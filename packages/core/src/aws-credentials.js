// Cognito Identity Pool の一時 AWS credentials 取得 + API Gateway 署名付き transport。
//
// 公式アプリの REST (API Gateway) 認可基盤の Node 移植:
//   - ApiClientConfigBuilder.kt:34-46 — ApiClientFactory()
//       .credentialsProvider(credentialsProvider).apiKey(apiKey).region("ap-northeast-1")
//   - ApiClientConfigBuilder.kt:51-61 — CognitoCachingCredentialsProvider(identityPoolId, region)
//   - BaseApp.kt:95-102 — setCHAPIClient(): credentialsProvider = AWSMobileClient.getInstance()
//     (= User Pool ログインを Identity Pool に連携した credentials), apiKey = API_GATEWAY_API_KEY
//   - AppIdentifyIdUtil.kt:26-48 — appidentifyid = "ap-northeast-1:" + ANDROID_ID (初回生成を永続化)
//
// 実装方針: @aws-sdk/client-cognito-identity を増やさず素 fetch + X-Amz-Target で呼ぶ
// (P2-2 の cognito-idp 生 HTTP 化と同方式)。GetId / GetCredentialsForIdentity は SigV4 署名
// 不要の匿名 API。取得した credentials は Expiration の手前 (refreshMarginMs) までメモリ
// キャッシュし、失効前に自動再取得する。
//
// P3-13: リトライ / タイムアウト実値 (R3:AUTH-04)
//   参照: _aws_sdk_ref/ClientConfiguration.java:33,36 —
//     DEFAULT_CONNECTION_TIMEOUT = 15_000 ms, DEFAULT_SOCKET_TIMEOUT = 15_000 ms
//   参照: _aws_sdk_ref/PredefinedRetryPolicies.java:50 — DEFAULT_MAX_ERROR_RETRY = 3
//   参照: _aws_sdk_ref/PredefinedRetryPolicies.java:154-194 — SDKDefaultRetryCondition:
//     HTTP 500/502/503/504 + Throttling / ThrottlingException /
//     ProvisionedThroughputExceededException + ネットワーク例外のみリトライ。
//     4xx Throttling 系はリトライ対象 (RetryUtils.java:34-41 — isThrottlingException)。
//     4xx 非 Throttling (NotAuthorizedException 等) はリトライ禁止。
//     タイムアウト (AbortError/TimeoutError) はリトライ禁止
//     (RetryUtils.java:82-101 — SocketTimeoutException は InterruptedIOException
//     サブクラスでリトライ除外)。
//   参照: _aws_sdk_ref/RetryUtils.java:34-41 — isThrottlingException errorCode 集合。
//   参照: _aws_sdk_ref/RetryUtils.java:82-101 — isInterrupted: SocketTimeoutException 除外。
//
// P3-15: identityId / credentials の tokens ストア永続化 (R3:AUTH-06)
//   参照: _aws_sdk_ref/CognitoCachingCredentialsProvider.java:86-98 — キー定数
//   参照: _aws_sdk_ref/CognitoCachingCredentialsProvider.java:473-505 — loadCachedCredentials
//   参照: _aws_sdk_ref/CognitoCachingCredentialsProvider.java:515-521 — refresh 後の saveCredentials
//   参照: _aws_sdk_ref/CognitoCachingCredentialsProvider.java:638-646 — saveCredentials
//   参照: _aws_sdk_ref/CognitoCachingCredentialsProvider.java:655-659 — saveIdentityId
//   永続化ストアの実値形式は tokens.json (0600) の aws_credentials キーに収める。
//   失効閾値 500s は既存実装と参照一致 (CognitoCredentialsProvider.java:67)。
//
// ★ 実機未検証マーカー: リクエスト形は AWS API 仕様 + 参照実装から導出したが、実機
//   API Gateway での受理は未検証。

import { randomUUID } from "node:crypto";
import { signRequest } from "./sigv4.js";
import { SesameError, ERR } from "./errors.js";
import { badRequest } from "./util.js";
import { t } from "./i18n.js";

// ---- P3-13: リトライ / タイムアウト実値 ----

