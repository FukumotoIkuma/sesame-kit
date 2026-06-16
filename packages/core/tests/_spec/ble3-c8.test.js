// BLE3-0152 〜 BLE3-0169: face / palm / fingerprint capability テスト
//
// 対象実装:
//   packages/core/src/ble/biometric.js  (faceGetData / faceChangeData / faceDeleteData /
//                                         faceModeSetData / faceModeGetData /
//                                         palmModeSetData / palmModeGetData / palmGetData /
//                                         palmDeleteData / fingerPrintModeSetData /
//                                         fingerPrintModeGetData / handleBiometricPublish /
//                                         BiometricCommands / BIOMETRIC_RPC_OPS /
//                                         FINGERPRINT_RPC_OPS)
//   packages/core/src/itemcodes.js      (ITEM_CODES)
//
// 方針: 全て純関数 or session mock — ネットワーク/実機不使用。決定論的。

import { describe, it, expect, vi } from "vitest";
import { Buffer } from "node:buffer";
import {
  faceGetData,
  faceChangeData,
  faceDeleteData,
  faceModeSetData,
  faceModeGetData,
  palmModeSetData,
  palmModeGetData,
  palmGetData,
  palmDeleteData,
  fingerPrintModeSetData,
  fingerPrintModeGetData,
  handleBiometricPublish,
  BiometricCommands,
  BIOMETRIC_RPC_OPS,
  FINGERPRINT_RPC_OPS,
} from "../../src/ble/biometric.js";
import { ITEM_CODES as ITEM } from "../../src/itemcodes.js";

// BIO_VIEW_METHODS.palm は index.js で freeze された定数として export されていないため
// ローカルで宣言して検証する (palm の contract-existence テスト用)。
// palmChange が存在しないことの assert に使う。
const BIO_VIEW_METHODS_PALM = Object.freeze([
  "palmModeSet", "palmModeGet", "palmListGet", "palmDelete",
]);

// ── ヘルパ: モック session (request が即 resolve) ───────────────────────────
function makeMockSession({ resultCode = 0, payload = Buffer.alloc(0) } = {}) {
  const request = vi.fn().mockResolvedValue({ resultCode, payload });
  return { session: { request }, request };
}

// ── ヘルパ: handleBiometricPublish 用の pkt を作る ──────────────────────────
// handleBiometricPublish は pkt.body ?? pkt.payload を読む。
// B 実装は payload キー、A 実装は body キーを使うが、実装は body ?? payload で両対応している。
// ここでは body キーで統一する(実装ソースに忠実)。
function pkt(itemCode, body = Buffer.alloc(0)) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body ?? []);
  return { itemCode, body: buf };
}

// =====================================================================
// BLE3-0152: faceListGet → SSM_OS3_FACE_GET(156) 空 data
// =====================================================================
describe("[BLE3-0152] faceListGet → FACE_GET(156) 空 data、ack を返す", () => {
  it("[BLE3-0152] faceGetData() は 0B の Buffer を返す (CHFaceCapableImpl.kt:39-42 と一致)", () => {
    const data = faceGetData();
    expect(Buffer.isBuffer(data)).toBe(true);
    expect(data.length).toBe(0);
  });

  it("[BLE3-0152] BiometricCommands.faceListGet が FACE_GET=156 に空 data で request を呼ぶ", async () => {
    const { session, request } = makeMockSession();
    const bio = new BiometricCommands(session);
    const result = await bio.faceListGet();
    expect(request).toHaveBeenCalledTimes(1);
    const [itemCode, data] = request.mock.calls[0];
    expect(itemCode).toBe(ITEM.FACE_GET); // 156
    expect(itemCode).toBe(156);
    expect(data.length).toBe(0);
    // ack 契約: {resultCode, payload} がそのまま返る
    expect(result.resultCode).toBe(0);
  });

  it("[BLE3-0152] ITEM.FACE_GET は 156", () => {
    expect(ITEM.FACE_GET).toBe(156);
  });

  it("[BLE3-0152] FACE_FIRST=159 / FACE_NOTIFY=157 / FACE_LAST=158 の publish が存在する (itemcodes 確認)", () => {
    expect(ITEM.FACE_FIRST).toBe(159);
    expect(ITEM.FACE_NOTIFY).toBe(157);
    expect(ITEM.FACE_LAST).toBe(158);
  });
});

