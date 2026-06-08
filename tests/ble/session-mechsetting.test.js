// SesameBleSession の mechSetting / time / versionTag / history 配線テスト。
// 忠実 mock SESAME を注入し、HW 無しでコマンド往復・time 同期・publish 解析を検証する。
import { describe, it, expect, beforeEach } from "vitest";
import { Buffer } from "node:buffer";
import { SesameBleSession } from "../../src/ble/session.js";
import {
  deriveSessionKey, ccmEncrypt, ccmDecrypt, splitSegments, SegmentAssembler,
  OP, ITEM, SEG,
} from "../../src/ble/protocol.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const OPS_CONTROL = 92;

/**
 * 忠実 mock SESAME。login 応答に systemTime4 を載せ、item ごとに応答 payload を差し替えられる。
 * @param systemTimeSec login 応答に載せるデバイス時刻 (秒、LE 4B)。null で 0 (= 遠過去 → time 同期発火)。
 */
class MockSesame {
  constructor({ systemTimeSec = 0, versionTag = "1.0.0", historyPayload = null } = {}) {
    this.secret = Buffer.from(SECRET, "hex");
    this.token = Buffer.from([1, 2, 3, 4]);
    this.key = deriveSessionKey(this.secret, this.token);
    this.asm = new SegmentAssembler();
    this.encCount = 0;
    this.decCount = 0;
    this.onPacket = null;
    this.commands = []; // 受信した全 {item, data}
    this.systemTimeSec = systemTimeSec;
    this.versionTag = versionTag;
    this.historyPayload = historyPayload;
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
    this.commands.push({ item, data: Buffer.from(data) });

    if (item === ITEM.LOGIN) {
      const t = Buffer.alloc(4); t.writeUInt32LE(this.systemTimeSec >>> 0);
      this._emitCipher(Buffer.concat([Buffer.from([OP.RESPONSE, ITEM.LOGIN, 0]), t]));
      return;
    }
    if (item === ITEM.VERSION_TAG) {
      this._emitCipher(Buffer.concat([Buffer.from([OP.RESPONSE, ITEM.VERSION_TAG, 0]), Buffer.from(this.versionTag, "utf8")]));
      return;
    }
    if (item === ITEM.HISTORY) {
      const p = this.historyPayload || Buffer.alloc(0);
      this._emitCipher(Buffer.concat([Buffer.from([OP.RESPONSE, ITEM.HISTORY, 0]), p]));
      return;
    }
    if (item === ITEM.TIME) return; // time(8) は応答しない (fire-and-forget)
    this._emitCipher(Buffer.from([OP.RESPONSE, item, 0x00]));
  }

