// SESAME BLE プロトコルコアの単体テスト (純 JS、ハードウェア不要)。
import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import {
  deriveSessionKey, loginPayload, ccmEncrypt, ccmDecrypt,
  splitSegments, SegmentAssembler, buildSendFrame, parseRecvFrame,
  historyTagBLE, autolockData, opSensorControlData, bleTxPowerData, parseMechStatus,
  OP, ITEM, SEG, GATT, MECH_STATE,
} from "../../src/ble/protocol.js";

const SECRET = "0123456789abcdef0123456789abcdef"; // 16B hex
const TOKEN = Buffer.from([0xde, 0xad, 0xbe, 0xef]); // 4B initial token

describe("deriveSessionKey / loginPayload", () => {
  it("16B のセッション鍵を返し、決定的", () => {
    const k1 = deriveSessionKey(SECRET, TOKEN);
    const k2 = deriveSessionKey(Buffer.from(SECRET, "hex"), TOKEN);
    expect(k1.length).toBe(16);
    expect(k1.equals(k2)).toBe(true);
  });
  it("token が 4B でなければ throw", () => {
    expect(() => deriveSessionKey(SECRET, Buffer.from([1, 2, 3]))).toThrow(/4-byte/);
  });
  it("secretKey が 16B でなければ throw", () => {
    expect(() => deriveSessionKey("00", TOKEN)).toThrow(/16 bytes/);
  });
  it("loginPayload = [2] ++ token16[0:4]", () => {
    const k = deriveSessionKey(SECRET, TOKEN);
    const p = loginPayload(k);
    expect(p.length).toBe(5);
    expect(p[0]).toBe(ITEM.LOGIN); // 2
    expect(p.subarray(1).equals(k.subarray(0, 4))).toBe(true);
  });
});

describe("CCM encrypt/decrypt", () => {
  it("round-trip (ct は tag 4B 付き、復号で元に戻る)", () => {
    const key = deriveSessionKey(SECRET, TOKEN);
    const pt = buildSendFrame(ITEM.AUTOLOCK, autolockData(30));
    const enc = ccmEncrypt(key, 0, TOKEN, pt);
    expect(enc.length).toBe(pt.length + 4); // tag 4B
    const back = ccmDecrypt(key, 0, TOKEN, enc);
    expect(back.equals(pt)).toBe(true);
  });
  it("カウンタが違うと復号失敗 (tag 不一致 → throw)", () => {
    const key = deriveSessionKey(SECRET, TOKEN);
    const enc = ccmEncrypt(key, 0, TOKEN, Buffer.from([82, 1, 2]));
    expect(() => ccmDecrypt(key, 1, TOKEN, enc)).toThrow();
  });
  it("カウンタを揃えれば任意 count で round-trip", () => {
    const key = deriveSessionKey(SECRET, TOKEN);
    for (const count of [0, 1, 5, 255, 65536]) {
      const pt = Buffer.from([83, 0x00, 0x0e, count & 0xff]);
      const back = ccmDecrypt(key, count, TOKEN, ccmEncrypt(key, count, TOKEN, pt));
      expect(back.equals(pt)).toBe(true);
    }
  });
});

