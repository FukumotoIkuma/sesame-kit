// `sesame access cards enroll` の配線テスト (BLE 実機なし)。
//
// ctx.makeBle を fake BLE に差し替え、cardModeSet(1)=register で delegate.onCardReceive に
// 複数カードを 1 枚ずつ流し込む。collect(重複排除) → hub.registerCards へ一括という配線を検証する。
// 実 BLE / 実機検証は別 (このコマンドは experimental)。
import { describe, it, expect, vi } from "vitest";
import { Command } from "commander";
import { registerAccessCommands } from "../../src/cli/access.js";

/**
 * fake SesameBle。cardModeSet(1)=register で registerDelegate.onCardReceive に records を流す。
 * lateCardOnExit を渡すと cardModeSet(0)=control 移行時にもう 1 枚流す
 * (= _LAST が「register を抜ける」際に届くケースの再現。unsub 順の取りこぼし回帰テスト用)。
 */
function makeFakeBle(records, { lateCardOnExit = null, failConnect = false } = {}) {
  let delegate = null;
  const calls = [];
  const emit = (r) => { if (delegate?.onCardReceive) delegate.onCardReceive(r.cardID, r.cardName, r.cardType); };
  return {
    calls,
    biometric: {
      registerDelegate(d) { delegate = d; return () => calls.push(["unsub"]); },
      async cardModeSet(mode) {
        calls.push(["cardModeSet", mode]);
        if (mode === 1) for (const r of records) emit(r);
        if (mode === 0 && lateCardOnExit) emit(lateCardOnExit);
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

  it("register モードを抜ける際に届くカードも取りこぼさない (cardModeSet(0) → unsub の順)", async () => {
    const hub = { listDevices: vi.fn(async () => [DEV]), registerCards: vi.fn(async () => ({ ok: true })) };
    const ble = makeFakeBle(
      [{ cardID: "AA11", cardName: "n1", cardType: 1 }],
      { lateCardOnExit: { cardID: "CC33", cardName: "n3", cardType: 2 } },
    );
    const { ctx } = makeCtx({ hub, ble });
    await buildProgram(ctx).parseAsync(["access", "cards", "enroll", "--device", "u1"], { from: "user" });

    // 解除は MODE_CONTROL 復帰の後 (抜ける際の publish を拾ってから)。
    const modeOffIdx = ble.calls.findIndex((c) => c[0] === "cardModeSet" && c[1] === 0);
    const unsubIdx = ble.calls.findIndex((c) => c[0] === "unsub");
    expect(modeOffIdx).toBeGreaterThanOrEqual(0);
    expect(unsubIdx).toBeGreaterThan(modeOffIdx);
    // 抜ける際に届いた CC33 も登録対象。
    const ids = hub.registerCards.mock.calls[0][1].map((c) => c.cardID);
    expect(ids).toEqual(expect.arrayContaining(["AA11", "CC33"]));
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

  it("bioCaps 限定ビューに card 系が無い機種 (cardModeSet 非存在) は die(2)", async () => {
    const hub = { listDevices: vi.fn(async () => [DEV]), registerCards: vi.fn() };
    // biometric ゲッタは生えるが card 能力は無い (例 sesame_face_ai = palm+face のみ) を模す。
    const ble = {
      biometric: { registerDelegate: vi.fn() }, // cardModeSet が無い
      async connect() {}, async close() {},
    };
    const { ctx } = makeCtx({ hub, ble });
    await expect(
      buildProgram(ctx).parseAsync(["access", "cards", "enroll", "--device", "u1"], { from: "user" }),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.registerCards).not.toHaveBeenCalled();
  });
});

/**
 * fake SesameBle (passcode 版)。passcodeModeSet(1)=register で registerDelegate.onKeyBoardReceive
 * に records を流す (publish 形は card と同じ parseTouchCard 共通形 — CHPassCodeEventHandlers.kt:28-37)。
 */
function makeFakePasscodeBle(records) {
  let delegate = null;
  const calls = [];
  return {
    calls,
    biometric: {
      registerDelegate(d) { delegate = d; return () => calls.push(["unsub"]); },
      async passcodeModeSet(mode) {
        calls.push(["passcodeModeSet", mode]);
        if (mode === 1 && delegate?.onKeyBoardReceive) {
          for (const r of records) delegate.onKeyBoardReceive(r.cardID, r.cardName, r.cardType);
        }
      },
    },
    async connect() { calls.push(["connect"]); },
    async close() { calls.push(["close"]); },
  };
}

describe("access passcodes enroll (配線, SURF-04)", () => {
  it("複数入力を集約し hub.registerPasscodes へ一括登録する (cards enroll と対称)", async () => {
    const hub = {
      listDevices: vi.fn(async () => [DEV]),
      registerPasscodes: vi.fn(async (uuid, records) => ({ ok: true, count: records.length })),
    };
    const ble = makeFakePasscodeBle([
      { cardID: "1234", cardName: "31323334", cardType: 0 },
      { cardID: "5678", cardName: "35363738", cardType: 0 },
    ]);
    const { ctx, outputs } = makeCtx({ hub, ble });

    await buildProgram(ctx).parseAsync(["access", "passcodes", "enroll", "--device", "u1"], { from: "user" });

    // register モードに入り、終了後に control へ戻す (passcodeModeSet 経由)。
    expect(ble.calls).toContainEqual(["passcodeModeSet", 1]);
    expect(ble.calls).toContainEqual(["passcodeModeSet", 0]);
    expect(ble.calls).toContainEqual(["close"]);
    // 解除は MODE_CONTROL 復帰の後 (cards enroll と同じ取りこぼし防止順序)。
    const modeOffIdx = ble.calls.findIndex((c) => c[0] === "passcodeModeSet" && c[1] === 0);
    const unsubIdx = ble.calls.findIndex((c) => c[0] === "unsub");
    expect(unsubIdx).toBeGreaterThan(modeOffIdx);
    expect(hub.registerPasscodes).toHaveBeenCalledTimes(1);
    expect(hub.registerPasscodes).toHaveBeenCalledWith("u1", [
      { cardID: "1234", cardName: "31323334", cardType: 0 },
      { cardID: "5678", cardName: "35363738", cardType: 0 },
    ]);
    expect(outputs[0]).toMatchObject({ ok: true, enrolled: 2, deviceUUID: "u1" });
  });

  it("passcode 能力が無い機種 (bioCaps 限定ビューに passcodeModeSet 非存在) は die(2)", async () => {
    const hub = { listDevices: vi.fn(async () => [{ ...DEV, deviceModel: "ssm_touch" }]), registerPasscodes: vi.fn() };
    // ssm_touch の bioCaps は card+fingerprint のみ → 限定ビューに passcode 系は生えない (P3-15)。
    const ble = {
      biometric: { registerDelegate: vi.fn(), cardModeSet: vi.fn() }, // passcodeModeSet が無い
      async connect() {}, async close() {},
    };
    const { ctx } = makeCtx({ hub, ble });
    await expect(
      buildProgram(ctx).parseAsync(["access", "passcodes", "enroll", "--device", "u1"], { from: "user" }),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.registerPasscodes).not.toHaveBeenCalled();
  });

  it("0 件なら登録せず enrolled:0 を返す", async () => {
    const hub = { listDevices: vi.fn(async () => [DEV]), registerPasscodes: vi.fn() };
    const ble = makeFakePasscodeBle([]);
    const { ctx, outputs } = makeCtx({ hub, ble });
    await buildProgram(ctx).parseAsync(["access", "passcodes", "enroll", "--device", "u1"], { from: "user" });
    expect(hub.registerPasscodes).not.toHaveBeenCalled();
    expect(outputs[0]).toMatchObject({ ok: true, enrolled: 0 });
  });
});