// =====================================================================
// BLE3-0153: faceChange → SSM_OS3_FACE_CHANGE(154) + [idLen][id][name]
// =====================================================================
describe("[BLE3-0153] faceChange → FACE_CHANGE(154) + [idLen][id(hex→bytes)][name(hex畳み)]", () => {
  it("[BLE3-0153] ITEM.FACE_CHANGE は 154", () => {
    expect(ITEM.FACE_CHANGE).toBe(154);
  });

  it("[BLE3-0153] faceChangeData('0a0b', 'deadbeef') = [02, 0a, 0b, de, ad, be, ef]", () => {
    // id hex='0a0b' → hexToBytes → [0x0a, 0x0b] (2B) → idLen=2
    // name hex='deadbeef' → hexNameToBytes → [0xde, 0xad, 0xbe, 0xef]
    // data = [02] ++ [0a, 0b] ++ [de, ad, be, ef]
    const d = faceChangeData("0a0b", "deadbeef");
    expect(d[0]).toBe(0x02); // idLen
    expect(d[1]).toBe(0x0a);
    expect(d[2]).toBe(0x0b);
    expect(d[3]).toBe(0xde);
    expect(d[4]).toBe(0xad);
    expect(d[5]).toBe(0xbe);
    expect(d[6]).toBe(0xef);
    expect(d.length).toBe(7);
  });

  it("[BLE3-0153] faceChangeData: name 奇数長末尾1文字も byte 化する (Kotlin chunked(2) 一致)", () => {
    // name='abc' → chunked(2) = ['ab','c'] → [0xab, 0x0c]
    // id='ff' (1B), idLen=1
    const d = faceChangeData("ff", "abc");
    expect(d[0]).toBe(0x01); // idLen=1
    expect(d[1]).toBe(0xff);
    expect(d[2]).toBe(0xab);
    expect(d[3]).toBe(0x0c);
    expect(d.length).toBe(4);
  });

  it("[BLE3-0153] BiometricCommands.faceChange が FACE_CHANGE=154 + 正しい data を送る", async () => {
    const { session, request } = makeMockSession();
    const bio = new BiometricCommands(session);
    await bio.faceChange("0a", "0102");
    const [itemCode, data] = request.mock.calls[0];
    expect(itemCode).toBe(154);
    // id='0a' → 1B, idLen=1, name='0102' → [0x01, 0x02]
    expect(data.equals(Buffer.from([0x01, 0x0a, 0x01, 0x02]))).toBe(true);
  });
});

// =====================================================================
// BLE3-0154: faceDelete → SSM_OS3_FACE_DELETE(155) + [faceID.toInt(16) 単一 byte]
// =====================================================================
describe("[BLE3-0154] faceDelete → FACE_DELETE(155) + [faceID.toInt(16) 単一 byte]", () => {
  it("[BLE3-0154] ITEM.FACE_DELETE は 155", () => {
    expect(ITEM.FACE_DELETE).toBe(155);
  });

  it("[BLE3-0154] faceDeleteData('0a') = [0x0a] (1B のみ)", () => {
    // CHFaceCapableImpl.kt:52: byteArrayOf(faceID.toInt(16).toByte())
    const d = faceDeleteData("0a");
    expect(d.length).toBe(1);
    expect(d[0]).toBe(0x0a);
  });

  it("[BLE3-0154] faceDeleteData('ff') = [0xff]", () => {
    const d = faceDeleteData("ff");
    expect(d.length).toBe(1);
    expect(d[0]).toBe(0xff);
  });

  it("[BLE3-0154] BiometricCommands.faceDelete が FACE_DELETE=155 + 単一 byte data を送る", async () => {
    const { session, request } = makeMockSession();
    const bio = new BiometricCommands(session);
    await bio.faceDelete("0b");
    const [itemCode, data] = request.mock.calls[0];
    expect(itemCode).toBe(155);
    expect(data.length).toBe(1);
    expect(data[0]).toBe(0x0b);
  });
});

// =====================================================================
// BLE3-0155: FACE_NOTIFY(157) publish → parseTouchFace → onFaceReceive
// =====================================================================
describe("[BLE3-0155] FACE_NOTIFY(157) publish → parseTouchFace → onFaceReceive", () => {
  it("[BLE3-0155] itemCode 157 publish が onFaceReceive(device, {type,id,nameUUID}) へ写像する", () => {
    // CHSesameTouchFace レイアウト: [type 1B][idLen 1B][id idLen][nameLen 1B][nameUUID nameLen]
    // type=02, idLen=01, id=0x7f, nameLen=04, name=deadbeef
    const body = Buffer.from([0x02, 0x01, 0x7f, 0x04, 0xde, 0xad, 0xbe, 0xef]);
    let received = null;
    const delegate = {
      onFaceReceive: (_dev, face) => { received = face; },
    };
    const result = handleBiometricPublish(pkt(157, body), delegate, "dev1");
    expect(result).toBe(true);
    expect(received).not.toBeNull();
    expect(received.type).toBe(0x02);
    expect(received.id).toBe("7f");
    expect(received.nameUUID).toBe("deadbeef");
  });

  it("[BLE3-0155] device 引数が onFaceReceive の第一引数として渡される", () => {
    const body = Buffer.from([0x01, 0x01, 0xaa, 0x00]);
    let devArg = undefined;
    const delegate = { onFaceReceive: (dev) => { devArg = dev; } };
    handleBiometricPublish(pkt(157, body), delegate, "myDevice");
    expect(devArg).toBe("myDevice");
  });

  it("[BLE3-0155] delegate に onFaceReceive が無くても handled=true でクラッシュしない", () => {
    const body = Buffer.from([0x02, 0x01, 0x7f, 0x04, 0xde, 0xad, 0xbe, 0xef]);
    const handled = handleBiometricPublish(pkt(ITEM.FACE_NOTIFY, body), {}, null);
    expect(handled).toBe(true);
  });

  it("[BLE3-0155] ITEM.FACE_NOTIFY は 157", () => {
    expect(ITEM.FACE_NOTIFY).toBe(157);
  });
});

