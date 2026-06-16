// spec: ble-os2.md — BLE2-0037..BLE2-0058 (selected 18 IDs)
// TDD: assert に spec の期待値を置く。実装が spec と食い違う場合は red になってよい。
// IDs: BLE2-0037 BLE2-0038 BLE2-0039 BLE2-0040 BLE2-0041 BLE2-0042 BLE2-0043
//      BLE2-0044 BLE2-0045 BLE2-0046 BLE2-0047 BLE2-0052 BLE2-0053 BLE2-0054
//      BLE2-0055 BLE2-0056 BLE2-0057 BLE2-0058

import { describe, it, expect, vi, afterEach } from "vitest";
import { Buffer } from "node:buffer";
import {
  parseMechStatus,
  MECH_STATE,
  timePhoneData,
} from "../../src/ble/os2/protocol.js";
import { SesameOS2BleSession, BleResultError } from "../../src/ble/os2/session.js";
import { SesameOS2Ble } from "../../src/ble/os2/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an 8-byte mech_status_t buffer.
 * Layout (CHSesame2MechStatus / CHSesameBotMechStatus):
 *   [0..1] batteryRaw LE u16
 *   [2..3] target     LE i16
 *   [4..5] position   LE i16  (Bot: [4]=motorStatus)
 *   [6]   retCode
 *   [7]   flags  (bit0=isStop[bot/bike], bit1=isInLockRange, bit2=isInUnlockRange, bit5=isBatteryCritical)
 */
function makeMechBuf({ battery = 0x0c10, targetRaw = 0, positionRaw = 0, motorStatus = 0, retCode = 0, flags = 0 } = {}) {
  const buf = Buffer.alloc(8);
  buf.writeUInt16LE(battery, 0);
  buf.writeInt16LE(targetRaw, 2);
  buf.writeInt16LE(positionRaw, 4);
  buf[4] = motorStatus;   // for Bot: motorStatus overwrites lower byte of position field
  buf[6] = retCode;
  buf[7] = flags;
  return buf;
}

/**
 * Make a minimal working transport stub.
 * connect() resolves immediately, write() is a no-op, disconnect() resolves immediately.
 */
function makeTransport({ connectImpl } = {}) {
  return {
    connect: connectImpl ?? (async () => {}),
    write: () => {},
    disconnect: async () => {},
  };
}

/**
 * Make a SesameOS2BleSession with a ready transport.
 */
function makeSession({ model = null, secretKey = "0102030405060708090a0b0c0d0e0f10", ssmPublicKey = null, connectImpl } = {}) {
  const transport = makeTransport({ connectImpl });
  return new SesameOS2BleSession({
    transport,
    secretKey,
    ssmPublicKey: ssmPublicKey ?? Buffer.alloc(64),
    model,
  });
}

