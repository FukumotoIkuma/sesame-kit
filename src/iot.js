// SESAME Hub3 / WM2 経由のぶら下がりデバイス制御 (biz3OperateIoT / op='cmd')。
//
// Ported from biz3 (CANDY-HOUSE/biz3, MIT):
//   - vendor reference: references_web/src/api/useIotCtrl.js (sendCommandToHub3WithConnectionId,
//       handleSesameItemOperation)
//   - vendor reference: references_web/src/hooks/useOperateIoT.js (sendCmd, iotReceive)
//   - vendor reference: references_web/src/utils/biz3utils.js (stringToUint8Array,
//       hexStringToUint8Array, getMatterProductTypeFromModelName)
//   - vendor reference: references_web/src/components/MobileBindDevice.js / MobileWifiModule.js /
//       biz/device/VIotSwitch.js / biz/device/UpgradeFirmware.js (高レベル呼び出し例)
//
// プロトコル概要 (useIotCtrl.js:110-228):
//   1. topic を hub3_id から構築:  `wm2${hub3_id.split('-').pop()}cmd`
//      (大文字小文字変換は一切しない。UUID 末尾セグメント=末尾12hex を素のまま使う)
//   2. payload バイト連結:
//        signArray(4B) ++ cmdArray(1B = cmd の下位8bit) ++ didArray(device_id を UTF8 化したバイト列)
//        ++ (cmd 別追加バイト)
//      ※ device_id は hex デコードせず TextEncoder で UTF8 バイト化する。
//        ハイフン込み 36 文字の UUID 文字列は 36 バイトとして入る (useIotCtrl.js:127)。
//   3. payload = Buffer.from(payloadArray).toString('base64') (useIotCtrl.js:222)
//   4. 送信フレーム = { action:'biz3OperateIoT', topic, payload, op:'cmd' }
//      (useOperateIoT.js:54-61 sendCmd が { action, ...cmd } を sendMessage に投げるだけ)。
//      companyID/apiKeyId/connectionId は付けない (connectionId はクラウドが自動付与:
//      useIotCtrl.js:129-132)。
//
// sign (= CMAC 時刻署名) は crypto.cmacTime(secretKey) で得る。biz3 Cmac.cmacTime と同一実装で、
//   8 hex 文字 (4B) を返す。それを hexStringToUint8Array で 4 バイトに戻して連結する
//   (useIotCtrl.js:120-121)。署名鍵は『その device の secretKey (32hex)』である点に注意。
//
// 応答モデル (useOperateIoT.js:6-43):
//   応答も action='biz3OperateIoT'。message.op は『数値の cmdCode が echo されたもの』で、
//   これをキーにディスパッチされる。よって transport の購読キーは `biz3OperateIoT:<cmdCode>`
//   (transport.js:395 が `${msg.action}:${msg.op || ""}` を作る。数値 op は文字列化される)。
//   実データは message.data (あれば)。device 特定は message.UUID || message.touch_id。
//   送信は fire-and-forget (sendCmd は応答を待たない) なので、応答が要るものは client.subscribe で受ける。

import { t } from "./i18n.js";
import { cmacTime } from "./crypto.js";
import { ACTION_TYPES } from "../vendor/biz3/constants/messageConstants.js";
import { cmdCode } from "../vendor/biz3/constants/cmdCode.js";
import { modelNameByProductType } from "../vendor/biz3/constants/sesameDeviceModel.js";

const ACTION = ACTION_TYPES.BIZ3_OPERATE_IOT; // "biz3OperateIoT" (vendor 由来)
const DEFAULT_TIMEOUT_MS = 10_000;

// ---------- 低レベル binary helpers (biz3utils 移植) ----------

/**
 * hex 文字列を Uint8Array に変換 (biz3utils.js:221-235)。
 * null/undefined は空配列 (biz3utils と同挙動)。奇数長は例外。
 * @param {string|null|undefined} hexString
 * @returns {Uint8Array}
 */
function hexStringToUint8Array(hexString) {
  if (hexString === undefined || hexString === null) return new Uint8Array(0);
  if (hexString.length % 2 !== 0) throw new Error(t("iot.err.invalidHexString"));
  const out = new Uint8Array(hexString.length / 2);
  for (let i = 0; i < hexString.length; i += 2) {
    out[i / 2] = parseInt(hexString.substring(i, i + 2), 16);
  }
  return out;
}

