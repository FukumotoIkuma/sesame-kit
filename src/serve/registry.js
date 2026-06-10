// メソッドレジストリ — デーモンが公開する全 RPC メソッドの単一カタログ。
//
// 設計: cloud/Biz3 RPC と登録済み BLE op を一様に公開。名前空間 op
// (org/company/payment/access/iot/presetir/schedule) は
// 各モジュールの `NAMESPACE_OPS`(公開 op の単一の真実) から **自動生成** し、
// ハンドラは一様に `hub[ns][op](params)`。位置引数を持つ高レベル op だけ明示の薄い表で橋渡し。
// 危険な少数 (IR learn=Hub3 グローバル mode、events 購読) は daemon に委譲する特別扱い。
//
// ハンドラ署名: `handler({ hub, params, conn, daemon }) => Promise<result>`
//   - hub: 常駐 SesameHub3
//   - params: JSON-RPC params (オブジェクト)
//   - conn: 呼び出し元 Connection (events/lease 用)
//   - daemon: Daemon (購読/リース/authState 用)

import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { RpcError, RPC, KIND, CONTRACT_VERSION } from "./jsonrpc.js";
import { stabilityOf, provenanceOf, eventStabilityOf, eventProvenanceOf } from "./stability.js";
import { RESULT_SCHEMAS } from "./result-schemas.js";
import { t } from "../i18n.js";
import * as schedule from "../schedule.js";
import * as org from "../org.js";
import * as company from "../company.js";
import * as payment from "../payment.js";
import * as access from "../access.js";
import * as iot from "../iot.js";
import * as presetir from "../presetir.js";
import { SesameBle, SesameOS2Ble, createBleTransport } from "../ble/index.js";
import { resolveRegisterTransport } from "../devices.js";

/**
 * 常駐 hub。registry は (a) 明示メソッド (hub.lock 等) と (b) 名前空間 op の動的
 * dispatch (hub[ns][op]) の両方で hub を使う。どちらも実行時に解決する設計なので、
 * 型は daemon の HubLike を index signature 付きで緩める (動的 dispatch を許す)。
 * daemon が実際に渡す `this.hub` (HubLike) と互換である必要がある。
 * @typedef {import("./daemon.js").HubLike & Record<string, any>} Hub
 */

/**
 * RPC ハンドラに渡る実行コンテキスト。
 * @typedef {object} HandlerCtx
 * @property {Hub} hub 常駐 SesameHub3
 * @property {Record<string, any>} params JSON-RPC params (オブジェクト)
 * @property {import("./daemon.js").Connection} [conn] 呼び出し元 Connection
 * @property {import("./daemon.js").Daemon} daemon Daemon (購読/リース/authState 用)
 */

/**
 * 1 メソッドのレジストリエントリ。
 * @typedef {object} MethodEntry
 * @property {string} summary
 * @property {Array<{name:string, required:boolean, desc?:string, schema?:Record<string, unknown>}>} params
 * @property {string} result
 * @property {(ctx: HandlerCtx) => unknown} handler
 * @property {string} [namespace]
 */

/**
 * gen-rpc-schema が抽出した 1 param の記述。
 * @typedef {{ name:string, required:boolean, tsType?:string, schema?:Record<string, unknown> }} GenParam
 */

// ビルド時に .d.ts から抽出した名前空間 op の param 型 (scripts/gen-rpc-schema.mjs)。
// これにより discover が「名前空間 op の引数名・型」を自己記述できる。
/** @type {Record<string, GenParam[]>} */
let GEN_PARAMS = {};
try {
  GEN_PARAMS = JSON.parse(readFileSync(new URL("./rpc-params.generated.json", import.meta.url), "utf8"));
} catch { /* 未生成なら空 (フォールバックの (params) になる) */ }

// 自動公開する名前空間 (getter 名 → モジュール)。getter は SesameHub3 のプロパティ名と一致。
const NS_MODULES = { schedule, org, company, payment, access, iot, presetir };

/**
 * params 必須キーの存在チェック (軽量バリデータ)。欠落は bad_params。
 * @param {Record<string, unknown>} params
 * @param {string[]} keys
 */
