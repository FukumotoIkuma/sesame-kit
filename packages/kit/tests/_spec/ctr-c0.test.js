// packages/kit/tests/_spec/ctr-c0.test.js
// CTR-0001 〜 CTR-0018 の TDD spec テスト (統合版)
// 対象実装: packages/kit/src/serve/registry.js, result-schemas.js, stability.js
//           packages/core/src/jsonrpc.js, schema/openrpc.json
// 参照既存テスト: openrpc-contract.test.js, provenance.test.js,
//               serve/contract-fingerprint.test.js, serve/result-schemas-contract.test.js,
//               serve-stability.test.js
// 方針: A/B 統合。実行可能・self-contained・決定論的 (ネットワーク/実機不使用)

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  buildRegistry,
  buildOpenRpcDoc,
  NAMESPACE_MODULE_KEYS,
  SUBSCRIBABLE_TOPICS,
} from "../../src/serve/registry.js";
import { RESULT_SCHEMAS } from "../../src/serve/result-schemas.js";
import {
  STABLE_METHODS,
  STABLE_EVENTS,
  stabilityOf,
  provenanceOf,
  eventStabilityOf,
  eventProvenanceOf,
} from "../../src/serve/stability.js";
import { CONTRACT_VERSION, KNOWN_FINGERPRINTS } from "@sesame-kit/core/jsonrpc";

// ── shared fixtures ──────────────────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));

const committed = JSON.parse(
  readFileSync(resolve(HERE, "../../../../schema/openrpc.json"), "utf8"),
);

// Build once; all tests share the same read-only registry and doc.
const reg = buildRegistry();
const doc = buildOpenRpcDoc(reg, CONTRACT_VERSION);

const registeredMethods = new Set(reg.keys());

// Vocabulary constants (mirror provenance.test.js)
const PROVENANCE_VOCAB = ["local", "app-core", "unverified"];
const STABLE_PROVENANCE = ["local", "app-core"];

// openrpc-contract.test.js:116 の methodSetFingerprint と同一ロジック
function methodSetFingerprint(d) {
  const methods = d.methods.map((m) => m.name).sort();
  const topics = d["x-event-topics"] ?? [];
  const combined = JSON.stringify(methods) + JSON.stringify(topics);
  return createHash("sha256").update(combined).digest("hex").slice(0, 16);
}

// contract-fingerprint.test.js:31 の computeFingerprint と同一ロジック
function computeRegistryFingerprint(registry) {
  const methods = [...registry.keys()].sort().join(",");
  return createHash("sha256").update(methods).digest("hex").slice(0, 16);
}

// openrpc-contract.test.js:18-43 と同一
function machineContract(d) {
  const param = (p) => ({ name: p.name, required: p.required, schema: p.schema });
  return {
    openrpc: d.openrpc,
    info: {
      title: d.info.title,
      version: d.info.version,
      "x-apiVersion": d.info["x-apiVersion"],
      "x-contractVersion": d.info["x-contractVersion"],
    },
    methods: d.methods.map((m) => ({
      name: m.name,
      params: (m.params || []).map(param),
      result: m.result?.schema ? { ...m.result.schema, description: undefined } : undefined,
      "x-stability": m["x-stability"],
      "x-provenance": m["x-provenance"],
    })),
    events: d["x-events"].map((e) => ({
      name: e.name,
      "x-stability": e["x-stability"],
      "x-provenance": e["x-provenance"],
    })),
    eventTopics: d["x-event-topics"],
  };
}

// openrpc-contract.test.js:106-109 の既知フィンガープリント (method+topics hash)
const OPENRPC_KNOWN_FINGERPRINTS = {
  "1.3.0": "d19ad7b056be728e",
  "1.4.0": "64ea81ba7ced77e0",
};

// ---------------------------------------------------------------------------
// CTR-0001: openrpc ↔ registry のメソッド集合が 1:1 (205) で完全一致する
// ---------------------------------------------------------------------------

