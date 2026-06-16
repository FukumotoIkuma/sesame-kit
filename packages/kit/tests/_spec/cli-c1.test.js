// packages/kit/tests/_spec/cli-c1.test.js
// Spec-driven tests for CLI-0019, CLI-0020, CLI-0022, CLI-0028, CLI-0029
// (CLI 横断機構 — 対話ゲート / selectFromList 契約 / config redact / parseJson / run() catch 順序)
//
// TDD: assertions follow spec contracts. Where implementation diverges from spec
// the test will be red (intentional — do not adjust assertions to match bugs).
// No network / BLE / real device access — all pure-function or mock-based.
//
// セットアップ: KIT_SETUP (vitest.config.js) で ja ロケール固定・カタログ登録済みのため
// ここでは i18n セットアップは不要。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── @inquirer/prompts must be mocked before importing prompts.js ─────────────
vi.mock("@inquirer/prompts", () => ({
  select: vi.fn(),
  input: vi.fn(),
  confirm: vi.fn(),
}));

// ─── imports ──────────────────────────────────────────────────────────────────

import { select } from "@inquirer/prompts";
import { isInteractive, selectFromList } from "../../src/prompts.js";
import { canPrompt, redactConfig, makeCtx } from "../../src/cli/ctx.js";
import {
  setJsonMode,
  isJsonMode,
  die,
  EXIT,
  maybeHandleBleError,
  isCommanderError,
  commanderErrorInfo,
  withStaleHint,
  runtimeExitCode,
} from "../../src/cli/errors.js";

// ─── shared helpers ───────────────────────────────────────────────────────────

/** process.exit を捕捉して throw に変換する (die() がテスト中に実プロセスを終了しないように)。 */
function interceptExit() {
  return vi.spyOn(process, "exit").mockImplementation((code) => {
    const e = new Error(`process.exit(${code})`);
    e.exitCode = code;
    throw e;
  });
}

/** commander Command の opts() だけを持つ最小フェイク。 */
function makeProgram(globalOpts = {}) {
  return { opts: () => ({ json: false, debug: false, configDir: undefined, ...globalOpts }) };
}

// ─── CLI-0019 ─────────────────────────────────────────────────────────────────

describe("[CLI-0019] isInteractive/canPrompt が TTY かつ --json 無しのときだけ対話を許可", () => {
  // isInteractive() は process.stdin.isTTY && process.stdout.isTTY の Boolean。
  // canPrompt(program) は isInteractive() && !program.opts().json と同値。
  // ref: packages/kit/src/prompts.js:12-14; packages/kit/src/cli/ctx.js:160-162

  /** process.stdin / stdout の isTTY を一時的に差し替えるヘルパ。 */
  function withTTY(stdinTTY, stdoutTTY, fn) {
    const origIn = process.stdin.isTTY;
    const origOut = process.stdout.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: stdinTTY, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: stdoutTTY, configurable: true });
    try { return fn(); }
    finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origIn, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: origOut, configurable: true });
    }
  }

  it("[CLI-0019] stdin.isTTY && stdout.isTTY のとき isInteractive() は true", () => {
    withTTY(true, true, () => {
      expect(isInteractive()).toBe(true);
    });
  });

  it("[CLI-0019] stdin が非 TTY (パイプ) のとき isInteractive() は false", () => {
    withTTY(false, true, () => {
      expect(isInteractive()).toBe(false);
    });
  });

  it("[CLI-0019] stdout が非 TTY (パイプ) のとき isInteractive() は false", () => {
    withTTY(true, false, () => {
      expect(isInteractive()).toBe(false);
    });
  });

  it("[CLI-0019] 両方非 TTY のとき isInteractive() は false", () => {
    withTTY(false, false, () => {
      expect(isInteractive()).toBe(false);
    });
  });

  it("[CLI-0019] TTY + 非 --json のとき canPrompt(program) は true", () => {
    withTTY(true, true, () => {
      expect(canPrompt(makeProgram({ json: false }))).toBe(true);
    });
  });

  it("[CLI-0019] TTY + --json のとき canPrompt(program) は false (JSON モードでは対話しない)", () => {
    withTTY(true, true, () => {
      expect(canPrompt(makeProgram({ json: true }))).toBe(false);
    });
  });

  it("[CLI-0019] 非 TTY + 非 --json のとき canPrompt(program) は false (パイプ/cron で固まらない)", () => {
    withTTY(false, false, () => {
      expect(canPrompt(makeProgram({ json: false }))).toBe(false);
    });
  });

  it("[CLI-0019] canPrompt は isInteractive() && !opts.json と等値 (機構の自己整合)", () => {
    withTTY(true, true, () => {
      // TTY + json=false → both true
      expect(canPrompt(makeProgram({ json: false }))).toBe(isInteractive() && !false);
      // TTY + json=true → both false
      expect(canPrompt(makeProgram({ json: true }))).toBe(isInteractive() && !true);
    });
  });
});

