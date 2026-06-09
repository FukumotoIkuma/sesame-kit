// SESAME 組織管理 (employee / employeeGroup / role / deviceGroup / employeeDevice)。
//
// Ported from biz3 (CANDY-HOUSE/biz3, MIT):
//   - vendor reference: references_web/src/api/useManageEmployee.js (employee / employeeGroup / role)
//   - vendor reference: references_web/src/api/useManageGroup.js (deviceGroup / employeeDevice / getDeviceEmployeeKeys)
//
// これは「認証」ではなく「ログイン済みセッションで投げる組織管理 op」群。
// 認証フロー (Cognito / refresh / DEVICE_KEY) は auth.js のまま。ここは一切関与しない。
//
// ───────────── frame に関する一次資料の事実 (biz3 を 1 行ずつ確認済) ─────────────
//
// WebSocketManager.sendMessage は JSON.stringify(message) をそのまま ws.send するだけで
// (WebSocketManager.ts:383)、binary packing / checksum / UUID 変換 / topic 構築は一切ない。
// よって frame = 渡した JS オブジェクトそのもの。
//
// 応答ルーティングの 2 種類:
//   (1) 同期応答 (op が送信 op と一致): biz3 は registerCallback(action, op, cb) で受ける。
//       → CLI では client.request(frame) (action+op 一致を 1 件待つ) で対応。
//   (2) 別 op の async push で返る一覧:
//       - employee get → push op 'pubEmployees' (useManageEmployee.js:7,70-88)。
//       - employee queryByCS → push op 'pubQueryByCS' (useManageEmployee.js:391-416)。
//       どちらも page 単位で複数 chunk が届くので subscribe で蓄積する。
//
// フィールドのネスト差異 (op ごとに違う。biz3 を直接確認):
//   employee: get=companyID 直置き / add,delete,order=items 直置き(companyID は item 内)
//             / update=obj:{companyID,...} ラップ / queryByCS=keyword / confirmQueryByCS=email
//             / currentInfo=引数なし。
//   employeeGroup: getGroups=cid 直置き / add,update=obj:{cid,...} / deleteGroups=objs(配列)+cid
//             / getBindDeviceGroup=gid のみ(cid を送らない!) / addBindUser,removeBindUser=cid,gid,uuids,items 直置き
//             / removeBindDeviceGroup=cid+...data 直置き。
//   role: get=companyID / post,delete=companyID+...data 直置き (cid ではなく companyID)。
//   deviceGroup: getGroups=cid / add=obj:{name,cid,uuids} / update=obj:{cid,...item}
//             / deleteGroups=objs(各要素に cid マージ) / addBindDevice,removeBindDevice=cid,gid,uuids,items 直置き
//             / getBindUserGroup=gid のみ(cid 無し) / removeBindUserGroup=cid+...data 直置き。
//   employeeDevice: add=items 直置き(companyID 無し) / group=...item+companyID 直置き
//             / get=subUUID のみ / del,updateGuestTag,generateGuestQR=...data 直置き(companyID 無し)。
//   getDeviceEmployeeKeys: deviceUUID+companyID+limit 直置き。

import { ACTION_TYPES } from "../vendor/biz3/constants/messageConstants.js";
import { assertSuccess, subscribeChunks, badRequest, timeoutError, rejected } from "./util.js";

// action 文字列は vendor (biz3 messageConstants) から引く (手書きしない)。
const ACT_EMPLOYEE = ACTION_TYPES.BIZ3_MANAGE_EMPLOYEE;             // "biz3ManageEmployee"
const ACT_EMPLOYEE_GROUP = ACTION_TYPES.BIZ3_MANAGE_EMPLOYEE_GROUP; // "biz3ManageEmployeeGroup"
const ACT_ROLE = ACTION_TYPES.BIZ3_MANAGE_ROLE;                    // "biz3ManageRole"
const ACT_DEVICE_GROUP = ACTION_TYPES.BIZ3_MANAGE_DEVICE_GROUP;     // "biz3ManageDeviceGroup"
const ACT_EMPLOYEE_DEVICE = ACTION_TYPES.BIZ3_MANAGE_EMPLOYEE_DEVICE; // "biz3ManageEmployeeDevice"
const ACT_DEVICE_EMP_KEYS = ACTION_TYPES.BIZ3_GET_DEVICEEMOLOYEEKEYS; // "biz3GetDeviceEmployeeKeys"

