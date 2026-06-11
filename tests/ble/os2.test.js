// SESAME OS2 BLE (cipher / protocol / session) のユニットテスト。
// SDK のバイト列規約 (counter 5B + token 8B nonce, opCode 込みフレーム, ECDH 鍵導出) を検証する。

import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import crypto, { createECDH } from "node:crypto";
// AES-CMAC は内製実装 (src/aes-cmac.js, RFC 4493)。旧 node-aes-cmac は P5-2 で除去。
import { aesCmac } from "../../src/aes-cmac.js";

import { SesameOS2BleCipher, __test__ as cipherTest } from "../../src/ble/os2/cipher.js";
import {
  OP, ITEM, SEG, buildSendFrame, parseRecvFrame, sessionToken, deriveSessionKey,
  sessionAuth, loginPayload, deriveRegisterKeys, registrationData, parseMechStatus,
  parseLoginResponse, autolockData, MECH_STATE, timePhoneData,
  createHistag, lockPositionConfiguration, lockPositionData, botMechSettingData,
  botUpdateSettingData, enableDfuData,
} from "../../src/ble/os2/protocol.js";
import { SesameOS2BleSession } from "../../src/ble/os2/session.js";
import { SesameOS2Ble } from "../../src/ble/os2/index.js";
import { SegmentAssembler } from "../../src/ble/protocol.js";

// ---- device 側 (firmware) cipher の模倣 ----
// OS2 の counter 最上位ビット (0x80_00000000) は **方向マーカ**: app→device は flag を立て、
// device→app は flag を落とす。app の SesameOS2BleCipher は app 視点 (encrypt=flag立, decrypt=flag落)。
// firmware はその鏡像 (app の outbound を decrypt するとき flag を立て、app へ encrypt するとき
// flag を落とす)。テストでは firmware を鏡像 nonce で再現する。
function deviceNonce(counter, token8, flag) {
  const b = Buffer.alloc(5);
  let v = flag ? (counter | (0x80n << 32n)) : (counter & 0x7fffffffffn);
  for (let i = 0; i < 5; i++) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return Buffer.concat([b, token8]);
}
function makeDeviceCipher(key, token8) {
  let enc = 0n; let dec = 0n;
  return {
    // device → app: flag を落とす (app の decrypt が flag落マスクで一致する)。
    encrypt(pt) {
      const iv = deviceNonce(enc, token8, false); enc += 1n;
      const c = crypto.createCipheriv("aes-128-ccm", key, iv, { authTagLength: 4 });
      c.setAAD(Buffer.from([0]), { plaintextLength: pt.length });
      return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
    },
    // app → device: app は flag立で暗号化したので、device の decrypt も flag を立てて一致させる。
    decrypt(ctTag) {
      const iv = deviceNonce(dec, token8, true); dec += 1n;
      const ct = ctTag.subarray(0, ctTag.length - 4);
      const tag = ctTag.subarray(ctTag.length - 4);
      const d = crypto.createDecipheriv("aes-128-ccm", key, iv, { authTagLength: 4 });
      d.setAAD(Buffer.from([0]), { plaintextLength: ct.length });
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]);
    },
  };
}

