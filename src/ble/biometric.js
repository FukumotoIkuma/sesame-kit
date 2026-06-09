// 生体・アクセス制御デバイス (Sesame Touch / Touch Pro / Face / Palm) の BLE 登録経路。
//
// 移植元 (1:1):
//   - CHSesameBiometricDeviceImpl.kt (publish ディスパッチの全体像)
//   - open/devices/sesameBiometric/capability/{card,fingerPrint,passcode,face,palm}/
//       CH*CapableImpl.kt   … device-side 送信コマンド (ModeSet/Get, *Add, batchAdd, delete, change …)
//       CH*EventHandlers.kt … *_FIRST/_NOTIFY/_LAST/_CHANGE/_DELETE/_MODE_SET の publish 受信分岐
//       CH*Delegate.kt      … 上記をコールバックへ写像する delegate インタフェース
//   - parseData/CHSesameBiometricParseData.kt (CHSesameTouchCard / CHSesameTouchFace のバイト解釈)
//
// 各 capability は「登録モードに入る (ModeSet)」→「デバイスが *_FIRST/_NOTIFY/_LAST を push」→
// 「アプリが *Add/batchAdd で実機に書き戻す」という同じ骨格を持つ。SDK は capability ごとに
// 別クラスへ委譲する構成だが、ここでは protocol.js と同じく **純関数のペイロード生成器** と
// **publish ハンドラ (delegate を呼ぶ純ディスパッチャ)**、それを session に束ねる薄い
// `BiometricCommands` クラスに分ける。session への結線 (request/onPublish) は本モジュールが
// 内部で行うが、publish を外部から手で流し込みたい場合のために handler 関数も単独 export する
// (結線フェーズで index.js が自由に組める)。
//
// ★ itemcodes 連携: card/passcode の **batchAdd** は SesameItemCode ではなく StpItemCode
//   (STP_ITEM_CODE_CARDS_ADD=182 / STP_ITEM_CODE_PASSCODES_ADD=184, SesameProtocols.kt:66) を
//   cmdItCode に使う。これは src/itemcodes.js の STP_ITEM_CODES (WM2_ACTION_CODES と同様の
//   隔離 enum) から参照する。

import { Buffer } from "node:buffer";
import { ITEM_CODES, STP_ITEM_CODES } from "../itemcodes.js";

const ITEM = ITEM_CODES;
const STP_ITEM = STP_ITEM_CODES;

// batchAdd の 1 パケット最大ペイロード長 (CHCardCapableImpl.kt:111 MAX_PAYLOAD_SIZE)。
const MAX_BATCH_PAYLOAD = 209;
// batchAdd でパケット間に挟む待機 (CHCardCapableImpl.kt:150 sleep(4000))。
const BATCH_PACKET_DELAY_MS = 4000;

// *Add の固定ヘッダ (CHCardCapableImpl.kt:103 / CHPassCodeCapableImpl.kt:48)。
const CARD_DATA_USED = 0xf0;       // CARD_DATA_USED / KB_DATA_USED
const TYPE_CLOUD_BASE = 0x00;      // CARD_TYPE_CLOUD_BASE / KB_TYPE_CLOUD

// ---------- 低レベル byte ヘルパ (SDK の DataExtention.kt 系の局所移植) ----------

/** hex 文字列 → Buffer (奇数長 / 非 hex は throw)。SDK hexStringToByteArray 相当。 */
function hexToBytes(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error(`biometric: invalid hex string: ${hex}`);
  }
  return Buffer.from(hex, "hex");
}

/** UUID 文字列/hex 文字列からハイフンを除去した 16B UUID を得る。 */
function uuidToBytes(id) {
  const clean = String(id || "").replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(clean)) {
    throw new Error(`biometric: deviceUUID must be 16B hex/UUID: ${id}`);
  }
  return hexToBytes(clean);
}

/** Buffer → hex 文字列 (小文字)。SDK toHexString 相当。 */
function bytesToHex(buf) {
  return Buffer.from(buf).toString("hex");
}

/**
 * 末尾を指定バイトで size までパディング (既に size 以上なら切らずそのまま)。
 * SDK ByteArray.padEnd(size, pad) 相当 (CHCardCapableImpl.kt:103 id.padEnd(16,0x00))。
 */
function padEnd(buf, size, pad = 0x00) {
  const b = Buffer.from(buf);
  if (b.length >= size) return b;
  return Buffer.concat([b, Buffer.alloc(size - b.length, pad)]);
}

/**
 * Short.toReverseBytes() (DataExtention.kt:108-112) の符号なし版。
 * batchAdd の dataIndex/dataSize は Short を LE 2B 化したもの (CHCardCapableImpl.kt:117-118)。
 * 値域 0..65535 を LE 2B で詰める (batchAdd の長さは非負)。
 */
function shortToReverseBytesLE(value) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value & 0xffff);
  return b;
}

/**
 * hexName (16進文字列) を 2 文字ずつ byte に畳む。
 * SDK: hexName.chunked(2).map { it.toInt(16).toByte() } (CHCardCapableImpl.kt:166 ほか change 系)。
 * 奇数長は末尾 1 文字を捨てる Kotlin chunked と同挙動 (= floor(len/2) バイト)。
 */
function hexNameToBytes(hexName) {
  const out = [];
  for (let i = 0; i + 1 < hexName.length; i += 2) {
    out.push(parseInt(hexName.slice(i, i + 2), 16));
  }
  return Buffer.from(out);
}

// =====================================================================
//  parseData: CHSesameTouchCard / CHSesameTouchFace (受信バイトの解釈)
// =====================================================================

/**
 * CHSesameTouchCard(data) (CHSesameBiometricParseData.kt:10-17) を 1:1 で移植。
 *   data[0]                     : cardType
 *   data[1]                     : idLength
 *   data[2 .. idLength+1]       : cardID   (hex)
 *   data[idLength+2]            : nameLength
 *   data[idLength+3 .. +len]    : cardName (hex)
 * card / fingerprint / passcode の NOTIFY/CHANGE 受信に共通で使う。
 *
 * @param {Buffer} data
 * @returns {{cardType:number, idLength:number, cardID:string, nameLength:number, cardName:string, recordSize:number}}
 */
export function parseTouchCard(data) {
  const buf = Buffer.from(data);
  const cardType = buf[0];
  const idLength = buf[1];
  const cardID = bytesToHex(buf.subarray(2, idLength + 2));
  const nameIndex = idLength + 2;
  const nameLength = buf[nameIndex];
  const cardName = bytesToHex(buf.subarray(nameIndex + 1, nameIndex + 1 + nameLength));
  // NOTIFY は複数レコードが連結されうる (CHCardEventHandlers.kt:31-39)。1 レコードのバイト長 =
  // type(1) + idLen(1) + id(idLength) + nameLen(1) + name(nameLength)。
  const recordSize = 1 + 1 + idLength + 1 + nameLength;
  return { cardType, idLength, cardID, nameLength, cardName, recordSize };
}

/**
 * CHSesameTouchFace(data) (CHSesameBiometricParseData.kt:28-36) を移植。
 * face / palm の NOTIFY/CHANGE 受信に使う。nameUUID は hex を noHashtoUUID した文字列だが、
 * kit には UUID 整形ヘルパが無いため nameUUID は **hex 文字列のまま** 返す
 * (SDK の noHashtoUUID は表示用整形であり、識別子としての値は hex と同値)。
 *
 * @param {Buffer} data
 * @returns {{type:number, idLength:number, id:string, nameLength:number, nameUUID:string}}
 */
