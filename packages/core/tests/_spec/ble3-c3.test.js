// BLE3-0061..0078: mech-status / mech-setting / reset / dfu / wm2-profile / wm2-gatt
//
// 対象実装:
//   packages/core/src/ble/protocol.js  (parseNetworkStatus / parseMechSetting / parseOpsSetting / ccmSault /
//                                        loginPayload / registrationData / SESSION_PROFILES)
//   packages/core/src/ble/dfu.js       (updateFirmware / updateFirmwareBleOnly / updateFirmwareWM2 / onMoveToOtaProgress)
//   packages/core/src/ble/index.js     (SesameBle constructor profile 選択 / wifi() ゲッタ)
//   packages/core/src/ble/wm2.js       (WM2_GATT / WM2_ACTION)
//   packages/core/src/itemcodes.js     (WM2_ACTION_CODES)
//   packages/core/src/ble/session.js   (SesameBleSession)
//   packages/core/src/ble/devicemodel.js (capabilitiesForModel)
//
// 実機・ネットワーク不要。全テスト決定論的。

import { describe, it, expect, beforeEach } from "vitest";
import { Buffer } from "node:buffer";

// ---- 実装モジュール ----
import {
  parseNetworkStatus,
  parseMechSetting,
  parseOpsSetting,
  ccmSault,
  loginPayload,
  registrationData,
  SESSION_PROFILES,
  deriveSessionKey,
  ccmEncrypt,
  ccmDecrypt,
  splitSegments,
  SegmentAssembler,
  OP,
  ITEM,
  SEG,
  GATT,
} from "../../src/ble/protocol.js";

import { WM2_GATT, WM2_ACTION } from "../../src/ble/wm2.js";
import { WM2_ACTION_CODES } from "../../src/itemcodes.js";
import { ITEM_CODES } from "../../src/itemcodes.js";
import { capabilitiesForModel } from "../../src/ble/devicemodel.js";
import { SesameBle } from "../../src/ble/index.js";
import { SesameBleSession } from "../../src/ble/session.js";
import {
  updateFirmware,
  updateFirmwareBleOnly,
  updateFirmwareWM2,
  onMoveToOtaProgress,
} from "../../src/ble/dfu.js";

// ---------- 共通定数 ----------
const SECRET = "0123456789abcdef0123456789abcdef";
const TOKEN4 = Buffer.from([0x01, 0x02, 0x03, 0x04]);

// ---------- MockSesame (lock profile) ----------
class MockSesame {
  constructor({ secret = SECRET, token = TOKEN4, loginResult = 0 } = {}) {
    this.secret = Buffer.from(secret, "hex");
    this.token = token;
    this.loginResult = loginResult;
    this.key = deriveSessionKey(this.secret, this.token);
    this.asm = new SegmentAssembler();
    this.encCount = 0;
    this.decCount = 0;
    this.onPacket = null;
    this.lastCommand = null;
    this.disconnected = false;
  }
  connect(onPacket) {
    this.onPacket = onPacket;
    this._emitPlain(Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.INITIAL]), this.token]));
    return Promise.resolve();
  }
  write(seg) {
    const a = this.asm.feed(Buffer.from(seg));
    if (!a) return;
    let frame;
    if (a.type === SEG.CIPHERTEXT) {
      frame = ccmDecrypt(this.key, this.decCount, this.token, a.data);
      this.decCount += 1;
    } else {
      frame = a.data;
    }
    const item = frame[0];
    const data = frame.subarray(1);
    if (item === ITEM.LOGIN) {
      this._emitCipher(Buffer.from([OP.RESPONSE, ITEM.LOGIN, this.loginResult, 0, 0, 0, 0]));
      return;
    }
    this.lastCommand = { item, data: Buffer.from(data) };
    this._emitCipher(Buffer.from([OP.RESPONSE, item, 0x00]));
  }
  disconnect() { this.disconnected = true; return Promise.resolve(); }
  _emitPlain(f) { for (const s of splitSegments(f, SEG.PLAINTEXT)) this.onPacket(s); }
  _emitCipher(f) {
    const ct = ccmEncrypt(this.key, this.encCount, this.token, f);
    this.encCount += 1;
    for (const s of splitSegments(ct, SEG.CIPHERTEXT)) this.onPacket(s);
  }
}

// ---------- MockWM2 (wm2 profile: INITIAL=13 / 鍵=secretKey生16B / sault=token4) ----------
class MockWM2 {
  constructor({ secret = SECRET, token = TOKEN4 } = {}) {
    this.secret = Buffer.from(secret, "hex");
    this.token = token;
    this.asm = new SegmentAssembler();
    this.encCount = 0;
    this.decCount = 0;
    this.onPacket = null;
    this.lastCommand = null;
    this.disconnected = false;
  }
  connect(onPacket) {
    this.onPacket = onPacket;
    // WM2 は initial=13 (WM2ActionCode.INITIAL, CHWifiModule2Device.kt:540)
    this._emitPlain(Buffer.concat([Buffer.from([OP.PUBLISH, 13]), this.token]));
    return Promise.resolve();
  }
  write(seg) {
    const a = this.asm.feed(Buffer.from(seg));
    if (!a) return;
    let frame;
    if (a.type === SEG.CIPHERTEXT) {
      // cipher 鍵 = secretKey 生16B, sault = token4 (profile "wm2")
      frame = ccmDecrypt(this.secret, this.decCount, this.token, a.data, "wm2");
      this.decCount += 1;
    } else {
      frame = a.data;
    }
    const item = frame[0];
    // WM2 login は平文 (item=2)
    if (a.type === SEG.PLAINTEXT && item === 2) {
      this._emitCipher(Buffer.from([OP.RESPONSE, 2, 0x00]));
      return;
    }
    this.lastCommand = { item, data: Buffer.from(frame.subarray(1)) };
    this._emitCipher(Buffer.from([OP.RESPONSE, item, 0x00]));
  }
  disconnect() { this.disconnected = true; return Promise.resolve(); }
  _emitPlain(f) { for (const s of splitSegments(f, SEG.PLAINTEXT)) this.onPacket(s); }
  _emitCipher(f) {
    const ct = ccmEncrypt(this.secret, this.encCount, this.token, f, "wm2");
    this.encCount += 1;
    for (const s of splitSegments(ct, SEG.CIPHERTEXT)) this.onPacket(s);
  }
}

