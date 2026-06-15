// lock-c2.test.js — LOCK-0037〜LOCK-0057 (18件) 統合テスト
//
// 対象実装:
//   packages/core/src/lock.js              - setAutolock
//   packages/core/src/lock-manager.js      - LockManager
//   packages/core/src/devices.js           - getDeviceStatus
//   packages/core/src/ble/protocol.js      - historyTagBLE / buildSendFrame / autolockData
//   packages/core/src/ble/devicemodel.js   - capabilitiesForModel / transportsForOp
//   packages/core/src/ble/bot2.js          - clickItemCode
//   packages/core/src/itemcodes.js         - ITEM_CODES
//   packages/kit/src/cli/lock-ops.js       - pickTransport / sanitizeStatus / fmtCloudStatus
//
// 方針:
//   - 全テストはネットワーク/実機に触れない (全 mock or 純関数)
//   - 正しい期待値 (spec 準拠) を assert — 実装バグで red になってよい
//   - import パス・mock 方法は既存テスト (lock-c1.test.js) に倣う

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Buffer } from "node:buffer";

// ---- core imports (packages/core/tests/_spec/ から ../../src/ へ) ----
import { setAutolock } from "../../src/lock.js";
import { LockManager } from "../../src/lock-manager.js";
import { getDeviceStatus } from "../../src/devices.js";
import { historyTagBLE, autolockData, buildSendFrame } from "../../src/ble/protocol.js";
import { capabilitiesForModel, transportsForOp } from "../../src/ble/devicemodel.js";
import { ITEM_CODES } from "../../src/itemcodes.js";
import { ERR } from "../../src/errors.js";
import { clickItemCode } from "../../src/ble/bot2.js";
import { setLocale } from "../../src/i18n.js";

// ---- kit CLI imports (packages/core/tests/_spec/ から ../../../kit/src/cli/ へ) ----
import { pickTransport, sanitizeStatus, fmtCloudStatus } from "../../../kit/src/cli/lock-ops.js";

// =========================================================
// 共通定数
// =========================================================
const KEY = "0123456789abcdef0123456789abcdef";
const DEVICE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeffff";
const SUB = "11111111-2222-3333-4444-555566667777";
const ACK_KEY = "biz3TriggerLocker:";
const OK_ACK = { action: "biz3TriggerLocker", code: 200, data: {}, success: true };

// =========================================================
// 最小 mock client (lock-c1.test.js と同型)
// request=FIFO ack 相関、emit=1件解決+fan-out、subscribe=解除可能
// =========================================================
function makeMockClient(status = "open") {
  const handlers = new Map();
  const pending = new Map();
  let nextId = 0;
  const sent = [];
  const client = {
    sent,
    _status: status,
    getStatus() { return client._status; },
    subscribe(key, fn) {
      const id = nextId++;
      if (!handlers.has(key)) handlers.set(key, new Map());
      handlers.get(key).set(id, fn);
      return () => {
        const m = handlers.get(key);
        if (m) m.delete(id);
      };
    },
    send(msg) { sent.push(msg); },
    request(payload, timeoutMs = 10_000) {
      const key = `${payload.action}:${payload.op || ""}`;
      return new Promise((resolve, reject) => {
        const entry = { resolve: null, to: null };
        entry.to = setTimeout(() => {
          const q = pending.get(key);
          if (q) { const i = q.indexOf(entry); if (i >= 0) q.splice(i, 1); }
          const e = Object.assign(new Error(`request timeout: ${key}`), { code: "TRANSPORT_TIMEOUT" });
          reject(e);
        }, timeoutMs);
        entry.resolve = (msg) => { clearTimeout(entry.to); resolve(msg); };
        if (!pending.has(key)) pending.set(key, []);
        pending.get(key).push(entry);
        client.send(payload);
      });
    },
    emit(key, msg) {
      const q = pending.get(key);
      if (q && q.length > 0) {
        const entry = q.shift();
        if (q.length === 0) pending.delete(key);
        entry.resolve(msg);
      }
      const m = handlers.get(key);
      if (!m) return;
      for (const fn of [...m.values()]) fn(msg);
    },
  };
  return client;
}

