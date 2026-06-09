// SesameHub3 高レベルクライアント。
// 低レベル WS (Hub3WsClient) とトークン管理 / 設定解決を内部で抱える。
//
// 使い方:
//   const hub = await SesameHub3.fromConfig();   // ~/.config/sesame-kit から
//   await hub.connect();
//   await hub.send("ac", "停止");                  // (remote名, キー名 or keyUUID)
//   await hub.close();
//
// ライブラリ消費者で独自のトークン保管をしたい場合は、下記 TokenStore 実装を渡す。
//
// API の 2 系統:
//   - name-based : config の hub3s/remotes/locks に登録した名前で操作 (`unlock("front")`)
//   - direct     : config を介さず deviceUUID + secretKey を直接渡す (`unlockDevice({...})`)
//                  → `*Device` / `*Direct` サフィックスが付くものが direct 系。

/**
 * トークン永続化インターフェース。FileTokenStore がデフォルト実装。
 * 独自実装 (keychain / DB / メモリ) を渡す場合は下記 6 メソッドすべて必須。
 *
 * @typedef {Object} TokenStore
 * @property {() => (object|null)} load            保存済みトークン {idToken, refreshToken, clientId, accessToken?, deviceKey?} を返す。無ければ null
 * @property {(tokens: object) => void} save       トークンを永続化 (refresh 時に呼ばれる)
 * @property {() => void} clear                     トークンを破棄
 * @property {() => (object|null)} loadPending      sign-in 進行中の一時状態を返す。無ければ null
 * @property {(state: object) => void} savePending  sign-in 進行中の一時状態を保存
 * @property {() => void} clearPending              sign-in 一時状態を破棄
 */

import { Hub3WsClient, sendIR, getIRCodes } from "./transport.js";
import { ConfigStore, normalizeConfig } from "./config.js";
import { FileTokenStore } from "./tokens.js";
import { getValidIdToken, jwtSub } from "./auth.js";
import { configPaths } from "./paths.js";
import { LockManager } from "./lock-manager.js";
import { ACTION_TYPES } from "../vendor/biz3/constants/messageConstants.js";
import * as ir from "./ir.js";
import * as devices from "./devices.js";
import * as account from "./account.js";
import * as schedule from "./schedule.js";
import * as org from "./org.js";
import * as company from "./company.js";
import * as access from "./access.js";
import * as iot from "./iot.js";
import * as presetir from "./presetir.js";
import * as payment from "./payment.js";
import { setAutolock as setAutolockRaw } from "./lock.js";
import { t } from "./i18n.js";

const DEFAULT_CONFIG = {
  companyID: "ch_CandyhouseMobile",
  wsUrl: "wss://82q6nuplv0.execute-api.ap-northeast-1.amazonaws.com/public", // 公式ステージ (旧 /production は web 由来の誤値)
  lang: "ja",
  default: { remote: null, lock: null },
  hub3s: {},
  remotes: {},
  locks: {},
};

const STATE_CHANGE_KEY = `${ACTION_TYPES.BIZ3_TRIGGER_LOCKER}:pubDeviceStateChange`;

function normalizeUuid(s) {
  return typeof s === "string" ? s.replace(/-/g, "").toLowerCase() : "";
}

const UUID_RE = /^[0-9a-fA-F-]{32,}$/;

export class SesameHub3 {
  /**
   * 既定の設定ディレクトリ (~/.config/sesame-kit 等) から読み込んで構築。
   * CLI 内部はこのファクトリを使う。
   * @param {{ configDir?: string, debug?: boolean }} [opts]
   */
  static async fromConfig(opts = {}) {
    const paths = configPaths(opts.configDir);
    const configStore = new ConfigStore(paths.config);
    const tokenStore = FileTokenStore.fromConfigDir(opts.configDir);
    return new SesameHub3({
      config: configStore.load(),
      configStore,
      tokenStore,
      debug: !!opts.debug,
    });
  }

  /**
   * 自動 connect/close ヘルパ。boilerplate 削減用。
   *
   *   await SesameHub3.use(async (hub) => { await hub.unlock("front"); });
   *   await SesameHub3.use({ configDir: "/tmp/cfg" }, async (hub) => { ... });
   *   await SesameHub3.use({ tokenStore: myStore, config: {...} }, async (hub) => { ... });
   *
   * config / tokenStore を opts で渡せば fromConfig をスキップ (他プロジェクト埋込み用)。
   *
   * @param {((hub:SesameHub3) => Promise<any>) | object} fnOrOpts
   * @param {(hub:SesameHub3) => Promise<any>} [maybeFn]
   */
  static async use(fnOrOpts, maybeFn) {
    let opts = {}, fn;
    if (typeof fnOrOpts === "function") { fn = fnOrOpts; }
    else { opts = fnOrOpts || {}; fn = maybeFn; }
    if (typeof fn !== "function") {
      throw new Error(t("domain.client.useUsage"));
    }

    const hub = (opts.tokenStore && opts.config)
      ? new SesameHub3({
          config: opts.config,
          tokenStore: opts.tokenStore,
          configStore: opts.configStore || null,
          debug: !!opts.debug,
        })
      : await SesameHub3.fromConfig(opts);

    await hub.connect();
    try { return await fn(hub); }
    finally { await hub.close(); }
  }

