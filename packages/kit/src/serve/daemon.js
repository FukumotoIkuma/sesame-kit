// Daemon — 単一常駐 hub の上に JSON-RPC を多重化する中核。
//
// 全フレーミング (stdio/UDS/HTTP/WS/gRPC) はここに Connection を addConnection し、
// 受信行を handleLine に渡すだけ。Daemon は:
//   - registry 解決 + rpc.discover
//   - **メソッド名単位の直列化** (複数クライアントの同一 op 応答入替を防ぐ。
//     WS の FIFO リゾルバは (action:op) 単位グローバルなため)
//   - 購読を **daemon が一元所有** (Map<Connection,Set<topic>>)、hub の状態 push を
//     **1 本だけ**張って購読 Connection へ fan-out (リスナ爆発・IR 副作用を回避)
//   - authState 管理、起動ポリシー (framing 先・connect 再試行・degraded)、graceful shutdown
//
// Connection 契約 (framing が実装): { id:string, send(obj):void, close():void }
//   send はフレーミング固有の直列化 + 背圧を担う (溢れたらその接続を切る)。

import { handleMessage, makeEvent, RpcError, RPC, KIND } from "@sesame-kit/core/jsonrpc";
import { buildRegistry, buildOpenRpcDoc, STATE_TOPICS, SUBSCRIBABLE_TOPICS } from "./registry.js";
import { TRANSPORT_ERR } from "@sesame-kit/core/transport";
import { t } from "@sesame-kit/core/i18n";

/**
 * フレーミングが実装する接続契約。Daemon は send/close と分類フラグだけに依存する
 * (transport 固有の直列化・背圧は framing 側の責務)。
 * @typedef {object} Connection
 * @property {string} [id]
 * @property {(obj: unknown) => void} send フレーミング固有の直列化 + 背圧
 * @property {() => void} close 接続を閉じる (framing 固有のリソース解放)
 * @property {boolean} [ephemeral] HTTP POST /rpc・gRPC unary など 1 往復で閉じる接続
 */

/**
 * 常駐 hub。SesameHub3 本体、もしくはテストの狭い fake。Daemon が実際に触る面だけを
 * 構造的に要求する (テスト fake を許容しつつ未定義メソッド呼び出しを型で防ぐ)。
 * 名前空間 dispatch (hub[ns][op]) は registry 側で行うため、ここでは index signature を足す。
 * @typedef {object} HubLike
 * @property {boolean} connected
 * @property {string|null} [subUUID]
 * @property {() => Promise<void>} connect
 * @property {() => Promise<void>} close
 * @property {(cb: () => void) => void} [onReconnect]
 * @property {() => Promise<unknown>} [refreshAccount] 実 companyID/subUUID を config へ反映 (SURF-09)
 * @property {(items: Array<{deviceUUID: unknown, deviceModel: unknown}>, cb: (msg: unknown) => void) => (() => void)} onDeviceUpdate
 * @property {(cb: (msg: unknown) => void) => (() => void)} [onUserDeviceChange]
 * @property {import("@sesame-kit/core/tokens").TokenStore} [tokenStore]
 * @property {{ devices?: Record<string, { deviceUUID: unknown, deviceModel: unknown }>, registerBaseUrl?: string|null }} [config]
 */

// topic 集合は registry.js の STATE_TOPICS / SUBSCRIBABLE_TOPICS を単一の真実として import する
// (SURF-16 = ARCH-07: 旧実装はここに同じ配列が二重定義されていて、topic 追加時にずれ得た)。

/**
 * unknown な throw から安全に message を取り出す (ログ用)。
 * @param {unknown} e
 * @returns {string}
 */
function errMessage(e) {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String(/** @type {{message: unknown}} */ (e).message);
  return String(e);
}

/**
 * handler が投げた素の Error を kind 付き RpcError へ正規化する。判定は transport が付ける
 * **構造化コード (.code = TRANSPORT_ERR.*)** で行う (跨モジュールの脆弱な文字列正規表現を排除)。
 * 該当しなければそのまま返し、errorFromThrow が internal にフォールバックする。
 * @param {unknown} e
 * @returns {unknown}
 */
function classifyError(e) {
  if (e instanceof RpcError) return e;
  const code = (e && typeof e === "object" && "code" in e) ? /** @type {{code: unknown}} */ (e).code : undefined;
  const message = (e && typeof e === "object" && "message" in e) ? String(/** @type {{message: unknown}} */ (e).message) : "";
  if (code === TRANSPORT_ERR.TIMEOUT) return new RpcError(message, { code: RPC.APP_ERROR, kind: KIND.TIMEOUT });
  if (code === TRANSPORT_ERR.CLOSED) return new RpcError(message, { code: RPC.APP_ERROR, kind: KIND.CONNECTION_LOST });
  return e;
}

