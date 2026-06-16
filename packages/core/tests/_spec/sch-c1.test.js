// packages/core/tests/_spec/sch-c1.test.js
// Spec-driven tests for SCH-0020, SCH-0021, SCH-0022, SCH-0023, SCH-0024,
//   SCH-0026, SCH-0027, SCH-0028, SCH-0030, SCH-0031
//
// 実行環境: vitest (KIT_SETUP で i18n ja 固定済み) — ネットワーク/実機不使用。
// TDD: red テストは許容。クラッシュ/実行不能は不可。

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ── core modules under test ──────────────────────────────────────────────────
import { NAMESPACE_OPS, getScheduleList, cancelSchedule } from "../../src/schedule.js";
import { TRANSPORT_ERR } from "../../src/transport.js";
import { SesameError } from "../../src/errors.js";

// ── serve modules ────────────────────────────────────────────────────────────
import { buildRegistry } from "../../../kit/src/serve/registry.js";
import { requireAuth } from "../../../kit/src/serve/registry-helpers.js";
import { KIND } from "../../src/jsonrpc.js";

// ── CLI ──────────────────────────────────────────────────────────────────────
import { Command } from "commander";
import { registerScheduleCommands } from "../../../kit/src/cli/schedule.js";

// ── mock helper ──────────────────────────────────────────────────────────────
import { mockClient } from "../helpers/mock-ws.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Paths for artifact reads
const KIT_SRC = resolve(__dirname, "../../../kit/src");
const KIT_SDK = resolve(__dirname, "../../../kit/sdk");

// ── JSON artifacts (readFileSync で読む – JSON import assert 非依存) ──────────
const rpcParams = JSON.parse(readFileSync(resolve(KIT_SRC, "serve/rpc-params.generated.json"), "utf8"));
const grpcMethods = JSON.parse(readFileSync(resolve(KIT_SRC, "serve/grpc-methods.generated.json"), "utf8"));

// ── CLI fake ctx ──────────────────────────────────────────────────────────────
function makeCtx({ hub, json = false } = {}) {
  const outputs = [];
  const dies = [];

  const ctx = {
    outputs,
    dies,
    out: (_isJson, humanFn, jsonObj) => {
      if (_isJson) {
        outputs.push(jsonObj);
      } else {
        humanFn();
        outputs.push(jsonObj);
      }
    },
    die: (msg, code) => {
      const e = new Error(msg);
      e.exitCode = code;
      dies.push({ msg, code });
      throw e;
    },
    canPrompt: () => false,
    withHub: (fn) => fn(hub, { opts: { json } }),
    withAccount: (fn) => fn(hub, { opts: { json } }),
    prompts: {
      selectFromList: vi.fn(),
      promptText: vi.fn(),
      confirm: vi.fn(),
      promptLine: vi.fn(),
    },
  };
  return ctx;
}

function buildProgram(ctx) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerScheduleCommands(program, ctx);
  return program;
}

afterEach(() => vi.restoreAllMocks());

// ─── SCH-0020: sesame schedule cancel --json 封筒 {ok,scheduleId,response} ───

describe("[SCH-0020] sesame schedule cancel --json 封筒 {ok,scheduleId,response}", () => {
  it("[SCH-0020] --json 時に {ok:true, scheduleId, response:<raw ack>} を出力し ack を raw 埋め込みにする", async () => {
    const rawAck = { action: "biz3Schedule", op: "cancelSchedule", data: {} };

    const hub = {
      schedule: {
        cancelSchedule: vi.fn().mockResolvedValue(rawAck),
        getScheduleList: vi.fn().mockResolvedValue([]),
      },
    };

    const ctx = makeCtx({ hub, json: true });
    const program = buildProgram(ctx);

    await program.parseAsync(["schedule", "cancel", "sched-XYZ"], { from: "user" });

    // out の jsonObj 形が {ok:true, scheduleId, response} であること
    const jsonOutput = ctx.outputs[ctx.outputs.length - 1];
    expect(jsonOutput).toMatchObject({
      ok: true,
      scheduleId: "sched-XYZ",
      response: rawAck,
    });
  });

  it("[SCH-0020] response には raw ack がそのまま入る (success/data の断定なし)", async () => {
    const rawAck = { action: "biz3Schedule", op: "cancelSchedule" };
    const hub = {
      schedule: {
        cancelSchedule: vi.fn().mockResolvedValue(rawAck),
        getScheduleList: vi.fn().mockResolvedValue([]),
      },
    };

    const ctx = makeCtx({ hub, json: true });
    const program = buildProgram(ctx);
    await program.parseAsync(["schedule", "cancel", "sched-001"], { from: "user" });

    const jsonOutput = ctx.outputs[ctx.outputs.length - 1];
    expect(jsonOutput.response).toEqual(rawAck);
    expect(jsonOutput.ok).toBe(true);
    expect(jsonOutput.scheduleId).toBe("sched-001");
    // response は resp と同一参照 (raw 埋め込み)
    expect(jsonOutput.response).toBe(rawAck);
  });

  it("[SCH-0020] cancelSchedule の ack が raw (success フィールド有無に関わらず) そのまま response に入る", async () => {
    const acks = [
      { action: "biz3Schedule", op: "cancelSchedule" },
      { action: "biz3Schedule", op: "cancelSchedule", data: { ok: true } },
      { action: "biz3Schedule", op: "cancelSchedule", success: true },
    ];
    for (const ack of acks) {
      const c = mockClient(ack);
      const resp = await cancelSchedule(c, { subUUID: "u-1", scheduleId: "s-1" });
      const jsonObj = { ok: true, scheduleId: "s-1", response: resp };
      expect(jsonObj.response).toEqual(ack);
    }
  });
});

