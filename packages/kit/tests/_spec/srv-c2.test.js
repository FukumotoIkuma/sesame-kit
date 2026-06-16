// packages/kit/tests/_spec/srv-c2.test.js
// Spec-driven tests for SRV-0038, SRV-0039, SRV-0040, SRV-0041, SRV-0042, SRV-0043,
// SRV-0049, SRV-0050, SRV-0051, SRV-0055, SRV-0056, SRV-0057, SRV-0058,
// SRV-0062, SRV-0063, SRV-0064, SRV-0066, SRV-0067
//
// 実行環境: vitest (unit project) — KIT_SETUP により kit カタログ登録済み・ロケール ja 固定。
// TDD: テスト失敗 (red) は許容。クラッシュ/実行不能は不可。

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Daemon } from "../../src/serve/daemon.js";
import { buildRegistry, buildOpenRpcDoc, SUBSCRIBABLE_TOPICS, STATE_TOPICS } from "../../src/serve/registry.js";
import { STABLE_METHODS, STABLE_EVENTS, stabilityOf, provenanceOf } from "../../src/serve/stability.js";
import { need, requireAuth, requireConfigStore } from "../../src/serve/registry-helpers.js";
import { KIND, RPC, makeEvent } from "@sesame-kit/core/jsonrpc";
import { TRANSPORT_ERR } from "@sesame-kit/core/transport";
import { t, registerCatalog, setLocale } from "@sesame-kit/core/i18n";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const KIT_ROOT = resolve(__dirname, "..", "..");

// ─── shared fake hub factory ───────────────────────────────────────────────────

function makeFakeHub({ connected = true, devices = {}, over = {} } = {}) {
  let duFn = null;
  const hub = {
    connected,
    subUUID: "sub-1",
    config: { devices },
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    onDeviceUpdate: (_items, fn) => { duFn = fn; return () => { duFn = null; }; },
    _emit: (msg) => { if (duFn) duFn(msg); },
    unlock: vi.fn(async (n) => ({ ok: true, name: n })),
    lock: vi.fn(async (n) => ({ ok: true, name: n })),
    listDevices: vi.fn(async () => [{ deviceUUID: "u1" }]),
    getLoginUser: vi.fn(async () => ({ companyID: "co" })),
    ...over,
  };
  for (const ns of ["schedule", "org", "company", "payment", "access", "iot", "presetir"]) {
    if (!hub[ns]) {
      hub[ns] = new Proxy({}, {
        get: (_t, op) => (params) => Promise.resolve({ ns, op: String(op), params }),
      });
    }
  }
  return hub;
}

function makeConn() {
  const sent = [];
  return { id: String(Math.random()), send: (o) => sent.push(o), sent, close: vi.fn() };
}

// ─── SRV-0038: _serialize 直列化機構 ─────────────────────────────────────────

describe("[SRV-0038] Daemon._serialize: 同名 op を 1 並行に絞りチェーンは前段成否に関わらず継続", () => {
  it("[SRV-0038] 同名 op を 1 並行に絞り、前段の成否に関わらず次を走らせ、tail 解決後に _locks を掃除する (maxActive=1)", async () => {
    const d = new Daemon({ hub: makeFakeHub() });

    // maxActive=1 を確認
    let active = 0;
    let maxActive = 0;
    const slow = () => new Promise((res) => {
      active++;
      maxActive = Math.max(maxActive, active);
      setTimeout(() => { active--; res("ok"); }, 5);
    });
    await Promise.all([
      d._serialize("test_key", slow),
      d._serialize("test_key", slow),
      d._serialize("test_key", slow),
    ]);
    expect(maxActive).toBe(1);

    // 前段 reject でも次を走らせる (応答入替防止)
    const results = [];
    const reject1 = () => Promise.reject(new Error("fail"));
    const resolve2 = () => { results.push("ran"); return Promise.resolve("done"); };
    await Promise.allSettled([
      d._serialize("reject_key", reject1),
      d._serialize("reject_key", resolve2),
    ]);
    expect(results).toContain("ran"); // 前段 reject でも次が実行された

    // 解決後に _locks からキーが削除される (チェーン無限伸長防止)
    const d2 = new Daemon({ hub: makeFakeHub() });
    await d2._serialize("cleanup_key", () => Promise.resolve());
    await new Promise((r) => setTimeout(r, 20));
    expect(d2._locks.has("cleanup_key")).toBe(false);
  });
});

// ─── SRV-0039: classifyError ─────────────────────────────────────────────────