const DEFAULT_TIMEOUT_MS = 10_000;

// ════════════════════════════════════════════════════════════════════════════
//  employee (biz3ManageEmployee)
// ════════════════════════════════════════════════════════════════════════════

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
export async function getEmployees(client, { companyID, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!companyID) throw badRequest("org.req.companyID");
  return collectChunks(client, {
    action: ACT_EMPLOYEE,
    pubOp: "pubEmployees", // useManageEmployee.js:7
    sendFrame: { action: ACT_EMPLOYEE, companyID, op: "get" }, // :18-22
    timeoutMs,
    // pubEmployees の chunk 形: { totalCount, data:{ list, page } } (:71-88)
    parseChunk: (msg) => {
      const totalCount = msg?.data?.totalCount;
      const inner = msg?.data?.data ?? {};
      return { totalCount, list: inner.list ?? [], page: inner.page ?? 1 };
    },
  });
}

/**
 * ログイン中の自分自身の社員情報を取得する。companyID も items も不要。
 * biz3: registerCallback(action,'currentInfo',cb) で同期受信 (useManageEmployee.js:187-197)。
 * 応答本体は res.data (vendor 確認: MobileMeIndex.js:60 setCurrentUserInfo(res.data) /
 * me/index.js:36)。既知フィールド: nickname / email。
 * @param {import("./transport.js").Hub3WsClient} client
 * @returns {Promise<object>} res.data (例: { nickname, email, ... })
 */
export async function getCurrentUserInfo(client, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const resp = await client.request({ action: ACT_EMPLOYEE, op: "currentInfo" }, timeoutMs);
  assertSuccess(resp, "getCurrentUserInfo");
  return resp.data; // vendor は常に res.data を読む (?? resp フォールバックは推測だった)
}

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
export async function addEmployees(client, { items, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!Array.isArray(items)) throw badRequest("org.req.itemsArray");
  const resp = await client.request({ action: ACT_EMPLOYEE, items, op: "add" }, timeoutMs);
  assertSuccess(resp, "addEmployees");
  return resp;
}

