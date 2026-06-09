/** @param {import("commander").Command} program */
export function registerServeCommand(program: import("commander").Command): void;
/**
 * serve が投げる/橋渡しする拡張 Error。
 * - exitCode: usage エラー等で run() が尊重する終了コード。
 * - code/data/rpcError: rpc 経路で JSON-RPC error 封筒を CLI エラーへ橋渡しするマーカー
 *   (外側 CLI ハンドラが data.kind を失わず stale config 誤案内を避けるため)。
 */
export type ServeError = Error & {
    exitCode?: number;
    code?: number | string;
    data?: unknown;
    rpcError?: boolean;
};
/**
 * net.Socket 等が投げる errno 付きエラー (ENOENT/ECONNREFUSED で分岐する)。
 */
export type ErrnoError = Error & {
    code?: string;
};
/**
 * JSON-RPC 応答/通知の最小形 (1 行 JSON をパースした結果)。
 */
export type RpcMessage = {
    jsonrpc?: string;
    id?: number | string | null;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
};
//# sourceMappingURL=serve.d.ts.map