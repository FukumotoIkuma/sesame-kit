/**
 * getRemoteList / searchRemoteList の戻り値。
 * vendor (useRemoteCtrl.js:43-57) の応答 `message.data` は {data:[...], pagination:{...}} の
 * ラッパーで、一覧本体は `message.data.data`、ページング情報は `message.data.pagination`
 * (currentPage / pageSize / hasMore 等。次ページは currentPage+1, hasMore で打ち切り —
 *  loadMoreRemotes, useRemoteCtrl.js:431-441)。
 * @typedef {{ list: any[], pagination: {currentPage?:number, pageSize?:number, hasMore?:boolean} | null }} RemoteListPage
 */
/**
 * 登録済みリモコン一覧を取得 (ページング)。
 * 次ページは戻り値 pagination の currentPage+1 を page に渡す (hasMore が false なら終端 —
 * vendor loadMoreRemotes, useRemoteCtrl.js:431-441)。
 * @param {WsClient} client
 * @param {{type:number, companyID:string, page?:number, pageSize?:number}} p
 *   type は **実 remote.type** (自己学習=0xFE00, UI メニューの 0xFEFF ではない / 上記トラップ参照)
 * @returns {Promise<RemoteListPage>}
 */
export function getRemoteList(client: WsClient, p: {
    type: number;
    companyID: string;
    page?: number;
    pageSize?: number;
}): Promise<RemoteListPage>;
/**
 * プリセットリモコン (メーカー DB) 検索。最大 1000 件返却
 * (vendor は page=1/pageSize=1000 固定で frame にページング引数を露出しない —
 *  useRemoteCtrl.js:406-414)。
 * @param {WsClient} client
 * @param {{type:number, companyID:string, searchTerm:string}} p
 * @returns {Promise<RemoteListPage>}
 */
export function searchRemoteList(client: WsClient, p: {
    type: number;
    companyID: string;
    searchTerm: string;
}): Promise<RemoteListPage>;
/**
 * プリセットリモコンをあと 1 個追加できるかどうか判定する。
 *
 * vendor 実装 1:1 (references_web/src/api/useRemoteCtrl.js:226-255 canAddMoreRemote):
 *   - type が 0xfe00 (自己学習) なら無制限 → true
 *   - stateInfo.remoteList 内で type in {0x8000, 0x2000, 0xe000, 0xc000} の件数が 3 未満なら true
 *
 * vendor は counts >= 3 のときスナックバーを表示して false を返す。kit では UI が無いため
 * false を返すのみとし、呼び出し元 (addIRRemoteServer) が badRequest をスローする。
 *
 * @param {number} newType 追加しようとするリモコンの type
 * @param {Array<{type?: number|string}>} remoteList stateInfo.remoteList (対象 Hub3 デバイスの配列)
 * @returns {boolean} 追加可能なら true
 */
export function canAddMoreRemote(newType: number, remoteList: Array<{
    type?: number | string;
}>): boolean;
/**
 * リモコンを追加。
 *
 * vendor 形 (导出元: references_web/src/pages/.../ir/learn/index.js:261-270,
 *              remote-air/index.js:512-521, remote-non-air/index.js:264-273):
 *   remote = {
 *     uuid       — クライアント発番 UUID (必須; 省略時はここで generateUUID() を補完)。
 *     model      — リモコンのモデル文字列。
 *     state      — 最後に発射したコマンド HEX (初回は '')。
 *     alias      — 表示名 (vendor の localRemoteAlias)。
 *     code       — preset コード文字列。
 *     type       — リモコン種別 int (0xC000/0x2000/0xE000/0x8000/0xFE00 等)。
 *     deviceUUID — Hub3 の deviceId (= hub3DeviceId)。**必須。欠落時は badRequest。**
 *     keys       — キー配列 (初回は [])。
 *   }
 *
 * ⚠️ 旧ドキュメントの {hub3DeviceId, name, irOperation} はいずれも存在しない。
 *    vendor は uuid/alias/state/deviceUUID/keys を自前で付加してから送信しており、
 *    「search/match 出力をそのまま渡せる」は誤り。本関数でその組み立てを行う。
 *
 * 上限メモ: vendor クライアント側で type 4 種(0x8000/0x2000/0xE000/0xC000)を
 * stateInfo.remoteList で数え 3 個以上なら拒否する (canAddMoreRemote — P3-2 実装済み)。
 * サーバ側 enforcement のコードは参照に無い(「サーバ側にある」は出典なし — P3-2 訂正)。
 * 出典: references_web/src/api/useRemoteCtrl.js:226-255 (canAddMoreRemote),
 *       同 :525-531 (addIRRemote が送信前にこのガードを通す)。
 *
 * @param {WsClient} client
 * @param {{remote: object & {uuid?: string, deviceUUID?: unknown}, companyID: string}} p
 */
