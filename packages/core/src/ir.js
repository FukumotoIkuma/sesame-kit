// SESAME Hub3 IR リモコン関連の高レベル操作。
//
// Ported from biz3 (CANDY-HOUSE/biz3, MIT):
//   - vendor reference: references_web/src/api/useRemoteCtrl.js
//
// 基本 op (sendIR / getIRCodes) は transport.js に置いたまま、
// それ以外の op (remote/key の CRUD, mode 制御, 学習フロー, preset 検索) をここに集約。
//
// 命名規則 (vendor 由来の不一致):
//   - sendIR: deviceId / irDeviceUUID    ← Hub3 / リモコン
//   - getIRCodes/updateIRCode/deleteIRCode: hub3DeviceId / remoteId
//   - updateRemoteAlias: deviceId / uuid  ← Hub3 / リモコン (Alias 系のみ uuid 名)
//   - deleteIRRemote: hub3DeviceId / uuid
// → biz3 のフィールド命名は op ごとに微妙に違うので、こちら側ヘルパーで吸収する。
//
// ⚠️ irType の特大トラップ (自己学習リモコンの type が 2 つある):
//
//   biz3 の公式 UI には「リモコン種別の選択メニュー」(ir-type-list 画面) があり、
//   エアコン/テレビ/照明/扇風機/学習 から選ぶ。各項目に整数 id が振られている:
//       エアコン=0xC000 テレビ=0x2000 照明=0xE000 扇風機=0x8000 学習=0xFEFF
//
//   プリセット (エアコン等) を選ぶと、その「メニュー id」がそのまま
//   実デバイスの remote.type になり、sendIR にも乗る。つまり id = 実 type で一致する。
//
//   ところが「学習」だけは違う。メニュー id は 0xFEFF だが、学習を選んだ後に
//   実際に作られるリモコンの remote.type は 0xFE00 になる (= 旧実装が実機で観測した 65024)。
//   0xFEFF は「学習メニューを押した」という UI 上の印でしかなく、
//   デバイスにも sendIR にも 0xFEFF は決して現れない。
//
//   → このコードで getRemoteList / matchRemote などに渡す type や、
//     自己学習リモコンを表す値は **必ず実 type = 0xFE00 (65024)** を使う。
//     UI メニュー id の 0xFEFF を実 type と勘違いすると、サーバ照合が一致せず
//     リモコンが見つからない/動かない。一次資料: learn/index.js:142,
//     useRemoteCtrl.js:228 (どちらも 0xFE00 を学習リモコンの type として扱う)。
//     値の一覧と出所は crypto.js の IR_TYPE コメントにも記載。

import { generateUUID, normalizeUuid } from "./crypto.js";
import { ACTION_TYPES } from "./vendor/biz3/constants/messageConstants.js";
import { assertSuccess, rejected, timeoutError, badRequest } from "./util.js";
import { t } from "./i18n.js";

/**
 * 下位 WS トランスポート (transport.js の Hub3WsClient)。
 * @typedef {import("./transport.js").Hub3WsClient} WsClient
 */

const ACTION = ACTION_TYPES.BIZ3_IR_REMOTE; // "biz3IRRemote" (vendor 由来)
const DEFAULT_TIMEOUT_MS = 10_000;
const LEARN_DEFAULT_TIMEOUT_MS = 60_000;

const MODE = Object.freeze({
  CONTROL: 0,
  REGISTER: 1,
});

/** @param {string} deviceId */
const modeTopic = (deviceId) => `hub3/${deviceId}/ir/mode`;
/** @param {string} deviceId */
const dataTopic = (deviceId) => `hub3/${deviceId}/ir/learned/data`;

// ---------- remote 一覧 / 検索 ----------

