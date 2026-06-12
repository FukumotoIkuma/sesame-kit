// SESAME BLE プロトコル — 純 JS のコア (OS 非依存・ゼロ追加依存)。
//
// 移植元 (1:1、行番号は調査仕様書準拠):
//   - ESP32 C 実装: references_esp32/main/sesame/{ssm.c, ssm_cmd.c}, utils/{c_ccm.c, aes-cbc-cmac.c}
//   - Android SDK : references_android/.../ble/{SesameProtocols.kt, SesameBleReceiver.kt},
//                   ble/os3/base/{CHSesameOS3.kt, SesameOS3BleCipher.kt}, open/devices/base/CHSesameOS3LockBase.kt
//
// 対象は SesameOS3 (SESAME 5 / 5 Pro / Touch 等)。OS2 (SESAME 3/4/Bot) は対象外 (鍵導出・nonce 長が別)。
//
// この層は「接続後のバイト列」だけを扱う純関数群。BLE 無線 I/O (scan/connect/write/notify) は
// transport アダプタの責務で、ここには一切含めない (= どの OS / ライブラリでも動く)。

import crypto from "node:crypto";
import { Buffer } from "node:buffer";
// AES-CMAC は内製実装 (RFC 4493 準拠, src/aes-cmac.js)。旧 node-aes-cmac は無メンテ +
// deprecated Buffer コンストラクタ使用のため置き換えた (REFACTORING_PLAN P5-2)。
import { aesCmac } from "../aes-cmac.js";
import { t } from "../i18n.js";
import { ITEM_CODES, WM2_ACTION_CODES } from "../itemcodes.js";

// ---------- 定数 ----------

/** GATT (blecent.c:13-15 / SesameProtocols.kt:80-83)。 */
export const GATT = Object.freeze({
  SERVICE: "fd81",
  WRITE_CHAR: "16860002-a5ae-9856-b6d3-dbb4c676993e", // RX (app→device, Write Without Response)
  NOTIFY_CHAR: "16860003-a5ae-9856-b6d3-dbb4c676993e", // TX (device→app, notify)
});

/** advertise の company ID (LE 5A 05 = 0x055A)。blecent.c:132 */
export const COMPANY_ID = 0x055a;

/** op_code (candy.h:66-69 / SesameProtocols.kt:55-57)。受信で意味を持つのは response/publish。 */
export const OP = Object.freeze({
  CREATE: 0x01, READ: 0x02, UPDATE: 0x03, DELETE: 0x04,
  SYNC: 0x05, ASYNC: 0x06, RESPONSE: 0x07, PUBLISH: 0x08,
  // undefine(0x10) — SesameProtocols.kt:55-57 SSM2OpCode の終端メンバ。SDK 内で送受信に使われない
  // **未使用センチネル** (enum 完全性のためにのみ移植。ルーティングに使わないこと)。
  UNDEFINE: 0x10,
});

/** item_code。クラウドと共通の正準ソース (src/itemcodes.js) を参照する (重複定義を避ける)。 */
export const ITEM = ITEM_CODES;

/** セグメントの parsing type (candy.h:44-46 / SesameBleReceiver.kt:5)。ヘッダ = (type<<1) | startBit。 */
export const SEG = Object.freeze({ APPEND_ONLY: 0, PLAINTEXT: 1, CIPHERTEXT: 2 });

/**
 * SESAME OS3 デバイスがコマンド応答 (response 0x07) の先頭バイトで返す結果コード。
 * 出典: Android SDK `enum SesameResultCode` —
 *   _sesame_sdk_ref/sesame-sdk/.../ble/SesameProtocols.kt:28-30
 *     success(0)..INVALID_PARAM(8) で **8 で終端**。
 * コード 9 ("invalidAction") は iOS SDK 由来と主張されていたが `references_ios/` は存在しない。
 * 未検証値は UNVERIFIED_RESULT_NAMES に隔離し、この表は SesameProtocols.kt と 1:1 に保つ (P3-16)。
 * これは **デバイス層 (SesameOS3) の taxonomy** で BLE/WM2 で共通。クラウド (biz3) 経路は
 * この code を surface しないため、利用できるのは BLE 直接経路のみ。
 */
export const RESULT = Object.freeze({
  0: "success", 1: "invalidFormat", 2: "notSupported", 3: "resultStorageFail",
  4: "invalidSig", 5: "notFound", 6: "unknown", 7: "busy", 8: "invalidParam",
});

/**
 * 一次ソース (Android SDK SesameProtocols.kt:28-30) で**確認できない**結果コード名。
 * RESULT 本体を参照と 1:1 に保つため、未検証値をここに隔離する (P3-14 UNVERIFIED_ITEM_CODES と同規範)。
 * iOS SDK (`references_ios/` 不在) 等の別一次ソースまたは実機キャプチャで確認できたら
 * RESULT へ昇格すること。確認できない場合は resultName が `unknown(N)` を返すため、
 * jsonrpc.js の BLE_RESULT_TO_RPC は fallback (rejected) で処理する。
 *
 * 9: "invalidAction" — iOS SDK `CHError.BleInvalidAction` との対応が主張されていたが、
 *   `CHError.BleInvalidAction` はクライアント側エラー enum であり結果コード 9 の根拠にならない。
 *   SesameProtocols.kt:28-30 は 8 (INVALID_PARAM) で終端しており、9 は存在しない。
 */
export const UNVERIFIED_RESULT_NAMES = Object.freeze({
  9: "invalidAction",
});

/**
 * 結果コード → 名前 (未知は unknown(N))。
 * 検証済みコード (RESULT) を優先し、未知コードは `unknown(N)` を返す。
 * UNVERIFIED_RESULT_NAMES の値は意図的にここから除外している (P3-16)。
 * @param {number} code
 * @returns {string}
 */
export function resultName(code) {
  return /** @type {Record<number, string>} */ (RESULT)[code] || `unknown(${code})`;
}

const CCM_TAG_LEN = 4; // candy.h:42
const MAX_CHUNK_DATA = 19; // 20B パケット - ヘッダ1B (ssm.c:112-127)

