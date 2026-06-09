// 新規配線した top-level RPC メソッドの結線テスト。
// (device.hideHistory / device.hideBattery / webapi.invoke が hub の対応メソッドへ
//  正しい params で委譲し、必須 param 欠落を弾くこと。subscribeIotResponse が非公開なこと。)
import { describe, it, expect } from "vitest";
import { buildRegistry } from "../../src/serve/registry.js";

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
});
