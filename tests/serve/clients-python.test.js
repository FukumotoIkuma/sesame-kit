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
# transport-level 413 も undefined/generic ではなく SesameError(kind/code) で見える
try:
    h.call("status", big="a" * 1100000)
    print("FAIL: large request did not raise"); sys.exit(1)
except sc.SesameError as e:
    assert e.kind == "bad_params", ("kind", e.kind)
    assert e.code == 413, ("code", e.code)
    assert str(e), "empty error message"
# 不正 topic の subscribe は SesameError を raise する (握り潰さない)
try:
    h.subscribe(["bogus_topic"], lambda t, p: None)
    print("FAIL: subscribe did not raise"); sys.exit(1)
except sc.SesameError:
    pass
# SSE subscribe の URL に token を載せない (ヘッダ認証で漏洩防止)。urlopen を捕捉して URL を検査。
import urllib.request as _u
captured = {}
_orig = _u.urlopen
def _spy(req, *a, **k):
    captured["url"] = req.full_url if hasattr(req, "full_url") else req
    captured["auth"] = (req.get_header("Authorization") if hasattr(req, "get_header") else None)
    return _orig(req, *a, **k)
_u.urlopen = _spy
try:
    h.subscribe(["lockState"], lambda t, p: None)
finally:
    _u.urlopen = _orig
assert "token=" not in captured.get("url", ""), ("token leaked in SSE url", captured.get("url"))
assert token not in captured.get("url", ""), ("token value leaked in SSE url")
assert captured.get("auth") == f"Bearer {token}", ("missing Authorization header", captured.get("auth"))
print("PYOK")
`;

// 設定ディレクトリ解決の優先順位が CLI (src/paths.js) と一致するか:
//   1. SESAME_KIT_HOME → そのディレクトリ直下
//   2. XDG_CONFIG_HOME → $XDG/sesame-kit
//   3. ~/.config/sesame-kit
const PY_PATHS = `
import os, sys
import sesame_client as sc
# 1. SESAME_KIT_HOME が最優先
os.environ["SESAME_KIT_HOME"] = "/tmp/skh"
os.environ["XDG_CONFIG_HOME"] = "/tmp/xdg"
assert sc._default_socket_path() == "/tmp/skh/sesame.sock", sc._default_socket_path()
assert sc._default_token_path() == "/tmp/skh/serve.token", sc._default_token_path()
# 2. SESAME_KIT_HOME 無し → XDG_CONFIG_HOME/sesame-kit
del os.environ["SESAME_KIT_HOME"]
assert sc._default_socket_path() == "/tmp/xdg/sesame-kit/sesame.sock", sc._default_socket_path()
assert sc._default_token_path() == "/tmp/xdg/sesame-kit/serve.token", sc._default_token_path()
# 3. どちらも無し → ~/.config/sesame-kit
del os.environ["XDG_CONFIG_HOME"]
home = os.path.expanduser("~")
assert sc._default_socket_path() == os.path.join(home, ".config", "sesame-kit", "sesame.sock"), sc._default_socket_path()
print("PATHOK")
`;

describe.skipIf(!hasPython)("Python 同梱クライアント パス解決", () => {
  it("SESAME_KIT_HOME → XDG_CONFIG_HOME → ~/.config の優先順位が CLI と一致する", () => {
    // 親プロセスの env を汚さないよう、子で純粋に解決ロジックだけを検証する。
    const env = { ...process.env, PYTHONPATH: PYDIR, PYTHONDONTWRITEBYTECODE: "1" };
    delete env.SESAME_KIT_HOME;
    delete env.XDG_CONFIG_HOME;
    const r = spawnSync("python3", ["-c", PY_PATHS], { env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`python path assertions failed:\n${r.stdout}\n${r.stderr}`);
    expect(r.stdout).toContain("PATHOK");
  });
});

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
      { env: { ...process.env, PYTHONPATH: PYDIR, PYTHONDONTWRITEBYTECODE: "1" }, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`python assertions failed:\n${r.stdout}\n${r.stderr}`);
    expect(r.stdout).toContain("PYOK");
  });
});
