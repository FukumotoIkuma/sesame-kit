// ビルド時に packages/core/types/*.d.ts から名前空間 op の param 型を抽出し、
// packages/kit/src/serve/rpc-params.generated.json を生成する。
// registry はこの JSON を実行時に読むだけ (tsc を実行時に走らせない)。
//
// 実行: npm run build:rpc-schema  (build:types の後に走らせる — .d.ts が要るため)

import ts from "typescript";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// 名前空間一覧は registry の NS_MODULES が単一真実源 (P1-15: 本スクリプト側の手書きリストに
// payment が漏れ、payment.* の型が openrpc/proto/SDK 全てでプレースホルダに劣化した再発防止)。
import { NAMESPACE_MODULE_KEYS } from "../packages/kit/src/serve/registry.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NS_MODULES = NAMESPACE_MODULE_KEYS;

/** TS の型ノード → JSON Schema。文字列マッチでなく AST のノード種別で判定する。
 *  union はメンバを anyOf/enum で honestly に表し、別名/未知型のみ {} を返す (嘘の型を主張しない)。 */
export function nodeToSchema(node) {
  if (!node) return {};
  switch (node.kind) {
    case ts.SyntaxKind.StringKeyword: return { type: "string" };
    case ts.SyntaxKind.NumberKeyword: return { type: "number" };
    case ts.SyntaxKind.BooleanKeyword: return { type: "boolean" };
    case ts.SyntaxKind.ObjectKeyword: return { type: "object" }; // `object`
    case ts.SyntaxKind.ArrayType: {           // X[]
      const items = nodeToSchema(node.elementType);
      return Object.keys(items).length ? { type: "array", items } : { type: "array" };
    }
    case ts.SyntaxKind.TypeLiteral: return { type: "object" }; // { a: ...; b: ... }
    // リテラル型は値そのものを enum で表す ("ac" → {type:"string", enum:["ac"]})。
    case ts.SyntaxKind.LiteralType: {
      const lit = node.literal;
      if (ts.isStringLiteral(lit)) return { type: "string", enum: [lit.text] };
      if (ts.isNumericLiteral(lit)) return { type: "number", enum: [Number(lit.text)] };
      if (lit.kind === ts.SyntaxKind.TrueKeyword) return { type: "boolean", enum: [true] };
      if (lit.kind === ts.SyntaxKind.FalseKeyword) return { type: "boolean", enum: [false] };
      return {};
    }
    // union は嘘の単一型に潰さず、解決できるメンバだけで honestly に表す。
    // null/undefined/未解決メンバは落とす (送れない/型不明なので)。
    case ts.SyntaxKind.UnionType: {
      const parts = node.types
        .filter((t) => t.kind !== ts.SyntaxKind.NullKeyword && t.kind !== ts.SyntaxKind.UndefinedKeyword)
        .map(nodeToSchema)
        .filter((s) => Object.keys(s).length);
      if (!parts.length) return {};
      // 全メンバが同型のリテラル (例: "ac"|"tv") → 1 つの enum にまとめる。
      const types = new Set(parts.map((p) => p.type));
      if (types.size === 1 && parts.every((p) => Array.isArray(p.enum))) {
        return { type: [...types][0], enum: parts.flatMap((p) => p.enum) };
      }
      return parts.length === 1 ? parts[0] : { anyOf: parts };
    }
  }
  if (ts.isTypeReferenceNode(node)) {
    const name = node.typeName.getText();
    if (name === "Array" && node.typeArguments?.length === 1) { // Array<X>
      const items = nodeToSchema(node.typeArguments[0]);
      return Object.keys(items).length ? { type: "array", items } : { type: "array" };
    }
    if (name === "Record" || name === "Object") return { type: "object" };
  }
  return {}; // 別名/未知型は型確定せず schema 空 (嘘の型を主張しない)
}

/**
 * 型ノードを「実体の TypeLiteral」へ解決する。
 *
 * 直接 `{ ... }` ならそのまま返す。`Parameters<typeof fn>[N]`
 * (= 別 op の N 番目引数を再利用する indexed-access 型。removeSesameFromHub3 が
 * addSesameToHub3 の引数を流用する等) は、参照先の関数宣言を同一 .d.ts 内で引いて
 * その N 番目引数の型へ解決する。チェーンしていても再帰で辿る。
 * 解決できない (別名/外部型) 場合は null。
 *
 * @param {ts.SourceFile} sf
 * @param {ts.TypeNode|undefined} type
 * @param {number} [depth] 循環参照の暴走防止
 * @returns {ts.TypeLiteralNode|null}
 */