// ---------- セッションプロファイル (lock / wm2) ----------
//
// SesameOS3 のセッション確立は機種で 2 系統に分かれる。CHWifiModule2Device は CHSesameOS3 の
// login/register/initial を**オーバーライド**しており、ロック系と非互換 (CHWifiModule2Device.kt:279-321,
// 521-528)。差分はワイヤ形状そのもの (initial itemCode / login payload / cipher 鍵 / CCM sault) なので、
// 「どちらの形でしゃべるか」をプロファイルとしてこの層で定義し、session.js が参照する。
//
//   lock (既定): SESAME5 系ロック・Hub3・Bot2/Bike2/3・biometric (CHSesameOS3 基底のまま)
//     - initial itemCode = 14 (SesameItemCode.initial)
//     - login: 鍵 = CMAC(secretKey, token4)、payload = [LOGIN(2)] ++ 鍵[0:4] (CHSesameOS3LockBase.kt:109-120)
//     - register data = pubK64 ++ timestamp4 (CHHub3Device.kt:191-194)、登録後鍵 = CMAC(pre16, token4)
//     - CCM sault = 0x00 ++ token4 → nonce 13B (CHHub3Device.kt:170,203)
//   wm2: WifiModule2 のみ (CHWifiModule2Device.kt)
//     - initial itemCode = 13 (WM2ActionCode.INITIAL、kt:521-528/540)
//     - login: 鍵 = secretKey **生 16B**、payload = [LOGIN_WM2(2)] ++ CMAC(secretKey, token4) **16B 全量**
//       (kt:314-321: loginTag = AesCmac(secretKey).computeMac(mSesameToken)、cipher 鍵 = secretKey 生)
//     - register data = pubK64 のみ (timestamp 無し、kt:290)、登録後鍵 = ecdhSecret_pre16 **生**
//       (kt:295-297: cipher = SesameOS3BleCipher(name, ecdhSecret_pre16, mSesameToken))
//     - CCM sault = token4 (0x00 を挟まない) → nonce 12B (kt:297,317 sault = mSesameToken)
export const SESSION_PROFILES = Object.freeze({
  lock: Object.freeze({ initialItemCode: ITEM_CODES.INITIAL }),       // 14 (SesameProtocols.kt)
  wm2: Object.freeze({ initialItemCode: WM2_ACTION_CODES.INITIAL }),  // 13 (CHWifiModule2Device.kt:540)
});

/**
 * プロファイル名の検証 (lock / wm2 以外を黙って lock 扱いしない)。
 * @param {string} profile
 * @returns {"lock"|"wm2"}
 */
export function assertProfile(profile) {
  if (profile !== "lock" && profile !== "wm2") {
    throw new Error(t("ble.unknownProfile", { profile: String(profile) }));
  }
  return profile;
}

// ---------- セッション鍵 / login ----------

/**
 * 既存 secretKey と initial token から CCM セッション鍵 (16B) を導出する。
 * token16 = AES-128-CMAC(secretKey, randomToken)  (ssm_cmd.c:43 / CHSesameOS3LockBase.kt:109)
 *
 * @param {string|Buffer} secretKey 16B (32hex)
 * @param {Buffer} token 4B (initial publish のランダム値)
 * @returns {Buffer} 16B セッション鍵
 */
export function deriveSessionKey(secretKey, token) {
  const key = Buffer.isBuffer(secretKey) ? secretKey : Buffer.from(secretKey, "hex");
  if (key.length !== 16) throw new Error(t("ble.secretKeyMustBe16", { len: key.length }));
  if (!Buffer.isBuffer(token) || token.length !== 4) throw new Error(t("ble.tokenMustBe4Byte"));
  // 内製 aesCmac は常に 16B Buffer を返す (旧 node-aes-cmac の hex/Buffer 揺れ正規化は不要)。
  return aesCmac(key, token);
}

/**
 * 登録 (registration) 直後の sessionAuth 用セッション鍵を ECDH 共有秘密から導出する。
 *   sessionKey16 = AES-128-CMAC(ecdhSecretPre16, token4)   (CHHub3Device.kt:202-203)
 *
 * 通常 login (deriveSessionKey 上記) との分岐:
 *   - 通常 login : 鍵 = 既存の pre-shared secretKey (CMAC(secretKey, token), CHHub3Device.kt:168)。
 *   - register 直後: 鍵 = ECDH 共有秘密の先頭 16B (= crypto.js:ecdhSecretPre16, CHHub3Device.kt:163-174,197)。
 *   どちらも CMAC の **メッセージは token4 (4B)** で共通、戻りは 16B。違いは CMAC の鍵だけ。
 *
 * sault も両者共通 (lock profile): sault = 0x00 ++ token4 (CHHub3Device.kt:170,203 /
 * SesameOS3BleCipher.kt:8-19)。sault は CCM nonce の組み立て側 (ccmNonce(count, ccmSault(profile,
 * token4))) で消費するため、この鍵導出関数自体は sault を引数に取らない (session 確立後の暗号化は
 * ccmEncrypt/ccmDecrypt が担う)。
 * なお wm2 profile はこの関数を **使わない** (登録後鍵 = pre16 生・login 鍵 = secretKey 生、
 * CHWifiModule2Device.kt:295-297,317。SESSION_PROFILES 参照)。
 *
 * 実装方針: アルゴリズム (16B 鍵 + 4B token → AES-128-CMAC(鍵, token4) で 16B) は login 経路の
 *   deriveSessionKey と完全に同一で、違いは「鍵の出所」だけ。よって CMAC コードパスを二重に
 *   持たず deriveSessionKey へ委譲する (将来 CMAC 仕様が変わっても 1 箇所だけ直せばよい)。
 *   ここでは ecdhSecretPre16 という意味的別名のための薄いラッパに徹し、register 文脈で分かりやすい
 *    ecdhSecretPre16 専用エラーメッセージだけを先に検証してから本体へ渡す。
 *
 * @param {Buffer} ecdhSecretPre16 ECDH 共有秘密の先頭 16B (crypto.js:ecdhSecretPre16 の戻り)。
 * @param {Buffer} token4 initial publish のランダム値 4B。
 * @returns {Buffer} 16B セッション鍵 (= sessionAuth)。
 */
