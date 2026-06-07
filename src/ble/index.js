// SESAME BLE 直接制御の公開エントリ。
//
// クラウド (WebSocket/biz3) を介さず、PC の Bluetooth から登録済み SESAME を直接操作する。
// クラウドでは不可だった設定系 (autolock 等) も BLE なら本体に反映される。
//
// 使い方 (高レベル):
//   import { SesameBle } from "sesame-kit";        // もしくは: import { ble } from "sesame-kit"
//   await SesameBle.use({ deviceUUID, secretKey }, async (lock) => {
//     await lock.unlock();
//     await lock.autolock(30);              // ← クラウド不可・BLE 可
//     console.log(lock.lastStatus);
//   });
//
// 低レベル層 (protocol/session/transport) も個別 export。独自トランスポートを注入する場合は
// new SesameBle({ secretKey, transport }) で差し替え可能。

import { Buffer } from "node:buffer";
import { t } from "../i18n.js";
import { SesameBleSession } from "./session.js";
import { createBleTransport } from "./transport.js";
import {
  ITEM, MECH_STATE, historyTagBLE, autolockData,
} from "./protocol.js";
import { capabilitiesForModel } from "./devicemodel.js";

import { scanSesames, NobleTransport } from "./transport.js";

export { SesameBleSession, BleResultError } from "./session.js";
// SesameResultCode (デバイス層の結果コード taxonomy)。BLE エラーの .resultName で分岐可能。
export { RESULT as SESAME_RESULT_CODES, resultName } from "./protocol.js";
export { NobleTransport, createBleTransport, advToDeviceUUID, scanSesames } from "./transport.js";
export * as protocol from "./protocol.js";
export * as devicemodel from "./devicemodel.js";
export { capabilitiesForModel, kindForModel, supportsOp, isOperable, transportsForOp, KIND, PRODUCT_TYPES } from "./devicemodel.js";

/** deviceUUID 正規化 (照合用)。 */
function normId(u) { return String(u).replace(/-/g, "").toLowerCase(); }

const STATUS_WAIT_MS = 4_000;

/**
 * 登録済み SESAME を BLE で直接操作する高レベルファサード。
 */
export class SesameBle {
  /**
   * @param {{
   *   secretKey: string|Buffer,   // 32hex のロック共通鍵 (cloud の `sesame devices` で取得済み)
   *   deviceUUID?: string,        // 対象識別 (advertise 照合)。複数 SESAME が近接する環境で必須
   *   address?: string,           // BLE アドレスで識別する代替
   *   debug?: boolean,
   *   transport?: object,         // 独自トランスポート (省略時 noble)
   * }} opts
   */
  constructor({ secretKey, deviceUUID, address, model = null, debug = false, scanTimeoutMs, transport } = {}) {
    if (!secretKey) throw new Error(t("ble.secretKeyRequired"));
    this._transport = transport || createBleTransport({ deviceUUID, address, debug, scanTimeoutMs });
    this._session = new SesameBleSession({ transport: this._transport, secretKey, debug });
    this._model = model;
    this._caps = capabilitiesForModel(model); // 型ごとの能力 (SDK CHProductModel 準拠)
  }

  /** デバイスの model 文字列 (例 "sesame_5" / "bot_2")。未指定なら null。 */
  get model() { return this._model; }
  /** 型ごとの能力 { kind, os, ops, mechKind, bleSupported, label }。 */
  get capabilities() { return this._caps; }
  /** この操作を BLE で送れるか (このファサードは BLE 専用なので ble 能力で判定)。 */
  supports(op) { return this._caps.ble.includes(op); }

  /** BLE で送れない操作を弾く。SDK では型ごとに能力が非対称 (Bot は click のみ等)。 */
  _assertOp(op) {
    if (!this._caps.ble.includes(op)) {
      const ok = this._caps.ble.length ? this._caps.ble.join("/") : t("ble.noBleLockOps");
      throw new Error(t("ble.opNotSupported", {
        label: this._caps.label,
        modelSuffix: this._model ? ` (${this._model})` : "",
        op,
        ok,
      }));
    }
  }

  /** mechStatus publish を購読 (戻り値 unsubscribe)。 */
  onStatus(fn) { return this._session.onStatus(fn); }
  /** 最後に受信した mechStatus。 */
  get lastStatus() { return this._session.lastStatus; }
  get isConnected() { return this._session.isLoggedIn; }

  /** 接続 + login。 */
  async connect() { await this._session.connect(); return this; }
  /** 切断。 */
  async close() { await this._session.disconnect(); }

  /**
   * 施錠 (BLE item=82)。tag は履歴に残す任意ラベル。
   * @returns {Promise<{resultCode:number, payload:Buffer}>}
   */
  lock(tag) { this._assertOp("lock"); return this._session.request(ITEM.LOCK, historyTagBLE(tag)); }

