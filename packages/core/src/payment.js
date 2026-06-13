// Biz3 payment management (biz3ManagePayment).
//
// Ported from references_web/src/api/useStripeInfo.js:
//   - getPaymentMethods
//   - getClientSecret
//   - changeDefaultPayment
//   - removePayment
//   - payUpdateLevel
//   - getDevApiInfo
//
// Note: Stripe Elements confirmation is intentionally not reproduced here; this module exposes
// the Biz3 WebSocket operations around the Stripe flow. A browser/client still has to call
// Stripe.js confirmSetup with the client secret before changeDefaultPayment can point at the
// resulting payment method.

import { ACTION_TYPES } from "./vendor/biz3/constants/messageConstants.js";
import { assertSuccess, badRequest } from "./util.js";

const ACT_PAYMENT = ACTION_TYPES.BIZ3_MANAGE_PAYMENT; // "biz3ManagePayment"
const DEFAULT_TIMEOUT_MS = 10_000;

/** @param {{customerId?:string, companyID?:string}} params @returns {string|undefined} */
function customerIdOf(params) {
  return params?.customerId || params?.companyID;
}

/**
 * List Stripe payment methods for the priority company/customer.
 *
 * biz3 getCardList (useStripeInfo.js:99-108):
 * { action:'biz3ManagePayment', customerId, op:'getPaymentMethods' }
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{customerId?:string, companyID?:string, timeoutMs?:number}} params
 * @returns {Promise<object[]>}
 */
export async function getPaymentMethods(client, params = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS } = params;
  const customerId = customerIdOf(params);
  if (!customerId) throw badRequest("payment.err.customerIdRequired");
  const resp = await client.request({ action: ACT_PAYMENT, customerId, op: "getPaymentMethods" }, timeoutMs);
  assertSuccess(resp, "getPaymentMethods");
  return Array.isArray(resp?.data) ? resp.data : [];
}

/**
 * Request a Stripe SetupIntent client secret.
 *
 * biz3 getClientSecret (useStripeInfo.js:222-234):
 * { action:'biz3ManagePayment', customerId, op:'getClientSecret' }
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{customerId?:string, companyID?:string, timeoutMs?:number}} params
 * @returns {Promise<string|null>}
 */
export async function getClientSecret(client, params = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS } = params;
  const customerId = customerIdOf(params);
  if (!customerId) throw badRequest("payment.err.customerIdRequired");
  const resp = await client.request({ action: ACT_PAYMENT, customerId, op: "getClientSecret" }, timeoutMs);
  assertSuccess(resp, "getClientSecret");
  return /** @type {string|null} */ (resp?.data ?? null);
}

/**
 * Change the default Stripe payment method after Stripe.js confirmSetup succeeds.
 *
 * biz3 changeDefaultPay (useStripeInfo.js:240-252):
 * { action:'biz3ManagePayment', customerId, defaultPaymentMethod, op:'changeDefaultPayment' }
 *
 * 応答: vendor (useStripeInfo.js:123-135) は `message.reqContext.defaultPaymentMethod` を
 * 読む。応答の実体は `reqContext` にあるため、戻り値に `reqContext` を含める。
 * 参照: references_web/src/api/useStripeInfo.js:123-135
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{customerId?:string, companyID?:string, defaultPaymentMethod?:string, timeoutMs?:number}} params
 * @returns {Promise<{data: object|null, reqContext: any}>}
 */
export async function changeDefaultPayment(client, params = {}) {
  const { defaultPaymentMethod, timeoutMs = DEFAULT_TIMEOUT_MS } = params;
  const customerId = customerIdOf(params);
  if (!customerId) throw badRequest("payment.err.customerIdRequired");
  if (!defaultPaymentMethod) throw badRequest("payment.err.defaultPaymentMethodRequired");
  const resp = await client.request(
    { action: ACT_PAYMENT, customerId, defaultPaymentMethod, op: "changeDefaultPayment" },
    timeoutMs,
  );
  assertSuccess(resp, "changeDefaultPayment");
  // vendor が消費するのは resp.reqContext (useStripeInfo.js:124: message.reqContext.defaultPaymentMethod)。
  // resp.data は通常 null / 空だが、lib 利用者が両フィールドにアクセスできるよう両方を返す。
  return { data: resp?.data ?? null, reqContext: resp?.reqContext };
}

