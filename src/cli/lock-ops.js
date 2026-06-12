// 統合ロック操作 (P5-3 で cli.js から抽出)。
//
// トップレベル動詞 (`sesame <device> unlock` 等) の実行経路:
//   - pickTransport: 経路選択ポリシー (auto は cloud 優先、BLE 必須 op のみ BLE)
//   - bleExec: 接続済み SesameBle に op を実行する**唯一のコア** (単発・セッション共用)
//   - runBleOp / runCloudOp: 単発実行 (接続/切断と表示込み)
//   - cmdDeviceOp / cmdAct: デバイス主語コマンドの入口
// 依存方向: cli.js → lock-ops.js → ctx.js。session.js へは**動的 import のみ**
// (session.js が bleExec/fmtMech を静的 import するため、静的に張ると循環になる)。

import { t } from "../i18n.js";
import { die } from "./errors.js";
import { loadCtx, out, withHub, canPrompt, hasCloudSession } from "./ctx.js";
import { isInteractive, selectFromList } from "../prompts.js";
import { SesameBle, capabilitiesForModel, transportsForOp, CONTROL_OPS } from "../ble/index.js";

/** @typedef {import("./ctx.js").Program} Program */
/** @typedef {import("./ctx.js").GlobalOpts} GlobalOpts */
/** @typedef {import("./ctx.js").CliError} CliError */

/** 統合ロック操作の解決済み entry。 */
/**
 * @typedef {object} LockEntry
 * @property {string} name
 * @property {string} deviceUUID
 * @property {string} secretKey
 * @property {string|null} [model]
 */

/** デバイスに対して可能な操作 (動詞)。制御 op は能力モデル (CONTROL_OPS) を単一真実源として引き、
 *  状態取得の "status" だけ CLI 固有に足す。型ごとの可否は cmdAct の能力ゲートが別途判定する。 */
export const DEVICE_ACTIONS = new Set([...CONTROL_OPS, "status"]);

/**
 * config からロック entry を解決する。
 * 優先: 位置引数/--name → default.lock → 単一なら自動 → 対話選択。
 * @param {Program} program
 * @param {string|null|undefined} name
 * @returns {Promise<LockEntry|null>} die 済みなら null
 */
export async function resolveLockEntry(program, name) {
  const { configStore } = loadCtx(program);
  if (!configStore.exists()) { die(t("cli.noConfigInitSync"), 2); return null; }
  const cfg = configStore.load();
  const locks = cfg.locks || {};
  const names = Object.keys(locks);
  if (names.length === 0) { die(t("cli.locksNotRegisteredSync"), 2); return null; }

  /** @type {string|null} */
  let chosen = null;
  if (name) {
    if (locks[name]) chosen = name; // 完全一致
    else { die(t("cli.lockNotFound", { name, names: names.join(", ") }), 2); return null; }
  } else {
    chosen = cfg.default?.lock || (names.length === 1 ? names[0] : null);
    if (!chosen) {
      if (!canPrompt(program)) { die(t("cli.multipleLocksSpecify", { names: names.join(", ") }), 2); return null; }
      chosen = await selectFromList(t("cli.whichLock"), names, (n) => `${n}\t${locks[n].deviceUUID}`);
      if (!chosen) { console.error(t("cli.cancelledDot")); return null; }
    }
  }
  const lock = locks[chosen];
  if (!lock?.deviceUUID || !lock?.secretKey) { die(t("cli.lockMissingKeys", { name: chosen }), 2); return null; }
  return { name: chosen, deviceUUID: lock.deviceUUID, secretKey: lock.secretKey, model: lock.model || null };
}

/**
 * 単発コマンドの経路を決定する。
 *   - 既定 (オート): 能力フル。経路はツールが自動選択する。BLE はスキャン/接続のオーバーヘッドが
 *     あるため毎回は張らず、cloud で運べる op は cloud、cloud で運べない op (autolock など BLE 必須)
 *     のみ BLE で一時接続する (cloud が速いという意味ではなく、BLE の接続コストを毎回払わないため)。
 *   - `--ble-only` / `--cloud-only`: 経路を固定したいときの明示指定 (最優先)。
 * 「BLE 接続を保持する」モードは `sesame session`。運べる経路はデバイス型×op の能力から導出する。
 * @param {string} op
 * @param {{ cloudOnly?: boolean, bleOnly?: boolean }} options
 * @param {string|null|undefined} model
 * @returns {"cloud"|"ble"}
 */