// ============================================================
// BLE3-0061: parseNetworkStatus(1B) — WM2/Hub3 共通 bit flags
// ============================================================
describe("[BLE3-0061] parseNetworkStatus(1B): WM2/Hub3 共通ネットワーク bit flags", () => {
  // bit field 値は CHHub3Device.kt:293-299 / CHWifiModule2Device.kt:503-510 と 1:1:
  //   bit1 (0x02) = isAp
  //   bit2 (0x04) = isNet
  //   bit3 (0x08) = isIot
  //   bit4 (0x10) = isAPCheck
  //   bit5 (0x20) = isAPConnecting
  //   bit6 (0x40) = isNETConnecting
  //   bit7 (0x80) = isIOTConnecting

  it("[BLE3-0061] 全フラグ OFF (payload=0x00)", () => {
    const r = parseNetworkStatus(Buffer.from([0x00]));
    expect(r.isAp).toBe(false);
    expect(r.isNet).toBe(false);
    expect(r.isIot).toBe(false);
    expect(r.isAPCheck).toBe(false);
    expect(r.isAPConnecting).toBe(false);
    expect(r.isNETConnecting).toBe(false);
    expect(r.isIOTConnecting).toBe(false);
    expect(r.raw).toBe(0x00);
  });

  it("[BLE3-0061] isAp=bit1, isNet=bit2, isIot=bit3, isAPCheck=bit4, isAPConnecting=bit5, isNETConnecting=bit6", () => {
    expect(parseNetworkStatus(Buffer.from([0x02])).isAp).toBe(true);
    expect(parseNetworkStatus(Buffer.from([0x02])).isNet).toBe(false);
    expect(parseNetworkStatus(Buffer.from([0x04])).isNet).toBe(true);
    expect(parseNetworkStatus(Buffer.from([0x04])).isAp).toBe(false);
    expect(parseNetworkStatus(Buffer.from([0x08])).isIot).toBe(true);
    expect(parseNetworkStatus(Buffer.from([0x10])).isAPCheck).toBe(true);
    expect(parseNetworkStatus(Buffer.from([0x20])).isAPConnecting).toBe(true);
    expect(parseNetworkStatus(Buffer.from([0x40])).isNETConnecting).toBe(true);
  });

  it("[BLE3-0061] isIOTConnecting=true (bit7=0x80, Kotlin signed byte<0 と等価)", () => {
    expect(parseNetworkStatus(Buffer.from([0x80])).isIOTConnecting).toBe(true);
    expect(parseNetworkStatus(Buffer.from([0x7f])).isIOTConnecting).toBe(false);
  });

  it("[BLE3-0061] 全フラグ ON (payload=0xFF)", () => {
    const r = parseNetworkStatus(Buffer.from([0xff]));
    expect(r.isAp).toBe(true);
    expect(r.isNet).toBe(true);
    expect(r.isIot).toBe(true);
    expect(r.isAPCheck).toBe(true);
    expect(r.isAPConnecting).toBe(true);
    expect(r.isNETConnecting).toBe(true);
    expect(r.isIOTConnecting).toBe(true);
  });

  it("[BLE3-0061] 複数バイト payload でも先頭 1B のみ使用される", () => {
    const r = parseNetworkStatus(Buffer.from([0x06, 0xff]));
    expect(r.isAp).toBe(true);  // bit1
    expect(r.isNet).toBe(true); // bit2
    expect(r.isIOTConnecting).toBe(false); // bit7 は 0
  });

  it("[BLE3-0061] 空 payload で throw", () => {
    expect(() => parseNetworkStatus(Buffer.alloc(0))).toThrow();
  });

  it("[BLE3-0061] raw フィールドは payload[0] をそのまま返す", () => {
    const r = parseNetworkStatus(Buffer.from([0xAB]));
    expect(r.raw).toBe(0xAB);
  });
});

// ============================================================
// BLE3-0062: parseMechSetting(6B) — i16 LE x3
// ============================================================
describe("[BLE3-0062] parseMechSetting(6B): lockPosition/unlockPosition/autoLockSecond i16 LE", () => {
  it("[BLE3-0062] 正値をもつ標準的な 6B payload を正しくパースする", () => {
    const buf = Buffer.alloc(6);
    buf.writeInt16LE(100, 0);
    buf.writeInt16LE(200, 2);
    buf.writeInt16LE(30, 4);
    const r = parseMechSetting(buf);
    expect(r.lockPosition).toBe(100);
    expect(r.unlockPosition).toBe(200);
    expect(r.autoLockSecond).toBe(30);
  });

  it("[BLE3-0062] 負値 (lockPosition=100, unlockPosition=-200, autoLockSecond=300) を正しくパースする", () => {
    const buf = Buffer.alloc(6);
    buf.writeInt16LE(100, 0);
    buf.writeInt16LE(-200, 2);
    buf.writeInt16LE(300, 4);
    const r = parseMechSetting(buf);
    expect(r.lockPosition).toBe(100);
    expect(r.unlockPosition).toBe(-200);
    expect(r.autoLockSecond).toBe(300);
  });

  it("[BLE3-0062] autoLockSecond は符号付き i16 LE (Short, CHSesame5.kt:36 )", () => {
    const buf = Buffer.alloc(6);
    buf.writeInt16LE(0, 0);
    buf.writeInt16LE(0, 2);
    buf.writeInt16LE(-1, 4);
    const r = parseMechSetting(buf);
    expect(r.autoLockSecond).toBe(-1);
  });

  it("[BLE3-0062] 全フィールド 0", () => {
    const r = parseMechSetting(Buffer.alloc(6));
    expect(r.lockPosition).toBe(0);
    expect(r.unlockPosition).toBe(0);
    expect(r.autoLockSecond).toBe(0);
  });

  it("[BLE3-0062] 6B より長い buffer でも先頭 6B のみ参照", () => {
    const buf = Buffer.alloc(10);
    buf.writeInt16LE(1, 0);
    buf.writeInt16LE(2, 2);
    buf.writeInt16LE(3, 4);
    const r = parseMechSetting(buf);
    expect(r.lockPosition).toBe(1);
    expect(r.unlockPosition).toBe(2);
    expect(r.autoLockSecond).toBe(3);
  });

  it("[BLE3-0062] <6B で throw", () => {
    expect(() => parseMechSetting(Buffer.alloc(5))).toThrow();
  });

  it("[BLE3-0062] Buffer でない入力で throw", () => {
    expect(() => parseMechSetting("abcdef")).toThrow();
  });
});