export function deriveSessionKeyFromEcdh(ecdhSecretPre16, token4) {
  if (!Buffer.isBuffer(ecdhSecretPre16) || ecdhSecretPre16.length !== 16) {
    throw new Error(t("ble.ecdhSecretMustBe16", { len: Buffer.isBuffer(ecdhSecretPre16) ? ecdhSecretPre16.length : "non-buffer" }));
  }
  // CMAC 本体は deriveSessionKey に集約 (token4 の長さ検証もそちらが担う)。
  return deriveSessionKey(ecdhSecretPre16, token4);
}

/**
 * login コマンドの平文ペイロード (PLAINTEXT セグメントで送る)。プロファイルで形が分かれる:
 *   - lock: [LOGIN(2)] ++ token16[0:4] = 5B (ssm_cmd.c:44-45 / CHSesameOS3LockBase.kt:118-120)
 *   - wm2 : [LOGIN_WM2(2)] ++ loginTag **16B 全量** = 17B
 *           (CHWifiModule2Device.kt:314-321: sendCommand(SesameOS3Payload(LOGIN_WM2, loginTag), plain)。
 *            loginTag = AesCmac(secretKey 生 16B).computeMac(mSesameToken) で切り詰めない)
 * LOGIN(2) と WM2ActionCode.LOGIN_WM2(2) は同値なので先頭バイトは共通、続く長さだけが異なる。
 * @param {Buffer} token16 deriveSessionKey の戻り (lock: session 鍵 / wm2: loginTag = CMAC(secretKey, token))
 * @param {"lock"|"wm2"} [profile="lock"]
 * @returns {Buffer} lock: 5B / wm2: 17B
 */
export function loginPayload(token16, profile = "lock") {
  assertProfile(profile);
  if (profile === "wm2") return Buffer.concat([Buffer.from([ITEM.LOGIN]), token16]);
  return Buffer.concat([Buffer.from([ITEM.LOGIN]), token16.subarray(0, 4)]);
}

// ---------- AES-128-CCM (c_ccm.c, ssm.c:80-82/100-104) ----------

/**
 * CCM nonce = count(8B LE) ++ sault。sault はプロファイル依存 (ccmSault):
 *   - lock: sault = 0x00 ++ token4 → nonce 13B (ssm.h:17-21 / CHHub3Device.kt:170,203)
 *   - wm2 : sault = token4         → nonce 12B (CHWifiModule2Device.kt:297,317)
 * SesameOS3BleCipher.kt:13 nonce = encryptCounter.toBytes() (8B LE, DataExtention.kt:114-129) + sault。
 * @param {number|bigint} count
 * @param {Buffer} sault ccmSault の戻り (lock 5B / wm2 4B)
 * @returns {Buffer} 13B (lock) / 12B (wm2)
 */
function ccmNonce(count, sault) {
  const c = Buffer.alloc(8);
  c.writeBigUInt64LE(BigInt(count));
  return Buffer.concat([c, sault]);
}

/**
 * CCM sault をプロファイルから組み立てる (SesameOS3BleCipher のコンストラクタ第 3 引数に相当)。
 *   - lock: "00" + mSesameToken (CHHub3Device.kt:170,203 / CHSesame5 系・Bot2/Bike2 も同形)
 *   - wm2 : mSesameToken そのまま 4B — 0x00 を挟まない (CHWifiModule2Device.kt:297,317)
 * @param {"lock"|"wm2"} profile
 * @param {Buffer} token4 initial token (4B)
 * @returns {Buffer} lock: 5B / wm2: 4B
 */
export function ccmSault(profile, token4) {
  assertProfile(profile);
  if (!Buffer.isBuffer(token4) || token4.length !== 4) throw new Error(t("ble.tokenMustBe4Byte"));
  if (profile === "wm2") return Buffer.from(token4);
  return Buffer.concat([Buffer.from([0x00]), token4]);
}

const CCM_AAD = Buffer.from([0x00]); // ssm.c:8

/**
 * コマンド平文を CCM 暗号化し、末尾に 4B tag を付けて返す。
 * @param {Buffer} token16 セッション鍵
 * @param {number|bigint} count 送信カウンタ (送信ごと +1)
 * @param {Buffer} token4 initial token
 * @param {Buffer} plaintext 暗号化前フレーム ([item, ...data])
 * @param {"lock"|"wm2"} [profile="lock"] nonce sault の形 (ccmSault 参照)。既定は従来どおり lock。
 * @returns {Buffer} ciphertext ++ tag(4B)
 */
export function ccmEncrypt(token16, count, token4, plaintext, profile = "lock") {
  const iv = ccmNonce(count, ccmSault(profile, token4));
  const c = crypto.createCipheriv("aes-128-ccm", token16, iv, { authTagLength: CCM_TAG_LEN });
  c.setAAD(CCM_AAD, { plaintextLength: plaintext.length });
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  return Buffer.concat([ct, c.getAuthTag()]);
}

/**
 * CCM 復号。入力は ciphertext ++ tag(4B)。tag 不一致なら throw。
 * @param {Buffer} token16
 * @param {number|bigint} count 受信カウンタ (受信ごと +1)
 * @param {Buffer} token4
 * @param {Buffer} ctWithTag ciphertext ++ tag(4B)
 * @param {"lock"|"wm2"} [profile="lock"] nonce sault の形 (ccmSault 参照)。既定は従来どおり lock。
 * @returns {Buffer} 復号平文
 */
