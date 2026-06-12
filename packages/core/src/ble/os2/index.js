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
  OP, ITEM, MECH_STATE, createHistag, autolockData,
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
 * 登録済み OS2 SESAME を BLE で直接操作する高レベルファサード。
 * 操作の対応関係は SDK の各 OS2 デバイスクラスに準拠:
 *   - SESAME2/3/4 : lock / unlock / toggle / autolock / history
 *   - Bot1        : click (lock/unlock も内部的に同 motor 動作だが SDK は click を主とする)
 *   - Bike1       : unlock のみ (施錠は手動)
 */
/**
 * SesameOS2Ble のコンストラクタ opts。
 * @typedef {object} SesameOS2BleOptions
 * @property {string|Buffer} [secretKey] ロック共通鍵 (16B / 32hex)。login 必須、register モードでは不要。
 * @property {string|Buffer} [keyIndex] userIdx (sesame2KeyData.keyIndex)。login の signPayload に使う。既定 "0000" (CHSesame2Device.kt:465 の登録時永続値)。
 * @property {string|Buffer} [ssmPublicKey] デバイス公開鍵 (64B, sesame2KeyData.sesame2PublicKey)。login の ECDH 相手。
 * @property {string} [deviceUUID]
 * @property {string|null} [model] "sesame_2" / "sesame_3" / "sesame_4" / "ssmbot_1" / "bike_1"。
 * @property {boolean} [registerMode] 工場出荷デバイスの register() 用。
 * @property {Function|null} [registerServer] register() のサーバ登録コールバック (myDevicesRegisterSesame2Post 相当)。
 * @property {boolean} [localServerAuth] true で registerServer をローカル getRegisterKey から自動生成 (makeLocalRegisterServer)。registerServer 明示指定時はそちらを優先。UNVERIFIED。
 * @property {boolean} [needAuthFromServer] ゲスト鍵等: connect 時に signLogin でサーバ署名 sessionAuth を取得。
 * @property {((signPayloadHex:string)=>Promise<string>)|null} [signLogin] needAuthFromServer の署名コールバック。
 * @property {boolean} [debug]
 * @property {import("../session.js").BleTransport} [transport] BLE トランスポート (OS3 と共通の transport.js を注入)。実行時必須 (未指定はコンストラクタが throw)。
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
      // model を session へ伝搬: Bot/Bike は timePhone 条件が Sesame2/3/4 と異なるため (P3-14)。
      model,
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
  /**
   * login response (systemTime / fwVersion / historyCnt / mechSetting / mechSettingBot /
   * mechSettingBytes / isConfigured / mechStatus)。BLE2-07 で mechSetting は解析済みオブジェクト
   * (Sesame2: {lockPosition, unlockPosition, isConfigured} — 度数、CHSesame2.kt:24-28 /
   * Bot1 は mechSettingBot の 7 フィールド — CHSesameBikeDevice.kt:520)。
   * `loginInfo.isConfigured === false` は角度未キャリブレーション (SDK の NoSettings 状態、
   * CHSesame2Device.kt:268)。
   */
  get loginInfo() { return this._session.lastLoginResponse; }

  /** @param {(status:any)=>void} fn */
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
   * 戻り値の {secretKey(=ownerKey hex), keyIndex("0000"), sesamePublicKey} はそのまま次回 login の
   * コンストラクタ {secretKey, keyIndex, ssmPublicKey} に渡せる (CHSesame2Device.kt:462-469 の
   * CHDevice 永続化フィールドと同じ契約)。
   * @param {{deviceUUID?:string, productType?:(string|number), ak?:Buffer}} [opts]
   * @returns {Promise<{deviceUUID:string, secretKey:string, keyIndex:string, ownerKey:string,
   *                    ecdhSecret:string, sesamePublicKey:string, serverSecret:string}>}
   */
  async register({ deviceUUID, productType, ak } = {}) {
    if (typeof this._registerServer !== "function") throw new Error("register() requires a registerServer callback");
    return this._session.register({
      deviceUUID: deviceUUID || this._deviceUUID,
      productType: productType ?? this._model ?? undefined,
      registerServer: /** @type {NonNullable<Parameters<typeof this._session.register>[0]>["registerServer"]} */ (this._registerServer),
      ak,
    });
  }

  /**
   * 施錠 (OP.async, item=82)。SESAME2/3/4。tag は履歴に残す任意バイト列。
   * data = createHistag(tag) の **22B 固定** (CHSesame2Device.kt:185: SSM2OpCode.async, lock,
   * sesame2KeyData.createHistag(historytag) / Bot は CHSesameBotDevice.kt:370)。
   * @param {Buffer|Uint8Array} [tag]
   */
  lock(tag) { return this._session.request(OP.ASYNC, ITEM.LOCK, createHistag(tag)); }

  /**
   * 解錠 (OP.async, item=83)。SESAME2/3/4 と Bike1。data = createHistag(tag) 22B
   * (CHSesame2Device.kt:201 / Bot CHSesameBotDevice.kt:387 / Bike CHSesameBikeDevice.kt:311)。
   * @param {Buffer|Uint8Array} [tag]
   */
  unlock(tag) { return this._session.request(OP.ASYNC, ITEM.UNLOCK, createHistag(tag)); }

  /**
   * SESAME Bot1 のクリック (OP.async, item=89)。data = createHistag(tag) 22B
   * (CHSesameBotDevice.kt:408)。
   * @param {Buffer|Uint8Array} [tag]
   */
  click(tag) { return this._session.request(OP.ASYNC, ITEM.CLICK, createHistag(tag)); }

  /**
   * トグル (SESAME2/3/4)。直近の mechStatus が無ければ status() を取得してから判定。
   * locked → unlock、それ以外 → lock (CHSesame2Device.kt:165-178 / 172-176)。
   * @param {Buffer|Uint8Array} [tag]
   */
  async toggle(tag) {
    let s = this.lastStatus;
    if (!s) s = await this.status().catch(() => null);
    if (s && s.state === MECH_STATE.LOCKED) return this._session.request(OP.ASYNC, ITEM.UNLOCK, createHistag(tag));
    return this._session.request(OP.ASYNC, ITEM.LOCK, createHistag(tag));
  }

  /**
   * オートロック設定 (OP.update, item=11、2byte LE 秒数 ++ createHistag(tag) = 24B。0=無効。
   * CHSesame2Device.kt:141)。SESAME2/3/4。
   * **BLE 経由なら実機に反映される** (クラウドの biz3TriggerLocker では ack のみで未反映だった機能)。
   * @param {number} seconds 0..65535
   * @param {Buffer|Uint8Array} [tag]
   */
  autolock(seconds, tag) { return this._session.request(OP.UPDATE, ITEM.AUTOLOCK, autolockData(seconds, tag)); }

  /** オートロック無効化 (= autolock(0))。CHSesame2Device.kt:150-152。 @param {Buffer|Uint8Array} [tag] */
  disableAutolock(tag) { return this.autolock(0, tag); }

  /**
   * 現在のオートロック秒数を取得 (OP.read, item=11)。応答 payload は LE 秒数 (CHSesame2Device.kt:157-160)。
   * @returns {Promise<number>}
   */
  async getAutolock() {
    const r = await this._session.request(OP.READ, ITEM.AUTOLOCK, Buffer.alloc(0));
    // payload を reversedArray して整数化: CHSesame2Device.kt:159
    //   `java.lang.Long.parseLong(res.payload.reversedArray().toHexString(), 16).toInt()`
    // = バイト列を LE として読んで Long(64bit) に収める。
    // Node.js readUIntLE は最大 6B。7〜8B でもゼロ上位なら同値だが readUIntLE は throw する。
    // 上位バイトが 0 の場合のみ下位 6B を readUIntLE で読む (1:1 対応)。
    // 実ファームの autolock 値は秒数 (u32 相当) であり 6B 超はほぼ発生しないが、
    // 参照が 8B まで許容するため同等の明示処理を行う。
    const p = r.payload;
    if (!p.length) return 0;
    if (p.length <= 6) return p.readUIntLE(0, p.length);
    // 7B 以上: 上位バイトがすべて 0 なら有効下位バイトのみで readUIntLE。
    // そうでなければ BigInt 経由で Number に変換 (Long.parseLong と等価)。
    // 出典: CHSesame2Device.kt:159 (java.lang.Long は 8B 符号付き)。
    let high = 0n;
    for (let i = p.length - 1; i >= 6; i--) high = (high << 8n) | BigInt(p[i]);
    if (high === 0n) return p.readUIntLE(0, 6);
    // ゼロでない上位バイトが存在: BigInt 全体を Number に変換。
    let val = 0n;
    for (let i = p.length - 1; i >= 0; i--) val = (val << 8n) | BigInt(p[i]);
    return Number(val);
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
   *
   * ★【意図的逸脱: P3-26 / R2:BLE2-17】自動履歴読み出しは非実装。
   * SDK (CHSesame2Device.kt:543-553) は mechStatus publish 受信時に retCode != 0 または
   * target == Short.MIN_VALUE のとき readHistoryCommand{} を自動発行してサーバ POST するが、
   * kit では実装しない。デバイス内履歴バッファが蓄積する可能性があるため、必要に応じて
   * このメソッドを手動で呼び出すこと (参照: CHSesame2Device.kt:543-553)。
   *
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
   * @param {SesameOS2BleOptions} opts コンストラクタ opts
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
   * @param {SesameOS2BleOptions & {productType?:(string|number), ak?:Buffer}} opts コンストラクタ opts (registerServer 必須)
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
