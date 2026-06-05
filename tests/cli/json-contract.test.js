// CLI の --json 出力契約のスモークテスト (他言語からの subprocess 呼び出し前提)。
// 契約:
//   1. --json 時、成功コマンドは stdout に純 JSON を 1 件だけ出す (人間向けログは stderr)。
//   2. エラーは stderr に {error,code} JSON + 非 0 exit (stdout は汚さない)。
//   3. 非対話/--json でプロンプトに入って固まらない。
//   4. commander 自身の usage エラー (引数不足/未知オプション) も上記契約に従う。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BIN = resolve(__dirname, "..", "..", "bin", "sesame.js");
let workDir;

beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), "sesame-json-")); });
afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

/** sesame をサブプロセスで実行。{code, stdout, stderr} を返す (throw しない)。stdin は空。 */
function runCli(args) {
  try {
    const stdout = execFileSync("node", [BIN, ...args, "--config-dir", workDir], {
      input: "", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}

describe("CLI --json 出力契約", () => {
  it("成功コマンドは stdout に純 JSON を 1 件だけ出す (meta)", () => {
    const r = runCli(["meta", "--json"]);
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.stdout); // throw しなければ単一 JSON
    expect(obj.region).toBeTruthy();
  });

  it("config path --json は {dir} を stdout に出す (生パスを垂れ流さない)", () => {
    const r = runCli(["config", "path", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).dir).toBe(workDir);
  });

  it("locks add はフラグで非対話登録でき、stdout は純 JSON", () => {
    runCli(["init"]);
    const r = runCli([
      "locks", "add", "--json",
      "--name", "front",
      "--uuid", "AABBCCDD-1111-2222-3333-444455556666",
      "--secret", "00112233445566778899aabbccddeeff",
      "--model", "sesame_5_pro",
    ]);
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.stdout);
    expect(obj).toMatchObject({ ok: true, lock: "front" });
    // 登録が効いていることを locks ls --json で確認
    const ls = runCli(["locks", "ls", "--json"]);
    expect(ls.code).toBe(0);
    expect(() => JSON.parse(ls.stdout)).not.toThrow();
    expect(ls.stdout).toContain("front");
  });

  it("locks add は非対話で必須フラグ欠落なら固まらず JSON エラーで落ちる", () => {
    runCli(["init"]);
    const r = runCli(["locks", "add", "--json"]); // フラグ無し・stdin 空
    expect(r.code).not.toBe(0);
    expect(r.stdout).toBe(""); // stdout を汚さない
    const err = JSON.parse(r.stderr);
    expect(err.error).toBeTruthy();
    expect(typeof err.code).toBe("number");
  });

  it("実行時エラーは stderr に {error,code} JSON + 非 0 exit (login: email 必須)", () => {
    const r = runCli(["login", "--json"]); // commander の missing-argument 経由
    expect(r.code).not.toBe(0);
    expect(r.stdout).toBe("");
    const err = JSON.parse(r.stderr);
    expect(err.error).toContain("email");
  });

  it("未知オプションも JSON エラー封筒で落ちる", () => {
    const r = runCli(["meta", "--json", "--no-such-flag"]);
    expect(r.code).not.toBe(0);
    expect(() => JSON.parse(r.stderr)).not.toThrow();
    expect(JSON.parse(r.stderr).error).toBeTruthy();
  });

  it("非 JSON モードでは人間向けエラー (Error:/error:) を stderr に出す", () => {
    const r = runCli(["login"]); // --json 無し
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("error");
    // JSON 封筒ではない (人間向け)
    expect(() => JSON.parse(r.stderr)).toThrow();
  });
});