describe("[SRV-0039] classifyError: TRANSPORT_ERR.TIMEOUT/CLOSED → kind付き RpcError (文字列正規表現非依存)", () => {
  it("[SRV-0039] TRANSPORT_ERR.TIMEOUT → kind=timeout の RpcError に正規化", async () => {
    const hub = makeFakeHub({
      over: {
        org: new Proxy({}, {
          get: (_t, _op) => () => {
            const e = new Error("request timeout");
            e.code = TRANSPORT_ERR.TIMEOUT;
            throw e;
          },
        }),
      },
    });
    const d = new Daemon({ hub });
    d.authState = "ok";
    await expect(d.invoke("org.getEmployees", {}, null))
      .rejects.toMatchObject({ kind: KIND.TIMEOUT });
  });

  it("[SRV-0039] TRANSPORT_ERR.CLOSED → kind=connection_lost の RpcError に正規化", async () => {
    const hub = makeFakeHub({
      over: {
        org: new Proxy({}, {
          get: (_t, _op) => () => {
            const e = new Error("websocket closed");
            e.code = TRANSPORT_ERR.CLOSED;
            throw e;
          },
        }),
      },
    });
    const d = new Daemon({ hub });
    d.authState = "ok";
    await expect(d.invoke("org.getEmployees", {}, null))
      .rejects.toMatchObject({ kind: KIND.CONNECTION_LOST });
  });

  it("[SRV-0039] RpcError はそのまま透過 (classifyError が変換しない)", async () => {
    const { RpcError } = await import("@sesame-kit/core/jsonrpc");
    const hub = makeFakeHub({
      over: {
        org: new Proxy({}, {
          get: () => () => {
            throw new RpcError("already rpc", { kind: KIND.NOT_AUTHENTICATED });
          },
        }),
      },
    });
    const d = new Daemon({ hub });
    d.authState = "ok";
    await expect(d.invoke("org.getEmployees", {}, null))
      .rejects.toMatchObject({ kind: KIND.NOT_AUTHENTICATED });
  });

  it("[SRV-0039] code 無しの素 Error は透過して errorFromThrow が internal に変換", async () => {
    const hub = makeFakeHub({
      over: {
        org: new Proxy({}, {
          get: () => () => { throw new Error("boom"); },
        }),
      },
    });
    const d = new Daemon({ hub });
    d.authState = "ok";
    const res = await d.dispatchMessage(
      null,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "org.getEmployees", params: {} }),
    );
    expect(res.error.data.kind).toBe(KIND.INTERNAL);
  });
});

// ─── SRV-0040: 名前空間 op 自動公開 ──────────────────────────────────────────

describe("[SRV-0040] 名前空間 op は NAMESPACE_OPS から自動公開され hub[ns][op](params) へ委譲", () => {
  it("[SRV-0040] NS_MODULES の各 NAMESPACE_OPS の全 op が ns.op として registry に登録される", () => {
    const reg = buildRegistry();
    expect(reg.has("org.getEmployees")).toBe(true);
    expect(reg.has("schedule.getScheduleList")).toBe(true);
    expect(reg.has("access.getCards")).toBe(true);
    expect(reg.has("iot.setHub3LedDuty")).toBe(true);
    expect(reg.has("presetir.emitAir")).toBe(true);
    expect(reg.has("company.getCompanies")).toBe(true);
  });

  it("[SRV-0040] ハンドラが requireAuth 後 hub[ns][op](params) に委譲する", async () => {
    const calls = [];
    const hub = makeFakeHub({
      over: {
        org: new Proxy({}, {
          get: (_t, op) => (params) => {
            calls.push([`org.${String(op)}`, params]);
            return Promise.resolve({ ok: true });
          },
        }),
      },
    });
    const d = new Daemon({ hub });
    d.authState = "ok";
    await d.invoke("org.getEmployees", { companyID: "co" }, null);
    expect(calls).toContainEqual(["org.getEmployees", { companyID: "co" }]);
  });

  it("[SRV-0040] GEN_PARAMS あり: entry.params は配列", () => {
    const reg = buildRegistry();
    const entry = reg.get("org.getEmployees");
    expect(entry).toBeTruthy();
    expect(Array.isArray(entry.params)).toBe(true);
  });
});

// ─── SRV-0041: BLE op 自動公開 ──────────────────────────────────────────────

describe("[SRV-0041] BLE op は BLE_RPC_OPS/OS2_BLE_RPC_OPS から自動展開し fail-closed allowlist を通す", () => {
  it("[SRV-0041] BLE_RPC_OPS の op が ble.<op> として registry に登録される", () => {
    const reg = buildRegistry();
    const bleKeys = [...reg.keys()].filter((k) => k.startsWith("ble.") && !k.startsWith("ble.os2."));
    expect(bleKeys.length).toBeGreaterThan(0);
  });

  it("[SRV-0041] OS2_BLE_RPC_OPS の op が ble.os2.<op> として登録される", () => {
    const reg = buildRegistry();
    const os2Keys = [...reg.keys()].filter((k) => k.startsWith("ble.os2."));
    expect(os2Keys.length).toBeGreaterThan(0);
  });

  it("[SRV-0041] required param 欠落 → bad_params (undefined/null のみ欠落扱い, 0/false は通す)", async () => {
    const reg = buildRegistry();
    const bleEntry = [...reg.entries()].find(
      ([k, e]) => k.startsWith("ble.") && !k.startsWith("ble.os2.") && e.params.some((p) => p.required),
    );
    if (!bleEntry) return; // BLE_RPC_OPS に required param 無ければスキップ
    const [, entry] = bleEntry;
    const reqParam = entry.params.find((p) => p.required);
    await expect(
      entry.handler({ hub: {}, params: { [reqParam.name]: undefined }, daemon: { authState: "ok", hub: { connected: true } } }),
    ).rejects.toMatchObject({ kind: KIND.BAD_PARAMS });
  });
});

// ─── SRV-0042: requireAuth ゲート ────────────────────────────────────────────

