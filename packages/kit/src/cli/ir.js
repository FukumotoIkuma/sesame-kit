// `sesame ir …` コマンド群: IR advanced (Phase C)。P5-3 で cli.js から抽出。
//
// learn / mode get|set / key rm|rename / remote-list / search / match /
// remote-add / remote-add-matter / remote-rm / remote-rename。
// 本体ロジックは src/ir.js (client 経由)。ここは commander への配線と入出力整形のみ。
// 依存方向: cli.js → ir.js → pickers.js / ctx.js (循環なし)。

import { readFileSync } from "node:fs";
import { t } from "@sesame-kit/core/i18n";
import { die } from "./errors.js";
import { loadCtx, withHub, out, canPrompt } from "./ctx.js";
import { pickRemoteName, pickRemoteKeyName } from "./pickers.js";
import { promptText, confirm as confirmPrompt } from "../prompts.js";
import { parseIrType } from "@sesame-kit/core/crypto";

/** @typedef {import("./ctx.js").Program} Program */
/** @typedef {import("./ctx.js").CmdOpts} CmdOpts */
/** @typedef {import("./ctx.js").CliError} CliError */

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
    // P1-12: listIRRemotes は {list, pagination} を返す (vendor useRemoteCtrl.js:43-57 の読み方)。
    const { list: rawList, pagination } = await hub.listIRRemotes(irt);
    const list = /** @type {Array<{alias?:string, name?:string, irDeviceUUID?:string, uuid?:string}>} */ (rawList);
    out(opts.json, () => {
      console.log(t("cli.foundRemotes", { count: list.length, type: irt }));
      for (const r of list) {
        console.log(`  ${r.alias || r.name || "(no name)"}\t${r.irDeviceUUID || r.uuid || ""}`);
      }
    }, { count: list.length, remotes: list, pagination });
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
    // P1-12: searchPresetIRRemotes は {list, pagination} を返す (vendor useRemoteCtrl.js:59-63 の読み方)。
    const { list: rawList } = await hub.searchPresetIRRemotes(irt, term);
    const list = /** @type {Array<{brandName?:string, name?:string, modelName?:string, model?:string, uuid?:string}>} */ (rawList);
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
 * --json <file|-> の入力を読む (ファイルパス or "-"=stdin)。
 * `ir remote-add` / 将来の JSON 投入系コマンドの共通入口。
 * @param {string} src ファイルパス or "-"
 * @returns {Promise<string>} 生 JSON 文字列
 */
