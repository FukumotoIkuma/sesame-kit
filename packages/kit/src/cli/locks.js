// `sesame locks …` コマンド群: ロック定義の config 管理。P5-3 で cli.js から抽出。
//
// ls / add (--from-url 含む) / rm / set-default / sync-from-devices / sync-from-account。
// 操作 (unlock/lock/toggle 等) はトップレベル動詞 (cli/lock-ops.js) で、ここは定義の CRUD のみ。
// 依存方向: cli.js → locks.js → pickers.js / ctx.js (循環なし)。

import { t } from "@sesame-kit/core/i18n";
import { die, isJsonMode } from "./errors.js";
import { loadCtx, withHub, out, redactConfig, canPrompt, promptLine } from "./ctx.js";
import { printSyncResult } from "./pickers.js";
import { confirm as confirmPrompt } from "../prompts.js";
import { isLockModel } from "@sesame-kit/core/config";
import { parseShareKeyUrl } from "@sesame-kit/core/sharekey";
// P3-2: 個人アカウント鍵ストア REST API (@experimental: 実 API Gateway 未検証 §9 V15)。
import { makeKeyStoreTransport, getDevicesList, putKey } from "@sesame-kit/core/devices";

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
 * push: true のとき、ローカル config に登録後に個人アカウント鍵ストア REST API へ同期する
 * (P3-2。CHAPIClientBiz.kt:102-103 の putKey 相当。@experimental: 実機未検証 §9 V15)。
 * @typedef {object} LockAddOpts
 * @property {string} [name]
 * @property {string} [uuid]
 * @property {string} [secret]
 * @property {string} [model]
 * @property {string} [alias]
 * @property {string} [fromUrl]
 * @property {string} [ssmPublicKey]
 * @property {string} [keyIndex]
 * @property {boolean} [push]
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

  // P3-2: --push で個人アカウント鍵ストアへ同期 (CHAPIClientBiz.kt:102-103 putKey 相当)。
  // @experimental 実機 API Gateway での受理は未検証 (REFACTORING_PLAN §9 V15)。
  if (opts.push) {
    const { tokenStore } = loadCtx(program);
    const cfg = configStore.load();
    try {
      const transport = makeKeyStoreTransport({ tokenStore, config: cfg, configStore });
      /** @type {import("@sesame-kit/core/devices").CHUserKey} */
      const key = {
        deviceUUID: /** @type {string} */ (deviceUUID),
        deviceModel: model || "",
        keyIndex: keyIndex || "",
        secretKey: /** @type {string} */ (secretKey),
        sesame2PublicKey: ssmPublicKey || "",
        deviceName: name || null,
        keyLevel: 2, // level=2 が owner 相当 (CHUserKey.kt / cheyKeyToUserKey 参照)
      };
      await putKey(transport, key);
      if (!isJsonMode()) console.log(t("cli.okLockPushed", { name }));
    } catch (e) {
      // 同期失敗はローカル登録の成功に影響させない (警告で継続)
      if (!isJsonMode()) {
        console.error(t("cli.warnLockPushFailed", { name, message: /** @type {CliError} */ (e).message }));
      }
    }
  }

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
 * `locks sync-from-account` — 個人アカウント鍵ストア REST API から鍵を取り込み、
 * ローカル config に登録していない鍵を locks に追加する (P3-2)。
 * CHAPIClientBiz.kt:105-106 の getDevicesList 相当。
 *
 * @experimental 実機 API Gateway での受理は未検証 (REFACTORING_PLAN §9 V15)。
 *
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdLockSyncFromAccount(_opts, program) {
  const { configStore, tokenStore } = loadCtx(program);
  if (!configStore.exists()) die(t("cli.configNotInitialized"), 2);
  const cfg = configStore.load();
  /** @type {import("@sesame-kit/core/devices").CHUserKey[]} */
  let keys;
  try {
    const transport = makeKeyStoreTransport({ tokenStore, config: cfg, configStore });
    keys = await getDevicesList(transport);
  } catch (e) {
    die(t("cli.syncFromAccountFailed", { message: /** @type {CliError} */ (e).message }), 1);
    return;
  }
  const locks = cfg.locks || {};
  let added = 0;
  for (const key of keys) {
    if (!key.deviceUUID) continue;
    // 既存エントリは上書きしない (sync の場合は追加のみ)。
    const existing = Object.values(locks).find((l) => l.deviceUUID === key.deviceUUID);
    if (existing) continue;
    const name = key.deviceName || key.deviceUUID;
    configStore.addLock(name, {
      deviceUUID: key.deviceUUID,
      secretKey: key.secretKey || "",
      model: key.deviceModel || null,
      alias: null,
      ssmPublicKey: null,
      keyIndex: key.keyIndex || null,
    });
    added++;
  }
  out(isJsonMode(),
    () => console.log(t("cli.syncFromAccountDone", { total: keys.length, added })),
    { ok: true, total: keys.length, added });
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
    // P3-2: ローカル登録後に個人アカウント鍵ストアへ同期 (@experimental §9 V15)。
    .option("--push", t("cli.optLockPush"))
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
  // P3-2: 個人アカウント鍵ストアから鍵を取り込む (@experimental §9 V15)。
  locks.command("sync-from-account").description(t("cli.descLockSyncFromAccount"))
    .action((opts) => cmdLockSyncFromAccount(opts, program));
}
