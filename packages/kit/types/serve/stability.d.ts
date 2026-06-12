/** メソッド名 → "stable" | "experimental" (provenance から導出)。
 * @param {string} name
 * @returns {"stable"|"experimental"}
 */
export function stabilityOf(name: string): "stable" | "experimental";
/** メソッド名 → provenance 文字列。未登録は "unverified"。
 * @param {string} name
 * @returns {string}
 */
export function provenanceOf(name: string): string;
/** イベント名 → "stable" | "experimental"。
 * @param {string} name
 * @returns {"stable"|"experimental"}
 */
export function eventStabilityOf(name: string): "stable" | "experimental";
/** イベント名 → provenance。
 * @param {string} name
 * @returns {string}
 */
export function eventProvenanceOf(name: string): string;
/** @type {Record<string, string>} */
export const STABLE_METHODS: Record<string, string>;
/** @type {Record<string, string>} */
export const STABLE_EVENTS: Record<string, string>;
//# sourceMappingURL=stability.d.ts.map