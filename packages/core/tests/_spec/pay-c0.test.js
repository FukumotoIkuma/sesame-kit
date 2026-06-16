// packages/core/tests/_spec/pay-c0.test.js
// TDD spec tests for PAY-0001 through PAY-0018 (payment domain).
// Implementation: packages/core/src/payment.js
// Reference vendor: references_web/src/api/useStripeInfo.js
//
// 統合方針:
//   - A/B 両実装を比較し、各 spec につきより正しく移植元忠実な方を採用。
//   - import は packages/core/tests/ 内の相対パスに統一。
//   - ネットワーク・実機に触れない。全て mock または純関数。
//   - TDD: 実装が spec と食い違う箇所は spec どおりの期待値を assert (red でよい)。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  getPaymentMethods,
  getClientSecret,
  changeDefaultPayment,
  removePayment,
  payUpdateLevel,
  getDevApiInfo,
  NAMESPACE_OPS,
} from "../../src/payment.js";
import { mockClient } from "../helpers/mock-ws.js";
import { ERR } from "../../src/errors.js";

// ── shared constants ──────────────────────────────────────────────────────────

const ACT = "biz3ManagePayment";

const HERE = dirname(fileURLToPath(import.meta.url));

// Eagerly load static generated files (referenced by PAY-0017 and PAY-0018).
const RPC_PARAMS = JSON.parse(
  readFileSync(resolve(HERE, "../../../kit/src/serve/rpc-params.generated.json"), "utf-8"),
);
const GRPC_MAP = JSON.parse(
  readFileSync(resolve(HERE, "../../../kit/src/serve/grpc-methods.generated.json"), "utf-8"),
);
const PROTO_TEXT = readFileSync(
  resolve(HERE, "../../../kit/src/serve/sesame.proto"),
  "utf-8",
);

// ── local helpers ─────────────────────────────────────────────────────────────

/** mockClient that returns success:true with given data. */
function okClient(data, extra = {}) {
  return mockClient({ success: true, data, ...extra });
}

/** mockClient that returns success:false with optional upstream code. */
function failClient(code = "ERR_UPSTREAM") {
  return mockClient({ success: false, code, message: "upstream error" });
}

// ── PAY-0001: getPaymentMethods フレーム形 + data 戻り ────────────────────────

describe("[PAY-0001] getPaymentMethods → biz3ManagePayment/getPaymentMethods フレーム形", () => {
  it("[PAY-0001] customerId 指定: フレームに customerId、応答 data 配列をそのまま返す", async () => {
    // ref: useStripeInfo.js:100-109; payment.js:37-44
    const data = [{ id: "pm_1" }, { id: "pm_2" }];
    const c = okClient(data);
    const result = await getPaymentMethods(c, { customerId: "cus_explicit" });
    expect(c.sent[0]).toEqual({
      action: ACT,
      customerId: "cus_explicit",
      op: "getPaymentMethods",
    });
    expect(result).toEqual(data);
  });

  it("[PAY-0001] companyID フォールバック: customerId 省略時は companyID を customerId に使う", async () => {
    // ref: useStripeInfo.js:101 — priorityCompanyId を customerId に入れる
    const data = [{ id: "pm_3" }];
    const c = okClient(data);
    const result = await getPaymentMethods(c, { companyID: "ch_fallback" });
    expect(c.sent[0]).toEqual({
      action: ACT,
      customerId: "ch_fallback",
      op: "getPaymentMethods",
    });
    expect(result).toEqual(data);
  });

  it("[PAY-0001] action は 'biz3ManagePayment'、op は 'getPaymentMethods'、余分キーなし", async () => {
    const c = okClient([]);
    await getPaymentMethods(c, { companyID: "ch_A" });
    const frame = c.sent[0];
    expect(Object.keys(frame).sort()).toEqual(["action", "customerId", "op"].sort());
    expect(frame.action).toBe(ACT);
    expect(frame.op).toBe("getPaymentMethods");
  });
});

// ── PAY-0002: getClientSecret フレーム形と data 戻り ─────────────────────────

describe("[PAY-0002] getClientSecret → biz3ManagePayment/getClientSecret フレーム形と data 戻り", () => {
  it("[PAY-0002] フレームが {action,customerId,op:'getClientSecret'} で余分キー(defaultPaymentMethod等)なし", async () => {
    // ref: useStripeInfo.js:221-235; payment.js:56-63
    // vendor msgData は customerId,op のみ (useStripeInfo.js:226-230)
    const c = okClient("seti_xxx_secret");
    await getClientSecret(c, { customerId: "cus_A" });
    const frame = c.sent[0];
    expect(frame).toEqual({
      action: ACT,
      customerId: "cus_A",
      op: "getClientSecret",
    });
    expect(frame).not.toHaveProperty("defaultPaymentMethod");
  });

  it("[PAY-0002] 応答 data (SetupIntent client secret 文字列) を返す", async () => {
    const c = okClient("seti_secret_str");
    const result = await getClientSecret(c, { customerId: "cus_A" });
    expect(result).toBe("seti_secret_str");
  });

  it("[PAY-0002] 応答 data 欠落(null/undefined)なら null を返す (resp?.data ?? null)", async () => {
    // ref: payment.js:62 — resp?.data ?? null
    const c1 = okClient(null);
    expect(await getClientSecret(c1, { customerId: "cus_A" })).toBeNull();

    const c2 = mockClient({ success: true });
    expect(await getClientSecret(c2, { customerId: "cus_A" })).toBeNull();
  });

  it("[PAY-0002] companyID フォールバック: customerId 省略時は companyID を使う", async () => {
    const c = okClient("seti_fallback");
    await getClientSecret(c, { companyID: "ch_fallback" });
    expect(c.sent[0].customerId).toBe("ch_fallback");
  });
});

