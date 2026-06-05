/**
 * lock 制御コマンドを送信し、サーバ ack を待って解決する。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{
 *   deviceId: string,    // ロックの deviceUUID
 *   secretKey: string,   // 32hex のロック共通鍵 (devices command で取得)
 *   subUUID: string,     // ログインユーザの subUUID
 *   cmd: number,         // CMD.LOCK | UNLOCK | TOGGLE | CLICK
 *   timeoutMs?: number,
 * }} params
 * @returns {Promise<any>} biz3TriggerLocker ack メッセージ
 */
export function triggerLock(client: import("./transport.js").Hub3WsClient, params: {
    deviceId: string;
    secretKey: string;
    subUUID: string;
    cmd: number;
    timeoutMs?: number;
}): Promise<any>;
/** ロックを施錠 (cmd=82)。 */
export function lockLock(client: any, p: any): Promise<any>;
/** ロックを解錠 (cmd=83)。 */
export function lockUnlock(client: any, p: any): Promise<any>;
/** ロックを反転 (cmd=88, cloud のみ)。現在状態に応じてサーバが LOCK/UNLOCK を判定。 */
export function lockToggle(client: any, p: any): Promise<any>;
/** SESAME Bot のボタンクリック (cmd=89)。 */
export function botClick(client: any, p: any): Promise<any>;
/**
 * 任意の SESAME ItemCode をクラウド経由 (biz3TriggerLocker) で送る汎用レール。
 *
 * フレームは lock/unlock と同型 `{action, cmd, sign:cmacTime(secretKey), history:base64(payload), device_id}`
 * (公式 SDK CHAPIClientBiz.cmdSesame と一致: msg=3byte時刻の CMAC を sign、payload を history に base64)。
 * lock/unlock(82/83) と autolock(11) 等は同一 ItemCode 名前空間 (Android SesameSDK SesameProtocols.kt)。
 *
 * ⚠️ **lock/unlock/toggle/bot 以外は実機に反映されない (実機検証済み)**:
 *   biz3TriggerLocker は lock/unlock/toggle/bot のみを実機へ中継する。それ以外の ItemCode は
 *   サーバが `success:true` で **ack だけ返すが、ロック本体には適用されない** (autolock=11 で
 *   2026 実機確認: ack は返るが autolock 設定は変化せず)。biz3 web/SDK にも設定系のクラウド送信
 *   経路は無く (useIotCtrl.js の IoT cmd は ADD/REMOVE_SESAME・LED・RELAY 等のみで autolock は
 *   "Unsupported"、公式アプリは BLE 直送)。よって本関数で lock/unlock 系以外を送っても
 *   **`success:true` は「サーバ受領」止まりで実機反映の保証は無い**。lock/unlock/toggle/bot 用、
 *   もしくは将来クラウド対応された ItemCode 用の汎用レールとして残す。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{
 *   deviceId: string,                 // ロックの deviceUUID
 *   secretKey: string,                // 32hex の共通鍵
 *   cmd: number,                      // SesameItemCode 値 (CMD.AUTOLOCK 等)
 *   payload?: Uint8Array|Buffer|number[], // BLE ペイロード (省略時は subUUID の history タグ)
 *   subUUID?: string,                 // payload 省略時に history へ使う
 *   timeoutMs?: number,
 * }} params
 * @returns {Promise<any>} biz3TriggerLocker ack メッセージ (success:false は reject)
 */
export function triggerItemCommand(client: import("./transport.js").Hub3WsClient, params: {
    deviceId: string;
    secretKey: string;
    cmd: number;
    payload?: Uint8Array | Buffer | number[];
    subUUID?: string;
    timeoutMs?: number;
}): Promise<any>;
/**
 * オートロック (解錠 N 秒後に自動施錠) を設定する。autolock = ItemCode 11、payload = 2byte LE 秒数。
 * `seconds=0` で無効化 (autolock_jp.md: 遅延時間 0 は自動施錠無効)。
 *
 * ⚠️ **クラウド経由では実機に反映されない (2026 実機検証済み)**。biz3TriggerLocker は cmd=11 に
 *   `success:true` を返すが、ロック本体の autolock 設定は変化しない。autolock の正規経路は **BLE 直送のみ**
 *   (公式アプリ準拠)。本関数はフレーム生成としては正しい (BLE トランスポートや将来のクラウド対応用) が、
 *   現状の biz3 クラウドでは効果が無い。CLI からは公開していない ({@link triggerItemCommand} 参照)。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{ deviceId: string, secretKey: string, seconds: number, timeoutMs?: number }} params
 *   seconds: 0..65535 (0=無効)。SESAME 本体の選択肢は 0/5/10/.../秒。
 * @returns {Promise<{ack: any, cmd: number, seconds: number}>}
 */
export function setAutolock(client: import("./transport.js").Hub3WsClient, { deviceId, secretKey, seconds, timeoutMs }: {
    deviceId: string;
    secretKey: string;
    seconds: number;
    timeoutMs?: number;
}): Promise<{
    ack: any;
    cmd: number;
    seconds: number;
}>;
import { Buffer } from "node:buffer";
//# sourceMappingURL=lock.d.ts.map