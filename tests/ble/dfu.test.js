// BLE DFU / OTA (src/ble/dfu.js) の単体テスト。
// session.test.js と同じ「忠実な mock SESAME」を transport として注入し、
//   (A) updateFirmware = 命令を送らずデバイスハンドルを返す
//   (B) updateFirmwareBleOnly = MOVE_TO(84) + 進捗 publish
//   (C) updateFirmwareWM2 = OPEN_OTA_SERVER(126) + 進捗 publish
// を HW 無しで検証する。
import { describe, it, expect, beforeEach } from "vitest";
import { Buffer } from "node:buffer";
import { SesameBleSession, BleResultError } from "../../src/ble/session.js";
import {
  deriveSessionKey, ccmEncrypt, ccmDecrypt, splitSegments, SegmentAssembler,
  OP, ITEM, SEG,
} from "../../src/ble/protocol.js";
import {
  updateFirmware, updateFirmwareBleOnly, updateFirmwareWM2,
  onMoveToOtaProgress, onWM2OtaProgress,
} from "../../src/ble/dfu.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const WM2_OPEN_OTA_SERVER = 126; // CHWifiModule2Device.kt:540 WM2ActionCode.OPEN_OTA_SERVER

/** 忠実な mock SESAME。OTA 命令 (MOVE_TO / OPEN_OTA_SERVER) に response を返し、進捗 publish を流せる。 */
class MockSesame {
  constructor({ secret = SECRET, token = Buffer.from([1, 2, 3, 4]), otaResult = 0 } = {}) {
    this.secret = Buffer.from(secret, "hex");
    this.token = token;
    this.otaResult = otaResult;
    this.key = deriveSessionKey(this.secret, this.token);
    this.asm = new SegmentAssembler();
    this.encCount = 0; // device→client
    this.decCount = 0; // client→device
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
    if (a.type === SEG.CIPHERTEXT) { frame = ccmDecrypt(this.key, this.decCount, this.token, a.data); this.decCount += 1; }
    else frame = a.data;
    const item = frame[0];
    const data = frame.subarray(1);
    if (item === ITEM.LOGIN) {
      this._emitCipher(Buffer.from([OP.RESPONSE, ITEM.LOGIN, 0, 0, 0, 0, 0]));
      return;
    }
    this.lastCommand = { item, data: Buffer.from(data) };
    // MOVE_TO / OPEN_OTA_SERVER 等は response(7)+item+resultCode を返す。
    this._emitCipher(Buffer.from([OP.RESPONSE, item, this.otaResult]));
  }

  /** テスト用: 任意 itemCode の publish を進捗バイト付きで流す。 */
  emitProgress(itemCode, progress) {
    this._emitCipher(Buffer.from([OP.PUBLISH, itemCode, progress]));
  }

  disconnect() { this.disconnected = true; return Promise.resolve(); }

  _emitPlain(frame) { for (const s of splitSegments(frame, SEG.PLAINTEXT)) this.onPacket(s); }
  _emitCipher(frame) {
    const ct = ccmEncrypt(this.key, this.encCount, this.token, frame);
    this.encCount += 1;
    for (const s of splitSegments(ct, SEG.CIPHERTEXT)) this.onPacket(s);
  }
}

describe("BLE DFU / OTA", () => {
  let dev, session;
  beforeEach(async () => {
    dev = new MockSesame();
    session = new SesameBleSession({ transport: dev, secretKey: SECRET });
    await session.connect();
  });

  // ---- (A) updateFirmware = 命令を送らずハンドルを返す (CHSesameOS3.kt:441-449) ----
  it("updateFirmware は命令を送らず session ハンドルを返す", () => {
    dev.lastCommand = null;
    const handle = updateFirmware(session);
    expect(handle.session).toBe(session);
    expect(dev.lastCommand).toBeNull(); // 命令送信もカウンタ消費も無い
  });

  it("updateFirmware は未接続なら 'device is not available' で throw (CHSesameOS3.kt:447)", () => {
    const offline = new SesameBleSession({ transport: new MockSesame(), secretKey: SECRET });
    expect(() => updateFirmware(offline)).toThrow(/not available/);
  });

  // ---- (B) Hub3 updateFirmwareBleOnly = MOVE_TO(84) (CHHub3Device.kt:213-226) ----
  it("updateFirmwareBleOnly は MOVE_TO(84) を空 data で送り success を返す", async () => {
    const r = await updateFirmwareBleOnly(session);
    expect(r.resultCode).toBe(0);
    expect(r.session).toBe(session);
    expect(dev.lastCommand.item).toBe(ITEM.MOVE_TO);
    expect(dev.lastCommand.item).toBe(84);
    expect(dev.lastCommand.data.length).toBe(0); // byteArrayOf() = 空
  });

  it("updateFirmwareBleOnly は resultCode≠0 を BleResultError で reject", async () => {
    dev = new MockSesame({ otaResult: 7 }); // busy
    session = new SesameBleSession({ transport: dev, secretKey: SECRET });
    await session.connect();
    const err = await updateFirmwareBleOnly(session).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(BleResultError);
    expect(err.resultCode).toBe(7);
    expect(err.itemCode).toBe(ITEM.MOVE_TO);
  });

  it("onMoveToOtaProgress は MOVE_TO publish の先頭バイトを進捗として受ける", async () => {
    const got = [];
    const off = onMoveToOtaProgress(session, (p) => got.push(p));
    dev.emitProgress(ITEM.MOVE_TO, 0);
    dev.emitProgress(ITEM.MOVE_TO, 50);
    dev.emitProgress(ITEM.MOVE_TO, 100);
    off();
    dev.emitProgress(ITEM.MOVE_TO, 7); // unsubscribe 後は届かない
    expect(got).toEqual([0, 50, 100]);
  });

  // ---- (C) WM2 updateFirmware = OPEN_OTA_SERVER(126) (CHWifiModule2Device.kt:450-458) ----
  it("updateFirmwareWM2 は OPEN_OTA_SERVER(126) を空 data で送り success を返す", async () => {
    const r = await updateFirmwareWM2(session);
    expect(r.resultCode).toBe(0);
    expect(dev.lastCommand.item).toBe(WM2_OPEN_OTA_SERVER);
    expect(dev.lastCommand.item).toBe(126);
    expect(dev.lastCommand.data.length).toBe(0);
  });

  it("updateFirmwareWM2 の onProgress は OPEN_OTA_SERVER publish を受け、応答後に内部 unsubscribe する", async () => {
    const got = [];
    // 応答が返る前に進捗を流すため、request と publish の順序を制御。MockSesame は write で即 response を
    // 返すので、ここでは応答後 (await 完了後) の publish が届かないこと = 内部 unsubscribe を検証する。
    const r = await updateFirmwareWM2(session, { onProgress: (p) => got.push(p) });
    expect(r.resultCode).toBe(0);
    dev.emitProgress(WM2_OPEN_OTA_SERVER, 42); // 解決後は内部購読が外れているので届かない
    expect(got).toEqual([]);
  });

  it("onWM2OtaProgress は所有権を呼び出し側に渡し OPEN_OTA_SERVER publish を取り続ける", () => {
    const got = [];
    const off = onWM2OtaProgress(session, (p) => got.push(p));
    dev.emitProgress(WM2_OPEN_OTA_SERVER, 10);
    dev.emitProgress(WM2_OPEN_OTA_SERVER, 90);
    off();
    expect(got).toEqual([10, 90]);
  });
});
