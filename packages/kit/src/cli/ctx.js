// CLI の共有コンテキスト (P5-3 で cli.js から抽出)。
//
// loadCtx (ConfigStore/TokenStore の構築)・withHub (connect→fn→close)・出力/マスク系
// (out/mask/redactConfig)・対話可否 (canPrompt/promptLine)・cli/ サブモジュールへ渡す
// makeCtx をここに集約する。依存方向: cli.js / cli/*.js → ctx.js (逆は無し)。

import { createInterface } from "node:readline/promises";
import { SesameHub3 } from "@sesame-kit/core/client";
import { ConfigStore } from "@sesame-kit/core/config";
import { FileTokenStore } from "@sesame-kit/core/tokens";
import { configPaths } from "@sesame-kit/core/paths";
import { t } from "@sesame-kit/core/i18n";
import { die } from "./errors.js";
import { isInteractive, selectFromList, promptText, confirm as confirmPrompt } from "../prompts.js";
import { SesameBle } from "@sesame-kit/core/ble";

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
 * @property {import("@sesame-kit/core/paths").ConfigPaths} paths
 * @property {import("@sesame-kit/core/config").ConfigStore} configStore
 * @property {import("@sesame-kit/core/tokens").FileTokenStore} tokenStore
 */

/**
 * withHub/withAccount のコールバックが受け取る追加情報。
 * @typedef {{ opts: Record<string, any>, paths: import("@sesame-kit/core/paths").ConfigPaths }} HubExtra
 */

/**
 * @param {unknown} s
 * @returns {string}
 */
export function mask(s) {
  if (typeof s !== "string") return /** @type {string} */ (s ?? "(none)");
  if (s.length <= 8) return s;
  return `${s.slice(0, 4)}…${s.slice(-4)} (len=${s.length})`;
}

/** config show 用に config を複製し secretKey を**ツリー全体で**マスクする (tokens と同じ扱い)。
 *  config には devices と派生 locks の双方に鍵が入る等、複数箇所に現れるため一律で潰す。
 *  生の鍵が要るときは `sesame devices` (意図的な全ダンプ口) を使う。 */
/**
 * @param {unknown} cfg
 * @returns {unknown}
 */
export function redactConfig(cfg) {
  if (!cfg || typeof cfg !== "object") return cfg;
  const clone = structuredClone(cfg);
  (/** @param {Record<string, any>} o */ function walk(o) {
    if (!o || typeof o !== "object") return;
    for (const [k, v] of Object.entries(o)) {
      if (k === "secretKey" && typeof v === "string") o[k] = mask(v);
      else walk(v);
    }
  })(clone);
  return clone;
}

/**
 * @param {boolean|undefined} json
 * @param {() => void} humanFn
 * @param {unknown} jsonObj
 */
export function out(json, humanFn, jsonObj) {
  if (json) console.log(JSON.stringify(jsonObj, null, 2));
  else humanFn();
}

/**
 * program.opts() を吸い上げて ConfigStore / TokenStore / paths を返す。
 * @param {Program} program
 * @returns {CliLoadCtx}
 */
export function loadCtx(program) {
  const opts = program.opts();
  const paths = configPaths(opts.configDir);
  const configStore = new ConfigStore(paths.config);
  const tokenStore = new FileTokenStore({
    tokensPath: paths.tokens,
    loginStatePath: paths.loginState,
  });
  return { opts, paths, configStore, tokenStore };
}

/**
 * @param {Program} program
 * @param {(hub: SesameHub3, extra: HubExtra) => any} fn
 * @returns {Promise<any>}
 */
export async function withHub(program, fn) {
  const { opts, paths, configStore, tokenStore } = loadCtx(program);
  if (!configStore.exists()) {
    die(t("cli.noConfigRun", { path: paths.config }), 2);
  }
  const hub = new SesameHub3({
    config: configStore.load(),
    configStore,
    tokenStore,
    debug: !!opts.debug,
  });
  try {
    await hub.connect();
    return await fn(hub, { opts, paths });
  } finally {
    await hub.close();
  }
}

/**
 * @param {string} question
 * @returns {Promise<string>}
 */
export async function promptLine(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.once("close", () => { closed = true; });
  try {
    const ans = await rl.question(question);
    // 3rd-pass L-1: Ctrl-D (EOF) で空文字 resolve した場合は throw (無限ループ防止)
    if (closed && !ans) throw new Error(t("cli.promptAbortedEof"));
    return ans.trim();
  } finally {
    rl.close();
  }
}