/**
 * 文字列を UTF8 バイト列に変換 (biz3utils.js:240-243 stringToUint8Array)。
 * @param {string} str
 * @returns {Uint8Array}
 */
function stringToUint8Array(str) {
  return new TextEncoder().encode(str);
}

/**
 * deviceModel 名 → productType の数値 (biz3utils.js:53-56)。
 * vendor の modelNameByProductType を逆引き。未知は null。
 * @param {string} modelName
 * @returns {number|null}
 */
function getProductTypeFromModelName(modelName) {
  const entry = Object.entries(modelNameByProductType).find(([, name]) => name === modelName);
  return entry ? parseInt(entry[0], 10) : null;
}

// biz3utils.js:64-100 の matterProductTypeMap を厳密に移植 (vendor に同等定数が無いため)。
// productType → matter product type。29 は biz3 でもコメントアウト (= undefined を返す)。
const MATTER_PRODUCT_TYPE_MAP = Object.freeze({
  1: 255, 2: 255, 3: 255, 4: 255, 5: 0, 6: 0, 7: 0, 8: 255, 9: 255, 10: 255,
  11: 255, 13: 255, 14: 255, 15: 255, 16: 0, 17: 1, 18: 255, 19: 255, 20: 0,
  21: 0, 22: 255, 23: 255, 24: 255, 25: 255, 26: 255, 27: 255, 28: 255,
  30: 255, 31: 255, 32: 0, 33: 0, 34: 0, 35: 1,
});

/**
 * deviceModel 名 → matter product type (biz3utils.js:58-101)。
 * productType が不明なら null。map に無ければ undefined。
 * @param {string} modelName
 * @returns {number|null|undefined}
 */
function getMatterProductTypeFromModelName(modelName) {
  const productType = getProductTypeFromModelName(modelName);
  if (productType === null) return null;
  return MATTER_PRODUCT_TYPE_MAP[productType];
}

/**
 * Uint8Array を連結する小ヘルパー (biz3 の手動 offset 連結を簡潔化)。
 * @param  {...Uint8Array} arrays
 * @returns {Uint8Array}
 */
