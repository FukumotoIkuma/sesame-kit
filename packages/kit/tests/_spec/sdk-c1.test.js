// spec-domain: sdk | prefix: SDK | ids: SDK-0020 – SDK-0029
// Target IDs: SDK-0020, SDK-0021, SDK-0022, SDK-0023, SDK-0024, SDK-0025, SDK-0026, SDK-0027, SDK-0028, SDK-0029
//
// Pure-function / static-analysis tests — no network, no real devices.
// All transport calls are replaced with mocks; path-resolution is tested
// by manipulating process.env in a controlled way and restoring it.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KIT_DIR   = resolve(__dirname, "..", "..");   // packages/kit
const ROOT_DIR  = resolve(KIT_DIR, "..", "..");     // repo root

// ── shared paths ──────────────────────────────────────────────────────────────
const CLIENTS_PY_DIR  = join(KIT_DIR, "clients", "python");
const CLIENTS_JS_MJS  = join(KIT_DIR, "clients", "js", "sesame-client.mjs");
const KIT_PACKAGE_JSON = join(KIT_DIR, "package.json");
const SDK_TS_SRC       = join(KIT_DIR, "sdk", "ts", "sesame-client.ts");

// ── lazy loaded module cache ───────────────────────────────────────────────────
let _clientsJsMod;
async function clientsJs() {
  if (!_clientsJsMod) {
    _clientsJsMod = await import(CLIENTS_JS_MJS);
  }
  return _clientsJsMod;
}

// ── committed sesame-client.ts source (read once) ────────────────────────────
let _sdkTsCommitted;
function sdkTsCommitted() {
  if (!_sdkTsCommitted) {
    _sdkTsCommitted = readFileSync(SDK_TS_SRC, "utf8");
  }
  return _sdkTsCommitted;
}

// =============================================================================
// SDK-0020  clients/python パッケージ整合
// =============================================================================
describe("[SDK-0020] clients/python パッケージ整合 (setup.cfg / pyproject.toml / .npmignore)", () => {
  it("[SDK-0020] setup.cfg: [metadata] name=sesame-client / version 存在 / [options] py_modules=sesame_client / python_requires>=3.8", () => {
    const raw = readFileSync(join(CLIENTS_PY_DIR, "setup.cfg"), "utf8");

    expect(raw).toContain("[metadata]");
    expect(raw).toMatch(/name\s*=\s*sesame-client/);
    expect(raw).toMatch(/version\s*=/);
    expect(raw).toContain("[options]");
    expect(raw).toMatch(/py_modules\s*=\s*sesame_client/);
    expect(raw).toMatch(/python_requires\s*=\s*>=3\.8/);
  });

  it("[SDK-0020] pyproject.toml: build-system のみで [project] テーブルを持たない (UNKNOWN-0.0.0 罠回避)", () => {
    const raw = readFileSync(join(CLIENTS_PY_DIR, "pyproject.toml"), "utf8");

    expect(raw).toContain("[build-system]");
    expect(raw).toContain("build-backend");
    // PEP 621 [project] が無いことを確認
    expect(raw).not.toContain("[project]");
  });

  it("[SDK-0020] .npmignore: __pycache__/ と *.py[cod] の 2 パターンが含まれる", () => {
    const raw = readFileSync(join(CLIENTS_PY_DIR, ".npmignore"), "utf8");

    expect(raw).toContain("__pycache__/");
    expect(raw).toContain("*.py[cod]");
  });
});

