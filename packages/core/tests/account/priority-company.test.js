// account.js の純関数 newTags / priorityCompany / priorityCompanyId (BIZ-11) の単体テスト。
// 1:1 移植元: references_web/src/api/useStripeInfo.js:28-71、
//             references_web/src/utils/gUtils.js:134-149 (pageNames), 246 (allTags)。
import { describe, it, expect } from "vitest";
import {
  PAGE_NAMES,
  ALL_TAGS,
  newTags,
  priorityCompany,
  priorityCompanyId,
} from "../../src/account.js";

describe("PAGE_NAMES / ALL_TAGS (gUtils.js:134-149,246)", () => {
  it("日本語ページ名定数は web の実値と一致する", () => {
    expect(PAGE_NAMES.members).toBe("ユーザー");
    expect(PAGE_NAMES.cards).toBe("カード管理");
    expect(PAGE_NAMES.devices).toBe("デバイス（ドア・認証機器）");
    expect(PAGE_NAMES.historys).toBe("全体履歴");
    expect(PAGE_NAMES.developer).toBe("開発者向け");
    expect(PAGE_NAMES.membersRole).toBe("ロール");
  });

  it("ALL_TAGS は members/devices/cards/historys/developer の 5 件 (gUtils.js:246)", () => {
    expect(ALL_TAGS).toEqual(["ユーザー", "デバイス（ドア・認証機器）", "カード管理", "全体履歴", "開発者向け"]);
  });
});

describe("newTags (useStripeInfo.js:28-39)", () => {
  it("falsy はそのまま返す", () => {
    expect(newTags(null)).toBeNull();
    expect(newTags(undefined)).toBeUndefined();
  });

  it("isSesameApp は access に '開発者向け' を追加する", () => {
    const r = newTags({ isSesameApp: true, access: ["ユーザー"] });
    expect(r.access).toEqual(["ユーザー", "開発者向け"]);
  });

  it("tag[0]='オーナー' は access を allTags で置換する", () => {
    const r = newTags({ tag: ["オーナー"], access: ["ユーザー"] });
    expect(r.access).toEqual([...ALL_TAGS]);
  });

  it("tag[0]='マネージャー' も allTags 置換", () => {
    const r = newTags({ tag: ["マネージャー"], access: [] });
    expect(r.access).toEqual([...ALL_TAGS]);
  });

  it("それ以外のロールはそのまま返す (同一参照)", () => {
    const info = { tag: ["ゲスト"], access: ["ユーザー"] };
    expect(newTags(info)).toBe(info);
  });
});

describe("priorityCompany (useStripeInfo.js:41-63)", () => {
  const companies = [
    { companyID: "ch_A", name: "A", feeLevel: { subscriptionId: "sub_A", isRootUser: false, level: 1 } },
    { companyID: "ch_B", name: "B", feeLevel: { subscriptionId: "sub_B", isRootUser: false, level: 3 } },
  ];

  it("非 isSesameApp: customerInfo.companyID 一致の company の subscriptionId を合成して返す", () => {
    const r = priorityCompany({ companyID: "ch_B", name: "me" }, companies);
    expect(r.companyID).toBe("ch_B");
    expect(r.name).toBe("me"); // customerInfo 側が基底
    expect(r.subscriptionId).toBe("sub_B");
  });

  it("非 isSesameApp: 一致が無ければ subscriptionId は undefined のまま合成", () => {
    const r = priorityCompany({ companyID: "ch_X" }, companies);
    expect(r.companyID).toBe("ch_X");
    expect(r.subscriptionId).toBeUndefined();
  });

  it("isSesameApp: companies 空なら {}", () => {
    expect(priorityCompany({ isSesameApp: true }, [])).toEqual({});
  });

  it("isSesameApp: isRootUser === true の company を優先し feeLevel を展開する", () => {
    const withRoot = [
      ...companies,
      { companyID: "ch_R", feeLevel: { subscriptionId: "sub_R", isRootUser: true, level: 0 } },
    ];
    const r = priorityCompany({ isSesameApp: true }, withRoot);
    expect(r.companyID).toBe("ch_R");
    expect(r.subscriptionId).toBe("sub_R"); // feeLevel が展開される
    expect(r.isRootUser).toBe(true);
  });

  it("isSesameApp: rootUser 不在なら非 isSesameApp の中から feeLevel.level 最大を選ぶ", () => {
    const r = priorityCompany({ isSesameApp: true }, companies);
    expect(r.companyID).toBe("ch_B"); // level 3 > 1
    expect(r.level).toBe(3);
  });

  it("isSesameApp: 候補が 1 件も無い場合は {} (web の TypeError からの意図的逸脱。JSDoc 注記)", () => {
    const onlyApp = [{ companyID: "ch_S", isSesameApp: true, feeLevel: { level: 9 } }];
    expect(priorityCompany({ isSesameApp: true }, onlyApp)).toEqual({});
  });
});

describe("priorityCompanyId (useStripeInfo.js:65-67)", () => {
  it("priorityCompany の companyID を返す", () => {
    const companies = [{ companyID: "ch_A", feeLevel: { subscriptionId: "s" } }];
    expect(priorityCompanyId({ companyID: "ch_A" }, companies)).toBe("ch_A");
  });

  it("companyID が得られなければ null", () => {
    expect(priorityCompanyId({ isSesameApp: true }, [])).toBeNull();
  });
});
