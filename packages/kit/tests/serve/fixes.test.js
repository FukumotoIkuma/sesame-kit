// レビュー指摘の修正に対する回帰テスト (C1 再購読 / H2 行上限 / H3 413+landing /
// M6 events over POST 拒否 / fanout dedupe / param ガード)。
import { describe, it, expect, afterEach, vi } from "vitest";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../../src/serve/daemon.js";
import { startSocketFraming } from "../../src/serve/framing/socket.js";
import { startHttpFraming } from "../../src/serve/framing/http.js";
import { KIND } from "@sesame-kit/core/jsonrpc";
import { TRANSPORT_ERR } from "@sesame-kit/core/transport";

function fakeHub(over = {}) {
  let duFn = null, duCount = 0;
  const reconnectCbs = [];
  return {
    connected: true, subUUID: "s", config: { devices: { front: { deviceUUID: "u1", deviceModel: "sesame_5" } } },
    tokenStore: { load: () => ({ refreshToken: "x" }) },
    connect: vi.fn(async () => {}), close: vi.fn(async () => {}),
    onReconnect: (cb) => { reconnectCbs.push(cb); return () => {}; },
    _fireReconnect: () => reconnectCbs.forEach((c) => c()),
    onDeviceUpdate: vi.fn((_i, fn) => { duCount++; duFn = fn; return () => { duFn = null; }; }),
    _emit: (m) => duFn && duFn(m),
    get duCount() { return duCount; },
    ...over,
  };
}

let handle;
afterEach(async () => { if (handle) await handle.stop?.(); handle = null; });

describe("C1: 再接続で購読を張り直す", () => {
  it("start() が onReconnect を登録し、発火で旧 unsub→再 subscribe する", () => {
    const hub = fakeHub();
    const d = new Daemon({ hub });
    d.start();
    const conn = { id: "x", send() {}, close() {} };
    d.addConnection(conn);
    d.subscribe(conn, ["lockState"]);    // ここで onDeviceUpdate 1 回目
    expect(hub.duCount).toBe(1);
    hub._fireReconnect();                 // 再接続 → 旧 unsub 後に 2 回目
    expect(hub.duCount).toBe(2);
  });
});

describe("fanout dedupe & param ガード", () => {
  it("両 topic 購読の接続にはイベントが 1 回だけ届く", () => {
    const hub = fakeHub();
    const d = new Daemon({ hub });
    const sent = [];
    const conn = { id: "x", send: (o) => sent.push(o), close() {} };
    d.addConnection(conn);
    d.subscribe(conn, ["lockState", "deviceUpdate"]);
    hub._emit({ data: { deviceUUID: "u1" } });
    // 接続時の event.ready を除いた購読イベントが二重配信されないことを見る。
    expect(sent.filter((m) => m.method !== "event.ready")).toHaveLength(1);
  });

  it("params が配列だと INVALID_PARAMS", async () => {
    const d = new Daemon({ hub: fakeHub() });
    await expect(d.invoke("status", [1, 2], null)).rejects.toMatchObject({ kind: KIND.BAD_PARAMS });
  });
});

describe("classifyError: transport の構造化コードで kind 決定 (文字列regex非依存)", () => {
  it("TRANSPORT_ERR.TIMEOUT → kind timeout", async () => {
    const hub = fakeHub({ org: { getEmployees: () => { const e = new Error("request timeout: x"); e.code = TRANSPORT_ERR.TIMEOUT; throw e; } } });
    const d = new Daemon({ hub }); d.authState = "ok";
    await expect(d.invoke("org.getEmployees", {}, null)).rejects.toMatchObject({ kind: KIND.TIMEOUT });
  });
  it("TRANSPORT_ERR.CLOSED → kind connection_lost", async () => {
    const hub = fakeHub({ org: { getEmployees: () => { const e = new Error("websocket closed"); e.code = TRANSPORT_ERR.CLOSED; throw e; } } });
    const d = new Daemon({ hub }); d.authState = "ok";
    await expect(d.invoke("org.getEmployees", {}, null)).rejects.toMatchObject({ kind: KIND.CONNECTION_LOST });
  });
  it("コード無しの素のエラーは internal (整形応答で確認)", async () => {
    const hub = fakeHub({ org: { getEmployees: () => { throw new Error("boom"); } } });
    const d = new Daemon({ hub }); d.authState = "ok";
    const res = await d.dispatchMessage(null, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "org.getEmployees", params: {} }));
    expect(res.error.data.kind).toBe(KIND.INTERNAL);
  });
});

describe("M4: SSE は全 topic 不正なら 400", () => {
  const TOKEN = "tok-dddddddddddddddddddddddddddddddd";
  it("?topics=bogus → 400 (黙ってストリームを返さない)", async () => {
    const d = new Daemon({ hub: fakeHub() }); d.authState = "ok";
    handle = await startHttpFraming(d, { port: 0, token: TOKEN });
    const r = await fetch(`${handle.url}/events?topics=bogus&token=${TOKEN}`);
    expect(r.status).toBe(400);
    await r.text();
  });
});

describe("H2: NDJSON 行サイズ上限", () => {
  it("改行なしの巨大入力で接続が切られる", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "sesame-fix-"));
    const socketPath = join(workDir, "s.sock");
    const d = new Daemon({ hub: fakeHub() });
    handle = await startSocketFraming(d, { socketPath });
    await new Promise((resolve, reject) => {
      const c = net.connect(socketPath);
      c.on("connect", () => c.write("x".repeat(1_100_000))); // 改行なし >1MB
      c.on("close", () => { resolve(); });
      c.on("error", () => resolve()); // 切断は close か error
      setTimeout(() => reject(new Error("not closed")), 2000);
    });
    rmSync(workDir, { recursive: true, force: true });
  });
});

describe("H3 + DX: HTTP 堅牢化 & 案内", () => {
  const TOKEN = "tok-cccccccccccccccccccccccccccccccc";
  it("GET / は token 不要で使い方を返す", async () => {
    const d = new Daemon({ hub: fakeHub() });
    handle = await startHttpFraming(d, { port: 0, token: TOKEN });
    const r = await fetch(`${handle.url}/`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("rpc.discover");
  });
  it("401 に WWW-Authenticate ヘッダとヒント", async () => {
    const d = new Daemon({ hub: fakeHub() });
    handle = await startHttpFraming(d, { port: 0, token: TOKEN });
    const r = await fetch(`${handle.url}/rpc`, { method: "POST", body: "{}" });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/Bearer/);
  });
  it("過大 body は 413", async () => {
    const d = new Daemon({ hub: fakeHub() });
    handle = await startHttpFraming(d, { port: 0, token: TOKEN });
    const big = "a".repeat(1_100_000);
    const r = await fetch(`${handle.url}/rpc`, {
      method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: { big } }),
    });
    expect(r.status).toBe(413);
  });
  it("M6: events.subscribe を POST でやると拒否される", async () => {
    const d = new Daemon({ hub: fakeHub() }); d.authState = "ok";
    handle = await startHttpFraming(d, { port: 0, token: TOKEN });
    const r = await fetch(`${handle.url}/rpc`, {
      method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "events.subscribe", params: { topics: ["lockState"] } }),
    });
    const j = await r.json();
    expect(j.error.data.kind).toBe(KIND.BAD_PARAMS);
  });
});
