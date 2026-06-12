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
export function getUserDevices(client: WsClient, opts: {
    timeoutMs?: number;
    partialOnTimeout: true;
}): Promise<{
    partial: boolean;
    list: any[];
}>;
/**
 * @overload
 * @param {WsClient} client
 * @param {{timeoutMs?: number, partialOnTimeout?: false}} [opts]
 * @returns {Promise<any[]>}
 */
export function getUserDevices(client: WsClient, opts?: {
    timeoutMs?: number;
    partialOnTimeout?: false;
} | undefined): Promise<any[]>;
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
export function getDeviceStatus(client: WsClient, { deviceUUID }: {
    deviceUUID: string;
}): Promise<object | null>;
/**
 * デバイス名変更。subUUID は呼び出し側 (client.js) が持つ。
 * @param {WsClient} client
 * @param {{subUUID: string, deviceUUID: string, deviceName: string}} p
 */
export function updateDeviceName(client: WsClient, { subUUID, deviceUUID, deviceName }: {
    subUUID: string;
    deviceUUID: string;
    deviceName: string;
}): Promise<import("./transport.js").WsMessage>;
/**
 * デバイスを company から削除。items=[{deviceUUID,...}]
 * @param {WsClient} client
 * @param {{companyID: string, items: Array<{deviceUUID: string}>}} p
 */
export function deleteDevices(client: WsClient, { companyID, items }: {
    companyID: string;
    items: Array<{
        deviceUUID: string;
    }>;
}): Promise<import("./transport.js").WsMessage>;
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
export function addDevices(client: WsClient, { companyID, items }: {
    companyID: string;
    items: object[];
}): Promise<import("./transport.js").WsMessage>;
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
export function reorderDevices(client: WsClient, { companyID, items }: {
    companyID: string;
    items: object[];
}): Promise<any>;
/**
 * デバイスごとの push 通知設定一覧を取得する (biz3ManageDevice/notifyList)。
 * pushToken はモバイル push トークン (vendor は FCM 等の端末トークンを渡す)。
 *
 * @param {WsClient} client
 * @param {{companyID: string, pushToken: string, items: object[]}} p
 * @returns {Promise<any>} 通知設定一覧 (resp.data)
 */
export function getNotifyStatus(client: WsClient, { companyID, pushToken, items }: {
    companyID: string;
    pushToken: string;
    items: object[];
}): Promise<any>;
/**
 * 単機の push 通知 ON/OFF を切り替える (biz3ManageDevice/notifyManage)。
 *
 * @param {WsClient} client
 * @param {{companyID: string, pushToken: string, deviceUUID: string, enablePush: number|boolean}} p
 *   enablePush: vendor はそのまま乗せる (useManageDevice.js:304-318)。boolean は 1/0 へ正規化。
 */
export function switchNotify(client: WsClient, { companyID, pushToken, deviceUUID, enablePush }: {
    companyID: string;
    pushToken: string;
    deviceUUID: string;
    enablePush: number | boolean;
}): Promise<import("./transport.js").WsMessage>;
/**
 * 充電池モード (リチウム充電池使用フラグ) を切り替える (biz3ManageDevice/switchRecharge)。
 * vendor フレームに companyID は**乗らない** (useManageDevice.js:360-372)。
 *
 * @param {WsClient} client
 * @param {{deviceUUID: string, isRechargeBattery: boolean|number}} p
 */
export function switchRechargeableBattery(client: WsClient, { deviceUUID, isRechargeBattery }: {
    deviceUUID: string;
    isRechargeBattery: boolean | number;
}): Promise<import("./transport.js").WsMessage>;
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
export function subscribeDevicesUpdate(client: WsClient, { companyID, items, onUpdate }: {
    companyID: string;
    items: any[];
    onUpdate: (msg: any) => void;
}): {
    unsubscribe: () => void;
    sendFrame: () => void;
};
/**
 * デバイス一覧の増減 push (`pubUserDeviceChange`) を購読する (P3-5)。
 *
 * vendor (useIotCtrl.js:12,23-25): 鍵共有・デバイス追加/削除があるとサーバが
 * `{action:"biz3TriggerLocker", op:"pubUserDeviceChange", ...}` を push し、
 * web はそれを受けて getCompanyDevices() でデバイス一覧を再取得する。
 * 専用の subscribe op は存在しない (useIotCtrl.js:23-25 はハンドラ登録のみ)。
 * ただし vendor 接続は常に getCompanyDevices() 完了後に subscribeDevicesUpdate を送信済み
 * (useManageDevice.js:51,336-346) のため、無購読接続にも pubUserDeviceChange が届くかは
 * 実機未検証 (§9 V14 参照)。本関数はローカル購読のみを行う。
 * 再接続を跨いでも transport の subscribers は保持される。
 *
 * @param {WsClient} client
 * @param {{onChange: (msg: any) => void}} p
 * @returns {() => void} unsubscribe
 */
