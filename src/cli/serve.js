// `sesame serve` — 常駐 JSON-RPC バックエンド。
// Cloud/Biz3 RPC と登録済み BLE op (ble.invoke / ble.os2.invoke)、イベントを、
// stdio / Unix socket / HTTP(+SSE) / WebSocket / gRPC のどれからでも他言語に公開する。
//
// 認証はデーモンに載せない (CLI 専用)。デーモンは既存トークン前提で起動し、
// 未認証/クラウド不通でも死なず degraded で待ち受ける。

import net from "node:net";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, chmodSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SesameHub3 } from "../client.js";
import { configPaths } from "../paths.js";
import { Daemon } from "../serve/daemon.js";
import { startStdioFraming } from "../serve/framing/stdio.js";
import { startSocketFraming } from "../serve/framing/socket.js";
import { startHttpFraming } from "../serve/framing/http.js";
import { startWsFraming } from "../serve/framing/ws.js";
import { startGrpcFraming } from "../serve/framing/grpc.js";
import { generateToken } from "../serve/framing/token.js";
import { t } from "../i18n.js";

const DEF = { http: 8080, ws: 8081, grpc: 50051 };

/**
 * serve が投げる/橋渡しする拡張 Error。
 * - exitCode: usage エラー等で run() が尊重する終了コード。
 * - code/data/rpcError: rpc 経路で JSON-RPC error 封筒を CLI エラーへ橋渡しするマーカー
 *   (外側 CLI ハンドラが data.kind を失わず stale config 誤案内を避けるため)。
 * @typedef {Error & {
 *   exitCode?: number,
 *   code?: number|string,
 *   data?: unknown,
 *   rpcError?: boolean,
 * }} ServeError
 */

/**
 * net.Socket 等が投げる errno 付きエラー (ENOENT/ECONNREFUSED で分岐する)。
 * @typedef {Error & { code?: string }} ErrnoError
 */

/**
 * JSON-RPC 応答/通知の最小形 (1 行 JSON をパースした結果)。
 * @typedef {{
 *   jsonrpc?: string,
 *   id?: number|string|null,
 *   method?: string,
 *   params?: unknown,
 *   result?: unknown,
 *   error?: { code: number, message: string, data?: unknown },
 * }} RpcMessage
 */

function pkgVersion() {
  try {
    const p = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    return JSON.parse(readFileSync(p, "utf8")).version || "0.0.0";
  } catch { return "0.0.0"; }
}

/**
 * opts の任意ポート値 (true=既定 / "N"=指定) を数値へ。無効なら null。
 * @param {string|boolean|undefined} v
 * @param {number} def
 * @returns {number|null}
 */
function portOf(v, def) {
  if (v === undefined || v === false) return null;
  if (v === true) return def;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0 || n > 65535) {
    // 不正なポート指定は usage エラー (exit 2)。黙って既定にせず明示エラー。
    const err = /** @type {ServeError} */ (new Error(t("serve.invalidPort", { v })));
    err.exitCode = 2;
    throw err;
  }
  return n;
}

/**
 * テスト用スタブ hub (env-gated)。実クラウドに繋がず契約だけ検証できるようにする。
 * daemon が触る HubLike 面 + テスト用の _emit/listDevices 等を備える。HubLike にない
 * メソッド (getLoginUser 等) も持つため、unknown 経由で HubLike にナロー化する。
 * @returns {import("../serve/daemon.js").HubLike & { _emit: (m: unknown) => void }}
 */
function makeStubHub() {
  /** @type {((msg: unknown) => void)|null} */
  let duFn = null;
  const stub = {
    connected: true, subUUID: "stub-sub", config: { devices: {} },
    async connect() {}, async close() {},
    /** @param {unknown} _i @param {(msg: unknown) => void} fn */
    onDeviceUpdate: (_i, fn) => { duFn = fn; return () => { duFn = null; }; },
    /** @param {unknown} m */
    _emit: (m) => duFn && duFn(m),
    async getLoginUser() { return { stub: true }; },
    async listDevices() { return []; },
    /** @param {string} name */
    async unlock(name) { return { ok: true, name }; },
    /** @param {{ deviceUUID: string }} p */
    async unlockDevice({ deviceUUID }) { return { ok: true, deviceUUID }; },
  };
  return /** @type {import("../serve/daemon.js").HubLike & { _emit: (m: unknown) => void }} */ (
    /** @type {unknown} */ (stub)
  );
}

/**
 * @param {import("commander").Command} program
 * @returns {Promise<import("../serve/daemon.js").HubLike>}
 */
