// セッションモード (P5-3 で cli.js から抽出)。session-ui.js (ink/react) と対。
//
// `sesame session [names...]` / `sesame <device>` (action 省略 + TTY) の実体。
// 対象デバイスへ BLE 接続を張ったまま保持し、runSessionMenu でメニュー操作させる。
// session-ui.js (ink + react) は起動コスト削減のため cmdSession 内で動的 import する。
// 依存方向: cli.js → session.js → lock-ops.js (bleExec/fmtMech) → ctx.js。

import { EventEmitter } from "node:events";
import { t } from "../i18n.js";
import { rethrowMissingOptional } from "../optional-deps.js";
import { die } from "./errors.js";
import { loadCtx, withHub, hasCloudSession } from "./ctx.js";
import { isInteractive } from "../prompts.js";
import { SesameBle, capabilitiesForModel } from "../ble/index.js";
import { bleExec, fmtMech } from "./lock-ops.js";

/** @typedef {import("./ctx.js").Program} Program */
/** @typedef {import("./ctx.js").GlobalOpts} GlobalOpts */
/** @typedef {import("./ctx.js").CliError} CliError */
/** @typedef {import("./lock-ops.js").LockEntry} LockEntry */
/** @typedef {import("./lock-ops.js").MechStatus} MechStatus */
/** @typedef {import("../client.js").SesameHub3} SesameHub3 */

/**
 * config 由来の Hub3 entry (relay/LED 用 secretKey 付き)。
 * @typedef {object} Hub3Entry
 * @property {string} name
 * @property {string|undefined} deviceId
 * @property {string} model
 * @property {string|null} secretKey
 */

/**
 * config の全ロック entry (deviceUUID/secretKey が揃っているもの) を返す。
 * @param {Program} program
 * @returns {LockEntry[]}
 */
function allLockEntries(program) {
  const { configStore } = loadCtx(program);
  if (!configStore.exists()) { die(t("cli.noConfigInitSync"), 2); return []; }
  const locks = configStore.load().locks || {};
  return Object.entries(locks)
    .filter(([, l]) => l?.deviceUUID && l?.secretKey)
    .map(([name, l]) => ({ name, deviceUUID: /** @type {string} */ (l.deviceUUID), secretKey: /** @type {string} */ (l.secretKey), model: l.model || null }));
}

/**
 * config の全 Hub3 entry を返す ({name, deviceId, model, secretKey})。
 * secretKey/model は devices レコード丸ごと保存により config に揃っているので、ここで返す
 * (relay/LED は secretKey 必須。旧実装の「session 開始時に listDevices で再取得」する band-aid は廃止)。
 */
/**
 * @param {Program} program
 * @returns {Hub3Entry[]}
 */
function allHub3Entries(program) {
  const { configStore } = loadCtx(program);
  if (!configStore.exists()) return [];
  const hub3s = configStore.load().hub3s || {};
  return Object.entries(hub3s)
    .filter(([, h]) => h?.deviceId)
    .map(([name, h]) => ({ name, deviceId: h.deviceId, model: h.model || "hub_3", secretKey: h.secretKey || null }));
}

/**
 * 指定 Hub3 名に属する remote の一覧 ({name, label}) を返す (IR 送信のリモコン選択用)。
 * @param {Program} program
 * @param {string} hub3Name
 * @returns {Array<{name:string, label:string}>}
 */
function remotesForHub3(program, hub3Name) {
  const { configStore } = loadCtx(program);
  if (!configStore.exists()) return [];
  const remotes = configStore.load().remotes || {};
  return Object.entries(remotes)
    .filter(([, r]) => r?.hub3 === hub3Name)
    .map(([name, r]) => ({ name, label: r.alias ? `${name} (${r.alias})` : name }));
}

// セッション UI で使う操作ラベル (ロック系 + Hub3 系)。
// ロケールは run() 内で setLocale() してから確定するため、モジュール評価時に固定せず
// 呼び出し時に t() を引く (lazy)。
export function sessionLabel() {
  return {
    unlock: t("cli.sessLabelUnlock"), lock: t("cli.sessLabelLock"), toggle: t("cli.sessLabelToggle"), click: t("cli.sessLabelClick"), status: t("cli.sessLabelStatus"), autolock: t("cli.sessLabelAutolock"),
    ir: t("cli.sessLabelIr"), "relay-on": t("cli.sessLabelRelayOn"), "relay-off": t("cli.sessLabelRelayOff"), led: t("cli.sessLabelLed"),
  };
}

