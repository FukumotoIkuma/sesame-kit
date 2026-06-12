// sesame serve の薄い公式 JS クライアント (Node 20+, 依存ゼロ)。
// 別プロセスで動いている serve デーモンに繋ぐ用途。
//
//   import { SesameClient } from "./sesame-client.mjs";
//   const c = SesameClient.unix();                 // 既定 UDS パス (POSIX。sesame serve で起動)
//   console.log(await c.unlock("front"));
//   await c.subscribe(["lockState"], (topic, p) => console.log("EVENT", topic, p));
//
//   const h = SesameClient.http("http://127.0.0.1:8080"); // token は serve.token から自動
//   const w = await SesameClient.ws("ws://127.0.0.1:8081"); // Windows でも全二重 (要 Node22+ or ws)
//
// 失敗は SesameRpcError(message, kind) を throw (kind: not_authenticated / connection_lost / timeout /
// not_implemented / bad_params / rejected / internal — serve の error.data.kind 7 種と一致)。
// (旧名 SesameError は deprecated alias として 1 リリース維持。)
// subscribe は **常に await** すること (接続/認証エラーを取りこぼさないため)。

import net from "node:net";
import os from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

// CLI の権威ある解決順 (src/paths.js) に合わせる:
//   1. SESAME_KIT_HOME (アプリ専用) → そのディレクトリ直下
//   2. XDG_CONFIG_HOME → $XDG_CONFIG_HOME/sesame-kit
//   3. ~/.config/sesame-kit
// クライアントは standalone コピーなので src/ から import せず自前で再現する。
function defaultConfigDir() {
  if (process.env.SESAME_KIT_HOME) return process.env.SESAME_KIT_HOME;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "sesame-kit");
  return join(os.homedir(), ".config", "sesame-kit");
}
function defaultSocketPath() {
  return join(defaultConfigDir(), "sesame.sock");
}
function defaultTokenPath() {
  return join(defaultConfigDir(), "serve.token");
}
function defaultToken() {
  try { return readFileSync(defaultTokenPath(), "utf8").trim(); } catch { return null; }
}

// P5-9 (ARCH-19): core の SesameError (src/errors.js, code:string) との同名異義を解消するため、
// sdk/ts と同じ SesameRpcError (kind / code:number) に改名した。name はクラス名と同期する。
export class SesameRpcError extends Error {
  constructor(message, kind, code) { super(message); this.name = "SesameRpcError"; this.kind = kind; this.code = code; }
}

/**
 * @deprecated 旧名。core の SesameError (code:string) との同名異義解消のため SesameRpcError に
 * 改名した。後方互換 alias として 1 リリース維持し、次 minor で削除予定。
 */
export { SesameRpcError as SesameError };

// serve.token (ローカルの serve が生成するランダムトークン) はファイルから読み込むため、
// 万一改竄された値が Authorization ヘッダや URL クエリに混入すると HTTP ヘッダ/URL
// インジェクション (CRLF 注入・クエリ汚染) になりうる。token がネットワーク送出に使われる
// 前に必ずこの検証を通し、想定文字種以外を拒否する (実インジェクション対策 +
// CodeQL js/file-access-to-http のテイントバリア)。
function sanitizeServeToken(raw) {
  if (raw == null) return null;
  const tok = String(raw).trim();
  if (tok === "") return null;
  // serve のトークンは URL-safe な英数字系 (base64url / hex 等)。制御文字・空白・改行を
  // 1 つでも含む値は不正として拒否する (= ヘッダ/URL に注入されうる文字を遮断)。
  if (!/^[\w.~+/=-]+$/.test(tok)) {
    throw new SesameRpcError("serve.token の形式が不正です (制御文字や空白は許可されません)", "not_authenticated");
  }
  return tok;
}

