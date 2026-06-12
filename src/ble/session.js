// SESAME BLE セッション状態機械 (OS 非依存)。
//
// 接続後のバイト列のやり取りだけを担い、無線 I/O は注入された transport に委譲する
// (= mock transport でハードウェア無しにテスト可能)。
//
// フロー (調査仕様 §C/D/E/F、ssm.c / CHSesameOS3LockBase.kt 準拠):
//   connect → transport.connect(onPacket)
//     → device が publish(8)+initial(14)+token4 を送る
//     → counters=0、session鍵=CMAC(secretKey, token)、login(2) を PLAINTEXT で送信
//     → device が response(7)+login(2)+resultCode を返す → resultCode==0 で接続完了
//   request(item, data) → frame を CCM 暗号化 (encCount++) → セグメント送信
//     → response(7)+item を待って {resultCode, payload} で解決
//   publish(8)+mechStatus(81) は onStatus リスナへ。
//
// 上記は profile "lock" (既定) のフロー。WifiModule2 は initial(13)・login/register/暗号鍵・sault が
// ロックと非互換のため profile "wm2" で構築する (protocol.js SESSION_PROFILES、
// CHWifiModule2Device.kt:279-321,521-528。@experimental 実機未検証)。

import { Buffer } from "node:buffer";
import { createECDH } from "node:crypto";
import { t } from "../i18n.js";
import { WM2_ACTION_CODES } from "../itemcodes.js";
import { ecdhSecretPre16 } from "../crypto.js";
import { registerSesame5 } from "../devices.js";
import {
  deriveSessionKey, deriveSessionKeyFromEcdh, loginPayload, ccmEncrypt, ccmDecrypt,
  splitSegments, SegmentAssembler, buildSendFrame, parseRecvFrame, registrationData,
  parseMechStatus, parseMechSetting, parseOpsSetting, configureLockPositionData,
  opSensorControlData, bleTxPowerData,
  timeSyncData, parseDeviceTimeSeconds, needsTimeSync,
  historyReadData, historyDeleteData, OP, ITEM, SEG, resultName,
  SESSION_PROFILES, assertProfile,
} from "./protocol.js";
import { parseBiometricMechStatus } from "./biometric.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const LOGIN_TIMEOUT_MS = 8_000;
const REGISTER_TIMEOUT_MS = 8_000;

// EC point uncompressed 形式の先頭バイト (0x04 ‖ X32 ‖ Y32 = 65B)。
// SDK の EccKey.getPubK() は prefix 無しの 64B raw (X‖Y) を送る (registrationData の契約)
// ため、Node の getPublicKey() (既定 65B) から先頭 1B を剥がして 64B にする。
const ECDH_UNCOMPRESSED_PREFIX = 0x04;

/**
 * BLE デバイスが非 0 の resultCode を返したときのエラー。
 * `resultName` (notFound/busy/invalidSig…) で機械的に分岐できる (SesameResultCode 由来)。
 */
export class BleResultError extends Error {
  /** @param {"login"|"command"} phase @param {number} resultCode @param {number|null} itemCode */
  constructor(phase, resultCode, itemCode = null) {
    const name = resultName(resultCode);
    // 紛らわしいコードに一言ヒント (エラーそのものに載るので別 docs を読む必要がない)。
    const hint = { invalidSig: t("ble.hintInvalidSig"), notFound: t("ble.hintNotFound"), busy: t("ble.hintBusy") }[name] || "";
    super(t("ble.bleResultFailed", {
      phase,
      name,
      hint,
      resultCode,
      itemSuffix: itemCode != null ? `, item=${itemCode}` : "",
    }));
    this.name = "BleResultError";
    this.resultCode = resultCode;
    this.resultName = name;
    this.itemCode = itemCode;
  }
}

/**
 * @typedef {object} BleTransport BLE 無線 I/O アダプタ (transport.js のアダプタが満たす契約)。
 * @property {(onPacket:(packet:Buffer)=>void, onDisconnect?:(reason:any)=>void)=>Promise<void>} connect
 *   接続+notify購読。各 notify を onPacket へ。リンク断時は onDisconnect(reason) を 1 回呼ぶ (任意)。
 * @property {(bytes:Buffer)=>void|Promise<void>} write Write Without Response。
 * @property {()=>void|Promise<void>} disconnect 切断。
 */

/**
 * @typedef {object} Waiter ハンドシェイク待機者 (login/ready/register の Promise 制御)。
 * @property {(value?:any)=>void} resolve
 * @property {(err:Error)=>void} reject
 * @property {any} timer setTimeout ハンドル。
 */

