/**
 * 全エントリを {name → entry} で構築する。
 * @returns {Map<string, {summary:string, params:any[], result:string, handler:Function, namespace?:string}>}
 */
export function buildRegistry(): Map<string, {
    summary: string;
    params: any[];
    result: string;
    handler: Function;
    namespace?: string;
}>;
/**
 * OpenRPC 文書を組み立てる (rpc.discover 応答)。param スキーマは初期は粗いが
 * 「何の op が在るか」は完全網羅する。secretKey 等の実値 example は載せない。
 */
export function buildOpenRpcDoc(reg: any, version: any): {
    openrpc: string;
    info: {
        title: string;
        version: any;
        "x-apiVersion": string;
        "x-contractVersion": string;
        description: any;
    };
    methods: {
        name: any;
        summary: any;
        params: any;
        result: {
            name: string;
            schema: any;
        };
        "x-stability": string;
        "x-provenance": any;
    }[];
    "x-events": {
        name: any;
        description: any;
        "x-stability": string;
        "x-provenance": any;
    }[];
    "x-event-topics": string[];
};
export const SUBSCRIBABLE_TOPICS: string[];
//# sourceMappingURL=registry.d.ts.map