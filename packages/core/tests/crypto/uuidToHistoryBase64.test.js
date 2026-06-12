// Unit tests for uuidToHistoryBase64()
//
// 仕様まとめ (src/crypto.js を読んだもの):
//   - 入力 uuid は 32hex (with/without ハイフン) の文字列
//   - prefix は hex 文字列 (デフォルト '000c'), 2B 想定だが実装上は hex として連結
//   - 出力は (prefix bytes + uuid 16B) を base64 化したもの
//   - デフォルト prefix '000c' (2B) のとき: 18B → base64 24 文字
//   - 入力が string でない / hex 文字数が 32 でないと throw
//
// biz3 utils.uuidBuffer() ポーティングの境界条件を網羅する。

import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import { uuidToHistoryBase64 } from "../../src/crypto.js";

// 既知のテスト用 UUID (RFC 4122 example の 1 つ)
const UUID_HYPHEN = "123e4567-e89b-12d3-a456-426614174000";
const UUID_NO_HYPHEN = "123e4567e89b12d3a456426614174000";
const UUID_BYTES_HEX = "123e4567e89b12d3a456426614174000"; // 16B

describe("uuidToHistoryBase64 - 正常系", () => {
  it("ハイフン付き UUID で 24 文字の base64 を返す (デフォルト prefix)", () => {
    const result = uuidToHistoryBase64(UUID_HYPHEN);
    expect(typeof result).toBe("string");
    expect(result).toHaveLength(24); // 18B → base64 24 chars
  });

  it("ハイフン無し 32hex でも同じ結果を返す (ハイフン除去のべき等性)", () => {
    const withHyphen = uuidToHistoryBase64(UUID_HYPHEN);
    const withoutHyphen = uuidToHistoryBase64(UUID_NO_HYPHEN);
    expect(withHyphen).toBe(withoutHyphen);
  });

  it("デフォルト prefix は '000c' が先頭 2B として埋め込まれる", () => {
    const result = uuidToHistoryBase64(UUID_HYPHEN);
    const decoded = Buffer.from(result, "base64");
    expect(decoded).toHaveLength(18);
    expect(decoded[0]).toBe(0x00);
    expect(decoded[1]).toBe(0x0c);
  });

  it("decode した残り 16B が UUID bytes と一致する", () => {
    const result = uuidToHistoryBase64(UUID_HYPHEN);
    const decoded = Buffer.from(result, "base64");
    const uuidPart = decoded.subarray(2); // 先頭 2B prefix を除いた残り
    expect(uuidPart).toHaveLength(16);
    expect(uuidPart.toString("hex")).toBe(UUID_BYTES_HEX);
  });

  it("カスタム prefix '0001' を指定すると先頭 2B が 0x00 0x01 になる", () => {
    const result = uuidToHistoryBase64(UUID_HYPHEN, "0001");
    const decoded = Buffer.from(result, "base64");
    expect(decoded[0]).toBe(0x00);
    expect(decoded[1]).toBe(0x01);
    expect(decoded.subarray(2).toString("hex")).toBe(UUID_BYTES_HEX);
  });

  it("カスタム prefix 'ffff' を指定すると先頭 2B が 0xff 0xff になる", () => {
    const result = uuidToHistoryBase64(UUID_HYPHEN, "ffff");
    const decoded = Buffer.from(result, "base64");
    expect(decoded[0]).toBe(0xff);
    expect(decoded[1]).toBe(0xff);
  });

  it("prefix を空文字にすると 16B (= base64 24 文字, padding 込み) になる", () => {
    const result = uuidToHistoryBase64(UUID_HYPHEN, "");
    const decoded = Buffer.from(result, "base64");
    expect(decoded).toHaveLength(16);
    expect(decoded.toString("hex")).toBe(UUID_BYTES_HEX);
  });

  it("大文字 UUID も小文字 UUID も同じ結果になる (hex の大小無視)", () => {
    const upper = uuidToHistoryBase64(UUID_HYPHEN.toUpperCase());
    const lower = uuidToHistoryBase64(UUID_HYPHEN.toLowerCase());
    expect(upper).toBe(lower);
  });

  it("オール 0 の UUID は prefix + 16 個の 0x00 になる", () => {
    const result = uuidToHistoryBase64("00000000-0000-0000-0000-000000000000");
    const decoded = Buffer.from(result, "base64");
    expect(decoded).toHaveLength(18);
    expect(decoded.subarray(2).equals(Buffer.alloc(16, 0))).toBe(true);
  });

  it("オール F の UUID は prefix + 16 個の 0xff になる", () => {
    const result = uuidToHistoryBase64("ffffffff-ffff-ffff-ffff-ffffffffffff");
    const decoded = Buffer.from(result, "base64");
    expect(decoded).toHaveLength(18);
    expect(decoded.subarray(2).equals(Buffer.alloc(16, 0xff))).toBe(true);
  });

  it("同じ入力に対して deterministic (純粋関数として) である", () => {
    const a = uuidToHistoryBase64(UUID_HYPHEN);
    const b = uuidToHistoryBase64(UUID_HYPHEN);
    const c = uuidToHistoryBase64(UUID_HYPHEN);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("出力 base64 は decode→encode で round-trip 一致する", () => {
    const out = uuidToHistoryBase64(UUID_HYPHEN);
    const round = Buffer.from(out, "base64").toString("base64");
    expect(round).toBe(out);
  });
});

describe("uuidToHistoryBase64 - エラー系", () => {
  it("uuid が undefined だと throw する", () => {
    expect(() => uuidToHistoryBase64(undefined)).toThrow(/uuid required \(string\)/);
  });

  it("uuid が null だと throw する", () => {
    expect(() => uuidToHistoryBase64(null)).toThrow(/uuid required \(string\)/);
  });

  it("uuid が数値だと throw する", () => {
    expect(() => uuidToHistoryBase64(123456)).toThrow(/uuid required \(string\)/);
  });

  it("uuid が object だと throw する", () => {
    expect(() => uuidToHistoryBase64({ uuid: UUID_HYPHEN })).toThrow(/uuid required \(string\)/);
  });

  it("uuid が配列だと throw する", () => {
    expect(() => uuidToHistoryBase64([UUID_HYPHEN])).toThrow(/uuid required \(string\)/);
  });

  it("uuid が空文字だと長さ不正で throw する", () => {
    expect(() => uuidToHistoryBase64("")).toThrow(/uuid must be 32 hex chars/);
  });

  it("uuid が短すぎる (31 hex) と throw する", () => {
    const shortUuid = "0".repeat(31);
    expect(() => uuidToHistoryBase64(shortUuid)).toThrow(/got len=31/);
  });

  it("uuid が長すぎる (33 hex) と throw する", () => {
    const longUuid = "0".repeat(33);
    expect(() => uuidToHistoryBase64(longUuid)).toThrow(/got len=33/);
  });

  it("ハイフン除去後に 32 文字未満なら throw する", () => {
    // '12-34' → 4 文字
    expect(() => uuidToHistoryBase64("12-34")).toThrow(/got len=4/);
  });

  it("エラーメッセージにハイフン除去後の長さが含まれる", () => {
    // 32 個のハイフンだけ → 除去後 0 文字
    expect(() => uuidToHistoryBase64("-".repeat(32))).toThrow(/got len=0/);
  });
});

describe("uuidToHistoryBase64 - hex として不正な文字を含むケース", () => {
  // Buffer.from(hex, 'hex') は非 hex 文字に出会うとそこで打ち切る挙動。
  // 関数自体は length チェックのみなので「validation の境界」を明示的に固定化しておく。
  it("32 文字 hex だが一部に非 hex 文字 (z) が含まれていても length チェックは通る (= 関数は throw しない)", () => {
    // 仕様: 現状の実装は hex 妥当性まではチェックしない。Buffer.from の打ち切り挙動が反映される。
    // この振る舞いを固定化するための回帰テスト。
    const bogus = "z".repeat(32);
    // throw しないことを確認 (現状の実装)
    expect(() => uuidToHistoryBase64(bogus)).not.toThrow();
    const result = uuidToHistoryBase64(bogus);
    // 非 hex なので uuid 部分は decode で 0B になり、出力は prefix のみ (2B → base64 4 文字)
    const decoded = Buffer.from(result, "base64");
    expect(decoded[0]).toBe(0x00);
    expect(decoded[1]).toBe(0x0c);
  });
});
