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
/**
 * デフォルト REST transport を作る。原典は API Gateway (AWSCredentialsProvider) だが、
 * 本 kit は既存の Cognito idToken (getValidIdToken) を再利用し Authorization に乗せる。
 *
 * ★ホストは UNVERIFIED (上記ブロック注記参照)。`baseUrl` を必ず注入すること。
 *
 * @param {{baseUrl:string, tokenStore:{load:Function,save:Function}, fetchImpl?:Function}} opts
 * @returns {(req:{method:string, path:string, body?:object}) => Promise<{status:number, text:string, json:any}>}
 */
export function makeRegisterTransport({ baseUrl, tokenStore, fetchImpl }?: {
    baseUrl: string;
    tokenStore: {
        load: Function;
        save: Function;
    };
    fetchImpl?: Function;
}): (req: {
    method: string;
    path: string;
    body?: object;
}) => Promise<{
    status: number;
    text: string;
    json: any;
}>;
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
 * 戻り値: guestKeysSignPost は String を返し、SDK は login(it.data) に渡す。
 *   = session token (hex)。JSON ラップ ({data:...} 等) されている可能性があるため
 *     text / json.data / json をこの順で session token として解決する。
 *
 * @param {(req)=>Promise<{status,text,json}>} transport makeRegisterTransport の戻り値、または fake。
 * @param {{deviceUUID:string, tokenHex:string, secretKey:string}} p
 * @returns {Promise<string>} session token (hex)。
 */
export function signGuestKey(transport: (req: any) => Promise<{
    status: any;
    text: any;
    json: any;
}>, { deviceUUID, tokenHex, secretKey }: {
    deviceUUID: string;
    tokenHex: string;
    secretKey: string;
}): Promise<string>;
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
 * @param {(req)=>Promise<{status,text,json}>} transport makeRegisterTransport の戻り値、または fake。
 * @param {{deviceUUID:string, productType:(string|number), serverSecret:string}} p
 *   productType は model 名 (例 "sesame_5") または数値 productType。
 * @returns {Promise<any>} サーバ応答 (json があれば json、無ければ text)。
 */
export function registerSesame5(transport: (req: any) => Promise<{
    status: any;
    text: any;
    json: any;
}>, { deviceUUID, productType, serverSecret }: {
    deviceUUID: string;
    productType: (string | number);
    serverSecret: string;
}): Promise<any>;
//# sourceMappingURL=devices.d.ts.map