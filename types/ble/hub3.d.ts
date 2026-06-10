/** scanWifiSSID: data 無し (CHHub3Device.kt:241 byteArrayOf())。結果は SSID_NOTIFY publish で届く。 */
export function scanWifiSSIDData(): Buffer<ArrayBuffer>;
/**
 * setWifiSSID: data = SSID の UTF-8 bytes (CHHub3Device.kt:256 ssid.toByteArray())。
 * @param {string} ssid
 * @returns {Buffer}
 */
export function setWifiSSIDData(ssid: string): Buffer;
/**
 * setWifiPassword: data = パスワードの UTF-8 bytes (CHHub3Device.kt:247 password.toByteArray())。
 * @param {string} password
 * @returns {Buffer}
 */
export function setWifiPasswordData(password: string): Buffer;
/**
 * removeSesame: data = dash 除去した UUID 文字列 (32hex) を **生バイトへ decode** した 16B
 * (CHHub3Device.kt:230-232 noDashUUID.hexStringToByteArray())。
 *
 * 注: WM2 の removeSesame (wm2.js) は「大文字 UUID 文字列の UTF-8 bytes」を送るが、Hub3 は
 *   「dash 除去 hex を decode した生 16B」を送る (SDK で経路が異なる)。混同しないこと。
 *
 * @param {string} tag 削除対象の鍵タグ (UUID 文字列、dash あり/なし可)。
 * @returns {Buffer} 16B
 */
export function removeSesameData(tag: string): Buffer;
/** networkType 取得コマンドの data (無し)。状態は NETWORK_TYPE(209) publish で届く。 */
export function networkTypeData(): Buffer<ArrayBuffer>;
/**
 * SSID_NOTIFY(133) publish payload を解析 (CHHub3Device.kt:322-326)。
 *   ssidRssi = bytesToShort(payload[0], payload[1])  — 先頭 2B を short に
 *   ssidStr  = String(payload.drop(2))               — 残りを UTF-8 文字列
 *
 * 注: SDK の bytesToShort(byte1, byte2) は DataExtention.kt:99-102 で
 *   **((byte2 and 0xFF) shl 8) or (byte1 and 0xFF)** = byte1 が下位・byte2 が上位 =
 *   **little-endian signed short**。呼び出しは bytesToShort(payload[0], payload[1]) なので
 *   payload[0]=下位 / payload[1]=上位。よって readInt16LE と等価 (RSSI は負値を取り得るため signed)。
 *   wm2.js parseScanWifiSSID と同一ロジック。
 *
 * @param {Buffer} payload
 * @returns {{rssi:number, ssid:string}}
 */
export function parseScanWifiSSID(payload: Buffer): {
    rssi: number;
    ssid: string;
};
/**
 * NETWORK_TYPE(209) publish payload を解析 (CHHub3Device.kt:328-333)。
 *   isWifiConnected = payload[0].toInt() == 1
 *   isLTEConnected  = payload[1].toInt() == 1
 * CHHub3NetWorkType (CHWifiModule2.kt:42-44) の 2 フラグに対応する。
 *
 * @param {Buffer} payload (>=2B)
 * @returns {{isWifiConnected:boolean, isLTEConnected:boolean}}
 */
export function parseNetworkType(payload: Buffer): {
    isWifiConnected: boolean;
    isLTEConnected: boolean;
};
/**
 * mechSetting(80) publish = Hub3 の Wi-Fi 設定 (SSID/パスワード)。CHHub3Device.kt:272-285 と 1:1。
 * payload 長で旧/新ファームを分岐:
 *   - 96B 未満 (旧 Hub3 ファーム、60B): SSID = payload[0..29] / パスワード = payload[30..59]
 *   - 96B 以上 (新 Hub3 ファーム):       SSID = payload[0..31] / パスワード = payload[32..95]
 * いずれも文字列化後、末尾の 0x00 と '?' を trim する (SDK の trimEnd(0.toChar(), '?'))。
 *
 * @param {Buffer} payload
 * @returns {{wifiSSID:string, wifiPassWord:string}}
 */