function concatBytes(...arrays) {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

// ---------- topic / payload 構築 ----------

/**
 * hub3_id から MQTT cmd topic を構築する (useIotCtrl.js:112-116)。
 * hub3_id 未指定なら device_id を流用 (WiFi モデルは自身が Hub3)。
 * 大文字小文字変換は一切しない。
 * @param {string} hub3Id 親 Hub3 (または自身) の UUID (ハイフン付き小文字想定)
 * @returns {string} `wm2{末尾セグメント}cmd`
 */
export function buildIotTopic(hub3Id) {
  if (!hub3Id) throw new Error(t("iot.err.hub3IdRequiredTopic"));
  const lastSegment = hub3Id.split("-").pop();
  return `wm2${lastSegment}cmd`;
}

/**
 * iot cmd の payload バイト列を構築し base64 文字列を返す (useIotCtrl.js:120-222)。
 * 連結順: signArray(4B) ++ cmd(1B) ++ device_id UTF8 ++ extra(任意)。
 *
 * @param {{
 *   cmd: number,            // cmdCode (下位8bit のみ採用)
 *   deviceId: string,       // 対象デバイスの UUID 文字列 (UTF8 バイト化される)
 *   secretKey: string,      // 32hex。署名に使う device の secretKey
 *   extra?: Uint8Array,     // cmd 別追加バイト (無ければ無し)
 * }} p
 * @returns {string} base64 payload
 */
export function buildIotPayload({ cmd, deviceId, secretKey, extra }) {
  if (typeof cmd !== "number") throw new Error(t("iot.err.cmdRequired"));
  if (!deviceId) throw new Error(t("iot.err.deviceIdRequired"));
  if (!secretKey) throw new Error(t("iot.err.secretKeyRequiredCmac"));

  const sign = cmacTime(secretKey);                 // 8 hex (4B)
  const signArray = hexStringToUint8Array(sign);    // 4 bytes
  const cmdArray = new Uint8Array([cmd & 0xff]);
  const didArray = stringToUint8Array(deviceId);    // UTF8 (UUID 文字列そのまま)

  let payloadArray = concatBytes(signArray, cmdArray, didArray);
  if (extra && extra.length > 0) {
    payloadArray = concatBytes(payloadArray, extra);
  }
  return Buffer.from(payloadArray).toString("base64");
}

// ---------- 低レベル送信 ----------

/**
 * 既に組み上げた topic / base64 payload で iot cmd を送る (useOperateIoT.js:54-61)。
 * 送信は fire-and-forget。応答 (op=数値cmdCode) を待ちたい場合は
 * subscribeIotResponse を併用するか、send 前後で購読すること。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{ topic: string, payload: string, op?: string }} p op は既定 'cmd'
 * @returns {void}
 */
export function sendIotCmd(client, { topic, payload, op = "cmd" }) {
  if (!topic) throw new Error(t("iot.err.topicRequired"));
  if (!payload) throw new Error(t("iot.err.payloadRequiredBase64"));
  client.send({ action: ACTION, topic, payload, op });
}

/**
 * iot cmd の応答 push を購読する (useOperateIoT.js:6-43)。
 * 購読キーは `biz3OperateIoT:<cmdCode>` (応答の message.op は数値 cmdCode の echo)。
 * 戻り値の unsubscribe を必ず呼ぶこと。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {number} cmd 待ち受ける cmdCode (応答 op と一致)
 * @param {(msg:any)=>void} fn 応答コールバック (msg 全体を渡す)
 * @returns {()=>void} unsubscribe
 */
export function subscribeIotResponse(client, cmd, fn) {
  return client.subscribe(`${ACTION}:${cmd}`, fn);
}

/**
 * iot cmd を送信し、対象デバイスからの応答 push (op=cmd) を 1 件待つ共通ヘルパー。
 *
 * 応答 push は op=数値cmdCode で届き、device 特定は message.UUID || message.touch_id
 * (useOperateIoT.js:9-18)。deviceId 指定時はそれと一致する push のみ採用する。
 *
 * 注意 (未確認): RELAY_SWITCH(208) / CLEAR_WIFI_SSID(210) など、biz3 web 側に専用
 * コールバック登録が無い cmd は応答 push が来ない可能性がある。それらは
 * sendIotCmd (fire-and-forget) を使うこと。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{
 *   topic: string,
 *   payload: string,
 *   cmd: number,                // 応答 op と照合する cmdCode
 *   deviceId?: string,          // 応答の UUID/touch_id と照合 (省略時は最初の応答を採用)
 *   timeoutMs?: number,
 * }} p
 * @returns {Promise<any>} 応答 message (data があれば message 全体を返す。data 抽出は呼び出し側)
 */
export function sendIotCmdAwait(client, { topic, payload, cmd, deviceId, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const target = normalizeUuid(deviceId);
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => {
      unsub();
      reject(new Error(t("iot.err.cmdTimeout", { cmd, topic })));
    }, timeoutMs);
    const unsub = subscribeIotResponse(client, cmd, (msg) => {
      // device 照合: vendor は message.UUID || message.touch_id のみ (確認: useOperateIoT.js:9-17)。
      if (target) {
        const incoming = normalizeUuid(msg?.UUID || msg?.touch_id);
        if (incoming && incoming !== target) return;
      }
      clearTimeout(to);
      unsub();
      resolve(msg);
    });
    // 購読確立後に送信 (race 防止)
    sendIotCmd(client, { topic, payload });
  });
}

// ---------- 高レベルラッパ ----------

/**
 * Hub3 (WiFi) 本体 LED の調光を設定/取得する (cmdCode=92 / 0x5C, useIotCtrl.js:163-190,
 * MobileWifiModule.js:129-172)。
 * payload extra = [op(1B), duty(1B)]。op は set=0x01 / get=0x02。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{
 *   deviceId: string,          // Hub3 の deviceUUID
 *   secretKey: string,         // Hub3 の secretKey (32hex)
 *   hub3Id?: string,           // topic 用。省略時 deviceId
 *   op: number,                // 0x01=set / 0x02=get (0..255)
 *   duty: number,              // 0..255 (set 時の輝度。get 時もダミー必須)
 *   timeoutMs?: number,
 * }} p
 * @returns {Promise<{ ledDuty: number|undefined, message: any }>} data.ledDuty (0..255)
 */
