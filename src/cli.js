// commander ベースの CLI。bin/sesame.js から run() を呼ぶ。
//
// 設計メモ:
// - グローバルオプション --config-dir / --debug / --json は program.opts() で取得
// - 全コマンドは loadCtx() でファクトリ越しに ConfigStore / TokenStore を得る
// - 出力は --json 指定時に JSON.stringify、それ以外は人間可読
// - 位置引数が足りない & TTY & !--json なら対話 prompt (src/prompts.js)

import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { SesameHub3 } from "./client.js";
import { ConfigStore } from "./config.js";
import { FileTokenStore } from "./tokens.js";
import { configPaths } from "./paths.js";
import { ensureSecureDir, writeSecretJson, restrictSecretFile } from "./secure-fs.js";
import { setLocale, resolveLocale, isKnownLang, t } from "./i18n.js";
import {
  die, setJsonMode, isJsonMode, withStaleHint,
  isCommanderError, commanderErrorInfo, runtimeExitCode,
} from "./cli/errors.js";
import { routeDeviceArgv } from "./cli/dispatch.js";
import {
  bootstrap,
  CONFIG_META,
  getValidIdToken,
  loginInitiate,
  loginVerify,
  logout,
} from "./auth.js";
import { SesameError, ERR } from "./errors.js";
import { isInteractive, selectFromList, promptText, confirm as confirmPrompt } from "./prompts.js";
import { parseIrType, DEFAULT_IR_TYPE } from "./crypto.js";
import { parseShareKeyUrl } from "./sharekey.js";
import { registerScheduleCommands } from "./cli/schedule.js";
import { registerCompanyCommands } from "./cli/company.js";
import { registerPaymentCommands } from "./cli/payment.js";
import { registerOrgCommands } from "./cli/org.js";
import { registerAccessCommands } from "./cli/access.js";
import { registerIotCommands } from "./cli/iot.js";
import { registerPresetIrCommands } from "./cli/presetir.js";
import { registerBleCommands } from "./cli/ble.js";
import { registerServeCommand } from "./cli/serve.js";
import { SesameBle, capabilitiesForModel, transportsForOp, CONTROL_OPS } from "./ble/index.js";
import { bleWasUsed } from "./ble/transport.js";
import { EventEmitter } from "node:events";
// session-ui (ink + react) は session でしか使わないので、起動コスト削減のため動的 import する。

const __dirname = dirname(fileURLToPath(import.meta.url));

// --json 契約・die()・終了コード・stale hint は src/cli/errors.js に集約 (横断のエラー契約)。
// 表示用 out() のみここに残す (--json は引数で受ける)。

/**
 * commander の Command (全コマンドハンドラに渡る program)。
 * @typedef {import("commander").Command} Program
 */

/** @typedef {import("./client.js").DeviceInfo} DeviceInfo */
/** @typedef {import("./client.js").IRKey} IRKey */
/** @typedef {import("./config.js").LoadedConfig} LoadedConfig */

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

/** 統合ロック操作の解決済み entry。 */
/**
 * @typedef {object} LockEntry
 * @property {string} name
 * @property {string} deviceUUID
 * @property {string} secretKey
 * @property {string|null} [model]
 */

/**
 * config 由来の Hub3 entry (relay/LED 用 secretKey 付き)。
 * @typedef {object} Hub3Entry
 * @property {string} name
 * @property {string|undefined} deviceId
 * @property {string} model
 * @property {string|null} secretKey
 */

// ---------- 共通ユーティリティ ----------

function getPkgVersion() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * @param {unknown} s
 * @returns {string}
 */
function mask(s) {
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
function redactConfig(cfg) {
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
function out(json, humanFn, jsonObj) {
  if (json) console.log(JSON.stringify(jsonObj, null, 2));
  else humanFn();
}

/**
 * program.opts() を吸い上げて ConfigStore / TokenStore / paths を返す。
 * @param {Program} program
 * @returns {CliLoadCtx}
 */
function loadCtx(program) {
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
 * loadCtx() の戻り (ConfigStore / TokenStore / paths / opts)。
 * @typedef {object} CliLoadCtx
 * @property {Record<string, any>} opts commander の program.opts()
 * @property {import("./paths.js").ConfigPaths} paths
 * @property {import("./config.js").ConfigStore} configStore
 * @property {import("./tokens.js").FileTokenStore} tokenStore
 */

/**
 * withHub/withAccount のコールバックが受け取る追加情報。
 * @typedef {{ opts: Record<string, any>, paths: import("./paths.js").ConfigPaths }} HubExtra
 */

/**
 * cli/ サブモジュール (registerXxxCommands) に渡す共有コンテキスト。makeCtx() の戻り。
 * 各 register は `register(program, ctx)` でこの ctx 越しに cli.js の helper を使う。
 * @typedef {object} CliCtx
 * @property {(json: boolean, humanFn: () => void, jsonObj: unknown) => void} out
 *   --json 指定時は jsonObj を、それ以外は humanFn() を出力。
 * @property {(msg: string, code?: number) => never} die エラー表示して exit (usage は code 2)。
 * @property {() => boolean} canPrompt TTY かつ --json なしなら true。
 * @property {() => CliLoadCtx} loadCtx ConfigStore/TokenStore/paths/opts を取得。
 * @property {(fn: (hub: import("./client.js").SesameHub3, extra: HubExtra) => any) => Promise<any>} withHub
 *   connect → fn(hub, {opts, paths}) → close。
 * @property {(fn: (hub: import("./client.js").SesameHub3, extra: HubExtra & { customerInfo: any }) => any) => Promise<any>} withAccount
 *   withHub に加え refreshAccount() 済み customerInfo を extra へ渡す。
 * @property {{ selectFromList: typeof selectFromList, promptText: typeof promptText, confirm: typeof confirmPrompt, promptLine: (question: string) => Promise<string> }} prompts
 * @property {(opts: any) => import("./ble/index.js").SesameBle} makeBle SesameBle ファサード生成。
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
function makeCtx(program) {
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

/**
 * @param {Program} program
 * @param {(hub: SesameHub3, extra: HubExtra) => any} fn
 * @returns {Promise<any>}
 */
async function withHub(program, fn) {
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
async function promptLine(question) {
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
function canPrompt(program) {
  return isInteractive() && !program.opts().json;
}

/**
 * 名前未指定 & 対話可能なら、設定済みリストから選択させる。
 * @param {Program} program
 * @param {ConfigStore} configStore
 * @param {string|undefined} current
 * @returns {Promise<string|null|undefined>}
 */
async function pickRemoteName(program, configStore, current) {
  if (current) return current;
  const cfg = configStore.load();
  const names = Object.keys(cfg.remotes || {});
  if (names.length === 0) die(t("cli.remotesNotRegistered"), 2);
  if (names.length === 1) return names[0];
  if (!canPrompt(program)) return null;
  return selectFromList(t("cli.whichRemote"), names, (n) => {
    const r = cfg.remotes[n];
    const def = n === cfg.default?.remote ? " *" : "";
    return `${n}${def}\thub3=${r.hub3}\tkeys=${Object.keys(r.keys || {}).length}${r.alias ? `\t(${r.alias})` : ""}`;
  });
}

/**
 * @param {Program} program
 * @param {ConfigStore} configStore
 * @param {string|null|undefined} remoteName
 * @param {string|undefined} current
 * @returns {Promise<string|null|undefined>}
 */
async function pickRemoteKeyName(program, configStore, remoteName, current) {
  if (current) return current;
  const cfg = configStore.load();
  const rn = /** @type {string} */ (remoteName);
  const remote = cfg.remotes?.[rn];
  if (!remote) die(t("cli.unknownRemote", { remote: rn }), 2);
  const keys = Object.keys(remote.keys || {});
  if (keys.length === 0) die(t("cli.remoteNoKeys", { remote: rn }), 2);
  if (!canPrompt(program)) return null;
  return selectFromList(t("cli.whichRemoteKey", { remote: rn }), keys, (k) => `${k}\t${remote.keys[k]}`);
}

/**
 * Hub から デバイス一覧を取って UUID を選ばせる (model フィルタ任意)。
 * @param {Program} program
 * @param {SesameHub3} hub
 * @param {string|undefined} current
 * @param {{ filter?: (d: DeviceInfo) => boolean, message?: string }} [opts]
 * @returns {Promise<string|undefined>}
 */
async function pickDeviceUUID(program, hub, current, { filter, message = t("cli.whichDevice") } = {}) {
  if (current) return current;
  /** @type {DeviceInfo[]} */
  let list;
  try { list = await hub.listUserDevices(); } catch { list = []; }
  if (!list.length) {
    try { list = await hub.listDevices(); } catch { /* ignore */ }
  }
  const filtered = filter ? (list || []).filter(filter) : (list || []);
  if (!filtered.length) die(t("cli.devicesNotFound"), 2);
  // 1 個ならそれを auto-pick (Review L-4)
  if (filtered.length === 1) return filtered[0].deviceUUID;
  if (!canPrompt(program)) {
    // 非対話で複数候補あり → 具体的な救済策をエラーに含める
    // (3rd-pass L-2: 外側の `list` を shadow しないようリネーム)
    const summary = filtered.map((d) => `  ${d.deviceUUID}\t${d.deviceModel || "?"}\t${d.deviceName || ""}`).join("\n");
    die(t("cli.multipleDevicesNeedUuid", { summary }), 2);
  }
  const chosen = await selectFromList(message, filtered, (d) =>
    `${d.deviceName || "(no name)"}\t${d.deviceModel || "?"}\t${d.deviceUUID}`);
  return chosen.deviceUUID;
}

// ---------- コマンド: 認証 ----------

/**
 * @param {string|undefined} email
 * @param {CmdOpts} opts
 * @param {Program} program
 */
async function cmdLogin(email, opts, program) {
  if (!email) die(t("cli.emailRequired"), 2);
  const { tokenStore } = loadCtx(program);
  await loginInitiate(tokenStore, email);
  out(isJsonMode(), () => {
    console.log(t("cli.loginSent", { email }));
    console.log(t("cli.loginStep2"));
  }, { ok: true, email, next: "sesame verify <code>" });
}

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
async function bootstrapAfterLogin(program, { quiet = false } = {}) {
  /** @param {...unknown} a */
  const log = (...a) => { if (!quiet) console.error(...a); };
  /** @type {BootstrapSummary} */
  const summary = { companyID: null, locks: null, hub3s: null, remotes: null, errors: [] };
  try {
    await withHub(program, async (hub) => {
      try {
        const ci = /** @type {CustomerInfo|null} */ (await hub.refreshAccount());
        summary.companyID = ci?.companyID || null;
        log(t("cli.bootAccount", { companyID: summary.companyID || "default" }));
      } catch (e) { summary.errors.push(`account: ${/** @type {CliError} */ (e).message}`); log(t("cli.bootAccountFail", { message: /** @type {CliError} */ (e).message })); }

      try {
        const r = await hub.syncLocksFromDevices({});
        summary.locks = r;
        log(t("cli.bootLocks", { added: r.added.length, updated: r.updated.length, names: r.added.length ? ` (${r.added.join(", ")})` : "" }));
      } catch (e) { summary.errors.push(`locks: ${/** @type {CliError} */ (e).message}`); log(t("cli.bootLocksFail", { message: /** @type {CliError} */ (e).message })); }

      try {
        const r = await hub.syncHub3sFromDevices();
        summary.hub3s = r;
        log(t("cli.bootHub3", { added: r.added?.length || 0, names: r.added?.length ? ` (${r.added.join(", ")})` : "" }));
      } catch (e) { summary.errors.push(`hub3s: ${/** @type {CliError} */ (e).message}`); log(t("cli.bootHub3Fail", { message: /** @type {CliError} */ (e).message })); }

      try {
        const { remotes } = await hub.syncRemotesFromDevices();
        for (const name of [...remotes.added, ...remotes.updated]) { try { await hub.syncRemoteKeys(name); } catch { /* best effort */ } }
        summary.remotes = remotes;
        log(t("cli.bootRemotes", { added: remotes.added.length, names: remotes.added.length ? ` (${remotes.added.join(", ")})` : "" }));
      } catch (e) { summary.errors.push(`remotes: ${/** @type {CliError} */ (e).message}`); log(t("cli.bootRemotesFail", { message: /** @type {CliError} */ (e).message })); }
    });
  } catch (e) {
    summary.errors.push(`connect: ${/** @type {CliError} */ (e).message}`);
    // 認証失効は構造化エラーで判定 (getValidIdToken が SesameError(UNAUTHENTICATED) を投げる)。
    // message 文字列マッチ (/token/i 等の誤爆) を排除。
    const authExpired = e instanceof SesameError && e.code === ERR.UNAUTHENTICATED;
    summary.authExpired = authExpired;
    if (authExpired) log(t("cli.bootAuthExpired", { message: /** @type {CliError} */ (e).message }));
    else log(t("cli.bootConnectFail", { message: /** @type {CliError} */ (e).message }));
  }
  return summary;
}

/**
 * @param {string|undefined} code
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdVerify(code, _opts, program) {
  const { opts, tokenStore } = loadCtx(program);
  if (!code && canPrompt(program)) code = await promptLine(t("cli.verifyCodePrompt"));
  if (!code) die(t("cli.codeRequired"), 2);
  const tok = await loginVerify(tokenStore, code);
  if (!opts.json) console.error(t("cli.signedInAutoSetup"));
  // 認証後の取り込みを自動化 (companyID / ロック / Hub3 IR)。失敗しても認証成功は維持。
  const bootstrap = await bootstrapAfterLogin(program, { quiet: !!opts.json });
  out(opts.json, () => {
    const lk = bootstrap.locks ? bootstrap.locks.added.length + bootstrap.locks.updated.length : 0;
    console.log(t("cli.verifyDone", { count: lk }));
    console.log(t("cli.verifyExamples"));
    if (bootstrap.errors.length) console.log(t("cli.verifyPartialFail"));
  }, {
    ok: true,
    clientId: tok.clientId,
    username: tok.username,
    deviceKey: tok.deviceKey ? "set" : null,
    bootstrap,
  });
}

/**
 * 認証後セットアップの手動再実行 (デバイス追加後など)。
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdSetup(_opts, program) {
  const { opts, tokenStore } = loadCtx(program);
  if (!tokenStore.load()) die(t("cli.notLoggedIn"), 2);
  if (!opts.json) console.error(t("cli.setupRunning"));
  const bootstrap = await bootstrapAfterLogin(program, { quiet: !!opts.json });
  const failed = bootstrap.errors.length > 0;
  out(opts.json, () => {
    if (bootstrap.authExpired) {
      console.error(t("cli.setupAuthExpired"));
    } else if (failed) {
      console.error(t("cli.setupPartialFail", { errors: bootstrap.errors.join("; ") }));
    } else {
      console.log(t("cli.setupDone"));
    }
  }, { ok: !failed, bootstrap });
  if (failed) process.exitCode = 1;
}

/**
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdRefresh(_opts, program) {
  const { opts, tokenStore } = loadCtx(program);
  const tok = await getValidIdToken(tokenStore, { marginSec: 999999 });
  out(opts.json, () => {
    console.log(t("cli.idTokenRefreshed", { len: tok.length }));
  }, { ok: true, idTokenLength: tok.length });
}

/**
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdLogout(_opts, program) {
  const { opts, tokenStore } = loadCtx(program);
  if (!tokenStore.load()) {
    out(opts.json, () => console.log(t("cli.logoutNoSession")), { ok: true, alreadyLoggedOut: true });
    return;
  }
  // サーバ側 (ForgetDevice + RevokeToken) もクリーンにしてからローカルを消す。
  const r = await logout(tokenStore);
  out(opts.json, () => {
    console.log(t("cli.logoutDone"));
    if (!r.revokedToken || !r.forgotDevice) console.error(t("cli.logoutPartial"));
  }, { ok: true, ...r });
}

/**
 * biz3GetLoginUser の customerInfo (companyID/subUUID 等)。client は object|null で返すため絞る。
 * @typedef {{ companyID?: string, subUUID?: string|null, name?: string, subscriptionId?: string }} CustomerInfo
 */

/**
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdWhoami(_opts, program) {
  await withHub(program, async (hub, { opts }) => {
    // biz3GetLoginUser で customerInfo/quotas を取得し、実 companyID を config に保存
    const customerInfo = /** @type {CustomerInfo|null} */ (await hub.refreshAccount());
    const quotas = (await hub.getLoginUser()).quotas;
    out(opts.json, () => {
      if (!customerInfo) { console.log(t("cli.noCustomerInfo")); return; }
      console.log(t("cli.companyId", { companyID: /** @type {string} */ (customerInfo.companyID) }));
      console.log(t("cli.subUuid", { subUUID: customerInfo.subUUID || "(none)" }));
      if (customerInfo.name) console.log(t("cli.name", { name: customerInfo.name }));
      if (customerInfo.subscriptionId) console.log(t("cli.subscription", { subscriptionId: customerInfo.subscriptionId }));
      console.log(t("cli.companyIdSaved"));
    }, { ok: true, customerInfo, quotas });
  });
}

// ---------- コマンド: 操作 ----------

/**
 * --remote <name> を取る系のオプション袋。
 * @typedef {{ remote?: string|null }} RemoteOpts
 */

/**
 * @param {string|null|undefined} key
 * @param {RemoteOpts} options
 * @param {Program} program
 */
async function cmdSend(key, options, program) {
  const { configStore } = loadCtx(program);
  if (configStore.exists()) {
    const remoteName = await pickRemoteName(program, configStore, options.remote ?? undefined);
    if (!remoteName && !options.remote) die(t("cli.remoteRequiredNonInteractive"), 2);
    options.remote = remoteName || options.remote;
    if (!key) {
      key = await pickRemoteKeyName(program, configStore, options.remote, key ?? undefined);
      if (!key) die(t("cli.keyRequiredNonInteractive"), 2);
    }
  } else if (!key) {
    die(t("cli.keyRequired"), 2);
  }
  await withHub(program, async (hub, { opts }) => {
    const resp = /** @type {{ data?: { message?: string } }} */ (await hub.send(options.remote ?? null, /** @type {string} */ (key)));
    out(opts.json, () => {
      console.log(t("cli.okSend", { key }));
      if (resp?.data?.message) console.log(`   ${resp.data.message}`);
    }, { ok: true, key, response: resp });
  });
}

/**
 * @param {RemoteOpts} options
 * @param {Program} program
 */
async function cmdList(options, program) {
  const { configStore } = loadCtx(program);
  if (configStore.exists()) {
    options.remote = await pickRemoteName(program, configStore, options.remote ?? undefined) || options.remote;
  }
  await withHub(program, async (hub, { opts }) => {
    const codes = await hub.listKeys(options.remote ?? null);
    out(opts.json, () => {
      if (!Array.isArray(codes) || codes.length === 0) {
        console.log(t("cli.noKeys"));
        return;
      }
      console.log(t("cli.foundKeys", { count: codes.length }));
      for (const c of codes) console.log(`  ${c.name}\t${c.keyUUID}`);
    }, { ok: true, count: codes.length, keys: codes });
  });
}

/**
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdPing(_opts, program) {
  await withHub(program, async (hub, { opts }) => {
    await hub.ping();
    out(opts.json, () => console.log(t("cli.okKeepalive")), { ok: true });
  });
}

/**
 * listDevices の生レコードは DeviceRecord より広い (keyLevel / sesame2PublicKey 等の生フィールド)。
 * @typedef {DeviceInfo & { keyLevel?: number, sesame2PublicKey?: string }} FullDeviceInfo
 */

/**
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdDevices(_opts, program) {
  await withHub(program, async (hub, { opts, paths }) => {
    const list = /** @type {FullDeviceInfo[]} */ (await hub.listDevices());
    // devices.json には secretKey が入るので 0600 / 親 0700 で書く (旧実装は mode 無指定で 0644)。
    writeSecretJson(paths.devices, { devices: list });
    out(opts.json, () => {
      console.log(t("cli.foundDevices", { count: list.length }));
      for (const d of list) {
        console.log(`  ${d.deviceName}`);
        console.log(`    model:     ${d.deviceModel}`);
        console.log(`    UUID:      ${d.deviceUUID}`);
        console.log(`    keyLevel:  ${d.keyLevel}`);
        console.log(`    publicKey: ${mask(d.sesame2PublicKey)}`);
        console.log(`    secretKey: ${mask(d.secretKey)}`);
        console.log("");
      }
      console.log(t("cli.savedTo", { path: paths.devices }));
    }, { ok: true, count: list.length, devices: list, savedTo: paths.devices });
  });
}