// ─── CLI-0020 ─────────────────────────────────────────────────────────────────

describe("[CLI-0020] selectFromList の auto-pick/空 throw/装飾剥がし契約", () => {
  // ref: packages/kit/src/prompts.js:21-23; packages/kit/src/prompts.js:56-68
  // 空/非配列→noCandidates throw、要素1個→auto-pick (select 非呼出)、
  // 複数→choices {name:getLabel(it),value:it} + pageSize:12/loop:false で select へ委譲

  beforeEach(() => {
    vi.mocked(select).mockReset();
  });

  it("[CLI-0020] 空配列を渡すと cli.noCandidates で throw し select を呼ばない", async () => {
    await expect(selectFromList("デバイスを選択", [])).rejects.toThrow(/候補がありません/);
    expect(select).not.toHaveBeenCalled();
  });

  it("[CLI-0020] undefined を渡すと cli.noCandidates で throw する", async () => {
    await expect(selectFromList("選択", undefined)).rejects.toThrow(/候補がありません/);
    expect(select).not.toHaveBeenCalled();
  });

  it("[CLI-0020] null を渡すと cli.noCandidates で throw する", async () => {
    await expect(selectFromList("選択", null)).rejects.toThrow(/候補がありません/);
  });

  it("[CLI-0020] 非配列オブジェクト { 0: 'a' } を渡すと cli.noCandidates で throw する", async () => {
    await expect(selectFromList("選択", { 0: "a" })).rejects.toThrow(/候補がありません/);
  });

  it("[CLI-0020] throw メッセージに message (第1引数) を含む", async () => {
    await expect(selectFromList("デバイスを選択", [])).rejects.toThrow(/デバイスを選択/);
  });

  it("[CLI-0020] 要素 1 個ならその要素を即返し select を呼ばない (auto-pick)", async () => {
    const only = { id: "only-lock" };
    const r = await selectFromList("選択", [only]);
    expect(r).toBe(only);
    expect(select).not.toHaveBeenCalled();
  });

  it("[CLI-0020] 複数要素のとき choices は {name:getLabel(it), value:it} の配列", async () => {
    const items = [{ id: "A" }, { id: "B" }, { id: "C" }];
    vi.mocked(select).mockResolvedValue(items[1]);
    const r = await selectFromList("? 選択してください", items, (it) => `lock:${it.id}`);
    expect(r).toBe(items[1]);
    expect(select).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(select).mock.calls[0][0];
    expect(arg.choices).toEqual([
      { name: "lock:A", value: items[0] },
      { name: "lock:B", value: items[1] },
      { name: "lock:C", value: items[2] },
    ]);
  });

  it("[CLI-0020] message の先頭 '? ' 装飾を剥がして inquirer select へ渡す (plainMessage)", async () => {
    const items = ["x", "y"];
    vi.mocked(select).mockResolvedValue("x");
    await selectFromList("? 選択してください", items);
    const arg = vi.mocked(select).mock.calls[0][0];
    expect(arg.message).toBe("選択してください");
    expect(arg.message).not.toMatch(/^\?/);
  });

  it("[CLI-0020] select へ pageSize:12 / loop:false を渡す", async () => {
    const items = ["x", "y"];
    vi.mocked(select).mockResolvedValue("x");
    await selectFromList("選択", items);
    const arg = vi.mocked(select).mock.calls[0][0];
    expect(arg.pageSize).toBe(12);
    expect(arg.loop).toBe(false);
  });

  it("[CLI-0020] select の戻り値をそのまま返す", async () => {
    const items = [{ id: "A" }, { id: "B" }];
    vi.mocked(select).mockResolvedValue(items[1]);
    const result = await selectFromList("選択", items, (it) => it.id);
    expect(result).toBe(items[1]);
  });

  it("[CLI-0020] getLabel 省略時は String() でラベル化する", async () => {
    const items = ["alpha", "beta"];
    vi.mocked(select).mockResolvedValue("beta");
    await selectFromList("選択", items);
    const arg = vi.mocked(select).mock.calls[0][0];
    expect(arg.choices.map((c) => c.name)).toEqual(["alpha", "beta"]);
  });
});