  /**
   * @param {{
   *   config: object,
   *   tokenStore: TokenStore,
   *   configStore?: ConfigStore,
   *   debug?: boolean,
   * }} args
   */
  constructor({ config, tokenStore, configStore = null, debug = false }) {
    if (!config) throw new Error(t("domain.client.configRequired"));
    if (!tokenStore) throw new Error(t("domain.client.tokenStoreRequired"));
    this._config = normalizeConfig({ ...DEFAULT_CONFIG, ...config });
    this._configStore = configStore;
    this._tokenStore = tokenStore;
    this._debug = debug;
    /** @type {Hub3WsClient | null} */
    this._ws = null;
    this._subUUID = null; // connect() で idToken から抽出
    /**
     * close() 時に await したい async cleanup 関数の集合 (2nd-pass M-1)。
     * `onIRLearned` 等の戻り値 unsubscribe は呼び出し側の await 忘れで Hub3 が
     * REGISTER モードに残るリスクがあるため、ここに登録しておくと close() で確実に走る。
     */
    this._pendingCleanups = new Set();
    /** WS 再接続 (初回以外の OPEN) で呼ぶコールバック集合。購読者の再 subscribe 用。 */
    this._reconnectCbs = new Set();
    // ロック制御の関心事は LockManager に集約 (client.js の god object 化回避)。
    // ws/subUUID は connect 前後で変わるためアクセサで毎回最新を読ませる。
    this._lock = new LockManager({
      getWs: () => this._ws,
      getConfig: () => this._config,
      getSubUUID: () => this._subUUID,
      ensureConnected: () => this._ensureConnected(),
    });
  }

  /**
   * WS 再接続時に呼ばれるコールバックを登録する。戻り値で解除。
   * デーモン等、再接続後にサーバ購読 (subscribe frame) を張り直したい用途向け。
   * @param {() => void} cb
   * @returns {() => void} unsubscribe
   */
  onReconnect(cb) {
    this._reconnectCbs.add(cb);
    return () => this._reconnectCbs.delete(cb);
  }

  /** 登録済み再接続コールバックを発火する (transport の onReopen から呼ばれる)。 */
  _fireReconnect() {
    for (const cb of [...this._reconnectCbs]) {
      try { cb(); } catch (e) { if (this._debug) console.error("[hub3] onReconnect cb error:", e?.message || e); }
    }
  }

  get config() { return this._config; }
  get configStore() { return this._configStore; }
  get tokenStore() { return this._tokenStore; }
  get connected() { return !!this._ws; }

  /**
   * remote 名 (省略時は default) から remote 定義と親 hub3 をまとめて取得。
   */
  resolveRemote(name) {
    if (this._configStore) return this._configStore.resolveRemote(name);
    // configStore なしで直接構築された場合: 手動で解決
    const cfg = this._config;
    const remotes = cfg.remotes || {};
    const names = Object.keys(remotes);
    const chosen = name || cfg.default?.remote || (names.length === 1 ? names[0] : null);
    if (!chosen) throw new Error(t("domain.client.noRemoteNoDefault"));
    const remote = remotes[chosen];
    if (!remote) throw new Error(t("domain.client.unknownRemote", { name: chosen }));
    const hub3 = cfg.hub3s?.[remote.hub3];
    if (!hub3) throw new Error(t("domain.client.remoteMissingHub3", { name: chosen, hub3: remote.hub3 }));
    return { name: chosen, remote, hub3Name: remote.hub3, hub3 };
  }

  /** WS 接続を確立。既に接続済みなら何もしない。 */
  async connect() {
    if (this._ws) return;
    const idToken = await getValidIdToken(this._tokenStore);
    this._subUUID = jwtSub(idToken);
    this._ws = new Hub3WsClient({
      wsUrl: this._config.wsUrl,
      idToken,
      lang: this._config.lang,
      debug: this._debug,
      // 再接続が MAX_RETRIES_BEFORE_TOKEN_CHECK に達した時、
      // token を強制 refresh して再接続を継続する。
      onTokenRefreshNeeded: async () => {
        try {
          // marginSec を大きくして必ず refresh する
          return await getValidIdToken(this._tokenStore, { marginSec: 999999 });
        } catch (e) {
          if (this._debug) console.error("[hub3] token refresh failed:", e?.message || e);
          return null;
        }
      },
      // 再接続後に登録済みコールバックを発火 (購読者の subscribe frame 再送など)。
      onReopen: () => this._fireReconnect(),
    });
    await this._ws.connect();
  }

  async close() {
    // pending cleanups を先に走らせる (onIRLearned 等の await 忘れ救済)
    if (this._pendingCleanups.size > 0) {
      const fns = [...this._pendingCleanups];
      this._pendingCleanups.clear();
      await Promise.allSettled(fns.map((fn) => Promise.resolve().then(fn)));
    }
    if (!this._ws) return;
    this._ws.close();
    this._ws = null;
  }

  _ensureConnected() {
    if (!this._ws) throw new Error(t("domain.client.notConnected"));
  }

  // ---------- ドメイン namespace ----------
  // 各機能モジュール (schedule/org/company/payment/access/iot/presetir) は
  // `fn(client, params)` の純関数集。それを namespace getter で薄く委譲する
  // (client.js を God object 化させない設計)。companyID / subUUID は
  // this._config / connect 時の値を自動注入し、params で上書きできる。
  //
  //   await hub.schedule.getScheduleList();           // companyID/subUUID 自動
  //   await hub.org.getEmployees();                   // companyID 自動
  //   await hub.access.getCards({ deviceUUIDs: [...] });
  //
  // 低レベル関数を直接使いたい場合は `import { org } from "sesame-kit"` で
  // モジュールごと取り、第1引数に WS client を渡す。

