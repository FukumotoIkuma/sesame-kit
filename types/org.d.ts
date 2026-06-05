/**
 * 社員一覧を取得する。
 *
 * biz3: get は ack のみで、実データは別 op 'pubEmployees' で page 単位に push される
 * (useManageEmployee.js:7,18-22,70-88)。各 push の data 形:
 *   message.data = { totalCount, data: { list, page } }
 * page===1 で全置換、page>1 で追記。本実装は totalCount と蓄積件数が一致するまで
 * (または次 chunk が来なくなるまで) 待ち、全 list を 1 配列で返す。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, timeoutMs?:number}} params
 * @returns {Promise<{count:number, list:any[]}>}  count=totalCount, list=全社員
 */
export function getEmployees(client: import("./transport.js").Hub3WsClient, { companyID, timeoutMs }: {
    companyID: string;
    timeoutMs?: number;
}): Promise<{
    count: number;
    list: any[];
}>;
/**
 * ログイン中の自分自身の社員情報を取得する。companyID も items も不要。
 * biz3: registerCallback(action,'currentInfo',cb) で同期受信 (useManageEmployee.js:187-197)。
 * @param {import("./transport.js").Hub3WsClient} client
 * @returns {Promise<object>} 応答 message (data 構造は biz3 では未確認: 呼出側 me/index.js 依存)
 */
export function getCurrentUserInfo(client: import("./transport.js").Hub3WsClient, { timeoutMs }?: {
    timeoutMs?: number;
}): Promise<object>;
/**
 * 社員を追加する。
 * biz3: { action, items, op:'add' }。items は配列で各要素内に companyID を入れる
 * (useManageEmployee.js:263-274, AddEmployee.js:64-78)。トップレベル companyID 無し。
 * 各 item 例: { employeeEmail, employeeName, phone, department, tag:[...], companyID }
 * (空 phone/department は undefined。tag はロール/タグ id の配列)。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{items:object[], timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message。success:false の場合 throw
 *   (message==='Limit Exceeded' でプラン上限 — :89-100)。
 */
export function addEmployees(client: import("./transport.js").Hub3WsClient, { items, timeoutMs }: {
    items: object[];
    timeoutMs?: number;
}): Promise<object>;
/**
 * 社員情報を更新する。
 * biz3: update のみ obj:{companyID,...data} でラップする (useManageEmployee.js:169-185)。
 * data は更新フィールド (例 { Name:'nickname', Value:newValue } — me/index.js:63)。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, data:object, timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export function updateEmployee(client: import("./transport.js").Hub3WsClient, { companyID, data, timeoutMs }: {
    companyID: string;
    data: object;
    timeoutMs?: number;
}): Promise<object>;
/**
 * 社員を削除する。
 * biz3: { action, items, op:'delete' }。items は社員オブジェクト配列または
 * [{ subUUID, companyID }] (useManageEmployee.js:199-210, EmployeeItem.js:219-225)。
 * トップレベル companyID 無し (companyID は要素内に含めるパターンあり)。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{items:object[], timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export function removeEmployees(client: import("./transport.js").Hub3WsClient, { items, timeoutMs }: {
    items: object[];
    timeoutMs?: number;
}): Promise<object>;
/**
 * 社員の並び順を更新する。
 * biz3: { action, items, op:'order' }。各要素 { friendUUID, rank }、rank は -index
 * (降順負値、MobileContacts.js:94-98)。friendUUID には社員の subUUID を入れる。
 * 注: handleEmployee に order の case が無く応答は no-op (一覧再取得もしない) のため、
 *     CLI でも ack を待つだけ (request)。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{items:{friendUUID:string, rank:number}[], timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export function reorderEmployees(client: import("./transport.js").Hub3WsClient, { items, timeoutMs }: {
    items: {
        friendUUID: string;
        rank: number;
    }[];
    timeoutMs?: number;
}): Promise<object>;
/**
 * CS (カスタマーサポート) 横断で社員/ユーザーを検索する。
 *
 * biz3: 送信 op は 'queryByCS' だが応答購読 op は 'pubQueryByCS' (useManageEmployee.js:391-416)。
 * page 単位の chunk が来るので page===totalPage まで蓄積し、全 list を返す。
 * 各 chunk: res.data = { data:{ list, page }, totalPage }。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{keyword:string, timeoutMs?:number}} params
 * @returns {Promise<any[]>} 全 chunk を結合した検索結果リスト
 */
