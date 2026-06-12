// 会社管理 (biz3ManageCompany)。
//
// Ported from biz3 (CANDY-HOUSE/biz3, MIT):
//   - vendor reference: references_web/src/api/useStripeInfo.js
//   - vendor reference: references_web/src/components/biz/layout/index.js (add 引数の出所)
//
// 注: これは「認証」ではなく「ログイン済みセッションで自分の会社情報を引く op」。
//     認証フロー (Cognito client / refresh / DEVICE_KEY 永続化) は auth.js のまま
//     アプリ寄せを維持しており、ここは一切関与しない。
//
// biz3ManageCompany の 4 op (biz3GetLoginUser は account.js 側で実装済みのため除外):
//   - get             : 会社一覧取得。フレーム = {action, op:'get'} (フラット)
//   - updateName      : 会社名変更。 フレーム = {action, obj:{companyID,name}, op}
//   - add             : 会社新規登録。フレーム = {action, name, employeeEmail, subUUID, op}
//   - getPaymentConfig: 課金レベル設定取得。フレーム = {action, companyID, op}
//
// いずれも純 JSON の WS フレームで、バイナリ packing / checksum / UUID 大文字化等は無い
// (useStripeInfo.js は company op に対しそうした加工を一切しない)。
//
// 応答ルーティング: biz3 は handleCompaniesResponse の switch (useStripeInfo.js:156-185)
// で action='biz3ManageCompany' + op の組で受ける。get/updateName/add は switch case で
// 直接処理 (setCompanies)、getPaymentConfig は switch case が無く invokeCallbacks(message)
// で op 単位コールバックへ委譲する。いずれも応答は同 action+op で同期的に返るため、
// CLI 側では client.request({action, op, ...}) (action+op 一致応答待ち) で受ける。

import { ACTION_TYPES } from "./vendor/biz3/constants/messageConstants.js";
import { assertSuccess, badRequest } from "./util.js";

// action 文字列は vendor (biz3 messageConstants) から引く (手書きしない)。
// messageConstants.js:5 BIZ3_MANAGE_COMPANY = 'biz3ManageCompany'
const ACT_COMPANY = ACTION_TYPES.BIZ3_MANAGE_COMPANY; // "biz3ManageCompany"
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * ログインセッションのユーザに紐づく全 company の一覧を取得する。
 *
 * biz3 getCompanies (useStripeInfo.js:73-82): フレームは {action, op:'get'} のみで
 * companyID も email も送らない (obj ラップ無し)。応答は handleCompaniesResponse の
 * 'get' case (useStripeInfo.js:161-165) で message.success のとき message.data が
 * company オブジェクトの配列。各要素の確認済みフィールド:
 *   companyID, name, feeLevel{subscriptionId, isRootUser:bool, level:number},
 *   tag (配列。tag[0]==='オーナー' で isOwner 判定), isSesameApp:bool,
 *   employeeEmail, subUUID  (useStripeInfo.js:41-71, 277 で読み出しを確認)。
 *
 * 注: 応答は配列であって obj ラップではない。companyID は他 op
 * (updateName/getPaymentConfig) が要求する priorityCompanyId の一次データ。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{timeoutMs?:number}} [params]
 * @returns {Promise<object[]>} company オブジェクトの配列
 */
export async function getCompanies(client, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const resp = await client.request({ action: ACT_COMPANY, op: "get" }, timeoutMs);
  assertSuccess(resp, "getCompanies");
  // setCompanies(message.data) (useStripeInfo.js:163)。data は配列。
  return Array.isArray(resp?.data) ? resp.data : [];
}

/**
 * 会社名を変更する。
 *
 * biz3 updateCompanyName (useStripeInfo.js:293-305): フレームは
 * {action, obj:{companyID, name}, op:'updateName'} で、companyID/name は必ず obj の
 * 内側に入れる (トップレベルに companyID を置かない)。companyID は priorityCompanyId
 * (= get 応答から決まる優先会社の companyID)。
 *
 * 応答 (useStripeInfo.js:166-174): message.success のとき message.data === {companyID, name}
 * (更新後の値。配列ではない)。biz3 はこの companyID 一致の company の name を差し替える。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, name:string, timeoutMs?:number}} params
 * @returns {Promise<{companyID:string, name:string}|undefined>} 応答 data (更新後の {companyID, name})。
 *   サーバが data を返さなければ undefined (BIZ-10: 入力値での補完 = 応答の捏造はしない。
 *   biz3 も message.data をそのまま読むだけで補完しない)。
 */
