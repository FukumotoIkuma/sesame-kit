// オフライン上流カナリア (scripts/canary-upstream.mjs --replay) の検証。
//
// 目的: creds 無しの CI で「記録済み上流応答 (tests/fixtures/upstream/*.json) ↔ stable スキーマ
// (src/serve/result-schemas.js)」の drift を検出できることを保証する。CI が回すコマンドと
// 同一のサブプロセス実行を再現し、(1) 同梱 fixtures は全部通る、(2) スキーマ違反 fixture では
// exit 1 する、ことを確認する。
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RESULT_SCHEMAS } from "../../src/serve/result-schemas.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");
const SCRIPT = join(REPO, "scripts", "canary-upstream.mjs");
const FIXTURES_DIR = join(REPO, "tests", "fixtures", "upstream");

/** スクリプトを replay モードで起動し {status, stdout, stderr} を返す (非ゼロでも throw しない)。 */
function runReplay(extraArgs = []) {
  try {
    const stdout = execFileSync("node", [SCRIPT, "--replay", ...extraArgs], {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}

describe("upstream canary — offline replay", () => {
  it("同梱 fixtures は全て stable スキーマに適合し exit 0", () => {
    const res = runReplay();
    expect(res.stderr, res.stdout + res.stderr).toBe("");
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/no upstream drift detected/);
    expect(res.stdout).not.toMatch(/DRIFT/);
  });

  it("各 fixture の method は RESULT_SCHEMAS のキーである", () => {
    const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const fixture = JSON.parse(execFileSync("cat", [join(FIXTURES_DIR, f)], { encoding: "utf8" }));
      expect(RESULT_SCHEMAS[fixture.method], `${f}: 未知の method ${fixture.method}`).toBeTruthy();
      expect("sample" in fixture, `${f}: sample 欠落`).toBe(true);
    }
  });

  it("stable な read-only メソッド (status/whoami/devices/lock.status) の fixture が存在する", () => {
    const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
    const methods = new Set(
      files.map((f) => JSON.parse(execFileSync("cat", [join(FIXTURES_DIR, f)], { encoding: "utf8" })).method),
    );
    for (const m of ["status", "account.whoami", "devices.list", "lock.status"]) {
      expect(methods.has(m), `stable method ${m} の fixture が無い`).toBe(true);
    }
  });

  it("スキーマ違反 fixture を入れると drift を検出して exit 1", () => {
    // 同梱 fixtures を一時ディレクトリに複製し、壊れた fixture を 1 つ足して replay を回す。
    // (FIXTURES_DIR を直接汚さないため、--fixtures-dir 相当ではなく一時ディレクトリにスクリプトを
    //  向けられないので、ここでは一時ディレクトリにスクリプトと fixtures を併せて配置する。)
    const tmp = mkdtempSync(join(tmpdir(), "canary-replay-"));
    try {
      const tmpFixtures = join(tmp, "tests", "fixtures", "upstream");
      cpSync(FIXTURES_DIR, tmpFixtures, { recursive: true });
      // devices.list は要素に deviceUUID(required) が要る → string でなく数値にして違反させる。
      writeFileSync(
        join(tmpFixtures, "broken.json"),
        JSON.stringify({ method: "devices.list", sample: [{ deviceUUID: 12345 }] }),
      );
      // スクリプトは __dirname/../tests/fixtures/upstream を見るので、tmp 配下に scripts/ も置く。
      cpSync(join(REPO, "scripts"), join(tmp, "scripts"), { recursive: true });
      cpSync(join(REPO, "src"), join(tmp, "src"), { recursive: true });

      const tmpScript = join(tmp, "scripts", "canary-upstream.mjs");
      let res;
      try {
        const stdout = execFileSync("node", [tmpScript, "--replay"], { cwd: tmp, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        res = { status: 0, stdout, stderr: "" };
      } catch (e) {
        res = { status: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
      }
      expect(res.status).toBe(1);
      expect(res.stdout).toMatch(/DRIFT/);
      expect(res.stdout).toMatch(/broken\.json/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
