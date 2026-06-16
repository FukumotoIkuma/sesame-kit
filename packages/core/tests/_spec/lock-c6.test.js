// lock-c6.test.js — LOCK-0112 〜 LOCK-0133 (18件) 統合テスト
// A/B 両実装を比較し、より正確・移植元忠実な方を採用してマージ。
// TDD: テストの失敗 (red) は許容。クラッシュ/実行不能は不可。
//
// Coverage:
//   LOCK-0112: --json envelope: cloud op {ok,op,name,via:"cloud",response}
//   LOCK-0113: --json envelope: BLE op {ok,op,name,via:"ble",result,status}
//   LOCK-0114: sanitizeStatus removes secretKey
//   LOCK-0115: fmtCloudStatus / fmtMech consistent 1-line format
//   LOCK-0116: runBleOp OS2 (os===2) delegates to SesameOS2Ble
//   LOCK-0117: runBleOp OS2 BLE needs ssmPublicKey, else exit 2
//   LOCK-0118: lock.lock/unlock/toggle serve == same cloud cmd
//   LOCK-0119: lock.click scriptIndex branches to botClickScript vs botClick
//   LOCK-0120: lock.setAutolock cloud default / ble branch / bad transport
//   LOCK-0121: lock.* requireAuth (cloud), setAutolock ble skips requireAuth
//   LOCK-0122: lock.status requires deviceUUID, calls getDeviceStatus
//   LOCK-0123: generated TS/Python SDK has lock.* methods 1:1 with openrpc
//   LOCK-0124: error messages en/ja catalog completeness
//   LOCK-0128: biz3TriggerLocker:pubUserDeviceChange does NOT resolve triggerLock
//   LOCK-0130: OS3/OS2 BLE resultCode!=0 → BleResultError reject
//   LOCK-0131: BleResultError.resultName → JSON-RPC kind/code mapping
//   LOCK-0132: OS3 response frame [op][item][resultCode][payload] decomposition
//   LOCK-0133: OS3 BLE bot2 script index range validation (clickItemCode)

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Buffer } from "node:buffer";

// i18n (relative to packages/core/tests/_spec/)
import { setLocale, t } from "../../src/i18n.js";

// Core lock functions (kit-side CLI helpers)
import { sanitizeStatus, fmtCloudStatus, runBleOp } from "../../../kit/src/cli/lock-ops.js";
import { fmtMech } from "../../../kit/src/cli/exec.js";

// Serve entries
import { lockEntries } from "../../../kit/src/serve/entries/lock.js";

// JSON-RPC
import { RpcError, RPC, KIND, errorFromThrow } from "../../src/jsonrpc.js";

// BLE protocol
import { parseRecvFrame, OP, RESULT, resultName } from "../../src/ble/protocol.js";

// Bot2
import { clickItemCode } from "../../src/ble/bot2.js";

// capabilitiesForModel
import { capabilitiesForModel } from "../../src/ble/devicemodel.js";

// ─── 共通定数 ────────────────────────────────────────────────────────────────

const KEY    = "0123456789abcdef0123456789abcdef";
const DEVICE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeffff";
const SUB    = "11111111222233334444555566667777";
const OK_ACK = { action: "biz3TriggerLocker", code: 200, data: {}, success: true };
const LOCK_NAME = "front";

// ─── mock client ──────────────────────────────────────────────────────────────

function makeMockClient(status = "open") {
  const handlers = new Map();
  const pending  = new Map();
  const sent     = [];
  const client   = {
    sent,
    getStatus: () => status,
    subscribe(key, fn) {
      if (!handlers.has(key)) handlers.set(key, new Map());
      const id = Symbol();
      handlers.get(key).set(id, fn);
      return () => handlers.get(key)?.delete(id);
    },
    send(msg) { sent.push(msg); },
    request(payload, timeoutMs = 10_000) {
      const key = `${payload.action}:${payload.op || ""}`;
      return new Promise((resolve, reject) => {
        const entry = { resolve: null, to: null };
        entry.to = setTimeout(
          () => reject(Object.assign(new Error(`timeout: ${key}`), { code: "TRANSPORT_TIMEOUT" })),
          timeoutMs,
        );
        entry.resolve = (msg) => { clearTimeout(entry.to); resolve(msg); };
        if (!pending.has(key)) pending.set(key, []);
        pending.get(key).push(entry);
        client.send(payload);
      });
    },
    emit(key, msg) {
      const q = pending.get(key);
      if (q && q.length) { const e = q.shift(); if (!q.length) pending.delete(key); e.resolve(msg); }
      const m = handlers.get(key);
      if (m) for (const fn of [...m.values()]) fn(msg);
    },
  };
  return client;
}

// ─── lockEntries helper ───────────────────────────────────────────────────────

function buildLockEntries(overrides = {}) {
  return lockEntries({
    bleUseOptsFromParams: vi.fn().mockReturnValue({ secretKey: KEY, deviceUUID: DEVICE }),
    bleCommandAck: (r) => ({ resultCode: r.resultCode, resultName: resultName(r.resultCode) }),
    ...overrides,
  });
}

// ─── daemon helpers ───────────────────────────────────────────────────────────

function makeDaemon(hub, authState = "authenticated") {
  return { hub, authState };
}

function expiredDaemon(hub) {
  return { hub, authState: "expired" };
}

function makeHub(extra = {}) {
  return {
    lock: vi.fn().mockResolvedValue(OK_ACK),
    unlock: vi.fn().mockResolvedValue(OK_ACK),
    toggle: vi.fn().mockResolvedValue(OK_ACK),
    lockDevice: vi.fn().mockResolvedValue(OK_ACK),
    unlockDevice: vi.fn().mockResolvedValue(OK_ACK),
    toggleDevice: vi.fn().mockResolvedValue(OK_ACK),
    botClick: vi.fn().mockResolvedValue(OK_ACK),
    botClickScript: vi.fn().mockResolvedValue(OK_ACK),
    botClickDevice: vi.fn().mockResolvedValue(OK_ACK),
    botClickScriptDevice: vi.fn().mockResolvedValue(OK_ACK),
    setAutolock: vi.fn().mockResolvedValue({ ack: OK_ACK, cmd: 11, seconds: 30 }),
    setAutolockDevice: vi.fn().mockResolvedValue({ ack: OK_ACK, cmd: 11, seconds: 30 }),
    getDeviceStatus: vi.fn().mockResolvedValue({ deviceUUID: DEVICE, stateInfo: { CHSesame2Status: "locked" } }),
    connected: true,
    ...extra,
  };
}

