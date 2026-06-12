// Unit tests for normalizeUuid() and hexToUuid() (P5-4 UUID 正規化統合)
//
// 仕様:
//   normalizeUuid(s)
//     - ハイフン除去 + 小文字化 (空安全: 非文字列は "" を返す)
//     - 比較・照合用途での大小・ハイフン有無の吸収に使う
//
//   hexToUuid(hex)
//     - 32桁 hex → "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" (小文字)
//     - 32hex 以外 (非16B) は hexToBuf 経由で明示 throw
//
// 旧: transport.js:nobleUuid / client.js:normalizeUuid / lock.js:normalizeUuid 等 14 箇所が
//     同義実装を持っていた。本テストは統合後の単一実装を固定する。

import { describe, it, expect } from "vitest";
import { normalizeUuid, hexToUuid } from "../../src/crypto.js";

const HYPHEN_UPPER  = "123E4567-E89B-12D3-A456-426614174000";
const HYPHEN_LOWER  = "123e4567-e89b-12d3-a456-426614174000";
const NO_HYPHEN     = "123e4567e89b12d3a456426614174000";
const NO_HYPHEN_UP  = "123E4567E89B12D3A456426614174000";

describe("normalizeUuid - 正常系", () => {
  it("ハイフン付き大文字 UUID を 32 文字小文字 hex に変換する", () => {
    expect(normalizeUuid(HYPHEN_UPPER)).toBe(NO_HYPHEN);
  });

  it("ハイフン付き小文字 UUID を 32 文字小文字 hex に変換する", () => {
    expect(normalizeUuid(HYPHEN_LOWER)).toBe(NO_HYPHEN);
  });

  it("ハイフン無し大文字 hex を小文字に変換する", () => {
    expect(normalizeUuid(NO_HYPHEN_UP)).toBe(NO_HYPHEN);
  });

  it("ハイフン無し小文字 hex はそのまま返す (べき等)", () => {
    expect(normalizeUuid(NO_HYPHEN)).toBe(NO_HYPHEN);
  });

  it("大文字と小文字・ハイフン有無の比較が一致する (照合用途)", () => {
    expect(normalizeUuid(HYPHEN_UPPER)).toBe(normalizeUuid(HYPHEN_LOWER));
    expect(normalizeUuid(HYPHEN_UPPER)).toBe(normalizeUuid(NO_HYPHEN));
    expect(normalizeUuid(NO_HYPHEN_UP)).toBe(normalizeUuid(NO_HYPHEN));
  });

  it("空文字を渡すと空文字を返す", () => {
    expect(normalizeUuid("")).toBe("");
  });
});

describe("normalizeUuid - 空安全", () => {
  it("null を渡すと空文字を返す", () => {
    // @ts-expect-error: 型エラーを意図的に抑制 (非文字列 null の挙動)
    expect(normalizeUuid(null)).toBe("");
  });

  it("undefined を渡すと空文字を返す", () => {
    // @ts-expect-error: 型エラーを意図的に抑制 (非文字列 undefined の挙動)
    expect(normalizeUuid(undefined)).toBe("");
  });

  it("数値を渡すと空文字を返す", () => {
    // @ts-expect-error
    expect(normalizeUuid(42)).toBe("");
  });
});

describe("hexToUuid - 正常系", () => {
  it("32桁 hex を正しいダッシュ付き UUID 形式に整形する", () => {
    expect(hexToUuid(NO_HYPHEN)).toBe(HYPHEN_LOWER);
  });

  it("整形後は必ず小文字になる", () => {
    // Buffer.toString("hex") は常に小文字なので、通常の使用ケースは小文字入力のみ
    expect(hexToUuid(NO_HYPHEN)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("形式 8-4-4-4-12 (UUID RFC 4122 レイアウト) である", () => {
    const result = hexToUuid("a0b1c2d3e4f500112233445566778899");
    expect(result).toBe("a0b1c2d3-e4f5-0011-2233-445566778899");
  });

  it("全ゼロ hex を変換できる", () => {
    expect(hexToUuid("0".repeat(32))).toBe("00000000-0000-0000-0000-000000000000");
  });

  it("全 f hex を変換できる", () => {
    expect(hexToUuid("f".repeat(32))).toBe("ffffffff-ffff-ffff-ffff-ffffffffffff");
  });

  it("normalizeUuid(hexToUuid(x)) は normalizeUuid(x) と等しい (往復べき等)", () => {
    expect(normalizeUuid(hexToUuid(NO_HYPHEN))).toBe(normalizeUuid(NO_HYPHEN));
  });
});

describe("hexToUuid - 異常系", () => {
  it("31桁 hex (7.5B) は throw する", () => {
    expect(() => hexToUuid("a".repeat(31))).toThrow();
  });

  it("33桁 hex (16.5B) は throw する (偶数長チェック前に非 32hex でも落ちる)", () => {
    expect(() => hexToUuid("a".repeat(33))).toThrow();
  });

  it("空文字は throw する (0B ≠ 16B)", () => {
    expect(() => hexToUuid("")).toThrow();
  });

  it("非 hex 文字を含む 32 文字列は throw する", () => {
    expect(() => hexToUuid("g".repeat(32))).toThrow();
  });
});
