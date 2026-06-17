// `sesame ble …` コマンド群 — BLE 直結操作 (鍵不要の近接スキャン + 初期登録 +
// 生体/アクセス制御デバイスの登録済み一覧 + Bot2/Bot3 スクリプト読み出し +
// 汎用脱出口 invoke/os2-invoke + 高価値 op の専用コマンド ota/reset/wifi/position)。
//
// 本体ロジックは src/ble/* (SesameBle facade / BiometricCommands / Bot2Commands)。
// ここは commander への配線・対象解決・入出力整形のみを担う。
//
// 設計方針 (P4-1 で改訂):
//   - 「全機能を CLI・RPC・SDK のすべてから」のコンセプトに従い、BLE 書き込み系も CLI から
//     到達できる。任意 op は `ble invoke <device> <op>` (serve の ble.invoke RPC と同じ
//     ドット op パス / JSON 引数 revive / allowlist 照合 — 単一実装 serve/registry.invokePath)、
//     頻出の OTA / 工場リセット / Wi-Fi provisioning / 施解錠角設定は専用コマンドを持つ。
//     カード等の enroll 系は既存 `sesame access cards enroll` (cli/access.js) が担う。
//   - scan は鍵不要 (advertise のみ)。それ以外は config(locks) の secretKey で BLE login する。
//   - biometric の一覧は GET 要求 → デバイスが publish (START → NOTIFY×N → END) を返す設計なので、
//     registerDelegate で収集し END (または timeout) で確定する。
//
// 注意: BLE 生体/スクリプト系は公式 SDK から 1:1 移植・ユニットテスト済みだが**実機未検証**
// (README / docs/*/ble.md 参照)。`--debug` で生フレームを確認できる。
//
// ctx 契約 (cli.js makeCtx が供給): ctx.out / die / canPrompt / loadCtx。
// BLE は hub を使わないので withHub は通らず、config は ctx.loadCtx().configStore から引く。

import { t } from "@sesame-kit/core/i18n";
import {
  SesameBle, SesameOS2Ble, createBleTransport, capabilitiesForModel,
  BLE_RPC_ALLOWLIST, OS2_BLE_RPC_ALLOWLIST,
} from "@sesame-kit/core/ble";
// P1-8 (R2:SURF-26 + R2:SURF-39): 生体一覧収集ロジックを biometric.js へ移管済み。
// CLI はここから import して差し替える (collect ロジックの単一実装 = biometric.js)。
import { collectBiometricList, BIO_LIST } from "@sesame-kit/core/ble";
// ble.invoke RPC と「同じドット op パス・同じ JSON 引数 revive 規約・同じ allowlist 照合」を
// 共有する。P5-3: 実装を葉モジュール (ble/rpc-helpers.js) へ移設したため serve/registry.js
// ではなく直接 import する (serve 層全体 = rpc-params.generated.json 等を巻き込まない)。
import { invokePath, collectWifiScan, wifiViewOf, bleCommandAck } from "@sesame-kit/core/ble";
import { resolveRegisterTransport } from "@sesame-kit/core/devices";
// hex 検証/UUID 正規化は crypto.js に一本化。
import { hexToBuf, normalizeUuid } from "@sesame-kit/core/crypto";

/**
 * ble サブコマンドの commander options。値は string|undefined (boolean フラグは無い)。
 * @typedef {{
 *   secret?: string,
 *   model?: string,
 *   timeout?: string,
 *   index?: string,
 *   address?: string,
 *   productType?: string,
 *   save?: string,
 *   localServerAuth?: boolean,
 *   ak?: string,
 *   registerBaseUrl?: string,
 *   serverAuth?: boolean,
 *   args?: string,
 *   keyIndex?: string,
 *   ssmPublicKey?: string,
 *   yes?: boolean,
 *   companyId?: string,
 * }} BleOptions
 */

/**
 * resolveBleEntry の解決結果。
 * ssmPublicKey/keyIndex は OS2 デバイス用の鍵素材 (バックログ4): 優先順位は
 * 明示フラグ (--ssm-public-key / --key-index) > config locks エントリの保存値 > null。
 * @typedef {{ name: string, deviceUUID: string, secretKey: string, model: (string|null),
 *             ssmPublicKey: (string|null), keyIndex: (string|null) }} BleEntry
 */

/**
 * listNearby() / listNearbyDevices() の発見結果 1 件 (advertise だけから判る属性 + rssi)。
 * SesameBle.listNearby は Array<object> 宣言で型を落とすため、ここで実体形状にナロー化する。
 * @typedef {{
 *   deviceUUID: string,
 *   productType?: number,
 *   model?: (string|null),
 *   kind?: string,
 *   isRegistered?: boolean,
 *   advTagB1?: boolean,
 *   isConnectable?: boolean,
 *   rssi?: (number|null),
 *   localName?: (string|null),
 *   address?: (string|null),
 *   peripheral?: unknown,
 * }} BleDiscovery
 */

/**
 * BIO_LIST の 1 entry (getter 名 + collect 用 delegate コールバック名)。
 * P1-8: biometric.js で定義・export 済み。ここは型参照のみ。
 * @typedef {import("@sesame-kit/core/ble").BioSpec} BioSpec
 */

// BIO_LIST / collectBiometricList は biometric.js へ移管済み (P1-8 R2:SURF-26 + R2:SURF-39)。
// import は本ファイル冒頭で行う。re-export は後方互換のため維持する。
export { BIO_LIST, collectBiometricList } from "@sesame-kit/core/ble";