export function parseTouchFace(data) {
  const buf = Buffer.from(data);
  const type = buf[0];
  const idLength = buf[1];
  const id = bytesToHex(buf.subarray(2, idLength + 2));
  const nameIndex = idLength + 2;
  const nameLength = buf[nameIndex];
  const nameUUID = bytesToHex(buf.subarray(nameIndex + 1, nameIndex + 1 + nameLength));
  return { type, idLength, id, nameLength, nameUUID };
}

/**
 * CHRemoteNanoTriggerSettings.fromData(buf) (CHSesameBiometricParseData.kt:59-74) を移植。
 * Remote Nano の TRIGGER_DELAYTIME publish (itemCode 191) の payload を解釈する。
 * SDK は ByteBuffer を LITTLE_ENDIAN で wrap し先頭 1 byte を get().toUByte() で読む。
 * 1 byte 値なので LE/BE は同値だが、原典どおり LE・先頭 1B を triggerDelaySecond (0..255) とする。
 *
 * @param {Buffer} data publish payload
 * @returns {{triggerDelaySecond:number}}
 */
export function parseRemoteNanoTrigger(data) {
  const buf = Buffer.from(data);
  return { triggerDelaySecond: buf[0] };
}

/**
 * 生体・アクセス制御デバイス (Touch / Touch Pro / Face / Palm) の mechStatus を解釈する。
 *
 * SDK: CHSesameTouchProMechStatus(data) (CHSesameBiometricParseData.kt:76) を 1:1 で移植。
 * このクラスは CHSesameProtocolMechStatus (CHDeivceProtocols.kt:334-351) を実装するだけで、
 * position/target/isInLockRange/isStop/isCritical/isBatteryCritical の **どの getter も
 * オーバーライドしない**。よって全フィールドはインタフェース既定値に落ちる:
 *   position=0, target=0, isInLockRange=false (→ isInUnlockRange=true),
 *   isStop=null, isCritical=null, isBatteryCritical=false。
 * 保持されるのは raw payload (data) のみ。
 *
 * ★重要: 生体デバイスの mechStatus は **ロックの 7B/3B レイアウト (protocol.js parseMechStatus)
 *   とは別物**。ロック用 parse は position/target/flags をバイト位置から読むが、生体 mechStatus
 *   にはその構造が無い (SDK は raw を保持するだけ)。そのため protocol.js の parseMechStatus に
 *   生体 payload を流すと長さ不一致で throw する。ここではロック解釈を一切行わず、SDK の
 *   pass-through 意味論をそのまま再現する。
 *
 * batteryRaw は SDK が reportBatteryData(payload.sliceArray(0..1)) として電池報告に使う
 * 先頭 2B (CHSesameBiometricDeviceImpl.kt:216) を LE u16 として参考値で同梱する
 * (mechStatus クラス自体は電池を解釈しないが、呼び出し側の利便のため)。payload が 2B 未満なら
 * batteryRaw は null。
 *
 * @param {Buffer} data publish payload (raw)
 * @returns {{data:Buffer, position:number, target:number, isInLockRange:boolean,
 *            isInUnlockRange:boolean, isStop:null, isCritical:null, isBatteryCritical:boolean,
 *            batteryRaw:number|null}}
 */
export function parseBiometricMechStatus(data) {
  const buf = Buffer.from(data);
  return {
    data: buf,
    // 以下は CHSesameProtocolMechStatus の既定値 (生体 mechStatus はどれも override しない)。
    position: 0,
    target: 0,
    isInLockRange: false,
    isInUnlockRange: true,
    isStop: null,
    isCritical: null,
    isBatteryCritical: false,
    // SDK の reportBatteryData が使う先頭 2B (LE)。解釈は本来サーバ側だが参考値で同梱。
    batteryRaw: buf.length >= 2 ? buf.readUInt16LE(0) : null,
  };
}

/**
 * PUB_KEY_SESAME(102) publish の子鍵束を解釈する。
 * SDK: CHSesameBiometricDeviceImpl.handlePubKeySesame (kt:219-255) を 1:1 で移植。
 *
 * payload を **23B ずつ** に分割する (SDK divideArray(23), DataExtention.kt:20-34)。
 * divideArray は末尾の端数チャンクを **0x00 で 23B までゼロ埋め** する (事前確保 ByteArray を
 * arraycopy で部分的に埋めるため)。よって全ゼロ判定はこのゼロ埋めも込みで行う。
 *
 * 各 23B チャンク (it):
 *   it[22] = lockStatus。0 のスロットは空き (skip)。
 *   it[21] == 0x00 → SS5 鍵:  id = it[0..15] (16B) の hex、value = [0x05, it[22]]。
 *   it[21] != 0x00 → SS2 鍵:  id = base64decode(utf8(it[0..21]) + "==") の hex、value = [0x04, it[22]]。
 *       (SS2 系は 22B の base64 文字列を ASCII で詰めており、"==" を補って復号する)。
 * SDK は id をさらに noHashtoUUID で UUID 整形するが、kit は parseTouchFace と同じ方針で
 * **hex 文字列のまま** id とする (noHashtoUUID は表示整形であり識別子としての値は hex と同値)。
 * base64 復号に失敗したチャンクは SDK 同様スキップする (kt:247-249 catch)。
 *
 * 空きスロット判定 (hasEmptySlot, kt:225-231):
 *   既定 (非 OpenSensor): 全ゼロチャンクが 1 つでもあれば空きあり。
 *   OpenSensor 系: hub3 用に 1 スロット予約するため、全ゼロチャンクが **2 つ以上** で空きあり。
 * kit は product model 文脈を持たない (handleBiometricPublish と同様) ため、呼び出し側が
 * isOpenSensor を渡して切り替える。
 *
 * @param {Buffer} data PUB_KEY_SESAME publish payload
 * @param {{isOpenSensor?:boolean}} [opts]
 * @returns {{keys:Array<{ssmID:string, keyType:number, lockStatus:number}>,
 *            slotFull:boolean, emptySlotCount:number}}
 *   keys: 占有スロットのみ (lockStatus!=0)。keyType は 0x05(SS5)/0x04(SS2)、value 第2バイトは lockStatus。
 *   slotFull: !hasEmptySlot (SDK setSlotFull(!hasEmptySlot) と同義)。
 */