/** ソケット / コネクションタイムアウト (参照: _aws_sdk_ref/ClientConfiguration.java:33,36)。 */
const AWS_TIMEOUT_MS = 15_000;
/** 最大リトライ回数 (参照: _aws_sdk_ref/PredefinedRetryPolicies.java:50)。 */
const AWS_MAX_RETRIES = 3;
/** 指数バックオフ基底 ms。 */
const AWS_RETRY_BASE_MS = 100;
/**
 * Throttling 系 errorCode (参照: _aws_sdk_ref/RetryUtils.java:34-41 — isThrottlingException)。
 * Cognito は 400 または 429 でこれらの __type を返す。リトライ対象
 * (PredefinedRetryPolicies.java:187-189)。
 */
const THROTTLING_CODES = new Set([
  "Throttling",
  "ThrottlingException",
  "ProvisionedThroughputExceededException",
]);

// ---- 実値 (_sesame_sdk_ref/app.properties にチェックイン済みの本番値) ----

/** AWS リージョン (ApiClientConfigBuilder.kt:18 DEFAULT_REGION)。 */
const AWS_REGION = "ap-northeast-1";
/** Cognito Identity Pool ID (app.properties:8 aws.cognito.identityPoolId)。 */
export const IDENTITY_POOL_ID = "ap-northeast-1:0a1820f1-dbb3-4bca-9227-2a92f6abf0ae";
/** Cognito User Pool ID (app.properties:9 aws.cognito.userPoolId)。GetId の Logins キーに使う。 */
export const USER_POOL_ID = "ap-northeast-1_bY2byhlCa";
/** API Gateway の x-api-key (app.properties:5 aws.apigateway.apiKey → BaseApp.kt:100 BuildConfig.API_GATEWAY_API_KEY)。 */
export const API_GATEWAY_API_KEY = "iGgXj9GorS4PeH90mAysg1l7kdvoIPxM25mPFl3k";
/** 公式 REST ホスト (app.properties:3 candyhouse.sesame.api.prod = BuildConfig.ch_server)。 */
export const DEFAULT_CH_API_BASE_URL = "https://app.candyhouse.co/prod";

/**
 * credentials を Expiration の何 ms 手前から失効扱いにするか。
 * 参照: CognitoCredentialsProvider.java:67 `DEFAULT_THRESHOLD_SECONDS = 500`
 *      CognitoCredentialsProvider.java:853-863 `needsNewSession()` —
 *        `timeRemaining < (refreshThreshold * 1000)` = 500 * 1000 ms = 500_000 ms
 */
const DEFAULT_REFRESH_MARGIN_MS = 500_000;

/**
 * Identity Pool から得る一時 credentials (getCredentials の戻り値)。
 * @typedef {Object} AwsTemporaryCredentials
 * @property {string} accessKeyId
 * @property {string} secretAccessKey
 * @property {string} sessionToken
 * @property {Date} expiration
 * @property {string} identityId
 */

/**
 * 署名付き transport が要求する credentials 供給インターフェース
 * (Kotlin の AWSCredentialsProvider 相当。テストではこの shape の fake を注入できる)。
 * @typedef {Object} CredentialsProviderLike
 * @property {() => Promise<AwsTemporaryCredentials>} getCredentials
 * @property {() => void} [clearCache]
 */

/**
 * appidentifyid の解決が要求する config の最小 shape (ConfigStore 非依存の duck typing)。
 * @typedef {{ appIdentifyId?: string|null }} AppIdConfigLike
 */
/**
 * appidentifyid の永続化が要求する store の最小 shape (config.js の ConfigStore が満たす)。
 * @typedef {{ load: () => AppIdConfigLike, save: () => void }} AppIdConfigStoreLike
 */

/**
 * Cognito Identity (cognito-identity.<region>.amazonaws.com) の匿名 API を呼ぶ。
 * AWS JSON 1.1 プロトコル: POST / + X-Amz-Target: AWSCognitoIdentityService.<Op>。
 * エラー応答は {__type, message} で返るため、__type を含む SesameError に写像する。
 *
 * P3-13: AbortSignal.timeout (15s) + 5xx/Throttling/ネットワーク例外で最大 3 回リトライ
 * (参照: _aws_sdk_ref/ClientConfiguration.java:33,36 / PredefinedRetryPolicies.java:50)。
 * NotAuthorizedException 等の 4xx はリトライ禁止。
 *
 * @param {{fetchImpl: typeof globalThis.fetch, region: string, op: string, payload: object,
 *          timeoutMs?: number, maxRetries?: number}} p
 * @returns {Promise<any>} パース済み応答 JSON
 */