// ============================================================
// BLE3-0063: parseOpsSetting(2B) — u16 LE
// ============================================================
describe("[BLE3-0063] parseOpsSetting(2B): opsLockSecond u16 LE", () => {
  it("[BLE3-0063] opsLockSecond=0 (無効)", () => {
    const r = parseOpsSetting(Buffer.alloc(2));
    expect(r.opsLockSecond).toBe(0);
  });

  it("[BLE3-0063] opsLockSecond=300 (5分)", () => {
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE(300);
    const r = parseOpsSetting(buf);
    expect(r.opsLockSecond).toBe(300);
  });

  it("[BLE3-0063] 最大値 0xFFFF (UShort 最大) = 65535", () => {
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE(0xffff);
    const r = parseOpsSetting(buf);
    expect(r.opsLockSecond).toBe(65535);
  });

  it("[BLE3-0063] 符号なし解釈 — 0x8000 = 32768", () => {
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE(0x8000);
    const r = parseOpsSetting(buf);
    expect(r.opsLockSecond).toBe(32768);
    expect(r.opsLockSecond).toBeGreaterThan(0);
  });

  it("[BLE3-0063] <2B で throw", () => {
    expect(() => parseOpsSetting(Buffer.alloc(1))).toThrow();
  });

  it("[BLE3-0063] Buffer でない入力で throw", () => {
    expect(() => parseOpsSetting([0, 1])).toThrow();
  });
});

// ============================================================
// BLE3-0064: reset — item=104 空 payload、成功時 disconnect
// ============================================================
describe("[BLE3-0064] reset: item=104 空 payload / 成功時 dropKey 相当 disconnect", () => {
  it("[BLE3-0064] ITEM_CODES.RESET = 104 (SesameProtocols.kt:36)", () => {
    expect(ITEM_CODES.RESET).toBe(104);
  });

  it("[BLE3-0064] OS3 lock 系 reset は item=Reset(104) を空 data で送る", async () => {
    const dev = new MockSesame();
    const ble = new SesameBle({ secretKey: SECRET, model: "sesame_5", transport: dev });
    await ble.connect();
    await ble.reset();
    expect(dev.lastCommand.item).toBe(104); // Reset(104)
    expect(dev.lastCommand.data.length).toBe(0); // 空 ByteArray
    await ble.close();
  });

  it("[BLE3-0064] reset 成功 (resultCode=0) で transport を disconnect する (dropKey 相当)", async () => {
    const dev = new MockSesame();
    const ble = new SesameBle({ secretKey: SECRET, model: "sesame_5", transport: dev });
    await ble.connect();
    await ble.reset();
    expect(dev.disconnected).toBe(true);
  });
});

// ============================================================
// BLE3-0065: updateFirmware 経路分岐
// ============================================================
describe("[BLE3-0065] updateFirmware 経路分岐: WM2/Hub3/lock系/未対応", () => {
  it("[BLE3-0065] updateFirmware(session): login 済み session で {session} ハンドルを返す (lock 系 no-op)", () => {
    const session = { isLoggedIn: true };
    const result = updateFirmware(session);
    expect(result).toEqual({ session });
  });

  it("[BLE3-0065] updateFirmware(session): 未ログイン session で throw する", () => {
    const session = { isLoggedIn: false };
    expect(() => updateFirmware(session)).toThrow();
  });

  it("[BLE3-0065] updateFirmware(null): null で throw する", () => {
    expect(() => updateFirmware(null)).toThrow();
  });

  it("[BLE3-0065] OS3 lock 系 (sesame_5) は命令無送信で {session} ハンドル返し", async () => {
    const dev = new MockSesame();
    const ble = new SesameBle({ secretKey: SECRET, model: "sesame_5", transport: dev });
    await ble.connect();
    dev.lastCommand = null;
    const handle = ble.updateFirmware();
    expect(handle).toHaveProperty("session");
    expect(dev.lastCommand).toBeNull();
    await ble.close();
  });

  it("[BLE3-0065] WM2 model の capabilitiesForModel は wifiProvisioning=true を返す (WM2経路の前提)", () => {
    const caps = capabilitiesForModel("wm_2");
    expect(caps.wifiProvisioning).toBe(true);
  });

  it("[BLE3-0065] Hub3 model の capabilitiesForModel は kind=hub3 を返す", () => {
    const caps = capabilitiesForModel("hub_3");
    expect(caps.kind).toBe("hub3");
    expect(caps.wifiProvisioning).toBe(false);
  });

  it("[BLE3-0065] lock5 model の capabilitiesForModel は kind=lock5 を返す", () => {
    const caps = capabilitiesForModel("sesame_5");
    expect(caps.kind).toBe("lock5");
    expect(caps.wifiProvisioning).toBe(false);
  });

  it("[BLE3-0065] OS2 (sesame_2) / 未知 model は throw (経路捏造しない)", () => {
    for (const model of ["sesame_2", "sesame_4", "ssmbot_1", "bike_1"]) {
      const ble = new SesameBle({ secretKey: SECRET, model, transport: new MockSesame() });
      expect(() => ble.updateFirmware(), `model=${model}`).toThrow();
    }
  });
});

