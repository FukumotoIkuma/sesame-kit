// P3-8: changeDefaultPayment が reqContext を返すことを検証するテスト。
//
// 参照: references_web/src/api/useStripeInfo.js:123-135 — vendor は
//   message.reqContext.defaultPaymentMethod を読む (resp.data ではなく reqContext が実体)。
// 修正前: return resp?.data ?? null  (reqContext が破棄されていた)
// 修正後: return { data: resp?.data ?? null, reqContext: resp?.reqContext }

import { describe, it, expect } from "vitest";
import { changeDefaultPayment } from "../../src/payment.js";
import { mockClient } from "../helpers/mock-ws.js";

describe("P3-8: changeDefaultPayment — reqContext を破棄しない", () => {
  it("応答に reqContext がある場合、戻り値に reqContext が含まれる (useStripeInfo.js:124)", async () => {
    // vendor のフィールド: message.reqContext.defaultPaymentMethod を消費する。
    // 参照: references_web/src/api/useStripeInfo.js:124
    const reqContext = { defaultPaymentMethod: "pm_card_visa" };
    const c = mockClient({ success: true, data: null, reqContext });

    const result = await changeDefaultPayment(c, {
      companyID: "ch_A",
      defaultPaymentMethod: "pm_card_visa",
    });

    expect(result).toHaveProperty("reqContext");
    expect(result.reqContext).toEqual(reqContext);
    expect(result.reqContext.defaultPaymentMethod).toBe("pm_card_visa");
  });

  it("data フィールドも引き続き含まれる", async () => {
    const dataPayload = { ok: true };
    const c = mockClient({ success: true, data: dataPayload, reqContext: { defaultPaymentMethod: "pm_x" } });

    const result = await changeDefaultPayment(c, {
      companyID: "ch_A",
      defaultPaymentMethod: "pm_x",
    });

    expect(result.data).toEqual(dataPayload);
  });

  it("reqContext が存在しない応答でも戻り値は { data, reqContext: undefined } shape になる", async () => {
    const c = mockClient({ success: true, data: null });

    const result = await changeDefaultPayment(c, {
      companyID: "ch_A",
      defaultPaymentMethod: "pm_y",
    });

    expect(result).toHaveProperty("data");
    expect(result).toHaveProperty("reqContext");
    expect(result.data).toBeNull();
  });

  it("送信フレームは従来と変わらない", async () => {
    const c = mockClient({ success: true, data: null, reqContext: {} });

    await changeDefaultPayment(c, { companyID: "ch_A", defaultPaymentMethod: "pm_1" });

    expect(c.sent[0]).toEqual({
      action: "biz3ManagePayment",
      customerId: "ch_A",
      defaultPaymentMethod: "pm_1",
      op: "changeDefaultPayment",
    });
  });
});
