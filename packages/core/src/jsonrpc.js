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
 *   1.3.0: 以下の追加 (すべて後方互換な追加)。
 *     - Phase1 P1-7: ble.scan を追加 (BLE デバイス探索の typed op。計 202 メソッド)。
 *     - Phase1 P1-8: 生体一覧 5 op (finger/face/palm/guestFinger/guestFace) の結果形を
 *       ack → { records: [...] } に変更 (@experimental。破壊的変更ではなく experimental 形変更)。
 *     - Phase1 P1-4: devices.subscribeDevicesUpdate の戻り値 () => void →
 *       { unsubscribe, sendFrame } に変更 (@experimental)。
 *     - Phase3 P3-27: ble.wifi.networkStatus (発明 op) を削除 (@experimental だったため
 *       minor バージョン内で撤去)。
 *     - Phase4 P4-4: access.auth-data POST/PUT/DELETE/NAME の RPC 追加 (@experimental)。
 *     - Phase4 P4-5: ble.os2.reset / ble.os2.configureLockPosition の typed RPC 追加
 *       (@experimental)。
 *     - Phase4 P4-6: config.syncRemotesFromServer RPC 追加 (@experimental)。
 *     - Phase4 P4-8: events.subscribe/unsubscribe の topics param に
 *       x-event-topics の enum schema を付与 (SDK 型が union になる。後方互換)。
 *     - stable 13 メソッドのシグネチャは不変 (破壊的変更なし。major 据え置き正当)。
 *   1.4.0: 以下の追加・変更 (すべて後方互換)。メソッド集合は 202→205 に増加。
 *     - Phase3 P3-2: keystore.list / keystore.put / keystore.remove を追加 (計 205 メソッド)。
 *       個人アカウント鍵ストア REST API (CHAPIClient.kt:29-46) の RPC 公開。
 *       @experimental 実機 API Gateway での受理は未検証 (REFACTORING_PLAN §9 V15)。
 *     - Phase4 P4-2: ble.os2.* イベント / BLE status 取得の MechStatus に含まれる isStop が
 *       boolean|null の 3 値型に変更 (os2lock=null / os2bot=boolean / os2bike=boolean)。
 *       メソッド集合は不変 (result 形変更のみ)。参照: CHSesame2.kt:40 / CHSesameBotDevice.kt:286-293。
 *     - Phase3 P3-8: payment.changeDefaultPayment の戻り値が { data, reqContext } に変更。
 *       vendor (references_web/src/api/useStripeInfo.js:123-135) が読む reqContext フィールドを
 *       ライブラリ利用者に公開。メソッド集合は不変 (result 形変更のみ)。
 */
import { t } from "./i18n.js";
import { SesameError, ERR } from "./errors.js";

export const CONTRACT_VERSION = "1.4.0";

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
export const KNOWN_FINGERPRINTS = Object.freeze({
  "1.3.0": "617b3c33d26e9701",
  "1.4.0": "28fc802bc1720a77",
});

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
// BLE アダプタ層エラー (P5-5 / R3:ARCH-10): BLE_* は全 retryable=false (ハードウェア/権限の問題)。
// BLE_INIT_TIMEOUT のみ retryable=true で SesameError.retryable が true になる (errorFromThrow が透過)。
/** @type {Record<string, { kind: string, code: number }>} */
const SESAME_TO_RPC = Object.freeze({
  [ERR.NOT_CONNECTED]: { kind: KIND.CONNECTION_LOST, code: RPC.APP_ERROR },
  [ERR.TIMEOUT]: { kind: KIND.TIMEOUT, code: RPC.APP_ERROR },
  [ERR.REJECTED]: { kind: KIND.REJECTED, code: RPC.APP_ERROR },
  [ERR.BAD_REQUEST]: { kind: KIND.BAD_PARAMS, code: RPC.INVALID_PARAMS },
  [ERR.UNAUTHENTICATED]: { kind: KIND.NOT_AUTHENTICATED, code: RPC.APP_ERROR },
  // BLE アダプタ層エラー → rejected (ハードウェア/権限由来。上流クラウド拒否とは種類が違うが
  // "操作を続行できない" という意味で rejected が最も近い写像。kind=internal は避ける)。
  [ERR.BLE_NO_ADAPTER]: { kind: KIND.REJECTED, code: RPC.APP_ERROR },
  [ERR.BLE_UNAUTHORIZED]: { kind: KIND.REJECTED, code: RPC.APP_ERROR },
  [ERR.BLE_UNSUPPORTED]: { kind: KIND.REJECTED, code: RPC.APP_ERROR },
  [ERR.BLE_POWERED_OFF]: { kind: KIND.REJECTED, code: RPC.APP_ERROR },
  [ERR.BLE_INIT_TIMEOUT]: { kind: KIND.TIMEOUT, code: RPC.APP_ERROR },
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
