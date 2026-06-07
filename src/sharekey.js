// デバイス鍵共有 URL (ゲスト共有 QR) の生成 / 解析。
//
// Ported 1:1 from biz3 (CANDY-HOUSE/biz3, MIT):
//   - generateInviteGuestQRCodeByInfo : references_web/src/utils/biz3utils.js:114-135
//   - readQrcode (URL 解析部のみ)        : references_web/src/utils/biz3utils.js:167-213
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
import { t } from "./i18n.js";
import { productTypeFromModelName } from "./crypto.js";
import { modelNameByProductType } from "../vendor/biz3/constants/sesameDeviceModel.js";

/** SesameOS3 判定 (biz3utils.js:103-105)。productType - 5 >= 0 で OS3。 */
function isSesameOs3(productType) {
  return productType - 5 >= 0;
}

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
export function buildShareKeyUrl(deviceKey, { keyLevel, guestKeyId, name } = {}) {
  if (!deviceKey) throw new Error("deviceKey required");

  const productType = productTypeFromModelName(deviceKey.deviceModel);
  if (productType == null) {
    throw new Error(t("org.sharekey.unknownDeviceModel", { model: JSON.stringify(deviceKey.deviceModel) }));
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
    if (!v) throw new Error(t("org.sharekey.fieldRequired", { field: k }));
  }

  const keydata =
    deviceModelHex +
    secretKey +
    deviceKey.sesame2PublicKey +
    deviceKey.keyIndex +
    String(deviceKey.deviceUUID).replace(/-/g, "");
  const littleKey = Buffer.from(keydata, "hex").toString("base64");

  const lvl = keyLevel ?? deviceKey.keyLevel;
  const displayName = name || deviceKey.deviceName || "";
  const params = [
    "t=sk", // qrMode.QR_SESAMEKEY = 'sk' (biz3 constants/qrType.js)
    `sk=${littleKey}`,
    `l=${lvl}`,
    `n=${encodeURIComponent(displayName)}`,
  ].join("&");
  return `ssm://UI?${params}`;
}

/**
 * 共有 URL (`ssm://UI?...` 文字列) を解析して鍵情報に戻す。biz3 readQrcode の URL 解析部の移植
 * (画像スキャン部 = Decoder/DOM 依存は除外。URL 文字列を直接受ける)。
 *
 * @param {string} url `ssm://UI?t=sk&sk=...&l=...&n=...`
 * @returns {{secretKey:string, keyIndex:string, sesame2PublicKey:string, keyLevel:number|null,
 *           deviceModel:string|null, deviceName:string|null, deviceUUID:string}}
 */
export function parseShareKeyUrl(url) {
  if (!url) throw new Error("url required");
  const qIdx = String(url).indexOf("?");
  const params = new URLSearchParams(qIdx >= 0 ? String(url).slice(qIdx + 1) : String(url));

  const skRaw = params.get("sk");
  if (!skRaw) throw new Error("sk param not found in url");
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

  const lStr = params.get("l");
  return {
    secretKey,
    keyIndex,
    sesame2PublicKey,
    keyLevel: lStr != null && lStr !== "" ? parseInt(lStr, 10) : null,
    deviceModel: modelNameByProductType[productType] ?? null,
    deviceName: params.get("n"),
    deviceUUID,
  };
}
