// packages/core/tests/_spec/co-c1.test.js
// TDD spec テスト: CO-0022 〜 CO-0037 (会社管理 CLI / serve / SDK / i18n)
//
// 対象実装:
//   packages/core/src/company.js          (core 4 op)
//   packages/kit/src/cli/company.js       (CLI registerCompanyCommands)
//   packages/kit/src/serve/registry.js    (buildRegistry / NS_MODULES)
//   packages/kit/src/serve/stability.js   (STABLE_METHODS / stabilityOf)
//   packages/kit/sdk/ts/sesame-client.ts  (TypeScript SDK _Company)
//   packages/kit/sdk/python/sesame_client.py (_Company)
//   packages/kit/src/serve/rpc-params.generated.json
//   packages/kit/src/serve/sesame.proto
//   packages/kit/src/serve/grpc-methods.generated.json
//   packages/core/src/i18n/company.js
//   packages/core/src/transport.js        (TRANSPORT_ERR / DEFAULT_TIMEOUT_MS)
//
// 方針: TDD — 実装が spec と食い違う場合は正しい期待値 (spec どおり) を assert する (red 許容)。
// ネットワーク・実機に触れない。全て mock または純関数・ファイル読み取り。

import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// ─── core 実装 ────────────────────────────────────────────────────────────────
import {
  getCompanies,
  updateCompanyName,
  addCompany,
  getPaymentConfig,
  NAMESPACE_OPS,
} from "../../src/company.js";

// ─── i18n ─────────────────────────────────────────────────────────────────────
import i18nCompany from "../../src/i18n/company.js";

// ─── transport (timeout 定数・エラーコード検証用) ─────────────────────────────
import { TRANSPORT_ERR } from "../../src/transport.js";

// ─── errors ──────────────────────────────────────────────────────────────────
import { SesameError, ERR } from "../../src/errors.js";

// ─── CLI ──────────────────────────────────────────────────────────────────────
import { registerCompanyCommands } from "../../../kit/src/cli/company.js";

// ─── serve ────────────────────────────────────────────────────────────────────
import { buildRegistry, NAMESPACE_MODULE_KEYS } from "../../../kit/src/serve/registry.js";
import { STABLE_METHODS, stabilityOf } from "../../../kit/src/serve/stability.js";

// ─── mock-ws helpers ──────────────────────────────────────────────────────────
import { mockClient } from "../helpers/mock-ws.js";

// ─── JSON アセット ────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
import rpcParams from "../../../kit/src/serve/rpc-params.generated.json" assert { type: "json" };
import grpcMethods from "../../../kit/src/serve/grpc-methods.generated.json" assert { type: "json" };

// ─── proto テキスト (CO-0029 用) ──────────────────────────────────────────────
const protoText = readFileSync(
  resolve(__dirname, "../../../kit/src/serve/sesame.proto"),
  "utf8",
);

// ─── SDK テキスト (CO-0028 用) ────────────────────────────────────────────────
const sdkTsText = readFileSync(
  resolve(__dirname, "../../../kit/sdk/ts/sesame-client.ts"),
  "utf8",
);
const sdkPyText = readFileSync(
  resolve(__dirname, "../../../kit/sdk/python/sesame_client.py"),
  "utf8",
);

// ─── CLI fake ctx ─────────────────────────────────────────────────────────────
// withAccount は fn(hub, { opts, customerInfo }) を即呼びする。

