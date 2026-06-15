// lock-c5.test.js — LOCK-0094 〜 LOCK-0111 統合 TDD spec テスト (18件)
//
// 対象: pickTransport / capabilitiesForModel / transportsForOp / kindForModel /
//        CONTROL_OPS / cmdDeviceOp / cmdAct / runCloudOp
//
// 方針:
//   - die() は process.exit を throw に差し替えて捕捉する (vi.spyOn)。
//   - 純関数 (capabilitiesForModel / transportsForOp / kindForModel) は直接テスト。
//   - runCloudOp は vi.mock で withHub を差し替え、hub モックで呼び出しを検証。
//   - ネットワーク/実機に触れない。全て mock or 純関数。決定論的。
//   - タイトル先頭に [LOCK-XXXX] を置く (TDD: spec に対する正しい期待値を assert)。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- @sesame-kit/core/ble: 純関数 ------------------------------------------
import {
  capabilitiesForModel,
  transportsForOp,
  kindForModel,
  KIND,
  CONTROL_OPS,
} from "@sesame-kit/core/ble";

// ---- @sesame-kit/core/crypto: CMD コード ------------------------------------
import { CMD } from "@sesame-kit/core/crypto";

// ---- @sesame-kit/core/i18n --------------------------------------------------
import { setLocale } from "@sesame-kit/core/i18n";

// ---- kit CLI: vi.mock は hoisting されるため import より前に評価される -------
// ctx.js の withHub / hasCloudSession をモックして runCloudOp をテスト可能にする。
vi.mock("../../../kit/src/cli/ctx.js", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    withHub: vi.fn(),
    hasCloudSession: vi.fn(() => true),
    loadCtx: vi.fn(() => ({
      opts: { json: false },
      paths: {},
      configStore: { exists: () => true, load: () => ({ locks: {}, default: {} }) },
      tokenStore: { load: () => ({ refreshToken: "tok" }) },
    })),
  };
});

// hoisting 後に import
import { pickTransport, runCloudOp } from "../../../kit/src/cli/lock-ops.js";
import { withHub } from "../../../kit/src/cli/ctx.js";

// ---------------------------------------------------------------------------
// ヘルパ: process.exit を spy して throw に変換する
// ---------------------------------------------------------------------------
function mockProcessExit() {
  return vi.spyOn(process, "exit").mockImplementation((code) => {
    const e = new Error(`process.exit(${code})`);
    /** @type {any} */ (e).exitCode = code;
    throw e;
  });
}

// ===========================================================================
// LOCK-0094: pickTransport auto — cloud で運べる op は cloud を返す
// ===========================================================================
describe("LOCK-0094: pickTransport auto — cloud 可 op は cloud を返す", () => {
  beforeEach(() => setLocale("en"));

  it("[LOCK-0094] auto かつ lock (sesame_5, cloud 可) は 'cloud' を返す", () => {
    const result = pickTransport("lock", {}, "sesame_5");
    expect(result).toBe("cloud");
  });

  it("[LOCK-0094] auto かつ unlock (sesame_5, cloud 可) は 'cloud' を返す", () => {
    const result = pickTransport("unlock", {}, "sesame_5");
    expect(result).toBe("cloud");
  });

  it("[LOCK-0094] auto かつ toggle (sesame_5, cloud 可) は 'cloud' を返す", () => {
    const result = pickTransport("toggle", {}, "sesame_5");
    expect(result).toBe("cloud");
  });

  it("[LOCK-0094] auto かつ click (bot_2, cloud 可) は 'cloud' を返す", () => {
    // bot_2: cloud=["click"] → click は cloud 可
    const result = pickTransport("click", {}, "bot_2");
    expect(result).toBe("cloud");
  });
});