  _bindNs(mod) {
    this._ensureConnected();
    const ws = this._ws;
    const companyID = this._config.companyID;
    const subUUID = this._subUUID;
    // モジュールが NAMESPACE_OPS (公開 op の allowlist) を持つ場合はそれだけを露出。
    // presetir/iot のように client を取らない純ロジック (class/builder) が export に
    // 混じるモジュールで、それらを誤ってラップして壊すのを防ぐ。
    const names = Array.isArray(mod.NAMESPACE_OPS)
      ? mod.NAMESPACE_OPS
      : Object.keys(mod).filter((k) => typeof mod[k] === "function");
    const out = {};
    for (const name of names) {
      const fn = mod[name];
      if (typeof fn !== "function") continue;
      // companyID/subUUID を既定注入。params で明示すればそちら優先。
      out[name] = (params = {}) => fn(ws, { companyID, subUUID, ...params });
    }
    return out;
  }

  /** スケジュール (biz3Schedule)。 */
  get schedule() { return this._bindNs(schedule); }
  /** 組織管理 (employee/group/role/device-group/employee-device)。 */
  get org() { return this._bindNs(org); }
  /** 会社 (biz3ManageCompany)。 */
  get company() { return this._bindNs(company); }
  /** 支払い管理 (biz3ManagePayment)。 */
  get payment() { return this._bindNs(payment); }
  /** 認証データ (NFC カード/パスコードの WS op)。 */
  get access() { return this._bindNs(access); }
  /** IoT cmd (biz3OperateIoT: DFU/LED/リレー/Sesame item)。 */
  get iot() { return this._bindNs(iot); }
  /** プリセットリモコン command 生成 (remoteEmit, HXD)。 */
  get presetir() { return this._bindNs(presetir); }

  /**
   * IR 発射 (name-based)。`keyOrUUID` が UUID 形式ならそのまま command として、
   * そうでなければ remote.keys から名前解決する。
   * config を介さない版は {@link SesameHub3#sendIRDirect}。
   *
   * @param {string|null} remoteName リモコン名 (null で default.remote)
   * @param {string} keyOrUUID キー名 or keyUUID
   * @returns {Promise<object>} sendIR の応答 (success / data.message 等)
   */
  async send(remoteName, keyOrUUID) {
    this._ensureConnected();
    if (!keyOrUUID) throw new Error(t("domain.client.keyRequired"));
    const { remote, hub3 } = this.resolveRemote(remoteName);
    const isUUID = UUID_RE.test(keyOrUUID);
    const command = isUUID ? keyOrUUID : remote.keys?.[keyOrUUID];
    if (!command) {
      const avail = Object.keys(remote.keys || {}).join(", ") || "(none)";
      throw new Error(t("domain.client.unknownKey", { key: keyOrUUID, avail }));
    }
    return sendIR(this._ws, {
      deviceId: hub3.deviceId,
      irDeviceUUID: remote.irDeviceUUID,
      irType: remote.irType,
      command,
      operation: remote.irOperation,
      companyID: this._config.companyID,
    });
  }

  /**
   * リモコンに登録されている IR キー一覧をサーバから取得 (name-based)。
   * config を介さない版は {@link SesameHub3#getIRCodesDirect}。
   *
   * @param {string|null} remoteName リモコン名 (null で default.remote)
   * @returns {Promise<Array<{name:string, keyUUID:string}>>}
   */
  async listKeys(remoteName) {
    this._ensureConnected();
    const { remote, hub3 } = this.resolveRemote(remoteName);
    return getIRCodes(this._ws, {
      deviceId: hub3.deviceId,
      irDeviceUUID: remote.irDeviceUUID,
      companyID: this._config.companyID,
    });
  }

  /**
   * 接続疎通確認: biz3KeepAlive を 1 往復して ack を待つ。
   * 失敗時は throw。
   */
  async ping() {
    this._ensureConnected();
    return this._ws.ping();
  }

  // ---------- アカウント (ログインユーザ情報) ----------

  /**
   * ログインユーザの customerInfo / quotas を取得 (biz3GetLoginUser)。
   * email は tokenStore の username (login に使った値) を使う。
   * @returns {Promise<{customerInfo: object|null, quotas: object|null}>}
   */
  async getLoginUser() {
    this._ensureConnected();
    const email = this._tokenStore.load()?.username;
    if (!email) throw new Error(t("domain.client.emailNotInStore"));
    return account.getLoginUser(this._ws, { email });
  }

  /**
   * biz3GetLoginUser で実 companyID / subUUID を取得し、config と内部状態に反映する。
   * companyID は従来デフォルト (ch_CandyhouseMobile) を置いていたが、これで実値に上書きできる。
   * @returns {Promise<object|null>} customerInfo
   */
  async refreshAccount() {
    const { customerInfo } = await this.getLoginUser();
    if (customerInfo?.companyID) {
      this._config.companyID = customerInfo.companyID;
      if (this._configStore) {
        const cfg = this._configStore.load();
        cfg.companyID = customerInfo.companyID;
        this._configStore.save();
      }
    }
    if (customerInfo?.subUUID) {
      this._subUUID = customerInfo.subUUID; // jwtSub と同値のはずだが、正式値で上書き
    }
    return customerInfo ?? null;
  }

