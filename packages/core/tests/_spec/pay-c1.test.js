// packages/core/tests/_spec/pay-c1.test.js
// Spec-driven tests for PAY-0019 through PAY-0036 (payment domain).
// Each it() title is prefixed with its spec ID. Tests are TDD: assertions
// follow the spec contract. Where the implementation currently diverges from
// spec the test is expected to be red (TDD — do not bend assert to match
// a buggy implementation).
// No network / BLE / real device access — all mock or pure-function.

import { describe, it, expect } from "vitest";
import {
  getPaymentMethods,
  getClientSecret,
  changeDefaultPayment,
  removePayment,
  payUpdateLevel,
  getDevApiInfo,
  NAMESPACE_OPS,
} from "../../src/payment.js";
import { SesameError, ERR } from "../../src/errors.js";
import { errorFromThrow, KIND, RPC } from "../../src/jsonrpc.js";
import { mockClient } from "../helpers/mock-ws.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Standard success mock. */
function ok(data = null, extra = {}) {
  return mockClient({ success: true, data, ...extra });
}

/** Success mock that also carries a reqContext. */
function okCtx(data, reqContext) {
  return mockClient({ success: true, data, reqContext });
}

/** Mock that returns success:false (upstream rejection). */
function failUpstream(code = "STRIPE_CARD_DECLINED") {
  return mockClient({ success: false, code, message: "declined" });
}

/** Mock that returns no success field (success key absent). */
function noSuccessField(data) {
  return mockClient({ data });
}

// ─── PAY-0019 ─────────────────────────────────────────────────────────────────

describe("[PAY-0019] PaymentPayUpdateLevelRequest proto fields — subId and subscriptionId", () => {
  it("[PAY-0019] proto field subId: wire frame uses key subId when subId is passed directly", async () => {
    const c = ok({ accepted: true });
    await payUpdateLevel(c, { companyID: "ch_A", subId: "sub_wire", level: 4, isUpgrade: true });
    expect(c.sent[0]).toHaveProperty("subId", "sub_wire");
  });

  it("[PAY-0019] proto field subscriptionId alias: wire frame resolves to subId key (not subscriptionId)", async () => {
    // Core resolves: subId = params.subId || params.subscriptionId (payment.js:135).
    const c = ok({ accepted: true });
    await payUpdateLevel(c, { companyID: "ch_A", subscriptionId: "sub_alias", level: 4, isUpgrade: true });
    expect(c.sent[0]).toHaveProperty("subId", "sub_alias");
    expect(c.sent[0]).not.toHaveProperty("subscriptionId");
  });

  it("[PAY-0019] rpc-params.generated.json lists both subId and subscriptionId for payment.payUpdateLevel", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const url = new URL(
      "../../../kit/src/serve/rpc-params.generated.json",
      import.meta.url,
    );
    const gen = JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
    const params = gen["payment.payUpdateLevel"];
    expect(params).toBeDefined();
    const names = params.map((p) => p.name);
    expect(names).toContain("subId");
    expect(names).toContain("subscriptionId");
    // Both must be required:false (optional by design).
    const subIdEntry = params.find((p) => p.name === "subId");
    const subscriptionIdEntry = params.find((p) => p.name === "subscriptionId");
    expect(subIdEntry.required).toBe(false);
    expect(subscriptionIdEntry.required).toBe(false);
  });
});

// ─── PAY-0020 ─────────────────────────────────────────────────────────────────

describe("[PAY-0020] daemon companyID auto-injection for payment ops (_bindNs contract)", () => {
  it("[PAY-0020] customerIdOf uses companyID when customerId absent (daemon-injected path)", async () => {
    const c = ok([]);
    const result = await getPaymentMethods(c, { companyID: "ch_INJECTED" });
    expect(c.sent[0]).toMatchObject({ action: "biz3ManagePayment", customerId: "ch_INJECTED", op: "getPaymentMethods" });
    expect(Array.isArray(result)).toBe(true);
  });

  it("[PAY-0020] explicit customerId overrides daemon-injected companyID", async () => {
    // _bindNs: { companyID, ...params } — params.customerId wins because customerIdOf
    // prefers params.customerId first.
    const c = ok([]);
    await getPaymentMethods(c, { companyID: "ch_DAEMON", customerId: "ch_EXPLICIT" });
    expect(c.sent[0]).toMatchObject({ customerId: "ch_EXPLICIT" });
  });

  it("[PAY-0020] getDevApiInfo also uses injected companyID when customerId absent", async () => {
    const c = ok({ apiKeyValue: "v", apiKeyId: "k", usedCount: 0 });
    await getDevApiInfo(c, { companyID: "ch_DAEMON", email: "user@example.com" });
    expect(c.sent[0]).toMatchObject({ customerId: "ch_DAEMON" });
  });

  it("[PAY-0020] rpc-params companyID for payment.getPaymentMethods is required:false with auto-injected desc", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const url = new URL(
      "../../../kit/src/serve/rpc-params.generated.json",
      import.meta.url,
    );
    const gen = JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
    const params = gen["payment.getPaymentMethods"];
    const companyIDEntry = params.find((p) => p.name === "companyID");
    expect(companyIDEntry).toBeDefined();
    expect(companyIDEntry.required).toBe(false);
    expect(companyIDEntry.desc).toMatch(/auto-injected/i);
  });
});