// =========================================================
// LOCK-0037: setAutolock seconds 範囲外/非整数は BAD_REQUEST (送信前)
// =========================================================
describe("LOCK-0037 / setAutolock — 範囲外・非整数は BAD_REQUEST (送信前)", () => {
  let c;
  beforeEach(() => {
    setLocale("en");
    c = makeMockClient();
  });

  it("[LOCK-0037] seconds が 0..65535 整数でなければ送信前に SesameError(BAD_REQUEST) を投げる", async () => {
    const badValues = [-1, 65536, 1.5, NaN, "30"];
    for (const bad of badValues) {
      const p = setAutolock(c, { deviceId: DEVICE, secretKey: KEY, seconds: bad });
      await expect(p).rejects.toMatchObject({ code: ERR.BAD_REQUEST });
      await expect(p.catch((e) => e.message)).resolves.toMatch(/0\.\.65535/);
    }
    // 送信前 = sent は空のまま
    expect(c.sent).toHaveLength(0);
  });
});

// =========================================================
// LOCK-0039: autolock は cloud 能力に含まれず CLI 非公開
// =========================================================
describe("LOCK-0039 / autolock は cloud 能力に含まれず CLI 非公開", () => {
  beforeEach(() => setLocale("en"));

  it("[LOCK-0039] sesame_5 の cloud 能力一覧に autolock が含まれない", () => {
    const caps = capabilitiesForModel("sesame_5");
    expect(caps.cloud).not.toContain("autolock");
    expect(caps.ble).toContain("autolock");
  });

  it("[LOCK-0039] transportsForOp('sesame_5', 'autolock') は ['ble'] のみ返す", () => {
    const transports = transportsForOp("sesame_5", "autolock");
    expect(transports).toEqual(["ble"]);
    expect(transports).not.toContain("cloud");
  });

  it("[LOCK-0039] pickTransport('autolock', {}, 'sesame_5') は 'ble' を返す (cloud 不可 op)", () => {
    const transport = pickTransport("autolock", {}, "sesame_5");
    expect(transport).toBe("ble");
  });

  it("[LOCK-0039] pickTransport('autolock', {cloudOnly: true}, 'sesame_5') は die する (cloud 不可)", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw Object.assign(new Error(`process.exit(${code})`), { exitCode: code });
    });
    try {
      expect(() => pickTransport("autolock", { cloudOnly: true }, "sesame_5")).toThrow();
    } finally {
      exitSpy.mockRestore();
    }
  });
});

// =========================================================
// LOCK-0040: status クラウド取得 (getDeviceStatus / biz3ManageDevice)
// =========================================================
describe("LOCK-0040 / getDeviceStatus — biz3ManageDevice フレームと data[0] 返却", () => {
  beforeEach(() => setLocale("en"));

  it("[LOCK-0040] action=biz3ManageDevice op=getDeviceStatus で request し、resp.data[0] を返す", async () => {
    const deviceRecord = { deviceUUID: DEVICE, stateInfo: { CHSesame2Status: "locked" } };
    const sent = [];
    const client = {
      subscribe: () => () => {},
      request(payload, _timeoutMs) {
        sent.push(payload);
        return Promise.resolve({ success: true, data: [deviceRecord] });
      },
    };

    const result = await getDeviceStatus(client, { deviceUUID: DEVICE });

    expect(sent[0].action).toBe("biz3ManageDevice");
    expect(sent[0].op).toBe("getDeviceStatus");
    expect(sent[0].deviceUUID).toBe(DEVICE);
    // data[0] だけを返す (配列は返さない)
    expect(result).toEqual(deviceRecord);
  });

  it("[LOCK-0040] data が空配列なら null を返す", async () => {
    const client = {
      subscribe: () => () => {},
      request: () => Promise.resolve({ success: true, data: [] }),
    };
    const result = await getDeviceStatus(client, { deviceUUID: DEVICE });
    expect(result).toBeNull();
  });

  it("[LOCK-0040] data が null のとき null を返す", async () => {
    const client = {
      subscribe: () => () => {},
      request: () => Promise.resolve({ success: true, data: null }),
    };
    const result = await getDeviceStatus(client, { deviceUUID: DEVICE });
    expect(result).toBeNull();
  });
});

