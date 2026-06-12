// 予約実行スケジュール管理 (biz3Schedule)。
//
// Ported from biz3 (CANDY-HOUSE/biz3, MIT):
//   - vendor reference: references_web/src/api/useManageSchedule.js
//   - item フィールド: references_web/src/pages/biz/schedule-list/index.js
//
// 概要:
//   biz3Schedule は「指定時刻に lock / unlock / upgrade_firmware を実行する」予約の
//   一覧取得 (getScheduleList) と取消 (cancelSchedule) の 2 op のみ。
//   スケジュールの新規作成 op は biz3 web 側に存在しない (createSchedule/addSchedule とも
//   grep でヒットせず: references_web/src 全体)。登録は別経路/別アプリ由来の可能性があるが
//   本ファイル群からは未確認。CLI は list + cancel に限定する。
//
// フレームの要点 (useManageSchedule.js を 1 行ずつ確認):
//   - フラットな JSON。obj ラップ無し。companyID / apiKeyId は付与しない。
//   - userId フィールドに gStripe.customerInfo.subUUID を **加工せず** そのまま入れる
//     (大文字化やハイフン加工なし / useManageSchedule.js:13,17,52,56)。
//   - subUUID が falsy なら送信自体を中止 (useManageSchedule.js:14,53 は return)。
//   - 応答は action+op で dispatch される (useCallbacks.js:17-31 が action→op の 2 段照合 /
//     registerCallback(action, messageData.op, cb))。よって request の op を frame に
//     乗せれば transport の `${action}:${op}` キーで一致する。

import { ACTION_TYPES } from "./vendor/biz3/constants/messageConstants.js";
import { badRequest, rejected } from "./util.js";
import { t } from "./i18n.js";

// action 文字列は vendor (biz3 messageConstants) から引く (手書きしない)。
// messageConstants.js:21  BIZ3_SCHEDULE: 'biz3Schedule'
const ACT_SCHEDULE = ACTION_TYPES.BIZ3_SCHEDULE; // "biz3Schedule"
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * @typedef {Object} ScheduleItem
 * @property {string} scheduleId  取消に使う ID (schedule-list/index.js:49,82,102)
 * @property {string} action      'lock' | 'unlock' | 'upgrade_firmware' 等
 *                                 (schedule-list/index.js:77 / UI ラベルは正規化された表示用で
 *                                  サーバ側の正式 enum は未確認)
 * @property {string} displayTime '2026-01-01 09:00' または 'HH:MM' 形式 (index.js:78,31)
 * @property {string} deviceName  対象デバイス名 (index.js:92)
 */

/**
 * サーバに登録済みの予約スケジュール一覧を取得する。
 *
 * フレーム: { action: "biz3Schedule", userId: <subUUID>, op: "getScheduleList" }
 * 応答:     { action: "biz3Schedule", op: "getScheduleList", data: [ ScheduleItem, ... ] }
 *           message.data は **オブジェクトでラップされず直接配列** (useManageSchedule.js:34-35
 *           が count=data.length / Items=data に自前で詰め替えている点に注意)。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{subUUID?:string, timeoutMs?:number}} [params]
 *   subUUID は gStripe.customerInfo.subUUID 相当 (生の文字列をそのまま userId に入れる)
 * @returns {Promise<ScheduleItem[]>} スケジュール item の配列 (空なら [])
 */
export async function getScheduleList(client, { subUUID, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  // biz3: subUUID が falsy なら送信自体を中止 (useManageSchedule.js:14)。
  if (!subUUID) throw badRequest("schedule.err.subUUIDRequired");

  // フィールド順は原典 (useManageSchedule.js:15-19) のリテラル順 action, userId, op に合わせる。
  const frame = {
    action: ACT_SCHEDULE,
    userId: subUUID,
    op: "getScheduleList",
  };
  const resp = await client.request(frame, timeoutMs);
  if (resp && resp.success === false) {
    throw rejected(t("schedule.err.getScheduleListFailed", { message: resp.message || JSON.stringify(resp) }), { upstreamCode: resp?.code ?? null });
  }
  // 応答 data は配列直返し (useManageSchedule.js:34-35)。欠落時は空配列。
  return Array.isArray(resp?.data) ? resp.data : [];
}

/**
 * 予約スケジュールを 1 件取消す。
 *
 * フレーム: { action: "biz3Schedule", userId: <subUUID>, scheduleId: <scheduleId>, op: "cancelSchedule" }
 *           (フィールド順は原典 useManageSchedule.js:54-59 のリテラル順)
 * 応答:     { action: "biz3Schedule", op: "cancelSchedule", ... }
 *
 * 未確認: cancelSchedule 応答 data の具体構造は web コードからは判別不可。biz3 hook の switch
 * には cancelSchedule ケースが無く (useManageSchedule.js:31-41 は getScheduleList のみ)、
 * 完了は registerCallback の cb 受信 (= ack) でしか確認していない。UI は楽観的に isCancelling
 * フラグを立てるだけ (schedule-list/index.js:47-51)。よって本実装は **ack 受信=成功** とみなし、
 * resp.success が明示的に false の場合のみ throw する。成功フラグ等の data 形は実機検証要。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{subUUID?:string, scheduleId?:string, timeoutMs?:number}} [params]
 *   scheduleId は getScheduleList で得た item.scheduleId をそのまま渡す。
 * @returns {Promise<any>} サーバ応答 (ack)。data の構造は未確認のため raw を返す。
 */
export async function cancelSchedule(client, { subUUID, scheduleId, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  // biz3: subUUID が falsy なら送信中止 (useManageSchedule.js:53)。
  if (!subUUID) throw badRequest("schedule.err.subUUIDRequired");
  if (!scheduleId) throw badRequest("schedule.err.scheduleIdRequired");

  const frame = {
    action: ACT_SCHEDULE,
    userId: subUUID,
    scheduleId,
    op: "cancelSchedule",
  };
  const resp = await client.request(frame, timeoutMs);
  if (resp && resp.success === false) {
    throw rejected(t("schedule.err.cancelScheduleFailed", { message: resp.message || JSON.stringify(resp) }), { upstreamCode: resp?.code ?? null });
  }
  return resp;
}

// 公開 op の allowlist (SesameHub3._bindNs / serve registry が参照する単一の真実)。
export const NAMESPACE_OPS = ["getScheduleList", "cancelSchedule"];
