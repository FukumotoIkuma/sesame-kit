/**
 * hub3_id から MQTT cmd topic を構築する (useIotCtrl.js:112-116)。
 * hub3_id 未指定なら device_id を流用 (WiFi モデルは自身が Hub3)。
 * 大文字小文字変換は一切しない。
 * @param {string} hub3Id 親 Hub3 (または自身) の UUID (ハイフン付き小文字想定)
 * @returns {string} `wm2{末尾セグメント}cmd`
 */
export function buildIotTopic(hub3Id: string): string;
/**
 * iot cmd の payload バイト列を構築し base64 文字列を返す (useIotCtrl.js:120-222)。
 * 連結順: signArray(4B) ++ cmd(1B) ++ device_id UTF8 ++ extra(任意)。
 *
 * @param {{
 *   cmd: number,            // cmdCode (下位8bit のみ採用)
 *   deviceId: string,       // 対象デバイスの UUID 文字列 (UTF8 バイト化される)
 *   secretKey: string,      // 32hex。署名に使う device の secretKey
 *   extra?: Uint8Array,     // cmd 別追加バイト (無ければ無し)
 * }} p
 * @returns {string} base64 payload
 */
export function buildIotPayload({ cmd, deviceId, secretKey, extra }: {
    cmd: number;
    deviceId: string;
    secretKey: string;
    extra?: Uint8Array;
}): string;
/**
 * 既に組み上げた topic / base64 payload で iot cmd を送る (useOperateIoT.js:54-61)。
 * 送信は fire-and-forget。応答 (op=数値cmdCode) を待ちたい場合は
 * subscribeIotResponse を併用するか、send 前後で購読すること。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{ topic: string, payload: string, op?: string }} p op は既定 'cmd'
 * @returns {void}
 */
export function sendIotCmd(client: import("./transport.js").Hub3WsClient, { topic, payload, op }: {
    topic: string;
    payload: string;
    op?: string;
}): void;
/**
 * iot cmd の応答 push を購読する (useOperateIoT.js:6-43)。
 * 購読キーは `biz3OperateIoT:<cmdCode>` (応答の message.op は数値 cmdCode の echo)。
 * 戻り値の unsubscribe を必ず呼ぶこと。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {number} cmd 待ち受ける cmdCode (応答 op と一致)
 * @param {(msg:any)=>void} fn 応答コールバック (msg 全体を渡す)
 * @returns {()=>void} unsubscribe
 */
export function subscribeIotResponse(client: import("./transport.js").Hub3WsClient, cmd: number, fn: (msg: any) => void): () => void;
/**
 * iot cmd を送信し、対象デバイスからの応答 push (op=cmd) を 1 件待つ共通ヘルパー。
 *
 * 応答 push は op=数値cmdCode で届き、device 特定は message.UUID || message.touch_id
 * (useOperateIoT.js:9-18)。deviceId 指定時はそれと一致する push のみ採用する。
 *
 * 注意 (未確認): RELAY_SWITCH(208) / CLEAR_WIFI_SSID(210) など、biz3 web 側に専用
 * コールバック登録が無い cmd は応答 push が来ない可能性がある。それらは
 * sendIotCmd (fire-and-forget) を使うこと。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{
 *   topic: string,
 *   payload: string,
 *   cmd: number,                // 応答 op と照合する cmdCode
 *   deviceId?: string,          // 応答の UUID/touch_id と照合 (省略時は最初の応答を採用)
 *   timeoutMs?: number,
 * }} p
 * @returns {Promise<any>} 応答 message (data があれば message 全体を返す。data 抽出は呼び出し側)
 */
export function sendIotCmdAwait(client: import("./transport.js").Hub3WsClient, { topic, payload, cmd, deviceId, timeoutMs }: {
    topic: string;
    payload: string;
    cmd: number;
    deviceId?: string;
    timeoutMs?: number;
}): Promise<any>;
/**
 * Hub3 (WiFi) 本体 LED の調光を設定/取得する (cmdCode=92 / 0x5C, useIotCtrl.js:163-190,
 * MobileWifiModule.js:129-172)。
 * payload extra = [op(1B), duty(1B)]。op は set=0x01 / get=0x02。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{
 *   deviceId: string,          // Hub3 の deviceUUID
 *   secretKey: string,         // Hub3 の secretKey (32hex)
 *   hub3Id?: string,           // topic 用。省略時 deviceId
 *   op: number,                // 0x01=set / 0x02=get (0..255)
 *   duty: number,              // 0..255 (set 時の輝度。get 時もダミー必須)
 *   timeoutMs?: number,
 * }} p
 * @returns {Promise<{ ledDuty: number|undefined, message: any }>} data.ledDuty (0..255)
 */
