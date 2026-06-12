// `sesame devices` / `sesame device …` / history / battery / firmware / webapi。
// device 管理系 (Phase D + P3-1) を P5-3 で cli.js から抽出。
//
// `devices` (全デバイス dump → devices.json) はトップレベル先頭側に出すため別 register
// (registerDevicesCommand) にしている (help のコマンド順 = 登録順を変えない)。
// 依存方向: cli.js → device.js → pickers.js / lock-ops.js / ctx.js (循環なし)。

import { t } from "../i18n.js";
import { die } from "./errors.js";
import { withHub, out, mask, canPrompt } from "./ctx.js";
import { pickDeviceUUID } from "./pickers.js";
import { fmtCloudStatus, sanitizeStatus } from "./lock-ops.js";
import { promptText, confirm as confirmPrompt } from "../prompts.js";
import { writeSecretJson } from "../secure-fs.js";
import { normalizeUuid } from "../crypto.js";

/** @typedef {import("./ctx.js").Program} Program */
/** @typedef {import("./ctx.js").CmdOpts} CmdOpts */
/** @typedef {import("./ctx.js").CliError} CliError */
/** @typedef {import("../client.js").DeviceInfo} DeviceInfo */

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
 * `sesame device add [json]` — デバイスを company に追加 (P3-1, biz3ManageDevice/add)。
 * items は QR 由来のデバイスキーオブジェクト (配列または単体 JSON)。
 * 上限超過はサーバの "Limit Exceeded" がそのまま表示される (useManageDevice.js:28-30)。
 * @param {string|undefined} json
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdDeviceAdd(json, _opts, program) {
  if (!json) die(t("cli.deviceAddJsonRequired"), 2);
  /** @type {any} */
  let items;
  try { items = JSON.parse(/** @type {string} */ (json)); }
  catch (e) { die(t("cli.invalidJsonItems", { message: /** @type {CliError} */ (e).message }), 2); }
  if (!Array.isArray(items)) items = [items];
  await withHub(program, async (hub, { opts }) => {
    const resp = await hub.addDevices(items);
    out(opts.json, () => console.log(t("cli.okAddedDevices", { count: items.length })),
      { ok: true, count: items.length, response: resp });
  });
}

/**
 * `sesame device reorder <uuid...>` — 並び順更新 (P3-1, biz3ManageDevice/reorderDevices)。
 * 指定 UUID を先頭から並べ、未指定のデバイスは現在順のまま末尾に続ける
 * (vendor はデバイス一覧全体を並べ替えて送る — useManageDevice.js:270-285。rank は lib が採番)。
 * @param {string[]} uuids
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
async function cmdDeviceReorder(uuids, _opts, program) {
  if (!uuids || uuids.length === 0) die(t("cli.deviceReorderUuidsRequired"), 2);
  await withHub(program, async (hub, { opts }) => {
    const list = /** @type {DeviceInfo[]} */ (await hub.listDevices());
    /** @type {DeviceInfo[]} */
    const ordered = [];
    for (const u of uuids) {
      const d = list.find((x) => normalizeUuid(x.deviceUUID) === normalizeUuid(u));
      if (!d) { die(t("cli.deviceReorderUnknownUuid", { uuid: u }), 2); return; }
      ordered.push(d);
    }
    for (const d of list) if (!ordered.includes(d)) ordered.push(d);
    const data = await hub.reorderDevices(ordered);
    out(opts.json, () => {
      console.log(t("cli.okReorderedDevices", { count: ordered.length }));
      for (const d of ordered) console.log(`  ${d.deviceName || "(no name)"}\t${d.deviceUUID || ""}`);
    }, { ok: true, order: ordered.map((d) => d.deviceUUID), devices: data });
  });
}

/**
 * `sesame device notify [uuid]` — push 通知設定 (P3-1, notifyList / notifyManage)。
 * --on/--off 指定時は単機の切り替え (notifyManage)、無指定時は一覧 (notifyList)。
 * --token はモバイル push トークン (vendor は端末の FCM トークン — useManageDevice.js:287-318)。
 * @param {string|undefined} uuid
 * @param {{ token?: string, on?: boolean, off?: boolean }} options
 * @param {Program} program
 */
