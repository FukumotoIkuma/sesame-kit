// CLI のエラー/終了コード契約・秘匿ファイル権限・言語永続化を実バイナリで検証する。
// (回帰: usage エラーが exit 1 / 設定ディレクトリが 0755 / `--lang en init` で config が ja のまま)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BIN = resolve(__dirname, "..", "..", "bin", "sesame.js");
const isPosix = process.platform !== "win32";
let work;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), "sesame-contract-")); });
afterEach(() => { rmSync(work, { recursive: true, force: true }); });

// spawnSync は終了コードに関わらず stdout/stderr を両方返す (execFileSync は成功時 stderr を捨てる)。
function run(args) {
  const r = spawnSync("node", [BIN, ...args], { input: "", encoding: "utf8" });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
const mode = (p) => statSync(p).mode & 0o777;

describe("CLI 終了コード契約 (usage error = 2)", () => {
  const cd = () => ["--config-dir", join(work, "cfg")];

  it("未知コマンドは exit 2", () => {
    expect(run([...cd(), "no_such_command"]).code).toBe(2);
  });
  it("未知オプションは exit 2", () => {
    expect(run([...cd(), "--bogus-opt"]).code).toBe(2);
  });
  it("必須引数欠落 (login) は exit 2", () => {
    expect(run([...cd(), "login"]).code).toBe(2);
  });
  it("--json 時も usage エラーは封筒 code:2", () => {
    const r = run([...cd(), "no_such_command", "--json"]);
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stderr.trim())).toMatchObject({ code: 2 });
  });
});

describe("秘匿ファイル権限", () => {
  it("init は設定ディレクトリを 0700 で作る", () => {
    const dir = join(work, "cfg");
    expect(run(["--config-dir", dir, "init"]).code).toBe(0);
    if (isPosix) expect(mode(dir)).toBe(0o700);
  });

  it("migrate は 0644 の旧トークンを 0600 へ締めて取り込む", () => {
    const src = join(work, "src"); mkdirSync(src);
    const old = join(src, ".tokens.json");
    writeFileSync(old, JSON.stringify({ idToken: "x", refreshToken: "y" }), { mode: 0o644 });
    const dir = join(work, "cfg");
    expect(run(["--config-dir", dir, "migrate", src]).code).toBe(0);
    if (isPosix) expect(mode(join(dir, "tokens.json"))).toBe(0o600);
  });
});

describe("言語の永続化と警告", () => {
  it("--lang en init は config に uiLang/lang=en を焼き込む", () => {
    const dir = join(work, "cfg");
    expect(run(["--config-dir", dir, "--lang", "en", "init"]).code).toBe(0);
    const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
    expect(cfg.uiLang).toBe("en");
    expect(cfg.lang).toBe("en");
  });

  it("未知の --lang は警告を出す (黙って英語に落とさない)", () => {
    const r = run(["--config-dir", join(work, "cfg"), "--lang", "xx", "config", "path"]);
    expect(r.stderr.toLowerCase()).toMatch(/unknown --lang|未知の --lang/);
  });
});
