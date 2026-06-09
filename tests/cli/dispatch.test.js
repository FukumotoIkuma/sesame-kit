// cli/dispatch.js: デバイス主語ルーティングの純ロジックを検証する。
import { describe, it, expect } from "vitest";
import { extractPositionals, reservedCommandNames, routeDeviceArgv } from "../../src/cli/dispatch.js";

// commander の Command を模した最小フェイク (dispatch が触る面だけ)。
const fakeProgram = {
  options: [
    { long: "--config-dir", short: null, required: true, optional: false },
    { long: "--json", short: null, required: false, optional: false },
    { long: "--lang", short: null, required: true, optional: false },
    { long: "--debug", short: null, required: false, optional: false },
  ],
  commands: [
    { name: () => "init", aliases: () => [] },
    { name: () => "op", aliases: () => [] },
    { name: () => "session", aliases: () => ["watch"] },
  ],
};

const A = (...rest) => ["node", "sesame", ...rest];

describe("extractPositionals", () => {
  it("値オプションの値をデバイス名と誤認しない", () => {
    expect(extractPositionals(["--config-dir", "/x", "init"], fakeProgram)).toEqual(["init"]);
  });
  it("--opt=value 形式は後続を消費しない", () => {
    expect(extractPositionals(["--config-dir=/x", "front", "unlock"], fakeProgram)).toEqual(["front", "unlock"]);
  });
  it("ブール値オプションは次トークンを消費しない", () => {
    expect(extractPositionals(["--json", "front"], fakeProgram)).toEqual(["front"]);
  });
  it("-- 以降は全部位置引数", () => {
    expect(extractPositionals(["--", "--weird", "x"], fakeProgram)).toEqual(["--weird", "x"]);
  });
});

describe("reservedCommandNames", () => {
  it("コマンド名 + エイリアス + help を含む", () => {
    const r = reservedCommandNames(fakeProgram);
    expect(r.has("init")).toBe(true);
    expect(r.has("watch")).toBe(true); // session の alias
    expect(r.has("help")).toBe(true);
  });
});

describe("routeDeviceArgv", () => {
  const base = { program: fakeProgram, deviceActions: new Set(["unlock", "lock", "status"]) };

  it("既知の管理コマンドは書き換えない (値オプションが先でも)", () => {
    const argv = A("--config-dir", "/x", "init");
    expect(routeDeviceArgv({ ...base, argv, isKnownDevice: () => false, interactive: true })).toBe(argv);
  });

  it("device action 同伴は op へ書き換える", () => {
    const argv = A("front", "unlock");
    expect(routeDeviceArgv({ ...base, argv, isKnownDevice: () => false, interactive: false }))
      .toEqual(["node", "sesame", "op", "front", "unlock"]);
  });

  it("既知デバイス (action 無し) も op へ", () => {
    const argv = A("front");
    expect(routeDeviceArgv({ ...base, argv, isKnownDevice: () => true, interactive: false }))
      .toEqual(["node", "sesame", "op", "front"]);
  });

  it("未知トークン (デバイスでも action でもない) は据え置き → commander が未知コマンド", () => {
    const argv = A("no_such_command");
    expect(routeDeviceArgv({ ...base, argv, isKnownDevice: () => false, interactive: false })).toBe(argv);
  });

  it("引数なし + 対話 (非 --json) は session へ", () => {
    expect(routeDeviceArgv({ ...base, argv: A(), isKnownDevice: () => false, interactive: true }))
      .toEqual(["node", "sesame", "session"]);
  });

  it("引数なし + --json は据え置き (help を出させる)", () => {
    const argv = A("--json");
    expect(routeDeviceArgv({ ...base, argv, isKnownDevice: () => false, interactive: true })).toBe(argv);
  });

  it("-h/--help は常に据え置き", () => {
    const argv = A("front", "--help");
    expect(routeDeviceArgv({ ...base, argv, isKnownDevice: () => true, interactive: true })).toBe(argv);
  });
});
