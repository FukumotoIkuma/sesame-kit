// SESAME OS2 BLE プロトコル (SESAME2/3/4・初代 Bot・初代 Bike) — 純 JS のコア。
//
// 移植元 (1:1):
//   - references_android/.../ble/os2/CHSesame2Device.kt   (login / register / mechStatus)
//   - references_android/.../ble/os2/CHSesameBotDevice.kt  (bot login / mechStatus)
//   - references_android/.../ble/os2/CHSesameBikeDevice.kt (bike login / mechStatus)
//   - references_android/.../ble/os2/base/CHSesameOS2.kt   (SSM2Payload.toDataWithHeader)
//
// OS3 (src/ble/protocol.js) との差分:
//   - 送信フレームに **opCode を含む**: SSM2Payload.toDataWithHeader() = [opCode, itemCode] ++ data
//     (CHSesameOS2.kt:29-31)。OS3 は item_code ++ data のみ (op_code 付与なし)。
//   - login の session 鍵は **ECDH 由来**: sessionKey = CMAC(ecdhSecretPre16, sessionToken8)
//     (CHSesame2Device.kt:246-251)。OS3 通常 login は CMAC(secretKey, token4)。
//   - sessionToken は 8B (mAppToken4 ++ mSesameToken4)。
//   - sessionAuth = CMAC(secretKey, userIdx ++ appPubKey64 ++ sessionToken8) (CHSesame2Device.kt:238-243)。
//   - loginPayload = userIdx ++ appPubKey64 ++ mAppToken4 ++ sessionAuth[0:4] (CHSesame2Device.kt:252)。
//   - nonce/counter/tag は os2/cipher.js を参照 (5B counter + 8B token, 4B tag)。
//
// セグメント分割/結合 (DeviceSegmentType plain/cipher, 20B chunk, (type<<1)|startBit ヘッダ) は
// OS2/OS3 共通の BLE 下層 (SesameBleTransmit/SesameBleReceiver) なので、親 protocol.js の
// splitSegments/SegmentAssembler/SEG を再利用する (二重実装を避ける)。

/// <reference path="../../types/node-aes-cmac.d.ts" />
import { Buffer } from "node:buffer";
import { aesCmac } from "node-aes-cmac";
import { ITEM_CODES } from "../../itemcodes.js";
// セグメント下層・op コード・toUInt32ByteArray は OS2/OS3 共通。親 protocol.js を再利用 (編集はしない)。
// registrationTimestampBytes は SDK の Long.toUInt32ByteArray() (DataExtention.kt:138-147、
// ms を 1000 で割って秒にし LE 4B) の唯一の実装。OS2 timePhone もこれを使う。
import {
  OP, SEG, splitSegments, SegmentAssembler, RESULT, resultName, registrationTimestampBytes,
} from "../protocol.js";

export { OP, SEG, splitSegments, SegmentAssembler, RESULT, resultName };

/**
 * item_code (OS2/OS3 共通の正準ソース = itemcodes.js)。
 *
 * OS2 専用コード IRER(15) / TIMEPHONE(16) も itemcodes.js に昇格済みなので、ここは
 * ITEM_CODES をそのまま参照する (二重定義を避ける)。
 *   - IRER = 15      : 登録時の IR/ER 読み出し (SesameProtocols.kt:34)。
 *   - TIMEPHONE = 16 : login 後の時刻同期コマンド (SesameProtocols.kt:34、SesameItemCode.timePhone)。
 *     ★OS2 の時刻同期は TIME(8) ではなく timePhone(16)。CHSesame2Device.kt:263 は
 *       SesameItemCode.timePhone を使う (TIME(8) と混同しないこと)。
 */
export const ITEM = ITEM_CODES;

/**
 * CMAC の戻りを Buffer に正規化 (node-aes-cmac は環境により hex / Buffer を返す)。
 * @param {Buffer} key
 * @param {Buffer} msg
 * @returns {Buffer}
 */
function cmacBuf(key, msg) {
  const mac = aesCmac(key, msg, { returnAsBuffer: true });
  return Buffer.isBuffer(mac) ? mac : Buffer.from(mac, "hex");
}

