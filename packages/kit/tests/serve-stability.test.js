// stability ソースの整合ガード。
//
// STABLE_METHODS / STABLE_EVENTS は手書きの真実なので、レジストリのメソッド名や
// 広告イベント名と乖離すると、本来 stable のものが無言で experimental に降格する
// (stabilityOf は未登録を experimental にフォールバックするため、エラーにならない)。
// = このプラットフォームが防ぐべき "schema ↔ impl ドリフト" を stability 自身で起こす穴。
// それを CI で必ず落とすため、全キーが実在することを保証する。
//
// 純ロジックなので unit project (tests/serve/ 外に配置) で走らせる。
import { describe, it, expect } from "vitest";
import { buildRegistry, buildOpenRpcDoc } from "../src/serve/registry.js";
import { STABLE_METHODS, STABLE_EVENTS } from "../src/serve/stability.js";

describe("stability source integrity", () => {
  const reg = buildRegistry();
  const methodNames = new Set(reg.keys());
  const eventNames = new Set(buildOpenRpcDoc(reg, "0.0.0")["x-events"].map((e) => e.name));

  it("every STABLE_METHODS key is a real registered method (no typo / stale name)", () => {
    const missing = Object.keys(STABLE_METHODS).filter((n) => !methodNames.has(n));
    expect(missing).toEqual([]);
  });

  it("every STABLE_EVENTS key is a real advertised event", () => {
    const missing = Object.keys(STABLE_EVENTS).filter((n) => !eventNames.has(n));
    expect(missing).toEqual([]);
  });
});