export function ccmDecrypt(token16, count, token4, ctWithTag, profile = "lock") {
  if (ctWithTag.length < CCM_TAG_LEN) throw new Error(t("ble.ciphertextTooShort"));
  const iv = ccmNonce(count, ccmSault(profile, token4));
  const ct = ctWithTag.subarray(0, ctWithTag.length - CCM_TAG_LEN);
  const tag = ctWithTag.subarray(ctWithTag.length - CCM_TAG_LEN);
  const d = crypto.createDecipheriv("aes-128-ccm", token16, iv, { authTagLength: CCM_TAG_LEN });
  d.setAAD(CCM_AAD, { plaintextLength: ct.length });
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

// ---------- セグメント分割 / 結合 (ssm.c:70-128 / SesameBleReceiver.kt) ----------

/**
 * 1 メッセージ (平文 or 暗号文+tag) を 20B パケット列に分割する。
 * 先頭パケットのみ start bit、最終パケットで parsing type を立てる (中間は APPEND_ONLY)。
 * @param {Buffer} payload 送るバイト列 (平文ならフレーム、暗号なら ct++tag)
 * @param {number} parsingType SEG.PLAINTEXT | SEG.CIPHERTEXT
 * @returns {Buffer[]} 各 ≤20B
 */
export function splitSegments(payload, parsingType) {
  const packets = [];
  let offset = 0;
  let first = true;
  // payload 長 0 でも 1 パケット (ヘッダのみ) を送る必要がある場合に対応 (do-while 的)
  do {
    const remain = payload.length - offset;
    const isLast = remain <= MAX_CHUNK_DATA;
    const dataLen = isLast ? remain : MAX_CHUNK_DATA;
    let header = isLast ? (parsingType << 1) : (SEG.APPEND_ONLY << 1);
    if (first) header |= 1;
    packets.push(Buffer.concat([Buffer.from([header]), payload.subarray(offset, offset + dataLen)]));
    offset += dataLen;
    first = false;
  } while (offset < payload.length);
  return packets;
}

/**
 * 受信セグメントを結合するアセンブラ。feed() で 1 パケットずつ与え、メッセージ完結時に
 * { type, data } を返す (未完なら null)。start bit でバッファをリセット。
 */
export class SegmentAssembler {
  constructor() {
    /** @type {Buffer[]} */
    this._buf = [];
  }

  /**
   * @param {Buffer} packet notify で届いた 1 パケット
   * @returns {{type:number, data:Buffer}|null} 完結時のみ {type, data}
   */
  feed(packet) {
    if (!packet || packet.length < 1) return null;
    const header = packet[0];
    if (header & 1) this._buf = []; // start bit → リセット (ssm.c:71-73)
    this._buf.push(packet.subarray(1));
    const type = header >> 1;
    if (type === SEG.APPEND_ONLY) return null; // 継続 (ssm.c:76-78)
    const data = Buffer.concat(this._buf);
    this._buf = [];
    return { type, data };
  }
}

// ---------- フレーム build / parse (ssm.c:85-94 / CHSesameOS3.kt:142-150) ----------

/**
 * 送信フレーム = [item_code] ++ data。op_code は送信時付与しない (CHSesameOS3.kt:495-499)。
 * @param {number} itemCode
 * @param {Buffer} [data]
 * @returns {Buffer}
 */
export function buildSendFrame(itemCode, data = Buffer.alloc(0)) {
  return Buffer.concat([Buffer.from([itemCode]), data]);
}

/**
 * 受信フレーム (復号後) = [op_code][item_code][body...] を分解。
 * response(7) は body=[resultCode][payload...]、publish(8) は body=[payload...] (呼び出し側で解釈)。
 * @param {Buffer} buf
 * @returns {{opCode:number, itemCode:number, body:Buffer}}
 */
export function parseRecvFrame(buf) {
  if (buf.length < 2) throw new Error(t("ble.frameTooShort"));
  return { opCode: buf[0], itemCode: buf[1], body: buf.subarray(2) };
}

// ---------- 各コマンドの data 生成 ----------

/**
 * lock/unlock の data = `[0x00, 0x0E] ++ historyTag`、先頭 20B に切詰め (CHDBModel.kt:37-57)。
 * 先頭 2B `0x000E` (BE) は tag type = "Android user BLE UUID" (SesameProtocols.kt:70)。
 *
 * tag 省略時は type のみ (`[0x00,0x0E]`) を送る = SDK の `historytag=null` パスと同じ。
 * tag を渡す場合は **Buffer (バイト列) を渡すこと**。type が UUID を示すため、任意 utf8 文字列を
 * 入れると型と中身が不整合になる (操作ログ用途であり実害は小さいが、SDK 準拠なら bytes)。
 *
 * @param {Buffer|Uint8Array} [tag] 操作ログ用タグ (バイト列)。省略可。
 * @returns {Buffer}
 */
export function historyTagBLE(tag) {
  let tagBuf;
  if (tag == null) tagBuf = Buffer.alloc(0);
  else if (Buffer.isBuffer(tag) || tag instanceof Uint8Array) tagBuf = Buffer.from(tag);
  else throw new Error(t("ble.historyTagBuffer"));
  return Buffer.concat([Buffer.from([0x00, 0x0e]), tagBuf]).subarray(0, 20);
}

/**
 * autolock の data = 2B LE 秒数 (delay.toShort().toReverseBytes()、CHSesame5Device.kt:96-105)。0=無効。
 * @param {number} seconds 0..65535
 * @returns {Buffer} 2B
 */
export function autolockData(seconds) {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 0xffff) {
    throw new Error(t("ble.secondsRange"));
  }
  const b = Buffer.alloc(2);
  b.writeUInt16LE(seconds);
  return b;
}

/**
 * Short.toReverseBytes() (DataExtention.kt:108-112) の移植。
 * SDK は ByteBuffer.putShort で **big-endian** に詰めた後 [1],[0] の順に並べ替える =
 * 結果は符号付き 16bit を **little-endian 2B** にしたものと等価。
 * configureLockPosition の lockTarget/unlockTarget はこの関数で LE 2B 化される
 * (CHSesame5Device.kt:69-73)。負値 (-32768..-1) も含むため writeInt16LE で詰める。
 * @param {number} value -32768..32767
 * @returns {Buffer} 2B LE
 */
