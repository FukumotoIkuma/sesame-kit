/** 個人ユーザのデバイス一覧。companyID 不要。 */
export function getUserDevices(client: any, { timeoutMs }?: {
    timeoutMs?: number;
}): Promise<any>;
/** 単機の現在状態 (ロック開閉、電池等)。biz3 では isFromApp=true 限定だが CLI でも投げてみる価値あり。 */
export function getDeviceStatus(client: any, { deviceUUID }: {
    deviceUUID: any;
}): Promise<any>;
/** デバイス名変更。subUUID は呼び出し側 (client.js) が持つ。 */
export function updateDeviceName(client: any, { subUUID, deviceUUID, deviceName }: {
    subUUID: any;
    deviceUUID: any;
    deviceName: any;
}): Promise<any>;
/** デバイスを company から削除。items=[{deviceUUID,...}] */
export function deleteDevices(client: any, { companyID, items }: {
    companyID: any;
    items: any;
}): Promise<any>;
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
export function subscribeDevicesUpdate(client: any, { companyID, items, onUpdate }: {
    companyID: any;
    items: any;
    onUpdate: any;
}): any;
/**
 * ロックの開閉履歴を取得。`list` はデバイス指定の配列。
 * @param {{companyID:string, list:any[], pageSize?:number}} p
 */
export function getDeviceHistory(client: any, { companyID, list, pageSize }: {
    companyID: any;
    list: any;
    pageSize?: any;
}): Promise<any>;
/**
 * 開閉履歴の1エントリを非表示化 (論理削除)。
 * biz3 useManageGroup.js makeInvisibleHistory: フラット {action, deviceUUID, timestamp, op}。
 * @param {{deviceUUID:string, timestamp:number}} p
 */
export function makeHistoryInvisible(client: any, { deviceUUID, timestamp }: {
    deviceUUID: any;
    timestamp: any;
}): Promise<any>;
/**
 * 電池履歴を取得。DynamoDB の lastEvaluatedKey でページング。
 * 1 回呼ぶごとに 1 ページ分。null → 最新ページ。
 * 戻り値: { records: [{ts, light, heavy, lightPercentage, heavyPercentage}], lastEvaluatedKey }
 */
export function getBatteryRecord(client: any, { deviceUUID, lastEvaluatedKey, pageSize }: {
    deviceUUID: any;
    lastEvaluatedKey?: any;
    pageSize?: number;
}): Promise<any>;
/**
 * 電池履歴の1エントリを非表示化 (論理削除)。
 * biz3 MobileBatteryChart.js makeInvisibleRecord: フラット {action, deviceUUID, timestamp_second, op}。
 * @param {{deviceUUID:string, timestampSecond:number}} p
 */
export function makeBatteryRecordInvisible(client: any, { deviceUUID, timestampSecond }: {
    deviceUUID: any;
    timestampSecond: any;
}): Promise<any>;
/** 配信中ファームウェア一覧。 */
export function listFirmware(client: any): Promise<any>;
/**
 * biz3InvokeWebAPIs 経由で REST WebAPI を呼ぶ。
 * func 例: 'webapi_ssm_shadow_get', 'webapi_history_get', 'webapi_cmd_send'。
 * apiKeyId は別途 biz3 の dev console で発行されたもの。
 *
 * @param {{func:string, apiKeyId:string, query?:object, body?:object}} p
 */
export function invokeWebAPI(client: any, { func, apiKeyId, query, body }: {
    func: any;
    apiKeyId: any;
    query?: {};
    body?: {};
}): Promise<any>;
/** WebAPI 経由で 単機の shadow state を取得。 */
export function webapiDeviceState(client: any, { apiKeyId, deviceId }: {
    apiKeyId: any;
    deviceId: any;
}): Promise<any>;
/**
 * WebAPI 経由で履歴を取得。
 * biz3 useDeveloper.js:67-80: query = {device_id, page:0, lg:5, isBiz:true}。
 * lg は言語コードの**数値 ID** (biz3 は 5 を渡す)。旧実装は "ja" (文字列) で誤り。
 */
export function webapiDeviceHistory(client: any, { apiKeyId, deviceId, page, lg, isBiz }: {
    apiKeyId: any;
    deviceId: any;
    page?: number;
    lg?: number;
    isBiz?: boolean;
}): Promise<any>;
/** WebAPI 経由でロック cmd 送信 (sign/history は呼び出し側で組み立て)。 */
export function webapiSendCmd(client: any, { apiKeyId, deviceId, cmd, sign, history }: {
    apiKeyId: any;
    deviceId: any;
    cmd: any;
    sign: any;
    history: any;
}): Promise<any>;
//# sourceMappingURL=devices.d.ts.map