describe("セグメント split/assemble", () => {
  function roundTrip(payload, type) {
    const packets = splitSegments(payload, type);
    const asm = new SegmentAssembler();
    let result = null;
    for (const p of packets) {
      expect(p.length).toBeLessThanOrEqual(20);
      const r = asm.feed(p);
      if (r) result = r;
    }
    return { packets, result };
  }

  it("19B 以下は 1 パケット (start+type 同時)", () => {
    const { packets, result } = roundTrip(Buffer.alloc(10, 0xab), SEG.PLAINTEXT);
    expect(packets.length).toBe(1);
    expect(packets[0][0]).toBe((SEG.PLAINTEXT << 1) | 1);
    expect(result.type).toBe(SEG.PLAINTEXT);
    expect(result.data.equals(Buffer.alloc(10, 0xab))).toBe(true);
  });

  it("20B 超は複数パケット、中間は APPEND_ONLY、最終で type", () => {
    const payload = Buffer.alloc(45, 0x7);
    const { packets, result } = roundTrip(payload, SEG.CIPHERTEXT);
    expect(packets.length).toBe(3); // 19 + 19 + 7
    expect(packets[0][0]).toBe((SEG.APPEND_ONLY << 1) | 1); // start, append-only
    expect(packets[1][0]).toBe(SEG.APPEND_ONLY << 1); // 中間
    expect(packets[2][0]).toBe(SEG.CIPHERTEXT << 1); // 最終
    expect(result.type).toBe(SEG.CIPHERTEXT);
    expect(result.data.equals(payload)).toBe(true);
  });

  it("ちょうど 19B は 1 パケット", () => {
    const { packets } = roundTrip(Buffer.alloc(19, 1), SEG.PLAINTEXT);
    expect(packets.length).toBe(1);
  });

  it("start bit で受信バッファがリセットされる (途中のゴミを破棄)", () => {
    const asm = new SegmentAssembler();
    asm.feed(Buffer.from([0x00 | 1, 0xff])); // start, append-only (未完)
    // 新しい完結メッセージが start 付きで来たら前のを捨てる
    const r = asm.feed(Buffer.concat([Buffer.from([(SEG.PLAINTEXT << 1) | 1]), Buffer.from([0xaa, 0xbb])]));
    expect(r.type).toBe(SEG.PLAINTEXT);
    expect(r.data.equals(Buffer.from([0xaa, 0xbb]))).toBe(true);
  });
});

describe("frame build/parse", () => {
  it("buildSendFrame = [item] ++ data", () => {
    expect(buildSendFrame(ITEM.LOCK, Buffer.from([1, 2])).equals(Buffer.from([82, 1, 2]))).toBe(true);
    expect(buildSendFrame(ITEM.VERSION_TAG).equals(Buffer.from([5]))).toBe(true);
  });
  it("parseRecvFrame = {opCode, itemCode, body}", () => {
    const r = parseRecvFrame(Buffer.from([OP.RESPONSE, ITEM.LOGIN, 0x00, 0x11, 0x22]));
    expect(r.opCode).toBe(OP.RESPONSE);
    expect(r.itemCode).toBe(ITEM.LOGIN);
    expect(r.body.equals(Buffer.from([0x00, 0x11, 0x22]))).toBe(true);
  });
  it("publish の mechStatus を分解できる", () => {
    const status = Buffer.from([0x70, 0x17, 0, 0, 0, 0, 0b0000_0010]); // ~5.99V, is_lock_range
    const frame = Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.MECH_STATUS]), status]);
    const { opCode, itemCode, body } = parseRecvFrame(frame);
    expect(opCode).toBe(OP.PUBLISH);
    expect(itemCode).toBe(ITEM.MECH_STATUS);
    expect(parseMechStatus(body).state).toBe(MECH_STATE.LOCKED);
  });
});

describe("コマンド data 生成", () => {
  it("historyTagBLE は [0x00,0x0E] 前置、20B 上限。tag 省略は type のみ (SDK null-tag)", () => {
    expect(historyTagBLE().equals(Buffer.from([0x00, 0x0e]))).toBe(true); // 省略 = [00 0E]
    const t = historyTagBLE(Buffer.from([1, 2, 3]));
    expect(t.equals(Buffer.from([0x00, 0x0e, 1, 2, 3]))).toBe(true);
    expect(historyTagBLE(Buffer.alloc(50, 0xaa)).length).toBe(20); // 20B 切詰め
  });
  it("historyTagBLE に文字列を渡すと throw (type 0x000E は UUID バイト列想定)", () => {
    expect(() => historyTagBLE("hello")).toThrow(/Buffer/);
  });
  it("autolockData は 2B LE", () => {
    expect([...autolockData(30)]).toEqual([30, 0]);
    expect([...autolockData(300)]).toEqual([0x2c, 0x01]);
    expect([...autolockData(0)]).toEqual([0, 0]);
    expect(() => autolockData(70000)).toThrow(/0\.\.65535/);
  });
  it("opSensorControlData は 2B LE (UShort, autolockData と同形式)", () => {
    expect([...opSensorControlData(300)]).toEqual([0x2c, 0x01]);
    expect([...opSensorControlData(0)]).toEqual([0, 0]);
    expect([...opSensorControlData(65535)]).toEqual([0xff, 0xff]);
    expect(() => opSensorControlData(-1)).toThrow(/0\.\.65535/);
    expect(() => opSensorControlData(70000)).toThrow(/0\.\.65535/);
  });
  it("bleTxPowerData は符号付き 1B (-128..127)", () => {
    expect([...bleTxPowerData(0)]).toEqual([0]);
    expect([...bleTxPowerData(127)]).toEqual([127]);
    expect([...bleTxPowerData(-4)]).toEqual([0xfc]);   // -4 を Int8 で詰めると 0xFC
    expect([...bleTxPowerData(-128)]).toEqual([0x80]);
    expect(() => bleTxPowerData(128)).toThrow(/-128\.\.127/);
    expect(() => bleTxPowerData(-129)).toThrow(/-128\.\.127/);
  });
});

