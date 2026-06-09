// SESAME ロック (WM2 / SESAME 4/5/Pro / SESAME 6 等) のクラウド経由制御。
//
// Ported from biz3 (CANDY-HOUSE/biz3, MIT):
//   - vendor reference: references_web/src/api/useIotCtrl.js (sendCommandToWM2)
//
// 設計メモ:
//   - `biz3TriggerLocker` リクエストには op フィールドが無い (`{action, cmd, sign, history, device_id}`)
//   - 応答は同期 ack ではなく、async push `biz3TriggerLocker:pubDeviceStateChange` で届く
//     → request/response ペアリングではなく subscribe して target deviceId のメッセージを待つ
//   - cmd code: 82=LOCK / 83=UNLOCK / 88=TOGGLE (cloud only) / 89=CLICK (Bot)
//   - sign は 256 秒粒度の時刻 CMAC。リプレイ耐性はサーバ側ウィンドウ任せ。
//   - subUUID はログインユーザ自身の UUID (history 経由でサーバ側操作ログに残る)

import { Buffer } from "node:buffer";
import { cmacTime, uuidToHistoryBase64, CMD } from "./crypto.js";
import { ACTION_TYPES } from "../vendor/biz3/constants/messageConstants.js";
import { t } from "./i18n.js";
import { SesameError, ERR } from "./errors.js";

const TRIGGER_ACTION = ACTION_TYPES.BIZ3_TRIGGER_LOCKER; // "biz3TriggerLocker" (vendor 由来)
// 同期 ack のキー: サーバは {action:"biz3TriggerLocker", code:200, data:{}, success:true} を
// op 無しで返す → transport の dispatch キーは `biz3TriggerLocker:` (op 空)。
const ACK_KEY = `${TRIGGER_ACTION}:`;
// 状態 push (来る環境なら): {action:"biz3TriggerLocker", op:"pubDeviceStateChange", data:{deviceUUID,...}}
const STATE_EVENT_KEY = `${TRIGGER_ACTION}:pubDeviceStateChange`;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * 内部: biz3TriggerLocker フレームを送信し、サーバの **同期 ack** を待って解決する。
 *
 * 実機観測 (2026, /production): biz3TriggerLocker は送信に対し
 *   `{action:"biz3TriggerLocker", code:200, data:{}, success:true}` を**即時 ack** で返す。
 * 旧実装は `pubDeviceStateChange` push を待っていたが、このアカウント/デバイスでは push が
 * 来ず timeout 誤判定していた (コマンド自体はサーバ受理済みなのに失敗扱い)。よって ack で解決し、
 * pubDeviceStateChange は来た場合のみ補助的に解決トリガにする (デバイス差異への保険)。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{cmd:number, sign:string, history:string, deviceId:string, timeoutMs?:number}} f
 * @returns {Promise<any>} ack (または state push) メッセージ
 */