// 生体モード取得メソッド (card/passcode/finger/face/palm → *ModeGet)。応答 1 値の単純 request。
const BIO_MODE = {
  card: "cardModeGet",
  passcode: "passcodeModeGet",
  finger: "fingerPrintModeGet",
  face: "faceModeGet",
  palm: "palmModeGet",
};

/**
 * @param {import("commander").Command} program
 * @param {import("../cli.js").CliCtx} ctx cli.js makeCtx() が供給する共有コンテキスト
 */
export function registerBleCommands(program, ctx) {
  const ble = program.command("ble").description(t("ble.cli.cmd.desc"));

  // 接続が要るサブコマンド共通の対象指定オプション。
  /** @param {import("commander").Command} cmd */
  const withTargetOpts = (cmd) =>
    cmd
      .option("--secret <hex>", t("ble.cli.opt.secret"))
      .option("--model <model>", t("ble.cli.opt.model"))
      .option("--timeout <ms>", t("ble.cli.opt.timeout"))
      .option("--server-auth", t("ble.cli.opt.serverAuth"))
      .option("--register-base-url <url>", t("ble.cli.opt.registerBaseUrl"));

  // ---- ble scan ----
  // 近接 SESAME を鍵無しで列挙 (listNearbyDevices)。登録済み/未登録・機種・RSSI 等を出す。
  ble
    .command("scan")
    .description(t("ble.cli.scan.desc"))
    .option("--timeout <ms>", t("ble.cli.opt.scanTimeout"), "5000")
    .action((options) => cmdScan(ctx, options));

  // ---- ble register / os2-register ----
  // 工場出荷デバイスを直接 BLE 登録する。OS3 は secretKey を得たらそのまま config 保存も可能。
  ble
    .command("register <deviceUUID>")
    .description(t("ble.cli.register.desc"))
    .option("--address <address>", t("ble.cli.opt.address"))
    .option("--model <model>", t("ble.cli.opt.model"))
    .option("--product-type <type>", t("ble.cli.opt.productType"))
    .option("--timeout <ms>", t("ble.cli.opt.scanTimeout"), "8000")
    .option("--save <name>", t("ble.cli.register.opt.save"))
    .option("--register-base-url <url>", t("ble.cli.opt.registerBaseUrl"))
    .action((deviceUUID, options) => cmdRegister(ctx, deviceUUID, options));

  ble
    .command("os2-register <deviceUUID>")
    .description(t("ble.cli.os2Register.desc"))
    .option("--address <address>", t("ble.cli.opt.address"))
    .option("--model <model>", t("ble.cli.opt.model"))
    .option("--product-type <type>", t("ble.cli.opt.productType"))
    .option("--timeout <ms>", t("ble.cli.opt.scanTimeout"), "8000")
    .option("--ak <hex>", t("ble.cli.os2Register.opt.ak"))
    .option("--no-local-server-auth", t("ble.cli.os2Register.opt.noLocalServerAuth"))
    .action((deviceUUID, options) => cmdOS2Register(ctx, deviceUUID, options));

  // ---- ble cards|passcodes|fingers|faces|palms <device> ----
  // 生体/アクセス制御デバイスの登録済み一覧を BLE 経由で取得する (読み取り専用)。
  const LIST_CMDS = [
    ["cards", "card"], ["passcodes", "passcode"], ["fingers", "finger"], ["faces", "face"], ["palms", "palm"],
  ];
  for (const [cmdName, type] of LIST_CMDS) {
    withTargetOpts(
      ble.command(`${cmdName} <device>`).description(t(`ble.cli.${cmdName}.desc`)),
    ).action((device, options) => cmdBiometricList(ctx, type, device, options));
  }

  // ---- ble mode <device> <type> ----
  // 生体登録モードの現在値を取得 (card/passcode/finger/face/palm)。
  withTargetOpts(
    ble.command("mode <device> <type>").description(t("ble.cli.mode.desc")),
  ).action((device, type, options) => cmdBiometricMode(ctx, device, type, options));

  // ---- ble script <device> ----
  // Bot2/Bot3 のスクリプト一覧 + 現在スクリプトを取得 (読み取り専用)。
  withTargetOpts(
    ble.command("script <device>").description(t("ble.cli.script.desc")),
  )
    .option("--index <n>", t("ble.cli.script.opt.index"))
    .action((device, options) => cmdScript(ctx, device, options));

  // ---- ble script-run <device> <index> ---- (台本を番号指定で BLE 実行: click(170+index))
  withTargetOpts(
    ble.command("script-run <device> <index>").description(t("ble.cli.scriptRun.desc")),
  ).action((device, index, options) => cmdScriptRun(ctx, device, index, options));

  // ---- ble script-select <device> <index> ---- (アクティブ台本を切り替え: SCRIPT_SELECT 94)
  withTargetOpts(
    ble.command("script-select <device> <index>").description(t("ble.cli.scriptSelect.desc")),
  ).action((device, index, options) => cmdScriptSelect(ctx, device, index, options));

  // ---- ble script-write <device> <index> --json <{name,actions}> ---- (台本の書き込み: EDIT_SCRIPT 181)
  withTargetOpts(
    ble.command("script-write <device> <index>").description(t("ble.cli.scriptWrite.desc")),
  )
    .option("--json <script>", t("ble.cli.scriptWrite.opt.json"))
    .action((device, index, options) => cmdScriptWrite(ctx, device, index, options));

  // ---- ble invoke <device> <op> [--args <json>] ----
  // P4-1 段階1: 汎用脱出口。serve の ble.invoke RPC と同じドット op パス / JSON 引数 revive /
  // allowlist (BLE_RPC_ALLOWLIST) でファサードを直接叩く (デーモン不要)。
  withTargetOpts(
    ble.command("invoke <device> <op>").description(t("ble.cli.invoke.desc")),
  )
    .option("--args <json>", t("ble.cli.invoke.opt.args"))
    .option("--address <address>", t("ble.cli.opt.address"))
    .action((device, op, options) => cmdInvoke(ctx, device, op, options));

  // ---- ble os2-invoke <device> <op> [--args <json>] ----
  // OS2 (SESAME2/3/4・初代 Bot/Bike) の汎用脱出口。ble.os2.invoke RPC と対称。
  // OS2 login は ECDH のため keyIndex / ssmPublicKey が必要 (os2-register の戻り値)。
  ble
    .command("os2-invoke <device> <op>")
    .description(t("ble.cli.os2Invoke.desc"))
    .option("--args <json>", t("ble.cli.invoke.opt.args"))
    .option("--secret <hex>", t("ble.cli.opt.secret"))
    .option("--model <model>", t("ble.cli.opt.model"))
    .option("--key-index <hex>", t("ble.cli.os2Invoke.opt.keyIndex"))
    .option("--ssm-public-key <hex>", t("ble.cli.os2Invoke.opt.ssmPublicKey"))
    .option("--address <address>", t("ble.cli.opt.address"))
    .option("--timeout <ms>", t("ble.cli.opt.scanTimeout"))
    .action((device, op, options) => cmdOS2Invoke(ctx, device, op, options));

  // ---- ble ota <device> ---- (P4-1 段階2: updateFirmware)
  withTargetOpts(
    ble.command("ota <device>").description(t("ble.cli.ota.desc")),
  ).action((device, options) => cmdOta(ctx, device, options));

  // ---- ble reset <device> ---- (P4-1 段階2: OS3 工場出荷リセット。破壊的なので確認を取る)
  withTargetOpts(
    ble.command("reset <device>").description(t("ble.cli.reset.desc")),
  )
    .option("--yes", t("ble.cli.reset.opt.yes"))
    .action((device, options) => cmdReset(ctx, device, options));

  // ---- ble wifi <device> scan|ssid <value>|password <value>|connect ----
  // (P4-1 段階2: WM2/Hub3 の Wi-Fi プロビジョニング。kind は model から自動判別)
  withTargetOpts(
    ble.command("wifi <device> <action> [value]").description(t("ble.cli.wifi.desc")),
  )
    .option("--company-id <id>", t("ble.cli.wifi.opt.companyId"))
    .action((device, action, value, options) => cmdWifi(ctx, device, action, value, options));

  // ---- ble position <device> <lock> <unlock> ---- (P4-1 段階2: configureLockPosition)
  withTargetOpts(
    ble.command("position <device> <lock> <unlock>").description(t("ble.cli.position.desc")),
  ).action((device, lockPos, unlockPos, options) => cmdPosition(ctx, device, lockPos, unlockPos, options));
}