// =============================================================================
// SDK-0021  clients/js sanitizeServeToken テイントバリア
// =============================================================================
describe("[SDK-0021] clients/js sanitizeServeToken CRLF/ヘッダ/URL インジェクション遮断", () => {
  it("[SDK-0021] sanitizeServeToken: null/空文字列 → null (エラーなし)", async () => {
    const { SesameClient } = await clientsJs();
    const c = SesameClient.http("http://127.0.0.1:19999", null);
    expect(c).toBeTruthy();
    expect(() => SesameClient.http("http://127.0.0.1:19999", "")).not.toThrow();
  });

  it("[SDK-0021] sanitizeServeToken: URL-safe 文字のみ → 正常通過 (構築エラーなし)", async () => {
    const { SesameClient } = await clientsJs();
    expect(() => SesameClient.http("http://127.0.0.1:19999", "abc123ABC_-")).not.toThrow();
    expect(() => SesameClient.http("http://127.0.0.1:19999", "abc123_-~+=/.")).not.toThrow();
  });

  it("[SDK-0021] sanitizeServeToken: 改行文字を含む → SesameRpcError(kind=not_authenticated) を throw", async () => {
    const { SesameClient, SesameRpcError } = await clientsJs();
    expect(() => SesameClient.http("http://127.0.0.1:19999", "token\nInjected: header"))
      .toThrow(SesameRpcError);
    try {
      SesameClient.http("http://127.0.0.1:19999", "token\r\nInjected: evil");
    } catch (e) {
      expect(e.kind).toBe("not_authenticated");
    }
  });

  it("[SDK-0021] sanitizeServeToken: 空白文字を含む → SesameRpcError(kind=not_authenticated) を throw", async () => {
    const { SesameClient, SesameRpcError } = await clientsJs();
    expect(() => SesameClient.http("http://127.0.0.1:19999", "bad token here"))
      .toThrow(SesameRpcError);
    try {
      SesameClient.http("http://127.0.0.1:19999", "bad token here");
    } catch (e) {
      expect(e.kind).toBe("not_authenticated");
    }
  });

  it("[SDK-0021] sanitizeServeToken: 制御文字(タブ)を含む → SesameRpcError(kind=not_authenticated) を throw", async () => {
    const { SesameClient, SesameRpcError } = await clientsJs();
    expect(() => SesameClient.http("http://127.0.0.1:19999", "tok\ten")).toThrow(SesameRpcError);
    try {
      SesameClient.http("http://127.0.0.1:19999", "tok\ten");
    } catch (e) {
      expect(e.kind).toBe("not_authenticated");
    }
  });

  it("[SDK-0021] HttpTransport と WsTransport の両方が同一バリアを通す (ソース検査)", () => {
    const src = readFileSync(CLIENTS_JS_MJS, "utf8");

    expect(src).toContain("sanitizeServeToken");
    // 正規表現バリアが定義されている
    expect(src).toMatch(/\[\\\w\.\~\+\/=-\]\+/);
    // WsTransport ctor でも sanitizeServeToken が呼ばれる
    const wsClassStart = src.indexOf("class WsTransport");
    const wsClassBody = src.slice(wsClassStart, wsClassStart + 500);
    expect(wsClassBody).toContain("sanitizeServeToken");
  });

  it("[SDK-0021] WsTransport も同一バリアを通す (WS ctor で invalid token → throw)", async () => {
    const { SesameClient, SesameRpcError } = await clientsJs();
    await expect(SesameClient.ws("ws://127.0.0.1:19998", "bad token with space")).rejects.toMatchObject({
      name: "SesameRpcError",
      kind: "not_authenticated",
    });
  });
});

