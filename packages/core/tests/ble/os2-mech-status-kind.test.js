// P4-2: parseMechStatus の isStop kind 3 値化テスト。
//
// 問題: 全機種共通 parseMechStatus がデフォルト (Sesame2/3/4) でも flags bit0 から
//   isStop を捏造していた。参照 CHSesame2.kt:40 は `isStop: Boolean? = null` と明示 null。
//
// 修正 (P4-2): kind を 3 値化。
//   os2bot  : motorStatus 由来 (CHSesameBotDevice.kt:286-293)
//   os2bike : flags bit0 由来 (CHSesameBot.kt:28 / CHSesameBikeDevice.kt:296)
//   既定 (os2lock) : isStop = null (CHSesame2.kt:40)
//
// P4-6: devicemodel.js の BIKE_OS2 mechKind が "os2bot" から "os2bike" に変更されたこと。
//
// 出典:
//   _sesame_sdk_ref/.../open/devices/CHSesame2.kt:40 — isStop: Boolean? = null
//   _sesame_sdk_ref/.../open/devices/CHSesameBot.kt:28 — isStop: Boolean? = (flags and 1 == 0)
//   _sesame_sdk_ref/.../ble/os2/CHSesameBikeDevice.kt:296 — CHSesameBotMechStatus を利用
//   _sesame_sdk_ref/.../ble/os2/CHSesame2Device.kt:631 — sliceArray(20..27) = 8B

import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import {
  parseMechStatus, MECH_STATE,
} from "../../src/ble/os2/protocol.js";
import {
  capabilitiesForModel, KIND,
} from "../../src/ble/devicemodel.js";

// 8B mechStatus バッファを組み立てるヘルパ。
// 出典: CHSesame2Device.kt:631 — SSM2LoginResponsePayload.mech_status_t = sliceArray(20..27) = 8B
// データレイアウト (CHSesame2MechStatus / CHSesameBot.kt):
//   [0..1] batteryRaw  LE u16
//   [2..3] target      LE i16
//   [4..5] position    LE i16  (Bot: [4]=motorStatus)
//   [6]   retCode
//   [7]   flags        (bit0=isStop [Bot/Bike], bit1=isInLockRange, bit2=isInUnlockRange, bit5=isBatteryCritical)
function makeMechStatus({ motorStatus = 0, flags = 0 } = {}) {
  const buf = Buffer.alloc(8);
  buf[4] = motorStatus;   // CHSesameBot.kt:23 motorStatus = data[4]
  buf[7] = flags;         // CHSesame2.kt:37 flags = data[7]
  return buf;
}

// ---- ケース 1: Sesame2/3/4 (既定 os2lock) → isStop = null ----------------------
// 出典: CHSesame2.kt:40 `override var isStop: Boolean? = null`

describe("P4-2 ケース1: os2lock (Sesame2/3/4) → isStop = null", () => {
  it("kind 未指定 (既定 os2lock): isStop は null (CHSesame2.kt:40)", () => {
    // flags bit0=0 なら以前の実装は false を返していた (捏造)。
    const buf = makeMechStatus({ flags: 0x00 });
    const s = parseMechStatus(buf);
    expect(s.isStop).toBeNull();
  });

  it("kind='os2lock' 明示: isStop は null (CHSesame2.kt:40)", () => {
    const buf = makeMechStatus({ flags: 0x00 });
    const s = parseMechStatus(buf, { kind: "os2lock" });
    expect(s.isStop).toBeNull();
  });

  it("flags bit0=1 でも os2lock では isStop = null (bit0 を読まない)", () => {
    // 以前は (flags & 1) === 0 → false を返していた。参照には意味論がないため null が正しい。
    const buf = makeMechStatus({ flags: 0x01 });
    const s = parseMechStatus(buf, { kind: "os2lock" });
    expect(s.isStop).toBeNull();
  });

  it("os2lock: state は isInLockRange/isInUnlockRange 由来の 3 値 (lock/unlock/moved)", () => {
    // flags=0x00 (どちらの range にも居ない) → MOVED
    const buf = makeMechStatus({ flags: 0x00 });
    expect(parseMechStatus(buf, { kind: "os2lock" }).state).toBe(MECH_STATE.MOVED);
    // flags=0x02 (bit1=isInLockRange) → LOCKED
    const bufL = makeMechStatus({ flags: 0x02 });
    expect(parseMechStatus(bufL, { kind: "os2lock" }).state).toBe(MECH_STATE.LOCKED);
  });
});

// ---- ケース 2: os2bike (Bike1) → isStop = flags bit0 由来 ----------------------
// 出典: CHSesameBot.kt:28 `override var isStop: Boolean? = (flags and 1 == 0)`
//       CHSesameBikeDevice.kt:296 — Bike1 は CHSesameBotMechStatus を使う

