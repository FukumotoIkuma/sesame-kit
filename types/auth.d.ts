/**
 * idToken の `sub` claim (= Cognito user UUID) を返す。
 * biz3 が `gStripe.customerInfo.subUUID` として使っている値と同じで、
 * `biz3TriggerLocker` の `history` フィールドに乗せる必要がある。
 * @param {string} token
 * @returns {string|null}
 */
export function jwtSub(token: string): string | null;
/**
 * 失効していない idToken を返す。必要なら refresh する。
 * 失効まで `marginSec` 以下なら早期 refresh する (デフォルト 60秒)。
 *
 * @param {import("./tokens.js").TokenStore} store
 * @param {{ marginSec?: number }} [opts]
 * @returns {Promise<string>}
 */
export function getValidIdToken(store: import("./tokens.js").TokenStore, { marginSec }?: {
    marginSec?: number;
}): Promise<string>;
/**
 * Step 1: CUSTOM_AUTH を開始。Cognito が email に確認コードを送る。
 * 新規ユーザーの場合は SignUp してから retry。
 *
 * @param {import("./tokens.js").TokenStore} store
 * @param {string} username
 * @param {{ clientId?: string }} [opts] 互換用。Consumer Client 以外は拒否する。
 */
export function loginInitiate(store: import("./tokens.js").TokenStore, username: string, { clientId }?: {
    clientId?: string;
}): Promise<{
    challenge: "CUSTOM_CHALLENGE";
    params: Record<string, string> | undefined;
}>;
/**
 * Step 2: email で受け取ったコードで CUSTOM_CHALLENGE を回答。
 * 成功するとトークンを保存し、pending 状態を消す。
 *
 * @param {import("./tokens.js").TokenStore} store
 * @param {string} code
 */
export function loginVerify(store: import("./tokens.js").TokenStore, code: string): Promise<import("./tokens.js").StoredTokens>;
/**
 * ログアウト。公式アプリ相当にサーバ側もクリーンにする:
 *   1. ForgetDevice — このデバイスの remembered 登録を解除 (ConfirmDevice の対。これが無いと
 *      login のたびに remembered device がアカウントに溜まり続ける)。
 *   2. RevokeToken  — この refresh token を失効 (ローカル削除だけでは生き残るため)。
 * サーバ呼び出しは best-effort (失敗してもローカルは必ず消す)。どちらも対象はこのセッション/
 * このデバイスのみで、公式アプリ等の別セッションには影響しない (GlobalSignOut は使わない)。
 *
 * @param {import("./tokens.js").TokenStore} store
 * @returns {Promise<{forgotDevice:boolean, revokedToken:boolean}>}
 */
export function logout(store: import("./tokens.js").TokenStore): Promise<{
    forgotDevice: boolean;
    revokedToken: boolean;
}>;
/**
 * 既存の localStorage ダンプから bootstrap (互換用)。
 *
 * @param {import("./tokens.js").TokenStore} store
 * @param {Partial<import("./tokens.js").StoredTokens>} values
 * @returns {import("./tokens.js").StoredTokens}
 */
export function bootstrap(store: import("./tokens.js").TokenStore, values: Partial<import("./tokens.js").StoredTokens>): import("./tokens.js").StoredTokens;
export const CONSUMER_CLIENT_ID: "6ialca0p8u0lsgvbmvsljfm305";
export namespace CONFIG_META {
    export { COGNITO_REGION as region };
    export { USER_POOL_ID as userPoolId };
    export { CONSUMER_CLIENT_ID as consumerClientId };
}
declare const COGNITO_REGION: "ap-northeast-1";
declare const USER_POOL_ID: "ap-northeast-1_bY2byhlCa";
export {};
//# sourceMappingURL=auth.d.ts.map