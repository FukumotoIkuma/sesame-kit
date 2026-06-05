/**
 * SESAME Hub3 から IR を発射する。
 *
 * @param {Hub3WsClient} client
 * @param {{
 *   deviceId: string,         // Hub3 UUID (大文字)
 *   irDeviceUUID: string,     // remote.uuid
 *   irType: number,           // remote.type (例: 49152)
 *   command: string,          // 自己学習なら keyUUID、プリセットなら 16byte hex
 *   operation: "learnEmit"|"remoteEmit",
 *   companyID: string,
 * }} params
 */
export function sendIR(client: Hub3WsClient, params: {
    deviceId: string;
    irDeviceUUID: string;
    irType: number;
    command: string;
    operation: "learnEmit" | "remoteEmit";
    companyID: string;
}): Promise<any>;
/**
 * 指定 IR デバイス (リモコン) の登録キー一覧を取得。
 *
 * 注: このエンドポイントだけ Hub3 UUID のフィールド名が `deviceId` ではなく
 *     `hub3DeviceId`。これは公式 biz3 の意図的な命名差 (useRemoteCtrl.js:820-826)。
 *
 * @param {Hub3WsClient} client
 * @param {{deviceId:string, irDeviceUUID:string, companyID:string}} params
 */
export function getIRCodes(client: Hub3WsClient, params: {
    deviceId: string;
    irDeviceUUID: string;
    companyID: string;
}): Promise<any>;
export const TRANSPORT_ERR: Readonly<{
    TIMEOUT: "TRANSPORT_TIMEOUT";
    CLOSED: "TRANSPORT_CLOSED";
}>;
export class Hub3WsClient {
    /**
     * @param {{
     *   wsUrl: string,
     *   idToken: string,
     *   lang?: string,
     *   debug?: boolean,
     *   autoReconnect?: boolean,              // default true
     *   onTokenRefreshNeeded?: (oldToken: string) => Promise<string|null>,
     *     // retry が MAX_RETRIES_BEFORE_TOKEN_CHECK に達した時に呼ばれる。
     *     // 新 token を返すと idToken を差し替えて retryCount をリセットして再接続継続。
     *     // null を返すと諦めず exponential backoff を続行 (token は古いまま)。
     * }} cfg
     */
    constructor(cfg: any);
    cfg: any;
    idToken: any;
    onTokenRefreshNeeded: any;
    onReopen: any;
    _everConnected: boolean;
    /** @type {import("ws").WebSocket | null} */
    ws: any | null;
    status: "disconnected";
    /** @type {Map<string, ((msg:any|Error)=>void)[]>} action+op → FIFO の resolver 配列 */
    pending: Map<string, ((msg: any | Error) => void)[]>;
    /** @type {((msg:any)=>void)[]} 任意メッセージのリスナ */
    listeners: ((msg: any) => void)[];
    /** @type {Map<string, Set<(msg:any)=>void>>} action+op → 永続購読 fn 集合 (biz3 の pub* 系イベント受信用) */
    subscribers: Map<string, Set<(msg: any) => void>>;
    /** @type {any[]} 未接続中の送信をバッファ */
    messageQueue: any[];
    retryCount: number;
    closedByUser: boolean;
    lastActiveTime: number;
    lastTickTime: number;
    _refreshedThisCycle: boolean;
    keepaliveTimer: NodeJS.Timeout;
    pongTimer: NodeJS.Timeout;
    connectTimer: any;
    reconnectTimer: any;
    sleepDetectorTimer: NodeJS.Timeout;
    _connectPromise: Promise<any>;
    _initialConnectResolve: (value: any) => void;
    _initialConnectReject: (reason?: any) => void;
    log(...args: any[]): void;
    /**
     * WS 接続を確立。失敗時は reject。成功後の切断は auto-reconnect される。
     */
    connect(): Promise<any>;
    /** 明示的にクローズ。auto-reconnect は抑止される。 */
    close(): void;
    /**
     * リクエスト送信。応答 (action+op 一致) を1個待つ。FIFO。
     * 未接続中は messageQueue に積まれ、接続復帰後 flush される。
     */
    request(payload: any, timeoutMs?: number): Promise<any>;
    /** 応答を期待しない fire-and-forget 送信。 */
    send(payload: any): void;
    onMessage(fn: any): () => void;
    /**
     * 特定 action+op の永続購読。biz3 の `pubDeviceStateChange` などの async push を受ける。
     *
     * @param {string} key `"<action>:<op>"` 形式。op が無い場合は `"<action>:"`
     * @param {(msg:any)=>void} fn
     * @returns {()=>void} unsubscribe
     */
    subscribe(key: string, fn: (msg: any) => void): () => void;
    /**
     * keepalive 1往復で接続を実検証する。timeout で reject。
     * 注: biz3 の keepalive ack は `success` ではなく `connectionId` を返す
     * (WebSocketManager.ts:72-83)。なので応答が**届いたこと自体**を生存判定とし、
     * success フィールドの有無には依存しない (旧実装は !!resp.success で常に false の恐れ)。
     */
    ping(timeoutMs?: number): Promise<boolean>;
    /** 接続状態 (デバッグ・テスト用)。 */
    getStatus(): "disconnected";
    _initWebSocket(): void;
    _onOpen(): void;
    _onClose(code: any, reason: any): void;
    _onError(err: any): void;
    /** 受動的再接続 (close を契機)。exponential backoff。 */
    _handleReconnect(): void;
    /** 能動的再接続 (pong timeout / sleep wake / idle 検知)。delay なし。 */
    _reconnect(): void;
    _onMessage(raw: any): void;
    _registerPending(key: any, resolver: any): void;
    _unregisterPending(key: any, resolver: any): void;
    _rejectAllPending(err: any): void;
    _sendOrQueue(payload: any): void;
    _flushMessageQueue(): void;
    _startKeepalive(): void;
    _triggerHeartbeatCheck(): void;
    _clearKeepalive(): void;
    _startSleepDetector(): void;
    _stopSleepDetector(): void;
    _wakeUpConnection(): void;
    _clearAllTimers(): void;
}
//# sourceMappingURL=transport.d.ts.map