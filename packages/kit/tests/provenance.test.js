// provenance 整合: tier は provenance から導出される、という不変条件を固定する (v)。
//
// 二境界モデル (docs/api-stability.md) の要: stable は「公式アプリで load-bearing かつ検証済み」
// = provenance が local / app-core のものだけ。experimental は unverified。これを機械的に保証し、
// 「確信度 (provenance)」と「約束 (tier)」が乖離しないことを CI で守る。
import { describe, it, expect } from "vitest";
import { buildRegistry, buildOpenRpcDoc } from "../src/serve/registry.js";
import { stabilityOf, provenanceOf, eventStabilityOf, eventProvenanceOf } from "../src/serve/stability.js";

const PROVENANCE_VOCAB = ["local", "app-core", "unverified"];
const STABLE_PROVENANCE = ["local", "app-core"]; // stable に許される provenance

describe("provenance ↔ tier consistency", () => {
  const reg = buildRegistry();
  const eventNames = buildOpenRpcDoc(reg, "0.0.0")["x-events"].map((e) => e.name);

  it("全 method の provenance は語彙内", () => {
    for (const name of reg.keys()) {
      expect(PROVENANCE_VOCAB).toContain(provenanceOf(name));
    }
  });

  it("stable method は検証済み provenance / experimental は unverified", () => {
    for (const name of reg.keys()) {
      if (stabilityOf(name) === "stable") {
        expect(STABLE_PROVENANCE).toContain(provenanceOf(name));
      } else {
        expect(provenanceOf(name)).toBe("unverified");
      }
    }
  });

  it("event も同じ不変条件を満たす", () => {
    for (const name of eventNames) {
      expect(PROVENANCE_VOCAB).toContain(eventProvenanceOf(name));
      if (eventStabilityOf(name) === "stable") {
        expect(STABLE_PROVENANCE).toContain(eventProvenanceOf(name));
      } else {
        expect(eventProvenanceOf(name)).toBe("unverified");
      }
    }
  });
});
