/**
 * Kotlin SDK の CHAPIClient#biometricsOperation と同じ POST /device/v1/biometrics transport。
 *
 * 認可は公式アプリと同じ「SigV4 (Cognito Identity Pool の一時 credentials) + x-api-key +
 * appidentifyid」(REFACTORING_PLAN P2-1 / BIZ-07。基盤 = src/aws-credentials.js + src/sigv4.js):
 *   - ApiClientConfigBuilder.kt:34-46 — credentialsProvider + apiKey + region
 *   - BaseApp.kt:95-102 — credentialsProvider = AWSMobileClient.getInstance(),
 *     apiKey = BuildConfig.API_GATEWAY_API_KEY
 *   - ホストは app.properties:3 (https://app.candyhouse.co/prod) を既定とする。
 * credentialsProvider か getIdToken (idToken 供給コールバック) のどちらかで SigV4 経路になる。
 *
 * 互換 (非推奨): authorization / bearerToken / authorizationProvider は Authorization ヘッダを
 * そのまま付ける旧経路。参照 SDK に idToken Bearer の REST 認可は存在せず実 API Gateway
 * (IAM 認可) には拒否される見込みのため、SesameClient (client.js:921) が SigV4 へ移行する
 * までの互換注入口としてのみ残す。
 *
 * @experimental SigV4 経路の実機 API Gateway での受理は未検証 (REFACTORING_PLAN §9 V4/V5)。
 *
 * @param {BiometricsAuthOptions} opts
 * @returns {BiometricsTransport}
 */
export function makeBiometricsTransport({ baseUrl, credentialsProvider, getIdToken, appIdentifyId, config, configStore, apiKey, authorization, bearerToken, authorizationProvider, fetchImpl, }?: BiometricsAuthOptions): BiometricsTransport;
/**
 * 対象デバイスの NFC カード一覧を取得する。
 * 応答は op='pubCardLinkedIDs' の async push で deviceUUID/page ごとに届くため、
 * 内部で集約してから完了通知 or timeout で確定する (useManageAuthData.js:50-191)。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{deviceUUIDs:string[], timeoutMs?:number}} params
 * @returns {Promise<{byDevice: Record<string, object[]>, items: object[]}>}
 *   items の各要素: { cardID, nameUUID, name, cardType, subUUID, ..., uuids:string[] }
 */
export function getCards(client: import("./transport.js").Hub3WsClient, { deviceUUIDs, timeoutMs }: {
    deviceUUIDs: string[];
    timeoutMs?: number;
}): Promise<{
    byDevice: Record<string, object[]>;
    items: object[];
}>;
/**
 * 対象デバイスの暗証番号 (passcode) 一覧を取得する。getCards と同型。
 * 応答データ本体は op='pubPasscodeLinkedIDs' で届く (useManageAuthData.js:189-191)。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{deviceUUIDs:string[], timeoutMs?:number}} params
 * @returns {Promise<{byDevice: Record<string, object[]>, items: object[]}>}
 *   items の各要素: { passwordID, keyBoardPassCode, keyBoardPassCodeNameUUID, name, nameUUID, subUUID, ..., uuids:string[] }
 */
export function getPasscodes(client: import("./transport.js").Hub3WsClient, { deviceUUIDs, timeoutMs }: {
    deviceUUIDs: string[];
    timeoutMs?: number;
}): Promise<{
    byDevice: Record<string, object[]>;
    items: object[];
}>;
/**
 * カードをサーバ DB に登録する (postCards)。
 *
 * ⚠️ getCards/clearCards と異なり obj でラップせず、deviceUUID と list を
 *    トップレベルに置く非対称構造 (useManageAuthData.js:379-394)。混同しないこと。
 * ⚠️ これは「DB への登録」のみ。実ファームウェア書き込みは別途 BLE
 *    (SesameBle.biometric.cardAdd / cardBatchAdd, src/ble/biometric.js) で行う 2 段構造。
 *    list.length < 1 なら何もしない (biz3:381)。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{deviceUUID:string, list:object[], timeoutMs?:number}} params
 *   list 要素: { cardID, nameUUID, name, cardType, memberID? } 等 (cards/index.js:268-286)
 * @returns {Promise<object|null>} 応答メッセージ。list 空のときは null。
 */
