// メソッドレジストリ — デーモンが公開する全 RPC メソッドの単一カタログ。
//
// 設計: 「全機能を一様に公開」。名前空間 op (org/company/access/iot/presetir/schedule) は
// 各モジュールの `NAMESPACE_OPS`(公開 op の単一の真実) から **自動生成** し、
// ハンドラは一様に `hub[ns][op](params)`。位置引数を持つ高レベル op だけ明示の薄い表で橋渡し。
// 危険な少数 (IR learn=Hub3 グローバル mode、events 購読) は daemon に委譲する特別扱い。
//
// ハンドラ署名: `handler({ hub, params, conn, daemon }) => Promise<result>`
//   - hub: 常駐 SesameHub3
//   - params: JSON-RPC params (オブジェクト)
//   - conn: 呼び出し元 Connection (events/lease 用)
//   - daemon: Daemon (購読/リース/authState 用)

import { readFileSync } from "node:fs";
import { RpcError, RPC, KIND, CONTRACT_VERSION } from "./jsonrpc.js";
import { stabilityOf, provenanceOf, eventStabilityOf, eventProvenanceOf } from "./stability.js";
import { RESULT_SCHEMAS } from "./result-schemas.js";
import { t } from "../i18n.js";
import * as schedule from "../schedule.js";
import * as org from "../org.js";
import * as company from "../company.js";
import * as access from "../access.js";
import * as iot from "../iot.js";
import * as presetir from "../presetir.js";

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
const NS_MODULES = { schedule, org, company, access, iot, presetir };

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