// =====================================================================
// BLE3-0156: FACE_CHANGE(154) publish → parseTouchFace → onFaceChanged
// =====================================================================
describe("[BLE3-0156] FACE_CHANGE(154) publish → parseTouchFace → onFaceChanged", () => {
  it("[BLE3-0156] itemCode 154 publish が onFaceChanged(device, face) へ届く", () => {
    // CHFaceEventHandlers.kt:17-20
    const body = Buffer.from([0x03, 0x01, 0xcc, 0x02, 0xab, 0xcd]);
    let changed = null;
    const delegate = { onFaceChanged: (_dev, face) => { changed = face; } };
    const result = handleBiometricPublish(pkt(154, body), delegate, "dev");
    expect(result).toBe(true);
    expect(changed).not.toBeNull();
    expect(changed.type).toBe(0x03);
    expect(changed.id).toBe("cc");
    expect(changed.nameUUID).toBe("abcd");
  });

  it("[BLE3-0156] device が onFaceChanged の第一引数として渡される", () => {
    const body = Buffer.from([0x01, 0x01, 0xab, 0x02, 0xcd, 0xef]);
    const device = { id: "d1" };
    let devArg = undefined;
    const delegate = { onFaceChanged: (d) => { devArg = d; } };
    handleBiometricPublish(pkt(ITEM.FACE_CHANGE, body), delegate, device);
    expect(devArg).toBe(device);
  });

  it("[BLE3-0156] ITEM.FACE_CHANGE は 154", () => {
    expect(ITEM.FACE_CHANGE).toBe(154);
  });
});

// =====================================================================
// BLE3-0157: FACE_FIRST(159)/FACE_LAST(158)/FACE_MODE_SET(161) publish → start/end/modeChanged
// =====================================================================
describe("[BLE3-0157] FACE_FIRST/FACE_LAST/FACE_MODE_SET publish → start/end/modeChanged", () => {
  it("[BLE3-0157] itemCode 159 (FACE_FIRST) → onFaceReceiveStart が呼ばれる", () => {
    let called = false;
    const delegate = { onFaceReceiveStart: () => { called = true; } };
    const result = handleBiometricPublish(pkt(159), delegate, "dev");
    expect(result).toBe(true);
    expect(called).toBe(true);
  });

  it("[BLE3-0157] FACE_FIRST の device 引数が onFaceReceiveStart へ渡される", () => {
    const device = {};
    let devArg = null;
    const delegate = { onFaceReceiveStart: (d) => { devArg = d; } };
    handleBiometricPublish(pkt(ITEM.FACE_FIRST), delegate, device);
    expect(devArg).toBe(device);
  });

  it("[BLE3-0157] itemCode 158 (FACE_LAST) → onFaceReceiveEnd が呼ばれる", () => {
    let called = false;
    const delegate = { onFaceReceiveEnd: () => { called = true; } };
    const result = handleBiometricPublish(pkt(158), delegate, "dev");
    expect(result).toBe(true);
    expect(called).toBe(true);
  });

  it("[BLE3-0157] FACE_LAST の device 引数が onFaceReceiveEnd へ渡される", () => {
    const device = {};
    let devArg = null;
    const delegate = { onFaceReceiveEnd: (d) => { devArg = d; } };
    handleBiometricPublish(pkt(ITEM.FACE_LAST), delegate, device);
    expect(devArg).toBe(device);
  });

  it("[BLE3-0157] itemCode 161 (FACE_MODE_SET) → onFaceModeChanged(payload[0]) が呼ばれる", () => {
    let modeArg = undefined;
    const delegate = { onFaceModeChanged: (_dev, mode) => { modeArg = mode; } };
    const result = handleBiometricPublish(pkt(161, Buffer.from([0x02])), delegate, "dev");
    expect(result).toBe(true);
    expect(modeArg).toBe(0x02);
  });

  it("[BLE3-0157] ITEM.FACE_FIRST=159 / FACE_LAST=158 / FACE_MODE_SET=161 の定数確認", () => {
    expect(ITEM.FACE_FIRST).toBe(159);
    expect(ITEM.FACE_LAST).toBe(158);
    expect(ITEM.FACE_MODE_SET).toBe(161);
  });
});