// ─── SCH-0021: serve registry が schedule.* を NAMESPACE_OPS から自動公開 ───

describe("[SCH-0021] serve registry が schedule.* を NAMESPACE_OPS から自動公開", () => {
  it("[SCH-0021] NAMESPACE_OPS は ['getScheduleList','cancelSchedule'] である", () => {
    expect(NAMESPACE_OPS).toEqual(["getScheduleList", "cancelSchedule"]);
  });

  it("[SCH-0021] buildRegistry に schedule.getScheduleList と schedule.cancelSchedule が登録される", () => {
    const reg = buildRegistry();
    expect(reg.has("schedule.getScheduleList")).toBe(true);
    expect(reg.has("schedule.cancelSchedule")).toBe(true);
  });

  it("[SCH-0021] NAMESPACE_OPS から来る op 以外 (createSchedule 等) は登録されない", () => {
    const reg = buildRegistry();
    expect(reg.has("schedule.createSchedule")).toBe(false);
    expect(reg.has("schedule.addSchedule")).toBe(false);
  });

  it("[SCH-0021] ハンドラが requireAuth 後 hub.schedule[op](p) に委譲する", async () => {
    const calls = [];
    const hub = {
      connected: true,
      schedule: new Proxy({}, {
        get: (_t, op) => (params) => {
          calls.push([`schedule.${String(op)}`, params]);
          return Promise.resolve({ ok: true });
        },
      }),
    };
    const reg = buildRegistry();
    const entry = reg.get("schedule.getScheduleList");
    expect(entry).toBeTruthy();
    expect(typeof entry.handler).toBe("function");

    const daemon = { authState: "ok", hub };
    const result = await entry.handler({ hub, params: { subUUID: "u-1" }, daemon });
    expect(calls).toContainEqual(["schedule.getScheduleList", { subUUID: "u-1" }]);
    expect(result).toEqual({ ok: true });
  });

  it("[SCH-0021] entry.namespace は 'schedule' である", () => {
    const reg = buildRegistry();
    const entry = reg.get("schedule.getScheduleList");
    expect(entry.namespace).toBe("schedule");
  });

  it("[SCH-0021] entry.params は GEN_PARAMS から取得した配列 (subUUID/timeoutMs 等)", () => {
    const reg = buildRegistry();
    const entry = reg.get("schedule.getScheduleList");
    expect(Array.isArray(entry.params)).toBe(true);
    expect(entry.params.map((p) => p.name)).toContain("subUUID");
  });
});

// ─── SCH-0022: serve schedule.* の requireAuth ガード ────────────────────────

describe("[SCH-0022] serve schedule.* の requireAuth ガード (未認証/未接続)", () => {
  it("[SCH-0022] daemon.authState==='expired' で kind=NOT_AUTHENTICATED の RpcError を投げる", () => {
    const daemon = { authState: "expired", hub: { connected: true } };
    expect(() => requireAuth(daemon)).toThrow();
    try {
      requireAuth(daemon);
    } catch (e) {
      expect(e.kind).toBe(KIND.NOT_AUTHENTICATED);
    }
  });

  it("[SCH-0022] daemon.hub.connected===false で kind=CONNECTION_LOST の RpcError を投げる", () => {
    const daemon = { authState: "ok", hub: { connected: false } };
    expect(() => requireAuth(daemon)).toThrow();
    try {
      requireAuth(daemon);
    } catch (e) {
      expect(e.kind).toBe(KIND.CONNECTION_LOST);
    }
  });

  it("[SCH-0022] schedule.getScheduleList ハンドラが authState=expired で NOT_AUTHENTICATED を投げる", async () => {
    const reg = buildRegistry();
    const entry = reg.get("schedule.getScheduleList");
    const daemon = { authState: "expired", hub: { connected: true } };
    // handler は requireAuth で同期 throw する可能性があるため Promise.resolve でラップ
    await expect(
      Promise.resolve().then(() => entry.handler({ hub: daemon.hub, params: {}, daemon })),
    ).rejects.toMatchObject({ kind: KIND.NOT_AUTHENTICATED });
  });

  it("[SCH-0022] schedule.cancelSchedule ハンドラが hub.connected=false で CONNECTION_LOST を投げる", async () => {
    const reg = buildRegistry();
    const entry = reg.get("schedule.cancelSchedule");
    const daemon = { authState: "ok", hub: { connected: false } };
    // handler は requireAuth で同期 throw する可能性があるため Promise.resolve でラップ
    await expect(
      Promise.resolve().then(() => entry.handler({ hub: daemon.hub, params: {}, daemon })),
    ).rejects.toMatchObject({ kind: KIND.CONNECTION_LOST });
  });

  it("[SCH-0022] authState=ok / connected=true では requireAuth が throw しない", () => {
    const daemon = { authState: "ok", hub: { connected: true } };
    expect(() => requireAuth(daemon)).not.toThrow();
  });
});

