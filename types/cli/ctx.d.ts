/**
 * commander の Command (全コマンドハンドラに渡る program)。
 * @typedef {import("commander").Command} Program
 */
/**
 * グローバルオプション (program.opts())。--config-dir / --debug / --json / --lang。
 * commander が返す OptionValues は緩い型なので、既知キーだけ宣言し残りは index で許容する。
 * @typedef {object} GlobalOpts
 * @property {string} [configDir]
 * @property {boolean} [debug]
 * @property {boolean} [json]
 * @property {string} [lang]
 */
/**
 * commander のサブコマンドオプション (.action の opts 引数)。既知キーは個別 typedef で、
 * 汎用経路はこの緩い型で受ける。
 * @typedef {Record<string, any>} CmdOpts
 */
/**
 * client.js が投げうるエラー (SesameError 含む。code/message を読む場面用)。
 * @typedef {Error & {code?: string, exitCode?: number, message: string}} CliError
 */
/**
 * loadCtx() の戻り (ConfigStore / TokenStore / paths / opts)。
 * @typedef {object} CliLoadCtx
 * @property {Record<string, any>} opts commander の program.opts()
 * @property {import("../paths.js").ConfigPaths} paths
 * @property {import("../config.js").ConfigStore} configStore
 * @property {import("../tokens.js").FileTokenStore} tokenStore
 */
/**
 * withHub/withAccount のコールバックが受け取る追加情報。
 * @typedef {{ opts: Record<string, any>, paths: import("../paths.js").ConfigPaths }} HubExtra
 */
/**
 * @param {unknown} s
 * @returns {string}
 */
export function mask(s: unknown): string;
/** config show 用に config を複製し secretKey を**ツリー全体で**マスクする (tokens と同じ扱い)。
 *  config には devices と派生 locks の双方に鍵が入る等、複数箇所に現れるため一律で潰す。
 *  生の鍵が要るときは `sesame devices` (意図的な全ダンプ口) を使う。 */
/**
 * @param {unknown} cfg
 * @returns {unknown}
 */
export function redactConfig(cfg: unknown): unknown;
/**
 * @param {boolean|undefined} json
 * @param {() => void} humanFn
 * @param {unknown} jsonObj
 */
export function out(json: boolean | undefined, humanFn: () => void, jsonObj: unknown): void;
/**
 * program.opts() を吸い上げて ConfigStore / TokenStore / paths を返す。
 * @param {Program} program
 * @returns {CliLoadCtx}
 */
export function loadCtx(program: Program): CliLoadCtx;
/**
 * @param {Program} program
 * @param {(hub: SesameHub3, extra: HubExtra) => any} fn
 * @returns {Promise<any>}
 */
export function withHub(program: Program, fn: (hub: SesameHub3, extra: HubExtra) => any): Promise<any>;
/**
 * @param {string} question
 * @returns {Promise<string>}
 */
export function promptLine(question: string): Promise<string>;
/**
 * prompts が許可される条件: TTY かつ --json 指定なし。
 * @param {Program} program
 * @returns {boolean}
 */
export function canPrompt(program: Program): boolean;
/**
 * auto フォールバック先の cloud が使えるか (token があるか)。
 * @param {Program} program
 * @returns {boolean}
 */
export function hasCloudSession(program: Program): boolean;
/**
 * cli/ サブモジュール (registerXxxCommands) に渡す共有コンテキスト。makeCtx() の戻り。
 * 各 register は `register(program, ctx)` でこの ctx 越しに共有 helper を使う。
 * @typedef {object} CliCtx
 * @property {(json: boolean, humanFn: () => void, jsonObj: unknown) => void} out
 *   --json 指定時は jsonObj を、それ以外は humanFn() を出力。
 * @property {(msg: string, code?: number) => never} die エラー表示して exit (usage は code 2)。
 * @property {() => boolean} canPrompt TTY かつ --json なしなら true。
 * @property {() => CliLoadCtx} loadCtx ConfigStore/TokenStore/paths/opts を取得。
 * @property {(fn: (hub: import("../client.js").SesameHub3, extra: HubExtra) => any) => Promise<any>} withHub
 *   connect → fn(hub, {opts, paths}) → close。
 * @property {(fn: (hub: import("../client.js").SesameHub3, extra: HubExtra & { customerInfo: any }) => any) => Promise<any>} withAccount
 *   withHub に加え refreshAccount() 済み customerInfo を extra へ渡す。
 * @property {{ selectFromList: typeof selectFromList, promptText: typeof promptText, confirm: typeof confirmPrompt, promptLine: (question: string) => Promise<string> }} prompts
 * @property {(opts: any) => import("../ble/index.js").SesameBle} makeBle SesameBle ファサード生成。
 * @property {(raw: string, hint?: string) => any} parseJson --json 文字列を JSON.parse (失敗は die(...,2))。
 */
