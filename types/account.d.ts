/**
 * ログインユーザの customerInfo / quotas を取得する。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{email:string}} params  login に使った email (tokenStore の username)
 * @returns {Promise<{customerInfo: object|null, quotas: object|null}>}
 */
export function getLoginUser(client: import("./transport.js").Hub3WsClient, { email }: {
    email: string;
}): Promise<{
    customerInfo: object | null;
    quotas: object | null;
}>;
//# sourceMappingURL=account.d.ts.map