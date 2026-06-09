/** scanWifiSSID: data 無し (CHWifiModule2Device.kt:324 byteArrayOf())。結果は publish で届く。 */
export function scanWifiSSIDData(): Buffer<ArrayBuffer>;
/**
 * setWifiSSID: data = SSID の UTF-8 bytes (CHWifiModule2Device.kt:337 ssid.toByteArray())。
 * @param {string} ssid
 * @returns {Buffer}
 */
export function setWifiSSIDData(ssid: string): Buffer;
/**
 * setWifiPassword: data = パスワードの UTF-8 bytes (CHWifiModule2Device.kt:351 password.toByteArray())。
 * @param {string} password
 * @returns {Buffer}
 */
export function setWifiPasswordData(password: string): Buffer;
/**
 * connectWifi: data = verification の UTF-8 bytes (CHWifiModule2Device.kt:358-363)。
 *   company       = API_GATEWAY_CLIENT_ID から ":" と "-" を除去した文字列
 *   verification  = company + ":" + deviceId.uppercase().split('-').last()
 *                   (deviceUUID を大文字化し、最後のハイフン区切りセグメント = 末尾 12hex を採る)
 *
 * @param {{companyId?:string, deviceUUID?:string}} [args]
 *   companyId = co.candyhouse.sesame.BuildConfig.API_GATEWAY_CLIENT_ID。SDK では Cognito の
 *     identity pool 風 "ap-northeast-1:xxxx-..." 形式で、":"/"-" を除いた英数字を company とする。
 *   deviceUUID = 接続中 WM2 の deviceId (CHDeviceUtil.deviceId)。
 * @returns {Buffer}
 */
export function connectWifiData({ companyId, deviceUUID }?: {
    companyId?: string;
    deviceUUID?: string;
}): Buffer;
/**
 * insertSesames: data = allKey (子 Sesame の鍵束)。CHWifiModule2Device.kt:380-401 を 1:1 移植。
 *
 *   noHashUUID = sesame2KeyData.deviceUUID.replace("-","")          (32hex)
 *   b64k       = base64(hexToBytes(noHashUUID)).replace("=","")     (16B → base64, パディング除去)
 *   ssmIRData  = b64k.toByteArray()                                  (UTF-8 = ASCII bytes)
 *   ssmPKData  = (sesame_5/5_pro/5_us/bike_2 のとき) 固定 64B 公開鍵
 *                それ以外は sesame2PublicKey.hexToBytes()            (64B)
 *   ssmSecKa   = secretKey.hexToBytes()                              (16B)
 *   ssmUUid    = deviceUUID.uppercase().toByteArray()                (ハイフン込み UUID 文字列の UTF-8)
 *   allKey     = ssmIRData ++ ssmPKData ++ ssmSecKa ++ ssmUUid
 *
 * 注: ssmIRData (base64 文字列の **ASCII bytes**) と ssmUUid (ハイフン付き大文字 UUID 文字列の
 *   ASCII bytes) は「バイト列化された文字列」であって生バイナリではない。SDK の挙動どおり文字列を
 *   そのまま UTF-8 で詰める。base64 パディング "=" は除去する (CHWifiModule2Device.kt:382)。
 *
 * 子 Sesame の鍵 (cloud の `sesame devices` 由来)。
 * @typedef {Object} ChildSesameKey
 * @property {string} deviceUUID
 * @property {string|Buffer} secretKey
 * @property {string|Buffer} [sesame2PublicKey]
 * @property {string} [deviceModel]
 *
 * @param {Partial<ChildSesameKey>} [sesameKey] 子 Sesame の鍵。runtime で必須項目を検証する。
 *   deviceModel が sesame_5/5_pro/5_us/bike_2 のとき sesame2PublicKey は無視され固定 PK が使われる。
 * @returns {Buffer} allKey
 */
export function insertSesamesData(sesameKey?: Partial<ChildSesameKey>): Buffer;
/**
 * removeSesame: data = sesameKeyTag を大文字化した UTF-8 bytes (CHWifiModule2Device.kt:415)。
 * @param {string} sesameKeyTag 削除対象の鍵タグ。
 * @returns {Buffer}
 */