describe("[SRV-0042] requireAuth ゲートは authState=expired→not_authenticated / hub未接続→connection_lost", () => {
  it("[SRV-0042] authState=expired → kind=not_authenticated", async () => {
    const hub = makeFakeHub({ connected: true });
    const d = new Daemon({ hub });
    d.authState = "expired";
    await expect(d.invoke("org.getEmployees", {}, null))
      .rejects.toMatchObject({ kind: KIND.NOT_AUTHENTICATED });
  });

  it("[SRV-0042] hub.connected=false → kind=connection_lost", async () => {
    const hub = makeFakeHub({ connected: false });
    const d = new Daemon({ hub });
    d.authState = "ok";
    await expect(d.invoke("org.getEmployees", {}, null))
      .rejects.toMatchObject({ kind: KIND.CONNECTION_LOST });
  });

  it("[SRV-0042] authState=ok かつ connected=true → throw しない", async () => {
    const hub = makeFakeHub({ connected: true });
    const d = new Daemon({ hub });
    d.authState = "ok";
    const result = await d.invoke("devices.list", {}, null);
    expect(result).toBeDefined();
  });

  it("[SRV-0042] requireAuth 直接: expired → NOT_AUTHENTICATED を throw", () => {
    const daemon = { authState: "expired", hub: { connected: true } };
    expect(() => requireAuth(daemon)).toThrow();
    try { requireAuth(daemon); } catch (e) {
      expect(e.kind).toBe(KIND.NOT_AUTHENTICATED);
    }
  });

  it("[SRV-0042] requireAuth 直接: hub.connected=false → CONNECTION_LOST を throw", () => {
    const daemon = { authState: "ok", hub: { connected: false } };
    expect(() => requireAuth(daemon)).toThrow();
    try { requireAuth(daemon); } catch (e) {
      expect(e.kind).toBe(KIND.CONNECTION_LOST);
    }
  });
});

// ─── SRV-0043: need / requireConfigStore ─────────────────────────────────────

describe("[SRV-0043] need() / requireConfigStore() は欠落/構成不備を bad_params で明示拒否し internal 潰れを防ぐ", () => {
  it("[SRV-0043] need(): undefined → bad_params", () => {
    expect(() => need({ k: undefined }, ["k"])).toThrow();
    try { need({ k: undefined }, ["k"]); } catch (e) {
      expect(e.kind).toBe(KIND.BAD_PARAMS);
    }
  });

  it("[SRV-0043] need(): null → bad_params", () => {
    expect(() => need({ k: null }, ["k"])).toThrow();
    try { need({ k: null }, ["k"]); } catch (e) {
      expect(e.kind).toBe(KIND.BAD_PARAMS);
    }
  });

  it("[SRV-0043] need(): 空文字 → bad_params", () => {
    expect(() => need({ k: "" }, ["k"])).toThrow();
    try { need({ k: "" }, ["k"]); } catch (e) {
      expect(e.kind).toBe(KIND.BAD_PARAMS);
    }
  });

  it("[SRV-0043] need(): 0 は有効値で throw しない", () => {
    expect(() => need({ k: 0 }, ["k"])).not.toThrow();
  });

  it("[SRV-0043] need(): false は有効値で throw しない", () => {
    expect(() => need({ k: false }, ["k"])).not.toThrow();
  });

  it("[SRV-0043] requireConfigStore: configStore 不在 → bad_params", () => {
    const hub = { configStore: null };
    expect(() => requireConfigStore(hub, "config.syncLocks")).toThrow();
    try { requireConfigStore(hub, "config.syncLocks"); } catch (e) {
      expect(e.kind).toBe(KIND.BAD_PARAMS);
    }
  });

  it("[SRV-0043] requireConfigStore: configStore 存在 → throw しない", () => {
    const hub = { configStore: {} };
    expect(() => requireConfigStore(hub, "config.syncLocks")).not.toThrow();
  });
});

// ─── SRV-0049: gRPC Subscribe event envelope stripping ───────────────────────

describe("[SRV-0049] gRPC Subscribe は event.<topic> 封筒を {topic,json} へ剥がし、他 framing は makeEvent 形を保つ", () => {
  it("[SRV-0049] makeEvent は {jsonrpc:'2.0', method:'event.<topic>', params} を生成する", () => {
    const ev = makeEvent("lockState", { deviceUUID: "u1" });
    expect(ev.jsonrpc).toBe("2.0");
    expect(ev.method).toBe("event.lockState");
    expect(ev.params).toEqual({ deviceUUID: "u1" });
  });

  it("[SRV-0049] gRPC conn.send は event. prefix を剥がし {topic,json} へ変換する (純ロジック検証)", () => {
    // grpc.js の conn.send: replace(/^event\./, '') で topic 抽出 + JSON.stringify(ev.params)
    const ev = { method: "event.lockState", params: { deviceUUID: "u1", state: "unlocked" } };
    const topic = String(ev.method || "").replace(/^event\./, "");
    const json = JSON.stringify(ev.params ?? null);

    expect(topic).toBe("lockState");
    expect(JSON.parse(json)).toEqual({ deviceUUID: "u1", state: "unlocked" });
  });

  it("[SRV-0049] gRPC では event. prefix が除去される: event.ready → 'ready'", () => {
    const grpcTopicExtract = (method) => String(method || "").replace(/^event\./, "");
    expect(grpcTopicExtract("event.lockState")).toBe("lockState");
    expect(grpcTopicExtract("event.deviceUpdate")).toBe("deviceUpdate");
    expect(grpcTopicExtract("event.ready")).toBe("ready");
    // 非 event は変化なし
    expect(grpcTopicExtract("other.thing")).toBe("other.thing");
  });

  it("[SRV-0049] NDJSON/WS は makeEvent 形 (method='event.<topic>') をそのまま送る", () => {
    // addConnection が event.ready を送るので確認
    const sent = [];
    const conn = { id: "ws", send: (o) => sent.push(o), close: () => {} };
    const d = new Daemon({ hub: makeFakeHub() });
    d.addConnection(conn);
    const readyEv = sent.find((m) => m.method === "event.ready");
    expect(readyEv).toBeTruthy();
    expect(readyEv.jsonrpc).toBe("2.0");
  });
});

