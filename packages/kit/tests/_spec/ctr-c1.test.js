// CTR-0019〜CTR-0037 (除 CTR-0035) spec tests — contract self-consistency
// 対象: packages/kit/src/serve/registry.js, stability.js, result-schemas.js
//       packages/core/src/jsonrpc.js, scripts/gen-grpc-proto.mjs, gen-sdk-*.mjs
//       packages/kit/tests/fixtures/upstream/*.json
// 実行環境: vitest (unit project)
// 方針: A/B 統合。より移植元忠実・網羅的な側を採用。TDD — red は許容 (spec 準拠が正典)

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  buildRegistry,
  buildOpenRpcDoc,
  SUBSCRIBABLE_TOPICS,
  STATE_TOPICS,
} from "../../src/serve/registry.js";
import {
  stabilityOf,
  provenanceOf,
  eventStabilityOf,
  eventProvenanceOf,
  STABLE_METHODS,
} from "../../src/serve/stability.js";
import { RESULT_SCHEMAS } from "../../src/serve/result-schemas.js";
import {
  makeResult,
  makeEvent,
  makeError,
  classify,
  handleMessage,
  errorFromThrow,
  RpcError,
  RPC,
  KIND,
} from "@sesame-kit/core/jsonrpc";
import { SesameError, ERR } from "@sesame-kit/core/errors";
import { generateProto } from "../../../../scripts/gen-grpc-proto.mjs";
import { generateSchema, serializeSchema } from "../../../../scripts/gen-rpc-schema.mjs";
import { generateSdk } from "../../../../scripts/gen-sdk-ts.mjs";
import { generateSdkPy } from "../../../../scripts/gen-sdk-py.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = resolve(HERE, "..", "..");
const REPO_ROOT = resolve(KIT_ROOT, "..", "..");

// committed openrpc.json (drift gate の基準)
const committed = JSON.parse(
  readFileSync(join(REPO_ROOT, "schema", "openrpc.json"), "utf8"),
);

// fixtures ディレクトリ
const FIXTURES_DIR = join(KIT_ROOT, "tests", "fixtures", "upstream");

// proto/map パス (drift gate)
const PROTO_PATH = resolve(KIT_ROOT, "src", "serve", "sesame.proto");
const MAP_PATH = resolve(KIT_ROOT, "src", "serve", "grpc-methods.generated.json");
const GENERATED_PATH = resolve(KIT_ROOT, "src", "serve", "rpc-params.generated.json");
const TS_SDK_PATH = resolve(KIT_ROOT, "sdk", "ts", "sesame-client.ts");
const PY_SDK_PATH = resolve(KIT_ROOT, "sdk", "python", "sesame_client.py");

// ── shared constants ──────────────────────────────────────────────────────────

const PROVENANCE_VOCAB = ["local", "app-core", "unverified"];
const STABLE_PROVENANCE = ["local", "app-core"];

// ── CTR-0019: event tier↔provenance 双条件 ────────────────────────────────────

describe("[CTR-0019] event tier↔provenance 双条件", () => {
  const reg = buildRegistry();
  const doc = buildOpenRpcDoc(reg, "0.0.0");
  const eventNames = doc["x-events"].map((e) => e.name);

  it("[CTR-0019] x-events 各イベントの eventProvenanceOf が語彙 {local,app-core,unverified} 内", () => {
    expect(eventNames.length).toBeGreaterThan(0);
    for (const name of eventNames) {
      expect(PROVENANCE_VOCAB, `${name}: provenance "${eventProvenanceOf(name)}" が語彙外`).toContain(eventProvenanceOf(name));
    }
  });

  it("[CTR-0019] stable イベントは {local,app-core} / それ以外は unverified", () => {
    for (const name of eventNames) {
      const prov = eventProvenanceOf(name);
      const tier = eventStabilityOf(name);
      if (tier === "stable") {
        expect(
          STABLE_PROVENANCE,
          `${name}: stable イベントの provenance "${prov}" は {local,app-core} でなければならない`,
        ).toContain(prov);
      } else {
        expect(
          prov,
          `${name}: experimental イベントの provenance は "unverified" でなければならない`,
        ).toBe("unverified");
      }
    }
  });
});

// ── CTR-0020: SUBSCRIBABLE_TOPICS 単一定義 ↔ x-event-topics ──────────────────