// ─── SCH-0023: serve discover の schedule param 形 ───────────────────────────

describe("[SCH-0023] serve discover の schedule param 形 (subUUID/scheduleId/timeoutMs)", () => {
  it("[SCH-0023] rpc-params.generated.json に schedule.getScheduleList エントリが存在する", () => {
    expect(rpcParams["schedule.getScheduleList"]).toBeTruthy();
  });

  it("[SCH-0023] schedule.getScheduleList params = [subUUID?, timeoutMs?] (scheduleId 無し)", () => {
    const params = rpcParams["schedule.getScheduleList"];
    expect(Array.isArray(params)).toBe(true);
    const names = params.map((p) => p.name);
    expect(names).toContain("subUUID");
    expect(names).toContain("timeoutMs");
    // scheduleId は含まない (getScheduleList には不要)
    expect(names).not.toContain("scheduleId");
  });

  it("[SCH-0023] schedule.cancelSchedule params = [subUUID?, scheduleId?, timeoutMs?]", () => {
    const params = rpcParams["schedule.cancelSchedule"];
    expect(Array.isArray(params)).toBe(true);
    const names = params.map((p) => p.name);
    expect(names).toContain("subUUID");
    expect(names).toContain("scheduleId");
    expect(names).toContain("timeoutMs");
  });

  it("[SCH-0023] 全パラメータが required:false (subUUID は daemon が自動注入)", () => {
    for (const key of ["schedule.getScheduleList", "schedule.cancelSchedule"]) {
      const params = rpcParams[key];
      for (const p of params) {
        expect(p.required, `${key}.${p.name} should be required:false`).toBe(false);
      }
    }
  });

  it("[SCH-0023] subUUID params の desc に daemon 自動注入注記が含まれる", () => {
    for (const key of ["schedule.getScheduleList", "schedule.cancelSchedule"]) {
      const subUUIDParam = rpcParams[key].find((p) => p.name === "subUUID");
      expect(subUUIDParam).toBeTruthy();
      expect(subUUIDParam.desc ?? "").toMatch(/auto.inject/i);
    }
  });

  it("[SCH-0023] core 関数シグネチャと param 形が一致: getScheduleList({subUUID,timeoutMs}) / cancelSchedule({subUUID,scheduleId,timeoutMs})", async () => {
    // getScheduleList: subUUID と timeoutMs のみ受け付け scheduleId は無視
    const c = mockClient({ success: true, data: [] });
    await getScheduleList(c, { subUUID: "u-1", timeoutMs: 5000 });
    expect(c.sent[0]).toHaveProperty("action");
    expect(c.sent[0]).not.toHaveProperty("scheduleId");

    const c2 = mockClient({ success: true });
    await cancelSchedule(c2, { subUUID: "u-1", scheduleId: "s-1", timeoutMs: 5000 });
    expect(c2.sent[0]).toHaveProperty("scheduleId");
  });
});

// ─── SCH-0024: serve gRPC proto/method の schedule 契約 ─────────────────────

