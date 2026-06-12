// SESAME デバイス制御で使う暗号 / バイナリ helpers。
//
// Ported from biz3 (CANDY-HOUSE/biz3, MIT):
//   - vendor reference: references_web/src/utils/Cmac.js (CMAC-AES-128)
//   - vendor reference: references_web/src/utils/biz3utils.js (uuidBuffer 等)
//   - vendor reference: references_web/src/constants/cmdCode.js (item code)
//   - vendor reference: references_web/src/constants/sesameDeviceModel.js (productType)
//
// biz3 Web は Web Crypto API + 自前 CMAC 実装、Node では内製の src/aes-cmac.js (RFC 4493) を使用
// (旧 node-aes-cmac は無メンテ + deprecated Buffer コンストラクタ使用のため内製化。P5-2)。
// 公式 BLE 実装と同じ AES-CMAC で、用途のみ異なる (biz3 は時刻署名 / BLE は session key 派生)。

import { aesCmac } from "./aes-cmac.js";
import { randomUUID, randomBytes, createECDH } from "node:crypto";
import { Buffer } from "node:buffer";
import { t } from "./i18n.js";
// 公式 biz3 の純定数を直接 import (手書き複製を排除 = 推測ズレ原理的になし)。
// vendor/biz3/constants/ は biz3 原文のコピー (vendor/biz3/README.md 参照)。
import { modelNameByProductType } from "../vendor/biz3/constants/sesameDeviceModel.js";

// ---------- UUID ----------

/**
 * v4 UUID を生成。biz3 biz3utils.generateUUID:269-280 と一致させる。
 * 学習リモコンのキーは **クライアントが keyUUID を発番**してサーバに渡す
 * (learn/index.js:222)。サーバ発番ではない。
 *
 * ★重要: biz3 は `randomUUID().toUpperCase()` で **大文字** UUID を返す。
 *   Node の randomUUID は既定で小文字なので toUpperCase() で揃える。
 *   (biz3 アプリと同一アカウント併用時に keyUUID 形式を一致させるため)
 */
export function generateUUID() {
  return randomUUID().toUpperCase();
}

// ---------- AES-CMAC ----------

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
export function cmacTime(hexKey) {
  if (typeof hexKey !== "string") {
    throw new Error(`secretKey must be a 32-char hex string (got ${typeof hexKey})`);
  }
  if (hexKey.length !== 32) {
    throw new Error(`secretKey must be a 32-char hex string (got length ${hexKey.length})`);
  }
  if (!/^[0-9a-fA-F]{32}$/.test(hexKey)) {
    throw new Error("secretKey must be a 32-char hex string (non-hex characters found)");
  }
  const key = Buffer.from(hexKey, "hex");
  const ts = Math.floor(Date.now() / 1000);
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(ts, 0);
  const msg = buf.subarray(1, 4); // 上位 3B
  // 内製 aesCmac (src/aes-cmac.js) は常に 16B Buffer を返す (旧 node-aes-cmac の
  // hex/Buffer 揺れ正規化ラッパ cmacBuf は不要になったため削除済み。P5-2)。
  return aesCmac(key, msg).toString("hex").slice(0, 8);
}

// ---------- binary helpers ----------

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
export function hexToBuf(hex, { bytes } = {}) {
  if (typeof hex !== "string") {
    throw new Error(`hexToBuf: hex must be a string (got ${typeof hex})`);
  }
  if (hex.length % 2 !== 0) {
    throw new Error(`hexToBuf: hex string must be even-length (got length ${hex.length})`);
  }
  if (!/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("hexToBuf: non-hex characters found");
  }
  const buf = Buffer.from(hex, "hex");
  if (bytes !== undefined && buf.length !== bytes) {
    throw new Error(`hexToBuf: expected ${bytes} byte(s) (got ${buf.length})`);
  }
  return buf;
}

/**
 * Buffer/Uint8Array → 小文字 hex 文字列 (SDK の toHexString 相当)。
 * @param {Buffer|Uint8Array} buf
 * @returns {string}
 */
export function bufToHex(buf) {
  if (!Buffer.isBuffer(buf) && !(buf instanceof Uint8Array)) {
    throw new Error(`bufToHex: buf must be a Buffer/Uint8Array (got ${typeof buf})`);
  }
  return Buffer.from(buf).toString("hex");
}