describe("[CTR-0020] SUBSCRIBABLE_TOPICS 単一定義から x-event-topics と daemon を駆動", () => {
  const reg = buildRegistry();
  const doc = buildOpenRpcDoc(reg, "0.0.0");

  it("[CTR-0020] SUBSCRIBABLE_TOPICS = STATE_TOPICS + deviceListChanged", () => {
    expect([...SUBSCRIBABLE_TOPICS]).toEqual([...STATE_TOPICS, "deviceListChanged"]);
  });

  it("[CTR-0020] buildOpenRpcDoc の x-event-topics が SUBSCRIBABLE_TOPICS と完全一致", () => {
    expect(doc["x-event-topics"]).toEqual([...SUBSCRIBABLE_TOPICS]);
  });

  it("[CTR-0020] event.ready は x-events に載るが購読可能集合 (SUBSCRIBABLE_TOPICS) に含まれない", () => {
    const eventNames = doc["x-events"].map((e) => e.name);
    expect(eventNames).toContain("event.ready");
    expect([...SUBSCRIBABLE_TOPICS]).not.toContain("ready");
    expect([...SUBSCRIBABLE_TOPICS]).not.toContain("event.ready");
  });

  it("[CTR-0020] committed openrpc.json の x-event-topics も SUBSCRIBABLE_TOPICS と一致", () => {
    expect(committed["x-event-topics"]).toEqual([...SUBSCRIBABLE_TOPICS]);
  });
});

// ── CTR-0021: proto3 field presence — optional scalar ─────────────────────────

describe("[CTR-0021] proto3 field presence: required でない scalar に optional 付与", () => {
  it("[CTR-0021] generateProto が required でない scalar に optionalScalars を付与する", async () => {
    const { nameMap } = await generateProto();
    const hasOptional = Object.values(nameMap).some((e) => e.optionalScalars && e.optionalScalars.length > 0);
    expect(hasOptional, "optionalScalars が 1 つもない — optional scalar 機構が壊れている").toBe(true);
  });

  it("[CTR-0021] LockSetAutolock.seconds は required のため optionalScalars に含まれない", async () => {
    const { nameMap } = await generateProto();
    const entry = Object.values(nameMap).find((e) => e.method === "lock.setAutolock");
    if (entry) {
      expect(entry.optionalScalars || []).not.toContain("seconds");
    }
  });

  it("[CTR-0021] scriptIndex/pageSize など non-required scalar は optionalScalars に列挙される", async () => {
    const { nameMap } = await generateProto();
    const found = Object.values(nameMap).some(
      (e) =>
        (e.optionalScalars || []).includes("scriptIndex") ||
        (e.optionalScalars || []).includes("pageSize"),
    );
    expect(found).toBe(true);
  });

  it("[CTR-0021] proto テキスト中に 'optional' キーワードが存在する", async () => {
    const { protoText } = await generateProto();
    expect(protoText).toMatch(/\boptional\s+\w+/);
  });
});

// ── CTR-0022: scalar は proto 型 / object/dynamic は JSON 文字列 field ──────────

describe("[CTR-0022] scalar は proto型 / object は JSON 文字列 field (jsonFields)", () => {
  it("[CTR-0022] lock.unlock/lock.status/device.history/ir.send/ir.listKeys は jsonFields=[]", async () => {
    const { nameMap } = await generateProto();
    const byMethod = Object.fromEntries(Object.values(nameMap).map((e) => [e.method, e]));
    for (const m of ["lock.unlock", "lock.status", "device.history", "ir.send", "ir.listKeys"]) {
      expect(byMethod[m], `${m} が生成物に無い`).toBeTruthy();
      expect(
        byMethod[m].jsonFields,
        `${m} の scalar 引数が JSON 文字列 field 化している (schema 付与漏れ)`,
      ).toEqual([]);
    }
  });

  it("[CTR-0022] device.battery の lastEvaluatedKey は jsonFields に列挙される (object = JSON 文字列 field)", async () => {
    const { nameMap } = await generateProto();
    const byMethod = Object.fromEntries(Object.values(nameMap).map((e) => [e.method, e]));
    expect(byMethod["device.battery"], "device.battery が無い").toBeTruthy();
    expect(byMethod["device.battery"].jsonFields).toEqual(["lastEvaluatedKey"]);
  });
});

// ── CTR-0023: sesame.proto + grpc-methods.generated.json drift gate ───────────

