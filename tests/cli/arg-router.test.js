// デバイス主語ルーター (run() の firstTok 判定) を実バイナリで検証する。
//
// 回帰: firstTok 検出が「最初の非 - トークン」を素朴に拾っていたため、値を取るグローバル
// オプション `--config-dir <path>` の **値** (path) をデバイス名と誤認し、
// `sesame --config-dir /x init` を device="/x" として op へ誤ルートしていた。結果、
// グローバルオプションをサブコマンドより前に置くと管理コマンドが動かなかった
// (`--config-dir` を末尾に置く回避が必要だった)。値オプションの次トークンを読み飛ばして修正。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BIN = resolve(__dirname, "..", "..", "bin", "sesame.js");
let workDir;

beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), "sesame-router-")); });
afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

function run(args) {
  try {
    const stdout = execFileSync("node", [BIN, ...args], { input: "", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}

describe("デバイス主語ルーターと値オプション", () => {
  it("--config-dir をサブコマンドより前に置いても init が動く (値をデバイス名と誤認しない)", () => {
    const r = run(["--config-dir", workDir, "init"]);
    expect(r.code).toBe(0);
    expect(existsSync(join(workDir, "config.json"))).toBe(true);
  });

  it("--config-dir を末尾に置いても従来どおり動く", () => {
    const r = run(["init", "--config-dir", workDir]);
    expect(r.code).toBe(0);
    expect(existsSync(join(workDir, "config.json"))).toBe(true);
  });

  it("先頭がデバイス名なら従来どおり op へルートされる", () => {
    run(["--config-dir", workDir, "init"]);
    // 未登録デバイス名 → デバイス主語実行へ入り、ロック未登録/未発見で die (op へ届いている証跡)。
    const r = run(["--config-dir", workDir, "somedevice", "status", "--cloud-only", "--json"]);
    expect(r.code).not.toBe(0);
    // commander の "unknown command" ではなく、デバイス op 経路のエラーであること。
    expect(r.stderr).not.toMatch(/unknown command/i);
  });
});