export function removeSesameData(sesameKeyTag: string): Buffer;
/** networkStatus 取得コマンドの data (無し)。状態は publish (NETWORK_STATUS) で届く。 */
export function networkStatusData(): Buffer<ArrayBuffer>;
/**
 * SCAN_WIFI_SSID publish payload を解析 (CHWifiModule2Device.kt:486-490)。
 *   ssidRssi = bytesToShort(payload[0], payload[1])  — 先頭 2B を short に
 *   ssidStr  = String(payload.drop(2))               — 残りを UTF-8 文字列
 *
 * 注: SDK の bytesToShort(byte1, byte2) は DataExtention.kt:99-102 で
 *   **((byte2 and 0xFF) shl 8) or (byte1 and 0xFF)** = byte1 が下位・byte2 が上位 =
 *   **little-endian signed short**。呼び出しは bytesToShort(payload[0], payload[1]) なので
 *   payload[0]=下位 / payload[1]=上位。よって readInt16LE と等価 (RSSI は負値を取り得るため signed)。
 *
 * @param {Buffer} payload
 * @returns {{rssi:number, ssid:string}}
 */
export function parseScanWifiSSID(payload: Buffer): {
    rssi: number;
    ssid: string;
};
/**
 * UPDATE_WIFI_SSID publish = 現在の SSID 文字列 (CHWifiModule2Device.kt:491-495)。
 * @param {Buffer} payload
 * @returns {string}
 */
export function parseWifiSSIDPublish(payload: Buffer): string;
/**
 * UPDATE_WIFI_PASSWORD publish = 現在のパスワード文字列 (CHWifiModule2Device.kt:496-500)。
 * @param {Buffer} payload
 * @returns {string}
 */
export function parseWifiPasswordPublish(payload: Buffer): string;
/**
 * NETWORK_STATUS publish payload[0] のビットフラグを解析 (CHWifiModule2Device.kt:502-510)。
 *   isAp           = (payload[0] and 2)  > 0   bit1
 *   isNet          = (payload[0] and 4)  > 0   bit2
 *   isIot          = (payload[0] and 8)  > 0   bit3
 *   isAPCheck      = (payload[0] and 16) > 0   bit4
 *   isAPConnecting = (payload[0] and 32) > 0   bit5
 *   isNETConnecting= (payload[0] and 64) > 0   bit6
 *   isIOTConnecting= payload[0] < 0            (Kotlin signed Byte の最上位 bit7)
 *
 * 注: Kotlin の payload[0] は **signed Byte**。最上位 bit (0x80) が立つと負値になり、
 *   isIOTConnecting = (payload[0] < 0) はそのまま bit7 判定と等価。JS では payload[0] は
 *   0..255 の unsigned なので bit7 を (b & 0x80) で判定する (= 等価)。
 *
 * @param {Buffer} payload (>=1B)
 * @returns {{isAp:boolean, isNet:boolean, isIot:boolean, isAPCheck:boolean,
 *            isAPConnecting:boolean, isNETConnecting:boolean, isIOTConnecting:boolean, raw:number}}
 */
export function parseNetworkStatus(payload: Buffer): {
    isAp: boolean;
    isNet: boolean;
    isIot: boolean;
    isAPCheck: boolean;
    isAPConnecting: boolean;
    isNETConnecting: boolean;
    isIOTConnecting: boolean;
    raw: number;
};
/**
 * SESAME_KEYS publish payload を 23B チャンクに分割し、子 Sesame の {ssm id → ロック状態} を返す
 * (CHWifiModule2Device.kt:468-485)。各エントリ:
 *   ss2_ir_22   = chunk[0..21]   (22B = base64 で詰めた IR データ)
 *   lock_status = chunk[22]      (0:未接続 / 1:BLE 接続 / 2:ログイン成功)
 *   ssmID       = noHashtoUUID(base64decodeHex(String(ss2_ir_22) + "=="))
 *
 *   String(ss2_ir_22) は 22B を ASCII 文字列に戻し、"==" を補って base64 デコード → 16B →
 *   ハイフン付き UUID 文字列 (noHashtoUUID) に整形する。
 *
 * @param {Buffer} payload 23B の倍数。
 * @returns {Array<{deviceUUID:string, status:number}>} 順序は payload 順。
 *   壊れたエントリ (base64 デコード/長さ不正) は SDK 同様スキップする (try/catch 相当)。
 */