/**
 * getRemoteList / searchRemoteList の戻り値。
 * vendor (useRemoteCtrl.js:43-57) の応答 `message.data` は {data:[...], pagination:{...}} の
 * ラッパーで、一覧本体は `message.data.data`、ページング情報は `message.data.pagination`
 * (currentPage / pageSize / hasMore 等。次ページは currentPage+1, hasMore で打ち切り —
 *  loadMoreRemotes, useRemoteCtrl.js:431-441)。
 * @typedef {{ list: any[], pagination: {currentPage?:number, pageSize?:number, hasMore?:boolean} | null }} RemoteListPage
 */

/**
 * 登録済みリモコン一覧を取得 (ページング)。
 * 次ページは戻り値 pagination の currentPage+1 を page に渡す (hasMore が false なら終端 —
 * vendor loadMoreRemotes, useRemoteCtrl.js:431-441)。
 * @param {WsClient} client
 * @param {{type:number, companyID:string, page?:number, pageSize?:number}} p
 *   type は **実 remote.type** (自己学習=0xFE00, UI メニューの 0xFEFF ではない / 上記トラップ参照)
 * @returns {Promise<RemoteListPage>}
 */
export async function getRemoteList(client, p) {
  const frame = {
    action: ACTION,
    op: "getRemoteList",
    type: p.type,
    companyID: p.companyID,
    pagination: { page: p.page ?? 1, pageSize: p.pageSize ?? 200 },
  };
  const resp = await client.request(frame, DEFAULT_TIMEOUT_MS);
  assertSuccess(resp, "getRemoteList", { strict: true });
  // vendor の読み方 1:1 (useRemoteCtrl.js:44-46):
  //   const responseData = message.data || {};
  //   const list = responseData.data || [];
  //   const paginationInfo = responseData.pagination || {};
  const d = /** @type {{data?: any[], pagination?: any}} */ (resp.data ?? {});
  return { list: d.data ?? [], pagination: d.pagination ?? null };
}

/**
 * プリセットリモコン (メーカー DB) 検索。最大 1000 件返却
 * (vendor は page=1/pageSize=1000 固定で frame にページング引数を露出しない —
 *  useRemoteCtrl.js:406-414)。
 * @param {WsClient} client
 * @param {{type:number, companyID:string, searchTerm:string}} p
 * @returns {Promise<RemoteListPage>}
 */
export async function searchRemoteList(client, p) {
  const frame = {
    action: ACTION,
    op: "searchRemoteList",
    type: p.type,
    companyID: p.companyID,
    searchTerm: p.searchTerm,
    pagination: { page: 1, pageSize: 1000 },
  };
  const resp = await client.request(frame, DEFAULT_TIMEOUT_MS);
  assertSuccess(resp, "searchRemoteList", { strict: true });
  // vendor の読み方 1:1 (useRemoteCtrl.js:60-62): searchList = message.data.data
  const d = /** @type {{data?: any[], pagination?: any}} */ (resp.data ?? {});
  return { list: d.data ?? [], pagination: d.pagination ?? null };
}

// ---------- プリセット上限チェック ----------

/**
 * プリセットリモコンをあと 1 個追加できるかどうか判定する。
 *
 * vendor 実装 1:1 (references_web/src/api/useRemoteCtrl.js:226-255 canAddMoreRemote):
 *   - type が 0xfe00 (自己学習) なら無制限 → true
 *   - stateInfo.remoteList 内で type in {0x8000, 0x2000, 0xe000, 0xc000} の件数が 3 未満なら true
 *
 * vendor は counts >= 3 のときスナックバーを表示して false を返す。kit では UI が無いため
 * false を返すのみとし、呼び出し元 (addIRRemoteServer) が badRequest をスローする。
 *
 * @param {number} newType 追加しようとするリモコンの type
 * @param {Array<{type?: number|string}>} remoteList stateInfo.remoteList (対象 Hub3 デバイスの配列)
 * @returns {boolean} 追加可能なら true
 */
