// Cognito Identity Provider を素の HTTP (fetch) で呼ぶ互換層。
//
// 背景:
//   auth.js が使う Cognito API は現在 8 種 (InitiateAuth / RespondToAuthChallenge / SignUp /
//   ConfirmDevice / ForgetDevice / RevokeToken / GetUser / UpdateUserAttributes) で、
//   すべて SigV4 署名不要の匿名 API。
//   (UpdateDeviceStatus は v1 P2-5 で撤去済み。GetUser / UpdateUserAttributes は P2-8 で追加。)
//   `@aws-sdk/client-cognito-identity-provider` (transitive 約 30 パッケージ) を引き込む必要はなく、
//   AWS JSON 1.1 プロトコルの素 fetch で完全置換できる。
//
// ワイヤ形状 (AWS JSON 1.1):
//   POST https://cognito-idp.<region>.amazonaws.com/
//   Content-Type: application/x-amz-json-1.1
//   X-Amz-Target: AWSCognitoIdentityProviderService.<Op>
//   body: リクエストパラメータの JSON
//
// エラー互換:
//   エラー応答 body の `__type` (例: "NotAuthorizedException"、
//   "com.amazonaws.cognito...#NotAuthorizedException" の "#" 付き形式もある) を
//   Error.name に写像する。これにより AWS SDK 時代の
//   `err.name === "NotAuthorizedException"` 等の既存ハンドラが無変更で動く。
//
// P3-13: リトライ / タイムアウト (R3:AUTH-04)
//   参照: _aws_sdk_ref/ClientConfiguration.java:33,36 —
//     DEFAULT_SOCKET_TIMEOUT = 15_000 ms
//     DEFAULT_CONNECTION_TIMEOUT = 15_000 ms
//   参照: _aws_sdk_ref/PredefinedRetryPolicies.java:50 —
//     DEFAULT_MAX_ERROR_RETRY = 3
//   参照: _aws_sdk_ref/PredefinedRetryPolicies.java:154-194 — SDKDefaultRetryCondition:
//     HTTP 500/502/503/504 + RetryUtils.isThrottlingException() (Throttling /
//     ThrottlingException / ProvisionedThroughputExceededException) + IOException のみ
//     リトライ対象。4xx 認証エラー (NotAuthorizedException 等) はリトライ禁止。
//     SocketTimeoutException (InterruptedIOException のサブクラス) はリトライ除外。
//   参照: _aws_sdk_ref/RetryUtils.java:34-41 — isThrottlingException の対象 errorCode 集合。
//   参照: _aws_sdk_ref/RetryUtils.java:82-101 — isInterrupted: SocketTimeoutException はリトライ除外。
//
// ★ 意図的逸脱: User-Agent ヘッダは Node fetch の既定のまま送出しない。
//   参照の Android SDK は `aws-sdk-android/2.77.0 Linux/...` を常時付与するが、
//   公式アプリの UA 模倣はサーバ側で挙動を変える可能性があり (サーバ実装非公開)、
//   かつ模倣値は実機と完全一致できない。UserContextData 非送出 (v2 P2-4) と同種の
//   意図的逸脱として注記する。 (P3-18b 文書化対象)

const DEFAULT_REGION = "ap-northeast-1";

// ---- P3-13: リトライ / タイムアウト実値 (参照: _aws_sdk_ref/ClientConfiguration.java:33,36) ----
/** ソケット/コネクションタイムアウト: 15,000ms (DEFAULT_SOCKET_TIMEOUT / DEFAULT_CONNECTION_TIMEOUT)。 */
const AWS_TIMEOUT_MS = 15_000;
/** 最大リトライ回数: 3 (DEFAULT_MAX_ERROR_RETRY)。初回試行を含まず 3 回追加試行。 */
const AWS_MAX_RETRIES = 3;
/** 指数バックオフ: 2^attempt * 100ms (SDK の FullJitterBackoffStrategy 相当)。 */
const AWS_RETRY_BASE_MS = 100;
/** throttling errorCode 集合 (参照: _aws_sdk_ref/RetryUtils.java:34-41 isThrottlingException)。 */
const THROTTLING_CODES = new Set(["Throttling", "ThrottlingException", "ProvisionedThroughputExceededException"]);

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
 * P3-13: AbortSignal.timeout (15s — ClientConfiguration.java:36 DEFAULT_SOCKET_TIMEOUT) +
 * 5xx / Throttling (Throttling / ThrottlingException / ProvisionedThroughputExceededException) /
 * ネットワーク例外のみ指数バックオフ最大 3 回リトライ
 * (DEFAULT_MAX_ERROR_RETRY=3 — PredefinedRetryPolicies.java:50)。
 * Throttling は 4xx でも来る (RetryUtils.java:34-41 — isThrottlingException)。
 * 4xx 非 Throttling エラー (NotAuthorizedException 等) と タイムアウト (AbortError/TimeoutError)
 * はリトライ禁止 (RetryUtils.java:82-101 — SocketTimeoutException は InterruptedIOException
 * サブクラスでリトライ除外)。
 *
 * @param {string} op オペレーション名 (例: "InitiateAuth")。X-Amz-Target の末尾になる。
 * @param {object} payload リクエストパラメータ (AWS SDK の Command input と同形)
 * @param {{ region?: string, fetchImpl?: typeof fetch, timeoutMs?: number, maxRetries?: number }} [opts]
 * @returns {Promise<CognitoResponse>}
 * @throws {Error} エラー応答時。`name` に Cognito の例外名 (__type の "#" 以降) を写像。
 */
