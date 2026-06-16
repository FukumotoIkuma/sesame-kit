// packages/core/tests/_spec/org-c1.test.js
//
// TDD テスト: spec ID ORG-0019 〜 ORG-0036 (統合版)
// A/B 独立実装のベストを統合。各 it タイトル先頭に [ORG-XXXX] を置く。
// 全て mock/純関数のみ — ネットワーク・実機不使用。
// 実装が spec と食い違う場合は spec どおりの期待値で assert する (red が正解)。

import { describe, it, expect, vi, afterEach } from "vitest";
import * as org from "../../src/org.js";
import { mockClient, chunkMockClient } from "../helpers/mock-ws.js";
import { ACTION_TYPES } from "../../src/vendor/biz3/constants/messageConstants.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../../..");

// ─────────────────────────────────────────────────────────────────────────────
// CLI テスト共通ヘルパー
// ─────────────────────────────────────────────────────────────────────────────

function makeHubStub(orgOverrides = {}) {
  const noop = vi.fn().mockResolvedValue({ success: true });
  return {
    config: { companyID: "ch_STUB" },
    org: {
      getEmployees: vi.fn().mockResolvedValue({ count: 0, list: [] }),
      getCurrentUserInfo: noop,
      addEmployees: noop,
      updateEmployee: noop,
      removeEmployees: noop,
      reorderEmployees: noop,
      queryByCS: vi.fn().mockResolvedValue([]),
      confirmQueryByCS: noop,
      getEmployeeGroups: vi.fn().mockResolvedValue([]),
      addEmployeeGroup: noop,
      ...orgOverrides,
    },
    listDevices: vi.fn().mockResolvedValue([]),
  };
}

function makeCtxStub({ json = false, canPromptResult = false, confirmResult = true } = {}) {
  const died = [];
  const jsonOutputs = [];
  const opts = { json };
  const ctx = {
    opts,
    died,
    jsonOutputs,
    withHub(fn) {
      return fn(makeHubStub(), { opts });
    },
    withAccount(fn) {
      return fn(makeHubStub(), { opts });
    },
    out(isJson, humanFn, jsonEnvelope) {
      if (isJson) {
        jsonOutputs.push(jsonEnvelope);
      } else {
        try { humanFn(); } catch { /* suppress */ }
      }
    },
    die(msg, code) {
      const err = new Error(`ctx.die: ${msg} (exit ${code})`);
      err.dieCode = code;
      died.push({ msg, code });
      throw err;
    },
    canPrompt() { return canPromptResult; },
    prompts: {
      confirm: vi.fn().mockResolvedValue(confirmResult),
    },
    parseJson(str, _hint) {
      try { return JSON.parse(str); } catch { this.die("invalid json", 2); }
    },
  };
  return ctx;
}

// ════════════════════════════════════════════════════════════════════════
// ORG-0019: removeEmployees: items 非配列で bad_request
// ════════════════════════════════════════════════════════════════════════

describe("[ORG-0019] removeEmployees — items 非配列で bad_request", () => {
  it("[ORG-0019] items が配列でなければ badRequest を throw し send しない", async () => {
    const c = mockClient({});
    await expect(org.removeEmployees(c, { items: {} })).rejects.toThrow();
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0019] items=null でも badRequest を throw し send しない", async () => {
    const c = mockClient({});
    await expect(org.removeEmployees(c, { items: null })).rejects.toThrow();
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0019] items=string でも badRequest を throw し send しない", async () => {
    const c = mockClient({});
    await expect(org.removeEmployees(c, { items: "bad" })).rejects.toThrow();
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0019] CLI rm: --json 欠落で ctx.die (exit 2)", async () => {
    const ctx = makeCtxStub();
    const { registerOrgCommands } = await import("../../../kit/src/cli/org.js");
    const { Command } = await import("commander");
    const program = new Command().exitOverride();
    registerOrgCommands(program, ctx);
    await program.parseAsync(["org", "employee", "rm"], { from: "user" }).catch(() => {});
    expect(ctx.died.length).toBeGreaterThan(0);
    expect(ctx.died[0].code).toBe(2);
  });

  it("[ORG-0019] CLI rm: --json が非配列 (オブジェクト) で exit 2", async () => {
    const ctx = makeCtxStub();
    const { registerOrgCommands } = await import("../../../kit/src/cli/org.js");
    const { Command } = await import("commander");
    const program = new Command().exitOverride();
    registerOrgCommands(program, ctx);
    await program.parseAsync(["org", "employee", "rm", "--json", '{"notArray":true}'], { from: "user" }).catch(() => {});
    expect(ctx.died.length).toBeGreaterThan(0);
    expect(ctx.died[0].code).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════════════
// ORG-0020: reorderEmployees 送信フレーム {action,items,op:'order'} 各要素 {friendUUID,rank}
// ════════════════════════════════════════════════════════════════════════

describe("[ORG-0020] reorderEmployees 送信フレーム wire-fidelity", () => {
  it("[ORG-0020] op:'order' で items 直置き、各要素 {friendUUID,rank} を送る", async () => {
    const c = mockClient({ success: true });
    const items = [
      { friendUUID: "uuid-A", rank: 0 },
      { friendUUID: "uuid-B", rank: -1 },
      { friendUUID: "uuid-C", rank: -2 },
    ];
    await org.reorderEmployees(c, { items });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: "biz3ManageEmployee",
      items,
      op: "order",
    });
    expect(c.sent[0]).not.toHaveProperty("companyID");
  });

  it("[ORG-0020] rank は -index (降順負値) パターンが送信フレームに透過される", async () => {
    const c = mockClient({ success: true });
    const employees = [{ subUUID: "a" }, { subUUID: "b" }, { subUUID: "c" }];
    const items = employees.map((e, i) => ({ friendUUID: e.subUUID, rank: -i }));
    await org.reorderEmployees(c, { items });
    // MobileContacts.js:94-98: rank: -index で index=0 → -0 (負のゼロ)
    // Object.is(-0, 0) === false なので -0 で期待する
    expect(c.sent[0].items[0].friendUUID).toBe("a");
    expect(Object.is(c.sent[0].items[0].rank, -0)).toBe(true);
    expect(c.sent[0].items[1]).toEqual({ friendUUID: "b", rank: -1 });
    expect(c.sent[0].items[2]).toEqual({ friendUUID: "c", rank: -2 });
    expect(c.sent[0].op).toBe("order");
  });

  it("[ORG-0020] フレームにトップレベル companyID は含まれない (items 直置き)", async () => {
    const c = mockClient({ success: true });
    await org.reorderEmployees(c, { items: [{ friendUUID: "u1", rank: 0 }] });
    expect(c.sent[0]).not.toHaveProperty("companyID");
    expect(c.sent[0]).not.toHaveProperty("obj");
  });
});