function shortToReverseBytes(value) {
  if (!Number.isInteger(value) || value < -32768 || value > 32767) {
    throw new Error(t("ble.shortRange", { value: String(value) }));
  }
  const b = Buffer.alloc(2);
  b.writeInt16LE(value);
  return b;
}

// ---------- mechSetting (角度キャリブレーション、item 80) ----------

/**
 * configureLockPosition(lockTarget, unlockTarget) コマンドの data を組み立てる。
 *   data = lockTarget.toReverseBytes() ++ unlockTarget.toReverseBytes() = 4B
 *   (CHSesame5Device.kt:69-73)。
 *
 * lockTarget / unlockTarget は施錠位置・解錠位置の **角度 (エンコーダ生値、符号付き 16bit)**。
 * 各々を toReverseBytes (= LE 2B) で詰め、`[lockLE(2)] ++ [unlockLE(2)]` の 4B にする。
 * これを buildSendFrame(ITEM.MECH_SETTING, data) → CIPHERTEXT で送る (sendCommand cipher)。
 *
 * @param {number} lockTarget   施錠目標角 (-32768..32767)
 * @param {number} unlockTarget 解錠目標角 (-32768..32767)
 * @returns {Buffer} 4B
 */
export function configureLockPositionData(lockTarget, unlockTarget) {
  return Buffer.concat([shortToReverseBytes(lockTarget), shortToReverseBytes(unlockTarget)]);
}

/**
 * mechSetting (item 80) の publish/response payload を解析する。
 * CHSesame5MechSettings(data) (CHSesame5.kt:34-38) を 1:1 で移植:
 *   data[0..1]: lockPosition   (bytesToShort = i16 LE)
 *   data[2..3]: unlockPosition (i16 LE)
 *   data[4..5]: autoLockSecond (i16 LE)
 *
 * 登録応答 (handleRegisterResponse, CHSesame5Device.kt:201) では payload[7..12] の 6B が
 * この mechSetting に相当する。publish (handleDevicePublish, CHSesame5Device.kt:220-222) では
 * payload 全体が 6B の mechSetting。どちらも先頭 6B を読むので length>=6 を要求する。
 *
 * 注: bytesToShort(b1,b2) = (b2<<8)|b1 = **符号付き** little-endian (DataExtention.kt:99-102)。
 * SDK は autoLockSecond も Short (符号付き) で持つため、ここも readInt16LE で揃える。
 *
 * @param {Buffer} buf 6B 以上
 * @returns {{lockPosition:number, unlockPosition:number, autoLockSecond:number}}
 */
export function parseMechSetting(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error(t("ble.mechSettingMustBeBuffer"));
  if (buf.length < 6) throw new Error(t("ble.mechSettingLength", { len: buf.length }));
  return {
    lockPosition: buf.readInt16LE(0),
    unlockPosition: buf.readInt16LE(2),
    autoLockSecond: buf.readInt16LE(4),
  };
}

/**
 * opsSetting (item OPS_CONTROL) の payload を解析する。
 * CHSesame5OpsSettings(data) (CHSesame5.kt:40-42) を移植:
 *   data[0..1]: opsLockSecond (bytesToUShort = u16 LE)
 * SDK は UShort (符号なし) で持つため readUInt16LE。
 * @param {Buffer} buf 2B 以上
 * @returns {{opsLockSecond:number}}
 */
export function parseOpsSetting(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error(t("ble.opsSettingMustBeBuffer"));
  if (buf.length < 2) throw new Error(t("ble.opsSettingLength", { len: buf.length }));
  return { opsLockSecond: buf.readUInt16LE(0) };
}

/**
 * opSensorControl(isEnable) コマンドの data を組み立てる。
 *   data = isEnable.toShort().toReverseBytes() = 2B LE (CHSesame5Device.kt:107-116)。
 *
 * SDK の引数名は isEnable だが、実体は opsLockSecond (Open Sensor の自動施錠秒数) を
 * 載せる 16bit 値で、成功時に opsSetting?.opsLockSecond = isEnable.toUShort() でキャッシュ更新する。
 * autolock(11) と同じ 2B LE 形式。0=無効。範囲は UShort (0..65535)。
 * @param {number} seconds 0..65535 (0 = 無効)
 * @returns {Buffer} 2B LE
 */
export function opSensorControlData(seconds) {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 0xffff) {
    throw new Error(t("ble.secondsRange"));
  }
  const b = Buffer.alloc(2);
  b.writeUInt16LE(seconds);
  return b;
}

/**
 * setBleTxPower(txPower) コマンドの data を組み立てる。
 *   data = byteArrayOf(txPower) = 1B (CHSesameOS3LockBase.kt:62-71 /
 *   CHSesameBiometricDeviceImpl.kt:332-341)。
 *
 * txPower は Kotlin の Byte = **符号付き 8bit** (-128..127)。publish 受信
 * (CHSesameOS3LockBase.kt:229-231) でも payload[0] を Byte として bleTxPower に格納する。
 * 1B なので符号付き/符号なしどちらで書いても同一バイトだが、SDK の意味論 (Byte) に揃えて
 * -128..127 を受け、writeInt8 で詰める。
 * @param {number} txPower -128..127
 * @returns {Buffer} 1B
 */
export function bleTxPowerData(txPower) {
  if (!Number.isInteger(txPower) || txPower < -128 || txPower > 127) {
    throw new Error(t("ble.txPowerRange", { value: String(txPower) }));
  }
  const b = Buffer.alloc(1);
  b.writeInt8(txPower);
  return b;
}

// ---------- time 同期 (item 8) ----------