// ============================================================
// BLE3-0066: DFU 進捗 publish — payload 先頭 1B が進捗値
// ============================================================
describe("[BLE3-0066] DFU 進捗 publish: payload.first() = payload[0]", () => {
  it("[BLE3-0066] updateFirmware(session): login 済みで {session} を返す", () => {
    const session = { isLoggedIn: true };
    const result = updateFirmware(session);
    expect(result.session).toBe(session);
  });

  it("[BLE3-0066] WM2_ACTION_CODES.OPEN_OTA_SERVER = 126 (CHWifiModule2Device.kt:540 と一致)", () => {
    expect(WM2_ACTION_CODES.OPEN_OTA_SERVER).toBe(126);
  });

  it("[BLE3-0066] ITEM_CODES.MOVE_TO = 84 (CHHub3Device.kt:217 MOVE_TO, SesameProtocols.kt:52)", () => {
    expect(ITEM_CODES.MOVE_TO).toBe(84);
  });

  it("[BLE3-0066] onMoveToOtaProgress: MOVE_TO publish の先頭1B が onProgress に届く", async () => {
    const dev = new MockSesame();
    const session = new SesameBleSession({ transport: dev, secretKey: SECRET });
    await session.connect();
    const got = [];
    const off = onMoveToOtaProgress(session, (p) => got.push(p));
    dev._emitCipher(Buffer.from([OP.PUBLISH, ITEM.MOVE_TO, 42]));
    off();
    expect(got).toEqual([42]);
    await session.disconnect();
  });
});

// ============================================================
// BLE3-0067: updateFirmware(lock系): 未ログインで dfuDeviceNotAvailable
// ============================================================
describe("[BLE3-0067] updateFirmware(lock系): 未接続なら dfuDeviceNotAvailable で throw", () => {
  it("[BLE3-0067] session=null で throw (命令無送信・カウンタ非消費)", () => {
    expect(() => updateFirmware(null)).toThrow();
  });

  it("[BLE3-0067] session.isLoggedIn=false で throw", () => {
    expect(() => updateFirmware({ isLoggedIn: false })).toThrow();
  });

  it("[BLE3-0067] session.isLoggedIn=true なら throw しない (login 済みが唯一の条件)", () => {
    expect(() => updateFirmware({ isLoggedIn: true })).not.toThrow();
  });

  it("[BLE3-0067] 戻り値は {session} ハンドルのみ (BLE command 送信なし = カウンタ非消費)", () => {
    const session = { isLoggedIn: true };
    const result = updateFirmware(session);
    expect(result.session).toBe(session);
    expect(typeof result.then).toBe("undefined");
  });

  it("[BLE3-0067] login 済みでない SesameBleSession に updateFirmware を呼ぶと throw", () => {
    const offline = new SesameBleSession({ transport: new MockSesame(), secretKey: SECRET });
    expect(() => updateFirmware(offline)).toThrow(/not available/i);
  });

  it("[BLE3-0067] login 済み SesameBleSession は throw しない", async () => {
    const dev = new MockSesame();
    const s = new SesameBleSession({ transport: dev, secretKey: SECRET });
    await s.connect();
    expect(() => updateFirmware(s)).not.toThrow();
    await s.disconnect();
  });
});

// ============================================================
// BLE3-0068: WM2 セッション確立 — initial=13 / login payload=CMAC 16B 全量 / register=pubK64のみ
// ============================================================
describe("[BLE3-0068] WM2 セッション確立: initial=13 / login=CMAC 16B 全量 / register=pubK64のみ", () => {
  it("[BLE3-0068] SESSION_PROFILES.wm2.initialItemCode = 13 (WM2ActionCode.INITIAL, kt:540)", () => {
    expect(SESSION_PROFILES.wm2.initialItemCode).toBe(13);
  });

  it("[BLE3-0068] SESSION_PROFILES.lock.initialItemCode = 14 (SesameItemCode.initial, SesameProtocols.kt:34)", () => {
    expect(SESSION_PROFILES.lock.initialItemCode).toBe(14);
  });

  it("[BLE3-0068] loginPayload(token16, 'wm2'): [2] ++ token16 全量 = 17B", () => {
    const tag = Buffer.alloc(16, 0xaa);
    const wm2 = loginPayload(tag, "wm2");
    expect(wm2.length).toBe(17);
    expect(wm2[0]).toBe(2);
    expect(wm2.subarray(1).equals(tag)).toBe(true);
    // lock は 5B (先頭 4B のみ)
    const lock = loginPayload(tag);
    expect(lock.length).toBe(5);
  });

  it("[BLE3-0068] loginPayload(token16, 'lock'): [2] ++ token16[0:4] = 5B", () => {
    const token16 = Buffer.from("0102030405060708090a0b0c0d0e0f10", "hex");
    const payload = loginPayload(token16, "lock");
    expect(payload.length).toBe(5);
    expect(payload[0]).toBe(2);
    expect(payload.subarray(1)).toEqual(token16.subarray(0, 4));
  });

  it("[BLE3-0068] registrationData(pubK64, now, 'wm2'): pubK 64B のみ (timestamp 無し) = 64B", () => {
    const pubK = Buffer.alloc(64, 0xbb);
    const data = registrationData(pubK, Date.now(), "wm2");
    expect(data.length).toBe(64);
    expect(data.equals(pubK)).toBe(true);
    // lock は 68B (pubK 64B + timestamp 4B)
    const lockData = registrationData(pubK, Date.now(), "lock");
    expect(lockData.length).toBe(68);
  });

  it("[BLE3-0068] registrationData(pubK64, now, 'lock'): pubK 64B ++ timestamp 4B = 68B", () => {
    const pubK = Buffer.alloc(64, 0x42);
    const data = registrationData(pubK, Date.now(), "lock");
    expect(data.length).toBe(68);
    expect(data.subarray(0, 64)).toEqual(pubK);
  });
});

