/** 結果コード → 名前 (未知は unknown(N))。 */
export function resultName(code: any): any;
/**
 * 既存 secretKey と initial token から CCM セッション鍵 (16B) を導出する。
 * token16 = AES-128-CMAC(secretKey, randomToken)  (ssm_cmd.c:43 / CHSesameOS3LockBase.kt:109)
 *
 * @param {string|Buffer} secretKey 16B (32hex)
 * @param {Buffer} token 4B (initial publish のランダム値)
 * @returns {Buffer} 16B セッション鍵
 */
export function deriveSessionKey(secretKey: string | Buffer, token: Buffer): Buffer;
/**
 * login コマンドの平文ペイロード = [LOGIN(2)] ++ token16[0:4] (ssm_cmd.c:44-45 / CHSesameOS3LockBase.kt:118-120)。
 * PLAINTEXT セグメントで送る。
 * @param {Buffer} token16 deriveSessionKey の戻り
 * @returns {Buffer} 5B
 */
export function loginPayload(token16: Buffer): Buffer;
/**
 * コマンド平文を CCM 暗号化し、末尾に 4B tag を付けて返す。
 * @param {Buffer} token16 セッション鍵
 * @param {number|bigint} count 送信カウンタ (送信ごと +1)
 * @param {Buffer} token4 initial token
 * @param {Buffer} plaintext 暗号化前フレーム ([item, ...data])
 * @returns {Buffer} ciphertext ++ tag(4B)
 */
export function ccmEncrypt(token16: Buffer, count: number | bigint, token4: Buffer, plaintext: Buffer): Buffer;
/**
 * CCM 復号。入力は ciphertext ++ tag(4B)。tag 不一致なら throw。
 * @param {Buffer} token16
 * @param {number|bigint} count 受信カウンタ (受信ごと +1)
 * @param {Buffer} token4
 * @param {Buffer} ctWithTag ciphertext ++ tag(4B)
 * @returns {Buffer} 復号平文
 */
export function ccmDecrypt(token16: Buffer, count: number | bigint, token4: Buffer, ctWithTag: Buffer): Buffer;
/**
 * 1 メッセージ (平文 or 暗号文+tag) を 20B パケット列に分割する。
 * 先頭パケットのみ start bit、最終パケットで parsing type を立てる (中間は APPEND_ONLY)。
 * @param {Buffer} payload 送るバイト列 (平文ならフレーム、暗号なら ct++tag)
 * @param {number} parsingType SEG.PLAINTEXT | SEG.CIPHERTEXT
 * @returns {Buffer[]} 各 ≤20B
 */
export function splitSegments(payload: Buffer, parsingType: number): Buffer[];
/**
 * 送信フレーム = [item_code] ++ data。op_code は送信時付与しない (CHSesameOS3.kt:495-499)。
 * @param {number} itemCode
 * @param {Buffer} [data]
 * @returns {Buffer}
 */
export function buildSendFrame(itemCode: number, data?: Buffer): Buffer;
/**
 * 受信フレーム (復号後) = [op_code][item_code][body...] を分解。
 * response(7) は body=[resultCode][payload...]、publish(8) は body=[payload...] (呼び出し側で解釈)。
 * @param {Buffer} buf
 * @returns {{opCode:number, itemCode:number, body:Buffer}}
 */
export function parseRecvFrame(buf: Buffer): {
    opCode: number;
    itemCode: number;
    body: Buffer;
};
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
export function historyTagBLE(tag?: Buffer | Uint8Array): Buffer;
/**
 * autolock の data = 2B LE 秒数 (delay.toShort().toReverseBytes()、CHSesame5Device.kt:96-105)。0=無効。
 * @param {number} seconds 0..65535
 * @returns {Buffer} 2B
 */
export function autolockData(seconds: number): Buffer;
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
export function parseMechStatus(buf: Buffer): {
    state: string;
    isInLockRange: boolean;
    target: number | null;
    position: number | null;
    isStop: boolean;
    isCritical: boolean;
    isBatteryCritical: boolean;
    batteryRaw: number;
    flags: number;
};
/** GATT (blecent.c:13-15 / SesameProtocols.kt:80-83)。 */
export const GATT: Readonly<{
    SERVICE: "fd81";
    WRITE_CHAR: "16860002-a5ae-9856-b6d3-dbb4c676993e";
    NOTIFY_CHAR: "16860003-a5ae-9856-b6d3-dbb4c676993e";
}>;
/** advertise の company ID (LE 5A 05 = 0x055A)。blecent.c:132 */
export const COMPANY_ID: 1370;
/** op_code (candy.h:66-69 / SesameProtocols.kt:55-57)。受信で意味を持つのは response/publish。 */
export const OP: Readonly<{
    CREATE: 1;
    READ: 2;
    UPDATE: 3;
    DELETE: 4;
    SYNC: 5;
    ASYNC: 6;
    RESPONSE: 7;
    PUBLISH: 8;
}>;
/** item_code。クラウドと共通の正準ソース (src/itemcodes.js) を参照する (重複定義を避ける)。 */
export const ITEM: Readonly<{
    NONE: 0;
    REGISTRATION: 1;
    LOGIN: 2;
    USER: 3;
    HISTORY: 4;
    VERSION_TAG: 5;
    TIME: 8;
    AUTOLOCK: 11;
    INITIAL: 14;
    MAGNET: 17;
    HISTORY_DELETE: 18;
    MECH_SETTING: 80;
    MECH_STATUS: 81;
    LOCK: 82;
    UNLOCK: 83;
    MOVE_TO: 84;
    TOGGLE: 88;
    CLICK: 89;
}>;
/** セグメントの parsing type (candy.h:44-46 / SesameBleReceiver.kt:5)。ヘッダ = (type<<1) | startBit。 */
export const SEG: Readonly<{
    APPEND_ONLY: 0;
    PLAINTEXT: 1;
    CIPHERTEXT: 2;
}>;
/**
 * SESAME OS3 デバイスがコマンド応答 (response 0x07) の先頭バイトで返す結果コード。
 * 出典: 公式 SesameSDK `enum SesameResultCode: UInt8`
 *   (references_ios/Sources/SesameSDK/Ble/CHDeviceProtocol.swift:195)。
 * これは **デバイス層 (SesameOS3) の taxonomy** で BLE/WM2 で共通。クラウド (biz3) 経路は
 * この code を surface しないため、利用できるのは BLE 直接経路のみ。
 */
export const RESULT: Readonly<{
    0: "success";
    1: "invalidFormat";
    2: "notSupported";
    3: "resultStorageFail";
    4: "invalidSig";
    5: "notFound";
    6: "unknown";
    7: "busy";
    8: "invalidParam";
    9: "invalidAction";
}>;
/**
 * 受信セグメントを結合するアセンブラ。feed() で 1 パケットずつ与え、メッセージ完結時に
 * { type, data } を返す (未完なら null)。start bit でバッファをリセット。
 */
export class SegmentAssembler {
    _buf: any[];
    /**
     * @param {Buffer} packet notify で届いた 1 パケット
     * @returns {{type:number, data:Buffer}|null} 完結時のみ {type, data}
     */
    feed(packet: Buffer): {
        type: number;
        data: Buffer;
    } | null;
}
/** ロック状態。SESAME 5 (OS3) は施錠範囲フラグの有無の 2 値 (中間 "moved" は無い)。 */
export const MECH_STATE: Readonly<{
    LOCKED: "locked";
    UNLOCKED: "unlocked";
}>;
import { Buffer } from "node:buffer";
//# sourceMappingURL=protocol.d.ts.map