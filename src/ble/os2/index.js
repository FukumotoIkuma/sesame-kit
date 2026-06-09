// SESAME OS2 BLE 直接制御の公開エントリ (SESAME2/3/4・初代 Bot・初代 Bike)。
//
// クラウド (WebSocket/biz3) を介さず、PC の Bluetooth から登録済み OS2 SESAME を直接操作する。
// OS3 (src/ble/index.js の SesameBle) とは別プロトコルなので独立ファサードとして提供する。
//
// 使い方 (高レベル):
//   import { SesameOS2Ble } from "sesame-kit/ble/os2";  // 結線は別フェーズ
//   await SesameOS2Ble.use(
//     { deviceUUID, secretKey, keyIndex, ssmPublicKey, model: "sesame_3" },
//     async (lock) => {
//       await lock.unlock();
//       await lock.autolock(30);
//       console.log(lock.lastStatus);
//     });
//
// OS2 login は OS3 と違い、デバイス公開鍵 (ssmPublicKey) との ECDH を要する。よって
// secretKey に加え keyIndex (userIdx) / ssmPublicKey が必須 (sesame2KeyData の各フィールド相当)。

import { Buffer } from "node:buffer";
import { SesameOS2BleSession } from "./session.js";
import {
  OP, ITEM, MECH_STATE, historyTag, autolockData,
  lockPositionData, botUpdateSettingData, enableDfuData,
} from "./protocol.js";
import { makeLocalRegisterServer } from "../../crypto.js";

export { SesameOS2BleSession, BleResultError } from "./session.js";
// makeLocalRegisterServer: getRegisterKey (CHServerAuth 相当) を register() の registerServer
// コールバックに合わせるローカルアダプタ。クラウドを介さずオフラインで server-auth register を
// 走らせたいときに registerServer に渡す (詳細は src/crypto.js の JSDoc / UNVERIFIED 注記を参照)。
export { makeLocalRegisterServer } from "../../crypto.js";
export { RESULT as SESAME_RESULT_CODES, resultName, OP, ITEM, MECH_STATE } from "./protocol.js";
export * as protocol from "./protocol.js";
export { SesameOS2BleCipher } from "./cipher.js";

const STATUS_WAIT_MS = 4_000;

/**
 * @typedef {object} SesameOS2BleOptions
 * @property {string|Buffer} [secretKey] 16B / 32hex ロック共通鍵。register モードでは不要。
 * @property {string|Buffer} [keyIndex] userIdx (sesame2KeyData.keyIndex)。
 * @property {string|Buffer} [ssmPublicKey] デバイス公開鍵 64B。
 * @property {string} [deviceUUID]
 * @property {string|null} [model]
 * @property {boolean} [registerMode]
 * @property {Function|null} [registerServer]
 * @property {boolean} [localServerAuth]
 * @property {boolean} [needAuthFromServer]
 * @property {(signPayloadHex:string)=>Promise<string>} [signLogin]
 * @property {boolean} [debug]
 * @property {object} transport BLE transport。OS2 facade では必須。
 */

/**
 * 登録済み OS2 SESAME を BLE で直接操作する高レベルファサード。
 * 操作の対応関係は SDK の各 OS2 デバイスクラスに準拠:
 *   - SESAME2/3/4 : lock / unlock / toggle / autolock / history
 *   - Bot1        : click (lock/unlock も内部的に同 motor 動作だが SDK は click を主とする)
 *   - Bike1       : unlock のみ (施錠は手動)
 */
export class SesameOS2Ble {
  /**
   * @param {SesameOS2BleOptions} [opts]
   */
  constructor(opts = {}) {
    const {
    secretKey, keyIndex, ssmPublicKey, deviceUUID, model = null,
    registerMode = false, registerServer = null, localServerAuth = false, needAuthFromServer = false, signLogin = null,
    debug = false, transport,
    } = opts;
    if (!transport) throw new Error("transport required (inject a BLE transport)");
    if (!registerMode && !secretKey && !needAuthFromServer) throw new Error("secretKey required (32hex) for OS2 login");
    this._transport = transport;
    this._session = new SesameOS2BleSession({
      transport,
      secretKey: registerMode ? undefined : secretKey,
      keyIndex,
      ssmPublicKey,
      debug,
    });
    this._model = model;
    this._deviceUUID = deviceUUID;
    this._registerMode = registerMode;
    // registerServer 明示指定が最優先。未指定かつ localServerAuth=true ならローカル
    // getRegisterKey アダプタ (makeLocalRegisterServer) を自動生成して充てる
    // (クラウド不要のオフライン server-auth register。getRegisterKey は UNVERIFIED)。
    this._registerServer = registerServer
      || (localServerAuth ? makeLocalRegisterServer() : null);
    this._needAuthFromServer = !!needAuthFromServer;
    this._signLogin = typeof signLogin === "function" ? signLogin : null;
    this._debug = debug;
  }