/**
 * Remove a Stripe payment method.
 *
 * biz3 delCard (useStripeInfo.js:254-265):
 * { action:'biz3ManagePayment', paymentId, customerId, op:'removePayment' }
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{customerId?:string, companyID?:string, paymentId?:string, timeoutMs?:number}} params
 * @returns {Promise<object[]|object|null>}
 */
export async function removePayment(client, params = {}) {
  const { paymentId, timeoutMs = DEFAULT_TIMEOUT_MS } = params;
  const customerId = customerIdOf(params);
  if (!customerId) throw badRequest("payment.err.customerIdRequired");
  if (!paymentId) throw badRequest("payment.err.paymentIdRequired");
  const resp = await client.request({ action: ACT_PAYMENT, customerId, paymentId, op: "removePayment" }, timeoutMs);
  assertSuccess(resp, "removePayment");
  return resp?.data ?? null;
}

/**
 * Update/cancel the company's paid level.
 *
 * biz3 updateLevel (useStripeInfo.js:200-219):
 * { action:'biz3ManagePayment', [subId,] isUpgrade, level, isCancel, customerId, op:'payUpdateLevel' }
 *
 * subId は Free 会社(初回アップグレード)では undefined となりフレームに含まれない
 * (references_web/src/api/useStripeInfo.js:41-47 で subscriptionId は optional)。
 *
 * `level` is the encoded biz3 level (`planIndex * 2 + yearlyBit`), not just the plan index.
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{customerId?:string, companyID?:string, subId?:string, subscriptionId?:string, level?:number, isUpgrade?:boolean, isCancel?:boolean, timeoutMs?:number}} params
 * @returns {Promise<object|null>}
 */
export async function payUpdateLevel(client, params = {}) {
  const { level, isUpgrade, isCancel = false, timeoutMs = DEFAULT_TIMEOUT_MS } = params;
  const customerId = customerIdOf(params);
  // references_web/src/api/useStripeInfo.js:200-219: ガードは customerId のみ。
  // subscriptionId は priorityCompany(:41-47) で undefined になり得て、
  // undefined は JSON.stringify で落ち subId なしで送信される(Free 会社の初回アップグレード経路)。
  const subId = params.subId || params.subscriptionId || undefined;
  if (!customerId) throw badRequest("payment.err.customerIdRequired");
  if (level == null || Number.isNaN(Number(level))) throw badRequest("payment.err.levelRequired");
  if (typeof isUpgrade !== "boolean") throw badRequest("payment.err.isUpgradeRequired");
  /** @type {import("./transport.js").WsFrame} */
  const frame = { action: ACT_PAYMENT, isUpgrade, level: Number(level), isCancel: !!isCancel, customerId, op: "payUpdateLevel" };
  // subId != null のときのみフレームに含める(参照の「undefined は直列化で落ちる」挙動の 1:1)。
  if (subId != null) frame.subId = subId;
  const resp = await client.request(frame, timeoutMs);
  assertSuccess(resp, "payUpdateLevel");
  return resp?.data ?? null;
}

/**
 * Get or rotate developer API information.
 *
 * biz3 getDevApiInfo (useStripeInfo.js:274-290):
 * { action:'biz3ManagePayment', customerId, email, op:'getDevApiInfo', update? }
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{customerId?:string, companyID?:string, email?:string, update?:boolean|null, timeoutMs?:number}} params
 * @returns {Promise<{apiKeyValue?:string,apiKeyId?:string,usedCount?:number}|object|null>}
 */
export async function getDevApiInfo(client, params = {}) {
  const { email, update = null, timeoutMs = DEFAULT_TIMEOUT_MS } = params;
  const customerId = customerIdOf(params);
  if (!customerId) throw badRequest("payment.err.customerIdRequired");
  if (!email) throw badRequest("payment.err.emailRequired");
  /** @type {{action:string, customerId:string, email:string, op:string, update?:boolean}} */
  const frame = { action: ACT_PAYMENT, customerId, email, op: "getDevApiInfo" };
  if (update !== null && update !== undefined) frame.update = !!update;
  const resp = await client.request(frame, timeoutMs);
  assertSuccess(resp, "getDevApiInfo");
  return resp?.data ?? null;
}

export const NAMESPACE_OPS = [
  "getPaymentMethods",
  "getClientSecret",
  "changeDefaultPayment",
  "removePayment",
  "payUpdateLevel",
  "getDevApiInfo",
];
