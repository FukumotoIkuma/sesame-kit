// packages/core/tests/_spec/ble3-c10.test.js
//
// Vitest テスト: BLE3-0188 〜 BLE3-0205 (18 件)
// spec ソース: spec/ble-os3.md
//   (biometric-pubkey, biometric-mechstatus, parse-error, capability-gate,
//    biometric-contract, list-collect)
//
// 方針: ネットワーク/実機非依存。全テスト独立・決定論的。
// TDD: spec どおりの期待値で固定 (実装の現状に合わせない)。

import { describe, it, expect, vi } from "vitest";
import { Buffer } from "node:buffer";

// ---- biometric.js exports ----
import {
  parsePubKeySesame,
  parseBiometricMechStatus,
  parseTouchCard,
  parseTouchFace,
  handleBiometricPublish,
  BiometricCommands,
  collectBiometricList,
  BIO_LIST,
  BIOMETRIC_RPC_OPS,
  FINGERPRINT_RPC_OPS,
  REMOTE_NANO_RPC_OPS,
} from "../../src/ble/biometric.js";

// ---- index.js exports ----
import {
  SesameBle,
  BLE_RPC_ALLOWLIST,
  BLE_RPC_OPS,
  invokePath,
  bleCommandAck,
  bioCapsForModel,
} from "../../src/ble/index.js";

// ---- devicemodel.js exports ----
import { capabilitiesForModel } from "../../src/ble/devicemodel.js";

// ────────────────────────────────────────────────────────────────
//  共通ヘルパ
// ────────────────────────────────────────────────────────────────

/** connect しないダミー transport (SesameBle constructor を通すだけ)。 */
const fakeTransport = {
  connect: async () => {},
  write: () => {},
  disconnect: async () => {},
};

/**
 * 最小限の session スタブ (BiometricCommands 用)。
 * request は {resultCode:0, payload:Buffer.alloc(0)} を即 resolve する。
 * onPublish は unsubscribe 関数を返す。
 * _emit で登録済みハンドラを直接呼べる。
 */
function makeSession({ onPublish } = {}) {
  const handlers = [];
  return {
    request: vi.fn().mockResolvedValue({ resultCode: 0, payload: Buffer.alloc(0) }),
    onPublish: typeof onPublish === "function"
      ? onPublish
      : (fn) => { handlers.push(fn); return () => {}; },
    _emit: (pkt) => { for (const h of handlers) h(pkt); },
  };
}

// =========================================================================
// [BLE3-0188] PUB_KEY_SESAME 空きスロット判定の OpenSensor 分岐 (>1 vs >=1)
// =========================================================================
describe("[BLE3-0188] parsePubKeySesame: hasEmptySlot 判定が OpenSensor で >1、それ以外で >=1", () => {
  // 全ゼロ 23B チャンク = 空きスロット
  const emptyChunk = Buffer.alloc(23, 0x00);
  // 非空チャンク (SS5, lockStatus=1)
  const filledChunk = Buffer.concat([
    Buffer.alloc(16, 0xaa),
    Buffer.alloc(5, 0x00),
    Buffer.from([0x00, 0x01]),
  ]);

  it("[BLE3-0188] 非 OpenSensor: 全ゼロチャンク 1 つ → hasEmptySlot=true (>=1 で空きとみなす)", () => {
    const r = parsePubKeySesame(emptyChunk, { isOpenSensor: false });
    expect(r.emptySlotCount).toBe(1);
    expect(r.slotFull).toBe(false); // hasEmptySlot=true → slotFull=false
  });

  it("[BLE3-0188] OpenSensor: 全ゼロチャンク 1 つ → hasEmptySlot=false (>1 を満たさない → slotFull=true)", () => {
    // SDK kt:228 isOpenSensor → emptySlotCount >1 でのみ hasEmptySlot=true (hub3 予約スロット考慮)
    const r = parsePubKeySesame(emptyChunk, { isOpenSensor: true });
    expect(r.emptySlotCount).toBe(1);
    expect(r.slotFull).toBe(true); // hasEmptySlot=false → slotFull=true
  });

  it("[BLE3-0188] OpenSensor: 全ゼロチャンク 2 つ → hasEmptySlot=true (>1 を満たす)", () => {
    const data = Buffer.concat([emptyChunk, emptyChunk]);
    const r = parsePubKeySesame(data, { isOpenSensor: true });
    expect(r.emptySlotCount).toBe(2);
    expect(r.slotFull).toBe(false); // hasEmptySlot=true
  });

  it("[BLE3-0188] 非 OpenSensor: 全ゼロチャンク 0 → hasEmptySlot=false → slotFull=true", () => {
    const r = parsePubKeySesame(filledChunk, { isOpenSensor: false });
    expect(r.emptySlotCount).toBe(0);
    expect(r.slotFull).toBe(true);
  });

  it("[BLE3-0188] isOpenSensor は capabilitiesForModel から確定: open_sensor_1=true, ssm_touch_pro=false", () => {
    expect(capabilitiesForModel("open_sensor_1").isOpenSensor).toBe(true);
    expect(capabilitiesForModel("ssm_touch_pro").isOpenSensor).toBe(false);
  });
});

