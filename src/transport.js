// SESAME Hub3 Biz cloud WebSocket client.
//
// Ported from biz3 (CANDY-HOUSE/biz3, MIT):
//   - vendor reference: references_web/src/websocket/WebSocketManager.ts
//   - vendor reference: references_web/src/hooks/useCallbacks.js
//   - vendor reference: references_web/src/api/useRemoteCtrl.js (sendIR / getIRCodes frame)
//   - vendor reference: references_web/src/constants/messageConstants.js (timing constants)
//
// 認証は Cognito idToken を URL クエリパラメータ ?token= で渡す。
// 公式 Web (biz3) と挙動を揃えるため、以下を実装している:
//   - exponential backoff auto-reconnect (1s → 10s)
//   - keepalive (60s) + pong timeout (3s) → 半開接続検知で active reconnect
//   - retry 3 回失敗で token refresh callback を呼ぶ
//   - 未接続中 send は messageQueue にバッファし OPEN 復帰時に flush
//   - sleep/wake 検知 (setInterval の skew で host suspend を検出)
//   - idle 検知 (1.5 × heartbeat 以上アイドルなら再接続)
//   - 同 (action, op) の並行 request を FIFO で正しく解決
//     (biz3 の useCallbacks は同一 op の全 callback に同じ response を流すバグがあるが、
//      こちらは FIFO で意味的に正しい)
//   - 再接続 queue は同一 action のメッセージを 1 通に圧縮**しない** (意図的逸脱:
//     WebSocketManager.ts:373-381 は queue 内の同一 action を上書きするが、action は
//     同じでも op/payload が異なる request を握り潰すため、こちらは全件保持し
//     QUEUE_ENTRY_MAX_AGE_MS の鮮度切りだけ行う)

// 型は devDependencies の @types/ws が提供する (REFACTORING_PLAN P5-7/ARCH-15:
// 旧 @ts-expect-error + 自前 WsLike 最小 typedef を正式型へ置き換え)。
import WebSocket from "ws";
import { ACTION_TYPES } from "../vendor/biz3/constants/messageConstants.js";
import { t } from "./i18n.js";
import { rejected } from "./util.js";

/**
 * WS 接続状態。
 * @typedef {"disconnected"|"connecting"|"open"|"closing"} WsStatus
 */

/**
 * サーバから受信する WS メッセージ (JSON parse 後)。op ごとに `data` 等が付く。
 * @typedef {{ action?: string, op?: string, success?: boolean, message?: string, data?: unknown }
 *   & Record<string, unknown>} WsMessage
 */

/**
 * 送信フレーム。最低限 action を持ち、op その他は呼び出し側が付与する。
 * @typedef {{ action: string, op?: string } & Record<string, unknown>} WsFrame
 */

const STATUS = Object.freeze({
  DISCONNECTED: "disconnected",
  CONNECTING: "connecting",
  OPEN: "open",
  CLOSING: "closing",
});

// 公式 messageConstants.js と同値
const KEEPALIVE_INTERVAL_MS = 60_000;
const PONG_TIMEOUT_MS = 3_000;
const CONNECT_TIMEOUT_MS = 5_000;
const MIN_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 10_000;
const RECONNECT_BACKOFF_BASE = 1.5;
const MAX_RETRIES_BEFORE_TOKEN_CHECK = 3;
const SLEEP_CHECK_INTERVAL_MS = 2_000;
const SLEEP_THRESHOLD_MS = 5_000;
const IDLE_TIME_MULTIPLIER = 1.5;
// queue に積んだ payload が古くなり過ぎたら破棄 (lock の sign 期限は 256s)
const QUEUE_ENTRY_MAX_AGE_MS = 60_000;

const KEEPALIVE_ACTION = ACTION_TYPES.BIZ3_KEEP_ALIVE; // "biz3KeepAlive" (vendor 由来)

// transport が投げるエラーの分類コード (.code)。serve の daemon が文字列正規表現でなく
// これで kind (timeout/connection_lost) を決定する (跨モジュールの暗黙文字列契約を排除)。
export const TRANSPORT_ERR = Object.freeze({ TIMEOUT: "TRANSPORT_TIMEOUT", CLOSED: "TRANSPORT_CLOSED" });
/**
 * `.code` 付きの Error。serve daemon が code で kind を分類する。
 * @typedef {Error & { code?: string }} CodedError
 */