export function parseSesameKeys(payload: Buffer): Array<{
    deviceUUID: string;
    status: number;
}>;
/**
 * WM2 の publish ({itemCode, body}) を action code ごとに解析して
 * `{ kind, ... }` の正規化オブジェクトに変換する (session.onPublish のディスパッチ補助)。
 *
 * 対応 (CHWifiModule2Device.kt:461-529 onGattWM2Publish):
 *   SCAN_WIFI_SSID(19)      → { kind:"scanWifiSSID", rssi, ssid }
 *   UPDATE_WIFI_SSID(3)     → { kind:"wifiSSID", ssid }
 *   UPDATE_WIFI_PASSWORD(4) → { kind:"wifiPassword", password }
 *   NETWORK_STATUS(6)       → { kind:"networkStatus", ...flags }
 *   SESAME_KEYS(16)         → { kind:"sesameKeys", keys:[{deviceUUID,status}] }
 *   OPEN_OTA_SERVER(126)    → { kind:"otaProgress", progress }  (payload.first())
 * 上記以外は { kind:"unknown", itemCode, body } を返す。
 *
 * @param {{itemCode:number, body:Buffer}} pub
 * @returns {object} 解析結果
 */
export function parseWM2Publish({ itemCode, body }: {
    itemCode: number;
    body: Buffer;
}): object;
/**
 * WM2 専用 GATT。SESAME ロック (protocol.js GATT, fd81 系) とは別サービス。
 * transport へ注入してこの UUID で discover/subscribe させる
 *   (例: createBleTransport({ ..., gatt: WM2_GATT }) のように差し替える / 配線は別フェーズ)。
 * 出典: CHWifiModule2Device.kt:534-536 — uuidService01 / writeChrac / receiveChr。
 */
