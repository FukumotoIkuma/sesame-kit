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

import { readFileSync } from "node:fs";
import { RpcError, RPC, KIND, CONTRACT_VERSION } from "@sesame-kit/core/jsonrpc";
import { stabilityOf, provenanceOf, eventStabilityOf, eventProvenanceOf } from "./stability.js";
import { RESULT_SCHEMAS } from "./result-schemas.js";
import { t } from "@sesame-kit/core/i18n";
import * as schedule from "@sesame-kit/core/schedule";
import * as org from "@sesame-kit/core/org";
import * as company from "@sesame-kit/core/company";
import * as payment from "@sesame-kit/core/payment";
import * as access from "@sesame-kit/core/access";
import * as iot from "@sesame-kit/core/iot";
import * as presetir from "@sesame-kit/core/presetir";
import {
  SesameBle, SesameOS2Ble, createBleTransport,
  BLE_RPC_ALLOWLIST, OS2_BLE_RPC_ALLOWLIST,
  BLE_RPC_OPS, OS2_BLE_RPC_OPS,
} from "@sesame-kit/core/ble";
// P5-3: invokePath/reviveJsonArg/wifiViewOf/collectWifiScan/bleCommandAck を葉モジュールへ移設。
// registry はここから再 import してそのまま re-export する (後方互換: 外部テストが registry から
// import しているため、registry 経由のアクセスも維持する)。
import {
  invokePath as _invokePath,
  reviveJsonArg as _reviveJsonArg,
  wifiViewOf as _wifiViewOf,
  collectWifiScan as _collectWifiScan,
  bleCommandAck as _bleCommandAck,
  WM2_API_GATEWAY_CLIENT_ID as _WM2_API_GATEWAY_CLIENT_ID,
} from "@sesame-kit/core/ble";
import { resolveRegisterTransport } from "@sesame-kit/core/devices";
// P5-2: topLevelEntries 808 行モノリスを entries/ へ機械分割。
// need/requireAuth は os2UseRun/buildRegistry 内で直接使用。requireConfigStore/asTopicList は entries/ へ移動済み。
import { need, requireAuth } from "./registry-helpers.js";
import { authEntries } from "./entries/auth.js";
import { configEntries } from "./entries/config.js";
import { lockEntries } from "./entries/lock.js";
import { irEntries } from "./entries/ir.js";
import { deviceEntriesPre, webapiEntries, accessAuthEntries } from "./entries/device.js";
import { bleEntries } from "./entries/ble.js";
import { eventsEntries } from "./entries/events.js";

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
 * desc は生成側が上書きした説明 (SURF-09: companyID/subUUID の自動注入注記等)。無ければ tsType を出す。
 * @typedef {{ name:string, required:boolean, tsType?:string, desc?:string, schema?:Record<string, unknown> }} GenParam
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

// 名前空間キーの単一真実源。scripts/gen-rpc-schema.mjs はこれを import して param 型を
// 抽出する (P1-15: payment が生成対象から漏れて型がプレースホルダに劣化した再発防止)。
export const NAMESPACE_MODULE_KEYS = Object.freeze(Object.keys(NS_MODULES));

// ---------- BLE 専用 RPC (P4-1 段階2) の共有ヘルパ (P5-3: 葉モジュールから再 export) ----------
//
// 実体は src/ble/rpc-helpers.js に移設した。registry.js はここで再 export し後方互換を維持する
// (tests/serve/ble-rpc-wiring.test.js 等が registry から直接 import しているため)。
// cli/ble.js は registry.js を迂回して rpc-helpers.js から直接 import する (P5-3 の目的)。

// ローカル名を維持しつつ re-export する (bleOpEntries/buildRegistry が内部で名前を使う)。
const reviveJsonArg = _reviveJsonArg;
const invokePath = _invokePath;
const bleCommandAck = _bleCommandAck;
const wifiViewOf = _wifiViewOf;
const collectWifiScan = _collectWifiScan;