export function queryByCS(client: import("./transport.js").Hub3WsClient, { keyword, timeoutMs }: {
    keyword: string;
    timeoutMs?: number;
}): Promise<any[]>;
/**
 * queryByCS で見つけたユーザーを確定する。
 * biz3: { action, email, op:'confirmQueryByCS' } (useManageEmployee.js:420-432)。
 * 注: 成功すると biz3 UI は現セッションを signout する設計 (CSUserSearchDialog.js:127)。
 *     CLI でこの op を投げる場合は副作用に注意。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{email:string, timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export function confirmQueryByCS(client: import("./transport.js").Hub3WsClient, { email, timeoutMs }: {
    email: string;
    timeoutMs?: number;
}): Promise<object>;
/**
 * 従業員グループ一覧を取得する。
 * biz3: { action, cid, op:'getGroups' }、応答 data=グループ配列 (useManageEmployee.js:25-33,47-49)。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, timeoutMs?:number}} params
 * @returns {Promise<any[]>} グループ配列
 */
export function getEmployeeGroups(client: import("./transport.js").Hub3WsClient, { companyID, timeoutMs }: {
    companyID: string;
    timeoutMs?: number;
}): Promise<any[]>;
/**
 * 従業員グループを追加する。
 * biz3: obj:{cid,...item} でラップ (useManageEmployee.js:212-228)。応答 data=追加グループ1件。
 * item の具体フィールド (グループ名等) は biz3 UI 依存で未確認。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, item:object, timeoutMs?:number}} params
 * @returns {Promise<object>} 追加されたグループ (resp.data)
 */
export function addEmployeeGroup(client: import("./transport.js").Hub3WsClient, { companyID, item, timeoutMs }: {
    companyID: string;
    item: object;
    timeoutMs?: number;
}): Promise<object>;
/**
 * 従業員グループ情報を更新する。
 * biz3: obj:{cid,...item} でラップ (useManageEmployee.js:230-246)。item に gid 等を含める想定。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, item:object, timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export function updateEmployeeGroup(client: import("./transport.js").Hub3WsClient, { companyID, item, timeoutMs }: {
    companyID: string;
    item: object;
    timeoutMs?: number;
}): Promise<object>;
/**
 * 従業員グループを削除する (複数可)。
 * biz3: { action, objs:<gids>, cid, op:'deleteGroups' } (useManageEmployee.js:248-261)。
 * objs はトップレベル配列。gids の各要素型は biz3 UI 依存で未確認。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, gids:any[], timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export function removeEmployeeGroups(client: import("./transport.js").Hub3WsClient, { companyID, gids, timeoutMs }: {
    companyID: string;
    gids: any[];
    timeoutMs?: number;
}): Promise<object>;
/**
 * 従業員グループに紐づくデバイスグループを取得する。
 * biz3: { action, gid, op:'getBindDeviceGroup' } — cid は送らない (useManageEmployee.js:321-334)。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{gid:string, timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message (data 構造は未確認)
 */