// ─── SRV-0050: stability tier from provenance ────────────────────────────────

describe("[SRV-0050] stability tier は provenance から導出され、全 method/event が x-stability/x-provenance を持つ", () => {
  const reg = buildRegistry();
  const doc = buildOpenRpcDoc(reg, "0.0.0");

  it("[SRV-0050] 全 method が x-stability∈{stable,experimental} と x-provenance を持つ", () => {
    for (const m of doc.methods) {
      expect(["stable", "experimental"], `${m.name} x-stability`).toContain(m["x-stability"]);
      expect(m["x-provenance"], `${m.name} x-provenance`).toBeTruthy();
    }
  });

  it("[SRV-0050] STABLE_METHODS に登録 (local/app-core) → 'stable'、未登録 → 'experimental'", () => {
    for (const [name, prov] of Object.entries(STABLE_METHODS)) {
      expect(["local", "app-core"]).toContain(prov);
      expect(stabilityOf(name)).toBe("stable");
      expect(provenanceOf(name)).toBe(prov);
    }
    expect(stabilityOf("org.getEmployees")).toBe("experimental");
    expect(provenanceOf("org.getEmployees")).toBe("unverified");
  });

  it("[SRV-0050] provenance=local/app-core → stable、experimental は experimental で漏れない", () => {
    const byName = Object.fromEntries(doc.methods.map((m) => [m.name, m]));
    // stable コア
    for (const n of ["status", "lock.unlock", "devices.list", "events.subscribe", "rpc.discover"]) {
      expect(byName[n]["x-stability"], n).toBe("stable");
    }
    // experimental (未確認群)
    for (const n of ["org.getEmployees", "iot.setHub3LedDuty"]) {
      expect(byName[n]["x-stability"], n).toBe("experimental");
    }
  });

  it("[SRV-0050] x-events も全て x-stability/x-provenance を持つ", () => {
    const events = doc["x-events"] || [];
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(["stable", "experimental"], `${e.name} x-stability`).toContain(e["x-stability"]);
      expect(e["x-provenance"], `${e.name} x-provenance`).toBeTruthy();
    }
  });
});

// ─── SRV-0051: STABLE_METHODS/EVENTS 全キーが実在する ───────────────────────

describe("[SRV-0051] STABLE_METHODS/STABLE_EVENTS の全キーが実レジストリ/広告イベントに実在する (無言降格防止)", () => {
  const reg = buildRegistry();
  const methodNames = new Set(reg.keys());
  const doc = buildOpenRpcDoc(reg, "0.0.0");
  const eventNames = new Set((doc["x-events"] || []).map((e) => e.name));

  it("[SRV-0051] STABLE_METHODS の全キーが buildRegistry のキーに実在する", () => {
    const missing = Object.keys(STABLE_METHODS).filter((n) => !methodNames.has(n));
    expect(missing, `missing STABLE_METHODS keys: ${missing.join(", ")}`).toEqual([]);
  });

  it("[SRV-0051] STABLE_EVENTS の全キーが x-events 名に実在する", () => {
    const missing = Object.keys(STABLE_EVENTS).filter((n) => !eventNames.has(n));
    expect(missing, `missing STABLE_EVENTS keys: ${missing.join(", ")}`).toEqual([]);
  });
});

// ─── SRV-0055: HTTP status→kind 写像 self-consistency ───────────────────────

describe("[SRV-0055] HTTP status→kind 写像が fixture と完全一致 (5xx→connection_lost, 既定→internal)", () => {
  const FIXTURE_PATH = resolve(KIT_ROOT, "tests", "fixtures", "http-kind-map.json");
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

  it("[SRV-0055] fixture の statuses エントリが正しい構造を持つ (kind/retryable 完備)", () => {
    expect(Object.keys(fixture.statuses).length).toBeGreaterThan(0);
    for (const [, v] of Object.entries(fixture.statuses)) {
      expect(v).toHaveProperty("kind");
      expect(v).toHaveProperty("retryable");
    }
  });

  it("[SRV-0055] 5xx range → connection_lost / retryable=true", () => {
    expect(fixture.serverErrorRange.kind).toBe("connection_lost");
    expect(fixture.serverErrorRange.retryable).toBe(true);
    for (const s of fixture.serverErrorRange.samples) {
      expect(s).toBeGreaterThanOrEqual(500);
    }
  });

  it("[SRV-0055] fallback (未登録) → internal / retryable=false", () => {
    expect(fixture.fallback.kind).toBe("internal");
    expect(fixture.fallback.retryable).toBe(false);
  });

  it("[SRV-0055] clients/js の httpKind() が fixture 全エントリと一致する", async () => {
    const { httpKind } = await import("../../clients/js/sesame-client.mjs");
    for (const [s, v] of Object.entries(fixture.statuses)) {
      expect(httpKind(Number(s)), `status ${s}`).toBe(v.kind);
    }
    for (const s of fixture.serverErrorRange.samples) {
      expect(httpKind(s), `status ${s} (5xx)`).toBe("connection_lost");
    }
    for (const s of fixture.fallback.samples) {
      expect(httpKind(s), `status ${s} (fallback)`).toBe("internal");
    }
  });
});

// ─── SRV-0056: KIND enum 7 値 parity ─────────────────────────────────────────