/** @param {string} msg @returns {CodedError} */
function timeoutErr(msg) { const e = /** @type {CodedError} */ (new Error(msg)); e.code = TRANSPORT_ERR.TIMEOUT; return e; }
/** @param {string} msg @returns {CodedError} */
function closedErr(msg) { const e = /** @type {CodedError} */ (new Error(msg)); e.code = TRANSPORT_ERR.CLOSED; return e; }

/**
 * catch 節の unknown から message 文字列を取り出し、改行 (CR/LF) を除去して返す。
 * 改行除去はログインジェクション (偽ログ行の差し込み) 対策の sanitizer を兼ねる
 * (error message はネットワーク/上流由来でありうるため)。
 * @param {unknown} e
 * @returns {string}
 */
function asErrMsg(e) {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/\n|\r/g, "");
}

// debug ログに乗せる payload から資格情報フィールドを伏せる (debug 限定だが、apiKeyId /
// token / 鍵素材が平文でログに残らないようにする — clear-text-logging 対策)。
const SENSITIVE_LOG_KEYS = new Set([
  "apiKeyId", "token", "idToken", "accessToken", "refreshToken",
  "secretKey", "sk", "password", "devicePassword", "sign", "history", "secret",
]);

/**
 * payload を JSON 文字列化する際に資格情報フィールドを "***" に伏せ、CR/LF も除去する。
 * @param {unknown} payload
 * @returns {string}
 */
function redactPayloadForLog(payload) {
  try {
    // 走査と直列化を JSON.stringify に委ね、replacer は「値を返すだけ」にする。
    // 手書き再帰で out[k]=… と動的キー代入すると、payload 由来のキー (__proto__ 等) で
    // out の prototype を汚染し得る (remote-property-injection)。replacer 方式なら
    // 動的書き込みのシンク自体が無く、伏字も同時に行える。
    return JSON.stringify(payload, (key, value) =>
      (SENSITIVE_LOG_KEYS.has(key) ? "***" : value),
    ).replace(/\n|\r/g, "");
  } catch {
    return "[unserializable payload]"; // 循環参照等
  }
}

/**
 * Hub3WsClient のコンストラクタ設定。
 * @typedef {object} Hub3WsClientConfig
 * @property {string} wsUrl 接続先 WS URL
 * @property {string} idToken Cognito idToken (?token= で渡す)
 * @property {string} [lang] UI 言語 (?lang=)
 * @property {boolean} [debug] デバッグログ出力 (default false)
 * @property {boolean} [autoReconnect] 切断時に自動再接続するか (default true)
 * @property {(oldToken: string) => Promise<string|null>} [onTokenRefreshNeeded]
 *   retry が MAX_RETRIES_BEFORE_TOKEN_CHECK に達した時に呼ばれる。新 token を返すと
 *   idToken を差し替えて retryCount をリセットして再接続継続。null を返すと諦めず
 *   exponential backoff を続行 (token は古いまま)。
 * @property {(() => void) | null} [onReopen] 再接続 (初回以外の OPEN) で呼ばれる
 */

export class Hub3WsClient {
  /**
   * @param {Hub3WsClientConfig} cfg
   */
  constructor(cfg) {
    // P5-1 方針3: コンストラクタ必須引数の欠落 (プログラマエラー)。serve 非到達 (構築前)。
    if (!cfg.wsUrl) throw new Error(t("domain.transport.wsUrlRequired"));
    if (!cfg.idToken) throw new Error(t("domain.transport.idTokenRequired"));
    this.cfg = { lang: "ja", debug: false, autoReconnect: true, ...cfg };
    this.idToken = cfg.idToken;
    this.onTokenRefreshNeeded = cfg.onTokenRefreshNeeded || null;
    // 再接続 (初回以外の OPEN) で呼ばれる。サーバへ subscribe frame を再送したい購読者用。
    // 初回 OPEN では呼ばれない (初回購読は通常の API 経由で張られるため)。
    this.onReopen = cfg.onReopen || null;
    this._everConnected = false;

    /** @type {WebSocket | null} */
    this.ws = null;
    /** @type {WsStatus} */
    this.status = STATUS.DISCONNECTED;

    /** @type {Map<string, ((msg: WsMessage|CodedError)=>void)[]>} action+op → FIFO の resolver 配列 */
    this.pending = new Map();
    /** @type {((msg: WsMessage)=>void)[]} 任意メッセージのリスナ */
    this.listeners = [];
    /** @type {Map<string, Set<(msg: WsMessage)=>void>>} action+op → 永続購読 fn 集合 (biz3 の pub* 系イベント受信用) */
    this.subscribers = new Map();
    /** @type {Array<{payload: unknown, enqueuedAt: number}>} 未接続中の送信をバッファ */
    this.messageQueue = [];

    this.retryCount = 0;
    this.closedByUser = false;
    this.lastActiveTime = Date.now();
    this.lastTickTime = Date.now();
    this._refreshedThisCycle = false; // 1 接続サイクルに 1 回まで token refresh (Review C-3)

    // timers
    /** @type {ReturnType<typeof setInterval> | null} */
    this.keepaliveTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.pongTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.connectTimer = null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.reconnectTimer = null;
    /** @type {ReturnType<typeof setInterval> | null} */
    this.sleepDetectorTimer = null;

    // 初回 connect() の promise/resolver (Review C-2)
    /** @type {Promise<void> | null} */
    this._connectPromise = null;
    /** @type {(() => void) | null} */
    this._initialConnectResolve = null;
    /** @type {((reason?: unknown) => void) | null} */
    this._initialConnectReject = null;
  }