/**
 * セッション対象 1 デバイスの entry (ロック / Hub3 を統合した緩い形)。
 * @typedef {object} SessionEntry
 * @property {string} name
 * @property {string} [deviceUUID] ロック (BLE)
 * @property {string} [secretKey]
 * @property {string} [deviceId] Hub3 (cloud relay/LED)
 * @property {string|null} [model]
 * @property {string} [kind]
 */

/**
 * セッション中の 1 デバイス。ble は接続できたら SesameBle、未接続は null。
 * lastStatus は SesameBle 側のキャッシュ済み mechStatus。
 * @typedef {{ kind: string, entry: SessionEntry, ble: (import("../ble/index.js").SesameBle & { lastStatus?: MechStatus|null })|null }} SessionDevice
 */

/**
 * デバイス型 × 利用可能な経路の **和集合** で操作一覧を作る。
 * その op を運べる経路が今使えるときだけ出す: BLE 接続中なら ble 能力、ログイン済みなら cloud 能力。
 * (例: ロックは BLE 接続中のみ autolock を出す。OS2 ロックは cloud の lock/unlock/toggle のみ。)
 * @param {SessionDevice} d
 * @param {boolean} hasCloud クラウド経路が使えるか
 * @returns {Array<{label:string, value:string}>}
 */
export function sessionActionsFor(d, hasCloud) {
  const caps = capabilitiesForModel(d.entry.model);
  // 今使える経路で運べる op の集合。
  /** @type {Set<string>} */
  const avail = new Set();
  if (d.ble) for (const o of caps.ble) avail.add(o);
  if (hasCloud) for (const o of caps.cloud) avail.add(o);

  // 提示順: lock5 は現在状態から自然な順、それ以外は能力順。
  /** @type {string[]} */
  let ordered;
  if (caps.kind === "lock5") {
    const primary = d.ble?.lastStatus?.state === "locked" ? "unlock" : "lock";
    ordered = [primary, ...["unlock", "lock", "toggle", "autolock"].filter((o) => o !== primary)];
  } else {
    ordered = caps.ops; // bot2:[click] / bike2:[unlock] / hub3:[ir,relay,led] / os2lock:[lock,unlock,toggle] 等
  }

  const LABEL = sessionLabel();
  /** @type {Array<{label:string, value:string}>} */
  const acts = [];
  for (const o of ordered.filter((o) => avail.has(o))) {
    if (o === "relay") { // Hub3 のリレーは ON/OFF の 2 項目に展開。
      acts.push({ label: LABEL["relay-on"], value: "relay-on" }, { label: LABEL["relay-off"], value: "relay-off" });
    } else {
      acts.push({ label: /** @type {Record<string, string>} */ (LABEL)[o], value: o });
    }
  }
  if (caps.mechKind && d.ble) acts.push({ label: LABEL.status, value: "status" }); // mech がある型は BLE 接続中のみ状態取得
  return acts;
}

/**
 * ヘッダの状態表示。BLE 接続済みは実 mechStatus、Hub3/未接続は注記 (クラウド状態は形が不定で正規化しない)。
 * @param {SessionDevice} d
 * @returns {string}
 */
export function sessionFmtState(d) {
  if (d.kind === "hub3") return t("cli.sessHub3State");
  return d.ble ? fmtMech(d.ble.lastStatus) : t("cli.sessBleNotConnected");
}

/**
 * 1 操作を実行し結果メッセージを返す。
 *   ロック: BLE 接続済みなら BLE、無ければクラウド (autolock は BLE 必須)。
 *   Hub3 : IR 送信 (extra={remote,key}) / リレー ON/OFF / LED (extra=duty)。いずれもクラウド。
 * @param {SesameHub3|null} hub クラウドクライアント (未ログイン時 null)
 * @returns {(op: string, d: SessionDevice, extra: any) => Promise<string>}
 */
