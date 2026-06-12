// SESAME BLE 経由ファームウェア更新 (DFU / OTA) — OS 非依存の純ロジック層。
//
// 移植元 (1:1):
//   - co/candyhouse/sesame/ble/os3/base/CHSesameOS3.kt:441-449  updateFirmware()
//   - co/candyhouse/sesame/ble/os3/CHHub3Device.kt:217-230       updateFirmwareBleOnly()
//                                          :320-322              MOVE_TO publish = onOTAProgress
//   - co/candyhouse/sesame/ble/os3/CHWifiModule2Device.kt:450-458 updateFirmware() = OPEN_OTA_SERVER(126)
//                                          :465-467              OPEN_OTA_SERVER publish = onOTAProgress
//
// 対象は SesameOS3 系 (SESAME 5 lock / Hub3 / WifiModule2)。OS2 (SESAME 3/4) は別経路で対象外。
//
// SDK の OTA は 3 つの異なるフローを持つ。バイト列・命令・分岐をそのまま移植する:
//
//   (A) OS3 lock / Hub3 の updateFirmware (CHSesameOS3.kt:441-449)
//       → **命令を一切送らず**、接続済み BluetoothDevice ハンドルをそのまま呼び出し側へ返すだけ。
//         実際の DFU バイナリ転送は外部 DFU ライブラリ (Nordic DFU 等) が別 GATT サービスで行う。
//         JS 版ではトランスポート (= 接続中のデバイスハンドル) を返す。命令送信もカウンタ消費も無い。
//
//   (B) Hub3 の updateFirmwareBleOnly (CHHub3Device.kt:217-230)
//       → MOVE_TO(84) を **暗号化セッションで** 送り、resultCode==success ならデバイスを返す。
//         進捗は MOVE_TO(84) の publish で届き、payload の **先頭 1 バイト** が進捗値
//         (CHHub3Device.kt:320-322 onOTAProgress(payload.first()))。
//
//   (C) WifiModule2 の updateFirmware (CHWifiModule2Device.kt:450-458)
//       → OPEN_OTA_SERVER(126) を送り、resultCode==success ならデバイスを返す。
//         進捗は OPEN_OTA_SERVER(126) の publish で届き、payload の **先頭 1 バイト** が進捗値
//         (CHWifiModule2Device.kt:465-467 onOTAProgress(payload.first()))。
//
// この層は接続後のバイト列のやり取りだけを扱い、無線 I/O は session に注入された transport に委譲する
// (= mock transport でハードウェア無しにテスト可能)。

import { Buffer } from "node:buffer";
import { t } from "../i18n.js";
import { ITEM } from "./protocol.js";
import { WM2_ACTION_CODES } from "../itemcodes.js";

// WM2 の OTA 開始アクションコード。SesameItemCode とは別 enum (CHWifiModule2Device.kt:540 WM2ActionCode)
// で数値空間が重複するため、src/itemcodes.js では WM2_ACTION_CODES に隔離されている。
// 結線フェーズで local const から正準ソース (WM2_ACTION_CODES.OPEN_OTA_SERVER) 参照へ昇格済み。
const WM2_OPEN_OTA_SERVER = WM2_ACTION_CODES.OPEN_OTA_SERVER;

/**
 * 進捗 payload の先頭 1 バイトが進捗値 (onOTAProgress(payload.first()))。
 * 原典は単なる UByte 1 つ (CHHub3Device.kt:321 / CHWifiModule2Device.kt:466)。
 * @param {unknown} body
 * @returns {number|null}
 */
function firstByteProgress(body) {
  return Buffer.isBuffer(body) && body.length > 0 ? body[0] : null;
}

/**
 * OTA 進捗コールバック。
 * @typedef {(progress: number|null, body: Buffer) => void} OtaProgressCallback
 */