// ---------- コマンド実体 ----------

/**
 * @param {import("../cli.js").CliCtx} ctx
 * @param {BleOptions} options
 */
async function cmdScan(ctx, options) {
  const { opts } = ctx.loadCtx();
  const timeoutMs = Number(options.timeout) || 5000;
  // listNearby は Array<object> を返す宣言。実体は BleDiscovery 形状なのでナロー化する。
  const found = /** @type {BleDiscovery[]} */ (
    await SesameBle.listNearby({ timeoutMs, debug: !!opts.debug })
  );
  ctx.out(opts.json, () => {
    if (!found.length) { console.log(t("ble.cli.scan.none")); return; }
    console.log(t("ble.cli.scan.header", { count: found.length }));
    for (const d of found) {
      const reg = d.isRegistered ? "registered" : "unregistered";
      const rssi = d.rssi != null ? `${d.rssi}dBm` : "?";
      console.log(`  ${d.deviceUUID}\t${d.model || "?"}\t${reg}\t${rssi}`);
    }
  }, { ok: true, count: found.length, devices: found.map(scrubDiscovery) });
}

/**
 * @param {import("../cli.js").CliCtx} ctx
 * @param {string} deviceUUID
 * @param {BleOptions} options
 */
async function cmdRegister(ctx, deviceUUID, options) {
  const { opts, configStore, tokenStore } = ctx.loadCtx();
  const timeoutMs = Number(options.timeout) || 8000;
  const model = options.model || null;
  const registerTransport = resolveCliRegisterTransport({ configStore, tokenStore, options });
  // model は SesameBle コンストラクタへ ...ctorOpts で透過する (公開 opts 型に未掲載のため型のみ補完)。
  const result = await SesameBle.registerOnce(/** @type {Parameters<typeof SesameBle.registerOnce>[0] & {model?:string|null}} */ ({
    deviceUUID,
    address: options.address,
    model,
    productType: options.productType || model || undefined,
    scanTimeoutMs: timeoutMs,
    debug: !!opts.debug,
    registerTransport,
  }));
  const saveName = options.save || null;
  if (saveName) {
    configStore.addLock(saveName, {
      deviceUUID: result.deviceUUID,
      secretKey: result.secretKey,
      model: model || String(result.productType || "") || null,
      alias: saveName,
    });
  }
  ctx.out(opts.json, () => {
    console.log(t(saveName ? "ble.cli.register.saved" : "ble.cli.register.done", {
      deviceUUID: result.deviceUUID,
      name: saveName || "",
    }));
    console.log(`secretKey=${result.secretKey}`);
  }, { ok: true, saved: !!saveName, name: saveName, result });
}