// HTTP ステータス → SesameError.kind 写像 (出典: REFACTORING_PLAN.md P4-5/SURF-10)。
// sdk/ts・sdk/python・clients/python と共通の正で、tests/fixtures/http-kind-map.json に固定。
//   400/413/415→bad_params, 401/403→not_authenticated, 404→not_implemented,
//   408/429/5xx→connection_lost (再試行可), その他→internal
// (thin クライアントは retryable フィールドを持たない — connection_lost が再試行可能の意)
// export はテスト照合用 (tests/serve/http-kind-map.test.js)。
export function httpKind(status) {
  if (status === 401 || status === 403) return "not_authenticated";
  if (status === 400 || status === 413 || status === 415) return "bad_params";
  if (status === 404) return "not_implemented";
  if (status === 408 || status === 429 || status >= 500) return "connection_lost";
  return "internal";
}

function sesameErrorFromRpc(error, fallbackKind, fallbackCode) {
  if (error && typeof error === "object") {
    return new SesameRpcError(error.message || "JSON-RPC error", error.data?.kind || fallbackKind, error.code ?? fallbackCode);
  }
  return new SesameRpcError(String(error || "HTTP error"), fallbackKind, fallbackCode);
}

export class SesameClient {
  constructor(transport) { this._t = transport; }

  static unix(path = defaultSocketPath()) {
    if (process.platform === "win32") {
      throw new SesameRpcError("Unix socket は POSIX 専用です。Windows では SesameClient.http() か .ws() を使ってください", "not_implemented");
    }
    return new SesameClient(new StreamTransport(path));
  }
  static http(base = "http://127.0.0.1:8080", token = defaultToken()) {
    return new SesameClient(new HttpTransport(base.replace(/\/$/, ""), token));
  }
  /** WebSocket クライアント。`ws` パッケージ(ヘッダ認証可)を優先し、無ければ global WebSocket (await 必須)。 */
  static async ws(url = "ws://127.0.0.1:8081", token = defaultToken()) {
    // ws パッケージは upgrade で Authorization ヘッダを送れる (token を URL に載せず済む)。
    // 無ければ global WebSocket (ブラウザ/Node22+) にフォールバックし URL ?token= を使う。
    const pkg = await import("ws").then((m) => m.WebSocket).catch(() => null);
    const WS = pkg || globalThis.WebSocket;
    if (!WS) throw new SesameRpcError("WebSocket が無い。Node 20+ で `npm i ws`、または Node 22+ が必要です", "not_implemented");
    const t = new WsTransport(WS, url, token, /* useHeader */ !!pkg);
    await t.ready();
    return new SesameClient(t);
  }

  async call(method, params = {}) {
    const resp = await this._t.request({ jsonrpc: "2.0", method, params }); // id は transport が採番
    if (resp.error) throw sesameErrorFromRpc(resp.error, "internal");
    return resp.result;
  }
  /** topics を購読。常に await すること (接続/認証/不正 topic エラーが throw で返る)。 */
  async subscribe(topics, onEvent) {
    const resp = await this._t.subscribe(topics, onEvent);
    // UDS/WS は購読要求の応答 (msg) を返す。error があれば握り潰さず throw (不正 topic 等)。
    if (resp && resp.error) throw new SesameRpcError(resp.error.message, resp.error.data?.kind, resp.error.code);
    return resp?.result;
  }
  async discover() { return this.call("rpc.discover"); }

  unlock(name, kw = {}) { return this.call("lock.unlock", name ? { name, ...kw } : kw); }
  lock(name, kw = {}) { return this.call("lock.lock", name ? { name, ...kw } : kw); }
  // P4-9 (SURF-35): unlock/lock と同型の便宜メソッド。Python クライアントとの表面対称性を回復。
  toggle(name, kw = {}) { return this.call("lock.toggle", name ? { name, ...kw } : kw); }
  status() { return this.call("status"); }
  devices() { return this.call("devices.list"); }
  close() { this._t.close(); }
}

/** 受信行を id/event で振り分ける共通処理 (UDS/WS で共有)。 */
function routeMessage(self, line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; } // 壊れた行で落ちない
  if ("id" in msg && self._pending.has(msg.id)) {
    const { resolve } = self._pending.get(msg.id); self._pending.delete(msg.id); resolve(msg);
  } else if (typeof msg.method === "string" && msg.method.startsWith("event.")) {
    self._onEvent?.(msg.method.slice("event.".length), msg.params);
  }
}