/**
 * @param {Buffer|Uint8Array|string} v
 * @param {string} name
 * @returns {Buffer}
 */
function asBuf(v, name) {
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === "string") return Buffer.from(v, "hex");
  if (v instanceof Uint8Array) return Buffer.from(v);
  throw new Error(`${name} must be a Buffer / Uint8Array / hex string`);
}

// ---------- セッション鍵 / login (CHSesame2Device.kt:233-254) ----------

/**
 * OS2 の sessionToken (8B) = mAppToken(4B) ++ mSesameToken(4B)。
 * (CHSesame2Device.kt:237 / CHSesameBotDevice.kt:439)
 * @param {Buffer} mAppToken 4B (アプリ側ランダム、CHSesameOS2.kt:17 generateRandomData(4))
 * @param {Buffer} mSesameToken 4B (initial publish でデバイスが返すトークン)
 * @returns {Buffer} 8B
 */
export function sessionToken(mAppToken, mSesameToken) {
  const a = asBuf(mAppToken, "mAppToken");
  const s = asBuf(mSesameToken, "mSesameToken");
  if (a.length !== 4) throw new Error(`mAppToken must be 4 bytes (got ${a.length})`);
  if (s.length !== 4) throw new Error(`mSesameToken must be 4 bytes (got ${s.length})`);
  return Buffer.concat([a, s]);
}

/**
 * OS2 login の sessionKey (16B) を ECDH 共有秘密の先頭 16B から導出する。
 *   sessionKey = AES-128-CMAC(ecdhSecretPre16, sessionToken8)
 *   (CHSesame2Device.kt:246-248 / CHSesameBotDevice.kt:448-450 / CHSesameBikeDevice.kt:339-341)
 * @param {Buffer} ecdhSecretPre16 ECDH 共有秘密の先頭 16B (crypto.js:ecdhSecretPre16 の戻り)
 * @param {Buffer} sessionToken8 8B (sessionToken() の戻り)
 * @returns {Buffer} 16B
 */
export function deriveSessionKey(ecdhSecretPre16, sessionToken8) {
  const pre = asBuf(ecdhSecretPre16, "ecdhSecretPre16");
  if (pre.length !== 16) throw new Error(`ecdhSecretPre16 must be 16 bytes (got ${pre.length})`);
  if (!Buffer.isBuffer(sessionToken8) || sessionToken8.length !== 8) {
    throw new Error(`sessionToken must be 8 bytes (got ${Buffer.isBuffer(sessionToken8) ? sessionToken8.length : "non-buffer"})`);
  }
  return cmacBuf(pre, sessionToken8);
}

/**
 * OS2 login の sessionAuth (16B) をローカル secretKey から計算する (isNeedAuthFromServer=false 経路)。
 *   signPayload = userIdx ++ appPublicKey64 ++ sessionToken8
 *   sessionAuth = AES-128-CMAC(secretKey, signPayload)
 *   (CHSesame2Device.kt:238-243 / CHSesameBotDevice.kt:441-447 / CHSesameBikeDevice.kt:333-338)
 * サーバ認証 (isNeedAuthFromServer=true) の場合はサーバ署名 token を使うため呼ばない
 * (CHSesame2Device.kt:240-242)。
 * @param {Buffer} secretKey 16B (sesame2KeyData.secretKey)
 * @param {Buffer} userIdx keyIndex のバイト列 (sesame2KeyData.keyIndex)
 * @param {Buffer} appPublicKey64 アプリ ECDH 生公開鍵 64B (X‖Y, prefix 無し)
 * @param {Buffer} sessionToken8 8B
 * @returns {Buffer} 16B (loginPayload では先頭 4B のみ使用)
 */
