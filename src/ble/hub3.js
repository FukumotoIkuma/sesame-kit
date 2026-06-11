// SESAME Hub3 / Hub3 LTE を BLE デバイスとして扱うコア (OS 非依存・純 JS)。
//
// 移植元 (1:1):
//   _sesame_sdk_ref/sesame-sdk/.../ble/os3/CHHub3Device.kt
//
// Hub3 は SESAME 5 系ロック・WM2 と **同じ SesameOS3 BLE スタック** (CCM 暗号セグメント・
// [item][data] 送信フレーム・[op][item][body] 受信フレーム・SegmentAssembler) の上で動く。
// register=ECDH→ecdhSecretPre16 / login=CMAC(secretKey, token4) はすべて基底 (CHSesameOS3) を
// そのまま継承しており、kit でも session.js (register/connect/request) をそのまま使える。
// したがって本モジュールは Hub3 固有の「コマンド data 生成」と「publish/応答 payload 解析」
// だけを担う (鍵導出・login・register は session.js が持つ)。
//
// WM2 との違いは 2 点だけ:
//   (1) GATT は SESAME ロックと **同じ** (fd81 系)。WM2 のような専用 GATT は無いので transport の
//       既定 GATT で discover/subscribe する (CHHub3Device は CHSesameOS3 を継承するだけ)。
//   (2) cmdItCode は **SesameItemCode** に直接乗る (WM2 のような別 enum ではない)。Wi-Fi 設定は
//       HUB3_ITEM_CODE_WIFI_SSID(131)/WIFI_PASSWORD(135)/UPDATE_WIFI_SSID(136)、SSID スキャン結果は
//       SSID_NOTIFY(133)。値は src/itemcodes.js (ITEM_CODES) を唯一のソースとして参照する。
//
// ★ NETWORK_TYPE(209) について (P3-14): 209 は SesameItemCode に存在しない (SesameProtocols.kt:32-53
//   は 208 で終端) し、CHHub3Device.kt にも対応ハンドラは無い。biz3 web の native ブリッジ挙動
//   (references_web/src/components/MobileWifiModule.js:219-235) からの推定であり、本モジュールの
//   networkType 系 (parseNetworkType / networkTypeData / Hub3Commands.networkType) だけは
//   UNVERIFIED_ITEM_CODES を参照する @experimental 経路 (実機未検証、§9 V6)。
//
// ★ 実機未検証: バイト列・itemCode・publish 構造は CHHub3Device.kt と 1:1 で移植したが、Hub3 実機での
//   往復確認は行っていない (README の Known limitations と整合)。

import { Buffer } from "node:buffer";
import { t } from "../i18n.js";
import { ITEM_CODES, UNVERIFIED_ITEM_CODES } from "../itemcodes.js";
import { parseNetworkStatus } from "./protocol.js";

const ITEM = ITEM_CODES;
// 209 (networkType) は SDK 由来でないため隔離された UNVERIFIED_ITEM_CODES から引く (P3-14)。
const UNVERIFIED = UNVERIFIED_ITEM_CODES;

/** UTF-8 bytes へ (Kotlin String.toByteArray() 相当)。 @param {unknown} s @returns {Buffer} */
function utf8(s) {
  return Buffer.from(String(s), "utf8");
}

/** ハイフン除去 (大小は保持)。 @param {unknown} u @returns {string} */
function stripDashes(u) {
  return String(u).replace(/-/g, "");
}

// ---------- コマンド data 生成 (request(itemCode, data) に乗せる) ----------
//
// いずれも CHHub3Device.kt の sendCommand(SesameOS3Payload(itemCode, data)) の data に相当。
// SesameOS3Payload(cmdItCode, payload) は protocol.js:buildSendFrame(itemCode, data) と同型
// ([item] ++ data) なので、ここでは data 部だけを組み立てる (frame 化と CCM 暗号化は session.request)。

/** scanWifiSSID: data 無し (CHHub3Device.kt:241 byteArrayOf())。結果は SSID_NOTIFY publish で届く。 */
export function scanWifiSSIDData() {
  return Buffer.alloc(0);
}

/**
 * setWifiSSID: data = SSID の UTF-8 bytes (CHHub3Device.kt:256 ssid.toByteArray())。
 * @param {string} ssid
 * @returns {Buffer}
 */