  /** @param {...unknown} args */
  log(...args) {
    if (this.cfg.debug) console.error("[hub3]", ...args);
  }

  // ---------- public API ----------

  /**
   * WS 接続を確立。失敗時は reject。成功後の切断は auto-reconnect される。
   */
  async connect() {
    if (this.status === STATUS.OPEN) return;
    // 既に接続中なら同じ promise を返す (Review C-2: 二重上書き防止)
    if (this._connectPromise) return this._connectPromise;

    this.closedByUser = false;
    this.retryCount = 0;
    this._refreshedThisCycle = false;
    this._startSleepDetector();

    this._connectPromise = new Promise(/** @param {() => void} resolve */ (resolve, reject) => {
      this._initialConnectResolve = resolve;
      this._initialConnectReject = reject;
      this._initWebSocket();
    });
    try {
      await this._connectPromise;
    } finally {
      this._connectPromise = null;
    }
  }

  /** 明示的にクローズ。auto-reconnect は抑止される。 */
  close() {
    this.closedByUser = true;
    this.status = STATUS.CLOSING;
    this._clearAllTimers();
    this._stopSleepDetector();
    if (this.ws) {
      try {
        this.ws.removeAllListeners("close");
        this.ws.removeAllListeners("error");
        this.ws.close();
      } catch { /* ignore */ }
    }
    this.ws = null;
    this.status = STATUS.DISCONNECTED;
    this._rejectAllPending(closedErr(t("domain.transport.closedByUser")));
    this.messageQueue = [];
    // 初回 connect() 中だった場合は明示的に reject (Review C-2: leak 防止)
    if (this._initialConnectReject) {
      const rej = this._initialConnectReject;
      this._initialConnectResolve = null;
      this._initialConnectReject = null;
      try { rej(closedErr(t("domain.transport.closedBeforeInitial"))); } catch { /* ignore */ }
    }
    // _connectPromise も null 化 (2nd-pass C-2: rejected promise が次回 connect() で
    // 再利用される race を防ぐ)。
    this._connectPromise = null;
    this.subscribers.clear(); // 全 subscriber も解除 (Review L-6)
  }

  /**
   * リクエスト送信。応答 (action+op 一致) を1個待つ。FIFO。
   * 未接続中は messageQueue に積まれ、接続復帰後 flush される。
   * @param {WsFrame} payload
   * @param {number} [timeoutMs]
   * @returns {Promise<WsMessage>}
   */
  request(payload, timeoutMs = 10_000) {
    const key = `${payload.action}:${payload.op || ""}`;
    return new Promise((resolve, reject) => {
      /** @param {WsMessage|CodedError} msg */
      const resolver = (msg) => {
        clearTimeout(to);
        if (msg instanceof Error) reject(msg);
        else resolve(msg);
      };
      const to = setTimeout(() => {
        this._unregisterPending(key, resolver);
        reject(timeoutErr(t("domain.transport.requestTimeout", { key })));
      }, timeoutMs);
      this._registerPending(key, resolver);
      this._sendOrQueue(payload);
    });
  }

  /**
   * 応答を期待しない fire-and-forget 送信。
   * @param {WsFrame} payload
   */
  send(payload) {
    this._sendOrQueue(payload);
  }

