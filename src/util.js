// モジュール横断の小さな共有ユーティリティ。
// WS op の応答 success 判定はほぼ全モジュールで重複していたので 1 箇所に集約する。

import { t } from "./i18n.js";

/**
 * WS op の応答 `resp` を検査し、失敗していれば例外を投げる。成功なら resp を返す。
 *
 * biz3 の応答には 2 系統あり、本ライブラリも両方を扱う:
 *   - lenient (既定): `success` フィールドが**明示的に false** の時だけ失敗扱い。
 *     `success` を持たない応答 (data だけ返る op、push 集約の完了通知など) は成功とみなす。
 *   - strict: `success === true` を要求し、欠落していても失敗扱い
 *     (常に success を返すと分かっている op 用)。
 *
 * @template T
 * @param {T} resp           WS 応答メッセージ
 * @param {string} op        失敗時メッセージに使う op ラベル
 * @param {{strict?:boolean}} [opts]
 * @returns {T} 成功時はそのまま resp を返す (呼び出し側で resp.data 等を取り出せる)
 * @throws {Error} 失敗時 (`<op> failed: <message|JSON>`)
 */
export function assertSuccess(resp, op, { strict = false } = {}) {
  const failed = strict ? !resp?.success : !resp || resp.success === false;
  if (failed) {
    throw new Error(t("domain.util.opFailed", { op, detail: resp?.message || JSON.stringify(resp) }));
  }
  return resp;
}
