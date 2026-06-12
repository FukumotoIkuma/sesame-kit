/**
 * JWT payload (base64url) をデコードして指定 claim の値を返す。
 * token が null/undefined/不正形式/JSON 不正 いずれでも null を返す (catch で包む)。
 * null/undefined → token.split が TypeError → catch → null の経路が意図的動作。
 * P5-5: jwtExp / jwtAud / jwtSub の共通基底として抽出。tokens.js も import して使用。
 * @param {string|null|undefined} token
 * @param {string} name  claim 名 (例: "exp", "aud", "sub")
 * @returns {string|number|null}
 */
export function jwtClaim(token: string | null | undefined, name: string): string | number | null;
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
 * _aws_sdk_ref/CognitoIdentityProviderClientConfig.java:40)。
 *
 * @param {import("./tokens.js").TokenStore} store
 * @param {{ marginSec?: number }} [opts]
 * @returns {Promise<string>}
 */
export function getValidIdToken(store: import("./tokens.js").TokenStore, { marginSec }?: {
    marginSec?: number;
}): Promise<string>;
/**
 * Step 1: アプリと同じ「signUp 先行 → CUSTOM_AUTH (SRP_A 付き) 開始」。
 *
 * フロー (アプリ忠実):
 *   1. SignUp (Password="dummypwk", UserAttributes=[{Name:"email"}]) を常に先に実行。
 *      既存ユーザーの UsernameExistsException は容認して signIn へ進む
 *      (_sesame_sdk_ref/app/.../LoginMailFG.kt:114-118)。
 *   2. InitiateAuth (CUSTOM_AUTH, AuthParameters={USERNAME, CHALLENGE_NAME:"SRP_A", SRP_A}).
 *      SRP_A は `generateEphemeralA()` で生成した A = g^a mod N の hex 文字列。
 *      _aws_sdk_ref/CognitoUser.java:3492-3494 の 1:1。
 *      DEVICE_KEY は initiate には入れない (_aws_sdk_ref/CognitoUser.java:3473-3507)。
 *   3a. 応答が CUSTOM_CHALLENGE → そのまま pending に保存して返す (現行 Cognito の観測形)。
 *   3b. 応答が PASSWORD_VERIFIER → user SRP で回答してから CUSTOM_CHALLENGE を待つ
 *      (_aws_sdk_ref/CognitoUser.java:3057-3071, 3588-3662)。
 *
 * @experimental 実機未検証 (§9 V13): アプリ形 InitiateAuth (SRP_A 付き) を実 Cognito が
 *   受理し CUSTOM_CHALLENGE を返すこと、および PASSWORD_VERIFIER 連鎖経路の実機確認が未実施。
 *   参照: _aws_sdk_ref/CognitoUser.java:3057-3071, 3588-3662。
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