// ── PAY-0003: changeDefaultPayment フレーム形 ─────────────────────────────────

describe("[PAY-0003] changeDefaultPayment → defaultPaymentMethod を含むフレーム形", () => {
  it("[PAY-0003] フレームが {action,customerId,defaultPaymentMethod,op:'changeDefaultPayment'} でキー集合が vendor と一致", async () => {
    // ref: useStripeInfo.js:237-250; payment.js:79-92
    // vendor changeDefaultPay msgData キー: action,customerId,defaultPaymentMethod,op (useStripeInfo.js:241-245)
    const c = mockClient({ success: true, data: null, reqContext: {} });
    await changeDefaultPayment(c, {
      customerId: "cus_A",
      defaultPaymentMethod: "pm_card_visa",
    });
    expect(c.sent[0]).toEqual({
      action: ACT,
      customerId: "cus_A",
      defaultPaymentMethod: "pm_card_visa",
      op: "changeDefaultPayment",
    });
  });

  it("[PAY-0003] action='biz3ManagePayment'、op='changeDefaultPayment'、4キーのみ", async () => {
    const c = mockClient({ success: true, data: null, reqContext: {} });
    await changeDefaultPayment(c, { companyID: "ch_A", defaultPaymentMethod: "pm_1" });
    const frame = c.sent[0];
    expect(Object.keys(frame).sort()).toEqual(
      ["action", "customerId", "defaultPaymentMethod", "op"].sort(),
    );
    expect(frame.action).toBe(ACT);
    expect(frame.op).toBe("changeDefaultPayment");
    expect(frame.defaultPaymentMethod).toBe("pm_1");
  });

  it("[PAY-0003] companyID フォールバック: customerId 省略時は companyID を customerId に使う", async () => {
    const c = mockClient({ success: true, data: null, reqContext: {} });
    await changeDefaultPayment(c, { companyID: "ch_fallback", defaultPaymentMethod: "pm_2" });
    expect(c.sent[0].customerId).toBe("ch_fallback");
  });
});

// ── PAY-0004: changeDefaultPayment が reqContext を破棄せず返す ──────────────

describe("[PAY-0004] changeDefaultPayment が応答 reqContext を破棄せず返す (vendor 消費キー保持)", () => {
  // ref: useStripeInfo.js:123-135; payment.js:84-91
  // vendor は message.reqContext.defaultPaymentMethod を読む (:124,:129)
  // kit は return {data, reqContext} (:91)

  it("[PAY-0004] reqContext あり: 戻り値 {data, reqContext} 形で reqContext.defaultPaymentMethod が到達する", async () => {
    const reqContext = { defaultPaymentMethod: "pm_card_mastercard" };
    const c = mockClient({ success: true, data: null, reqContext });
    const result = await changeDefaultPayment(c, {
      companyID: "ch_A",
      defaultPaymentMethod: "pm_card_mastercard",
    });
    expect(result).toHaveProperty("reqContext");
    expect(result.reqContext).toEqual(reqContext);
    expect(result.reqContext.defaultPaymentMethod).toBe("pm_card_mastercard");
  });

  it("[PAY-0004] data フィールドも含まれる ({data,reqContext} の両方が戻る)", async () => {
    const dataPayload = { something: true };
    const reqContext = { defaultPaymentMethod: "pm_z" };
    const c = mockClient({ success: true, data: dataPayload, reqContext });
    const result = await changeDefaultPayment(c, {
      companyID: "ch_A",
      defaultPaymentMethod: "pm_z",
    });
    expect(result.data).toEqual(dataPayload);
    expect(result.reqContext).toEqual(reqContext);
  });

  it("[PAY-0004] reqContext なし: 戻り値は {data, reqContext} shape (reqContext=undefined 許容)", async () => {
    const c = mockClient({ success: true, data: null });
    const result = await changeDefaultPayment(c, {
      companyID: "ch_A",
      defaultPaymentMethod: "pm_y",
    });
    // reqContext を data に潰さない
    expect(result).toHaveProperty("data");
    expect(result).toHaveProperty("reqContext");
    expect(result.data).toBeNull();
  });

  it("[PAY-0004] reqContext あり / なし どちらの分岐も reqContext キーを持つ", async () => {
    const c1 = mockClient({ success: true, data: null, reqContext: { defaultPaymentMethod: "pm_z" } });
    const r1 = await changeDefaultPayment(c1, { companyID: "ch_A", defaultPaymentMethod: "pm_z" });
    expect("reqContext" in r1).toBe(true);

    const c2 = mockClient({ success: true, data: null });
    const r2 = await changeDefaultPayment(c2, { companyID: "ch_A", defaultPaymentMethod: "pm_z" });
    expect("reqContext" in r2).toBe(true);
  });
});

// ── PAY-0005: removePayment フレーム形 ───────────────────────────────────────

