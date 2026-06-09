// `sesame <device> status` の経路選択 (pickTransport) を実バイナリで end-to-end 検証する。
//
// 回帰: status はヘルプが謳う action (unlock/lock/toggle/click/status/autolock) かつ非対話の
// 既定動作だが、制御 op の capability リストには載らない (mech 状態の読み取りであって制御では
// ないため)。以前は pickTransport が transportsForOp の空配列を見て、mech を持つ lock/bot でも
// 「No transport available for status (unsupported on this model)」で即死し、status が全モデル・
// 全経路で使えなかった。実行層 (ble.status / getDeviceStatus) は両経路で status を扱えるのに、
// ゲートだけが弾いていた。ここでは: mech 型は経路ゲートを通過し (未ログインなら login 案内まで
// 進む)、mech を持たない hub は従来どおり非対応で弾く、を固定する。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BIN = resolve(__dirname, "..", "..", "bin", "sesame.js");
let workDir;

beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), "sesame-status-")); });
afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

/** sesame をサブプロセスで実行 (--config-dir は末尾)。{code, stdout, stderr} を返す。 */
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

function addLock(name, model) {
  return runCli([
    "locks", "add", "--json", "--name", name,
    "--uuid", "AABBCCDD-1111-2222-3333-444455556666",
    "--secret", "00112233445566778899aabbccddeeff",
    "--model", model,
  ]);
}

describe("sesame <device> status の経路ゲート", () => {
  it("mech を持つ lock は status の経路ゲートを通過する (未ログインなら login 案内まで進む)", () => {
    runCli(["init"]);
    expect(addLock("front", "sesame_5").code).toBe(0);
    const r = runCli(["front", "status", "--cloud-only", "--json"]);
    expect(r.code).not.toBe(0); // 未ログインなので最終的には失敗する
    // 回帰の核心: 「経路なし/非対応」で弾かれてはいけない。ログイン案内まで到達していること。
    expect(r.stderr).not.toMatch(/No transport available|unsupported on this model/);
    expect(r.stderr).toMatch(/logged in|login/i);
  }, 15000);

  it("mech を持たない hub は status を従来どおり非対応で弾く", () => {
    runCli(["init"]);
    expect(addLock("myhub", "hub_3").code).toBe(0);
    const r = runCli(["myhub", "status", "--cloud-only", "--json"]);
    expect(r.code).not.toBe(0);
    const err = JSON.parse(r.stderr);
    expect(err.error).toMatch(/No transport available|unsupported on this model/);
  }, 15000);
});