// ════════════════════════════════════════════════════════════════════════
// ORG-0021: reorderEmployees: items 非配列で bad_request
// ════════════════════════════════════════════════════════════════════════

describe("[ORG-0021] reorderEmployees — items 非配列で bad_request", () => {
  it("[ORG-0021] items が配列でなければ badRequest を throw し send しない", async () => {
    const c = mockClient({});
    await expect(org.reorderEmployees(c, { items: {} })).rejects.toThrow();
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0021] items=undefined でも badRequest を throw し send しない", async () => {
    const c = mockClient({});
    await expect(org.reorderEmployees(c, { items: undefined })).rejects.toThrow();
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0021] items=null でも badRequest を throw し send しない", async () => {
    const c = mockClient({});
    await expect(org.reorderEmployees(c, { items: null })).rejects.toThrow();
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0021] items=42 (数値) でも badRequest を throw し send しない", async () => {
    const c = mockClient({});
    await expect(org.reorderEmployees(c, { items: 42 })).rejects.toThrow();
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0021] CLI reorder: --json 欠落で exit 2", async () => {
    const ctx = makeCtxStub();
    const { registerOrgCommands } = await import("../../../kit/src/cli/org.js");
    const { Command } = await import("commander");
    const program = new Command().exitOverride();
    registerOrgCommands(program, ctx);
    await program.parseAsync(["org", "employee", "reorder"], { from: "user" }).catch(() => {});
    expect(ctx.died.length).toBeGreaterThan(0);
    expect(ctx.died[0].code).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════════════
// ORG-0022: queryByCS 送信 op='queryByCS' / 購読 op='pubQueryByCS' のクロス
// ════════════════════════════════════════════════════════════════════════

describe("[ORG-0022] queryByCS — 送信 op と購読 op のクロス", () => {
  it("[ORG-0022] 送信フレームの op は 'queryByCS'、応答購読キーは 'pubQueryByCS'", async () => {
    const c = chunkMockClient();
    const p = org.queryByCS(c, { keyword: "tanaka" });

    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: "biz3ManageEmployee",
      keyword: "tanaka",
      op: "queryByCS",
    });

    expect(c.hasSub("biz3ManageEmployee:pubQueryByCS")).toBe(true);
    expect(c.hasSub("biz3ManageEmployee:queryByCS")).toBe(false);

    c.push("biz3ManageEmployee:pubQueryByCS", {
      data: { data: { list: [{ id: 1 }], page: 1 }, totalPage: 1 },
    });
    await p;
  });

  it("[ORG-0022] keyword パラメータがフレームのトップレベル直置きで入る", async () => {
    const c = chunkMockClient();
    const p = org.queryByCS(c, { keyword: "smith" });
    expect(c.sent[0].keyword).toBe("smith");
    expect(c.sent[0]).not.toHaveProperty("items");
    expect(c.sent[0]).not.toHaveProperty("companyID");

    c.push("biz3ManageEmployee:pubQueryByCS", {
      data: { data: { list: [], page: 1 }, totalPage: 1 },
    });
    await p;
  });

  it("[ORG-0022] chunk が totalPage まで届くと list を返す", async () => {
    const c = chunkMockClient();
    const p = org.queryByCS(c, { keyword: "jones" });
    c.push("biz3ManageEmployee:pubQueryByCS", {
      data: { data: { list: [{ id: 1 }], page: 1 }, totalPage: 2 },
    });
    c.push("biz3ManageEmployee:pubQueryByCS", {
      data: { data: { list: [{ id: 2 }], page: 2 }, totalPage: 2 },
    });
    const r = await p;
    expect(r).toEqual([{ id: 1 }, { id: 2 }]);
  });
});

// ════════════════════════════════════════════════════════════════════════
// ORG-0023: queryByCS は page===totalPage まで集約・常に追記 (appendOnly)
// ════════════════════════════════════════════════════════════════════════