async function cmdDeviceNotify(uuid, options, program) {
  if (!options.token) die(t("cli.pushTokenRequired"), 2);
  if (options.on && options.off) die(t("cli.notifyOnOffExclusive"), 2);
  await withHub(program, async (hub, { opts }) => {
    const pushToken = /** @type {string} */ (options.token);
    if (options.on || options.off) {
      uuid = await pickDeviceUUID(program, hub, uuid, { message: t("cli.whichDeviceNotify") }) || uuid;
      if (!uuid) die(t("cli.deviceUuidRequired"), 2);
      const enablePush = options.on ? 1 : 0;
      const resp = await hub.switchDeviceNotify({ pushToken, deviceUUID: /** @type {string} */ (uuid), enablePush });
      out(opts.json, () => console.log(t("cli.okNotifySwitched", { uuid: /** @type {string} */ (uuid), state: options.on ? "on" : "off" })),
        { ok: true, deviceUUID: uuid, enablePush, response: resp });
      return;
    }
    // 一覧 (notifyList): uuid 指定ならその 1 台、無指定なら全デバイス。
    const list = /** @type {DeviceInfo[]} */ (await hub.listDevices());
    const target = uuid ? normalizeUuid(uuid) : null;
    const items = (target
      ? list.filter((d) => normalizeUuid(d.deviceUUID) === target)
      : list
    ).map((d) => ({ deviceUUID: d.deviceUUID, deviceModel: d.deviceModel }));
    const data = await hub.getDevicesNotifyStatus({ pushToken, items });
    out(opts.json, () => console.log(JSON.stringify(data, null, 2)), { notifyStatus: data });
  });
}

/**
 * `sesame device recharge [uuid] --on|--off` — 充電池モード切替 (P3-1, switchRecharge)。
 * @param {string|undefined} uuid
 * @param {{ on?: boolean, off?: boolean }} options
 * @param {Program} program
 */
async function cmdDeviceRecharge(uuid, options, program) {
  if (!!options.on === !!options.off) die(t("cli.rechargeOnOffRequired"), 2);
  await withHub(program, async (hub, { opts }) => {
    uuid = await pickDeviceUUID(program, hub, uuid, { message: t("cli.whichDeviceRecharge") }) || uuid;
    if (!uuid) die(t("cli.deviceUuidRequired"), 2);
    const isRechargeBattery = !!options.on;
    const resp = await hub.switchRechargeableBattery({ deviceUUID: /** @type {string} */ (uuid), isRechargeBattery });
    out(opts.json, () => console.log(t("cli.okRechargeSwitched", { uuid: /** @type {string} */ (uuid), state: isRechargeBattery ? "on" : "off" })),
      { ok: true, deviceUUID: uuid, isRechargeBattery, response: resp });
  });
}

/**
 * @param {string|undefined} deviceUUID
 * @param {{ delete?: string, pageSize?: string, lastKey?: string, all?: boolean }} options
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
    // --all (P3-7): vendor fetchAllHistory 相当の自動ページング
    // (res.length===pageSize で継続、lastKey=末尾 timestamp — DeviceHistory.js:37-74)。
    if (options.all) {
      if (options.lastKey != null) die(t("cli.historyAllLastKeyExclusive"), 2);
      const data = await hub.getAllDeviceHistory(deviceUUID, { pageSize: pageSize ?? 100 });
      out(opts.json, () => console.log(JSON.stringify(data, null, 2)), { data, count: data.length });
      return;
    }
    // --last-key (P3-7): 直前ページ末尾レコードの timestamp で次ページを取る。
    /** @type {number|null} */
    let lastKey = null;
    if (options.lastKey != null) {
      lastKey = Number(options.lastKey);
      if (!Number.isFinite(lastKey)) { die(t("cli.historyLastKeyInvalid", { value: options.lastKey }), 2); return; }
    }
    const data = await hub.getDeviceHistory([{ deviceUUID, lastKey }], /** @type {number} */ (pageSize));
    out(opts.json, () => console.log(JSON.stringify(data, null, 2)), { data });
  });
}