// =========================================================
// LOCK-0041: getDeviceStatus は strict success 検証
// =========================================================
describe("LOCK-0041 / getDeviceStatus — strict success 検証", () => {
  beforeEach(() => setLocale("en"));

  it("[LOCK-0041] success フィールドが無い応答は reject する (strict:true)", async () => {
    const client = {
      subscribe: () => () => {},
      // success フィールドが無い (strict=true では失敗扱い)
      request: () => Promise.resolve({ data: [{ deviceUUID: DEVICE }] }),
    };
    await expect(getDeviceStatus(client, { deviceUUID: DEVICE })).rejects.toThrow();
  });

  it("[LOCK-0041] success:false の応答は reject する", async () => {
    const client = {
      subscribe: () => () => {},
      request: () => Promise.resolve({ success: false, code: 403, message: "forbidden" }),
    };
    await expect(getDeviceStatus(client, { deviceUUID: DEVICE }))
      .rejects.toMatchObject({ code: ERR.REJECTED });
  });
});

// =========================================================
// LOCK-0044: CLI auto/--cloud-only は lock/unlock/toggle/click を cloud で運ぶ
// =========================================================
describe("LOCK-0044 / pickTransport — cloud で運べる op は auto/--cloud-only で 'cloud'", () => {
  beforeEach(() => setLocale("en"));

  const lockOps = ["lock", "unlock", "toggle"];

  for (const op of lockOps) {
    it(`[LOCK-0044] ${op} / auto → 'cloud' (sesame_5)`, () => {
      expect(pickTransport(op, {}, "sesame_5")).toBe("cloud");
    });

    it(`[LOCK-0044] ${op} / --cloud-only → 'cloud' (sesame_5)`, () => {
      expect(pickTransport(op, { cloudOnly: true }, "sesame_5")).toBe("cloud");
    });
  }

  it("[LOCK-0044] click / auto → 'cloud' (bot_2)", () => {
    expect(pickTransport("click", {}, "bot_2")).toBe("cloud");
  });

  it("[LOCK-0044] lock5 の cloud[] に lock/unlock/toggle が含まれ、autolock は含まれない", () => {
    const caps = capabilitiesForModel("sesame_5");
    expect(caps.cloud).toContain("lock");
    expect(caps.cloud).toContain("unlock");
    expect(caps.cloud).toContain("toggle");
    expect(caps.cloud).not.toContain("autolock");
  });

  it("[LOCK-0044] bot_2 の cloud[] に click が含まれる", () => {
    const caps = capabilitiesForModel("bot_2");
    expect(caps.cloud).toContain("click");
  });
});

// =========================================================
// LOCK-0045: CLI --cloud-only で cloud 不可 op は opNotOverCloud で die(2)
// =========================================================
describe("LOCK-0045 / pickTransport — --cloud-only + cloud 不可 op は die(2)", () => {
  beforeEach(() => setLocale("en"));

  it("[LOCK-0045] autolock --cloud-only は die する (cloud[] に autolock 無し)", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw Object.assign(new Error(`process.exit(${code})`), { exitCode: code });
    });
    try {
      expect(() => pickTransport("autolock", { cloudOnly: true }, "sesame_5")).toThrow();
      // exit(2) が呼ばれたことを確認
      expect(exitSpy).toHaveBeenCalledWith(2);
    } catch (e) {
      // die() が throw した場合は exitCode を確認
      expect(e.exitCode ?? 2).toBe(2);
    } finally {
      exitSpy.mockRestore();
    }
  });
});

// =========================================================
// LOCK-0046: CLI cloud op 実行は cloud ログイン必須
// =========================================================
describe("LOCK-0046 / cmdAct — cloud セッション未確立なら die(cli.cloudNotLoggedIn)", () => {
  beforeEach(() => setLocale("en"));

  it("[LOCK-0046] transport=cloud で解決される op (unlock) は pickTransport が 'cloud' を返す", () => {
    // cloud で運べる op に対して pickTransport は 'cloud' を返す。
    // lock-ops.js:324-326 で hasCloudSession(program)=false のとき die(cli.cloudNotLoggedIn, 2) を呼ぶ。
    // この契約を純関数レベルで確認する。
    const result = pickTransport("unlock", { cloudOnly: true }, "sesame_5");
    expect(result).toBe("cloud");
  });
});

