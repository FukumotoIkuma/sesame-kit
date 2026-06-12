// Cognito "remembered device" の device password verifier 生成。
//
// デバイストラッキングが有効な User Pool では、認証応答の NewDeviceMetadata で
// 配られた DeviceKey を ConfirmDevice で確定するまでデバイスは「未確認」のままで、
// REFRESH_TOKEN_AUTH に未確認の DEVICE_KEY を渡すと Cognito が
// `NotAuthorizedException: Invalid Refresh Token` を返す。公式アプリ (Amplify) は
// この ConfirmDevice を自動で行うため refresh が通り続ける。CLI でも同じ verifier を
// 生成して ConfirmDevice する必要がある。
//
// アルゴリズムは amazon-cognito-identity-js の AuthenticationHelper.generateHashDevice
// と同一 (SRP-6a, 3072-bit group, g=2)。一次資料: AWS Amplify / amazon-cognito-identity-js。
import { createHash, createHmac, randomBytes } from "node:crypto";

// SRP-6a 3072-bit group prime (RFC 5054 / Cognito 共通)。g = 2。
const N_HEX =
  "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1" +
  "29024E088A67CC74020BBEA63B139B22514A08798E3404DD" +
  "EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245" +
  "E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED" +
  "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D" +
  "C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F" +
  "83655D23DCA3AD961C62F356208552BB9ED529077096966D" +
  "670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B" +
  "E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9" +
  "DE2BCBF6955817183995497CEA956AE515D2261898FA0510" +
  "15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64" +
  "ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7" +
  "ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6B" +
  "F12FFA06D98A0864D87602733EC86A64521F2B18177B200C" +
  "BBE117577A615D6C770988C0BAD946E208E24FA074E5AB31" +
  "43DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF";

const N = BigInt("0x" + N_HEX);
const G = 2n;

/**
 * モジュラ冪剰余 base^exp mod mod。
 * @param {bigint} base
 * @param {bigint} exp
 * @param {bigint} mod
 * @returns {bigint}
 */
function modPow(base, exp, mod) {
  let result = 1n;
  base = ((base % mod) + mod) % mod; // 負値も正規化
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

/**
 * SHA-256 → 64桁 hex (先頭ゼロ詰め)。amazon-cognito-identity-js の hash() 相当。
 * @param {import("node:crypto").BinaryLike} data
 * @returns {string}
 */
function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex").padStart(64, "0");
}

/**
 * hex 文字列をバイト列として解釈して SHA-256。hexHash() 相当。
 * @param {string} hexStr
 * @returns {string}
 */
function hexHash(hexStr) {
  return sha256Hex(Buffer.from(hexStr, "hex"));
}

/**
 * BigInt → 偶数長 hex。最上位ビットが立つ場合は符号誤読防止に "00" を前置 (padHex 相当)。
 * @param {bigint} bigInt
 * @returns {string}
 */
function padHex(bigInt) {
  let hex = bigInt.toString(16);
  if (hex.length % 2 === 1) hex = "0" + hex;
  else if ("89abcdef".includes(hex[0].toLowerCase())) hex = "00" + hex;
  return hex;
}

/**
 * ConfirmDevice 用の DeviceSecretVerifierConfig と、後続の DEVICE_SRP 認証で使う
 * device password を生成する。
 *
 * @param {string} deviceGroupKey NewDeviceMetadata.DeviceGroupKey
 * @param {string} deviceKey      NewDeviceMetadata.DeviceKey
 * @returns {{devicePassword:string, passwordVerifier:string, salt:string}}
 *   passwordVerifier / salt は base64 (ConfirmDevice にそのまま渡せる)。
 */
export function generateDeviceVerifier(deviceGroupKey, deviceKey) {
  const devicePassword = randomBytes(40).toString("base64");
  const fullHash = sha256Hex(`${deviceGroupKey}${deviceKey}:${devicePassword}`);

  const saltHex = padHex(BigInt("0x" + randomBytes(16).toString("hex")));
  const x = BigInt("0x" + hexHash(saltHex + fullHash));
  const verifierHex = padHex(modPow(G, x, N));

  return {
    devicePassword,
    passwordVerifier: Buffer.from(verifierHex, "hex").toString("base64"),
    salt: Buffer.from(saltHex, "hex").toString("base64"),
  };
}