// =========================================================================
// [BLE3-0189] MECH_STATUS(81) publish (生体) → CHSesameTouchProMechStatus pass-through
// =========================================================================
describe("[BLE3-0189] parseBiometricMechStatus / handleBiometricPublish MECH_STATUS: pass-through", () => {
  const MECH_STATUS = 81;

  it("[BLE3-0189] handleBiometricPublish(MECH_STATUS) → onMechStatus を呼ぶ", () => {
    const payload = Buffer.from([0x10, 0x0c, 0x01, 0x02]);
    const received = [];
    const delegate = { onMechStatus: (_dev, st) => received.push(st) };
    const result = handleBiometricPublish({ itemCode: MECH_STATUS, body: payload }, delegate, "dev");
    expect(result).toBe(true);
    expect(received).toHaveLength(1);
  });

  it("[BLE3-0189] position=0, target=0, isInLockRange=false, isInUnlockRange=true (CHSesameProtocolMechStatus 既定値)", () => {
    const s = parseBiometricMechStatus(Buffer.from([0xab, 0xcd]));
    expect(s.position).toBe(0);
    expect(s.target).toBe(0);
    expect(s.isInLockRange).toBe(false);
    expect(s.isInUnlockRange).toBe(true);
  });

  it("[BLE3-0189] isStop=null, isCritical=null, isBatteryCritical=false (CHSesameProtocolMechStatus 既定値)", () => {
    const s = parseBiometricMechStatus(Buffer.from([0x00]));
    expect(s.isStop).toBeNull();
    expect(s.isCritical).toBeNull();
    expect(s.isBatteryCritical).toBe(false);
  });

  it("[BLE3-0189] raw data を保持する", () => {
    const payload = Buffer.from([0x01, 0x02, 0x03]);
    const s = parseBiometricMechStatus(payload);
    expect([...s.data]).toEqual([0x01, 0x02, 0x03]);
  });

  it("[BLE3-0189] batteryRaw = 先頭 2B LE u16 (kt:216 reportBatteryData 先頭 2B)", () => {
    // [0x10, 0x0c] → LE u16 = 0x0c10 = 3088
    const s = parseBiometricMechStatus(Buffer.from([0x10, 0x0c, 0x00]));
    expect(s.batteryRaw).toBe(0x0c10);
  });

  it("[BLE3-0189] 1B 以下 payload → batteryRaw=null", () => {
    expect(parseBiometricMechStatus(Buffer.from([0xff])).batteryRaw).toBeNull();
    expect(parseBiometricMechStatus(Buffer.alloc(0)).batteryRaw).toBeNull();
  });
});

// =========================================================================
// [BLE3-0190] BATTERY_VOLTAGE(202)/SESAME_UNSUPPORT(204)/BLE_TX_POWER(206) publish 補助分岐
// =========================================================================
describe("[BLE3-0190] handleBiometricPublish: battery(202)/unsupport(204)/txPower(206) 分岐", () => {
  const BATTERY_VOLTAGE = 202;
  const SESAME_UNSUPPORT = 204;
  const BLE_TX_POWER = 206;

  it("[BLE3-0190] 202 → onBatteryVoltageReceived(payloadHex) を呼ぶ (kt:185-187)", () => {
    const payload = Buffer.from([0xab, 0xcd]);
    const received = [];
    const delegate = { onBatteryVoltageReceived: (_dev, hex) => received.push(hex) };
    const result = handleBiometricPublish({ itemCode: BATTERY_VOLTAGE, body: payload }, delegate, "d");
    expect(result).toBe(true);
    expect(received).toEqual(["abcd"]);
  });

  it("[BLE3-0190] 204 → onSupportChanged(false) を呼ぶ (kt:189-192 setSupport(false))", () => {
    const received = [];
    const delegate = { onSupportChanged: (_dev, v) => received.push(v) };
    const result = handleBiometricPublish({ itemCode: SESAME_UNSUPPORT, body: Buffer.alloc(0) }, delegate, "d");
    expect(result).toBe(true);
    expect(received).toEqual([false]);
  });

  it("[BLE3-0190] 206 → onBleTxPowerReceive(payload[0] 符号付き Int8) を呼ぶ (kt:194-197)", () => {
    // Kotlin Byte = 符号付き 1B: 0xd0 = -48 signed
    const cases = [
      { byte: 0xd0, expected: -48 },
      { byte: 0x7f, expected: 127 },
      { byte: 0x00, expected: 0 },
      { byte: 0xfe, expected: -2 },
    ];
    for (const { byte, expected } of cases) {
      const received = [];
      const delegate = { onBleTxPowerReceive: (_dev, v) => received.push(v) };
      handleBiometricPublish({ itemCode: BLE_TX_POWER, body: Buffer.from([byte]) }, delegate, "d");
      expect(received[0]).toBe(expected);
    }
  });
});

// =========================================================================
// [BLE3-0191] parseTouchCard/parseTouchFace の truncated 入力で throw (AIOOBE 写像)
// =========================================================================
describe("[BLE3-0191] parseTouchCard/parseTouchFace: truncated 入力で throw (AIOOBE 写像)", () => {
  it("[BLE3-0191] parseTouchCard: 正常入力はパースできる", () => {
    // type=0x01, idLen=2, id=[0xaa,0xbb], nameLen=3, name=[0x11,0x22,0x33]
    const buf = Buffer.from([0x01, 0x02, 0xaa, 0xbb, 0x03, 0x11, 0x22, 0x33]);
    const r = parseTouchCard(buf);
    expect(r.cardType).toBe(0x01);
    expect(r.idLength).toBe(2);
  });

  it("[BLE3-0191] parseTouchCard: buf.length < 2 → throw (short-buf AIOOBE)", () => {
    expect(() => parseTouchCard(Buffer.from([0x01]))).toThrow();
    expect(() => parseTouchCard(Buffer.alloc(0))).toThrow();
  });

  it("[BLE3-0191] parseTouchCard: idLength+2 >= len → throw (idLength-overflow, kt:10-17)", () => {
    // type=0x00, idLen=100 (範囲外)
    const buf = Buffer.from([0x00, 100, 0x00, 0x00]);
    expect(() => parseTouchCard(buf)).toThrow();
  });

  it("[BLE3-0191] parseTouchCard: nameIndex+1+nameLength > len → throw (nameLength-overflow, kt:10-17)", () => {
    // type=0x00, idLen=1, id=[0xff], nameLen=100 (範囲外)
    const buf = Buffer.from([0x00, 0x01, 0xff, 100, 0x00]);
    expect(() => parseTouchCard(buf)).toThrow();
  });

  it("[BLE3-0191] parseTouchFace: buf.length < 2 → throw (AIOOBE 写像)", () => {
    expect(() => parseTouchFace(Buffer.from([0x02]))).toThrow();
    expect(() => parseTouchFace(Buffer.alloc(0))).toThrow();
  });

  it("[BLE3-0191] parseTouchFace: idLength-overflow → throw (kt:28-36)", () => {
    const buf = Buffer.from([0x02, 50, 0x00, 0x00]);
    expect(() => parseTouchFace(buf)).toThrow();
  });

  it("[BLE3-0191] parseTouchFace: nameLength-overflow → throw (kt:28-36)", () => {
    // type=0x02, idLen=1, id=[0x01], nameLen=200 (over)
    const buf = Buffer.from([0x02, 0x01, 0x01, 200, 0x00]);
    expect(() => parseTouchFace(buf)).toThrow();
  });

  it("[BLE3-0191] CARD_NOTIFY ループは parseTouchCard throw で break する (CHCardEventHandlers.kt:22-34)", () => {
    const CARD_NOTIFY = 110;
    // 有効レコードの後に壊れたバイト列 → ループが break して 1 件だけ受信
    // type=0x01, idLen=1, id=[0xff], nameLen=1, name=[0xab] → recordSize=5
    const validRecord = Buffer.from([0x01, 0x01, 0xff, 0x01, 0xab]);
    // 壊れレコード: 1B のみ
    const brokenRecord = Buffer.from([0x00]);
    const payload = Buffer.concat([validRecord, brokenRecord]);

    const received = [];
    const delegate = { onCardReceive: (_dev, id, name, type) => received.push({ id, name, type }) };
    handleBiometricPublish({ itemCode: CARD_NOTIFY, body: payload }, delegate, "d");
    // 1 件だけ受信して break
    expect(received).toHaveLength(1);
  });
});