function dispatchTrigger(client, { cmd, sign, history, deviceId, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  // sign は時刻 CMAC で 256 秒粒度。未接続で queue に積まれ 256 秒超過すると署名期限切れ。
  // lock は queue させず即 throw (Review H-3)。
  if (client.getStatus && client.getStatus() !== "open") {
    throw new SesameError(t("domain.lock.notConnected"), { code: ERR.NOT_CONNECTED, retryable: true });
  }
  const target = normalizeUuid(deviceId);

  return new Promise((resolve, reject) => {
    let done = false;
    const cleanup = () => { clearTimeout(to); unsubAck(); unsubState(); };
    const succeed = (msg) => { if (done) return; done = true; cleanup(); resolve(msg); };
    const fail = (err) => { if (done) return; done = true; cleanup(); reject(err); };

    const to = setTimeout(
      () => fail(new SesameError(t("domain.lock.timeout", { cmd, device: target }), { code: ERR.TIMEOUT, retryable: true })),
      timeoutMs,
    );

    // (主) 同期 ack。success:false は明示的失敗、それ以外 (code:200/success:true) は成功。
    const unsubAck = client.subscribe(ACK_KEY, (msg) => {
      if (msg && msg.success === false) {
        fail(new SesameError(
          t("domain.lock.failed", { cmd, code: msg.code ?? "?", message: msg.message || "" }).trim(),
          { code: ERR.REJECTED, retryable: false, data: { upstreamCode: msg.code ?? null } },
        ));
        return;
      }
      succeed(msg);
    });

    // (副) 状態 push。data.deviceUUID 一致のときのみ解決 (来ない環境では無視される)。
    const unsubState = client.subscribe(STATE_EVENT_KEY, (msg) => {
      const incoming = normalizeUuid(msg?.data?.deviceUUID || msg.deviceUUID || msg.device_id);
      if (incoming && incoming !== target) return;
      succeed(msg);
    });

    client.send({ action: TRIGGER_ACTION, cmd, sign, history, device_id: deviceId });
  });
}

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
export async function triggerLock(client, params) {
  const bad = (m) => new SesameError(t(m), { code: ERR.BAD_REQUEST });
  if (!params.deviceId) throw bad("domain.lock.deviceIdRequired");
  if (!params.secretKey) throw bad("domain.lock.secretKeyRequired");
  if (!params.subUUID) throw bad("domain.lock.subUUIDRequired");
  if (typeof params.cmd !== "number") throw bad("domain.lock.cmdRequired");

  const sign = cmacTime(params.secretKey);
  const history = uuidToHistoryBase64(params.subUUID);
  return dispatchTrigger(client, {
    cmd: params.cmd,
    sign,
    history,
    deviceId: params.deviceId,
    timeoutMs: params.timeoutMs,
  });
}

/** ロックを施錠 (cmd=82)。 */
export function lockLock(client, p) { return triggerLock(client, { ...p, cmd: CMD.LOCK }); }
/** ロックを解錠 (cmd=83)。 */
export function lockUnlock(client, p) { return triggerLock(client, { ...p, cmd: CMD.UNLOCK }); }
/** ロックを反転 (cmd=88, cloud のみ)。現在状態に応じてサーバが LOCK/UNLOCK を判定。 */
export function lockToggle(client, p) { return triggerLock(client, { ...p, cmd: CMD.TOGGLE }); }
/** SESAME Bot のボタンクリック (cmd=89)。 */
export function botClick(client, p) { return triggerLock(client, { ...p, cmd: CMD.CLICK }); }

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
export async function triggerItemCommand(client, params) {
  const bad = (m) => new SesameError(t(m), { code: ERR.BAD_REQUEST });
  if (!params.deviceId) throw bad("domain.lock.deviceIdRequired");
  if (!params.secretKey) throw bad("domain.lock.secretKeyRequired");
  if (typeof params.cmd !== "number") throw bad("domain.lock.cmdRequired");

  const sign = cmacTime(params.secretKey);
  let history;
  if (params.payload != null) {
    history = Buffer.from(params.payload).toString("base64");
  } else if (params.subUUID) {
    history = uuidToHistoryBase64(params.subUUID);
  } else {
    throw bad("domain.lock.payloadOrSubUUID");
  }

  return dispatchTrigger(client, {
    cmd: params.cmd,
    sign,
    history,
    deviceId: params.deviceId,
    timeoutMs: params.timeoutMs,
  });
}

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
export async function setAutolock(client, { deviceId, secretKey, seconds, timeoutMs }) {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 0xffff) {
    throw new SesameError(t("domain.lock.secondsRange"), { code: ERR.BAD_REQUEST });
  }
  // 2byte リトルエンディアン (SDK: delay.toShort().toReverseBytes())。
  const payload = Buffer.from([seconds & 0xff, (seconds >> 8) & 0xff]);
  const ack = await triggerItemCommand(client, { deviceId, secretKey, cmd: CMD.AUTOLOCK, payload, timeoutMs });
  return { ack, cmd: CMD.AUTOLOCK, seconds };
}

function normalizeUuid(s) {
  return typeof s === "string" ? s.replace(/-/g, "").toLowerCase() : "";
}
