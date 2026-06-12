// BLE 実行コア (P5-7 で lock-ops.js から抽出)。
//
// bleExec / fmtMech / MechStatus を独立モジュールに分離することで
// lock-ops.js ⇄ session.js の実行時循環を解消する。
//
// 依存方向: lock-ops.js → exec.js ← session.js。exec.js は cli/ 内の
// 他モジュールに依存しない (i18n のみ)。

import { t } from "../i18n.js";

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
 * 接続済み SesameBle / SesameOS2Ble に op を実行する**唯一のコア**。単発コマンド・セッションの両方がここを通る
 * (session は保持中の接続を、単発は都度張った接続を渡す。「保持接続があればそれで操作する」という
 * セッションモードの挙動が、両方の既定動作になる)。能力ゲートは SesameBle 側が担保。表示はしない。
 * OS2 ファサード (SesameOS2Ble) も lock/unlock/toggle/click/autolock/status の同名メソッドを持つため、
 * 型は SesameBle | SesameOS2Ble の共通サブタイプとして `any` で受ける (両者に共通 interface 無し)。
 * @param {string} op
 * @param {import("../ble/index.js").SesameBle|import("../ble/os2/index.js").SesameOS2Ble} ble
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
