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
export function getCompanies(client: import("./transport.js").Hub3WsClient, { timeoutMs }?: {
    timeoutMs?: number;
}): Promise<object[]>;
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
 * @returns {Promise<{companyID:string, name:string}>} 更新後の {companyID, name}
 */
export function updateCompanyName(client: import("./transport.js").Hub3WsClient, { companyID, name, timeoutMs }: {
    companyID: string;
    name: string;
    timeoutMs?: number;
}): Promise<{
    companyID: string;
    name: string;
}>;
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
 * @returns {Promise<object>} 新規 company オブジェクト (応答 data)
 */
export function addCompany(client: import("./transport.js").Hub3WsClient, { name, employeeEmail, subUUID, timeoutMs }: {
    name: string;
    employeeEmail: string;
    subUUID: string;
    timeoutMs?: number;
}): Promise<object>;
/**
 * 課金レベル設定 (料金プラン設定) を取得する。
 *
 * biz3 getLevelConfig (useStripeInfo.js:322-334): フレームは
 * {action, companyID:<priorityCompanyId>, op:'getPaymentConfig'} で companyID は
 * トップレベルに直接置く (obj ラップ無し)。companyID は priorityCompanyId
 * (get 応答由来の優先会社 ID)。
 *
 * 応答: biz3 では handleCompaniesResponse の switch に getPaymentConfig case が無く、
 * invokeCallbacks(message) (useStripeInfo.js:159) で op 単位コールバックへ委譲される。
 * よって応答 data の構造はこのファイルからは未確認 (呼び出し側 cb 依存)。
 * action='biz3ManageCompany' + op='getPaymentConfig' で返る点のみ確定。
 *
 * 未確認: 応答 data のフィールド集合 (実機検証要)。本実装は resp.data をそのまま返す。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, timeoutMs?:number}} params
 * @returns {Promise<*>} 課金レベル設定 (応答 data。構造未確認)
 */
export function getPaymentConfig(client: import("./transport.js").Hub3WsClient, { companyID, timeoutMs }: {
    companyID: string;
    timeoutMs?: number;
}): Promise<any>;
export const NAMESPACE_OPS: string[];
//# sourceMappingURL=company.d.ts.map