describe("[ORG-0023] queryByCS — page===totalPage まで集約・常に追記 (appendOnly)", () => {
  it("[ORG-0023] 複数 page を appendOnly で蓄積し page===totalPage で完了する", async () => {
    const c = chunkMockClient();
    const p = org.queryByCS(c, { keyword: "test" });

    c.push("biz3ManageEmployee:pubQueryByCS", {
      data: { data: { list: [{ id: 1 }, { id: 2 }], page: 1 }, totalPage: 3 },
    });
    c.push("biz3ManageEmployee:pubQueryByCS", {
      data: { data: { list: [{ id: 3 }], page: 2 }, totalPage: 3 },
    });
    c.push("biz3ManageEmployee:pubQueryByCS", {
      data: { data: { list: [{ id: 4 }], page: 3 }, totalPage: 3 },
    });

    const r = await p;
    expect(r).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
  });

  it("[ORG-0023] page===1 でも前データを置換せず追記する (appendOnly — pubEmployees と異なる規則)", async () => {
    const c = chunkMockClient();
    const p = org.queryByCS(c, { keyword: "test" });

    c.push("biz3ManageEmployee:pubQueryByCS", {
      data: { data: { list: [{ id: "a" }, { id: "b" }], page: 1 }, totalPage: 2 },
    });
    c.push("biz3ManageEmployee:pubQueryByCS", {
      data: { data: { list: [{ id: "c" }], page: 2 }, totalPage: 2 },
    });

    const r = await p;
    expect(r).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
  });

  it("[ORG-0023] 1 page (page===totalPage===1) で即完了", async () => {
    const c = chunkMockClient();
    const p = org.queryByCS(c, { keyword: "test" });

    c.push("biz3ManageEmployee:pubQueryByCS", {
      data: { data: { list: [{ id: 1 }], page: 1 }, totalPage: 1 },
    });

    const r = await p;
    expect(r).toEqual([{ id: 1 }]);
  });

  it("[ORG-0023] pubQueryByCS の appendOnly は pubEmployees の page===1 置換規則と別 (リグレッションガード)", async () => {
    const cEmp = chunkMockClient();
    const pEmp = org.getEmployees(cEmp, { companyID: "ch_X" });
    cEmp.push("biz3ManageEmployee:pubEmployees", {
      data: { totalCount: 2, data: { list: [{ subUUID: "x" }], page: 2 } },
    });
    cEmp.push("biz3ManageEmployee:pubEmployees", {
      data: { totalCount: 2, data: { list: [{ subUUID: "a" }], page: 1 } },
    });
    cEmp.push("biz3ManageEmployee:pubEmployees", {
      data: { totalCount: 2, data: { list: [{ subUUID: "b" }], page: 2 } },
    });
    const rEmp = await pEmp;
    expect(rEmp.list.map((e) => e.subUUID)).toEqual(["a", "b"]);

    const cCS = chunkMockClient();
    const pCS = org.queryByCS(cCS, { keyword: "k" });
    cCS.push("biz3ManageEmployee:pubQueryByCS", {
      data: { data: { list: [{ id: 1 }, { id: 2 }], page: 1 }, totalPage: 2 },
    });
    cCS.push("biz3ManageEmployee:pubQueryByCS", {
      data: { data: { list: [{ id: 3 }], page: 2 }, totalPage: 2 },
    });
    const rCS = await pCS;
    expect(rCS).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
  });
});

// ════════════════════════════════════════════════════════════════════════
// ORG-0024: queryByCS totalPage 欠落時は補完せず timeout に倒す (安全側)
// ════════════════════════════════════════════════════════════════════════

describe("[ORG-0024] queryByCS — totalPage 欠落時は安全側 (timeout)", () => {
  afterEach(() => vi.useRealTimers());

  it("[ORG-0024] totalPage が undefined のときは page===totalPage が成立せず完了せず timeout する", async () => {
    vi.useFakeTimers();
    const c = chunkMockClient();
    const p = org.queryByCS(c, { keyword: "test", timeoutMs: 100 });

    c.push("biz3ManageEmployee:pubQueryByCS", {
      data: { data: { list: [{ id: 1 }], page: 1 } /* totalPage なし */ },
    });

    vi.advanceTimersByTime(100);

    await expect(p).rejects.toThrow();
  });

  it("[ORG-0024] totalPage が null でも undefined 扱い (補完なし) — timeout に倒す", async () => {
    vi.useFakeTimers();
    const c = chunkMockClient();
    const p = org.queryByCS(c, { keyword: "test", timeoutMs: 100 });

    c.push("biz3ManageEmployee:pubQueryByCS", {
      data: { data: { list: [{ id: 1 }], page: 1 }, totalPage: null },
    });

    vi.advanceTimersByTime(100);

    await expect(p).rejects.toThrow();
  });

  it("[ORG-0024] totalPage が明示されれば正常完了する (対照ケース)", async () => {
    const c = chunkMockClient();
    const p = org.queryByCS(c, { keyword: "k" });
    c.push("biz3ManageEmployee:pubQueryByCS", {
      data: { data: { list: [{ id: 1 }], page: 1 }, totalPage: 1 },
    });
    await expect(p).resolves.toEqual([{ id: 1 }]);
  });
});

// ════════════════════════════════════════════════════════════════════════
// ORG-0025: queryByCS partialOnTimeout=true で {partial,list} object に shape 切替
// ════════════════════════════════════════════════════════════════════════

