// 対話 UI ヘルパ。矢印キー選択・テキスト入力・確認は @inquirer/prompts に委譲する
// (番号入力より UX が良く、ページング・検索・キャンセルも標準で効く)。
//
// 設計方針:
//   - `--json` 指定時や非 TTY (パイプ越し / cron) では呼ばない (呼び出し側で isInteractive 判定)。
//   - 公開 API (selectFromList / menu / promptText / confirm / isInteractive) は据え置き、
//     中身だけ inquirer 化。selectFromList は要素 1 個なら auto-pick、空なら throw を維持。

import { select, input, confirm as inquirerConfirm } from "@inquirer/prompts";

export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/** 先頭の "? " などの装飾を除いた素のメッセージ (inquirer が "? " を自前で付けるため)。 */
function plainMessage(m) {
  return String(m).replace(/^[?>\s]+/, "").trim();
}

/**
 * テキスト入力 prompt。空 OK なら required=false で。
 * @param {string} message
 * @param {{required?:boolean, defaultValue?:string|null}} [opts]
 */
export async function promptText(message, { required = true, defaultValue = null } = {}) {
  return input({
    message: plainMessage(message),
    default: defaultValue != null ? String(defaultValue) : undefined,
    validate: (v) => (required && defaultValue == null && !String(v).trim() ? "必須項目です" : true),
  }).then((v) => String(v).trim());
}

/**
 * yes/no 確認。デフォルトは defaultYes。
 * @param {string} message
 * @param {{defaultYes?:boolean}} [opts]
 */
export async function confirm(message, { defaultYes = true } = {}) {
  return inquirerConfirm({ message: plainMessage(message), default: defaultYes });
}

/**
 * リストから 1 つ選ばせる (↑↓ で移動 / Enter で決定)。要素 1 個なら auto-pick。空ならエラー。
 *
 * @template T
 * @param {string} message
 * @param {T[]} items
 * @param {(item:T) => string} [getLabel]  表示ラベル (default: String)
 * @returns {Promise<T>}
 */
export async function selectFromList(message, items, getLabel = String) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(`${message}: 候補がありません`);
  }
  if (items.length === 1) return items[0];

  return select({
    message: plainMessage(message),
    choices: items.map((it) => ({ name: getLabel(it), value: it })),
    pageSize: 12, // これを超えると ↑↓ でスクロール
    loop: false,
  });
}

/**
 * メニュー (selectFromList の薄いラッパ、ラベルだけ表示)。戻り値は選ばれたエントリの `value`。
 *
 * @param {string} title
 * @param {{label:string, value:any}[]} entries
 */
export async function menu(title, entries) {
  const chosen = await selectFromList(title, entries, (e) => e.label);
  return chosen.value;
}
