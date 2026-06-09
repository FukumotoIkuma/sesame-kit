// ロック制御の関心事を SesameHub3 (client.js) から切り出した凝集ユニット。
//
// client.js が IR / devices / config 同期 / account / lock を 1 クラスに抱える
// "god object" 化していたため、name 解決 (config の locks/default.lock) と
// lock 操作 (name-based / direct) をここに集約する。client.js は本クラスへ薄く委譲する
// だけになり、ロックロジックを WS/config をモックして単体テストできる。
//
// 状態 (ws / subUUID) は connect 前後で変わるため、値ではなく **アクセサ** を受け取り
// 毎回最新を読む (client.js が再 connect しても追従する)。
//
// API の 2 系統 (client.js と同じ):
//   - name-based : config の locks/default.lock を名前解決 (`unlock("front")`)
//   - direct     : config を介さず deviceUUID + secretKey を直接渡す (`unlockDevice({...})`)

import { lockLock, lockUnlock, lockToggle, botClick, triggerLock, setAutolock } from "./lock.js";
import { CMD } from "./crypto.js";
import { t } from "./i18n.js";
import { SesameError, ERR } from "./errors.js";

export class LockManager {
  /**
   * @param {{
   *   getWs: () => (import("./transport.js").Hub3WsClient | null),
   *   getConfig: () => object,
   *   getSubUUID: () => (string | null),
   *   ensureConnected: () => void,
   * }} accessors
   */
  constructor({ getWs, getConfig, getSubUUID, ensureConnected }) {
    this._getWs = getWs;
    this._getConfig = getConfig;
    this._getSubUUID = getSubUUID;
    this._ensureConnected = ensureConnected;
  }

  /**
   * lock 設定を name から解決。name 省略時は default.lock、
   * 無ければ locks が 1 つだけならそれ。
   */
  resolveLock(name) {
    const cfg = this._getConfig();
    const locks = cfg.locks || {};
    const names = Object.keys(locks);
    const chosen = name || cfg.default?.lock || (names.length === 1 ? names[0] : null);
    if (!chosen) {
      throw new SesameError(t("domain.client.noLockNoDefault", { names: names.join(", ") || "(none)" }), { code: ERR.BAD_REQUEST });
    }
    const lock = locks[chosen];
    if (!lock) throw new SesameError(t("domain.client.unknownLock", { name: chosen, names: names.join(", ") || "(none)" }), { code: ERR.BAD_REQUEST });
    return { name: chosen, lock };
  }

  /** name 解決 + 必須フィールド検査 → triggerLock 用 params。 */
  _lockParams(name) {
    const subUUID = this._getSubUUID();
    if (!subUUID) throw new SesameError(t("domain.client.subUUIDNotAvailableConnect"), { code: ERR.NOT_CONNECTED, retryable: true });
    const { lock } = this.resolveLock(name);
    if (!lock.deviceUUID) throw new SesameError(t("domain.client.lockMissingDeviceUUID", { name: name || "(default)" }), { code: ERR.BAD_REQUEST });
    if (!lock.secretKey) throw new SesameError(t("domain.client.lockMissingSecretKey", { name: name || "(default)" }), { code: ERR.BAD_REQUEST });
    return { deviceId: lock.deviceUUID, secretKey: lock.secretKey, subUUID };
  }

  // ---------- name-based ----------

  /** ロック施錠 (name-based, cmd=82)。 */
  async lock(name) {
    this._ensureConnected();
    return lockLock(this._getWs(), this._lockParams(name));
  }

  /** ロック解錠 (name-based, cmd=83)。 */
  async unlock(name) {
    this._ensureConnected();
    return lockUnlock(this._getWs(), this._lockParams(name));
  }

  /** トグル (name-based, cmd=88, cloud のみの合成命令)。 */
  async toggle(name) {
    this._ensureConnected();
    return lockToggle(this._getWs(), this._lockParams(name));
  }

  /** SESAME Bot クリック (name-based, cmd=89)。 */
  async botClick(name) {
    this._ensureConnected();
    return botClick(this._getWs(), this._lockParams(name));
  }

  /** 任意 cmd 直指定 (上級用)。 */
  async triggerRaw(name, cmd) {
    this._ensureConnected();
    return triggerLock(this._getWs(), { ...this._lockParams(name), cmd });
  }

  /**
   * オートロック設定 (name-based)。解錠 N 秒後に自動施錠。`seconds=0` で無効。
   * @param {string|null} name ロック名 (null で default.lock)
   * @param {number} seconds 0..65535 (0=無効)
   * @param {number} [timeoutMs] ack 待ちタイムアウト
   */
  async setAutolock(name, seconds, timeoutMs) {
    this._ensureConnected();
    const { deviceId, secretKey } = this._lockParams(name); // subUUID は autolock では未使用
    return setAutolock(this._getWs(), { deviceId, secretKey, seconds, timeoutMs });
  }

  // ---------- direct (config-less) ----------

  /**
   * 直接 lock 制御 (config を介さない, 任意 cmd)。`unlockDevice`/`lockDevice` 等の基底。
   * @param {{deviceUUID:string, secretKey:string, cmd:number, timeoutMs?:number}} p
   */
  async triggerDevice({ deviceUUID, secretKey, cmd, timeoutMs }) {
    this._ensureConnected();
    const subUUID = this._getSubUUID();
    if (!subUUID) throw new SesameError(t("domain.client.subUUIDNotAvailable"), { code: ERR.NOT_CONNECTED, retryable: true });
    return triggerLock(this._getWs(), { deviceId: deviceUUID, secretKey, subUUID, cmd, timeoutMs });
  }

  /** 直接 解錠 (cmd=83)。 */
  unlockDevice(p)   { return this.triggerDevice({ ...p, cmd: CMD.UNLOCK }); }
  /** 直接 施錠 (cmd=82)。 */
  lockDevice(p)     { return this.triggerDevice({ ...p, cmd: CMD.LOCK }); }
  /** 直接 トグル (cmd=88)。 */
  toggleDevice(p)   { return this.triggerDevice({ ...p, cmd: CMD.TOGGLE }); }
  /** 直接 Bot クリック (cmd=89)。 */
  botClickDevice(p) { return this.triggerDevice({ ...p, cmd: CMD.CLICK }); }
}
