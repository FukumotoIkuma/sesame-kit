/**
 * v4 UUID を生成。biz3 biz3utils.generateUUID:269-280 と一致させる。
 * 学習リモコンのキーは **クライアントが keyUUID を発番**してサーバに渡す
 * (learn/index.js:222)。サーバ発番ではない。
 *
 * ★重要: biz3 は `randomUUID().toUpperCase()` で **大文字** UUID を返す。
 *   Node の randomUUID は既定で小文字なので toUpperCase() で揃える。
 *   (biz3 アプリと同一アカウント併用時に keyUUID 形式を一致させるため)
 */
export function generateUUID(): string;
/**
 * 時刻ベースの CMAC 署名。
 * biz3 Cmac.cmacTime() と同じ:
 *   1. UNIX 秒を 4B LE にパック
 *   2. 上位 3B (index 1-3) だけを取る → 256 秒粒度の時刻
 *   3. AES-CMAC(secretKey, message) → 16B MAC
 *   4. hex 化して先頭 8 文字 (= 4B) を返す
 *
 * AES-CMAC は内製の src/aes-cmac.js (RFC 4493 準拠)。RFC 4493 §4 の全 Test Vector
 * (Example 1-4) を tests/crypto/aes-cmac.test.js で固定し、Test Vector 2
 * (key=2b7e1516..., msg=6bc1bee2..., expected=070a16b4...) は tests/crypto/cmacTime.test.js
 * でも検証している (biz3 Cmac.js も同じ RFC 4493 標準を Web Crypto 上で自前
 * 実装しているため出力は一致する)。
 *
 * @param {string} hexKey 16B (32hex) の secretKey
 * @returns {string} 4B hex (8 文字)
 */
export function cmacTime(hexKey: string): string;
/**
 * hex 文字列 → Buffer (奇数長 / 非 hex 文字は明示エラー)。
 *
 * ★一本化の動機 (REFACTORING_PLAN P5-4 / ARCH-08): hex 変換が biometric/iot/transport/cli に
 *   4+ 実装され、検証強度がバラバラだった (Buffer.from(hex,"hex") や parseInt は不正入力を
 *   黙って切り詰め/0 化する)。検証付き変換をここに集約し、各所はエラー文言 (i18n) だけ
 *   ローカルに保ちつつ内部検証を本関数へ委譲する。
 *
 * @param {string} hex 偶数長の hex 文字列 ("" は 0B Buffer)
 * @param {{bytes?: number}} [opts] bytes 指定でデコード後のバイト長も検証する
 * @returns {Buffer}
 */
export function hexToBuf(hex: string, { bytes }?: {
    bytes?: number;
}): Buffer;
/**
 * Buffer/Uint8Array → 小文字 hex 文字列 (SDK の toHexString 相当)。
 * @param {Buffer|Uint8Array} buf
 * @returns {string}
 */
export function bufToHex(buf: Buffer | Uint8Array): string;
/**
 * UUID (32hex with hyphens) → 18B base64 (prefix '000c' 付き)。
 * biz3 utils.uuidBuffer() と同じ。`biz3TriggerLocker` の `history` フィールドに乗せる。
 *
 * @param {string} uuid 'XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX' or 32hex
 * @param {string} prefix デフォルト '000c'
 * @returns {string} base64 (24 文字)
 */
export function uuidToHistoryBase64(uuid: string, prefix?: string): string;
/**
 * UUID を照合用に正規化する (ハイフン除去 + 小文字化、空安全)。
 *
 * 用途: deviceUUID の比較/フィルタリングで大文字小文字・ハイフン有無を吸収する。
 *   例: "XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX" → "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
 *
 * ★ toLowerCase が必要な理由: SESAME クラウド/WM2/Hub3 は UUID を大文字で返す場合があり、
 *   BLE 側 (noble) は小文字を返す。正規化せずに比較するとフィルタが取りこぼす。
 *   一方、鍵導出用の raw hex (insertSesamesData の noHashUUID 等) は大小を変えても
 *   バイト列は変わらないが、SDK 原文は大小変換なし (1:1 ポート規範)。
 *   鍵導出には src/ble/wm2.js, hub3.js の stripDashes を使うこと (P5-4)。
 *
 * ★ client.js/lock.js/iot.js/config.js/cli/*.js/ble/index.js/ble/transport.js の
 *   14 箇所に重複していた同義実装をここに統合 (REFACTORING_PLAN P5-4 / ARCH-05)。
 *
 * @param {unknown} s UUID 文字列 (非文字列は "" を返す)
 * @returns {string} 32 文字小文字 hex (ハイフンなし)、または "" (非文字列入力)
 */
