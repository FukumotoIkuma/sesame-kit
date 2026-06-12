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
import {
  SesameBle, SesameOS2Ble, createBleTransport,
  BLE_RPC_ALLOWLIST, OS2_BLE_RPC_ALLOWLIST, resultName,
  BLE_RPC_OPS, OS2_BLE_RPC_OPS,
} from "../ble/index.js";
// P1-8 (R2:SURF-26 + R2:SURF-39): 生体一覧収集ヘルパを biometric.js から import する。
// CLI と serve の両方が同一実装を使うことで経路対称性 (規範4) を実現する。
import { collectBiometricList, BIO_LIST } from "../ble/biometric.js";
import { ITEM_CODES } from "../itemcodes.js";
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
 * config 同期 RPC (config.*) の前段ガード (SURF-07)。daemon の hub が ConfigStore を持たない
 * 構成 (config/tokenStore 直渡しの埋め込み等) では同期先が無いため bad_params で明示拒否する。
 * hub.syncXxx 側の plain Error (requiresConfigStore) が kind=internal に潰れるのを防ぐ。
 * @param {Hub} hub
 * @param {string} op エラーメッセージに出すメソッド名
 */
function requireConfigStore(hub, op) {
  if (!hub.configStore) {
    throw new RpcError(t("serve.configStoreRequired", { op }), { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
  }
}

/**
 * BLE ファサードをドット区切り op パスで辿って実行する (`ble.invoke` / `ble.os2.invoke` /
 * CLI `sesame ble invoke` 共通の単一実装。CLI が同じドット op パス・同じ JSON 引数 revive
 * 規約を共有するため export している)。
 *
 * **fail-closed (P4-2 / ARCH-14)**: 第 1 セグメントを allowlist (ble/index.js の
 * BLE_RPC_ALLOWLIST / OS2_BLE_RPC_ALLOWLIST = ファサードの意図的公開面) と照合し、
 * 非掲載は **値の解決 (getter 実行) より前に** bad_params で拒否する。旧実装は
 * `_`/constructor/prototype のブロックリストのみの fail-open で、connect/close/register 等の
 * ライフサイクル API や任意の getter に到達できた。
 *
 * @param {Record<string, any>} root 走査対象のオブジェクトツリー (ble facade 等)。
 * @param {string} path ドット区切りの op パス。
 * @param {unknown[]} [args]
 * @param {readonly string[]} [allowlist] 第 1 セグメントの allowlist。**未指定は全拒否**
 *   (fail-closed の既定。呼び出し側が公開面の表を明示的に渡す)。
 */
export async function invokePath(root, path, args = [], allowlist = []) {
  if (!path || typeof path !== "string") {
    throw new RpcError("missing required param: op", { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
  }
  if (path.includes("_") || path.includes("constructor") || path.includes("prototype")) {
    throw new RpcError(`unsupported BLE op: ${path}`, { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
  }
  const parts = path.split(".").filter(Boolean);
  // fail-closed: allowlist 非掲載の第 1 セグメントは、root のプロパティ解決 (getter が実行され
  // 得る) に入る前に拒否する。
  if (parts.length === 0 || !allowlist.includes(parts[0])) {
    throw new RpcError(`unsupported BLE op: ${path}`, { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
  }
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

// ---------- BLE 専用 RPC (P4-1 段階2) の共有ヘルパ ----------

/**
 * WM2 connectWifi の verification に使う既定 companyId。
 * 出典: _sesame_sdk_ref/app.properties:6 `aws.apigateway.clientId` (= BuildConfig.API_GATEWAY_CLIENT_ID。
 * CHWifiModule2Device.kt:358-363 が ":"/"-" を除去して company 部に使う)。params.companyId で上書き可。
 */
export const WM2_API_GATEWAY_CLIENT_ID = "ap-northeast-1:0a1820f1-dbb3-4bca-9227-2a92f6abf0ae";

// Wi-Fi SSID スキャン publish の既定収集時間 (SDK に終了通知契約が無い WM2 のための打ち切り)。
const WIFI_SCAN_COLLECT_MS = 8_000;

/**
 * SesameBle ファサードから Wi-Fi プロビジョニング view を kind で自動判別して返す。
 *   - wifiProvisioning (WM2)  → ble.wifi({companyId})
 *   - hubProvisioning (Hub3)  → ble.hub3()
 * どちらでもない model は bad_params (op を捏造して実機に送らない)。
 * CLI `sesame ble wifi` も同じ判別を共有する (export)。
 * @param {import("../ble/index.js").SesameBle} ble
 * @param {{companyId?:string}} [opts]
 * @returns {{type:"wm2"|"hub3", view:Record<string, any>}}
 */
export function wifiViewOf(ble, { companyId } = {}) {
  const caps = ble.capabilities;
  if (caps.wifiProvisioning) return { type: "wm2", view: ble.wifi({ companyId: companyId ?? WM2_API_GATEWAY_CLIENT_ID }) };
  if (caps.hubProvisioning) return { type: "hub3", view: ble.hub3() };
  throw new RpcError(t("serve.bleWifiNotSupported", { label: caps.label }), { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
}

/**
 * scanWifiSSID を送り、publish ({kind:"scanWifiSSID"}) を収集して SSID 一覧を返す。
 * Hub3 は SSID_LAST(134) マーカー publish (CHHub3Device.kt:325) で確定し、WM2 は終了通知が
 * 無い (CHWifiModule2Device.kt:486-490 は逐次 publish のみ) ため collectMs で打ち切る。
 * 同一 SSID の再 publish は rssi を更新する (重複行を返さない)。
 * @param {Record<string, any>} view WifiModule2 / Hub3Commands (onPublish + scanWifiSSID を持つ
 *   wifiViewOf の戻り view。Record なのは両クラスの publish 正規化形が異なるため)
 * @param {{collectMs?:number}} [opts]
 * @returns {Promise<{ssids:Array<{ssid:string, rssi:number}>}>}
 */
export function collectWifiScan(view, { collectMs = WIFI_SCAN_COLLECT_MS } = {}) {
  return new Promise((resolve, reject) => {
    /** @type {Map<string, {ssid:string, rssi:number}>} */
    const found = new Map();
    let done = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let timer = null;
    /** @type {() => void} */
    let off = () => {};
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      off();
      resolve({ ssids: [...found.values()] });
    };
    off = view.onPublish((/** @type {any} */ p) => {
      if (p && p.kind === "scanWifiSSID" && typeof p.ssid === "string") {
        found.set(p.ssid, { ssid: p.ssid, rssi: p.rssi });
      } else if (p && p.kind === "ssidMarker" && p.itemCode === ITEM_CODES.HUB3_ITEM_CODE_SSID_LAST) {
        finish(); // Hub3 のみ: 末尾マーカーで早期確定
      }
    });
    timer = setTimeout(finish, collectMs);
    // スキャン要求の ack 失敗 (BleResultError 等) は収集を打ち切って伝搬する。
    Promise.resolve(view.scanWifiSSID()).catch((err) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      off();
      reject(err);
    });
  });
}

/**
 * BLE コマンド応答 ({resultCode, payload}) を JSON 化可能な ack へ正規化する
 * (payload の生 Buffer は契約に載せない。生バイトが要る場合は ble.invoke を使う)。
 * @param {{resultCode:number}} r
 * @returns {{resultCode:number, resultName:string}}
 */
export function bleCommandAck(r) {
  return { resultCode: r.resultCode, resultName: resultName(r.resultCode) };
}

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
 * @param {import("../ble/index.js").BleRpcOpSpec} ops
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
  // ble.invoke / ble.* 専用 RPC 共通の対象指定群 (bleUseOptsFromParams が消費する単一の表)。
  const bleTargetParams = [
    { name: "deviceUUID", required: false, schema: S },
    { name: "address", required: false, schema: S },
    { name: "secretKey", required: true, schema: S },
    { name: "model", required: false, schema: S },
    { name: "scanTimeoutMs", required: false, schema: N },
    { name: "debug", required: false, schema: B },
    { name: "needAuthFromServer", required: false, schema: B },
    { name: "registerBaseUrl", required: false, schema: S },
  ];
  // ble.wifi.* は model で WM2 (専用 GATT) / Hub3 を判別するため model 必須。
  const bleTargetParamsModelRequired = bleTargetParams.map((p) => (
    p.name === "model" ? { ...p, required: true, desc: t("serve.desc.bleModelWifi") } : p
  ));

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
    // SURF-06: 実疎通の確認 (biz3KeepAlive 1 往復)。`status` は daemon のローカル状態を返すだけ
    // なので、RPC 消費者がクラウド接続の生存を実検証する手段としてこれを公開する。experimental。
    "cloud.ping": {
      summary: t("serve.sum.cloudPing"),
      params: [], result: "{ ok: true, rttMs }",
      handler: async ({ hub, daemon }) => {
        requireAuth(daemon);
        const t0 = Date.now();
        await hub.ping(); // keepalive ack 受信 = 生存。timeout は transport が reject する。
        return { ok: true, rttMs: Date.now() - t0 };
      },
    },
    "account.whoami": {
      summary: t("serve.sum.whoami"),
      params: [], result: t("serve.result.customerInfo"),
      handler: ({ hub, daemon }) => { requireAuth(daemon); return hub.getLoginUser(); },
    },
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
    // SURF-07: devices → config 同期を RPC へ公開 (hub.sync*FromDevices / syncRemoteKeys 委譲)。
    // daemon の ConfigStore (= CLI と同じ ~/.config/sesame-kit/config.json) へ**書き込む**操作。
    // ConfigStore を持たない構成 (config/tokenStore 直渡しの埋め込み) では bad_params で明示拒否
    // する (hub 側の plain Error が internal に潰れるのを防ぐ)。いずれも experimental。
    "config.syncLocks": {
      summary: t("serve.sum.configSyncLocks"),
      params: [{ name: "prune", required: false, desc: t("serve.desc.syncPrune"), schema: B }],
      result: "{ added, updated, removed }",
      handler: ({ hub, params, daemon }) => {
        requireAuth(daemon); requireConfigStore(hub, "config.syncLocks");
        return hub.syncLocksFromDevices({ prune: !!params.prune });
      },
    },
    "config.syncHub3s": {
      summary: t("serve.sum.configSyncHub3s"),
      params: [{ name: "prune", required: false, desc: t("serve.desc.syncPrune"), schema: B }],
      result: "{ added, updated, removed }",
      handler: ({ hub, params, daemon }) => {
        requireAuth(daemon); requireConfigStore(hub, "config.syncHub3s");
        return hub.syncHub3sFromDevices({ prune: !!params.prune });
      },
    },
    "config.syncRemotes": {
      summary: t("serve.sum.configSyncRemotes"),
      params: [],
      result: "{ hub3: {added,updated,removed}, remotes: {added,updated} }",
      handler: ({ hub, daemon }) => {
        requireAuth(daemon); requireConfigStore(hub, "config.syncRemotes");
        return hub.syncRemotesFromDevices();
      },
    },
    "config.syncRemoteKeys": {
      summary: t("serve.sum.configSyncRemoteKeys"),
      params: [{ name: "remote", required: false, desc: t("serve.desc.syncRemoteName"), schema: S }],
      result: "{ name, keyCount }",
      handler: ({ hub, params, daemon }) => {
        requireAuth(daemon); requireConfigStore(hub, "config.syncRemoteKeys");
        return hub.syncRemoteKeys(params.remote ?? null);
      },
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
    // P1-7 (R2:SURF-25): 近接 SESAME の発見一覧。BLE scan は鍵不要 (advertise のみ) で、
    // ble.register / ble.os2.register が要求する deviceUUID を RPC 消費者が自己解決できるようにする。
    // secretKey 不要・experimental (STABLE_METHODS 非掲載)。
    "ble.scan": {
      summary: t("serve.sum.bleScan"),
      params: [
        { name: "scanTimeoutMs", required: false, desc: t("serve.desc.bleScanTimeoutMs"), schema: N },
        { name: "includeUnknown", required: false, desc: t("serve.desc.bleScanIncludeUnknown"), schema: B },
      ],
      result: "{ ok: true, count, devices: [{deviceUUID, model, kind, productType, isRegistered, rssi, …}] }",
      handler: async ({ params }) => {
        const found = /** @type {Array<Record<string, unknown>>} */ (
          await SesameBle.listNearby({
            timeoutMs: params.scanTimeoutMs,
            includeUnknown: !!params.includeUnknown,
          })
        );
        return { ok: true, count: found.length, devices: found.map(scrubDiscovery) };
      },
    },
    "ble.invoke": {
      summary: t("serve.sum.bleInvoke"),
      params: [
        { name: "op", required: true, schema: S },
        { name: "args", required: false, schema: A },
        ...bleTargetParams,
      ],
      result: "BLE operation result",
      handler: async ({ hub, params }) => {
        need(params, ["op", "secretKey"]);
        // fail-closed (P4-2): 公開面 allowlist (ble/index.js BLE_RPC_ALLOWLIST) 非掲載 op は拒否。
        return SesameBle.use(bleUseOptsFromParams(hub, params),
          (ble) => invokePath(ble, params.op, params.args, BLE_RPC_ALLOWLIST));
      },
    },
    // ---- P4-1 段階2: 高価値 BLE op の専用 RPC (typed SDK に個別メソッドとして現れる) ----
    // いずれも experimental (STABLE_METHODS 非掲載)。対象指定は ble.invoke と同じ
    // {deviceUUID?, address?, secretKey, model?, …} (bleTargetParams / bleUseOptsFromParams)。
    "ble.updateFirmware": {
      summary: t("serve.sum.bleUpdateFirmware"),
      params: [...bleTargetParams, { name: "timeoutMs", required: false, schema: N }],
      result: "{ commandSent, resultCode|null, resultName|null }",
      handler: async ({ hub, params }) => SesameBle.use(bleUseOptsFromParams(hub, params), async (ble) => {
        // WM2 (OPEN_OTA_SERVER) / Hub3 (MOVE_TO) は応答 Promise、OS3 ロック系は SDK 同様
        // **コマンド無送信**で同期にハンドル返し (CHSesameOS3.kt:441-449。P1-7 の分岐をそのまま使う)。
        const r = /** @type {{resultCode?:number}} */ (
          await Promise.resolve(ble.updateFirmware({ timeoutMs: params.timeoutMs }))
        );
        const sent = typeof r?.resultCode === "number";
        return sent
          ? { commandSent: true, ...bleCommandAck(/** @type {{resultCode:number}} */ (r)) }
          : { commandSent: false, resultCode: null, resultName: null };
      }),
    },
    "ble.reset": {
      summary: t("serve.sum.bleReset"),
      params: [...bleTargetParams],
      result: "{ resultCode, resultName }",
      handler: async ({ hub, params }) => SesameBle.use(bleUseOptsFromParams(hub, params),
        async (ble) => bleCommandAck(await ble.reset())),
    },
    "ble.position": {
      summary: t("serve.sum.blePosition"),
      params: [
        ...bleTargetParams,
        { name: "lockPosition", required: true, desc: t("serve.desc.blePositionLock"), schema: N },
        { name: "unlockPosition", required: true, desc: t("serve.desc.blePositionUnlock"), schema: N },
      ],
      result: "{ resultCode, resultName }",
      handler: async ({ hub, params }) => {
        // 0 は有効な角度 (need() は 0 も欠落扱いするため undefined/null だけを明示チェック)。
        for (const k of ["lockPosition", "unlockPosition"]) {
          if (params[k] === undefined || params[k] === null) {
            throw new RpcError(t("serve.missingParam", { k }), { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
          }
        }
        return SesameBle.use(bleUseOptsFromParams(hub, params),
          async (ble) => bleCommandAck(await ble.configureLockPosition(params.lockPosition, params.unlockPosition)));
      },
    },
    "ble.wifi.scan": {
      summary: t("serve.sum.bleWifiScan"),
      params: [
        ...bleTargetParamsModelRequired,
        { name: "companyId", required: false, desc: t("serve.desc.bleCompanyId"), schema: S },
        { name: "collectMs", required: false, desc: t("serve.desc.bleCollectMs"), schema: N },
      ],
      result: "{ ssids: [{ssid, rssi}] }",
      handler: async ({ hub, params }) => {
        need(params, ["model"]); // WM2/Hub3 の判別 (GATT も異なる) に model が必須
        return SesameBle.use(bleUseOptsFromParams(hub, params), (ble) => {
          const { view } = wifiViewOf(ble, { companyId: params.companyId });
          return collectWifiScan(view, { collectMs: params.collectMs });
        });
      },
    },
    "ble.wifi.setSsid": {
      summary: t("serve.sum.bleWifiSetSsid"),
      params: [
        ...bleTargetParamsModelRequired,
        { name: "ssid", required: true, schema: S },
        { name: "companyId", required: false, desc: t("serve.desc.bleCompanyId"), schema: S },
      ],
      result: "{ resultCode, resultName }",
      handler: async ({ hub, params }) => {
        need(params, ["model", "ssid"]);
        return SesameBle.use(bleUseOptsFromParams(hub, params), async (ble) => {
          const { view } = wifiViewOf(ble, { companyId: params.companyId });
          return bleCommandAck(await view.setWifiSSID(params.ssid));
        });
      },
    },
    "ble.wifi.setPassword": {
      summary: t("serve.sum.bleWifiSetPassword"),
      params: [
        ...bleTargetParamsModelRequired,
        { name: "password", required: true, schema: S },
        { name: "companyId", required: false, desc: t("serve.desc.bleCompanyId"), schema: S },
      ],
      result: "{ resultCode, resultName }",
      handler: async ({ hub, params }) => {
        need(params, ["model", "password"]);
        return SesameBle.use(bleUseOptsFromParams(hub, params), async (ble) => {
          const { view } = wifiViewOf(ble, { companyId: params.companyId });
          return bleCommandAck(await view.setWifiPassword(params.password));
        });
      },
    },
    "ble.wifi.connect": {
      summary: t("serve.sum.bleWifiConnect"),
      params: [
        ...bleTargetParamsModelRequired,
        { name: "companyId", required: false, desc: t("serve.desc.bleCompanyId"), schema: S },
      ],
      result: "{ resultCode, resultName }",
      handler: async ({ hub, params }) => {
        need(params, ["model"]);
        return SesameBle.use(bleUseOptsFromParams(hub, params), async (ble) => {
          const { type, view } = wifiViewOf(ble, { companyId: params.companyId });
          // Hub3 に connect コマンドは存在しない (CHHub3Device.kt の Wi-Fi 系は SSID/Password の
          // 設定のみで、適用は本体側)。WM2 だけが CONNECT_WIFI(5) を持つ (CHWifiModule2Device.kt:355-365)。
          if (type !== "wm2") {
            throw new RpcError(t("serve.bleWifiConnectWm2Only"), { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
          }
          return bleCommandAck(await view.connectWifi());
        });
      },
    },
    // P1-8 (R2:SURF-26 + R2:SURF-39): 生体一覧 5 op の専用収集ハンドラ。
    // ble.wifi.scan (collectWifiScan) と同パターン: GET 要求 → publish(FIRST→NOTIFY×N→LAST) を
    // registerDelegate で収集し records 配列を返す。
    // これらは `bleOpEntries` が生成する "ack" 返しのハンドラ (ble.biometric.cardGet 等) を
    // topLevelEntries に明示し override する。override の理由: biometric.js の BIOMETRIC_RPC_OPS
    // では result:"ack" 宣言だが実際には publish 収集が必要で、ack だけ返しても消費者は実データを
    // 取得できない (P1-8 の問題の本質)。
    //
    // タイムアウト: ble.wifi.scan と同じ収集時間をデフォルトとする (collectMs param で上書き可)。
    // experimental (STABLE_METHODS 非掲載) — P4-1 の changelog に記載。
    ...(() => {
      // 5 op の共通ヘルパ: SesameBle.use → biometricView → collectBiometricList を共通化する。
      /**
       * type (card/passcode/finger/face/palm) に対応する biometric view を SesameBle facade から選ぶ。
       * finger は Bike3 の fingerPrint view、それ以外は biometric view を使う。
       * CLI の biometricView (cli/ble.js) と同一判別ロジック。
       * @param {import("../ble/index.js").SesameBle} ble
       * @param {string} type
       * @returns {Record<string, Function>}
       */
      function biometricViewOf(ble, type) {
        const caps = ble.capabilities;
        if (type === "finger" && caps.fingerprint && !caps.biometric) {
          return /** @type {Record<string, Function>} */ (/** @type {unknown} */ (ble.fingerPrint));
        }
        return /** @type {Record<string, Function>} */ (/** @type {unknown} */ (ble.biometric));
      }
      /** @param {string} type card|passcode|finger|face|palm */
      const bioListEntry = (type) => {
        const spec = BIO_LIST[/** @type {keyof typeof BIO_LIST} */ (type)];
        // op パスは BIOMETRIC_RPC_OPS / FINGERPRINT_RPC_OPS の getter 名に合わせる:
        //   card → biometric.cardGet
        //   passcode → biometric.passcodeGet
        //   face → biometric.faceListGet
        //   palm → biometric.palmListGet
        //   finger → fingerPrint.fingerPrints
        return {
          summary: t("serve.sum.bleBioListGet", { type }),
          params: [
            ...bleTargetParams,
            { name: "collectMs", required: false, desc: t("serve.desc.bleCollectMs"), schema: N },
          ],
          result: "{ records: Array<{id, name, type} | object> }",
          handler: async (/** @type {HandlerCtx} */ { hub, params }) => {
            const collectMs = typeof params.collectMs === "number" ? params.collectMs : 8_000;
            return SesameBle.use(bleUseOptsFromParams(hub, params), (ble) => {
              const cmds = biometricViewOf(ble, type);
              return collectBiometricList(cmds, spec, collectMs).then((records) => ({ records }));
            });
          },
        };
      };
      return {
        "ble.biometric.cardGet":    bioListEntry("card"),
        "ble.biometric.passcodeGet": bioListEntry("passcode"),
        "ble.biometric.faceListGet": bioListEntry("face"),
        "ble.biometric.palmListGet": bioListEntry("palm"),
        "ble.fingerPrint.fingerPrints": bioListEntry("finger"),
      };
    })(),
    "ble.register": {
      summary: t("serve.sum.bleRegister"),
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
      summary: t("serve.sum.bleOs2Invoke"),
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
        // fail-closed (P4-2): OS2 公開面 allowlist (ble/index.js OS2_BLE_RPC_ALLOWLIST) で照合。
        }, (ble) => invokePath(ble, params.op, params.args, OS2_BLE_RPC_ALLOWLIST));
      },
    },
    "ble.os2.register": {
      summary: t("serve.sum.bleOs2Register"),
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

  // 1.5) BLE op を BLE_RPC_OPS / OS2_BLE_RPC_OPS から自動公開 (SURF-08 段階3)。
  //   topLevelEntries より先に set し、専用ハンドラ (ble.updateFirmware / ble.wifi.* 等) が
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
      event("event.deviceListChanged", t("serve.event.deviceListChanged")),
      event("event.ready", t("serve.event.ready")),
    ],
    // 購読可能 topic (events.subscribe / SSE ?topics= で受け付ける値)。event.ready のような
    // 接続時の broadcast 通知は含まない。SDK の購読型はこれ (x-events ではなく) から導出する。
    "x-event-topics": [...SUBSCRIBABLE_TOPICS],
  };
}