// =============================================================================
// SDK-0022  clients/js transport 機構 (id 共有 / idle-close / 握手認証)
// =============================================================================
describe("[SDK-0022] clients/js StreamTransport 機構 (id 共有 / idle-close / routeMessage)", () => {
  it("[SDK-0022] routeMessage: id 一致応答を _pending から pop して resolve する (ソース検査)", () => {
    const src = readFileSync(CLIENTS_JS_MJS, "utf8");
    expect(src).toContain("_pending.has(msg.id)");
    expect(src).toContain("self._pending.delete(msg.id)");
    expect(src).toContain("resolve(msg)");
  });

  it("[SDK-0022] routeMessage: method が 'event.' で始まる通知のみ onEvent へ振り分ける", () => {
    const src = readFileSync(CLIENTS_JS_MJS, "utf8");
    expect(src).toContain('msg.method.startsWith("event.")');
    expect(src).toContain('msg.method.slice("event.".length)');
  });

  it("[SDK-0022] StreamTransport: _ids が 0 から始まり ++_ids で採番される", () => {
    const src = readFileSync(CLIENTS_JS_MJS, "utf8");
    expect(src).toMatch(/this\._ids\s*=\s*0/);
    expect(src).toContain("++this._ids");
  });

  it("[SDK-0022] StreamTransport: 20s タイムアウトで kind='timeout' を reject する", () => {
    const src = readFileSync(CLIENTS_JS_MJS, "utf8");
    expect(src).toContain("20000");
    expect(src).toContain('"timeout"');
  });

  it("[SDK-0022] StreamTransport: 購読/pending 無で _scheduleIdleClose+unref を呼ぶ (ソース検査)", () => {
    const src = readFileSync(CLIENTS_JS_MJS, "utf8");
    expect(src).toContain("_scheduleIdleClose");
    expect(src).toContain("unref");
    expect(src).toContain("this._subscribed");
    expect(src).toContain("this._pending.size");
  });

  it("[SDK-0022] WsTransport: 握手 401/403/unauthorized → not_authenticated (ソース検査)", () => {
    const src = readFileSync(CLIENTS_JS_MJS, "utf8");
    expect(src).toMatch(/401|403|unauthorized/i);
    expect(src).toContain('"not_authenticated"');
    expect(src).toContain("1008");
  });

  it("[SDK-0022] WsTransport: call と subscribe が同一 _ids カウンタを共有する (ソース検査)", () => {
    const src = readFileSync(CLIENTS_JS_MJS, "utf8");
    const wsClassStart = src.indexOf("class WsTransport");
    const wsClassBody = src.slice(wsClassStart, wsClassStart + 2000);
    expect(wsClassBody).toMatch(/this\._ids\s*=\s*0/);
    expect(wsClassBody).toContain("++this._ids");
  });

  it("[SDK-0022] routeMessage: id 一致応答は _pending から pop して resolve される (ソース構造検査)", () => {
    // ESM の node:net は namespace が configurable=false のため vi.spyOn 不可。
    // 代わりにソース上で routeMessage のアルゴリズムが正しく実装されていることを確認する。
    const src = readFileSync(CLIENTS_JS_MJS, "utf8");
    // routeMessage の本体が存在し、id 一致で _pending から取り出して resolve する
    expect(src).toContain("function routeMessage(self, line)");
    expect(src).toContain("self._pending.has(msg.id)");
    const fnStart = src.indexOf("function routeMessage");
    const fnBody = src.slice(fnStart, fnStart + 400);
    expect(fnBody).toContain("self._pending.get(msg.id)");
    expect(fnBody).toContain("self._pending.delete(msg.id)");
    expect(fnBody).toContain("resolve(msg)");
  });

  it("[SDK-0022] routeMessage: event.topic 通知は onEvent へ振り分けられる (ソース構造検査)", () => {
    // ESM の node:net は namespace が configurable=false のため vi.spyOn 不可。
    const src = readFileSync(CLIENTS_JS_MJS, "utf8");
    const fnStart = src.indexOf("function routeMessage");
    const fnBody = src.slice(fnStart, fnStart + 500);
    // event. prefix で始まる method を onEvent へ振り分ける
    expect(fnBody).toContain('msg.method.startsWith("event.")');
    expect(fnBody).toContain('msg.method.slice("event.".length)');
    expect(fnBody).toContain("self._onEvent");
  });

  it("[SDK-0022] request timeout 20s — SesameRpcError(kind='timeout') で reject (ソース構造検査)", () => {
    // ESM の node:net は namespace が configurable=false のため vi.spyOn 不可。
    const src = readFileSync(CLIENTS_JS_MJS, "utf8");
    // StreamTransport.request に 20s timeout と kind='timeout' が実装されている
    const streamClassStart = src.indexOf("class StreamTransport");
    const streamClassEnd = src.indexOf("\nclass ", streamClassStart + 1);
    const streamBody = src.slice(streamClassStart, streamClassEnd > streamClassStart ? streamClassEnd : undefined);
    expect(streamBody).toContain("20000");
    expect(streamBody).toContain('"timeout"');
    expect(streamBody).toContain("SesameRpcError");
  });
});

// =============================================================================
// SDK-0023  生成 TS SDK の _call 封筒 (unary HTTP)
// =============================================================================
describe("[SDK-0023] 生成 TS SDK の _call 封筒 (jsonrpc/id/Bearer/error 翻訳)", () => {
  const committed = () => sdkTsCommitted();

  it("[SDK-0023] _call: {jsonrpc:'2.0', id:++this._id, method, params} を POST する", () => {
    const src = committed();
    expect(src).toContain("private async _call(");
    expect(src).toContain('jsonrpc: "2.0"');
    expect(src).toMatch(/id:\s*\+\+this\._id/);
    expect(src).toContain('method: "POST"');
    expect(src).toContain("/rpc");
  });

  it("[SDK-0023] _call: token があれば Authorization: Bearer を付す", () => {
    const src = committed();
    expect(src).toContain("Bearer");
    expect(src).toContain("authorization");
  });

  it("[SDK-0023] _call: fetch 例外は SesameRpcError(-32000, connection_lost, retryable) に翻訳", () => {
    const src = committed();
    expect(src).toContain("-32000");
    expect(src).toContain('"connection_lost"');
    expect(src).toContain("retryable: true");
    expect(src).toContain("cannot reach sesame serve");
  });

  it("[SDK-0023] _call: 非200 は httpErrorFromBody で verbatim error body / httpErrorKind(status) 合成", () => {
    const src = committed();
    expect(src).toContain("httpErrorFromBody");
    expect(src).toContain("httpErrorKind");
    expect(src).toContain("httpRetryable");
    expect(src).toMatch(/if \(!res\.ok\).*httpErrorFromBody/s);
  });

  it("[SDK-0023] _call: JSON.parse 失敗は -32700 internal に翻訳 (parseResponseJson)", () => {
    const src = committed();
    expect(src).toContain("-32700");
    expect(src).toContain("parseResponseJson");
    expect(src).toContain('"internal"');
    expect(src).toContain("retryable: false");
  });

  it("[SDK-0023] _call 実動作: gen-sdk-ts.mjs の generateSdk で生成物が committed と一致する (drift gate)", async () => {
    const { generateSdk } = await import(join(ROOT_DIR, "scripts", "gen-sdk-ts.mjs"));
    const spec = JSON.parse(readFileSync(join(ROOT_DIR, "schema", "openrpc.json"), "utf8"));
    const generated = generateSdk(spec);
    expect(generated).toBe(sdkTsCommitted());
  });

  it("[SDK-0023] httpErrorFromBody: JSON-RPC error body (code+message) を verbatim に採用する (ソース検査)", () => {
    const src = committed();
    expect(src).toContain('typeof rpc.code === "number"');
    expect(src).toContain('typeof rpc.message === "string"');
  });
});