class StreamTransport {
  constructor(path) {
    this._ids = 0; this._pending = new Map(); this._onEvent = null; this._fatal = null; this._subscribed = false; this._closed = false; this._buf = ""; this._idleClose = null;
    this._sock = net.connect(path);
    this._sock.on("error", (e) => {
      const msg = (e.code === "ENOENT" || e.code === "ECONNREFUSED")
        ? `sesame serve が起動していません (socket: ${path})。別ターミナルで \`sesame serve\` を実行してください`
        : `socket エラー: ${e.message}`;
      this._fatal = new SesameRpcError(msg, "connection_lost");
      for (const { reject } of this._pending.values()) reject(this._fatal);
      this._pending.clear();
      this._scheduleIdleClose();
    });
    this._sock.on("data", (d) => {
      this._buf += d.toString();
      let nl;
      while ((nl = this._buf.indexOf("\n")) >= 0) {
        const line = this._buf.slice(0, nl);
        this._buf = this._buf.slice(nl + 1);
        if (line.trim()) routeMessage(this, line);
      }
    });
    this._scheduleIdleClose({ unrefSocket: false });
  }
  _cancelIdleClose() {
    if (this._idleClose) clearImmediate(this._idleClose);
    this._idleClose = null;
  }
  _scheduleIdleClose({ unrefSocket = true } = {}) {
    if (this._closed || this._subscribed || this._pending.size !== 0) return;
    if (unrefSocket) this._sock.unref?.();
    if (this._idleClose) return;
    this._idleClose = setImmediate(() => {
      this._idleClose = null;
      if (!this._closed && !this._subscribed && this._pending.size === 0) this.close();
    });
    this._idleClose.unref?.();
  }
  request(msg) {
    if (this._fatal) return Promise.reject(this._fatal);
    this._cancelIdleClose();
    this._sock.ref?.();
    const id = ++this._ids;
    return new Promise((resolve, reject) => {
      const finish = (fn, value) => {
        clearTimeout(to);
        this._pending.delete(id);
        this._scheduleIdleClose();
        fn(value);
      };
      const to = setTimeout(() => finish(reject, new SesameRpcError("request timed out", "timeout")), 20000);
      this._pending.set(id, { resolve: (m) => finish(resolve, m), reject: (e) => finish(reject, e) });
      this._sock.write(JSON.stringify({ ...msg, id }) + "\n");
    });
  }
  subscribe(topics, onEvent) {
    this._subscribed = true;
    this._sock.ref?.();
    this._onEvent = onEvent;
    return this.request({ jsonrpc: "2.0", method: "events.subscribe", params: { topics } })
      .catch((e) => { this._subscribed = false; this._scheduleIdleClose(); throw e; });
  }
  close() { this._closed = true; this._cancelIdleClose(); this._sock.destroy(); }
}