export { invokePath };
export { wifiViewOf };
export { collectWifiScan };
export { bleCommandAck };
export { _WM2_API_GATEWAY_CLIENT_ID as WM2_API_GATEWAY_CLIENT_ID };

/**
 * listNearbyDevices / SesameBle.listNearby の発見結果 1 件から peripheral ハンドルを除去し、
 * JSON 化可能な平坦オブジェクトを返す。
 * peripheral は noble の内部オブジェクトで JSON 不可のため除外する (CLI cmdScan の
 * scrubDiscovery と同一の変換)。
 * @param {Record<string, unknown>} d
 * @returns {Record<string, unknown>}
 */
function scrubDiscovery(d) {
  const { peripheral, ...rest } = d || {};
  return rest;
}

/**
 * ble.* 専用 RPC 共通の対象指定 params から SesameBle.use の opts を組む
 * (ble.invoke と同じ対象指定群 {deviceUUID?, address?, secretKey, model?, …} の単一実装)。
 * @param {Hub} hub
 * @param {Record<string, any>} params
 * @returns {Record<string, any>} SesameBle.use 第 1 引数
 */
function bleUseOptsFromParams(hub, params) {
  need(params, ["secretKey"]);
  const needAuthFromServer = !!(params.needAuthFromServer || params.registerBaseUrl);
  return {
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
  };
}

// ---- SURF-08 段階3: BLE_RPC_OPS / OS2_BLE_RPC_OPS から ble.<op> を自動展開 ----
// 各 facade が宣言した op 仕様 (params 順 = ファサードメソッドの位置引数順) を、型付きの
// `ble.<op>` / `ble.os2.<op>` RPC に変換する。ハンドラは named params → 位置引数配列へ写像して
// invokePath (fail-closed allowlist) を通す。すべて experimental (STABLE_METHODS 非掲載)。
const BLE_SCHEMA_BY_TYPE = {
  number: { type: "number" }, string: { type: "string" }, boolean: { type: "boolean" },
  object: { type: "object" }, array: { type: "array" },
};
const BLE_GEN_TARGET = [
  { name: "deviceUUID", required: false, schema: { type: "string" } },
  { name: "address", required: false, schema: { type: "string" } },
  { name: "secretKey", required: true, schema: { type: "string" } },
  { name: "model", required: false, schema: { type: "string" } },
  { name: "scanTimeoutMs", required: false, schema: { type: "number" } },
  { name: "debug", required: false, schema: { type: "boolean" } },
  { name: "needAuthFromServer", required: false, schema: { type: "boolean" } },
  { name: "registerBaseUrl", required: false, schema: { type: "string" } },
];
const OS2_GEN_TARGET = [
  { name: "deviceUUID", required: false, schema: { type: "string" } },
  { name: "address", required: false, schema: { type: "string" } },
  { name: "secretKey", required: true, schema: { type: "string" } },
  { name: "keyIndex", required: true, schema: { type: "string" } },
  { name: "ssmPublicKey", required: true, schema: { type: "string" } },
  { name: "model", required: false, schema: { type: "string" } },
  { name: "scanTimeoutMs", required: false, schema: { type: "number" } },
  { name: "debug", required: false, schema: { type: "boolean" } },
];

/**
 * SesameOS2Ble.use を params から組んで fn を実行する (ble.os2.invoke と同じ対象指定群)。
 * @param {Record<string, any>} params
 * @param {(ble:any)=>any} fn
 */
function os2UseRun(params, fn) {
  need(params, ["secretKey", "keyIndex", "ssmPublicKey"]);
  const transport = createBleTransport({
    deviceUUID: params.deviceUUID, address: params.address,
    debug: !!params.debug, scanTimeoutMs: params.scanTimeoutMs,
  });
  return SesameOS2Ble.use({
    transport, deviceUUID: params.deviceUUID, secretKey: params.secretKey,
    keyIndex: params.keyIndex, ssmPublicKey: params.ssmPublicKey,
    model: params.model ?? null, debug: !!params.debug,
  }, fn);
}

