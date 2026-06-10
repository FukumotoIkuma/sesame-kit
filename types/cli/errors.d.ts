/** @param {boolean} on */
export function setJsonMode(on: boolean): void;
/** @returns {boolean} */
export function isJsonMode(): boolean;
/**
 * エラーを表示してプロセスを終了する。エラーは常に stderr へ (stdout は成功 JSON 専用)。
 * @param {string} msg
 * @param {number} [code] EXIT.RUNTIME(1) 既定。usage エラーは EXIT.USAGE(2)。
 * @returns {never}
 */
export function die(msg: string, code?: number): never;
/**
 * commander の usage エラーか (未知コマンド/オプション/引数欠落など)。
 * @param {unknown} err
 * @returns {boolean}
 */
export function isCommanderError(err: unknown): boolean;
/**
 * commander が投げる usage エラー (CommanderError 互換)。
 * @typedef {Error & {code?: string, exitCode?: number}} CommanderLikeError
 */
/**
 * commander エラーから {msg, code} を導く。usage 系は常に exit 2。
 * メッセージ先頭の "error: " は剥がす (--json 封筒で error が二重にならないように)。
 * @param {CommanderLikeError} err
 * @returns {{msg:string, code:number}}
 */
export function commanderErrorInfo(err: CommanderLikeError): {
    msg: string;
    code: number;
};
/**
 * commander 以外の一般エラーの exit code (明示 exitCode を尊重、無ければ 1)。
 * @param {unknown} err
 * @returns {number}
 */
export function runtimeExitCode(err: unknown): number;
/**
 * server が「未知のキー/デバイス」系エラーを返したら config が古い可能性を案内に添える。
 * ただし JSON-RPC の構造化エラー (err.rpcError マーカーや data.kind を持つ) と型付き
 * SesameError は既に正しい分類を持つので hint を付けない: `Method not found` のような
 * 単なる typo を「config が古い」と誤誘導しないため。
 * @param {unknown} err  Error オブジェクト (推奨) か message 文字列
 * @returns {string} 表示用メッセージ
 */
export function withStaleHint(err: unknown): string;
/** 終了コード契約 (README: 0=成功 / 1=ランタイム / 2=usage)。 */
export const EXIT: Readonly<{
    OK: 0;
    RUNTIME: 1;
    USAGE: 2;
}>;
/**
 * commander が投げる usage エラー (CommanderError 互換)。
 */
export type CommanderLikeError = Error & {
    code?: string;
    exitCode?: number;
};
//# sourceMappingURL=errors.d.ts.map