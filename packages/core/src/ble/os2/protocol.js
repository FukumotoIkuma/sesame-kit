// SESAME OS2 BLE プロトコル (SESAME2/3/4・初代 Bot・初代 Bike) — 純 JS のコア。
//
// 移植元 (1:1):
//   - _sesame_sdk_ref/sesame-sdk/.../ble/os2/CHSesame2Device.kt   (login / register / mechStatus)
//   - _sesame_sdk_ref/sesame-sdk/.../ble/os2/CHSesameBotDevice.kt  (bot login / mechStatus)
//   - _sesame_sdk_ref/sesame-sdk/.../ble/os2/CHSesameBikeDevice.kt (bike login / mechStatus)
//   - _sesame_sdk_ref/sesame-sdk/.../ble/os2/base/CHSesameOS2.kt   (SSM2Payload.toDataWithHeader)
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

import { Buffer } from "node:buffer";
// AES-CMAC は内製実装 (RFC 4493 準拠, src/aes-cmac.js)。旧 node-aes-cmac は無メンテ +
// deprecated Buffer コンストラクタ使用のため置き換えた (REFACTORING_PLAN P5-2)。
import { aesCmac } from "../../aes-cmac.js";
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

// 注: 旧 node-aes-cmac の hex/Buffer 揺れを吸収していた cmacBuf ラッパは、内製 aesCmac
// (src/aes-cmac.js) が常に 16B Buffer を返すため不要となり削除した (P5-2)。

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
 *
 * mSesameToken は initial publish payload の全長をそのまま渡すこと (_handleInitial で確認済み)。
 * 実ファームウェアは必ず 4B を送る (CHSesame2Device.kt:519 で切り詰めなく格納)。
 * 4B 以外が来た場合はここで明示エラーを出す (session.js _handleInitial が先に reject する)。
 *
 * @param {Buffer} mAppToken 4B (アプリ側ランダム、CHSesameOS2.kt:17 generateRandomData(4))
 * @param {Buffer} mSesameToken 4B (initial publish payload の全長: CHSesame2Device.kt:519 参照)
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
  return aesCmac(pre, sessionToken8);
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
  return aesCmac(key, signPayload);
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
 * 注: registration の sessionToken は **serverToken(4B) ++ mSesameToken(4B) = 8B 固定** である。
 * serverToken は CHServerAuth.kt:54 の `val serverToken = ByteArray(4)` が示すとおり常に 4B。
 * したがって sessionToken = 4B + 4B = 8B となり、login 経路の sessionToken
 * (mAppToken4 ++ mSesameToken4 = 8B) と同じ長さになる。
 * cipher.js の SesameOS2BleCipher コンストラクタが要求する 8B 検証は登録・ログイン両経路で満たされる。
 * SesameOS2BleCipher.kt:7 はコンストラクタで長さ検証をしていないが、CCM nonce = counter5B ++ token
 * の制約(nonce 上限 13B)から token ≤ 8B が必要であり、4B+4B=8B は最大値を使い切る正準形である。
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
  const registerKey = aesCmac(pre, stoken);
  const ownerKey = aesCmac(registerKey, Buffer.from("owner_key", "utf8"));
  const sessionKey = aesCmac(registerKey, stoken);
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
 *   response body  = [cmdItemCode, cmdOpCode, cmdResultCode, ...payload]   (SesameProtocols.kt:15-19)
 *   publish  body  = [cmdItemCode, ...payload]                             (SesameProtocols.kt:5-8)
 * 親 OS3 protocol.parseRecvFrame は op+item の 2B ヘッダだったが、OS2 は notify 種別で構造が
 * 変わる (response は 3B ヘッダ、publish は 1B ヘッダ) ため OS2 専用に分解する。
 * ★response は **itemCode が先頭** (cmdItCode=data[0], cmdOPCode=data[1])。送信フレーム
 *   (toDataWithHeader = [opCode, itemCode]) とは順序が逆である点に注意。
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
    // SSM2ResponsePayload: cmdItCode=body[0], cmdOPCode=body[1], cmdResultCode=body[2], payload=body[3:]
    // (SesameProtocols.kt:15-19。itemCode が先、opCode が後。応答ルーティングのキーは itemCode)。
    if (body.length < 3) throw new Error("OS2 response frame too short");
    return {
      notifyOpCode,
      type: "response",
      itemCode: body[0],
      cmdOpCode: body[1],
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
 * SDK の createHistag(histag) (CHDBModel.kt:18-23) を 1:1 で移植する。
 *   limitedHistag = histag.take(21)                       // 先頭 21B に切り詰め
 *   padding       = 22 - limitedHistag.size - 1           // 全長 22B に 0 埋め
 *   結果          = [size:1B] ++ limitedHistag ++ 0*padding  // 常に 22B
 * tag 省略 (null) 時は size=0、本体 0B、padding=21 → [0x00] ++ 0*21 = 22B の全 0。
 *
 * ★OS2 の **履歴タグを伴うコマンドはすべてこの 22B 構造を送る**:
 *   - lock/unlock      : CHSesame2Device.kt:185,201 (data = createHistag(historytag))
 *   - Bot lock/unlock/click : CHSesameBotDevice.kt:370,387,408
 *   - Bike unlock      : CHSesameBikeDevice.kt:311
 *   - autolock         : CHSesame2Device.kt:141 (2B LE 秒数 ++ createHistag)
 *   - configureLockPosition / Bot updateSetting : CHSesame2Device.kt:557 / CHSesameBotDevice.kt:421-422
 *   タグ無しでも全 0 の 22B を送る (実機は先頭 1B を長さとしてパースするため、生バイト透過や
 *   0B 送信はフォーマット不正になる)。
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
 * autolock の data = 2B LE 秒数 (delay.toShort().toReverseBytes()) ++ createHistag(tag) = 24B。
 * (CHSesame2Device.kt:141: SSM2OpCode.update, autolock, delay.toShort().toReverseBytes() ++ createHistag(historytag))
 * 0 で無効化 (disableAutolock = enableAutolock(0), CHSesame2Device.kt:150-152)。
 * @param {number} seconds 0..65535
 * @param {Buffer|Uint8Array} [tag] 履歴タグ
 * @returns {Buffer} 24B (2B LE 秒数 ++ 22B createHistag)
 */
export function autolockData(seconds, tag) {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 0xffff) {
    throw new Error("seconds must be an integer 0..65535 (0 = disable)");
  }
  const b = Buffer.alloc(2);
  b.writeUInt16LE(seconds);
  return Buffer.concat([b, createHistag(tag)]);
}