describe("OS2 cipher", () => {
  it("toCounterBytes: encrypt sets the 0x80_00000000 flag, decrypt masks 0x7f_ffffffff (5B LE)", () => {
    // counter 0: encrypt → 00 00 00 00 80 (bit39 立つ、LE)。decrypt → 00 00 00 00 00。
    expect(cipherTest.toCounterBytes(0n, true)).toEqual(Buffer.from([0x00, 0x00, 0x00, 0x00, 0x80]));
    expect(cipherTest.toCounterBytes(0n, false)).toEqual(Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00]));
    // counter 1: encrypt → 01 00 00 00 80。
    expect(cipherTest.toCounterBytes(1n, true)).toEqual(Buffer.from([0x01, 0x00, 0x00, 0x00, 0x80]));
    // counter 0x0102: LE → 02 01 00 00 (+flag for encrypt)。
    expect(cipherTest.toCounterBytes(0x0102n, true)).toEqual(Buffer.from([0x02, 0x01, 0x00, 0x00, 0x80]));
  });

  it("nonce = counter5B ++ sessionToken8B = 13B", () => {
    const token8 = Buffer.from("0011223344556677", "hex");
    const n = cipherTest.os2Nonce(0n, token8, true);
    expect(n.length).toBe(13);
    expect(n.subarray(5)).toEqual(token8);
    expect(n.subarray(0, 5)).toEqual(Buffer.from([0, 0, 0, 0, 0x80]));
  });

  it("app.encrypt round-trips with the firmware-mirror decrypt (direction flag), 4B tag", () => {
    const key = Buffer.alloc(16, 7);
    const token8 = Buffer.from("a1a2a3a4b1b2b3b4", "hex");
    const app = new SesameOS2BleCipher(key, token8);
    const device = makeDeviceCipher(key, token8);

    // app → device
    const m1 = Buffer.from([OP.ASYNC, ITEM.UNLOCK, 0xde, 0xad]);
    const c1 = app.encrypt(m1);
    expect(c1.length).toBe(m1.length + cipherTest.OS2_CCM_TAG_LEN); // tag 4B
    expect(device.decrypt(c1)).toEqual(m1);

    // device → app (response は [notifyOp, item, op, result] 順。SesameProtocols.kt:15-19)
    const r1 = Buffer.from([OP.RESPONSE, ITEM.UNLOCK, OP.ASYNC, 0x00]);
    expect(app.decrypt(device.encrypt(r1))).toEqual(r1);

    expect(app.encryptCounter).toBe(1n);
    expect(app.decryptCounter).toBe(1n);
  });

  it("tampered ciphertext fails decryption (tag mismatch)", () => {
    const key = Buffer.alloc(16, 9);
    const token8 = Buffer.alloc(8, 3);
    const app = new SesameOS2BleCipher(key, token8);
    const device = makeDeviceCipher(key, token8);
    const c = Buffer.from(app.encrypt(Buffer.from([1, 2, 3])));
    c[0] ^= 0xff;
    expect(() => device.decrypt(c)).toThrow();
  });
});

describe("OS2 protocol — frames", () => {
  it("buildSendFrame includes opCode then itemCode (OS2 difference vs OS3)", () => {
    const f = buildSendFrame(OP.SYNC, ITEM.LOGIN, Buffer.from([0xaa]));
    expect(f).toEqual(Buffer.from([OP.SYNC, ITEM.LOGIN, 0xaa]));
  });

  it("parseRecvFrame: response has [item,op,result] header, publish has [item] header", () => {
    // SSM2ResponsePayload は cmdItCode=data[0], cmdOPCode=data[1], cmdResultCode=data[2]
    // (導出元: SesameProtocols.kt:15-19。itemCode が先、opCode が後)。
    const resp = parseRecvFrame(Buffer.from([OP.RESPONSE, ITEM.UNLOCK, OP.ASYNC, 0x00, 0x01, 0x02]));
    expect(resp).toMatchObject({ type: "response", itemCode: ITEM.UNLOCK, cmdOpCode: OP.ASYNC, resultCode: 0 });
    expect(resp.payload).toEqual(Buffer.from([0x01, 0x02]));

    // SSM3PublishPayload は cmdItCode=data[0] (SesameProtocols.kt:5-8)。
    const pub = parseRecvFrame(Buffer.from([OP.PUBLISH, ITEM.MECH_STATUS, 0x11, 0x22]));
    expect(pub).toMatchObject({ type: "publish", itemCode: ITEM.MECH_STATUS });
    expect(pub.payload).toEqual(Buffer.from([0x11, 0x22]));
  });

  it("parseRecvFrame acceptance: [7,2,5,0] = login response / [7,82,6,0] = lock(82) response", () => {
    // 実機相当バイト列 (SesameProtocols.kt:15-19): notifyOp=7(RESPONSE), item=2(LOGIN),
    // op=5(SYNC), result=0(success) → itemCode=LOGIN でルーティングされる。
    const login = parseRecvFrame(Buffer.from([7, 2, 5, 0]));
    expect(login).toMatchObject({ type: "response", itemCode: ITEM.LOGIN, cmdOpCode: OP.SYNC, resultCode: 0 });
    // notifyOp=7, item=82(LOCK), op=6(ASYNC), result=0 → itemCode=LOCK(82)。
    const lock = parseRecvFrame(Buffer.from([7, 82, 6, 0]));
    expect(lock).toMatchObject({ type: "response", itemCode: ITEM.LOCK, cmdOpCode: OP.ASYNC, resultCode: 0 });
  });

  it("ITEM has OS2 local codes IRER=15, TIMEPHONE=16", () => {
    expect(ITEM.IRER).toBe(15);
    expect(ITEM.TIMEPHONE).toBe(16);
  });
});

