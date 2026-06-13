/**
 * 成功応答を組み立てる。
 * @param {RpcId} id
 * @param {unknown} result
 * @returns {RpcResultEnvelope}
 */
export function makeResult(id: RpcId, result: unknown): RpcResultEnvelope;
/**
 * エラー応答を組み立てる。data は kind 等のみ。inbound params は決して入れない。
 * @param {RpcId} id
 * @param {number} code
 * @param {string} message
 * @param {string} [kind]
 * @param {Record<string, unknown>|null} [data]
 * @returns {RpcErrorEnvelope}
 */
export function makeError(id: RpcId, code: number, message: string, kind?: string, data?: Record<string, unknown> | null): RpcErrorEnvelope;
/**
 * 任意の throw を JSON-RPC error オブジェクトへ正規化 (params は echo しない)。
 * @param {RpcId} id
 * @param {unknown} err
 * @returns {RpcErrorEnvelope}
 */
export function errorFromThrow(id: RpcId, err: unknown): RpcErrorEnvelope;
/**
 * 1 行 (1 メッセージ) を parse して分類する。
 * @param {string} raw
 * @returns {ClassifyResult}
 */
export function classify(raw: string): ClassifyResult;
/**
 * 1 メッセージを処理して応答オブジェクト (通知なら null) を返す。
 * メソッド実行は `invoke(method, params)` に委譲 (Daemon が registry 解決 + 直列化 + 認可を仕込む)。
 * この関数は throw しない。
 *
 * @param {string} raw 1 行の生メッセージ
 * @param {(method:string, params:unknown) => Promise<unknown>} invoke
 * @returns {Promise<RpcResponse|null>} 応答 (通知なら null)
 */
export function handleMessage(raw: string, invoke: (method: string, params: unknown) => Promise<unknown>): Promise<RpcResponse | null>;
/**
 * サーバ発のイベント通知フレームを作る (予約名 `event.<topic>`)。
 * @param {string} topic
 * @param {unknown} payload
 * @returns {RpcEvent}
 */
export function makeEvent(topic: string, payload: unknown): RpcEvent;
export const CONTRACT_VERSION: "1.4.0";
/**
 * CONTRACT_VERSION ごとの公開メソッド集合フィンガープリント (規範7 のゲート)。
 *
 * 算出方法: buildRegistry() のキー一覧をソートして "," 結合し、SHA-256 の下位 64bit (16 hex 文字)。
 *   const methods = [...buildRegistry().keys()].sort().join(",");
 *   const hash = crypto.createHash("sha256").update(methods).digest("hex").slice(0, 16);
 *
 * 使用目的: 公開面が変わったのに CONTRACT_VERSION が据え置かれた状態を CI で検出する。
 *   - メソッドを追加/削除/改名した場合 → hash 不一致 → バージョン bump を強制。
 *   - result 形・params 形のみ変わった場合は hash 不変 → bump 不要 (minor 追加は minor bump)。
 *   - この定数を更新するには「既存ハッシュを削除して新ハッシュを追加」ではなく
 *     「新バージョンを追記して古いバージョンも残す」こと (changelog として機能するため)。
 *
 * v1.3.0 メソッド集合: 202 メソッド。ble.scan を追加した版。
 *   v2 P5-14(workspace 分割)後に ble.scan (P1-7)・access.auth-data 系 4 op (P4-4)・
 *   ble.os2.reset/configureLockPosition (P4-5)・config.syncRemotesFromServer (P4-6) を追加し
 *   ble.wifi.networkStatus を削除 (P3-27) して確定した公開面。
 * v1.4.0 メソッド集合: 205 メソッド。keystore.list / keystore.put / keystore.remove を追加した版 (P3-2)。
 *   result 形変更 (isStop nullable 化 P4-2 / payment.changeDefaultPayment reqContext P3-8) はメソッド集合不変のため
 *   フィンガープリントには影響しない (hash = 28fc802bc1720a77 は P3-2 のメソッド集合に対応)。
 *
 * @type {Readonly<Record<string, string>>}
 */
export const KNOWN_FINGERPRINTS: Readonly<Record<string, string>>;
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
export const RPC: Readonly<{
    PARSE_ERROR: -32700;
    INVALID_REQUEST: -32600;
    METHOD_NOT_FOUND: -32601;
    INVALID_PARAMS: -32602;
    INTERNAL_ERROR: -32603;
    APP_ERROR: -32000;
}>;
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
    constructor(message: string, { code, kind, data }?: {
        code?: number;
        kind?: string;
        data?: Record<string, unknown> | null;
    });
    /** @type {number} */
    code: number;
    /** @type {string} */
    kind: string;
    /** @type {Record<string, unknown>|null} */
    data: Record<string, unknown> | null;
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
export const KIND: Readonly<{
    NOT_AUTHENTICATED: "not_authenticated";
    BAD_PARAMS: "bad_params";
    TIMEOUT: "timeout";
    CONNECTION_LOST: "connection_lost";
    REJECTED: "rejected";
    INTERNAL: "internal";
    NOT_IMPLEMENTED: "not_implemented";
}>;
/**
 * JSON-RPC の id 型。string / number / null のいずれか。
 */
export type RpcId = string | number | null;
/**
 * JSON-RPC error オブジェクト (応答の `error` フィールド)。
 */
export type RpcErrorObject = {
    code: number;
    message: string;
    data?: Record<string, unknown>;
};
/**
 * JSON-RPC 成功応答エンベロープ。
 */
export type RpcResultEnvelope = {
    jsonrpc: "2.0";
    id: RpcId;
    result: unknown;
};
/**
 * JSON-RPC エラー応答エンベロープ。
 */
export type RpcErrorEnvelope = {
    jsonrpc: "2.0";
    id: RpcId;
    error: RpcErrorObject;
};
/**
 * JSON-RPC 応答エンベロープ (成功 or エラー)。
 */
export type RpcResponse = RpcResultEnvelope | RpcErrorEnvelope;
/**
 * サーバ発のイベント通知フレーム (id なし)。
 */
export type RpcEvent = {
    jsonrpc: "2.0";
    method: string;
    params: unknown;
};
/**
 * `classify` の分類結果。
 */
export type ClassifyResult = {
    type: "parse-error";
} | {
    type: "batch";
} | {
    type: "invalid";
    id: RpcId;
} | {
    type: "request";
    id: RpcId;
    method: string;
    params: unknown;
} | {
    type: "notification";
    method: string;
    params: unknown;
};
//# sourceMappingURL=jsonrpc.d.ts.map