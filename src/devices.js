// SESAME デバイス管理 (history / battery / status / firmware / webapi proxy)。
//
// Ported from biz3 (CANDY-HOUSE/biz3, MIT):
//   - vendor reference: references_web/src/api/useManageDevice.js
//   - vendor reference: references_web/src/api/useManageGroup.js (getHistory)
//   - vendor reference: references_web/src/api/useDeveloper.js (firmware, invokeAPI)
//   - vendor reference: references_web/src/components/MobileBatteryChart.js (battery)
//
// 既存 client.js の listDevices() (getCompanyDevice) はそのまま残し、
// 個人ユーザ向けの getUserDevice、CRUD、履歴系をここに集める。

import { ACTION_TYPES } from "../vendor/biz3/constants/messageConstants.js";
import { assertSuccess, subscribeChunks, badRequest, timeoutError, rejected } from "./util.js";
import { t } from "./i18n.js";
import { productTypeFromModelName } from "./crypto.js";
import { getValidIdToken } from "./auth.js";

/**
 * 下位 WS トランスポート。完全な型は transport.js の Hub3WsClient。
 * @typedef {import("./transport.js").Hub3WsClient} WsClient
 */

/**
 * REST register transport の応答。
 * @typedef {Object} RegisterResponse
 * @property {number} [status]
 * @property {string} [text]
 * @property {*} [json]
 */

/**
 * REST register transport の呼び出しシグネチャ。
 * @typedef {(req: {method: string, path: string, body?: object}) => Promise<RegisterResponse>} RegisterTransport
 */

// action 文字列は vendor (biz3 messageConstants) から引く (手書きしない)。
const ACT_MANAGE = ACTION_TYPES.BIZ3_MANAGE_DEVICE;       // "biz3ManageDevice"
const ACT_HISTORY = ACTION_TYPES.BIZ3_GET_DEVICEHISTORY;  // "biz3GetDeviceHistory"
const ACT_BATTERY = ACTION_TYPES.BIZ3_GET_BATTERY_RECORD; // "biz3GetDeviceBatteryRecord"
const ACT_FIRMWARE = ACTION_TYPES.BIZ3_LIST_FIRMWARE;     // "biz3ListFirmware"
const ACT_WEBAPI = ACTION_TYPES.BIZ3_INVOKE_WEBAPI;       // "biz3InvokeWebAPIs"
const ACT_TRIGGER = ACTION_TYPES.BIZ3_TRIGGER_LOCKER;     // "biz3TriggerLocker" (state push)
const DEFAULT_TIMEOUT_MS = 10_000;

// ---------- device CRUD (biz3ManageDevice) ----------

/**
 * 個人ユーザのデバイス一覧。companyID 不要。
 * @param {WsClient} client
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<any[]>}
 */
export async function getUserDevices(client, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  // biz3 PubedUserDevice は page 単位 push (vendor 確認: useManageDevice.js:38-55):
  //   message.data = { totalPage, data: { list, page } }
  // page===1 で全置換、page>1 で追記、totalPage===page で完了。単発 resolve だと複数
  // ページのデバイスを取りこぼすため、全 page を蓄積して返す。
  /** @type {any[]} */
  let acc = [];
  return subscribeChunks(client, {
    sendFrame: { action: ACT_MANAGE, op: "getUserDevice" },
    timeoutMs,
    onTimeout: () => timeoutError(t("domain.devices.getUserDeviceTimeout")),
    result: () => acc,
    subscriptions: [{
      key: `${ACT_MANAGE}:PubedUserDevice`,
      /** @param {any} msg @param {(err?: Error) => void} finish */
      onMessage: (msg, finish) => {
        const totalPage = msg?.data?.totalPage;
        const inner = msg?.data?.data ?? {};
        const page = inner.page ?? 1;
        acc = page === 1 ? [...(inner.list ?? [])] : [...acc, ...(inner.list ?? [])];
        // totalPage が無ければ単一 chunk とみなし即完了 (vendor も totalPage===page で確定)。
        if (typeof totalPage !== "number" || page >= totalPage) finish();
      },
    }],
  });
}

