// P1-3: runBleOp の OS2 ルーティング検証。
//
// OS2 model のデバイスが --ble-only / autolock で BLE 経路に入ったとき:
//   (a) ssmPublicKey 未保存 → OS2 専用エラーメッセージ (OS3 ファサードへ誤接続しない証跡)
//   (b) ssmPublicKey 保存済み → OS3 ファサードではなく OS2 ファサードに渡ろうとする
//       (実 BLE 接続は不可な test 環境では noble/アダプタ初期化前のエラーになるが、
//        「ssmPublicKey 未設定」エラーは出ない = 正しいファサードに到達済みの証跡)
//
// OS3 model は従来の SesameBle.use 経路を維持し、OS2 専用エラーを出さない。
//
// テストは実機接続なしで行うため「BLE not found / noble error」までしか進まないが、
// エラー分岐の違い (OS2 vs OS3 のメッセージ) でルーティングの正しさを確認する。
//
// モデル選択根拠:
//   - sesame_2: OS2 ロック。LOCK_MODELS (config.js) に含まれ、`locks add` が受理する。
//   - ssmbot_1: OS2 Bot。LOCK_MODELS に含まれ、`locks add` が受理する。click が BLE 能力。
//   - bike_1:   OS2 Bike。LOCK_MODELS に含まれない → ConfigStore.addLock() で直接挿入する
//               (status-transport.test.js と同じ手法)。unlock が BLE 能力。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConfigStore } from "@sesame-kit/core/config";

const BIN = resolve(__dirname, "..", "..", "bin", "sesame.js");
let workDir;

beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), "sesame-os2-route-")); });
afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

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

function addLockViaApi(name, model, extra = {}) {
  // `locks add --json` でモデルの許可リストを通す (sesame_2/ssmbot_1 は LOCK_MODELS に含まれる)。
  const args = [
    "locks", "add", "--json", "--name", name,
    "--uuid", "AABBCCDD-1111-2222-3333-444455556666",
    "--secret", "00112233445566778899aabbccddeeff",
    "--model", model,
  ];
  if (extra.ssmPublicKey) args.push("--ssm-public-key", extra.ssmPublicKey);
  if (extra.keyIndex) args.push("--key-index", extra.keyIndex);
  return runCli(args);
}

// OS2 デバイスの BLE 操作: ssmPublicKey 未設定 → OS2 専用エラーを出す。
// これは SesameBle (OS3 ファサード) に渡ってしまっていたら出ないエラーなので、
// OS2 経路が正しく分岐したことの証跡になる。
describe("OS2 BLE ルーティング (runBleOp os===2 分岐)", () => {
  it("sesame_2 (OS2 lock) で --ble-only unlock: ssmPublicKey 未保存 → OS2 専用エラー", () => {
    runCli(["init"]);
    addLockViaApi("s2lock", "sesame_2");
    const r = runCli(["s2lock", "unlock", "--ble-only", "--json"]);
    expect(r.code).not.toBe(0);
    // OS2 専用エラー (cli.os2BleNeedSsmPublicKey) を含む。
    // SesameBle (OS3) に落ちていたら "Bluetooth" / "BLE adapter" 等になる。
    expect(r.stderr).toMatch(/ssmPublicKey|ssm-public-key|os2-register/i);
  }, 10000);

  it("sesame_2 (OS2 lock) で autolock: ssmPublicKey 未保存 → OS2 専用エラー (autolock は BLE 必須 op)", () => {
    runCli(["init"]);
    addLockViaApi("s2lock", "sesame_2");
    const r = runCli(["s2lock", "autolock", "30", "--json"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/ssmPublicKey|ssm-public-key|os2-register/i);
  }, 10000);

  it("ssmbot_1 (OS2 bot) で --ble-only click: ssmPublicKey 未保存 → OS2 専用エラー", () => {
    runCli(["init"]);
    addLockViaApi("mybot", "ssmbot_1");
    const r = runCli(["mybot", "click", "--ble-only", "--json"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/ssmPublicKey|ssm-public-key|os2-register/i);
  }, 10000);

  it("bike_1 (OS2 bike) で --ble-only unlock: ssmPublicKey 未保存 → OS2 専用エラー", () => {
    runCli(["init"]);
    // bike_1 は LOCK_MODELS 外なので ConfigStore 直接挿入 (status-transport.test.js と同じ手法)。
    ConfigStore.fromConfigDir(workDir).addLock("mybike", {
      deviceUUID: "AABBCCDD-1111-2222-3333-444455556666",
      secretKey: "00112233445566778899aabbccddeeff",
      model: "bike_1",
    });
    const r = runCli(["mybike", "unlock", "--ble-only", "--json"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/ssmPublicKey|ssm-public-key|os2-register/i);
  }, 10000);
});

// OS3 デバイスの BLE 操作: OS2 専用エラーを出さない (既存経路を壊していない)。
describe("OS3 BLE ルーティング (runBleOp os===3 経路が維持されること)", () => {
  it("sesame_5 (OS3 lock) で --ble-only unlock: OS2 専用エラーは出ない", () => {
    runCli(["init"]);
    addLockViaApi("front", "sesame_5");
    const r = runCli(["front", "unlock", "--ble-only", "--json"]);
    expect(r.code).not.toBe(0);
    // OS3 はコードが BLE アダプタ初期化まで進む。
    // OS2 専用の「ssmPublicKey 未設定」エラーが出ていないことが証跡。
    expect(r.stderr).not.toMatch(/ssmPublicKey|ssm-public-key requires|os2-register/i);
  }, 10000);

  it("bot_2 (OS3 bot) で --ble-only click: OS2 専用エラーは出ない", () => {
    runCli(["init"]);
    addLockViaApi("mybot2", "bot_2");
    const r = runCli(["mybot2", "click", "--ble-only", "--json"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).not.toMatch(/ssmPublicKey|ssm-public-key requires|os2-register/i);
  }, 10000);
});

// ssmPublicKey 保存済み OS2 デバイスは OS2 ファサードに渡る。
// 実 BLE 接続できないため Bluetooth 権限/アダプタエラーになるが、OS2 専用エラーは出ない。
describe("OS2 BLE ルーティング: ssmPublicKey 保存済みは OS2 ファサードへ", () => {
  it("sesame_2 で ssmPublicKey 保存済み → OS2 専用エラーは出ない (ファサードに到達)", () => {
    runCli(["init"]);
    // ssmPublicKey は 128hex (64B)。テスト用のダミー値。
    addLockViaApi("s2lock", "sesame_2", { ssmPublicKey: "a".repeat(128), keyIndex: "0000" });
    const r = runCli(["s2lock", "unlock", "--ble-only", "--json"]);
    expect(r.code).not.toBe(0);
    // OS2 専用エラーが出ない = ssmPublicKey チェックを通過してファサードに到達した証跡。
    // (BLE アダプタが無ければ Bluetooth 権限/アダプタ初期化エラーで終了する。)
    expect(r.stderr).not.toMatch(/ssmPublicKey.*Save it|ssm-public-key.*requires|os2-register/i);
  }, 10000);
});