describe("[CTR-0023] sesame.proto + grpc-methods.generated.json drift gate", () => {
  it("[CTR-0023] generateProto() の protoText が committed sesame.proto とバイト一致", async () => {
    const { protoText } = await generateProto();
    expect(readFileSync(PROTO_PATH, "utf8")).toBe(protoText);
  });

  it("[CTR-0023] generateProto() の nameMap が grpc-methods.generated.json とバイト一致", async () => {
    const { nameMap } = await generateProto();
    expect(readFileSync(MAP_PATH, "utf8")).toBe(JSON.stringify(nameMap, null, 2) + "\n");
  });

  it("[CTR-0023] Subscribe(stream Event)/Invoke(JsonRpc) の 2 特別 rpc が末尾に固定追加される", async () => {
    const { protoText } = await generateProto();
    expect(protoText).toContain("rpc Subscribe (SubReq) returns (stream Event);");
    expect(protoText).toContain("rpc Invoke (JsonRpc) returns (JsonRpc);");
  });

  it("[CTR-0023] events.* は generateProto が除外する (Subscribe ストリームで扱う)", async () => {
    const { nameMap } = await generateProto();
    const methods = Object.values(nameMap).map((e) => e.method);
    const eventsMethod = methods.filter((m) => m.startsWith("events."));
    expect(eventsMethod).toEqual([]);
  });
});

// ── CTR-0024: rpc-params.generated.json drift gate ───────────────────────────

describe("[CTR-0024] rpc-params.generated.json drift gate", () => {
  it("[CTR-0024] committed rpc-params.generated.json が今の .d.ts から再生成した結果と一致", async () => {
    const fresh = serializeSchema(await generateSchema());
    expect(readFileSync(GENERATED_PATH, "utf8")).toBe(fresh);
  });
});

// ── CTR-0025: 公開 op の param schema が 1 つも空でない ──────────────────────

describe("[CTR-0025] 公開 op の param schema が 1 つも空でない (型不明を放置しない回帰ガード)", () => {
  it("[CTR-0025] generateSchema() の全 op の全 param が非空 schema を持つ", async () => {
    const schema = await generateSchema();
    const empties = [];
    for (const [op, params] of Object.entries(schema)) {
      for (const p of params) {
        if (!p.schema || Object.keys(p.schema).length === 0) {
          empties.push(`${op}.${p.name} (${p.tsType})`);
        }
      }
    }
    expect(
      empties,
      `空スキーマ param が存在する: ${empties.join(", ")} — nodeToSchema に型対応を追加すること`,
    ).toEqual([]);
  });
});

// ── CTR-0026: stability tier が gRPC proto の rpc 宣言直前コメントに伝播 ──────

describe("[CTR-0026] stability tier が gRPC proto の rpc 宣言直前コメントに伝播", () => {
  it("[CTR-0026] STABLE_METHODS の op は rpc 宣言直前に '// stable' コメントが付く", async () => {
    const { protoText } = await generateProto();
    const lines = protoText.split("\n");
    const stableExpected = [
      ["status", "Status"],
      ["account.whoami", "AccountWhoami"],
      ["lock.lock", "LockLock"],
      ["lock.unlock", "LockUnlock"],
      ["lock.status", "LockStatus"],
      ["devices.list", "DevicesList"],
      ["device.history", "DeviceHistory"],
      ["device.battery", "DeviceBattery"],
    ];
    for (const [, pascalName] of stableExpected) {
      const rpcLineIdx = lines.findIndex((l) => l.trimStart().startsWith(`rpc ${pascalName} (`));
      expect(rpcLineIdx, `rpc ${pascalName} が生成 proto に無い`).toBeGreaterThan(-1);
      const commentLine = lines[rpcLineIdx - 1]?.trim();
      expect(commentLine, `rpc ${pascalName} の直前行が '// stable' でない`).toBe("// stable");
    }
  });

  it("[CTR-0026] STABLE_METHODS 非掲載 op は '// experimental (unverified)' コメントが付く", async () => {
    const { protoText } = await generateProto();
    const lines = protoText.split("\n");
    const experimentalExpected = [
      ["org.getEmployees", "OrgGetEmployees"],
      ["ble.invoke", "BleInvoke"],
      ["ir.send", "IrSend"],
    ];
    for (const [, pascalName] of experimentalExpected) {
      const rpcLineIdx = lines.findIndex((l) => l.trimStart().startsWith(`rpc ${pascalName} (`));
      expect(rpcLineIdx, `rpc ${pascalName} が生成 proto に無い`).toBeGreaterThan(-1);
      const commentLine = lines[rpcLineIdx - 1]?.trim();
      expect(
        commentLine,
        `rpc ${pascalName} の直前行が '// experimental (unverified)' でない`,
      ).toBe("// experimental (unverified)");
    }
  });

  it("[CTR-0026] 生成 proto の '// stable' 行数が STABLE_METHODS の service 掲載数と一致", async () => {
    const { protoText } = await generateProto();
    const lines = protoText.split("\n");
    const stableCommentCount = lines.filter((l) => l.trim() === "// stable").length;
    const stableInService = Object.keys(STABLE_METHODS).filter(
      (name) => !name.startsWith("events."),
    ).length;
    expect(
      stableCommentCount,
      `stable コメント数 (${stableCommentCount}) と STABLE_METHODS service 掲載数 (${stableInService}) が不一致`,
    ).toBe(stableInService);
  });
});

