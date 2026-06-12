// 新規配線した top-level RPC メソッドの結線テスト。
// (device.hideHistory / device.hideBattery / webapi.invoke が hub の対応メソッドへ
//  正しい params で委譲し、必須 param 欠落を弾くこと。subscribeIotResponse が非公開なこと。)
import { afterEach, describe, it, expect, vi } from "vitest";
import { buildRegistry } from "../../src/serve/registry.js";
import { SesameBle } from "@sesame-kit/core/ble";
import { CONSUMER_CLIENT_ID } from "@sesame-kit/core/auth";

const CONFIRMED_DEVICE = {
  deviceKey: "dev-key-abc",
  deviceGroupKey: "dev-group-abc",
  devicePassword: "dev-password-abc",
};

// requireAuth を通すための最小 daemon。
const daemon = { authState: "active", hub: { connected: true } };

/** 呼び出しを記録する fake hub を作る。各メソッドは呼ばれた引数を calls に積む。 */
function makeHub() {
  const calls = [];
  const rec = (name) => (arg) => { calls.push([name, arg]); return { ok: true, name }; };
  return {
    calls,
    hideDeviceHistory: rec("hideDeviceHistory"),
    hideBatteryRecord: rec("hideBatteryRecord"),
    invokeWebAPI: rec("invokeWebAPI"),
  };
}

