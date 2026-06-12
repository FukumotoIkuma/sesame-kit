// エントリ: lock — 施錠・解錠・オートロック・ステータス。
// `Record<string, MethodEntry>` を返す純関数として機械分割 (P5-2)。

import { RpcError, RPC, KIND } from "../jsonrpc.js";
import { requireAuth, need } from "../registry-helpers.js";
import { SesameBle } from "../../ble/index.js";
import { t } from "../../i18n.js";

const S = { type: "string" };
const N = { type: "number" };
const B = { type: "boolean" };

/**
 * name (config) もしくは {deviceUUID,secretKey} で lock op を発行する共通 helper。
 * @param {string} verb
 * @returns {(ctx: import("../registry-helpers.js").HandlerCtx) => unknown}
 */
function lockOp(verb) {
  return ({ hub, params, daemon }) => {
    requireAuth(daemon);
    if (params.deviceUUID) {
      need(params, ["deviceUUID", "secretKey"]);
      return hub[`${verb}Device`]({ deviceUUID: params.deviceUUID, secretKey: params.secretKey });
    }
    need(params, ["name"]);
    return hub[verb](params.name);
  };
}

const lockParams = [
  { name: "name", required: false, desc: t("serve.desc.lockNameParam"), schema: S },
  { name: "deviceUUID", required: false, desc: t("serve.desc.deviceUUIDParam"), schema: S },
  { name: "secretKey", required: false, desc: t("serve.desc.secretKeyParam"), schema: S },
];

/**
 * @param {{ bleUseOptsFromParams: (hub: any, params: any) => any, bleCommandAck: (r: {resultCode: number}) => any }} helpers
 * @returns {Record<string, import("../registry-helpers.js").MethodEntry>}
 */
export function lockEntries({ bleUseOptsFromParams, bleCommandAck }) {
  return {
    "lock.lock": { summary: t("serve.sum.lockLock"), params: lockParams, result: t("serve.result.statePush"), handler: lockOp("lock") },
    "lock.unlock": { summary: t("serve.sum.lockUnlock"), params: lockParams, result: t("serve.result.statePush"), handler: lockOp("unlock") },
    "lock.toggle": { summary: t("serve.sum.lockToggle"), params: lockParams, result: t("serve.result.statePush"), handler: lockOp("toggle") },
    // scriptIndex (0..9) 指定時は Bot2/Bot3 の台本を番号実行 (cmd=170+index, CHSesameBot2Device.kt:73-89)。
    // 省略時は通常の Bot クリック (cmd=89 = 選択中の台本)。
    "lock.click": {
      summary: t("serve.sum.lockClick"),
      params: [
        ...lockParams,
        { name: "scriptIndex", required: false, desc: t("serve.desc.lockScriptIndex"), schema: N },
      ],
      result: t("serve.result.statePush"),
      handler: ({ hub, params, daemon }) => {
        requireAuth(daemon);
        const hasScript = params.scriptIndex !== undefined && params.scriptIndex !== null;
        if (params.deviceUUID) {
          need(params, ["deviceUUID", "secretKey"]);
          return hasScript
            ? hub.botClickScriptDevice({ deviceUUID: params.deviceUUID, secretKey: params.secretKey, scriptIndex: params.scriptIndex })
            : hub.botClickDevice({ deviceUUID: params.deviceUUID, secretKey: params.secretKey });
        }
        need(params, ["name"]);
        return hasScript ? hub.botClickScript(params.name, params.scriptIndex) : hub.botClick(params.name);
      },
    },
    // SURF-15: transport param で cloud / BLE 経路を選べる。
    //   - "cloud": biz3TriggerLocker cmd=11 (ack は返るが**実機反映は未確認** — §9。README の
    //     「autolock cloud 不可」観測とも整合)。
    //   - "ble":   SesameBle.autolock(seconds) (ItemCode 11 直送。公式アプリと同経路で実機反映される)。
    // 既定は "cloud"。プランの「既定 ble」からの意図的逸脱: 既存呼び出し (transport 未指定) の
    // 挙動・必要 param (name だけで呼べる) を変えないため。確実な経路が要る消費者は明示的に
    // transport:"ble" + {deviceUUID/secretKey/model} を渡す (summary/desc に明記)。
    "lock.setAutolock": {
      summary: t("serve.sum.lockSetAutolock"),
      params: [
        ...lockParams,
        { name: "seconds", required: true, desc: t("serve.desc.autolockSeconds"), schema: N },
        { name: "timeoutMs", required: false, schema: N },
        { name: "transport", required: false, desc: t("serve.desc.autolockTransport"), schema: { type: "string", enum: ["cloud", "ble"] } },
        // transport:"ble" 用の対象指定 (bleUseOptsFromParams が消費。secretKey は ble 時のみ必須)。
        { name: "address", required: false, schema: S },
        { name: "model", required: false, schema: S },
        { name: "scanTimeoutMs", required: false, schema: N },
        { name: "debug", required: false, schema: B },
      ],
      result: "{ ack, cmd, seconds } (cloud) | { resultCode, resultName, seconds, transport } (ble)",
      handler: async ({ hub, params, daemon }) => {
        need(params, ["seconds"]);
        const transport = params.transport ?? "cloud";
        if (transport === "ble") {
          // BLE 経路はクラウド接続不要 (requireAuth しない)。対象は deviceUUID/address + secretKey。
          return SesameBle.use(bleUseOptsFromParams(hub, params), async (ble) => ({
            ...bleCommandAck(await ble.autolock(params.seconds)),
            seconds: params.seconds,
            transport: "ble",
          }));
        }
        if (transport !== "cloud") {
          throw new RpcError(t("serve.badAutolockTransport", { transport: String(transport) }), { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
        }
        requireAuth(daemon);
        if (params.deviceUUID) {
          need(params, ["deviceUUID", "secretKey"]);
          return hub.setAutolockDevice({ deviceUUID: params.deviceUUID, secretKey: params.secretKey, seconds: params.seconds, timeoutMs: params.timeoutMs });
        }
        return hub.setAutolock(params.name ?? null, params.seconds, params.timeoutMs);
      },
    },
    "lock.status": {
      summary: t("serve.sum.lockStatus"),
      params: [{ name: "deviceUUID", required: true, desc: t("serve.desc.targetDeviceUUID"), schema: S }], result: "device | null (vendor consumes data[0])",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["deviceUUID"]); return hub.getDeviceStatus(params.deviceUUID); },
    },
  };
}