describe("P4-2 ケース2: os2bike (Bike1) → isStop = flags bit0 由来", () => {
  it("os2bike: flags bit0=0 → isStop=true (CHSesameBot.kt:28: flags and 1 == 0 → true)", () => {
    // 出典: CHSesameBot.kt:28 `(flags and 1 == 0)` = bit0 が 0 なら true
    const buf = makeMechStatus({ flags: 0x00 }); // bit0=0
    const s = parseMechStatus(buf, { kind: "os2bike" });
    expect(s.isStop).toBe(true);
  });

  it("os2bike: flags bit0=1 → isStop=false (CHSesameBot.kt:28: flags and 1 == 0 → false)", () => {
    // 出典: CHSesameBot.kt:28 `(flags and 1 == 0)` = bit0 が 1 なら false
    const buf = makeMechStatus({ flags: 0x01 }); // bit0=1
    const s = parseMechStatus(buf, { kind: "os2bike" });
    expect(s.isStop).toBe(false);
  });

  it("os2bike: isStop は boolean (null ではない)", () => {
    const buf = makeMechStatus({ flags: 0x00 });
    const s = parseMechStatus(buf, { kind: "os2bike" });
    expect(typeof s.isStop).toBe("boolean");
  });

  it("os2bike: state は Sesame2 と同じ 3 値 (lock/unlock/moved)", () => {
    // Bike1 は CHSesameBikeDevice.kt:299 で lock/unlock/moved と同形
    const buf = makeMechStatus({ flags: 0x04 }); // bit2=isInUnlockRange
    expect(parseMechStatus(buf, { kind: "os2bike" }).state).toBe(MECH_STATE.UNLOCKED);
  });
});

// ---- ケース 3: os2bot (Bot1) → isStop = motorStatus 由来 ----------------------
// 出典: CHSesameBotDevice.kt:286-293 — motorStatus による when ブロック
//       (CHSesameBot.kt:28 の flags-based 初期値は when で必ず上書きされる)

describe("P4-2 ケース3: os2bot (Bot1) → isStop = motorStatus 由来", () => {
  it("os2bot: motorStatus=0 (noPower) → isStop=true (CHSesameBotDevice.kt:287)", () => {
    // 出典: CHSesameBotDevice.kt:287 `0.toByte() -> true`
    const buf = makeMechStatus({ motorStatus: 0, flags: 0x00 });
    const s = parseMechStatus(buf, { kind: "os2bot" });
    expect(s.isStop).toBe(true);
  });

  it("os2bot: motorStatus=1 (forward) → isStop=false (CHSesameBotDevice.kt:288)", () => {
    // 出典: CHSesameBotDevice.kt:288 `1.toByte() -> false`
    // flags bit0=0 では以前の flags-based 実装なら isStop=true になるが、Bot では motorStatus 優先。
    const buf = makeMechStatus({ motorStatus: 1, flags: 0x00 });
    const s = parseMechStatus(buf, { kind: "os2bot" });
    expect(s.isStop).toBe(false);
  });

  it("os2bot: motorStatus=2 (hold) → isStop=true (CHSesameBotDevice.kt:289)", () => {
    // 出典: CHSesameBotDevice.kt:289 `2.toByte() -> true`
    const buf = makeMechStatus({ motorStatus: 2, flags: 0x01 });
    const s = parseMechStatus(buf, { kind: "os2bot" });
    expect(s.isStop).toBe(true);
  });

  it("os2bot: motorStatus=3 (backward) → isStop=false (CHSesameBotDevice.kt:290)", () => {
    // 出典: CHSesameBotDevice.kt:290 `3.toByte() -> false`
    const buf = makeMechStatus({ motorStatus: 3, flags: 0x00 });
    const s = parseMechStatus(buf, { kind: "os2bot" });
    expect(s.isStop).toBe(false);
  });

  it("os2bot: state は 2 値 (LOCKED / UNLOCKED)、MOVED は出ない (CHSesameBotDevice.kt:303)", () => {
    // 出典: CHSesameBotDevice.kt:303 `if (isInLockRange) Locked else Unlocked`
    const buf = makeMechStatus({ flags: 0x00 }); // 両 range=0
    expect(parseMechStatus(buf, { kind: "os2bot" }).state).toBe(MECH_STATE.UNLOCKED);
    expect(parseMechStatus(buf, { kind: "os2bot" }).state).not.toBe(MECH_STATE.MOVED);
  });
});

// ---- P4-6: devicemodel BIKE_OS2 mechKind = "os2bike" -------------------------
// 出典: CHSesame2Device.kt:631 sliceArray(20..27) = 8B (mechStatus は 8B)
//       mechKind が "os2bot" → "os2bike" に変更 (Bike1 は CHSesameBotMechStatus を使い
//       flags bit0 由来の isStop を持つ。motorStatus 上書きはしない)

describe("P4-6: BIKE_OS2 mechKind = 'os2bike' (not 'os2bot')", () => {
  it("bike_1 の mechKind は os2bike (P4-6 修正)", () => {
    // 修正前: "os2bot"。Bike1 は CHSesameBotMechStatus (flags bit0 由来) を使うが
    // motorStatus の上書きはしない → os2bike が正しい。
    const caps = capabilitiesForModel("bike_1");
    expect(caps.mechKind).toBe("os2bike");
    expect(caps.mechKind).not.toBe("os2bot");
  });

  it("ssmbot_1 の mechKind は os2bot のまま (P4-6 で変更なし)", () => {
    const caps = capabilitiesForModel("ssmbot_1");
    expect(caps.mechKind).toBe("os2bot");
  });

  it("sesame_2 の mechKind は os2lock のまま (P4-2 の kind 名と一致)", () => {
    const caps = capabilitiesForModel("sesame_2");
    expect(caps.mechKind).toBe("os2lock");
  });

  it("BIKE_OS2 kind が bikeOs2 (P4-6 によりデバイスモデルの kind は変わらない)", () => {
    // mechKind を os2bike に変えても BIKE_OS2 kind 定数は "bikeOs2" のまま。
    expect(KIND.BIKE_OS2).toBe("bikeOs2");
    expect(capabilitiesForModel("bike_1").kind).toBe(KIND.BIKE_OS2);
  });
});