  get model() { return this._model; }
  get isConnected() { return this._session.isLoggedIn; }
  get lastStatus() { return this._session.lastStatus; }
  /** login response (systemTime / fwVersion / historyCnt / mechSetting / mechStatus)。 */
  get loginInfo() { return this._session.lastLoginResponse; }

  onStatus(fn) { return this._session.onStatus(fn); }

  /**
   * 接続 + login。needAuthFromServer=true のときは signLogin 経由でサーバ署名 sessionAuth を使う。
   */
  async connect() {
    try {
      if (this._needAuthFromServer) {
        if (typeof this._signLogin !== "function") throw new Error("needAuthFromServer requires a signLogin callback");
        await this._session.connect({ signLogin: this._signLogin });
      } else {
        await this._session.connect();
      }
    } catch (err) {
      await this._session.disconnect().catch(() => {});
      throw err;
    }
    return this;
  }

  async close() { await this._session.disconnect(); }

  /**
   * 工場出荷 (未登録) デバイスの登録 (ECDH + サーバ認証)。registerMode:true で構築した場合に呼ぶ。
   * @param {{deviceUUID?:string, productType?:(string|number), ak?:Buffer}} [opts]
   * @returns {Promise<{deviceUUID:string, secretKey:string, ownerKey:string, sesamePublicKey:string, serverSecret:string}>}
   */
  async register({ deviceUUID, productType, ak } = {}) {
    if (typeof this._registerServer !== "function") throw new Error("register() requires a registerServer callback");
    return this._session.register({
      deviceUUID: deviceUUID || this._deviceUUID,
      productType: productType ?? this._model ?? undefined,
      registerServer: this._registerServer,
      ak,
    });
  }

  /** 施錠 (OP.async, item=82)。SESAME2/3/4。tag は履歴に残す任意バイト列。 */
  lock(tag) { return this._session.request(OP.ASYNC, ITEM.LOCK, historyTag(tag)); }

  /** 解錠 (OP.async, item=83)。SESAME2/3/4 と Bike1。 */
  unlock(tag) { return this._session.request(OP.ASYNC, ITEM.UNLOCK, historyTag(tag)); }

  /** SESAME Bot1 のクリック (OP.async, item=89)。 */
  click(tag) { return this._session.request(OP.ASYNC, ITEM.CLICK, historyTag(tag)); }

  /**
   * トグル (SESAME2/3/4)。直近の mechStatus が無ければ status() を取得してから判定。
   * locked → unlock、それ以外 → lock (CHSesame2Device.kt:165-178 / 172-176)。
   */
  async toggle(tag) {
    let s = this.lastStatus;
    if (!s) s = await this.status().catch(() => null);
    if (s && s.state === MECH_STATE.LOCKED) return this._session.request(OP.ASYNC, ITEM.UNLOCK, historyTag(tag));
    return this._session.request(OP.ASYNC, ITEM.LOCK, historyTag(tag));
  }

  /**
   * オートロック設定 (OP.update, item=11、2byte LE 秒数 ++ historyTag。0=無効)。SESAME2/3/4。
   * **BLE 経由なら実機に反映される** (クラウドの biz3TriggerLocker では ack のみで未反映だった機能)。
   * @param {number} seconds 0..65535
   * @param {Buffer} [tag]
   */
  autolock(seconds, tag) { return this._session.request(OP.UPDATE, ITEM.AUTOLOCK, autolockData(seconds, tag)); }

  /** オートロック無効化 (= autolock(0))。CHSesame2Device.kt:150-152。 */
  disableAutolock(tag) { return this.autolock(0, tag); }

  /**
   * 現在のオートロック秒数を取得 (OP.read, item=11)。応答 payload は LE 秒数 (CHSesame2Device.kt:157-160)。
   * @returns {Promise<number>}
   */
  async getAutolock() {
    const r = await this._session.request(OP.READ, ITEM.AUTOLOCK, Buffer.alloc(0));
    // payload を reversedArray して整数化 (CHSesame2Device.kt:159 java.lang.Long.parseLong(reversed.toHex,16))。
    // = LE 整数。長さ可変に備え readUIntLE で読む。
    return r.payload.length ? r.payload.readUIntLE(0, r.payload.length) : 0;
  }

  /**
   * versionTag を取得 (OP.read, item=5)。payload[4..15] が ASCII version 文字列 (CHSesame2Device.kt:131-133)。
   * @returns {Promise<string>}
   */
  async versionTag() {
    const r = await this._session.request(OP.READ, ITEM.VERSION_TAG, Buffer.alloc(0));
    return r.payload.subarray(4, 16).toString("latin1");
  }

