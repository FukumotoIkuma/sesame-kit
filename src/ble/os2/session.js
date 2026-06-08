// SESAME OS2 BLE セッション状態機械 (SESAME2/3/4・初代 Bot・初代 Bike)。OS 非依存。
//
// 接続後のバイト列のやり取りだけを担い、無線 I/O は注入された transport に委譲する
// (= mock transport でハードウェア無しにテスト可能)。OS3 (src/ble/session.js) と同型だが、
// OS2 の鍵導出・nonce・フレーム (opCode 込み) を使う。
//
// 移植元 (1:1):
//   - CHSesame2Device.kt (login:213-272 / register:406-482 / mechStatus:543-553 / onGattSesamePublish:508-554)
//   - CHSesameBotDevice.kt (login:432-484 / register:496-562)
//   - CHSesameBikeDevice.kt (login:323-364 / register:376-440)
//
// フロー (login):
//   connect → transport.connect(onPacket)
//     → device が publish(8)+initial(14)+mSesameToken(4B) を送る (CHSesame2Device.kt:518-540)
//     → sessionToken = mAppToken4 ++ mSesameToken4
//     → ECDH(ssmPublicKey) → pre16、sessionKey = CMAC(pre16, sessionToken)
//     → sessionAuth = CMAC(secretKey, userIdx ++ appPubKey64 ++ sessionToken) [サーバ認証時は signLogin]
//     → cipher = (sessionKey, sessionToken)、login(2) を SYNC opCode で PLAINTEXT 送信
//     → device が response(7)+login(2)+resultCode(+payload) を返す → resultCode==0 で接続完了
//   request(opCode, item, data) → frame を OS2 CCM 暗号化 (encCount++) → セグメント送信
//     → response(7)+item を待って {resultCode, payload} で解決
//   publish(8)+mechStatus(81) は onStatus リスナへ。

import { Buffer } from "node:buffer";
import { createECDH, randomBytes } from "node:crypto";
import { ecdhSecretPre16 } from "../../crypto.js";
import { t } from "../../i18n.js";
import {
  OP, ITEM, SEG, splitSegments, SegmentAssembler, parseRecvFrame, buildSendFrame,
  sessionToken as buildSessionToken, deriveSessionKey, sessionAuth as computeSessionAuth,
  loginPayload, deriveRegisterKeys, registrationData, parseLoginResponse, parseMechStatus,
  timePhoneData, resultName,
} from "./protocol.js";
import { SesameOS2BleCipher } from "./cipher.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const LOGIN_TIMEOUT_MS = 8_000;
const REGISTER_TIMEOUT_MS = 8_000;

// EC point uncompressed prefix。Node の getPublicKey() は 0x04 ‖ X ‖ Y = 65B を返すので、
// SDK EccKey.getPubK() 契約 (prefix 無し 64B raw) に合わせて先頭 1B を剥がす。
const ECDH_UNCOMPRESSED_PREFIX = 0x04;

/**
 * OS2 デバイスが非 0 の resultCode を返したときのエラー。
 * resultName (notFound/busy/invalidSig…) で機械的に分岐できる (SesameResultCode 由来)。
 */
export class BleResultError extends Error {
  /** @param {"login"|"command"|"registration"} phase @param {number} resultCode @param {number|null} itemCode */
  constructor(phase, resultCode, itemCode = null) {
    const name = resultName(resultCode);
    super(`OS2 BLE ${phase} failed: ${name} (resultCode=${resultCode}${itemCode != null ? `, item=${itemCode}` : ""})`);
    this.name = "BleResultError";
    this.resultCode = resultCode;
    this.resultName = name;
    this.itemCode = itemCode;
  }
}

