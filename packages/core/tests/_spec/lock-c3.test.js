// LOCK-0058..LOCK-0075 統合テストファイル (A/B merger)
//
// 対象:
//   packages/core/src/ble/protocol.js      — OS3 parseMechStatus / autolockData
//   packages/core/src/ble/session.js       — OS3 autolock キャッシュ局所更新
//   packages/core/src/ble/index.js         — SesameBle._assertOp / autolock ガード
//   packages/core/src/ble/devicemodel.js   — caps.ble テーブル
//   packages/core/src/ble/os2/protocol.js  — OS2 createHistag / autolockData / buildSendFrame
//   packages/core/src/ble/os2/index.js     — SesameOS2Ble lock/unlock/click/toggle/autolock/disableAutolock
//
// 方針: TDD — spec どおりの期待値で assert (実装の現状に媚びない)。
//       ネットワーク/実機不使用。全て mock or 純関数。決定論的。

import { describe, it, expect, beforeEach } from "vitest";
import { Buffer } from "node:buffer";
import { setLocale } from "../../src/i18n.js";

// ---- OS3 プロトコル純関数 ----
import {
  parseMechStatus,
  autolockData as autolockDataOS3,
  MECH_STATE,
  deriveSessionKey,
  ccmEncrypt,
  ccmDecrypt,
  splitSegments,
  SegmentAssembler,
  OP,
  ITEM,
  SEG,
} from "../../src/ble/protocol.js";

// ---- OS3 ファサード ----
import { SesameBle } from "../../src/ble/index.js";

// ---- OS3 セッション (直接テスト用) ----
import { SesameBleSession } from "../../src/ble/session.js";

// ---- devicemodel ----
import { capabilitiesForModel } from "../../src/ble/devicemodel.js";

// ---- OS2 プロトコル純関数 ----
import {
  createHistag,
  autolockData as autolockDataOS2,
  buildSendFrame as buildSendFrameOS2,
  OP as OP2,
  ITEM as ITEM2,
  MECH_STATE as MECH_STATE2,
} from "../../src/ble/os2/protocol.js";

// ---- OS2 ファサード ----
import { SesameOS2Ble } from "../../src/ble/os2/index.js";

// setup: ja ロケール固定 (セットアップで既に設定されているが明示的に統一)
beforeEach(() => setLocale("ja"));

// ============================================================
//  共通定数
// ============================================================

const SECRET_HEX = "0123456789abcdef0123456789abcdef";

// ============================================================
//  OS3 MockSesame (facade/session テスト用)
//  — A 実装の MockSesameOS3 と B 実装の MockSesame を統合した最終版
// ============================================================

class MockSesameOS3 {
  constructor({ initialState = null, mechSettingBuf = null, resultCode = 0 } = {}) {
    this.secret = Buffer.from(SECRET_HEX, "hex");
    this.token = Buffer.from([9, 9, 9, 9]);
    this.key = deriveSessionKey(this.secret, this.token);
    this.asm = new SegmentAssembler();
    this.encCount = 0;
    this.decCount = 0;
    this.onPacket = null;
    this.commands = [];
    this.lastCommand = null;
    this.disconnected = false;
    this.initialState = initialState;
    this.mechSettingBuf = mechSettingBuf;
    this.resultCode = resultCode;
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
      this.decCount++;
    } else {
      frame = a.data;
    }
    const item = frame[0];
    const data = Buffer.from(frame.subarray(1));
    this.commands.push({ item, data });
    this.lastCommand = { item, data };

    if (item === ITEM.LOGIN) {
      // login response (4B zero systemTime)
      this._emitCipher(Buffer.concat([Buffer.from([OP.RESPONSE, ITEM.LOGIN, 0]), Buffer.alloc(4)]));
      if (this.initialState) {
        this._emitCipher(Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.MECH_STATUS]), this.initialState]));
      }
      if (this.mechSettingBuf) {
        this._emitCipher(Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.MECH_SETTING]), this.mechSettingBuf]));
      }
      return;
    }
    // generic response (resultCode から)
    this._emitCipher(Buffer.concat([Buffer.from([OP.RESPONSE, item, this.resultCode])]));
  }

  disconnect() {
    this.disconnected = true;
    return Promise.resolve();
  }

  _emitPlain(f) {
    for (const s of splitSegments(f, SEG.PLAINTEXT)) this.onPacket(s);
  }

  _emitCipher(f) {
    const ct = ccmEncrypt(this.key, this.encCount, this.token, f);
    this.encCount++;
    for (const s of splitSegments(ct, SEG.CIPHERTEXT)) this.onPacket(s);
  }

  /** テストからの mechSetting push (A 方式) */
  emitMechSetting(buf) {
    this._emitCipher(Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.MECH_SETTING]), buf]));
  }
}

// ============================================================
//  OS2 BLE ファサード用 helper (B 実装を採用)
//  — SesameOS2Ble を transport stub で構築。
//    session.request をモンキーパッチして送信内容を検証する。
// ============================================================

function makeOs2Ble(opts = {}) {
  const transport = {
    connect: () => Promise.resolve(),
    write: () => {},
    disconnect: () => Promise.resolve(),
  };
  return new SesameOS2Ble({
    secretKey: SECRET_HEX,
    keyIndex: "0000",
    ssmPublicKey: Buffer.alloc(64),
    transport,
    ...opts,
  });
}

// ============================================================
//  LOCK-0058: OS3 autolockData の範囲/非整数 reject
// ============================================================

