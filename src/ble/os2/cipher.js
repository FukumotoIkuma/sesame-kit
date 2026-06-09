// SESAME OS2 BLE 暗号 (SESAME2/3/4・初代 Bot・初代 Bike)。
//
// 移植元 (1:1):
//   - references_android/.../ble/os2/base/SesameOS2BleCipher.kt
//
// OS3 (src/ble/protocol.js の ccmEncrypt/ccmDecrypt) との差分 (★最重要):
//   - nonce  = counter(5B) ++ sessionToken(8B)            (OS3 は count(8B LE) ++ 0x00 ++ token(4B))
//   - sessionToken は **8B** (mAppToken4B ++ mSesameToken4B)。OS3 の token4 とは別物。
//   - counter は 5B LE で、暗号化側は最上位ビット (0x80_00000000) を立て、復号側は
//     0x7f_ffffffff でマスクする。この **最上位ビットは「方向マーカ」** である:
//       app → device : flag=1 (encrypt が 0x80 を立てる)
//       device → app : flag=0 (device の encrypt は flag を立てず、app の decrypt が 0x7f マスクで一致)
//     したがって本クラス (app 視点) の encrypt と decrypt は **同じ counter 値でも別 nonce** になり、
//     自分の encrypt を自分の decrypt では復号できない (相手 = firmware が鏡像の flag で対になる)。
//     これは SDK 忠実な挙動 (SesameOS2BleCipher.kt:13,23 toEncryCounter/toDecryCounter) で、誤りではない。
//   - tag は 32bit = 4B (Kotlin GCMParameterSpec(32, nonce) の第1引数 = tag bit 長)。
//   - AAD は 0x00 1byte。
//   - mode は AES/CCM/NoPadding (Node では aes-128-ccm)。
//
// この層は「セッション確立後のバイト列」だけを扱う純クラス。BLE 無線 I/O は transport の責務。

import crypto from "node:crypto";
import { Buffer } from "node:buffer";

// CCM tag 長 (byte)。Kotlin GCMParameterSpec(32, nonce) の 32bit = 4B。
const OS2_CCM_TAG_LEN = 4;
// AAD (SesameOS2BleCipher.kt:18,31 updateAAD(byteArrayOf(0)))。
const OS2_CCM_AAD = Buffer.from([0x00]);
// counter のビット幅 (5B = 40bit)。Kotlin Long の 5byte 切り出しと一致。
const COUNTER_BYTES = 5;
// 暗号化 counter で立てる最上位フラグビット (0x80_00000000 = bit39)。
const ENCRYPT_FLAG = 0x80n << 32n; // = 0x8000000000n
// 復号 counter のマスク (0x7f_ffffffff、bit39 を落とす)。
const DECRYPT_MASK = 0x7fffffffffn;

/**
 * OS2 の counter(5B LE) を生成する。
 * SesameOS2BleCipher.kt:36-59 の toEncryCounter()/toDecryCounter() を 1:1 で移植。
 *   - 5 回ループで `testLong.toByte()` (下位 8bit) を順に詰め、毎回 8bit 右シフト = LE 並び。
 * @param {bigint} counter 0 起点のカウンタ値 (送受信ごとに +1)。
 * @param {boolean} isEncrypt true なら OR (ENCRYPT_FLAG)、false なら AND (DECRYPT_MASK)。
 * @returns {Buffer} 5B
 */
function toCounterBytes(counter, isEncrypt) {
  let v = isEncrypt ? (counter | ENCRYPT_FLAG) : (counter & DECRYPT_MASK);
  const bytes = Buffer.alloc(COUNTER_BYTES);
  for (let i = 0; i < COUNTER_BYTES; i++) {
    bytes[i] = Number(v & 0xffn); // testLong.toByte() = 下位 8bit
    v >>= 8n;                     // testLong.shr(Byte.SIZE_BITS)
  }
  return bytes;
}

/**
 * OS2 の CCM nonce (13B) を組み立てる。
 *   nonce = counter5B ++ sessionToken8B   (SesameOS2BleCipher.kt:13,23)
 * @param {bigint} counter
 * @param {Buffer} sessionToken8 8B (mAppToken4B ++ mSesameToken4B)
 * @param {boolean} isEncrypt encrypt/decrypt で counter のフラグ処理が異なる。
 * @returns {Buffer} 13B
 */
