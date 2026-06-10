// WifiModule2 (WM2) を BLE デバイスとして扱うコア (OS 非依存・純 JS)。
//
// 移植元 (1:1):
//   _sesame_sdk_ref/sesame-sdk/.../ble/os3/CHWifiModule2Device.kt
//
// WM2 は SESAME 5 系ロックと **同じ SesameOS3 BLE スタック** (CCM 暗号セグメント・[item][data]
// 送信フレーム・[op][item][body] 受信フレーム・SegmentAssembler) の上で動く。違いは 2 点だけ:
//   (1) GATT サービス/特性 UUID が WM2 専用 (CHWifiModule2Device.kt:533-537 Wm2Chracs)。
//       fd81 系の SESAME ロックとは別サービスなので、transport 層で WM2 用 UUID を使う必要がある。
//   (2) cmdItCode が SesameItemCode ではなく **WM2ActionCode** (src/itemcodes.js:WM2_ACTION_CODES)。
//       数値空間が SesameItemCode と重複する (例 3=UPDATE_WIFI_SSID ≠ USER) ため別 enum で扱う。
//
// この層は protocol.js / session.js の純関数を再利用し、WM2 固有の「コマンド data 生成」と
// 「publish/応答 payload 解析」だけを担う (無線 I/O は transport の責務、暗号・分割は protocol.js)。
//
// 注: 鍵導出・nonce/カウンタ・login/register ハンドシェイクは SESAME ロックと完全に共通
// (CHWifiModule2Device は CHSesameOS3 を継承し、register=ECDH→ecdhSecretPre16、
//  login=CMAC(secretKey, token4) を基底からそのまま使う)。よって session.js (register/connect/
//  request) をそのまま利用でき、ここで再実装しない。本モジュールが足すのは WM2 固有の
//  action code を request() に乗せるための data builder と publish parser である。

import { Buffer } from "node:buffer";
import { t } from "../i18n.js";
import { WM2_ACTION_CODES } from "../itemcodes.js";

// ---------- GATT (CHWifiModule2Device.kt:533-537 Wm2Chracs) ----------

/**
 * WM2 専用 GATT。SESAME ロック (protocol.js GATT, fd81 系) とは別サービス。
 * transport へ注入してこの UUID で discover/subscribe させる
 *   (例: createBleTransport({ ..., gatt: WM2_GATT }) のように差し替える / 配線は別フェーズ)。
 * 出典: CHWifiModule2Device.kt:534-536 — uuidService01 / writeChrac / receiveChr。
 */
export const WM2_GATT = Object.freeze({
  SERVICE: "1b7e8251-2877-41c3-b46e-cf057c562524",   // uuidService01
  WRITE_CHAR: "aca0ef7c-eeaa-48ad-9508-19a6cef6b356", // writeChrac (app→device)
  NOTIFY_CHAR: "8ac32d3f-5cb9-4d44-bec2-ee689169f626", // receiveChr (device→app, notify)
});

/** WM2 アクションコード (src/itemcodes.js を唯一のソースとして参照)。 */
export const WM2_ACTION = WM2_ACTION_CODES;

// SESAME 5 系の固定公開鍵 (insertSesames で sesame_5/5_pro/5_us/bike_2 のとき差し替えるダミー PK)。
// CHWifiModule2Device.kt:391 のリテラルを 1:1 で移植 (推測なし)。
const SESAME5_FIXED_PUBKEY_HEX =
  "41B6D190EBBC1E9FA49E62710D80092784E998649FCA150419D2C70C6573BCA4666481EA47FDD755BB0761AB95EF95C9BD24016D54B14606EB5835541E45F27E";

// insertSesames で固定 PK に差し替える対象 model (CHWifiModule2Device.kt:385-389)。
const FIXED_PUBKEY_MODELS = new Set(["sesame_5", "sesame_5_pro", "sesame_5_us", "bike_2"]);

// 子鍵 push (SESAME_KEYS) / IoT shadow の 1 エントリ長 = 23B (CHWifiModule2Device.kt:94,471)。
const KEY_ENTRY_LEN = 23;

// エラーメッセージは共有 i18n カタログ (src/i18n/ble.js の ble.wm2*) を t() で参照する
// (結線フェーズで local const から昇格済み。既存 BLE 層とメッセージ体系を揃える)。

// ---------- 文字列正規化 helper ----------

/**
 * UTF-8 bytes へ (Kotlin String.toByteArray() 相当)。
 * @param {string} s
 * @returns {Buffer}
 */
function utf8(s) {
  return Buffer.from(String(s), "utf8");
}