/**
 * UUID (32hex with hyphens) → 18B base64 (prefix '000c' 付き)。
 * biz3 utils.uuidBuffer() と同じ。`biz3TriggerLocker` の `history` フィールドに乗せる。
 *
 * @param {string} uuid 'XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX' or 32hex
 * @param {string} prefix デフォルト '000c'
 * @returns {string} base64 (24 文字)
 */
export function uuidToHistoryBase64(uuid, prefix = "000c") {
  if (typeof uuid !== "string") throw new Error("uuid required (string)");
  const cleanHex = uuid.replace(/-/g, "");
  if (cleanHex.length !== 32) {
    throw new Error(`uuid must be 32 hex chars (got len=${cleanHex.length})`);
  }
  return Buffer.from(prefix + cleanHex, "hex").toString("base64");
}

// ---------- cmd codes ----------
// クラウドと BLE は同一の SesameItemCode を送る (梱包だけが違う)。コード表は src/itemcodes.js に一本化し、
// クラウド側ではそれを CMD という別名で参照する (歴史的な名前)。biz3 web が施錠/解錠 UI で送るのは
// TOGGLE=88 / CLICK(=BOT_CLICK)=89 (useIotCtrl.js:37, VIotSwitch.js:35)。LOCK=82/UNLOCK=83 も
// サーバ API が解釈する正当値。
export { ITEM_CODES as CMD } from "./itemcodes.js";

// ---------- IR type (リモコンの wire 値: remote.type / sendIR の irType) ----------
//
// これらは「実デバイス (remote.type) に乗る wire 値」。biz3 一次資料で確認:
//
//   プリセットリモコン (operation: "remoteEmit"):
//     ac=0xc000 / tv=0x2000 / light=0xe000 / fan=0x8000
//     vendor: ir-type-list/index.js — 種別を選ぶとその値がそのまま remote.type になり
//             sendIR(..., remote.type) に乗る (remote-list/index.js:322, remote-air/index.js:370)。
//
//   自己学習リモコン (operation: "learnEmit", カテゴリ情報なし):
//     learn = 0xFE00 (65024)
//     vendor: learn/index.js:142 — 学習で作るリモコンは {model:'Learn', type:0xfe00}。
//             useRemoteCtrl.js:228 も `remoteDevice.type === 0xfe00` を「自己学習」と判定。
//     ※ ir-type-list の learn メニューは 0xFEFF だが、これは「UI の種別選択メニュー識別子」
//       であって実 remote.type ではない (選ぶと学習画面へ遷移するだけ)。
//       プリセットは「メニュー値=実type」だが学習だけ非対称。旧実装の実機実測 65024(0xFE00)
//       が正しく、UI 値 0xFEFF を実 type と取り違えてはいけない。
//
// 通常 sesame は device の stateInfo.remoteList から irType を自動取得するので、
// これらの定数はフォールバックと `ir search`/`remote-list` の引数用。

export const IR_TYPE = Object.freeze({
  ac: 0xc000,     // 49152 エアコン (プリセット)
  tv: 0x2000,     //  8192 テレビ (プリセット)
  light: 0xe000,  // 57344 照明 (プリセット)
  fan: 0x8000,    // 32768 扇風機 (プリセット)
  learn: 0xfe00,  // 65024 自己学習リモコンの実 type (learn/index.js:142 で確証)
});

/**
 * irType が不明な場合の保険値。
 * このツールは自己学習リモコン (learnEmit) を主対象とするため learn (0xFE00) を既定とする。
 * (フォールバックが実際に使われるのは server が type を報告しない異常時のみ)
 */
export const DEFAULT_IR_TYPE = IR_TYPE.learn; // 0xFE00 (65024)

/**
 * irType を文字列エイリアス (ac/tv/...) または数値文字列から数値に解決する。
 * @param {string|number} v "ac" | "49152" | 0xc000 等
 * @returns {number}
 */
export function parseIrType(v) {
  if (typeof v === "number") return v;
  if (typeof v !== "string") throw new Error(`irType must be a string or number (got ${typeof v})`);
  const key = v.trim().toLowerCase();
  if (key in IR_TYPE) return IR_TYPE[/** @type {keyof typeof IR_TYPE} */ (key)];
  const n = Number(key);
  if (Number.isFinite(n)) return n;
  const aliases = Object.keys(IR_TYPE).join(", ");
  throw new Error(t("domain.crypto.unknownIrType", { value: v, aliases }));
}