async function cognitoIdentityCall({
  fetchImpl, region, op, payload,
  timeoutMs = AWS_TIMEOUT_MS,
  maxRetries = AWS_MAX_RETRIES,
}) {
  const url = `https://cognito-identity.${region}.amazonaws.com/`;
  const init = {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": `AWSCognitoIdentityService.${op}`,
    },
    body: JSON.stringify(payload),
  };

  let res;
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const cap = AWS_RETRY_BASE_MS * 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.random() * cap));
    }
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      res = await fetchImpl(url, { ...init, signal });
    } catch (e) {
      lastErr = e;
      // AbortError (ユーザキャンセル) / TimeoutError (AbortSignal.timeout 発火) は
      // リトライ禁止 (参照: RetryUtils.java:82-101 — SocketTimeoutException は
      // InterruptedIOException サブクラスでリトライ除外)。
      const name = /** @type {any} */ (e)?.name;
      if (name === "AbortError" || name === "TimeoutError" || attempt >= maxRetries) throw e;
      continue; // ネットワーク例外 (TypeError 等) — リトライ対象 (参照: IOException)
    }
    // 5xx: リトライ対象 (参照: PredefinedRetryPolicies.java:174-179 — 500/502/503/504)
    if (res.status >= 500 && attempt < maxRetries) {
      lastErr = new Error(`HTTP ${res.status}`);
      continue;
    }
    // 4xx: Throttling 系のみリトライ対象
    // (参照: PredefinedRetryPolicies.java:187-189 — isThrottlingException)
    if (res.status >= 400 && res.status < 500 && attempt < maxRetries) {
      let throttleCode = "";
      try {
        const cloneText = await res.clone().text();
        const parsed = cloneText ? JSON.parse(cloneText) : {};
        const rawType = typeof parsed.__type === "string" ? parsed.__type : "";
        throttleCode = rawType.split("#").pop() ?? "";
      } catch { /* パース失敗は非 Throttling として扱う */ }
      if (THROTTLING_CODES.has(throttleCode)) {
        lastErr = new Error(`Throttling: ${throttleCode}`);
        continue;
      }
    }
    break;
  }
  if (!res) throw lastErr;

  const text = await res.text();
  /** @type {any} */
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body は下の status 判定で拒否 */ }

  const ok = typeof res.status === "number" && res.status >= 200 && res.status < 300;

  if (!ok || json?.__type) {
    // __type は "namespace#NotAuthorizedException" 形式のこともあるため "#" 以降を採る。
    const rawType = typeof json?.__type === "string" ? json.__type : "";
    const hashIdx = rawType.lastIndexOf("#");
    const type = (hashIdx >= 0 ? rawType.slice(hashIdx + 1) : rawType) || `HTTP ${res.status}`;
    const message = json?.message || json?.Message || text || "";
    throw new SesameError(
      t("domain.aws.cognitoIdentityError", { op, type, message }),
      {
        // NotAuthorizedException = idToken 失効/連携不可 → 再ログインで復帰する認証エラー。
        code: type === "NotAuthorizedException" ? ERR.UNAUTHENTICATED : ERR.REJECTED,
        data: { op, type },
      },
    );
  }
  return json;
}

/**
 * Expiration を epoch ms へ正規化する。GetCredentialsForIdentity の Expiration は
 * epoch 秒 (小数 double)。文字列日時も念のため受ける。
 * @param {unknown} v
 * @returns {number|null}
 */
function expirationMsOf(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v * 1000;
  if (typeof v === "string") {
    const ms = Date.parse(v);
    if (!Number.isNaN(ms)) return ms;
  }
  return null;
}

/**
 * P3-15 で永続化する AWS credentials の形。tokens.json の aws_credentials キーに収める。
 * 参照: _aws_sdk_ref/CognitoCachingCredentialsProvider.java:86-98 (AK_KEY/SK_KEY/ST_KEY/EXP_KEY 定数)。
 * @typedef {Object} PersistedAwsCredentials
 * @property {string} identityId
 * @property {string} accessKeyId
 * @property {string} secretAccessKey
 * @property {string} sessionToken
 * @property {number} expirationMs epoch ms (参照: CognitoCachingCredentialsProvider.java:644 — long time)
 */

/**
 * P3-15: credentialsStore が実装すべき最小インターフェース。
 * FileTokenStore の拡張や in-memory fake を注入できる duck-typing インターフェース。
 * @typedef {Object} CredentialsStoreLike
 * @property {() => PersistedAwsCredentials|null} loadAwsCredentials
 * @property {(c: PersistedAwsCredentials|null) => void} saveAwsCredentials
 */

