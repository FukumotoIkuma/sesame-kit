/**
 * デバイス鍵から共有 URL (`ssm://UI?...`) を組み立てる。biz3 generateInviteGuestQRCodeByInfo の 1:1 移植。
 *
 * @param {object} deviceKey デバイス鍵。devices 一覧 (listDevices) の 1 要素や getDeviceStatus 応答。
 *   必須: deviceModel, sesame2PublicKey(hex), keyIndex(hex), deviceUUID。
 *   secretKey は guestKeyId 未指定時に必須。
 * @param {object} opts
 * @param {number|string} opts.keyLevel 0=owner / 1=manager / 2=guest (URL の l=)
 * @param {string} [opts.guestKeyId] ゲスト共有時に secretKey 位置へ差し込む値 (generateGuestQR 応答)
 * @param {string} [opts.name] 表示名 (URL の n=)。省略時 deviceKey.deviceName。
 * @returns {string} `ssm://UI?t=sk&sk=<base64>&l=<lv>&n=<urlenc>`
 */
export function buildShareKeyUrl(deviceKey: object, { keyLevel, guestKeyId, name }?: {
    keyLevel: number | string;
    guestKeyId?: string;
    name?: string;
}): string;
/**
 * 共有 URL (`ssm://UI?...` 文字列) を解析して鍵情報に戻す。biz3 readQrcode の URL 解析部の移植
 * (画像スキャン部 = Decoder/DOM 依存は除外。URL 文字列を直接受ける)。
 *
 * @param {string} url `ssm://UI?t=sk&sk=...&l=...&n=...`
 * @returns {{secretKey:string, keyIndex:string, sesame2PublicKey:string, keyLevel:number|null,
 *           deviceModel:string|null, deviceName:string|null, deviceUUID:string}}
 */
export function parseShareKeyUrl(url: string): {
    secretKey: string;
    keyIndex: string;
    sesame2PublicKey: string;
    keyLevel: number | null;
    deviceModel: string | null;
    deviceName: string | null;
    deviceUUID: string;
};
//# sourceMappingURL=sharekey.d.ts.map