// account.getLoginUser の単体テスト。
// biz3GetLoginUser フレーム (op なし) + 応答 data.customerInfo/quotas を検証。
import { describe, it, expect } from "vitest";
import { getLoginUser } from "../../src/account.js";

// 最小 mock client: request(frame) を記録し、固定応答を返す。
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

describe("getLoginUser", () => {
  it("email 必須", async () => {
    const c = mockClient({});
    await expect(getLoginUser(c, {})).rejects.toThrow(/email required/);
  });

  it("フレームは {action:'biz3GetLoginUser', email} で op を含まない", async () => {
    const c = mockClient({ success: true, data: { customerInfo: {}, quotas: {} } });
    await getLoginUser(c, { email: "me@example.com" });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0].action).toBe("biz3GetLoginUser");
    expect(c.sent[0].email).toBe("me@example.com");
    expect(c.sent[0]).not.toHaveProperty("op");
  });

  it("応答 data.customerInfo / data.quotas を返す", async () => {
    const customerInfo = { companyID: "ch_X", subUUID: "u-1", name: "会社" };
    const quotas = { monthlyApiCalls: 3000 };
    const c = mockClient({ success: true, data: { customerInfo, quotas } });
    const r = await getLoginUser(c, { email: "me@example.com" });
    expect(r.customerInfo).toEqual(customerInfo);
    expect(r.quotas).toEqual(quotas);
  });

  it("success:false は throw", async () => {
    const c = mockClient({ success: false, message: "no user" });
    await expect(getLoginUser(c, { email: "x@y.z" })).rejects.toThrow(/getLoginUser failed: no user/);
  });

  it("data が無くても customerInfo/quotas は null で返る (例外にしない)", async () => {
    const c = mockClient({ success: true });
    const r = await getLoginUser(c, { email: "x@y.z" });
    expect(r.customerInfo).toBeNull();
    expect(r.quotas).toBeNull();
  });
});