// ---------- コマンド: セットアップ / 設定 ----------

/**
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdInit(_opts, program) {
  const { opts, paths, configStore } = loadCtx(program);
  ensureSecureDir(paths.dir); // 0700 で作成 (旧実装は mode 無指定で 0755 になっていた)
  // `sesame --lang en init` の意図を config に焼き込み、次回以降のセッションへ引き継ぐ。
  const created = configStore.init(CLI_LANG_FLAG ? { uiLang: CLI_LANG_FLAG, lang: CLI_LANG_FLAG } : {});
  out(opts.json, () => {
    if (created) console.log(t("cli.okCreated", { path: paths.config }));
    else         console.log(t("cli.alreadyExists", { path: paths.config }));
    console.log(``);
    console.log(t("cli.initNode", { version: process.version }));
    console.log(t("cli.initCompanyId"));
    console.log(``);
    console.log(t("cli.initNextSteps"));
    console.log(t("cli.initStep1"));
    console.log(t("cli.initStep2a"));
    console.log(t("cli.initStep2b"));
    console.log(``);
    console.log(t("cli.initConcept"));
    console.log(t("cli.initConcept2"));
    console.log(t("cli.initConcept3"));
    console.log(``);
    console.log(t("cli.initNpmLink"));
    console.log(t("cli.initNpmLink2"));
  }, { ok: true, created, configPath: paths.config, nodeVersion: process.version });
}

/**
 * @param {CmdOpts} opts
 * @param {Program} program
 */
async function cmdConfigPath(opts, program) {
  const { paths } = loadCtx(program);
  out(isJsonMode(), () => console.log(paths.dir), { dir: paths.dir });
}

/**
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdConfigShow(_opts, program) {
  const { opts, paths, configStore, tokenStore } = loadCtx(program);
  const cfg = configStore.exists() ? configStore.load() : null;
  const tokens = tokenStore.load();
  const tokensMasked = tokens
    ? {
        clientId: tokens.clientId,
        username: tokens.username,
        idToken: mask(tokens.idToken),
        refreshToken: mask(tokens.refreshToken),
        accessToken: mask(tokens.accessToken),
        deviceKey: tokens.deviceKey ? "set" : null,
        lastRefresh: tokens.lastRefresh,
      }
    : null;
  const cfgRedacted = redactConfig(cfg); // secretKey はマスク (tokens と同様)。生鍵は `sesame devices`。
  out(opts.json, () => {
    console.log(t("cli.configDir", { dir: paths.dir }));
    console.log(t("cli.configJsonHeader"));
    console.log(cfgRedacted ? JSON.stringify(cfgRedacted, null, 2) : t("cli.notInitialized"));
    console.log(t("cli.tokensJsonHeader"));
    console.log(tokensMasked ? JSON.stringify(tokensMasked, null, 2) : t("cli.notSignedIn"));
  }, { configDir: paths.dir, config: cfgRedacted, tokens: tokensMasked });
}

/**
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdRemoteLs(_opts, program) {
  const { opts, configStore } = loadCtx(program);
  if (!configStore.exists()) die(t("cli.configNotInitialized"), 2);
  const cfg = configStore.load();
  const remotes = cfg.remotes || {};
  const def = cfg.default?.remote;
  out(opts.json, () => {
    const names = Object.keys(remotes);
    if (!names.length) { console.log(t("cli.noRemotes")); return; }
    for (const n of names) {
      const r = remotes[n];
      const mark = n === def ? "*" : " ";
      const keyCount = Object.keys(r.keys || {}).length;
      console.log(`${mark} ${n}\thub3=${r.hub3}\tIR=${r.irDeviceUUID}\tkeys=${keyCount}${r.alias ? `\talias=${r.alias}` : ""}`);
    }
    console.log(t("cli.defaultMarker"));
  }, { default: def, remotes });
}

/**
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdRemoteAdd(_opts, program) {
  // devices の応答だけで完結: Hub3 配下リモコン (uuid+type) を一覧から選ぶ。
  // irType も irDeviceUUID も手打ちさせない。
  await withHub(program, async (hub, { opts }) => {
    await hub.syncHub3sFromDevices(); // hub3 名を確保
    const candidates = await hub.listRemotesFromDevices();
    if (!candidates.length) {
      console.error(t("cli.remotesNotFound"));
      return;
    }
    const chosen = candidates.length === 1
      ? candidates[0]
      : await selectFromList(t("cli.whichRemote"), candidates,
          (r) => `${r.alias || "(no name)"}\thub3=${r.hub3Name}\ttype=${r.type}\t${r.uuid}`);

    // chosen.hub3DeviceUUID に対応する config 上の hub3 名を解決
    const cfg = hub.config;
    const hub3Entry = Object.entries(cfg.hub3s).find(
      ([, h]) => /** @type {string} */ (h.deviceId).replace(/-/g, "").toLowerCase() === chosen.hub3DeviceUUID.replace(/-/g, "").toLowerCase(),
    );
    const hub3Name = hub3Entry ? hub3Entry[0] : null;
    if (!hub3Name) die(t("cli.remoteParentHub3NotFound"), 2);

    const defaultName = (chosen.alias || "remote").replace(/\s+/g, "_").toLowerCase();
    const name = canPrompt(program)
      ? await promptText(t("cli.configName"), { defaultValue: defaultName })
      : defaultName;

    /** @type {ConfigStore} */ (hub.configStore).addRemote(name, {
      hub3: hub3Name,
      irDeviceUUID: chosen.uuid,
      irType: chosen.type,
      irOperation: "learnEmit",
      alias: chosen.alias,
      keys: {},
    });
    const { keyCount } = await hub.syncRemoteKeys(name); // 末尾で自動 sync-keys
    out(opts.json, () => {
      console.log(t("cli.okRemoteAdded", { name, hub3: hub3Name, irType: chosen.type, keyCount }));
    }, { ok: true, name, hub3: hub3Name, irType: chosen.type, keyCount });
  });
}

