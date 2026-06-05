// 同梱 Python クライアント (clients/python/sesame_client.py) を**実 serve プロセス**に対して叩く e2e。
// python3 が無い環境では skip。サーバは SESAME_SERVE_TEST_HUB=1 のスタブ hub で実クラウドに繋がない。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BIN = resolve(__dirname, "..", "..", "bin", "sesame.js");
const PYDIR = resolve(__dirname, "..", "..", "clients", "python");
const hasPython = spawnSync("python3", ["--version"]).status === 0;

let workDir, proc;
beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), "sesame-pyc-")); });
afterEach(() => { if (proc && !proc.killed) proc.kill("SIGKILL"); proc = null; rmSync(workDir, { recursive: true, force: true }); });

const PY_ASSERT = `
import sys
import sesame_client as sc
sock, base, token = sys.argv[1], sys.argv[2], sys.argv[3]
c = sc.SesameClient.unix(sock)
st = c.status()
assert st.get("connected") is True, ("status", st)
assert "contractVersion" in st, ("no contractVersion", st)
assert len(c.discover_names()) > 50, ("too few methods")
assert c.unlock("front").get("ok") is True, ("unlock failed")
h = sc.SesameClient.http(base, token)
assert h.status().get("connected") is True, ("http status")
# 不正 topic の subscribe は SesameError を raise する (握り潰さない)
try:
    h.subscribe(["bogus_topic"], lambda t, p: None)
    print("FAIL: subscribe did not raise"); sys.exit(1)
except sc.SesameError:
    pass
print("PYOK")
`;

describe.skipIf(!hasPython)("Python 同梱クライアント e2e", () => {
  it("unix/http で status・discover・unlock が通り、不正 topic は raise", async () => {
    const socketPath = join(workDir, "s.sock");
    const httpPort = 18099;
    // serve を起動 (stub hub)。token は <configDir>/serve.token に書かれる。
    proc = spawn("node", [BIN, "serve", "--socket", socketPath, "--http", String(httpPort), "--config-dir", workDir],
      { env: { ...process.env, SESAME_SERVE_TEST_HUB: "1" }, stdio: ["ignore", "ignore", "pipe"] });
    // stderr に "ready" が出るまで待つ。
    await new Promise((res, rej) => {
      let buf = "";
      proc.stderr.on("data", (d) => { buf += d.toString(); if (/ready/.test(buf)) res(); });
      proc.on("error", rej);
      setTimeout(() => rej(new Error("serve start timeout")), 8000);
    });
    const token = spawnSync("node", ["-e", `process.stdout.write(require("fs").readFileSync(require("path").join(${JSON.stringify(workDir)}, "serve.token"), "utf8").trim())`]).stdout.toString();
    const r = spawnSync("python3", ["-c", PY_ASSERT, socketPath, `http://127.0.0.1:${httpPort}`, token],
      { env: { ...process.env, PYTHONPATH: PYDIR }, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`python assertions failed:\n${r.stdout}\n${r.stderr}`);
    expect(r.stdout).toContain("PYOK");
  });
});
