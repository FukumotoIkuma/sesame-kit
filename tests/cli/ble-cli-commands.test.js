// `sesame ble invoke/os2-invoke/ota/reset/wifi/position` (P4-1) の配線テスト (BLE 実機なし)。
//
// ctx.makeBle を fake BLE に差し替え (access enroll と同じ seam)、
//   - invoke が serve と同じ allowlist / ドット op パス / $buffer revive で動くこと
//   - 専用コマンドがファサードの対応メソッドへ正しい引数で委譲すること
//   - 破壊的 reset の確認ゲート、wifi の kind 自動判別 / connect の WM2 限定
// を検証する。
import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import { registerBleCommands } from "../../src/cli/ble.js";
import { SesameOS2Ble, capabilitiesForModel } from "../../src/ble/index.js";

const LOCKS = {
  mylock: { deviceUUID: "u-lock", secretKey: "00".repeat(16), model: "sesame_5" },
  myhub: { deviceUUID: "u-hub", secretKey: "11".repeat(16), model: "hub_3" },
  mywm2: { deviceUUID: "u-wm2", secretKey: "22".repeat(16), model: "wm_2" },
  // バックログ4: OS2 鍵素材 (locks add --ssm-public-key/--key-index で保存される形) 付き lock
  myos2: {
    deviceUUID: "u-os2", secretKey: "33".repeat(16), model: "sesame_4",
    ssmPublicKey: "cd".repeat(64), keyIndex: "0001",
  },
};

/** fake ctx。die は throw 化して捕捉可能に。makeBle で fake facade を注入する。 */
function makeCtx({ ble, canPrompt = false, confirm = vi.fn(async () => true) } = {}) {
  const outputs = [];
  const makeBleCalls = [];
  const ctx = {
    out: (_json, _humanFn, jsonObj) => { outputs.push(jsonObj); },
    die: (msg, code) => { const e = new Error(msg); e.exitCode = code; throw e; },
    canPrompt: () => canPrompt,
    loadCtx: () => ({
      opts: { json: true },
      configStore: { load: () => ({ locks: LOCKS }) },
      tokenStore: {},
      paths: {},
    }),
    prompts: { confirm, promptText: vi.fn(), selectFromList: vi.fn(), promptLine: vi.fn() },
    makeBle: (opts) => { makeBleCalls.push(opts); return ble; },
    parseJson: (raw) => JSON.parse(raw),
  };
  return { ctx, outputs, makeBleCalls };
}

function buildProgram(ctx) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerBleCommands(program, ctx);
  return program;
}