// ---------------------------------------------------------------------------
// DEVICE_SRP_AUTH / DEVICE_PASSWORD_VERIFIER のクライアント実装。
// amazon-cognito-identity-js の AuthenticationHelper をそのまま移植したもの
// (公式アプリ=Amplify と同じ計算)。記憶済みデバイスでのデバイス認証に使う。
// ---------------------------------------------------------------------------

// k = H(N, g)。SRP-6a の乗数パラメータ。padHex(N)+padHex(g) を hex として hash。
const K = BigInt("0x" + hexHash(padHex(N) + padHex(G)));

// HKDF の info。amazon-cognito-identity-js の infoBits と同一。
const INFO_BITS = Buffer.from("Caldera Derived Key", "utf8");

const WEEK_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * u = H(A, B)。SRP のスクランブリングパラメータ。
 * @param {bigint} A
 * @param {bigint} B
 * @returns {bigint}
 */
function calculateU(A, B) {
  return BigInt("0x" + hexHash(padHex(A) + padHex(B)));
}

/**
 * HKDF(SHA-256) で 16 byte の鍵を導出。amazon の computehkdf 相当。
 * @param {Buffer} ikm
 * @param {Buffer} salt
 * @returns {Buffer}
 */
function computeHkdf(ikm, salt) {
  const prk = createHmac("sha256", salt).update(ikm).digest();
  const infoBitsUpdate = Buffer.concat([INFO_BITS, Buffer.from([1])]);
  return createHmac("sha256", prk).update(infoBitsUpdate).digest().subarray(0, 16);
}

/**
 * クライアント秘密 a と公開値 A = g^a mod N を生成 (A != 0)。
 * @returns {{a: bigint, A: bigint}}
 */
export function generateEphemeralA() {
  let a, A;
  do {
    a = BigInt("0x" + randomBytes(128).toString("hex")) % N;
    A = modPow(G, a, N);
  } while (A % N === 0n);
  return { a, A };
}

/**
 * SRP-6a の共有鍵バンドル (x, u, S, HKDF) を導出する共通コア。
 * device SRP / user SRP の数式は完全に同型で、差は「SRP 秘密の構成要素」
 * (poolName+username あるいは deviceGroupKey+deviceKey) と「ハッシュ対象のユーザー名」
 * のみ。本関数はその差を引数 firstId/secondId で吸収し、両者を単一実装に統合する。
 *
 * x       = H(padHex(salt) | H(firstId | secondId | ":" | password))
 * u       = H(padHex(A) | padHex(B))
 * S       = (B - k·g^x) ^ (a + u·x) mod N
 * hkdf    = HKDF("Caldera Derived Key", 16)(ikm=padHex(S), salt=padHex(u))
 *
 * 参照: _aws_sdk_ref/CognitoUser.java:4060-4096 (AuthenticationHelper の
 *   getPasswordAuthenticationKey)。device 版は amazon-cognito-identity-js の同型実装。
 *
 * バイト等価の根拠: passwordHash は sha256Hex (常に 64 hex = 32 byte) なので
 *   Buffer.from(padHex(salt) + passwordHash, "hex") は
 *   padHex(salt) のバイト列に inner-hash 32 byte を連結したものと一致する
 *   (Java の salt.toByteArray() | innerHash と同じ並び)。
 *
 * @param {object} args
 * @param {string} args.firstId  SRP 秘密の第1要素 (device: deviceGroupKey / user: poolName)
 * @param {string} args.secondId SRP 秘密の第2要素 (device: deviceKey / user: username)
 * @param {string} args.password 平文パスワード (device: devicePassword / user: ユーザーパスワード)
 * @param {bigint} args.serverB サーバ公開値 B
 * @param {bigint} args.salt
 * @param {bigint} args.a クライアント秘密
 * @param {bigint} args.A クライアント公開値
 * @returns {{hkdf: Buffer, sValue: bigint, u: bigint, x: bigint}}
 *   sValue/u/x はサーバ役シミュレーションや回帰テストでの検証用に返す。
 */