/**
 * @param {import("../cli.js").CliCtx} ctx
 * @param {string} deviceUUID
 * @param {BleOptions} options
 */
async function cmdOS2Register(ctx, deviceUUID, options) {
  const { opts } = ctx.loadCtx();
  const timeoutMs = Number(options.timeout) || 8000;
  const model = options.model || null;
  const transport = createBleTransport({
    deviceUUID,
    address: options.address,
    scanTimeoutMs: timeoutMs,
    debug: !!opts.debug,
  });
  const result = /** @type {{deviceUUID?:string, secretKey?:string, ownerKey?:string, sesamePublicKey?:string}} */ (await SesameOS2Ble.registerOnce({
    transport,
    deviceUUID,
    model,
    productType: options.productType || model || undefined,
    localServerAuth: options.localServerAuth !== false,
    debug: !!opts.debug,
    ak: options.ak ? parseHexOption(ctx, options.ak, "ak") : undefined,
  }));
  ctx.out(opts.json, () => {
    console.log(t("ble.cli.os2Register.done", { deviceUUID: result.deviceUUID ?? "" }));
    console.log(`secretKey=${result.secretKey}`);
    console.log(`ownerKey=${result.ownerKey}`);
    console.log(`sesamePublicKey=${result.sesamePublicKey}`);
    // バックログ4: 鍵素材を config に保存すれば以後の os2-invoke で --ssm-public-key が不要になる。
    console.log(t("ble.cli.os2Register.saveHint", {
      deviceUUID: result.deviceUUID ?? "",
      secretKey: result.secretKey ?? "",
      sesamePublicKey: result.sesamePublicKey ?? "",
    }));
  }, { ok: true, result });
}

/**
 * @param {import("../cli.js").CliCtx} ctx
 * @param {string} type  BIO_LIST のキー (card/passcode/finger/face/palm)
 * @param {string} device
 * @param {BleOptions} options
 */
async function cmdBiometricList(ctx, type, device, options) {
  const spec = /** @type {BioSpec} */ (BIO_LIST[/** @type {keyof typeof BIO_LIST} */ (type)]);
  const { opts, configStore, tokenStore } = ctx.loadCtx();
  const entry = resolveBleEntry(ctx, device, options);
  if (!entry) return;
  const caps = capabilitiesForModel(entry.model);
  const timeoutMs = Number(options.timeout) || 8000;
  const serverAuth = resolveCliServerAuth({ configStore, tokenStore, options });

  await SesameBle.use(
    { secretKey: entry.secretKey, deviceUUID: entry.deviceUUID, model: entry.model, debug: !!opts.debug, ...serverAuth },
    async (dev) => {
      const cmds = biometricView(dev, type, caps); // 非対応機種はここで明示エラー
      const records = await collectBiometricList(cmds, spec, timeoutMs);
      ctx.out(opts.json, () => {
        console.log(t("ble.cli.list.header", { type, count: records.length, name: entry.name }));
        for (const r of records) console.log(`  ${formatRecord(r)}`);
      }, { ok: true, type, name: entry.name, deviceUUID: entry.deviceUUID, count: records.length, records });
    },
  );
}

/**
 * @param {import("../cli.js").CliCtx} ctx
 * @param {string} device
 * @param {string} type
 * @param {BleOptions} options
 */
async function cmdBiometricMode(ctx, device, type, options) {
  const method = BIO_MODE[/** @type {keyof typeof BIO_MODE} */ (type)];
  if (!method) { ctx.die(t("ble.cli.mode.badType", { type, types: Object.keys(BIO_MODE).join("/") }), 2); return; }
  const { opts, configStore, tokenStore } = ctx.loadCtx();
  const entry = resolveBleEntry(ctx, device, options);
  if (!entry) return;
  const caps = capabilitiesForModel(entry.model);
  const serverAuth = resolveCliServerAuth({ configStore, tokenStore, options });

  await SesameBle.use(
    { secretKey: entry.secretKey, deviceUUID: entry.deviceUUID, model: entry.model, debug: !!opts.debug, ...serverAuth },
    async (dev) => {
      const cmds = biometricView(dev, type, caps);
      const mode = await cmds[method]();
      ctx.out(opts.json, () => console.log(t("ble.cli.mode.result", { type, mode, name: entry.name })),
        { ok: true, type, mode, name: entry.name, deviceUUID: entry.deviceUUID });
    },
  );
}

/**
 * @param {import("../cli.js").CliCtx} ctx
 * @param {string} device
 * @param {BleOptions} options
 */
async function cmdScript(ctx, device, options) {
  const { opts, configStore, tokenStore } = ctx.loadCtx();
  const entry = resolveBleEntry(ctx, device, options);
  if (!entry) return;
  const caps = capabilitiesForModel(entry.model);
  if (!caps.script) { ctx.die(t("ble.cli.script.notSupported", { name: entry.name, model: entry.model || "?" }), 2); return; }
  const index = options.index != null ? Number(options.index) : null;
  const serverAuth = resolveCliServerAuth({ configStore, tokenStore, options });

  await SesameBle.use(
    { secretKey: entry.secretKey, deviceUUID: entry.deviceUUID, model: entry.model, debug: !!opts.debug, ...serverAuth },
    async (dev) => {
      const list = await dev.script.getScriptNameList();
      const current = await dev.script.getCurrentScript(index).catch(() => null);
      const names = (list.events || []).map((e, i) => ({ index: i, name: bufToText(e.name) }));
      ctx.out(opts.json, () => {
        console.log(t("ble.cli.script.header", { name: entry.name, curIdx: list.curIdx }));
        for (const n of names) console.log(`  [${n.index}] ${n.name}${n.index === list.curIdx ? " *" : ""}`);
        if (current) console.log(t("ble.cli.script.current", { actions: (current.actions || []).length }));
      }, { ok: true, name: entry.name, deviceUUID: entry.deviceUUID, curIdx: list.curIdx, scripts: names, current });
    },
  );
}