/**
 * 社員情報を更新する。
 * biz3: update のみ obj:{companyID,...data} でラップする (useManageEmployee.js:169-185)。
 * data は更新フィールド (例 { Name:'nickname', Value:newValue } — me/index.js:63)。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, data:object, timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export async function updateEmployee(client, { companyID, data, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!companyID) throw badRequest("org.req.companyID");
  const resp = await client.request(
    { action: ACT_EMPLOYEE, obj: { companyID, ...data }, op: "update" },
    timeoutMs,
  );
  assertSuccess(resp, "updateEmployee");
  return resp;
}

/**
 * 社員を削除する。
 * biz3: { action, items, op:'delete' }。items は社員オブジェクト配列または
 * [{ subUUID, companyID }] (useManageEmployee.js:199-210, EmployeeItem.js:219-225)。
 * トップレベル companyID 無し (companyID は要素内に含めるパターンあり)。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{items:object[], timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export async function removeEmployees(client, { items, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!Array.isArray(items)) throw badRequest("org.req.itemsArray");
  const resp = await client.request({ action: ACT_EMPLOYEE, items, op: "delete" }, timeoutMs);
  assertSuccess(resp, "removeEmployees");
  return resp;
}

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
export async function reorderEmployees(client, { items, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!Array.isArray(items)) throw badRequest("org.req.itemsArray");
  const resp = await client.request({ action: ACT_EMPLOYEE, items, op: "order" }, timeoutMs);
  assertSuccess(resp, "reorderEmployees");
  return resp;
}

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
export async function queryByCS(client, { keyword, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!keyword) throw badRequest("org.req.keyword");
  return collectChunks(client, {
    action: ACT_EMPLOYEE,
    pubOp: "pubQueryByCS", // useManageEmployee.js:411,415
    sendFrame: { action: ACT_EMPLOYEE, keyword, op: "queryByCS" }, // :394-398
    timeoutMs,
    returnListOnly: true,
    // chunk 形: res.data = { data:{ list, page }, totalPage } (:405-408)
    parseChunk: (msg) => {
      const top = msg?.data ?? {};
      const inner = top.data ?? {};
      return {
        list: inner.list ?? [],
        page: inner.page ?? 1,
        totalPage: top.totalPage ?? 1,
      };
    },
  });
}

/**
 * queryByCS で見つけたユーザーを確定する。
 * biz3: { action, email, op:'confirmQueryByCS' } (useManageEmployee.js:420-432)。
 * 注: 成功すると biz3 UI は現セッションを signout する設計 (CSUserSearchDialog.js:127)。
 *     CLI でこの op を投げる場合は副作用に注意。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{email:string, timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export async function confirmQueryByCS(client, { email, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!email) throw badRequest("org.req.email");
  const resp = await client.request(
    { action: ACT_EMPLOYEE, email, op: "confirmQueryByCS" },
    timeoutMs,
  );
  assertSuccess(resp, "confirmQueryByCS");
  return resp;
}

// ════════════════════════════════════════════════════════════════════════════
//  employeeGroup (biz3ManageEmployeeGroup)
//  注: companyID のキー名は 'cid' (getBindDeviceGroup を除く)。
// ════════════════════════════════════════════════════════════════════════════

/**
 * 従業員グループ一覧を取得する。
 * biz3: { action, cid, op:'getGroups' }、応答 data=グループ配列 (useManageEmployee.js:25-33,47-49)。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, timeoutMs?:number}} params
 * @returns {Promise<any[]>} グループ配列
 */
export async function getEmployeeGroups(client, { companyID, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!companyID) throw badRequest("org.req.companyID");
  const resp = await client.request(
    { action: ACT_EMPLOYEE_GROUP, cid: companyID, op: "getGroups" },
    timeoutMs,
  );
  assertSuccess(resp, "getEmployeeGroups");
  return resp?.data ?? [];
}

/**
 * 従業員グループを追加する。
 * biz3: obj:{cid,...item} でラップ (useManageEmployee.js:212-228)。応答 data=追加グループ1件。
 * item の具体フィールド (グループ名等) は biz3 UI 依存で未確認。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, item:object, timeoutMs?:number}} params
 * @returns {Promise<object>} 追加されたグループ (resp.data)
 */
export async function addEmployeeGroup(client, { companyID, item, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!companyID) throw badRequest("org.req.companyID");
  const resp = await client.request(
    { action: ACT_EMPLOYEE_GROUP, obj: { cid: companyID, ...item }, op: "add" },
    timeoutMs,
  );
  assertSuccess(resp, "addEmployeeGroup");
  return resp?.data ?? resp;
}