// ── CTR-0027: JSON-RPC dispatch 分類規約 ─────────────────────────────────────

describe("[CTR-0027] JSON-RPC dispatch の分類規約", () => {
  it("[CTR-0027] 配列 (batch) は type:batch に分類される", () => {
    expect(classify("[]").type).toBe("batch");
    expect(classify("[1,2,3]").type).toBe("batch");
  });

  it("[CTR-0027] jsonrpc !== '2.0' は type:invalid", () => {
    expect(classify(JSON.stringify({ jsonrpc: "1.0", method: "foo", id: 1 })).type).toBe("invalid");
  });

  it("[CTR-0027] jsonrpc 欠落は type:invalid", () => {
    expect(classify(JSON.stringify({ method: "foo", id: 1 })).type).toBe("invalid");
  });

  it("[CTR-0027] id 欠落は type:notification (応答せず)", () => {
    const result = classify(JSON.stringify({ jsonrpc: "2.0", method: "foo" }));
    expect(result.type).toBe("notification");
  });

  it("[CTR-0027] id:null は type:request (通知ではない)", () => {
    const result = classify(JSON.stringify({ jsonrpc: "2.0", method: "foo", id: null }));
    expect(result.type).toBe("request");
    expect(result.id).toBe(null);
  });

  it("[CTR-0027] id あり は type:request", () => {
    const result = classify(JSON.stringify({ jsonrpc: "2.0", method: "bar", id: 1 }));
    expect(result.type).toBe("request");
    expect(result.id).toBe(1);
  });

  it("[CTR-0027] parse 失敗は type:parse-error", () => {
    expect(classify("not-json").type).toBe("parse-error");
  });

  it("[CTR-0027] handleMessage が batch を -32600 で拒否する", async () => {
    const response = await handleMessage("[]", async () => {});
    expect(response).not.toBeNull();
    expect(response.error.code).toBe(RPC.INVALID_REQUEST);
  });

  it("[CTR-0027] 通知はエラーでも null を返す (沈黙)", async () => {
    const response = await handleMessage(
      JSON.stringify({ jsonrpc: "2.0", method: "nonexistent.method" }),
      async () => { throw new Error("not found"); },
    );
    expect(response).toBeNull();
  });

  it("[CTR-0027] error.data に inbound params (secretKey 等) を echo しない", async () => {
    const errRes = await handleMessage(
      JSON.stringify({ jsonrpc: "2.0", method: "foo", id: 1, params: { secretKey: "S3CR3T" } }),
      async () => { throw new Error("fail"); },
    );
    expect(errRes.error).toBeTruthy();
    const dataStr = JSON.stringify(errRes.error.data || {});
    expect(dataStr).not.toContain("S3CR3T");
    expect(dataStr).not.toContain("secretKey");
  });

  it("[CTR-0027] makeError の data に params は含まれない (secretKey 漏洩防止)", () => {
    const errResp = makeError(1, RPC.APP_ERROR, "fail", KIND.INTERNAL, null);
    const dataStr = JSON.stringify(errResp.error.data || {});
    expect(dataStr).not.toContain("secretKey");
    expect(dataStr).not.toContain("params");
  });
});

// ── CTR-0028: error.kind 写像の全 framing 単一真実源 ─────────────────────────

