// registry-helpers.js — エントリ分割ファイル (entries/*.js) から共用する最小 helper セット。
// registry.js 本体と entries/ が双方向依存しないように、共通ユーティリティのみをここに切り出す。
// (P5-2: topLevelEntries 808 行モノリス分割の補助モジュール)

import { RpcError, RPC, KIND } from "../jsonrpc.js";
import { t } from "../i18n.js";

/**
 * 1 メソッドのレジストリエントリ。
 * @typedef {object} MethodEntry
 * @property {string} summary
 * @property {Array<{name:string, required:boolean, desc?:string, schema?:Record<string, unknown>}>} params
 * @property {string} result
 * @property {(ctx: HandlerCtx) => unknown} handler
 * @property {string} [namespace]
 */

/**
 * RPC ハンドラに渡る実行コンテキスト。
 * @typedef {object} HandlerCtx
 * @property {import("./daemon.js").HubLike & Record<string, any>} hub 常駐 SesameHub3
 * @property {Record<string, any>} params JSON-RPC params (オブジェクト)
 * @property {import("./daemon.js").Connection} [conn] 呼び出し元 Connection
 * @property {import("./daemon.js").Daemon} daemon Daemon (購読/リース/authState 用)
 */

/**
 * params 必須キーの存在チェック (軽量バリデータ)。欠落は bad_params。
 * @param {Record<string, unknown>} params
 * @param {string[]} keys
 */
export function need(params, keys) {
  for (const k of keys) {
    if (params[k] === undefined || params[k] === null || params[k] === "") {
      throw new RpcError(t("serve.missingParam", { k }), { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
    }
  }
}

/**
 * topics param を topic 文字列配列へ正規化する (単一値も配列に包む)。
 * 値の妥当性 (既知 topic か) は呼び出し側が TOPICS で検証する。
 * @param {unknown} raw
 * @returns {string[]}
 */
export function asTopicList(raw) {
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((v) => String(v));
}

/**
 * クラウド接続が要る op の前段ガード (未認証/未接続を明示エラーに)。
 * @param {import("./daemon.js").Daemon} daemon
 */
export function requireAuth(daemon) {
  if (daemon.authState === "expired") {
    throw new RpcError(t("serve.notAuthenticated"), { kind: KIND.NOT_AUTHENTICATED });
  }
  if (!daemon.hub.connected) {
    throw new RpcError(t("serve.cloudNotConnected"), { kind: KIND.CONNECTION_LOST });
  }
}

/**
 * config 同期 RPC (config.*) の前段ガード (SURF-07)。daemon の hub が ConfigStore を持たない
 * 構成 (config/tokenStore 直渡しの埋め込み等) では同期先が無いため bad_params で明示拒否する。
 * hub.syncXxx 側の plain Error (requiresConfigStore) が kind=internal に潰れるのを防ぐ。
 * @param {import("./daemon.js").HubLike & Record<string, any>} hub
 * @param {string} op エラーメッセージに出すメソッド名
 */
export function requireConfigStore(hub, op) {
  if (!hub.configStore) {
    throw new RpcError(t("serve.configStoreRequired", { op }), { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
  }
}
