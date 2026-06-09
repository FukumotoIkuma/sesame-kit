// RESULT_SCHEMAS (結果形の単一真実源) と registry の整合テスト。
//
// result-schemas.js は registry.js → OpenRPC → 生成 SDK の result 型へ流れる単一源。
// 「実在しないメソッドのスキーマ (orphan)」が紛れると、SDK には出ないのに気付けず腐るため、
// 全 RESULT_SCHEMAS キーが registry の実メソッドであることをここで保証する
// (逆方向 = 記録応答との shape 整合は tests/serve/upstream-canary-replay.test.js が担当)。
import { describe, it, expect } from "vitest";
import { buildRegistry } from "../../src/serve/registry.js";
import { RESULT_SCHEMAS } from "../../src/serve/result-schemas.js";

describe("RESULT_SCHEMAS ↔ registry の整合", () => {
  const methods = new Set([...buildRegistry().keys()]);

  it("全 RESULT_SCHEMAS キーは registry の実メソッド (orphan スキーマ無し)", () => {
    for (const name of Object.keys(RESULT_SCHEMAS)) {
      expect(methods.has(name), `RESULT_SCHEMAS["${name}"] に対応する registry メソッドが無い`).toBe(true);
    }
  });

  it("各スキーマは type を持つ JSON-Schema 風オブジェクト (生成器が解釈できる形)", () => {
    for (const [name, schema] of Object.entries(RESULT_SCHEMAS)) {
      expect(schema && typeof schema === "object", `${name}: スキーマがオブジェクトでない`).toBe(true);
      expect(["object", "array", "string", "number", "boolean"]).toContain(schema.type);
    }
  });

  it("凍結されている (実行時の誤改変を防ぐ)", () => {
    expect(Object.isFrozen(RESULT_SCHEMAS)).toBe(true);
  });
});