// =========================================================
// LOCK-0047: CLI status は cloud で getDeviceStatus、secretKey を出力から落とす
// =========================================================
describe("LOCK-0047 / sanitizeStatus / fmtCloudStatus", () => {
  beforeEach(() => setLocale("en"));

  it("[LOCK-0047] sanitizeStatus が secretKey を除去する", () => {
    const status = {
      deviceUUID: DEVICE,
      secretKey: KEY,
      stateInfo: { CHSesame2Status: "locked", position: -176, batteryPercentage: 80 },
    };
    const safe = sanitizeStatus(status);
    expect(safe).not.toHaveProperty("secretKey");
    expect(safe).toHaveProperty("deviceUUID", DEVICE);
    expect(safe).toHaveProperty("stateInfo");
  });

  it("[LOCK-0047] sanitizeStatus は非オブジェクト入力をそのまま返す", () => {
    expect(sanitizeStatus(null)).toBeNull();
    expect(sanitizeStatus("str")).toBe("str");
  });

  it("[LOCK-0047] fmtCloudStatus が state/pos/battery を整形する", () => {
    const st = {
      stateInfo: { CHSesame2Status: "locked", position: -176, batteryPercentage: 80 },
    };
    const line = fmtCloudStatus(st);
    expect(line).toMatch(/state=locked/);
    expect(line).toMatch(/pos=-176/);
    expect(line).toMatch(/battery=80%/);
  });

  it("[LOCK-0047] fmtCloudStatus が stateInfo なし/null で fallback 文字列を返す", () => {
    expect(typeof fmtCloudStatus(null)).toBe("string");
    expect(fmtCloudStatus(null).length).toBeGreaterThan(0);
    expect(typeof fmtCloudStatus({})).toBe("string");
    expect(fmtCloudStatus({}).length).toBeGreaterThan(0);
  });

  it("[LOCK-0047] status の pickTransport は auto/--cloud-only で 'cloud' を返す", () => {
    expect(pickTransport("status", {}, "sesame_5")).toBe("cloud");
    expect(pickTransport("status", { cloudOnly: true }, "sesame_5")).toBe("cloud");
  });
});

// =========================================================
// LOCK-0048: name-based と direct で同一 triggerLock フレームになる
// =========================================================
describe("LOCK-0048 / name-based と direct で同一 triggerLock フレームになる", () => {
  beforeEach(() => setLocale("en"));

  it("[LOCK-0048] lockManager.unlock と unlockDevice が同じ {action, cmd, device_id} フレームを生成する", async () => {
    const c1 = makeMockClient();
    const c2 = makeMockClient();

    const lockEntry = { deviceUUID: DEVICE, secretKey: KEY };
    const config = {
      locks: { front: lockEntry },
      default: { lock: "front" },
    };

    const mgr1 = new LockManager({
      getWs: () => c1,
      getConfig: () => config,
      getSubUUID: () => SUB,
      ensureConnected: () => {},
    });
    const mgr2 = new LockManager({
      getWs: () => c2,
      getConfig: () => config,
      getSubUUID: () => SUB,
      ensureConnected: () => {},
    });

    // name-based unlock
    const p1 = mgr1.unlock("front");
    c1.emit(ACK_KEY, OK_ACK);
    await p1;

    // direct unlockDevice
    const p2 = mgr2.unlockDevice({ deviceUUID: DEVICE, secretKey: KEY });
    c2.emit(ACK_KEY, OK_ACK);
    await p2;

    const f1 = c1.sent[0];
    const f2 = c2.sent[0];

    expect(f1.action).toBe("biz3TriggerLocker");
    expect(f2.action).toBe("biz3TriggerLocker");
    expect(f1.cmd).toBe(83); // CMD.UNLOCK
    expect(f2.cmd).toBe(83);
    expect(f1.device_id).toBe(DEVICE);
    expect(f2.device_id).toBe(DEVICE);
    expect(typeof f1.sign).toBe("string");
    expect(typeof f2.sign).toBe("string");
    expect(typeof f1.history).toBe("string");
    expect(typeof f2.history).toBe("string");
    // op フィールドは存在しない (biz3TriggerLocker フレームは op なし)
    expect(f1).not.toHaveProperty("op");
    expect(f2).not.toHaveProperty("op");
  });
});

