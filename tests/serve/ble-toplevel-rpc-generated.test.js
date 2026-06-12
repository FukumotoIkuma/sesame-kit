// SURF-08 段階3: OS3/OS2 トップレベル op (OS3_TOPLEVEL_RPC_OPS / OS2_TOPLEVEL_RPC_OPS) から
// 自動生成した ble.<op> / ble.os2.<op> RPC の結線テスト。
//
// 検証の要 (下書きからの修正点を固定する):
//   - deleteHistory は recordId 数値ではなく history() の payload Buffer を **1 位置引数**で受ける
//   - opSensorControl は boolean enabled ではなく number seconds を受ける
//   - sendAdvProductType は data (Buffer) を **必須**で受ける (引数なしではない)
//   - setBleTxPower の引数名は txPower
//   - magnet は読み取りではなく **ack** (CHResult<CHEmpty>)
//   - OS2 autolock / disableAutolock / updateSetting の trailing tag は省略可
//   - OS2 history({ack}) は opts オブジェクト 1 引数で raw
// named params → ファサードメソッドの位置引数への写像が宣言順どおりであることを
// SesameBle.use / SesameOS2Ble.use スタブで invokePath 経由に確認する。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildRegistry } from "../../src/serve/registry.js";
import { stabilityOf } from "../../src/serve/stability.js";
import { SesameBle, SesameOS2Ble } from "../../src/ble/index.js";

const daemon = { authState: "active", hub: { connected: true } };

const OS3_TARGET = { secretKey: "00".repeat(16), deviceUUID: "U", model: "sesame_5" };
const OS2_TARGET = { secretKey: "00".repeat(16), keyIndex: "0000", ssmPublicKey: "11".repeat(64), deviceUUID: "U", model: "sesame_3" };

/** SesameBle.use を乗っ取り、fake facade を fn へ渡す。 */
function stubOs3(fake) {
  return vi.spyOn(SesameBle, "use").mockImplementation(async (_opts, fn) => fn(fake));
}
/** SesameOS2Ble.use を乗っ取り、fake facade を fn へ渡す。 */
function stubOs2(fake) {
  return vi.spyOn(SesameOS2Ble, "use").mockImplementation(async (_opts, fn) => fn(fake));
}

const ackResp = () => ({ resultCode: 0, payload: Buffer.alloc(0) });