/**
 * CognitoCachingCredentialsProvider 相当: User Pool の idToken を Identity Pool に連携し
 * (GetId → GetCredentialsForIdentity, logins = "cognito-idp.<region>.amazonaws.com/<userPoolId>")、
 * 一時 credentials を Expiration の refreshMarginMs 手前まで再利用する。
 *
 * P3-14: Identity Pool 再解決 (GetId やり直し) のトリガを参照に合わせ
 *   ResourceNotFoundException + ValidationException のみに修正。NotAuthorizedException は
 *   即時 throw する (unauthenticated 扱い)。
 *   参照: _aws_sdk_ref/CognitoCredentialsProvider.java:789-803 —
 *     catch (ResourceNotFoundException)   → retryGetCredentialsForIdentity()
 *     catch (AmazonServiceException) where errorCode == "ValidationException" → retry
 *     それ以外 (NotAuthorizedException 含む) → throw ase
 *
 * P3-15: identityId と credentials を credentialsStore へ永続化し、
 *   プロセス再起動後に GetId をスキップ。
 *   参照: _aws_sdk_ref/CognitoCachingCredentialsProvider.java:434-435 — initialize 内の読み込み
 *         _aws_sdk_ref/CognitoCachingCredentialsProvider.java:473-505 — loadCachedCredentials
 *         _aws_sdk_ref/CognitoCachingCredentialsProvider.java:515-521 — refresh 後の saveCredentials
 *         _aws_sdk_ref/CognitoCachingCredentialsProvider.java:638-646 — saveCredentials
 *         _aws_sdk_ref/CognitoCachingCredentialsProvider.java:655-659 — saveIdentityId
 *
 * idToken の供給はコールバック注入 (auth.js へ依存しない)。同時呼び出しは single-flight で
 * 1 回の取得に合流させる。
 *
 * @param {{
 *   getIdToken: () => Promise<string>,
 *   identityPoolId?: string,
 *   userPoolId?: string,
 *   region?: string,
 *   fetchImpl?: typeof globalThis.fetch,
 *   refreshMarginMs?: number,
 *   now?: () => number,
 *   credentialsStore?: CredentialsStoreLike|null,
 * }} p now はテスト用の時計注入口。credentialsStore は永続化ストア (省略で in-memory のみ)。
 * @returns {CredentialsProviderLike & {clearCache: () => void}}
 */