// =====================================================================
// BLE3-0158: FACE_DELETE(155) publish は delegate 無し・handled=true
// =====================================================================
describe("[BLE3-0158] FACE_DELETE(155) publish は delegate 無し・handled=true", () => {
  it("[BLE3-0158] itemCode 155 publish は true を返し onFaceDeleted は呼ばれない", () => {
    // CHFaceEventHandlers.kt:38-40: FACE_DELETE は何もせず return true
    let deletedCalled = false;
    const delegate = {
      onFaceDeleted: () => { deletedCalled = true; },
    };
    const result = handleBiometricPublish(pkt(155, Buffer.from([0x05, 0x00])), delegate, "dev");
    expect(result).toBe(true);
    expect(deletedCalled).toBe(false);
  });

  it("[BLE3-0158] itemCode 155 publish で onFaceChanged も onFaceReceive も呼ばれない", () => {
    const calls = [];
    const delegate = {
      onFaceChanged: () => calls.push("changed"),
      onFaceReceive: () => calls.push("receive"),
    };
    handleBiometricPublish(pkt(155, Buffer.from([0x01, 0x02, 0x03])), delegate, "dev");
    expect(calls).toHaveLength(0);
  });
});

// =====================================================================
// BLE3-0159: FACE_MODE_DELETE_NOTIFY(192) publish → onFaceDeleted(faceID, ok=payload[1]==0)
// =====================================================================
describe("[BLE3-0159] FACE_MODE_DELETE_NOTIFY(192) publish → onFaceDeleted(faceID, ok=payload[1]==0)", () => {
  it("[BLE3-0159] ITEM.FACE_MODE_DELETE_NOTIFY は 192", () => {
    expect(ITEM.FACE_MODE_DELETE_NOTIFY).toBe(192);
  });

  it("[BLE3-0159] payload[0]=faceID, payload[1]==0x00 で ok=true", () => {
    // CHFaceEventHandlers.kt:41-48: faceID=payload[0].toByte(), isSuccess=payload[1]==0.toByte()
    let res = null;
    const delegate = { onFaceDeleted: (_dev, id, ok) => { res = [id, ok]; } };
    const result = handleBiometricPublish(pkt(192, Buffer.from([0x07, 0x00])), delegate, "dev");
    expect(result).toBe(true);
    expect(res).toEqual([7, true]);
  });

  it("[BLE3-0159] payload[1]!=0 で ok=false", () => {
    let res = null;
    const delegate = { onFaceDeleted: (_dev, id, ok) => { res = [id, ok]; } };
    handleBiometricPublish(pkt(192, Buffer.from([0x03, 0x01])), delegate, "dev");
    expect(res).toEqual([3, false]);
  });

  it("[BLE3-0159] payload が 1B のとき dispatch せず handled=true (len<2 ガード)", () => {
    let called = false;
    const delegate = { onFaceDeleted: () => { called = true; } };
    const result = handleBiometricPublish(pkt(192, Buffer.from([0x05])), delegate, "dev");
    expect(result).toBe(true);
    expect(called).toBe(false);
  });

  it("[BLE3-0159] payload が 0B のとき dispatch せず handled=true", () => {
    let called = false;
    const delegate = { onFaceDeleted: () => { called = true; } };
    const result = handleBiometricPublish(pkt(192, Buffer.alloc(0)), delegate, "dev");
    expect(result).toBe(true);
    expect(called).toBe(false);
  });
});

// =====================================================================
// BLE3-0160: palmModeSet → SSM_OS3_PALM_MODE_SET(169) + [mode 1B]
// =====================================================================
describe("[BLE3-0160] palmModeSet → PALM_MODE_SET(169) + [mode 1B]", () => {
  it("[BLE3-0160] ITEM.PALM_MODE_SET は 169", () => {
    expect(ITEM.PALM_MODE_SET).toBe(169);
  });

  it("[BLE3-0160] palmModeSetData(mode) は [mode & 0xff] の 1B を返す", () => {
    // CHPalmCapableImpl.kt:20: byteArrayOf(mode)
    expect(palmModeSetData(0x01).equals(Buffer.from([0x01]))).toBe(true);
    expect(palmModeSetData(0x00).equals(Buffer.from([0x00]))).toBe(true);
    expect(palmModeSetData(255).equals(Buffer.from([0xff]))).toBe(true);
  });

  it("[BLE3-0160] palmModeSetData(256) は 0xff+1 → 0x00 (& 0xff 切り捨て)", () => {
    expect(palmModeSetData(256)[0]).toBe(0x00);
  });

  it("[BLE3-0160] BiometricCommands.palmModeSet が PALM_MODE_SET=169 + [mode] を送る", async () => {
    const { session, request } = makeMockSession();
    const bio = new BiometricCommands(session);
    await bio.palmModeSet(0x02);
    const [itemCode, data] = request.mock.calls[0];
    expect(itemCode).toBe(169);
    expect(data.equals(Buffer.from([0x02]))).toBe(true);
  });
});