  /**
   * 全 SESAME デバイス (Hub3 含む) のリストを取得。
   * biz3ManageDevice/getCompanyDevice → PubedCompanyDevice の応答を待つ。
   */
  async listDevices({ timeoutMs = 10_000 } = {}) {
    this._ensureConnected();
    let resolveGot;
    const got = new Promise((resolve) => { resolveGot = resolve; });
    const listener = (msg) => {
      if (msg.action === ACTION_TYPES.BIZ3_MANAGE_DEVICE && msg.op === "PubedCompanyDevice") {
        resolveGot(msg);
      }
    };
    // 3rd-pass L-3: onMessage の戻り unsubscribe を必ず呼んで listener leak を防ぐ
    // (daemon 用途で listDevices を繰り返し呼ぶと累積していた)
    const off = this._ws.onMessage(listener);
    let timeoutId;
    try {
      this._ws.send({
        action: ACTION_TYPES.BIZ3_MANAGE_DEVICE,
        op: "getCompanyDevice",
        companyID: this._config.companyID,
      });
      const timeout = new Promise((_, rej) => {
        timeoutId = setTimeout(() => rej(new Error(t("domain.client.getCompanyDeviceTimeout"))), timeoutMs);
      });
      const msg = await Promise.race([got, timeout]);
      return msg?.data?.data?.list || [];
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      off();
    }
  }

  // ---------- devices → config 同期 (ドメイン操作) ----------
  // CLI 専用だった自動化を library 利用者も使えるよう SesameHub3 に集約。
  // いずれも内部で listDevices / listIRRemotes を引いて ConfigStore に委譲する。
  // configStore 無しで構築された場合は使えない (throw)。

  _requireConfigStore(op) {
    if (!this._configStore) throw new Error(t("domain.client.requiresConfigStore", { op }));
  }

  /**
   * 全 SESAME デバイスを引いてロックを config に取り込む。
   * @param {{prune?:boolean}} [opts]
   * @returns {Promise<{added:string[], updated:string[], removed:string[]}>}
   */
  async syncLocksFromDevices(opts = {}) {
    this._ensureConnected();
    this._requireConfigStore("syncLocksFromDevices");
    const list = await this.listDevices();
    return this._configStore.syncLocksFromDevices(list, opts);
  }

  /**
   * 全 SESAME デバイスを引いて Hub3 を config に取り込む。
   * @param {{prune?:boolean}} [opts]
   * @returns {Promise<{added:string[], updated:string[], removed:string[]}>}
   */
  async syncHub3sFromDevices(opts = {}) {
    this._ensureConnected();
    this._requireConfigStore("syncHub3sFromDevices");
    const list = await this.listDevices();
    return this._configStore.syncHub3sFromDevices(list, opts);
  }

  /**
   * `devices` 応答だけからリモコンを config に取り込む (引数不要)。
   * 内部で Hub3 を自動登録してから、各 Hub3 の stateInfo.remoteList を展開する。
   * irType はリモコン側が持っているのでユーザー指定不要。
   * @returns {Promise<{hub3:{added,updated,removed}, remotes:{added,updated}}>}
   */
  async syncRemotesFromDevices() {
    this._ensureConnected();
    this._requireConfigStore("syncRemotesFromDevices");
    const list = await this.listDevices();
    const hub3 = this._configStore.syncHub3sFromDevices(list);
    const remotes = this._configStore.syncRemotesFromDevices(list);
    return { hub3, remotes };
  }

  /**
   * devices から「Hub3 とその配下リモコン」をフラットに取得 (登録せず一覧だけ)。
   * 対話 add で候補を見せる用途。
   * @returns {Promise<Array<{hub3DeviceUUID:string, hub3Name:string, uuid:string, type:number, alias:string|null}>>}
   */
  async listRemotesFromDevices() {
    this._ensureConnected();
    const list = await this.listDevices();
    const out = [];
    for (const d of list) {
      if (d.deviceModel !== "hub_3" && d.deviceModel !== "hub_3_lte") continue;
      for (const r of d.stateInfo?.remoteList || []) {
        const uuid = r.uuid || r.irDeviceUUID;
        if (!uuid) continue;
        out.push({
          hub3DeviceUUID: d.deviceUUID,
          hub3Name: d.deviceName || d.deviceUUID,
          uuid,
          type: Number(r.type ?? r.irType),
          alias: r.alias || r.name || null,
        });
      }
    }
    return out;
  }

  /**
   * server 側 (getRemoteList) のリモコンを config に取り込む (上級/代替経路)。
   * 通常は syncRemotesFromDevices で足りる。
   * @param {string} hub3Name これらのリモコンが属する Hub3 の config 名
   * @param {number} irType 取得するリモコンの irType (例 49152=エアコン)
   * @returns {Promise<{added:string[], updated:string[]}>}
   */
  async syncRemotesFromServer(hub3Name, irType) {
    this._ensureConnected();
    this._requireConfigStore("syncRemotesFromServer");
    const list = await this.listIRRemotes(irType);
    return this._configStore.syncRemotesFromServer(list, hub3Name);
  }

  /**
   * 指定 remote のキー一覧を server から取得して config に書き戻す。
   * @param {string|null} remoteName
   * @returns {Promise<{name:string, keyCount:number}>}
   */
  async syncRemoteKeys(remoteName) {
    this._ensureConnected();
    this._requireConfigStore("syncRemoteKeys");
    const { name } = this.resolveRemote(remoteName);
    const codes = await this.listKeys(name);
    const keys = {};
    for (const c of codes) keys[c.name] = c.keyUUID;
    this._configStore.updateRemoteKeys(name, keys);
    return { name, keyCount: Object.keys(keys).length };
  }

  // ---------- lock ----------

  // lock 制御の実体は LockManager (src/lock-manager.js) に集約。以下は後方互換の薄い委譲。

  /**
   * lock 設定を name から解決。name 省略時は default.lock、
   * 無ければ locks が 1 つだけならそれ。
   */
  resolveLock(name) {
    return this._lock.resolveLock(name);
  }

