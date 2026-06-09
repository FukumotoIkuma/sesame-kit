// `sesame ble …` コマンド群 — BLE 直結の **読み取り系** (鍵不要の近接スキャン +
// 生体/アクセス制御デバイスの登録済み一覧 + Bot2/Bot3 スクリプト読み出し)。
//
// 本体ロジックは src/ble/* (SesameBle facade / BiometricCommands / Bot2Commands)。
// ここは commander への配線・対象解決・入出力整形のみを担う。
//
// 設計方針:
//   - **読み取り専用**。enroll(登録)/delete/mode-set など状態を変える BLE op はここでは扱わない
//     (それらは実機未検証・一部破壊的なため library-only のまま据え置く)。
//   - scan は鍵不要 (advertise のみ)。それ以外は config(locks) の secretKey で BLE login する。
//   - biometric の一覧は GET 要求 → デバイスが publish (START → NOTIFY×N → END) を返す設計なので、
//     registerDelegate で収集し END (または timeout) で確定する。
//
// 注意: BLE 生体/スクリプト系は公式 SDK から 1:1 移植・ユニットテスト済みだが**実機未検証**
// (README / docs/*/ble.md 参照)。`--debug` で生フレームを確認できる。
//
// ctx 契約 (cli.js makeCtx が供給): ctx.out / die / canPrompt / loadCtx。
// BLE は hub を使わないので withHub は通らず、config は ctx.loadCtx().configStore から引く。

import { t } from "../i18n.js";
import { SesameBle, capabilitiesForModel } from "../ble/index.js";

// 生体タイプ別の「GET メソッド名」と「収集に使う delegate コールバック名」。
// recv が (device,id,name,type) を返すか単一オブジェクトを返すかで record 化を変える。
export const BIO_LIST = {
  card: { getter: "cardGet", start: "onCardReceiveStart", recv: "onCardReceive", end: "onCardReceiveEnd" },
  passcode: { getter: "passcodeGet", start: "onKeyBoardReceiveStart", recv: "onKeyBoardReceive", end: "onKeyBoardReceiveEnd" },
  finger: { getter: "fingerPrints", start: "onFingerPrintReceiveStart", recv: "onFingerPrintReceive", end: "onFingerPrintReceiveEnd" },
  face: { getter: "faceListGet", start: "onFaceReceiveStart", recv: "onFaceReceive", end: "onFaceReceiveEnd", single: true },
  palm: { getter: "palmListGet", start: "onPalmReceiveStart", recv: "onPalmReceive", end: "onPalmReceiveEnd", single: true },
};

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
 * @param {object} ctx cli.js makeCtx() が供給する共有コンテキスト
 */
export function registerBleCommands(program, ctx) {
  const ble = program.command("ble").description(t("ble.cli.cmd.desc"));

  // 接続が要るサブコマンド共通の対象指定オプション。
  const withTargetOpts = (cmd) =>
    cmd
      .option("--secret <hex>", t("ble.cli.opt.secret"))
      .option("--model <model>", t("ble.cli.opt.model"))
      .option("--timeout <ms>", t("ble.cli.opt.timeout"));

  // ---- ble scan ----
  // 近接 SESAME を鍵無しで列挙 (listNearbyDevices)。登録済み/未登録・機種・RSSI 等を出す。
  ble
    .command("scan")
    .description(t("ble.cli.scan.desc"))
    .option("--timeout <ms>", t("ble.cli.opt.scanTimeout"), "5000")
    .action((options) => cmdScan(ctx, options));

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
}

// ---------- コマンド実体 ----------