export function makeCognitoCredentialsProvider({
  getIdToken,
  identityPoolId = IDENTITY_POOL_ID,
  userPoolId = USER_POOL_ID,
  region = AWS_REGION,
  fetchImpl = globalThis.fetch,
  refreshMarginMs = DEFAULT_REFRESH_MARGIN_MS,
  now = Date.now,
  credentialsStore = null,
} = /** @type {any} */ ({})) {
  if (typeof getIdToken !== "function") throw badRequest("domain.aws.getIdTokenRequired");
  if (typeof fetchImpl !== "function") throw badRequest("domain.aws.fetchRequired");

  // Logins のキーは User Pool の provider 名 (AWS 仕様。値は当該 pool の idToken)。
  const loginKey = `cognito-idp.${region}.amazonaws.com/${userPoolId}`;

  /** @type {string|null} 解決済み IdentityId (GetId の結果。credentials より長寿命) */
  let identityId = null;
  /** @type {(AwsTemporaryCredentials & {expirationMs: number})|null} */
  let cached = null;
  /** @type {Promise<AwsTemporaryCredentials>|null} 進行中の取得 (single-flight) */
  let inflight = null;

  // P3-15: 起動時に永続化ストアから読み込む
  // (参照: CognitoCachingCredentialsProvider.java:434-435 getCachedIdentityId + loadCachedCredentials)
  if (credentialsStore) {
    try {
      const persisted = /** @type {PersistedAwsCredentials|null} */ (credentialsStore.loadAwsCredentials?.());
      if (persisted && typeof persisted.identityId === "string") {
        identityId = persisted.identityId;
        // 参照: CognitoCachingCredentialsProvider.java:473-505 — expirationKey 存在 + 全キー揃い
        if (
          persisted.accessKeyId && persisted.secretAccessKey &&
          persisted.sessionToken && typeof persisted.expirationMs === "number"
        ) {
          cached = {
            accessKeyId: persisted.accessKeyId,
            secretAccessKey: persisted.secretAccessKey,
            sessionToken: persisted.sessionToken,
            expiration: new Date(persisted.expirationMs),
            identityId: persisted.identityId,
            expirationMs: persisted.expirationMs,
          };
        }
      }
    } catch {
      // 破損ストアは無視して in-memory のみで続行
    }
  }

  /**
   * @param {Record<string, string>} logins
   * @returns {Promise<string>} IdentityId
   */
  async function resolveIdentityId(logins) {
    const r = await cognitoIdentityCall({
      fetchImpl, region, op: "GetId",
      payload: { IdentityPoolId: identityPoolId, Logins: logins },
    });
    if (typeof r?.IdentityId !== "string" || !r.IdentityId) {
      throw new SesameError(t("domain.aws.cognitoIdentityMalformed", { op: "GetId" }), {
        code: ERR.REJECTED, data: { op: "GetId" },
      });
    }
    return r.IdentityId;
  }

  /**
   * @param {string} id IdentityId
   * @param {Record<string, string>} logins
   * @returns {Promise<AwsTemporaryCredentials & {expirationMs: number}>}
   */
  async function fetchCredentialsFor(id, logins) {
    const r = await cognitoIdentityCall({
      fetchImpl, region, op: "GetCredentialsForIdentity",
      payload: { IdentityId: id, Logins: logins },
    });
    const c = r?.Credentials;
    const expirationMs = expirationMsOf(c?.Expiration);
    // 応答フィールド名は AWS 仕様どおり AccessKeyId / SecretKey / SessionToken / Expiration
    // (SecretAccessKey ではない点に注意)。
    if (!c?.AccessKeyId || !c?.SecretKey || !c?.SessionToken || expirationMs == null) {
      throw new SesameError(
        t("domain.aws.cognitoIdentityMalformed", { op: "GetCredentialsForIdentity" }),
        { code: ERR.REJECTED, data: { op: "GetCredentialsForIdentity" } },
      );
    }
    return {
      accessKeyId: c.AccessKeyId,
      secretAccessKey: c.SecretKey,
      sessionToken: c.SessionToken,
      expiration: new Date(expirationMs),
      identityId: typeof r?.IdentityId === "string" && r.IdentityId ? r.IdentityId : id,
      expirationMs,
    };
  }

  /** @returns {Promise<AwsTemporaryCredentials>} */
  async function refresh() {
    const idToken = await getIdToken();
    /** @type {Record<string, string>} */
    const logins = { [loginKey]: String(idToken) };

    let id = identityId ?? (await resolveIdentityId(logins));
    try {
      cached = await fetchCredentialsFor(id, logins);
    } catch (e) {
      // P3-14: recoverable = ResourceNotFoundException || ValidationException のみ。
      // NotAuthorizedException はリトライせず即 throw (参照一致)。
      // 参照: _aws_sdk_ref/CognitoCredentialsProvider.java:789-803 —
      //   catch (ResourceNotFoundException)   → retryGetCredentialsForIdentity() (常に)
      //   catch (AmazonServiceException) where errorCode == "ValidationException" → retry (常に)
      //   それ以外                             → throw ase
      // 参照は hadCachedIdentity ガードを持たない。GetId 直後でも recoverable 例外はリトライする。
      const type = e instanceof SesameError ? /** @type {{type?: string}|null} */ (e.data)?.type : null;
      const recoverable = type === "ResourceNotFoundException" || type === "ValidationException";
      if (!recoverable) throw e;
      identityId = null;
      id = await resolveIdentityId(logins);
      cached = await fetchCredentialsFor(id, logins);
    }
    identityId = cached.identityId;

    // P3-15: 取得後に永続化ストアへ保存
    // (参照: CognitoCachingCredentialsProvider.java:515-521, 638-646, 655-659)
    if (credentialsStore?.saveAwsCredentials) {
      try {
        credentialsStore.saveAwsCredentials(/** @type {PersistedAwsCredentials} */ ({
          identityId: cached.identityId,
          accessKeyId: cached.accessKeyId,
          secretAccessKey: cached.secretAccessKey,
          sessionToken: cached.sessionToken,
          expirationMs: cached.expirationMs,
        }));
      } catch {
        // 永続化失敗は in-memory キャッシュが残るので握り潰す
      }
    }

    return cached;
  }

  return {
    /** @returns {Promise<AwsTemporaryCredentials>} */
    async getCredentials() {
      if (cached && cached.expirationMs - refreshMarginMs > now()) return cached;
      if (!inflight) {
        inflight = refresh().finally(() => { inflight = null; });
      }
      return inflight;
    },
    /** キャッシュ破棄 (テスト・明示的な再取得用)。 */
    clearCache() {
      cached = null;
      identityId = null;
      if (credentialsStore?.saveAwsCredentials) {
        try { credentialsStore.saveAwsCredentials(null); } catch { /* ignore */ }
      }
    },
  };
}

