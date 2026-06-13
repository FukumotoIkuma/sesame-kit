// ライブラリ層の型付きエラー。
//
// ドメイン失敗を機械可読な `code` で分類して投げる。これにより:
//   - ライブラリ直利用者は `err.code` で分岐できる (localized message を parse しない)。
//   - serve 層 (packages/kit/src/serve/framing/*.js) は `code` を JSON-RPC の `error.data.kind` へ写像できる。
// 層分けのため、ライブラリは serve の RpcError/KIND に依存しない (依存方向は serve → lib)。
//
// ---- エラー設計の方針 (P5-5 / ARCH-09) ----
//
// どの Error クラスを投げるかは「誰の落ち度か」で線引きする:
//
//   1. **呼び出し側不正 (ユーザ入力・引数)** = `util.badRequest()` / SesameError(BAD_REQUEST)。
//      例: 不明なロック名・必須引数の欠落・非対応 model への操作要求。serve 経由では
//      error.data.kind=bad_params に写像され、CLI/RPC 利用者が自分の入力を直せる。
//      公開ファサードの入口 (コンストラクタ / op ゲート / use 系) もここに含む。
//   2. **上流 (クラウド/デバイス) の明示的拒否** = `util.rejected()` / SesameError(REJECTED)。
//      再試行しても無駄な確定失敗。timeout は `util.timeoutError()` (retryable=true)。
//   3. **内部不変条件 (プログラマエラー)** = plain Error。
//      例: バイト列長の不一致・load() 前の save() 呼び出し・コンストラクタへの null 注入など、
//      「ライブラリを組み込むコードのバグ」。利用者の実行時入力では到達しない経路であり、
//      serve では kind=internal のまま落ちてよい (隠さずバグとして表面化させる)。
//
// 注: BLE セッション層の `BleResultError` (デバイス結果コード付き) は独自クラスのまま投げる。
// serve の errorFromThrow が resultName → kind を直接写像する (Phase 4 / SURF-11) ため、
// SesameError に**包み直さない**こと (resultCode/resultName が data から失われる)。
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
  // BLE アダプタ層エラー (P5-5 / R3:ARCH-10)。すべて retryable=false。
  // serve 写像: kind=rejected (BLE_NO_ADAPTER/BLE_UNAUTHORIZED/BLE_UNSUPPORTED/BLE_POWERED_OFF)
  // または kind=timeout (BLE_INIT_TIMEOUT)。errorFromThrow の SESAME_TO_RPC を参照。
  BLE_NO_ADAPTER: "ble_no_adapter",          // noble 未導入 / BLE ハードウェア不在
  BLE_UNAUTHORIZED: "ble_unauthorized",      // Bluetooth 権限なし (macOS entitlement)
  BLE_UNSUPPORTED: "ble_unsupported",        // Bluetooth 非対応ハードウェア/プラットフォーム
  BLE_POWERED_OFF: "ble_powered_off",        // Bluetooth がオフ
  BLE_INIT_TIMEOUT: "ble_init_timeout",      // Bluetooth 初期化タイムアウト (retryable=true)
});

export class SesameError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, retryable?: boolean, data?: object|null, cause?: unknown }} [opts]
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