export function setHub3LedDuty(client: import("./transport.js").Hub3WsClient, p: {
    deviceId: string;
    secretKey: string;
    hub3Id?: string;
    op: number;
    duty: number;
    timeoutMs?: number;
}): Promise<{
    ledDuty: number | undefined;
    message: any;
}>;
/**
 * Hub3 LTE リレー (継電器) を開閉する (cmdCode=208 / 0xD0, useIotCtrl.js:192-213,
 * VIotSwitch.js:56-71)。
 * payload extra = [op(1B)] (省略時 op=0x01 = 開閉操作)。
 *
 * 応答 push は biz3 web に専用コールバック登録が無いため未確認 (spec responseShape:
 * useIotCtrl.js:192-213)。本ラッパは fire-and-forget で送信する (応答は待たない)。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{
 *   deviceId: string,          // Hub3 LTE の deviceUUID
 *   secretKey: string,         // 32hex
 *   hub3Id?: string,           // topic 用。省略時 deviceId
 *   op?: number,               // 既定 0x01
 * }} p
 * @returns {void}
 */
export function hub3RelaySwitch(client: import("./transport.js").Hub3WsClient, p: {
    deviceId: string;
    secretKey: string;
    hub3Id?: string;
    op?: number;
}): void;
/**
 * Hub3 にぶら下がり Sesame を追加する (cmdCode=101 / 0x65, useIotCtrl.js:53-107/159-161,
 * MobileBindDevice.js:70-97)。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{
 *   hub3Id: string,            // 親 Hub3 の deviceUUID (= device_id として payload に入る + topic)
 *   secretKey: string,         // 親 Hub3 の secretKey (32hex)。署名に使う
 *   sesameId: string,          // 追加する Sesame の UUID
 *   ssmSecKa: string,          // Sesame の secretKey (32hex)
 *   nickName?: string,
 *   deviceModel: string,       // 例 'sesame_5' (productType/matterProductType 導出に必要)
 *   timeoutMs?: number,
 * }} p
 * @returns {Promise<{ ssks: any, message: any }>} data.ssks (ぶら下がりリスト状態)
 */
export function addSesameToHub3(client: import("./transport.js").Hub3WsClient, p: {
    hub3Id: string;
    secretKey: string;
    sesameId: string;
    ssmSecKa: string;
    nickName?: string;
    deviceModel: string;
    timeoutMs?: number;
}): Promise<{
    ssks: any;
    message: any;
}>;
/**
 * Hub3 からぶら下がり Sesame を削除する (cmdCode=103 / 0x67, useIotCtrl.js:155-158)。
 * payload packing は ADD と完全同形 (handleSesameItemOperation を共用)。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {Parameters<typeof addSesameToHub3>[1]} p addSesameToHub3 と同じ
 * @returns {Promise<{ ssks: any, message: any }>}
 */
export function removeSesameFromHub3(client: import("./transport.js").Hub3WsClient, p: Parameters<typeof addSesameToHub3>[1]): Promise<{
    ssks: any;
    message: any;
}>;
/**
 * ファームウェア更新 (DFU) をトリガする (cmdCode=0x03, useIotCtrl.js:110-111/153,
 * UpgradeFirmware.js:98-120)。
 * iotPayload なし。payload = [sign, cmd=0x03, device_id]。
 *
 * 進捗は長時間にわたり複数回 push で届く (data={progress, versionTag, UUID})。
 * versionTag があれば完了。よって応答は subscribeIotResponse で複数回受ける設計とし、
 * 本関数は送信のみ + 購読 unsubscribe を返す。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{
 *   deviceId: string,          // 更新対象の UUID (payload の device_id)
 *   hub3Id?: string,           // topic 用 (親 Hub3。WiFi モデルは自身)。省略時 deviceId
 *   secretKey: string,         // 32hex
 *   onProgress?: (data:{progress?:number, versionTag?:string, UUID?:string})=>void,
 * }} p
 * @returns {()=>void} unsubscribe (進捗購読の解除)
 */
export function startFirmwareUpdate(client: import("./transport.js").Hub3WsClient, p: {
    deviceId: string;
    hub3Id?: string;
    secretKey: string;
    onProgress?: (data: {
        progress?: number;
        versionTag?: string;
        UUID?: string;
    }) => void;
}): () => void;
/**
 * Hub3 の保存 WiFi 設定をクリアする (cmdCode=210 / 0xD2, useIotCtrl.js:214-215,
 * MobileWifiModule.js:146-153)。追加バイト無し。
 *
 * 応答 push は専用コールバック登録が無く未確認のため fire-and-forget。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{ deviceId: string, secretKey: string, hub3Id?: string }} p
 * @returns {void}
 */
