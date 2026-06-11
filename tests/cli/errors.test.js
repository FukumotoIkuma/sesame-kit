// cli/errors.js: エラー/終了コード契約の純ロジックを検証する。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  EXIT, withStaleHint, commanderErrorInfo, isCommanderError, runtimeExitCode,
  setJsonMode, isJsonMode,
} from "../../src/cli/errors.js";
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

describe("SURF-19: BLE 環境エラーの終了コード契約", () => {
  // BLE_UNAUTHORIZED 等は実行環境のランタイム障害であり usage(2) ではない → exit 1。
  // maybeHandleBleError は cli.js の内部関数で、経路を起動するには実 BLE 環境 (権限拒否等)
  // が必要なため、ここではソースを直接固定する (回帰: かつて exit 2 を返していた)。
  it("maybeHandleBleError は exit 1 を設定し、--json 封筒も code:1 + bleCode を保つ", () => {
    const src = readFileSync(new URL("../../src/cli.js", import.meta.url), "utf8");
    const start = src.indexOf("function maybeHandleBleError");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n}", start) + 2);
    expect(body).toContain("process.exitCode = 1");
    expect(body).not.toContain("process.exitCode = 2");
    expect(body).toContain("code: 1, bleCode: code"); // --json 封筒: code は exit code と一致、bleCode 維持
  });
});