export function canAddMoreRemote(newType, remoteList) {
  // 自己学習リモコンは無制限 (references_web/src/api/useRemoteCtrl.js:228-231)
  if (newType === 0xfe00) return true;
  // プリセット 4 種 (エアコン=0xc000/テレビ=0x2000/照明=0xe000/扇風機=0x8000) の既存件数を数える
  // 出典: references_web/src/api/useRemoteCtrl.js:239-243
  let counts = 0;
  for (const remote of remoteList) {
    const t = Number(remote.type);
    if (t === 0x8000 || t === 0x2000 || t === 0xe000 || t === 0xc000) {
      counts++;
    }
  }
  return counts < 3;
}

// ---------- remote CRUD ----------

/**
 * リモコンを追加。
 *
 * vendor 形 (导出元: references_web/src/pages/.../ir/learn/index.js:261-270,
 *              remote-air/index.js:512-521, remote-non-air/index.js:264-273):
 *   remote = {
 *     uuid       — クライアント発番 UUID (必須; 省略時はここで generateUUID() を補完)。
 *     model      — リモコンのモデル文字列。
 *     state      — 最後に発射したコマンド HEX (初回は '')。
 *     alias      — 表示名 (vendor の localRemoteAlias)。
 *     code       — preset コード文字列。
 *     type       — リモコン種別 int (0xC000/0x2000/0xE000/0x8000/0xFE00 等)。
 *     deviceUUID — Hub3 の deviceId (= hub3DeviceId)。**必須。欠落時は badRequest。**
 *     keys       — キー配列 (初回は [])。
 *   }
 *
 * ⚠️ 旧ドキュメントの {hub3DeviceId, name, irOperation} はいずれも存在しない。
 *    vendor は uuid/alias/state/deviceUUID/keys を自前で付加してから送信しており、
 *    「search/match 出力をそのまま渡せる」は誤り。本関数でその組み立てを行う。
 *
 * 上限メモ: vendor クライアント側で type 4 種(0x8000/0x2000/0xE000/0xC000)を
 * stateInfo.remoteList で数え 3 個以上なら拒否する (canAddMoreRemote — P3-2 実装済み)。
 * サーバ側 enforcement のコードは参照に無い(「サーバ側にある」は出典なし — P3-2 訂正)。
 * 出典: references_web/src/api/useRemoteCtrl.js:226-255 (canAddMoreRemote),
 *       同 :525-531 (addIRRemote が送信前にこのガードを通す)。
 *
 * @param {WsClient} client
 * @param {{remote: object & {uuid?: string, deviceUUID?: unknown}, companyID: string}} p
 */
export async function addIRRemote(client, { remote, companyID }) {
  // deviceUUID (= hub3DeviceId) 欠落検査。参照では呼び出し元が常に渡す前提で
  // ガード無しだが、kit は組み立て後に送信するため欠落を明示拒否する。
  if (!remote.deviceUUID) throw badRequest("domain.ir.addIRRemoteDeviceUUIDRequired");
  // uuid 未指定時はクライアント発番で補完する。
  // 导出元: references_web/src/pages/.../ir/learn/index.js:262 / remote-air/index.js:513
  //         / remote-non-air/index.js:265 — いずれも biz3utils.generateUUID() で発番。
  const remoteWithUuid = remote.uuid
    ? remote
    : { ...remote, uuid: generateUUID() };
  const frame = { action: ACTION, op: "addIRRemote", remote: remoteWithUuid, companyID };
  const resp = await client.request(frame, DEFAULT_TIMEOUT_MS);
  assertSuccess(resp, "addIRRemote", { strict: true });
  return resp.data ?? null;
}

/**
 * リモコン削除。
 * @param {WsClient} client
 * @param {{hub3DeviceId: string, uuid: string, companyID: string}} p
 */
export async function deleteIRRemote(client, { hub3DeviceId, uuid, companyID }) {
  const frame = { action: ACTION, op: "deleteIRRemote", hub3DeviceId, uuid, companyID };
  const resp = await client.request(frame, DEFAULT_TIMEOUT_MS);
  assertSuccess(resp, "deleteIRRemote", { strict: true });
  return resp;
}

