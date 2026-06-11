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
import { assertSuccess, badRequest } from "./util.js";

const ACT_LOGIN = ACTION_TYPES.BIZ3_GET_LOGIN_INFO; // "biz3GetLoginUser"
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * biz3GetLoginUser の customerInfo。biz3 由来の動的 JSON で、companyID / subUUID /
 * subscriptionId / name 等が入る。client.js#refreshAccount が companyID / subUUID を読む。
 * @typedef {{
 *   companyID?: string,
 *   subUUID?: string,
 *   subscriptionId?: string,
 *   name?: string,
 * } & Record<string, unknown>} CustomerInfo
 */

/**
 * biz3GetLoginUser の quotas。biz3 由来の動的 JSON。
 * @typedef {Record<string, unknown>} Quotas
 */

/**
 * biz3GetLoginUser 応答の data ペイロード。
 * @typedef {{ customerInfo?: CustomerInfo | null, quotas?: Quotas | null }} LoginUserData
 */

/**
 * ログインユーザの customerInfo / quotas を取得する。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{email:string}} params  login に使った email (tokenStore の username)
 * @returns {Promise<{customerInfo: CustomerInfo|null, quotas: Quotas|null}>}
 */
export async function getLoginUser(client, { email }) {
  if (!email) throw badRequest("domain.account.emailRequired");
  // biz3 は op を付けない (useStripeInfo.js:192-194)。応答も action のみで判定される
  // ため、request の key は "biz3GetLoginUser:" (op 空) で一致する。
  const resp = await client.request({ action: ACT_LOGIN, email }, DEFAULT_TIMEOUT_MS);
  assertSuccess(resp, "getLoginUser");
  // resp.data は transport 上 unknown。biz3 応答形状にナロー化する。
  const data = /** @type {LoginUserData | undefined} */ (resp?.data);
  return {
    customerInfo: data?.customerInfo ?? null,
    quotas: data?.quotas ?? null,
  };
}

// ---------- 純関数: アクセス権タグ補完 / 優先会社の選定 (BIZ-11) ----------
//
// web (biz3) はログイン直後に customerInfo を newTags() で補正し (useStripeInfo.js:85-98)、
// getCompanies() の結果から priorityCompany を選んで以後の companyID 既定
// (priorityCompanyId) に使う (useStripeInfo.js:41-67)。kit の CLI/namespace は
// 「config.companyID 既定、--customer-id / params.companyID 上書き」を既定とするが、
// web と同じ優先会社選定をしたい利用者向けに同じ計算を純関数として公開する。

/**
 * biz3 のページ名定数 (アクセス権タグの実値)。サーバ/DB に入る値は日本語文字列そのもの。
 * 1:1 移植元: references_web/src/utils/gUtils.js:134-149 (pageNames)。
 */
export const PAGE_NAMES = Object.freeze({
  members: "ユーザー",
  membersGroup: "ユーザーグループ",
  membersRole: "ロール",
  historys: "全体履歴",
  scheduleList: "予約一覧",
  developer: "開発者向け",
  cards: "カード管理",
  devices: "デバイス（ドア・認証機器）",
  touchDevices: "認証機器",
  ssmDevices: "ドア",
  ssmDevicesGroup: "ドアグループ",
  appDevices: "セサミ",
  appContacts: "連絡先",
  appMe: "自分",
});

/**
 * オーナー/マネージャーに付与される全アクセス権タグ。
 * 1:1 移植元: references_web/src/utils/gUtils.js:246 (allTags)。
 */
export const ALL_TAGS = Object.freeze([
  PAGE_NAMES.members,
  PAGE_NAMES.devices,
  PAGE_NAMES.cards,
  PAGE_NAMES.historys,
  PAGE_NAMES.developer,
]);