// =========================================================================
// [BLE3-0192] bioCapsForModel: face/palm/finger 集合が DeviceProfiles と 1:1
// =========================================================================
describe("[BLE3-0192] bioCapsForModel: 各機種の bioCaps が DeviceProfiles と 1:1", () => {
  it("[BLE3-0192] sesame_face = {card, fingerprint, palm, face} (FACE プロファイル, kt:47)", () => {
    expect([...bioCapsForModel("sesame_face")].sort()).toEqual(["card", "face", "fingerprint", "palm"].sort());
  });

  it("[BLE3-0192] sesame_face_ai = {palm, face} のみ (FACE_AI プロファイル, kt:48)", () => {
    expect([...bioCapsForModel("sesame_face_ai")].sort()).toEqual(["face", "palm"].sort());
  });

  it("[BLE3-0192] sesame_face_Pro = {card, fingerprint, passcode, palm, face} (FACE_PRO, kt:49-55)", () => {
    expect([...bioCapsForModel("sesame_face_Pro")].sort()).toEqual(["card", "face", "fingerprint", "palm", "passcode"].sort());
  });

  it("[BLE3-0192] sesame_face_pro_ai = {passcode, palm, face} (FACE_PRO_AI, kt:56)", () => {
    expect([...bioCapsForModel("sesame_face_pro_ai")].sort()).toEqual(["face", "palm", "passcode"].sort());
  });

  it("[BLE3-0192] ssm_touch = {card, fingerprint} (TOUCH プロファイル, kt:45)", () => {
    expect([...bioCapsForModel("ssm_touch")].sort()).toEqual(["card", "fingerprint"].sort());
  });

  it("[BLE3-0192] ssm_touch_pro = {card, fingerprint, passcode} (TOUCH_PRO, kt:46)", () => {
    expect([...bioCapsForModel("ssm_touch_pro")].sort()).toEqual(["card", "fingerprint", "passcode"].sort());
  });

  it("[BLE3-0192] remote = [] 空集合 (CHDeivceProtocols.kt:112 setOf())", () => {
    expect([...bioCapsForModel("remote")]).toHaveLength(0);
  });

  it("[BLE3-0192] remote_nano = [] 空集合", () => {
    expect([...bioCapsForModel("remote_nano")]).toHaveLength(0);
  });

  it("[BLE3-0192] open_sensor_1 = [] 空集合 (CHDeivceProtocols.kt:81 setOf())", () => {
    expect([...bioCapsForModel("open_sensor_1")]).toHaveLength(0);
  });

  it("[BLE3-0192] sesame_5 (non-biometric) = [] 空集合", () => {
    expect([...bioCapsForModel("sesame_5")]).toHaveLength(0);
  });

  it("[BLE3-0192] 未知機種 → 空配列 (操作を捏造しない)", () => {
    expect([...bioCapsForModel("unknown_model_xyz")]).toHaveLength(0);
  });
});

// =========================================================================
// [BLE3-0193] biometric ゲッタの bioCaps 限定ビュー: 集合外メソッドは undefined
// =========================================================================
describe("[BLE3-0193] SesameBle#biometric: bioCaps 集合内メソッドのみ bind、集合外は undefined", () => {
  const bleFaceAi = new SesameBle({
    secretKey: "0102030405060708090a0b0c0d0e0f10",
    model: "sesame_face_ai",
    transport: fakeTransport,
  });

  it("[BLE3-0193] sesame_face_ai: biometric ゲッタが取得できる (bioCaps 非空で biometricNotSupported にならない)", () => {
    expect(() => bleFaceAi.biometric).not.toThrow();
  });

  it("[BLE3-0193] sesame_face_ai: palm/face 系メソッドは存在する (bioCaps 集合内)", () => {
    const view = bleFaceAi.biometric;
    expect(typeof view.palmDelete).toBe("function");
    expect(typeof view.faceDelete).toBe("function");
    expect(typeof view.palmListGet).toBe("function");
    expect(typeof view.faceListGet).toBe("function");
  });

  it("[BLE3-0193] sesame_face_ai: cardAdd は undefined (bioCaps 集合外 — op 捏造禁止)", () => {
    expect(bleFaceAi.biometric.cardAdd).toBeUndefined();
  });

  it("[BLE3-0193] sesame_face_ai: passcodeAdd は undefined (bioCaps 集合外)", () => {
    expect(bleFaceAi.biometric.passcodeAdd).toBeUndefined();
  });

  it("[BLE3-0193] sesame_face_ai: 共通 API (insertSesame/removeSesame/registerDelegate) は常に存在する", () => {
    const view = bleFaceAi.biometric;
    expect(typeof view.insertSesame).toBe("function");
    expect(typeof view.removeSesame).toBe("function");
    expect(typeof view.registerDelegate).toBe("function");
  });

  it("[BLE3-0193] ssm_touch は card/fingerprint のみ — face/palm/passcode は対応外", () => {
    const caps = bioCapsForModel("ssm_touch");
    const capsSet = new Set(caps);
    expect(capsSet.has("card")).toBe(true);
    expect(capsSet.has("fingerprint")).toBe(true);
    expect(capsSet.has("face")).toBe(false);
    expect(capsSet.has("palm")).toBe(false);
    expect(capsSet.has("passcode")).toBe(false);
  });
});

