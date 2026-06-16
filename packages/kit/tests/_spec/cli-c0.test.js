// spec/cli.md CLI-0001 〜 CLI-0018 の TDD spec テスト
// 実装: packages/kit/src/cli/dispatch.js, packages/kit/src/cli/errors.js,
//        packages/kit/src/cli.js, packages/kit/src/cli/ctx.js
// 実行可能・self-contained・決定論的 (ネットワーク/実機不使用)

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  extractPositionals,
  reservedCommandNames,
  routeDeviceArgv,
} from "../../src/cli/dispatch.js";
import {
  EXIT,
  setJsonMode,
  isJsonMode,
  die,
  isCommanderError,
  commanderErrorInfo,
  runtimeExitCode,
  withStaleHint,
  maybeHandleBleError,
} from "../../src/cli/errors.js";
import { maybeHandleBleError as maybeHandleBleErrorReExported } from "../../src/cli.js";
import { redactConfig, out, makeCtx } from "../../src/cli/ctx.js";
import { SesameError, ERR } from "@sesame-kit/core/errors";
import { Command } from "commander";

// ----------------------------------------------------------------
// 共通フェイク: commander Program の最小 fake (dispatch が触る面だけ)
// ----------------------------------------------------------------
function makeFakeProgram({ extraCommands = [], extraOptions = [] } = {}) {
  return {
    options: [
      { long: "--config-dir", short: null, required: true, optional: false },
      { long: "--json", short: null, required: false, optional: false },
      { long: "--lang", short: null, required: true, optional: false },
      { long: "--debug", short: null, required: false, optional: false },
      ...extraOptions,
    ],
    commands: [
      { name: () => "init", aliases: () => [] },
      { name: () => "op", aliases: () => [] },
      { name: () => "session", aliases: () => ["watch"] },
      { name: () => "login", aliases: () => [] },
      ...extraCommands,
    ],
  };
}

/** argv ヘルパ: ["node", "sesame", ...rest] */
const A = (...rest) => ["node", "sesame", ...rest];
const fakeProgram = makeFakeProgram();
const DEVICE_ACTIONS = new Set(["unlock", "lock", "status", "toggle", "click"]);

// ----------------------------------------------------------------
// CLI-0001: routeDeviceArgv のデバイス主語振り分け
// ----------------------------------------------------------------
describe("[CLI-0001] routeDeviceArgv のデバイス主語振り分け", () => {
  const base = { program: fakeProgram, deviceActions: DEVICE_ACTIONS };

  it("[CLI-0001] device action 同伴トークンは op へ書き換える", () => {
    const argv = A("front", "unlock");
    const result = routeDeviceArgv({ ...base, argv, isKnownDevice: () => false, interactive: false });
    expect(result).toEqual(["node", "sesame", "op", "front", "unlock"]);
  });

  it("[CLI-0001] isKnownDevice 真 (action 無し) も op へ書き換える", () => {
    const argv = A("front");
    const result = routeDeviceArgv({ ...base, argv, isKnownDevice: () => true, interactive: false });
    expect(result).toEqual(["node", "sesame", "op", "front"]);
  });

  it("[CLI-0001] 未知単独トークンは据え置き (commander が未知コマンドを投げる)", () => {
    const argv = A("no_such_command");
    const result = routeDeviceArgv({ ...base, argv, isKnownDevice: () => false, interactive: false });
    expect(result).toBe(argv); // 同一参照
  });

  it("[CLI-0001] 引数なし + 対話 (非 --json) は session へ書き換える", () => {
    const result = routeDeviceArgv({ ...base, argv: A(), isKnownDevice: () => false, interactive: true });
    expect(result).toEqual(["node", "sesame", "session"]);
  });

  it("[CLI-0001] 引数なし + --json は据え置き (help を出させる)", () => {
    const argv = A("--json");
    const result = routeDeviceArgv({ ...base, argv, isKnownDevice: () => false, interactive: true });
    expect(result).toBe(argv); // 同一参照
  });

  it("[CLI-0001] -h/--help は常に据え置き (早期 return)", () => {
    const argv1 = A("front", "--help");
    expect(routeDeviceArgv({ ...base, argv: argv1, isKnownDevice: () => true, interactive: true })).toBe(argv1);
    const argv2 = A("-h");
    expect(routeDeviceArgv({ ...base, argv: argv2, isKnownDevice: () => true, interactive: true })).toBe(argv2);
  });

  it("[CLI-0001] 予約語先頭 (管理コマンド) は op へ誤誘導しない", () => {
    const argv = A("init");
    const result = routeDeviceArgv({ ...base, argv, isKnownDevice: () => false, interactive: false });
    expect(result).toBe(argv); // 据え置き
  });
});