  /**
   * ロック施錠 (name-based, cmd=82)。config を介さない版は {@link SesameHub3#lockDevice}。
   * @param {string|null} [name] ロック名 (null で default.lock)
   * @returns {Promise<object>} pubDeviceStateChange の応答
   */
  async lock(name) {
    return this._lock.lock(name);
  }

  /**
   * ロック解錠 (name-based, cmd=83)。config を介さない版は {@link SesameHub3#unlockDevice}。
   * @param {string|null} [name] ロック名 (null で default.lock)
   * @returns {Promise<object>} pubDeviceStateChange の応答
   */
  async unlock(name) {
    return this._lock.unlock(name);
  }

  /**
   * トグル (name-based, cmd=88, cloud のみの合成命令)。
   * @param {string|null} [name] ロック名 (null で default.lock)
   * @returns {Promise<object>}
   */
  async toggle(name) {
    return this._lock.toggle(name);
  }

  /**
   * SESAME Bot クリック (name-based, cmd=89)。
   * 注: lock.js の低レベル関数 `botClick(client, params)` とは別物 (こちらは name で解決)。
   * @param {string|null} [name] ロック名 (null で default.lock)
   * @returns {Promise<object>}
   */
  async botClick(name) {
    return this._lock.botClick(name);
  }

  /**
   * デバッグ用: WS の全受信メッセージを購読する (戻り値で unsubscribe)。
   * fire-and-forget な op (autolock 等) のサーバ応答を観測するのに使う。
   * @param {(msg:object)=>void} fn
   * @returns {()=>void} unsubscribe
   */
  onAnyMessage(fn) {
    this._ensureConnected();
    return this._ws.onMessage(fn);
  }

  /** 任意 cmd 直指定 (上級用)。 */
  async triggerLockRaw(name, cmd) {
    return this._lock.triggerRaw(name, cmd);
  }

  /**
   * オートロック設定 (name-based)。解錠 N 秒後に自動施錠。`seconds=0` で無効。
   *
   * ⚠️ 実験的 / 実機未検証: クラウド中継 (Hub3) が autolock(ItemCode 11) を通すかは前例が無い。
   *    公式アプリは BLE で送っている。fire-and-forget (応答待ちしない)。
   *
   * @param {string|null} name ロック名 (null で default.lock)
   * @param {number} seconds 0..65535 (0=無効)
   * @param {number} [timeoutMs] ack 待ちタイムアウト
   * @returns {Promise<{ack:any, cmd:number, seconds:number}>}
   */
  async setAutolock(name, seconds, timeoutMs) {
    return this._lock.setAutolock(name, seconds, timeoutMs);
  }

  get subUUID() { return this._subUUID; }

  // ---------- IR advanced (Phase C) ----------

  /**
   * Hub3 を学習モードに入れ、物理リモコンの 1 ボタンを学習して remote にキー登録。
   *
   * @param {string} remoteName リモコン名
   * @param {string} keyName 登録するキー名
   * @param {{
   *   timeoutMs?: number,        // ボタン押下待ち timeout (default 60s)
   *   onPrompt?: () => void,     // 学習モード突入後に呼ばれる (ユーザに「ボタン押して」と促す)
   * }} [opts]
   * @returns {Promise<{keyUUID: string, captured: any, saved: any}>}
   */
  async learnIR(remoteName, keyName, { timeoutMs = 60_000, onPrompt } = {}) {
    this._ensureConnected();
    const { remote, hub3, name: rName } = this.resolveRemote(remoteName);
    const result = await ir.learnIRKey(this._ws, {
      hub3DeviceId: hub3.deviceId,
      remoteId: remote.irDeviceUUID,
      keyName,
      irType: remote.irType,
      companyID: this._config.companyID,
      timeoutMs,
      onPrompt,
    });
    // keyUUID はクライアント発番 (learnIRKey が返す)。config にキー名→keyUUID を反映。
    const keyUUID = result.keyUUID;
    if (keyUUID && this._configStore) {
      const cur = remote.keys || {};
      cur[keyName] = keyUUID;
      this._configStore.updateRemoteKeys(rName, cur);
    }
    return result;
  }

  async listIRRemotes(type, { page, pageSize } = {}) {
    this._ensureConnected();
    return ir.getRemoteList(this._ws, { type, companyID: this._config.companyID, page, pageSize });
  }

  async searchPresetIRRemotes(type, searchTerm) {
    this._ensureConnected();
    return ir.searchRemoteList(this._ws, { type, companyID: this._config.companyID, searchTerm });
  }

  async addIRRemoteServer(remoteObj) {
    this._ensureConnected();
    return ir.addIRRemote(this._ws, { remote: remoteObj, companyID: this._config.companyID });
  }

  async deleteIRRemoteServer(remoteName) {
    this._ensureConnected();
    const { remote, hub3 } = this.resolveRemote(remoteName);
    return ir.deleteIRRemote(this._ws, {
      hub3DeviceId: hub3.deviceId,
      uuid: remote.irDeviceUUID,
      companyID: this._config.companyID,
    });
  }

  async renameIRRemote(remoteName, alias) {
    this._ensureConnected();
    const { remote, hub3 } = this.resolveRemote(remoteName);
    return ir.updateRemoteAlias(this._ws, {
      hub3DeviceId: hub3.deviceId,
      uuid: remote.irDeviceUUID,
      alias,
      companyID: this._config.companyID,
    });
  }