function need(params, keys) {
  for (const k of keys) {
    if (params[k] === undefined || params[k] === null || params[k] === "") {
      throw new RpcError(t("serve.missingParam", { k }), { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
    }
  }
}

/**
 * topics param を topic 文字列配列へ正規化する (単一値も配列に包む)。
 * 値の妥当性 (既知 topic か) は呼び出し側が TOPICS で検証する。
 * @param {unknown} raw
 * @returns {string[]}
 */
function asTopicList(raw) {
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((v) => String(v));
}

/**
 * JSON で送られた特殊エンコード (Buffer/$buffer) を実値へ復元する。prototype 汚染キーは拒否。
 * @param {any} value
 * @returns {any}
 */
function reviveJsonArg(value) {
  if (Array.isArray(value)) return value.map(reviveJsonArg);
  if (!value || typeof value !== "object") return value;
  if (value.type === "Buffer" && Array.isArray(value.data)) return Buffer.from(value.data);
  if (typeof value.$buffer === "string") {
    const encoding = value.encoding === "base64" ? "base64" : "hex";
    return Buffer.from(value.$buffer, encoding);
  }
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new RpcError(`unsupported JSON argument key: ${key}`, { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
    }
    out[key] = reviveJsonArg(nested);
  }
  return out;
}

/**
 * クラウド接続が要る op の前段ガード (未認証/未接続を明示エラーに)。
 * @param {import("./daemon.js").Daemon} daemon
 */
function requireAuth(daemon) {
  if (daemon.authState === "expired") {
    throw new RpcError(t("serve.notAuthenticated"), { kind: KIND.NOT_AUTHENTICATED });
  }
  if (!daemon.hub.connected) {
    throw new RpcError(t("serve.cloudNotConnected"), { kind: KIND.CONNECTION_LOST });
  }
}

/**
 * @param {Record<string, any>} root 走査対象のオブジェクトツリー (ble facade 等)。
 * @param {string} path ドット区切りの op パス。
 * @param {unknown[]} [args]
 */
async function invokePath(root, path, args = []) {
  if (!path || typeof path !== "string") {
    throw new RpcError("missing required param: op", { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
  }
  if (path.includes("_") || path.includes("constructor") || path.includes("prototype")) {
    throw new RpcError(`unsupported BLE op: ${path}`, { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
  }
  const parts = path.split(".").filter(Boolean);
  let target = root;
  for (let i = 0; i < parts.length; i += 1) {
    const key = parts[i];
    const value = target?.[key];
    if (value === undefined) {
      throw new RpcError(`unsupported BLE op: ${path}`, { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
    }
    if (i === parts.length - 1) {
      if (typeof value !== "function") return value;
      const revived = reviveJsonArg(args);
      return value.apply(target, Array.isArray(revived) ? revived : [revived]);
    }
    target = typeof value === "function" ? value.call(target) : value;
  }
  return target;
}

/**
 * 位置引数を持つ高レベル op の薄い橋渡し表。
 * 各 entry: { summary, params:[{name,required,desc}], result, handler }
 * @returns {Record<string, MethodEntry>}
 */
function topLevelEntries() {
  /**
   * name (config) もしくは {deviceUUID,secretKey} で lock op を発行する共通 helper。
   * @param {string} verb
   * @returns {(ctx: HandlerCtx) => unknown}
   */
  const lockOp = (verb) => ({ hub, params, daemon }) => {
    requireAuth(daemon);
    if (params.deviceUUID) {
      need(params, ["deviceUUID", "secretKey"]);
      return hub[`${verb}Device`]({ deviceUUID: params.deviceUUID, secretKey: params.secretKey });
    }
    need(params, ["name"]);
    return hub[verb](params.name);
  };
  const S = { type: "string" };
  const N = { type: "number" };
  const B = { type: "boolean" };
  const O = { type: "object" };
  const A = { type: "array" };
  const lockParams = [
    { name: "name", required: false, desc: t("serve.desc.lockNameParam"), schema: S },
    { name: "deviceUUID", required: false, desc: t("serve.desc.deviceUUIDParam"), schema: S },
    { name: "secretKey", required: false, desc: t("serve.desc.secretKeyParam"), schema: S },
  ];

  return {
    "status": {
      summary: t("serve.sum.status"),
      params: [], result: "{ connected, authState, subUUID, apiVersion, contractVersion }",
      // apiVersion: API サーフェスの SemVer (canonical)。消費者が major 不一致を毎回 fail-fast
      // できるよう返す。contractVersion は後方互換のための deprecated 別名 (1.0 で削除予定)。
      handler: ({ hub, daemon }) => ({
        connected: hub.connected,
        authState: daemon.authState,
        subUUID: hub.subUUID,
        apiVersion: CONTRACT_VERSION,
        contractVersion: CONTRACT_VERSION,
      }),
    },
    "account.whoami": {
      summary: t("serve.sum.whoami"),
      params: [], result: t("serve.result.customerInfo"),
      handler: ({ hub, daemon }) => { requireAuth(daemon); return hub.getLoginUser(); },
    },
    "lock.lock": { summary: t("serve.sum.lockLock"), params: lockParams, result: t("serve.result.statePush"), handler: lockOp("lock") },
    "lock.unlock": { summary: t("serve.sum.lockUnlock"), params: lockParams, result: t("serve.result.statePush"), handler: lockOp("unlock") },
    "lock.toggle": { summary: t("serve.sum.lockToggle"), params: lockParams, result: t("serve.result.statePush"), handler: lockOp("toggle") },
    "lock.click": { summary: t("serve.sum.lockClick"), params: lockParams, result: t("serve.result.statePush"), handler: lockOp("botClick") },
    "lock.setAutolock": {
      summary: "set autolock seconds (cloud path; BLE is preferred when available)",
      params: [...lockParams, { name: "seconds", required: true, schema: N }, { name: "timeoutMs", required: false, schema: N }],
      result: "{ ack, cmd, seconds }",
      handler: ({ hub, params, daemon }) => {
        requireAuth(daemon); need(params, ["seconds"]);
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
    "devices.list": {
      summary: t("serve.sum.devicesList"),
      params: [], result: "device[]",
      handler: ({ hub, daemon }) => { requireAuth(daemon); return hub.listDevices(); },
    },
    "devices.userList": {
      summary: "personal user device list (biz3 getUserDevice)",
      params: [], result: "device[]",
      handler: ({ hub, daemon }) => { requireAuth(daemon); return hub.listUserDevices(); },
    },
    // クラウド一括登録の convenience。BLE で読み取った複数カードの records を 1 回の postCards へ
    // まとめて投入する (vendor 検証済 postCards へ委譲。新 WS op は捏造しない)。experimental。
    "access.registerCards": {
      summary: t("serve.sum.accessRegisterCards"),
      params: [
        { name: "deviceUUID", required: true, desc: t("serve.desc.targetDeviceUUID"), schema: S },
        { name: "cards", required: true, desc: t("serve.desc.registerCardsCards"), schema: { type: "array", items: { type: "object" } } },
      ],
      result: "postCards ack (null if cards empty)",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["deviceUUID", "cards"]); return hub.registerCards(params.deviceUUID, params.cards); },
    },
    "device.history": {
      summary: t("serve.sum.deviceHistory"),
      params: [{ name: "deviceUUID", required: true, schema: S }, { name: "pageSize", required: false, schema: N }], result: "history[]",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["deviceUUID"]); return hub.getDeviceHistory([params.deviceUUID], params.pageSize); },
    },
    "device.battery": {
      summary: t("serve.sum.deviceBattery"),
      params: [{ name: "deviceUUID", required: true, schema: S }, { name: "pageSize", required: false, schema: N }], result: "{ records, lastEvaluatedKey }",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["deviceUUID"]); return hub.getDeviceBattery(params.deviceUUID, { pageSize: params.pageSize }); },
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
      summary: "rename a device",
      params: [
        { name: "deviceUUID", required: true, schema: S },
        { name: "deviceName", required: true, schema: S },
      ],
      result: "manageDevice ack",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["deviceUUID", "deviceName"]); return hub.renameDevice(params.deviceUUID, params.deviceName); },
    },
    "device.delete": {
      summary: "delete a device from the company",
      params: [{ name: "deviceUUID", required: true, schema: S }],
      result: "deleteDevices ack",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["deviceUUID"]); return hub.deleteDevice(params.deviceUUID); },
    },
    "firmware.list": {
      summary: "available firmware list",
      params: [], result: "firmware[]",
      handler: ({ hub, daemon }) => { requireAuth(daemon); return hub.listFirmware(); },
    },
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
      summary: "WebAPI proxy: device shadow state",
      params: [
        { name: "deviceId", required: true, schema: S },
        { name: "apiKeyId", required: false, schema: S },
      ],
      result: "WebAPI device state",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["deviceId"]); return hub.webapiDeviceState({ deviceId: params.deviceId, apiKeyId: params.apiKeyId }); },
    },
    "webapi.deviceHistory": {
      summary: "WebAPI proxy: device history",
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
      summary: "WebAPI proxy: send a lock command",
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
    "ir.send": {
      summary: t("serve.sum.irSend"),
      params: [{ name: "remote", required: false, desc: t("serve.desc.irRemote"), schema: S }, { name: "key", required: true, desc: t("serve.desc.irKey"), schema: S }],
      result: t("serve.result.sendResponse"),
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["key"]); return hub.send(params.remote ?? null, params.key); },
    },
    "ir.listKeys": {
      summary: t("serve.sum.irListKeys"),
      params: [{ name: "remote", required: false, schema: S }], result: "key[]",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); return hub.listKeys(params.remote ?? null); },
    },
    "ir.learn": {
      summary: "learn one IR key into a configured remote",
      params: [
        { name: "remote", required: true, schema: S },
        { name: "key", required: true, schema: S },
        { name: "timeoutMs", required: false, schema: N },
      ],
      result: "{ keyUUID, captured, saved }",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["remote", "key"]); return hub.learnIR(params.remote, params.key, { timeoutMs: params.timeoutMs }); },
    },
    "ir.listRemotes": {
      summary: "list registered IR remotes by type",
      params: [{ name: "type", required: true, schema: N }, { name: "page", required: false, schema: N }, { name: "pageSize", required: false, schema: N }],
      result: "remote[]",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["type"]); return hub.listIRRemotes(params.type, { page: params.page, pageSize: params.pageSize }); },
    },
    "ir.searchRemotes": {
      summary: "search preset IR remotes",
      params: [{ name: "type", required: true, schema: N }, { name: "searchTerm", required: true, schema: S }],
      result: "remote[]",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["type", "searchTerm"]); return hub.searchPresetIRRemotes(params.type, params.searchTerm); },
    },
    "ir.addRemote": {
      summary: "add an IR remote object on the server",
      params: [{ name: "remote", required: true, schema: O }],
      result: "addIRRemote response",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["remote"]); return hub.addIRRemoteServer(params.remote); },
    },
    "ir.deleteRemote": {
      summary: "delete a configured IR remote on the server",
      params: [{ name: "remote", required: true, schema: S }],
      result: "deleteIRRemote response",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["remote"]); return hub.deleteIRRemoteServer(params.remote); },
    },
    "ir.renameRemote": {
      summary: "rename an IR remote alias",
      params: [{ name: "remote", required: true, schema: S }, { name: "alias", required: true, schema: S }],
      result: "updateRemoteAlias response",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["remote", "alias"]); return hub.renameIRRemote(params.remote, params.alias); },
    },
    "ir.deleteKey": {
      summary: "delete one IR key",
      params: [{ name: "remote", required: true, schema: S }, { name: "key", required: true, schema: S }],
      result: "deleteIRCode response",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["remote", "key"]); return hub.deleteIRKey(params.remote, params.key); },
    },
    "ir.renameKey": {
      summary: "rename one IR key",
      params: [{ name: "remote", required: true, schema: S }, { name: "key", required: true, schema: S }, { name: "newName", required: true, schema: S }],
      result: "updateIRCode response",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["remote", "key", "newName"]); return hub.renameIRKey(params.remote, params.key, params.newName); },
    },
    "ir.getMode": {
      summary: "get Hub3 IR mode",
      params: [{ name: "hub3", required: false, schema: S }],
      result: "mode",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); return hub.getIRMode(params.hub3 ?? null); },
    },
    "ir.setMode": {
      summary: "set Hub3 IR mode",
      params: [{ name: "hub3", required: false, schema: S }, { name: "mode", required: true, schema: N }],
      result: "setIRMode response",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["mode"]); return hub.setIRMode(params.hub3 ?? null, params.mode); },
    },
    "ir.matchRemote": {
      summary: "match learned IR data against preset remotes",
      params: [
        { name: "irData", required: true, schema: S },
        { name: "irType", required: true, schema: N },
        { name: "brandName", required: false, schema: S },
      ],
      result: "matchRemote response",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["irData", "irType"]); return hub.matchIRRemote({ irData: params.irData, irType: params.irType, brandName: params.brandName }); },
    },
    "access.postAuthenticationData": {
      summary: "Kotlin SDK biometric credential sync: postAuthenticationData",
      params: [{ name: "operation", required: true, schema: S }, { name: "deviceID", required: true, schema: S }, { name: "items", required: true, schema: A }, { name: "baseUrl", required: false, schema: S }],
      result: "credential items or biometrics response",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["operation", "deviceID", "items"]); return hub.postAuthenticationData(params); },
    },
    "access.putAuthenticationData": {
      summary: "Kotlin SDK biometric credential sync: putAuthenticationData",
      params: [{ name: "operation", required: true, schema: S }, { name: "deviceID", required: true, schema: S }, { name: "items", required: true, schema: A }, { name: "baseUrl", required: false, schema: S }],
      result: "biometrics response",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["operation", "deviceID", "items"]); return hub.putAuthenticationData(params); },
    },
    "access.deleteAuthenticationData": {
      summary: "Kotlin SDK biometric credential sync: deleteAuthenticationData",
      params: [{ name: "operation", required: true, schema: S }, { name: "deviceID", required: true, schema: S }, { name: "items", required: true, schema: A }, { name: "baseUrl", required: false, schema: S }],
      result: "biometrics response",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["operation", "deviceID", "items"]); return hub.deleteAuthenticationData(params); },
    },
    "access.updateAuthenticationName": {
      summary: "Kotlin SDK biometric credential sync: updateAuthenticationName",
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
    "ble.invoke": {
      summary: "invoke a registered OS3 BLE operation through the daemon host Bluetooth adapter",
      params: [
        { name: "op", required: true, schema: S },
        { name: "args", required: false, schema: A },
        { name: "deviceUUID", required: false, schema: S },
        { name: "address", required: false, schema: S },
        { name: "secretKey", required: true, schema: S },
        { name: "model", required: false, schema: S },
        { name: "scanTimeoutMs", required: false, schema: N },
        { name: "debug", required: false, schema: B },
        { name: "needAuthFromServer", required: false, schema: B },
        { name: "registerBaseUrl", required: false, schema: S },
      ],
      result: "BLE operation result",
      handler: async ({ hub, params }) => {
        need(params, ["op", "secretKey"]);
        const needAuthFromServer = !!(params.needAuthFromServer || params.registerBaseUrl);
        return SesameBle.use({
          deviceUUID: params.deviceUUID,
          address: params.address,
          secretKey: params.secretKey,
          model: params.model ?? null,
          scanTimeoutMs: params.scanTimeoutMs,
          debug: !!params.debug,
          needAuthFromServer,
          registerTransport: needAuthFromServer
            ? resolveRegisterTransport({
                baseUrl: typeof params.registerBaseUrl === "string" ? params.registerBaseUrl : undefined,
                config: hub.config,
                tokenStore: hub.tokenStore,
                required: true,
              })
            : undefined,
        }, (ble) => invokePath(ble, params.op, params.args));
      },
    },
    "ble.register": {
      summary: "register a factory-reset OS3 BLE device through the daemon host Bluetooth adapter",
      params: [
        { name: "deviceUUID", required: true, schema: S },
        { name: "address", required: false, schema: S },
        { name: "model", required: false, schema: S },
        { name: "productType", required: false, schema: S },
        { name: "scanTimeoutMs", required: false, schema: N },
        { name: "debug", required: false, schema: B },
        { name: "nowMs", required: false, schema: N },
        { name: "registerBaseUrl", required: false, schema: S },
      ],
      result: "OS3 BLE registration result",
      handler: async ({ hub, params }) => {
        need(params, ["deviceUUID"]);
        // model は SesameBle コンストラクタ (能力テーブル参照) へ透過する。registerOnce の
        // 公開 opts 型には現れないが ...ctorOpts で受け渡されるため、型のみキャストで補う。
        return SesameBle.registerOnce(/** @type {Parameters<typeof SesameBle.registerOnce>[0] & {model?:string|null}} */ ({
          deviceUUID: params.deviceUUID,
          address: params.address,
          model: params.model ?? null,
          productType: params.productType ?? params.model ?? undefined,
          scanTimeoutMs: params.scanTimeoutMs,
          debug: !!params.debug,
          nowMs: params.nowMs,
          registerTransport: resolveRegisterTransport({
            baseUrl: typeof params.registerBaseUrl === "string" ? params.registerBaseUrl : undefined,
            config: hub.config,
            tokenStore: hub.tokenStore,
          }),
        }));
      },
    },
    "ble.os2.invoke": {
      summary: "invoke a registered OS2 BLE operation through the daemon host Bluetooth adapter",
      params: [
        { name: "op", required: true, schema: S },
        { name: "args", required: false, schema: A },
        { name: "deviceUUID", required: false, schema: S },
        { name: "address", required: false, schema: S },
        { name: "secretKey", required: true, schema: S },
        { name: "keyIndex", required: true, schema: S },
        { name: "ssmPublicKey", required: true, schema: S },
        { name: "model", required: false, schema: S },
        { name: "scanTimeoutMs", required: false, schema: N },
        { name: "debug", required: false, schema: B },
      ],
      result: "BLE operation result",
      handler: async ({ params }) => {
        need(params, ["op", "secretKey", "keyIndex", "ssmPublicKey"]);
        const transport = createBleTransport({
          deviceUUID: params.deviceUUID,
          address: params.address,
          debug: !!params.debug,
          scanTimeoutMs: params.scanTimeoutMs,
        });
        return SesameOS2Ble.use({
          transport,
          deviceUUID: params.deviceUUID,
          secretKey: params.secretKey,
          keyIndex: params.keyIndex,
          ssmPublicKey: params.ssmPublicKey,
          model: params.model ?? null,
          debug: !!params.debug,
        }, (ble) => invokePath(ble, params.op, params.args));
      },
    },
    "ble.os2.register": {
      summary: "register a factory-reset OS2 BLE device through the daemon host Bluetooth adapter",
      params: [
        { name: "deviceUUID", required: true, schema: S },
        { name: "address", required: false, schema: S },
        { name: "model", required: false, schema: S },
        { name: "productType", required: false, schema: S },
        { name: "scanTimeoutMs", required: false, schema: N },
        { name: "debug", required: false, schema: B },
        { name: "localServerAuth", required: false, schema: B },
        { name: "ak", required: false, schema: O },
      ],
      result: "OS2 BLE registration result",
      handler: async ({ params }) => {
        need(params, ["deviceUUID"]);
        const transport = createBleTransport({
          deviceUUID: params.deviceUUID,
          address: params.address,
          debug: !!params.debug,
          scanTimeoutMs: params.scanTimeoutMs,
        });
        return SesameOS2Ble.registerOnce({
          transport,
          deviceUUID: params.deviceUUID,
          model: params.model ?? null,
          productType: params.productType ?? params.model ?? undefined,
          localServerAuth: params.localServerAuth !== false,
          debug: !!params.debug,
          ak: reviveJsonArg(params.ak),
        });
      },
    },
  };
}

