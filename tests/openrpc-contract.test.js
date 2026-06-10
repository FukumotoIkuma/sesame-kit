// 公開 OpenRPC 成果物 (schema/openrpc.json) ↔ 実装 の双方向 drift gate。
//
// これが iii の核心: 「実装が真実」を成果物に固定し、両者がずれたら CI で必ず落とす。
// ずれる典型: メソッド/イベント追加・param 変更・tier 変更を commit したが
// `npm run build:openrpc` を忘れた → 公開契約が黙って腐るのを防ぐ。
//
// 比較対象は「機械契約の射影」(メソッド名 / params 名・required・schema / result 型 /
// x-stability / x-provenance / events)。要約・説明文はローカライズされた *ドキュメント* で
// あって契約ではないので、locale 非依存にするため射影から除外する (SDK 生成が依存するのは
// 機械的な形だけ)。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildRegistry, buildOpenRpcDoc } from "../src/serve/registry.js";
import { CONTRACT_VERSION } from "../src/serve/jsonrpc.js";

/** OpenRPC doc → 機械契約だけの射影 (散文を落とす)。 */
function machineContract(doc) {
  const param = (p) => ({ name: p.name, required: p.required, schema: p.schema });
  return {
    openrpc: doc.openrpc,
    info: {
      title: doc.info.title,
      version: doc.info.version,
      "x-apiVersion": doc.info["x-apiVersion"],
      "x-contractVersion": doc.info["x-contractVersion"],
    },
    methods: doc.methods.map((m) => ({
      name: m.name,
      params: (m.params || []).map(param),
      // 結果スキーマ全体を契約に含める (型付き SDK return の drift を捕捉)。description は散文なので除く。
      result: m.result?.schema ? { ...m.result.schema, description: undefined } : undefined,
      "x-stability": m["x-stability"],
      "x-provenance": m["x-provenance"],
    })),
    events: doc["x-events"].map((e) => ({
      name: e.name,
      "x-stability": e["x-stability"],
      "x-provenance": e["x-provenance"],
    })),
    eventTopics: doc["x-event-topics"],
  };
}

const committed = JSON.parse(readFileSync(new URL("../schema/openrpc.json", import.meta.url)));

describe("OpenRPC contract artifact (schema/openrpc.json)", () => {
  it("機械契約が実装と一致する (ずれたら `npm run build:openrpc` で再生成)", () => {
    const live = buildOpenRpcDoc(buildRegistry(), CONTRACT_VERSION);
    expect(machineContract(committed)).toEqual(machineContract(live));
  });

  it("info.version / x-apiVersion は CONTRACT_VERSION", () => {
    expect(committed.info.version).toBe(CONTRACT_VERSION);
    expect(committed.info["x-apiVersion"]).toBe(CONTRACT_VERSION);
  });

  it("rpc.discover 自身も公開契約に含む", () => {
    const discover = committed.methods.find((m) => m.name === "rpc.discover");
    expect(discover).toBeTruthy();
    expect(discover["x-stability"]).toBe("stable");
    expect(discover["x-provenance"]).toBe("local");
  });

  it("全 method/event が x-stability / x-provenance を持つ (公開契約の完全性)", () => {
    for (const m of committed.methods) {
      expect(["stable", "experimental"]).toContain(m["x-stability"]);
      expect(typeof m["x-provenance"]).toBe("string");
    }
    for (const e of committed["x-events"]) {
      expect(["stable", "experimental"]).toContain(e["x-stability"]);
    }
  });
});