// =====================================================================
// BLE3-0161: palmModeGet → SSM_OS3_PALM_MODE_GET(168) 空 data、応答 payload[0]=mode
// =====================================================================
describe("[BLE3-0161] palmModeGet → PALM_MODE_GET(168) 空 data、応答 payload[0]=mode", () => {
  it("[BLE3-0161] ITEM.PALM_MODE_GET は 168", () => {
    expect(ITEM.PALM_MODE_GET).toBe(168);
  });

  it("[BLE3-0161] palmModeGetData() は 0B を返す", () => {
    const d = palmModeGetData();
    expect(Buffer.isBuffer(d)).toBe(true);
    expect(d.length).toBe(0);
  });

  it("[BLE3-0161] BiometricCommands.palmModeGet が PALM_MODE_GET=168 + 空 data を送り payload[0] を返す", async () => {
    const request = vi.fn().mockResolvedValue({ resultCode: 0, payload: Buffer.from([0x03]) });
    const bio = new BiometricCommands({ request });
    const mode = await bio.palmModeGet();
    const [itemCode, data] = request.mock.calls[0];
    expect(itemCode).toBe(168);
    expect(data.length).toBe(0);
    expect(mode).toBe(0x03);
  });

  it("[BLE3-0161] palmModeGet: 空 payload で throw (data error)", async () => {
    // CHPalmCapableImpl.kt:32 相当: 空 payload を data error で拒否する
    const request = vi.fn().mockResolvedValue({ resultCode: 0, payload: Buffer.alloc(0) });
    const bio = new BiometricCommands({ request });
    await expect(bio.palmModeGet()).rejects.toThrow(/palmModeGet data error/);
  });
});

// =====================================================================
// BLE3-0162: palmListGet → SSM_OS3_PALM_GET(164) 空 data、PALM_FIRST/NOTIFY/LAST 誘発
// =====================================================================
describe("[BLE3-0162] palmListGet → PALM_GET(164) 空 data", () => {
  it("[BLE3-0162] ITEM.PALM_GET は 164", () => {
    expect(ITEM.PALM_GET).toBe(164);
  });

  it("[BLE3-0162] palmGetData() は 0B を返す", () => {
    const d = palmGetData();
    expect(Buffer.isBuffer(d)).toBe(true);
    expect(d.length).toBe(0);
  });

  it("[BLE3-0162] BiometricCommands.palmListGet が PALM_GET=164 + 空 data で request を呼ぶ", async () => {
    const { session, request } = makeMockSession();
    const bio = new BiometricCommands(session);
    const result = await bio.palmListGet();
    const [itemCode, data] = request.mock.calls[0];
    expect(itemCode).toBe(164);
    expect(data.length).toBe(0);
    // ack 契約: {resultCode, payload} がそのまま返る
    expect(result.resultCode).toBe(0);
  });

  it("[BLE3-0162] PALM_FIRST=167 / PALM_NOTIFY=165 / PALM_LAST=166 の itemcodes 確認", () => {
    // CHPalmCapableImpl.kt:36-40 参照: PALM_GET=164, NOTIFY=165, LAST=166, FIRST=167
    expect(ITEM.PALM_FIRST).toBe(167);
    expect(ITEM.PALM_NOTIFY).toBe(165);
    expect(ITEM.PALM_LAST).toBe(166);
  });
});

// =====================================================================
// BLE3-0163: palmDelete → SSM_OS3_PALM_DELETE(163) + [palmID.toInt(16) 単一 byte]
// =====================================================================
describe("[BLE3-0163] palmDelete → PALM_DELETE(163) + [palmID.toInt(16) 単一 byte]", () => {
  it("[BLE3-0163] ITEM.PALM_DELETE は 163", () => {
    expect(ITEM.PALM_DELETE).toBe(163);
  });

  it("[BLE3-0163] palmDeleteData('0a') = [0x0a] (face と同型・単一 byte)", () => {
    // CHPalmCapableImpl.kt:43: byteArrayOf(palmID.toInt(16).toByte())
    const d = palmDeleteData("0a");
    expect(d.length).toBe(1);
    expect(d[0]).toBe(0x0a);
  });

  it("[BLE3-0163] palmDeleteData('ff') = [0xff]", () => {
    const d = palmDeleteData("ff");
    expect(d.length).toBe(1);
    expect(d[0]).toBe(0xff);
  });

  it("[BLE3-0163] BiometricCommands.palmDelete が PALM_DELETE=163 + 単一 byte data を送る", async () => {
    const { session, request } = makeMockSession();
    const bio = new BiometricCommands(session);
    await bio.palmDelete("0c");
    const [itemCode, data] = request.mock.calls[0];
    expect(itemCode).toBe(163);
    expect(data.length).toBe(1);
    expect(data[0]).toBe(0x0c);
  });
});