export function sessionAuth(secretKey, userIdx, appPublicKey64, sessionToken8) {
  const key = asBuf(secretKey, "secretKey");
  if (key.length !== 16) throw new Error(`secretKey must be 16 bytes (got ${key.length})`);
  const idx = asBuf(userIdx, "userIdx");
  const pub = asBuf(appPublicKey64, "appPublicKey64");
  if (pub.length !== 64) throw new Error(`appPublicKey64 must be 64 bytes (X‖Y, got ${pub.length})`);
  if (!Buffer.isBuffer(sessionToken8) || sessionToken8.length !== 8) {
    throw new Error(`sessionToken must be 8 bytes (got ${Buffer.isBuffer(sessionToken8) ? sessionToken8.length : "non-buffer"})`);
  }
  const signPayload = Buffer.concat([idx, pub, sessionToken8]);
  return cmacBuf(key, signPayload);
}

/**
 * OS2 login コマンドの平文 data を組み立てる。
 *   data = userIdx ++ appPublicKey64 ++ mAppToken4 ++ sessionAuth[0:4]
 *   (CHSesame2Device.kt:252 / CHSesameBotDevice.kt:451 / CHSesameBikeDevice.kt:342)
 * これを buildSendFrame(OP.SYNC, ITEM.LOGIN, data) でフレーム化し PLAINTEXT 送出する
 * (CHSesame2Device.kt:254-255: SSM2OpCode.sync, SesameItemCode.login, DeviceSegmentType.plain)。
 * @param {Buffer} userIdx
 * @param {Buffer} appPublicKey64 64B
 * @param {Buffer} mAppToken4 4B
 * @param {Buffer} sessionAuth16 sessionAuth() の戻り (先頭 4B のみ使用)
 * @returns {Buffer}
 */
export function loginPayload(userIdx, appPublicKey64, mAppToken4, sessionAuth16) {
  const idx = asBuf(userIdx, "userIdx");
  const pub = asBuf(appPublicKey64, "appPublicKey64");
  const app = asBuf(mAppToken4, "mAppToken4");
  const auth = asBuf(sessionAuth16, "sessionAuth16");
  if (pub.length !== 64) throw new Error(`appPublicKey64 must be 64 bytes (got ${pub.length})`);
  if (app.length !== 4) throw new Error(`mAppToken4 must be 4 bytes (got ${app.length})`);
  if (auth.length < 4) throw new Error(`sessionAuth must be >= 4 bytes (got ${auth.length})`);
  return Buffer.concat([idx, pub, app, auth.subarray(0, 4)]);
}

// ---------- 登録 (registration) 鍵導出 (CHSesame2Device.kt:445-456) ----------

/**
 * OS2 登録ハンドシェイクの鍵束を ECDH 共有秘密とトークンから導出する。
 *   sessionToken = serverToken ++ mSesameToken          (CHSesame2Device.kt:451)
 *   registerKey  = CMAC(ecdhSecretPre16, sessionToken)  (CHSesame2Device.kt:452)
 *   ownerKey     = CMAC(registerKey, "owner_key")       (CHSesame2Device.kt:453)
 *   sessionKey   = CMAC(registerKey, sessionToken)      (CHSesame2Device.kt:454)
 * sessionKey/sessionToken で cipher を確立し (os2/cipher.js)、REGISTRATION 応答以降を暗号化する。
 * ownerKey は登録完了後に保存する device の鍵 (CHSesame2Device.kt:462-471 CHDevice の owner_key)。
 *
 * 注: registration の sessionToken は **serverToken(可変長) ++ mSesameToken(4B)** で、login の
 * sessionToken (mAppToken4 ++ mSesameToken4 = 8B) とは構造が異なる。cipher の nonce が要求する
 * 8B は「login 経路」の制約で、registration 経路の sessionToken 長は serverToken に依存する
 * (SDK では serverToken は server が返す。本実装は SDK のバイト連結をそのまま再現する)。
 *
 * @param {Buffer} ecdhSecretPre16 16B
 * @param {Buffer} serverToken サーバが返すトークン (registerSesame1.st)
 * @param {Buffer} mSesameToken 4B (initial publish のトークン)
 * @returns {{registerKey:Buffer, ownerKey:Buffer, sessionKey:Buffer, sessionToken:Buffer}}
 */
