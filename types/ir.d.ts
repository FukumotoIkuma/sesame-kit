/**
 * 登録済みリモコン一覧を取得 (ページング)。
 * @param {WsClient} client
 * @param {{type:number, companyID:string, page?:number, pageSize?:number}} p
 *   type は **実 remote.type** (自己学習=0xFE00, UI メニューの 0xFEFF ではない / 上記トラップ参照)
 */
export function getRemoteList(client: WsClient, p: {
    type: number;
    companyID: string;
    page?: number;
    pageSize?: number;
}): Promise<{}>;
/**
 * プリセットリモコン (メーカー DB) 検索。最大 1000 件返却。
 * @param {WsClient} client
 * @param {{type:number, companyID:string, searchTerm:string}} p
 */
export function searchRemoteList(client: WsClient, p: {
    type: number;
    companyID: string;
    searchTerm: string;
}): Promise<{}>;
/**
 * リモコンを追加 (Hub3 1 台あたり 3 個上限がサーバ側にある)。
 * `remote` の形は biz3 がそのまま remoteDevice オブジェクトを渡しているので、
 * 呼び出し側で {hub3DeviceId, type, name, irOperation, ...} を入れる。
 * @param {WsClient} client
 * @param {{remote: object, companyID: string}} p
 */
export function addIRRemote(client: WsClient, { remote, companyID }: {
    remote: object;
    companyID: string;
}): Promise<{}>;
/**
 * リモコン削除。
 * @param {WsClient} client
 * @param {{hub3DeviceId: string, uuid: string, companyID: string}} p
 */
export function deleteIRRemote(client: WsClient, { hub3DeviceId, uuid, companyID }: {
    hub3DeviceId: string;
    uuid: string;
    companyID: string;
}): Promise<import("./transport.js").WsMessage>;
/**
 * リモコンの alias を更新。注: 命名差で `deviceId`/`uuid`。
 * @param {WsClient} client
 * @param {{hub3DeviceId: string, uuid: string, alias: string, companyID: string}} p
 */
export function updateRemoteAlias(client: WsClient, { hub3DeviceId, uuid, alias, companyID }: {
    hub3DeviceId: string;
    uuid: string;
    alias: string;
    companyID: string;
}): Promise<import("./transport.js").WsMessage>;
/**
 * IR キー (ボタン) を追加。学習フロー (learnIRKey) から呼ばれることが多い。
 * `irCode` の形は biz3 がオブジェクトをそのまま乗せるので、
 * 呼び出し側で {hub3DeviceId, remoteId, name, irData, irWaveLength, irType, ...} を入れる。
 * @param {WsClient} client
 * @param {{irCode: object, companyID: string}} p
 */
export function addIRCode(client: WsClient, { irCode, companyID }: {
    irCode: object;
    companyID: string;
}): Promise<{}>;
/**
 * キー名変更。
 * @param {WsClient} client
 * @param {{hub3DeviceId: string, remoteId: string, keyUUID: string, name: string, companyID: string}} p
 */
export function updateIRCode(client: WsClient, { hub3DeviceId, remoteId, keyUUID, name, companyID }: {
    hub3DeviceId: string;
    remoteId: string;
    keyUUID: string;
    name: string;
    companyID: string;
}): Promise<import("./transport.js").WsMessage>;
/**
 * キー削除。
 * @param {WsClient} client
 * @param {{hub3DeviceId: string, remoteId: string, keyUUID: string, companyID: string}} p
 */
export function deleteIRCode(client: WsClient, { hub3DeviceId, remoteId, keyUUID, companyID }: {
    hub3DeviceId: string;
    remoteId: string;
    keyUUID: string;
    companyID: string;
}): Promise<import("./transport.js").WsMessage>;
/**
 * 現在の IR モード (CONTROL=0 / REGISTER=1) を取得。
 * @param {WsClient} client
 * @param {{deviceId: string, companyID: string}} p
 */