  /**
   * 現在の mechStatus を返す。未受信なら publish を待つ (timeout 付き)。
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<object>} parseMechStatus の結果
   */
  status({ timeoutMs = STATUS_WAIT_MS } = {}) {
    if (this._session.lastStatus) return Promise.resolve(this._session.lastStatus);
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => { off(); reject(new Error("could not receive mechStatus (timeout)")); }, timeoutMs);
      const off = this._session.onStatus((s) => { clearTimeout(to); off(); resolve(s); });
    });
  }

  /**
   * 履歴を 1 バッチ取得 (OP.read, item=4)。payload の解析は呼び出し側 (生バイト返し)。
   * SDK は isInternetAvailable() で 0x01/0x00 を切り替える (CHSesame2Device.kt:606-612)。
   * BLE 直接用途では既定 0x01 (取得後デバイス側で消す挙動) を送る。
   * @param {{ack?:boolean}} [opts] ack=false で 0x00 (消さずに読むだけ)
   * @returns {Promise<Buffer>}
   */
  async history({ ack = true } = {}) {
    const r = await this._session.request(OP.READ, ITEM.HISTORY, Buffer.from([ack ? 0x01 : 0x00]));
    return r.payload;
  }

  /** 工場出荷状態へリセット (OP.delete, item=registration)。CHSesame2Device.kt:570-578。 */
  async reset() {
    return this._session.request(OP.DELETE, ITEM.REGISTRATION, Buffer.alloc(0));
  }

  /**
   * SESAME2/3/4 の施錠/解錠角を設定する (OP.update, item=80=mechSetting)。
   * CHSesame2Device.kt:556-568 を 1:1 で移植。送信 data = lockPositionConfiguration(deg) ++ createHistag(null)
   * (12B 角設定 ++ 22B 履歴タグ枠 = 34B)。引数は度数で、内部で tick (deg*1024/360) と ±150 range に変換する。
   * @param {number} lockDeg   施錠角 (度)
   * @param {number} unlockDeg 解錠角 (度)
   * @returns {Promise<{resultCode:number, payload:Buffer}>}
   */
  configureLockPosition(lockDeg, unlockDeg) {
    return this._session.request(OP.UPDATE, ITEM.MECH_SETTING, lockPositionData(lockDeg, unlockDeg));
  }

  /**
   * 初代 SESAME Bot の mech_setting を更新する (OP.update, item=80=mechSetting)。
   * CHSesameBotDevice.kt:418-430 を 1:1 で移植。送信 data = setting.data() ++ createHistag(tag)
   * (12B 設定 ++ 22B 履歴タグ枠 = 34B)。Bot 以外では呼ばない (SDK は CHSesameBot 専用)。
   * @param {{userPrefDir:number, lockSec:number, unlockSec:number, clickLockSec:number,
   *          clickHoldSec:number, clickUnlockSec:number, buttonMode:number}} setting
   * @param {Buffer} [tag] 履歴タグ
   * @returns {Promise<{resultCode:number, payload:Buffer}>}
   */
  updateSetting(setting, tag) {
    return this._session.request(OP.UPDATE, ITEM.MECH_SETTING, botUpdateSettingData(setting, tag));
  }

  /**
   * BLE DFU (ファームウェア更新) を開始する (OP.update, item=7=enableDFU、payload "01")。
   * CHSesame2Device.kt:580-599 を移植。login 済みデバイスを前提とし暗号化経路で開始コマンドを送る
   * (SDK の isRegistered=true 経路、:584)。未登録時の平文経路 (:592) はこのファサードの対象外。
   *
   * ★本メソッドは **DFU 開始コマンドの送信のみ** を行う。開始後デバイスは DFU ブートローダへ
   *   遷移し切断される想定で、本体ファーム (Nordic DFU 等の OTA バイナリ) の転送は
   *   別 GATT サービスを扱う外部 DFU 層の責務。実機での DFU 完遂は未検証。
   * @returns {Promise<{resultCode:number, payload:Buffer}>}
   */
  updateFirmware() {
    return this._session.request(OP.UPDATE, ITEM.ENABLE_DFU, enableDfuData());
  }

  /**
   * connect → fn → close を自動で行うヘルパー。
   * @param {object} opts コンストラクタ opts
   * @param {(lock:SesameOS2Ble)=>Promise<any>} fn
   */
  static async use(opts, fn) {
    const lock = new SesameOS2Ble(opts);
    await lock.connect();
    try { return await fn(lock); }
    finally { await lock.close(); }
  }

  /**
   * 工場出荷デバイスを connect → register → close まで自動化する。
   * @param {object} opts コンストラクタ opts (registerServer 必須)
   * @param {(result:object)=>Promise<any>} [fn] 登録結果コールバック (鍵の保存など)
   * @returns {Promise<object>} 登録結果
   */
  static async registerOnce(opts = {}, fn) {
    const { productType, ak, ...ctorOpts } = opts;
    const ble = new SesameOS2Ble({ ...ctorOpts, registerMode: true });
    try {
      const result = await ble.register({ productType, ak });
      if (typeof fn === "function") await fn(result);
      return result;
    } finally {
      await ble.close().catch(() => {});
    }
  }
}