/**
 * 単機の現在状態 (ロック開閉、電池等)。biz3 では isFromApp=true 限定だが CLI でも投げてみる価値あり。
 *
 * vendor は応答 `data` を配列で受けるが、**消費するのは先頭要素のみ** (単一デバイスの状態)。
 *   references_web/src/api/useManageDevice.js:84
 *     setDeviceStatus(message.data?.length > 0 ? message.data[0] : null);
 * よって生の transport 配列を露出せず vendor と同じ「単一 device-status または null」を返す
 * (配列を返すと全消費者に `[0]` を強要し、2 要素目が来ない契約が暗黙になる)。
 *
 * @param {WsClient} client
 * @param {{deviceUUID: string}} p
 * @returns {Promise<object|null>} 単一の device-status (devices 一覧の 1 要素と同形)、無ければ null
 */
export async function getDeviceStatus(client, { deviceUUID }) {
  const resp = await client.request(
    { action: ACT_MANAGE, op: "getDeviceStatus", deviceUUID },
    DEFAULT_TIMEOUT_MS,
  );
  assertSuccess(resp, "getDeviceStatus", { strict: true });
  return Array.isArray(resp.data) && resp.data.length > 0 ? resp.data[0] : null;
}

/**
 * デバイス名変更。subUUID は呼び出し側 (client.js) が持つ。
 * @param {WsClient} client
 * @param {{subUUID: string, deviceUUID: string, deviceName: string}} p
 */
export async function updateDeviceName(client, { subUUID, deviceUUID, deviceName }) {
  const resp = await client.request(
    {
      action: ACT_MANAGE,
      op: "updateName",
      obj: { subUUID, deviceUUID, deviceName },
    },
    DEFAULT_TIMEOUT_MS,
  );
  assertSuccess(resp, "updateDeviceName", { strict: true });
  return resp;
}

/**
 * デバイスを company から削除。items=[{deviceUUID,...}]
 * @param {WsClient} client
 * @param {{companyID: string, items: Array<{deviceUUID: string}>}} p
 */
export async function deleteDevices(client, { companyID, items }) {
  const resp = await client.request(
    { action: ACT_MANAGE, op: "del", companyID, items },
    DEFAULT_TIMEOUT_MS,
  );
  assertSuccess(resp, "deleteDevices", { strict: true });
  return resp;
}

/**
 * デバイス state push を購読。subscribeDevicesUpdate (biz3ManageDevice) を投げて購読要求し、
 * 実際の state push は **`biz3TriggerLocker:pubDeviceStateChange`** で届く。
 *
 * 注 (監査で修正): 購読要求の op は biz3ManageDevice/subscribeDevicesUpdate
 * (useManageDevice.js:325) だが、**応答の push は別 action/op** で来る:
 * biz3 は `biz3TriggerLocker` action の `pubDeviceStateChange` (小文字, useIotCtrl.js:11,21)
 * として state 変化を流す。push 本体は `data = {deviceUUID, stateInfo}`。
 * 旧実装は `biz3ManageDevice:PubedDeviceStateChange` (大文字 P・別 action) を購読しており
 * push を1件も受信できなかった。
 *
 * **既知の制限**: biz3 プロトコルに `unsubscribeDevicesUpdate` op は無いため、
 * unsubscribe()/close() 後もサーバ側 push は止まらない (ローカルで無視するだけ)。
 *
 * @param {WsClient} client
 * @param {{companyID: string, items: any[], onUpdate: (msg: any) => void}} p
 * @returns {() => void} unsubscribe
 */
export function subscribeDevicesUpdate(client, { companyID, items, onUpdate }) {
  client.send({ action: ACT_MANAGE, op: "subscribeDevicesUpdate", items, companyID });
  return client.subscribe(`biz3TriggerLocker:pubDeviceStateChange`, (msg) => {
    try { onUpdate(msg); } catch { /* ignore */ }
  });
}

// ---------- history ----------

/**
 * ロックの開閉履歴を取得。`list` はデバイス指定の配列。
 * @param {WsClient} client
 * @param {{companyID:string, list:any[], pageSize?:number|null}} p
 */
export async function getDeviceHistory(client, { companyID, list, pageSize = null }) {
  const resp = await client.request(
    { action: ACT_HISTORY, op: "getHistory", companyID, list, pageSize },
    DEFAULT_TIMEOUT_MS,
  );
  assertSuccess(resp, "getDeviceHistory", { strict: true });
  return resp.data;
}

/**
 * 開閉履歴の1エントリを非表示化 (論理削除)。
 * biz3 useManageGroup.js makeInvisibleHistory: フラット {action, deviceUUID, timestamp, op}。
 * @param {WsClient} client
 * @param {{deviceUUID:string, timestamp:number}} p
 */