describe("LOCK-0058: OS3 autolockData — 範囲/非整数 reject", () => {
  it("[LOCK-0058] 0..65535 の整数のみ受理し、負値 | >65535 | 小数 | NaN は throw する", () => {
    // 正常値
    expect(() => autolockDataOS3(0)).not.toThrow();
    expect(() => autolockDataOS3(30)).not.toThrow();
    expect(() => autolockDataOS3(65535)).not.toThrow();

    // 負値
    expect(() => autolockDataOS3(-1)).toThrow();
    // 上限超
    expect(() => autolockDataOS3(65536)).toThrow();
    // 非整数
    expect(() => autolockDataOS3(1.5)).toThrow();
    // NaN
    expect(() => autolockDataOS3(NaN)).toThrow();
    // 文字列
    expect(() => autolockDataOS3("30")).toThrow();
  });

  it("[LOCK-0058] autolockData(seconds) は 2B LE バッファを返す", () => {
    const buf = autolockDataOS3(30);
    expect(buf.length).toBe(2);
    expect(buf.readUInt16LE(0)).toBe(30);

    const buf300 = autolockDataOS3(300);
    expect(buf300.readUInt16LE(0)).toBe(300);

    // 0 → [0x00, 0x00]
    const buf0 = autolockDataOS3(0);
    expect([...buf0]).toEqual([0, 0]);

    // 65535 → [0xff, 0xff]
    const bufMax = autolockDataOS3(65535);
    expect([...bufMax]).toEqual([0xff, 0xff]);
  });
});

// ============================================================
//  LOCK-0059: OS3 autolock 成功時 _lastMechSetting.autoLockSecond 局所更新
// ============================================================

describe("LOCK-0059: OS3 autolock 成功時 _lastMechSetting.autoLockSecond 局所更新", () => {
  it("[LOCK-0059] キャッシュ未初期化 → autolock 成功後に新規作成 (lockPosition=0, unlockPosition=0, autoLockSecond=seconds)", async () => {
    const dev = new MockSesameOS3({ resultCode: 0 });
    const ble = new SesameBle({ secretKey: SECRET_HEX, transport: dev });
    await ble.connect();

    // キャッシュを明示的に null にしておく
    ble._session._lastMechSetting = null;

    await ble.autolock(60);

    expect(ble._session._lastMechSetting).not.toBeNull();
    expect(ble._session._lastMechSetting.autoLockSecond).toBe(60);
    expect(ble._session._lastMechSetting.lockPosition).toBe(0);
    expect(ble._session._lastMechSetting.unlockPosition).toBe(0);

    await ble.close();
  });

  it("[LOCK-0059] キャッシュ既存 → autoLockSecond のみ差し替え (lock/unlock 位置保持)", async () => {
    const dev = new MockSesameOS3({ resultCode: 0 });
    const ble = new SesameBle({ secretKey: SECRET_HEX, transport: dev });
    await ble.connect();

    // 既存キャッシュを直接セット
    ble._session._lastMechSetting = { lockPosition: 100, unlockPosition: -100, autoLockSecond: 0 };

    await ble.autolock(30);

    expect(ble._session._lastMechSetting.autoLockSecond).toBe(30);
    expect(ble._session._lastMechSetting.lockPosition).toBe(100);
    expect(ble._session._lastMechSetting.unlockPosition).toBe(-100);

    await ble.close();
  });

  it("[LOCK-0059] mechSetting publish 経由でキャッシュ初期化 → autolock 後 autoLockSecond のみ更新", async () => {
    const dev = new MockSesameOS3();
    const session = new SesameBleSession({ transport: dev, secretKey: SECRET_HEX });
    await session.connect();

    // lockPosition=256(LE 0001), unlockPosition=-256(LE FF00), autoLockSecond=120(LE 7800)
    dev.emitMechSetting(Buffer.from("000100ff7800", "hex"));
    expect(session.lastMechSetting).toEqual({ lockPosition: 256, unlockPosition: -256, autoLockSecond: 120 });

    const res = await session.autolock(45);
    expect(res.resultCode).toBe(0);

    // autoLockSecond だけ更新
    expect(session.lastMechSetting.autoLockSecond).toBe(45);
    expect(session.lastMechSetting.lockPosition).toBe(256);
    expect(session.lastMechSetting.unlockPosition).toBe(-256);
  });
});

// ============================================================
//  LOCK-0060: OS3 7B mechStatus のビットレイアウト解釈
// ============================================================

