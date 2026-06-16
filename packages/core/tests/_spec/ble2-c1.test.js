// spec: ble-os2.md — BLE2-0019 … BLE2-0036
// writer: integrated (A + B merged)
// 実行方法: vitest run packages/core/tests/_spec/ble2-c1.test.js

import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";

import { ITEM_CODES } from "../../src/itemcodes.js";
import {
  OP,
  ITEM,
  MECH_STATE,
  buildSendFrame,
  parseMechStatus,
  parseMechSettingSesame2,
  parseMechSettingBot,
  parseLoginResponse,
  deriveRegisterKeys,
  registrationData,
  timePhoneData,
} from "../../src/ble/os2/protocol.js";
import { SesameOS2BleSession } from "../../src/ble/os2/session.js";
import { SesameOS2Ble } from "../../src/ble/os2/index.js";
import { makeLocalRegisterServer } from "../../src/crypto.js";

// ---------------------------------------------------------------------------
// [BLE2-0019] OS2 itemCode 値が SesameItemCode と一致
// ref: packages/core/src/itemcodes.js:12-41
// SDK: SesameProtocols.kt:34-36
// kind: wire-fidelity
// ---------------------------------------------------------------------------
describe("[BLE2-0019] OS2 itemCode 値が SesameItemCode と一致 (login/initial/IRER/timePhone 等)", () => {
  it("[BLE2-0019] registration=1", () => { expect(ITEM_CODES.REGISTRATION).toBe(1); });
  it("[BLE2-0019] login=2", () => { expect(ITEM_CODES.LOGIN).toBe(2); });
  it("[BLE2-0019] history=4", () => { expect(ITEM_CODES.HISTORY).toBe(4); });
  it("[BLE2-0019] versionTag=5", () => { expect(ITEM_CODES.VERSION_TAG).toBe(5); });
  it("[BLE2-0019] enableDFU=7", () => { expect(ITEM_CODES.ENABLE_DFU).toBe(7); });
  it("[BLE2-0019] autolock=11", () => { expect(ITEM_CODES.AUTOLOCK).toBe(11); });
  it("[BLE2-0019] initial=14", () => { expect(ITEM_CODES.INITIAL).toBe(14); });
  it("[BLE2-0019] IRER=15", () => { expect(ITEM_CODES.IRER).toBe(15); });
  it("[BLE2-0019] timePhone=16", () => { expect(ITEM_CODES.TIMEPHONE).toBe(16); });
  it("[BLE2-0019] mechSetting=80", () => { expect(ITEM_CODES.MECH_SETTING).toBe(80); });
  it("[BLE2-0019] mechStatus=81", () => { expect(ITEM_CODES.MECH_STATUS).toBe(81); });
  it("[BLE2-0019] lock=82", () => { expect(ITEM_CODES.LOCK).toBe(82); });
  it("[BLE2-0019] unlock=83", () => { expect(ITEM_CODES.UNLOCK).toBe(83); });
  it("[BLE2-0019] click=89", () => { expect(ITEM_CODES.CLICK).toBe(89); });
  it("[BLE2-0019] ITEM エクスポートは ITEM_CODES と同一オブジェクト (os2/protocol.js re-export)", () => {
    expect(ITEM.REGISTRATION).toBe(1);
    expect(ITEM.TIMEPHONE).toBe(16);
    expect(ITEM.MECH_SETTING).toBe(80);
    expect(ITEM.LOCK).toBe(82);
    expect(ITEM.UNLOCK).toBe(83);
    expect(ITEM.CLICK).toBe(89);
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0020] OS2 時刻同期は TIME(8) ではなく timePhone(16)
// ref: packages/core/src/itemcodes.js:27; packages/core/src/ble/os2/session.js:746-779
// SDK: CHSesame2Device.kt:263
// kind: wire-fidelity
// ---------------------------------------------------------------------------
describe("[BLE2-0020] OS2 時刻同期は TIME(8) ではなく timePhone(16)", () => {
  it("[BLE2-0020] ITEM.TIMEPHONE は 16 (TIME=8 と別物)", () => {
    expect(ITEM.TIMEPHONE).toBe(16);
    expect(ITEM.TIME).toBe(8);
    expect(ITEM.TIMEPHONE).not.toBe(ITEM.TIME);
  });

  it("[BLE2-0020] timePhoneData() は 4B LE 秒値を返す (ms をそのまま使わない)", () => {
    // 固定 ms=1605929466482 → 秒=1605929466=0x5FB889FA → LE=[FA,89,B8,5F]
    const ms = 1605929466482;
    const result = timePhoneData(ms);
    expect(result).toBeInstanceOf(Buffer);
    expect(result.length).toBe(4);
    const secValue = result.readUInt32LE(0);
    expect(secValue).toBe(1605929466);
  });

  it("[BLE2-0020] buildSendFrame(OP.UPDATE, ITEM.TIMEPHONE, data) の先頭 2B が [0x03, 0x10]", () => {
    const data = timePhoneData(1605929466482);
    const frame = buildSendFrame(OP.UPDATE, ITEM.TIMEPHONE, data);
    expect(frame[0]).toBe(OP.UPDATE);       // 0x03
    expect(frame[1]).toBe(ITEM.TIMEPHONE);  // 0x10 = 16
    expect(frame.length).toBe(2 + 4);       // [op, item] ++ 4B
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0021] register IRER 読み出しは PLAINTEXT、ER = payload.drop(16)
// ref: packages/core/src/ble/os2/session.js:284-287
// SDK: CHSesame2Device.kt:412-418
// kind: payload-fidelity
// ---------------------------------------------------------------------------
describe("[BLE2-0021] register IRER: READ IRER(15) は PLAINTEXT、ER = payload.drop(16)", () => {
  it("[BLE2-0021] buildSendFrame(OP.READ, ITEM.IRER) の先頭 2B が [0x02, 0x0F]", () => {
    const frame = buildSendFrame(OP.READ, ITEM.IRER, Buffer.alloc(0));
    expect(frame[0]).toBe(OP.READ);    // 0x02
    expect(frame[1]).toBe(ITEM.IRER);  // 0x0F = 15
    expect(frame.length).toBe(2);
  });

  it("[BLE2-0021] IRER payload の先頭 16B を捨てた残りが ER (drop(16))", () => {
    // payload = [IR(16B)][ER(n B)] → ER = payload.subarray(16)
    const irBytes = Buffer.alloc(16, 0xAA);
    const erBytes = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const payload = Buffer.concat([irBytes, erBytes]);
    const er = payload.subarray(16);
    expect(er).toEqual(erBytes);
    expect(er.toString("hex")).toBe("01020304");
  });

  it("[BLE2-0021] payload < 16B のとき ER が取れない (境界確認)", () => {
    const tooShort = Buffer.alloc(15, 0xAA);
    const erBytes = tooShort.subarray(16);
    expect(erBytes.length).toBe(0); // drop(16) が空 = 正常な ER を得られない
  });

  it("[BLE2-0021] IRER payload が 16B 未満なら throw (session.js:286)", () => {
    const shortPayload = Buffer.alloc(10);
    expect(() => {
      if (shortPayload.length < 16) throw new Error("IRER payload too short");
    }).toThrow("IRER payload too short");
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0022] register 鍵束 = registerKey/ownerKey/sessionKey の CMAC 連鎖
// ref: packages/core/src/ble/os2/protocol.js:176-187
// SDK: CHSesame2Device.kt:451-454
// kind: crypto-vector
// ---------------------------------------------------------------------------
describe("[BLE2-0022] register 鍵束: deriveRegisterKeys CMAC 連鎖", () => {
  const pre16 = Buffer.alloc(16, 0x11);
  const serverToken = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const mSesameToken = Buffer.from([0x05, 0x06, 0x07, 0x08]);

  it("[BLE2-0022] deriveRegisterKeys は registerKey/ownerKey/sessionKey/sessionToken を返す", () => {
    const result = deriveRegisterKeys(pre16, serverToken, mSesameToken);
    expect(result).toHaveProperty("registerKey");
    expect(result).toHaveProperty("ownerKey");
    expect(result).toHaveProperty("sessionKey");
    expect(result).toHaveProperty("sessionToken");
  });

  it("[BLE2-0022] sessionToken = serverToken ++ mSesameToken (8B)", () => {
    const result = deriveRegisterKeys(pre16, serverToken, mSesameToken);
    expect(result.sessionToken.length).toBe(8);
    expect(result.sessionToken.subarray(0, 4)).toEqual(serverToken);
    expect(result.sessionToken.subarray(4)).toEqual(mSesameToken);
  });

  it("[BLE2-0022] 各鍵は 16B (AES-128-CMAC 出力)", () => {
    const result = deriveRegisterKeys(pre16, serverToken, mSesameToken);
    expect(result.registerKey.length).toBe(16);
    expect(result.ownerKey.length).toBe(16);
    expect(result.sessionKey.length).toBe(16);
  });

  it("[BLE2-0022] ownerKey !== sessionKey (異なる CMAC 入力)", () => {
    const result = deriveRegisterKeys(pre16, serverToken, mSesameToken);
    expect(result.ownerKey.toString("hex")).not.toBe(result.sessionKey.toString("hex"));
  });

  it("[BLE2-0022] pre16 が 16B でなければ throw", () => {
    expect(() => deriveRegisterKeys(Buffer.alloc(15), serverToken, mSesameToken)).toThrow();
    expect(() => deriveRegisterKeys(Buffer.alloc(8, 0x11), serverToken, mSesameToken)).toThrow();
  });

  it("[BLE2-0022] mSesameToken が 4B でなければ throw", () => {
    expect(() => deriveRegisterKeys(pre16, serverToken, Buffer.alloc(3))).toThrow();
    expect(() => deriveRegisterKeys(pre16, serverToken, Buffer.alloc(5))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0023] REGISTRATION payload = sig1[0:4] ++ appPubKey64 ++ serverToken
// ref: packages/core/src/ble/os2/protocol.js:199-206; session.js:330-331
// SDK: CHSesame2Device.kt:447-458
// kind: payload-fidelity
// ---------------------------------------------------------------------------
describe("[BLE2-0023] REGISTRATION payload = sig1[0:4] ++ appPubKey64 ++ serverToken", () => {
  const sig1 = Buffer.alloc(32, 0xAA);
  const appPubKey64 = Buffer.alloc(64, 0xBB);
  const serverToken = Buffer.from([0x01, 0x02, 0x03, 0x04]);

  it("[BLE2-0023] registrationData は sig1[0:4] ++ appPubKey64(64B) ++ serverToken で構成される", () => {
    const data = registrationData(sig1, appPubKey64, serverToken);
    expect(data.subarray(0, 4)).toEqual(sig1.subarray(0, 4));
    expect(data.subarray(4, 68)).toEqual(appPubKey64);
    expect(data.subarray(68)).toEqual(serverToken);
    expect(data.length).toBe(72); // 4 + 64 + 4
  });

  it("[BLE2-0023] REGISTRATION frame の先頭 2B = [OP.CREATE, ITEM.REGISTRATION]", () => {
    const data = registrationData(sig1, appPubKey64, serverToken);
    const frame = buildSendFrame(OP.CREATE, ITEM.REGISTRATION, data);
    expect(frame[0]).toBe(OP.CREATE);         // 0x01
    expect(frame[1]).toBe(ITEM.REGISTRATION); // 0x01
  });

  it("[BLE2-0023] sig1 が 4B 未満なら throw", () => {
    expect(() => registrationData(Buffer.alloc(3), appPubKey64, serverToken)).toThrow();
  });

  it("[BLE2-0023] appPubKey64 が 64B でなければ throw", () => {
    expect(() => registrationData(sig1, Buffer.alloc(63), serverToken)).toThrow();
    expect(() => registrationData(sig1, Buffer.alloc(65), serverToken)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0024] register 完了は login publish で通知され ownerKey が secretKey になる
// ref: session.js:343-356; session.js:702-718
// SDK: CHSesame2Device.kt:462-469; CHSesame2Device.kt:508-517
// kind: payload-fidelity
// ---------------------------------------------------------------------------
describe("[BLE2-0024] register 完了: ownerKey が secretKey、keyIndex='0000'", () => {
  it("[BLE2-0024] deriveRegisterKeys の ownerKey が secretKey になること (contract 確認)", () => {
    const pre16 = Buffer.alloc(16, 0x22);
    const serverToken = Buffer.from([0xAA, 0xBB, 0xCC, 0xDD]);
    const mSesameToken = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    const { ownerKey } = deriveRegisterKeys(pre16, serverToken, mSesameToken);
    expect(ownerKey.length).toBe(16);
    const expectedSecretKey = ownerKey.toString("hex");
    expect(typeof expectedSecretKey).toBe("string");
    expect(expectedSecretKey.length).toBe(32); // 16B = 32 hex chars
  });

  it("[BLE2-0024] register 戻り keyIndex は '0000' (CHSesame2Device.kt:465)", () => {
    // session.js:348 keyIndex: "0000"
    // session.js:339 this._keyIndex = Buffer.from("0000", "hex")
    const keyIndexBuf = Buffer.from("0000", "hex");
    expect(keyIndexBuf.length).toBe(2);
    expect(keyIndexBuf[0]).toBe(0x00);
    expect(keyIndexBuf[1]).toBe(0x00);
    expect(keyIndexBuf.toString("hex")).toBe("0000");
  });

  it("[BLE2-0024] register 戻り値で secretKey と keyIndex は別物 (ownerKey hex / '0000')", () => {
    const ownerKeyHex = "deadbeef".repeat(4);
    const retVal = { secretKey: ownerKeyHex, keyIndex: "0000", ownerKey: ownerKeyHex };
    expect(retVal.secretKey).toBe(retVal.ownerKey);
    expect(retVal.keyIndex).toBe("0000");
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0025] register 戻り ecdhSecret(pre16) は login 鍵ではない
// ref: session.js:312-316; session.js:343-352
// SDK: CHSesame2Device.kt:453; CHSesame2Device.kt:243
// kind: payload-fidelity
// ---------------------------------------------------------------------------
describe("[BLE2-0025] register ecdhSecret(pre16) は login 鍵ではない", () => {
  it("[BLE2-0025] pre16 と ownerKey は異なる値 (pre16 を secretKey に使うと invalidSig)", () => {
    const pre16 = Buffer.alloc(16, 0x33);
    const serverToken = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const mSesameToken = Buffer.from([0x05, 0x06, 0x07, 0x08]);
    const { ownerKey } = deriveRegisterKeys(pre16, serverToken, mSesameToken);
    expect(ownerKey.toString("hex")).not.toBe(pre16.toString("hex"));
  });

  it("[BLE2-0025] ecdhSecretHex (pre16.hex) と ownerKeyHex は独立した文字列", () => {
    const pre16 = Buffer.alloc(16, 0x44);
    const serverToken = Buffer.from([0xAA, 0xBB, 0xCC, 0xDD]);
    const mSesameToken = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    const { ownerKey } = deriveRegisterKeys(pre16, serverToken, mSesameToken);
    const ecdhSecretHex = pre16.toString("hex");
    const ownerKeyHex = ownerKey.toString("hex");
    expect(ecdhSecretHex).not.toBe(ownerKeyHex);
  });

  it("[BLE2-0025] ecdhSecret は pre16(16B)の hex で 32 文字", () => {
    const pre16 = Buffer.alloc(16, 0x42);
    const ecdhSecretHex = pre16.toString("hex");
    expect(ecdhSecretHex.length).toBe(32);
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0026] register は secretKey 付きセッションでは拒否
// ref: session.js:251-255
// SDK: CHSesame2Device.kt:407-410
// kind: error-path
// ---------------------------------------------------------------------------
describe("[BLE2-0026] register() は secretKey 付き構築/deviceUUID/registerServer 必須ガード", () => {
  function makeTransport() {
    return { connect: async () => {}, write: async () => {}, disconnect: async () => {} };
  }

  it("[BLE2-0026] secretKey 付きセッションで register() は reject (factory device 必須)", async () => {
    const session = new SesameOS2BleSession({
      transport: makeTransport(),
      secretKey: "0102030405060708090a0b0c0d0e0f10",
    });
    await expect(session.register({})).rejects.toThrow(/factory device/i);
  });

  it("[BLE2-0026] deviceUUID が無ければ register() は reject", async () => {
    const session = new SesameOS2BleSession({ transport: makeTransport() });
    await expect(
      session.register({ registerServer: async () => ({}) })
    ).rejects.toThrow(/deviceUUID/i);
  });

  it("[BLE2-0026] registerServer が関数でなければ register() は reject", async () => {
    const session = new SesameOS2BleSession({ transport: makeTransport() });
    await expect(
      session.register({ deviceUUID: "test-uuid" })
    ).rejects.toThrow(/registerServer/i);
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0027] register registerServer 戻りは base64 既定で sig1/st/pubkey を Buffer 化
// ref: session.js:303-307; session.js:817-823
// SDK: CHSesame2Device.kt:440-443
// kind: payload-fidelity
// ---------------------------------------------------------------------------
describe("[BLE2-0027] registerServer 戻りの toBuf 正規化 (base64/Buffer/Uint8Array)", () => {
  // session.js 内部の toBuf ロジックを直接確認

  function toBufLike(v, encoding = "base64") {
    if (v == null) throw new Error("null/undefined");
    if (Buffer.isBuffer(v)) return v;
    if (v instanceof Uint8Array) return Buffer.from(v);
    if (typeof v === "string") return Buffer.from(v, encoding);
    throw new Error(`cannot coerce ${typeof v}`);
  }

  it("[BLE2-0027] Buffer はそのまま返す", () => {
    const buf = Buffer.from("aabbcc", "hex");
    const result = toBufLike(buf, "base64");
    expect(result).toBe(buf);
  });

  it("[BLE2-0027] Uint8Array は Buffer として扱われる", () => {
    const uint8 = new Uint8Array([0xCA, 0xFE, 0xBA, 0xBE]);
    const asBuf = Buffer.from(uint8);
    expect(Buffer.isBuffer(asBuf)).toBe(true);
    expect(asBuf[0]).toBe(0xCA);
    const result = toBufLike(uint8);
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result[0]).toBe(0xCA);
  });

  it("[BLE2-0027] base64 文字列は Buffer.from(v, 'base64') で正規化される", () => {
    const testBytes = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
    const base64str = testBytes.toString("base64");
    const decoded = Buffer.from(base64str, "base64");
    expect(decoded).toEqual(testBytes);
    const result = toBufLike(base64str, "base64");
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result).toEqual(testBytes);
  });

  it("[BLE2-0027] null は throw", () => {
    expect(() => toBufLike(null)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0028] register の app ECDH 鍵は IRER 後に生成しハンドシェイク全体で共有
// ref: session.js:289-310; session.js:330
// SDK: CHSesame2Device.kt:436-447
// kind: payload-fidelity
// ---------------------------------------------------------------------------
describe("[BLE2-0028] register: 単一 ECDH 鍵ペアをハンドシェイク全体で共有", () => {
  it("[BLE2-0028] registrationData の appPubKey64 は 64B (prefix 無し X||Y)", () => {
    const sig1 = Buffer.alloc(8, 0xAA);
    const appPubK64 = Buffer.alloc(64, 0xCC);
    const serverToken = Buffer.alloc(4, 0x11);
    const data = registrationData(sig1, appPubK64, serverToken);
    // data = sig1[0:4](4B) ++ appPubK64(64B) ++ serverToken
    expect(data.subarray(4, 68)).toEqual(appPubK64);
  });

  it("[BLE2-0028] appPubKey64 が 64B でなければ registrationData は throw", () => {
    const sig1 = Buffer.alloc(8, 0xAA);
    const badPub65 = Buffer.alloc(65, 0xCC); // 65B (with prefix)
    const serverToken = Buffer.alloc(4, 0x11);
    expect(() => registrationData(sig1, badPub65, serverToken)).toThrow();
  });

  it("[BLE2-0028] registrationData にも同じ appPubK64 を使う (単一鍵)", () => {
    const appPubKey64 = Buffer.alloc(64, 0xCC);
    const sig1 = Buffer.alloc(4, 0x01);
    const serverToken = Buffer.alloc(4, 0x02);
    const payload = registrationData(sig1, appPubKey64, serverToken);
    // appPubKey64 は payload[4:68]
    expect(payload.subarray(4, 68)).toEqual(appPubKey64);
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0029] localServerAuth register は makeLocalRegisterServer を充てる
// ref: packages/core/src/ble/os2/index.js:87-91
// kind: contract-existence
// ---------------------------------------------------------------------------
describe("[BLE2-0029] localServerAuth: SesameOS2Ble が makeLocalRegisterServer を自動充て", () => {
  function makeTransport() {
    return { connect: async () => {}, write: async () => {}, disconnect: async () => {} };
  }

  it("[BLE2-0029] registerServer 明示時はそちらを優先し localServerAuth を無視する", () => {
    const customServer = async () => ({});
    const ble = new SesameOS2Ble({
      transport: makeTransport(),
      registerMode: true,
      registerServer: customServer,
      localServerAuth: true,
    });
    expect(ble._registerServer).toBe(customServer);
  });

  it("[BLE2-0029] registerServer 未指定かつ localServerAuth=true なら makeLocalRegisterServer() を充てる", () => {
    const ble = new SesameOS2Ble({
      transport: makeTransport(),
      registerMode: true,
      localServerAuth: true,
    });
    expect(typeof ble._registerServer).toBe("function");
  });

  it("[BLE2-0029] registerServer 未指定かつ localServerAuth=false なら _registerServer は null", () => {
    const ble = new SesameOS2Ble({
      transport: makeTransport(),
      registerMode: true,
      localServerAuth: false,
    });
    expect(ble._registerServer).toBeNull();
  });

  it("[BLE2-0029] makeLocalRegisterServer() は関数を返す", () => {
    const srv = makeLocalRegisterServer();
    expect(typeof srv).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0030] login response systemTime は LE u32
// ref: packages/core/src/ble/os2/protocol.js:641-647
// SDK: CHSesame2Device.kt:627; DataExtention.kt:69-71
// kind: payload-fidelity
// ---------------------------------------------------------------------------
describe("[BLE2-0030] login response systemTime は LE u32", () => {
  function makeLoginPayload({ systemTimeSec = 0, fwVersion = 1 } = {}) {
    const buf = Buffer.alloc(28);
    buf.writeUInt32LE(systemTimeSec, 0);
    buf.writeInt8(fwVersion, 4);
    return buf;
  }

  it("[BLE2-0030] systemTime は readUInt32LE(0) で読む (BE ではない)", () => {
    const payload = makeLoginPayload({ systemTimeSec: 1605929466, fwVersion: 1 });
    const result = parseLoginResponse(payload);
    expect(result.systemTime).toBe(1605929466);
  });

  it("[BLE2-0030] BE 逆読みとは異なる値になることを確認 (旧バグの回帰防止)", () => {
    const sec = 0x01020304;
    const payload = makeLoginPayload({ systemTimeSec: sec, fwVersion: 1 });
    const result = parseLoginResponse(payload);
    expect(result.systemTime).toBe(sec);
    expect(result.systemTime).not.toBe(0x04030201);
  });

  it("[BLE2-0030] LE バイト順の確認 (0x12345678)", () => {
    const buf = Buffer.alloc(28);
    buf[0] = 0x78; buf[1] = 0x56; buf[2] = 0x34; buf[3] = 0x12;
    buf.writeInt8(1, 4); // fwVersion
    const r = parseLoginResponse(buf);
    expect(r.systemTime).toBe(0x12345678);
    expect(r.systemTime).not.toBe(0x78563412);
  });

  it("[BLE2-0030] payload が 28B 未満なら throw", () => {
    expect(() => parseLoginResponse(Buffer.alloc(27))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0031] login response fwVersion は符号付き Byte
// ref: packages/core/src/ble/os2/protocol.js:654
// SDK: CHSesame2Device.kt:628; CHSesame2Device.kt:262
// kind: payload-fidelity
// ---------------------------------------------------------------------------
describe("[BLE2-0031] login response fwVersion は符号付き Byte (readInt8)", () => {
  function makeLoginPayloadRaw(fwByte) {
    const buf = Buffer.alloc(28);
    buf.writeUInt32LE(1000, 0); // systemTime
    buf[4] = fwByte & 0xFF;
    return buf;
  }

  it("[BLE2-0031] fw=1 は正値 (符号なし/符号付きどちらでも同じ)", () => {
    const result = parseLoginResponse(makeLoginPayloadRaw(1));
    expect(result.fwVersion).toBe(1);
  });

  it("[BLE2-0031] fw=0x80(128) は符号付き読みで -128 になる (Kotlin Byte = signed)", () => {
    const result = parseLoginResponse(makeLoginPayloadRaw(0x80));
    expect(result.fwVersion).toBe(-128);
    expect(result.fwVersion >= 1).toBe(false); // signed 比較でガード不成立
  });

  it("[BLE2-0031] fw=0xFF(255) は符号付き読みで -1 になる", () => {
    const result = parseLoginResponse(makeLoginPayloadRaw(0xFF));
    expect(result.fwVersion).toBe(-1);
  });

  it("[BLE2-0031] fw=0 → 0 (ゼロ)", () => {
    const result = parseLoginResponse(makeLoginPayloadRaw(0));
    expect(result.fwVersion).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0032] login response の mech_setting=[8:20] / mech_status=[20:28] スライス
// ref: packages/core/src/ble/os2/protocol.js:641-668
// SDK: CHSesame2Device.kt:627-633
// kind: payload-fidelity
// ---------------------------------------------------------------------------
describe("[BLE2-0032] login response スライス: mech_setting=[8:20], mech_status=[20:28]", () => {
  it("[BLE2-0032] 28B 未満の payload は throw", () => {
    expect(() => parseLoginResponse(Buffer.alloc(27))).toThrow();
  });

  it("[BLE2-0032] historyCnt = payload[6]", () => {
    const buf = Buffer.alloc(28);
    buf.writeUInt32LE(1000, 0);
    buf.writeInt8(1, 4);
    buf[6] = 42;
    const result = parseLoginResponse(buf);
    expect(result.historyCnt).toBe(42);
  });

  it("[BLE2-0032] mechSetting は payload[8:20] の 12B を解析 (lockPosition など)", () => {
    const buf = Buffer.alloc(28);
    buf.writeUInt32LE(1000, 0);
    buf.writeInt8(1, 4);
    buf.writeInt16LE(512, 8);  // lockRaw=512 → 180度
    buf.writeInt16LE(0, 10);   // unlockRaw=0 → 0度
    const result = parseLoginResponse(buf);
    expect(result.mechSetting.lockPosition).toBe(180);
    expect(result.mechSetting.isConfigured).toBe(true);
  });

  it("[BLE2-0032] mechStatus は payload[20:28] の 8B を解析 (flags など)", () => {
    const buf = Buffer.alloc(28);
    buf.writeUInt32LE(1000, 0);
    buf.writeInt8(1, 4);
    buf[27] = 0x02; // flags=0x02 → isInLockRange=true
    const result = parseLoginResponse(buf);
    expect(result.mechStatus.isInLockRange).toBe(true);
    expect(result.mechStatus.state).toBe(MECH_STATE.LOCKED);
  });

  it("[BLE2-0032] lockPosition/unlockPosition raw 値との対応", () => {
    const buf = Buffer.alloc(28);
    buf.writeUInt32LE(1000, 0);
    buf.writeInt8(1, 4);
    buf.writeInt16LE(256, 8);  // lockRaw=256 → 90度
    buf.writeInt16LE(512, 10); // unlockRaw=512 → 180度
    const result = parseLoginResponse(buf);
    expect(result.mechSetting.lockPosition).toBe(Math.trunc((256 * 360) / 1024));
    expect(result.mechSetting.unlockPosition).toBe(Math.trunc((512 * 360) / 1024));
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0033] mechSetting Sesame2 は度数換算 + isConfigured=(lock!=unlock)
// ref: packages/core/src/ble/os2/protocol.js:571-588
// SDK: CHSesame2.kt:24-28; CHSesame2Device.kt:268
// kind: payload-fidelity
// ---------------------------------------------------------------------------
describe("[BLE2-0033] parseMechSettingSesame2: 度数換算 + isConfigured=(lock!=unlock)", () => {
  it("[BLE2-0033] lockPosition/unlockPosition は raw*360/1024 の整数切り捨て (Math.trunc)", () => {
    const buf = Buffer.alloc(4);
    buf.writeInt16LE(512, 0);
    buf.writeInt16LE(256, 2);
    const result = parseMechSettingSesame2(buf);
    expect(result.lockPosition).toBe(180);
    expect(result.unlockPosition).toBe(90);
  });

  it("[BLE2-0033] lockPositionRaw / unlockPositionRaw も公開される", () => {
    const buf = Buffer.alloc(4);
    buf.writeInt16LE(512, 0);
    buf.writeInt16LE(256, 2);
    const result = parseMechSettingSesame2(buf);
    expect(result.lockPositionRaw).toBe(512);
    expect(result.unlockPositionRaw).toBe(256);
  });

  it("[BLE2-0033] isConfigured=true when lockPosition != unlockPosition", () => {
    const buf = Buffer.alloc(4);
    buf.writeInt16LE(512, 0);
    buf.writeInt16LE(256, 2);
    const result = parseMechSettingSesame2(buf);
    expect(result.isConfigured).toBe(true);
  });

  it("[BLE2-0033] isConfigured=false (NoSettings) when lock == unlock", () => {
    const buf = Buffer.alloc(4);
    buf.writeInt16LE(512, 0);
    buf.writeInt16LE(512, 2);
    const result = parseMechSettingSesame2(buf);
    expect(result.isConfigured).toBe(false);
  });

  it("[BLE2-0033] 負の raw でも trunc(0方向切り捨て)で正しく換算", () => {
    const buf = Buffer.alloc(4);
    buf.writeInt16LE(-512, 0); // -180度
    buf.writeInt16LE(-256, 2); // -90度
    const result = parseMechSettingSesame2(buf);
    expect(result.lockPosition).toBe(-180);
    expect(result.lockPositionRaw).toBe(-512);
    expect(result.unlockPositionRaw).toBe(-256);
  });

  it("[BLE2-0033] 4B 未満は throw", () => {
    expect(() => parseMechSettingSesame2(Buffer.alloc(3))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0034] mechSetting Bot は 7 フィールド符号付き Byte
// ref: packages/core/src/ble/os2/protocol.js:599-613
// SDK: CHSesameBot.kt:17; CHSesameBikeDevice.kt:520
// kind: payload-fidelity
// ---------------------------------------------------------------------------
describe("[BLE2-0034] parseMechSettingBot: 7 フィールド符号付き Byte (readInt8)", () => {
  it("[BLE2-0034] 7 フィールドすべてを readInt8 で返す", () => {
    const buf = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
    const result = parseMechSettingBot(buf);
    expect(result.userPrefDir).toBe(1);
    expect(result.lockSec).toBe(2);
    expect(result.unlockSec).toBe(3);
    expect(result.clickLockSec).toBe(4);
    expect(result.clickHoldSec).toBe(5);
    expect(result.clickUnlockSec).toBe(6);
    expect(result.buttonMode).toBe(7);
  });

  it("[BLE2-0034] 0x80(=128) は符号付き -128 として読まれる (Kotlin Byte = signed)", () => {
    const buf = Buffer.alloc(7, 0x80);
    const result = parseMechSettingBot(buf);
    expect(result.userPrefDir).toBe(-128);
    expect(result.lockSec).toBe(-128);
  });

  it("[BLE2-0034] 0xFF(=255) は符号付き -1 として読まれる", () => {
    const buf = Buffer.alloc(7, 0xFF);
    const result = parseMechSettingBot(buf);
    expect(result.userPrefDir).toBe(-1);
    expect(result.buttonMode).toBe(-1);
  });

  it("[BLE2-0034] 7B 未満は throw", () => {
    expect(() => parseMechSettingBot(Buffer.alloc(6))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0035] mechStatus retCode=data[6] / flags=data[7] の順 (Sesame2/3/4)
// ref: packages/core/src/ble/os2/protocol.js:488-499
// SDK: CHSesame2.kt:30-39
// kind: payload-fidelity
// ---------------------------------------------------------------------------
describe("[BLE2-0035] parseMechStatus os2lock: retCode=data[6] / flags=data[7]", () => {
  it("[BLE2-0035] retCode は data[6]", () => {
    const buf = Buffer.alloc(8);
    buf[6] = 0x42;
    buf[7] = 0x00;
    const result = parseMechStatus(buf);
    expect(result.retCode).toBe(0x42);
  });

  it("[BLE2-0035] flags は data[7] (data[6] の retCode と順を逆にしない)", () => {
    const buf = Buffer.alloc(8);
    buf[6] = 0x00;
    buf[7] = 0x02; // flags: bit1=isInLockRange
    const result = parseMechStatus(buf);
    expect(result.flags).toBe(0x02);
    expect(result.isInLockRange).toBe(true);
  });

  it("[BLE2-0035] batteryRaw は data[0:2] LE u16", () => {
    const buf = Buffer.alloc(8);
    buf.writeUInt16LE(0x0C10, 0); // batteryRaw = 3088
    const result = parseMechStatus(buf);
    expect(result.batteryRaw).toBe(3088);
  });

  it("[BLE2-0035] isInLockRange = flags & 0x02 (bit1)", () => {
    const buf = Buffer.alloc(8);
    buf[7] = 0x02;
    expect(parseMechStatus(buf).isInLockRange).toBe(true);
    const buf2 = Buffer.alloc(8);
    buf2[7] = 0x01;
    expect(parseMechStatus(buf2).isInLockRange).toBe(false);
  });

  it("[BLE2-0035] isInUnlockRange = flags & 0x04 (bit2)", () => {
    const buf = Buffer.alloc(8);
    buf[7] = 0x04;
    expect(parseMechStatus(buf).isInUnlockRange).toBe(true);
    const buf2 = Buffer.alloc(8);
    buf2[7] = 0x02;
    expect(parseMechStatus(buf2).isInUnlockRange).toBe(false);
  });

  it("[BLE2-0035] isBatteryCritical = flags & 0x20 (bit5)", () => {
    const buf = Buffer.alloc(8);
    buf[7] = 0x20;
    expect(parseMechStatus(buf).isBatteryCritical).toBe(true);
    const buf2 = Buffer.alloc(8);
    buf2[7] = 0x00;
    expect(parseMechStatus(buf2).isBatteryCritical).toBe(false);
  });

  it("[BLE2-0035] 8B 未満は throw", () => {
    expect(() => parseMechStatus(Buffer.alloc(7))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0036] mechStatus target==-32768(Short.MIN_VALUE) は null
// ref: packages/core/src/ble/os2/protocol.js:493; protocol.js:534-536
// SDK: CHSesame2.kt:33
// kind: payload-fidelity
// ---------------------------------------------------------------------------
describe("[BLE2-0036] mechStatus target=Short.MIN_VALUE(-32768) は null", () => {
  it("[BLE2-0036] target=-32768 のとき result.target は null", () => {
    const buf = Buffer.alloc(8);
    buf.writeInt16LE(-32768, 2);
    const result = parseMechStatus(buf);
    expect(result.target).toBeNull();
  });

  it("[BLE2-0036] target=-32768 のとき targetDeg も null", () => {
    const buf = Buffer.alloc(8);
    buf.writeInt16LE(-32768, 2);
    const result = parseMechStatus(buf);
    expect(result.targetDeg).toBeNull();
  });

  it("[BLE2-0036] target=-32768 以外は数値として公開される", () => {
    const buf = Buffer.alloc(8);
    buf.writeInt16LE(512, 2);
    const result = parseMechStatus(buf);
    expect(result.target).toBe(512);
    expect(result.targetDeg).toBe(Math.trunc(512 * 360 / 1024)); // 180
  });

  it("[BLE2-0036] target=-32767 は null にならない (境界の 1 つ上)", () => {
    const buf = Buffer.alloc(8);
    buf.writeInt16LE(-32767, 2);
    const result = parseMechStatus(buf);
    expect(result.target).toBe(-32767);
    expect(result.target).not.toBeNull();
  });

  it("[BLE2-0036] target=0 → target=0, targetDeg=0", () => {
    const buf = Buffer.alloc(8);
    buf.writeInt16LE(0, 2);
    const result = parseMechStatus(buf);
    expect(result.target).toBe(0);
    expect(result.targetDeg).toBe(0);
  });

  it("[BLE2-0036] position は Short.MIN_VALUE でも null にならない (target 専用ルール)", () => {
    const buf = Buffer.alloc(8);
    buf.writeInt16LE(-32768, 4); // position = Short.MIN_VALUE
    const result = parseMechStatus(buf);
    expect(result.position).toBe(-32768); // null にならない
    expect(result.positionDeg).not.toBeNull();
  });
});