/**
 * 従業員グループ情報を更新する。
 * biz3: obj:{cid,...item} でラップ (useManageEmployee.js:230-246)。item に gid 等を含める想定。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, item:object, timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export async function updateEmployeeGroup(client, { companyID, item, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!companyID) throw badRequest("org.req.companyID");
  const resp = await client.request(
    { action: ACT_EMPLOYEE_GROUP, obj: { cid: companyID, ...item }, op: "update" },
    timeoutMs,
  );
  assertSuccess(resp, "updateEmployeeGroup");
  return resp;
}

/**
 * 従業員グループを削除する (複数可)。
 * biz3: { action, objs:<gids>, cid, op:'deleteGroups' } (useManageEmployee.js:248-261)。
 * objs はトップレベル配列。gids の各要素型は biz3 UI 依存で未確認。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, gids:any[], timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export async function removeEmployeeGroups(client, { companyID, gids, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!companyID) throw badRequest("org.req.companyID");
  if (!Array.isArray(gids)) throw badRequest("org.req.gidsArray");
  const resp = await client.request(
    { action: ACT_EMPLOYEE_GROUP, objs: gids, cid: companyID, op: "deleteGroups" },
    timeoutMs,
  );
  assertSuccess(resp, "removeEmployeeGroups");
  return resp;
}

/**
 * 従業員グループに紐づくデバイスグループを取得する。
 * biz3: { action, gid, op:'getBindDeviceGroup' } — cid は送らない (useManageEmployee.js:321-334)。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{gid:string, timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message (data 構造は未確認)
 */
export async function getEmployeeGroupBindDeviceGroup(client, { gid, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!gid) throw badRequest("org.req.gid");
  const resp = await client.request(
    { action: ACT_EMPLOYEE_GROUP, gid, op: "getBindDeviceGroup" },
    timeoutMs,
  );
  assertSuccess(resp, "getEmployeeGroupBindDeviceGroup");
  return resp?.data ?? resp;
}

/**
 * 従業員グループにユーザーを紐付ける。
 * biz3: { action, cid, gid, uuids, items, op:'addBindUser' } 全て直置き (useManageEmployee.js:336-352)。
 * uuids と items は別引数で両方送る。要素構造は biz3 UI 依存で未確認。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, gid:string, uuids:any[], items:any[], timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export async function addEmployeeInGroup(client, { companyID, gid, uuids, items, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!companyID) throw badRequest("org.req.companyID");
  const resp = await client.request(
    { action: ACT_EMPLOYEE_GROUP, cid: companyID, gid, uuids, items, op: "addBindUser" },
    timeoutMs,
  );
  assertSuccess(resp, "addEmployeeInGroup");
  return resp;
}

/**
 * 従業員グループからユーザーを解除する。
 * biz3: items を {subUUID} のみに絞り込んで送る (useManageEmployee.js:354-373, :358-360)。
 * uuids は引数そのまま。cid/gid/uuids/items 全て直置き。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, gid:string, uuids:any[], items:{subUUID:string}[], timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export async function removeEmployeeInGroup(client, { companyID, gid, uuids, items, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!companyID) throw badRequest("org.req.companyID");
  if (!Array.isArray(items)) throw badRequest("org.req.itemsArray");
  // biz3 useManageEmployee.js:358-360 と同じく {subUUID} だけに絞る。
  const params = items.map((item) => ({ subUUID: item.subUUID }));
  const resp = await client.request(
    { action: ACT_EMPLOYEE_GROUP, cid: companyID, gid, uuids, items: params, op: "removeBindUser" },
    timeoutMs,
  );
  assertSuccess(resp, "removeEmployeeInGroup");
  return resp;
}

/**
 * 従業員グループからデバイスグループを解除する。
 * biz3: { action, cid, ...data, op:'removeBindDeviceGroup' } (useManageEmployee.js:375-389)。
 * data の中身 (gid 等) は biz3 UI 依存で未確認。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, data:object, timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export async function removeEmployeeGroupBindDeviceGroup(client, { companyID, data, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!companyID) throw badRequest("org.req.companyID");
  const resp = await client.request(
    { action: ACT_EMPLOYEE_GROUP, cid: companyID, ...data, op: "removeBindDeviceGroup" },
    timeoutMs,
  );
  assertSuccess(resp, "removeEmployeeGroupBindDeviceGroup");
  return resp;
}

// ════════════════════════════════════════════════════════════════════════════
//  role / tags (biz3ManageRole)
//  注: ここだけ companyID のキー名は 'companyID' (employeeGroup 系の 'cid' と異なる)。
// ════════════════════════════════════════════════════════════════════════════

/**
 * 役割タグ一覧を取得する。
 * biz3: { action, companyID, op:'get' }、応答 data=タグ配列 (useManageEmployee.js:35-43,116-127)。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, timeoutMs?:number}} params
 * @returns {Promise<any[]>} タグ配列
 */