export class Daemon {
  /**
   * @param {{ hub: HubLike, version?: string, debug?: boolean }} args
   *   hub は SesameHub3 (テストでは狭いインターフェースの fake)。
   */
  constructor({ hub, version = "0.0.0", debug = false }) {
    if (!hub) throw new Error(t("serve.hubRequired"));
    /** @type {HubLike} */
    this.hub = hub;
    this.version = version;
    this._debug = debug;
    /** @type {"ok"|"degraded"|"expired"} */
    this.authState = "degraded"; // ok | degraded | expired
    this._registry = buildRegistry();
    this._openrpc = buildOpenRpcDoc(this._registry, version);
    /** @type {Map<string, Promise<unknown>>} メソッド名→直列化チェーン末尾 */
    this._locks = new Map();
    /** @type {Map<Connection, Set<string>>} Connection→購読 topic */
    this._subs = new Map();
    /** @type {(() => void)|null} hub 状態 push の単一購読の unsubscribe (張っている時のみ非 null) */
    this._stateUnsub = null;
    /** @type {(() => void)|null} pubUserDeviceChange (deviceListChanged) 購読の unsubscribe (P3-5) */
    this._deviceListUnsub = null;
    this._stopped = false;
    this._shuttingDown = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    this._retryTimer = null;
    /** @type {(() => void)|null} */
    this._retryResolve = null;
  }

  /** @param {...unknown} a */
  _log(...a) { if (this._debug) console.error("[serve]", ...a); }

  openRpcDocument() { return this._openrpc; }

  // ---- 起動ポリシー (framing は先に上がっている前提。ここは背景で接続を試みる) ----
  start() {
    // 再接続のたびに購読を張り直す (C1: subscribe frame 再送が無いとイベントが永久に止まる)。
    if (typeof this.hub.onReconnect === "function") {
      this.hub.onReconnect(() => this._reestablishStateSub());
    }
    this._connectLoop();
  }

  async _connectLoop() {
    let delay = 1000;
    while (!this._stopped) {
      try {
        await this.hub.connect();
        this.authState = "ok";
        this._log("cloud connected");
        // SURF-09: 名前空間 op の companyID/subUUID は daemon が hub 既定値を自動注入する契約
        // (gen-rpc-schema が required:false に上書き)。config の既定 companyID
        // (ch_CandyhouseMobile) と実アカウントの companyID の食い違いを、起動直後に
        // biz3GetLoginUser 1 回で解消しておく。失敗は warn ログのみで継続する
        // (注入値が既定のままになるだけで、明示 params 渡しの呼び出しは影響を受けない)。
        if (typeof this.hub.refreshAccount === "function") {
          try {
            await this.hub.refreshAccount();
          } catch (e) {
            console.error(t("serve.refreshAccountFailed", { detail: errMessage(e).slice(0, 160) }));
          }
        }
        this._ensureStateSub();
        return;
      } catch (e) {
        // 認証状態は error 文字列の正規表現ではなく、トークンの有無で決定的に分類する。
        //   トークンが無い (未ログイン) → expired (= not_authenticated を即返す。"sesame login" 案内)
        //   トークンはある → degraded (ネットワーク不通等。背景で再試行して復帰を拾う)
        this.authState = this._hasStoredTokens() ? "degraded" : "expired";
        // 接続失敗は --debug でなくても見えるように (未ログイン等を初学者が気付けるよう)。
        console.error(t("serve.connectFailed", { authState: this.authState, detail: errMessage(e).slice(0, 160) }));
        await this._sleep(delay);
        delay = Math.min(delay * 2, 30000);
      }
    }
  }

  _hasStoredTokens() {
    try {
      const t = this.hub.tokenStore?.load?.();
      return !!(t && (t.refreshToken || t.idToken));
    } catch { return false; }
  }

  /**
   * キャンセル可能な sleep。shutdown 時に即 resolve してループを抜けさせる。
   * @param {number} ms
   * @returns {Promise<void>}
   */
  _sleep(ms) {
    return new Promise((/** @type {() => void} */ resolve) => {
      this._retryResolve = resolve;
      this._retryTimer = setTimeout(() => { this._retryResolve = null; resolve(); }, ms);
    });
  }

  // ---- Connection 管理 ----
  /** @param {Connection} conn */
  addConnection(conn) {
    this._subs.set(conn, new Set());
    // 永続接続にはストリーム確立を告げる event.ready を 1 本送る (stdio/socket/ws/SSE/
    // gRPC Subscribe を一様に)。ephemeral (HTTP POST /rpc・gRPC unary) には送らない。
    if (!conn.ephemeral) {
      try { conn.send(makeEvent("ready", {})); } catch { /* 送信不可 (即時切断等) は無視 */ }
    }
  }