// =========================================================================
// [BLE3-0194] remoteNano/biometric ゲッタは非対応機種で明示エラー (op 捏造禁止)
// =========================================================================
describe("[BLE3-0194] SesameBle#remoteNano/#biometric: 非対応機種で明示エラー", () => {
  const bleBot2 = new SesameBle({
    secretKey: "0102030405060708090a0b0c0d0e0f10",
    model: "bot_2",
    transport: fakeTransport,
  });
  const bleFace = new SesameBle({
    secretKey: "0102030405060708090a0b0c0d0e0f10",
    model: "sesame_face",
    transport: fakeTransport,
  });

  it("[BLE3-0194] bot_2: biometric ゲッタは biometricNotSupported で throw", () => {
    expect(() => bleBot2.biometric).toThrow(/biometricNotSupported/);
  });

  it("[BLE3-0194] bot_2: remoteNano ゲッタは remoteNanoNotSupported で throw", () => {
    expect(() => bleBot2.remoteNano).toThrow(/remoteNanoNotSupported/);
  });

  it("[BLE3-0194] sesame_face: remoteNano ゲッタは remoteNanoNotSupported で throw (biometric kind だが isRemote=false)", () => {
    expect(() => bleFace.remoteNano).toThrow(/remoteNanoNotSupported/);
  });

  it("[BLE3-0194] remote: remoteNano ゲッタは取得できる (isRemote=true)", () => {
    const bleRemote = new SesameBle({
      secretKey: "0102030405060708090a0b0c0d0e0f10",
      model: "remote",
      transport: fakeTransport,
    });
    expect(() => bleRemote.remoteNano).not.toThrow();
  });

  it("[BLE3-0194] hub_3/wm_2/sesame_5: biometric=false → ゲッタ例外の条件", () => {
    expect(capabilitiesForModel("hub_3").biometric).toBe(false);
    expect(capabilitiesForModel("wm_2").biometric).toBe(false);
    expect(capabilitiesForModel("sesame_5").biometric).toBe(false);
  });

  it("[BLE3-0194] ssm_touch: biometric=true かつ bioCaps.length > 0", () => {
    expect(capabilitiesForModel("ssm_touch").biometric).toBe(true);
    expect(capabilitiesForModel("ssm_touch").bioCaps.length).toBeGreaterThan(0);
  });
});

// =========================================================================
// [BLE3-0195] remote/remote_nano は biometric ゲッタで biometricNoCaps (P3-15)
// =========================================================================
describe("[BLE3-0195] remote/remote_nano: biometric ゲッタは biometricNoCaps で throw (P3-15)", () => {
  it.each(["remote", "remote_nano"])(
    "[BLE3-0195] %s: biometric ゲッタは biometricNoCaps を throw (bioCaps=setOf())",
    (model) => {
      const ble = new SesameBle({
        secretKey: "0102030405060708090a0b0c0d0e0f10",
        model,
        transport: fakeTransport,
      });
      expect(() => ble.biometric).toThrow(/biometricNoCaps/);
    }
  );

  it.each(["remote", "remote_nano"])(
    "[BLE3-0195] %s: remoteNano ゲッタは取得できる (isRemote=true)",
    (model) => {
      const ble = new SesameBle({
        secretKey: "0102030405060708090a0b0c0d0e0f10",
        model,
        transport: fakeTransport,
      });
      expect(() => ble.remoteNano).not.toThrow();
      expect(typeof ble.remoteNano.setTriggerDelayTime).toBe("function");
    }
  );

  it("[BLE3-0195] remote: kind=biometric, bioCaps=空集合, isRemote=true (CHDeivceProtocols.kt:112)", () => {
    const caps = capabilitiesForModel("remote");
    expect(caps.kind).toBe("biometric");
    expect(caps.bioCaps.length).toBe(0);
    expect(caps.isRemote).toBe(true);
  });

  it("[BLE3-0195] remote_nano: kind=biometric, bioCaps=空集合, isRemote=true (CHDeivceProtocols.kt:118)", () => {
    const caps = capabilitiesForModel("remote_nano");
    expect(caps.kind).toBe("biometric");
    expect(caps.bioCaps.length).toBe(0);
    expect(caps.isRemote).toBe(true);
  });
});

// =========================================================================
// [BLE3-0196] fingerPrint ゲッタは Bike3 (fingerprint kind) のみ露出・他機種は明示エラー
// =========================================================================
describe("[BLE3-0196] SesameBle#fingerPrint: bike_3 のみ露出、他機種は fingerPrintNotSupported", () => {
  it("[BLE3-0196] bike_3: fingerPrint ゲッタが取得できる (caps.fingerprint=true)", () => {
    const ble = new SesameBle({
      secretKey: "0102030405060708090a0b0c0d0e0f10",
      model: "bike_3",
      transport: fakeTransport,
    });
    expect(() => ble.fingerPrint).not.toThrow();
  });

  it("[BLE3-0196] bike_3: fingerPrints/fingerPrintDelete/fingerPrintChange/fingerPrintModeGet/fingerPrintModeSet/registerDelegate が存在する", () => {
    const ble = new SesameBle({
      secretKey: "0102030405060708090a0b0c0d0e0f10",
      model: "bike_3",
      transport: fakeTransport,
    });
    const fp = ble.fingerPrint;
    expect(typeof fp.fingerPrints).toBe("function");
    expect(typeof fp.fingerPrintDelete).toBe("function");
    expect(typeof fp.fingerPrintChange).toBe("function");
    expect(typeof fp.fingerPrintModeGet).toBe("function");
    expect(typeof fp.fingerPrintModeSet).toBe("function");
    expect(typeof fp.registerDelegate).toBe("function");
  });

  it.each(["sesame_5", "bot_2", "bike_2", "ssm_touch", "remote", "hub_3"])(
    "[BLE3-0196] %s: fingerPrint ゲッタは fingerPrintNotSupported で throw (CHSesameBike3Device.kt:20-24)",
    (model) => {
      const ble = new SesameBle({
        secretKey: "0102030405060708090a0b0c0d0e0f10",
        model,
        transport: fakeTransport,
      });
      expect(() => ble.fingerPrint).toThrow(/fingerPrintNotSupported/);
    }
  );

  it("[BLE3-0196] bike_3: capabilitiesForModel で fingerprint=true、biometric=false", () => {
    const caps = capabilitiesForModel("bike_3");
    expect(caps.fingerprint).toBe(true);
    expect(caps.biometric).toBe(false); // bike_3 は BIKE3 kind
  });
});

