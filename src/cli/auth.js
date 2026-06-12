// 認証系コマンド (P5-3 で cli.js から抽出)。
// login/verify/setup/refresh/logout/whoami/bootstrap と、認証後の自動セットアップ
// (bootstrapAfterLogin) をここに集約する。依存方向: cli.js → auth.js → ctx.js。

import {
  bootstrap,
  getValidIdToken,
  loginInitiate,
  loginVerify,
  logout,
} from "../auth.js";
import { SesameError, ERR } from "../errors.js";
import { t } from "../i18n.js";
import { die, isJsonMode } from "./errors.js";
import { loadCtx, out, withHub, canPrompt, promptLine } from "./ctx.js";

/** @typedef {import("./ctx.js").Program} Program */
/** @typedef {import("./ctx.js").CmdOpts} CmdOpts */
/** @typedef {import("./ctx.js").CliError} CliError */

/**
 * @param {string|undefined} email
 * @param {CmdOpts} _opts 予約 (コマンド固有オプション無し。シグネチャ統一のため保持)
 * @param {Program} program
 */
export async function cmdLogin(email, _opts, program) {
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
export async function cmdVerify(code, _opts, program) {
  const { opts, tokenStore } = loadCtx(program);
  if (!code && canPrompt(program)) code = await promptLine(t("cli.verifyCodePrompt"));
  if (!code) die(t("cli.codeRequired"), 2);
  const tok = await loginVerify(tokenStore, code);
  if (!opts.json) console.error(t("cli.signedInAutoSetup"));
  // 認証後の取り込みを自動化 (companyID / ロック / Hub3 IR)。失敗しても認証成功は維持。
  const summary = await bootstrapAfterLogin(program, { quiet: !!opts.json });
  out(opts.json, () => {
    const lk = summary.locks ? summary.locks.added.length + summary.locks.updated.length : 0;
    console.log(t("cli.verifyDone", { count: lk }));
    console.log(t("cli.verifyExamples"));
    if (summary.errors.length) console.log(t("cli.verifyPartialFail"));
  }, {
    ok: true,
    clientId: tok.clientId,
    username: tok.username,
    deviceKey: tok.deviceKey ? "set" : null,
    bootstrap: summary,
  });
}

/**
 * 認証後セットアップの手動再実行 (デバイス追加後など)。
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
export async function cmdSetup(_opts, program) {
  const { opts, tokenStore } = loadCtx(program);
  if (!tokenStore.load()) die(t("cli.notLoggedIn"), 2);
  if (!opts.json) console.error(t("cli.setupRunning"));
  const summary = await bootstrapAfterLogin(program, { quiet: !!opts.json });
  const failed = summary.errors.length > 0;
  out(opts.json, () => {
    if (summary.authExpired) {
      console.error(t("cli.setupAuthExpired"));
    } else if (failed) {
      console.error(t("cli.setupPartialFail", { errors: summary.errors.join("; ") }));
    } else {
      console.log(t("cli.setupDone"));
    }
  }, { ok: !failed, bootstrap: summary });
  if (failed) process.exitCode = 1;
}

/**
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
export async function cmdRefresh(_opts, program) {
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
export async function cmdLogout(_opts, program) {
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
export async function cmdWhoami(_opts, program) {
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

/**
 * bootstrap (互換コマンド): app-login 済み token backup を stdin の JSON から復元する。
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
export async function cmdBootstrap(_opts, program) {
  // stdin がパイプ/リダイレクトでない (TTY) のに読みに行くと無限に待つので明示拒否する。
  if (process.stdin.isTTY) die(t("cli.bootstrapStdin"), 2);
  const { tokenStore } = loadCtx(program);
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const input = Buffer.concat(chunks).toString("utf8").trim();
  if (!input) die(t("cli.bootstrapEmpty"), 2);
  let values;
  try { values = JSON.parse(input); }
  catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    die(t("cli.bootstrapInvalidJson", { message }), 2);
  }
  const tok = bootstrap(tokenStore, values);
  out(isJsonMode(), () => console.log(t("cli.okBootstrapped", { clientId: /** @type {string} */ (tok.clientId) })),
    { ok: true, clientId: tok.clientId });
}