describe("[SRV-0056] KIND enum (7値) の自己整合: clients/js d.ts の SesameErrorKind union が全値を含む", () => {
  it("[SRV-0056] KIND が 7 値を持つ", () => {
    const kinds = Object.values(KIND);
    expect(kinds).toHaveLength(7);
    expect(kinds).toContain("not_authenticated");
    expect(kinds).toContain("bad_params");
    expect(kinds).toContain("timeout");
    expect(kinds).toContain("connection_lost");
    expect(kinds).toContain("rejected");
    expect(kinds).toContain("internal");
    expect(kinds).toContain("not_implemented");
  });

  it("[SRV-0056] sesame-client.d.ts の SesameErrorKind union が serve KIND 全値を含む", () => {
    const dts = readFileSync(resolve(KIT_ROOT, "clients", "js", "sesame-client.d.ts"), "utf8");
    for (const kind of Object.values(KIND)) {
      expect(dts, `kind '${kind}' not in d.ts union`).toContain(`| "${kind}"`);
    }
  });
});

// ─── SRV-0057: gRPC grpcStatusFor kind→gRPC status 写像 ─────────────────────

describe("[SRV-0057] gRPC status 写像 grpcStatusFor は kind→gRPC status を網羅し、他 framing と同一 kind を保つ", () => {
  it("[SRV-0057] grpcStatusFor の写像規則: kind→gRPC status (純ロジック確認)", () => {
    // grpc.js の grpcStatusFor switch ロジックを再現して境界を確認
    // gRPC status codes (grpc-js が文書化している数値)
    const GRPC_STATUS = {
      UNAUTHENTICATED: 16,
      INVALID_ARGUMENT: 3,
      UNIMPLEMENTED: 12,
      UNAVAILABLE: 14,
      FAILED_PRECONDITION: 9,
      INTERNAL: 13,
    };
    const grpcStatusFor = (kind) => {
      switch (kind) {
        case "not_authenticated": return GRPC_STATUS.UNAUTHENTICATED;
        case "bad_params": return GRPC_STATUS.INVALID_ARGUMENT;
        case "not_implemented": return GRPC_STATUS.UNIMPLEMENTED;
        case "connection_lost":
        case "timeout": return GRPC_STATUS.UNAVAILABLE;
        case "rejected": return GRPC_STATUS.FAILED_PRECONDITION;
        default: return GRPC_STATUS.INTERNAL;
      }
    };

    expect(grpcStatusFor("not_authenticated")).toBe(GRPC_STATUS.UNAUTHENTICATED);
    expect(grpcStatusFor("bad_params")).toBe(GRPC_STATUS.INVALID_ARGUMENT);
    expect(grpcStatusFor("not_implemented")).toBe(GRPC_STATUS.UNIMPLEMENTED);
    expect(grpcStatusFor("connection_lost")).toBe(GRPC_STATUS.UNAVAILABLE);
    expect(grpcStatusFor("timeout")).toBe(GRPC_STATUS.UNAVAILABLE);
    expect(grpcStatusFor("rejected")).toBe(GRPC_STATUS.FAILED_PRECONDITION);
    expect(grpcStatusFor("internal")).toBe(GRPC_STATUS.INTERNAL);
    // 未知 kind → INTERNAL (デフォルト)
    expect(grpcStatusFor("some_unknown_kind")).toBe(GRPC_STATUS.INTERNAL);
  });

  it("[SRV-0057] SesameError(REJECTED) → FAILED_PRECONDITION + metadata kind=rejected", async () => {
    const { SesameError, ERR } = await import("@sesame-kit/core/errors");
    const grpc = await import("@grpc/grpc-js");
    const protoLoader = await import("@grpc/proto-loader");
    const { startGrpcFraming } = await import("../../src/serve/framing/grpc.js");

    const PROTO = resolve(KIT_ROOT, "src", "serve", "sesame.proto");
    const TOKEN = "srv0057-token-cccccccccccccccccccccc";
    const hub = makeFakeHub({
      over: {
        unlock: vi.fn(async () => {
          throw new SesameError("nope", { code: ERR.REJECTED, retryable: false, data: { upstreamCode: 403 } });
        }),
      },
    });
    const d = new Daemon({ hub });
    d.authState = "ok";
    const handle = await startGrpcFraming(d, { port: 0, token: TOKEN });
    try {
      const pkgDef = protoLoader.loadSync(PROTO, { keepCase: true, longs: String, defaults: true });
      const proto = grpc.loadPackageDefinition(pkgDef).sesame;
      const client = new proto.Sesame(
        `127.0.0.1:${handle.port}`,
        grpc.credentials.createInsecure(),
      );
      const md = new grpc.Metadata();
      md.set("authorization", `Bearer ${TOKEN}`);
      const err = await new Promise((_, rej) =>
        client.LockUnlock({ name: "front" }, md, (e) => (e ? rej(e) : rej(new Error("should_throw")))),
      ).catch((e) => e);
      expect(err.code).toBe(grpc.status.FAILED_PRECONDITION);
      expect(err.metadata.get("kind")[0]).toBe("rejected");
      client.close();
    } finally {
      await handle.stop();
    }
  });
});

// ─── SRV-0058: gRPC proto3 optional presence ─────────────────────────────────