export function deriveRegisterKeys(ecdhSecretPre16, serverToken, mSesameToken) {
  const pre = asBuf(ecdhSecretPre16, "ecdhSecretPre16");
  if (pre.length !== 16) throw new Error(`ecdhSecretPre16 must be 16 bytes (got ${pre.length})`);
  const srv = asBuf(serverToken, "serverToken");
  const ssm = asBuf(mSesameToken, "mSesameToken");
  if (ssm.length !== 4) throw new Error(`mSesameToken must be 4 bytes (got ${ssm.length})`);
  const stoken = Buffer.concat([srv, ssm]);
  const registerKey = cmacBuf(pre, stoken);
  const ownerKey = cmacBuf(registerKey, Buffer.from("owner_key", "utf8"));
  const sessionKey = cmacBuf(registerKey, stoken);
  return { registerKey, ownerKey, sessionKey, sessionToken: stoken };
}

/**
 * OS2 REGISTRATION コマンドの平文 data を組み立てる。
 *   payload = sig1[0:4] ++ appPublicKey64 ++ serverToken   (CHSesame2Device.kt:447)
 * buildSendFrame(OP.CREATE, ITEM.REGISTRATION, payload) で PLAINTEXT 送出
 * (CHSesame2Device.kt:449,458: SSM2OpCode.create, registration, DeviceSegmentType.plain)。
 * @param {Buffer} sig1 サーバ署名 (registerSesame1.sig1)。先頭 4B のみ使用。
 * @param {Buffer} appPublicKey64 64B
 * @param {Buffer} serverToken サーバトークン (registerSesame1.st)
 * @returns {Buffer}
 */
export function registrationData(sig1, appPublicKey64, serverToken) {
  const s = asBuf(sig1, "sig1");
  const pub = asBuf(appPublicKey64, "appPublicKey64");
  const srv = asBuf(serverToken, "serverToken");
  if (s.length < 4) throw new Error(`sig1 must be >= 4 bytes (got ${s.length})`);
  if (pub.length !== 64) throw new Error(`appPublicKey64 must be 64 bytes (got ${pub.length})`);
  return Buffer.concat([s.subarray(0, 4), pub, srv]);
}

// ---------- フレーム build / parse (CHSesameOS2.kt:28-32) ----------

/**
 * OS2 送信フレーム = [op_code, item_code] ++ data。
 * SDK SSM2Payload.toDataWithHeader() (CHSesameOS2.kt:29-31) を 1:1 で移植。
 * ★OS3 との最大の差: OS2 は op_code をフレーム先頭に **含める**。
 * @param {number} opCode OP.* (sync/create/read/update/async など)
 * @param {number} itemCode ITEM.*
 * @param {Buffer} [data]
 * @returns {Buffer}
 */
export function buildSendFrame(opCode, itemCode, data = Buffer.alloc(0)) {
  return Buffer.concat([Buffer.from([opCode & 0xff, itemCode & 0xff]), data]);
}

/**
 * 受信フレーム (復号後 or 平文) を分解。
 * SesameNotifypayload (notifyOpCode=buf[0], payload=buf[1:]) → SSM2ResponsePayload / SSM3PublishPayload。
 *   notify[0]      = notifyOpCode (response=7 / publish=8)
 *   response body  = [cmdOpCode, cmdItemCode, cmdResultCode, ...payload]
 *   publish  body  = [cmdItemCode, ...payload]
 * 親 OS3 protocol.parseRecvFrame は op+item の 2B ヘッダだったが、OS2 は notify 種別で構造が
 * 変わる (response は 3B ヘッダ、publish は 1B ヘッダ) ため OS2 専用に分解する。
 *
 * @param {Buffer} buf notify ペイロード全体 (SesameNotifypayload 入力)
 * @returns {{notifyOpCode:number} & ({type:"response", cmdOpCode:number, itemCode:number,
 *            resultCode:number, payload:Buffer} | {type:"publish", itemCode:number, payload:Buffer}
 *            | {type:"other", body:Buffer})}
 */