describe("OS2 protocol — key derivation (matches SDK CMAC chains)", () => {
  const pre16 = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
  const mApp = Buffer.from("aabbccdd", "hex");
  const mSsm = Buffer.from("11223344", "hex");

  it("sessionToken = mAppToken ++ mSesameToken (8B)", () => {
    expect(sessionToken(mApp, mSsm)).toEqual(Buffer.from("aabbccdd11223344", "hex"));
  });

  it("deriveSessionKey = CMAC(pre16, sessionToken8)", () => {
    const st = sessionToken(mApp, mSsm);
    const got = deriveSessionKey(pre16, st);
    const ref = aesCmac(pre16, st, { returnAsBuffer: true });
    expect(got).toEqual(Buffer.isBuffer(ref) ? ref : Buffer.from(ref, "hex"));
  });

  it("sessionAuth = CMAC(secret, userIdx ++ appPub64 ++ sessionToken8); loginPayload layout", () => {
    const secret = Buffer.alloc(16, 5);
    const userIdx = Buffer.from("0001", "hex");
    const appPub = Buffer.alloc(64, 0x42);
    const st = sessionToken(mApp, mSsm);
    const auth = sessionAuth(secret, userIdx, appPub, st);
    const ref = aesCmac(secret, Buffer.concat([userIdx, appPub, st]), { returnAsBuffer: true });
    expect(auth).toEqual(Buffer.isBuffer(ref) ? ref : Buffer.from(ref, "hex"));

    const lp = loginPayload(userIdx, appPub, mApp, auth);
    expect(lp).toEqual(Buffer.concat([userIdx, appPub, mApp, auth.subarray(0, 4)]));
  });

  it("deriveRegisterKeys: registerKey/ownerKey/sessionKey chain", () => {
    const serverToken = Buffer.from("cafebabe", "hex");
    const { registerKey, ownerKey, sessionKey, sessionToken: st } = deriveRegisterKeys(pre16, serverToken, mSsm);
    expect(st).toEqual(Buffer.concat([serverToken, mSsm]));
    const rk = Buffer.from(aesCmac(pre16, st, { returnAsBuffer: true }));
    expect(registerKey).toEqual(rk);
    expect(ownerKey).toEqual(Buffer.from(aesCmac(rk, Buffer.from("owner_key"), { returnAsBuffer: true })));
    expect(sessionKey).toEqual(Buffer.from(aesCmac(rk, st, { returnAsBuffer: true })));
  });

  it("registrationData = sig1[0:4] ++ appPub64 ++ serverToken", () => {
    const sig1 = Buffer.from("01020304050607", "hex");
    const appPub = Buffer.alloc(64, 1);
    const serverToken = Buffer.from("deadbeef", "hex");
    expect(registrationData(sig1, appPub, serverToken))
      .toEqual(Buffer.concat([sig1.subarray(0, 4), appPub, serverToken]));
  });
});

