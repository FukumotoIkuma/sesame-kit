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
export const NAMESPACE_MODULE_KEYS: readonly string[];
/** pubDeviceStateChange を源とする state push の topic (同一ストリームの別ラベル — daemon._fanout 参照)。 */
export const STATE_TOPICS: readonly string[];
/** 購読可能な全 topic。deviceListChanged は pubUserDeviceChange 源の別ストリーム。 */
export const SUBSCRIBABLE_TOPICS: readonly string[];
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
 * desc は生成側が上書きした説明 (SURF-09: companyID/subUUID の自動注入注記等)。無ければ tsType を出す。
 */
export type GenParam = {
    name: string;
    required: boolean;
    tsType?: string;
    desc?: string;
    schema?: Record<string, unknown>;
};
export const invokePath: typeof _invokePath;
export const wifiViewOf: typeof _wifiViewOf;
export const collectWifiScan: typeof _collectWifiScan;
export const bleCommandAck: typeof _bleCommandAck;
import { WM2_API_GATEWAY_CLIENT_ID as _WM2_API_GATEWAY_CLIENT_ID } from "../ble/rpc-helpers.js";
import { invokePath as _invokePath } from "../ble/rpc-helpers.js";
import { wifiViewOf as _wifiViewOf } from "../ble/rpc-helpers.js";
import { collectWifiScan as _collectWifiScan } from "../ble/rpc-helpers.js";
import { bleCommandAck as _bleCommandAck } from "../ble/rpc-helpers.js";
export { _WM2_API_GATEWAY_CLIENT_ID as WM2_API_GATEWAY_CLIENT_ID };
//# sourceMappingURL=registry.d.ts.map