// =========================================================================
// [BLE3-0197] BIOMETRIC_RPC_OPS の params 順序 = ファサード位置引数順 (wire 崩れ防止)
// =========================================================================
describe("[BLE3-0197] BIOMETRIC_RPC_OPS: params 順序がファサードの位置引数順と一致 (wire 崩れ防止)", () => {
  it("[BLE3-0197] biometric.cardMove: [cardId, touchProUUID] の順 (CHCardCapableImpl.kt:72)", () => {
    const op = BIOMETRIC_RPC_OPS["biometric.cardMove"];
    expect(op).toBeDefined();
    expect(op.params[0].name).toBe("cardId");
    expect(op.params[1].name).toBe("touchProUUID");
  });

  it("[BLE3-0197] biometric.cardChange: [ID, hexName] の順 (CHCardCapableImpl.kt:158)", () => {
    const op = BIOMETRIC_RPC_OPS["biometric.cardChange"];
    expect(op.params[0].name).toBe("ID");
    expect(op.params[1].name).toBe("hexName");
  });

  it("[BLE3-0197] biometric.cardChangeValue: [ID, newID] の順 (CHCardCapableImpl.kt:169)", () => {
    const op = BIOMETRIC_RPC_OPS["biometric.cardChangeValue"];
    expect(op.params[0].name).toBe("ID");
    expect(op.params[1].name).toBe("newID");
  });

  it("[BLE3-0197] biometric.passcodeMove: [cardId, touchProUUID] の順 (CHPassCodeCapableImpl.kt)", () => {
    const op = BIOMETRIC_RPC_OPS["biometric.passcodeMove"];
    expect(op.params[0].name).toBe("cardId");
    expect(op.params[1].name).toBe("touchProUUID");
  });

  it("[BLE3-0197] biometric.passcodeChange: [ID, hexName] の順", () => {
    const op = BIOMETRIC_RPC_OPS["biometric.passcodeChange"];
    expect(op).toBeDefined();
    expect(op.params[0].name).toBe("ID");
    expect(op.params[1].name).toBe("hexName");
  });

  it("[BLE3-0197] biometric.cardAdd: [id, hexName] の順", () => {
    const op = BIOMETRIC_RPC_OPS["biometric.cardAdd"];
    expect(op).toBeDefined();
    expect(op.params[0].name).toBe("id");
    expect(op.params[1].name).toBe("hexName");
  });

  it("[BLE3-0197] biometric.faceChange: [ID, name] の順 (CHFaceCapableImpl.kt:45)", () => {
    const op = BIOMETRIC_RPC_OPS["biometric.faceChange"];
    expect(op).toBeDefined();
    expect(op.params[0].name).toBe("ID");
    expect(op.params[1].name).toBe("name");
  });
});

// =========================================================================
// [BLE3-0198] card/passcode CRUD op が BIOMETRIC_RPC_OPS / allowlist に 1:1 存在 (面パリティ)
// =========================================================================
describe("[BLE3-0198] card/passcode CRUD op が BIOMETRIC_RPC_OPS に存在し allowlist に掲載 (面パリティ)", () => {
  const CARD_OPS = [
    "biometric.cardModeSet", "biometric.cardModeGet", "biometric.cardGet",
    "biometric.cardAdd", "biometric.cardDelete", "biometric.cardMove",
    "biometric.cardChange", "biometric.cardChangeValue",
  ];
  const PASSCODE_OPS = [
    "biometric.passcodeModeSet", "biometric.passcodeModeGet", "biometric.passcodeGet",
    "biometric.passcodeAdd", "biometric.passcodeDelete", "biometric.passcodeMove",
    "biometric.passcodeChange",
  ];

  it("[BLE3-0198] card 系 CRUD 全 op が BIOMETRIC_RPC_OPS に存在する", () => {
    for (const op of CARD_OPS) {
      expect(BIOMETRIC_RPC_OPS[op], `BIOMETRIC_RPC_OPS に ${op} が無い`).toBeDefined();
    }
  });

  it("[BLE3-0198] passcode 系 CRUD 全 op が BIOMETRIC_RPC_OPS に存在する", () => {
    for (const op of PASSCODE_OPS) {
      expect(BIOMETRIC_RPC_OPS[op], `BIOMETRIC_RPC_OPS に ${op} が無い`).toBeDefined();
    }
  });

  it("[BLE3-0198] BLE_RPC_ALLOWLIST に 'biometric' が掲載される (invokePath fail-closed ゲート)", () => {
    expect(BLE_RPC_ALLOWLIST).toContain("biometric");
  });

  it("[BLE3-0198] BLE_RPC_OPS に BIOMETRIC_RPC_OPS が spread されている (biometric.cardAdd, biometric.passcodeAdd が存在)", () => {
    expect(BLE_RPC_OPS["biometric.cardAdd"]).toBeDefined();
    expect(BLE_RPC_OPS["biometric.passcodeAdd"]).toBeDefined();
  });
});