export async function makeHistoryInvisible(client, { deviceUUID, timestamp }) {
  const resp = await client.request(
    { action: ACT_HISTORY, op: "makeInvisible", deviceUUID, timestamp },
    DEFAULT_TIMEOUT_MS,
  );
  assertSuccess(resp, "makeHistoryInvisible");
  return resp;
}

// ---------- battery ----------

/**
 * 電池履歴を取得。DynamoDB の lastEvaluatedKey でページング。
 * 1 回呼ぶごとに 1 ページ分。null → 最新ページ。
 * 戻り値: { records: [{ts, light, heavy, lightPercentage, heavyPercentage}], lastEvaluatedKey }
 * @param {WsClient} client
 * @param {{deviceUUID:string, lastEvaluatedKey?:unknown, pageSize?:number}} p
 */
export async function getBatteryRecord(client, { deviceUUID, lastEvaluatedKey = null, pageSize = 100 }) {
  const resp = await client.request(
    { action: ACT_BATTERY, op: "batch-get", deviceUUID, lastEvaluatedKey, pageSize },
    DEFAULT_TIMEOUT_MS,
  );
  assertSuccess(resp, "getBatteryRecord", { strict: true });
  return resp.data || { records: [], lastEvaluatedKey: null };
}

/**
 * 電池履歴の1エントリを非表示化 (論理削除)。
 * biz3 MobileBatteryChart.js makeInvisibleRecord: フラット {action, deviceUUID, timestamp_second, op}。
 * @param {WsClient} client
 * @param {{deviceUUID:string, timestampSecond:number}} p
 */
export async function makeBatteryRecordInvisible(client, { deviceUUID, timestampSecond }) {
  const resp = await client.request(
    { action: ACT_BATTERY, op: "makeInvisible", deviceUUID, timestamp_second: timestampSecond },
    DEFAULT_TIMEOUT_MS,
  );
  assertSuccess(resp, "makeBatteryRecordInvisible");
  return resp;
}

// ---------- firmware ----------

/**
 * 配信中ファームウェア一覧。
 * @param {WsClient} client
 * @returns {Promise<any[]>}
 */
export async function listFirmware(client) {
  // この op は op フィールド無し (action のみ)。応答は単発 push (`${ACT_FIRMWARE}:`)。
  /** @type {any[]} */
  let data = [];
  return subscribeChunks(client, {
    sendFrame: { action: ACT_FIRMWARE },
    timeoutMs: DEFAULT_TIMEOUT_MS,
    onTimeout: () => timeoutError(t("domain.devices.listFirmwareTimeout")),
    result: () => data,
    subscriptions: [{
      key: `${ACT_FIRMWARE}:`,
      /** @param {any} msg @param {(err?: Error) => void} finish */
      onMessage: (msg, finish) => { data = msg?.data || []; finish(); },
    }],
  });
}

// ---------- webapi proxy ----------

/**
 * biz3InvokeWebAPIs 経由で REST WebAPI を呼ぶ。
 * func 例: 'webapi_ssm_shadow_get', 'webapi_history_get', 'webapi_cmd_send'。
 * apiKeyId は別途 biz3 の dev console で発行されたもの。
 *
 * @param {WsClient} client
 * @param {{func:string, apiKeyId:string, query?:object, body?:object}} p
 */
export async function invokeWebAPI(client, { func, apiKeyId, query = {}, body = {} }) {
  const resp = await client.request(
    { action: ACT_WEBAPI, op: func, apiKeyId, query, body },
    DEFAULT_TIMEOUT_MS,
  );
  assertSuccess(resp, `invokeWebAPI(${func})`, { strict: true });
  return resp.data;
}

// ---------- 便利ラッパ (WebAPI 経由の高頻度ユースケース) ----------

/**
 * WebAPI 経由で 単機の shadow state を取得。
 * @param {WsClient} client
 * @param {{apiKeyId: string, deviceId: string}} p
 */
export function webapiDeviceState(client, { apiKeyId, deviceId }) {
  return invokeWebAPI(client, {
    func: "webapi_ssm_shadow_get",
    apiKeyId,
    query: { device_id: deviceId },
  });
}

/**
 * WebAPI 経由で履歴を取得。
 * biz3 useDeveloper.js:67-80: query = {device_id, page:0, lg:5, isBiz:true}。
 * lg は言語コードの**数値 ID** (biz3 は 5 を渡す)。旧実装は "ja" (文字列) で誤り。
 * @param {WsClient} client
 * @param {{apiKeyId: string, deviceId: string, page?: number, lg?: number, isBiz?: boolean}} p
 */