  /**
   * 任意の受信メッセージを購読する。
   * @param {(msg: WsMessage)=>void} fn
   * @returns {()=>void} unsubscribe
   */
  onMessage(fn) {
    this.listeners.push(fn);
    // unsubscribe を返す (Review L-6: 長時間プロセスの leak 防止)
    return () => {
      const i = this.listeners.indexOf(fn);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /**
   * 特定 action+op の永続購読。biz3 の `pubDeviceStateChange` などの async push を受ける。
   *
   * @param {string} key `"<action>:<op>"` 形式。op が無い場合は `"<action>:"`
   * @param {(msg:any)=>void} fn
   * @returns {()=>void} unsubscribe
   */
  subscribe(key, fn) {
    let set = this.subscribers.get(key);
    if (!set) { set = new Set(); this.subscribers.set(key, set); }
    set.add(fn);
    return () => {
      const s = this.subscribers.get(key);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) this.subscribers.delete(key);
    };
  }

  /**
   * keepalive 1往復で接続を実検証する。timeout で reject。
   * 注: biz3 の keepalive ack は `success` ではなく `connectionId` を返す
   * (WebSocketManager.ts:72-83)。なので応答が**届いたこと自体**を生存判定とし、
   * success フィールドの有無には依存しない (旧実装は !!resp.success で常に false の恐れ)。
   */
  async ping(timeoutMs = PONG_TIMEOUT_MS) {
    const resp = await this.request({ action: KEEPALIVE_ACTION }, timeoutMs);
    return !!resp; // 応答受信 = 生存。request は timeout で reject する。
  }

  /** 接続状態 (デバッグ・テスト用)。 */
  getStatus() {
    return this.status;
  }

  // ---------- internal: WS lifecycle ----------

  _initWebSocket() {
    this.status = STATUS.CONNECTING;
    // URL は new URL() で構築・検証する (生文字列連結を避け、scheme を ws/wss に限定)。
    // これにより不正な wsUrl を接続前に弾き、token/lang のエンコードも URL API に委ねる。
    const wsBase = new URL(this.cfg.wsUrl);
    if (wsBase.protocol !== "wss:" && wsBase.protocol !== "ws:") {
      // P5-1 方針3: wsUrl のプロトコルが不正 (プログラマエラー / 内部不変条件)。
      throw new Error(t("domain.transport.wsUrlRequired"));
    }
    wsBase.searchParams.set("token", this.idToken);
    wsBase.searchParams.set("lang", this.cfg.lang);
    const url = wsBase.href;
    this.log("connecting", this.cfg.wsUrl);

    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch { /* ignore */ }
      this.ws = null;
    }

    const ws = new WebSocket(url);
    this.ws = ws;

    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (this.ws && this.status !== STATUS.OPEN) {
        this.log("connect timeout — closing");
        try { this.ws.close(); } catch { /* ignore */ }
      }
    }, CONNECT_TIMEOUT_MS);

    ws.once("open", () => this._onOpen());
    ws.on("message", (/** @type {Buffer|string} */ raw) => this._onMessage(raw));
    ws.on("close", (/** @type {number} */ code, /** @type {Buffer} */ reason) => this._onClose(code, reason));
    ws.on("error", (/** @type {Error} */ err) => this._onError(err));
  }

  _onOpen() {
    const isReconnect = this._everConnected;
    this._everConnected = true;
    this.status = STATUS.OPEN;
    this.log("connected");
    if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
    this.retryCount = 0;
    this._refreshedThisCycle = false; // 接続成功で token refresh 履歴をリセット (Review C-3)
    this.lastActiveTime = Date.now();
    this._startKeepalive();
    this._flushMessageQueue();

    if (this._initialConnectResolve) {
      const r = this._initialConnectResolve;
      this._initialConnectResolve = null;
      this._initialConnectReject = null;
      r();
    }

    // 再接続時: 購読者は subscribe frame の再送が要る (サーバは新接続を覚えていない)。
    if (isReconnect && this.onReopen) {
      try { this.onReopen(); } catch (e) { this.log("onReopen error", asErrMsg(e)); }
    }
  }

  /**
   * @param {number} code
   * @param {Buffer} [reason]
   */
  _onClose(code, reason) {
    // reason はサーバ由来。改行を除去してログインジェクションを防ぐ (sanitizer は inline)。
    this.log("closed", code, (reason ? reason.toString() : "").replace(/\n|\r/g, ""));
    this._clearKeepalive();
    if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
    const wasOpen = this.status === STATUS.OPEN;
    this.status = STATUS.DISCONNECTED;
    this.ws = null;

    // 接続中の pending を全部 reject (応答先 ws が消えたため)
    this._rejectAllPending(closedErr(t("domain.transport.closed")));

    if (this.closedByUser) return;

    // 初回 connect 中の close → connect() を reject、以降 send が積み続けないよう
    // closedByUser=true 相当の振る舞いにする (Review M-7)
    if (!wasOpen && this._initialConnectReject) {
      const rej = this._initialConnectReject;
      this._initialConnectResolve = null;
      this._initialConnectReject = null;
      this.closedByUser = true;
      this.messageQueue = [];
      rej(closedErr(t("domain.transport.closedBeforeOpen", { code })));
      return;
    }

    if (this.cfg.autoReconnect) {
      this._handleReconnect();
    }
  }

  /** @param {Error} err */
  _onError(err) {
    this.log("error", String(err?.message || err).replace(/\n|\r/g, "")); // err はネットワーク由来
    // error 直後に close も来るので、reconnect 判断は close 側で行う
  }

  // ---------- internal: reconnect ----------

  /** 受動的再接続 (close を契機)。exponential backoff。 */
  _handleReconnect() {
    if (this.closedByUser) return;
    if (this.reconnectTimer) return; // 既にスケジュール済み
    if (this.ws && this.status === STATUS.CONNECTING) return;

    const delay = Math.min(
      MIN_RECONNECT_DELAY_MS * RECONNECT_BACKOFF_BASE ** this.retryCount,
      MAX_RECONNECT_DELAY_MS,
    );
    this.log(`reconnect scheduled (attempt ${this.retryCount + 1}, delay=${Math.floor(delay)}ms)`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.retryCount++;
      // 1 connect サイクルに 1 回だけ token refresh を試す (Review C-3: 無限ループ防止)
      if (
        this.retryCount === MAX_RETRIES_BEFORE_TOKEN_CHECK
        && this.onTokenRefreshNeeded
        && !this._refreshedThisCycle
      ) {
        this._refreshedThisCycle = true;
        this.log("retry threshold reached — requesting token refresh");
        try {
          const fresh = await this.onTokenRefreshNeeded(this.idToken);
          if (fresh && fresh !== this.idToken) {
            this.idToken = fresh;
            this.retryCount = 0;
            this.log("token refreshed");
          } else {
            this.log("token refresh returned no new token — continuing backoff");
          }
        } catch (e) {
          this.log("token refresh callback threw:", asErrMsg(e));
        }
      }
      this._initWebSocket();
    }, delay);
  }

  /** 能動的再接続 (pong timeout / sleep wake / idle 検知)。delay なし。 */
  _reconnect() {
    if (this.closedByUser) return;
    this.log("active reconnect");
    this._clearAllTimers();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch { /* ignore */ }
      this.ws = null;
    }
    this.status = STATUS.DISCONNECTED;
    this.retryCount = 0;
    // 能動再接続後の新サイクルでも token refresh が動くようリセット (2nd-pass C-3)
    this._refreshedThisCycle = false;
    this._initWebSocket();
  }

  // ---------- internal: message routing ----------

  /** @param {Buffer|string} raw */
  _onMessage(raw) {
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    /** @type {WsMessage} */
    let msg;
    try { msg = JSON.parse(text); }
    catch {
      // text はサーバ由来。改行除去でログインジェクションを防ぐ (sanitizer は inline)。
      this.log("non-JSON message:", text.slice(0, 200).replace(/\n|\r/g, ""));
      return;
    }
    this.log("recv:", redactPayloadForLog(msg).slice(0, 200)); // サーバ応答も資格情報を伏せる
    this.lastActiveTime = Date.now();

    // keepalive ack: success フィールド有無問わず pong timer をクリア (Review H-1:
    // サーバが success 無しで返した場合でも正常通信として扱う)
    if (msg.action === KEEPALIVE_ACTION) {
      if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
    }

    // FIFO で 1 resolver 解決
    const key = `${msg.action}:${msg.op || ""}`;
    const queue = this.pending.get(key);
    if (queue && queue.length > 0) {
      const resolver = queue.shift();
      if (queue.length === 0) this.pending.delete(key);
      if (resolver) { try { resolver(msg); } catch (e) { this.log("resolver threw:", asErrMsg(e)); } }
    }

    // 永続購読 fan-out。Set を snapshot してから iterate (Review H-6:
    // ハンドラ内で unsub される可能性があるためイテレータ汚染を避ける)
    const subs = this.subscribers.get(key);
    if (subs && subs.size > 0) {
      for (const fn of [...subs]) {
        try { fn(msg); } catch (e) { this.log("subscriber threw:", asErrMsg(e)); }
      }
    }

    for (const l of this.listeners) {
      try { l(msg); } catch (e) { this.log("listener err", asErrMsg(e)); }
    }
  }

  /**
   * @param {string} key
   * @param {(msg: WsMessage|CodedError)=>void} resolver
   */
  _registerPending(key, resolver) {
    let queue = this.pending.get(key);
    if (!queue) { queue = []; this.pending.set(key, queue); }
    queue.push(resolver);
  }

  /**
   * @param {string} key
   * @param {(msg: WsMessage|CodedError)=>void} resolver
   */
  _unregisterPending(key, resolver) {
    const queue = this.pending.get(key);
    if (!queue) return;
    const i = queue.indexOf(resolver);
    if (i >= 0) queue.splice(i, 1);
    if (queue.length === 0) this.pending.delete(key);
  }

  /** @param {CodedError} err */
  _rejectAllPending(err) {
    for (const [, queue] of this.pending) {
      for (const r of queue) {
        try { r(err); } catch { /* ignore */ }
      }
    }
    this.pending.clear();
  }

  // ---------- internal: send / queue ----------

  /** @param {WsFrame} payload */
  _sendOrQueue(payload) {
    if (this.ws && this.status === STATUS.OPEN) {
      this.log("send:", redactPayloadForLog(payload)); // payload は呼び出し側入力 (資格情報は伏せる)
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (e) {
        this.log("send failed, queueing:", asErrMsg(e));
        this.messageQueue.push({ payload, enqueuedAt: Date.now() });
      }
    } else {
      this.log("queued (not open):", redactPayloadForLog(payload));
      this.messageQueue.push({ payload, enqueuedAt: Date.now() });
    }
  }

  _flushMessageQueue() {
    const now = Date.now();
    // 古過ぎる payload を drop (Review H-3: lock の CMAC sign は 256s 粒度なので
    // 60s 超えたら危険。pending の resolver も timeout に任せる)
    let dropped = 0;
    while (this.messageQueue.length > 0 && now - this.messageQueue[0].enqueuedAt > QUEUE_ENTRY_MAX_AGE_MS) {
      this.messageQueue.shift();
      dropped++;
    }
    if (dropped > 0) this.log(`flush: dropped ${dropped} stale queued payload(s)`);
    while (this.messageQueue.length > 0 && this.ws && this.status === STATUS.OPEN) {
      const entry = this.messageQueue.shift();
      if (!entry) break;
      try {
        this.log("flush:", redactPayloadForLog(entry.payload));
        this.ws.send(JSON.stringify(entry.payload));
      } catch (e) {
        this.log("flush failed, re-queueing:", asErrMsg(e));
        this.messageQueue.unshift(entry);
        break;
      }
    }
  }

  // ---------- internal: keepalive + idle ----------

  _startKeepalive() {
    this._clearKeepalive();
    const tick = () => {
      if (!this.ws || this.status !== STATUS.OPEN) return;

      // idle 検知: 1.5 × heartbeat 以上音沙汰なし → 半開接続疑い
      const idle = Date.now() - this.lastActiveTime;
      if (idle > KEEPALIVE_INTERVAL_MS * IDLE_TIME_MULTIPLIER) {
        this.log(`idle ${Math.floor(idle / 1000)}s — reconnecting`);
        this._reconnect();
        return;
      }

      this._triggerHeartbeatCheck();
    };
    this.keepaliveTimer = setInterval(tick, KEEPALIVE_INTERVAL_MS);
    this._triggerHeartbeatCheck(); // 接続直後にも 1 回
  }

  _triggerHeartbeatCheck() {
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
    try {
      // ws が null の場合は元実装同様に TypeError を発生させ、下の catch で握って return する
      // (heartbeat を送れない接続では pongTimer を張らない、という挙動を保つ)。
      const ws = /** @type {WebSocket} */ (this.ws);
      ws.send(JSON.stringify({ action: KEEPALIVE_ACTION }));
    } catch (e) {
      this.log("keepalive send err:", asErrMsg(e));
      return;
    }
    this.pongTimer = setTimeout(() => {
      this.log("pong timeout — active reconnect");
      this._reconnect();
    }, PONG_TIMEOUT_MS);
  }

  _clearKeepalive() {
    if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
  }

  // ---------- internal: sleep detector ----------

  _startSleepDetector() {
    this._stopSleepDetector();
    this.lastTickTime = Date.now();
    this.sleepDetectorTimer = setInterval(() => {
      const now = Date.now();
      const gap = now - this.lastTickTime;
      this.lastTickTime = now;
      if (gap > SLEEP_THRESHOLD_MS) {
        this.log(`sleep/wake detected (gap ${gap}ms) — checking connection`);
        this._wakeUpConnection();
      }
    }, SLEEP_CHECK_INTERVAL_MS);
    this.sleepDetectorTimer.unref?.(); // Node プロセス終了を妨げない
  }

  _stopSleepDetector() {
    if (this.sleepDetectorTimer) { clearInterval(this.sleepDetectorTimer); this.sleepDetectorTimer = null; }
  }

  _wakeUpConnection() {
    if (this.closedByUser) return;
    const idle = Date.now() - this.lastActiveTime;
    if (!this.ws || this.status !== STATUS.OPEN || idle > KEEPALIVE_INTERVAL_MS * IDLE_TIME_MULTIPLIER) {
      this._reconnect();
    } else {
      this._triggerHeartbeatCheck();
    }
  }

  // ---------- internal: misc ----------

  _clearAllTimers() {
    this._clearKeepalive();
    if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }
}