/**
 * @typedef {object} BleTransport BLE 無線 I/O アダプタ (transport.js のアダプタが満たす契約)。
 * @property {(onPacket:(packet:Buffer)=>void, onDisconnect?:(reason:any)=>void)=>Promise<void>} connect
 *   接続+notify購読。各 notify を onPacket へ。リンク断 (相手側切断/圏外/write 失敗) で onDisconnect(reason) を 1 回呼ぶ。
 * @property {(bytes:Buffer)=>void|Promise<void>} write Write Without Response。
 * @property {()=>void|Promise<void>} disconnect 切断。
 */

export class SesameOS2BleSession {
  /**
   * @param {{
   *   transport: BleTransport,
   *   secretKey?: string|Buffer,        // 16B ロック共通鍵 (登録済みデバイスの login に必須)
   *   keyIndex?: string|Buffer,         // userIdx (sesame2KeyData.keyIndex)。login の signPayload に使う
   *   ssmPublicKey?: string|Buffer,     // デバイス公開鍵 64B (sesame2KeyData.sesame2PublicKey)。login の ECDH 相手
   *   debug?: boolean,
   *   defaultTimeoutMs?: number,
   * }} opts
   *   secretKey/keyIndex/ssmPublicKey は **登録済みデバイスの login 時のみ必須**。
   *   工場出荷 (未登録) デバイスを register() で登録する場合は secretKey を渡さずに構築する
   *   (initial 受信で login を試みず ReadyToRegister 状態へ遷移)。
   *
   *   注: 自動再接続はしない (OS3 session と同じ方針)。リンク断は _handleTransportDisconnect で
   *   pending/待機者を fail-fast するだけなので、再接続したい場合は呼び出し側が新しいインスタンスを
   *   構築し直す (使い捨てセッション)。
   */
  constructor({ transport, secretKey, keyIndex, ssmPublicKey, debug = false, defaultTimeoutMs = DEFAULT_TIMEOUT_MS }) {
    if (!transport) throw new Error("transport required");
    this._transport = transport;
    this._secretKey = secretKey == null ? null : (Buffer.isBuffer(secretKey) ? secretKey : Buffer.from(secretKey, "hex"));
    this._keyIndex = keyIndex == null ? Buffer.alloc(0) : (Buffer.isBuffer(keyIndex) ? keyIndex : Buffer.from(keyIndex, "hex"));
    this._ssmPublicKey = ssmPublicKey == null ? null : (Buffer.isBuffer(ssmPublicKey) ? ssmPublicKey : Buffer.from(ssmPublicKey, "hex"));
    this._debug = debug;
    this._defaultTimeoutMs = defaultTimeoutMs;

    this._asm = new SegmentAssembler();
    // mAppToken = generateRandomData(4) (CHSesameOS2.kt:17)。セッションごとに新規。
    this._mAppToken = randomBytes(4);
    this._mSesameToken = null; // 4B initial token (device 由来)
    this._loginKeyPair = null; // login 用 app ECDH 鍵ペア (_startLogin で生成)
    this._sessionToken = null; // 8B (mAppToken ++ mSesameToken)
    this._cipher = null;       // SesameOS2BleCipher
    this._loggedIn = false;
    this._readyToRegister = false;

    this._readyWaiter = null;    // register(): initial 受信 (ReadyToRegister) を待つ
    this._registerWaiter = null; // register(): login publish (登録完了) を待つ
    this._loginWaiter = null;    // connect(): login response を待つ

    /** @type {Map<number, Array<{resolve:Function, reject:Function, timer:any}>>} item → FIFO */
    this._pending = new Map();
    this._statusListeners = new Set();
    this._publishListeners = new Set();
    this._lastStatus = null;
    this._lastLoginResponse = null;

    // サーバ認証 login (isNeedAuthFromServer)。connect({ signLogin }) で注入。
    // 設定時は sessionAuth をローカル計算せず signLogin(signPayloadHex) の戻り (hex) を使う
    // (CHSesame2Device.kt:240-242 / 526-530 signGuestKey→login(it.data))。
    this._signLogin = null;
    // register() 用のサーバ登録コールバック (myDevicesRegisterSesame2Post 相当)。
    this._registerServer = null;
    // register() 用の app ECDH 鍵ペア (register() 内で生成し、ハンドシェイク全体で共有)。
    this._regKeyPair = null;
  }