function makeCtx({ hub = {}, json = false, customerInfo = undefined } = {}) {
  const outputs = [];
  const dies = [];

  const ctx = {
    outputs,
    dies,
    out(isJson, humanFn, jsonObj) {
      outputs.push(jsonObj);
      if (!isJson) humanFn();
    },
    die(msg, code) {
      const e = new Error(msg);
      /** @type {any} */ (e).exitCode = code;
      dies.push({ msg, code });
      throw e;
    },
    canPrompt: () => false,
    withHub: (fn) => fn(hub, { opts: { json } }),
    withAccount: (fn) => fn(hub, { opts: { json }, customerInfo }),
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
  registerCompanyCommands(program, ctx);
  return program;
}

afterEach(() => vi.restoreAllMocks());

// ═══════════════════════════════════════════════════════════════════════════════
// [CO-0022] sesame company ls 出力整形 (件数文言・owner タグ・--json 封筒)
// ═══════════════════════════════════════════════════════════════════════════════
describe("[CO-0022] sesame company ls 出力整形", () => {
  it("[CO-0022] --json では {ok,count,companies} 封筒を返す", async () => {
    const companies = [
      { companyID: "ch_A", name: "会社A", tag: ["オーナー"] },
      { companyID: "ch_B", name: "会社B", tag: [] },
    ];
    const hub = { company: { getCompanies: async () => companies } };
    const ctx = makeCtx({ hub, json: true });
    const program = buildProgram(ctx);

    await program.parseAsync(["company", "ls"], { from: "user" });

    expect(ctx.outputs).toHaveLength(1);
    const out = ctx.outputs[0];
    expect(out.ok).toBe(true);
    expect(out.count).toBe(2);
    expect(out.companies).toBe(companies);
  });

  it("[CO-0022] --json 封筒の count は companies の件数と一致する", async () => {
    const companies = [
      { companyID: "ch_A", name: "会社A", tag: [] },
      { companyID: "ch_B", name: "会社B", tag: [] },
      { companyID: "ch_C", name: "会社C", tag: [] },
    ];
    const hub = { company: { getCompanies: async () => companies } };
    const ctx = makeCtx({ hub, json: true });

    await buildProgram(ctx).parseAsync(["company", "ls"], { from: "user" });

    expect(ctx.outputs[0].count).toBe(3);
    expect(ctx.outputs[0].ok).toBe(true);
  });

  it("[CO-0022] human 0件は none 文言を出力", async () => {
    const hub = { company: { getCompanies: async () => [] } };
    const ctx = makeCtx({ hub });
    const program = buildProgram(ctx);
    const logged = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => logged.push(a.join(" ")));

    await program.parseAsync(["company", "ls"], { from: "user" });
    spy.mockRestore();

    // found.one / found.many ではなく none 相当の文言 ("(no companies)")
    expect(logged.some((l) => l.includes("no companies") || l.includes("none"))).toBe(true);
  });

  it("[CO-0022] human 1件は found.one 文言 (count 含む)", async () => {
    const companies = [{ companyID: "ch_A", name: "会社A" }];
    const hub = { company: { getCompanies: async () => companies } };
    const ctx = makeCtx({ hub });
    const program = buildProgram(ctx);
    const logged = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => logged.push(a.join(" ")));

    await program.parseAsync(["company", "ls"], { from: "user" });
    spy.mockRestore();

    // "Found 1 company:" — count=1 の found.one 文言
    expect(logged.some((l) => /found\s+1\s+company/i.test(l))).toBe(true);
  });

  it("[CO-0022] human 複数は found.many 文言 (count 含む)", async () => {
    const companies = [
      { companyID: "ch_A", name: "会社A" },
      { companyID: "ch_B", name: "会社B" },
    ];
    const hub = { company: { getCompanies: async () => companies } };
    const ctx = makeCtx({ hub });
    const program = buildProgram(ctx);
    const logged = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => logged.push(a.join(" ")));

    await program.parseAsync(["company", "ls"], { from: "user" });
    spy.mockRestore();

    // "Found 2 companies:"
    expect(logged.some((l) => /found\s+2\s+companies/i.test(l))).toBe(true);
  });

  it("[CO-0022] owner タグ: tag[0]==='オーナー' の company に ownerTag が per-element 付与される", async () => {
    const companies = [
      { companyID: "ch_A", name: "会社A", tag: ["オーナー"] },   // owner
      { companyID: "ch_B", name: "会社B", tag: [] },               // non-owner
      { companyID: "ch_C", name: "会社C", tag: null },             // tag 非配列
    ];
    const hub = { company: { getCompanies: async () => companies } };
    const ctx = makeCtx({ hub });
    const program = buildProgram(ctx);
    const logged = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => logged.push(a.join(" ")));

    await program.parseAsync(["company", "ls"], { from: "user" });
    spy.mockRestore();

    // ch_A の行に ownerTag が付く (ja: " [オーナー]", en: " [owner]")
    const ownerLine = logged.find((l) => l.includes("ch_A"));
    expect(ownerLine).toBeDefined();
    expect(ownerLine).toMatch(/\[owner\]|\[オーナー\]/);

    // ch_B の行には付かない
    const nonOwnerLine = logged.find((l) => l.includes("ch_B"));
    if (nonOwnerLine) {
      expect(nonOwnerLine).not.toMatch(/\[owner\]|\[オーナー\]/);
    }

    // ch_C (tag=null) の行には付かない
    const nullTagLine = logged.find((l) => l.includes("ch_C"));
    if (nullTagLine) {
      expect(nullTagLine).not.toMatch(/\[owner\]|\[オーナー\]/);
    }
  });

  it("[CO-0022] tag が配列でない company には ownerTag を付与しない (per-element Array.isArray ガード)", async () => {
    const companies = [
      { companyID: "ch_A", name: "会社A", tag: "オーナー" },  // 配列でない
      { companyID: "ch_B", name: "会社B" },                   // tag 無し
    ];
    const hub = { company: { getCompanies: async () => companies } };
    const ctx = makeCtx({ hub });
    const program = buildProgram(ctx);
    const logged = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => logged.push(a.join(" ")));

    await program.parseAsync(["company", "ls"], { from: "user" });
    spy.mockRestore();

    // どの行にも ownerTag が付かない
    expect(logged.every((l) => !l.match(/\[owner\]|\[オーナー\]/))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// [CO-0023] sesame company rename <name>
// ═══════════════════════════════════════════════════════════════════════════════
describe("[CO-0023] sesame company rename <name>", () => {
  it("[CO-0023] --json では {ok,company} 封筒を返す", async () => {
    const resp = { companyID: "ch_A", name: "新名" };
    const updateCompanyNameMock = vi.fn(async () => resp);
    const hub = { company: { updateCompanyName: updateCompanyNameMock } };
    const ctx = makeCtx({ hub, json: true });
    const program = buildProgram(ctx);

    await program.parseAsync(["company", "rename", "新名"], { from: "user" });

    expect(ctx.outputs).toHaveLength(1);
    expect(ctx.outputs[0]).toEqual({ ok: true, company: resp });
  });

  it("[CO-0023] updateCompanyName は {name} のみ渡す (companyID 明示せず namespace 注入)", async () => {
    const resp = { companyID: "ch_A", name: "新名" };
    const updateCompanyNameMock = vi.fn(async () => resp);
    const hub = { company: { updateCompanyName: updateCompanyNameMock } };
    const ctx = makeCtx({ hub, json: true });
    const program = buildProgram(ctx);

    await program.parseAsync(["company", "rename", "新名"], { from: "user" });

    expect(updateCompanyNameMock).toHaveBeenCalledOnce();
    const args = updateCompanyNameMock.mock.calls[0][0];
    // companyID は渡さない (namespace 注入に委ねる)
    expect(args).toMatchObject({ name: "新名" });
    expect(args).not.toHaveProperty("companyID");
  });

  it("[CO-0023] human では rename.ok 文言を出力", async () => {
    const resp = { companyID: "ch_A", name: "新名" };
    const hub = { company: { updateCompanyName: async () => resp } };
    const ctx = makeCtx({ hub, json: false });
    const program = buildProgram(ctx);
    const logged = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => logged.push(a.join(" ")));

    await program.parseAsync(["company", "rename", "新名"], { from: "user" });
    spy.mockRestore();

    // rename.ok: 'OK: renamed company {companyID} → "{name}"'
    expect(logged.some((l) => /OK.*rename|renamed/i.test(l))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// [CO-0024] sesame company add <name>
// ═══════════════════════════════════════════════════════════════════════════════
describe("[CO-0024] sesame company add <name>", () => {
  it("[CO-0024] customerInfo 完備時: addCompany を呼び --json で {ok,company} を返す", async () => {
    const newCompany = { companyID: "ch_new", name: "新会社" };
    const addCompanyMock = vi.fn(async () => newCompany);
    const hub = { company: { addCompany: addCompanyMock } };
    const customerInfo = { employeeEmail: "me@example.com", subUUID: "sub-uuid-1" };
    const ctx = makeCtx({ hub, json: true, customerInfo });
    const program = buildProgram(ctx);

    await program.parseAsync(["company", "add", "新会社"], { from: "user" });

    expect(addCompanyMock).toHaveBeenCalledOnce();
    expect(ctx.outputs[0]).toEqual({ ok: true, company: newCompany });
  });

  it("[CO-0024] addCompany に customerInfo の employeeEmail/subUUID を渡す", async () => {
    const addCompanyMock = vi.fn(async () => null);
    const hub = { company: { addCompany: addCompanyMock } };
    const customerInfo = { employeeEmail: "me@example.com", subUUID: "sub-uuid-1" };
    const ctx = makeCtx({ hub, customerInfo });
    const program = buildProgram(ctx);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(["company", "add", "新会社"], { from: "user" });
    spy.mockRestore();

    expect(addCompanyMock).toHaveBeenCalledOnce();
    const args = addCompanyMock.mock.calls[0][0];
    expect(args).toMatchObject({
      name: "新会社",
      employeeEmail: "me@example.com",
      subUUID: "sub-uuid-1",
    });
  });

  it("[CO-0024] customerInfo.employeeEmail 欠落で ctx.die(missingCustomerInfo, 1) を呼ぶ", async () => {
    const hub = { company: { addCompany: vi.fn() } };
    const customerInfo = { subUUID: "sub-uuid-1" }; // employeeEmail 欠落
    const ctx = makeCtx({ hub, customerInfo });
    const program = buildProgram(ctx);

    await expect(program.parseAsync(["company", "add", "新会社"], { from: "user" })).rejects.toThrow();
    expect(ctx.dies).toHaveLength(1);
    expect(ctx.dies[0].code).toBe(1);
    // addCompany は呼ばれない
    expect(hub.company.addCompany).not.toHaveBeenCalled();
  });

  it("[CO-0024] customerInfo.subUUID 欠落で ctx.die(missingCustomerInfo, 1) を呼ぶ", async () => {
    const hub = { company: { addCompany: vi.fn() } };
    const customerInfo = { employeeEmail: "me@example.com" }; // subUUID 欠落
    const ctx = makeCtx({ hub, customerInfo });
    const program = buildProgram(ctx);

    await expect(program.parseAsync(["company", "add", "新会社"], { from: "user" })).rejects.toThrow();
    expect(ctx.dies).toHaveLength(1);
    expect(ctx.dies[0].code).toBe(1);
    expect(hub.company.addCompany).not.toHaveBeenCalled();
  });

  it("[CO-0024] customerInfo 自体が undefined の場合も die(1) を呼ぶ", async () => {
    const hub = { company: { addCompany: vi.fn() } };
    const ctx = makeCtx({ hub, customerInfo: undefined });
    const program = buildProgram(ctx);

    await expect(program.parseAsync(["company", "add", "新会社"], { from: "user" })).rejects.toThrow();
    expect(ctx.dies).toHaveLength(1);
    expect(ctx.dies[0].code).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// [CO-0025] sesame company payment
// ═══════════════════════════════════════════════════════════════════════════════
describe("[CO-0025] sesame company payment", () => {
  it("[CO-0025] --json では {ok,paymentConfig} 封筒を返す", async () => {
    const config = { level: 3, isYear: true, config: "plan_a", time: "2026-01-01", total: 9900, nextPrice: 0 };
    const hub = { company: { getPaymentConfig: async () => config } };
    const ctx = makeCtx({ hub, json: true });
    const program = buildProgram(ctx);

    await program.parseAsync(["company", "payment"], { from: "user" });

    expect(ctx.outputs).toHaveLength(1);
    expect(ctx.outputs[0]).toEqual({ ok: true, paymentConfig: config });
  });

  it("[CO-0025] --json で config null のときも {ok:true, paymentConfig:null} を返す", async () => {
    const hub = { company: { getPaymentConfig: async () => null } };
    const ctx = makeCtx({ hub, json: true });

    await buildProgram(ctx).parseAsync(["company", "payment"], { from: "user" });

    expect(ctx.outputs[0]).toMatchObject({ ok: true, paymentConfig: null });
  });

  it("[CO-0025] config==null のとき payment.none 文言を出力", async () => {
    const hub = { company: { getPaymentConfig: async () => null } };
    const ctx = makeCtx({ hub });
    const program = buildProgram(ctx);
    const logged = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => logged.push(a.join(" ")));

    await program.parseAsync(["company", "payment"], { from: "user" });
    spy.mockRestore();

    // payment.none: "(no payment config / no response data)" or similar
    expect(logged.some((l) => /no payment config|payment.*none/i.test(l))).toBe(true);
  });

  it("[CO-0025] config!=null のとき JSON.stringify(config,null,2) を出力", async () => {
    const config = { level: 3, isYear: true };
    const hub = { company: { getPaymentConfig: async () => config } };
    const ctx = makeCtx({ hub });
    const program = buildProgram(ctx);
    const logged = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => logged.push(a.join(" ")));

    await program.parseAsync(["company", "payment"], { from: "user" });
    spy.mockRestore();

    const expected = JSON.stringify(config, null, 2);
    expect(logged.some((l) => l.includes(expected) || l.includes('"level"'))).toBe(true);
  });

  it("[CO-0025] getPaymentConfig は companyID を明示せず呼ぶ (namespace 注入)", async () => {
    const getPaymentConfigMock = vi.fn(async () => null);
    const hub = { company: { getPaymentConfig: getPaymentConfigMock } };
    const ctx = makeCtx({ hub, json: true });
    const program = buildProgram(ctx);

    await program.parseAsync(["company", "payment"], { from: "user" });

    expect(getPaymentConfigMock).toHaveBeenCalledOnce();
    // 引数なし or 空オブジェクト — companyID は明示しない
    const args = getPaymentConfigMock.mock.calls[0];
    if (args.length > 0 && args[0] !== undefined) {
      expect(args[0]).not.toHaveProperty("companyID");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// [CO-0026] serve registry が company.* 4 op を NAMESPACE_OPS から自動公開 (requireAuth 付き)
// ═══════════════════════════════════════════════════════════════════════════════
describe("[CO-0026] serve registry が company.* 4 op を登録する", () => {
  const EXPECTED_OPS = ["getCompanies", "updateCompanyName", "addCompany", "getPaymentConfig"];

  it("[CO-0026] NAMESPACE_OPS が 'getCompanies','updateCompanyName','addCompany','getPaymentConfig' の 4 op を含む", () => {
    expect(Array.isArray(NAMESPACE_OPS)).toBe(true);
    expect(NAMESPACE_OPS).toHaveLength(4);
    for (const op of EXPECTED_OPS) {
      expect(NAMESPACE_OPS, `NAMESPACE_OPS should contain '${op}'`).toContain(op);
    }
  });

  it("[CO-0026] buildRegistry の registry に company.* 4 op が存在する", () => {
    const reg = buildRegistry();
    for (const op of EXPECTED_OPS) {
      expect(reg.has(`company.${op}`), `company.${op} が registry に存在する`).toBe(true);
    }
  });

  it("[CO-0026] company.* 4 op が registry に 1:1 で存在し余分な company.* op が無い", () => {
    const reg = buildRegistry();
    const companyKeys = [...reg.keys()].filter((k) => k.startsWith("company."));
    expect(companyKeys).toHaveLength(4);
    const sortedKeys = companyKeys.sort();
    const sortedExpected = EXPECTED_OPS.map((op) => `company.${op}`).sort();
    expect(sortedKeys).toEqual(sortedExpected);
  });

  it("[CO-0026] registry.js の NS_MODULES に company が含まれる (NAMESPACE_MODULE_KEYS)", () => {
    expect(NAMESPACE_MODULE_KEYS).toContain("company");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// [CO-0027] company.* は STABLE_METHODS 非掲載 = experimental 安定性
// ═══════════════════════════════════════════════════════════════════════════════
describe("[CO-0027] company.* は STABLE_METHODS 非掲載 = experimental", () => {
  const COMPANY_OPS = ["company.getCompanies", "company.updateCompanyName", "company.addCompany", "company.getPaymentConfig"];

  it("[CO-0027] STABLE_METHODS に company.* op が含まれない", () => {
    for (const op of COMPANY_OPS) {
      expect(Object.hasOwn(STABLE_METHODS, op), `STABLE_METHODS に ${op} が存在しない`).toBe(false);
    }
  });

  it("[CO-0027] stabilityOf('company.*') はすべて 'experimental'", () => {
    for (const op of COMPANY_OPS) {
      expect(stabilityOf(op), `stabilityOf('${op}') === 'experimental'`).toBe("experimental");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// [CO-0028] 生成 SDK (ts/py) に company 4 メソッドが存在し param 形が一致
// ═══════════════════════════════════════════════════════════════════════════════
describe("[CO-0028] 生成 SDK (ts/py) に company 4 メソッドが存在", () => {
  it("[CO-0028] rpc-params の company.addCompany: name/employeeEmail required・subUUID optional", () => {
    const params = rpcParams["company.addCompany"];
    expect(params).toBeDefined();
    const nameParam = params.find((p) => p.name === "name");
    const emailParam = params.find((p) => p.name === "employeeEmail");
    const subParam = params.find((p) => p.name === "subUUID");
    expect(nameParam?.required).toBe(true);
    expect(emailParam?.required).toBe(true);
    expect(subParam?.required).toBe(false);
  });

  it("[CO-0028] rpc-params の company.updateCompanyName: name required・companyID optional", () => {
    const params = rpcParams["company.updateCompanyName"];
    expect(params).toBeDefined();
    const nameParam = params.find((p) => p.name === "name");
    const cidParam = params.find((p) => p.name === "companyID");
    expect(nameParam?.required).toBe(true);
    expect(cidParam?.required).toBe(false);
  });

  it("[CO-0028] rpc-params の company.getPaymentConfig: companyID optional", () => {
    const params = rpcParams["company.getPaymentConfig"];
    expect(params).toBeDefined();
    const cidParam = params.find((p) => p.name === "companyID");
    expect(cidParam?.required).toBe(false);
  });

  it("[CO-0028] rpc-params の company.getCompanies: timeoutMs optional", () => {
    expect(rpcParams).toHaveProperty("company.getCompanies");
    const getCompaniesParams = rpcParams["company.getCompanies"];
    const timeoutParam = getCompaniesParams.find((p) => p.name === "timeoutMs");
    expect(timeoutParam).toBeDefined();
    expect(timeoutParam.required).toBe(false);
  });

  it("[CO-0028] TypeScript SDK に company.{getCompanies,updateCompanyName,addCompany,getPaymentConfig} が存在", () => {
    expect(sdkTsText).toMatch(/readonly company\s*=/);
    expect(sdkTsText).toMatch(/addCompany.*company\.addCompany/);
    expect(sdkTsText).toMatch(/getCompanies.*company\.getCompanies/);
    expect(sdkTsText).toMatch(/getPaymentConfig.*company\.getPaymentConfig/);
    expect(sdkTsText).toMatch(/updateCompanyName.*company\.updateCompanyName/);
  });

  it("[CO-0028] TS SDK addCompany: name/employeeEmail required, subUUID optional", () => {
    const lines = sdkTsText.split("\n");
    const addLine = lines.find((l) => l.includes("addCompany:") && l.includes("_call"));
    expect(addLine).toBeDefined();
    // name と employeeEmail は required (?: なし)
    expect(addLine).toMatch(/name:\s*string/);
    expect(addLine).toMatch(/employeeEmail:\s*string/);
    // subUUID は optional (?: あり)
    expect(addLine).toMatch(/subUUID\?:/);
  });

  it("[CO-0028] TS SDK updateCompanyName: name required, companyID optional", () => {
    const lines = sdkTsText.split("\n");
    const line = lines.find((l) => l.includes("updateCompanyName:") && l.includes("_call"));
    expect(line).toBeDefined();
    expect(line).toMatch(/name:\s*string/);
    expect(line).toMatch(/companyID\?:/);
  });

  it("[CO-0028] TS SDK getPaymentConfig: companyID optional", () => {
    const lines = sdkTsText.split("\n");
    const line = lines.find((l) => l.includes("getPaymentConfig:") && l.includes("_call"));
    expect(line).toBeDefined();
    expect(line).toMatch(/companyID\?:/);
  });

  it("[CO-0028] Python SDK _Company に 4 メソッドが存在", () => {
    expect(sdkPyText).toMatch(/class _Company/);
    expect(sdkPyText).toContain("def addCompany(");
    expect(sdkPyText).toContain("def getCompanies(");
    expect(sdkPyText).toContain("def getPaymentConfig(");
    expect(sdkPyText).toContain("def updateCompanyName(");
  });

  it("[CO-0028] Python SDK addCompany: name/employeeEmail required, subUUID optional (None 既定)", () => {
    const lines = sdkPyText.split("\n");
    const line = lines.find((l) => l.includes("def addCompany("));
    expect(line).toBeDefined();
    expect(line).toMatch(/name:\s*str/);
    expect(line).toMatch(/employeeEmail:\s*str/);
    // subUUID は optional (デフォルト None)
    expect(line).toMatch(/subUUID.*None/);
  });

  it("[CO-0028] Python SDK updateCompanyName: name required, companyID optional", () => {
    const lines = sdkPyText.split("\n");
    const line = lines.find((l) => l.includes("def updateCompanyName("));
    expect(line).toBeDefined();
    expect(line).toMatch(/name:\s*str/);
    expect(line).toMatch(/companyID.*None/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// [CO-0029] proto CompanyRequest メッセージの必須/optional が core 契約と一致
// ═══════════════════════════════════════════════════════════════════════════════
describe("[CO-0029] proto CompanyRequest メッセージの必須/optional", () => {
  it("[CO-0029] CompanyGetCompaniesRequest: timeoutMs は optional", () => {
    expect(protoText).toContain("message CompanyGetCompaniesRequest");
    const getBlock = protoText.match(/message CompanyGetCompaniesRequest\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(getBlock).toMatch(/timeoutMs/);
    // name は存在しない
    expect(getBlock).not.toMatch(/\bname\b/);
  });

  it("[CO-0029] CompanyUpdateCompanyNameRequest: name は required (optional キーワードなし)・companyID は optional", () => {
    expect(protoText).toContain("message CompanyUpdateCompanyNameRequest");
    const block = protoText.match(/message CompanyUpdateCompanyNameRequest\s*\{([^}]*)\}/s)?.[1] ?? "";
    // name フィールドが存在し optional 修飾子が付いていない
    expect(block).toMatch(/\bname\b/);
    // name の行に optional が付いていない
    const nameLine = block.split("\n").find((l) => l.includes("name"));
    expect(nameLine).toBeDefined();
    expect(nameLine).not.toMatch(/optional.*name|name.*optional/);
    // companyID は optional
    expect(block).toMatch(/optional\s+string\s+companyID/);
  });

  it("[CO-0029] CompanyAddCompanyRequest: name/employeeEmail は required・subUUID は optional", () => {
    expect(protoText).toContain("message CompanyAddCompanyRequest");
    const block = protoText.match(/message CompanyAddCompanyRequest\s*\{([^}]*)\}/s)?.[1] ?? "";
    const lines = block.split("\n");
    const nameLine = lines.find((l) => /\bname\b/.test(l));
    const emailLine = lines.find((l) => /employeeEmail/.test(l));
    const subLine = lines.find((l) => /subUUID/.test(l));
    expect(nameLine).toBeDefined();
    expect(nameLine).not.toMatch(/^.*optional/);
    expect(emailLine).toBeDefined();
    expect(emailLine).not.toMatch(/^.*optional/);
    // subUUID は optional
    expect(subLine).toBeDefined();
    expect(subLine).toMatch(/optional/);
  });

  it("[CO-0029] CompanyGetPaymentConfigRequest: companyID は optional", () => {
    expect(protoText).toContain("message CompanyGetPaymentConfigRequest");
    const block = protoText.match(/message CompanyGetPaymentConfigRequest\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(block).toMatch(/optional\s+string\s+companyID/);
  });

  it("[CO-0029] grpc-methods.generated.json: Company* 4 エントリの optionalScalars が proto の optional と一致", () => {
    // CompanyGetCompanies: optionalScalars に timeoutMs
    expect(grpcMethods["CompanyGetCompanies"]).toBeDefined();
    expect(grpcMethods["CompanyGetCompanies"].optionalScalars).toContain("timeoutMs");
    expect(grpcMethods["CompanyGetCompanies"].method).toBe("company.getCompanies");
    // CompanyUpdateCompanyName: optionalScalars に companyID
    expect(grpcMethods["CompanyUpdateCompanyName"]).toBeDefined();
    expect(grpcMethods["CompanyUpdateCompanyName"].optionalScalars).toContain("companyID");
    expect(grpcMethods["CompanyUpdateCompanyName"].optionalScalars).not.toContain("name");
    expect(grpcMethods["CompanyUpdateCompanyName"].method).toBe("company.updateCompanyName");
    // CompanyAddCompany: optionalScalars に subUUID (name/employeeEmail は not optional)
    expect(grpcMethods["CompanyAddCompany"]).toBeDefined();
    expect(grpcMethods["CompanyAddCompany"].optionalScalars).toContain("subUUID");
    expect(grpcMethods["CompanyAddCompany"].optionalScalars).not.toContain("name");
    expect(grpcMethods["CompanyAddCompany"].optionalScalars).not.toContain("employeeEmail");
    expect(grpcMethods["CompanyAddCompany"].method).toBe("company.addCompany");
    // CompanyGetPaymentConfig: optionalScalars に companyID
    expect(grpcMethods["CompanyGetPaymentConfig"]).toBeDefined();
    expect(grpcMethods["CompanyGetPaymentConfig"].optionalScalars).toContain("companyID");
    expect(grpcMethods["CompanyGetPaymentConfig"].method).toBe("company.getPaymentConfig");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// [CO-0030] company.* カタログの ja ロケール未翻訳 (出力文言が英語のまま残る)
// ═══════════════════════════════════════════════════════════════════════════════
describe("[CO-0030] company.* カタログの ja 未翻訳キー検出", () => {
  const en = i18nCompany.en;
  const ja = i18nCompany.ja;

  const UNTRANSLATED_KEYS = [
    "company.ls.none",
    "company.ls.found.one",
    "company.ls.found.many",
    "company.rename.ok",
    "company.add.ok",
    "company.err.companyIDRequired",
    "company.err.nameRequired",
  ];

  it("[CO-0030] 7 キーが en===ja (未翻訳) であることを確認", () => {
    for (const key of UNTRANSLATED_KEYS) {
      expect(en[key], `en["${key}"] が存在する`).toBeDefined();
      expect(ja[key], `ja["${key}"] が存在する`).toBeDefined();
      expect(ja[key], `ja["${key}"] が en と同一 (未翻訳)`).toBe(en[key]);
    }
  });

  it("[CO-0030] 翻訳済みキーは en!=ja であることを確認 (cmd.desc / ls.desc / add.missingCustomerInfo)", () => {
    const TRANSLATED_KEYS = [
      "company.cmd.desc",
      "company.ls.desc",
      "company.add.missingCustomerInfo",
    ];
    for (const key of TRANSLATED_KEYS) {
      if (en[key] && ja[key]) {
        expect(ja[key], `ja["${key}"] は en と異なる (翻訳済み)`).not.toBe(en[key]);
      }
    }
  });

  it("[CO-0030] err.employeeEmailRequired / err.subUUIDRequired は翻訳済み (ja は英語以外)", () => {
    // ja では "login ユーザの customerInfo 由来" が含まれ en とは異なる
    expect(ja["company.err.employeeEmailRequired"]).not.toBe(en["company.err.employeeEmailRequired"]);
    expect(ja["company.err.subUUIDRequired"]).not.toBe(en["company.err.subUUIDRequired"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// [CO-0031] company.* カタログのキー集合 en↔ja 完全一致 (欠落/孤立キー無し)
// ═══════════════════════════════════════════════════════════════════════════════
describe("[CO-0031] company.* i18n カタログ en↔ja キー集合完全一致", () => {
  it("[CO-0031] en キー集合と ja キー集合が完全一致 (欠落・孤立なし)", () => {
    const enKeys = Object.keys(i18nCompany.en).sort();
    const jaKeys = Object.keys(i18nCompany.ja).sort();
    expect(enKeys).toEqual(jaKeys);
  });

  it("[CO-0031] en-only キーが空 (ja 欠落なし)", () => {
    const enKeys = new Set(Object.keys(i18nCompany.en));
    const jaKeys = new Set(Object.keys(i18nCompany.ja));
    const enOnly = [...enKeys].filter((k) => !jaKeys.has(k));
    expect(enOnly).toEqual([]);
  });

  it("[CO-0031] ja-only キーが空 (孤立 ja キーなし)", () => {
    const enKeys = new Set(Object.keys(i18nCompany.en));
    const jaKeys = new Set(Object.keys(i18nCompany.ja));
    const jaOnly = [...jaKeys].filter((k) => !enKeys.has(k));
    expect(jaOnly).toEqual([]);
  });

  it("[CO-0031] en/ja とも 17 キーを持つ", () => {
    // spec note: 検証済 en/ja とも 17 キー
    expect(Object.keys(i18nCompany.en)).toHaveLength(17);
    expect(Object.keys(i18nCompany.ja)).toHaveLength(17);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// [CO-0032] getCompanies の isFromApp 送信抑止は lib 非移植 (負の事実)
// ═══════════════════════════════════════════════════════════════════════════════
describe("[CO-0032] getCompanies は isFromApp 分岐を持たず常に送信する", () => {
  it("[CO-0032] getCompanies は条件なしで biz3ManageCompany/get を送る (isFromApp ガードなし)", async () => {
    const c = mockClient({ success: true, data: [] });
    await getCompanies(c);
    // 送信が 1 件 (ガードで抑止されない)
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toMatchObject({ action: "biz3ManageCompany", op: "get" });
  });

  it("[CO-0032] getCompanies に fromType/isFromApp フィールドを送信しない (UI 概念の排除)", async () => {
    const c = mockClient({ success: true, data: [] });
    await getCompanies(c);
    expect(c.sent[0]).not.toHaveProperty("fromType");
    expect(c.sent[0]).not.toHaveProperty("isFromApp");
  });

  it("[CO-0032] getCompanies の実装に fromType/isFromApp 文字列が含まれない (負の事実)", () => {
    // company.js ソーステキストを読み、isFromApp 参照がないことを確認
    const src = readFileSync(
      resolve(__dirname, "../../src/company.js"),
      "utf8",
    );
    expect(src).not.toContain("isFromApp");
    expect(src).not.toContain("fromType");
    expect(src).not.toContain("searchParams");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// [CO-0033] updateCompanyName/addCompany/getPaymentConfig の success:false 拒否
// ═══════════════════════════════════════════════════════════════════════════════
describe("[CO-0033] updateCompanyName/addCompany/getPaymentConfig の success:false → rejected throw", () => {
  it("[CO-0033] updateCompanyName: success:false で SesameError(code=rejected, retryable=false) を throw する", async () => {
    const c = mockClient({ success: false, message: "updateName-error" });
    await expect(
      updateCompanyName(c, { companyID: "ch_A", name: "X" }),
    ).rejects.toMatchObject({
      code: ERR.REJECTED,
      retryable: false,
    });
  });

  it("[CO-0033] addCompany: success:false で SesameError(code=rejected, retryable=false) を throw する", async () => {
    const c = mockClient({ success: false, message: "add-error" });
    await expect(
      addCompany(c, { name: "N", employeeEmail: "e@e.com", subUUID: "u" }),
    ).rejects.toMatchObject({
      code: ERR.REJECTED,
      retryable: false,
    });
  });

  it("[CO-0033] getPaymentConfig: success:false で SesameError(code=rejected, retryable=false) を throw する", async () => {
    const c = mockClient({ success: false, message: "payment-error" });
    await expect(
      getPaymentConfig(c, { companyID: "ch_A" }),
    ).rejects.toMatchObject({
      code: ERR.REJECTED,
      retryable: false,
    });
  });

  it("[CO-0033] エラーメッセージは '<op> failed: <message>' 形式で伝播する", async () => {
    const c1 = mockClient({ success: false, message: "updateName-error" });
    await expect(
      updateCompanyName(c1, { companyID: "ch_A", name: "X" }),
    ).rejects.toThrow(/updateCompanyName failed: updateName-error/);

    const c2 = mockClient({ success: false, message: "add-error" });
    await expect(
      addCompany(c2, { name: "N", employeeEmail: "e@e.com", subUUID: "u" }),
    ).rejects.toThrow(/addCompany failed: add-error/);

    const c3 = mockClient({ success: false, message: "payment-error" });
    await expect(
      getPaymentConfig(c3, { companyID: "ch_A" }),
    ).rejects.toThrow(/getPaymentConfig failed: payment-error/);
  });

  it("[CO-0033] success:true の場合は throw しない (境界確認)", async () => {
    const c = mockClient({ success: true, data: { companyID: "ch_A", name: "X" } });
    await expect(
      updateCompanyName(c, { companyID: "ch_A", name: "X" }),
    ).resolves.not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// [CO-0034] company 4 op の応答待ちタイムアウト経路
// ═══════════════════════════════════════════════════════════════════════════════
describe("[CO-0034] company 4 op の timeout 経路", () => {
  it("[CO-0034] TRANSPORT_ERR.TIMEOUT が 'TRANSPORT_TIMEOUT' であること", () => {
    expect(TRANSPORT_ERR.TIMEOUT).toBe("TRANSPORT_TIMEOUT");
  });

  it("[CO-0034] getCompanies は request に timeoutMs を渡す (DEFAULT_TIMEOUT_MS=10_000)", async () => {
    let capturedTimeout;
    const c = {
      sent: [],
      async request(frame, timeoutMs) {
        capturedTimeout = timeoutMs;
        this.sent.push(frame);
        return { success: true, data: [] };
      },
    };
    await getCompanies(c);
    // デフォルト timeout = 10_000
    expect(capturedTimeout).toBe(10_000);
  });

  it("[CO-0034] updateCompanyName は request に timeoutMs を渡す (DEFAULT_TIMEOUT_MS=10_000)", async () => {
    let capturedTimeout;
    const c = {
      sent: [],
      async request(frame, timeoutMs) {
        capturedTimeout = timeoutMs;
        this.sent.push(frame);
        return { success: true, data: { companyID: "ch_A", name: "X" } };
      },
    };
    await updateCompanyName(c, { companyID: "ch_A", name: "X" });
    expect(capturedTimeout).toBe(10_000);
  });

  it("[CO-0034] addCompany は request に timeoutMs を渡す (DEFAULT_TIMEOUT_MS=10_000)", async () => {
    let capturedTimeout;
    const c = {
      sent: [],
      async request(frame, timeoutMs) {
        capturedTimeout = timeoutMs;
        this.sent.push(frame);
        return { success: true, data: null };
      },
    };
    await addCompany(c, { name: "N", employeeEmail: "e@e.com", subUUID: "u" });
    expect(capturedTimeout).toBe(10_000);
  });

  it("[CO-0034] getPaymentConfig は request に timeoutMs を渡す (DEFAULT_TIMEOUT_MS=10_000)", async () => {
    let capturedTimeout;
    const c = {
      sent: [],
      async request(frame, timeoutMs) {
        capturedTimeout = timeoutMs;
        this.sent.push(frame);
        return { success: true, data: null };
      },
    };
    await getPaymentConfig(c, { companyID: "ch_A" });
    expect(capturedTimeout).toBe(10_000);
  });

  it("[CO-0034] timeoutMs パラメータを明示した場合は既定を上書きする", async () => {
    let capturedTimeout;
    const c = {
      sent: [],
      async request(frame, timeoutMs) {
        capturedTimeout = timeoutMs;
        this.sent.push(frame);
        return { success: true, data: [] };
      },
    };
    await getCompanies(c, { timeoutMs: 5_000 });
    expect(capturedTimeout).toBe(5_000);
  });

  it("[CO-0034] company 4 op は client.request を直接呼ぶ (subscribeChunks 非経由) — 全 op が sent に 1 フレーム記録", async () => {
    // subscribeChunks は send + subscribe を使うが、company op は request のみ使う
    const c1 = mockClient({ success: true, data: [] });
    await getCompanies(c1);
    expect(c1.sent).toHaveLength(1);

    const c2 = mockClient({ success: true, data: { companyID: "ch_A", name: "x" } });
    await updateCompanyName(c2, { companyID: "ch_A", name: "x" });
    expect(c2.sent).toHaveLength(1);

    const c3 = mockClient({ success: true, data: { companyID: "ch_new" } });
    await addCompany(c3, { name: "n", employeeEmail: "e@x.com", subUUID: "u" });
    expect(c3.sent).toHaveLength(1);

    const c4 = mockClient({ success: true, data: null });
    await getPaymentConfig(c4, { companyID: "ch_A" });
    expect(c4.sent).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// [CO-0035] updateName 応答の merge 述語 (companyID 一致 company のみ name 差替・他は不変)
// ═══════════════════════════════════════════════════════════════════════════════
describe("[CO-0035] updateCompanyName 応答の merge 述語", () => {
  it("[CO-0035] updateCompanyName は {companyID,name} を返す (consumer が map で使う一次データ)", async () => {
    const c = mockClient({ success: true, data: { companyID: "ch_A", name: "新名" } });
    const r = await updateCompanyName(c, { companyID: "ch_A", name: "新名" });
    expect(r).toEqual({ companyID: "ch_A", name: "新名" });
  });

  it("[CO-0035] web .map 述語: company.companyID===data.companyID の会社のみ name 差替、他は不変", () => {
    // web useStripeInfo.js:168-172 の述語を純関数として固定
    const data = { companyID: "ch_A", name: "新名" };
    const companies = [
      { companyID: "ch_A", name: "旧名", isSesameApp: false },
      { companyID: "ch_B", name: "他社",  isSesameApp: false },
    ];
    const merged = companies.map((c) =>
      c.companyID === data.companyID ? { ...c, name: data.name } : c,
    );
    // ch_A の name が差し替わる
    expect(merged[0].name).toBe("新名");
    expect(merged[0].companyID).toBe("ch_A");
    // ch_B は不変
    expect(merged[1].name).toBe("他社");
    expect(merged[1].companyID).toBe("ch_B");
    // ch_A の他フィールドは維持される
    expect(merged[0].isSesameApp).toBe(false);
  });

  it("[CO-0035] 非一致要素は name を含め全フィールドが不変 (選択的 merge)", () => {
    const companies = [
      { companyID: "ch_X", name: "X社", feeLevel: { level: 2 }, tag: ["Admin"] },
      { companyID: "ch_Y", name: "Y社", feeLevel: { level: 1 }, tag: [] },
    ];
    const data = { companyID: "ch_X", name: "X社 (改名)" };

    const merged = companies.map((c) =>
      c.companyID === data.companyID ? { ...c, name: data.name } : c,
    );

    // ch_Y は全フィールドが不変
    expect(merged[1]).toEqual(companies[1]);
    // ch_X は name のみ差し替わり他フィールドは保持される
    expect(merged[0].feeLevel).toEqual({ level: 2 });
    expect(merged[0].tag).toEqual(["Admin"]);
    expect(merged[0].name).toBe("X社 (改名)");
  });

  it("[CO-0035] data 欠落時は undefined を返す (consumer の map が undefined.companyID で誤評価しない分岐)", async () => {
    const c = mockClient({ success: true });
    const r = await updateCompanyName(c, { companyID: "ch_A", name: "新名" });
    // data 欠落時 undefined (BIZ-10: 捏造しない)
    expect(r).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// [CO-0036] web は login 応答直後に getCompanies を自動発火 / kit は明示呼び出しのみ (lifecycle 負の事実)
// ═══════════════════════════════════════════════════════════════════════════════
describe("[CO-0036] kit は login 後の getCompanies 自動連鎖なし (lifecycle 負の事実)", () => {
  it("[CO-0036] client.js の refreshAccount 実装に getCompanies の自動呼び出しが含まれない", () => {
    const clientSrc = readFileSync(
      resolve(__dirname, "../../src/client.js"),
      "utf8",
    );
    // refreshAccount の実装ブロック内で getCompanies を呼んでいないことを確認
    const refreshAccountIdx = clientSrc.indexOf("refreshAccount");
    const refreshAccountSection = clientSrc.slice(refreshAccountIdx, refreshAccountIdx + 1500);
    // getCompanies を呼んでいないこと (自動連鎖の負の事実)
    expect(refreshAccountSection).not.toMatch(/getCompanies\s*\(/);
  });

  it("[CO-0036] CLI company ls は withAccount の後に getCompanies を明示呼び出しする", async () => {
    const getCompaniesMock = vi.fn(async () => []);
    const hub = { company: { getCompanies: getCompaniesMock } };
    const ctx = makeCtx({ hub, json: true });
    const program = buildProgram(ctx);

    await program.parseAsync(["company", "ls"], { from: "user" });

    // CLI が明示的に getCompanies() を呼ぶ
    expect(getCompaniesMock).toHaveBeenCalledOnce();
  });

  it("[CO-0036] company ls の getCompanies 呼び出しは引数なし (companyID 不要)", async () => {
    const getCompaniesMock = vi.fn(async () => []);
    const hub = { company: { getCompanies: getCompaniesMock } };
    const ctx = makeCtx({ hub, json: true });
    const program = buildProgram(ctx);

    await program.parseAsync(["company", "ls"], { from: "user" });

    expect(getCompaniesMock).toHaveBeenCalledOnce();
    // 引数なし = getCompanies()
    expect(getCompaniesMock.mock.calls[0]).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// [CO-0037] getPaymentConfig の必須検証はリテラル 'companyID required'
//           (updateCompanyName の i18n key と別経路)
// ═══════════════════════════════════════════════════════════════════════════════
describe("[CO-0037] companyID 必須エラーの生成経路 (literal vs i18n key 不統一)", () => {
  it("[CO-0037] getPaymentConfig: companyID 欠落で SesameError(BAD_REQUEST) throw し文言は 'companyID required'", async () => {
    const c = mockClient({ success: true });
    let err;
    try {
      await getPaymentConfig(c, {});
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(err.message).toMatch(/companyID required/);
  });

  it("[CO-0037] updateCompanyName: companyID 欠落で SesameError(BAD_REQUEST) throw し文言は 'companyID required'", async () => {
    const c = mockClient({ success: true });
    let err;
    try {
      await updateCompanyName(c, { name: "X" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(err.message).toMatch(/companyID required/);
  });

  it("[CO-0037] 両エラー文言は同一 (i18n company.err.companyIDRequired = 'companyID required')", () => {
    // i18n/company.js の en 値が 'companyID required' であることを確認
    expect(i18nCompany.en["company.err.companyIDRequired"]).toBe("companyID required");
    // ja も同一 (未翻訳)
    expect(i18nCompany.ja["company.err.companyIDRequired"]).toBe("companyID required");
  });

  it("[CO-0037] getPaymentConfig の実装はリテラル文字列を badRequest に渡す (i18n key ではない)", () => {
    const src = readFileSync(
      resolve(__dirname, "../../src/company.js"),
      "utf8",
    );
    // getPaymentConfig 内の badRequest 呼び出しがリテラル文字列を使う
    const getPaymentBlock = src.match(/getPaymentConfig[\s\S]{0,500}?badRequest\([^)]*\)/)?.[0] ?? "";
    expect(getPaymentBlock).toContain("companyID required");
    // i18n key ではなくリテラル文字列
    expect(getPaymentBlock).not.toContain("company.err.companyIDRequired");
  });

  it("[CO-0037] updateCompanyName の実装は i18n key 'company.err.companyIDRequired' を badRequest に渡す", () => {
    const src = readFileSync(
      resolve(__dirname, "../../src/company.js"),
      "utf8",
    );
    // updateCompanyName 内の badRequest 呼び出しが i18n key を使う
    const updateBlock = src.match(/updateCompanyName[\s\S]{0,300}?badRequest\([^)]*\)/)?.[0] ?? "";
    expect(updateBlock).toContain("company.err.companyIDRequired");
  });

  it("[CO-0037] 両 op の最終出力文言は同一 'companyID required' (内部経路が異なっても同じ結果)", async () => {
    const c1 = mockClient({ success: true });
    const c2 = mockClient({ success: true });

    let errGet, errUpdate;
    try { await getPaymentConfig(c1, {}); } catch (e) { errGet = e; }
    try { await updateCompanyName(c2, { name: "x" }); } catch (e) { errUpdate = e; }

    // 両 op の最終文言は同一であること (内部経路差異にもかかわらず)
    expect(errGet.message).toMatch(/companyID required/);
    expect(errUpdate.message).toMatch(/companyID required/);
    // 両者の文言が実際に同一文字列であること
    expect(errGet.message).toBe(errUpdate.message);
  });
});