export async function setHub3LedDuty(client, p) {
  const { deviceId, secretKey, hub3Id, op, duty, timeoutMs } = p;
  if (op === undefined || duty === undefined) throw new Error(t("iot.err.opDutyRequired"));
  if (op < 0 || op > 255 || duty < 0 || duty > 255) {
    throw new Error(t("iot.err.opDutyRange"));
  }
  const cmd = cmdCode.HUB3_ITEM_CODE_LED_DUTY; // 92
  const topic = buildIotTopic(hub3Id || deviceId);
  const extra = new Uint8Array([op, duty]);
  const payload = buildIotPayload({ cmd, deviceId, secretKey, extra });
  const msg = await sendIotCmdAwait(client, { topic, payload, cmd, deviceId, timeoutMs });
  return { ledDuty: msg?.data?.ledDuty, message: msg };
}

/**
 * Hub3 LTE リレー (継電器) を開閉する (cmdCode=208 / 0xD0, useIotCtrl.js:192-213,
 * VIotSwitch.js:56-71)。
 * payload extra = [op(1B)] (省略時 op=0x01 = 開閉操作)。
 *
 * 応答 push は biz3 web に専用コールバック登録が無いため未確認 (spec responseShape:
 * useIotCtrl.js:192-213)。本ラッパは fire-and-forget で送信する (応答は待たない)。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{
 *   deviceId: string,          // Hub3 LTE の deviceUUID
 *   secretKey: string,         // 32hex
 *   hub3Id?: string,           // topic 用。省略時 deviceId
 *   op?: number,               // 既定 0x01
 * }} p
 * @returns {void}
 */
export function hub3RelaySwitch(client, p) {
  const { deviceId, secretKey, hub3Id, op = 0x01 } = p;
  if (op < 0 || op > 255) throw new Error(t("iot.err.opRange"));
  const cmd = cmdCode.HUB3_ITEM_CODE_RELAY_SWITCH; // 208
  const topic = buildIotTopic(hub3Id || deviceId);
  const extra = new Uint8Array([op]);
  const payload = buildIotPayload({ cmd, deviceId, secretKey, extra });
  sendIotCmd(client, { topic, payload });
}

/**
 * ADD/REMOVE_SESAME の追加バイトを構築する (handleSesameItemOperation, useIotCtrl.js:53-107)。
 * 連結順: sesameId(16B) ++ secretKey(16B) ++ nickNameLen(1B) ++ nickNameUTF8 ++
 *         productType(1B) ++ matterProductType(1B)。
 *
 * @param {{ sesameId: string, ssmSecKa: string, nickName?: string, deviceModel: string }} iotPayload
 * @returns {Uint8Array}
 */
function buildSesameItemExtra(iotPayload) {
  // sesameId はハイフン除去 → hex デコード (16B)
  const cleanSesameId = iotPayload.sesameId?.replace(/-/g, "") ?? "";
  const sesameIdArray = hexStringToUint8Array(cleanSesameId);

  // ssmSecKa は hex デコード (16B)
  const secretKeyArray = hexStringToUint8Array(iotPayload.ssmSecKa);

  // nickName は UTF8。長さは 1 バイトに収める (>255 で例外)
  const nickName = iotPayload.nickName || "";
  const nickNameArray = stringToUint8Array(nickName);
  if (nickNameArray.length > 255) {
    throw new Error(t("iot.err.nicknameTooLong"));
  }
  const nickNameLenArray = new Uint8Array([nickNameArray.length]);

  // 未知の deviceModel だと getProductTypeFromModelName が null → Uint8Array([null]) が
  // 黙って 0 を詰めてしまう。add/rm-sesame は鍵を含む確定操作なので、誤った productType を
  // 実機へ送る前にここで弾く (安全側)。
  const productType = getProductTypeFromModelName(iotPayload.deviceModel);
  if (productType === null) {
    throw new Error(t("iot.err.unknownModel", { model: JSON.stringify(iotPayload.deviceModel) }));
  }
  const productTypeArray = new Uint8Array([productType]);
  // matterProductType は productType が既知でも map 外 (例 productType 29) なら undefined。
  // biz3 もこの場合 undefined → 0 として送るため (意図的)、ここでは 0 にフォールバックする。
  const matterProductTypeArray = new Uint8Array([getMatterProductTypeFromModelName(iotPayload.deviceModel) ?? 0]);

  return concatBytes(
    sesameIdArray,
    secretKeyArray,
    nickNameLenArray,
    nickNameArray,
    productTypeArray,
    matterProductTypeArray,
  );
}

