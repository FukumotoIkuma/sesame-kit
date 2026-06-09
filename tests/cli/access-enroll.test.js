// `sesame access cards enroll` の配線テスト (BLE 実機なし)。
//
// ctx.makeBle を fake BLE に差し替え、cardModeSet(1)=register で onEnroll に複数カードを
// 流し込む。collect(重複排除) → hub.registerCards へ一括という配線を検証する。
// 実 BLE / 実機検証は別 (このコマンドは experimental)。
import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { registerAccessCommands } from "../../src/cli/access.js";

/** cardModeSet(1) を受けたら onEnroll コールバックへ records を流す fake SesameBle。 */
function makeFakeBle(records, { failConnect = false } = {}) {
  let enrollCb = null;
  const calls = [];
  return {
    calls,
    biometric: {
      onEnroll(cb) { enrollCb = cb; return () => calls.push(["unsub"]); },
      async cardModeSet(mode) {
        calls.push(["cardModeSet", mode]);
        if (mode === 1 && enrollCb) enrollCb({ kind: "card", records });
      },
    },
    async connect() { calls.push(["connect"]); if (failConnect) throw new Error("ble down"); },
    async close() { calls.push(["close"]); },
  };
}

/** fake ctx を組む。withHub は即 fn(hub,{opts}) を呼ぶ。die は throw して捕捉可能にする。 */
function makeCtx({ hub, ble, canPrompt = true }) {
  const outputs = [];
  const ctx = {
    out: (json, humanFn, jsonObj) => { outputs.push(jsonObj); },
    die: (msg, code) => { const e = new Error(msg); e.code = code; throw e; },
    canPrompt: () => canPrompt,
    withHub: (fn) => fn(hub, { opts: { json: true } }),
    prompts: { promptText: vi.fn(async () => ""), selectFromList: vi.fn(), confirm: vi.fn(), promptLine: vi.fn() },
    makeBle: () => ble,
    parseJson: (raw) => JSON.parse(raw),
  };
  return { ctx, outputs };
}

function buildProgram(ctx) {
  const program = new Command();
  program.exitOverride(); // throw 化 (process.exit させない)
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerAccessCommands(program, ctx);
  return program;
}

const DEV = { deviceUUID: "u1", secretKey: "00112233445566778899aabbccddeeff", deviceModel: "sesame_touch_pro" };

describe("access cards enroll (配線)", () => {
  it("複数タップを集約し hub.registerCards へ一括登録する", async () => {
    const hub = {
      listDevices: vi.fn(async () => [DEV]),
      registerCards: vi.fn(async (uuid, cards) => ({ ok: true, count: cards.length })),
    };
    const ble = makeFakeBle([
      { cardID: "AA11", cardName: "n1", cardType: 1 },
      { cardID: "BB22", cardName: "n2", cardType: 0 },
    ]);
    const { ctx, outputs } = makeCtx({ hub, ble });

    await buildProgram(ctx).parseAsync(["access", "cards", "enroll", "--device", "u1"], { from: "user" });

    // register モードに入り、終了後に control へ戻す。
    expect(ble.calls).toContainEqual(["cardModeSet", 1]);
    expect(ble.calls).toContainEqual(["cardModeSet", 0]);
    expect(ble.calls).toContainEqual(["close"]);
    // 2 枚を 1 回で登録。
    expect(hub.registerCards).toHaveBeenCalledTimes(1);
    expect(hub.registerCards).toHaveBeenCalledWith("u1", [
      { cardID: "AA11", cardName: "n1", cardType: 1 },
      { cardID: "BB22", cardName: "n2", cardType: 0 },
    ]);
    expect(outputs[0]).toMatchObject({ ok: true, enrolled: 2, deviceUUID: "u1" });
  });

  it("同一 cardID は重複排除される", async () => {
    const hub = { listDevices: vi.fn(async () => [DEV]), registerCards: vi.fn(async () => ({ ok: true })) };
    const ble = makeFakeBle([
      { cardID: "AA11", cardName: "n1", cardType: 1 },
      { cardID: "AA11", cardName: "n1-dup", cardType: 1 },
    ]);
    const { ctx } = makeCtx({ hub, ble });
    await buildProgram(ctx).parseAsync(["access", "cards", "enroll", "--device", "u1"], { from: "user" });
    expect(hub.registerCards.mock.calls[0][1]).toHaveLength(1);
  });

  it("カード 0 枚なら登録せず enrolled:0 を返す", async () => {
    const hub = { listDevices: vi.fn(async () => [DEV]), registerCards: vi.fn() };
    const ble = makeFakeBle([]);
    const { ctx, outputs } = makeCtx({ hub, ble });
    await buildProgram(ctx).parseAsync(["access", "cards", "enroll", "--device", "u1"], { from: "user" });
    expect(hub.registerCards).not.toHaveBeenCalled();
    expect(outputs[0]).toMatchObject({ ok: true, enrolled: 0 });
  });

  it("secretKey が無いデバイスは die(2)", async () => {
    const hub = { listDevices: vi.fn(async () => [{ deviceUUID: "u1", deviceModel: "sesame_touch_pro" }]), registerCards: vi.fn() };
    const ble = makeFakeBle([]);
    const { ctx } = makeCtx({ hub, ble });
    await expect(
      buildProgram(ctx).parseAsync(["access", "cards", "enroll", "--device", "u1"], { from: "user" }),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.registerCards).not.toHaveBeenCalled();
  });
});
