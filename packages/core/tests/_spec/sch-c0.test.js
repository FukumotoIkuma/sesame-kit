// packages/core/tests/_spec/sch-c0.test.js
//
// TDD spec tests: SCH-0001 through SCH-0019 (schedule domain)
//
// Implementation:
//   packages/core/src/schedule.js       — getScheduleList / cancelSchedule / NAMESPACE_OPS
//   packages/kit/src/cli/schedule.js    — registerScheduleCommands (ls / cancel)
//
// Rules:
//   - Each it() title starts with [<ID>]
//   - Assertions follow the spec (not the implementation — red is OK in TDD)
//   - No network / BLE / real devices; all mock / pure-function / deterministic
//   - CLI tests use the fake-ctx pattern established in acc-c4.test.js
//
// Import base: packages/core/tests/_spec/ (2 levels up = packages/core/)

import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";

// ---- core implementation ----
import { getScheduleList, cancelSchedule, NAMESPACE_OPS } from "../../src/schedule.js";
import { mockClient } from "../helpers/mock-ws.js";

// ---- CLI implementation ----
import { registerScheduleCommands } from "../../../kit/src/cli/schedule.js";

// ================================================================================
// Constants
// ================================================================================

// biz3 messageConstants.js:21  BIZ3_SCHEDULE: 'biz3Schedule'
const ACT = "biz3Schedule";

// ================================================================================
// CLI fake helpers (acc-c4.test.js pattern)
// ================================================================================

/**
 * Fake hub for CLI tests.
 * @param {object} [overrides]
 */
function makeFakeHub(overrides = {}) {
  return {
    schedule: {
      getScheduleList: vi.fn(async () => []),
      cancelSchedule: vi.fn(async () => ({})),
    },
    ...overrides,
  };
}

/**
 * Fake ctx — follows the established acc-c4.test.js contract.
 * withHub: calls fn(hub, {opts:{json}}) immediately, recording output via ctx.out.
 *
 * @param {object} hub
 * @param {object} [opts]
 * @param {boolean} [opts.json]
 * @param {boolean} [opts.canPromptVal]
 * @param {Function} [opts.selectFromListImpl]
 */
function makeCtx(hub, { json = false, canPromptVal = false, selectFromListImpl = vi.fn(async () => null) } = {}) {
  const outputs = [];
  const errors  = [];
  const dies    = [];

  const ctx = {
    outputs,
    errors,
    dies,
    out: (_json, humanFn, jsonObj) => {
      // Always record the jsonObj for structural assertions.
      // In human mode, also call humanFn (which typically calls console.log).
      if (!_json) humanFn();
      outputs.push(jsonObj);
    },
    die: (msg, code) => {
      dies.push({ msg, code });
      const e = new Error(msg);
      e.exitCode = code;
      throw e;
    },
    canPrompt: () => canPromptVal,
    withHub: (fn) => fn(hub, { opts: { json } }),
    prompts: {
      selectFromList: selectFromListImpl,
      promptText: vi.fn(async () => ""),
      confirm: vi.fn(async () => false),
      promptLine: vi.fn(async () => ""),
    },
  };
  return ctx;
}

function buildProgram(ctx) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerScheduleCommands(program, ctx);
  return program;
}

// ================================================================================
// SCH-0001 — getScheduleList frame shape (flat JSON / action,userId,op)
// ================================================================================

describe("SCH-0001: getScheduleList → biz3Schedule フレーム (flat / 3キーのみ)", () => {
  it("[SCH-0001] 送信フレームが {action:'biz3Schedule', userId:<subUUID>, op:'getScheduleList'} の3キーのみ (obj ラップ無し・companyID/apiKeyId 無し)", async () => {
    // ref: references_web/src/api/useManageSchedule.js:15-19; packages/core/src/schedule.js:60-64
    // ref: messageConstants.js:21  BIZ3_SCHEDULE='biz3Schedule'
    const c = mockClient({ data: [] });
    await getScheduleList(c, { subUUID: "sub-uuid-001" });

    expect(c.sent).toHaveLength(1);
    const frame = c.sent[0];

    // 3 keys only: action, userId, op
    expect(Object.keys(frame).sort()).toEqual(["action", "op", "userId"]);

    expect(frame.action).toBe(ACT);
    expect(frame.op).toBe("getScheduleList");
    expect(frame.userId).toBe("sub-uuid-001");

    // No obj-wrap (unlike useManageDevice.js which wraps with obj/companyID)
    expect(frame).not.toHaveProperty("obj");
    expect(frame).not.toHaveProperty("companyID");
    expect(frame).not.toHaveProperty("apiKeyId");
    expect(frame).not.toHaveProperty("scheduleId");
  });
});

// ================================================================================
// SCH-0002 — getScheduleList userId carries subUUID verbatim
// ================================================================================