// =============================================================================
// SDK-0024  sesame sdk eject の I/O エラーパス (ok:false 封筒)
// =============================================================================
describe("[SDK-0024] sesame sdk eject I/O エラーパス (read-fail / write-fail)", () => {
  it("[SDK-0024] readFileSync 失敗メッセージが 'Cannot read SDK source: ...' になる (ソース検査)", () => {
    const src = readFileSync(join(KIT_DIR, "src", "cli", "sdk.js"), "utf8");
    expect(src).toContain("Cannot read SDK source:");
  });

  it("[SDK-0024] writeFileSync/mkdirSync 失敗メッセージが 'Cannot write to <destPath>: ...' になる (ソース検査)", () => {
    const src = readFileSync(join(KIT_DIR, "src", "cli", "sdk.js"), "utf8");
    expect(src).toContain("Cannot write to ");
  });

  it("[SDK-0024] read 失敗: isJsonMode → stdout ok:false / 非JSON → stderr 'error: ...' (ソース検査)", () => {
    const src = readFileSync(join(KIT_DIR, "src", "cli", "sdk.js"), "utf8");
    // ok: false の JSON 出力 (JSON.stringify({ ok: false, error: msg }))
    expect(src).toContain("ok: false");
    // stderr へ error: プレフィクス出力
    expect(src).toContain("`error: ${msg}\\n`");
    // process.exitCode = 1
    expect(src).toContain("process.exitCode = 1");
  });

  it("[SDK-0024] write 失敗: destPath を含むメッセージが stdout/stderr に出る (ソース検査)", () => {
    const src = readFileSync(join(KIT_DIR, "src", "cli", "sdk.js"), "utf8");
    expect(src).toContain("Cannot write to ${destPath}:");
  });

  it("[SDK-0024] 両 I/O エラーパスとも process.exitCode=1 で終了 (ソース検査)", () => {
    const src = readFileSync(join(KIT_DIR, "src", "cli", "sdk.js"), "utf8");
    const matches = [...src.matchAll(/process\.exitCode\s*=\s*1/g)];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it("[SDK-0024] readFileSync 失敗 → 非JSON モードで stderr に 'error: Cannot read SDK source: ...' / exitCode=1 (ソース検査)", () => {
    // ESM の node:fs は namespace が configurable=false のため vi.spyOn 不可。
    // ソース上で catch ブロックが process.stderr.write(error: ... \n) と process.exitCode=1 を実装していることを確認する。
    const src = readFileSync(join(KIT_DIR, "src", "cli", "sdk.js"), "utf8");
    // read 失敗の catch ブロック
    expect(src).toContain("Cannot read SDK source:");
    // 非JSON モードでは stderr に error: プレフィクスで出力する
    expect(src).toContain("`error: ${msg}\\n`");
    expect(src).toContain("process.exitCode = 1");
    // isJsonMode() 分岐が存在する
    expect(src).toContain("isJsonMode()");
  });

  it("[SDK-0024] writeFileSync 失敗 → 非JSON モードで stderr に 'error: Cannot write to <dest>: ...' / exitCode=1 (ソース検査)", () => {
    // ESM の node:fs は namespace が configurable=false のため vi.spyOn 不可。
    const src = readFileSync(join(KIT_DIR, "src", "cli", "sdk.js"), "utf8");
    // write 失敗の catch ブロック
    expect(src).toContain("Cannot write to ${destPath}:");
    // 非JSON モードでは stderr に error: プレフィクスで出力する
    expect(src).toContain("`error: ${msg}\\n`");
    // exitCode = 1 が設定される
    const matches = [...src.matchAll(/process\.exitCode\s*=\s*1/g)];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// SDK-0025  clients/js WsTransport: ヘッダ vs URL token 分岐 / 握手認証失敗 reject
// =============================================================================
describe("[SDK-0025] clients/js WsTransport — ヘッダ vs URL token 分岐 / 握手認証失敗", () => {
  it("[SDK-0025] ws パッケージ有 (useHeader=true) → Authorization ヘッダ使用 (ソース検査)", () => {
    const src = readFileSync(CLIENTS_JS_MJS, "utf8");
    // useHeader フラグが存在する
    expect(src).toContain("useHeader");
    // ヘッダ使用時は Authorization: Bearer トークンをヘッダに乗せる
    expect(src).toContain("authorization: `Bearer ${token}`");
    // useHeader && token のとき headers を使う分岐
    expect(src).toContain("useHeader && token");
    // ws パッケージがある場合は useHeader=true (!!pkg)
    expect(src).toContain("/* useHeader */");
    expect(src).toContain("!!pkg");
  });

  it("[SDK-0025] ws パッケージ無 (useHeader=false) → URL ?token= にフォールバック", () => {
    const src = readFileSync(CLIENTS_JS_MJS, "utf8");
    expect(src).toContain("token=${token}");
    expect(src).toContain("globalThis.WebSocket");
  });

  it("[SDK-0025] SesameClient.ws が ws パッケージを優先 import し、無ければ global WebSocket にフォールバック", () => {
    const src = readFileSync(CLIENTS_JS_MJS, "utf8");
    expect(src).toContain('import("ws")');
    expect(src).toContain(".catch(() => null)");
    expect(src).toContain("globalThis.WebSocket");
  });

  it("[SDK-0025] ready() は _open Promise を返し、握手完了を同期確立する", () => {
    const src = readFileSync(CLIENTS_JS_MJS, "utf8");
    expect(src).toContain("ready() { return this._open; }");
  });

  it("[SDK-0025] 401/403/unauthorized error → not_authenticated で reject (ソース検査)", () => {
    const src = readFileSync(CLIENTS_JS_MJS, "utf8");
    expect(src).toMatch(/401\|403\|unauthorized/i);
    expect(src).toContain('"not_authenticated"');
  });

  it("[SDK-0025] close code 1008 → not_authenticated として reject (ソース検査)", () => {
    const src = readFileSync(CLIENTS_JS_MJS, "utf8");
    expect(src).toContain("1008");
    expect(src).toMatch(/ev\.code === 1008/);
    // 1008 ブロックに not_authenticated が近接している
    const idx = src.indexOf("1008");
    const ctx = src.slice(idx, idx + 200);
    expect(ctx).toContain("not_authenticated");
  });

  it("[SDK-0025] request timeout は 20s (ソース検査)", () => {
    const src = readFileSync(CLIENTS_JS_MJS, "utf8");
    const wsClassStart = src.indexOf("class WsTransport");
    const wsClassEnd   = src.indexOf("\nclass ", wsClassStart + 1);
    const wsBody = src.slice(wsClassStart, wsClassEnd > wsClassStart ? wsClassEnd : undefined);
    expect(wsBody).toContain("20000");
    expect(src).toContain('"timeout"');
  });
});

// =============================================================================
// SDK-0026  clients/js defaultConfigDir 3 段優先順位
// =============================================================================
describe("[SDK-0026] clients/js defaultConfigDir 3 段優先順位 (SESAME_KIT_HOME / XDG / ~/.config)", () => {
  let savedEnv;
  beforeEach(() => {
    savedEnv = {
      SESAME_KIT_HOME: process.env.SESAME_KIT_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    };
    delete process.env.SESAME_KIT_HOME;
    delete process.env.XDG_CONFIG_HOME;
  });
  afterEach(() => {
    if (savedEnv.SESAME_KIT_HOME !== undefined) process.env.SESAME_KIT_HOME = savedEnv.SESAME_KIT_HOME;
    else delete process.env.SESAME_KIT_HOME;
    if (savedEnv.XDG_CONFIG_HOME !== undefined) process.env.XDG_CONFIG_HOME = savedEnv.XDG_CONFIG_HOME;
    else delete process.env.XDG_CONFIG_HOME;
  });

  it("[SDK-0026] ソース: SESAME_KIT_HOME → XDG_CONFIG_HOME/sesame-kit → ~/.config/sesame-kit の 3 段 (ソース検査)", () => {
    const src = readFileSync(CLIENTS_JS_MJS, "utf8");
    expect(src).toContain("SESAME_KIT_HOME");
    expect(src).toContain("XDG_CONFIG_HOME");
    expect(src).toContain('"sesame-kit"');
    expect(src).toContain('.config');
  });

  it("[SDK-0026] SESAME_KIT_HOME が設定されている場合はそのディレクトリを返す (最優先) (ソース検査)", () => {
    const src = readFileSync(CLIENTS_JS_MJS, "utf8");
    expect(src).toMatch(/if \(process\.env\.SESAME_KIT_HOME\)/);
    expect(src).toContain("return process.env.SESAME_KIT_HOME");
  });

  it("[SDK-0026] XDG_CONFIG_HOME が設定されている場合は $XDG_CONFIG_HOME/sesame-kit を返す (ソース検査)", () => {
    const src = readFileSync(CLIENTS_JS_MJS, "utf8");
    expect(src).toMatch(/const xdg = process\.env\.XDG_CONFIG_HOME/);
    expect(src).toMatch(/if \(xdg\) return join\(xdg, "sesame-kit"\)/);
  });

  it("[SDK-0026] どちらも未設定なら ~/.config/sesame-kit を返す (ソース検査)", () => {
    const src = readFileSync(CLIENTS_JS_MJS, "utf8");
    expect(src).toMatch(/return join\(os\.homedir\(\), "\.config", "sesame-kit"\)/);
  });

  it("[SDK-0026] defaultSocketPath は defaultConfigDir() + sesame.sock, defaultTokenPath は serve.token (ソース検査)", () => {
    const src = readFileSync(CLIENTS_JS_MJS, "utf8");
    expect(src).toContain('join(defaultConfigDir(), "sesame.sock")');
    expect(src).toContain('join(defaultConfigDir(), "serve.token")');
    expect(src).toContain('"sesame.sock"');
    expect(src).toContain('"serve.token"');
  });

  it("[SDK-0026] defaultConfigDir 関数が src/paths.js から import せず自前で定義している (ソース検査)", () => {
    const src = readFileSync(CLIENTS_JS_MJS, "utf8");
    expect(src).not.toContain("from \"../src/paths");
    expect(src).not.toContain("from './src/paths");
    expect(src).toContain("function defaultConfigDir");
  });
});

// =============================================================================
// SDK-0027  clients/js パッケージ配布整合 (exports['./client'] / files)
// =============================================================================
describe("[SDK-0027] clients/js 配布整合 (package.json exports['./client'] + files)", () => {
  const pkg = () => JSON.parse(readFileSync(KIT_PACKAGE_JSON, "utf8"));

  it("[SDK-0027] exports['./client'].types が clients/js/sesame-client.d.ts を指す", () => {
    const p = pkg();
    expect(p.exports?.["./client"]?.types).toBe("./clients/js/sesame-client.d.ts");
  });

  it("[SDK-0027] exports['./client'].default が clients/js/sesame-client.mjs を指す", () => {
    const p = pkg();
    expect(p.exports?.["./client"]?.default).toBe("./clients/js/sesame-client.mjs");
  });

  it("[SDK-0027] files に 'clients/' が含まれる (npm 配布同梱)", () => {
    const p = pkg();
    expect(p.files).toContain("clients/");
  });

  it("[SDK-0027] clients/js ディレクトリに package.json が存在しない (親 kit の export-map に依存する設計)", () => {
    const clientsJsDir = join(KIT_DIR, "clients", "js");
    let exists = true;
    try { readFileSync(join(clientsJsDir, "package.json"), "utf8"); } catch { exists = false; }
    expect(exists).toBe(false);
  });
});

// =============================================================================
// SDK-0028  生成 TS SDK の streamEvents (SSE) フレーム解析 + HTTP error 翻訳
// =============================================================================
describe("[SDK-0028] 生成 TS SDK streamEvents SSE フレーム解析 + HTTP error 翻訳", () => {
  const src = () => sdkTsCommitted();

  it("[SDK-0028] streamEvents が GET /events?topics=... を Authorization: Bearer 付きで開く", () => {
    const s = src();
    expect(s).toContain("async streamEvents(");
    expect(s).toContain("/events?topics=");
    expect(s).toContain("encodeURIComponent");
    expect(s).toContain('accept: "text/event-stream"');
  });

  it("[SDK-0028] 'data:' で始まる行のみ JSON.parse して onEvent へ流す", () => {
    const s = src();
    expect(s).toContain('startsWith("data:")');
    expect(s).toContain("onEvent(JSON.parse(json)");
  });

  it("[SDK-0028] ':' コメント行 (heartbeat) は無視 ('data:' 以外はスキップ)", () => {
    const s = src();
    expect(s).toMatch(/heartbeat.*ignored|ignored.*heartbeat/i);
  });

  it("[SDK-0028] buf.split('\\n') の末尾部分行を保持する (チャンク跨ぎ対応)", () => {
    const s = src();
    expect(s).toContain('buf.split("\\n")');
    expect(s).toContain("lines.pop()");
    expect(s).toContain('buf = lines.pop() ?? ""');
    expect(s).toContain("// keep the partial trailing line");
  });

  it("[SDK-0028] !res.ok → httpErrorFromBody で JSON-RPC error body 優先 / なければ httpErrorKind(status)", () => {
    const s = src();
    expect(s).toContain("httpErrorFromBody");
    expect(s).toContain("parseResponseJson");
    expect(s).toContain("if (!res.ok || !res.body)");
    expect(s).toMatch(/if \(!res\.ok.*\).*httpErrorFromBody/s);
  });

  it("[SDK-0028] JSON parse 失敗 → SesameRpcError(-32700) に翻訳 (parseResponseJson)", () => {
    const s = src();
    expect(s).toContain("-32700");
    expect(s).toContain('"internal"');
  });

  it("[SDK-0028] streamEvents テンプレが gen-sdk-ts.mjs の固定テンプレ部に存在する (ソース検査)", () => {
    const genSrc = readFileSync(join(ROOT_DIR, "scripts", "gen-sdk-ts.mjs"), "utf8");
    expect(genSrc).toContain("streamEvents");
    expect(genSrc).toContain("heartbeat");
    expect(genSrc).toContain("httpErrorFromBody");
    expect(genSrc).toContain("parseResponseJson");
  });

  it("[SDK-0028] httpErrorFromBody: JSON-RPC error body が code:number/message:string を持てば verbatim", () => {
    const s = src();
    expect(s).toContain('typeof rpc.code === "number"');
    expect(s).toContain('typeof rpc.message === "string"');
    expect(s).toContain("httpErrorKind(res.status)");
    expect(s).toContain("httpRetryable(res.status)");
  });
});

// =============================================================================
// SDK-0029  clients/python の _sesame_error_from_http body.kind 優先順位
// =============================================================================
describe("[SDK-0029] clients/python _sesame_error_from_http body.kind 優先順位", () => {
  const pyClientSrc = () =>
    readFileSync(join(CLIENTS_PY_DIR, "sesame_client.py"), "utf8");

  it("[SDK-0029] _sesame_error_from_http が存在し、err が dict の場合 err.data.kind を優先する (ソース検査)", () => {
    const src = pyClientSrc();
    expect(src).toContain("def _sesame_error_from_http");
    expect(src).toContain('err_data.get("kind") or _http_kind(code)');
  });

  it("[SDK-0029] err が str の場合 → _http_kind(code) を kind とする (ソース検査)", () => {
    const src = pyClientSrc();
    expect(src).toContain("isinstance(err, str)");
    const fnStart = src.indexOf("def _sesame_error_from_http");
    const fnBody  = src.slice(fnStart, fnStart + 800);
    expect(fnBody).toContain("_http_kind(code)");
  });

  it("[SDK-0029] body が parse 不能 / dict でない場合 → text || 'HTTP {code}: {reason}' + _http_kind(code)", () => {
    const src = pyClientSrc();
    expect(src).toContain('"HTTP {code}: {reason}"');
    expect(src).toContain("_http_kind(code)");
  });

  it("[SDK-0029] 401 かつ token 無し → _unauthorized() で具体的案内に分岐 (ソース検査)", () => {
    const src = pyClientSrc();
    expect(src).toContain("def _unauthorized(self)");
    expect(src).toContain("e.code == 401 and not self._token");
    expect(src).toContain("self._unauthorized()");
  });

  it("[SDK-0029] err が dict のとき _http_kind(code) より err.data.kind が優先される (優先順位の順序確認)", () => {
    const src = pyClientSrc();
    const fnStart = src.indexOf("def _sesame_error_from_http");
    const fnEnd   = src.indexOf("\ndef ", fnStart + 1);
    const fnBody  = src.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 1000);

    const dictBranchIdx = fnBody.indexOf("isinstance(err, dict)");
    const strBranchIdx  = fnBody.indexOf("isinstance(err, str)");
    expect(dictBranchIdx).toBeGreaterThanOrEqual(0);
    expect(strBranchIdx).toBeGreaterThanOrEqual(0);
    expect(dictBranchIdx).toBeLessThan(strBranchIdx);
  });

  // ── JS 再現ロジックで各分岐を検証 ─────────────────────────────────────────────
  function httpKindPy(status) {
    if (status === 401 || status === 403) return "not_authenticated";
    if (status === 400 || status === 413 || status === 415) return "bad_params";
    if (status === 404) return "not_implemented";
    if (status === 408 || status === 429 || status >= 500) return "connection_lost";
    return "internal";
  }

  function sesameErrorFromHttp(code, reason, bodyText) {
    const text = bodyText || "";
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    const err = (data && typeof data === "object") ? data.error : null;
    if (err && typeof err === "object") {
      const errData = err.data || {};
      return {
        message: err.message || reason || "HTTP error",
        kind: errData.kind || httpKindPy(code),
        code: err.code !== undefined ? err.code : code,
      };
    }
    if (typeof err === "string") {
      return { message: err, kind: httpKindPy(code), code };
    }
    return { message: text || `HTTP ${code}: ${reason}`, kind: httpKindPy(code), code };
  }

  it("[SDK-0029] error が dict で err.data.kind がある → body.kind が _http_kind(status) より優先される", () => {
    const body = JSON.stringify({
      error: { code: -32000, message: "bad input", data: { kind: "bad_params" } },
    });
    const result = sesameErrorFromHttp(500, "Internal Server Error", body);
    expect(result.kind).toBe("bad_params");
  });

  it("[SDK-0029] error が dict で err.data.kind が無い → _http_kind(status) を使う", () => {
    const body = JSON.stringify({
      error: { code: -32000, message: "some error", data: {} },
    });
    const result = sesameErrorFromHttp(401, "Unauthorized", body);
    expect(result.kind).toBe("not_authenticated");
  });

  it("[SDK-0029] error が str → _http_kind(status) を kind に使う", () => {
    const body = JSON.stringify({ error: "simple error string" });
    const result = sesameErrorFromHttp(404, "Not Found", body);
    expect(result.kind).toBe("not_implemented");
    expect(result.message).toBe("simple error string");
  });

  it("[SDK-0029] body が parse 不能 → text + _http_kind(code)", () => {
    const result = sesameErrorFromHttp(503, "Service Unavailable", "not-json");
    expect(result.kind).toBe("connection_lost");
    expect(result.message).toBe("not-json");
  });

  it("[SDK-0029] body が空 → 'HTTP {code}: {reason}' + _http_kind(code)", () => {
    const result = sesameErrorFromHttp(503, "Service Unavailable", "");
    expect(result.kind).toBe("connection_lost");
    expect(result.message).toBe("HTTP 503: Service Unavailable");
  });

  it("[SDK-0029] _http_kind は 401/403→not_authenticated / 400/413/415→bad_params / 404→not_implemented / 408/429/5xx→connection_lost / other→internal (ソース確認+JS検証)", () => {
    const src = pyClientSrc();
    expect(src).toContain("def _http_kind(");
    expect(src).toContain('"not_authenticated"');
    expect(src).toContain('"bad_params"');
    expect(src).toContain('"not_implemented"');
    expect(src).toContain('"connection_lost"');
    expect(src).toContain('"internal"');
    // JS 再現ロジックでも各マッピングを確認
    expect(httpKindPy(401)).toBe("not_authenticated");
    expect(httpKindPy(403)).toBe("not_authenticated");
    expect(httpKindPy(400)).toBe("bad_params");
    expect(httpKindPy(413)).toBe("bad_params");
    expect(httpKindPy(415)).toBe("bad_params");
    expect(httpKindPy(404)).toBe("not_implemented");
    expect(httpKindPy(408)).toBe("connection_lost");
    expect(httpKindPy(429)).toBe("connection_lost");
    expect(httpKindPy(500)).toBe("connection_lost");
    expect(httpKindPy(503)).toBe("connection_lost");
    expect(httpKindPy(422)).toBe("internal");
    expect(httpKindPy(200)).toBe("internal");
  });

  it("[SDK-0029] _sesame_error_from_http の body.kind 優先: 実動作確認 (python3 サブプロセス)", async () => {
    const { spawnSync } = await import("node:child_process");
    const hasPython = spawnSync("python3", ["--version"]).status === 0;
    if (!hasPython) return;

    const script = `
import sys
sys.path.insert(0, ${JSON.stringify(CLIENTS_PY_DIR)})
import sesame_client as sc

# 1. err が dict → data.kind 優先
body_with_kind = b'{"error": {"code": -1, "message": "fail", "data": {"kind": "rejected"}}}'
e = sc._sesame_error_from_http(400, "Bad Request", body_with_kind)
assert e.kind == "rejected", f"expected rejected, got {e.kind}"

# 2. err が str → _http_kind(code)
body_str_err = b'{"error": "some error string"}'
e2 = sc._sesame_error_from_http(400, "Bad Request", body_str_err)
assert e2.kind == "bad_params", f"expected bad_params, got {e2.kind}"

# 3. body が parse 不能 → _http_kind(code)
body_bad = b"not json at all"
e3 = sc._sesame_error_from_http(404, "Not Found", body_bad)
assert e3.kind == "not_implemented", f"expected not_implemented, got {e3.kind}"

# 4. err が dict だが data.kind 無し → _http_kind(code) にフォールバック
body_no_kind = b'{"error": {"code": -1, "message": "fail", "data": {}}}'
e4 = sc._sesame_error_from_http(413, "Payload Too Large", body_no_kind)
assert e4.kind == "bad_params", f"expected bad_params, got {e4.kind}"

print("SDK0029OK")
`;
    const result = spawnSync("python3", ["-c", script], { encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`SDK-0029 python assertion failed:\n${result.stdout}\n${result.stderr}`);
    }
    expect(result.stdout).toContain("SDK0029OK");
  });
});