export async function cognitoCall(op, payload, {
  region = DEFAULT_REGION,
  fetchImpl,
  timeoutMs = AWS_TIMEOUT_MS,
  maxRetries = AWS_MAX_RETRIES,
} = {}) {
  const doFetch = fetchImpl ?? fetch;
  const url = `https://cognito-idp.${region}.amazonaws.com/`;
  const init = {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `AWSCognitoIdentityProviderService.${op}`,
    },
    body: JSON.stringify(payload ?? {}),
  };


  // 1 回目試行。5xx / Throttling はリトライループへ。
  let resp;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const cap = AWS_RETRY_BASE_MS * 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.random() * cap));
    }
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      resp = await doFetch(url, { ...init, signal });
    } catch (e) {
      lastErr = e;
      // AbortError (ユーザキャンセル) / TimeoutError (AbortSignal.timeout 発火) は
      // リトライ禁止 (参照: RetryUtils.java:82-101 — SocketTimeoutException は
      // InterruptedIOException サブクラスでリトライ除外)。
      const name = /** @type {any} */ (e)?.name;
      if (name === "AbortError" || name === "TimeoutError" || attempt >= maxRetries) throw e;
      // ネットワーク例外 (TypeError 等): リトライ対象 (参照: IOException)
      continue;
    }

    // 5xx: リトライ対象 (参照: PredefinedRetryPolicies.java:174-179 — 500/502/503/504)
    if (resp.status >= 500 && attempt < maxRetries) {
      lastErr = new Error(`HTTP ${resp.status}`);
      continue;
    }

    // 4xx: Throttling 系のみリトライ対象
    // (参照: PredefinedRetryPolicies.java:187-189 — isThrottlingException)
    // body はストリームを一度だけ読むため clone() で先読みして判定する。
    if (resp.status >= 400 && resp.status < 500 && attempt < maxRetries) {
      let throttleCode = "";
      try {
        const cloneText = await resp.clone().text();
        const parsed = cloneText ? JSON.parse(cloneText) : {};
        const rawType = typeof parsed.__type === "string" ? parsed.__type : "";
        throttleCode = rawType.split("#").pop() ?? "";
      } catch { /* パース失敗は非 Throttling として扱う */ }
      if (THROTTLING_CODES.has(throttleCode)) {
        lastErr = new Error(`Throttling: ${throttleCode}`);
        continue;
      }
    }

    break; // 成功 or 非 Throttling 4xx は確定
  }
  if (!resp) throw lastErr;

  const text = await resp.text();
  /** @type {Record<string, unknown>} */
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      // 非 JSON 応答 (ゲートウェイエラー等)。ok ならそのまま空 body、エラーなら下で扱う。
      body = {};
    }
  }

  if (!resp.ok) {
    // __type は "NotAuthorizedException" の素形と
    // "com.amazonaws.cognito.idp...#NotAuthorizedException" の "#" 付き形式の両方がある。
    const rawType = typeof body.__type === "string" ? body.__type : "";
    const name = rawType.split("#").pop() || "CognitoHttpError";
    // メッセージのキーは "message" が標準だが、一部 API は "Message" を返す。
    const message =
      (typeof body.message === "string" && body.message) ||
      (typeof body.Message === "string" && body.Message) ||
      `Cognito ${op} failed: HTTP ${resp.status}`;
    const err = new Error(message);
    err.name = name; // 既存の `err.name === "NotAuthorizedException"` 等のハンドラ互換
    throw err;
  }

  return /** @type {CognitoResponse} */ (body);
}
