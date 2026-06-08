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
//# sourceMappingURL=device-srp.d.ts.map