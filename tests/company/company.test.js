// company (biz3ManageCompany) の単体テスト。
// 送信フレームの正確性 (action/op/フィールド名/ネスト構造) と応答パースを検証。
import { describe, it, expect } from "vitest";
import {
  getCompanies,
  updateCompanyName,
  addCompany,
  getPaymentConfig,
} from "../../src/company.js";

// 最小 mock client: request(frame) を記録し、固定応答を返す。
// account/getLoginUser.test.js と同じ手本。
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

describe("getCompanies", () => {
  it("フレームは {action:'biz3ManageCompany', op:'get'} で companyID/email を含まない", async () => {
    const c = mockClient({ success: true, data: [] });
    await getCompanies(c);
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({ action: "biz3ManageCompany", op: "get" });
    expect(c.sent[0]).not.toHaveProperty("companyID");
    expect(c.sent[0]).not.toHaveProperty("email");
    expect(c.sent[0]).not.toHaveProperty("obj");
  });

  it("応答 data の配列をそのまま返す", async () => {
    const companies = [
      {
        companyID: "ch_A",
        name: "会社A",
        feeLevel: { subscriptionId: "sub_1", isRootUser: true, level: 3 },
        tag: ["オーナー"],
        isSesameApp: false,
        employeeEmail: "owner@example.com",
        subUUID: "u-1",
      },
      { companyID: "ch_B", name: "会社B" },
    ];
    const c = mockClient({ success: true, data: companies });
    const r = await getCompanies(c);
    expect(r).toEqual(companies);
  });

  it("data が配列でなければ空配列を返す", async () => {
    const c = mockClient({ success: true });
    expect(await getCompanies(c)).toEqual([]);
  });

  it("success:false は throw", async () => {
    const c = mockClient({ success: false, message: "denied" });
    await expect(getCompanies(c)).rejects.toThrow(/getCompanies failed: denied/);
  });
});

describe("updateCompanyName", () => {
  it("companyID 必須", async () => {
    const c = mockClient({ success: true });
    await expect(updateCompanyName(c, { name: "x" })).rejects.toThrow(/companyID required/);
  });

  it("name 必須", async () => {
    const c = mockClient({ success: true });
    await expect(updateCompanyName(c, { companyID: "ch_A" })).rejects.toThrow(/name required/);
  });

  it("フレームは companyID/name を obj にネストし op:'updateName'", async () => {
    const c = mockClient({ success: true, data: { companyID: "ch_A", name: "新名" } });
    await updateCompanyName(c, { companyID: "ch_A", name: "新名" });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: "biz3ManageCompany",
      obj: { companyID: "ch_A", name: "新名" },
      op: "updateName",
    });
    // companyID/name はトップレベルに置かない
    expect(c.sent[0]).not.toHaveProperty("companyID");
    expect(c.sent[0]).not.toHaveProperty("name");
  });

  it("応答 data の {companyID, name} を返す", async () => {
    const c = mockClient({ success: true, data: { companyID: "ch_A", name: "新名" } });
    const r = await updateCompanyName(c, { companyID: "ch_A", name: "新名" });
    expect(r).toEqual({ companyID: "ch_A", name: "新名" });
  });

  it("data 欠落時は入力値で補完して返す", async () => {
    const c = mockClient({ success: true });
    const r = await updateCompanyName(c, { companyID: "ch_A", name: "新名" });
    expect(r).toEqual({ companyID: "ch_A", name: "新名" });
  });

  it("success:false は throw", async () => {
    const c = mockClient({ success: false, message: "nope" });
    await expect(updateCompanyName(c, { companyID: "ch_A", name: "x" })).rejects.toThrow(
      /updateCompanyName failed: nope/,
    );
  });

  it("name は空文字でも許容 (null/undefined のみ拒否)", async () => {
    const c = mockClient({ success: true, data: { companyID: "ch_A", name: "" } });
    await updateCompanyName(c, { companyID: "ch_A", name: "" });
    expect(c.sent[0].obj).toEqual({ companyID: "ch_A", name: "" });
  });
});

describe("addCompany", () => {
  it("name / employeeEmail / subUUID は必須", async () => {
    const c = mockClient({ success: true });
    await expect(addCompany(c, { employeeEmail: "e", subUUID: "u" })).rejects.toThrow(/name required/);
    await expect(addCompany(c, { name: "n", subUUID: "u" })).rejects.toThrow(/employeeEmail required/);
    await expect(addCompany(c, { name: "n", employeeEmail: "e" })).rejects.toThrow(/subUUID required/);
  });

  it("フレームはフラット展開 (obj ラップ無し / companyID 無し) で op:'add'", async () => {
    const c = mockClient({ success: true, data: { companyID: "ch_new", name: "新会社" } });
    await addCompany(c, { name: "新会社", employeeEmail: "me@example.com", subUUID: "u-9" });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: "biz3ManageCompany",
      name: "新会社",
      employeeEmail: "me@example.com",
      subUUID: "u-9",
      op: "add",
    });
    expect(c.sent[0]).not.toHaveProperty("obj");
    expect(c.sent[0]).not.toHaveProperty("companyID");
  });

  it("応答 data (新規 company) を返す", async () => {
    const created = { companyID: "ch_new", name: "新会社" };
    const c = mockClient({ success: true, data: created });
    expect(await addCompany(c, { name: "新会社", employeeEmail: "me@example.com", subUUID: "u-9" })).toEqual(
      created,
    );
  });

  it("success:false は throw", async () => {
    const c = mockClient({ success: false, message: "dup" });
    await expect(
      addCompany(c, { name: "n", employeeEmail: "e", subUUID: "u" }),
    ).rejects.toThrow(/addCompany failed: dup/);
  });
});

describe("getPaymentConfig", () => {
  it("companyID 必須", async () => {
    const c = mockClient({ success: true });
    await expect(getPaymentConfig(c, {})).rejects.toThrow(/companyID required/);
  });

  it("フレームは companyID をトップレベルに置き op:'getPaymentConfig'", async () => {
    const c = mockClient({ success: true, data: { levels: [] } });
    await getPaymentConfig(c, { companyID: "ch_A" });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: "biz3ManageCompany",
      companyID: "ch_A",
      op: "getPaymentConfig",
    });
    expect(c.sent[0]).not.toHaveProperty("obj");
  });

  it("応答 data をそのまま返す (構造未確認)", async () => {
    const cfg = { levels: [{ level: 1, price: 100 }] };
    const c = mockClient({ success: true, data: cfg });
    expect(await getPaymentConfig(c, { companyID: "ch_A" })).toEqual(cfg);
  });

  it("data 欠落時は null", async () => {
    const c = mockClient({ success: true });
    expect(await getPaymentConfig(c, { companyID: "ch_A" })).toBeNull();
  });

  it("success:false は throw", async () => {
    const c = mockClient({ success: false, message: "err" });
    await expect(getPaymentConfig(c, { companyID: "ch_A" })).rejects.toThrow(
      /getPaymentConfig failed: err/,
    );
  });
});