// ---------- productType (model name → byte value) ----------
// 手書きせず、biz3 の sesameDeviceModel.js を直接逆引きして生成する。
// biz3 は modelNameByProductType = { <productType>: "<model名>" }。これを反転して
// PRODUCT_TYPE = { "<model名>": <productType> } を作る。欠番 (12,34) も自動で反映され、
// biz3 が機種を追加/変更しても vendor を更新すればそのまま追従する。
export const PRODUCT_TYPE = Object.freeze(
  Object.fromEntries(
    Object.entries(modelNameByProductType).map(([pt, model]) => [model, Number(pt)]),
  ),
);

/**
 * モデル名 (例 "sesame_5") から biz3 の productType 数値を引く。
 * @param {string} modelName
 * @returns {number|undefined}
 */
export function productTypeFromModelName(modelName) {
  return PRODUCT_TYPE[modelName];
}

// ---------- ECDH 共有鍵導出 (BLE デバイス登録 / 初期ペアリング) ----------
//
// ★配線状況 (2026-06 時点): この ECDH ブロックの ecdhSecretPre16() は登録フローに
//   **配線済み**である。session.register() (src/ble/session.js) がデバイスの返す
//   公開鍵から共有秘密を導き、secretKey/session 鍵を確立する形で本番フローに乗り、
//   SesameBle.register()/registerOnce() ファサード経由で到達可能。mock vector で
//   単体/end-to-end テスト済み (tests/crypto/ecdh.test.js, tests/ble/session-register.test.js,
//   tests/ble/facade-register.test.js)。ただし **実機 OS3 デバイスに対する token16
//   バイト列一致は未検証** (protocol.js:282-299 の registration 側記述と整合)。
//   現状の自動検証範囲は NIST P-256 既知ベクタ + mock end-to-end まで。
//   注: 同ファイル後段の server-auth ブロック (getRegisterKey / deriveRegisterPriKey /
//   SERVER_AUTH_PUBKEY) は **OS2 register の任意経路に配線済み** (makeLocalRegisterServer 経由で
//   SesameOS2BleSession.register({ registerServer }) に注入する。OS3 register は純 ECDH で
//   getRegisterKey を使わない)。配線詳細と未検証性は後段 server-auth ブロックの注記を参照。
//
// SESAME 公式 SDK は P-256 (secp256r1 / prime256v1) ECDH で共有秘密を作り、
// その先頭 16B を初期ペアリングの secret に使う。Node では呼び出し側が用意した
// `createECDH("prime256v1")` インスタンス (秘密鍵をセット済み) と remote の生公開鍵
// から再現する。
//
// 原典 (CANDY-HOUSE SesameSDK):
//   co/candyhouse/sesame/utils/EccKey.kt:27-33 — ecdh():
//     val fixheader = "3059301306072a8648ce3d020106082a8648ce3d030107034200" + remote(hex)
//     KeyFactory("EC").generatePublic(X509EncodedKeySpec(fixheader.hexToBytes()))
//     KeyAgreement("ECDH").apply { init(priv); doPhase(pub, true) }.generateSecret()
//   → fixheader は SubjectPublicKeyInfo の固定 DER 前置。末尾 "...034200" の
//     "04" が EC point の **uncompressed prefix**。remote はそこに続く 64B (X‖Y) の
//     生バイト列 (prefix 無し)。よって Node では「04 + 64B」を computeSecret に渡すのと等価。
//   co/candyhouse/sesame/ble/os3/CHHub3Device.kt:197 — ecdh().sliceArray(0..15)
//     → 共有秘密 (32B X 座標) の **先頭 16B** をペアリング secret として使用。
//
// Node の createECDH("prime256v1").computeSecret(uncompressedPoint) は ECDH の生出力
// (= 共有点の X 座標 32B) をそのまま返す。これは JCA の KeyAgreement("ECDH").generateSecret()
// と同一 (どちらも KDF を挟まない raw ECDH)。NIST P-256 既知ベクタで一致を確認済み
// (tests/crypto/ecdh.test.js)。

const ECDH_UNCOMPRESSED_PREFIX = 0x04; // EC point uncompressed 形式の先頭バイト
const ECDH_RAW_PUBKEY_LEN = 64;        // P-256 生公開鍵 = X(32B) ‖ Y(32B)

/**
 * keyPair (呼び出し側が用意する createECDH("prime256v1") インスタンス、または
 * .computeSecret を持つラッパ) から computeSecret 可能な ECDH オブジェクトを取り出す。
 * @param {import("node:crypto").ECDH|{ecdh?:import("node:crypto").ECDH, computeSecret?:Function}} keyPair
 * @returns {{computeSecret:(other:Buffer)=>Buffer}}
 */