export function getEmployeeGroupBindDeviceGroup(client: import("./transport.js").Hub3WsClient, { gid, timeoutMs }: {
    gid: string;
    timeoutMs?: number;
}): Promise<object>;
/**
 * 従業員グループにユーザーを紐付ける。
 * biz3: { action, cid, gid, uuids, items, op:'addBindUser' } 全て直置き (useManageEmployee.js:336-352)。
 * uuids と items は別引数で両方送る。要素構造は biz3 UI 依存で未確認。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, gid:string, uuids:any[], items:any[], timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export function addEmployeeInGroup(client: import("./transport.js").Hub3WsClient, { companyID, gid, uuids, items, timeoutMs }: {
    companyID: string;
    gid: string;
    uuids: any[];
    items: any[];
    timeoutMs?: number;
}): Promise<object>;
/**
 * 従業員グループからユーザーを解除する。
 * biz3: items を {subUUID} のみに絞り込んで送る (useManageEmployee.js:354-373, :358-360)。
 * uuids は引数そのまま。cid/gid/uuids/items 全て直置き。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, gid:string, uuids:any[], items:{subUUID:string}[], timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export function removeEmployeeInGroup(client: import("./transport.js").Hub3WsClient, { companyID, gid, uuids, items, timeoutMs }: {
    companyID: string;
    gid: string;
    uuids: any[];
    items: {
        subUUID: string;
    }[];
    timeoutMs?: number;
}): Promise<object>;
/**
 * 従業員グループからデバイスグループを解除する。
 * biz3: { action, cid, ...data, op:'removeBindDeviceGroup' } (useManageEmployee.js:375-389)。
 * data の中身 (gid 等) は biz3 UI 依存で未確認。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, data:object, timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export function removeEmployeeGroupBindDeviceGroup(client: import("./transport.js").Hub3WsClient, { companyID, data, timeoutMs }: {
    companyID: string;
    data: object;
    timeoutMs?: number;
}): Promise<object>;
/**
 * 役割タグ一覧を取得する。
 * biz3: { action, companyID, op:'get' }、応答 data=タグ配列 (useManageEmployee.js:35-43,116-127)。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, timeoutMs?:number}} params
 * @returns {Promise<any[]>} タグ配列
 */
export function getTags(client: import("./transport.js").Hub3WsClient, { companyID, timeoutMs }: {
    companyID: string;
    timeoutMs?: number;
}): Promise<any[]>;
/**
 * 役割タグを追加/更新する。
 * biz3: { action, companyID, ...data, op:'post' } (useManageEmployee.js:289-303)。
 * op:'post' は ...data の後に置き、data 内の op を上書きする (順序が一次資料どおり重要)。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, data:object, timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export function postTag(client: import("./transport.js").Hub3WsClient, { companyID, data, timeoutMs }: {
    companyID: string;
    data: object;
    timeoutMs?: number;
}): Promise<object>;
/**
 * 役割タグを削除する。
 * biz3: { action, companyID, ...data, op:'delete' } (useManageEmployee.js:305-319)。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, data:object, timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export function removeTag(client: import("./transport.js").Hub3WsClient, { companyID, data, timeoutMs }: {
    companyID: string;
    data: object;
    timeoutMs?: number;
}): Promise<object>;
/**
 * デバイスグループ一覧を取得する。
 * biz3: { action, cid, op:'getGroups' }、応答 data=配列 (useManageGroup.js:11-19,27-33)。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, timeoutMs?:number}} params
 * @returns {Promise<any[]>} デバイスグループ配列
 */
