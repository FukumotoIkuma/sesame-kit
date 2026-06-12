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
 * ir.* の直後に来る認証データ系エントリ (access.postAuthenticationData 等)。
 * @returns {Record<string, import("../registry-helpers.js").MethodEntry>}
 */
export function accessAuthEntries(): Record<string, import("../registry-helpers.js").MethodEntry>;
//# sourceMappingURL=device.d.ts.map