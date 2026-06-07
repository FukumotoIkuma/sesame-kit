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

import { Buffer } from "node:buffer";
import { t } from "../i18n.js";
import {
  deriveSessionKey, loginPayload, ccmEncrypt, ccmDecrypt,
  splitSegments, SegmentAssembler, buildSendFrame, parseRecvFrame,
  parseMechStatus, OP, ITEM, SEG, resultName,
} from "./protocol.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const LOGIN_TIMEOUT_MS = 8_000;

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
 * @property {(onPacket:(packet:Buffer)=>void)=>Promise<void>} connect 接続+notify購読。各 notify を onPacket へ。
 * @property {(bytes:Buffer)=>void|Promise<void>} write Write Without Response。
 * @property {()=>void|Promise<void>} disconnect 切断。
 */

export class SesameBleSession {
  /**
   * @param {{transport:BleTransport, secretKey:string|Buffer, debug?:boolean,
   *          defaultTimeoutMs?:number}} opts
   */
  constructor({ transport, secretKey, debug = false, defaultTimeoutMs = DEFAULT_TIMEOUT_MS }) {
    if (!transport) throw new Error(t("ble.transportRequired"));
    if (!secretKey) throw new Error(t("ble.secretKeyRequiredSession"));
    this._transport = transport;
    this._secretKey = Buffer.isBuffer(secretKey) ? secretKey : Buffer.from(secretKey, "hex");
    this._debug = debug;
    this._defaultTimeoutMs = defaultTimeoutMs;

    this._asm = new SegmentAssembler();
    this._token = null; // 4B initial token
    this._key = null; // 16B session key
    this._encCount = 0;
    this._decCount = 0;
    this._loggedIn = false;

    /** @type {Map<number, Array<{resolve:Function, reject:Function, timer:any}>>} item → FIFO */
    this._pending = new Map();
    this._statusListeners = new Set();
    this._publishListeners = new Set();
    this._lastStatus = null;
    this._loginWaiter = null;
  }

  _log(...a) { if (this._debug) console.error("[ble]", ...a); }

  /** 最後に受信した mechStatus (parseMechStatus の結果)。未受信なら null。 */
  get lastStatus() { return this._lastStatus; }
  get isLoggedIn() { return this._loggedIn; }

  /** mechStatus publish を購読。戻り値 unsubscribe。 */
  onStatus(fn) { this._statusListeners.add(fn); return () => this._statusListeners.delete(fn); }
  /** 任意 publish を購読 ({opCode,itemCode,body})。戻り値 unsubscribe。 */
  onPublish(fn) { this._publishListeners.add(fn); return () => this._publishListeners.delete(fn); }

  /**
   * 接続して login まで完了させる。
   * @returns {Promise<void>} login 成功で resolve
   */
  async connect() {
    const loginPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._loginWaiter = null;
        reject(new Error(t("ble.loginTimeout")));
      }, LOGIN_TIMEOUT_MS);
      this._loginWaiter = { resolve, reject, timer };
    });
    await this._transport.connect((packet) => this._onPacket(packet));
    return loginPromise;
  }

  async disconnect() {
    // pending を全て reject してリーク防止
    for (const [, queue] of this._pending) {
      for (const p of queue) { clearTimeout(p.timer); p.reject(new Error(t("ble.disconnected"))); }
    }
    this._pending.clear();
    if (this._loginWaiter) { clearTimeout(this._loginWaiter.timer); this._loginWaiter = null; }
    await this._transport.disconnect();
    this._loggedIn = false;
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
      this._pending.get(itemCode).push(entry);
      // 送信は subscribe 登録後に (race 防止)
      this._sendCipher(buildSendFrame(itemCode, data));
    });
  }

  /** 暗号化なしで item+data を送る (login 等のハンドシェイク用低レベル)。 */
  _sendPlain(frame) {
    for (const seg of splitSegments(frame, SEG.PLAINTEXT)) this._transport.write(seg);
  }

  /** CCM 暗号化して送る (encCount++)。 */
  _sendCipher(frame) {
    const ct = ccmEncrypt(this._key, this._encCount, this._token, frame);
    this._encCount += 1;
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
    if (!assembled) return; // 未完

    let frame;
    if (assembled.type === SEG.CIPHERTEXT) {
      try {
        frame = ccmDecrypt(this._key, this._decCount, this._token, assembled.data);
      } catch (e) {
        // 復号失敗 = カウンタずれ or 破損。デバイス側が当該メッセージで enc カウンタを進めたかは
        // 判別不能なため _decCount は進めない (進めると正常時にずれる)。以降ずれ続けるが、これは
        // 異常系であり、回復は再接続 (initial で両カウンタ 0 リセット) に委ねる。
        this._log("decrypt failed (count desync / corruption)", e?.message);
        return;
      }
      this._decCount += 1;
    } else {
      frame = assembled.data; // PLAINTEXT (initial / login 応答が平文の場合)
    }

    let parsed;
    try { parsed = parseRecvFrame(frame); }
    catch (e) { this._log("parse error", e?.message); return; }
    const { opCode, itemCode, body } = parsed;
    this._log("recv", { opCode, itemCode, len: body.length });

    if (opCode === OP.PUBLISH) {
      if (itemCode === ITEM.INITIAL) { this._handleInitial(body); return; }
      if (itemCode === ITEM.MECH_STATUS) {
        try { this._lastStatus = parseMechStatus(body); } catch { /* ignore */ }
        for (const fn of [...this._statusListeners]) { try { fn(this._lastStatus); } catch { /* ignore */ } }
      }
      for (const fn of [...this._publishListeners]) { try { fn({ opCode, itemCode, body }); } catch { /* ignore */ } }
      return;
    }

    if (opCode === OP.RESPONSE) {
      const resultCode = body.length > 0 ? body[0] : 0;
      const payload = body.subarray(1);
      if (itemCode === ITEM.LOGIN) { this._handleLoginResponse(resultCode); return; }
      this._resolvePending(itemCode, resultCode, payload);
    }
  }

  _handleInitial(token) {
    if (!token || token.length < 4) { this._log("initial token too short"); return; }
    this._token = Buffer.from(token.subarray(0, 4));
    this._encCount = 0;
    this._decCount = 0;
    this._key = deriveSessionKey(this._secretKey, this._token);
    this._log("initial token received, sending login");
    this._sendPlain(loginPayload(this._key)); // login は PLAINTEXT
  }

  _handleLoginResponse(resultCode) {
    if (!this._loginWaiter) return;
    const w = this._loginWaiter;
    this._loginWaiter = null;
    clearTimeout(w.timer);
    if (resultCode === 0) { this._loggedIn = true; w.resolve(); }
    else w.reject(new BleResultError("login", resultCode));
  }

  _resolvePending(itemCode, resultCode, payload) {
    const queue = this._pending.get(itemCode);
    if (!queue || queue.length === 0) return; // 対応する request なし (unsolicited)
    const entry = queue.shift();
    if (queue.length === 0) this._pending.delete(itemCode);
    clearTimeout(entry.timer);
    if (resultCode === 0) entry.resolve({ resultCode, payload });
    else entry.reject(new BleResultError("command", resultCode, itemCode));
  }
}