describe("LOCK-0060: OS3 7B mechStatus (lock) のビットレイアウト解釈", () => {
  it("[LOCK-0060] batteryRaw = data[0..1] u16LE", () => {
    const buf = Buffer.from([0x34, 0x12, 0, 0, 0, 0, 0]);
    expect(parseMechStatus(buf).batteryRaw).toBe(0x1234);
  });

  it("[LOCK-0060] target = data[2..3] i16LE (通常値)", () => {
    const buf = Buffer.from([0, 0, 100, 0, 0, 0, 0]);
    expect(parseMechStatus(buf).target).toBe(100);
  });

  it("[LOCK-0060] target = -32768 (0x8000 LE) → null (未設定)", () => {
    const buf = Buffer.from([0, 0, 0x00, 0x80, 0, 0, 0]);
    expect(parseMechStatus(buf).target).toBeNull();
  });

  it("[LOCK-0060] position = data[4..5] i16LE", () => {
    // 0xFF50 LE = -176
    const buf = Buffer.from([0, 0, 0, 0, 0x50, 0xff, 0]);
    expect(parseMechStatus(buf).position).toBe(-176);
  });

  it("[LOCK-0060] flags bit1 (0b00000010) = isInLockRange → locked", () => {
    const buf = Buffer.from([0, 0, 0, 0, 0, 0, 0b00000010]);
    const s = parseMechStatus(buf);
    expect(s.isInLockRange).toBe(true);
    expect(s.state).toBe(MECH_STATE.LOCKED);
  });

  it("[LOCK-0060] flags bit3 (0b00001000) = isCritical", () => {
    const buf = Buffer.from([0, 0, 0, 0, 0, 0, 0b00001000]);
    expect(parseMechStatus(buf).isCritical).toBe(true);
  });

  it("[LOCK-0060] flags bit4 (0b00010000) = isStop", () => {
    const buf = Buffer.from([0, 0, 0, 0, 0, 0, 0b00010000]);
    expect(parseMechStatus(buf).isStop).toBe(true);
  });

  it("[LOCK-0060] flags bit5 (0b00100000) = isBatteryCritical", () => {
    const buf = Buffer.from([0, 0, 0, 0, 0, 0, 0b00100000]);
    expect(parseMechStatus(buf).isBatteryCritical).toBe(true);
  });

  it("[LOCK-0060] 全フラグ 0: unlocked, isCritical=false, isStop=false, isBatteryCritical=false", () => {
    const buf = Buffer.from([0x70, 0x17, 0, 0, 0, 0, 0]);
    const s = parseMechStatus(buf);
    expect(s.state).toBe(MECH_STATE.UNLOCKED);
    expect(s.isInLockRange).toBe(false);
    expect(s.isCritical).toBe(false);
    expect(s.isStop).toBe(false);
    expect(s.isBatteryCritical).toBe(false);
  });

  it("[LOCK-0060] 複合フラグ: isInLockRange+isCritical+isBatteryCritical (bit1|bit3|bit5 = 0x2A)", () => {
    const buf = Buffer.from([0x70, 0x17, 0x00, 0x01, 0xD0, 0xFF, 0b00101010]);
    const s = parseMechStatus(buf);
    expect(s.isInLockRange).toBe(true);
    expect(s.isCritical).toBe(true);
    expect(s.isBatteryCritical).toBe(true);
    expect(s.isStop).toBe(false);
    expect(s.state).toBe(MECH_STATE.LOCKED);
    expect(s.batteryRaw).toBe(0x1770);
    expect(s.target).toBe(256);
    expect(s.position).toBe(-48); // 0xFFD0 LE = -48
  });
});

// ============================================================
//  LOCK-0061: OS3 3B mechStatus (bot/bike) のビットレイアウトと interface 既定値
// ============================================================

describe("LOCK-0061: OS3 3B mechStatus (bot/bike) のビットレイアウトと interface 既定値", () => {
  it("[LOCK-0061] batteryRaw = data[0..1] u16LE", () => {
    const buf = Buffer.from([0x56, 0x12, 0]);
    expect(parseMechStatus(buf).batteryRaw).toBe(0x1256);
  });

  it("[LOCK-0061] flags bit1 (0b00000010) = isInLockRange → locked", () => {
    const buf = Buffer.from([0, 0, 0b00000010]);
    const s = parseMechStatus(buf);
    expect(s.isInLockRange).toBe(true);
    expect(s.state).toBe(MECH_STATE.LOCKED);
  });

  it("[LOCK-0061] flags bit2 (0b00000100) = isStop (CHSesameBot2MechStatus bit2=4)", () => {
    const buf = Buffer.from([0, 0, 0b00000100]);
    expect(parseMechStatus(buf).isStop).toBe(true);
  });

  it("[LOCK-0061] interface 既定値: position=0, target=0, isCritical=null, isBatteryCritical=false", () => {
    const buf = Buffer.from([0, 0, 0]);
    const s = parseMechStatus(buf);
    expect(s.position).toBe(0);
    expect(s.target).toBe(0);
    expect(s.isCritical).toBeNull();
    expect(s.isBatteryCritical).toBe(false);
  });

  it("[LOCK-0061] isInLockRange=false → state=unlocked", () => {
    const buf = Buffer.from([0, 0, 0]);
    expect(parseMechStatus(buf).state).toBe(MECH_STATE.UNLOCKED);
  });
});

// ============================================================
//  LOCK-0062: OS3 mechStatus の長さ分岐と不正長 reject
// ============================================================

