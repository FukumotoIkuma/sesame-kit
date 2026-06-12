/**
 * 署名に使う AWS credentials。sessionToken は Cognito Identity Pool の一時 credentials
 * (GetCredentialsForIdentity) では必須で、X-Amz-Security-Token ヘッダとして署名対象に含める。
 * @typedef {Object} SigV4Credentials
 * @property {string} accessKeyId
 * @property {string} secretAccessKey
 * @property {string} [sessionToken]
 */
/**
 * @param {string|Buffer} data
 * @returns {string} sha256 hex digest
 */
export function sha256Hex(data: string | Buffer): string;
/**
 * SigV4 署名鍵の導出: HMAC("AWS4"+secret, date) → region → service → "aws4_request" の連鎖
 * (AWS General Reference: Calculate the signature)。既知ベクタテストから個別検証できるよう export。
 * @param {{secretAccessKey: string, dateStamp: string, region: string, service: string}} p
 *   dateStamp は YYYYMMDD (UTC)。
 * @returns {Buffer} 署名鍵
 */
export function deriveSigningKey({ secretAccessKey, dateStamp, region, service }: {
    secretAccessKey: string;
    dateStamp: string;
    region: string;
    service: string;
}): Buffer;
/**
 * リクエストへ SigV4 署名を付ける。
 *
 * 戻り値の headers は fetch にそのまま渡せる完全なヘッダ一式 (入力 headers を小文字キー化し、
 * host / x-amz-date / x-amz-security-token (sessionToken がある時) / authorization を追加したもの)。
 * canonicalRequest / stringToSign / signature は既知ベクタテスト・デバッグ用に公開する。
 *
 * @param {{
 *   method: string,
 *   url: string,
 *   headers?: Record<string, string>,
 *   body?: string|Buffer|null,
 *   credentials: SigV4Credentials,
 *   service?: string,
 *   region?: string,
 *   date?: Date,
 * }} p
 *   service/region の既定は本 kit の実利用値 (API Gateway = execute-api / ap-northeast-1,
 *   ApiClientConfigBuilder.kt:18 DEFAULT_REGION)。date はテスト用の固定日時注入口。
 * @returns {{
 *   headers: Record<string, string>,
 *   canonicalRequest: string,
 *   stringToSign: string,
 *   signature: string,
 *   credentialScope: string,
 *   signedHeaders: string,
 *   amzDate: string,
 * }}
 */
export function signRequest({ method, url, headers, body, credentials, service, region, date, }: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string | Buffer | null;
    credentials: SigV4Credentials;
    service?: string;
    region?: string;
    date?: Date;
}): {
    headers: Record<string, string>;
    canonicalRequest: string;
    stringToSign: string;
    signature: string;
    credentialScope: string;
    signedHeaders: string;
    amzDate: string;
};
/**
 * 署名に使う AWS credentials。sessionToken は Cognito Identity Pool の一時 credentials
 * (GetCredentialsForIdentity) では必須で、X-Amz-Security-Token ヘッダとして署名対象に含める。
 */
export type SigV4Credentials = {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string | undefined;
};
//# sourceMappingURL=sigv4.d.ts.map