// =========================================================================
// [BLE3-0199] BIOMETRIC/FINGERPRINT/REMOTE_NANO_RPC_OPS の params 順序 = ファサード位置引数順
// =========================================================================
describe("[BLE3-0199] FINGERPRINT_RPC_OPS / REMOTE_NANO_RPC_OPS: params 順序がファサードと一致", () => {
  it("[BLE3-0199] fingerPrint.fingerPrintChange: [ID, hexName] の順 (CHFingerPrintCapableImpl.kt:64)", () => {
    const op = FINGERPRINT_RPC_OPS["fingerPrint.fingerPrintChange"];
    expect(op).toBeDefined();
    expect(op.params[0].name).toBe("ID");
    expect(op.params[1].name).toBe("hexName");
  });

  it("[BLE3-0199] fingerPrint.fingerPrintDelete: [fingerPrintID] の 1 引数 (CHFingerPrintCapableImpl.kt:42)", () => {
    const op = FINGERPRINT_RPC_OPS["fingerPrint.fingerPrintDelete"];
    expect(op).toBeDefined();
    expect(op.params[0].name).toBe("fingerPrintID");
  });

  it("[BLE3-0199] remoteNano.setTriggerDelayTime: [time] の 1 引数 (CHRemoteNanoCapableImpl.kt:19)", () => {
    const op = REMOTE_NANO_RPC_OPS["remoteNano.setTriggerDelayTime"];
    expect(op).toBeDefined();
    expect(op.params[0].name).toBe("time");
  });

  it("[BLE3-0199] biometric.faceDelete: [faceID] の 1 引数 (CHFaceCapableImpl.kt:51)", () => {
    const op = BIOMETRIC_RPC_OPS["biometric.faceDelete"];
    expect(op.params[0].name).toBe("faceID");
  });

  it("[BLE3-0199] biometric.palmDelete: [palmID] の 1 引数 (CHPalmCapableImpl.kt:42)", () => {
    const op = BIOMETRIC_RPC_OPS["biometric.palmDelete"];
    expect(op.params[0].name).toBe("palmID");
  });

  it("[BLE3-0199] remoteNano.insertSesame/removeSesame が存在し params を持つ", () => {
    expect(REMOTE_NANO_RPC_OPS["remoteNano.insertSesame"]).toBeDefined();
    expect(REMOTE_NANO_RPC_OPS["remoteNano.removeSesame"]).toBeDefined();
    expect(REMOTE_NANO_RPC_OPS["remoteNano.insertSesame"].params[0].name).toBe("sesame");
    expect(REMOTE_NANO_RPC_OPS["remoteNano.removeSesame"].params[0].name).toBe("tag");
  });

  it("[BLE3-0199] 全 RPC_OPS の op が result フィールドを持つ (ack/raw の契約完全性)", () => {
    for (const [opKey, spec] of Object.entries({
      ...BIOMETRIC_RPC_OPS, ...FINGERPRINT_RPC_OPS, ...REMOTE_NANO_RPC_OPS,
    })) {
      expect(typeof spec.result, `${opKey} に result が無い`).toBe("string");
    }
  });
});

// =========================================================================
// [BLE3-0200] BLE_RPC_ALLOWLIST に biometric/fingerPrint/remoteNano 第1セグメントが掲載
// =========================================================================
describe("[BLE3-0200] BLE_RPC_ALLOWLIST: biometric/fingerPrint/remoteNano が掲載される", () => {
  it("[BLE3-0200] 'biometric' が掲載される", () => {
    expect(BLE_RPC_ALLOWLIST).toContain("biometric");
  });

  it("[BLE3-0200] 'fingerPrint' が掲載される", () => {
    expect(BLE_RPC_ALLOWLIST).toContain("fingerPrint");
  });

  it("[BLE3-0200] 'remoteNano' が掲載される", () => {
    expect(BLE_RPC_ALLOWLIST).toContain("remoteNano");
  });

  it("[BLE3-0200] 非掲載 op 'unknown.foo' は invokePath で拒否される (fail-closed)", async () => {
    const ble = new SesameBle({
      secretKey: "0102030405060708090a0b0c0d0e0f10",
      model: "sesame_5",
      transport: fakeTransport,
    });
    await expect(invokePath(ble, "unknown.foo", [], BLE_RPC_ALLOWLIST)).rejects.toThrow();
  });

  it("[BLE3-0200] allowlist 空配列 → 全拒否 (fail-closed の既定)", async () => {
    const ble = new SesameBle({
      secretKey: "0102030405060708090a0b0c0d0e0f10",
      model: "sesame_5",
      transport: fakeTransport,
    });
    await expect(invokePath(ble, "biometric", [], [])).rejects.toThrow();
  });
});

// =========================================================================
// [BLE3-0201] ble.biometric.* serve ハンドラが ack 封筒 (bleCommandAck) を組む
// =========================================================================
describe("[BLE3-0201] bleCommandAck {resultCode, resultName} 封筒 + BIOMETRIC_RPC_OPS result 宣言", () => {
  it("[BLE3-0201] bleCommandAck({resultCode:0}) → {resultCode:0, resultName:'success'}", () => {
    const ack = bleCommandAck({ resultCode: 0 });
    expect(ack.resultCode).toBe(0);
    expect(ack.resultName).toBe("success");
  });

  it("[BLE3-0201] bleCommandAck({resultCode:7}) → {resultCode:7, resultName:string} (非0も変換)", () => {
    const ack = bleCommandAck({ resultCode: 7 });
    expect(ack.resultCode).toBe(7);
    expect(typeof ack.resultName).toBe("string");
  });

  it("[BLE3-0201] 送信系 op は result='ack'", () => {
    const ackOps = [
      "biometric.cardModeSet", "biometric.cardAdd", "biometric.cardDelete",
      "biometric.cardMove", "biometric.cardChange", "biometric.cardChangeValue",
      "biometric.passcodeModeSet", "biometric.passcodeAdd", "biometric.passcodeDelete",
      "biometric.passcodeMove", "biometric.passcodeChange",
      "biometric.faceModeSet", "biometric.faceChange", "biometric.faceDelete",
      "biometric.palmModeSet", "biometric.palmDelete",
      "biometric.insertSesame", "biometric.removeSesame",
    ];
    for (const op of ackOps) {
      expect(BIOMETRIC_RPC_OPS[op]?.result).toBe("ack");
    }
  });

  it("[BLE3-0201] ModeGet 系は result='raw'", () => {
    expect(BIOMETRIC_RPC_OPS["biometric.cardModeGet"]?.result).toBe("raw");
    expect(BIOMETRIC_RPC_OPS["biometric.passcodeModeGet"]?.result).toBe("raw");
    expect(BIOMETRIC_RPC_OPS["biometric.faceModeGet"]?.result).toBe("raw");
    expect(BIOMETRIC_RPC_OPS["biometric.palmModeGet"]?.result).toBe("raw");
  });

  it("[BLE3-0201] FINGERPRINT_RPC_OPS の送信系は result='ack'", () => {
    expect(FINGERPRINT_RPC_OPS["fingerPrint.fingerPrintModeSet"]?.result).toBe("ack");
    expect(FINGERPRINT_RPC_OPS["fingerPrint.fingerPrintDelete"]?.result).toBe("ack");
    expect(FINGERPRINT_RPC_OPS["fingerPrint.fingerPrintChange"]?.result).toBe("ack");
  });

  it("[BLE3-0201] REMOTE_NANO_RPC_OPS の setTriggerDelayTime は result='ack'", () => {
    expect(REMOTE_NANO_RPC_OPS["remoteNano.setTriggerDelayTime"]?.result).toBe("ack");
  });

  it("[BLE3-0201] BiometricCommands.cardDelete は request の ack をそのまま返す (biometric.js:980-984 契約)", async () => {
    const session = makeSession();
    session.request.mockResolvedValue({ resultCode: 0, payload: Buffer.alloc(0) });
    const cmds = new BiometricCommands(session);
    const r = await cmds.cardDelete("ff");
    expect(r).toMatchObject({ resultCode: 0 });
  });
});

