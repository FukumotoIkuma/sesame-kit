// drift-guard: committed の rpc-params.generated.json が、今の .d.ts から再生成した結果と
// 一致することを保証する (lib の param 型を変えて `npm run build` し忘れた stale を検出)。
import { describe, it, expect } from "vitest";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { generateSchema, serializeSchema, GENERATED_PATH, nodeToSchema } from "../../scripts/gen-rpc-schema.mjs";
import { generateProto, PROTO_PATH, MAP_PATH } from "../../scripts/gen-grpc-proto.mjs";

describe("生成物の drift", () => {
  it("rpc-params.generated.json は今の .d.ts から再生成した結果と一致", async () => {
    const fresh = serializeSchema(await generateSchema());
    expect(readFileSync(GENERATED_PATH, "utf8")).toBe(fresh); // 不一致なら npm run build:rpc-schema
  });

  it("sesame.proto + grpc-methods.generated.json は registry から再生成した結果と一致", async () => {
    const { protoText, nameMap } = await generateProto();
    expect(readFileSync(PROTO_PATH, "utf8")).toBe(protoText); // 不一致なら npm run build:grpc-proto
    expect(readFileSync(MAP_PATH, "utf8")).toBe(JSON.stringify(nameMap, null, 2) + "\n");
  });

  it("scalar (string/number) 引数の主要 op は jsonFields に落ちない (schema 付け忘れ検出)", async () => {
    const { nameMap } = await generateProto(); // { Pascal: { method, jsonFields } }
    const byMethod = Object.fromEntries(Object.values(nameMap).map((e) => [e.method, e]));
    // これらは scalar 引数のみ。jsonFields に入っていたら schema 欠落 = 型付き呼び出しが壊れる。
    for (const m of ["lock.unlock", "lock.status", "device.history", "device.battery", "ir.send", "ir.listKeys"]) {
      expect(byMethod[m], `${m} が生成物に無い`).toBeTruthy();
      expect(byMethod[m].jsonFields, `${m} の scalar 引数が JSON文字列field 化している (registry に schema を付与せよ)`).toEqual([]);
    }
  });

  it("公開 op の param schema は 1 つも空でない (型不明を放置しない回帰ガード)", async () => {
    const schema = await generateSchema();
    const empties = [];
    for (const [op, params] of Object.entries(schema)) {
      for (const p of params) {
        if (!p.schema || Object.keys(p.schema).length === 0) empties.push(`${op}.${p.name} (${p.tsType})`);
      }
    }
    // 空が出たら: nodeToSchema に型対応を足すか、本当に送れない型なら param から外す。
    expect(empties).toEqual([]);
  });
});

describe("nodeToSchema: union/literal を honestly に表す", () => {
  // 小さな .d.ts 断片を parse して 2 番目引数の各メンバ型 → schema を取り出す。
  function schemasOf(src) {
    const sf = ts.createSourceFile("t.d.ts", src, ts.ScriptTarget.Latest, true);
    const out = {};
    sf.forEachChild((n) => {
      if (!ts.isFunctionDeclaration(n)) return;
      const lit = n.parameters?.[1]?.type;
      if (lit && ts.isTypeLiteralNode(lit)) {
        for (const m of lit.members) out[m.name.getText(sf)] = nodeToSchema(m.type);
      }
    });
    return out;
  }

  it('文字列リテラル union ("ac"|"tv") → type:string + enum', () => {
    const s = schemasOf('declare function f(ws: any, p: { kind: "ac" | "tv" | "light" }): void;');
    expect(s.kind).toEqual({ type: "string", enum: ["ac", "tv", "light"] });
  });

  it("string|null → null を落とし type:string に解決", () => {
    const s = schemasOf("declare function f(ws: any, p: { name: string | null }): void;");
    expect(s.name).toEqual({ type: "string" });
  });

  it("異種 union (string|number) → anyOf", () => {
    const s = schemasOf("declare function f(ws: any, p: { v: string | number }): void;");
    expect(s.v).toEqual({ anyOf: [{ type: "string" }, { type: "number" }] });
  });

  it("数値リテラル → type:number + enum", () => {
    const s = schemasOf("declare function f(ws: any, p: { n: 1 | 2 }): void;");
    expect(s.n).toEqual({ type: "number", enum: [1, 2] });
  });
});