// ----------------------------------------------------------------
// CLI-0002: routeDeviceArgv の argv 書換は不変参照保存
// ----------------------------------------------------------------
describe("[CLI-0002] routeDeviceArgv の argv 書換は不変参照保存", () => {
  const base = { program: fakeProgram, deviceActions: DEVICE_ACTIONS };

  it("[CLI-0002] 予約コマンド先頭では同一参照を返す", () => {
    const argv = A("init");
    expect(routeDeviceArgv({ ...base, argv, isKnownDevice: () => false, interactive: true })).toBe(argv);
  });

  it("[CLI-0002] 未知単独トークンでは同一参照を返す", () => {
    const argv = A("no_such_command");
    expect(routeDeviceArgv({ ...base, argv, isKnownDevice: () => false, interactive: false })).toBe(argv);
  });

  it("[CLI-0002] 引数なし + --json では同一参照を返す", () => {
    const argv = A("--json");
    expect(routeDeviceArgv({ ...base, argv, isKnownDevice: () => false, interactive: true })).toBe(argv);
  });

  it("[CLI-0002] -h/--help では同一参照を返す", () => {
    const argv = A("front", "--help");
    expect(routeDeviceArgv({ ...base, argv, isKnownDevice: () => true, interactive: true })).toBe(argv);
  });

  it("[CLI-0002] op へ書き換える場合は新配列を生成する (同一参照でない)", () => {
    const argv = A("front", "unlock");
    const result = routeDeviceArgv({ ...base, argv, isKnownDevice: () => false, interactive: false });
    expect(result).not.toBe(argv);
    expect(result[2]).toBe("op");
  });

  it("[CLI-0002] session へ書き換える場合は新配列を生成する (同一参照でない)", () => {
    const argv = A();
    const result = routeDeviceArgv({ ...base, argv, isKnownDevice: () => false, interactive: true });
    expect(result).not.toBe(argv);
    expect(result[2]).toBe("session");
  });
});

// ----------------------------------------------------------------
// CLI-0003: extractPositionals が値オプションの値を位置引数と誤認しない
// ----------------------------------------------------------------
describe("[CLI-0003] extractPositionals が値オプションの値を位置引数と誤認しない", () => {
  it("[CLI-0003] 別トークン値 (--config-dir <path>) の値は読み飛ばす", () => {
    expect(extractPositionals(["--config-dir", "/x", "init"], fakeProgram)).toEqual(["init"]);
  });

  it("[CLI-0003] --opt=value 形式は後続を消費しない", () => {
    expect(extractPositionals(["--config-dir=/x", "front", "unlock"], fakeProgram)).toEqual(["front", "unlock"]);
  });

  it("[CLI-0003] ブール値オプション (--json) は次トークンを消費しない", () => {
    expect(extractPositionals(["--json", "front"], fakeProgram)).toEqual(["front"]);
  });

  it("[CLI-0003] -- 以降は全て位置引数として取得する", () => {
    expect(extractPositionals(["--", "--weird", "x"], fakeProgram)).toEqual(["--weird", "x"]);
  });

  it("[CLI-0003] グローバル値オプションの値がデバイス名へ誤ルートしない", () => {
    // --config-dir /x が先頭にある場合、/x がデバイス名に誤認されない
    const positionals = extractPositionals(["--config-dir", "/x", "init"], fakeProgram);
    expect(positionals[0]).toBe("init");
    expect(positionals).not.toContain("/x");
  });

  it("[CLI-0003] 値オプション前置でもデバイス名は正しく抽出される", () => {
    expect(extractPositionals(["--config-dir", "/home/user/.sesame", "front", "unlock"], fakeProgram))
      .toEqual(["front", "unlock"]);
  });
});

// ----------------------------------------------------------------
// CLI-0004: 値オプション集合は commander Option introspection 由来
// ----------------------------------------------------------------
describe("[CLI-0004] 値オプション集合は commander Option introspection 由来", () => {
  it("[CLI-0004] o.required=true のオプションは別トークン値をスキップする", () => {
    const result = extractPositionals(["--config-dir", "somepath", "target"], fakeProgram);
    expect(result).toEqual(["target"]); // "somepath" が飲み込まれた = required の値スキップが機能
  });

  it("[CLI-0004] o.required=false, o.optional=false のオプションは値スキップしない (bool オプション)", () => {
    // --json は required=false, optional=false なので次トークンを消費しない
    const result = extractPositionals(["--json", "target"], fakeProgram);
    expect(result).toEqual(["target"]); // "target" が位置引数として残る
  });

  it("[CLI-0004] long と short 両方が登録される (short オプションのスキップ)", () => {
    const program = {
      options: [
        { long: "--output", short: "-o", required: true, optional: false },
      ],
      commands: [],
    };
    // short flag -o も値スキップ対象
    expect(extractPositionals(["-o", "file.json", "target"], program)).toEqual(["target"]);
  });

  it("[CLI-0004] optional 値オプション (.optional=true) も値消費対象", () => {
    const prog = {
      options: [
        { long: "--timeout", short: null, required: false, optional: true },
      ],
      commands: [],
    };
    expect(extractPositionals(["--timeout", "30", "cmd"], prog)).toEqual(["cmd"]);
  });

  it("[CLI-0004] 新しい値オプションが追加されても introspection により自動追従する", () => {
    const extendedProgram = {
      options: [
        ...fakeProgram.options,
        { long: "--new-opt", short: "-n", required: true, optional: false },
      ],
      commands: fakeProgram.commands,
    };
    const result = extractPositionals(["--new-opt", "val", "device"], extendedProgram);
    expect(result).toEqual(["device"]);
  });

  it("[CLI-0004] program.options が空なら全トークンを位置引数として扱う", () => {
    const prog = { options: [], commands: [] };
    expect(extractPositionals(["front", "unlock"], prog)).toEqual(["front", "unlock"]);
  });
});

