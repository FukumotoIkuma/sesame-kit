// 公開 OpenRPC 契約を成果物として書き出す (schema/openrpc.json)。
//
// 実行時の rpc.discover と同じ buildOpenRpcDoc を使う = 「実装が真実」を成果物に固定する。
// info.version は API 契約の SemVer (CONTRACT_VERSION) で固定 (パッケージ version だと無害な
// bump でも churn するため)。要約等は英語 canonical で出す (locale 非依存の契約にするため)。
//
// drift gate (tests/openrpc-contract.test.js) がこの成果物と実装の一致を保証する。
// 実行: npm run build:openrpc (build:rpc-schema の後 — registry が .d.ts 由来 param を読むため)
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setLocale } from "../src/i18n.js";
import { buildRegistry, buildOpenRpcDoc } from "../src/serve/registry.js";
import { CONTRACT_VERSION } from "../src/jsonrpc.js";

setLocale("en"); // 公開契約は英語 canonical

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "schema", "openrpc.json");

const doc = buildOpenRpcDoc(buildRegistry(), CONTRACT_VERSION);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(doc, null, 2) + "\n");

const stable = doc.methods.filter((m) => m["x-stability"] === "stable").length;
console.log(`wrote ${OUT}`);
console.log(`  apiVersion=${CONTRACT_VERSION} methods=${doc.methods.length} (stable=${stable}) events=${doc["x-events"].length}`);
