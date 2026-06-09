// ライブラリ層の型付きエラー。
//
// ドメイン失敗を機械可読な `code` で分類して投げる。これにより:
//   - ライブラリ直利用者は `err.code` で分岐できる (localized message を parse しない)。
//   - serve 層 (src/serve/jsonrpc.js) は `code` を JSON-RPC の `error.data.kind` へ写像できる。
// 層分けのため、ライブラリは serve の RpcError/KIND に依存しない (依存方向は serve → lib)。
//
// `retryable`: 自動化が「再試行してよいか」を分岐するためのヒント (timeout/未接続=true、
//   引数不正/上流拒否=false)。`data`: 付随情報 (上流クラウドの code 等。provenance=upstream)。

/** 機械可読なエラーコード (安定契約。serve が kind へ写像)。 */
export const ERR = Object.freeze({
  NOT_CONNECTED: "not_connected",   // クラウド WS 未接続/未準備 (retryable)
  TIMEOUT: "timeout",               // 応答待ちタイムアウト (retryable)
  REJECTED: "rejected",             // 上流クラウドが明示的に失敗を返した (data.upstreamCode)
  BAD_REQUEST: "bad_request",       // 呼び出し側の不正 (引数欠落/不明な名前など)
  UNAUTHENTICATED: "unauthenticated", // 未ログイン/トークン失効
});

export class SesameError extends Error {
  /**
   * @param {string} message
   * @param {{ code: string, retryable?: boolean, data?: object|null, cause?: any }} opts
   */
  constructor(message, { code, retryable = false, data = null, cause } = {}) {
    super(message);
    this.name = "SesameError";
    this.code = code;
    this.retryable = retryable;
    this.data = data;
    if (cause !== undefined) this.cause = cause;
  }
}
