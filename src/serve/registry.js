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
import * as schedule from "../schedule.js";
import * as org from "../org.js";
import * as company from "../company.js";
import * as access from "../access.js";
import * as iot from "../iot.js";
import * as presetir from "../presetir.js";

// ビルド時に .d.ts から抽出した名前空間 op の param 型 (scripts/gen-rpc-schema.mjs)。
// これにより discover が「名前空間 op の引数名・型」を自己記述できる。
let GEN_PARAMS = {};
try {
  GEN_PARAMS = JSON.parse(readFileSync(new URL("./rpc-params.generated.json", import.meta.url), "utf8"));
} catch { /* 未生成なら空 (フォールバックの (params) になる) */ }

// 自動公開する名前空間 (getter 名 → モジュール)。getter は SesameHub3 のプロパティ名と一致。
const NS_MODULES = { schedule, org, company, access, iot, presetir };

/** params 必須キーの存在チェック (軽量バリデータ)。欠落は bad_params。 */
function need(params, keys) {
  for (const k of keys) {
    if (params[k] === undefined || params[k] === null || params[k] === "") {
      throw new RpcError(`missing required param: ${k}`, { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
    }
  }
}

/** クラウド接続が要る op の前段ガード (未認証/未接続を明示エラーに)。 */
function requireAuth(daemon) {
  if (daemon.authState === "expired") {
    throw new RpcError("not authenticated — run: sesame login <email>  (then restart the daemon)", { kind: KIND.NOT_AUTHENTICATED });
  }
  if (!daemon.hub.connected) {
    throw new RpcError("cloud not connected", { kind: KIND.CONNECTION_LOST });
  }
}

/**
 * 位置引数を持つ高レベル op の薄い橋渡し表。
 * 各 entry: { summary, params:[{name,required,desc}], result, handler }
 */
function topLevelEntries() {
  /** name (config) もしくは {deviceUUID,secretKey} で lock op を発行する共通 helper。 */
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
    { name: "name", required: false, desc: "config 上のロック名 (deviceUUID 指定時は不要)", schema: S },
    { name: "deviceUUID", required: false, desc: "直接指定する deviceUUID", schema: S },
    { name: "secretKey", required: false, desc: "deviceUUID 指定時の 32hex 共通鍵", schema: S },
  ];

  return {
    "status": {
      summary: "デーモン状態 (接続/認証/ユーザ/契約版)",
      params: [], result: "{ connected, authState, subUUID, contractVersion }",
      // contractVersion: 消費者が major 不一致を fail-fast できるよう毎回返す。
      handler: ({ hub, daemon }) => ({ connected: hub.connected, authState: daemon.authState, subUUID: hub.subUUID, contractVersion: CONTRACT_VERSION }),
    },
    "account.whoami": {
      summary: "ログインユーザ情報 (biz3GetLoginUser)",
      params: [], result: "customerInfo 等",
      handler: ({ hub, daemon }) => { requireAuth(daemon); return hub.getLoginUser(); },
    },
    "lock.lock": { summary: "施錠", params: lockParams, result: "状態 push", handler: lockOp("lock") },
    "lock.unlock": { summary: "解錠", params: lockParams, result: "状態 push", handler: lockOp("unlock") },
    "lock.toggle": { summary: "トグル", params: lockParams, result: "状態 push", handler: lockOp("toggle") },
    "lock.click": { summary: "Bot クリック", params: lockParams, result: "状態 push", handler: lockOp("botClick") },
    "lock.status": {
      summary: "デバイスの現在状態 (lock state/battery)",
      params: [{ name: "deviceUUID", required: true, desc: "対象 deviceUUID", schema: S }], result: "status",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["deviceUUID"]); return hub.getDeviceStatus(params.deviceUUID); },
    },
    "devices.list": {
      summary: "全 SESAME デバイス一覧 (secretKey 含む)",
      params: [], result: "device[]",
      handler: ({ hub, daemon }) => { requireAuth(daemon); return hub.listDevices(); },
    },
    "device.history": {
      summary: "開閉履歴",
      params: [{ name: "deviceUUID", required: true, schema: S }, { name: "pageSize", required: false, schema: N }], result: "history[]",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["deviceUUID"]); return hub.getDeviceHistory([params.deviceUUID], params.pageSize); },
    },
    "device.battery": {
      summary: "電池履歴",
      params: [{ name: "deviceUUID", required: true, schema: S }, { name: "pageSize", required: false, schema: N }], result: "battery[]",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["deviceUUID"]); return hub.getDeviceBattery(params.deviceUUID, { pageSize: params.pageSize }); },
    },
    "ir.send": {
      summary: "IR リモコンのキーを送信",
      params: [{ name: "remote", required: false, desc: "リモコン名 (省略時 default)", schema: S }, { name: "key", required: true, desc: "キー名 or keyUUID", schema: S }],
      result: "送信応答",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); need(params, ["key"]); return hub.send(params.remote ?? null, params.key); },
    },
    "ir.listKeys": {
      summary: "リモコンの学習済みキー一覧",
      params: [{ name: "remote", required: false, schema: S }], result: "key[]",
      handler: ({ hub, params, daemon }) => { requireAuth(daemon); return hub.listKeys(params.remote ?? null); },
    },
  };
}

