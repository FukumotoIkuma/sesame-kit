// SESAME デバイス制御で使う暗号 / バイナリ helpers。
//
// Ported from biz3 (CANDY-HOUSE/biz3, MIT):
//   - vendor reference: references_web/src/utils/Cmac.js (CMAC-AES-128)
//   - vendor reference: references_web/src/utils/biz3utils.js (uuidBuffer 等)
//   - vendor reference: references_web/src/constants/cmdCode.js (item code)
//   - vendor reference: references_web/src/constants/sesameDeviceModel.js (productType)
//
// biz3 Web は Web Crypto API + 自前 CMAC 実装、Node では node-aes-cmac (RFC 4493) を使用。
// 公式 BLE 実装と同じ AES-CMAC で、用途のみ異なる (biz3 は時刻署名 / BLE は session key 派生)。

import { aesCmac } from "node-aes-cmac";
import { randomUUID } from "node:crypto";
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
 * `node-aes-cmac` は RFC 4493 標準実装。RFC 4493 §4 の Test Vector 2
 * (key=2b7e1516..., msg=6bc1bee2..., expected=070a16b4...) で動作検証済み
 * (リポルートで `node _crypto_test.mjs` 実行時 PASS。biz3 Cmac.js も同じ
 * RFC 4493 標準を Web Crypto 上で自前実装しているため出力は一致する)。
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
  const mac = aesCmac(key, msg);  // node-aes-cmac は Buffer を返す
  const macBuf = Buffer.isBuffer(mac) ? mac : Buffer.from(mac, "hex");
  return macBuf.toString("hex").slice(0, 8);
}

// ---------- binary helpers ----------

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
  if (key in IR_TYPE) return IR_TYPE[key];
  const n = Number(key);
  if (Number.isFinite(n)) return n;
  const aliases = Object.keys(IR_TYPE).join(", ");
  throw new Error(`Unknown irType "${v}". 数値 (例 49152) かエイリアス (${aliases}) を指定してください。`);
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

export function productTypeFromModelName(modelName) {
  return PRODUCT_TYPE[modelName];
}
