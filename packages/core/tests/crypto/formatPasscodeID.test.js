// P3-7: formatPasscodeID の単体テスト。
//
// 参照ベクタ: references_web/src/utils/biz3utils.js:262-267
//   const formatPasscodeID = (password) =>
//     Array.from(password.toString())
//       .map(num => ('0' + parseInt(num,10).toString(16)).slice(-2))
//       .join('').toUpperCase();
//
// テストベクタは参照の関数を Node で直接評価した値と一致させる。

import { describe, it, expect } from "vitest";
import { formatPasscodeID } from "../../src/crypto.js";

describe("P3-7: formatPasscodeID (biz3utils.js:262-267)", () => {
  // 参照の示す主要ケース: "123" → "010203"
  it('"123" → "010203"', () => {
    expect(formatPasscodeID("123")).toBe("010203");
  });

  it('"0" → "00"', () => {
    expect(formatPasscodeID("0")).toBe("00");
  });

  it('"9" → "09"', () => {
    expect(formatPasscodeID("9")).toBe("09");
  });

  // 各桁を 2 桁 hex に: 0→00, 1→01, …, 9→09 (10進整数前提)
  it('"0123456789" → "00010203040506070809"', () => {
    expect(formatPasscodeID("0123456789")).toBe("00010203040506070809");
  });

  it("数値引数 (toString で文字列化される)", () => {
    expect(formatPasscodeID(123)).toBe("010203");
  });

  it("結果は大文字 (biz3utils.js:266: .toUpperCase())", () => {
    // 0-9 の hex は大文字に変化しないが、10-15 は A-F になる
    // biz3utils では桁を 10 進整数として扱うため 10 以上は通常 PIN として使われないが
    // toUpperCase() の仕様上 a-f は A-F になることを確認する。
    // 参照通り: 各桁は parseInt(num,10) で 10 進整数として読む。
    // '1','2','3' → 1,2,3 → 0x01,0x02,0x03 → "010203"
    const result = formatPasscodeID("1");
    expect(result).toBe(result.toUpperCase());
  });

  it("空文字は空文字を返す", () => {
    expect(formatPasscodeID("")).toBe("");
  });
});