describe("[CTR-0028] error.kind 写像: SesameError/BleResultError → JSON-RPC kind/retryable", () => {
  it("[CTR-0028] RpcError はそのまま素通し", () => {
    const err = new RpcError("custom msg", { code: RPC.APP_ERROR, kind: KIND.REJECTED });
    const resp = errorFromThrow(1, err);
    expect(resp.error.code).toBe(RPC.APP_ERROR);
    expect(resp.error.data.kind).toBe(KIND.REJECTED);
  });

  it("[CTR-0028] BleResultError(invalidSig) → not_authenticated", () => {
    const err = Object.assign(new Error("invalid signature"), {
      name: "BleResultError",
      resultCode: 2,
      resultName: "invalidSig",
      itemCode: null,
    });
    const resp = errorFromThrow(1, err);
    expect(resp.error.data.kind).toBe(KIND.NOT_AUTHENTICATED);
  });

  it("[CTR-0028] BleResultError(busy) → rejected + retryable:true", () => {
    const err = Object.assign(new Error("device busy"), {
      name: "BleResultError",
      resultCode: 5,
      resultName: "busy",
      itemCode: null,
    });
    const resp = errorFromThrow(1, err);
    expect(resp.error.data.kind).toBe(KIND.REJECTED);
    expect(resp.error.data.retryable).toBe(true);
  });

  it("[CTR-0028] BleResultError(未知 resultName) → rejected (fallback)", () => {
    const err = Object.assign(new Error("unknown(9)"), {
      name: "BleResultError",
      resultCode: 9,
      resultName: "unknown(9)",
      itemCode: null,
    });
    const resp = errorFromThrow(1, err);
    expect(resp.error.data.kind).toBe(KIND.REJECTED);
    expect(resp.error.data.retryable).toBe(false);
  });

  it("[CTR-0028] SesameError(NOT_CONNECTED) → kind=connection_lost", () => {
    const err = new SesameError("not connected", { code: ERR.NOT_CONNECTED });
    const resp = errorFromThrow(1, err);
    expect(resp.error.data.kind).toBe(KIND.CONNECTION_LOST);
  });

  it("[CTR-0028] 想定外エラー → kind=internal (stack/params は出さない)", () => {
    const err = new Error("unexpected internal failure");
    const resp = errorFromThrow(1, err);
    expect(resp.error.data.kind).toBe(KIND.INTERNAL);
    expect(resp.error.code).toBe(RPC.INTERNAL_ERROR);
    expect(JSON.stringify(resp)).not.toContain("stack");
    expect(JSON.stringify(resp.error.data || {})).not.toContain("at ");
  });

  it("[CTR-0028] KIND enum が実 emit 値のみ宣言する (not_authenticated/bad_params/timeout/connection_lost/rejected/internal/not_implemented)", () => {
    const validKinds = new Set([
      "not_authenticated", "bad_params", "timeout", "connection_lost",
      "rejected", "internal", "not_implemented",
    ]);
    for (const v of Object.values(KIND)) {
      expect(validKinds.has(v), `KIND に未知の値 "${v}" がある`).toBe(true);
    }
  });
});

// ── CTR-0029: SDK がスキーマ駆動で機械生成され全 stable メソッドを露出 ─────────

describe("[CTR-0029] SDK(ts/py) スキーマ駆動生成・全 stable メソッド露出", () => {
  it("[CTR-0029] generateSdk(spec) が committed sesame-client.ts とバイト一致", () => {
    const committed_ts = readFileSync(TS_SDK_PATH, "utf8");
    expect(generateSdk(committed)).toBe(committed_ts);
  });

  it("[CTR-0029] generateSdkPy(spec) が committed sesame_client.py とバイト一致", () => {
    const committed_py = readFileSync(PY_SDK_PATH, "utf8");
    expect(generateSdkPy(committed)).toBe(committed_py);
  });

  it("[CTR-0029] 全 stable メソッドが TS SDK に op として出る", () => {
    const committed_ts = readFileSync(TS_SDK_PATH, "utf8");
    const stable = committed.methods.filter((m) => m["x-stability"] === "stable");
    for (const m of stable) {
      const op = m.name.includes(".") ? m.name.slice(m.name.indexOf(".") + 1) : m.name;
      expect(
        committed_ts.includes(`${op}:`) || committed_ts.includes(`${op} =`),
        `stable メソッド ${m.name} (op=${op}) が TS SDK に出ていない`,
      ).toBe(true);
    }
  });

  it("[CTR-0029] 全 stable メソッドが Python SDK に def として出る", () => {
    const committed_py = readFileSync(PY_SDK_PATH, "utf8");
    const stable = committed.methods.filter((m) => m["x-stability"] === "stable");
    for (const m of stable) {
      const op = m.name.includes(".") ? m.name.slice(m.name.indexOf(".") + 1) : m.name;
      expect(
        committed_py.includes(`def ${op}(`),
        `stable ${m.name} が Python SDK に def として出ていない`,
      ).toBe(true);
    }
  });

  it("[CTR-0029] TS SDK に API_VERSION === x-apiVersion が焼き込まれる", () => {
    const committed_ts = readFileSync(TS_SDK_PATH, "utf8");
    expect(committed_ts).toContain(`API_VERSION = "${committed.info["x-apiVersion"]}"`);
  });
});

// ── CTR-0030: experimental tier が生成 SDK の @experimental 注記に伝播 ─────────

