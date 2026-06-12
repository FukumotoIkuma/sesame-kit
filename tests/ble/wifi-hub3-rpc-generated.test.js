// SURF-08 段階3: WM2_RPC_OPS / HUB3_RPC_OPS から自動生成した
// ble.wifi.<op> / ble.hub3.<op> RPC の結線テスト。
//
// 検証の要 (tests/serve/ble-rpc-generated.test.js と同方針):
//   (1) 生成された ble.wifi.* / ble.hub3.* が登録され experimental であること。
//   (2) named params → ファサードメソッドの **位置引数** への写像が宣言順どおりであること
//       (順序がずれるとワイヤのバイト列が壊れる)。
//   (3) invokePath が中間セグメント "wifi" / "hub3" を **引数なし** (value.call(target)) で解決し、
//       そのビュー上のメソッドが正しい位置引数で呼ばれること。
//   (4) 専用ハンドラと重複する WM2 op (scanWifiSSID 等) は生成版に **存在しない** こと。
//
// SesameBle.use をスタブし、fn に渡す擬似 facade (wifi()/hub3() メソッド付き) を差し込む。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildRegistry } from "../../src/serve/registry.js";
import { stabilityOf } from "../../src/serve/stability.js";
import * as bleIndex from "../../src/ble/index.js";

const daemon = { authState: "ok", hub: { connected: true } };

/** SesameBle.use をスタブし、fn に渡す擬似 facade を差し込む。 */
function stubBle(fakeFacade) {
  return vi.spyOn(bleIndex.SesameBle, "use").mockImplementation(async (_opts, fn) => fn(fakeFacade));
}

// WM2 用ターゲット (生成 handler は secretKey 必須。model は wifiProvisioning 機種を渡す想定だが
// SesameBle.use はスタブされるため値自体は invokePath の経路選択にしか効かない)。
const WM2_TARGET = { secretKey: "0123456789abcdef0123456789abcdef", deviceUUID: "d-wm2", model: "wifi_module_2" };
const HUB3_TARGET = { secretKey: "0123456789abcdef0123456789abcdef", deviceUUID: "d-hub3", model: "hub_3" };

const ackResolved = async () => ({ resultCode: 0, payload: Buffer.alloc(0) });