/**
 * Bot2/Bot3 用の script ファサードを解決して fn(dev.script, dev) を実行する共通ヘルパ。
 * @param {import("../cli.js").CliCtx} ctx
 * @param {string} device
 * @param {BleOptions} options
 * @param {(script: import("@sesame-kit/core/ble").Bot2Commands, dev: any) => Promise<unknown>} fn
 * @returns {Promise<void>}
 */
async function withScript(ctx, device, options, fn) {
  const { opts, configStore, tokenStore } = ctx.loadCtx();
  const entry = resolveBleEntry(ctx, device, options);
  if (!entry) return;
  const caps = capabilitiesForModel(entry.model);
  if (!caps.script) { ctx.die(t("ble.cli.script.notSupported", { name: entry.name, model: entry.model || "?" }), 2); return; }
  const serverAuth = resolveCliServerAuth({ configStore, tokenStore, options });
  await SesameBle.use(
    { secretKey: entry.secretKey, deviceUUID: entry.deviceUUID, model: entry.model, debug: !!opts.debug, ...serverAuth },
    (dev) => fn(dev.script, dev),
  );
}

/**
 * 0..9 の台本 index をパースする (不正は exit 2)。
 * @param {import("../cli.js").CliCtx} ctx @param {string} raw @returns {number|null}
 */
function parseScriptIndex(ctx, raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 9) { ctx.die(t("ble.cli.scriptRun.badIndex", { index: String(raw) }), 2); return null; }
  return n;
}

/**
 * `ble script-run <device> <index>`: 台本を番号指定で実行 (click(170+index), CHSesameBot2Device.kt:73-97)。
 * @param {import("../cli.js").CliCtx} ctx @param {string} device @param {string} index @param {BleOptions} options
 */
async function cmdScriptRun(ctx, device, index, options) {
  const idx = parseScriptIndex(ctx, index);
  if (idx == null) return;
  const { opts } = ctx.loadCtx();
  await withScript(ctx, device, options, async (script) => {
    const r = await script.click(idx);
    ctx.out(opts.json, () => console.log(t("ble.cli.scriptRun.done", { index: idx })),
      { ok: true, scriptIndex: idx, resultCode: r?.resultCode ?? null });
  });
}

/**
 * `ble script-select <device> <index>`: アクティブ台本を切り替え (SCRIPT_SELECT 94)。
 * @param {import("../cli.js").CliCtx} ctx @param {string} device @param {string} index @param {BleOptions} options
 */
async function cmdScriptSelect(ctx, device, index, options) {
  const idx = parseScriptIndex(ctx, index);
  if (idx == null) return;
  const { opts } = ctx.loadCtx();
  await withScript(ctx, device, options, async (script) => {
    const r = await script.selectScript(idx);
    ctx.out(opts.json, () => console.log(t("ble.cli.scriptSelect.done", { index: idx })),
      { ok: true, scriptIndex: idx, resultCode: r?.resultCode ?? null });
  });
}

/**
 * `ble script-write <device> <index> --json '{"name":..,"actions":[{action,time},..]}'`:
 * 台本を書き込む (EDIT_SCRIPT 181, CHSesameBot2Device.kt:99-110)。
 * @param {import("../cli.js").CliCtx} ctx @param {string} device @param {string} index @param {BleOptions & {json?:string}} options
 */
async function cmdScriptWrite(ctx, device, index, options) {
  const idx = parseScriptIndex(ctx, index);
  if (idx == null) return;
  if (!options.json) { ctx.die(t("ble.cli.scriptWrite.jsonRequired"), 2); return; }
  const script = ctx.parseJson(options.json, "ble script-write --json");
  const { opts } = ctx.loadCtx();
  await withScript(ctx, device, options, async (s) => {
    const r = await s.sendClickScript(idx, script);
    ctx.out(opts.json, () => console.log(t("ble.cli.scriptWrite.done", { index: idx })),
      { ok: true, scriptIndex: idx, resultCode: r?.resultCode ?? null });
  });
}

/**
 * P4-1 段階1: 汎用脱出口 `ble invoke <device> <op>`。
 * serve の ble.invoke RPC と同一実装 (registry.invokePath + BLE_RPC_ALLOWLIST) を直接呼ぶ。
 * @param {import("../cli.js").CliCtx} ctx
 * @param {string} device
 * @param {string} op ドット区切り op パス (例 "lock" / "script.getScriptNameList")
 * @param {BleOptions} options
 */
async function cmdInvoke(ctx, device, op, options) {
  const entry = resolveBleEntry(ctx, device, options);
  if (!entry) return;
  const args = parseInvokeArgs(ctx, options.args);
  await useBleDevice(ctx, entry, options, async (dev, opts) => {
    const result = await invokePath(dev, op, args, BLE_RPC_ALLOWLIST);
    ctx.out(opts.json, () => {
      console.log(t("ble.cli.invoke.done", { op, name: entry.name }));
      if (result !== undefined) console.log(JSON.stringify(result, null, 2));
    }, { ok: true, op, name: entry.name, deviceUUID: entry.deviceUUID, result: result === undefined ? null : result });
  });
}

/**
 * OS2 用の汎用脱出口 `ble os2-invoke <device> <op>` (ble.os2.invoke RPC と対称)。
 * @param {import("../cli.js").CliCtx} ctx
 * @param {string} device
 * @param {string} op
 * @param {BleOptions} options
 */
