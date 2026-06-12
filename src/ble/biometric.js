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
import { capabilitiesForModel } from "./devicemodel.js";
// hex 変換/UUID 正規化は crypto.js に一本化 (REFACTORING_PLAN P5-4)。
import { hexToBuf, bufToHex, normalizeUuid } from "../crypto.js";

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

/**
 * hex 文字列 → Buffer (奇数長 / 非 hex は throw)。SDK hexStringToByteArray 相当。
 * 検証ロジックは crypto.js:hexToBuf に委譲し、エラー文言だけ従来の biometric 形式を維持
 * (挙動互換, P5-4)。
 * @param {string} hex
 * @returns {Buffer}
 */
function hexToBytes(hex) {
  try {
    return hexToBuf(/** @type {string} */ (hex));
  } catch {
    throw new Error(`biometric: invalid hex string: ${hex}`);
  }
}

/**
 * UUID 文字列/hex 文字列からハイフンを除去した 16B UUID を得る。
 * normalizeUuid (lowercase 込み) を使う。バイト変換で大小は無関係だが、
 * 正規化関数を統一することでコードパスを減らす (P5-4)。
 * @param {string} id
 * @returns {Buffer}
 */
function uuidToBytes(id) {
  const clean = normalizeUuid(id);
  if (!/^[0-9a-f]{32}$/.test(clean)) {
    throw new Error(`biometric: deviceUUID must be 16B hex/UUID: ${id}`);
  }
  return hexToBytes(clean);
}

/**
 * Buffer → hex 文字列 (小文字)。SDK toHexString 相当。crypto.js:bufToHex の薄い別名 (P5-4)。
 * @param {Buffer|Uint8Array} buf
 * @returns {string}
 */
function bytesToHex(buf) {
  return bufToHex(buf);
}

/**
 * 末尾を指定バイトで size までパディング (既に size 以上なら切らずそのまま)。
 * SDK ByteArray.padEnd(size, pad) 相当 (CHCardCapableImpl.kt:103 id.padEnd(16,0x00))。
 * @param {Buffer} buf
 * @param {number} size
 * @param {number} [pad]
 * @returns {Buffer}
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
 * @param {number} value
 * @returns {Buffer}
 */
function shortToReverseBytesLE(value) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(value & 0xffff);
  return b;
}

/**
 * hexName (16進文字列) を 2 文字ずつ byte に畳む。
 * SDK: hexName.chunked(2).map { it.toInt(16).toByte() } (CHCardCapableImpl.kt:162 ほか change 系)。
 * Kotlin chunked(2) は奇数長末尾の 1 文字も独立チャンクとして残す ("abc" → ["ab","c"])。
 * "c".toInt(16) = 12 (= 0x0c) となり末尾 1B が出力される。旧 JS の `i + 1 < len` は末尾を
 * 落とす誤りだった (旧コメント「末尾を捨てる Kotlin 同挙動」は参照実装の逆 = 虚偽)。
 * 修正: `i < len` に変え hexName.slice(i, i+2) で末尾 1 文字でも parseInt する。
 * @param {string} hexName
 * @returns {Buffer}
 */