describe("生成された OS3 トップレベル ble.<op>", () => {
  let reg;
  beforeEach(() => { reg = buildRegistry(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("代表 op が登録され experimental", () => {
    for (const op of ["ble.history", "ble.deleteHistory", "ble.getVersionTag", "ble.magnet",
      "ble.opSensorControl", "ble.sendAdvProductType", "ble.setBleTxPower"]) {
      expect(reg.get(op), `${op} が未登録`).toBeTruthy();
      expect(stabilityOf(op)).toBe("experimental");
    }
  });

  it("ble.history は引数なしで raw payload をそのまま返す", async () => {
    const history = vi.fn(async () => Buffer.from([0xde, 0xad]));
    stubOs3({ history });
    const r = await reg.get("ble.history").handler({ hub: {}, daemon, params: { ...OS3_TARGET } });
    expect(history).toHaveBeenCalledWith();
    expect(Buffer.isBuffer(r)).toBe(true);
    expect(r.toString("hex")).toBe("dead");
  });

  it("ble.deleteHistory は historyPayload Buffer を位置引数化し ack を返す ($buffer revive)", async () => {
    const deleteHistory = vi.fn(async () => ackResp());
    stubOs3({ deleteHistory });
    const r = await reg.get("ble.deleteHistory").handler({
      hub: {}, daemon, params: { ...OS3_TARGET, historyPayload: { $buffer: "00010203" } },
    });
    expect(deleteHistory).toHaveBeenCalledTimes(1);
    const arg = deleteHistory.mock.calls[0][0];
    expect(Buffer.isBuffer(arg)).toBe(true);
    expect(arg.toString("hex")).toBe("00010203");
    expect(r).toEqual({ resultCode: 0, resultName: "success" });
  });

  it("ble.deleteHistory は historyPayload 欠落で bad_params (必須)", async () => {
    stubOs3({ deleteHistory: vi.fn() });
    await expect(reg.get("ble.deleteHistory").handler({ hub: {}, daemon, params: { ...OS3_TARGET } }))
      .rejects.toMatchObject({ name: "RpcError", kind: "bad_params" });
  });

  it("ble.opSensorControl は number seconds を位置引数化する (0 も有効値)", async () => {
    const opSensorControl = vi.fn(async () => ackResp());
    stubOs3({ opSensorControl });
    await reg.get("ble.opSensorControl").handler({ hub: {}, daemon, params: { ...OS3_TARGET, seconds: 0 } });
    expect(opSensorControl).toHaveBeenCalledWith(0);
  });

  it("ble.sendAdvProductType は data (Buffer) を必須で受ける", async () => {
    const sendAdvProductType = vi.fn(async () => ackResp());
    stubOs3({ sendAdvProductType });
    const r = await reg.get("ble.sendAdvProductType").handler({
      hub: {}, daemon, params: { ...OS3_TARGET, data: { $buffer: "abcd" } },
    });
    expect(Buffer.isBuffer(sendAdvProductType.mock.calls[0][0])).toBe(true);
    expect(sendAdvProductType.mock.calls[0][0].toString("hex")).toBe("abcd");
    expect(r).toEqual({ resultCode: 0, resultName: "success" });
    stubOs3({ sendAdvProductType: vi.fn() });
    await expect(reg.get("ble.sendAdvProductType").handler({ hub: {}, daemon, params: { ...OS3_TARGET } }))
      .rejects.toMatchObject({ name: "RpcError", kind: "bad_params" });
  });

  it("ble.setBleTxPower は txPower を位置引数化し ack", async () => {
    const setBleTxPower = vi.fn(async () => ackResp());
    stubOs3({ setBleTxPower });
    const r = await reg.get("ble.setBleTxPower").handler({ hub: {}, daemon, params: { ...OS3_TARGET, txPower: -8 } });
    expect(setBleTxPower).toHaveBeenCalledWith(-8);
    expect(r).toEqual({ resultCode: 0, resultName: "success" });
  });

  it("ble.magnet は引数なしの ack (読み取りではない)", async () => {
    const magnet = vi.fn(async () => ackResp());
    stubOs3({ magnet });
    const r = await reg.get("ble.magnet").handler({ hub: {}, daemon, params: { ...OS3_TARGET } });
    expect(magnet).toHaveBeenCalledWith();
    expect(r).toEqual({ resultCode: 0, resultName: "success" });
  });

  it("制御 verb (lock/unlock/toggle/autolock) と status は生成されない (意図的除外)", () => {
    for (const op of ["ble.lock", "ble.unlock", "ble.click", "ble.toggle", "ble.autolock", "ble.status"]) {
      expect(reg.get(op), `${op} は OS3 toplevel から生成されてはならない`).toBeUndefined();
    }
  });
});

describe("生成された OS2 トップレベル ble.os2.<op>", () => {
  let reg;
  beforeEach(() => { reg = buildRegistry(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("代表 op が登録され experimental", () => {
    for (const op of ["ble.os2.autolock", "ble.os2.disableAutolock", "ble.os2.getAutolock",
      "ble.os2.history", "ble.os2.versionTag", "ble.os2.updateSetting"]) {
      expect(reg.get(op), `${op} が未登録`).toBeTruthy();
      expect(stabilityOf(op)).toBe("experimental");
    }
  });

  it("ble.os2.autolock は (seconds, tag) の順で位置引数化する (tag 省略可)", async () => {
    const autolock = vi.fn(async () => ackResp());
    stubOs2({ autolock });
    // tag なし → seconds のみが位置引数 (undefined trailing は写像されるが値は undefined)
    const r = await reg.get("ble.os2.autolock").handler({ hub: {}, daemon, params: { ...OS2_TARGET, seconds: 300 } });
    expect(autolock.mock.calls[0][0]).toBe(300);
    expect(autolock.mock.calls[0][1]).toBeUndefined();
    expect(r).toEqual({ resultCode: 0, resultName: "success" });
    // tag あり → 2 番目に Buffer
    stubOs2({ autolock });
    await reg.get("ble.os2.autolock").handler({ hub: {}, daemon, params: { ...OS2_TARGET, seconds: 0, tag: { $buffer: "aa" } } });
    expect(autolock.mock.calls[1][0]).toBe(0);
    expect(Buffer.isBuffer(autolock.mock.calls[1][1])).toBe(true);
  });

  it("ble.os2.autolock は seconds 欠落で bad_params", async () => {
    stubOs2({ autolock: vi.fn() });
    await expect(reg.get("ble.os2.autolock").handler({ hub: {}, daemon, params: { ...OS2_TARGET } }))
      .rejects.toMatchObject({ name: "RpcError", kind: "bad_params" });
  });

  it("ble.os2.getAutolock は引数なしで raw (number) をそのまま返す", async () => {
    const getAutolock = vi.fn(async () => 300);
    stubOs2({ getAutolock });
    const r = await reg.get("ble.os2.getAutolock").handler({ hub: {}, daemon, params: { ...OS2_TARGET } });
    expect(getAutolock).toHaveBeenCalledWith();
    expect(r).toBe(300);
  });

  it("ble.os2.history は opts オブジェクトを位置引数化し raw payload を返す", async () => {
    const history = vi.fn(async () => Buffer.from([0x01]));
    stubOs2({ history });
    const r = await reg.get("ble.os2.history").handler({ hub: {}, daemon, params: { ...OS2_TARGET, opts: { ack: false } } });
    expect(history).toHaveBeenCalledWith({ ack: false });
    expect(Buffer.isBuffer(r)).toBe(true);
  });

  it("ble.os2.updateSetting は (setting, tag) の順で位置引数化する", async () => {
    const updateSetting = vi.fn(async () => ackResp());
    stubOs2({ updateSetting });
    const setting = { userPrefDir: 0, lockSec: 1, unlockSec: 1, clickLockSec: 1, clickHoldSec: 1, clickUnlockSec: 1, buttonMode: 0 };
    const r = await reg.get("ble.os2.updateSetting").handler({ hub: {}, daemon, params: { ...OS2_TARGET, setting } });
    expect(updateSetting.mock.calls[0][0]).toEqual(setting);
    expect(r).toEqual({ resultCode: 0, resultName: "success" });
    stubOs2({ updateSetting: vi.fn() });
    await expect(reg.get("ble.os2.updateSetting").handler({ hub: {}, daemon, params: { ...OS2_TARGET } }))
      .rejects.toMatchObject({ name: "RpcError", kind: "bad_params" });
  });

  it("制御 verb (lock/unlock/click/toggle) と status は生成されない (意図的除外)", () => {
    for (const op of ["ble.os2.lock", "ble.os2.unlock", "ble.os2.click", "ble.os2.toggle", "ble.os2.status"]) {
      expect(reg.get(op), `${op} は OS2 toplevel から生成されてはならない`).toBeUndefined();
    }
  });
});