export function parsePubKeySesame(data, { isOpenSensor = false } = {}) {
  const buf = Buffer.from(data);
  const chunks = divideArray23(buf);
  let emptySlotCount = 0;
  const keys = [];
  for (const chunk of chunks) {
    if (chunk.every((b) => b === 0x00)) { emptySlotCount += 1; continue; }
    const lockStatus = chunk[22];
    if (lockStatus === 0) continue; // 空きスロット (SDK kt:236-237)
    if (chunk[21] === 0x00) {
      // SS5: 先頭 16B を hex 化して識別子に (SDK は noHashtoUUID で UUID 整形、kit は hex 据置)。
      const ssmID = bytesToHex(chunk.subarray(0, 16));
      keys.push({ ssmID, keyType: 0x05, lockStatus });
    } else {
      // SS2: 22B を ASCII 文字列とみなし "==" を補って base64 復号 → hex。
      try {
        const b64 = chunk.subarray(0, 22).toString("latin1") + "==";
        const decoded = Buffer.from(b64, "base64");
        const ssmID = bytesToHex(decoded);
        keys.push({ ssmID, keyType: 0x04, lockStatus });
      } catch {
        // 復号失敗チャンクはスキップ (SDK kt:247-249 の catch 相当)。
      }
    }
  }
  // hasEmptySlot: OpenSensor は >1、それ以外は >=1 (SDK kt:225-231)。
  const hasEmptySlot = isOpenSensor ? emptySlotCount > 1 : emptySlotCount > 0;
  return { keys, slotFull: !hasEmptySlot, emptySlotCount };
}

/**
 * SDK ByteArray.divideArray(23) (DataExtention.kt:20-34) を移植。
 * 末尾の端数チャンクを 23B まで 0x00 ゼロ埋めする (事前確保 ByteArray の arraycopy 挙動と一致)。
 * 入力長 0 は空配列 (ceil(0/23)=0)。
 * @param {Buffer} buf
 * @returns {Buffer[]} 各 23B (末尾はゼロ埋め)
 */
function divideArray23(buf) {
  const CHUNK = 23;
  const count = Math.ceil(buf.length / CHUNK);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const start = i * CHUNK;
    const chunk = Buffer.alloc(CHUNK, 0x00);
    buf.subarray(start, start + CHUNK).copy(chunk);
    out.push(chunk);
  }
  return out;
}

// =====================================================================
//  ペイロード生成器 (device-side 送信コマンドの data 部)
//  いずれも buildSendFrame(itemCode, data) → CIPHERTEXT (session.request) で送る前提。
// =====================================================================

// ---- card (CHCardCapableImpl.kt) ----

/** cardModeSet: data = [mode] (CHCardCapableImpl.kt:53)。 */
export function cardModeSetData(mode) { return Buffer.from([mode & 0xff]); }
/** cardModeGet / cardGet: data = [] (空)。 */
export function cardModeGetData() { return Buffer.alloc(0); }
export function cardGetData() { return Buffer.alloc(0); }

/**
 * cardAdd: data = [F0][00][idLen] ++ id.padEnd(16) ++ [nameLen] ++ name.padEnd(16)
 * (CHCardCapableImpl.kt:101-104)。id は raw bytes、hexName は UTF-8 文字列としてバイト化
 * (SDK は hexName.toByteArray() = UTF-8。padEnd(16) で 16B 固定枠)。
 * @param {Buffer} id      カード UID 生バイト列
 * @param {string} hexName 名前 (UTF-8 文字列)
 */
export function cardAddData(id, hexName) {
  const idBuf = Buffer.from(id);
  const nameBuf = Buffer.from(hexName, "utf8");
  return Buffer.concat([
    Buffer.from([CARD_DATA_USED, TYPE_CLOUD_BASE, idBuf.length]),
    padEnd(idBuf, 16, 0x00),
    Buffer.from([nameBuf.length]),
    padEnd(nameBuf, 16, 0x00),
  ]);
}

/** cardDelete: data = cardID(hex→bytes) (CHCardCapableImpl.kt:62)。 */
export function cardDeleteData(cardID) { return hexToBytes(cardID); }

/**
 * cardMove: data = [idLen] ++ id(hex→bytes) ++ touchProUUID(UTF-8) (CHCardCapableImpl.kt:71)。
 * @param {string} cardId       hex
 * @param {string} touchProUUID 移動先デバイスの UUID 文字列 (UTF-8)
 */
export function cardMoveData(cardId, touchProUUID) {
  const idBuf = hexToBytes(cardId);
  return Buffer.concat([Buffer.from([idBuf.length]), idBuf, Buffer.from(touchProUUID, "utf8")]);
}

/**
 * cardChange: data = [idLen] ++ id(hex→bytes) ++ hexName(2文字ずつ畳んだ bytes)
 * (CHCardCapableImpl.kt:160-166)。新方式は 16B UUID を name として渡す。
 */
export function cardChangeData(ID, hexName) {
  const idBuf = hexToBytes(ID);
  return Buffer.concat([Buffer.from([idBuf.length]), idBuf, hexNameToBytes(hexName)]);
}

/** cardChangeValue: data = [idLen] ++ id(hex→bytes) ++ newID(UTF-8) (CHCardCapableImpl.kt:174)。 */
export function cardChangeValueData(ID, newID) {
  const idBuf = hexToBytes(ID);
  return Buffer.concat([Buffer.from([idBuf.length]), idBuf, Buffer.from(newID, "utf8")]);
}

// ---- fingerPrint (CHFingerPrintCapableImpl.kt) ----

export function fingerPrintModeSetData(mode) { return Buffer.from([mode & 0xff]); }
export function fingerPrintModeGetData() { return Buffer.alloc(0); }
export function fingerPrintGetData() { return Buffer.alloc(0); }
/** fingerPrintDelete: data = fingerPrintID(hex→bytes) (CHFingerPrintCapableImpl.kt:50)。 */
export function fingerPrintDeleteData(fingerPrintID) { return hexToBytes(fingerPrintID); }
/** fingerPrintsChange: data = [idLen] ++ id(hex→bytes) ++ hexName(畳んだ bytes) (CHFingerPrintCapableImpl.kt:74)。 */
export function fingerPrintChangeData(ID, hexName) {
  const idBuf = hexToBytes(ID);
  return Buffer.concat([Buffer.from([idBuf.length]), idBuf, hexNameToBytes(hexName)]);
}

// ---- passcode (CHPassCodeCapableImpl.kt) ----

export function passcodeModeSetData(mode) { return Buffer.from([mode & 0xff]); }
export function passcodeModeGetData() { return Buffer.alloc(0); }
export function passcodeGetData() { return Buffer.alloc(0); }

/**
 * keyBoardPassCodeAdd: data = [F0][00][idLen] ++ id.padEnd(16) ++ [nameLen] ++ name.padEnd(16)
 * (CHPassCodeCapableImpl.kt:44-49)。card と同一レイアウト (定数名のみ KB_*)。
 */
export function passcodeAddData(id, hexName) {
  const idBuf = Buffer.from(id);
  const nameBuf = Buffer.from(hexName, "utf8");
  return Buffer.concat([
    Buffer.from([CARD_DATA_USED, TYPE_CLOUD_BASE, idBuf.length]),
    padEnd(idBuf, 16, 0x00),
    Buffer.from([nameBuf.length]),
    padEnd(nameBuf, 16, 0x00),
  ]);
}

/** keyBoardPassCodeDelete: data = id(hex→bytes) (CHPassCodeCapableImpl.kt:104)。 */
export function passcodeDeleteData(keyBoardPassCodeID) { return hexToBytes(keyBoardPassCodeID); }
/** keyBoardPassCodeMove: data = [idLen] ++ id(hex→bytes) ++ touchProUUID(UTF-8) (CHPassCodeCapableImpl.kt:113)。 */
export function passcodeMoveData(cardId, touchProUUID) {
  const idBuf = hexToBytes(cardId);
  return Buffer.concat([Buffer.from([idBuf.length]), idBuf, Buffer.from(touchProUUID, "utf8")]);
}
/** keyBoardPassCodeChange: data = [idLen] ++ id(hex→bytes) ++ hexName(畳んだ bytes) (CHPassCodeCapableImpl.kt:123)。 */
export function passcodeChangeData(ID, hexName) {
  const idBuf = hexToBytes(ID);
  return Buffer.concat([Buffer.from([idBuf.length]), idBuf, hexNameToBytes(hexName)]);
}