/**
 * ハイフン除去 (大小は保持)。
 * @param {string} u
 * @returns {string}
 */
function stripDashes(u) {
  return String(u).replace(/-/g, "");
}

// ---------- コマンド data 生成 (request(actionCode, data) に乗せる) ----------
//
// いずれも CHWifiModule2Device.kt の sendCommand(SesameOS3Payload(actionCode, data)) の data に相当。
// SesameOS3Payload(cmdItCode, payload) は protocol.js:buildSendFrame(itemCode, data) と同型
// ([item] ++ data) なので、ここでは data 部だけを組み立てる (frame 化と CCM 暗号化は session.request)。

/** scanWifiSSID: data 無し (CHWifiModule2Device.kt:324 byteArrayOf())。結果は publish で届く。 */
export function scanWifiSSIDData() {
  return Buffer.alloc(0);
}

/**
 * setWifiSSID: data = SSID の UTF-8 bytes (CHWifiModule2Device.kt:337 ssid.toByteArray())。
 * @param {string} ssid
 * @returns {Buffer}
 */
export function setWifiSSIDData(ssid) {
  if (typeof ssid !== "string" || ssid.length === 0) throw new Error(t("ble.wm2SsidRequired"));
  return utf8(ssid);
}

/**
 * setWifiPassword: data = パスワードの UTF-8 bytes (CHWifiModule2Device.kt:351 password.toByteArray())。
 * @param {string} password
 * @returns {Buffer}
 */
