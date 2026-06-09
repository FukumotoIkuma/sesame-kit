// gRPC フレーミングの統合テスト (型付きメソッド + JSON-field + Subscribe + Invoke)。
import { describe, it, expect, afterEach, vi } from "vitest";
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Daemon } from "../../src/serve/daemon.js";
import { startGrpcFraming } from "../../src/serve/framing/grpc.js";

const TOKEN = "grpc-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PROTO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "serve", "sesame.proto");

function fakeHub() {
  let duFn = null;
  const hub = {
    connected: true, subUUID: "s", config: { devices: {} },
    connect: vi.fn(async () => {}), close: vi.fn(async () => {}),
    onDeviceUpdate: (_i, fn) => { duFn = fn; return () => { duFn = null; }; },
    _emit: (m) => duFn && duFn(m),
    unlock: vi.fn(async (n) => ({ ok: true, name: n })),
    getDeviceStatus: vi.fn(async (u) => ({ deviceUUID: u, locked: true })),
    getDeviceHistory: vi.fn(async (uuids, pageSize) => ({ uuids, pageSize })),
    send: vi.fn(async (remote, key) => ({ remote, key })),
    org: { addEmployees: vi.fn(async (p) => ({ received: p })) },
  };
  return hub;
}

function makeClient(port) {
  const pkgDef = protoLoader.loadSync(PROTO, { keepCase: true, longs: String, defaults: true });
  const proto = grpc.loadPackageDefinition(pkgDef).sesame;
  return new proto.Sesame(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
}
function bearer(token) {
  const md = new grpc.Metadata();
  if (token) md.set("authorization", `Bearer ${token}`);
  return md;
}
function unary(client, method, req, md) {
  return new Promise((res, rej) => client[method](req, md, (e, r) => e ? rej(e) : res(r)));
}

let handle, client, hub;
afterEach(async () => { if (client) client.close(); if (handle) await handle.stop(); handle = client = hub = null; });

describe("gRPC 型付きメソッド", () => {
  it("型付き Status(無引数) → JsonRpc(json) で結果", async () => {
    hub = fakeHub();
    const d = new Daemon({ hub }); d.authState = "ok";
    handle = await startGrpcFraming(d, { port: 0, token: TOKEN });
    client = makeClient(handle.port);
    const r = await unary(client, "Status", {}, bearer(TOKEN));
    expect(JSON.parse(r.json)).toMatchObject({ connected: true, subUUID: "s" });
  });

  it("型付き LockUnlock({name}) → hub.unlock に型付きで届く", async () => {
    hub = fakeHub();
    const d = new Daemon({ hub }); d.authState = "ok";
    handle = await startGrpcFraming(d, { port: 0, token: TOKEN });
    client = makeClient(handle.port);
    const r = await unary(client, "LockUnlock", { name: "front" }, bearer(TOKEN));
    expect(hub.unlock).toHaveBeenCalledWith("front");
    expect(JSON.parse(r.json)).toMatchObject({ ok: true, name: "front" });
  });

  it("型付き LockStatus({deviceUUID}) がプレーン引数で通る (JSON二重エンコード不要)", async () => {
    hub = fakeHub();
    const d = new Daemon({ hub }); d.authState = "ok";
    handle = await startGrpcFraming(d, { port: 0, token: TOKEN });
    client = makeClient(handle.port);
    const r = await unary(client, "LockStatus", { deviceUUID: "u1" }, bearer(TOKEN));
    expect(hub.getDeviceStatus).toHaveBeenCalledWith("u1");
    expect(JSON.parse(r.json)).toMatchObject({ deviceUUID: "u1", locked: true });
  });

  it("型付き DeviceHistory({deviceUUID, pageSize:数値}) が通り pageSize が number で届く", async () => {
    hub = fakeHub();
    const d = new Daemon({ hub }); d.authState = "ok";
    handle = await startGrpcFraming(d, { port: 0, token: TOKEN });
    client = makeClient(handle.port);
    const r = await unary(client, "DeviceHistory", { deviceUUID: "u1", pageSize: 5 }, bearer(TOKEN));
    expect(hub.getDeviceHistory).toHaveBeenCalledWith(["u1"], 5);
    expect(JSON.parse(r.json)).toMatchObject({ uuids: ["u1"], pageSize: 5 });
  });

  it("型付き IrSend({remote, key}) がプレーン引数で通る", async () => {
    hub = fakeHub();
    const d = new Daemon({ hub }); d.authState = "ok";
    handle = await startGrpcFraming(d, { port: 0, token: TOKEN });
    client = makeClient(handle.port);
    await unary(client, "IrSend", { remote: "ac", key: "on" }, bearer(TOKEN));
    expect(hub.send).toHaveBeenCalledWith("ac", "on");
  });

  it("Subscribe は不正 topic を黙殺せず INVALID_ARGUMENT で閉じる", async () => {
    hub = fakeHub();
    const d = new Daemon({ hub }); d.authState = "ok";
    handle = await startGrpcFraming(d, { port: 0, token: TOKEN });
    client = makeClient(handle.port);
    const stream = client.Subscribe({ token: TOKEN, topics: ["bogus"] });
    await expect(new Promise((res, rej) => {
      stream.on("data", () => res("got-data")); // 来てはいけない
      stream.on("error", rej);
      setTimeout(() => res("hung"), 1500); // 黙ってハングしたら fail
    })).rejects.toMatchObject({ code: grpc.status.INVALID_ARGUMENT });
  });

  it("object param は JSON 文字列 field で渡し、glue が parse して届ける", async () => {
    hub = fakeHub();
    const d = new Daemon({ hub }); d.authState = "ok";
    handle = await startGrpcFraming(d, { port: 0, token: TOKEN });
    client = makeClient(handle.port);
    await unary(client, "OrgAddEmployees", { items: JSON.stringify([{ email: "a@b.c" }]) }, bearer(TOKEN));
    // glue が items を配列に parse して namespace op へ渡す
    const arg = hub.org.addEmployees.mock.calls[0][0];
    expect(arg.items).toEqual([{ email: "a@b.c" }]);
  });

  it("token 無しは UNAUTHENTICATED (gRPC status)", async () => {
    hub = fakeHub();
    const d = new Daemon({ hub }); d.authState = "ok";
    handle = await startGrpcFraming(d, { port: 0, token: TOKEN });
    client = makeClient(handle.port);
    await expect(unary(client, "Status", {}, bearer(null))).rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED });
  });

  it("後方互換 Invoke で rpc.discover", async () => {
    hub = fakeHub();
    const d = new Daemon({ hub }); d.authState = "ok";
    handle = await startGrpcFraming(d, { port: 0, token: TOKEN });
    client = makeClient(handle.port);
    const r = await unary(client, "Invoke", { json: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "rpc.discover" }) }, bearer(TOKEN));
    expect(JSON.parse(r.json).result.openrpc).toBe("1.2.6");
  });

  it("ドメイン拒否 (SesameError) は FAILED_PRECONDITION + kind/retryable metadata", async () => {
    const { SesameError, ERR } = await import("../../src/errors.js");
    hub = fakeHub();
    hub.unlock = vi.fn(async () => {
      throw new SesameError("nope", { code: ERR.REJECTED, retryable: false, data: { upstreamCode: 403 } });
    });
    const d = new Daemon({ hub }); d.authState = "ok";
    handle = await startGrpcFraming(d, { port: 0, token: TOKEN });
    client = makeClient(handle.port);
    const err = await unary(client, "LockUnlock", { name: "front" }, bearer(TOKEN)).catch((e) => e);
    expect(err.code).toBe(grpc.status.FAILED_PRECONDITION); // internal ではない
    expect(err.metadata.get("kind")[0]).toBe("rejected");
    expect(err.metadata.get("retryable")[0]).toBe("false");
  });

  it("Subscribe でイベントストリーム", async () => {
    hub = fakeHub();
    const d = new Daemon({ hub }); d.authState = "ok";
    handle = await startGrpcFraming(d, { port: 0, token: TOKEN });
    client = makeClient(handle.port);
    const stream = client.Subscribe({ token: TOKEN, topics: ["lockState"] });
    const got = new Promise((res, rej) => { stream.on("data", res); stream.on("error", rej); setTimeout(() => rej(new Error("timeout")), 1500); });
    await new Promise((r) => setTimeout(r, 50));
    hub._emit({ data: { deviceUUID: "u1" } });
    const ev = await got;
    expect(ev.topic).toBe("lockState");
    expect(JSON.parse(ev.json)).toMatchObject({ data: { deviceUUID: "u1" } });
    stream.cancel();
  });
});