async function buildHub(program) {
  // テストスタブは本番では絶対に使わない (NODE_ENV=production では無効化)。
  if (process.env.SESAME_SERVE_TEST_HUB === "1" && process.env.NODE_ENV !== "production") return makeStubHub();
  const g = program.opts();
  // SesameHub3 は HubLike の上位互換だが onDeviceUpdate の items が string 厳密 (HubLike は
  // unknown) で、関数引数の非変性により直接代入できない。daemon が触る面は安全なため
  // unknown 経由で HubLike へナロー化する (cross-file: 真因は HubLike.onDeviceUpdate の
  // items 型を SesameHub3 と揃えること。本ファイル外なのでここでは橋渡しに留める)。
  return /** @type {import("../serve/daemon.js").HubLike} */ (
    /** @type {unknown} */ (SesameHub3.fromConfig({ configDir: g.configDir, debug: !!g.debug }))
  );
}

/** @param {import("commander").Command} program */
export function registerServeCommand(program) {
  program.command("serve")
    .description(t("serve.cmd.desc"))
    .option("--stdio", t("serve.opt.stdio"))
    .option("--socket [path]", t("serve.opt.socket"))
    .option("--no-socket", t("serve.opt.noSocket"))
    .option("--http [port]", t("serve.opt.http", { port: DEF.http }))
    .option("--ws [port]", t("serve.opt.ws", { port: DEF.ws }))
    .option("--grpc [port]", t("serve.opt.grpc", { port: DEF.grpc }))
    .option("--bind <addr>", t("serve.opt.bind"), "127.0.0.1")
    .option("--token <t>", t("serve.opt.token"))
    .option("--cors <origins>", t("serve.opt.cors"))
    .addHelpText("after", t("serve.help.after"))
    .action((opts) => cmdServe(opts, program));

  // 起動中デーモンへ JSON-RPC を 1 発送る (nc -U + jq 不要に)。
  program.command("rpc [method]")
    .description(t("serve.rpc.desc"))
    .option("--params <json>", t("serve.rpc.opt.params"))
    .option("--socket <path>", t("serve.rpc.opt.socket"))
    .option("--subscribe <topics>", t("serve.rpc.opt.subscribe"))
    .option("--paths", t("serve.rpc.opt.paths"))
    .option("--http [url]", t("serve.rpc.opt.http"))
    .option("--token <t>", t("serve.rpc.opt.token"))
    .addHelpText("after", t("serve.rpc.help.after"))
    .action((method, opts) => cmdRpc(method, opts, program));
}

/**
 * UDS を保持し events を購読、各イベントを 1 行 JSON で出し続ける (Ctrl-C で終了)。
 * @param {string} socketPath
 * @param {string[]} topics
 * @returns {Promise<void>}
 */
function rpcSubscribe(socketPath, topics) {
  return new Promise((/** @type {() => void} */ resolve, reject) => {
    const sock = net.connect(socketPath);
    let buf = "";
    sock.on("connect", () => {
      sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "events.subscribe", params: { topics } }) + "\n");
      console.error(t("serve.subscribed", { topics: topics.join(",") }));
    });
    sock.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        /** @type {RpcMessage} */
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (typeof msg.method === "string" && msg.method.startsWith("event.")) {
          console.log(JSON.stringify({ topic: msg.method.slice(6), payload: msg.params }));
        }
      }
    });
    sock.on("error", (/** @type {ErrnoError} */ e) => {
      if (e.code === "ENOENT" || e.code === "ECONNREFUSED") {
        reject(new Error(t("serve.notRunning", { socketPath })));
      } else reject(e);
    });
    process.on("SIGINT", () => { sock.destroy(); resolve(); });
  });
}

/**
 * UDS 経由で 1 リクエスト送り result を返す。未起動は分かりやすいエラーに。
 * @param {string} socketPath
 * @param {string} method
 * @param {unknown} params
 * @param {number} [timeoutMs]
 * @returns {Promise<unknown>}
 */
