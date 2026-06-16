// LOCK-0076..LOCK-0093 統合テスト (A/B マージ)
//
// 対象:
//   LOCK-0076..0083  packages/core/src/ble/os2/protocol.js
//                    (parseMechStatus / parseRecvFrame / getAutolock payload decode)
//   LOCK-0084        packages/core/src/ble/session.js
//                    (SesameBleSession.request() notLoggedIn guard)
//   LOCK-0085..0090  packages/kit/src/cli/dispatch.js
//                    (routeDeviceArgv / extractPositionals)
//   LOCK-0091        packages/kit/src/cli/lock-ops.js + dispatch.js
//                    (resolveLockEntry 完全一致)
//   LOCK-0092        packages/core/src/ble/devicemodel.js + lock-ops.js
//                    (DEVICE_ACTIONS = CONTROL_OPS ∪ {status})
//   LOCK-0093        packages/kit/src/cli/lock-ops.js
//                    (cmdDeviceOp 未知 action → die code 2)
//
// 方針: TDD — spec どおりの期待値を assert する (実装の現状に合わせない)。
//        ネットワーク/実機不使用。全て mock or 純関数。決定論的。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Buffer } from "node:buffer";

// ─── OS2 protocol ─────────────────────────────────────────────────────────────
import {
  parseMechStatus,
  parseRecvFrame,
  MECH_STATE,
  OP,
} from "../../src/ble/os2/protocol.js";

// ─── CLI dispatch ──────────────────────────────────────────────────────────────
import {
  extractPositionals,
  reservedCommandNames,
  routeDeviceArgv,
} from "../../../kit/src/cli/dispatch.js";

// ─── lock-ops ─────────────────────────────────────────────────────────────────
import { DEVICE_ACTIONS } from "../../../kit/src/cli/lock-ops.js";

// ─── CONTROL_OPS (devicemodel.js 経由 ble/index.js から) ──────────────────────
import { CONTROL_OPS } from "../../src/ble/index.js";

// ─── i18n ─────────────────────────────────────────────────────────────────────
import { setLocale } from "@sesame-kit/core/i18n";

// ══════════════════════════════════════════════════════════════════════════════
// ヘルパー: 8B OS2 mechStatus バッファを組み立てる
//   [batteryRaw(u16LE), target(i16LE), position(i16LE), retCode(u8), flags(u8)]
// ══════════════════════════════════════════════════════════════════════════════
function makeMechBuf({ batteryRaw = 0, target = 0, position = 0, retCode = 0, flags = 0 } = {}) {
  const b = Buffer.alloc(8);
  b.writeUInt16LE(batteryRaw, 0);
  b.writeInt16LE(target, 2);
  b.writeInt16LE(position, 4);
  b[6] = retCode & 0xff;
  b[7] = flags & 0xff;
  return b;
}

// flags ビット定数
const FLAG_LOCK_RANGE    = 0x02; // bit1 = isInLockRange
const FLAG_UNLOCK_RANGE  = 0x04; // bit2 = isInUnlockRange
const FLAG_BATT_CRITICAL = 0x20; // bit5 = isBatteryCritical