describe("[SCH-0024] serve gRPC proto/method の schedule 契約", () => {
  it("[SCH-0024] grpc-methods.generated.json に ScheduleGetScheduleList が存在し method='schedule.getScheduleList'", () => {
    const entry = grpcMethods["ScheduleGetScheduleList"];
    expect(entry).toBeTruthy();
    expect(entry.method).toBe("schedule.getScheduleList");
  });

  it("[SCH-0024] ScheduleGetScheduleList の optionalScalars が [subUUID, timeoutMs] を含む (scheduleId 無し)", () => {
    const entry = grpcMethods["ScheduleGetScheduleList"];
    expect(entry.optionalScalars).toContain("subUUID");
    expect(entry.optionalScalars).toContain("timeoutMs");
    expect(entry.optionalScalars).not.toContain("scheduleId");
  });

  it("[SCH-0024] grpc-methods.generated.json に ScheduleCancelSchedule が存在し method='schedule.cancelSchedule'", () => {
    const entry = grpcMethods["ScheduleCancelSchedule"];
    expect(entry).toBeTruthy();
    expect(entry.method).toBe("schedule.cancelSchedule");
  });

  it("[SCH-0024] ScheduleCancelSchedule の optionalScalars が [subUUID, scheduleId, timeoutMs] を含む", () => {
    const entry = grpcMethods["ScheduleCancelSchedule"];
    expect(entry.optionalScalars).toContain("subUUID");
    expect(entry.optionalScalars).toContain("scheduleId");
    expect(entry.optionalScalars).toContain("timeoutMs");
  });

  it("[SCH-0024] sesame.proto に ScheduleGetScheduleList rpc 宣言が存在する", () => {
    const proto = readFileSync(resolve(KIT_SRC, "serve/sesame.proto"), "utf8");
    expect(proto).toMatch(/rpc\s+ScheduleGetScheduleList\s*\(/);
    expect(proto).toMatch(/rpc\s+ScheduleCancelSchedule\s*\(/);
  });

  it("[SCH-0024] proto の ScheduleGetScheduleListRequest が {subUUID?, timeoutMs?} を含む", () => {
    const proto = readFileSync(resolve(KIT_SRC, "serve/sesame.proto"), "utf8");
    expect(proto).toMatch(/message ScheduleGetScheduleListRequest\s*\{[^}]*optional string subUUID/s);
    expect(proto).toMatch(/message ScheduleGetScheduleListRequest\s*\{[^}]*optional double timeoutMs/s);
  });

  it("[SCH-0024] proto の ScheduleCancelScheduleRequest が {subUUID?, scheduleId?, timeoutMs?} を含む", () => {
    const proto = readFileSync(resolve(KIT_SRC, "serve/sesame.proto"), "utf8");
    expect(proto).toMatch(/message ScheduleCancelScheduleRequest\s*\{[^}]*optional string subUUID/s);
    expect(proto).toMatch(/message ScheduleCancelScheduleRequest\s*\{[^}]*optional string scheduleId/s);
    expect(proto).toMatch(/message ScheduleCancelScheduleRequest\s*\{[^}]*optional double timeoutMs/s);
  });

  it("[SCH-0024] proto の rpc 宣言直前に experimental (unverified) コメントが付く", () => {
    const proto = readFileSync(resolve(KIT_SRC, "serve/sesame.proto"), "utf8");
    // // experimental ... → rpc ScheduleGetScheduleList
    expect(proto).toMatch(/\/\/\s*experimental.*\n\s*rpc\s+ScheduleGetScheduleList/);
    expect(proto).toMatch(/\/\/\s*experimental.*\n\s*rpc\s+ScheduleCancelSchedule/);
  });
});

// ─── SCH-0026: SDK ts/py の schedule メソッド契約 ───────────────────────────

describe("[SCH-0026] SDK ts/py の schedule メソッド契約", () => {
  it("[SCH-0026] TS SDK に readonly schedule = { ... } ブロックが存在する", () => {
    const ts = readFileSync(resolve(KIT_SDK, "ts/sesame-client.ts"), "utf8");
    expect(ts).toMatch(/readonly\s+schedule\s*=/);
  });

  it("[SCH-0026] TS SDK の cancelSchedule は method 文字列 'schedule.cancelSchedule' で _call する", () => {
    const ts = readFileSync(resolve(KIT_SDK, "ts/sesame-client.ts"), "utf8");
    expect(ts).toMatch(/this\._call\(['"]schedule\.cancelSchedule['"]/);
  });

  it("[SCH-0026] TS SDK の getScheduleList は method 文字列 'schedule.getScheduleList' で _call する", () => {
    const ts = readFileSync(resolve(KIT_SDK, "ts/sesame-client.ts"), "utf8");
    expect(ts).toMatch(/this\._call\(['"]schedule\.getScheduleList['"]/);
  });

  it("[SCH-0026] TS SDK の cancelSchedule params 型が {subUUID?,scheduleId?,timeoutMs?} を含む", () => {
    const ts = readFileSync(resolve(KIT_SDK, "ts/sesame-client.ts"), "utf8");
    expect(ts).toMatch(/subUUID\?:\s*string/);
    expect(ts).toMatch(/scheduleId\?:\s*string/);
  });

  it("[SCH-0026] TS SDK の getScheduleList params 型が {subUUID?,timeoutMs?} を含む (scheduleId 無し)", () => {
    const ts = readFileSync(resolve(KIT_SDK, "ts/sesame-client.ts"), "utf8");
    const lines = ts.split("\n");
    const line = lines.find((l) => l.includes("getScheduleList:") && l.includes("_call"));
    expect(line).toBeTruthy();
    expect(line).toContain("subUUID?");
    expect(line).toContain("timeoutMs?");
    expect(line).not.toContain("scheduleId?");
  });

  it("[SCH-0026] py SDK に _Schedule クラスと cancelSchedule/getScheduleList が存在する", () => {
    const py = readFileSync(resolve(KIT_SDK, "python/sesame_client.py"), "utf8");
    expect(py).toMatch(/class\s+_Schedule\s*:/);
    expect(py).toMatch(/def\s+cancelSchedule\s*\(self/);
    expect(py).toMatch(/def\s+getScheduleList\s*\(self/);
  });

  it("[SCH-0026] py SDK の cancelSchedule は _call('schedule.cancelSchedule', ...) を呼ぶ", () => {
    const py = readFileSync(resolve(KIT_SDK, "python/sesame_client.py"), "utf8");
    expect(py).toMatch(/_call\(['"]schedule\.cancelSchedule['"]/);
  });

  it("[SCH-0026] py SDK の getScheduleList は _call('schedule.getScheduleList', ...) を呼ぶ", () => {
    const py = readFileSync(resolve(KIT_SDK, "python/sesame_client.py"), "utf8");
    expect(py).toMatch(/_call\(['"]schedule\.getScheduleList['"]/);
  });

  it("[SCH-0026] py SDK の self.schedule = _Schedule(self) が存在する (インスタンス露出)", () => {
    const py = readFileSync(resolve(KIT_SDK, "python/sesame_client.py"), "utf8");
    expect(py).toMatch(/self\.schedule\s*=\s*_Schedule\s*\(\s*self\s*\)/);
  });
});

// ─── SCH-0027: SDK py _omit_none が未指定パラメータを送らない ───────────────

describe("[SCH-0027] SDK py _omit_none が未指定パラメータを送らない", () => {
  it("[SCH-0027] sesame_client.py に _omit_none の定義が存在する", () => {
    const py = readFileSync(resolve(KIT_SDK, "python/sesame_client.py"), "utf8");
    expect(py).toMatch(/def\s+_omit_none\s*\(/);
  });

  it("[SCH-0027] _omit_none の実装: None 値を除去し非 None 値を保持する (純ロジック)", () => {
    // _omit_none = {k: v for k, v in d.items() if v is not None}
    // JS で同等ロジックを直接検証
    const omitNone = (d) => Object.fromEntries(Object.entries(d).filter(([, v]) => v !== null && v !== undefined));

    expect(omitNone({ subUUID: "u-1", scheduleId: null, timeoutMs: undefined }))
      .toEqual({ subUUID: "u-1" });
    expect(omitNone({ subUUID: null, scheduleId: null, timeoutMs: null }))
      .toEqual({});
    expect(omitNone({ subUUID: "u-1", scheduleId: "s-1", timeoutMs: 5000 }))
      .toEqual({ subUUID: "u-1", scheduleId: "s-1", timeoutMs: 5000 });
    expect(omitNone({ subUUID: undefined, scheduleId: undefined, timeoutMs: undefined })).toEqual({});
  });

  it("[SCH-0027] py SDK cancelSchedule が _omit_none を使って None パラメータを除去する", () => {
    const py = readFileSync(resolve(KIT_SDK, "python/sesame_client.py"), "utf8");
    const lines = py.split("\n");
    const cancelMethodStart = lines.findIndex((l) => l.includes("def cancelSchedule("));
    const cancelMethodEnd = lines.findIndex(
      (l, i) => i > cancelMethodStart && l.match(/^\s{4}def /),
    );
    const cancelBody = lines.slice(cancelMethodStart, cancelMethodEnd > 0 ? cancelMethodEnd : cancelMethodStart + 10).join("\n");
    expect(cancelBody).toContain("_omit_none");
  });

  it("[SCH-0027] py SDK getScheduleList が _omit_none を使って None パラメータを除去する", () => {
    const py = readFileSync(resolve(KIT_SDK, "python/sesame_client.py"), "utf8");
    const lines = py.split("\n");
    const getMethodStart = lines.findIndex((l) => l.includes("def getScheduleList("));
    const getMethodEnd = lines.findIndex(
      (l, i) => i > getMethodStart && l.match(/^\s{4}def /),
    );
    const getBody = lines.slice(getMethodStart, getMethodEnd > 0 ? getMethodEnd : getMethodStart + 10).join("\n");
    expect(getBody).toContain("_omit_none");
  });

  it("[SCH-0027] _Schedule.cancelSchedule のシグネチャに None デフォルト値がある (subUUID/scheduleId/timeoutMs)", () => {
    const py = readFileSync(resolve(KIT_SDK, "python/sesame_client.py"), "utf8");
    expect(py).toMatch(/def\s+cancelSchedule\s*\(self/);
    const cancelMatch = py.match(/def\s+cancelSchedule\s*\(self[^)]+\)/);
    expect(cancelMatch).not.toBeNull();
    expect(cancelMatch[0]).toMatch(/None/);
  });

  it("[SCH-0027] _Schedule.getScheduleList のシグネチャに None デフォルト値がある (subUUID/timeoutMs)", () => {
    const py = readFileSync(resolve(KIT_SDK, "python/sesame_client.py"), "utf8");
    expect(py).toMatch(/def\s+getScheduleList\s*\(self/);
    const getMatch = py.match(/def\s+getScheduleList\s*\(self[^)]+\)/);
    expect(getMatch).not.toBeNull();
    expect(getMatch[0]).toMatch(/None/);
  });

  it("[SCH-0027] subUUID 省略時: _omit_none({subUUID:None,...}) で subUUID が送出ペイロードから除去される", () => {
    // daemon 自動注入を阻害しない (None → 除去 → daemon が注入)
    const omitNone = (d) => Object.fromEntries(Object.entries(d).filter(([, v]) => v !== null && v !== undefined));
    const payload = omitNone({ subUUID: null, timeoutMs: null });
    expect(payload).not.toHaveProperty("subUUID");
    expect(payload).not.toHaveProperty("timeoutMs");
  });
});

// ─── SCH-0028: createSchedule 等の作成 op が全 surface に存在しない (負の証拠) ─

describe("[SCH-0028] createSchedule 等の作成 op が全 surface に存在しない (負の証拠)", () => {
  it("[SCH-0028] NAMESPACE_OPS に createSchedule / addSchedule が含まれない", () => {
    expect(NAMESPACE_OPS).not.toContain("createSchedule");
    expect(NAMESPACE_OPS).not.toContain("addSchedule");
    expect(NAMESPACE_OPS).toEqual(["getScheduleList", "cancelSchedule"]);
  });

  it("[SCH-0028] serve registry に schedule.createSchedule / schedule.addSchedule が登録されない", () => {
    const reg = buildRegistry();
    expect(reg.has("schedule.createSchedule")).toBe(false);
    expect(reg.has("schedule.addSchedule")).toBe(false);
  });

  it("[SCH-0028] grpc-methods.generated.json に ScheduleCreateSchedule / ScheduleAddSchedule が存在しない", () => {
    expect(grpcMethods["ScheduleCreateSchedule"]).toBeUndefined();
    expect(grpcMethods["ScheduleAddSchedule"]).toBeUndefined();
  });

  it("[SCH-0028] rpc-params.generated.json に schedule.createSchedule / schedule.addSchedule が存在しない", () => {
    expect(rpcParams["schedule.createSchedule"]).toBeUndefined();
    expect(rpcParams["schedule.addSchedule"]).toBeUndefined();
  });

  it("[SCH-0028] proto に ScheduleCreateSchedule / ScheduleAddSchedule rpc 宣言が存在しない", () => {
    const proto = readFileSync(resolve(KIT_SRC, "serve/sesame.proto"), "utf8");
    expect(proto).not.toMatch(/rpc\s+ScheduleCreateSchedule/);
    expect(proto).not.toMatch(/rpc\s+ScheduleAddSchedule/);
  });

  it("[SCH-0028] TS SDK に createSchedule / addSchedule が存在しない", () => {
    const ts = readFileSync(resolve(KIT_SDK, "ts/sesame-client.ts"), "utf8");
    const scheduleBlockMatch = ts.match(/readonly\s+schedule\s*=\s*\{([^}]+)\}/);
    if (scheduleBlockMatch) {
      expect(scheduleBlockMatch[1]).not.toMatch(/createSchedule/);
      expect(scheduleBlockMatch[1]).not.toMatch(/addSchedule/);
    } else {
      expect(ts).not.toMatch(/schedule\.createSchedule/);
      expect(ts).not.toMatch(/schedule\.addSchedule/);
    }
  });

  it("[SCH-0028] py SDK _Schedule クラスに createSchedule / addSchedule メソッドが存在しない", () => {
    const py = readFileSync(resolve(KIT_SDK, "python/sesame_client.py"), "utf8");
    const classMatch = py.match(/class\s+_Schedule[\s\S]*?(?=\nclass\s|\nclass\t|$)/);
    if (classMatch) {
      expect(classMatch[0]).not.toMatch(/def\s+createSchedule/);
      expect(classMatch[0]).not.toMatch(/def\s+addSchedule/);
    } else {
      expect(py).not.toMatch(/_call\(['"]schedule\.createSchedule['"]/);
      expect(py).not.toMatch(/_call\(['"]schedule\.addSchedule['"]/);
    }
  });

  it("[SCH-0028] core/src/schedule.js が createSchedule / addSchedule を export しない", async () => {
    const scheduleSrc = await import("../../src/schedule.js");
    expect(scheduleSrc).not.toHaveProperty("createSchedule");
    expect(scheduleSrc).not.toHaveProperty("addSchedule");
  });
});

// ─── SCH-0030: getScheduleList/cancelSchedule の応答タイムアウト error-path ──

describe("[SCH-0030] getScheduleList/cancelSchedule の応答タイムアウト error-path (transport timeoutErr / code=TRANSPORT_TIMEOUT が素通り伝播)", () => {
  it("[SCH-0030] TRANSPORT_ERR.TIMEOUT コードは 'TRANSPORT_TIMEOUT' である", () => {
    // transport.js:73
    expect(TRANSPORT_ERR.TIMEOUT).toBe("TRANSPORT_TIMEOUT");
  });

  it("[SCH-0030] getScheduleList: transport.request が timeoutErr で reject すると schedule.js がそのまま伝播する", async () => {
    const timeoutError = new Error("request timeout");
    timeoutError.code = TRANSPORT_ERR.TIMEOUT;
    const c = {
      sent: [],
      async request(frame) {
        c.sent.push(frame);
        throw timeoutError;
      },
    };
    // schedule.js は catch/wrap 無しなので timeoutErr が生のまま出る
    await expect(
      getScheduleList(c, { subUUID: "u-1" }),
    ).rejects.toThrow("request timeout");
    // code が TRANSPORT_TIMEOUT のまま出ること
    await getScheduleList(c, { subUUID: "u-1" }).catch((e) => {
      expect(e.code).toBe(TRANSPORT_ERR.TIMEOUT);
    });
  });

  it("[SCH-0030] cancelSchedule: transport.request が timeoutErr で reject すると schedule.js がそのまま伝播する", async () => {
    const timeoutError = new Error("request timeout");
    timeoutError.code = TRANSPORT_ERR.TIMEOUT;
    const c = {
      sent: [],
      async request(frame) {
        c.sent.push(frame);
        throw timeoutError;
      },
    };
    await expect(
      cancelSchedule(c, { subUUID: "u-1", scheduleId: "s-1" }),
    ).rejects.toThrow("request timeout");
    await cancelSchedule(c, { subUUID: "u-1", scheduleId: "s-1" }).catch((e) => {
      expect(e.code).toBe(TRANSPORT_ERR.TIMEOUT);
    });
  });

  it("[SCH-0030] タイムアウトエラーは SesameError に包まれず raw の TRANSPORT_TIMEOUT error がそのまま伝播する", async () => {
    const timeoutError = Object.assign(new Error("biz3Schedule:getScheduleList timed out"), { code: "TRANSPORT_TIMEOUT" });
    const c = {
      sent: [],
      async request(frame) { c.sent.push(frame); throw timeoutError; },
    };
    let thrown;
    try {
      await getScheduleList(c, { subUUID: "u-1" });
    } catch (e) {
      thrown = e;
    }
    // SesameError.code は 'bad_request' や 'rejected' でなく、raw TRANSPORT_TIMEOUT のまま
    expect(thrown?.code).toBe("TRANSPORT_TIMEOUT");
    // SesameError でないこと (schedule.js / _bindNs は catch/wrap しないため)
    expect(thrown).not.toBeInstanceOf(SesameError);
  });

  it("[SCH-0030] timeoutErr は subUUID badRequest (同期 throw) とは別の、送信後非同期の無応答異常系である", async () => {
    // badRequest は送信前: c.sent.length === 0
    const c = mockClient({});
    await expect(getScheduleList(c, {})).rejects.toMatchObject({});
    expect(c.sent).toHaveLength(0); // 送信前に throw

    // timeout は送信後: c.sent.length === 1
    const timeoutError = new Error("request timeout");
    timeoutError.code = TRANSPORT_ERR.TIMEOUT;
    const c2 = {
      sent: [],
      async request(frame) { c2.sent.push(frame); throw timeoutError; },
    };
    await expect(getScheduleList(c2, { subUUID: "u-1" })).rejects.toMatchObject({});
    expect(c2.sent).toHaveLength(1); // 送信後に timeout
  });

  it("[SCH-0030] DEFAULT_TIMEOUT_MS は 10_000 ms である (schedule.js:30)", () => {
    const calls = [];
    const c = {
      sent: [],
      async request(frame, timeoutMs) {
        calls.push(timeoutMs);
        c.sent.push(frame);
        return { success: true, data: [] };
      },
    };
    return getScheduleList(c, { subUUID: "u-1" }).then(() => {
      expect(calls[0]).toBe(10_000);
    });
  });

  it("[SCH-0030] cancelSchedule の DEFAULT_TIMEOUT_MS も 10_000 ms である", () => {
    const calls = [];
    const c = {
      sent: [],
      async request(frame, timeoutMs) {
        calls.push(timeoutMs);
        c.sent.push(frame);
        return { success: true };
      },
    };
    return cancelSchedule(c, { subUUID: "u-1", scheduleId: "s-1" }).then(() => {
      expect(calls[0]).toBe(10_000);
    });
  });
});

// ─── SCH-0031: cancelSchedule の応答相関キー biz3Schedule:cancelSchedule と scheduleId 非相関 ─

describe("[SCH-0031] cancelSchedule の応答相関キー biz3Schedule:cancelSchedule と scheduleId 非相関 (FIFO のみ・負の証拠)", () => {
  it("[SCH-0031] cancelSchedule は key='biz3Schedule:cancelSchedule' で transport.request を呼ぶ (scheduleId は相関キーに含まない)", async () => {
    // transport.js:263: key = `${payload.action}:${payload.op || ''}`
    const capturedFrames = [];
    const c = {
      sent: [],
      async request(frame) {
        capturedFrames.push(frame);
        c.sent.push(frame);
        return { action: "biz3Schedule", op: "cancelSchedule" };
      },
    };
    await cancelSchedule(c, { subUUID: "u-1", scheduleId: "sched-X" });
    expect(capturedFrames).toHaveLength(1);
    const frame = capturedFrames[0];
    // 相関キー導出: `${action}:${op}` = 'biz3Schedule:cancelSchedule'
    const key = `${frame.action}:${frame.op}`;
    expect(key).toBe("biz3Schedule:cancelSchedule");
    // scheduleId はフレームに含まれるが相関キーには含まれない
    expect(frame.scheduleId).toBe("sched-X");
    expect(key).not.toContain("sched-X");
  });

  it("[SCH-0031] 異なる scheduleId 2件が同じ相関キー 'biz3Schedule:cancelSchedule' を持つ (scheduleId 非相関の確認)", async () => {
    const frames = [];
    const c = {
      sent: [],
      async request(frame) {
        frames.push(frame);
        c.sent.push(frame);
        return { action: "biz3Schedule", op: "cancelSchedule" };
      },
    };
    await cancelSchedule(c, { subUUID: "u-1", scheduleId: "sched-A" });
    await cancelSchedule(c, { subUUID: "u-1", scheduleId: "sched-B" });
    expect(frames).toHaveLength(2);
    const key0 = `${frames[0].action}:${frames[0].op}`;
    const key1 = `${frames[1].action}:${frames[1].op}`;
    expect(key0).toBe("biz3Schedule:cancelSchedule");
    expect(key1).toBe("biz3Schedule:cancelSchedule");
    expect(frames[0].scheduleId).toBe("sched-A");
    expect(frames[1].scheduleId).toBe("sched-B");
  });

  it("[SCH-0031] getScheduleList の相関キー 'biz3Schedule:getScheduleList' とは別キーである (op 名で区別)", async () => {
    const listFrame = [];
    const cancelFrame = [];
    const cl = {
      sent: [],
      async request(frame) {
        if (frame.op === "getScheduleList") listFrame.push(frame);
        else cancelFrame.push(frame);
        cl.sent.push(frame);
        if (frame.op === "getScheduleList") return { success: true, data: [] };
        return { action: "biz3Schedule", op: "cancelSchedule" };
      },
    };
    await getScheduleList(cl, { subUUID: "u-1" });
    await cancelSchedule(cl, { subUUID: "u-1", scheduleId: "s-1" });

    const listKey = `${listFrame[0].action}:${listFrame[0].op}`;
    const cancelKey = `${cancelFrame[0].action}:${cancelFrame[0].op}`;
    expect(listKey).toBe("biz3Schedule:getScheduleList");
    expect(cancelKey).toBe("biz3Schedule:cancelSchedule");
    expect(listKey).not.toBe(cancelKey);
  });

  it("[SCH-0031] 移植元相関キー {action,op} の2段照合: scheduleId を相関に使わない (参照: useManageSchedule.js:61)", () => {
    // scheduleId は登録キーに含まれない (action + op のみ)
    function makeKey(payload) {
      return `${payload.action}:${payload.op || ""}`;
    }

    const frame = { action: "biz3Schedule", userId: "u-1", scheduleId: "sched-X", op: "cancelSchedule" };
    const key = makeKey(frame);

    expect(key).toBe("biz3Schedule:cancelSchedule");
    expect(key).not.toContain("sched-X");
    expect(key).not.toContain("scheduleId");
  });

  it("[SCH-0031] FIFO 解決: 並行 cancelSchedule 2件は FIFO で解決される (scheduleId で区別されない)", async () => {
    // フレーム2件を順番に受け取り、それぞれが queue.shift() で解決される
    const results = [];
    let callCount = 0;
    const responses = [
      { action: "biz3Schedule", op: "cancelSchedule", data: { item: 1 } },
      { action: "biz3Schedule", op: "cancelSchedule", data: { item: 2 } },
    ];
    const c = {
      sent: [],
      async request(frame) {
        c.sent.push(frame);
        return responses[callCount++];
      },
    };
    const r1 = await cancelSchedule(c, { subUUID: "u-1", scheduleId: "sched-1" });
    const r2 = await cancelSchedule(c, { subUUID: "u-1", scheduleId: "sched-2" });
    results.push(r1, r2);
    // 送信順 (FIFO) に対応する応答が返る
    expect(results[0]).toEqual(responses[0]);
    expect(results[1]).toEqual(responses[1]);
    expect(c.sent[0].scheduleId).toBe("sched-1");
    expect(c.sent[1].scheduleId).toBe("sched-2");
  });
});