// ─── CLI-0022 ─────────────────────────────────────────────────────────────────

describe("[CLI-0022] redactConfig が secretKey をツリー全体で再帰マスクする (横断機構)", () => {
  // ref: packages/kit/src/cli/ctx.js:74-85; packages/kit/src/cli/ctx.js:61-65
  // structuredClone後にwalkで全ノードのsecretKey(string)をmask()で潰し、
  // devicesとlocksの複数箇所に渡って生32hex鍵を残さず元cfgを破壊しない。

  const RAW = "5ccec6781bb7509bdd58fa21565b647b"; // 32 hex

  const deepCfg = {
    companyID: "ch_test",
    devices: {
      front: { deviceName: "front", secretKey: RAW, sesame2PublicKey: "6b59370c" },
      back: { deviceName: "back", secretKey: RAW, sesame2PublicKey: "aabbccdd" },
    },
    locks: {
      front: { deviceUUID: "AABB", secretKey: RAW, model: "sesame_5" },
      back: { deviceUUID: "CCDD", secretKey: RAW, model: "sesame_5" },
    },
  };

  it("[CLI-0022] devices と locks の双方で secretKey をマスクし生鍵を残さない", () => {
    const r = redactConfig(deepCfg);
    expect(r.devices.front.secretKey).not.toBe(RAW);
    expect(r.devices.back.secretKey).not.toBe(RAW);
    expect(r.locks.front.secretKey).not.toBe(RAW);
    expect(r.locks.back.secretKey).not.toBe(RAW);
  });

  it("[CLI-0022] マスク後の secretKey は mask() 形式 (先頭4…末尾4 len=NN)", () => {
    const r = redactConfig(deepCfg);
    // mask() の出力形式: "{first4}…{last4} (len={n})"
    expect(r.devices.front.secretKey).toMatch(/^[a-f0-9]{4}…[a-f0-9]{4} \(len=32\)$/);
    expect(r.locks.front.secretKey).toMatch(/^[a-f0-9]{4}…[a-f0-9]{4} \(len=32\)$/);
  });

  it("[CLI-0022] JSON 出力ツリー全体に生 32hex secretKey が残らない", () => {
    const json = JSON.stringify(redactConfig(deepCfg));
    expect(json).not.toContain(RAW);
  });

  it("[CLI-0022] 非 secretKey フィールドは保持する", () => {
    const r = redactConfig(deepCfg);
    expect(r.companyID).toBe("ch_test");
    expect(r.devices.front.sesame2PublicKey).toBe("6b59370c");
    expect(r.locks.front.deviceUUID).toBe("AABB");
    expect(r.locks.front.model).toBe("sesame_5");
  });

  it("[CLI-0022] 元オブジェクトを破壊しない (structuredClone で複製してから walk)", () => {
    redactConfig(deepCfg);
    expect(deepCfg.devices.front.secretKey).toBe(RAW);
    expect(deepCfg.locks.front.secretKey).toBe(RAW);
  });

  it("[CLI-0022] null はそのまま返す", () => {
    expect(redactConfig(null)).toBe(null);
  });

  it("[CLI-0022] undefined はそのまま返す", () => {
    expect(redactConfig(undefined)).toBe(undefined);
  });

  it("[CLI-0022] 非オブジェクト (文字列) はそのまま返す", () => {
    expect(redactConfig("plain")).toBe("plain");
  });

  it("[CLI-0022] 深くネストした secretKey もマスクされる", () => {
    const nested = {
      devices: {
        hub: {
          secretKey: RAW,
          locks: {
            door: { secretKey: RAW },
          },
        },
      },
    };
    const r = redactConfig(nested);
    expect(r.devices.hub.secretKey).not.toBe(RAW);
    expect(r.devices.hub.locks.door.secretKey).not.toBe(RAW);
    expect(JSON.stringify(r)).not.toContain(RAW);
  });
});