function rpcCall(socketPath, method, params, timeoutMs = 15000) {
  return new Promise((/** @type {(result: unknown) => void} */ resolve, reject) => {
    const sock = net.connect(socketPath);
    let buf = "";
    const to = setTimeout(() => { sock.destroy(); reject(new Error(t("serve.rpcTimeout"))); }, timeoutMs);
    sock.on("connect", () => sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n"));
    sock.on("data", (d) => {
      buf += d.toString();
      // 1 接続につき event.ready 等の通知が応答より先に届くため、行ごとに走査し
      // 自分のリクエスト (id:1) の応答だけを拾う。通知 (event.*) は読み飛ばす。
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        /** @type {RpcMessage} */
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (typeof msg.method === "string" && msg.method.startsWith("event.")) continue;
        if (msg.id !== 1) continue;
        clearTimeout(to); sock.destroy();
        if (msg.error) {
          // JSON-RPC error をそのまま CLI エラーへ橋渡し。data.kind を失わず、外側の
          // CLI ハンドラが stale config 誤案内を避けられるよう rpcError マーカーも立てる。
          const e = /** @type {ServeError} */ (new Error(msg.error.message));
          e.code = msg.error.code;
          e.data = msg.error.data;
          e.rpcError = true;
          return reject(e);
        }
        return resolve(msg.result);
      }
    });
    sock.on("error", (/** @type {ErrnoError} */ e) => {
      clearTimeout(to);
      if (e.code === "ENOENT" || e.code === "ECONNREFUSED") {
        reject(new Error(t("serve.notRunning", { socketPath })));
      } else reject(e);
    });
  });
}

/**
 * HTTP の `serve --http` へ 1 リクエスト送り result を返す。serve.token を既定トークンに使う。
 * @param {string} url
 * @param {string|null} token
 * @param {string} method
 * @param {unknown} params
 * @param {number} [timeoutMs]
 * @returns {Promise<unknown>}
 */
async function rpcCallHttp(url, token, method, params, timeoutMs = 15000) {
  // 末尾スラッシュ除去は線形ループで (正規表現 /\/+$/ は ReDoS 懸念のため避ける)。
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 0x2f /* "/" */) end--;
  const endpoint = url.slice(0, end) + "/rpc";
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw new Error(t("serve.rpcTimeout"));
    throw new Error(t("serve.httpNotRunning", { url })); // 接続拒否 (未起動) 等
  } finally { clearTimeout(to); }
  if (resp.status === 401) throw new Error(t("serve.httpUnauthorized"));
  const msg = /** @type {RpcMessage} */ (await resp.json());
  if (msg.error) {
    // UDS 経路と同様、data.kind / rpcError マーカーを引き継ぐ (誤った stale config 案内を回避)。
    const e = /** @type {ServeError} */ (new Error(msg.error.message));
    e.code = msg.error.code;
    e.data = msg.error.data;
    e.rpcError = true;
    throw e;
  }
  return msg.result;
}

/**
 * --http の URL を解決 (値省略時は既定)。
 * @param {string|boolean|undefined} http
 * @returns {string}
 */
function resolveHttpUrl(http) {
  return typeof http === "string" ? http : "http://127.0.0.1:8080";
}

/**
 * @param {string|undefined} method
 * @param {Record<string, any>} opts
 * @param {import("commander").Command} program
 */
