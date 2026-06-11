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
 * 失効まで `marginSec` 以下なら早期 refresh する (デフォルト 120秒 =
 * AWSMobileClient 2.77.0 の REFRESH_THRESHOLD_DEFAULT、
 * CognitoIdentityProviderClientConfig.java:40)。
 *
 * @param {import("./tokens.js").TokenStore} store
 * @param {{ marginSec?: number }} [opts]
 * @returns {Promise<string>}
 */
export function getValidIdToken(store: import("./tokens.js").TokenStore, { marginSec }?: {
    marginSec?: number;
}): Promise<string>;
/**
 * Step 1: アプリと同じ「signUp 先行 → CUSTOM_AUTH 開始」(LoginMailFG.kt:106-127 の 1:1)。
 * Cognito が email に確認コードを送る。
 *
 * フロー (アプリ忠実):
 *   1. SignUp (Password="dummypwk", UserAttributes=[{Name:"email"}]) を常に先に実行。
 *      既存ユーザーの UsernameExistsException は容認して signIn へ進む
 *      (LoginMailFG.kt:114-118)。
 *   2. InitiateAuth (CUSTOM_AUTH, AuthParameters={USERNAME})。
 *      DEVICE_KEY は initiate には入れない — 参照 SDK の initiateCustomAuthRequest は
 *      DEVICE_KEY を同梱しない (CognitoUser.java:3473-3507)。DEVICE_KEY は全チャレンジ
 *      回答側に注入される (CognitoUser.java:2919-2922 / ChallengeContinuation.java:160-167)。
 *
 * @param {import("./tokens.js").TokenStore} store
 * @param {string} username
 * @param {{ clientId?: string }} [opts] 互換用。Consumer Client 以外は拒否する。
 */
export function loginInitiate(store: import("./tokens.js").TokenStore, username: string, { clientId }?: {
    clientId?: string;
}): Promise<{
    challenge: string;
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
 * ログアウト。公式アプリは**ローカル signOut のみ**で、以下のサーバ側クリーンアップは
 * 本 kit の意図的な強化 (公式挙動の再現ではない):
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