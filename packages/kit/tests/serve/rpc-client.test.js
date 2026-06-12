// `sesame rpc` クライアント (src/cli/serve.js の rpcCall) を実バイナリで end-to-end 検証する。
//
// 回帰: デーモンは 1 接続ごとに event.ready 通知を応答より先に 1 本流す。以前の rpcCall は
// 「最初の 1 行 = 応答」と決め打ちしてその event.ready を掴んでしまい、result が undefined に
// なっていた (`sesame rpc` は `reading 'methods'` で crash、`sesame rpc <m>` は "undefined" を
// 出力)。socket framing 側のテストはデーモンしか叩いておらず、このクライアント経路は無検証
// だったためすり抜けた。ここではクライアント経路ごと実 spawn で固定する。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BIN = resolve(__dirname, "..", "..", "bin", "sesame.js");
const E2E_TIMEOUT = 30000;
let workDir, proc;

beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), "sesame-rpc-")); });
afterEach(() => {
  if (proc && !proc.killed) proc.kill("SIGTERM");
  proc = null;
  rmSync(workDir, { recursive: true, force: true });
});

/** UDS デーモンを起動し、ソケットが現れるまで待つ。 */
function startDaemon() {
  return new Promise((resolveP, reject) => {
    proc = spawn("node", [BIN, "serve", "--config-dir", workDir], {
      env: { ...process.env, SESAME_SERVE_TEST_HUB: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.on("error", reject);
    const sock = join(workDir, "sesame.sock");
    const t0 = Date.now();
    const wait = setInterval(() => {
      if (existsSync(sock)) { clearInterval(wait); resolveP(); }
      else if (Date.now() - t0 > E2E_TIMEOUT) { clearInterval(wait); reject(new Error("daemon socket never appeared")); }
    }, 50);
  });
}

/** `sesame rpc ...` クライアントを実 spawn して stdout を返す。 */
function rpcClient(args) {
  const r = spawnSync("node", [BIN, "rpc", ...args, "--config-dir", workDir], {
    env: { ...process.env, SESAME_SERVE_TEST_HUB: "1" },
    encoding: "utf8",
    timeout: E2E_TIMEOUT,
  });
  return r;
}

describe("sesame rpc client (UDS, end-to-end)", () => {
  it("`sesame rpc` (method 省略) が event.ready を読み飛ばして method 一覧を引ける", async () => {
    await startDaemon();
    const r = rpcClient([]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/undefined/);
    expect(r.stdout).toContain("org.getEmployees");
    expect(r.stderr).not.toMatch(/Cannot read properties/);
  });

  it("`sesame rpc status` が event.ready を読み飛ばして本来の result を返す", async () => {
    await startDaemon();
    const r = rpcClient(["status"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).not.toBe("undefined");
    const parsed = JSON.parse(r.stdout);
    expect(parsed.connected).toBe(true);
    expect(parsed).toHaveProperty("apiVersion");
  });

  it("`sesame rpc events.subscribe` は一時購読として成功させず --subscribe に誘導する", async () => {
    await startDaemon();
    const r = rpcClient(["events.subscribe", "--params", '{"topics":["lockState"]}']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/--subscribe|persistent stream/i);
  });
});

/** HTTP デーモンをエフェメラルポートで起動し、URL (token は serve.token に保存される) を返す。 */
function startHttpDaemon() {
  return new Promise((resolveP, reject) => {
    proc = spawn("node", [BIN, "serve", "--no-socket", "--http", "0", "--config-dir", workDir], {
      env: { ...process.env, SESAME_SERVE_TEST_HUB: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.on("error", reject);
    let buf = "";
    const onData = (d) => {
      buf += d.toString();
      const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { proc.stdout.off("data", onData); proc.stderr.off("data", onData); resolveP(`http://127.0.0.1:${m[1]}`); }
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    setTimeout(() => reject(new Error("http daemon never printed its URL")), E2E_TIMEOUT);
  });
}

describe("sesame rpc client (HTTP, end-to-end)", () => {
  it("`sesame rpc --http` が serve --http に繋ぎ method 一覧を引ける (token は serve.token から自動)", async () => {
    const url = await startHttpDaemon();
    const r = rpcClient(["--http", url]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("org.getEmployees");
    expect(r.stderr).not.toMatch(/Cannot read properties|401/);
  });

  it("`sesame rpc status --http` が result を返す", async () => {
    const url = await startHttpDaemon();
    const r = rpcClient(["status", "--http", url]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.connected).toBe(true);
  });

  it("不正トークンは 401 を分かりやすく案内する", async () => {
    const url = await startHttpDaemon();
    const r = rpcClient(["status", "--http", url, "--token", "wrong"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/401/);
  });

  it("未起動の HTTP 先は接続不可を案内する (黙って固まらない)", async () => {
    // 起動しない。到達不能ポートを指定。
    const r = rpcClient(["status", "--http", "http://127.0.0.1:1"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/cannot reach|HTTP/i);
  });
});