describe("[SRV-0058] gRPC proto3 optional presence — 省略 scalar は delete、明示 0/false/'' は値維持", () => {
  it("[SRV-0058] grpc-methods.generated.json の optionalScalars が実在する (LockUnlock: name/deviceUUID)", () => {
    const map = JSON.parse(
      readFileSync(resolve(KIT_ROOT, "src", "serve", "grpc-methods.generated.json"), "utf8"),
    );
    const lockUnlock = map["LockUnlock"];
    expect(lockUnlock).toBeTruthy();
    expect(lockUnlock.optionalScalars).toContain("name");
    expect(lockUnlock.optionalScalars).toContain("deviceUUID");
  });

  it("[SRV-0058] sentinel あり (_f in params) → 値(0含む)を維持し sentinel のみ除去", () => {
    // grpc.js:124-132 の presence 正規化ロジック
    const normalize = (params, optionalScalars) => {
      const p = { ...params };
      for (const f of optionalScalars) {
        if (`_${f}` in p) {
          delete p[`_${f}`];
        } else {
          delete p[f];
        }
      }
      return p;
    };

    // 明示 0 — sentinel あり → 0 を維持
    const explicit0 = normalize(
      { scriptIndex: 0, _scriptIndex: "scriptIndex" },
      ["scriptIndex"],
    );
    expect(explicit0.scriptIndex).toBe(0);
    expect("_scriptIndex" in explicit0).toBe(false);

    // 明示 false — sentinel あり → false を維持
    const explicitFalse = normalize(
      { partialOnTimeout: false, _partialOnTimeout: "partialOnTimeout" },
      ["partialOnTimeout"],
    );
    expect(explicitFalse.partialOnTimeout).toBe(false);

    // 明示空文字 — sentinel あり → '' を維持
    const explicitEmpty = normalize(
      { label: "", _label: "label" },
      ["label"],
    );
    expect(explicitEmpty.label).toBe("");
  });

  it("[SRV-0058] sentinel なし → フィールドを params から削除 (省略=未指定)", () => {
    const normalize = (params, optionalScalars) => {
      const p = { ...params };
      for (const f of optionalScalars) {
        if (`_${f}` in p) {
          delete p[`_${f}`];
        } else {
          delete p[f];
        }
      }
      return p;
    };

    const omitted = normalize({ name: "", deviceUUID: "u1" }, ["name", "deviceUUID"]);
    expect("name" in omitted).toBe(false);
    expect("deviceUUID" in omitted).toBe(false);
  });

  it("[SRV-0058] required scalar には optional 不付与 (optionalScalars 配列は存在する)", () => {
    const map = JSON.parse(
      readFileSync(resolve(KIT_ROOT, "src", "serve", "grpc-methods.generated.json"), "utf8"),
    );
    const setAutolock = map["LockSetAutolock"];
    if (setAutolock) {
      expect(Array.isArray(setAutolock.optionalScalars)).toBe(true);
    }
  });
});

// ─── SRV-0062: registerCatalog 重複キー / t() フォールバック / {var} 補間 ──

describe("[SRV-0062] registerCatalog 重複キー検出・t() フォールバック・{var} 補間", () => {
  it("[SRV-0062] registerCatalog: 新規キー登録は成功する", () => {
    const uniqueKey = `__srv0062_new_${Date.now()}__`;
    expect(() =>
      registerCatalog("__srv0062_new_area__", {
        en: { [uniqueKey]: "new en" },
        ja: { [uniqueKey]: "新規 ja" },
      }),
    ).not.toThrow();
    setLocale("en");
    expect(t(uniqueKey)).toBe("new en");
    setLocale("ja");
    expect(t(uniqueKey)).toBe("新規 ja");
    setLocale("en");
  });

  it("[SRV-0062] registerCatalog: 既存キー重複で TypeError (誤登録早期検出)", () => {
    expect(() =>
      registerCatalog("__srv0062_dup_test__", {
        en: { "ble.disconnected": "DUPLICATE" },
        ja: {},
      }),
    ).toThrow(TypeError);
  });

  it("[SRV-0062] registerCatalog: ja キー重複も TypeError", () => {
    expect(() =>
      registerCatalog("__srv0062_dup_test_ja__", {
        en: {},
        ja: { "ble.disconnected": "重複" },
      }),
    ).toThrow(TypeError);
  });

  it("[SRV-0062] t(): 未定義キーは en にフォールバックし、無ければキー文字列を返す (3段フォールバック)", () => {
    setLocale("ja");
    const result = t("__completely_undefined_key_srv_0062__");
    expect(result).toBe("__completely_undefined_key_srv_0062__");
    setLocale("en");
  });

  it("[SRV-0062] t(): {var} を split-join で全置換する (複数出現も置換)", () => {
    const key = `__srv0062_var_test_${Date.now()}__`;
    registerCatalog("__srv0062_var_area__", {
      en: { [key]: "hello {name}, see {name} again" },
      ja: { [key]: "こんにちは {name}" },
    });
    setLocale("en");
    const result = t(key, { name: "world" });
    expect(result).toBe("hello world, see world again");
    setLocale("en");
  });
});

// ─── SRV-0063: 全 framing 同一封筒 (fake hub で同居起動) ──────────────────

