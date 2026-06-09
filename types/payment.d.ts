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
export function getPaymentMethods(client: import("./transport.js").Hub3WsClient, params?: {
    customerId?: string;
    companyID?: string;
    timeoutMs?: number;
}): Promise<object[]>;
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
export function getClientSecret(client: import("./transport.js").Hub3WsClient, params?: {
    customerId?: string;
    companyID?: string;
    timeoutMs?: number;
}): Promise<string | null>;
/**
 * Change the default Stripe payment method after Stripe.js confirmSetup succeeds.
 *
 * biz3 changeDefaultPay (useStripeInfo.js:240-252):
 * { action:'biz3ManagePayment', customerId, defaultPaymentMethod, op:'changeDefaultPayment' }
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{customerId?:string, companyID?:string, defaultPaymentMethod:string, timeoutMs?:number}} params
 * @returns {Promise<object|null>}
 */
export function changeDefaultPayment(client: import("./transport.js").Hub3WsClient, params?: {
    customerId?: string;
    companyID?: string;
    defaultPaymentMethod: string;
    timeoutMs?: number;
}): Promise<object | null>;
/**
 * Remove a Stripe payment method.
 *
 * biz3 delCard (useStripeInfo.js:254-265):
 * { action:'biz3ManagePayment', paymentId, customerId, op:'removePayment' }
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{customerId?:string, companyID?:string, paymentId:string, timeoutMs?:number}} params
 * @returns {Promise<object[]|object|null>}
 */
export function removePayment(client: import("./transport.js").Hub3WsClient, params?: {
    customerId?: string;
    companyID?: string;
    paymentId: string;
    timeoutMs?: number;
}): Promise<object[] | object | null>;
/**
 * Update/cancel the company's paid level.
 *
 * biz3 updateLevel (useStripeInfo.js:202-220):
 * { action:'biz3ManagePayment', subId, isUpgrade, level, isCancel, customerId, op:'payUpdateLevel' }
 *
 * `level` is the encoded biz3 level (`planIndex * 2 + yearlyBit`), not just the plan index.
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{customerId?:string, companyID?:string, subId?:string, subscriptionId?:string, level:number, isUpgrade:boolean, isCancel?:boolean, timeoutMs?:number}} params
 * @returns {Promise<object|null>}
 */
export function payUpdateLevel(client: import("./transport.js").Hub3WsClient, params?: {
    customerId?: string;
    companyID?: string;
    subId?: string;
    subscriptionId?: string;
    level: number;
    isUpgrade: boolean;
    isCancel?: boolean;
    timeoutMs?: number;
}): Promise<object | null>;
/**
 * Get or rotate developer API information.
 *
 * biz3 getDevApiInfo (useStripeInfo.js:274-290):
 * { action:'biz3ManagePayment', customerId, email, op:'getDevApiInfo', update? }
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{customerId?:string, companyID?:string, email:string, update?:boolean|null, timeoutMs?:number}} params
 * @returns {Promise<{apiKeyValue?:string,apiKeyId?:string,usedCount?:number}|object|null>}
 */
export function getDevApiInfo(client: import("./transport.js").Hub3WsClient, params?: {
    customerId?: string;
    companyID?: string;
    email: string;
    update?: boolean | null;
    timeoutMs?: number;
}): Promise<{
    apiKeyValue?: string;
    apiKeyId?: string;
    usedCount?: number;
} | object | null>;
export const NAMESPACE_OPS: string[];
//# sourceMappingURL=payment.d.ts.map