/**
 * Hub3 にぶら下がり Sesame を追加する (cmdCode=101 / 0x65, useIotCtrl.js:53-107/159-161,
 * MobileBindDevice.js:70-97)。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{
 *   hub3Id: string,            // 親 Hub3 の deviceUUID (= device_id として payload に入る + topic)
 *   secretKey: string,         // 親 Hub3 の secretKey (32hex)。署名に使う
 *   sesameId: string,          // 追加する Sesame の UUID
 *   ssmSecKa: string,          // Sesame の secretKey (32hex)
 *   nickName?: string,
 *   deviceModel: string,       // 例 'sesame_5' (productType/matterProductType 導出に必要)
 *   timeoutMs?: number,
 * }} p
 * @returns {Promise<{ ssks: any, message: any }>} data.ssks (ぶら下がりリスト状態)
 */
export async function addSesameToHub3(client, p) {
  const cmd = cmdCode.SSM3_ITEM_ADD_SESAME; // 101
  return sesameItemOp(client, { ...p, cmd });
}

/**
 * Hub3 からぶら下がり Sesame を削除する (cmdCode=103 / 0x67, useIotCtrl.js:155-158)。
 * payload packing は ADD と完全同形 (handleSesameItemOperation を共用)。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {Parameters<typeof addSesameToHub3>[1]} p addSesameToHub3 と同じ
 * @returns {Promise<{ ssks: any, message: any }>}
 */
export async function removeSesameFromHub3(client, p) {
  const cmd = cmdCode.SSM3_ITEM_REMOVE_SESAME; // 103
  return sesameItemOp(client, { ...p, cmd });
}

/** ADD/REMOVE 共通処理。device_id = hub3Id (親 Hub3 の UUID)。 */
async function sesameItemOp(client, p) {
  const { hub3Id, secretKey, sesameId, ssmSecKa, nickName, deviceModel, cmd, timeoutMs } = p;
  if (!hub3Id) throw new Error(t("iot.err.hub3IdRequired"));
  if (!sesameId) throw new Error(t("iot.err.sesameIdRequired"));
  if (!ssmSecKa) throw new Error(t("iot.err.ssmSecKaRequired"));
  if (!deviceModel) throw new Error(t("iot.err.deviceModelRequired"));

  const topic = buildIotTopic(hub3Id);
  const extra = buildSesameItemExtra({ sesameId, ssmSecKa, nickName, deviceModel });
  // device_id は親 Hub3 の UUID (MobileBindDevice.js:75-80 → sendCommandToHub3WithConnectionId は
  // device_id=hub3UUID で呼ばれる)。
  const payload = buildIotPayload({ cmd, deviceId: hub3Id, secretKey, extra });
  const msg = await sendIotCmdAwait(client, { topic, payload, cmd, deviceId: hub3Id, timeoutMs });
  return { ssks: msg?.data?.ssks, message: msg };
}

/**
 * ファームウェア更新 (DFU) をトリガする (cmdCode=0x03, useIotCtrl.js:110-111/153,
 * UpgradeFirmware.js:98-120)。
 * iotPayload なし。payload = [sign, cmd=0x03, device_id]。
 *
 * 進捗は長時間にわたり複数回 push で届く (data={progress, versionTag, UUID})。
 * versionTag があれば完了。よって応答は subscribeIotResponse で複数回受ける設計とし、
 * 本関数は送信のみ + 購読 unsubscribe を返す。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{
 *   deviceId: string,          // 更新対象の UUID (payload の device_id)
 *   hub3Id?: string,           // topic 用 (親 Hub3。WiFi モデルは自身)。省略時 deviceId
 *   secretKey: string,         // 32hex
 *   onProgress?: (data:{progress?:number, versionTag?:string, UUID?:string})=>void,
 * }} p
 * @returns {()=>void} unsubscribe (進捗購読の解除)
 */
export function startFirmwareUpdate(client, p) {
  const { deviceId, hub3Id, secretKey, onProgress } = p;
  const cmd = cmdCode.ssmOSUpdate; // 0x03
  const topic = buildIotTopic(hub3Id || deviceId);
  const payload = buildIotPayload({ cmd, deviceId, secretKey });

  let unsub = () => {};
  if (onProgress) {
    const target = normalizeUuid(deviceId);
    unsub = subscribeIotResponse(client, cmd, (msg) => {
      if (target) {
        const incoming = normalizeUuid(msg?.UUID || msg?.touch_id); // vendor: useOperateIoT.js:9-17
        if (incoming && incoming !== target) return;
      }
      try { onProgress(msg?.data ?? msg); } catch { /* ignore */ }
    });
  }
  sendIotCmd(client, { topic, payload });
  return unsub;
}

