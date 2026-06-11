// 対話選択ヘルパ (P5-3 で cli.js から抽出)。
//
// remote 名 / remote キー / デバイス UUID の「未指定なら一覧から選ばせる」共通ロジックと、
// sync 系結果の整形 (printSyncResult)。remote.js / ir.js / device.js / locks.js が共用する。
// 依存方向: cli/*.js → pickers.js → ctx.js (循環なし)。

import { t } from "../i18n.js";
import { die } from "./errors.js";
import { canPrompt, out } from "./ctx.js";
import { selectFromList } from "../prompts.js";

/** @typedef {import("./ctx.js").Program} Program */
/** @typedef {import("../client.js").SesameHub3} SesameHub3 */
/** @typedef {import("../client.js").DeviceInfo} DeviceInfo */
/** @typedef {import("../config.js").ConfigStore} ConfigStore */

/**
 * 名前未指定 & 対話可能なら、設定済みリストから選択させる。
 * @param {Program} program
 * @param {ConfigStore} configStore
 * @param {string|undefined} current
 * @returns {Promise<string|null|undefined>}
 */
export async function pickRemoteName(program, configStore, current) {
  if (current) return current;
  const cfg = configStore.load();
  const names = Object.keys(cfg.remotes || {});
  if (names.length === 0) die(t("cli.remotesNotRegistered"), 2);
  if (names.length === 1) return names[0];
  if (!canPrompt(program)) return null;
  return selectFromList(t("cli.whichRemote"), names, (n) => {
    const r = cfg.remotes[n];
    const def = n === cfg.default?.remote ? " *" : "";
    return `${n}${def}\thub3=${r.hub3}\tkeys=${Object.keys(r.keys || {}).length}${r.alias ? `\t(${r.alias})` : ""}`;
  });
}

/**
 * @param {Program} program
 * @param {ConfigStore} configStore
 * @param {string|null|undefined} remoteName
 * @param {string|undefined} current
 * @returns {Promise<string|null|undefined>}
 */
export async function pickRemoteKeyName(program, configStore, remoteName, current) {
  if (current) return current;
  const cfg = configStore.load();
  const rn = /** @type {string} */ (remoteName);
  const remote = cfg.remotes?.[rn];
  if (!remote) die(t("cli.unknownRemote", { remote: rn }), 2);
  const keys = Object.keys(remote.keys || {});
  if (keys.length === 0) die(t("cli.remoteNoKeys", { remote: rn }), 2);
  if (!canPrompt(program)) return null;
  return selectFromList(t("cli.whichRemoteKey", { remote: rn }), keys, (k) => `${k}\t${remote.keys[k]}`);
}

/**
 * Hub から デバイス一覧を取って UUID を選ばせる (model フィルタ任意)。
 * @param {Program} program
 * @param {SesameHub3} hub
 * @param {string|undefined} current
 * @param {{ filter?: (d: DeviceInfo) => boolean, message?: string }} [opts]
 * @returns {Promise<string|undefined>}
 */
export async function pickDeviceUUID(program, hub, current, { filter, message = t("cli.whichDevice") } = {}) {
  if (current) return current;
  /** @type {DeviceInfo[]} */
  let list;
  try { list = await hub.listUserDevices(); } catch { list = []; }
  if (!list.length) {
    try { list = await hub.listDevices(); } catch { /* ignore */ }
  }
  const filtered = filter ? (list || []).filter(filter) : (list || []);
  if (!filtered.length) die(t("cli.devicesNotFound"), 2);
  // 1 個ならそれを auto-pick (Review L-4)
  if (filtered.length === 1) return filtered[0].deviceUUID;
  if (!canPrompt(program)) {
    // 非対話で複数候補あり → 具体的な救済策をエラーに含める
    // (3rd-pass L-2: 外側の `list` を shadow しないようリネーム)
    const summary = filtered.map((d) => `  ${d.deviceUUID}\t${d.deviceModel || "?"}\t${d.deviceName || ""}`).join("\n");
    die(t("cli.multipleDevicesNeedUuid", { summary }), 2);
  }
  const chosen = await selectFromList(message, filtered, (d) =>
    `${d.deviceName || "(no name)"}\t${d.deviceModel || "?"}\t${d.deviceUUID}`);
  return chosen.deviceUUID;
}

/**
 * sync 系の結果 (added/updated/removed) を整形出力。
 * @param {boolean} json
 * @param {string} kind
 * @param {{added?:string[], updated?:string[], removed?:string[]}} r
 */
export function printSyncResult(json, kind, r) {
  out(json, () => {
    /** @type {string[]} */
    const parts = [];
    if (r.added?.length)   parts.push(`+${r.added.length} (${r.added.join(", ")})`);
    if (r.updated?.length) parts.push(`~${r.updated.length} (${r.updated.join(", ")})`);
    if (r.removed?.length) parts.push(`-${r.removed.length} (${r.removed.join(", ")})`);
    console.log(t("cli.okSync", { kind, parts: parts.join(" / ") || t("cli.syncNoChange") }));
  }, { ok: true, kind, ...r });
}