/**
 * @param {string} name
 * @param {CmdOpts} opts
 * @param {Program} program
 */
async function cmdRemoteSetDefault(name, opts, program) {
  const { configStore } = loadCtx(program);
  configStore.setDefaultRemote(name);
  out(isJsonMode(), () => console.log(t("cli.okDefaultRemote", { name })), { ok: true, defaultRemote: name });
}

/**
 * @param {string|undefined} name
 * @param {CmdOpts} opts
 * @param {Program} program
 */
async function cmdRemoteSyncKeys(name, opts, program) {
  await withHub(program, async (hub) => {
    const { name: resolvedName, keyCount } = await hub.syncRemoteKeys(name ?? null);
    out(isJsonMode(), () => console.log(t("cli.okSyncedKeys", { keyCount, name: resolvedName })),
      { ok: true, remote: resolvedName, keyCount });
  });
}

/**
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdHub3Ls(_opts, program) {
  const { opts, configStore } = loadCtx(program);
  if (!configStore.exists()) die(t("cli.configNotInitialized"), 2);
  const cfg = configStore.load();
  const hub3s = cfg.hub3s || {};
  out(opts.json, () => {
    const names = Object.keys(hub3s);
    if (!names.length) { console.log(t("cli.noHub3")); return; }
    for (const n of names) {
      const h = hub3s[n];
      console.log(`  ${n}\t${h.deviceId}${h.name && h.name !== n ? `\t(${h.name})` : ""}`);
    }
  }, { hub3s });
}

/**
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdHub3Add(_opts, program) {
  // devices から Hub3 を引いて選択式に (UUID 手打ちを排除)。
  await withHub(program, async (hub, { opts }) => {
    const list = await hub.listDevices();
    const hub3Devices = list.filter((d) => d.deviceModel === "hub_3" || d.deviceModel === "hub_3_lte");
    if (!hub3Devices.length) {
      console.error(t("cli.hub3NotFoundInDevices"));
      return;
    }
    const chosen = hub3Devices.length === 1
      ? hub3Devices[0]
      : await selectFromList(t("cli.whichHub3"), hub3Devices,
          (d) => `${d.deviceName || "(no name)"}\t${d.deviceUUID}`);
    const deviceUUID = /** @type {string} */ (chosen.deviceUUID);
    const defaultName = (chosen.deviceName || deviceUUID).replace(/\s+/g, "_").toLowerCase();
    const name = canPrompt(program)
      ? await promptText(t("cli.configName"), { defaultValue: defaultName })
      : defaultName;
    /** @type {ConfigStore} */ (hub.configStore).addHub3(name, { deviceId: deviceUUID, name: chosen.deviceName || name });
    out(opts.json, () => console.log(t("cli.okHub3Added", { name, deviceUUID })),
      { ok: true, name, deviceId: deviceUUID });
  });
}

// ---------- コマンド: lock ----------

/**
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdLockLs(_opts, program) {
  const { opts, configStore } = loadCtx(program);
  if (!configStore.exists()) die(t("cli.configNotInitialized"), 2);
  const cfg = configStore.load();
  const locks = cfg.locks || {};
  const def = cfg.default?.lock;
  out(opts.json, () => {
    const names = Object.keys(locks);
    if (!names.length) { console.log(t("cli.noLocks")); return; }
    for (const n of names) {
      const l = locks[n];
      const mark = n === def ? "*" : " ";
      console.log(`${mark} ${n}\t${l.deviceUUID}\tmodel=${l.model || "?"}${l.alias ? `\t(${l.alias})` : ""}`);
    }
    console.log(t("cli.defaultMarker"));
  }, { default: def, locks });
}

/**
 * `locks add` のオプション袋。フラグ指定で非対話登録できる。
 * @typedef {object} LockAddOpts
 * @property {string} [name]
 * @property {string} [uuid]
 * @property {string} [secret]
 * @property {string} [model]
 * @property {string} [alias]
 * @property {string} [fromUrl]
 */

/**
 * @param {LockAddOpts} opts
 * @param {Program} program
 */
async function cmdLockAdd(opts, program) {
  const { configStore } = loadCtx(program);
  if (!configStore.exists()) die(t("cli.configNotInitialized"), 2);

  // --from-url: 共有 URL (ssm://UI?t=sk&sk=...) を解析し、uuid/secret/model/name を補完する。
  // 共有 URL を生成 (sesame org keys share-url) するだけでなく、受け取った URL/QR から
  // ロックを取り込めるようにする (buildShareKeyUrl の対の操作)。
  // ゲスト共有 (l=2) では sk 位置に guestKeyId が入る点に注意 (parseShareKeyUrl がそのまま返す)。
  /** @type {ReturnType<typeof parseShareKeyUrl>|null} */
  let parsed = null;
  if (opts.fromUrl) {
    try {
      parsed = parseShareKeyUrl(opts.fromUrl);
    } catch (e) {
      die(t("cli.shareUrlParseFailed", { message: /** @type {CliError} */ (e).message }), 2);
      return;
    }
  }

  // フラグ指定があれば非対話で登録 (他言語からの呼び出し/--json 用)。
  // 優先順位: 明示フラグ > --from-url 由来の値 > prompt(TTY) > die(必須)/null(任意)。
  /**
   * @param {keyof LockAddOpts} flag
   * @param {string} label
   * @param {boolean} required
   * @param {string|null} [fallback]
   * @returns {Promise<string|null>}
   */
  const ask = async (flag, label, required, fallback) => {
    if (opts[flag] != null) return /** @type {string} */ (opts[flag]);
    if (fallback != null && fallback !== "") return fallback;
    if (canPrompt(program)) return await promptLine(label);
    if (required) die(t("cli.flagRequiredNonInteractive", { flag }), 2);
    return null;
  };
  const name = await ask("name", t("cli.lockNamePrompt"), true, parsed?.deviceName);
  if (!name) die(t("cli.nameRequired"), 2);
  const deviceUUID = await ask("uuid", t("cli.deviceUuidPrompt"), true, parsed?.deviceUUID);
  if (!deviceUUID) die(t("cli.deviceUuidRequired"), 2);
  const secretKey = await ask("secret", t("cli.secretKeyPrompt"), true, parsed?.secretKey);
  if (!secretKey) die(t("cli.secretKeyRequired"), 2);
  const model = await ask("model", t("cli.modelPrompt"), false, parsed?.deviceModel);
  const alias = await ask("alias", t("cli.aliasPrompt"), false);
  configStore.addLock(name, {
    deviceUUID,
    secretKey,
    model: model || null,
    alias: alias || null,
  });
  out(isJsonMode(), () => console.log(t("cli.okLockAdded", { name })),
    { ok: true, lock: name, deviceUUID, model: model || null, alias: alias || null });
}

/**
 * @param {string} name
 * @param {CmdOpts} opts
 * @param {Program} program
 */
async function cmdLockSetDefault(name, opts, program) {
  const { configStore } = loadCtx(program);
  configStore.setDefaultLock(name);
  out(isJsonMode(), () => console.log(t("cli.okDefaultLock", { name })), { ok: true, defaultLock: name });
}

/**
 * @param {string} name
 * @param {{ yes?: boolean }} options
 * @param {Program} program
 */
async function cmdLockRm(name, options, program) {
  const { configStore } = loadCtx(program);
  // Review M-4: 確認 prompt 追加 (secretKey が消えると復旧は devices 再取得が必要)
  // 2nd-pass M-4: 非対話モードでは prompt 不能なので --yes が無いと拒否
  if (canPrompt(program)) {
    if (!(await confirmPrompt(
      t("cli.confirmLockRm", { name }),
      { defaultYes: false },
    ))) {
      return console.error(t("cli.cancelled"));
    }
  } else if (!options.yes) {
    die(t("cli.nonInteractiveNeedsYes"), 2);
  }
  configStore.removeLock(name);
  out(isJsonMode(), () => console.log(t("cli.okLockRemoved", { name })), { ok: true, removed: name });
}

/**
 * @param {{ prune?: boolean }} options
 * @param {Program} program
 */
async function cmdLockSyncFromDevices(options, program) {
  await withHub(program, async (hub, { opts }) => {
    const r = await hub.syncLocksFromDevices({ prune: !!options.prune });
    printSyncResult(opts.json, "lock", r);
  });
}

/**
 * @param {{ prune?: boolean }} options
 * @param {Program} program
 */
async function cmdHub3SyncFromDevices(options, program) {
  await withHub(program, async (hub, { opts }) => {
    const r = await hub.syncHub3sFromDevices({ prune: !!options.prune });
    printSyncResult(opts.json, "hub3", r);
  });
}

/**
 * @param {CmdOpts} _options
 * @param {Program} program
 */
async function cmdRemoteSyncFromDevices(_options, program) {
  // 引数不要。devices の各 Hub3 stateInfo.remoteList から irType 込みで全リモコン取り込み。
  await withHub(program, async (hub, { opts }) => {
    const { remotes } = await hub.syncRemotesFromDevices();
    // 取り込んだ各 remote のキーも同期
    for (const name of [...remotes.added, ...remotes.updated]) {
      try { await hub.syncRemoteKeys(name); } catch { /* best effort */ }
    }
    printSyncResult(opts.json, "remote", remotes);
  });
}

/**
 * sync 系の結果 (added/updated/removed) を整形出力。
 * @param {boolean} json
 * @param {string} kind
 * @param {{added?:string[], updated?:string[], removed?:string[]}} r
 */
function printSyncResult(json, kind, r) {
  out(json, () => {
    /** @type {string[]} */
    const parts = [];
    if (r.added?.length)   parts.push(`+${r.added.length} (${r.added.join(", ")})`);
    if (r.updated?.length) parts.push(`~${r.updated.length} (${r.updated.join(", ")})`);
    if (r.removed?.length) parts.push(`-${r.removed.length} (${r.removed.join(", ")})`);
    console.log(t("cli.okSync", { kind, parts: parts.join(" / ") || t("cli.syncNoChange") }));
  }, { ok: true, kind, ...r });
}

// ---------- コマンド: IR advanced (Phase C) ----------

/**
 * @param {string|null|undefined} remoteName
 * @param {string|null|undefined} keyName
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdIRLearn(remoteName, keyName, _opts, program) {
  const { configStore } = loadCtx(program);
  if (configStore.exists()) {
    remoteName = await pickRemoteName(program, configStore, remoteName ?? undefined) || remoteName;
  }
  if (!keyName && canPrompt(program)) {
    keyName = await promptText(t("cli.learnKeyName"));
  }
  if (!keyName) die(t("cli.keynameRequired"), 2);
  await withHub(program, async (hub, { opts }) => {
    console.error(t("cli.switchingLearnMode", { remote: remoteName || "default", key: keyName }));
    const result = await hub.learnIR(/** @type {string} */ (remoteName), keyName, {
      onPrompt: () => console.error(t("cli.pointRemote")),
    });
    const saved = /** @type {{keyUUID?: string}|null} */ (result.saved);
    const captured = /** @type {{irData?: string}|null} */ (result.captured);
    out(opts.json, () => {
      console.log(t("cli.okLearned", { key: keyName }));
      if (saved?.keyUUID) console.log(t("cli.keyUuid", { keyUUID: saved.keyUUID }));
      if (captured?.irData) {
        const head = captured.irData.slice(0, 32);
        console.log(t("cli.irData", { head, len: captured.irData.length }));
      }
    }, { ok: true, key: keyName, ...result });
  });
}

/**
 * @param {string|undefined} hub3Name
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdIRModeGet(hub3Name, _opts, program) {
  await withHub(program, async (hub, { opts }) => {
    const mode = await hub.getIRMode(hub3Name);
    out(opts.json, () => console.log(t("cli.mode", { mode: JSON.stringify(mode) })), { mode });
  });
}

/**
 * @param {string} hub3Name
 * @param {string} mode
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdIRModeSet(hub3Name, mode, _opts, program) {
  const m = Number(mode);
  if (![0, 1].includes(m)) die(t("cli.modeMustBe"), 2);
  await withHub(program, async (hub, { opts }) => {
    await hub.setIRMode(hub3Name, m);
    out(opts.json, () => console.log(t("cli.okMode", { mode: m, label: m === 0 ? "CONTROL" : "REGISTER" })), { ok: true, mode: m });
  });
}

/**
 * @param {string|null|undefined} remoteName
 * @param {string|null|undefined} keyName
 * @param {{ yes?: boolean }|undefined} options
 * @param {Program} program
 */
async function cmdIRKeyRm(remoteName, keyName, options, program) {
  const { configStore } = loadCtx(program);
  if (configStore.exists()) {
    remoteName = await pickRemoteName(program, configStore, remoteName ?? undefined) || remoteName;
    keyName = await pickRemoteKeyName(program, configStore, remoteName, keyName ?? undefined) || keyName;
  }
  if (!keyName) die(t("cli.keyRequiredShort"), 2);
  if (canPrompt(program)) {
    if (!(await confirmPrompt(t("cli.confirmKeyRm", { key: keyName }), { defaultYes: false }))) {
      return console.error(t("cli.cancelled"));
    }
  } else if (!options?.yes) {
    die(t("cli.nonInteractiveYesForce"), 2);
  }
  await withHub(program, async (hub, { opts }) => {
    await hub.deleteIRKey(/** @type {string} */ (remoteName), keyName);
    out(opts.json, () => console.log(t("cli.okDeletedKey", { key: keyName, remote: remoteName || "default" })),
      { ok: true });
  });
}