export function parseMechSetting(payload: Buffer): {
    wifiSSID: string;
    wifiPassWord: string;
};
/**
 * PUB_KEY_SESAME(102) publish = Hub3 が保持する子 Sesame 鍵束 (CHHub3Device.kt:299-314)。
 * 23B チャンクに分割し、lock_status(chunk[22]) != 0 のものだけを {deviceUUID, index} で返す。
 *   ss5_id  = chunk[0..15]                                   (16B 生 UUID)
 *   ssmID   = ss5_id.toHexString().noHashtoUUID()            (ハイフン付き UUID 文字列)
 *   status  = chunk[22]                                      (0 を除外)
 *
 * 注: WM2 (wm2.js parseSesameKeys) は 22B を base64 文字列として decode するが、Hub3 は
 *   先頭 16B を **生 UUID バイト**としてそのまま hex→UUID 整形する (SDK で経路が異なる)。
 *
 * @param {Buffer} payload 23B の倍数。
 * @returns {Array<{deviceUUID:string, index:number}>} status!=0 のエントリのみ、payload 順。
 */
export function parseSesameKeys(payload: Buffer): Array<{
    deviceUUID: string;
    index: number;
}>;
/**
 * Hub3 の publish ({itemCode, body}) を itemCode ごとに解析して `{ kind, ... }` の正規化
 * オブジェクトに変換する (session.onPublish のディスパッチ補助)。
 *
 * 対応 (CHHub3Device.kt:268-340 onGattSesamePublish):
 *   MECH_SETTING(80)         → { kind:"mechSetting", wifiSSID, wifiPassWord }
 *   PUB_KEY_SESAME(102)      → { kind:"sesameKeys", keys:[{deviceUUID,index}] }
 *   MOVE_TO(84)              → { kind:"otaProgress", progress }  (payload.first(), OTA 進捗)
 *   HUB3_ITEM_CODE_SSID_NOTIFY(133)  → { kind:"scanWifiSSID", rssi, ssid }
 *   HUB3_ITEM_CODE_NETWORK_TYPE(209) → { kind:"networkType", isWifiConnected, isLTEConnected }
 *   HUB3_ITEM_CODE_SSID_FIRST(132) / SSID_LAST(134) → { kind:"ssidMarker", itemCode }  (SDK は no-op)
 * 上記以外 (mechStatus(81) はネットワーク状態として session が別途扱う) は
 *   { kind:"unknown", itemCode, body } を返す。
 *
 * @param {{itemCode:number, body:Buffer}} pub
 * @returns {object} 解析結果
 */
export function parseHub3Publish({ itemCode, body }: {
    itemCode: number;
    body: Buffer;
}): object;
export class Hub3Commands {
    /**
     * @param {{session:import("./session.js").SesameBleSession}} opts
     *   session: SESAME 既定 GATT で接続/ログイン済み (もしくは register 済み) の SesameBleSession。
     */
    constructor({ session }?: {
        session: import("./session.js").SesameBleSession;
    });
    /** @type {Set<(parsed:any)=>void>} */
    /** @type {(() => void)|null} session publish 中継の unsubscribe。 */
    /** Hub3 publish (正規化済み {kind, ...}) を購読。戻り値 unsubscribe。 @param {(parsed:any)=>void} fn */
    onPublish(fn: (parsed: any) => void): () => boolean;
    /** 購読解除 (session の publish 中継を外す)。 */
    dispose(): void;
    /**
     * 周辺 Wi-Fi SSID をスキャン (CHHub3Device.kt:238-244)。
     * 結果は onPublish の {kind:"scanWifiSSID"} で逐次届く。
     */
    scanWifiSSID(): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /** Wi-Fi SSID を設定 (CHHub3Device.kt:255-265、HUB3_UPDATE_WIFI_SSID=136)。 @param {string} ssid */
    setWifiSSID(ssid: string): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /** Wi-Fi パスワードを設定 (CHHub3Device.kt:246-253、HUB3_ITEM_CODE_WIFI_PASSWORD=135)。 @param {string} password */
    setWifiPassword(password: string): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * 子 Sesame を Hub3 から削除する (CHHub3Device.kt:228-236、REMOVE_SESAME=103)。
     * data は dash 除去 UUID(32hex) を decode した生 16B (WM2 とは経路が異なる)。
     * @param {string} tag 削除対象の鍵タグ (UUID 文字列)。
     */
    removeSesame(tag: string): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * Hub3 に現在の接続種別を要求する (NETWORK_TYPE=209)。
     * 状態は onPublish の {kind:"networkType"} で届く。
     *
     * 注: CHHub3Device.kt は NETWORK_TYPE の **送信 (要求)** 経路を明示しておらず、publish 受信
     *   (CHHub3Device.kt:328-333) のみ確認できる。要求コマンドとして空 data を送る本メソッドは
     *   SDK で送信側が確認できない (publish 専用の可能性がある) ため実機未検証。受信だけ必要なら
     *   onPublish の {kind:"networkType"} を購読すればよい。
     */
    networkType(): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
}
import { Buffer } from "node:buffer";
//# sourceMappingURL=hub3.d.ts.map