export function webapiDeviceHistory(client, { apiKeyId, deviceId, page = 0, lg = 5, isBiz = true }) {
  return invokeWebAPI(client, {
    func: "webapi_history_get",
    apiKeyId,
    query: { device_id: deviceId, page, lg, isBiz },
  });
}

/**
 * WebAPI 経由でロック cmd 送信 (sign/history は呼び出し側で組み立て)。
 * @param {WsClient} client
 * @param {{apiKeyId: string, deviceId: string, cmd: unknown, sign: unknown, history: unknown}} p
 */
export function webapiSendCmd(client, { apiKeyId, deviceId, cmd, sign, history }) {
  return invokeWebAPI(client, {
    func: "webapi_cmd_send",
    apiKeyId,
    body: { device_id: deviceId, cmd, sign, history },
  });
}

// ---------- BLE デバイス登録 / 初期ペアリング REST API クライアント (reg-guestkey-sign-client) ----------
//
// ★★ 移植忠実性: 未確定 (UNVERIFIED PORT) ★★
//   このブロック (signGuestKey / registerSesame5) は OS3 デバイス登録 (SESAME5 系) の
//   REST API クライアントである。リクエスト整形 (パス / フィールド名 / 大文字化 / hex) は
//   原典 SDK の該当 Kotlin を 1:1 で移植したが、以下は **未照合**:
//     - REST ホスト (BuildConfig.ch_server)。SDK では gradle ext (candyhouse.sesame.api.*)
//       由来でリポジトリに焼き込まれておらず、biz3 web (aws-exports.js) も WS gateway しか
//       持たない。よって本番ホストは config 注入を必須とし、ここでは決め打ちしない。
//     - API Gateway の認証方式 (IAM SigV4 + Cognito identity pool か idToken Bearer か)。
//       SDK は ApiClientConfigBuilder で AWSCredentialsProvider (identity pool) を使うが、
//       本 kit の既存クラウド認証は Cognito idToken (getValidIdToken) のみ。ここでは既存
//       認証を再利用し Authorization: Bearer <idToken> を付すが、実機 API Gateway が
//       これを受理するかは E2E 未検証。
//   本ブロックは SesameBle の needAuthFromServer / registerTransport 経路から任意に呼ばれる。
//   BLE session-layer の登録ハンドシェイクは実装済みだが、この REST 認証方式そのものは
//   実機 OS3 register キャプチャで突き合わせるまで未検証として扱う。
//
// 原典 (CANDY-HOUSE SesameSDK):
//   co/candyhouse/sesame/server/CHAPIClient.kt:84-96 — エンドポイント定義:
//     POST /device/v1/sesame5/{device_id}  myDevicesRegisterSesame5Post(model, body)
//     POST /device/v1/sesame2/sign         guestKeysSignPost(body) : String
//   co/candyhouse/sesame/server/CHAPIClientBiz.kt:143-144,193-195 — 呼び出し:
//     signGuestKey(key) = guestKeysSignPost(key)
//     myDevicesRegisterSesame5Post(deviceId, body)
//   co/candyhouse/sesame/ble/os3/base/CHSesameOS3.kt:474-484 — signGuestKey 呼び出し:
//     CHRemoveSignKeyRequest(deviceId.uppercase(), mSesameToken.toHexString(), secretKey)
//     成功時 login(it.data) — つまり戻り値 String が session token (hex)。
//   co/candyhouse/sesame/ble/os3/CHHub3Device.kt:183-186 — register 呼び出し:
//     CHOS3RegisterReq(productModel.productType().toString(), serverSecret)
//   co/candyhouse/sesame/server/dto/CHHistoryUploadRequest.kt:8 — リクエスト DTO:
//     CHRemoveSignKeyRequest(deviceId, token, secretKey)  ← フィールド名そのまま
//   co/candyhouse/sesame/server/dto/CHSS2RegisterReq.kt:5 — リクエスト DTO:
//     CHOS3RegisterReq(t, pk)  ← Gson 直列化なので JSON キーは {t, pk}。
//                                 t = productType 文字列, pk = serverSecret。

/** REST 登録 API のパス基底 (CHAPIClient.kt の @Operation path)。 */
const REG_PATH_SIGN = "/device/v1/sesame2/sign";       // guestKeysSignPost
const REG_PATH_SESAME5 = "/device/v1/sesame5";          // myDevicesRegisterSesame5Post (+ /{device_id})