export function setWifiSSIDData(ssid) {
  if (typeof ssid !== "string" || ssid.length === 0) throw new Error(t("ble.wm2SsidRequired"));
  return utf8(ssid);
}

/**
 * setWifiPassword: data = パスワードの UTF-8 bytes (CHHub3Device.kt:247 password.toByteArray())。
 * @param {string} password
 * @returns {Buffer}
 */
export function setWifiPasswordData(password) {
  if (typeof password !== "string") throw new Error(t("ble.wm2PasswordString"));
  return utf8(password);
}

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
export function removeSesameData(tag) {
  if (typeof tag !== "string" || tag.length === 0) throw new Error(t("ble.wm2SesameKeyTagRequired"));
  return Buffer.from(stripDashes(tag), "hex");
}

/**
 * networkType 取得コマンドの data (無し)。
 * @experimental 実機未検証 (§9 V6)。itemCode 209 は Android SDK に存在せず、biz3 web の native
 *   ブリッジ挙動 (references_web/src/components/MobileWifiModule.js:219-235) からの推定 (P3-14)。
 */
export function networkTypeData() {
  return Buffer.alloc(0);
}

// ---------- publish payload 解析 (onGattSesamePublish, CHHub3Device.kt:268-340) ----------

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
export function parseScanWifiSSID(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  // payload[0]=下位, payload[1]=上位 の little-endian signed short (DataExtention.kt:99-102)。
  const rssi = buf.length >= 2 ? buf.readInt16LE(0) : 0;
  const ssid = buf.length > 2 ? buf.subarray(2).toString("utf8") : "";
  return { rssi, ssid };
}

/**
 * NETWORK_TYPE(209) publish payload を解析する — と推定。
 *   isWifiConnected = payload[0] == 1
 *   isLTEConnected  = payload[1] == 1
 *
 * 出典 (P3-14): **Android SDK に存在しない**。SesameItemCode は 208 で終端し
 *   (SesameProtocols.kt:32-53)、CHHub3Device.kt の onGattSesamePublish (kt:272-338) にも 209 の
 *   ハンドラは無い。biz3 web の native ブリッジが requestNetworkType に対し
 *   {isWifiConnected, isLTEConnected} の 2 boolean を返す挙動
 *   (references_web/src/components/MobileWifiModule.js:219-235) からの **推定** で、payload の
 *   バイト配置 ([wifi 1B][lte 1B]) を裏付ける一次ソースは無い。
 * @experimental 実機未検証 (§9 V6)。確証が得られない場合は機能ごと削除を検討する。
 *
 * @param {Buffer} payload (>=2B)
 * @returns {{isWifiConnected:boolean, isLTEConnected:boolean}}
 */
export function parseNetworkType(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (buf.length < 2) throw new Error(t("ble.hub3NetworkTypeShort"));
  return {
    isWifiConnected: buf[0] === 1,
    isLTEConnected: buf[1] === 1,
  };
}

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
export function parseMechSetting(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let ssidRange;
  let pwdRange;
  if (buf.length < 96) {
    // 旧 Hub3 ファーム (60B): SSID=[0..29] (30B), パスワード=[30..59] (30B)。
    ssidRange = [0, 30];
    pwdRange = [30, 60];
  } else {
    // 新 Hub3 ファーム (96B): SSID=[0..31] (32B), パスワード=[32..95] (64B)。
    ssidRange = [0, 32];
    pwdRange = [32, 96];
  }
  return {
    wifiSSID: trimNullAndQuestion(buf.subarray(ssidRange[0], ssidRange[1])),
    wifiPassWord: trimNullAndQuestion(buf.subarray(pwdRange[0], pwdRange[1])),
  };
}

/**
 * Buffer を UTF-8 文字列にし、末尾の 0x00 と '?' (0x3f) を除去する
 * (Kotlin String(...).trimEnd(0.toChar(), '?'.toChar()) と 1:1)。
 * @param {Buffer} buf
 * @returns {string}
 */