export function parseRecvFrame(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 1) throw new Error("OS2 frame too short");
  const notifyOpCode = buf[0];
  const body = buf.subarray(1);
  if (notifyOpCode === OP.RESPONSE) {
    // SSM2ResponsePayload: cmdOPCode=body[0], cmdItCode=body[1], cmdResultCode=body[2], payload=body[3:]
    if (body.length < 3) throw new Error("OS2 response frame too short");
    return {
      notifyOpCode,
      type: "response",
      cmdOpCode: body[0],
      itemCode: body[1],
      resultCode: body[2],
      payload: body.subarray(3),
    };
  }
  if (notifyOpCode === OP.PUBLISH) {
    // SSM3PublishPayload: cmdItCode=body[0], payload=body[1:]
    if (body.length < 1) throw new Error("OS2 publish frame too short");
    return { notifyOpCode, type: "publish", itemCode: body[0], payload: body.subarray(1) };
  }
  return { notifyOpCode, type: "other", body };
}

// ---------- 各コマンドの data 生成 ----------

/**
 * lock/unlock/click/toggle の history tag data。
 * SDK の sesame2KeyData.createHistag(historytag) (CHDBModel.kt) はタグ種別ヘッダ無しで
 * historyTag をそのまま (なければ空) 送る (OS2 lock/unlock/click は createHistag(tag) を data に渡す:
 * CHSesame2Device.kt:185,201 / CHSesameBotDevice.kt:370,408)。
 * tag 省略時は空バイト列。
 * @param {Buffer|Uint8Array} [tag] 履歴タグ (バイト列)
 * @returns {Buffer}
 */
export function historyTag(tag) {
  if (tag == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(tag) || tag instanceof Uint8Array) return Buffer.from(tag);
  throw new Error("historyTag: pass tag as Buffer/Uint8Array");
}

/**
 * SDK の createHistag(histag) (CHDBModel.kt:18-23) を 1:1 で移植する。
 *   limitedHistag = histag.take(21)                       // 先頭 21B に切り詰め
 *   padding       = 22 - limitedHistag.size - 1           // 全長 22B に 0 埋め
 *   結果          = [size:1B] ++ limitedHistag ++ 0*padding  // 常に 22B
 * tag 省略 (null) 時は size=0、本体 0B、padding=21 → [0x00] ++ 0*21 = 22B の全 0。
 *
 * ★lock/unlock/click の historyTag() (ヘッダ無し raw 透過) とは別物。
 *   configureLockPosition / Bot updateSetting は SDK 上 createHistag(...) を連結する
 *   (CHSesame2Device.kt:557 / CHSesameBotDevice.kt:421-422) ため、この 22B 構造を使う。
 * @param {Buffer|Uint8Array|null} [tag] 履歴タグ (バイト列)。省略/null 時は全 0 の 22B。
 * @returns {Buffer} 常に 22B
 */
export function createHistag(tag) {
  let src;
  if (tag == null) src = Buffer.alloc(0);
  else if (Buffer.isBuffer(tag) || tag instanceof Uint8Array) src = Buffer.from(tag);
  else throw new Error("createHistag: pass tag as Buffer/Uint8Array");
  const limited = src.subarray(0, 21); // histag.take(21)
  const out = Buffer.alloc(22);        // [size] ++ limited ++ padding (全長 22B、未使用は 0)
  out[0] = limited.length;
  limited.copy(out, 1);
  return out;
}

/**
 * SESAME2/3/4 の施錠/解錠角設定ペイロードを生成する (CHSesameLockPositionConfiguration:635-645)。
 *
 * SDK は度数 (lockTarget/unlockTarget) を内部単位へ変換する:
 *   tick = (deg * 1024 / 360).toShort()  (CHSesame2Device.kt:557 — Int 演算後に Short へ)
 * その tick から ±150 の range を作り、すべて Short の LE 2B (toReverseBytes、DataExtention.kt:108-112) で連結:
 *   payload = lock ++ unlock ++ lockMin ++ lockMax ++ unlockMin ++ unlockMax   (各 2B LE、計 12B)
 *   lockMin/Max   = lock   ∓150 / ±150
 *   unlockMin/Max = unlock ∓150 / ±150   (toPayload:642-643)
 *
 * range の加減算 (lock-150 等) は SDK 同様 16bit でラップする (Short 演算) ため writeInt16LE で
 * 切り詰める。configureLockPosition の送信 data はこの 12B に createHistag(null) を連結する
 * (CHSesame2Device.kt:557)。
 *
 * @param {number} lockDeg   施錠角 (度、SDK 引数 lockTarget: Short)
 * @param {number} unlockDeg 解錠角 (度、SDK 引数 unlockTarget: Short)
 * @returns {Buffer} 12B (lock/unlock/lockMin/lockMax/unlockMin/unlockMax の LE Short 列)
 */