async function readJsonSource(src) {
  if (src === "-") {
    if (process.stdin.isTTY) die(t("cli.jsonStdinNotTty"), 2);
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  try {
    return readFileSync(src, "utf8").trim();
  } catch (e) {
    die(t("cli.jsonFileReadFailed", { file: src, message: /** @type {CliError} */ (e).message }), 2);
    return ""; // unreachable (die は exit)
  }
}

/**
 * `sesame ir remote-add --json <file|->` — リモコンオブジェクトをサーバへ登録 (SURF-05)。
 *
 * 入力契約: vendor 形オブジェクト (ir.js addIRRemote 参照):
 *   {
 *     uuid       — クライアント発番 UUID。省略時は addIRRemote 内で自動補完。
 *     model      — リモコンのモデル文字列。
 *     state      — 最後に発射したコマンド HEX (初回は '')。
 *     alias      — 表示名。
 *     code       — preset コード文字列。
 *     type       — リモコン種別 int (0xC000/0x2000/0xE000/0x8000/0xFE00 等)。
 *     deviceUUID — Hub3 の deviceId (必須)。
 *     keys       — キー配列 (初回は [])。
 *   }
 *
 * 注意: `sesame ir search` / `sesame ir match` の出力は uuid/alias/state/deviceUUID/keys が
 * 未セットのため、それらを付加してから渡すこと。
 * 一次資料: references_web/src/pages/.../ir/learn/index.js:261-270,
 *           remote-air/index.js:512-521, remote-non-air/index.js:264-273。
 *
 * @param {{ json?: string }} options
 * @param {Program} program
 */
async function cmdIRRemoteAddServer(options, program) {
  if (!options.json) die(t("cli.irRemoteAddJsonRequired"), 2);
  const raw = await readJsonSource(/** @type {string} */ (options.json));
  /** @type {any} */
  let remote;
  try { remote = JSON.parse(raw); }
  catch (e) { die(t("cli.invalidJsonValue", { message: /** @type {CliError} */ (e).message }), 2); }
  if (!remote || typeof remote !== "object" || Array.isArray(remote)) {
    die(t("cli.irRemoteAddNotObject"), 2);
  }
  await withHub(program, async (hub, { opts }) => {
    const resp = await hub.addIRRemoteServer(remote);
    out(opts.json, () => console.log(t("cli.okIrRemoteAdded", { name: remote.name || remote.alias || remote.uuid || "(unnamed)" })),
      { ok: true, remote, response: resp });
  });
}

/**
 * `sesame ir remote-add-matter` — リモコンを Matter の On/Off デバイスとして Hub3 に登録
 * (SURF-05 / P3-3 残件。hub.addRemoteToMatter = useRemoteCtrl.js:933-955 フィールド 1:1)。
 * Matter ペアリング窓 (`sesame iot matter-open`) の開放とセットで使う。実機未検証 (experimental)。
 * @param {{ hub3DeviceId?: string, irDeviceType?: string, cmdOn?: string, cmdOff?: string,
 *           irDeviceUuid?: string, irDeviceName?: string }} options
 * @param {Program} program
 */
async function cmdIRRemoteAddMatter(options, program) {
  // commander は --ir-device-uuid → irDeviceUuid とキャメル化する。vendor フィールド名へ写像。
  const p = {
    hub3DeviceId: options.hub3DeviceId,
    irDeviceType: options.irDeviceType === undefined ? undefined : Number(options.irDeviceType),
    cmdOn: options.cmdOn,
    cmdOff: options.cmdOff,
    irDeviceUUID: options.irDeviceUuid,
    irDeviceName: options.irDeviceName,
  };
  /** @type {string[]} */
  const missing = [];
  if (!p.hub3DeviceId) missing.push("--hub3-device-id");
  if (p.irDeviceType === undefined || Number.isNaN(p.irDeviceType)) missing.push("--ir-device-type");
  if (!p.cmdOn) missing.push("--cmd-on");
  if (!p.cmdOff) missing.push("--cmd-off");
  if (!p.irDeviceUUID) missing.push("--ir-device-uuid");
  if (!p.irDeviceName) missing.push("--ir-device-name");
  if (missing.length > 0) die(t("cli.irRemoteAddMatterMissing", { missing: missing.join(" ") }), 2);
  await withHub(program, async (hub, { opts }) => {
    const resp = await hub.addRemoteToMatter(/** @type {{hub3DeviceId:string, irDeviceType:number, cmdOn:string, cmdOff:string, irDeviceUUID:string, irDeviceName:string}} */ (p));
    out(opts.json, () => console.log(t("cli.okIrRemoteAddedMatter", { name: /** @type {string} */ (p.irDeviceName) })),
      { ok: true, request: p, response: resp });
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

/**
 * `sesame ir` グループを commander に登録する (IR advanced / Phase C)。
 * @param {Program} program
 */
export function registerIrCommands(program) {
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
  // SURF-05: `ir search`/`ir match` の出力 remote オブジェクトをそのまま投入できる登録口。
  irCmd.command("remote-add").description(t("cli.descIrRemoteAdd"))
    .option("--json <file|->", t("cli.optIrRemoteAddJson"))
    .addHelpText("after", t("cli.helpIrRemoteAdd"))
    .action((opts) => cmdIRRemoteAddServer(opts, program));
  // SURF-05 (P3-3 残件): リモコンの Matter デバイス化。
  irCmd.command("remote-add-matter").description(t("cli.descIrRemoteAddMatter"))
    .option("--hub3-device-id <uuid>", t("cli.optMatterHub3DeviceId"))
    .option("--ir-device-type <type>", t("cli.optMatterIrDeviceType"))
    .option("--cmd-on <hex>", t("cli.optMatterCmdOn"))
    .option("--cmd-off <hex>", t("cli.optMatterCmdOff"))
    .option("--ir-device-uuid <uuid>", t("cli.optMatterIrDeviceUuid"))
    .option("--ir-device-name <name>", t("cli.optMatterIrDeviceName"))
    .action((opts) => cmdIRRemoteAddMatter(opts, program));
  irCmd.command("remote-rm [name]").description(t("cli.descIrRemoteRm"))
    .action((name, opts) => cmdIRRemoteRmServer(name, opts, program));
  irCmd.command("remote-rename <alias> [name]").description(t("cli.descIrRemoteRename"))
    .action((alias, name, opts) => cmdIRRemoteRenameServer(name, alias, opts, program));
}