describe("[CTR-0030] experimental tier が生成 SDK(ts/py) の @experimental 注記に伝播", () => {
  it("[CTR-0030] TS SDK に @experimental 注記が含まれる", () => {
    const committed_ts = readFileSync(TS_SDK_PATH, "utf8");
    expect(committed_ts).toContain("@experimental");
  });

  it("[CTR-0030] Python SDK に @experimental 注記が含まれる", () => {
    const committed_py = readFileSync(PY_SDK_PATH, "utf8");
    expect(committed_py).toContain("@experimental");
  });

  it("[CTR-0030] generateSdk で experimental メソッドは @experimental JSDoc コメント付き", () => {
    const generated_ts = generateSdk(committed);
    const hasExperimental = committed.methods.some((m) => m["x-stability"] === "experimental");
    if (hasExperimental) {
      expect(generated_ts).toContain("@experimental");
    }
  });

  it("[CTR-0030] generateSdkPy で experimental メソッドは @experimental docstring 付き", () => {
    const generated_py = generateSdkPy(committed);
    const hasExperimental = committed.methods.some((m) => m["x-stability"] === "experimental");
    if (hasExperimental) {
      expect(generated_py).toContain("@experimental");
    }
  });

  it("[CTR-0030] TS SDK API_VERSION が x-apiVersion と一致する", () => {
    const committed_ts = readFileSync(TS_SDK_PATH, "utf8");
    expect(committed_ts).toContain(`API_VERSION = "${committed.info["x-apiVersion"]}"`);
  });

  it("[CTR-0030] Python SDK API_VERSION が x-apiVersion と一致する", () => {
    const committed_py = readFileSync(PY_SDK_PATH, "utf8");
    expect(committed_py).toContain(`API_VERSION = "${committed.info["x-apiVersion"]}"`);
  });
});

// ── CTR-0031: nullable result schema が SDK 戻り型の | null / | None に伝播 ──────

describe("[CTR-0031] nullable result schema が SDK 戻り型の | null / | None に伝播", () => {
  it("[CTR-0031] lock.status は RESULT_SCHEMAS で nullable:true", () => {
    expect(RESULT_SCHEMAS["lock.status"]).toBeTruthy();
    expect(RESULT_SCHEMAS["lock.status"].nullable).toBe(true);
  });

  it("[CTR-0031] TS SDK で lock.status の戻り型に '| null' が含まれる", () => {
    const generated_ts = generateSdk(committed);
    expect(generated_ts).toContain("| null");
  });

  it("[CTR-0031] Python SDK で lock.status の戻り型に '| None' が含まれる", () => {
    const generated_py = generateSdkPy(committed);
    expect(generated_py).toContain("| None");
  });

  it("[CTR-0031] device.battery.lastEvaluatedKey も nullable:true (nullable OBJ)", () => {
    const schema = RESULT_SCHEMAS["device.battery"];
    expect(schema).toBeTruthy();
    expect(schema.properties?.lastEvaluatedKey?.nullable).toBe(true);
  });
});

// ── CTR-0032: experimental メソッド(keystore 等)が registry に存在し experimental で公開 ─

describe("[CTR-0032] experimental メソッド(keystore.*)が registry に存在し x-stability=experimental で公開", () => {
  const reg = buildRegistry();

  it("[CTR-0032] keystore.list が registry に登録されている", () => {
    expect(reg.has("keystore.list")).toBe(true);
  });

  it("[CTR-0032] keystore.put が registry に登録されている", () => {
    expect(reg.has("keystore.put")).toBe(true);
  });

  it("[CTR-0032] keystore.remove が registry に登録されている", () => {
    expect(reg.has("keystore.remove")).toBe(true);
  });

  it("[CTR-0032] keystore.* は STABLE_METHODS 非掲載のため stabilityOf=experimental", () => {
    for (const m of ["keystore.list", "keystore.put", "keystore.remove"]) {
      expect(stabilityOf(m), `${m} の stability が experimental でない`).toBe("experimental");
    }
  });

  it("[CTR-0032] keystore.* の provenanceOf=unverified", () => {
    for (const m of ["keystore.list", "keystore.put", "keystore.remove"]) {
      expect(provenanceOf(m), `${m} の provenance が unverified でない`).toBe("unverified");
    }
  });

  it("[CTR-0032] buildOpenRpcDoc で keystore.* が x-stability=experimental で射影される", () => {
    const doc = buildOpenRpcDoc(reg, "0.0.0");
    for (const name of ["keystore.list", "keystore.put", "keystore.remove"]) {
      const m = doc.methods.find((x) => x.name === name);
      expect(m, `${name} が OpenRPC doc に無い`).toBeTruthy();
      expect(m["x-stability"]).toBe("experimental");
      expect(m["x-provenance"]).toBe("unverified");
    }
  });
});

// ── CTR-0033: 記録済み上流応答が RESULT_SCHEMAS に適合 (オフライン canary replay) ──