export async function getTags(client, { companyID, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!companyID) throw badRequest("org.req.companyID");
  const resp = await client.request(
    { action: ACT_ROLE, companyID, op: "get" },
    timeoutMs,
  );
  assertSuccess(resp, "getTags");
  return resp?.data ?? [];
}

/**
 * 役割タグを追加/更新する。
 * biz3: { action, companyID, ...data, op:'post' } (useManageEmployee.js:289-303)。
 * op:'post' は ...data の後に置き、data 内の op を上書きする (順序が一次資料どおり重要)。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, data:object, timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export async function postTag(client, { companyID, data, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!companyID) throw badRequest("org.req.companyID");
  const resp = await client.request(
    { action: ACT_ROLE, companyID, ...data, op: "post" },
    timeoutMs,
  );
  assertSuccess(resp, "postTag");
  return resp;
}

/**
 * 役割タグを削除する。
 * biz3: { action, companyID, ...data, op:'delete' } (useManageEmployee.js:305-319)。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, data:object, timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export async function removeTag(client, { companyID, data, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!companyID) throw badRequest("org.req.companyID");
  const resp = await client.request(
    { action: ACT_ROLE, companyID, ...data, op: "delete" },
    timeoutMs,
  );
  assertSuccess(resp, "removeTag");
  return resp;
}

// ════════════════════════════════════════════════════════════════════════════
//  deviceGroup (biz3ManageDeviceGroup)
//  注: companyID のキー名は 'cid' (getBindUserGroup は cid 無し)。
// ════════════════════════════════════════════════════════════════════════════

/**
 * デバイスグループ一覧を取得する。
 * biz3: { action, cid, op:'getGroups' }、応答 data=配列 (useManageGroup.js:11-19,27-33)。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, timeoutMs?:number}} params
 * @returns {Promise<any[]>} デバイスグループ配列
 */
export async function getDeviceGroups(client, { companyID, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!companyID) throw badRequest("org.req.companyID");
  const resp = await client.request(
    { action: ACT_DEVICE_GROUP, cid: companyID, op: "getGroups" },
    timeoutMs,
  );
  assertSuccess(resp, "getDeviceGroups");
  return resp?.data ?? [];
}