// ---- face (CHFaceCapableImpl.kt) ----

export function faceModeSetData(mode) { return Buffer.from([mode & 0xff]); }
export function faceModeGetData() { return Buffer.alloc(0); }
export function faceGetData() { return Buffer.alloc(0); }
/** faceChange: data = [idLen] ++ id(hex→bytes) ++ name(畳んだ bytes) (CHFaceCapableImpl.kt:50)。 */
export function faceChangeData(ID, name) {
  const idBuf = hexToBytes(ID);
  return Buffer.concat([Buffer.from([idBuf.length]), idBuf, hexNameToBytes(name)]);
}
/** faceDelete: data = [faceID(hex→単一 byte)] (CHFaceCapableImpl.kt:56 byteArrayOf(faceID.toInt(16).toByte()))。 */
export function faceDeleteData(faceID) { return Buffer.from([parseInt(faceID, 16) & 0xff]); }

// ---- palm (CHPalmCapableImpl.kt) ----

export function palmModeSetData(mode) { return Buffer.from([mode & 0xff]); }
export function palmModeGetData() { return Buffer.alloc(0); }
export function palmGetData() { return Buffer.alloc(0); }
/** palmDelete: data = [palmID(hex→単一 byte)] (CHPalmCapableImpl.kt:47)。 */
export function palmDeleteData(palmID) { return Buffer.from([parseInt(palmID, 16) & 0xff]); }

// ---- remoteNano (CHRemoteNanoCapableImpl.kt) ----

/**
 * setTriggerDelayTime: data = [time(UByte 1B)] (CHRemoteNanoCapableImpl.kt:19-28
 * byteArrayOf(time.toByte()))。time は UByte 0..255。範囲外は throw (誇張せず原典の型制約を再現)。
 * @param {number} time 0..255
 */
export function remoteNanoTriggerDelayData(time) {
  if (!Number.isInteger(time) || time < 0 || time > 255) {
    throw new Error(`biometric: triggerDelay time must be UByte 0..255: ${time}`);
  }
  return Buffer.from([time & 0xff]);
}

// ---- radar sensitivity (CHDeviceConnectCapableImpl.kt) ----

/**
 * setRadarSensitivity: data = payload をそのまま (CHDeviceConnectCapableImpl.kt:89-95)。
 * SDK は raw payload Buffer を SSM_OS3_RADAR_PARAM_SET(200) に無加工で載せる
 * (payload[1] をログ出力するのみで構造は触らない)。kit でも生バイトを通す。
 * @param {Buffer} payload レーダーパラメータの生バイト列
 */
export function radarSensitivityData(payload) {
  return Buffer.from(payload);
}

// ---- connector child Sesame keys (CHDeviceConnectCapableImpl.kt) ----

/**
 * insertSesame の ADD_SESAME payload を組み立てる。
 *
 * SDK:
 *   - OS3 子デバイス (SS5/5Pro/Bike2): UUID(16B) ++ secretKey(16B)
 *   - OS2 子デバイス (SS3/4/Bot1/Bike1): base64(UUID16).replace("=","")(22B)
 *       ++ sesame2PublicKey(64B) ++ secretKey(16B)
 *
 * `sesame2PublicKey` を渡した場合は OS2 形、それ以外は OS3 形で送る。
 *
 * @param {{deviceUUID:string, secretKey:string|Buffer, sesame2PublicKey?:string|Buffer}} sesame
 * @returns {Buffer}
 */
export function insertSesameData({ deviceUUID, secretKey, sesame2PublicKey } = {}) {
  const uuid = uuidToBytes(deviceUUID);
  const sec = Buffer.isBuffer(secretKey) ? Buffer.from(secretKey) : hexToBytes(secretKey);
  if (sec.length !== 16) throw new Error(`biometric: secretKey must be 16B / 32hex, got ${sec.length}B`);
  if (!sesame2PublicKey) return Buffer.concat([uuid, sec]);

  const pub = Buffer.isBuffer(sesame2PublicKey) ? Buffer.from(sesame2PublicKey) : hexToBytes(sesame2PublicKey);
  if (pub.length !== 64) throw new Error(`biometric: sesame2PublicKey must be 64B / 128hex, got ${pub.length}B`);
  const b64k = Buffer.from(uuid).toString("base64").replace(/=/g, "");
  return Buffer.concat([Buffer.from(b64k, "utf8"), pub, sec]);
}

/**
 * removeSesame の REMOVE_SESAME payload を組み立てる。
 * keyType=0x04 は OS2 子鍵 (base64(UUID16).replace("=",""))、それ以外は OS3 子鍵 (UUID16)。
 *
 * @param {string} tag UUID/hex
 * @param {{keyType?:number}} [opts]
 * @returns {Buffer}
 */
export function removeSesameData(tag, { keyType = 0x05 } = {}) {
  const uuid = uuidToBytes(tag);
  if (keyType === 0x04) {
    return Buffer.from(Buffer.from(uuid).toString("base64").replace(/=/g, ""), "utf8");
  }
  return uuid;
}

// ---- batchAdd の各パケット data (card / passcode 共通アルゴリズム) ----

/**
 * batchAdd 1 パケットの data を組み立てる。
 *   data = dataIndex.toReverseBytes()(2B LE) ++ dataSize.toReverseBytes()(2B LE) ++ chunk
 * (CHCardCapableImpl.kt:117-122 / CHPassCodeCapableImpl.kt:73-78)。
 * chunk は全データ data[dataIndex .. dataIndex+chunkSize) で chunkSize = min(残り, 209)。
 *
 * @param {Buffer} data      全登録データ
 * @param {number} dataIndex 現在の読み出し位置
 * @returns {{packet:Buffer, nextIndex:number}}
 */
export function batchAddPacket(data, dataIndex) {
  const dataSize = data.length;
  const remaining = dataSize - dataIndex;
  const chunkSize = Math.min(remaining, MAX_BATCH_PAYLOAD);
  const chunk = data.subarray(dataIndex, dataIndex + chunkSize);
  const packet = Buffer.concat([
    shortToReverseBytesLE(dataIndex),
    shortToReverseBytesLE(dataSize),
    chunk,
  ]);
  return { packet, nextIndex: dataIndex + chunkSize };
}

// =====================================================================
//  publish 受信ハンドラ (delegate ディスパッチ)
//  CHSesameBiometricDeviceImpl.onGattSesamePublish → 各 CH*EventHandler.handleEvent を
//  1 関数に統合。session.onPublish({opCode,itemCode,body}) の body を payload として渡す。
// =====================================================================