export function normalizeUuid(s: unknown): string;
/**
 * 32桁 hex 文字列をハイフン付き UUID 文字列に整形する。
 *
 * 参照: `DataExtention.kt:41-46` (noHashtoUUID) — hex を 8-4-4-4-12 に区切る純粋整形。
 *   入力検証 (32 hex = 16B) は hexToBuf に委譲。通常呼び出し元は Buffer.toString("hex") +
 *   固定 prefix の連結なので落ちないが、不正長を黙って通さないよう防壁として検証する。
 *
 * ★ transport.js の旧 hexToUuid / wm2.js の noHashToUUID / hub3.js の noHashToUUID の
 *   3 重実装をここに統合 (REFACTORING_PLAN P5-4 / ARCH-05)。
 *
 * @param {string} hex 32 桁の小文字 hex
 * @returns {string} "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" (小文字)
 */
export function hexToUuid(hex: string): string;
/**
 * irType を文字列エイリアス (ac/tv/...) または数値文字列から数値に解決する。
 * @param {string|number} v "ac" | "49152" | 0xc000 等
 * @returns {number}
 */
export function parseIrType(v: string | number): number;
/**
 * モデル名 (例 "sesame_5") から biz3 の productType 数値を引く。
 * @param {string} modelName
 * @returns {number|undefined}
 */
export function productTypeFromModelName(modelName: string): number | undefined;
/**
 * ECDH 共有秘密 (生 X 座標 32B) を導出する。
 * EccKey.ecdh():27-33 — remote 公開鍵 (64B raw) に uncompressed prefix を付与し、
 * KeyAgreement("ECDH").generateSecret() 相当の raw ECDH 出力を返す。
 *
 * @param {import("node:crypto").ECDH|{ecdh?:import("node:crypto").ECDH}} keyPair
 *        呼び出し側が用意する createECDH("prime256v1") インスタンス (秘密鍵セット済み)。
 * @param {Buffer|string} remotePubKey64 remote の生公開鍵 (64B, X‖Y, prefix 無し)。
 * @returns {Buffer} 32B 共有秘密 (P-256 共有点の X 座標)。
 */
export function ecdhSharedSecret(keyPair: import("node:crypto").ECDH | {
    ecdh?: import("node:crypto").ECDH;
}, remotePubKey64: Buffer | string): Buffer;
/**
 * ECDH 共有秘密の先頭 16B を返す (初期ペアリング secret)。
 * CHHub3Device.kt:197 — ecdh().sliceArray(0..15)。
 *
 * 原典 Kotlin の sliceArray(0..15) は **copy** を作る。これに合わせ、ここでも
 * subarray (view) ではなく Buffer.from(...) で独立した 16B バッファを返す。
 * subarray だと戻り値が 32B 共有秘密の backing ArrayBuffer を共有する view となり、
 * 捨てたはずの後半 16B が pre.buffer 経由 (backing 全体を読む API) に露出しうる。
 * コピーすることで、捨てた後半 16B をこの 16B 戻り値バッファには残さない。
 *
 * 注意 (機微値隔離の限界): Node の Buffer.from(<=4KB) は 8KB 共有 pool から確保するため、
 * この戻り値は他割当と同一の ArrayBuffer(byteLength 8192) を共有する (byteOffset で区別)。
 * すなわち「pool 全体を隔離する」わけではなく、あくまで「ECDH 32B 出力の後半 16B を
 * この戻り値バッファ自身には載せない」ことが目的。真に pool 外へ隔離したい場合は
 * Buffer.allocUnsafeSlow(16) + copy が必要だが、用途上ここまでは要求しない。
 *
 * @param {import("node:crypto").ECDH|{ecdh?:import("node:crypto").ECDH}} keyPair
 * @param {Buffer|string} remotePubKey64 remote の生公開鍵 (64B, X‖Y, prefix 無し)。
 * @returns {Buffer} 16B 共有秘密先頭 (独立コピー、後半 16B をこのバッファに残さない)。
 */