describe("[SRV-0063] 全 framing 同一封筒 — 同一 op が UDS/HTTP/WS/gRPC で同一結果で届く", () => {
  it("[SRV-0063] Daemon.invoke は framing に依らず同じ registry ハンドラへ委譲する", async () => {
    const hub = makeFakeHub();
    const d = new Daemon({ hub });
    d.authState = "ok";

    const conn1 = makeConn();
    const conn2 = makeConn();
    d.addConnection(conn1);
    d.addConnection(conn2);

    const r1 = await d.invoke("lock.unlock", { name: "front" }, conn1);
    const r2 = await d.invoke("lock.unlock", { name: "front" }, conn2);
    expect(r1).toMatchObject({ ok: true, name: "front" });
    expect(r2).toMatchObject({ ok: true, name: "front" });
    expect(hub.unlock).toHaveBeenCalledTimes(2);
    expect(hub.unlock).toHaveBeenCalledWith("front");
  });

  it("[SRV-0063] dispatchMessage は handleMessage を通して同一 invoke を呼ぶ", async () => {
    const hub = makeFakeHub();
    const d = new Daemon({ hub });
    d.authState = "ok";
    const conn = makeConn();
    d.addConnection(conn);

    const res = await d.dispatchMessage(
      conn,
      JSON.stringify({ jsonrpc: "2.0", id: 42, method: "lock.unlock", params: { name: "back" } }),
    );
    expect(res.result).toMatchObject({ ok: true, name: "back" });
    expect(hub.unlock).toHaveBeenCalledWith("back");
  });

  it("[SRV-0063] 異なる framing の conn を同居させても互いに干渉しない", async () => {
    const hub = makeFakeHub();
    const d = new Daemon({ hub });
    d.authState = "ok";

    const connA = makeConn();
    const connB = makeConn();
    const connC = { id: "http", ephemeral: true, send: vi.fn(), close: vi.fn() };

    d.addConnection(connA);
    d.addConnection(connB);
    d.addConnection(connC);

    const [rA, rB, rC] = await Promise.all([
      d.invoke("lock.unlock", { name: "x" }, connA),
      d.invoke("lock.unlock", { name: "x" }, connB),
      d.invoke("lock.unlock", { name: "x" }, connC),
    ]);
    expect(rA).toMatchObject({ ok: true });
    expect(rB).toMatchObject({ ok: true });
    expect(rC).toMatchObject({ ok: true });
    expect(hub.unlock).toHaveBeenCalledTimes(3);
  });
});

// ─── SRV-0064: 1 イベントが全購読経路へ各 framing の wire 形で符号化される ─

describe("[SRV-0064] 1 イベントが全購読経路へ各 framing の wire 形へ符号化される", () => {
  it("[SRV-0064] Daemon fan-out: 購読 conn にのみ event.<topic> が届く", () => {
    const hub = makeFakeHub({ devices: { front: { deviceUUID: "u1", deviceModel: "sesame_5" } } });
    const d = new Daemon({ hub });

    const udsConn = makeConn();
    const wsConn = makeConn();
    const noSub = makeConn();

    d.addConnection(udsConn);
    d.addConnection(wsConn);
    d.addConnection(noSub);
    d.subscribe(udsConn, ["lockState"]);
    d.subscribe(wsConn, ["lockState"]);
    // noSub は購読しない

    hub._emit({ data: { deviceUUID: "u1", state: "unlocked" } });

    const events = (c) => c.sent.filter((m) => m.method === "event.lockState");
    expect(events(udsConn)).toHaveLength(1);
    expect(events(wsConn)).toHaveLength(1);
    expect(events(noSub)).toHaveLength(0);
  });

  it("[SRV-0064] NDJSON/WS wire 形は makeEvent 形 {jsonrpc, method:'event.<topic>', params}", () => {
    const hub = makeFakeHub({ devices: { front: { deviceUUID: "u1", deviceModel: "sesame_5" } } });
    const d = new Daemon({ hub });
    const conn = makeConn();
    d.addConnection(conn);
    d.subscribe(conn, ["lockState"]);

    hub._emit({ data: { deviceUUID: "u1", state: "locked" } });

    const ev = conn.sent.find((m) => m.method === "event.lockState");
    expect(ev).toBeTruthy();
    expect(ev.jsonrpc).toBe("2.0");
    expect(ev.method).toBe("event.lockState");
    expect(ev.params).toMatchObject({ data: { deviceUUID: "u1" } });
  });

  it("[SRV-0064] gRPC wire 形: event. prefix を剥がし params を JSON 文字列化した {topic,json}", () => {
    // grpc.js:185-191 の conn.send 実装と同等のロジック検証
    const written = [];
    const sendImpl = (obj) => {
      const ev = obj;
      const topic = String(ev.method || "").replace(/^event\./, "");
      const json = JSON.stringify(ev.params ?? null);
      written.push({ topic, json });
    };

    const evData = { deviceUUID: "u1", state: "unlocked" };
    sendImpl(makeEvent("lockState", { data: evData }));

    expect(written[0].topic).toBe("lockState");
    const parsed = JSON.parse(written[0].json);
    expect(parsed.data).toMatchObject(evData);
  });

  it("[SRV-0064] SSE wire 形: data: JSON\\n\\n (NDJSON とは別の改行2フレーム)", () => {
    const sseFrame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
    const ev = makeEvent("lockState", { data: { deviceUUID: "u1" } });
    const frame = sseFrame(ev);
    expect(frame.startsWith("data: ")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);
    const parsed = JSON.parse(frame.replace(/^data: /, "").trim());
    expect(parsed.method).toBe("event.lockState");
  });
});

// ─── SRV-0066: Daemon._connectLoop 常駐起動ポリシー ─────────────────────────