export function addIRRemote(client: WsClient, { remote, companyID }: {
    remote: object & {
        uuid?: string;
        deviceUUID?: unknown;
    };
    companyID: string;
}): Promise<{} | null>;
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
 * リモコンの保存 state (最後に発射した command HEX) をサーバへ永続化する (P3-2)。
 *
 * vendor (useRemoteCtrl.js:493-514 updateRemoteState):
 *   frame = { action, op:'updateRemoteState', deviceId: hub3DeviceId, uuid: remoteId,
 *             state, companyID }
 * フィールド名トラップ: Hub3 は **deviceId**、リモコンは **uuid** (alias 系と同じ命名)。
 * state はエアコン等の「最後に送った command HEX 文字列」 (remote-air/index.js:371-377 が
 * sendIR 成功後に cmd をそのまま渡す)。次回はこの state から復元する
 * (remote-air/index.js:108-113 → presetir.restoreAirState)。
 *
 * @param {WsClient} client
 * @param {{hub3DeviceId: string, uuid: string, state: string, companyID: string}} p
 */
export function updateRemoteState(client: WsClient, { hub3DeviceId, uuid, state, companyID }: {
    hub3DeviceId: string;
    uuid: string;
    state: string;
    companyID: string;
}): Promise<import("./transport.js").WsMessage>;
/**
 * リモコンを Matter デバイスとして Hub3 に登録する (P3-3)。
 *
 * vendor (useRemoteCtrl.js:933-955 addRemoteToMatter) のフィールド 1:1:
 *   frame = { action, op:'addRemoteToMatter', hub3DeviceId, irDeviceType: irRemote.type,
 *             cmdOn, cmdOff, irDeviceUUID: irRemote.uuid, irDeviceName: irRemote.alias, companyID }
 * Matter ペアリング窓 (iot.js `openMatterPairingWindow`) の開放後に呼ぶことで、リモコンが Matter の
 * On/Off デバイスとして見えるようになる (cmdOn/cmdOff は発射 command HEX)。
 *
 * @experimental 実機未検証 (参照: useRemoteCtrl.js:933-955)。
 * @param {WsClient} client
 * @param {{hub3DeviceId: string, irDeviceType: number, cmdOn: string, cmdOff: string,
 *          irDeviceUUID: string, irDeviceName: string, companyID: string}} p
 */
export function addRemoteToMatter(client: WsClient, { hub3DeviceId, irDeviceType, cmdOn, cmdOff, irDeviceUUID, irDeviceName, companyID }: {
    hub3DeviceId: string;
    irDeviceType: number;
    cmdOn: string;
    cmdOff: string;
    irDeviceUUID: string;
    irDeviceName: string;
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
 * getRemoteList / searchRemoteList の戻り値。
 * vendor (useRemoteCtrl.js:43-57) の応答 `message.data` は {data:[...], pagination:{...}} の
 * ラッパーで、一覧本体は `message.data.data`、ページング情報は `message.data.pagination`
 * (currentPage / pageSize / hasMore 等。次ページは currentPage+1, hasMore で打ち切り —
 *  loadMoreRemotes, useRemoteCtrl.js:431-441)。
 */
export type RemoteListPage = {
    list: any[];
    pagination: {
        currentPage?: number;
        pageSize?: number;
        hasMore?: boolean;
    } | null;
};
/**
 * 下位 WS トランスポート (transport.js の Hub3WsClient)。
 */
export type WsClient = import("./transport.js").Hub3WsClient;
export const MODE: Readonly<{
    CONTROL: 0;
    REGISTER: 1;
}>;
//# sourceMappingURL=ir.d.ts.map