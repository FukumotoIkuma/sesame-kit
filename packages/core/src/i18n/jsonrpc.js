// JSON-RPC プロトコルエラーメッセージ (packages/core/src/jsonrpc.js が使う)。
// これらは core ライブラリの一部として core に残す。
// kit 専用の serve.* 文言は packages/kit/src/i18n/serve.js で管理する。
export default {
  en: {
    "serve.parseError": "Parse error (send one JSON per line; pretty-print not allowed)",
    "serve.batchUnsupported": "Batch requests are not supported",
    "serve.invalidRequest": "Invalid Request",
    "serve.internal": "internal",
    "serve.internalError": "internal error",
  },
  ja: {
    "serve.parseError": "Parse error (1 行 1 JSON で送ること。pretty-print 不可)",
    "serve.batchUnsupported": "Batch requests are not supported",
    "serve.invalidRequest": "Invalid Request",
    "serve.internal": "internal",
    "serve.internalError": "internal error",
  },
};