async function cmdOS2Invoke(ctx, device, op, options) {
  const { opts } = ctx.loadCtx();
  const entry = resolveBleEntry(ctx, device, options);
  if (!entry) return;
  // OS2 login は ECDH 必須 (sesame2KeyData.sesame2PublicKey)。鍵素材はバックログ4で
  // config locks にも保存できる (locks add --ssm-public-key)。resolveBleEntry が
  // 「明示フラグ > config 保存値」の優先順位で解決済み。どちらにも無ければ明示要求する。
  if (!entry.ssmPublicKey) {
    ctx.die(t("ble.cli.os2Invoke.needSsmPublicKey"), 2);
    return;
  }
  const args = parseInvokeArgs(ctx, options.args);
  const transport = createBleTransport({
    deviceUUID: entry.deviceUUID,
    address: options.address,
    scanTimeoutMs: Number(options.timeout) || 8000,
    debug: !!opts.debug,
  });
  const result = await SesameOS2Ble.use({
    transport,
    deviceUUID: entry.deviceUUID,
    secretKey: entry.secretKey,
    // 省略時 (フラグも config も無し) は undefined → session 既定の "0000" (CHSesame2Device.kt:465)
    keyIndex: entry.keyIndex ?? undefined,
    ssmPublicKey: entry.ssmPublicKey,
    model: entry.model,
    debug: !!opts.debug,
  }, (dev) => invokePath(/** @type {Record<string, any>} */ (/** @type {unknown} */ (dev)), op, args, OS2_BLE_RPC_ALLOWLIST));
  ctx.out(opts.json, () => {
    console.log(t("ble.cli.invoke.done", { op, name: entry.name }));
    if (result !== undefined) console.log(JSON.stringify(result, null, 2));
  }, { ok: true, op, name: entry.name, deviceUUID: entry.deviceUUID, result: result === undefined ? null : result });
}

/**
 * `ble ota <device>` — BLE ファームウェア更新 (updateFirmware)。経路は model で分岐
 * (WM2=OPEN_OTA_SERVER / Hub3=MOVE_TO / OS3 ロック系=SDK 同様コマンド無送信、P1-7)。
 * @param {import("../cli.js").CliCtx} ctx
 * @param {string} device
 * @param {BleOptions} options
 */
async function cmdOta(ctx, device, options) {
  const entry = resolveBleEntry(ctx, device, options);
  if (!entry) return;
  const timeoutMs = Number(options.timeout) || undefined;
  await useBleDevice(ctx, entry, options, async (dev, opts) => {
    const r = /** @type {{resultCode?:number}} */ (
      await Promise.resolve(dev.updateFirmware({ timeoutMs }))
    );
    const sent = typeof r?.resultCode === "number";
    const ack = sent ? bleCommandAck(/** @type {{resultCode:number}} */ (r)) : { resultCode: null, resultName: null };
    ctx.out(opts.json, () => {
      console.log(t(sent ? "ble.cli.ota.sent" : "ble.cli.ota.noop", {
        name: entry.name,
        resultName: ack.resultName ?? "",
      }));
    }, { ok: true, name: entry.name, deviceUUID: entry.deviceUUID, commandSent: sent, ...ack });
  });
}

/**
 * `ble reset <device>` — OS3 デバイスを工場出荷状態へ戻す (破壊的: 鍵が無効化される)。
 * 非対話 (--json / パイプ) では --yes を必須にする。
 * @param {import("../cli.js").CliCtx} ctx
 * @param {string} device
 * @param {BleOptions} options
 */
async function cmdReset(ctx, device, options) {
  const entry = resolveBleEntry(ctx, device, options);
  if (!entry) return;
  if (!options.yes) {
    if (!ctx.canPrompt()) { ctx.die(t("ble.cli.reset.needYes"), 2); return; }
    const ok = await ctx.prompts.confirm(t("ble.cli.reset.prompt", { name: entry.name }), { defaultYes: false });
    // 正常な中断: die ではなく plain log + return (org employee confirm と同じ流儀)。
    if (!ok) { console.error(t("ble.cli.reset.aborted")); return; }
  }
  await useBleDevice(ctx, entry, options, async (dev, opts) => {
    const ack = bleCommandAck(await dev.reset());
    ctx.out(opts.json, () => console.log(t("ble.cli.reset.done", { name: entry.name })),
      { ok: true, name: entry.name, deviceUUID: entry.deviceUUID, ...ack });
  });
}

// `ble wifi` の action 語彙 (scan / ssid <value> / password <value> / connect)。
const WIFI_ACTIONS = ["scan", "ssid", "password", "connect"];

/**
 * `ble wifi <device> <action> [value]` — WM2/Hub3 の Wi-Fi プロビジョニング。
 * WM2 か Hub3 かは model の kind から自動判別する (wifiViewOf。GATT も自動切替)。
 * @param {import("../cli.js").CliCtx} ctx
 * @param {string} device
 * @param {string} action scan|ssid|password|connect
 * @param {string|undefined} value ssid/password の設定値
 * @param {BleOptions} options
 */