export function setWifiPasswordData(password) {
  if (typeof password !== "string") throw new Error(t("ble.wm2PasswordString"));
  return utf8(password);
}

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
export function connectWifiData({ companyId, deviceUUID } = {}) {
  if (typeof companyId !== "string" || companyId.length === 0) throw new Error(t("ble.wm2CompanyIdRequired"));
  if (typeof deviceUUID !== "string" || deviceUUID.length === 0) throw new Error(t("ble.wm2DeviceUUIDRequired"));
  // CHWifiModule2Device.kt:359 replace(":","").replace("-","")
  const company = companyId.replace(/:/g, "").replace(/-/g, "");
  // CHWifiModule2Device.kt:361 deviceId.toString().uppercase().split('-').last()
  const tail = deviceUUID.toUpperCase().split("-").pop();
  const verification = `${company}:${tail}`;
  return utf8(verification);
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
export function insertSesamesData(sesameKey = {}) {
  const { deviceUUID, secretKey, sesame2PublicKey, deviceModel } = sesameKey;
  if (typeof deviceUUID !== "string" || deviceUUID.length === 0 || secretKey == null) {
    throw new Error(t("ble.wm2SesameKeyRequired"));
  }

  // noHashUUID(32hex) → 16B → base64 → パディング除去 → ASCII bytes (CHWifiModule2Device.kt:381-383)。
  const noHashUUID = stripDashes(deviceUUID);
  const b64k = Buffer.from(noHashUUID, "hex").toString("base64").replace(/=/g, "");
  const ssmIRData = Buffer.from(b64k, "utf8");

  // ssmPKData: 対象 model は固定 PK、それ以外は sesame2PublicKey (CHWifiModule2Device.kt:385-394)。
  let ssmPKData;
  if (deviceModel && FIXED_PUBKEY_MODELS.has(deviceModel)) {
    ssmPKData = Buffer.from(SESAME5_FIXED_PUBKEY_HEX, "hex");
  } else {
    if (sesame2PublicKey == null) throw new Error(t("ble.wm2SesameKeyRequired"));
    ssmPKData = Buffer.isBuffer(sesame2PublicKey)
      ? sesame2PublicKey
      : Buffer.from(String(sesame2PublicKey), "hex");
  }

  // ssmSecKa: secretKey の生バイト (CHWifiModule2Device.kt:399)。
  const ssmSecKa = Buffer.isBuffer(secretKey) ? secretKey : Buffer.from(String(secretKey), "hex");

  // ssmUUid: 大文字 UUID 文字列 (ハイフン込み) の ASCII bytes (CHWifiModule2Device.kt:400)。
  const ssmUUid = Buffer.from(deviceUUID.toUpperCase(), "utf8");

  return Buffer.concat([ssmIRData, ssmPKData, ssmSecKa, ssmUUid]);
}

/**
 * removeSesame: data = sesameKeyTag を大文字化した UTF-8 bytes (CHWifiModule2Device.kt:415)。
 * @param {string} sesameKeyTag 削除対象の鍵タグ。
 * @returns {Buffer}
 */
export function removeSesameData(sesameKeyTag) {
  if (typeof sesameKeyTag !== "string" || sesameKeyTag.length === 0) throw new Error(t("ble.wm2SesameKeyTagRequired"));
  return utf8(sesameKeyTag.toUpperCase());
}

/** networkStatus 取得コマンドの data (無し)。状態は publish (NETWORK_STATUS) で届く。 */
export function networkStatusData() {
  return Buffer.alloc(0);
}

// ---------- publish payload 解析 (onGattWM2Publish, CHWifiModule2Device.kt:461-529) ----------

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
export function parseScanWifiSSID(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  // payload[0]=下位, payload[1]=上位 の little-endian signed short (DataExtention.kt:99-102)。
  const rssi = buf.length >= 2 ? buf.readInt16LE(0) : 0;
  const ssid = buf.length > 2 ? buf.subarray(2).toString("utf8") : "";
  return { rssi, ssid };
}

/**
 * UPDATE_WIFI_SSID publish = 現在の SSID 文字列 (CHWifiModule2Device.kt:491-495)。
 * @param {Buffer} payload
 * @returns {string}
 */
export function parseWifiSSIDPublish(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return buf.toString("utf8");
}

/**
 * UPDATE_WIFI_PASSWORD publish = 現在のパスワード文字列 (CHWifiModule2Device.kt:496-500)。
 * @param {Buffer} payload
 * @returns {string}
 */
export function parseWifiPasswordPublish(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return buf.toString("utf8");
}

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
export function parseNetworkStatus(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (buf.length < 1) throw new Error(t("ble.wm2NetworkStatusEmpty"));
  const b = buf[0];
  return {
    isAp: (b & 2) > 0,             // bit1
    isNet: (b & 4) > 0,            // bit2
    isIot: (b & 8) > 0,            // bit3
    isAPCheck: (b & 16) > 0,       // bit4
    isAPConnecting: (b & 32) > 0,  // bit5
    isNETConnecting: (b & 64) > 0, // bit6
    isIOTConnecting: (b & 0x80) > 0, // bit7 (Kotlin signed byte < 0 と等価)
    raw: b,
  };
}

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
export function parseSesameKeys(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const out = [];
  for (let off = 0; off + KEY_ENTRY_LEN <= buf.length; off += KEY_ENTRY_LEN) {
    const chunk = buf.subarray(off, off + KEY_ENTRY_LEN);
    const ss2ir22 = chunk.subarray(0, 22);
    const status = chunk[22];
    try {
      // String(ss2_ir_22) + "==" を base64 デコード → 16B (CHWifiModule2Device.kt:476)。
      const b64 = ss2ir22.toString("ascii") + "==";
      const raw = Buffer.from(b64, "base64");
      if (raw.length !== 16) continue; // noHashtoUUID は 16B を要求 (不正はスキップ)
      const deviceUUID = noHashToUUID(raw);
      out.push({ deviceUUID, status });
    } catch {
      // SDK の catch (e) 相当: 壊れたエントリは無視して継続。
    }
  }
  return out;
}

/**
 * 16B → ハイフン付き UUID 文字列 (SDK の noHashtoUUID 相当)。
 * @param {Buffer} raw 16B
 * @returns {string} "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" (小文字)
 */
function noHashToUUID(raw) {
  const hex = raw.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

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
export function parseWM2Publish({ itemCode, body }) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body || []);
  switch (itemCode) {
    case WM2_ACTION.SCAN_WIFI_SSID:
      return { kind: "scanWifiSSID", ...parseScanWifiSSID(buf) };
    case WM2_ACTION.UPDATE_WIFI_SSID:
      return { kind: "wifiSSID", ssid: parseWifiSSIDPublish(buf) };
    case WM2_ACTION.UPDATE_WIFI_PASSWORD:
      return { kind: "wifiPassword", password: parseWifiPasswordPublish(buf) };
    case WM2_ACTION.NETWORK_STATUS:
      return { kind: "networkStatus", ...parseNetworkStatus(buf) };
    case WM2_ACTION.SESAME_KEYS:
      return { kind: "sesameKeys", keys: parseSesameKeys(buf) };
    case WM2_ACTION.OPEN_OTA_SERVER:
      // onOTAProgress(this, payload.first()) — 進捗 1B (CHWifiModule2Device.kt:465-467)。
      return { kind: "otaProgress", progress: buf.length > 0 ? buf[0] : 0 };
    default:
      return { kind: "unknown", itemCode, body: buf };
  }
}

