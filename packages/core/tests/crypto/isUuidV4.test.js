// P3-9: isUuidV4 の単体テスト。
//
// 参照ベクタ: references_web/src/utils/biz3utils.js:435-453
//   const isUUIDV4 = (tag) => {
//     if (!tag) return false;
//     let tagBuffer = tag;
//     if (typeof tagBuffer === 'string') tagBuffer = Buffer.from(tag.replace(/-/g,''),'hex');
//     if (tagBuffer.length !== 16) return false;
//     const version = tagBuffer[6] & 0xf0;
//     const variant = tagBuffer[8] & 0xc0;
//     return version === 0x40 && variant === 0x80;
//   };
//
// UUID v4 のバイト構造:
//   byte[6] & 0xf0 === 0x40  (version bits: 0100xxxx)
//   byte[8] & 0xc0 === 0x80  (variant bits: 10xxxxxx)

import { describe, it, expect } from "vitest";
import { isUuidV4 } from "../../src/crypto.js";
import { Buffer } from "node:buffer";

// 既知の UUID v4 (ランダム): byte[6]=0x4X, byte[8]=0x[89ab]X を手動確認。
// "550e8400-e29b-41d4-a716-446655440000"
//   バイト列 (hex): 550e8400e29b41d4a716446655440000
//   byte[6] = 0x41 → & 0xf0 = 0x40 ✓
//   byte[8] = 0xa7 → & 0xc0 = 0x80 ✓
const UUID_V4_STR = "550e8400-e29b-41d4-a716-446655440000";
const UUID_V4_HEX = "550e8400e29b41d4a716446655440000";

// UUID v1 風 (version = 0x10): byte[6] = 0x10 → & 0xf0 = 0x10 ≠ 0x40
// "550e8400-e29b-11d4-a716-446655440000"
//   byte[6] = 0x11 → & 0xf0 = 0x10 ✗
const UUID_V1_STR = "550e8400-e29b-11d4-a716-446655440000";

// ゼロ埋め (version = 0x00)
const UUID_ZERO_STR = "00000000-0000-0000-0000-000000000000";

describe("P3-9: isUuidV4 (biz3utils.js:435-453)", () => {
  it("有効な UUID v4 文字列(ハイフン付き) → true", () => {
    expect(isUuidV4(UUID_V4_STR)).toBe(true);
  });

  it("有効な UUID v4 (32hex ノーハイフン) → true", () => {
    expect(isUuidV4(UUID_V4_HEX)).toBe(true);
  });

  it("有効な UUID v4 (Buffer) → true", () => {
    const buf = Buffer.from(UUID_V4_HEX, "hex");
    expect(isUuidV4(buf)).toBe(true);
  });

  it("UUID v1 → false (version bits ≠ 0x40)", () => {
    expect(isUuidV4(UUID_V1_STR)).toBe(false);
  });

  it("全ゼロ UUID → false (version = 0x00)", () => {
    expect(isUuidV4(UUID_ZERO_STR)).toBe(false);
  });

  it("falsy (null) → false (biz3utils.js:436)", () => {
    expect(isUuidV4(null)).toBe(false);
  });

  it("falsy (undefined) → false", () => {
    expect(isUuidV4(undefined)).toBe(false);
  });

  it("falsy ('') → false", () => {
    expect(isUuidV4("")).toBe(false);
  });

  it("16B でない Buffer → false (biz3utils.js:443)", () => {
    expect(isUuidV4(Buffer.from("deadbeef", "hex"))).toBe(false); // 4B
  });

  it("長さ 15 の hex 文字列 (デコード後 7B) → false", () => {
    // 奇数長なので Buffer.from の hex デコードは偶数にパディングされて 7B になる
    // (長さ 16 で無いため false)
    const shortHex = "550e8400e29b41"; // 14hex = 7B
    expect(isUuidV4(shortHex)).toBe(false);
  });

  // variant チェック: byte[8] & 0xc0 !== 0x80 → false
  // "550e8400-e29b-41d4-7716-446655440000"
  //   byte[8] = 0x77 → & 0xc0 = 0x40 ≠ 0x80 → false
  it("variant bit が 0x80 でない → false", () => {
    const noVariant = "550e8400e29b41d47716446655440000";
    expect(isUuidV4(noVariant)).toBe(false);
  });
});