// 最小 JSON-Schema バリデータ (canary-upstream.mjs と同ロジック)
function validate(schema, value, path = "$") {
  if (!schema || typeof schema !== "object") return [];
  if (value === null) {
    return schema.nullable ? [] : [`${path}: null は許可されていない (nullable でない)`];
  }
  if (value === undefined) return [`${path}: 値が undefined`];
  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || Array.isArray(value)) {
        return [`${path}: object を期待したが ${Array.isArray(value) ? "array" : typeof value}`];
      }
      const errors = [];
      for (const key of schema.required || []) {
        if (value[key] === undefined || value[key] === null) {
          errors.push(`${path}.${key}: required フィールドが欠落`);
        }
      }
      for (const [key, sub] of Object.entries(schema.properties || {})) {
        if (value[key] !== undefined) errors.push(...validate(sub, value[key], `${path}.${key}`));
      }
      return errors;
    }
    case "array": {
      if (!Array.isArray(value)) return [`${path}: array を期待したが ${typeof value}`];
      const errors = [];
      value.forEach((item, i) => errors.push(...validate(schema.items, item, `${path}[${i}]`)));
      return errors;
    }
    case "string":
      return typeof value === "string" ? [] : [`${path}: string を期待したが ${typeof value}`];
    case "number":
      return typeof value === "number" ? [] : [`${path}: number を期待したが ${typeof value}`];
    case "boolean":
      return typeof value === "boolean" ? [] : [`${path}: boolean を期待したが ${typeof value}`];
    default:
      return [];
  }
}

describe("[CTR-0033] 記録済み上流応答が RESULT_SCHEMAS に適合 (オフライン canary replay drift gate)", () => {
  const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));

  it("[CTR-0033] 全 fixture が RESULT_SCHEMAS に適合する (exit 0 相当)", () => {
    expect(files.length, "fixture が無い").toBeGreaterThan(0);
    const violations = [];
    for (const f of files) {
      const fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, f), "utf8"));
      const schema = RESULT_SCHEMAS[fixture.method];
      if (!schema) {
        violations.push(`${f}: 未知の method "${fixture.method}"`);
        continue;
      }
      if (!("sample" in fixture)) {
        violations.push(`${f}: sample フィールドが無い`);
        continue;
      }
      const errors = validate(schema, fixture.sample);
      if (errors.length > 0) {
        violations.push(`${f}: ${errors.slice(0, 2).join(", ")}`);
      }
    }
    expect(violations, `DRIFT 検出: ${violations.join("; ")}`).toEqual([]);
  });

  it("[CTR-0033] validate() は schema.nullable のとき value===null を許容する", () => {
    const nullSchema = { type: "object", nullable: true, properties: {}, required: [] };
    expect(validate(nullSchema, null)).toEqual([]);
  });

  it("[CTR-0033] validate() は非 nullable schema で null を違反とする", () => {
    const nonNullSchema = { type: "object", properties: {}, required: [] };
    const errors = validate(nonNullSchema, null);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("[CTR-0033] validate() は value===undefined を違反とする", () => {
    const schema = { type: "string" };
    const errors = validate(schema, undefined);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("[CTR-0033] lock.status null fixture が nullable 経路で適合する", () => {
    const nullFixture = JSON.parse(
      readFileSync(join(FIXTURES_DIR, "lock.status.null.json"), "utf8"),
    );
    const schema = RESULT_SCHEMAS[nullFixture.method];
    const errors = validate(schema, nullFixture.sample);
    expect(errors).toEqual([]);
  });

  it("[CTR-0033] device.battery.lastpage fixture が nullable lastEvaluatedKey で適合する", () => {
    const fixture = JSON.parse(
      readFileSync(join(FIXTURES_DIR, "device.battery.lastpage.json"), "utf8"),
    );
    const schema = RESULT_SCHEMAS[fixture.method];
    const errors = validate(schema, fixture.sample);
    expect(errors).toEqual([]);
  });

  it("[CTR-0033] nullable schema で value===null を許容し、非 nullable で null は違反 (RESULT_SCHEMAS)", () => {
    // lock.status は nullable(DEVICE) → null を許容
    const lockStatusSchema = RESULT_SCHEMAS["lock.status"];
    expect(lockStatusSchema.nullable).toBe(true);
    expect(validate(lockStatusSchema, null)).toEqual([]);

    // devices.list は array(DEVICE) → null は違反
    const devicesListSchema = RESULT_SCHEMAS["devices.list"];
    expect(validate(devicesListSchema, null).length).toBeGreaterThan(0);
  });
});

// ── CTR-0034: 全 fixture の method が RESULT_SCHEMAS のキーであり sample を持つ ──

describe("[CTR-0034] 全 fixture の method が RESULT_SCHEMAS のキーであり sample を持つ", () => {
  const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));

  it("[CTR-0034] 各 fixture は method が RESULT_SCHEMAS に実在し sample フィールドを持つ", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const fixture = JSON.parse(readFileSync(join(FIXTURES_DIR, f), "utf8"));
      expect(RESULT_SCHEMAS[fixture.method], `${f}: 未知の method ${fixture.method}`).toBeTruthy();
      expect("sample" in fixture, `${f}: sample 欠落`).toBe(true);
    }
  });

  it("[CTR-0034] stable read-only の fixture が存在する (status/account.whoami/devices.list/lock.status)", () => {
    const methods = new Set(
      files.map((f) => JSON.parse(readFileSync(join(FIXTURES_DIR, f), "utf8")).method),
    );
    for (const m of ["status", "account.whoami", "devices.list", "lock.status"]) {
      expect(methods.has(m), `stable method "${m}" の fixture が無い`).toBe(true);
    }
  });
});

