/**
 * idToken の `sub` claim (= Cognito user UUID) を返す。
 * biz3 が `gStripe.customerInfo.subUUID` として使っている値と同じで、
 * `biz3TriggerLocker` の `history` フィールドに乗せる必要がある。
 */
export function jwtSub(token: any): any;
/**
 * 失効していない idToken を返す。必要なら refresh する。
 * 失効まで `marginSec` 以下なら早期 refresh する (デフォルト 60秒)。
 *
 * @param {{load:Function, save:Function}} store
 */
export function getValidIdToken(store: {
    load: Function;
    save: Function;
}, { marginSec }?: {
    marginSec?: number;
}): Promise<any>;
/**
 * Step 1: CUSTOM_AUTH を開始。Cognito が email に確認コードを送る。
 * 新規ユーザーの場合は SignUp してから retry。
 *
 * @param {{savePending:Function}} store
 */
export function loginInitiate(store: {
    savePending: Function;
}, username: any, { clientId }?: {
    clientId?: string;
}): Promise<{
    challenge: "CUSTOM_CHALLENGE";
    params: Record<string, string>;
}>;
/**
 * Step 2: email で受け取ったコードで CUSTOM_CHALLENGE を回答。
 * 成功するとトークンを保存し、pending 状態を消す。
 *
 * @param {{loadPending:Function, save:Function, clearPending:Function}} store
 */
export function loginVerify(store: {
    loadPending: Function;
    save: Function;
    clearPending: Function;
}, code: any): Promise<{
    clientId: any;
    idToken: string;
    refreshToken: string;
    accessToken: string;
    deviceKey: any;
    deviceGroupKey: any;
    devicePassword: any;
    username: any;
    lastRefresh: string;
}>;
/**
 * ログアウト。公式アプリ相当にサーバ側もクリーンにする:
 *   1. ForgetDevice — このデバイスの remembered 登録を解除 (ConfirmDevice の対。これが無いと
 *      login のたびに remembered device がアカウントに溜まり続ける)。
 *   2. RevokeToken  — この refresh token を失効 (ローカル削除だけでは生き残るため)。
 * サーバ呼び出しは best-effort (失敗してもローカルは必ず消す)。どちらも対象はこのセッション/
 * このデバイスのみで、公式アプリ等の別セッションには影響しない (GlobalSignOut は使わない)。
 *
 * @param {{load:Function, clear:Function, clearPending:Function, save:Function}} store
 * @returns {Promise<{forgotDevice:boolean, revokedToken:boolean}>}
 */
export function logout(store: {
    load: Function;
    clear: Function;
    clearPending: Function;
    save: Function;
}): Promise<{
    forgotDevice: boolean;
    revokedToken: boolean;
}>;
/**
 * 既存の localStorage ダンプから bootstrap (互換用)。
 *
 * @param {{save:Function}} store
 */
export function bootstrap(store: {
    save: Function;
}, values: any): {
    clientId: any;
    idToken: any;
    refreshToken: any;
    accessToken: any;
    deviceKey: any;
    username: any;
    lastRefresh: string;
};
export const CONSUMER_CLIENT_ID: "6ialca0p8u0lsgvbmvsljfm305";
export const BIZ_CLIENT_ID: "21u50hboia4s5q0sbk6pbdfmss";
export namespace CONFIG_META {
    export { COGNITO_REGION as region };
    export { USER_POOL_ID as userPoolId };
    export { CONSUMER_CLIENT_ID as consumerClientId };
    export { BIZ_CLIENT_ID as bizClientId };
}
declare const COGNITO_REGION: "ap-northeast-1";
declare const USER_POOL_ID: "ap-northeast-1_bY2byhlCa";
export {};
//# sourceMappingURL=auth.d.ts.map