// SESAME Touch (Pro) のアクセス制御データ管理 — NFC カード / キーパッド暗証番号 (passcode)。
//
// Ported from biz3 (CANDY-HOUSE/biz3, MIT):
//   - vendor reference: references_web/src/api/useManageAuthData.js
//
// すべての op は WS action `biz3ManageAccessCtlAuthData` 上で動き、op で分岐する。
// ログイン済みセッションでサーバ側 DB を操作する層で、ここは「WS の DB 同期 op」に専念する。
//
// ⚠️ 2層構造の注意 (biz3 の設計):
//   カード/パスコードの実ファームウェア書き込みは BLE (iotCmd, topic=`stp${uuid}cmd`) 経由で行い、
//   本モジュールの WS op は「サーバ DB 側の同期」を担う。実機への add/delete の物理書き込みは
//   別モジュール (biz3OperateIoT 系) の責務であり、ここでは扱わない。
//   biz3 では BLE で実機を変更 → その ack コールバック内で本 WS op を投げて DB を追従させる。
//
//   ★ この CLI での BLE 経路の実体: src/ble/biometric.js (BiometricCommands)。
//     SesameBle.biometric.{cardAdd,cardDelete,cardBatchAdd,passcodeAdd,passcodeDelete,
//     passcodeBatchAdd,...} が実機への物理書き込みを行い、その完了後に本モジュールの
//     postCards/postPasscodes/delCards/delPasscodes で DB を追従させる (biz3 と同じ 2 段)。
//     旧称の「iotCmd / biz3OperateIoT」= SesameBle.biometric (BLE 直結経路) と読み替える。
//
//   ★ enroll (実機タップ登録) → DB 同期の実結線: BLE 側で出揃った登録レコードを本モジュールの
//     syncEnrolledCards/syncEnrolledPasscodes (= postCards/postPasscodes への委譲) へ渡す。
//     BLE 側の集約は src/ble/biometric.js の createEnrollCollector / BiometricCommands.onEnroll が
//     行い、その onEnrolled コールバック内で本関数を呼ぶ (BLE→cloud の責務境界はその境目)。
//
// ⚠️ 取得 (getCards/getPasscodes) の応答は **2系統** で届く (useManageAuthData.js:116-191):
//   (1) 完了通知:  { action, op:'getCards' }            ← data 本体なし。fetch 完了の合図のみ。
//   (2) データ本体: { action, op:'pubCardLinkedIDs', data:{ deviceUUID, page, list } }
//                  ← page===1 で list 置換、それ以外は累積 (ページング)。
//   passcode は op が 'getPasscodes' / 'pubPasscodeLinkedIDs' になる (同型)。

import { ACTION_TYPES } from "../vendor/biz3/constants/messageConstants.js";
import { assertSuccess, subscribeChunks, timeoutError } from "./util.js";
import { t } from "./i18n.js";
import { generateUUID } from "./crypto.js";

// action 文字列は vendor (biz3 messageConstants:9) から引く (手書きしない)。
const ACTION = ACTION_TYPES.BIZ3_MANAGE_AC_AUTHDATA; // "biz3ManageAccessCtlAuthData"

// async push の応答 op 名。biz3utils 由来の定数 (useManageAuthData.js:12-13)。
const PUB_CARD_LINKED_IDS = "pubCardLinkedIDs";
const PUB_PASSCODE_LINKED_IDS = "pubPasscodeLinkedIDs";

const DEFAULT_TIMEOUT_MS = 15_000;

// ---------- 内部: getXxx (完了通知 + pub データ push の集約) ----------

/**
 * getCards / getPasscodes を投げ、pub*LinkedIDs の async push をページング集約して返す共通処理。
 *
 * biz3 (useManageAuthData.js:50-63,116-132,176-191) のフロー:
 *   1. { action, obj:{ devices: 'uuid1,uuid2,...' }, op } を送信 (devices はカンマ連結文字列)。
 *   2. サーバは対象デバイスごとに op='pubCardLinkedIDs'/'pubPasscodeLinkedIDs' で
 *      { data:{ deviceUUID, page, list } } を複数回 push (page でページング)。
 *   3. 最後に完了通知 { op:'getCards'/'getPasscodes' } (data 無し) が届く。
 *
 * CLI では (1) 送信 → (2) pub を集約 → (3) 完了通知 or timeout で確定、という流れで
 * デバイス横断の一覧をまとめて返す。biz3 の handleDeviceCardData (124-131) と同じく
 * deviceUUID ごとに page===1 で置換 / それ以外で追記する。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {object} cfg
 * @param {string} cfg.op            送信 op ('getCards' | 'getPasscodes')
 * @param {string} cfg.pubOp         データ push の op ('pubCardLinkedIDs' | 'pubPasscodeLinkedIDs')
 * @param {string} cfg.idKey         集約キー ('cardID' | 'passwordID')
 * @param {string[]} cfg.deviceUUIDs 対象 deviceUUID 配列
 * @param {number} cfg.timeoutMs
 * @returns {Promise<{byDevice: Record<string, object[]>, items: object[]}>}
 *   byDevice: deviceUUID → そのデバイスに紐づく要素配列
 *   items:    idKey 単位に集約し uuids(=該当 deviceUUID 群) を付与した横断リスト
 */