/**
 * REST 応答の HTTP ステータスを検査し、非 2xx なら明示エラーで投げる。
 *
 * WS op 側は assertSuccess (util.js) で success===false を明示的に拒否する規約があるが、
 * REST 側にはこの防御が無く、サーバが 4xx/5xx をエラー JSON ボディ
 * (例 {"message":"forbidden"}) で返すと signGuestKey がそのエラー文字列を session token
 * として誤採用する silent failure があった。transport (real / fake) に依らず**各関数の
 * 応答解釈の前に**ステータスを検査することでこれを防ぐ。
 *
 * @param {{status?:number, text?:string, json?:any}} res transport の戻り値
 * @param {string} op 失敗時メッセージに使う op ラベル
 * @throws {Error} 非 2xx 時 (`<op> failed: HTTP <status> <body>`)
 */
function assertHttpOk(res, op) {
  const status = res?.status;
  if (typeof status !== "number" || status < 200 || status >= 300) {
    const detail = res?.json?.message
      || (typeof res?.text === "string" && res.text)
      || (res?.json != null ? JSON.stringify(res.json) : "");
    throw rejected(t("domain.devices.registerHttpError", { op, status: status ?? "?", detail }), { status: status ?? null });
  }
}

/**
 * デフォルト REST transport を作る。原典は API Gateway (AWSCredentialsProvider) だが、
 * 本 kit は既存の Cognito idToken (getValidIdToken) を再利用し Authorization に乗せる。
 *
 * ★ホストは UNVERIFIED (上記ブロック注記参照)。`baseUrl` を必ず注入すること。
 *
 * @param {{baseUrl?:string, tokenStore?:import("./tokens.js").TokenStore, fetchImpl?:typeof globalThis.fetch}} [opts]
 * @returns {RegisterTransport}
 */