export function subscribeUserDeviceChange(client: WsClient, { onChange }: {
    onChange: (msg: any) => void;
}): () => void;
/**
 * ロックの開閉履歴を取得。`list` はデバイス指定の配列。
 * @param {WsClient} client
 * @param {{companyID:string, list:any[], pageSize?:number|null}} p
 */
export function getDeviceHistory(client: WsClient, { companyID, list, pageSize }: {
    companyID: string;
    list: any[];
    pageSize?: number | null;
}): Promise<unknown>;
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
export function getAllDeviceHistory(client: WsClient, { companyID, deviceUUID, pageSize, maxPages }: {
    companyID: string;
    deviceUUID: string;
    pageSize?: number;
    maxPages?: number;
}): Promise<any[]>;
/**
 * 開閉履歴の1エントリを非表示化 (論理削除)。
 * biz3 useManageGroup.js makeInvisibleHistory: フラット {action, deviceUUID, timestamp, op}。
 * @param {WsClient} client
 * @param {{deviceUUID:string, timestamp:number}} p
 */
export function makeHistoryInvisible(client: WsClient, { deviceUUID, timestamp }: {
    deviceUUID: string;
    timestamp: number;
}): Promise<import("./transport.js").WsMessage>;
/**
 * 電池履歴を取得。DynamoDB の lastEvaluatedKey でページング。
 * 1 回呼ぶごとに 1 ページ分。null → 最新ページ。
 * 戻り値: { records: [{ts, light, heavy, lightPercentage, heavyPercentage}], lastEvaluatedKey }
 * @param {WsClient} client
 * @param {{deviceUUID:string, lastEvaluatedKey?:unknown, pageSize?:number}} p
 */
export function getBatteryRecord(client: WsClient, { deviceUUID, lastEvaluatedKey, pageSize }: {
    deviceUUID: string;
    lastEvaluatedKey?: unknown;
    pageSize?: number;
}): Promise<{}>;
/**
 * 電池履歴の1エントリを非表示化 (論理削除)。
 * biz3 MobileBatteryChart.js makeInvisibleRecord: フラット {action, deviceUUID, timestamp_second, op}。
 * @param {WsClient} client
 * @param {{deviceUUID:string, timestampSecond:number}} p
 */
export function makeBatteryRecordInvisible(client: WsClient, { deviceUUID, timestampSecond }: {
    deviceUUID: string;
    timestampSecond: number;
}): Promise<import("./transport.js").WsMessage>;
/**
 * 配信中ファームウェア一覧。
 * @param {WsClient} client
 * @returns {Promise<any[]>}
 */
export function listFirmware(client: WsClient): Promise<any[]>;
/**
 * biz3InvokeWebAPIs 経由で REST WebAPI を呼ぶ。
 * func 例: 'webapi_ssm_shadow_get', 'webapi_history_get', 'webapi_cmd_send'。
 * apiKeyId は別途 biz3 の dev console で発行されたもの。
 *
 * P3-10: vendor (useDeveloper.js:46-58) は query/body を渡さない呼び出しでキー自体を省く。
 * query は省略時キー脱落 (undefined → JSON.stringify で除去)、body も同様。
 * 空オブジェクト {} を常時送る旧実装は 1:1 逸脱のため条件スプレッドに修正。
 *
 * @param {WsClient} client
 * @param {{func:string, apiKeyId:string, query?:object, body?:object}} p
 */
export function invokeWebAPI(client: WsClient, { func, apiKeyId, query, body }: {
    func: string;
    apiKeyId: string;
    query?: object;
    body?: object;
}): Promise<unknown>;
/**
 * WebAPI 経由で 単機の shadow state を取得。
 * @param {WsClient} client
 * @param {{apiKeyId: string, deviceId: string}} p
 */
export function webapiDeviceState(client: WsClient, { apiKeyId, deviceId }: {
    apiKeyId: string;
    deviceId: string;
}): Promise<unknown>;
/**
 * WebAPI 経由で履歴を取得。
 * biz3 useDeveloper.js:67-80: query = {device_id, page:0, lg:5, isBiz:true}。
 * lg は言語コードの**数値 ID** (biz3 は 5 を渡す)。旧実装は "ja" (文字列) で誤り。
 * @param {WsClient} client
 * @param {{apiKeyId: string, deviceId: string, page?: number, lg?: number, isBiz?: boolean}} p
 */
export function webapiDeviceHistory(client: WsClient, { apiKeyId, deviceId, page, lg, isBiz }: {
    apiKeyId: string;
    deviceId: string;
    page?: number;
    lg?: number;
    isBiz?: boolean;
}): Promise<unknown>;
/**
 * WebAPI 経由でロック cmd 送信 (sign/history は呼び出し側で組み立て)。
 * @param {WsClient} client
 * @param {{apiKeyId: string, deviceId: string, cmd: unknown, sign: unknown, history: unknown}} p
 */
