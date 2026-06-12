// `sesame migrate` (P5-3 で cli.js から抽出)。
// 旧構成 (.env / keys.json) から現行 config への移行。認証状態 (.tokens.json 等) は
// ConfirmDevice 済みか検証できないため移行せず skip する。
// 依存方向: cli.js → migrate.js → ctx.js。

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ensureSecureDir } from "../secure-fs.js";
import { DEFAULT_IR_TYPE } from "../crypto.js";
import { t } from "../i18n.js";
import { loadCtx, out } from "./ctx.js";

/** @typedef {import("./ctx.js").Program} Program */
/** @typedef {import("./ctx.js").CmdOpts} CmdOpts */

/**
 * 旧構成 (.env / keys.json、認証状態は skip) からの移行サマリ。
 * @typedef {object} MigrateSummary
 * @property {string} configDir
 * @property {string[]} imported
 * @property {string[]} skipped
 * @property {string} [hub3Added]
 * @property {string} [remoteAdded]
 *
 * @param {string|undefined} srcDir
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
export async function cmdMigrate(srcDir, _opts, program) {
  const { opts, paths, configStore } = loadCtx(program);
  const src = resolve(srcDir || process.cwd());
  ensureSecureDir(paths.dir); // 0700

  /** @type {MigrateSummary} */
  const summary = { configDir: paths.dir, imported: [], skipped: [] };

  // 1. tokens — 旧 .tokens.json / .login_state.json は ConfirmDevice 済みか検証できず、
  //    そのまま取り込むと初回 refresh で Invalid Refresh Token になる入口になる。
  //    認証状態は移行せず、公式アプリ相当の `sesame login` で作り直す。
  const oldTokens = resolve(src, ".tokens.json");
  if (existsSync(oldTokens)) {
    summary.skipped.push(".tokens.json (run `sesame login <email>`)");
  }
  const oldPending = resolve(src, ".login_state.json");
  if (existsSync(oldPending)) {
    summary.skipped.push(".login_state.json (stale sign-in state)");
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
    if (summary.skipped.length) console.log(t("cli.skipped", { list: summary.skipped.join(", ") }));
    if (summary.hub3Added)   console.log(t("cli.migrateHub3", { name: summary.hub3Added }));
    if (summary.remoteAdded) console.log(t("cli.migrateRemote", { name: summary.remoteAdded }));
    console.log(t("cli.migrateOldFiles"));
  }, summary);
}

/**
 * .env の素朴なパーサ (KEY=value、コメント/クォート対応)。dotenv 依存を持たないための内製。
 * @param {string} content
 * @returns {Record<string, string>}
 */
export function parseDotenv(content) {
  /** @type {Record<string, string>} */
  const vars = {};
  for (const line of content.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const m = s.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    vars[m[1]] = val;
  }
  return vars;
}