  async deleteIRKey(remoteName, keyOrUUID) {
    this._ensureConnected();
    const { remote, hub3, name } = this.resolveRemote(remoteName);
    const keyUUID = remote.keys?.[keyOrUUID] || keyOrUUID;
    const resp = await ir.deleteIRCode(this._ws, {
      hub3DeviceId: hub3.deviceId,
      remoteId: remote.irDeviceUUID,
      keyUUID,
      companyID: this._config.companyID,
    });
    // config 側からも除去
    if (this._configStore && remote.keys?.[keyOrUUID]) {
      const { [keyOrUUID]: _, ...rest } = remote.keys;
      this._configStore.updateRemoteKeys(name, rest);
    }
    return resp;
  }

  async renameIRKey(remoteName, keyOrUUID, newName) {
    this._ensureConnected();
    const { remote, hub3, name } = this.resolveRemote(remoteName);
    const keyUUID = remote.keys?.[keyOrUUID] || keyOrUUID;
    const resp = await ir.updateIRCode(this._ws, {
      hub3DeviceId: hub3.deviceId,
      remoteId: remote.irDeviceUUID,
      keyUUID,
      name: newName,
      companyID: this._config.companyID,
    });
    if (this._configStore && remote.keys?.[keyOrUUID]) {
      const next = { ...remote.keys };
      delete next[keyOrUUID];
      next[newName] = keyUUID;
      this._configStore.updateRemoteKeys(name, next);
    }
    return resp;
  }

  async getIRMode(hub3Name) {
    this._ensureConnected();
    const hub3 = this._resolveHub3(hub3Name);
    return ir.getIRMode(this._ws, { deviceId: hub3.deviceId, companyID: this._config.companyID });
  }

  async setIRMode(hub3Name, mode) {
    this._ensureConnected();
    const hub3 = this._resolveHub3(hub3Name);
    return ir.setIRMode(this._ws, { deviceId: hub3.deviceId, mode, companyID: this._config.companyID });
  }

  async matchIRRemote({ irData, irType, brandName }) {
    this._ensureConnected();
    return ir.matchRemote(this._ws, { irData, irType, brandName, companyID: this._config.companyID });
  }

  _resolveHub3(name) {
    const cfg = this._config;
    const hub3s = cfg.hub3s || {};
    const names = Object.keys(hub3s);
    const chosen = name || (names.length === 1 ? names[0] : null);
    if (!chosen) throw new Error(t("domain.client.noHub3Specified"));
    const h = hub3s[chosen];
    if (!h) throw new Error(t("domain.client.unknownHub3", { name: chosen }));
    return h;
  }

  // ---------- Device management (Phase D) ----------

  /** 個人ユーザのデバイス一覧 (会社 vs 個人で別 op)。 */
  async listUserDevices() {
    this._ensureConnected();
    return devices.getUserDevices(this._ws);
  }

  async getDeviceStatus(deviceUUID) {
    this._ensureConnected();
    return devices.getDeviceStatus(this._ws, { deviceUUID });
  }

  /**
   * 読み取った複数 IC カードをクラウド DB へ一括登録する (postCards への委譲)。
   *
   * BLE enroll (`sesame access cards enroll`) で集約した records をそのまま渡せる。
   * cards 要素は BLE 読み取り形 `{cardID, cardName, cardType}` (access.enrolledToCardList が
   * postCards の list 形へ写像する)。既に postCards の list 形を持つ場合は access.postCards を直接使う。
   * @param {string} deviceUUID 対象 Touch の deviceUUID
   * @param {Array<{cardID:string, cardName?:string, cardType?:number}>} cards
   * @returns {Promise<object|null>} postCards 応答 (cards 空なら null)
   */
  async registerCards(deviceUUID, cards) {
    this._ensureConnected();
    return access.syncEnrolledCards(this._ws, { deviceUUID, records: cards });
  }

  _biometricsBaseUrl(baseUrl) {
    const url = baseUrl || this._config.biometricsBaseUrl || this._config.registerBaseUrl;
    if (!url) throw new Error("biometrics baseUrl required (set config.biometricsBaseUrl or pass baseUrl)");
    return url;
  }

  _biometricsAuthorizationProvider() {
    return async () => `Bearer ${await getValidIdToken(this._tokenStore)}`;
  }

  async postAuthenticationData({ operation, deviceID, items, baseUrl, transport } = {}) {
    return access.postAuthenticationData(null, {
      operation,
      deviceID,
      items,
      transport,
      baseUrl: transport ? undefined : this._biometricsBaseUrl(baseUrl),
      authorizationProvider: transport ? undefined : this._biometricsAuthorizationProvider(),
    });
  }

  async putAuthenticationData({ operation, deviceID, items, baseUrl, transport } = {}) {
    return access.putAuthenticationData(null, {
      operation,
      deviceID,
      items,
      transport,
      baseUrl: transport ? undefined : this._biometricsBaseUrl(baseUrl),
      authorizationProvider: transport ? undefined : this._biometricsAuthorizationProvider(),
    });
  }

  async deleteAuthenticationData({ operation, deviceID, items, baseUrl, transport } = {}) {
    return access.deleteAuthenticationData(null, {
      operation,
      deviceID,
      items,
      transport,
      baseUrl: transport ? undefined : this._biometricsBaseUrl(baseUrl),
      authorizationProvider: transport ? undefined : this._biometricsAuthorizationProvider(),
    });
  }

  async updateAuthenticationName({ request, kind, baseUrl, transport, ...rest } = {}) {
    return access.updateAuthenticationName(null, {
      request,
      kind,
      ...rest,
      transport,
      baseUrl: transport ? undefined : this._biometricsBaseUrl(baseUrl),
      authorizationProvider: transport ? undefined : this._biometricsAuthorizationProvider(),
    });
  }