/**
 * Hub3 の保存 WiFi 設定をクリアする (cmdCode=210 / 0xD2, useIotCtrl.js:214-215,
 * MobileWifiModule.js:146-153)。追加バイト無し。
 *
 * 応答 push は専用コールバック登録が無く未確認のため fire-and-forget。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{ deviceId: string, secretKey: string, hub3Id?: string }} p
 * @returns {void}
 */
export function clearHub3WifiSsid(client, { deviceId, secretKey, hub3Id }) {
  const cmd = cmdCode.HUB3_ITEM_CODE_CLEAR_WIFI_SSID; // 210
  const topic = buildIotTopic(hub3Id || deviceId);
  const payload = buildIotPayload({ cmd, deviceId, secretKey });
  sendIotCmd(client, { topic, payload });
}

/**
 * Matter ペアリングコード (QR/手動コード) を取得する (cmdCode=137 / 0x89,
 * MobileWifiModule.js:82-96)。iotPayload なし。
 *
 * 注意: cmdCode 137 は STP_ITEM_CODE_PASSCODE_CHANGE_VALUE とも重複定義 (cmdCode.js:73,80)。
 * Hub3 文脈で使うこと。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{ deviceId: string, secretKey: string, hub3Id?: string, timeoutMs?: number }} p
 * @returns {Promise<{ qrCode: string|undefined, manualCode: string|undefined, message: any }>}
 */
export async function getMatterPairingCode(client, p) {
  const { deviceId, secretKey, hub3Id, timeoutMs } = p;
  const cmd = cmdCode.HUB3_MATTER_PAIRING_CODE; // 137
  const topic = buildIotTopic(hub3Id || deviceId);
  const payload = buildIotPayload({ cmd, deviceId, secretKey });
  const msg = await sendIotCmdAwait(client, { topic, payload, cmd, deviceId, timeoutMs });
  return { qrCode: msg?.data?.qrCode, manualCode: msg?.data?.manualCode, message: msg };
}

/**
 * Matter ペアリング窓を開く (cmdCode=153 / 0x99, MobileWifiModule.js:97-126)。iotPayload なし。
 * data={statusCode}。statusCode===0 で成功。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{ deviceId: string, secretKey: string, hub3Id?: string, timeoutMs?: number }} p
 * @returns {Promise<{ statusCode: number|undefined, message: any }>}
 */
export async function openMatterPairingWindow(client, p) {
  const { deviceId, secretKey, hub3Id, timeoutMs } = p;
  const cmd = cmdCode.HUB3_MATTER_PAIRING_WINDOW; // 153
  const topic = buildIotTopic(hub3Id || deviceId);
  const payload = buildIotPayload({ cmd, deviceId, secretKey });
  const msg = await sendIotCmdAwait(client, { topic, payload, cmd, deviceId, timeoutMs });
  return { statusCode: msg?.data?.statusCode, message: msg };
}

function normalizeUuid(s) {
  return typeof s === "string" ? s.replace(/-/g, "").toLowerCase() : "";
}

// テスト用に内部ヘルパーも公開 (frame/byte 検証のため)。
export const __internal = {
  hexStringToUint8Array,
  stringToUint8Array,
  getProductTypeFromModelName,
  getMatterProductTypeFromModelName,
  buildSesameItemExtra,
  concatBytes,
};

/**
 * namespace (hub.iot.*) に露出する client op の allowlist。
 * buildIotTopic / buildIotPayload / __internal は client を取らない内部ヘルパー
 * なので namespace に出さない (低レベル用途は index.js から直接 import)。
 *
 * subscribeIotResponse(client, cmd, fn) は (params) 1 引数の namespace/JSON-RPC 規約に
 * 適合しない購読プリミティブ (第2引数が cmd 数値、第3がコールバック) なので allowlist に
 * 載せない。sendIotCmdAwait が内部で直接使うほか、低レベル購読が要る利用者は
 * `import { iot } from "sesame-kit"` で直接 import する。
 */
export const NAMESPACE_OPS = [
  "sendIotCmd", "sendIotCmdAwait",
  "setHub3LedDuty", "hub3RelaySwitch",
  "addSesameToHub3", "removeSesameFromHub3",
  "startFirmwareUpdate", "clearHub3WifiSsid",
  "getMatterPairingCode", "openMatterPairingWindow",
];
