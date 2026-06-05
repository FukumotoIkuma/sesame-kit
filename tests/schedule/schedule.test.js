// schedule.getScheduleList / cancelSchedule の単体テスト。
// biz3Schedule フレーム (flat JSON: action/userId/op, obj ラップ無し / companyID 無し) と
// 応答パース (getScheduleList の data は配列直返し) を検証。
// 一次資料: useManageSchedule.js:11-24 / :50-64。
import { describe, it, expect } from "vitest";
import { getScheduleList, cancelSchedule } from "../../src/schedule.js";

// 最小 mock client: request(frame) を記録し、固定応答を返す (getLoginUser.test.js が手本)。
function mockClient(reply) {
  const sent = [];
  return {
    sent,
    async request(frame) {
      sent.push(frame);
      return reply;
    },
  };
}

describe("getScheduleList", () => {
  it("subUUID 必須", async () => {
    const c = mockClient({});
    await expect(getScheduleList(c, {})).rejects.toThrow(/subUUID required/);
    await expect(getScheduleList(c, { subUUID: "" })).rejects.toThrow(/subUUID required/);
    expect(c.sent).toHaveLength(0); // falsy なら送信自体しない
  });

  it("フレームは {action:'biz3Schedule', userId, op:'getScheduleList'} (flat / obj ラップ無し)", async () => {
    const c = mockClient({ success: true, data: [] });
    await getScheduleList(c, { subUUID: "sub-RAW-uuid-123" });
    expect(c.sent).toHaveLength(1);
    const frame = c.sent[0];
    expect(frame.action).toBe("biz3Schedule");
    expect(frame.op).toBe("getScheduleList");
    // userId は subUUID を加工せずそのまま (大文字化やハイフン加工なし)
    expect(frame.userId).toBe("sub-RAW-uuid-123");
  });

  it("フレームに companyID / apiKeyId / obj / scheduleId を含まない", async () => {
    const c = mockClient({ success: true, data: [] });
    await getScheduleList(c, { subUUID: "u-1" });
    const frame = c.sent[0];
    expect(frame).not.toHaveProperty("companyID");
    expect(frame).not.toHaveProperty("apiKeyId");
    expect(frame).not.toHaveProperty("obj");
    expect(frame).not.toHaveProperty("scheduleId");
    // フレームのキーは action/userId/op の 3 つだけ
    expect(Object.keys(frame).sort()).toEqual(["action", "op", "userId"]);
  });

  it("応答 data (配列直返し) をそのまま返す", async () => {
    const items = [
      { scheduleId: "s1", action: "lock", displayTime: "2026-01-01 09:00", deviceName: "玄関" },
      { scheduleId: "s2", action: "unlock", displayTime: "08:30", deviceName: "勝手口" },
    ];
    const c = mockClient({ success: true, data: items });
    const r = await getScheduleList(c, { subUUID: "u-1" });
    expect(r).toEqual(items);
    expect(r).toHaveLength(2);
    expect(r[0].scheduleId).toBe("s1");
  });

  it("data が配列でない/欠落なら空配列を返す", async () => {
    const c1 = mockClient({ success: true });
    expect(await getScheduleList(c1, { subUUID: "u-1" })).toEqual([]);

    const c2 = mockClient({ success: true, data: { Items: [] } }); // obj ラップは想定外 → []
    expect(await getScheduleList(c2, { subUUID: "u-1" })).toEqual([]);
  });

  it("success:false は throw", async () => {
    const c = mockClient({ success: false, message: "no auth" });
    await expect(getScheduleList(c, { subUUID: "u-1" })).rejects.toThrow(/getScheduleList failed: no auth/);
  });

  it("success フィールドが無くても (= 通常応答) data を返す", async () => {
    const c = mockClient({ action: "biz3Schedule", op: "getScheduleList", data: [{ scheduleId: "x" }] });
    const r = await getScheduleList(c, { subUUID: "u-1" });
    expect(r).toEqual([{ scheduleId: "x" }]);
  });
});

describe("cancelSchedule", () => {
  it("subUUID 必須", async () => {
    const c = mockClient({});
    await expect(cancelSchedule(c, { scheduleId: "s1" })).rejects.toThrow(/subUUID required/);
    expect(c.sent).toHaveLength(0);
  });

  it("scheduleId 必須", async () => {
    const c = mockClient({});
    await expect(cancelSchedule(c, { subUUID: "u-1" })).rejects.toThrow(/scheduleId required/);
    expect(c.sent).toHaveLength(0);
  });

  it("フレームは {action, userId, scheduleId, op:'cancelSchedule'} (flat)", async () => {
    const c = mockClient({ success: true });
    await cancelSchedule(c, { subUUID: "u-RAW", scheduleId: "sched-9" });
    expect(c.sent).toHaveLength(1);
    const frame = c.sent[0];
    expect(frame.action).toBe("biz3Schedule");
    expect(frame.op).toBe("cancelSchedule");
    expect(frame.userId).toBe("u-RAW"); // 加工なし
    expect(frame.scheduleId).toBe("sched-9");
    expect(Object.keys(frame).sort()).toEqual(["action", "op", "scheduleId", "userId"]);
  });

  it("フレームに companyID / obj を含まない", async () => {
    const c = mockClient({ success: true });
    await cancelSchedule(c, { subUUID: "u-1", scheduleId: "s1" });
    const frame = c.sent[0];
    expect(frame).not.toHaveProperty("companyID");
    expect(frame).not.toHaveProperty("obj");
  });

  it("ack をそのまま返す (ack 受信=成功)", async () => {
    const ack = { action: "biz3Schedule", op: "cancelSchedule", data: { ok: true } };
    const c = mockClient(ack);
    const r = await cancelSchedule(c, { subUUID: "u-1", scheduleId: "s1" });
    expect(r).toEqual(ack);
  });

  it("success:false は throw", async () => {
    const c = mockClient({ success: false, message: "not found" });
    await expect(cancelSchedule(c, { subUUID: "u-1", scheduleId: "s1" })).rejects.toThrow(
      /cancelSchedule failed: not found/,
    );
  });
});