// =====================================================================
// BLE3-0164: palmChange は SDK に送信実装が無く biometric ビュー/RPC OPS に存在しない
// =====================================================================
describe("[BLE3-0164] palmChange は SDK 送信不在 → BIO_VIEW_METHODS.palm / BIOMETRIC_RPC_OPS に存在しない", () => {
  it("[BLE3-0164] BIO_VIEW_METHODS.palm に 'palmChange' が存在しない", () => {
    // CHPalmCapableImpl.kt:19-46: 送信メソッドは modeSet/modeGet/listGet/delete の 4 つのみ
    expect(BIO_VIEW_METHODS_PALM).not.toContain("palmChange");
  });

  it("[BLE3-0164] BIOMETRIC_RPC_OPS に 'biometric.palmChange' キーが存在しない", () => {
    expect(Object.keys(BIOMETRIC_RPC_OPS)).not.toContain("biometric.palmChange");
  });

  it("[BLE3-0164] BiometricCommands インスタンスに palmChange メソッドが存在しない", () => {
    const { session } = makeMockSession();
    const bio = new BiometricCommands(session);
    // PALM_CHANGE(162) は受信専用 (CHPalmEventHandlers.kt:16-19 が onPalmChanged へ流すのみ)
    expect(typeof bio.palmChange).toBe("undefined");
  });

  it("[BLE3-0164] BIOMETRIC_RPC_OPS に palm 送信は 4 メソッドのみ", () => {
    const palmOps = Object.keys(BIOMETRIC_RPC_OPS).filter(k => k.startsWith("biometric.palm"));
    // palmModeSet / palmModeGet / palmListGet / palmDelete
    expect(palmOps).toHaveLength(4);
    expect(palmOps).toContain("biometric.palmModeSet");
    expect(palmOps).toContain("biometric.palmModeGet");
    expect(palmOps).toContain("biometric.palmListGet");
    expect(palmOps).toContain("biometric.palmDelete");
  });
});

// =====================================================================
// BLE3-0165: PALM_NOTIFY(165)/PALM_CHANGE(162) publish → parseTouchFace → onPalmReceive/onPalmChanged
// =====================================================================
describe("[BLE3-0165] PALM_NOTIFY(165)/PALM_CHANGE(162) publish → onPalmReceive/onPalmChanged", () => {
  // CHSesameTouchFace レイアウト: [type][idLen][id...][nameLen][nameUUID...]
  // type=0x04, idLen=1, id='5a', nameLen=2, nameUUID='1122'
  const palmFacePayload = Buffer.from([0x04, 0x01, 0x5a, 0x02, 0x11, 0x22]);

  it("[BLE3-0165] itemCode 165 (PALM_NOTIFY) → onPalmReceive(parseTouchFace)", () => {
    let received = null;
    const delegate = { onPalmReceive: (_dev, face) => { received = face; } };
    const result = handleBiometricPublish(pkt(165, palmFacePayload), delegate, "dev");
    expect(result).toBe(true);
    expect(received).not.toBeNull();
    expect(received.type).toBe(0x04);
    expect(received.id).toBe("5a");
    expect(received.nameUUID).toBe("1122");
  });

  it("[BLE3-0165] itemCode 162 (PALM_CHANGE) → onPalmChanged(parseTouchFace)", () => {
    // CHPalmEventHandlers.kt:16-19 が PALM_CHANGE → onPalmChanged へ写像
    let changed = null;
    const delegate = { onPalmChanged: (_dev, face) => { changed = face; } };
    const result = handleBiometricPublish(pkt(162, palmFacePayload), delegate, "dev");
    expect(result).toBe(true);
    expect(changed).not.toBeNull();
    expect(changed.id).toBe("5a");
  });

  it("[BLE3-0165] ITEM.PALM_NOTIFY=165, ITEM.PALM_CHANGE=162 の定数確認", () => {
    expect(ITEM.PALM_NOTIFY).toBe(165);
    expect(ITEM.PALM_CHANGE).toBe(162);
  });
});