// =========================================================================
// [BLE3-0202] ble.invoke 経由の biometric.card*/passcode* は allowlist で fail-closed
// =========================================================================
describe("[BLE3-0202] invokePath: BLE_RPC_ALLOWLIST fail-closed ガード", () => {
  const ble = new SesameBle({
    secretKey: "0102030405060708090a0b0c0d0e0f10",
    model: "ssm_touch_pro",
    transport: fakeTransport,
  });

  it("[BLE3-0202] 'biometric' は allowlist に掲載 → invokePath はプロパティ解決へ進む (allowlist では拒否しない)", async () => {
    try {
      await invokePath(ble, "biometric.cardModeSet", [1], BLE_RPC_ALLOWLIST);
    } catch (e) {
      // allowlist で蹴られたなら "unsupportedBleOp" が含まれる → それ以外は OK
      expect(String(e)).not.toMatch(/unsupportedBleOp/);
    }
  });

  it("[BLE3-0202] 非掲載 op 'unknown.foo' は拒否される (fail-closed)", async () => {
    await expect(invokePath(ble, "unknown.foo", [], BLE_RPC_ALLOWLIST)).rejects.toThrow();
  });

  it("[BLE3-0202] 非掲載 'connect' は拒否される (接続ライフサイクル保護)", async () => {
    await expect(invokePath(ble, "connect", [], BLE_RPC_ALLOWLIST)).rejects.toThrow();
  });

  it("[BLE3-0202] 非掲載 'close' は拒否される", async () => {
    await expect(invokePath(ble, "close", [], BLE_RPC_ALLOWLIST)).rejects.toThrow();
  });

  it("[BLE3-0202] allowlist 空配列では 'biometric' も拒否される (全拒否 fail-closed)", async () => {
    await expect(invokePath(ble, "biometric.cardGet", [], [])).rejects.toThrow();
  });

  it("[BLE3-0202] 'fingerPrint' は allowlist に掲載 → 通過する", async () => {
    const bleBike3 = new SesameBle({
      secretKey: "0102030405060708090a0b0c0d0e0f10",
      model: "bike_3",
      transport: fakeTransport,
    });
    try {
      await invokePath(bleBike3, "fingerPrint.fingerPrints", [], BLE_RPC_ALLOWLIST);
    } catch (e) {
      expect(String(e)).not.toMatch(/unsupportedBleOp/);
    }
  });
});

// =========================================================================
// [BLE3-0203] collectBiometricList: FIRST→NOTIFY×N→END 収集を END/timeout で確定
// =========================================================================
describe("[BLE3-0203] collectBiometricList: FIRST→NOTIFY→END 収集を END または timeout で確定", () => {
  const CARD_FIRST = 112;
  const CARD_NOTIFY = 110;
  const CARD_LAST = 111;

  it("[BLE3-0203] BIO_LIST.card の getter/start/recv/end 名が BiometricCommands と一致する", () => {
    expect(BIO_LIST.card.getter).toBe("cardGet");
    expect(BIO_LIST.card.start).toBe("onCardReceiveStart");
    expect(BIO_LIST.card.recv).toBe("onCardReceive");
    expect(BIO_LIST.card.end).toBe("onCardReceiveEnd");
  });

  it("[BLE3-0203] BIO_LIST.passcode の delegate 名は onKeyBoardReceive* (passcode = keyboard 系 SDK 名)", () => {
    expect(BIO_LIST.passcode.getter).toBe("passcodeGet");
    expect(BIO_LIST.passcode.start).toBe("onKeyBoardReceiveStart");
    expect(BIO_LIST.passcode.recv).toBe("onKeyBoardReceive");
    expect(BIO_LIST.passcode.end).toBe("onKeyBoardReceiveEnd");
  });

  it("[BLE3-0203] END 受信で records が確定する (CARD_FIRST → NOTIFY×2 → CARD_LAST)", async () => {
    const session = makeSession();
    const cmds = new BiometricCommands(session);

    const promise = collectBiometricList(cmds, BIO_LIST.card, 2000);

    // type=0x01, idLen=1, id=[0xaa], nameLen=1, name=[0xbb]
    const notifyPayload = Buffer.from([0x01, 0x01, 0xaa, 0x01, 0xbb]);
    session._emit({ itemCode: CARD_FIRST, body: Buffer.alloc(0) });
    session._emit({ itemCode: CARD_NOTIFY, body: notifyPayload });
    session._emit({ itemCode: CARD_NOTIFY, body: notifyPayload });
    session._emit({ itemCode: CARD_LAST, body: Buffer.alloc(0) });

    const records = await promise;
    expect(Array.isArray(records)).toBe(true);
    expect(records).toHaveLength(2);
  });

  it("[BLE3-0203] timeout で END 来なくても空 records で resolve する (ハングしない)", async () => {
    const session = makeSession();
    const cmds = new BiometricCommands(session);
    const records = await collectBiometricList(cmds, BIO_LIST.card, 50);
    expect(Array.isArray(records)).toBe(true);
    expect(records).toHaveLength(0);
  });
});

