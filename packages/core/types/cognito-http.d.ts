/**
 * Cognito AuthenticationResult (旧 @aws-sdk AuthenticationResultType 互換の最小形)。
 * @typedef {object} CognitoAuthResult
 * @property {string} [IdToken]
 * @property {string} [AccessToken]
 * @property {string} [RefreshToken]
 * @property {string} [TokenType]
 * @property {number} [ExpiresIn]
 * @property {{ DeviceKey?: string, DeviceGroupKey?: string }} [NewDeviceMetadata]
 */
/**
 * auth.js が読む Cognito 応答フィールドの和集合 (op ごとに使う部分だけ読む)。
 * @typedef {object} CognitoResponse
 * @property {string} [ChallengeName]
 * @property {Record<string, string>} [ChallengeParameters]
 * @property {string} [Session]
 * @property {CognitoAuthResult} [AuthenticationResult]
 * @property {boolean} [UserConfirmationNecessary]
 * @property {boolean} [UserConfirmed]
 * @property {string} [UserSub]
 * @property {{ Name: string; Value: string }[]} [UserAttributes]
 */
/**
 * Cognito Identity Provider の 1 オペレーションを呼ぶ。
 *
 * @param {string} op オペレーション名 (例: "InitiateAuth")。X-Amz-Target の末尾になる。
 * @param {object} payload リクエストパラメータ (AWS SDK の Command input と同形)
 * @param {{ region?: string, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<CognitoResponse>}
 * @throws {Error} エラー応答時。`name` に Cognito の例外名 (__type の "#" 以降) を写像。
 */
export function cognitoCall(op: string, payload: object, { region, fetchImpl }?: {
    region?: string;
    fetchImpl?: typeof fetch;
}): Promise<CognitoResponse>;
/**
 * Cognito AuthenticationResult (旧
 */
export type CognitoAuthResult = {
    IdToken?: string | undefined;
    AccessToken?: string | undefined;
    RefreshToken?: string | undefined;
    TokenType?: string | undefined;
    ExpiresIn?: number | undefined;
    NewDeviceMetadata?: {
        DeviceKey?: string;
        DeviceGroupKey?: string;
    } | undefined;
};
/**
 * auth.js が読む Cognito 応答フィールドの和集合 (op ごとに使う部分だけ読む)。
 */
export type CognitoResponse = {
    ChallengeName?: string | undefined;
    ChallengeParameters?: Record<string, string> | undefined;
    Session?: string | undefined;
    AuthenticationResult?: CognitoAuthResult | undefined;
    UserConfirmationNecessary?: boolean | undefined;
    UserConfirmed?: boolean | undefined;
    UserSub?: string | undefined;
    UserAttributes?: {
        Name: string;
        Value: string;
    }[] | undefined;
};
//# sourceMappingURL=cognito-http.d.ts.map