describe("[CTR-0001] openrpc↔registry↔proto↔grpc-map のメソッド集合が 1:1 (205) で完全一致する", () => {
  it("[CTR-0001] buildRegistry() のキー集合が schema/openrpc.json の methods 名集合と一致する", () => {
    const committedNames = new Set(committed.methods.map((m) => m.name));

    for (const name of registeredMethods) {
      expect(committedNames.has(name), `registry メソッド "${name}" が openrpc.json に存在しない`).toBe(true);
    }
    for (const name of committedNames) {
      expect(registeredMethods.has(name), `openrpc.json メソッド "${name}" が registry に存在しない`).toBe(true);
    }
    expect(registeredMethods.size).toBe(205);
    expect(committedNames.size).toBe(205);
  });

  it("[CTR-0001] events.* 2 op を除いた 203 op が grpc-methods.generated.json のエントリ数と一致する", () => {
    const mapPath = resolve(HERE, "../../src/serve/grpc-methods.generated.json");
    const nameMap = JSON.parse(readFileSync(mapPath, "utf8"));

    const nonEventCount = [...registeredMethods].filter((n) => !n.startsWith("events.")).length;
    expect(nonEventCount).toBe(203);
    expect(Object.keys(nameMap).length).toBe(203);
  });
});

// ---------------------------------------------------------------------------
// CTR-0002: rpc.discover が自身を含む全公開面を自己記述する
// ---------------------------------------------------------------------------