// ---------- mechStatus 解析 (OS2) ----------

/** OS2 ロック状態。Sesame2/3/4 は施錠/解錠範囲フラグに加え中間 (moved) を持つ。 */
export const MECH_STATE = Object.freeze({ LOCKED: "locked", UNLOCKED: "unlocked", MOVED: "moved" });

/**
 * OS2 の mech_status を解析する。
 *
 * SESAME2/3/4 (CHSesame2MechStatus, open/devices/CHSesame2.kt:31-40) — 8B mech_status_t
 * (CHSesame2Device.kt:631 mech_status_t = [20..27]):
 *   data[0..1]: 電池電圧 ADC 生値 (LE)
 *   data[2..3]: target   (i16 LE、Short.MIN_VALUE=-32768 は「未設定」→ null。CHSesame2.kt:34)
 *   data[4..5]: position (i16 LE)
 *   data[6]   : retCode (0 以外は履歴読み出しトリガ。CHSesame2.kt:35 / CHSesame2Device.kt:545)
 *   data[7]   : flags  (bit1=2 isInLockRange / bit2=4 isInUnlockRange / bit5=32 isBatteryCritical。
 *                       CHSesame2.kt:37-40: flags and 2 / and 4 / and 32)
 *
 * Bot/Bike (CHSesameBotMechStatus, open/devices/CHSesameBot.kt:22-29) も同じ 8B レイアウトで、
 * Bot 固有に motorStatus = data[4] (noPower=0/forward=1/hold=2/backward=3) を持つ
 * (CHSesameBot.kt:23 / CHSesameBotDevice.kt:286-293 の isStop 判定)。
 * flags は同じく data[7] (CHSesameBot.kt:24-28)。
 *
 * ★retCode=data[6] / flags=data[7] の順 (CHSesame2.kt:35-37)。旧実装はこれを逆 (flags=buf[6])
 *   に読んでおり、施錠/解錠判定・電池警告・履歴トリガが全機種で誤値だった (BLE2-02)。
 *
 * 施錠/解錠/中間は isInLockRange / isInUnlockRange の 2 ビットで判定する
 * (CHSesame2Device.kt:551 / CHSesameBikeDevice.kt:299: lock / unlock / else=moved)。
 *
 * kind 3 値化 (P4-2):
 *   - kind="os2bot"  : Bot1 固有意味論 (P3-24 / R2:BLE2-15)。
 *       state は 2 値のみ: isInLockRange → LOCKED、else → UNLOCKED (MOVED は出ない)。
 *       出典: CHSesameBotDevice.kt:303 / :346 —
 *         `deviceStatus = if (isInLockRange) CHDeviceStatus.Locked else CHDeviceStatus.Unlocked`
 *       isStop は motorStatus 由来で上書き計算される (CHSesameBotDevice.kt:286-293 / :334-344):
 *         motorStatus 0 (noPower) → true
 *         motorStatus 1 (forward)  → false
 *         motorStatus 2 (hold)     → true
 *         motorStatus 3 (backward) → false
 *         else                     → false
 *       (CHSesameBot.kt:28 の flags-based isStop はクラス初期値であり、
 *        CHSesameBotDevice.kt:286-293 の when ブロックで必ず上書きされる)
 *   - kind="os2bike" : Bike1 固有。isStop は flags bit0 由来 (CHSesameBotMechStatus と同クラス利用。
 *       出典: CHSesameBot.kt:28 `isStop: Boolean? = (flags and 1 == 0)` /
 *             CHSesameBikeDevice.kt:296 Bike1 は CHSesameBotMechStatus を使う)。
 *   - 既定 (os2lock / kind 未指定) : Sesame2/3/4。**isStop = null**。
 *       出典: CHSesame2.kt:40 `override var isStop: Boolean? = null` — SDK が明示的に null。
 *       flags bit0 の意味論は一次資料がないため null で公開するのが 1:1 移植として正しい。
 *
 * @param {Buffer} buf mech_status_t (8B。Kotlin は data[7] まで読む固定レイアウト)
 * @param {{kind?: string}} [opts] オプション。kind="os2bot"/"os2bike" で固有意味論を適用。
 * @returns {{state:string, isInLockRange:boolean, isInUnlockRange:boolean, isBatteryCritical:boolean,
 *            target:number|null, position:number|null, targetDeg:number|null, positionDeg:number,
 *            batteryRaw:number, retCode:number, flags:number, motorStatus:number, isStop:boolean|null}}
 */
