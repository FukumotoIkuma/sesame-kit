// TS SDK 成果物 (packages/kit/sdk/ts/sesame-client.ts) ↔ スキーマ の drift gate。
//
// SDK はスキーマ駆動で機械生成される。スキーマ (schema/openrpc.json) を変えたのに
// `npm run build:sdk` を忘れると SDK が腐る。再生成結果が committed と一致することを担保し、
// あわせて stable メソッドが全て SDK に出ていることを確認する。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { generateSdk } from "../../../scripts/gen-sdk-ts.mjs";

const spec = JSON.parse(readFileSync(new URL("../../../schema/openrpc.json", import.meta.url)));
const committed = readFileSync(new URL("../sdk/ts/sesame-client.ts", import.meta.url), "utf8");

describe("TS SDK artifact (packages/kit/sdk/ts/sesame-client.ts)", () => {
  it("スキーマから再生成した結果と一致する (ずれたら `npm run build:sdk`)", () => {
    expect(generateSdk(spec)).toBe(committed);
  });

  it("全 stable メソッドが SDK に出ている (op 名で)", () => {
    const stable = spec.methods.filter((m) => m["x-stability"] === "stable");
    for (const m of stable) {
      const op = m.name.includes(".") ? m.name.slice(m.name.indexOf(".") + 1) : m.name;
      // `op:` (namespace 内) もしくは `op =` (ルート直下) のどちらかで現れる
      expect(committed.includes(`${op}:`) || committed.includes(`${op} =`)).toBe(true);
    }
  });

  it("experimental メソッドは @experimental 注記が付く", () => {
    expect(committed).toContain("@experimental");
    expect(committed).toContain(`API_VERSION = "${spec.info["x-apiVersion"]}"`);
  });

  it("HTTP transport errors are normalized into SesameRpcError kind/retryable", () => {
    expect(committed).toContain("function httpErrorKind");
    expect(committed).toContain('"not_authenticated"');
    expect(committed).toContain('"connection_lost"');
    expect(committed).toContain("cannot reach sesame serve");
  });
});