export function ecdhSecretPre16(keyPair: import("node:crypto").ECDH | {
    ecdh?: import("node:crypto").ECDH;
}, remotePubKey64: Buffer | string): Buffer;
/**
 * deriveRegisterPriKey が返す 32B を P-256 秘密鍵スカラとして見たとき、
 * setPrivateKey が受理する有効範囲 [1, n-1] に入っているか検証する。
 *
 * ★原典 SDK との整合 (実測で確定):
 *   CHServerAuth.priKeyToPubKey (CHServerAuth.kt:113-148) は priKey を PKCS8 経由で
 *   KeyFactory("EC").generatePrivate に渡し、s = ECPrivateKey.s を取り出して multiply(G,s) する。
 *   この JCA 経路 (Android: AndroidOpenSSL/Conscrypt, デスクトップ: SunEC) を実機 JDK で再現すると:
 *     s==0        → IllegalArgumentException (w is POINT_INFINITY)
 *     s==n        → ArithmeticException (BigInteger not invertible)
 *     s>=n+1, s>n → InvalidKeyException "private key must be within the range [1, n-1]"
 *     1<=s<=n-1   → 正常生成
 *   いずれも mod n 還元は **しない**。Node(OpenSSL) の setPrivateKey も同じく [1, n-1] のみ受理し
 *   0 / n / n+1 / 0xFF..FF を throw する (実測)。つまり両者は同一境界で「明示エラー」に倒れ、
 *   SDK 側が範囲外スカラから pubkey/secret を **黙って生成することはない**。
 *   したがって還元 (mod n) を入れると逆に SDK と異なる鍵を生む退行になるため行わない。
 *
 *   SDK の getRegisterKey は priKeyToPubKey が例外を握りつぶし Pair(null,null) を返した後
 *   pair.second!! / pair.first!! で NPE に至る (= 範囲外 e では SDK も実質クラッシュ)。
 *   本実装は OpenSSL の不透明なメッセージに依存せず、ここで境界を明示エラー化する。
 *   発生確率は e に対し ~2^-32 (scalar==0/>=n)。実機 e でのみ再現しうる潜在境界。
 *
 * @param {Buffer} priKey 32B priKey スカラ。
 * @throws {Error} スカラが 0 もしくは n 以上のとき (SDK でも生成不可な値)。
 */
export function assertValidP256Scalar(priKey: Buffer): void;
/**
 * 初期ペアリング用の登録鍵 (P-256 priKey) を e から決定的に導出する。
 * CHServerAuth.kt:43-50。oneKey = CMAC("Sesame2_key_pair", e); twoKey = CMAC(oneKey, e);
 * priKey = oneKey ‖ twoKey (32B)。
 *
 * @param {string|Buffer} e デバイスが返す e (hex 文字列 or Buffer)。
 * @returns {Buffer} 32B priKey (P-256 秘密鍵スカラ)。
 */
export function deriveRegisterPriKey(e: string | Buffer): Buffer;
/**
 * 初期ペアリングのサーバ認証応答 sig1 を計算する。
 * CHServerAuth.getRegisterKey() (CHServerAuth.kt:41-65) の 1:1 移植 (の主張)。
 *
 * ★移植忠実性 未確定 (UNVERIFIED): 出力は実機 (OS2 SESAME2/3/4) のバイト列 (sig1/pubkey) と未照合。
 *   現状の検証は内部整合 (serverauth.test.js) + mock end-to-end (os2/session) のみ。実機キャプチャ
 *   or ゴールデンベクタで照合するまで「未確定」を維持すること (ブロック冒頭の TODO 参照)。
 *   配線先: makeLocalRegisterServer 経由で OS2 register の任意 server-auth 経路 (詳細は同関数 JSDoc)。
 *
 * 手順:
 *   priKey       = deriveRegisterPriKey(e)                       (32B)
 *   pubKey       = priKey から P-256 公開鍵 (X ‖ Y, **64B**, prefix 無し)
 *                  (SDK priKeyToPubKey の drop(27) = SPKI 91B − 27B。CHServerAuth.kt:138)
 *   secret       = ECDH(priKey, serverKey)[0..15]                (16B)
 *   serverToken  = 4B 乱数 (テスト用に注入可)
 *   sessionToken = serverToken ‖ b64decode(n)
 *   msg          = b64decode(ak) ‖ sessionToken
 *   sig1         = CMAC(secret, msg)[0..3]                       (4B)
 *
 * @param {{ak:string, n:string, e:string|Buffer}} data
 *   ak/n はデバイスから受け取る base64 文字列、e は hex 文字列 (or Buffer)。
 *   e/ak/n の長さは SDK 想定長 (EXPECTED_E/AK/N_BYTES, 既定 16B) で検証され、
 *   不一致は明示エラー。期待長自体は UNVERIFIED (定数コメント参照)。
 * @param {{serverToken?:Buffer}} [opts] serverToken を注入してゴールデンベクタを再現可能にする。
 *   省略時は 4B 乱数。
 * @returns {{sig1:string, st:string, pubkey:string}} すべて base64 文字列。
 *   sig1 = 4B sig, st = 4B serverToken, pubkey = **64B** 登録用公開鍵 (X‖Y, prefix 無し)。
 */