describe("[PAY-0005] removePayment → paymentId+customerId を含むフレーム形", () => {
  it("[PAY-0005] フレームが {action,customerId,paymentId,op:'removePayment'} でキー集合が vendor delCard と一致", async () => {
    // ref: useStripeInfo.js:252-264; payment.js:104-112
    // vendor delCard キー集合={action,paymentId,customerId,op}
    const c = okClient([{ id: "pm_2" }]);
    const result = await removePayment(c, { companyID: "ch_A", paymentId: "pm_1" });
    expect(c.sent[0]).toMatchObject({
      action: ACT,
      customerId: "ch_A",
      paymentId: "pm_1",
      op: "removePayment",
    });
    expect(Object.keys(c.sent[0]).sort()).toEqual(
      ["action", "customerId", "op", "paymentId"].sort(),
    );
    // 応答 data を返す
    expect(result).toEqual([{ id: "pm_2" }]);
  });

  it("[PAY-0005] 応答 data null → null を返す (removePayment は null 許容)", async () => {
    const c = mockClient({ success: true, data: null });
    const result = await removePayment(c, { companyID: "ch_A", paymentId: "pm_x" });
    expect(result).toBeNull();
  });

  it("[PAY-0005] companyID フォールバック: companyID を customerId に使う", async () => {
    const c = okClient([]);
    await removePayment(c, { companyID: "ch_fallback", paymentId: "pm_1" });
    expect(c.sent[0].customerId).toBe("ch_fallback");
  });
});

// ── PAY-0006: payUpdateLevel フレーム形 ──────────────────────────────────────

describe("[PAY-0006] payUpdateLevel → subId/isUpgrade/level/isCancel/customerId のフレーム形", () => {
  it("[PAY-0006] フレームが {action,isUpgrade,level,isCancel,customerId,op:'payUpdateLevel',subId} でキー集合が vendor updateLevel と一致", async () => {
    // ref: useStripeInfo.js:200-219; payment.js:129-146
    // vendor updateLevel msgData キー集合=action,subId,isUpgrade,level,isCancel,customerId,op (useStripeInfo.js:206-214)
    const c = okClient({ accepted: true });
    await payUpdateLevel(c, {
      companyID: "ch_A",
      subId: "sub_1",
      level: 4,
      isUpgrade: true,
      isCancel: false,
    });
    const frame = c.sent[0];
    expect(frame).toMatchObject({
      action: ACT,
      subId: "sub_1",
      isUpgrade: true,
      level: 4,
      isCancel: false,
      customerId: "ch_A",
      op: "payUpdateLevel",
    });
    expect(frame.action).toBe(ACT);
    expect(frame.op).toBe("payUpdateLevel");
    expect(typeof frame.isCancel).toBe("boolean");
    expect(frame.isCancel).toBe(false);
    expect(typeof frame.level).toBe("number");
    expect(frame.level).toBe(4);
  });

  it("[PAY-0006] isCancel 未指定(既定 false): フレームに isCancel:false が入る", async () => {
    const c = okClient(null);
    await payUpdateLevel(c, {
      companyID: "ch_A",
      subId: "sub_2",
      level: 2,
      isUpgrade: false,
    });
    expect(c.sent[0].isCancel).toBe(false);
  });

  it("[PAY-0006] level は数値として送られる (encoded biz3 level)", async () => {
    const c = okClient(null);
    await payUpdateLevel(c, { companyID: "ch_A", subId: "sub_3", level: 6, isUpgrade: true });
    expect(typeof c.sent[0].level).toBe("number");
    expect(c.sent[0].level).toBe(6);
  });
});

// ── PAY-0007: payUpdateLevel が subId 未定義時にキー省略 ─────────────────────

describe("[PAY-0007] payUpdateLevel が subscriptionId 未定義時に subId キーを省く (Free 会社初回 upgrade)", () => {
  // ref: useStripeInfo.js:200-205; payment.js:135-142
  // vendor の undefined は JSON.stringify で落ちる挙動の 1:1
  it("[PAY-0007] subId/subscriptionId 無し(Free 会社): フレームに subId キーが現れない", async () => {
    const c = okClient({ accepted: true });
    await payUpdateLevel(c, {
      companyID: "ch_A",
      level: 2,
      isUpgrade: true,
    });
    expect(c.sent[0]).not.toHaveProperty("subId");
    expect(c.sent[0]).toEqual({
      action: ACT,
      isUpgrade: true,
      level: 2,
      isCancel: false,
      customerId: "ch_A",
      op: "payUpdateLevel",
    });
  });

  it("[PAY-0007] subId 指定あり: フレームに subId が含まれる", async () => {
    const c = okClient({ accepted: true });
    await payUpdateLevel(c, {
      companyID: "ch_A",
      subId: "sub_abc",
      level: 4,
      isUpgrade: true,
    });
    expect(c.sent[0]).toHaveProperty("subId", "sub_abc");
  });

  it("[PAY-0007] subscriptionId で渡しても subId として解決される", async () => {
    // ref: payment.js:135 — subId = params.subId || params.subscriptionId
    const c = okClient({ accepted: true });
    await payUpdateLevel(c, {
      companyID: "ch_A",
      subscriptionId: "sub_via_alias",
      level: 2,
      isUpgrade: false,
    });
    expect(c.sent[0]).toHaveProperty("subId", "sub_via_alias");
  });
});

// ── PAY-0008: level は encoded biz3 level として Number() 正規化で送る ────────

describe("[PAY-0008] payUpdateLevel の level は encoded biz3 level として Number() 正規化送出", () => {
  // ref: payment.js:140 — level: Number(level)
  it("[PAY-0008] level=number: wire 上も number のまま透過送出", async () => {
    const c = okClient(null);
    await payUpdateLevel(c, { companyID: "ch_A", level: 5, isUpgrade: true });
    expect(typeof c.sent[0].level).toBe("number");
    expect(c.sent[0].level).toBe(5);
  });

  it("[PAY-0008] level=string 入力: core が Number() で JSON number に正規化する (vendor は raw 送出で非対称)", async () => {
    // kit 側のみ Number() 正規化 (入力寛容化); CLI 経路は toInt で number 化済み
    const c = okClient(null);
    await payUpdateLevel(c, {
      companyID: "ch_A",
      level: /** @type {any} */ ("6"),
      isUpgrade: false,
    });
    expect(typeof c.sent[0].level).toBe("number");
    expect(c.sent[0].level).toBe(6);
  });
});