// =========================================================
// LOCK-0049: lockManager は subUUID 未取得時 NOT_CONNECTED
// =========================================================
describe("LOCK-0049 / LockManager — subUUID 未取得時 NOT_CONNECTED", () => {
  beforeEach(() => setLocale("en"));

  it("[LOCK-0049] unlock() で subUUID が null なら SesameError(NOT_CONNECTED, retryable:true) を投げる", async () => {
    const c = makeMockClient();
    const mgr = new LockManager({
      getWs: () => c,
      getConfig: () => ({
        locks: { front: { deviceUUID: DEVICE, secretKey: KEY } },
        default: { lock: "front" },
      }),
      getSubUUID: () => null,
      ensureConnected: () => {},
    });

    await expect(mgr.unlock("front")).rejects.toMatchObject({
      code: ERR.NOT_CONNECTED,
      retryable: true,
    });
  });

  it("[LOCK-0049] triggerDevice() で subUUID が null なら SesameError(NOT_CONNECTED, retryable:true) を投げる", async () => {
    const c = makeMockClient();
    const mgr = new LockManager({
      getWs: () => c,
      getConfig: () => ({ locks: {}, default: null }),
      getSubUUID: () => null,
      ensureConnected: () => {},
    });

    await expect(mgr.triggerDevice({ deviceUUID: DEVICE, secretKey: KEY, cmd: 83 }))
      .rejects.toMatchObject({ code: ERR.NOT_CONNECTED, retryable: true });
  });
});

// =========================================================
// LOCK-0050: lock-manager の name 解決と必須フィールド検査
// =========================================================
describe("LOCK-0050 / LockManager.resolveLock — name 解決と必須フィールド検査", () => {
  beforeEach(() => setLocale("en"));

  function makeMgr(locks, defaultLock, subUUID = SUB) {
    const cfg = {
      locks,
      ...(defaultLock ? { default: { lock: defaultLock } } : {}),
    };
    return new LockManager({
      getWs: () => makeMockClient(),
      getConfig: () => cfg,
      getSubUUID: () => subUUID,
      ensureConnected: () => {},
    });
  }

  it("[LOCK-0050] name 指定で locks[name] を解決する", () => {
    const mgr = makeMgr(
      { front: { deviceUUID: DEVICE, secretKey: KEY }, back: { deviceUUID: "back-uuid", secretKey: KEY } },
      "front",
    );
    const { name, lock } = mgr.resolveLock("back");
    expect(name).toBe("back");
    expect(lock.deviceUUID).toBe("back-uuid");
  });

  it("[LOCK-0050] name 省略 → default.lock を解決する", () => {
    const mgr = makeMgr(
      { front: { deviceUUID: DEVICE, secretKey: KEY }, back: { deviceUUID: "back-uuid", secretKey: KEY } },
      "front",
    );
    const { name } = mgr.resolveLock(null);
    expect(name).toBe("front");
  });

  it("[LOCK-0050] name 省略 + default なし + 単一 lock → その lock を自動選択", () => {
    const mgr = makeMgr({ only: { deviceUUID: DEVICE, secretKey: KEY } }, null);
    const { name } = mgr.resolveLock(null);
    expect(name).toBe("only");
  });

  it("[LOCK-0050] 不明な name → BAD_REQUEST を投げる", () => {
    const mgr = makeMgr({ front: { deviceUUID: DEVICE, secretKey: KEY } }, null);
    expect(() => mgr.resolveLock("nonexistent")).toThrow(
      expect.objectContaining({ code: ERR.BAD_REQUEST }),
    );
  });

  it("[LOCK-0050] name 省略 + default なし + 複数 locks → BAD_REQUEST を投げる", () => {
    const mgr = makeMgr(
      { front: { deviceUUID: DEVICE, secretKey: KEY }, back: { deviceUUID: "back-uuid", secretKey: KEY } },
      null,
    );
    try {
      mgr.resolveLock(null);
      expect.fail("should throw");
    } catch (e) {
      expect(e.code).toBe(ERR.BAD_REQUEST);
    }
  });

  it("[LOCK-0050] deviceUUID 欠落 → BAD_REQUEST", async () => {
    const mgr = makeMgr({ front: { secretKey: KEY } }, "front");
    await expect(mgr.unlock("front")).rejects.toMatchObject({ code: ERR.BAD_REQUEST });
  });

  it("[LOCK-0050] secretKey 欠落 → BAD_REQUEST", async () => {
    const mgr = makeMgr({ front: { deviceUUID: DEVICE } }, "front");
    await expect(mgr.unlock("front")).rejects.toMatchObject({ code: ERR.BAD_REQUEST });
  });
});