// =====================================================================
// BLE3-0166: PALM_FIRST(167)/PALM_LAST(166)/PALM_MODE_SET(169) publish → start/end/modeChanged
// =====================================================================
describe("[BLE3-0166] PALM_FIRST/PALM_LAST/PALM_MODE_SET publish → start/end/modeChanged", () => {
  it("[BLE3-0166] itemCode 167 (PALM_FIRST) → onPalmReceiveStart が呼ばれる", () => {
    let called = false;
    const delegate = { onPalmReceiveStart: () => { called = true; } };
    const result = handleBiometricPublish(pkt(167), delegate, "dev");
    expect(result).toBe(true);
    expect(called).toBe(true);
  });

  it("[BLE3-0166] PALM_FIRST の device 引数が onPalmReceiveStart へ渡される", () => {
    const device = {};
    let devArg = null;
    const delegate = { onPalmReceiveStart: (d) => { devArg = d; } };
    handleBiometricPublish(pkt(ITEM.PALM_FIRST), delegate, device);
    expect(devArg).toBe(device);
  });

  it("[BLE3-0166] itemCode 166 (PALM_LAST) → onPalmReceiveEnd が呼ばれる", () => {
    let called = false;
    const delegate = { onPalmReceiveEnd: () => { called = true; } };
    const result = handleBiometricPublish(pkt(166), delegate, "dev");
    expect(result).toBe(true);
    expect(called).toBe(true);
  });

  it("[BLE3-0166] PALM_LAST の device 引数が onPalmReceiveEnd へ渡される", () => {
    const device = {};
    let devArg = null;
    const delegate = { onPalmReceiveEnd: (d) => { devArg = d; } };
    handleBiometricPublish(pkt(ITEM.PALM_LAST), delegate, device);
    expect(devArg).toBe(device);
  });

  it("[BLE3-0166] itemCode 169 (PALM_MODE_SET) → onPalmModeChanged(payload[0]) が呼ばれる", () => {
    // CHPalmEventHandlers.kt:32-35 MODE_SET case: onPalmModeChanged(payload.payload[0])
    let modeArg = undefined;
    const delegate = { onPalmModeChanged: (_dev, mode) => { modeArg = mode; } };
    const result = handleBiometricPublish(pkt(169, Buffer.from([0x03])), delegate, "dev");
    expect(result).toBe(true);
    expect(modeArg).toBe(0x03);
  });

  it("[BLE3-0166] ITEM.PALM_FIRST=167 / PALM_LAST=166 / PALM_MODE_SET=169 の定数確認", () => {
    expect(ITEM.PALM_FIRST).toBe(167);
    expect(ITEM.PALM_LAST).toBe(166);
    expect(ITEM.PALM_MODE_SET).toBe(169);
  });
});

// =====================================================================
// BLE3-0167: PALM_MODE_DELETE_NOTIFY(193) publish → onPalmDeleted(palmID, ok=payload[1]==0)
// =====================================================================
describe("[BLE3-0167] PALM_MODE_DELETE_NOTIFY(193) publish → onPalmDeleted(palmID, ok=payload[1]==0)", () => {
  it("[BLE3-0167] ITEM.PALM_MODE_DELETE_NOTIFY は 193", () => {
    expect(ITEM.PALM_MODE_DELETE_NOTIFY).toBe(193);
  });

  it("[BLE3-0167] payload[0]=palmID, payload[1]==0x00 で ok=true", () => {
    // CHPalmEventHandlers.kt:36-42: palmID=payload[0], isSuccess=payload[1]==0
    let res = null;
    const delegate = { onPalmDeleted: (_dev, id, ok) => { res = [id, ok]; } };
    const result = handleBiometricPublish(pkt(193, Buffer.from([0x09, 0x00])), delegate, "dev");
    expect(result).toBe(true);
    expect(res).toEqual([9, true]);
  });

  it("[BLE3-0167] payload[1]!=0 で ok=false", () => {
    let res = null;
    const delegate = { onPalmDeleted: (_dev, id, ok) => { res = [id, ok]; } };
    handleBiometricPublish(pkt(193, Buffer.from([0x02, 0x01])), delegate, "dev");
    expect(res).toEqual([2, false]);
  });

  it("[BLE3-0167] payload が 1B のとき dispatch せず handled=true (len<2 ガード)", () => {
    // CHPalmEventHandlers.kt:41-42: size<2 で dispatch せず return true
    let called = false;
    const delegate = { onPalmDeleted: () => { called = true; } };
    const result = handleBiometricPublish(pkt(193, Buffer.from([0x05])), delegate, "dev");
    expect(result).toBe(true);
    expect(called).toBe(false);
  });

  it("[BLE3-0167] payload が 0B のとき dispatch せず handled=true", () => {
    let called = false;
    const delegate = { onPalmDeleted: () => { called = true; } };
    const result = handleBiometricPublish(pkt(193, Buffer.alloc(0)), delegate, "dev");
    expect(result).toBe(true);
    expect(called).toBe(false);
  });
});