export function parseMechStatus(buf, { kind } = {}) {
  if (!Buffer.isBuffer(buf)) throw new Error("mechStatus must be a Buffer");
  // Kotlin の CHSesame2MechStatus/CHSesameBotMechStatus は data[7] (flags) まで無条件に読む 8B 固定。
  if (buf.length < 8) throw new Error(`OS2 mechStatus must be >= 8 bytes (got ${buf.length})`);
  const batteryRaw = buf.readUInt16LE(0);
  const target = buf.readInt16LE(2);
  const position = buf.readInt16LE(4);
  const retCode = buf[6];                          // CHSesame2.kt:35 retCode = data[6]
  const flags = buf[7];                            // CHSesame2.kt:37 flags = data[7]
  const isInLockRange = !!(flags & 0b0000_0010);   // flags and 2 (CHSesame2.kt:38)
  const isInUnlockRange = !!(flags & 0b0000_0100); // flags and 4 (CHSesame2.kt:39)
  const isBatteryCritical = !!(flags & 0b0010_0000); // flags and 32 (CHSesame2.kt:40)
  const motorStatus = buf[4];                      // CHSesameBot.kt:23 / CHSesameBotDevice.kt:286

  // Bot1 固有: state は 2 値 (LOCKED / UNLOCKED)、MOVED は出ない。
  // 出典: CHSesameBotDevice.kt:303, :346 —
  //   `deviceStatus = if (isInLockRange) CHDeviceStatus.Locked else CHDeviceStatus.Unlocked`
  const isBot = kind === "os2bot";
  const state = isInLockRange
    ? MECH_STATE.LOCKED
    : (isBot || isInUnlockRange ? MECH_STATE.UNLOCKED : MECH_STATE.MOVED);

  const isBike = kind === "os2bike";

  // isStop の 3 値化 (P4-2):
  //   os2bot  : motorStatus 由来 (CHSesameBotDevice.kt:286-293, :334-344)。
  //             flags-based (CHSesameBot.kt:28) はクラス初期値で when ブロックで必ず上書きされる。
  //   os2bike : flags bit0 由来 (CHSesameBot.kt:28 — Bike1 は CHSesameBotMechStatus クラスを使う。
  //             出典: CHSesameBikeDevice.kt:296 / CHSesameBot.kt:28)。
  //   既定 (os2lock): null — SDK が明示的に null (CHSesame2.kt:40: `isStop: Boolean? = null`)。
  //             flags bit0 のロックでの意味論は一次資料なし。参照を捏造しない。
  /** @type {boolean|null} */
  const isStop = isBot
    ? (motorStatus === 0 || motorStatus === 2)  // noPower=0/hold=2 → true; forward=1/backward=3 → false; else false
    : isBike
      ? (flags & 0b0000_0001) === 0             // CHSesameBot.kt:28: (flags and 1 == 0)
      : null;                                   // os2lock (Sesame2/3/4): CHSesame2.kt:40 = null

  return {
    state,
    isInLockRange,
    isInUnlockRange,
    isBatteryCritical,
    // raw はエンコーダ生値 (符号付き 16bit、1024 = 360°)。SDK の position/target はこれを
    // **度数換算した値** (raw*360/1024) で公開する (CHSesame2.kt:32-33)。kit は wire 値検証の
    // ため raw を維持しつつ、SDK と同じ度数を *Deg で併記する (BLE2-08。単位: 度)。
    target: target === -32768 ? null : target,
    position,
    targetDeg: target === -32768 ? null : os2RawToDeg(target),
    positionDeg: os2RawToDeg(position),
    batteryRaw,
    retCode,
    flags,
    // Bot 固有フィールド (CHSesameBot.kt:23): motorStatus = data[4]
    // (noPower=0/forward=1/hold=2/backward=3)。
    // Sesame2/Bike では motorStatus は position の下位バイトに重なるだけの参考値。
    motorStatus,
    isStop,
  };
}