  async renameDevice(deviceUUID, deviceName) {
    this._ensureConnected();
    if (!this._subUUID) throw new Error(t("domain.client.subUUIDNotAvailable"));
    return devices.updateDeviceName(this._ws, { subUUID: this._subUUID, deviceUUID, deviceName });
  }

  /** company から指定 UUID のデバイスを削除。 */
  async deleteDevice(deviceUUID) {
    this._ensureConnected();
    return devices.deleteDevices(this._ws, {
      companyID: this._config.companyID,
      items: [{ deviceUUID }],
    });
  }

  /**
   * @deprecated `onDeviceUpdate(items, fn)` を使ってください (on* イベント命名に統一)。
   * 後方互換のため残置。内部実装は onDeviceUpdate と同一。
   */
  subscribeDeviceUpdates(deviceInfos, onUpdate) {
    return this.onDeviceUpdate(deviceInfos, onUpdate);
  }

  /**
   * ロック開閉履歴を取得。`list` はデバイス指定の配列。
   *
   * @param {Array<{deviceUUID: string}>} list 履歴を取得するデバイスの配列
   * @param {number} [pageSize] 1ページ件数 (未指定でサーバ既定)
   * @returns {Promise<any>}
   */
  async getDeviceHistory(list, pageSize) {
    this._ensureConnected();
    return devices.getDeviceHistory(this._ws, {
      companyID: this._config.companyID,
      list,
      pageSize,
    });
  }

  /** 開閉履歴の1エントリを非表示化 (論理削除)。timestamp は getDeviceHistory の各 record の値。 */
  async hideDeviceHistory({ deviceUUID, timestamp }) {
    this._ensureConnected();
    return devices.makeHistoryInvisible(this._ws, { deviceUUID, timestamp });
  }

  /** 電池履歴を取得 (1ページ)。lastEvaluatedKey でページング。 */
  async getDeviceBattery(deviceUUID, { lastEvaluatedKey = null, pageSize = 100 } = {}) {
    this._ensureConnected();
    return devices.getBatteryRecord(this._ws, { deviceUUID, lastEvaluatedKey, pageSize });
  }

  /** 電池履歴の1エントリを非表示化 (論理削除)。timestampSecond は getDeviceBattery の record.ts。 */
  async hideBatteryRecord({ deviceUUID, timestampSecond }) {
    this._ensureConnected();
    return devices.makeBatteryRecordInvisible(this._ws, { deviceUUID, timestampSecond });
  }

  async listFirmware() {
    this._ensureConnected();
    return devices.listFirmware(this._ws);
  }

  /** WebAPI proxy 経由で REST API を叩く。apiKeyId は config 側に保存。 */
  async invokeWebAPI({ func, query, body, apiKeyId }) {
    this._ensureConnected();
    const key = apiKeyId || this._config.apiKeyId;
    if (!key) throw new Error(t("domain.client.apiKeyIdRequired"));
    return devices.invokeWebAPI(this._ws, { func, apiKeyId: key, query, body });
  }

  async webapiDeviceState({ deviceId, apiKeyId } = {}) {
    this._ensureConnected();
    const key = apiKeyId || this._config.apiKeyId;
    if (!key) throw new Error(t("domain.client.apiKeyIdRequired"));
    return devices.webapiDeviceState(this._ws, { apiKeyId: key, deviceId });
  }

  async webapiDeviceHistory({ deviceId, page, lg, isBiz, apiKeyId } = {}) {
    this._ensureConnected();
    const key = apiKeyId || this._config.apiKeyId;
    if (!key) throw new Error(t("domain.client.apiKeyIdRequired"));
    return devices.webapiDeviceHistory(this._ws, { apiKeyId: key, deviceId, page, lg, isBiz });
  }

  async webapiSendCmd({ deviceId, cmd, sign, history, apiKeyId } = {}) {
    this._ensureConnected();
    const key = apiKeyId || this._config.apiKeyId;
    if (!key) throw new Error(t("domain.client.apiKeyIdRequired"));
    return devices.webapiSendCmd(this._ws, { apiKeyId: key, deviceId, cmd, sign, history });
  }

  // ---------- config-less direct API ----------
  // 他プロジェクトに組み込むとき、name 経由の config lookup を介さず
  // deviceUUID + secretKey を直接渡して操作するための関数群。

  /**
   * 直接 lock 制御 (config を介さない, 任意 cmd)。`unlockDevice`/`lockDevice` 等の基底。
   * @param {{deviceUUID:string, secretKey:string, cmd:number, timeoutMs?:number}} p
   *   deviceUUID: ロックの UUID / secretKey: 32hex 共通鍵 (devices で取得) /
   *   cmd: 82=LOCK 83=UNLOCK 88=TOGGLE 89=CLICK
   * @returns {Promise<object>} pubDeviceStateChange の応答
   */
  async triggerLockDevice({ deviceUUID, secretKey, cmd, timeoutMs }) {
    return this._lock.triggerDevice({ deviceUUID, secretKey, cmd, timeoutMs });
  }

  /**
   * 直接 解錠 (config を介さない, cmd=83)。
   * @param {{deviceUUID:string, secretKey:string, timeoutMs?:number}} p
   * @returns {Promise<object>} pubDeviceStateChange の応答
   */
  unlockDevice(p)   { return this._lock.unlockDevice(p); }
  /**
   * 直接 施錠 (config を介さない, cmd=82)。
   * @param {{deviceUUID:string, secretKey:string, timeoutMs?:number}} p
   * @returns {Promise<object>}
   */
  lockDevice(p)     { return this._lock.lockDevice(p); }
  /**
   * 直接 トグル (config を介さない, cmd=88)。
   * @param {{deviceUUID:string, secretKey:string, timeoutMs?:number}} p
   * @returns {Promise<object>}
   */
  toggleDevice(p)   { return this._lock.toggleDevice(p); }
  /**
   * 直接 Bot クリック (config を介さない, cmd=89)。
   * @param {{deviceUUID:string, secretKey:string, timeoutMs?:number}} p
   * @returns {Promise<object>}
   */
  botClickDevice(p) { return this._lock.botClickDevice(p); }

