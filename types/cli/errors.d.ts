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
 * maybeHandleBleError のテスト用 seam (バックログ9)。実 BLE 環境 (権限拒否等) が無いと
 * 経路を起動できないため、副作用 (platform 判定・設定ペイン spawn・exitCode 設定) を
 * 注入可能にする。本番 (cli.js / cli/lock-ops.js) は引数無しで呼び、既定の実体を使う。
 * @typedef {object} BleErrorDeps
 * @property {NodeJS.Platform} [platform] 既定 process.platform
 * @property {typeof spawn} [spawnFn] 既定 node:child_process.spawn
 * @property {(code: number) => void} [setExitCode] 既定 process.exitCode への代入
 */
/**
 * BLE 権限/電源系エラーを検知し、macOS なら設定ペインを開いて案内する。
 * 旧実装は cli.js の内部関数で、tests/cli/errors.test.js がソース文字列で挙動を固定していた
 * (バックログ9)。挙動契約は不変: exit 1 (SURF-19: ランタイム障害。2 は usage 専用) /
 * --json 封筒は {error, code:1, bleCode} で bleCode (機械可読な BLE 分類) を維持する。
 * @param {unknown} err
 * @param {BleErrorDeps} [deps]
 * @returns {boolean} ハンドルした (= 呼び出し側は return) なら true
 */
export function maybeHandleBleError(err: unknown, deps?: BleErrorDeps): boolean;
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
/**
 * maybeHandleBleError のテスト用 seam (バックログ9)。実 BLE 環境 (権限拒否等) が無いと
 * 経路を起動できないため、副作用 (platform 判定・設定ペイン spawn・exitCode 設定) を
 * 注入可能にする。本番 (cli.js / cli/lock-ops.js) は引数無しで呼び、既定の実体を使う。
 */
export type BleErrorDeps = {
    /**
     * 既定 process.platform
     */
    platform?: NodeJS.Platform | undefined;
    /**
     * 既定 node:child_process.spawn
     */
    spawnFn?: typeof spawn | undefined;
    /**
     * 既定 process.exitCode への代入
     */
    setExitCode?: ((code: number) => void) | undefined;
};
import { spawn } from "node:child_process";
//# sourceMappingURL=errors.d.ts.map