function resolveEcdh(keyPair) {
  if (!keyPair) throw new Error("keyPair required (createECDH instance)");
  // 直接 ECDH インスタンス、またはそれを内包するラッパのどちらでも受ける。
  // 構造的にプロパティ存在を見るため、union を緩く読める形にナロー化する。
  const kp = /** @type {{ ecdh?: import("node:crypto").ECDH, computeSecret?: Function }} */ (keyPair);
  const candidate =
    typeof kp.computeSecret === "function" ? kp
      : (kp.ecdh && typeof kp.ecdh.computeSecret === "function") ? kp.ecdh
        : null;
  if (!candidate) {
    throw new Error("keyPair must expose computeSecret() (a createECDH('prime256v1') instance)");
  }
  return /** @type {{computeSecret:(other:Buffer)=>Buffer}} */ (candidate);
}

/**
 * remote の生公開鍵 (64B, prefix 無し) を uncompressed point 形式に正規化する。
 * EccKey.kt の fixheader 末尾 "04" が示す通り、SDK の remote は 0x04 prefix を含まない
 * X‖Y の 64B (これが SDK 契約)。Node の computeSecret は 0x04 prefix 付き (65B) を
 * 要求するので前置する。
 *
 * ★65B (0x04 prefix 付き) 受理は SDK 仕様ではなく **本ラッパ独自の利便機能**:
 *   Node の getPublicKey() が既定で返す uncompressed 65B をそのまま渡せるようにする
 *   ためのもの。SDK 契約に忠実なのは 64B raw のみ。65B を渡しても computeSecret は
 *   同一結果になるが、契約外の形態である点に注意 (将来 64B 厳格化に倒す余地あり)。
 * @param {Buffer|string} remotePubKey64 64B raw (Buffer) or 128hex string
 *   (利便機能として 0x04 prefix 付き 65B / 130hex も受理)
 * @returns {Buffer} 65B uncompressed point (0x04 ‖ X ‖ Y)
 */
function toUncompressedPoint(remotePubKey64) {
  let raw;
  if (Buffer.isBuffer(remotePubKey64)) {
    raw = remotePubKey64;
  } else if (typeof remotePubKey64 === "string") {
    if (!/^[0-9a-fA-F]+$/.test(remotePubKey64) || remotePubKey64.length % 2 !== 0) {
      throw new Error("remotePubKey64 hex string must be even-length hex");
    }
    raw = Buffer.from(remotePubKey64, "hex");
  } else {
    throw new Error(`remotePubKey64 must be a Buffer or hex string (got ${typeof remotePubKey64})`);
  }
  // 寛容受理 (本ラッパ独自の利便機能, SDK 契約外): 既に 0x04 prefix 付き (65B) で
  // 渡された場合はそのまま使う。SDK 契約の正規形は 64B raw。
  if (raw.length === ECDH_RAW_PUBKEY_LEN + 1 && raw[0] === ECDH_UNCOMPRESSED_PREFIX) {
    return raw;
  }
  if (raw.length !== ECDH_RAW_PUBKEY_LEN) {
    throw new Error(
      `remotePubKey64 must be ${ECDH_RAW_PUBKEY_LEN}B raw public key (X‖Y, no prefix); got ${raw.length}B`,
    );
  }
  return Buffer.concat([Buffer.from([ECDH_UNCOMPRESSED_PREFIX]), raw]);
}

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
export function ecdhSharedSecret(keyPair, remotePubKey64) {
  const ecdh = resolveEcdh(keyPair);
  const point = toUncompressedPoint(remotePubKey64);
  return ecdh.computeSecret(point);
}

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
export function ecdhSecretPre16(keyPair, remotePubKey64) {
  return Buffer.from(ecdhSharedSecret(keyPair, remotePubKey64).subarray(0, 16));
}