export function pickTransport(op, options, model) {
  if (options.cloudOnly && options.bleOnly) { die(t("cli.cloudBleExclusive"), 2); }
  // status は制御 op ではなく mech 状態の読み取り。capability リスト (制御 op のみ) には載らないが、
  // 実行層は BLE (ble.status) でも cloud (getDeviceStatus) でも取得できる。mech を持つ型
  // (mechKind != null = lock/bot) なら対応、hub/biometric/wifi は mech が無いので非対応。
  // auto/--cloud-only は cloud を既定 (BLE 接続コスト回避)、--ble-only は BLE。
  if (op === "status") {
    if (!capabilitiesForModel(model).mechKind) { die(t("cli.noTransportForOp", { op }), 2); }
    return options.bleOnly ? "ble" : "cloud";
  }
  const allowed = transportsForOp(model, op);
  if (allowed.length === 0) { die(t("cli.noTransportForOp", { op }), 2); }
  if (options.bleOnly) {
    if (!allowed.includes("ble")) { die(t("cli.opNotOverBle", { op }), 2); }
    return "ble";
  }
  if (options.cloudOnly) {
    if (!allowed.includes("cloud")) { die(t("cli.opNotOverCloud", { op }), 2); }
    return "cloud";
  }
  // オート: cloud で運べるなら cloud (BLE の接続コストを避けるため)。cloud 不可な op (autolock) のみ BLE。
  return allowed.includes("cloud") ? "cloud" : "ble";
}

/**
 * BLE の mechStatus (ble.status() の戻り)。
 * @typedef {{ state?: string, position?: number|null, isBatteryCritical?: boolean, isStop?: boolean, isCritical?: boolean }} MechStatus
 */

/**
 * mechStatus を 1 行に整形。
 * @param {MechStatus|null|undefined} s
 * @returns {string}
 */
export function fmtMech(s) {
  if (!s) return t("cli.statusNotFetched");
  const warn = [s.isBatteryCritical && t("cli.batteryLow"), s.isStop && t("cli.stop"), s.isCritical && t("cli.abnormal")].filter(Boolean).join(" ");
  // position はロック (Sesame5/6) のみ。Bot/Bike は概念がないので state だけ表示する。
  const pos = s.position == null ? "" : ` pos=${s.position}`;
  return `state=${s.state}${pos}${warn ? " " + warn : ""}`;
}

/**
 * cloud の device-status (stateInfo) を fmtMech と揃えた 1 行に整形。
 * @param {{ stateInfo?: { position?: number|null, batteryPercentage?: number|null, CHSesame2Status?: string } }|null|undefined} st
 * @returns {string}
 */
export function fmtCloudStatus(st) {
  if (!st || !st.stateInfo) return t("cli.statusNotFetched");
  const si = st.stateInfo;
  const pos = si.position == null ? "" : ` pos=${si.position}`;
  const batt = si.batteryPercentage == null ? "" : ` battery=${si.batteryPercentage}%`;
  return `state=${si.CHSesame2Status ?? "?"}${pos}${batt}`;
}

/**
 * status 出力から秘匿値 (secretKey) を落とす。status は状態読み取りで鍵は不要。
 * @param {unknown} st
 * @returns {unknown}
 */
export function sanitizeStatus(st) {
  if (!st || typeof st !== "object") return st;
  const { secretKey, ...safe } = /** @type {Record<string, unknown>} */ (st); // eslint-disable-line no-unused-vars
  return safe;
}

/**
 * 接続済み SesameBle に op を実行する**唯一のコア**。単発コマンド・セッションの両方がここを通る
 * (session は保持中の接続を、単発は都度張った接続を渡す。「保持接続があればそれで操作する」という
 * セッションモードの挙動が、両方の既定動作になる)。能力ゲートは SesameBle 側が担保。表示はしない。
 * @param {string} op
 * @param {SesameBle} ble
 * @param {string|number|null|undefined} seconds
 * @returns {Promise<{result:any, status:MechStatus|null}>}
 */