describe("OS2 protocol — data builders & parsers", () => {
  it("autolockData: 2B LE seconds ++ createHistag = 24B (CHSesame2Device.kt:141)", () => {
    // data = delay.toShort().toReverseBytes() ++ createHistag(historytag) = 2B + 22B = 24B。
    expect(autolockData(30)).toEqual(Buffer.concat([Buffer.from([30, 0]), Buffer.alloc(22)]));
    expect(autolockData(30).length).toBe(24);
    expect(autolockData(0)).toEqual(Buffer.concat([Buffer.from([0, 0]), Buffer.alloc(22)]));
    expect(autolockData(300, Buffer.from([0xab])))
      .toEqual(Buffer.concat([Buffer.from([0x2c, 0x01]), createHistag(Buffer.from([0xab]))]));
    expect(() => autolockData(70000)).toThrow();
  });

  it("parseMechStatus: retCode=buf[6], flags=buf[7] (CHSesame2.kt:34-40), target -32768 = null", () => {
    // ベクタ導出元: open/devices/CHSesame2.kt:34-40
    //   retCode = data[6], flags = data[7], isInLockRange = flags and 2,
    //   isInUnlockRange = flags and 4, isBatteryCritical = flags and 32。
    // flags(byte7) bit1 (=2) → locked
    const locked = parseMechStatus(Buffer.from([0x10, 0x0c, 0x00, 0x01, 0x00, 0x02, 0x00, 0x02]));
    expect(locked.state).toBe(MECH_STATE.LOCKED);
    expect(locked.isInLockRange).toBe(true);
    expect(locked.retCode).toBe(0);
    // flags(byte7) bit2 (=4) → unlocked
    const unlocked = parseMechStatus(Buffer.from([0x10, 0x0c, 0x00, 0x01, 0x00, 0x02, 0x00, 0x04]));
    expect(unlocked.state).toBe(MECH_STATE.UNLOCKED);
    // range フラグ無し → moved。byte6 は retCode (履歴トリガ、CHSesame2Device.kt:545)。
    const moved = parseMechStatus(Buffer.from([0x10, 0x0c, 0x00, 0x80, 0x00, 0x02, 0x05, 0x00]));
    expect(moved.state).toBe(MECH_STATE.MOVED);
    expect(moved.target).toBe(null); // 0x8000 LE = -32768
    expect(moved.retCode).toBe(5);   // retCode は byte6 (flags=byte7=0 と取り違えない)
    // flags bit5 (=32) → isBatteryCritical (CHSesame2.kt:40)
    const lowBat = parseMechStatus(Buffer.from([0x10, 0x0c, 0x00, 0x01, 0x00, 0x02, 0x00, 0x22]));
    expect(lowBat.isBatteryCritical).toBe(true);
    expect(lowBat.state).toBe(MECH_STATE.LOCKED); // 0x22 = 32 | 2
    // 8B 未満は明示エラー (Kotlin は data[7] まで読む固定レイアウト)。
    expect(() => parseMechStatus(Buffer.alloc(7))).toThrow(/8 bytes/);
  });

  it("parseMechStatus: Bot 固有 motorStatus=buf[4] / isStop=(flags&1)==0 (CHSesameBot.kt:22-29)", () => {
    // CHSesameBotMechStatus: motorStatus = data[4] (noPower=0/forward=1/hold=2/backward=3、
    // CHSesameBotDevice.kt:286-293)、flags = data[7]、isStop = (flags and 1 == 0) (CHSesameBot.kt:28)。
    const moving = parseMechStatus(Buffer.from([0x10, 0x0c, 0x00, 0x00, 0x01, 0x00, 0x00, 0x03]));
    expect(moving.motorStatus).toBe(1); // forward
    expect(moving.isStop).toBe(false);  // flags bit0=1 → 動作中
    const stopped = parseMechStatus(Buffer.from([0x10, 0x0c, 0x00, 0x00, 0x02, 0x00, 0x00, 0x02]));
    expect(stopped.motorStatus).toBe(2); // hold
    expect(stopped.isStop).toBe(true);   // flags bit0=0 → 停止
  });

  it("parseMechStatus: positionDeg/targetDeg = raw*360/1024 を併記 (CHSesame2.kt:32-33、BLE2-08)", () => {
    // raw: target=256 (90°), position=512 (180°)。SDK は度数を公開し raw は持たないが、
    // kit は wire 検証用に raw を維持し *Deg を併記する。
    const buf = Buffer.alloc(8);
    buf.writeInt16LE(256, 2);  // target raw
    buf.writeInt16LE(512, 4);  // position raw
    const s = parseMechStatus(buf);
    expect(s.target).toBe(256);
    expect(s.position).toBe(512);
    expect(s.targetDeg).toBe(90);
    expect(s.positionDeg).toBe(180);
    // 負角は Kotlin Int 除算 (0 方向切り捨て) と一致: -512 raw → -180°
    const neg = Buffer.alloc(8);
    neg.writeInt16LE(-512, 4);
    expect(parseMechStatus(neg).positionDeg).toBe(-180);
    // 端数: 300 raw → 300*360/1024 = 105.46… → 105 (truncate)
    const frac = Buffer.alloc(8);
    frac.writeInt16LE(300, 4);
    expect(parseMechStatus(frac).positionDeg).toBe(105);
    // target=-32768 (未設定) は raw/deg とも null
    const unset = Buffer.alloc(8);
    unset.writeInt16LE(-32768, 2);
    expect(parseMechStatus(unset).target).toBeNull();
    expect(parseMechStatus(unset).targetDeg).toBeNull();
  });

  it("parseLoginResponse: systemTime LE (toBigLong), fw/historyCnt, 12B setting, 8B status", () => {
    const buf = Buffer.alloc(28);
    // 導出元: SSM2LoginResponsePayload (CHSesame2Device.kt:627) の systemTime は
    // sliceArray(0..3).toBigLong()。toBigLong (DataExtention.kt:69-71) = reversedArray を
    // hex parse = **little-endian** 読み。デバイス送信は LE 4B なので mock も LE で書く
    // (旧テストは writeUInt32BE で誤エンディアンを保護していた)。
    buf.writeUInt32LE(1600000000, 0); // systemTime
    buf[4] = 3;  // fw
    buf[6] = 7;  // historyCnt
    // mech_setting_t (payload[8..19]): lock=0x0100(256raw=90deg), unlock=0x0000 → isConfigured=true
    buf.writeInt16LE(256, 8);
    buf.writeInt16LE(0, 10);
    buf[20 + 7] = 0x02; // mech_status flags は byte7 (CHSesame2.kt:37) → locked
    const lr = parseLoginResponse(buf);
    expect(lr.systemTime).toBe(1600000000);
    expect(lr.fwVersion).toBe(3);
    expect(lr.historyCnt).toBe(7);
    // BLE2-07: mechSetting は CHSesame2MechSettings 解析済み (度数 = raw*360/1024、CHSesame2.kt:24-28)。
    expect(lr.mechSettingBytes.length).toBe(12);
    expect(lr.mechSetting).toMatchObject({
      lockPosition: 90, unlockPosition: 0, isConfigured: true,
      lockPositionRaw: 256, unlockPositionRaw: 0,
    });
    expect(lr.isConfigured).toBe(true);
    // Bot 形 (CHSesameBikeDevice.kt:520): mech_setting_t[0..6] が 7 フィールド (Kotlin Byte)。
    expect(lr.mechSettingBot).toEqual({
      userPrefDir: 0, lockSec: 1, unlockSec: 0, clickLockSec: 0,
      clickHoldSec: 0, clickUnlockSec: 0, buttonMode: 0,
    });
    expect(lr.mechStatus.state).toBe(MECH_STATE.LOCKED);
  });

  it("parseLoginResponse: lock==unlock 角は isConfigured=false (NoSettings、CHSesame2Device.kt:268)", () => {
    const buf = Buffer.alloc(28);
    buf.writeUInt32LE(1600000000, 0);
    // lock=unlock=0 → 未キャリブレーション。
    const lr = parseLoginResponse(buf);
    expect(lr.mechSetting.isConfigured).toBe(false);
    expect(lr.isConfigured).toBe(false);
  });

  it("timePhoneData divides ms by 1000 then LE 4B (SDK fa89b85f vector)", () => {
    expect(timePhoneData(1605929466482)).toEqual(Buffer.from("fa89b85f", "hex"));
  });

  // ---- mechSetting write (configureLockPosition / Bot updateSetting) ----

  // SDK の toReverseBytes() (Short → LE 2B、DataExtention.kt:108-112) を独立に再現した参照実装。
  function leShort(n) {
    const b = Buffer.alloc(2);
    b.writeInt16LE(((n % 0x10000) + 0x10000) % 0x10000 >= 0x8000
      ? (((n % 0x10000) + 0x10000) % 0x10000) - 0x10000
      : ((n % 0x10000) + 0x10000) % 0x10000);
    return b;
  }

  it("createHistag: SDK 22B [size]++tag++0pad, null = all-zero 22B", () => {
    // null → size=0、全 0 の 22B (CHDBModel.kt:18-23、padding=21)。
    expect(createHistag()).toEqual(Buffer.alloc(22));
    // 3B tag → [03, t0, t1, t2, 0*18]。
    const t = createHistag(Buffer.from([0xaa, 0xbb, 0xcc]));
    expect(t.length).toBe(22);
    expect(t[0]).toBe(3);
    expect(t.subarray(1, 4)).toEqual(Buffer.from([0xaa, 0xbb, 0xcc]));
    expect(t.subarray(4)).toEqual(Buffer.alloc(18));
    // >21B は 21B に切り詰め (take(21))、全長は 22B のまま。
    const big = createHistag(Buffer.alloc(30, 0x7f));
    expect(big.length).toBe(22);
    expect(big[0]).toBe(21);
    expect(big.subarray(1)).toEqual(Buffer.alloc(21, 0x7f));
  });

  it("lockPositionConfiguration: tick=deg*1024/360, ±150 range, all LE Short (CHSesameLockPositionConfiguration)", () => {
    // lockDeg=0 → tick 0、unlockDeg=90 → tick trunc(90*1024/360)=256。
    const cfg = lockPositionConfiguration(0, 90);
    expect(cfg.length).toBe(12);
    const expected = Buffer.concat([
      leShort(0),        // lock
      leShort(256),      // unlock
      leShort(0 - 150),  // lockMin  = -150
      leShort(0 + 150),  // lockMax  = 150
      leShort(256 - 150),// unlockMin= 106
      leShort(256 + 150),// unlockMax= 406
    ]);
    expect(cfg).toEqual(expected);
    // lock=-150 は 16bit ラップ (0xFF6A) で LE 格納される (Short 演算)。
    expect(cfg.readInt16LE(4)).toBe(-150);
  });

  it("lockPositionData: 12B config ++ 22B createHistag(null) = 34B (CHSesame2Device.kt:557)", () => {
    const data = lockPositionData(10, 280);
    expect(data.length).toBe(34);
    expect(data.subarray(0, 12)).toEqual(lockPositionConfiguration(10, 280));
    expect(data.subarray(12)).toEqual(Buffer.alloc(22)); // createHistag(null) = 全 0
  });

  it("botMechSettingData: 7B fields ++ 5B zero pad = 12B (CHSesameBotMechSettings.data)", () => {
    const setting = {
      userPrefDir: 1, lockSec: 2, unlockSec: 3, clickLockSec: 4,
      clickHoldSec: 5, clickUnlockSec: 6, buttonMode: 7,
    };
    const data = botMechSettingData(setting);
    expect(data).toEqual(Buffer.from([1, 2, 3, 4, 5, 6, 7, 0, 0, 0, 0, 0]));
    expect(() => botMechSettingData({ ...setting, buttonMode: 999 })).toThrow();
  });

  it("botUpdateSettingData: setting.data() ++ createHistag(tag) (CHSesameBotDevice.kt:421-422)", () => {
    const setting = {
      userPrefDir: 0, lockSec: 0, unlockSec: 0, clickLockSec: 0,
      clickHoldSec: 0, clickUnlockSec: 0, buttonMode: 0,
    };
    const tag = Buffer.from([0x11, 0x22]);
    const data = botUpdateSettingData(setting, tag);
    expect(data.length).toBe(34);
    expect(data.subarray(0, 12)).toEqual(botMechSettingData(setting));
    expect(data.subarray(12)).toEqual(createHistag(tag));
  });

  it("enableDfuData: single 0x01 byte (CHSesame2Device.kt:584 enableDFU '01')", () => {
    expect(enableDfuData()).toEqual(Buffer.from([0x01]));
  });
});

