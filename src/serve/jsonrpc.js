// JSON-RPC 2.0 プロトコルコア (transport 非依存)。
//
// 全フレーミング (stdio / UDS / HTTP / WS / gRPC) が共有する純粋な protocol 層。
// ここは「1 メッセージの parse / 分類 / 整形」だけを担い、メソッド解決やイベント配信、
// 並行制御は Daemon 側に置く (この層は registry も hub も知らない)。
//
// 仕様準拠の要点:
//   - 応答は `id` あり、通知は `id` なし+`method` あり。両者を混同しない。
//   - 通知にはエラーでも応答を返さない。
//   - batch (配列) は v1 では受け付けない (明示的に -32600)。
//   - 予約名前空間 `rpc.*` は `rpc.discover` 以外 method-not-found。
//   - エラーの `data` に inbound params を絶対に echo しない (secretKey 漏洩防止)。

/**
 * 機械向け契約 (RPC メソッド名/params 形/結果形/event 名/error.kind) の SemVer。
 * **破壊的変更でだけ major を上げる** (パッケージ version とは独立。pkg は無害な変更でも上がる)。
 * 消費者はこれを `status.contractVersion` か discover の `info["x-contractVersion"]` で読み、
 * major 不一致なら fail-fast できる。後方互換な追加は minor、説明のみは patch。
 *   1.0.0: 初版 (5 framing / 79 method / event.lockState・deviceUpdate / 6 kind)
 *   1.1.0: ドメインエラーの構造化 (kind=rejected 追加 / error.data.retryable / per-method
 *          x-stability・x-provenance / status・discover の apiVersion)。すべて後方互換な追加。
 *   1.2.0: event.ready を全永続接続 (stdio/socket/ws/SSE/gRPC Subscribe) で一律発火 /
 *          discover に x-event-topics (購読可能 topic)。後方互換な追加。
 */
import { t } from "../i18n.js";
import { SesameError, ERR } from "../errors.js";

export const CONTRACT_VERSION = "1.2.0";

/**
 * JSON-RPC の id 型。string / number / null のいずれか。
 * @typedef {string|number|null} RpcId
 */

/**
 * JSON-RPC error オブジェクト (応答の `error` フィールド)。
 * @typedef {{ code: number, message: string, data?: Record<string, unknown> }} RpcErrorObject
 */

/**
 * JSON-RPC 成功応答エンベロープ。
 * @typedef {{ jsonrpc: "2.0", id: RpcId, result: unknown }} RpcResultEnvelope
 */

/**
 * JSON-RPC エラー応答エンベロープ。
 * @typedef {{ jsonrpc: "2.0", id: RpcId, error: RpcErrorObject }} RpcErrorEnvelope
 */

/**
 * JSON-RPC 応答エンベロープ (成功 or エラー)。
 * @typedef {RpcResultEnvelope|RpcErrorEnvelope} RpcResponse
 */

/**
 * サーバ発のイベント通知フレーム (id なし)。
 * @typedef {{ jsonrpc: "2.0", method: string, params: unknown }} RpcEvent
 */

/**
 * `classify` の分類結果。
 * @typedef {{type:"parse-error"}
 *          | {type:"batch"}
 *          | {type:"invalid", id:RpcId}
 *          | {type:"request", id:RpcId, method:string, params:unknown}
 *          | {type:"notification", method:string, params:unknown}} ClassifyResult
 */

/** JSON-RPC 2.0 標準エラーコード + アプリ域 (-32000)。 */
export const RPC = Object.freeze({
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  APP_ERROR: -32000, // ドメインエラーの既定コード (kind で細分化)
});

/**
 * ドメイン/プロトコルエラー。handler はこれを throw するとそのまま JSON-RPC error になる。
 * `kind` は機械可読な分類で、`error.data.kind` に載る (クライアントが分岐できる)。
 * @param {string} message
 * @param {{ code?: number, kind?: string, data?: Record<string, unknown>|null }} [opts]
 */