  /**
   * 直接 autolock 設定 (config を介さない, cmd=11)。
   * @param {{deviceUUID:string, secretKey:string, seconds:number, timeoutMs?:number}} p
   * @returns {Promise<{ack:any, cmd:number, seconds:number}>}
   */
  setAutolockDevice({ deviceUUID, secretKey, seconds, timeoutMs }) {
    this._ensureConnected();
    return setAutolockRaw(this._ws, { deviceId: deviceUUID, secretKey, seconds, timeoutMs });
  }

  /**
   * 直接 IR 発射 (config を介さない)。
   * @param {{hub3DeviceId:string, irDeviceUUID:string, irType:number, command:string, operation?:string}} p
   *   hub3DeviceId: Hub3 UUID / irDeviceUUID: リモコン UUID / irType: 例 49152 /
   *   command: keyUUID か 16byte hex / operation: "learnEmit" (default) | "remoteEmit"
   * @returns {Promise<object>} sendIR の応答
   */
  async sendIRDirect({ hub3DeviceId, irDeviceUUID, irType, command, operation = "learnEmit" }) {
    this._ensureConnected();
    return sendIR(this._ws, {
      deviceId: hub3DeviceId,
      irDeviceUUID,
      irType,
      command,
      operation,
      companyID: this._config.companyID,
    });
  }

  /**
   * 直接 IR キー一覧取得 (config を介さない)。
   * @param {{hub3DeviceId:string, irDeviceUUID:string}} p
   * @returns {Promise<Array<{name:string, keyUUID:string}>>}
   */
  async getIRCodesDirect({ hub3DeviceId, irDeviceUUID }) {
    this._ensureConnected();
    return getIRCodes(this._ws, {
      deviceId: hub3DeviceId,
      irDeviceUUID,
      companyID: this._config.companyID,
    });
  }

  // ---------- high-level event subscriptions ----------
  // 低レベル `this._ws.subscribe(key, fn)` の薄い wrapper だが、
  // deviceId フィルタ・複数 unsubscribe の合成・モード切替の自動化など、
  // 「やりたいこと」レベルで使えるよう包んだ。

  /** name で指定したロックの state change push を購読。戻り値は unsubscribe。 */
  onLockStateChange(name, fn) {
    this._ensureConnected();
    const { lock } = this.resolveLock(name);
    return this.onLockStateChangeDevice(lock.deviceUUID, fn);
  }

  /** UUID 直指定で state change を購読。 */
  onLockStateChangeDevice(deviceUUID, fn) {
    this._ensureConnected();
    const target = normalizeUuid(deviceUUID);
    return this._ws.subscribe(STATE_CHANGE_KEY, (msg) => {
      // pubDeviceStateChange の本体は message.data、識別は data.deviceUUID
      // (vendor 確認: useIotCtrl.js:20-21 が updateDeviceState(message.data)、
      //  useManageDevice.js:147 が updatedDevice.deviceUUID)。単一フィールドのみ。
      const incoming = normalizeUuid(msg?.data?.deviceUUID);
      if (incoming !== target) return;
      try { fn(msg); } catch { /* ignore */ }
    });
  }

  /**
   * IR 学習データの購読 (受け取った波形を fn に流す)。
   * 内部で setIRMode(REGISTER) → subscribeIRData を発行する。
   *
   * **重要**: 戻り値の async unsubscribe 関数は **必ず `await` してください**。
   * `hub.close()` も pending cleanup を best-effort で実行しますが、明示的に await する方が
   * REGISTER モード復帰の失敗を呼び出し側で扱えます。
   *
   * 戻り値: async () => Promise<void>  — subscribe 解除 + setIRMode(CONTROL) 復帰
   */
  async onIRLearned(hub3Name, fn) {
    this._ensureConnected();
    const h = this._resolveHub3(hub3Name);
    const companyID = this._config.companyID;
    await ir.setIRMode(this._ws, { deviceId: h.deviceId, mode: ir.MODE.REGISTER, companyID });
    const sub = await ir.subscribeIRData(this._ws, { deviceId: h.deviceId, companyID });
    const off = sub.onData((msg) => {
      // 学習波形は response.data.data (vendor 確認: learn/index.js:219,227)。単一パスのみ。
      try { fn(msg?.data?.data); } catch { /* ユーザ callback の例外は購読を壊さない */ }
    });
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      this._pendingCleanups.delete(cleanup);
      off();
      sub.unsubscribe();
      try {
        await ir.setIRMode(this._ws, { deviceId: h.deviceId, mode: ir.MODE.CONTROL, companyID });
      } catch { /* best effort */ }
    };
    // close() 時の自動 cleanup 用に登録 (2nd-pass M-1)
    this._pendingCleanups.add(cleanup);
    return cleanup;
  }

  /**
   * デバイス state push の購読 (複数デバイスまとめて)。
   * @param {{deviceUUID:string, deviceModel?:string}[]} items
   * @param {(msg:any) => void} fn
   */
  onDeviceUpdate(items, fn) {
    this._ensureConnected();
    return devices.subscribeDevicesUpdate(this._ws, {
      companyID: this._config.companyID,
      items,
      onUpdate: fn,
    });
  }
}
