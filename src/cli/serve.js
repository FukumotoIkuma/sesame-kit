// `sesame serve` — 常駐 JSON-RPC バックエンド。
// 全機能 (lock/ir/iot/org/company/access/schedule/presetir + イベント) を、
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

function pkgVersion() {
  try {
    const p = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    return JSON.parse(readFileSync(p, "utf8")).version || "0.0.0";
  } catch { return "0.0.0"; }
}

/** opts の任意ポート値 (true=既定 / "N"=指定) を数値へ。無効なら null。 */
function portOf(v, def) {
  if (v === undefined || v === false) return null;
  if (v === true) return def;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0 || n > 65535) {
    throw new Error(t("serve.invalidPort", { v })); // 黙って既定にせず明示エラー
  }
  return n;
}

/** テスト用スタブ hub (env-gated)。実クラウドに繋がず契約だけ検証できるようにする。 */
function makeStubHub() {
  let duFn = null;
  return {
    connected: true, subUUID: "stub-sub", config: { devices: {} },
    async connect() {}, async close() {},
    onDeviceUpdate: (_i, fn) => { duFn = fn; return () => { duFn = null; }; },
    _emit: (m) => duFn && duFn(m),
    async getLoginUser() { return { stub: true }; },
    async listDevices() { return []; },
    async unlock(name) { return { ok: true, name }; },
    async unlockDevice({ deviceUUID }) { return { ok: true, deviceUUID }; },
  };
}

async function buildHub(program) {
  // テストスタブは本番では絶対に使わない (NODE_ENV=production では無効化)。
  if (process.env.SESAME_SERVE_TEST_HUB === "1" && process.env.NODE_ENV !== "production") return makeStubHub();
  const g = program.opts();
  return SesameHub3.fromConfig({ configDir: g.configDir, debug: !!g.debug });
}

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

/** UDS を保持し events を購読、各イベントを 1 行 JSON で出し続ける (Ctrl-C で終了)。 */
function rpcSubscribe(socketPath, topics) {
  return new Promise((resolve, reject) => {
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
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (typeof msg.method === "string" && msg.method.startsWith("event.")) {
          console.log(JSON.stringify({ topic: msg.method.slice(6), payload: msg.params }));
        }
      }
    });
    sock.on("error", (e) => {
      if (e.code === "ENOENT" || e.code === "ECONNREFUSED") {
        reject(new Error(t("serve.notRunning", { socketPath })));
      } else reject(e);
    });
    process.on("SIGINT", () => { sock.destroy(); resolve(); });
  });
}

/** UDS 経由で 1 リクエスト送り result を返す。未起動は分かりやすいエラーに。 */
function rpcCall(socketPath, method, params, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
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
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (typeof msg.method === "string" && msg.method.startsWith("event.")) continue;
        if (msg.id !== 1) continue;
        clearTimeout(to); sock.destroy();
        if (msg.error) { const e = new Error(msg.error.message); e.code = msg.error.code; return reject(e); }
        return resolve(msg.result);
      }
    });
    sock.on("error", (e) => {
      clearTimeout(to);
      if (e.code === "ENOENT" || e.code === "ECONNREFUSED") {
        reject(new Error(t("serve.notRunning", { socketPath })));
      } else reject(e);
    });
  });
}

/** HTTP の `serve --http` へ 1 リクエスト送り result を返す。serve.token を既定トークンに使う。 */
async function rpcCallHttp(url, token, method, params, timeoutMs = 15000) {
  const endpoint = url.replace(/\/+$/, "") + "/rpc";
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
    if (e.name === "AbortError") throw new Error(t("serve.rpcTimeout"));
    throw new Error(t("serve.httpNotRunning", { url })); // 接続拒否 (未起動) 等
  } finally { clearTimeout(to); }
  if (resp.status === 401) throw new Error(t("serve.httpUnauthorized"));
  const msg = await resp.json();
  if (msg.error) { const e = new Error(msg.error.message); e.code = msg.error.code; throw e; }
  return msg.result;
}

/** --http の URL を解決 (値省略時は既定)。 */
function resolveHttpUrl(http) {
  return typeof http === "string" ? http : "http://127.0.0.1:8080";
}

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
    const topics = opts.subscribe.split(",").map((s) => s.trim()).filter(Boolean);
    if (opts.http) {
      // HTTP の購読は SSE (GET /events)。ここでは curl の SSE 例を案内する。
      console.error(t("serve.subscribeHttpUnsupported", { url: resolveHttpUrl(opts.http), topics: topics.join(",") }));
      process.exit(2);
    }
    await rpcSubscribe(socketPath, topics);
    return;
  }

  const m = method || "rpc.discover";
  let params = {};
  if (opts.params) {
    try { params = JSON.parse(opts.params); } catch (e) { console.error(t("serve.badParamsJson", { message: e.message })); process.exit(2); }
  }
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
  if (m === "status" && result && result.authState && result.authState !== "ok") {
    console.error(t("serve.hint.notLoggedIn"));
  }
  if (program.opts().json) { console.log(JSON.stringify(result, null, 2)); return; }
  if (m === "rpc.discover") {
    // 人間向けの表: メソッド名 + 引数 (required はそのまま、任意は [name])。
    for (const meth of result.methods) {
      const ps = (meth.params || []).map((p) => (p.required ? p.name : `[${p.name}]`)).join(" ");
      console.log(`${meth.name.padEnd(28)} ${ps}`);
    }
    console.error(t("serve.discoverFooter", { count: result.methods.length }));
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

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

  const hub = await buildHub(program);
  const daemon = new Daemon({ hub, version: pkgVersion(), debug: !!program.opts().debug });

  // 人間向けの案内は **stderr** へ (stdio モードでは stdout が RPC チャネル)。
  const note = (...a) => console.error("[serve]", ...a);

  const handles = [];
  let shuttingDown = false;
  let resolveRun;
  const runUntilShutdown = new Promise((r) => { resolveRun = r; });

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
    if (httpPort != null) { const h = await startHttpFraming(daemon, { bind: opts.bind, port: httpPort, token }); handles.push(h); note(t("serve.note.http", { url: h.url })); }
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
  const onSig = (s) => shutdown(s);
  process.once("SIGINT", () => onSig("SIGINT"));
  process.once("SIGTERM", () => onSig("SIGTERM"));
  process.once("SIGHUP", () => onSig("SIGHUP"));
  // uncaughtException は本当に異常 → cleanup して exit。
  process.once("uncaughtException", async (e) => { note(t("serve.note.uncaught"), e?.message); await shutdown("uncaughtException"); process.exit(1); });
  // unhandledRejection はログのみ (良性の reject 1 個でロック制御を落とさない)。
  // ただし**短時間のバースト**は構造的バグなので exit (無限ログ垂れ流しを防ぐ)。
  // 生涯累積で数えると無期限常駐が良性 reject の蓄積でいつか必ず落ちるため、直近 60s の窓で判定する。
  const rejTimes = [];
  process.on("unhandledRejection", (e) => {
    note(t("serve.note.unhandled"), e?.message || e);
    const now = Date.now();
    rejTimes.push(now);
    while (rejTimes.length && now - rejTimes[0] > 60_000) rejTimes.shift();
    if (rejTimes.length > 50) { note(t("serve.note.tooManyRej")); process.exit(1); }
  });

  await runUntilShutdown;
}