/**
 * time(8) コマンドの data を組み立てる。
 *   data = System.currentTimeMillis().toUInt32ByteArray() = 4B (CHSesameOS3LockBase.kt:131-137)。
 *
 * toUInt32ByteArray (DataExtention.kt:138-147) は ms→秒 (floor) の下位 32bit を little-endian 4B
 * にするもので、registrationTimestampBytes と **完全に同一アルゴリズム** (登録時刻も同じ関数を使う、
 * CHSesameOS3LockBase.kt:93)。よって唯一の実装である registrationTimestampBytes に委譲し、
 * time 文脈で分かりやすい別名を提供する (アルゴリズムを二重に持たない)。
 *
 * 送出経路 (CHSesameOS3LockBase.kt:126-138 handleLoginResponse):
 *   login 応答の payload[0..3] (デバイス時刻 toBigLong, 秒) と端末の現在秒を比較し、
 *   差の絶対値が 3 秒を超えたときだけ time(8) を CIPHERTEXT 送出する。
 *   差判定は session 側 (parseTimeSyncPayload) で行う。
 *
 * @param {number} [nowMs=Date.now()] エポックミリ秒
 * @returns {Buffer} 4B (秒値の下位 32bit を LE)
 */
export function timeSyncData(nowMs = Date.now()) {
  return registrationTimestampBytes(nowMs);
}

/**
 * login 応答 payload からデバイス側の現在時刻 (秒) を取り出す。
 * SDK: loginPayload.payload.sliceArray(0..3).toBigLong() (CHSesameOS3LockBase.kt:127)。
 * toBigLong (DataExtention.kt:69-71) = reversedArray().toHexString() を 16進 Long parse
 *   = 4B を **big-endian 並べ替え後の値** = 元バイト列を little-endian u32 として読むのと等価。
 * payload が 4B 未満なら null (時刻同期判定をスキップさせる)。
 * @param {Buffer} payload login response の payload (resultCode を除いた本体)
 * @returns {number|null} デバイス時刻 (秒) or null
 */
export function parseDeviceTimeSeconds(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 4) return null;
  return payload.readUInt32LE(0);
}

/**
 * デバイス時刻 (秒) と端末時刻の差が同期しきい値 (>3 秒) を超えるか。
 * SDK: abs(currentTimestamp - systemTime) > 3 (CHSesameOS3LockBase.kt:128-130)。
 * @param {number} deviceSeconds parseDeviceTimeSeconds の戻り
 * @param {number} [nowMs=Date.now()] 端末のエポックミリ秒
 * @returns {boolean} true なら time(8) を送るべき
 */
export function needsTimeSync(deviceSeconds, nowMs = Date.now()) {
  if (typeof deviceSeconds !== "number") return false;
  const currentSeconds = Math.floor(nowMs / 1000);
  return Math.abs(currentSeconds - deviceSeconds) > 3;
}

// ---------- history 読み出し / 削除 (item 4 / 18) ----------

/**
 * history(4) 読み出しコマンドの data = byteArrayOf(0x01) (CHSesameOS3LockBase.kt:187-188)。
 * 1 件分の履歴を要求する固定 1B フラグ。
 * @returns {Buffer} 1B
 */
export function historyReadData() {
  return Buffer.from([0x01]);
}

/**
 * historyDelete(18, SSM2_ITEM_CODE_HISTORY_DELETE) コマンドの data を組み立てる。
 *   data = recordId = historyPayload.sliceArray(0..3) = 履歴 payload 先頭 4B
 *   (CHSesameOS3LockBase.kt:201-207)。
 * サーバへ履歴を post できた後、その 1 件をデバイスから消すために送る。
 * 渡す historyPayload は history(4) 応答の payload (先頭 4B が recordId)。
 * @param {Buffer} historyPayload history(4) 応答 payload (4B 以上)
 * @returns {Buffer} 4B recordId
 */
export function historyDeleteData(historyPayload) {
  if (!Buffer.isBuffer(historyPayload) || historyPayload.length < 4) {
    throw new Error(t("ble.historyPayloadTooShort", { len: Buffer.isBuffer(historyPayload) ? historyPayload.length : "non-buffer" }));
  }
  return Buffer.from(historyPayload.subarray(0, 4));
}

// ---------- 登録タイムスタンプ 4B (BLE デバイス登録 / 初期ペアリング) ----------

/**
 * 登録 (registration) コマンドの末尾に付ける現在時刻を 4B にエンコードする。
 * SDK の `Long.toUInt32ByteArray()` (DataExtention.kt:138-147) を 1:1 で移植する。
 *
 * ★配線状況 (2026-06 時点): この関数は登録フローに**配線済み**である。
 *   registrationData() がこのバイト列を pubKey64 の後ろに連結し (下記の (a))、
 *   session.register() (src/ble/session.js:226) が
 *   `_sendPlain(buildSendFrame(ITEM.REGISTRATION, registrationData(pubK64, nowMs)))` で
 *   REGISTRATION(1) を PLAINTEXT セグメント送出する形で本番フローに乗っている。
 *   登録フローの配線済み要素:
 *     (a) registrationData() = pubKey64(64B) ++ registrationTimestampBytes(4B) の組み立て
 *         (CHHub3Device.kt:193)。この関数の直下に実装済み。
 *     (b) ITEM.REGISTRATION(=1) を PLAINTEXT で送る session 経路 (session.js:226)。配線済み。
 *     (c) crypto.js の ECDH ブロック (ecdhSecretPre16) は session.register() (session.js:234)
 *         で device の返す公開鍵から共有秘密を導く形で接続済み。
 *   ファサード層も SesameBle.register() / registerOnce() として公開済み (index.js)。
 *   注: バイト列・ハンドシェイクは mock vector で単体/end-to-end テスト済みだが、**実機 OS3
 *   デバイスに対する検証は未了** (README の Known limitations 参照)。配線は完了している。
 *
 * 用途 (CHHub3Device.kt:193):
 *   registration payload = EccKey.getPubK()(64B) ++ currentTimeMillis().toUInt32ByteArray()(4B)
 * を plain セグメントで送る。
 *
 * SDK 原典 (DataExtention.kt:138-147):
 *   val tmp = this / 1000                       // ms → 秒 (Long 除算 = floor)
 *   bytes[3] = (tmp and 0xFFFF).toByte()         // 0xFFFF でマスク後 .toByte() で下位8bitに切り詰め → bits 0..7
 *   bytes[2] = (tmp ushr 8  and 0xFFFF).toByte() // 同上 → bits 8..15
 *   bytes[1] = (tmp ushr 16 and 0xFFFF).toByte() // 同上 → bits 16..23
 *   bytes[0] = (tmp ushr 24 and 0xFFFF).toByte() // 同上 → bits 24..31
 *   return bytes.reversedArray()                 // [b24,b16,b8,b0] (BE) → reverse → [b0,b8,b16,b24] (LE)
 *
 * 注: 原典のマスク定数は 0xFF ではなく 0xFFFF だが、最後の `.toByte()` が下位 8bit へ切り詰めるため
 *   0xFFFF マスクの上位 8bit (bits 8..15) は捨てられ、出力は本実装の `& 0xFFn` と完全に等価。
 *
 * 結果は「秒値の下位 32bit を little-endian 4B」で詰めたものと等価。
 * `ushr` (符号なし右シフト) と各バイトの `.toByte()` 切り詰めにより、秒値が 32bit を超える
 * 遠未来でも自動的に下位 32bit だけが採られる (bits >=32 は b0 にも乗らない)。
 *
 * ★仕様上限: 秒値が 2^32 を超える遠未来 (>2106年, 約 0xFFFFFFFF 秒) では下位 32bit へ
 *   無言ラップする。これは SDK の toUInt32ByteArray() (Kotlin Long の ushr + 下位 8bit
 *   マスク) と一致する移植であり正しさの欠陥ではない。ただし登録時刻はデバイス側で時計
 *   照合される可能性があり、ラップ後の値で invalidParam 系を誘発し得る (デバイス側時刻
 *   検証がある場合の挙動は未検証)。配線時に留意。
 *
 * 固定 ms=1605929466482 → tmp=1605929466(=0x5FB889FA) → 戻り `fa89b85f`
 * (DataExtention.kt:139 のコメント "fa89b85f" と一致)。
 *
 * @param {number} [nowMs=Date.now()] エポックミリ秒 (非負整数)。
 * @returns {Buffer} 4B (秒値の下位 32bit を LE)
 */