export function makeSessionExec(hub) {
  return async (op, d, extra) => {
    if (d.kind === "hub3") {
      if (!hub) return t("cli.sessHub3NeedLogin");
      if (op === "ir") { await hub.send(extra.remote, extra.key); return t("cli.sessIrSent", { remote: extra.remote, key: extra.key, name: d.entry.name }); }
      if (op === "relay-on" || op === "relay-off") {
        if (!d.entry.secretKey) return t("cli.sessNoSecretKey");
        await hub.iot.hub3RelaySwitch({ deviceId: d.entry.deviceId, secretKey: d.entry.secretKey, op: op === "relay-on" ? 0x01 : 0x00 });
        return t("cli.sessRelayResult", { state: op === "relay-on" ? "ON" : "OFF", name: d.entry.name });
      }
      if (op === "led") {
        if (!d.entry.secretKey) return t("cli.sessNoSecretKey");
        const r = /** @type {{ ledDuty?: number }} */ (await hub.iot.setHub3LedDuty({ deviceId: d.entry.deviceId, secretKey: d.entry.secretKey, op: 0x01, duty: Number(extra) }));
        return t("cli.sessLedResult", { duty: Number(extra), name: d.entry.name, extra: r?.ledDuty != null ? ` → ${r.ledDuty}` : "" });
      }
      return t("cli.sessUnsupportedOp", { op });
    }
    // ロック系
    const sessLabel = /** @type {Record<string, string>} */ (sessionLabel());
    if (d.ble) {
      const { status } = await bleExec(op, d.ble, extra);
      return op === "status" ? `${d.entry.name}: ${fmtMech(status)}` : `OK: ${sessLabel[op]} (${d.entry.name})`;
    }
    if (op === "autolock") return t("cli.sessAutolockBleOnly");
    if (op === "status") return t("cli.sessStatusCloud", { name: d.entry.name });
    if (!hub) return t("cli.sessNeedBleOrLogin");
    const hubAny = /** @type {Record<string, (name: string) => Promise<any>>} */ (/** @type {unknown} */ (hub));
    if (op === "click") await hub.botClick(d.entry.name);
    else await hubAny[op](d.entry.name); // lock/unlock/toggle
    return t("cli.sessCloudResult", { label: sessLabel[op], name: d.entry.name });
  };
}

/**
 * 対象ロックへ BLE 接続を張ったまま保持し、runSessionMenu でメニュー操作させる。
 * 接続を維持するので 1 操作ごとの再スキャン/再接続が起きない。
 *
 * @param {string[]} names 対象ロック名 (完全一致)。空なら config の全ロック。
 * @param {{ bleOnly?: boolean, cloudOnly?: boolean }} _options
 * @param {Program} program
 */