function fakeJwt(expSec) {
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64u({ alg: "none" })}.${b64u({ aud: CONSUMER_CLIENT_ID, exp: expSec, sub: "u" })}.`;
}

function makeAuthHub() {
  const far = Math.floor(Date.now() / 1000) + 3600;
  return {
    config: { registerBaseUrl: "https://register.example.invalid/root/" },
    tokenStore: {
      load: () => ({ idToken: fakeJwt(far), refreshToken: "refresh", clientId: CONSUMER_CLIENT_ID, ...CONFIRMED_DEVICE }),
      save: vi.fn(),
    },
  };
}

/**
 * registerTransport 用 fetch スタブ。SigV4 化 (P2-1) に伴い、API 本体の前に
 * Cognito Identity Pool (GetId / GetCredentialsForIdentity) への 2 リクエストが入るため、
 * cognito-identity 向けは固定 credentials 応答を返し、それ以外 (API 本体) のみ記録する。
 */
function makeRegisterFetchStub() {
  const apiCalls = [];
  const fn = vi.fn(async (url, init) => {
    if (String(url).startsWith("https://cognito-identity.ap-northeast-1.amazonaws.com/")) {
      const target = init?.headers?.["x-amz-target"];
      if (target === "AWSCognitoIdentityService.GetId") {
        return { status: 200, text: async () => JSON.stringify({ IdentityId: "ap-northeast-1:id-1" }) };
      }
      return {
        status: 200,
        text: async () => JSON.stringify({
          IdentityId: "ap-northeast-1:id-1",
          Credentials: {
            AccessKeyId: "AKFROMPOOL", SecretKey: "SK", SessionToken: "ST",
            Expiration: Date.now() / 1000 + 3600,
          },
        }),
      };
    }
    apiCalls.push([url, init]);
    return { status: 200, text: async () => "{}" };
  });
  fn.apiCalls = apiCalls;
  return fn;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("registry: 新規 top-level メソッドの結線", () => {
  const reg = buildRegistry();

  it("device.hideHistory → hub.hideDeviceHistory({deviceUUID,timestamp})", async () => {
    const hub = makeHub();
    const e = reg.get("device.hideHistory");
    expect(e).toBeTruthy();
    expect(e.params.map((p) => p.name)).toEqual(["deviceUUID", "timestamp"]);
    await e.handler({ hub, daemon, params: { deviceUUID: "U", timestamp: 123 } });
    expect(hub.calls).toEqual([["hideDeviceHistory", { deviceUUID: "U", timestamp: 123 }]]);
  });

  it("device.hideBattery → hub.hideBatteryRecord({deviceUUID,timestampSecond})", async () => {
    const hub = makeHub();
    const e = reg.get("device.hideBattery");
    expect(e.params.map((p) => p.name)).toEqual(["deviceUUID", "timestampSecond"]);
    await e.handler({ hub, daemon, params: { deviceUUID: "U", timestampSecond: 99 } });
    expect(hub.calls).toEqual([["hideBatteryRecord", { deviceUUID: "U", timestampSecond: 99 }]]);
  });

  it("webapi.invoke → hub.invokeWebAPI({func,query,body,apiKeyId})", async () => {
    const hub = makeHub();
    const e = reg.get("webapi.invoke");
    expect(e.params.map((p) => p.name)).toEqual(["func", "query", "body", "apiKeyId"]);
    await e.handler({ hub, daemon, params: { func: "f", query: { a: 1 }, body: { b: 2 }, apiKeyId: "k" } });
    expect(hub.calls).toEqual([["invokeWebAPI", { func: "f", query: { a: 1 }, body: { b: 2 }, apiKeyId: "k" }]]);
  });

  // P1-11 回帰ガード: device.history が lib 層へ渡す list は **オブジェクト配列** [{deviceUUID}]。
  // vendor (references_web/src/components/DeviceHistory.js:37) は常に
  // getDeviceHistory([{deviceUUID, lastKey}], ...) を送る。裸文字列配列 ["U"] だとサーバが
  // list[i].deviceUUID を読めず RPC/SDK/gRPC 経由の履歴取得が壊れる。
  it("device.history → hub.getDeviceHistory([{deviceUUID, lastKey}], pageSize) (list 要素はオブジェクト)", async () => {
    const calls = [];
    const hub = { getDeviceHistory: async (list, pageSize) => { calls.push([list, pageSize]); return []; } };
    const e = reg.get("device.history");
    expect(e).toBeTruthy();
    await e.handler({ hub, daemon, params: { deviceUUID: "U", pageSize: 7 } });
    expect(calls).toHaveLength(1);
    const [list, pageSize] = calls[0];
    expect(pageSize).toBe(7);
    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(1);
    expect(typeof list[0]).toBe("object"); // 裸文字列 "U" ではない
    // vendor (DeviceHistory.js:37) は常に {deviceUUID, lastKey} を送る (初回 lastKey=null)
    expect(list[0]).toEqual({ deviceUUID: "U", lastKey: null });
  });

  // P3-7: 履歴/電池のページングカーソルを RPC から渡せる (lastKey / lastEvaluatedKey)。
  it("device.history は lastKey param を list 要素へ透過する (DeviceHistory.js:37-44)", async () => {
    const calls = [];
    const hub = { getDeviceHistory: async (list, pageSize) => { calls.push([list, pageSize]); return []; } };
    const e = reg.get("device.history");
    expect(e.params.map((p) => p.name)).toEqual(["deviceUUID", "pageSize", "lastKey"]);
    await e.handler({ hub, daemon, params: { deviceUUID: "U", pageSize: 7, lastKey: 1700000000 } });
    expect(calls[0][0]).toEqual([{ deviceUUID: "U", lastKey: 1700000000 }]);
  });

  it("device.battery は lastEvaluatedKey param を透過する (MobileBatteryChart.js:40-50 の片道契約を解消)", async () => {
    const calls = [];
    const hub = { getDeviceBattery: async (uuid, opts) => { calls.push([uuid, opts]); return { records: [] }; } };
    const e = reg.get("device.battery");
    expect(e.params.map((p) => p.name)).toEqual(["deviceUUID", "pageSize", "lastEvaluatedKey"]);
    const cursor = { ts: { N: "1" } };
    await e.handler({ hub, daemon, params: { deviceUUID: "U", pageSize: 5, lastEvaluatedKey: cursor } });
    expect(calls[0]).toEqual(["U", { pageSize: 5, lastEvaluatedKey: cursor }]);
    await e.handler({ hub, daemon, params: { deviceUUID: "U" } });
    expect(calls[1][1].lastEvaluatedKey).toBeNull(); // 未指定なら null (初回ページ)
  });

  // P3-1: biz3ManageDevice 残り 5 op の RPC 配線 (useManageDevice.js:256-372)。
  it("devices.add → hub.addDevices(items)", async () => {
    const calls = [];
    const hub = { addDevices: async (items) => { calls.push(items); return { ok: true }; } };
    const e = reg.get("devices.add");
    expect(e).toBeTruthy();
    const items = [{ deviceUUID: "U", secretKey: "s" }];
    await e.handler({ hub, daemon, params: { items } });
    expect(calls).toEqual([items]);
  });

  it("devices.reorder → hub.reorderDevices(items)", async () => {
    const calls = [];
    const hub = { reorderDevices: async (items) => { calls.push(items); return []; } };
    const e = reg.get("devices.reorder");
    const items = [{ deviceUUID: "a" }, { deviceUUID: "b" }];
    await e.handler({ hub, daemon, params: { items } });
    expect(calls).toEqual([items]);
  });

  it("devices.notifyStatus / devices.notifyManage / devices.switchRecharge の結線", async () => {
    const calls = [];
    const hub = {
      getDevicesNotifyStatus: async (p) => { calls.push(["notifyStatus", p]); return []; },
      switchDeviceNotify: async (p) => { calls.push(["notifyManage", p]); return { ok: true }; },
      switchRechargeableBattery: async (p) => { calls.push(["switchRecharge", p]); return { ok: true }; },
    };
    await reg.get("devices.notifyStatus").handler({ hub, daemon, params: { pushToken: "tok", items: [{ deviceUUID: "U" }] } });
    await reg.get("devices.notifyManage").handler({ hub, daemon, params: { pushToken: "tok", deviceUUID: "U", enablePush: false } });
    await reg.get("devices.switchRecharge").handler({ hub, daemon, params: { deviceUUID: "U", isRechargeBattery: false } });
    expect(calls).toEqual([
      ["notifyStatus", { pushToken: "tok", items: [{ deviceUUID: "U" }] }],
      // boolean false が「欠落」と誤判定されない (need() を使わない明示チェック)
      ["notifyManage", { pushToken: "tok", deviceUUID: "U", enablePush: false }],
      ["switchRecharge", { deviceUUID: "U", isRechargeBattery: false }],
    ]);
  });

  // P3-3: addRemoteToMatter (useRemoteCtrl.js:933-955 フィールド 1:1) の RPC 配線。
  it("ir.addRemoteToMatter → hub.addRemoteToMatter (vendor フィールド名のまま透過)", async () => {
    const calls = [];
    const hub = { addRemoteToMatter: async (p) => { calls.push(p); return { ok: true }; } };
    const e = reg.get("ir.addRemoteToMatter");
    expect(e).toBeTruthy();
    expect(e.params.map((p) => p.name)).toEqual([
      "hub3DeviceId", "irDeviceType", "cmdOn", "cmdOff", "irDeviceUUID", "irDeviceName",
    ]);
    await e.handler({
      hub, daemon,
      params: { hub3DeviceId: "H", irDeviceType: 0xc000, cmdOn: "ON", cmdOff: "OFF", irDeviceUUID: "R", irDeviceName: "AC" },
    });
    expect(calls).toEqual([{ hub3DeviceId: "H", irDeviceType: 0xc000, cmdOn: "ON", cmdOff: "OFF", irDeviceUUID: "R", irDeviceName: "AC" }]);
  });

  it("P3-1/P3-3 の新メソッドは experimental (stable 契約に未昇格)", async () => {
    const { stabilityOf } = await import("../../src/serve/stability.js");
    for (const m of ["devices.add", "devices.reorder", "devices.notifyStatus", "devices.notifyManage", "devices.switchRecharge", "ir.addRemoteToMatter"]) {
      expect(reg.has(m), `${m} が registry に無い`).toBe(true);
      expect(stabilityOf(m), `${m} は experimental であるべき`).toBe("experimental");
    }
  });

  // P3-5: deviceListChanged topic (pubUserDeviceChange の fan-out) が購読可能集合に載る。
  it("SUBSCRIBABLE_TOPICS に deviceListChanged が含まれ、x-event-topics と一致する", async () => {
    const { SUBSCRIBABLE_TOPICS, buildOpenRpcDoc } = await import("../../src/serve/registry.js");
    expect(SUBSCRIBABLE_TOPICS).toContain("deviceListChanged");
    const doc = buildOpenRpcDoc(reg, "0.0.0-test");
    expect(doc["x-event-topics"]).toEqual([...SUBSCRIBABLE_TOPICS]);
    const eventNames = doc["x-events"].map((e) => e.name);
    expect(eventNames).toContain("event.deviceListChanged");
  });

  it("必須 param 欠落は bad_params で弾く", () => {
    const hub = makeHub();
    expect(() => reg.get("device.hideHistory").handler({ hub, daemon, params: { deviceUUID: "U" } })).toThrow();
    expect(() => reg.get("device.hideBattery").handler({ hub, daemon, params: {} })).toThrow();
    expect(() => reg.get("webapi.invoke").handler({ hub, daemon, params: {} })).toThrow();
    expect(() => reg.get("devices.add").handler({ hub, daemon, params: {} })).toThrow();
    expect(() => reg.get("devices.notifyManage").handler({ hub, daemon, params: { pushToken: "t", deviceUUID: "U" } })).toThrow(); // enablePush 欠落
    expect(() => reg.get("devices.switchRecharge").handler({ hub, daemon, params: { deviceUUID: "U" } })).toThrow(); // isRechargeBattery 欠落
    expect(() => reg.get("ir.addRemoteToMatter").handler({ hub, daemon, params: { hub3DeviceId: "H" } })).toThrow();
  });

  it("iot.removeSesameFromHub3 は公開され、iot.subscribeIotResponse は非公開", () => {
    expect(reg.has("iot.removeSesameFromHub3")).toBe(true);
    expect(reg.has("iot.subscribeIotResponse")).toBe(false);
  });

  it("ble.register は hub.tokenStore + config.registerBaseUrl から registerTransport を渡す", async () => {
    const regSpy = vi.spyOn(SesameBle, "registerOnce").mockResolvedValue({ ok: true });
    const fetchSpy = makeRegisterFetchStub();
    vi.stubGlobal("fetch", fetchSpy);

    const e = reg.get("ble.register");
    await e.handler({ hub: makeAuthHub(), daemon, params: { deviceUUID: "U", model: "sesame_5" } });

    const opts = regSpy.mock.calls[0][0];
    expect(typeof opts.registerTransport).toBe("function");
    await opts.registerTransport({ method: "POST", path: "/device/v1/sesame5/U", body: { t: "1", pk: "s" } });
    expect(fetchSpy.apiCalls[0][0]).toBe("https://register.example.invalid/root/device/v1/sesame5/U");
    // P2-1: idToken Bearer は撤去。Identity Pool credentials による SigV4 + x-api-key で署名される。
    expect(fetchSpy.apiCalls[0][1].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKFROMPOOL\//);
    expect(fetchSpy.apiCalls[0][1].headers["x-api-key"]).toBeTruthy();
  });

  it("ble.invoke の needAuthFromServer は hub.tokenStore 由来の registerTransport を SesameBle.use に渡す", async () => {
    const useSpy = vi.spyOn(SesameBle, "use").mockResolvedValue({ ok: true });
    const fetchSpy = makeRegisterFetchStub();
    vi.stubGlobal("fetch", fetchSpy);

    const e = reg.get("ble.invoke");
    await e.handler({
      hub: makeAuthHub(),
      daemon,
      params: { op: "status", secretKey: "00".repeat(16), deviceUUID: "U", needAuthFromServer: true },
    });

    const opts = useSpy.mock.calls[0][0];
    expect(opts.needAuthFromServer).toBe(true);
    expect(typeof opts.registerTransport).toBe("function");
    await opts.registerTransport({ method: "POST", path: "/device/v1/sesame2/sign", body: { token: "t" } });
    expect(fetchSpy.apiCalls[0][0]).toBe("https://register.example.invalid/root/device/v1/sesame2/sign");
    // P2-1: idToken Bearer は撤去。Identity Pool credentials による SigV4 + x-api-key で署名される。
    expect(fetchSpy.apiCalls[0][1].headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKFROMPOOL\//);
    expect(fetchSpy.apiCalls[0][1].headers["x-api-key"]).toBeTruthy();
  });
});