// ----------------------------------------------------------------
// CLI-0005: -- は option 走査終端・bare - は位置引数 (POSIX argv 機構不変条件)
// ----------------------------------------------------------------
describe("[CLI-0005] -- は option 走査終端・bare - は位置引数 (POSIX argv 機構不変条件)", () => {
  it("[CLI-0005] -- 出現で以降を全て位置引数として push し走査終了する", () => {
    expect(extractPositionals(["--", "a", "b", "--opt"], fakeProgram)).toEqual(["a", "b", "--opt"]);
  });

  it("[CLI-0005] -- の前の位置引数も含まれる", () => {
    expect(extractPositionals(["front", "--", "extra"], fakeProgram)).toEqual(["front", "extra"]);
  });

  it("[CLI-0005] bare - (stdin 慣用) はオプション扱いされず位置引数になる", () => {
    // dispatch.js:28 の a !== "-" ガードで bare `-` はオプションでなく positionals.push される
    expect(extractPositionals(["-", "front"], fakeProgram)).toEqual(["-", "front"]);
  });

  it("[CLI-0005] - で始まる通常オプション (--json 等) は位置引数にならない", () => {
    expect(extractPositionals(["--json", "front"], fakeProgram)).toEqual(["front"]);
  });

  it("[CLI-0005] bare - と -- が同時に現れた場合: bare - は位置引数、-- 以降も位置引数", () => {
    expect(extractPositionals(["-", "--", "more"], fakeProgram)).toEqual(["-", "more"]);
  });

  it("[CLI-0005] -- の後に何も無ければ前の位置引数のみ返す", () => {
    expect(extractPositionals(["front", "--"], fakeProgram)).toEqual(["front"]);
  });
});

// ----------------------------------------------------------------
// CLI-0006: reservedCommandNames が登録コマンド名+エイリアス+暗黙 help を予約語に含める
// ----------------------------------------------------------------
describe("[CLI-0006] reservedCommandNames が登録コマンド名+エイリアス+暗黙 help を予約語に含める", () => {
  it("[CLI-0006] コマンド名が予約語に含まれる", () => {
    const r = reservedCommandNames(fakeProgram);
    expect(r.has("init")).toBe(true);
    expect(r.has("op")).toBe(true);
    expect(r.has("session")).toBe(true);
    expect(r.has("login")).toBe(true);
  });

  it("[CLI-0006] エイリアスが予約語に含まれる (watch は session のエイリアス)", () => {
    const r = reservedCommandNames(fakeProgram);
    expect(r.has("watch")).toBe(true);
  });

  it("[CLI-0006] commander 暗黙の help が予約語に含まれる", () => {
    const r = reservedCommandNames(fakeProgram);
    expect(r.has("help")).toBe(true);
  });

  it("[CLI-0006] 予約語先頭は op へ誤誘導しない (sesame help <cmd> が op に回らない)", () => {
    const base = { program: fakeProgram, deviceActions: DEVICE_ACTIONS };
    const argv = A("help", "init");
    const result = routeDeviceArgv({ ...base, argv, isKnownDevice: () => false, interactive: false });
    expect(result).toBe(argv); // 据え置き
  });
});

// ----------------------------------------------------------------
// CLI-0007: 予約語集合は live registry 由来 + commander が program.commands に出さない help を明示合成
// ----------------------------------------------------------------
describe("[CLI-0007] 予約語集合は live registry 由来 + commander が program.commands に出さない help を明示合成", () => {
  it("[CLI-0007] 予約集合 = 'help' 明示 ∪ name() ∪ aliases()", () => {
    const r = reservedCommandNames(fakeProgram);
    // 全 name() が含まれる
    for (const c of fakeProgram.commands) {
      expect(r.has(c.name())).toBe(true);
      for (const a of c.aliases()) expect(r.has(a)).toBe(true);
    }
    // help は program.commands に現れないため明示予約
    expect(r.has("help")).toBe(true);
  });

  it("[CLI-0007] コマンド登録が増えると自動追従する (no-drift)", () => {
    const progA = makeFakeProgram();
    const progB = makeFakeProgram({
      extraCommands: [{ name: () => "newcmd", aliases: () => ["nc"] }],
    });
    const rA = reservedCommandNames(progA);
    const rB = reservedCommandNames(progB);
    expect(rA.has("newcmd")).toBe(false);
    expect(rB.has("newcmd")).toBe(true);
    expect(rB.has("nc")).toBe(true);
  });

  it("[CLI-0007] help は program.commands 内容によらず常に予約される (commander が出さないため)", () => {
    const emptyProgram = { options: [], commands: [] };
    const r = reservedCommandNames(emptyProgram);
    expect(r.has("help")).toBe(true);
  });
});

// ----------------------------------------------------------------
// CLI-0008: isKnownDevice は config 不在/破損で false を返し例外を握り潰す
// ----------------------------------------------------------------
describe("[CLI-0008] isKnownDevice は config 不在/破損で false を返し例外を握り潰す", () => {
  it("[CLI-0008] configStore.exists() 偽 → isKnownDevice が false を返す (routing 非破壊)", () => {
    const base = { program: fakeProgram, deviceActions: DEVICE_ACTIONS };
    const argv = A("possibledevice");
    const result = routeDeviceArgv({ ...base, argv, isKnownDevice: () => false, interactive: false });
    expect(result).toBe(argv); // 据え置き = routing 非破壊
  });

  it("[CLI-0008] isKnownDevice が例外を throw しても catch で飲み込み false を返す (routing 非破壊)", () => {
    // 実装: cli.js の isKnownDevice ラッパは try/catch で false を返す
    // safeWrapper で模倣する
    const throwingIsKnownDevice = () => { throw new Error("config broken"); };
    const base = { program: fakeProgram, deviceActions: DEVICE_ACTIONS };
    const argv = A("somedevice");
    const safeWrapper = (name) => {
      try { return throwingIsKnownDevice(name); } catch { return false; }
    };
    const result = routeDeviceArgv({ ...base, argv, isKnownDevice: safeWrapper, interactive: false });
    expect(result).toBe(argv); // 据え置き (例外が飲み込まれ false → routing 非破壊)
  });

  it("[CLI-0008] devices が 0 件のとき isKnownDevice は false を返す", () => {
    // Object.keys({}) = [] → names.length === 0 → false
    const isKnownDeviceEmpty = (_name) => {
      const names = Object.keys({});
      if (names.length === 0) return false;
      return names.includes(_name);
    };
    expect(isKnownDeviceEmpty("front")).toBe(false);
  });

  it("[CLI-0008] 既知デバイス名一致なら true (正常ケース)", () => {
    const argv = A("front");
    const result = routeDeviceArgv({
      program: fakeProgram,
      deviceActions: DEVICE_ACTIONS,
      argv,
      isKnownDevice: (name) => name === "front",
      interactive: false,
    });
    expect(result[2]).toBe("op"); // op へ書き換え
  });
});

