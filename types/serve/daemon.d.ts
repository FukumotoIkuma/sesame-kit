export class Daemon {
    /**
     * @param {{ hub: object, version?: string, debug?: boolean }} args
     *   hub は SesameHub3 (テストでは狭いインターフェースの fake)。
     */
    constructor({ hub, version, debug }: {
        hub: object;
        version?: string;
        debug?: boolean;
    });
    hub: any;
    version: string;
    _debug: boolean;
    authState: string;
    _registry: Map<string, {
        summary: string;
        params: any[];
        result: string;
        handler: Function;
        namespace?: string;
    }>;
    _openrpc: {
        openrpc: string;
        info: {
            title: string;
            version: any;
            "x-contractVersion": string;
            description: any;
        };
        methods: {
            name: any;
            summary: any;
            params: any;
            result: {
                name: string;
                schema: {
                    description: any;
                    type: string;
                };
            };
        }[];
        "x-events": {
            name: string;
            description: any;
        }[];
    };
    /** @type {Map<string, Promise<any>>} メソッド名→直列化チェーン末尾 */
    _locks: Map<string, Promise<any>>;
    /** @type {Map<object, Set<string>>} Connection→購読 topic */
    _subs: Map<object, Set<string>>;
    /** hub 状態 push の単一購読の unsubscribe (張っている時のみ非 null) */
    _stateUnsub: any;
    _stopped: boolean;
    _shuttingDown: boolean;
    _retryTimer: NodeJS.Timeout;
    _log(...a: any[]): void;
    start(): void;
    _connectLoop(): Promise<void>;
    _hasStoredTokens(): boolean;
    /** キャンセル可能な sleep。shutdown 時に即 resolve してループを抜けさせる。 */
    _sleep(ms: any): Promise<any>;
    _retryResolve: (value: any) => void;
    addConnection(conn: any): void;
    removeConnection(conn: any): void;
    /** 1 メッセージを処理して応答オブジェクト (通知なら null) を返す。push はしない (HTTP POST 用)。 */
    dispatchMessage(conn: any, raw: any): Promise<any>;
    /** framing から: 1 行を処理し、応答があれば conn.send で push する。throw しない。 */
    handleLine(conn: any, raw: any): Promise<void>;
    /** メソッド実行。registry 解決 + rpc.discover + メソッド名単位の直列化。常に Promise を返す。 */
    invoke(method: any, params: any, conn: any): Promise<any>;
    /**
     * 同名メソッドを直列化する。これは応答入替の主防御ではなく (request() ベースの op は
     * transport の (action:op) FIFO が保証する) **listDevices 等 onMessage 先着 resolve で
     * 解決する op** を、複数クライアント同時呼び出しから守る防御。同名 op を 1 並行に絞る。
     */
    _serialize(key: any, run: any): Promise<any>;
    subscribe(conn: any, topics: any): {
        subscribed: string[];
    };
    unsubscribe(conn: any, topics: any): {
        subscribed: string[];
    };
    _anySubscribers(): boolean;
    /** 状態 push の単一購読を (必要なら) 張る。hub 未接続なら接続時に再試行。 */
    _ensureStateSub(): void;
    _reestablishStateSub(): void;
    _maybeTeardownStateSub(): void;
    /**
     * 状態 push を購読 Connection へ配信する。
     * 注: lockState と deviceUpdate は現状どちらも biz3 の pubDeviceStateChange を源とする
     * (同一ストリームの別ラベル)。両方購読している接続には **1 回だけ** 配信する
     * (最初に購読している topic のラベルで) — 同一イベントの二重配信を避ける。
     */
    _fanout(msg: any): void;
    /** 冪等。受付停止 → hub.close()(=_pendingCleanups 実行) → 解決。 */
    shutdown(): Promise<void>;
    /** 購読可能な topic 一覧 (framing が事前検証に使う)。 */
    get topics(): string[];
    /** テスト/イントロスペクション用。 */
    get registry(): Map<string, {
        summary: string;
        params: any[];
        result: string;
        handler: Function;
        namespace?: string;
    }>;
    get openrpc(): {
        openrpc: string;
        info: {
            title: string;
            version: any;
            "x-contractVersion": string;
            description: any;
        };
        methods: {
            name: any;
            summary: any;
            params: any;
            result: {
                name: string;
                schema: {
                    description: any;
                    type: string;
                };
            };
        }[];
        "x-events": {
            name: string;
            description: any;
        }[];
    };
}
//# sourceMappingURL=daemon.d.ts.map