export class RpcError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: number, kind?: string, data?: Record<string, unknown>|null }} [opts]
   */
  constructor(message, { code = RPC.APP_ERROR, kind = "internal", data = null } = {}) {
    super(message);
    this.name = "RpcError";
    /** @type {number} */
    this.code = code;
    /** @type {string} */
    this.kind = kind;
    /** @type {Record<string, unknown>|null} */
    this.data = data;
  }
}

/**
 * error.data.kind の enum。**実際に emit される値だけ**を載せる (利用者が switch できるよう、
 * 出ないものは定義しない — 出さない値を契約に書かない)。
 *   not_authenticated : 未ログイン/トークン失効 (CLI で sesame login)
 *   connection_lost   : クラウド WS 未接続/切断
 *   timeout           : op がタイムアウト (transport の request timeout 由来)
 *   bad_params        : 引数不正/parse 不能
 *   rejected          : 上流クラウドが明示的に失敗を返した (error.data.upstreamCode に上流 code)
 *   not_implemented   : 未知メソッド
 *   internal          : 上記以外 (ライブラリ/サーバ由来の想定外エラー。message に詳細)
 *
 * error.data.retryable (boolean, 任意): 自動化向けの再試行ヒント。timeout/connection_lost=true、
 *   rejected/bad_params=false。kind で分岐しきれない「再試行可否」を 1 フラグで示す。
 */
export const KIND = Object.freeze({
  NOT_AUTHENTICATED: "not_authenticated",
  BAD_PARAMS: "bad_params",
  TIMEOUT: "timeout",
  CONNECTION_LOST: "connection_lost",
  REJECTED: "rejected",
  INTERNAL: "internal",
  NOT_IMPLEMENTED: "not_implemented",
});

// BLE デバイスの結果コード (BleResultError.resultName) → JSON-RPC kind 写像 (SURF-11)。
// resultName の語彙は検証済み SesameResultCode (src/ble/protocol.js RESULT: success/invalidFormat/
// notSupported/resultStorageFail/invalidSig/notFound/unknown/busy/invalidParam。
// 出典: _sesame_sdk_ref/.../SesameProtocols.kt:28-30。8 (INVALID_PARAM) で終端。
// OS2 側 src/ble/os2/protocol.js も同語彙)。タイムアウトは BleResultError ではなく
// 通常 Error (ble.requestTimeout) で届くため、この表に timeout は現れない。
//   - 呼び出し形の不正をデバイスが弾いたもの (invalidFormat/invalidParam) → bad_params
//     (コード 9 "invalidAction" は iOS SDK 由来と主張されていたが一次ソース不在のため
//     UNVERIFIED_RESULT_NAMES に隔離。resultName(9) = "unknown(9)" → 下記 fallback で rejected に
//     フォールバックする — P3-16)
//   - 鍵不一致 (invalidSig = secretKey mismatch) → not_authenticated
//   - デバイスが明示的に実行を拒否/失敗 (busy/notFound/notSupported/storage/unknown) → rejected
//     (busy のみ retryable=true: 他操作完了後の再試行で成功し得る)
//   - テーブル未登録の resultName (例: "unknown(9)") → rejected (errorFromThrow の fallback が処理)
/** @type {Record<string, { kind: string, code: number, retryable: boolean }>} */
const BLE_RESULT_TO_RPC = Object.freeze({
  invalidFormat: { kind: "bad_params", code: RPC.INVALID_PARAMS, retryable: false },
  invalidParam: { kind: "bad_params", code: RPC.INVALID_PARAMS, retryable: false },
  invalidSig: { kind: "not_authenticated", code: RPC.APP_ERROR, retryable: false },
  busy: { kind: "rejected", code: RPC.APP_ERROR, retryable: true },
  notFound: { kind: "rejected", code: RPC.APP_ERROR, retryable: false },
  notSupported: { kind: "rejected", code: RPC.APP_ERROR, retryable: false },
  resultStorageFail: { kind: "rejected", code: RPC.APP_ERROR, retryable: false },
  unknown: { kind: "rejected", code: RPC.APP_ERROR, retryable: false },
});