/**
 * @param {string|null|undefined} remoteName
 * @param {string|null|undefined} keyName
 * @param {string|null|undefined} newName
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdIRKeyRename(remoteName, keyName, newName, _opts, program) {
  const { configStore } = loadCtx(program);
  if (configStore.exists()) {
    remoteName = await pickRemoteName(program, configStore, remoteName ?? undefined) || remoteName;
    keyName = await pickRemoteKeyName(program, configStore, remoteName, keyName ?? undefined) || keyName;
  }
  if (!keyName) die(t("cli.keyRequiredShort"), 2);
  if (!newName && canPrompt(program)) newName = await promptText(t("cli.newNamePromptKey", { key: keyName }));
  if (!newName) die(t("cli.newNameRequiredKey"), 2);
  await withHub(program, async (hub, { opts }) => {
    await hub.renameIRKey(/** @type {string} */ (remoteName), keyName, newName);
    out(opts.json, () => console.log(t("cli.okRenamedKey", { key: keyName, newName })), { ok: true });
  });
}

/**
 * @param {string} type
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdIRRemoteListServer(type, _opts, program) {
  /** @type {number} */
  let irt;
  try { irt = parseIrType(type); } catch (e) { die(/** @type {CliError} */ (e).message, 2); }
  await withHub(program, async (hub, { opts }) => {
    const list = /** @type {Array<{alias?:string, name?:string, irDeviceUUID?:string, uuid?:string}>} */ (await hub.listIRRemotes(irt));
    out(opts.json, () => {
      console.log(t("cli.foundRemotes", { count: list.length, type: irt }));
      for (const r of list) {
        console.log(`  ${r.alias || r.name || "(no name)"}\t${r.irDeviceUUID || r.uuid || ""}`);
      }
    }, { count: list.length, remotes: list });
  });
}

/**
 * @param {string} type
 * @param {string|undefined} term
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdIRRemoteSearch(type, term, _opts, program) {
  /** @type {number} */
  let irt;
  try { irt = parseIrType(type); } catch (e) { die(/** @type {CliError} */ (e).message, 2); }
  if (!term) die(t("cli.searchTermRequired"), 2);
  await withHub(program, async (hub, { opts }) => {
    const list = /** @type {Array<{brandName?:string, name?:string, modelName?:string, model?:string, uuid?:string}>} */ (await hub.searchPresetIRRemotes(irt, term));
    out(opts.json, () => {
      console.log(t("cli.foundPresetRemotes", { count: list.length }));
      for (const r of list) {
        console.log(`  ${r.brandName || r.name || "?"}\t${r.modelName || r.model || ""}\t${r.uuid || ""}`);
      }
    }, { count: list.length, results: list });
  });
}

/**
 * @param {string} type
 * @param {string|undefined} irData
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdIRRemoteMatch(type, irData, _opts, program) {
  /** @type {number} */
  let irt;
  try { irt = parseIrType(type); } catch (e) { die(/** @type {CliError} */ (e).message, 2); }
  if (!irData) die(t("cli.irDataRequired"), 2);
  await withHub(program, async (hub, { opts }) => {
    const matches = /** @type {unknown[]} */ (await hub.matchIRRemote({ irData, irType: irt }));
    out(opts.json, () => {
      console.log(t("cli.foundMatchingRemotes", { count: matches.length }));
      for (const m of matches) console.log(`  ${JSON.stringify(m)}`);
    }, { count: matches.length, matches });
  });
}

/**
 * @param {string|undefined} name
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdIRRemoteRmServer(name, _opts, program) {
  await withHub(program, async (hub, { opts }) => {
    await hub.deleteIRRemoteServer(name);
    out(opts.json, () => console.log(t("cli.okDeletedServerRemote", { name: name || "default" })),
      { ok: true });
  });
}

/**
 * @param {string|undefined} name
 * @param {string|undefined} alias
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdIRRemoteRenameServer(name, alias, _opts, program) {
  if (!alias) die(t("cli.aliasRequired"), 2);
  await withHub(program, async (hub, { opts }) => {
    await hub.renameIRRemote(/** @type {string} */ (name), alias);
    out(opts.json, () => console.log(t("cli.okRenamedRemote", { name: name || "default", alias })),
      { ok: true });
  });
}

// ---------- コマンド: device management (Phase D) ----------

/**
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdDeviceUserLs(_opts, program) {
  await withHub(program, async (hub, { opts }) => {
    const list = /** @type {DeviceInfo[]} */ (await hub.listUserDevices());
    out(opts.json, () => {
      console.log(t("cli.foundUserDevices", { count: list.length }));
      for (const d of list) {
        console.log(`  ${d.deviceName || "(no name)"}\t${d.deviceModel || "?"}\t${d.deviceUUID || ""}`);
      }
    }, { count: list.length, devices: list });
  });
}

/**
 * @param {string|undefined} uuid
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdDeviceStatus(uuid, _opts, program) {
  await withHub(program, async (hub, { opts }) => {
    uuid = await pickDeviceUUID(program, hub, uuid, { message: t("cli.whichDeviceStatus") }) || uuid;
    if (!uuid) die(t("cli.deviceUuidRequired"), 2);
    const status = await hub.getDeviceStatus(uuid);
    const safe = sanitizeStatus(status); // status に secretKey は不要 — 端末/JSON に鍵を出さない
    out(opts.json, () => console.log(fmtCloudStatus(status)), { status: safe });
  });
}

/**
 * @param {string|undefined} uuid
 * @param {string|null|undefined} newName
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdDeviceRename(uuid, newName, _opts, program) {
  await withHub(program, async (hub, { opts }) => {
    uuid = await pickDeviceUUID(program, hub, uuid, { message: t("cli.whichDeviceRename") }) || uuid;
    if (!uuid) die(t("cli.deviceUuidRequired"), 2);
    if (!newName && canPrompt(program)) newName = await promptText(t("cli.newDeviceName"));
    if (!newName) die(t("cli.newNameRequiredDevice"), 2);
    await hub.renameDevice(uuid, newName);
    out(opts.json, () => console.log(t("cli.okRenamedDevice", { uuid: /** @type {string} */ (uuid), newName: /** @type {string} */ (newName) })), { ok: true });
  });
}

/**
 * @param {string|undefined} uuid
 * @param {{ yes?: boolean }} options
 * @param {Program} program
 */
async function cmdDeviceRm(uuid, options, program) {
  await withHub(program, async (hub, { opts }) => {
    uuid = await pickDeviceUUID(program, hub, uuid, { message: t("cli.whichDeviceRm") }) || uuid;
    if (!uuid) die(t("cli.deviceUuidRequired"), 2);
    if (canPrompt(program)) {
      if (!(await confirmPrompt(t("cli.confirmDeviceRm", { uuid }), { defaultYes: false }))) {
        return console.error(t("cli.cancelled"));
      }
    } else if (!options.yes) {
      die(t("cli.nonInteractiveNeedsYes"), 2);
    }
    await hub.deleteDevice(uuid);
    out(opts.json, () => console.log(t("cli.okDeletedDevice", { uuid: /** @type {string} */ (uuid) })), { ok: true });
  });
}

/**
 * @param {string|undefined} deviceUUID
 * @param {{ delete?: string, pageSize?: string }} options
 * @param {Program} program
 */
async function cmdHistory(deviceUUID, options, program) {
  await withHub(program, async (hub, { opts }) => {
    // 履歴は単機取得。cloud の getHistory は空 list を「全デバイス」と解釈せず無応答=タイムアウト
    // するため、battery と同じく未指定なら 1 台なら auto-pick / 複数 + 非対話は UUID 要求 /
    // 複数 + 対話は選択、にフォールバックする (空 list を投げて固まる経路を断つ)。
    deviceUUID = await pickDeviceUUID(program, hub, deviceUUID, { message: t("cli.whichDeviceHistory") }) || deviceUUID;
    if (!deviceUUID) die(t("cli.deviceUuidRequired"), 2);
    // --delete <timestamp>: 履歴 1 エントリを非表示化 (論理削除)。timestamp は各 record の値。
    if (options.delete != null) {
      const timestamp = Number(options.delete);
      if (!Number.isFinite(timestamp)) { die(t("cli.historyTimestampInvalid", { value: options.delete }), 2); return; }
      await hub.hideDeviceHistory({ deviceUUID, timestamp });
      out(opts.json, () => console.log(t("cli.historyDeleted", { timestamp })), { ok: true, deviceUUID, timestamp, hidden: true });
      return;
    }
    const pageSize = options.pageSize ? Number(options.pageSize) : null;
    const data = await hub.getDeviceHistory([{ deviceUUID }], /** @type {number} */ (pageSize));
    out(opts.json, () => console.log(JSON.stringify(data, null, 2)), { data });
  });
}

/**
 * @param {string|undefined} deviceUUID
 * @param {{ delete?: string, pageSize?: string }} options
 * @param {Program} program
 */
async function cmdBattery(deviceUUID, options, program) {
  await withHub(program, async (hub, { opts }) => {
    deviceUUID = await pickDeviceUUID(program, hub, deviceUUID, {
      message: t("cli.whichDeviceBattery"),
      filter: (d) => /^(sesame_|wm_|ssmbot_|bot_|bike_)/.test(d.deviceModel || ""),
    }) || deviceUUID;
    if (!deviceUUID) die(t("cli.deviceUuidRequired"), 2);
    // --delete <ts>: 電池履歴 1 エントリを非表示化 (論理削除)。ts は record.ts (秒)。
    if (options.delete != null) {
      const timestampSecond = Number(options.delete);
      if (!Number.isFinite(timestampSecond)) { die(t("cli.batteryTimestampInvalid", { value: options.delete }), 2); return; }
      await hub.hideBatteryRecord({ deviceUUID, timestampSecond });
      out(opts.json, () => console.log(t("cli.batteryDeleted", { timestampSecond })), { ok: true, deviceUUID, timestampSecond, hidden: true });
      return;
    }
    const pageSize = options.pageSize ? Number(options.pageSize) : 100;
    const data = /** @type {{ records?: Array<{ts?:number, light?:number, heavy?:number, lightPercentage?:number, heavyPercentage?:number}>, lastEvaluatedKey?: unknown }} */ (await hub.getDeviceBattery(deviceUUID, { pageSize }));
    out(opts.json, () => {
      const recs = data.records || [];
      console.log(t("cli.batteryRecords", { count: recs.length }));
      for (const r of recs) {
        const ts = r.ts ? new Date(r.ts * 1000).toISOString() : "?";
        console.log(`  ${ts}\tlight=${r.light}\theavy=${r.heavy}\tlight%=${r.lightPercentage}\theavy%=${r.heavyPercentage}`);
      }
      if (data.lastEvaluatedKey) console.log(t("cli.nextPageKey", { key: JSON.stringify(data.lastEvaluatedKey) }));
    }, data);
  });
}

/**
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdFirmware(_opts, program) {
  await withHub(program, async (hub, { opts }) => {
    const list = await hub.listFirmware();
    out(opts.json, () => console.log(JSON.stringify(list, null, 2)), { firmwares: list });
  });
}

/**
 * @param {string|undefined} func
 * @param {{ query?: string, body?: string, apiKey?: string }} options
 * @param {Program} program
 */
async function cmdWebapi(func, options, program) {
  if (!func) die(t("cli.funcRequired"), 2);
  /** @type {Record<string, any>} */
  let query = {};
  /** @type {Record<string, any>} */
  let body = {};
  try {
    if (options.query) query = JSON.parse(options.query);
    if (options.body)  body  = JSON.parse(options.body);
  } catch (e) {
    die(t("cli.invalidJsonQueryBody", { message: /** @type {CliError} */ (e).message }), 2);
  }
  await withHub(program, async (hub, { opts }) => {
    const data = await hub.invokeWebAPI({ func, query, body, apiKeyId: options.apiKey });
    out(opts.json, () => console.log(JSON.stringify(data, null, 2)), { data });
  });
}

// ---------- 既存の lock op ----------

// ---------- 統合ロック操作 (トップレベル動詞 unlock/lock/toggle/status/autolock/bot) ----------

/**
 * config からロック entry を解決する。
 * 優先: 位置引数/--name → default.lock → 単一なら自動 → 部分一致 → 対話選択。
 * @returns {{name:string, deviceUUID:string, secretKey:string}|null} die 済みなら null
 */
/**
 * 先頭トークンが「登録済みデバイス名」を指しているか (op へ回してよいか) を非破壊で判定する。
 * resolveLockEntry の名前解決 (完全一致 + 大文字小文字無視の部分一致) を踏襲しつつ、
 * lock 派生 view に限らず devices/hub3s の全デバイスキーを対象にする。
 * config 不在/破損時は false (= 未知コマンド扱いに委ねる)。例外は飲み込む (ルーティングを壊さない)。
 * @param {Program} program
 * @param {string|undefined} name
 * @returns {boolean}
 */