function resolveTypeLiteral(sf, type, depth = 0) {
  if (!type || depth > 8) return null;
  if (ts.isTypeLiteralNode(type)) return type;

  // `X[N]` 形。X が `Parameters<typeof fn>`、N がリテラル数値のときだけ解決する。
  if (ts.isIndexedAccessTypeNode(type)) {
    const obj = type.objectType;
    const idx = type.indexType;
    if (
      ts.isTypeReferenceNode(obj) &&
      obj.typeName.getText(sf) === "Parameters" &&
      obj.typeArguments?.length === 1 &&
      ts.isTypeQueryNode(obj.typeArguments[0]) && // `typeof fn`
      ts.isLiteralTypeNode(idx) &&
      ts.isNumericLiteral(idx.literal)
    ) {
      const fnName = obj.typeArguments[0].exprName.getText(sf);
      const argIndex = Number(idx.literal.text);
      let resolved = null;
      sf.forEachChild((n) => {
        if (resolved) return;
        if (ts.isFunctionDeclaration(n) && n.name?.text === fnName) {
          resolved = resolveTypeLiteral(sf, n.parameters?.[argIndex]?.type, depth + 1);
        }
      });
      return resolved;
    }
  }
  return null;
}

/** 1 つの .d.ts から「関数名 → params(2番目引数のメンバ)」を抽出。
 *  JSON で送れない関数型メンバ (コールバック等) は除外する。
 *  2 番目引数が `{ ... }` でなくても `Parameters<typeof other>[1]` 形なら参照先へ解決する。 */
function extractModule(ns) {
  const file = resolve(ROOT, "packages/core/types", `${ns}.d.ts`);
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const out = {};
  sf.forEachChild((n) => {
    if (!ts.isFunctionDeclaration(n) || !n.name) return;
    const p = n.parameters?.[1];
    if (!p || !p.type) return;
    const lit = resolveTypeLiteral(sf, p.type);
    if (!lit) return;
    out[n.name.text] = lit.members
      .filter((m) => m.name && m.type)
      .filter((m) => !ts.isFunctionTypeNode(m.type)) // コールバック等は wire param でない
      .map((m) => ({
        name: m.name.getText(sf),
        required: !m.questionToken,
        tsType: m.type.getText(sf),
        schema: nodeToSchema(m.type),
      }));
  });
  return out;
}

// SURF-09: daemon (SesameHub3._bindNs) が config/account から自動注入する param。
// lib 関数のシグネチャ上は必須 (string) でも、RPC 契約としては省略可 — 省略時は daemon が
// `hub.refreshAccount()` で解決済みの実値を注入する。required:true のままだと SDK/型付き
// クライアントが「必須なのに値を知らない」矛盾した契約になるため、生成時に上書きする。
const DAEMON_INJECTED_PARAMS = Object.freeze({
  companyID: "auto-injected by the daemon from config/account when omitted",
  subUUID: "auto-injected by the daemon from the logged-in account when omitted",
});

/**
 * 名前空間 op の param 配列へ daemon 注入 param の required:false 上書きを適用する (SURF-09)。
 * @param {Array<{name:string, required:boolean, tsType?:string, schema?:object}>} params
 */
function applyDaemonInjectedOverride(params) {
  return params.map((p) => {
    const note = DAEMON_INJECTED_PARAMS[p.name];
    if (!note) return p;
    return { ...p, required: false, desc: `${p.tsType ?? ""} — ${note}`.trim() };
  });
}

/** 生成結果オブジェクトを返す (テストの drift-guard が呼ぶ)。 */
export async function generateSchema() {
  const result = {};
  for (const ns of NS_MODULES) {
    // 公開 op の allowlist だけ採用 (内部ヘルパは除外)。
    const mod = await import(resolve(ROOT, "packages/core/src", `${ns}.js`));
    const ops = new Set(Array.isArray(mod.NAMESPACE_OPS) ? mod.NAMESPACE_OPS : []);
    const extracted = extractModule(ns);
    for (const [fn, params] of Object.entries(extracted)) {
      if (ops.has(fn)) result[`${ns}.${fn}`] = applyDaemonInjectedOverride(params);
    }
  }
  return result;
}

export const GENERATED_PATH = resolve(ROOT, "packages/kit/src", "serve", "rpc-params.generated.json");
/** 文字列表現 (ファイルと byte 一致を比較するため統一)。 */
export function serializeSchema(obj) {
  return JSON.stringify(obj, null, 2) + "\n";
}

// スクリプトとして実行された時だけファイルへ書き出す。
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await generateSchema();
  writeFileSync(GENERATED_PATH, serializeSchema(result));
  console.log(`wrote ${GENERATED_PATH} (${Object.keys(result).length} ops)`);
}