export function lockPositionConfiguration(lockDeg, unlockDeg) {
  if (!Number.isInteger(lockDeg) || !Number.isInteger(unlockDeg)) {
    throw new Error("lockDeg / unlockDeg must be integers (degrees)");
  }
  const RANGE = 150; // CHSesameLockPositionConfiguration.range (:636)
  // (deg * 1024 / 360) を Int 演算 → Short へ (Kotlin の Int.toShort() = 下位 16bit)。
  const toTick = (/** @type {number} */ deg) => toShort(Math.trunc((deg * 1024) / 360));
  const lock = toTick(lockDeg);
  const unlock = toTick(unlockDeg);
  // 各 range は Short 演算でラップ (lock-150 など)。writeInt16LE が下位 16bit を LE で書く。
  const shorts = [
    lock,
    unlock,
    toShort(lock - RANGE),
    toShort(lock + RANGE),
    toShort(unlock - RANGE),
    toShort(unlock + RANGE),
  ];
  const out = Buffer.alloc(12);
  for (let i = 0; i < shorts.length; i++) out.writeInt16LE(shorts[i], i * 2);
  return out;
}

/**
 * SESAME2/3/4 configureLockPosition の送信 data を組み立てる (CHSesame2Device.kt:556-558)。
 *   payload = lockPositionConfiguration(...) ++ createHistag(null)   (12B ++ 22B = 34B)
 * buildSendFrame(OP.UPDATE, ITEM.MECH_SETTING, ...) で送る (item=80)。
 * @param {number} lockDeg   施錠角 (度)
 * @param {number} unlockDeg 解錠角 (度)
 * @returns {Buffer} 34B
 */
export function lockPositionData(lockDeg, unlockDeg) {
  return Buffer.concat([lockPositionConfiguration(lockDeg, unlockDeg), createHistag(null)]);
}

/**
 * @typedef {object} BotMechSetting 初代 SESAME Bot の mech_setting フィールド (各値 -128..255 の 1B)。
 * @property {number} userPrefDir
 * @property {number} lockSec
 * @property {number} unlockSec
 * @property {number} clickLockSec
 * @property {number} clickHoldSec
 * @property {number} clickUnlockSec
 * @property {number} buttonMode
 */

/**
 * 初代 SESAME Bot の mech_setting ペイロードを生成する (CHSesameBotMechSettings.data(), CHSesameBot.kt:17-20)。
 *   data = [userPrefDir, lockSec, unlockSec, clickLockSec, clickHoldSec, clickUnlockSec, buttonMode]
 *          ++ [0,0,0,0,0]   // 5B の予約 0 埋め (計 12B)
 * 各値は符号付き Byte (-128..127) として 1B で書く (Kotlin Byte)。
 * @param {BotMechSetting} setting
 * @returns {Buffer} 12B
 */
export function botMechSettingData(setting) {
  if (setting == null || typeof setting !== "object") throw new Error("botMechSettingData: setting object required");
  /** @type {(keyof BotMechSetting)[]} */
  const fields = ["userPrefDir", "lockSec", "unlockSec", "clickLockSec", "clickHoldSec", "clickUnlockSec", "buttonMode"];
  const out = Buffer.alloc(12); // 7B 本体 ++ 5B (0,0,0,0,0)
  for (let i = 0; i < fields.length; i++) {
    const v = setting[fields[i]];
    if (!Number.isInteger(v) || v < -128 || v > 255) {
      throw new Error(`botMechSettingData.${fields[i]} must be an integer byte (-128..255), got ${v}`);
    }
    out[i] = v & 0xff;
  }
  return out;
}

