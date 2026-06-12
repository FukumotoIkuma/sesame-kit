// エントリ: device — デバイス一覧・履歴・電池・リネーム・削除・アクセス・認証データ・WebAPI。
// `Record<string, MethodEntry>` を返す純関数として機械分割 (P5-2)。
//
// キー順を保持するため 3 関数に分割する:
//   deviceEntriesPre    — config.* より前のエントリ (devices/access.register/device/firmware)
//   webapiEntries       — config.* の直後 (webapi.*)
//   accessAuthEntries   — ir.* の直後 (access.postAuthenticationData 等)
// buildRegistry() は configEntries/irEntries を挟んで 3 つを呼ぶ。

import { RpcError, RPC, KIND } from "../../jsonrpc.js";
import { requireAuth, need } from "../registry-helpers.js";
import { t } from "../../i18n.js";

const S = { type: "string" };
const N = { type: "number" };
const B = { type: "boolean" };
const O = { type: "object" };
const A = { type: "array" };

/**
 * config.* より前のデバイス系エントリ (devices/access.register/device/firmware)。
 * @returns {Record<string, import("../registry-helpers.js").MethodEntry>}
 */
export function deviceEntriesPre() {
  return {
    "devices.list": {
      summary: t("serve.sum.devicesList"),
      params: [], result: "device[]",
      handler: ({ hub, daemon }) => { requireAuth(daemon); return hub.listDevices(); },
    },
    "devices.userList": {
      summary: t("serve.sum.devicesUserList"),
      params: [], result: "device[]",
      handler: ({ hub, daemon }) => { requireAuth(daemon); return hub.listUserDevices(); },
    },
    // P3-1: biz3ManageDevice 残り 5 op (useManageDevice.js:256-372)。いずれも experimental
    // (STABLE_METHODS 非掲載)。items の形は vendor 透過 (QR 由来キー / デバイスオブジェクト)。
    "devices.add": {
      summary: t("serve.sum.devicesAdd"),
      params: [{ name: "items", required: true, desc: t("serve.desc.devicesAddItems"), schema: { type: "array", items: { type: "object" } } }],
      result: "manageDevice ack ('Limit Exceeded' propagates as rejected)",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["items"]); return hub.addDevices(params.items); },
    },
    "devices.reorder": {
      summary: t("serve.sum.devicesReorder"),
      params: [{ name: "items", required: true, desc: t("serve.desc.devicesReorderItems"), schema: { type: "array", items: { type: "object" } } }],
      result: "reordered device[] (resp.data)",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["items"]); return hub.reorderDevices(params.items); },
    },
    "devices.notifyStatus": {
      summary: t("serve.sum.devicesNotifyStatus"),
      params: [
        { name: "pushToken", required: true, desc: t("serve.desc.pushToken"), schema: S },
        { name: "items", required: true, schema: { type: "array", items: { type: "object" } } },
      ],
      result: "notify status list (resp.data)",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["pushToken", "items"]); return hub.getDevicesNotifyStatus({ pushToken: params.pushToken, items: params.items }); },
    },
    "devices.notifyManage": {
      summary: t("serve.sum.devicesNotifyManage"),
      params: [
        { name: "pushToken", required: true, desc: t("serve.desc.pushToken"), schema: S },
        { name: "deviceUUID", required: true, schema: S },
        { name: "enablePush", required: true, desc: t("serve.desc.enablePush"), schema: B },
      ],
      result: "manageDevice ack",
      handler: ({ hub, params, daemon }) => {
        requireAuth(daemon);
        need(params, ["pushToken", "deviceUUID"]);
        if (params.enablePush === undefined || params.enablePush === null) {
          throw new RpcError(t("serve.missingParam", { k: "enablePush" }), { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
        }
        return hub.switchDeviceNotify({ pushToken: params.pushToken, deviceUUID: params.deviceUUID, enablePush: params.enablePush });
      },
    },
    "devices.switchRecharge": {
      summary: t("serve.sum.devicesSwitchRecharge"),
      params: [
        { name: "deviceUUID", required: true, schema: S },
        { name: "isRechargeBattery", required: true, schema: B },
      ],
      result: "manageDevice ack",
      handler: ({ hub, params, daemon }) => {
        requireAuth(daemon);
        need(params, ["deviceUUID"]);
        if (params.isRechargeBattery === undefined || params.isRechargeBattery === null) {
          throw new RpcError(t("serve.missingParam", { k: "isRechargeBattery" }), { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
        }
        return hub.switchRechargeableBattery({ deviceUUID: params.deviceUUID, isRechargeBattery: params.isRechargeBattery });
      },
    },
    // クラウド登録の convenience。BLE で読み取った records をレコード毎の updateCardName で
    // DB 同期する (vendor のタップ登録経路 cards/index.js:104-136 と同形。P3-11)。experimental。
    "access.registerCards": {
      summary: t("serve.sum.accessRegisterCards"),
      params: [
        { name: "deviceUUID", required: true, desc: t("serve.desc.targetDeviceUUID"), schema: S },
        { name: "cards", required: true, desc: t("serve.desc.registerCardsCards"), schema: { type: "array", items: { type: "object" } } },
      ],
      result: "updateCardName responses (null if cards empty)",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["deviceUUID", "cards"]); return hub.registerCards(params.deviceUUID, params.cards); },
    },
    // SURF-04: registerCards と対称の passcode 版。BLE enroll で集めた records を
    // access.syncEnrolledPasscodes (= postPasscodes 委譲, passwords.js:101-113) で DB 同期する。
    // nameUUID (ファームウェア採番) は透過される。experimental。
    "access.registerPasscodes": {
      summary: t("serve.sum.accessRegisterPasscodes"),
      params: [
        { name: "deviceUUID", required: true, desc: t("serve.desc.targetDeviceUUID"), schema: S },
        { name: "passcodes", required: true, desc: t("serve.desc.registerPasscodesRecords"), schema: { type: "array", items: { type: "object" } } },
      ],
      result: "postPasscodes response (null if passcodes empty)",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["deviceUUID", "passcodes"]); return hub.registerPasscodes(params.deviceUUID, params.passcodes); },
    },
    "device.history": {
      summary: t("serve.sum.deviceHistory"),
      params: [
        { name: "deviceUUID", required: true, schema: S },
        { name: "pageSize", required: false, schema: N },
        // P3-7: 直前ページ末尾レコードの timestamp (DeviceHistory.js:37-44 loadHistory の lastKey)。
        { name: "lastKey", required: false, desc: t("serve.desc.historyLastKey"), schema: N },
      ], result: "history[]",
      // list はオブジェクト配列 [{deviceUUID, lastKey}] (vendor 確認: DeviceHistory.js:37 が
      // getDeviceHistory([{deviceUUID, lastKey}], ...) を送る)。裸文字列配列だとサーバが
      // list[i].deviceUUID を読めず履歴取得が壊れる (P1-11)。
      handler: ({ hub, params, daemon }) => {
        requireAuth(daemon); need(params, ["deviceUUID"]);
        // lastKey は「直前ページ末尾 record の timestamp」なので 0 は有効値ではない。
        // gRPC (proto3) 経由では未指定の数値フィールドが既定値 0 で届くため、falsy は
        // null (初回ページ) に正規化する。
        return hub.getDeviceHistory([{ deviceUUID: params.deviceUUID, lastKey: params.lastKey || null }], params.pageSize);
      },
    },
    "device.battery": {
      summary: t("serve.sum.deviceBattery"),
      params: [
        { name: "deviceUUID", required: true, schema: S },
        { name: "pageSize", required: false, schema: N },
        // P3-7: 応答 lastEvaluatedKey をそのまま渡して次ページを取る (MobileBatteryChart.js:40-50)。
        // 旧契約は「返すが渡せない」片道だった。中身は DynamoDB の opaque カーソル (object)。
        { name: "lastEvaluatedKey", required: false, desc: t("serve.desc.batteryLastEvaluatedKey"), schema: O },
      ], result: "{ records, lastEvaluatedKey }",
      handler: ({ hub, params, daemon }) => {
        requireAuth(daemon); need(params, ["deviceUUID"]);
        return hub.getDeviceBattery(params.deviceUUID, { pageSize: params.pageSize, lastEvaluatedKey: params.lastEvaluatedKey ?? null });
      },
    },
    "device.hideHistory": {
      summary: t("serve.sum.deviceHideHistory"),
      params: [
        { name: "deviceUUID", required: true, desc: t("serve.desc.targetDeviceUUID"), schema: S },
        { name: "timestamp", required: true, desc: t("serve.desc.historyTimestamp"), schema: N },
      ], result: "{ success: true }",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["deviceUUID", "timestamp"]); return hub.hideDeviceHistory({ deviceUUID: params.deviceUUID, timestamp: params.timestamp }); },
    },
    "device.hideBattery": {
      summary: t("serve.sum.deviceHideBattery"),
      params: [
        { name: "deviceUUID", required: true, desc: t("serve.desc.targetDeviceUUID"), schema: S },
        { name: "timestampSecond", required: true, desc: t("serve.desc.batteryTimestamp"), schema: N },
      ], result: "{ success: true }",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["deviceUUID", "timestampSecond"]); return hub.hideBatteryRecord({ deviceUUID: params.deviceUUID, timestampSecond: params.timestampSecond }); },
    },
    "device.rename": {
      summary: t("serve.sum.deviceRename"),
      params: [
        { name: "deviceUUID", required: true, schema: S },
        { name: "deviceName", required: true, schema: S },
      ],
      result: "manageDevice ack",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["deviceUUID", "deviceName"]); return hub.renameDevice(params.deviceUUID, params.deviceName); },
    },
    "device.delete": {
      summary: t("serve.sum.deviceDelete"),
      params: [{ name: "deviceUUID", required: true, schema: S }],
      result: "deleteDevices ack",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["deviceUUID"]); return hub.deleteDevice(params.deviceUUID); },
    },
    "firmware.list": {
      summary: t("serve.sum.firmwareList"),
      params: [], result: "firmware[]",
      handler: ({ hub, daemon }) => { requireAuth(daemon); return hub.listFirmware(); },
    },
  };
}