// ---------- サーバ認証 (初期ペアリングの sig1 生成 / reg-server-ecdh-auth) ----------
//
// ★★ 移植忠実性: 未確定 (UNVERIFIED PORT) ★★
//   このブロック (deriveRegisterPriKey / getRegisterKey / SERVER_AUTH_PUBKEY) の
//   アルゴリズムは原典 CHServerAuth.kt (本リポジトリの _sesame_sdk_ref に存在) の **getRegisterKey
//   定義** が根拠だが、その定義は SDK 内に呼び出し元が無く (server 側で実行される想定)、
//   - serverauth.test.js の「生プリミティブ独立再計算」(refRegisterKey) は同一の定義
//     アルゴリズムを再実装したものなので、確認しているのは **内部整合性のみ** であって
//     SDK/サーバが実際に送るバイト列 (sig1/pubkey) との一致ではない。
//   よって以下の核心要素はいずれも実機キャプチャと未照合:
//     - CMAC 鍵文字列 "Sesame2_key_pair"
//     - priKey = oneKey ‖ twoKey の連結順
//     - sessionToken = serverToken ‖ b64(n) / msg = b64(ak) ‖ sessionToken の連結順
//     - priKeyToPubKey の drop(27) → 64B pubkey (X‖Y, prefix 無し)
//     - SERVER_AUTH_PUBKEY (serverKey) の定数値
//
//   ★配線状況 (2026-06 更新): getRegisterKey は **OS2 register の任意 server-auth 経路に配線済み**。
//     呼び出し元 CHSesame2Device.register (CHSesame2Device.kt:406-482) が getRegisterKey 相当の
//     {sig1, st, pubkey} を server から受けて REGISTRATION を組む。kit ではこれを registerServer
//     コールバック注入 (SesameOS2BleSession.register({registerServer}), src/ble/os2/session.js) で
//     再現し、makeLocalRegisterServer (下記) が getRegisterKey をそのコールバックに適合させて
//     「クラウド非依存のオフライン server-auth register」を可能にする (login 側の signLogin /
//     _loginViaServer と同じ流儀)。mock end-to-end で app↔device 鍵一致を検証
//     (tests/ble/os2-register.test.js)。既定の BLE-only register は不変 (registerServer/
//     localServerAuth 未指定なら従来どおり明示エラー)。
//
//   ★世代の明確化 (旧注記の訂正): getRegisterKey は **OS2 (SESAME2/3/4) 固有**の登録認証であり、
//     呼び出し元も OS2 (CHSesame2Device) のみ。OS3 register (CHHub3Device.kt:176-211) は純 ECDH で
//     getRegisterKey を使わない (一次資料で確認)。旧注記は「OS2 由来を OS3 register に流用する前提が
//     未検証」と懸念していたが、実際には OS3 が本アルゴリズムを使わないため流用は発生しない。
//     したがって配線は OS2 のみとし、検証も **OS2 実機 (SESAME2/3/4) register キャプチャ**で行う。
//
//   TODO(未確定解除の条件): 以下の **いずれか** で独立な出所と突き合わせるまで「未確定」を解除しない:
//     (a) **OS2 (SESAME2/3/4) 実機**の register フローのキャプチャで sig1/pubkey 一致を E2E 確認。
//     (b) 別実装/SDK 一次資料からのゴールデンベクタ (serverKey 値, priKey 鍵文字列, 連結順,
//         drop(27)) と照合する。
//   それまでは本注記と README の Known limitations の記載を維持する。
//
// 原典 (CANDY-HOUSE SesameSDK, ※上記のとおり未照合):
//   co/candyhouse/sesame/ble/os2/CHServerAuth.kt:27-65 — getRegisterKey()。
//   端末登録の初期ペアリングで、デバイスから受け取った {ak,n,e} を元に
//     1. e から「登録用の P-256 秘密鍵」を CMAC で決定的に導出
//     2. その秘密鍵と CHServerAuth.serverKey (固定 65B 公開鍵) で ECDH → 共有秘密先頭 16B = secret
//     3. 4B 乱数 serverToken を作り sessionToken = serverToken ‖ b64decode(n)
//     4. msg = b64decode(ak) ‖ sessionToken を secret で CMAC した先頭 4B = sig1
//   を計算して {sig1, st(=serverToken), pubkey(=登録用公開鍵)} を返す。
//
// ★priKey 導出 (CHServerAuth.kt:43-50):
//     oneKey = CMAC("Sesame2_key_pair", e)
//     twoKey = CMAC(oneKey,            e)
//     priKey = oneKey ‖ twoKey        (16B + 16B = 32B P-256 秘密鍵スカラ)
//   ここで CMAC の **鍵** が ("Sesame2_key_pair" → oneKey) と変わり、**メッセージ**は
//   両方とも e そのもの (時刻 CMAC のように上位 3B を取る等の加工はしない)。
//
// ★priKey → pubKey (CHServerAuth.kt:113-148 priKeyToPubKey):
//   SDK は priKey をスカラとして G を点倍算し、X509 SubjectPublicKeyInfo (P-256 SPKI = 91B) に
//   詰めた publicKey.encoded から先頭 27B を drop する (CHServerAuth.kt:138)。
//   27B = SPKI ヘッダ 26B + uncompressed point prefix 0x04 の 1B (EccKey.kt の fixheader
//   "3059…03420004" 27B と同じ区切りで、**04 を含む**)。残りは 91 − 27 = **64B (X‖Y, prefix 無し)**。
//   Node の createECDH("prime256v1").setPrivateKey(priKey).getPublicKey() は 0x04 prefix 付き
//   65B を返すので、subarray(1) で先頭 1B を剥がしたものが SDK の drop(27) と等価。
//   消費側 (EccKey.ecdh / 本実装の ecdhSecretPre16) は fixheader(04 込み) + remote 64B で
//   SPKI を再構成するため、65B を渡すと 04 が二重化し SPKI が破損する。
//
// ★serverKey (CHServerAuth.kt:28-29): サーバが保持する固定 P-256 公開鍵 (65B, 04 prefix 込み)。
//   ecdhShareKey は EccKey.ecdh() と同じく X509 fixheader を前置して KeyAgreement。
//   serverKey は既に 04 prefix 付き 65B のため、ecdhSharedSecret() の 65B 受理経路で
//   そのまま computeSecret に渡せる (生 X 座標 32B → 先頭 16B が secret)。

