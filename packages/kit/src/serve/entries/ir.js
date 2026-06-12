// エントリ: ir — IR リモコン送信・学習・リモコン管理。
// `Record<string, MethodEntry>` を返す純関数として機械分割 (P5-2)。

import { requireAuth, need } from "../registry-helpers.js";
import { t } from "@sesame-kit/core/i18n";

const S = { type: "string" };
const N = { type: "number" };
const O = { type: "object" };

/**
 * @returns {Record<string, import("../registry-helpers.js").MethodEntry>}
 */
export function irEntries() {
  return {
    "ir.send": {
      summary: t("serve.sum.irSend"),
      params: [{ name: "remote", required: false, desc: t("serve.desc.irRemote"), schema: S }, { name: "key", required: true, desc: t("serve.desc.irKey"), schema: S }],
      result: t("serve.result.sendResponse"),
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["key"]); return hub.send(params.remote ?? null, params.key); },
    },
    "ir.listKeys": {
      summary: t("serve.sum.irListKeys"),
      params: [
        { name: "remote", required: false, schema: S },
        // SURF-24: config 非依存の直指定 (emit 側 presetir.sendIR / ir.send の direct 経路と対称)。
        // 両方を指定したときだけ hub.getIRCodesDirect に直行する (remote 名解決をスキップ)。
        { name: "hub3DeviceId", required: false, desc: t("serve.desc.irListKeysHub3DeviceId"), schema: S },
        { name: "irDeviceUUID", required: false, desc: t("serve.desc.irListKeysIrDeviceUUID"), schema: S },
      ],
      result: "key[]",
      handler: ({ hub, params, daemon }) => {
        requireAuth(daemon);
        if (params.hub3DeviceId || params.irDeviceUUID) {
          // 片方だけの直指定は対象を特定できない (config 解決と混ぜない) ため明示エラー。
          need(params, ["hub3DeviceId", "irDeviceUUID"]);
          return hub.getIRCodesDirect({ hub3DeviceId: params.hub3DeviceId, irDeviceUUID: params.irDeviceUUID });
        }
        return hub.listKeys(params.remote ?? null);
      },
    },
    "ir.learn": {
      summary: t("serve.sum.irLearn"),
      params: [
        { name: "remote", required: true, schema: S },
        { name: "key", required: true, schema: S },
        { name: "timeoutMs", required: false, schema: N },
      ],
      result: "{ keyUUID, captured, saved }",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["remote", "key"]); return hub.learnIR(params.remote, params.key, { timeoutMs: params.timeoutMs }); },
    },
    "ir.listRemotes": {
      summary: t("serve.sum.irListRemotes"),
      params: [{ name: "type", required: true, schema: N }, { name: "page", required: false, schema: N }, { name: "pageSize", required: false, schema: N }],
      // P1-12: vendor (useRemoteCtrl.js:43-57) の応答は {data:[...], pagination:{...}} のラッパー。
      result: "{ list: remote[], pagination: object|null }",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["type"]); return hub.listIRRemotes(params.type, { page: params.page, pageSize: params.pageSize }); },
    },
    "ir.searchRemotes": {
      summary: t("serve.sum.irSearchRemotes"),
      params: [{ name: "type", required: true, schema: N }, { name: "searchTerm", required: true, schema: S }],
      // P1-12: vendor (useRemoteCtrl.js:59-63) の応答は {data:[...], pagination:{...}} のラッパー。
      result: "{ list: remote[], pagination: object|null }",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["type", "searchTerm"]); return hub.searchPresetIRRemotes(params.type, params.searchTerm); },
    },
    "ir.addRemote": {
      summary: t("serve.sum.irAddRemote"),
      params: [{ name: "remote", required: true, schema: O }],
      result: "addIRRemote response",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["remote"]); return hub.addIRRemoteServer(params.remote); },
    },
    "ir.deleteRemote": {
      summary: t("serve.sum.irDeleteRemote"),
      params: [{ name: "remote", required: true, schema: S }],
      result: "deleteIRRemote response",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["remote"]); return hub.deleteIRRemoteServer(params.remote); },
    },
    "ir.renameRemote": {
      summary: t("serve.sum.irRenameRemote"),
      params: [{ name: "remote", required: true, schema: S }, { name: "alias", required: true, schema: S }],
      result: "updateRemoteAlias response",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["remote", "alias"]); return hub.renameIRRemote(params.remote, params.alias); },
    },
    "ir.deleteKey": {
      summary: t("serve.sum.irDeleteKey"),
      params: [{ name: "remote", required: true, schema: S }, { name: "key", required: true, schema: S }],
      result: "deleteIRCode response",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["remote", "key"]); return hub.deleteIRKey(params.remote, params.key); },
    },
    "ir.renameKey": {
      summary: t("serve.sum.irRenameKey"),
      params: [{ name: "remote", required: true, schema: S }, { name: "key", required: true, schema: S }, { name: "newName", required: true, schema: S }],
      result: "updateIRCode response",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["remote", "key", "newName"]); return hub.renameIRKey(params.remote, params.key, params.newName); },
    },
    "ir.getMode": {
      summary: t("serve.sum.irGetMode"),
      params: [{ name: "hub3", required: false, schema: S }],
      result: "mode",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); return hub.getIRMode(params.hub3 ?? null); },
    },
    "ir.setMode": {
      summary: t("serve.sum.irSetMode"),
      params: [{ name: "hub3", required: false, schema: S }, { name: "mode", required: true, schema: N }],
      result: "setIRMode response",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["mode"]); return hub.setIRMode(params.hub3 ?? null, params.mode); },
    },
    "ir.matchRemote": {
      summary: t("serve.sum.irMatchRemote"),
      params: [
        { name: "irData", required: true, schema: S },
        { name: "irType", required: true, schema: N },
        { name: "brandName", required: false, schema: S },
      ],
      result: "matchRemote response",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["irData", "irType"]); return hub.matchIRRemote({ irData: params.irData, irType: params.irType, brandName: params.brandName }); },
    },
    // P3-3: リモコンの Matter デバイス化 (useRemoteCtrl.js:933-955 フィールド 1:1)。
    // CLI は `sesame ir remote-add-matter` (SURF-05)。experimental・実機未検証。
    "ir.addRemoteToMatter": {
      summary: t("serve.sum.irAddRemoteToMatter"),
      params: [
        { name: "hub3DeviceId", required: true, schema: S },
        { name: "irDeviceType", required: true, desc: t("serve.desc.irDeviceType"), schema: N },
        { name: "cmdOn", required: true, desc: t("serve.desc.matterCmdOn"), schema: S },
        { name: "cmdOff", required: true, desc: t("serve.desc.matterCmdOff"), schema: S },
        { name: "irDeviceUUID", required: true, schema: S },
        { name: "irDeviceName", required: true, schema: S },
      ],
      result: "addRemoteToMatter response",
      handler: ({ hub, params, daemon }) => {
        requireAuth(daemon);
        need(params, ["hub3DeviceId", "irDeviceType", "cmdOn", "cmdOff", "irDeviceUUID", "irDeviceName"]);
        return hub.addRemoteToMatter({
          hub3DeviceId: params.hub3DeviceId,
          irDeviceType: params.irDeviceType,
          cmdOn: params.cmdOn,
          cmdOff: params.cmdOff,
          irDeviceUUID: params.irDeviceUUID,
          irDeviceName: params.irDeviceName,
        });
      },
    },
  };
}
