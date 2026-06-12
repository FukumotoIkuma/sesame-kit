// cli/errors.js: エラー/終了コード契約の純ロジックを検証する。
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  EXIT, withStaleHint, commanderErrorInfo, isCommanderError, runtimeExitCode,
  setJsonMode, isJsonMode, maybeHandleBleError,
} from "../../src/cli/errors.js";
// バックログ9: cli.js の既存 import 互換 (re-export) も契約として固定する。
import { maybeHandleBleError as reExported } from "../../src/cli.js";
import { SesameError, ERR } from "../../src/errors.js";

describe("cli/errors: 終了コード契約", () => {
  it("EXIT は 0/1/2 (README 契約)", () => {
    expect(EXIT.OK).toBe(0);
    expect(EXIT.RUNTIME).toBe(1);
    expect(EXIT.USAGE).toBe(2);
  });

  it("commander の usage エラーは exit 2 に統一される", () => {
    for (const code of [
      "commander.unknownCommand", "commander.unknownOption",
      "commander.missingArgument", "commander.excessArguments",
      "commander.optionMissingArgument",
    ]) {
      const { code: exit } = commanderErrorInfo({ code, message: "error: boom", exitCode: 1 });
      expect(exit).toBe(2);
    }
  });

  it("commanderErrorInfo は先頭 'error: ' を剥がす", () => {
    const { msg } = commanderErrorInfo({ code: "commander.unknownCommand", message: "error: unknown command 'x'" });
    expect(msg).toBe("unknown command 'x'");
  });

  it("非 usage の commander エラーは exitCode を尊重", () => {
    const { code } = commanderErrorInfo({ code: "commander.executeSubCommandAsync", message: "x", exitCode: 7 });
    expect(code).toBe(7);
  });

  it("isCommanderError は commander.* のみ true", () => {
    expect(isCommanderError({ code: "commander.help" })).toBe(true);
    expect(isCommanderError({ code: "boom" })).toBe(false);
    expect(isCommanderError(new Error("x"))).toBe(false);
  });

  it("runtimeExitCode は exitCode を尊重し、無ければ 1", () => {
    expect(runtimeExitCode(new Error("x"))).toBe(1);
    expect(runtimeExitCode(Object.assign(new Error("x"), { exitCode: 5 }))).toBe(5);
  });
});

describe("cli/errors: withStaleHint", () => {
  it("stale っぽいエラーにはヒントを足す", () => {
    const out = withStaleHint(new Error("triggerLock failed: not found"));
    expect(out).not.toBe("triggerLock failed: not found");
    expect(out).toContain("sync"); // ローカライズ済みヒントに sync コマンド導線が入る
  });

  it("無関係なエラーはそのまま", () => {
    expect(withStaleHint(new Error("everything is fine"))).toBe("everything is fine");
  });

  it("JSON-RPC 構造化エラー (rpcError) にはヒントを付けない (typo を config 古いと誤誘導しない)", () => {
    const e = Object.assign(new Error("Method not found: nope.method"), { rpcError: true, code: -32601 });
    expect(withStaleHint(e)).toBe("Method not found: nope.method");
  });

  it("data.kind を持つエラーにはヒントを付けない", () => {
    const e = Object.assign(new Error("not found"), { data: { kind: "not_implemented" } });
    expect(withStaleHint(e)).toBe("not found");
  });

  it("型付き SesameError にはヒントを付けない", () => {
    const e = new SesameError("device not found", { code: ERR.BAD_REQUEST });
    expect(withStaleHint(e)).toBe("device not found");
  });
});

describe("cli/errors: json mode", () => {
  it("setJsonMode/isJsonMode をトグルできる", () => {
    setJsonMode(true); expect(isJsonMode()).toBe(true);
    setJsonMode(false); expect(isJsonMode()).toBe(false);
  });
});

describe("SURF-19: BLE 環境エラーの終了コード契約 (maybeHandleBleError 直接テスト)", () => {
  // BLE_UNAUTHORIZED 等は実行環境のランタイム障害であり usage(2) ではない → exit 1。
  // バックログ9: 旧テストは cli.js のソース文字列を固定して関数抽出を阻んでいた。
  // 関数は cli/errors.js へ移動し、副作用 (platform / spawn / exitCode) を deps 注入して
  // BLE エラーオブジェクトを直接流し、exit code / --json 封筒 / bleCode を検証する。
  const BLE_CODES = [
    "BLE_UNAUTHORIZED", "BLE_UNSUPPORTED", "BLE_POWERED_OFF", "BLE_INIT_TIMEOUT", "BLE_NO_ADAPTER",
  ];

  /** deps を spy 化して呼び、{handled, exitCodes, spawned, stderr} を返す。 */
  function callWith(err, { json = false, platform = "linux" } = {}) {
    setJsonMode(json);
    const exitCodes = [];
    const spawnFn = vi.fn(() => ({ unref: () => {} }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handled = maybeHandleBleError(err, {
      platform,
      spawnFn,
      setExitCode: (c) => exitCodes.push(c),
    });
    const stderr = errSpy.mock.calls.map((c) => c.join(" "));
    errSpy.mockRestore();
    setJsonMode(false);
    return { handled, exitCodes, spawned: spawnFn.mock.calls, stderr };
  }

  afterEach(() => { setJsonMode(false); vi.restoreAllMocks(); });

  it("BLE 環境エラー 5 種すべてで exit 1 を設定する (2 は usage 専用)", () => {
    for (const code of BLE_CODES) {
      const { handled, exitCodes } = callWith(Object.assign(new Error("boom"), { code }));
      expect(handled).toBe(true);
      expect(exitCodes).toEqual([EXIT.RUNTIME]); // 1。回帰: かつて exit 2 を返していた
    }
  });

  it("--json 封筒は {error, code:1, bleCode} (code は exit code と一致、bleCode 維持)", () => {
    const { stderr, exitCodes } = callWith(
      Object.assign(new Error("no bt"), { code: "BLE_POWERED_OFF" }), { json: true },
    );
    expect(exitCodes).toEqual([1]);
    const env = JSON.parse(stderr[0]);
    expect(env).toEqual({ error: "no bt", code: 1, bleCode: "BLE_POWERED_OFF" });
  });

  it("BLE 系でない code は false を返し副作用ゼロ (呼び出し側の通常エラー経路へ)", () => {
    const { handled, exitCodes, stderr } = callWith(Object.assign(new Error("x"), { code: "ENOENT" }));
    expect(handled).toBe(false);
    expect(exitCodes).toEqual([]);
    expect(stderr).toEqual([]);
    expect(maybeHandleBleError(new Error("no code"), { setExitCode: () => {} })).toBe(false);
  });

  it("macOS + BLE_UNAUTHORIZED (非 JSON) は設定ペインを open し誘導文を出す", () => {
    const { handled, spawned, stderr } = callWith(
      Object.assign(new Error("denied"), { code: "BLE_UNAUTHORIZED" }), { platform: "darwin" },
    );
    expect(handled).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(spawned[0][0]).toBe("open");
    expect(spawned[0][1][0]).toContain("Privacy_Bluetooth");
    expect(stderr[0]).toBe("Error: denied");
  });

  it("--json では設定ペインを開かない (機械可読出力を汚さない)", () => {
    const { spawned } = callWith(
      Object.assign(new Error("denied"), { code: "BLE_UNAUTHORIZED" }),
      { platform: "darwin", json: true },
    );
    expect(spawned).toHaveLength(0);
  });

  it("cli.js からの re-export は同一実体 (既存 import 互換)", () => {
    expect(reExported).toBe(maybeHandleBleError);
  });
});