export function registrationTimestampBytes(nowMs = Date.now()) {
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs) || nowMs < 0) {
    throw new Error(t("ble.timestampNonNeg", { ms: String(nowMs) }));
  }
  // Long 除算 (floor) を BigInt で再現。秒値は 53bit を超え得るため BigInt で扱う。
  const tmp = BigInt(Math.floor(nowMs)) / 1000n;
  const bytes = Buffer.alloc(4);
  // SDK と同じ添字割当 (.toByte() による下位 8bit マスクを 0xFFn で再現)。
  bytes[3] = Number(tmp & 0xffn);          // bits 0..7
  bytes[2] = Number((tmp >> 8n) & 0xffn);  // bits 8..15
  bytes[1] = Number((tmp >> 16n) & 0xffn); // bits 16..23
  bytes[0] = Number((tmp >> 24n) & 0xffn); // bits 24..31
  // reversedArray(): [b24,b16,b8,b0] → [b0,b8,b16,b24]
  return Buffer.from([bytes[3], bytes[2], bytes[1], bytes[0]]);
}

/**
 * REGISTRATION(1) コマンドの平文 data を組み立てる。
 *   data = EccKey.getPubK()(64B) ++ currentTimeMillis().toUInt32ByteArray()(4B) = 68B
 *   (CHHub3Device.kt:191-194)。
 *
 * これを buildSendFrame(ITEM.REGISTRATION, data) に通すと [01] ++ data = 69B フレームになり、
 * **PLAINTEXT セグメント** (SEG.PLAINTEXT) で送る (CHSesameOS3.kt:495-499: 送信フレームは
 * [item_code] ++ data で op_code は付与しない。registration は session 確立前なので暗号化せず平文)。
 *
 * pubK は ECDH 鍵ペア (crypto.js の createECDH("prime256v1")) の **生 P-256 公開鍵 X‖Y(64B)**。
 * SDK の EccKey.getPubK() は uncompressed prefix 0x04 を含まない 64B raw を返す (EccKey.kt の
 * fixheader 規約 / crypto.js:220-228 と同契約)。よってここは 64B/128hex のみを受け、Node の
 * getPublicKey() が既定で返す 0x04 付き 65B はそのまま渡せない (呼び出し側で剥がすこと)。
 *
 * ★配線状況 (2026-06 時点): registrationTimestampBytes と同様、この関数は登録フローに
 *   **配線済み**。session.register() (session.js:226) が
 *   `_sendPlain(buildSendFrame(ITEM.REGISTRATION, registrationData(pubK64, nowMs)))` で
 *   REGISTRATION(1) を PLAINTEXT 送出し、ファサード SesameBle.register()/registerOnce()
 *   から到達できる。mock vector でテスト済みだが**実機 OS3 検証は未了** (README 参照)。
 *
 * プロファイル分岐 (P1-6):
 *   - lock (既定): pubK64 ++ timestamp4 = 68B (CHHub3Device.kt:191-194 / CHSesameOS3LockBase.kt:93)
 *   - wm2        : **pubK64 のみ** = 64B — timestamp を付けない
 *                  (CHWifiModule2Device.kt:290: sendCommand(SesameOS3Payload(REGISTER_WM2,
 *                   EccKey.getPubK().hexStringToByteArray()), plain) — data は公開鍵 64B のみ)
 *
 * @param {Buffer|string} pubK ECDH 生公開鍵 64B (X‖Y, prefix 無し) または 128hex 文字列。
 * @param {number} [nowMs=Date.now()] エポックミリ秒 (registrationTimestampBytes へ委譲。wm2 では未使用)。
 * @param {"lock"|"wm2"} [profile="lock"]
 * @returns {Buffer} lock: 68B (pubK 64B ++ timestamp 4B) / wm2: 64B (pubK のみ)。
 */