describe("[CTR-0002] rpc.discover が自身を含む全公開面を自己記述し、reg 経由でなく daemon が直接応答する", () => {
  it("[CTR-0002] rpc.discover が registry に stable/local の 1 エントリとして存在する", () => {
    expect(registeredMethods.has("rpc.discover")).toBe(true);
    expect(stabilityOf("rpc.discover")).toBe("stable");
    expect(provenanceOf("rpc.discover")).toBe("local");
    // committed openrpc.json の rpc.discover エントリも確認
    const discover = committed.methods.find((m) => m.name === "rpc.discover");
    expect(discover).toBeTruthy();
    expect(discover["x-stability"]).toBe("stable");
    expect(discover["x-provenance"]).toBe("local");
  });

  it("[CTR-0002] buildOpenRpcDoc の応答 doc が rpc.discover 自身を含む 205 メソッドを網羅する", () => {
    const discover = doc.methods.find((m) => m.name === "rpc.discover");
    expect(discover).toBeTruthy();
    expect(doc.methods.length).toBe(205);
  });

  it("[CTR-0002] buildOpenRpcDoc の応答 doc が 4 x-events と 3 x-event-topics を網羅する", () => {
    expect(Array.isArray(doc["x-events"])).toBe(true);
    expect(doc["x-events"].length).toBe(4);
    expect(Array.isArray(doc["x-event-topics"])).toBe(true);
    expect(doc["x-event-topics"].length).toBe(3);
  });

  it("[CTR-0002] daemon.js は rpc.discover を method === 'rpc.discover' の分岐で openRpcDocument() に直接委譲する (ソース確認)", () => {
    const daemonSrc = readFileSync(resolve(HERE, "../../src/serve/daemon.js"), "utf8");
    expect(daemonSrc).toMatch(/method\s*===\s*["']rpc\.discover["']/);
    expect(daemonSrc).toMatch(/openRpcDocument\(\)/);
  });

  it("[CTR-0002] 他の rpc.* は METHOD_NOT_FOUND + NOT_IMPLEMENTED を投げる (fail-closed — ソース確認)", () => {
    const daemonSrc = readFileSync(resolve(HERE, "../../src/serve/daemon.js"), "utf8");
    expect(daemonSrc).toMatch(/startsWith\(['"]rpc\.['"]\)/);
    expect(daemonSrc).toMatch(/METHOD_NOT_FOUND/);
    expect(daemonSrc).toMatch(/NOT_IMPLEMENTED|not_implemented/);
  });
});

// ---------------------------------------------------------------------------
// CTR-0003: 各 NAMESPACE_OPS が registry へ 1:1 自動公開される (7 ns)
// ---------------------------------------------------------------------------

describe("[CTR-0003] 各 NAMESPACE_OPS が公開 op の単一真実源として registry へ 1:1 自動公開される (7 ns)", () => {
  it("[CTR-0003] NS_MODULES の 7 モジュールがすべて registry に公開される", () => {
    const expectedNs = ["schedule", "org", "company", "payment", "access", "iot", "presetir"];
    expect(NAMESPACE_MODULE_KEYS).toHaveLength(7);
    for (const ns of expectedNs) {
      expect([...NAMESPACE_MODULE_KEYS]).toContain(ns);
    }
  });

  it("[CTR-0003] schedule NAMESPACE_OPS の 2 op が registry に存在する", () => {
    expect(registeredMethods.has("schedule.getScheduleList")).toBe(true);
    expect(registeredMethods.has("schedule.cancelSchedule")).toBe(true);
  });

  it("[CTR-0003] org NAMESPACE_OPS の 34 op が registry に存在する", () => {
    const orgOps = [
      "getEmployees", "getCurrentUserInfo", "addEmployees", "updateEmployee",
      "removeEmployees", "reorderEmployees", "queryByCS", "confirmQueryByCS",
      "getEmployeeGroups", "addEmployeeGroup", "updateEmployeeGroup", "removeEmployeeGroups",
      "getEmployeeGroupBindDeviceGroup", "addEmployeeInGroup", "removeEmployeeInGroup",
      "removeEmployeeGroupBindDeviceGroup", "getTags", "postTag", "removeTag",
      "getDeviceGroups", "addDeviceGroup", "updateDeviceGroup", "removeDeviceGroups",
      "addDeviceInGroup", "removeDeviceInGroup", "getDeviceGroupBindUserGroup",
      "removeDeviceGroupBindUserGroup", "shareDeviceKeysToEmployees",
      "shareDeviceGroupKeysToEmployeeGroup", "getEmployeeDeviceKeys", "removeEmployeeDeviceKey",
      "updateGuestKeyTag", "generateGuestQR", "getDeviceEmployeeKeys",
    ];
    expect(orgOps).toHaveLength(34);
    for (const op of orgOps) {
      expect(registeredMethods.has(`org.${op}`), `org.${op} が registry に存在しない`).toBe(true);
    }
  });

  it("[CTR-0003] payment NAMESPACE_OPS の 6 op が registry に存在する", () => {
    const paymentOps = [
      "getPaymentMethods", "getClientSecret", "changeDefaultPayment",
      "removePayment", "payUpdateLevel", "getDevApiInfo",
    ];
    expect(paymentOps).toHaveLength(6);
    for (const op of paymentOps) {
      expect(registeredMethods.has(`payment.${op}`), `payment.${op} が registry に存在しない`).toBe(true);
    }
  });

  it("[CTR-0003] access NAMESPACE_OPS の 11 op が registry に存在する", () => {
    const accessOps = [
      "getCards", "getPasscodes", "postCards", "postPasscodes",
      "delCards", "delPasscodes", "clearCards", "clearPasscodes",
      "updateCardName", "updatePasscodeName", "updateCardOwner",
    ];
    expect(accessOps).toHaveLength(11);
    for (const op of accessOps) {
      expect(registeredMethods.has(`access.${op}`), `access.${op} が registry に存在しない`).toBe(true);
    }
  });

  it("[CTR-0003] iot.* の op が registry に 10 件存在する", () => {
    const iotKeys = [...registeredMethods].filter((k) => k.startsWith("iot."));
    expect(iotKeys).toHaveLength(10);
  });

  it("[CTR-0003] presetir NAMESPACE_OPS の 3 op が registry に存在する", () => {
    expect(registeredMethods.has("presetir.sendIR")).toBe(true);
    expect(registeredMethods.has("presetir.emitAir")).toBe(true);
    expect(registeredMethods.has("presetir.emitButton")).toBe(true);
    const presetirKeys = [...registeredMethods].filter((k) => k.startsWith("presetir."));
    expect(presetirKeys).toHaveLength(3);
  });

  it("[CTR-0003] NAMESPACE_OPS の計 70 op が registry に存在し、捏造/欠落ゼロ (単一真実源)", () => {
    const nsKeys = ["schedule", "org", "company", "payment", "access", "iot", "presetir"];
    let total = 0;
    for (const ns of nsKeys) {
      const nsOps = [...registeredMethods].filter((k) => k.startsWith(`${ns}.`));
      total += nsOps.length;
    }
    expect(total).toBe(70);
  });
});

// ---------------------------------------------------------------------------
// CTR-0004: NAMESPACE_MODULE_KEYS が registry/param生成/proto生成で同一集合を駆動
// ---------------------------------------------------------------------------

describe("[CTR-0004] NAMESPACE_MODULE_KEYS が registry/param生成/proto生成で同一集合を駆動する (payment 脱落再発防止)", () => {
  it("[CTR-0004] NAMESPACE_MODULE_KEYS は 7 key で payment を含む", () => {
    const keys = [...NAMESPACE_MODULE_KEYS];
    expect(keys.length).toBe(7);
    expect(keys).toContain("payment");
    const expected = ["schedule", "org", "company", "payment", "access", "iot", "presetir"];
    for (const ns of expected) {
      expect(keys).toContain(ns);
    }
  });

  it("[CTR-0004] NAMESPACE_MODULE_KEYS は Object.freeze で凍結されている", () => {
    expect(Object.isFrozen(NAMESPACE_MODULE_KEYS)).toBe(true);
  });

  it("[CTR-0004] 全 ns(payment 含む)が registry に少なくとも 1 op を持つ (生成対象から脱落していない)", () => {
    for (const ns of NAMESPACE_MODULE_KEYS) {
      const nsOps = [...registeredMethods].filter((k) => k.startsWith(`${ns}.`));
      expect(nsOps.length, `${ns} の op が registry にない (param 生成対象から脱落している可能性)`).toBeGreaterThanOrEqual(1);
    }
  });

  it("[CTR-0004] gen-rpc-schema.mjs が NAMESPACE_MODULE_KEYS を registry.js から import する (ソース確認)", () => {
    const src = readFileSync(resolve(HERE, "../../../../scripts/gen-rpc-schema.mjs"), "utf8");
    expect(src).toContain("NAMESPACE_MODULE_KEYS");
    expect(src).toMatch(/registry/);
  });
});

// ---------------------------------------------------------------------------
// CTR-0005: 公開メソッド集合フィンガープリント ↔ CONTRACT_VERSION の 1:1 連動
// ---------------------------------------------------------------------------

describe("[CTR-0005] 公開メソッド集合フィンガープリント ↔ CONTRACT_VERSION 1:1 連動 (規範7)", () => {
  it("[CTR-0005] CONTRACT_VERSION(1.4.0) が KNOWN_FINGERPRINTS に登録されている", () => {
    expect(CONTRACT_VERSION).toBe("1.4.0");
    expect(Object.hasOwn(KNOWN_FINGERPRINTS, CONTRACT_VERSION)).toBe(true);
  });

  it("[CTR-0005] buildRegistry().keys() ソート連結の SHA-256 下位 64bit が KNOWN_FINGERPRINTS[CONTRACT_VERSION] と一致する", () => {
    const actual = computeRegistryFingerprint(reg);
    const expected = KNOWN_FINGERPRINTS[CONTRACT_VERSION]; // "28fc802bc1720a77"
    expect(expected).toBeDefined();
    expect(actual).toBe(expected);
  });

  it("[CTR-0005] フィンガープリントが決定論的 (同一 registry で 2 回呼んでも同じ値)", () => {
    const h1 = computeRegistryFingerprint(reg);
    const h2 = computeRegistryFingerprint(reg);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(16);
  });
});

// ---------------------------------------------------------------------------
// CTR-0006: メソッド集合 + x-event-topics フィンガープリントと committed openrpc.json の一致
// ---------------------------------------------------------------------------

describe("[CTR-0006] メソッド集合 + x-event-topics フィンガープリント ↔ CONTRACT_VERSION (64ea81ba7ced77e0)", () => {
  it("[CTR-0006] 現 CONTRACT_VERSION が openrpc-level KNOWN_FINGERPRINTS に登録されている", () => {
    expect(Object.hasOwn(OPENRPC_KNOWN_FINGERPRINTS, CONTRACT_VERSION)).toBe(true);
  });

  it("[CTR-0006] live レジストリの method+topics hash が CONTRACT_VERSION の登録値 (64ea81ba7ced77e0) と一致する", () => {
    const fp = methodSetFingerprint(doc);
    const expected = OPENRPC_KNOWN_FINGERPRINTS[CONTRACT_VERSION];
    expect(fp).toBe(expected);
  });

  it("[CTR-0006] committed openrpc.json のフィンガープリントも CONTRACT_VERSION 登録値と一致する (build 済み確認)", () => {
    const fp = methodSetFingerprint(committed);
    const expected = OPENRPC_KNOWN_FINGERPRINTS[CONTRACT_VERSION];
    expect(fp).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// CTR-0007: CONTRACT_VERSION が openrpc info の 3 フィールドに同一刻印される
// ---------------------------------------------------------------------------

describe("[CTR-0007] CONTRACT_VERSION が openrpc info の x-apiVersion / x-contractVersion / info.version に同一刻印", () => {
  it("[CTR-0007] committed openrpc.json の info.version / x-apiVersion が CONTRACT_VERSION(1.4.0)", () => {
    expect(committed.info.version).toBe(CONTRACT_VERSION);
    expect(committed.info["x-apiVersion"]).toBe(CONTRACT_VERSION);
  });

  it("[CTR-0007] buildOpenRpcDoc の info.version === CONTRACT_VERSION", () => {
    expect(doc.info.version).toBe(CONTRACT_VERSION);
  });

  it("[CTR-0007] buildOpenRpcDoc の info['x-apiVersion'] === CONTRACT_VERSION", () => {
    expect(doc.info["x-apiVersion"]).toBe(CONTRACT_VERSION);
  });

  it("[CTR-0007] buildOpenRpcDoc の info['x-contractVersion'] === CONTRACT_VERSION", () => {
    expect(doc.info["x-contractVersion"]).toBe(CONTRACT_VERSION);
  });

  it("[CTR-0007] 3 フィールドが互いに同一値 (x-contractVersion === x-apiVersion === info.version)", () => {
    expect(doc.info["x-contractVersion"]).toBe(doc.info["x-apiVersion"]);
    expect(doc.info["x-apiVersion"]).toBe(doc.info.version);
  });
});

// ---------------------------------------------------------------------------
// CTR-0008: openrpc.json 機械契約射影が実装と双方向一致
// ---------------------------------------------------------------------------

describe("[CTR-0008] openrpc.json 機械契約射影が実装と双方向一致し全 method/event が tier/provenance を持つ", () => {
  it("[CTR-0008] committed schema/openrpc.json の機械射影が live buildOpenRpcDoc と一致する (散文/locale 除外)", () => {
    expect(machineContract(committed)).toEqual(machineContract(doc));
  });

  it("[CTR-0008] 全 method が x-stability と string な x-provenance を持つ (公開契約の完全性)", () => {
    for (const m of committed.methods) {
      expect(["stable", "experimental"]).toContain(m["x-stability"]);
      expect(typeof m["x-provenance"]).toBe("string");
    }
  });

  it("[CTR-0008] 全 x-events が x-stability と x-provenance を持つ", () => {
    for (const e of committed["x-events"]) {
      expect(["stable", "experimental"]).toContain(e["x-stability"]);
      expect(typeof e["x-provenance"]).toBe("string");
    }
  });

  it("[CTR-0008] x-event-topics が 3 件存在する", () => {
    expect(committed["x-event-topics"]).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// CTR-0009: buildOpenRpcDoc が全 method/event に x-stability/x-provenance を付与する
// ---------------------------------------------------------------------------

describe("[CTR-0009] buildOpenRpcDoc が全 method/event に x-stability/x-provenance を付与する", () => {
  it("[CTR-0009] 全 method の x-stability が {stable,experimental} のいずれか", () => {
    for (const m of doc.methods) {
      expect(["stable", "experimental"], `method "${m.name}" の x-stability が不正`).toContain(m["x-stability"]);
    }
  });

  it("[CTR-0009] 全 method の x-provenance が string", () => {
    for (const m of doc.methods) {
      expect(typeof m["x-provenance"], `method "${m.name}" の x-provenance が string でない`).toBe("string");
    }
  });

  it("[CTR-0009] 全 x-events の x-stability が {stable,experimental} のいずれか", () => {
    for (const e of doc["x-events"]) {
      expect(["stable", "experimental"], `event "${e.name}" の x-stability が不正`).toContain(e["x-stability"]);
    }
  });

  it("[CTR-0009] 全 x-events の x-provenance が string", () => {
    for (const e of doc["x-events"]) {
      expect(typeof e["x-provenance"], `event "${e.name}" の x-provenance が string でない`).toBe("string");
    }
  });
});

// ---------------------------------------------------------------------------
// CTR-0010: result.schema — RESULT_SCHEMAS または fallback {type:object}
// ---------------------------------------------------------------------------

describe("[CTR-0010] buildOpenRpcDoc の result.schema は RESULT_SCHEMAS を載せ、未登録は {type:object} フォールバック", () => {
  it("[CTR-0010] RESULT_SCHEMAS に登録されたメソッドの result.schema にその型が射影される", () => {
    for (const m of doc.methods) {
      if (Object.hasOwn(RESULT_SCHEMAS, m.name)) {
        const expected = RESULT_SCHEMAS[m.name];
        expect(m.result?.schema?.type, `method "${m.name}" の result.schema.type が無い`).toBe(expected.type);
      }
    }
  });

  it("[CTR-0010] RESULT_SCHEMAS に無いメソッドの result.schema.type は 'object' にフォールバックする", () => {
    for (const m of doc.methods) {
      if (!Object.hasOwn(RESULT_SCHEMAS, m.name)) {
        expect(m.result?.schema?.type, `method "${m.name}" の fallback result.schema.type が 'object' でない`).toBe("object");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// CTR-0011: RESULT_SCHEMAS の全キーが registry 実メソッド (orphan スキーマ無し)
// ---------------------------------------------------------------------------

describe("[CTR-0011] RESULT_SCHEMAS の全キーが registry 実メソッド (orphan スキーマ無し)", () => {
  it("[CTR-0011] 全 RESULT_SCHEMAS キーは registry の実メソッド (orphan スキーマ無し)", () => {
    for (const name of Object.keys(RESULT_SCHEMAS)) {
      expect(registeredMethods.has(name), `RESULT_SCHEMAS["${name}"] に対応する registry メソッドが無い (orphan)`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// CTR-0012: 各 RESULT_SCHEMAS エントリが生成器解釈可能な JSON-Schema 形
// ---------------------------------------------------------------------------

describe("[CTR-0012] 各 RESULT_SCHEMAS エントリが生成器解釈可能な JSON-Schema 形 (type を持つ)", () => {
  it("[CTR-0012] 各スキーマ値が object で type ∈ {object,array,string,number,boolean}", () => {
    const VALID_TYPES = ["object", "array", "string", "number", "boolean"];
    for (const [name, schema] of Object.entries(RESULT_SCHEMAS)) {
      expect(schema && typeof schema === "object", `RESULT_SCHEMAS["${name}"] がオブジェクトでない`).toBe(true);
      expect(VALID_TYPES, `RESULT_SCHEMAS["${name}"].type が不正`).toContain(schema.type);
    }
  });

  it("[CTR-0012] status の result は {type:'object'} / devices.list は {type:'array'}", () => {
    expect(RESULT_SCHEMAS["status"].type).toBe("object");
    expect(RESULT_SCHEMAS["devices.list"].type).toBe("array");
  });
});

// ---------------------------------------------------------------------------
// CTR-0013: RESULT_SCHEMAS は Object.freeze で凍結
// ---------------------------------------------------------------------------

describe("[CTR-0013] RESULT_SCHEMAS は Object.freeze で凍結 (実行時の誤改変防止)", () => {
  it("[CTR-0013] Object.isFrozen(RESULT_SCHEMAS) === true", () => {
    expect(Object.isFrozen(RESULT_SCHEMAS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CTR-0014: STABLE_METHODS ⊆ RESULT_SCHEMAS (rpc.discover 除く)
// ---------------------------------------------------------------------------

describe("[CTR-0014] STABLE_METHODS ⊆ RESULT_SCHEMAS (rpc.discover 除く) — stable 昇格時のスキーマ漏れ検出", () => {
  it("[CTR-0014] STABLE_METHODS の全キー(rpc.discover 除く)に対応する RESULT_SCHEMAS エントリが存在する", () => {
    const schemaKeys = new Set(Object.keys(RESULT_SCHEMAS));
    const missing = Object.keys(STABLE_METHODS)
      .filter((name) => name !== "rpc.discover")
      .filter((name) => !schemaKeys.has(name));
    expect(
      missing,
      `RESULT_SCHEMAS に未登録の stable メソッド: ${missing.join(", ")} — SDK 戻り型が unknown に劣化する`,
    ).toEqual([]);
  });

  it("[CTR-0014] rpc.discover は RESULT_SCHEMAS から除外される (メタ API でスキーマ不要)", () => {
    expect(Object.keys(RESULT_SCHEMAS)).not.toContain("rpc.discover");
  });
});

// ---------------------------------------------------------------------------
// CTR-0015: STABLE_METHODS の全キーが registry 実メソッド
// ---------------------------------------------------------------------------

describe("[CTR-0015] STABLE_METHODS の全キーが registry 実メソッド (typo/rename による無言降格防止)", () => {
  it("[CTR-0015] STABLE_METHODS の全キーが registry に存在する", () => {
    const missing = Object.keys(STABLE_METHODS).filter((n) => !registeredMethods.has(n));
    expect(missing).toEqual([]);
  });

  it("[CTR-0015] stabilityOf は未登録メソッドを experimental にフォールバックする (降格穴の根拠確認)", () => {
    expect(stabilityOf("non.existent.method")).toBe("experimental");
  });
});

// ---------------------------------------------------------------------------
// CTR-0016: STABLE_EVENTS の全キーが広告イベント (x-events) に実在する
// ---------------------------------------------------------------------------

describe("[CTR-0016] STABLE_EVENTS の全キーが広告イベント (x-events) に実在する", () => {
  it("[CTR-0016] STABLE_EVENTS の全キーが buildOpenRpcDoc の x-events に実在する", () => {
    const eventNames = new Set(doc["x-events"].map((e) => e.name));
    const missing = Object.keys(STABLE_EVENTS).filter((n) => !eventNames.has(n));
    expect(missing).toEqual([]);
  });

  it("[CTR-0016] STABLE_EVENTS は 3 キー(event.lockState / event.deviceUpdate / event.ready)", () => {
    expect(Object.keys(STABLE_EVENTS)).toHaveLength(3);
    expect(STABLE_EVENTS).toHaveProperty("event.lockState");
    expect(STABLE_EVENTS).toHaveProperty("event.deviceUpdate");
    expect(STABLE_EVENTS).toHaveProperty("event.ready");
  });

  it("[CTR-0016] STABLE_EVENTS ⊆ x-events (event.deviceListChanged は experimental で STABLE_EVENTS 非掲載)", () => {
    expect(Object.keys(STABLE_EVENTS)).not.toContain("event.deviceListChanged");
    const eventNames = doc["x-events"].map((e) => e.name);
    expect(eventNames).toContain("event.deviceListChanged");
  });
});

// ---------------------------------------------------------------------------
// CTR-0017: 全 method の provenance が語彙 {local,app-core,unverified} 内
// ---------------------------------------------------------------------------

describe("[CTR-0017] 全 method の provenance が語彙 {local,app-core,unverified} 内", () => {
  it("[CTR-0017] registry 全メソッドの provenanceOf が PROVENANCE_VOCAB のいずれか", () => {
    for (const name of registeredMethods) {
      expect(PROVENANCE_VOCAB, `method "${name}" の provenance が語彙外`).toContain(provenanceOf(name));
    }
  });

  it("[CTR-0017] provenanceOf の未登録フォールバックは 'unverified'", () => {
    expect(provenanceOf("completely.unknown.method")).toBe("unverified");
  });
});

// ---------------------------------------------------------------------------
// CTR-0018: tier は provenance から導出 — stable⇔{local,app-core} / experimental⇔unverified
// ---------------------------------------------------------------------------

describe("[CTR-0018] tier は provenance から導出 — stable⇔{local,app-core} / experimental⇔unverified の双条件", () => {
  it("[CTR-0018] stable メソッドは provenance が {local,app-core}", () => {
    for (const name of registeredMethods) {
      if (stabilityOf(name) === "stable") {
        expect(STABLE_PROVENANCE, `stable method "${name}" の provenance が ${provenanceOf(name)}`).toContain(provenanceOf(name));
      }
    }
  });

  it("[CTR-0018] experimental メソッドは provenance が unverified", () => {
    for (const name of registeredMethods) {
      if (stabilityOf(name) === "experimental") {
        expect(provenanceOf(name), `experimental method "${name}" の provenance が unverified でない`).toBe("unverified");
      }
    }
  });

  it("[CTR-0018] STABLE_METHODS の全キーは stable かつ {local,app-core} provenance", () => {
    for (const [name, prov] of Object.entries(STABLE_METHODS)) {
      expect(stabilityOf(name)).toBe("stable");
      expect(STABLE_PROVENANCE).toContain(prov);
    }
  });

  it("[CTR-0018] STABLE_METHODS 非掲載メソッドは experimental かつ provenance=unverified", () => {
    const stableSet = new Set(Object.keys(STABLE_METHODS));
    for (const name of registeredMethods) {
      if (!stableSet.has(name)) {
        expect(stabilityOf(name)).toBe("experimental");
        expect(provenanceOf(name)).toBe("unverified");
      }
    }
  });
});