/** connect/close を記録する fake SesameBle (機能は test ごとに足す)。 */
function makeFakeBle(extra = {}, model = "sesame_5") {
  const calls = [];
  return {
    calls,
    capabilities: capabilitiesForModel(model),
    async connect() { calls.push(["connect"]); return this; },
    async close() { calls.push(["close"]); },
    ...extra,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("ble invoke (汎用脱出口)", () => {
  it("allowlist 掲載 op をドットパスで実行し、--args の $buffer を revive する", async () => {
    const lock = vi.fn(async (tag) => ({ resultCode: 0, tag }));
    const ble = makeFakeBle({ lock });
    const { ctx, outputs } = makeCtx({ ble });
    await buildProgram(ctx).parseAsync(
      ["ble", "invoke", "mylock", "lock", "--args", '[{"$buffer":"00ff"}]'],
      { from: "user" },
    );
    expect(lock).toHaveBeenCalledTimes(1);
    expect(Buffer.isBuffer(lock.mock.calls[0][0])).toBe(true);
    expect(lock.mock.calls[0][0].toString("hex")).toBe("00ff");
    expect(ble.calls).toEqual([["connect"], ["close"]]);
    expect(outputs[0]).toMatchObject({ ok: true, op: "lock", name: "mylock", deviceUUID: "u-lock" });
  });

  it("allowlist 非掲載 op (close) は実行されず bad params で落ちる (serve と同一規約)", async () => {
    const ble = makeFakeBle();
    const closeCalls = () => ble.calls.filter((c) => c[0] === "close").length;
    const { ctx } = makeCtx({ ble });
    await expect(
      buildProgram(ctx).parseAsync(["ble", "invoke", "mylock", "close"], { from: "user" }),
    ).rejects.toThrow(/unsupported BLE op/);
    // close は finally の切断 1 回のみ (op としては実行されていない)。
    expect(closeCalls()).toBe(1);
  });

  it("config に無いデバイスは --secret 無しだと die(2)", async () => {
    const { ctx } = makeCtx({ ble: makeFakeBle() });
    await expect(
      buildProgram(ctx).parseAsync(["ble", "invoke", "nope", "lock"], { from: "user" }),
    ).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe("ble os2-invoke", () => {
  it("OS2 allowlist で照合し SesameOS2Ble.use 経由で実行する", async () => {
    const fake = { lock: vi.fn(async () => ({ resultCode: 0 })) };
    const useSpy = vi.spyOn(SesameOS2Ble, "use").mockImplementation(async (_opts, fn) => fn(fake));
    const { ctx, outputs } = makeCtx({});
    await buildProgram(ctx).parseAsync(
      ["ble", "os2-invoke", "mylock", "lock", "--ssm-public-key", "ab".repeat(64), "--key-index", "0000"],
      { from: "user" },
    );
    expect(fake.lock).toHaveBeenCalled();
    const opts = useSpy.mock.calls[0][0];
    expect(opts).toMatchObject({
      deviceUUID: "u-lock", secretKey: LOCKS.mylock.secretKey, keyIndex: "0000",
      ssmPublicKey: "ab".repeat(64), model: "sesame_5",
    });
    expect(opts.transport).toBeTruthy(); // createBleTransport が注入されている
    expect(outputs[0]).toMatchObject({ ok: true, op: "lock" });
  });

  it("--ssm-public-key 無し・config にも保存無しは die(2) (OS2 login は ECDH 必須)", async () => {
    const useSpy = vi.spyOn(SesameOS2Ble, "use").mockResolvedValue({});
    const { ctx } = makeCtx({});
    await expect(
      buildProgram(ctx).parseAsync(["ble", "os2-invoke", "mylock", "lock"], { from: "user" }),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(useSpy).not.toHaveBeenCalled();
  });

  it("バックログ4: フラグ省略時は config 保存の ssmPublicKey/keyIndex で login する", async () => {
    const fake = { lock: vi.fn(async () => ({ resultCode: 0 })) };
    const useSpy = vi.spyOn(SesameOS2Ble, "use").mockImplementation(async (_opts, fn) => fn(fake));
    const { ctx, outputs } = makeCtx({});
    await buildProgram(ctx).parseAsync(["ble", "os2-invoke", "myos2", "lock"], { from: "user" });
    expect(useSpy.mock.calls[0][0]).toMatchObject({
      deviceUUID: "u-os2",
      secretKey: LOCKS.myos2.secretKey,
      ssmPublicKey: LOCKS.myos2.ssmPublicKey, // config 保存値で解決
      keyIndex: LOCKS.myos2.keyIndex,
      model: "sesame_4",
    });
    expect(outputs[0]).toMatchObject({ ok: true, op: "lock", name: "myos2" });
  });

  it("バックログ4: 明示フラグは config 保存値より優先される", async () => {
    const fake = { lock: vi.fn(async () => ({ resultCode: 0 })) };
    const useSpy = vi.spyOn(SesameOS2Ble, "use").mockImplementation(async (_opts, fn) => fn(fake));
    const { ctx } = makeCtx({});
    await buildProgram(ctx).parseAsync(
      ["ble", "os2-invoke", "myos2", "lock", "--ssm-public-key", "ef".repeat(64), "--key-index", "00ff"],
      { from: "user" },
    );
    expect(useSpy.mock.calls[0][0]).toMatchObject({
      ssmPublicKey: "ef".repeat(64), // フラグ > config
      keyIndex: "00ff",
    });
  });

  it("バックログ4: keyIndex 未指定 (フラグも config も無し) は undefined → session 既定 \"0000\"", async () => {
    const fake = { lock: vi.fn(async () => ({ resultCode: 0 })) };
    const useSpy = vi.spyOn(SesameOS2Ble, "use").mockImplementation(async (_opts, fn) => fn(fake));
    const { ctx } = makeCtx({});
    await buildProgram(ctx).parseAsync(
      ["ble", "os2-invoke", "mylock", "lock", "--ssm-public-key", "ab".repeat(64)],
      { from: "user" },
    );
    expect(useSpy.mock.calls[0][0].keyIndex).toBeUndefined();
  });

  it("OS2 非公開 op (connect) は拒否される", async () => {
    const fake = { connect: vi.fn() };
    vi.spyOn(SesameOS2Ble, "use").mockImplementation(async (_opts, fn) => fn(fake));
    const { ctx } = makeCtx({});
    await expect(
      buildProgram(ctx).parseAsync(
        ["ble", "os2-invoke", "mylock", "connect", "--ssm-public-key", "ab".repeat(64)],
        { from: "user" },
      ),
    ).rejects.toThrow(/unsupported BLE op/);
    expect(fake.connect).not.toHaveBeenCalled();
  });
});

describe("ble ota / reset / position", () => {
  it("ota: 応答あり経路は commandSent:true + resultName", async () => {
    const ble = makeFakeBle({ updateFirmware: vi.fn(async () => ({ resultCode: 0, payload: Buffer.alloc(0), session: {} })) }, "hub_3");
    const { ctx, outputs } = makeCtx({ ble });
    await buildProgram(ctx).parseAsync(["ble", "ota", "myhub"], { from: "user" });
    expect(outputs[0]).toMatchObject({ ok: true, commandSent: true, resultCode: 0, resultName: "success" });
  });

  it("ota: OS3 ロックの no-op 経路 (同期 {session} 返し) は commandSent:false", async () => {
    const ble = makeFakeBle({ updateFirmware: vi.fn(() => ({ session: {} })) });
    const { ctx, outputs } = makeCtx({ ble });
    await buildProgram(ctx).parseAsync(["ble", "ota", "mylock"], { from: "user" });
    expect(outputs[0]).toMatchObject({ ok: true, commandSent: false, resultCode: null, resultName: null });
    expect(ble.calls).toEqual([["connect"], ["close"]]);
  });

  it("reset: 非対話で --yes 無しは die(2) (接続もしない)", async () => {
    const reset = vi.fn();
    const ble = makeFakeBle({ reset });
    const { ctx, makeBleCalls } = makeCtx({ ble, canPrompt: false });
    await expect(
      buildProgram(ctx).parseAsync(["ble", "reset", "mylock"], { from: "user" }),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(makeBleCalls).toHaveLength(0);
    expect(reset).not.toHaveBeenCalled();
  });

  it("reset: --yes で実行し ack を出す", async () => {
    const ble = makeFakeBle({ reset: vi.fn(async () => ({ resultCode: 0, payload: Buffer.alloc(0) })) });
    const { ctx, outputs } = makeCtx({ ble });
    await buildProgram(ctx).parseAsync(["ble", "reset", "mylock", "--yes"], { from: "user" });
    expect(ble.reset).toHaveBeenCalledTimes(1);
    expect(outputs[0]).toMatchObject({ ok: true, resultCode: 0, resultName: "success" });
  });

  it("reset: 対話で No は中断 (reset を呼ばない)", async () => {
    const ble = makeFakeBle({ reset: vi.fn() });
    const confirm = vi.fn(async () => false);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ctx, makeBleCalls } = makeCtx({ ble, canPrompt: true, confirm });
    await buildProgram(ctx).parseAsync(["ble", "reset", "mylock"], { from: "user" });
    expect(confirm).toHaveBeenCalled();
    expect(ble.reset).not.toHaveBeenCalled();
    expect(makeBleCalls).toHaveLength(0);
    errSpy.mockRestore();
  });

  it("position: 整数 2 値を configureLockPosition へ (負値も可)", async () => {
    const ble = makeFakeBle({ configureLockPosition: vi.fn(async () => ({ resultCode: 0, payload: Buffer.alloc(0) })) });
    const { ctx, outputs } = makeCtx({ ble });
    await buildProgram(ctx).parseAsync(["ble", "position", "mylock", "0", "-256"], { from: "user" });
    expect(ble.configureLockPosition).toHaveBeenCalledWith(0, -256);
    expect(outputs[0]).toMatchObject({ ok: true, lockPosition: 0, unlockPosition: -256, resultCode: 0 });
  });

  it("position: 非整数は die(2)", async () => {
    const { ctx } = makeCtx({ ble: makeFakeBle() });
    await expect(
      buildProgram(ctx).parseAsync(["ble", "position", "mylock", "abc", "0"], { from: "user" }),
    ).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe("ble wifi (WM2/Hub3 自動判別)", () => {
  /** onPublish + 各コマンドを持つ fake view。 */
  function makeView(publishOnScan = []) {
    let cb = null;
    return {
      calls: [],
      onPublish(fn) { cb = fn; return () => { cb = null; }; },
      async scanWifiSSID() { for (const p of publishOnScan) cb(p); return { resultCode: 0 }; },
      async setWifiSSID(ssid) { this.calls.push(["setWifiSSID", ssid]); return { resultCode: 0 }; },
      async setWifiPassword(pw) { this.calls.push(["setWifiPassword", pw]); return { resultCode: 0 }; },
      async connectWifi() { this.calls.push(["connectWifi"]); return { resultCode: 0 }; },
    };
  }

  it("hub_3: ssid 設定は hub3() view へ委譲される", async () => {
    const view = makeView();
    const ble = makeFakeBle({ hub3: vi.fn(() => view), wifi: vi.fn() }, "hub_3");
    const { ctx, outputs } = makeCtx({ ble });
    await buildProgram(ctx).parseAsync(["ble", "wifi", "myhub", "ssid", "my-net"], { from: "user" });
    expect(ble.hub3).toHaveBeenCalled();
    expect(ble.wifi).not.toHaveBeenCalled();
    expect(view.calls).toEqual([["setWifiSSID", "my-net"]]);
    expect(outputs[0]).toMatchObject({ ok: true, action: "ssid", resultCode: 0, resultName: "success" });
  });

  it("wm_2: password / connect は wifi() view へ委譲される", async () => {
    const view = makeView();
    const ble = makeFakeBle({ wifi: vi.fn(() => view), hub3: vi.fn() }, "wm_2");
    const { ctx } = makeCtx({ ble });
    const program = buildProgram(ctx);
    await program.parseAsync(["ble", "wifi", "mywm2", "password", "pw123"], { from: "user" });
    await program.parseAsync(["ble", "wifi", "mywm2", "connect"], { from: "user" });
    expect(view.calls).toEqual([["setWifiPassword", "pw123"], ["connectWifi"]]);
  });

  it("hub_3 への connect は die(2) (Hub3 に CONNECT_WIFI は無い)", async () => {
    const ble = makeFakeBle({ hub3: vi.fn() }, "hub_3");
    const { ctx, makeBleCalls } = makeCtx({ ble });
    await expect(
      buildProgram(ctx).parseAsync(["ble", "wifi", "myhub", "connect"], { from: "user" }),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(makeBleCalls).toHaveLength(0); // 接続前に弾く
  });

  it("scan は publish を収集して SSID 一覧を出す (Hub3 は SSID_LAST で確定)", async () => {
    const view = makeView([
      { kind: "scanWifiSSID", ssid: "net-a", rssi: -40 },
      { kind: "ssidMarker", itemCode: 134 }, // HUB3_ITEM_CODE_SSID_LAST
    ]);
    const ble = makeFakeBle({ hub3: vi.fn(() => view) }, "hub_3");
    const { ctx, outputs } = makeCtx({ ble });
    await buildProgram(ctx).parseAsync(["ble", "wifi", "myhub", "scan", "--timeout", "60000"], { from: "user" });
    expect(outputs[0]).toMatchObject({ ok: true, ssids: [{ ssid: "net-a", rssi: -40 }] });
  });

  it("Wi-Fi 非対応 model (sesame_5) は die(2)", async () => {
    const { ctx, makeBleCalls } = makeCtx({ ble: makeFakeBle() });
    await expect(
      buildProgram(ctx).parseAsync(["ble", "wifi", "mylock", "scan"], { from: "user" }),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(makeBleCalls).toHaveLength(0);
  });

  it("未知 action / 値欠落は die(2)", async () => {
    const ble = makeFakeBle({ hub3: vi.fn() }, "hub_3");
    const { ctx } = makeCtx({ ble });
    await expect(
      buildProgram(ctx).parseAsync(["ble", "wifi", "myhub", "frobnicate"], { from: "user" }),
    ).rejects.toMatchObject({ exitCode: 2 });
    await expect(
      buildProgram(makeCtx({ ble }).ctx).parseAsync(["ble", "wifi", "myhub", "ssid"], { from: "user" }),
    ).rejects.toMatchObject({ exitCode: 2 });
  });
});
