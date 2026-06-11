// `sesame iot raw` (SURF-23) の配線テスト — iot.sendIotCmd / sendIotCmdAwait への委譲と
// payload 正規化 (hex → base64 / その他は透過)、usage 検証 (exit 2) を固定する。
import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { registerIotCommands } from "../../src/cli/iot.js";

/** fake ctx (access-enroll.test.js と同型)。withHub は即 fn(hub,{opts})、die は throw。 */
function makeCtx({ hub }) {
  const outputs = [];
  const ctx = {
    out: (_json, _humanFn, jsonObj) => { outputs.push(jsonObj); },
    die: (msg, code) => { const e = new Error(msg); e.code = code; throw e; },
    canPrompt: () => false,
    loadCtx: () => { throw new Error("not used"); },
    withHub: (fn) => fn(hub, { opts: { json: true } }),
    prompts: { promptText: vi.fn(), selectFromList: vi.fn(), confirm: vi.fn(), promptLine: vi.fn() },
    makeBle: vi.fn(),
    parseJson: (raw) => JSON.parse(raw),
  };
  return { ctx, outputs };
}

function buildProgram(ctx) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerIotCommands(program, ctx);
  return program;
}

function makeHub() {
  return {
    iot: {
      sendIotCmd: vi.fn(),
      sendIotCmdAwait: vi.fn(async (p) => ({ op: p.cmd, data: { ok: 1 } })),
    },
  };
}

describe("iot raw (SURF-23)", () => {
  it("hex payload はバイト列として base64 化して sendIotCmd へ (fire-and-forget)", async () => {
    const hub = makeHub();
    const { ctx, outputs } = makeCtx({ hub });
    await buildProgram(ctx).parseAsync(
      ["iot", "raw", "--topic", "hub3/u1/cmd", "--payload", "deadbeef"],
      { from: "user" },
    );
    expect(hub.iot.sendIotCmd).toHaveBeenCalledWith({
      topic: "hub3/u1/cmd",
      payload: Buffer.from("deadbeef", "hex").toString("base64"),
    });
    expect(hub.iot.sendIotCmdAwait).not.toHaveBeenCalled();
    expect(outputs[0]).toMatchObject({ ok: true, sent: true, awaited: false, topic: "hub3/u1/cmd" });
  });

  it("hex でない payload はそのまま透過する (base64 済み等)", async () => {
    const hub = makeHub();
    const { ctx } = makeCtx({ hub });
    await buildProgram(ctx).parseAsync(
      ["iot", "raw", "--topic", "t", "--payload", "3q2+7w=="],
      { from: "user" },
    );
    expect(hub.iot.sendIotCmd).toHaveBeenCalledWith({ topic: "t", payload: "3q2+7w==" });
  });

  it("--await --cmd <n> は sendIotCmdAwait へ委譲 (deviceId/timeoutMs 透過)", async () => {
    const hub = makeHub();
    const { ctx, outputs } = makeCtx({ hub });
    await buildProgram(ctx).parseAsync(
      ["iot", "raw", "--topic", "t", "--payload", "00ff", "--await", "--cmd", "92", "--device", "u1", "--timeout", "5000"],
      { from: "user" },
    );
    expect(hub.iot.sendIotCmdAwait).toHaveBeenCalledWith({
      topic: "t",
      payload: Buffer.from("00ff", "hex").toString("base64"),
      cmd: 92,
      deviceId: "u1",
      timeoutMs: 5000,
    });
    expect(outputs[0]).toMatchObject({ ok: true, awaited: true, cmd: 92 });
  });

  it("--topic / --payload 欠落、--await で --cmd 欠落は die(2)", async () => {
    const hub = makeHub();
    const { ctx } = makeCtx({ hub });
    await expect(
      buildProgram(ctx).parseAsync(["iot", "raw", "--payload", "00"], { from: "user" }),
    ).rejects.toMatchObject({ code: 2 });
    await expect(
      buildProgram(ctx).parseAsync(["iot", "raw", "--topic", "t"], { from: "user" }),
    ).rejects.toMatchObject({ code: 2 });
    await expect(
      buildProgram(ctx).parseAsync(["iot", "raw", "--topic", "t", "--payload", "00", "--await"], { from: "user" }),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.iot.sendIotCmd).not.toHaveBeenCalled();
    expect(hub.iot.sendIotCmdAwait).not.toHaveBeenCalled();
  });
});
