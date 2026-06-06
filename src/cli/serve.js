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
    throw new Error(`invalid port: ${v}`); // 黙って既定にせず明示エラー
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
    .description("常駐 JSON-RPC バックエンド (stdio/UDS/HTTP/WS/gRPC で全機能を他言語へ公開)")
    .option("--stdio", "stdin/stdout で NDJSON JSON-RPC (埋め込み: 親が子プロセスとして spawn)")
    .option("--socket [path]", "Unix domain socket (省略時 ~/.config/sesame-kit/sesame.sock)")
    .option("--no-socket", "UDS を無効化")
    .option("--http [port]", `HTTP(+SSE) を listen (既定 ${DEF.http})`)
    .option("--ws [port]", `WebSocket を listen (既定 ${DEF.ws})`)
    .option("--grpc [port]", `gRPC を listen (既定 ${DEF.grpc})`)
    .option("--bind <addr>", "TCP バインドアドレス", "127.0.0.1")
    .option("--token <t>", "HTTP/WS/gRPC 用の loopback token (省略時は生成して表示)")
    .addHelpText("after", `
迷ったら: 引数なしで起動 (UDS) し、別端末で \`sesame rpc\` を使うのが最速 (JSON を書かずに済む)。
  sesame serve                         # UDS (既定。最も移植性が高い)
  sesame rpc                           #   → 全メソッドと引数を一覧
  sesame rpc lock.unlock --params '{"name":"front"}'
  sesame rpc --subscribe lockState     #   → 鍵状態の変化を表示し続ける

フレーミングは 1 つ以上選ぶ。公開メソッドはどれでも同一。
  sesame serve --stdio                 # 埋め込み (Python/Go が子プロセスとして spawn)
  sesame serve --http 8080             # ブラウザ/全言語。http://… をブラウザで開くと使い方が出る
  sesame serve --ws 8081 --grpc 50051  # 全二重 / 型付きスタブ

他言語から繋ぐ接続情報: sesame rpc --paths   (socket / token のパスを JSON で)
事前に CLI でログインしておくこと: sesame login <email>`)
    .action((opts) => cmdServe(opts, program));

  // 起動中デーモンへ JSON-RPC を 1 発送る (nc -U + jq 不要に)。
  program.command("rpc [method]")
    .description("起動中の `sesame serve` に JSON-RPC を送る (UDS)。method 省略で全メソッド一覧")
    .option("--params <json>", "params を JSON で渡す (例: '{\"name\":\"front\"}')")
    .option("--socket <path>", "UDS パス (省略時は既定)")
    .option("--subscribe <topics>", "イベント購読 (例: lockState,deviceUpdate)。Ctrl-C で停止")
    .option("--paths", "接続情報 (socket / token のパス) を JSON 出力 (他言語クライアント用)")
    .addHelpText("after", `
例:
  sesame rpc                                  # 全メソッドと引数を一覧
  sesame rpc status
  sesame rpc lock.unlock --params '{"name":"front"}'
  sesame rpc --subscribe lockState            # 鍵状態の変化を表示し続ける
  sesame rpc --paths                          # 他言語から繋ぐ接続情報を JSON で`)
    .action((method, opts) => cmdRpc(method, opts, program));
}