// ---- session: end-to-end login over a mock transport ----

/**
 * SesameOS2BleSession を駆動する mock transport。app の write を傍受し、
 * device 側の応答を onPacket に返す。OS2 のバイト列で login round-trip を検証する。
 */
function makeMockDevice({ keyIndex, deviceKeyPair, mSesameToken }) {
  let onPacket = null;
  let deviceCipher = null;
  const writes = [];
  const commands = []; // 復号後のコマンドフレーム ([op, item, ...data]) を記録 (facade 検証用)
  const appAsm = new SegmentAssembler();

  const sendPlain = (frame) => {
    const header = (SEG.PLAINTEXT << 1) | 1; // single segment, start bit
    onPacket(Buffer.concat([Buffer.from([header]), frame]));
  };
  const sendCipher = (frame) => {
    const ct = deviceCipher.encrypt(frame);
    const header = (SEG.CIPHERTEXT << 1) | 1;
    onPacket(Buffer.concat([Buffer.from([header]), ct]));
  };

  const onAppSegment = (seg) => {
    const a = appAsm.feed(seg);
    if (!a) return;
    let frame = a.data;
    if (a.type === SEG.CIPHERTEXT) frame = deviceCipher.decrypt(frame);
    const op = frame[0];
    const item = frame[1];
    if (op === OP.SYNC && item === ITEM.LOGIN) {
      // login data = userIdx ++ appPub64 ++ mAppToken4 ++ auth4。device 側で同じ sessionKey を導出。
      const data = frame.subarray(2);
      const appPub = data.subarray(keyIndex.length, keyIndex.length + 64);
      const mAppToken = data.subarray(keyIndex.length + 64, keyIndex.length + 64 + 4);
      const st = sessionToken(mAppToken, mSesameToken);
      const ecdh = createECDH("prime256v1");
      ecdh.setPrivateKey(deviceKeyPair.getPrivateKey());
      const shared = ecdh.computeSecret(Buffer.concat([Buffer.from([0x04]), appPub]));
      const pre16 = shared.subarray(0, 16);
      const sessionKey = deriveSessionKey(pre16, st);
      deviceCipher = makeDeviceCipher(sessionKey, st); // firmware 視点 (鏡像 flag)
      const lr = Buffer.alloc(28);
      lr.writeUInt32BE(Math.floor(Date.now() / 1000), 0);
      lr[27] = 0x02; // mech_status flags = byte7 (CHSesame2.kt:37) → locked
      // response = [notifyOp=RESPONSE, item, op, result] (導出元: SesameProtocols.kt:15-19
      // SSM2ResponsePayload — cmdItCode=data[0], cmdOPCode=data[1], cmdResultCode=data[2])。
      sendPlain(Buffer.concat([Buffer.from([OP.RESPONSE, ITEM.LOGIN, OP.SYNC, 0x00]), lr]));
      return;
    }
    // 暗号化コマンドへの応答 (例: unlock)。response = [RESPONSE, item, op, result=0]
    // (導出元: SesameProtocols.kt:15-19。itemCode が先)。
    commands.push(Buffer.from(frame));
    sendCipher(Buffer.from([OP.RESPONSE, item, op, 0x00]));
  };

  return {
    transport: {
      async connect(cb) {
        onPacket = cb;
        // device → app: initial publish。frame = [PUBLISH, INITIAL, ...mSesameToken]
        sendPlain(Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.INITIAL]), mSesameToken]));
      },
      write(seg) { writes.push(Buffer.from(seg)); onAppSegment(Buffer.from(seg)); },
      async disconnect() {},
    },
    writes,
    commands,
  };
}

