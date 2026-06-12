// P1-8 (R2:SURF-26 + R2:SURF-39): 生体一覧専用収集ハンドラの結線テスト。
//
// 検証対象: ble.biometric.cardGet / passcodeGet / faceListGet / palmListGet /
//   ble.fingerPrint.fingerPrints の 5 op が「GET → publish(FIRST→NOTIFY×N→LAST) → records 配列」
//   を正しく収集して返すこと。
//
// モックの導出元:
//   - BiometricCommands.registerDelegate は session.onPublish に handleBiometricPublish を結線する
//     (biometric.js BiometricCommands.registerDelegate)。
//   - CARD_NOTIFY/LAST 等の publish イベントのバイト列は参照実装
//     _sesame_sdk_ref/sesame-sdk/.../CHCardEventHandlers.kt:22-39 / CHPassCodeEventHandlers.kt:22-34 に
//     従う: cardGet → CARD_FIRST(onCardReceiveStart) → CARD_NOTIFY(onCardReceive) × N →
//     CARD_LAST(onCardReceiveEnd) の publish 列。
//   - BIO_LIST.card.start/recv/end コールバック名は CHCardDelegate.kt に 1:1 対応している。
//   - fake ファサードは registerDelegate + getter を持つ cmds 面を呼び出し元に露出する
//     (collectBiometricList の cmds 引数仕様 = biometric.js collectBiometricList パラメータ)。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildRegistry } from "../../src/serve/registry.js";
import * as bleIndex from "../../src/ble/index.js";

const daemon = { authState: "ok", hub: { connected: true } };
const TARGET = { secretKey: "0123456789abcdef0123456789abcdef", deviceUUID: "d-1", model: "sesame_touch_pro" };

/**
 * BiometricCommands 面をシミュレートする fake cmds を作る。
 * fire(delegate) はコールバックを即座に呼んで END まで流すスクリプト。
 *
 * 導出元: BiometricCommands.registerDelegate が session.onPublish に handleBiometricPublish を
 * 結線する薄いラッパ (biometric.js BiometricCommands.registerDelegate)。
 * collectBiometricList は registerDelegate を呼び getter を呼ぶ (biometric.js collectBiometricList)。
 *
 * @param {string} getterName  spec.getter (cardGet / passcodeGet / etc.)
 * @param {(d: Record<string, Function>) => void} fire  delegate を受け取り publish を流すコールバック
 */
function makeCmds(getterName, fire) {
  /** @type {Record<string, Function>|null} */
  let delegate = null;
  return {
    /** @param {Record<string, Function>} d @returns {() => void} */
    registerDelegate(d) { delegate = d; return () => { delegate = null; }; },
    [getterName]() {
      if (delegate) fire(delegate);
      return Promise.resolve({ resultCode: 0 });
    },
  };
}

/** SesameBle.use をスタブし、biometric ファサードに fake cmds を差し込む。 */
function stubBle(fakeBiometric) {
  return vi.spyOn(bleIndex.SesameBle, "use").mockImplementation(async (_opts, fn) => {
    const ble = {
      capabilities: bleIndex.capabilitiesForModel("sesame_touch_pro"),
      biometric: fakeBiometric,
      fingerPrint: fakeBiometric, // finger テスト用にも同一 fake を使う
    };
    return fn(/** @type {any} */ (ble));
  });
}