/**
 * 初代 SESAME Bot updateSetting の送信 data を組み立てる (CHSesameBotDevice.kt:418-422)。
 *   data = setting.data() ++ createHistag(historyTag)   (12B ++ 22B = 34B)
 * buildSendFrame(OP.UPDATE, ITEM.MECH_SETTING, ...) で送る (item=80)。
 * @param {BotMechSetting} setting botMechSettingData の引数
 * @param {Buffer|Uint8Array} [tag] 履歴タグ
 * @returns {Buffer} 34B
 */
export function botUpdateSettingData(setting, tag) {
  return Buffer.concat([botMechSettingData(setting), createHistag(tag)]);
}

/**
 * Kotlin の Int.toShort() / Short 演算ラップを再現する (下位 16bit を符号付き Short に解釈)。
 * lock-150 等が 16bit を跨ぐ場合に SDK と同じ値にする。
 * @param {number} n
 * @returns {number} -32768..32767
 */
function toShort(n) {
  const v = ((n % 0x10000) + 0x10000) % 0x10000; // 下位 16bit (unsigned)
  return v >= 0x8000 ? v - 0x10000 : v;          // 符号付き化
}

/**
 * BLE DFU (ファームウェア更新) 開始コマンドの data。
 * SDK updateFirmware は enableDFU(7) に "01" (1B) を送る (CHSesame2Device.kt:580-599)。
 * 登録済み (login 済み) なら暗号化、未登録なら平文で送る。本実装は **開始コマンド送信まで**を
 * 担い、本体ファーム転送 (Nordic DFU 等の OTA バイナリ転送) は別 GATT サービスを扱う外部 DFU 層の責務。
 * @returns {Buffer} 1B (0x01)
 */
export function enableDfuData() {
  return Buffer.from([0x01]);
}

/**
 * autolock の data = 2B LE 秒数 (delay.toShort().toReverseBytes()) ++ historyTag。
 * (CHSesame2Device.kt:141: SSM2OpCode.update, autolock, delay.toShort().toReverseBytes() ++ createHistag)
 * 0 で無効化 (disableAutolock = enableAutolock(0), CHSesame2Device.kt:151)。
 * @param {number} seconds 0..65535
 * @param {Buffer|Uint8Array} [tag] 履歴タグ
 * @returns {Buffer}
 */
export function autolockData(seconds, tag) {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 0xffff) {
    throw new Error("seconds must be an integer 0..65535 (0 = disable)");
  }
  const b = Buffer.alloc(2);
  b.writeUInt16LE(seconds);
  return Buffer.concat([b, historyTag(tag)]);
}

// ---------- mechStatus 解析 (OS2) ----------

/** OS2 ロック状態。Sesame2/3/4 は施錠/解錠範囲フラグに加え中間 (moved) を持つ。 */
export const MECH_STATE = Object.freeze({ LOCKED: "locked", UNLOCKED: "unlocked", MOVED: "moved" });

/**
 * OS2 の mech_status を解析する。
 *
 * SESAME2/3/4 (CHSesame2MechStatus) — 8B mech_status_t (CHSesame2Device.kt:631 mech_status_t = [20..27]):
 *   data[0..1]: 電池電圧 ADC 生値 (LE)
 *   data[2..3]: target   (i16 LE、Short.MIN_VALUE=-32768 は「未設定」→ null。CHSesame2Device.kt:548)
 *   data[4..5]: position (i16 LE)
 *   data[6]   : flags  (bit1 isInLockRange / bit2 isInUnlockRange / ほか SDK CHSesame2MechStatus)
 *   data[7]   : retCode (0 以外は履歴読み出しトリガ。CHSesame2Device.kt:545)
 *
 * Bot/Bike (CHSesameBotMechStatus) — 7B mech_status_t:
 *   data[0..1]: 電池電圧 ADC 生値 (LE)
 *   data[2..3]: target   (i16 LE)
 *   data[4..5]: position (i16 LE)  ※Bot は motorStatus を含む実装だが lock-range 判定は flags で行う
 *   data[6]   : flags (bit1 isInLockRange / bit2 isInUnlockRange)
 *
 * 施錠/解錠/中間は isInLockRange / isInUnlockRange の 2 ビットで判定する
 * (CHSesame2Device.kt:551 / CHSesameBikeDevice.kt:299: lock / unlock / else=moved)。
 *
 * @param {Buffer} buf mech_status_t (7B or 8B)
 * @returns {{state:string, isInLockRange:boolean, isInUnlockRange:boolean,
 *            target:number|null, position:number|null, batteryRaw:number, retCode:number|null, flags:number}}
 */