export async function bleExec(op, ble, seconds) {
  /** @type {any} */
  let result = null;
  const bleAny = /** @type {Record<string, () => Promise<any>>} */ (/** @type {unknown} */ (ble));
  if (op === "autolock") result = await ble.autolock(Number(seconds));
  else if (op !== "status") result = await bleAny[op](); // lock/unlock/toggle/click (履歴タグ無し = SDK null-tag [00 0E])
  const status = /** @type {MechStatus|null} */ (await ble.status().catch(() => null));
  return { result, status };
}

/**
 * 接続済みの SesameBle に対して 1 操作を実行し、単発コマンド向けに表示する (接続/切断は呼び出し側責務)。
 * @param {string} op
 * @param {SesameBle} lock
 * @param {LockEntry} entry
 * @param {string|number|null|undefined} seconds
 * @param {GlobalOpts} gopts
 */
async function runBleOnLock(op, lock, entry, seconds, gopts) {
  const { result, status } = await bleExec(op, lock, seconds);
  out(gopts.json, () => {
    if (op === "status") { console.log(`${entry.name}: ${fmtMech(status)}`); return; }
    console.log(t("cli.okOp", { op, extra: op === "autolock" ? ` ${Number(seconds) === 0 ? t("cli.autolockDisabled") : t("cli.autolockSeconds", { seconds: Number(seconds) })}` : "", name: entry.name }));
    if (status) console.log(`   ${fmtMech(status)}`);
  }, { ok: true, op, name: entry.name, via: "ble", result, status });
}

/**
 * BLE で 1 操作 (connect→op→close)。--ble-only 明示 or BLE 必須 op (autolock) 用。
 * @param {string} op
 * @param {LockEntry} entry
 * @param {string|number|null|undefined} seconds
 * @param {GlobalOpts} gopts
 * @param {{ scanTimeoutMs?: number }} [bleOpts]
 */
export async function runBleOp(op, entry, seconds, gopts, { scanTimeoutMs } = {}) {
  await SesameBle.use(
    { secretKey: entry.secretKey, deviceUUID: entry.deviceUUID, model: entry.model ?? undefined, debug: !!gopts.debug, scanTimeoutMs },
    (lock) => runBleOnLock(op, lock, entry, seconds, gopts),
  );
}

/**
 * クラウド経由で 1 操作を実行。
 * @param {string} op
 * @param {LockEntry} entry
 * @param {Program} program
 */
export async function runCloudOp(op, entry, program) {
  await withHub(program, async (hub, { opts }) => {
    if (op === "status") {
      const st = await hub.getDeviceStatus(entry.deviceUUID);
      const safe = sanitizeStatus(st);
      out(opts.json, () => console.log(`${entry.name}: ${fmtCloudStatus(st)}`), { ok: true, op, name: entry.name, via: "cloud", status: safe });
      return;
    }
    // click (Bot の BLE クリック) は cloud では botClick(cmd=89) に対応。
    const hubAny = /** @type {Record<string, (name: string) => Promise<any>>} */ (/** @type {unknown} */ (hub));
    const resp = /** @type {{ data?: Record<string, unknown> }} */ ((op === "bot" || op === "click") ? await hub.botClick(entry.name) : await hubAny[op](entry.name)); // lock/unlock/toggle
    out(opts.json, () => {
      console.log(`OK: ${op} (${entry.name})`);
      if (resp?.data && Object.keys(resp.data).length) console.log(`   ${JSON.stringify(resp.data)}`);
    }, { ok: true, op, name: entry.name, via: "cloud", response: resp });
  });
}

/**
 * cmdDeviceOp / cmdAct が cli.js から注入される依存。
 * maybeHandleBleError は cli.js に実体がある (BLE 環境エラーの終了コード契約をソース固定する
 * テストの都合 + macOS 設定ペイン誘導という「プロセス終端の関心事」のため)。
 * @typedef {{ maybeHandleBleError?: (err: unknown) => boolean }} LockOpsDeps
 */