/**
 * OS2 エンコーダ生値 → 度数 (SDK の `(raw.toInt() * 360 / 1024).toShort()` と同値)。
 * Kotlin の Int 除算は 0 方向への切り捨てなので Math.trunc で揃える (負角でも一致)。
 * 出典: CHSesame2.kt:25-26 (mechSetting), :32-33 (mechStatus position/target)。
 * @param {number} raw 符号付き 16bit エンコーダ生値
 * @returns {number} 度数 (整数、0 方向切り捨て)
 */
function os2RawToDeg(raw) {
  return Math.trunc((raw * 360) / 1024);
}

/**
 * OS2 の mech_setting (12B) を SESAME2/3/4 として解析する (BLE2-07)。
 * CHSesame2MechSettings (open/devices/CHSesame2.kt:24-28) を 1:1 で移植:
 *   lockPosition   = (bytesToShort(data[0], data[1]).toInt() * 360 / 1024).toShort()   — 度数
 *   unlockPosition = (bytesToShort(data[2], data[3]).toInt() * 360 / 1024).toShort()   — 度数
 *   isConfigured   = (lockPosition != unlockPosition)
 * bytesToShort は符号付き LE (DataExtention.kt:99-102)。raw (エンコーダ生値) も併記する。
 * @param {Buffer} buf mech_setting_t (4B 以上。login 応答では 12B が来る)
 * @returns {{lockPosition:number, unlockPosition:number, isConfigured:boolean,
 *            lockPositionRaw:number, unlockPositionRaw:number}}
 */
export function parseMechSettingSesame2(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) {
    throw new Error(`OS2 mechSetting must be >= 4 bytes (got ${Buffer.isBuffer(buf) ? buf.length : "non-buffer"})`);
  }
  const lockPositionRaw = buf.readInt16LE(0);
  const unlockPositionRaw = buf.readInt16LE(2);
  const lockPosition = os2RawToDeg(lockPositionRaw);
  const unlockPosition = os2RawToDeg(unlockPositionRaw);
  return {
    lockPosition,
    unlockPosition,
    // 施錠角 == 解錠角は「未キャリブレーション」(SDK は NoSettings 状態へ遷移。CHSesame2.kt:27 /
    // CHSesame2Device.kt:268)。
    isConfigured: lockPosition !== unlockPosition,
    lockPositionRaw,
    unlockPositionRaw,
  };
}

/**
 * OS2 の mech_setting (12B) を初代 SESAME Bot として解析する (BLE2-07)。
 * SSMBotLoginResponsePayload (CHSesameBikeDevice.kt:520) は mech_setting_t[0..6] の 7 バイトを
 * そのまま CHSesameBotMechSettings の 7 フィールド (CHSesameBot.kt:17 — すべて Kotlin Byte =
 * 符号付き 1B) に渡す。残り 5B は予約 0 埋め (CHSesameBot.kt:19 data() の対称)。
 * @param {Buffer} buf mech_setting_t (7B 以上)
 * @returns {{userPrefDir:number, lockSec:number, unlockSec:number, clickLockSec:number,
 *            clickHoldSec:number, clickUnlockSec:number, buttonMode:number}}
 */
