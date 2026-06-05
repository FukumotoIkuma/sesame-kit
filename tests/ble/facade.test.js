// SesameBle ファサードの単体テスト。mock SESAME を transport 注入し、lock/autolock/toggle/use を検証。
import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import { SesameBle } from "../../src/ble/index.js";
import {
  deriveSessionKey, ccmEncrypt, ccmDecrypt, splitSegments, SegmentAssembler,
  OP, ITEM, SEG,
} from "../../src/ble/protocol.js";

const SECRET = "0123456789abcdef0123456789abcdef";

/** session.test.js の MockSesame を簡略再掲 (mechStatus を connect 直後に流せる)。 */
class MockSesame {
  constructor({ initialState = null } = {}) {
    this.secret = Buffer.from(SECRET, "hex");
    this.token = Buffer.from([9, 9, 9, 9]);
    this.key = deriveSessionKey(this.secret, this.token);
    this.asm = new SegmentAssembler();
    this.encCount = 0; this.decCount = 0;
    this.onPacket = null; this.lastCommand = null; this.disconnected = false;
    this.initialState = initialState; // 接続後に流す mechStatus (locked/unlocked)
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
    if (a.type === SEG.CIPHERTEXT) { frame = ccmDecrypt(this.key, this.decCount, this.token, a.data); this.decCount++; }
    else frame = a.data;
    const item = frame[0];
    if (item === ITEM.LOGIN) {
      this._emitCipher(Buffer.from([OP.RESPONSE, ITEM.LOGIN, 0, 0, 0, 0, 0]));
      // login 直後に mechStatus publish (実機同様)
      if (this.initialState) this._emitCipher(Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.MECH_STATUS]), this.initialState]));
      return;
    }
    this.lastCommand = { item, data: Buffer.from(frame.subarray(1)) };
    this._emitCipher(Buffer.from([OP.RESPONSE, item, 0x00]));
  }
  disconnect() { this.disconnected = true; return Promise.resolve(); }
  _emitPlain(f) { for (const s of splitSegments(f, SEG.PLAINTEXT)) this.onPacket(s); }
  _emitCipher(f) { const ct = ccmEncrypt(this.key, this.encCount, this.token, f); this.encCount++; for (const s of splitSegments(ct, SEG.CIPHERTEXT)) this.onPacket(s); }
}

const LOCKED = Buffer.from([0x70, 0x17, 0, 0, 0, 0, 0b010]);
const UNLOCKED = Buffer.from([0x70, 0x17, 0, 0, 0, 0, 0b100]);

describe("SesameBle facade", () => {
  it("connect → unlock → autolock → close", async () => {
    const dev = new MockSesame();
    const ble = new SesameBle({ secretKey: SECRET, transport: dev });
    await ble.connect();
    expect(ble.isConnected).toBe(true);

    await ble.unlock(); // 履歴タグ無し
    expect(dev.lastCommand.item).toBe(ITEM.UNLOCK);
    expect(dev.lastCommand.data).toEqual(Buffer.from([0x00, 0x0e])); // historyTagBLE() = type のみ

    const r = await ble.autolock(30);
    expect(r.resultCode).toBe(0);
    expect(dev.lastCommand.item).toBe(ITEM.AUTOLOCK);
    expect([...dev.lastCommand.data]).toEqual([30, 0]); // 2B LE

    await ble.close();
    expect(dev.disconnected).toBe(true);
  });

  it("toggle は lastStatus が locked なら unlock", async () => {
    const dev = new MockSesame({ initialState: LOCKED });
    const ble = new SesameBle({ secretKey: SECRET, transport: dev });
    await ble.connect();
    expect(ble.lastStatus.state).toBe("locked");
    await ble.toggle();
    expect(dev.lastCommand.item).toBe(ITEM.UNLOCK);
    await ble.close();
  });

  it("toggle は unlocked なら lock", async () => {
    const dev = new MockSesame({ initialState: UNLOCKED });
    const ble = new SesameBle({ secretKey: SECRET, transport: dev });
    await ble.connect();
    expect(ble.lastStatus.state).toBe("unlocked");
    await ble.toggle();
    expect(dev.lastCommand.item).toBe(ITEM.LOCK);
    await ble.close();
  });

  it("status() は受信済み mechStatus を返す", async () => {
    const dev = new MockSesame({ initialState: LOCKED });
    const ble = new SesameBle({ secretKey: SECRET, transport: dev });
    await ble.connect();
    const s = await ble.status();
    expect(s.state).toBe("locked");
    await ble.close();
  });

  it("SesameBle.use は connect/close を自動化", async () => {
    const dev = new MockSesame();
    let called = false;
    await SesameBle.use({ secretKey: SECRET, transport: dev }, async (lock) => {
      called = true;
      await lock.lock();
    });
    expect(called).toBe(true);
    expect(dev.disconnected).toBe(true);
    expect(dev.lastCommand.item).toBe(ITEM.LOCK);
  });

  it("secretKey 必須", () => {
    expect(() => new SesameBle({})).toThrow(/secretKey required/);
  });

  it("model=bot_2 は click のみ。lock/unlock/toggle/autolock は型エラー", async () => {
    const dev = new MockSesame();
    const ble = new SesameBle({ secretKey: SECRET, model: "bot_2", transport: dev });
    await ble.connect();
    expect(ble.capabilities.kind).toBe("bot2");
    await ble.click();
    expect(dev.lastCommand.item).toBe(ITEM.CLICK); // 89
    expect(() => ble.lock()).toThrow(/click/);     // 同期 throw。非対応 → 可能操作を案内
    expect(() => ble.unlock()).toThrow();
    expect(() => ble.autolock(30)).toThrow();
    await expect(ble.toggle()).rejects.toThrow();  // toggle は async なので reject
    await ble.close();
  });

  it("model=bike_2 は unlock のみ。lock/click は型エラー", async () => {
    const dev = new MockSesame();
    const ble = new SesameBle({ secretKey: SECRET, model: "bike_2", transport: dev });
    await ble.connect();
    await ble.unlock();
    expect(dev.lastCommand.item).toBe(ITEM.UNLOCK);
    expect(() => ble.lock()).toThrow();
    expect(() => ble.click()).toThrow();
    await ble.close();
  });

  it("model=sesame_5 (既定) は click 非対応", async () => {
    const dev = new MockSesame();
    const ble = new SesameBle({ secretKey: SECRET, model: "sesame_5", transport: dev });
    await ble.connect();
    expect(ble.capabilities.kind).toBe("lock5");
    expect(() => ble.click()).toThrow();
    await ble.close();
  });
});