// ライブラリの SesameError.code → JSON-RPC {kind, code} 写像 (serve は lib に依存してよい)。
/** @type {Record<string, { kind: string, code: number }>} */
const SESAME_TO_RPC = Object.freeze({
  [ERR.NOT_CONNECTED]: { kind: KIND.CONNECTION_LOST, code: RPC.APP_ERROR },
  [ERR.TIMEOUT]: { kind: KIND.TIMEOUT, code: RPC.APP_ERROR },
  [ERR.REJECTED]: { kind: KIND.REJECTED, code: RPC.APP_ERROR },
  [ERR.BAD_REQUEST]: { kind: KIND.BAD_PARAMS, code: RPC.INVALID_PARAMS },
  [ERR.UNAUTHENTICATED]: { kind: KIND.NOT_AUTHENTICATED, code: RPC.APP_ERROR },
});

/**
 * 成功応答を組み立てる。
 * @param {RpcId} id
 * @param {unknown} result
 * @returns {RpcResultEnvelope}
 */
export function makeResult(id, result) {
  return { jsonrpc: "2.0", id, result: result === undefined ? null : result };
}

/**
 * エラー応答を組み立てる。data は kind 等のみ。inbound params は決して入れない。
 * @param {RpcId} id
 * @param {number} code
 * @param {string} message
 * @param {string} [kind]
 * @param {Record<string, unknown>|null} [data]
 * @returns {RpcErrorEnvelope}
 */
export function makeError(id, code, message, kind, data = null) {
  /** @type {Record<string, unknown>} */
  const errorData = {};
  if (data && typeof data === "object") Object.assign(errorData, data);
  if (kind) errorData.kind = kind; // kind は契約なので最後に置き、caller data に上書きさせない
  /** @type {RpcErrorObject} */
  const error = { code, message };
  if (Object.keys(errorData).length) error.data = errorData;
  return { jsonrpc: "2.0", id, error };
}

/**
 * 任意の throw を JSON-RPC error オブジェクトへ正規化 (params は echo しない)。
 * @param {RpcId} id
 * @param {unknown} err
 * @returns {RpcErrorEnvelope}
 */
export function errorFromThrow(id, err) {
  if (err instanceof RpcError) {
    return makeError(id, err.code, err.message, err.kind, err.data);
  }
  // BLE デバイスの結果コード付きエラー (src/ble/session.js / os2/session.js の BleResultError)。
  // 旧実装は kind=internal に潰れて resultCode/resultName が RPC 境界で失われていた (SURF-11)。
  // name 判定にするのは OS3/OS2 両 session の BleResultError が別クラスのため (instanceof 不可。
  // どちらも {resultCode, resultName, itemCode} を持つ同形契約)。
  if (err instanceof Error && err.name === "BleResultError") {
    const e = /** @type {Error & {resultCode?:number, resultName?:string, itemCode?:number|null}} */ (err);
    const m = (e.resultName && BLE_RESULT_TO_RPC[e.resultName])
      || { kind: KIND.REJECTED, code: RPC.APP_ERROR, retryable: false }; // unknown(N) 等の未知名は rejected
    return makeError(id, m.code, String(err.message), m.kind, {
      bleResultCode: e.resultCode ?? null,
      bleResultName: e.resultName ?? null,
      itemCode: e.itemCode ?? null,
      retryable: m.retryable,
    });
  }
  // ライブラリのドメインエラー: code を kind へ写像し、retryable / 付随 data を載せる
  // (internal 潰れを回避し、消費者が data.kind / data.retryable で分岐できるようにする)。
  if (err instanceof SesameError) {
    const m = (err.code && SESAME_TO_RPC[err.code]) || { kind: KIND.INTERNAL, code: RPC.INTERNAL_ERROR };
    /** @type {Record<string, unknown>} */
    const data = { ...(err.data || {}) };
    if (typeof err.retryable === "boolean") data.retryable = err.retryable;
    return makeError(id, m.code, String(err.message), m.kind, Object.keys(data).length ? data : null);
  }
  // 想定外の内部エラー: メッセージは出すが stack/params は出さない。
  const errMessage = (err instanceof Error) ? err.message
    : (err && typeof err === "object" && "message" in err) ? String(/** @type {{message: unknown}} */ (err).message)
    : "";
  const message = errMessage ? errMessage : t("serve.internalError");
  return makeError(id, RPC.INTERNAL_ERROR, message, KIND.INTERNAL);
}