class WsTransport {
  constructor(WS, url, token, useHeader) {
    this._ids = 0; this._pending = new Map(); this._onEvent = null; this._fatal = null;
    // token はネットワーク送出前に形式検証する (ヘッダ/URL インジェクション対策)。
    token = sanitizeServeToken(token);
    // ヘッダ送信可 (ws パッケージ) なら Authorization ヘッダ、不可 (ブラウザ) なら URL ?token=。
    this._ws = useHeader && token
      ? new WS(url, { headers: { authorization: `Bearer ${token}` } })
      : new WS(url + (url.includes("?") ? "&" : "?") + (token ? `token=${token}` : ""));
    this._open = new Promise((resolve, reject) => {
      const fail = (e) => { this._fatal = e; for (const { reject: rj } of this._pending.values()) rj(e); this._pending.clear(); reject(e); };
      this._ws.addEventListener("open", () => resolve());
      // 握手 401 (verifyClient 拒否) は error として届く。message に 401 を含めば認証失敗。
      this._ws.addEventListener("error", (ev) => {
        const m = String(ev?.message || ev?.error?.message || "");
        if (/401|403|unauthorized/i.test(m)) fail(new SesameRpcError("unauthorized (token 不一致/未指定)", "not_authenticated", 401));
        else fail(new SesameRpcError(`ws 接続失敗 (${url})。sesame serve --ws を起動しましたか?`, "connection_lost"));
      });
      // 念のため close 1008 も認証失敗として扱う (open が先勝ちした場合の保険)。
      this._ws.addEventListener("close", (ev) => { if (ev.code === 1008) fail(new SesameRpcError("unauthorized (token)", "not_authenticated", 1008)); });
    });
    this._open.catch(() => {}); // unhandled rejection 抑止 (ready() で受ける)
    this._ws.addEventListener("message", (ev) => routeMessage(this, typeof ev.data === "string" ? ev.data : ev.data.toString()));
  }
  ready() { return this._open; }
  async request(msg) {
    if (this._fatal) return Promise.reject(this._fatal);
    await this._open;
    if (this._fatal) return Promise.reject(this._fatal);
    const id = ++this._ids;
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => { this._pending.delete(id); reject(new SesameRpcError("request timed out", "timeout")); }, 20000);
      this._pending.set(id, { resolve: (m) => { clearTimeout(to); resolve(m); }, reject });
      this._ws.send(JSON.stringify({ ...msg, id }));
    });
  }
  subscribe(topics, onEvent) { this._onEvent = onEvent; return this.request({ jsonrpc: "2.0", method: "events.subscribe", params: { topics } }); }
  close() { try { this._ws.close(); } catch { /* ignore */ } }
}

class HttpTransport {
  // token はネットワーク送出前に形式検証する (Authorization ヘッダ/URL インジェクション対策)。
  constructor(base, token) { this._base = base; this._token = sanitizeServeToken(token); this._ids = 0; }
  _headers() { return this._token ? { "content-type": "application/json", authorization: `Bearer ${this._token}` } : { "content-type": "application/json" }; }
  _unauthorized() {
    return this._token
      ? new SesameRpcError("unauthorized (token 不一致)", "not_authenticated", 401)
      : new SesameRpcError(`token が見つかりません。\`sesame serve --http\` で起動すると ${defaultTokenPath()} に保存されます`, "not_authenticated", 401);
  }
  async request(msg) {
    const id = ++this._ids;
    let r;
    try {
      r = await fetch(`${this._base}/rpc`, { method: "POST", headers: this._headers(), body: JSON.stringify({ ...msg, id }) });
    } catch (e) {
      throw new SesameRpcError(`接続失敗: ${e.message}。\`sesame serve --http\` を起動しましたか?`, "connection_lost");
    }
    if (r.status === 204) return { id, result: null };
    let body;
    try { body = await r.json(); } catch { body = null; }
    if (r.status === 401 && !this._token) throw this._unauthorized();
    if (!r.ok) throw sesameErrorFromRpc(body?.error ?? body ?? r.statusText, httpKind(r.status), r.status);
    return body;
  }
  async subscribe(topics, onEvent) {
    // token は Authorization ヘッダ (_headers) で送る。URL クエリに載せると proxy/access ログに漏れる。
    const url = `${this._base}/events?topics=${encodeURIComponent(topics.join(","))}`;
    let res;
    try { res = await fetch(url, { headers: this._headers() }); }
    catch (e) { throw new SesameRpcError(`events 接続失敗: ${e.message}`, "connection_lost"); }
    if (res.status === 401) throw this._unauthorized();
    if (res.status >= 400) { // 400 = 不正 topic 等。黙ってストリームを張らず明示エラーに。
      let detail = ""; try { detail = JSON.stringify(await res.json()); } catch { /* ignore */ }
      throw new SesameRpcError(`events 購読失敗 (HTTP ${res.status}): ${detail}`, "bad_params", res.status);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, nl); buf = buf.slice(nl + 2);
            const line = block.split("\n").find((l) => l.startsWith("data: "));
            if (line) { let m; try { m = JSON.parse(line.slice(6)); } catch { continue; } if (m.method?.startsWith("event.")) onEvent(m.method.slice(6), m.params); }
          }
        }
      } catch (e) { console.error("[sesame] subscribe error:", e.message); }
    })();
  }
  close() {}
}
