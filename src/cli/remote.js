// `sesame send/list/ping` + `sesame remote …` / `sesame hub3 …`。
// リモコン (IR キー送信) と Hub3 の config 管理系を P5-3 で cli.js から抽出。
//
// send/list/ping はトップレベル先頭側 (login 系の直後) に出すため別 register
// (registerSendCommands) にしている (help のコマンド順 = 登録順を変えない)。
// 依存方向: cli.js → remote.js → pickers.js / ctx.js (循環なし)。

import { t } from "../i18n.js";
import { die, isJsonMode } from "./errors.js";
import { loadCtx, withHub, out, canPrompt } from "./ctx.js";
import { pickRemoteName, pickRemoteKeyName, printSyncResult } from "./pickers.js";
import { selectFromList, promptText } from "../prompts.js";

/** @typedef {import("./ctx.js").Program} Program */
/** @typedef {import("./ctx.js").CmdOpts} CmdOpts */
/** @typedef {import("../config.js").ConfigStore} ConfigStore */

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
 * @param {RemoteOpts & { hub3DeviceId?: string, irDeviceUuid?: string }} options
 * @param {Program} program
 */
async function cmdList(options, program) {
  // SURF-24: config 非依存の直指定 (--hub3-device-id + --ir-device-uuid)。両方そろえば
  // remote 名解決をスキップして getIRCodesDirect に直行する。片方だけは対象不定なので usage。
  const direct = !!(options.hub3DeviceId || options.irDeviceUuid);
  if (direct && !(options.hub3DeviceId && options.irDeviceUuid)) {
    die(t("cli.listDirectNeedsBoth"), 2);
  }
  const { configStore } = loadCtx(program);
  if (!direct && configStore.exists()) {
    options.remote = await pickRemoteName(program, configStore, options.remote ?? undefined) || options.remote;
  }
  await withHub(program, async (hub, { opts }) => {
    const codes = direct
      ? await hub.getIRCodesDirect({
          hub3DeviceId: /** @type {string} */ (options.hub3DeviceId),
          irDeviceUUID: /** @type {string} */ (options.irDeviceUuid),
        })
      : await hub.listKeys(options.remote ?? null);
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

// ---------- コマンド: remote (config 管理) ----------

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
    if (!candidates.length) { die(t("cli.remotesNotFound"), 2); return; }
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
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdRemoteSetDefault(name, _opts, program) {
  const { configStore } = loadCtx(program);
  configStore.setDefaultRemote(name);
  out(isJsonMode(), () => console.log(t("cli.okDefaultRemote", { name })), { ok: true, defaultRemote: name });
}

/**
 * @param {string|undefined} name
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdRemoteSyncKeys(name, _opts, program) {
  await withHub(program, async (hub) => {
    const { name: resolvedName, keyCount } = await hub.syncRemoteKeys(name ?? null);
    out(isJsonMode(), () => console.log(t("cli.okSyncedKeys", { keyCount, name: resolvedName })),
      { ok: true, remote: resolvedName, keyCount });
  });
}

/**
 * P4-6 (R2:SURF-32): server の getRemoteList から config へ取り込む (syncRemotesFromDevices の代替経路)。
 * hub3 名と irType を必須引数とする (devices 経路では自動判定だが server 経路は明示指定が必要)。
 * @param {string} hub3
 * @param {string} irTypeStr  コマンドライン文字列 → Number() で整数化
 * @param {CmdOpts} _options
 * @param {Program} program
 */
async function cmdRemoteSyncFromServer(hub3, irTypeStr, _options, program) {
  const irType = Number(irTypeStr);
  if (!Number.isFinite(irType) || irType <= 0) die(t("cli.argRemoteSyncFromServerIrType"), 2);
  await withHub(program, async (hub, { opts }) => {
    const result = await hub.syncRemotesFromServer(hub3, irType);
    out(opts.json,
      () => console.log(t("cli.okRemoteSyncFromServer", {
        hub3, irType, added: result.added.length, updated: result.updated.length,
      })),
      { ok: true, hub3, irType, added: result.added, updated: result.updated });
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

// ---------- コマンド: hub3 (config 管理) ----------

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
    if (!hub3Devices.length) { die(t("cli.hub3NotFoundInDevices"), 2); return; }
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
 * `sesame send/list/ping` を登録する。
 * help のコマンド順 = 登録順のため、login 系の直後 (devices より前) に呼ぶ。
 * @param {Program} program
 */
export function registerSendCommands(program) {
  program.command("send [key]").description(t("cli.descSend"))
    .option("--remote <name>", t("cli.optRemoteName"))
    .action((key, opts) => cmdSend(key, opts, program));
  program.command("list").description(t("cli.descList"))
    .option("--remote <name>", t("cli.optRemoteName"))
    // SURF-24: config 非依存の直指定 (両方そろえて使う)。
    .option("--hub3-device-id <uuid>", t("cli.optListHub3DeviceId"))
    .option("--ir-device-uuid <uuid>", t("cli.optListIrDeviceUuid"))
    .action((opts) => cmdList(opts, program));
  program.command("ping").description(t("cli.descPing"))
    .action((opts) => cmdPing(opts, program));
}

/**
 * `sesame remote …` / `sesame hub3 …` グループを登録する (config 管理)。
 * @param {Program} program
 */
export function registerRemoteCommands(program) {
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
  // P4-6 (R2:SURF-32): sync-from-server — server 経由の代替取り込み経路。
  // hub3 と irType を必須引数とする (devices 経路と異なり自動判定が効かないため)。
  remote.command("sync-from-server <hub3> <irType>")
    .description(t("cli.descRemoteSyncFromServer"))
    .action((hub3, irType, opts) => cmdRemoteSyncFromServer(hub3, irType, opts, program));

  const hub3 = program.command("hub3").description(t("cli.descHub3"));
  hub3.command("ls").description(t("cli.descHub3Ls"))
    .action((opts) => cmdHub3Ls(opts, program));
  hub3.command("add").description(t("cli.descHub3Add"))
    .action((opts) => cmdHub3Add(opts, program));
  hub3.command("sync-from-devices").description(t("cli.descHub3SyncFromDevices"))
    .option("--prune", t("cli.optPruneHub3"))
    .action((opts) => cmdHub3SyncFromDevices(opts, program));
}