export function parseMechStatus(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error("mechStatus must be a Buffer");
  if (buf.length < 7) throw new Error(`OS2 mechStatus must be >= 7 bytes (got ${buf.length})`);
  const batteryRaw = buf.readUInt16LE(0);
  const target = buf.readInt16LE(2);
  const position = buf.readInt16LE(4);
  const flags = buf[6];
  const retCode = buf.length >= 8 ? buf[7] : null;
  const isInLockRange = !!(flags & 0b0000_0010);   // flags and 2
  const isInUnlockRange = !!(flags & 0b0000_0100); // flags and 4
  const state = isInLockRange ? MECH_STATE.LOCKED : (isInUnlockRange ? MECH_STATE.UNLOCKED : MECH_STATE.MOVED);
  return {
    state,
    isInLockRange,
    isInUnlockRange,
    target: target === -32768 ? null : target,
    position,
    batteryRaw,
    retCode,
    flags,
  };
}

/**
 * OS2 login 応答ペイロードを解析する。
 * SSM2LoginResponsePayload (CHSesame2Device.kt:626-634) / SSMBotLoginResponsePayload
 * (CHSesameBikeDevice.kt:513-521) を 1:1 で移植。
 *   payload[0..3] : systemTime (BE, toBigLong)
 *   payload[4]    : fw_version
 *   payload[6]    : historyCnt
 *   payload[8..19]: mech_setting_t (12B)
 *   payload[20..27]: mech_status_t (8B、Sesame2)。Bot/Bike も同レイアウトを使用。
 * @param {Buffer} payload login response の payload (resultCode は含まない)
 * @returns {{systemTime:number, fwVersion:number, historyCnt:number,
 *            mechSetting:Buffer, mechStatus:object}}
 */
export function parseLoginResponse(payload) {
  if (!Buffer.isBuffer(payload) || payload.length < 28) {
    throw new Error(`OS2 login response must be >= 28 bytes (got ${Buffer.isBuffer(payload) ? payload.length : "non-buffer"})`);
  }
  const systemTime = payload.readUInt32BE(0); // toBigLong (BE)
  const fwVersion = payload[4];
  const historyCnt = payload[6];
  const mechSetting = Buffer.from(payload.subarray(8, 20)); // mech_setting_t 12B
  const mechStatusBytes = Buffer.from(payload.subarray(20, 28)); // mech_status_t 8B
  return {
    systemTime,
    fwVersion,
    historyCnt,
    mechSetting,
    mechStatus: parseMechStatus(mechStatusBytes),
  };
}

/**
 * timePhone (時刻同期) コマンドの data = currentTimeMillis().toUInt32ByteArray() (4B LE)。
 * login 後に時刻差が大きい場合に送る (CHSesame2Device.kt:263 / CHSesameBotDevice.kt:280,466)。
 *
 * ★SDK の toUInt32ByteArray() (DataExtention.kt:138-147) は **ms を 1000 で割って秒値**にし、
 *   その下位 32bit を LE 4B にする (固定 ms=1605929466482 → 秒 1605929466 → "fa89b85f")。
 *   ms をそのまま使わない点に注意 (login response の systemTime も同じく「秒」)。
 *   この変換は親 protocol.js:registrationTimestampBytes が唯一の実装なので委譲する
 *   (toUInt32ByteArray の実装が分散して仕様がズレるのを防ぐ)。
 * @param {number} [nowMs=Date.now()]
 * @returns {Buffer} 4B LE (秒値の下位 32bit)
 */
export function timePhoneData(nowMs = Date.now()) {
  return registrationTimestampBytes(nowMs);
}
