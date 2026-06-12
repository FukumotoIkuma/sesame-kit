// Python SDK 成果物 (sdk/python/sesame_client.py) ↔ スキーマ の drift gate (TS 版と対)。
//
// スキーマ駆動で機械生成されるので、schema を変えて `npm run build:sdk:py` を忘れると腐る。
// 再生成結果が committed と一致することを担保し、stable メソッドが全て出ていることを確認する。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { generateSdkPy } from "../../../scripts/gen-sdk-py.mjs";

const spec = JSON.parse(readFileSync(new URL("../../../schema/openrpc.json", import.meta.url)));
const committed = readFileSync(new URL("../../../sdk/python/sesame_client.py", import.meta.url), "utf8");

describe("Python SDK artifact (sdk/python/sesame_client.py)", () => {
  it("スキーマから再生成した結果と一致する (ずれたら `npm run build:sdk:py`)", () => {
    expect(generateSdkPy(spec)).toBe(committed);
  });

  it("全 stable メソッドが SDK に def として出ている", () => {
    const stable = spec.methods.filter((m) => m["x-stability"] === "stable");
    for (const m of stable) {
      const op = m.name.includes(".") ? m.name.slice(m.name.indexOf(".") + 1) : m.name;
      expect(committed.includes(`def ${op}(`)).toBe(true);
    }
  });

  it("experimental は @experimental docstring・API_VERSION を持つ", () => {
    expect(committed).toContain("@experimental");
    expect(committed).toContain(`API_VERSION = "${spec.info["x-apiVersion"]}"`);
  });
});
