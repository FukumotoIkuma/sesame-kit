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
 * @param {{subUUID:string, timeoutMs?:number}} params
 *   subUUID は gStripe.customerInfo.subUUID 相当 (生の文字列をそのまま userId に入れる)
 * @returns {Promise<ScheduleItem[]>} スケジュール item の配列 (空なら [])
 */
export function getScheduleList(client: import("./transport.js").Hub3WsClient, { subUUID, timeoutMs }?: {
    subUUID: string;
    timeoutMs?: number;
}): Promise<ScheduleItem[]>;
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
 * @param {{subUUID:string, scheduleId:string, timeoutMs?:number}} params
 *   scheduleId は getScheduleList で得た item.scheduleId をそのまま渡す。
 * @returns {Promise<any>} サーバ応答 (ack)。data の構造は未確認のため raw を返す。
 */
export function cancelSchedule(client: import("./transport.js").Hub3WsClient, { subUUID, scheduleId, timeoutMs }?: {
    subUUID: string;
    scheduleId: string;
    timeoutMs?: number;
}): Promise<any>;
export const NAMESPACE_OPS: string[];
export type ScheduleItem = {
    /**
     * 取消に使う ID (schedule-list/index.js:49,82,102)
     */
    scheduleId: string;
    /**
     * 'lock' | 'unlock' | 'upgrade_firmware' 等
     *  (schedule-list/index.js:77 / UI ラベルは正規化された表示用で
     *   サーバ側の正式 enum は未確認)
     */
    action: string;
    /**
     * '2026-01-01 09:00' または 'HH:MM' 形式 (index.js:78,31)
     */
    displayTime: string;
    /**
     * 対象デバイス名 (index.js:92)
     */
    deviceName: string;
};
//# sourceMappingURL=schedule.d.ts.map