// ---------------------------------------------------------------------------
// [BLE2-0037] mechStatus state 3値判定 (locked/unlocked/moved) os2lock
// ---------------------------------------------------------------------------
describe("[BLE2-0037] mechStatus state 3-value judgment (locked/unlocked/moved) — os2lock", () => {
  it("[BLE2-0037] isInLockRange=true → state=LOCKED (CHSesame2Device.kt:551)", () => {
    // flags bit1=isInLockRange=true
    const buf = makeMechBuf({ flags: 0b00000010 });
    const s = parseMechStatus(buf, { kind: "os2lock" });
    expect(s.state).toBe(MECH_STATE.LOCKED);
    expect(s.isInLockRange).toBe(true);
  });

  it("[BLE2-0037] isInUnlockRange=true, isInLockRange=false → state=UNLOCKED", () => {
    // flags bit2=isInUnlockRange=true
    const buf = makeMechBuf({ flags: 0b00000100 });
    const s = parseMechStatus(buf, { kind: "os2lock" });
    expect(s.state).toBe(MECH_STATE.UNLOCKED);
    expect(s.isInUnlockRange).toBe(true);
  });

  it("[BLE2-0037] both range flags=0 → state=MOVED (else branch, CHSesame2Device.kt:551)", () => {
    const buf = makeMechBuf({ flags: 0b00000000 });
    const s = parseMechStatus(buf, { kind: "os2lock" });
    expect(s.state).toBe(MECH_STATE.MOVED);
  });

  it("[BLE2-0037] kind 指定なし (既定 os2lock) — 両 range=0 → MOVED", () => {
    const buf = makeMechBuf({ flags: 0x00 });
    const s = parseMechStatus(buf);
    expect(s.state).toBe(MECH_STATE.MOVED);
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0038] mechStatus kind=os2lock の isStop は null (Sesame2/3/4)
// ---------------------------------------------------------------------------
describe("[BLE2-0038] mechStatus kind=os2lock → isStop=null (CHSesame2.kt:40)", () => {
  it("[BLE2-0038] os2lock: isStop は null (CHSesame2.kt:40 明示 null)", () => {
    const buf = makeMechBuf({ flags: 0x00 });
    const s = parseMechStatus(buf, { kind: "os2lock" });
    expect(s.isStop).toBeNull();
  });

  it("[BLE2-0038] flags bit0=1 でも os2lock では isStop=null (bit0 を読まない)", () => {
    const buf = makeMechBuf({ flags: 0x01 });
    const s = parseMechStatus(buf, { kind: "os2lock" });
    expect(s.isStop).toBeNull();
  });

  it("[BLE2-0038] no kind (default) → isStop=null (same as os2lock)", () => {
    const buf = makeMechBuf({ flags: 0x00 });
    const s = parseMechStatus(buf);
    expect(s.isStop).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0039] mechStatus kind=os2bot は state 2値 + motorStatus 由来 isStop
// ---------------------------------------------------------------------------
describe("[BLE2-0039] mechStatus kind=os2bot — state 2-value + motorStatus isStop (CHSesameBotDevice.kt:286-293,303)", () => {
  it("[BLE2-0039] os2bot: isInLockRange=true → LOCKED (CHSesameBotDevice.kt:303)", () => {
    const buf = makeMechBuf({ flags: 0b00000010 }); // bit1=isInLockRange
    const s = parseMechStatus(buf, { kind: "os2bot" });
    expect(s.state).toBe(MECH_STATE.LOCKED);
  });

  it("[BLE2-0039] os2bot: both range flags=0 → UNLOCKED (NOT moved, CHSesameBotDevice.kt:303)", () => {
    const buf = makeMechBuf({ flags: 0x00 });
    const s = parseMechStatus(buf, { kind: "os2bot" });
    expect(s.state).toBe(MECH_STATE.UNLOCKED);
    expect(s.state).not.toBe(MECH_STATE.MOVED);
  });

  it("[BLE2-0039] os2bot: motorStatus=0 (noPower) → isStop=true (CHSesameBotDevice.kt:287)", () => {
    // motorStatus occupies buf[4]
    const buf = Buffer.alloc(8);
    buf[4] = 0; // motorStatus=noPower
    buf[7] = 0x01; // flags bit0=1 (would be false in flags-based)
    const s = parseMechStatus(buf, { kind: "os2bot" });
    expect(s.isStop).toBe(true);
  });

  it("[BLE2-0039] os2bot: motorStatus=1 (forward) → isStop=false (CHSesameBotDevice.kt:288)", () => {
    const buf = Buffer.alloc(8);
    buf[4] = 1; // motorStatus=forward
    buf[7] = 0x00; // flags bit0=0 (would be true in flags-based)
    const s = parseMechStatus(buf, { kind: "os2bot" });
    expect(s.isStop).toBe(false);
  });

  it("[BLE2-0039] os2bot: motorStatus=2 (hold) → isStop=true (CHSesameBotDevice.kt:289)", () => {
    const buf = Buffer.alloc(8);
    buf[4] = 2;
    const s = parseMechStatus(buf, { kind: "os2bot" });
    expect(s.isStop).toBe(true);
  });

  it("[BLE2-0039] os2bot: motorStatus=3 (backward) → isStop=false (CHSesameBotDevice.kt:290)", () => {
    const buf = Buffer.alloc(8);
    buf[4] = 3;
    const s = parseMechStatus(buf, { kind: "os2bot" });
    expect(s.isStop).toBe(false);
  });

  it("[BLE2-0039] os2bot: motorStatus=4 (else) → isStop=false (CHSesameBotDevice.kt:291)", () => {
    const buf = Buffer.alloc(8);
    buf[4] = 4;
    const s = parseMechStatus(buf, { kind: "os2bot" });
    expect(s.isStop).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0040] mechStatus kind=os2bike は isStop=flags bit0 由来
// ---------------------------------------------------------------------------
describe("[BLE2-0040] mechStatus kind=os2bike → isStop=flags bit0 (CHSesameBot.kt:28 / CHSesameBikeDevice.kt:296)", () => {
  it("[BLE2-0040] os2bike: flags bit0=0 → isStop=true (flags and 1 == 0 → true)", () => {
    const buf = makeMechBuf({ flags: 0x00 }); // bit0=0
    expect(parseMechStatus(buf, { kind: "os2bike" }).isStop).toBe(true);
  });

  it("[BLE2-0040] os2bike: flags bit0=1 → isStop=false (flags and 1 == 0 → false)", () => {
    const buf = makeMechBuf({ flags: 0x01 }); // bit0=1
    expect(parseMechStatus(buf, { kind: "os2bike" }).isStop).toBe(false);
  });

  it("[BLE2-0040] os2bike: isStop は boolean (null ではない)", () => {
    const buf = makeMechBuf({ flags: 0x00 });
    const s = parseMechStatus(buf, { kind: "os2bike" });
    expect(typeof s.isStop).toBe("boolean");
    expect(s.isStop).not.toBeNull();
  });

  it("[BLE2-0040] os2bike: state は 3 値 (isInUnlockRange=true → UNLOCKED, CHSesameBikeDevice.kt:299)", () => {
    const buf = makeMechBuf({ flags: 0b00000100 }); // bit2=isInUnlockRange
    expect(parseMechStatus(buf, { kind: "os2bike" }).state).toBe(MECH_STATE.UNLOCKED);
    // both range=0 → MOVED (3-value like Sesame2)
    const bufMoved = makeMechBuf({ flags: 0x00 });
    expect(parseMechStatus(bufMoved, { kind: "os2bike" }).state).toBe(MECH_STATE.MOVED);
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0041] session が model から mechStatus kind を選ぶ (ssmbot_1/bike_1/既定)
// ---------------------------------------------------------------------------
describe("[BLE2-0041] SesameOS2BleSession selects mechStatus kind from model (session.js:556-564 / :690-695)", () => {
  it("[BLE2-0041] model=ssmbot_1 → session._model が 'ssmbot_1' (os2bot 分岐の前提)", () => {
    const session = makeSession({ model: "ssmbot_1" });
    expect(session._model).toBe("ssmbot_1");
  });

  it("[BLE2-0041] model=bike_1 → session._model が 'bike_1' (os2bike 分岐の前提)", () => {
    const session = makeSession({ model: "bike_1" });
    expect(session._model).toBe("bike_1");
  });

  it("[BLE2-0041] model=sesame_3 → session._model が 'sesame_3' (os2lock 既定)", () => {
    const session = makeSession({ model: "sesame_3" });
    expect(session._model).toBe("sesame_3");
  });

  it("[BLE2-0041] model=null → session._model=null (defaults to os2lock kind)", () => {
    const session = makeSession({ model: null });
    expect(session._model).toBeNull();
  });

  it("[BLE2-0041] ssmbot_1: parseMechStatus with kind=os2bot gives 2-value state (indirect verify)", () => {
    const buf = makeMechBuf({ flags: 0x00 }); // both ranges=0
    expect(parseMechStatus(buf, { kind: "os2bot" }).state).toBe(MECH_STATE.UNLOCKED); // not MOVED
  });

  it("[BLE2-0041] bike_1: parseMechStatus with kind=os2bike gives flags bit0 isStop (indirect verify)", () => {
    const buf = makeMechBuf({ flags: 0x00 }); // bit0=0
    expect(parseMechStatus(buf, { kind: "os2bike" }).isStop).toBe(true);
  });

  it("[BLE2-0041] sesame_3: parseMechStatus with kind=os2lock gives isStop=null (indirect verify)", () => {
    const buf = makeMechBuf({ flags: 0x01 });
    expect(parseMechStatus(buf, { kind: "os2lock" }).isStop).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0042] mechStatus position/target は raw と度数(*Deg)を併記
// ---------------------------------------------------------------------------
describe("[BLE2-0042] mechStatus position/target raw + positionDeg/targetDeg併記 (CHSesame2.kt:32-33)", () => {
  it("[BLE2-0042] position=512 → positionDeg=Math.trunc(512*360/1024)=180", () => {
    const buf = Buffer.alloc(8);
    buf.writeInt16LE(0, 2); // target=0
    buf.writeInt16LE(512, 4); // position=512
    const s = parseMechStatus(buf);
    expect(s.position).toBe(512);
    expect(s.positionDeg).toBe(Math.trunc((512 * 360) / 1024));
    expect(s.positionDeg).toBe(180);
  });

  it("[BLE2-0042] targetDeg = trunc(targetRaw * 360 / 1024) for non-MIN_VALUE target", () => {
    // targetRaw=256 → 256*360/1024 = 90.0 → 90
    const buf = Buffer.alloc(8);
    buf.writeInt16LE(256, 2); // target=256
    const s = parseMechStatus(buf);
    expect(s.target).toBe(256);
    expect(s.targetDeg).toBe(90);
  });

  it("[BLE2-0042] negative positionRaw → positionDeg rounds toward 0 (Math.trunc, CHSesame2.kt:32)", () => {
    // positionRaw=-100 → -100*360/1024 = -35.15... → trunc=-35
    const buf = Buffer.alloc(8);
    buf.writeInt16LE(-100, 4); // position
    const s = parseMechStatus(buf);
    expect(s.position).toBe(-100);
    expect(s.positionDeg).toBe(Math.trunc((-100 * 360) / 1024));
  });

  it("[BLE2-0042] target=-32768 (Short.MIN_VALUE) → target=null, targetDeg=null (CHSesame2.kt:33)", () => {
    // Short.MIN_VALUE sentinel means no target set
    const buf = Buffer.alloc(8);
    buf.writeInt16LE(-32768, 2); // target=MIN_VALUE
    const s = parseMechStatus(buf);
    expect(s.target).toBeNull();
    expect(s.targetDeg).toBeNull();
  });

  it("[BLE2-0042] position=1024 → positionDeg=360", () => {
    const buf = Buffer.alloc(8);
    buf.writeInt16LE(1024, 4); // position=1024 → positionDeg=360
    const s = parseMechStatus(buf);
    expect(s.position).toBe(1024);
    expect(s.positionDeg).toBe(360);
  });

  it("[BLE2-0042] raw と度数(Deg) は両方フィールドに存在する (SDK と kit の追加)", () => {
    const buf = Buffer.alloc(8);
    buf.writeInt16LE(100, 4); // position
    buf.writeInt16LE(200, 2); // target
    buf[7] = 0x02;
    const s = parseMechStatus(buf);
    expect("position" in s).toBe(true);
    expect("positionDeg" in s).toBe(true);
    expect("target" in s).toBe(true);
    expect("targetDeg" in s).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0043] mechStatus は自動履歴読み出しを行わない (意図的逸脱)
// ---------------------------------------------------------------------------
describe("[BLE2-0043] mechStatus publish does NOT auto-read history (intentional deviation, session.js:556-575)", () => {
  it("[BLE2-0043] session に readHistoryCommand / auto-history メソッドが存在しない (意図的逸脱)", () => {
    // SDK CHSesame2Device.kt:543-549 auto-fires readHistoryCommand on retCode!=0 or target==MIN_VALUE
    // kit intentionally does NOT implement this
    const session = makeSession({ model: "sesame_3" });
    expect(typeof session.readHistoryCommand).toBe("undefined");
    expect(typeof session._readHistoryCommand).toBe("undefined");
    expect(typeof session._autoReadHistory).toBe("undefined");
    expect(typeof session._autoHistory).toBe("undefined");
  });

  it("[BLE2-0043] parseMechStatus は retCode!=0 でも副作用なしで値を返す (純関数)", () => {
    // Verifying that parseMechStatus is a pure function with no side-effects
    const buf = makeMechBuf({ retCode: 1, flags: 0x00 }); // retCode!=0
    const s = parseMechStatus(buf, { kind: "os2lock" });
    expect(s.retCode).toBe(1);
    expect(s.state).toBeDefined();
  });

  it("[BLE2-0043] parseMechStatus with target==MIN_VALUE does not throw or auto-fire history", () => {
    // SDK would auto-fire readHistoryCommand when target==Short.MIN_VALUE(-32768) — kit does NOT
    const buf = Buffer.alloc(8);
    buf.writeInt16LE(-32768, 2); // target=MIN_VALUE
    const s = parseMechStatus(buf, { kind: "os2lock" });
    expect(s.target).toBeNull(); // sentinel still converted to null
    // No history auto-trigger — pure function
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0044] timePhone data は秒値の LE 4B (ms/1000)
// ---------------------------------------------------------------------------
describe("[BLE2-0044] timePhoneData = LE 4B seconds (ms/1000), NOT raw ms (protocol.js:683-685)", () => {
  it("[BLE2-0044] 固定 ms=1605929466482 → LE 4B [0xfa,0x89,0xb8,0x5f]", () => {
    // SDK DataExtention.kt:139 コメント: ms/1000=1605929466=0x5FB889FA → LE = fa89b85f
    const result = timePhoneData(1605929466482);
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBe(4);
    expect(result[0]).toBe(0xfa);
    expect(result[1]).toBe(0x89);
    expect(result[2]).toBe(0xb8);
    expect(result[3]).toBe(0x5f);
  });

  it("[BLE2-0044] timePhoneData encodes seconds (ms/1000) in LE (SDK DataExtention.kt:138-147)", () => {
    const nowMs = 1605929466482;
    const data = timePhoneData(nowMs);
    const expectedSec = Math.floor(nowMs / 1000);
    const expectedLE = Buffer.alloc(4);
    expectedLE.writeUInt32LE(expectedSec >>> 0, 0);
    expect(data).toEqual(expectedLE);
  });

  it("[BLE2-0044] ms=0 → LE 4B all zero", () => {
    const result = timePhoneData(0);
    expect(result.length).toBe(4);
    expect(result.readUInt32LE(0)).toBe(0);
  });

  it("[BLE2-0044] ms をそのまま使わず秒値を使う (ms を 1000 で割る)", () => {
    // ms と秒の両方でテストして混同がないことを確認
    const ms = 2000; // = 2 秒
    const result = timePhoneData(ms);
    expect(result.readUInt32LE(0)).toBe(2);
  });

  it("[BLE2-0044] timePhoneData default arg uses Date.now()", () => {
    const before = Math.floor(Date.now() / 1000);
    const data = timePhoneData();
    const after = Math.floor(Date.now() / 1000);
    const sec = data.readUInt32LE(0);
    expect(sec).toBeGreaterThanOrEqual(before);
    expect(sec).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0045] timePhone 送信条件: register 完了は無条件送信
// ---------------------------------------------------------------------------
describe("[BLE2-0045] timePhone sent unconditionally on register completion (session.js:750-755)", () => {
  it("[BLE2-0045] _maybeSyncTime('register') sends timePhone regardless of time error (direct _sendCipher spy)", () => {
    const session = makeSession({ model: "sesame_3" });
    const sentFrames = [];
    session._sendCipher = (frame) => sentFrames.push(frame);
    session._lastLoginResponse = { systemTime: Math.floor(Date.now() / 1000), fwVersion: 1 };
    session._maybeSyncTime("register");
    expect(sentFrames.length).toBe(1);
    // The frame: [OP.UPDATE=0x03, ITEM.TIMEPHONE=16]
    expect(sentFrames[0][0]).toBe(0x03); // OP.UPDATE
    expect(sentFrames[0][1]).toBe(16);   // ITEM.TIMEPHONE
  });

  it("[BLE2-0045] register timePhone は systemTime==now でも送る (timeError=0 でも無条件)", () => {
    const session = makeSession({ model: "sesame_3" });
    const sentFrames = [];
    session._sendCipher = (frame) => sentFrames.push(frame);
    const nowSec = Math.floor(Date.now() / 1000);
    session._lastLoginResponse = { systemTime: nowSec, fwVersion: 1 }; // timeError=0
    session._maybeSyncTime("register");
    expect(sentFrames.length).toBe(1); // unconditional
  });

  it("[BLE2-0045] register timePhone は fw_version=0 でも送る (fw ガード無し)", () => {
    const session = makeSession({ model: "sesame_3" });
    const sentFrames = [];
    session._sendCipher = (frame) => sentFrames.push(frame);
    const nowSec = Math.floor(Date.now() / 1000);
    session._lastLoginResponse = { systemTime: nowSec - 100, fwVersion: 0 }; // fw<1 but still sends
    session._maybeSyncTime("register");
    expect(sentFrames.length).toBe(1); // unconditional, no fw guard on register
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0046] timePhone 送信条件: Sesame2/3/4 は abs(timeError)>3 かつ fw>=1
// ---------------------------------------------------------------------------
describe("[BLE2-0046] timePhone for Sesame2/3/4: abs(timeError)>3 AND fw>=1 (session.js:771-780 / CHSesame2Device.kt:261-264)", () => {
  function makeLoginSession(model = "sesame_3") {
    const session = makeSession({ model });
    session._sendCipher = vi.fn();
    return session;
  }

  it("[BLE2-0046] abs(timeError)>3 かつ fw>=1 → 送信する (CHSesame2Device.kt:261-264)", () => {
    const session = makeLoginSession("sesame_2");
    const nowSec = Math.floor(Date.now() / 1000);
    session._lastLoginResponse = { systemTime: nowSec - 10, fwVersion: 1 }; // timeError=10>3, fw=1>=1
    session._maybeSyncTime("login-response");
    expect(session._sendCipher).toHaveBeenCalledTimes(1);
    const frame = session._sendCipher.mock.calls[0][0];
    expect(frame[0]).toBe(0x03); // OP.UPDATE
    expect(frame[1]).toBe(16);   // ITEM.TIMEPHONE
  });

  it("[BLE2-0046] abs(timeError)>3 かつ fw<1 → 送信しない (fw ガード)", () => {
    const session = makeLoginSession("sesame_2");
    const nowSec = Math.floor(Date.now() / 1000);
    session._lastLoginResponse = { systemTime: nowSec - 10, fwVersion: 0 }; // timeError=10>3, fw=0<1
    session._maybeSyncTime("login-response");
    expect(session._sendCipher).not.toHaveBeenCalled();
  });

  it("[BLE2-0046] abs(timeError)<=3 → 送信しない (誤差が小さい)", () => {
    const session = makeLoginSession("sesame_3");
    const nowSec = Math.floor(Date.now() / 1000);
    session._lastLoginResponse = { systemTime: nowSec - 2, fwVersion: 5 }; // timeError=2<=3
    session._maybeSyncTime("login-response");
    expect(session._sendCipher).not.toHaveBeenCalled();
  });

  it("[BLE2-0046] 未来 (timeError=-10, abs=10>3): fw>=1 なら送信する", () => {
    // abs は使われる: device time > host time も同様に検証
    const session = makeLoginSession("sesame_4");
    const nowSec = Math.floor(Date.now() / 1000);
    session._lastLoginResponse = { systemTime: nowSec + 10, fwVersion: 2 }; // timeError=-10, abs=10>3
    session._maybeSyncTime("login-response");
    expect(session._sendCipher).toHaveBeenCalledTimes(1);
  });

  it("[BLE2-0046] timeError=3 (exactly) → 送信しない (>3 であること、>=3 ではない)", () => {
    const session = makeLoginSession("sesame_3");
    const nowSec = Math.floor(Date.now() / 1000);
    session._lastLoginResponse = { systemTime: nowSec - 3, fwVersion: 5 }; // timeError=3 not >3
    session._maybeSyncTime("login-response");
    expect(session._sendCipher).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0047] timePhone 送信条件: Bot/Bike は timeError>3 のみ (abs/fw ガード無し)
// ---------------------------------------------------------------------------
describe("[BLE2-0047] timePhone for Bot/Bike: timeError>3 only (no abs/fw guard, session.js:761-769)", () => {
  function makeBotBikeSession(model) {
    const session = makeSession({ model });
    session._sendCipher = vi.fn();
    return session;
  }

  it("[BLE2-0047] ssmbot_1: timeError=10>3 → 送信する", () => {
    const session = makeBotBikeSession("ssmbot_1");
    const nowSec = Math.floor(Date.now() / 1000);
    session._lastLoginResponse = { systemTime: nowSec - 10, fwVersion: 0 }; // fw=0 but no fw guard for bot
    session._maybeSyncTime("login-response");
    expect(session._sendCipher).toHaveBeenCalledTimes(1);
  });

  it("[BLE2-0047] bike_1: timeError>3 → 送信する (CHSesameBikeDevice.kt:355)", () => {
    const session = makeBotBikeSession("bike_1");
    const nowSec = Math.floor(Date.now() / 1000);
    session._lastLoginResponse = { systemTime: nowSec - 5, fwVersion: 0 };
    session._maybeSyncTime("login-response");
    expect(session._sendCipher).toHaveBeenCalledTimes(1);
  });

  it("[BLE2-0047] ssmbot_1: timeError=2<=3 → 送信しない", () => {
    const session = makeBotBikeSession("ssmbot_1");
    const nowSec = Math.floor(Date.now() / 1000);
    session._lastLoginResponse = { systemTime: nowSec - 2, fwVersion: 1 };
    session._maybeSyncTime("login-response");
    expect(session._sendCipher).not.toHaveBeenCalled();
  });

  it("[BLE2-0047] ssmbot_1: 未来(timeError=-10<0) → abs なし → 送信しない (CHSesameBotDevice.kt:464)", () => {
    // CHSesameBotDevice.kt:464: if (timeError > 3) — abs なし。未来は送らない。
    const session = makeBotBikeSession("ssmbot_1");
    const nowSec = Math.floor(Date.now() / 1000);
    session._lastLoginResponse = { systemTime: nowSec + 10, fwVersion: 1 }; // timeError=-10, not >3
    session._maybeSyncTime("login-response");
    expect(session._sendCipher).not.toHaveBeenCalled();
  });

  it("[BLE2-0047] bike_1: timeError=3 exactly → 送信しない (>3 のみ)", () => {
    const session = makeBotBikeSession("bike_1");
    const nowSec = Math.floor(Date.now() / 1000);
    session._lastLoginResponse = { systemTime: nowSec - 3, fwVersion: 0 };
    session._maybeSyncTime("login-response");
    expect(session._sendCipher).not.toHaveBeenCalled();
  });

  it("[BLE2-0047] ssmbot_1: fw=0 かつ timeError>3 → 送信する (Bot は fw ガード無し、Sesame2 と対照)", () => {
    const session = makeBotBikeSession("ssmbot_1");
    const nowSec = Math.floor(Date.now() / 1000);
    session._lastLoginResponse = { systemTime: nowSec - 10, fwVersion: 0 }; // fw<1 but bot doesn't care
    session._maybeSyncTime("login-response");
    expect(session._sendCipher).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0052] request は未 login で reject、resultCode!=0 は BleResultError
// ---------------------------------------------------------------------------
describe("[BLE2-0052] request() rejects when not logged in; resultCode!=0 → BleResultError (session.js:443-456 / :795-806)", () => {
  it("[BLE2-0052] _loggedIn=false で request() を呼ぶと即 reject", async () => {
    const session = makeSession();
    expect(session._loggedIn).toBe(false);
    await expect(
      session.request(0x06, 0x52, Buffer.alloc(0))
    ).rejects.toThrow(/not logged in/i);
  });

  it("[BLE2-0052] _resolvePending: resultCode=0 → resolve with {resultCode, payload}", () => {
    const session = makeSession();
    const payload = Buffer.from([0xAA, 0xBB]);
    let resolved;
    const itemCode = 0x52;
    const entry = {
      resolve: (v) => { resolved = v; },
      reject: () => {},
      timer: setTimeout(() => {}, 10000),
    };
    session._pending.set(itemCode, [entry]);
    session._resolvePending(itemCode, 0, payload);
    clearTimeout(entry.timer);
    expect(resolved).toBeDefined();
    expect(resolved.resultCode).toBe(0);
    expect(resolved.payload).toEqual(payload);
  });

  it("[BLE2-0052] _resolvePending: resultCode!=0 → rejects with BleResultError", () => {
    const session = makeSession();
    let rejectedErr;
    const itemCode = 0x52;
    const entry = {
      resolve: () => {},
      reject: (e) => { rejectedErr = e; },
      timer: setTimeout(() => {}, 10000),
    };
    session._pending.set(itemCode, [entry]);
    session._resolvePending(itemCode, 3, Buffer.alloc(0)); // resultCode=3 (busy)
    clearTimeout(entry.timer);
    expect(rejectedErr).toBeInstanceOf(BleResultError);
    expect(rejectedErr.resultCode).toBe(3);
  });

  it("[BLE2-0052] BleResultError は resultCode と resultName を持つ", () => {
    const err = new BleResultError("command", 2, 82);
    expect(err).toBeInstanceOf(Error);
    expect(err.resultCode).toBe(2);
    expect(typeof err.resultName).toBe("string");
    expect(err.resultName.length).toBeGreaterThan(0);
    expect(err.name).toBe("BleResultError");
    expect(err.itemCode).toBe(82);
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0053] write reject は fail-fast せず握りつぶす
// ---------------------------------------------------------------------------
describe("[BLE2-0053] _writeSeg suppresses write rejection (fire-and-forget, session.js:488-496)", () => {
  it("[BLE2-0053] transport.write が同期 throw しても _writeSeg は throw しない", () => {
    const transport = {
      connect: async () => {},
      write: () => { throw new Error("write error sync"); },
      disconnect: async () => {},
    };
    const session = new SesameOS2BleSession({
      transport,
      secretKey: "0102030405060708090a0b0c0d0e0f10",
      ssmPublicKey: Buffer.alloc(64),
    });
    expect(() => session._writeSeg(Buffer.from([0x01]))).not.toThrow();
  });

  it("[BLE2-0053] transport.write が Promise reject しても unhandledRejection を生じない", async () => {
    const transport = {
      connect: async () => {},
      write: () => Promise.reject(new Error("write rejected")),
      disconnect: async () => {},
    };
    const session = new SesameOS2BleSession({
      transport,
      secretKey: "0102030405060708090a0b0c0d0e0f10",
      ssmPublicKey: Buffer.alloc(64),
    });
    // _writeSeg 内で .catch を付けているため throw しない
    expect(() => session._writeSeg(Buffer.from([0x01]))).not.toThrow();
    // Give microtask queue a tick to process the rejection catch
    await new Promise((r) => setTimeout(r, 10));
    // If we get here without unhandledRejection, the test passes
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0054] transport 切断で pending/待機者を全て fail-fast
// ---------------------------------------------------------------------------
describe("[BLE2-0054] transport disconnect fails pending and waiters (session.js:390-431)", () => {
  it("[BLE2-0054] _handleTransportDisconnect rejects all pending requests", () => {
    const session = makeSession();
    const errors = [];
    const item1 = 0x52;
    const timer1 = setTimeout(() => {}, 10000);
    session._pending.set(item1, [{
      resolve: () => {},
      reject: (e) => errors.push(e),
      timer: timer1,
    }]);
    session._handleTransportDisconnect("link-lost");
    clearTimeout(timer1);
    expect(errors.length).toBe(1);
    // The error message is i18n-translated (ble.linkLost key); just verify it's an Error
    expect(errors[0]).toBeInstanceOf(Error);
  });

  it("[BLE2-0054] _handleTransportDisconnect rejects _loginWaiter", () => {
    const session = makeSession();
    let rejectedErr;
    const timer = setTimeout(() => {}, 10000);
    session._loginWaiter = {
      resolve: () => {},
      reject: (e) => { rejectedErr = e; },
      timer,
    };
    session._handleTransportDisconnect("link-lost");
    clearTimeout(timer);
    expect(rejectedErr).toBeDefined();
    expect(rejectedErr).toBeInstanceOf(Error);
  });

  it("[BLE2-0054] _failAllPending で _loggedIn=false にリセットされ waiter も null になる", () => {
    const session = makeSession();
    session._loggedIn = true;
    const timer = setTimeout(() => {}, 10000);
    session._loginWaiter = { resolve: () => {}, reject: () => {}, timer };
    session._failAllPending(new Error("test"));
    clearTimeout(timer);
    expect(session._loggedIn).toBe(false);
    expect(session._loginWaiter).toBeNull();
  });

  it("[BLE2-0054] _failAllPending で pending request が reject される", async () => {
    const session = makeSession();
    session._loggedIn = true;
    session._cipher = { encrypt: (f) => f };
    const p = session.request(0x06, 82, Buffer.alloc(0), { timeoutMs: 5000 });
    session._failAllPending(new Error("link lost"));
    await expect(p).rejects.toThrow("link lost");
  });

  it("[BLE2-0054] disconnect() は transport.disconnect を呼び _loggedIn=false にする", async () => {
    let disconnectCalled = false;
    const transport = {
      connect: async () => {},
      write: () => {},
      disconnect: async () => { disconnectCalled = true; },
    };
    const session = new SesameOS2BleSession({
      transport,
      secretKey: "0102030405060708090a0b0c0d0e0f10",
      ssmPublicKey: Buffer.alloc(64),
    });
    session._loggedIn = true;
    await session.disconnect();
    expect(disconnectCalled).toBe(true);
    expect(session._loggedIn).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0055] connect()/register() の transport.connect 失敗で孤児 Promise を抑制
// ---------------------------------------------------------------------------
describe("[BLE2-0055] transport.connect failure suppresses orphan Promise (session.js:200-210 / :267-277)", () => {
  it("[BLE2-0055] connect(): transport.connect 失敗 → throw し loginWaiter=null になる", async () => {
    const transport = {
      connect: async () => { throw new Error("BLE connect failed"); },
      write: () => {},
      disconnect: async () => {},
    };
    const session = new SesameOS2BleSession({
      transport,
      secretKey: "0102030405060708090a0b0c0d0e0f10",
      ssmPublicKey: Buffer.alloc(64),
    });
    await expect(session.connect()).rejects.toThrow("BLE connect failed");
    expect(session._loginWaiter).toBeNull();
  });

  it("[BLE2-0055] register(): transport.connect 失敗 → throw し readyWaiter=null になる", async () => {
    const transport = {
      connect: async () => { throw new Error("BLE connect failed in register"); },
      write: () => {},
      disconnect: async () => {},
    };
    // register 用 session: secretKey なし
    const session = new SesameOS2BleSession({ transport });
    const dummyRegisterServer = async () => ({ sig1: Buffer.alloc(4), st: Buffer.alloc(8), pubkey: Buffer.alloc(64) });
    await expect(
      session.register({ deviceUUID: "test-uuid", registerServer: dummyRegisterServer })
    ).rejects.toThrow("BLE connect failed in register");
    expect(session._readyWaiter).toBeNull();
  });

  it("[BLE2-0055] after connect failure, unhandledRejection does not propagate", async () => {
    const transport = {
      connect: async () => { throw new Error("fail"); },
      write: () => {},
      disconnect: async () => {},
    };
    const session = new SesameOS2BleSession({
      transport,
      secretKey: "0102030405060708090a0b0c0d0e0f10",
      ssmPublicKey: Buffer.alloc(64),
    });
    let unhandledRejection = false;
    const handler = () => { unhandledRejection = true; };
    process.on("unhandledRejection", handler);
    try {
      await session.connect().catch(() => {});
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandledRejection).toBe(false);
    } finally {
      process.off("unhandledRejection", handler);
    }
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0056] セッション再利用 (busy) は明示 reject (使い捨て)
// ---------------------------------------------------------------------------
describe("[BLE2-0056] session reuse (busy) → explicit reject (session.js:159-162 / :191 / :255)", () => {
  it("[BLE2-0056] _loggedIn=true で connect() → reject", async () => {
    const session = makeSession();
    session._loggedIn = true;
    await expect(session.connect()).rejects.toThrow(/already in use|busy/i);
  });

  it("[BLE2-0056] _loginWaiter が存在する状態で connect() → reject", async () => {
    const session = makeSession();
    const timer = setTimeout(() => {}, 9999);
    session._loginWaiter = { resolve: () => {}, reject: () => {}, timer };
    await expect(session.connect()).rejects.toThrow(/already in use|busy/i);
    clearTimeout(timer);
  });

  it("[BLE2-0056] _readyToRegister=true で connect() → reject", async () => {
    const session = makeSession();
    session._readyToRegister = true;
    await expect(session.connect()).rejects.toThrow(/already in use|busy/i);
  });

  it("[BLE2-0056] _readyWaiter が存在する状態で register() → reject", async () => {
    const session = new SesameOS2BleSession({ transport: makeTransport() });
    const timer = setTimeout(() => {}, 9999);
    session._readyWaiter = { resolve: () => {}, reject: () => {}, timer };
    const dummyRegisterServer = async () => ({});
    await expect(session.register({ deviceUUID: "uuid", registerServer: dummyRegisterServer })).rejects.toThrow(/already in use|busy/i);
    clearTimeout(timer);
  });

  it("[BLE2-0056] _isBusy() returns true when loggedIn=true", () => {
    const session = makeSession();
    session._loggedIn = true;
    expect(session._isBusy()).toBe(true);
  });

  it("[BLE2-0056] _isBusy() returns true when _registerWaiter is set", () => {
    const session = makeSession();
    const timer = setTimeout(() => {}, 10000);
    session._registerWaiter = { resolve: () => {}, reject: () => {}, timer };
    expect(session._isBusy()).toBe(true);
    clearTimeout(timer);
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0057] login response は publish 経路でも完了できる
// ---------------------------------------------------------------------------
describe("[BLE2-0057] login publish completes register or login (_handleLoginPublish, session.js:702-726)", () => {
  // Build a minimal 28B login payload
  function makeLoginPayload(systemTime = 1000) {
    const buf = Buffer.alloc(28);
    buf.writeUInt32LE(systemTime, 0);
    buf[4] = 1; // fwVersion
    return buf;
  }

  it("[BLE2-0057] _registerWaiter がある → 登録完了として resolve (CHSesameBotDevice.kt:270-305)", () => {
    const session = makeSession();
    let registerResolved = false;
    const timer = setTimeout(() => {}, 9999);
    session._registerWaiter = {
      resolve: () => { registerResolved = true; },
      reject: () => {},
      timer,
    };
    // stub _maybeSyncTime to avoid cipher calls
    session._maybeSyncTime = () => {};
    session._handleLoginPublish(makeLoginPayload());
    clearTimeout(timer);
    expect(registerResolved).toBe(true);
    expect(session._loggedIn).toBe(true);
  });

  it("[BLE2-0057] _registerWaiter が無く _loginWaiter がある → login 完了として resolve", () => {
    const session = makeSession();
    let loginResolved = false;
    const timer = setTimeout(() => {}, 9999);
    session._loginWaiter = {
      resolve: () => { loginResolved = true; },
      reject: () => {},
      timer,
    };
    session._maybeSyncTime = () => {};
    session._handleLoginPublish(makeLoginPayload());
    clearTimeout(timer);
    expect(loginResolved).toBe(true);
    expect(session._loggedIn).toBe(true);
  });

  it("[BLE2-0057] _registerWaiter takes priority over _loginWaiter", () => {
    const session = makeSession();
    let registerResolved = false;
    let loginResolved = false;
    const timerR = setTimeout(() => {}, 9999);
    const timerL = setTimeout(() => {}, 9999);
    session._registerWaiter = {
      resolve: () => { registerResolved = true; },
      reject: () => {},
      timer: timerR,
    };
    session._loginWaiter = {
      resolve: () => { loginResolved = true; },
      reject: () => {},
      timer: timerL,
    };
    session._maybeSyncTime = () => {};
    session._handleLoginPublish(makeLoginPayload());
    clearTimeout(timerR);
    clearTimeout(timerL);
    // registerWaiter is resolved, loginWaiter stays pending (not resolved in this path)
    expect(registerResolved).toBe(true);
    expect(loginResolved).toBe(false);
  });

  it("[BLE2-0057] どちらの waiter もなければ何もしない (副作用なし)", () => {
    const session = makeSession();
    session._maybeSyncTime = () => {};
    session._loggedIn = false;
    expect(() => session._handleLoginPublish(makeLoginPayload())).not.toThrow();
    expect(session._loggedIn).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// [BLE2-0058] SesameOS2Ble は transport 必須・login 鍵素材ガード
// ---------------------------------------------------------------------------
describe("[BLE2-0058] SesameOS2Ble constructor guards (os2/index.js:66-95)", () => {
  const dummyTransport = {
    connect: async () => {},
    write: () => {},
    disconnect: async () => {},
  };

  it("[BLE2-0058] transport 未指定は throw", () => {
    expect(() => new SesameOS2Ble({})).toThrow(/transport required/i);
  });

  it("[BLE2-0058] transport 未指定(引数なし)は throw", () => {
    expect(() => new SesameOS2Ble()).toThrow(/transport required/i);
  });

  it("[BLE2-0058] registerMode=false/secretKey なし/needAuthFromServer=false → secretKey 必須 throw", () => {
    expect(() => new SesameOS2Ble({ transport: dummyTransport })).toThrow(/secretKey required/i);
  });

  it("[BLE2-0058] registerMode=true → secretKey 無しでも構築可 (register モード)", () => {
    expect(() => new SesameOS2Ble({ transport: dummyTransport, registerMode: true })).not.toThrow();
  });

  it("[BLE2-0058] secretKey 指定 → login モードで構築可", () => {
    expect(() => new SesameOS2Ble({
      transport: dummyTransport,
      secretKey: "0102030405060708090a0b0c0d0e0f10",
      ssmPublicKey: Buffer.alloc(64).toString("hex"),
    })).not.toThrow();
  });

  it("[BLE2-0058] needAuthFromServer=true → secretKey 無しでも構築可 (サーバ認証モード)", () => {
    expect(() => new SesameOS2Ble({ transport: dummyTransport, needAuthFromServer: true })).not.toThrow();
  });

  it("[BLE2-0058] registerMode 時は secretKey を session へ渡さない (session._secretKey=null)", () => {
    const facade = new SesameOS2Ble({
      transport: dummyTransport,
      registerMode: true,
      secretKey: "0102030405060708090a0b0c0d0e0f10", // registerMode なので session には渡さない
    });
    expect(facade._session._secretKey).toBeNull();
  });

  it("[BLE2-0058] secretKey provided → session receives secretKey (non-register mode)", () => {
    const ble = new SesameOS2Ble({
      transport: dummyTransport,
      secretKey: "0102030405060708090a0b0c0d0e0f10",
    });
    expect(ble._session._secretKey).not.toBeNull();
    expect(ble._session._secretKey.length).toBe(16);
  });
});