/**
 * cli/ サブモジュール (registerXxxCommands) に渡す共有コンテキストを作る。
 * program を内部に束縛し、新コマンドが cli.js の private helper に直接依存せず
 * ctx 越しに利用できるようにする (循環 import 回避 + cli.js 肥大化防止)。
 *
 * @param {import("commander").Command} program
 * @returns {CliCtx}
 */
export function makeCtx(program: import("commander").Command): CliCtx;
/**
 * commander の Command (全コマンドハンドラに渡る program)。
 */
export type Program = import("commander").Command;
/**
 * グローバルオプション (program.opts())。--config-dir / --debug / --json / --lang。
 * commander が返す OptionValues は緩い型なので、既知キーだけ宣言し残りは index で許容する。
 */
export type GlobalOpts = {
    configDir?: string | undefined;
    debug?: boolean | undefined;
    json?: boolean | undefined;
    lang?: string | undefined;
};
/**
 * commander のサブコマンドオプション (.action の opts 引数)。既知キーは個別 typedef で、
 * 汎用経路はこの緩い型で受ける。
 */
export type CmdOpts = Record<string, any>;
/**
 * client.js が投げうるエラー (SesameError 含む。code/message を読む場面用)。
 */
export type CliError = Error & {
    code?: string;
    exitCode?: number;
    message: string;
};
/**
 * loadCtx() の戻り (ConfigStore / TokenStore / paths / opts)。
 */
export type CliLoadCtx = {
    /**
     * commander の program.opts()
     */
    opts: Record<string, any>;
    paths: import("../paths.js").ConfigPaths;
    configStore: import("../config.js").ConfigStore;
    tokenStore: import("../tokens.js").FileTokenStore;
};
/**
 * withHub/withAccount のコールバックが受け取る追加情報。
 */
export type HubExtra = {
    opts: Record<string, any>;
    paths: import("../paths.js").ConfigPaths;
};
/**
 * cli/ サブモジュール (registerXxxCommands) に渡す共有コンテキスト。makeCtx() の戻り。
 * 各 register は `register(program, ctx)` でこの ctx 越しに共有 helper を使う。
 */
export type CliCtx = {
    /**
     *   --json 指定時は jsonObj を、それ以外は humanFn() を出力。
     */
    out: (json: boolean, humanFn: () => void, jsonObj: unknown) => void;
    /**
     * エラー表示して exit (usage は code 2)。
     */
    die: (msg: string, code?: number) => never;
    /**
     * TTY かつ --json なしなら true。
     */
    canPrompt: () => boolean;
    /**
     * ConfigStore/TokenStore/paths/opts を取得。
     */
    loadCtx: () => CliLoadCtx;
    /**
     *   connect → fn(hub, {opts, paths}) → close。
     */
    withHub: (fn: (hub: import("../client.js").SesameHub3, extra: HubExtra) => any) => Promise<any>;
    /**
     *   withHub に加え refreshAccount() 済み customerInfo を extra へ渡す。
     */
    withAccount: (fn: (hub: import("../client.js").SesameHub3, extra: HubExtra & {
        customerInfo: any;
    }) => any) => Promise<any>;
    prompts: {
        selectFromList: typeof selectFromList;
        promptText: typeof promptText;
        confirm: typeof confirmPrompt;
        promptLine: (question: string) => Promise<string>;
    };
    /**
     * SesameBle ファサード生成。
     */
    makeBle: (opts: any) => import("../ble/index.js").SesameBle;
    /**
     * --json 文字列を JSON.parse (失敗は die(...,2))。
     */
    parseJson: (raw: string, hint?: string) => any;
};
import { SesameHub3 } from "../client.js";
import { selectFromList } from "../prompts.js";
import { promptText } from "../prompts.js";
import { confirm as confirmPrompt } from "../prompts.js";
//# sourceMappingURL=ctx.d.ts.map