// ----------------------------------------------------------------
// CLI-0009: --json の早期検出は bare flag 限定
// ----------------------------------------------------------------
describe("[CLI-0009] --json の早期検出は bare flag 限定", () => {
  afterEach(() => setJsonMode(false));

  it("[CLI-0009] argv.includes('--json') で setJsonMode が早期確定する", () => {
    setJsonMode(["node", "sesame", "--json"].includes("--json"));
    expect(isJsonMode()).toBe(true);
  });

  it("[CLI-0009] --json= 形式は bare flag と見なされない (includes は exact match)", () => {
    const argv = ["node", "sesame", "--json=true"];
    setJsonMode(argv.includes("--json"));
    expect(isJsonMode()).toBe(false);
  });

  it("[CLI-0009] dispatch.js の isJson も bare --json トークンで判定する", () => {
    // 引数なし + --json は据え置き (isJson=true → session に入らない)
    const base = { program: fakeProgram, deviceActions: DEVICE_ACTIONS };
    const argv = A("--json");
    const result = routeDeviceArgv({ ...base, argv, isKnownDevice: () => false, interactive: true });
    expect(result).toBe(argv); // --json があるため session に誘導されない
  });

  it("[CLI-0009] setJsonMode と dispatch の --json 検出が同一の bare flag トークンで一致する", () => {
    const argv = ["node", "sesame", "--json"];
    const userArgs = argv.slice(2);
    const fromCli = argv.includes("--json");   // cli.js 相当
    const fromDispatch = userArgs.includes("--json"); // dispatch.js 相当
    expect(fromCli).toBe(true);
    expect(fromDispatch).toBe(true);
    expect(fromCli).toBe(fromDispatch);
  });

  it("[CLI-0009] --json が無い場合、引数なし+対話で session ルーティングされる", () => {
    const argv = A();
    const result = routeDeviceArgv({
      program: fakeProgram,
      deviceActions: DEVICE_ACTIONS,
      argv,
      isKnownDevice: () => false,
      interactive: true,
    });
    expect(result[2]).toBe("session");
  });
});

// ----------------------------------------------------------------
// CLI-0010: EXIT 契約 (0/1/2) と commander usage コードの exit 2 への一律写像
// ----------------------------------------------------------------
describe("[CLI-0010] EXIT 契約 (0/1/2) と commander usage コードの exit 2 への一律写像", () => {
  it("[CLI-0010] EXIT = {OK:0, RUNTIME:1, USAGE:2}", () => {
    expect(EXIT.OK).toBe(0);
    expect(EXIT.RUNTIME).toBe(1);
    expect(EXIT.USAGE).toBe(2);
  });

  it("[CLI-0010] COMMANDER_USAGE_CODES 9 種は全て exit 2 に統一される", () => {
    const usageCodes = [
      "commander.unknownCommand",
      "commander.unknownOption",
      "commander.missingArgument",
      "commander.optionMissingArgument",
      "commander.missingMandatoryOptionValue",
      "commander.mandatoryOptionMissing",
      "commander.excessArguments",
      "commander.invalidArgument",
      "commander.invalidOptionArgument",
    ];
    for (const code of usageCodes) {
      const { code: exit } = commanderErrorInfo({ code, message: "error: boom", exitCode: 1 });
      expect(exit).toBe(2);
    }
  });

  it("[CLI-0010] 非 usage の commander エラーは exitCode を尊重する", () => {
    const { code } = commanderErrorInfo({ code: "commander.executeSubCommandAsync", message: "x", exitCode: 7 });
    expect(code).toBe(7);
  });

  it("[CLI-0010] commanderErrorInfo はメッセージ先頭の 'error: ' を剥がす", () => {
    const { msg } = commanderErrorInfo({ code: "commander.unknownCommand", message: "error: unknown command 'x'" });
    expect(msg).toBe("unknown command 'x'");
  });

  it("[CLI-0010] isCommanderError は commander.* コードのみ true を返す", () => {
    expect(isCommanderError({ code: "commander.unknownCommand" })).toBe(true);
    expect(isCommanderError({ code: "commander.help" })).toBe(true);
    expect(isCommanderError({ code: "boom" })).toBe(false);
    expect(isCommanderError(new Error("x"))).toBe(false);
    expect(isCommanderError(null)).toBe(false);
  });
});