async function fetchAuthData(client, { op, pubOp, idKey, deviceUUIDs, timeoutMs }) {
  if (!Array.isArray(deviceUUIDs) || deviceUUIDs.length === 0) {
    return { byDevice: {}, items: [] };
  }
  const deviceIds = deviceUUIDs.join(","); // biz3: devices.map(d=>d.deviceUUID).join(',') (54)

  /** @type {Record<string, object[]>} deviceUUID → list (ページング累積) */
  const byDevice = {};
  // 「(1) 取得 send → (2) pub データ push を集約 → (3) 完了通知 op で確定」の 2 購読モデル。
  // ライフサイクル (Promise/cleanup/timeout/二重解決) は util.subscribeChunks に委譲する。
  return subscribeChunks(client, {
    // (1) 取得リクエスト送信 (useManageAuthData.js:55-62)。obj.devices にカンマ連結文字列。
    sendFrame: { action: ACTION, obj: { devices: deviceIds }, op },
    timeoutMs,
    onTimeout: () => timeoutError(t("access.err.opTimeout", { op })),
    result: () => ({ byDevice, items: aggregate(byDevice, idKey) }),
    subscriptions: [
      // (2) データ本体 push の集約 (useManageAuthData.js:116-131)。完了はさせない。
      {
        key: `${ACTION}:${pubOp}`,
        onMessage: (msg) => {
          const data = msg?.data;
          if (!data) return;
          const { deviceUUID, page, list = [] } = data;
          if (!deviceUUID) return;
          const current = byDevice[deviceUUID] || [];
          // page===1 なら置換、それ以外は累積 (biz3:126)。
          byDevice[deviceUUID] = page === 1 ? [...list] : [...current, ...list];
        },
      },
      // (3) 完了通知 (useManageAuthData.js:180-185)。data 本体は無い → ここで確定。
      {
        key: `${ACTION}:${op}`,
        onMessage: (_msg, finish) => { finish(); },
      },
    ],
  });
}

/**
 * deviceUUID ごとの list を idKey 単位に集約し、uuids(該当 deviceUUID 群)を付与する。
 * biz3 nfcCards / passcodes useMemo (useManageAuthData.js:134-174) と同じ集約ロジック。
 * @param {Record<string, object[]>} byDevice
 * @param {string} idKey 'cardID' | 'passwordID'
 * @returns {object[]}
 */
function aggregate(byDevice, idKey) {
  /** @type {Record<string, Set<string>>} */
  const idMap = {};
  const cards = [];
  for (const [deviceUUID, list] of Object.entries(byDevice)) {
    for (const card of list) {
      const id = card[idKey];
      if (!idMap[id]) idMap[id] = new Set();
      idMap[id].add(deviceUUID);
      cards.push(card);
    }
  }
  return cards.map((card) => ({ ...card, uuids: Array.from(idMap[card[idKey]]) }));
}

