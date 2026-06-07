// 極小 i18n。中央メッセージカタログ + t(key, vars)。
//
// 既定は英語 (README が英語デフォルトのため)。日本語は明示切替:
//   ロケール解決の優先順位: --lang フラグ  >  config の uiLang  >  既定 "en"
// (システムロケール LANG/LC_ALL での自動切替はあえて採らない = 既定は常に en)。
//
// CLI 起動時に呼び出し側が setLocale() してから t() を使う。文字列は {var} で補間。

/** @typedef {"en"|"ja"} Locale */

const CATALOG = {
  en: {
    // --- interactive session UI (src/session-ui.js) ---
    "session.title": "─── SESAME session ───",
    "session.hints": "↑↓ move  → confirm  ← back  q quit",
    "session.busy": "Working...",
    "session.devicesTitle": "Pick a device:",
    "session.actionsTitle": "{name} — actions:",
    "session.quit": "Quit",
    "session.back": "← Back",
    "session.autolockPrompt": "{name} autolock seconds (0 = off): ",
    "session.ledPrompt": "{name} LED brightness (0-255): ",
    "session.numRange": "⚠ Enter an integer in 0..{max}.",
    "session.irPickRemote": "{name} IR: pick a remote",
    "session.noRemotes": "{name}: no remotes registered (add with `sesame remote add`). ← / Esc to go back",
    "session.irPickKey": "{remote} keys (send):",
    "session.keysLoading": "{remote}: loading keys...",
    "session.noKeys": "{remote}: no keys (run `sesame remote sync-keys`). ← / Esc to go back",
  },
  ja: {
    "session.title": "─── SESAME セッション ───",
    "session.hints": "↑↓ 移動  → 決定  ← 戻る  q 終了",
    "session.busy": "実行中...",
    "session.devicesTitle": "操作するデバイス:",
    "session.actionsTitle": "{name} の操作:",
    "session.quit": "終了",
    "session.back": "← 戻る",
    "session.autolockPrompt": "{name} オートロック秒数 (0=無効): ",
    "session.ledPrompt": "{name} LED 調光 (0-255): ",
    "session.numRange": "⚠ 0..{max} の整数で指定してください。",
    "session.irPickRemote": "{name} の IR: リモコン選択",
    "session.noRemotes": "{name}: 登録リモコンがありません ( sesame remote add で登録 )。← / Esc で戻る",
    "session.irPickKey": "{remote} のキー選択 (送信):",
    "session.keysLoading": "{remote}: キー取得中...",
    "session.noKeys": "{remote}: キーがありません ( sesame remote sync-keys )。← / Esc で戻る",
  },
};

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
  const pick = (v) => {
    if (!v) return null;
    const s = String(v).toLowerCase();
    if (s.startsWith("ja")) return "ja";
    if (s.startsWith("en")) return "en";
    return null;
  };
  return pick(flag) || pick(configLang) || "en";
}