  emitMechSetting(buf) { this._emitCipher(Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.MECH_SETTING]), buf])); }
  emitOpsSetting(buf) { this._emitCipher(Buffer.concat([Buffer.from([OP.PUBLISH, OPS_CONTROL]), buf])); }

  disconnect() { return Promise.resolve(); }
  _emitPlain(frame) { for (const s of splitSegments(frame, SEG.PLAINTEXT)) this.onPacket(s); }
  _emitCipher(frame) {
    const ct = ccmEncrypt(this.key, this.encCount, this.token, frame);
    this.encCount += 1;
    for (const s of splitSegments(ct, SEG.CIPHERTEXT)) this.onPacket(s);
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("SesameBleSession mechSetting/time/versionTag/history", () => {
  let dev, session;
  beforeEach(() => {
    dev = new MockSesame();
    session = new SesameBleSession({ transport: dev, secretKey: SECRET });
  });

  it("configureLockPosition が MECH_SETTING(80) を 4B LE で送る", async () => {
    await session.connect();
    const res = await session.configureLockPosition(256, -256);
    expect(res.resultCode).toBe(0);
    const cmd = dev.commands.find((c) => c.item === ITEM.MECH_SETTING);
    expect(cmd.data.toString("hex")).toBe("000100ff");
    // 成功後にキャッシュが更新される (SDK CHSesame5Device.kt:76-77)
    expect(session.lastMechSetting.lockPosition).toBe(256);
    expect(session.lastMechSetting.unlockPosition).toBe(-256);
  });

  it("magnet が MAGNET(17) を空ペイロードで送り resultCode 0 を返す", async () => {
    await session.connect();
    const res = await session.magnet();
    expect(res.resultCode).toBe(0);
    const cmd = dev.commands.find((c) => c.item === ITEM.MAGNET);
    expect(cmd).toBeTruthy();
    expect(cmd.data.length).toBe(0); // 引数なし=空 ByteArray (CHSesame5Device.kt:118-126)
  });

  it("login 時にデバイス時刻が遠過去なら time(8) を送る", async () => {
    // systemTimeSec=0 (遠過去) → 差 >3 秒 → time 同期発火
    await session.connect();
    await flush();
    expect(dev.commands.some((c) => c.item === ITEM.TIME)).toBe(true);
  });

  it("login 時にデバイス時刻が現在と一致するなら time(8) を送らない", async () => {
    dev = new MockSesame({ systemTimeSec: Math.floor(Date.now() / 1000) });
    session = new SesameBleSession({ transport: dev, secretKey: SECRET });
    await session.connect();
    await flush();
    expect(dev.commands.some((c) => c.item === ITEM.TIME)).toBe(false);
  });

  it("getVersionTag が versionTag(5) を送り UTF-8 文字列を返す", async () => {
    dev = new MockSesame({ versionTag: "2.7.1" });
    session = new SesameBleSession({ transport: dev, secretKey: SECRET });
    await session.connect();
    expect(await session.getVersionTag()).toBe("2.7.1");
  });

  it("readHistory → deleteHistory が history(4) と HISTORY_DELETE(18) を送る", async () => {
    dev = new MockSesame({ historyPayload: Buffer.from("11223344aabbcc", "hex") });
    session = new SesameBleSession({ transport: dev, secretKey: SECRET });
    await session.connect();
    const hist = await session.readHistory();
    expect(hist.toString("hex")).toBe("11223344aabbcc");
    const r = await session.deleteHistory(hist);
    expect(r.resultCode).toBe(0);
    const del = dev.commands.find((c) => c.item === ITEM.HISTORY_DELETE);
    expect(del.data.toString("hex")).toBe("11223344"); // recordId = payload[0..3]
  });

  it("mechSetting(80) / OPS_CONTROL(92) publish が解析されキャッシュされる", async () => {
    await session.connect();
    dev.emitMechSetting(Buffer.from("000100ff7800", "hex"));
    expect(session.lastMechSetting).toEqual({ lockPosition: 256, unlockPosition: -256, autoLockSecond: 120 });
    dev.emitOpsSetting(Buffer.from("2c01", "hex"));
    expect(session.lastOpsSetting).toEqual({ opsLockSecond: 300 });
  });

  it("opSensorControl が OPS_CONTROL(92) を 2B LE で送り opsLockSecond キャッシュを更新する", async () => {
    await session.connect();
    const res = await session.opSensorControl(300);
    expect(res.resultCode).toBe(0);
    const cmd = dev.commands.find((c) => c.item === OPS_CONTROL);
    expect(cmd.data.toString("hex")).toBe("2c01"); // 300 = 0x012c → LE 2B
    // 成功時に opsSetting?.opsLockSecond を更新 (CHSesame5Device.kt:113)
    expect(session.lastOpsSetting).toEqual({ opsLockSecond: 300 });
  });

  it("setBleTxPower が BLE_TX_POWER_SETTING(206) を符号付き 1B で送る", async () => {
    await session.connect();
    const res = await session.setBleTxPower(-4);
    expect(res.resultCode).toBe(0);
    const cmd = dev.commands.find((c) => c.item === ITEM.SSM3_ITEM_CODE_BLE_TX_POWER_SETTING);
    expect(cmd.data.toString("hex")).toBe("fc"); // -4 を Int8 で詰めると 0xFC
  });

  it("sendAdvProductType が SET_ADV_PRODUCT_TYPE(205) に生バイト列をそのまま載せる", async () => {
    await session.connect();
    const res = await session.sendAdvProductType(Buffer.from("dead", "hex"));
    expect(res.resultCode).toBe(0);
    const cmd = dev.commands.find((c) => c.item === ITEM.SS3_ITEM_CODE_SET_ADV_PRODUCT_TYPE);
    expect(cmd.data.toString("hex")).toBe("dead");
  });

  it("reset が RESET(104) を空ペイロードで送り成功時に session を破棄する", async () => {
    await session.connect();
    expect(session.isLoggedIn).toBe(true);
    const res = await session.reset();
    expect(res.resultCode).toBe(0);
    const cmd = dev.commands.find((c) => c.item === ITEM.RESET);
    expect(cmd.data.length).toBe(0);
    // 成功 (resultCode==0) のとき dropKey 相当 = disconnect でセッション破棄 (CHSesameOS3.kt:425-426)
    expect(session.isLoggedIn).toBe(false);
  });
});