/**
 * publish パケット 1 件を delegate へディスパッチする純関数。
 *
 * SDK では capability ごとに EventHandler を登録し handleEvent が true を返すまで巡回するが、
 * itemCode が一意に capability を決めるためここでは単一 switch で 1:1 に写像する。
 * いずれの delegate コールバックも任意 (未定義なら no-op)。device 引数は SDK の delegate 第1引数
 * (CHDevices) に相当する不透明トークンで、呼び出し側が文脈 (どのデバイスか) を持たせるために渡す。
 *
 * 受理した itemCode は true を、未対応 (mechStatus 等の非生体 publish) は false を返す
 * (CHSesameBiometricDeviceImpl.kt の handled フラグ相当)。
 *
 * @param {{itemCode:number, body:Buffer}} pkt    publish パケット (session.onPublish の引数)
 * @param {object} delegate  下記コールバックの一部または全部を持つオブジェクト
 * @param {any} [device]     コールバックへ素通しする識別子 (省略可)
 * @returns {boolean} 生体 capability として処理したら true
 *
 * delegate コールバック (SDK CH*Delegate.kt 1:1):
 *   card:        onCardReceiveStart/onCardReceive/onCardReceiveEnd/onCardChanged/onCardModeChanged/onCardDelete
 *   fingerPrint: onFingerPrintReceiveStart/onFingerPrintReceive/onFingerPrintReceiveEnd/onFingerPrintChanged/onFingerModeChange/onFingerDelete
 *   passcode:    onKeyBoardReceiveStart/onKeyBoardReceive/onKeyBoardReceiveEnd/onKeyBoardChanged/onKeyBoardModeChange/onKeyBoardDelete
 *   face:        onFaceReceiveStart/onFaceReceive/onFaceReceiveEnd/onFaceChanged/onFaceModeChanged/onFaceDeleted
 *   palm:        onPalmReceiveStart/onPalmReceive/onPalmReceiveEnd/onPalmChanged/onPalmModeChanged/onPalmDeleted
 *   remoteNano:  onTriggerDelaySecondReceived({triggerDelaySecond})  (CHRemoteNanoDelegate.kt)
 *   radar:       onRadarReceive(payload:Buffer)                      (CHDeviceConnectDelegate.kt onRadarReceive)
 *   mechStatus:  onMechStatus(status)  status = parseBiometricMechStatus の結果
 *                  (CHSesameBiometricDeviceImpl.kt:214-217 handleMechStatus + CHDeviceStatusDelegate.onMechStatus)
 *   pubKey:      onSesameKeysReceived({keys,slotFull,emptySlotCount})
 *                  (kt:219-255 handlePubKeySesame + ObservableMutableMap.setSlotFull)。
 *                  ※ slotFull は既定 (非 OpenSensor) 判定。OpenSensor 判定が要る場合は
 *                    呼び出し側で parsePubKeySesame(payload,{isOpenSensor:true}) を直接使う。
 *   battery:     onBatteryVoltageReceived(payloadHex)  (kt:185-187 reportBatteryData(payload.toHexString()))
 *   support:     onSupportChanged(false)               (kt:189-192 setSupport(false))
 *   bleTxPower:  onBleTxPowerReceive(txPower)           (kt:194-197 bleTxPower=payload[0]、符号付き 1B)
 */
