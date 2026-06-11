// payment (biz3ManagePayment) frame-shape tests.
import { describe, it, expect } from "vitest";
import {
  changeDefaultPayment,
  getClientSecret,
  getDevApiInfo,
  getPaymentMethods,
  payUpdateLevel,
  removePayment,
} from "../../src/payment.js";
// 共有 fake (P5-7 / ARCH-16): request(frame) を記録し、固定応答を返す。
import { mockClient } from "../helpers/mock-ws.js";

describe("payment namespace", () => {
  it("getPaymentMethods sends biz3ManagePayment/getPaymentMethods and returns array data", async () => {
    const data = [{ id: "pm_1" }];
    const c = mockClient({ success: true, data });
    await expect(getPaymentMethods(c, { companyID: "ch_A" })).resolves.toEqual(data);
    expect(c.sent[0]).toEqual({ action: "biz3ManagePayment", customerId: "ch_A", op: "getPaymentMethods" });
  });

  it("getClientSecret sends getClientSecret and returns data", async () => {
    const c = mockClient({ success: true, data: "seti_secret" });
    await expect(getClientSecret(c, { customerId: "ch_A" })).resolves.toBe("seti_secret");
    expect(c.sent[0]).toEqual({ action: "biz3ManagePayment", customerId: "ch_A", op: "getClientSecret" });
  });

  it("changeDefaultPayment sends defaultPaymentMethod", async () => {
    const c = mockClient({ success: true, data: { ok: true } });
    await changeDefaultPayment(c, { companyID: "ch_A", defaultPaymentMethod: "pm_1" });
    expect(c.sent[0]).toEqual({
      action: "biz3ManagePayment",
      customerId: "ch_A",
      defaultPaymentMethod: "pm_1",
      op: "changeDefaultPayment",
    });
  });

  it("removePayment sends paymentId", async () => {
    const c = mockClient({ success: true, data: [] });
    await removePayment(c, { companyID: "ch_A", paymentId: "pm_1" });
    expect(c.sent[0]).toEqual({
      action: "biz3ManagePayment",
      customerId: "ch_A",
      paymentId: "pm_1",
      op: "removePayment",
    });
  });

  it("payUpdateLevel sends subscription, level, direction and cancel flag", async () => {
    const c = mockClient({ success: true, data: { accepted: true } });
    await payUpdateLevel(c, {
      companyID: "ch_A",
      subscriptionId: "sub_1",
      level: 5,
      isUpgrade: true,
      isCancel: false,
    });
    expect(c.sent[0]).toEqual({
      action: "biz3ManagePayment",
      subId: "sub_1",
      isUpgrade: true,
      level: 5,
      isCancel: false,
      customerId: "ch_A",
      op: "payUpdateLevel",
    });
  });

  it("getDevApiInfo omits update unless requested", async () => {
    const c = mockClient({ success: true, data: { apiKeyId: "key" } });
    await getDevApiInfo(c, { companyID: "ch_A", email: "owner@example.com" });
    expect(c.sent[0]).toEqual({
      action: "biz3ManagePayment",
      customerId: "ch_A",
      email: "owner@example.com",
      op: "getDevApiInfo",
    });
    await getDevApiInfo(c, { companyID: "ch_A", email: "owner@example.com", update: true });
    expect(c.sent[1]).toEqual({
      action: "biz3ManagePayment",
      customerId: "ch_A",
      email: "owner@example.com",
      op: "getDevApiInfo",
      update: true,
    });
  });

  it("validates required params", async () => {
    const c = mockClient({ success: true });
    await expect(getPaymentMethods(c, {})).rejects.toThrow(/customerId required/);
    await expect(changeDefaultPayment(c, { companyID: "ch_A" })).rejects.toThrow(/defaultPaymentMethod required/);
    await expect(removePayment(c, { companyID: "ch_A" })).rejects.toThrow(/paymentId required/);
    await expect(payUpdateLevel(c, { companyID: "ch_A", subscriptionId: "sub_1", level: 1 })).rejects.toThrow(
      /isUpgrade required/,
    );
    await expect(getDevApiInfo(c, { companyID: "ch_A" })).rejects.toThrow(/email required/);
  });
});