// ============================================================
// BLE3-0069: WM2 CCM sault=token4 (12B nonce) / 登録後鍵=ecdhPre16 生16B
// ============================================================
describe("[BLE3-0069] WM2 CCM sault=token4 (0x00 無し) → 12B nonce / 登録後鍵=ecdhPre16 生", () => {
  const token4 = Buffer.from([0x11, 0x22, 0x33, 0x44]);

  it("[BLE3-0069] ccmSault('wm2', token4): token4 のみ 4B (0x00 を挟まない, CHWifiModule2Device.kt:297)", () => {
    const sault = ccmSault("wm2", token4);
    expect(sault.length).toBe(4);
    expect(sault.equals(token4)).toBe(true);
  });

  it("[BLE3-0069] ccmSault('lock', token4): 0x00 ++ token4 = 5B (CHHub3Device.kt:174,207)", () => {
    const sault = ccmSault("lock", token4);
    expect(sault.length).toBe(5);
    expect(sault[0]).toBe(0x00);
    expect(sault.subarray(1).equals(token4)).toBe(true);
  });

  it("[BLE3-0069] nonce 長 = count(8B) + sault: wm2=12B / lock=13B", () => {
    const wm2Sault = ccmSault("wm2", token4);
    const lockSault = ccmSault("lock", token4);
    expect(8 + wm2Sault.length).toBe(12);
    expect(8 + lockSault.length).toBe(13);
  });

  it("[BLE3-0069] WM2 と lock の sault が異なる (先頭 0x00 の有無)", () => {
    const wm2Sault = ccmSault("wm2", token4);
    const lockSault = ccmSault("lock", token4);
    expect(wm2Sault.equals(lockSault)).toBe(false);
    expect(lockSault.length - wm2Sault.length).toBe(1);
  });

  it("[BLE3-0069] ccmEncrypt(profile='wm2') と ccmEncrypt(profile='lock') は異なるバイト列 (nonce 幅の差)", () => {
    const key = Buffer.alloc(16, 0x01);
    const plaintext = Buffer.from([0x03, 0x61, 0x62]);
    const ctWm2 = ccmEncrypt(key, 0, TOKEN4, plaintext, "wm2");
    const ctLock = ccmEncrypt(key, 0, TOKEN4, plaintext, "lock");
    expect(ctWm2.equals(ctLock)).toBe(false);
  });
});

// ============================================================
// BLE3-0070: WM2 profile login — 鍵=secretKey 生16B / payload=[LOGIN_WM2(2)]++CMAC 16B
// ============================================================
describe("[BLE3-0070] WM2 profile login: payload=[LOGIN_WM2(2)]++CMAC(secretKey,token4) 16B = 17B", () => {
  it("[BLE3-0070] loginPayload(cmac16B, 'wm2') 先頭バイト = 2 (LOGIN_WM2 = LOGIN = 2)", () => {
    const cmac16 = Buffer.alloc(16, 0xbb);
    const payload = loginPayload(cmac16, "wm2");
    expect(payload[0]).toBe(2);
  });

  it("[BLE3-0070] loginPayload(cmac16B, 'wm2') は CMAC 16B 全量を含む (切り詰めない)", () => {
    const cmac16 = Buffer.from("0102030405060708090a0b0c0d0e0f10", "hex");
    const payload = loginPayload(cmac16, "wm2");
    expect(payload.length).toBe(17);
    expect(payload.subarray(1).equals(cmac16)).toBe(true);
  });

  it("[BLE3-0070] lock profile の loginPayload は 5B (token16 先頭 4B のみ、非互換)", () => {
    const token16 = Buffer.alloc(16, 0xcc);
    const lockPayload = loginPayload(token16, "lock");
    const wm2Payload = loginPayload(token16, "wm2");
    expect(lockPayload.length).toBe(5);
    expect(wm2Payload.length).toBe(17);
    expect(lockPayload.length).not.toBe(wm2Payload.length);
  });

  it("[BLE3-0070] WM2 mock で connect すると login が平文で届き 17B = [2]++CMAC16B を送る", async () => {
    const receivedPlainFrames = [];
    class RecordingWM2 extends MockWM2 {
      write(seg) {
        const a = this.asm.feed(Buffer.from(seg));
        if (!a) return;
        if (a.type === SEG.PLAINTEXT) {
          receivedPlainFrames.push(Buffer.from(a.data));
        }
        super.write.call(this, seg);
      }
    }
    const dev = new RecordingWM2();
    const session = new SesameBleSession({ transport: dev, secretKey: SECRET, profile: "wm2" });
    await session.connect();
    const loginFrame = receivedPlainFrames.find((f) => f[0] === 2);
    expect(loginFrame).toBeTruthy();
    expect(loginFrame.length).toBe(17);
    expect(loginFrame[0]).toBe(2);
    await session.disconnect();
  });
});

// ============================================================
// BLE3-0071: WM2 profile register — data=pubK64のみ / 登録後鍵=ecdhSecret_pre16 生
// ============================================================
describe("[BLE3-0071] WM2 profile register: data=pubK64 のみ(64B) / 登録後鍵=ecdhSecret_pre16 生", () => {
  it("[BLE3-0071] registrationData(pubK64, now, 'wm2') は 64B のみ (timestamp 4B を含まない)", () => {
    const pubK = Buffer.alloc(64, 0x77);
    const data = registrationData(pubK, 0, "wm2");
    expect(data.length).toBe(64);
  });

  it("[BLE3-0071] registrationData(pubK64, now, 'wm2') の内容は pubK64 と同一", () => {
    const pubK = Buffer.from("ab".repeat(64), "hex");
    const data = registrationData(pubK, 0, "wm2");
    expect(data.equals(pubK)).toBe(true);
  });

  it("[BLE3-0071] registrationData で pubK 長 ≠ 64 なら throw (wm2 でも共通)", () => {
    expect(() => registrationData(Buffer.alloc(63), 0, "wm2")).toThrow();
    expect(() => registrationData(Buffer.alloc(65), 0, "wm2")).toThrow();
  });

  it("[BLE3-0071] lock profile の registrationData は 68B (pubK64 ++ timestamp4, CHHub3Device.kt:197)", () => {
    const pubK = Buffer.alloc(64, 0x55);
    const data = registrationData(pubK, 0, "lock");
    expect(data.length).toBe(68);
    expect(data.subarray(0, 64).equals(pubK)).toBe(true);
    const wm2Data = registrationData(pubK, 0, "wm2");
    expect(data.length - wm2Data.length).toBe(4);
  });
});