  _log(...a) { if (this._debug) console.error("[ble-os2]", ...a); }

  _isBusy() {
    return this._loggedIn || this._readyToRegister
      || this._loginWaiter != null || this._readyWaiter != null || this._registerWaiter != null;
  }

  get lastStatus() { return this._lastStatus; }
  get lastLoginResponse() { return this._lastLoginResponse; }
  get isLoggedIn() { return this._loggedIn; }
  get isReadyToRegister() { return this._readyToRegister; }

  onStatus(fn) { this._statusListeners.add(fn); return () => this._statusListeners.delete(fn); }
  onPublish(fn) { this._publishListeners.add(fn); return () => this._publishListeners.delete(fn); }

  /**
   * 接続して login まで完了させる (登録済みデバイス用)。secretKey/keyIndex/ssmPublicKey 必須。
   *
   * 通常 login (既定): sessionAuth = CMAC(secretKey, userIdx ++ appPubKey64 ++ sessionToken)
   *   をローカル計算 (CHSesame2Device.kt:243)。
   * サーバ認証 login (signLogin 指定時): signPayload (= userIdx ++ appPubKey64 ++ sessionToken) の
   *   hex を signLogin に渡し、サーバ署名済み sessionAuth (hex) を取得して使う
   *   (CHSesame2Device.kt:240,526-530)。
   *
   * @param {{signLogin?:(signPayloadHex:string)=>Promise<string>}} [opts]
   * @returns {Promise<void>} login 成功で resolve
   */
  async connect({ signLogin } = {}) {
    if (!this._secretKey && typeof signLogin !== "function") {
      return Promise.reject(new Error("secretKey required (or provide signLogin for server-auth login)"));
    }
    if (!this._ssmPublicKey) return Promise.reject(new Error("ssmPublicKey (device public key, 64B) required for OS2 login"));
    if (this._isBusy()) return Promise.reject(new Error("session already in use; construct a new SesameOS2BleSession instead"));
    this._signLogin = typeof signLogin === "function" ? signLogin : null;
    const loginPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._loginWaiter = null;
        reject(new Error("OS2 BLE login timeout (no initial/login response)"));
      }, LOGIN_TIMEOUT_MS);
      this._loginWaiter = { resolve, reject, timer };
    });
    await this._connectTransport();
    return loginPromise;
  }

  /**
   * 工場出荷 (未登録) デバイスの登録ハンドシェイク (CHSesame2Device.kt:406-482)。
   * secretKey を渡さずに構築した session で呼ぶ。
   *
   * フロー:
   *   1. transport 接続 → initial(14) publish を待つ (secretKey 無し → ReadyToRegister)。
   *   2. READ IRER を PLAINTEXT 送出し、応答 payload から ER = payload.drop(16) を取り出す。
   *   3. registerServer({ deviceUUID, ak, mSesameToken, ER, productType }) を呼び、
   *      サーバから { sig1, serverToken(st), sesamePublicKey(pubkey) } を得る。
   *   4. ECDH(sesamePublicKey) → pre16。
   *   5. registerKey/ownerKey/sessionKey = deriveRegisterKeys(pre16, serverToken, mSesameToken)。
   *      cipher = (sessionKey, sessionToken)。
   *   6. payload = sig1[0:4] ++ appPubKey64 ++ serverToken、CREATE REGISTRATION を PLAINTEXT 送出。
   *   7. login publish (登録完了) を待ち、{deviceUUID, secretKey(=pre16 hex), ownerKey, sesamePublicKey} を返す。
   *
   * @param {{deviceUUID:string, productType?:(string|number),
   *          registerServer:(req:{deviceUUID:string, ak:Buffer, mSesameToken:Buffer, ER:string,
   *                                productType:(string|number|undefined),
   *                                appPubK64:Buffer, appPubK64Base64:string})=>Promise<{sig1:(string|Buffer),
   *                                serverToken:(string|Buffer), sesamePublicKey:(string|Buffer)}>,
   *          ak?:Buffer}} opts
   *   registerServer: myDevicesRegisterSesame2Post に相当する注入関数。base64/hex/Buffer いずれの
   *     戻りも受ける (内部で Buffer 化)。req には session が生成した app の登録用 ECDH 公開鍵
   *     (appPubK64 / その base64 appPubK64Base64) も載る。CHSesame2Device.kt は getRegisterKey の
   *     ak に EccKey.getRegisterAK() = base64(app 公開鍵) を使うため、ローカル実装
   *     (crypto.js makeLocalRegisterServer) はこの appPubK64 を ak に採用する。本番のサーバ実装は
   *     ak フィールド (または appPubK64) を使う/無視するを選べる。ak は EccKey.getRegisterAK() 相当
   *     (省略時は appPubK64 をローカル registerServer が使う)。
   * @returns {Promise<{deviceUUID:string, secretKey:string, ownerKey:string,
   *                    sesamePublicKey:string, serverSecret:string}>}
   */
  async register({ deviceUUID, productType, registerServer, ak } = {}) {
    if (this._secretKey) return Promise.reject(new Error("register() requires a factory device: construct WITHOUT secretKey"));
    if (!deviceUUID) return Promise.reject(new Error("deviceUUID required for register()"));
    if (typeof registerServer !== "function") return Promise.reject(new Error("registerServer callback required for OS2 register()"));
    if (this._isBusy()) return Promise.reject(new Error("session already in use; construct a new SesameOS2BleSession instead"));
    this._registerServer = registerServer;

    // 1. 接続 → initial を待って ReadyToRegister に遷移するのを待つ。
    if (!this._readyToRegister) {
      const readyPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this._readyWaiter = null;
          reject(new Error("register() did not reach ReadyToRegister (no initial)"));
        }, LOGIN_TIMEOUT_MS);
        this._readyWaiter = { resolve, reject, timer };
      });
      await this._connectTransport();
      await readyPromise;
    }

    const mSesameToken = this._mSesameToken;
    const serverSecret = mSesameToken.toString("hex"); // CHSesame2Device.kt:428 mSesameToken.base64Encode 相当

    // 2. READ IRER (PLAINTEXT) → ER = payload.drop(16) (CHSesame2Device.kt:412-418)。
    const irRes = await this._requestPlain(OP.READ, ITEM.IRER, Buffer.alloc(0), REGISTER_TIMEOUT_MS);
    if (irRes.payload.length < 16) throw new Error(`IRER payload too short (got ${irRes.payload.length})`);
    const ER = irRes.payload.subarray(16).toString("hex");

    // 3. app ECDH 鍵ペアを生成 (login の EccKey.getPubK() に相当)。
    this._regKeyPair = createECDH("prime256v1");
    this._regKeyPair.generateKeys();
    const appPubK64 = this._appPubK64(this._regKeyPair);

    // 4. サーバ登録 (myDevicesRegisterSesame2Post)。sig1 / serverToken(st) / sesamePublicKey(pubkey) を得る。
    //    appPubK64/appPubK64Base64 も渡す: CHSesame2Device.kt は getRegisterKey の ak に
    //    EccKey.getRegisterAK() = base64(app 登録用公開鍵) を使うため、ローカル registerServer
    //    (makeLocalRegisterServer) が caller 由来 ak ではなく session が生成した app 鍵を使えるよう
    //    公開鍵を渡す (本番のサーバ実装は無視してよい追加フィールド)。
    const srvResp = await this._registerServer({
      deviceUUID, ak, mSesameToken, ER, productType,
      appPubK64, appPubK64Base64: appPubK64.toString("base64"),
    });
    // SDK は sig1/st/pubkey をすべて base64decodeByteArray する (CHSesame2Device.kt:440-443)。
    // 文字列は base64 とみなす (Buffer/Uint8Array はそのまま)。
    const sig1 = toBuf(srvResp.sig1, "base64");
    const serverToken = toBuf(srvResp.serverToken ?? srvResp.st, "base64");
    const sesamePublicKey = toBuf(srvResp.sesamePublicKey ?? srvResp.pubkey, "base64");

    // 5. ECDH(sesamePublicKey) → pre16、登録鍵束 (CHSesame2Device.kt:445-456)。
    const pre16 = ecdhSecretPre16(this._regKeyPair, sesamePublicKey);
    const { ownerKey, sessionKey, sessionToken: regSessionToken } = deriveRegisterKeys(pre16, serverToken, mSesameToken);
    const secretKey = pre16.toString("hex"); // 登録後の device 共通鍵 = ECDH pre16 (CHSesame2Device.kt 後続 login で secretKey 化)

    // 6. cipher 確立 (sessionKey, regSessionToken)。enc/decCount は cipher 内部で 0 起点。
    this._cipher = new SesameOS2BleCipher(sessionKey, regSessionToken);
    this._sessionToken = regSessionToken;

    // 7. REGISTRATION 応答 (login publish) 待ちを登録してから CREATE REGISTRATION を PLAINTEXT 送出。
    const regPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._registerWaiter = null;
        reject(new Error("OS2 BLE registration timeout (no login publish)"));
      }, REGISTER_TIMEOUT_MS);
      this._registerWaiter = { resolve, reject, timer };
    });
    const payload = registrationData(sig1, appPubK64, serverToken);
    this._sendPlain(buildSendFrame(OP.CREATE, ITEM.REGISTRATION, payload));
    await regPromise; // login publish 受信で resolve

    this._loggedIn = true;
    this._readyToRegister = false;
    this._secretKey = Buffer.from(secretKey, "hex");

    pre16.fill(0);

    return {
      deviceUUID,
      secretKey,
      ownerKey: ownerKey.toString("hex"),
      sesamePublicKey: sesamePublicKey.toString("hex"),
      serverSecret,
    };
  }

  /** Node getPublicKey() (65B) から SDK 契約の 64B raw (prefix 無し) を取り出す。 */
  _appPubK64(keyPair) {
    const pub65 = keyPair.getPublicKey();
    if (pub65.length !== 65 || pub65[0] !== ECDH_UNCOMPRESSED_PREFIX) {
      throw new Error(`unexpected ECDH public key length ${pub65.length} (expected 65B uncompressed)`);
    }
    return pub65.subarray(1);
  }

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
   * OS3 session._failAllPending と対称。
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
    this._signLogin = null;
  }

  /**
   * transport を onPacket / onDisconnect 配線付きで接続する (connect()/register() 共通)。
   * onDisconnect: リンク断 (相手側切断 / 圏外 / write リトライ枯渇) で pending/待機者を即 reject し、
   * OS3 session 同様 timeout 宙づりを防ぐ (fail-fast)。transport が 2 引数 connect 非対応でも安全。
   */
  _connectTransport() {
    return this._transport.connect(
      (packet) => this._onPacket(packet),
      (reason) => this._handleTransportDisconnect(reason),
    );
  }

  /**
   * transport から「リンクが切れた」と通知されたときのハンドラ (transport.connect の onDisconnect)。
   * OS3 session._handleTransportDisconnect と同様、pending/待機者を即 reject して **timeout 宙づりを
   * 防ぐ** (fail-fast)。能動 disconnect() と異なり transport.disconnect() は呼ばない (既に切断済み・
   * 自分が起点ではないため)。何度呼ばれても安全 (待機者・pending が無ければ no-op)。
   * @param {any} reason 切断理由 (noble の reason 文字列等)
   */
  _handleTransportDisconnect(reason) {
    this._log("transport disconnected, failing pending requests", reason);
    this._failAllPending(new Error(t("ble.linkLost")));
  }

  async disconnect() {
    // pending / 待機者を全て reject してリーク防止 (connect()/register() の await が永久ハングしない)。
    this._failAllPending(new Error(t("ble.disconnected")));
    await this._transport.disconnect();
  }

  /**
   * 暗号化コマンドを送り、response(7)+item を待って返す。
   * OS2 はフレームに opCode を含むため (lock/unlock/click は async、read/update は対応 opCode)、
   * opCode を明示的に渡す。
   * @param {number} opCode OP.* (lock/unlock/click は OP.ASYNC、autolock は OP.UPDATE 等)
   * @param {number} itemCode ITEM.*
   * @param {Buffer} [data]
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<{resultCode:number, payload:Buffer}>}
   */
  request(opCode, itemCode, data = Buffer.alloc(0), { timeoutMs } = {}) {
    if (!this._loggedIn) return Promise.reject(new Error("not logged in (call connect() first)"));
    const to = timeoutMs ?? this._defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._dequeue(itemCode, entry);
        reject(new Error(`OS2 BLE request timeout (item=${itemCode})`));
      }, to);
      const entry = { resolve, reject, timer };
      if (!this._pending.has(itemCode)) this._pending.set(itemCode, []);
      this._pending.get(itemCode).push(entry);
      this._sendCipher(buildSendFrame(opCode, itemCode, data));
    });
  }

  /** PLAINTEXT で送り、response(7)+item を待つ (register の IRER 読み出し等)。 */
  _requestPlain(opCode, itemCode, data, timeoutMs) {
    const to = timeoutMs ?? this._defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._dequeue(itemCode, entry);
        reject(new Error(`OS2 BLE request timeout (item=${itemCode})`));
      }, to);
      const entry = { resolve, reject, timer };
      if (!this._pending.has(itemCode)) this._pending.set(itemCode, []);
      this._pending.get(itemCode).push(entry);
      this._sendPlain(buildSendFrame(opCode, itemCode, data));
    });
  }

  /** 暗号化なしで送る (login / registration / IRER 等のハンドシェイク用)。 */
  _sendPlain(frame) {
    for (const seg of splitSegments(frame, SEG.PLAINTEXT)) this._transport.write(seg);
  }

  /** OS2 CCM 暗号化して送る (cipher 内部で encCount++)。 */
  _sendCipher(frame) {
    const ct = this._cipher.encrypt(frame);
    for (const seg of splitSegments(ct, SEG.CIPHERTEXT)) this._transport.write(seg);
  }

  _dequeue(itemCode, entry) {
    const queue = this._pending.get(itemCode);
    if (!queue) return;
    const i = queue.indexOf(entry);
    if (i >= 0) queue.splice(i, 1);
    if (queue.length === 0) this._pending.delete(itemCode);
  }

  // ---------- 受信 ----------

  _onPacket(packet) {
    let assembled;
    try { assembled = this._asm.feed(Buffer.isBuffer(packet) ? packet : Buffer.from(packet)); }
    catch (e) { this._log("assemble error", e); return; }
    if (!assembled) return;

    let frame;
    if (assembled.type === SEG.CIPHERTEXT) {
      // SesameOS2BleCipher.decrypt() は doFinal の前に decryptCounter を進める。これに倣い、
      // 復号失敗 (破損/取りこぼし) してもこの 1 フレームだけ捨て、counter は進めて後続と整合させる。
      try {
        frame = this._cipher.decrypt(assembled.data);
      } catch (e) {
        this._log("decrypt failed; skipping this frame", e?.message);
        return;
      }
    } else {
      frame = assembled.data; // PLAINTEXT (initial / login 応答が平文の場合)
    }

    let parsed;
    try { parsed = parseRecvFrame(frame); }
    catch (e) { this._log("parse error", e?.message); return; }
    this._log("recv", parsed.type, "item", parsed.itemCode);

    if (parsed.type === "publish") {
      const { itemCode, payload } = parsed;
      if (itemCode === ITEM.INITIAL) { this._handleInitial(payload); return; }
      if (itemCode === ITEM.LOGIN) { this._handleLoginPublish(payload); return; }
      if (itemCode === ITEM.MECH_STATUS) {
        try { this._lastStatus = parseMechStatus(payload); } catch { /* ignore */ }
        for (const fn of [...this._statusListeners]) { try { fn(this._lastStatus); } catch { /* ignore */ } }
      }
      for (const fn of [...this._publishListeners]) { try { fn({ itemCode, payload }); } catch { /* ignore */ } }
      return;
    }

    if (parsed.type === "response") {
      const { itemCode, resultCode, payload } = parsed;
      if (itemCode === ITEM.LOGIN) { this._handleLoginResponse(resultCode, payload); return; }
      this._resolvePending(itemCode, resultCode, payload);
    }
  }

  _handleInitial(token) {
    if (!token || token.length < 4) { this._log("initial token too short"); return; }
    this._mSesameToken = Buffer.from(token.subarray(0, 4));
    // secretKey も signLogin も無い (工場出荷) → login せず ReadyToRegister へ。
    if (!this._secretKey && !this._signLogin) {
      this._readyToRegister = true;
      this._log("initial received, no secretKey → ReadyToRegister");
      this._resolveWaiter("_readyWaiter");
      return;
    }
    // sessionToken / ECDH / sessionKey を確立し login を送る。
    this._startLogin();
  }

  /** login ハンドシェイク本体 (CHSesame2Device.kt:231-255)。signLogin 指定時は非同期で sessionAuth を取得。 */
  _startLogin() {
    this._sessionToken = buildSessionToken(this._mAppToken, this._mSesameToken);
    // app ECDH 鍵ペア (EccKey は本来アプリ単位で永続だが、本実装はセッション単位で生成する。
    // login の signPayload / loginPayload に載る appPubKey と ECDH が同一鍵ペアであれば整合する)。
    if (!this._loginKeyPair) {
      this._loginKeyPair = createECDH("prime256v1");
      this._loginKeyPair.generateKeys();
    }
    const appPubK64 = this._appPubK64(this._loginKeyPair);
    const pre16 = ecdhSecretPre16(this._loginKeyPair, this._ssmPublicKey);
    const sessionKey = deriveSessionKey(pre16, this._sessionToken);
    this._cipher = new SesameOS2BleCipher(sessionKey, this._sessionToken);
    pre16.fill(0);

    if (this._signLogin) {
      // サーバ認証: signPayload = userIdx ++ appPubKey64 ++ sessionToken。hex をサーバへ。
      const signPayload = Buffer.concat([this._keyIndex, appPubK64, this._sessionToken]);
      this._loginViaServer(signPayload, appPubK64);
      return;
    }
    const auth = computeSessionAuth(this._secretKey, this._keyIndex, appPubK64, this._sessionToken);
    this._sendLogin(appPubK64, auth);
  }

  async _loginViaServer(signPayload, appPubK64) {
    let serverAuth;
    try {
      serverAuth = await this._signLogin(signPayload.toString("hex"));
    } catch (e) {
      this._rejectWaiter("_loginWaiter", e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const auth = Buffer.isBuffer(serverAuth) ? serverAuth : Buffer.from(String(serverAuth), "hex");
    if (auth.length < 4) {
      this._rejectWaiter("_loginWaiter", new Error(`server-signed sessionAuth must be >= 4 bytes (got ${auth.length})`));
      return;
    }
    this._sendLogin(appPubK64, auth);
  }

  /** login(2) を SYNC opCode で PLAINTEXT 送る (CHSesame2Device.kt:254-255)。 */
  _sendLogin(appPubK64, auth16) {
    const data = loginPayload(this._keyIndex, appPubK64, this._mAppToken, auth16);
    this._sendPlain(buildSendFrame(OP.SYNC, ITEM.LOGIN, data));
    this._log("login sent");
  }

  _handleLoginResponse(resultCode, payload) {
    if (!this._loginWaiter) return;
    if (resultCode !== 0) { this._rejectWaiter("_loginWaiter", new BleResultError("login", resultCode, ITEM.LOGIN)); return; }
    try { this._lastLoginResponse = parseLoginResponse(payload); this._lastStatus = this._lastLoginResponse.mechStatus; }
    catch (e) { this._log("login response parse failed", e?.message); }
    this._loggedIn = true;
    this._maybeSyncTime();
    this._resolveWaiter("_loginWaiter");
  }

  /** 登録直後はデバイスが response ではなく login **publish** で完了を知らせる (CHSesame2Device.kt:508-517)。 */
  _handleLoginPublish(payload) {
    try { this._lastLoginResponse = parseLoginResponse(payload); this._lastStatus = this._lastLoginResponse.mechStatus; }
    catch (e) { this._log("login publish parse failed", e?.message); }
    // register() の登録完了通知。
    if (this._registerWaiter) {
      this._loggedIn = true;
      this._maybeSyncTime();
      this._resolveWaiter("_registerWaiter");
      return;
    }
    // login() 経路でも publish 形式で来る可能性に備える (CHSesame2Device.kt は通常 response だが
    // Bot/Bike は publish 経路も持つ: CHSesameBotDevice.kt:273-305)。
    if (this._loginWaiter) {
      this._loggedIn = true;
      this._maybeSyncTime();
      this._resolveWaiter("_loginWaiter");
    }
  }

  /** login response の systemTime と現在時刻の差が大きければ timePhone を送る (CHSesame2Device.kt:259-264)。 */
  _maybeSyncTime() {
    const lr = this._lastLoginResponse;
    if (!lr) return;
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - lr.systemTime) > 3) {
      // ★OS2 は TIME(8) ではなく timePhone(16) で時刻同期する (CHSesame2Device.kt:263)。
      try { this._sendCipher(buildSendFrame(OP.UPDATE, ITEM.TIMEPHONE, timePhoneData())); }
      catch (e) { this._log("timePhone sync failed", e?.message); }
    }
  }

  _resolveWaiter(field, value) {
    const w = this[field];
    if (!w) return;
    this[field] = null;
    clearTimeout(w.timer);
    w.resolve(value);
  }

  _resolvePending(itemCode, resultCode, payload) {
    const queue = this._pending.get(itemCode);
    if (!queue || queue.length === 0) return;
    const entry = queue.shift();
    if (queue.length === 0) this._pending.delete(itemCode);
    clearTimeout(entry.timer);
    // IRER 等の read は resultCode!=0 でも payload を使う場面があるが、SDK 同様 0 以外は失敗扱いにする。
    if (resultCode === 0) entry.resolve({ resultCode, payload });
    else entry.reject(new BleResultError("command", resultCode, itemCode));
  }
}

/**
 * 文字列 or Buffer/Uint8Array を Buffer 化 (registerServer の戻り正規化)。
 * SDK は server フィールド (sig1/st/pubkey) を base64decodeByteArray するため、文字列は
 * 既定で base64 と解釈する (encoding 引数で hex も指定可)。Buffer/Uint8Array はそのまま。
 * @param {string|Buffer|Uint8Array} v
 * @param {"base64"|"hex"} [encoding="base64"]
 * @returns {Buffer}
 */
function toBuf(v, encoding = "base64") {
  if (v == null) throw new Error("registerServer returned a null/undefined field");
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === "string") return Buffer.from(v, encoding);
  throw new Error(`cannot coerce to Buffer (got ${typeof v})`);
}