describe("OS2 session — login + command over mock transport", () => {
  it("logs in via ECDH and sends an encrypted unlock", async () => {
    // device 鍵ペアを用意 (ssmPublicKey = device 公開鍵 64B)。
    const deviceKeyPair = createECDH("prime256v1");
    deviceKeyPair.generateKeys();
    const ssmPublicKey = deviceKeyPair.getPublicKey().subarray(1); // 64B raw

    const secretKey = Buffer.alloc(16, 0x33);
    const keyIndex = Buffer.from("0002", "hex");
    const mSesameToken = Buffer.from("99887766", "hex");

    const { transport } = makeMockDevice({ secretKey, keyIndex, deviceKeyPair, mSesameToken });
    const session = new SesameOS2BleSession({ transport, secretKey, keyIndex, ssmPublicKey });

    await session.connect();
    expect(session.isLoggedIn).toBe(true);
    expect(session.lastStatus.state).toBe(MECH_STATE.LOCKED);

    const r = await session.request(OP.ASYNC, ITEM.UNLOCK, createHistag(Buffer.from([1, 2, 3])));
    expect(r.resultCode).toBe(0);
    await session.disconnect();
  });

  it("[7,82,6,0] 相当の response で pending(LOCK=82) が解決される (acceptance)", async () => {
    const deviceKeyPair = createECDH("prime256v1");
    deviceKeyPair.generateKeys();
    const ssmPublicKey = deviceKeyPair.getPublicKey().subarray(1);
    const secretKey = Buffer.alloc(16, 0x55);
    const keyIndex = Buffer.from("0000", "hex");
    const mSesameToken = Buffer.from("01020304", "hex");
    const { transport } = makeMockDevice({ keyIndex, deviceKeyPair, mSesameToken });
    const session = new SesameOS2BleSession({ transport, secretKey, keyIndex, ssmPublicKey });
    await session.connect();
    // mock は [RESPONSE(7), item(82), op(6), 0] を返す → itemCode=82 の pending が解決する。
    const r = await session.request(OP.ASYNC, ITEM.LOCK, createHistag());
    expect(r.resultCode).toBe(0);
    await session.disconnect();
  });
});