  /** 解錠 (BLE item=83)。Sesame5/6 ロックと Bike2 が対応。 */
  unlock(tag) { this._assertOp("unlock"); return this._session.request(ITEM.UNLOCK, historyTagBLE(tag)); }

  /**
   * SESAME Bot のクリック (BLE item=89)。Bot2/Bot3 のみ。
   * @param {Buffer} [tag] 履歴タグ (UUID バイト列)
   */
  click(tag) { this._assertOp("click"); return this._session.request(ITEM.CLICK, historyTagBLE(tag)); }

  /**
   * トグル (Sesame5/6 ロックのみ)。直近の mechStatus が無ければ status() を取得してから判定。
   * locked → unlock、それ以外 → lock (CHSesame5Device.kt:128-145 準拠)。
   */
  async toggle(tag) {
    this._assertOp("toggle");
    let s = this.lastStatus;
    if (!s) s = await this.status().catch(() => null);
    if (s && s.state === MECH_STATE.LOCKED) return this._session.request(ITEM.UNLOCK, historyTagBLE(tag));
    return this._session.request(ITEM.LOCK, historyTagBLE(tag));
  }

  /**
   * オートロック設定 (BLE item=11、2byte LE 秒数。0=無効)。Sesame5/6 ロックのみ。
   * **BLE 経由なら実機に反映される** (クラウドの biz3TriggerLocker では ack のみで未反映だった機能)。
   * @param {number} seconds 0..65535
   */
  autolock(seconds) { this._assertOp("autolock"); return this._session.request(ITEM.AUTOLOCK, autolockData(seconds)); }

  /**
   * 現在の mechStatus を返す。未受信なら publish を待つ (timeout 付き)。
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<object>} parseMechStatus の結果
   */
  status({ timeoutMs = STATUS_WAIT_MS } = {}) {
    if (this._session.lastStatus) return Promise.resolve(this._session.lastStatus);
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => { off(); reject(new Error(t("ble.mechStatusTimeout"))); }, timeoutMs);
      const off = this._session.onStatus((s) => { clearTimeout(to); off(); resolve(s); });
    });
  }

  /**
   * 履歴を 1 バッチ取得 (BLE item=4)。payload の解析は呼び出し側 (生バイト返し)。
   * @returns {Promise<Buffer>}
   */
  async history() {
    const r = await this._session.request(ITEM.HISTORY, Buffer.from([0x01]));
    return r.payload;
  }

  /**
   * connect → fn → close を自動で行うヘルパー。
   * @param {object} opts コンストラクタ opts
   * @param {(lock:SesameBle)=>Promise<any>} fn
   */
  static async use(opts, fn) {
    const lock = new SesameBle(opts);
    await lock.connect();
    try { return await fn(lock); }
    finally { await lock.close(); }
  }

  /**
   * 複数ロックに**1 回のスキャン**で同時接続する (逐次スキャンを避ける正攻法)。
   * 近接していないロックは結果に現れず即スキップ (per-device の scan timeout を払わない)。
   * 見つかったロックへは**並行接続** (login まで)。
   *
   * @param {Array<{name:string, deviceUUID:string, secretKey:string, model?:string}>} entries
   * @param {{debug?:boolean, scanTimeoutMs?:number}} [opts]
   * @returns {Promise<{connected: Map<string, SesameBle>, unreachable: string[], failed: Array<{name:string, error:Error}>}>}
   */
  static async connectMany(entries, { debug = false, scanTimeoutMs = 8_000 } = {}) {
    const found = await scanSesames({ deviceUUIDs: entries.map((e) => e.deviceUUID), timeoutMs: scanTimeoutMs, debug });
    const byNorm = new Map([...found.entries()].map(([uuid, p]) => [normId(uuid), p]));

    const connected = new Map();
    const unreachable = [];
    const failed = [];

    const inRange = entries.filter((e) => byNorm.has(normId(e.deviceUUID)));
    for (const e of entries) if (!byNorm.has(normId(e.deviceUUID))) unreachable.push(e.name);

    // 見つかったものは並行で connect+login (別 peripheral なので同時接続可)。
    await Promise.all(inRange.map(async (e) => {
      const peripheral = byNorm.get(normId(e.deviceUUID));
      const ble = new SesameBle({ secretKey: e.secretKey, deviceUUID: e.deviceUUID, model: e.model, debug, transport: new NobleTransport({ peripheral, debug }) });
      try { await ble.connect(); connected.set(e.name, ble); }
      catch (error) { failed.push({ name: e.name, error }); await ble.close().catch(() => {}); }
    }));

    return { connected, unreachable, failed };
  }
}
