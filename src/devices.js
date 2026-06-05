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
import { assertSuccess } from "./util.js";

// action 文字列は vendor (biz3 messageConstants) から引く (手書きしない)。
const ACT_MANAGE = ACTION_TYPES.BIZ3_MANAGE_DEVICE;       // "biz3ManageDevice"
const ACT_HISTORY = ACTION_TYPES.BIZ3_GET_DEVICEHISTORY;  // "biz3GetDeviceHistory"
const ACT_BATTERY = ACTION_TYPES.BIZ3_GET_BATTERY_RECORD; // "biz3GetDeviceBatteryRecord"
const ACT_FIRMWARE = ACTION_TYPES.BIZ3_LIST_FIRMWARE;     // "biz3ListFirmware"
const ACT_WEBAPI = ACTION_TYPES.BIZ3_INVOKE_WEBAPI;       // "biz3InvokeWebAPIs"
const ACT_TRIGGER = ACTION_TYPES.BIZ3_TRIGGER_LOCKER;     // "biz3TriggerLocker" (state push)
const DEFAULT_TIMEOUT_MS = 10_000;

// ---------- device CRUD (biz3ManageDevice) ----------

/** 個人ユーザのデバイス一覧。companyID 不要。 */
export async function getUserDevices(client, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  // 応答は PubedUserDevice 系で来る可能性 (catalog より)。pending 単純解決を試み、
  // 失敗時は listener fallback を用意する。
  return new Promise((resolve, reject) => {
    let done = false;
    const to = setTimeout(() => {
      if (done) return;
      done = true;
      unsub();
      reject(new Error("getUserDevice timeout"));
    }, timeoutMs);
    const unsub = client.subscribe(`${ACT_MANAGE}:PubedUserDevice`, (msg) => {
      if (done) return;
      done = true;
      clearTimeout(to);
      unsub();
      resolve(msg?.data?.data?.list || msg?.data?.list || msg?.data || []);
    });
    client.send({ action: ACT_MANAGE, op: "getUserDevice" });
  });
}

/** 単機の現在状態 (ロック開閉、電池等)。biz3 では isFromApp=true 限定だが CLI でも投げてみる価値あり。 */
export async function getDeviceStatus(client, { deviceUUID }) {
  const resp = await client.request(
    { action: ACT_MANAGE, op: "getDeviceStatus", deviceUUID },
    DEFAULT_TIMEOUT_MS,
  );
  assertSuccess(resp, "getDeviceStatus", { strict: true });
  return resp.data;
}

/** デバイス名変更。subUUID は呼び出し側 (client.js) が持つ。 */
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

/** デバイスを company から削除。items=[{deviceUUID,...}] */
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
 * @param {{companyID:string, list:any[], pageSize?:number}} p
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

/** 配信中ファームウェア一覧。 */
export async function listFirmware(client) {
  // この op は op フィールド無し (action のみ)
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { unsub(); reject(new Error("listFirmware timeout")); }, DEFAULT_TIMEOUT_MS);
    const unsub = client.subscribe(`${ACT_FIRMWARE}:`, (msg) => {
      clearTimeout(to);
      unsub();
      resolve(msg?.data || []);
    });
    client.send({ action: ACT_FIRMWARE });
  });
}

// ---------- webapi proxy ----------

/**
 * biz3InvokeWebAPIs 経由で REST WebAPI を呼ぶ。
 * func 例: 'webapi_ssm_shadow_get', 'webapi_history_get', 'webapi_cmd_send'。
 * apiKeyId は別途 biz3 の dev console で発行されたもの。
 *
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

/** WebAPI 経由で 単機の shadow state を取得。 */
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
 */
export function webapiDeviceHistory(client, { apiKeyId, deviceId, page = 0, lg = 5, isBiz = true }) {
  return invokeWebAPI(client, {
    func: "webapi_history_get",
    apiKeyId,
    query: { device_id: deviceId, page, lg, isBiz },
  });
}

/** WebAPI 経由でロック cmd 送信 (sign/history は呼び出し側で組み立て)。 */
export function webapiSendCmd(client, { apiKeyId, deviceId, cmd, sign, history }) {
  return invokeWebAPI(client, {
    func: "webapi_cmd_send",
    apiKeyId,
    body: { device_id: deviceId, cmd, sign, history },
  });
}
