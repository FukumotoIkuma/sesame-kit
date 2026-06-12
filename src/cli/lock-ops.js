// 統合ロック操作 (P5-3 で cli.js から抽出)。
//
// トップレベル動詞 (`sesame <device> unlock` 等) の実行経路:
//   - pickTransport: 経路選択ポリシー (auto は cloud 優先、BLE 必須 op のみ BLE)
//   - bleExec: 接続済み SesameBle に op を実行する**唯一のコア** (単発・セッション共用、実体は exec.js)
//   - runBleOp / runCloudOp: 単発実行 (接続/切断と表示込み)
//   - cmdDeviceOp / cmdAct: デバイス主語コマンドの入口
// 依存方向: cli.js → lock-ops.js → exec.js / ctx.js / session.js。
// P5-7: bleExec/fmtMech を exec.js へ抽出し循環を解消。session.js は静的 import に昇格。

import { t } from "../i18n.js";
import { die } from "./errors.js";
import { loadCtx, out, withHub, canPrompt, hasCloudSession } from "./ctx.js";
import { isInteractive, selectFromList } from "../prompts.js";
import { SesameBle, SesameOS2Ble, capabilitiesForModel, transportsForOp, CONTROL_OPS, createBleTransport } from "../ble/index.js";
import { bleExec, fmtMech } from "./exec.js";
import { cmdSession } from "./session.js";

// bleExec / fmtMech / MechStatus は exec.js に移動した。後方互換のため re-export する。
export { bleExec, fmtMech };
/** @typedef {import("./exec.js").MechStatus} MechStatus */

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
 * @property {string} [ssmPublicKey] OS2 BLE login 用デバイス公開鍵 (128 hex)。config に保存済みのときのみ存在。
 * @property {string} [keyIndex]     OS2 BLE login 用 userIdx (4 hex)。config に保存済みのときのみ存在。
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
async function resolveLockEntry(program, name) {
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
  return {
    name: chosen,
    deviceUUID: lock.deviceUUID,
    secretKey: lock.secretKey,
    model: lock.model || null,
    // OS2 BLE login 用の鍵素材 (config に保存済みのときのみ)。
    // `locks add --ssm-public-key / --key-index` で保存した値を resolveLockEntry で透過させ、
    // runBleOp の OS2 経路が ECDH に使う (cmdOS2Invoke と同じ解決規則)。
    ...(lock.ssmPublicKey ? { ssmPublicKey: lock.ssmPublicKey } : {}),
    ...(lock.keyIndex ? { keyIndex: lock.keyIndex } : {}),
  };
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

// MechStatus typedef / fmtMech は exec.js に移動した (re-export 済み)。

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

// bleExec は exec.js に移動した (re-export 済み)。

/**
 * 接続済みの SesameBle / SesameOS2Ble に対して 1 操作を実行し、単発コマンド向けに表示する (接続/切断は呼び出し側責務)。
 * OS2 ファサードも同名の制御メソッドを持つため共通に使える。OS2 の mechStatus は "moved" 状態を含むが、
 * fmtMech は state/position/isBatteryCritical/isStop をそのまま整形するため追加の分岐は不要。
 * @param {string} op
 * @param {SesameBle|SesameOS2Ble} lock
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
 * OS2 デバイス (capabilitiesForModel(entry.model).os === 2) は SesameOS2Ble ファサードへ委譲。
 * OS3 は従来どおり SesameBle (OS3 ファサード)。
 * OS2/OS3 でハンドシェイク・暗号が完全に別物のため、ファサードを間違えると接続不可になる
 * (CHSesame2Device.kt 系 vs CHSesameOS3.kt 系 — 互換性なし)。
 * @param {string} op
 * @param {LockEntry} entry
 * @param {string|number|null|undefined} seconds
 * @param {GlobalOpts} gopts
 * @param {{ scanTimeoutMs?: number }} [bleOpts]
 */
export async function runBleOp(op, entry, seconds, gopts, { scanTimeoutMs } = {}) {
  const caps = capabilitiesForModel(entry.model);
  if (caps.os === 2) {
    // OS2 BLE ルーティング: SesameOS2Ble ファサードへ委譲。
    // login には ssmPublicKey (デバイス公開鍵) が必須 — ECDH の相手鍵。
    // 未保存なら `sesame locks add --ssm-public-key <hex>` で config に登録するよう案内する
    // (cmdOS2Invoke と同じ解決規則: resolveLockEntry で透過済み)。
    if (!entry.ssmPublicKey) {
      die(t("cli.os2BleNeedSsmPublicKey"), 2);
      return;
    }
    const transport = createBleTransport({
      deviceUUID: entry.deviceUUID,
      debug: !!gopts.debug,
      scanTimeoutMs,
    });
    await SesameOS2Ble.use({
      transport,
      deviceUUID: entry.deviceUUID,
      secretKey: entry.secretKey,
      // 省略時は "0000" (CHSesame2Device.kt:465 の登録時永続値)
      keyIndex: entry.keyIndex ?? undefined,
      ssmPublicKey: entry.ssmPublicKey,
      model: entry.model ?? undefined,
      debug: !!gopts.debug,
    }, (lock) => runBleOnLock(op, lock, entry, seconds, gopts));
    return;
  }
  // OS3 (従来どおり)
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
      // P5-7: bleExec/fmtMech を exec.js へ抽出したので循環が解消し、
      // 静的 import の cmdSession をそのまま呼べる (動的 import 不要)。
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