/**
 * デバイス主語の実行: `sesame <device> [action] [args]`。
 *   - action 省略 + TTY → そのデバイス (複数可) の対話セッション。
 *   - action 省略 + 非対話 → status を表示。
 *   - action 指定 → 1 発実行 (cmdAct に委譲。経路はオートで自動)。
 * @param {string|undefined} device
 * @param {string|undefined} action
 * @param {string[]|undefined} args
 * @param {{ bleOnly?: boolean, cloudOnly?: boolean, name?: string }} options
 * @param {Program} program
 * @param {LockOpsDeps} [deps]
 */
export async function cmdDeviceOp(device, action, args, options, program, deps = {}) {
  if (!action) {
    if (isInteractive() && !program.opts().json) {
      // セッション UI (ink/react を内部で遅延ロード) は必要時のみ読み込む。
      // 静的 import にすると session.js → lock-ops.js (bleExec/fmtMech) と循環するため動的に。
      const { cmdSession } = await import("./session.js");
      await cmdSession(device ? [device] : [], options, program);
      return;
    }
    action = "status"; // 非対話の既定は状態表示
  }
  if (!DEVICE_ACTIONS.has(action)) {
    die(t("cli.unknownAction", { action, actions: [...DEVICE_ACTIONS].join(" / "), device: device || "<device>" }), 2);
    return;
  }
  const seconds = action === "autolock" ? (args && args[0]) : null;
  if (action === "autolock" && (seconds == null)) {
    die(t("cli.autolockNeedsSeconds"), 2);
    return;
  }
  await cmdAct(action, device, seconds, options, program, deps);
}

/**
 * @param {string} op
 * @param {string|undefined} name
 * @param {string|null|undefined} seconds
 * @param {{ bleOnly?: boolean, cloudOnly?: boolean, name?: string }} options
 * @param {Program} program
 * @param {LockOpsDeps} [deps]
 */
export async function cmdAct(op, name, seconds, options, program, deps = {}) {
  const entry = await resolveLockEntry(program, name || options.name);
  if (!entry) return; // die 済み
  const transport = pickTransport(op, options, entry.model);
  const gopts = /** @type {GlobalOpts} */ (program.opts());
  const extra = op === "autolock" ? ` ${seconds}s` : "";

  // デバイス型ごとの能力ゲート (SDK 準拠)。model が判っていて非対応な操作は接続前に弾く。
  // 例: Bot に lock/unlock → "click を使え"、Lock に click → "toggle を使え"。
  // ゲート対象は制御 op (CONTROL_OPS = 能力モデルの単一真実源)。"status" は全機種可なので除外。
  if (CONTROL_OPS.includes(op) && entry.model) {
    const caps = capabilitiesForModel(entry.model);
    if (!caps.ops.includes(op)) {
      die(t("cli.modelNotSupportOp", { label: caps.label, model: entry.model, op, ops: caps.ops.join("/") || t("cli.opsNone") }), 2);
      return;
    }
  }

  // autolock の引数検証は接続前に。
  if (op === "autolock") {
    const sec = Number(seconds);
    if (!Number.isInteger(sec) || sec < 0 || sec > 65535) { die(t("cli.secondsRange"), 2); return; }
  }

  if (transport === "ble") {
    // BLE 一時接続 (--ble-only 明示、または autolock のような cloud 不可な op)。
    if (!gopts.json) console.error(`[ble] ${op}${extra} → ${entry.name}`);
    try {
      await runBleOp(op, entry, seconds, gopts);
    } catch (e) {
      if (deps.maybeHandleBleError && deps.maybeHandleBleError(e)) return; // 権限/電源/未導入は設定誘導
      throw e;
    }
    return;
  }
  // transport === "cloud"
  if (!hasCloudSession(program)) {
    die(t("cli.cloudNotLoggedIn"), 2);
    return;
  }
  if (!gopts.json) console.error(`[cloud] ${op}${extra} → ${entry.name}`);
  await runCloudOp(op, entry, program);
}
