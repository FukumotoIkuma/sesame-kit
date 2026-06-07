/** 成功応答を組み立てる。 */
export function makeResult(id: any, result: any): {
    jsonrpc: string;
    id: any;
    result: any;
};
/** エラー応答を組み立てる。data は kind 等のみ。inbound params は決して入れない。 */
export function makeError(id: any, code: any, message: any, kind: any, data?: any): {
    jsonrpc: string;
    id: any;
    error: {
        code: any;
        message: any;
    };
};
/** 任意の throw を JSON-RPC error オブジェクトへ正規化 (params は echo しない)。 */
export function errorFromThrow(id: any, err: any): {
    jsonrpc: string;
    id: any;
    error: {
        code: any;
        message: any;
    };
};
/**
 * 1 行 (1 メッセージ) を parse して分類する。
 * @param {string} raw
 * @returns {{type:"parse-error"}
 *          | {type:"batch"}
 *          | {type:"invalid", id:(string|number|null)}
 *          | {type:"request", id:(string|number), method:string, params:any}
 *          | {type:"notification", method:string, params:any}}
 */
export function classify(raw: string): {
    type: "parse-error";
} | {
    type: "batch";
} | {
    type: "invalid";
    id: (string | number | null);
} | {
    type: "request";
    id: (string | number);
    method: string;
    params: any;
} | {
    type: "notification";
    method: string;
    params: any;
};
/**
 * 1 メッセージを処理して応答オブジェクト (通知なら null) を返す。
 * メソッド実行は `invoke(method, params)` に委譲 (Daemon が registry 解決 + 直列化 + 認可を仕込む)。
 * この関数は throw しない。
 *
 * @param {string} raw 1 行の生メッセージ
 * @param {(method:string, params:any) => Promise<any>} invoke
 * @returns {Promise<object|null>} 応答 (通知なら null)
 */
export function handleMessage(raw: string, invoke: (method: string, params: any) => Promise<any>): Promise<object | null>;
/** サーバ発のイベント通知フレームを作る (予約名 `event.<topic>`)。 */
export function makeEvent(topic: any, payload: any): {
    jsonrpc: string;
    method: string;
    params: any;
};
export const CONTRACT_VERSION: "1.0.0";
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
 * @param {{ code?: number, kind?: string, data?: object }} [opts]
 */
export class RpcError extends Error {
    constructor(message: any, { code, kind, data }?: {
        code?: -32000;
        kind?: string;
        data?: any;
    });
    code: -32000;
    kind: string;
    data: any;
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
export const KIND: Readonly<{
    NOT_AUTHENTICATED: "not_authenticated";
    BAD_PARAMS: "bad_params";
    TIMEOUT: "timeout";
    CONNECTION_LOST: "connection_lost";
    INTERNAL: "internal";
    NOT_IMPLEMENTED: "not_implemented";
}>;
//# sourceMappingURL=jsonrpc.d.ts.map