// ---------- カード: 取得 ----------

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
export async function getCards(client, { deviceUUIDs, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return fetchAuthData(client, {
    op: "getCards",
    pubOp: PUB_CARD_LINKED_IDS,
    idKey: "cardID",
    deviceUUIDs,
    timeoutMs,
  });
}

// ---------- パスコード: 取得 ----------

/**
 * 対象デバイスの暗証番号 (passcode) 一覧を取得する。getCards と同型。
 * 応答データ本体は op='pubPasscodeLinkedIDs' で届く (useManageAuthData.js:189-191)。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{deviceUUIDs:string[], timeoutMs?:number}} params
 * @returns {Promise<{byDevice: Record<string, object[]>, items: object[]}>}
 *   items の各要素: { passwordID, keyBoardPassCode, keyBoardPassCodeNameUUID, name, nameUUID, subUUID, ..., uuids:string[] }
 */
export async function getPasscodes(client, { deviceUUIDs, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return fetchAuthData(client, {
    op: "getPasscodes",
    pubOp: PUB_PASSCODE_LINKED_IDS,
    idKey: "passwordID",
    deviceUUIDs,
    timeoutMs,
  });
}

// ---------- 内部: op 付き同期応答を待つ共通処理 ----------

/**
 * action+op 一致の同期応答を request で待つ。biz3 は invokeCallbacks(message) で
 * コールバック発火しているだけだが (useManageAuthData.js:260-271)、CLI では
 * 応答メッセージ (reqContext 含む) を呼び出し側に返す。
 * @returns {Promise<object>} 応答メッセージ
 */
async function requestOp(client, frame, opLabel, timeoutMs) {
  const resp = await client.request(frame, timeoutMs);
  return assertSuccess(resp, opLabel);
}

// ---------- カード: 登録 (DB 同期) ----------

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
export async function postCards(client, { deviceUUID, list, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!Array.isArray(list) || list.length < 1) return null;
  return requestOp(client, { action: ACTION, deviceUUID, list, op: "postCards" }, "postCards", timeoutMs);
}

// ---------- パスコード: 登録 (DB 同期) ----------

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
export async function postPasscodes(client, { deviceUUID, list, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!Array.isArray(list) || list.length < 1) return null;
  return requestOp(client, { action: ACTION, deviceUUID, list, op: "postPasscodes" }, "postPasscodes", timeoutMs);
}

// ---------- カード: 削除 (DB 同期) ----------

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
export function delCards(client, { items }) {
  if (!Array.isArray(items) || items.length === 0) return false;
  client.send({ action: ACTION, items, op: "delCards" });
  return true;
}

// ---------- パスコード: 削除 (DB 同期) ----------

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
export function delPasscodes(client, { items }) {
  if (!Array.isArray(items) || items.length === 0) return false;
  client.send({ action: ACTION, items, op: "delPasscodes" });
  return true;
}

// ---------- カード: 全クリア ----------

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
export async function clearCards(client, { deviceUUID, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!deviceUUID) return null;
  return requestOp(client, { action: ACTION, obj: { devices: deviceUUID }, op: "clearCards" }, "clearCards", timeoutMs);
}

// ---------- パスコード: 全クリア ----------

/**
 * 指定デバイスのパスコードを全削除する (clearPasscodes)。clearCards と同型。
 * obj.devices は単一 deviceUUID 文字列 (useManageAuthData.js:313-329)。
 * 注: biz3 の関数名は clearPasswords だが op は 'clearPasscodes'。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{deviceUUID:string, timeoutMs?:number}} params
 * @returns {Promise<object|null>}
 */
export async function clearPasscodes(client, { deviceUUID, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!deviceUUID) return null;
  return requestOp(client, { action: ACTION, obj: { devices: deviceUUID }, op: "clearPasscodes" }, "clearPasscodes", timeoutMs);
}

// ---------- カード: 名前 / nameUUID 更新 ----------

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
export async function updateCardName(client, { item, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return requestOp(client, { action: ACTION, obj: { ...item }, op: "updateCardName" }, "updateCardName", timeoutMs);
}

// ---------- パスコード: 名前 / nameUUID 更新 ----------

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
export async function updatePasscodeName(client, { item, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return requestOp(client, { action: ACTION, obj: { ...item }, op: "updatePasscodeName" }, "updatePasscodeName", timeoutMs);
}

// ---------- カード: 所有者割当 ----------

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
export async function updateCardOwner(client, { cardID, ownerSubUUID, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  // biz3: 'ownerSubUUID' in item の時だけ送る (348)。undefined は送らない。'' は送る。
  if (ownerSubUUID === undefined) return null;
  return requestOp(
    client,
    { action: ACTION, obj: { cardID, ownerSubUUID }, op: "updateCardOwner" },
    "updateCardOwner",
    timeoutMs,
  );
}

// ---------- enroll → DB 同期ブリッジ (BLE で実機登録 → 本 WS op で DB 追従) ----------
//
// biz3 の 2 段構造の **2 段目** (DB 同期) を、BLE 1 段目 (実機タップ登録) の集約結果に
// 接続する糊。BLE 側の集約は src/ble/biometric.js の createEnrollCollector /
// BiometricCommands.onEnroll が担い、その onEnrolled コールバック内で本関数を呼ぶ想定。
//
// 責務分担 (本ファイル冒頭の 2 層構造コメントの通り):
//   - 実機への物理書き込み = BLE (SesameBle.biometric.cardAdd 等)。本関数は一切触らない。
//   - DB 同期            = 本関数 (= 既存 postCards/postPasscodes へ委譲)。
// よって本関数は「BLE 由来の enroll レコード → postCards/postPasscodes の list 要素」への
// 変換 + 既存 op 呼び出しだけを行い、新しい WS op は増やさない。

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
export function enrolledToCardList(records) {
  if (!Array.isArray(records)) return [];
  return records.map((r) => ({
    cardID: r.cardID,
    name: r.cardName,
    cardType: r.cardType,
    nameUUID: generateUUID(),
  }));
}

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
export async function syncEnrolledCards(client, { deviceUUID, records, list, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const payload = Array.isArray(list) ? list : enrolledToCardList(records);
  return postCards(client, { deviceUUID, list: payload, timeoutMs });
}

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
export async function syncEnrolledPasscodes(client, { deviceUUID, records, list, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const payload = Array.isArray(list) ? list : enrolledToCardList(records);
  return postPasscodes(client, { deviceUUID, list: payload, timeoutMs });
}

// 公開 op の allowlist (SesameHub3._bindNs / serve registry が参照する単一の真実)。
// syncEnrolledCards/Passcodes は WS op を増やさず postCards/postPasscodes へ委譲する糊なので
// allowlist には載せない (新 op を捏造しない)。enrolledToCardList は純関数 (op ではない)。
export const NAMESPACE_OPS = [
  "getCards", "getPasscodes", "postCards", "postPasscodes",
  "delCards", "delPasscodes", "clearCards", "clearPasscodes",
  "updateCardName", "updatePasscodeName", "updateCardOwner",
];