async function cmdWifi(ctx, device, action, value, options) {
  if (!WIFI_ACTIONS.includes(action)) {
    ctx.die(t("ble.cli.wifi.badAction", { action, actions: WIFI_ACTIONS.join("/") }), 2);
    return;
  }
  if ((action === "ssid" || action === "password") && value == null) {
    ctx.die(t("ble.cli.wifi.valueRequired", { action }), 2);
    return;
  }
  const entry = resolveBleEntry(ctx, device, options);
  if (!entry) return;
  // 接続前に能力で弾く (WM2 は専用 GATT のため model 不明では接続もできない)。
  const caps = capabilitiesForModel(entry.model);
  if (!caps.wifiProvisioning && !caps.hubProvisioning) {
    ctx.die(t("ble.cli.wifi.notSupported", { name: entry.name, model: entry.model || "?" }), 2);
    return;
  }
  if (action === "connect" && !caps.wifiProvisioning) {
    // Hub3 に connect コマンドは存在しない (CHHub3Device.kt は SSID/Password 設定のみ)。
    ctx.die(t("ble.cli.wifi.connectWm2Only"), 2);
    return;
  }
  await useBleDevice(ctx, entry, options, async (dev, opts) => {
    const { view } = wifiViewOf(dev, { companyId: options.companyId });
    if (action === "scan") {
      const collectMs = Number(options.timeout) || 8000;
      const { ssids } = await collectWifiScan(view, { collectMs });
      ctx.out(opts.json, () => {
        if (!ssids.length) { console.log(t("ble.cli.wifi.scanNone")); return; }
        console.log(t("ble.cli.wifi.scanHeader", { count: ssids.length, name: entry.name }));
        for (const s of ssids) console.log(`  ${s.ssid}\t${s.rssi}dBm`);
      }, { ok: true, name: entry.name, deviceUUID: entry.deviceUUID, ssids });
      return;
    }
    const ack = bleCommandAck(
      action === "ssid" ? await view.setWifiSSID(value)
        : action === "password" ? await view.setWifiPassword(value)
        : await view.connectWifi(),
    );
    ctx.out(opts.json, () => console.log(t("ble.cli.wifi.done", { action, name: entry.name })),
      { ok: true, action, name: entry.name, deviceUUID: entry.deviceUUID, ...ack });
  });
}

/**
 * `ble position <device> <lock> <unlock>` — 施錠/解錠角を設定 (configureLockPosition)。
 * OS3 Sesame5/6 系ロック専用 (ファサードの _assertLock5 が機種を弾く)。
 * @param {import("../cli.js").CliCtx} ctx
 * @param {string} device
 * @param {string} lockPos 施錠角 (整数 -32768..32767)
 * @param {string} unlockPos 解錠角 (整数 -32768..32767)
 * @param {BleOptions} options
 */
async function cmdPosition(ctx, device, lockPos, unlockPos, options) {
  const lock = Number(lockPos);
  const unlock = Number(unlockPos);
  if (!Number.isInteger(lock) || !Number.isInteger(unlock)) {
    ctx.die(t("ble.cli.position.badNumber"), 2);
    return;
  }
  const entry = resolveBleEntry(ctx, device, options);
  if (!entry) return;
  await useBleDevice(ctx, entry, options, async (dev, opts) => {
    const ack = bleCommandAck(await dev.configureLockPosition(lock, unlock));
    ctx.out(opts.json, () => console.log(t("ble.cli.position.done", { name: entry.name, lock, unlock })),
      { ok: true, name: entry.name, deviceUUID: entry.deviceUUID, lockPosition: lock, unlockPosition: unlock, ...ack });
  });
}

// ---------- ヘルパ ----------

/**
 * 解決済み entry で SesameBle を構築し connect → fn → close する (新コマンド共通の足場)。
 * ctx.makeBle 経由で構築するためテストで fake BLE に差し替え可能 (access enroll と同じ seam)。
 * @param {import("../cli.js").CliCtx} ctx
 * @param {BleEntry} entry
 * @param {BleOptions} options
 * @param {(dev: import("@sesame-kit/core/ble").SesameBle, opts: Record<string, any>) => Promise<unknown>} fn
 */
async function useBleDevice(ctx, entry, options, fn) {
  const { opts, configStore, tokenStore } = ctx.loadCtx();
  const serverAuth = resolveCliServerAuth({ configStore, tokenStore, options });
  const dev = ctx.makeBle({
    secretKey: entry.secretKey,
    deviceUUID: entry.deviceUUID,
    model: entry.model,
    debug: !!opts.debug,
    ...serverAuth,
  });
  await dev.connect();
  try { return await fn(dev, opts); }
  finally { await dev.close().catch(() => {}); }
}

/**
 * --args <json> を ble.invoke RPC の args と同じ規約で解釈する (省略 = []、JSON 配列推奨。
 * 非配列は invokePath 側で単一引数として包む。Buffer は {"$buffer":"00ff"} / {type:"Buffer",data:[…]}
 * を invokePath の revive が復元する)。parse 失敗は die(…, 2)。
 * @param {import("../cli.js").CliCtx} ctx
 * @param {string|undefined} raw
 * @returns {unknown[]}
 */
function parseInvokeArgs(ctx, raw) {
  if (raw === undefined) return [];
  return ctx.parseJson(raw, '["arg1", {"$buffer":"00ff"}]');
}

/**
 * @param {{configStore: import("@sesame-kit/core/config").ConfigStore,
 *          tokenStore: import("@sesame-kit/core/tokens").FileTokenStore,
 *          options: BleOptions, required?: boolean}} params
 * @returns {import("@sesame-kit/core/devices").RegisterTransport|undefined}
 */
function resolveCliRegisterTransport({ configStore, tokenStore, options, required = false }) {
  return resolveRegisterTransport({
    baseUrl: options.registerBaseUrl,
    config: configStore.load(),
    tokenStore,
    required,
  });
}

