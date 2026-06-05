export function isInteractive(): boolean;
/**
 * テキスト入力 prompt。空 OK なら required=false で。
 * @param {string} message
 * @param {{required?:boolean, defaultValue?:string|null}} [opts]
 */
export function promptText(message: string, { required, defaultValue }?: {
    required?: boolean;
    defaultValue?: string | null;
}): Promise<string>;
/**
 * yes/no 確認。デフォルトは defaultYes。
 * @param {string} message
 * @param {{defaultYes?:boolean}} [opts]
 */
export function confirm(message: string, { defaultYes }?: {
    defaultYes?: boolean;
}): Promise<boolean>;
/**
 * リストから 1 つ選ばせる (↑↓ で移動 / Enter で決定)。要素 1 個なら auto-pick。空ならエラー。
 *
 * @template T
 * @param {string} message
 * @param {T[]} items
 * @param {(item:T) => string} [getLabel]  表示ラベル (default: String)
 * @returns {Promise<T>}
 */
export function selectFromList<T>(message: string, items: T[], getLabel?: (item: T) => string): Promise<T>;
/**
 * メニュー (selectFromList の薄いラッパ、ラベルだけ表示)。戻り値は選ばれたエントリの `value`。
 *
 * @param {string} title
 * @param {{label:string, value:any}[]} entries
 */
export function menu(title: string, entries: {
    label: string;
    value: any;
}[]): Promise<any>;
//# sourceMappingURL=prompts.d.ts.map