export class SesameBleSession {
  /**
   * @param {{transport:BleTransport, secretKey?:string|Buffer, debug?:boolean,
   *          defaultTimeoutMs?:number, profile?:("lock"|"wm2"), syncTime?:boolean}} opts
   *   secretKey は **登録済みデバイスへのログイン時のみ必須**。工場出荷 (未登録) デバイスを
   *   register() で登録する場合は secretKey を渡さずに構築する (initial 受信で login を試みず
   *   ReadyToRegister 状態へ遷移する。CHSesameOS3.kt:468-491 isRegistered=false 相当)。
   *
   *   profile はセッション確立のワイヤ形状 (protocol.js SESSION_PROFILES):
   *     - "lock" (既定): CHSesameOS3 基底のロック系 (SESAME5/Hub3/Bot2/Bike2/3/biometric)。
   *     - "wm2": WifiModule2。CHWifiModule2Device.kt は initial(13)/login/register を
   *       オーバーライドしており非互換 (kt:279-321,521-528)。鍵 = secretKey/pre16 **生 16B**、
   *       login payload = CMAC 16B 全量、register data = pubK64 のみ、CCM sault = token4 (12B nonce)。
   *       @experimental WM2 profile は SDK Kotlin の静的読みからの移植で **実機未検証**
   *       (参照: CHWifiModule2Device.kt:279-321 / SesameOS3BleCipher.kt:8-32)。
   *
   *   syncTime (既定 true): login 成功後の time(8) 自動同期を行うか (BLE3-03)。
   *     CHSesameOS3LockBase.kt:126-138 handleLoginResponse の時刻同期は **ロック系のみ** の挙動で、
   *     Hub3 は login を override して handleLoginResponse を呼ばない (CHHub3Device.kt:167-178 —
   *     login 応答はコールバックで deviceStatus 遷移のみ)。WM2 も同様 (CHWifiModule2Device.kt:314-321。
   *     こちらは profile="wm2" で構造的に対象外)。ファサード (index.js) は kind が HUB3/WIFI の
   *     とき false を渡す。
   */
  constructor({ transport, secretKey, debug = false, defaultTimeoutMs = DEFAULT_TIMEOUT_MS, profile = "lock", syncTime = true }) {
    if (!transport) throw new Error(t("ble.transportRequired"));
    // secretKey 無し = 工場出荷デバイスの register() 用。connect()/login は secretKey を要求する。
    this._transport = transport;
    this._secretKey = secretKey == null
      ? null
      : (Buffer.isBuffer(secretKey) ? secretKey : Buffer.from(secretKey, "hex"));
    this._debug = debug;
    this._defaultTimeoutMs = defaultTimeoutMs;
    /** @type {"lock"|"wm2"} セッション確立プロファイル (protocol.js SESSION_PROFILES)。 */
    this._profile = assertProfile(profile);
    /** @type {boolean} login 後の time(8) 自動同期 (BLE3-03。Hub3/WM2 は false)。 */
    this._syncTime = !!syncTime;
    // initial publish の itemCode はプロファイル依存: lock=14 / wm2=13 (CHWifiModule2Device.kt:521,540)。
    this._initialItemCode = SESSION_PROFILES[this._profile].initialItemCode;

    this._asm = new SegmentAssembler();
    /** @type {Buffer|null} */
    this._token = null; // 4B initial token
    /** @type {Buffer|null} */
    this._key = null; // 16B session key
    this._encCount = 0;
    this._decCount = 0;
    this._loggedIn = false;
    this._readyToRegister = false; // initial 受信時 secretKey 無しで true (CHSesameOS3.kt:468-491)
    /** @type {import("./session.js").Waiter|null} */
    this._readyWaiter = null;      // register() 内で ReadyToRegister(=initial 受信) を待つ
    /** @type {import("./session.js").Waiter|null} */
    this._registerWaiter = null;   // register() の REGISTRATION 応答待ち

    /** @type {Map<number, Array<{resolve:(v:{resultCode:number, payload:Buffer})=>void, reject:(e:Error)=>void, timer:any}>>} item → FIFO */
    this._pending = new Map();
    /** @type {Set<(status:any)=>void>} */
    this._statusListeners = new Set();
    /** @type {Set<(pub:{opCode:number, itemCode:number, body:Buffer})=>void>} */
    this._publishListeners = new Set();
    /** @type {any} */
    this._lastStatus = null;
    /** @type {{lockPosition:number, unlockPosition:number, autoLockSecond:number}|null} */
    this._lastMechSetting = null; // 最後に受けた mechSetting (parseMechSetting の結果)
    /** @type {{opsLockSecond:number}|null} */
    this._lastOpsSetting = null;  // 最後に受けた opsSetting (parseOpsSetting の結果)
    /** @type {import("./session.js").Waiter|null} */
    this._loginWaiter = null;
    // サーバ認証 login (isNeedAuthFromServer) 用の非同期 token 解決器。
    // connect({ signLogin }) で注入される。設定時は initial 受信で
    // deriveSessionKey(secretKey, token) を使わず signLogin(tokenHex) の戻り (hex) を
    // session 鍵として login する (CHSesameOS3.kt:473-487 / CHHub3Device.kt:163-174 token!=null)。
    /** @type {((tokenHex:string)=>Promise<string>)|null} */
    this._signLogin = null;
  }

  /** @param {...any} a */
  _log(...a) { if (this._debug) console.error("[ble]", ...a); }

  /**
   * connect()/register() 再入ガード。既に login 済み、または connect/register ハンドシェイク
   * (login/ready/register いずれかの待機者) が進行中なら true。
   *
   * セッションは 1 回限りの使い捨て (transport の GATT 接続とカウンタ状態を 1 接続に束縛する)。
   * 二重 connect()/register() は _loginWaiter/_readyWaiter/_registerWaiter を上書きして前の
   * 待機者をリーク(永久ハング)させ、また再入時に古い this._token / this._key を流用して
   * カウンタ整合が壊れる。ファサード (use/registerOnce) は 1 回限りなので通常は到達しないが、
   * SesameBleSession を直接使う誤用を安全側で弾く (黙って壊れた状態に進めない)。
   */
  _isBusy() {
    return this._loggedIn || this._readyToRegister
      || this._loginWaiter != null || this._readyWaiter != null || this._registerWaiter != null;
  }

  /** 最後に受信した mechStatus (parseMechStatus の結果)。未受信なら null。 */
  get lastStatus() { return this._lastStatus; }
  /** 最後に受信した mechSetting (parseMechSetting の結果)。未受信なら null。 */
  get lastMechSetting() { return this._lastMechSetting; }
  /** 最後に受信した opsSetting (parseOpsSetting の結果)。未受信なら null。 */
  get lastOpsSetting() { return this._lastOpsSetting; }
  get isLoggedIn() { return this._loggedIn; }
  /** initial(14) を受信したが secretKey 未設定で login を試みていない状態 (register 待ち)。 */
  get isReadyToRegister() { return this._readyToRegister; }

  /** mechStatus publish を購読。戻り値 unsubscribe。 @param {(status:any)=>void} fn */
  onStatus(fn) { this._statusListeners.add(fn); return () => this._statusListeners.delete(fn); }
  /** 任意 publish を購読 ({opCode,itemCode,body})。戻り値 unsubscribe。 @param {(pub:{opCode:number, itemCode:number, body:Buffer})=>void} fn */
  onPublish(fn) { this._publishListeners.add(fn); return () => this._publishListeners.delete(fn); }