// ---- appidentifyid (AppIdentifyIdUtil.kt 相当) ----

/**
 * appidentifyid を新規生成する。形式は "ap-northeast-1:<安定 ID>"
 * (AppIdentifyIdUtil.kt:42 `"ap-northeast-1:" + getAndroidIdOrNull(context)`)。
 * Node には ANDROID_ID 相当のホスト固有 ID が無いため、ランダム UUID を初回生成して
 * 永続化する方式を採る。
 * @param {{uuid?: () => string}} [p] テスト用 UUID 注入口。
 * @returns {string}
 */
export function generateAppIdentifyId({ uuid = randomUUID } = {}) {
  return `${AWS_REGION}:${uuid()}`;
}

/**
 * appidentifyid を解決する。優先順位: 明示注入 > config 保存値 > 新規生成。
 * 新規生成時は config オブジェクトへ書き戻す (AppIdentifyIdUtil.kt:35-45 の
 * SharedPreferences 永続化相当)。configStore を渡せば即 save し、config だけの場合は
 * in-memory 反映に留める (ConfigStore.load() はストア内部のキャッシュ実体を返すため、
 * 呼び出し側の次回 save() で永続化される)。
 *
 * @param {{appIdentifyId?: string|null, config?: AppIdConfigLike|null,
 *          configStore?: AppIdConfigStoreLike|null, uuid?: () => string}} [p]
 * @returns {string}
 */
export function resolveAppIdentifyId({ appIdentifyId, config, configStore, uuid } = {}) {
  if (appIdentifyId) return appIdentifyId;
  const cfg = config || (configStore ? configStore.load() : null);
  if (cfg?.appIdentifyId) return cfg.appIdentifyId;
  const generated = generateAppIdentifyId(uuid ? { uuid } : {});
  if (cfg) cfg.appIdentifyId = generated;
  if (configStore) {
    try { configStore.save(); } catch { /* 読み取り専用環境では in-memory のみ */ }
  }
  return generated;
}

// ---- 署名付き API Gateway transport (ApiClientFactory 相当) ----

/**
 * 末尾スラッシュを線形時間で除去 (正規表現 `/\/+$/` は ReDoS 回避のため使わない)。
 * @param {string} s
 * @returns {string}
 */
function stripTrailingSlashes(s) {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0x2f /* "/" */) end--;
  return s.slice(0, end);
}

