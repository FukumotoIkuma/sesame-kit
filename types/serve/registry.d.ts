/**
 * 全エントリを {name → entry} で構築する。
 * @returns {Map<string, MethodEntry>}
 */
export function buildRegistry(): Map<string, MethodEntry>;
/**
 * OpenRPC 文書を組み立てる (rpc.discover 応答)。param スキーマは初期は粗いが
 * 「何の op が在るか」は完全網羅する。secretKey 等の実値 example は載せない。
 * @param {Map<string, MethodEntry>} reg
 * @param {string} version
 * @returns {Record<string, unknown>}
 */
export function buildOpenRpcDoc(reg: Map<string, MethodEntry>, version: string): Record<string, unknown>;
export const SUBSCRIBABLE_TOPICS: string[];
/**
 * 常駐 hub。registry は (a) 明示メソッド (hub.lock 等) と (b) 名前空間 op の動的
 * dispatch (hub[ns][op]) の両方で hub を使う。どちらも実行時に解決する設計なので、
 * 型は daemon の HubLike を index signature 付きで緩める (動的 dispatch を許す)。
 * daemon が実際に渡す `this.hub` (HubLike) と互換である必要がある。
 */
export type Hub = import("./daemon.js").HubLike & Record<string, any>;
/**
 * RPC ハンドラに渡る実行コンテキスト。
 */
export type HandlerCtx = {
    /**
     * 常駐 SesameHub3
     */
    hub: Hub;
    /**
     * JSON-RPC params (オブジェクト)
     */
    params: Record<string, any>;
    /**
     * 呼び出し元 Connection
     */
    conn?: import("./daemon.js").Connection | undefined;
    /**
     * Daemon (購読/リース/authState 用)
     */
    daemon: import("./daemon.js").Daemon;
};
/**
 * 1 メソッドのレジストリエントリ。
 */
export type MethodEntry = {
    summary: string;
    params: Array<{
        name: string;
        required: boolean;
        desc?: string;
        schema?: Record<string, unknown>;
    }>;
    result: string;
    handler: (ctx: HandlerCtx) => unknown;
    namespace?: string | undefined;
};
/**
 * gen-rpc-schema が抽出した 1 param の記述。
 */
export type GenParam = {
    name: string;
    required: boolean;
    tsType?: string;
    schema?: Record<string, unknown>;
};
//# sourceMappingURL=registry.d.ts.map