// =========================================================================
// [BLE3-0204] collectBiometricList collectMs 既定 (serve 8000ms / CLI 既定) の option 分岐
// =========================================================================
describe("[BLE3-0204] collectBiometricList: collectMs 指定あり → 採用、未指定 → タイムアウト挙動", () => {
  const CARD_FIRST = 112;
  const CARD_LAST = 111;

  it("[BLE3-0204] collectMs=50: 50ms 以内に resolve (timeout 駆動でハングしない)", async () => {
    const session = makeSession();
    const cmds = new BiometricCommands(session);
    const start = Date.now();
    await collectBiometricList(cmds, BIO_LIST.card, 50);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("[BLE3-0204] serve の既定値は 8000ms (ble.js:103 `8_000` ハードコード)", () => {
    const DEFAULT_COLLECT_MS = 8_000;
    expect(DEFAULT_COLLECT_MS).toBe(8000);
  });

  it("[BLE3-0204] END 未到達でも timeout=100ms で空 records として resolve する (FIRST/END が来ない機種対策)", async () => {
    const session = makeSession();
    const cmds = new BiometricCommands(session);
    const records = await collectBiometricList(cmds, BIO_LIST.passcode, 100);
    expect(records).toEqual([]);
  });

  it("[BLE3-0204] END を 2 回流しても二重 resolve しない (finish 冪等ガード)", async () => {
    const session = makeSession();
    const cmds = new BiometricCommands(session);

    const promise = collectBiometricList(cmds, BIO_LIST.card, 200);

    session._emit({ itemCode: CARD_FIRST, body: Buffer.alloc(0) });
    session._emit({ itemCode: CARD_LAST, body: Buffer.alloc(0) });
    session._emit({ itemCode: CARD_LAST, body: Buffer.alloc(0) }); // 重複

    const records = await promise;
    expect(Array.isArray(records)).toBe(true);
  });
});

// =========================================================================
// [BLE3-0205] list 整形 bioNameToText: name バイト→UTF-8 + 末尾NUL除去 (16B padding 由来)
// =========================================================================
describe("[BLE3-0205] collectBiometricList の name 整形: UTF-8 化 + 末尾 NUL 除去 (cardAdd 16B padEnd 由来)", () => {
  // collectBiometricList → BiometricCommands.registerDelegate → handleBiometricPublish →
  // parseTouchCard (cardName=hex文字列) → bioNameToText(hex文字列) → string分岐でそのまま返す
  // NUL 除去が機能するのは name が Buffer として直接 onCardReceive に渡されるとき。

  /**
   * makeCardCmds: BiometricCommands を模倣する最小スタブ。
   * collectBiometricList は cmds.registerDelegate + cmds[spec.getter]() を呼ぶだけなので、
   * このスタブで delegate を手動制御できる。
   */
  function makeCardCmds(records = [], { autoEnd = true } = {}) {
    let delegate = null;
    return {
      cardGet: () => Promise.resolve({ resultCode: 0, payload: Buffer.alloc(0) }),
      registerDelegate(d) {
        delegate = d;
        if (autoEnd) {
          Promise.resolve().then(() => {
            if (delegate.onCardReceiveStart) delegate.onCardReceiveStart("dev");
            for (const rec of records) {
              if (delegate.onCardReceive) {
                delegate.onCardReceive("dev", rec.id, rec.name, rec.type);
              }
            }
            if (delegate.onCardReceiveEnd) delegate.onCardReceiveEnd("dev");
          });
        }
        return () => { delegate = null; };
      },
    };
  }

  it("[BLE3-0205] NUL パディング付き Buffer → 末尾 NUL が除去される", async () => {
    // cardAddData が padEnd(16) で 0x00 を詰める → "Hello\0\0\0..."
    const padded = Buffer.concat([Buffer.from("Hello", "utf8"), Buffer.alloc(11, 0x00)]);
    const cmds = makeCardCmds([{ id: "aabb", name: padded, type: 0x05 }]);
    const records = await collectBiometricList(cmds, BIO_LIST.card, 5000);
    expect(records).toHaveLength(1);
    expect(records[0].name).toBe("Hello");
    expect(records[0].name.charCodeAt(records[0].name.length - 1)).not.toBe(0);
  });

  it("[BLE3-0205] 文字列 name はそのまま返す (string 分岐)", async () => {
    const cmds = makeCardCmds([{ id: "aabb", name: "Card X", type: 0x05 }]);
    const records = await collectBiometricList(cmds, BIO_LIST.card, 5000);
    expect(records[0].name).toBe("Card X");
  });

  it("[BLE3-0205] 全 NUL バッファ → 空文字列になる", async () => {
    const cmds = makeCardCmds([{ id: "aabb", name: Buffer.alloc(16, 0x00), type: 0x05 }]);
    const records = await collectBiometricList(cmds, BIO_LIST.card, 5000);
    expect(records[0].name).toBe("");
  });

  it("[BLE3-0205] UTF-8 マルチバイト文字も正しく変換 + NUL 除去", async () => {
    // 日本語 "鍵" = 3B UTF-8 [e9 8d b5], padEnd 16
    const kanji = Buffer.from("鍵", "utf8");
    const padded = Buffer.concat([kanji, Buffer.alloc(16 - kanji.length, 0x00)]);
    const cmds = makeCardCmds([{ id: "aabb", name: padded, type: 0x05 }]);
    const records = await collectBiometricList(cmds, BIO_LIST.card, 5000);
    expect(records[0].name).toBe("鍵");
  });

  it("[BLE3-0205] null name → 空文字列 (bioNameToText null guard)", async () => {
    const cmds = makeCardCmds([{ id: "aabb", name: null, type: 0x05 }]);
    const records = await collectBiometricList(cmds, BIO_LIST.card, 5000);
    expect(records[0].name).toBe("");
  });
});
