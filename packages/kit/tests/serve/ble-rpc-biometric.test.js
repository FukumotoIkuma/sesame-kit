// SURF-08 段階3: BIOMETRIC_RPC_OPS / FINGERPRINT_RPC_OPS / REMOTE_NANO_RPC_OPS から自動生成した
// ble.biometric.* / ble.fingerPrint.* / ble.remoteNano.* RPC の結線テスト。
//
// 検証の要 (ble-rpc-generated.test.js と同手法): named params → ファサードメソッドの **位置引数**
// への写像が宣言順どおりであること (順序がずれるとワイヤのバイト列が壊れる)。SesameBle.use を
// スタブし、サブファサード getter が返すビューの該当メソッドが期待引数で呼ばれることを
// invokePath 経由で確認する。ack は {resultCode,resultName} に正規化、raw はそのまま返る。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildRegistry } from "../../src/serve/registry.js";
import { stabilityOf } from "../../src/serve/stability.js";
import * as bleIndex from "@sesame-kit/core/ble";

const daemon = { authState: "ok", hub: { connected: true } };
const ACK = { resultCode: 0, payload: Buffer.alloc(0) };

/** SesameBle.use をスタブし、fn に渡す擬似 facade を差し込む。 */
function stubBle(fakeFacade) {
  return vi.spyOn(bleIndex.SesameBle, "use").mockImplementation(async (_opts, fn) => fn(fakeFacade));
}

const TARGET = { secretKey: "0123456789abcdef0123456789abcdef", deviceUUID: "d-1", model: "sesame_touch_pro" };

