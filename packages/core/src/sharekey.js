// デバイス鍵共有 URL (ゲスト共有 QR) の生成 / 解析 + フレンド (社員追加) QR。
//
// Ported 1:1 from biz3 (CANDY-HOUSE/biz3, MIT):
//   - generateInviteGuestQRCodeByInfo : references_web/src/utils/biz3utils.js:114-135
//   - readQrcode (URL 解析部のみ)        : references_web/src/utils/biz3utils.js:167-213
//   - generateUserQRCodeBySubUUID      : references_web/src/utils/biz3utils.js:107-112
//   - readUserQrcode (URL 解析部のみ)    : references_web/src/utils/biz3utils.js:144-165
//
// biz3 web は SESAME アプリと共有するため、鍵情報を `ssm://UI?t=sk&sk=<base64>&l=<lv>&n=<name>`
// という URL にエンコードし、それを QR 画像化 (@nuintun/qrcode の dataURL) している。
// **URL 文字列の組み立て・解析は DOM 非依存**なので Node にそのまま移植できる (画像化は別 / 任意)。
// CLI は共有 URL を出力し、端末 QR 表示は任意 (cli 側で qrcode-terminal を動的 import)。
//
// sk ペイロード (hex 連結 → base64):
//   deviceModel(productType, 1B) ++ secretKey(16B) ++ sesame2PublicKey ++ keyIndex(2B) ++ deviceUUID(16B)
//   - SesameOS3 機種 (productType-5>=0) では sesame2PublicKey は 4B、OS2 系は 64B (readQrcode 参照)。
//   - ゲスト共有 (keyLevel=2) のときは secretKey の位置に generateGuestQR で得た guestKeyId を入れる
//     (biz3utils.js:121)。owner(0)/manager(1) は deviceKey.secretKey をそのまま使う。

import { Buffer } from "node:buffer";
import { badRequest } from "./util.js";
import { productTypeFromModelName } from "./crypto.js";
import { modelNameByProductType } from "./vendor/biz3/constants/sesameDeviceModel.js";

/**
 * 共有 URL 生成に使うデバイス鍵。devices 一覧 (listDevices) の 1 要素や getDeviceStatus 応答。
 * @typedef {Object} DeviceKey
 * @property {string} [deviceModel] 機種名 (例 "sesame_5")
 * @property {string} [secretKey] hex (16 byte)
 * @property {string} [sesame2PublicKey] hex
 * @property {string} [keyIndex] hex (2 byte)
 * @property {string} [deviceUUID]
 * @property {number|string} [keyLevel]
 * @property {string} [deviceName]
 */

/**
 * SesameOS3 判定 (biz3utils.js:103-105)。productType - 5 >= 0 で OS3。
 * @param {number} productType
 * @returns {boolean}
 */
