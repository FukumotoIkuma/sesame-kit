// `sesame locks …` コマンド群: ロック定義の config 管理。P5-3 で cli.js から抽出。
//
// ls / add (--from-url 含む) / rm / set-default / sync-from-devices。
// 操作 (unlock/lock/toggle 等) はトップレベル動詞 (cli/lock-ops.js) で、ここは定義の CRUD のみ。
// 依存方向: cli.js → locks.js → pickers.js / ctx.js (循環なし)。

import { t } from "../i18n.js";
import { die, isJsonMode } from "./errors.js";
import { loadCtx, withHub, out, redactConfig, canPrompt, promptLine } from "./ctx.js";
import { printSyncResult } from "./pickers.js";
import { confirm as confirmPrompt } from "../prompts.js";
import { isLockModel } from "../config.js";
import { parseShareKeyUrl } from "../sharekey.js";

/** @typedef {import("./ctx.js").Program} Program */
/** @typedef {import("./ctx.js").CmdOpts} CmdOpts */
/** @typedef {import("./ctx.js").CliError} CliError */

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isDeviceUuidLike(v) {
  return typeof v === "string" &&
    (/^[0-9a-f]{32}$/i.test(v) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v));
}

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isSecretKeyLike(v) {
  return typeof v === "string" && /^[0-9a-f]{32}$/i.test(v);
}

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
  }, redactConfig({ default: def, locks }));
}

/**
 * `locks add` のオプション袋。フラグ指定で非対話登録できる。
 * ssmPublicKey/keyIndex は OS2 デバイス用 (バックログ4: os2-register の戻り値を保存し、
 * os2-invoke が --ssm-public-key 無しで config から解決できるようにする)。
 * @typedef {object} LockAddOpts
 * @property {string} [name]
 * @property {string} [uuid]
 * @property {string} [secret]
 * @property {string} [model]
 * @property {string} [alias]
 * @property {string} [fromUrl]
 * @property {string} [ssmPublicKey]
 * @property {string} [keyIndex]
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
  if (!isDeviceUuidLike(deviceUUID)) die(t("cli.invalidDeviceUuid", { value: deviceUUID }), 2);
  const secretKey = await ask("secret", t("cli.secretKeyPrompt"), true, parsed?.secretKey);
  if (!secretKey) die(t("cli.secretKeyRequired"), 2);
  if (!isSecretKeyLike(secretKey)) die(t("cli.invalidSecretKey"), 2);
  const model = await ask("model", t("cli.modelPrompt"), false, parsed?.deviceModel);
  if (model && !isLockModel(model)) die(t("cli.invalidLockModel", { model }), 2);
  const alias = await ask("alias", t("cli.aliasPrompt"), false);
  // OS2 鍵素材 (任意フラグ。対話 prompt はしない — OS3 が大半で、OS2 利用者は
  // os2-register の出力を貼るだけなのでフラグ経路で十分)。形式不正は usage エラー (exit 2)。
  const ssmPublicKey = opts.ssmPublicKey || null;
  if (ssmPublicKey && !/^[0-9a-f]{128}$/i.test(ssmPublicKey)) die(t("cli.invalidSsmPublicKey"), 2);
  const keyIndex = opts.keyIndex || null;
  if (keyIndex && !/^[0-9a-f]{4}$/i.test(keyIndex)) die(t("cli.invalidKeyIndex"), 2);
  configStore.addLock(name, {
    deviceUUID,
    secretKey,
    model: model || null,
    alias: alias || null,
    ssmPublicKey,
    keyIndex,
  });
  out(isJsonMode(), () => console.log(t("cli.okLockAdded", { name })),
    { ok: true, lock: name, deviceUUID, model: model || null, alias: alias || null,
      ...(ssmPublicKey ? { ssmPublicKey } : {}), ...(keyIndex ? { keyIndex } : {}) });
}

/**
 * @param {string} name
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdLockSetDefault(name, _opts, program) {
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
 * `sesame locks …` グループを登録する (ロック定義の管理。操作はトップレベル動詞)。
 * @param {Program} program
 */
export function registerLocksCommands(program) {
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
    // OS2 デバイス用の任意鍵素材 (バックログ4。os2-register の戻り値を config に保存する)。
    .option("--ssm-public-key <hex>", t("cli.optLockSsmPublicKey"))
    .option("--key-index <hex>", t("cli.optLockKeyIndex"))
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
}