export async function updateCompanyName(client, { companyID, name, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!companyID) throw badRequest("company.err.companyIDRequired");
  if (name == null) throw badRequest("company.err.nameRequired");
  const resp = await client.request(
    { action: ACT_COMPANY, obj: { companyID, name }, op: "updateName" },
    timeoutMs,
  );
  assertSuccess(resp, "updateCompanyName");
  // data は {companyID, name} (useStripeInfo.js:170)。
  // resp.data は WsMessage 上 unknown。上流形状を JSDoc cast で明示する (実機検証済の構造)。
  return /** @type {{companyID:string, name:string}|undefined} */ (resp.data);
}

/**
 * 会社を新規登録する。
 *
 * biz3 addCompany (useStripeInfo.js:307-320): フレームは
 * {action, name, employeeEmail, subUUID, op:'add'} とフラット展開 (obj ラップ無し)。
 * companyID は送らない (新規作成のため)。呼び出し元 (layout/index.js:300-309) では
 * name=入力会社名, employeeEmail=customerInfo.employeeEmail, subUUID=customerInfo.subUUID
 * を渡す。employeeEmail / subUUID はログインユーザの customerInfo (biz3GetLoginUser 応答)
 * 由来であり、CLI では既ログインユーザ情報から補完する必要がある。
 *
 * 応答 (useStripeInfo.js:175-179): message.success のとき message.data が新規 company
 * 1件で、biz3 は companies 配列に push する (setCompanies(prev => [...prev, message.data]))。
 * data は get の配列要素と同型 (companyID, name 等) と推定されるが、add 応答 data の
 * 個別フィールドは biz3 で読み出されておらず詳細は未確認 (push のみ)。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{name:string, employeeEmail:string, subUUID:string, timeoutMs?:number}} params
 * @returns {Promise<object|null>} 新規 company オブジェクト (応答 data。欠落時 null)
 */
export async function addCompany(client, { name, employeeEmail, subUUID, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!name) throw badRequest("company.err.nameRequired");
  if (!employeeEmail) throw badRequest("company.err.employeeEmailRequired");
  if (!subUUID) throw badRequest("company.err.subUUIDRequired");
  const resp = await client.request(
    { action: ACT_COMPANY, name, employeeEmail, subUUID, op: "add" },
    timeoutMs,
  );
  assertSuccess(resp, "addCompany");
  // resp.data は WsMessage 上 unknown。新規 company オブジェクト (object) として扱う。
  return /** @type {object|undefined} */ (resp.data) ?? null;
}

/**
 * 課金レベル設定 (料金プラン設定) を取得する。
 *
 * biz3 getLevelConfig (useStripeInfo.js:322-334): フレームは
 * {action, companyID:<priorityCompanyId>, op:'getPaymentConfig'} で companyID は
 * トップレベルに直接置く (obj ラップ無し)。companyID は priorityCompanyId
 * (get 応答由来の優先会社 ID)。
 *
 * 応答: handleCompaniesResponse の switch には case が無いが invokeCallbacks(message)
 * (useStripeInfo.js:159,331) で op 単位コールバックへ届く。応答 data の形は consumer で確定:
 *   { config, isYear, time, total, level, nextPrice }
 * (vendor 確認: biz/settings/index.js:91-95 setPaymentConfig({...res.data})、:60-66,120,148,280)。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, timeoutMs?:number}} params
 * @returns {Promise<{config:any,isYear:boolean,time:any,total:any,level:any,nextPrice:any}|null>}
 */
export async function getPaymentConfig(client, { companyID, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!companyID) throw badRequest("companyID required");
  const resp = await client.request(
    { action: ACT_COMPANY, companyID, op: "getPaymentConfig" },
    timeoutMs,
  );
  assertSuccess(resp, "getPaymentConfig");
  // resp.data は WsMessage 上 unknown。consumer (settings/index.js) 確定の形状へ cast。
  return /** @type {{config:any,isYear:boolean,time:any,total:any,level:any,nextPrice:any}|undefined} */ (
    resp?.data
  ) ?? null;
}

// 公開 op の allowlist (SesameHub3._bindNs / serve registry が参照する単一の真実)。
export const NAMESPACE_OPS = ["getCompanies", "updateCompanyName", "addCompany", "getPaymentConfig"];