// ============================================================
// BLE3-0072: WM2 profile CCM sault=token4 (0x00 無し) → 12B nonce
// ============================================================
describe("[BLE3-0072] WM2 profile CCM sault=token4 (0x00 無し) → nonce 12B", () => {
  const token4 = Buffer.from([0xde, 0xad, 0xbe, 0xef]);

  it("[BLE3-0072] wm2 sault は token4 のみ (4B, 0x00 なし)", () => {
    const s = ccmSault("wm2", token4);
    expect(s.length).toBe(4);
    expect(s[0]).toBe(0xde);
  });

  it("[BLE3-0072] lock sault は 0x00++token4 (5B)", () => {
    const s = ccmSault("lock", token4);
    expect(s.length).toBe(5);
    expect(s[0]).toBe(0x00);
    expect(s[1]).toBe(0xde);
  });

  it("[BLE3-0072] nonce(wm2) = 8B count + 4B sault = 12B", () => {
    expect(8 + ccmSault("wm2", token4).length).toBe(12);
  });

  it("[BLE3-0072] nonce(lock) = 8B count + 5B sault = 13B", () => {
    expect(8 + ccmSault("lock", token4).length).toBe(13);
  });

  it("[BLE3-0072] token4 が 4B でなければ throw", () => {
    expect(() => ccmSault("wm2", Buffer.alloc(3))).toThrow();
    expect(() => ccmSault("wm2", Buffer.alloc(5))).toThrow();
  });

  it("[BLE3-0072] ccmEncrypt(profile='wm2') と ccmEncrypt(profile='lock') は異なるバイト列 (nonce 幅の差)", () => {
    const key = Buffer.alloc(16, 0x11);
    const token = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
    const pt = Buffer.from([0x05, 0x01]);
    const ctWm2 = ccmEncrypt(key, 0, token, pt, "wm2");
    const ctLock = ccmEncrypt(key, 0, token, pt, "lock");
    expect(ctWm2.equals(ctLock)).toBe(false);
    // wm2 は 12B nonce で復号できる
    expect(() => ccmDecrypt(key, 0, token, ctWm2, "wm2")).not.toThrow();
    // wm2 の暗号文を lock nonce で復号しようとすると失敗する
    expect(
      (() => {
        try {
          const dec = ccmDecrypt(key, 0, token, ctWm2, "lock");
          return dec.equals(pt);
        } catch {
          return false;
        }
      })()
    ).toBe(false);
  });
});

// ============================================================
// BLE3-0073: WM2 profile initial itemCode = 13 (lock は 14)
// ============================================================
describe("[BLE3-0073] WM2 profile initial itemCode = 13 (lock は 14, 非互換)", () => {
  it("[BLE3-0073] SESSION_PROFILES.wm2.initialItemCode = 13 / SESSION_PROFILES.lock.initialItemCode = 14", () => {
    expect(SESSION_PROFILES.wm2.initialItemCode).toBe(13);
    expect(SESSION_PROFILES.lock.initialItemCode).toBe(14);
    expect(SESSION_PROFILES.wm2.initialItemCode).not.toBe(SESSION_PROFILES.lock.initialItemCode);
  });

  it("[BLE3-0073] WM2_ACTION_CODES.INITIAL = 13", () => {
    expect(WM2_ACTION_CODES.INITIAL).toBe(13);
  });

  it("[BLE3-0073] ITEM.INITIAL (lock) = 14 (SesameProtocols.kt:34)", () => {
    expect(ITEM.INITIAL).toBe(14);
  });

  it("[BLE3-0073] WM2 では CONNECT_WIFI=5 が 'initial' と衝突しない", () => {
    expect(WM2_ACTION_CODES.CONNECT_WIFI).toBe(5);
    expect(WM2_ACTION_CODES.INITIAL).not.toBe(WM2_ACTION_CODES.CONNECT_WIFI);
  });
});

// ============================================================
// BLE3-0074: getVersionTag — lock=item5 / wm2=VERSION_TAG(127)
// ============================================================
describe("[BLE3-0074] getVersionTag: lock=item5 / wm2=WM2ActionCode.VERSION_TAG(127)", () => {
  it("[BLE3-0074] ITEM_CODES.VERSION_TAG = 5 (SesameProtocols.kt:32)", () => {
    expect(ITEM_CODES.VERSION_TAG).toBe(5);
  });

  it("[BLE3-0074] WM2_ACTION_CODES.VERSION_TAG = 127 (CHWifiModule2Device.kt:540)", () => {
    expect(WM2_ACTION_CODES.VERSION_TAG).toBe(127);
  });

  it("[BLE3-0074] WM2 の VERSION_TAG(127) は lock の VERSION_TAG(5) と異なる (誤発火防止)", () => {
    expect(WM2_ACTION_CODES.VERSION_TAG).not.toBe(5);
    expect(WM2_ACTION_CODES.CONNECT_WIFI).toBe(5);
  });

  it("[BLE3-0074] WM2_ACTION_CODES.VERSION_TAG は OPEN_OTA_SERVER(126) の次の値", () => {
    expect(WM2_ACTION_CODES.VERSION_TAG).toBe(WM2_ACTION_CODES.OPEN_OTA_SERVER + 1);
  });

  it("[BLE3-0074] lock profile session.getVersionTag は itemCode=5 を送る", async () => {
    const dev = new MockSesame();
    const session = new SesameBleSession({ transport: dev, secretKey: SECRET });
    await session.connect();
    await session.getVersionTag();
    expect(dev.lastCommand.item).toBe(ITEM.VERSION_TAG);
    expect(dev.lastCommand.item).toBe(5);
    await session.disconnect();
  });

  it("[BLE3-0074] wm2 profile session.getVersionTag は itemCode=127 を送る", async () => {
    const dev = new MockWM2();
    const session = new SesameBleSession({ transport: dev, secretKey: SECRET, profile: "wm2" });
    await session.connect();
    await session.getVersionTag();
    expect(dev.lastCommand.item).toBe(127);
    await session.disconnect();
  });
});