// 購読可能なイベント topic (events.subscribe / SSE ?topics= で受け付ける値)。
// x-events には event.ready のような購読対象でない broadcast 通知も載るため、購読可能な
// 集合はこちらを単一の真実とし、契約 (x-event-topics) と SDK の型をここから導出する。
export const SUBSCRIBABLE_TOPICS = ["lockState", "deviceUpdate"];

/**
 * events.subscribe / unsubscribe (daemon に委譲)。
 * @returns {Record<string, MethodEntry>}
 */
function eventEntries() {
  const TOPICS = SUBSCRIBABLE_TOPICS;
  return {
    "events.subscribe": {
      summary: t("serve.sum.eventsSubscribe", { topics: TOPICS.join("/") }),
      params: [{ name: "topics", required: true, desc: t("serve.desc.subscribeTopics", { topics: TOPICS.join("/") }) }],
      result: "{ subscribed: string[] }",
      handler: ({ params, conn, daemon }) => {
        if (conn?.ephemeral) {
          throw new RpcError(t("serve.eventsNeedPersistent"),
            { code: RPC.INVALID_REQUEST, kind: KIND.BAD_PARAMS });
        }
        const topics = asTopicList(params.topics);
        const bad = topics.filter((tp) => !TOPICS.includes(tp));
        if (bad.length) throw new RpcError(t("serve.unknownTopics", { topics: bad.join(",") }), { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
        return daemon.subscribe(conn, topics);
      },
    },
    "events.unsubscribe": {
      summary: t("serve.sum.eventsUnsubscribe"),
      params: [{ name: "topics", required: true }],
      result: "{ subscribed: string[] }",
      handler: ({ params, conn, daemon }) => {
        const topics = asTopicList(params.topics);
        return daemon.unsubscribe(conn, topics);
      },
    },
  };
}

/**
 * 全エントリを {name → entry} で構築する。
 * @returns {Map<string, MethodEntry>}
 */
export function buildRegistry() {
  /** @type {Map<string, MethodEntry>} */
  const reg = new Map();

  reg.set("rpc.discover", {
    summary: t("serve.sum.rpcDiscover"),
    params: [],
    result: t("serve.result.openrpc"),
    namespace: "rpc",
    handler: ({ daemon }) => daemon.openRpcDocument(),
  });

  // 1) 名前空間 op を NAMESPACE_OPS から自動公開。
  for (const [ns, mod] of Object.entries(NS_MODULES)) {
    const ops = Array.isArray(mod.NAMESPACE_OPS) ? mod.NAMESPACE_OPS : [];
    for (const op of ops) {
      const gen = GEN_PARAMS[`${ns}.${op}`];
      // 抽出済みなら実 param (名前/required/型) を、無ければ汎用 (params) を出す。
      const params = gen
        ? gen.map((p) => ({ name: p.name, required: p.required, desc: p.tsType, schema: p.schema }))
        : [{ name: "(params)", required: false, desc: t("serve.desc.nsParams") }];
      reg.set(`${ns}.${op}`, {
        summary: t("serve.sum.nsOp", { ns, op }),
        params,
        result: t("serve.result.opResponse"),
        namespace: ns,
        handler: ({ hub, params: p, daemon }) => { requireAuth(daemon); return hub[ns][op](p); },
      });
    }
  }

  // 2) 位置引数を持つ高レベル op の明示表。
  for (const [name, entry] of Object.entries(topLevelEntries())) reg.set(name, entry);

  // 3) events 特別扱い。
  for (const [name, entry] of Object.entries(eventEntries())) reg.set(name, entry);

  return reg;
}

/**
 * OpenRPC 文書を組み立てる (rpc.discover 応答)。param スキーマは初期は粗いが
 * 「何の op が在るか」は完全網羅する。secretKey 等の実値 example は載せない。
 * @param {Map<string, MethodEntry>} reg
 * @param {string} version
 * @returns {Record<string, unknown>}
 */
export function buildOpenRpcDoc(reg, version) {
  /** @type {Array<Record<string, unknown>>} */
  const methods = [];
  for (const [name, e] of reg) {
    methods.push({
      name,
      summary: e.summary,
      params: (e.params || []).map((p) => ({
        name: p.name,
        required: !!p.required,
        description: p.desc || "",
        schema: p.schema || {}, // 抽出できた型のみ。不明は {} (嘘の型を主張しない)
      })),
      // result スキーマ: 形をトレース確認できた stable メソッドのみ RESULT_SCHEMAS で型を出す。
      // 未確認は description だけの緩い object (SDK 側で unknown/Any にフォールバック)。
      result: {
        name: "result",
        schema: RESULT_SCHEMAS[name]
          ? { description: e.result || "", ...RESULT_SCHEMAS[name] }
          : { description: e.result || "", type: "object" },
      },
      // tier は provenance から導出。SDK/ツールは stable だけに張れる (docs/api-stability.md)。
      "x-stability": stabilityOf(name),
      "x-provenance": provenanceOf(name),
    });
  }
  // サーバ発イベントも記述 (予約名 event.<topic>)。event.* も stable/experimental を持つ。
  /** @param {string} name @param {string} description */
  const event = (name, description) => ({
    name, description,
    "x-stability": eventStabilityOf(name),
    "x-provenance": eventProvenanceOf(name),
  });
  return {
    openrpc: "1.2.6",
    info: {
      title: "sesame serve",
      version, // パッケージ version (無害な変更でも上がる)
      "x-apiVersion": CONTRACT_VERSION, // API サーフェスの SemVer (canonical)
      "x-contractVersion": CONTRACT_VERSION, // deprecated 別名 (1.0 で削除予定)
      description: t("serve.openrpc.description"),
    },
    methods,
    "x-events": [
      event("event.lockState", t("serve.event.lockState")),
      event("event.deviceUpdate", t("serve.event.deviceUpdate")),
      event("event.ready", t("serve.event.ready")),
    ],
    // 購読可能 topic (events.subscribe / SSE ?topics= で受け付ける値)。event.ready のような
    // 接続時の broadcast 通知は含まない。SDK の購読型はこれ (x-events ではなく) から導出する。
    "x-event-topics": [...SUBSCRIBABLE_TOPICS],
  };
}