function trimNullAndQuestion(buf) {
  // 線形時間で末尾の 0x00 / '?' を除去する (正規表現 `/[\x00?]+$/` は crafted 入力で
  // ポリノミアル backtracking = ReDoS のため使わない)。
  const s = buf.toString("utf8");
  let end = s.length;
  while (end > 0) {
    const c = s.charCodeAt(end - 1);
    if (c !== 0x00 && c !== 0x3f /* "?" */) break;
    end--;
  }
  return s.slice(0, end);
}

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
export function parseSesameKeys(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const out = [];
  let index = -1;
  for (let off = 0; off + KEY_ENTRY_LEN <= buf.length; off += KEY_ENTRY_LEN) {
    index += 1; // SDK は divideArray 後の forEachIndexed の index (全エントリで採番)。
    const chunk = buf.subarray(off, off + KEY_ENTRY_LEN);
    const lockStatus = chunk[22];
    if (lockStatus === 0) continue; // lock_status != 0 のみ (CHHub3Device.kt:305)。
    const ss5id = chunk.subarray(0, 16);
    out.push({ deviceUUID: noHashToUUID(ss5id), index });
  }
  return out;
}

// 子鍵 push (PUB_KEY_SESAME) の 1 エントリ長 = 23B (CHHub3Device.kt:302 divideArray(23))。
const KEY_ENTRY_LEN = 23;

/**
 * 16B → ハイフン付き UUID 文字列 (SDK の toHexString().noHashtoUUID() 相当)。
 * @param {Buffer} raw 16B
 * @returns {string} "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" (小文字)
 */
function noHashToUUID(raw) {
  const hex = raw.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Hub3 の publish ({itemCode, body}) を itemCode ごとに解析して `{ kind, ... }` の正規化
 * オブジェクトに変換する (session.onPublish のディスパッチ補助)。
 *
 * 対応 (CHHub3Device.kt:272-338 onGattSesamePublish):
 *   MECH_SETTING(80)         → { kind:"mechSetting", wifiSSID, wifiPassWord }
 *   MECH_STATUS(81)          → { kind:"networkStatus", isAp, isNet, isIot, ... }
 *                              (Hub3 では 81 がロック機構状態ではなく **ネットワーク状態 bit ベクタ**。
 *                               CHHub3Device.kt:291-301 → CHWifiModule2NetWorkStatus。WM2 の
 *                               NETWORK_STATUS(6) と同一 bit layout なので protocol.js の
 *                               parseNetworkStatus を共有する。P3-16)
 *   PUB_KEY_SESAME(102)      → { kind:"sesameKeys", keys:[{deviceUUID,index}] }
 *   MOVE_TO(84)              → { kind:"otaProgress", progress }  (payload.first(), OTA 進捗)
 *   HUB3_ITEM_CODE_SSID_NOTIFY(133)  → { kind:"scanWifiSSID", rssi, ssid }
 *   HUB3_ITEM_CODE_SSID_FIRST(132) / SSID_LAST(134) → { kind:"ssidMarker", itemCode }  (SDK は no-op)
 *   NETWORK_TYPE(209)        → { kind:"networkType", isWifiConnected, isLTEConnected }
 *                              (@experimental — SDK 非由来の推定 itemCode。parseNetworkType 参照)
 * 上記以外は { kind:"unknown", itemCode, body } を返す。
 *
 * @param {{itemCode:number, body:Buffer}} pub
 * @returns {object} 解析結果
 */
export function parseHub3Publish({ itemCode, body }) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body || []);
  switch (itemCode) {
    case ITEM.MECH_SETTING:
      return { kind: "mechSetting", ...parseMechSetting(buf) };
    case ITEM.MECH_STATUS:
      // Hub3 の mechStatus(81) は payload[0] のネットワーク状態 bit フラグ
      // (CHHub3Device.kt:291-301)。WM2 と同一 layout の共有 parser で解析する (P3-16)。
      return { kind: "networkStatus", ...parseNetworkStatus(buf) };
    case ITEM.PUB_KEY_SESAME:
      return { kind: "sesameKeys", keys: parseSesameKeys(buf) };
    case ITEM.MOVE_TO:
      // onOTAProgress(this, payload.first()) — OTA 進捗 1B (CHHub3Device.kt:320-322)。
      return { kind: "otaProgress", progress: buf.length > 0 ? buf[0] : 0 };
    case ITEM.HUB3_ITEM_CODE_SSID_NOTIFY:
      return { kind: "scanWifiSSID", ...parseScanWifiSSID(buf) };
    case UNVERIFIED.HUB3_ITEM_CODE_NETWORK_TYPE:
      // @experimental SDK 非由来 (P3-14)。parseNetworkType の出典注記を参照。
      return { kind: "networkType", ...parseNetworkType(buf) };
    case ITEM.HUB3_ITEM_CODE_SSID_FIRST:
    case ITEM.HUB3_ITEM_CODE_SSID_LAST:
      // CHHub3Device.kt:324-325 は両方とも空ブロック (マーカーのみ)。
      return { kind: "ssidMarker", itemCode };
    default:
      return { kind: "unknown", itemCode, body: buf };
  }
}

