// parseIrType / IR_TYPE の単体テスト。
import { describe, it, expect } from "vitest";
import { parseIrType, IR_TYPE } from "../../src/crypto.js";

describe("IR_TYPE", () => {
  it("biz3 で確認した実 wire 値を持つ", () => {
    // プリセット: ir-type-list/index.js (メニュー値=実type)
    expect(IR_TYPE.ac).toBe(0xc000);    // 49152
    expect(IR_TYPE.tv).toBe(0x2000);    //  8192
    expect(IR_TYPE.light).toBe(0xe000); // 57344
    expect(IR_TYPE.fan).toBe(0x8000);   // 32768
    // 自己学習: 実 remote.type は 0xFE00 (learn/index.js:142, useRemoteCtrl.js:228)。
    // ir-type-list の learn メニュー値 0xFEFF は UI 識別子であって実 type ではない。
    expect(IR_TYPE.learn).toBe(0xfe00); // 65024
  });
  it("freeze されている", () => {
    expect(Object.isFrozen(IR_TYPE)).toBe(true);
  });
});

describe("parseIrType", () => {
  it("数値はそのまま返す", () => {
    expect(parseIrType(49152)).toBe(49152);
    expect(parseIrType(12345)).toBe(12345);
  });

  it("エイリアス文字列を数値に解決 (大小無視・trim)", () => {
    expect(parseIrType("ac")).toBe(0xc000);
    expect(parseIrType("AC")).toBe(0xc000);
    expect(parseIrType("  tv  ")).toBe(0x2000);
    expect(parseIrType("learn")).toBe(0xfe00);
  });

  it("数値文字列をパース", () => {
    expect(parseIrType("49152")).toBe(49152);
    expect(parseIrType("100")).toBe(100);
  });

  it("未知のエイリアスはエラー (候補を含む)", () => {
    expect(() => parseIrType("fridge")).toThrow(/Unknown irType "fridge"/);
    expect(() => parseIrType("fridge")).toThrow(/ac, tv/);
  });

  it("string/number 以外はエラー", () => {
    expect(() => parseIrType(null)).toThrow(/must be a string or number/);
    expect(() => parseIrType({})).toThrow(/must be a string or number/);
  });
});