export function postCards(client: import("./transport.js").Hub3WsClient, { deviceUUID, list, timeoutMs }: {
    deviceUUID: string;
    list: object[];
    timeoutMs?: number;
}): Promise<object | null>;
/**
 * パスコードをサーバ DB に登録する (postPasscodes)。postCards と同型 (useManageAuthData.js:396-411)。
 * obj ラップ無し、deviceUUID と list をトップレベルに置く。list.length < 1 なら何もしない。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{deviceUUID:string, list:object[], timeoutMs?:number}} params
 *   list 要素の正確なフィールドは biz3 のこのファイル内では未確認 (UI 由来)。getPasscodes 応答 item
 *   (passwordID 等) と対応すると推測される。**未確認: 実機検証要**。
 * @returns {Promise<object|null>}
 */
export function postPasscodes(client: import("./transport.js").Hub3WsClient, { deviceUUID, list, timeoutMs }: {
    deviceUUID: string;
    list: object[];
    timeoutMs?: number;
}): Promise<object | null>;
/**
 * カードをサーバ DB から削除する (delCards)。
 *
 * ⚠️ obj/deviceUUID ラップ無し、items 配列をトップレベルに置く (useManageAuthData.js:355-365)。
 *    items 要素は { deviceID, cardID } (deviceUUID ではなく deviceID)。
 * ⚠️ これは「BLE 削除 ack 後の DB 後始末」。実削除は BLE
 *    (SesameBle.biometric.cardDelete, src/ble/biometric.js) 経由で行う 2 段構造。
 *    !items.length なら何もしない (biz3:356)。
 * ⚠️ biz3 では delCards に応答ハンドラもコールバック登録も無い (useManageAuthData.js:265-267)。
 *    サーバは応答 op を返さないため、request で待つと必ず timeout する。biz3 と同じく
 *    **fire-and-forget (send)** にする。!items.length なら何もしない。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{items:Array<{deviceID:string, cardID:string}>}} params
 * @returns {boolean} 送信したら true、items 空で何もしなければ false
 */
export function delCards(client: import("./transport.js").Hub3WsClient, { items }: {
    items: Array<{
        deviceID: string;
        cardID: string;
    }>;
}): boolean;
/**
 * パスコードをサーバ DB から削除する (delPasscodes)。delCards と同型 (useManageAuthData.js:367-377)。
 * items 要素は { deviceID, passwordID }。!items.length なら何もしない。
 *
 * ⚠️ biz3 では delPasscodes の応答ハンドラに専用 case が無く default に落ちる (272-273)。
 *    = 専用応答を期待していない。delCards と同様 **fire-and-forget (send)** にする
 *    (request で待つと応答 op が来ず timeout する)。!items.length なら何もしない。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{items:Array<{deviceID:string, passwordID:string}>}} params
 * @returns {boolean} 送信したら true、items 空で何もしなければ false
 */
export function delPasscodes(client: import("./transport.js").Hub3WsClient, { items }: {
    items: Array<{
        deviceID: string;
        passwordID: string;
    }>;
}): boolean;
/**
 * 指定デバイスのカードを全削除する (clearCards)。
 *
 * ⚠️ obj.devices は **単一 deviceUUID 文字列** (getCards のようなカンマ連結ではない:
 *    useManageAuthData.js:295-311)。!deviceUUID なら何もしない。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{deviceUUID:string, timeoutMs?:number}} params
 * @returns {Promise<object|null>}
 */
export function clearCards(client: import("./transport.js").Hub3WsClient, { deviceUUID, timeoutMs }: {
    deviceUUID: string;
    timeoutMs?: number;
}): Promise<object | null>;
/**
 * 指定デバイスのパスコードを全削除する (clearPasscodes)。clearCards と同型。
 * obj.devices は単一 deviceUUID 文字列 (useManageAuthData.js:313-329)。
 * 注: biz3 の関数名は clearPasswords だが op は 'clearPasscodes'。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{deviceUUID:string, timeoutMs?:number}} params
 * @returns {Promise<object|null>}
 */
