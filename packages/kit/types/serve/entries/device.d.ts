/**
 * config.* より前のデバイス系エントリ (devices/access.register/device/firmware)。
 * @returns {Record<string, import("../registry-helpers.js").MethodEntry>}
 */
export function deviceEntriesPre(): Record<string, import("../registry-helpers.js").MethodEntry>;
/**
 * config.* の直後に来る WebAPI エントリ (webapi.*)。
 * @returns {Record<string, import("../registry-helpers.js").MethodEntry>}
 */
export function webapiEntries(): Record<string, import("../registry-helpers.js").MethodEntry>;
/**
 * 個人アカウント鍵ストア REST API の RPC 公開仕様 (P3-2)。
 * @experimental 実機 API Gateway での受理は未検証。
 *
 * CHAPIClient.kt:29-46 の PUT /device, GET /device/list, DELETE /device に相当。
 * registry パッチ方式は v2 教訓で禁止。buildRegistry 呼び出しは CONTRACT_VERSION bump を
 * 担当する P5-8 postStep で行う。本関数は型情報・ドキュメント用の仕様宣言のみを提供し、
 * buildRegistry() には直接接続しない (NAMESPACE_OPS の宣言形式と同じ位置付け)。
 *
 * params/result の型宣言は devices.js の CHUserKey JSDoc に準拠。
 *
 * @returns {Record<string, import("../registry-helpers.js").MethodEntry>}
 */
export function keyStoreEntries(): Record<string, import("../registry-helpers.js").MethodEntry>;
/**
 * ir.* の直後に来る認証データ系エントリ (access.postAuthenticationData 等)。
 * @returns {Record<string, import("../registry-helpers.js").MethodEntry>}
 */
export function accessAuthEntries(): Record<string, import("../registry-helpers.js").MethodEntry>;
//# sourceMappingURL=device.d.ts.map