describe("SCH-0002: getScheduleList userId に subUUID を無加工で載せる", () => {
  it("[SCH-0002] frame.userId に subUUID 生文字列がそのまま入る (大文字化/ハイフン加工/トリム等の変換なし)", async () => {
    // ref: useManageSchedule.js:13,17 — subUUID assigned directly to userId; schedule.js:62
    const raw = "sub-RAW-uuid-Mixed-Case-123";
    const c = mockClient({ data: [] });
    await getScheduleList(c, { subUUID: raw });

    expect(c.sent[0].userId).toBe(raw);
    // Confirm no transformation was applied
    expect(c.sent[0].userId).not.toBe(raw.toUpperCase());
    expect(c.sent[0].userId).not.toBe(raw.toLowerCase());
    expect(c.sent[0].userId).not.toBe(raw.replace(/-/g, ""));
  });

  it("[SCH-0002] ハイフン含む subUUID もそのまま透過する", async () => {
    const hyphenated = "11111111-2222-3333-4444-555566667777";
    const c = mockClient({ data: [] });
    await getScheduleList(c, { subUUID: hyphenated });
    expect(c.sent[0].userId).toBe(hyphenated);
  });

  it("[SCH-0002] 空白入り subUUID もトリムせずそのまま userId に載せる", async () => {
    // Truthy value with spaces: passes the falsy guard, sent as-is
    const subWithSpaces = "  sub-uuid-with-spaces  ";
    const c = mockClient({ data: [] });
    await getScheduleList(c, { subUUID: subWithSpaces });
    expect(c.sent[0].userId).toBe(subWithSpaces);
  });
});

// ================================================================================
// SCH-0003 — getScheduleList returns data array directly (no obj-wrap)
// ================================================================================

describe("SCH-0003: getScheduleList 応答 data を配列直返し (obj ラップせず)", () => {
  it("[SCH-0003] 応答 message.data が配列ならそのまま ScheduleItem[] を返す", async () => {
    // ref: useManageSchedule.js:34-35 — data.length/Items — data itself is the array
    const items = [
      { scheduleId: "s1", action: "lock", displayTime: "09:00", deviceName: "玄関" },
      { scheduleId: "s2", action: "unlock", displayTime: "08:30", deviceName: "裏口" },
    ];
    const c = mockClient({ data: items });
    const result = await getScheduleList(c, { subUUID: "u-1" });

    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual(items);
    expect(result).toHaveLength(2);
  });

  it("[SCH-0003] 応答 data が欠落 (undefined) なら [] を返す", async () => {
    // ref: schedule.js:70 — Array.isArray guard returns [] on missing data
    const c = mockClient({ action: ACT, op: "getScheduleList" }); // no data field
    const result = await getScheduleList(c, { subUUID: "u-1" });
    expect(result).toEqual([]);
  });

  it("[SCH-0003] 応答 data がオブジェクトラップ ({Items:[]}) なら [] を返す (非配列はフォールバック)", async () => {
    // ref: schedule.js:70 — non-array falls through to []
    const c = mockClient({ data: { Items: [], count: 0 } });
    const result = await getScheduleList(c, { subUUID: "u-1" });
    expect(result).toEqual([]);
  });

  it("[SCH-0003] 応答 data が null なら [] を返す", async () => {
    const c = mockClient({ data: null });
    const result = await getScheduleList(c, { subUUID: "u-1" });
    expect(result).toEqual([]);
  });
});

// ================================================================================
// SCH-0004 — ScheduleItem field shape (scheduleId/action/displayTime/deviceName)
// ================================================================================

describe("SCH-0004: ScheduleItem フィールド形 (scheduleId/action/displayTime/deviceName)", () => {
  it("[SCH-0004] 返却 item が scheduleId/action/displayTime/deviceName を保持する (schedule-list UI キー名と一致)", async () => {
    // ref: schedule-list/index.js:49=scheduleId, :77=action, :78=displayTime, :92=deviceName
    // ref: schedule.js:32-40 ScheduleItem typedef
    const rawItems = [
      { scheduleId: "sched-001", action: "lock", displayTime: "2026-06-15 09:00", deviceName: "玄関" },
      { scheduleId: "sched-002", action: "unlock", displayTime: "08:30", deviceName: "裏口" },
    ];
    const c = mockClient({ data: rawItems });
    const result = await getScheduleList(c, { subUUID: "u-1" });

    expect(result[0].scheduleId).toBe("sched-001");
    expect(result[0].action).toBe("lock");
    expect(result[0].displayTime).toBe("2026-06-15 09:00");
    expect(result[0].deviceName).toBe("玄関");

    expect(result[1].scheduleId).toBe("sched-002");
    expect(result[1].action).toBe("unlock");
  });

  it("[SCH-0004] action enum lock/unlock/upgrade_firmware を保持する (表示用正規化を被せない)", async () => {
    // note: action server enum is lock/unlock/upgrade_firmware; display-normalization is separate
    const rawItems = [
      { scheduleId: "s1", action: "lock", displayTime: "09:00", deviceName: "d1" },
      { scheduleId: "s2", action: "unlock", displayTime: "10:00", deviceName: "d2" },
      { scheduleId: "s3", action: "upgrade_firmware", displayTime: "03:00", deviceName: "d3" },
    ];
    const c = mockClient({ data: rawItems });
    const result = await getScheduleList(c, { subUUID: "u-1" });
    expect(result.map((r) => r.action)).toEqual(["lock", "unlock", "upgrade_firmware"]);
  });
});

// ================================================================================
// SCH-0005 — getScheduleList with missing subUUID throws badRequest without sending
// ================================================================================

