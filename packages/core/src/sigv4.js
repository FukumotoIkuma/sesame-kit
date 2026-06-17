// AWS Signature Version 4 (SigV4) 署名の自前実装。依存は node:crypto のみ。
//
// 出典 (本実装が従う仕様):
//   - AWS General Reference「Signature Version 4 signing process」
//     (Create a canonical request → Create a string to sign → Calculate the signature)。
//   - 参照アプリ側の対応物: AWS Android SDK の ApiClientFactory が API Gateway リクエストへ
//     SigV4 署名を付ける (_sesame_sdk_ref/.../utils/ApiClientConfigBuilder.kt:34-46 —
//     credentialsProvider + apiKey + region)。
//   - 依存追加 (@smithy/signature-v4 等) は依存方針により行わず、ここで自前実装する。
//
// 既知ベクタ検証: tests/sigv4/sigv4.test.js
//   - AWS ドキュメント掲載の IAM ListUsers 署名例 (固定日時 20150830T123600Z・固定鍵
//     AKIDEXAMPLE) で canonical request → string to sign → signature を検証。
//   - AWS SigV4 test suite (get-vanilla / post-vanilla, service="service") 相当ベクタ。
//
// スコープ: 本 kit が使う API Gateway (service=execute-api) 向けの header 署名のみ。
// S3 系の特例 (パス単エンコード・UNSIGNED-PAYLOAD) は対象外。

import { createHash, createHmac } from "node:crypto";
import { badRequest } from "./util.js";

const ALGORITHM = "AWS4-HMAC-SHA256";

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
export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * @param {string|Buffer} key
 * @param {string} data
 * @returns {Buffer}
 */
function hmacSha256(key, data) {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * RFC 3986 の unreserved 文字以外を %XX (大文字 hex) にエンコードする。
 * encodeURIComponent が素通しする !'()* も SigV4 では エンコード対象 (AWS 仕様の UriEncode)。
 * @param {string} s
 * @returns {string}
 */
function rfc3986Encode(s) {
  return encodeURIComponent(s).replace(
    /[!'()*]/g, // 単一文字クラス + g。backtracking なし (線形)。
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * canonical URI を組む。非 S3 サービスは「各パスセグメントを 2 回 URI エンコード」が仕様
 * (AWS General Reference: Create a canonical request)。URL#pathname は既に 1 回エンコード
 * 済みの形なので、ここで rfc3986Encode を 1 回かけると計 2 回エンコードになる。
 * 本 kit の実パス (/prod/device/v1/...) は unreserved 文字のみで、エンコードは恒等。
 * @param {string} pathname URL#pathname (先頭 "/")
 * @returns {string}
 */
function canonicalUriOf(pathname) {
  if (!pathname || pathname === "/") return "/";
  return pathname.split("/").map((seg) => rfc3986Encode(seg)).join("/");
}

/**
 * canonical query string を組む。キー・値を UriEncode し、エンコード後のキー → 値の順で
 * バイト順ソートして "k=v" を "&" 連結する (AWS 仕様)。
 * @param {URLSearchParams} searchParams
 * @returns {string}
 */
function canonicalQueryOf(searchParams) {
  /** @type {Array<[string, string]>} */
  const pairs = [];
  for (const [k, v] of searchParams) pairs.push([rfc3986Encode(k), rfc3986Encode(v)]);
  pairs.sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
  );
  return pairs.map((p) => `${p[0]}=${p[1]}`).join("&");
}

/**
 * ヘッダ値の canonical 形: 前後空白を捨て、連続する space/tab を 1 space に潰す (AWS 仕様)。
 * @param {string} value
 * @returns {string}
 */
function canonicalHeaderValue(value) {
  // [ \t]+ は単一文字クラスの線形マッチ (ReDoS 不成立)。
  return String(value).trim().replace(/[ \t]+/g, " ");
}

/**
 * Date → SigV4 の日時表記 (ISO8601 basic, 例 20150830T123600Z)。
 * @param {Date} date
 * @returns {string}
 */
function amzDateOf(date) {
  const iso = date.toISOString(); // 2015-08-30T12:36:00.000Z
  return (
    iso.slice(0, 4) + iso.slice(5, 7) + iso.slice(8, 10) +
    "T" + iso.slice(11, 13) + iso.slice(14, 16) + iso.slice(17, 19) + "Z"
  );
}

/**
 * SigV4 署名鍵の導出: HMAC("AWS4"+secret, date) → region → service → "aws4_request" の連鎖
 * (AWS General Reference: Calculate the signature)。既知ベクタテストから個別検証できるよう export。
 * @param {{secretAccessKey: string, dateStamp: string, region: string, service: string}} p
 *   dateStamp は YYYYMMDD (UTC)。
 * @returns {Buffer} 署名鍵
 */
export function deriveSigningKey({ secretAccessKey, dateStamp, region, service }) {
  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

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
export function signRequest({
  method,
  url,
  headers = {},
  body = null,
  credentials,
  service = "execute-api",
  region = "ap-northeast-1",
  date = new Date(),
}) {
  if (!method || typeof method !== "string") throw badRequest("domain.aws.sigv4MethodRequired");
  if (!url || typeof url !== "string") throw badRequest("domain.aws.sigv4UrlRequired");
  if (!credentials?.accessKeyId || !credentials?.secretAccessKey) {
    throw badRequest("domain.aws.sigv4CredentialsRequired");
  }
  /** @type {URL} */
  let u;
  try {
    u = new URL(url);
  } catch {
    throw badRequest("domain.aws.sigv4UrlRequired");
  }

  const amzDate = amzDateOf(date);
  const dateStamp = amzDate.slice(0, 8);

  // ---- 署名対象ヘッダ (小文字キーへ正規化 + host/x-amz-date/security-token を追加) ----
  /** @type {Record<string, string>} */
  const headerMap = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v == null) continue;
    headerMap[k.toLowerCase()] = String(v);
  }
  if (!headerMap.host) headerMap.host = u.host;
  headerMap["x-amz-date"] = amzDate;
  if (credentials.sessionToken) headerMap["x-amz-security-token"] = credentials.sessionToken;

  const headerNames = Object.keys(headerMap).sort();
  const canonicalHeaders = headerNames
    .map((name) => `${name}:${canonicalHeaderValue(headerMap[name])}\n`)
    .join("");
  const signedHeaders = headerNames.join(";");

  // ---- canonical request ----
  const payloadHash = sha256Hex(body == null ? "" : body);
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUriOf(u.pathname),
    canonicalQueryOf(u.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  // ---- string to sign ----
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    ALGORITHM,
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  // ---- signature ----
  const signingKey = deriveSigningKey({
    secretAccessKey: credentials.secretAccessKey,
    dateStamp,
    region,
    service,
  });
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  const authorization =
    `${ALGORITHM} Credential=${credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    headers: { ...headerMap, authorization },
    canonicalRequest,
    stringToSign,
    signature,
    credentialScope,
    signedHeaders,
    amzDate,
  };
}