function isSesameOs3(productType) {
  return productType - 5 >= 0;
}

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
export function buildShareKeyUrl(deviceKey, { keyLevel, guestKeyId, name } = {}) {
  if (!deviceKey) throw badRequest("deviceKey required");

  const productType = productTypeFromModelName(/** @type {string} */ (deviceKey.deviceModel));
  if (productType == null) {
    throw badRequest("org.sharekey.unknownDeviceModel", { model: JSON.stringify(deviceKey.deviceModel) });
  }
  // biz3: parseInt(model,10).toString(16).padStart(2,'0')
  const deviceModelHex = productType.toString(16).padStart(2, "0");

  // ゲスト共有なら guestKeyId を secretKey 位置に差し込む (biz3utils.js:121)。
  const secretKey = guestKeyId || deviceKey.secretKey;

  // 必須 hex フィールドの検証 (欠落のまま base64 化すると壊れた鍵を共有してしまう)。
  const required = {
    secretKey,
    sesame2PublicKey: deviceKey.sesame2PublicKey,
    keyIndex: deviceKey.keyIndex,
    deviceUUID: deviceKey.deviceUUID,
  };
  for (const [k, v] of Object.entries(required)) {
    if (!v) throw badRequest("org.sharekey.fieldRequired", { field: k });
  }

  const keydata =
    deviceModelHex +
    secretKey +
    deviceKey.sesame2PublicKey +
    deviceKey.keyIndex +
    String(deviceKey.deviceUUID).replace(/-/g, "");
  const littleKey = Buffer.from(keydata, "hex").toString("base64");

  // biz3utils.js:127-131 と 1:1 (BIZ-09):
  //   - l は guestInfo.keyLevel のみ (deviceKey.keyLevel へのフォールバックは参照に無い)。
  //     keyLevel 未指定なら biz3 同様 "l=undefined" になる (呼び出し側で必ず渡すこと)。
  //   - n は guestInfo.employeeName || deviceKey.deviceName (両欠落時は biz3 同様
  //     encodeURIComponent(undefined) = "undefined" が入る。`|| ""` の補完はしない)。
  const displayName = name || deviceKey.deviceName;
  const params = [
    "t=sk", // qrMode.QR_SESAMEKEY = 'sk' (biz3 constants/qrType.js)
    `sk=${littleKey}`,
    `l=${keyLevel}`,
    // 両欠落 (undefined) も biz3 同様そのまま通す (encodeURIComponent(undefined) = "undefined")。
    `n=${encodeURIComponent(/** @type {string} */ (displayName))}`,
  ].join("&");
  return `ssm://UI?${params}`;
}

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
export function parseShareKeyUrl(url) {
  if (!url) throw badRequest("url required");
  const qIdx = String(url).indexOf("?");
  const params = new URLSearchParams(qIdx >= 0 ? String(url).slice(qIdx + 1) : String(url));

  const skRaw = params.get("sk");
  if (!skRaw) throw badRequest("sk param not found in url");
  // base64 中の '+' が URL 上で空白に化けるケースに対応 (biz3utils.js:173)。
  const sk = skRaw.replace(/ /g, "+");
  // biz3 は Buffer.from(Buffer.from(sk,'base64'),'hex') と二重化しているが、第1引数が Buffer の
  // 場合 encoding は無視され単なるコピーになるため、base64 デコード結果がそのまま bytes。
  const data = Buffer.from(sk, "base64");

  const productType = data[0];
  let secretKey, sesame2PublicKey, keyIndex, deviceUUIDHex;
  if (isSesameOs3(productType)) {
    secretKey = data.slice(1, 1 + 16).toString("hex");
    sesame2PublicKey = data.slice(1 + 16, 1 + 16 + 4).toString("hex");
    keyIndex = data.slice(1 + 16 + 4, 1 + 16 + 4 + 2).toString("hex");
    deviceUUIDHex = data.slice(1 + 16 + 4 + 2).toString("hex");
  } else {
    secretKey = data.slice(1, 17).toString("hex");
    sesame2PublicKey = data.slice(17, 81).toString("hex");
    keyIndex = data.slice(81, 83).toString("hex");
    deviceUUIDHex = data.slice(83, 99).toString("hex");
  }
  const deviceUUID = deviceUUIDHex
    .replace(/(\w{8})(\w{4})(\w{4})(\w{4})(\w{12})/, "$1-$2-$3-$4-$5")
    .toUpperCase();

  return {
    secretKey,
    keyIndex,
    sesame2PublicKey,
    // biz3utils.js:189 `parseInt(urlParams.get('l'))` の 1:1。l 欠落 (null) / 非数値は NaN。
    keyLevel: parseInt(/** @type {string} */ (params.get("l")), 10),
    deviceModel: /** @type {Record<number, string>} */ (modelNameByProductType)[productType] ?? null,
    deviceName: params.get("n"),
    deviceUUID,
  };
}

// ---------- フレンド (社員追加) QR ----------

// qrMode.QR_FRIEND = 'friend' (references_web/src/constants/qrType.js:3)
const QR_FRIEND = "friend";

/**
 * subUUID からフレンド QR URL を生成する。
 * biz3 generateUserQRCodeBySubUUID の 1:1 移植 (biz3utils.js:107-112)。
 *
 *   ssm://UI/?t=friend&friend=<subUUID 大文字>
 *
 * `t=friend` と `friend=<UUID>` の大文字生成が参照の仕様。
 * 参照: references_web/src/utils/biz3utils.js:107-112
 *
 * @param {string} subUUID 操作者のユーザ UUID (Cognito subUUID)
 * @returns {string} `ssm://UI/?t=friend&friend=<subUUID 大文字>`
 */
export function buildFriendQrUrl(subUUID) {
  if (!subUUID) throw badRequest("sharekey.err.subUUIDRequired");
  // biz3utils.js:111: t=${qrMode.QR_FRIEND}&${qrMode.QR_FRIEND}=${userSub.toUpperCase()}
  return `ssm://UI/?t=${QR_FRIEND}&${QR_FRIEND}=${String(subUUID).toUpperCase()}`;
}

/**
 * フレンド QR URL (`ssm://UI/?t=friend&friend=...`) を解析して `{ friendID }` を返す。
 * biz3 readUserQrcode の URL 解析部の 1:1 移植 (biz3utils.js:144-165, DOM 依存部除外)。
 *
 *   - `t !== 'friend'` または `friend` パラメータ欠落の場合は throw。
 *   - friendID は **小文字** で返す (biz3utils.js:158: `friendUUID.toLowerCase()`)。
 *
 * 参照: references_web/src/utils/biz3utils.js:144-165
 *
 * @param {string} url `ssm://UI/?t=friend&friend=<subUUID>` 形式の文字列
 * @returns {{ friendID: string }} friendID は小文字
 */
export function parseFriendQrUrl(url) {
  if (!url) throw badRequest("sharekey.err.friendQrUrlRequired");
  const qIdx = String(url).indexOf("?");
  const params = new URLSearchParams(qIdx >= 0 ? String(url).slice(qIdx + 1) : String(url));

  const type = params.get("t");
  const friendUUID = params.get(QR_FRIEND);
  // biz3utils.js:153: `if (type !== qrMode.QR_FRIEND || !friendUUID)` → call(null) (解析失敗)
  if (type !== QR_FRIEND || !friendUUID) {
    throw badRequest("sharekey.err.invalidFriendQr");
  }
  // biz3utils.js:158: friendID: friendUUID.toLowerCase()
  return { friendID: friendUUID.toLowerCase() };
}