/**
 * config.* の直後に来る WebAPI エントリ (webapi.*)。
 * @returns {Record<string, import("../registry-helpers.js").MethodEntry>}
 */
export function webapiEntries() {
  return {
    "webapi.invoke": {
      summary: t("serve.sum.webapiInvoke"),
      params: [
        { name: "func", required: true, desc: t("serve.desc.webapiFunc"), schema: S },
        { name: "query", required: false, desc: t("serve.desc.webapiQuery"), schema: { type: "object" } },
        { name: "body", required: false, desc: t("serve.desc.webapiBody"), schema: { type: "object" } },
        { name: "apiKeyId", required: false, desc: t("serve.desc.webapiApiKeyId"), schema: S },
      ], result: "any (WebAPI proxy 応答)",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["func"]); return hub.invokeWebAPI({ func: params.func, query: params.query, body: params.body, apiKeyId: params.apiKeyId }); },
    },
    "webapi.deviceState": {
      summary: t("serve.sum.webapiDeviceState"),
      params: [
        { name: "deviceId", required: true, schema: S },
        { name: "apiKeyId", required: false, schema: S },
      ],
      result: "WebAPI device state",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["deviceId"]); return hub.webapiDeviceState({ deviceId: params.deviceId, apiKeyId: params.apiKeyId }); },
    },
    "webapi.deviceHistory": {
      summary: t("serve.sum.webapiDeviceHistory"),
      params: [
        { name: "deviceId", required: true, schema: S },
        { name: "page", required: false, schema: N },
        { name: "lg", required: false, schema: N },
        { name: "isBiz", required: false, schema: B },
        { name: "apiKeyId", required: false, schema: S },
      ],
      result: "WebAPI device history",
      handler: ({ hub, params, daemon }) => {
        requireAuth(daemon); need(params, ["deviceId"]);
        return hub.webapiDeviceHistory({
          deviceId: params.deviceId,
          page: params.page,
          lg: params.lg,
          isBiz: params.isBiz,
          apiKeyId: params.apiKeyId,
        });
      },
    },
    "webapi.sendCmd": {
      summary: t("serve.sum.webapiSendCmd"),
      params: [
        { name: "deviceId", required: true, schema: S },
        { name: "cmd", required: true, schema: N },
        { name: "sign", required: true, schema: S },
        { name: "history", required: true, schema: S },
        { name: "apiKeyId", required: false, schema: S },
      ],
      result: "WebAPI command response",
      handler: ({ hub, params, daemon }) => {
        requireAuth(daemon); need(params, ["deviceId", "cmd", "sign", "history"]);
        return hub.webapiSendCmd({
          deviceId: params.deviceId,
          cmd: params.cmd,
          sign: params.sign,
          history: params.history,
          apiKeyId: params.apiKeyId,
        });
      },
    },
  };
}