// ── PAY-0009: getDevApiInfo フレーム形 ───────────────────────────────────────

describe("[PAY-0009] getDevApiInfo → customerId+email を含むフレーム形", () => {
  // ref: useStripeInfo.js:273-291; useStripeInfo.js:117-119; payment.js:158-168
  it("[PAY-0009] フレームが {action,customerId,email,op:'getDevApiInfo'} で vendor getDevApiInfo と一致", async () => {
    const c = okClient({ apiKeyValue: "key_val", apiKeyId: "key_id", usedCount: 3 });
    const result = await getDevApiInfo(c, {
      customerId: "cus_A",
      email: "owner@example.com",
    });
    expect(c.sent[0]).toEqual({
      action: ACT,
      customerId: "cus_A",
      email: "owner@example.com",
      op: "getDevApiInfo",
    });
    expect(result).toMatchObject({
      apiKeyValue: "key_val",
      apiKeyId: "key_id",
      usedCount: 3,
    });
  });

  it("[PAY-0009] フレームのキー集合 = {action,customerId,email,op} (update なし時)", async () => {
    const c = okClient({ apiKeyId: "k1" });
    await getDevApiInfo(c, { companyID: "ch_A", email: "dev@example.com" });
    expect(Object.keys(c.sent[0]).sort()).toEqual(
      ["action", "customerId", "email", "op"].sort(),
    );
  });

  it("[PAY-0009] companyID フォールバック: customerId 省略時は companyID を使う", async () => {
    const c = okClient({ apiKeyId: "k1" });
    await getDevApiInfo(c, { companyID: "ch_fallback", email: "dev@example.com" });
    expect(c.sent[0].customerId).toBe("ch_fallback");
  });
});

// ── PAY-0010: getDevApiInfo の update キーは要求時のみ付与 ───────────────────

describe("[PAY-0010] getDevApiInfo の update キーは要求時のみフレームに付与", () => {
  // ref: useStripeInfo.js:285-287; payment.js:159-165
  // vendor は isUpdate!==null のときのみ {...msgData, update:isUpdate} とスプレッド
  it("[PAY-0010] update=null/undefined: update キーがフレームに現れない", async () => {
    // update 未指定 (null デフォルト)
    const c1 = okClient({ apiKeyId: "k1" });
    await getDevApiInfo(c1, { companyID: "ch_A", email: "a@b.com" });
    expect(c1.sent[0]).not.toHaveProperty("update");

    // update を明示的に null で渡す
    const c2 = okClient({ apiKeyId: "k1" });
    await getDevApiInfo(c2, { companyID: "ch_A", email: "a@b.com", update: null });
    expect(c2.sent[0]).not.toHaveProperty("update");

    // update を明示的に undefined で渡す
    const c3 = okClient({ apiKeyId: "k1" });
    await getDevApiInfo(c3, { companyID: "ch_A", email: "a@b.com", update: undefined });
    expect(c3.sent[0]).not.toHaveProperty("update");
  });

  it("[PAY-0010] update=true: フレームに update:true が付く", async () => {
    const c = okClient({ apiKeyId: "k2" });
    await getDevApiInfo(c, { companyID: "ch_A", email: "a@b.com", update: true });
    expect(c.sent[0]).toHaveProperty("update", true);
  });

  it("[PAY-0010] update=false: フレームに update:false が付く (falsy=false でも明示付与)", async () => {
    // ref: payment.js:165 — update!==null && update!==undefined の条件
    const c = okClient({ apiKeyId: "k3" });
    await getDevApiInfo(c, { companyID: "ch_A", email: "a@b.com", update: false });
    expect(c.sent[0]).toHaveProperty("update", false);
  });
});

// ── PAY-0011: getDevApiInfo の応答 apiKeyId が webapi 連携の入力になる ────────

describe("[PAY-0011] getDevApiInfo の応答 apiKeyId が後続 biz3InvokeWebAPIs フレームの apiKeyId として消費される契約", () => {
  // ref: useStripeInfo.js:116-120; useDeveloper.js:45-58; payment.js:156-168
  it("[PAY-0011] 応答 data.apiKeyId フィールド名が vendor setApiKey と一致する契約", async () => {
    const c = okClient({ apiKeyValue: "sk_live_xxx", apiKeyId: "keyid_abc", usedCount: 0 });
    const result = await getDevApiInfo(c, { companyID: "ch_A", email: "dev@x.com" });
    // vendor は getDevApiInfo 応答 data から apiKeyId を setApiKey で記憶し
    // useDeveloper.invokeAPI で apiKeyId として WEBAPI フレームに載せる
    expect(result).toHaveProperty("apiKeyId");
    expect(result.apiKeyId).toBe("keyid_abc");
    expect(result).toHaveProperty("apiKeyValue");
  });

  it("[PAY-0011] getDevApiInfo 応答の apiKeyId が文字列として取り出せる", async () => {
    const c = okClient({ apiKeyValue: "v2_key", apiKeyId: "kid_abc123", usedCount: 5 });
    const result = await getDevApiInfo(c, { companyID: "ch_B", email: "admin@example.com" });
    expect(typeof result.apiKeyId).toBe("string");
  });
});

