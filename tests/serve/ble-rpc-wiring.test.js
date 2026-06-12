// BLE 専用 RPC (P4-1 段階2) の配線テストと invokePath の fail-closed (P4-2) 否定ケース。
//
// - ble.updateFirmware / ble.reset / ble.position / ble.wifi.* が SesameBle ファサードの
//   対応メソッドへ正しい引数で委譲し、JSON 化可能な ack を返すこと。
// - invokePath が allowlist 非掲載の第 1 セグメントを **getter を実行する前に** bad_params で
//   拒否すること (旧 fail-open の回帰防止)。
import { describe, it, expect, vi, afterEach } from "vitest";
import { buildRegistry, invokePath, collectWifiScan, wifiViewOf } from "../../src/serve/registry.js";
import { SesameBle, SesameOS2Ble, BLE_RPC_ALLOWLIST, OS2_BLE_RPC_ALLOWLIST, capabilitiesForModel } from "../../src/ble/index.js";
import { ITEM_CODES } from "../../src/itemcodes.js";

const daemon = { authState: "active", hub: { connected: true } };
const reg = buildRegistry();
const TARGET = { secretKey: "00".repeat(16), deviceUUID: "U", model: "sesame_5" };

afterEach(() => vi.restoreAllMocks());

/** SesameBle.use を乗っ取り、fake facade を fn へ渡す。 */
function stubUse(fake) {
  return vi.spyOn(SesameBle, "use").mockImplementation(async (_opts, fn) => fn(fake));
}

/** publish 購読 + scanWifiSSID を持つ fake Wi-Fi view。fire(cb) で publish を流す。 */
function makeWifiView({ onScan } = {}) {
  let cb = null;
  const view = {
    calls: [],
    onPublish(fn) { cb = fn; return () => { cb = null; }; },
    async scanWifiSSID() { view.calls.push(["scanWifiSSID"]); if (onScan) onScan(() => cb); return { resultCode: 0 }; },
    async setWifiSSID(ssid) { view.calls.push(["setWifiSSID", ssid]); return { resultCode: 0 }; },
    async setWifiPassword(pw) { view.calls.push(["setWifiPassword", pw]); return { resultCode: 0 }; },
    async connectWifi() { view.calls.push(["connectWifi"]); return { resultCode: 0 }; },
  };
  return view;
}

/** capabilities + wifi()/hub3() を持つ最小 fake facade。 */
function makeWifiBle(model, view) {
  return {
    capabilities: capabilitiesForModel(model),
    wifi: vi.fn(() => view),
    hub3: vi.fn(() => view),
  };
}

