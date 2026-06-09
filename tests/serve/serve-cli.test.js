// `sesame serve` を実バイナリで spawn し、stdio フレーミングを end-to-end 検証する。
// 実クラウドに繋がないよう SESAME_SERVE_TEST_HUB=1 でスタブ hub を使う。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BIN = resolve(__dirname, "..", "..", "bin", "sesame.js");
// 実 `node bin/sesame.js` を spawn する e2e。CLI 一式のコールドロードは、フルスイート
// 並列実行下では多数の vitest ワーカーと CPU を奪い合い、vitest 既定の 5s testTimeout を
// 稀に超える。超えると afterEach の SIGTERM が出力前の子を殺し、stdout 空 →
// JSON.parse("") で落ちる (偽陽性)。spawn 系は本質的に unit より遅いので余裕を持たせる。
const E2E_TIMEOUT = 30000;
let workDir, proc;

beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), "sesame-serve-")); });
afterEach(() => {
  if (proc && !proc.killed) proc.kill("SIGTERM");
  proc = null;
  rmSync(workDir, { recursive: true, force: true });
});

/** serve --stdio を起動し、複数 JSON-RPC を送って応答行を集める。 */
function runStdioSession(requests) {
  return new Promise((resolveP, reject) => {
    proc = spawn("node", [BIN, "serve", "--stdio", "--config-dir", workDir], {
      env: { ...process.env, SESAME_SERVE_TEST_HUB: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out = [];
    let buf = "";
    proc.stdout.on("data", (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (!("id" in msg)) continue; // event.ready 等の通知は応答として数えない
        out.push(msg);
        if (out.length >= requests.length) { proc.stdin.end(); }
      }
    });
    proc.on("error", reject);
    proc.on("close", () => resolveP(out));
    // stderr (人間向け案内) が出てから送る — ready を待つ。
    proc.stderr.once("data", () => {
      for (const r of requests) proc.stdin.write(JSON.stringify(r) + "\n");
    });
    setTimeout(() => { if (proc && !proc.killed) proc.kill("SIGKILL"); reject(new Error("timeout")); }, E2E_TIMEOUT);
  });
}

describe("sesame serve --stdio (end-to-end)", () => {
  it("rpc.discover が全名前空間 op を列挙し、status/未知 method も契約どおり", async () => {
    const res = await runStdioSession([
      { jsonrpc: "2.0", id: 1, method: "rpc.discover" },
      { jsonrpc: "2.0", id: 2, method: "status" },
      { jsonrpc: "2.0", id: 3, method: "no.such.method" },
      { jsonrpc: "2.0", id: 4, method: "lock.unlock", params: { name: "front" } },
    ]);
    const byId = Object.fromEntries(res.map((r) => [r.id, r]));

    // rpc.discover: OpenRPC + 全名前空間が見える
    const names = byId[1].result.methods.map((m) => m.name);
    expect(byId[1].result.openrpc).toBe("1.2.6");
    for (const m of ["lock.unlock", "org.getEmployees", "iot.setHub3LedDuty", "access.getCards",
      "schedule.getScheduleList", "company.getCompanies", "presetir.emitAir", "events.subscribe"]) {
      expect(names).toContain(m);
    }
    // status
    expect(byId[2].result).toMatchObject({ connected: true, subUUID: "stub-sub" });
    // 未知 method
    expect(byId[3].error.code).toBe(-32601);
    // 看板 op lock.unlock が stdio 経路でも hub に届く (5 番目の framing)
    expect(byId[4].result).toMatchObject({ ok: true, name: "front" });
  }, E2E_TIMEOUT); // 並列スイート実行下で実プロセス spawn が遅れても落ちないよう余裕を持たせる

  it("stdout は純 JSON-RPC のみ (人間向け案内は stderr)", async () => {
    const res = await runStdioSession([{ jsonrpc: "2.0", id: 1, method: "status" }]);
    // 全行が JSON としてパースできている (runStdioSession が JSON.parse 済み)
    expect(res).toHaveLength(1);
    expect(res[0].jsonrpc).toBe("2.0");
  }, E2E_TIMEOUT); // 並列スイート実行下で実プロセス spawn が遅れても落ちないよう余裕を持たせる

  it("起動直後に event.ready を stdout へ通知する (stderr 儀式の代替)", async () => {
    const firstLine = await new Promise((resolveP, reject) => {
      proc = spawn("node", [BIN, "serve", "--stdio", "--config-dir", workDir], {
        env: { ...process.env, SESAME_SERVE_TEST_HUB: "1" }, stdio: ["pipe", "pipe", "pipe"],
      });
      let buf = "";
      proc.stdout.on("data", (d) => {
        buf += d.toString();
        const nl = buf.indexOf("\n");
        if (nl >= 0) resolveP(JSON.parse(buf.slice(0, nl)));
      });
      proc.on("error", reject);
      setTimeout(() => reject(new Error("timeout")), E2E_TIMEOUT);
    });
    expect(firstLine.method).toBe("event.ready");
    expect("id" in firstLine).toBe(false); // 通知なので id は無い
  }, E2E_TIMEOUT); // 並列スイート実行下で実プロセス spawn が遅れても落ちないよう余裕を持たせる
});

/** 引数つきで bin を spawn し、{code, stdout, stderr} を返す (待受しない短命コマンド用)。 */
function runCli(args) {
  return new Promise((resolveP, reject) => {
    proc = spawn("node", [BIN, ...args, "--config-dir", workDir], {
      env: { ...process.env, SESAME_SERVE_TEST_HUB: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => resolveP({ code, stdout, stderr }));
    setTimeout(() => { if (proc && !proc.killed) proc.kill("SIGKILL"); reject(new Error("timeout")); }, E2E_TIMEOUT);
  });
}

describe("sesame serve framing 選択 (usage エラー)", () => {
  it("--no-socket 単独 (他フレーミング無し) は exit 2 で待受せず明示拒否する", async () => {
    const { code, stderr } = await runCli(["serve", "--no-socket"]);
    expect(code).toBe(2); // usage エラー (0=success,1=runtime,2=usage)
    expect(stderr).toMatch(/at least one|1 つ以上|framing|フレーミング/i);
  }, E2E_TIMEOUT);
});

describe("sesame rpc --params 不正 JSON のエラー契約", () => {
  it("非 --json は人間向けメッセージで exit 2", async () => {
    const { code, stderr } = await runCli(["rpc", "--params", "{bad", "status"]);
    expect(code).toBe(2);
    expect(stderr).toMatch(/--params/);
    // 構造化封筒ではない (人間向け)。
    expect(() => JSON.parse(stderr.trim())).toThrow();
  }, E2E_TIMEOUT);

  it("--json は {error,code:2} の構造化封筒を stderr に出して exit 2", async () => {
    const { code, stdout, stderr } = await runCli(["--json", "rpc", "--params", "{bad", "status"]);
    expect(code).toBe(2);
    expect(stdout.trim()).toBe(""); // stdout は成功 JSON 専用 (エラーは出さない)
    const env = JSON.parse(stderr.trim());
    expect(env.code).toBe(2);
    expect(typeof env.error).toBe("string");
    expect(env.error).toMatch(/--params/);
  }, E2E_TIMEOUT);
});

describe("sesame rpc --paths (機械可読な接続情報)", () => {
  it("socket / tokenFile / token を JSON で出力する", async () => {
    const out = await new Promise((resolveP, reject) => {
      proc = spawn("node", [BIN, "rpc", "--paths", "--config-dir", workDir], { stdio: ["ignore", "pipe", "pipe"] });
      let buf = "";
      proc.stdout.on("data", (d) => { buf += d.toString(); });
      proc.on("error", reject);
      proc.on("close", () => resolveP(buf));
      setTimeout(() => reject(new Error("timeout")), E2E_TIMEOUT);
    });
    const info = JSON.parse(out);
    expect(info.socket).toContain("sesame.sock");
    expect(info.tokenFile).toContain("serve.token");
    expect(info.token).toBeNull(); // HTTP 未起動なので token ファイルは無い
  }, E2E_TIMEOUT); // 並列スイート実行下で実プロセス spawn が遅れても落ちないよう余裕を持たせる
});