/**
 * リモコンの alias を更新。注: 命名差で `deviceId`/`uuid`。
 * @param {WsClient} client
 * @param {{hub3DeviceId: string, uuid: string, alias: string, companyID: string}} p
 */
export async function updateRemoteAlias(client, { hub3DeviceId, uuid, alias, companyID }) {
  const frame = {
    action: ACTION,
    op: "updateRemoteAlias",
    deviceId: hub3DeviceId, // 公式仕様: ここだけ deviceId
    uuid,
    alias,
    companyID,
  };
  const resp = await client.request(frame, DEFAULT_TIMEOUT_MS);
  assertSuccess(resp, "updateRemoteAlias", { strict: true });
  return resp;
}

/**
 * リモコンの保存 state (最後に発射した command HEX) をサーバへ永続化する (P3-2)。
 *
 * vendor (useRemoteCtrl.js:493-514 updateRemoteState):
 *   frame = { action, op:'updateRemoteState', deviceId: hub3DeviceId, uuid: remoteId,
 *             state, companyID }
 * フィールド名トラップ: Hub3 は **deviceId**、リモコンは **uuid** (alias 系と同じ命名)。
 * state はエアコン等の「最後に送った command HEX 文字列」 (remote-air/index.js:371-377 が
 * sendIR 成功後に cmd をそのまま渡す)。次回はこの state から復元する
 * (remote-air/index.js:108-113 → presetir.restoreAirState)。
 *
 * @param {WsClient} client
 * @param {{hub3DeviceId: string, uuid: string, state: string, companyID: string}} p
 */
export async function updateRemoteState(client, { hub3DeviceId, uuid, state, companyID }) {
  const frame = {
    action: ACTION,
    op: "updateRemoteState",
    deviceId: hub3DeviceId, // vendor 命名: ここは deviceId (useRemoteCtrl.js:501)
    uuid,
    state,
    companyID,
  };
  const resp = await client.request(frame, DEFAULT_TIMEOUT_MS);
  assertSuccess(resp, "updateRemoteState", { strict: true });
  return resp;
}

/**
 * リモコンを Matter デバイスとして Hub3 に登録する (P3-3)。
 *
 * vendor (useRemoteCtrl.js:933-955 addRemoteToMatter) のフィールド 1:1:
 *   frame = { action, op:'addRemoteToMatter', hub3DeviceId, irDeviceType: irRemote.type,
 *             cmdOn, cmdOff, irDeviceUUID: irRemote.uuid, irDeviceName: irRemote.alias, companyID }
 * Matter ペアリング窓 (iot.js `openMatterPairingWindow`) の開放後に呼ぶことで、リモコンが Matter の
 * On/Off デバイスとして見えるようになる (cmdOn/cmdOff は発射 command HEX)。
 *
 * @experimental 実機未検証 (参照: useRemoteCtrl.js:933-955)。
 * @param {WsClient} client
 * @param {{hub3DeviceId: string, irDeviceType: number, cmdOn: string, cmdOff: string,
 *          irDeviceUUID: string, irDeviceName: string, companyID: string}} p
 */
export async function addRemoteToMatter(client, { hub3DeviceId, irDeviceType, cmdOn, cmdOff, irDeviceUUID, irDeviceName, companyID }) {
  const frame = {
    action: ACTION,
    op: "addRemoteToMatter",
    hub3DeviceId,
    irDeviceType,
    cmdOn,
    cmdOff,
    irDeviceUUID,
    irDeviceName,
    companyID,
  };
  const resp = await client.request(frame, DEFAULT_TIMEOUT_MS);
  assertSuccess(resp, "addRemoteToMatter", { strict: true });
  return resp;
}

// ---------- key CRUD ----------

/**
 * IR キー (ボタン) を追加。学習フロー (learnIRKey) から呼ばれることが多い。
 * `irCode` の形は biz3 がオブジェクトをそのまま乗せるので、
 * 呼び出し側で {hub3DeviceId, remoteId, name, irData, irWaveLength, irType, ...} を入れる。
 * @param {WsClient} client
 * @param {{irCode: object, companyID: string}} p
 */