// ---------- 高レベル: Hub3 制御ファサード ----------
//
// SesameBleSession (session.js) を SESAME 既定 GATT で接続/ログイン済みであることが前提。
// 本クラスは session.request(itemCode, data) に Hub3 固有の itemCode と上記 data builder を結線し、
// publish を parseHub3Publish で正規化して購読者へ配るだけの薄い層 (WifiModule2 と同型)。

export class Hub3Commands {
  /**
   * @param {{session:import("./session.js").SesameBleSession}} opts
   *   session: SESAME 既定 GATT で接続/ログイン済み (もしくは register 済み) の SesameBleSession。
   */
  constructor({ session } = /** @type {{session:import("./session.js").SesameBleSession}} */ ({})) {
    if (!session) throw new Error(t("ble.hub3SessionRequired"));
    this._session = session;
    /** @type {Set<(parsed:any)=>void>} */
    this._publishListeners = new Set();
    /** @type {(() => void)|null} session publish 中継の unsubscribe。 */
    this._off = session.onPublish((pub) => {
      let parsed;
      try { parsed = parseHub3Publish(pub); } catch { return; }
      for (const fn of [...this._publishListeners]) { try { fn(parsed); } catch { /* ignore */ } }
    });
  }

  /** Hub3 publish (正規化済み {kind, ...}) を購読。戻り値 unsubscribe。 @param {(parsed:any)=>void} fn */
  onPublish(fn) { this._publishListeners.add(fn); return () => this._publishListeners.delete(fn); }

  /** 購読解除 (session の publish 中継を外す)。 */
  dispose() { if (this._off) { this._off(); this._off = null; } this._publishListeners.clear(); }

  /**
   * 周辺 Wi-Fi SSID をスキャン (CHHub3Device.kt:238-244)。
   * 結果は onPublish の {kind:"scanWifiSSID"} で逐次届く。
   */
  scanWifiSSID() {
    return this._session.request(ITEM.HUB3_ITEM_CODE_WIFI_SSID, scanWifiSSIDData());
  }

  /** Wi-Fi SSID を設定 (CHHub3Device.kt:255-265、HUB3_UPDATE_WIFI_SSID=136)。 @param {string} ssid */
  setWifiSSID(ssid) {
    return this._session.request(ITEM.HUB3_UPDATE_WIFI_SSID, setWifiSSIDData(ssid));
  }

  /** Wi-Fi パスワードを設定 (CHHub3Device.kt:246-253、HUB3_ITEM_CODE_WIFI_PASSWORD=135)。 @param {string} password */
  setWifiPassword(password) {
    return this._session.request(ITEM.HUB3_ITEM_CODE_WIFI_PASSWORD, setWifiPasswordData(password));
  }

  /**
   * 子 Sesame を Hub3 から削除する (CHHub3Device.kt:228-236、REMOVE_SESAME=103)。
   * data は dash 除去 UUID(32hex) を decode した生 16B (WM2 とは経路が異なる)。
   * @param {string} tag 削除対象の鍵タグ (UUID 文字列)。
   */
  removeSesame(tag) {
    return this._session.request(ITEM.REMOVE_SESAME, removeSesameData(tag));
  }

  /**
   * Hub3 に現在の接続種別を要求する (NETWORK_TYPE=209)。
   * 状態は onPublish の {kind:"networkType"} で届く — と推定。
   *
   * 注 (P3-14): itemCode 209 は **Android SDK に存在しない** (SesameItemCode は 208 で終端、
   *   SesameProtocols.kt:32-53。CHHub3Device.kt に送信・受信どちらのハンドラも無い)。biz3 web の
   *   native ブリッジ挙動 (requestNetworkType、references_web/src/components/MobileWifiModule.js:219-235)
   *   からの推定であり、BLE 経路の存在自体が未確認。
   * @experimental 実機未検証 (§9 V6)。確証が得られない場合は機能ごと削除を検討する。
   */
  networkType() {
    return this._session.request(UNVERIFIED.HUB3_ITEM_CODE_NETWORK_TYPE, networkTypeData());
  }
}
