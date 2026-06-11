// Cognito Identity Pool の一時 AWS credentials 取得 + API Gateway 署名付き transport。
//
// 公式アプリの REST (API Gateway) 認可基盤の Node 移植 (REFACTORING_PLAN P2-1):
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
// キャッシュし、失効前に自動再取得する (CognitoCachingCredentialsProvider 相当)。
//
// ★ 実機未検証マーカー: リクエスト形は AWS API 仕様 + 参照実装から導出したが、実機
//   API Gateway での受理は未検証 (REFACTORING_PLAN §9 V4/V5)。

import { randomUUID } from "node:crypto";
import { signRequest } from "./sigv4.js";
import { SesameError, ERR } from "./errors.js";
import { badRequest } from "./util.js";
import { t } from "./i18n.js";

// ---- 実値 (_sesame_sdk_ref/app.properties にチェックイン済みの本番値) ----

/** AWS リージョン (ApiClientConfigBuilder.kt:18 DEFAULT_REGION)。 */
export const AWS_REGION = "ap-northeast-1";
/** Cognito Identity Pool ID (app.properties:8 aws.cognito.identityPoolId)。 */
export const IDENTITY_POOL_ID = "ap-northeast-1:0a1820f1-dbb3-4bca-9227-2a92f6abf0ae";
/** Cognito User Pool ID (app.properties:9 aws.cognito.userPoolId)。GetId の Logins キーに使う。 */
export const USER_POOL_ID = "ap-northeast-1_bY2byhlCa";
/** API Gateway の x-api-key (app.properties:5 aws.apigateway.apiKey → BaseApp.kt:100 BuildConfig.API_GATEWAY_API_KEY)。 */
export const API_GATEWAY_API_KEY = "iGgXj9GorS4PeH90mAysg1l7kdvoIPxM25mPFl3k";
/** 公式 REST ホスト (app.properties:3 candyhouse.sesame.api.prod = BuildConfig.ch_server)。 */
export const DEFAULT_CH_API_BASE_URL = "https://app.candyhouse.co/prod";

/** credentials を Expiration の何 ms 手前から失効扱いにするか (余裕 60s)。 */
const DEFAULT_REFRESH_MARGIN_MS = 60_000;

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
 * Cognito Identity (cognito-identity.<region>.amazonaws.com) の匿名 API を 1 回呼ぶ。
 * AWS JSON 1.1 プロトコル: POST / + X-Amz-Target: AWSCognitoIdentityService.<Op>。
 * エラー応答は {__type, message} で返るため、__type を含む SesameError に写像する。
 *
 * @param {{fetchImpl: typeof globalThis.fetch, region: string, op: string, payload: object}} p
 * @returns {Promise<any>} パース済み応答 JSON
 */
async function cognitoIdentityCall({ fetchImpl, region, op, payload }) {
  const res = await fetchImpl(`https://cognito-identity.${region}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": `AWSCognitoIdentityService.${op}`,
    },
    body: JSON.stringify(payload),
  });
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
 * CognitoCachingCredentialsProvider 相当: User Pool の idToken を Identity Pool に連携し
 * (GetId → GetCredentialsForIdentity, logins = "cognito-idp.<region>.amazonaws.com/<userPoolId>")、
 * 一時 credentials を Expiration の refreshMarginMs 手前までメモリキャッシュする。
 *
 * idToken の供給はコールバック注入 (auth.js へ依存しない)。同時呼び出しは single-flight で
 * 1 回の取得に合流させる。IdentityId もキャッシュし、失効 (ResourceNotFound / NotAuthorized)
 * を検出したら GetId からやり直す (Android SDK の identityId 再解決と同じ振る舞い)。
 *
 * @param {{
 *   getIdToken: () => Promise<string>,
 *   identityPoolId?: string,
 *   userPoolId?: string,
 *   region?: string,
 *   fetchImpl?: typeof globalThis.fetch,
 *   refreshMarginMs?: number,
 *   now?: () => number,
 * }} p now はテスト用の時計注入口。
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

    const hadCachedIdentity = identityId != null;
    let id = identityId ?? (await resolveIdentityId(logins));
    try {
      cached = await fetchCredentialsFor(id, logins);
    } catch (e) {
      // キャッシュ済み IdentityId が server 側で消えていた/連携が切れていた場合のみ、
      // GetId からやり直して 1 回だけ再試行する (CognitoCachingCredentialsProvider の
      // identityId 再解決相当)。GetId 直後の失敗はそのまま投げる。
      const type = e instanceof SesameError ? /** @type {{type?: string}|null} */ (e.data)?.type : null;
      const recoverable = type === "ResourceNotFoundException" || type === "NotAuthorizedException";
      if (!hadCachedIdentity || !recoverable) throw e;
      identityId = null;
      id = await resolveIdentityId(logins);
      cached = await fetchCredentialsFor(id, logins);
    }
    identityId = cached.identityId;
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
    },
  };
}

// ---- appidentifyid (AppIdentifyIdUtil.kt 相当) ----

/**
 * appidentifyid を新規生成する。形式は "ap-northeast-1:<安定 ID>"
 * (AppIdentifyIdUtil.kt:42 `"ap-northeast-1:" + getAndroidIdOrNull(context)`)。
 * Node には ANDROID_ID 相当のホスト固有 ID が無いため、ランダム UUID を初回生成して
 * 永続化する方式を採る (REFACTORING_PLAN P2-1 手順 3)。
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
 * @experimental 実機 API Gateway での受理は未検証 (REFACTORING_PLAN §9 V4/V5)。
 *   ヘッダ構成 (SigV4 + x-api-key + appidentifyid) は参照実装
 *   (ApiClientConfigBuilder.kt:34-46, BaseApp.kt:95-102, AppIdentifyIdUtil.kt:42) から導出。
 *
 * @param {{
 *   baseUrl: string,
 *   credentialsProvider: CredentialsProviderLike,
 *   apiKey?: string,
 *   appIdentifyId?: string|null,
 *   region?: string,
 *   service?: string,
 *   fetchImpl?: typeof globalThis.fetch,
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
    // appidentifyid: CHAPIClient.kt:24 ほかの @Parameter(name="appidentifyid", location="header")。
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
    const res = await fetchImpl(url, { method, headers: signed.headers, body: bodyText });
    const text = await res.text();
    /** @type {any} */
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body は text で返す */ }
    return { status: res.status, text, json };
  };
}