export async function cmdSession(names, _options, program) {
  const gopts = /** @type {GlobalOpts} */ (program.opts());
  if (gopts.json) { die(t("cli.sessionJsonOnly"), 2); return; }
  if (!isInteractive()) { die(t("cli.sessionTtyOnly"), 2); return; }

  const loggedIn = hasCloudSession(program);

  // 操作できるデバイス全部を対象にする: ロック/Bot/Bike (BLE+cloud) と、ログイン済みなら Hub3 (cloud)。
  // model/secretKey は config の devices レコードに揃っているので entry がそのまま能力解決に使える。
  const locks = allLockEntries(program).map((e) => ({ ...e, kind: "lock" }));
  const hub3s = loggedIn ? allHub3Entries(program).map((e) => ({ ...e, kind: "hub3" })) : [];
  const allDevs = /** @type {SessionEntry[]} */ (/** @type {unknown} */ ([...locks, ...hub3s]));
  if (allDevs.length === 0) { die(t("cli.noOperableDevices"), 2); return; }

  // 対象を決定: 名前指定があれば完全一致で絞る、無ければ全デバイス。
  /** @type {SessionEntry[]} */
  let targets;
  if (Array.isArray(names) && names.length > 0) {
    targets = [];
    for (const n of names) {
      const match = allDevs.find((e) => e.name === n);
      if (!match) { die(t("cli.deviceNotFoundCandidates", { name: n, names: allDevs.map((e) => e.name).join(", ") }), 2); return; }
      if (!targets.some((t) => t.name === match.name)) targets.push(match);
    }
  } else {
    targets = allDevs;
  }

  const lockTargets = targets.filter((t) => t.kind === "lock");

  /** @type {Map<string, SessionDevice>} */
  const devices = new Map();
  for (const t of targets) devices.set(t.name, { kind: /** @type {string} */ (t.kind), entry: t, ble: null });

  // UI のライブ再描画トリガ。BLE の mechStatus publish / 背景接続の完了で "update" を流す。
  const bus = new EventEmitter();
  bus.setMaxListeners(0);

  // BLE を張って devices[].ble に反映する (ロックのみ・best-effort・非致命)。繋がった台数を返す。
  const connectBle = async () => {
    if (lockTargets.length === 0) return 0;
    try {
      const result = await SesameBle.connectMany(/** @type {Array<{name:string, deviceUUID:string, secretKey:string, model?:string}>} */ (/** @type {unknown} */ (lockTargets)), { debug: !!gopts.debug, scanTimeoutMs: 8_000 });
      for (const [name, ble] of result.connected) {
        const d = devices.get(name);
        if (d) { d.ble = ble; ble.onStatus(() => bus.emit("update")); } // 以降 BLE 優先・状態変化で再描画
      }
      bus.emit("update"); // 接続が増えたら ·BLE に昇格させるため再描画
      return result.connected.size;
    } catch (e) {
      if (gopts.debug) console.error(t("cli.bleConnectFailedDebug", { message: /** @type {CliError} */ (e)?.message || String(e) }));
      return 0;
    }
  };

  let blePromise = null;
  if (loggedIn) {
    // オートのアプリ的挙動: クラウドでメニューを即表示し、BLE は **バックグラウンド** で接続する
    // (繋がったデバイスは次の描画で ·BLE に昇格し、以降 BLE 優先)。起動を BLE スキャンで待たせない。
    if (lockTargets.length) console.error(t("cli.bleBackgroundConnecting"));
    blePromise = connectBle();
  } else {
    // 未ログイン: クラウドの下支えが無いので BLE を待つしかない。0 なら die。
    console.error(t("cli.bleScanning", { names: lockTargets.map((lt) => lt.name).join(", ") }));
    if ((await connectBle()) === 0) {
      die(t("cli.bleNoneAndNotLoggedIn"), 1);
      return;
    }
  }

  // ink/react を遅延ロード。これらは optional peer dependency (P5-1) なので、未導入なら
  // 導入コマンドを案内する明瞭なエラーに変換する (rethrowMissingOptional)。
  let runSessionUI;
  try {
    ({ runSessionUI } = await import("../session-ui.js"));
  } catch (e) {
    rethrowMissingOptional(e, ["ink", "react", "ink-select-input", "ink-text-input"], t("cli.sessionMissingDeps"));
    throw e;
  }
  /** @param {SesameHub3|null} hub */
  const runner = async (hub) => {
    // Hub3 の relay/LED 用 secretKey は config の devices レコードに保存済み (sync 時に取り込み)。
    // 旧実装の「session 開始時に listDevices で再取得」する band-aid は不要 (entry.secretKey をそのまま使う。
    // 欠落していれば relay/LED の exec が `sesame devices で再取得` を案内する)。
    // session-ui.js はデバイス型をジェネリック (D extends SessionUIDeviceLike) で受けるため、
    // SessionDevice のままキャスト無しで渡せる (P5-7 で型ギャップ解消)。
    try {
      await runSessionUI({
        devices,
        hasCloud: !!hub,
        bus,
        exec: makeSessionExec(hub),
        /** @param {SessionDevice} d */
        actionsFor: (d) => sessionActionsFor(d, !!hub),
        fmtState: sessionFmtState,
        /** @param {SessionDevice} d */
        hub3RemotesFor: (d) => remotesForHub3(program, d.entry.name).map((r) => ({ label: r.label, value: r.name })),
        /** @param {string} remoteName */
        listKeysFor: async (remoteName) => (await /** @type {SesameHub3} */ (hub).listKeys(remoteName)).map((k) => ({ label: k.name, value: k.name })),
      });
    } finally {
      if (blePromise) await blePromise.catch(() => {}); // 背景接続の完了を待ってから閉じる
      for (const d of devices.values()) if (d.ble) await d.ble.close().catch(() => {});
      console.error(t("cli.disconnected"));
    }
  };

  if (loggedIn) await withHub(program, (hub) => runner(hub));
  else await runner(null);
}
