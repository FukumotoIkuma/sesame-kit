/** @typedef {import("./ctx.js").Program} Program */
/** @typedef {import("./ctx.js").CmdOpts} CmdOpts */
/** @typedef {import("./ctx.js").CliError} CliError */
/**
 * @param {string|undefined} email
 * @param {CmdOpts} _opts 予約 (コマンド固有オプション無し。シグネチャ統一のため保持)
 * @param {Program} program
 */
export function cmdLogin(email: string | undefined, _opts: CmdOpts, program: Program): Promise<void>;
/**
 * 認証後の自動セットアップ。接続して companyID 取得 → ロック / Hub3+リモコン を devices から取り込む。
 * best-effort: 各ステップは個別に try/catch し、失敗しても他を続行 (ネットワーク不調で認証成功を潰さない)。
 *
 * @typedef {{added:string[], updated:string[], removed?:string[]}} SyncResult
 * @typedef {object} BootstrapSummary
 * @property {string|null} companyID
 * @property {SyncResult|null} locks
 * @property {{added?:string[], updated?:string[]}|null} hub3s
 * @property {SyncResult|null} remotes
 * @property {string[]} errors
 * @property {boolean} [authExpired]
 *
 * @param {Program} program
 * @param {{ quiet?: boolean }} [opts]
 * @returns {Promise<BootstrapSummary>} 取り込みサマリ
 */
export function bootstrapAfterLogin(program: Program, { quiet }?: {
    quiet?: boolean;
}): Promise<BootstrapSummary>;
/**
 * @param {string|undefined} code
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
export function cmdVerify(code: string | undefined, _opts: CmdOpts, program: Program): Promise<void>;
/**
 * 認証後セットアップの手動再実行 (デバイス追加後など)。
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
export function cmdSetup(_opts: CmdOpts, program: Program): Promise<void>;
/**
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
export function cmdRefresh(_opts: CmdOpts, program: Program): Promise<void>;
/**
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
export function cmdLogout(_opts: CmdOpts, program: Program): Promise<void>;
/**
 * biz3GetLoginUser の customerInfo (companyID/subUUID 等)。client は object|null で返すため絞る。
 * @typedef {{ companyID?: string, subUUID?: string|null, name?: string, subscriptionId?: string }} CustomerInfo
 */
/**
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
export function cmdWhoami(_opts: CmdOpts, program: Program): Promise<void>;
/**
 * bootstrap (互換コマンド): app-login 済み token backup を stdin の JSON から復元する。
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
export function cmdBootstrap(_opts: CmdOpts, program: Program): Promise<void>;
export type Program = import("./ctx.js").Program;
export type CmdOpts = import("./ctx.js").CmdOpts;
export type CliError = import("./ctx.js").CliError;
/**
 * 認証後の自動セットアップ。接続して companyID 取得 → ロック / Hub3+リモコン を devices から取り込む。
 * best-effort: 各ステップは個別に try/catch し、失敗しても他を続行 (ネットワーク不調で認証成功を潰さない)。
 */
export type SyncResult = {
    added: string[];
    updated: string[];
    removed?: string[];
};
/**
 * 認証後の自動セットアップ。接続して companyID 取得 → ロック / Hub3+リモコン を devices から取り込む。
 * best-effort: 各ステップは個別に try/catch し、失敗しても他を続行 (ネットワーク不調で認証成功を潰さない)。
 */
export type BootstrapSummary = {
    companyID: string | null;
    locks: SyncResult | null;
    hub3s: {
        added?: string[];
        updated?: string[];
    } | null;
    remotes: SyncResult | null;
    errors: string[];
    authExpired?: boolean | undefined;
};
/**
 * biz3GetLoginUser の customerInfo (companyID/subUUID 等)。client は object|null で返すため絞る。
 */
export type CustomerInfo = {
    companyID?: string;
    subUUID?: string | null;
    name?: string;
    subscriptionId?: string;
};
//# sourceMappingURL=auth.d.ts.map