// ── CTR-0036: pascal(method) 写像の単射性 ─────────────────────────────────────

describe("[CTR-0036] pascal(method)→PascalCase 写像が非 event registry メソッド全体に対し単射", () => {
  it("[CTR-0036] grpc-methods.generated.json のエントリ数が非 events.* registry メソッド数と一致 (衝突による脱落ゼロ)", async () => {
    const { nameMap } = await generateProto();
    const reg = buildRegistry();
    const nonEventCount = [...reg.keys()].filter((k) => !k.startsWith("events.")).length;
    expect(
      Object.keys(nameMap).length,
      `nameMap エントリ数 が非 event registry メソッド数(${nonEventCount}) と不一致 — pascal 衝突による silent 脱落の可能性`,
    ).toBe(nonEventCount);
  });

  it("[CTR-0036] nameMap の全 Pascal 名が distinct (衝突ゼロ)", async () => {
    const { nameMap } = await generateProto();
    const pascals = Object.keys(nameMap);
    const distinct = new Set(pascals);
    expect(distinct.size).toBe(pascals.length);
  });

  it("[CTR-0036] nameMap の全 method 値が distinct (2 つの JSON-RPC method が同一 Pascal に写像されない)", async () => {
    const { nameMap } = await generateProto();
    const methods = Object.values(nameMap).map((e) => e.method);
    const distinct = new Set(methods);
    expect(distinct.size).toBe(methods.length);
  });
});

// ── CTR-0037: makeResult の undefined→null 正規化と makeEvent の event.<topic> 命名規約 ──

describe("[CTR-0037] makeResult の undefined→null 正規化と makeEvent の event.<topic> 命名規約", () => {
  it("[CTR-0037] makeResult は result===undefined を null に正規化する", () => {
    const resp = makeResult(1, undefined);
    expect(resp.jsonrpc).toBe("2.0");
    expect(resp.id).toBe(1);
    expect(resp.result).toBe(null);
  });

  it("[CTR-0037] makeResult は result が null のときそのまま null を返す", () => {
    const resp = makeResult(2, null);
    expect(resp.result).toBe(null);
  });

  it("[CTR-0037] makeResult は通常値をそのまま返す (result===0 は 0)", () => {
    const resp = makeResult(3, 0);
    expect(resp.result).toBe(0);
  });

  it("[CTR-0037] makeResult は通常オブジェクトをそのまま返す", () => {
    const resp = makeResult(4, { ok: true });
    expect(resp.result).toEqual({ ok: true });
  });

  it("[CTR-0037] makeEvent は 'event.<topic>' 命名規約でフレームを組む", () => {
    const frame = makeEvent("lockState", { deviceUUID: "U", locked: true });
    expect(frame.jsonrpc).toBe("2.0");
    expect(frame.method).toBe("event.lockState");
    expect(frame.params).toEqual({ deviceUUID: "U", locked: true });
  });

  it("[CTR-0037] makeEvent の method が gRPC Subscribe の 'event.' prefix strip と対応する", () => {
    const frame = makeEvent("deviceUpdate", { data: 1 });
    const topic = String(frame.method || "").replace(/^event\./, "");
    expect(topic).toBe("deviceUpdate");
  });

  it("[CTR-0037] makeEvent は SUBSCRIBABLE_TOPICS の全 topic で命名規約を満たす", () => {
    for (const topic of SUBSCRIBABLE_TOPICS) {
      const frame = makeEvent(topic, null);
      expect(frame.method).toBe(`event.${topic}`);
    }
  });
});