export function srpPasswordSecrets({ firstId, secondId, password, serverB, salt, a, A }) {
  // SRP-6a の縮退チェック: B ≡ 0 (mod N) のとき S が自明値になる。
  // 参照: _aws_sdk_ref/CognitoUser.java:3686-3689 (device 側 deviceSrpAuthRequest) /
  //       _aws_sdk_ref/CognitoUser.java:3605-3608 (user 側 userSrpAuthRequest)。
  if (serverB % N === 0n) throw new Error("SRP error, B cannot be zero");

  const U = calculateU(A, serverB);
  if (U === 0n) throw new Error("SRP error, U cannot be 0");

  const passwordHash = sha256Hex(`${firstId}${secondId}:${password}`);
  const x = BigInt("0x" + hexHash(padHex(salt) + passwordHash));
  const gModPowXN = modPow(G, x, N);
  // base = (B - k * g^x) mod N (負値は modPow 側で正規化される)
  const base = serverB - K * gModPowXN;
  const sValue = modPow(base, a + U * x, N);
  const hkdf = computeHkdf(
    Buffer.from(padHex(sValue), "hex"),
    Buffer.from(padHex(U), "hex"),
  );
  return { hkdf, sValue, u: U, x };
}

/**
 * デバイスパスワード認証鍵 (HKDF 出力) を導出。amazon の getPasswordAuthenticationKey 相当。
 * deviceGroupKey/deviceKey はサーバ verifier 生成時と同じ "{group}{key}:{password}" を成す。
 *
 * 数式本体は srpPasswordSecrets に統合済み (device/user 単一実装)。本関数は device 固有の
 * 引数名 (deviceGroupKey/deviceKey/devicePassword) を共通コアにマッピングする薄いラッパ。
 *
 * @param {object} args
 * @param {string} args.deviceGroupKey
 * @param {string} args.deviceKey
 * @param {string} args.devicePassword
 * @param {bigint} args.serverB サーバ公開値 B
 * @param {bigint} args.salt
 * @param {bigint} args.a クライアント秘密
 * @param {bigint} args.A クライアント公開値
 * @returns {{hkdf: Buffer, sValue: bigint}} sValue はサーバ役シミュレーションでの検証用に返す。
 */
export function deviceAuthSecrets({ deviceGroupKey, deviceKey, devicePassword, serverB, salt, a, A }) {
  const { hkdf, sValue } = srpPasswordSecrets({
    firstId: deviceGroupKey,
    secondId: deviceKey,
    password: devicePassword,
    serverB,
    salt,
    a,
    A,
  });
  return { hkdf, sValue };
}

/**
 * DEVICE_PASSWORD_VERIFIER の PASSWORD_CLAIM_SIGNATURE を計算。
 * HMAC-SHA256(hkdf, deviceGroupKey || deviceKey || secretBlock || timestamp)。
 * @param {object} args
 * @param {Buffer} args.hkdf
 * @param {string} args.deviceGroupKey
 * @param {string} args.deviceKey
 * @param {string} args.secretBlock base64 の SECRET_BLOCK
 * @param {string} args.timestamp cognitoTimestamp() の出力
 * @returns {string} base64 署名
 */
export function devicePasswordSignature({ hkdf, deviceGroupKey, deviceKey, secretBlock, timestamp }) {
  const msg = Buffer.concat([
    Buffer.from(deviceGroupKey, "utf8"),
    Buffer.from(deviceKey, "utf8"),
    Buffer.from(secretBlock, "base64"),
    Buffer.from(timestamp, "utf8"),
  ]);
  return createHmac("sha256", hkdf).update(msg).digest("base64");
}

/** Cognito が要求する固定書式のタイムスタンプ "ddd MMM D HH:mm:ss UTC yyyy" (UTC、日は 0 詰めしない)。 */
export function cognitoTimestamp(d = new Date()) {
  /** @param {number} n */
  const p = (n) => String(n).padStart(2, "0");
  return `${WEEK_DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} UTC ${d.getUTCFullYear()}`;
}

// サーバ役シミュレーション (テスト専用)。実 Cognito の DEVICE_PASSWORD_VERIFIER 側計算を
// 再現し、クライアント sValue と一致することで SRP 実装の正しさを検証する。
export const __srpTest = { N, G, K, modPow, calculateU, padHex };
