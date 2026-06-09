/**
 * biz3GetLoginUser の customerInfo。biz3 由来の動的 JSON で、companyID / subUUID /
 * subscriptionId / name 等が入る。client.js#refreshAccount が companyID / subUUID を読む。
 * @typedef {{
 *   companyID?: string,
 *   subUUID?: string,
 *   subscriptionId?: string,
 *   name?: string,
 * } & Record<string, unknown>} CustomerInfo
 */
/**
 * biz3GetLoginUser の quotas。biz3 由来の動的 JSON。
 * @typedef {Record<string, unknown>} Quotas
 */
/**
 * biz3GetLoginUser 応答の data ペイロード。
 * @typedef {{ customerInfo?: CustomerInfo | null, quotas?: Quotas | null }} LoginUserData
 */
/**
 * ログインユーザの customerInfo / quotas を取得する。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{email:string}} params  login に使った email (tokenStore の username)
 * @returns {Promise<{customerInfo: CustomerInfo|null, quotas: Quotas|null}>}
 */
export function getLoginUser(client: import("./transport.js").Hub3WsClient, { email }: {
    email: string;
}): Promise<{
    customerInfo: CustomerInfo | null;
    quotas: Quotas | null;
}>;
/**
 * biz3GetLoginUser の customerInfo。biz3 由来の動的 JSON で、companyID / subUUID /
 * subscriptionId / name 等が入る。client.js#refreshAccount が companyID / subUUID を読む。
 */
export type CustomerInfo = {
    companyID?: string;
    subUUID?: string;
    subscriptionId?: string;
    name?: string;
} & Record<string, unknown>;
/**
 * biz3GetLoginUser の quotas。biz3 由来の動的 JSON。
 */
export type Quotas = Record<string, unknown>;
/**
 * biz3GetLoginUser 応答の data ペイロード。
 */
export type LoginUserData = {
    customerInfo?: CustomerInfo | null;
    quotas?: Quotas | null;
};
//# sourceMappingURL=account.d.ts.map