describe("P1-8 生体一覧専用収集ハンドラ (ble.biometric.cardGet 等)", () => {
  /** @type {ReturnType<typeof buildRegistry>} */
  let reg;
  beforeEach(() => { reg = buildRegistry(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("ble.biometric.cardGet: NOTIFY 3 件 + END → records 3 件 ({id,name,type})", async () => {
    // 導出元: CHCardDelegate.kt onCardReceive(device, cardID, cardName, cardType) の引数順
    // (biometric.js BiometricDelegate.onCardReceive 宣言)。
    const cmds = makeCmds("cardGet", (d) => {
      d.onCardReceiveStart(undefined);
      d.onCardReceive(undefined, "id01", "name01", 1);
      d.onCardReceive(undefined, "id02", "name02", 2);
      d.onCardReceive(undefined, "id03", "name03", 3);
      d.onCardReceiveEnd(undefined);
    });
    stubBle(cmds);
    const r = await reg.get("ble.biometric.cardGet").handler({ hub: {}, daemon, params: { ...TARGET, collectMs: 1000 } });
    expect(r).toMatchObject({ records: [
      { id: "id01", name: "name01", type: 1 },
      { id: "id02", name: "name02", type: 2 },
      { id: "id03", name: "name03", type: 3 },
    ] });
  });

  it("ble.biometric.passcodeGet: NOTIFY 2 件 + END → records 2 件", async () => {
    // 導出元: CHPassCodeDelegate.kt onKeyBoardReceive(device, cardID, cardName, cardType) の引数順
    // (biometric.js BiometricDelegate.onKeyBoardReceive 宣言)。
    const cmds = makeCmds("passcodeGet", (d) => {
      d.onKeyBoardReceiveStart(undefined);
      d.onKeyBoardReceive(undefined, "p01", "pw01", 0);
      d.onKeyBoardReceive(undefined, "p02", "pw02", 0);
      d.onKeyBoardReceiveEnd(undefined);
    });
    stubBle(cmds);
    const r = await reg.get("ble.biometric.passcodeGet").handler({ hub: {}, daemon, params: { ...TARGET, collectMs: 1000 } });
    expect(r).toMatchObject({ records: [
      { id: "p01", name: "pw01", type: 0 },
      { id: "p02", name: "pw02", type: 0 },
    ] });
  });

  it("ble.biometric.faceListGet: single オブジェクト 1 件 + END → records 1 件 (parseTouchFace 形)", async () => {
    // 導出元: CHFaceDelegate.kt onFaceReceive(device, face: CHSesameTouchFace) の引数順
    // (biometric.js BiometricDelegate.onFaceReceive 宣言)。BIO_LIST.face.single=true のため
    // obj をそのまま push する。
    const faceObj = { type: 0, idLength: 1, id: "ff", nameLength: 2, nameUUID: "aabb" };
    const cmds = makeCmds("faceListGet", (d) => {
      d.onFaceReceiveStart(undefined);
      d.onFaceReceive(undefined, faceObj);
      d.onFaceReceiveEnd(undefined);
    });
    stubBle(cmds);
    const r = await reg.get("ble.biometric.faceListGet").handler({ hub: {}, daemon, params: { ...TARGET, collectMs: 1000 } });
    expect(r).toMatchObject({ records: [faceObj] });
  });

  it("ble.biometric.palmListGet: single オブジェクト + END → records 返す", async () => {
    // 導出元: CHPalmDelegate.kt onPalmReceive(device, face: CHSesameTouchFace) の引数順。
    const palmObj = { type: 1, idLength: 1, id: "aa", nameLength: 2, nameUUID: "ccdd" };
    const cmds = makeCmds("palmListGet", (d) => {
      d.onPalmReceiveStart(undefined);
      d.onPalmReceive(undefined, palmObj);
      d.onPalmReceiveEnd(undefined);
    });
    stubBle(cmds);
    const r = await reg.get("ble.biometric.palmListGet").handler({ hub: {}, daemon, params: { ...TARGET, collectMs: 1000 } });
    expect(r).toMatchObject({ records: [palmObj] });
  });

  it("ble.fingerPrint.fingerPrints: NOTIFY 1 件 + END → records 1 件", async () => {
    // 導出元: CHFingerPrintDelegate.kt onFingerPrintReceive(device, cardID, cardName, cardType) 引数順
    // (biometric.js BiometricDelegate.onFingerPrintReceive 宣言)。
    // ble.fingerPrint.fingerPrints は fingerPrint ビュー (Bike3 の指紋専用) を使う。
    const cmds = makeCmds("fingerPrints", (d) => {
      d.onFingerPrintReceiveStart(undefined);
      d.onFingerPrintReceive(undefined, "fp01", "fname01", 0);
      d.onFingerPrintReceiveEnd(undefined);
    });
    // fingerPrint ビュー向けに model を bike_3 に変更する
    vi.spyOn(bleIndex.SesameBle, "use").mockImplementation(async (_opts, fn) => {
      const ble = {
        capabilities: bleIndex.capabilitiesForModel("bike_3"),
        biometric: null,
        fingerPrint: cmds,
      };
      return fn(/** @type {any} */ (ble));
    });
    const r = await reg.get("ble.fingerPrint.fingerPrints").handler({
      hub: {}, daemon, params: { ...TARGET, model: "bike_3", collectMs: 1000 },
    });
    expect(r).toMatchObject({ records: [{ id: "fp01", name: "fname01", type: 0 }] });
  });

  it("END 前に timeout すると収集済みレコードを返す", async () => {
    // timeout パスの検証 (END コールバックを送らない)。
    const cmds = makeCmds("cardGet", (d) => {
      d.onCardReceiveStart(undefined);
      d.onCardReceive(undefined, "id01", "n01", 1);
      // onCardReceiveEnd を呼ばない → timeout で確定
    });
    stubBle(cmds);
    const r = await reg.get("ble.biometric.cardGet").handler({
      hub: {}, daemon, params: { ...TARGET, collectMs: 30 },
    });
    expect(r).toMatchObject({ records: [{ id: "id01", name: "n01", type: 1 }] });
  });

  it("5 op がすべてレジストリに登録されている", () => {
    const ops = [
      "ble.biometric.cardGet",
      "ble.biometric.passcodeGet",
      "ble.biometric.faceListGet",
      "ble.biometric.palmListGet",
      "ble.fingerPrint.fingerPrints",
    ];
    for (const op of ops) {
      expect(reg.get(op), `${op} がレジストリに無い`).toBeTruthy();
    }
  });

  it("secretKey 必須 (対象指定群は bleTargetParams と共通)", async () => {
    stubBle({ registerDelegate: vi.fn(() => () => {}), cardGet: vi.fn() });
    await expect(reg.get("ble.biometric.cardGet").handler({ hub: {}, daemon, params: {} }))
      .rejects.toMatchObject({ name: "RpcError", kind: "bad_params" });
  });
});
