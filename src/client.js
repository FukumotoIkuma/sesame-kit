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
 * 正準定義は tokens.js にある (load/save/clear + loadPending/savePending/clearPending)。
 * @typedef {import("./tokens.js").TokenStore} TokenStore
 */

/**
 * 高レベルクライアントが扱う設定。`load()` 後は locks/hub3s が必ず存在するため
 * LoadedConfig を採用する (LockManager もこの形を要求する)。
 * @typedef {import("./config.js").LoadedConfig} ClientConfig
 */

/**
 * getCompanyDevice 応答 1 件。正準定義は config.js の DeviceRecord。
 * @typedef {import("./config.js").DeviceRecord} DeviceInfo
 */

/**
 * IR リモコンキー 1 件 (listKeys / getIRCodes の戻り)。
 * @typedef {{ name: string, keyUUID: string }} IRKey
 */

/**
 * #18 biometric REST (post/put/deleteAuthenticationData) の公開オプション袋。
 * baseUrl/transport は client が解決して access.* に渡すため省略可。
 * @typedef {object} BiometricAuthBag
 * @property {string} [operation]
 * @property {string} [deviceID]
 * @property {object[]} [items]
 * @property {string} [baseUrl]
 * @property {import("./access.js").BiometricsTransport} [transport]
 */

/**
 * updateAuthenticationName の公開オプション袋。request 直指定 or kind から組み立て。
 * 残りのフィールド (subUUID/stpDeviceUUID/name/...) は access 側へ透過する。
 * @typedef {Omit<import("./access.js").UpdateAuthNameParams, "transport"|"baseUrl"|"authorization"|"bearerToken"|"authorizationProvider"|"fetchImpl"> & {
 *   baseUrl?: string,
 *   transport?: import("./access.js").BiometricsTransport,
 * }} BiometricNameBag
 */

import { Hub3WsClient, sendIR, getIRCodes } from "./transport.js";
import { ConfigStore, normalizeConfig, migrateConfig } from "./config.js";
import { resolveByName, REMOTE_RESOLVE_ERRORS } from "./resolve.js";
import { FileTokenStore } from "./tokens.js";
import { getValidIdToken, jwtSub } from "./auth.js";
import { makeCognitoCredentialsProvider, DEFAULT_CH_API_BASE_URL } from "./aws-credentials.js";
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
import { subscribeChunks, timeoutError, badRequest } from "./util.js";
import { t } from "./i18n.js";

/**
 * 直接構築 (use) 時の既定値。`devices` は持たないため Partial。
 * @type {Partial<ClientConfig>}
 */
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

/**
 * catch 節の unknown から message 文字列を安全に取り出す (debug ログ用)。
 * @param {unknown} e
 * @returns {string}
 */
function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