/**
 * BLE_RPC_OPS / OS2_BLE_RPC_OPS の宣言から `ble.<op>` MethodEntry 群を生成する。
 * @param {string} prefix "ble" | "ble.os2"
 * @param {import("@sesame-kit/core/ble").BleRpcOpSpec} ops
 * @param {readonly string[]} allowlist 第 1 セグメント allowlist (fail-closed)
 * @param {{ target: Array<any>, run: (hub: Hub, params: Record<string, any>, fn: (ble:any)=>any)=>Promise<any> }} cfg
 * @returns {Record<string, MethodEntry>}
 */
function bleOpEntries(prefix, ops, allowlist, cfg) {
  /** @type {Record<string, MethodEntry>} */
  const out = {};
  for (const [opPath, spec] of Object.entries(ops)) {
    const specParams = Array.isArray(spec.params) ? spec.params : [];
    const opParams = specParams.map((p) => ({
      name: p.name, required: !!p.required, desc: p.desc,
      schema: BLE_SCHEMA_BY_TYPE[p.type] || BLE_SCHEMA_BY_TYPE.object,
    }));
    const ackResult = spec.result === "ack";
    out[`${prefix}.${opPath}`] = {
      summary: spec.summary || t("serve.sum.bleGenericOp", { op: opPath }),
      params: [...cfg.target, ...opParams],
      result: ackResult ? "{ resultCode, resultName }"
        : (typeof spec.result === "string" && spec.result !== "raw" ? spec.result : "BLE operation result"),
      handler: async ({ hub, params }) => {
        for (const p of opParams) {
          // 0/false は有効値なので undefined/null のみ欠落扱い (need() は 0 も弾くため使わない)。
          if (p.required && (params[p.name] === undefined || params[p.name] === null)) {
            throw new RpcError(t("serve.missingParam", { k: p.name }), { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
          }
        }
        const args = specParams.map((p) => params[p.name]);
        return cfg.run(hub, params, async (ble) => {
          const r = await invokePath(ble, opPath, args, allowlist);
          return ackResult ? bleCommandAck(/** @type {{resultCode:number}} */ (r)) : r;
        });
      },
    };
  }
  return out;
}

// topLevelEntries() は entries/ へ機械分割済み (P5-2)。
// buildRegistry() 内で各 entries 関数を呼ぶ。

// 購読可能なイベント topic (events.subscribe / SSE ?topics= で受け付ける値)。
// x-events には event.ready のような購読対象でない broadcast 通知も載るため、購読可能な
// 集合はこちらを単一の真実とし、契約 (x-event-topics) と SDK の型をここから導出する。
// deviceListChanged (P3-5): biz3TriggerLocker/pubUserDeviceChange (鍵共有・デバイス増減 push —
// useIotCtrl.js:12,23-25) の fan-out。lockState/deviceUpdate (pubDeviceStateChange 源) とは別ストリーム。
//
// SURF-16 (= ARCH-07): topic 集合はここが単一定義。daemon.js は STATE_TOPICS /
// SUBSCRIBABLE_TOPICS を import して使う (旧実装は daemon.js にも同じ配列が手書きされていて、
// topic 追加時に二重メンテが要った)。
/** pubDeviceStateChange を源とする state push の topic (同一ストリームの別ラベル — daemon._fanout 参照)。 */
export const STATE_TOPICS = Object.freeze(["lockState", "deviceUpdate"]);
/** 購読可能な全 topic。deviceListChanged は pubUserDeviceChange 源の別ストリーム。 */
export const SUBSCRIBABLE_TOPICS = Object.freeze([...STATE_TOPICS, "deviceListChanged"]);

// eventEntries() は entries/events.js へ機械分割済み (P5-2)。

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
      // desc は生成側の上書き (SURF-09 の自動注入注記) があればそれを優先する。
      const params = gen
        ? gen.map((p) => ({ name: p.name, required: p.required, desc: p.desc ?? p.tsType, schema: p.schema }))
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

  // 1.2) P4-10: presetir.sendIR の hub3DeviceId alias は presetir.js sendIR の JSDoc 型
  //   ({deviceId?, hub3DeviceId?, …}) に持たせており、NAMESPACE_OPS 自動公開がそこから
  //   param を抽出する。ここでの追記は不要 (旧パッチは hub3DeviceId を二重登録していた)。

  // 1.5) BLE op を BLE_RPC_OPS / OS2_BLE_RPC_OPS から自動公開 (SURF-08 段階3)。
  //   bleEntries (entries/ble.js) より先に set し、専用ハンドラ (ble.updateFirmware / ble.wifi.* 等) が
  //   override できるようにする (専用版は commandSent 分岐や companyId 解決を持つため)。
  const bleGen = bleOpEntries("ble", BLE_RPC_OPS, BLE_RPC_ALLOWLIST, {
    target: BLE_GEN_TARGET,
    run: (hub, params, fn) => SesameBle.use(bleUseOptsFromParams(hub, params), fn),
  });
  for (const [name, entry] of Object.entries(bleGen)) reg.set(name, entry);
  const os2Gen = bleOpEntries("ble.os2", OS2_BLE_RPC_OPS, OS2_BLE_RPC_ALLOWLIST, {
    target: OS2_GEN_TARGET,
    run: (_hub, params, fn) => os2UseRun(params, fn),
  });
  for (const [name, entry] of Object.entries(os2Gen)) reg.set(name, entry);

  // 2) 位置引数を持つ高レベル op の明示表 (entries/ へ分割済み — P5-2)。
  // キー順 (旧 topLevelEntries の return オブジェクト順と同一):
  //   authEntries → lockEntries → deviceEntriesPre → configEntries
  //   → webapiEntries → irEntries → accessAuthEntries → bleEntries
  const bleHelpers = { bleUseOptsFromParams, bleCommandAck };
  const fullBleHelpers = {
    invokePath, wifiViewOf, collectWifiScan, bleCommandAck,
    bleUseOptsFromParams, scrubDiscovery, reviveJsonArg,
    BLE_RPC_ALLOWLIST, OS2_BLE_RPC_ALLOWLIST,
  };
  for (const [name, entry] of Object.entries(authEntries())) reg.set(name, entry);
  for (const [name, entry] of Object.entries(lockEntries(bleHelpers))) reg.set(name, entry);
  for (const [name, entry] of Object.entries(deviceEntriesPre())) reg.set(name, entry);
  for (const [name, entry] of Object.entries(configEntries())) reg.set(name, entry);
  for (const [name, entry] of Object.entries(webapiEntries())) reg.set(name, entry);
  for (const [name, entry] of Object.entries(irEntries())) reg.set(name, entry);
  for (const [name, entry] of Object.entries(accessAuthEntries())) reg.set(name, entry);
  for (const [name, entry] of Object.entries(bleEntries(fullBleHelpers))) reg.set(name, entry);

  // 3) events (entries/events.js へ分割済み — P5-2)。
  for (const [name, entry] of Object.entries(eventsEntries({ TOPICS: SUBSCRIBABLE_TOPICS }))) reg.set(name, entry);

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
      event("event.deviceListChanged", t("serve.event.deviceListChanged")),
      event("event.ready", t("serve.event.ready")),
    ],
    // 購読可能 topic (events.subscribe / SSE ?topics= で受け付ける値)。event.ready のような
    // 接続時の broadcast 通知は含まない。SDK の購読型はこれ (x-events ではなく) から導出する。
    "x-event-topics": [...SUBSCRIBABLE_TOPICS],
  };
}
