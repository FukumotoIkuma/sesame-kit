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
    const secret = "00112233445566778899aabbccddeeff";
    const r = runCli([
      "locks", "add", "--json",
      "--name", "front",
      "--uuid", "AABBCCDD-1111-2222-3333-444455556666",
      "--secret", secret,
      "--model", "sesame_5_pro",
    ]);
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.stdout);
    expect(obj).toMatchObject({ ok: true, lock: "front" });
    // 登録が効いていることを locks ls --json で確認
    const ls = runCli(["locks", "ls", "--json"]);
    expect(ls.code).toBe(0);
    const listed = JSON.parse(ls.stdout);
    expect(ls.stdout).toContain("front");
    expect(ls.stdout).not.toContain(secret);
    expect(listed.locks.front.secretKey).toMatch(/len=32/);
  }, 15000); // 並列スイート実行下で node を 3 回同期 spawn するため余裕を持たせる

  it("locks add は UUID/secret/model を保存前に検証する", () => {
    runCli(["init"]);
    const badUuid = runCli([
      "locks", "add", "--json",
      "--name", "bad",
      "--uuid", "not-a-uuid",
      "--secret", "00112233445566778899aabbccddeeff",
      "--model", "sesame_5",
    ]);
    expect(badUuid.code).toBe(2);
    expect(JSON.parse(badUuid.stderr).error).toMatch(/deviceUUID/i);

    const badSecret = runCli([
      "locks", "add", "--json",
      "--name", "bad",
      "--uuid", "AABBCCDD-1111-2222-3333-444455556666",
      "--secret", "nope",
      "--model", "sesame_5",
    ]);
    expect(badSecret.code).toBe(2);
    expect(JSON.parse(badSecret.stderr).error).toMatch(/secretKey/i);

    const badModel = runCli([
      "locks", "add", "--json",
      "--name", "bad",
      "--uuid", "AABBCCDD-1111-2222-3333-444455556666",
      "--secret", "00112233445566778899aabbccddeeff",
      "--model", "hub_3",
    ]);
    expect(badModel.code).toBe(2);
    expect(JSON.parse(badModel.stderr).error).toMatch(/model/i);

    const ls = runCli(["locks", "ls", "--json"]);
    expect(ls.code).toBe(0);
    expect(JSON.parse(ls.stdout).locks).toEqual({});
  }, 15000);

  it("バックログ4: locks add は --ssm-public-key/--key-index を保存し、形式不正は exit 2", () => {
    runCli(["init"]);
    const ssmPub = "ab".repeat(64);
    const ok = runCli([
      "locks", "add", "--json",
      "--name", "os2",
      "--uuid", "AABBCCDD-1111-2222-3333-444455556666",
      "--secret", "00112233445566778899aabbccddeeff",
      "--ssm-public-key", ssmPub,
      "--key-index", "0001",
    ]);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ ok: true, lock: "os2", ssmPublicKey: ssmPub, keyIndex: "0001" });
    const ls = runCli(["locks", "ls", "--json"]);
    expect(JSON.parse(ls.stdout).locks.os2).toMatchObject({ ssmPublicKey: ssmPub, keyIndex: "0001" });

    // 形式不正 (128 hex / 4 hex 以外) は usage エラー (exit 2) で保存しない
    const badPub = runCli([
      "locks", "add", "--json",
      "--name", "bad",
      "--uuid", "AABBCCDD-1111-2222-3333-444455556666",
      "--secret", "00112233445566778899aabbccddeeff",
      "--ssm-public-key", "zz".repeat(64),
    ]);
    expect(badPub.code).toBe(2);
    expect(JSON.parse(badPub.stderr).error).toMatch(/ssm-public-key/i);
    const badIdx = runCli([
      "locks", "add", "--json",
      "--name", "bad",
      "--uuid", "AABBCCDD-1111-2222-3333-444455556666",
      "--secret", "00112233445566778899aabbccddeeff",
      "--key-index", "00",
    ]);
    expect(badIdx.code).toBe(2);
    expect(JSON.parse(badIdx.stderr).error).toMatch(/key-index/i);
    const ls2 = runCli(["locks", "ls", "--json"]);
    expect(JSON.parse(ls2.stdout).locks.bad).toBeUndefined();
  }, 30000); // node を 6 回同期 spawn するため余裕を持たせる

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

  it("bootstrap は空 stdin/壊れた JSON を JSON エラー封筒で落とす", () => {
    const empty = runCli(["bootstrap", "--json"]);
    expect(empty.code).toBe(2);
    expect(empty.stdout).toBe("");
    expect(JSON.parse(empty.stderr).error).toMatch(/bootstrap/i);
  });

  it("--lang ja --help は commander 由来ラベルも日本語化する", () => {
    const r = runCli(["--lang", "ja", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("使い方:");
    expect(r.stdout).toContain("オプション:");
    expect(r.stdout).toContain("ヘルプを表示");
    expect(r.stdout).not.toContain("Usage:");
    expect(r.stdout).not.toContain("display help for command");
  });

  it("非 JSON モードでは人間向けエラー (Error:/error:) を stderr に出す", () => {
    const r = runCli(["login"]); // --json 無し
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("error");
    // JSON 封筒ではない (人間向け)
    expect(() => JSON.parse(r.stderr)).toThrow();
  });

  // ---- Phase 4 (SURF-05/24) で追加した CLI 入口の usage 契約 ----

  it("ir remote-add は --json 無しなら exit 2 (接続前に弾く)", () => {
    const r = runCli(["ir", "remote-add"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--json");
  });

  it("ir remote-add-matter は必須オプション欠落で exit 2 (不足一覧を出す)", () => {
    const r = runCli(["ir", "remote-add-matter"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--hub3-device-id");
    expect(r.stderr).toContain("--ir-device-uuid");
  });

  it("list の直指定は --hub3-device-id / --ir-device-uuid の片方だけなら exit 2", () => {
    const r = runCli(["list", "--hub3-device-id", "H"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--ir-device-uuid");
  });

  it("iot raw は --topic 欠落で exit 2 (接続前に弾く)", () => {
    const r = runCli(["iot", "raw", "--payload", "00"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--topic");
  });
});