export function handleBiometricPublish(pkt, delegate, device) {
  if (!pkt || !delegate) return false;
  const { itemCode } = pkt;
  const payload = Buffer.from(pkt.body ?? pkt.payload ?? Buffer.alloc(0));
  const call = (fn, ...args) => { if (typeof fn === "function") fn(device, ...args); };

  switch (itemCode) {
    // ---- card ----
    case ITEM.CARD_FIRST:
      call(delegate.onCardReceiveStart); return true;
    case ITEM.CARD_LAST:
      call(delegate.onCardReceiveEnd); return true;
    case ITEM.CARD_NOTIFY: {
      // NOTIFY は複数レコードの連結 (CHCardEventHandlers.kt:31-39)。recordSize ずつ前進。
      let rest = payload;
      while (rest.length > 0) {
        const card = parseTouchCard(rest);
        call(delegate.onCardReceive, card.cardID, card.cardName, card.cardType);
        if (card.recordSize <= 0 || card.recordSize > rest.length) break;
        rest = rest.subarray(card.recordSize);
      }
      return true;
    }
    case ITEM.CARD_CHANGE: {
      const card = parseTouchCard(payload);
      call(delegate.onCardChanged, card.cardID, card.cardName, card.cardType);
      return true;
    }
    case ITEM.CARD_MODE_SET:
      call(delegate.onCardModeChanged, payload[0]); return true;
    case ITEM.CARD_DELETE: {
      // CHCardEventHandlers.kt:55-58: payload[2]=idLen, id=payload[3 .. idLen+2]。
      const idLen = payload[2];
      const cardID = bytesToHex(payload.subarray(3, 3 + idLen));
      call(delegate.onCardDelete, cardID);
      return true;
    }

    // ---- fingerPrint ----
    case ITEM.FINGERPRINT_FIRST:
      call(delegate.onFingerPrintReceiveStart); return true;
    case ITEM.FINGERPRINT_LAST:
      call(delegate.onFingerPrintReceiveEnd); return true;
    case ITEM.FINGERPRINT_NOTIFY: {
      // CHFingerPrintEventHandlers.kt:39-42: 1 レコードのみを解釈 (card と異なりループ無し)。
      const card = parseTouchCard(payload);
      call(delegate.onFingerPrintReceive, card.cardID, card.cardName, card.cardType);
      return true;
    }
    case ITEM.FINGERPRINT_CHANGE: {
      const card = parseTouchCard(payload);
      call(delegate.onFingerPrintChanged, card.cardID, card.cardName, card.cardType);
      return true;
    }
    case ITEM.FINGERPRINT_MODE_SET:
      call(delegate.onFingerModeChange, payload[0]); return true;
    case ITEM.FINGERPRINT_DELETE:
      // CHFingerPrintEventHandlers.kt:48: payload 全体を hex 化して渡す (card と分岐が違う)。
      call(delegate.onFingerDelete, bytesToHex(payload)); return true;

    // ---- passcode ----
    case ITEM.PASSCODE_FIRST:
      call(delegate.onKeyBoardReceiveStart); return true;
    case ITEM.PASSCODE_LAST:
      call(delegate.onKeyBoardReceiveEnd); return true;
    case ITEM.PASSCODE_NOTIFY: {
      // card と同じく複数レコード連結 (CHPassCodeEventHandlers.kt:28-37)。
      let rest = payload;
      while (rest.length > 0) {
        const card = parseTouchCard(rest);
        call(delegate.onKeyBoardReceive, card.cardID, card.cardName, card.cardType);
        if (card.recordSize <= 0 || card.recordSize > rest.length) break;
        rest = rest.subarray(card.recordSize);
      }
      return true;
    }
    case ITEM.PASSCODE_CHANGE: {
      const card = parseTouchCard(payload);
      call(delegate.onKeyBoardChanged, card.cardID, card.cardName, card.cardType);
      return true;
    }
    case ITEM.PASSCODE_MODE_SET:
      call(delegate.onKeyBoardModeChange, payload[0]); return true;
    case ITEM.PASSCODE_DELETE: {
      // CHPassCodeEventHandlers.kt:55-58: payload[2]=idLen, id=payload[3 .. idLen+2]。
      const idLen = payload[2];
      const pwdID = bytesToHex(payload.subarray(3, 3 + idLen));
      call(delegate.onKeyBoardDelete, pwdID);
      return true;
    }

    // ---- face ----
    case ITEM.FACE_FIRST:
      call(delegate.onFaceReceiveStart); return true;
    case ITEM.FACE_LAST:
      call(delegate.onFaceReceiveEnd); return true;
    case ITEM.FACE_NOTIFY:
      call(delegate.onFaceReceive, parseTouchFace(payload)); return true;
    case ITEM.FACE_CHANGE:
      call(delegate.onFaceChanged, parseTouchFace(payload)); return true;
    case ITEM.FACE_MODE_SET:
      call(delegate.onFaceModeChanged, payload[0]); return true;
    case ITEM.FACE_DELETE:
      // CHFaceEventHandlers.kt:50-52: DELETE は ack のみ (delegate 呼び出し無し) だが handled=true。
      return true;
    case ITEM.FACE_MODE_DELETE_NOTIFY:
      // CHFaceEventHandlers.kt:54-60: payload[0]=faceID, payload[1]==0 で成功。
      if (payload.length >= 2) call(delegate.onFaceDeleted, payload[0], payload[1] === 0x00);
      return true;

    // ---- palm ----
    case ITEM.PALM_FIRST:
      call(delegate.onPalmReceiveStart); return true;
    case ITEM.PALM_LAST:
      call(delegate.onPalmReceiveEnd); return true;
    case ITEM.PALM_NOTIFY:
      call(delegate.onPalmReceive, parseTouchFace(payload)); return true;
    case ITEM.PALM_CHANGE:
      call(delegate.onPalmChanged, parseTouchFace(payload)); return true;
    case ITEM.PALM_MODE_SET:
      call(delegate.onPalmModeChanged, payload[0]); return true;
    case ITEM.PALM_MODE_DELETE_NOTIFY:
      // CHPalmEventHandlers.kt:46-52: payload[0]=palmID, payload[1]==0 で成功。
      if (payload.length >= 2) call(delegate.onPalmDeleted, payload[0], payload[1] === 0x00);
      return true;

    // ---- remoteNano (trigger delay) ----
    case ITEM.REMOTE_NANO_PUB_TRIGGER_DELAYTIME: {
      // CHRemoteNanoEventHandler.kt:15-21: payload を CHRemoteNanoTriggerSettings.fromData で
      // parse し onTriggerDelaySecondReceived へ。SDK は device.isRemote() ガードを掛けるが、
      // kit は device 文脈を持たない (呼び出し側が device トークンを渡すだけ) ため、ここでは
      // itemCode 一致で常に dispatch する (機種判定はファサード/呼び出し側の責務)。
      const setting = parseRemoteNanoTrigger(payload);
      call(delegate.onTriggerDelaySecondReceived, setting);
      return true;
    }

    // ---- face radar sensitivity ----
    case ITEM.SSM_OS3_RADAR_PARAM_PUBLISH:
      // CHSesameBiometricDeviceImpl.kt:176,210-212: payload を生のまま onRadarReceive へ渡す。
      call(delegate.onRadarReceive, payload);
      return true;

    // ---- mechStatus (生体デバイスの状態通知) ----
    case ITEM.MECH_STATUS:
      // CHSesameBiometricDeviceImpl.kt:166-169,214-217 handleMechStatus:
      //   mechStatus = CHSesameTouchProMechStatus(payload) (raw 保持) + reportBatteryData(先頭2B)。
      // ロックの 7B/3B レイアウトとは別物なので protocol.js の parseMechStatus は使わない。
      call(delegate.onMechStatus, parseBiometricMechStatus(payload));
      return true;

    // ---- 子鍵束 (HUB3/WM2 が保持する子 Sesame 鍵の push) ----
    case ITEM.PUB_KEY_SESAME:
      // CHSesameBiometricDeviceImpl.kt:171-174,219-255 handlePubKeySesame。
      // slotFull は既定 (非 OpenSensor) 判定。OpenSensor 機の正確な判定は呼び出し側が
      // parsePubKeySesame(payload,{isOpenSensor:true}) を直接呼ぶこと (delegate は model 文脈を持たない)。
      call(delegate.onSesameKeysReceived, parsePubKeySesame(payload));
      return true;

    // ---- 電池電圧 publish ----
    case ITEM.SSM3_ITEM_CODE_BATTERY_VOLTAGE:
      // CHSesameBiometricDeviceImpl.kt:185-187: reportBatteryData(payload.toHexString())。
      // SDK はサーバへ post するが、kit は payload を hex 化して delegate へ素通しする
      // (サーバ通信は呼び出し側 / access 層の責務)。
      call(delegate.onBatteryVoltageReceived, bytesToHex(payload));
      return true;

    // ---- 子鍵スロット 非サポート publish ----
    case ITEM.SSM3_ITEM_CODE_SESAME_UNSUPPORT:
      // CHSesameBiometricDeviceImpl.kt:189-192: ssm2KeysMap.setSupport(false)。
      call(delegate.onSupportChanged, false);
      return true;

    // ---- BLE 送信出力 publish ----
    case ITEM.SSM3_ITEM_CODE_BLE_TX_POWER_SETTING: {
      // CHSesameBiometricDeviceImpl.kt:194-197: bleTxPower = payload[0] (Kotlin Byte = 符号付き 1B)。
      const txPower = payload.length > 0 ? payload.readInt8(0) : 0;
      call(delegate.onBleTxPowerReceive, txPower);
      return true;
    }

    default:
      return false;
  }
}

// =====================================================================
//  BiometricCommands: session に束ねた device-side 送信 API
//  session.request(itemCode, data) → {resultCode, payload} を返す契約に乗せる。
//  publish 購読は registerDelegate() が session.onPublish に handleBiometricPublish を結線する。
// =====================================================================

export class BiometricCommands {
  /**
   * @param {object} session SesameBleSession 互換 (request(itemCode,data)→Promise<{resultCode,payload}> と
   *                         onPublish(fn)→unsubscribe を持つこと)。
   */
  constructor(session) {
    if (!session || typeof session.request !== "function") {
      throw new Error("biometric: session with request() is required");
    }
    this._session = session;
  }

  /** request の薄いラッパ (将来 timeout 等を一括調整できるよう一箇所に集約)。 */
  _req(itemCode, data) { return this._session.request(itemCode, data); }

  // ---- card ----
  /** 登録モード設定。応答後にデバイスが CARD_FIRST/NOTIFY/LAST を push する。 */
  async cardModeSet(mode) { await this._req(ITEM.CARD_MODE_SET, cardModeSetData(mode)); }
  async cardModeGet() { const r = await this._req(ITEM.CARD_MODE_GET, cardModeGetData()); return r.payload[0]; }
  async cardGet() { await this._req(ITEM.CARD_GET, cardGetData()); }
  async cardAdd(id, hexName) { await this._req(ITEM.CARD_ADD, cardAddData(id, hexName)); }
  async cardDelete(cardID) { await this._req(ITEM.CARD_DELETE, cardDeleteData(cardID)); }
  async cardMove(cardId, touchProUUID) { await this._req(ITEM.CARD_MOVE, cardMoveData(cardId, touchProUUID)); }
  async cardChange(ID, hexName) { await this._req(ITEM.CARD_CHANGE, cardChangeData(ID, hexName)); }
  async cardChangeValue(ID, newID) { await this._req(ITEM.CARD_CHANGE_VALUE, cardChangeValueData(ID, newID)); }
  /** card の一括登録 (STP 分割転送)。STP_ITEM_CODE_CARDS_ADD で送る。 */
  cardBatchAdd(id, progress) { return this._batchAdd(STP_ITEM.STP_ITEM_CODE_CARDS_ADD, Buffer.from(id), progress); }