/**
 * @param {string|undefined} deviceUUID
 * @param {{ delete?: string, pageSize?: string, lastKey?: string }} options
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
    // --last-key (P3-7): 前回応答の lastEvaluatedKey (JSON) をそのまま渡して次ページを取る
    // (MobileBatteryChart.js:40-50。中身は DynamoDB の opaque カーソル)。
    /** @type {unknown} */
    let lastEvaluatedKey = null;
    if (options.lastKey != null) {
      try { lastEvaluatedKey = JSON.parse(options.lastKey); }
      catch (e) { die(t("cli.batteryLastKeyInvalid", { message: /** @type {CliError} */ (e).message }), 2); return; }
    }
    const data = /** @type {{ records?: Array<{ts?:number, light?:number, heavy?:number, lightPercentage?:number, heavyPercentage?:number}>, lastEvaluatedKey?: unknown }} */ (await hub.getDeviceBattery(deviceUUID, { pageSize, lastEvaluatedKey }));
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

/**
 * `sesame devices` (全デバイス dump → devices.json) を登録する。
 * help のコマンド順 = 登録順のため、device グループより前 (ping の直後) に呼ぶ。
 * @param {Program} program
 */
export function registerDevicesCommand(program) {
  program.command("devices").description(t("cli.descDevices"))
    .action((opts) => cmdDevices(opts, program));
}

/**
 * `sesame device …` グループ + history / battery / firmware / webapi を登録する (Phase D)。
 * @param {Program} program
 */
export function registerDeviceCommands(program) {
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
  // P3-1: biz3ManageDevice 残り op (add/reorder/notify/recharge)
  devCmd.command("add [json]").description(t("cli.descDeviceAdd"))
    .action((json, opts) => cmdDeviceAdd(json, opts, program));
  devCmd.command("reorder <uuids...>").description(t("cli.descDeviceReorder"))
    .action((uuids, opts) => cmdDeviceReorder(uuids, opts, program));
  devCmd.command("notify [uuid]").description(t("cli.descDeviceNotify"))
    .option("--token <pushToken>", t("cli.optPushToken"))
    .option("--on", t("cli.optNotifyOn"))
    .option("--off", t("cli.optNotifyOff"))
    .action((uuid, opts) => cmdDeviceNotify(uuid, opts, program));
  devCmd.command("recharge [uuid]").description(t("cli.descDeviceRecharge"))
    .option("--on", t("cli.optRechargeOn"))
    .option("--off", t("cli.optRechargeOff"))
    .action((uuid, opts) => cmdDeviceRecharge(uuid, opts, program));

  program.command("history [deviceUUID]").description(t("cli.descHistory"))
    .option("--page-size <n>", t("cli.optPageSize"))
    .option("--delete <timestamp>", t("cli.optHistoryDelete"))
    .option("--last-key <timestamp>", t("cli.optHistoryLastKey"))
    .option("--all", t("cli.optHistoryAll"))
    .action((uuid, opts) => cmdHistory(uuid, opts, program));
  program.command("battery [deviceUUID]").description(t("cli.descBattery"))
    .option("--page-size <n>", t("cli.optPageSize100"))
    .option("--delete <ts>", t("cli.optBatteryDelete"))
    .option("--last-key <json>", t("cli.optBatteryLastKey"))
    .action((uuid, opts) => cmdBattery(uuid, opts, program));
  program.command("firmware").description(t("cli.descFirmware"))
    .action((opts) => cmdFirmware(opts, program));
  program.command("webapi <func>").description(t("cli.descWebapi"))
    .option("--query <json>", t("cli.optWebapiQuery"))
    .option("--body <json>", t("cli.optWebapiBody"))
    .option("--api-key <id>", t("cli.optWebapiApiKey"))
    .action((func, opts) => cmdWebapi(func, opts, program));
}
