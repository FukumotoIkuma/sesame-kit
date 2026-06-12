// Unit tests for canAddMoreRemote in src/ir.js (P3-2)。
//
// 出典: references_web/src/api/useRemoteCtrl.js:226-255 (canAddMoreRemote)
//   - type 0xfe00 (自己学習) は無制限
//   - stateInfo.remoteList 内で {0x8000, 0x2000, 0xe000, 0xc000} をカウント
//   - counts >= 3 なら false

import { describe, it, expect } from "vitest";
import { canAddMoreRemote } from "../../src/ir.js";

/**
 * remoteList のヘルパ — type 値だけを持つ最小オブジェクト配列を作る。
 * @param {...number} types
 */
function makeList(...types) {
  return types.map((type) => ({ type }));
}

describe("canAddMoreRemote (P3-2)", () => {
  // ── 自己学習リモコンは無制限 ──────────────────────────────────────────────
  it("type=0xfe00 (自己学習) は既存件数に関わらず true を返す", () => {
    // references_web/src/api/useRemoteCtrl.js:228-231
    const alreadyFull = makeList(0x8000, 0x2000, 0xe000); // 3 個 = 上限到達
    expect(canAddMoreRemote(0xfe00, alreadyFull)).toBe(true);
  });

  it("type=0xfe00 は空リストでも true", () => {
    expect(canAddMoreRemote(0xfe00, [])).toBe(true);
  });

  // ── プリセット上限チェック ──────────────────────────────────────────────
  it("プリセット 0 個のとき true (追加可)", () => {
    expect(canAddMoreRemote(0x8000, [])).toBe(true);
  });

  it("プリセット 1 個のとき true", () => {
    expect(canAddMoreRemote(0x2000, makeList(0x8000))).toBe(true);
  });

  it("プリセット 2 個のとき true", () => {
    expect(canAddMoreRemote(0xc000, makeList(0x8000, 0x2000))).toBe(true);
  });

  it("プリセット 3 個 (上限到達) のとき false (拒否)", () => {
    // references_web/src/api/useRemoteCtrl.js:244-252: counts >= 3 → false
    const list = makeList(0x8000, 0x2000, 0xe000);
    expect(canAddMoreRemote(0xc000, list)).toBe(false);
  });

  it("プリセット 4 個 (超過) のとき false", () => {
    const list = makeList(0x8000, 0x2000, 0xe000, 0xc000);
    expect(canAddMoreRemote(0x8000, list)).toBe(false);
  });

  // ── 型 4 種すべてがカウント対象か ─────────────────────────────────────
  it("0x8000 (扇風機) がカウント対象", () => {
    // references_web/src/api/useRemoteCtrl.js:240 — type === 0x8000
    const list = makeList(0x8000, 0x8000, 0x8000);
    expect(canAddMoreRemote(0x8000, list)).toBe(false);
  });

  it("0x2000 (テレビ) がカウント対象", () => {
    // references_web/src/api/useRemoteCtrl.js:240 — type === 0x2000
    const list = makeList(0x2000, 0x2000, 0x2000);
    expect(canAddMoreRemote(0x2000, list)).toBe(false);
  });

  it("0xe000 (照明) がカウント対象", () => {
    // references_web/src/api/useRemoteCtrl.js:240 — type === 0xe000
    const list = makeList(0xe000, 0xe000, 0xe000);
    expect(canAddMoreRemote(0x8000, list)).toBe(false);
  });

  it("0xc000 (エアコン) がカウント対象", () => {
    // references_web/src/api/useRemoteCtrl.js:240 — type === 0xc000
    const list = makeList(0xc000, 0xc000, 0xc000);
    expect(canAddMoreRemote(0x2000, list)).toBe(false);
  });

  // ── 0xfe00 のリモコンはカウントに含まれない ────────────────────────────
  it("リスト内の 0xfe00 はカウントに含まれない (プリセット 2 個 + 学習 3 個でも true)", () => {
    // references_web/src/api/useRemoteCtrl.js:239-243 — 0xfe00 は条件分岐外
    const list = makeList(0x8000, 0x2000, 0xfe00, 0xfe00, 0xfe00);
    expect(canAddMoreRemote(0xc000, list)).toBe(true);
  });

  // ── type が文字列で来た場合も Number() で正規化される ─────────────────
  it("remoteList の type が文字列数値のとき正しくカウントする", () => {
    // type フィールドが JSON 経由で文字列になるケースを想定
    const list = [
      { type: "32768" },  // 0x8000
      { type: "8192" },   // 0x2000
      { type: "57344" },  // 0xe000
    ];
    expect(canAddMoreRemote(0xc000, list)).toBe(false);
  });

  // ── 境界値: ちょうど 3 個 ─────────────────────────────────────────────
  it("3 個ちょうどで false (counts >= 3 の境界値)", () => {
    // counts < 3 → true, counts >= 3 → false
    // references_web/src/api/useRemoteCtrl.js:252: return counts < 3
    expect(canAddMoreRemote(0x8000, makeList(0xc000, 0x2000, 0xe000))).toBe(false);
  });
});