export function clearPasscodes(client: import("./transport.js").Hub3WsClient, { deviceUUID, timeoutMs }: {
    deviceUUID: string;
    timeoutMs?: number;
}): Promise<object | null>;
/**
 * カード名 (と nameUUID) を更新する (updateCardName)。
 *
 * biz3 handlePutCardName (useManageAuthData.js:331-344) は { action, obj:{...item}, op } を送る。
 * item には { cardID, name, cardNameUUID, timestamp, cardType, stpDeviceUUID } を入れる
 * (carddetails.js:79-87,177-184)。応答は reqContext に送ったフィールドが echo back される
 * (useManageAuthData.js:192-234)。
 *
 * ⚠️ biz3 の updateItemName (438-471) は **cardNameUUID が UUIDv4 形式でない場合**、
 *    WS を直接投げず先に BLE (SSM_OS3_CARD_CHANGE=107) で nameUUID を v4 化する分岐がある。
 *    その BLE payload 構築は SesameBle.biometric.cardChange (CARD_CHANGE=107, src/ble/biometric.js)
 *    の責務。本関数は **WS の updateCardName 送信のみ** を行う。CLI で BLE 前段を回避するには、
 *    呼び出し側が cardNameUUID に v4 UUID を渡すこと (crypto.generateUUID() で生成可)。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{item:object, timeoutMs?:number}} params
 *   item: { cardID, name, cardNameUUID, timestamp?, cardType?, stpDeviceUUID }
 * @returns {Promise<object>} 応答メッセージ (reqContext 含む)
 */
export function updateCardName(client: import("./transport.js").Hub3WsClient, { item, timeoutMs }: {
    item: object;
    timeoutMs?: number;
}): Promise<object>;
/**
 * パスコード名 (と nameUUID) を更新する (updatePasscodeName)。updateCardName と同型。
 * item には { stpDeviceUUID, keyBoardPassCode, keyBoardPassCodeNameUUID, name } を入れる
 * (useManageAuthData.js:201-210,331-344)。
 *
 * ⚠️ keyBoardPassCodeNameUUID が UUIDv4 形式でない場合、biz3 は先に BLE
 *    (SSM_OS3_PASSCODE_CHANGE=123) で v4 化する分岐がある
 *    (SesameBle.biometric.passcodeChange, src/ble/biometric.js の責務)。
 *    本関数は WS 送信のみ。v4 UUID を渡せば BLE 前段を回避できる。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{item:object, timeoutMs?:number}} params
 *   item: { stpDeviceUUID, keyBoardPassCode, keyBoardPassCodeNameUUID, name }
 * @returns {Promise<object>}
 */
export function updatePasscodeName(client: import("./transport.js").Hub3WsClient, { item, timeoutMs }: {
    item: object;
    timeoutMs?: number;
}): Promise<object>;
/**
 * カードの所有者 (メンバー) を割り当てる (updateCardOwner)。これは WS のみで完結 (BLE 不要)。
 *
 * biz3 (useManageAuthData.js:346-353) は 'ownerSubUUID' in item の時だけ送る。
 * ownerSubUUID は割り当てるメンバーの subUUID。空文字 '' でも送信 = 未割当解除。
 * frame は { action, obj:{ cardID, ownerSubUUID }, op:'updateCardOwner' }。
 * 応答は reqContext:{ cardID, ownerSubUUID } を echo back (235-259)。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{cardID:string, ownerSubUUID:string, timeoutMs?:number}} params
 *   ownerSubUUID は省略 (undefined) すると送信しない (null 相当)。'' は送信して未割当解除。
 * @returns {Promise<object|null>} ownerSubUUID 未指定なら null。
 */
export function updateCardOwner(client: import("./transport.js").Hub3WsClient, { cardID, ownerSubUUID, timeoutMs }: {
    cardID: string;
    ownerSubUUID: string;
    timeoutMs?: number;
}): Promise<object | null>;
/**
 * Kotlin SDK CHDataSynchronizeCapable.postAuthenticationData と同じ REST 操作。
 * body = { op: `${operation}_post`, deviceID, items } を POST /device/v1/biometrics へ送る。
 *
 * @param {import("./transport.js").Hub3WsClient|null} _client WS 互換のため未使用
 * @param {AuthDataParams} params
 * @returns {Promise<object[]|object>} SDK と同じく response.data.items があればそれを返し、無ければ応答全体
 */
export function postAuthenticationData(_client: import("./transport.js").Hub3WsClient | null, params: AuthDataParams): Promise<object[] | object>;
/**
 * Kotlin SDK CHDataSynchronizeCapable.putAuthenticationData と同じ REST 操作。
 * body = { op: `${operation}_put`, deviceID, items }。
 * @param {import("./transport.js").Hub3WsClient|null} _client WS 互換のため未使用
 * @param {AuthDataParams} params
 */