function os2Nonce(counter, sessionToken8, isEncrypt) {
  return Buffer.concat([toCounterBytes(counter, isEncrypt), sessionToken8]);
}

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
  constructor(sessionKey, sessionToken) {
    if (!Buffer.isBuffer(sessionKey) || sessionKey.length !== 16) {
      throw new Error(`OS2 sessionKey must be 16 bytes (got ${Buffer.isBuffer(sessionKey) ? sessionKey.length : "non-buffer"})`);
    }
    if (!Buffer.isBuffer(sessionToken) || sessionToken.length !== 8) {
      throw new Error(`OS2 sessionToken must be 8 bytes (mAppToken4 ++ mSesameToken4) (got ${Buffer.isBuffer(sessionToken) ? sessionToken.length : "non-buffer"})`);
    }
    this._key = sessionKey;
    this._token = sessionToken;
    this._encCount = 0n; // SesameOS2BleCipher.kt:8 encryptCounter
    this._decCount = 0n; // SesameOS2BleCipher.kt:9 decryptCounter
  }

  /** 現在の送信カウンタ (テスト/デバッグ用)。 */
  get encryptCounter() { return this._encCount; }
  /** 現在の受信カウンタ (テスト/デバッグ用)。 */
  get decryptCounter() { return this._decCount; }

  /**
   * 平文を CCM 暗号化し、末尾に 4B tag を付けて返す。
   * SesameOS2BleCipher.kt:11-20: nonce 生成 → encryptCounter++ → init/updateAAD(0)/doFinal。
   * @param {Buffer} plaintext 暗号化前フレーム ([opCode, item, ...data])。
   * @returns {Buffer} ciphertext ++ tag(4B)
   */
  encrypt(plaintext) {
    const iv = os2Nonce(this._encCount, this._token, true);
    this._encCount += 1n; // SesameOS2BleCipher.kt:14 encryptCounter.inc()
    const c = crypto.createCipheriv("aes-128-ccm", this._key, iv, { authTagLength: OS2_CCM_TAG_LEN });
    c.setAAD(OS2_CCM_AAD, { plaintextLength: plaintext.length });
    const ct = Buffer.concat([c.update(plaintext), c.final()]);
    return Buffer.concat([ct, c.getAuthTag()]);
  }

  /**
   * CCM 復号。入力は ciphertext ++ tag(4B)。tag 不一致なら throw。
   * SesameOS2BleCipher.kt:22-33: nonce 生成 → decryptCounter = inc() and Long.MAX_VALUE → doFinal。
   * SDK は decryptCounter を doFinal の前に進めるため、復号失敗してもカウンタは進む。これに倣い、
   * counter を進めてから復号することで、破損/取りこぼし後も後続フレームとの整合を保つ。
   * @param {Buffer} ctWithTag ciphertext ++ tag(4B)
   * @returns {Buffer} 復号平文
   */
  decrypt(ctWithTag) {
    if (!Buffer.isBuffer(ctWithTag) || ctWithTag.length < OS2_CCM_TAG_LEN) {
      throw new Error("OS2 ciphertext too short (no tag)");
    }
    const iv = os2Nonce(this._decCount, this._token, false);
    // SesameOS2BleCipher.kt:26 decryptCounter = decryptCounter.inc() and Long.MAX_VALUE。
    // Long.MAX_VALUE マスクは 63bit。counter は 5B(40bit) しか使わないため実質無影響だが、
    // 移植忠実性のため counter を doFinal の前に進める点だけ再現する。
    this._decCount += 1n;
    const ct = ctWithTag.subarray(0, ctWithTag.length - OS2_CCM_TAG_LEN);
    const tag = ctWithTag.subarray(ctWithTag.length - OS2_CCM_TAG_LEN);
    const d = crypto.createDecipheriv("aes-128-ccm", this._key, iv, { authTagLength: OS2_CCM_TAG_LEN });
    d.setAAD(OS2_CCM_AAD, { plaintextLength: ct.length });
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]);
  }
}

// テスト用に nonce / counter 生成を露出 (SDK ベクタ照合用)。
export const __test__ = { toCounterBytes, os2Nonce, OS2_CCM_TAG_LEN };