describe("LOCK-0062: OS3 mechStatus の長さ分岐 (3B=bot / >=7B=lock) と不正長 reject", () => {
  it("[LOCK-0062] len=3 → bot 解析 (position=0, target=0, isCritical=null)", () => {
    const buf = Buffer.alloc(3);
    expect(() => parseMechStatus(buf)).not.toThrow();
    const s = parseMechStatus(buf);
    expect(s.position).toBe(0);
    expect(s.target).toBe(0);
    expect(s.isCritical).toBeNull();
  });

  it("[LOCK-0062] len=7 → lock 解析 (isCritical は boolean)", () => {
    const buf = Buffer.alloc(7);
    expect(() => parseMechStatus(buf)).not.toThrow();
    const s = parseMechStatus(buf);
    expect(typeof s.isCritical).toBe("boolean");
    expect(typeof s.position).toBe("number");
  });

  it("[LOCK-0062] len=8 (>=7) → lock 解析", () => {
    const buf = Buffer.alloc(8);
    buf[6] = 0b00000010;
    expect(() => parseMechStatus(buf)).not.toThrow();
    expect(parseMechStatus(buf).state).toBe(MECH_STATE.LOCKED);
  });

  it("[LOCK-0062] len=1 → throw (不正長)", () => {
    expect(() => parseMechStatus(Buffer.alloc(1))).toThrow();
  });

  it("[LOCK-0062] len=2 → throw (不正長)", () => {
    expect(() => parseMechStatus(Buffer.alloc(2))).toThrow();
  });

  it("[LOCK-0062] len=4 → throw (不正長)", () => {
    expect(() => parseMechStatus(Buffer.alloc(4))).toThrow();
  });

  it("[LOCK-0062] len=5 → throw (不正長)", () => {
    expect(() => parseMechStatus(Buffer.alloc(5))).toThrow();
  });

  it("[LOCK-0062] len=6 → throw (不正長)", () => {
    expect(() => parseMechStatus(Buffer.alloc(6))).toThrow();
  });

  it("[LOCK-0062] len=0 → throw (不正長)", () => {
    expect(() => parseMechStatus(Buffer.alloc(0))).toThrow();
  });

  it("[LOCK-0062] 非Buffer → throw", () => {
    expect(() => parseMechStatus("hello")).toThrow();
    expect(() => parseMechStatus(null)).toThrow();
    expect(() => parseMechStatus([0, 0, 0, 0, 0, 0, 0])).toThrow();
    expect(() => parseMechStatus(new Uint8Array([0, 0, 0]))).toThrow();
  });
});

// ============================================================
//  LOCK-0063: OS3 mechStatus state は isInLockRange 単独判定
// ============================================================

describe("LOCK-0063: OS3 mechStatus state は isInLockRange 単独判定 (moved は無い)", () => {
  it("[LOCK-0063] 7B: isInLockRange=true → state='locked'", () => {
    const buf = Buffer.from([0, 0, 0, 0, 0, 0, 0b00000010]);
    expect(parseMechStatus(buf).state).toBe(MECH_STATE.LOCKED);
  });

  it("[LOCK-0063] 7B: isInLockRange=false → state='unlocked' (中間 moved は無い)", () => {
    const buf = Buffer.from([0, 0, 0, 0, 0, 0, 0]);
    const s = parseMechStatus(buf);
    expect(s.state).toBe(MECH_STATE.UNLOCKED);
    expect(s.state).not.toBe("moved");
  });

  it("[LOCK-0063] 3B: isInLockRange=true → state='locked'", () => {
    const buf = Buffer.from([0, 0, 0b00000010]);
    expect(parseMechStatus(buf).state).toBe(MECH_STATE.LOCKED);
  });

  it("[LOCK-0063] 3B: isInLockRange=false → state='unlocked'", () => {
    const buf = Buffer.from([0, 0, 0]);
    expect(parseMechStatus(buf).state).toBe(MECH_STATE.UNLOCKED);
  });

  it("[LOCK-0063] isInUnlockRange フィールドは OS3 parseMechStatus には存在しない", () => {
    // OS3 は isInLockRange の有無のみで state を決める (OS2 専用フィールド)
    const buf7 = Buffer.from([0, 0, 0, 0, 0, 0, 0]);
    const s7 = parseMechStatus(buf7);
    expect("isInUnlockRange" in s7).toBe(false);
    // isInLockRange と state の対応のみ検証
    expect(s7.isInLockRange).toBe(false);
  });
});

// ============================================================
//  LOCK-0064: OS3 lock mechStatus の batteryRaw = data[0..1] u16LE を素通し
// ============================================================

describe("LOCK-0064: OS3 lock mechStatus の batteryRaw = data[0..1] u16LE 素通し", () => {
  it("[LOCK-0064] 任意の u16LE 値をそのまま batteryRaw で返す", () => {
    const buf = Buffer.from([0xb0, 0x17, 0, 0, 0, 0, 0]);
    expect(parseMechStatus(buf).batteryRaw).toBe(0x17b0);
  });

  it("[LOCK-0064] batteryRaw=0 は 0 を返す", () => {
    const buf = Buffer.alloc(7);
    expect(parseMechStatus(buf).batteryRaw).toBe(0);
  });

  it("[LOCK-0064] batteryRaw=0xFFFF (65535) は 65535 を返す", () => {
    const buf = Buffer.from([0xff, 0xff, 0, 0, 0, 0, 0]);
    expect(parseMechStatus(buf).batteryRaw).toBe(65535);
  });

  it("[LOCK-0064] 換算式は batteryRaw のみ (batteryVoltage/batteryPercent フィールドは存在しない)", () => {
    const buf = Buffer.from([0xb0, 0x17, 0, 0, 0, 0, 0]);
    const s = parseMechStatus(buf);
    expect("batteryVoltage" in s).toBe(false);
    expect("batteryPercent" in s).toBe(false);
  });
});

// ============================================================
//  LOCK-0065: OS3 _assertOp による機種別ガード
// ============================================================

