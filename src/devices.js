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
import {
  makeCognitoCredentialsProvider,
  makeApiGatewayTransport,
  DEFAULT_CH_API_BASE_URL,
} from "./aws-credentials.js";

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
const DEFAULT_TIMEOUT_MS = 10_000;

// ---------- device CRUD (biz3ManageDevice) ----------

/**
 * 個人ユーザのデバイス一覧。companyID 不要。
 *
 * partialOnTimeout (BIZ-14 / バックログ6, オプトイン): true なら timeout 時に reject せず、
 * その時点までの蓄積を `{partial:true, list}` で resolve する (参照 UI は page push のたびに
 * 表示へ反映するため、完了前でも部分蓄積が残る — useManageDevice.js:38-55 の setDevices /
 * useManageEmployee.js:70-88 と同パターン)。指定時は完走しても `{partial:false, list}` の
 * 同 shape で返る (既定の配列戻りと shape が変わる点に注意)。既定 (false) は従来どおり reject。
 *
 * @overload
 * @param {WsClient} client
 * @param {{timeoutMs?: number, partialOnTimeout: true}} opts
 * @returns {Promise<{partial:boolean, list:any[]}>}
 */
/**
 * @overload
 * @param {WsClient} client
 * @param {{timeoutMs?: number, partialOnTimeout?: false}} [opts]
 * @returns {Promise<any[]>}
 */
/**
 * @param {WsClient} client
 * @param {{timeoutMs?: number, partialOnTimeout?: boolean}} [opts]
 * @returns {Promise<any[] | {partial:boolean, list:any[]}>}
 */