/**
 * SigV4 + x-api-key (+ appidentifyid) 付きの REST transport を作る
 * (ApiClientConfigBuilder.kt:34-46 の ApiClientFactory 相当)。
 * devices.js makeRegisterTransport / access.js makeBiometricsTransport が共用する基盤。
 *
 * ── appidentifyid の per-op 化 ──
 * 参照では appidentifyid は transport 全体のヘッダではなく、CHAPIClient.kt の
 * `@Parameter(name="appidentifyid", location="header")` が付いたエンドポイントのみに乗る。
 * 全列挙 (出典: _sesame_sdk_ref/sesame-sdk/.../server/CHAPIClient.kt — 全 @Operation を確認):
 *
 *   | エンドポイント                                   | method | appidentifyid | 出典 (CHAPIClient.kt) |
 *   |--------------------------------------------------|--------|---------------|------------------------|
 *   | /device (updateKeys)                             | POST   | あり          | :22-26                 |
 *   | /device (putKey)                                 | PUT    | あり          | :29-33                 |
 *   | /device/list (getDevicesList)                    | GET    | あり          | :36-39                 |
 *   | /device (removeKey)                              | DELETE | あり          | :42-46                 |
 *   | /friend (addFriend)                              | POST   | あり          | :49-53                 |
 *   | /friend/token (uploadDeviceToken)                | POST   | あり          | :56-60                 |
 *   | /web_route (getWebUrlByScene)                    | POST   | あり          | :63-67                 |
 *   | /device/v1/iot/sesame2/{device_id}               | POST   | なし          | :70-74                 |
 *   | /device/v1/sesame2/{device_id} (register os2)    | POST   | なし          | :77-81                 |
 *   | /device/v1/sesame5/{device_id} (register os3)    | POST   | なし          | :84-88                 |
 *   | /device/v1/sesame2/historys (feedHistory)        | POST   | なし          | :91-92                 |
 *   | /device/v1/sesame2/sign (guestKeysSignPost)      | POST   | なし          | :95-96                 |
 *   | /device/v1/wifi_module/{device_id}/status        | GET    | なし          | :99-102                |
 *   | /device/v1/biometrics (biometricsOperation)      | POST   | なし          | :105-106               |
 *   | /device/v1/subscribe (subscribeToTopic)          | POST   | なし          | :109-110               |
 *   | /device/v1/sesame5/{device_id}/battery           | POST   | なし          | :113-117               |
 *   | /device/infor (postCHDeviceInfo)                 | POST   | なし          | :120-121               |
 *   | /device/v1/token (fcmTokenSignDelete)            | DELETE | なし          | :124-125               |
 *   | /device/v1/sesame5/{device_id}/fwVer             | POST   | なし          | :128-132               |
 *   | /device/v1/bot/script (updateBotScript)          | POST   | なし          | :135-136               |
 *   | /device/v1/wifi_module/{device_id}/switch        | POST   | なし          | :139-143               |
 *
 *   つまり「あり」は旧 API (/device 直下の鍵 CRUD・/device/list・/friend 系・/web_route) のみで、
 *   /device/v1/** と /device/infor には一切付かない。値は呼び出し側で
 *   AppIdentifyIdUtil.get() が都度供給される (CHAPIClientBiz.kt:85-88,99-115,117-134)。
 *
 *   本 kit の制御は **transport 構築時** の `appIdentifyId` フラグで行う (per-request の
 *   path 判定はしない): 「あり」エンドポイント用の transport を作るときだけ値を渡し、
 *   null/省略 (既定) ならヘッダ自体を付けない。register/sign 用 (devices.js
 *   makeRegisterTransport) と biometrics 用 (access.js makeBiometricsTransport) は
 *   上表どおり「なし」なので値を渡さない。
 *
 * @experimental 実機 API Gateway での受理は未検証。
 *   ヘッダ構成 (SigV4 + x-api-key) は参照実装
 *   (ApiClientConfigBuilder.kt:34-46, BaseApp.kt:95-102, AppIdentifyIdUtil.kt:42) から導出。
 *
 * P3-13: AbortSignal.timeout (15s) + 5xx / Throttling (Throttling / ThrottlingException /
 *   ProvisionedThroughputExceededException) / ネットワーク例外で最大 3 回リトライ。
 *   タイムアウト (AbortError/TimeoutError) はリトライ禁止。
 *   Clock Skew 系 4xx (RequestTimeTooSkewed / RequestExpired / InvalidSignatureException /
 *   SignatureDoesNotMatch) は **意図的に非リトライ**: 署名はループ外で 1 回生成され
 *   X-Amz-Date が固定のため再送しても skew は解消せず、応答 Date からオフセットを取って
 *   再署名するのは本 transport の責務外。参照の isClockSkewError はリトライ対象だが
 *   ここでは意図的逸脱とする (本体実装 606-651 / 境界 spec AUTH-0086)。
 *   (参照: _aws_sdk_ref/ClientConfiguration.java:33,36 / PredefinedRetryPolicies.java:50 /
 *    RetryUtils.java:34-41,65-73,82-101)
 *
 * @param {{
 *   baseUrl: string,
 *   credentialsProvider: CredentialsProviderLike,
 *   apiKey?: string,
 *   appIdentifyId?: string|null,
 *   region?: string,
 *   service?: string,
 *   fetchImpl?: typeof globalThis.fetch,
 *   timeoutMs?: number,
 *   maxRetries?: number,
 * }} p
 * @returns {(req: {method: string, path: string, body?: object}) => Promise<{status: number, text: string, json: any}>}
 */