function isKnownDevice(program, name) {
  if (!name) return false;
  try {
    const { configStore } = loadCtx(program);
    if (!configStore.exists()) return false;
    const cfg = configStore.load();
    const names = Object.keys(cfg.devices || {});
    if (names.length === 0) return false;
    if (names.includes(name)) return true; // 完全一致
    const lower = String(name).toLowerCase();
    // 部分一致が一意に定まるときのみデバイスとみなす (resolveLockEntry と同じ曖昧さ規則)。
    return names.filter((n) => n.toLowerCase().includes(lower)).length >= 1;
  } catch {
    return false;
  }
}

/**
 * config からロック entry を解決する。
 * @param {Program} program
 * @param {string|null|undefined} name
 * @returns {Promise<LockEntry|null>} die 済みなら null
 */
async function resolveLockEntry(program, name) {
  const { configStore } = loadCtx(program);
  if (!configStore.exists()) { die(t("cli.noConfigInitSync"), 2); return null; }
  const cfg = configStore.load();
  const locks = cfg.locks || {};
  const names = Object.keys(locks);
  if (names.length === 0) { die(t("cli.locksNotRegisteredSync"), 2); return null; }

  /** @type {string|null} */
  let chosen = null;
  if (name) {
    if (locks[name]) chosen = name; // 完全一致
    else {
      // 部分一致 (大文字小文字無視)
      const matches = names.filter((n) => n.toLowerCase().includes(String(name).toLowerCase()));
      if (matches.length === 1) chosen = matches[0];
      else if (matches.length > 1) { die(t("cli.multipleMatch", { name, matches: matches.join(", ") }), 2); return null; }
      else { die(t("cli.lockNotFound", { name, names: names.join(", ") }), 2); return null; }
    }
  } else {
    chosen = cfg.default?.lock || (names.length === 1 ? names[0] : null);
    if (!chosen) {
      if (!canPrompt(program)) { die(t("cli.multipleLocksSpecify", { names: names.join(", ") }), 2); return null; }
      chosen = await selectFromList(t("cli.whichLock"), names, (n) => `${n}\t${locks[n].deviceUUID}`);
      if (!chosen) { console.error(t("cli.cancelledDot")); return null; }
    }
  }
  const lock = locks[chosen];
  if (!lock?.deviceUUID || !lock?.secretKey) { die(t("cli.lockMissingKeys", { name: chosen }), 2); return null; }
  return { name: chosen, deviceUUID: lock.deviceUUID, secretKey: lock.secretKey, model: lock.model || null };
}

/**
 * 単発コマンドの経路を決定する。
 *   - 既定 (オート): 能力フル。経路はツールが自動選択する。BLE はスキャン/接続のオーバーヘッドが
 *     あるため毎回は張らず、cloud で運べる op は cloud、cloud で運べない op (autolock など BLE 必須)
 *     のみ BLE で一時接続する (cloud が速いという意味ではなく、BLE の接続コストを毎回払わないため)。
 *   - `--ble-only` / `--cloud-only`: 経路を固定したいときの明示指定 (最優先)。
 * 「BLE 接続を保持する」モードは `sesame session`。運べる経路はデバイス型×op の能力から導出する。
 * @param {string} op
 * @param {{ cloudOnly?: boolean, bleOnly?: boolean }} options
 * @param {string|null|undefined} model
 * @returns {"cloud"|"ble"}
 */
function pickTransport(op, options, model) {
  if (options.cloudOnly && options.bleOnly) { die(t("cli.cloudBleExclusive"), 2); }
  // status は制御 op ではなく mech 状態の読み取り。capability リスト (制御 op のみ) には載らないが、
  // 実行層は BLE (ble.status) でも cloud (getDeviceStatus) でも取得できる。mech を持つ型
  // (mechKind != null = lock/bot) なら対応、hub/biometric/wifi は mech が無いので非対応。
  // auto/--cloud-only は cloud を既定 (BLE 接続コスト回避)、--ble-only は BLE。
  if (op === "status") {
    if (!capabilitiesForModel(model).mechKind) { die(t("cli.noTransportForOp", { op }), 2); }
    return options.bleOnly ? "ble" : "cloud";
  }
  const allowed = transportsForOp(model, op);
  if (allowed.length === 0) { die(t("cli.noTransportForOp", { op }), 2); }
  if (options.bleOnly) {
    if (!allowed.includes("ble")) { die(t("cli.opNotOverBle", { op }), 2); }
    return "ble";
  }
  if (options.cloudOnly) {
    if (!allowed.includes("cloud")) { die(t("cli.opNotOverCloud", { op }), 2); }
    return "cloud";
  }
  // オート: cloud で運べるなら cloud (BLE の接続コストを避けるため)。cloud 不可な op (autolock) のみ BLE。
  return allowed.includes("cloud") ? "cloud" : "ble";
}

/**
 * auto フォールバック先の cloud が使えるか (token があるか)。
 * @param {Program} program
 * @returns {boolean}
 */
function hasCloudSession(program) {
  const { tokenStore } = loadCtx(program);
  const t = tokenStore.load();
  return !!(t && (t.refreshToken || t.idToken));
}

/**
 * BLE の mechStatus (ble.status() の戻り)。
 * @typedef {{ state?: string, position?: number|null, isBatteryCritical?: boolean, isStop?: boolean, isCritical?: boolean }} MechStatus
 */

/**
 * mechStatus を 1 行に整形。
 * @param {MechStatus|null|undefined} s
 * @returns {string}
 */
function fmtMech(s) {
  if (!s) return t("cli.statusNotFetched");
  const warn = [s.isBatteryCritical && t("cli.batteryLow"), s.isStop && t("cli.stop"), s.isCritical && t("cli.abnormal")].filter(Boolean).join(" ");
  // position はロック (Sesame5/6) のみ。Bot/Bike は概念がないので state だけ表示する。
  const pos = s.position == null ? "" : ` pos=${s.position}`;
  return `state=${s.state}${pos}${warn ? " " + warn : ""}`;
}

/**
 * cloud の device-status (stateInfo) を fmtMech と揃えた 1 行に整形。
 * @param {{ stateInfo?: { position?: number|null, batteryPercentage?: number|null, CHSesame2Status?: string } }|null|undefined} st
 * @returns {string}
 */
function fmtCloudStatus(st) {
  if (!st || !st.stateInfo) return t("cli.statusNotFetched");
  const si = st.stateInfo;
  const pos = si.position == null ? "" : ` pos=${si.position}`;
  const batt = si.batteryPercentage == null ? "" : ` battery=${si.batteryPercentage}%`;
  return `state=${si.CHSesame2Status ?? "?"}${pos}${batt}`;
}

/**
 * status 出力から秘匿値 (secretKey) を落とす。status は状態読み取りで鍵は不要。
 * @param {unknown} st
 * @returns {unknown}
 */
function sanitizeStatus(st) {
  if (!st || typeof st !== "object") return st;
  const { secretKey, ...safe } = /** @type {Record<string, unknown>} */ (st); // eslint-disable-line no-unused-vars
  return safe;
}

/**
 * config の全ロック entry (deviceUUID/secretKey が揃っているもの) を返す。
 * @param {Program} program
 * @returns {LockEntry[]}
 */
function allLockEntries(program) {
  const { configStore } = loadCtx(program);
  if (!configStore.exists()) { die(t("cli.noConfigInitSync"), 2); return []; }
  const locks = configStore.load().locks || {};
  return Object.entries(locks)
    .filter(([, l]) => l?.deviceUUID && l?.secretKey)
    .map(([name, l]) => ({ name, deviceUUID: /** @type {string} */ (l.deviceUUID), secretKey: /** @type {string} */ (l.secretKey), model: l.model || null }));
}

/**
 * config の全 Hub3 entry を返す ({name, deviceId, model, secretKey})。
 * secretKey/model は devices レコード丸ごと保存により config に揃っているので、ここで返す
 * (relay/LED は secretKey 必須。旧実装の「session 開始時に listDevices で再取得」する band-aid は廃止)。
 */
/**
 * @param {Program} program
 * @returns {Hub3Entry[]}
 */
function allHub3Entries(program) {
  const { configStore } = loadCtx(program);
  if (!configStore.exists()) return [];
  const hub3s = configStore.load().hub3s || {};
  return Object.entries(hub3s)
    .filter(([, h]) => h?.deviceId)
    .map(([name, h]) => ({ name, deviceId: h.deviceId, model: h.model || "hub_3", secretKey: h.secretKey || null }));
}

/**
 * 指定 Hub3 名に属する remote の一覧 ({name, label}) を返す (IR 送信のリモコン選択用)。
 * @param {Program} program
 * @param {string} hub3Name
 * @returns {Array<{name:string, label:string}>}
 */
function remotesForHub3(program, hub3Name) {
  const { configStore } = loadCtx(program);
  if (!configStore.exists()) return [];
  const remotes = configStore.load().remotes || {};
  return Object.entries(remotes)
    .filter(([, r]) => r?.hub3 === hub3Name)
    .map(([name, r]) => ({ name, label: r.alias ? `${name} (${r.alias})` : name }));
}

/**
/**
 * 統合ハンドラ。op: unlock|lock|toggle|status|autolock|bot。
 * @param {string} op
 * @param {string|undefined} name 位置引数のロック名
 * @param {string|null} seconds autolock 用
 * @param {object} options commander options (--ble-only/--cloud-only/--name)
 * @param {object} program
 */
/** BLE 経由で 1 操作を実行。scanTimeoutMs を指定すると圏外時に早めに失敗 (auto の高速フォールバック用)。 */
/** 接続済みの SesameBle に対して 1 操作を実行 (接続/切断は呼び出し側責務)。 */
/**
 * 接続済み SesameBle に op を実行する**唯一のコア**。単発コマンド・セッションの両方がここを通る
 * (session は保持中の接続を、単発は都度張った接続を渡す。「保持接続があればそれで操作する」という
 * セッションモードの挙動が、両方の既定動作になる)。能力ゲートは SesameBle 側が担保。表示はしない。
 * @param {string} op
 * @param {SesameBle} ble
 * @param {string|number|null|undefined} seconds
 * @returns {Promise<{result:any, status:MechStatus|null}>}
 */
async function bleExec(op, ble, seconds) {
  /** @type {any} */
  let result = null;
  const bleAny = /** @type {Record<string, () => Promise<any>>} */ (/** @type {unknown} */ (ble));
  if (op === "autolock") result = await ble.autolock(Number(seconds));
  else if (op !== "status") result = await bleAny[op](); // lock/unlock/toggle/click (履歴タグ無し = SDK null-tag [00 0E])
  const status = /** @type {MechStatus|null} */ (await ble.status().catch(() => null));
  return { result, status };
}

/**
 * 接続済みの SesameBle に対して 1 操作を実行し、単発コマンド向けに表示する (接続/切断は呼び出し側責務)。
 * @param {string} op
 * @param {SesameBle} lock
 * @param {LockEntry} entry
 * @param {string|number|null|undefined} seconds
 * @param {GlobalOpts} gopts
 */
async function runBleOnLock(op, lock, entry, seconds, gopts) {
  const { result, status } = await bleExec(op, lock, seconds);
  out(gopts.json, () => {
    if (op === "status") { console.log(`${entry.name}: ${fmtMech(status)}`); return; }
    console.log(t("cli.okOp", { op, extra: op === "autolock" ? ` ${Number(seconds) === 0 ? t("cli.autolockDisabled") : t("cli.autolockSeconds", { seconds: Number(seconds) })}` : "", name: entry.name }));
    if (status) console.log(`   ${fmtMech(status)}`);
  }, { ok: true, op, name: entry.name, via: "ble", result, status });
}

/**
 * BLE で 1 操作 (connect→op→close)。--ble-only 明示 or BLE 必須 op (autolock) 用。
 * @param {string} op
 * @param {LockEntry} entry
 * @param {string|number|null|undefined} seconds
 * @param {GlobalOpts} gopts
 * @param {{ scanTimeoutMs?: number }} [bleOpts]
 */
async function runBleOp(op, entry, seconds, gopts, { scanTimeoutMs } = {}) {
  await SesameBle.use(
    { secretKey: entry.secretKey, deviceUUID: entry.deviceUUID, model: entry.model ?? undefined, debug: !!gopts.debug, scanTimeoutMs },
    (lock) => runBleOnLock(op, lock, entry, seconds, gopts),
  );
}

/**
 * クラウド経由で 1 操作を実行。
 * @param {string} op
 * @param {LockEntry} entry
 * @param {Program} program
 */
async function runCloudOp(op, entry, program) {
  await withHub(program, async (hub, { opts }) => {
    if (op === "status") {
      const st = await hub.getDeviceStatus(entry.deviceUUID);
      const safe = sanitizeStatus(st);
      out(opts.json, () => console.log(`${entry.name}: ${fmtCloudStatus(st)}`), { ok: true, op, name: entry.name, via: "cloud", status: safe });
      return;
    }
    // click (Bot の BLE クリック) は cloud では botClick(cmd=89) に対応。
    const hubAny = /** @type {Record<string, (name: string) => Promise<any>>} */ (/** @type {unknown} */ (hub));
    const resp = /** @type {{ data?: Record<string, unknown> }} */ ((op === "bot" || op === "click") ? await hub.botClick(entry.name) : await hubAny[op](entry.name)); // lock/unlock/toggle
    out(opts.json, () => {
      console.log(`OK: ${op} (${entry.name})`);
      if (resp?.data && Object.keys(resp.data).length) console.log(`   ${JSON.stringify(resp.data)}`);
    }, { ok: true, op, name: entry.name, via: "cloud", response: resp });
  });
}

