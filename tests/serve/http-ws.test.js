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

  it("token 無しは 401", async () => {
    const d = new Daemon({ hub: fakeHub() });
    handle = await startHttpFraming(d, { port: 0, token: TOKEN });
    const r = await fetch(`${handle.url}/rpc`, { method: "POST", body: "{}" });
    expect(r.status).toBe(401);
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
