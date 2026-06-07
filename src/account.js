// ログインユーザ情報 (biz3GetLoginUser)。
//
// Ported from biz3 (CANDY-HOUSE/biz3, MIT):
//   - vendor reference: references_web/src/api/useStripeInfo.js:82-92, 191-197
//
// 注: これは「認証」ではなく「ログイン済みセッションで自分の会社情報を引く op」。
//     認証フロー (Cognito client / refresh / DEVICE_KEY 永続化) は auth.js のまま
//     アプリ寄せを維持しており、ここは一切関与しない。
//
// フレーム (op なし):  { action: "biz3GetLoginUser", email }
// 応答:               message.data = { customerInfo, quotas }
//   customerInfo に companyID / subUUID / subscriptionId / name 等が入る。

import { ACTION_TYPES } from "../vendor/biz3/constants/messageConstants.js";
import { assertSuccess } from "./util.js";
import { t } from "./i18n.js";

const ACT_LOGIN = ACTION_TYPES.BIZ3_GET_LOGIN_INFO; // "biz3GetLoginUser"
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * ログインユーザの customerInfo / quotas を取得する。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{email:string}} params  login に使った email (tokenStore の username)
 * @returns {Promise<{customerInfo: object|null, quotas: object|null}>}
 */
export async function getLoginUser(client, { email }) {
  if (!email) throw new Error(t("domain.account.emailRequired"));
  // biz3 は op を付けない (useStripeInfo.js:192-194)。応答も action のみで判定される
  // ため、request の key は "biz3GetLoginUser:" (op 空) で一致する。
  const resp = await client.request({ action: ACT_LOGIN, email }, DEFAULT_TIMEOUT_MS);
  assertSuccess(resp, "getLoginUser");
  return {
    customerInfo: resp?.data?.customerInfo ?? null,
    quotas: resp?.data?.quotas ?? null,
  };
}
