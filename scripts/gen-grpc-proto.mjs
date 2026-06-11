// ビルド時に registry 全 op から **型付き** gRPC 定義を生成する。
//   - src/serve/sesame.proto          : op ごとに型付き Request message + 型付き service
//   - src/serve/grpc-methods.generated.json : gRPC メソッド名(Pascal) → JSON-RPC メソッド名
//
// 設計: request は実 param を protobuf 型に (string/double/bool/repeated string …)。
//       動的な葉 (object/未知) は google.protobuf.Struct/Value (公式の動的 JSON 型)。
//       response は google.protobuf.Value (配列/スカラ/オブジェクトを一様に運べる)。
// これにより「JSON 文字列を運ぶだけの gRPC」でなく、型付き codegen の価値が出る。
//
// 実行: npm run build:grpc-proto  (build:rpc-schema の後。registry が生成 JSON を読むため)

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry } from "../src/serve/registry.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** "lock.unlock" → "LockUnlock" (gRPC メソッド名は識別子なので分割して PascalCase 連結)。 */
function pascal(method) {
  return method.split(".").map((s) => s.replace(/[^a-zA-Z0-9]/g, "")).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join("");
}

/**
 * 抽出済 JSON Schema → protobuf 型。**proto-loader が生 JS を Struct/Value に変換しない**ことを
 * 実測で確認したため、scalar/string配列だけ protobuf 型にし、**object/動的な葉は JSON 文字列**
 * (`string`, json=true) にする。glue がその field だけ JSON.parse する。
 * @returns {{ type:string, json:boolean }}
 */
function pbFieldType(schema) {
  const s = schema || {};
  if (s.type === "string") return { type: "string", json: false };
  if (s.type === "number") return { type: "double", json: false };
  if (s.type === "boolean") return { type: "bool", json: false };
  if (s.type === "array" && s.items && s.items.type === "string") return { type: "repeated string", json: false };
  // object / object[] / 未知 → JSON 文字列 (動的な葉)。
  return { type: "string", json: true };
}

/** proto フィールド名として妥当か ([a-zA-Z_][a-zA-Z0-9_]*)。 */
function validField(name) {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

export async function generateProto() {
  const reg = buildRegistry();
  const methods = []; // { jsonrpc, pascal, fields:[{type,name}] }

  for (const [name, entry] of reg) {
    if (name.startsWith("events.")) continue; // イベントは Subscribe ストリームで扱う
    const params = entry.params || [];
    const fields = [];
    const jsonFields = []; // glue が JSON.parse する field 名
    for (const p of params) {
      if (!validField(p.name)) {
        fields.push({ type: "string", name: "params" }); // "(params)" 等は JSON 文字列に
        jsonFields.push("params");
      } else {
        const t = pbFieldType(p.schema);
        fields.push({ type: t.type, name: p.name });
        if (t.json) jsonFields.push(p.name);
      }
    }
    methods.push({ jsonrpc: name, pascal: pascal(name), fields, jsonFields });
  }
  // SURF-22: 旧実装はここで `Discover` を追加していたが、registry の rpc.discover が上のループで
  // `RpcDiscover` として既に生成されるため同一 op への重複 rpc だった。利用箇所 (tests/clients/
  // sdk/docs) に `Discover` 参照は無いことを確認の上、deprecated 残置はせず即削除した。

  // ---- .proto テキスト ----
  const L = [];
  L.push("// 自動生成 (scripts/gen-grpc-proto.mjs)。手で編集しない (npm run build:grpc-proto)。");
  L.push("// request は scalar/string配列を protobuf 型に、object/動的な葉は JSON 文字列 (proto-loader が");
  L.push("// 生 JS を Struct に変換しないため)。response は dynamic なので JsonRpc(json) で運ぶ。");
  L.push('syntax = "proto3";');
  L.push("package sesame;");
  L.push("");
  L.push("service Sesame {");
  for (const m of methods) {
    L.push(`  rpc ${m.pascal} (${m.pascal}Request) returns (JsonRpc);`);
  }
  L.push("  // イベント購読 (topics を渡し event を stream で受ける)。payload は JSON 文字列。");
  L.push("  rpc Subscribe (SubReq) returns (stream Event);");
  L.push("  // 後方互換: 任意の JSON-RPC を文字列で運ぶ汎用経路 (型付きに無い新 op 用)。");
  L.push("  rpc Invoke (JsonRpc) returns (JsonRpc);");
  L.push("}");
  L.push("");
  for (const m of methods) {
    L.push(`message ${m.pascal}Request {`);
    m.fields.forEach((f, i) => L.push(`  ${f.type} ${f.name} = ${i + 1};`));
    L.push("}");
  }
  L.push("");
  L.push("message SubReq { string token = 1; repeated string topics = 2; }");
  L.push("message Event { string topic = 1; string json = 2; }");
  L.push("message JsonRpc { string json = 1; }");
  L.push("");

  const protoText = L.join("\n");
  // map: Pascal → { method, jsonFields }。glue が JSON.parse する field を知るため。
  const nameMap = Object.fromEntries(methods.map((m) => [m.pascal, { method: m.jsonrpc, jsonFields: m.jsonFields }]));
  return { protoText, nameMap, count: methods.length };
}

export const PROTO_PATH = resolve(ROOT, "src", "serve", "sesame.proto");
export const MAP_PATH = resolve(ROOT, "src", "serve", "grpc-methods.generated.json");

if (import.meta.url === `file://${process.argv[1]}`) {
  const { protoText, nameMap, count } = await generateProto();
  writeFileSync(PROTO_PATH, protoText);
  writeFileSync(MAP_PATH, JSON.stringify(nameMap, null, 2) + "\n");
  console.log(`wrote ${PROTO_PATH} + ${MAP_PATH} (${count} typed methods)`);
}
