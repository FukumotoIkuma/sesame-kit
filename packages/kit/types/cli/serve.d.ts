/** @param {import("commander").Command} program */
export function registerServeCommand(program: import("commander").Command): void;
/**
 * SesameClient (clients/js) の SesameError を CLI のエラー契約へ橋渡しする。
 *   - 接続不能/未起動・timeout・HTTP 401 は従来の i18n メッセージへ写像 (人間向け案内を維持)。
 *   - サーバが返した JSON-RPC error は data.kind / rpcError マーカー付き ServeError へ変換し、
 *     外側の CLI ハンドラが stale config 誤案内 (withStaleHint) を避けられるようにする。
 *   - kind=bad_params (引数不正/未知 op) は呼び出し側の usage エラーなので exitCode=2 を
 *     立てる (バックログ5 / SURF-19 見送り分。README の終了コード契約 0=成功/1=ランタイム/
 *     2=usage と一致させる)。それ以外の kind は従来どおりランタイム 1。
 * (テストのため export。run() の catch → runtimeExitCode が exitCode を尊重する。)
 * @param {unknown} e
 * @param {{ socketPath?: string, url?: string }} [where]
 * @returns {Error}
 */
export function toServeError(e: unknown, { socketPath, url }?: {
    socketPath?: string;
    url?: string;
}): Error;
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