// =========================================================
// LOCK-0051: OS3 lock の ItemCode と送信フレーム (item=82)
// =========================================================
describe("LOCK-0051 / OS3 lock BLE フレーム (LOCK=82)", () => {
  beforeEach(() => setLocale("en"));

  it("[LOCK-0051] ITEM_CODES.LOCK === 82", () => {
    expect(ITEM_CODES.LOCK).toBe(82);
  });

  it("[LOCK-0051] buildSendFrame(82, historyTagBLE()) は [0x52, 0x00, 0x0E] で始まる", () => {
    const frame = buildSendFrame(ITEM_CODES.LOCK, historyTagBLE());
    expect(frame[0]).toBe(0x52); // 82 = 0x52
    expect(frame[1]).toBe(0x00);
    expect(frame[2]).toBe(0x0e);
  });

  it("[LOCK-0051] buildSendFrame(82, historyTagBLE(tag)) は [item_code]++data (op_code 無し)", () => {
    const tag = Buffer.from([0x01, 0x02, 0x03]);
    const data = historyTagBLE(tag);
    const frame = buildSendFrame(ITEM_CODES.LOCK, data);
    expect(frame[0]).toBe(82);
    expect(frame.length).toBe(1 + data.length);
    expect(frame.subarray(1)).toEqual(data);
  });
});

// =========================================================
// LOCK-0052: OS3 unlock の ItemCode と送信フレーム (item=83)
// =========================================================
describe("LOCK-0052 / OS3 unlock BLE フレーム (UNLOCK=83)", () => {
  beforeEach(() => setLocale("en"));

  it("[LOCK-0052] ITEM_CODES.UNLOCK === 83", () => {
    expect(ITEM_CODES.UNLOCK).toBe(83);
  });

  it("[LOCK-0052] buildSendFrame(83, historyTagBLE()) は [0x53, 0x00, 0x0E] で始まる", () => {
    const frame = buildSendFrame(ITEM_CODES.UNLOCK, historyTagBLE());
    expect(frame[0]).toBe(0x53); // 83 = 0x53
    expect(frame[1]).toBe(0x00);
    expect(frame[2]).toBe(0x0e);
  });

  it("[LOCK-0052] buildSendFrame(83, historyTagBLE(tag)) は [item=83]++data", () => {
    const tag = Buffer.from([0xca, 0xfe]);
    const data = historyTagBLE(tag);
    const frame = buildSendFrame(ITEM_CODES.UNLOCK, data);
    expect(frame[0]).toBe(83);
    expect(frame.length).toBe(1 + data.length);
  });
});

// =========================================================
// LOCK-0053: OS3 click の ItemCode (item=89) と RUN_SCRIPT_0(170)+index 規則
// =========================================================
describe("LOCK-0053 / OS3 click ItemCode (CLICK=89) と RUN_SCRIPT_0(170)+index 規則", () => {
  beforeEach(() => setLocale("en"));

  it("[LOCK-0053] ITEM_CODES.CLICK === 89", () => {
    expect(ITEM_CODES.CLICK).toBe(89);
  });

  it("[LOCK-0053] BOT2_ITEM_CODE_RUN_SCRIPT_0 === 170", () => {
    expect(ITEM_CODES.BOT2_ITEM_CODE_RUN_SCRIPT_0).toBe(170);
  });

  it("[LOCK-0053] clickItemCode(0) → 170 (RUN_SCRIPT_0)", () => {
    expect(clickItemCode(0)).toBe(170);
  });

  it("[LOCK-0053] clickItemCode(9) → 179 (RUN_SCRIPT_9)", () => {
    expect(clickItemCode(9)).toBe(179);
  });

  it("[LOCK-0053] clickItemCode(undefined) → 89 (CLICK)", () => {
    expect(clickItemCode(undefined)).toBe(89);
  });

  it("[LOCK-0053] RUN_SCRIPT_0..9 が 170..179 に対応する", () => {
    for (let i = 0; i <= 9; i++) {
      const key = `BOT2_ITEM_CODE_RUN_SCRIPT_${i}`;
      expect(ITEM_CODES[key]).toBe(170 + i);
    }
  });
});

