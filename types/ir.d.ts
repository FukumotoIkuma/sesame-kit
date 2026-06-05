/**
 * 登録済みリモコン一覧を取得 (ページング)。
 * @param {{type:number, companyID:string, page?:number, pageSize?:number}} p
 *   type は **実 remote.type** (自己学習=0xFE00, UI メニューの 0xFEFF ではない / 上記トラップ参照)
 */
export function getRemoteList(client: any, p: {
    type: number;
    companyID: string;
    page?: number;
    pageSize?: number;
}): Promise<any>;
/**
 * プリセットリモコン (メーカー DB) 検索。最大 1000 件返却。
 * @param {{type:number, companyID:string, searchTerm:string}} p
 */
export function searchRemoteList(client: any, p: {
    type: number;
    companyID: string;
    searchTerm: string;
}): Promise<any>;
/**
 * リモコンを追加 (Hub3 1 台あたり 3 個上限がサーバ側にある)。
 * `remote` の形は biz3 がそのまま remoteDevice オブジェクトを渡しているので、
 * 呼び出し側で {hub3DeviceId, type, name, irOperation, ...} を入れる。
 */
export function addIRRemote(client: any, { remote, companyID }: {
    remote: any;
    companyID: any;
}): Promise<any>;
/** リモコン削除。 */
export function deleteIRRemote(client: any, { hub3DeviceId, uuid, companyID }: {
    hub3DeviceId: any;
    uuid: any;
    companyID: any;
}): Promise<any>;
/** リモコンの alias を更新。注: 命名差で `deviceId`/`uuid`。 */
export function updateRemoteAlias(client: any, { hub3DeviceId, uuid, alias, companyID }: {
    hub3DeviceId: any;
    uuid: any;
    alias: any;
    companyID: any;
}): Promise<any>;
/**
 * IR キー (ボタン) を追加。学習フロー (learnIRKey) から呼ばれることが多い。
 * `irCode` の形は biz3 がオブジェクトをそのまま乗せるので、
 * 呼び出し側で {hub3DeviceId, remoteId, name, irData, irWaveLength, irType, ...} を入れる。
 */
export function addIRCode(client: any, { irCode, companyID }: {
    irCode: any;
    companyID: any;
}): Promise<any>;
/** キー名変更。 */
export function updateIRCode(client: any, { hub3DeviceId, remoteId, keyUUID, name, companyID }: {
    hub3DeviceId: any;
    remoteId: any;
    keyUUID: any;
    name: any;
    companyID: any;
}): Promise<any>;
/** キー削除。 */
export function deleteIRCode(client: any, { hub3DeviceId, remoteId, keyUUID, companyID }: {
    hub3DeviceId: any;
    remoteId: any;
    keyUUID: any;
    companyID: any;
}): Promise<any>;
/** 現在の IR モード (CONTROL=0 / REGISTER=1) を取得。 */
export function getIRMode(client: any, { deviceId, companyID }: {
    deviceId: any;
    companyID: any;
}): Promise<any>;
/** モード切替。学習するには REGISTER に入れる必要がある。 */
export function setIRMode(client: any, { deviceId, mode, companyID }: {
    deviceId: any;
    mode: any;
    companyID: any;
}): Promise<any>;
/**
 * IR データ (= 学習で取り込まれた赤外線波形) の購読を開始。
 * 戻り値は `{ unsubscribe, onData }`。`onData(fn)` で `subscribeIRDataRsp` 受信ごとに fn が呼ばれる。
 * 利用後は必ず `unsubscribe()` を呼ぶこと。
 */
export function subscribeIRData(client: any, { deviceId, companyID }: {
    deviceId: any;
    companyID: any;
}): Promise<{
    onData(fn: any): () => boolean;
    unsubscribe(): void;
}>;
/** モード変化 (例: REGISTER から CONTROL に戻った瞬間) の購読。subscribeIRData と同形。 */
export function subscribeIRMode(client: any, { deviceId, companyID }: {
    deviceId: any;
    companyID: any;
}): Promise<{
    onData(fn: any): () => boolean;
    unsubscribe(): void;
}>;
/**
 * 学習で取った irData を既知のメーカー DB と照合する。
 * @param {{irData:string, irType:number, brandName?:string, companyID:string}} p
 */
export function matchRemote(client: any, { irData, irType, brandName, companyID }: {
    irData: any;
    irType: any;
    brandName: any;
    companyID: any;
}): Promise<any>;
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
 * @returns {Promise<{keyUUID: string, captured: any, saved: any}>}
 *   keyUUID はクライアント発番 (これを send の command に使う)
 */
export function learnIRKey(client: any, p: {
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
export const MODE: Readonly<{
    CONTROL: 0;
    REGISTER: 1;
}>;
//# sourceMappingURL=ir.d.ts.map