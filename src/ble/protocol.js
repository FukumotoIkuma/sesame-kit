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
import { aesCmac } from "node-aes-cmac";
import { ITEM_CODES } from "../itemcodes.js";

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
});

/** item_code。クラウドと共通の正準ソース (src/itemcodes.js) を参照する (重複定義を避ける)。 */
export const ITEM = ITEM_CODES;

/** セグメントの parsing type (candy.h:44-46 / SesameBleReceiver.kt:5)。ヘッダ = (type<<1) | startBit。 */
export const SEG = Object.freeze({ APPEND_ONLY: 0, PLAINTEXT: 1, CIPHERTEXT: 2 });

/**
 * SESAME OS3 デバイスがコマンド応答 (response 0x07) の先頭バイトで返す結果コード。
 * 出典: 公式 SesameSDK `enum SesameResultCode: UInt8`
 *   (references_ios/Sources/SesameSDK/Ble/CHDeviceProtocol.swift:195)。
 * これは **デバイス層 (SesameOS3) の taxonomy** で BLE/WM2 で共通。クラウド (biz3) 経路は
 * この code を surface しないため、利用できるのは BLE 直接経路のみ。
 */
export const RESULT = Object.freeze({
  0: "success", 1: "invalidFormat", 2: "notSupported", 3: "resultStorageFail",
  4: "invalidSig", 5: "notFound", 6: "unknown", 7: "busy", 8: "invalidParam", 9: "invalidAction",
});

/** 結果コード → 名前 (未知は unknown(N))。 */
export function resultName(code) {
  return RESULT[code] || `unknown(${code})`;
}

const CCM_TAG_LEN = 4; // candy.h:42
const MAX_CHUNK_DATA = 19; // 20B パケット - ヘッダ1B (ssm.c:112-127)

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
  if (key.length !== 16) throw new Error(`secretKey must be 16 bytes (got ${key.length})`);
  if (!Buffer.isBuffer(token) || token.length !== 4) throw new Error("token must be a 4-byte Buffer");
  const mac = aesCmac(key, token, { returnAsBuffer: true });
  return Buffer.isBuffer(mac) ? mac : Buffer.from(mac, "hex");
}

/**
 * login コマンドの平文ペイロード = [LOGIN(2)] ++ token16[0:4] (ssm_cmd.c:44-45 / CHSesameOS3LockBase.kt:118-120)。
 * PLAINTEXT セグメントで送る。
 * @param {Buffer} token16 deriveSessionKey の戻り
 * @returns {Buffer} 5B
 */
export function loginPayload(token16) {
  return Buffer.concat([Buffer.from([ITEM.LOGIN]), token16.subarray(0, 4)]);
}

// ---------- AES-128-CCM (c_ccm.c, ssm.c:80-82/100-104) ----------

/**
 * CCM nonce (13B) = count(8B LE) ++ 0x00 ++ token(4B)。
 * (ssm.h:17-21 / SesameOS3BleCipher.kt:13 + sault=0x00++token)
 */
function ccmNonce(count, token4) {
  const c = Buffer.alloc(8);
  c.writeBigUInt64LE(BigInt(count));
  return Buffer.concat([c, Buffer.from([0x00]), token4]);
}

const CCM_AAD = Buffer.from([0x00]); // ssm.c:8

/**
 * コマンド平文を CCM 暗号化し、末尾に 4B tag を付けて返す。
 * @param {Buffer} token16 セッション鍵
 * @param {number|bigint} count 送信カウンタ (送信ごと +1)
 * @param {Buffer} token4 initial token
 * @param {Buffer} plaintext 暗号化前フレーム ([item, ...data])
 * @returns {Buffer} ciphertext ++ tag(4B)
 */
export function ccmEncrypt(token16, count, token4, plaintext) {
  const iv = ccmNonce(count, token4);
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
 * @returns {Buffer} 復号平文
 */
export function ccmDecrypt(token16, count, token4, ctWithTag) {
  if (ctWithTag.length < CCM_TAG_LEN) throw new Error("ciphertext too short (no tag)");
  const iv = ccmNonce(count, token4);
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
  constructor() { this._buf = []; }

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
  if (buf.length < 2) throw new Error("frame too short");
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
  else throw new Error("historyTagBLE: tag は Buffer/Uint8Array で渡してください (type 0x000E は UUID バイト列を想定)");
  return Buffer.concat([Buffer.from([0x00, 0x0e]), tagBuf]).subarray(0, 20);
}

/**
 * autolock の data = 2B LE 秒数 (delay.toShort().toReverseBytes()、CHSesame5Device.kt:96-105)。0=無効。
 * @param {number} seconds 0..65535
 * @returns {Buffer} 2B
 */
export function autolockData(seconds) {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 0xffff) {
    throw new Error("seconds must be an integer 0..65535 (0 = disable)");
  }
  const b = Buffer.alloc(2);
  b.writeUInt16LE(seconds);
  return b;
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
 *     position/target の概念なし (null)
 *
 * 施錠/解錠は **isInLockRange の有無のみ** で判定する。OS3 に unlock-range ビットも中間 (moved) も無い
 * (CHSesame5.kt:24-32 / CHSesameBot2.kt:123-126: isInUnlockRange = !isInLockRange)。
 *
 * @param {Buffer} buf 3B (bot/bike) または 7B 以上 (lock)
 * @returns {{state:string, isInLockRange:boolean, target:number|null, position:number|null,
 *            isStop:boolean, isCritical:boolean, isBatteryCritical:boolean, batteryRaw:number, flags:number}}
 */
export function parseMechStatus(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error("mechStatus must be a Buffer");
  if (buf.length === 3) return parseMechStatusBot(buf);
  if (buf.length >= 7) return parseMechStatusLock(buf);
  throw new Error(`mechStatus は 3B (bot/bike) か 7B 以上 (lock) を想定 (got ${buf.length}B)`);
}

/** 7B: CHSesame5MechStatus 準拠 (Sesame5/6)。 */
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

/** 3B: CHSesameBot2MechStatus / CHSesameBike2MechStatus 準拠 (Bot2/Bot3/Bike2/Bike3)。 */
function parseMechStatusBot(buf) {
  const batteryRaw = buf.readUInt16LE(0);
  const flags = buf[2];
  const isInLockRange = !!(flags & 0b0000_0010); // flags and 2
  return {
    state: isInLockRange ? MECH_STATE.LOCKED : MECH_STATE.UNLOCKED,
    isInLockRange,
    target: null,
    position: null,
    isCritical: false,
    isStop: !!(flags & 0b0000_0100),            // flags and 4
    isBatteryCritical: false,
    batteryRaw,
    flags,
  };
}