// セッション UI で使う操作ラベル (ロック系 + Hub3 系)。
// ロケールは run() 内で setLocale() してから確定するため、モジュール評価時に固定せず
// 呼び出し時に t() を引く (lazy)。
function sessionLabel() {
  return {
    unlock: t("cli.sessLabelUnlock"), lock: t("cli.sessLabelLock"), toggle: t("cli.sessLabelToggle"), click: t("cli.sessLabelClick"), status: t("cli.sessLabelStatus"), autolock: t("cli.sessLabelAutolock"),
    ir: t("cli.sessLabelIr"), "relay-on": t("cli.sessLabelRelayOn"), "relay-off": t("cli.sessLabelRelayOff"), led: t("cli.sessLabelLed"),
  };
}

/**
 * セッション対象 1 デバイスの entry (ロック / Hub3 を統合した緩い形)。
 * @typedef {object} SessionEntry
 * @property {string} name
 * @property {string} [deviceUUID] ロック (BLE)
 * @property {string} [secretKey]
 * @property {string} [deviceId] Hub3 (cloud relay/LED)
 * @property {string|null} [model]
 * @property {string} [kind]
 */

/**
 * セッション中の 1 デバイス。ble は接続できたら SesameBle、未接続は null。
 * lastStatus は SesameBle 側のキャッシュ済み mechStatus。
 * @typedef {{ kind: string, entry: SessionEntry, ble: (import("./ble/index.js").SesameBle & { lastStatus?: MechStatus|null })|null }} SessionDevice
 */

/* exported for tests */
/**
 * デバイス型 × 利用可能な経路の **和集合** で操作一覧を作る。
 * その op を運べる経路が今使えるときだけ出す: BLE 接続中なら ble 能力、ログイン済みなら cloud 能力。
 * (例: ロックは BLE 接続中のみ autolock を出す。OS2 ロックは cloud の lock/unlock/toggle のみ。)
 * @param {SessionDevice} d
 * @param {boolean} hasCloud クラウド経路が使えるか
 * @returns {Array<{label:string, value:string}>}
 */
function sessionActionsFor(d, hasCloud) {
  const caps = capabilitiesForModel(d.entry.model);
  // 今使える経路で運べる op の集合。
  /** @type {Set<string>} */
  const avail = new Set();
  if (d.ble) for (const o of caps.ble) avail.add(o);
  if (hasCloud) for (const o of caps.cloud) avail.add(o);

  // 提示順: lock5 は現在状態から自然な順、それ以外は能力順。
  /** @type {string[]} */
  let ordered;
  if (caps.kind === "lock5") {
    const primary = d.ble?.lastStatus?.state === "locked" ? "unlock" : "lock";
    ordered = [primary, ...["unlock", "lock", "toggle", "autolock"].filter((o) => o !== primary)];
  } else {
    ordered = caps.ops; // bot2:[click] / bike2:[unlock] / hub3:[ir,relay,led] / os2lock:[lock,unlock,toggle] 等
  }

  const LABEL = sessionLabel();
  /** @type {Array<{label:string, value:string}>} */
  const acts = [];
  for (const o of ordered.filter((o) => avail.has(o))) {
    if (o === "relay") { // Hub3 のリレーは ON/OFF の 2 項目に展開。
      acts.push({ label: LABEL["relay-on"], value: "relay-on" }, { label: LABEL["relay-off"], value: "relay-off" });
    } else {
      acts.push({ label: /** @type {Record<string, string>} */ (LABEL)[o], value: o });
    }
  }
  if (caps.mechKind && d.ble) acts.push({ label: LABEL.status, value: "status" }); // mech がある型は BLE 接続中のみ状態取得
  return acts;
}

/**
 * ヘッダの状態表示。BLE 接続済みは実 mechStatus、Hub3/未接続は注記 (クラウド状態は形が不定で正規化しない)。
 * @param {SessionDevice} d
 * @returns {string}
 */
function sessionFmtState(d) {
  if (d.kind === "hub3") return t("cli.sessHub3State");
  return d.ble ? fmtMech(d.ble.lastStatus) : t("cli.sessBleNotConnected");
}

/**
 * 1 操作を実行し結果メッセージを返す。
 *   ロック: BLE 接続済みなら BLE、無ければクラウド (autolock は BLE 必須)。
 *   Hub3 : IR 送信 (extra={remote,key}) / リレー ON/OFF / LED (extra=duty)。いずれもクラウド。
 * @param {SesameHub3|null} hub クラウドクライアント (未ログイン時 null)
 * @returns {(op: string, d: SessionDevice, extra: any) => Promise<string>}
 */
function makeSessionExec(hub) {
  return async (op, d, extra) => {
    if (d.kind === "hub3") {
      if (!hub) return t("cli.sessHub3NeedLogin");
      if (op === "ir") { await hub.send(extra.remote, extra.key); return t("cli.sessIrSent", { remote: extra.remote, key: extra.key, name: d.entry.name }); }
      if (op === "relay-on" || op === "relay-off") {
        if (!d.entry.secretKey) return t("cli.sessNoSecretKey");
        await hub.iot.hub3RelaySwitch({ deviceId: d.entry.deviceId, secretKey: d.entry.secretKey, op: op === "relay-on" ? 0x01 : 0x00 });
        return t("cli.sessRelayResult", { state: op === "relay-on" ? "ON" : "OFF", name: d.entry.name });
      }
      if (op === "led") {
        if (!d.entry.secretKey) return t("cli.sessNoSecretKey");
        const r = /** @type {{ ledDuty?: number }} */ (await hub.iot.setHub3LedDuty({ deviceId: d.entry.deviceId, secretKey: d.entry.secretKey, op: 0x01, duty: Number(extra) }));
        return t("cli.sessLedResult", { duty: Number(extra), name: d.entry.name, extra: r?.ledDuty != null ? ` → ${r.ledDuty}` : "" });
      }
      return t("cli.sessUnsupportedOp", { op });
    }
    // ロック系
    const sessLabel = /** @type {Record<string, string>} */ (sessionLabel());
    if (d.ble) {
      const { status } = await bleExec(op, d.ble, extra);
      return op === "status" ? `${d.entry.name}: ${fmtMech(status)}` : `OK: ${sessLabel[op]} (${d.entry.name})`;
    }
    if (op === "autolock") return t("cli.sessAutolockBleOnly");
    if (op === "status") return t("cli.sessStatusCloud", { name: d.entry.name });
    if (!hub) return t("cli.sessNeedBleOrLogin");
    const hubAny = /** @type {Record<string, (name: string) => Promise<any>>} */ (/** @type {unknown} */ (hub));
    if (op === "click") await hub.botClick(d.entry.name);
    else await hubAny[op](d.entry.name); // lock/unlock/toggle
    return t("cli.sessCloudResult", { label: sessLabel[op], name: d.entry.name });
  };
}

/**
 * 対象ロックへ BLE 接続を張ったまま保持し、runSessionMenu でメニュー操作させる。
 * 接続を維持するので 1 操作ごとの再スキャン/再接続が起きない。
 *
 * @param {string[]} names 対象ロック名 (部分一致可)。空なら config の全ロック。
 * @param {{ bleOnly?: boolean, cloudOnly?: boolean }} options
 * @param {Program} program
 */
async function cmdSession(names, options, program) {
  const gopts = /** @type {GlobalOpts} */ (program.opts());
  if (gopts.json) { die(t("cli.sessionJsonOnly"), 2); return; }
  if (!isInteractive()) { die(t("cli.sessionTtyOnly"), 2); return; }

  const loggedIn = hasCloudSession(program);

  // 操作できるデバイス全部を対象にする: ロック/Bot/Bike (BLE+cloud) と、ログイン済みなら Hub3 (cloud)。
  // model/secretKey は config の devices レコードに揃っているので entry がそのまま能力解決に使える。
  const locks = allLockEntries(program).map((e) => ({ ...e, kind: "lock" }));
  const hub3s = loggedIn ? allHub3Entries(program).map((e) => ({ ...e, kind: "hub3" })) : [];
  const allDevs = /** @type {SessionEntry[]} */ (/** @type {unknown} */ ([...locks, ...hub3s]));
  if (allDevs.length === 0) { die(t("cli.noOperableDevices"), 2); return; }

  // 対象を決定: 名前指定があれば部分一致で絞る、無ければ全デバイス。
  /** @type {SessionEntry[]} */
  let targets;
  if (Array.isArray(names) && names.length > 0) {
    targets = [];
    for (const n of names) {
      const matches = allDevs.filter((e) => e.name.toLowerCase().includes(String(n).toLowerCase()));
      if (matches.length === 0) { die(t("cli.deviceNotFoundCandidates", { name: n, names: allDevs.map((e) => e.name).join(", ") }), 2); return; }
      for (const m of matches) if (!targets.some((t) => t.name === m.name)) targets.push(m);
    }
  } else {
    targets = allDevs;
  }

  const lockTargets = targets.filter((t) => t.kind === "lock");

  /** @type {Map<string, SessionDevice>} */
  const devices = new Map();
  for (const t of targets) devices.set(t.name, { kind: /** @type {string} */ (t.kind), entry: t, ble: null });

  // UI のライブ再描画トリガ。BLE の mechStatus publish / 背景接続の完了で "update" を流す。
  const bus = new EventEmitter();
  bus.setMaxListeners(0);

  // BLE を張って devices[].ble に反映する (ロックのみ・best-effort・非致命)。繋がった台数を返す。
  const connectBle = async () => {
    if (lockTargets.length === 0) return 0;
    try {
      const result = await SesameBle.connectMany(/** @type {Array<{name:string, deviceUUID:string, secretKey:string, model?:string}>} */ (/** @type {unknown} */ (lockTargets)), { debug: !!gopts.debug, scanTimeoutMs: 8_000 });
      for (const [name, ble] of result.connected) {
        const d = devices.get(name);
        if (d) { d.ble = ble; ble.onStatus(() => bus.emit("update")); } // 以降 BLE 優先・状態変化で再描画
      }
      bus.emit("update"); // 接続が増えたら ·BLE に昇格させるため再描画
      return result.connected.size;
    } catch (e) {
      if (gopts.debug) console.error(t("cli.bleConnectFailedDebug", { message: /** @type {CliError} */ (e)?.message || String(e) }));
      return 0;
    }
  };

  let blePromise = null;
  if (loggedIn) {
    // オートのアプリ的挙動: クラウドでメニューを即表示し、BLE は **バックグラウンド** で接続する
    // (繋がったデバイスは次の描画で ·BLE に昇格し、以降 BLE 優先)。起動を BLE スキャンで待たせない。
    if (lockTargets.length) console.error(t("cli.bleBackgroundConnecting"));
    blePromise = connectBle();
  } else {
    // 未ログイン: クラウドの下支えが無いので BLE を待つしかない。0 なら die。
    console.error(t("cli.bleScanning", { names: lockTargets.map((lt) => lt.name).join(", ") }));
    if ((await connectBle()) === 0) {
      die(t("cli.bleNoneAndNotLoggedIn"), 1);
      return;
    }
  }

  const { runSessionUI } = await import("./session-ui.js"); // ink/react を遅延ロード
  /** @param {SesameHub3|null} hub */
  const runner = async (hub) => {
    // Hub3 の relay/LED 用 secretKey は config の devices レコードに保存済み (sync 時に取り込み)。
    // 旧実装の「session 開始時に listDevices で再取得」する band-aid は不要 (entry.secretKey をそのまま使う。
    // 欠落していれば relay/LED の exec が `sesame devices で再取得` を案内する)。
    // runSessionUI の宣言型に hub3RemotesFor/listKeysFor が無い (session-ui.js 側の型ギャップ)
    // ため props を一旦変数で組んでから渡す (excess-property check 回避)。
    const props = {
      devices,
      hasCloud: !!hub,
      bus,
      exec: makeSessionExec(hub),
      /** @param {SessionDevice} d */
      actionsFor: (d) => sessionActionsFor(d, !!hub),
      fmtState: sessionFmtState,
      /** @param {SessionDevice} d */
      hub3RemotesFor: (d) => remotesForHub3(program, d.entry.name).map((r) => ({ label: r.label, value: r.name })),
      /** @param {string|null} remoteName */
      listKeysFor: async (remoteName) => (await /** @type {SesameHub3} */ (hub).listKeys(remoteName)).map((k) => ({ label: k.name, value: k.name })),
    };
    try {
      // session-ui.js の props 宣言型は devices/コールバックを `object` で受ける (SessionDevice より広い)。
      // 反変のため SessionDevice 版コールバックは構造的に弾かれる。実行時は同形なので Parameters で適合させる。
      await runSessionUI(/** @type {Parameters<typeof runSessionUI>[0]} */ (/** @type {unknown} */ (props)));
    } finally {
      if (blePromise) await blePromise.catch(() => {}); // 背景接続の完了を待ってから閉じる
      for (const d of devices.values()) if (d.ble) await d.ble.close().catch(() => {});
      console.error(t("cli.disconnected"));
    }
  };

  if (loggedIn) await withHub(program, (hub) => runner(hub));
  else await runner(null);
}

