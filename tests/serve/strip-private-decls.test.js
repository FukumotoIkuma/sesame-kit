// scripts/strip-private-decls.mjs の単体テスト (REFACTORING_PLAN P1-16)。
// fixture の d.ts 文字列に stripPrivateMembers を直接適用して検査する。
// 「types/ 配下に `_` 始まり公開メンバが残っていない」検査は生成物が古い間は失敗するため
// ここでは行わない (統括が `npm run build` 後に確認する)。
import { describe, it, expect, vi, afterEach } from "vitest";
import { stripPrivateMembers } from "../../scripts/strip-private-decls.mjs";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stripPrivateMembers: private メンバの除去", () => {
  it("プロパティ形式 `_x:` を除去する (旧来から対象)", () => {
    const input = [
      "export class Foo {",
      "    _secret: string;",
      "    name: string;",
      "}",
      "",
    ].join("\n");
    const out = stripPrivateMembers(input);
    expect(out).not.toContain("_secret");
    expect(out).toContain("    name: string;");
  });

  it("メソッド形式 `_x(...)` を除去する (旧 regex の取りこぼし — P1-16 本体)", () => {
    const input = [
      "export class Hub3WsClient {",
      "    _ensureConnected(): Hub3WsClient;",
      "    _bindNs(mod: Record<string, unknown>): Record<string, (params?: Record<string, unknown>) => unknown>;",
      "    connect(): Promise<void>;",
      "}",
      "",
    ].join("\n");
    const out = stripPrivateMembers(input);
    expect(out).not.toContain("_ensureConnected");
    expect(out).not.toContain("_bindNs");
    expect(out).toContain("    connect(): Promise<void>;");
  });

  it("optional (`_x?:` / `_x?(`) と `private` 修飾子付きも除去する", () => {
    const input = [
      "export class Foo {",
      "    _maybe?: number;",
      "    _maybeFn?(a: string): void;",
      "    private _hidden: boolean;",
      "    visible?: number;",
      "}",
      "",
    ].join("\n");
    const out = stripPrivateMembers(input);
    expect(out).not.toContain("_maybe");
    expect(out).not.toContain("_maybeFn");
    expect(out).not.toContain("_hidden");
    expect(out).toContain("    visible?: number;");
  });

  it("複数行にわたる型 (brace を含む) のメンバを終端 `;` まで丸ごと除去する", () => {
    const input = [
      "export class Foo {",
      "    _state: {",
      "        a: string;",
      "        b: number;",
      "    };",
      "    after: string;",
      "}",
      "",
    ].join("\n");
    const out = stripPrivateMembers(input);
    expect(out).not.toContain("_state");
    expect(out).not.toContain("a: string;");
    expect(out).toContain("    after: string;");
  });

  it("直前の複数行 JSDoc ブロックもメンバと一体で除去する", () => {
    const input = [
      "export class Foo {",
      "    /**",
      "     * 内部用。接続を保証する。",
      "     * @returns {Foo}",
      "     */",
      "    _ensureConnected(): Foo;",
      "    /** 公開メソッド */",
      "    connect(): Promise<void>;",
      "}",
      "",
    ].join("\n");
    const out = stripPrivateMembers(input);
    expect(out).not.toContain("_ensureConnected");
    expect(out).not.toContain("内部用。接続を保証する。");
    expect(out).toContain("/** 公開メソッド */");
    expect(out).toContain("    connect(): Promise<void>;");
  });

  it("直前の 1 行 JSDoc も除去し、無関係な直前コードは温存する", () => {
    const input = [
      "export class Foo {",
      "    keep: string;",
      "    /** 内部プロパティ */",
      "    _internal: string;",
      "}",
      "",
    ].join("\n");
    const out = stripPrivateMembers(input);
    expect(out).not.toContain("_internal");
    expect(out).not.toContain("内部プロパティ");
    expect(out).toContain("    keep: string;");
  });
});

describe("stripPrivateMembers: 非 private の温存", () => {
  it("`_` 始まりでないメンバ・トップレベル宣言は変更しない", () => {
    const input = [
      "/** モジュール JSDoc */",
      "export class Foo {",
      "    /** 公開 */",
      "    name: string;",
      "    method(arg: string): void;",
      "}",
      "export function _topLevel(): void;",
      "",
    ].join("\n");
    // インデント 4 のクラスメンバだけが対象。トップレベルの `_` 名は対象外 (export 判断は tsc 側)。
    expect(stripPrivateMembers(input)).toBe(input);
  });

  it("ネストの深い (インデント 8) `_` メンバは対象外のまま温存する", () => {
    const input = [
      "export class Foo {",
      "    config: {",
      "        _raw: string;",
      "    };",
      "}",
      "",
    ].join("\n");
    expect(stripPrivateMembers(input)).toBe(input);
  });
});

describe("stripPrivateMembers: 不正入力 (閉じない private メンバ)", () => {
  it("終端 `;` が無い場合は残部を欠落させず温存して console.warn する (旧実装は黙って欠落)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const input = [
      "export class Foo {",
      "    _broken: {",
      "        a: string", // `;` が無く brace も閉じない
      "    rest: string;",
      "}",
      "",
    ].join("\n");
    const out = stripPrivateMembers(input, "fixture.d.ts");
    // 残部 (rest/閉じ brace) が出力に残る。
    expect(out).toContain("    rest: string;");
    expect(out).toContain("_broken");
    expect(out).toBe(input); // メンバ開始行以降を丸ごと温存
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("fixture.d.ts");
    expect(warn.mock.calls[0][0]).toContain("unterminated");
  });

  it("正常入力では console.warn しない", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stripPrivateMembers("export class Foo {\n    _x: string;\n}\n");
    expect(warn).not.toHaveBeenCalled();
  });
});