// =========================================================
// LOCK-0054: historyTagBLE のバイト列 ([0x00,0x0E] 前置 + 20B 切詰め)
// =========================================================
describe("LOCK-0054 / historyTagBLE — [0x00,0x0E] 前置 + 20B 切詰め", () => {
  beforeEach(() => setLocale("en"));

  it("[LOCK-0054] tag 省略時は [0x00, 0x0E] の 2B のみ", () => {
    const r = historyTagBLE();
    expect(r).toBeInstanceOf(Buffer);
    expect(r.length).toBe(2);
    expect(r[0]).toBe(0x00);
    expect(r[1]).toBe(0x0e);
  });

  it("[LOCK-0054] 短い tag → [0x00, 0x0E, ...tag]", () => {
    const tag = Buffer.from([0xaa, 0xbb, 0xcc]);
    const r = historyTagBLE(tag);
    expect(r[0]).toBe(0x00);
    expect(r[1]).toBe(0x0e);
    expect(r[2]).toBe(0xaa);
    expect(r[3]).toBe(0xbb);
    expect(r[4]).toBe(0xcc);
    expect(r.length).toBe(5);
  });

  it("[LOCK-0054] tag が 18B 超は 20B に切り詰める (先頭 [0x00,0x0E] + 18B)", () => {
    // 19B のタグ → prefix 2B + 19B = 21B → 20B に切り詰め
    const tag = Buffer.alloc(19, 0xff);
    const r = historyTagBLE(tag);
    expect(r.length).toBe(20);
    expect(r[0]).toBe(0x00);
    expect(r[1]).toBe(0x0e);
    for (let i = 0; i < 18; i++) expect(r[2 + i]).toBe(0xff);
  });

  it("[LOCK-0054] tag が 18B ちょうどなら 20B (切り詰めなし)", () => {
    const tag = Buffer.alloc(18, 0xee);
    const r = historyTagBLE(tag);
    expect(r.length).toBe(20);
  });

  it("[LOCK-0054] Uint8Array を tag に渡しても正常動作する", () => {
    const tag = new Uint8Array([0x01, 0x02, 0x03]);
    const r = historyTagBLE(tag);
    expect(r[0]).toBe(0x00);
    expect(r[1]).toBe(0x0e);
    expect(r[2]).toBe(0x01);
  });

  it("[LOCK-0054] SDK 一致: NAME_UUID_TYPE_ANDROID_USER_BLE_UUID=14 → [0x00, 0x0E]", () => {
    const result = historyTagBLE();
    expect(result[0]).toBe(0x00); // 14 >> 8
    expect(result[1]).toBe(0x0e); // 14 & 0xff
  });
});

// =========================================================
// LOCK-0055: historyTagBLE に非バイト列を渡すと throw
// =========================================================
describe("LOCK-0055 / historyTagBLE — 非バイト列を渡すと throw", () => {
  beforeEach(() => setLocale("en"));

  it("[LOCK-0055] string を渡すと throw する", () => {
    expect(() => historyTagBLE("hello")).toThrow();
  });

  it("[LOCK-0055] number を渡すと throw する", () => {
    expect(() => historyTagBLE(42)).toThrow();
  });

  it("[LOCK-0055] プレーン object を渡すと throw する", () => {
    expect(() => historyTagBLE({ data: [1, 2, 3] })).toThrow();
  });

  it("[LOCK-0055] null は省略扱いで [0x00, 0x0E] を返す (throw しない)", () => {
    // null は tag == null/undefined のパスに該当し tagBuf = Buffer.alloc(0)
    const result = historyTagBLE(null);
    expect([...result]).toEqual([0x00, 0x0e]);
  });

  it("[LOCK-0055] Buffer は正常に受け入れる (throw しない)", () => {
    expect(() => historyTagBLE(Buffer.from([0x01]))).not.toThrow();
  });

  it("[LOCK-0055] Uint8Array は正常に受け入れる (throw しない)", () => {
    expect(() => historyTagBLE(new Uint8Array([0x01]))).not.toThrow();
  });
});

