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
 * デバイスパスワード認証鍵 (HKDF 出力) を導出。amazon の getPasswordAuthenticationKey 相当。
 * deviceGroupKey/deviceKey はサーバ verifier 生成時と同じ "{group}{key}:{password}" を成す。
 *
 * @returns {{hkdf: Buffer, sValue: bigint}} sValue はサーバ役シミュレーションでの検証用に返す。
 */
export function deviceAuthSecrets({ deviceGroupKey, deviceKey, devicePassword, serverB, salt, a, A }: {
    deviceGroupKey: any;
    deviceKey: any;
    devicePassword: any;
    serverB: any;
    salt: any;
    a: any;
    A: any;
}): {
    hkdf: Buffer;
    sValue: bigint;
};
/**
 * DEVICE_PASSWORD_VERIFIER の PASSWORD_CLAIM_SIGNATURE を計算。
 * HMAC-SHA256(hkdf, deviceGroupKey || deviceKey || secretBlock || timestamp)。
 */
export function devicePasswordSignature({ hkdf, deviceGroupKey, deviceKey, secretBlock, timestamp }: {
    hkdf: any;
    deviceGroupKey: any;
    deviceKey: any;
    secretBlock: any;
    timestamp: any;
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
declare function modPow(base: any, exp: any, mod: any): bigint;
/** u = H(A, B)。SRP のスクランブリングパラメータ。 */
declare function calculateU(A: any, B: any): bigint;
/** BigInt → 偶数長 hex。最上位ビットが立つ場合は符号誤読防止に "00" を前置 (padHex 相当)。 */
declare function padHex(bigInt: any): any;
export {};
//# sourceMappingURL=device-srp.d.ts.map