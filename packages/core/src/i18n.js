// 極小 i18n。中央メッセージカタログ + t(key, vars)。
//
// 既定は英語 (README が英語デフォルトのため)。日本語は明示切替:
//   ロケール解決の優先順位: --lang フラグ  >  config の uiLang  >  既定 "en"
// (システムロケール LANG/LC_ALL での自動切替はあえて採らない = 既定は常に en)。
//
// CLI 起動時に呼び出し側が setLocale() してから t() を使う。文字列は {var} で補間。
//
// カタログは領域別ファイル (src/i18n/<area>.js, `export default { en, ja }`) に分割し、
// ここで静的 import してマージする。新しい領域を足すときは下の import と AREAS に 1 行ずつ追加。

/** @typedef {"en"|"ja"} Locale */

import session from "./i18n/session.js";
import cli from "./i18n/cli.js";
import serve from "./i18n/serve.js";
import org from "./i18n/org.js";
import access from "./i18n/access.js";
import iot from "./i18n/iot.js";
import presetir from "./i18n/presetir.js";
import company from "./i18n/company.js";
import payment from "./i18n/payment.js";
import schedule from "./i18n/schedule.js";
import domain from "./i18n/domain.js";
import ble from "./i18n/ble.js";
import auth from "./i18n/auth.js";

const AREAS = [session, cli, serve, org, access, iot, presetir, company, payment, schedule, domain, ble, auth];

/**
 * メッセージカタログ。キー → 文字列テンプレート。
 * @type {{ en: Record<string, string>, ja: Record<string, string> }}
 */
const CATALOG = { en: {}, ja: {} };
for (const a of AREAS) {
  if (a?.en) Object.assign(CATALOG.en, a.en);
  if (a?.ja) Object.assign(CATALOG.ja, a.ja);
}

/** @type {Locale} */
let _locale = "en";

/** @param {string} [loc] */
export function setLocale(loc) {
  _locale = loc === "ja" ? "ja" : "en";
}

/** @returns {Locale} */
export function getLocale() {
  return _locale;
}

/**
 * メッセージを引く。未定義キーは en にフォールバックし、それも無ければキー文字列を返す。
 * @param {string} key
 * @param {Record<string, string|number>} [vars]
 */
export function t(key, vars) {
  const dict = CATALOG[_locale] || CATALOG.en;
  let s = key in dict ? dict[key] : key in CATALOG.en ? CATALOG.en[key] : key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/**
 * ロケールを解決する。優先順位: flag > configLang > 既定 "en"。
 * "ja"/"ja_JP.UTF-8" のような値は前方一致で判定 ("ja*"→ja, "en*"→en, それ以外は無視)。
 * @param {{ flag?: string|null, configLang?: string|null }} [src]
 * @returns {Locale}
 */
export function resolveLocale({ flag, configLang } = {}) {
  return pickLocale(flag) || pickLocale(configLang) || "en";
}

/**
 * 単一の言語値を "en"/"ja" へ正規化。未知/空は null。
 * @param {string|null|undefined} v
 * @returns {Locale|null}
 */
function pickLocale(v) {
  if (!v) return null;
  const s = String(v).toLowerCase();
  if (s.startsWith("ja")) return "ja";
  if (s.startsWith("en")) return "en";
  return null;
}

/**
 * 明示指定された言語値が認識可能 (en/ja 接頭辞) か。`--lang xx` のような未知値を
 * 黙って英語へ落とさず警告するための判定。空/未指定は「指定なし」として true 扱い。
 * @param {string|null|undefined} v
 * @returns {boolean}
 */
export function isKnownLang(v) {
  return !v || pickLocale(v) != null;
}