// ---------- 高レベル: WM2 制御ファサード ----------
//
// SesameBleSession (session.js) を WM2 GATT で構築済みであることが前提 (transport に WM2_GATT を
// 注入する配線は別フェーズ)。本クラスは session.request(actionCode, data) に WM2 の action code と
// 上記 data builder を結線し、publish を parseWM2Publish で正規化して購読者へ配るだけの薄い層。

export class WifiModule2 {
  /**
   * @param {{session?:import("./session.js").SesameBleSession, companyId?:string, deviceUUID?:string}} [opts]
   *   session: WM2 GATT で接続/ログイン済み (もしくは register 済み) の SesameBleSession。
   *   companyId: connectWifi で使う API_GATEWAY_CLIENT_ID (省略時は connectWifi 呼び出しで要指定)。
   *   deviceUUID: connectWifi の verification 末尾に使う WM2 の deviceUUID。
   */
  constructor({ session, companyId, deviceUUID } = {}) {
    if (!session) throw new Error(t("ble.wm2SessionRequired"));
    this._session = session;
    this._companyId = companyId;
    this._deviceUUID = deviceUUID;
    /** @type {Set<(parsed: ReturnType<typeof parseWM2Publish>) => void>} */
    this._publishListeners = new Set();
    /** @type {(() => void)|null} */
    this._off = null;
    // session の生 publish を WM2 用に正規化して中継する。
    this._off = session.onPublish((/** @type {{itemCode:number, body:Buffer}} */ pub) => {
      let parsed;
      try { parsed = parseWM2Publish(pub); } catch { return; }
      for (const fn of [...this._publishListeners]) { try { fn(parsed); } catch { /* ignore */ } }
    });
  }

  /**
   * WM2 publish (正規化済み {kind, ...}) を購読。戻り値 unsubscribe。
   * @param {(parsed: ReturnType<typeof parseWM2Publish>) => void} fn
   * @returns {() => void}
   */
  onPublish(fn) { this._publishListeners.add(fn); return () => this._publishListeners.delete(fn); }

  /** 購読解除 (session の publish 中継を外す)。 */
  dispose() { if (this._off) { this._off(); this._off = null; } this._publishListeners.clear(); }

  /** 周辺 Wi-Fi SSID をスキャン。結果は onPublish の {kind:"scanWifiSSID"} で逐次届く。 */
  scanWifiSSID() {
    return this._session.request(WM2_ACTION.SCAN_WIFI_SSID, scanWifiSSIDData());
  }

  /**
   * Wi-Fi SSID を設定。
   * @param {string} ssid
   */
  setWifiSSID(ssid) {
    return this._session.request(WM2_ACTION.UPDATE_WIFI_SSID, setWifiSSIDData(ssid));
  }

  /**
   * Wi-Fi パスワードを設定。
   * @param {string} password
   */
  setWifiPassword(password) {
    return this._session.request(WM2_ACTION.UPDATE_WIFI_PASSWORD, setWifiPasswordData(password));
  }

  /**
   * 設定済み SSID/パスワードで Wi-Fi 接続を開始。
   * @param {{companyId?:string, deviceUUID?:string}} [args] 省略時はコンストラクタの値を使用。
   */
  connectWifi({ companyId, deviceUUID } = {}) {
    return this._session.request(
      WM2_ACTION.CONNECT_WIFI,
      connectWifiData({ companyId: companyId ?? this._companyId, deviceUUID: deviceUUID ?? this._deviceUUID }),
    );
  }

  /** WM2 に現在の network 状態を要求 (状態は onPublish の {kind:"networkStatus"} で届く)。 */
  networkStatus() {
    return this._session.request(WM2_ACTION.NETWORK_STATUS, networkStatusData());
  }

  /**
   * 子 Sesame の鍵を WM2 に登録する。
   * @param {ChildSesameKey} sesameKey
   */
  insertSesames(sesameKey) {
    return this._session.request(WM2_ACTION.ADD_SESAME, insertSesamesData(sesameKey));
  }

  /**
   * 子 Sesame の鍵を WM2 から削除する。
   * @param {string} sesameKeyTag
   */
  removeSesame(sesameKeyTag) {
    return this._session.request(WM2_ACTION.DELETE_SESAME, removeSesameData(sesameKeyTag));
  }

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
  async reset(opts = {}) {
    // RESET_WM2 を空ペイロードで送出 (kt:443 byteArrayOf())。
    const res = await this._session.request(WM2_ACTION.RESET_WM2, Buffer.alloc(0), opts);
    // cmdResultCode==success のときだけ dropKey 相当 (= session 破棄) を行う (kt:444-446)。
    if (res.resultCode === 0) {
      await this._session.disconnect();
    }
    return res;
  }
}