/**
 * (B/C) 進捗 publish を購読する低レベルヘルパ。指定 itemCode の publish が来るたびに
 * onProgress(progress, body) を呼ぶ。戻り値は unsubscribe 関数。
 *
 * SDK の onGattSesamePublish / onGattWM2Publish が itemCode で分岐して
 * onOTAProgress(payload.first()) を delegate に投げるのと同じ (CHHub3Device.kt:320-322 /
 * CHWifiModule2Device.kt:465-467)。session.onPublish は {opCode,itemCode,body} を渡す。
 *
 * @param {import("./session.js").SesameBleSession} session 接続済みセッション
 * @param {number} itemCode 進捗を載せる publish の itemCode (MOVE_TO or OPEN_OTA_SERVER)
 * @param {OtaProgressCallback} [onProgress] 進捗コールバック (0..100 想定の生バイト)
 * @returns {() => void} unsubscribe
 */
function subscribeProgress(session, itemCode, onProgress) {
  if (typeof onProgress !== "function") return () => {};
  return session.onPublish((/** @type {{itemCode:number, body:Buffer}} */ { itemCode: it, body }) => {
    if (it !== itemCode) return;
    try { onProgress(firstByteProgress(body), body); } catch { /* ignore listener throw */ }
  });
}

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
export function updateFirmware(session) {
  if (!session || !session.isLoggedIn) {
    throw new Error(t("ble.dfuDeviceNotAvailable")); // CHSesameOS3.kt:447 と同一メッセージ
  }
  return { session };
}

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
export async function updateFirmwareBleOnly(session, { onProgress, timeoutMs } = {}) {
  // MOVE_TO の data は byteArrayOf() = 空 (CHHub3Device.kt:222)。
  const unsubscribe = subscribeProgress(session, ITEM.MOVE_TO, onProgress);
  try {
    const res = await session.request(ITEM.MOVE_TO, Buffer.alloc(0), { timeoutMs });
    // request() は resultCode!=0 を BleResultError で reject 済み (CHHub3Device.kt:225-226 の
    // failure(NSError(resultCode)) に対応)。ここに来るのは success のみ。
    return { resultCode: res.resultCode, payload: res.payload, session };
  } finally {
    // 簡便 API として購読の後始末は内部で行う (応答が来た = OTA サーバ起動完了の時点で停止)。
    // 継続的な進捗購読が必要なら onWM2OtaProgress / subscribeOtaProgress を直接使う。
    unsubscribe();
  }
}

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
export async function updateFirmwareWM2(session, { onProgress, timeoutMs } = {}) {
  const unsubscribe = subscribeProgress(session, WM2_OPEN_OTA_SERVER, onProgress);
  try {
    // OPEN_OTA_SERVER の data は byteArrayOf() = 空 (CHWifiModule2Device.kt:451)。
    const res = await session.request(WM2_OPEN_OTA_SERVER, Buffer.alloc(0), { timeoutMs });
    return { resultCode: res.resultCode, payload: res.payload, session };
  } finally {
    unsubscribe();
  }
}

/**
 * Hub3 / OS3 lock の MOVE_TO(84) 進捗 publish を購読する (CHHub3Device.kt:320-322)。
 * updateFirmwareBleOnly が応答後に内部で unsubscribe するのに対し、こちらは購読の所有権を
 * 呼び出し側へ渡す版 (OTA 完了 100% まで進捗を取り続けたいとき)。
 *
 * @param {import("./session.js").SesameBleSession} session
 * @param {(progress:number|null, body:Buffer)=>void} onProgress
 * @returns {() => void} unsubscribe
 */
export function onMoveToOtaProgress(session, onProgress) {
  return subscribeProgress(session, ITEM.MOVE_TO, onProgress);
}

/**
 * WM2 の OPEN_OTA_SERVER(126) 進捗 publish を購読する (CHWifiModule2Device.kt:465-467)。
 * 購読の所有権を呼び出し側へ渡す版 (updateFirmwareWM2 の内部購読とは独立)。
 *
 * @param {import("./session.js").SesameBleSession} session
 * @param {(progress:number|null, body:Buffer)=>void} onProgress
 * @returns {() => void} unsubscribe
 */
export function onWM2OtaProgress(session, onProgress) {
  return subscribeProgress(session, WM2_OPEN_OTA_SERVER, onProgress);
}