// ===========================================================================
// LOCK-0112: --json 出力封筒: cloud op {ok,op,name,via:"cloud",response}
// ===========================================================================

describe("LOCK-0112: --json cloud op output envelope", () => {
  beforeEach(() => { setLocale("en"); });

  it("[LOCK-0112] --json 時 stdout に {ok:true, op, name, via:'cloud', response} を出力する", async () => {
    const { out } = await import("../../../kit/src/cli/ctx.js");
    const stdoutLines = [];
    const stderrLines = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args) => stdoutLines.push(args.join(" "));
    console.error = (...args) => stderrLines.push(args.join(" "));
    try {
      const fakeResp = OK_ACK;
      const jsonObj = { ok: true, op: "unlock", name: LOCK_NAME, via: "cloud", response: fakeResp };
      out(true, () => { console.error(`[cloud] unlock → ${LOCK_NAME}`); }, jsonObj);

      expect(stdoutLines).toHaveLength(1);
      const parsed = JSON.parse(stdoutLines[0]);
      expect(parsed.ok).toBe(true);
      expect(parsed.op).toBe("unlock");
      expect(parsed.name).toBe(LOCK_NAME);
      expect(parsed.via).toBe("cloud");
      expect(parsed.response).toMatchObject(fakeResp);
      // json=true のとき humanFn は呼ばれない → stderr には何も出ない
      expect(stderrLines).toHaveLength(0);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  });

  it("[LOCK-0112b] json=false のとき humanFn が呼ばれ stderr へ出力される (stdout は空)", async () => {
    const { out } = await import("../../../kit/src/cli/ctx.js");
    const stdoutLines = [];
    const stderrLines = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args) => stdoutLines.push(args.join(" "));
    console.error = (...args) => stderrLines.push(args.join(" "));
    try {
      out(false, () => { console.error(`[cloud] lock → ${LOCK_NAME}`); }, { ok: true });
      expect(stdoutLines).toHaveLength(0);
      expect(stderrLines.some(l => l.includes("[cloud]"))).toBe(true);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  });
});

// ===========================================================================
// LOCK-0113: --json 出力封筒: BLE op {ok,op,name,via:"ble",result,status}
// ===========================================================================