// ---------- protocol helpers ----------
// Ported from biz3 (vendor: references_web/src/api/useRemoteCtrl.js)。
// hook の useCallback 内部のフレーム組み立て部分だけを抽出して plain function 化。

/**
 * SESAME Hub3 から IR を発射する。
 *
 * deviceId / irDeviceUUID / companyID は config 由来で undefined になり得るため optional。
 *
 * @param {Hub3WsClient} client
 * @param {{
 *   deviceId?: string,         // Hub3 UUID (大文字)
 *   irDeviceUUID?: string,     // remote.uuid
 *   irType: number,            // remote.type (例: 49152)
 *   command: string,           // 自己学習なら keyUUID、プリセットなら 16byte hex
 *   operation: "learnEmit"|"remoteEmit",
 *   companyID?: string,
 * }} params
 * @returns {Promise<import("./transport.js").WsMessage>}
 */
export async function sendIR(client, params) {
  const frame = {
    action: ACTION_TYPES.BIZ3_IR_REMOTE,
    op: "sendIR",
    deviceId: params.deviceId,
    command: params.command,
    operation: params.operation,
    irType: params.irType,
    companyID: params.companyID,
    irDeviceUUID: params.irDeviceUUID,
  };
  const resp = await client.request(frame, 10_000);
  if (!resp.success) {
    // P5-1 方針1: サーバが success:false を返した = 上流の明示的拒否 → REJECTED。
    throw rejected(t("domain.transport.sendIRFailed", { detail: resp.message || JSON.stringify(resp) }));
  }
  return resp;
}

/**
 * 指定 IR デバイス (リモコン) の登録キー一覧を取得。
 *
 * 注: このエンドポイントだけ Hub3 UUID のフィールド名が `deviceId` ではなく
 *     `hub3DeviceId`。これは公式 biz3 の意図的な命名差 (useRemoteCtrl.js:820-826)。
 *
 * @param {Hub3WsClient} client
 * @param {{deviceId?:string, irDeviceUUID?:string, companyID?:string}} params
 * @returns {Promise<Array<{name:string, keyUUID:string}>>}
 */
export async function getIRCodes(client, params) {
  const frame = {
    action: ACTION_TYPES.BIZ3_IR_REMOTE,
    op: "getIRCodes",
    hub3DeviceId: params.deviceId,
    remoteId: params.irDeviceUUID,
    companyID: params.companyID,
  };
  const resp = await client.request(frame, 10_000);
  if (!resp.success) {
    // P5-1 方針1: サーバが success:false を返した = 上流の明示的拒否 → REJECTED。
    throw rejected(t("domain.transport.getIRCodesFailed", { detail: resp.message || JSON.stringify(resp) }));
  }
  return /** @type {Array<{name:string, keyUUID:string}>} */ (resp.data || []);
}
