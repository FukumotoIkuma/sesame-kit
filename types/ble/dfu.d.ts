/**
 * (A) OS3 lock / Hub3 の updateFirmware (CHSesameOS3.kt:441-449)。
 *
 * SDK は接続済み BluetoothDevice をそのまま呼び出し側へ返すだけで、**BLE コマンドは送らない**
 * (実際の DFU バイナリ転送は外部 DFU ライブラリが別 GATT サービスで行う前提)。よって JS 版でも
 * 命令送信・カウンタ消費は一切行わず、接続中のデバイスハンドル (= session) をそのまま返す。
 *
 * 原典 Kotlin:
 *   val device = (this as CHDeviceUtil).advertisement?.device
 *   if (device != null) onResponse.invoke(Result.success(device))
 *   else onResponse.invoke(Result.failure(RuntimeException("Bluetooth device is not available.")))
 *
 * JS では advertisement.device に相当する公開ハンドルが無いため、login 済みであることを唯一の
 * 「device available」条件とし (CHSesameOS3.kt の device!=null 相当)、未接続なら原典同様に reject する。
 *
 * @param {import("./session.js").SesameBleSession} session 接続済みセッション
 * @returns {{session: import("./session.js").SesameBleSession}} 外部 DFU ライブラリへ渡すデバイスハンドル
 */
export function updateFirmware(session: import("./session.js").SesameBleSession): {
    session: import("./session.js").SesameBleSession;
};
/**
 * (B) Hub3 の updateFirmwareBleOnly (CHHub3Device.kt:217-230)。
 *
 * MOVE_TO(84) を暗号化セッションで送り、resultCode==success ならデバイスを返す。進捗は
 * MOVE_TO(84) の publish で届く (CHHub3Device.kt:320-322)。onProgress を渡すと自動で購読し、
 * 解決時に unsubscribe する (購読の所有権は呼び出し側に渡さない簡便 API)。
 *
 * 原典 Kotlin:
 *   sendCommand(SesameOS3Payload(SesameItemCode.moveTo.value, byteArrayOf())) { res ->
 *     if (res.cmdResultCode == success) onResponse(advertisement!!.device!!)
 *     else onResponse(failure(NSError(...)))
 *   }
 * (BLE 不可なら "BLE unavailable" で即 failure。JS では request() が notLoggedIn を弾く。)
 *
 * @param {import("./session.js").SesameBleSession} session 接続済みセッション
 * @param {{onProgress?:OtaProgressCallback, timeoutMs?:number}} [opts]
 *   onProgress: MOVE_TO publish の進捗 (payload 先頭バイト)。
 * @returns {Promise<{resultCode:number, payload:Buffer, session:object}>}
 *   MOVE_TO 応答 (resultCode==0) ＋デバイスハンドル (session)。
 */
export function updateFirmwareBleOnly(session: import("./session.js").SesameBleSession, { onProgress, timeoutMs }?: {
    onProgress?: OtaProgressCallback;
    timeoutMs?: number;
}): Promise<{
    resultCode: number;
    payload: Buffer;
    session: object;
}>;
/**
 * (C) WifiModule2 の updateFirmware (CHWifiModule2Device.kt:450-458)。
 *
 * OPEN_OTA_SERVER(126) を暗号化セッションで送り、resultCode==success ならデバイスを返す。進捗は
 * OPEN_OTA_SERVER(126) の publish で届く (CHWifiModule2Device.kt:465-467)。
 *
 * 原典 Kotlin:
 *   sendCommand(SesameOS3Payload(WM2ActionCode.OPEN_OTA_SERVER.value, byteArrayOf())) { res ->
 *     if (res.cmdResultCode == success) onResponse(advertisement!!.device!!)
 *     else onResponse(failure(NSError(...)))
 *   }
 *
 * 注: WM2 の OPEN_OTA_SERVER(126) は WM2ActionCode enum 由来で、SesameItemCode (ITEM) とは別空間。
 *   request() は cmdItCode をそのまま送るため、ここでは WM2_OPEN_OTA_SERVER(=126) を直接渡す
 *   (CHWifiModule2Device.kt:451 と 1:1)。
 *
 * @param {import("./session.js").SesameBleSession} session 接続済みセッション (WM2)
 * @param {{onProgress?:OtaProgressCallback, timeoutMs?:number}} [opts]
 * @returns {Promise<{resultCode:number, payload:Buffer, session:object}>}
 */
export function updateFirmwareWM2(session: import("./session.js").SesameBleSession, { onProgress, timeoutMs }?: {
    onProgress?: OtaProgressCallback;
    timeoutMs?: number;
}): Promise<{
    resultCode: number;
    payload: Buffer;
    session: object;
}>;
/**
 * Hub3 / OS3 lock の MOVE_TO(84) 進捗 publish を購読する (CHHub3Device.kt:320-322)。
 * updateFirmwareBleOnly が応答後に内部で unsubscribe するのに対し、こちらは購読の所有権を
 * 呼び出し側へ渡す版 (OTA 完了 100% まで進捗を取り続けたいとき)。
 *
 * @param {import("./session.js").SesameBleSession} session
 * @param {(progress:number|null, body:Buffer)=>void} onProgress
 * @returns {() => void} unsubscribe
 */
export function onMoveToOtaProgress(session: import("./session.js").SesameBleSession, onProgress: (progress: number | null, body: Buffer) => void): () => void;
/**
 * WM2 の OPEN_OTA_SERVER(126) 進捗 publish を購読する (CHWifiModule2Device.kt:465-467)。
 * 購読の所有権を呼び出し側へ渡す版 (updateFirmwareWM2 の内部購読とは独立)。
 *
 * @param {import("./session.js").SesameBleSession} session
 * @param {(progress:number|null, body:Buffer)=>void} onProgress
 * @returns {() => void} unsubscribe
 */
export function onWM2OtaProgress(session: import("./session.js").SesameBleSession, onProgress: (progress: number | null, body: Buffer) => void): () => void;
/**
 * OTA 進捗コールバック。
 */
export type OtaProgressCallback = (progress: number | null, body: Buffer) => void;
import { Buffer } from "node:buffer";
//# sourceMappingURL=dfu.d.ts.map