export function getRegisterKey(data: {
    ak: string;
    n: string;
    e: string | Buffer;
}, opts?: {
    serverToken?: Buffer;
}): {
    sig1: string;
    st: string;
    pubkey: string;
};
/**
 * getRegisterKey を OS2 register() の `registerServer` コールバックに合わせるローカルアダプタ。
 *
 * ★位置づけ (BLE-first / オフライン): SesameOS2BleSession.register() (src/ble/os2/session.js) の
 *   server-auth 経路は `registerServer({deviceUUID, ak, mSesameToken, ER, productType, appPubK64, ...})`
 *   → `{sig1, serverToken(st), sesamePublicKey(pubkey)}` を返すコールバック注入で動く
 *   (login 側の signLogin / _loginViaServer と同じ流儀)。本来は公式サーバ API
 *   (myDevicesRegisterSesame2Post) を叩く想定だが、SESAME の登録サーバ認証は
 *   CHServerAuth.getRegisterKey の決定的計算であり、その入力 {ak,n,e} は登録ハンドシェイク中に
 *   ローカルで揃う。よって getRegisterKey をそのまま registerServer に充てれば、クラウドを介さず
 *   **自分のコードからオフラインで** server-auth register を実行できる (= 本 kit の BLE-first 方針)。
 *
 * 入力マッピング (CHSesame2Device.kt:424-443 / CHServerAuth.kt:41-65):
 *   - ak = EccKey.getRegisterAK() = base64(app の登録用 ECDH 公開鍵 64B)。
 *         session が生成した app 鍵ペアの公開鍵 (appPubK64) を base64 化して渡す。
 *         CHSesame2Device.kt は ak に getRegisterAK() を使うので、registerServer に
 *         caller 由来の ak を渡すのではなく **session が握る appPubK64** を採用する
 *         (これが getRegisterKey の msg = decode(ak) ++ sessionToken と整合する)。
 *   - n  = mSesameToken.base64Encode()  (CHSesame2Device.kt:428 と同じ)。
 *   - e  = ER = IRER 応答の payload.drop(16) の hex  (CHSesame2Device.kt:418)。
 *
 * ★★ 移植忠実性 未確定 (UNVERIFIED) ★★: 本アダプタは getRegisterKey に依存するため、その
 *   UNVERIFIED 前提 (CMAC 鍵文字列・連結順・serverKey・長さ・OS2→OS3 世代差) をすべて引き継ぐ。
 *   getRegisterKey の冒頭注記どおり、実機 (OS2 SESAME2/3/4) register キャプチャ or 独立
 *   ゴールデンベクタで {sig1/st/pubkey} 一致を確認するまで「未確定」を解除しないこと。
 *   現状の自動検証は内部整合 (serverauth.test.js) と mock end-to-end (os2/session) に留まる。
 *
 * @param {{serverToken?:Buffer}} [opts] getRegisterKey へ素通しする serverToken (テスト用注入)。
 *   省略時は getRegisterKey 内で 4B 乱数。
 * @returns {(req:{ak?:(string|Buffer), mSesameToken:Buffer, ER:string,
 *           appPubK64?:Buffer, appPubK64Base64?:string})=>{sig1:string, serverToken:string, sesamePublicKey:string}}
 *   registerServer 契約に合う同期コールバック。session 側の toBuf が base64 文字列を受けるため
 *   getRegisterKey の base64 出力 (sig1/st/pubkey) をそのまま {sig1, serverToken, sesamePublicKey} に写す。
 */
export function makeLocalRegisterServer(opts?: {
    serverToken?: Buffer;
}): (req: {
    ak?: (string | Buffer);
    mSesameToken: Buffer;
    ER: string;
    appPubK64?: Buffer;
    appPubK64Base64?: string;
}) => {
    sig1: string;
    serverToken: string;
    sesamePublicKey: string;
};
export { ITEM_CODES as CMD } from "./itemcodes.js";
export const IR_TYPE: Readonly<{
    ac: 49152;
    tv: 8192;
    light: 57344;
    fan: 32768;
    learn: 65024;
}>;
/**
 * irType が不明な場合の保険値。
 * このツールは自己学習リモコン (learnEmit) を主対象とするため learn (0xFE00) を既定とする。
 * (フォールバックが実際に使われるのは server が type を報告しない異常時のみ)
 */
export const DEFAULT_IR_TYPE: 65024;
/**
 * CHServerAuth.serverKey — サーバが保持する固定 P-256 公開鍵 (uncompressed, 65B, 04 prefix 込み)。
 * CHServerAuth.kt:28-29 の定数をそのまま移植 (推測なし)。
 * @type {string} 130hex (= 65B)
 */
export const SERVER_AUTH_PUBKEY: string;
export const P256_ORDER: bigint;
import { Buffer } from "node:buffer";
//# sourceMappingURL=crypto.d.ts.map