export function makeRegisterTransport({ baseUrl, tokenStore, fetchImpl = globalThis.fetch } = {}) {
  if (!baseUrl) throw badRequest("domain.devices.registerBaseUrlRequired");
  if (!tokenStore) throw badRequest("domain.devices.registerTokenStoreRequired");
  if (typeof fetchImpl !== "function") throw badRequest("domain.devices.registerFetchRequired");
  const base = baseUrl.replace(/\/+$/, ""); // 末尾スラッシュ除去 (パスと二重化させない)
  return async ({ method, path, body }) => {
    // path 未指定で base + undefined = '...undefined' という無効 URL を作らない (低優先の防御)。
    if (typeof path !== "string" || !path) throw badRequest("domain.devices.registerPathRequired");
    const idToken = await getValidIdToken(tokenStore);
    const res = await fetchImpl(base + path, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${idToken}`,
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, text, json };
  };
}

/**
 * guestKeysSign — 既存登録済みデバイスの再ログイン時に session token を取得する
 * (CHSesameOS3.kt:474-484, CHAPIClientBiz.kt:143-144)。
 *
 * リクエスト整形 (CHRemoveSignKeyRequest, CHHistoryUploadRequest.kt:8):
 *   { deviceId: <deviceUUID 大文字>, token: <tokenHex>, secretKey: <secretKey> }
 *   ・deviceId は **大文字化** (CHSesameOS3.kt:476 deviceId.uppercase())
 *   ・token は mSesameToken の **hex** 文字列 (CHSesameOS3.kt:477 toHexString())
 *   ・secretKey は sesame2KeyData.secretKey をそのまま
 *
 * 戻り値: guestKeysSignPost は **素の String** を返す (HTTP body そのものが token)。
 *   SDK 確認: CHAPIClient.kt:95 `guestKeysSignPost(...): String` → CHSesameOS3.kt:481
 *   login(it.data)。JSON ラップ ({data:...}) は vendor に存在しないので生 body (text) を採る。
 *
 * @param {RegisterTransport} transport makeRegisterTransport の戻り値、または fake。
 * @param {{deviceUUID:string, tokenHex:string, secretKey:string}} p
 * @returns {Promise<string>} session token (hex)。
 */
export async function signGuestKey(transport, { deviceUUID, tokenHex, secretKey }) {
  if (typeof transport !== "function") throw badRequest("domain.devices.registerTransportRequired");
  if (!deviceUUID) throw badRequest("domain.devices.deviceUUIDRequired");
  if (!tokenHex) throw badRequest("domain.devices.tokenHexRequired");
  if (!secretKey) throw badRequest("domain.devices.secretKeyRequired");
  const body = {
    deviceId: deviceUUID.toUpperCase(), // CHSesameOS3.kt:476 deviceId.uppercase()
    token: tokenHex,                    // CHSesameOS3.kt:477 mSesameToken.toHexString()
    secretKey,                          // CHSesameOS3.kt:478 sesame2KeyData.secretKey
  };
  const res = await transport({ method: "POST", path: REG_PATH_SIGN, body });
  // 非 2xx (4xx/5xx) はここで拒否。エラー JSON ボディを session token として誤採用しない。
  assertHttpOk(res, "signGuestKey");
  // guestKeysSignPost の戻りは素の String (= session token hex。HTTP body)。生 body を採る。
  // transport が body を JSON 文字列としてパースした場合のみ res.json (string) を使う。
  const token = res.text || (typeof res.json === "string" ? res.json : "");
  if (!token) throw badRequest("domain.devices.signGuestKeyNoToken");
  return token;
}

/**
 * registerSesame5 — OS3 (SESAME5 系) デバイスをサーバに登録する
 * (CHHub3Device.kt:183-186, CHAPIClientBiz.kt:193-195)。
 *
 * パス: POST /device/v1/sesame5/{device_id}  (CHAPIClient.kt:84)
 *   ・device_id は CHHub3Device.kt:184 deviceId.toString() (大文字化なし。SDK 厳守)。
 * リクエスト整形 (CHOS3RegisterReq, CHSS2RegisterReq.kt:5 → Gson キー {t, pk}):
 *   { t: <productType 文字列>, pk: <serverSecret> }
 *   ・t = productModel.productType().toString() (CHHub3Device.kt:185)
 *     → 本 kit は model 名を crypto.js productTypeFromModelName で productType に解決し
 *       .toString() する (完了条件 4)。数値 productType を直接渡すことも許容。
 *   ・pk = serverSecret。SDK では serverSecret は register 時に新規生成される別値ではなく、
 *     その時点の BLE セッショントークン mSesameToken を hex 化した値そのもの
 *     (CHHub3Device.kt:182 `val serverSecret = mSesameToken.toHexString()`)。
 *     よって本関数が受け取る serverSecret は、signGuestKey が token として送る
 *     mSesameToken hex (L353) と同一カテゴリの値である (両者が値衝突して見えるのは正常)。
 *     本 kit はこの値を呼び出し側から受け取り、整形せずそのまま pk に乗せるだけ。
 *
 * @param {RegisterTransport} transport makeRegisterTransport の戻り値、または fake。
 * @param {{deviceUUID:string, productType:(string|number), serverSecret:string}} p
 *   productType は model 名 (例 "sesame_5") または数値 productType。
 * @returns {Promise<any>} サーバ応答 (json があれば json、無ければ text)。
 */
export async function registerSesame5(transport, { deviceUUID, productType, serverSecret }) {
  if (typeof transport !== "function") throw badRequest("domain.devices.registerTransportRequired");
  if (!deviceUUID) throw badRequest("domain.devices.deviceUUIDRequired");
  if (productType == null) throw badRequest("domain.devices.productTypeRequired");
  if (!serverSecret) throw badRequest("domain.devices.serverSecretRequired");

  // productType を数値に解決: 数値 (または数値文字列) はそのまま、それ以外は model 名として
  // crypto.js productTypeFromModelName で逆引きする (手書き複製を排除)。
  let pt;
  if (typeof productType === "number") {
    pt = productType;
  } else if (typeof productType === "string" && /^\d+$/.test(productType)) {
    pt = Number(productType);
  } else {
    pt = productTypeFromModelName(productType);
    if (pt == null) throw badRequest("domain.devices.unknownProductModel", { model: String(productType) });
  }

  const body = {
    t: String(pt),     // CHHub3Device.kt:185 productType().toString()
    pk: serverSecret,  // CHHub3Device.kt:182 serverSecret = mSesameToken.toHexString()
  };
  // device_id は大文字化しない (CHHub3Device.kt:184 deviceId.toString())。
  const path = `${REG_PATH_SESAME5}/${deviceUUID}`;
  const res = await transport({ method: "POST", path, body });
  // 非 2xx (4xx/5xx) はここで拒否。エラーボディを成功応答として誤採用しない。
  assertHttpOk(res, "registerSesame5");
  return res.json != null ? res.json : res.text;
}