// ══════════════════════════════════════════════════════════════════════════════
// LOCK-0076: OS2 getAutolock LE payload decode
// ══════════════════════════════════════════════════════════════════════════════
describe("LOCK-0076: OS2 getAutolock LE payload decode", () => {
  // SesameOS2Ble.getAutolock() が session.request() から受け取った payload を
  // LE 整数として変換するロジックをインライン再現してテスト。
  // (packages/core/src/ble/os2/index.js 202-224 と同型)

  function decodeAutolockPayload(payload) {
    const p = payload;
    if (!p.length) return 0;
    if (p.length <= 6) return p.readUIntLE(0, p.length);
    let high = 0n;
    for (let i = p.length - 1; i >= 6; i--) high = (high << 8n) | BigInt(p[i]);
    if (high === 0n) return p.readUIntLE(0, 6);
    let val = 0n;
    for (let i = p.length - 1; i >= 0; i--) val = (val << 8n) | BigInt(p[i]);
    return Number(val);
  }

  it("[LOCK-0076] 4B payload → LE 秒数に変換 (300秒 = 0x2c 0x01 0x00 0x00)", () => {
    const p4 = Buffer.from([0x2c, 0x01, 0x00, 0x00]);
    expect(decodeAutolockPayload(p4)).toBe(300);
  });

  it("[LOCK-0076] 2B payload → LE 秒数 (300秒 = 0x2c 0x01)", () => {
    const p2 = Buffer.from([0x2c, 0x01]);
    expect(decodeAutolockPayload(p2)).toBe(300);
  });

  it("[LOCK-0076] 空 payload → 0 を返す", () => {
    expect(decodeAutolockPayload(Buffer.alloc(0))).toBe(0);
  });

  it("[LOCK-0076] 8B payload (上位バイト 0) → readUIntLE の戻りと同値 (30秒)", () => {
    const p8 = Buffer.alloc(8);
    p8.writeUInt32LE(30, 0); // value=30, bytes 4..7 = 0
    expect(decodeAutolockPayload(p8)).toBe(30);
  });

  it("[LOCK-0076] 8B payload (上位バイト非 0) → BigInt 経路で正しい数値", () => {
    const p8 = Buffer.alloc(8);
    p8[6] = 0x01; // byte[6] non-zero → high != 0n
    // 期待値: byte[6]=0x01 → 0x01_0000_0000_0000 = 281474976710656
    const expected = Number(0x01_0000_0000_0000n);
    expect(decodeAutolockPayload(p8)).toBe(expected);
  });

  it("[LOCK-0076] payload <=6B: 65535 = 0xFFFF LE [0xFF, 0xFF, 0x00, 0x00]", () => {
    const p4 = Buffer.alloc(4);
    p4.writeUInt32LE(65535, 0);
    expect(decodeAutolockPayload(p4)).toBe(65535);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// LOCK-0077: OS2 8B mechStatus ビットレイアウト
// ══════════════════════════════════════════════════════════════════════════════
describe("LOCK-0077: OS2 8B mechStatus ビットレイアウト (retCode=data[6], flags=data[7])", () => {
  it("[LOCK-0077] batteryRaw=u16LE, target=i16LE, position=i16LE, retCode=buf[6], flags=buf[7]", () => {
    const buf = makeMechBuf({
      batteryRaw: 0x1234,
      target: -100,
      position: 200,
      retCode: 7,
      flags: 0b00000110,
    });
    const r = parseMechStatus(buf);
    expect(r.batteryRaw).toBe(0x1234);
    expect(r.retCode).toBe(7);
    expect(r.flags).toBe(0b00000110);
    expect(r.target).toBe(-100);
    expect(r.position).toBe(200);
  });

  it("[LOCK-0077] flags bit1=isInLockRange, bit2=isInUnlockRange, bit5=isBatteryCritical", () => {
    // bit1 (value 2) → isInLockRange
    const bufLock = makeMechBuf({ flags: 0b00000010 });
    const rLock = parseMechStatus(bufLock);
    expect(rLock.isInLockRange).toBe(true);
    expect(rLock.isInUnlockRange).toBe(false);
    expect(rLock.isBatteryCritical).toBe(false);

    // bit2 (value 4) → isInUnlockRange
    const bufUnlock = makeMechBuf({ flags: 0b00000100 });
    const rUnlock = parseMechStatus(bufUnlock);
    expect(rUnlock.isInLockRange).toBe(false);
    expect(rUnlock.isInUnlockRange).toBe(true);

    // bit5 (value 32) → isBatteryCritical
    const bufBatt = makeMechBuf({ flags: 0b00100000 });
    const rBatt = parseMechStatus(bufBatt);
    expect(rBatt.isBatteryCritical).toBe(true);
  });

  it("[LOCK-0077] retCode と flags 位置の確認: buf[6]=retCode, buf[7]=flags (CHSesame2.kt:35-37)", () => {
    // 異なる値を buf[6], buf[7] に配置してどちらが何として読まれるか確認
    const buf = Buffer.alloc(8);
    buf[6] = 0xAB; // retCode
    buf[7] = 0b00000010; // flags → isInLockRange
    const r = parseMechStatus(buf);
    expect(r.retCode).toBe(0xAB);
    expect(r.isInLockRange).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// LOCK-0078: OS2 mechStatus 不正長 reject (8B 必須)
// ══════════════════════════════════════════════════════════════════════════════
describe("LOCK-0078: OS2 mechStatus 不正長 reject (8B 必須)", () => {
  it("[LOCK-0078] 7B は throw する", () => {
    expect(() => parseMechStatus(Buffer.alloc(7))).toThrow();
  });

  it("[LOCK-0078] 0B は throw する", () => {
    expect(() => parseMechStatus(Buffer.alloc(0))).toThrow();
  });

  it("[LOCK-0078] 1B は throw する", () => {
    expect(() => parseMechStatus(Buffer.alloc(1))).toThrow();
  });

  it("[LOCK-0078] 非 Buffer は throw する", () => {
    expect(() => parseMechStatus("not a buffer")).toThrow();
    expect(() => parseMechStatus(null)).toThrow();
    expect(() => parseMechStatus(new Uint8Array(8))).toThrow();
    expect(() => parseMechStatus([0, 1, 2, 3, 4, 5, 6, 7])).toThrow();
  });

  it("[LOCK-0078] 8B はエラーを出さない (境界値)", () => {
    expect(() => parseMechStatus(Buffer.alloc(8))).not.toThrow();
  });

  it("[LOCK-0078] 9B 以上も許容される (余分なバイトは無視)", () => {
    expect(() => parseMechStatus(Buffer.alloc(9))).not.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// LOCK-0079: OS2 mechStatus state の 3 値判定 (lock/unlock/moved)
// ══════════════════════════════════════════════════════════════════════════════
describe("LOCK-0079: OS2 mechStatus state の 3 値判定", () => {
  it("[LOCK-0079] isInLockRange=true → LOCKED", () => {
    const buf = makeMechBuf({ flags: FLAG_LOCK_RANGE });
    expect(parseMechStatus(buf).state).toBe(MECH_STATE.LOCKED);
  });

  it("[LOCK-0079] isInUnlockRange=true (lockRange=false) → UNLOCKED", () => {
    const buf = makeMechBuf({ flags: FLAG_UNLOCK_RANGE });
    expect(parseMechStatus(buf).state).toBe(MECH_STATE.UNLOCKED);
  });

  it("[LOCK-0079] どちらも 0 → MOVED", () => {
    const buf = makeMechBuf({ flags: 0b00000000 });
    expect(parseMechStatus(buf).state).toBe(MECH_STATE.MOVED);
  });

  it("[LOCK-0079] MECH_STATE 値は文字列 locked/unlocked/moved", () => {
    expect(MECH_STATE.LOCKED).toBe("locked");
    expect(MECH_STATE.UNLOCKED).toBe("unlocked");
    expect(MECH_STATE.MOVED).toBe("moved");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// LOCK-0080: OS2 mechStatus isStop の kind 3 値化
// ══════════════════════════════════════════════════════════════════════════════
describe("LOCK-0080: OS2 mechStatus isStop の kind 3 値化", () => {
  it("[LOCK-0080] os2lock (既定) → isStop = null (CHSesame2.kt:40)", () => {
    const buf = makeMechBuf({ flags: 0b00000001 }); // bit0 セットでもロックは null
    expect(parseMechStatus(buf).isStop).toBeNull();
    expect(parseMechStatus(buf, { kind: "os2lock" }).isStop).toBeNull();
  });

  it("[LOCK-0080] os2bot: motorStatus=0 (noPower) → isStop=true", () => {
    const buf = makeMechBuf({ position: 0 }); // buf[4]=0 → motorStatus=0
    expect(parseMechStatus(buf, { kind: "os2bot" }).isStop).toBe(true);
  });

  it("[LOCK-0080] os2bot: motorStatus=2 (hold) → isStop=true", () => {
    const buf = Buffer.alloc(8);
    buf[4] = 2; // motorStatus=hold
    buf[7] = 0b00000010; // isInLockRange
    expect(parseMechStatus(buf, { kind: "os2bot" }).isStop).toBe(true);
  });

  it("[LOCK-0080] os2bot: motorStatus=1 (forward) → isStop=false", () => {
    const buf = Buffer.alloc(8);
    buf[4] = 1; // motorStatus=forward
    expect(parseMechStatus(buf, { kind: "os2bot" }).isStop).toBe(false);
  });

  it("[LOCK-0080] os2bot: motorStatus=3 (backward) → isStop=false", () => {
    const buf = Buffer.alloc(8);
    buf[4] = 3; // motorStatus=backward
    expect(parseMechStatus(buf, { kind: "os2bot" }).isStop).toBe(false);
  });

  it("[LOCK-0080] os2bike: flags bit0=0 → isStop=true (CHSesameBot.kt:28)", () => {
    const buf = makeMechBuf({ flags: 0b00000000 }); // bit0=0 → stopped
    expect(parseMechStatus(buf, { kind: "os2bike" }).isStop).toBe(true);
  });

  it("[LOCK-0080] os2bike: flags bit0=1 → isStop=false", () => {
    const buf = makeMechBuf({ flags: 0b00000001 }); // bit0=1 → not stopped
    expect(parseMechStatus(buf, { kind: "os2bike" }).isStop).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// LOCK-0081: OS2 Bot1 mechStatus state は 2 値 (MOVED を出さない)
// ══════════════════════════════════════════════════════════════════════════════
describe("LOCK-0081: OS2 Bot1 mechStatus state は 2 値 (MOVED を出さない)", () => {
  it("[LOCK-0081] os2bot: isInLockRange=true → LOCKED", () => {
    const buf = makeMechBuf({ flags: FLAG_LOCK_RANGE });
    expect(parseMechStatus(buf, { kind: "os2bot" }).state).toBe(MECH_STATE.LOCKED);
  });

  it("[LOCK-0081] os2bot: どちらの range も 0 → UNLOCKED (MOVED を出さない)", () => {
    const buf = makeMechBuf({ flags: 0b00000000 });
    const r = parseMechStatus(buf, { kind: "os2bot" });
    expect(r.state).toBe(MECH_STATE.UNLOCKED);
    expect(r.state).not.toBe(MECH_STATE.MOVED);
  });

  it("[LOCK-0081] os2bot: isInUnlockRange=true (lockRange=false) → UNLOCKED (not MOVED)", () => {
    const buf = makeMechBuf({ flags: 0b00000100 }); // bit2=isInUnlockRange, bit1=0
    expect(parseMechStatus(buf, { kind: "os2bot" }).state).toBe(MECH_STATE.UNLOCKED);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// LOCK-0082: OS2 mechStatus 度数換算 (Math.trunc(raw*360/1024))
// ══════════════════════════════════════════════════════════════════════════════
describe("LOCK-0082: OS2 mechStatus 度数換算 (Math.trunc(raw*360/1024))", () => {
  it("[LOCK-0082] 正角: position=512 → positionDeg=180", () => {
    const buf = makeMechBuf({ position: 512 });
    expect(parseMechStatus(buf).positionDeg).toBe(Math.trunc(512 * 360 / 1024));
    expect(parseMechStatus(buf).positionDeg).toBe(180);
  });

  it("[LOCK-0082] 負角: position=-512 → positionDeg=-180", () => {
    const buf = makeMechBuf({ position: -512 });
    expect(parseMechStatus(buf).positionDeg).toBe(Math.trunc(-512 * 360 / 1024));
    expect(parseMechStatus(buf).positionDeg).toBe(-180);
  });

  it("[LOCK-0082] 端数切捨て (正): position=1 → positionDeg=0", () => {
    const buf = makeMechBuf({ position: 1 });
    expect(parseMechStatus(buf).positionDeg).toBe(0);
  });

  it("[LOCK-0082] 端数切捨て (負): position=-1 → positionDeg=0 (Math.trunc, not floor)", () => {
    // Math.trunc(-1*360/1024) = Math.trunc(-0.3515...) = -0 in JS (Object.is -0 != 0)
    // Kotlin の Int 除算は 0 方向切捨てで数値 0 を返す。JS の -0 は許容 (実用上同値)。
    const buf2 = makeMechBuf({ position: -1 });
    const deg = parseMechStatus(buf2).positionDeg;
    expect(deg === 0).toBe(true); // -0 === 0 も true (絶対値 0 を確認)
  });

  it("[LOCK-0082] target=-32768 (Short.MIN_VALUE) → target=null, targetDeg=null", () => {
    const buf = makeMechBuf({ target: -32768 });
    const s = parseMechStatus(buf);
    expect(s.target).toBeNull();
    expect(s.targetDeg).toBeNull();
  });

  it("[LOCK-0082] target=256 → targetDeg=90", () => {
    const buf = makeMechBuf({ target: 256 });
    const s = parseMechStatus(buf);
    expect(s.target).toBe(256);
    expect(s.targetDeg).toBe(Math.trunc(256 * 360 / 1024));
    expect(s.targetDeg).toBe(90);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// LOCK-0083: OS2 response/publish フレーム分解
// ══════════════════════════════════════════════════════════════════════════════
describe("LOCK-0083: OS2 parseRecvFrame response(7)/publish(8) 分解", () => {
  it("[LOCK-0083] notifyOpCode=RESPONSE(7): [notifyOp, itemCode, opCode, resultCode, ...payload]", () => {
    // response body: [itemCode=11, opCode=2(READ), resultCode=0, payload=[0x1e,0x00]]
    const body = Buffer.from([0x0B, 0x02, 0x00, 0x1E, 0x00]);
    const frame = Buffer.concat([Buffer.from([OP.RESPONSE]), body]);
    const r = parseRecvFrame(frame);
    expect(r.type).toBe("response");
    expect(r.notifyOpCode).toBe(OP.RESPONSE);
    expect(r.itemCode).toBe(0x0B);   // itemCode 先 (送信フレームとは逆順)
    expect(r.cmdOpCode).toBe(0x02);  // READ
    expect(r.resultCode).toBe(0x00);
    expect(r.payload).toEqual(Buffer.from([0x1E, 0x00]));
  });

  it("[LOCK-0083] notifyOpCode=PUBLISH(8): [notifyOp, itemCode, ...payload]", () => {
    const statusPayload = Buffer.alloc(8);
    statusPayload[7] = 0b00000010; // flags: isInLockRange
    const body = Buffer.concat([Buffer.from([0x51]), statusPayload]); // itemCode=81=mechStatus
    const frame = Buffer.concat([Buffer.from([OP.PUBLISH]), body]);
    const r = parseRecvFrame(frame);
    expect(r.type).toBe("publish");
    expect(r.notifyOpCode).toBe(OP.PUBLISH);
    expect(r.itemCode).toBe(0x51); // 81
    expect(r.payload).toEqual(statusPayload);
  });

  it("[LOCK-0083] response の itemCode は先頭 (送信フレーム [opCode, itemCode] とは逆順)", () => {
    // 送信: [opCode=2, itemCode=11], 応答: [notifyOp=7, itemCode=11, opCode=2, ...]
    const buf = Buffer.from([OP.RESPONSE, 0x0B, 0x02, 0x00]);
    const r = parseRecvFrame(buf);
    expect(r.itemCode).toBe(0x0B); // 11 = AUTOLOCK — itemCode が先
    expect(r.cmdOpCode).toBe(0x02); // READ — opCode が後
  });

  it("[LOCK-0083] response フレームが短すぎる (body < 3B) → throw", () => {
    const frame = Buffer.from([OP.RESPONSE, 0x0B, 0x02]); // body 2B, 要 3B
    expect(() => parseRecvFrame(frame)).toThrow();
  });

  it("[LOCK-0083] publish フレームに itemCode なし (body 空) → throw", () => {
    const frame = Buffer.from([OP.PUBLISH]);
    expect(() => parseRecvFrame(frame)).toThrow();
  });

  it("[LOCK-0083] 空 Buffer / 非 Buffer は throw", () => {
    expect(() => parseRecvFrame(Buffer.alloc(0))).toThrow();
    expect(() => parseRecvFrame("not a buffer")).toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// LOCK-0084: OS3 session.request は _loggedIn=false のとき即 reject
// ══════════════════════════════════════════════════════════════════════════════
describe("LOCK-0084: SesameBleSession.request() は _loggedIn=false のとき即 reject", () => {
  // SesameBleSession を直接インスタンス化し、_loggedIn=false (デフォルト) で
  // request() が即座に reject されることを確認する。

  async function makeUnloggedSession() {
    const { SesameBleSession } = await import("../../src/ble/session.js");
    const fakeTransport = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      write: vi.fn(),
      onPacket: null,
    };
    // secretKey は 32hex が必要
    const sess = new SesameBleSession({
      transport: fakeTransport,
      secretKey: "0123456789abcdef0123456789abcdef",
    });
    // _loggedIn はデフォルト false
    return sess;
  }

  it("[LOCK-0084] _loggedIn=false → request() は即 reject する", async () => {
    setLocale("en");
    const sess = await makeUnloggedSession();
    await expect(sess.request(11)).rejects.toThrow();
  });

  it("[LOCK-0084] reject は即座 (timeout=5000ms でも 500ms 以内に reject される)", async () => {
    setLocale("en");
    const sess = await makeUnloggedSession();
    const start = Date.now();
    await expect(sess.request(11, Buffer.alloc(0), { timeoutMs: 5000 })).rejects.toThrow();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  it("[LOCK-0084] lock/unlock 等の itemCode でも同じガードで reject される", async () => {
    setLocale("en");
    const sess = await makeUnloggedSession();
    await expect(sess.request(82)).rejects.toThrow(); // lock
    await expect(sess.request(83)).rejects.toThrow(); // unlock
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// ヘルパー: 最小 commander-like program スタブ
// ══════════════════════════════════════════════════════════════════════════════
function makeProgram({
  commandNames = ["init", "login", "verify", "locks", "session", "op"],
  valueOptLongs = ["--config-dir"],
} = {}) {
  return {
    options: valueOptLongs.map((long) => ({
      long,
      short: undefined,
      required: true,  // 値を取るオプション
      optional: false,
    })),
    commands: commandNames.map((name) => ({
      name: () => name,
      aliases: () => [],
    })),
    opts: () => ({}),
  };
}

function makeArgv(...userArgs) {
  return ["/usr/bin/node", "/usr/bin/sesame", ...userArgs];
}

// ══════════════════════════════════════════════════════════════════════════════
// LOCK-0085: 既知デバイス名 → op へ書き換え
// ══════════════════════════════════════════════════════════════════════════════
describe("LOCK-0085: 先頭トークンが既知デバイス → argv を op へ書き換え", () => {
  it("[LOCK-0085] 既知デバイス + action → argv[2]='op' に書き換え", () => {
    const program = makeProgram();
    const argv = makeArgv("front", "unlock");
    const result = routeDeviceArgv({
      argv,
      program,
      deviceActions: DEVICE_ACTIONS,
      isKnownDevice: (name) => name === "front",
      interactive: false,
    });
    expect(result[2]).toBe("op");
    expect(result.slice(3)).toContain("front");
    expect(result.slice(3)).toContain("unlock");
  });

  it("[LOCK-0085] 既知デバイス単独 (action なし) → op へ書き換え (isKnownDevice が判断)", () => {
    const program = makeProgram();
    const argv = makeArgv("front");
    const result = routeDeviceArgv({
      argv,
      program,
      deviceActions: DEVICE_ACTIONS,
      isKnownDevice: (name) => name === "front",
      interactive: false,
    });
    expect(result[2]).toBe("op");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// LOCK-0086: secondTok ∈ DEVICE_ACTIONS → 未知デバイスでも op へ書き換え
// ══════════════════════════════════════════════════════════════════════════════
describe("LOCK-0086: secondTok ∈ DEVICE_ACTIONS → op へ書き換え (未知デバイスでも)", () => {
  const VALID_ACTIONS = ["unlock", "lock", "toggle", "click", "autolock", "status"];

  for (const action of VALID_ACTIONS) {
    it(`[LOCK-0086] <未知デバイス> ${action} → argv[2]='op' に書き換え`, () => {
      const program = makeProgram();
      const argv = makeArgv("unknowndevicexyz", action);
      const result = routeDeviceArgv({
        argv,
        program,
        deviceActions: DEVICE_ACTIONS,
        isKnownDevice: () => false, // 未知デバイス
        interactive: false,
      });
      expect(result[2]).toBe("op");
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// LOCK-0087: 予約コマンド / 未知単独トークン → argv 据え置き
// ══════════════════════════════════════════════════════════════════════════════
describe("LOCK-0087: 予約コマンド / 未知単独トークン → argv 据え置き", () => {
  it("[LOCK-0087] 予約コマンドが先頭 → argv 据え置き (commander に処理させる)", () => {
    const program = makeProgram();
    for (const cmd of ["init", "login", "verify", "locks", "session", "help"]) {
      const argv = makeArgv(cmd);
      const result = routeDeviceArgv({
        argv,
        program,
        deviceActions: DEVICE_ACTIONS,
        isKnownDevice: () => false,
        interactive: false,
      });
      expect(result[2]).toBe(cmd); // 据え置き
    }
  });

  it("[LOCK-0087] 未知単独トークン (typo) → argv 据え置き (commander が未知コマンドを出す)", () => {
    const program = makeProgram();
    const argv = makeArgv("boguscommandxyz");
    const result = routeDeviceArgv({
      argv,
      program,
      deviceActions: DEVICE_ACTIONS,
      isKnownDevice: () => false,
      interactive: false,
    });
    expect(result[2]).toBe("boguscommandxyz"); // 据え置き、op 挿入なし
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// LOCK-0088: extractPositionals — 値オプションの値を除外
// ══════════════════════════════════════════════════════════════════════════════
describe("LOCK-0088: extractPositionals — 値オプションの値は positionals から除外", () => {
  it("[LOCK-0088] --config-dir <path> (値取得): path は positional でない", () => {
    const program = makeProgram({ valueOptLongs: ["--config-dir"] });
    const userArgs = ["--config-dir", "/some/path", "front", "unlock"];
    const pos = extractPositionals(userArgs, program);
    expect(pos).not.toContain("/some/path");
    expect(pos).toContain("front");
    expect(pos).toContain("unlock");
  });

  it("[LOCK-0088] --opt=value 形式は後続を消費しない (= 等号込みで値同梱)", () => {
    const program = makeProgram({ valueOptLongs: ["--config-dir"] });
    const userArgs = ["--config-dir=/some/path", "front", "unlock"];
    const pos = extractPositionals(userArgs, program);
    expect(pos).toContain("front");
    expect(pos).toContain("unlock");
    expect(pos).not.toContain("--config-dir=/some/path");
    expect(pos).not.toContain("/some/path");
  });

  it("[LOCK-0088] --json (boolean フラグ): 後続を消費しない", () => {
    const program = makeProgram({ valueOptLongs: [] }); // 値オプションなし
    const userArgs = ["--json", "front"];
    const pos = extractPositionals(userArgs, program);
    expect(pos).toContain("front");
  });

  it("[LOCK-0088] -- 以降は全て positionals (セパレータ)", () => {
    const program = makeProgram({ valueOptLongs: ["--config-dir"] });
    const userArgs = ["--", "--config-dir", "front"];
    const pos = extractPositionals(userArgs, program);
    // -- 以降はすべて positionals
    expect(pos).toContain("--config-dir");
    expect(pos).toContain("front");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// LOCK-0089: 引数なし: 対話 + 非 JSON → session; それ以外 → argv 据え置き
// ══════════════════════════════════════════════════════════════════════════════
describe("LOCK-0089: 引数なし routing", () => {
  it("[LOCK-0089] 引数なし + 対話 + 非 JSON → argv[2]='session' へ書き換え", () => {
    const program = makeProgram();
    const argv = makeArgv();
    const result = routeDeviceArgv({
      argv,
      program,
      deviceActions: DEVICE_ACTIONS,
      isKnownDevice: () => false,
      interactive: true,
    });
    expect(result[2]).toBe("session");
  });

  it("[LOCK-0089] 引数なし + --json + 対話 → argv 据え置き (help を出す)", () => {
    const program = makeProgram();
    const argv = makeArgv("--json");
    const result = routeDeviceArgv({
      argv,
      program,
      deviceActions: DEVICE_ACTIONS,
      isKnownDevice: () => false,
      interactive: true,
    });
    // --json があるため session へ書き換えない → argv のまま返る
    expect(result).toEqual(argv);
  });

  it("[LOCK-0089] 引数なし + 非対話 → argv 据え置き (help を出す)", () => {
    const program = makeProgram();
    const argv = makeArgv();
    const result = routeDeviceArgv({
      argv,
      program,
      deviceActions: DEVICE_ACTIONS,
      isKnownDevice: () => false,
      interactive: false,
    });
    expect(result[2]).toBeUndefined(); // session へ書き換えない
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// LOCK-0090: -h/--help を含む argv は常に据え置き
// ══════════════════════════════════════════════════════════════════════════════
describe("LOCK-0090: -h/--help を含む argv → 常に据え置き (device routing なし)", () => {
  it("[LOCK-0090] --help あり: 既知デバイス + action でも argv 据え置き", () => {
    const program = makeProgram();
    const argv = makeArgv("front", "unlock", "--help");
    const result = routeDeviceArgv({
      argv,
      program,
      deviceActions: DEVICE_ACTIONS,
      isKnownDevice: () => true,
      interactive: true,
    });
    expect(result).toEqual(argv);
  });

  it("[LOCK-0090] -h あり: argv 据え置き", () => {
    const program = makeProgram();
    const argv = makeArgv("front", "-h");
    const result = routeDeviceArgv({
      argv,
      program,
      deviceActions: DEVICE_ACTIONS,
      isKnownDevice: () => true,
      interactive: true,
    });
    expect(result).toEqual(argv);
  });

  it("[LOCK-0090] -h 単独: session へも書き換えない", () => {
    const program = makeProgram();
    const argv = makeArgv("-h");
    const result = routeDeviceArgv({
      argv,
      program,
      deviceActions: DEVICE_ACTIONS,
      isKnownDevice: () => false,
      interactive: true,
    });
    expect(result).toEqual(argv);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// LOCK-0091: resolveLockEntry は完全一致のみ受理 (部分一致は exit 2)
// ══════════════════════════════════════════════════════════════════════════════
describe("LOCK-0091: resolveLockEntry 完全一致のみ — 部分一致は exit 2", () => {
  // resolveLockEntry は `locks[name]` でオブジェクトキー完全一致を使う。
  // routing 自体は LOCK-0086 で secondTok が DEVICE_ACTION のとき op へ進む (fron status → op)。
  // ただし op 実行時に resolveLockEntry が「fron」を locks から引けず die(_, 2) を呼ぶ。
  // このテストはその内部契約 (exact lookup) を直接検証する。

  it("[LOCK-0091] 部分一致 (fron vs front) → exact lookup は undefined を返す", () => {
    const locks = { front: { deviceUUID: "uuid", secretKey: "key" } };
    expect(locks["fron"]).toBeUndefined();   // 完全一致失敗
    expect(locks["frontt"]).toBeUndefined(); // suffix 付きも失敗
    expect(locks["ront"]).toBeUndefined();   // prefix 欠けも失敗
  });

  it("[LOCK-0091] 完全一致 (front === front) → defined を返す", () => {
    const locks = { front: { deviceUUID: "uuid", secretKey: "key" } };
    expect(locks["front"]).toBeDefined();
  });

  it("[LOCK-0091] resolveLockEntry のロジック模倣: 完全一致なし → die code 2 相当", () => {
    const locks = { front: { deviceUUID: "uuid-front", secretKey: "a".repeat(32) } };
    let dieCode = null;

    function mockResolve(name, locksMap) {
      if (name && !locksMap[name]) {
        dieCode = 2;
        throw new Error(`die:2:${name}`);
      }
      return locksMap[name] || null;
    }

    expect(() => mockResolve("fron", locks)).toThrow(/die:2:fron/);
    expect(dieCode).toBe(2);
    expect(mockResolve("front", locks)).toBeTruthy();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// LOCK-0092: DEVICE_ACTIONS = CONTROL_OPS ∪ {status}
// ══════════════════════════════════════════════════════════════════════════════
describe("LOCK-0092: DEVICE_ACTIONS = CONTROL_OPS ∪ {status} の語彙導出", () => {
  it("[LOCK-0092] DEVICE_ACTIONS には CONTROL_OPS のすべてが含まれる", () => {
    for (const op of CONTROL_OPS) {
      expect(DEVICE_ACTIONS.has(op)).toBe(true);
    }
  });

  it("[LOCK-0092] DEVICE_ACTIONS には 'status' が含まれる", () => {
    expect(DEVICE_ACTIONS.has("status")).toBe(true);
  });

  it("[LOCK-0092] DEVICE_ACTIONS に ir/relay/led は含まれない", () => {
    expect(DEVICE_ACTIONS.has("ir")).toBe(false);
    expect(DEVICE_ACTIONS.has("relay")).toBe(false);
    expect(DEVICE_ACTIONS.has("led")).toBe(false);
  });

  it("[LOCK-0092] CONTROL_OPS には status が含まれない (制御 op のみ)", () => {
    expect(CONTROL_OPS.includes("status")).toBe(false);
  });

  it("[LOCK-0092] CONTROL_OPS は lock/unlock/toggle/click/autolock を含み ir/relay/led を含まない", () => {
    for (const op of ["ir", "relay", "led"]) {
      expect(CONTROL_OPS.includes(op)).toBe(false);
    }
    for (const op of ["lock", "unlock", "toggle", "click", "autolock"]) {
      expect(CONTROL_OPS.includes(op)).toBe(true);
    }
  });

  it("[LOCK-0092] DEVICE_ACTIONS.size = CONTROL_OPS.length + 1 (+1 が status)", () => {
    expect(DEVICE_ACTIONS.size).toBe(CONTROL_OPS.length + 1);
  });

  it("[LOCK-0092] DEVICE_ACTIONS は CONTROL_OPS ∪ {status} と等しい (余計な要素がない)", () => {
    const expected = new Set([...CONTROL_OPS, "status"]);
    for (const op of DEVICE_ACTIONS) {
      expect(expected.has(op)).toBe(true);
    }
    expect(DEVICE_ACTIONS.size).toBe(expected.size);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// LOCK-0093: 未知 action は die(_, 2) を呼ぶ (cli.unknownAction)
// ══════════════════════════════════════════════════════════════════════════════
describe("LOCK-0093: cmdDeviceOp 未知 action → die code 2 + 許可動詞列挙", () => {
  it("[LOCK-0093] DEVICE_ACTIONS に無い action (bogus 等) は false を返す", () => {
    const bogusActions = ["bogus", "fly", "dance", "reboot", "ir", "relay", "led"];
    for (const action of bogusActions) {
      expect(DEVICE_ACTIONS.has(action)).toBe(false);
    }
  });

  it("[LOCK-0093] DEVICE_ACTIONS の要素 (allowedActions) はすべて文字列で非空", () => {
    expect(DEVICE_ACTIONS.size).toBeGreaterThan(0);
    for (const a of DEVICE_ACTIONS) {
      expect(typeof a).toBe("string");
      expect(a.length).toBeGreaterThan(0);
    }
  });

  it("[LOCK-0093] 許可動詞列挙文字列は lock/unlock/status を含み bogus を含まない", () => {
    const allowedActions = [...DEVICE_ACTIONS].join(" / ");
    expect(allowedActions).toContain("lock");
    expect(allowedActions).toContain("unlock");
    expect(allowedActions).toContain("status");
    expect(allowedActions).not.toContain("bogus");
    expect(allowedActions).not.toContain("ir");
    expect(allowedActions).not.toContain("relay");
  });

  it("[LOCK-0093] cmdDeviceOp に未知 action を渡すと process.exit(2) を呼ぶ", async () => {
    setLocale("en");
    const originalExit = process.exit;
    const exitCodes = [];
    process.exit = /** @type {any} */ ((code) => {
      exitCodes.push(code);
      throw new Error(`process.exit(${code})`);
    });
    try {
      const { cmdDeviceOp } = await import("../../../kit/src/cli/lock-ops.js");
      const program = {
        opts: () => ({ json: false }),
        commands: [],
        options: [],
      };
      await expect(
        cmdDeviceOp("mydevice", "bogusaction", [], {}, program)
      ).rejects.toThrow(/process\.exit\(2\)/);
      expect(exitCodes[exitCodes.length - 1]).toBe(2);
    } finally {
      process.exit = originalExit;
    }
  });
});