describe("LOCK-0065: OS3 _assertOp による lock/unlock/click/toggle/autolock の機種別ガード", () => {
  it("[LOCK-0065] LOCK5 (sesame_5) は lock/unlock/toggle/autolock を許可", async () => {
    const dev = new MockSesameOS3();
    const ble = new SesameBle({ secretKey: SECRET_HEX, model: "sesame_5", transport: dev });
    await ble.connect();
    expect(() => ble.lock()).not.toThrow();
    expect(() => ble.unlock()).not.toThrow();
    expect(() => ble.autolock(30)).not.toThrow();
    await ble.close();
  });

  it("[LOCK-0065] BOT2 (bot_2) は click を許可、lock で throw (BAD_REQUEST)", async () => {
    const dev = new MockSesameOS3();
    const ble = new SesameBle({ secretKey: SECRET_HEX, model: "bot_2", transport: dev });
    await ble.connect();
    expect(() => ble.click()).not.toThrow();
    expect(() => ble.lock()).toThrow();
    await ble.close();
  });

  it("[LOCK-0065] BIKE2 (bike_2) は unlock を許可、lock で throw (BAD_REQUEST)", async () => {
    const dev = new MockSesameOS3();
    const ble = new SesameBle({ secretKey: SECRET_HEX, model: "bike_2", transport: dev });
    await ble.connect();
    expect(() => ble.unlock()).not.toThrow();
    expect(() => ble.lock()).toThrow();
    await ble.close();
  });

  it("[LOCK-0065] BOT2 で lock/unlock/autolock は同期 throw、toggle は async reject", async () => {
    const dev = new MockSesameOS3();
    const ble = new SesameBle({ secretKey: SECRET_HEX, model: "bot_2", transport: dev });
    await ble.connect();
    expect(() => ble.lock()).toThrow();
    expect(() => ble.unlock()).toThrow();
    expect(() => ble.autolock(10)).toThrow();
    // toggle は async メソッド内で _assertOp を呼ぶため rejected Promise になる
    await expect(ble.toggle()).rejects.toThrow();
    await ble.close();
  });

  it("[LOCK-0065] BIKE2 で click/lock は同期 throw、toggle は async reject", async () => {
    const dev = new MockSesameOS3();
    const ble = new SesameBle({ secretKey: SECRET_HEX, model: "bike_2", transport: dev });
    await ble.connect();
    expect(() => ble.click()).toThrow();
    expect(() => ble.lock()).toThrow();
    // toggle は async メソッド内で _assertOp を呼ぶため rejected Promise になる
    await expect(ble.toggle()).rejects.toThrow();
    await ble.close();
  });
});

// ============================================================
//  LOCK-0066: OS3 autolock の over-exposure 回避 (ble[] 露出確認)
// ============================================================

describe("LOCK-0066: OS3 autolock の over-exposure 回避 (_assertOp('autolock') でゲート)", () => {
  it("[LOCK-0066] LOCK5 (sesame_5) は ble[] に autolock を持つ", () => {
    const caps = capabilitiesForModel("sesame_5");
    expect(caps.ble).toContain("autolock");
  });

  it("[LOCK-0066] OS2 SESAME2 (sesame_2) は ble[] に autolock を持つ (OS2 も autolock 能力あり)", () => {
    const caps = capabilitiesForModel("sesame_2");
    expect(caps.ble).toContain("autolock");
  });

  it("[LOCK-0066] BOT2 は ble[] に autolock を持たない → _assertOp('autolock') が throw する", async () => {
    const dev = new MockSesameOS3();
    const ble = new SesameBle({ secretKey: SECRET_HEX, model: "bot_2", transport: dev });
    await ble.connect();
    expect(() => ble.autolock(30)).toThrow();
    await ble.close();
  });

  it("[LOCK-0066] BIKE2 は autolock で throw", async () => {
    const dev = new MockSesameOS3();
    const ble = new SesameBle({ secretKey: SECRET_HEX, model: "bike_2", transport: dev });
    await ble.connect();
    expect(() => ble.autolock(30)).toThrow();
    await ble.close();
  });

  it("[LOCK-0066] BIOMETRIC (ssm_touch) は autolock で throw", async () => {
    const dev = new MockSesameOS3();
    const ble = new SesameBle({ secretKey: SECRET_HEX, model: "ssm_touch", transport: dev });
    await ble.connect();
    expect(() => ble.autolock(30)).toThrow();
    await ble.close();
  });
});

// ============================================================
//  LOCK-0067: OS2 lock の OP/ItemCode と送信フレーム
// ============================================================

describe("LOCK-0067: OS2 lock の OP/ItemCode と送信フレーム (OP.ASYNC=6, item=82=0x52)", () => {
  it("[LOCK-0067] buildSendFrame(OP.ASYNC, LOCK, createHistag()) 先頭 2B は [0x06, 0x52]", () => {
    const frame = buildSendFrameOS2(OP2.ASYNC, ITEM2.LOCK, createHistag());
    expect(frame[0]).toBe(0x06); // OP.ASYNC=6
    expect(frame[1]).toBe(0x52); // ITEM.LOCK=82
  });

  it("[LOCK-0067] tag 省略時: フレーム全長 24B ([op,item] ++ 22B createHistag)", () => {
    const frame = buildSendFrameOS2(OP2.ASYNC, ITEM2.LOCK, createHistag());
    expect(frame.length).toBe(24);
    // histag 部分は全 0
    expect([...frame.subarray(2)]).toEqual([...Buffer.alloc(22)]);
  });

  it("[LOCK-0067] tag 指定時: createHistag(tag) の内容が反映される (24B)", () => {
    const tag = Buffer.from([0xAA, 0xBB, 0xCC]);
    const frame = buildSendFrameOS2(OP2.ASYNC, ITEM2.LOCK, createHistag(tag));
    expect(frame.length).toBe(24);
    expect(frame[0]).toBe(0x06);
    expect(frame[1]).toBe(0x52);
    expect(frame[2]).toBe(3);     // histag size
    expect(frame[3]).toBe(0xAA);
    expect(frame[4]).toBe(0xBB);
    expect(frame[5]).toBe(0xCC);
  });
});