export function parseMechSettingBot(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 7) {
    throw new Error(`OS2 Bot mechSetting must be >= 7 bytes (got ${Buffer.isBuffer(buf) ? buf.length : "non-buffer"})`);
  }
  // Kotlin Byte は符号付き 1B。readInt8 で意味論を揃える (CHSesameBot.kt:17)。
  return {
    userPrefDir: buf.readInt8(0),
    lockSec: buf.readInt8(1),
    unlockSec: buf.readInt8(2),
    clickLockSec: buf.readInt8(3),
    clickHoldSec: buf.readInt8(4),
    clickUnlockSec: buf.readInt8(5),
    buttonMode: buf.readInt8(6),
  };
}

/**
 * OS2 login 応答ペイロードを解析する。
 * SSM2LoginResponsePayload (CHSesame2Device.kt:626-634) / SSMBotLoginResponsePayload
 * (CHSesameBikeDevice.kt:513-521) を 1:1 で移植。
 *   payload[0..3] : systemTime (toBigLong = reversedArray を hex parse → **little-endian** u32。
 *                   DataExtention.kt:69-71。旧実装の readUInt32BE は逆読みで、時刻差判定が常に
 *                   発火する誤りだった)
 *   payload[4]    : fw_version
 *   payload[6]    : historyCnt
 *   payload[8..19]: mech_setting_t (12B)
 *   payload[20..27]: mech_status_t (8B、Sesame2)。Bot/Bike も同レイアウトを使用。
 *
 * mech_setting は機種でクラスが分かれる (BLE2-07):
 *   - Sesame2/3/4: CHSesame2MechSettings (CHSesame2.kt:24-28) → mechSetting
 *   - Bot1       : CHSesameBotMechSettings の 7 フィールド (CHSesameBikeDevice.kt:520) → mechSettingBot
 * 呼び出し側は機種に応じてどちらかを読む (両方とも常に解析して返す。生バイトは mechSettingBytes)。
 * isConfigured は Sesame2 形の判定 (lock != unlock) をトップレベルへ併記する
 * (CHSesame2Device.kt:268 の NoSettings 判定に対応)。
 *
 * @param {Buffer} payload login response の payload (resultCode は含まない)
 * @param {{kind?: string}} [opts] オプション。parseMechStatus へ転送 (Bot1 固有意味論に使用。P3-24)。
 * @returns {{systemTime:number, fwVersion:number, historyCnt:number,
 *            mechSetting:ReturnType<typeof parseMechSettingSesame2>,
 *            mechSettingBot:ReturnType<typeof parseMechSettingBot>,
 *            mechSettingBytes:Buffer, isConfigured:boolean, mechStatus:object}}
 */
export function parseLoginResponse(payload, opts = {}) {
  if (!Buffer.isBuffer(payload) || payload.length < 28) {
    throw new Error(`OS2 login response must be >= 28 bytes (got ${Buffer.isBuffer(payload) ? payload.length : "non-buffer"})`);
  }
  // toBigLong (DataExtention.kt:69-71) = reversedArray().toHexString() の 16 進 parse
  // = 元バイト列を little-endian として読むのと等価 (OS3 側 parseDeviceTimeSeconds と同じ)。
  const systemTime = payload.readUInt32LE(0);
  // Kotlin の Byte は符号付き (-128..127)。payload[4] は符号なし (0..255) なので
  // readInt8(4) で符号付き読みに統一する。
  // fw_version >= 1 のガード (_maybeSyncTime) は符号付き評価が正しく、
  // 0x80 以上のファームでは Kotlin 側も負値となりガードが不成立になる。
  // 出典: CHSesame2Device.kt:628 `var fw_version = loginPayload[4]` (Kotlin Byte = signed)
  //       CHSesame2Device.kt:262 `if (loginResponse.fw_version >= 1)` (signed 比較)
  const fwVersion = payload.readInt8(4);
  const historyCnt = payload[6];
  const mechSettingBytes = Buffer.from(payload.subarray(8, 20)); // mech_setting_t 12B
  const mechStatusBytes = Buffer.from(payload.subarray(20, 28)); // mech_status_t 8B
  const mechSetting = parseMechSettingSesame2(mechSettingBytes);
  return {
    systemTime,
    fwVersion,
    historyCnt,
    mechSetting,
    mechSettingBot: parseMechSettingBot(mechSettingBytes),
    mechSettingBytes,
    isConfigured: mechSetting.isConfigured,
    mechStatus: parseMechStatus(mechStatusBytes, opts),
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
