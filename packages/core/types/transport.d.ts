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
export function sendIR(client: Hub3WsClient, params: {
    deviceId?: string;
    irDeviceUUID?: string;
    irType: number;
    command: string;
    operation: "learnEmit" | "remoteEmit";
    companyID?: string;
}): Promise<import("./transport.js").WsMessage>;
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
export function getIRCodes(client: Hub3WsClient, params: {
    deviceId?: string;
    irDeviceUUID?: string;
    companyID?: string;
}): Promise<Array<{
    name: string;
    keyUUID: string;
}>>;
export const TRANSPORT_ERR: Readonly<{
    TIMEOUT: "TRANSPORT_TIMEOUT";
    CLOSED: "TRANSPORT_CLOSED";
}>;
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
    constructor(cfg: Hub3WsClientConfig);
    cfg: {
        /**
         * 接続先 WS URL
         */
        wsUrl: string;
        /**
         * Cognito idToken (?token= で渡す)
         */
        idToken: string;
        /**
         * UI 言語 (?lang=)
         */
        lang: string;
        /**
         * デバッグログ出力 (default false)
         */
        debug: boolean;
        /**
         * 切断時に自動再接続するか (default true)
         */
        autoReconnect: boolean;
        /**
         * retry が MAX_RETRIES_BEFORE_TOKEN_CHECK に達した時に呼ばれる。新 token を返すと
         * idToken を差し替えて retryCount をリセットして再接続継続。null を返すと諦めず
         * exponential backoff を続行 (token は古いまま)。
         */
        onTokenRefreshNeeded?: ((oldToken: string) => Promise<string | null>) | undefined;
        /**
         * 再接続 (初回以外の OPEN) で呼ばれる
         */
        onReopen?: (() => void) | null | undefined;
    };
    idToken: string;
    onTokenRefreshNeeded: ((oldToken: string) => Promise<string | null>) | null;
    onReopen: (() => void) | null;
    /** @type {WebSocket | null} */
    ws: WebSocket | null;
    /** @type {WsStatus} */
    status: WsStatus;
    /** @type {Map<string, ((msg: WsMessage|CodedError)=>void)[]>} action+op → FIFO の resolver 配列 */
    pending: Map<string, ((msg: WsMessage | CodedError) => void)[]>;
    /** @type {((msg: WsMessage)=>void)[]} 任意メッセージのリスナ */
    listeners: ((msg: WsMessage) => void)[];
    /** @type {Map<string, Set<(msg: WsMessage)=>void>>} action+op → 永続購読 fn 集合 (biz3 の pub* 系イベント受信用) */
    subscribers: Map<string, Set<(msg: WsMessage) => void>>;
    /** @type {Array<{payload: unknown, enqueuedAt: number}>} 未接続中の送信をバッファ */
    messageQueue: Array<{
        payload: unknown;
        enqueuedAt: number;
    }>;
    retryCount: number;
    closedByUser: boolean;
    lastActiveTime: number;
    lastTickTime: number;
    /** @type {ReturnType<typeof setInterval> | null} */
    keepaliveTimer: ReturnType<typeof setInterval> | null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    pongTimer: ReturnType<typeof setTimeout> | null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    connectTimer: ReturnType<typeof setTimeout> | null;
    /** @type {ReturnType<typeof setTimeout> | null} */
    reconnectTimer: ReturnType<typeof setTimeout> | null;
    /** @type {ReturnType<typeof setInterval> | null} */
    sleepDetectorTimer: ReturnType<typeof setInterval> | null;
    /** @param {...unknown} args */
    log(...args: unknown[]): void;
    /**
     * WS 接続を確立。失敗時は reject。成功後の切断は auto-reconnect される。
     */
    connect(): Promise<void>;
    /** 明示的にクローズ。auto-reconnect は抑止される。 */
    close(): void;
    /**
     * リクエスト送信。応答 (action+op 一致) を1個待つ。FIFO。
     * 未接続中は messageQueue に積まれ、接続復帰後 flush される。
     * @param {WsFrame} payload
     * @param {number} [timeoutMs]
     * @returns {Promise<WsMessage>}
     */
    request(payload: WsFrame, timeoutMs?: number): Promise<WsMessage>;
    /**
     * 応答を期待しない fire-and-forget 送信。
     * @param {WsFrame} payload
     */
    send(payload: WsFrame): void;
    /**
     * 任意の受信メッセージを購読する。
     * @param {(msg: WsMessage)=>void} fn
     * @returns {()=>void} unsubscribe
     */
    onMessage(fn: (msg: WsMessage) => void): () => void;
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
    getStatus(): WsStatus;
}
/**
 * `.code` 付きの Error。serve daemon が code で kind を分類する。
 */
export type CodedError = Error & {
    code?: string;
};
/**
 * WS 接続状態。
 */
export type WsStatus = "disconnected" | "connecting" | "open" | "closing";
/**
 * サーバから受信する WS メッセージ (JSON parse 後)。op ごとに `data` 等が付く。
 */
export type WsMessage = {
    action?: string;
    op?: string;
    success?: boolean;
    message?: string;
    data?: unknown;
} & Record<string, unknown>;
/**
 * 送信フレーム。最低限 action を持ち、op その他は呼び出し側が付与する。
 */
export type WsFrame = {
    action: string;
    op?: string;
} & Record<string, unknown>;
/**
 * Hub3WsClient のコンストラクタ設定。
 */
export type Hub3WsClientConfig = {
    /**
     * 接続先 WS URL
     */
    wsUrl: string;
    /**
     * Cognito idToken (?token= で渡す)
     */
    idToken: string;
    /**
     * UI 言語 (?lang=)
     */
    lang?: string | undefined;
    /**
     * デバッグログ出力 (default false)
     */
    debug?: boolean | undefined;
    /**
     * 切断時に自動再接続するか (default true)
     */
    autoReconnect?: boolean | undefined;
    /**
     * retry が MAX_RETRIES_BEFORE_TOKEN_CHECK に達した時に呼ばれる。新 token を返すと
     * idToken を差し替えて retryCount をリセットして再接続継続。null を返すと諦めず
     * exponential backoff を続行 (token は古いまま)。
     */
    onTokenRefreshNeeded?: ((oldToken: string) => Promise<string | null>) | undefined;
    /**
     * 再接続 (初回以外の OPEN) で呼ばれる
     */
    onReopen?: (() => void) | null | undefined;
};
import WebSocket from "ws";
//# sourceMappingURL=transport.d.ts.map