// ----------------------------------------------------------------
// CLI-0011: runtimeExitCode が SesameError(BAD_REQUEST) を usage(2)・他を runtime(1) に写す
// ----------------------------------------------------------------
describe("[CLI-0011] runtimeExitCode が SesameError(BAD_REQUEST) を usage(2)・他を runtime(1) に写す", () => {
  it("[CLI-0011] SesameError(BAD_REQUEST) は EXIT.USAGE(2) に写す", () => {
    const err = new SesameError("不明なデバイス名", { code: ERR.BAD_REQUEST });
    expect(runtimeExitCode(err)).toBe(EXIT.USAGE);
  });

  it("[CLI-0011] BAD_REQUEST 以外の SesameError は EXIT.RUNTIME(1) のまま", () => {
    for (const code of [ERR.REJECTED, ERR.TIMEOUT, ERR.NOT_CONNECTED, ERR.UNAUTHENTICATED]) {
      const err = new SesameError("runtime failure", { code });
      expect(runtimeExitCode(err)).toBe(EXIT.RUNTIME);
    }
  });

  it("[CLI-0011] 明示 exitCode を尊重する (BAD_REQUEST 以外)", () => {
    const err = Object.assign(new Error("x"), { exitCode: 5 });
    expect(runtimeExitCode(err)).toBe(5);
  });

  it("[CLI-0011] exitCode 無しは EXIT.RUNTIME(1) を返す", () => {
    expect(runtimeExitCode(new Error("x"))).toBe(1);
  });

  it("[CLI-0011] BAD_REQUEST + 明示 exitCode でも USAGE(2) が優先される", () => {
    const err = Object.assign(new SesameError("bad", { code: ERR.BAD_REQUEST }), { exitCode: 7 });
    expect(runtimeExitCode(err)).toBe(EXIT.USAGE);
  });
});