async function cmdScan(ctx, options) {
  const { opts } = ctx.loadCtx();
  const timeoutMs = Number(options.timeout) || 5000;
  const found = await SesameBle.listNearby({ timeoutMs, debug: !!opts.debug });
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

async function cmdBiometricList(ctx, type, device, options) {
  const spec = BIO_LIST[type];
  const { opts } = ctx.loadCtx();
  const entry = resolveBleEntry(ctx, device, options);
  if (!entry) return;
  const caps = capabilitiesForModel(entry.model);
  const timeoutMs = Number(options.timeout) || 8000;

  await SesameBle.use(
    { secretKey: entry.secretKey, deviceUUID: entry.deviceUUID, model: entry.model, debug: !!opts.debug },
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

async function cmdBiometricMode(ctx, device, type, options) {
  const method = BIO_MODE[type];
  if (!method) { ctx.die(t("ble.cli.mode.badType", { type, types: Object.keys(BIO_MODE).join("/") }), 2); return; }
  const { opts } = ctx.loadCtx();
  const entry = resolveBleEntry(ctx, device, options);
  if (!entry) return;
  const caps = capabilitiesForModel(entry.model);

  await SesameBle.use(
    { secretKey: entry.secretKey, deviceUUID: entry.deviceUUID, model: entry.model, debug: !!opts.debug },
    async (dev) => {
      const cmds = biometricView(dev, type, caps);
      const mode = await cmds[method]();
      ctx.out(opts.json, () => console.log(t("ble.cli.mode.result", { type, mode, name: entry.name })),
        { ok: true, type, mode, name: entry.name, deviceUUID: entry.deviceUUID });
    },
  );
}

async function cmdScript(ctx, device, options) {
  const { opts } = ctx.loadCtx();
  const entry = resolveBleEntry(ctx, device, options);
  if (!entry) return;
  const caps = capabilitiesForModel(entry.model);
  if (!caps.script) { ctx.die(t("ble.cli.script.notSupported", { name: entry.name, model: entry.model || "?" }), 2); return; }
  const index = options.index != null ? Number(options.index) : null;

  await SesameBle.use(
    { secretKey: entry.secretKey, deviceUUID: entry.deviceUUID, model: entry.model, debug: !!opts.debug },
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

// ---------- ヘルパ ----------

/**
 * `<device>` (config の lock 名 or deviceUUID) を BLE entry へ解決する。
 * --secret / --model で補完・上書きできる (config に無い生体デバイスを直接指定する用)。
 * @returns {{name:string, deviceUUID:string, secretKey:string, model:(string|null)}|null}
 */
function resolveBleEntry(ctx, device, options) {
  const cfg = ctx.loadCtx().configStore.load();
  const locks = cfg.locks || {};

  // 1) config の lock 名 (完全一致 → 部分一致) で引く。
  let name = device;
  let rec = locks[device];
  if (!rec) {
    const byUuid = Object.entries(locks).find(([, l]) => normUuid(l.deviceUUID) === normUuid(device));
    if (byUuid) { name = byUuid[0]; rec = byUuid[1]; }
  }
  if (!rec) {
    const partial = Object.entries(locks).filter(([n]) => n.toLowerCase().includes(String(device).toLowerCase()));
    if (partial.length === 1) { name = partial[0][0]; rec = partial[0][1]; }
    else if (partial.length > 1) {
      ctx.die(t("ble.cli.resolve.ambiguous", { device, names: partial.map(([n]) => n).join(", ") }), 2);
      return null;
    }
  }

  // 2) config に無くても、UUID らしき指定 + --secret があれば直接 entry を組む。
  const deviceUUID = rec?.deviceUUID || device;
  const secretKey = options.secret || rec?.secretKey;
  const model = options.model || rec?.model || null;
  if (!secretKey) {
    ctx.die(t("ble.cli.resolve.noSecret", { device }), 2);
    return null;
  }
  return { name: rec ? name : deviceUUID, deviceUUID, secretKey, model };
}

/** type に応じて biometric / fingerPrint ビューを選ぶ (Bike3 は fingerPrint のみ)。 */
function biometricView(dev, type, caps) {
  if (type === "finger" && caps.fingerprint && !caps.biometric) return dev.fingerPrint;
  return dev.biometric; // 非生体機種は getter が明示エラーを投げる
}

/** GET 要求 → publish(START→NOTIFY×N→END) を収集し、END または timeout で確定する。
 *  (テストのため export。spec は BIO_LIST の 1 entry。) */
export function collectBiometricList(cmds, spec, timeoutMs) {
  return new Promise((resolve) => {
    const records = [];
    let done = false;
    let off = () => {};
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      off();
      resolve(records);
    };
    const delegate = {
      [spec.start]: () => {},
      [spec.recv]: spec.single
        ? (_dev, obj) => records.push(obj)
        : (_dev, id, name, cardType) => records.push({ id, name: bufToText(name), type: cardType }),
      [spec.end]: () => finish(),
    };
    off = cmds.registerDelegate(delegate);
    timer = setTimeout(finish, timeoutMs);
    // GET を撃つ (応答 ack は即返るが、実データは publish で来る → finish は END/timeout 駆動)。
    Promise.resolve(cmds[spec.getter]()).catch(() => { /* publish/timeout を待つ */ });
  });
}

/** record (card/passcode/finger は {id,name,type}、face/palm はパース済みオブジェクト) を1行に。
 *  (テストのため export。) */
export function formatRecord(r) {
  if (r && typeof r === "object" && "id" in r) return `${r.id}\t${r.name || ""}\ttype=${r.type ?? "?"}`;
  return JSON.stringify(r);
}

/** Buffer/Uint8Array の名前を UTF-8 文字列へ。既に文字列ならそのまま。 */
function bufToText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try { return Buffer.from(v).toString("utf8").replace(/\0+$/, ""); } catch { return String(v); }
}

/** scan 結果から JSON に載せられない peripheral ハンドルを除く。 */
function scrubDiscovery(d) {
  const { peripheral, ...rest } = d || {};
  return rest;
}

function normUuid(s) {
  return typeof s === "string" ? s.replace(/-/g, "").toLowerCase() : "";
}