  // ---- fingerPrint ----
  async fingerPrintModeSet(mode) { await this._req(ITEM.FINGERPRINT_MODE_SET, fingerPrintModeSetData(mode)); }
  async fingerPrintModeGet() { const r = await this._req(ITEM.FINGERPRINT_MODE_GET, fingerPrintModeGetData()); return r.payload[0]; }
  async fingerPrints() { await this._req(ITEM.FINGERPRINT_GET, fingerPrintGetData()); }
  async fingerPrintDelete(fingerPrintID) { await this._req(ITEM.FINGERPRINT_DELETE, fingerPrintDeleteData(fingerPrintID)); }
  async fingerPrintChange(ID, hexName) { await this._req(ITEM.FINGERPRINT_CHANGE, fingerPrintChangeData(ID, hexName)); }

  // ---- passcode ----
  async passcodeModeSet(mode) { await this._req(ITEM.PASSCODE_MODE_SET, passcodeModeSetData(mode)); }
  async passcodeModeGet() { const r = await this._req(ITEM.PASSCODE_MODE_GET, passcodeModeGetData()); return r.payload[0]; }
  async passcodeGet() { await this._req(ITEM.PASSCODE_GET, passcodeGetData()); }
  async passcodeAdd(id, hexName) { await this._req(ITEM.PASSCODE_ADD, passcodeAddData(id, hexName)); }
  async passcodeDelete(keyBoardPassCodeID) { await this._req(ITEM.PASSCODE_DELETE, passcodeDeleteData(keyBoardPassCodeID)); }
  async passcodeMove(cardId, touchProUUID) { await this._req(ITEM.PASSCODE_MOVE, passcodeMoveData(cardId, touchProUUID)); }
  async passcodeChange(ID, hexName) { await this._req(ITEM.PASSCODE_CHANGE, passcodeChangeData(ID, hexName)); }
  /** passcode の一括登録 (STP 分割転送)。STP_ITEM_CODE_PASSCODES_ADD で送る。 */
  passcodeBatchAdd(data, progress) { return this._batchAdd(STP_ITEM.STP_ITEM_CODE_PASSCODES_ADD, Buffer.from(data), progress); }

  // ---- face ----
  async faceModeSet(mode) { await this._req(ITEM.FACE_MODE_SET, faceModeSetData(mode)); }
  async faceModeGet() {
    const r = await this._req(ITEM.FACE_MODE_GET, faceModeGetData());
    if (!r.payload || r.payload.length === 0) throw new Error(`biometric: faceModeGet data error: ${bytesToHex(r.payload ?? Buffer.alloc(0))}`);
    return r.payload[0];
  }
  async faceListGet() { await this._req(ITEM.FACE_GET, faceGetData()); }
  async faceChange(ID, name) { await this._req(ITEM.FACE_CHANGE, faceChangeData(ID, name)); }
  async faceDelete(faceID) { await this._req(ITEM.FACE_DELETE, faceDeleteData(faceID)); }

  // ---- palm ----
  async palmModeSet(mode) { await this._req(ITEM.PALM_MODE_SET, palmModeSetData(mode)); }
  async palmModeGet() {
    const r = await this._req(ITEM.PALM_MODE_GET, palmModeGetData());
    if (!r.payload || r.payload.length === 0) throw new Error(`biometric: palmModeGet data error: ${bytesToHex(r.payload ?? Buffer.alloc(0))}`);
    return r.payload[0];
  }
  async palmListGet() { await this._req(ITEM.PALM_GET, palmGetData()); }
  async palmDelete(palmID) { await this._req(ITEM.PALM_DELETE, palmDeleteData(palmID)); }

  // ---- remoteNano (trigger delay) ----
  /**
   * Remote Nano のトリガ遅延秒を設定する (CHRemoteNanoCapableImpl.setTriggerDelayTime と 1:1)。
   * itemCode 190 + [time(UByte 1B)]。応答後にデバイスが TRIGGER_DELAYTIME(191) を push しうる
   * (publish は registerDelegate の onTriggerDelaySecondReceived で受ける)。
   * @param {number} time 0..255 (秒)
   */
  async setTriggerDelay(time) { await this._req(ITEM.REMOTE_NANO_SET_TRIGGER_DELAYTIME, remoteNanoTriggerDelayData(time)); }

  // ---- face radar sensitivity ----
  /**
   * Face のレーダー感度パラメータを設定する (CHDeviceConnectCapableImpl.setRadarSensitivity と 1:1)。
   * itemCode 200 + payload を無加工で送る。payload 構造は SDK 側でも不透明 (生バイト)。
   * 受信 (RADAR_PARAM_PUBLISH=201) は registerDelegate の onRadarReceive で生 payload を受ける。
   * @param {Buffer} payload レーダーパラメータの生バイト列
   */
  async setRadarSensitivity(payload) { await this._req(ITEM.SSM_OS3_RADAR_PARAM_SET, radarSensitivityData(payload)); }

  /**
   * 子 Sesame の鍵を connector デバイスへ追加する (CHDeviceConnectCapableImpl.insertSesame と 1:1)。
   * OS3 子鍵は `{deviceUUID, secretKey}`、OS2 子鍵はそれに `sesame2PublicKey` を加えて渡す。
   * @param {{deviceUUID:string, secretKey:string|Buffer, sesame2PublicKey?:string|Buffer}} sesame
   * @returns {Promise<{resultCode:number, payload:Buffer}>}
   */
  insertSesame(sesame) {
    return this._req(ITEM.ADD_SESAME, insertSesameData(sesame));
  }

  /**
   * 子 Sesame の鍵を connector デバイスから削除する (CHDeviceConnectCapableImpl.removeSesame と 1:1)。
   * PUB_KEY_SESAME の parse 結果で keyType=0x04 なら OS2、0x05 なら OS3 として payload を切り替える。
   * @param {string} tag 削除対象 Sesame UUID
   * @param {{keyType?:number}} [opts]
   * @returns {Promise<{resultCode:number, payload:Buffer}>}
   */
  removeSesame(tag, opts = {}) {
    return this._req(ITEM.REMOVE_SESAME, removeSesameData(tag, opts));
  }

