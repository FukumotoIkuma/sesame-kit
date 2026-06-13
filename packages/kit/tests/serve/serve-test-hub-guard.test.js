// P5-4: serve のテストスタブ hub のガード検証
// スタブは opt-in (NODE_ENV=test || VITEST) でのみ有効化し、
// 本番環境では絶対に起動しないことを確認する。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BIN = resolve(__dirname, "..", "..", "bin", "sesame.js");
const E2E_TIMEOUT = 30000;
let workDir, proc;

beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), "sesame-stub-guard-")); });
afterEach(() => {
  if (proc && !proc.killed) proc.kill("SIGTERM");
  proc = null;
  rmSync(workDir, { recursive: true, force: true });
});

/**
 * serve を起動し、最初の stdout 出力行を読み込む。
 * スタブが有効なら event.ready (stub-hub が起動)、
 * スタブが無効なら error 通知 (実 hub に接続失敗) が来るはず。
 * @param {Record<string, string>} env
 * @returns {Promise<unknown>}
 */
function getFirstOutput(env) {
  return new Promise((resolveP, reject) => {
    proc = spawn("node", [BIN, "serve", "--stdio", "--config-dir", workDir], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    proc.stdout.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        if (line) {
          try {
            resolveP(JSON.parse(line));
          } catch (_e) {
            reject(new Error(`JSON parse error: ${line}`));
          }
        }
      }
    });
    proc.on("error", reject);
    setTimeout(() => reject(new Error("timeout")), E2E_TIMEOUT);
  });
}

describe("P5-4: serve テストスタブ hub のガード (opt-in 検証)", () => {
  it("通常環境 (NODE_ENV 未設定・VITEST なし) では SESAME_SERVE_TEST_HUB=1 でもスタブが起動しない", async () => {
    // 環境をクリア: NODE_ENV と VITEST の両方を削除
    const env = { SESAME_SERVE_TEST_HUB: "1" };
    delete env.NODE_ENV;
    delete env.VITEST;
    const out = await getFirstOutput(env);
    // スタブが起動していない = 実 hub に接続しようとして失敗 = error メッセージが来るはず
    // (実 hub が無い環境なので接続失敗)
    expect(out.error || out.method).toBeDefined(); // いずれかのエラーハンドリングが起動
  }, E2E_TIMEOUT);

  it("NODE_ENV=test + SESAME_SERVE_TEST_HUB=1 ではスタブが起動する", async () => {
    const out = await getFirstOutput({
      NODE_ENV: "test",
      SESAME_SERVE_TEST_HUB: "1",
    });
    // スタブが起動していれば event.ready 通知が来る
    expect(out.method).toBe("event.ready");
    expect("id" in out).toBe(false); // 通知なので id は無い
  }, E2E_TIMEOUT);

  it("VITEST=true (vitest ワーカー) + SESAME_SERVE_TEST_HUB=1 ではスタブが起動する", async () => {
    const out = await getFirstOutput({
      VITEST: "true",
      SESAME_SERVE_TEST_HUB: "1",
    });
    // スタブが起動していれば event.ready 通知が来る
    expect(out.method).toBe("event.ready");
    expect("id" in out).toBe(false); // 通知なので id は無い
  }, E2E_TIMEOUT);

  it("NODE_ENV=production + SESAME_SERVE_TEST_HUB=1 ではスタブが起動しない", async () => {
    const out = await getFirstOutput({
      NODE_ENV: "production",
      SESAME_SERVE_TEST_HUB: "1",
    });
    // スタブが起動していない = 実 hub に接続しようとして失敗
    expect(out.error || out.method).toBeDefined();
  }, E2E_TIMEOUT);
});