describe("OS2 facade — lock/unlock/click/toggle/autolock data (createHistag 22B 統一)", () => {
  // 全 OS2 制御コマンドの data は createHistag の 22B 固定 (CHSesame2Device.kt:141,185,201 /
  // CHSesameBotDevice.kt:370,387,408 / CHSesameBikeDevice.kt:311)。
  async function connectedFacade() {
    const deviceKeyPair = createECDH("prime256v1");
    deviceKeyPair.generateKeys();
    const ssmPublicKey = deviceKeyPair.getPublicKey().subarray(1);
    const secretKey = Buffer.alloc(16, 0x66);
    const keyIndex = Buffer.from("0000", "hex");
    const mSesameToken = Buffer.from("0a0b0c0d", "hex");
    const mock = makeMockDevice({ keyIndex, deviceKeyPair, mSesameToken });
    const ble = new SesameOS2Ble({
      transport: mock.transport, secretKey, keyIndex, ssmPublicKey, model: "sesame_3",
    });
    await ble.connect();
    return { ble, mock };
  }

  it("lock: data = createHistag(tag) 22B (CHSesame2Device.kt:185)", async () => {
    const { ble, mock } = await connectedFacade();
    await ble.lock(Buffer.from([0x01, 0x02]));
    const cmd = mock.commands.at(-1);
    expect(cmd[0]).toBe(OP.ASYNC);
    expect(cmd[1]).toBe(ITEM.LOCK);
    expect(cmd.subarray(2).length).toBe(22);
    expect(cmd.subarray(2)).toEqual(createHistag(Buffer.from([0x01, 0x02])));
    await ble.close();
  });

  it("lock: タグ省略でも全 0 の 22B を送る (createHistag(null))", async () => {
    const { ble, mock } = await connectedFacade();
    await ble.lock();
    const cmd = mock.commands.at(-1);
    expect(cmd.subarray(2)).toEqual(Buffer.alloc(22));
    await ble.close();
  });

  it("unlock / click: data = createHistag(tag) 22B (CHSesame2Device.kt:201 / CHSesameBotDevice.kt:408)", async () => {
    const { ble, mock } = await connectedFacade();
    await ble.unlock(Buffer.from([0xaa]));
    expect(mock.commands.at(-1)[1]).toBe(ITEM.UNLOCK);
    expect(mock.commands.at(-1).subarray(2)).toEqual(createHistag(Buffer.from([0xaa])));
    await ble.click();
    expect(mock.commands.at(-1)[1]).toBe(ITEM.CLICK);
    expect(mock.commands.at(-1).subarray(2)).toEqual(Buffer.alloc(22));
    await ble.close();
  });

  it("toggle: locked → unlock を createHistag 22B で送る (CHSesame2Device.kt:165-178)", async () => {
    const { ble, mock } = await connectedFacade();
    // login response の mech_status が locked (mock 由来) → unlock 側に分岐。
    expect(ble.lastStatus.state).toBe(MECH_STATE.LOCKED);
    await ble.toggle(Buffer.from([0x07]));
    const cmd = mock.commands.at(-1);
    expect(cmd[1]).toBe(ITEM.UNLOCK);
    expect(cmd.subarray(2)).toEqual(createHistag(Buffer.from([0x07])));
    await ble.close();
  });

  it("autolock: data = 2B LE 秒数 ++ createHistag = 24B (CHSesame2Device.kt:141)", async () => {
    const { ble, mock } = await connectedFacade();
    await ble.autolock(30, Buffer.from([0x09]));
    const cmd = mock.commands.at(-1);
    expect(cmd[0]).toBe(OP.UPDATE);
    expect(cmd[1]).toBe(ITEM.AUTOLOCK);
    expect(cmd.subarray(2).length).toBe(24);
    expect(cmd.subarray(2)).toEqual(Buffer.concat([Buffer.from([30, 0]), createHistag(Buffer.from([0x09]))]));
    await ble.close();
  });
});

