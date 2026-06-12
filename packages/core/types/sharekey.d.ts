/**
 * デバイス鍵から共有 URL (`ssm://UI?...`) を組み立てる。biz3 generateInviteGuestQRCodeByInfo の 1:1 移植。
 *
 * @param {DeviceKey} deviceKey デバイス鍵。devices 一覧 (listDevices) の 1 要素や getDeviceStatus 応答。
 *   必須: deviceModel, sesame2PublicKey(hex), keyIndex(hex), deviceUUID。
 *   secretKey は guestKeyId 未指定時に必須。
 * @param {object} [opts]
 * @param {number|string} [opts.keyLevel] 0=owner / 1=manager / 2=guest (URL の l=)。
 *   biz3 (biz3utils.js:131) は guestInfo.keyLevel をそのまま埋めるだけなので、未指定だと
 *   "l=undefined" になる。deviceKey.keyLevel へはフォールバックしない (参照に無いため)。
 * @param {string} [opts.guestKeyId] ゲスト共有時に secretKey 位置へ差し込む値 (generateGuestQR 応答)
 * @param {string} [opts.name] 表示名 (URL の n=)。省略時 deviceKey.deviceName (biz3utils.js:127)。
 * @returns {string} `ssm://UI?t=sk&sk=<base64>&l=<lv>&n=<urlenc>`
 */
export function buildShareKeyUrl(deviceKey: DeviceKey, { keyLevel, guestKeyId, name }?: {
    keyLevel?: string | number | undefined;
    guestKeyId?: string | undefined;
    name?: string | undefined;
}): string;
/**
 * 共有 URL (`ssm://UI?...` 文字列) を解析して鍵情報に戻す。biz3 readQrcode の URL 解析部の移植
 * (画像スキャン部 = Decoder/DOM 依存は除外。URL 文字列を直接受ける)。
 *
 * @param {string} url `ssm://UI?t=sk&sk=...&l=...&n=...`
 * @returns {{secretKey:string, keyIndex:string, sesame2PublicKey:string, keyLevel:number,
 *           deviceModel:string|null, deviceName:string|null, deviceUUID:string}}
 *   keyLevel は biz3utils.js:189 と同じ `parseInt(l)` で、l 欠落/非数値なら **NaN**
 *   (null には倒さない。parseInt→NaN 挙動含む 1:1)。
 */
export function parseShareKeyUrl(url: string): {
    secretKey: string;
    keyIndex: string;
    sesame2PublicKey: string;
    keyLevel: number;
    deviceModel: string | null;
    deviceName: string | null;
    deviceUUID: string;
};
/**
 * 共有 URL 生成に使うデバイス鍵。devices 一覧 (listDevices) の 1 要素や getDeviceStatus 応答。
 */
export type DeviceKey = {
    /**
     * 機種名 (例 "sesame_5")
     */
    deviceModel?: string | undefined;
    /**
     * hex (16 byte)
     */
    secretKey?: string | undefined;
    /**
     * hex
     */
    sesame2PublicKey?: string | undefined;
    /**
     * hex (2 byte)
     */
    keyIndex?: string | undefined;
    deviceUUID?: string | undefined;
    keyLevel?: string | number | undefined;
    deviceName?: string | undefined;
};
//# sourceMappingURL=sharekey.d.ts.map