/**
 * prompts が許可される条件: TTY かつ --json 指定なし。
 * @param {Program} program
 * @returns {boolean}
 */
export function canPrompt(program) {
  return isInteractive() && !program.opts().json;
}

/**
 * auto フォールバック先の cloud が使えるか (token があるか)。
 * @param {Program} program
 * @returns {boolean}
 */
export function hasCloudSession(program) {
  const { tokenStore } = loadCtx(program);
  const tok = tokenStore.load();
  return !!(tok && (tok.refreshToken || tok.idToken));
}

/**
 * cli/ サブモジュール (registerXxxCommands) に渡す共有コンテキスト。makeCtx() の戻り。
 * 各 register は `register(program, ctx)` でこの ctx 越しに共有 helper を使う。
 * @typedef {object} CliCtx
 * @property {(json: boolean, humanFn: () => void, jsonObj: unknown) => void} out
 *   --json 指定時は jsonObj を、それ以外は humanFn() を出力。
 * @property {(msg: string, code?: number) => never} die エラー表示して exit (usage は code 2)。
 * @property {() => boolean} canPrompt TTY かつ --json なしなら true。
 * @property {() => CliLoadCtx} loadCtx ConfigStore/TokenStore/paths/opts を取得。
 * @property {(fn: (hub: import("@sesame-kit/core/client").SesameHub3, extra: HubExtra) => any) => Promise<any>} withHub
 *   connect → fn(hub, {opts, paths}) → close。
 * @property {(fn: (hub: import("@sesame-kit/core/client").SesameHub3, extra: HubExtra & { customerInfo: any }) => any) => Promise<any>} withAccount
 *   withHub に加え refreshAccount() 済み customerInfo を extra へ渡す。
 * @property {{ selectFromList: typeof selectFromList, promptText: typeof promptText, confirm: typeof confirmPrompt, promptLine: (question: string) => Promise<string> }} prompts
 * @property {(opts: any) => import("@sesame-kit/core/ble").SesameBle} makeBle SesameBle ファサード生成。
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
export function makeCtx(program) {
  return {
    /** out(json, humanFn, jsonObj): --json 指定時は jsonObj を、それ以外は humanFn() を出力 */
    out,
    /** die(msg, code=1): エラー表示して exit */
    die,
    /** canPrompt(): TTY かつ --json なし */
    canPrompt: () => canPrompt(program),
    /** loadCtx(): { opts, paths, configStore, tokenStore } */
    loadCtx: () => loadCtx(program),
    /** withHub(fn): connect → fn(hub, {opts, paths}) → close */
    withHub: (fn) => withHub(program, fn),
    /**
     * withAccount(fn): withHub に加え、実行前に refreshAccount() で実 companyID /
     * subUUID を保証する (org / company など companyID 必須の op 用)。
     * refreshAccount() の戻り (customerInfo) を fn の第2引数 extra.customerInfo に渡すため、
     * employeeEmail/subUUID が要るコマンドは getLoginUser() を再度呼ばず済む。
     */
    withAccount: (fn) =>
      withHub(program, async (hub, extra) => {
        const customerInfo = await hub.refreshAccount();
        return fn(hub, { ...extra, customerInfo });
      }),
    /** 対話 prompt 群 */
    prompts: { selectFromList, promptText, confirm: confirmPrompt, promptLine },
    /** makeBle(opts): SesameBle ファサード生成 (BLE enroll 等で使用。テストで差し替え可能な seam)。 */
    makeBle: (opts) => new SesameBle(opts),
    /**
     * parseJson(raw, hint): --json 文字列を JSON.parse。失敗時は die(...,2) し undefined を返す。
     * cli/ 各モジュールで重複していた parseJsonArg を 1 本化したもの。
     */
    /**
     * @param {string} raw
     * @param {string} [hint]
     * @returns {any}
     */
    parseJson(raw, hint) {
      try {
        return JSON.parse(raw);
      } catch (e) {
        die(t("cli.invalidJsonValue", { message: /** @type {CliError} */ (e).message }) + (hint ? t("cli.invalidJsonExample", { hint }) : ""), 2);
        return undefined;
      }
    },
  };
}