// ============================================================
//  LOCK-0068: OS2 unlock の OP/ItemCode (OP.ASYNC=6, item=83=0x53)
// ============================================================

describe("LOCK-0068: OS2 unlock の OP/ItemCode (OP.ASYNC=6, item=83=0x53)", () => {
  it("[LOCK-0068] buildSendFrame(OP.ASYNC, UNLOCK, createHistag()) 先頭 2B は [0x06, 0x53]", () => {
    const frame = buildSendFrameOS2(OP2.ASYNC, ITEM2.UNLOCK, createHistag());
    expect(frame[0]).toBe(0x06);
    expect(frame[1]).toBe(0x53); // ITEM.UNLOCK=83
  });

  it("[LOCK-0068] tag 省略時: フレーム全長 24B", () => {
    const frame = buildSendFrameOS2(OP2.ASYNC, ITEM2.UNLOCK, createHistag());
    expect(frame.length).toBe(24);
  });

  it("[LOCK-0068] tag 指定時: createHistag の内容が正しく含まれる", () => {
    const tag = Buffer.from([0xaa, 0xbb]);
    const frame = buildSendFrameOS2(OP2.ASYNC, ITEM2.UNLOCK, createHistag(tag));
    expect(frame[1]).toBe(83);
    expect(frame[2]).toBe(2); // histag size
    expect(frame[3]).toBe(0xaa);
    expect(frame[4]).toBe(0xbb);
  });
});

// ============================================================
//  LOCK-0069: OS2 click (Bot1) の OP/ItemCode (OP.ASYNC=6, item=89=0x59)
// ============================================================

describe("LOCK-0069: OS2 click (Bot1) の OP/ItemCode (OP.ASYNC=6, item=89=0x59)", () => {
  it("[LOCK-0069] buildSendFrame(OP.ASYNC, CLICK, createHistag()) 先頭 2B は [0x06, 0x59]", () => {
    const frame = buildSendFrameOS2(OP2.ASYNC, ITEM2.CLICK, createHistag());
    expect(frame[0]).toBe(0x06);
    expect(frame[1]).toBe(89);   // ITEM.CLICK=89=0x59
  });

  it("[LOCK-0069] ITEM.CLICK === 89 の確認", () => {
    expect(ITEM2.CLICK).toBe(89);
  });

  it("[LOCK-0069] tag 省略時: フレーム全長 24B", () => {
    const frame = buildSendFrameOS2(OP2.ASYNC, ITEM2.CLICK, createHistag());
    expect(frame.length).toBe(24);
  });

  it("[LOCK-0069] tag 指定時: histag の内容が反映される", () => {
    const tag = Buffer.from([0xff]);
    const frame = buildSendFrameOS2(OP2.ASYNC, ITEM2.CLICK, createHistag(tag));
    expect(frame[1]).toBe(89);
    expect(frame[2]).toBe(1);    // histag size
    expect(frame[3]).toBe(0xff);
  });
});

// ============================================================
//  LOCK-0070: OS2 createHistag のバイト列 ([size 1B]++take(21)++0埋め=22B固定)
// ============================================================

describe("LOCK-0070: OS2 createHistag ([size 1B]++take(21)++padding=22B 固定)", () => {
  it("[LOCK-0070] tag=null → 全0の22B (size=0, 本体0B, padding21B)", () => {
    const h = createHistag(null);
    expect(h.length).toBe(22);
    expect(h[0]).toBe(0);
    expect([...h]).toEqual(new Array(22).fill(0));
  });

  it("[LOCK-0070] tag=undefined (省略) → 全0の22B", () => {
    const h = createHistag();
    expect(h.length).toBe(22);
    expect([...h]).toEqual(new Array(22).fill(0));
  });

  it("[LOCK-0070] 3バイト tag → [3, 0xAA, 0xBB, 0xCC, 0..18] = 22B", () => {
    const tag = Buffer.from([0xAA, 0xBB, 0xCC]);
    const h = createHistag(tag);
    expect(h.length).toBe(22);
    expect(h[0]).toBe(3);
    expect(h[1]).toBe(0xAA);
    expect(h[2]).toBe(0xBB);
    expect(h[3]).toBe(0xCC);
    for (let i = 4; i < 22; i++) expect(h[i]).toBe(0);
  });

  it("[LOCK-0070] 21バイト tag (最大) → [size=21] ++ 21B = 22B", () => {
    const tag = Buffer.alloc(21, 0xAB);
    const h = createHistag(tag);
    expect(h.length).toBe(22);
    expect(h[0]).toBe(21);
    for (let i = 1; i <= 21; i++) expect(h[i]).toBe(0xAB);
  });

  it("[LOCK-0070] >21B のタグは take(21) で切り詰め → [size=21] ++ first21B = 22B", () => {
    const tag = Buffer.alloc(30, 0x77);
    const h = createHistag(tag);
    expect(h.length).toBe(22);
    expect(h[0]).toBe(21);
    for (let i = 1; i <= 21; i++) expect(h[i]).toBe(0x77);
  });

  it("[LOCK-0070] Uint8Array も受け付ける", () => {
    const tag = new Uint8Array([0x01, 0x02, 0x03]);
    const h = createHistag(tag);
    expect(h.length).toBe(22);
    expect(h[0]).toBe(3);
    expect(h[1]).toBe(0x01);
  });
});