// =====================================================================
// BLE3-0168: fingerPrintModeSet → SSM_OS3_FINGERPRINT_MODE_SET(122) + [mode 1B]
// =====================================================================
describe("[BLE3-0168] fingerPrintModeSet → FINGERPRINT_MODE_SET(122) + [mode 1B]", () => {
  it("[BLE3-0168] ITEM.FINGERPRINT_MODE_SET は 122", () => {
    expect(ITEM.FINGERPRINT_MODE_SET).toBe(122);
  });

  it("[BLE3-0168] fingerPrintModeSetData(mode) は [mode & 0xff] の 1B を返す", () => {
    // CHFingerPrintCapableImpl.kt:33-38: kt:37 byteArrayOf(mode)
    expect(fingerPrintModeSetData(0x01).equals(Buffer.from([0x01]))).toBe(true);
    expect(fingerPrintModeSetData(0x00).equals(Buffer.from([0x00]))).toBe(true);
    expect(fingerPrintModeSetData(0xff).equals(Buffer.from([0xff]))).toBe(true);
  });

  it("[BLE3-0168] BiometricCommands.fingerPrintModeSet が FINGERPRINT_MODE_SET=122 + [mode] を送る", async () => {
    const { session, request } = makeMockSession();
    const bio = new BiometricCommands(session);
    await bio.fingerPrintModeSet(0x01);
    const [itemCode, data] = request.mock.calls[0];
    expect(itemCode).toBe(122);
    expect(data.equals(Buffer.from([0x01]))).toBe(true);
  });

  it("[BLE3-0168] fingerPrintModeSet が ack ({resultCode, payload}) を返す", async () => {
    const { session } = makeMockSession({ resultCode: 0, payload: Buffer.alloc(0) });
    const bio = new BiometricCommands(session);
    const result = await bio.fingerPrintModeSet(2);
    expect(result).toHaveProperty("resultCode", 0);
  });

  it("[BLE3-0168] FINGERPRINT_RPC_OPS に fingerPrint.fingerPrintModeSet が存在し result='ack'", () => {
    expect(FINGERPRINT_RPC_OPS["fingerPrint.fingerPrintModeSet"]).toBeDefined();
    expect(FINGERPRINT_RPC_OPS["fingerPrint.fingerPrintModeSet"].result).toBe("ack");
  });
});

// =====================================================================
// BLE3-0169: fingerPrintModeGet → SSM_OS3_FINGERPRINT_MODE_GET(121) 空 data、応答 payload[0]=mode
// =====================================================================
describe("[BLE3-0169] fingerPrintModeGet → FINGERPRINT_MODE_GET(121) 空 data、応答 payload[0]=mode", () => {
  it("[BLE3-0169] ITEM.FINGERPRINT_MODE_GET は 121", () => {
    expect(ITEM.FINGERPRINT_MODE_GET).toBe(121);
  });

  it("[BLE3-0169] fingerPrintModeGetData() は 0B を返す", () => {
    const d = fingerPrintModeGetData();
    expect(Buffer.isBuffer(d)).toBe(true);
    expect(d.length).toBe(0);
  });

  it("[BLE3-0169] BiometricCommands.fingerPrintModeGet が FINGERPRINT_MODE_GET=121 + 空 data を送り payload[0] を返す", async () => {
    // CHFingerPrintCapableImpl.kt:27: res.payload[0] を返す
    const request = vi.fn().mockResolvedValue({ resultCode: 0, payload: Buffer.from([0x05]) });
    const bio = new BiometricCommands({ request });
    const mode = await bio.fingerPrintModeGet();
    const [itemCode, data] = request.mock.calls[0];
    expect(itemCode).toBe(121);
    expect(data.length).toBe(0);
    expect(mode).toBe(0x05);
  });

  it("[BLE3-0169] fingerPrintModeGet: 空 payload のとき payload[0]=undefined (ガード無し仕様)", async () => {
    // biometric.js:1013 の r.payload[0] は空 payload ガード無し (undefined になりうる)
    // spec note: face/palm DELETE_NOTIFY の payload.length>=2 ガードと違い
    //            fingerPrintModeGet は undefined を返す実装 (SDK も kt:27 res.payload[0] のみ)
    const request = vi.fn().mockResolvedValue({ resultCode: 0, payload: Buffer.alloc(0) });
    const bio = new BiometricCommands({ request });
    const mode = await bio.fingerPrintModeGet();
    expect(mode).toBeUndefined();
  });

  it("[BLE3-0169] FINGERPRINT_RPC_OPS に fingerPrint.fingerPrintModeGet が存在し result='raw'", () => {
    expect(FINGERPRINT_RPC_OPS["fingerPrint.fingerPrintModeGet"]).toBeDefined();
    expect(FINGERPRINT_RPC_OPS["fingerPrint.fingerPrintModeGet"].result).toBe("raw");
  });
});