/**
 * デバイスグループを作成する。
 * biz3: obj:{name,cid,uuids} でラップ (useManageGroup.js:84-102)。
 * uuids は作成時に含めるデバイス UUID 配列。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, name:string, uuids:string[], timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export async function addDeviceGroup(client, { companyID, name, uuids = [], timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!companyID) throw badRequest("org.req.companyID");
  const resp = await client.request(
    { action: ACT_DEVICE_GROUP, obj: { name, cid: companyID, uuids }, op: "add" },
    timeoutMs,
  );
  assertSuccess(resp, "addDeviceGroup");
  return resp;
}

/**
 * デバイスグループ情報を更新する。
 * biz3: obj:{cid,...item} でラップ (useManageGroup.js:310-326)。item に gid 等を含める想定。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, item:object, timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export async function updateDeviceGroup(client, { companyID, item, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!companyID) throw badRequest("org.req.companyID");
  const resp = await client.request(
    { action: ACT_DEVICE_GROUP, obj: { cid: companyID, ...item }, op: "update" },
    timeoutMs,
  );
  assertSuccess(resp, "updateDeviceGroup");
  return resp;
}

/**
 * デバイスグループを削除する (複数可)。
 * biz3: groupIds の各 obj に cid をマージした配列を objs(複数形) に入れる
 * (useManageGroup.js:67-82)。obj(単数) ではなく objs。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, groupIds:object[], timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export async function removeDeviceGroups(client, { companyID, groupIds, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!companyID) throw badRequest("org.req.companyID");
  if (!Array.isArray(groupIds)) throw badRequest("org.req.groupIdsArray");
  // biz3 useManageGroup.js:71-74 と同じく各要素に cid をマージ。
  const objs = groupIds.map((obj) => ({ ...obj, cid: companyID }));
  const resp = await client.request(
    { action: ACT_DEVICE_GROUP, objs, op: "deleteGroups" },
    timeoutMs,
  );
  assertSuccess(resp, "removeDeviceGroups");
  return resp;
}

/**
 * デバイスグループにデバイスを紐付ける。
 * biz3: { action, cid, gid, uuids, items, op:'addBindDevice' } 全て直置き (useManageGroup.js:240-256)。
 * removeBindDevice と異なり items は絞り込まず透過する。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, gid:string, uuids:any[], items:any[], timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export async function addDeviceInGroup(client, { companyID, gid, uuids, items, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!companyID) throw badRequest("org.req.companyID");
  const resp = await client.request(
    { action: ACT_DEVICE_GROUP, cid: companyID, gid, uuids, items, op: "addBindDevice" },
    timeoutMs,
  );
  assertSuccess(resp, "addDeviceInGroup");
  return resp;
}

/**
 * デバイスグループからデバイスを解除する。
 * biz3: items を必ず {deviceUUID, secretKey} のみに絞り込んで送る (useManageGroup.js:218-238, :222-225)。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, gid:string, uuids:any[], items:{deviceUUID:string,secretKey:string}[], timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export async function removeDeviceInGroup(client, { companyID, gid, uuids, items, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!companyID) throw badRequest("org.req.companyID");
  if (!Array.isArray(items)) throw badRequest("org.req.itemsArray");
  // biz3 useManageGroup.js:222-225 と同じく {deviceUUID, secretKey} だけに絞る。
  const params = items.map((item) => ({ deviceUUID: item.deviceUUID, secretKey: item.secretKey }));
  const resp = await client.request(
    { action: ACT_DEVICE_GROUP, cid: companyID, gid, uuids, items: params, op: "removeBindDevice" },
    timeoutMs,
  );
  assertSuccess(resp, "removeDeviceInGroup");
  return resp;
}

/**
 * デバイスグループにバインド済みの従業員グループを取得する。
 * biz3: { action, gid, op:'getBindUserGroup' } — cid 無し (useManageGroup.js:189-200)。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{gid:string, timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message (data 構造は未確認)
 */
export async function getDeviceGroupBindUserGroup(client, { gid, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!gid) throw badRequest("org.req.gid");
  const resp = await client.request(
    { action: ACT_DEVICE_GROUP, gid, op: "getBindUserGroup" },
    timeoutMs,
  );
  assertSuccess(resp, "getDeviceGroupBindUserGroup");
  return resp?.data ?? resp;
}

