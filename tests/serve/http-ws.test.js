// HTTP(+SSE) と WebSocket フレーミングの統合テスト (fake hub の Daemon に対して)。
import { describe, it, expect, afterEach, vi } from "vitest";
import { WebSocket } from "ws";
import { Daemon } from "../../src/serve/daemon.js";
import { startHttpFraming } from "../../src/serve/framing/http.js";
import { startWsFraming } from "../../src/serve/framing/ws.js";

const TOKEN = "test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function fakeHub() {
  let duFn = null;
  return {
    connected: true, subUUID: "s", config: { devices: {} },
    connect: vi.fn(async () => {}), close: vi.fn(async () => {}),
    onDeviceUpdate: (_items, fn) => { duFn = fn; return () => { duFn = null; }; },
    _emit: (m) => duFn && duFn(m),
  };
}

let handle;
afterEach(async () => { if (handle) await handle.stop(); handle = null; });

describe("HTTP framing", () => {
  it("POST /rpc に token 付きで JSON-RPC → 応答", async () => {
    const d = new Daemon({ hub: fakeHub(), version: "1.0.0" }); d.authState = "ok";
    handle = await startHttpFraming(d, { port: 0, token: TOKEN });
    const r = await fetch(`${handle.url}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "rpc.discover" }),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.result.openrpc).toBe("1.2.6");
  });

  it("token 無しは 401 で JSON-RPC 2.0 error を返す (data.kind=not_authenticated)", async () => {
    const d = new Daemon({ hub: fakeHub() });
    handle = await startHttpFraming(d, { port: 0, token: TOKEN });
    const r = await fetch(`${handle.url}/rpc`, { method: "POST", body: "{}" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/Bearer/);
    const j = await r.json();
    // README の構造化エラー契約 / SDK が期待する JSON-RPC 2.0 error 形であること。
    expect(j.jsonrpc).toBe("2.0");
    expect(j.id).toBeNull();
    expect(j.error).toBeTruthy();
    expect(typeof j.error.code).toBe("number");
    expect(typeof j.error.message).toBe("string");
    expect(j.error.data.kind).toBe("not_authenticated");
    // 旧来の {error, hint} 形ではないこと (回帰防止)。
    expect(j.error).not.toBe("unauthorized");
    expect(j.hint).toBeUndefined();
  });

  it("GET / の usage は --http 0 でも実バインドポートを表示する (127.0.0.1:0 にしない)", async () => {
    const d = new Daemon({ hub: fakeHub() }); d.authState = "ok";
    handle = await startHttpFraming(d, { port: 0, token: TOKEN });
    const realPort = new URL(handle.url).port;
    expect(realPort).not.toBe("0");
    const r = await fetch(`${handle.url}/`); // token 不要
    const text = await r.text();
    expect(text).toContain(`127.0.0.1:${realPort}`);
    expect(text).not.toContain("127.0.0.1:0");
  });

  it("CORS 未指定なら CORS ヘッダを一切出さない (安全な既定)", async () => {
    const d = new Daemon({ hub: fakeHub() }); d.authState = "ok";
    handle = await startHttpFraming(d, { port: 0, token: TOKEN });
    const r = await fetch(`${handle.url}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", origin: "https://app.example" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "rpc.discover" }),
    });
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    // preflight も CORS 無効時は通常の処理 (token 無し OPTIONS は 401)。
    const pre = await fetch(`${handle.url}/rpc`, { method: "OPTIONS", headers: { origin: "https://app.example" } });
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("CORS 有効 (allowlist): preflight 204 + 許可 origin を echo、許可外は echo しない", async () => {
    const d = new Daemon({ hub: fakeHub() }); d.authState = "ok";
    handle = await startHttpFraming(d, { port: 0, token: TOKEN, corsOrigins: ["https://app.example"] });
    // preflight (token 不要)
    const pre = await fetch(`${handle.url}/rpc`, {
      method: "OPTIONS",
      headers: { origin: "https://app.example", "access-control-request-method": "POST" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(pre.headers.get("access-control-allow-methods")).toContain("POST");
    expect(pre.headers.get("access-control-allow-headers")).toMatch(/authorization/i);
    expect(pre.headers.get("access-control-max-age")).toBeTruthy();
    // 実 POST にも echo (許可 origin)
    const ok = await fetch(`${handle.url}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", origin: "https://app.example" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "rpc.discover" }),
    });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.example");
    // 許可外 origin には ACAO を付けない
    const denied = await fetch(`${handle.url}/rpc`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("CORS '*' なら全 origin を許可 (preflight/POST で ACAO 付与)", async () => {
    const d = new Daemon({ hub: fakeHub() }); d.authState = "ok";
    handle = await startHttpFraming(d, { port: 0, token: TOKEN, corsOrigins: "*" });
    const pre = await fetch(`${handle.url}/rpc`, {
      method: "OPTIONS",
      headers: { origin: "https://whatever.example", "access-control-request-method": "POST" },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://whatever.example");
    const ok = await fetch(`${handle.url}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", origin: "https://whatever.example" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "rpc.discover" }),
    });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://whatever.example");
  });

  it("GET / の使用例は port 0 ではなく実際の listen port を表示する", async () => {
    const d = new Daemon({ hub: fakeHub() });
    handle = await startHttpFraming(d, { port: 0, token: TOKEN });
    const r = await fetch(`${handle.url}/`);
    expect(r.status).toBe(200);
    const text = await r.text();
    const port = new URL(handle.url).port;
    expect(text).toContain(`http://127.0.0.1:${port}/rpc`);
    expect(text).not.toContain("127.0.0.1:0/rpc");
  });

  it("GET /events (SSE) で購読しイベントを受信", async () => {
    const hub = fakeHub();
    const d = new Daemon({ hub }); d.authState = "ok";
    handle = await startHttpFraming(d, { port: 0, token: TOKEN });
    const ctrl = new AbortController();
    const res = await fetch(`${handle.url}/events?topics=lockState&token=${TOKEN}`, { signal: ctrl.signal });
    const reader = res.body.getReader();
    await reader.read(); // 初期コメント ": ok"
    await new Promise((r) => setTimeout(r, 30)); // 購読確立を待つ
    hub._emit({ data: { deviceUUID: "u1" } });
    let received = "";
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      received += new TextDecoder().decode(value);
      if (received.includes("event.lockState")) break;
    }
    ctrl.abort();
    expect(received).toContain("event.lockState");
  });
});

describe("WebSocket framing", () => {
  it("ws で rpc.discover が引ける", async () => {
    const d = new Daemon({ hub: fakeHub() }); d.authState = "ok";
    handle = await startWsFraming(d, { port: 0, token: TOKEN });
    const r = await wsRpc(`${handle.url}?token=${TOKEN}`, { jsonrpc: "2.0", id: 1, method: "rpc.discover" });
    expect(r.result.openrpc).toBe("1.2.6");
  });

  it("token 無しは握手で拒否 (401。open は発火しない)", async () => {
    const d = new Daemon({ hub: fakeHub() }); d.authState = "ok";
    handle = await startWsFraming(d, { port: 0, token: TOKEN });
    // verifyClient で 101 を返さず 401 で弾くため、open ではなく error (Unexpected server response: 401) になる。
    await expect(wsRpc(handle.url, { jsonrpc: "2.0", id: 2, method: "status" })).rejects.toThrow(/401|unauthorized/);
  });
});

function wsRpc(url, msg) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const to = setTimeout(() => { ws.close(); reject(new Error("timeout")); }, 1500);
    ws.on("open", () => ws.send(JSON.stringify(msg)));
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      if (!("id" in m)) return; // 接続時の event.ready 等の通知はスキップ
      clearTimeout(to); ws.close(); resolve(m);
    });
    ws.on("close", (code) => { if (code === 1008) { clearTimeout(to); reject(new Error("unauthorized")); } });
    ws.on("error", (e) => { clearTimeout(to); reject(e); });
  });
}