/** デバイスに対して可能な操作 (動詞)。制御 op は能力モデル (CONTROL_OPS) を単一真実源として引き、
 *  状態取得の "status" だけ CLI 固有に足す。型ごとの可否は cmdAct の能力ゲートが別途判定する。 */
const DEVICE_ACTIONS = new Set([...CONTROL_OPS, "status"]);

/**
 * デバイス主語の実行: `sesame <device> [action] [args]`。
 *   - action 省略 + TTY → そのデバイス (複数可) の対話セッション。
 *   - action 省略 + 非対話 → status を表示。
 *   - action 指定 → 1 発実行 (cmdAct に委譲。経路はオートで自動)。
 */
/**
 * @param {string|undefined} device
 * @param {string|undefined} action
 * @param {string[]|undefined} args
 * @param {{ bleOnly?: boolean, cloudOnly?: boolean, name?: string }} options
 * @param {Program} program
 */
async function cmdDeviceOp(device, action, args, options, program) {
  if (!action) {
    if (isInteractive() && !program.opts().json) { await cmdSession(device ? [device] : [], options, program); return; }
    action = "status"; // 非対話の既定は状態表示
  }
  if (!DEVICE_ACTIONS.has(action)) {
    die(t("cli.unknownAction", { action, actions: [...DEVICE_ACTIONS].join(" / "), device: device || "<device>" }), 2);
    return;
  }
  const seconds = action === "autolock" ? (args && args[0]) : null;
  if (action === "autolock" && (seconds == null)) {
    die(t("cli.autolockNeedsSeconds"), 2);
    return;
  }
  await cmdAct(action, device, seconds, options, program);
}

/**
 * @param {string} op
 * @param {string|undefined} name
 * @param {string|null|undefined} seconds
 * @param {{ bleOnly?: boolean, cloudOnly?: boolean, name?: string }} options
 * @param {Program} program
 */
async function cmdAct(op, name, seconds, options, program) {
  const entry = await resolveLockEntry(program, name || options.name);
  if (!entry) return; // die 済み
  const transport = pickTransport(op, options, entry.model);
  const gopts = /** @type {GlobalOpts} */ (program.opts());
  const extra = op === "autolock" ? ` ${seconds}s` : "";

  // デバイス型ごとの能力ゲート (SDK 準拠)。model が判っていて非対応な操作は接続前に弾く。
  // 例: Bot に lock/unlock → "click を使え"、Lock に click → "toggle を使え"。
  // ゲート対象は制御 op (CONTROL_OPS = 能力モデルの単一真実源)。"status" は全機種可なので除外。
  if (CONTROL_OPS.includes(op) && entry.model) {
    const caps = capabilitiesForModel(entry.model);
    if (!caps.ops.includes(op)) {
      die(t("cli.modelNotSupportOp", { label: caps.label, model: entry.model, op, ops: caps.ops.join("/") || t("cli.opsNone") }), 2);
      return;
    }
  }

  // autolock の引数検証は接続前に。
  if (op === "autolock") {
    const sec = Number(seconds);
    if (!Number.isInteger(sec) || sec < 0 || sec > 65535) { die(t("cli.secondsRange"), 2); return; }
  }

  if (transport === "ble") {
    // BLE 一時接続 (--ble-only 明示、または autolock のような cloud 不可な op)。
    if (!gopts.json) console.error(`[ble] ${op}${extra} → ${entry.name}`);
    try {
      await runBleOp(op, entry, seconds, gopts);
    } catch (e) {
      if (maybeHandleBleError(e)) return; // 権限/電源/未導入は設定誘導
      throw e;
    }
    return;
  }
  // transport === "cloud"
  if (!hasCloudSession(program)) {
    die(t("cli.cloudNotLoggedIn"), 2);
    return;
  }
  if (!gopts.json) console.error(`[cloud] ${op}${extra} → ${entry.name}`);
  await runCloudOp(op, entry, program);
}

// ---------- コマンド: migrate ----------

/**
 * 旧構成 (.env / keys.json / .tokens.json) からの移行サマリ。
 * @typedef {object} MigrateSummary
 * @property {string} configDir
 * @property {string[]} imported
 * @property {string} [hub3Added]
 * @property {string} [remoteAdded]
 *
 * @param {string|undefined} srcDir
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdMigrate(srcDir, _opts, program) {
  const { opts, paths, configStore, tokenStore } = loadCtx(program);
  const src = resolve(srcDir || process.cwd());
  ensureSecureDir(paths.dir); // 0700

  /** @type {MigrateSummary} */
  const summary = { configDir: paths.dir, imported: [] };

  // 1. tokens — copyFileSync は元ファイルの mode を引き継ぐ (旧 .tokens.json が 0644 だと
  //    移行先も 0644 になる)。idToken/refreshToken/deviceKey 入りなので copy 後に 0600 へ締める。
  const oldTokens = resolve(src, ".tokens.json");
  if (existsSync(oldTokens)) {
    copyFileSync(oldTokens, paths.tokens);
    restrictSecretFile(paths.tokens);
    summary.imported.push("tokens.json");
  }
  const oldPending = resolve(src, ".login_state.json");
  if (existsSync(oldPending)) {
    copyFileSync(oldPending, paths.loginState);
    restrictSecretFile(paths.loginState);
    summary.imported.push("login_state.json");
  }

  // 2. config: .env + keys.json を統合
  const cfg = configStore.load(); // 既存 or 空
  const envPath = resolve(src, ".env");
  /** @type {Record<string, string>} */
  let envVars = {};
  if (existsSync(envPath)) {
    envVars = parseDotenv(readFileSync(envPath, "utf8"));
    summary.imported.push(".env");
  }
  const keysPath = resolve(src, "keys.json");
  /** @type {{ alias?: string, keys?: Record<string, string> }|null} */
  let keysFile = null;
  if (existsSync(keysPath)) {
    keysFile = JSON.parse(readFileSync(keysPath, "utf8"));
    summary.imported.push("keys.json");
  }

  if (envVars.COMPANY_ID)   cfg.companyID = envVars.COMPANY_ID;
  if (envVars.WS_URL)       cfg.wsUrl     = envVars.WS_URL;
  if (envVars.LANG)         cfg.lang      = envVars.LANG;

  // hub3/remote は派生 view (cfg.hub3s) を直接いじらず、devices/remotes へ書く store API 経由で登録する
  // (view は save() の _reproject で再生成されるため、直接代入しても保存されず消える)。
  if (envVars.HUB3_DEVICE_ID) {
    const hub3Name = "default";
    configStore.addHub3(hub3Name, { deviceId: envVars.HUB3_DEVICE_ID, name: hub3Name });
    summary.hub3Added = hub3Name;
  }

  if (envVars.IR_DEVICE_UUID && Object.keys(cfg.hub3s).length) {
    const hub3Name = Object.keys(cfg.hub3s)[0];
    const remoteName = keysFile?.alias || "default";
    configStore.addRemote(remoteName, {
      hub3: hub3Name,
      irDeviceUUID: envVars.IR_DEVICE_UUID,
      irType: Number(envVars.IR_TYPE) || DEFAULT_IR_TYPE,
      irOperation: envVars.IR_OPERATION || "learnEmit",
      alias: keysFile?.alias || null,
      keys: keysFile?.keys || {},
    });
    summary.remoteAdded = remoteName;
  }

  configStore.save(); // companyID/wsUrl/lang 等の直接設定分を確定 (hub3/remote は上で保存済み)

  out(opts.json, () => {
    console.log(t("cli.okMigrated", { dir: paths.dir }));
    console.log(t("cli.imported", { list: summary.imported.join(", ") || t("cli.importedNone") }));
    if (summary.hub3Added)   console.log(t("cli.migrateHub3", { name: summary.hub3Added }));
    if (summary.remoteAdded) console.log(t("cli.migrateRemote", { name: summary.remoteAdded }));
    console.log(t("cli.migrateOldFiles"));
  }, summary);
}

/**
 * @param {string} content
 * @returns {Record<string, string>}
 */
function parseDotenv(content) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of content.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const m = s.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[m[1]] = val;
  }
  return out;
}

// ---------- run ----------

// テスト用 export: status 出力の純関数 (秘匿値除去 / 整形) と config マスク。
export { fmtCloudStatus, sanitizeStatus, redactConfig };

// 明示された --lang の解決済みロケール (init で uiLang/lang を永続化するために保持)。
// 認識できないフラグや未指定なら null。
/** @type {import("./i18n.js").Locale|null} */
let CLI_LANG_FLAG = null;