/**
 * 1 行 (1 メッセージ) を parse して分類する。
 * @param {string} raw
 * @returns {ClassifyResult}
 */
export function classify(raw) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { type: "parse-error" };
  }
  if (Array.isArray(parsed)) return { type: "batch" };
  if (parsed === null || typeof parsed !== "object") return { type: "invalid", id: null };
  const msg = /** @type {Record<string, unknown>} */ (parsed);
  // JSON-RPC 2.0: `jsonrpc` メンバは厳密に文字列 "2.0" でなければならない。
  // 欠落/別バージョン (例 "1.0") は Invalid Request。id は取れるなら echo (応答整形用)。
  if (msg.jsonrpc !== "2.0") {
    return { type: "invalid", id: normalizeId(msg.id) };
  }
  if (typeof msg.method !== "string" || !msg.method) {
    // id を取れるなら拾う (応答整形用)。型は string/number/null のみ許容。
    return { type: "invalid", id: normalizeId(msg.id) };
  }
  const params = msg.params === undefined ? {} : msg.params;
  // `id` フィールドの「欠落」= 通知。`id:null` は通知ではなく id=null の request。
  if (!("id" in msg)) return { type: "notification", method: msg.method, params };
  return { type: "request", id: normalizeId(msg.id), method: msg.method, params };
}

/**
 * @param {unknown} id
 * @returns {RpcId}
 */
function normalizeId(id) {
  if (typeof id === "string" || typeof id === "number" || id === null) return id;
  return null; // 不正な id 型は null に丸める (応答は返せるように)
}

/**
 * 1 メッセージを処理して応答オブジェクト (通知なら null) を返す。
 * メソッド実行は `invoke(method, params)` に委譲 (Daemon が registry 解決 + 直列化 + 認可を仕込む)。
 * この関数は throw しない。
 *
 * @param {string} raw 1 行の生メッセージ
 * @param {(method:string, params:unknown) => Promise<unknown>} invoke
 * @returns {Promise<RpcResponse|null>} 応答 (通知なら null)
 */
export async function handleMessage(raw, invoke) {
  const c = classify(raw);
  switch (c.type) {
    case "parse-error":
      // NDJSON は 1 行 1 JSON。pretty-print (改行入り) すると行ごとに parse 失敗するので明示する。
      return makeError(null, RPC.PARSE_ERROR, t("serve.parseError"), KIND.BAD_PARAMS);
    case "batch":
      return makeError(null, RPC.INVALID_REQUEST, t("serve.batchUnsupported"), KIND.BAD_PARAMS);
    case "invalid":
      return makeError(c.id, RPC.INVALID_REQUEST, t("serve.invalidRequest"), KIND.BAD_PARAMS);
    case "notification":
      // 通知: 実行はするが応答は一切返さない (エラーでも沈黙)。
      try { await invoke(c.method, c.params); } catch { /* 通知はサイレント */ }
      return null;
    case "request":
      try {
        const result = await invoke(c.method, c.params);
        return makeResult(c.id, result);
      } catch (err) {
        return errorFromThrow(c.id, err);
      }
    default:
      return makeError(null, RPC.INTERNAL_ERROR, t("serve.internal"), KIND.INTERNAL);
  }
}

/**
 * サーバ発のイベント通知フレームを作る (予約名 `event.<topic>`)。
 * @param {string} topic
 * @param {unknown} payload
 * @returns {RpcEvent}
 */
export function makeEvent(topic, payload) {
  return { jsonrpc: "2.0", method: `event.${topic}`, params: payload };
}