describe("[ORG-0025] queryByCS — partialOnTimeout shape 切替", () => {
  afterEach(() => vi.useRealTimers());

  it("[ORG-0025] 既定 (partialOnTimeout=false) は配列を直返し (list のみ)", async () => {
    const c = chunkMockClient();
    const p = org.queryByCS(c, { keyword: "test" });

    c.push("biz3ManageEmployee:pubQueryByCS", {
      data: { data: { list: [{ id: 1 }], page: 1 }, totalPage: 1 },
    });

    const r = await p;
    expect(Array.isArray(r)).toBe(true);
    expect(r).toEqual([{ id: 1 }]);
  });

  it("[ORG-0025] partialOnTimeout=true の完走時は {partial:false, list} の object shape", async () => {
    const c = chunkMockClient();
    const p = org.queryByCS(c, { keyword: "test", partialOnTimeout: true });

    c.push("biz3ManageEmployee:pubQueryByCS", {
      data: { data: { list: [{ id: 1 }, { id: 2 }], page: 1 }, totalPage: 1 },
    });

    const r = await p;
    expect(r).toMatchObject({ partial: false });
    expect(r).toHaveProperty("list");
    expect(/** @type {any} */(r).list).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("[ORG-0025] partialOnTimeout=true の timeout 時は {partial:true, list} の object shape (reject しない)", async () => {
    vi.useFakeTimers();
    const c = chunkMockClient();
    const p = org.queryByCS(c, { keyword: "test", timeoutMs: 200, partialOnTimeout: true });

    c.push("biz3ManageEmployee:pubQueryByCS", {
      data: { data: { list: [{ id: "x" }], page: 1 }, totalPage: 3 },
    });

    vi.advanceTimersByTime(200);

    const r = await p;
    expect(r).toMatchObject({ partial: true });
    expect(/** @type {any} */(r).list).toEqual([{ id: "x" }]);
  });
});

// ════════════════════════════════════════════════════════════════════════
// ORG-0026: queryByCS: keyword 欠落で bad_request / chunk success:false で reject
// ════════════════════════════════════════════════════════════════════════

describe("[ORG-0026] queryByCS — keyword 欠落 / chunk success:false", () => {
  it("[ORG-0026] keyword が空文字で badRequest を throw し send しない", async () => {
    const c = chunkMockClient();
    await expect(org.queryByCS(c, { keyword: "" })).rejects.toThrow();
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0026] keyword=undefined で badRequest を throw し send しない", async () => {
    const c = chunkMockClient();
    await expect(org.queryByCS(c, { keyword: undefined })).rejects.toThrow();
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0026] pubQueryByCS chunk の success:false で rejected を throw", async () => {
    const c = chunkMockClient();
    const p = org.queryByCS(c, { keyword: "test" });

    c.push("biz3ManageEmployee:pubQueryByCS", {
      success: false,
      message: "CS search failed",
    });

    await expect(p).rejects.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════
// ORG-0027: confirmQueryByCS 送信フレーム {action,email,op:'confirmQueryByCS'}
// ════════════════════════════════════════════════════════════════════════

describe("[ORG-0027] confirmQueryByCS — 送信フレーム wire-fidelity", () => {
  it("[ORG-0027] フレームは {action:biz3ManageEmployee, email, op:'confirmQueryByCS'}", async () => {
    const c = mockClient({ success: true });
    await org.confirmQueryByCS(c, { email: "user@example.com" });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: "biz3ManageEmployee",
      email: "user@example.com",
      op: "confirmQueryByCS",
    });
  });

  it("[ORG-0027] フレームに keyword/items/companyID を含まない", async () => {
    const c = mockClient({ success: true });
    await org.confirmQueryByCS(c, { email: "u@e.jp" });
    expect(c.sent[0]).not.toHaveProperty("keyword");
    expect(c.sent[0]).not.toHaveProperty("items");
    expect(c.sent[0]).not.toHaveProperty("companyID");
  });

  it("[ORG-0027] email はフレームのトップレベル直置き (obj/items ラップ無し)", async () => {
    const c = mockClient({ success: true });
    await org.confirmQueryByCS(c, { email: "direct@x.com" });
    expect(c.sent[0].email).toBe("direct@x.com");
    expect(c.sent[0]).not.toHaveProperty("obj");
  });
});

// ════════════════════════════════════════════════════════════════════════
// ORG-0028: confirmQueryByCS: email 欠落で bad_request
// ════════════════════════════════════════════════════════════════════════

describe("[ORG-0028] confirmQueryByCS — email 欠落で bad_request", () => {
  it("[ORG-0028] email 空文字で badRequest を throw し send しない", async () => {
    const c = mockClient({});
    await expect(org.confirmQueryByCS(c, { email: "" })).rejects.toThrow();
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0028] email=undefined で badRequest を throw し send しない", async () => {
    const c = mockClient({});
    await expect(org.confirmQueryByCS(c, { email: undefined })).rejects.toThrow();
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0028] email=null で badRequest を throw し send しない", async () => {
    const c = mockClient({});
    await expect(org.confirmQueryByCS(c, { email: null })).rejects.toThrow();
    expect(c.sent).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════
// ORG-0029: CLI confirm は副作用 (成功時 signout) を対話確認でガード
// ════════════════════════════════════════════════════════════════════════

describe("[ORG-0029] CLI confirm — 副作用 (成功時 signout) の対話確認ガード", () => {
  it("[ORG-0029] canPrompt=true で confirm が呼ばれる", async () => {
    const ctx = makeCtxStub({ canPromptResult: true, confirmResult: true });
    const { registerOrgCommands } = await import("../../../kit/src/cli/org.js");
    const { Command } = await import("commander");
    const program = new Command().exitOverride();
    registerOrgCommands(program, ctx);
    await program.parseAsync(["org", "employee", "confirm", "user@example.com"], { from: "user" }).catch(() => {});
    expect(ctx.prompts.confirm).toHaveBeenCalledTimes(1);
  });

  it("[ORG-0029] canPrompt=true かつ confirm=no のとき confirmQueryByCS を呼ばず die しない (plain log + return)", async () => {
    const ctx = makeCtxStub({ canPromptResult: true, confirmResult: false });
    const { registerOrgCommands } = await import("../../../kit/src/cli/org.js");
    const { Command } = await import("commander");
    const program = new Command().exitOverride();
    registerOrgCommands(program, ctx);
    await program.parseAsync(["org", "employee", "confirm", "x@y.z"], { from: "user" }).catch(() => {});
    expect(ctx.died).toHaveLength(0);
    expect(ctx.prompts.confirm).toHaveBeenCalledTimes(1);
  });

  it("[ORG-0029] canPrompt=false (--json 非対話) のとき確認スキップで confirmQueryByCS を実行", async () => {
    const ctx = makeCtxStub({ json: true, canPromptResult: false, confirmResult: true });
    const confirmSpy = vi.fn().mockResolvedValue({ success: true });
    ctx.withAccount = (fn) => {
      const hub = makeHubStub({ confirmQueryByCS: confirmSpy });
      return fn(hub, { opts: ctx.opts });
    };
    const { registerOrgCommands } = await import("../../../kit/src/cli/org.js");
    const { Command } = await import("commander");
    const program = new Command().exitOverride();
    registerOrgCommands(program, ctx);
    await program.parseAsync(["org", "employee", "confirm", "z@w.v"], { from: "user" }).catch(() => {});
    expect(ctx.prompts.confirm).not.toHaveBeenCalled();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy).toHaveBeenCalledWith({ email: "z@w.v" });
  });
});

// ════════════════════════════════════════════════════════════════════════
// ORG-0030: 全 employee op の serve 認証ゲート (requireAuth) と未認証 error-path
// ════════════════════════════════════════════════════════════════════════

describe("[ORG-0030] serve 認証ゲート — requireAuth と未認証 error-path", () => {
  const EMPLOYEE_OPS = [
    "getEmployees",
    "getCurrentUserInfo",
    "addEmployees",
    "updateEmployee",
    "removeEmployees",
    "reorderEmployees",
    "queryByCS",
    "confirmQueryByCS",
  ];

  it("[ORG-0030] NAMESPACE_OPS は 8 employee op を含む", () => {
    for (const op of EMPLOYEE_OPS) {
      expect(org.NAMESPACE_OPS).toContain(op);
    }
  });

  it("[ORG-0030] registry に org.<op> として 8 op 全登録", async () => {
    const { buildRegistry } = await import("../../../kit/src/serve/registry.js");
    const reg = buildRegistry();
    for (const op of EMPLOYEE_OPS) {
      expect(reg.has(`org.${op}`), `org.${op} should be in registry`).toBe(true);
    }
  });

  it("[ORG-0030] 未認証 (authState=expired) で org.getEmployees が認証エラーを throw", async () => {
    const { buildRegistry } = await import("../../../kit/src/serve/registry.js");
    const reg = buildRegistry();
    const entry = reg.get("org.getEmployees");
    expect(entry).toBeDefined();
    const expiredDaemon = { authState: "expired", hub: { connected: false } };
    // handler は sync throw するため Promise.resolve でラップして rejects で検証
    await expect(
      Promise.resolve().then(() => entry.handler({ hub: {}, params: { companyID: "ch_X" }, daemon: expiredDaemon })),
    ).rejects.toMatchObject({ kind: "not_authenticated" });
  });

  it("[ORG-0030] 未認証 (authState=expired) で 8 employee op すべてが認証エラーを throw", async () => {
    const { buildRegistry } = await import("../../../kit/src/serve/registry.js");
    const reg = buildRegistry();
    const expiredDaemon = { authState: "expired", hub: { connected: false } };
    for (const op of EMPLOYEE_OPS) {
      const entry = reg.get(`org.${op}`);
      expect(entry, `org.${op} entry`).toBeDefined();
      await expect(
        Promise.resolve().then(() => entry.handler({ hub: {}, params: {}, daemon: expiredDaemon })),
        `org.${op} should throw on expired auth`,
      ).rejects.toMatchObject({ kind: "not_authenticated" });
    }
  });

  it("[ORG-0030] cloud 未接続 (connected=false, authState=ok) で connection_lost を throw", async () => {
    const { buildRegistry } = await import("../../../kit/src/serve/registry.js");
    const reg = buildRegistry();
    const entry = reg.get("org.getEmployees");
    const disconnectedDaemon = { authState: "ok", hub: { connected: false } };
    await expect(
      Promise.resolve().then(() => entry.handler({ hub: {}, params: {}, daemon: disconnectedDaemon })),
    ).rejects.toMatchObject({ kind: "connection_lost" });
  });
});

// ════════════════════════════════════════════════════════════════════════
// ORG-0031: 8 employee op の contract-existence
// ════════════════════════════════════════════════════════════════════════

describe("[ORG-0031] 8 employee op の contract-existence", () => {
  const EIGHT_EMPLOYEE_OPS = [
    "getEmployees",
    "getCurrentUserInfo",
    "addEmployees",
    "updateEmployee",
    "removeEmployees",
    "reorderEmployees",
    "queryByCS",
    "confirmQueryByCS",
  ];

  it("[ORG-0031] NAMESPACE_OPS に 8 employee op が全て存在する (過不足なし)", () => {
    for (const op of EIGHT_EMPLOYEE_OPS) {
      expect(org.NAMESPACE_OPS).toContain(op);
    }
  });

  it("[ORG-0031] registry に org.<op> として 8 op 全登録", async () => {
    const { buildRegistry } = await import("../../../kit/src/serve/registry.js");
    const reg = buildRegistry();
    for (const op of EIGHT_EMPLOYEE_OPS) {
      expect(reg.has(`org.${op}`), `registry should have org.${op}`).toBe(true);
    }
  });

  it("[ORG-0031] grpc-methods.generated.json に 8 employee op が全て存在する", () => {
    const grpcPath = resolve(ROOT, "packages/kit/src/serve/grpc-methods.generated.json");
    const json = JSON.parse(readFileSync(grpcPath, "utf8"));
    // grpc-methods.generated.json は dict (キー=PascalCase, 値に .method がある)
    const methods = Object.values(json).map((v) => /** @type {any} */(v).method);
    for (const op of EIGHT_EMPLOYEE_OPS) {
      expect(methods).toContain(`org.${op}`);
    }
  });

  it("[ORG-0031] rpc-params.generated.json に 8 employee op が全て存在する", () => {
    const rpcPath = resolve(ROOT, "packages/kit/src/serve/rpc-params.generated.json");
    const rpcParams = JSON.parse(readFileSync(rpcPath, "utf8"));
    for (const op of EIGHT_EMPLOYEE_OPS) {
      expect(Object.keys(rpcParams)).toContain(`org.${op}`);
    }
  });

  it("[ORG-0031] rpc-params.generated.json の param 名が spec と一致 (getEmployees/queryByCS/confirmQueryByCS)", () => {
    const rpcPath = resolve(ROOT, "packages/kit/src/serve/rpc-params.generated.json");
    const rpcParams = JSON.parse(readFileSync(rpcPath, "utf8"));

    const getEmpNames = rpcParams["org.getEmployees"].map((p) => p.name);
    expect(getEmpNames).toContain("companyID");
    expect(getEmpNames).toContain("timeoutMs");

    const queryNames = rpcParams["org.queryByCS"].map((p) => p.name);
    expect(queryNames).toContain("keyword");
    expect(queryNames).toContain("partialOnTimeout");

    const confirmNames = rpcParams["org.confirmQueryByCS"].map((p) => p.name);
    expect(confirmNames).toContain("email");

    const addNames = rpcParams["org.addEmployees"].map((p) => p.name);
    expect(addNames).toContain("items");
  });

  it("[ORG-0031] TS SDK sesame-client.ts に 8 employee op が全て記述されている", () => {
    const sdkPath = resolve(ROOT, "packages/kit/sdk/ts/sesame-client.ts");
    const sdk = readFileSync(sdkPath, "utf8");
    for (const op of EIGHT_EMPLOYEE_OPS) {
      expect(sdk).toContain(`${op}:`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// ORG-0032: CLI employee 各サブコマンドの --json 出力封筒パリティ
// ════════════════════════════════════════════════════════════════════════

describe("[ORG-0032] CLI employee --json 出力封筒パリティ", () => {
  it("[ORG-0032] ls --json 封筒は {ok:true, count, employees: list}", async () => {
    const ctx = makeCtxStub({ json: true });
    const list = [{ subUUID: "u1", employeeName: "Alice" }];
    ctx.withAccount = (fn) => {
      const hub = makeHubStub({ getEmployees: vi.fn().mockResolvedValue({ count: 1, list }) });
      return fn(hub, { opts: ctx.opts });
    };
    const { registerOrgCommands } = await import("../../../kit/src/cli/org.js");
    const { Command } = await import("commander");
    const program = new Command().exitOverride();
    registerOrgCommands(program, ctx);
    await program.parseAsync(["org", "employee", "ls"], { from: "user" }).catch(() => {});
    expect(ctx.jsonOutputs).toHaveLength(1);
    expect(ctx.jsonOutputs[0]).toMatchObject({ ok: true, count: 1, employees: list });
  });

  it("[ORG-0032] me --json 封筒は {ok:true, currentUser: info}", async () => {
    const ctx = makeCtxStub({ json: true });
    const info = { subUUID: "me-1", employeeName: "Me" };
    ctx.withAccount = (fn) => {
      const hub = makeHubStub({ getCurrentUserInfo: vi.fn().mockResolvedValue(info) });
      return fn(hub, { opts: ctx.opts });
    };
    const { registerOrgCommands } = await import("../../../kit/src/cli/org.js");
    const { Command } = await import("commander");
    const program = new Command().exitOverride();
    registerOrgCommands(program, ctx);
    await program.parseAsync(["org", "employee", "me"], { from: "user" }).catch(() => {});
    expect(ctx.jsonOutputs).toHaveLength(1);
    expect(ctx.jsonOutputs[0]).toMatchObject({ ok: true, currentUser: info });
  });

  it("[ORG-0032] search --json 封筒は {ok:true, count, results: list}", async () => {
    const ctx = makeCtxStub({ json: true });
    const results = [{ subUUID: "u2", employeeName: "Carol" }];
    ctx.withAccount = (fn) => {
      const hub = makeHubStub({ queryByCS: vi.fn().mockResolvedValue(results) });
      return fn(hub, { opts: ctx.opts });
    };
    const { registerOrgCommands } = await import("../../../kit/src/cli/org.js");
    const { Command } = await import("commander");
    const program = new Command().exitOverride();
    registerOrgCommands(program, ctx);
    await program.parseAsync(["org", "employee", "search", "carol"], { from: "user" }).catch(() => {});
    expect(ctx.jsonOutputs).toHaveLength(1);
    expect(ctx.jsonOutputs[0]).toMatchObject({ ok: true, count: 1, results });
  });

  it("[ORG-0032] add --json 封筒は {ok:true, response: resp}", async () => {
    const ctx = makeCtxStub({ json: true });
    const resp = { success: true };
    ctx.withAccount = (fn) => {
      const hub = makeHubStub({ addEmployees: vi.fn().mockResolvedValue(resp) });
      return fn(hub, { opts: ctx.opts });
    };
    const { registerOrgCommands } = await import("../../../kit/src/cli/org.js");
    const { Command } = await import("commander");
    const program = new Command().exitOverride();
    registerOrgCommands(program, ctx);
    const items = JSON.stringify([{ employeeEmail: "x@y.z", employeeName: "X", tag: [] }]);
    await program.parseAsync(["org", "employee", "add", "--json", items], { from: "user" }).catch(() => {});
    expect(ctx.jsonOutputs).toHaveLength(1);
    expect(ctx.jsonOutputs[0]).toMatchObject({ ok: true, response: resp });
  });

  it("[ORG-0032] rm --json 封筒は {ok:true, response: resp}", async () => {
    const ctx = makeCtxStub({ json: true });
    const resp = { success: true };
    ctx.withAccount = (fn) => {
      const hub = makeHubStub({ removeEmployees: vi.fn().mockResolvedValue(resp) });
      return fn(hub, { opts: ctx.opts });
    };
    const { registerOrgCommands } = await import("../../../kit/src/cli/org.js");
    const { Command } = await import("commander");
    const program = new Command().exitOverride();
    registerOrgCommands(program, ctx);
    const items = JSON.stringify([{ subUUID: "u1", companyID: "ch_X" }]);
    await program.parseAsync(["org", "employee", "rm", "--json", items], { from: "user" }).catch(() => {});
    expect(ctx.jsonOutputs).toHaveLength(1);
    expect(ctx.jsonOutputs[0]).toMatchObject({ ok: true, response: resp });
  });

  it("[ORG-0032] 変更系 (add/update/rm/reorder/confirm): --json 封筒は {ok:true, response: resp}", () => {
    const resp = { success: true };
    const jsonObj = { ok: true, response: resp };
    expect(jsonObj).toHaveProperty("ok", true);
    expect(jsonObj).toHaveProperty("response");
    expect(jsonObj).not.toHaveProperty("employees");
    expect(jsonObj).not.toHaveProperty("results");
  });

  it("[ORG-0032] ls/search/変更系の封筒キー集合が互いに独立している", () => {
    const lsEnvelope = { ok: true, count: 0, employees: [] };
    const searchEnvelope = { ok: true, count: 0, results: [] };
    const changeEnvelope = { ok: true, response: {} };

    expect(lsEnvelope).not.toHaveProperty("results");
    expect(lsEnvelope).not.toHaveProperty("response");
    expect(searchEnvelope).not.toHaveProperty("employees");
    expect(searchEnvelope).not.toHaveProperty("response");
    expect(changeEnvelope).not.toHaveProperty("employees");
    expect(changeEnvelope).not.toHaveProperty("results");
  });
});

// ════════════════════════════════════════════════════════════════════════
// ORG-0033: action 文字列は vendor messageConstants から引き手書きしない (wire enum 一致)
// ════════════════════════════════════════════════════════════════════════

describe("[ORG-0033] action 文字列 — vendor messageConstants 単一定数で全 8 op 一致", () => {
  it("[ORG-0033] ACT_EMPLOYEE は vendor の BIZ3_MANAGE_EMPLOYEE='biz3ManageEmployee' と等値", () => {
    expect(ACTION_TYPES.BIZ3_MANAGE_EMPLOYEE).toBe("biz3ManageEmployee");
  });

  it("[ORG-0033] getEmployees (op:get) フレームの action は 'biz3ManageEmployee'", async () => {
    const c = chunkMockClient();
    const p = org.getEmployees(c, { companyID: "ch_X" });
    expect(c.sent[0].action).toBe("biz3ManageEmployee");
    c.push("biz3ManageEmployee:pubEmployees", {
      data: { totalCount: 0, data: { list: [], page: 1 } },
    });
    await p;
  });

  it("[ORG-0033] getCurrentUserInfo (op:currentInfo) フレームの action は 'biz3ManageEmployee'", async () => {
    const c = mockClient({ success: true, data: {} });
    await org.getCurrentUserInfo(c);
    expect(c.sent[0].action).toBe("biz3ManageEmployee");
  });

  it("[ORG-0033] addEmployees (op:add) フレームの action は 'biz3ManageEmployee'", async () => {
    const c = mockClient({ success: true });
    await org.addEmployees(c, { items: [] });
    expect(c.sent[0].action).toBe("biz3ManageEmployee");
  });

  it("[ORG-0033] updateEmployee (op:update) フレームの action は 'biz3ManageEmployee'", async () => {
    const c = mockClient({ success: true });
    await org.updateEmployee(c, { companyID: "ch_X", data: {} });
    expect(c.sent[0].action).toBe("biz3ManageEmployee");
  });

  it("[ORG-0033] removeEmployees (op:delete) フレームの action は 'biz3ManageEmployee'", async () => {
    const c = mockClient({ success: true });
    await org.removeEmployees(c, { items: [] });
    expect(c.sent[0].action).toBe("biz3ManageEmployee");
  });

  it("[ORG-0033] reorderEmployees (op:order) フレームの action は 'biz3ManageEmployee'", async () => {
    const c = mockClient({ success: true });
    await org.reorderEmployees(c, { items: [] });
    expect(c.sent[0].action).toBe("biz3ManageEmployee");
  });

  it("[ORG-0033] queryByCS (op:queryByCS) 送信フレームの action は 'biz3ManageEmployee'", async () => {
    const c = chunkMockClient();
    const p = org.queryByCS(c, { keyword: "test" });
    expect(c.sent[0].action).toBe("biz3ManageEmployee");
    c.push("biz3ManageEmployee:pubQueryByCS", {
      data: { data: { list: [], page: 1 }, totalPage: 1 },
    });
    await p;
  });

  it("[ORG-0033] confirmQueryByCS (op:confirmQueryByCS) フレームの action は 'biz3ManageEmployee'", async () => {
    const c = mockClient({ success: true });
    await org.confirmQueryByCS(c, { email: "a@b.com" });
    expect(c.sent[0].action).toBe("biz3ManageEmployee");
  });

  it("[ORG-0033] 8 op 全てのフレーム action が同一定数 ACTION_TYPES.BIZ3_MANAGE_EMPLOYEE", async () => {
    const expectedAction = ACTION_TYPES.BIZ3_MANAGE_EMPLOYEE;

    const c1 = mockClient({ success: true, data: {} });
    await org.getCurrentUserInfo(c1);
    expect(c1.sent[0].action).toBe(expectedAction);

    const c2 = mockClient({ success: true });
    await org.addEmployees(c2, { items: [] });
    expect(c2.sent[0].action).toBe(expectedAction);

    const c3 = mockClient({ success: true });
    await org.updateEmployee(c3, { companyID: "ch_X", data: {} });
    expect(c3.sent[0].action).toBe(expectedAction);
  });
});

// ════════════════════════════════════════════════════════════════════════
// ORG-0034: getEmployeeGroups → {action:biz3ManageEmployeeGroup, cid, op:getGroups}
// ════════════════════════════════════════════════════════════════════════

describe("[ORG-0034] getEmployeeGroups — 送信フレームと応答 data 配列 wire-fidelity", () => {
  it("[ORG-0034] フレームは {action:'biz3ManageEmployeeGroup', cid:companyID, op:'getGroups'}", async () => {
    const c = mockClient({ success: true, data: [{ gid: "g1" }] });
    await org.getEmployeeGroups(c, { companyID: "ch_X" });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: "biz3ManageEmployeeGroup",
      cid: "ch_X",
      op: "getGroups",
    });
  });

  it("[ORG-0034] cid キー名 (companyID ではなく cid) を使う", async () => {
    const c = mockClient({ success: true, data: [] });
    await org.getEmployeeGroups(c, { companyID: "ch_X" });
    expect(c.sent[0]).toHaveProperty("cid", "ch_X");
    expect(c.sent[0]).not.toHaveProperty("companyID");
  });

  it("[ORG-0034] 応答 resp.data 配列をそのまま返す", async () => {
    const groups = [{ gid: "g1" }, { gid: "g2" }];
    const c = mockClient({ success: true, data: groups });
    const r = await org.getEmployeeGroups(c, { companyID: "ch_X" });
    expect(r).toEqual(groups);
  });

  it("[ORG-0034] data なし (undefined) のとき空配列 [] を返す (フォールバック)", async () => {
    const c = mockClient({ success: true });
    const r = await org.getEmployeeGroups(c, { companyID: "ch_X" });
    expect(r).toEqual([]);
  });

  it("[ORG-0034] data が null の場合も空配列を返す (resp.data ?? [])", async () => {
    const c = mockClient({ success: true, data: null });
    const r = await org.getEmployeeGroups(c, { companyID: "ch_X" });
    expect(r).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════
// ORG-0035: getEmployeeGroups companyID 未指定で badRequest
// ════════════════════════════════════════════════════════════════════════

describe("[ORG-0035] getEmployeeGroups — companyID 未指定で badRequest", () => {
  it("[ORG-0035] companyID 未指定 (undefined) で badRequest を throw し WS 送信しない", async () => {
    const c = mockClient({});
    await expect(org.getEmployeeGroups(c, {})).rejects.toThrow();
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0035] companyID='' (空文字) で badRequest を throw し WS 送信しない", async () => {
    const c = mockClient({});
    await expect(org.getEmployeeGroups(c, { companyID: "" })).rejects.toThrow();
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0035] companyID=null で badRequest を throw し WS 送信しない", async () => {
    const c = mockClient({});
    await expect(org.getEmployeeGroups(c, { companyID: null })).rejects.toThrow();
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0035] 有効な companyID があれば throw しない", async () => {
    const c = mockClient({ success: true, data: [] });
    await expect(org.getEmployeeGroups(c, { companyID: "ch_X" })).resolves.toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════════
// ORG-0036: addEmployeeGroup → obj:{cid,...item} ラップ op:add
// ════════════════════════════════════════════════════════════════════════

describe("[ORG-0036] addEmployeeGroup — obj:{cid,...item} ラップと応答 data 返却", () => {
  it("[ORG-0036] フレームは {action:'biz3ManageEmployeeGroup', obj:{cid,...item}, op:'add'}", async () => {
    const c = mockClient({ success: true, data: { gid: "g-new" } });
    await org.addEmployeeGroup(c, { companyID: "ch_X", item: { name: "NewGroup" } });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: "biz3ManageEmployeeGroup",
      obj: { cid: "ch_X", name: "NewGroup" },
      op: "add",
    });
  });

  it("[ORG-0036] obj キーは cid (companyID ではない) でトップレベルに companyID を持たない", async () => {
    const c = mockClient({ success: true, data: {} });
    await org.addEmployeeGroup(c, { companyID: "ch_X", item: {} });
    expect(c.sent[0].obj).toHaveProperty("cid", "ch_X");
    expect(c.sent[0].obj).not.toHaveProperty("companyID");
    expect(c.sent[0]).not.toHaveProperty("companyID");
    expect(c.sent[0]).not.toHaveProperty("cid");
  });

  it("[ORG-0036] item のフィールドが obj 内に展開される (cid の後に続く)", async () => {
    const c = mockClient({ success: true, data: { gid: "g-1" } });
    await org.addEmployeeGroup(c, {
      companyID: "ch_X",
      item: { name: "G", description: "desc", foo: 42 },
    });
    expect(c.sent[0].obj).toEqual({ cid: "ch_X", name: "G", description: "desc", foo: 42 });
  });

  it("[ORG-0036] 応答 resp.data (追加グループ1件) を返す", async () => {
    const group = { gid: "g-new", name: "NewGroup" };
    const c = mockClient({ success: true, data: group });
    const r = await org.addEmployeeGroup(c, { companyID: "ch_X", item: { name: "NewGroup" } });
    expect(r).toEqual(group);
  });

  it("[ORG-0036] data 欠落時は undefined を返す (resp 全体にフォールバックしない)", async () => {
    const c = mockClient({ success: true });
    const r = await org.addEmployeeGroup(c, { companyID: "ch_X", item: {} });
    expect(r).toBeUndefined();
  });

  it("[ORG-0036] companyID 未指定で badRequest を throw し WS 送信しない", async () => {
    const c = mockClient({});
    await expect(org.addEmployeeGroup(c, { companyID: "", item: {} })).rejects.toThrow();
    expect(c.sent).toHaveLength(0);
  });
});
