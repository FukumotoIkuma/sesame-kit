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
        "x-contractVersion": string;
        description: string;
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
        description: string;
    }[];
};
//# sourceMappingURL=registry.d.ts.map