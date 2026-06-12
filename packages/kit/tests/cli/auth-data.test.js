// `sesame access auth-data post|put|delete|name` の配線テスト (P4-4 / R2:SURF-30)。
//
// client.js の postAuthenticationData/putAuthenticationData/deleteAuthenticationData/
// updateAuthenticationName への配線と --json 出力契約を検証する。
// 実 SigV4 呼び出しは行わない (fake hub で差し替え)。
import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { registerAccessCommands } from "../../src/cli/access.js";

/**
 * fake hub — 生体 REST 4 メソッドを spy で差し替える。
 * @param {object} [overrides]
 */
function makeFakeHub(overrides = {}) {
  return {
    postAuthenticationData: vi.fn(async () => ({ ok: true })),
    putAuthenticationData: vi.fn(async () => ({ ok: true })),
    deleteAuthenticationData: vi.fn(async () => ({ ok: true })),
    updateAuthenticationName: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

/**
 * fake ctx。withHub は即 fn(hub,{opts}) を呼ぶ。die は捕捉可能にする。
 * @param {object} hub
 */
function makeCtx(hub) {
  const outputs = [];
  return {
    outputs,
    ctx: {
      out: (_json, _humanFn, jsonObj) => { outputs.push(jsonObj); },
      die: (msg, code) => { const e = new Error(msg); e.code = code; throw e; },
      canPrompt: () => false,
      withHub: (fn) => fn(hub, { opts: { json: true } }),
      parseJson: (raw, _hint) => JSON.parse(raw),
    },
  };
}

/**
 * Commander ツリーを構築して parseAsync を呼ぶ。
 * @param {object} ctx
 * @param {string[]} args
 */
async function run(ctx, args) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerAccessCommands(program, ctx);
  await program.parseAsync(args, { from: "user" });
}

// ─────────────────────────────────────────────
describe("access auth-data post", () => {
  it("正常: hub.postAuthenticationData を呼び、ctx.out に ok:true を渡す", async () => {
    const hub = makeFakeHub();
    const { ctx, outputs } = makeCtx(hub);

    await run(ctx, [
      "access", "auth-data", "post",
      "--operation", "op-1",
      "--device-id", "dev-abc",
      "--items", '[{"id":"x1"}]',
    ]);

    expect(hub.postAuthenticationData).toHaveBeenCalledOnce();
    expect(hub.postAuthenticationData).toHaveBeenCalledWith({
      operation: "op-1",
      deviceID: "dev-abc",
      items: [{ id: "x1" }],
    });
    expect(outputs[0]).toMatchObject({ ok: true, operation: "op-1", deviceID: "dev-abc" });
  });

  it("--operation 欠落は die(code=2)", async () => {
    const hub = makeFakeHub();
    const { ctx } = makeCtx(hub);
    await expect(run(ctx, [
      "access", "auth-data", "post",
      "--device-id", "dev-abc",
      "--items", "[]",
    ])).rejects.toMatchObject({ code: 2 });
    expect(hub.postAuthenticationData).not.toHaveBeenCalled();
  });

  it("--device-id 欠落は die(code=2)", async () => {
    const hub = makeFakeHub();
    const { ctx } = makeCtx(hub);
    await expect(run(ctx, [
      "access", "auth-data", "post",
      "--operation", "op-1",
      "--items", "[]",
    ])).rejects.toMatchObject({ code: 2 });
    expect(hub.postAuthenticationData).not.toHaveBeenCalled();
  });

  it("--items 欠落は die(code=2)", async () => {
    const hub = makeFakeHub();
    const { ctx } = makeCtx(hub);
    await expect(run(ctx, [
      "access", "auth-data", "post",
      "--operation", "op-1",
      "--device-id", "dev-abc",
    ])).rejects.toMatchObject({ code: 2 });
    expect(hub.postAuthenticationData).not.toHaveBeenCalled();
  });

  it("--items が配列でない JSON は die(code=2)", async () => {
    const hub = makeFakeHub();
    const { ctx } = makeCtx(hub);
    await expect(run(ctx, [
      "access", "auth-data", "post",
      "--operation", "op-1",
      "--device-id", "dev-abc",
      "--items", '{"not":"array"}',
    ])).rejects.toMatchObject({ code: 2 });
    expect(hub.postAuthenticationData).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────
describe("access auth-data put", () => {
  it("正常: hub.putAuthenticationData を呼ぶ", async () => {
    const hub = makeFakeHub();
    const { ctx, outputs } = makeCtx(hub);

    await run(ctx, [
      "access", "auth-data", "put",
      "--operation", "op-put",
      "--device-id", "dev-put",
      "--items", '[{"id":"y1"}]',
    ]);

    expect(hub.putAuthenticationData).toHaveBeenCalledOnce();
    expect(hub.putAuthenticationData).toHaveBeenCalledWith({
      operation: "op-put",
      deviceID: "dev-put",
      items: [{ id: "y1" }],
    });
    expect(outputs[0]).toMatchObject({ ok: true, operation: "op-put", deviceID: "dev-put" });
  });

  it("--operation 欠落は die(code=2)", async () => {
    const hub = makeFakeHub();
    const { ctx } = makeCtx(hub);
    await expect(run(ctx, [
      "access", "auth-data", "put",
      "--device-id", "d",
      "--items", "[]",
    ])).rejects.toMatchObject({ code: 2 });
  });
});

// ─────────────────────────────────────────────
describe("access auth-data delete", () => {
  it("正常: hub.deleteAuthenticationData を呼ぶ", async () => {
    const hub = makeFakeHub();
    const { ctx, outputs } = makeCtx(hub);

    await run(ctx, [
      "access", "auth-data", "delete",
      "--operation", "op-del",
      "--device-id", "dev-del",
      "--items", '[{"id":"z1"}]',
    ]);

    expect(hub.deleteAuthenticationData).toHaveBeenCalledOnce();
    expect(hub.deleteAuthenticationData).toHaveBeenCalledWith({
      operation: "op-del",
      deviceID: "dev-del",
      items: [{ id: "z1" }],
    });
    expect(outputs[0]).toMatchObject({ ok: true, operation: "op-del", deviceID: "dev-del" });
  });

  it("--device-id 欠落は die(code=2)", async () => {
    const hub = makeFakeHub();
    const { ctx } = makeCtx(hub);
    await expect(run(ctx, [
      "access", "auth-data", "delete",
      "--operation", "op-del",
      "--items", "[]",
    ])).rejects.toMatchObject({ code: 2 });
  });
});

// ─────────────────────────────────────────────
describe("access auth-data name", () => {
  it("正常 (kind あり): hub.updateAuthenticationName に kind を渡す", async () => {
    const hub = makeFakeHub();
    const { ctx, outputs } = makeCtx(hub);

    await run(ctx, [
      "access", "auth-data", "name",
      "--kind", "card",
      "--json", '{"stpDeviceUUID":"u1","name":"My Card"}',
    ]);

    expect(hub.updateAuthenticationName).toHaveBeenCalledOnce();
    expect(hub.updateAuthenticationName).toHaveBeenCalledWith({
      kind: "card",
      stpDeviceUUID: "u1",
      name: "My Card",
    });
    expect(outputs[0]).toMatchObject({ ok: true, kind: "card" });
  });

  it("--json 省略時は空 params で呼べる (kind のみ)", async () => {
    const hub = makeFakeHub();
    const { ctx, outputs } = makeCtx(hub);

    await run(ctx, [
      "access", "auth-data", "name",
      "--kind", "passcode",
    ]);

    expect(hub.updateAuthenticationName).toHaveBeenCalledOnce();
    expect(hub.updateAuthenticationName).toHaveBeenCalledWith({ kind: "passcode" });
    expect(outputs[0]).toMatchObject({ ok: true, kind: "passcode" });
  });

  it("--kind も --json も省略でも呼べる (access.js が kind 省略を許容)", async () => {
    const hub = makeFakeHub();
    const { ctx, outputs } = makeCtx(hub);

    await run(ctx, ["access", "auth-data", "name"]);

    expect(hub.updateAuthenticationName).toHaveBeenCalledOnce();
    // kind 未指定の場合、params.kind は undefined (access.js 側が request 直指定と扱う)。
    expect(hub.updateAuthenticationName).toHaveBeenCalledWith({ kind: undefined });
    expect(outputs[0]).toMatchObject({ ok: true, kind: null });
  });

  it("--json が配列でも object でもない壊れた JSON は parseJson が throw し hub は呼ばれない", async () => {
    const hub = makeFakeHub();
    const { ctx } = makeCtx(hub);
    // ctx.parseJson は JSON.parse をそのまま呼ぶ — 壊れた JSON は SyntaxError を throw する。
    // registerAccessCommands は parseJson の戻り === undefined でガードするが、
    // throw した場合は withHub 外に伝播して上位が捕捉する (die しない → code なし)。
    await expect(run(ctx, [
      "access", "auth-data", "name",
      "--json", "not-valid-json",
    ])).rejects.toThrow();
    expect(hub.updateAuthenticationName).not.toHaveBeenCalled();
  });
});