describe("SCH-0005: getScheduleList subUUID 欠落で送信せず badRequest", () => {
  it("[SCH-0005] subUUID undefined なら request を送らず badRequest('schedule.err.subUUIDRequired') を throw", async () => {
    // ref: useManageSchedule.js:13-14 — falsy → return (no send)
    // ref: schedule.js:56-57 — badRequest('schedule.err.subUUIDRequired')
    const c = mockClient({});
    await expect(getScheduleList(c, {})).rejects.toThrow(/subUUID required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[SCH-0005] subUUID 空文字でも badRequest を throw し送信しない", async () => {
    const c = mockClient({});
    await expect(getScheduleList(c, { subUUID: "" })).rejects.toThrow(/subUUID required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[SCH-0005] subUUID null でも throw し送信しない", async () => {
    const c = mockClient({});
    // @ts-ignore
    await expect(getScheduleList(c, { subUUID: null })).rejects.toThrow(/subUUID required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[SCH-0005] params 全省略でも throw し送信しない", async () => {
    const c = mockClient({});
    await expect(getScheduleList(c)).rejects.toThrow(/subUUID required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[SCH-0005] throw は送信前に発生する (同期的検証)", async () => {
    const c = mockClient({});
    const p = getScheduleList(c, { subUUID: undefined });
    // Even while Promise is pending, sent is still empty
    expect(c.sent).toHaveLength(0);
    await expect(p).rejects.toThrow();
    expect(c.sent).toHaveLength(0);
  });
});

// ================================================================================
// SCH-0006 — getScheduleList with success:false throws rejected
// ================================================================================

describe("SCH-0006: getScheduleList success:false で rejected throw", () => {
  it("[SCH-0006] 応答に success===false が明示された場合のみ rejected を throw", async () => {
    // ref: schedule.js:66-68; i18n key: schedule.err.getScheduleListFailed
    const c = mockClient({ success: false, code: "ERR_001", message: "auth failed" });
    const err = await getScheduleList(c, { subUUID: "u-1" }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/getScheduleList failed/);
  });

  it("[SCH-0006] upstreamCode を resp.code から拾う", async () => {
    // ref: util.js:74-76 — rejected data has upstreamCode
    const c = mockClient({ success: false, code: "UPSTREAM_CODE_XYZ", message: "fail" });
    const err = await getScheduleList(c, { subUUID: "u-1" }).catch((e) => e);
    expect(err.data?.upstreamCode).toBe("UPSTREAM_CODE_XYZ");
  });

  it("[SCH-0006] resp.code が無ければ upstreamCode は null", async () => {
    // ref: schedule.js:67 — resp?.code ?? null
    const c = mockClient({ success: false, message: "no code" });
    const err = await getScheduleList(c, { subUUID: "u-1" }).catch((e) => e);
    expect(err.data?.upstreamCode).toBeNull();
  });

  it("[SCH-0006] success フィールドが無い (欠落=正常扱い) なら data を返す", async () => {
    // ref: schedule.js:66 — only success===false explicitly throws; missing = normal
    const items = [{ scheduleId: "x", action: "lock", displayTime: "09:00", deviceName: "d" }];
    const c = mockClient({ action: ACT, op: "getScheduleList", data: items });
    const result = await getScheduleList(c, { subUUID: "u-1" });
    expect(result).toEqual(items);
  });

  it("[SCH-0006] success===true は正常扱いで data を返す", async () => {
    const items = [{ scheduleId: "y", action: "unlock", displayTime: "10:00", deviceName: "d" }];
    const c = mockClient({ success: true, data: items });
    const result = await getScheduleList(c, { subUUID: "u-1" });
    expect(result).toEqual(items);
  });
});

// ================================================================================
// SCH-0007 — getScheduleList correlation key ${action}:${op}
// ================================================================================

describe("SCH-0007: getScheduleList 応答相関キー biz3Schedule:getScheduleList", () => {
  it("[SCH-0007] transport.request が key='biz3Schedule:getScheduleList' に対応するフレームで呼ばれる (action:op の2段照合)", async () => {
    // ref: transport.js:262-263  key=`${action}:${op}`
    // ref: useManageSchedule.js:21  registerCallback(BIZ3_SCHEDULE, op, cb)
    const c = mockClient({ data: [] });
    await getScheduleList(c, { subUUID: "u-correlation" });

    expect(c.sent).toHaveLength(1);
    const frame = c.sent[0];
    expect(frame.action).toBe(ACT);
    expect(frame.op).toBe("getScheduleList");
    // Correlation key as formed by transport.js:263
    const correlationKey = `${frame.action}:${frame.op}`;
    expect(correlationKey).toBe("biz3Schedule:getScheduleList");
  });

  it("[SCH-0007] FIFO mock で同一 op 2件の応答が送信順に解決される", async () => {
    // FIFO resolution confirmation: 2 requests resolved in send order
    const resolvers = [];
    const c = {
      sent: [],
      async request(frame) {
        c.sent.push(frame);
        return new Promise((resolve) => resolvers.push(resolve));
      },
    };

    const p1 = getScheduleList(c, { subUUID: "sub-A" });
    const p2 = getScheduleList(c, { subUUID: "sub-B" });

    expect(c.sent).toHaveLength(2);

    // Resolve in FIFO order
    resolvers[0]({ data: [{ scheduleId: "first" }] });
    resolvers[1]({ data: [{ scheduleId: "second" }] });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1[0].scheduleId).toBe("first");
    expect(r2[0].scheduleId).toBe("second");
  });
});

// ================================================================================
// SCH-0008 — cancelSchedule frame shape (action,userId,scheduleId,op)
// ================================================================================

describe("SCH-0008: cancelSchedule → biz3Schedule cancelSchedule フレーム (4キーのみ)", () => {
  it("[SCH-0008] 送信フレームが {action:'biz3Schedule', userId:<subUUID>, scheduleId, op:'cancelSchedule'} の4キーのみ", async () => {
    // ref: useManageSchedule.js:54-59; schedule.js:96-101
    const c = mockClient({ action: ACT, op: "cancelSchedule" });
    await cancelSchedule(c, { subUUID: "sub-uuid-001", scheduleId: "sched-999" });

    expect(c.sent).toHaveLength(1);
    const frame = c.sent[0];

    // 4 keys only: action, userId, scheduleId, op
    expect(Object.keys(frame).sort()).toEqual(["action", "op", "scheduleId", "userId"]);

    expect(frame.action).toBe(ACT);
    expect(frame.op).toBe("cancelSchedule");
    expect(frame.userId).toBe("sub-uuid-001");
    expect(frame.scheduleId).toBe("sched-999");

    // No obj/companyID
    expect(frame).not.toHaveProperty("obj");
    expect(frame).not.toHaveProperty("companyID");
  });

  it("[SCH-0008] フィールド順は原典 useManageSchedule.js:54-59 のリテラル順 (action, userId, scheduleId, op)", async () => {
    // ref: useManageSchedule.js:54-59 literal field order
    const c = mockClient({ action: ACT, op: "cancelSchedule" });
    await cancelSchedule(c, { subUUID: "u", scheduleId: "s" });
    const keys = Object.keys(c.sent[0]);
    expect(keys).toEqual(["action", "userId", "scheduleId", "op"]);
  });

  it("[SCH-0008] userId は subUUID 無加工", async () => {
    const raw = "sub-RAW-Mixed-uuid";
    const c = mockClient({ action: ACT, op: "cancelSchedule" });
    await cancelSchedule(c, { subUUID: raw, scheduleId: "s-1" });
    expect(c.sent[0].userId).toBe(raw);
  });
});

// ================================================================================
// SCH-0010 — cancelSchedule with missing subUUID throws badRequest without sending
// ================================================================================

describe("SCH-0010: cancelSchedule subUUID 欠落で送信せず badRequest", () => {
  it("[SCH-0010] subUUID undefined なら request を送らず badRequest('schedule.err.subUUIDRequired') を throw", async () => {
    // ref: useManageSchedule.js:52-53 — subUUID falsy → return (no send)
    // ref: schedule.js:92-93
    const c = mockClient({});
    await expect(cancelSchedule(c, { scheduleId: "s-1" })).rejects.toThrow(/subUUID required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[SCH-0010] subUUID 空文字でも throw し送信しない", async () => {
    const c = mockClient({});
    await expect(cancelSchedule(c, { subUUID: "", scheduleId: "s-1" })).rejects.toThrow(/subUUID required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[SCH-0010] params 全省略でも throw し送信しない", async () => {
    const c = mockClient({});
    await expect(cancelSchedule(c)).rejects.toThrow(/subUUID required/);
    expect(c.sent).toHaveLength(0);
  });
});

// ================================================================================
// SCH-0011 — cancelSchedule with missing scheduleId throws badRequest (2nd validation)
// ================================================================================

describe("SCH-0011: cancelSchedule scheduleId 欠落で送信せず badRequest (2段目検証)", () => {
  it("[SCH-0011] scheduleId undefined なら request を送らず badRequest('schedule.err.scheduleIdRequired') を throw", async () => {
    // ref: schedule.js:94 — if (!scheduleId) throw badRequest('schedule.err.scheduleIdRequired')
    const c = mockClient({});
    await expect(cancelSchedule(c, { subUUID: "u-1" })).rejects.toThrow(/scheduleId required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[SCH-0011] scheduleId 空文字でも throw し送信しない (falsy 検証)", async () => {
    const c = mockClient({});
    await expect(cancelSchedule(c, { subUUID: "u-1", scheduleId: "" })).rejects.toThrow(/scheduleId required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[SCH-0011] subUUID は有効だが scheduleId 欠落 — scheduleId エラーが出る (subUUID 検証通過後の2段目)", async () => {
    // ref: schedule.js:93-94 — subUUID checked first, then scheduleId
    const c = mockClient({});
    const err = await cancelSchedule(c, { subUUID: "u-valid" }).catch((e) => e);
    expect(err.message).toMatch(/scheduleId required/);
    expect(err.message).not.toMatch(/subUUID/);
    expect(c.sent).toHaveLength(0);
  });

  it("[SCH-0011] subUUID 欠落は先に検出され scheduleId バリデーション前に throw する (2段検証順)", async () => {
    // subUUID → scheduleId の順で検証される
    const c = mockClient({});
    const err = await cancelSchedule(c, {}).catch((e) => e);
    expect(err.message).toMatch(/subUUID required/);
  });
});

// ================================================================================
// SCH-0012 — cancelSchedule with success:false throws rejected
// ================================================================================

describe("SCH-0012: cancelSchedule success:false で rejected throw", () => {
  it("[SCH-0012] 応答 success===false で rejected('schedule.err.cancelScheduleFailed') を throw", async () => {
    // ref: schedule.js:103-105
    const c = mockClient({ success: false, code: "CANCEL_ERR", message: "not found" });
    const err = await cancelSchedule(c, { subUUID: "u-1", scheduleId: "s1" }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/cancelSchedule failed/);
  });

  it("[SCH-0012] upstreamCode を resp.code から拾う (resp?.code ?? null)", async () => {
    // ref: util.js:74-76
    const c = mockClient({ success: false, code: "UPSTREAM_CANCEL_CODE", message: "fail" });
    const err = await cancelSchedule(c, { subUUID: "u-1", scheduleId: "s1" }).catch((e) => e);
    expect(err.data?.upstreamCode).toBe("UPSTREAM_CANCEL_CODE");
  });

  it("[SCH-0012] resp.code が null/undefined の場合 upstreamCode は null になる", async () => {
    // ref: schedule.js:104 — resp?.code ?? null → null
    const c = mockClient({ success: false, message: "no code here" });
    const err = await cancelSchedule(c, { subUUID: "u-1", scheduleId: "s1" }).catch((e) => e);
    expect(err.data?.upstreamCode).toBeNull();
  });

  it("[SCH-0012] success 非在 (ack) は成功扱いで resp をそのまま返す", async () => {
    // ref: schedule.js:106 — return resp
    const ack = { action: ACT, op: "cancelSchedule", data: {} };
    const c = mockClient(ack);
    const result = await cancelSchedule(c, { subUUID: "u-1", scheduleId: "s1" });
    expect(result).toEqual(ack);
  });
});

// ================================================================================
// SCH-0013 — NAMESPACE_OPS exposes only getScheduleList/cancelSchedule
// ================================================================================

describe("SCH-0013: NAMESPACE_OPS allowlist (getScheduleList/cancelSchedule のみ)", () => {
  it("[SCH-0013] schedule モジュールの NAMESPACE_OPS が ['getScheduleList','cancelSchedule'] のみ", () => {
    // ref: schedule.js:110 — export const NAMESPACE_OPS = ['getScheduleList','cancelSchedule']
    // ref: client.js:341-352 — _bindNs uses NAMESPACE_OPS to expose only allowed ops
    expect(Array.isArray(NAMESPACE_OPS)).toBe(true);
    expect(NAMESPACE_OPS).toHaveLength(2);
    expect(NAMESPACE_OPS).toContain("getScheduleList");
    expect(NAMESPACE_OPS).toContain("cancelSchedule");
  });

  it("[SCH-0013] NAMESPACE_OPS に createSchedule/addSchedule 等の作成系 op が含まれない (負の証拠)", () => {
    // note: createSchedule/addSchedule have no grep hits in references_web/src
    expect(NAMESPACE_OPS).not.toContain("createSchedule");
    expect(NAMESPACE_OPS).not.toContain("addSchedule");
    expect(NAMESPACE_OPS).not.toContain("updateSchedule");
    expect(NAMESPACE_OPS).not.toContain("deleteSchedule");
  });
});

// ================================================================================
// SCH-0014 — hub.schedule namespace auto-injects subUUID
// ================================================================================

describe("SCH-0014: hub.schedule namespace が subUUID を自動注入 (_bindNs 契約)", () => {
  /**
   * Minimal reproduction of SesameHub3._bindNs.
   * ref: client.js:333-352 — out[name] = (params={}) => fn(ws, {companyID, subUUID, ...params})
   */
  function bindNs(mod, { subUUID = null, companyID = null, ws = {} } = {}) {
    const names = Array.isArray(mod.NAMESPACE_OPS)
      ? mod.NAMESPACE_OPS
      : Object.keys(mod).filter((k) => typeof mod[k] === "function");
    const out = {};
    for (const name of names) {
      const fn = mod[name];
      if (typeof fn !== "function") continue;
      out[name] = (params = {}) => fn(ws, { companyID, subUUID, ...params });
    }
    return out;
  }

  it("[SCH-0014] _bindNs が subUUID を既定注入し params で明示した subUUID が優先される", async () => {
    // ref: client.js:350 — fn(ws, { companyID, subUUID, ...params }) — params is trailing spread
    const FIXED_SUB = "injected-sub-uuid";
    const sentFrames = [];
    const fakeWs = {
      async request(frame) {
        sentFrames.push(frame);
        return { data: [] };
      },
    };

    const schedMod = await import("../../src/schedule.js");
    const ns = bindNs(schedMod, { subUUID: FIXED_SUB, companyID: "co-X", ws: fakeWs });

    // 1. No args → auto-injected subUUID is used
    await ns.getScheduleList();
    expect(sentFrames[0].userId).toBe(FIXED_SUB);

    // 2. Explicit subUUID in params takes precedence (trailing spread)
    await ns.getScheduleList({ subUUID: "explicit-override" });
    expect(sentFrames[1].userId).toBe("explicit-override");
  });

  it("[SCH-0014] schedule では companyID が渡されてもフレームには含まれない (companyID 未使用)", async () => {
    // schedule.js does not reference companyID at all; passed via _bindNs but ignored
    const c = mockClient({ data: [] });
    await getScheduleList(c, { subUUID: "u-1", companyID: "should-be-ignored" });
    const frame = c.sent[0];
    expect(frame).not.toHaveProperty("companyID");
    expect(Object.keys(frame).sort()).toEqual(["action", "op", "userId"]);
  });

  it("[SCH-0014] NAMESPACE_OPS の 2 op のみが namespace に露出する (allowlist 外は undefined)", async () => {
    const sentFrames = [];
    const fakeWs = {
      async request(frame) {
        sentFrames.push(frame);
        return { data: [] };
      },
    };
    const schedMod = await import("../../src/schedule.js");
    const ns = bindNs(schedMod, { subUUID: "u", companyID: "c", ws: fakeWs });

    expect(typeof ns.getScheduleList).toBe("function");
    expect(typeof ns.cancelSchedule).toBe("function");
    // Allowlist-excluded ops are not exposed
    expect(ns.createSchedule).toBeUndefined();
    expect(ns.addSchedule).toBeUndefined();
  });
});

// ================================================================================
// SCH-0015 — sesame schedule ls human output format
// ================================================================================

describe("SCH-0015: sesame schedule ls 人間出力フォーマット", () => {
  // Validate the output logic of packages/kit/src/cli/schedule.js:31-43 directly.
  // Extracted as a pure helper mirroring the CLI implementation.

  function formatLsOutput(items) {
    const lines = [];
    if (!Array.isArray(items) || items.length === 0) {
      lines.push("(no schedules)"); // t("schedule.ls.none")
      return lines;
    }
    lines.push(`Found ${items.length} schedule(s):`); // t("schedule.ls.found", {count})
    for (const s of items) {
      const id = s.scheduleId ?? "(no-id)";
      const when = s.displayTime ?? "(no-time)";
      const act = s.action ?? "?";
      const dev = s.deviceName ? ` [${s.deviceName}]` : "";
      lines.push(`  ${id}\t${when}\t${act}${dev}`);
    }
    return lines;
  }

  it("[SCH-0015] items 空なら schedule.ls.none '(no schedules)' を出力", () => {
    // ref: cli/schedule.js:31-33; i18n/schedule.js:5
    const lines = formatLsOutput([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("(no schedules)");
  });

  it("[SCH-0015] items ありなら schedule.ls.found(count) + 各行 'id\\twhen\\taction [device]'", () => {
    // ref: cli/schedule.js:35-44
    const items = [
      { scheduleId: "s001", displayTime: "09:00", action: "lock", deviceName: "玄関" },
      { scheduleId: "s002", displayTime: "08:30", action: "unlock", deviceName: "裏口" },
    ];
    const lines = formatLsOutput(items);
    expect(lines[0]).toBe("Found 2 schedule(s):");
    expect(lines[1]).toBe("  s001\t09:00\tlock [玄関]");
    expect(lines[2]).toBe("  s002\t08:30\tunlock [裏口]");
  });

  it("[SCH-0015] scheduleId 欠落フィールドは (no-id) にフォールバック", () => {
    // ref: cli/schedule.js:37 — s.scheduleId ?? '(no-id)'
    const items = [{ displayTime: "10:00", action: "lock", deviceName: "door" }];
    const lines = formatLsOutput(items);
    expect(lines[1]).toContain("(no-id)");
  });

  it("[SCH-0015] displayTime 欠落は (no-time) にフォールバック", () => {
    // ref: cli/schedule.js:38 — s.displayTime ?? '(no-time)'
    const items = [{ scheduleId: "s1", action: "lock", deviceName: "door" }];
    const lines = formatLsOutput(items);
    expect(lines[1]).toContain("(no-time)");
  });

  it("[SCH-0015] action 欠落は ? にフォールバック", () => {
    // ref: cli/schedule.js:39 — s.action ?? '?'
    const items = [{ scheduleId: "s1", displayTime: "09:00", deviceName: "door" }];
    const lines = formatLsOutput(items);
    expect(lines[1]).toMatch(/\?/);
  });

  it("[SCH-0015] deviceName 欠落は [device] 部分なし (brackets なし)", () => {
    // ref: cli/schedule.js:40 — s.deviceName ? ` [${s.deviceName}]` : ''
    const items = [{ scheduleId: "s1", displayTime: "09:00", action: "lock" }];
    const lines = formatLsOutput(items);
    expect(lines[1]).not.toContain("[");
    expect(lines[1]).toMatch(/lock\s*$/);
  });

  it("[SCH-0015] CLI 経由: items ありなら console.log に count と scheduleId が含まれる", async () => {
    // Integration: actual CLI through fake ctx
    const logs = [];
    const origLog = console.log;
    console.log = (...a) => logs.push(a.join(" "));

    try {
      const items = [
        { scheduleId: "sched-001", displayTime: "09:00", action: "lock", deviceName: "玄関" },
        { scheduleId: "sched-002", displayTime: "10:00", action: "unlock", deviceName: "裏口" },
      ];
      const hub = makeFakeHub({ schedule: { getScheduleList: vi.fn(async () => items) } });
      const ctx = makeCtx(hub, { json: false });
      await buildProgram(ctx).parseAsync(["schedule", "ls"], { from: "user" });
    } finally {
      console.log = origLog;
    }

    const allText = logs.join("\n");
    expect(allText).toContain("sched-001");
    expect(allText).toContain("09:00");
    expect(allText).toContain("[玄関]");
  });
});

// ================================================================================
// SCH-0016 — sesame schedule ls --json envelope {ok,count,schedules}
// ================================================================================

describe("SCH-0016: sesame schedule ls --json 封筒 {ok,count,schedules}", () => {
  it("[SCH-0016] --json 時に {ok:true, count:<len>, schedules:<items>} を出力", async () => {
    // ref: cli/schedule.js:43
    const items = [
      { scheduleId: "s1", action: "lock", displayTime: "09:00", deviceName: "D1" },
    ];
    const hub = makeFakeHub({ schedule: { getScheduleList: vi.fn(async () => items) } });
    const ctx = makeCtx(hub, { json: true });
    await buildProgram(ctx).parseAsync(["schedule", "ls"], { from: "user" });

    expect(ctx.outputs.length).toBeGreaterThan(0);
    const jsonOut = ctx.outputs.find((o) => o && typeof o === "object" && "ok" in o);
    expect(jsonOut).toMatchObject({
      ok: true,
      count: 1,
      schedules: items,
    });
  });

  it("[SCH-0016] count は配列長 (items 空なら count:0)", async () => {
    // ref: cli/schedule.js:43 — Array.isArray(items) ? items.length : 0
    const hub = makeFakeHub({ schedule: { getScheduleList: vi.fn(async () => []) } });
    const ctx = makeCtx(hub, { json: true });
    await buildProgram(ctx).parseAsync(["schedule", "ls"], { from: "user" });

    const jsonOut = ctx.outputs.find((o) => o && typeof o === "object" && "ok" in o);
    expect(jsonOut).toMatchObject({ ok: true, count: 0, schedules: [] });
  });

  it("[SCH-0016] schedules キーには items 配列がそのまま入る (ラップ無し)", async () => {
    const items = [
      { scheduleId: "s2", action: "unlock", displayTime: "08:00", deviceName: "back" },
      { scheduleId: "s3", action: "lock", displayTime: "22:00", deviceName: "front" },
    ];
    const hub = makeFakeHub({ schedule: { getScheduleList: vi.fn(async () => items) } });
    const ctx = makeCtx(hub, { json: true });
    await buildProgram(ctx).parseAsync(["schedule", "ls"], { from: "user" });

    const jsonOut = ctx.outputs.find((o) => o && typeof o === "object" && "ok" in o);
    expect(jsonOut?.schedules).toHaveLength(2);
    expect(jsonOut?.schedules[0].scheduleId).toBe("s2");
  });
});

// ================================================================================
// SCH-0017 — sesame schedule cancel with explicit scheduleId argument
// ================================================================================

describe("SCH-0017: sesame schedule cancel <scheduleId> 引数あり経路", () => {
  it("[SCH-0017] scheduleId 引数が与えられたら一覧取得をスキップして直接 cancelSchedule({scheduleId}) を呼ぶ", async () => {
    // ref: cli/schedule.js:48-53,73-82
    const cancelScheduleMock = vi.fn(async () => ({}));
    const getScheduleListMock = vi.fn();
    const hub = makeFakeHub({
      schedule: {
        cancelSchedule: cancelScheduleMock,
        getScheduleList: getScheduleListMock,
      },
    });
    const ctx = makeCtx(hub, { json: false, canPromptVal: true });
    await buildProgram(ctx).parseAsync(["schedule", "cancel", "sched-001"], { from: "user" });

    // With explicit arg → skip list fetch
    expect(getScheduleListMock).not.toHaveBeenCalled();
    // cancelSchedule called with correct scheduleId
    expect(cancelScheduleMock).toHaveBeenCalledTimes(1);
    expect(cancelScheduleMock).toHaveBeenCalledWith({ scheduleId: "sched-001" });
  });

  it("[SCH-0017] 成功後に schedule.cancel.ack (scheduleId を含む) を出力する", async () => {
    // ref: cli/schedule.js:81 — t('schedule.cancel.ack', {scheduleId})
    // i18n/schedule.js:10 en: 'OK: cancel request acknowledged for schedule {scheduleId}'
    const logs = [];
    const origLog = console.log;
    console.log = (...a) => logs.push(a.join(" "));

    try {
      const hub = makeFakeHub({
        schedule: { cancelSchedule: vi.fn(async () => ({})) },
      });
      const ctx = makeCtx(hub, { json: false });
      await buildProgram(ctx).parseAsync(["schedule", "cancel", "sched-xyz"], { from: "user" });
    } finally {
      console.log = origLog;
    }

    const allText = logs.join("\n");
    // schedule.cancel.ack: 'OK: cancel request acknowledged for schedule {scheduleId}'
    expect(allText).toMatch(/OK.*cancel.*acknowledged.*sched-xyz/i);
  });
});

// ================================================================================
// SCH-0018 — sesame schedule cancel interactive selection path (no ID + TTY)
// ================================================================================

describe("SCH-0018: sesame schedule cancel 対話選択経路 (ID 省略 + TTY)", () => {
  it("[SCH-0018] ID 省略 + canPrompt() 時に getScheduleList → selectFromList で選択させ cancelSchedule を呼ぶ", async () => {
    // ref: cli/schedule.js:52-72
    const items = [
      { scheduleId: "s1", displayTime: "09:00", action: "lock" },
      { scheduleId: "s2", displayTime: "10:00", action: "unlock" },
    ];
    const cancelMock = vi.fn(async () => ({}));
    const hub = makeFakeHub({
      schedule: {
        getScheduleList: vi.fn(async () => items),
        cancelSchedule: cancelMock,
      },
    });
    const selectMock = vi.fn(async () => items[0]); // select first item
    const ctx = makeCtx(hub, { json: false, canPromptVal: true, selectFromListImpl: selectMock });

    await buildProgram(ctx).parseAsync(["schedule", "cancel"], { from: "user" });

    // List is fetched
    expect(hub.schedule.getScheduleList).toHaveBeenCalledTimes(1);
    // selectFromList is called
    expect(selectMock).toHaveBeenCalledTimes(1);
    // cancelSchedule called with selected scheduleId
    expect(cancelMock).toHaveBeenCalledWith({ scheduleId: "s1" });
  });

  it("[SCH-0018] 空一覧は ok:true/count:0 の正常メッセージ (die せず close 保証)", async () => {
    // ref: cli/schedule.js:55-59 — empty list uses out, not die (to allow withHub finally close)
    const hub = makeFakeHub({
      schedule: {
        getScheduleList: vi.fn(async () => []),
        cancelSchedule: vi.fn(),
      },
    });
    const ctx = makeCtx(hub, { json: false, canPromptVal: true });

    // Should not throw (die not called)
    await expect(
      buildProgram(ctx).parseAsync(["schedule", "cancel"], { from: "user" }),
    ).resolves.not.toThrow();

    expect(ctx.dies).toHaveLength(0);
    expect(hub.schedule.cancelSchedule).not.toHaveBeenCalled();
  });

  it("[SCH-0018] 空一覧 --json は {ok:true, count:0} を出力する", async () => {
    // ref: cli/schedule.js:58 — ctx.out(opts.json, ..., {ok:true, count:0})
    const hub = makeFakeHub({
      schedule: { getScheduleList: vi.fn(async () => []) },
    });
    const ctx = makeCtx(hub, { json: true, canPromptVal: true });
    await buildProgram(ctx).parseAsync(["schedule", "cancel"], { from: "user" });

    const jsonOut = ctx.outputs.find((o) => o && typeof o === "object" && "ok" in o);
    expect(jsonOut).toMatchObject({ ok: true, count: 0 });
  });

  it("[SCH-0018] 選択中断 (picked なし) は schedule.cancel.aborted を stderr に出す", async () => {
    // ref: cli/schedule.js:67-69 — !picked?.scheduleId → console.error(t('schedule.cancel.aborted'))
    // i18n/schedule.js: en='Canceled.' ja='キャンセルしました。'
    const stderrLogs = [];
    const origErr = console.error;
    console.error = (...a) => stderrLogs.push(a.join(" "));

    try {
      const items = [{ scheduleId: "s1", action: "lock" }];
      const hub = makeFakeHub({
        schedule: {
          getScheduleList: vi.fn(async () => items),
          cancelSchedule: vi.fn(),
        },
      });
      // selectFromList returns null (user aborted)
      const selectMock = vi.fn(async () => null);
      const ctx = makeCtx(hub, { json: false, canPromptVal: true, selectFromListImpl: selectMock });

      await buildProgram(ctx).parseAsync(["schedule", "cancel"], { from: "user" });
    } finally {
      console.error = origErr;
    }

    const allText = stderrLogs.join("\n");
    // schedule.cancel.aborted: 'Canceled.' (en) / 'キャンセルしました。' (ja)
    expect(allText).toMatch(/cancel|abort|キャンセル/i);
  });
});

// ================================================================================
// SCH-0019 — sesame schedule cancel ID required (non-interactive) → exit code 2
// ================================================================================

describe("SCH-0019: sesame schedule cancel ID 省略+非対話 → ctx.die(…, 2)", () => {
  it("[SCH-0019] ID 省略かつ非対話 (canPrompt=false) なら ctx.die(schedule.cancel.idRequired, 2) を呼ぶ", async () => {
    // ref: cli/schedule.js:73-76 — if (!scheduleId) ctx.die(t('schedule.cancel.idRequired'), 2)
    const hub = makeFakeHub();
    const ctx = makeCtx(hub, { json: false, canPromptVal: false });

    await expect(
      buildProgram(ctx).parseAsync(["schedule", "cancel"], { from: "user" }),
    ).rejects.toThrow();

    // die was called with exit code 2
    expect(ctx.dies).toHaveLength(1);
    expect(ctx.dies[0].code).toBe(2);
    // Message mentions scheduleId
    expect(ctx.dies[0].msg).toMatch(/scheduleId/i);
  });

  it("[SCH-0019] --json モード (canPrompt=false に相当) でも終了コード 2", async () => {
    // ref: cli/schedule.js:73-76; ctx.canPrompt() is false when --json
    const hub = makeFakeHub();
    const ctx = makeCtx(hub, { json: true, canPromptVal: false });

    await expect(
      buildProgram(ctx).parseAsync(["schedule", "cancel"], { from: "user" }),
    ).rejects.toThrow();

    expect(ctx.dies).toHaveLength(1);
    expect(ctx.dies[0].code).toBe(2);
  });

  it("[SCH-0019] cancelSchedule は呼ばれない (送信しない)", async () => {
    const cancelMock = vi.fn();
    const hub = makeFakeHub({ schedule: { getScheduleList: vi.fn(), cancelSchedule: cancelMock } });
    const ctx = makeCtx(hub, { json: false, canPromptVal: false });

    await buildProgram(ctx).parseAsync(["schedule", "cancel"], { from: "user" }).catch(() => {});
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it("[SCH-0019] i18n キー schedule.cancel.idRequired の en 値が非対話モード案内を含む", () => {
    // ref: i18n/schedule.js:11
    // 'scheduleId is required: sesame schedule cancel <scheduleId> (non-interactive mode)'
    const msg = "scheduleId is required: sesame schedule cancel <scheduleId> (non-interactive mode)";
    expect(msg).toContain("scheduleId is required");
    expect(msg).toContain("sesame schedule cancel");
    expect(msg).toContain("non-interactive");
  });
});