  /**
   * 接続して login まで完了させる (登録済みデバイス用)。secretKey 必須。
   *
   * 通常 login (既定): session 鍵 = deriveSessionKey(secretKey, token4) = CMAC(secretKey, token4)
   *   をローカル計算し、loginPayload で平文 login する (CHHub3Device.kt:168-172 token==null 経路)。
   *
   * サーバ認証 login (signLogin 指定時): isNeedAuthFromServer 相当。initial で得た token を
   *   signLogin(tokenHex) に渡して**サーバ署名済み session token (hex)** を取得し、それを session 鍵
   *   として login する (CHHub3Device.kt:163-174 token!=null / CHSesameOS3.kt:473-487 の
   *   signGuestKey→login(it.data) 経路)。ゲスト鍵・期限付き鍵など secretKey 単体では session を
   *   確立できないデバイス向け。
   *
   * @param {{signLogin?:(tokenHex:string)=>Promise<string>}} [opts]
   *   signLogin: 4B initial token の hex を受け取り、サーバ署名済み session token (16B/32hex) を返す
   *     非同期関数。省略時は通常 login。
   * @returns {Promise<void>} login 成功で resolve
   */
  async connect({ signLogin } = {}) {
    if (!this._secretKey) return Promise.reject(new Error(t("ble.secretKeyRequiredSession")));
    // 再入ガード: 二重 connect / connect→disconnect 後の再 connect は待機者上書き・古い token
    // 流用を招くため明示エラー (使い捨てセッションの誤用)。disconnect() は _loggedIn 等を
    // クリアするが transport/カウンタは初期状態に戻らないため、再接続は新インスタンスで行う。
    if (this._isBusy()) return Promise.reject(new Error(t("ble.alreadyConnected")));
    this._signLogin = typeof signLogin === "function" ? signLogin : null;
    const loginPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._loginWaiter = null;
        reject(new Error(t("ble.loginTimeout")));
      }, LOGIN_TIMEOUT_MS);
      this._loginWaiter = { resolve, reject, timer };
    });
    await this._transport.connect(
      (packet) => this._onPacket(packet),
      (reason) => this._handleTransportDisconnect(reason),
    );
    return loginPromise;
  }

  /**
   * 工場出荷 (未登録) デバイスの初期ペアリング / 登録ハンドシェイク。
   * secretKey を渡さずに構築した session で呼ぶ (CHHub3Device.kt:176-211)。
   *
   * フロー (CHHub3Device.kt:176-211, CHSesameOS3.kt:468-492):
   *   1. transport 接続 → device の initial(14) publish を待つ。secretKey 無しのため login せず
   *      ReadyToRegister へ遷移 (_handleInitial の分岐, CHSesameOS3.kt:468-491 isRegistered=false)。
   *   2. (任意) registerSesame5 をコール (CHHub3Device.kt:187-189: 失敗してもログのみで継続)。
   *   3. ECDH 鍵ペア (P-256) を生成し、生公開鍵 64B (X‖Y) を registrationData(pubK, ts) に乗せて
   *      REGISTRATION(1) を **PLAINTEXT** 送出 (CHHub3Device.kt:191-194 / CHSesameOS3.kt:495-499)。
   *   4. response(7)+REGISTRATION(1)+resultCode+devicePubK(64B) を待つ。
   *   5. ecdhSecretPre16(keyPair, devicePubK) = ECDH 共有秘密の先頭 16B (CHHub3Device.kt:197)。
   *      secretKey(=wm2Key) = pre16 の hex で確定 (CHHub3Device.kt:198-200)。
   *   6. sessionKey = deriveSessionKeyFromEcdh(pre16, token4) (CHHub3Device.kt:202-203)。
   *      sault = 0x00 ++ token4 は CCM nonce 側 (ccmEncrypt/ccmDecrypt) が消費する。
   *      enc/decCount=0 で cipher を確立し、以降のコマンドは暗号化される。
   *      wm2 profile は鍵 = pre16 生 16B / sault = token4 / register data = pubK64 のみ
   *      (CHWifiModule2Device.kt:279-312。詳細はコンストラクタ JSDoc と protocol.js SESSION_PROFILES)。
   *   7. {deviceUUID, secretKey, productType, serverSecret(=token hex)} を返す
   *      (CHHub3Device.kt:196-208。serverSecret は mSesameToken.toHexString())。
   *
   * @param {{deviceUUID?:string, productType?:(string|number),
   *          registerTransport?:(req:any)=>Promise<any>, nowMs?:number}} [opts]
   *   - deviceUUID: 登録対象の UUID (戻り値・任意の registerSesame5 で使用)。必須 (未指定は reject)。
   *   - productType: 戻り値に載せる model 名 or 数値 productType (任意)。
   *   - registerTransport: 渡された場合のみ registerSesame5 をコール (失敗はログのみ)。
   *   - nowMs: registration timestamp (テスト用に注入可、既定 Date.now())。
   * @returns {Promise<{deviceUUID:string, secretKey:string, productType:(string|number|undefined),
   *                    serverSecret:string}>}
   */
  async register({ deviceUUID, productType, registerTransport, nowMs } = {}) {
    if (this._secretKey) return Promise.reject(new Error(t("ble.registerNeedsFactory")));
    if (!deviceUUID) return Promise.reject(new Error(t("ble.registerDeviceUUIDRequired")));
    // 再入ガード: 二重 register / 進行中の connect・register との競合を弾く。register() は
    // 自身の中で _readyToRegister を true にする (initial 受信時) ので、ここで既に true なのは
    // **別の** connect()/register() が先行した誤用 (= 古い token を流用しかねない再入)。
    // ファサード registerOnce は 1 回限りなので通常は到達しない安全側ガード。
    if (this._isBusy()) return Promise.reject(new Error(t("ble.alreadyConnected")));

    // 1. 接続 → initial を待って ReadyToRegister に遷移するのを待つ。
    if (!this._readyToRegister) {
      const readyPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this._readyWaiter = null;
          reject(new Error(t("ble.registerNotReady")));
        }, LOGIN_TIMEOUT_MS);
        this._readyWaiter = { resolve, reject, timer };
      });
      await this._transport.connect(
        (packet) => this._onPacket(packet),
        (reason) => this._handleTransportDisconnect(reason),
      );
      await readyPromise;
    }

    // serverSecret = mSesameToken.toHexString() (CHHub3Device.kt:182)。
    // ここまで来れば initial 受信済みで _token は必ず非 null (型のみ非 null 化)。
    const token = /** @type {Buffer} */ (this._token);
    const serverSecret = token.toString("hex");

    // 2. (任意) サーバ側 register。失敗してもログのみで継続 (CHHub3Device.kt:187-189)。
    if (typeof registerTransport === "function") {
      try {
        await registerSesame5(registerTransport, { deviceUUID, productType: /** @type {string|number} */ (productType), serverSecret });
      } catch (e) {
        this._log("registerSesame5 failed (continuing, server-side only)", /** @type {{message?:string}} */ (e)?.message);
      }
    }

    // 3. ECDH 鍵ペア生成 → 生公開鍵 64B (0x04 prefix を剥がす) を registrationData に。
    const keyPair = createECDH("prime256v1");
    keyPair.generateKeys();
    const pubK65 = keyPair.getPublicKey(); // 0x04 ‖ X32 ‖ Y32 = 65B
    if (pubK65.length !== 65 || pubK65[0] !== ECDH_UNCOMPRESSED_PREFIX) {
      // Node が uncompressed 65B 以外を返すことは無いが、契約違反を黙って通さない。
      throw new Error(t("ble.registerDevicePubKeyLen", { len: pubK65.length }));
    }
    const pubK64 = pubK65.subarray(1); // SDK EccKey.getPubK() 契約 = prefix 無し 64B

    // 4. REGISTRATION 応答待ちを登録してから PLAINTEXT で送る (race 防止)。
    /** @type {Promise<Buffer>} */
    const regPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._registerWaiter = null;
        reject(new Error(t("ble.registerTimeout")));
      }, REGISTER_TIMEOUT_MS);
      this._registerWaiter = { resolve, reject, timer };
    });
    // wm2 profile の REGISTRATION data は pubK64 のみ (timestamp 無し、CHWifiModule2Device.kt:290)。
    // lock は pubK64 ++ timestamp4 (CHHub3Device.kt:191-194)。分岐は registrationData が担う。
    this._sendPlain(buildSendFrame(ITEM.REGISTRATION, registrationData(pubK64, nowMs ?? Date.now(), this._profile)));
    const regPayload = await regPromise; // REGISTRATION 応答 payload (機種で長さが異なる)

    // 機種で応答 payload の構造が分かれる (プロファイル + 応答長で分岐):
    //   - wm2: payload[0..63] が device の生公開鍵 (CHWifiModule2Device.kt:295
    //     EccKey.ecdh(res.payload.sliceArray(0..63)))。
    //   - 64B (Hub3 等): payload 全体が device の生公開鍵 (CHHub3Device.kt:197 で payload を
    //     そのまま ECDH に渡す)。
    //   - 67B (Bot2/Bot3/Bike2/Bike3): payload[0..2]=mechStatus(3B)、payload[3..66]=devicePubKey(64B)
    //     (CHSesameBot2Device.kt:216-218 / CHSesameBike2Device.kt:110-113 の catch 分岐)。
    //   - 77B (SESAME 5 実機): CHSesame5Device.kt:200-202 handleRegisterResponse 準拠で
    //       payload[0..6]  = mechStatus  (7B, CHSesame5MechStatus)
    //       payload[7..12] = mechSetting (6B, CHSesame5MechSettings)
    //       payload[13..76]= devicePubKey(64B)
    //     先頭 13B を parse してキャッシュ (_lastStatus/_lastMechSetting) へ載せ、末尾 64B を
    //     device pubkey として ECDH に渡す。
    // SDK の Hub3 経路は mechStatus/mechSetting を register 応答からは取らない (publish で別途
    // 受ける) ため 64B のみ。SS5 は登録応答に同梱するため 77B、Bot/Bike は 3B mechStatus 同梱で 67B。
    const devicePubK = this._extractRegisterDevicePubK(regPayload);

    // 5. ECDH 共有秘密の先頭 16B → secretKey(=wm2Key) = pre16 の hex (CHHub3Device.kt:197-200)。
    const pre16 = ecdhSecretPre16(keyPair, devicePubK);
    const secretKey = pre16.toString("hex");

    // 6. cipher 鍵 (enc/decCount=0 で確立) はプロファイルで分かれる:
    //    - lock: sessionKey = CMAC(pre16, token4)、sault = 0x00 ++ token4 (CHHub3Device.kt:202-203)。
    //    - wm2 : 鍵 = ecdhSecret_pre16 **生 16B**、sault = token4 (CHWifiModule2Device.kt:295-297:
    //      cipher = SesameOS3BleCipher("customDeviceName", ecdhSecret_pre16, mSesameToken!!))。
    //    sault は CCM nonce 側 (ccmEncrypt/ccmDecrypt の profile 引数) で消費。
    this._key = this._profile === "wm2"
      ? Buffer.from(pre16) // 後段の pre16.fill(0) から守るためコピー
      : deriveSessionKeyFromEcdh(pre16, token);
    this._encCount = 0;
    this._decCount = 0;
    this._loggedIn = true;       // 以降のコマンドは暗号化セッションで送れる
    this._readyToRegister = false;
    this._secretKey = Buffer.from(secretKey, "hex"); // 確定した wm2Key を保持

    // 機微中間値 (ECDH 共有 16B) を零クリア (crypto.js の機微値配慮方針と整合)。
    pre16.fill(0);

    // 7. 登録結果を返す (CHHub3Device.kt:196-208)。
    return { deviceUUID, secretKey, productType, serverSecret };
  }

  /**
   * 単一待機者 (_loginWaiter/_readyWaiter/_registerWaiter) を reject + timer clear して
   * フィールドを null に戻す。disconnect() で 3 つを対称に解放するためのヘルパ
   * (取りこぼし防止: 待機者を追加したらここに 1 行足すだけで済む)。
   * @param {"_loginWaiter"|"_readyWaiter"|"_registerWaiter"} field
   * @param {Error} err
   */
  _rejectWaiter(field, err) {
    const w = this[field];
    if (!w) return;
    this[field] = null;
    clearTimeout(w.timer);
    w.reject(err);
  }

  /**
   * pending request と 3 待機者 (login/ready/register) を全て reject + timer clear し、
   * セッション状態フラグを倒す。能動 disconnect() と、transport からの非同期切断通知
   * (_handleTransportDisconnect) の両方が共有する内部解放処理 (transport.disconnect() は呼ばない)。
   * @param {Error} err pending/待機者へ渡す reject 理由
   */
  _failAllPending(err) {
    for (const [, queue] of this._pending) {
      for (const p of queue) { clearTimeout(p.timer); p.reject(err); }
    }
    this._pending.clear();
    this._rejectWaiter("_loginWaiter", err);
    this._rejectWaiter("_readyWaiter", err);
    this._rejectWaiter("_registerWaiter", err);
    this._loggedIn = false;
    this._readyToRegister = false;
    this._signLogin = null; // 次回 connect() の引数で再設定 (古い resolver を持ち越さない)
  }

  /**
   * transport から「リンクが切れた」と通知されたときのハンドラ (transport.connect の onDisconnect)。
   * SDK CHSesameOS3.kt:228-263 onConnectionStateChange の STATE_DISCONNECTED 分岐
   * (connectR.remove / cmdCallBack.clear) に相当。pending/待機者を即 reject して **timeout 宙づりを
   * 防ぐ** (fail-fast)。能動 disconnect() と異なり transport.disconnect() は呼ばない (既に切断済み・
   * 自分が起点ではないため)。何度呼ばれても安全 (待機者が無ければ no-op)。
   * @param {any} reason 切断理由 (noble の reason 文字列等)
   */
  _handleTransportDisconnect(reason) {
    this._log("transport disconnected, failing pending requests", reason);
    this._failAllPending(new Error(t("ble.linkLost")));
  }

  async disconnect() {
    // pending / 待機者を全て reject してリーク防止 (connect()/register() の await が
    // 永久ハングしないよう、login/ready/register の 3 待機者を対称に解放する)。
    this._failAllPending(new Error(t("ble.disconnected")));
    await this._transport.disconnect();
  }

  /**
   * 暗号化コマンドを送り、response(7)+item を待って返す。
   * @param {number} itemCode
   * @param {Buffer} [data]
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<{resultCode:number, payload:Buffer}>}
   */
  request(itemCode, data = Buffer.alloc(0), { timeoutMs } = {}) {
    if (!this._loggedIn) return Promise.reject(new Error(t("ble.notLoggedIn")));
    const to = timeoutMs ?? this._defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._dequeue(itemCode, entry);
        reject(new Error(t("ble.requestTimeout", { item: itemCode })));
      }, to);
      const entry = { resolve, reject, timer };
      if (!this._pending.has(itemCode)) this._pending.set(itemCode, []);
      /** @type {NonNullable<ReturnType<typeof this._pending.get>>} */ (this._pending.get(itemCode)).push(entry);
      // 送信は subscribe 登録後に (race 防止)
      this._sendCipher(buildSendFrame(itemCode, data));
    });
  }

  /**
   * mechSetting (角度キャリブレーション) を書き込む。
   *   data = configureLockPositionData(lockTarget, unlockTarget) (CHSesame5Device.kt:69-83)。
   * 成功時はキャッシュ (_lastMechSetting) の lock/unlock 位置も更新する (SDK と同じ局所更新)。
   * @param {number} lockTarget   施錠目標角 (-32768..32767)
   * @param {number} unlockTarget 解錠目標角 (-32768..32767)
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<{resultCode:number, payload:Buffer}>}
   */
  async configureLockPosition(lockTarget, unlockTarget, opts = {}) {
    const data = configureLockPositionData(lockTarget, unlockTarget);
    const res = await this.request(ITEM.MECH_SETTING, data, opts);
    // SDK は成功時に mechSetting?.lockPosition/unlockPosition を更新する (CHSesame5Device.kt:76-77)。
    if (this._lastMechSetting) {
      this._lastMechSetting = { ...this._lastMechSetting, lockPosition: lockTarget, unlockPosition: unlockTarget };
    } else {
      this._lastMechSetting = { lockPosition: lockTarget, unlockPosition: unlockTarget, autoLockSecond: 0 };
    }
    return res;
  }

  /**
   * magnet — LOCK5 系ロック固有のコマンド (CHSesame5Device.kt:118-126 magnet() と 1:1)。
   *   item = magnet(17)、data = 空 ByteArray。引数なし・cipher セグメントで送り、成功で解決する。
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<{resultCode:number, payload:Buffer}>}
   */
  magnet(opts = {}) {
    return this.request(ITEM.MAGNET, Buffer.alloc(0), opts);
  }

  /**
   * opSensorControl(isEnable) — Open Sensor の自動施錠秒数を設定する
   * (CHSesame5Device.kt:107-116 と 1:1)。
   *   item = OPS_CONTROL(92)、data = opSensorControlData(seconds) (2B LE)。
   * SDK は成功時に opsSetting?.opsLockSecond = isEnable.toUShort() でキャッシュを局所更新する。
   * 本実装も成功 (resultCode==0) のとき _lastOpsSetting.opsLockSecond を更新する。
   * @param {number} seconds 0..65535 (0 = 無効)
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<{resultCode:number, payload:Buffer}>}
   */
  async opSensorControl(seconds, opts = {}) {
    const data = opSensorControlData(seconds);
    const res = await this.request(ITEM.OPS_CONTROL, data, opts);
    // SDK は成功時に opsSetting?.opsLockSecond を更新する (CHSesame5Device.kt:113)。
    if (res.resultCode === 0) {
      this._lastOpsSetting = { ...(this._lastOpsSetting || {}), opsLockSecond: seconds };
    }
    return res;
  }

  /**
   * setBleTxPower(txPower) — BLE 送信出力を設定する
   * (CHSesameOS3LockBase.kt:62-71 / CHSesameBiometricDeviceImpl.kt:332-341 と 1:1)。
   *   item = SSM3_ITEM_CODE_BLE_TX_POWER_SETTING(206)、data = bleTxPowerData(txPower) (符号付き 1B)。
   * SDK は応答を待たず空コールバック ({}) で送りっぱなしにするが、本 kit の request() は
   * response(7)+item を待つ共通実装なので、ここでもそれに従い応答を返す (より堅牢、後方互換)。
   * @param {number} txPower -128..127
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<{resultCode:number, payload:Buffer}>}
   */
  setBleTxPower(txPower, opts = {}) {
    return this.request(ITEM.SSM3_ITEM_CODE_BLE_TX_POWER_SETTING, bleTxPowerData(txPower), opts);
  }

  /**
   * sendAdvProductType(data) — LOCK5 のアドバタイズ productType を書き換える
   * (CHSesame5Device.kt:85-94 と 1:1)。
   *   item = SS3_ITEM_CODE_SET_ADV_PRODUCT_TYPE(205)、data = 任意 ByteArray をそのまま。
   * 中身の意味は機種固有 (SDK も raw ByteArray を素通し) のため、呼び出し側が組み立てた
   * Buffer をそのまま送る。
   * @param {Buffer} data 送信する生バイト列
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<{resultCode:number, payload:Buffer}>}
   */
  sendAdvProductType(data, opts = {}) {
    if (!Buffer.isBuffer(data)) throw new Error(t("ble.advProductTypeMustBeBuffer"));
    return this.request(ITEM.SS3_ITEM_CODE_SET_ADV_PRODUCT_TYPE, data, opts);
  }

  /**
   * reset() — OS3 デバイスを工場出荷状態へ戻す (CHSesameOS3.kt:420-439 と 1:1)。
   *   item = Reset(104)、data = 空 ByteArray。成功 (cmdResultCode==success) のとき SDK は
   *   dropKey() を呼び、ローカルの鍵レコードを削除してセッションを破棄する。
   * 本 kit には永続鍵ストアが無い (secretKey は呼び出し側が保持) ため、dropKey 相当として
   * **成功時に disconnect() してセッションを破棄する** (WM2 reset と同じ流儀、wm2.js:440-448)。
   * 鍵レコードの削除そのものは呼び出し側の責務 (誇張せず明記)。
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<{resultCode:number, payload:Buffer}>} 成功時 resultCode=0
   */
  async reset(opts = {}) {
    const res = await this.request(ITEM.RESET, Buffer.alloc(0), opts);
    // cmdResultCode==success のときだけ dropKey 相当 (= session 破棄) を行う (kt:425-426)。
    if (res.resultCode === 0) {
      await this.disconnect();
    }
    return res;
  }

  /**
   * versionTag (ファームウェアバージョン文字列) を取得する。itemCode は profile で分かれる:
   *   - lock profile: item = versionTag(5)、data = 空、payload = UTF-8 文字列
   *     (CHSesameOS3.kt:398-418)。
   *   - wm2 profile : item = **WM2ActionCode.VERSION_TAG(127)**、data = 空、payload = UTF-8 文字列
   *     (CHWifiModule2Device.kt:423-435 — getVersionTag() は SesameOS3Payload(VERSION_TAG.value,
   *     byteArrayOf()) を送り、成功時 String(res.payload) を返す)。WM2 の action code 空間では
   *     5 = CONNECT_WIFI なので、旧挙動 (常に 5 を送る) は WM2 では versionTag ではなく
   *     Wi-Fi 接続開始を誤発火していた。応答パースは両 profile とも payload の UTF-8 文字列で同一。
   *     SDK の unlogined ガード (kt:424-426) は request() の notLoggedIn reject で等価に担保される。
   * @experimental wm2 profile の versionTag(127) 経路は SDK Kotlin の静的読みからの移植で
   *   実機未検証 (参照: CHWifiModule2Device.kt:423-435,540)。
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<string>} versionTag 文字列
   */
  async getVersionTag(opts = {}) {
    const itemCode = this._profile === "wm2" ? WM2_ACTION_CODES.VERSION_TAG : ITEM.VERSION_TAG;
    const res = await this.request(itemCode, Buffer.alloc(0), opts);
    return res.payload.toString("utf8");
  }

  /**
   * 履歴を 1 件読み出す。
   *   item = history(4)、data = [0x01] (CHSesameOS3LockBase.kt:185-192)。
   * payload は 1 件分の履歴生バイト列 (先頭 4B が recordId)。サーバ post / 削除は呼び出し側の責務。
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<Buffer>} 履歴 payload (空なら 0 件)
   */
  async readHistory(opts = {}) {
    const res = await this.request(ITEM.HISTORY, historyReadData(), opts);
    return res.payload;
  }

  /**
   * 履歴 1 件をデバイスから削除する。
   *   item = SSM2_ITEM_CODE_HISTORY_DELETE(18)、data = recordId = historyPayload[0..3]
   *   (CHSesameOS3LockBase.kt:201-209)。
   * @param {Buffer} historyPayload readHistory が返した payload (先頭 4B が recordId)
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<{resultCode:number, payload:Buffer}>}
   */
  deleteHistory(historyPayload, opts = {}) {
    return this.request(ITEM.HISTORY_DELETE, historyDeleteData(historyPayload), opts);
  }

  /**
   * 1 セグメントを transport へ書く。write が (リトライ尽きて) reject したときの後始末は
   * transport→onDisconnect→_handleTransportDisconnect が pending を fail-fast する経路で行うので、
   * ここでは未処理 Promise 拒否 (unhandledRejection) を避けるためだけに握りつぶす
   * (元から fire-and-forget。送信失敗は応答 timeout / 切断通知のどちらかで必ず表面化する)。
   * @param {Buffer} seg
   */
  _writeSeg(seg) {
    try {
      const r = this._transport.write(seg);
      if (r && typeof r.then === "function") r.catch((/** @type {any} */ e) => this._log("write rejected (handled via disconnect)", e?.message));
    } catch (e) {
      // 同期 throw (notConnected 等) も同経路。pending は切断通知で解放される。
      this._log("write threw (handled via disconnect)", /** @type {{message?:string}} */ (e)?.message);
    }
  }

  /** 暗号化なしで item+data を送る (login 等のハンドシェイク用低レベル)。 @param {Buffer} frame */
  _sendPlain(frame) {
    for (const seg of splitSegments(frame, SEG.PLAINTEXT)) this._writeSeg(seg);
  }

  /** CCM 暗号化して送る (encCount++)。sault はプロファイル依存 (lock: 0x00++token / wm2: token)。 @param {Buffer} frame */
  _sendCipher(frame) {
    // login/register 後のみ呼ばれ _key/_token は非 null (型のみ非 null 化)。
    const ct = ccmEncrypt(/** @type {Buffer} */ (this._key), this._encCount, /** @type {Buffer} */ (this._token), frame, this._profile);
    this._encCount += 1;
    for (const seg of splitSegments(ct, SEG.CIPHERTEXT)) this._writeSeg(seg);
  }

  /**
   * @param {number} itemCode
   * @param {{resolve:(v:{resultCode:number, payload:Buffer})=>void, reject:(e:Error)=>void, timer:any}} entry
   */
  _dequeue(itemCode, entry) {
    const queue = this._pending.get(itemCode);
    if (!queue) return;
    const i = queue.indexOf(entry);
    if (i >= 0) queue.splice(i, 1);
    if (queue.length === 0) this._pending.delete(itemCode);
  }

  // ---------- 受信 ----------

  /** @param {Buffer} packet */
  _onPacket(packet) {
    let assembled;
    try { assembled = this._asm.feed(Buffer.isBuffer(packet) ? packet : Buffer.from(packet)); }
    catch (e) { this._log("assemble error", e); return; }
    if (!assembled) return; // 未完

    /** @type {Buffer} */
    let frame;
    if (assembled.type === SEG.CIPHERTEXT) {
      // SDK 忠実: SesameOS3BleCipher.decrypt() は doFinal() の **前** に decryptCounter を
      // inc() する (SesameOS3BleCipher.kt:23-31)。よって復号が失敗しても counter は進む。
      // デバイス側は受信フレームごとに enc counter を 1 進めて送るため、こちらも 1:1 で
      // dec counter を進めることで、単発の破損/取りこぼし後も後続フレームと整合が保たれる
      // (進めないと 1 度の失敗で以降全フレームが恒久的にずれて復号不能 = セッションがハングする)。
      const usedCount = this._decCount;
      this._decCount += 1;
      try {
        // 暗号フレーム受信は login/register 後のみ → _key/_token は非 null (型のみ非 null 化)。
        // sault はプロファイル依存 (lock: 0x00++token / wm2: token、SesameOS3BleCipher.kt:23)。
        frame = ccmDecrypt(/** @type {Buffer} */ (this._key), usedCount, /** @type {Buffer} */ (this._token), assembled.data, this._profile);
      } catch (e) {
        // この 1 フレームだけ捨てる。counter は既に進めたので後続は復号継続できる。
        this._log("decrypt failed (corruption / dropped frame); skipping this frame", /** @type {{message?:string}} */ (e)?.message);
        return;
      }
    } else {
      frame = assembled.data; // PLAINTEXT (initial / login 応答が平文の場合)
    }

    let parsed;
    try { parsed = parseRecvFrame(frame); }
    catch (e) { this._log("parse error", /** @type {{message?:string}} */ (e)?.message); return; }
    const { opCode, itemCode, body } = parsed;
    this._log("recv", { opCode, itemCode, len: body.length });

    if (opCode === OP.PUBLISH) {
      // initial の itemCode はプロファイル依存: lock=INITIAL(14) / wm2=WM2ActionCode.INITIAL(13)
      // (CHWifiModule2Device.kt:521-528。自実装が 14 のみ処理すると WM2 はトークンを受け取れない)。
      if (itemCode === this._initialItemCode) { this._handleInitial(body); return; }
      if (itemCode === ITEM.MECH_STATUS) {
        // ロック (Sesame5/6=7B, Bot/Bike=3B) は parseMechStatus で position/target/flags を読む。
        // 生体・アクセス制御デバイス (Touch/Face/Palm) の mechStatus はロックのバイト構造を持たず
        // (SDK CHSesameTouchProMechStatus は raw を保持するだけ)、長さも 7B/3B に一致しないため
        // parseMechStatus は throw する。その場合は biometric.js の pass-through parse に落として
        // _lastStatus を必ず更新する (CHSesameBiometricDeviceImpl.kt:214-217 handleMechStatus と整合)。
        try {
          this._lastStatus = parseMechStatus(body);
        } catch {
          this._lastStatus = parseBiometricMechStatus(body);
        }
        for (const fn of [...this._statusListeners]) { try { fn(this._lastStatus); } catch { /* ignore */ } }
      }
      // mechSetting(80) / OPS_CONTROL(92) の publish を解析してキャッシュする
      // (CHSesame5Device.kt:220-227 handleDevicePublish)。
      else if (itemCode === ITEM.MECH_SETTING) {
        try { this._lastMechSetting = parseMechSetting(body); } catch { /* ignore */ }
      }
      else if (itemCode === ITEM.OPS_CONTROL) {
        try { this._lastOpsSetting = parseOpsSetting(body); } catch { /* ignore */ }
      }
      for (const fn of [...this._publishListeners]) { try { fn({ opCode, itemCode, body }); } catch { /* ignore */ } }
      return;
    }

    if (opCode === OP.RESPONSE) {
      const resultCode = body.length > 0 ? body[0] : 0;
      const payload = body.subarray(1);
      if (itemCode === ITEM.LOGIN) { this._handleLoginResponse(resultCode, payload); return; }
      if (itemCode === ITEM.REGISTRATION) { this._handleRegistrationResponse(resultCode, payload); return; }
      this._resolvePending(itemCode, resultCode, payload);
    }
  }

  /** @param {Buffer} token */
  _handleInitial(token) {
    // initial token は **4B 固定** (BLE3-05)。根拠: CCM nonce = count(8B LE) ++ sault で、
    // lock profile の sault = 0x00 ++ token4 (5B) → nonce 13B / wm2 profile の sault = token4 →
    // nonce 12B が暗号契約 (SesameOS3BleCipher.kt:8-19,23 / CHWifiModule2Device.kt:297,317、
    // protocol.js ccmSault も 4B を要求)。4B 超を黙って先頭 4B に切り詰めるとデバイス側の
    // sault と不一致になり全フレームが復号不能になるため、明示エラーで待機者を解放する。
    if (!token || token.length < 4) { this._log("initial token too short"); return; }
    if (token.length > 4) {
      const err = new Error(t("ble.initialTokenMustBe4", { len: token.length }));
      this._log("initial token too long (refusing to truncate)", token.length);
      this._rejectWaiter("_loginWaiter", err);
      this._rejectWaiter("_readyWaiter", err);
      return;
    }
    this._token = Buffer.from(token.subarray(0, 4));
    this._encCount = 0;
    this._decCount = 0;
    // secretKey 未設定 (工場出荷) なら login を試みず ReadyToRegister へ遷移する
    // (CHSesameOS3.kt:468-491: isRegistered=false のとき login せず register を待つ)。
    if (!this._secretKey) {
      this._readyToRegister = true;
      this._log("initial token received, no secretKey → ReadyToRegister");
      if (this._readyWaiter) {
        const w = this._readyWaiter;
        this._readyWaiter = null;
        clearTimeout(w.timer);
        w.resolve();
      }
      return;
    }
    // WM2 profile の login (CHWifiModule2Device.kt:314-321 override fun login):
    //   loginTag = AesCmac(secretKey 生 16B).computeMac(mSesameToken) — CMAC は計算するが
    //   それは **payload (16B 全量)** であって cipher 鍵ではない。
    //   cipher = SesameOS3BleCipher(name, secretKey 生 16B, mSesameToken) — 鍵 = secretKey 生、
    //   sault = token4 (0x00 を挟まない。nonce 12B は ccmEncrypt/ccmDecrypt の profile 引数が担う)。
    if (this._profile === "wm2") {
      if (this._signLogin) {
        // CHWifiModule2Device に isNeedAuthFromServer 経路は無い (login(token: String?) override は
        // token を使わない)。黙って無視せず明示エラー (op を捏造しない)。
        this._rejectWaiter("_loginWaiter", new Error(t("ble.wm2NoServerAuth")));
        return;
      }
      const loginTag = deriveSessionKey(this._secretKey, this._token); // CMAC(secretKey, token4) 16B
      this._key = Buffer.from(this._secretKey); // cipher 鍵 = secretKey 生 16B (kt:317)
      this._log("initial token received (wm2), sending login");
      this._sendPlain(loginPayload(loginTag, "wm2")); // [LOGIN_WM2(2)] ++ CMAC 16B 全量 (kt:318)
      return;
    }

    // サーバ認証 login (isNeedAuthFromServer): token を signLogin に渡して
    // サーバ署名済み session token を取得し、それを session 鍵として login する
    // (CHSesameOS3.kt:473-487 signGuestKey→login(it.data))。signLogin は非同期なので
    // 別経路 (_loginViaServer) で解決し、失敗は _loginWaiter を reject する。
    if (this._signLogin) { this._loginViaServer(); return; }

    this._key = deriveSessionKey(this._secretKey, this._token);
    this._log("initial token received, sending login");
    this._sendPlain(loginPayload(this._key)); // login は PLAINTEXT
  }

  /**
   * サーバ認証 login の非同期本体。signLogin(tokenHex) でサーバ署名済み session token (hex) を
   * 取得し、それを session 鍵 (16B) として平文 login を送る (CHSesameOS3.kt:474-484)。
   * signLogin が投げた場合は login 待機者を reject (connect() の await が解放される)。
   */
  async _loginViaServer() {
    let serverToken;
    try {
      // _signLogin 設定時 (initial 受信後) のみ呼ばれる → _signLogin/_token は非 null。
      const token = /** @type {Buffer} */ (this._token);
      serverToken = await /** @type {(tokenHex:string)=>Promise<string>} */ (this._signLogin)(token.toString("hex"));
    } catch (e) {
      this._rejectWaiter("_loginWaiter", e instanceof Error ? e : new Error(String(e)));
      return;
    }
    // signLogin の戻り (= guestKeysSignPost の String) を 16B session 鍵として採用。
    const key = Buffer.isBuffer(serverToken) ? serverToken : Buffer.from(String(serverToken), "hex");
    if (key.length !== 16) {
      this._rejectWaiter("_loginWaiter", new Error(t("ble.serverTokenMustBe16", { len: key.length })));
      return;
    }
    this._key = key;
    this._log("server-signed session token received, sending login");
    this._sendPlain(loginPayload(this._key)); // login は PLAINTEXT
  }

  /** @param {number} resultCode @param {Buffer} payload */
  _handleRegistrationResponse(resultCode, payload) {
    if (!this._registerWaiter) return;
    const w = this._registerWaiter;
    this._registerWaiter = null;
    clearTimeout(w.timer);
    if (resultCode === 0) w.resolve(Buffer.from(payload));
    else w.reject(new BleResultError("command", resultCode, ITEM.REGISTRATION));
  }

  /**
   * REGISTRATION 応答 payload から device の生公開鍵 64B を取り出す (プロファイルと応答長で分岐)。
   * mechStatus/mechSetting 同梱形のときは先頭を parse してキャッシュ
   * (_lastStatus/_lastMechSetting) に載せてから pubkey 部を返す。
   *
   *   - wm2 profile → payload[0..63] が device pubkey (64B 以上を要求し先頭 64B を採る。
   *           CHWifiModule2Device.kt:295 EccKey.ecdh(res.payload.sliceArray(0..63)))。
   *   - 64B → payload 全体が device pubkey (Hub3 等。CHHub3Device.kt:197)。
   *   - 67B → payload[0..2]=mechStatus(3B, CHSesameBot2MechStatus/CHSesameBike2MechStatus),
   *           [3..66]=devicePubKey(64B)
   *           (CHSesameBot2Device.kt:216-219 / CHSesameBike2Device.kt:110-113 の catch 分岐と 1:1。
   *            Bot2/Bot3/Bike2/Bike3 は 77B の try が ArrayIndexOutOfBounds で落ち catch 側が走る)。
   *   - 77B → payload[0..6]=mechStatus, [7..12]=mechSetting, [13..76]=devicePubKey
   *           (CHSesame5Device.kt:200-202 handleRegisterResponse と 1:1)。
   *
   * 注: SS5 形 (77B)・Bot/Bike 形 (67B)・wm2 形は SDK の Kotlin を移植したもので、
   *   実機応答での検証は未了 (README の Known limitations と整合)。
   * @param {Buffer} payload REGISTRATION 応答 payload
   * @returns {Buffer} device の生公開鍵 64B (X‖Y)
   */
  _extractRegisterDevicePubK(payload) {
    // wm2: 応答の先頭 64B が pubkey (sliceArray(0..63))。64B 未満は Kotlin 同様エラー。
    if (this._profile === "wm2") {
      if (!Buffer.isBuffer(payload) || payload.length < 64) {
        throw new Error(t("ble.registerDevicePubKeyLen", {
          len: Buffer.isBuffer(payload) ? payload.length : "non-buffer",
        }));
      }
      return Buffer.from(payload.subarray(0, 64));
    }
    if (!Buffer.isBuffer(payload) || (payload.length !== 64 && payload.length !== 67 && payload.length !== 77)) {
      throw new Error(t("ble.registerDevicePubKeyLen", {
        len: Buffer.isBuffer(payload) ? payload.length : "non-buffer",
      }));
    }
    if (payload.length === 64) return payload; // Hub3: payload 全体が pubkey

    if (payload.length === 67) {
      // 67B = Bot2/Bot3/Bike2/Bike3: mechStatus(3B) ++ devicePubKey(64B)。
      // mechStatus = CHSesameBot2MechStatus(payload.sliceArray(0..2)) (CHSesameBot2Device.kt:216 /
      // CHSesameBike2Device.kt:110)。3B は parseMechStatus が parseMechStatusBot へ振り分ける。
      // parse 失敗は登録自体を妨げないよう握りつぶす (77B 形と同じ流儀)。
      try { this._lastStatus = parseMechStatus(payload.subarray(0, 3)); } catch { /* ignore */ }
      return Buffer.from(payload.subarray(3, 67));
    }

    // 77B = SS5: mechStatus(7B) ++ mechSetting(6B) ++ devicePubKey(64B)。
    // 先頭 13B を既存 parse 関数で読み、login 経路と同じキャッシュ (_lastStatus/_lastMechSetting)
    // へ載せる (publish 経由の更新と同じ流れ。parse 失敗は登録自体を妨げないよう握りつぶす)。
    try { this._lastStatus = parseMechStatus(payload.subarray(0, 7)); } catch { /* ignore */ }
    try { this._lastMechSetting = parseMechSetting(payload.subarray(7, 13)); } catch { /* ignore */ }
    return Buffer.from(payload.subarray(13, 77));
  }

  /** @param {number} resultCode @param {Buffer} payload */
  _handleLoginResponse(resultCode, payload) {
    if (!this._loginWaiter) return;
    const w = this._loginWaiter;
    this._loginWaiter = null;
    clearTimeout(w.timer);
    if (resultCode === 0) {
      this._loggedIn = true;
      // 時刻同期 (CHSesameOS3LockBase.kt:126-138): login 応答 payload[0..3] のデバイス時刻 (秒) と
      // 端末時刻の差が 3 秒を超えていたら time(8) を CIPHERTEXT 送出する。login() の resolve は
      // 同期送信を待たず即時に行う (SDK も同期送信は fire-and-forget で応答を待たない)。
      // wm2 profile は対象外: CHWifiModule2Device.kt:318-320 の login コールバックはログのみで、
      // 時刻同期は CHSesameOS3LockBase (ロック系) 固有の処理。
      // syncTime=false (BLE3-03): Hub3 も login を override して handleLoginResponse を呼ばない
      // (CHHub3Device.kt:167-178) ため、ファサードは HUB3 kind で false を渡す。
      if (this._profile === "lock" && this._syncTime) this._maybeSyncTime(payload);
      w.resolve();
    }
    else w.reject(new BleResultError("login", resultCode));
  }

  /**
   * login 直後の時刻同期。デバイス時刻と端末時刻の差が >3 秒なら time(8) を暗号化送出する。
   * SDK の handleLoginResponse (CHSesameOS3LockBase.kt:126-138) と同じ判定・送出。
   * time(8) は応答を待たず投げっぱなし (fire-and-forget)。エラーは握りつぶす (login を妨げない)。
   * @param {Buffer} payload login response の payload (resultCode を除いた本体)
   */
  _maybeSyncTime(payload) {
    try {
      const deviceSeconds = parseDeviceTimeSeconds(payload);
      if (deviceSeconds == null) return;
      if (!needsTimeSync(deviceSeconds)) return;
      this._log("time drift > 3s, sending time sync", { deviceSeconds });
      this._sendCipher(buildSendFrame(ITEM.TIME, timeSyncData()));
    } catch (e) {
      this._log("time sync failed (ignored)", /** @type {{message?:string}} */ (e)?.message);
    }
  }

  /** @param {number} itemCode @param {number} resultCode @param {Buffer} payload */
  _resolvePending(itemCode, resultCode, payload) {
    const queue = this._pending.get(itemCode);
    if (!queue || queue.length === 0) return; // 対応する request なし (unsolicited)
    // length>0 を確認済みなので shift() は必ず entry を返す (型のみ非 null 化)。
    const entry = /** @type {NonNullable<ReturnType<typeof queue.shift>>} */ (queue.shift());
    if (queue.length === 0) this._pending.delete(itemCode);
    clearTimeout(entry.timer);
    if (resultCode === 0) entry.resolve({ resultCode, payload });
    else entry.reject(new BleResultError("command", resultCode, itemCode));
  }
}