export function registrationData(pubK, nowMs = Date.now(), profile = "lock") {
  assertProfile(profile);
  let pub;
  if (Buffer.isBuffer(pubK)) {
    pub = pubK;
  } else if (typeof pubK === "string") {
    if (!/^[0-9a-fA-F]+$/.test(pubK) || pubK.length % 2 !== 0) {
      throw new Error(t("ble.pubKMustBe64", { len: `${pubK.length}hex` }));
    }
    pub = Buffer.from(pubK, "hex");
  } else {
    throw new Error(t("ble.pubKMustBe64", { len: typeof pubK }));
  }
  if (pub.length !== 64) throw new Error(t("ble.pubKMustBe64", { len: `${pub.length}B` }));
  // wm2: 公開鍵のみ。timestamp は乗せない (CHWifiModule2Device.kt:290)。
  if (profile === "wm2") return Buffer.from(pub);
  // timestamp 4B は registrationTimestampBytes に委譲 (toUInt32ByteArray の唯一の実装箇所)。
  return Buffer.concat([pub, registrationTimestampBytes(nowMs)]);
}

// ---------- mechStatus 解析 (ssm.h:29-40, ssm.c:33-39) ----------

/** ロック状態。SESAME 5 (OS3) は施錠範囲フラグの有無の 2 値 (中間 "moved" は無い)。 */
export const MECH_STATE = Object.freeze({ LOCKED: "locked", UNLOCKED: "unlocked" });

/**
 * mech_status を OS3 デバイスの種別に応じて解析する。
 *
 * SDK は publish payload の **長さ** で具象 MechStatus クラスを選ぶ (CHSesame5Device.kt:213-218,
 * CHSesameBot2Device.kt:245-248)。それに倣い長さで分岐する:
 *
 *   7B = CHSesame5MechStatus (Sesame5/6 系ロック)
 *     data[0..1]: 電池電圧 ADC 生値 (LE。換算式は本体に無くサーバ側 → ここでは batteryRaw として返すのみ)
 *     data[2..3]: target   (i16 LE、-32768 は「未設定」→ null)
 *     data[4..5]: position (i16 LE)
 *     data[6]   : flags — bit1 isInLockRange / bit3 critical / bit4 stop / bit5 batteryCritical
 *   3B = CHSesameBot2MechStatus / CHSesameBike2MechStatus (Bot2/Bot3/Bike2/Bike3)
 *     data[0..1]: 電池電圧 ADC 生値 (LE)
 *     data[2]   : flags — bit1 isInLockRange / bit2 stop
 *     position/target は override されず interface 既定の 0 (CHDeivceProtocols.kt:334-351)
 *
 * 施錠/解錠は **isInLockRange の有無のみ** で判定する。OS3 に unlock-range ビットも中間 (moved) も無い
 * (CHSesame5.kt:24-32 / CHSesameBot2.kt:123-126: isInUnlockRange = !isInLockRange)。
 *
 * @param {Buffer} buf 3B (bot/bike) または 7B 以上 (lock)
 * @returns {{state:string, isInLockRange:boolean, target:number|null, position:number|null,
 *            isStop:boolean, isCritical:boolean|null, isBatteryCritical:boolean, batteryRaw:number, flags:number}}
 */
export function parseMechStatus(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error(t("ble.mechStatusMustBeBuffer"));
  if (buf.length === 3) return parseMechStatusBot(buf);
  if (buf.length >= 7) return parseMechStatusLock(buf);
  throw new Error(t("ble.mechStatusLength", { len: buf.length }));
}

/**
 * 7B: CHSesame5MechStatus 準拠 (Sesame5/6)。
 * @param {Buffer} buf
 */
function parseMechStatusLock(buf) {
  const batteryRaw = buf.readUInt16LE(0);
  const target = buf.readInt16LE(2);
  const position = buf.readInt16LE(4);
  const flags = buf[6];
  const isInLockRange = !!(flags & 0b0000_0010); // flags and 2
  return {
    state: isInLockRange ? MECH_STATE.LOCKED : MECH_STATE.UNLOCKED,
    isInLockRange,
    target: target === -32768 ? null : target,
    position,
    isCritical: !!(flags & 0b0000_1000),        // flags and 8
    isStop: !!(flags & 0b0001_0000),            // flags and 16
    isBatteryCritical: !!(flags & 0b0010_0000), // flags and 32
    batteryRaw,
    flags,
  };
}

/**
 * 3B: CHSesameBot2MechStatus / CHSesameBike2MechStatus 準拠 (Bot2/Bot3/Bike2/Bike3)。
 *
 * Bot2/Bike2 の MechStatus クラスは isInLockRange / isStop しか override しないため、
 * 他フィールドは CHSesameProtocolMechStatus の interface 既定値に落ちる
 * (CHDeivceProtocols.kt:334-351): position=0, target=0, isStop=null, isCritical=null,
 * isBatteryCritical=false。旧実装の position/target=null・isCritical=false は SDK 既定と
 * 不一致だった (BLE3-04)。
 * @param {Buffer} buf
 */
function parseMechStatusBot(buf) {
  const batteryRaw = buf.readUInt16LE(0);
  const flags = buf[2];
  const isInLockRange = !!(flags & 0b0000_0010); // flags and 2
  return {
    state: isInLockRange ? MECH_STATE.LOCKED : MECH_STATE.UNLOCKED,
    isInLockRange,
    // interface 既定 (CHDeivceProtocols.kt:335-338): position=0 / target=0。
    target: 0,
    position: 0,
    // interface 既定 (CHDeivceProtocols.kt:345-348): isCritical=null。
    isCritical: null,
    isStop: !!(flags & 0b0000_0100),            // flags and 4
    isBatteryCritical: false,                   // interface 既定 (CHDeivceProtocols.kt:339-340)
    batteryRaw,
    flags,
  };
}

// ---------- ネットワーク状態 bit フラグ (WM2 / Hub3 共通) ----------

/**
 * ネットワーク状態 publish の payload[0] bit フラグを解析する (WM2 / Hub3 共通)。
 *
 * 同一 bit layout を 2 箇所が使う:
 *   - WM2 : NETWORK_STATUS(6) publish (CHWifiModule2Device.kt:502-510)
 *   - Hub3: mechStatus(81) publish — Hub3 では 81 がロック機構状態ではなく
 *           CHWifiModule2NetWorkStatus として読まれる (CHHub3Device.kt:291-301)
 *
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
