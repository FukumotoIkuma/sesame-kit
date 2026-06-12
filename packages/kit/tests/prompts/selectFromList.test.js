// selectFromList の単体テスト。
//
// selectFromList は実際の選択を @inquirer/prompts の select() (矢印キー UI) に委譲する。
// 矢印キー操作の end-to-end は対話 TTY 依存で単体テストに不向きなため、ここでは
//   - 入力バリデーション (空/非配列 → throw)
//   - 要素1個の auto-pick (select を呼ばない)
//   - 複数要素のとき select に正しい {message, choices(name=label, value=item)} を渡す
//   - select の戻り (= 選ばれた item) をそのまま返す
// を、select を vi.mock で差し替えて検証する (TTY 非依存)。
import { describe, it, expect, beforeEach, vi } from "vitest";

// @inquirer/prompts を丸ごとモック (select/input/confirm)。
vi.mock("@inquirer/prompts", () => ({
  select: vi.fn(),
  input: vi.fn(),
  confirm: vi.fn(),
}));

import { select } from "@inquirer/prompts";
import { selectFromList } from "../../src/prompts.js";

beforeEach(() => {
  vi.mocked(select).mockReset();
});

describe("selectFromList - 入力バリデーション (select を呼ばない)", () => {
  it("空配列 → throw", async () => {
    await expect(selectFromList("デバイスを選択", [])).rejects.toThrow(/デバイスを選択: 候補がありません/);
    expect(select).not.toHaveBeenCalled();
  });
  it("undefined → throw", async () => {
    await expect(selectFromList("選んで", undefined)).rejects.toThrow(/候補がありません/);
  });
  it("null → throw", async () => {
    await expect(selectFromList("選んで", null)).rejects.toThrow(/候補がありません/);
  });
  it("非配列 (オブジェクト) → throw", async () => {
    await expect(selectFromList("選んで", { 0: "a" })).rejects.toThrow(/候補がありません/);
  });
});

describe("selectFromList - auto-pick", () => {
  it("要素1個ならその要素を即返し、select を呼ばない", async () => {
    const only = { id: "only" };
    const r = await selectFromList("選択", [only]);
    expect(r).toBe(only);
    expect(select).not.toHaveBeenCalled();
  });
});

describe("selectFromList - 複数選択 (select に委譲)", () => {
  it("choices は {name:label, value:item}、message は装飾を剥がして渡す", async () => {
    const items = [{ id: "A" }, { id: "B" }, { id: "C" }];
    vi.mocked(select).mockResolvedValue(items[1]);
    const r = await selectFromList("? 選択してください", items, (it) => `lock:${it.id}`);
    expect(r).toBe(items[1]); // select の戻りをそのまま返す
    expect(select).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(select).mock.calls[0][0];
    expect(arg.message).toBe("選択してください"); // 先頭の "? " を除去
    expect(arg.choices).toEqual([
      { name: "lock:A", value: items[0] },
      { name: "lock:B", value: items[1] },
      { name: "lock:C", value: items[2] },
    ]);
  });

  it("getLabel 省略時は String() でラベル化", async () => {
    const items = ["alpha", "beta"];
    vi.mocked(select).mockResolvedValue("beta");
    const r = await selectFromList("選択", items);
    expect(r).toBe("beta");
    const arg = vi.mocked(select).mock.calls[0][0];
    expect(arg.choices.map((c) => c.name)).toEqual(["alpha", "beta"]);
  });

  it("select が投げたらそのまま伝播 (Ctrl-C 等)", async () => {
    vi.mocked(select).mockRejectedValue(new Error("User force closed"));
    await expect(selectFromList("選択", ["a", "b"])).rejects.toThrow(/force closed/);
  });
});