// ============================================================
// BLE3-0075: WM2 facade route — kind===WIFI で profile 'wm2' を自動選択
// ============================================================
describe("[BLE3-0075] WM2 facade route: kind===WIFI で profile 'wm2' を自動選択 / syncTime 抑止", () => {
  it("[BLE3-0075] capabilitiesForModel('wm_2').wifiProvisioning = true", () => {
    expect(capabilitiesForModel("wm_2").wifiProvisioning).toBe(true);
  });

  it("[BLE3-0075] capabilitiesForModel('sesame_5').wifiProvisioning = false (lock 系は false)", () => {
    expect(capabilitiesForModel("sesame_5").wifiProvisioning).toBe(false);
  });

  it("[BLE3-0075] capabilitiesForModel('hub_3').wifiProvisioning = false (Hub3 は false)", () => {
    expect(capabilitiesForModel("hub_3").wifiProvisioning).toBe(false);
  });

  it("[BLE3-0075] capabilitiesForModel('wm_2').kind = 'wifi' (syncTime 抑止条件の前提)", () => {
    expect(capabilitiesForModel("wm_2").kind).toBe("wifi");
  });

  it("[BLE3-0075] capabilitiesForModel('hub_3').kind = 'hub3'", () => {
    expect(capabilitiesForModel("hub_3").kind).toBe("hub3");
  });

  it("[BLE3-0075] capabilitiesForModel('ssm_touch').kind = 'biometric'", () => {
    expect(capabilitiesForModel("ssm_touch").kind).toBe("biometric");
  });

  it("[BLE3-0075] capabilitiesForModel('sesame_5').kind = 'lock5'", () => {
    expect(capabilitiesForModel("sesame_5").kind).toBe("lock5");
  });

  it("[BLE3-0075] model='wm_2' で構築した SesameBle は profile=wm2 の session を持つ", () => {
    const ble = new SesameBle({ secretKey: SECRET, model: "wm_2", transport: new MockWM2() });
    expect(ble._session._profile).toBe("wm2");
  });

  it("[BLE3-0075] model='sesame_5' (lock 系) で構築した SesameBle は profile=lock の session を持つ", () => {
    const ble = new SesameBle({ secretKey: SECRET, model: "sesame_5", transport: new MockSesame() });
    expect(ble._session._profile).toBe("lock");
  });

  it("[BLE3-0075] model='wm_2' の syncTime は false (WIFI kind は login 後 time 同期しない)", () => {
    const ble = new SesameBle({ secretKey: SECRET, model: "wm_2", transport: new MockWM2() });
    expect(ble._session._syncTime).toBe(false);
  });

  it("[BLE3-0075] model='wm_2' で connect すると WM2 initial(13) を処理して login 完了する", async () => {
    const dev = new MockWM2();
    const ble = new SesameBle({ secretKey: SECRET, model: "wm_2", transport: dev });
    await expect(ble.connect()).resolves.not.toThrow();
    await ble.close();
  });
});

// ============================================================
// BLE3-0076: wifi() ゲッタ — wifiProvisioning 非対応機種で明示エラー
// ============================================================
describe("[BLE3-0076] wifi() ゲッタ: wifiProvisioning 非対応機種で明示エラー (能力ゲート)", () => {
  it("[BLE3-0076] lock5 model の capabilitiesForModel は wifiProvisioning=false", () => {
    expect(capabilitiesForModel("sesame_5").wifiProvisioning).toBe(false);
  });

  it("[BLE3-0076] biometric model の capabilitiesForModel は wifiProvisioning=false", () => {
    expect(capabilitiesForModel("ssm_touch").wifiProvisioning).toBe(false);
  });

  it("[BLE3-0076] hub3 model の capabilitiesForModel は wifiProvisioning=false", () => {
    expect(capabilitiesForModel("hub_3").wifiProvisioning).toBe(false);
  });

  it("[BLE3-0076] wm2 model のみ wifiProvisioning=true (wifi() を呼べる唯一の機種)", () => {
    const wifiModels = [
      "sesame_2", "ssmbot_1", "bike_1", "sesame_4", "sesame_5",
      "bike_2", "sesame_5_pro", "open_sensor_1", "ssm_touch_pro", "ssm_touch",
      "BLE_Connector_1", "hub_3", "remote", "remote_nano", "sesame_5_us",
      "bot_2", "sesame_face_Pro", "sesame_face", "sesame_6", "sesame_6_pro",
      "hub_3_lte",
    ];
    for (const m of wifiModels) {
      expect(capabilitiesForModel(m).wifiProvisioning).toBe(false);
    }
    expect(capabilitiesForModel("wm_2").wifiProvisioning).toBe(true);
  });

  it("[BLE3-0076] model='sesame_5' (非 WM2) で wifi() を呼ぶと throw", () => {
    const ble = new SesameBle({ secretKey: SECRET, model: "sesame_5", transport: new MockSesame() });
    expect(() => ble.wifi()).toThrow();
  });

  it("[BLE3-0076] model='hub_3' (非 WM2) で wifi() を呼ぶと throw", () => {
    const ble = new SesameBle({ secretKey: SECRET, model: "hub_3", transport: new MockSesame() });
    expect(() => ble.wifi()).toThrow();
  });

  it("[BLE3-0076] model='wm_2' (wifiProvisioning 対応) で wifi() は WifiModule2 を返す", () => {
    const ble = new SesameBle({ secretKey: SECRET, model: "wm_2", transport: new MockWM2() });
    expect(() => ble.wifi()).not.toThrow();
    const wm2 = ble.wifi();
    expect(wm2).toBeTruthy();
  });
});

// ============================================================
// BLE3-0077: WM2 専用 GATT — Wm2Chracs と完全一致
// ============================================================
describe("[BLE3-0077] WM2 専用 GATT サービス/特性 UUID が Wm2Chracs と一致", () => {
  const EXPECTED_SERVICE = "1b7e8251-2877-41c3-b46e-cf057c562524";
  const EXPECTED_WRITE = "aca0ef7c-eeaa-48ad-9508-19a6cef6b356";
  const EXPECTED_NOTIFY = "8ac32d3f-5cb9-4d44-bec2-ee689169f626";

  it("[BLE3-0077] WM2_GATT.SERVICE = '1b7e8251-2877-41c3-b46e-cf057c562524' (Wm2Chracs.uuidService01)", () => {
    expect(WM2_GATT.SERVICE).toBe(EXPECTED_SERVICE);
  });

  it("[BLE3-0077] WM2_GATT.WRITE_CHAR = 'aca0ef7c-eeaa-48ad-9508-19a6cef6b356' (Wm2Chracs.writeChrac)", () => {
    expect(WM2_GATT.WRITE_CHAR).toBe(EXPECTED_WRITE);
  });

  it("[BLE3-0077] WM2_GATT.NOTIFY_CHAR = '8ac32d3f-5cb9-4d44-bec2-ee689169f626' (Wm2Chracs.receiveChr)", () => {
    expect(WM2_GATT.NOTIFY_CHAR).toBe(EXPECTED_NOTIFY);
  });

  it("[BLE3-0077] WM2_GATT は fd81 系ロック GATT と SERVICE が異なる (別サービス確認)", () => {
    expect(WM2_GATT.SERVICE).not.toBe(GATT.SERVICE);
    expect(WM2_GATT.SERVICE).not.toContain("fd81");
  });

  it("[BLE3-0077] WM2_GATT はフリーズされている (Object.isFrozen)", () => {
    expect(Object.isFrozen(WM2_GATT)).toBe(true);
  });

  it("[BLE3-0077] WM2_GATT の各 UUID は標準的な 8-4-4-4-12 形式", () => {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(WM2_GATT.SERVICE).toMatch(uuidPattern);
    expect(WM2_GATT.WRITE_CHAR).toMatch(uuidPattern);
    expect(WM2_GATT.NOTIFY_CHAR).toMatch(uuidPattern);
  });
});

