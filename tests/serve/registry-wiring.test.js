// 新規配線した top-level RPC メソッドの結線テスト。
// (device.hideHistory / device.hideBattery / webapi.invoke が hub の対応メソッドへ
//  正しい params で委譲し、必須 param 欠落を弾くこと。subscribeIotResponse が非公開なこと。)
import { afterEach, describe, it, expect, vi } from "vitest";
import { buildRegistry } from "../../src/serve/registry.js";
import { SesameBle } from "../../src/ble/index.js";
import { CONSUMER_CLIENT_ID } from "../../src/auth.js";

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

  it("必須 param 欠落は bad_params で弾く", () => {
    const hub = makeHub();
    expect(() => reg.get("device.hideHistory").handler({ hub, daemon, params: { deviceUUID: "U" } })).toThrow();
    expect(() => reg.get("device.hideBattery").handler({ hub, daemon, params: {} })).toThrow();
    expect(() => reg.get("webapi.invoke").handler({ hub, daemon, params: {} })).toThrow();
  });

  it("iot.removeSesameFromHub3 は公開され、iot.subscribeIotResponse は非公開", () => {
    expect(reg.has("iot.removeSesameFromHub3")).toBe(true);
    expect(reg.has("iot.subscribeIotResponse")).toBe(false);
  });

  it("ble.register は hub.tokenStore + config.registerBaseUrl から registerTransport を渡す", async () => {
    const regSpy = vi.spyOn(SesameBle, "registerOnce").mockResolvedValue({ ok: true });
    const fetchSpy = vi.fn(async () => ({ status: 200, text: async () => "{}" }));
    vi.stubGlobal("fetch", fetchSpy);

    const e = reg.get("ble.register");
    await e.handler({ hub: makeAuthHub(), daemon, params: { deviceUUID: "U", model: "sesame_5" } });

    const opts = regSpy.mock.calls[0][0];
    expect(typeof opts.registerTransport).toBe("function");
    await opts.registerTransport({ method: "POST", path: "/device/v1/sesame5/U", body: { t: "1", pk: "s" } });
    expect(fetchSpy.mock.calls[0][0]).toBe("https://register.example.invalid/root/device/v1/sesame5/U");
    expect(fetchSpy.mock.calls[0][1].headers.authorization).toMatch(/^Bearer /);
  });

  it("ble.invoke の needAuthFromServer は hub.tokenStore 由来の registerTransport を SesameBle.use に渡す", async () => {
    const useSpy = vi.spyOn(SesameBle, "use").mockResolvedValue({ ok: true });
    const fetchSpy = vi.fn(async () => ({ status: 200, text: async () => "{}" }));
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
    expect(fetchSpy.mock.calls[0][0]).toBe("https://register.example.invalid/root/device/v1/sesame2/sign");
    expect(fetchSpy.mock.calls[0][1].headers.authorization).toMatch(/^Bearer /);
  });
});