/**
 * CHServerAuth.serverKey — サーバが保持する固定 P-256 公開鍵 (uncompressed, 65B, 04 prefix 込み)。
 * CHServerAuth.kt:28-29 の定数をそのまま移植 (推測なし)。
 * @type {string} 130hex (= 65B)
 */
export const SERVER_AUTH_PUBKEY =
  "04a040fcc7386b2a08304a3a2f0834df575c936794209729f0d42bd84218b35803932bea522200b2ebcbf17ab57c4509b4a3f1e268b2489eb3b75f7a765adbe181";

// ★長さ検証: SDK が想定する e / ak / n の長さ。
//   getRegisterKey の CMAC メッセージ (e そのもの / ak / n) は長さ非依存なので、長さ違いでも
//   黙って (誤った) priKey/sig1 を生んでしまう。assertValidP256Scalar と同じ「明示エラー」方針で
//   ここでも下限/上限を assert し、取り違えを早期に弾く。
//
//   ★訂正 (2026-06, 一次資料照合で確定): 旧実装は ak/n/e をいずれも 16B 固定と想定していたが、
//     これは **SDK 一次資料未照合の推測** だった。getRegisterKey の実呼び出し元
//     CHSesame2Device.register (CHSesame2Device.kt:424-447) と EccKey (EccKey.kt:19-25) を照合した結果、
//     OS2 register フローでの実際の長さは固定 16B ではないことが判明した:
//       - ak = EccKey.getRegisterAK() = base64(app の登録用 ECDH 公開鍵 **64B**)  (EccKey.kt:19-21)
//       - n  = mSesameToken.base64Encode() = **4B** (initial publish の token)     (CHSesame2Device.kt:428)
//       - e  = ER = IRER 応答 payload.drop(16) の hex (**可変長**)                  (CHSesame2Device.kt:418)
//     旧 16B 固定 assert は real OS2 wire 値 (ak=64B / n=4B) を誤って弾いてしまうため、ここを
//     一次資料準拠の境界 (ak=64B, n>=1B, e>=1B 偶数 hex) に訂正する。getRegisterKey 単体の
//     ゴールデンベクタ (serverauth.test.js) は 16B 入力で組まれているが、CMAC は長さ非依存なので
//     16B でも 64B/4B でも同一手順で計算でき、ベクタは不変 (下記の min/max 範囲に 16B も収まる)。
//
//   ★★ 移植忠実性は依然 UNVERIFIED ★★: 上記は「getRegisterKey の **呼び出し元**が渡す値の長さ」を
//     SDK で確認したに過ぎず、getRegisterKey 内部アルゴリズム (CMAC 鍵文字列・連結順・serverKey・
//     OS2→OS3 世代差) の出力一致は未確認のまま (ブロック冒頭 TODO 参照)。
// 固定長 assert はしない (SDK getRegisterKey/priKeyToPubKey は長さ検証を持たず、CMAC は長さ非依存)。
// 取り違え (空入力等) だけを弾くため下限のみ課す。ak=64B/n=4B/e=可変 という実 wire 長も、
// 16B 揃いの内部ゴールデンベクタも、どちらもこの下限を満たすので両立する。
export const MIN_AK_BYTES = 1;
export const MIN_N_BYTES = 1;
export const MIN_E_BYTES = 1;