  /**
   * STP 分割転送による一括登録 (cardBatchAdd / passcodeBatchAdd 共通実体)。
   * SDK CHCardCapableImpl.kt:106-160 / CHPassCodeCapableImpl.kt:52-114 を 1:1 で移植:
   *   209B ずつに分割し、各パケットを [dataIndex(2B LE)][dataSize(2B LE)][chunk] で送る。
   *   1 パケットごとに送信完了を待ち (request の Promise が CountDownLatch 相当)、
   *   次パケットが残るなら 4 秒待つ。
   * @param {number} stpItemCode STP_ITEM_CODE_CARDS_ADD / STP_ITEM_CODE_PASSCODES_ADD
   * @param {Buffer} data 全登録データ
   * @param {(current:number,total:number)=>void} [progress] 進捗コールバック
   */
  async _batchAdd(stpItemCode, data, progress) {
    const dataSize = data.length;
    const totalPackets = Math.ceil(dataSize / MAX_BATCH_PAYLOAD);
    let dataIndex = 0;
    let currentPacket = 0;
    while (dataIndex < dataSize) {
      currentPacket += 1;
      if (typeof progress === "function") progress(currentPacket, totalPackets);
      const { packet, nextIndex } = batchAddPacket(data, dataIndex);
      await this._req(stpItemCode, packet); // 送信完了待ち (latch 相当)
      dataIndex = nextIndex;
      if (dataIndex < dataSize) await sleep(BATCH_PACKET_DELAY_MS); // 次パケットまで 4 秒
    }
  }

  /**
   * publish 受信を delegate に結線する (session.onPublish へ handleBiometricPublish を登録)。
   * @param {object} delegate handleBiometricPublish の delegate
   * @param {any} [device] コールバックへ素通しする識別子
   * @returns {() => void} unsubscribe (session.onPublish が無ければ no-op)
   */
  registerDelegate(delegate, device) {
    if (typeof this._session.onPublish !== "function") return () => {};
    return this._session.onPublish((pkt) => { handleBiometricPublish(pkt, delegate, device); });
  }

  /**
   * 実機タップ登録 (enroll) を 1 セッション単位に集約し、終端で onEnrolled へ渡す delegate を
   * 結線する registerDelegate の薄いショートカット。BLE=実機の責務はここまでで、onEnrolled の
   * 中で access.postCards/postPasscodes を呼ぶ (= DB 同期) かは呼び出し側が決める
   * (本クラスは access.js を知らない)。createEnrollCollector + registerDelegate と等価。
   *
   * @param {(batch:{kind:'card'|'passcode', records:Array<{cardID:string,cardName:string,cardType:number}>, device:any}) => void} onEnrolled
   * @param {{card?:boolean, passcode?:boolean, device?:any}} [opts]
   * @returns {() => void} unsubscribe
   */
  onEnroll(onEnrolled, { card = true, passcode = true, device } = {}) {
    return this.registerDelegate(createEnrollCollector({ onEnrolled, card, passcode }), device);
  }
}

// =====================================================================
//  enroll → access (DB 同期) ブリッジ
//
//  「実機でカード/暗証番号がタップ登録された」イベントは、生体 BLE セッションの
//  *_FIRST → *_NOTIFY(複数) → *_LAST という publish 列で届く (handleBiometricPublish が
//  onCardReceiveStart/onCardReceive/onCardReceiveEnd 等の delegate へ写像する)。
//
//  これを access.js の WS DB 同期 op (postCards/postPasscodes) へ渡すのが本ブリッジの責務。
//  ただし BLE=実機 / cloud=DB の責務分担は崩さない:
//    - 本ブリッジは BLE 側で「1 登録セッション分のレコードを集約」し、_FIRST..._LAST の窓が
//      閉じた時点で集約済みレコードを **呼び出し側が注入した sink へ素通しするだけ**。
//    - 実際の DB 書き込み (postCards/postPasscodes 送信) は sink 側 (= access.js の API を
//      呼ぶ呼び出し側) の責務。本ブリッジは access.js を import しない (層を逆流させない)。
//  SDK には「集約して DB へ送る」一体型のクラスは無く (capability=実機書き込みのみ、DB 同期は
//  アプリ層)、biz3 でも BLE ack コールバック内でアプリが postCards を投げていた。よって本ブリッジは
//  その「アプリ層の薄い糊」を 1 関数に閉じ込めたもので、新しい抽象階層は足さない。
//
//  ⚠️ 実機未検証: _FIRST/_NOTIFY/_LAST の到達順・onLast での DB 反映可否は HW で要確認。
//     ここでは handleBiometricPublish のディスパッチ契約 (既存ユニットで担保) のみに依存する。
// =====================================================================

/**
 * card / passcode の enroll publish を 1 登録セッション単位に集約し、セッション終端
 * (*_LAST) で sink へ渡す delegate を生成する。戻り値は BiometricCommands.registerDelegate /
 * handleBiometricPublish にそのまま渡せる delegate オブジェクト。
 *
 * 集約レコードは parseTouchCard 由来の { cardID, cardName, cardType } (NOTIFY で渡る 3 値)。
 * sink には kind ('card'|'passcode') と集約配列を渡すだけで、DB へどう載せるか
 * (access.toPostCardList → access.postCards 等) は呼び出し側が決める。
 *
 * @param {object} cfg
 * @param {(batch:{kind:'card'|'passcode', records:Array<{cardID:string,cardName:string,cardType:number}>, device:any}) => void} cfg.onEnrolled
 *   1 セッション分が出揃った (= *_LAST 受信) 時に呼ばれる。records が空でも呼ぶ (空登録の検知用)。
 * @param {boolean} [cfg.card=true]     card の enroll を集約するか
 * @param {boolean} [cfg.passcode=true] passcode の enroll を集約するか
 * @returns {object} handleBiometricPublish 用 delegate (onCardReceive* / onKeyBoardReceive* を実装)
 */
export function createEnrollCollector({ onEnrolled, card = true, passcode = true } = {}) {
  if (typeof onEnrolled !== "function") {
    throw new Error("biometric: createEnrollCollector requires onEnrolled(batch) callback");
  }
  // kind ごとに「現在の登録セッションで集めたレコード」を保持する。_FIRST でリセット、
  // _LAST で sink へ flush する。SDK の delegate は device 引数を第1に取るので、最後に
  // 観測した device トークンを batch に同梱して渡す。
  const buf = { card: [], passcode: [] };
  let lastDevice;

  const start = (kind) => { buf[kind] = []; };
  const push = (kind, rec) => { buf[kind].push(rec); };
  const end = (kind) => {
    const records = buf[kind];
    buf[kind] = [];
    onEnrolled({ kind: kind === "card" ? "card" : "passcode", records, device: lastDevice });
  };
  // handleBiometricPublish は (device, ...args) で呼ぶので device を捕捉する薄いラッパ。
  const cap = (fn) => (device, ...args) => { lastDevice = device; return fn(...args); };

  const delegate = {};
  if (card) {
    delegate.onCardReceiveStart = cap(() => start("card"));
    delegate.onCardReceive = cap((cardID, cardName, cardType) => push("card", { cardID, cardName, cardType }));
    delegate.onCardReceiveEnd = cap(() => end("card"));
  }
  if (passcode) {
    delegate.onKeyBoardReceiveStart = cap(() => start("passcode"));
    delegate.onKeyBoardReceive = cap((cardID, cardName, cardType) => push("passcode", { cardID, cardName, cardType }));
    delegate.onKeyBoardReceiveEnd = cap(() => end("passcode"));
  }
  return delegate;
}

/** SDK の sleep(ms) (Thread.sleep) 相当の Promise。 */
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// STP コードは itemcodes.js の STP_ITEM_CODES へ昇格済み。後方互換のため本モジュールからも
// STP_ITEM 名で再公開する (中身は同一オブジェクト)。
export { STP_ITEM_CODES as STP_ITEM };
