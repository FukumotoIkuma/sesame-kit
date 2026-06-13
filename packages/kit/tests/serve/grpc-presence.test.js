// P1-3 (R3:SURF-01): proto3 field presence テスト。
// 問題: presence 無しの scalar は省略時に 0/false/"" に化け、ハンドラが「未指定」と区別できない。
// 修正: gen-grpc-proto.mjs で required でない scalar に proto3 `optional` を付与。
//        grpc.js glue で synthetic oneof sentinel (_fieldName) の有無で省略/明示を判定。
//        `@grpc/proto-loader` で `oneofs:true` を追加(synthetic oneof の展開に必要)。
// テスト方針(規範 12): 省略/明示既定値の対を全テストで網羅し、0 を一律 delete する安直修正を封じる。
import { describe, it, expect, afterEach, vi } from "vitest";
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Daemon } from "../../src/serve/daemon.js";
import { startGrpcFraming } from "../../src/serve/framing/grpc.js";

const TOKEN = "presence-test-token-bbbbbbbbbbbbbbb";
const PROTO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "serve", "sesame.proto");

function makeClient(port) {
  // oneofs:true は必須(proto3 optional = synthetic oneof を正しく扱うため)。
  const pkgDef = protoLoader.loadSync(PROTO, { keepCase: true, longs: String, defaults: true, oneofs: true });
  const proto = grpc.loadPackageDefinition(pkgDef).sesame;
  return new proto.Sesame(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
}
function bearer(t) {
  const md = new grpc.Metadata();
  if (t) md.set("authorization", `Bearer ${t}`);
  return md;
}
function unary(client, method, req, md) {
  return new Promise((res, rej) => client[method](req, md, (e, r) => (e ? rej(e) : res(r))));
}

function fakeHub() {
  return {
    connected: true,
    subUUID: "s",
    config: { devices: {} },
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    onDeviceUpdate: (_i, _fn) => () => {},
    botClick: vi.fn(async (name) => ({ clicked: name })),
    botClickScript: vi.fn(async (name, idx) => ({ clicked: name, scriptIndex: idx })),
    setAutolock: vi.fn(async (name, seconds) => ({ ack: true, seconds })),
    getDeviceHistory: vi.fn(async (list, pageSize) => ({ list, pageSize })),
    listNearby: vi.fn(async ({ timeoutMs }) => ({ timeoutMs, devices: [] })),
  };
}

let handle, client, hub;
afterEach(async () => {
  if (client) client.close();
  if (handle) await handle.stop();
  handle = client = hub = null;
});

describe("P1-3 gRPC proto3 field presence — LockClick", () => {
  it("LockClick({name}) — scriptIndex 省略時は botClick が呼ばれ botClickScript は呼ばれない", async () => {
    // 修正前: proto3 既定値注入により scriptIndex=0 が届き botClickScript(name,0) が呼ばれた。
    // 修正後: optional によりフィールドは undefined → hasScript=false → botClick のみ実行。
    hub = fakeHub();
    const d = new Daemon({ hub });
    d.authState = "ok";
    handle = await startGrpcFraming(d, { port: 0, token: TOKEN });
    client = makeClient(handle.port);
    const r = await unary(client, "LockClick", { name: "front" }, bearer(TOKEN));
    expect(hub.botClick).toHaveBeenCalledWith("front");
    expect(hub.botClickScript).not.toHaveBeenCalled();
    expect(JSON.parse(r.json)).toMatchObject({ clicked: "front" });
  });

  it("LockClick({name, scriptIndex: 0}) — 明示 0 は botClickScript(name,0) を呼ぶ (0を一律delete禁止の保証)", async () => {
    // 修正の核心: scriptIndex:0 を明示的に送った場合は「台本0」として届くことを保証する。
    // 安直修正「0 を delete」は台本0実行を不能にするため禁止(REFACTORING_PLAN P1-3 §修正手順③)。
    hub = fakeHub();
    const d = new Daemon({ hub });
    d.authState = "ok";
    handle = await startGrpcFraming(d, { port: 0, token: TOKEN });
    client = makeClient(handle.port);
    const r = await unary(client, "LockClick", { name: "front", scriptIndex: 0 }, bearer(TOKEN));
    expect(hub.botClickScript).toHaveBeenCalledWith("front", 0);
    expect(hub.botClick).not.toHaveBeenCalled();
    expect(JSON.parse(r.json)).toMatchObject({ scriptIndex: 0 });
  });

  it("LockClick({name, scriptIndex: 3}) — 非 0 の明示値も正しく届く", async () => {
    hub = fakeHub();
    const d = new Daemon({ hub });
    d.authState = "ok";
    handle = await startGrpcFraming(d, { port: 0, token: TOKEN });
    client = makeClient(handle.port);
    const r = await unary(client, "LockClick", { name: "front", scriptIndex: 3 }, bearer(TOKEN));
    expect(hub.botClickScript).toHaveBeenCalledWith("front", 3);
    expect(JSON.parse(r.json)).toMatchObject({ scriptIndex: 3 });
  });
});

describe("P1-3 gRPC proto3 field presence — LockSetAutolock", () => {
  it("LockSetAutolock({name, seconds}) — transport 省略時は setAutolock が呼ばれる (bad_params にならない)", async () => {
    // 修正前: transport:"" (proto3 既定) が ?? "cloud" をすり抜け enum 検査で常に bad_params。
    // 修正後: transport が optional なので省略時は undefined → ?? "cloud" が効いて cloud 経路に進む。
    hub = fakeHub();
    const d = new Daemon({ hub });
    d.authState = "ok";
    handle = await startGrpcFraming(d, { port: 0, token: TOKEN });
    client = makeClient(handle.port);
    const r = await unary(client, "LockSetAutolock", { name: "front", seconds: 60 }, bearer(TOKEN));
    expect(hub.setAutolock).toHaveBeenCalledWith("front", 60, undefined);
    const result = JSON.parse(r.json);
    expect(result).toMatchObject({ ack: true, seconds: 60 });
  });

  it("LockSetAutolock({name, seconds}) を送った際 name が存在し seconds が required として届く", async () => {
    // seconds は required フィールドなので optional を付けない。0 も valid(0秒=オートロック無効)。
    hub = fakeHub();
    hub.setAutolock = vi.fn(async (name, seconds) => ({ ack: true, name, seconds }));
    const d = new Daemon({ hub });
    d.authState = "ok";
    handle = await startGrpcFraming(d, { port: 0, token: TOKEN });
    client = makeClient(handle.port);
    await unary(client, "LockSetAutolock", { name: "front", seconds: 0 }, bearer(TOKEN));
    // seconds=0 は required なので proto-loader が 0 として届け、ハンドラも 0 を受ける
    expect(hub.setAutolock).toHaveBeenCalledWith("front", 0, undefined);
  });
});

describe("P1-3 gRPC proto3 field presence — DeviceHistory", () => {
  it("DeviceHistory({deviceUUID}) — pageSize 省略時はハンドラに undefined で届く (0 ではない)", async () => {
    // 修正前: pageSize:0 がハンドラに届き上流に 0 を送出していた。
    // 修正後: optional により pageSize は undefined → getDeviceHistory の第2引数が undefined。
    hub = fakeHub();
    const d = new Daemon({ hub });
    d.authState = "ok";
    handle = await startGrpcFraming(d, { port: 0, token: TOKEN });
    client = makeClient(handle.port);
    await unary(client, "DeviceHistory", { deviceUUID: "u1" }, bearer(TOKEN));
    const [list, pageSize] = hub.getDeviceHistory.mock.calls[0];
    expect(pageSize).toBeUndefined();
    expect(list[0].deviceUUID).toBe("u1");
  });

  it("DeviceHistory({deviceUUID, pageSize: 10}) — 明示 pageSize は値として届く", async () => {
    hub = fakeHub();
    const d = new Daemon({ hub });
    d.authState = "ok";
    handle = await startGrpcFraming(d, { port: 0, token: TOKEN });
    client = makeClient(handle.port);
    await unary(client, "DeviceHistory", { deviceUUID: "u1", pageSize: 10 }, bearer(TOKEN));
    const [, pageSize] = hub.getDeviceHistory.mock.calls[0];
    expect(pageSize).toBe(10);
  });
});

describe("P1-3 gRPC proto3 field presence — BleScan (scanTimeoutMs)", () => {
  it("BleScan({}) — scanTimeoutMs 省略時は SesameBle.listNearby の timeoutMs が undefined (0 で即死しない)", async () => {
    // 修正前: scanTimeoutMs:0 が listNearby に渡り即時タイムアウト(deviceNotFound)になった。
    // 修正後: optional により scanTimeoutMs は undefined → listNearby は既定 15s を使う。
    // ここでは SesameBle.listNearby のモックを通じて undefined 到達を確認する。
    // SesameBle.listNearby は実 BLE スキャンを伴うため vi.mock でモジュール差し替える。
    const { SesameBle } = await import("@sesame-kit/core/ble");
    const spy = vi.spyOn(SesameBle, "listNearby").mockResolvedValue([]);
    try {
      hub = fakeHub();
      const d = new Daemon({ hub });
      d.authState = "ok";
      handle = await startGrpcFraming(d, { port: 0, token: TOKEN });
      client = makeClient(handle.port);
      await unary(client, "BleScan", {}, bearer(TOKEN));
      expect(spy).toHaveBeenCalled();
      const callArgs = spy.mock.calls[0][0];
      expect(callArgs.timeoutMs).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("BleScan({scanTimeoutMs: 0}) — 明示 0 は timeoutMs:0 として届く (0を一律deleteする安直修正を封じる)", async () => {
    // 0 を一律 delete すると、意図的に「タイムアウト無し」で呼ぶ用途が壊れる。
    const { SesameBle } = await import("@sesame-kit/core/ble");
    const spy = vi.spyOn(SesameBle, "listNearby").mockResolvedValue([]);
    try {
      hub = fakeHub();
      const d = new Daemon({ hub });
      d.authState = "ok";
      handle = await startGrpcFraming(d, { port: 0, token: TOKEN });
      client = makeClient(handle.port);
      await unary(client, "BleScan", { scanTimeoutMs: 0 }, bearer(TOKEN));
      const callArgs = spy.mock.calls[0][0];
      expect(callArgs.timeoutMs).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("P1-3 gRPC proto3 field presence — 生成 proto の optional 付与確認", () => {
  it("sesame.proto の LockClickRequest は scriptIndex が optional scalar として宣言されている", async () => {
    // gen-grpc-proto.mjs の修正確認: required でない scalar に optional が付与される。
    const { readFileSync } = await import("node:fs");
    const protoText = readFileSync(PROTO, "utf8");
    const section = protoText.match(/message LockClickRequest \{[^}]+\}/s)?.[0] ?? "";
    expect(section).toContain("optional double scriptIndex");
    // required フィールド(なし)に optional が付かないことも確認。
    // LockClickRequest は required param 無しなので全 scalar が optional になる。
  });

  it("sesame.proto の LockSetAutolockRequest は seconds が non-optional (required フィールド)", async () => {
    // required フィールドには optional を付与しない(修正手順の「required フィールドは対象外」確認)。
    const { readFileSync } = await import("node:fs");
    const protoText = readFileSync(PROTO, "utf8");
    const section = protoText.match(/message LockSetAutolockRequest \{[^}]+\}/s)?.[0] ?? "";
    expect(section).toMatch(/double seconds = \d+;/); // optional 無し
    expect(section).not.toMatch(/optional double seconds/);
    expect(section).toContain("optional string transport"); // non-required は optional
  });

  it("grpc-methods.generated.json の LockClick に optionalScalars が含まれる", async () => {
    const { readFileSync } = await import("node:fs");
    const MAP_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "serve", "grpc-methods.generated.json");
    const map = JSON.parse(readFileSync(MAP_PATH, "utf8"));
    expect(map.LockClick.optionalScalars).toContain("scriptIndex");
    expect(map.LockSetAutolock.optionalScalars).toContain("transport");
    expect(map.LockSetAutolock.optionalScalars).not.toContain("seconds"); // required は除外
    expect(map.DeviceHistory.optionalScalars).toContain("pageSize");
    expect(map.BleScan.optionalScalars).toContain("scanTimeoutMs");
  });
});