// P-256 (secp256r1/prime256v1) の位数 n。priKey スカラの有効範囲 [1, n-1] 判定に使う。
export const P256_ORDER = BigInt(
  "0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551",
);

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
export function assertValidP256Scalar(priKey) {
  const s = BigInt("0x" + priKey.toString("hex"));
  if (s === 0n || s >= P256_ORDER) {
    throw new Error(
      "derived register priKey scalar is out of P-256 range [1, n-1] " +
        "(0 or >= curve order); SDK cannot generate a key for this e either. " +
        "Request a fresh e from the device and retry.",
    );
  }
}

/**
 * 初期ペアリング用の登録鍵 (P-256 priKey) を e から決定的に導出する。
 * CHServerAuth.kt:43-50。oneKey = CMAC("Sesame2_key_pair", e); twoKey = CMAC(oneKey, e);
 * priKey = oneKey ‖ twoKey (32B)。
 *
 * @param {string|Buffer} e デバイスが返す e (hex 文字列 or Buffer)。
 * @returns {Buffer} 32B priKey (P-256 秘密鍵スカラ)。
 */
export function deriveRegisterPriKey(e) {
  let eBytes;
  if (Buffer.isBuffer(e)) {
    eBytes = e;
  } else if (typeof e === "string") {
    if (!/^[0-9a-fA-F]+$/.test(e) || e.length % 2 !== 0) {
      throw new Error("e must be an even-length hex string");
    }
    eBytes = Buffer.from(e, "hex");
  } else {
    throw new Error(`e must be a hex string or Buffer (got ${typeof e})`);
  }
  // e の下限のみ検証 (空入力の取り違えを弾く)。固定長 assert はしない:
  // ER = IRER 応答 payload.drop(16) は可変長で (CHSesame2Device.kt:418)、CMAC は長さ非依存。
  if (eBytes.length < MIN_E_BYTES) {
    throw new Error(`e must be >= ${MIN_E_BYTES} byte(s) (got ${eBytes.length})`);
  }
  const keyBytes = Buffer.from("Sesame2_key_pair"); // CHServerAuth.kt:43
  const oneKey = aesCmac(keyBytes, eBytes);
  const twoKey = aesCmac(oneKey, eBytes);
  return Buffer.concat([oneKey, twoKey]); // 16B ‖ 16B = 32B
}

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
export function getRegisterKey(data, opts = {}) {
  if (!data || typeof data !== "object") {
    throw new Error("data required ({ak, n, e})");
  }
  const { ak, n, e } = data;
  if (typeof ak !== "string") throw new Error("ak must be a base64 string");
  if (typeof n !== "string") throw new Error("n must be a base64 string");
  if (e == null) throw new Error("e required (hex string or Buffer)");

  // ak/n を一度だけ復号し、下限のみ検証する (空入力の取り違え防止)。固定長 assert はしない:
  // 実 wire 値は ak=64B(app 公開鍵) / n=4B(mSesameToken) で固定長ではなく (定数コメント参照)、
  // CMAC は長さ非依存なので 16B 揃いの内部ベクタとも両立する。
  // Buffer.from(base64) は不正入力でも黙って短いバッファを返すため、空 (0B) だけは明示エラーに倒す。
  const akBytes = Buffer.from(ak, "base64");
  const nBytes = Buffer.from(n, "base64");
  if (akBytes.length < MIN_AK_BYTES) {
    throw new Error(`ak must decode to >= ${MIN_AK_BYTES} byte(s) (got ${akBytes.length})`);
  }
  if (nBytes.length < MIN_N_BYTES) {
    throw new Error(`n must decode to >= ${MIN_N_BYTES} byte(s) (got ${nBytes.length})`);
  }

  // 1. e → priKey (32B) → P-256 鍵ペア。
  //    priKey は CMAC 由来の実質ランダム 32B なので ~2^-32 の確率でスカラが 0 / n 以上になりうる。
  //    その場合 setPrivateKey は不透明な例外を throw する。SDK も同じく範囲外では生成不可
  //    (JCA が [1, n-1] を強制) なので、ここで SDK 整合の明示エラーに倒す (assertValidP256Scalar 参照)。
  const priKey = deriveRegisterPriKey(e);
  assertValidP256Scalar(priKey);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(priKey);
  // SDK priKeyToPubKey は SPKI 91B から drop(27) = **64B (X‖Y, prefix 無し)** を返す
  // (CHServerAuth.kt:138。27B = SPKI ヘッダ 26B + 0x04 の 1B)。Node の getPublicKey() は
  // 0x04 prefix 付き 65B なので subarray(1) で剥がす。消費側 (EccKey.ecdh) は
  // fixheader(04 込み 27B) + remote 64B を組むため、65B を返すと 04 が二重化し SPKI 破損。
  const pubKey = ecdh.getPublicKey().subarray(1); // 64B (X ‖ Y) = SDK drop(27)

  // 2. serverKey との ECDH → 共有秘密先頭 16B = secret。
  //    ecdhSecretPre16 は serverKey の 65B (04 prefix 込み) 形態をそのまま受理する。
  const secret = ecdhSecretPre16(ecdh, SERVER_AUTH_PUBKEY);

  // 3. serverToken (4B 乱数, テストでは注入)。
  const serverToken = opts.serverToken != null ? opts.serverToken : randomBytes(4);
  if (!Buffer.isBuffer(serverToken) || serverToken.length !== 4) {
    throw new Error("serverToken must be a 4-byte Buffer");
  }

  // 4. sessionToken = serverToken ‖ b64decode(n); msg = b64decode(ak) ‖ sessionToken。
  //    akBytes/nBytes は上で復号・長さ検証済みのものを再利用する。
  const sessionToken = Buffer.concat([serverToken, nBytes]);
  const msg = Buffer.concat([akBytes, sessionToken]);

  // 5. sig1 = CMAC(secret, msg)[0..3]。
  const sig1 = aesCmac(secret, msg).subarray(0, 4);

  const result = {
    sig1: Buffer.from(sig1).toString("base64"),
    st: serverToken.toString("base64"),
    pubkey: pubKey.toString("base64"),
  };

  // 6. 機微中間値の明示 zero-fill (ecdhSecretPre16 の機微値配慮方針と整合)。
  //    priKey(32B P-256 秘密鍵スカラ) と secret(ECDH 共有 16B) は登録認証の機微値。
  //    戻り値の base64 化を終えた後に零クリアし、GC 任せにしない。
  //    注意: ecdhSecretPre16 のコメントが認めるとおり Node の Buffer pool 隔離には限界があり
  //    完全な隔離は非目標。これは「保持している Buffer 自体を残さない」ための最小限の配慮。
  //    ecdh 内部の private key (setPrivateKey でコピー済み) は Node が管理し露出 API が無いため対象外。
  priKey.fill(0);
  secret.fill(0);

  return result;
}

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
export function makeLocalRegisterServer(opts = {}) {
  return function localRegisterServer(req) {
    if (!req || typeof req !== "object") throw new Error("registerServer req required");
    // ak は app の登録用公開鍵 (getRegisterAK 相当)。session が渡す appPubK64(Base64) を最優先で使う
    // (CHSesame2Device.kt は ak=getRegisterAK() を使うため、caller 由来 ak より session の app 鍵が正)。
    let akB64;
    if (typeof req.appPubK64Base64 === "string") {
      akB64 = req.appPubK64Base64;
    } else if (Buffer.isBuffer(req.appPubK64)) {
      akB64 = req.appPubK64.toString("base64");
    } else if (Buffer.isBuffer(req.ak)) {
      akB64 = req.ak.toString("base64");
    } else if (typeof req.ak === "string") {
      akB64 = req.ak; // 既に base64 とみなす (getRegisterKey と同じ前提)
    } else {
      throw new Error(
        "makeLocalRegisterServer: app public key required " +
          "(expose appPubK64/appPubK64Base64 from session, or pass ak as base64/Buffer)",
      );
    }
    if (!Buffer.isBuffer(req.mSesameToken)) {
      throw new Error("makeLocalRegisterServer: mSesameToken (Buffer) required for n");
    }
    if (typeof req.ER !== "string") {
      throw new Error("makeLocalRegisterServer: ER (hex string) required for e");
    }
    const nB64 = req.mSesameToken.toString("base64"); // CHSesame2Device.kt:428
    const { sig1, st, pubkey } = getRegisterKey({ ak: akB64, n: nB64, e: req.ER }, opts);
    // registerServer 契約のキー名へ写す (session 側 toBuf が base64 文字列を Buffer 化する)。
    return { sig1, serverToken: st, sesamePublicKey: pubkey };
  };
}