export const WM2_GATT: Readonly<{
    SERVICE: "1b7e8251-2877-41c3-b46e-cf057c562524";
    WRITE_CHAR: "aca0ef7c-eeaa-48ad-9508-19a6cef6b356";
    NOTIFY_CHAR: "8ac32d3f-5cb9-4d44-bec2-ee689169f626";
}>;
/** WM2 アクションコード (src/itemcodes.js を唯一のソースとして参照)。 */
export const WM2_ACTION: Readonly<{
    CODE_NON: 0;
    REGISTER_WM2: 1;
    LOGIN_WM2: 2;
    UPDATE_WIFI_SSID: 3;
    UPDATE_WIFI_PASSWORD: 4;
    CONNECT_WIFI: 5;
    NETWORK_STATUS: 6;
    DELETE_SESAME: 7;
    ADD_SESAME: 8;
    INITIAL: 13;
    CCCD: 14;
    SESAME_KEYS: 16;
    RESET_WM2: 18;
    SCAN_WIFI_SSID: 19;
    OPEN_OTA_SERVER: 126;
    VERSION_TAG: 127;
}>;
export class WifiModule2 {
    /**
     * @param {{session?:import("./session.js").SesameBleSession, companyId?:string, deviceUUID?:string}} [opts]
     *   session: WM2 GATT で接続/ログイン済み (もしくは register 済み) の SesameBleSession。
     *   companyId: connectWifi で使う API_GATEWAY_CLIENT_ID (省略時は connectWifi 呼び出しで要指定)。
     *   deviceUUID: connectWifi の verification 末尾に使う WM2 の deviceUUID。
     */
    constructor({ session, companyId, deviceUUID }?: {
        session?: import("./session.js").SesameBleSession;
        companyId?: string;
        deviceUUID?: string;
    });
    _session: import("./session.js").SesameBleSession;
    _companyId: string | undefined;
    _deviceUUID: string | undefined;
    /** @type {Set<(parsed: ReturnType<typeof parseWM2Publish>) => void>} */
    _publishListeners: Set<(parsed: ReturnType<typeof parseWM2Publish>) => void>;
    /** @type {(() => void)|null} */
    _off: (() => void) | null;
    /**
     * WM2 publish (正規化済み {kind, ...}) を購読。戻り値 unsubscribe。
     * @param {(parsed: ReturnType<typeof parseWM2Publish>) => void} fn
     * @returns {() => void}
     */
    onPublish(fn: (parsed: ReturnType<typeof parseWM2Publish>) => void): () => void;
    /** 購読解除 (session の publish 中継を外す)。 */
    dispose(): void;
    /** 周辺 Wi-Fi SSID をスキャン。結果は onPublish の {kind:"scanWifiSSID"} で逐次届く。 */
    scanWifiSSID(): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * Wi-Fi SSID を設定。
     * @param {string} ssid
     */
    setWifiSSID(ssid: string): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * Wi-Fi パスワードを設定。
     * @param {string} password
     */
    setWifiPassword(password: string): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * 設定済み SSID/パスワードで Wi-Fi 接続を開始。
     * @param {{companyId?:string, deviceUUID?:string}} [args] 省略時はコンストラクタの値を使用。
     */
    connectWifi({ companyId, deviceUUID }?: {
        companyId?: string;
        deviceUUID?: string;
    }): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /** WM2 に現在の network 状態を要求 (状態は onPublish の {kind:"networkStatus"} で届く)。 */
    networkStatus(): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * 子 Sesame の鍵を WM2 に登録する。
     * @param {ChildSesameKey} sesameKey
     */
    insertSesames(sesameKey: ChildSesameKey): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * 子 Sesame の鍵を WM2 から削除する。
     * @param {string} sesameKeyTag
     */
    removeSesame(sesameKeyTag: string): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * WM2 を工場出荷状態へリセットする (CHWifiModule2Device.kt:437-448 reset() と 1:1)。
     *
     * SDK は RESET_WM2(18) を空ペイロードで送り、cmdResultCode==success のとき dropKey() を呼ぶ
     * (CHBaseDevice.kt:120-139)。dropKey はローカルの鍵レコードを削除し deviceStatus を NoBleSignal に
     * 落として disconnect、sesame2KeyData=null とする。
     *
     * この kit では「ローカル鍵レコード」は session が握る (WM2 ファサードは鍵 DB を持たない)。
     * よって dropKey 相当は **成功時に session.disconnect() してセッションを破棄する** こと
     * (_loggedIn=false・transport 切断・待機者解放 = 鍵を持ったセッションを使えなくする) で写像する。
     *
     * SDK の「unlogined なら BleInvalidAction で失敗」ガード (kt:439-441) は、session.request() が
     * 未ログイン時に notLoggedIn で reject する契約 (session.js:333) と等価なので、ここでは
     * 追加ガードを置かず request() の reject に委ねる (RESET_WM2 を送る前に弾かれる)。
     *
     * 注: 実機未検証 (RESET_WM2 の itemCode 値・空ペイロード・成功時 dropKey は SDK の静的読みに
     *   基づく忠実移植)。disconnect は SDK の dropKey が行う「鍵レコード削除」までは再現しない
     *   (この層は永続鍵 DB を持たないため)。鍵の破棄は呼び出し側で保存済み secretKey を破棄して行う。
     *
     * @param {{timeoutMs?:number}} [opts]
     * @returns {Promise<{resultCode:number, payload:Buffer}>} RESET_WM2 の応答 (成功時 resultCode=0)
     */
    reset(opts?: {
        timeoutMs?: number;
    }): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
}
/**
 * insertSesames: data = allKey (子 Sesame の鍵束)。CHWifiModule2Device.kt:380-401 を 1:1 移植。
 *
 *   noHashUUID = sesame2KeyData.deviceUUID.replace("-","")          (32hex)
 *   b64k       = base64(hexToBytes(noHashUUID)).replace("=","")     (16B → base64, パディング除去)
 *   ssmIRData  = b64k.toByteArray()                                  (UTF-8 = ASCII bytes)
 *   ssmPKData  = (sesame_5/5_pro/5_us/bike_2 のとき) 固定 64B 公開鍵
 *                それ以外は sesame2PublicKey.hexToBytes()            (64B)
 *   ssmSecKa   = secretKey.hexToBytes()                              (16B)
 *   ssmUUid    = deviceUUID.uppercase().toByteArray()                (ハイフン込み UUID 文字列の UTF-8)
 *   allKey     = ssmIRData ++ ssmPKData ++ ssmSecKa ++ ssmUUid
 *
 * 注: ssmIRData (base64 文字列の **ASCII bytes**) と ssmUUid (ハイフン付き大文字 UUID 文字列の
 *   ASCII bytes) は「バイト列化された文字列」であって生バイナリではない。SDK の挙動どおり文字列を
 *   そのまま UTF-8 で詰める。base64 パディング "=" は除去する (CHWifiModule2Device.kt:382)。
 *
 * 子 Sesame の鍵 (cloud の `sesame devices` 由来)。
 */
export type ChildSesameKey = {
    deviceUUID: string;
    secretKey: string | Buffer;
    sesame2PublicKey?: string | Buffer<ArrayBufferLike> | undefined;
    deviceModel?: string | undefined;
};
import { Buffer } from "node:buffer";
//# sourceMappingURL=wm2.d.ts.map