// ============================================================
// BLE3-0078: WM2ActionCode enum 値が SDK と 1:1
// ============================================================
describe("[BLE3-0078] WM2ActionCode enum 値が SDK と 1:1 (CHWifiModule2Device.kt:539-541)", () => {
  const EXPECTED = {
    LOGIN_WM2: 2,
    UPDATE_WIFI_SSID: 3,
    UPDATE_WIFI_PASSWORD: 4,
    CONNECT_WIFI: 5,
    NETWORK_STATUS: 6,
    DELETE_SESAME: 7,
    ADD_SESAME: 8,
    INITIAL: 13,
    SESAME_KEYS: 16,
    RESET_WM2: 18,
    SCAN_WIFI_SSID: 19,
    OPEN_OTA_SERVER: 126,
    VERSION_TAG: 127,
  };

  it("[BLE3-0078] WM2_ACTION_CODES.LOGIN_WM2 = 2 (kt:540 LOGIN_WM2(2U))", () => {
    expect(WM2_ACTION_CODES.LOGIN_WM2).toBe(EXPECTED.LOGIN_WM2);
  });

  it("[BLE3-0078] WM2_ACTION_CODES.UPDATE_WIFI_SSID = 3 (kt:540)", () => {
    expect(WM2_ACTION_CODES.UPDATE_WIFI_SSID).toBe(EXPECTED.UPDATE_WIFI_SSID);
  });

  it("[BLE3-0078] WM2_ACTION_CODES.UPDATE_WIFI_PASSWORD = 4 (kt:540)", () => {
    expect(WM2_ACTION_CODES.UPDATE_WIFI_PASSWORD).toBe(EXPECTED.UPDATE_WIFI_PASSWORD);
  });

  it("[BLE3-0078] WM2_ACTION_CODES.CONNECT_WIFI = 5 (kt:540)", () => {
    expect(WM2_ACTION_CODES.CONNECT_WIFI).toBe(EXPECTED.CONNECT_WIFI);
  });

  it("[BLE3-0078] WM2_ACTION_CODES.NETWORK_STATUS = 6 (kt:540)", () => {
    expect(WM2_ACTION_CODES.NETWORK_STATUS).toBe(EXPECTED.NETWORK_STATUS);
  });

  it("[BLE3-0078] WM2_ACTION_CODES.DELETE_SESAME = 7 (kt:540)", () => {
    expect(WM2_ACTION_CODES.DELETE_SESAME).toBe(EXPECTED.DELETE_SESAME);
  });

  it("[BLE3-0078] WM2_ACTION_CODES.ADD_SESAME = 8 (kt:540)", () => {
    expect(WM2_ACTION_CODES.ADD_SESAME).toBe(EXPECTED.ADD_SESAME);
  });

  it("[BLE3-0078] WM2_ACTION_CODES.INITIAL = 13 (kt:540 INITIAL(13U))", () => {
    expect(WM2_ACTION_CODES.INITIAL).toBe(EXPECTED.INITIAL);
  });

  it("[BLE3-0078] WM2_ACTION_CODES.SESAME_KEYS = 16 (kt:540)", () => {
    expect(WM2_ACTION_CODES.SESAME_KEYS).toBe(EXPECTED.SESAME_KEYS);
  });

  it("[BLE3-0078] WM2_ACTION_CODES.RESET_WM2 = 18 (kt:540 RESET_WM2(18U))", () => {
    expect(WM2_ACTION_CODES.RESET_WM2).toBe(EXPECTED.RESET_WM2);
  });

  it("[BLE3-0078] WM2_ACTION_CODES.SCAN_WIFI_SSID = 19 (kt:540)", () => {
    expect(WM2_ACTION_CODES.SCAN_WIFI_SSID).toBe(EXPECTED.SCAN_WIFI_SSID);
  });

  it("[BLE3-0078] WM2_ACTION_CODES.OPEN_OTA_SERVER = 126 (kt:540 OPEN_OTA_SERVER(126U))", () => {
    expect(WM2_ACTION_CODES.OPEN_OTA_SERVER).toBe(EXPECTED.OPEN_OTA_SERVER);
  });

  it("[BLE3-0078] WM2_ACTION_CODES.VERSION_TAG = 127 (kt:540 VERSION_TAG(127U))", () => {
    expect(WM2_ACTION_CODES.VERSION_TAG).toBe(EXPECTED.VERSION_TAG);
  });

  it("[BLE3-0078] WM2_ACTION_CODES はフリーズされている (Object.isFrozen)", () => {
    expect(Object.isFrozen(WM2_ACTION_CODES)).toBe(true);
  });

  it("[BLE3-0078] WM2_ACTION (wm2.js re-export) と WM2_ACTION_CODES (itemcodes.js) が同一オブジェクト", () => {
    expect(WM2_ACTION).toBe(WM2_ACTION_CODES);
  });

  it("[BLE3-0078] SesameItemCode と WM2ActionCode の数値空間が重複する (別 enum が必要な根拠)", () => {
    // WM2.UPDATE_WIFI_SSID=3 は SesameItemCode.USER=3 と同値だが意味が異なる
    expect(WM2_ACTION_CODES.UPDATE_WIFI_SSID).toBe(3);
    expect(ITEM_CODES.USER).toBe(3);
    expect(WM2_ACTION_CODES).not.toBe(ITEM_CODES);
  });
});