describe("生成された ble.biometric.* / ble.fingerPrint.* / ble.remoteNano.* RPC", () => {
  let reg;
  beforeEach(() => { reg = buildRegistry(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("代表 op が登録され experimental", () => {
    for (const op of ["ble.biometric.cardAdd", "ble.biometric.cardModeGet", "ble.fingerPrint.fingerPrintDelete", "ble.remoteNano.setTriggerDelayTime"]) {
      expect(reg.get(op)).toBeTruthy();
      expect(stabilityOf(op)).toBe("experimental");
    }
  });

  it("36 個の biometric/fingerPrint/remoteNano op がすべて生成される", () => {
    const keys = Object.keys(bleIndex.BLE_RPC_OPS)
      .filter((k) => k.startsWith("biometric") || k.startsWith("fingerPrint") || k.startsWith("remoteNano"));
    expect(keys).toHaveLength(36);
    for (const k of keys) expect(reg.get(`ble.${k}`)).toBeTruthy();
  });

  it("cardAdd は (id, hexName) の順で位置引数化され ack を返す", async () => {
    const cardAdd = vi.fn(async () => ACK);
    stubBle({ biometric: { cardAdd } });
    const id = { type: "Buffer", data: [0x0a, 0x0b] };
    const r = await reg.get("ble.biometric.cardAdd").handler({ hub: {}, daemon, params: { ...TARGET, id, hexName: "AB" } });
    expect(cardAdd).toHaveBeenCalledTimes(1);
    const [argId, argName] = cardAdd.mock.calls[0];
    expect(Buffer.isBuffer(argId)).toBe(true); // {type:'Buffer',data:[]} → revive で Buffer 化
    expect(Array.from(argId)).toEqual([0x0a, 0x0b]);
    expect(argName).toBe("AB");
    expect(r).toMatchObject({ resultCode: 0, resultName: expect.any(String) });
  });

  it("cardMove は (cardId, touchProUUID) の順で位置引数化される", async () => {
    const cardMove = vi.fn(async () => ACK);
    stubBle({ biometric: { cardMove } });
    await reg.get("ble.biometric.cardMove").handler({ hub: {}, daemon, params: { ...TARGET, cardId: "0a0b", touchProUUID: "uuid-x" } });
    expect(cardMove).toHaveBeenCalledWith("0a0b", "uuid-x");
  });

  it("cardChange は (ID, hexName) の順、faceChange は (ID, name) の順", async () => {
    const cardChange = vi.fn(async () => ACK);
    const faceChange = vi.fn(async () => ACK);
    stubBle({ biometric: { cardChange, faceChange } });
    await reg.get("ble.biometric.cardChange").handler({ hub: {}, daemon, params: { ...TARGET, ID: "aa", hexName: "bb" } });
    await reg.get("ble.biometric.faceChange").handler({ hub: {}, daemon, params: { ...TARGET, ID: "cc", name: "dd" } });
    expect(cardChange).toHaveBeenCalledWith("aa", "bb");
    expect(faceChange).toHaveBeenCalledWith("cc", "dd");
  });

  it("cardModeGet は raw 結果 (mode byte) をそのまま返す", async () => {
    const cardModeGet = vi.fn(async () => 2);
    stubBle({ biometric: { cardModeGet } });
    const r = await reg.get("ble.biometric.cardModeGet").handler({ hub: {}, daemon, params: { ...TARGET } });
    expect(cardModeGet).toHaveBeenCalledWith();
    expect(r).toBe(2);
  });

  it("insertSesame は単一 object 引数で渡る ({deviceUUID, secretKey, ...})", async () => {
    const insertSesame = vi.fn(async () => ACK);
    stubBle({ biometric: { insertSesame } });
    const sesame = { deviceUUID: "uuid", secretKey: "k" };
    await reg.get("ble.biometric.insertSesame").handler({ hub: {}, daemon, params: { ...TARGET, sesame } });
    expect(insertSesame).toHaveBeenCalledWith(sesame);
  });

  it("removeSesame は (tag, opts) の順。opts 省略時は undefined", async () => {
    const removeSesame = vi.fn(async () => ACK);
    stubBle({ biometric: { removeSesame } });
    await reg.get("ble.biometric.removeSesame").handler({ hub: {}, daemon, params: { ...TARGET, tag: "uuid-y", opts: { keyType: 4 } } });
    expect(removeSesame).toHaveBeenCalledWith("uuid-y", { keyType: 4 });
    removeSesame.mockClear();
    await reg.get("ble.biometric.removeSesame").handler({ hub: {}, daemon, params: { ...TARGET, tag: "uuid-z" } });
    expect(removeSesame).toHaveBeenCalledWith("uuid-z", undefined);
  });

  it("必須 hexName 欠落は bad_params (cardAdd)", async () => {
    stubBle({ biometric: { cardAdd: vi.fn() } });
    await expect(reg.get("ble.biometric.cardAdd").handler({ hub: {}, daemon, params: { ...TARGET, id: { type: "Buffer", data: [] } } }))
      .rejects.toThrow();
  });

  it("fingerPrint.fingerPrintDelete は (id) の位置引数で ack を返す", async () => {
    const fingerPrintDelete = vi.fn(async () => ACK);
    stubBle({ fingerPrint: { fingerPrintDelete } });
    const r = await reg.get("ble.fingerPrint.fingerPrintDelete").handler({ hub: {}, daemon, params: { ...TARGET, fingerPrintID: "0a0b" } });
    expect(fingerPrintDelete).toHaveBeenCalledWith("0a0b");
    expect(r).toMatchObject({ resultCode: 0, resultName: expect.any(String) });
  });

  it("remoteNano.setTriggerDelayTime は (time) の位置引数で ack を返す", async () => {
    const setTriggerDelayTime = vi.fn(async () => ACK);
    stubBle({ remoteNano: { setTriggerDelayTime } });
    const r = await reg.get("ble.remoteNano.setTriggerDelayTime").handler({ hub: {}, daemon, params: { ...TARGET, time: 30 } });
    expect(setTriggerDelayTime).toHaveBeenCalledWith(30);
    expect(r).toMatchObject({ resultCode: 0, resultName: expect.any(String) });
  });

  it("registerDelegate / onEnroll / cardBatchAdd は op 化されない (RPC 不向きで除外)", () => {
    for (const op of [
      "ble.biometric.registerDelegate", "ble.biometric.onEnroll", "ble.biometric.cardBatchAdd",
      "ble.biometric.passcodeBatchAdd", "ble.fingerPrint.registerDelegate", "ble.remoteNano.registerDelegate",
    ]) {
      expect(reg.get(op)).toBeUndefined();
    }
  });
});