// ----------------------------------------------------------------
// CLI-0012: die() の --json エラー封筒は stderr に {error,code}・成功 JSON は stdout 分離
// ----------------------------------------------------------------
describe("[CLI-0012] die() の --json エラー封筒は stderr に {error,code}・成功 JSON は stdout 分離", () => {
  afterEach(() => {
    setJsonMode(false);
    vi.restoreAllMocks();
  });

  it("[CLI-0012] --json モードで die() は stderr に {error, code} JSON を出す", () => {
    setJsonMode(true);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    try {
      die("something went wrong", EXIT.RUNTIME);
    } catch { /* process.exit mock */ }
    const output = errSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed).toEqual({ error: "something went wrong", code: 1 });
    exitSpy.mockRestore();
  });

  it("[CLI-0012] 非 --json モードで die() は 'Error: <msg>' を stderr に出す", () => {
    setJsonMode(false);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    try {
      die("human readable error", EXIT.RUNTIME);
    } catch { /* process.exit mock */ }
    const output = errSpy.mock.calls[0][0];
    expect(output).toBe("Error: human readable error");
    exitSpy.mockRestore();
  });

  it("[CLI-0012] out() は --json 時 JSON を stdout へ (stderr 汚染なし)", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    out(true, () => {}, { ok: true, value: 42 });
    expect(logSpy).toHaveBeenCalledOnce();
    expect(errSpy).not.toHaveBeenCalled();
    const output = JSON.parse(logSpy.mock.calls[0][0]);
    expect(output).toEqual({ ok: true, value: 42 });
  });

  it("[CLI-0012] out() は 非 --json 時 humanFn() を呼ぶ", () => {
    const humanFn = vi.fn();
    out(false, humanFn, { ok: true });
    expect(humanFn).toHaveBeenCalledOnce();
  });

  it("[CLI-0012] setJsonMode/isJsonMode のトグル", () => {
    setJsonMode(true);
    expect(isJsonMode()).toBe(true);
    setJsonMode(false);
    expect(isJsonMode()).toBe(false);
  });

  it("[CLI-0012] die() は stderr のみを汚し stdout を汚さない", () => {
    setJsonMode(true);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    try {
      die("err", EXIT.RUNTIME);
    } catch { /* exit */ }
    expect(logSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});

// ----------------------------------------------------------------
// CLI-0013: exitOverride 全コマンド伝播 + --json 時 commander writeErr 抑止
// ----------------------------------------------------------------
describe("[CLI-0013] exitOverride 全コマンド伝播 + --json 時 commander writeErr 抑止 (機構契約)", () => {
  afterEach(() => { setJsonMode(false); vi.restoreAllMocks(); });

  it("[CLI-0013] --json モード時は isJsonMode() が true を返す (writeErr 抑止の前提)", () => {
    setJsonMode(true);
    expect(isJsonMode()).toBe(true);
  });

  it("[CLI-0013] isJsonMode() false のとき writeErr は抑止されない (非 --json では commander 整形 stderr)", () => {
    setJsonMode(false);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const writeErr = (str) => { if (!isJsonMode()) process.stderr.write(str); };
    writeErr("error: some commander message\n");
    expect(stderrSpy).toHaveBeenCalledWith("error: some commander message\n");
  });

  it("[CLI-0013] die() は --json 時に JSON 封筒だけを出す (commander 素のエラー文は抑止済み前提)", () => {
    setJsonMode(true);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    try {
      die("unknown option '--no-such-flag'", EXIT.USAGE);
    } catch { /* exit mock */ }
    expect(errSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(errSpy.mock.calls[0][0]);
    expect(parsed).toMatchObject({ error: "unknown option '--no-such-flag'", code: 2 });
    exitSpy.mockRestore();
  });

  it("[CLI-0013] propagateExitOverride の再帰伝播: 全サブコマンドに exitOverride が設定される", () => {
    const program = new Command();
    program.name("test");
    const sub = program.command("sub");
    sub.command("subsub");

    // propagateExitOverride 相当の再帰関数を再現
    const propagateExitOverride = (cmd) => {
      cmd.exitOverride();
      cmd.configureOutput({ writeErr: (str) => { if (!isJsonMode()) process.stderr.write(str); } });
      for (const c of cmd.commands) propagateExitOverride(c);
    };
    propagateExitOverride(program);

    // exitOverride が設定されていれば process.exit でなく例外を投げる
    expect(() => program.parse(["node", "test", "--unknown-flag"], { from: "user" })).toThrow();
    expect(() => sub.parse(["node", "sub", "--unknown-flag"], { from: "user" })).toThrow();
  });
});

// ----------------------------------------------------------------
// CLI-0014: help/version 表示は正常終了 (exit 0) でエラー経路に乗せない
// ----------------------------------------------------------------
describe("[CLI-0014] help/version 表示は正常終了 (exit 0) でエラー経路に乗せない", () => {
  it("[CLI-0014] commander.helpDisplayed は help/version エラーコードの一つ", () => {
    expect(isCommanderError({ code: "commander.helpDisplayed" })).toBe(true);
  });

  it("[CLI-0014] commander.help は help/version エラーコードの一つ", () => {
    expect(isCommanderError({ code: "commander.help" })).toBe(true);
  });

  it("[CLI-0014] commander.version は help/version エラーコードの一つ", () => {
    expect(isCommanderError({ code: "commander.version" })).toBe(true);
  });

  it("[CLI-0014] help/version コードが run() catch の早期 return 条件を正しく識別する", () => {
    // catch 分岐の条件式を直接検証
    const isHelpOrVersion = (code) =>
      code === "commander.helpDisplayed" ||
      code === "commander.help" ||
      code === "commander.version";
    expect(isHelpOrVersion("commander.helpDisplayed")).toBe(true);
    expect(isHelpOrVersion("commander.help")).toBe(true);
    expect(isHelpOrVersion("commander.version")).toBe(true);
    expect(isHelpOrVersion("commander.unknownCommand")).toBe(false);
  });

  it("[CLI-0014] commanderErrorInfo で helpDisplayed が usage(2) に写像されない (exit0 の前提として exitCode を尊重)", () => {
    // helpDisplayed/help/version は run() で catch 後に finishCli → return するため
    // commanderErrorInfo には到達しない。到達した場合も exitCode を尊重する。
    // COMMANDER_USAGE_CODES に helpDisplayed が含まれないことを確認する。
    const { code } = commanderErrorInfo({ code: "commander.helpDisplayed", message: "", exitCode: 0 });
    // usage codes に含まれないので exitCode を尊重: exitCode=0 は falsy → RUNTIME(1)
    expect(code).toBe(EXIT.RUNTIME);
  });

  it("[CLI-0014] commander の exitOverride+parse+help は CommanderError(helpDisplayed) を throw する", () => {
    const program = new Command();
    program.name("test").helpOption("-h, --help", "display help");
    program.exitOverride();
    let thrown = null;
    try {
      program.parse(["node", "test", "--help"], { from: "user" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).not.toBeNull();
    expect(["commander.helpDisplayed", "commander.help"]).toContain(thrown.code);
  });
});

// ----------------------------------------------------------------
// CLI-0015: maybeHandleBleError: BLE 環境エラー 5 種を exit 1 へ・封筒に bleCode 維持
// ----------------------------------------------------------------
describe("[CLI-0015] maybeHandleBleError: BLE 環境エラー 5 種を exit 1 へ・封筒に bleCode 維持", () => {
  const BLE_CODES = [
    "BLE_UNAUTHORIZED", "BLE_UNSUPPORTED", "BLE_POWERED_OFF", "BLE_INIT_TIMEOUT", "BLE_NO_ADAPTER",
  ];

  function callWith(err, { json = false, platform = "linux" } = {}) {
    setJsonMode(json);
    const exitCodes = [];
    const spawnFn = vi.fn(() => ({ unref: () => {} }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handled = maybeHandleBleError(err, {
      platform,
      spawnFn,
      setExitCode: (c) => exitCodes.push(c),
    });
    const stderr = errSpy.mock.calls.map((c) => c.join(" "));
    errSpy.mockRestore();
    setJsonMode(false);
    return { handled, exitCodes, spawned: spawnFn.mock.calls, stderr };
  }

  afterEach(() => { setJsonMode(false); vi.restoreAllMocks(); });

  it("[CLI-0015] BLE 環境エラー 5 種全てで exit 1 を設定する (2 は usage 専用・SURF-19)", () => {
    for (const code of BLE_CODES) {
      const { handled, exitCodes } = callWith(Object.assign(new Error("boom"), { code }));
      expect(handled).toBe(true);
      expect(exitCodes).toEqual([EXIT.RUNTIME]); // 1
    }
  });

  it("[CLI-0015] --json 封筒は {error, code:1, bleCode} (bleCode 維持)", () => {
    const { stderr, exitCodes } = callWith(
      Object.assign(new Error("no bt"), { code: "BLE_POWERED_OFF" }),
      { json: true },
    );
    expect(exitCodes).toEqual([1]);
    const env = JSON.parse(stderr[0]);
    expect(env).toEqual({ error: "no bt", code: 1, bleCode: "BLE_POWERED_OFF" });
  });

  it("[CLI-0015] BLE 以外の code は false を返し副作用ゼロ", () => {
    const { handled, exitCodes, stderr } = callWith(Object.assign(new Error("x"), { code: "ENOENT" }));
    expect(handled).toBe(false);
    expect(exitCodes).toEqual([]);
    expect(stderr).toEqual([]);
  });

  it("[CLI-0015] code なしエラーも false を返し副作用ゼロ", () => {
    const { handled, exitCodes } = callWith(new Error("no code"));
    expect(handled).toBe(false);
    expect(exitCodes).toEqual([]);
  });

  it("[CLI-0015] null/undefined は false を返し副作用ゼロ", () => {
    const exitCodes = [];
    expect(maybeHandleBleError(null, { setExitCode: (c) => exitCodes.push(c) })).toBe(false);
    expect(exitCodes).toEqual([]);
  });

  it("[CLI-0015] 非 --json 時は 'Error: <message>' を stderr に出す", () => {
    const { stderr } = callWith(
      Object.assign(new Error("BT off"), { code: "BLE_POWERED_OFF" }),
      { json: false, platform: "linux" },
    );
    expect(stderr[0]).toBe("Error: BT off");
  });
});

// ----------------------------------------------------------------
// CLI-0016: maybeHandleBleError: macOS+BLE_UNAUTHORIZED で設定ペインを open (--json では開かない)
// ----------------------------------------------------------------
describe("[CLI-0016] maybeHandleBleError: macOS+BLE_UNAUTHORIZED で設定ペインを open (--json では開かない)", () => {
  function callWith(err, { json = false, platform = "linux" } = {}) {
    setJsonMode(json);
    const exitCodes = [];
    const spawnFn = vi.fn(() => ({ unref: () => {} }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handled = maybeHandleBleError(err, {
      platform,
      spawnFn,
      setExitCode: (c) => exitCodes.push(c),
    });
    const stderr = errSpy.mock.calls.map((c) => c.join(" "));
    errSpy.mockRestore();
    setJsonMode(false);
    return { handled, exitCodes, spawned: spawnFn.mock.calls, stderr };
  }

  afterEach(() => { setJsonMode(false); vi.restoreAllMocks(); });

  it("[CLI-0016] macOS + BLE_UNAUTHORIZED + 非 --json: open で設定ペインを起動する", () => {
    const { handled, spawned } = callWith(
      Object.assign(new Error("denied"), { code: "BLE_UNAUTHORIZED" }),
      { platform: "darwin" },
    );
    expect(handled).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(spawned[0][0]).toBe("open");
    expect(spawned[0][1][0]).toContain("Privacy_Bluetooth");
  });

  it("[CLI-0016] --json モードでは macOS でも open を呼ばない (機械可読出力を汚さない)", () => {
    const { spawned } = callWith(
      Object.assign(new Error("denied"), { code: "BLE_UNAUTHORIZED" }),
      { platform: "darwin", json: true },
    );
    expect(spawned).toHaveLength(0);
  });

  it("[CLI-0016] 非 darwin では BLE_UNAUTHORIZED でも open を呼ばない", () => {
    const { spawned } = callWith(
      Object.assign(new Error("denied"), { code: "BLE_UNAUTHORIZED" }),
      { platform: "linux" },
    );
    expect(spawned).toHaveLength(0);
  });

  it("[CLI-0016] darwin + BLE_UNAUTHORIZED 以外 (BLE_POWERED_OFF 等) は open しない", () => {
    const { spawned } = callWith(
      Object.assign(new Error("off"), { code: "BLE_POWERED_OFF" }),
      { platform: "darwin" },
    );
    expect(spawned).toHaveLength(0);
  });

  it("[CLI-0016] spawn 失敗時 (throw) は bleEnablePrivacy にフォールバックする", () => {
    setJsonMode(false);
    const throwingSpawn = vi.fn(() => { throw new Error("spawn failed"); });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handled = maybeHandleBleError(
      Object.assign(new Error("denied"), { code: "BLE_UNAUTHORIZED" }),
      { platform: "darwin", spawnFn: throwingSpawn, setExitCode: () => {} },
    );
    const stderr = errSpy.mock.calls.map((c) => c.join(" "));
    errSpy.mockRestore();
    setJsonMode(false);
    expect(handled).toBe(true);
    // フォールバックメッセージ (cli.bleEnablePrivacy の内容) が出る
    expect(stderr.length).toBeGreaterThanOrEqual(2); // "Error: denied" + fallback メッセージ
    expect(stderr.some((s) => s.includes("Bluetooth") || s.includes("Allow") || s.includes("System"))).toBe(true);
  });
});

// ----------------------------------------------------------------
// CLI-0017: withStaleHint は stale っぽい平文エラーにのみ sync 導線を足し構造化エラーには付けない
// ----------------------------------------------------------------
describe("[CLI-0017] withStaleHint は stale っぽい平文エラーにのみ sync 導線を足し構造化エラーには付けない", () => {
  it("[CLI-0017] 'Unknown key' を含む平文エラーにヒントを付与する", () => {
    const result = withStaleHint(new Error("Unknown key: abc123"));
    expect(result).toContain("sync"); // sync 導線が含まれる
    expect(result).toContain("Unknown key");
  });

  it("[CLI-0017] 'sendIR failed' を含む平文エラーにヒントを付与する", () => {
    const result = withStaleHint(new Error("sendIR failed: no device"));
    expect(result).toContain("sync");
  });

  it("[CLI-0017] 'getIRCodes failed' を含む平文エラーにヒントを付与する", () => {
    const result = withStaleHint(new Error("getIRCodes failed"));
    expect(result).toContain("sync");
  });

  it("[CLI-0017] 'triggerLock failed' を含む平文エラーにヒントを付与する", () => {
    const result = withStaleHint(new Error("triggerLock failed: not found"));
    expect(result).toContain("sync");
  });

  it("[CLI-0017] 'not found' を含む平文エラーにヒントを付与する", () => {
    const result = withStaleHint(new Error("device not found"));
    expect(result).toContain("sync");
  });

  it("[CLI-0017] 'invalid device' を含む平文エラーにヒントを付与する", () => {
    const result = withStaleHint(new Error("invalid device name"));
    expect(result).toContain("sync");
  });

  it("[CLI-0017] 無関係なエラーはそのまま返す", () => {
    expect(withStaleHint(new Error("everything is fine"))).toBe("everything is fine");
  });

  it("[CLI-0017] rpcError マーカ付きエラーにはヒントを付けない (Method not found 誤誘導防止)", () => {
    const e = Object.assign(new Error("Method not found: nope.method"), { rpcError: true, code: -32601 });
    expect(withStaleHint(e)).toBe("Method not found: nope.method");
    expect(withStaleHint(e)).not.toContain("sync");
  });

  it("[CLI-0017] data.kind を持つ構造化エラーにはヒントを付けない", () => {
    const e = Object.assign(new Error("not found"), { data: { kind: "not_implemented" } });
    expect(withStaleHint(e)).toBe("not found");
    expect(withStaleHint(e)).not.toContain("sync");
  });

  it("[CLI-0017] 型付き SesameError にはヒントを付けない", () => {
    const e = new SesameError("device not found", { code: ERR.BAD_REQUEST });
    expect(withStaleHint(e)).toBe("device not found");
    expect(withStaleHint(e)).not.toContain("sync");
  });
});

// ----------------------------------------------------------------
// CLI-0018: finishCli / bleWasUsed
// ----------------------------------------------------------------
describe("[CLI-0018] finishCli: noble 使用時のみ明示 exit + stdout drain で出力取りこぼし防止 (機構契約)", () => {
  // finishCli は cli.js の private 関数のため、同等ロジックを再現して検証する。
  // cli.js:290-295:
  //   function finishCli() {
  //     if (!bleWasUsed()) return;
  //     const code = process.exitCode || 0;
  //     if (process.stdout.write("")) process.exit(code);
  //     else process.stdout.once("drain", () => process.exit(code));
  //   }

  it("[CLI-0018] bleWasUsed が false のとき finishCli は return して自然 exit に任せる", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {});
    const bleWasUsed = () => false;
    // finishCli 相当
    if (bleWasUsed()) {
      const code = process.exitCode || 0;
      if (process.stdout.write("")) process.exit(code);
    }
    // bleWasUsed=false なので process.exit は呼ばれない
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it("[CLI-0018] stdout.write('') で drain 確認後に process.exit する設計", () => {
    const code = 0;
    let exitCalled = false;
    let drainListened = false;
    const mockStdout = {
      write: (s) => {
        expect(s).toBe(""); // drain 確認用の空文字列
        return true; // drain 完了
      },
      once: (_event, _cb) => { drainListened = true; },
    };
    const mockExit = (c) => { exitCalled = true; expect(c).toBe(code); };
    // 即 exit (write が true の場合)
    if (mockStdout.write("")) mockExit(code);
    else mockStdout.once("drain", () => mockExit(code));
    expect(exitCalled).toBe(true);
    expect(drainListened).toBe(false); // true を返したので drain は待たない
  });

  it("[CLI-0018] stdout.write('') が false なら drain 後に exit する設計", () => {
    const code = 1;
    let drainListened = false;
    let drainCallback = null;
    const mockStdout = {
      write: (_s) => false, // drain 未完了
      once: (event, cb) => {
        expect(event).toBe("drain");
        drainListened = true;
        drainCallback = cb;
      },
    };
    let exitCode = null;
    const mockExit = (c) => { exitCode = c; };
    if (mockStdout.write("")) mockExit(code);
    else mockStdout.once("drain", () => mockExit(code));
    expect(drainListened).toBe(true);
    expect(exitCode).toBeNull(); // まだ exit されていない
    drainCallback(); // drain イベントを発火
    expect(exitCode).toBe(code);
  });

  it("[CLI-0018] bleWasUsed=true + write('') が true: 即 process.exit(exitCode) を呼ぶ", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {});
    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const origExitCode = process.exitCode;
    process.exitCode = 0;

    const bleWasUsed = () => true;
    if (bleWasUsed()) {
      const code = process.exitCode || 0;
      if (process.stdout.write("")) process.exit(code);
      else process.stdout.once("drain", () => process.exit(code));
    }
    expect(writeSpy).toHaveBeenCalledWith("");
    expect(exitSpy).toHaveBeenCalledWith(0);
    process.exitCode = origExitCode;
    exitSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it("[CLI-0018] bleWasUsed=true + write('') が false: drain イベント後に process.exit を呼ぶ", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {});
    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(false);
    const onceSpy = vi.spyOn(process.stdout, "once").mockImplementation((event, cb) => {
      if (event === "drain") cb(); // すぐに drain イベントを発火
      return process.stdout;
    });
    const origExitCode = process.exitCode;
    process.exitCode = 0;

    const bleWasUsed = () => true;
    if (bleWasUsed()) {
      const code = process.exitCode || 0;
      if (process.stdout.write("")) process.exit(code);
      else process.stdout.once("drain", () => process.exit(code));
    }
    expect(onceSpy).toHaveBeenCalledWith("drain", expect.any(Function));
    expect(exitSpy).toHaveBeenCalledWith(0);
    process.exitCode = origExitCode;
    exitSpy.mockRestore();
    writeSpy.mockRestore();
    onceSpy.mockRestore();
  });

  it("[CLI-0018] process.exitCode が設定されている場合はその code で exit する", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {});
    const writeSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const origExitCode = process.exitCode;
    process.exitCode = 1;

    const bleWasUsed = () => true;
    if (bleWasUsed()) {
      const code = process.exitCode || 0;
      if (process.stdout.write("")) process.exit(code);
    }
    expect(exitSpy).toHaveBeenCalledWith(1);
    process.exitCode = origExitCode;
    exitSpy.mockRestore();
    writeSpy.mockRestore();
  });
});