describe("registry: ble.* 専用 RPC の配線", () => {
  it("ble.updateFirmware: 応答あり (Hub3/WM2 経路) は {commandSent:true, resultCode, resultName}", async () => {
    const fake = { updateFirmware: vi.fn(async () => ({ resultCode: 0, payload: Buffer.alloc(0), session: {} })) };
    stubUse(fake);
    const e = reg.get("ble.updateFirmware");
    expect(e).toBeTruthy();
    const r = await e.handler({ hub: {}, daemon, params: { ...TARGET, timeoutMs: 123 } });
    expect(fake.updateFirmware).toHaveBeenCalledWith({ timeoutMs: 123 });
    expect(r).toEqual({ commandSent: true, resultCode: 0, resultName: "success" });
  });

  it("ble.updateFirmware: OS3 ロック系の no-op 経路 ({session} 同期返し) は commandSent:false", async () => {
    const fake = { updateFirmware: vi.fn(() => ({ session: {} })) };
    stubUse(fake);
    const r = await reg.get("ble.updateFirmware").handler({ hub: {}, daemon, params: { ...TARGET } });
    expect(r).toEqual({ commandSent: false, resultCode: null, resultName: null });
  });

  it("ble.reset → ble.reset() の ack {resultCode, resultName}", async () => {
    const fake = { reset: vi.fn(async () => ({ resultCode: 0, payload: Buffer.alloc(0) })) };
    stubUse(fake);
    const r = await reg.get("ble.reset").handler({ hub: {}, daemon, params: { ...TARGET } });
    expect(fake.reset).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ resultCode: 0, resultName: "success" });
  });

  it("ble.position → configureLockPosition(lock, unlock) (0 は有効値)", async () => {
    const fake = { configureLockPosition: vi.fn(async () => ({ resultCode: 0, payload: Buffer.alloc(0) })) };
    stubUse(fake);
    const r = await reg.get("ble.position").handler({
      hub: {}, daemon, params: { ...TARGET, lockPosition: 0, unlockPosition: 256 },
    });
    expect(fake.configureLockPosition).toHaveBeenCalledWith(0, 256);
    expect(r).toEqual({ resultCode: 0, resultName: "success" });
  });

  it("ble.position: lockPosition 欠落は bad_params", async () => {
    stubUse({ configureLockPosition: vi.fn() });
    await expect(reg.get("ble.position").handler({ hub: {}, daemon, params: { ...TARGET, unlockPosition: 1 } }))
      .rejects.toMatchObject({ name: "RpcError", kind: "bad_params" });
  });

  it("ble.wifi.scan (Hub3): SSID_LAST マーカーで早期確定し、同一 SSID は rssi を更新する", async () => {
    const view = makeWifiView({
      onScan: (getCb) => {
        const cb = getCb();
        cb({ kind: "scanWifiSSID", ssid: "net-a", rssi: -50 });
        cb({ kind: "scanWifiSSID", ssid: "net-b", rssi: -70 });
        cb({ kind: "scanWifiSSID", ssid: "net-a", rssi: -42 }); // 再 publish → rssi 更新
        cb({ kind: "ssidMarker", itemCode: ITEM_CODES.HUB3_ITEM_CODE_SSID_LAST });
      },
    });
    const fake = makeWifiBle("hub_3", view);
    stubUse(fake);
    const r = await reg.get("ble.wifi.scan").handler({
      hub: {}, daemon, params: { ...TARGET, model: "hub_3", collectMs: 60_000 },
    });
    // SSID_LAST で 60s を待たずに確定している (タイムアウト待ちならテストが timeout する)。
    expect(r).toEqual({ ssids: [{ ssid: "net-a", rssi: -42 }, { ssid: "net-b", rssi: -70 }] });
    expect(fake.hub3).toHaveBeenCalled(); // kind 自動判別: hub_3 → hub3()
    expect(fake.wifi).not.toHaveBeenCalled();
  });

  it("ble.wifi.scan (WM2): 終了マーカーが無いので collectMs で打ち切る", async () => {
    const view = makeWifiView({
      onScan: (getCb) => { getCb()({ kind: "scanWifiSSID", ssid: "wm2-net", rssi: -33 }); },
    });
    const fake = makeWifiBle("wm_2", view);
    stubUse(fake);
    const r = await reg.get("ble.wifi.scan").handler({
      hub: {}, daemon, params: { ...TARGET, model: "wm_2", collectMs: 30 },
    });
    expect(r).toEqual({ ssids: [{ ssid: "wm2-net", rssi: -33 }] });
    expect(fake.wifi).toHaveBeenCalled(); // kind 自動判別: wm_2 → wifi()
  });

  it("ble.wifi.setSsid / setPassword → view への委譲と ack", async () => {
    const view = makeWifiView();
    stubUse(makeWifiBle("hub_3", view));
    const r1 = await reg.get("ble.wifi.setSsid").handler({ hub: {}, daemon, params: { ...TARGET, model: "hub_3", ssid: "net" } });
    const r2 = await reg.get("ble.wifi.setPassword").handler({ hub: {}, daemon, params: { ...TARGET, model: "hub_3", password: "pw" } });
    expect(view.calls).toEqual([["setWifiSSID", "net"], ["setWifiPassword", "pw"]]);
    expect(r1).toEqual({ resultCode: 0, resultName: "success" });
    expect(r2).toEqual({ resultCode: 0, resultName: "success" });
  });

  it("ble.wifi.connect は WM2 のみ (Hub3 は bad_params)", async () => {
    const view = makeWifiView();
    stubUse(makeWifiBle("wm_2", view));
    const r = await reg.get("ble.wifi.connect").handler({ hub: {}, daemon, params: { ...TARGET, model: "wm_2" } });
    expect(view.calls).toEqual([["connectWifi"]]);
    expect(r).toEqual({ resultCode: 0, resultName: "success" });

    stubUse(makeWifiBle("hub_3", makeWifiView()));
    await expect(reg.get("ble.wifi.connect").handler({ hub: {}, daemon, params: { ...TARGET, model: "hub_3" } }))
      .rejects.toMatchObject({ name: "RpcError", kind: "bad_params" });
  });

  it("ble.wifi.*: model 欠落は bad_params (WM2/Hub3 判別に必須)", async () => {
    stubUse(makeWifiBle("hub_3", makeWifiView()));
    const { model, ...noModel } = TARGET;
    for (const name of ["ble.wifi.scan", "ble.wifi.setSsid", "ble.wifi.setPassword", "ble.wifi.connect"]) {
      await expect(reg.get(name).handler({ hub: {}, daemon, params: { ...noModel, ssid: "s", password: "p" } }))
        .rejects.toMatchObject({ name: "RpcError", kind: "bad_params" });
    }
  });

  it("ble.wifi.*: WM2/Hub3 以外の model は bad_params (wifiViewOf)", async () => {
    stubUse({ capabilities: capabilitiesForModel("sesame_5"), wifi: vi.fn(), hub3: vi.fn() });
    await expect(reg.get("ble.wifi.setSsid").handler({ hub: {}, daemon, params: { ...TARGET, model: "sesame_5", ssid: "s" } }))
      .rejects.toMatchObject({ name: "RpcError", kind: "bad_params" });
  });

  it("ble.* 専用 RPC は secretKey 必須 (対象指定群は ble.invoke と共通)", async () => {
    for (const name of ["ble.updateFirmware", "ble.reset", "ble.position", "ble.wifi.scan"]) {
      const e = reg.get(name);
      const p = e.params.find((x) => x.name === "secretKey");
      expect(p, `${name} に secretKey param が無い`).toBeTruthy();
      expect(p.required).toBe(true);
      await expect(e.handler({ hub: {}, daemon, params: {} }))
        .rejects.toMatchObject({ name: "RpcError", kind: "bad_params" });
    }
  });
});