// ── PAY-0012: customerIdOf フォールバック ────────────────────────────────────

describe("[PAY-0012] customerIdOf フォールバック (customerId 優先, companyID 既定)", () => {
  // ref: payment.js:22-25
  it("[PAY-0012] customerId 指定: フレームの customerId に params.customerId が使われる", async () => {
    const c = okClient([]);
    await getPaymentMethods(c, { customerId: "explicit_cus", companyID: "should_not_use" });
    expect(c.sent[0].customerId).toBe("explicit_cus");
  });

  it("[PAY-0012] customerId 無し / companyID のみ: フレームの customerId に companyID が使われる", async () => {
    const c = okClient([]);
    await getPaymentMethods(c, { companyID: "fallback_company" });
    expect(c.sent[0].customerId).toBe("fallback_company");
  });

  it("[PAY-0012] 両欠落(customerId も companyID もなし): customerIdRequired エラーを投げる (送信しない)", async () => {
    const c = okClient([]);
    await expect(getPaymentMethods(c, {})).rejects.toThrow(/customerId required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[PAY-0012] getClientSecret も同じフォールバック規則: companyID が customerId として使われる", async () => {
    const c = okClient("secret");
    await getClientSecret(c, { companyID: "co_xyz" });
    expect(c.sent[0].customerId).toBe("co_xyz");
  });

  it("[PAY-0012] changeDefaultPayment も同じフォールバック規則", async () => {
    const c = mockClient({ success: true, data: null, reqContext: {} });
    await changeDefaultPayment(c, { companyID: "co_abc", defaultPaymentMethod: "pm_1" });
    expect(c.sent[0].customerId).toBe("co_abc");
  });

  it("[PAY-0012] payUpdateLevel も同じフォールバック規則", async () => {
    const c = okClient(null);
    await payUpdateLevel(c, { companyID: "co_def", level: 2, isUpgrade: true });
    expect(c.sent[0].customerId).toBe("co_def");
  });

  it("[PAY-0012] getDevApiInfo の両欠落も customerIdRequired を投げる", async () => {
    const c = okClient(null);
    await expect(
      getDevApiInfo(c, { email: "x@example.com" }),
    ).rejects.toThrow(/customerId required/);
    expect(c.sent).toHaveLength(0);
  });
});

// ── PAY-0013: 全 op の必須引数バリデーション ─────────────────────────────────

describe("[PAY-0013] 全 op の必須引数バリデーションと bad_request 写像", () => {
  // ref: payment.js:40-138; util.js:54-56; i18n/payment.js:28-34
  it("[PAY-0013] customerId/companyID 欠落: badRequest(code=bad_request, retryable=false) を投げる", async () => {
    const c = okClient(null);
    await expect(getPaymentMethods(c, {})).rejects.toMatchObject({
      code: ERR.BAD_REQUEST,
      retryable: false,
    });
    await expect(getPaymentMethods(c, {})).rejects.toThrow(/customerId required/);
  });

  it("[PAY-0013] changeDefaultPayment: defaultPaymentMethod 欠落で bad_request", async () => {
    const c = mockClient({ success: true, data: null });
    await expect(
      changeDefaultPayment(c, { companyID: "ch_A" }),
    ).rejects.toMatchObject({ code: ERR.BAD_REQUEST, retryable: false });
    await expect(
      changeDefaultPayment(c, { companyID: "ch_A" }),
    ).rejects.toThrow(/defaultPaymentMethod required/);
  });

  it("[PAY-0013] removePayment: paymentId 欠落で bad_request", async () => {
    const c = okClient(null);
    await expect(
      removePayment(c, { companyID: "ch_A" }),
    ).rejects.toMatchObject({ code: ERR.BAD_REQUEST, retryable: false });
    await expect(
      removePayment(c, { companyID: "ch_A" }),
    ).rejects.toThrow(/paymentId required/);
  });

  it("[PAY-0013] payUpdateLevel: level 欠落で bad_request", async () => {
    const c = okClient(null);
    await expect(
      payUpdateLevel(c, { companyID: "ch_A", isUpgrade: true }),
    ).rejects.toMatchObject({ code: ERR.BAD_REQUEST, retryable: false });
    await expect(
      payUpdateLevel(c, { companyID: "ch_A", isUpgrade: true }),
    ).rejects.toThrow(/level required/);
  });

  it("[PAY-0013] payUpdateLevel: level=NaN で bad_request (levelRequired/NaN 境界)", async () => {
    const c = okClient(null);
    await expect(
      payUpdateLevel(c, { companyID: "ch_A", level: NaN, isUpgrade: true }),
    ).rejects.toMatchObject({ code: ERR.BAD_REQUEST, retryable: false });
  });

  it("[PAY-0013] payUpdateLevel: isUpgrade 非boolean(string)で bad_request (isUpgradeRequired 境界)", async () => {
    const c = okClient(null);
    await expect(
      payUpdateLevel(c, { companyID: "ch_A", level: 2, isUpgrade: /** @type {any} */ ("true") }),
    ).rejects.toMatchObject({ code: ERR.BAD_REQUEST, retryable: false });
    await expect(
      payUpdateLevel(c, { companyID: "ch_A", level: 2, isUpgrade: /** @type {any} */ ("true") }),
    ).rejects.toThrow(/isUpgrade required/);
  });

  it("[PAY-0013] getDevApiInfo: email 欠落で bad_request", async () => {
    const c = okClient(null);
    await expect(
      getDevApiInfo(c, { companyID: "ch_A" }),
    ).rejects.toMatchObject({ code: ERR.BAD_REQUEST, retryable: false });
    await expect(
      getDevApiInfo(c, { companyID: "ch_A" }),
    ).rejects.toThrow(/email required/);
  });

  it("[PAY-0013] バリデーションはすべて client.request 前に throw する (送信ゼロ)", async () => {
    const c = okClient(null);
    try { await getPaymentMethods(c, {}); } catch {}
    try { await changeDefaultPayment(c, { companyID: "ch_A" }); } catch {}
    try { await removePayment(c, { companyID: "ch_A" }); } catch {}
    try { await payUpdateLevel(c, { companyID: "ch_A", isUpgrade: true }); } catch {}
    try { await getDevApiInfo(c, { companyID: "ch_A" }); } catch {}
    expect(c.sent).toHaveLength(0);
  });
});

// ── PAY-0014: 上流 success:false で rejected ──────────────────────────────────

describe("[PAY-0014] 上流 success:false で rejected (retryable=false, upstreamCode 保持)", () => {
  // ref: util.js:34-43; useStripeInfo.js:117; useStripeInfo.js:141-143
  it("[PAY-0014] success:false → SesameError(code=rejected, retryable=false, data.upstreamCode=resp.code)", async () => {
    const c = failClient("PAYMENT_FAILED");
    let err;
    try {
      await getPaymentMethods(c, { companyID: "ch_A" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe(ERR.REJECTED);
    expect(err.retryable).toBe(false);
    expect(err.data?.upstreamCode).toBe("PAYMENT_FAILED");
  });

  it("[PAY-0014] success 欠落の data 応答は成功扱い (lenient): 正常に data を返す", async () => {
    // failed = !resp || resp.success === false → success 欠落は false でないので成功扱い
    const c = mockClient({ data: [{ id: "pm_1" }] }); // success フィールド無し
    const result = await getPaymentMethods(c, { companyID: "ch_A" });
    expect(Array.isArray(result)).toBe(true);
  });

  it("[PAY-0014] changeDefaultPayment success:false も rejected", async () => {
    const c = failClient("UPSTREAM_ERR");
    await expect(
      changeDefaultPayment(c, { companyID: "ch_A", defaultPaymentMethod: "pm_1" }),
    ).rejects.toMatchObject({ code: ERR.REJECTED });
  });

  it("[PAY-0014] payUpdateLevel success:false も rejected", async () => {
    const c = failClient();
    await expect(
      payUpdateLevel(c, { companyID: "ch_A", level: 2, isUpgrade: true }),
    ).rejects.toMatchObject({ code: ERR.REJECTED });
  });

  it("[PAY-0014] getDevApiInfo success:false も rejected", async () => {
    const c = failClient();
    await expect(
      getDevApiInfo(c, { companyID: "ch_A", email: "a@b.com" }),
    ).rejects.toMatchObject({ code: ERR.REJECTED });
  });
});

// ── PAY-0015: vendor は customerId をガードしないが kit は必須化する境界差 ─────

describe("[PAY-0015] vendor は customerId をガードしないが kit は必須化する (fail-closed 強化)", () => {
  // ref: useStripeInfo.js:237-264; payment.js:81-83; payment.js:106-108
  it("[PAY-0015] changeDefaultPayment: customerId 欠落を bad_request で弾く (vendor は無ガードで送信し得る)", async () => {
    const c = mockClient({ success: true, data: null, reqContext: {} });
    await expect(
      changeDefaultPayment(c, { defaultPaymentMethod: "pm_1" }),
    ).rejects.toMatchObject({ code: ERR.BAD_REQUEST, retryable: false });
    // 送信が行われない (vendor との差: vendor は送信してしまう)
    expect(c.sent).toHaveLength(0);
  });

  it("[PAY-0015] removePayment: customerId 欠落を bad_request で弾く (vendor delCard は無ガード)", async () => {
    const c = okClient(null);
    await expect(
      removePayment(c, { paymentId: "pm_x" }),
    ).rejects.toMatchObject({ code: ERR.BAD_REQUEST, retryable: false });
    expect(c.sent).toHaveLength(0);
  });

  it("[PAY-0015] customerId あれば送信は正常に行われる (フレーム形は vendor と一致)", async () => {
    const c = mockClient({ success: true, data: null, reqContext: {} });
    await changeDefaultPayment(c, { customerId: "cus_ok", defaultPaymentMethod: "pm_1" });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toMatchObject({
      action: ACT,
      customerId: "cus_ok",
      op: "changeDefaultPayment",
    });
  });
});

// ── PAY-0016: payment 6 op が registry に自動公開 ────────────────────────────

describe("[PAY-0016] payment 6 op が registry に自動公開され NAMESPACE_OPS と 1:1", () => {
  // ref: packages/kit/src/serve/registry.js:287-305; payment.js:171-178; registry.js:97-101
  it("[PAY-0016] NAMESPACE_OPS が 6 op を含む", () => {
    expect(NAMESPACE_OPS).toHaveLength(6);
    expect(NAMESPACE_OPS).toContain("getPaymentMethods");
    expect(NAMESPACE_OPS).toContain("getClientSecret");
    expect(NAMESPACE_OPS).toContain("changeDefaultPayment");
    expect(NAMESPACE_OPS).toContain("removePayment");
    expect(NAMESPACE_OPS).toContain("payUpdateLevel");
    expect(NAMESPACE_OPS).toContain("getDevApiInfo");
  });

  it("[PAY-0016] NAMESPACE_OPS が 6 op を名前通り含む (欠落・余剰なし)", () => {
    const expected = [
      "getPaymentMethods",
      "getClientSecret",
      "changeDefaultPayment",
      "removePayment",
      "payUpdateLevel",
      "getDevApiInfo",
    ];
    expect([...NAMESPACE_OPS].sort()).toEqual([...expected].sort());
  });

  it("[PAY-0016] buildRegistry が payment.<op> を 6 op 全て登録する (欠落・余剰なし)", async () => {
    const { buildRegistry, NAMESPACE_MODULE_KEYS } = await import("../../../kit/src/serve/registry.js");
    const reg = buildRegistry();
    const EXPECTED = NAMESPACE_OPS.map((op) => `payment.${op}`);
    for (const key of EXPECTED) {
      expect(reg.has(key), `missing registry entry: ${key}`).toBe(true);
    }
    expect(NAMESPACE_MODULE_KEYS).toContain("payment");
  });

  it("[PAY-0016] registry の payment エントリは 6 本ちょうど (欠落・余剰なし)", async () => {
    const { buildRegistry } = await import("../../../kit/src/serve/registry.js");
    const reg = buildRegistry();
    const paymentEntries = [...reg.keys()].filter((k) => k.startsWith("payment."));
    expect(paymentEntries).toHaveLength(6);
  });

  it("[PAY-0016] payment エントリのハンドラは関数で namespace='payment'", async () => {
    const { buildRegistry } = await import("../../../kit/src/serve/registry.js");
    const reg = buildRegistry();
    for (const op of NAMESPACE_OPS) {
      const entry = reg.get(`payment.${op}`);
      expect(entry, `entry missing: payment.${op}`).toBeDefined();
      expect(entry.namespace).toBe("payment");
      expect(typeof entry.handler).toBe("function");
    }
  });
});

// ── PAY-0017: payment RPC param schema が生成され型がプレースホルダに劣化しない ─

describe("[PAY-0017] payment RPC param schema が生成され型がプレースホルダに劣化しない", () => {
  // ref: rpc-params.generated.json:1021-1254; registry.js:291-296; registry.js:99-101
  it("[PAY-0017] rpc-params.generated.json に payment 6 op の named params(型付き)が存在する", () => {
    for (const op of NAMESPACE_OPS) {
      const key = `payment.${op}`;
      const params = RPC_PARAMS[key];
      expect(params, `missing rpc-params: ${key}`).toBeDefined();
      expect(Array.isArray(params)).toBe(true);
      // 汎用プレースホルダ '(params)' に落ちていない
      expect(params.length).toBeGreaterThan(0);
      expect(params[0].name).not.toBe("(params)");
    }
  });

  it("[PAY-0017] payment.getPaymentMethods の params に customerId/companyID/timeoutMs が型付きで存在する", () => {
    const params = RPC_PARAMS["payment.getPaymentMethods"];
    const names = params.map((p) => p.name);
    expect(names).toContain("customerId");
    expect(names).toContain("companyID");
    expect(names).toContain("timeoutMs");
    for (const p of params) {
      expect(p.tsType, `missing tsType for ${p.name}`).toBeDefined();
    }
  });

  it("[PAY-0017] payment.payUpdateLevel の params に subId/subscriptionId/level/isUpgrade/isCancel が存在する", () => {
    const params = RPC_PARAMS["payment.payUpdateLevel"];
    const names = params.map((p) => p.name);
    expect(names).toContain("subId");
    expect(names).toContain("subscriptionId");
    expect(names).toContain("level");
    expect(names).toContain("isUpgrade");
    expect(names).toContain("isCancel");
  });

  it("[PAY-0017] payment.getDevApiInfo の params に email/update が存在する", () => {
    const params = RPC_PARAMS["payment.getDevApiInfo"];
    const names = params.map((p) => p.name);
    expect(names).toContain("email");
    expect(names).toContain("update");
  });

  it("[PAY-0017] NAMESPACE_MODULE_KEYS が 'payment' を含む", async () => {
    const { NAMESPACE_MODULE_KEYS } = await import("../../../kit/src/serve/registry.js");
    expect(NAMESPACE_MODULE_KEYS).toContain("payment");
  });

  it("[PAY-0017] companyID は required:false で 'auto-injected by the daemon' 説明を持つ", () => {
    for (const op of NAMESPACE_OPS) {
      const params = RPC_PARAMS[`payment.${op}`];
      const companyId = params.find((p) => p.name === "companyID");
      expect(companyId, `companyID param missing in payment.${op}`).toBeDefined();
      expect(companyId.required).toBe(false);
      expect(companyId.desc).toMatch(/auto-injected/i);
    }
  });

  it("[PAY-0017] registry の payment エントリは params が汎用 (params) プレースホルダに劣化していない", async () => {
    const { buildRegistry } = await import("../../../kit/src/serve/registry.js");
    const reg = buildRegistry();
    for (const op of NAMESPACE_OPS) {
      const entry = reg.get(`payment.${op}`);
      expect(entry, `registry に payment.${op} が無い`).toBeDefined();
      const hasPlaceholder = entry.params.length === 1 && entry.params[0].name === "(params)";
      expect(hasPlaceholder, `payment.${op} の params が汎用プレースホルダに劣化している`).toBe(false);
    }
  });
});

// ── PAY-0018: payment proto/grpc/openrpc メソッド契約が registry と一致 ────────

describe("[PAY-0018] payment proto/grpc/openrpc メソッド契約が registry の op・param 集合と 1:1", () => {
  // ref: sesame.proto:91-101; sesame.proto:613-651; grpc-methods.generated.json:366-422; schema/openrpc.json:1537-1842

  const GRPC_METHOD_NAMES = [
    "PaymentGetPaymentMethods",
    "PaymentGetClientSecret",
    "PaymentChangeDefaultPayment",
    "PaymentRemovePayment",
    "PaymentPayUpdateLevel",
    "PaymentGetDevApiInfo",
  ];

  const GRPC_TO_REGISTRY = {
    PaymentGetPaymentMethods: "payment.getPaymentMethods",
    PaymentGetClientSecret: "payment.getClientSecret",
    PaymentChangeDefaultPayment: "payment.changeDefaultPayment",
    PaymentRemovePayment: "payment.removePayment",
    PaymentPayUpdateLevel: "payment.payUpdateLevel",
    PaymentGetDevApiInfo: "payment.getDevApiInfo",
  };

  it("[PAY-0018] grpc-methods.generated.json に payment 6 gRPC 名が存在し method 名が正しい", () => {
    for (const grpcName of GRPC_METHOD_NAMES) {
      expect(GRPC_MAP[grpcName], `missing gRPC entry: ${grpcName}`).toBeDefined();
      expect(GRPC_MAP[grpcName].method).toBe(GRPC_TO_REGISTRY[grpcName]);
    }
  });

  it("[PAY-0018] grpc-methods.generated.json に Payment* gRPC メソッドが 6 本存在する", () => {
    const paymentEntries = Object.entries(GRPC_MAP).filter(([k]) => k.startsWith("Payment"));
    expect(paymentEntries).toHaveLength(6);
  });

  it("[PAY-0018] grpc-methods: PaymentGetPaymentMethods の optionalScalars に customerId/companyID/timeoutMs が含まれる", () => {
    const entry = GRPC_MAP["PaymentGetPaymentMethods"];
    expect(entry.optionalScalars).toContain("customerId");
    expect(entry.optionalScalars).toContain("companyID");
    expect(entry.optionalScalars).toContain("timeoutMs");
    expect(entry.jsonFields).toEqual([]);
  });

  it("[PAY-0018] grpc-methods: PaymentPayUpdateLevel の optionalScalars に subId/subscriptionId/level/isUpgrade/isCancel が含まれる", () => {
    const entry = GRPC_MAP["PaymentPayUpdateLevel"];
    expect(entry.optionalScalars).toContain("subId");
    expect(entry.optionalScalars).toContain("subscriptionId");
    expect(entry.optionalScalars).toContain("level");
    expect(entry.optionalScalars).toContain("isUpgrade");
    expect(entry.optionalScalars).toContain("isCancel");
    expect(entry.jsonFields).toEqual([]);
  });

  it("[PAY-0018] grpc-methods: PaymentGetDevApiInfo の optionalScalars に email/update が含まれる", () => {
    const entry = GRPC_MAP["PaymentGetDevApiInfo"];
    expect(entry.optionalScalars).toContain("email");
    expect(entry.optionalScalars).toContain("update");
    expect(entry.jsonFields).toEqual([]);
  });

  it("[PAY-0018] sesame.proto に payment 6 rpc 宣言が存在する", () => {
    for (const grpcName of GRPC_METHOD_NAMES) {
      expect(PROTO_TEXT, `proto missing rpc: ${grpcName}`).toContain(`rpc ${grpcName}`);
    }
  });

  it("[PAY-0018] sesame.proto の PaymentPayUpdateLevelRequest に subId と subscriptionId の両フィールドが optional で存在する", () => {
    // ref: sesame.proto:635-644
    expect(PROTO_TEXT).toContain("PaymentPayUpdateLevelRequest");
    const msgMatch = PROTO_TEXT.match(/message PaymentPayUpdateLevelRequest\s*\{[^}]+\}/s);
    expect(msgMatch, "PaymentPayUpdateLevelRequest が proto に無い").toBeTruthy();
    const msgBody = msgMatch[0];
    expect(msgBody).toMatch(/\bsubId\b/);
    expect(msgBody).toMatch(/\bsubscriptionId\b/);
  });

  it("[PAY-0018] sesame.proto の Payment*Request は全フィールド optional (proto:613-651 確認)", () => {
    const paymentBlock = PROTO_TEXT.slice(
      PROTO_TEXT.indexOf("message PaymentGetPaymentMethodsRequest"),
      PROTO_TEXT.indexOf("message AccessGetCardsRequest"),
    );
    // このブロックに required フィールドが無い (optional のみ)
    const nonOptionalFields = paymentBlock
      .split("\n")
      .filter((line) => /^\s+(string|bool|double|int)\s+/.test(line))
      .filter((line) => !line.includes("optional") && !line.includes("repeated"));
    expect(nonOptionalFields).toHaveLength(0);
  });

  it("[PAY-0018] grpc-methods の Payment* method 名が registry の payment.<op> と 1:1 対応する", () => {
    const grpcMethods = Object.values(GRPC_MAP)
      .map((e) => e.method)
      .filter((m) => m.startsWith("payment."));
    expect(grpcMethods.sort()).toEqual(
      NAMESPACE_OPS.map((op) => `payment.${op}`).sort(),
    );
  });

  it("[PAY-0018] schema/openrpc.json に payment 6 メソッドが存在する", () => {
    const openrpcPath = resolve(HERE, "../../../../schema/openrpc.json");
    const openrpc = JSON.parse(readFileSync(openrpcPath, "utf-8"));
    const methodNames = openrpc.methods.map((m) => m.name);
    for (const op of NAMESPACE_OPS) {
      const rpcName = `payment.${op}`;
      expect(methodNames, `openrpc missing: ${rpcName}`).toContain(rpcName);
    }
  });
});