export async function run(argv = process.argv) {
  setJsonMode(argv.includes("--json")); // die()/エラー経路用にグローバル --json を先に確定
  const program = new Command();

  // UI ロケールを確定する (この後 t() を使うコマンド description / help / session UI 等に効く)。
  // commander へコマンドを登録する前に行う: description 文字列は登録時に t() で解決されるため、
  // それより先に setLocale() しないと既定 "en" のまま固定されてしまう。
  // 優先順位: --lang フラグ > config.uiLang > 既定 "en"。commander parse 前なので argv を直接覗く。
  {
    const langFlag =
      (() => { const i = argv.indexOf("--lang"); return i >= 0 ? argv[i + 1] : null; })() ||
      (argv.find((a) => a.startsWith("--lang=")) || "").split("=")[1] || null;
    // 未知の --lang (例: `--lang xx`) は黙って英語へ落とさず警告する (typo に気付けるように)。
    if (langFlag && !isKnownLang(langFlag)) console.error(t("cli.unknownLang", { lang: langFlag }));
    let cfgUiLang = null;
    try { const { configStore } = loadCtx(program); if (configStore.exists()) cfgUiLang = configStore.load().uiLang; } catch { /* config 未作成等は無視 */ }
    const locale = resolveLocale({ flag: langFlag, configLang: cfgUiLang });
    setLocale(locale);
    // 明示かつ認識できたフラグだけ init の永続化対象にする (`sesame --lang en init` の意図を残す)。
    CLI_LANG_FLAG = (langFlag && isKnownLang(langFlag)) ? locale : null;
  }

  program
    .name("sesame")
    .description(t("cli.progDescription"))
    .version(getPkgVersion(), "-V, --version")
    // 引数不足/未知オプション時に usage を出す (commander 既定はエラー1行のみで不親切)。
    // この前に設定すると後で追加する全サブコマンドへ継承される。--json 時は writeErr 側で抑止。
    .showHelpAfterError()
    .showSuggestionAfterError()
    .option("--config-dir <path>", t("cli.optConfigDir"))
    .option("--debug", t("cli.optDebug"))
    .option("--json", t("cli.optJson"))
    .option("--lang <lang>", t("cli.optLang"));

  program.addHelpText("before", t("cli.helpBefore"));

  program.command("login <email>").description(t("cli.descLogin"))
    .action((email, opts) => cmdLogin(email, opts, program));
  program.command("verify [code]").description(t("cli.descVerify"))
    .action((code, opts) => cmdVerify(code, opts, program));
  program.command("refresh").description(t("cli.descRefresh"))
    .action((opts) => cmdRefresh(opts, program));
  program.command("logout").description(t("cli.descLogout"))
    .action((opts) => cmdLogout(opts, program));
  program.command("whoami").description(t("cli.descWhoami"))
    .action((opts) => cmdWhoami(opts, program));

  program.command("send [key]").description(t("cli.descSend"))
    .option("--remote <name>", t("cli.optRemoteName"))
    .action((key, opts) => cmdSend(key, opts, program));
  program.command("list").description(t("cli.descList"))
    .option("--remote <name>", t("cli.optRemoteName"))
    .action((opts) => cmdList(opts, program));
  program.command("ping").description(t("cli.descPing"))
    .action((opts) => cmdPing(opts, program));
  program.command("devices").description(t("cli.descDevices"))
    .action((opts) => cmdDevices(opts, program));

  program.command("init").description(t("cli.descInit"))
    .action((opts) => cmdInit(opts, program));
  program.command("setup").description(t("cli.descSetup"))
    .action((opts) => cmdSetup(opts, program));
  program.command("migrate [srcDir]").description(t("cli.descMigrate"))
    .action((srcDir, opts) => cmdMigrate(srcDir, opts, program));

  // サブコマンド省略時は show 相当を出す (引数なしで exit 1 にならないように)
  const config = program.command("config").description(t("cli.descConfig"))
    .action((opts) => cmdConfigShow(opts, program));
  config.command("path").description(t("cli.descConfigPath"))
    .action((opts) => cmdConfigPath(opts, program));
  config.command("show").description(t("cli.descConfigShow"))
    .action((opts) => cmdConfigShow(opts, program));

  const remote = program.command("remote").description(t("cli.descRemote"));
  remote.command("ls").description(t("cli.descRemoteLs"))
    .action((opts) => cmdRemoteLs(opts, program));
  remote.command("add").description(t("cli.descRemoteAdd"))
    .addHelpText("after", t("cli.helpRemoteAdd"))
    .action((opts) => cmdRemoteAdd(opts, program));
  remote.command("set-default <name>").description(t("cli.descRemoteSetDefault"))
    .action((name, opts) => cmdRemoteSetDefault(name, opts, program));
  remote.command("sync-keys [name]").description(t("cli.descRemoteSyncKeys"))
    .action((name, opts) => cmdRemoteSyncKeys(name, opts, program));
  remote.command("sync-from-devices")
    .description(t("cli.descRemoteSyncFromDevices"))
    .action((opts) => cmdRemoteSyncFromDevices(opts, program));

  const hub3 = program.command("hub3").description(t("cli.descHub3"));
  hub3.command("ls").description(t("cli.descHub3Ls"))
    .action((opts) => cmdHub3Ls(opts, program));
  hub3.command("add").description(t("cli.descHub3Add"))
    .action((opts) => cmdHub3Add(opts, program));
  hub3.command("sync-from-devices").description(t("cli.descHub3SyncFromDevices"))
    .option("--prune", t("cli.optPruneHub3"))
    .action((opts) => cmdHub3SyncFromDevices(opts, program));

  // ロック定義の管理 (グループ名は locks。操作は下のトップレベル動詞)
  const locks = program.command("locks").description(t("cli.descLocks"));
  locks.command("ls").description(t("cli.descLockLs"))
    .action((opts) => cmdLockLs(opts, program));
  locks.command("add").description(t("cli.descLockAdd"))
    .option("--name <name>", t("cli.optLockName"))
    .option("--uuid <uuid>", t("cli.optLockUuid"))
    .option("--secret <hex>", t("cli.optLockSecret"))
    .option("--model <model>", t("cli.optLockModel"))
    .option("--alias <alias>", t("cli.optLockAlias"))
    .option("--from-url <url>", t("cli.optLockFromUrl"))
    .addHelpText("after", t("cli.helpLockAdd"))
    .action((opts) => cmdLockAdd(opts, program));
  locks.command("rm <name>").description(t("cli.descLockRm"))
    .option("--yes", t("cli.optYes"))
    .action((name, opts) => cmdLockRm(name, opts, program));
  locks.command("set-default <name>").description(t("cli.descLockSetDefault"))
    .action((name, opts) => cmdLockSetDefault(name, opts, program));
  locks.command("sync-from-devices").description(t("cli.descLockSyncFromDevices"))
    .option("--prune", t("cli.optPruneLock"))
    .action((opts) => cmdLockSyncFromDevices(opts, program));

  // ---------- デバイス主語の実行 (sesame <device> [action]) ----------
  // 主語はデバイス。`sesame front unlock` = front.unlock() 相当 (SDK の device.method() と同じ)。
  // action 省略は対話メニュー (= そのデバイスの session)。引数なし `sesame` は全デバイスの session。
  // 経路は既定「オート」(能力フル・自動。BLE 必須 op のみ BLE)。固定は --ble-only / --cloud-only。
  // 例: sesame front unlock / sesame kitchen click / sesame front autolock 30 / sesame front --ble-only
  //
  // 実体は隠し op コマンド。先頭トークンが既知コマンドでなければ run() がここへ振り分ける。
  program.command("op [device] [action] [args...]", { hidden: true })
    .option("--ble-only", t("cli.optBleOnly"))
    .option("--cloud-only", t("cli.optCloudOnly"))
    .action((device, action, args, opts) => cmdDeviceOp(device, action, args, opts, program));

  program.command("session [names...]").alias("watch")
    .description(t("cli.descSession"))
    .addHelpText("after", t("cli.helpSession"))
    .action((names, opts) => cmdSession(names, opts, program));

  // ---------- IR advanced (Phase C) ----------
  const irCmd = program.command("ir").description(t("cli.descIr"));
  irCmd.command("learn [remote] [keyname]")
    .description(t("cli.descIrLearn"))
    .action((remote, keyName, opts) => cmdIRLearn(remote, keyName, opts, program));
  const irMode = irCmd.command("mode").description(t("cli.descIrMode"));
  irMode.command("get [hub3]").description(t("cli.descIrModeGet"))
    .action((hub3, opts) => cmdIRModeGet(hub3, opts, program));
  irMode.command("set <mode> [hub3]").description(t("cli.descIrModeSet"))
    .action((mode, hub3, opts) => cmdIRModeSet(hub3, mode, opts, program));
  const irKey = irCmd.command("key").description(t("cli.descIrKey"));
  irKey.command("rm [remote] [key]").description(t("cli.descIrKeyRm"))
    .option("--yes", t("cli.optYes"))
    .action((remote, key, opts) => cmdIRKeyRm(remote, key, opts, program));
  irKey.command("rename [remote] [key] [new]").description(t("cli.descIrKeyRename"))
    .action((remote, key, n, opts) => cmdIRKeyRename(remote, key, n, opts, program));
  irCmd.command("remote-list <irType>").description(t("cli.descIrRemoteList"))
    .action((type, opts) => cmdIRRemoteListServer(type, opts, program));
  irCmd.command("search <irType> <term>").description(t("cli.descIrSearch"))
    .action((type, term, opts) => cmdIRRemoteSearch(type, term, opts, program));
  irCmd.command("match <irType> <irData>").description(t("cli.descIrMatch"))
    .action((type, irData, opts) => cmdIRRemoteMatch(type, irData, opts, program));
  irCmd.command("remote-rm [name]").description(t("cli.descIrRemoteRm"))
    .action((name, opts) => cmdIRRemoteRmServer(name, opts, program));
  irCmd.command("remote-rename <alias> [name]").description(t("cli.descIrRemoteRename"))
    .action((alias, name, opts) => cmdIRRemoteRenameServer(name, alias, opts, program));

  // ---------- device management (Phase D) ----------
  const devCmd = program.command("device").description(t("cli.descDevice"));
  devCmd.command("user-ls").description(t("cli.descDeviceUserLs"))
    .action((opts) => cmdDeviceUserLs(opts, program));
  devCmd.command("status [uuid]").description(t("cli.descDeviceStatus"))
    .action((uuid, opts) => cmdDeviceStatus(uuid, opts, program));
  devCmd.command("rename [uuid] [name]").description(t("cli.descDeviceRename"))
    .action((uuid, name, opts) => cmdDeviceRename(uuid, name, opts, program));
  devCmd.command("rm [uuid]").description(t("cli.descDeviceRm"))
    .option("--yes", t("cli.optYes"))
    .action((uuid, opts) => cmdDeviceRm(uuid, opts, program));

  program.command("history [deviceUUID]").description(t("cli.descHistory"))
    .option("--page-size <n>", t("cli.optPageSize"))
    .option("--delete <timestamp>", t("cli.optHistoryDelete"))
    .action((uuid, opts) => cmdHistory(uuid, opts, program));
  program.command("battery [deviceUUID]").description(t("cli.descBattery"))
    .option("--page-size <n>", t("cli.optPageSize100"))
    .option("--delete <ts>", t("cli.optBatteryDelete"))
    .action((uuid, opts) => cmdBattery(uuid, opts, program));
  program.command("firmware").description(t("cli.descFirmware"))
    .action((opts) => cmdFirmware(opts, program));
  program.command("webapi <func>").description(t("cli.descWebapi"))
    .option("--query <json>", t("cli.optWebapiQuery"))
    .option("--body <json>", t("cli.optWebapiBody"))
    .option("--api-key <id>", t("cli.optWebapiApiKey"))
    .action((func, opts) => cmdWebapi(func, opts, program));

  // bootstrap (互換コマンド: 既存 token を JSON で流し込み)
  program.command("bootstrap").description(t("cli.descBootstrap"))
    .action(async (opts) => {
      // stdin がパイプ/リダイレクトでない (TTY) のに読みに行くと無限に待つので明示拒否する。
      if (process.stdin.isTTY) die(t("cli.bootstrapStdin"), 2);
      const { tokenStore } = loadCtx(program);
      const chunks = [];
      for await (const c of process.stdin) chunks.push(c);
      const values = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const tok = bootstrap(tokenStore, values);
      out(isJsonMode(), () => console.log(t("cli.okBootstrapped", { clientId: /** @type {string} */ (tok.clientId) })),
        { ok: true, clientId: tok.clientId });
    });

  // meta コマンド
  program.command("meta").description(t("cli.descMeta"))
    .action(() => out(isJsonMode(), () => console.log(JSON.stringify(CONFIG_META, null, 2)), CONFIG_META));

  // ---------- 拡張コマンド群 (Phase F–L) を cli/ サブモジュールから登録 ----------
  // 各 register は registerXxxCommands(program, ctx) で commander サブコマンドを生やす。
  // 本体ロジックは src/<module>.js、コマンド配線は src/cli/<module>.js に分離している。
  const ctx = makeCtx(program);

  registerScheduleCommands(program, ctx);
  registerCompanyCommands(program, ctx);
  registerPaymentCommands(program, ctx);
  registerOrgCommands(program, ctx);
  registerAccessCommands(program, ctx);
  registerIotCommands(program, ctx);
  registerPresetIrCommands(program, ctx);
  registerBleCommands(program, ctx); // BLE 直結の読み取り系 (scan / 生体一覧 / Bot2 スクリプト)
  registerServeCommand(program); // 常駐 JSON-RPC バックエンド (serve は reserved に自動で入る)

  // デバイス主語の振り分け (位置引数の抽出・予約語判定・op 書き換え) は cli/dispatch.js に分離。
  // 既知デバイス / device action を伴うものだけ隠し op コマンドへ回し、それ以外の単独トークンは
  // 据え置いて commander に未知コマンド (+ 候補提示) を出させる。
  argv = routeDeviceArgv({
    argv,
    program,
    deviceActions: DEVICE_ACTIONS,
    isKnownDevice: (name) => isKnownDevice(program, name),
    interactive: isInteractive(),
  });

  // commander 自身の usage エラー (引数不足/未知オプション等) も JSON 契約に乗せる。
  // 全コマンドに exitOverride を伝播させ process.exit でなく throw させて下の catch に集約。
  // --json 時は commander の素のエラー文 (writeErr) を抑止し、die() の JSON 封筒だけ出す。
  (function propagateExitOverride(cmd) {
    cmd.exitOverride();
    cmd.configureOutput({ writeErr: (str) => { if (!isJsonMode()) process.stderr.write(str); } });
    for (const c of cmd.commands) propagateExitOverride(c);
  })(program);

  try {
    await program.parseAsync(argv);
  } catch (err) {
    const e = /** @type {import("./cli/errors.js").CommanderLikeError} */ (err);
    // help/version 表示は正常終了 (commander が stdout に出力済み)。
    if (e.code === "commander.helpDisplayed" || e.code === "commander.help" || e.code === "commander.version") {
      finishCli(); return;
    }
    if (program.opts().debug) console.error(e.stack);
    // BLE 権限/電源エラーは macOS なら該当設定ペインを自動で開いて誘導する。
    if (maybeHandleBleError(err)) { finishCli(); return; }
    // commander の usage エラー (未知コマンド/オプション/引数欠落) は契約どおり exit 2 に統一する。
    if (isCommanderError(err)) {
      const { msg, code } = commanderErrorInfo(e);
      // 非 JSON 時は commander が stderr に整形済み (usage 付き) なので二重出力を避ける。
      if (!isJsonMode()) { process.exitCode = code; finishCli(); return; }
      die(msg, code); return; // --json: 封筒で出す
    }
    die(withStaleHint(err), runtimeExitCode(err));
  }
  finishCli();
}

/**
 * 後始末してプロセスを終わらせる。noble (CoreBluetooth) を一度でも使うとネイティブ
 * ハンドルがイベントループに残り node が自然 exit しないため、その場合だけ明示終了する。
 * 出力の取りこぼしを防ぐため stdout を drain してから exit する。
 */
function finishCli() {
  if (!bleWasUsed()) return; // クラウドのみのコマンドは自然 exit に任せる (出力 truncate 回避)
  const code = process.exitCode || 0;
  if (process.stdout.write("")) process.exit(code);
  else process.stdout.once("drain", () => process.exit(code));
}

/**
 * BLE 権限/電源系エラーを検知し、macOS なら設定ペインを開いて案内する。
 * @param {unknown} err
 * @returns {boolean} ハンドルした (= 呼び出し側は return) なら true
 */
function maybeHandleBleError(err) {
  const e = /** @type {CliError} */ (err);
  const code = e?.code;
  if (
    code !== "BLE_UNAUTHORIZED" &&
    code !== "BLE_UNSUPPORTED" && // Linux/RPi/headless: アダプタ無し・権限不足 (native abort 探触のマップ先)
    code !== "BLE_POWERED_OFF" &&
    code !== "BLE_NO_ADAPTER"
  )
    return false;
  if (isJsonMode()) console.error(JSON.stringify({ error: e.message, code: 2, bleCode: code }));
  else console.error(`Error: ${e.message}`);
  if (!isJsonMode() && process.platform === "darwin" && code === "BLE_UNAUTHORIZED") {
    // システム設定 → プライバシーとセキュリティ → Bluetooth を直接開く (人間向け誘導。--json では出さない)。
    try {
      spawn("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Bluetooth"], {
        stdio: "ignore", detached: true,
      }).unref();
      console.error(t("cli.bleOpenedPrivacy"));
    } catch {
      console.error(t("cli.bleEnablePrivacy"));
    }
  }
  process.exitCode = 2;
  return true;
}