export async function addIRCode(client, { irCode, companyID }) {
  const frame = { action: ACTION, op: "addIRCode", irCode, companyID };
  const resp = await client.request(frame, DEFAULT_TIMEOUT_MS);
  assertSuccess(resp, "addIRCode", { strict: true });
  return resp.data || resp;
}

/**
 * キー名変更。
 * @param {WsClient} client
 * @param {{hub3DeviceId: string, remoteId: string, keyUUID: string, name: string, companyID: string}} p
 */
export async function updateIRCode(client, { hub3DeviceId, remoteId, keyUUID, name, companyID }) {
  const frame = {
    action: ACTION,
    op: "updateIRCode",
    hub3DeviceId,
    remoteId,
    keyUUID,
    name,
    companyID,
  };
  const resp = await client.request(frame, DEFAULT_TIMEOUT_MS);
  assertSuccess(resp, "updateIRCode", { strict: true });
  return resp;
}

/**
 * キー削除。
 * @param {WsClient} client
 * @param {{hub3DeviceId: string, remoteId: string, keyUUID: string, companyID: string}} p
 */
export async function deleteIRCode(client, { hub3DeviceId, remoteId, keyUUID, companyID }) {
  const frame = {
    action: ACTION,
    op: "deleteIRCode",
    hub3DeviceId,
    remoteId,
    keyUUID,
    companyID,
  };
  const resp = await client.request(frame, DEFAULT_TIMEOUT_MS);
  assertSuccess(resp, "deleteIRCode", { strict: true });
  return resp;
}

// ---------- mode 制御 + subscribe ----------

/**
 * 現在の IR モード (CONTROL=0 / REGISTER=1) を取得。
 * @param {WsClient} client
 * @param {{deviceId: string, companyID: string}} p
 */
export async function getIRMode(client, { deviceId, companyID }) {
  const frame = { action: ACTION, op: "getIRMode", deviceId, companyID };
  const resp = await client.request(frame, DEFAULT_TIMEOUT_MS);
  assertSuccess(resp, "getIRMode", { strict: true });
  return resp.data;
}

/**
 * モード切替。学習するには REGISTER に入れる必要がある。
 * @param {WsClient} client
 * @param {{deviceId: string, mode: number, companyID: string}} p
 */
export async function setIRMode(client, { deviceId, mode, companyID }) {
  const frame = { action: ACTION, op: "setIRMode", deviceId, mode, companyID };
  const resp = await client.request(frame, DEFAULT_TIMEOUT_MS);
  assertSuccess(resp, "setIRMode", { strict: true });
  return resp;
}

/**
 * IR データ (= 学習で取り込まれた赤外線波形) の購読を開始。
 * 戻り値は `{ unsubscribe, onData }`。`onData(fn)` で `subscribeIRDataRsp` 受信ごとに fn が呼ばれる。
 * 利用後は必ず `unsubscribe()` を呼ぶこと。
 * @param {WsClient} client
 * @param {{deviceId: string, companyID: string}} p
 * @returns {Promise<{onData: (fn: (msg: any) => void) => (() => void), unsubscribe: () => void}>}
 */