export function getDeviceGroups(client: import("./transport.js").Hub3WsClient, { companyID, timeoutMs }: {
    companyID: string;
    timeoutMs?: number;
}): Promise<any[]>;
/**
 * デバイスグループを作成する。
 * biz3: obj:{name,cid,uuids} でラップ (useManageGroup.js:84-102)。
 * uuids は作成時に含めるデバイス UUID 配列。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, name:string, uuids:string[], timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export function addDeviceGroup(client: import("./transport.js").Hub3WsClient, { companyID, name, uuids, timeoutMs }: {
    companyID: string;
    name: string;
    uuids: string[];
    timeoutMs?: number;
}): Promise<object>;
/**
 * デバイスグループ情報を更新する。
 * biz3: obj:{cid,...item} でラップ (useManageGroup.js:310-326)。item に gid 等を含める想定。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, item:object, timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export function updateDeviceGroup(client: import("./transport.js").Hub3WsClient, { companyID, item, timeoutMs }: {
    companyID: string;
    item: object;
    timeoutMs?: number;
}): Promise<object>;
/**
 * デバイスグループを削除する (複数可)。
 * biz3: groupIds の各 obj に cid をマージした配列を objs(複数形) に入れる
 * (useManageGroup.js:67-82)。obj(単数) ではなく objs。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, groupIds:object[], timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export function removeDeviceGroups(client: import("./transport.js").Hub3WsClient, { companyID, groupIds, timeoutMs }: {
    companyID: string;
    groupIds: object[];
    timeoutMs?: number;
}): Promise<object>;
/**
 * デバイスグループにデバイスを紐付ける。
 * biz3: { action, cid, gid, uuids, items, op:'addBindDevice' } 全て直置き (useManageGroup.js:240-256)。
 * removeBindDevice と異なり items は絞り込まず透過する。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, gid:string, uuids:any[], items:any[], timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export function addDeviceInGroup(client: import("./transport.js").Hub3WsClient, { companyID, gid, uuids, items, timeoutMs }: {
    companyID: string;
    gid: string;
    uuids: any[];
    items: any[];
    timeoutMs?: number;
}): Promise<object>;
/**
 * デバイスグループからデバイスを解除する。
 * biz3: items を必ず {deviceUUID, secretKey} のみに絞り込んで送る (useManageGroup.js:218-238, :222-225)。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, gid:string, uuids:any[], items:{deviceUUID:string,secretKey:string}[], timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export function removeDeviceInGroup(client: import("./transport.js").Hub3WsClient, { companyID, gid, uuids, items, timeoutMs }: {
    companyID: string;
    gid: string;
    uuids: any[];
    items: {
        deviceUUID: string;
        secretKey: string;
    }[];
    timeoutMs?: number;
}): Promise<object>;
/**
 * デバイスグループにバインド済みの従業員グループを取得する。
 * biz3: { action, gid, op:'getBindUserGroup' } — cid 無し (useManageGroup.js:189-200)。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{gid:string, timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message (data 構造は未確認)
 */
export function getDeviceGroupBindUserGroup(client: import("./transport.js").Hub3WsClient, { gid, timeoutMs }: {
    gid: string;
    timeoutMs?: number;
}): Promise<object>;
/**
 * デバイスグループから従業員グループを解除する。
 * biz3: { action, cid, ...data, op:'removeBindUserGroup' } (useManageGroup.js:202-216)。
 * data の中身 (gid/uuids 等) は biz3 UI 依存で未確認。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, data:object, timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export function removeDeviceGroupBindUserGroup(client: import("./transport.js").Hub3WsClient, { companyID, data, timeoutMs }: {
    companyID: string;
    data: object;
    timeoutMs?: number;
}): Promise<object>;
/**
 * 従業員にデバイス鍵を共有する。
 * biz3: { action, items, op:'add' }、companyID 無し (useManageGroup.js:106-119)。
 * items は呼出側 (DeviceShare.js:65-76) で {...device, ...user, keyLevel, startTime, endTime}
 * を生成。keyLevel: 0=owner,1=manager,2=guest。startTime/endTime は keyLevel==2 一時利用時のみ
 * epoch 秒、それ以外は空文字 ''。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{items:object[], timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export function shareDeviceKeysToEmployees(client: import("./transport.js").Hub3WsClient, { items, timeoutMs }: {
    items: object[];
    timeoutMs?: number;
}): Promise<object>;
/**
 * 従業員グループにデバイスグループ鍵を共有する。
 * biz3: { action, ...item, companyID, op:'group' } (useManageGroup.js:121-135)。
 * companyID キーは 'companyID' (cid ではない)。item (GroupShare.js:75-89) =
 *   { keyLevel(文字列 '0'/'1'/'2'), members:[subUUID...], devices:[deviceUUID...](ユニーク),
 *     mid:メンバーグループgid, dids:[デバイスグループgid...], startTime, endTime }。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, item:object, timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export function shareDeviceGroupKeysToEmployeeGroup(client: import("./transport.js").Hub3WsClient, { companyID, item, timeoutMs }: {
    companyID: string;
    item: object;
    timeoutMs?: number;
}): Promise<object>;
/**
 * 指定 subUUID の従業員が持つデバイス鍵一覧を取得する。
 * biz3: { action, subUUID, op:'get' }、companyID 無し (useManageGroup.js:137-148)。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{subUUID:string, timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message (data 構造は未確認)
 */
