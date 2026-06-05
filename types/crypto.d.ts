/**
 * v4 UUID を生成。biz3 biz3utils.generateUUID:269-280 と一致させる。
 * 学習リモコンのキーは **クライアントが keyUUID を発番**してサーバに渡す
 * (learn/index.js:222)。サーバ発番ではない。
 *
 * ★重要: biz3 は `randomUUID().toUpperCase()` で **大文字** UUID を返す。
 *   Node の randomUUID は既定で小文字なので toUpperCase() で揃える。
 *   (biz3 アプリと同一アカウント併用時に keyUUID 形式を一致させるため)
 */
export function generateUUID(): string;
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
export function cmacTime(hexKey: string): string;
/**
 * UUID (32hex with hyphens) → 18B base64 (prefix '000c' 付き)。
 * biz3 utils.uuidBuffer() と同じ。`biz3TriggerLocker` の `history` フィールドに乗せる。
 *
 * @param {string} uuid 'XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX' or 32hex
 * @param {string} prefix デフォルト '000c'
 * @returns {string} base64 (24 文字)
 */
export function uuidToHistoryBase64(uuid: string, prefix?: string): string;
/**
 * irType を文字列エイリアス (ac/tv/...) または数値文字列から数値に解決する。
 * @param {string|number} v "ac" | "49152" | 0xc000 等
 * @returns {number}
 */
export function parseIrType(v: string | number): number;
export function productTypeFromModelName(modelName: any): number;
export { ITEM_CODES as CMD } from "./itemcodes.js";
export const IR_TYPE: Readonly<{
    ac: 49152;
    tv: 8192;
    light: 57344;
    fan: 32768;
    learn: 65024;
}>;
/**
 * irType が不明な場合の保険値。
 * このツールは自己学習リモコン (learnEmit) を主対象とするため learn (0xFE00) を既定とする。
 * (フォールバックが実際に使われるのは server が type を報告しない異常時のみ)
 */
export const DEFAULT_IR_TYPE: 65024;
export const PRODUCT_TYPE: Readonly<{
    [k: string]: number;
}>;
//# sourceMappingURL=crypto.d.ts.map