export function makeApiGatewayTransport({
  baseUrl,
  credentialsProvider,
  apiKey = API_GATEWAY_API_KEY,
  appIdentifyId = null,
  region = AWS_REGION,
  service = "execute-api",
  fetchImpl = globalThis.fetch,
  timeoutMs = AWS_TIMEOUT_MS,
  maxRetries = AWS_MAX_RETRIES,
}) {
  if (!baseUrl || typeof baseUrl !== "string") throw badRequest("domain.aws.baseUrlRequired");
  if (typeof credentialsProvider?.getCredentials !== "function") {
    throw badRequest("domain.aws.credentialsProviderRequired");
  }
  if (typeof fetchImpl !== "function") throw badRequest("domain.aws.fetchRequired");
  const base = stripTrailingSlashes(baseUrl); // パスと二重化させない

  return async ({ method, path, body }) => {
    // path 未指定で base + undefined = '...undefined' という無効 URL を作らない。
    if (typeof path !== "string" || !path) throw badRequest("domain.aws.pathRequired");
    const credentials = await credentialsProvider.getCredentials();
    const url = base + path;
    const bodyText = body != null ? JSON.stringify(body) : undefined;
    /** @type {Record<string, string>} */
    const headers = {
      "content-type": "application/json",
      // x-api-key: ApiClientFactory.apiKey() 相当 (BaseApp.kt:100 API_GATEWAY_API_KEY)。
      "x-api-key": apiKey,
    };
    // appidentifyid: per-op (バックログ8)。CHAPIClient.kt で @Parameter(name="appidentifyid")
    // が付くエンドポイント (上表「あり」) 用の transport にだけ構築時に値が渡る。
    // null (既定) ならヘッダ自体を付けない (/device/v1/** は参照にヘッダが無い)。
    if (appIdentifyId) headers.appidentifyid = appIdentifyId;
    const signed = signRequest({
      method,
      url,
      headers,
      body: bodyText ?? "",
      credentials,
      service,
      region,
    });

    // P3-13: リトライ付き fetch
    //   参照: ClientConfiguration.java:33,36 / PredefinedRetryPolicies.java:50
    //   注: SigV4 の clock-skew 系エラー (RequestTimeTooSkewed / InvalidSignatureException 等) は
    //   ここではリトライしない。署名はループ外で 1 回生成され X-Amz-Date が固定されるため、
    //   同一署名を再送しても skew は解消しない (正しく直すには応答 Date からオフセットを取って
    //   再署名する必要があり、本 transport の責務外)。throttling / 5xx / ネットワークのみリトライする。
    let res;
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const cap = AWS_RETRY_BASE_MS * 2 ** attempt;
        await new Promise((r) => setTimeout(r, Math.random() * cap));
      }
      try {
        const signal = AbortSignal.timeout(timeoutMs);
        res = await fetchImpl(url, { method, headers: signed.headers, body: bodyText, signal });
      } catch (e) {
        lastErr = e;
        // AbortError (ユーザキャンセル) / TimeoutError (AbortSignal.timeout 発火) は
        // リトライ禁止 (参照: RetryUtils.java:82-101 — SocketTimeoutException は
        // InterruptedIOException サブクラスでリトライ除外)。
        const name = /** @type {any} */ (e)?.name;
        if (name === "AbortError" || name === "TimeoutError" || attempt >= maxRetries) throw e;
        continue; // ネットワーク例外 (TypeError 等) — リトライ対象 (参照: IOException)
      }
      // 5xx: リトライ対象 (参照: PredefinedRetryPolicies.java:174-179 — 500/502/503/504)
      if (res.status >= 500 && attempt < maxRetries) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      // 4xx: Throttling 系のみリトライ対象
      // (参照: PredefinedRetryPolicies.java:187-189 — isThrottlingException)
      if (res.status >= 400 && res.status < 500 && attempt < maxRetries) {
        let errorCode = "";
        try {
          const cloneText = await res.clone().text();
          const parsed = cloneText ? JSON.parse(cloneText) : {};
          const rawType = typeof parsed.__type === "string" ? parsed.__type : "";
          errorCode = rawType.split("#").pop() ?? "";
        } catch { /* パース失敗は非リトライとして扱う */ }
        if (THROTTLING_CODES.has(errorCode)) {
          lastErr = new Error(`Throttling: ${errorCode}`);
          continue;
        }
      }
      break;
    }
    if (!res) throw lastErr;

    const text = await res.text();
    /** @type {any} */
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body は text で返す */ }
    return { status: res.status, text, json };
  };
}
