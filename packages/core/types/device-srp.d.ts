/**
 * ConfirmDevice 用の DeviceSecretVerifierConfig と、後続の DEVICE_SRP 認証で使う
 * device password を生成する。
 *
 * @param {string} deviceGroupKey NewDeviceMetadata.DeviceGroupKey
 * @param {string} deviceKey      NewDeviceMetadata.DeviceKey
 * @returns {{devicePassword:string, passwordVerifier:string, salt:string}}
 *   passwordVerifier / salt は base64 (ConfirmDevice にそのまま渡せる)。
 */
export function generateDeviceVerifier(deviceGroupKey: string, deviceKey: string): {
    devicePassword: string;
    passwordVerifier: string;
    salt: string;
};
/**
 * クライアント秘密 a と公開値 A = g^a mod N を生成 (A != 0)。
 * @returns {{a: bigint, A: bigint}}
 */
export function generateEphemeralA(): {
    a: bigint;
    A: bigint;
};
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
export function srpPasswordSecrets({ firstId, secondId, password, serverB, salt, a, A }: {
    firstId: string;
    secondId: string;
    password: string;
    serverB: bigint;
    salt: bigint;
    a: bigint;
    A: bigint;
}): {
    hkdf: Buffer;
    sValue: bigint;
    u: bigint;
    x: bigint;
};
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
export function deviceAuthSecrets({ deviceGroupKey, deviceKey, devicePassword, serverB, salt, a, A }: {
    deviceGroupKey: string;
    deviceKey: string;
    devicePassword: string;
    serverB: bigint;
    salt: bigint;
    a: bigint;
    A: bigint;
}): {
    hkdf: Buffer;
    sValue: bigint;
};
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
export function devicePasswordSignature({ hkdf, deviceGroupKey, deviceKey, secretBlock, timestamp }: {
    hkdf: Buffer;
    deviceGroupKey: string;
    deviceKey: string;
    secretBlock: string;
    timestamp: string;
}): string;
/** Cognito が要求する固定書式のタイムスタンプ "ddd MMM D HH:mm:ss UTC yyyy" (UTC、日は 0 詰めしない)。 */
export function cognitoTimestamp(d?: Date): string;
export namespace __srpTest {
    export { N };
    export { G };
    export { K };
    export { modPow };
    export { calculateU };
    export { padHex };
}
declare const N: bigint;
declare const G: 2n;
declare const K: bigint;
/**
 * モジュラ冪剰余 base^exp mod mod。
 * @param {bigint} base
 * @param {bigint} exp
 * @param {bigint} mod
 * @returns {bigint}
 */
declare function modPow(base: bigint, exp: bigint, mod: bigint): bigint;
/**
 * u = H(A, B)。SRP のスクランブリングパラメータ。
 * @param {bigint} A
 * @param {bigint} B
 * @returns {bigint}
 */
declare function calculateU(A: bigint, B: bigint): bigint;
/**
 * BigInt → 偶数長 hex。最上位ビットが立つ場合は符号誤読防止に "00" を前置 (padHex 相当)。
 * @param {bigint} bigInt
 * @returns {string}
 */
declare function padHex(bigInt: bigint): string;
export {};
//# sourceMappingURL=device-srp.d.ts.map