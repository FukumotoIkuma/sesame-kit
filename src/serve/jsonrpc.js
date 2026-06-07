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
 */
import { t } from "../i18n.js";

export const CONTRACT_VERSION = "1.0.0";

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
 * @param {{ code?: number, kind?: string, data?: object }} [opts]
 */
export class RpcError extends Error {
  constructor(message, { code = RPC.APP_ERROR, kind = "internal", data = null } = {}) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.kind = kind;
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
 *   not_implemented   : 未知メソッド
 *   internal          : 上記以外 (ライブラリ/サーバ由来の想定外エラー。message に詳細)
 */
export const KIND = Object.freeze({
  NOT_AUTHENTICATED: "not_authenticated",
  BAD_PARAMS: "bad_params",
  TIMEOUT: "timeout",
  CONNECTION_LOST: "connection_lost",
  INTERNAL: "internal",
  NOT_IMPLEMENTED: "not_implemented",
});

/** 成功応答を組み立てる。 */
export function makeResult(id, result) {
  return { jsonrpc: "2.0", id, result: result === undefined ? null : result };
}

/** エラー応答を組み立てる。data は kind 等のみ。inbound params は決して入れない。 */
export function makeError(id, code, message, kind, data = null) {
  const errorData = {};
  if (data && typeof data === "object") Object.assign(errorData, data);
  if (kind) errorData.kind = kind; // kind は契約なので最後に置き、caller data に上書きさせない
  const error = { code, message };
  if (Object.keys(errorData).length) error.data = errorData;
  return { jsonrpc: "2.0", id, error };
}

/** 任意の throw を JSON-RPC error オブジェクトへ正規化 (params は echo しない)。 */
export function errorFromThrow(id, err) {
  if (err instanceof RpcError) {
    return makeError(id, err.code, err.message, err.kind, err.data);
  }
  // 想定外の内部エラー: メッセージは出すが stack/params は出さない。
  const message = (err && err.message) ? String(err.message) : t("serve.internalError");
  return makeError(id, RPC.INTERNAL_ERROR, message, KIND.INTERNAL);
}

/**
 * 1 行 (1 メッセージ) を parse して分類する。
 * @param {string} raw
 * @returns {{type:"parse-error"}
 *          | {type:"batch"}
 *          | {type:"invalid", id:(string|number|null)}
 *          | {type:"request", id:(string|number), method:string, params:any}
 *          | {type:"notification", method:string, params:any}}
 */
export function classify(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { type: "parse-error" };
  }
  if (Array.isArray(msg)) return { type: "batch" };
  if (msg === null || typeof msg !== "object") return { type: "invalid", id: null };
  if (typeof msg.method !== "string" || !msg.method) {
    // id を取れるなら拾う (応答整形用)。型は string/number/null のみ許容。
    return { type: "invalid", id: normalizeId(msg.id) };
  }
  const params = msg.params === undefined ? {} : msg.params;
  // `id` フィールドの「欠落」= 通知。`id:null` は通知ではなく id=null の request。
  if (!("id" in msg)) return { type: "notification", method: msg.method, params };
  return { type: "request", id: normalizeId(msg.id), method: msg.method, params };
}

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
 * @param {(method:string, params:any) => Promise<any>} invoke
 * @returns {Promise<object|null>} 応答 (通知なら null)
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

/** サーバ発のイベント通知フレームを作る (予約名 `event.<topic>`)。 */
export function makeEvent(topic, payload) {
  return { jsonrpc: "2.0", method: `event.${topic}`, params: payload };
}