/**
 * @param {{configStore: import("@sesame-kit/core/config").ConfigStore,
 *          tokenStore: import("@sesame-kit/core/tokens").FileTokenStore,
 *          options: BleOptions}} params
 * @returns {{needAuthFromServer?: true, registerTransport?: import("@sesame-kit/core/devices").RegisterTransport}}
 */
function resolveCliServerAuth({ configStore, tokenStore, options }) {
  const needAuthFromServer = !!(options.serverAuth || options.registerBaseUrl);
  if (!needAuthFromServer) return {};
  return {
    needAuthFromServer: true,
    registerTransport: resolveCliRegisterTransport({ configStore, tokenStore, options, required: true }),
  };
}

/**
 * `<device>` (config の lock 名 or deviceUUID) を BLE entry へ解決する。
 * --secret / --model で補完・上書きできる (config に無い生体デバイスを直接指定する用)。
 * @param {import("../cli.js").CliCtx} ctx
 * @param {string} device
 * @param {BleOptions} options
 * @returns {BleEntry|null}
 */
function resolveBleEntry(ctx, device, options) {
  const cfg = ctx.loadCtx().configStore.load();
  const locks = cfg.locks || {};

  // 1) config の lock 名 (完全一致) か deviceUUID で引く。部分一致は実操作の誤爆を招くため使わない。
  let name = device;
  let rec = locks[device];
  if (!rec) {
    const byUuid = Object.entries(locks).find(([, l]) => normalizeUuid(l.deviceUUID) === normalizeUuid(device));
    if (byUuid) { name = byUuid[0]; rec = byUuid[1]; }
  }

  // 2) config に無くても、UUID らしき指定 + --secret があれば直接 entry を組む。
  const deviceUUID = rec?.deviceUUID || device;
  const secretKey = options.secret || rec?.secretKey;
  const model = options.model || rec?.model || null;
  // OS2 鍵素材 (バックログ4): 明示フラグ > config 保存値 (locks add --ssm-public-key/--key-index)。
  const ssmPublicKey = options.ssmPublicKey || rec?.ssmPublicKey || null;
  const keyIndex = options.keyIndex || rec?.keyIndex || null;
  if (!secretKey) {
    ctx.die(t("ble.cli.resolve.noSecret", { device }), 2);
    return null;
  }
  return { name: rec ? name : deviceUUID, deviceUUID, secretKey, model, ssmPublicKey, keyIndex };
}

/**
 * type に応じて biometric / fingerPrint ビューを選ぶ (Bike3 は fingerPrint のみ)。
 * 返り値は getter/registerDelegate を文字列キーで引く動的アクセス面のため
 * Record<string, Function> として扱う (biometric.js / fingerPrint の共通形)。
 * @param {import("@sesame-kit/core/ble").SesameBle} dev
 * @param {string} type
 * @param {ReturnType<typeof capabilitiesForModel>} caps
 * @returns {Record<string, Function>}
 */
function biometricView(dev, type, caps) {
  if (type === "finger" && caps.fingerprint && !caps.biometric) {
    return /** @type {Record<string, Function>} */ (
      /** @type {unknown} */ (dev.fingerPrint)
    );
  }
  // 非生体機種は getter が明示エラーを投げる
  return /** @type {Record<string, Function>} */ (
    /** @type {unknown} */ (dev.biometric)
  );
}

// collectBiometricList / BIO_LIST は biometric.js へ移管済み (P1-8 R2:SURF-26 + R2:SURF-39)。
// export { BIO_LIST, collectBiometricList } は本ファイル上部の re-export 宣言で行っている。

/**
 * record (card/passcode/finger は {id,name,type}、face/palm はパース済みオブジェクト) を1行に。
 * (テストのため export。CLI 出力整形専用、biometric.js へは移さない。)
 * @param {unknown} r
 * @returns {string}
 */
export function formatRecord(r) {
  if (r && typeof r === "object" && "id" in r) {
    const rec = /** @type {{ id?: unknown, name?: unknown, type?: unknown }} */ (r);
    return `${rec.id}\t${rec.name || ""}\ttype=${rec.type ?? "?"}`;
  }
  return JSON.stringify(r);
}

/**
 * @param {import("../cli.js").CliCtx} ctx
 * @param {string|undefined} value
 * @param {string} name
 * @returns {Buffer|undefined}
 */
function parseHexOption(ctx, value, name) {
  // 検証 + 変換は crypto.js:hexToBuf に委譲 (P5-4)。CLI のエラー文言 (i18n ble.cli.badHex)
  // と exit code 2 は従来どおり維持する (挙動互換)。
  try {
    return hexToBuf(String(value || ""));
  } catch {
    ctx.die(t("ble.cli.badHex", { name }), 2);
    return undefined;
  }
}

/**
 * Buffer/Uint8Array の名前を UTF-8 文字列へ変換する (cmdScript の Bot スクリプト名用)。
 * biometric.js の bioNameToText と同一ロジックだが CLI ローカルの用途 (Bot2 script 名) のため
 * こちらに残す。biometric.js の collectBiometricList は bioNameToText を独立に持つ。
 * @param {unknown} v
 * @returns {string}
 */
function bufToText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    const s = Buffer.from(/** @type {Uint8Array|number[]} */ (v)).toString("utf8");
    let end = s.length;
    // 末尾 NUL 除去。
    while (end > 0 && s.charCodeAt(end - 1) === 0x00) end--;
    return s.slice(0, end);
  } catch { return String(v); }
}

/**
 * scan 結果から JSON に載せられない peripheral ハンドルを除く。
 * @param {BleDiscovery} d
 */
function scrubDiscovery(d) {
  const { peripheral, ...rest } = d || {};
  return rest;
}