describe("invokePath の fail-closed (P4-2)", () => {
  it("allowlist 非掲載の第 1 セグメントは bad_params (getter を実行しない)", async () => {
    let getterRan = false;
    const root = {};
    Object.defineProperty(root, "evil", { get() { getterRan = true; return () => "boom"; }, enumerable: true });
    await expect(invokePath(root, "evil", [], BLE_RPC_ALLOWLIST))
      .rejects.toMatchObject({ name: "RpcError", kind: "bad_params" });
    expect(getterRan).toBe(false);
  });

  it("接続ライフサイクル API (close/connect/register) へ到達できない", async () => {
    const close = vi.fn();
    const root = { close, connect: vi.fn(), register: vi.fn() };
    for (const op of ["close", "connect", "register"]) {
      await expect(invokePath(root, op, [], BLE_RPC_ALLOWLIST))
        .rejects.toMatchObject({ name: "RpcError", kind: "bad_params" });
    }
    expect(close).not.toHaveBeenCalled();
  });

  it("allowlist 省略時は全拒否 (fail-closed が既定)", async () => {
    await expect(invokePath({ status: async () => ({}) }, "status"))
      .rejects.toMatchObject({ name: "RpcError", kind: "bad_params" });
  });

  it("非公開プロパティ・prototype 連鎖は従来どおり拒否される", async () => {
    const root = { status: async () => ({}), _session: { secret: "x" } };
    for (const op of ["_session.secret", "status.constructor", "status.prototype.x"]) {
      await expect(invokePath(root, op, [], BLE_RPC_ALLOWLIST))
        .rejects.toMatchObject({ name: "RpcError", kind: "bad_params" });
    }
  });

  it("掲載 op は実行され、$buffer 引数が revive される", async () => {
    const lock = vi.fn(async (tag) => ({ resultCode: 0, tag }));
    const r = await invokePath({ lock }, "lock", [{ $buffer: "00ff" }], BLE_RPC_ALLOWLIST);
    expect(lock).toHaveBeenCalledTimes(1);
    expect(Buffer.isBuffer(lock.mock.calls[0][0])).toBe(true);
    expect(lock.mock.calls[0][0].toString("hex")).toBe("00ff");
    expect(r.resultCode).toBe(0);
  });

  it("掲載第 1 セグメント配下のドット連鎖は通る (script.getScriptNameList 形)", async () => {
    const getScriptNameList = vi.fn(async () => ({ curIdx: 0, events: [] }));
    const root = { get script() { return { getScriptNameList }; } };
    const r = await invokePath(root, "script.getScriptNameList", [], BLE_RPC_ALLOWLIST);
    expect(getScriptNameList).toHaveBeenCalled();
    expect(r).toEqual({ curIdx: 0, events: [] });
  });

  it("ble.os2.invoke は OS2 allowlist で照合する (connect は拒否 / lock は実行)", async () => {
    const fake = { lock: vi.fn(async () => ({ resultCode: 0 })), connect: vi.fn() };
    vi.spyOn(SesameOS2Ble, "use").mockImplementation(async (_opts, fn) => fn(fake));
    const e = reg.get("ble.os2.invoke");
    const base = { secretKey: "00".repeat(16), keyIndex: "0000", ssmPublicKey: "11".repeat(64), deviceUUID: "U" };
    await expect(e.handler({ hub: {}, daemon, params: { ...base, op: "connect" } }))
      .rejects.toMatchObject({ name: "RpcError", kind: "bad_params" });
    expect(fake.connect).not.toHaveBeenCalled();
    const r = await e.handler({ hub: {}, daemon, params: { ...base, op: "lock" } });
    expect(fake.lock).toHaveBeenCalled();
    expect(r).toEqual({ resultCode: 0 });
    expect(OS2_BLE_RPC_ALLOWLIST).toContain("lock");
  });

  it("ble.invoke は BLE allowlist で照合する (use へ到達しない非掲載 op)", async () => {
    const fake = { status: vi.fn(async () => ({ ok: 1 })), close: vi.fn() };
    vi.spyOn(SesameBle, "use").mockImplementation(async (_opts, fn) => fn(fake));
    const e = reg.get("ble.invoke");
    await expect(e.handler({ hub: {}, daemon, params: { ...TARGET, op: "close" } }))
      .rejects.toMatchObject({ name: "RpcError", kind: "bad_params" });
    expect(fake.close).not.toHaveBeenCalled();
    const r = await e.handler({ hub: {}, daemon, params: { ...TARGET, op: "status" } });
    expect(r).toEqual({ ok: 1 });
  });
});

describe("collectWifiScan / wifiViewOf 単体", () => {
  it("scanWifiSSID の ack 失敗は reject に伝搬し購読を解除する", async () => {
    let cb = null;
    let offCalled = false;
    const view = {
      onPublish(fn) { cb = fn; return () => { offCalled = true; }; },
      scanWifiSSID: async () => { throw new Error("busy"); },
    };
    await expect(collectWifiScan(view, { collectMs: 1000 })).rejects.toThrow("busy");
    expect(offCalled).toBe(true);
  });

  it("wifiViewOf は WM2 既定の companyId を注入しつつ上書き可能", () => {
    const wifi = vi.fn((opts) => ({ opts }));
    const ble = { capabilities: capabilitiesForModel("wm_2"), wifi };
    wifiViewOf(ble, {});
    expect(typeof wifi.mock.calls[0][0].companyId).toBe("string");
    expect(wifi.mock.calls[0][0].companyId.length).toBeGreaterThan(0);
    wifiViewOf({ ...ble, wifi }, { companyId: "my-id" });
    expect(wifi.mock.calls[1][0].companyId).toBe("my-id");
  });
});