export async function subscribeIRData(client, { deviceId, companyID }) {
  const topic = dataTopic(deviceId);
  const ackFrame = {
    action: ACTION,
    op: "subscribeIRData",
    topic,
    deviceId,
    companyID,
  };
  const ack = await client.request(ackFrame, DEFAULT_TIMEOUT_MS);
  if (!ack.success) throw rejected(t("domain.ir.subscribeIRDataFailed", { detail: ack.message || JSON.stringify(ack) }), { upstreamCode: ack?.code ?? null });

  /** @type {Set<(msg: any) => void>} */
  const listeners = new Set();
  // ★ 独自追加: 多デバイス購読の利便のため deviceId フィルタを維持するが、
  //   大文字小文字・ハイフン差を吸収するため normalizeUuid 同士で比較する。
  //   参照 (useRemoteCtrl.js:306-333) は全購読者へ配布しフィルタを持たない。
  const normalDeviceId = normalizeUuid(deviceId);
  const unsub = client.subscribe(`${ACTION}:subscribeIRDataRsp`, (msg) => {
    if (msg?.deviceId && normalizeUuid(msg.deviceId) !== normalDeviceId) return;
    for (const fn of listeners) {
      try { fn(msg); } catch { /* ignore */ }
    }
  });

  return {
    /** @param {(msg: any) => void} fn */
    onData(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    unsubscribe() {
      unsub();
      listeners.clear();
      // fire-and-forget で server に解除通知 (Review H-5: request にすると 10s block)
      try {
        client.send({ action: ACTION, op: "unsubscribeIRData", topic, deviceId, companyID });
      } catch { /* ignore */ }
    },
  };
}

/**
 * モード変化 (例: REGISTER から CONTROL に戻った瞬間) の購読。subscribeIRData と同形。
 * @param {WsClient} client
 * @param {{deviceId: string, companyID: string}} p
 * @returns {Promise<{onData: (fn: (msg: any) => void) => (() => void), unsubscribe: () => void}>}
 */
export async function subscribeIRMode(client, { deviceId, companyID }) {
  const topic = modeTopic(deviceId);
  const ack = await client.request(
    { action: ACTION, op: "subscribeIRMode", topic, deviceId, companyID },
    DEFAULT_TIMEOUT_MS,
  );
  if (!ack.success) throw rejected(t("domain.ir.subscribeIRModeFailed", { detail: ack.message || JSON.stringify(ack) }), { upstreamCode: ack?.code ?? null });
  /** @type {Set<(msg: any) => void>} */
  const listeners = new Set();
  // ★ 独自追加: 多デバイス購読の利便のため deviceId フィルタを維持するが、
  //   大文字小文字・ハイフン差を吸収するため normalizeUuid 同士で比較する。
  //   参照 (useRemoteCtrl.js:306-333) は全購読者へ配布しフィルタを持たない。
  const normalDeviceIdMode = normalizeUuid(deviceId);
  const unsub = client.subscribe(`${ACTION}:subscribeIRModeRsp`, (msg) => {
    if (msg?.deviceId && normalizeUuid(msg.deviceId) !== normalDeviceIdMode) return;
    for (const fn of listeners) {
      try { fn(msg); } catch { /* ignore */ }
    }
  });
  return {
    /** @param {(msg: any) => void} fn */
    onData(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    unsubscribe() {
      unsub();
      listeners.clear();
      try {
        client.send({ action: ACTION, op: "unsubscribeIRMode", topic, deviceId, companyID });
      } catch { /* ignore */ }
    },
  };
}

// ---------- match (学習波形から既知リモコンを照合) ----------

/**
 * 学習で取った irData を既知のメーカー DB と照合する。
 * @param {WsClient} client
 * @param {{irData:string, irType:number, brandName?:string, companyID:string}} p
 */
export async function matchRemote(client, { irData, irType, brandName, companyID }) {
  // P3-10: vendor (useRemoteCtrl.js:785-797) は brandName を常に値ありで渡す。
  // brandName 未指定時は空文字でなくキー自体を省く (1:1 逸脱の解消)。
  const frame = {
    action: ACTION,
    op: "matchRemote",
    irData,
    irWaveLength: irData.length / 2,
    irType,
    ...(brandName !== undefined && { brandName }),
    companyID,
  };
  const resp = await client.request(frame, DEFAULT_TIMEOUT_MS);
  assertSuccess(resp, "matchRemote", { strict: true });
  // biz3 remote-match/index.js:158: 一致候補は response.data.matches (配列)
  return /** @type {{matches?: any[]}} */ (resp.data ?? {}).matches || [];
}

// ---------- composite: 学習フロー ----------

/**
 * 物理リモコンのボタン 1 個を学習して、リモコンに新キーとして登録する。
 *
 *   1. setIRMode(REGISTER) — Hub3 を学習モードに
 *   2. subscribeIRData — 波形イベント購読
 *   3. (ユーザが物理リモコンを Hub3 に向けてボタンを押す)
 *   4. subscribeIRDataRsp イベントで波形を受信
 *   5. unsubscribeIRData + setIRMode(CONTROL)
 *   6. addIRCode で名前付きキーとして保存
 *
 * @param {{
 *   hub3DeviceId: string,
 *   remoteId: string,            // 既存リモコンの irDeviceUUID
 *   keyName: string,
 *   irType: number,              // remote.type
 *   companyID: string,
 *   timeoutMs?: number,          // ボタン押下待ち timeout (default 60s)
 *   onPrompt?: () => void,       // 学習モード突入後に呼ばれる (ユーザに「ボタン押して」と促す)
 * }} p
 * @param {WsClient} client
 * @returns {Promise<{keyUUID: string, captured: any, saved: any}>}
 *   keyUUID はクライアント発番 (これを send の command に使う)
 */
export async function learnIRKey(client, p) {
  const timeoutMs = p.timeoutMs ?? LEARN_DEFAULT_TIMEOUT_MS;

  await setIRMode(client, { deviceId: p.hub3DeviceId, mode: MODE.REGISTER, companyID: p.companyID });
  const sub = await subscribeIRData(client, { deviceId: p.hub3DeviceId, companyID: p.companyID });

  // biz3 learn/index.js:217-228 に厳密に合わせる:
  //   - 波形は subscribeIRDataRsp の `response.data.data` (msg.data.data)
  //   - keyUUID は **クライアントが発番** (generateUUID)。サーバ発番ではない。
  //   - addIRCode に渡す irCode = {keyUUID, name, uuid: remote.uuid, deviceId: hub3, data: 波形}
  /** @type {any} */
  let waveform = null;
  try {
    if (p.onPrompt) try { p.onPrompt(); } catch { /* ignore */ }
    waveform = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(timeoutError(t("domain.ir.learnTimeout"))), timeoutMs);
      sub.onData((/** @type {any} */ msg) => {
        // biz3 learn/index.js:217-249: response.success === false は失敗処理 (データは success 時のみ採用)。
        if (msg?.success === false) {
          clearTimeout(to);
          reject(rejected(t("domain.ir.learnFailed", { detail: msg?.message || "" }), { upstreamCode: msg?.code ?? null }));
          return;
        }
        const data = msg?.data?.data; // biz3: response.data.data が生波形
        // 波形が空/undefined のまま addIRCode へ進むと壊れたキーを保存するため reject する。
        // 意図的逸脱 (§0.1-2): vendor remote-match/index.js:142-149 は `!data` も待機継続だが、
        // 学習フローでは timeout まで黙って待つより明示失敗の方が誤保存を確実に防げる。
        if (data == null || data.length === 0) {
          clearTimeout(to);
          reject(rejected(t("domain.ir.learnEmptyWaveform")));
          return;
        }
        // biz3 remote-match/index.js:142-149: 波形長 <= 50 はノイズ扱いで無視して待機継続
        // ("learning data is empty, continue waiting...")。timeout タイマーは走らせたまま。
        if (data.length <= 50) return;
        clearTimeout(to);
        resolve(data);
      });
    });
  } finally {
    sub.unsubscribe();
    try {
      await setIRMode(client, { deviceId: p.hub3DeviceId, mode: MODE.CONTROL, companyID: p.companyID });
    } catch { /* ignore */ }
  }

  const keyUUID = generateUUID();
  const irCode = {
    keyUUID,
    name: p.keyName,
    uuid: p.remoteId,        // biz3: remote.uuid (= リモコンの irDeviceUUID)
    deviceId: p.hub3DeviceId, // biz3: hub3DeviceId
    data: waveform,           // biz3: response.data.data
  };
  const saved = await addIRCode(client, { irCode, companyID: p.companyID });
  return { keyUUID, captured: waveform, saved };
}

export { MODE };