async function cmdRpc(method, opts, program) {
  const dir = configPaths(program.opts().configDir);
  const socketPath = opts.socket || dir.socket;

  // --paths: 他言語クライアントが XDG パスを再導出しなくて済むよう接続情報を出す。
  if (opts.paths) {
    const tokenFile = join(dir.dir, "serve.token");
    let token = null;
    try { token = readFileSync(tokenFile, "utf8").trim(); } catch { /* HTTP 未起動なら無し */ }
    console.log(JSON.stringify({ socket: socketPath, tokenFile, token }, null, 2));
    return;
  }
  // --subscribe: イベントを出し続ける (イベントの行き止まり解消)。
  if (opts.subscribe) {
    const topics = String(opts.subscribe).split(",").map((/** @type {string} */ s) => s.trim()).filter(Boolean);
    if (opts.http) {
      // HTTP の購読は SSE (GET /events)。ここでは curl の SSE 例を案内する。
      console.error(t("serve.subscribeHttpUnsupported", { url: resolveHttpUrl(opts.http), topics: topics.join(",") }));
      process.exit(2);
    }
    await rpcSubscribe(socketPath, topics);
    return;
  }

  const m = method || "rpc.discover";
  /** @type {unknown} */
  let params = {};
  if (opts.params) {
    try {
      params = JSON.parse(opts.params);
    } catch (e) {
      // --json 時は構造化封筒 (CLI の --json エラー契約に合わせ {error,code})、
      // 非 --json は従来どおり人間向けメッセージ。どちらも usage エラーなので exit 2。
      const msg = t("serve.badParamsJson", { message: e instanceof Error ? e.message : String(e) });
      if (program.opts().json) console.error(JSON.stringify({ error: msg, code: 2 }));
      else console.error(msg);
      process.exit(2);
    }
  }
  /** @type {unknown} */
  let result;
  if (opts.http) {
    const url = resolveHttpUrl(opts.http);
    let token = opts.token || null;
    if (!token) { try { token = readFileSync(join(dir.dir, "serve.token"), "utf8").trim(); } catch { /* 無ければ未認証で投げ 401 を案内 */ } }
    result = await rpcCallHttp(url, token, m, params);
  } else {
    result = await rpcCall(socketPath, m, params);
  }
  // 未ログイン/失効を見たら次の一手を案内 (degraded で居座る問題の出口)。
  // result は unknown (rpc 応答)。status 応答の authState を読むためにナロー化する。
  const statusRes = /** @type {{ authState?: string }} */ (result);
  if (m === "status" && result && statusRes.authState && statusRes.authState !== "ok") {
    console.error(t("serve.hint.notLoggedIn"));
  }
  if (program.opts().json) { console.log(JSON.stringify(result, null, 2)); return; }
  if (m === "rpc.discover") {
    // 人間向けの表: メソッド名 + 引数 (required はそのまま、任意は [name])。
    // rpc.discover の result 形状にナロー化する。
    const disc = /** @type {{ methods: Array<{ name: string, params?: Array<{ name: string, required?: boolean }> }> }} */ (result);
    for (const meth of disc.methods) {
      const ps = (meth.params || []).map((p) => (p.required ? p.name : `[${p.name}]`)).join(" ");
      console.log(`${meth.name.padEnd(28)} ${ps}`);
    }
    console.error(t("serve.discoverFooter", { count: disc.methods.length }));
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

/**
 * @param {Record<string, any>} opts
 * @param {import("commander").Command} program
 */
async function cmdServe(opts, program) {
  // どのフレーミングを上げるか決定。明示が無ければ UDS のみ。
  const wantStdio = !!opts.stdio;
  const httpPort = portOf(opts.http, DEF.http);
  const wsPort = portOf(opts.ws, DEF.ws);
  const grpcPort = portOf(opts.grpc, DEF.grpc);
  const anyExplicit = wantStdio || opts.socket !== undefined || httpPort != null || wsPort != null || grpcPort != null;
  const wantSocket = opts.socket === false ? false : (opts.socket !== undefined ? true : !anyExplicit);
  const socketPath = typeof opts.socket === "string" ? opts.socket : configPaths(program.opts().configDir).socket;
  const needsToken = httpPort != null || wsPort != null || grpcPort != null;
  const token = needsToken ? (opts.token || generateToken()) : null;

  // 全フレーミングを解決した結果、1 つも上がらない (例: `--no-socket` 単独) なら
  // 何も listen しないデーモンを起動しても無意味。usage エラー (exit 2) で明示拒否する。
  if (!wantStdio && !wantSocket && httpPort == null && wsPort == null && grpcPort == null) {
    const err = /** @type {ServeError} */ (new Error(t("serve.noFraming")));
    err.exitCode = 2; // run() の catch が usage コード 2 を尊重する
    throw err;
  }

  // CORS は HTTP 専用のオプトイン設定。"*" か、カンマ区切りの origin リスト。
  const corsOrigins = opts.cors
    ? (String(opts.cors).trim() === "*" ? "*" : String(opts.cors).split(",").map((/** @type {string} */ s) => s.trim()).filter(Boolean))
    : null;

  const hub = await buildHub(program);
  const daemon = new Daemon({ hub, version: pkgVersion(), debug: !!program.opts().debug });

  // 人間向けの案内は **stderr** へ (stdio モードでは stdout が RPC チャネル)。
  /** @param {...unknown} a */
  const note = (...a) => console.error("[serve]", ...a);

  /** @type {Array<{ stop?: () => void|Promise<void>, path?: string, url?: string, port?: number }>} */
  const handles = [];
  let shuttingDown = false;
  /** @type {(value?: void) => void} */
  let resolveRun;
  /** @type {Promise<void>} */
  const runUntilShutdown = new Promise((r) => { resolveRun = r; });

  /** @param {string} reason */
  const shutdown = async (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    note(t("serve.note.shuttingDown", { reason }));
    // hub.close() 等が万一ハングしても Ctrl-C 不能にならないよう強制終了の保険。
    const watchdog = setTimeout(() => { note(t("serve.note.watchdog")); process.exit(1); }, 5000);
    watchdog.unref();
    for (const h of handles) { try { await h.stop?.(); } catch { /* ignore */ } }
    await daemon.shutdown();
    clearTimeout(watchdog);
    resolveRun();
  };

  try {
    if (wantStdio) { handles.push(startStdioFraming(daemon, { onShutdown: () => shutdown("stdin EOF") })); note(t("serve.note.stdioReady")); }
    if (wantSocket) {
      const h = await startSocketFraming(daemon, { socketPath }); handles.push(h);
      note(t("serve.note.unixSocket", { path: h.path }));
      note(t("serve.note.socketTest", { path: h.path }));
    }
    if (httpPort != null) {
      const h = await startHttpFraming(daemon, { bind: opts.bind, port: httpPort, token, corsOrigins }); handles.push(h);
      note(t("serve.note.http", { url: h.url }));
      if (corsOrigins) note(t("serve.note.cors", { origins: corsOrigins === "*" ? "*" : corsOrigins.join(", ") }));
    }
    if (wsPort != null) {
      const h = await startWsFraming(daemon, { bind: opts.bind, port: wsPort, token }); handles.push(h);
      note(t("serve.note.ws", { url: h.url }));
      note(t("serve.note.wsTest", { url: h.url }));
    }
    if (grpcPort != null) { const h = await startGrpcFraming(daemon, { bind: opts.bind, port: grpcPort, token }); handles.push(h); note(t("serve.note.grpc", { bind: opts.bind, port: h.port })); }
  } catch (e) {
    await shutdown("startup error");
    throw e; // run() の catch が JSON/人間向けエラーに整形
  }

  if (needsToken) {
    // token を well-known ファイルにも書く (バックグラウンド起動で stderr を見逃しても拾えるように)。
    const tokenFile = join(configPaths(program.opts().configDir).dir, "serve.token");
    try {
      const dir = dirname(tokenFile);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(tokenFile, token + "\n", { mode: 0o600 });
      // writeFileSync/mkdirSync の mode は**新規作成時のみ**効く。既存の緩い権限 (他ツールが
      // 0755 で作った dir、前回別 umask で残した 0644 の token) を確実に締めるため明示 chmod。
      try { chmodSync(tokenFile, 0o600); } catch { /* ignore */ }
      try { if (existsSync(dir)) chmodSync(dir, 0o700); } catch { /* ignore */ }
      handles.push({ stop: () => { try { unlinkSync(tokenFile); } catch { /* ignore */ } } });
      note(t("serve.note.token", { token }));
      note(t("serve.note.tokenUse", { token }));
      note(t("serve.note.tokenSaved", { tokenFile }));
    } catch {
      note(t("serve.note.tokenNoFile", { token }));
    }
    if (opts.bind && opts.bind !== "127.0.0.1" && opts.bind !== "localhost") {
      note(t("serve.note.bindWarn", { bind: opts.bind }));
      note(t("serve.note.bindWarn2"));
      note(t("serve.note.bindWarn3"));
      note(t("serve.note.bindWarn4"));
    }
  }
  daemon.start(); // クラウド接続を背景で試行 (失敗しても degraded で継続)
  note(t("serve.note.ready"));

  // シグナル/致命例外で graceful shutdown。プロセスはここで shutdown まで生き続ける。
  /** @param {string} s */
  const onSig = (s) => shutdown(s);
  process.once("SIGINT", () => onSig("SIGINT"));
  process.once("SIGTERM", () => onSig("SIGTERM"));
  process.once("SIGHUP", () => onSig("SIGHUP"));
  // uncaughtException は本当に異常 → cleanup して exit。
  process.once("uncaughtException", async (e) => { note(t("serve.note.uncaught"), e?.message); await shutdown("uncaughtException"); process.exit(1); });
  // unhandledRejection はログのみ (良性の reject 1 個でロック制御を落とさない)。
  // ただし**短時間のバースト**は構造的バグなので exit (無限ログ垂れ流しを防ぐ)。
  // 生涯累積で数えると無期限常駐が良性 reject の蓄積でいつか必ず落ちるため、直近 60s の窓で判定する。
  /** @type {number[]} */
  const rejTimes = [];
  process.on("unhandledRejection", (/** @type {unknown} */ e) => {
    note(t("serve.note.unhandled"), (e instanceof Error ? e.message : e));
    const now = Date.now();
    rejTimes.push(now);
    while (rejTimes.length && now - rejTimes[0] > 60_000) rejTimes.shift();
    if (rejTimes.length > 50) { note(t("serve.note.tooManyRej")); process.exit(1); }
  });

  await runUntilShutdown;
}