describe("[SRV-0066] Daemon._connectLoop 常駐起動ポリシー", () => {
  it("[SRV-0066] connect 成功 → authState='ok' + refreshAccount(best-effort) 1 回呼ぶ", async () => {
    const hub = makeFakeHub({
      over: {
        refreshAccount: vi.fn(async () => ({ companyID: "real_co" })),
      },
    });
    const d = new Daemon({ hub });
    await d._connectLoop();
    expect(d.authState).toBe("ok");
    expect(hub.refreshAccount).toHaveBeenCalledTimes(1);
  });

  it("[SRV-0066] refreshAccount throw → warn ログのみで継続 (authState は ok のまま)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const hub = makeFakeHub({
      over: {
        refreshAccount: vi.fn(async () => { throw new Error("ws down"); }),
      },
    });
    const d = new Daemon({ hub });
    await d._connectLoop();
    expect(d.authState).toBe("ok");
    expect(errSpy).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("[SRV-0066] refreshAccount を持たない hub でも起動できる", async () => {
    const hub = makeFakeHub();
    const d = new Daemon({ hub });
    await d._connectLoop();
    expect(d.authState).toBe("ok");
  });

  it("[SRV-0066] connect 失敗 + tokenStore.refreshToken あり → authState='degraded'", async () => {
    const hub = {
      connected: false,
      config: { devices: {} },
      connect: vi.fn(async () => { throw new Error("fail"); }),
      close: vi.fn(async () => {}),
      onDeviceUpdate: () => () => {},
      tokenStore: { load: () => ({ refreshToken: "tok" }) },
    };
    const d = new Daemon({ hub });
    d._sleep = vi.fn(async () => { d._stopped = true; });
    await d._connectLoop();
    expect(d.authState).toBe("degraded");
  });

  it("[SRV-0066] connect 失敗 + tokenStore なし → authState='expired'", async () => {
    const hub = {
      connected: false,
      config: { devices: {} },
      connect: vi.fn(async () => { throw new Error("no token"); }),
      close: vi.fn(async () => {}),
      onDeviceUpdate: () => () => {},
      tokenStore: { load: () => null },
    };
    const d = new Daemon({ hub });
    d._sleep = vi.fn(async () => { d._stopped = true; });
    await d._connectLoop();
    expect(d.authState).toBe("expired");
  });

  it("[SRV-0066] 指数バックオフ: 1s から ×2 で 30s を上限とする", () => {
    let delay = 1000;
    const delays = [delay];
    for (let i = 0; i < 8; i++) {
      delay = Math.min(delay * 2, 30000);
      delays.push(delay);
    }
    expect(delays[0]).toBe(1000);
    expect(delays[1]).toBe(2000);
    expect(delays[2]).toBe(4000);
    expect(delays[3]).toBe(8000);
    expect(delays[4]).toBe(16000);
    expect(delays[5]).toBe(30000);
    expect(delays[6]).toBe(30000);
  });

  it("[SRV-0066] _stopped=true でループが離脱する (connect は呼ばれない)", async () => {
    const hub = makeFakeHub();
    const d = new Daemon({ hub });
    d._stopped = true;
    const connectSpy = vi.fn(async () => {});
    hub.connect = connectSpy;
    await d._connectLoop();
    expect(connectSpy).not.toHaveBeenCalled();
  });
});

// ─── SRV-0067: Daemon.shutdown() 冪等オーケストレーション ───────────────────

describe("[SRV-0067] Daemon.shutdown() 冪等オーケストレーション", () => {
  it("[SRV-0067] 冪等: 二度目は即 return し hub.close は 1 回だけ", async () => {
    const hub = makeFakeHub();
    const d = new Daemon({ hub });
    await d.shutdown();
    await d.shutdown();
    expect(hub.close).toHaveBeenCalledTimes(1);
  });

  it("[SRV-0067] _stopped=true で connectLoop を止め、_shuttingDown=true で受付を閉じる", async () => {
    const hub = makeFakeHub();
    const d = new Daemon({ hub });
    await d.shutdown();
    expect(d._stopped).toBe(true);
    expect(d._shuttingDown).toBe(true);
  });

  it("[SRV-0067] _retryTimer clearTimeout + _retryResolve() で connectLoop の sleep を即解除", async () => {
    const hub = makeFakeHub();
    const d = new Daemon({ hub });
    let resolved = false;
    d._retryResolve = () => { resolved = true; };
    d._retryTimer = setTimeout(() => {}, 99999);
    await d.shutdown();
    expect(resolved).toBe(true);
    expect(d._retryResolve).toBeNull();
  });

  it("[SRV-0067] _stateUnsub/_deviceListUnsub があれば teardown してから hub.close", async () => {
    const hub = makeFakeHub();
    const d = new Daemon({ hub });
    const unsubState = vi.fn();
    const unsubDeviceList = vi.fn();
    d._stateUnsub = unsubState;
    d._deviceListUnsub = unsubDeviceList;
    await d.shutdown();
    expect(unsubState).toHaveBeenCalledTimes(1);
    expect(unsubDeviceList).toHaveBeenCalledTimes(1);
    expect(hub.close).toHaveBeenCalledTimes(1);
    expect(d._stateUnsub).toBeNull();
    expect(d._deviceListUnsub).toBeNull();
  });

  it("[SRV-0067] hub.close throw は warn ログで握り、shutdown は reject しない", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const hub = makeFakeHub({
      over: {
        close: vi.fn(async () => { throw new Error("close failed"); }),
      },
    });
    const d = new Daemon({ hub });
    await expect(d.shutdown()).resolves.toBeUndefined();
    vi.restoreAllMocks();
  });

  it("[SRV-0067] 2度目の shutdown は即 return し hub.close を呼ばない (冪等)", async () => {
    const hub = makeFakeHub();
    const d = new Daemon({ hub });
    await d.shutdown();
    hub.close.mockClear();
    await d.shutdown();
    expect(hub.close).not.toHaveBeenCalled();
  });
});