export function putAuthenticationData(_client: import("./transport.js").Hub3WsClient | null, params: AuthDataParams): Promise<any>;
/**
 * Kotlin SDK CHDataSynchronizeCapable.deleteAuthenticationData と同じ REST 操作。
 * body = { op: `${operation}_delete`, deviceID, items }。
 * @param {import("./transport.js").Hub3WsClient|null} _client WS 互換のため未使用
 * @param {AuthDataParams} params
 */
export function deleteAuthenticationData(_client: import("./transport.js").Hub3WsClient | null, params: AuthDataParams): Promise<any>;
/**
 * Kotlin SDK CHDataSynchronizeCapable.updateAuthenticationName と同じ REST 操作。
 * CHAuthenticationNameRequest.* が作る request object をそのまま POST /device/v1/biometrics へ送る。
 * 便利指定として `kind` を渡すと SDK companion の既定 op を補完する。
 *
 * @param {import("./transport.js").Hub3WsClient|null} _client WS 互換のため未使用
 * @param {UpdateAuthNameParams} params
 */
export function updateAuthenticationName(_client: import("./transport.js").Hub3WsClient | null, params: UpdateAuthNameParams): Promise<any>;
/**
 * createEnrollCollector の records ({cardID, cardName, cardType}) を postCards/postPasscodes の
 * list 要素 ({ cardID, name, cardType, nameUUID }) へ写像する純関数。
 *
 * ⚠️ 未確認 (実機検証要): NOTIFY 由来の cardName は hex 文字列で届くため、ここでは
 *   name にはそのまま cardName を載せる。DB が要求する nameUUID は BLE publish には含まれない
 *   ため、欠落時は v4 UUID を新規採番する (updateCardName の v4 要件と同じ流儀)。
 *   表示名や既存 nameUUID との突き合わせが必要な運用では呼び出し側で list を補正すること。
 *
 * @param {Array<{cardID:string, cardName:string, cardType:number}>} records
 * @returns {Array<{cardID:string, name:string, cardType:number, nameUUID:string}>}
 */
export function enrolledToCardList(records: Array<{
    cardID: string;
    cardName: string;
    cardType: number;
}>): Array<{
    cardID: string;
    name: string;
    cardType: number;
    nameUUID: string;
}>;
/**
 * enroll records を postPasscodes 用 list に写像する。
 * 参照元 UI は passcode identity に `passwordID` を使い、名前更新では
 * `keyBoardPassCode` / `keyBoardPassCodeNameUUID` を使う。カード形状は流用しない。
 *
 * @param {Array<{cardID?:string,passwordID?:string,cardName?:string,name?:string,cardType?:number,type?:number}>} records
 * @returns {Array<{passwordID:string,keyBoardPassCode:string,name:string,nameUUID:string,keyBoardPassCodeNameUUID:string,type:number}>}
 */
export function enrolledToPasscodeList(records: Array<{
    cardID?: string;
    passwordID?: string;
    cardName?: string;
    name?: string;
    cardType?: number;
    type?: number;
}>): Array<{
    passwordID: string;
    keyBoardPassCode: string;
    name: string;
    nameUUID: string;
    keyBoardPassCodeNameUUID: string;
    type: number;
}>;
/**
 * BLE で実機登録 (タップ) されたカードの集約結果を DB へ同期する (postCards への委譲)。
 * BiometricCommands.onEnroll の onEnrolled({kind:'card', records}) からそのまま呼べる。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{deviceUUID:string, records:Array<{cardID:string,cardName:string,cardType:number}>, list?:object[], timeoutMs?:number}} params
 *   list を渡せば変換をスキップしてそのまま postCards へ流す (呼び出し側で補正したい場合)。
 *   省略時は records を enrolledToCardList で変換する。
 * @returns {Promise<object|null>} postCards の戻り (list 空のときは null)
 */