/**
 * デバイスグループから従業員グループを解除する。
 * biz3: { action, cid, ...data, op:'removeBindUserGroup' } (useManageGroup.js:202-216)。
 * data の中身 (gid/uuids 等) は biz3 UI 依存で未確認。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{companyID:string, data:object, timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export async function removeDeviceGroupBindUserGroup(client, { companyID, data, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!companyID) throw badRequest("org.req.companyID");
  const resp = await client.request(
    { action: ACT_DEVICE_GROUP, cid: companyID, ...data, op: "removeBindUserGroup" },
    timeoutMs,
  );
  assertSuccess(resp, "removeDeviceGroupBindUserGroup");
  return resp;
}

// ════════════════════════════════════════════════════════════════════════════
//  employeeDevice (biz3ManageEmployeeDevice) — デバイス鍵の共有/取消/列挙
// ════════════════════════════════════════════════════════════════════════════

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
export async function shareDeviceKeysToEmployees(client, { items, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!Array.isArray(items)) throw badRequest("org.req.itemsArray");
  const resp = await client.request(
    { action: ACT_EMPLOYEE_DEVICE, items, op: "add" },
    timeoutMs,
  );
  assertSuccess(resp, "shareDeviceKeysToEmployees");
  return resp;
}

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
export async function shareDeviceGroupKeysToEmployeeGroup(client, { companyID, item, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!companyID) throw badRequest("org.req.companyID");
  const resp = await client.request(
    { action: ACT_EMPLOYEE_DEVICE, ...item, companyID, op: "group" },
    timeoutMs,
  );
  assertSuccess(resp, "shareDeviceGroupKeysToEmployeeGroup");
  return resp;
}

/**
 * 指定 subUUID の従業員が持つデバイス鍵一覧を取得する。
 * biz3: { action, subUUID, op:'get' }、companyID 無し (useManageGroup.js:137-148)。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{subUUID:string, timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message (data 構造は未確認)
 */
export async function getEmployeeDeviceKeys(client, { subUUID, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!subUUID) throw badRequest("org.req.subUUID");
  const resp = await client.request(
    { action: ACT_EMPLOYEE_DEVICE, subUUID, op: "get" },
    timeoutMs,
  );
  assertSuccess(resp, "getEmployeeDeviceKeys");
  return resp?.data ?? resp;
}

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
export async function removeEmployeeDeviceKey(client, { data, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!data || typeof data !== "object") throw badRequest("org.req.data");
  const resp = await client.request(
    { action: ACT_EMPLOYEE_DEVICE, ...data, op: "del" },
    timeoutMs,
  );
  assertSuccess(resp, "removeEmployeeDeviceKey");
  return resp;
}

/**
 * ゲスト鍵の名称タグを更新する。
 * biz3: { action, ...data, op:'updateGuestTag' } (useManageGroup.js:163-174)。
 * data = { deviceUUID, guestKeyId, keyName } (DeviceUserList.js:146-151)。keyName が新タグ名。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{data:{deviceUUID:string,guestKeyId:string,keyName:string}, timeoutMs?:number}} params
 * @returns {Promise<object>} 応答 message
 */
export async function updateGuestKeyTag(client, { data, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!data || typeof data !== "object") throw badRequest("org.req.data");
  const resp = await client.request(
    { action: ACT_EMPLOYEE_DEVICE, ...data, op: "updateGuestTag" },
    timeoutMs,
  );
  assertSuccess(resp, "updateGuestKeyTag");
  return resp;
}

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
export async function generateGuestQR(client, { data, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!data || typeof data !== "object") throw badRequest("org.req.data");
  const resp = await client.request(
    { action: ACT_EMPLOYEE_DEVICE, ...data, op: "generateGuestQR" },
    timeoutMs,
  );
  assertSuccess(resp, "generateGuestQR");
  return resp.data; // guestKeyId (MobileDeviceShareQRCode.js:58-69)
}

// ════════════════════════════════════════════════════════════════════════════
//  getDeviceEmployeeKeys (biz3GetDeviceEmployeeKeys) — デバイス側から鍵保有従業員を列挙
// ════════════════════════════════════════════════════════════════════════════

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
export async function getDeviceEmployeeKeys(client, { deviceUUID, companyID, limit = 0, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!deviceUUID) throw badRequest("org.req.deviceUUID");
  if (!companyID) throw badRequest("org.req.companyID");
  const resp = await client.request(
    { action: ACT_DEVICE_EMP_KEYS, deviceUUID, companyID, limit, op: "get" },
    timeoutMs,
  );
  assertSuccess(resp, "getDeviceEmployeeKeys");
  return resp?.data ?? [];
}

// ════════════════════════════════════════════════════════════════════════════
//  internal helper: chunk 集約 (pubEmployees / pubQueryByCS)
// ════════════════════════════════════════════════════════════════════════════

