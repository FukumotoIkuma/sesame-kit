// `sesame init` / `sesame config …` コマンド群。P5-3 で cli.js から抽出。
//
// init は --lang フラグの解決済みロケール (cli.js run() が保持する CLI_LANG_FLAG) を
// config に焼き込むため、registerInitCommand に getLangFlag を deps 注入する
// (モジュール変数を共有せず、依存方向 cli.js → config-cmd.js を保つ)。
// 依存方向: cli.js → config-cmd.js → ctx.js (循環なし)。

import { t } from "../i18n.js";
import { isJsonMode } from "./errors.js";
import { loadCtx, out, mask, redactConfig } from "./ctx.js";
import { ensureSecureDir } from "../secure-fs.js";

/** @typedef {import("./ctx.js").Program} Program */
/** @typedef {import("./ctx.js").CmdOpts} CmdOpts */

/**
 * @param {CmdOpts} _opts
 * @param {Program} program
 * @param {import("../i18n.js").Locale|null} langFlag 明示された --lang の解決済みロケール (無ければ null)
 */
async function cmdInit(_opts, program, langFlag) {
  const { opts, paths, configStore } = loadCtx(program);
  ensureSecureDir(paths.dir); // 0700 で作成 (旧実装は mode 無指定で 0755 になっていた)
  // `sesame --lang en init` の意図を config に焼き込み、次回以降のセッションへ引き継ぐ。
  const created = configStore.init(langFlag ? { uiLang: langFlag, lang: langFlag } : {});
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
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdConfigPath(_opts, program) {
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
 * `sesame init` を登録する。help のコマンド順 = 登録順のため setup/migrate より前に呼ぶ。
 * @param {Program} program
 * @param {{ getLangFlag: () => import("../i18n.js").Locale|null }} deps
 *   getLangFlag: 明示された --lang の解決済みロケール (cli.js run() が保持) を action 時に引く。
 */
export function registerInitCommand(program, deps) {
  program.command("init").description(t("cli.descInit"))
    .action((opts) => cmdInit(opts, program, deps.getLangFlag()));
}

/**
 * `sesame config` グループを登録する (サブコマンド省略時は show 相当)。
 * @param {Program} program
 */
export function registerConfigCommands(program) {
  // サブコマンド省略時は show 相当を出す (引数なしで exit 1 にならないように)
  const config = program.command("config").description(t("cli.descConfig"))
    .action((opts) => cmdConfigShow(opts, program));
  config.command("path").description(t("cli.descConfigPath"))
    .action((opts) => cmdConfigPath(opts, program));
  config.command("show").description(t("cli.descConfigShow"))
    .action((opts) => cmdConfigShow(opts, program));
}
