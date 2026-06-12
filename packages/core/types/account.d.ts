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
export function getLoginUser(client: import("./transport.js").Hub3WsClient, { email }: {
    email: string;
}): Promise<{
    customerInfo: CustomerInfo | null;
    quotas: Quotas | null;
}>;
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
export function newTags<T extends {
    isSesameApp?: boolean;
    tag?: string[];
    access?: string[];
}>(customerInfo: T | null | undefined): T | null | undefined;
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
export function priorityCompany(customerInfo: {
    isSesameApp?: boolean;
    companyID?: string;
} & Record<string, unknown>, companies: Array<{
    companyID?: string;
    isSesameApp?: boolean;
    feeLevel?: {
        subscriptionId?: string;
        isRootUser?: boolean;
        level?: number;
    };
} & Record<string, unknown>>): Record<string, unknown>;
/**
 * priorityCompany の companyID だけを返すショートカット。
 * 1:1 移植元: useStripeInfo.js:65-67 (priorityCompanyId useMemo)。
 * @param {Parameters<typeof priorityCompany>[0]} customerInfo
 * @param {Parameters<typeof priorityCompany>[1]} companies
 * @returns {string|null}
 */
export function priorityCompanyId(customerInfo: Parameters<typeof priorityCompany>[0], companies: Parameters<typeof priorityCompany>[1]): string | null;
/**
 * biz3 のページ名定数 (アクセス権タグの実値)。サーバ/DB に入る値は日本語文字列そのもの。
 * 1:1 移植元: references_web/src/utils/gUtils.js:134-149 (pageNames)。
 */
export const PAGE_NAMES: Readonly<{
    members: "ユーザー";
    membersGroup: "ユーザーグループ";
    membersRole: "ロール";
    historys: "全体履歴";
    scheduleList: "予約一覧";
    developer: "開発者向け";
    cards: "カード管理";
    devices: "デバイス（ドア・認証機器）";
    touchDevices: "認証機器";
    ssmDevices: "ドア";
    ssmDevicesGroup: "ドアグループ";
    appDevices: "セサミ";
    appContacts: "連絡先";
    appMe: "自分";
}>;
/**
 * オーナー/マネージャーに付与される全アクセス権タグ。
 * 1:1 移植元: references_web/src/utils/gUtils.js:246 (allTags)。
 */
export const ALL_TAGS: readonly ("ユーザー" | "全体履歴" | "開発者向け" | "カード管理" | "デバイス（ドア・認証機器）")[];
/**
 * biz3GetLoginUser の customerInfo。biz3 由来の動的 JSON で、companyID / subUUID /
 * subscriptionId / name 等が入る。client.js#refreshAccount が companyID / subUUID を読む。
 */
export type CustomerInfo = {
    companyID?: string;
    subUUID?: string;
    subscriptionId?: string;
    name?: string;
} & Record<string, unknown>;
/**
 * biz3GetLoginUser の quotas。biz3 由来の動的 JSON。
 */
export type Quotas = Record<string, unknown>;
/**
 * biz3GetLoginUser 応答の data ペイロード。
 */
export type LoginUserData = {
    customerInfo?: CustomerInfo | null;
    quotas?: Quotas | null;
};
//# sourceMappingURL=account.d.ts.map