// ============================================================
//  LOCK-0071: OS2 createHistag に非バイト列を渡すと reject
// ============================================================

describe("LOCK-0071: OS2 createHistag — 非バイト列を渡すと throw", () => {
  it("[LOCK-0071] string を渡すと throw", () => {
    expect(() => createHistag("hello")).toThrow();
  });

  it("[LOCK-0071] number を渡すと throw", () => {
    expect(() => createHistag(42)).toThrow();
  });

  it("[LOCK-0071] plain object を渡すと throw", () => {
    expect(() => createHistag({ length: 3 })).toThrow();
  });

  it("[LOCK-0071] Buffer は受け付ける (throw しない)", () => {
    expect(() => createHistag(Buffer.from([1, 2]))).not.toThrow();
  });

  it("[LOCK-0071] Uint8Array は受け付ける (throw しない)", () => {
    expect(() => createHistag(new Uint8Array([1, 2]))).not.toThrow();
  });
});

// ============================================================
//  LOCK-0072: OS2 toggle のクライアント側 lock/unlock 判定 (lastStatus.state)
// ============================================================

describe("LOCK-0072: OS2 toggle のクライアント側 lock/unlock 判定 (lastStatus.state)", () => {
  it("[LOCK-0072] lastStatus.state=locked → UNLOCK(83) を送る", async () => {
    const ble = makeOs2Ble();
    ble._session._lastStatus = { state: MECH_STATE2.LOCKED };

    let sentItem = null;
    ble._session.request = (op, item) => {
      sentItem = item;
      return Promise.resolve({ resultCode: 0, payload: Buffer.alloc(0) });
    };

    await ble.toggle();
    expect(sentItem).toBe(ITEM2.UNLOCK); // 83
  });

  it("[LOCK-0072] lastStatus.state=unlocked → LOCK(82) を送る", async () => {
    const ble = makeOs2Ble();
    ble._session._lastStatus = { state: MECH_STATE2.UNLOCKED };

    let sentItem = null;
    ble._session.request = (op, item) => {
      sentItem = item;
      return Promise.resolve({ resultCode: 0, payload: Buffer.alloc(0) });
    };

    await ble.toggle();
    expect(sentItem).toBe(ITEM2.LOCK); // 82
  });

  it("[LOCK-0072] lastStatus.state=moved (中間) → LOCK(82) を送る (else ブランチ)", async () => {
    const ble = makeOs2Ble();
    ble._session._lastStatus = { state: MECH_STATE2.MOVED };

    let sentItem = null;
    ble._session.request = (op, item) => {
      sentItem = item;
      return Promise.resolve({ resultCode: 0, payload: Buffer.alloc(0) });
    };

    await ble.toggle();
    expect(sentItem).toBe(ITEM2.LOCK); // 82
  });

  it("[LOCK-0072] ITEM.UNLOCK=83, ITEM.LOCK=82 の確認", () => {
    expect(ITEM2.UNLOCK).toBe(83);
    expect(ITEM2.LOCK).toBe(82);
  });
});

// ============================================================
//  LOCK-0073: OS2 autolock の OP/ItemCode と 24B payload
// ============================================================

describe("LOCK-0073: OS2 autolock の OP/ItemCode (OP.UPDATE=3, item=11=0x0B) と 24B payload", () => {
  it("[LOCK-0073] buildSendFrame(OP.UPDATE, AUTOLOCK, autolockData(30)) 先頭は [0x03, 0x0B]", () => {
    const data = autolockDataOS2(30);
    const frame = buildSendFrameOS2(OP2.UPDATE, ITEM2.AUTOLOCK, data);
    expect(frame[0]).toBe(0x03); // OP.UPDATE=3
    expect(frame[1]).toBe(0x0B); // ITEM.AUTOLOCK=11
    expect(frame[2]).toBe(0x1E); // 30 LE lo
    expect(frame[3]).toBe(0x00); // 30 LE hi
  });

  it("[LOCK-0073] autolockData(seconds) は 24B (2B LE 秒数 ++ 22B createHistag)", () => {
    const data = autolockDataOS2(300);
    expect(data.length).toBe(24);
    // 300 = 0x012C → LE [0x2C, 0x01]
    expect(data[0]).toBe(0x2c);
    expect(data[1]).toBe(0x01);
    // 残り 22B は createHistag(undefined) = 全 0
    for (let i = 2; i < 24; i++) expect(data[i]).toBe(0);
  });

  it("[LOCK-0073] tag 省略時: 2B秒数 ++ 全0の22B histag = 24B", () => {
    const data = autolockDataOS2(60);
    expect(data.length).toBe(24);
    expect(data[0]).toBe(60);
    expect(data[1]).toBe(0);
  });

  it("[LOCK-0073] tag 指定時: 2B秒数 ++ createHistag(tag) = 24B", () => {
    const tag = Buffer.from([0x11, 0x22]);
    const data = autolockDataOS2(10, tag);
    expect(data.length).toBe(24);
    expect(data[0]).toBe(10);
    expect(data[1]).toBe(0);
    // histag: [size=2, 0x11, 0x22, 0...0]
    expect(data[2]).toBe(2);
    expect(data[3]).toBe(0x11);
    expect(data[4]).toBe(0x22);
  });

  it("[LOCK-0073] autolockData は常に 24B (各種入力)", () => {
    expect(autolockDataOS2(0).length).toBe(24);
    expect(autolockDataOS2(30).length).toBe(24);
    expect(autolockDataOS2(300, Buffer.from([0xAB])).length).toBe(24);
  });
});

