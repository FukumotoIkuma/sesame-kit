/** @param {string} [loc] */
export function setLocale(loc?: string): void;
/** @returns {Locale} */
export function getLocale(): Locale;
/**
 * メッセージを引く。未定義キーは en にフォールバックし、それも無ければキー文字列を返す。
 * @param {string} key
 * @param {Record<string, string|number>} [vars]
 */
export function t(key: string, vars?: Record<string, string | number>): string;
/**
 * ロケールを解決する。優先順位: flag > configLang > 既定 "en"。
 * "ja"/"ja_JP.UTF-8" のような値は前方一致で判定 ("ja*"→ja, "en*"→en, それ以外は無視)。
 * @param {{ flag?: string|null, configLang?: string|null }} [src]
 * @returns {Locale}
 */
export function resolveLocale({ flag, configLang }?: {
    flag?: string | null;
    configLang?: string | null;
}): Locale;
/**
 * 明示指定された言語値が認識可能 (en/ja 接頭辞) か。`--lang xx` のような未知値を
 * 黙って英語へ落とさず警告するための判定。空/未指定は「指定なし」として true 扱い。
 * @param {string|null|undefined} v
 * @returns {boolean}
 */
export function isKnownLang(v: string | null | undefined): boolean;
export type Locale = "en" | "ja";
//# sourceMappingURL=i18n.d.ts.map