/**
 * ir.* の直後に来る認証データ系エントリ (access.postAuthenticationData 等)。
 * @returns {Record<string, import("../registry-helpers.js").MethodEntry>}
 */
export function accessAuthEntries() {
  return {
    "access.postAuthenticationData": {
      summary: t("serve.sum.accessPostAuthData"),
      params: [{ name: "operation", required: true, schema: S }, { name: "deviceID", required: true, schema: S }, { name: "items", required: true, schema: A }, { name: "baseUrl", required: false, schema: S }],
      result: "credential items or biometrics response",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["operation", "deviceID", "items"]); return hub.postAuthenticationData(params); },
    },
    "access.putAuthenticationData": {
      summary: t("serve.sum.accessPutAuthData"),
      params: [{ name: "operation", required: true, schema: S }, { name: "deviceID", required: true, schema: S }, { name: "items", required: true, schema: A }, { name: "baseUrl", required: false, schema: S }],
      result: "biometrics response",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["operation", "deviceID", "items"]); return hub.putAuthenticationData(params); },
    },
    "access.deleteAuthenticationData": {
      summary: t("serve.sum.accessDeleteAuthData"),
      params: [{ name: "operation", required: true, schema: S }, { name: "deviceID", required: true, schema: S }, { name: "items", required: true, schema: A }, { name: "baseUrl", required: false, schema: S }],
      result: "biometrics response",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["operation", "deviceID", "items"]); return hub.deleteAuthenticationData(params); },
    },
    "access.updateAuthenticationName": {
      summary: t("serve.sum.accessUpdateAuthName"),
      params: [
        { name: "request", required: false, schema: O },
        { name: "kind", required: false, schema: S },
        { name: "baseUrl", required: false, schema: S },
        { name: "subUUID", required: false, schema: S },
        { name: "stpDeviceUUID", required: false, schema: S },
        { name: "name", required: false, schema: S },
        { name: "timestamp", required: false, schema: N },
        { name: "type", required: false, schema: N },
        { name: "cardType", required: false, schema: N },
        { name: "nameUUID", required: false, schema: S },
        { name: "cardNameUUID", required: false, schema: S },
        { name: "faceNameUUID", required: false, schema: S },
        { name: "fingerPrintNameUUID", required: false, schema: S },
        { name: "palmNameUUID", required: false, schema: S },
        { name: "keyBoardPassCodeNameUUID", required: false, schema: S },
        { name: "cardID", required: false, schema: S },
        { name: "faceID", required: false, schema: S },
        { name: "fingerPrintID", required: false, schema: S },
        { name: "palmID", required: false, schema: S },
        { name: "keyBoardPassCode", required: false, schema: S },
        { name: "op", required: false, schema: S },
      ],
      result: "biometrics response",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); return hub.updateAuthenticationName(params); },
    },
  };
}