export async function getUserDevices(client, { timeoutMs = DEFAULT_TIMEOUT_MS, partialOnTimeout = false } = {}) {
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
    // P3-9: 同 action の success:false (即時エラー応答) で timeout を待たず失敗確定
    // (useManageDevice.js:27-34 の !message.success 判定)。
    errorAction: ACT_MANAGE,
    partialOnTimeout,
    // partialOnTimeout 時は object 形へ切り替える (subscribeChunks の spread 契約。
    // timeout 確定時は partial:true へ上書きされる)。
    result: () => (partialOnTimeout ? { partial: false, list: acc } : acc),
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
 * デバイスを company に追加する (biz3ManageDevice/add)。
 * **デバイスを「増やす」唯一の経路** (del だけある現状は非対称だった — P3-1)。
 * items は QR 由来のデバイスキーオブジェクト配列 (vendor は addSesameDevicesToBiz3 が
 * そのまま items に乗せる — useManageDevice.js:256-268)。
 *
 * 失敗応答の伝搬: サーバはデバイス数上限で `{success:false, message:"Limit Exceeded"}` を
 * 返す (useManageDevice.js:28-30)。assertSuccess(strict) がその message を含む
 * SesameError(rejected) で throw するため、呼び出し側にそのまま伝搬する。
 *
 * @param {WsClient} client
 * @param {{companyID: string, items: object[]}} p
 */
export async function addDevices(client, { companyID, items }) {
  if (!Array.isArray(items)) throw badRequest("domain.devices.itemsArray");
  const resp = await client.request(
    // frame 1:1 (useManageDevice.js:258-263): { action, op:'add', items, companyID }
    { action: ACT_MANAGE, op: "add", items, companyID },
    DEFAULT_TIMEOUT_MS,
  );
  assertSuccess(resp, "addDevices", { strict: true });
  return resp;
}

/**
 * デバイスの並び順を更新する (biz3ManageDevice/reorderDevices)。
 * vendor (useManageDevice.js:270-285) は items の各要素に `rank = 0 - index` を
 * 振ってから送る (先頭ほど大きい = 降順負値)。本関数も同じ採番を行う。
 * 応答 data は並び替え後のデバイス一覧 (useManageDevice.js:80-81 setCompanyDevices(message.data))。
 *
 * @param {WsClient} client
 * @param {{companyID: string, items: object[]}} p items は並べたい順のデバイスオブジェクト配列
 * @returns {Promise<any>} 並び替え後のデバイス一覧 (resp.data)
 */
export async function reorderDevices(client, { companyID, items }) {
  if (!Array.isArray(items)) throw badRequest("domain.devices.itemsArray");
  // rank 採番は vendor と同じ in-place (useManageDevice.js:272-274 item.rank = 0 - index)。
  const ranked = items.map((item, index) => ({ ...item, rank: 0 - index }));
  const resp = await client.request(
    // frame 1:1 (useManageDevice.js:275-280): { action, op:'reorderDevices', items, companyID }
    { action: ACT_MANAGE, op: "reorderDevices", items: ranked, companyID },
    DEFAULT_TIMEOUT_MS,
  );
  assertSuccess(resp, "reorderDevices", { strict: true });
  return resp.data;
}

/**
 * デバイスごとの push 通知設定一覧を取得する (biz3ManageDevice/notifyList)。
 * pushToken はモバイル push トークン (vendor は FCM 等の端末トークンを渡す)。
 *
 * @param {WsClient} client
 * @param {{companyID: string, pushToken: string, items: object[]}} p
 * @returns {Promise<any>} 通知設定一覧 (resp.data)
 */
export async function getNotifyStatus(client, { companyID, pushToken, items }) {
  if (!Array.isArray(items)) throw badRequest("domain.devices.itemsArray");
  const resp = await client.request(
    // frame 1:1 (useManageDevice.js:287-299): { action, companyID, pushToken, items, op:'notifyList' }
    { action: ACT_MANAGE, companyID, pushToken, items, op: "notifyList" },
    DEFAULT_TIMEOUT_MS,
  );
  assertSuccess(resp, "getNotifyStatus", { strict: true });
  return resp.data;
}

/**
 * 単機の push 通知 ON/OFF を切り替える (biz3ManageDevice/notifyManage)。
 *
 * @param {WsClient} client
 * @param {{companyID: string, pushToken: string, deviceUUID: string, enablePush: number|boolean}} p
 *   enablePush: vendor はそのまま乗せる (useManageDevice.js:304-318)。boolean は 1/0 へ正規化。
 */
export async function switchNotify(client, { companyID, pushToken, deviceUUID, enablePush }) {
  if (!deviceUUID) throw badRequest("domain.devices.deviceUUIDRequired");
  const resp = await client.request(
    // frame 1:1 (useManageDevice.js:308-315): { action, companyID, enablePush, deviceUUID, pushToken, op:'notifyManage' }
    {
      action: ACT_MANAGE,
      companyID,
      enablePush: typeof enablePush === "boolean" ? (enablePush ? 1 : 0) : enablePush,
      deviceUUID,
      pushToken,
      op: "notifyManage",
    },
    DEFAULT_TIMEOUT_MS,
  );
  assertSuccess(resp, "switchNotify", { strict: true });
  return resp;
}

/**
 * 充電池モード (リチウム充電池使用フラグ) を切り替える (biz3ManageDevice/switchRecharge)。
 * vendor フレームに companyID は**乗らない** (useManageDevice.js:360-372)。
 *
 * @param {WsClient} client
 * @param {{deviceUUID: string, isRechargeBattery: boolean|number}} p
 */
export async function switchRechargeableBattery(client, { deviceUUID, isRechargeBattery }) {
  if (!deviceUUID) throw badRequest("domain.devices.deviceUUIDRequired");
  const resp = await client.request(
    // frame 1:1 (useManageDevice.js:362-367): { action, deviceUUID, isRechargeBattery: 1|0, op:'switchRecharge' }
    { action: ACT_MANAGE, deviceUUID, isRechargeBattery: isRechargeBattery ? 1 : 0, op: "switchRecharge" },
    DEFAULT_TIMEOUT_MS,
  );
  assertSuccess(resp, "switchRechargeableBattery", { strict: true });
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
 * @returns {{ unsubscribe: () => void, sendFrame: () => void }}
 */
export function subscribeDevicesUpdate(client, { companyID, items, onUpdate }) {
  // P1-4: 購読フレーム送信部分を関数化し、WS 再接続時の再送に利用できるようにする。
  // サーバは接続ごとに購読状態を持つため、再接続後は必ずフレームを再送しなければならない
  // (vendor: useManageDevice.js:352-358 — onConnectionIdChange で getCompanyDevices() → subscribeDevices())。
  const sendFrame = () => {
    client.send({ action: ACT_MANAGE, op: "subscribeDevicesUpdate", items, companyID });
  };
  sendFrame();
  const offSub = client.subscribe(`biz3TriggerLocker:pubDeviceStateChange`, (msg) => {
    try { onUpdate(msg); } catch { /* ignore */ }
  });
  return { unsubscribe: offSub, sendFrame };
}

/**
 * デバイス一覧の増減 push (`pubUserDeviceChange`) を購読する (P3-5)。
 *
 * vendor (useIotCtrl.js:12,23-25): 鍵共有・デバイス追加/削除があるとサーバが
 * `{action:"biz3TriggerLocker", op:"pubUserDeviceChange", ...}` を push し、
 * web はそれを受けて getCompanyDevices() でデバイス一覧を再取得する。
 * 購読要求フレームは存在しない (pubDeviceStateChange と違い subscribe op 無しで届く) ため、
 * 本関数はローカル購読のみを行う。再接続を跨いでも transport の subscribers は保持される。
 *
 * @param {WsClient} client
 * @param {{onChange: (msg: any) => void}} p
 * @returns {() => void} unsubscribe
 */
export function subscribeUserDeviceChange(client, { onChange }) {
  return client.subscribe(`biz3TriggerLocker:pubUserDeviceChange`, (msg) => {
    try { onChange(msg); } catch { /* ignore */ }
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
 * 単機の開閉履歴を全ページ自動取得する (P3-7、vendor fetchAllHistory 相当)。
 *
 * vendor (DeviceHistory.js:37-74 downloadDeviceHistory/fetchAllHistory):
 *   - lastKey = 直前ページ末尾レコードの timestamp (初回は null)
 *   - 1 ページ取得して `res.length === pageSize` なら次ページ継続、満たなければ終端
 *   - pageSize は 100 固定 (DeviceHistory.js:56)
 *
 * @param {WsClient} client
 * @param {{companyID: string, deviceUUID: string, pageSize?: number, maxPages?: number}} p
 *   maxPages: 安全弁 (vendor には無い意図的逸脱 §0.1-2 — CLI/RPC で無限ループを防ぐ。既定 1000)。
 * @returns {Promise<any[]>} 全ページを結合した履歴配列
 */
export async function getAllDeviceHistory(client, { companyID, deviceUUID, pageSize = 100, maxPages = 1000 }) {
  if (!deviceUUID) throw badRequest("domain.devices.deviceUUIDRequired");
  /** @type {any[]} */
  const all = [];
  /** @type {number|null} */
  let lastKey = null;
  for (let page = 0; page < maxPages; page += 1) {
    /** @type {any[]} */
    const res = /** @type {any[]} */ (await getDeviceHistory(client, {
      companyID,
      list: [{ deviceUUID, lastKey }],
      pageSize,
    })) || [];
    all.push(...res);
    // 継続条件は vendor 1:1 (DeviceHistory.js:64: res.length > 0 && res.length === pageSize)。
    if (!(res.length > 0 && res.length === pageSize)) break;
    lastKey = res[res.length - 1]?.timestamp ?? null;
    if (lastKey == null) break; // timestamp 欠落時は継続不能 (vendor は undefined を渡し続けるが無限ループ防止)
  }
  return all;
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
  // P3-18: vendor (MobileBatteryChart.js:39-50 getBatteryRecordCallback) は success を見ずに
  // message.data.records を読む。strict:true だと success を省略する正常応答を例外化するため、
  // 非 strict (success===false のみ拒否) に緩める。
  // 注: 実応答で success フィールドの有無は未確認 (REFACTORING_PLAN §9 V9)。
  assertSuccess(resp, "getBatteryRecord");
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
      onMessage: (msg, finish) => {
        // P3-9: success:false の即時エラーを空配列の成功に化けさせない
        // (useDeveloper.js:18-31 は素通しだが、本 kit は明示失敗にする)。
        if (msg?.success === false) {
          finish(rejected(t("domain.util.opFailed", { op: "listFirmware", detail: msg?.message || JSON.stringify(msg) }),
            { upstreamCode: msg?.code ?? null }));
          return;
        }
        data = msg?.data || []; finish();
      },
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
  // P3-18: vendor (useDeveloper.js:18-31 handleAPIInfoResponse) は success を見ずに応答を
  // そのままコールバックへ流す。strict:true だと success を省略する正常応答を例外化するため、
  // 非 strict (success===false のみ拒否) に緩める。
  // 注: 実応答で success フィールドの有無は未確認 (REFACTORING_PLAN §9 V9)。
  assertSuccess(resp, `invokeWebAPI(${func})`);
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
// 認可方式 (参照実装と一致。REFACTORING_PLAN P2-1 / AUTH-01 + AUTH-02):
//   公式の REST (API Gateway) 認可は「SigV4 (Cognito Identity Pool の一時 credentials) +
//   x-api-key + appidentifyid」である:
//     - ApiClientConfigBuilder.kt:34-46 — ApiClientFactory()
//         .credentialsProvider(credentialsProvider).apiKey(apiKey).region("ap-northeast-1")
//     - BaseApp.kt:95-102 — setCHAPIClient(): credentialsProvider = AWSMobileClient.getInstance(),
//       apiKey = BuildConfig.API_GATEWAY_API_KEY (= app.properties:5)
//     - AppIdentifyIdUtil.kt:42 — appidentifyid = "ap-northeast-1:<ANDROID_ID 相当の安定 ID>"
//   idToken を Authorization: Bearer に使う箇所は参照 SDK に存在しないため、旧 Bearer 経路は
//   撤去した。REST ホストは _sesame_sdk_ref/app.properties:2-3 にチェックインされている
//   (prod = https://app.candyhouse.co/prod)。旧注記の「REST ホストは参照に無い」は虚偽
//   だったため削除し、既定ホストとして焼き込む (config 上書きは維持)。
//   実装基盤は src/aws-credentials.js (CognitoCachingCredentialsProvider / ApiClientFactory 相当)
//   + src/sigv4.js (SigV4 自前実装)。
//
// ★ 実機未検証マーカー: ヘッダ構成は参照実装から導出したが、実機 API Gateway での受理は
//   未検証 (REFACTORING_PLAN §9 V4/V5)。
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
 * 既定の REST ホスト (app.properties:3 candyhouse.sesame.api.prod = BuildConfig.ch_server)。
 * config.registerBaseUrl や明示引数で上書き可能。
 */
export const DEFAULT_REGISTER_BASE_URL = DEFAULT_CH_API_BASE_URL;

/**
 * デフォルト REST transport を作る。
 * 公式アプリと同じ「SigV4 (Cognito Identity Pool 一時 credentials) + x-api-key」を付ける
 * (ApiClientConfigBuilder.kt:34-46, BaseApp.kt:95-102。冒頭ブロック注記参照)。
 *
 * appidentifyid は付けない (バックログ8: per-op 化)。本 transport が叩くエンドポイント
 *   POST /device/v1/sesame2/sign        (CHAPIClient.kt:95-96 guestKeysSignPost)
 *   POST /device/v1/sesame2/{device_id} (CHAPIClient.kt:77-81 register os2)
 *   POST /device/v1/sesame5/{device_id} (CHAPIClient.kt:84-88 register os3)
 * には参照に @Parameter(name="appidentifyid", location="header") が無い。
 * 全列挙表は aws-credentials.js makeApiGatewayTransport の冒頭コメント参照。
 * 旧実装は appIdentifyId を常時解決・付与していたが参照より広かったため撤去した。
 * appIdentifyId / config / configStore オプションは後方互換のため受理するが **無視する**。
 *
 * 認可の入力は次のどちらか:
 *   - tokenStore — 既存ログイン (`sesame login`) の idToken を Identity Pool に連携して
 *     一時 credentials を取得する (BaseApp.kt:99 の AWSMobileClient.getInstance() 相当)。
 *   - credentialsProvider — 取得済み provider を直接注入 (テスト / 上級用)。
 *
 * @experimental 実機 API Gateway での受理は未検証 (REFACTORING_PLAN §9 V4/V5)。
 *
 * @param {{baseUrl?:string,
 *          tokenStore?:import("./tokens.js").TokenStore,
 *          credentialsProvider?:import("./aws-credentials.js").CredentialsProviderLike,
 *          appIdentifyId?:string|null,
 *          config?:import("./aws-credentials.js").AppIdConfigLike|null,
 *          configStore?:import("./aws-credentials.js").AppIdConfigStoreLike|null,
 *          apiKey?:string,
 *          fetchImpl?:typeof globalThis.fetch}} [opts]
 *   appIdentifyId / config / configStore は旧 API 互換のため受理するが無視する
 *   (参照のこれらのエンドポイントに appidentifyid ヘッダは無い)。
 * @returns {RegisterTransport}
 */
export function makeRegisterTransport({
  baseUrl = DEFAULT_REGISTER_BASE_URL,
  tokenStore,
  credentialsProvider,
  apiKey,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!credentialsProvider && !tokenStore) throw badRequest("domain.devices.registerAuthRequired");
  if (typeof fetchImpl !== "function") throw badRequest("domain.devices.registerFetchRequired");
  const store = /** @type {import("./tokens.js").TokenStore} */ (tokenStore);
  const provider = credentialsProvider
    // CognitoCachingCredentialsProvider 相当: 既存ログインの idToken (getValidIdToken が
    // 失効前 refresh を担う) を Identity Pool に連携して一時 credentials を取得・キャッシュ。
    || makeCognitoCredentialsProvider({ getIdToken: () => getValidIdToken(store), fetchImpl });
  return makeApiGatewayTransport({
    baseUrl: baseUrl || DEFAULT_REGISTER_BASE_URL,
    credentialsProvider: provider,
    // appIdentifyId は渡さない (既定 null = ヘッダ無し)。sign/register 系エンドポイントに
    // appidentifyid は参照に存在しない (CHAPIClient.kt:77-96)。
    apiKey,
    fetchImpl,
  });
}

/**
 * 既存のログイン状態から register REST transport を解決する。
 *
 * register / guest-key signing の REST API は BLE 経路からも使われるが、Cognito の
 * idToken/refreshToken ライフサイクルは `sesame login` が確立した TokenStore に集約する。
 * ここを通すことで CLI/RPC が別ログインや生 credentials を持たず、Consumer Client +
 * ConfirmDevice による refreshToken 維持をそのまま再利用する。
 *
 * baseUrl は明示値 > config.registerBaseUrl > DEFAULT_REGISTER_BASE_URL の順。既定ホストが
 * app.properties:2-3 で確定したため、baseUrl 未設定でも常に transport を返す
 * (旧「baseUrl 必須 throw / undefined 返し」は撤廃。`required` は後方互換のため受理するが無視)。
 * appIdentifyId / configStore も後方互換のため受理するが無視する (バックログ8:
 * sign/register 系エンドポイントに appidentifyid ヘッダは無い — makeRegisterTransport 注記)。
 *
 * @param {{baseUrl?:string|null,
 *          config?:({registerBaseUrl?:string|null} & import("./aws-credentials.js").AppIdConfigLike)|null,
 *          configStore?:import("./aws-credentials.js").AppIdConfigStoreLike|null,
 *          tokenStore?:import("./tokens.js").TokenStore,
 *          credentialsProvider?:import("./aws-credentials.js").CredentialsProviderLike,
 *          appIdentifyId?:string|null,
 *          fetchImpl?:typeof globalThis.fetch,
 *          required?:boolean}} [opts]
 * @returns {RegisterTransport}
 */
export function resolveRegisterTransport({ baseUrl, config, configStore, tokenStore, credentialsProvider, appIdentifyId, fetchImpl } = {}) {
  return makeRegisterTransport({
    baseUrl: baseUrl || config?.registerBaseUrl || DEFAULT_REGISTER_BASE_URL,
    config,
    configStore,
    tokenStore,
    credentialsProvider,
    appIdentifyId,
    fetchImpl,
  });
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