describe("OS2 facade — mechSetting write & DFU over mock transport", () => {
  // login 済み facade を作るヘルパー (mock device + SesameOS2Ble)。
  async function connectedFacade() {
    const deviceKeyPair = createECDH("prime256v1");
    deviceKeyPair.generateKeys();
    const ssmPublicKey = deviceKeyPair.getPublicKey().subarray(1);
    const secretKey = Buffer.alloc(16, 0x44);
    const keyIndex = Buffer.from("0005", "hex");
    const mSesameToken = Buffer.from("aabbccdd", "hex");
    const mock = makeMockDevice({ keyIndex, deviceKeyPair, mSesameToken });
    const ble = new SesameOS2Ble({
      transport: mock.transport, secretKey, keyIndex, ssmPublicKey, model: "sesame_3",
    });
    await ble.connect();
    return { ble, mock };
  }

  it("configureLockPosition sends OP.update item=80 with 34B (config ++ histag)", async () => {
    const { ble, mock } = await connectedFacade();
    await ble.configureLockPosition(0, 90);
    const cmd = mock.commands.at(-1);
    expect(cmd[0]).toBe(OP.UPDATE);
    expect(cmd[1]).toBe(ITEM.MECH_SETTING); // 80
    expect(cmd.subarray(2)).toEqual(lockPositionData(0, 90)); // 34B
    await ble.close();
  });

  it("updateSetting (Bot) sends OP.update item=80 with setting.data() ++ histag", async () => {
    const { ble, mock } = await connectedFacade();
    const setting = {
      userPrefDir: 1, lockSec: 10, unlockSec: 10, clickLockSec: 2,
      clickHoldSec: 1, clickUnlockSec: 2, buttonMode: 0,
    };
    await ble.updateSetting(setting, Buffer.from([0x09]));
    const cmd = mock.commands.at(-1);
    expect(cmd[0]).toBe(OP.UPDATE);
    expect(cmd[1]).toBe(ITEM.MECH_SETTING); // 80
    expect(cmd.subarray(2)).toEqual(botUpdateSettingData(setting, Buffer.from([0x09])));
    await ble.close();
  });

  it("updateFirmware sends OP.update item=7 (enableDFU) with payload 0x01", async () => {
    const { ble, mock } = await connectedFacade();
    await ble.updateFirmware();
    const cmd = mock.commands.at(-1);
    expect(cmd[0]).toBe(OP.UPDATE);
    expect(cmd[1]).toBe(ITEM.ENABLE_DFU); // 7
    expect(cmd.subarray(2)).toEqual(Buffer.from([0x01]));
    await ble.close();
  });
});