export function syncEnrolledCards(client: import("./transport.js").Hub3WsClient, { deviceUUID, records, list, timeoutMs }: {
    deviceUUID: string;
    records: Array<{
        cardID: string;
        cardName: string;
        cardType: number;
    }>;
    list?: object[];
    timeoutMs?: number;
}): Promise<object | null>;
/**
 * BLE で実機登録された暗証番号の集約結果を DB へ同期する (postPasscodes への委譲)。
 * syncEnrolledCards と同型。
 *
 * ⚠️ postPasscodes の list 要素は biz3 上未確認 (access.js:222 参照) のため、records からの
 *   自動変換は **誇張せず** enrolledToCardList と同じ最小写像に留める。確実な運用には
 *   呼び出し側が list を組み立てて渡すこと。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{deviceUUID:string, records:Array<{cardID:string,cardName:string,cardType:number}>, list?:object[], timeoutMs?:number}} params
 * @returns {Promise<object|null>}
 */
export function syncEnrolledPasscodes(client: import("./transport.js").Hub3WsClient, { deviceUUID, records, list, timeoutMs }: {
    deviceUUID: string;
    records: Array<{
        cardID: string;
        cardName: string;
        cardType: number;
    }>;
    list?: object[];
    timeoutMs?: number;
}): Promise<object | null>;
export const NAMESPACE_OPS: string[];
/**
 * REST /device/v1/biometrics transport の 1 リクエスト/応答。
 */
export type BiometricsTransport = (req: {
    method: string;
    path: string;
    body?: object;
}) => Promise<{
    status: number;
    text: string;
    json: any;
}>;
/**
 * 認証情報を含む biometrics transport 構築オプション。
 * 正準は SigV4 (credentialsProvider / getIdToken)。authorization 系は参照に無い互換注入口
 * (非推奨。makeBiometricsTransport の注記参照)。
 */
export type BiometricsAuthOptions = {
    /**
     * 既製 transport を注入 (テスト/特殊環境用)。
     */
    transport?: BiometricsTransport | undefined;
    /**
     * REST ルート URL (https のみ。既定 https://app.candyhouse.co/prod)。
     */
    baseUrl?: string | undefined;
    /**
     * Identity Pool 一時 credentials の供給元。
     */
    credentialsProvider?: import("./aws-credentials.js").CredentialsProviderLike | undefined;
    /**
     * idToken 供給コールバック (credentialsProvider を内部構築)。
     */
    getIdToken?: (() => Promise<string>) | undefined;
    /**
     * appidentifyid ヘッダ値 (省略時 config から解決/生成)。
     */
    appIdentifyId?: string | null | undefined;
    /**
     * appIdentifyId の保存先 config。
     */
    config?: import("./aws-credentials.js").AppIdConfigLike | null | undefined;
    /**
     * appIdentifyId を即永続化する store。
     */
    configStore?: import("./aws-credentials.js").AppIdConfigStoreLike | null | undefined;
    /**
     * x-api-key (省略時 app.properties:5 の実値)。
     */
    apiKey?: string | undefined;
    /**
     * [非推奨] 完成済み Authorization ヘッダ値。
     */
    authorization?: string | undefined;
    /**
     * [非推奨] Bearer トークン (ヘッダ未指定時)。
     */
    bearerToken?: string | undefined;
    /**
     * [非推奨] 都度 Authorization を解決する関数。
     */
    authorizationProvider?: (() => Promise<string>) | undefined;
    /**
     * fetch 実装 (テスト差し替え用)。
     */
    fetchImpl?: typeof fetch | undefined;
};
/**
 * postAuthenticationData/putAuthenticationData/deleteAuthenticationData の params。
 * operation/deviceID は実行時に検証 (withSuffix が欠落で throw) するため型上は optional。
 */
export type AuthDataParams = BiometricsAuthOptions & {
    operation?: string;
    deviceID?: string;
    items?: object[];
};
/**
 * updateAuthenticationName の params。request を直接渡すか kind から組み立てる。
 */
export type UpdateAuthNameParams = BiometricsAuthOptions & {
    request?: object;
    kind?: "card" | "face" | "fingerPrint" | "palm" | "passcode";
    timestamp?: number;
    subUUID?: string;
    stpDeviceUUID?: string;
    name?: string;
    nameUUID?: string;
    op?: string;
    type?: number;
    cardType?: number;
    cardNameUUID?: string;
    cardID?: string;
    faceNameUUID?: string;
    faceID?: string;
    fingerPrintNameUUID?: string;
    fingerPrintID?: string;
    palmNameUUID?: string;
    palmID?: string;
    keyBoardPassCodeNameUUID?: string;
    keyBoardPassCode?: string;
};
//# sourceMappingURL=access.d.ts.map