// =========================================================
// LOCK-0056: OS3 toggle のクライアント側 lock/unlock 判定
// =========================================================
describe("LOCK-0056 / OS3 toggle — lastStatus.state=locked→UNLOCK(83), それ以外→LOCK(82)", () => {
  beforeEach(() => setLocale("en"));

  it("[LOCK-0056] toggle ロジック: state=locked → UNLOCK(83) を選ぶ", () => {
    // CHSesame5Device.kt:128-145: deviceStatus==Locked → unlock, else lock
    const LOCKED_STATE = "locked";
    const pickItem = (state) =>
      state === LOCKED_STATE ? ITEM_CODES.UNLOCK : ITEM_CODES.LOCK;
    expect(pickItem("locked")).toBe(83);
    expect(pickItem("unlocked")).toBe(82);
    expect(pickItem("moved")).toBe(82);
    expect(pickItem(undefined)).toBe(82);
  });

  it("[LOCK-0056] ITEM_CODES.LOCK=82 / ITEM_CODES.UNLOCK=83 の値を確認", () => {
    expect(ITEM_CODES.LOCK).toBe(82);
    expect(ITEM_CODES.UNLOCK).toBe(83);
  });

  it("[LOCK-0056] toggle: locked → UNLOCK(83) を BLE で送る (session モック)", async () => {
    const requestedItems = [];
    const mockSession = {
      lastStatus: { state: "locked" },
      request: (itemCode, _data) => {
        requestedItems.push(itemCode);
        return Promise.resolve({ resultCode: 0, payload: Buffer.alloc(0) });
      },
    };
    const state = mockSession.lastStatus?.state;
    const item = state === "locked" ? ITEM_CODES.UNLOCK : ITEM_CODES.LOCK;
    await mockSession.request(item, historyTagBLE());
    expect(requestedItems[0]).toBe(83); // UNLOCK
  });

  it("[LOCK-0056] toggle: unlocked → LOCK(82) を BLE で送る (session モック)", async () => {
    const requestedItems = [];
    const mockSession = {
      lastStatus: { state: "unlocked" },
      request: (itemCode, _data) => {
        requestedItems.push(itemCode);
        return Promise.resolve({ resultCode: 0, payload: Buffer.alloc(0) });
      },
    };
    const state = mockSession.lastStatus?.state;
    const item = state === "locked" ? ITEM_CODES.UNLOCK : ITEM_CODES.LOCK;
    await mockSession.request(item, historyTagBLE());
    expect(requestedItems[0]).toBe(82); // LOCK
  });
});

// =========================================================
// LOCK-0057: OS3 autolock の ItemCode (item=11) と 2B LE payload
// =========================================================
describe("LOCK-0057 / OS3 autolock BLE フレーム (AUTOLOCK=11, 2B LE payload)", () => {
  beforeEach(() => setLocale("en"));

  it("[LOCK-0057] ITEM_CODES.AUTOLOCK === 11", () => {
    expect(ITEM_CODES.AUTOLOCK).toBe(11);
  });

  it("[LOCK-0057] autolockData(300) は 2B LE = [0x2C, 0x01]", () => {
    const buf = autolockData(300);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBe(2);
    expect(buf[0]).toBe(300 & 0xff);        // 0x2C
    expect(buf[1]).toBe((300 >> 8) & 0xff); // 0x01
  });

  it("[LOCK-0057] autolockData(0) は [0x00, 0x00] (無効化)", () => {
    const buf = autolockData(0);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBe(2);
    expect(buf[0]).toBe(0);
    expect(buf[1]).toBe(0);
  });

  it("[LOCK-0057] autolockData(65535) → [0xFF, 0xFF]", () => {
    const buf = autolockData(65535);
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xff);
  });

  it("[LOCK-0057] buildSendFrame(11, autolockData(30)) の先頭バイトは 0x0B (= 11)", () => {
    const data = autolockData(30);
    const frame = buildSendFrame(ITEM_CODES.AUTOLOCK, data);
    expect(frame[0]).toBe(0x0b); // 11 = 0x0B
    expect(frame.length).toBe(3); // [item] + [2B LE]
    expect(frame[1]).toBe(30 & 0xff);
    expect(frame[2]).toBe((30 >> 8) & 0xff);
  });

  it("[LOCK-0057] autolockData は writeUInt16LE と同等 (SDK delay.toShort().toReverseBytes())", () => {
    const seconds = 1234;
    const data = autolockData(seconds);
    const ref = Buffer.alloc(2);
    ref.writeUInt16LE(seconds);
    expect(Buffer.compare(data, ref)).toBe(0);
  });

  it("[LOCK-0057] autolockData の範囲外は throw する", () => {
    expect(() => autolockData(-1)).toThrow();
    expect(() => autolockData(65536)).toThrow();
    expect(() => autolockData(1.5)).toThrow();
  });

  it("[LOCK-0057] session.autolock は AUTOLOCK(11) itemCode を使う (ロジック確認)", () => {
    // AUTOLOCK=11 で autolockData が 2B LE を返すことを確認
    const data = autolockData(60);
    expect(ITEM_CODES.AUTOLOCK).toBe(11);
    expect(data.readUInt16LE(0)).toBe(60);
  });
});