/**
 * customerInfo の tag からアクセス権 (access) を補完する純関数。
 * 1:1 移植元: useStripeInfo.js:28-39 (newTags)。
 *   - isSesameApp: access に「開発者向け」を追加
 *   - tag[0] が 'オーナー' / 'マネージャー': access を allTags で置換
 *   - それ以外: そのまま返す
 * 注: isSesameApp かつ access 欠落の場合は web 同様 TypeError になる (スプレッド対象が
 *     undefined)。参照と同じ前提 (customerInfo.access は配列) で呼ぶこと。
 * @template {{isSesameApp?:boolean, tag?:string[], access?:string[]}} T
 * @param {T|null|undefined} customerInfo
 * @returns {T|null|undefined} 補完済みコピー (補完不要なら入力をそのまま返す)
 */
export function newTags(customerInfo) {
  if (!customerInfo) return customerInfo;
  if (customerInfo.isSesameApp) {
    return { ...customerInfo, access: [.../** @type {string[]} */ (customerInfo.access), PAGE_NAMES.developer] };
  }
  if (customerInfo.tag && customerInfo.tag.length > 0) {
    if (customerInfo.tag[0] === "オーナー" || customerInfo.tag[0] === "マネージャー") {
      return { ...customerInfo, access: /** @type {string[]} */ ([...ALL_TAGS]) };
    }
  }
  return customerInfo;
}

/**
 * web の「優先会社」選定 (payment/company 系 op の companyID 既定 = priorityCompanyId の
 * 一次計算)。1:1 移植元: useStripeInfo.js:41-63 (priorityCompany useMemo)。
 *   - 非 isSesameApp: customerInfo.companyID に一致する company の feeLevel.subscriptionId を
 *     customerInfo に合成して返す。
 *   - isSesameApp: companies 空なら {}。feeLevel.isRootUser === true の company があればそれ、
 *     無ければ非 isSesameApp の company から feeLevel.level 最大のものを選び、いずれも
 *     feeLevel を展開して返す。
 * 注 (参照からの逸脱): isSesameApp で候補が 1 件も無い場合、web は `null.feeLevel` で
 *     TypeError になる (useStripeInfo.js:60-62)。ライブラリでクラッシュさせないため
 *     ここでは {} を返す (この 1 点のみ意図的逸脱)。
 * @param {{isSesameApp?:boolean, companyID?:string} & Record<string, unknown>} customerInfo
 *   getLoginUser の customerInfo (web は INIT_CUSTOMER で常に object)。
 * @param {Array<{companyID?:string, isSesameApp?:boolean, feeLevel?:{subscriptionId?:string, isRootUser?:boolean, level?:number}} & Record<string, unknown>>} companies
 *   getCompanies (company.js) の応答配列。
 * @returns {Record<string, unknown>} 優先会社 (companyID を含む合成 object。候補無しは {})
 */
export function priorityCompany(customerInfo, companies) {
  if (!customerInfo.isSesameApp) {
    const target = companies.find((company) => company.companyID === customerInfo.companyID);
    return {
      ...customerInfo,
      subscriptionId: target?.feeLevel?.subscriptionId,
    };
  }
  if (companies.length === 0) return {};
  const rootUser = companies.find((company) => company.feeLevel?.isRootUser === true);
  if (rootUser) {
    return {
      ...rootUser,
      ...rootUser.feeLevel,
    };
  }
  const maxLevelUser = companies
    .filter((c) => !c.isSesameApp)
    .reduce(
      (max, c) => (!max || /** @type {number} */ (c.feeLevel?.level) > /** @type {number} */ (max.feeLevel?.level) ? c : max),
      /** @type {(typeof companies)[number]|null} */ (null),
    );
  if (!maxLevelUser) return {}; // 逸脱: web は null.feeLevel で TypeError (上記 JSDoc 参照)
  return {
    ...maxLevelUser,
    ...maxLevelUser.feeLevel,
  };
}

/**
 * priorityCompany の companyID だけを返すショートカット。
 * 1:1 移植元: useStripeInfo.js:65-67 (priorityCompanyId useMemo)。
 * @param {Parameters<typeof priorityCompany>[0]} customerInfo
 * @param {Parameters<typeof priorityCompany>[1]} companies
 * @returns {string|null}
 */
export function priorityCompanyId(customerInfo, companies) {
  return /** @type {string|undefined} */ (priorityCompany(customerInfo, companies)?.companyID) ?? null;
}