/**
 * 別 op の async push (pubEmployees / pubQueryByCS) を購読し、page 単位の chunk を
 * 蓄積して 1 配列にまとめて返す。biz3 は request の op と push の op が異なるため
 * (例 send:'get' → push:'pubEmployees')、request では待てず subscribe で受ける必要がある。
 *
 * 完了判定:
 *   - parseChunk が totalPage を返す場合 (queryByCS): page===totalPage で完了。
 *   - parseChunk が totalCount を返す場合 (pubEmployees): 蓄積件数 >= totalCount で完了
 *     (totalCount===0 や 1 ページのみでも即完了)。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{
 *   action:string,
 *   pubOp:string,
 *   sendFrame:object,
 *   timeoutMs:number,
 *   parseChunk:(msg:any)=>{list:any[], page:number, totalPage?:number, totalCount?:number},
 *   returnListOnly?:boolean,
 * }} cfg
 * @returns {Promise<{count:number, list:any[]} | any[]>}
 */
function collectChunks(client, cfg) {
  const { action, pubOp, sendFrame, timeoutMs, parseChunk, returnListOnly } = cfg;
  // 蓄積は本関数のクロージャで持ち、ライフサイクル (Promise/cleanup/timeout/二重解決ガード) は
  // util.subscribeChunks に委譲する (devices/access と共通の定型)。
  let acc = [];
  let total = null; // totalCount (件数) を見るモード用
  return subscribeChunks(client, {
    sendFrame,
    timeoutMs,
    onTimeout: () => timeoutError(`${action}:${pubOp} timeout`),
    result: () => (returnListOnly ? acc : { count: total ?? acc.length, list: acc }),
    subscriptions: [{
      key: `${action}:${pubOp}`,
      onMessage: (msg, finish) => {
        if (msg?.success === false) {
          finish(rejected(`${action}:${pubOp} failed: ${msg.message || JSON.stringify(msg)}`,
            { upstreamCode: msg?.code ?? null }));
          return;
        }
        const chunk = parseChunk(msg); // throw は subscribeChunks が捕捉して reject

        // page===1 で全置換、それ以外は追記 (biz3 pubEmployees の蓄積規則と同じ :75-87)。
        if (chunk.page === 1) acc = [...chunk.list];
        else acc = [...acc, ...chunk.list];

        if (typeof chunk.totalCount === "number") total = chunk.totalCount;

        // 完了判定。
        if (typeof chunk.totalPage === "number") {
          if (chunk.page >= chunk.totalPage) finish();
        } else if (typeof chunk.totalCount === "number") {
          if (acc.length >= chunk.totalCount) finish();
        }
        // どちらも無い場合は timeout まで待つ (chunk 形不明時の保険)。
      },
    }],
  });
}

// 公開 op の allowlist (SesameHub3._bindNs / serve registry が参照する単一の真実)。
export const NAMESPACE_OPS = [
  "getEmployees", "getCurrentUserInfo", "addEmployees", "updateEmployee",
  "removeEmployees", "reorderEmployees", "queryByCS", "confirmQueryByCS",
  "getEmployeeGroups", "addEmployeeGroup", "updateEmployeeGroup", "removeEmployeeGroups",
  "getEmployeeGroupBindDeviceGroup", "addEmployeeInGroup", "removeEmployeeInGroup",
  "removeEmployeeGroupBindDeviceGroup", "getTags", "postTag", "removeTag",
  "getDeviceGroups", "addDeviceGroup", "updateDeviceGroup", "removeDeviceGroups",
  "addDeviceInGroup", "removeDeviceInGroup", "getDeviceGroupBindUserGroup",
  "removeDeviceGroupBindUserGroup", "shareDeviceKeysToEmployees",
  "shareDeviceGroupKeysToEmployeeGroup", "getEmployeeDeviceKeys", "removeEmployeeDeviceKey",
  "updateGuestKeyTag", "generateGuestQR", "getDeviceEmployeeKeys",
];
