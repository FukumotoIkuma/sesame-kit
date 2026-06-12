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
export function makeCognitoCredentialsProvider({ getIdToken, identityPoolId, userPoolId, region, fetchImpl, refreshMarginMs, now, }?: {
    getIdToken: () => Promise<string>;
    identityPoolId?: string;
    userPoolId?: string;
    region?: string;
    fetchImpl?: typeof globalThis.fetch;
    refreshMarginMs?: number;
    now?: () => number;
}): CredentialsProviderLike & {
    clearCache: () => void;
};
/**
 * appidentifyid を新規生成する。形式は "ap-northeast-1:<安定 ID>"
 * (AppIdentifyIdUtil.kt:42 `"ap-northeast-1:" + getAndroidIdOrNull(context)`)。
 * Node には ANDROID_ID 相当のホスト固有 ID が無いため、ランダム UUID を初回生成して
 * 永続化する方式を採る (REFACTORING_PLAN P2-1 手順 3)。
 * @param {{uuid?: () => string}} [p] テスト用 UUID 注入口。
 * @returns {string}
 */
export function generateAppIdentifyId({ uuid }?: {
    uuid?: () => string;
}): string;
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
export function resolveAppIdentifyId({ appIdentifyId, config, configStore, uuid }?: {
    appIdentifyId?: string | null;
    config?: AppIdConfigLike | null;
    configStore?: AppIdConfigStoreLike | null;
    uuid?: () => string;
}): string;
/**
 * SigV4 + x-api-key (+ appidentifyid) 付きの REST transport を作る
 * (ApiClientConfigBuilder.kt:34-46 の ApiClientFactory 相当)。
 * devices.js makeRegisterTransport / access.js makeBiometricsTransport が共用する基盤。
 *
 * ── appidentifyid の per-op 化 (REFACTORING_PLAN バックログ8) ──
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
 * @experimental 実機 API Gateway での受理は未検証 (REFACTORING_PLAN §9 V4/V5)。
 *   ヘッダ構成 (SigV4 + x-api-key) は参照実装
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
export function makeApiGatewayTransport({ baseUrl, credentialsProvider, apiKey, appIdentifyId, region, service, fetchImpl, }: {
    baseUrl: string;
    credentialsProvider: CredentialsProviderLike;
    apiKey?: string;
    appIdentifyId?: string | null;
    region?: string;
    service?: string;
    fetchImpl?: typeof globalThis.fetch;
}): (req: {
    method: string;
    path: string;
    body?: object;
}) => Promise<{
    status: number;
    text: string;
    json: any;
}>;
/** Cognito Identity Pool ID (app.properties:8 aws.cognito.identityPoolId)。 */
export const IDENTITY_POOL_ID: "ap-northeast-1:0a1820f1-dbb3-4bca-9227-2a92f6abf0ae";
/** Cognito User Pool ID (app.properties:9 aws.cognito.userPoolId)。GetId の Logins キーに使う。 */
export const USER_POOL_ID: "ap-northeast-1_bY2byhlCa";
/** API Gateway の x-api-key (app.properties:5 aws.apigateway.apiKey → BaseApp.kt:100 BuildConfig.API_GATEWAY_API_KEY)。 */
export const API_GATEWAY_API_KEY: "iGgXj9GorS4PeH90mAysg1l7kdvoIPxM25mPFl3k";
/** 公式 REST ホスト (app.properties:3 candyhouse.sesame.api.prod = BuildConfig.ch_server)。 */
export const DEFAULT_CH_API_BASE_URL: "https://app.candyhouse.co/prod";
/**
 * Identity Pool から得る一時 credentials (getCredentials の戻り値)。
 */
export type AwsTemporaryCredentials = {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken: string;
    expiration: Date;
    identityId: string;
};
/**
 * 署名付き transport が要求する credentials 供給インターフェース
 * (Kotlin の AWSCredentialsProvider 相当。テストではこの shape の fake を注入できる)。
 */
export type CredentialsProviderLike = {
    getCredentials: () => Promise<AwsTemporaryCredentials>;
    clearCache?: (() => void) | undefined;
};
/**
 * appidentifyid の解決が要求する config の最小 shape (ConfigStore 非依存の duck typing)。
 */
export type AppIdConfigLike = {
    appIdentifyId?: string | null;
};
/**
 * appidentifyid の永続化が要求する store の最小 shape (config.js の ConfigStore が満たす)。
 */
export type AppIdConfigStoreLike = {
    load: () => AppIdConfigLike;
    save: () => void;
};
//# sourceMappingURL=aws-credentials.d.ts.map