// ─── CLI-0028 ─────────────────────────────────────────────────────────────────

describe("[CLI-0028] ctx.parseJson 横断ヘルパの --json パース失敗→die(invalidJsonValue[+invalidJsonExample],2)+undefined 契約", () => {
  // ref: packages/kit/src/cli/ctx.js:237-244
  // parseJson(raw, hint): JSON.parse 成功→値返却、失敗→die(invalidJsonValue+(hint?invalidJsonExample:''),2)+undefined

  let exitSpy;
  let errSpy;
  const stderrLines = [];

  beforeEach(() => {
    setJsonMode(false);
    stderrLines.length = 0;
    exitSpy = interceptExit();
    errSpy = vi.spyOn(console, "error").mockImplementation((...a) => stderrLines.push(a.join(" ")));
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errSpy.mockRestore();
    setJsonMode(false);
    vi.restoreAllMocks();
  });

  it("[CLI-0028] 有効な JSON 文字列を渡すと parse 値を返す (exit を呼ばない)", () => {
    const ctx = makeCtx(makeProgram());
    expect(ctx.parseJson('{"key":"value"}')).toEqual({ key: "value" });
    expect(ctx.parseJson('[1,2,3]')).toEqual([1, 2, 3]);
    expect(ctx.parseJson("42")).toBe(42);
    expect(ctx.parseJson("true")).toBe(true);
    expect(ctx.parseJson("null")).toBe(null);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("[CLI-0028] 不正な JSON は die(invalidJsonValue, 2) を呼ぶ (process.exit(2))", () => {
    const ctx = makeCtx(makeProgram());
    expect(() => ctx.parseJson("{not valid json}")).toThrow(/process\.exit\(2\)/);
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("[CLI-0028] 不正な JSON → undefined を返す (die 後 return undefined)", () => {
    // die() が process.exit を throw するので result は undefined のまま
    const exitSpyNoThrow = vi.spyOn(process, "exit").mockImplementation(() => {
      // スキップ — undefined を返す経路をシミュレート
    });
    const ctx = makeCtx(makeProgram());
    const result = ctx.parseJson("{bad}");
    expect(result).toBeUndefined();
    exitSpyNoThrow.mockRestore();
  });

  it("[CLI-0028] 不正 JSON の stderr に cli.invalidJsonValue (ja: '不正な JSON') が含まれる", () => {
    const ctx = makeCtx(makeProgram());
    try { ctx.parseJson("{invalid}"); } catch { /* interceptExit が throw */ }
    expect(stderrLines.join("\n")).toMatch(/不正な JSON/);
  });

  it("[CLI-0028] hint あり → invalidJsonValue + invalidJsonExample (二段メッセージ)", () => {
    const ctx = makeCtx(makeProgram());
    const hint = '{"uuid":"XXXX"}';
    try { ctx.parseJson("{bad}", hint); } catch { /* ok */ }
    const combined = stderrLines.join("\n");
    // invalidJsonValue 部分
    expect(combined).toMatch(/不正な JSON/);
    // invalidJsonExample 部分 (ja: "\n  例: {hint}")
    expect(combined).toMatch(/例:.*uuid/);
  });

  it("[CLI-0028] hint なし → invalidJsonExample を含まない", () => {
    const ctx = makeCtx(makeProgram());
    try { ctx.parseJson("{bad}"); } catch { /* ok */ }
    expect(stderrLines.join("\n")).not.toMatch(/例:/);
  });

  it("[CLI-0028] exit code は USAGE(2) (RUNTIME(1) ではない)", () => {
    let capturedCode = null;
    const exitSpyCapture = vi.spyOn(process, "exit").mockImplementation((code) => {
      capturedCode = code;
    });
    const ctx = makeCtx(makeProgram());
    ctx.parseJson("###");
    expect(capturedCode).toBe(2);
    expect(capturedCode).toBe(EXIT.USAGE);
    exitSpyCapture.mockRestore();
  });

  it("[CLI-0028] --json モードでは stderr に JSON 封筒 {error, code:2} を出す", () => {
    setJsonMode(true);
    const ctx = makeCtx(makeProgram({ json: true }));
    try { ctx.parseJson("{invalid}"); } catch { /* ok */ }
    const parsed = JSON.parse(stderrLines[0]);
    expect(parsed.code).toBe(2);
    expect(parsed.error).toMatch(/JSON/i);
  });

  it("[CLI-0028] --json モード + hint のとき封筒 error に hint が含まれる", () => {
    setJsonMode(true);
    const ctx = makeCtx(makeProgram({ json: true }));
    try { ctx.parseJson("{invalid}", '{"example":true}'); } catch { /* ok */ }
    const parsed = JSON.parse(stderrLines[0]);
    expect(parsed.error).toContain('{"example":true}');
    expect(parsed.code).toBe(2);
  });
});

// ─── CLI-0029 ─────────────────────────────────────────────────────────────────

describe("[CLI-0029] run() 最終 catch のエラー分類ディスパッチ順序 (help/version→debug→BLE→commander→generic)", () => {
  // ref: packages/kit/src/cli.js:264-281
  // 順序: (1) helpDisplayed/help/version → exit0
  //        (2) opts().debug → e.stack 出力
  //        (3) maybeHandleBleError 真 → finishCli+return (BLE は commander より前)
  //        (4) isCommanderError → commanderErrorInfo 経路
  //        (5) それ以外のみ die(withStaleHint(err), runtimeExitCode(err))
  //
  // BLE エラーが commander/generic より前に処理されること、
  // commander エラーが withStaleHint/runtimeExitCode に到達しないこと、
  // を機構不変条件として固定する。

  afterEach(() => {
    setJsonMode(false);
    vi.restoreAllMocks();
  });

  // ── ソース順序検証 ──

  it("[CLI-0029] ソース上: maybeHandleBleError チェックが isCommanderError チェックより前に現れる (BLE>commander順序)", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(__dirname, "../../src/cli.js"), "utf8");
    const blePos = src.indexOf("maybeHandleBleError(err)");
    const cmdPos = src.indexOf("isCommanderError(err)");
    expect(blePos).toBeGreaterThan(-1);
    expect(cmdPos).toBeGreaterThan(-1);
    expect(blePos).toBeLessThan(cmdPos);
  });

  it("[CLI-0029] ソース上: isCommanderError チェックが withStaleHint より前に現れる (commander>generic順序)", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(__dirname, "../../src/cli.js"), "utf8");
    const cmdPos = src.indexOf("isCommanderError(err)");
    const stalePos = src.indexOf("withStaleHint(err)");
    expect(cmdPos).toBeGreaterThan(-1);
    expect(stalePos).toBeGreaterThan(-1);
    expect(cmdPos).toBeLessThan(stalePos);
  });

  it("[CLI-0029] ソース上: helpDisplayed/help/version の早期 return が maybeHandleBleError より前に現れる", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(__dirname, "../../src/cli.js"), "utf8");
    const helpPos = src.indexOf("commander.helpDisplayed");
    const blePos = src.indexOf("maybeHandleBleError(err)");
    expect(helpPos).toBeGreaterThan(-1);
    expect(blePos).toBeGreaterThan(-1);
    expect(helpPos).toBeLessThan(blePos);
  });

  // ── dispatch シミュレーター ──
  //
  // run() の catch ロジックを抽出してシミュレートする。
  // 実際の run() は commander setup が絡むため直接呼ばず、
  // 各ハンドラの組み合わせとして catch 順序を検証する。

  function simulateCatch(err) {
    const e = err;

    // (1) help/version 短絡
    if (
      e.code === "commander.helpDisplayed" ||
      e.code === "commander.help" ||
      e.code === "commander.version"
    ) {
      return { route: "help" };
    }

    // (2) debug stack (副作用のみ、分岐を変えない)

    // (3) BLE エラー (commander/generic より前)
    const bleResult = { exitCode: undefined };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handled = maybeHandleBleError(err, {
      platform: "linux",
      spawnFn: vi.fn(() => ({ unref: vi.fn() })),
      setExitCode: (c) => { bleResult.exitCode = c; },
    });
    errSpy.mockRestore();
    if (handled) {
      return { route: "ble", exitCode: bleResult.exitCode };
    }

    // (4) commander usage エラー
    if (isCommanderError(err)) {
      const { msg, code } = commanderErrorInfo(e);
      return { route: "commander", msg, exitCode: code };
    }

    // (5) generic
    return {
      route: "generic",
      msg: withStaleHint(err),
      exitCode: runtimeExitCode(err),
    };
  }

  // ── (1) help/version は "help" ルートで短絡 ──

  it("[CLI-0029] commander.helpDisplayed は help ルートで短絡 (generic に到達しない)", () => {
    const r = simulateCatch(Object.assign(new Error("help"), { code: "commander.helpDisplayed" }));
    expect(r.route).toBe("help");
  });

  it("[CLI-0029] commander.help は help ルートで短絡", () => {
    const r = simulateCatch(Object.assign(new Error("help"), { code: "commander.help" }));
    expect(r.route).toBe("help");
  });

  it("[CLI-0029] commander.version は help ルートで短絡", () => {
    const r = simulateCatch(Object.assign(new Error("version"), { code: "commander.version" }));
    expect(r.route).toBe("help");
  });

  // ── (3) BLE エラーは commander/generic より前に処理 ──

  it("[CLI-0029] BLE_UNAUTHORIZED は ble ルートに到達し commander ルートに誤分類されない", () => {
    const err = Object.assign(new Error("bt denied"), { code: "BLE_UNAUTHORIZED" });
    const r = simulateCatch(err);
    expect(r.route).toBe("ble");
    expect(r.route).not.toBe("commander");
    expect(r.route).not.toBe("generic");
  });

  it("[CLI-0029] BLE_POWERED_OFF は ble ルートで RUNTIME(1) exit code (usage(2) ではない)", () => {
    const err = Object.assign(new Error("bt off"), { code: "BLE_POWERED_OFF" });
    const r = simulateCatch(err);
    expect(r.route).toBe("ble");
    expect(r.exitCode).toBe(EXIT.RUNTIME);
  });

  it("[CLI-0029] BLE_NO_ADAPTER は ble ルートで処理され die(withStaleHint) を呼ばない", () => {
    const err = Object.assign(new Error("no adapter"), { code: "BLE_NO_ADAPTER" });
    const r = simulateCatch(err);
    expect(r.route).toBe("ble");
  });

  // ── (4) commander usage エラーは generic に到達しない ──

  it("[CLI-0029] commander.unknownCommand は commander ルートで exit 2 (generic を経由しない)", () => {
    const err = Object.assign(new Error("error: unknown command 'foo'"), {
      code: "commander.unknownCommand", exitCode: 1,
    });
    const r = simulateCatch(err);
    expect(r.route).toBe("commander");
    expect(r.exitCode).toBe(EXIT.USAGE); // usage = 2
    expect(r.route).not.toBe("generic");
  });

  it("[CLI-0029] commander.missingArgument は commander ルートで exit 2", () => {
    const err = Object.assign(new Error("error: missing required argument 'email'"), {
      code: "commander.missingArgument", exitCode: 1,
    });
    const r = simulateCatch(err);
    expect(r.route).toBe("commander");
    expect(r.exitCode).toBe(EXIT.USAGE);
  });

  it("[CLI-0029] commander.unknownOption は commander ルートで exit 2", () => {
    const err = Object.assign(new Error("error: unknown option '--bogus'"), {
      code: "commander.unknownOption", exitCode: 1,
    });
    const r = simulateCatch(err);
    expect(r.route).toBe("commander");
    expect(r.exitCode).toBe(2);
  });

  // ── (5) generic エラーのみ die(withStaleHint, runtimeExitCode) に到達 ──

  it("[CLI-0029] 一般 Error は generic ルートで withStaleHint / runtimeExitCode を経由する", () => {
    const err = new Error("something went wrong");
    const r = simulateCatch(err);
    expect(r.route).toBe("generic");
    expect(r.msg).toBe("something went wrong");
    expect(r.exitCode).toBe(EXIT.RUNTIME);
  });

  it("[CLI-0029] stale っぽい平文エラーは generic ルートで withStaleHint がヒントを付与する", () => {
    const err = new Error("triggerLock failed: not found");
    const r = simulateCatch(err);
    expect(r.route).toBe("generic");
    // ja: ヒント導線に "sync" が含まれる
    expect(r.msg).toContain("sync");
  });

  // ── BLE エラーが isCommanderError(BLE_*) を通過しないことの追加保証 ──

  it("[CLI-0029] BLE_UNAUTHORIZED は isCommanderError が false を返す (BLE が先に捕捉される根拠)", () => {
    const err = Object.assign(new Error("denied"), { code: "BLE_UNAUTHORIZED" });
    expect(isCommanderError(err)).toBe(false);
  });

  // ── commander エラーが maybeHandleBleError を通過しないことの確認 ──

  it("[CLI-0029] commander.unknownCommand は maybeHandleBleError が false を返す (BLE ルートをスキップ)", () => {
    const err = Object.assign(new Error("unknown cmd"), { code: "commander.unknownCommand" });
    const handled = maybeHandleBleError(err, {
      platform: "linux",
      spawnFn: vi.fn(() => ({ unref: vi.fn() })),
      setExitCode: vi.fn(),
    });
    expect(handled).toBe(false);
  });

  // ── commander/generic 分離の定量的保証 ──

  it("[CLI-0029] commander エラーは commanderErrorInfo 経路 (withStaleHint/runtimeExitCode に到達しない)", () => {
    const cmdErr = Object.assign(new Error("error: unknown command"), {
      code: "commander.unknownCommand",
      exitCode: 1,
    });
    expect(isCommanderError(cmdErr)).toBe(true);
    const { code } = commanderErrorInfo(cmdErr);
    expect(code).toBe(EXIT.USAGE); // commanderErrorInfo は 2
    const wrongCode = runtimeExitCode(cmdErr);
    // runtimeExitCode は commander エラーを考慮しないので 1 を返す
    expect(wrongCode).toBe(EXIT.RUNTIME);
    // commander 経路 (2) と generic 経路 (1) は異なる — 誤分類防止の機構不変条件
    expect(code).not.toBe(wrongCode);
  });
});