  /** @param {Connection} conn */
  removeConnection(conn) {
    this._subs.delete(conn);
    this._maybeTeardownStateSub();
  }

  // ---- 受信処理 ----
  /**
   * 1 メッセージを処理して応答オブジェクト (通知なら null) を返す。push はしない (HTTP POST 用)。
   * @param {Connection} conn
   * @param {string} raw
   * @returns {Promise<import("@sesame-kit/core/jsonrpc").RpcResponse|null>}
   */
  dispatchMessage(conn, raw) {
    return handleMessage(raw, (method, params) => this.invoke(method, params, conn));
  }

  /**
   * framing から: 1 行を処理し、応答があれば conn.send で push する。throw しない。
   * @param {Connection} conn
   * @param {string} raw
   */
  async handleLine(conn, raw) {
    const res = await this.dispatchMessage(conn, raw);
    if (res) {
      try { conn.send(res); } catch (e) { this._log("send failed:", errMessage(e)); }
    }
  }

  /**
   * メソッド実行。registry 解決 + rpc.discover + メソッド名単位の直列化。常に Promise を返す。
   * @param {string} method
   * @param {unknown} params
   * @param {Connection} [conn]
   * @returns {Promise<unknown>}
   */
  async invoke(method, params, conn) {
    if (method === "rpc.discover") return this.openRpcDocument();
    if (method.startsWith("rpc.")) {
      throw new RpcError(t("serve.methodNotFound", { method }), { code: RPC.METHOD_NOT_FOUND, kind: KIND.NOT_IMPLEMENTED });
    }
    const entry = this._registry.get(method);
    if (!entry) {
      throw new RpcError(t("serve.methodNotFound", { method }), { code: RPC.METHOD_NOT_FOUND, kind: KIND.NOT_IMPLEMENTED });
    }
    const p = params == null ? {} : params;
    if (typeof p !== "object" || Array.isArray(p)) {
      throw new RpcError(t("serve.paramsMustBeObject"), { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
    }
    // hub は HubLike (daemon が触る面)。registry は名前空間 op を hub[ns][op] で動的解決するため
    // Record index を併せ持つ Hub 型を要求する。実体は同一オブジェクトなのでここで橋渡しする。
    const hub = /** @type {import("./registry.js").Hub} */ (/** @type {unknown} */ (this.hub));
    const params2 = /** @type {Record<string, unknown>} */ (p);
    const run = async () => {
      try {
        return await entry.handler({ hub, params: params2, conn, daemon: this });
      } catch (e) {
        throw classifyError(e); // transport 由来の timeout/切断を kind 付きに
      }
    };
    return this._serialize(method, run);
  }

  /**
   * 同名メソッドを直列化する。これは応答入替の主防御ではなく (request() ベースの op は
   * transport の (action:op) FIFO が保証する) **listDevices 等 onMessage 先着 resolve で
   * 解決する op** を、複数クライアント同時呼び出しから守る防御。同名 op を 1 並行に絞る。
   */
  /**
   * @param {string} key
   * @param {() => Promise<unknown>} run
   * @returns {Promise<unknown>}
   */
  _serialize(key, run) {
    const prev = this._locks.get(key) || Promise.resolve();
    const p = prev.then(run, run); // 前段の成否に関わらず次を実行
    // チェーンが無限に伸びないよう、解決したら掃除 (自分が末尾なら削除)
    const tail = p.catch(() => {});
    this._locks.set(key, tail);
    tail.then(() => { if (this._locks.get(key) === tail) this._locks.delete(key); });
    return p;
  }

  // ---- 購読 (daemon 一元所有) ----
  /**
   * @param {Connection|undefined} conn
   * @param {string[]} topics
   * @returns {{ subscribed: string[] }}
   */
  subscribe(conn, topics) {
    const set = conn && this._subs.get(conn);
    if (!set) throw new RpcError(t("serve.connNotRegistered"), { kind: KIND.INTERNAL });
    for (const t of topics) set.add(t);
    this._ensureStateSub();
    return { subscribed: [...set] };
  }

  /**
   * @param {Connection|undefined} conn
   * @param {string[]} topics
   * @returns {{ subscribed: string[] }}
   */
  unsubscribe(conn, topics) {
    const set = conn && this._subs.get(conn);
    if (!set) return { subscribed: [] };
    for (const t of topics) set.delete(t);
    this._maybeTeardownStateSub();
    return { subscribed: [...set] };
  }

  _anySubscribers() {
    for (const set of this._subs.values()) if (set.size) return true;
    return false;
  }

  /** 状態 push の単一購読を (必要なら) 張る。hub 未接続なら接続時に再試行。 */
  _ensureStateSub() {
    if (!this.hub.connected) return;
    if (!this._stateUnsub) {
      try {
        // config 上の devices を items に (サーバへ subscribe frame を送るため)。
        const devices = (this.hub.config && this.hub.config.devices) || {};
        const items = Object.values(devices).map((d) => ({ deviceUUID: d.deviceUUID, deviceModel: d.deviceModel }));
        this._stateUnsub = this.hub.onDeviceUpdate(items, (msg) => this._fanout(msg));
        this._log("state subscription established");
      } catch (e) {
        this._log("state sub failed:", errMessage(e));
      }
    }
    // P3-5: pubUserDeviceChange (デバイス増減 push) は購読 frame 不要のローカル購読
    // (useIotCtrl.js:12,23-25)。topic `deviceListChanged` として fan-out する。
    if (!this._deviceListUnsub && typeof this.hub.onUserDeviceChange === "function") {
      try {
        this._deviceListUnsub = this.hub.onUserDeviceChange((msg) => this._fanoutTopic("deviceListChanged", msg));
        this._log("device-list subscription established");
      } catch (e) {
        this._log("device-list sub failed:", errMessage(e));
      }
    }
  }

  _reestablishStateSub() {
    // 再接続後に購読者が居れば張り直す (サーバ側 subscribe frame は再送が要るため)。
    // P1-4 以降、ライブラリ層 (onDeviceUpdate) も onReconnect で frame を再送するため、
    // ここでの再送は二重になるが無害 (サーバは同じ items の subscribe を冪等に受け付ける)。
    // 旧 unsub を必ず呼んでから張り直す。呼ばないと transport の subscribers に古い fn が
    // 残り、新 fn と二重配信になる (subscribers は再接続を跨いで保持されるため)。
    if (this._stateUnsub) { try { this._stateUnsub(); } catch { /* ignore */ } this._stateUnsub = null; }
    if (this._deviceListUnsub) { try { this._deviceListUnsub(); } catch { /* ignore */ } this._deviceListUnsub = null; }
    if (this._anySubscribers()) this._ensureStateSub();
  }

  _maybeTeardownStateSub() {
    if (this._anySubscribers()) return;
    if (this._stateUnsub) {
      try { this._stateUnsub(); } catch { /* ignore */ }
      this._stateUnsub = null;
      this._log("state subscription torn down");
    }
    if (this._deviceListUnsub) {
      try { this._deviceListUnsub(); } catch { /* ignore */ }
      this._deviceListUnsub = null;
      this._log("device-list subscription torn down");
    }
  }

  /**
   * 状態 push を購読 Connection へ配信する。
   * 注: lockState と deviceUpdate は現状どちらも biz3 の pubDeviceStateChange を源とする
   * (同一ストリームの別ラベル)。両方購読している接続には **1 回だけ** 配信する
   * (最初に購読している topic のラベルで) — 同一イベントの二重配信を避ける。
   * deviceListChanged は別ストリーム (pubUserDeviceChange) なのでここでは配信しない
   * (_fanoutTopic 経由)。
   */
  /** @param {unknown} msg */
  _fanout(msg) {
    for (const [conn, set] of this._subs) {
      const topic = STATE_TOPICS.find((t) => set.has(t));
      if (topic) {
        try { conn.send(makeEvent(topic, msg)); } catch { /* framing 背圧で切断済み等 */ }
      }
    }
  }

  /**
   * 単一 topic のイベントを購読 Connection へ配信する (P3-5: deviceListChanged 用)。
   * @param {string} topic
   * @param {unknown} msg
   */
  _fanoutTopic(topic, msg) {
    for (const [conn, set] of this._subs) {
      if (!set.has(topic)) continue;
      try { conn.send(makeEvent(topic, msg)); } catch { /* framing 背圧で切断済み等 */ }
    }
  }

  // ---- shutdown ----
  /** 冪等。受付停止 → hub.close()(=_pendingCleanups 実行) → 解決。 */
  async shutdown() {
    if (this._shuttingDown) return;
    this._shuttingDown = true;
    this._stopped = true;
    if (this._retryTimer) clearTimeout(this._retryTimer);
    if (this._retryResolve) { this._retryResolve(); this._retryResolve = null; } // connectLoop の sleep を即解除
    if (this._stateUnsub) { try { this._stateUnsub(); } catch { /* ignore */ } this._stateUnsub = null; }
    if (this._deviceListUnsub) { try { this._deviceListUnsub(); } catch { /* ignore */ } this._deviceListUnsub = null; }
    try { await this.hub.close(); } catch (e) { this._log("hub.close error:", errMessage(e)); }
  }

  /** 購読可能な topic 一覧 (framing が事前検証に使う。registry.SUBSCRIBABLE_TOPICS が単一定義)。 */
  get topics() { return SUBSCRIBABLE_TOPICS; }

  /** テスト/イントロスペクション用。 */
  get registry() { return this._registry; }
  get openrpc() { return this._openrpc; }
}