function hexNameToBytes(hexName) {
  const out = [];
  for (let i = 0; i < hexName.length; i += 2) {
    out.push(parseInt(hexName.slice(i, i + 2), 16) & 0xff);
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
  // 範囲検証: Kotlin CHSesameTouchCard(data) は data[1] / data[nameIndex] / data.sliceArray(...) へ
  // 直接アクセスするため、短小入力や idLength 過大は ArrayIndexOutOfBoundsException を throw して
  // 呼び出し元 (do-while ループ) から脱出する
  // (CHSesameBiometricParseData.kt:10-17 / CHCardEventHandlers.kt:22-34)。
  // JS ポートは AIOOBE を throw に写像して同じセマンティクスを実現する。
  const idLength = buf[1]; // buf.length < 2 のとき undefined → 次の検証で捕捉
  const nameIndex = (idLength ?? 0) + 2;
  const nameLength = buf[nameIndex]; // nameIndex が範囲外のとき undefined → 捕捉
  if (
    buf.length < 2 ||
    (idLength + 2) >= buf.length ||
    (nameIndex + 1 + nameLength) > buf.length
  ) {
    throw new Error(
      `parseTouchCard: truncated record (buf=${buf.length}B idLength=${idLength} nameLength=${nameLength})`,
    );
  }
  const cardType = buf[0];
  const cardID = bytesToHex(buf.subarray(2, idLength + 2));
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
  // parseTouchCard と同型の範囲検証。CHSesameTouchFace(data) コンストラクタ
  // (CHSesameBiometricParseData.kt:28-36) も data[1] / data[nameIndex] へ直接アクセスするため
  // 短小入力は ArrayIndexOutOfBoundsException を throw する。JS ポートは throw に写像する。
  const idLength = buf[1];
  const nameIndex = (idLength ?? 0) + 2;
  const nameLength = buf[nameIndex];
  if (
    buf.length < 2 ||
    (idLength + 2) >= buf.length ||
    (nameIndex + 1 + nameLength) > buf.length
  ) {
    throw new Error(
      `parseTouchFace: truncated record (buf=${buf.length}B idLength=${idLength} nameLength=${nameLength})`,
    );
  }
  const type = buf[0];
  const id = bytesToHex(buf.subarray(2, idLength + 2));
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

/**
 * cardModeSet: data = [mode] (CHCardCapableImpl.kt:53)。
 * @param {number} mode
 * @returns {Buffer}
 */
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

/**
 * cardDelete: data = cardID(hex→bytes) (CHCardCapableImpl.kt:62)。
 * @param {string} cardID hex
 * @returns {Buffer}
 */
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
 * @param {string} ID hex
 * @param {string} hexName hex
 * @returns {Buffer}
 */
export function cardChangeData(ID, hexName) {
  const idBuf = hexToBytes(ID);
  return Buffer.concat([Buffer.from([idBuf.length]), idBuf, hexNameToBytes(hexName)]);
}

/**
 * cardChangeValue: data = [idLen] ++ id(hex→bytes) ++ newID(UTF-8) (CHCardCapableImpl.kt:174)。
 * @param {string} ID hex
 * @param {string} newID UTF-8 文字列
 * @returns {Buffer}
 */
export function cardChangeValueData(ID, newID) {
  const idBuf = hexToBytes(ID);
  return Buffer.concat([Buffer.from([idBuf.length]), idBuf, Buffer.from(newID, "utf8")]);
}

// ---- fingerPrint (CHFingerPrintCapableImpl.kt) ----

/** @param {number} mode @returns {Buffer} */
export function fingerPrintModeSetData(mode) { return Buffer.from([mode & 0xff]); }
export function fingerPrintModeGetData() { return Buffer.alloc(0); }
export function fingerPrintGetData() { return Buffer.alloc(0); }
/**
 * fingerPrintDelete: data = fingerPrintID(hex→bytes) (CHFingerPrintCapableImpl.kt:50)。
 * @param {string} fingerPrintID hex
 * @returns {Buffer}
 */
export function fingerPrintDeleteData(fingerPrintID) { return hexToBytes(fingerPrintID); }
/**
 * fingerPrintsChange: data = [idLen] ++ id(hex→bytes) ++ hexName(畳んだ bytes) (CHFingerPrintCapableImpl.kt:74)。
 * @param {string} ID hex
 * @param {string} hexName hex
 * @returns {Buffer}
 */
export function fingerPrintChangeData(ID, hexName) {
  const idBuf = hexToBytes(ID);
  return Buffer.concat([Buffer.from([idBuf.length]), idBuf, hexNameToBytes(hexName)]);
}

// ---- passcode (CHPassCodeCapableImpl.kt) ----

/** @param {number} mode @returns {Buffer} */
export function passcodeModeSetData(mode) { return Buffer.from([mode & 0xff]); }
export function passcodeModeGetData() { return Buffer.alloc(0); }
export function passcodeGetData() { return Buffer.alloc(0); }

/**
 * keyBoardPassCodeAdd: data = [F0][00][idLen] ++ id.padEnd(16) ++ [nameLen] ++ name.padEnd(16)
 * (CHPassCodeCapableImpl.kt:44-49)。card と同一レイアウト (定数名のみ KB_*)。
 * @param {Buffer} id
 * @param {string} hexName
 * @returns {Buffer}
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

/**
 * keyBoardPassCodeDelete: data = id(hex→bytes) (CHPassCodeCapableImpl.kt:104)。
 * @param {string} keyBoardPassCodeID hex
 * @returns {Buffer}
 */
export function passcodeDeleteData(keyBoardPassCodeID) { return hexToBytes(keyBoardPassCodeID); }
/**
 * keyBoardPassCodeMove: data = [idLen] ++ id(hex→bytes) ++ touchProUUID(UTF-8) (CHPassCodeCapableImpl.kt:113)。
 * @param {string} cardId hex
 * @param {string} touchProUUID UTF-8
 * @returns {Buffer}
 */
export function passcodeMoveData(cardId, touchProUUID) {
  const idBuf = hexToBytes(cardId);
  return Buffer.concat([Buffer.from([idBuf.length]), idBuf, Buffer.from(touchProUUID, "utf8")]);
}
/**
 * keyBoardPassCodeChange: data = [idLen] ++ id(hex→bytes) ++ hexName(畳んだ bytes) (CHPassCodeCapableImpl.kt:123)。
 * @param {string} ID hex
 * @param {string} hexName hex
 * @returns {Buffer}
 */
export function passcodeChangeData(ID, hexName) {
  const idBuf = hexToBytes(ID);
  return Buffer.concat([Buffer.from([idBuf.length]), idBuf, hexNameToBytes(hexName)]);
}

// ---- face (CHFaceCapableImpl.kt) ----

/** @param {number} mode @returns {Buffer} */
export function faceModeSetData(mode) { return Buffer.from([mode & 0xff]); }
export function faceModeGetData() { return Buffer.alloc(0); }
export function faceGetData() { return Buffer.alloc(0); }
/**
 * faceChange: data = [idLen] ++ id(hex→bytes) ++ name(畳んだ bytes) (CHFaceCapableImpl.kt:50)。
 * @param {string} ID hex
 * @param {string} name hex
 * @returns {Buffer}
 */
export function faceChangeData(ID, name) {
  const idBuf = hexToBytes(ID);
  return Buffer.concat([Buffer.from([idBuf.length]), idBuf, hexNameToBytes(name)]);
}
/**
 * faceDelete: data = [faceID(hex→単一 byte)] (CHFaceCapableImpl.kt:56 byteArrayOf(faceID.toInt(16).toByte()))。
 * @param {string} faceID hex
 * @returns {Buffer}
 */
export function faceDeleteData(faceID) { return Buffer.from([parseInt(faceID, 16) & 0xff]); }

// ---- palm (CHPalmCapableImpl.kt) ----

/** @param {number} mode @returns {Buffer} */
export function palmModeSetData(mode) { return Buffer.from([mode & 0xff]); }
export function palmModeGetData() { return Buffer.alloc(0); }
export function palmGetData() { return Buffer.alloc(0); }
/**
 * palmDelete: data = [palmID(hex→単一 byte)] (CHPalmCapableImpl.kt:47)。
 * @param {string} palmID hex
 * @returns {Buffer}
 */
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
export function insertSesameData({ deviceUUID, secretKey, sesame2PublicKey } = /** @type {{deviceUUID:string, secretKey:string|Buffer, sesame2PublicKey?:string|Buffer}} */ ({})) {
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
 * publish パケット 1 件 (session.onPublish が渡す {opCode, itemCode, body})。
 * @typedef {{itemCode:number, body?:Buffer, payload?:Buffer}} BiometricPublishPacket
 */

/**
 * handleBiometricPublish が呼ぶ delegate。全コールバックは任意 (未定義なら no-op)。
 * 第1引数は呼び出し側が渡す device トークン (省略可)。SDK CH*Delegate.kt と 1:1。
 * @typedef {Object} BiometricDelegate
 * @property {(device?: unknown) => void} [onCardReceiveStart]
 * @property {(device: unknown, cardID: string, cardName: string, cardType: number) => void} [onCardReceive]
 * @property {(device?: unknown) => void} [onCardReceiveEnd]
 * @property {(device: unknown, cardID: string, cardName: string, cardType: number) => void} [onCardChanged]
 * @property {(device: unknown, mode: number) => void} [onCardModeChanged]
 * @property {(device: unknown, cardID: string) => void} [onCardDelete]
 * @property {(device?: unknown) => void} [onFingerPrintReceiveStart]
 * @property {(device: unknown, cardID: string, cardName: string, cardType: number) => void} [onFingerPrintReceive]
 * @property {(device?: unknown) => void} [onFingerPrintReceiveEnd]
 * @property {(device: unknown, cardID: string, cardName: string, cardType: number) => void} [onFingerPrintChanged]
 * @property {(device: unknown, mode: number) => void} [onFingerModeChange]
 * @property {(device: unknown, id: string) => void} [onFingerDelete]
 * @property {(device?: unknown) => void} [onKeyBoardReceiveStart]
 * @property {(device: unknown, cardID: string, cardName: string, cardType: number) => void} [onKeyBoardReceive]
 * @property {(device?: unknown) => void} [onKeyBoardReceiveEnd]
 * @property {(device: unknown, cardID: string, cardName: string, cardType: number) => void} [onKeyBoardChanged]
 * @property {(device: unknown, mode: number) => void} [onKeyBoardModeChange]
 * @property {(device: unknown, id: string) => void} [onKeyBoardDelete]
 * @property {(device?: unknown) => void} [onFaceReceiveStart]
 * @property {(device: unknown, face: ReturnType<typeof parseTouchFace>) => void} [onFaceReceive]
 * @property {(device?: unknown) => void} [onFaceReceiveEnd]
 * @property {(device: unknown, face: ReturnType<typeof parseTouchFace>) => void} [onFaceChanged]
 * @property {(device: unknown, mode: number) => void} [onFaceModeChanged]
 * @property {(device: unknown, faceID: number, ok: boolean) => void} [onFaceDeleted]
 * @property {(device?: unknown) => void} [onPalmReceiveStart]
 * @property {(device: unknown, face: ReturnType<typeof parseTouchFace>) => void} [onPalmReceive]
 * @property {(device?: unknown) => void} [onPalmReceiveEnd]
 * @property {(device: unknown, face: ReturnType<typeof parseTouchFace>) => void} [onPalmChanged]
 * @property {(device: unknown, mode: number) => void} [onPalmModeChanged]
 * @property {(device: unknown, palmID: number, ok: boolean) => void} [onPalmDeleted]
 * @property {(device: unknown, setting: ReturnType<typeof parseRemoteNanoTrigger>) => void} [onTriggerDelaySecondReceived]
 * @property {(device: unknown, payload: Buffer) => void} [onRadarReceive]
 * @property {(device: unknown, status: ReturnType<typeof parseBiometricMechStatus>) => void} [onMechStatus]
 * @property {(device: unknown, keys: ReturnType<typeof parsePubKeySesame>) => void} [onSesameKeysReceived]
 * @property {(device: unknown, payloadHex: string) => void} [onBatteryVoltageReceived]
 * @property {(device: unknown, support: boolean) => void} [onSupportChanged]
 * @property {(device: unknown, txPower: number) => void} [onBleTxPowerReceive]
 */

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
 * @param {BiometricPublishPacket} pkt    publish パケット (session.onPublish の引数)
 * @param {BiometricDelegate} delegate  下記コールバックの一部または全部を持つオブジェクト
 * @param {unknown} [device]     コールバックへ素通しする識別子 (省略可)
 * @param {{isRemote?:(boolean|null), isOpenSensor?:boolean}} [opts] 機種文脈 (P3-15 の model 伝搬):
 *   - isRemote: Remote/Remote Nano 系か。SDK は TRIGGER_DELAYTIME(191) publish を
 *     device.isRemote() のときだけ delegate へ流す (CHRemoteNanoEventHandler.kt:15-21。BLEP-09)。
 *     false を渡すと 191 は「処理済み・dispatch 無し」(SDK の handled=true と同義)。
 *     省略 (null) 時は機種不明として従来どおり dispatch する (後方互換。ファサード経由では
 *     BiometricCommands が model から確定値を渡す)。
 *   - isOpenSensor: OpenSensor 系か。PUB_KEY_SESAME(102) の空きスロット判定が >1 になる
 *     (CHSesameBiometricDeviceImpl.kt:225-231。BLEP-11)。既定 false。
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
 *                  ※ slotFull の OpenSensor 判定 (>1) は opts.isOpenSensor で切り替わる (BLEP-11)。
 *   battery:     onBatteryVoltageReceived(payloadHex)  (kt:185-187 reportBatteryData(payload.toHexString()))
 *   support:     onSupportChanged(false)               (kt:189-192 setSupport(false))
 *   bleTxPower:  onBleTxPowerReceive(txPower)           (kt:194-197 bleTxPower=payload[0]、符号付き 1B)
 */
export function handleBiometricPublish(pkt, delegate, device, { isRemote = null, isOpenSensor = false } = {}) {
  if (!pkt || !delegate) return false;
  const { itemCode } = pkt;
  const payload = Buffer.from(pkt.body ?? pkt.payload ?? Buffer.alloc(0));
  /**
   * delegate コールバックを device 先頭で呼ぶ薄いディスパッチ。各コールバックは
   * BiometricDelegate で型付けされ呼び出し側引数も型検査されるが、ここは可変アリティを
   * 受ける汎用ディスパッチなので fn は緩い callable で受ける (実引数の型は呼び出し箇所で確定)。
   * @param {((...a: any[]) => void)|undefined} fn
   * @param {...unknown} args
   */
  const call = (fn, ...args) => { if (typeof fn === "function") fn(device, ...args); };

  switch (itemCode) {
    // ---- card ----
    case ITEM.CARD_FIRST:
      call(delegate.onCardReceiveStart); return true;
    case ITEM.CARD_LAST:
      call(delegate.onCardReceiveEnd); return true;
    case ITEM.CARD_NOTIFY: {
      // NOTIFY は複数レコードの連結 (CHCardEventHandlers.kt:31-39)。recordSize ずつ前進。
      // parseTouchCard が throw したら当該レコードを破棄してループ脱出する
      // (Kotlin は CHSesameTouchCard コンストラクタの AIOOBE で自然脱出: kt:22-34)。
      let rest = payload;
      while (rest.length > 0) {
        try {
          const card = parseTouchCard(rest);
          call(delegate.onCardReceive, card.cardID, card.cardName, card.cardType);
          if (card.recordSize <= 0 || card.recordSize > rest.length) break;
          rest = rest.subarray(card.recordSize);
        } catch {
          break;
        }
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
      // parseTouchCard が throw したら当該レコードを破棄してループ脱出する
      // (Kotlin は CHSesameTouchCard コンストラクタの AIOOBE で自然脱出: kt:22-34)。
      let rest = payload;
      while (rest.length > 0) {
        try {
          const card = parseTouchCard(rest);
          call(delegate.onKeyBoardReceive, card.cardID, card.cardName, card.cardType);
          if (card.recordSize <= 0 || card.recordSize > rest.length) break;
          rest = rest.subarray(card.recordSize);
        } catch {
          break;
        }
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
      // parse し、**device.isRemote() のときだけ** onTriggerDelaySecondReceived へ流す
      // (isRemote() は remote と remote_nano の両機種で真 — どちらも BiometricDeviceType.REMOTE
      // で生成される。CHDeivceProtocols.kt:112,118)。handled は機種に関わらず true (kt:21)。
      // opts.isRemote === false (= 機種確定で非 Remote) なら dispatch を黙殺する (BLEP-09)。
      // 機種不明 (null) は従来互換で dispatch する (ファサードは model から確定値を渡す)。
      if (isRemote === false) return true;
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
      // 空きスロット判定は opts.isOpenSensor で確定する (OpenSensor/OpenSensor2 は hub3 用に
      // 1 スロット予約するため「全ゼロチャンク >1」で空きあり。kt:225-231。BLEP-11)。
      // ファサード経由では BiometricCommands が model から確定値を渡す。既定 false (非 OpenSensor)。
      call(delegate.onSesameKeysReceived, parsePubKeySesame(payload, { isOpenSensor }));
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

/**
 * BiometricCommands が消費する session の最小契約 (SesameBleSession 互換)。
 * @typedef {Object} BiometricSession
 * @property {(itemCode: number, data: Buffer, opts?: object) => Promise<{resultCode:number, payload:Buffer}>} request
 * @property {(fn: (pkt: BiometricPublishPacket) => void) => (() => void)} [onPublish]
 */

export class BiometricCommands {
  /**
   * @param {BiometricSession} session SesameBleSession 互換 (request(itemCode,data)→Promise<{resultCode,payload}> と
   *                         onPublish(fn)→unsubscribe を持つこと)。
   * @param {{model?:(string|null)}} [opts] model: デバイス model 文字列 (例 "remote_nano")。
   *   渡すと publish ディスパッチに機種文脈が伝搬する (P3-15 の model 伝搬):
   *     - isRemote: TRIGGER_DELAYTIME(191) を remote/remote_nano 以外で黙殺 (BLEP-09、
   *       CHRemoteNanoEventHandler.kt:15-21)
   *     - isOpenSensor: PUB_KEY_SESAME の空きスロット判定を >1 に (BLEP-11、
   *       CHSesameBiometricDeviceImpl.kt:225-231)
   *   省略時は機種不明として従来挙動 (191 dispatch あり / 非 OpenSensor 判定)。
   */
  constructor(session, { model = null } = {}) {
    if (!session || typeof session.request !== "function") {
      throw new Error("biometric: session with request() is required");
    }
    this._session = session;
    this._model = model;
    const caps = model ? capabilitiesForModel(model) : null;
    /** @type {boolean|null} 機種不明 (model 省略) は null = 従来互換で dispatch。 */
    this._isRemote = caps ? caps.isRemote : null;
    /** @type {boolean} */
    this._isOpenSensor = caps ? caps.isOpenSensor : false;
  }

  /**
   * request の薄いラッパ (将来 timeout 等を一括調整できるよう一箇所に集約)。
   * @param {number} itemCode
   * @param {Buffer} data
   * @returns {Promise<{resultCode:number, payload:Buffer}>}
   */
  _req(itemCode, data) { return this._session.request(itemCode, data); }

  // ---- card ----
  // 送信系 (ModeSet/Get 以外) は request の ack ({resultCode,payload}) を **そのまま返す**。
  // これにより SURF-08 の `ble.biometric.<op>` 生成ハンドラが bleCommandAck(r) で
  // {resultCode,resultName} を組める (旧実装は await で ack を捨てていたため "ack" 契約に乗らず、
  // 生成ハンドラが undefined.resultCode で落ちていた)。ModeGet 系は parse 結果 (raw) を返す。
  /**
   * 登録モード設定。応答後にデバイスが CARD_FIRST/NOTIFY/LAST を push する。
   * @param {number} mode
   * @returns {Promise<{resultCode:number, payload:Buffer}>}
   */
  cardModeSet(mode) { return this._req(ITEM.CARD_MODE_SET, cardModeSetData(mode)); }
  async cardModeGet() { const r = await this._req(ITEM.CARD_MODE_GET, cardModeGetData()); return r.payload[0]; }
  /** @returns {Promise<{resultCode:number, payload:Buffer}>} */
  cardGet() { return this._req(ITEM.CARD_GET, cardGetData()); }
  /** @param {Buffer} id @param {string} hexName @returns {Promise<{resultCode:number, payload:Buffer}>} */
  cardAdd(id, hexName) { return this._req(ITEM.CARD_ADD, cardAddData(id, hexName)); }
  /** @param {string} cardID @returns {Promise<{resultCode:number, payload:Buffer}>} */
  cardDelete(cardID) { return this._req(ITEM.CARD_DELETE, cardDeleteData(cardID)); }
  /** @param {string} cardId @param {string} touchProUUID @returns {Promise<{resultCode:number, payload:Buffer}>} */
  cardMove(cardId, touchProUUID) { return this._req(ITEM.CARD_MOVE, cardMoveData(cardId, touchProUUID)); }
  /** @param {string} ID @param {string} hexName @returns {Promise<{resultCode:number, payload:Buffer}>} */
  cardChange(ID, hexName) { return this._req(ITEM.CARD_CHANGE, cardChangeData(ID, hexName)); }
  /** @param {string} ID @param {string} newID @returns {Promise<{resultCode:number, payload:Buffer}>} */
  cardChangeValue(ID, newID) { return this._req(ITEM.CARD_CHANGE_VALUE, cardChangeValueData(ID, newID)); }
  /**
   * card の一括登録 (STP 分割転送)。STP_ITEM_CODE_CARDS_ADD で送る。
   * @param {Buffer} id @param {(current:number,total:number)=>void} [progress]
   */
  cardBatchAdd(id, progress) { return this._batchAdd(STP_ITEM.STP_ITEM_CODE_CARDS_ADD, Buffer.from(id), progress); }

  // ---- fingerPrint ----
  /** @param {number} mode @returns {Promise<{resultCode:number, payload:Buffer}>} */
  fingerPrintModeSet(mode) { return this._req(ITEM.FINGERPRINT_MODE_SET, fingerPrintModeSetData(mode)); }
  async fingerPrintModeGet() { const r = await this._req(ITEM.FINGERPRINT_MODE_GET, fingerPrintModeGetData()); return r.payload[0]; }
  /** @returns {Promise<{resultCode:number, payload:Buffer}>} */
  fingerPrints() { return this._req(ITEM.FINGERPRINT_GET, fingerPrintGetData()); }
  /** @param {string} fingerPrintID @returns {Promise<{resultCode:number, payload:Buffer}>} */
  fingerPrintDelete(fingerPrintID) { return this._req(ITEM.FINGERPRINT_DELETE, fingerPrintDeleteData(fingerPrintID)); }
  /** @param {string} ID @param {string} hexName @returns {Promise<{resultCode:number, payload:Buffer}>} */
  fingerPrintChange(ID, hexName) { return this._req(ITEM.FINGERPRINT_CHANGE, fingerPrintChangeData(ID, hexName)); }

  // ---- passcode ----
  /** @param {number} mode @returns {Promise<{resultCode:number, payload:Buffer}>} */
  passcodeModeSet(mode) { return this._req(ITEM.PASSCODE_MODE_SET, passcodeModeSetData(mode)); }
  async passcodeModeGet() { const r = await this._req(ITEM.PASSCODE_MODE_GET, passcodeModeGetData()); return r.payload[0]; }
  /** @returns {Promise<{resultCode:number, payload:Buffer}>} */
  passcodeGet() { return this._req(ITEM.PASSCODE_GET, passcodeGetData()); }
  /** @param {Buffer} id @param {string} hexName @returns {Promise<{resultCode:number, payload:Buffer}>} */
  passcodeAdd(id, hexName) { return this._req(ITEM.PASSCODE_ADD, passcodeAddData(id, hexName)); }
  /** @param {string} keyBoardPassCodeID @returns {Promise<{resultCode:number, payload:Buffer}>} */
  passcodeDelete(keyBoardPassCodeID) { return this._req(ITEM.PASSCODE_DELETE, passcodeDeleteData(keyBoardPassCodeID)); }
  /** @param {string} cardId @param {string} touchProUUID @returns {Promise<{resultCode:number, payload:Buffer}>} */
  passcodeMove(cardId, touchProUUID) { return this._req(ITEM.PASSCODE_MOVE, passcodeMoveData(cardId, touchProUUID)); }
  /** @param {string} ID @param {string} hexName @returns {Promise<{resultCode:number, payload:Buffer}>} */
  passcodeChange(ID, hexName) { return this._req(ITEM.PASSCODE_CHANGE, passcodeChangeData(ID, hexName)); }
  /**
   * passcode の一括登録 (STP 分割転送)。STP_ITEM_CODE_PASSCODES_ADD で送る。
   * @param {Buffer} data @param {(current:number,total:number)=>void} [progress]
   */
  passcodeBatchAdd(data, progress) { return this._batchAdd(STP_ITEM.STP_ITEM_CODE_PASSCODES_ADD, Buffer.from(data), progress); }

  // ---- face ----
  /** @param {number} mode @returns {Promise<{resultCode:number, payload:Buffer}>} */
  faceModeSet(mode) { return this._req(ITEM.FACE_MODE_SET, faceModeSetData(mode)); }
  async faceModeGet() {
    const r = await this._req(ITEM.FACE_MODE_GET, faceModeGetData());
    if (!r.payload || r.payload.length === 0) throw new Error(`biometric: faceModeGet data error: ${bytesToHex(r.payload ?? Buffer.alloc(0))}`);
    return r.payload[0];
  }
  /** @returns {Promise<{resultCode:number, payload:Buffer}>} */
  faceListGet() { return this._req(ITEM.FACE_GET, faceGetData()); }
  /** @param {string} ID @param {string} name @returns {Promise<{resultCode:number, payload:Buffer}>} */
  faceChange(ID, name) { return this._req(ITEM.FACE_CHANGE, faceChangeData(ID, name)); }
  /** @param {string} faceID @returns {Promise<{resultCode:number, payload:Buffer}>} */
  faceDelete(faceID) { return this._req(ITEM.FACE_DELETE, faceDeleteData(faceID)); }

  // ---- palm ----
  /** @param {number} mode @returns {Promise<{resultCode:number, payload:Buffer}>} */
  palmModeSet(mode) { return this._req(ITEM.PALM_MODE_SET, palmModeSetData(mode)); }
  async palmModeGet() {
    const r = await this._req(ITEM.PALM_MODE_GET, palmModeGetData());
    if (!r.payload || r.payload.length === 0) throw new Error(`biometric: palmModeGet data error: ${bytesToHex(r.payload ?? Buffer.alloc(0))}`);
    return r.payload[0];
  }
  /** @returns {Promise<{resultCode:number, payload:Buffer}>} */
  palmListGet() { return this._req(ITEM.PALM_GET, palmGetData()); }
  /** @param {string} palmID @returns {Promise<{resultCode:number, payload:Buffer}>} */
  palmDelete(palmID) { return this._req(ITEM.PALM_DELETE, palmDeleteData(palmID)); }

  // ---- remoteNano (trigger delay) ----
  /**
   * Remote Nano のトリガ遅延秒を設定する (CHRemoteNanoCapableImpl.setTriggerDelayTime と 1:1)。
   * itemCode 190 + [time(UByte 1B)]。応答後にデバイスが TRIGGER_DELAYTIME(191) を push しうる
   * (publish は registerDelegate の onTriggerDelaySecondReceived で受ける)。
   * @param {number} time 0..255 (秒)
   * @returns {Promise<{resultCode:number, payload:Buffer}>}
   */
  // async を保つことで UByte 範囲外の検証エラーを **同期 throw でなく rejected promise** にする
  // (呼び出し側の await ... .rejects 契約を維持。本体は ack をそのまま返し "ack" 契約に乗る)。
  async setTriggerDelay(time) { return this._req(ITEM.REMOTE_NANO_SET_TRIGGER_DELAYTIME, remoteNanoTriggerDelayData(time)); }

  // ---- face radar sensitivity ----
  /**
   * Face のレーダー感度パラメータを設定する (CHDeviceConnectCapableImpl.setRadarSensitivity と 1:1)。
   * itemCode 200 + payload を無加工で送る。payload 構造は SDK 側でも不透明 (生バイト)。
   * 受信 (RADAR_PARAM_PUBLISH=201) は registerDelegate の onRadarReceive で生 payload を受ける。
   * @param {Buffer} payload レーダーパラメータの生バイト列
   * @returns {Promise<{resultCode:number, payload:Buffer}>}
   */
  setRadarSensitivity(payload) { return this._req(ITEM.SSM_OS3_RADAR_PARAM_SET, radarSensitivityData(payload)); }

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
   * コンストラクタへ渡した model から確定した機種文脈 (isRemote / isOpenSensor) を
   * handleBiometricPublish へ伝搬する (BLEP-09 / BLEP-11)。
   * @param {BiometricDelegate} delegate handleBiometricPublish の delegate
   * @param {unknown} [device] コールバックへ素通しする識別子
   * @returns {() => void} unsubscribe (session.onPublish が無ければ no-op)
   */
  registerDelegate(delegate, device) {
    if (typeof this._session.onPublish !== "function") return () => {};
    const opts = { isRemote: this._isRemote, isOpenSensor: this._isOpenSensor };
    return this._session.onPublish((/** @type {BiometricPublishPacket} */ pkt) => { handleBiometricPublish(pkt, delegate, device, opts); });
  }

  /**
   * 実機タップ登録 (enroll) を 1 セッション単位に集約し、終端で onEnrolled へ渡す delegate を
   * 結線する registerDelegate の薄いショートカット。BLE=実機の責務はここまでで、onEnrolled の
   * 中で access.postCards/postPasscodes を呼ぶ (= DB 同期) かは呼び出し側が決める
   * (本クラスは access.js を知らない)。createEnrollCollector + registerDelegate と等価。
   *
   * @param {(batch: EnrollBatch) => void} onEnrolled
   * @param {{card?:boolean, passcode?:boolean, device?:unknown}} [opts]
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
 * 集約レコードは parseTouchCard 由来の { cardID, cardName, cardType } (NOTIFY で渡る 3 値) に、
 * 取れる場合は **ファームウェア採番の nameUUID** を加えた 4 値 (P3-11)。
 *
 * nameUUID の出典トレース:
 *   - BLE NOTIFY/ack payload の「名前」位置 ([type 1B][idLen 1B][id idLen B][nameLen 1B][name nameLen B]、
 *     CHSesameBiometricParseData.kt:10-17 CHSesameTouchCard) に、ファームはタップ登録時に
 *     **自前で採番した 16B UUID** を載せる。biz3 web は同じ位置のフィールドを `nameUUID` として
 *     読み (references_web/src/utils/biz3utils.js:365-391 parseHexStrToCardInfo: id の後の
 *     [nameUUIDLen 1B][nameUUID 16B]。passcode は :393-420 parseHexStrToPasscodeInfo で id 枠 16B
 *     固定の後に同形)、タップ登録の ack ではこの値を updateCardName へそのまま渡して DB と
 *     ファームの nameUUID を一致させる (references_web/src/pages/biz/cards/index.js:104-136)。
 *   - よって BLE 側では parseTouchCard の cardName (hex) が名前位置のフィールドであり、
 *     それが 16B (= 32 hex) のとき「ファーム採番の nameUUID」とみなして record.nameUUID に載せる。
 *     16B でない場合 (ユーザーが短い表示名へ rename 済み等) は省略する (取れない種別では省略可)。
 *   - 値は parseTouchFace と同じ方針で **ハイフン無し hex (小文字)** のまま返す。web の表示は
 *     insertUUIDIsolationCharacter (biz3utils.js:236-238) でハイフン整形しているだけで、識別子と
 *     しての値は hex と同値 (ハイフン整形は消費側 access.js の責務)。
 *
 * sink には kind ('card'|'passcode') と集約配列を渡すだけで、DB へどう載せるか
 * (access.toPostCardList → access.postCards 等) は呼び出し側が決める。
 *
 * 集約済みの 1 enroll セッション分のレコード。
 * @typedef {Object} EnrollRecord
 * @property {string} cardID
 * @property {string} cardName
 * @property {number} cardType
 * @property {string} [nameUUID] ファームウェア採番の nameUUID (32hex 小文字・ハイフン無し)。
 *   NOTIFY の名前フィールドが 16B のときのみ存在 (P3-11。access.js 側が postCards/updateCardName
 *   の同期に消費する)。
 *
 * @typedef {Object} EnrollBatch
 * @property {'card'|'passcode'} kind
 * @property {EnrollRecord[]} records
 * @property {unknown} device
 *
 * @param {{onEnrolled?: (batch: EnrollBatch) => void, card?: boolean, passcode?: boolean}} [cfg]
 *   onEnrolled: 1 セッション分が出揃った (= *_LAST 受信) 時に呼ばれる。records が空でも呼ぶ (空登録の検知用)。
 *   card/passcode: それぞれの enroll を集約するか (既定 true)。
 * @returns {BiometricDelegate} handleBiometricPublish 用 delegate (onCardReceive* / onKeyBoardReceive* を実装)
 */
export function createEnrollCollector({ onEnrolled, card = true, passcode = true } = {}) {
  if (typeof onEnrolled !== "function") {
    throw new Error("biometric: createEnrollCollector requires onEnrolled(batch) callback");
  }
  const sink = onEnrolled; // ガード後の確定値をクロージャへ束縛
  // kind ごとに「現在の登録セッションで集めたレコード」を保持する。_FIRST でリセット、
  // _LAST で sink へ flush する。SDK の delegate は device 引数を第1に取るので、最後に
  // 観測した device トークンを batch に同梱して渡す。
  /** @type {{card: EnrollRecord[], passcode: EnrollRecord[]}} */
  const buf = { card: [], passcode: [] };
  /** @type {unknown} */
  let lastDevice;

  /** @param {'card'|'passcode'} kind */
  const start = (kind) => { buf[kind] = []; };
  /** @param {'card'|'passcode'} kind @param {EnrollRecord} rec */
  const push = (kind, rec) => { buf[kind].push(rec); };
  /**
   * NOTIFY の名前フィールド (parseTouchCard の cardName, hex) からファーム採番の nameUUID を導く。
   * 16B (= 32 hex) のときのみ nameUUID とみなす (ファームのタップ登録採番は 16B UUID 固定 —
   * references_web/src/utils/biz3utils.js:378-385 nameUUIDLen=16 / cards/index.js:104-136)。
   * @param {string} cardName parseTouchCard の cardName (hex)
   * @returns {{nameUUID?: string}} 16B でなければ空オブジェクト (record へ spread して省略)
   */
  const nameUUIDOf = (cardName) => (
    /^[0-9a-f]{32}$/.test(cardName) ? { nameUUID: cardName } : {}
  );
  /** @param {'card'|'passcode'} kind */
  const end = (kind) => {
    const records = buf[kind];
    buf[kind] = [];
    sink({ kind: kind === "card" ? "card" : "passcode", records, device: lastDevice });
  };
  // handleBiometricPublish は (device, ...args) で呼ぶので device を捕捉する薄いラッパ。
  /**
   * @param {(...a: any[]) => void} fn
   * @returns {(device: unknown, ...args: any[]) => void}
   */
  const cap = (fn) => (device, ...args) => { lastDevice = device; return fn(...args); };

  /** @type {BiometricDelegate} */
  const delegate = {};
  if (card) {
    delegate.onCardReceiveStart = cap(() => start("card"));
    delegate.onCardReceive = cap((cardID, cardName, cardType) => push("card", { cardID, cardName, cardType, ...nameUUIDOf(cardName) }));
    delegate.onCardReceiveEnd = cap(() => end("card"));
  }
  if (passcode) {
    delegate.onKeyBoardReceiveStart = cap(() => start("passcode"));
    delegate.onKeyBoardReceive = cap((cardID, cardName, cardType) => push("passcode", { cardID, cardName, cardType, ...nameUUIDOf(cardName) }));
    delegate.onKeyBoardReceiveEnd = cap(() => end("passcode"));
  }
  return delegate;
}

/**
 * SDK の sleep(ms) (Thread.sleep) 相当の Promise。
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// STP コードは itemcodes.js の STP_ITEM_CODES へ昇格済み。後方互換のため本モジュールからも
// STP_ITEM 名で再公開する (中身は同一オブジェクト)。
export { STP_ITEM_CODES as STP_ITEM };

// =====================================================================
//  P1-8 (R2:SURF-26 + R2:SURF-39): 生体一覧収集ヘルパ
//
//  CLI の `sesame ble cards|passcodes|fingers|faces|palms <device>` と
//  serve の `ble.biometric.cardGet` 等の専用収集ハンドラが共通で使う publish 収集ロジック。
//  元は cli/ble.js にのみ存在したが、serve 経由でも SDK 消費者が一覧を取得できるよう
//  biometric.js へ移管して export する (CLI は import に差し替え)。
//
//  設計: GET 要求 → デバイスが publish(FIRST → NOTIFY×N → LAST/END) を返す設計で、
//  END 受信または timeout で収集を確定する。同一実装の参照パターンは
//  serve/registry.js の collectWifiScan (ble.wifi.scan の専用収集ハンドラ)。
// =====================================================================

/**
 * 生体タイプ別の「GET メソッド名」と「収集に使う delegate コールバック名」。
 * CLI (cli/ble.js) と serve (registry.js の専用収集ハンドラ) の両方が参照する。
 * @typedef {{ getter: string, start: string, recv: string, end: string, single?: boolean }} BioSpec
 */

/**
 * card/passcode/finger/face/palm ごとの spec 表。
 * 出典: BiometricCommands の各 getter (cardGet/passcodeGet/fingerPrints/faceListGet/palmListGet) と
 *   registerDelegate の delegate コールバック名 (CHCard/PassCode/FingerPrint/Face/PalmEventHandlers.kt)。
 * @type {Readonly<Record<string, BioSpec>>}
 */
export const BIO_LIST = Object.freeze({
  card: { getter: "cardGet", start: "onCardReceiveStart", recv: "onCardReceive", end: "onCardReceiveEnd" },
  passcode: { getter: "passcodeGet", start: "onKeyBoardReceiveStart", recv: "onKeyBoardReceive", end: "onKeyBoardReceiveEnd" },
  finger: { getter: "fingerPrints", start: "onFingerPrintReceiveStart", recv: "onFingerPrintReceive", end: "onFingerPrintReceiveEnd" },
  face: { getter: "faceListGet", start: "onFaceReceiveStart", recv: "onFaceReceive", end: "onFaceReceiveEnd", single: true },
  palm: { getter: "palmListGet", start: "onPalmReceiveStart", recv: "onPalmReceive", end: "onPalmReceiveEnd", single: true },
});

/**
 * Buffer/Uint8Array の名前を UTF-8 文字列へ変換する。既に文字列ならそのまま返す。
 * CLI (cli/ble.js の bufToText) と同一ロジックをここに一本化する。
 * @param {unknown} v
 * @returns {string}
 */
function bioNameToText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    const s = Buffer.from(/** @type {Uint8Array|number[]} */ (v)).toString("utf8");
    let end = s.length;
    // 末尾 NUL 除去 (ReDoS 懸念のため正規表現 /\0+$/ を避けて線形ループで処理する)。
    while (end > 0 && s.charCodeAt(end - 1) === 0x00) end--;
    return s.slice(0, end);
  } catch { return String(v); }
}

/**
 * GET 要求 → publish(FIRST → NOTIFY×N → LAST/END) を収集し、END または timeout で確定する。
 *
 * serve の collectWifiScan (registry.js) と同パターン:
 *   1. registerDelegate でコールバックを登録する
 *   2. getter を呼ぶ (ack は即返るが実データは publish で来る)
 *   3. END コールバック or timeout で resolve する
 *
 * spec.single=true の場合 (face/palm): recv コールバックは (device, obj) の形で
 *   obj がパース済みオブジェクト。false (card/passcode/finger): (device, id, name, cardType) の
 *   形で {id, name(UTF-8化), type} に整形する。
 *
 * @param {Record<string, Function>} cmds  BiometricCommands インスタンス (registerDelegate + getter を持つ)
 * @param {BioSpec} spec  BIO_LIST の 1 entry
 * @param {number} timeoutMs
 * @returns {Promise<unknown[]>}
 */
export function collectBiometricList(cmds, spec, timeoutMs) {
  return new Promise((/** @type {(records: unknown[]) => void} */ resolve) => {
    /** @type {unknown[]} */
    const records = [];
    let done = false;
    /** @type {() => void} */
    let off = () => {};
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      off();
      resolve(records);
    };
    const delegate = {
      [spec.start]: () => {},
      [spec.recv]: spec.single
        ? (/** @type {unknown} */ _dev, /** @type {unknown} */ obj) => records.push(obj)
        : (/** @type {unknown} */ _dev, /** @type {unknown} */ id, /** @type {unknown} */ name, /** @type {unknown} */ cardType) =>
            records.push({ id, name: bioNameToText(name), type: cardType }),
      [spec.end]: () => finish(),
    };
    off = cmds.registerDelegate(delegate);
    timer = setTimeout(finish, timeoutMs);
    // GET を撃つ (応答 ack は即返るが、実データは publish で来る → finish は END/timeout 駆動)。
    Promise.resolve(cmds[spec.getter]()).catch(() => { /* publish/timeout を待つ */ });
  });
}

// =====================================================================
//  SURF-08 段階3: RPC 公開仕様 (biometric / fingerPrint / remoteNano サブファサード)
//
//  registry がこれらを読み `ble.biometric.<op>` / `ble.fingerPrint.<op>` /
//  `ble.remoteNano.<op>` を型付き RPC/SDK メソッドへ自動展開する (bot2.js SCRIPT_RPC_OPS と同型)。
//
//  ★ params の **順序 = ファサードメソッド (上の BiometricCommands) の位置引数の順序**。
//    順序がずれると registry が named→位置引数へ写像した際にワイヤのバイト列が壊れる (最重要)。
//  ★ result: 送信系 (request の ack {resultCode,payload} を返すメソッド) は "ack"、
//    ModeGet 系 (payload[0] = mode byte を返す) は "raw"。
//  ★ op パスの第1セグメントは allowlist (BLE_RPC_ALLOWLIST: "biometric"/"fingerPrint"/
//    "remoteNano") に掲載済み。第2セグメントは getter が返すビューのメソッド名。
//
//  除外したメソッド (RPC 化に不向き / 非対応):
//    - registerDelegate / onEnroll: publish 購読のコールバック登録系。RPC では引数の関数を
//      ワイヤに乗せられず、戻り値 unsubscribe も跨プロセスで扱えない (純ローカル)。
//      publish 受信は registry の event/notification 経路が別途担うため op 化しない。
//    - cardBatchAdd / passcodeBatchAdd: 第2引数が progress コールバック ((cur,total)=>void) で
//      RPC では渡せず、本体は 4 秒 sleep を挟む長時間 STP 分割転送 (1 RPC の往復契約に乗らない)。
//      一括登録は ble.invoke escape hatch 経由で行う。
//    - palmChange: SDK に送信実装が無い (PALM_CHANGE は受信専用。registry.js BIO_VIEW_METHODS の
//      注記参照) ためファサードにメソッドが存在せず op 化対象外。
// =====================================================================

/**
 * `biometric` サブファサード (Touch / Touch Pro / Face / Palm の card/passcode/face/palm 登録 +
 * connector 共通面) の RPC 公開仕様。
 *
 * 各 op の出典 (位置引数の意味・順序の裏取り):
 *   card:     CHCardCapableImpl.kt:38-174 (cardModeGet/Set:38,49 / cardAdd:83 / cardDelete:60 /
 *             cardMove:72 / cardChange:158 / cardChangeValue:169)
 *   passcode: CHPassCodeCapableImpl.kt:27-130 (keyBoardPassCode* — modeGet/Set:27,33 / add:39 /
 *             delete:113 / move:119 / change:130)
 *   face:     CHFaceCapableImpl.kt:22-51 (faceModeSet:22 / faceModeGet:29 / faceListGet:39 /
 *             faceChange:45 / faceDelete:51)
 *   palm:     CHPalmCapableImpl.kt:19-42 (palmModeSet:19 / palmModeGet:26 / palmListGet:36 / palmDelete:42)
 *   connect:  CHDeviceConnectCapableImpl.kt:23-95 (insertSesame:23 / removeSesame:52 / setRadarSensitivity:89)
 * @type {import("./index.js").BleRpcOpSpec}
 */
export const BIOMETRIC_RPC_OPS = {
  // ---- card (CHCardCapableImpl.kt) ----
  "biometric.cardModeSet": { params: [{ name: "mode", type: "number", required: true, desc: "card enroll mode byte (kicks off CARD_FIRST/NOTIFY/LAST push)" }], result: "ack" },
  "biometric.cardModeGet": { params: [], result: "raw" },
  "biometric.cardGet": { params: [], result: "ack" },
  "biometric.cardAdd": { params: [{ name: "id", type: "object", required: true, desc: "card UID raw bytes ({type:'Buffer',data:[]} or {$buffer})" }, { name: "hexName", type: "string", required: true, desc: "card name (UTF-8 string)" }], result: "ack" },
  "biometric.cardDelete": { params: [{ name: "cardID", type: "string", required: true, desc: "card id (hex) to delete" }], result: "ack" },
  "biometric.cardMove": { params: [{ name: "cardId", type: "string", required: true, desc: "card id (hex) to move" }, { name: "touchProUUID", type: "string", required: true, desc: "destination Touch Pro UUID (UTF-8)" }], result: "ack" },
  "biometric.cardChange": { params: [{ name: "ID", type: "string", required: true, desc: "card id (hex)" }, { name: "hexName", type: "string", required: true, desc: "new name (hex, folded 2 chars/byte)" }], result: "ack" },
  "biometric.cardChangeValue": { params: [{ name: "ID", type: "string", required: true, desc: "card id (hex)" }, { name: "newID", type: "string", required: true, desc: "new card id value (UTF-8)" }], result: "ack" },

  // ---- passcode (CHPassCodeCapableImpl.kt) ----
  "biometric.passcodeModeSet": { params: [{ name: "mode", type: "number", required: true, desc: "passcode enroll mode byte" }], result: "ack" },
  "biometric.passcodeModeGet": { params: [], result: "raw" },
  "biometric.passcodeGet": { params: [], result: "ack" },
  "biometric.passcodeAdd": { params: [{ name: "id", type: "object", required: true, desc: "passcode id raw bytes ({type:'Buffer',data:[]} or {$buffer})" }, { name: "hexName", type: "string", required: true, desc: "passcode name (UTF-8 string)" }], result: "ack" },
  "biometric.passcodeDelete": { params: [{ name: "keyBoardPassCodeID", type: "string", required: true, desc: "passcode id (hex) to delete" }], result: "ack" },
  "biometric.passcodeMove": { params: [{ name: "cardId", type: "string", required: true, desc: "passcode id (hex) to move" }, { name: "touchProUUID", type: "string", required: true, desc: "destination Touch Pro UUID (UTF-8)" }], result: "ack" },
  "biometric.passcodeChange": { params: [{ name: "ID", type: "string", required: true, desc: "passcode id (hex)" }, { name: "hexName", type: "string", required: true, desc: "new name (hex, folded 2 chars/byte)" }], result: "ack" },

  // ---- face (CHFaceCapableImpl.kt) ----
  "biometric.faceModeSet": { params: [{ name: "mode", type: "number", required: true, desc: "face enroll mode byte" }], result: "ack" },
  "biometric.faceModeGet": { params: [], result: "raw" },
  "biometric.faceListGet": { params: [], result: "ack" },
  "biometric.faceChange": { params: [{ name: "ID", type: "string", required: true, desc: "face id (hex)" }, { name: "name", type: "string", required: true, desc: "new name (hex, folded 2 chars/byte)" }], result: "ack" },
  "biometric.faceDelete": { params: [{ name: "faceID", type: "string", required: true, desc: "face id (hex single byte) to delete" }], result: "ack" },

  // ---- palm (CHPalmCapableImpl.kt) ----
  "biometric.palmModeSet": { params: [{ name: "mode", type: "number", required: true, desc: "palm enroll mode byte" }], result: "ack" },
  "biometric.palmModeGet": { params: [], result: "raw" },
  "biometric.palmListGet": { params: [], result: "ack" },
  "biometric.palmDelete": { params: [{ name: "palmID", type: "string", required: true, desc: "palm id (hex single byte) to delete" }], result: "ack" },

  // ---- connector common (CHDeviceConnectCapableImpl.kt) ----
  "biometric.insertSesame": { params: [{ name: "sesame", type: "object", required: true, desc: "{deviceUUID, secretKey, sesame2PublicKey?} child Sesame key to add" }], result: "ack" },
  "biometric.removeSesame": { params: [{ name: "tag", type: "string", required: true, desc: "child Sesame UUID to remove" }, { name: "opts", type: "object", required: false, desc: "{keyType?} 0x04=OS2 / 0x05=OS3 (default 0x05)" }], result: "ack" },
  "biometric.setRadarSensitivity": { params: [{ name: "payload", type: "object", required: true, desc: "raw radar parameter bytes ({type:'Buffer',data:[]} or {$buffer})" }], result: "ack" },
};

/**
 * `fingerPrint` サブファサード (SESAME Bike3 の指紋登録、CHFingerPrintCapable) の RPC 公開仕様。
 * Bike3 は card/passcode/face/palm を持たず指紋のみ。registerDelegate は除外 (publish 購読の
 * ローカルコールバック登録)。
 *
 * 出典: CHFingerPrintCapableImpl.kt:20-64 (fingerPrintModeGet:20 / fingerPrintModeSet:31 /
 *   fingerPrintDelete:42 / fingerPrints:53 / fingerPrintsChange:64)。
 * ※ ファサード公開名は `fingerPrintChange` (SDK の fingerPrintsChange に対応、index.js fingerPrint ゲッタ)。
 * @type {import("./index.js").BleRpcOpSpec}
 */
export const FINGERPRINT_RPC_OPS = {
  "fingerPrint.fingerPrintModeSet": { params: [{ name: "mode", type: "number", required: true, desc: "fingerprint enroll mode byte" }], result: "ack" },
  "fingerPrint.fingerPrintModeGet": { params: [], result: "raw" },
  "fingerPrint.fingerPrints": { params: [], result: "ack" },
  "fingerPrint.fingerPrintDelete": { params: [{ name: "fingerPrintID", type: "string", required: true, desc: "fingerprint id (hex) to delete" }], result: "ack" },
  "fingerPrint.fingerPrintChange": { params: [{ name: "ID", type: "string", required: true, desc: "fingerprint id (hex)" }, { name: "hexName", type: "string", required: true, desc: "new name (hex, folded 2 chars/byte)" }], result: "ack" },
};

/**
 * `remoteNano` サブファサード (Remote / Remote Nano 専用面、connector 共通面 + trigger delay) の
 * RPC 公開仕様。registerDelegate は除外 (publish 購読のローカルコールバック登録)。
 *
 * ★ 公開名 `setTriggerDelayTime` は SDK CHRemoteNanoCapable.kt:8 と 1:1 (index.js remoteNano ゲッタが
 *   BiometricCommands.setTriggerDelay へ委譲)。読み出しコマンドは SDK に無い (現在値は
 *   TRIGGER_DELAYTIME(191) publish が運び registerDelegate で受ける) ため getTriggerDelay 等は無い。
 *
 * 出典: CHRemoteNanoCapableImpl.kt:19-28 (setTriggerDelayTime) /
 *   CHDeviceConnectCapableImpl.kt:23-95 (insertSesame:23 / removeSesame:52 / setRadarSensitivity:89)。
 * @type {import("./index.js").BleRpcOpSpec}
 */
export const REMOTE_NANO_RPC_OPS = {
  "remoteNano.setTriggerDelayTime": { params: [{ name: "time", type: "number", required: true, desc: "trigger delay seconds (UByte 0..255)" }], result: "ack" },
  "remoteNano.insertSesame": { params: [{ name: "sesame", type: "object", required: true, desc: "{deviceUUID, secretKey, sesame2PublicKey?} child Sesame key to add" }], result: "ack" },
  "remoteNano.removeSesame": { params: [{ name: "tag", type: "string", required: true, desc: "child Sesame UUID to remove" }, { name: "opts", type: "object", required: false, desc: "{keyType?} 0x04=OS2 / 0x05=OS3 (default 0x05)" }], result: "ack" },
  "remoteNano.setRadarSensitivity": { params: [{ name: "payload", type: "object", required: true, desc: "raw radar parameter bytes ({type:'Buffer',data:[]} or {$buffer})" }], result: "ack" },
};
