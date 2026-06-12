export class Daemon {
    /**
     * @param {{ hub: HubLike, version?: string, debug?: boolean }} args
     *   hub は SesameHub3 (テストでは狭いインターフェースの fake)。
     */
    constructor({ hub, version, debug }: {
        hub: HubLike;
        version?: string;
        debug?: boolean;
    });
    /** @type {HubLike} */
    hub: HubLike;
    version: string;
    /** @type {"ok"|"degraded"|"expired"} */
    authState: "ok" | "degraded" | "expired";
    openRpcDocument(): Record<string, unknown>;
    start(): void;
    /** @param {Connection} conn */
    addConnection(conn: Connection): void;
    /** @param {Connection} conn */
    removeConnection(conn: Connection): void;
    /**
     * 1 メッセージを処理して応答オブジェクト (通知なら null) を返す。push はしない (HTTP POST 用)。
     * @param {Connection} conn
     * @param {string} raw
     * @returns {Promise<import("../jsonrpc.js").RpcResponse|null>}
     */
    dispatchMessage(conn: Connection, raw: string): Promise<import("../jsonrpc.js").RpcResponse | null>;
    /**
     * framing から: 1 行を処理し、応答があれば conn.send で push する。throw しない。
     * @param {Connection} conn
     * @param {string} raw
     */
    handleLine(conn: Connection, raw: string): Promise<void>;
    /**
     * メソッド実行。registry 解決 + rpc.discover + メソッド名単位の直列化。常に Promise を返す。
     * @param {string} method
     * @param {unknown} params
     * @param {Connection} [conn]
     * @returns {Promise<unknown>}
     */
    invoke(method: string, params: unknown, conn?: Connection): Promise<unknown>;
    /**
     * 同名メソッドを直列化する。これは応答入替の主防御ではなく (request() ベースの op は
     * transport の (action:op) FIFO が保証する) **listDevices 等 onMessage 先着 resolve で
     * 解決する op** を、複数クライアント同時呼び出しから守る防御。同名 op を 1 並行に絞る。
     */
    /**
     * @param {Connection|undefined} conn
     * @param {string[]} topics
     * @returns {{ subscribed: string[] }}
     */
    subscribe(conn: Connection | undefined, topics: string[]): {
        subscribed: string[];
    };
    /**
     * @param {Connection|undefined} conn
     * @param {string[]} topics
     * @returns {{ subscribed: string[] }}
     */
    unsubscribe(conn: Connection | undefined, topics: string[]): {
        subscribed: string[];
    };
    /**
     * 状態 push を購読 Connection へ配信する。
     * 注: lockState と deviceUpdate は現状どちらも biz3 の pubDeviceStateChange を源とする
     * (同一ストリームの別ラベル)。両方購読している接続には **1 回だけ** 配信する
     * (最初に購読している topic のラベルで) — 同一イベントの二重配信を避ける。
     * deviceListChanged は別ストリーム (pubUserDeviceChange) なのでここでは配信しない
     * (_fanoutTopic 経由)。
     */
    /** 冪等。受付停止 → hub.close()(=_pendingCleanups 実行) → 解決。 */
    shutdown(): Promise<void>;
    /** 購読可能な topic 一覧 (framing が事前検証に使う。registry.SUBSCRIBABLE_TOPICS が単一定義)。 */
    get topics(): readonly string[];
    /** テスト/イントロスペクション用。 */
    get registry(): Map<string, import("./registry.js").MethodEntry>;
    get openrpc(): Record<string, unknown>;
}
/**
 * フレーミングが実装する接続契約。Daemon は send/close と分類フラグだけに依存する
 * (transport 固有の直列化・背圧は framing 側の責務)。
 */
export type Connection = {
    id?: string | undefined;
    /**
     * フレーミング固有の直列化 + 背圧
     */
    send: (obj: unknown) => void;
    /**
     * 接続を閉じる (framing 固有のリソース解放)
     */
    close: () => void;
    /**
     * HTTP POST /rpc・gRPC unary など 1 往復で閉じる接続
     */
    ephemeral?: boolean | undefined;
};
/**
 * 常駐 hub。SesameHub3 本体、もしくはテストの狭い fake。Daemon が実際に触る面だけを
 * 構造的に要求する (テスト fake を許容しつつ未定義メソッド呼び出しを型で防ぐ)。
 * 名前空間 dispatch (hub[ns][op]) は registry 側で行うため、ここでは index signature を足す。
 */
export type HubLike = {
    connected: boolean;
    subUUID?: string | null | undefined;
    connect: () => Promise<void>;
    close: () => Promise<void>;
    onReconnect?: ((cb: () => void) => void) | undefined;
    /**
     * 実 companyID/subUUID を config へ反映 (SURF-09)
     */
    refreshAccount?: (() => Promise<unknown>) | undefined;
    onDeviceUpdate: (items: Array<{
        deviceUUID: unknown;
        deviceModel: unknown;
    }>, cb: (msg: unknown) => void) => (() => void);
    onUserDeviceChange?: ((cb: (msg: unknown) => void) => (() => void)) | undefined;
    tokenStore?: import("../tokens.js").TokenStore | undefined;
    config?: {
        devices?: Record<string, {
            deviceUUID: unknown;
            deviceModel: unknown;
        }>;
        registerBaseUrl?: string | null;
    } | undefined;
};
//# sourceMappingURL=daemon.d.ts.map