export function clearHub3WifiSsid(client: import("./transport.js").Hub3WsClient, { deviceId, secretKey, hub3Id }: {
    deviceId: string;
    secretKey: string;
    hub3Id?: string;
}): void;
/**
 * Matter ペアリングコード (QR/手動コード) を取得する (cmdCode=137 / 0x89,
 * MobileWifiModule.js:82-96)。iotPayload なし。
 *
 * 注意: cmdCode 137 は STP_ITEM_CODE_PASSCODE_CHANGE_VALUE とも重複定義 (cmdCode.js:73,80)。
 * Hub3 文脈で使うこと。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{ deviceId: string, secretKey: string, hub3Id?: string, timeoutMs?: number }} p
 * @returns {Promise<{ qrCode: string|undefined, manualCode: string|undefined, message: any }>}
 */
export function getMatterPairingCode(client: import("./transport.js").Hub3WsClient, p: {
    deviceId: string;
    secretKey: string;
    hub3Id?: string;
    timeoutMs?: number;
}): Promise<{
    qrCode: string | undefined;
    manualCode: string | undefined;
    message: any;
}>;
/**
 * Matter ペアリング窓を開く (cmdCode=153 / 0x99, MobileWifiModule.js:97-126)。iotPayload なし。
 * data={statusCode}。statusCode===0 で成功。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{ deviceId: string, secretKey: string, hub3Id?: string, timeoutMs?: number }} p
 * @returns {Promise<{ statusCode: number|undefined, message: any }>}
 */
export function openMatterPairingWindow(client: import("./transport.js").Hub3WsClient, p: {
    deviceId: string;
    secretKey: string;
    hub3Id?: string;
    timeoutMs?: number;
}): Promise<{
    statusCode: number | undefined;
    message: any;
}>;
export namespace __internal {
    export { hexStringToUint8Array };
    export { stringToUint8Array };
    export { getProductTypeFromModelName };
    export { getMatterProductTypeFromModelName };
    export { buildSesameItemExtra };
    export { concatBytes };
}
/**
 * namespace (hub.iot.*) に露出する client op の allowlist。
 * buildIotTopic / buildIotPayload / __internal は client を取らない内部ヘルパー
 * なので namespace に出さない (低レベル用途は index.js から直接 import)。
 */
export const NAMESPACE_OPS: string[];
/**
 * hex 文字列を Uint8Array に変換 (biz3utils.js:221-235)。
 * null/undefined は空配列 (biz3utils と同挙動)。奇数長は例外。
 * @param {string|null|undefined} hexString
 * @returns {Uint8Array}
 */
declare function hexStringToUint8Array(hexString: string | null | undefined): Uint8Array;
/**
 * 文字列を UTF8 バイト列に変換 (biz3utils.js:240-243 stringToUint8Array)。
 * @param {string} str
 * @returns {Uint8Array}
 */
declare function stringToUint8Array(str: string): Uint8Array;
/**
 * deviceModel 名 → productType の数値 (biz3utils.js:53-56)。
 * vendor の modelNameByProductType を逆引き。未知は null。
 * @param {string} modelName
 * @returns {number|null}
 */
declare function getProductTypeFromModelName(modelName: string): number | null;
/**
 * deviceModel 名 → matter product type (biz3utils.js:58-101)。
 * productType が不明なら null。map に無ければ undefined。
 * @param {string} modelName
 * @returns {number|null|undefined}
 */
declare function getMatterProductTypeFromModelName(modelName: string): number | null | undefined;
/**
 * ADD/REMOVE_SESAME の追加バイトを構築する (handleSesameItemOperation, useIotCtrl.js:53-107)。
 * 連結順: sesameId(16B) ++ secretKey(16B) ++ nickNameLen(1B) ++ nickNameUTF8 ++
 *         productType(1B) ++ matterProductType(1B)。
 *
 * @param {{ sesameId: string, ssmSecKa: string, nickName?: string, deviceModel: string }} iotPayload
 * @returns {Uint8Array}
 */
declare function buildSesameItemExtra(iotPayload: {
    sesameId: string;
    ssmSecKa: string;
    nickName?: string;
    deviceModel: string;
}): Uint8Array;
/**
 * Uint8Array を連結する小ヘルパー (biz3 の手動 offset 連結を簡潔化)。
 * @param  {...Uint8Array} arrays
 * @returns {Uint8Array}
 */
declare function concatBytes(...arrays: Uint8Array[]): Uint8Array;
export {};
//# sourceMappingURL=iot.d.ts.map