/** events.subscribe / unsubscribe (daemon に委譲)。 */
function eventEntries() {
  const TOPICS = ["lockState", "deviceUpdate"];
  return {
    "events.subscribe": {
      summary: `イベント購読 (topics: ${TOPICS.join("/")})。以後 event.<topic> 通知が届く`,
      params: [{ name: "topics", required: true, desc: `購読する topic 配列 (${TOPICS.join("/")})` }],
      result: "{ subscribed: string[] }",
      handler: ({ params, conn, daemon }) => {
        if (conn?.ephemeral) {
          throw new RpcError("events.* は持続接続が必要です (UDS/WebSocket/SSE/gRPC Subscribe)。HTTP POST /rpc や gRPC Invoke では購読できません",
            { code: RPC.INVALID_REQUEST, kind: KIND.BAD_PARAMS });
        }
        const topics = Array.isArray(params.topics) ? params.topics : [params.topics];
        const bad = topics.filter((t) => !TOPICS.includes(t));
        if (bad.length) throw new RpcError(`unknown topic(s): ${bad.join(",")}`, { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
        return daemon.subscribe(conn, topics);
      },
    },
    "events.unsubscribe": {
      summary: "イベント購読解除",
      params: [{ name: "topics", required: true }],
      result: "{ subscribed: string[] }",
      handler: ({ params, conn, daemon }) => {
        const topics = Array.isArray(params.topics) ? params.topics : [params.topics];
        return daemon.unsubscribe(conn, topics);
      },
    },
  };
}

/**
 * 全エントリを {name → entry} で構築する。
 * @returns {Map<string, {summary:string, params:any[], result:string, handler:Function, namespace?:string}>}
 */
export function buildRegistry() {
  const reg = new Map();

  // 1) 名前空間 op を NAMESPACE_OPS から自動公開。
  for (const [ns, mod] of Object.entries(NS_MODULES)) {
    const ops = Array.isArray(mod.NAMESPACE_OPS) ? mod.NAMESPACE_OPS : [];
    for (const op of ops) {
      const gen = GEN_PARAMS[`${ns}.${op}`];
      // 抽出済みなら実 param (名前/required/型) を、無ければ汎用 (params) を出す。
      const params = gen
        ? gen.map((p) => ({ name: p.name, required: p.required, desc: p.tsType, schema: p.schema }))
        : [{ name: "(params)", required: false, desc: "biz3 op の params をそのまま渡す" }];
      reg.set(`${ns}.${op}`, {
        summary: `${ns} の ${op} (自動公開)`,
        params,
        result: "op 応答",
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
 */
export function buildOpenRpcDoc(reg, version) {
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
      result: { name: "result", schema: { description: e.result || "", type: "object" } },
    });
  }
  // サーバ発イベントも記述 (予約名 event.<topic>)。
  return {
    openrpc: "1.2.6",
    info: {
      title: "sesame serve",
      version, // パッケージ version (無害な変更でも上がる)
      "x-contractVersion": CONTRACT_VERSION, // 機械契約の SemVer (破壊的変更でだけ major)
      description: "SESAME 制御の言語非依存 JSON-RPC バックエンド",
    },
    methods,
    "x-events": [
      { name: "event.lockState", description: "ロック状態変化 push (events.subscribe lockState)" },
      { name: "event.deviceUpdate", description: "デバイス状態更新 push (events.subscribe deviceUpdate)" },
      { name: "event.ready", description: "起動完了通知 (stdio framing のみ。接続直後に 1 回。他経路では飛ばない)" },
    ],
  };
}