/** UDS を保持し events を購読、各イベントを 1 行 JSON で出し続ける (Ctrl-C で終了)。 */
function rpcSubscribe(socketPath, topics) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    let buf = "";
    sock.on("connect", () => {
      sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "events.subscribe", params: { topics } }) + "\n");
      console.error(`[subscribed] ${topics.join(",")} — Ctrl-C で停止`);
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
        reject(new Error(`sesame serve が起動していません (socket: ${socketPath})。別ターミナルで \`sesame serve\` を実行してください`));
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
    const to = setTimeout(() => { sock.destroy(); reject(new Error("rpc timeout")); }, timeoutMs);
    sock.on("connect", () => sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n"));
    sock.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(to); sock.destroy();
      const msg = JSON.parse(buf.slice(0, nl));
      if (msg.error) { const e = new Error(msg.error.message); e.code = msg.error.code; return reject(e); }
      resolve(msg.result);
    });
    sock.on("error", (e) => {
      clearTimeout(to);
      if (e.code === "ENOENT" || e.code === "ECONNREFUSED") {
        reject(new Error(`sesame serve が起動していません (socket: ${socketPath})。別ターミナルで \`sesame serve\` を実行してください`));
      } else reject(e);
    });
  });
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
    await rpcSubscribe(socketPath, topics);
    return;
  }

  const m = method || "rpc.discover";
  let params = {};
  if (opts.params) {
    try { params = JSON.parse(opts.params); } catch (e) { console.error(`Error: --params が不正な JSON: ${e.message}`); process.exit(2); }
  }
  const result = await rpcCall(socketPath, m, params);
  // 未ログイン/失効を見たら次の一手を案内 (degraded で居座る問題の出口)。
  if (m === "status" && result && result.authState && result.authState !== "ok") {
    console.error(`Hint: 未ログイン/失効です。\`sesame login <email>\` 後にデーモンを再起動してください`);
  }
  if (program.opts().json) { console.log(JSON.stringify(result, null, 2)); return; }
  if (m === "rpc.discover") {
    // 人間向けの表: メソッド名 + 引数 (required はそのまま、任意は [name])。
    for (const meth of result.methods) {
      const ps = (meth.params || []).map((p) => (p.required ? p.name : `[${p.name}]`)).join(" ");
      console.log(`${meth.name.padEnd(28)} ${ps}`);
    }
    console.error(`\n${result.methods.length} methods. 例: sesame rpc lock.unlock --params '{"name":"front"}'`);
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
    note(`shutting down (${reason})...`);
    // hub.close() 等が万一ハングしても Ctrl-C 不能にならないよう強制終了の保険。
    const watchdog = setTimeout(() => { note("shutdown watchdog: forcing exit"); process.exit(1); }, 5000);
    watchdog.unref();
    for (const h of handles) { try { await h.stop?.(); } catch { /* ignore */ } }
    await daemon.shutdown();
    clearTimeout(watchdog);
    resolveRun();
  };

  try {
    if (wantStdio) { handles.push(startStdioFraming(daemon, { onShutdown: () => shutdown("stdin EOF") })); note("stdio framing ready (NDJSON JSON-RPC on stdin/stdout)"); }
    if (wantSocket) {
      const h = await startSocketFraming(daemon, { socketPath }); handles.push(h);
      note(`unix socket: ${h.path}`);
      note(`  quick test: printf '{"jsonrpc":"2.0","id":1,"method":"rpc.discover"}\\n' | nc -U ${h.path} | head -c 200`);
    }
    if (httpPort != null) { const h = await startHttpFraming(daemon, { bind: opts.bind, port: httpPort, token }); handles.push(h); note(`http: ${h.url}  (ブラウザで開くと使い方。POST /rpc, GET /events)`); }
    if (wsPort != null) {
      const h = await startWsFraming(daemon, { bind: opts.bind, port: wsPort, token }); handles.push(h);
      note(`ws: ${h.url}  (認証は Authorization: Bearer。ブラウザのみ ?token=<token>)`);
      note(`  quick test: wscat -c "${h.url}?token=<token>"  (npm i -g wscat)`);
    }
    if (grpcPort != null) { const h = await startGrpcFraming(daemon, { bind: opts.bind, port: grpcPort, token }); handles.push(h); note(`grpc: ${opts.bind}:${h.port}  (型付き。上級者向け。proto: src/serve/sesame.proto)`); }
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
      note(`token: ${token}`);
      note(`  use as: Authorization: Bearer ${token}`);
      note(`  saved to: ${tokenFile}`);
    } catch {
      note(`token: ${token}  (Authorization: Bearer <token> 必須)`);
    }
    if (opts.bind && opts.bind !== "127.0.0.1" && opts.bind !== "localhost") {
      note(`WARNING: --bind ${opts.bind} はロック制御をネットワークに公開します。`);
      note("  HTTP/WS/gRPC はいずれも TLS なしの平文です。token もロック制御コマンドも");
      note("  盗聴・リプレイ可能なので、LAN 公開は VPN / SSH トンネル / TLS リバースプロキシ越しに限定し、");
      note("  ファイアウォールで接続元を絞ること (token があるだけでは平文盗聴に無力)。");
    }
  }
  daemon.start(); // クラウド接続を背景で試行 (失敗しても degraded で継続)
  note("ready. (未ログインなら上の cloud connect 失敗を確認し `sesame login` を実行。Ctrl-C で停止)");

  // シグナル/致命例外で graceful shutdown。プロセスはここで shutdown まで生き続ける。
  const onSig = (s) => shutdown(s);
  process.once("SIGINT", () => onSig("SIGINT"));
  process.once("SIGTERM", () => onSig("SIGTERM"));
  process.once("SIGHUP", () => onSig("SIGHUP"));
  // uncaughtException は本当に異常 → cleanup して exit。
  process.once("uncaughtException", async (e) => { note("uncaughtException:", e?.message); await shutdown("uncaughtException"); process.exit(1); });
  // unhandledRejection はログのみ (良性の reject 1 個でロック制御を落とさない)。
  // ただし**短時間のバースト**は構造的バグなので exit (無限ログ垂れ流しを防ぐ)。
  // 生涯累積で数えると無期限常駐が良性 reject の蓄積でいつか必ず落ちるため、直近 60s の窓で判定する。
  const rejTimes = [];
  process.on("unhandledRejection", (e) => {
    note("unhandledRejection (ignored):", e?.message || e);
    const now = Date.now();
    rejTimes.push(now);
    while (rejTimes.length && now - rejTimes[0] > 60_000) rejTimes.shift();
    if (rejTimes.length > 50) { note("too many unhandled rejections in 60s — exiting"); process.exit(1); }
  });

  await runUntilShutdown;
}