export function getIRMode(client: WsClient, { deviceId, companyID }: {
    deviceId: string;
    companyID: string;
}): Promise<unknown>;
/**
 * モード切替。学習するには REGISTER に入れる必要がある。
 * @param {WsClient} client
 * @param {{deviceId: string, mode: number, companyID: string}} p
 */
export function setIRMode(client: WsClient, { deviceId, mode, companyID }: {
    deviceId: string;
    mode: number;
    companyID: string;
}): Promise<import("./transport.js").WsMessage>;
/**
 * IR データ (= 学習で取り込まれた赤外線波形) の購読を開始。
 * 戻り値は `{ unsubscribe, onData }`。`onData(fn)` で `subscribeIRDataRsp` 受信ごとに fn が呼ばれる。
 * 利用後は必ず `unsubscribe()` を呼ぶこと。
 * @param {WsClient} client
 * @param {{deviceId: string, companyID: string}} p
 * @returns {Promise<{onData: (fn: (msg: any) => void) => (() => void), unsubscribe: () => void}>}
 */
export function subscribeIRData(client: WsClient, { deviceId, companyID }: {
    deviceId: string;
    companyID: string;
}): Promise<{
    onData: (fn: (msg: any) => void) => (() => void);
    unsubscribe: () => void;
}>;
/**
 * モード変化 (例: REGISTER から CONTROL に戻った瞬間) の購読。subscribeIRData と同形。
 * @param {WsClient} client
 * @param {{deviceId: string, companyID: string}} p
 * @returns {Promise<{onData: (fn: (msg: any) => void) => (() => void), unsubscribe: () => void}>}
 */
export function subscribeIRMode(client: WsClient, { deviceId, companyID }: {
    deviceId: string;
    companyID: string;
}): Promise<{
    onData: (fn: (msg: any) => void) => (() => void);
    unsubscribe: () => void;
}>;
/**
 * 学習で取った irData を既知のメーカー DB と照合する。
 * @param {WsClient} client
 * @param {{irData:string, irType:number, brandName?:string, companyID:string}} p
 */
export function matchRemote(client: WsClient, { irData, irType, brandName, companyID }: {
    irData: string;
    irType: number;
    brandName?: string;
    companyID: string;
}): Promise<any[]>;
/**
 * 物理リモコンのボタン 1 個を学習して、リモコンに新キーとして登録する。
 *
 *   1. setIRMode(REGISTER) — Hub3 を学習モードに
 *   2. subscribeIRData — 波形イベント購読
 *   3. (ユーザが物理リモコンを Hub3 に向けてボタンを押す)
 *   4. subscribeIRDataRsp イベントで波形を受信
 *   5. unsubscribeIRData + setIRMode(CONTROL)
 *   6. addIRCode で名前付きキーとして保存
 *
 * @param {{
 *   hub3DeviceId: string,
 *   remoteId: string,            // 既存リモコンの irDeviceUUID
 *   keyName: string,
 *   irType: number,              // remote.type
 *   companyID: string,
 *   timeoutMs?: number,          // ボタン押下待ち timeout (default 60s)
 *   onPrompt?: () => void,       // 学習モード突入後に呼ばれる (ユーザに「ボタン押して」と促す)
 * }} p
 * @param {WsClient} client
 * @returns {Promise<{keyUUID: string, captured: any, saved: any}>}
 *   keyUUID はクライアント発番 (これを send の command に使う)
 */
export function learnIRKey(client: WsClient, p: {
    hub3DeviceId: string;
    remoteId: string;
    keyName: string;
    irType: number;
    companyID: string;
    timeoutMs?: number;
    onPrompt?: () => void;
}): Promise<{
    keyUUID: string;
    captured: any;
    saved: any;
}>;
/**
 * 下位 WS トランスポート (transport.js の Hub3WsClient)。
 */
export type WsClient = import("./transport.js").Hub3WsClient;
export const MODE: Readonly<{
    CONTROL: 0;
    REGISTER: 1;
}>;
//# sourceMappingURL=ir.d.ts.map