// `sesame org role ls` の表示 (P3-10) と `sesame org keys rm` の randomTag 自動補完 (BIZ-12) の
// 配線テスト (in-process。実 WS なし)。
//
// 出典:
//   - role 行の実フィールドは {tag, access[]} (references_web/src/components/biz/device/DataTableColumns.js:560-575)。
//   - ゲスト鍵削除は randomTag = cmacTime(device.secretKey) が必須
//     (references_web/src/components/DeviceUserList.js:117-132)。
import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import { registerOrgCommands } from "../../src/cli/org.js";
import { cmacTime } from "@sesame-kit/core/crypto";

/** fake ctx。withAccount は即 fn(hub, {opts}) を呼ぶ。human 表示 (humanFn) を必ず実行する。 */
function makeCtx({ hub, json = false }) {
  const outputs = [];
  const ctx = {
    outputs,
    out: (isJson, humanFn, jsonObj) => { outputs.push(jsonObj); if (!isJson) humanFn(); },
    die: (msg, code) => { const e = new Error(msg); /** @type {any} */ (e).exitCode = code; throw e; },
    canPrompt: () => false,
    withHub: (fn) => fn(hub, { opts: { json } }),
    withAccount: (fn) => fn(hub, { opts: { json } }),
    prompts: { selectFromList: vi.fn(), promptText: vi.fn(), confirm: vi.fn(), promptLine: vi.fn() },
    parseJson: (raw) => JSON.parse(raw),
  };
  return ctx;
}

function buildProgram(ctx) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerOrgCommands(program, ctx);
  return program;
}

afterEach(() => vi.restoreAllMocks());

describe("org role ls (P3-10: 表示は実フィールド {tag, access[]})", () => {
  it("各行を `tag\\taccess.join(',')` で表示する (id/name フォールバックは廃止)", async () => {
    const tags = [
      { tag: "オーナー", access: ["ユーザー", "デバイス（ドア・認証機器）", "カード管理", "全体履歴", "開発者向け"] },
      { tag: "Admin", access: ["ユーザー", "カード管理"] },
    ];
    const hub = { org: { getTags: async () => tags } };
    const ctx = makeCtx({ hub });
    const lines = [];
    vi.spyOn(console, "log").mockImplementation((s) => lines.push(String(s)));

    await buildProgram(ctx).parseAsync(["org", "role", "ls"], { from: "user" });

    // 表示スナップショット (実フィールド名。"(no-id) (no-name)" は出ない)
    expect(lines).toEqual([
      "Found 2 role tag(s):",
      "  オーナー\tユーザー,デバイス（ドア・認証機器）,カード管理,全体履歴,開発者向け",
      "  Admin\tユーザー,カード管理",
    ]);
    // JSON 側は生の配列を返す
    expect(ctx.outputs[0]).toEqual({ ok: true, count: 2, tags });
  });

  it("0 件は (no role tags)", async () => {
    const hub = { org: { getTags: async () => [] } };
    const ctx = makeCtx({ hub });
    const lines = [];
    vi.spyOn(console, "log").mockImplementation((s) => lines.push(String(s)));
    await buildProgram(ctx).parseAsync(["org", "role", "ls"], { from: "user" });
    expect(lines).toEqual(["(no role tags)"]);
  });
});

describe("org keys rm (BIZ-12: ゲスト鍵の randomTag 自動補完)", () => {
  const SECRET = "00112233445566778899aabbccddeeff";

  function makeHub({ devices, onRemove }) {
    return {
      listDevices: vi.fn(async () => devices),
      org: { removeEmployeeDeviceKey: vi.fn(async (params) => { onRemove?.(params); return { success: true }; }) },
    };
  }

  it("guestKeyId あり + randomTag 未指定なら listDevices の secretKey から cmacTime で補完する", async () => {
    /** @type {any} */
    let received = null;
    const hub = makeHub({
      devices: [{ deviceUUID: "DEV-1", secretKey: SECRET }],
      onRemove: (p) => { received = p; },
    });
    const ctx = makeCtx({ hub, json: true });

    // cmacTime は 256 秒粒度の時刻 CMAC。境界レースを避けるため前後で期待値を計算する。
    const before = cmacTime(SECRET);
    await buildProgram(ctx).parseAsync(
      ["org", "keys", "rm", "--json", '{"guestKeyId":"g-1","deviceUUID":"DEV-1"}'],
      { from: "user" },
    );
    const after = cmacTime(SECRET);

    expect(hub.listDevices).toHaveBeenCalledTimes(1);
    expect(received.data.guestKeyId).toBe("g-1");
    expect(received.data.randomTag).toMatch(/^[0-9a-f]{8}$/);
    expect([before, after]).toContain(received.data.randomTag); // DeviceUserList.js:117-132 と同計算
  });

  it("randomTag 明示時は上書きしない (listDevices も呼ばない)", async () => {
    /** @type {any} */
    let received = null;
    const hub = makeHub({ devices: [], onRemove: (p) => { received = p; } });
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["org", "keys", "rm", "--json", '{"guestKeyId":"g-1","deviceUUID":"DEV-1","randomTag":"cafebabe"}'],
      { from: "user" },
    );
    expect(hub.listDevices).not.toHaveBeenCalled();
    expect(received.data.randomTag).toBe("cafebabe");
  });

  it("従業員削除 (subUUID) は補完経路に入らない", async () => {
    /** @type {any} */
    let received = null;
    const hub = makeHub({ devices: [], onRemove: (p) => { received = p; } });
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["org", "keys", "rm", "--json", '{"subUUID":"s-1","deviceUUID":"DEV-1"}'],
      { from: "user" },
    );
    expect(hub.listDevices).not.toHaveBeenCalled();
    expect(received.data).toEqual({ subUUID: "s-1", deviceUUID: "DEV-1" });
  });

  it("デバイスが devices 一覧に無ければ die (randomTag を自動計算できない)", async () => {
    const hub = makeHub({ devices: [{ deviceUUID: "OTHER", secretKey: SECRET }] });
    const ctx = makeCtx({ hub, json: true });
    await expect(
      buildProgram(ctx).parseAsync(
        ["org", "keys", "rm", "--json", '{"guestKeyId":"g-1","deviceUUID":"DEV-1"}'],
        { from: "user" },
      ),
    ).rejects.toThrow(/DEV-1/);
    expect(hub.org.removeEmployeeDeviceKey).not.toHaveBeenCalled();
  });

  it("secretKey 欠落デバイスも die", async () => {
    const hub = makeHub({ devices: [{ deviceUUID: "DEV-1" }] });
    const ctx = makeCtx({ hub, json: true });
    await expect(
      buildProgram(ctx).parseAsync(
        ["org", "keys", "rm", "--json", '{"guestKeyId":"g-1","deviceUUID":"DEV-1"}'],
        { from: "user" },
      ),
    ).rejects.toThrow(/secretKey/);
  });
});