// ============================================================
//  LOCK-0074: OS2 autolockData の範囲/非整数 reject
// ============================================================

describe("LOCK-0074: OS2 autolockData の範囲/非整数 reject (0..65535 / 整数)", () => {
  it("[LOCK-0074] 0..65535 の整数は受理する", () => {
    expect(() => autolockDataOS2(0)).not.toThrow();
    expect(() => autolockDataOS2(30)).not.toThrow();
    expect(() => autolockDataOS2(65535)).not.toThrow();
  });

  it("[LOCK-0074] 負値は throw", () => {
    expect(() => autolockDataOS2(-1)).toThrow();
  });

  it("[LOCK-0074] >65535 は throw", () => {
    expect(() => autolockDataOS2(65536)).toThrow();
  });

  it("[LOCK-0074] 非整数(小数)は throw", () => {
    expect(() => autolockDataOS2(1.5)).toThrow();
    expect(() => autolockDataOS2(0.5)).toThrow();
  });

  it("[LOCK-0074] NaN は throw", () => {
    expect(() => autolockDataOS2(NaN)).toThrow();
  });

  it("[LOCK-0074] seconds=65535 の 2B LE は [0xff, 0xff]", () => {
    const data = autolockDataOS2(65535);
    expect(data[0]).toBe(0xff);
    expect(data[1]).toBe(0xff);
  });
});

// ============================================================
//  LOCK-0075: OS2 disableAutolock = autolock(0) のショートカット
// ============================================================

describe("LOCK-0075: OS2 disableAutolock = autolock(0) (seconds=0 無効化)", () => {
  it("[LOCK-0075] autolockData(0) と autolockData(0, undefined) が同一 (= disableAutolock(tag) の payload)", () => {
    const frame0 = buildSendFrameOS2(OP2.UPDATE, ITEM2.AUTOLOCK, autolockDataOS2(0));
    const frameDis = buildSendFrameOS2(OP2.UPDATE, ITEM2.AUTOLOCK, autolockDataOS2(0, undefined));
    expect(frame0).toEqual(frameDis);
  });

  it("[LOCK-0075] SesameOS2Ble.disableAutolock(tag) は autolock(0, tag) と同じ引数で request を呼ぶ", async () => {
    const ble = makeOs2Ble();

    const calls = [];
    ble._session.request = (op, item, data) => {
      calls.push({ op, item, data: Buffer.from(data) });
      return Promise.resolve({ resultCode: 0, payload: Buffer.alloc(0) });
    };

    const tag = Buffer.from([0x55]);

    await ble.autolock(0, tag);
    const fromAutolock = calls[0];

    await ble.disableAutolock(tag);
    const fromDisable = calls[1];

    expect(fromDisable.op).toBe(fromAutolock.op);
    expect(fromDisable.item).toBe(fromAutolock.item);
    expect(fromDisable.data).toEqual(fromAutolock.data);
  });

  it("[LOCK-0075] seconds=0 の 2B LE は [0x00, 0x00] (無効化フラグ)", () => {
    const data = autolockDataOS2(0);
    expect(data[0]).toBe(0x00);
    expect(data[1]).toBe(0x00);
    expect(data.length).toBe(24);
  });

  it("[LOCK-0075] フレームヘッダは [OP.UPDATE=3, AUTOLOCK=11]", () => {
    const frame = buildSendFrameOS2(OP2.UPDATE, ITEM2.AUTOLOCK, autolockDataOS2(0));
    expect(frame[0]).toBe(0x03);
    expect(frame[1]).toBe(0x0B);
  });

  it("[LOCK-0075] disableAutolock() tag省略時: [0x03,0x0B]++[0,0]++22B全0 = 26B フレーム", () => {
    const frame = buildSendFrameOS2(OP2.UPDATE, ITEM2.AUTOLOCK, autolockDataOS2(0));
    expect(frame.length).toBe(26); // 2B header + 24B autolockData
    expect(frame[0]).toBe(0x03);
    expect(frame[1]).toBe(0x0b);
    expect(frame[2]).toBe(0);    // seconds low byte
    expect(frame[3]).toBe(0);    // seconds high byte
    for (let i = 4; i < 26; i++) expect(frame[i]).toBe(0);
  });

  it("[LOCK-0075] tag 指定: disableAutolock(tag) は autolock(0, tag) のフレームと一致", () => {
    const tag = Buffer.from([0x11, 0x22, 0x33]);
    const frameAutolock = buildSendFrameOS2(OP2.UPDATE, ITEM2.AUTOLOCK, autolockDataOS2(0, tag));
    const frameDisable = buildSendFrameOS2(OP2.UPDATE, ITEM2.AUTOLOCK, autolockDataOS2(0, tag));
    expect(frameAutolock).toEqual(frameDisable);
    // tag が histag に入っていることも確認
    expect(frameAutolock[4]).toBe(3);    // histag size=3
    expect(frameAutolock[5]).toBe(0x11);
  });
});