describe("生成された ble.wifi.* RPC (WM2)", () => {
  let reg;
  beforeEach(() => { reg = buildRegistry(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("ble.wifi.insertSesames が登録され experimental", () => {
    expect(reg.get("ble.wifi.insertSesames")).toBeTruthy();
    expect(stabilityOf("ble.wifi.insertSesames")).toBe("experimental");
  });

  it("invokePath は wifi() を引数なしで解決し、insertSesames(sesameKey) へ位置引数化する", async () => {
    const insertSesames = vi.fn(ackResolved);
    // wifi は **メソッド** (invokePath が value.call(target) で呼ぶ)。companyId は渡されない。
    const wifi = vi.fn((opts) => {
      expect(opts).toBeUndefined(); // 中間セグメント解決は引数なし
      return { insertSesames };
    });
    stubBle({ wifi });
    const sesameKey = { deviceUUID: "child-1", secretKey: "ff".repeat(16), deviceModel: "sesame_5" };
    const r = await reg.get("ble.wifi.insertSesames").handler({ hub: {}, daemon, params: { ...WM2_TARGET, sesameKey } });
    expect(wifi).toHaveBeenCalledWith(); // 引数なし呼び出し
    expect(insertSesames).toHaveBeenCalledWith(sesameKey);
    expect(r).toMatchObject({ resultCode: 0, resultName: expect.any(String) });
  });

  it("removeSesame(sesameKeyTag) へ位置引数化し ack を返す", async () => {
    const removeSesame = vi.fn(ackResolved);
    stubBle({ wifi: () => ({ removeSesame }) });
    await reg.get("ble.wifi.removeSesame").handler({ hub: {}, daemon, params: { ...WM2_TARGET, sesameKeyTag: "TAG-XYZ" } });
    expect(removeSesame).toHaveBeenCalledWith("TAG-XYZ");
  });

  it("必須 sesameKeyTag 欠落は bad_params (removeSesame)", async () => {
    stubBle({ wifi: () => ({ removeSesame: vi.fn() }) });
    await expect(reg.get("ble.wifi.removeSesame").handler({ hub: {}, daemon, params: { ...WM2_TARGET } }))
      .rejects.toThrow();
  });

  // P3-20: ble.wifi.networkStatus は削除済み。SDK に NETWORK_STATUS 送信経路は無い
  //   (CHWifiModule2Device.kt:502-510 受信専用、CHWifiModule2.kt:30-39 に対応 API 無し)。
  //   受信は onPublish の {kind:"networkStatus"} で行う。
  it("ble.wifi.networkStatus は登録されない (P3-20: 送信経路は SDK 非存在)", () => {
    expect(reg.get("ble.wifi.networkStatus")).toBeUndefined();
  });

  it("reset は引数なしで呼ばれる", async () => {
    const reset = vi.fn(ackResolved);
    stubBle({ wifi: () => ({ reset }) });
    await reg.get("ble.wifi.reset").handler({ hub: {}, daemon, params: { ...WM2_TARGET } });
    expect(reset).toHaveBeenCalledWith();
  });

  it("専用ハンドラと重複する WM2 op は生成版に存在しない", () => {
    // scanWifiSSID/setWifiSSID/setWifiPassword/connectWifi は WM2_RPC_OPS に載せていない
    // (専用 ble.wifi.scan / setSsid / setPassword / connect が担う)。
    for (const op of ["scanWifiSSID", "setWifiSSID", "setWifiPassword", "connectWifi"]) {
      expect(reg.get(`ble.wifi.${op}`)).toBeUndefined();
    }
  });
});

describe("生成された ble.hub3.* RPC (Hub3)", () => {
  let reg;
  beforeEach(() => { reg = buildRegistry(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("ble.hub3.setWifiSSID が登録され experimental", () => {
    expect(reg.get("ble.hub3.setWifiSSID")).toBeTruthy();
    expect(stabilityOf("ble.hub3.setWifiSSID")).toBe("experimental");
  });

  it("invokePath は hub3() を引数なしで解決し、setWifiSSID(ssid) へ位置引数化する", async () => {
    const setWifiSSID = vi.fn(ackResolved);
    const hub3 = vi.fn((opts) => {
      expect(opts).toBeUndefined();
      return { setWifiSSID };
    });
    stubBle({ hub3 });
    const r = await reg.get("ble.hub3.setWifiSSID").handler({ hub: {}, daemon, params: { ...HUB3_TARGET, ssid: "MyNet" } });
    expect(hub3).toHaveBeenCalledWith();
    expect(setWifiSSID).toHaveBeenCalledWith("MyNet");
    expect(r).toMatchObject({ resultCode: 0, resultName: expect.any(String) });
  });

  it("setWifiPassword(password) / removeSesame(tag) へ位置引数化する", async () => {
    const setWifiPassword = vi.fn(ackResolved);
    const removeSesame = vi.fn(ackResolved);
    stubBle({ hub3: () => ({ setWifiPassword, removeSesame }) });
    await reg.get("ble.hub3.setWifiPassword").handler({ hub: {}, daemon, params: { ...HUB3_TARGET, password: "pw123" } });
    await reg.get("ble.hub3.removeSesame").handler({ hub: {}, daemon, params: { ...HUB3_TARGET, tag: "child-uuid" } });
    expect(setWifiPassword).toHaveBeenCalledWith("pw123");
    expect(removeSesame).toHaveBeenCalledWith("child-uuid");
  });

  it("scanWifiSSID / networkType は引数なしで呼ばれ ack を返す", async () => {
    const scanWifiSSID = vi.fn(ackResolved);
    const networkType = vi.fn(ackResolved);
    stubBle({ hub3: () => ({ scanWifiSSID, networkType }) });
    await reg.get("ble.hub3.scanWifiSSID").handler({ hub: {}, daemon, params: { ...HUB3_TARGET } });
    await reg.get("ble.hub3.networkType").handler({ hub: {}, daemon, params: { ...HUB3_TARGET } });
    expect(scanWifiSSID).toHaveBeenCalledWith();
    expect(networkType).toHaveBeenCalledWith();
  });

  it("必須 ssid 欠落は bad_params (setWifiSSID)", async () => {
    stubBle({ hub3: () => ({ setWifiSSID: vi.fn() }) });
    await expect(reg.get("ble.hub3.setWifiSSID").handler({ hub: {}, daemon, params: { ...HUB3_TARGET } }))
      .rejects.toThrow();
  });
});
