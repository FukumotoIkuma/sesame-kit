/**
 * OS2 BLE セッション暗号器。
 * sessionKey(16B) と sessionToken(8B) を保持し、encrypt/decrypt ごとに内部 counter を進める
 * (SesameOS2BleCipher.kt:7-33: encryptCounter / decryptCounter は別々に ++ される)。
 *
 * 注意 (counter 状態): 1 セッション (1 接続) に 1 インスタンス。encrypt と decrypt の counter は
 * 独立 (送信フレーム数と受信フレーム数は別々に進む)。SDK 同様、復号は doFinal の **前** に
 * counter を進める設計とし (下記 decrypt 参照)、破損/取りこぼし後も後続フレームと整合させる。
 */
export class SesameOS2BleCipher {
    /**
     * @param {Buffer} sessionKey 16B セッション鍵 (AES-128 鍵)。
     * @param {Buffer} sessionToken 8B (mAppToken4B ++ mSesameToken4B)。
     */
    constructor(sessionKey: Buffer, sessionToken: Buffer);
    /** 現在の送信カウンタ (テスト/デバッグ用)。 */
    get encryptCounter(): bigint;
    /** 現在の受信カウンタ (テスト/デバッグ用)。 */
    get decryptCounter(): bigint;
    /**
     * 平文を CCM 暗号化し、末尾に 4B tag を付けて返す。
     * SesameOS2BleCipher.kt:11-20: nonce 生成 → encryptCounter++ → init/updateAAD(0)/doFinal。
     * @param {Buffer} plaintext 暗号化前フレーム ([opCode, item, ...data])。
     * @returns {Buffer} ciphertext ++ tag(4B)
     */
    encrypt(plaintext: Buffer): Buffer;
    /**
     * CCM 復号。入力は ciphertext ++ tag(4B)。tag 不一致なら throw。
     * SesameOS2BleCipher.kt:22-33: nonce 生成 → decryptCounter = inc() and Long.MAX_VALUE → doFinal。
     * SDK は decryptCounter を doFinal の前に進めるため、復号失敗してもカウンタは進む。これに倣い、
     * counter を進めてから復号することで、破損/取りこぼし後も後続フレームとの整合を保つ。
     * @param {Buffer} ctWithTag ciphertext ++ tag(4B)
     * @returns {Buffer} 復号平文
     */
    decrypt(ctWithTag: Buffer): Buffer;
}
export namespace __test__ {
    export { toCounterBytes };
    export { os2Nonce };
    export { OS2_CCM_TAG_LEN };
}
import { Buffer } from "node:buffer";
/**
 * OS2 の counter(5B LE) を生成する。
 * SesameOS2BleCipher.kt:36-59 の toEncryCounter()/toDecryCounter() を 1:1 で移植。
 *   - 5 回ループで `testLong.toByte()` (下位 8bit) を順に詰め、毎回 8bit 右シフト = LE 並び。
 * @param {bigint} counter 0 起点のカウンタ値 (送受信ごとに +1)。
 * @param {bigint} maskOrFlag encrypt は OR (ENCRYPT_FLAG)、decrypt は AND (DECRYPT_MASK) を適用する。
 * @param {boolean} isEncrypt true なら OR、false なら AND。
 * @returns {Buffer} 5B
 */
declare function toCounterBytes(counter: bigint, isEncrypt: boolean): Buffer;
/**
 * OS2 の CCM nonce (13B) を組み立てる。
 *   nonce = counter5B ++ sessionToken8B   (SesameOS2BleCipher.kt:13,23)
 * @param {bigint} counter
 * @param {Buffer} sessionToken8 8B (mAppToken4B ++ mSesameToken4B)
 * @param {boolean} isEncrypt encrypt/decrypt で counter のフラグ処理が異なる。
 * @returns {Buffer} 13B
 */
declare function os2Nonce(counter: bigint, sessionToken8: Buffer, isEncrypt: boolean): Buffer;
declare const OS2_CCM_TAG_LEN: 4;
export {};
//# sourceMappingURL=cipher.d.ts.map