export function webapiSendCmd(client: WsClient, { apiKeyId, deviceId, cmd, sign, history }: {
    apiKeyId: string;
    deviceId: string;
    cmd: unknown;
    sign: unknown;
    history: unknown;
}): Promise<unknown>;
/**
 * デフォルト REST transport を作る。
 * 公式アプリと同じ「SigV4 (Cognito Identity Pool 一時 credentials) + x-api-key」を付ける
 * (ApiClientConfigBuilder.kt:34-46, BaseApp.kt:95-102。冒頭ブロック注記参照)。
 *
 * appidentifyid は付けない (バックログ8: per-op 化)。本 transport が叩くエンドポイント
 *   POST /device/v1/sesame2/sign        (CHAPIClient.kt:95-96 guestKeysSignPost)
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
export function makeRegisterTransport({ baseUrl, tokenStore, credentialsProvider, apiKey, fetchImpl, }?: {
    baseUrl?: string;
    tokenStore?: import("./tokens.js").TokenStore;
    credentialsProvider?: import("./aws-credentials.js").CredentialsProviderLike;
    appIdentifyId?: string | null;
    config?: import("./aws-credentials.js").AppIdConfigLike | null;
    configStore?: import("./aws-credentials.js").AppIdConfigStoreLike | null;
    apiKey?: string;
    fetchImpl?: typeof globalThis.fetch;
}): RegisterTransport;
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
export function resolveRegisterTransport({ baseUrl, config, configStore, tokenStore, credentialsProvider, appIdentifyId, fetchImpl }?: {
    baseUrl?: string | null;
    config?: ({
        registerBaseUrl?: string | null;
    } & import("./aws-credentials.js").AppIdConfigLike) | null;
    configStore?: import("./aws-credentials.js").AppIdConfigStoreLike | null;
    tokenStore?: import("./tokens.js").TokenStore;
    credentialsProvider?: import("./aws-credentials.js").CredentialsProviderLike;
    appIdentifyId?: string | null;
    fetchImpl?: typeof globalThis.fetch;
    required?: boolean;
}): RegisterTransport;
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
export function signGuestKey(transport: RegisterTransport, { deviceUUID, tokenHex, secretKey }: {
    deviceUUID: string;
    tokenHex: string;
    secretKey: string;
}): Promise<string>;
/**
 * registerSesame5 — OS3 (SESAME5 系) デバイスをサーバに登録する
 * (CHHub3Device.kt:187-190, CHAPIClientBiz.kt:193-195)。
 *
 * パス: POST /device/v1/sesame5/{device_id}  (CHAPIClient.kt:84)
 *   ・device_id は CHHub3Device.kt:188 deviceId.toString() (大文字化なし。SDK 厳守)。
 * リクエスト整形 (CHOS3RegisterReq, CHSS2RegisterReq.kt:5 → Gson キー {t, pk}):
 *   { t: <productType 文字列>, pk: <serverSecret> }
 *   ・t = productModel.productType().toString() (CHHub3Device.kt:189)
 *     → 本 kit は model 名を crypto.js productTypeFromModelName で productType に解決し
 *       .toString() する (完了条件 4)。数値 productType を直接渡すことも許容。
 *   ・pk = serverSecret。SDK では serverSecret は register 時に新規生成される別値ではなく、
 *     その時点の BLE セッショントークン mSesameToken を hex 化した値そのもの
 *     (CHHub3Device.kt:186 `val serverSecret = mSesameToken.toHexString()`)。
 *     よって本関数が受け取る serverSecret は、signGuestKey が token として送る
 *     mSesameToken hex (L353) と同一カテゴリの値である (両者が値衝突して見えるのは正常)。
 *     本 kit はこの値を呼び出し側から受け取り、整形せずそのまま pk に乗せるだけ。
 *
 * @param {RegisterTransport} transport makeRegisterTransport の戻り値、または fake。
 * @param {{deviceUUID:string, productType:(string|number), serverSecret:string}} p
 *   productType は model 名 (例 "sesame_5") または数値 productType。
 * @returns {Promise<any>} サーバ応答 (json があれば json、無ければ text)。
 */
export function registerSesame5(transport: RegisterTransport, { deviceUUID, productType, serverSecret }: {
    deviceUUID: string;
    productType: (string | number);
    serverSecret: string;
}): Promise<any>;
/**
 * 下位 WS トランスポート。完全な型は transport.js の Hub3WsClient。
 */
export type WsClient = import("./transport.js").Hub3WsClient;
/**
 * REST register transport の応答。
 */
export type RegisterResponse = {
    status?: number | undefined;
    text?: string | undefined;
    json?: any;
};
/**
 * REST register transport の呼び出しシグネチャ。
 */
export type RegisterTransport = (req: {
    method: string;
    path: string;
    body?: object;
}) => Promise<RegisterResponse>;
//# sourceMappingURL=devices.d.ts.map