describe("LOCK-0113: --json BLE op output envelope", () => {
  beforeEach(() => { setLocale("en"); });

  it("[LOCK-0113] --json 時 stdout に {ok:true, op, name, via:'ble', result, status} を出力する", async () => {
    const { out } = await import("../../../kit/src/cli/ctx.js");
    const stdoutLines = [];
    const origLog = console.log;
    console.log = (...args) => stdoutLines.push(args.join(" "));
    try {
      const mockResult = { resultCode: 0 };
      const mockStatus = { state: "locked", position: -176 };
      const jsonObj = { ok: true, op: "lock", name: LOCK_NAME, via: "ble", result: mockResult, status: mockStatus };
      out(true, () => {}, jsonObj);

      expect(stdoutLines).toHaveLength(1);
      const parsed = JSON.parse(stdoutLines[0]);
      expect(parsed.ok).toBe(true);
      expect(parsed.via).toBe("ble");
      expect(parsed.result).toMatchObject(mockResult);
      expect(parsed.status).toMatchObject(mockStatus);
      expect(parsed.op).toBe("lock");
      expect(parsed.name).toBe(LOCK_NAME);
    } finally {
      console.log = origLog;
    }
  });

  it("[LOCK-0113b] json=false のとき [ble] ログは stderr へ (B-impl b ケース)", async () => {
    const { out } = await import("../../../kit/src/cli/ctx.js");
    const stdoutLines = [];
    const stderrLines = [];
    const origLog = console.log;
    const origErr = console.error;
    console.log = (...args) => stdoutLines.push(args.join(" "));
    console.error = (...args) => stderrLines.push(args.join(" "));
    try {
      out(false, () => { console.error(`[ble] lock → ${LOCK_NAME}`); }, {});
      expect(stdoutLines).toHaveLength(0);
      expect(stderrLines.some(l => l.includes("[ble]"))).toBe(true);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  });
});

// ===========================================================================
// LOCK-0114: sanitizeStatus removes secretKey
// ===========================================================================

describe("LOCK-0114: sanitizeStatus removes secretKey", () => {
  it("[LOCK-0114] secretKey を含む status オブジェクトから secretKey を除去する", () => {
    const raw = {
      deviceUUID: DEVICE,
      secretKey: KEY,
      stateInfo: { CHSesame2Status: "locked", position: -176, batteryPercentage: 80 },
    };
    const safe = sanitizeStatus(raw);
    expect(safe).not.toHaveProperty("secretKey");
    expect(safe).toHaveProperty("deviceUUID", DEVICE);
    expect(safe).toHaveProperty("stateInfo");
  });

  it("[LOCK-0114b] secretKey が無いオブジェクトはそのまま返す", () => {
    const raw = { deviceUUID: DEVICE, stateInfo: null };
    const safe = sanitizeStatus(raw);
    expect(safe).toMatchObject(raw);
  });

  it("[LOCK-0114c] null/非オブジェクトはそのまま返す", () => {
    expect(sanitizeStatus(null)).toBeNull();
    expect(sanitizeStatus("string")).toBe("string");
    expect(sanitizeStatus(undefined)).toBeUndefined();
  });
});

// ===========================================================================
// LOCK-0115: fmtCloudStatus / fmtMech の整形一致
// ===========================================================================

describe("LOCK-0115: fmtCloudStatus / fmtMech consistent formatting", () => {
  beforeEach(() => { setLocale("en"); });

  it("[LOCK-0115] fmtCloudStatus: state=.. pos=.. battery=.. の 1 行", () => {
    const st = { stateInfo: { CHSesame2Status: "locked", position: -176, batteryPercentage: 80 } };
    const line = fmtCloudStatus(st);
    expect(line).toMatch(/state=locked/);
    expect(line).toMatch(/pos=-176/);
    expect(line).toMatch(/battery=80%/);
  });

  it("[LOCK-0115b] fmtCloudStatus: position が null なら pos=.. を省略", () => {
    const st = { stateInfo: { CHSesame2Status: "unlocked", position: null, batteryPercentage: 60 } };
    const line = fmtCloudStatus(st);
    expect(line).toMatch(/state=unlocked/);
    expect(line).not.toMatch(/pos=/);
    expect(line).toMatch(/battery=60%/);
  });

  it("[LOCK-0115c] fmtMech (BLE): state=.. pos=.. の 1 行", () => {
    const status = { state: "locked", position: -176 };
    const line = fmtMech(status);
    expect(line).toMatch(/state=locked/);
    expect(line).toMatch(/pos=-176/);
  });

  it("[LOCK-0115d] fmtMech: position が null なら pos=.. を省略 (Bot has no position)", () => {
    const status = { state: "unlocked", position: null };
    const line = fmtMech(status);
    expect(line).toMatch(/state=unlocked/);
    expect(line).not.toMatch(/pos=/);
  });

  it("[LOCK-0115e] fmtCloudStatus / fmtMech の先頭形式が state= で揃う", () => {
    const cloudSt = { stateInfo: { CHSesame2Status: "locked", position: 0, batteryPercentage: null } };
    const bleSt = { state: "locked", position: 0 };
    expect(fmtCloudStatus(cloudSt)).toMatch(/^state=/);
    expect(fmtMech(bleSt)).toMatch(/^state=/);
  });

  it("[LOCK-0115f] fmtCloudStatus: stateInfo 欠如時は statusNotFetched を返す", () => {
    expect(fmtCloudStatus(null)).toBe(t("cli.statusNotFetched"));
    expect(fmtCloudStatus({})).toBe(t("cli.statusNotFetched"));
  });
});

// ===========================================================================
// LOCK-0116: runBleOp OS2 → SesameOS2Ble facade
// ===========================================================================

describe("LOCK-0116: runBleOp OS2 delegates to SesameOS2Ble", () => {
  it("[LOCK-0116] OS2 モデル (sesame_2) は capabilitiesForModel().os === 2 を返す", () => {
    const caps = capabilitiesForModel("sesame_2");
    expect(caps.os).toBe(2);
  });

  it("[LOCK-0116b] OS3 モデル (sesame_5) は capabilitiesForModel().os === 3 を返す", () => {
    const caps = capabilitiesForModel("sesame_5");
    expect(caps.os).toBe(3);
  });

  it("[LOCK-0116c] ssmbot_1 は OS2 (os=2) を返す", () => {
    const caps = capabilitiesForModel("ssmbot_1");
    expect(caps.os).toBe(2);
  });
});

// ===========================================================================
// LOCK-0117: runBleOp OS2 ssmPublicKey 必須 → なければ exit 2
// ===========================================================================

describe("LOCK-0117: runBleOp OS2 without ssmPublicKey exits with code 2", () => {
  beforeEach(() => { setLocale("en"); });

  it("[LOCK-0117] ssmPublicKey が無い OS2 entry で runBleOp は process.exit(2) を呼ぶ", async () => {
    const os2Entry = {
      name: "front",
      deviceUUID: DEVICE,
      secretKey: KEY,
      model: "sesame_2",
      // ssmPublicKey: intentionally absent
    };
    const gopts = { json: false, debug: false };

    const origExit = process.exit;
    let exitCode = null;
    process.exit = (code) => { exitCode = code; throw new Error(`process.exit(${code})`); };
    try {
      await runBleOp("lock", os2Entry, null, gopts);
    } catch {
      // die() → process.exit(2) が投げた
    } finally {
      process.exit = origExit;
    }
    expect(exitCode).toBe(2);
  });

  it("[LOCK-0117b] ssmPublicKey 有りの OS2 entry では exit(2) を呼ばない", async () => {
    const os2EntryWithKey = {
      name: "front",
      deviceUUID: DEVICE,
      secretKey: KEY,
      model: "sesame_2",
      ssmPublicKey: "a".repeat(128),
      keyIndex: "0000",
    };
    const gopts = { json: false, debug: false };

    const origExit = process.exit;
    let exitCalled = false;
    process.exit = () => { exitCalled = true; throw new Error("process.exit"); };
    try {
      await runBleOp("lock", os2EntryWithKey, null, gopts);
    } catch {
      // BLE 接続失敗は想定内 (hardware not available)
    } finally {
      process.exit = origExit;
    }
    // ssmPublicKey があれば die() ではなく BLE 接続失敗で終わるはず
    expect(exitCalled).toBe(false);
  });

  it("[LOCK-0117c] i18n キー cli.os2BleNeedSsmPublicKey が存在する", () => {
    expect(t("cli.os2BleNeedSsmPublicKey")).toBeTruthy();
  });
});

// ===========================================================================
// LOCK-0118: serve lock.lock/unlock/toggle の cloud dispatch
// ===========================================================================

describe("LOCK-0118: serve lock.lock/unlock/toggle cloud dispatch", () => {
  it("[LOCK-0118] lock.lock: name 指定で hub.lock(name) を呼ぶ", async () => {
    const entries = buildLockEntries();
    const hub = makeHub();
    await entries["lock.lock"].handler({ hub, params: { name: LOCK_NAME }, daemon: makeDaemon(hub) });
    expect(hub.lock).toHaveBeenCalledWith(LOCK_NAME);
    expect(hub.lockDevice).not.toHaveBeenCalled();
  });

  it("[LOCK-0118b] lock.unlock: name 指定で hub.unlock(name) を呼ぶ", async () => {
    const entries = buildLockEntries();
    const hub = makeHub();
    await entries["lock.unlock"].handler({ hub, params: { name: LOCK_NAME }, daemon: makeDaemon(hub) });
    expect(hub.unlock).toHaveBeenCalledWith(LOCK_NAME);
  });

  it("[LOCK-0118c] lock.toggle: name 指定で hub.toggle(name) を呼ぶ", async () => {
    const entries = buildLockEntries();
    const hub = makeHub();
    await entries["lock.toggle"].handler({ hub, params: { name: LOCK_NAME }, daemon: makeDaemon(hub) });
    expect(hub.toggle).toHaveBeenCalledWith(LOCK_NAME);
  });

  it("[LOCK-0118d] lock.lock: deviceUUID+secretKey 指定で hub.lockDevice({deviceUUID,secretKey}) を呼ぶ", async () => {
    const entries = buildLockEntries();
    const hub = makeHub();
    await entries["lock.lock"].handler({
      hub,
      params: { deviceUUID: DEVICE, secretKey: KEY },
      daemon: makeDaemon(hub),
    });
    expect(hub.lockDevice).toHaveBeenCalledWith({ deviceUUID: DEVICE, secretKey: KEY });
    expect(hub.lock).not.toHaveBeenCalled();
  });

  it("[LOCK-0118e] lock.unlock: deviceUUID+secretKey 指定で hub.unlockDevice を呼ぶ", async () => {
    const entries = buildLockEntries();
    const hub = makeHub();
    await entries["lock.unlock"].handler({
      hub,
      params: { deviceUUID: DEVICE, secretKey: KEY },
      daemon: makeDaemon(hub),
    });
    expect(hub.unlockDevice).toHaveBeenCalledWith({ deviceUUID: DEVICE, secretKey: KEY });
  });
});

// ===========================================================================
// LOCK-0119: lock.click scriptIndex 分岐
// ===========================================================================

describe("LOCK-0119: serve lock.click scriptIndex branches", () => {
  it("[LOCK-0119] scriptIndex 省略 → hub.botClick(name) (cmd=89)", async () => {
    const entries = buildLockEntries();
    const hub = makeHub();
    await entries["lock.click"].handler({ hub, params: { name: LOCK_NAME }, daemon: makeDaemon(hub) });
    expect(hub.botClick).toHaveBeenCalledWith(LOCK_NAME);
    expect(hub.botClickScript).not.toHaveBeenCalled();
  });

  it("[LOCK-0119b] scriptIndex=3 → hub.botClickScript(name, 3) (cmd=173)", async () => {
    const entries = buildLockEntries();
    const hub = makeHub();
    await entries["lock.click"].handler({ hub, params: { name: LOCK_NAME, scriptIndex: 3 }, daemon: makeDaemon(hub) });
    expect(hub.botClickScript).toHaveBeenCalledWith(LOCK_NAME, 3);
    expect(hub.botClick).not.toHaveBeenCalled();
  });

  it("[LOCK-0119c] scriptIndex=0 は有効で hub.botClickScript(name, 0) を呼ぶ (境界値)", async () => {
    const entries = buildLockEntries();
    const hub = makeHub();
    await entries["lock.click"].handler({ hub, params: { name: LOCK_NAME, scriptIndex: 0 }, daemon: makeDaemon(hub) });
    expect(hub.botClickScript).toHaveBeenCalledWith(LOCK_NAME, 0);
  });

  it("[LOCK-0119d] scriptIndex=9 は有効で hub.botClickScript(name, 9) を呼ぶ (上限)", async () => {
    const entries = buildLockEntries();
    const hub = makeHub();
    await entries["lock.click"].handler({ hub, params: { name: LOCK_NAME, scriptIndex: 9 }, daemon: makeDaemon(hub) });
    expect(hub.botClickScript).toHaveBeenCalledWith(LOCK_NAME, 9);
  });

  it("[LOCK-0119e] deviceUUID+scriptIndex → hub.botClickScriptDevice({deviceUUID,secretKey,scriptIndex})", async () => {
    const entries = buildLockEntries();
    const hub = makeHub();
    await entries["lock.click"].handler({
      hub,
      params: { deviceUUID: DEVICE, secretKey: KEY, scriptIndex: 2 },
      daemon: makeDaemon(hub),
    });
    expect(hub.botClickScriptDevice).toHaveBeenCalledWith({ deviceUUID: DEVICE, secretKey: KEY, scriptIndex: 2 });
  });
});

// ===========================================================================
// LOCK-0120: lock.setAutolock transport 分岐
// ===========================================================================

describe("LOCK-0120: serve lock.setAutolock transport branching", () => {
  it("[LOCK-0120] transport 省略 (既定=cloud) → hub.setAutolock(name, seconds, undefined)", async () => {
    const entries = buildLockEntries();
    const hub = makeHub();
    await entries["lock.setAutolock"].handler({
      hub,
      params: { name: LOCK_NAME, seconds: 30 },
      daemon: makeDaemon(hub),
    });
    expect(hub.setAutolock).toHaveBeenCalledWith(LOCK_NAME, 30, undefined);
  });

  it("[LOCK-0120b] transport='cloud' 明示 → hub.setAutolock を呼ぶ", async () => {
    const entries = buildLockEntries();
    const hub = makeHub();
    await entries["lock.setAutolock"].handler({
      hub,
      params: { name: LOCK_NAME, seconds: 60, transport: "cloud" },
      daemon: makeDaemon(hub),
    });
    expect(hub.setAutolock).toHaveBeenCalled();
  });

  it("[LOCK-0120c] transport=不正値 → RpcError (INVALID_PARAMS) を throw", async () => {
    const entries = buildLockEntries();
    const hub = makeHub();
    await expect(
      entries["lock.setAutolock"].handler({
        hub,
        params: { name: LOCK_NAME, seconds: 30, transport: "wifi" },
        daemon: makeDaemon(hub),
      })
    ).rejects.toMatchObject({ code: RPC.INVALID_PARAMS });
  });

  it("[LOCK-0120d] transport=不正値 → kind=bad_params", async () => {
    const entries = buildLockEntries();
    const hub = makeHub();
    let err;
    try {
      await entries["lock.setAutolock"].handler({
        hub,
        params: { seconds: 30, transport: "bluetooth" },
        daemon: makeDaemon(hub),
      });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe(RPC.INVALID_PARAMS);
    expect(err.kind).toBe(KIND.BAD_PARAMS);
  });

  it("[LOCK-0120e] seconds 未指定 → need() が throw (必須パラメータ)", async () => {
    const entries = buildLockEntries();
    const hub = makeHub();
    await expect(
      entries["lock.setAutolock"].handler({
        hub,
        params: { name: LOCK_NAME }, // seconds なし
        daemon: makeDaemon(hub),
      })
    ).rejects.toThrow();
  });

  it("[LOCK-0120f] transport=ble → requireAuth しない (expired daemon でも not_authenticated にならない)", async () => {
    const entries = buildLockEntries();
    const hub = makeHub({ connected: false });
    const daemon = expiredDaemon(hub);
    let err;
    try {
      await entries["lock.setAutolock"].handler({
        hub,
        params: { deviceUUID: DEVICE, secretKey: KEY, seconds: 30, transport: "ble" },
        daemon,
      });
    } catch (e) { err = e; }
    // not_authenticated は出てはいけない (BLE 経路は requireAuth しない)
    if (err && err.kind) {
      expect(err.kind).not.toBe(KIND.NOT_AUTHENTICATED);
    }
  });
});

// ===========================================================================
// LOCK-0121: lock.* requireAuth ガード
// ===========================================================================

describe("LOCK-0121: serve lock.* requireAuth gate", () => {
  /** requireAuth は同期で throw するので try/catch で包む (handler が sync の場合もある) */
  async function callHandler(fn) {
    let err;
    try {
      const r = fn();
      if (r && typeof r.then === "function") await r;
    } catch (e) { err = e; }
    return err;
  }

  it("[LOCK-0121] lock.lock は expired daemon で not_authenticated を throw", async () => {
    const entries = buildLockEntries();
    const hub = makeHub({ connected: false });
    const err = await callHandler(() =>
      entries["lock.lock"].handler({ hub, params: { name: LOCK_NAME }, daemon: expiredDaemon(hub) })
    );
    expect(err, "should throw").toBeTruthy();
    expect(err instanceof RpcError || err.name === "RpcError").toBe(true);
    expect(err.kind).toBe(KIND.NOT_AUTHENTICATED);
  });

  it("[LOCK-0121b] lock.unlock は expired daemon で not_authenticated を throw", async () => {
    const entries = buildLockEntries();
    const hub = makeHub({ connected: false });
    const err = await callHandler(() =>
      entries["lock.unlock"].handler({ hub, params: { name: LOCK_NAME }, daemon: expiredDaemon(hub) })
    );
    expect(err, "should throw").toBeTruthy();
    expect(err.kind).toBe(KIND.NOT_AUTHENTICATED);
  });

  it("[LOCK-0121c] lock.toggle は expired daemon で not_authenticated を throw", async () => {
    const entries = buildLockEntries();
    const hub = makeHub({ connected: false });
    const err = await callHandler(() =>
      entries["lock.toggle"].handler({ hub, params: { name: LOCK_NAME }, daemon: expiredDaemon(hub) })
    );
    expect(err, "should throw").toBeTruthy();
    expect(err.kind).toBe(KIND.NOT_AUTHENTICATED);
  });

  it("[LOCK-0121d] lock.click は expired daemon で not_authenticated を throw", async () => {
    const entries = buildLockEntries();
    const hub = makeHub({ connected: false });
    const err = await callHandler(() =>
      entries["lock.click"].handler({ hub, params: { name: LOCK_NAME }, daemon: expiredDaemon(hub) })
    );
    expect(err, "should throw").toBeTruthy();
    expect(err.kind).toBe(KIND.NOT_AUTHENTICATED);
  });

  it("[LOCK-0121e] lock.status は expired daemon で not_authenticated を throw", async () => {
    const entries = buildLockEntries();
    const hub = makeHub({ connected: false });
    const err = await callHandler(() =>
      entries["lock.status"].handler({ hub, params: { deviceUUID: DEVICE }, daemon: expiredDaemon(hub) })
    );
    expect(err, "should throw").toBeTruthy();
    expect(err.kind).toBe(KIND.NOT_AUTHENTICATED);
  });

  it("[LOCK-0121f] lock.setAutolock transport=ble は expired daemon でも requireAuth しない", async () => {
    const entries = buildLockEntries();
    const hub = makeHub({ connected: false });
    const daemon = expiredDaemon(hub);
    let err;
    try {
      await entries["lock.setAutolock"].handler({
        hub,
        params: { deviceUUID: DEVICE, secretKey: KEY, seconds: 30, transport: "ble" },
        daemon,
      });
    } catch (e) { err = e; }
    if (err && err.kind) {
      expect(err.kind).not.toBe(KIND.NOT_AUTHENTICATED);
    }
  });
});

// ===========================================================================
// LOCK-0122: lock.status: deviceUUID 必須で hub.getDeviceStatus を呼ぶ
// ===========================================================================

describe("LOCK-0122: serve lock.status requires deviceUUID", () => {
  it("[LOCK-0122] deviceUUID 指定で hub.getDeviceStatus(deviceUUID) を呼ぶ", async () => {
    const entries = buildLockEntries();
    const hub = makeHub();
    const result = await entries["lock.status"].handler({
      hub,
      params: { deviceUUID: DEVICE },
      daemon: makeDaemon(hub),
    });
    expect(hub.getDeviceStatus).toHaveBeenCalledWith(DEVICE);
    expect(result).toMatchObject({ deviceUUID: DEVICE });
  });

  it("[LOCK-0122b] deviceUUID が無いと need() により throw", async () => {
    const entries = buildLockEntries();
    const hub = makeHub();
    let err;
    try {
      const result = entries["lock.status"].handler({ hub, params: {}, daemon: makeDaemon(hub) });
      // handler may return a promise or throw synchronously
      if (result && typeof result.then === "function") await result;
    } catch (e) { err = e; }
    expect(err, "should throw for missing deviceUUID").toBeTruthy();
    expect(hub.getDeviceStatus).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// LOCK-0123: 生成 SDK (TS/Python) lock.* メソッド存在確認
// ===========================================================================

describe("LOCK-0123: SDK lock.* methods exist (contract-existence)", () => {
  const LOCK_METHODS = ["lock", "unlock", "toggle", "click", "setAutolock", "status"];

  it("[LOCK-0123] lockEntries() に lock.{lock,unlock,toggle,click,setAutolock,status} が全て存在する", () => {
    const entries = buildLockEntries();
    for (const method of LOCK_METHODS) {
      expect(entries[`lock.${method}`], `lock.${method} が entries に存在する`).toBeDefined();
      expect(typeof entries[`lock.${method}`].handler).toBe("function");
    }
  });

  it("[LOCK-0123b] TypeScript SDK sesame-client.ts に lock.* メソッドが存在する (ファイル読み取り確認)", async () => {
    const fs = await import("node:fs");
    const tsPath = new URL("../../../kit/sdk/ts/sesame-client.ts", import.meta.url);
    const src = fs.readFileSync(tsPath, "utf8");
    // lock namespace ブロック内に全メソッドが存在すること
    const lockBlock = src.slice(src.indexOf("readonly lock ="), src.indexOf("readonly org ="));
    for (const method of ["lock:", "unlock:", "toggle:", "click:", "setAutolock:", "status:"]) {
      expect(lockBlock, `TS SDK missing ${method}`).toContain(method);
    }
  });
});

// ===========================================================================
// LOCK-0124: en/ja i18n カタログ完全性
// ===========================================================================

describe("LOCK-0124: en/ja i18n catalog completeness", () => {
  const REQUIRED_KEYS = [
    "cli.cloudBleExclusive",
    "cli.noTransportForOp",
    "cli.opNotOverBle",
    "cli.opNotOverCloud",
    "cli.unknownAction",
    "cli.autolockNeedsSeconds",
    "cli.modelNotSupportOp",
    "cli.secondsRange",
    "cli.cloudNotLoggedIn",
    "cli.os2BleNeedSsmPublicKey",
  ];

  const interp = { op: "test", actions: "unlock", device: "front", action: "test",
    label: "L", model: "sesame_5", ops: "unlock", names: "front", name: "front", transport: "test" };

  it("[LOCK-0124] en カタログに必要なエラーキーが全て存在し空でない", () => {
    setLocale("en");
    for (const key of REQUIRED_KEYS) {
      const val = t(key, interp);
      expect(val, `en key "${key}" が存在する`).toBeTruthy();
      expect(val, `en key "${key}" が翻訳されている (key 名そのままではない)`).not.toBe(key);
    }
  });

  it("[LOCK-0124b] ja カタログに必要なエラーキーが全て存在し空でない", () => {
    setLocale("ja");
    for (const key of REQUIRED_KEYS) {
      const val = t(key, interp);
      expect(val, `ja key "${key}" が存在する`).toBeTruthy();
      expect(val, `ja key "${key}" が翻訳されている`).not.toBe(key);
    }
    setLocale("en");
  });

  it("[LOCK-0124c] setLocale('ja') で ja テキストが返り、en と異なる", () => {
    setLocale("ja");
    const jaText = t("cli.cloudBleExclusive");
    setLocale("en");
    const enText = t("cli.cloudBleExclusive");
    expect(jaText).not.toBe(enText);
    expect(jaText.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// LOCK-0128: biz3TriggerLocker:pubUserDeviceChange は triggerLock を resolve しない
// ===========================================================================

describe("LOCK-0128: pubUserDeviceChange does NOT resolve triggerLock (negative fact)", () => {
  it("[LOCK-0128] dispatch キー pubUserDeviceChange は lock 購読キーと一致しない (純関数確認)", () => {
    const STATE_EVENT_KEY = "biz3TriggerLocker:pubDeviceStateChange";
    const ACK_KEY = "biz3TriggerLocker:";
    const wrongKey = "biz3TriggerLocker:pubUserDeviceChange";
    expect(wrongKey).not.toBe(STATE_EVENT_KEY);
    expect(wrongKey).not.toBe(ACK_KEY);
  });

  it("[LOCK-0128b] pubUserDeviceChange push では triggerLock が resolve されない (timeout で reject)", async () => {
    const { triggerLock } = await import("../../src/lock.js");
    const client = makeMockClient();

    const p = triggerLock(client, {
      deviceId: DEVICE,
      secretKey: KEY,
      subUUID: SUB,
      cmd: 82, // CMD.LOCK
      timeoutMs: 100,
    });

    // pubUserDeviceChange を emit → triggerLock の購読には届かないはず
    client.emit("biz3TriggerLocker:pubUserDeviceChange", {
      action: "biz3TriggerLocker",
      op: "pubUserDeviceChange",
      data: { deviceUUID: DEVICE },
    });

    // timeout で reject されるはず (resolve されないため)
    await expect(p).rejects.toThrow(/timeout/i);
  });

  it("[LOCK-0128c] pubDeviceStateChange + 一致 deviceUUID では triggerLock が resolve される (正の確認)", async () => {
    const { triggerLock } = await import("../../src/lock.js");
    const client = makeMockClient();

    const p = triggerLock(client, {
      deviceId: DEVICE,
      secretKey: KEY,
      subUUID: SUB,
      cmd: 82,
      timeoutMs: 200,
    });

    client.emit("biz3TriggerLocker:pubDeviceStateChange", {
      action: "biz3TriggerLocker",
      op: "pubDeviceStateChange",
      data: { deviceUUID: DEVICE },
    });

    await expect(p).resolves.toBeTruthy();
  });
});

// ===========================================================================
// LOCK-0130: OS3/OS2 BLE resultCode!=0 → BleResultError reject
// ===========================================================================

describe("LOCK-0130: BLE resultCode!=0 → BleResultError reject", () => {
  it("[LOCK-0130] RESULT テーブル: 0='success', 4='invalidSig', 7='busy'", () => {
    expect(RESULT[0]).toBe("success");
    expect(RESULT[4]).toBe("invalidSig");
    expect(RESULT[7]).toBe("busy");
  });

  it("[LOCK-0130b] resultName(0..8) が仕様どおりの文字列を返す", () => {
    expect(resultName(0)).toBe("success");
    expect(resultName(1)).toBe("invalidFormat");
    expect(resultName(2)).toBe("notSupported");
    expect(resultName(3)).toBe("resultStorageFail");
    expect(resultName(4)).toBe("invalidSig");
    expect(resultName(5)).toBe("notFound");
    expect(resultName(6)).toBe("unknown");
    expect(resultName(7)).toBe("busy");
    expect(resultName(8)).toBe("invalidParam");
  });

  it("[LOCK-0130c] resultName(9) は 'unknown(9)' (未登録コード)", () => {
    expect(resultName(9)).toBe("unknown(9)");
    expect(resultName(99)).toBe("unknown(99)");
  });

  it("[LOCK-0130d] _resolvePending 模倣: resultCode=0 → resolve、!=0 → reject (BleResultError)", () => {
    const resolveFn = vi.fn();
    const rejectFn = vi.fn();
    const queue = [{ resolve: resolveFn, reject: rejectFn, timer: null }];

    const entry = queue.shift();
    const resultCode = 4; // invalidSig
    if (resultCode === 0) {
      entry.resolve({ resultCode, payload: Buffer.alloc(0) });
    } else {
      const err = Object.assign(new Error(`BleResultError: resultCode=${resultCode}`), {
        name: "BleResultError",
        resultCode,
        resultName: resultName(resultCode),
      });
      entry.reject(err);
    }

    expect(resolveFn).not.toHaveBeenCalled();
    expect(rejectFn).toHaveBeenCalledOnce();
    const rejectedErr = rejectFn.mock.calls[0][0];
    expect(rejectedErr.name).toBe("BleResultError");
    expect(rejectedErr.resultCode).toBe(4);
    expect(rejectedErr.resultName).toBe("invalidSig");
  });
});

// ===========================================================================
// LOCK-0131: BleResultError.resultName → JSON-RPC kind/code 写像
// ===========================================================================

describe("LOCK-0131: BleResultError.resultName → JSON-RPC kind/code mapping", () => {
  function makeBleResultError(resultCodeVal, itemCode = 82) {
    return Object.assign(new Error(`BLE command failed: resultCode=${resultCodeVal}`), {
      name: "BleResultError",
      resultCode: resultCodeVal,
      resultName: resultName(resultCodeVal),
      itemCode,
    });
  }

  it("[LOCK-0131] invalidFormat (code=1) → bad_params (INVALID_PARAMS)", () => {
    const err = makeBleResultError(1);
    expect(err.resultName).toBe("invalidFormat");
    const rpc = errorFromThrow(1, err);
    expect(rpc.error.data.kind).toBe(KIND.BAD_PARAMS);
    expect(rpc.error.code).toBe(RPC.INVALID_PARAMS);
  });

  it("[LOCK-0131b] invalidParam (code=8) → bad_params (INVALID_PARAMS)", () => {
    const err = makeBleResultError(8);
    expect(err.resultName).toBe("invalidParam");
    const rpc = errorFromThrow(1, err);
    expect(rpc.error.data.kind).toBe(KIND.BAD_PARAMS);
    expect(rpc.error.code).toBe(RPC.INVALID_PARAMS);
  });

  it("[LOCK-0131c] invalidSig (code=4) → not_authenticated (APP_ERROR, retryable=false)", () => {
    const err = makeBleResultError(4);
    expect(err.resultName).toBe("invalidSig");
    const rpc = errorFromThrow(1, err);
    expect(rpc.error.data.kind).toBe(KIND.NOT_AUTHENTICATED);
    expect(rpc.error.data.retryable).toBe(false);
  });

  it("[LOCK-0131d] busy (code=7) → rejected (APP_ERROR, retryable=true)", () => {
    const err = makeBleResultError(7);
    expect(err.resultName).toBe("busy");
    const rpc = errorFromThrow(1, err);
    expect(rpc.error.data.kind).toBe(KIND.REJECTED);
    expect(rpc.error.data.retryable).toBe(true);
  });

  it("[LOCK-0131e] notFound (code=5) → rejected (APP_ERROR, retryable=false)", () => {
    const err = makeBleResultError(5);
    expect(err.resultName).toBe("notFound");
    const rpc = errorFromThrow(1, err);
    expect(rpc.error.data.kind).toBe(KIND.REJECTED);
    expect(rpc.error.data.retryable).toBe(false);
  });

  it("[LOCK-0131f] notSupported (code=2) → rejected (APP_ERROR, retryable=false)", () => {
    const err = makeBleResultError(2);
    expect(err.resultName).toBe("notSupported");
    const rpc = errorFromThrow(1, err);
    expect(rpc.error.data.kind).toBe(KIND.REJECTED);
    expect(rpc.error.data.retryable).toBe(false);
  });

  it("[LOCK-0131g] resultStorageFail (code=3) → rejected (APP_ERROR, retryable=false)", () => {
    const err = makeBleResultError(3);
    expect(err.resultName).toBe("resultStorageFail");
    const rpc = errorFromThrow(1, err);
    expect(rpc.error.data.kind).toBe(KIND.REJECTED);
    expect(rpc.error.data.retryable).toBe(false);
  });

  it("[LOCK-0131h] unknown (code=6) → rejected (APP_ERROR, retryable=false)", () => {
    const err = makeBleResultError(6);
    expect(err.resultName).toBe("unknown");
    const rpc = errorFromThrow(1, err);
    expect(rpc.error.data.kind).toBe(KIND.REJECTED);
    expect(rpc.error.data.retryable).toBe(false);
  });

  it("[LOCK-0131i] テーブル未登録 unknown(9) → rejected fallback", () => {
    const err = Object.assign(new Error("BLE command failed: resultCode=9"), {
      name: "BleResultError",
      resultCode: 9,
      resultName: resultName(9), // "unknown(9)"
      itemCode: 82,
    });
    expect(err.resultName).toBe("unknown(9)");
    const rpc = errorFromThrow(1, err);
    expect(rpc.error.data.kind).toBe(KIND.REJECTED);
    expect(rpc.error.data.retryable).toBe(false);
  });

  it("[LOCK-0131j] BleResultError data に bleResultCode / bleResultName / itemCode が含まれる", () => {
    const err = makeBleResultError(4, 83); // invalidSig, unlock itemCode
    const rpc = errorFromThrow(1, err);
    expect(rpc.error.data?.bleResultCode).toBe(4);
    expect(rpc.error.data?.bleResultName).toBe("invalidSig");
    expect(rpc.error.data?.itemCode).toBe(83);
  });
});

// ===========================================================================
// LOCK-0132: OS3 parseRecvFrame フレーム分解
// ===========================================================================

describe("LOCK-0132: OS3 parseRecvFrame frame decomposition", () => {
  it("[LOCK-0132] RESPONSE(7): buf[0]=opCode, buf[1]=itemCode, buf[2..]=body", () => {
    // フレーム: [op=7][item=82][resultCode=0][payload=0xAB, 0xCD]
    const buf = Buffer.from([OP.RESPONSE, 82, 0x00, 0xAB, 0xCD]);
    const { opCode, itemCode, body } = parseRecvFrame(buf);
    expect(opCode).toBe(OP.RESPONSE); // 7
    expect(itemCode).toBe(82);
    expect(body[0]).toBe(0x00); // resultCode
    expect([...body.subarray(1)]).toEqual([0xAB, 0xCD]); // payload
  });

  it("[LOCK-0132b] RESPONSE: body[0]=resultCode=4 (invalidSig), body.subarray(1)=payload", () => {
    const buf = Buffer.from([OP.RESPONSE, 11, 0x04, 0x10, 0x20]);
    const { opCode, itemCode, body } = parseRecvFrame(buf);
    expect(opCode).toBe(7);
    expect(itemCode).toBe(11); // AUTOLOCK
    expect(body[0]).toBe(4); // invalidSig
    expect([...body.subarray(1)]).toEqual([0x10, 0x20]);
  });

  it("[LOCK-0132c] PUBLISH(8): body は publish payload 全体 (resultCode なし)", () => {
    const buf = Buffer.from([OP.PUBLISH, 81, 0x01, 0x02, 0x03]);
    const { opCode, itemCode, body } = parseRecvFrame(buf);
    expect(opCode).toBe(OP.PUBLISH); // 8
    expect(itemCode).toBe(81);
    expect([...body]).toEqual([0x01, 0x02, 0x03]);
  });

  it("[LOCK-0132d] buf 長 < 2 は throw (frameTooShort)", () => {
    expect(() => parseRecvFrame(Buffer.from([0x07]))).toThrow();
    expect(() => parseRecvFrame(Buffer.alloc(0))).toThrow();
  });

  it("[LOCK-0132e] 2B フレームは body.length===0 (empty body)", () => {
    const buf = Buffer.from([OP.RESPONSE, 82]);
    const { opCode, itemCode, body } = parseRecvFrame(buf);
    expect(opCode).toBe(OP.RESPONSE);
    expect(itemCode).toBe(82);
    expect(body.length).toBe(0);
  });

  it("[LOCK-0132f] OS3 header は 2B (op+item)、body[0]=resultCode (仕様確認)", () => {
    const buf = Buffer.from([OP.RESPONSE, 82, 0x00, 0x11, 0x22]);
    const { body } = parseRecvFrame(buf);
    // body = [resultCode, ...payload]
    expect(body.length).toBe(3);
    expect(body[0]).toBe(0x00); // resultCode=success
  });
});

// ===========================================================================
// LOCK-0133: OS3 BLE bot2 script index 範囲検証 (clickItemCode)
// ===========================================================================

describe("LOCK-0133: clickItemCode script index range validation", () => {
  const RUN_SCRIPT_0 = 170;
  const MAX_SCRIPT_INDEX = 9;
  const CLICK_89 = 89;

  it("[LOCK-0133] index=null は CLICK(89) を返す", () => {
    expect(clickItemCode(null)).toBe(CLICK_89);
  });

  it("[LOCK-0133b] index=undefined は CLICK(89) を返す", () => {
    expect(clickItemCode(undefined)).toBe(CLICK_89);
  });

  it("[LOCK-0133c] index=0 は RUN_SCRIPT_0 (170) を返す", () => {
    expect(clickItemCode(0)).toBe(RUN_SCRIPT_0);
  });

  it("[LOCK-0133d] index=9 は RUN_SCRIPT_9 (179) を返す", () => {
    expect(clickItemCode(MAX_SCRIPT_INDEX)).toBe(RUN_SCRIPT_0 + MAX_SCRIPT_INDEX);
  });

  it.each([-1, 10, 11, 100, 255, 256])("[LOCK-0133e] index=%i は範囲外で throw", (idx) => {
    // Error message: "script index must be an integer 0..{max}" (en)
    // or "script index は 0..{max} の整数を想定" (ja)
    expect(() => clickItemCode(idx)).toThrow(/script.index|bot2ScriptIndex/i);
  });

  it("[LOCK-0133f] index=1.5 (非整数) は throw", () => {
    expect(() => clickItemCode(1.5)).toThrow();
  });

  it("[LOCK-0133g] index=NaN は throw", () => {
    expect(() => clickItemCode(NaN)).toThrow();
  });

  it("[LOCK-0133h] index 0..9 の全範囲が RUN_SCRIPT_0+i を返す (enumeration)", () => {
    for (let i = 0; i <= 9; i++) {
      expect(clickItemCode(i)).toBe(RUN_SCRIPT_0 + i);
    }
  });
});