/** @param {unknown} s @returns {string} */
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
   * @typedef {object} UseOpts
   * @property {string} [configDir]
   * @property {boolean} [debug]
   * @property {Partial<ClientConfig>} [config]
   * @property {TokenStore} [tokenStore]
   * @property {ConfigStore | null} [configStore]
   *
   * @param {((hub:SesameHub3) => Promise<any>) | UseOpts} fnOrOpts
   * @param {(hub:SesameHub3) => Promise<any>} [maybeFn]
   */
  static async use(fnOrOpts, maybeFn) {
    /** @type {UseOpts} */
    let opts = {};
    /** @type {((hub:SesameHub3) => Promise<any>) | undefined} */
    let fn;
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
   *   config: ClientConfig | Partial<ClientConfig>,
   *   tokenStore: TokenStore,
   *   configStore?: ConfigStore | null,
   *   debug?: boolean,
   * }} args
   */
  constructor({ config, tokenStore, configStore = null, debug = false }) {
    if (!config) throw new Error(t("domain.client.configRequired"));
    if (!tokenStore) throw new Error(t("domain.client.tokenStoreRequired"));
    // P5-6: 直接構築 (embedded) の config は旧 shape (locks/hub3s 永続化) でも受け付ける。
    // 旧 shape の解釈は migrateConfig、最新 shape の正規化は normalizeConfig (役割分担)。
    this._config = normalizeConfig(migrateConfig({ ...DEFAULT_CONFIG, ...config }));
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
      try { cb(); } catch (e) { if (this._debug) console.error("[hub3] onReconnect cb error:", errMsg(e)); }
    }
  }

  /**
   * companyID を必ず string で返す (DEFAULT_CONFIG / config.load が常に設定するため、
   * 型上 optional でも実体は常に present)。下流モジュールは companyID:string を要求する。
   * @returns {string}
   */
  get _companyID() {
    return /** @type {string} */ (this._config.companyID);
  }

  get config() { return this._config; }
  get configStore() { return this._configStore; }
  get tokenStore() { return this._tokenStore; }
  get connected() { return !!this._ws; }

  /**
   * remote 名 (省略時は default) から remote 定義と親 hub3 をまとめて取得。
   * @param {string} [name]
   */
  resolveRemote(name) {
    if (this._configStore) return this._configStore.resolveRemote(name);
    // configStore なしで直接構築された場合: resolveByName (src/resolve.js) で解決 (P5-4 で
    // ConfigStore.resolveRemote と一本化。失敗は SesameError(BAD_REQUEST) に統一)。
    const cfg = this._config;
    const { name: chosen, entry: remote } =
      resolveByName(cfg.remotes, name, cfg.default?.remote, REMOTE_RESOLVE_ERRORS);
    const hub3 = cfg.hub3s?.[remote.hub3];
    if (!hub3) throw badRequest("domain.client.remoteMissingHub3", { name: chosen, hub3: remote.hub3 });
    return { name: chosen, remote, hub3Name: remote.hub3, hub3 };
  }

  /** WS 接続を確立。既に接続済みなら何もしない。 */
  async connect() {
    if (this._ws) return;
    const idToken = await getValidIdToken(this._tokenStore);
    this._subUUID = jwtSub(idToken);
    this._ws = new Hub3WsClient({
      wsUrl: /** @type {string} */ (this._config.wsUrl),
      idToken,
      lang: this._config.lang,
      debug: this._debug,
      // 再接続が MAX_RETRIES_BEFORE_TOKEN_CHECK に達した時に呼ばれる。
      // 参照 (references_web/src/api/useAuthState.js:50-60 checkTokenExpiration) と同じく
      // exp を確認し、期限内なら refresh せず現 token を返す (= transport 側は同一 token
      // なので差し替えず backoff 継続)。期限切れ/閾値内のみ getValidIdToken が refresh する。
      onTokenRefreshNeeded: async () => {
        try {
          return await getValidIdToken(this._tokenStore);
        } catch (e) {
          if (this._debug) console.error("[hub3] token refresh failed:", errMsg(e));
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

  /**
   * 未接続なら throw、接続済みなら非 null の WS client を返す。
   * 呼び出し側はこの戻り値を使うと `this._ws` の null 絞り込みを跨いで保持できる。
   * @returns {Hub3WsClient}
   */
  _ensureConnected() {
    if (!this._ws) throw new Error(t("domain.client.notConnected"));
    return this._ws;
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

  /**
   * ドメインモジュール (純関数集) を namespace オブジェクトに束ねる。
   * companyID/subUUID を既定注入し、各 op を `(params) => fn(ws, {...})` でラップする。
   * @param {Record<string, unknown>} mod
   * @returns {Record<string, (params?: Record<string, unknown>) => unknown>}
   */
  _bindNs(mod) {
    this._ensureConnected();
    const ws = this._ws;
    const companyID = this._companyID;
    const subUUID = this._subUUID;
    // モジュールが NAMESPACE_OPS (公開 op の allowlist) を持つ場合はそれだけを露出。
    // presetir/iot のように client を取らない純ロジック (class/builder) が export に
    // 混じるモジュールで、それらを誤ってラップして壊すのを防ぐ。
    const names = Array.isArray(mod.NAMESPACE_OPS)
      ? /** @type {string[]} */ (mod.NAMESPACE_OPS)
      : Object.keys(mod).filter((k) => typeof mod[k] === "function");
    /** @type {Record<string, (params?: Record<string, unknown>) => unknown>} */
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
    const ws = this._ensureConnected();
    if (!keyOrUUID) throw new Error(t("domain.client.keyRequired"));
    const { remote, hub3 } = this.resolveRemote(remoteName ?? undefined);
    const isUUID = UUID_RE.test(keyOrUUID);
    const command = isUUID ? keyOrUUID : remote.keys?.[keyOrUUID];
    if (!command) {
      const avail = Object.keys(remote.keys || {}).join(", ") || "(none)";
      throw new Error(t("domain.client.unknownKey", { key: keyOrUUID, avail }));
    }
    return sendIR(ws, {
      deviceId: /** @type {string} */ (hub3.deviceId),
      irDeviceUUID: remote.irDeviceUUID,
      irType: remote.irType,
      command,
      operation: /** @type {"learnEmit"|"remoteEmit"} */ (remote.irOperation),
      companyID: this._companyID,
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
    const ws = this._ensureConnected();
    const { remote, hub3 } = this.resolveRemote(remoteName ?? undefined);
    return getIRCodes(ws, {
      deviceId: /** @type {string} */ (hub3.deviceId),
      irDeviceUUID: remote.irDeviceUUID,
      companyID: this._companyID,
    });
  }

  /**
   * 接続疎通確認: biz3KeepAlive を 1 往復して ack を待つ。
   * 失敗時は throw。
   */
  async ping() {
    const ws = this._ensureConnected();
    return ws.ping();
  }

  // ---------- アカウント (ログインユーザ情報) ----------

  /**
   * ログインユーザの customerInfo / quotas を取得 (biz3GetLoginUser)。
   * email は tokenStore の username (login に使った値) を使う。
   * @returns {Promise<{customerInfo: object|null, quotas: object|null}>}
   */
  async getLoginUser() {
    const ws = this._ensureConnected();
    const email = this._tokenStore.load()?.username;
    if (!email) throw new Error(t("domain.client.emailNotInStore"));
    return account.getLoginUser(ws, { email });
  }

  /**
   * biz3GetLoginUser で実 companyID / subUUID を取得し、config と内部状態に反映する。
   * companyID は従来デフォルト (ch_CandyhouseMobile) を置いていたが、これで実値に上書きできる。
   * @returns {Promise<object|null>} customerInfo
   */
  async refreshAccount() {
    const { customerInfo } = await this.getLoginUser();
    // customerInfo は biz3 由来の動的 JSON。companyID / subUUID を読むためにナロー化する。
    const ci = /** @type {{ companyID?: string, subUUID?: string } | null} */ (customerInfo);
    if (ci?.companyID) {
      this._config.companyID = ci.companyID;
      if (this._configStore) {
        const cfg = this._configStore.load();
        cfg.companyID = ci.companyID;
        this._configStore.save();
      }
    }
    if (ci?.subUUID) {
      this._subUUID = ci.subUUID; // jwtSub と同値のはずだが、正式値で上書き
    }
    return customerInfo ?? null;
  }

  /**
   * 全 SESAME デバイス (Hub3 含む) のリストを取得。
   * biz3ManageDevice/getCompanyDevice → PubedCompanyDevice の応答を待つ。
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<DeviceInfo[]>}
   */
  async listDevices({ timeoutMs = 10_000 } = {}) {
    const ws = this._ensureConnected();
    // biz3 PubedCompanyDevice は page 単位 push (vendor 確認: useManageDevice.js:36-55):
    //   message.data = { totalPage, data: { list, page } }
    // page===1 で全置換、page>1 で追記、totalPage===page で確定。最初の push で即 resolve
    // すると 1 ページ超のアカウントで一覧が先頭ページに切り詰められる (P1-13)。
    // 同一プロトコルの devices.js getUserDevices (PubedUserDevice) と同型の実装。
    /** @type {DeviceInfo[]} */
    let acc = [];
    return subscribeChunks(ws, {
      sendFrame: {
        action: ACTION_TYPES.BIZ3_MANAGE_DEVICE,
        op: "getCompanyDevice",
        companyID: this._companyID,
      },
      timeoutMs,
      onTimeout: () => timeoutError(t("domain.client.getCompanyDeviceTimeout")),
      // P1-5: 同 action の success:false (即時エラー応答) で timeout を待たず失敗確定
      // (useManageDevice.js:27-34 の !message.success 判定)。devices.js getUserDevices と同形。
      errorAction: ACTION_TYPES.BIZ3_MANAGE_DEVICE,
      result: () => acc,
      subscriptions: [{
        key: `${ACTION_TYPES.BIZ3_MANAGE_DEVICE}:PubedCompanyDevice`,
        /** @param {any} msg @param {(err?: Error) => void} finish */
        onMessage: (msg, finish) => {
          const totalPage = msg?.data?.totalPage;
          const inner = msg?.data?.data ?? {};
          const page = inner.page ?? 1;
          acc = page === 1 ? [...(inner.list ?? [])] : [...acc, ...(inner.list ?? [])];
          // totalPage が無ければ単一 chunk とみなし即完了 (vendor も totalPage===page で確定)。
          if (typeof totalPage !== "number" || page >= totalPage) finish();
        },
      }],
    });
  }

  // ---------- devices → config 同期 (ドメイン操作) ----------
  // CLI 専用だった自動化を library 利用者も使えるよう SesameHub3 に集約。
  // いずれも内部で listDevices / listIRRemotes を引いて ConfigStore に委譲する。
  // configStore 無しで構築された場合は使えない (throw)。

  /**
   * configStore が無ければ throw、あれば非 null の ConfigStore を返す。
   * @param {string} op エラーメッセージ用の操作名
   * @returns {ConfigStore}
   */
  _requireConfigStore(op) {
    if (!this._configStore) throw new Error(t("domain.client.requiresConfigStore", { op }));
    return this._configStore;
  }

  /**
   * 全 SESAME デバイスを引いてロックを config に取り込む。
   * @param {{prune?:boolean}} [opts]
   * @returns {Promise<{added:string[], updated:string[], removed:string[]}>}
   */
  async syncLocksFromDevices(opts = {}) {
    this._ensureConnected();
    const configStore = this._requireConfigStore("syncLocksFromDevices");
    const list = await this.listDevices();
    return configStore.syncLocksFromDevices(list, opts);
  }

  /**
   * 全 SESAME デバイスを引いて Hub3 を config に取り込む。
   * @param {{prune?:boolean}} [opts]
   * @returns {Promise<{added:string[], updated:string[], removed:string[]}>}
   */
  async syncHub3sFromDevices(opts = {}) {
    this._ensureConnected();
    const configStore = this._requireConfigStore("syncHub3sFromDevices");
    const list = await this.listDevices();
    return configStore.syncHub3sFromDevices(list, opts);
  }

  /**
   * `devices` 応答だけからリモコンを config に取り込む (引数不要)。
   * 内部で Hub3 を自動登録してから、各 Hub3 の stateInfo.remoteList を展開する。
   * irType はリモコン側が持っているのでユーザー指定不要。
   * @returns {Promise<{
   *   hub3: {added:string[], updated:string[], removed:string[]},
   *   remotes: {added:string[], updated:string[]},
   * }>}
   */
  async syncRemotesFromDevices() {
    this._ensureConnected();
    const configStore = this._requireConfigStore("syncRemotesFromDevices");
    const list = await this.listDevices();
    const hub3 = configStore.syncHub3sFromDevices(list);
    const remotes = configStore.syncRemotesFromDevices(list);
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
    /** @type {Array<{hub3DeviceUUID:string, hub3Name:string, uuid:string, type:number, alias:string|null}>} */
    const out = [];
    for (const d of list) {
      if (d.deviceModel !== "hub_3" && d.deviceModel !== "hub_3_lte") continue;
      const remoteList = /** @type {Array<Record<string, unknown>>} */ (d.stateInfo?.remoteList || []);
      for (const r of remoteList) {
        const uuid = /** @type {string|undefined} */ (r.uuid || r.irDeviceUUID);
        if (!uuid) continue;
        out.push({
          hub3DeviceUUID: d.deviceUUID ?? "",
          hub3Name: d.deviceName || d.deviceUUID || "",
          uuid,
          type: Number(r.type ?? r.irType),
          alias: /** @type {string|null} */ (r.alias || r.name || null),
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
    const configStore = this._requireConfigStore("syncRemotesFromServer");
    // P1-12: listIRRemotes は {list, pagination} を返す。config へ渡すのは一覧本体のみ。
    const { list } = await this.listIRRemotes(irType);
    return configStore.syncRemotesFromServer(
      /** @type {Array<{irDeviceUUID?: string, uuid?: string, type?: number|string, irType?: number|string, alias?: string|null, name?: string|null, irOperation?: string}>} */ (list),
      hub3Name,
    );
  }

  /**
   * 指定 remote のキー一覧を server から取得して config に書き戻す。
   * @param {string|null} remoteName
   * @returns {Promise<{name:string, keyCount:number}>}
   */
  async syncRemoteKeys(remoteName) {
    this._ensureConnected();
    const configStore = this._requireConfigStore("syncRemoteKeys");
    const { name } = this.resolveRemote(remoteName ?? undefined);
    const codes = await this.listKeys(name);
    /** @type {Record<string, string>} */
    const keys = {};
    for (const c of codes) keys[c.name] = c.keyUUID;
    configStore.updateRemoteKeys(name, keys);
    return { name, keyCount: Object.keys(keys).length };
  }

  // ---------- lock ----------

  // lock 制御の実体は LockManager (src/lock-manager.js) に集約。以下は後方互換の薄い委譲。

  /**
   * lock 設定を name から解決。name 省略時は default.lock、
   * 無ければ locks が 1 つだけならそれ。
   * @param {string|null} [name]
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
   * SESAME Bot2/Bot3 の **台本 (スクリプト) を番号指定で実行** (name-based, cloud 経由)。
   * cmd = 170 + scriptIndex (`CHSesameBot2Device.kt:73-89` の click(index) 相当)。
   * `botClick` (cmd=89) は「選択中の台本」を実行する別経路。
   * @param {string|null} name ロック名 (null で default.lock)
   * @param {number} scriptIndex 0..9
   * @returns {Promise<object>}
   */
  async botClickScript(name, scriptIndex) {
    return this._lock.botClickScript(name, scriptIndex);
  }

  /**
   * 直接 (config を介さず) Bot2/Bot3 台本を番号指定で実行。
   * @param {{deviceUUID:string, secretKey:string, scriptIndex:number, timeoutMs?:number}} p
   * @returns {Promise<object>}
   */
  botClickScriptDevice(p) { return this._lock.botClickScriptDevice(p); }

  /**
   * デバッグ用: WS の全受信メッセージを購読する (戻り値で unsubscribe)。
   * fire-and-forget な op (autolock 等) のサーバ応答を観測するのに使う。
   * @param {(msg: import("./transport.js").WsMessage)=>void} fn
   * @returns {()=>void} unsubscribe
   */
  onAnyMessage(fn) {
    const ws = this._ensureConnected();
    return ws.onMessage(fn);
  }

  /**
   * 任意 cmd 直指定 (上級用)。
   * @param {string|null} name
   * @param {number} cmd
   */
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
   * @returns {Promise<{keyUUID: string, captured: unknown, saved: unknown}>}
   */
  async learnIR(remoteName, keyName, { timeoutMs = 60_000, onPrompt } = {}) {
    const ws = this._ensureConnected();
    const { remote, hub3, name: rName } = this.resolveRemote(remoteName);
    const result = await ir.learnIRKey(ws, {
      hub3DeviceId: /** @type {string} */ (hub3.deviceId),
      remoteId: /** @type {string} */ (remote.irDeviceUUID),
      keyName,
      irType: remote.irType,
      companyID: this._companyID,
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

  /**
   * 登録済み IR リモコン一覧 (1 ページ分)。
   * 次ページは戻り値 pagination の currentPage+1 を page に渡す (vendor loadMoreRemotes,
   * useRemoteCtrl.js:431-441 と同じ読み方)。
   * @param {number} type irType
   * @param {{ page?: number, pageSize?: number }} [opts]
   * @returns {Promise<import("./ir.js").RemoteListPage>}
   */
  async listIRRemotes(type, { page, pageSize } = {}) {
    const ws = this._ensureConnected();
    return ir.getRemoteList(ws, { type, companyID: this._companyID, page, pageSize });
  }

  /**
   * プリセット IR リモコン検索 (最大 1000 件)。
   * @param {number} type irType
   * @param {string} searchTerm
   * @returns {Promise<import("./ir.js").RemoteListPage>}
   */
  async searchPresetIRRemotes(type, searchTerm) {
    const ws = this._ensureConnected();
    return ir.searchRemoteList(ws, { type, companyID: this._companyID, searchTerm });
  }

  /**
   * プリセットリモコンをサーバへ登録する。送信前に 3 個上限チェックを行う。
   *
   * 上限ロジック 1:1 (references_web/src/api/useRemoteCtrl.js:525-531):
   *   addIRRemote は送信前に canAddMoreRemote を通す。false なら拒否。
   *
   * 上限チェックには対象 Hub3 の現在の stateInfo.remoteList が必要。
   *   - `currentRemoteList` を渡すと、その一覧をもとにチェックする。
   *   - 省略時はチェックをスキップ (後方互換。直接 API 経路など一覧が手元にない場合)。
   *
   * @param {{type?: number|string, [k: string]: unknown}} remoteObj 追加するリモコンオブジェクト (type フィールド必須)
   * @param {{ currentRemoteList?: Array<{type?: number|string}> }} [opts]
   */
  async addIRRemoteServer(remoteObj, { currentRemoteList } = {}) {
    const ws = this._ensureConnected();
    // プリセット 3 個上限チェック (currentRemoteList が渡された場合のみ)。
    // 出典: references_web/src/api/useRemoteCtrl.js:525-531 (addIRRemote が
    //       送信前に canAddMoreRemote を通す)。
    if (currentRemoteList !== undefined) {
      const type = Number(remoteObj.type ?? 0);
      if (!ir.canAddMoreRemote(type, currentRemoteList)) {
        throw badRequest("domain.ir.presetRemoteLimit");
      }
    }
    return ir.addIRRemote(ws, { remote: remoteObj, companyID: this._companyID });
  }

  /** @param {string} [remoteName] */
  async deleteIRRemoteServer(remoteName) {
    const ws = this._ensureConnected();
    const { remote, hub3 } = this.resolveRemote(remoteName);
    return ir.deleteIRRemote(ws, {
      hub3DeviceId: /** @type {string} */ (hub3.deviceId),
      uuid: /** @type {string} */ (remote.irDeviceUUID),
      companyID: this._companyID,
    });
  }

  /**
   * @param {string} remoteName
   * @param {string} alias
   */
  async renameIRRemote(remoteName, alias) {
    const ws = this._ensureConnected();
    const { remote, hub3 } = this.resolveRemote(remoteName);
    return ir.updateRemoteAlias(ws, {
      hub3DeviceId: /** @type {string} */ (hub3.deviceId),
      uuid: /** @type {string} */ (remote.irDeviceUUID),
      alias,
      companyID: this._companyID,
    });
  }

  /**
   * @param {string} remoteName
   * @param {string} keyOrUUID
   */
  async deleteIRKey(remoteName, keyOrUUID) {
    const ws = this._ensureConnected();
    const { remote, hub3, name } = this.resolveRemote(remoteName);
    const keyUUID = remote.keys?.[keyOrUUID] || keyOrUUID;
    const resp = await ir.deleteIRCode(ws, {
      hub3DeviceId: /** @type {string} */ (hub3.deviceId),
      remoteId: /** @type {string} */ (remote.irDeviceUUID),
      keyUUID,
      companyID: this._companyID,
    });
    // config 側からも除去
    if (this._configStore && remote.keys?.[keyOrUUID]) {
      const { [keyOrUUID]: _, ...rest } = remote.keys;
      this._configStore.updateRemoteKeys(name, rest);
    }
    return resp;
  }

  /**
   * @param {string} remoteName
   * @param {string} keyOrUUID
   * @param {string} newName
   */
  async renameIRKey(remoteName, keyOrUUID, newName) {
    const ws = this._ensureConnected();
    const { remote, hub3, name } = this.resolveRemote(remoteName);
    const keyUUID = remote.keys?.[keyOrUUID] || keyOrUUID;
    const resp = await ir.updateIRCode(ws, {
      hub3DeviceId: /** @type {string} */ (hub3.deviceId),
      remoteId: /** @type {string} */ (remote.irDeviceUUID),
      keyUUID,
      name: newName,
      companyID: this._companyID,
    });
    if (this._configStore && remote.keys?.[keyOrUUID]) {
      const next = { ...remote.keys };
      delete next[keyOrUUID];
      next[newName] = keyUUID;
      this._configStore.updateRemoteKeys(name, next);
    }
    return resp;
  }

  /** @param {string} [hub3Name] */
  async getIRMode(hub3Name) {
    const ws = this._ensureConnected();
    const hub3 = this._resolveHub3(hub3Name);
    return ir.getIRMode(ws, { deviceId: /** @type {string} */ (hub3.deviceId), companyID: this._companyID });
  }

  /**
   * @param {string} hub3Name
   * @param {number} mode ir.MODE の値 (0=CONTROL, 1=REGISTER)
   */
  async setIRMode(hub3Name, mode) {
    const ws = this._ensureConnected();
    const hub3 = this._resolveHub3(hub3Name);
    return ir.setIRMode(ws, { deviceId: /** @type {string} */ (hub3.deviceId), mode, companyID: this._companyID });
  }

  /** @param {{ irData: string, irType: number, brandName?: string }} args */
  async matchIRRemote({ irData, irType, brandName }) {
    const ws = this._ensureConnected();
    return ir.matchRemote(ws, { irData, irType, brandName, companyID: this._companyID });
  }

  /**
   * リモコンを Matter デバイスとして Hub3 に登録 (P3-3、useRemoteCtrl.js:933-955 フィールド 1:1)。
   * Matter ペアリング窓 (iot.js) の開放とセットで使う。
   * @experimental 実機未検証 (参照: useRemoteCtrl.js:933-955)。
   * @param {{hub3DeviceId: string, irDeviceType: number, cmdOn: string, cmdOff: string,
   *          irDeviceUUID: string, irDeviceName: string}} p
   */
  async addRemoteToMatter({ hub3DeviceId, irDeviceType, cmdOn, cmdOff, irDeviceUUID, irDeviceName }) {
    const ws = this._ensureConnected();
    return ir.addRemoteToMatter(ws, {
      hub3DeviceId, irDeviceType, cmdOn, cmdOff, irDeviceUUID, irDeviceName,
      companyID: this._companyID,
    });
  }

  /** @param {string} [name] @returns {import("./config.js").Hub3View} */
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
    const ws = this._ensureConnected();
    return devices.getUserDevices(ws);
  }

  /** @param {string} deviceUUID */
  async getDeviceStatus(deviceUUID) {
    const ws = this._ensureConnected();
    return devices.getDeviceStatus(ws, { deviceUUID });
  }

  /**
   * 読み取った複数 IC カードをクラウド DB へ登録する。
   *
   * BLE enroll (`sesame access cards enroll`) で集約した records をそのまま渡せる。
   * cards 要素は BLE 読み取り形 `{cardID, cardName, cardType, nameUUID?}`。タップ登録経路は
   * vendor (cards/index.js:104-136) と同じくレコード毎の updateCardName 委譲で DB 同期する
   * (nameUUID はファーム採番値を透過。P3-11)。postCards の list 形を既に持つ一括投入は
   * access.postCards / syncEnrolledCards({list}) を直接使う。
   * @param {string} deviceUUID 対象 Touch の deviceUUID
   * @param {Array<{cardID:string, cardName?:string, cardType?:number, nameUUID?:string}>} cards
   * @returns {Promise<object|null>} updateCardName 応答の配列 (cards 空なら null)
   */
  async registerCards(deviceUUID, cards) {
    const ws = this._ensureConnected();
    // BLE 読み取り形は cardName/cardType を欠くことがあるが、enrolledToCardList が
    // 既定値で補正するため records 契約 (全フィールド必須) へキャストして渡す。
    const records = /** @type {Array<{cardID:string, cardName:string, cardType:number}>} */ (cards);
    return access.syncEnrolledCards(ws, { deviceUUID, records });
  }

  /**
   * 読み取った複数パスコードをクラウド DB へ登録する (registerCards と対称。SURF-04)。
   *
   * BLE enroll (`sesame access passcodes enroll`) で集約した records をそのまま渡せる。
   * records 要素は BLE 読み取り形 `{cardID|passwordID, cardName|name, nameUUID?}`。
   * DB 同期は access.syncEnrolledPasscodes (= postPasscodes 委譲。passcode に card のような
   * タップ登録→updateCardName 経路は参照に無い — passwords.js:94-115) で、nameUUID
   * (ファームウェア採番値) は透過される (P3-11 の不変条件: ファームと DB の nameUUID 一致)。
   * postPasscodes の list 形を既に持つ一括投入は access.postPasscodes /
   * syncEnrolledPasscodes({list}) を直接使う。
   * @param {string} deviceUUID 対象 Touch (Pro) / キーパッド搭載機の deviceUUID
   * @param {Array<{cardID?:string, passwordID?:string, cardName?:string, name?:string, nameUUID?:string}>} passcodes
   * @returns {Promise<object|null>} postPasscodes 応答 (records 空なら null)
   */
  async registerPasscodes(deviceUUID, passcodes) {
    const ws = this._ensureConnected();
    return access.syncEnrolledPasscodes(ws, { deviceUUID, records: passcodes });
  }

  /**
   * biometrics REST のベース URL を解決する。引数 > config.biometricsBaseUrl > config.registerBaseUrl
   * > 公式既定 (app.properties:3 = https://app.candyhouse.co/prod)。
   * @param {string} [baseUrl]
   * @returns {string}
   */
  _biometricsBaseUrl(baseUrl) {
    return baseUrl || this._config.biometricsBaseUrl || this._config.registerBaseUrl
      || DEFAULT_CH_API_BASE_URL;
  }

  /**
   * biometrics REST 用の Identity Pool credentials provider (SigV4 経路、P2-1/BIZ-07)。
   * 公式の認可は SigV4 + x-api-key (ApiClientConfigBuilder.kt:34-46) で、
   * 旧 idToken Bearer は参照に存在しないため撤去した。provider はキャッシュを持つので
   * インスタンスで 1 つを共有する。
   * @returns {import("./aws-credentials.js").CredentialsProviderLike}
   */
  _biometricsCredentialsProvider() {
    if (!this._bioCredentialsProvider) {
      this._bioCredentialsProvider = makeCognitoCredentialsProvider({
        getIdToken: () => getValidIdToken(this._tokenStore),
      });
    }
    return this._bioCredentialsProvider;
  }

  /**
   * biometrics 4 メソッド共通の transport 解決オプション (SigV4 経路)。
   * config / configStore は makeBiometricsTransport 側で無視される互換引数
   * (/device/v1/biometrics に appidentifyid は付かないため — access.js makeBiometricsTransport 参照)。
   * @param {string} [baseUrl]
   * @param {import("./access.js").BiometricsTransport} [transport]
   */
  _biometricsTransportOpts(baseUrl, transport) {
    if (transport) return { transport };
    return {
      transport: undefined,
      baseUrl: this._biometricsBaseUrl(baseUrl),
      credentialsProvider: this._biometricsCredentialsProvider(),
      config: this._config,
      configStore: this._configStore ?? undefined,
    };
  }

  /** @param {import("./client.js").BiometricAuthBag} [args] */
  async postAuthenticationData({ operation, deviceID, items, baseUrl, transport } = {}) {
    return access.postAuthenticationData(null, {
      operation,
      deviceID,
      items,
      ...this._biometricsTransportOpts(baseUrl, transport),
    });
  }

  /** @param {import("./client.js").BiometricAuthBag} [args] */
  async putAuthenticationData({ operation, deviceID, items, baseUrl, transport } = {}) {
    return access.putAuthenticationData(null, {
      operation,
      deviceID,
      items,
      ...this._biometricsTransportOpts(baseUrl, transport),
    });
  }

  /** @param {import("./client.js").BiometricAuthBag} [args] */
  async deleteAuthenticationData({ operation, deviceID, items, baseUrl, transport } = {}) {
    return access.deleteAuthenticationData(null, {
      operation,
      deviceID,
      items,
      ...this._biometricsTransportOpts(baseUrl, transport),
    });
  }

  /** @param {import("./client.js").BiometricNameBag} [args] */
  async updateAuthenticationName({ request, kind, baseUrl, transport, ...rest } = {}) {
    return access.updateAuthenticationName(null, {
      request,
      kind,
      ...rest,
      ...this._biometricsTransportOpts(baseUrl, transport),
    });
  }

  /**
   * @param {string} deviceUUID
   * @param {string} deviceName
   */
  async renameDevice(deviceUUID, deviceName) {
    const ws = this._ensureConnected();
    if (!this._subUUID) throw new Error(t("domain.client.subUUIDNotAvailable"));
    return devices.updateDeviceName(ws, { subUUID: this._subUUID, deviceUUID, deviceName });
  }

  /**
   * company から指定 UUID のデバイスを削除。
   * @param {string} deviceUUID
   */
  async deleteDevice(deviceUUID) {
    const ws = this._ensureConnected();
    return devices.deleteDevices(ws, {
      companyID: this._companyID,
      items: [{ deviceUUID }],
    });
  }

  /**
   * デバイスを company に追加する (P3-1)。items は QR 由来のデバイスキーオブジェクト配列
   * (useManageDevice.js:256-268)。上限超過時はサーバの "Limit Exceeded" がそのまま throw される。
   * @param {object[]} items
   */
  async addDevices(items) {
    const ws = this._ensureConnected();
    return devices.addDevices(ws, { companyID: this._companyID, items });
  }

  /**
   * デバイスの並び順を更新 (P3-1)。items は並べたい順のデバイスオブジェクト配列
   * (rank は lib 側が vendor と同じ -index で採番する — useManageDevice.js:270-285)。
   * @param {object[]} items
   * @returns {Promise<any>} 並び替え後のデバイス一覧
   */
  async reorderDevices(items) {
    const ws = this._ensureConnected();
    return devices.reorderDevices(ws, { companyID: this._companyID, items });
  }

  /**
   * デバイスごとの push 通知設定一覧 (P3-1, useManageDevice.js:287-302)。
   * @param {{pushToken: string, items: object[]}} p
   */
  async getDevicesNotifyStatus({ pushToken, items }) {
    const ws = this._ensureConnected();
    return devices.getNotifyStatus(ws, { companyID: this._companyID, pushToken, items });
  }

  /**
   * 単機の push 通知 ON/OFF 切り替え (P3-1, useManageDevice.js:304-320)。
   * @param {{pushToken: string, deviceUUID: string, enablePush: boolean|number}} p
   */
  async switchDeviceNotify({ pushToken, deviceUUID, enablePush }) {
    const ws = this._ensureConnected();
    return devices.switchNotify(ws, { companyID: this._companyID, pushToken, deviceUUID, enablePush });
  }

  /**
   * 充電池モード切り替え (P3-1, useManageDevice.js:360-372。frame に companyID は乗らない)。
   * @param {{deviceUUID: string, isRechargeBattery: boolean|number}} p
   */
  async switchRechargeableBattery({ deviceUUID, isRechargeBattery }) {
    const ws = this._ensureConnected();
    return devices.switchRechargeableBattery(ws, { deviceUUID, isRechargeBattery });
  }

  /**
   * @deprecated `onDeviceUpdate(items, fn)` を使ってください (on* イベント命名に統一)。
   * 後方互換のため残置。内部実装は onDeviceUpdate と同一。
   * @param {{deviceUUID:string, deviceModel?:string}[]} deviceInfos
   * @param {(msg:any) => void} onUpdate
   */
  subscribeDeviceUpdates(deviceInfos, onUpdate) {
    return this.onDeviceUpdate(deviceInfos, onUpdate);
  }

  /**
   * ロック開閉履歴を取得。`list` はデバイス指定の配列。
   * 要素の `lastKey` (直前ページ末尾レコードの timestamp) でページングできる (P3-7、
   * DeviceHistory.js:37-44 — vendor は常に {deviceUUID, lastKey} を送る)。
   *
   * @param {Array<{deviceUUID: string, lastKey?: number|null}>} list 履歴を取得するデバイスの配列
   * @param {number} [pageSize] 1 ページあたりの件数 (未指定でサーバ既定)
   * @returns {Promise<any>}
   */
  async getDeviceHistory(list, pageSize) {
    const ws = this._ensureConnected();
    return devices.getDeviceHistory(ws, {
      companyID: this._companyID,
      list,
      pageSize,
    });
  }

  /**
   * 単機の開閉履歴を全ページ自動取得 (P3-7、vendor fetchAllHistory 相当 —
   * DeviceHistory.js:37-74: res.length===pageSize の間 lastKey=末尾 timestamp で継続)。
   * @param {string} deviceUUID
   * @param {{ pageSize?: number, maxPages?: number }} [opts]
   * @returns {Promise<any[]>}
   */
  async getAllDeviceHistory(deviceUUID, { pageSize, maxPages } = {}) {
    const ws = this._ensureConnected();
    return devices.getAllDeviceHistory(ws, {
      companyID: this._companyID,
      deviceUUID,
      pageSize,
      maxPages,
    });
  }

  /**
   * 開閉履歴の1エントリを非表示化 (論理削除)。timestamp は getDeviceHistory の各 record の値。
   * @param {{ deviceUUID: string, timestamp: number }} args
   */
  async hideDeviceHistory({ deviceUUID, timestamp }) {
    const ws = this._ensureConnected();
    return devices.makeHistoryInvisible(ws, { deviceUUID, timestamp });
  }

  /**
   * 電池履歴を取得 (1ページ)。lastEvaluatedKey でページング。
   * @param {string} deviceUUID
   * @param {{ lastEvaluatedKey?: unknown, pageSize?: number }} [opts]
   */
  async getDeviceBattery(deviceUUID, { lastEvaluatedKey = null, pageSize = 100 } = {}) {
    const ws = this._ensureConnected();
    return devices.getBatteryRecord(ws, { deviceUUID, lastEvaluatedKey, pageSize });
  }

  /**
   * 電池履歴の1エントリを非表示化 (論理削除)。timestampSecond は getDeviceBattery の record.ts。
   * @param {{ deviceUUID: string, timestampSecond: number }} args
   */
  async hideBatteryRecord({ deviceUUID, timestampSecond }) {
    const ws = this._ensureConnected();
    return devices.makeBatteryRecordInvisible(ws, { deviceUUID, timestampSecond });
  }

  async listFirmware() {
    const ws = this._ensureConnected();
    return devices.listFirmware(ws);
  }

  /**
   * WebAPI proxy 経由で REST API を叩く。apiKeyId は config 側に保存。
   * @param {{ func: string, query?: object, body?: object, apiKeyId?: string }} args
   */
  async invokeWebAPI({ func, query, body, apiKeyId }) {
    const ws = this._ensureConnected();
    const key = apiKeyId || this._config.apiKeyId;
    if (!key) throw new Error(t("domain.client.apiKeyIdRequired"));
    return devices.invokeWebAPI(ws, { func, apiKeyId: key, query, body });
  }

  /** @param {{ deviceId?: string, apiKeyId?: string }} [args] */
  async webapiDeviceState({ deviceId, apiKeyId } = {}) {
    const ws = this._ensureConnected();
    const key = apiKeyId || this._config.apiKeyId;
    if (!key) throw new Error(t("domain.client.apiKeyIdRequired"));
    return devices.webapiDeviceState(ws, { apiKeyId: key, deviceId: /** @type {string} */ (deviceId) });
  }

  /** @param {{ deviceId?: string, page?: number, lg?: number, isBiz?: boolean, apiKeyId?: string }} [args] */
  async webapiDeviceHistory({ deviceId, page, lg, isBiz, apiKeyId } = {}) {
    const ws = this._ensureConnected();
    const key = apiKeyId || this._config.apiKeyId;
    if (!key) throw new Error(t("domain.client.apiKeyIdRequired"));
    return devices.webapiDeviceHistory(ws, { apiKeyId: key, deviceId: /** @type {string} */ (deviceId), page, lg, isBiz });
  }

  /** @param {{ deviceId?: string, cmd?: unknown, sign?: unknown, history?: unknown, apiKeyId?: string }} [args] */
  async webapiSendCmd({ deviceId, cmd, sign, history, apiKeyId } = {}) {
    const ws = this._ensureConnected();
    const key = apiKeyId || this._config.apiKeyId;
    if (!key) throw new Error(t("domain.client.apiKeyIdRequired"));
    return devices.webapiSendCmd(ws, { apiKeyId: key, deviceId: /** @type {string} */ (deviceId), cmd, sign, history });
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
    const ws = this._ensureConnected();
    return setAutolockRaw(ws, { deviceId: deviceUUID, secretKey, seconds, timeoutMs });
  }

  /**
   * 直接 IR 発射 (config を介さない)。
   * @param {{hub3DeviceId:string, irDeviceUUID:string, irType:number, command:string, operation?:string}} p
   *   hub3DeviceId: Hub3 UUID / irDeviceUUID: リモコン UUID / irType: 例 49152 /
   *   command: keyUUID か 16byte hex / operation: "learnEmit" (default) | "remoteEmit"
   * @returns {Promise<object>} sendIR の応答
   */
  async sendIRDirect({ hub3DeviceId, irDeviceUUID, irType, command, operation = "learnEmit" }) {
    const ws = this._ensureConnected();
    return sendIR(ws, {
      deviceId: hub3DeviceId,
      irDeviceUUID,
      irType,
      command,
      operation: /** @type {"learnEmit"|"remoteEmit"} */ (operation),
      companyID: this._companyID,
    });
  }

  /**
   * 直接 IR キー一覧取得 (config を介さない)。
   * @param {{hub3DeviceId:string, irDeviceUUID:string}} p
   * @returns {Promise<Array<{name:string, keyUUID:string}>>}
   */
  async getIRCodesDirect({ hub3DeviceId, irDeviceUUID }) {
    const ws = this._ensureConnected();
    return getIRCodes(ws, {
      deviceId: hub3DeviceId,
      irDeviceUUID,
      companyID: this._companyID,
    });
  }

  // ---------- high-level event subscriptions ----------
  // 低レベル `this._ws.subscribe(key, fn)` の薄い wrapper だが、
  // deviceId フィルタ・複数 unsubscribe の合成・モード切替の自動化など、
  // 「やりたいこと」レベルで使えるよう包んだ。

  /**
   * name で指定したロックの state change push を購読。戻り値は unsubscribe。
   * @param {string|null} name
   * @param {(msg: import("./transport.js").WsMessage)=>void} fn
   */
  onLockStateChange(name, fn) {
    this._ensureConnected();
    const { lock } = this.resolveLock(name);
    // config 上の model が分かるので購読 frame の items に乗せる
    // (vendor subscribeDevices は {deviceUUID, deviceModel} を送る — useManageDevice.js:341-344)。
    return this.onLockStateChangeDevice(lock.deviceUUID, fn, { deviceModel: lock.model ?? undefined });
  }

  /**
   * UUID 直指定で state change を購読。
   *
   * P3-4: `pubDeviceStateChange` は **`subscribeDevicesUpdate` frame を送った接続にのみ**
   * push される (useManageDevice.js:48-51,322-350)。旧実装はローカル購読だけでサーバへ
   * 購読 frame を送っておらず、ライブラリ利用者が onLockStateChange() だけ呼ぶとイベントが
   * 永遠に来なかった (serve daemon は onDeviceUpdate 経由で frame を送るため正常だった)。
   * 本メソッドは対象デバイスの購読 frame を送信し、WS 再接続時にも再送する
   * (サーバは新接続を覚えていないため再送が必須)。
   *
   * 既知の制限: biz3 に unsubscribe op は無いため、unsubscribe() はローカル購読の解除と
   * 再送停止のみ (サーバ側 push は接続が生きている限り続き、ローカルで無視される)。
   *
   * @param {string|undefined} deviceUUID
   * @param {(msg: import("./transport.js").WsMessage)=>void} fn
   * @param {{ deviceModel?: string }} [opts] 購読 frame の items に乗せる deviceModel (分かる場合)
   * @returns {() => void} unsubscribe
   */
  onLockStateChangeDevice(deviceUUID, fn, { deviceModel } = {}) {
    const ws = this._ensureConnected();
    const target = normalizeUuid(deviceUUID);
    // 購読 frame (useManageDevice.js:325-331 と同形)。vendor は {deviceUUID, deviceModel} を
    // 送る (:341-344) が、model 不明の direct 経路では deviceUUID のみ送る。
    const item = deviceModel ? { deviceUUID, deviceModel } : { deviceUUID };
    const sendSubscribeFrame = () => {
      ws.send({
        action: ACTION_TYPES.BIZ3_MANAGE_DEVICE,
        op: "subscribeDevicesUpdate",
        items: [item],
        companyID: this._companyID,
      });
    };
    sendSubscribeFrame();
    // 再接続時はサーバ側購読が消えるため frame を再送する (P3-4)。
    const offReconnect = this.onReconnect(sendSubscribeFrame);
    const offSub = ws.subscribe(STATE_CHANGE_KEY, (msg) => {
      // pubDeviceStateChange の本体は message.data、識別は data.deviceUUID
      // (vendor 確認: useIotCtrl.js:20-21 が updateDeviceState(message.data)、
      //  useManageDevice.js:147 が updatedDevice.deviceUUID)。単一フィールドのみ。
      const data = /** @type {{ deviceUUID?: string } | undefined} */ (msg?.data);
      const incoming = normalizeUuid(data?.deviceUUID);
      if (incoming !== target) return;
      try { fn(msg); } catch { /* ignore */ }
    });
    return () => { offReconnect(); offSub(); };
  }

  /**
   * デバイス一覧の増減 push (`pubUserDeviceChange`) を購読 (P3-5)。
   * 鍵共有・デバイス追加/削除があるとサーバが push する。vendor はこれを受けて
   * デバイス一覧を再取得する (useIotCtrl.js:12,23-25)。
   * 専用 subscribe op は存在しない (useIotCtrl.js:23-25 はハンドラ登録のみ)。
   * ただし vendor 接続は常に subscribeDevicesUpdate を送信済み (useManageDevice.js:51,346) のため、
   * 無購読接続にも push されるかは実機未検証 (§9 V14 参照)。
   * @param {(msg: import("./transport.js").WsMessage)=>void} fn
   * @returns {() => void} unsubscribe
   */
  onUserDeviceChange(fn) {
    const ws = this._ensureConnected();
    return devices.subscribeUserDeviceChange(ws, { onChange: fn });
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
  /**
   * @param {string} hub3Name
   * @param {(data: unknown)=>void} fn
   * @returns {Promise<() => Promise<void>>}
   */
  async onIRLearned(hub3Name, fn) {
    const ws = this._ensureConnected();
    const h = this._resolveHub3(hub3Name);
    const deviceId = /** @type {string} */ (h.deviceId);
    const companyID = this._companyID;
    await ir.setIRMode(ws, { deviceId, mode: ir.MODE.REGISTER, companyID });
    const sub = await ir.subscribeIRData(ws, { deviceId, companyID });
    const off = sub.onData((/** @type {import("./transport.js").WsMessage} */ msg) => {
      // 学習波形は response.data.data (vendor 確認: learn/index.js:219,227)。単一パスのみ。
      const data = /** @type {{ data?: unknown } | undefined} */ (msg?.data);
      try { fn(data?.data); } catch { /* ユーザ callback の例外は購読を壊さない */ }
    });
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      this._pendingCleanups.delete(cleanup);
      off();
      sub.unsubscribe();
      try {
        await ir.setIRMode(ws, { deviceId, mode: ir.MODE.CONTROL, companyID });
      } catch { /* best effort */ }
    };
    // close() 時の自動 cleanup 用に登録 (2nd-pass M-1)
    this._pendingCleanups.add(cleanup);
    return cleanup;
  }

  /**
   * デバイス state push の購読 (複数デバイスまとめて)。
   *
   * P1-4: WS 再接続後にサーバ側購読が失われるため、再接続時に購読フレームを再送する。
   * vendor: useManageDevice.js:352-358 — `onConnectionIdChange(() => getCompanyDevices())`
   * → useManageDevice.js:48-51 で `subscribeDevices(...)` を再送。
   * onLockStateChangeDevice と同型の onReconnect パターン。
   *
   * @param {{deviceUUID:string, deviceModel?:string}[]} items
   * @param {(msg:any) => void} fn
   * @returns {() => void} unsubscribe
   */
  onDeviceUpdate(items, fn) {
    const ws = this._ensureConnected();
    const { unsubscribe: offSub, sendFrame } = devices.subscribeDevicesUpdate(ws, {
      companyID: this._companyID,
      items,
      onUpdate: fn,
    });
    // 再接続時はサーバ側購読が消えるため frame を再送する (P1-4)。
    const offReconnect = this.onReconnect(sendFrame);
    return () => { offReconnect(); offSub(); };
  }
}