export function getEmployeeDeviceKeys(client: import("./transport.js").Hub3WsClient, { subUUID, timeoutMs }: {
    subUUID: string;
    timeoutMs?: number;
}): Promise<object>;
/**
 * 従業員/ゲストのデバイス鍵を削除する。
 * biz3: { action, ...data, op:'del' }、companyID 無し (useManageGroup.js:150-161)。
 * data は 2 パターン (DeviceUserList.js:117-132):
 *   (A) ゲスト鍵削除 = { guestKeyId, randomTag, deviceUUID }
 *       randomTag = await crypto.cmacTime(device.secretKey) を呼出側で生成して渡す。
 *   (B) 通常従業員削除 = { subUUID, deviceUUID } (randomTag 不要)。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{data:object, timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export function removeEmployeeDeviceKey(client: import("./transport.js").Hub3WsClient, { data, timeoutMs }: {
    data: object;
    timeoutMs?: number;
}): Promise<object>;
/**
 * ゲスト鍵の名称タグを更新する。
 * biz3: { action, ...data, op:'updateGuestTag' } (useManageGroup.js:163-174)。
 * data = { deviceUUID, guestKeyId, keyName } (DeviceUserList.js:146-151)。keyName が新タグ名。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{data:{deviceUUID:string,guestKeyId:string,keyName:string}, timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export function updateGuestKeyTag(client: import("./transport.js").Hub3WsClient, { data, timeoutMs }: {
    data: {
        deviceUUID: string;
        guestKeyId: string;
        keyName: string;
    };
    timeoutMs?: number;
}): Promise<object>;
/**
 * ゲスト用 guestKeyId を発行する (招待 QR の元になる)。
 * biz3: { action, ...data, op:'generateGuestQR' } (useManageGroup.js:176-187)。
 * data = currentDeviceKey (デバイス鍵オブジェクト全体: deviceUUID, secretKey,
 * sesame2PublicKey, keyIndex, deviceModel, deviceName, keyLevel 等) を spread
 * (MobileDeviceShareQRCode.js:58)。
 * 応答: res.success 必須、res.data = guestKeyId (文字列。QR の sk 生成に使う)。
 * 注: QR URL/画像化は別段 (biz3utils generateInviteGuestQRCodeByInfo) で本 op の対象外。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{data:object, timeoutMs?:number}} params
 * @returns {Promise<string>} guestKeyId
 */
export function generateGuestQR(client: import("./transport.js").Hub3WsClient, { data, timeoutMs }: {
    data: object;
    timeoutMs?: number;
}): Promise<string>;
/**
 * デバイス側から、その鍵を保有する従業員を列挙する。
 * biz3: { action, deviceUUID, companyID, limit, op:'get' } (useManageGroup.js:258-275)。
 * companyID 必須。limit=0 で全件 / 5 で非管理モード (DeviceUserList)。
 * 応答: resp.data = 配列。各 item = { keyLevel(数値:2=guest), subUUID, employeeName,
 *   guestKeyId(ゲスト時に length>0), ... } (DeviceUserList.js:29-40,119)。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{deviceUUID:string, companyID:string, limit?:number, timeoutMs?:number}} params
 * @returns {Promise<any[]>} 鍵保有従業員の配列
 */
export function getDeviceEmployeeKeys(client: import("./transport.js").Hub3WsClient, { deviceUUID, companyID, limit, timeoutMs }: {
    deviceUUID: string;
    companyID: string;
    limit?: number;
    timeoutMs?: number;
}): Promise<any[]>;
export const NAMESPACE_OPS: string[];
//# sourceMappingURL=org.d.ts.map