describe("parseMechStatus (OS3 / CHSesame5MechStatus 準拠)", () => {
  it("isInLockRange (flags&2) のみで施錠/解錠を判定 (中間 moved は無い)", () => {
    expect(parseMechStatus(Buffer.from([0, 0, 0, 0, 0, 0, 0b010])).state).toBe(MECH_STATE.LOCKED);
    expect(parseMechStatus(Buffer.from([0, 0, 0, 0, 0, 0, 0b000])).state).toBe(MECH_STATE.UNLOCKED);
    // bit2 は OS3 では unlock-range ではない → locked にはならない
    expect(parseMechStatus(Buffer.from([0, 0, 0, 0, 0, 0, 0b100])).state).toBe(MECH_STATE.UNLOCKED);
  });
  it("target / position を LE で読む。target=-32768 は null", () => {
    const buf = Buffer.alloc(7);
    buf.writeInt16LE(-100, 2);
    buf.writeInt16LE(50, 4);
    buf[6] = 0b0011_0010; // isInLockRange(2) + stop(16) + batteryCritical(32)
    const s = parseMechStatus(buf);
    expect(s.target).toBe(-100);
    expect(s.position).toBe(50);
    expect(s.state).toBe(MECH_STATE.LOCKED);
    expect(s.isStop).toBe(true);
    expect(s.isBatteryCritical).toBe(true);
    expect(s.isCritical).toBe(false);
    // 旧実装の捏造フィールドは無い
    expect(s.batteryMv).toBeUndefined();
  });
  it("target=-32768 (未設定) は null", () => {
    const buf = Buffer.alloc(7);
    buf.writeInt16LE(-32768, 2);
    expect(parseMechStatus(buf).target).toBeNull();
  });
  it("3B (Bot2/Bike2) は data[2] flags で施錠判定。position/target は null", () => {
    const locked = parseMechStatus(Buffer.from([0x10, 0x0c, 0b0000_0010])); // 電圧2B + flags
    expect(locked.state).toBe(MECH_STATE.LOCKED);
    expect(locked.position).toBeNull();
    expect(locked.target).toBeNull();
    const unlocked = parseMechStatus(Buffer.from([0x10, 0x0c, 0b0000_0000]));
    expect(unlocked.state).toBe(MECH_STATE.UNLOCKED);
    expect(parseMechStatus(Buffer.from([0, 0, 0b0000_0100])).isStop).toBe(true); // bit2 = stop
  });
  it("3B / 7B 以外 (中途半端な長さ) は throw", () => {
    expect(() => parseMechStatus(Buffer.alloc(5))).toThrow();
    expect(() => parseMechStatus(Buffer.alloc(2))).toThrow();
  });
});

describe("定数", () => {
  it("GATT UUID / item code が仕様値", () => {
    expect(GATT.SERVICE).toBe("fd81");
    expect(ITEM.LOCK).toBe(82);
    expect(ITEM.UNLOCK).toBe(83);
    expect(ITEM.AUTOLOCK).toBe(11);
    expect(OP.RESPONSE).toBe(0x07);
    expect(OP.PUBLISH).toBe(0x08);
  });
});