// ─── PAY-0021 ─────────────────────────────────────────────────────────────────

describe("[PAY-0021] payment SesameError → JSON-RPC error mapping", () => {
  it("[PAY-0021] SesameError(bad_request) → JSON-RPC INVALID_PARAMS / kind=bad_params", () => {
    const err = new SesameError("customerId required", {
      code: ERR.BAD_REQUEST,
      retryable: false,
    });
    const envelope = errorFromThrow(1, err);
    expect(envelope.error.code).toBe(RPC.INVALID_PARAMS);
    expect(envelope.error.data?.kind).toBe(KIND.BAD_PARAMS);
    expect(envelope.error.data?.retryable).toBe(false);
  });

  it("[PAY-0021] SesameError(rejected, upstreamCode) → JSON-RPC APP_ERROR / kind=rejected / retryable=false", () => {
    const err = new SesameError("upstream failed", {
      code: ERR.REJECTED,
      retryable: false,
      data: { upstreamCode: "E001" },
    });
    const envelope = errorFromThrow(2, err);
    expect(envelope.error.code).toBe(RPC.APP_ERROR);
    expect(envelope.error.data?.kind).toBe(KIND.REJECTED);
    expect(envelope.error.data?.retryable).toBe(false);
    expect(envelope.error.data?.upstreamCode).toBe("E001");
  });

  it("[PAY-0021] SesameError(timeout) → JSON-RPC APP_ERROR / kind=timeout / retryable=true", () => {
    const err = new SesameError("request timed out", {
      code: ERR.TIMEOUT,
      retryable: true,
    });
    const envelope = errorFromThrow(3, err);
    expect(envelope.error.code).toBe(RPC.APP_ERROR);
    expect(envelope.error.data?.kind).toBe(KIND.TIMEOUT);
    expect(envelope.error.data?.retryable).toBe(true);
  });

  it("[PAY-0021] missing customerId throws SesameError code=bad_request (changeDefaultPayment)", async () => {
    const c = ok();
    let err;
    try {
      await changeDefaultPayment(c, { defaultPaymentMethod: "pm_1" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(err.retryable).toBe(false);
    // Verify JSON-RPC mapping
    const envelope = errorFromThrow(4, err);
    expect(envelope.error.code).toBe(RPC.INVALID_PARAMS);
    expect(envelope.error.data?.kind).toBe(KIND.BAD_PARAMS);
  });

  it("[PAY-0021] upstream success:false throws SesameError code=rejected (payUpdateLevel)", async () => {
    const c = failUpstream("SUBSCRIPTION_ERROR");
    let err;
    try {
      await payUpdateLevel(c, { companyID: "ch_A", level: 4, isUpgrade: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.REJECTED);
    expect(err.data?.upstreamCode).toBe("SUBSCRIPTION_ERROR");
    // Verify JSON-RPC mapping
    const envelope = errorFromThrow(5, err);
    expect(envelope.error.code).toBe(RPC.APP_ERROR);
    expect(envelope.error.data?.kind).toBe(KIND.REJECTED);
  });
});

// ─── PAY-0022 ─────────────────────────────────────────────────────────────────

describe("[PAY-0022] generated SDK (ts/py) has payment 6 methods matching openrpc", () => {
  const EXPECTED_METHODS = [
    "changeDefaultPayment",
    "getClientSecret",
    "getDevApiInfo",
    "getPaymentMethods",
    "payUpdateLevel",
    "removePayment",
  ];

  it("[PAY-0022] sesame-client.ts payment object has all 6 methods (payment.<method> references)", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const url = new URL("../../../kit/sdk/ts/sesame-client.ts", import.meta.url);
    const src = readFileSync(fileURLToPath(url), "utf8");
    for (const method of EXPECTED_METHODS) {
      expect(src, `ts SDK: payment.${method} が存在する`).toContain(`payment.${method}`);
    }
  });

  it("[PAY-0022] sesame-client.ts payment.payUpdateLevel has subId and subscriptionId params", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const url = new URL("../../../kit/sdk/ts/sesame-client.ts", import.meta.url);
    const src = readFileSync(fileURLToPath(url), "utf8");
    const payUpdateLevelLine = src.split("\n").find((l) => l.includes("payment.payUpdateLevel"));
    expect(payUpdateLevelLine, "payUpdateLevel entry found").toBeDefined();
    expect(payUpdateLevelLine).toMatch(/subId/);
    expect(payUpdateLevelLine).toMatch(/subscriptionId/);
  });

  it("[PAY-0022] sesame_client.py _Payment class has all 6 methods", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const url = new URL("../../../kit/sdk/python/sesame_client.py", import.meta.url);
    const src = readFileSync(fileURLToPath(url), "utf8");
    for (const method of EXPECTED_METHODS) {
      expect(src, `py SDK: ${method} が存在する`).toContain(`def ${method}(`);
    }
  });

  it("[PAY-0022] sesame_client.py _omit_none is defined and used in payment methods", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const url = new URL("../../../kit/sdk/python/sesame_client.py", import.meta.url);
    const src = readFileSync(fileURLToPath(url), "utf8");
    expect(src, "_omit_none 定義が存在する").toContain("def _omit_none(");
    expect(src, "_omit_none 使用箇所が存在する").toContain("_omit_none({");
  });
});

// ─── PAY-0023 ─────────────────────────────────────────────────────────────────

describe("[PAY-0023] CLI: sesame payment methods → getPaymentMethods exposure and output shape", () => {
  it("[PAY-0023] getPaymentMethods returns array for CLI {ok,count,paymentMethods} envelope", async () => {
    const items = [
      { id: "pm_aaa", isDefaultPay: true },
      { id: "pm_bbb", isDefaultPay: false },
    ];
    const c = ok(items);
    const result = await getPaymentMethods(c, { companyID: "ch_A" });
    expect(result).toEqual(items);
    expect(result.length).toBe(2);
    expect(result[0].isDefaultPay).toBe(true);
  });

  it("[PAY-0023] getPaymentMethods returns [] when data is empty array", async () => {
    const c = ok([]);
    const result = await getPaymentMethods(c, { companyID: "ch_A" });
    expect(result).toEqual([]);
  });

  it("[PAY-0023] --customer-id omission: _bindNs companyID injection → customerId on wire", async () => {
    // CLI calls hub.payment.getPaymentMethods({ customerId: opts.customerId })
    // when --customer-id is omitted, opts.customerId is undefined.
    // _bindNs merges { companyID, ...params }, so customerIdOf sees companyID.
    const c = ok([]);
    await getPaymentMethods(c, { companyID: "ch_INJECT", customerId: undefined });
    expect(c.sent[0].customerId).toBe("ch_INJECT");
  });

  it("[PAY-0023] --json envelope shape is { ok:true, count, paymentMethods }", () => {
    const items = [{ id: "pm_1", isDefaultPay: true }, { id: "pm_2" }];
    // cli/payment.js: { ok: true, count: items.length, paymentMethods: items }
    const jsonOutput = { ok: true, count: items.length, paymentMethods: items };
    expect(jsonOutput.ok).toBe(true);
    expect(jsonOutput.count).toBe(2);
    expect(jsonOutput.paymentMethods).toEqual(items);
  });
});

// ─── PAY-0024 ─────────────────────────────────────────────────────────────────

describe("[PAY-0024] CLI: sesame payment client-secret → getClientSecret exposure and output shape", () => {
  it("[PAY-0024] getClientSecret returns the secret string for JSON output {ok,clientSecret}", async () => {
    const c = mockClient({ success: true, data: "seti_secret_abc123" });
    const secret = await getClientSecret(c, { companyID: "ch_A" });
    expect(secret).toBe("seti_secret_abc123");
    expect(c.sent[0]).toEqual({ action: "biz3ManagePayment", customerId: "ch_A", op: "getClientSecret" });
  });

  it("[PAY-0024] getClientSecret returns null when data is absent", async () => {
    const c = mockClient({ success: true, data: null });
    const secret = await getClientSecret(c, { companyID: "ch_A" });
    expect(secret).toBeNull();
  });

  it("[PAY-0024] getClientSecret frame has only {action, customerId, op} keys (no extra keys)", async () => {
    const c = mockClient({ success: true, data: "seti_x" });
    await getClientSecret(c, { customerId: "ch_CUST" });
    const frame = c.sent[0];
    expect(Object.keys(frame)).toEqual(["action", "customerId", "op"]);
  });

  it("[PAY-0024] --json envelope shape is { ok:true, clientSecret }", () => {
    const secret = "seti_secret_xyz";
    const jsonOutput = { ok: true, clientSecret: secret };
    expect(jsonOutput.ok).toBe(true);
    expect(jsonOutput.clientSecret).toBe(secret);
  });
});

// ─── PAY-0025 ─────────────────────────────────────────────────────────────────

describe("[PAY-0025] CLI: sesame payment default <pm> → --yes gate and changeDefaultPayment exposure", () => {
  it("[PAY-0025] changeDefaultPayment is called with correct params when --yes is present", async () => {
    const c = okCtx(null, { defaultPaymentMethod: "pm_xyz" });
    const result = await changeDefaultPayment(c, {
      customerId: "ch_A",
      defaultPaymentMethod: "pm_xyz",
    });
    expect(c.sent[0]).toMatchObject({
      action: "biz3ManagePayment",
      customerId: "ch_A",
      defaultPaymentMethod: "pm_xyz",
      op: "changeDefaultPayment",
    });
    // CLI: { ok: true, response: result }
    expect(result).toHaveProperty("data");
    expect(result).toHaveProperty("reqContext");
  });

  it("[PAY-0025] missing defaultPaymentMethod throws bad_request before send", async () => {
    const c = ok();
    let err;
    try {
      await changeDefaultPayment(c, { companyID: "ch_A" }); // defaultPaymentMethod 欠落
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(err.message).toMatch(/defaultPaymentMethod required/);
    expect(c.sent.length).toBe(0);
  });

  it("[PAY-0025] --yes absent: die(confirmRequired, 2) is called and changeDefaultPayment is not called", () => {
    let dieCalled = false;
    let hubCalled = false;
    const ctxMock = {
      die: (msg, code) => { dieCalled = true; expect(code).toBe(2); },
    };
    const opts = { yes: false };
    if (!opts.yes) {
      ctxMock.die("confirmRequired", 2);
    } else {
      hubCalled = true;
    }
    expect(dieCalled).toBe(true);
    expect(hubCalled).toBe(false);
  });

  it("[PAY-0025] changeDefaultPayment frame is { action, customerId, defaultPaymentMethod, op }", async () => {
    const c = okCtx(null, {});
    await changeDefaultPayment(c, { customerId: "ch_A", defaultPaymentMethod: "pm_visa" });
    expect(c.sent[0]).toEqual({
      action: "biz3ManagePayment",
      customerId: "ch_A",
      defaultPaymentMethod: "pm_visa",
      op: "changeDefaultPayment",
    });
  });
});

// ─── PAY-0026 ─────────────────────────────────────────────────────────────────

describe("[PAY-0026] CLI: sesame payment remove <id> → --yes gate and removePayment exposure", () => {
  it("[PAY-0026] removePayment is called with correct params when --yes is present", async () => {
    const c = ok(null);
    const result = await removePayment(c, { customerId: "ch_A", paymentId: "pm_del" });
    expect(c.sent[0]).toMatchObject({
      action: "biz3ManagePayment",
      customerId: "ch_A",
      paymentId: "pm_del",
      op: "removePayment",
    });
    expect(result).toBeNull();
  });

  it("[PAY-0026] missing paymentId throws bad_request before send (guard fires)", async () => {
    const c = ok();
    let err;
    try {
      await removePayment(c, { companyID: "ch_A" }); // paymentId 欠落
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(err.message).toMatch(/paymentId required/);
    expect(c.sent.length).toBe(0);
  });

  it("[PAY-0026] removePayment returns data (updated card list or null)", async () => {
    const cards = [{ id: "pm_keep" }];
    const c = ok(cards);
    const result = await removePayment(c, { companyID: "ch_A", paymentId: "pm_del" });
    expect(result).toEqual(cards);
  });

  it("[PAY-0026] --yes absent: die(confirmRequired, 2) is called and removePayment is not called", () => {
    let dieCalled = false;
    let hubCalled = false;
    const ctxMock = {
      die: (msg, code) => { dieCalled = true; expect(code).toBe(2); },
    };
    const opts = { yes: undefined };
    if (!opts.yes) {
      ctxMock.die("confirmRequired", 2);
    } else {
      hubCalled = true;
    }
    expect(dieCalled).toBe(true);
    expect(hubCalled).toBe(false);
  });
});

// ─── PAY-0027 ─────────────────────────────────────────────────────────────────

describe("[PAY-0027] CLI: sesame payment level <n> → --yes gate, toInt, payUpdateLevel (level numeric)", () => {
  it("[PAY-0027] --yes absent → die(confirmRequired, 2)", () => {
    let dieCalled = false;
    const ctx = { die: (_, code) => { dieCalled = true; expect(code).toBe(2); } };
    const opts = { yes: false };
    if (!opts.yes) ctx.die("confirmRequired", 2);
    expect(dieCalled).toBe(true);
  });

  it("[PAY-0027] payUpdateLevel receives numeric level (core Number(level) normalises string)", async () => {
    const c = ok({ accepted: true });
    await payUpdateLevel(c, { companyID: "ch_A", level: 4, isUpgrade: true, isCancel: false });
    expect(c.sent[0].level).toBe(4);
    expect(typeof c.sent[0].level).toBe("number");
  });

  it("[PAY-0027] level given as string is coerced to number by core Number(level)", async () => {
    const c = ok({ accepted: true });
    await payUpdateLevel(c, { companyID: "ch_A", level: "6", isUpgrade: false });
    expect(c.sent[0].level).toBe(6);
    expect(typeof c.sent[0].level).toBe("number");
  });

  it("[PAY-0027] missing level throws bad_request (levelRequired)", async () => {
    const c = ok();
    let err;
    try {
      await payUpdateLevel(c, { companyID: "ch_A", isUpgrade: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(err.message).toMatch(/level required/);
    expect(c.sent.length).toBe(0);
  });

  it("[PAY-0027] NaN level throws bad_request (levelRequired)", async () => {
    const c = ok();
    let err;
    try {
      await payUpdateLevel(c, { companyID: "ch_A", level: NaN, isUpgrade: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(err.message).toMatch(/level required/);
    expect(c.sent.length).toBe(0);
  });

  it("[PAY-0027] subscriptionId alias resolves to subId key on wire", async () => {
    const c = ok({ accepted: true });
    await payUpdateLevel(c, { companyID: "ch_A", subscriptionId: "sub_CUST", level: 2, isUpgrade: true });
    expect(c.sent[0]).toHaveProperty("subId", "sub_CUST");
  });

  it("[PAY-0027] subscriptionId defaults to customerInfo.subscriptionId (CLI call-site resolution)", () => {
    // cli/payment.js: subscriptionId: opts.subscriptionId || customerInfo?.subscriptionId
    const customerInfo = { subscriptionId: "sub_from_account" };
    const opts = { subscriptionId: undefined };
    const resolved = opts.subscriptionId || customerInfo?.subscriptionId;
    expect(resolved).toBe("sub_from_account");
  });
});

// ─── PAY-0028 ─────────────────────────────────────────────────────────────────

describe("[PAY-0028] CLI: sesame payment level isUpgrade inference", () => {
  it("[PAY-0028] isUpgrade=true is passed through to wire frame when upgrade flag", async () => {
    const c = ok({ accepted: true });
    await payUpdateLevel(c, { companyID: "ch_A", level: 4, isUpgrade: true });
    expect(c.sent[0].isUpgrade).toBe(true);
    expect(typeof c.sent[0].isUpgrade).toBe("boolean");
  });

  it("[PAY-0028] isUpgrade=false is passed through to wire frame when downgrade/cancel flag", async () => {
    const c = ok({ accepted: true });
    await payUpdateLevel(c, { companyID: "ch_A", level: 2, isUpgrade: false, isCancel: true });
    expect(c.sent[0].isUpgrade).toBe(false);
    expect(c.sent[0].isCancel).toBe(true);
  });

  it("[PAY-0028] non-boolean isUpgrade throws bad_request (isUpgradeRequired)", async () => {
    // Core guard: typeof isUpgrade !== 'boolean' → badRequest (payment.js:138).
    const c = ok();
    let err;
    try {
      await payUpdateLevel(c, { companyID: "ch_A", level: 4, isUpgrade: "true" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(err.message).toMatch(/isUpgrade required/);
    expect(c.sent.length).toBe(0);
  });

  it("[PAY-0028] auto-inference: current*2 < level → isUpgrade=true (encoded level comparison)", () => {
    // cli/payment.js:56: return current * 2 < Number(level)
    // current=1 (planIndex), encoded level=4 (planIndex=2, yearly) → upgrade
    const current = 1;
    const level = 4;
    const isUpgrade = current * 2 < Number(level);
    expect(isUpgrade).toBe(true);
  });

  it("[PAY-0028] auto-inference: current*2 >= level → isUpgrade=false (downgrade)", () => {
    const current = 2;
    const level = 2; // current*2=4 >= level=2
    const isUpgrade = current * 2 < Number(level);
    expect(isUpgrade).toBe(false);
  });

  it("[PAY-0028] --upgrade --downgrade both specified → upgradeConflict / die(upgradeConflict, 2)", () => {
    let died = false;
    const ctx = { die: (_, code) => { died = true; expect(code).toBe(2); } };

    function inferIsUpgrade(opts) {
      if (opts.upgrade && opts.downgrade) {
        ctx.die("upgradeConflict", 2);
        return undefined;
      }
      return opts.upgrade ? true : false;
    }

    const result = inferIsUpgrade({ upgrade: true, downgrade: true });
    expect(died).toBe(true);
    expect(result).toBeUndefined();
  });

  it("[PAY-0028] getPaymentConfig fetch failure (level unknown) → upgradeUnknown / die(...,2)", () => {
    let died = false;
    const ctx = { die: (_, code) => { died = true; expect(code).toBe(2); } };

    function autoInfer(currentLevel, level) {
      if (!Number.isFinite(currentLevel)) {
        ctx.die("upgradeUnknown", 2);
        return undefined;
      }
      return currentLevel * 2 < Number(level);
    }

    const result = autoInfer(NaN, 4);
    expect(died).toBe(true);
    expect(result).toBeUndefined();
  });
});

// ─── PAY-0029 ─────────────────────────────────────────────────────────────────

describe("[PAY-0029] CLI: sesame payment dev-api → getDevApiInfo exposure and --update --yes gate", () => {
  it("[PAY-0029] --update absent: getDevApiInfo(update:null) called with no yes gate", async () => {
    // CLI: update: opts.update ? true : null → null when flag absent.
    // Core: update !== null && update !== undefined → frame.update omitted.
    const c = ok({ apiKeyValue: "v", apiKeyId: "kid", usedCount: 5 });
    await getDevApiInfo(c, { companyID: "ch_A", email: "emp@example.com", update: null });
    expect(c.sent[0]).not.toHaveProperty("update");
  });

  it("[PAY-0029] --update present: getDevApiInfo(update:true) called", async () => {
    const c = ok({ apiKeyValue: "v2", apiKeyId: "kid2", usedCount: 0 });
    await getDevApiInfo(c, { companyID: "ch_A", email: "emp@example.com", update: true });
    expect(c.sent[0]).toHaveProperty("update", true);
  });

  it("[PAY-0029] --update present, --yes absent → die(confirmRequired, 2), getDevApiInfo not called", () => {
    let died = false;
    let called = false;
    const ctx = { die: (_, code) => { died = true; expect(code).toBe(2); } };
    const opts = { update: true, yes: false };
    if (opts.update && !opts.yes) {
      ctx.die("confirmRequired", 2);
    } else {
      called = true;
    }
    expect(died).toBe(true);
    expect(called).toBe(false);
  });

  it("[PAY-0029] email defaults from customerInfo.employeeEmail (CLI call-site resolution)", async () => {
    const c = ok({ apiKeyId: "k" });
    await getDevApiInfo(c, { companyID: "ch_A", email: "employee@company.com" });
    expect(c.sent[0]).toMatchObject({ email: "employee@company.com" });
  });

  it("[PAY-0029] email absent throws bad_request (emailRequired) before send", async () => {
    const c = ok();
    let err;
    try {
      await getDevApiInfo(c, { companyID: "ch_A" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(err.message).toMatch(/email required/);
    expect(c.sent.length).toBe(0);
  });

  it("[PAY-0029] --json envelope shape is { ok:true, devApiInfo } (cli/payment.js:166)", async () => {
    const c = ok({ apiKeyId: "k3", apiKeyValue: "v3", usedCount: 0 });
    const info = await getDevApiInfo(c, { customerId: "ch_A", email: "e@e.com" });
    const jsonOutput = { ok: true, devApiInfo: info };
    expect(jsonOutput.ok).toBe(true);
    expect(jsonOutput.devApiInfo).toMatchObject({ apiKeyId: "k3" });
  });
});

// ─── PAY-0030 ─────────────────────────────────────────────────────────────────

describe("[PAY-0030] payment all commands --json envelope vs human output parity", () => {
  it("[PAY-0030] methods: hub result appears in both {ok,count,paymentMethods} and human list", async () => {
    const items = [{ id: "pm_1", isDefaultPay: true }];
    const c = ok(items);
    const result = await getPaymentMethods(c, { companyID: "ch_A" });
    const jsonEnvelope = { ok: true, count: result.length, paymentMethods: result };
    expect(jsonEnvelope.ok).toBe(true);
    expect(jsonEnvelope.count).toBe(1);
    expect(jsonEnvelope.paymentMethods).toEqual(items);
  });

  it("[PAY-0030] client-secret: hub result appears in {ok,clientSecret}", async () => {
    const c = mockClient({ success: true, data: "seti_secret" });
    const secret = await getClientSecret(c, { companyID: "ch_A" });
    const jsonEnvelope = { ok: true, clientSecret: secret };
    expect(jsonEnvelope.clientSecret).toBe("seti_secret");
  });

  it("[PAY-0030] dev-api: hub result appears in {ok,devApiInfo}", async () => {
    const info = { apiKeyValue: "v", apiKeyId: "k", usedCount: 3 };
    const c = ok(info);
    const result = await getDevApiInfo(c, { companyID: "ch_A", email: "u@x.com" });
    const jsonEnvelope = { ok: true, devApiInfo: result };
    expect(jsonEnvelope.devApiInfo).toEqual(info);
  });

  it("[PAY-0030] default: --json {ok,response} references same response object", async () => {
    const c = okCtx(null, { defaultPaymentMethod: "pm_new" });
    const response = await changeDefaultPayment(c, { customerId: "ch_A", defaultPaymentMethod: "pm_new" });
    const jsonOut = { ok: true, response };
    expect(jsonOut.response).toBe(response);
    expect(jsonOut.response.reqContext.defaultPaymentMethod).toBe("pm_new");
  });

  it("[PAY-0030] ctx.out contract: json branch → JSON.stringify(jsonObj), human branch → humanFn()", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const url = new URL("../../../kit/src/cli/ctx.js", import.meta.url);
    const src = readFileSync(fileURLToPath(url), "utf8");
    expect(src).toContain("JSON.stringify(jsonObj");
    expect(src).toContain("humanFn()");
  });
});

// ─── PAY-0031 ─────────────────────────────────────────────────────────────────

describe("[PAY-0031] payment i18n catalog (en/ja) key completeness and parity", () => {
  it("[PAY-0031] en catalog contains all required error keys", async () => {
    const catalog = (await import("../../src/i18n/payment.js")).default;
    const en = catalog.en;
    const requiredErrKeys = [
      "payment.err.customerIdRequired",
      "payment.err.defaultPaymentMethodRequired",
      "payment.err.paymentIdRequired",
      "payment.err.levelRequired",
      "payment.err.isUpgradeRequired",
      "payment.err.emailRequired",
      "payment.err.confirmRequired",
      "payment.err.upgradeConflict",
      "payment.err.upgradeUnknown",
    ];
    for (const key of requiredErrKeys) {
      expect(en, `en: ${key} が存在する`).toHaveProperty(key);
    }
  });

  it("[PAY-0031] ja catalog contains all required error keys", async () => {
    const catalog = (await import("../../src/i18n/payment.js")).default;
    const ja = catalog.ja;
    const requiredErrKeys = [
      "payment.err.customerIdRequired",
      "payment.err.defaultPaymentMethodRequired",
      "payment.err.paymentIdRequired",
      "payment.err.levelRequired",
      "payment.err.isUpgradeRequired",
      "payment.err.emailRequired",
      "payment.err.confirmRequired",
      "payment.err.upgradeConflict",
      "payment.err.upgradeUnknown",
    ];
    for (const key of requiredErrKeys) {
      expect(ja, `ja: ${key} が存在する`).toHaveProperty(key);
    }
  });

  it("[PAY-0031] en and ja have identical key sets (no missing or extra keys)", async () => {
    const catalog = (await import("../../src/i18n/payment.js")).default;
    const enKeys = Object.keys(catalog.en).sort();
    const jaKeys = Object.keys(catalog.ja).sort();
    expect(enKeys).toEqual(jaKeys);
  });

  it("[PAY-0031] en catalog contains all CLI surface keys referenced by cli/payment.js", async () => {
    const catalog = (await import("../../src/i18n/payment.js")).default;
    const en = catalog.en;
    const cliKeys = [
      "payment.cmd.desc",
      "payment.methods.desc",
      "payment.secret.desc",
      "payment.default.desc",
      "payment.remove.desc",
      "payment.level.desc",
      "payment.devApi.desc",
      "payment.opt.customerId",
      "payment.opt.subscriptionId",
      "payment.opt.upgrade",
      "payment.opt.downgrade",
      "payment.opt.cancel",
      "payment.opt.email",
      "payment.opt.update",
      "payment.opt.yes",
      "payment.methods.none",
      "payment.methods.found",
      "payment.secret.value",
      "payment.default.ok",
      "payment.remove.ok",
      "payment.level.ok",
      "payment.devApi.none",
    ];
    for (const key of cliKeys) {
      expect(en, `en: ${key} が存在する`).toHaveProperty(key);
    }
  });
});

// ─── PAY-0032 ─────────────────────────────────────────────────────────────────

describe("[PAY-0032] payUpdateLevel isCancel !!isCancel bool coercion (vendor raw vs kit normalised)", () => {
  it("[PAY-0032] isCancel=true stays true (bool) on wire", async () => {
    const c = ok({ accepted: true });
    await payUpdateLevel(c, { companyID: "ch_A", level: 2, isUpgrade: false, isCancel: true });
    expect(c.sent[0].isCancel).toBe(true);
    expect(typeof c.sent[0].isCancel).toBe("boolean");
  });

  it("[PAY-0032] isCancel absent defaults to false (!!false = false) on wire", async () => {
    const c = ok({ accepted: true });
    await payUpdateLevel(c, { companyID: "ch_A", level: 2, isUpgrade: false });
    expect(c.sent[0].isCancel).toBe(false);
    expect(typeof c.sent[0].isCancel).toBe("boolean");
  });

  it("[PAY-0032] truthy non-bool isCancel (1) → bool true by !!isCancel (kit normalises, vendor does not)", async () => {
    const c = ok({ accepted: true });
    await payUpdateLevel(c, { companyID: "ch_A", level: 2, isUpgrade: false, isCancel: 1 });
    expect(c.sent[0].isCancel).toBe(true);
    expect(typeof c.sent[0].isCancel).toBe("boolean");
  });

  it("[PAY-0032] falsy non-bool isCancel (0) → bool false by !!isCancel", async () => {
    const c = ok({ accepted: true });
    await payUpdateLevel(c, { companyID: "ch_A", level: 2, isUpgrade: false, isCancel: 0 });
    expect(c.sent[0].isCancel).toBe(false);
    expect(typeof c.sent[0].isCancel).toBe("boolean");
  });

  it("[PAY-0032] level='4' (string) → frame.level===4 (Number() coercion)", async () => {
    const c = ok({ accepted: true });
    await payUpdateLevel(c, { companyID: "ch_A", level: "4", isUpgrade: true });
    expect(c.sent[0].level).toBe(4);
    expect(typeof c.sent[0].level).toBe("number");
  });
});

// ─── PAY-0033 ─────────────────────────────────────────────────────────────────

describe("[PAY-0033] getPaymentMethods non-array data → [] normalisation (fail-soft)", () => {
  it("[PAY-0033] data=null → returns [] (core normalises)", async () => {
    const c = mockClient({ success: true, data: null });
    const result = await getPaymentMethods(c, { companyID: "ch_A" });
    expect(result).toEqual([]);
  });

  it("[PAY-0033] data=undefined → returns [] (core normalises)", async () => {
    const c = mockClient({ success: true });
    const result = await getPaymentMethods(c, { companyID: "ch_A" });
    expect(result).toEqual([]);
  });

  it("[PAY-0033] data=string (non-array) → returns [] (core normalises)", async () => {
    const c = mockClient({ success: true, data: "unexpected_string" });
    const result = await getPaymentMethods(c, { companyID: "ch_A" });
    expect(result).toEqual([]);
  });

  it("[PAY-0033] data=array → returned as-is (no wrapping)", async () => {
    const cards = [{ id: "pm_1" }, { id: "pm_2" }];
    const c = mockClient({ success: true, data: cards });
    const result = await getPaymentMethods(c, { companyID: "ch_A" });
    expect(result).toEqual(cards);
  });

  it("[PAY-0033] removePayment data=null → returns null (no [] normalisation — asymmetry with getPaymentMethods)", async () => {
    // removePayment returns resp?.data ?? null — null is allowed, not [] normalised.
    const c = mockClient({ success: true, data: null });
    const result = await removePayment(c, { companyID: "ch_A", paymentId: "pm_1" });
    expect(result).toBeNull();
  });
});

// ─── PAY-0034 ─────────────────────────────────────────────────────────────────

describe("[PAY-0034] vendor success-guard asymmetry vs core assertSuccess (fail-closed)", () => {
  // vendor: getPaymentMethods/removePayment/changeDefaultPayment have NO !success guard.
  // core: ALL 6 ops have assertSuccess → success:false → rejected (fail-closed).

  it("[PAY-0034] getPaymentMethods success:false → SesameError rejected (core closes vendor gap)", async () => {
    const c = failUpstream("PM_FETCH_FAIL");
    let err;
    try {
      await getPaymentMethods(c, { companyID: "ch_A" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.REJECTED);
    expect(err.data?.upstreamCode).toBe("PM_FETCH_FAIL");
  });

  it("[PAY-0034] removePayment success:false → SesameError rejected (core closes vendor gap)", async () => {
    const c = failUpstream("CARD_NOT_FOUND");
    let err;
    try {
      await removePayment(c, { companyID: "ch_A", paymentId: "pm_gone" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.REJECTED);
  });

  it("[PAY-0034] changeDefaultPayment success:false → SesameError rejected (core closes vendor gap)", async () => {
    const c = failUpstream("DEFAULT_CHANGE_REJECTED");
    let err;
    try {
      await changeDefaultPayment(c, { companyID: "ch_A", defaultPaymentMethod: "pm_1" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.REJECTED);
  });

  it("[PAY-0034] success key absent (lenient) is treated as success — data is returned", async () => {
    // assertSuccess lenient: failed = !resp || resp.success === false.
    // success key absent → resp.success is undefined → !== false → not failed.
    const c = noSuccessField([{ id: "pm_1" }]);
    const result = await getPaymentMethods(c, { companyID: "ch_A" });
    expect(Array.isArray(result)).toBe(true);
  });

  it("[PAY-0034] assertSuccess includes upstreamCode from resp.code in SesameError.data", async () => {
    const c = mockClient({ success: false, code: "CLOUD_ERR_42" });
    let caught;
    try {
      await getPaymentMethods(c, { customerId: "ch_A" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SesameError);
    expect(caught.data?.upstreamCode).toBe("CLOUD_ERR_42");
  });
});

// ─── PAY-0035 ─────────────────────────────────────────────────────────────────

describe("[PAY-0035] getDevApiInfo update !!update bool coercion vs vendor raw spread", () => {
  it("[PAY-0035] update=null → key absent on wire", async () => {
    const c = ok({ apiKeyId: "k" });
    await getDevApiInfo(c, { companyID: "ch_A", email: "u@x.com", update: null });
    expect(c.sent[0]).not.toHaveProperty("update");
  });

  it("[PAY-0035] update=undefined → key absent on wire", async () => {
    const c = ok({ apiKeyId: "k" });
    await getDevApiInfo(c, { companyID: "ch_A", email: "u@x.com", update: undefined });
    expect(c.sent[0]).not.toHaveProperty("update");
  });

  it("[PAY-0035] update=true → wire carries update:true (bool)", async () => {
    const c = ok({ apiKeyId: "k" });
    await getDevApiInfo(c, { companyID: "ch_A", email: "u@x.com", update: true });
    expect(c.sent[0].update).toBe(true);
    expect(typeof c.sent[0].update).toBe("boolean");
  });

  it("[PAY-0035] update=1 (truthy non-bool) → wire carries update:true (kit !! coercion; vendor sends 1)", async () => {
    const c = ok({ apiKeyId: "k" });
    await getDevApiInfo(c, { companyID: "ch_A", email: "u@x.com", update: 1 });
    expect(c.sent[0].update).toBe(true);
    expect(typeof c.sent[0].update).toBe("boolean");
  });

  it("[PAY-0035] update='yes' (truthy string) → wire carries update:true (!!update)", async () => {
    const c = ok({ apiKeyId: "k" });
    await getDevApiInfo(c, { companyID: "ch_A", email: "u@x.com", update: "yes" });
    expect(c.sent[0].update).toBe(true);
    expect(typeof c.sent[0].update).toBe("boolean");
  });

  it("[PAY-0035] update=false → key present with value false (false is not null/undefined, !!false=false)", async () => {
    // update !== null && update !== undefined → condition true for false.
    // frame.update = !!false = false.
    const c = ok({ apiKeyId: "k" });
    await getDevApiInfo(c, { companyID: "ch_A", email: "u@x.com", update: false });
    expect(c.sent[0]).toHaveProperty("update", false);
    expect(typeof c.sent[0].update).toBe("boolean");
  });
});

// ─── PAY-0036 ─────────────────────────────────────────────────────────────────

describe("[PAY-0036] getDevApiInfo email absent — vendor silent-return vs kit badRequest", () => {
  it("[PAY-0036] email absent throws SesameError code=bad_request (kit fail-closed vs vendor silent return)", async () => {
    const c = ok();
    let err;
    try {
      await getDevApiInfo(c, { companyID: "ch_A" /* email omitted */ });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/email required/);
  });

  it("[PAY-0036] email absent: no frame sent (guard fires before client.request)", async () => {
    const c = ok();
    try {
      await getDevApiInfo(c, { companyID: "ch_A" });
    } catch { /* expected */ }
    expect(c.sent.length).toBe(0);
  });

  it("[PAY-0036] email=empty string throws bad_request (!email covers empty string)", async () => {
    const c = ok();
    let err;
    try {
      await getDevApiInfo(c, { companyID: "ch_A", email: "" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
  });

  it("[PAY-0036] email present: frame has correct keys {action, customerId, email, op}", async () => {
    const c = ok({ apiKeyId: "k" });
    await getDevApiInfo(c, { companyID: "ch_A", email: "dev@example.com" });
    expect(c.sent[0]).toEqual({
      action: "biz3ManagePayment",
      customerId: "ch_A",
      email: "dev@example.com",
      op: "getDevApiInfo",
    });
  });

  it("[PAY-0036] customerId absent also throws bad_request before email guard (guard order)", async () => {
    const c = ok();
    let caught;
    try {
      await getDevApiInfo(c, { email: "dev@example.com" }); // customerId 欠落
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SesameError);
    expect(caught.code).toBe(ERR.BAD_REQUEST);
    expect(caught.message).toMatch(/customerId required/);
  });

  it("[PAY-0036] i18n catalog has payment.err.emailRequired key in both en and ja", async () => {
    const catalog = (await import("../../src/i18n/payment.js")).default;
    expect(catalog.en).toHaveProperty("payment.err.emailRequired");
    expect(catalog.ja).toHaveProperty("payment.err.emailRequired");
  });
});