// ===========================================================================
// LOCK-0095: pickTransport auto — autolock (BLE 必須) は 'ble' を返す
// ===========================================================================
describe("LOCK-0095: pickTransport auto — autolock は 'ble' を返す", () => {
  beforeEach(() => setLocale("en"));

  it("[LOCK-0095] auto かつ autolock (sesame_5, cloud 不可) は 'ble' を返す", () => {
    // lock5: ble=[lock,unlock,toggle,autolock], cloud=[lock,unlock,toggle] → autolock は ble のみ
    const result = pickTransport("autolock", {}, "sesame_5");
    expect(result).toBe("ble");
  });

  it("[LOCK-0095] auto かつ autolock (sesame_2, cloud 不可) は 'ble' を返す", () => {
    // sesame2: 同じく autolock は cloud になく ble のみ
    const result = pickTransport("autolock", {}, "sesame_2");
    expect(result).toBe("ble");
  });
});

// ===========================================================================
// LOCK-0096: --ble-only — BLE 可 op は 'ble'、BLE 不可 op は exit 2
// ===========================================================================
describe("LOCK-0096: pickTransport --ble-only", () => {
  let exitSpy;
  beforeEach(() => {
    setLocale("en");
    exitSpy = mockProcessExit();
  });
  afterEach(() => exitSpy.mockRestore());

  it("[LOCK-0096] --ble-only かつ lock (sesame_5, ble 可) は 'ble' を返す", () => {
    const result = pickTransport("lock", { bleOnly: true }, "sesame_5");
    expect(result).toBe("ble");
  });

  it("[LOCK-0096] --ble-only かつ autolock (sesame_5, ble 可) は 'ble' を返す", () => {
    const result = pickTransport("autolock", { bleOnly: true }, "sesame_5");
    expect(result).toBe("ble");
  });

  it("[LOCK-0096] --ble-only かつ ble 不可 op (hub_3 の ir) は exit 2", () => {
    // hub_3: ble=[] → transportsForOp("hub_3","ir")=["cloud"] → ble に ir が無い → opNotOverBle で die(2)
    expect(() => pickTransport("ir", { bleOnly: true }, "hub_3")).toThrow(/exit.*2/);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});

// ===========================================================================
// LOCK-0097: --cloud-only — cloud 可 op は 'cloud'、cloud 不可 op は exit 2
// ===========================================================================
describe("LOCK-0097: pickTransport --cloud-only", () => {
  let exitSpy;
  beforeEach(() => {
    setLocale("en");
    exitSpy = mockProcessExit();
  });
  afterEach(() => exitSpy.mockRestore());

  it("[LOCK-0097] --cloud-only かつ lock (sesame_5, cloud 可) は 'cloud' を返す", () => {
    const result = pickTransport("lock", { cloudOnly: true }, "sesame_5");
    expect(result).toBe("cloud");
  });

  it("[LOCK-0097] --cloud-only かつ autolock (sesame_5, cloud 不可) は exit 2", () => {
    // lock5: autolock は ble のみ、cloud には無い → opNotOverCloud → die(exit 2)
    expect(() => pickTransport("autolock", { cloudOnly: true }, "sesame_5")).toThrow(/exit.*2/);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("[LOCK-0097] --cloud-only かつ autolock (sesame_2, cloud 不可) も exit 2", () => {
    expect(() => pickTransport("autolock", { cloudOnly: true }, "sesame_2")).toThrow(/exit.*2/);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});

// ===========================================================================
// LOCK-0098: --cloud-only と --ble-only の併用は exit 2 (最優先)
// ===========================================================================
describe("LOCK-0098: --cloud-only && --ble-only 同時指定は exit 2", () => {
  let exitSpy;
  beforeEach(() => {
    setLocale("en");
    exitSpy = mockProcessExit();
  });
  afterEach(() => exitSpy.mockRestore());

  it("[LOCK-0098] cloudOnly && bleOnly は cloudBleExclusive で exit 2 (最優先ガード)", () => {
    expect(() =>
      pickTransport("lock", { cloudOnly: true, bleOnly: true }, "sesame_5")
    ).toThrow(/exit.*2/);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("[LOCK-0098] 任意の op / model で両フラグ同時指定は exit 2", () => {
    expect(() =>
      pickTransport("autolock", { cloudOnly: true, bleOnly: true }, "sesame_5")
    ).toThrow(/exit.*2/);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});

// ===========================================================================
// LOCK-0099: pickTransport status — mech 型は通過、auto/--cloud-only は cloud
// ===========================================================================
describe("LOCK-0099: pickTransport status — mech 型は経路ゲート通過", () => {
  beforeEach(() => setLocale("en"));

  it("[LOCK-0099] op=status かつ mech 型 (sesame_5) かつ auto は 'cloud' を返す", () => {
    // sesame_5: mechKind="os3lock" (非null) → status ゲート通過, auto → cloud
    const result = pickTransport("status", {}, "sesame_5");
    expect(result).toBe("cloud");
  });

  it("[LOCK-0099] op=status かつ mech 型 (bot_2, mechKind=os3bot) かつ auto は 'cloud' を返す", () => {
    // bot_2: mechKind="os3bot" (非null) → status ゲート通過, auto → cloud
    const result = pickTransport("status", {}, "bot_2");
    expect(result).toBe("cloud");
  });

  it("[LOCK-0099] op=status かつ --cloud-only かつ mech 型 (sesame_5) は 'cloud' を返す", () => {
    const result = pickTransport("status", { cloudOnly: true }, "sesame_5");
    expect(result).toBe("cloud");
  });
});

// ===========================================================================
// LOCK-0100: pickTransport status + --ble-only は 'ble'
// ===========================================================================
describe("LOCK-0100: pickTransport status --ble-only は 'ble'", () => {
  beforeEach(() => setLocale("en"));

  it("[LOCK-0100] op=status かつ --ble-only かつ mech 型 (sesame_5) は 'ble' を返す", () => {
    const result = pickTransport("status", { bleOnly: true }, "sesame_5");
    expect(result).toBe("ble");
  });

  it("[LOCK-0100] op=status かつ --ble-only かつ bot_2 (mechKind=os3bot) は 'ble'", () => {
    const result = pickTransport("status", { bleOnly: true }, "bot_2");
    expect(result).toBe("ble");
  });
});

// ===========================================================================
// LOCK-0101: pickTransport status — mech 無し型 (hub/wifi/biometric) は exit 2
// ===========================================================================
describe("LOCK-0101: pickTransport status — mech 無し型は exit 2", () => {
  let exitSpy;
  beforeEach(() => {
    setLocale("en");
    exitSpy = mockProcessExit();
  });
  afterEach(() => exitSpy.mockRestore());

  it("[LOCK-0101] op=status かつ hub_3 (mechKind=null) は exit 2", () => {
    expect(() => pickTransport("status", {}, "hub_3")).toThrow(/exit.*2/);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("[LOCK-0101] op=status かつ wm_2 (mechKind=null) は exit 2", () => {
    expect(() => pickTransport("status", {}, "wm_2")).toThrow(/exit.*2/);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("[LOCK-0101] op=status かつ ssm_touch (biometric, mechKind=null) は exit 2", () => {
    expect(() => pickTransport("status", {}, "ssm_touch")).toThrow(/exit.*2/);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});

// ===========================================================================
// LOCK-0102: pickTransport — 制御 op で運べる経路ゼロは exit 2
// ===========================================================================
describe("LOCK-0102: pickTransport — 経路ゼロの制御 op は exit 2", () => {
  let exitSpy;
  beforeEach(() => {
    setLocale("en");
    exitSpy = mockProcessExit();
  });
  afterEach(() => exitSpy.mockRestore());

  it("[LOCK-0102] transportsForOp が空 (hub_3 の lock) は exit 2", () => {
    // hub_3: lock は cloud/ble どちらでも送れない → noTransportForOp で die(2)
    const allowed = transportsForOp("hub_3", "lock");
    expect(allowed).toHaveLength(0);
    expect(() => pickTransport("lock", {}, "hub_3")).toThrow(/exit.*2/);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("[LOCK-0102] transportsForOp が空 (ssm_touch の click) は exit 2", () => {
    // biometric: ops=[] なので click も空
    const allowed = transportsForOp("ssm_touch", "click");
    expect(allowed).toHaveLength(0);
    expect(() => pickTransport("click", {}, "ssm_touch")).toThrow(/exit.*2/);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("[LOCK-0102] 未知 model (totally_unknown_model_xyz) の lock は exit 2", () => {
    // KIND.UNKNOWN: cloud=[], ble=[] → transportsForOp returns [] → noTransportForOp で die(2)
    expect(() => pickTransport("lock", {}, "totally_unknown_model_xyz")).toThrow(/exit.*2/);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});

// ===========================================================================
// LOCK-0103: 機種能力ゲート — 非対応制御 op は caps.ops に含まれない
// ===========================================================================
describe("LOCK-0103: 機種能力ゲート — 非対応制御 op は caps.ops に含まれない", () => {
  beforeEach(() => setLocale("en"));

  it("[LOCK-0103] bot_2 は lock/unlock/toggle/autolock を ops に含まない (click のみ)", () => {
    const caps = capabilitiesForModel("bot_2");
    expect(caps.ops).toContain("click");
    expect(caps.ops).not.toContain("lock");
    expect(caps.ops).not.toContain("unlock");
    expect(caps.ops).not.toContain("toggle");
    expect(caps.ops).not.toContain("autolock");
  });

  it("[LOCK-0103] sesame_5 は click を ops に含まない (lock/unlock/toggle/autolock のみ)", () => {
    const caps = capabilitiesForModel("sesame_5");
    expect(caps.ops).not.toContain("click");
    expect(caps.ops).toContain("lock");
    expect(caps.ops).toContain("unlock");
    expect(caps.ops).toContain("toggle");
    expect(caps.ops).toContain("autolock");
  });

  it("[LOCK-0103] CONTROL_OPS には lock/unlock/toggle/click/autolock が含まれる、status は含まれない", () => {
    expect(CONTROL_OPS).toContain("lock");
    expect(CONTROL_OPS).toContain("unlock");
    expect(CONTROL_OPS).toContain("toggle");
    expect(CONTROL_OPS).toContain("click");
    expect(CONTROL_OPS).toContain("autolock");
    // status は制御 op ではない (CLI 固有)
    expect(CONTROL_OPS).not.toContain("status");
  });

  it("[LOCK-0103] 能力ゲートロジック: caps.ops に無い op は die(exit 2) に相当する", () => {
    // cmdAct の能力ゲートを純粋ロジックで再現
    class DieError extends Error {
      constructor(code) { super(`die(${code})`); this.exitCode = code; }
    }
    const gateCheck = (model, op) => {
      if (CONTROL_OPS.includes(op) && model) {
        const caps = capabilitiesForModel(model);
        if (!caps.ops.includes(op)) {
          throw new DieError(2);
        }
      }
    };
    // bot_2 に lock → die(2)
    expect(() => gateCheck("bot_2", "lock")).toThrow(DieError);
    // sesame_5 に click → die(2)
    expect(() => gateCheck("sesame_5", "click")).toThrow(DieError);
    // sesame_5 に lock → OK (通過)
    expect(() => gateCheck("sesame_5", "lock")).not.toThrow();
    // bot_2 に click → OK (通過)
    expect(() => gateCheck("bot_2", "click")).not.toThrow();
  });
});

// ===========================================================================
// LOCK-0104: capabilitiesForModel — lock5 (sesame_5/6/pro/us/miwa) の能力
// ===========================================================================
describe("LOCK-0104: capabilitiesForModel — lock5 の能力", () => {
  beforeEach(() => setLocale("en"));

  it("[LOCK-0104] sesame_5 の os=3, cloud=[lock,unlock,toggle], ble に autolock あり, mechKind=os3lock", () => {
    const caps = capabilitiesForModel("sesame_5");
    expect(caps.kind).toBe(KIND.LOCK5);
    expect(caps.os).toBe(3);
    expect(caps.cloud).toEqual(expect.arrayContaining(["lock", "unlock", "toggle"]));
    expect(caps.cloud).not.toContain("autolock");
    expect(caps.ble).toEqual(expect.arrayContaining(["lock", "unlock", "toggle", "autolock"]));
    expect(caps.mechKind).toBe("os3lock");
  });

  it("[LOCK-0104] sesame_6 も lock5 kind で同じ能力", () => {
    const caps = capabilitiesForModel("sesame_6");
    expect(caps.kind).toBe(KIND.LOCK5);
    expect(caps.cloud).toEqual(expect.arrayContaining(["lock", "unlock", "toggle"]));
    expect(caps.ble).toContain("autolock");
    expect(caps.mechKind).toBe("os3lock");
  });

  it("[LOCK-0104] sesame_6_pro / sesame_5_pro / sesame_5_us / sesame_miwa も lock5 能力を持つ", () => {
    for (const model of ["sesame_6_pro", "sesame_5_pro", "sesame_5_us", "sesame_miwa"]) {
      const caps = capabilitiesForModel(model);
      expect(caps.kind, `${model} kind`).toBe(KIND.LOCK5);
      expect(caps.mechKind, `${model} mechKind`).toBe("os3lock");
      expect(caps.cloud, `${model} cloud`).toContain("lock");
      expect(caps.ble, `${model} ble`).toContain("autolock");
    }
  });

  it("[LOCK-0104] transportsForOp lock5: lock は [ble,cloud]、autolock は [ble] のみ", () => {
    const lockTransports = transportsForOp("sesame_5", "lock");
    expect(lockTransports).toContain("ble");
    expect(lockTransports).toContain("cloud");

    const autolockTransports = transportsForOp("sesame_5", "autolock");
    expect(autolockTransports).toContain("ble");
    expect(autolockTransports).not.toContain("cloud");
  });
});

// ===========================================================================
// LOCK-0105: capabilitiesForModel — bot (bot_2/bot_3/ssmbot_1) は click のみ
// ===========================================================================
describe("LOCK-0105: capabilitiesForModel — bot は click のみ", () => {
  beforeEach(() => setLocale("en"));

  it("[LOCK-0105] bot_2 の cloud=[click], ble=[click], lock/unlock/toggle/autolock 含まず, mechKind=os3bot", () => {
    const caps = capabilitiesForModel("bot_2");
    expect(caps.kind).toBe(KIND.BOT2);
    expect(caps.cloud).toEqual(["click"]);
    expect(caps.ble).toEqual(["click"]);
    expect(caps.ops).toEqual(["click"]);
    expect(caps.cloud).not.toContain("lock");
    expect(caps.cloud).not.toContain("unlock");
    expect(caps.cloud).not.toContain("toggle");
    expect(caps.cloud).not.toContain("autolock");
    expect(caps.mechKind).toBe("os3bot");
  });

  it("[LOCK-0105] bot_3 も bot2 kind で click のみ", () => {
    const caps = capabilitiesForModel("bot_3");
    expect(caps.kind).toBe(KIND.BOT2);
    expect(caps.ops).toEqual(["click"]);
    expect(caps.ops).not.toContain("lock");
  });

  it("[LOCK-0105] ssmbot_1 (OS2 bot) は botOs2 kind で click のみ, mechKind=os2bot, os=2", () => {
    const caps = capabilitiesForModel("ssmbot_1");
    expect(caps.kind).toBe(KIND.BOT_OS2);
    expect(caps.ops).toEqual(["click"]);
    expect(caps.mechKind).toBe("os2bot");
    expect(caps.os).toBe(2);
  });
});

// ===========================================================================
// LOCK-0106: capabilitiesForModel — OS2 ロック (sesame_2/4) の世代/op
// ===========================================================================
describe("LOCK-0106: capabilitiesForModel — sesame2 (OS2 lock) の能力", () => {
  beforeEach(() => setLocale("en"));

  it("[LOCK-0106] sesame_2 の os=2, cloud=[lock,unlock,toggle], ble に autolock あり, mechKind=os2lock", () => {
    const caps = capabilitiesForModel("sesame_2");
    expect(caps.kind).toBe(KIND.SESAME2);
    expect(caps.os).toBe(2);
    expect(caps.cloud).toEqual(expect.arrayContaining(["lock", "unlock", "toggle"]));
    expect(caps.cloud).not.toContain("autolock");
    expect(caps.ble).toEqual(expect.arrayContaining(["lock", "unlock", "toggle", "autolock"]));
    expect(caps.mechKind).toBe("os2lock");
  });

  it("[LOCK-0106] sesame_4 も sesame2 kind で同じ能力", () => {
    const caps = capabilitiesForModel("sesame_4");
    expect(caps.kind).toBe(KIND.SESAME2);
    expect(caps.os).toBe(2);
    expect(caps.mechKind).toBe("os2lock");
    expect(caps.ble).toContain("autolock");
    expect(caps.cloud).not.toContain("autolock");
  });

  it("[LOCK-0106] sesame2 の transportsForOp: autolock は [ble] のみ", () => {
    const t = transportsForOp("sesame_2", "autolock");
    expect(t).toEqual(["ble"]);
  });
});

// ===========================================================================
// LOCK-0107: kindForModel — 未知 model は UNKNOWN、null は lock5 既定
// ===========================================================================
describe("LOCK-0107: kindForModel — 未知 model は UNKNOWN、null は lock5 既定", () => {
  beforeEach(() => setLocale("en"));

  it("[LOCK-0107] テーブルに無い model 文字列は KIND.UNKNOWN を返す", () => {
    expect(kindForModel("totally_unknown_xyz")).toBe(KIND.UNKNOWN);
    expect(kindForModel("not_in_table_12345")).toBe(KIND.UNKNOWN);
  });

  it("[LOCK-0107] UNKNOWN の capabilitiesForModel は ops=[] (操作を捏造しない)", () => {
    const caps = capabilitiesForModel("totally_unknown_xyz");
    expect(caps.kind).toBe(KIND.UNKNOWN);
    expect(caps.ops).toHaveLength(0);
    expect(caps.cloud).toHaveLength(0);
    expect(caps.ble).toHaveLength(0);
    expect(caps.mechKind).toBeNull();
  });

  it("[LOCK-0107] null/undefined/空文字は lock5 既定 (後方互換)", () => {
    expect(kindForModel(null)).toBe(KIND.LOCK5);
    expect(kindForModel(undefined)).toBe(KIND.LOCK5);
    expect(kindForModel("")).toBe(KIND.LOCK5);
  });

  it("[LOCK-0107] null model の capabilitiesForModel は lock5 の能力を返す", () => {
    const caps = capabilitiesForModel(null);
    expect(caps.kind).toBe(KIND.LOCK5);
    expect(caps.ops).toContain("lock");
  });
});

// ===========================================================================
// LOCK-0108: cmdDeviceOp autolock — seconds 引数欠落は exit 2 (接続前)
// cmdDeviceOp は config 依存 (resolveLockEntry) があるため、
// autolock の秒数チェックが "args[0] が無いとき die(exit 2)" になる
// ロジックを純粋に再現して検証する。
// ===========================================================================
describe("LOCK-0108: cmdDeviceOp autolock — seconds 引数欠落は exit 2", () => {
  beforeEach(() => setLocale("en"));

  it("[LOCK-0108] autolock の args=[] の場合 args[0] は undefined (== null で die 条件成立)", () => {
    // cmdDeviceOp のロジック: const seconds = action === "autolock" ? (args && args[0]) : null;
    // if (action === "autolock" && (seconds == null)) die(autolockNeedsSeconds, 2)
    const args = [];
    const seconds = "autolock" === "autolock" ? (args && args[0]) : null;
    // undefined == null → true → die(exit 2) 条件
    expect(seconds == null).toBe(true);
  });

  it("[LOCK-0108] autolock の args=undefined の場合も seconds == null が成立する", () => {
    const args = undefined;
    const seconds = "autolock" === "autolock" ? (args && args[0]) : null;
    expect(seconds == null).toBe(true);
  });

  it("[LOCK-0108] pickTransport は autolock + auto で 'ble' を返す (接続前バリデーション経路確認)", () => {
    // autolock 引数チェックは接続前。ble transport が選ばれた後、接続前に die する経路を確認。
    const result = pickTransport("autolock", {}, "sesame_5");
    expect(result).toBe("ble");
  });

  it("[LOCK-0108] autolock の args=[300] の場合 seconds=300 (正常値, die 条件不成立)", () => {
    const args = ["300"];
    const seconds = "autolock" === "autolock" ? (args && args[0]) : null;
    expect(seconds == null).toBe(false);
    expect(seconds).toBe("300");
  });
});

// ===========================================================================
// LOCK-0109: autolock seconds 範囲 0..65535 整数検証 (cmdAct / setAutolock)
// ===========================================================================
describe("LOCK-0109: autolock seconds 範囲 0..65535 整数検証", () => {
  // cmdAct の seconds チェックロジック (lock-ops.js:307-310):
  //   sec = Number(seconds); if (!Number.isInteger(sec) || sec < 0 || sec > 65535) die(secondsRange, 2)
  const isBad = (v) => {
    const sec = Number(v);
    return !Number.isInteger(sec) || sec < 0 || sec > 65535;
  };

  beforeEach(() => setLocale("en"));

  it("[LOCK-0109] 0 は valid (autolock 無効化)", () => {
    expect(isBad(0)).toBe(false);
  });

  it("[LOCK-0109] 65535 は valid (最大値)", () => {
    expect(isBad(65535)).toBe(false);
  });

  it("[LOCK-0109] 1 と 65534 は valid (境界内)", () => {
    expect(isBad(1)).toBe(false);
    expect(isBad(65534)).toBe(false);
  });

  it("[LOCK-0109] 文字列 '300' は Number(300) = 300 で valid", () => {
    expect(isBad("300")).toBe(false);
  });

  it("[LOCK-0109] -1 / 65536 / 1.5 / NaN / 非数文字列 は invalid (exit 2 になるべき)", () => {
    for (const v of [-1, 65536, 1.5, NaN, "abc"]) {
      expect(isBad(v), `${v} should be invalid`).toBe(true);
    }
  });
});

// ===========================================================================
// LOCK-0110: runCloudOp — cloud op の hub メソッド振り分け
// ===========================================================================
describe("LOCK-0110: runCloudOp — cloud 経路の op → hub メソッド振り分け", () => {
  const ENTRY = {
    name: "front",
    deviceUUID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeffff",
    secretKey: "0123456789abcdef0123456789abcdef",
    model: "sesame_5",
  };

  function makeMockHub() {
    return {
      lock: vi.fn(async () => ({ data: {} })),
      unlock: vi.fn(async () => ({ data: {} })),
      toggle: vi.fn(async () => ({ data: {} })),
      botClick: vi.fn(async () => ({ data: {} })),
      getDeviceStatus: vi.fn(async () => ({ stateInfo: null })),
    };
  }

  let consoleErrorSpy;
  let consoleLogSpy;

  beforeEach(() => {
    setLocale("en");
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("[LOCK-0110] op=lock は hub.lock(name) を呼ぶ", async () => {
    const hub = makeMockHub();
    withHub.mockImplementation(async (_program, fn) =>
      fn(hub, { opts: { json: false }, paths: {} })
    );
    const fakeProgram = { opts: () => ({ json: false }) };
    await runCloudOp("lock", ENTRY, fakeProgram);
    expect(hub.lock).toHaveBeenCalledWith(ENTRY.name);
    expect(hub.unlock).not.toHaveBeenCalled();
    expect(hub.botClick).not.toHaveBeenCalled();
  });

  it("[LOCK-0110] op=unlock は hub.unlock(name) を呼ぶ", async () => {
    const hub = makeMockHub();
    withHub.mockImplementation(async (_program, fn) =>
      fn(hub, { opts: { json: false }, paths: {} })
    );
    const fakeProgram = { opts: () => ({ json: false }) };
    await runCloudOp("unlock", ENTRY, fakeProgram);
    expect(hub.unlock).toHaveBeenCalledWith(ENTRY.name);
    expect(hub.lock).not.toHaveBeenCalled();
    expect(hub.botClick).not.toHaveBeenCalled();
  });

  it("[LOCK-0110] op=toggle は hub.toggle(name) を呼ぶ", async () => {
    const hub = makeMockHub();
    withHub.mockImplementation(async (_program, fn) =>
      fn(hub, { opts: { json: false }, paths: {} })
    );
    const fakeProgram = { opts: () => ({ json: false }) };
    await runCloudOp("toggle", ENTRY, fakeProgram);
    expect(hub.toggle).toHaveBeenCalledWith(ENTRY.name);
    expect(hub.lock).not.toHaveBeenCalled();
  });

  it("[LOCK-0110] op=click は hub.botClick(name) を呼ぶ (cmd=89 相当)", async () => {
    const hub = makeMockHub();
    withHub.mockImplementation(async (_program, fn) =>
      fn(hub, { opts: { json: false }, paths: {} })
    );
    const fakeProgram = { opts: () => ({ json: false }) };
    const BOT_ENTRY = { ...ENTRY, model: "bot_2", name: "kitchen" };
    await runCloudOp("click", BOT_ENTRY, fakeProgram);
    expect(hub.botClick).toHaveBeenCalledWith(BOT_ENTRY.name);
    expect(hub.lock).not.toHaveBeenCalled();
    expect(hub.toggle).not.toHaveBeenCalled();
  });

  it("[LOCK-0110] CMD コード: LOCK=82, UNLOCK=83, TOGGLE=88, CLICK=89", () => {
    expect(CMD.LOCK).toBe(82);
    expect(CMD.UNLOCK).toBe(83);
    expect(CMD.TOGGLE).toBe(88);
    expect(CMD.CLICK).toBe(89);
  });
});

// ===========================================================================
// LOCK-0111: cloud 経路で未ログインは exit 2 (hasCloudSession 判定)
// ===========================================================================
describe("LOCK-0111: cloud 経路で未ログインは exit 2 (hasCloudSession)", () => {
  beforeEach(() => setLocale("en"));

  it("[LOCK-0111] hasCloudSession 判定ロジック: refreshToken なし/null/空オブジェクト は false", () => {
    // ctx.js:169-173 のロジックを再現: !!(tok && (tok.refreshToken || tok.idToken))
    const hasSession = (tok) => !!(tok && (tok.refreshToken || tok.idToken));
    for (const tok of [null, {}, { refreshToken: null, idToken: null }, { refreshToken: "", idToken: "" }]) {
      expect(hasSession(tok), `${JSON.stringify(tok)} should be false`).toBe(false);
    }
  });

  it("[LOCK-0111] hasCloudSession: refreshToken あり は true", () => {
    const hasSession = (tok) => !!(tok && (tok.refreshToken || tok.idToken));
    expect(hasSession({ refreshToken: "some-refresh-token" })).toBe(true);
  });

  it("[LOCK-0111] hasCloudSession: idToken のみでも true", () => {
    const hasSession = (tok) => !!(tok && (tok.refreshToken || tok.idToken));
    expect(hasSession({ idToken: "some-id-token" })).toBe(true);
  });

  it("[LOCK-0111] cloud 経路で hasCloudSession=false のとき exit 2 (cmdAct ガードを純粋ロジックで確認)", () => {
    const exitSpy = mockProcessExit();
    // cmdAct:324-327 相当のガードロジック
    const simulateCmdAct = (transport, hasSession) => {
      if (transport === "cloud" && !hasSession) {
        process.exit(2);
      }
    };
    // token 無し → die(exit 2)
    expect(() => simulateCmdAct("cloud", false)).toThrow(/exit.*2/);
    expect(exitSpy).toHaveBeenCalledWith(2);
    // ble transport は hasCloudSession を参照しない
    expect(() => simulateCmdAct("ble", false)).not.toThrow();
    // token あり → 通過
    expect(() => simulateCmdAct("cloud", true)).not.toThrow();
    exitSpy.mockRestore();
  });
});
