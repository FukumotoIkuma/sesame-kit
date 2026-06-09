// schema/openrpc.json から型付き Python SDK を生成する (sdk/python/sesame_client.py)。
//
// TS 版 (gen-sdk-ts.mjs) と同じスキーマ駆動。公開契約を唯一の入力に機械生成し、
// build:openrpc → build:sdk:py で伝播、drift gate (tests/sdk-py-contract.test.js) が同期を担保。
// 依存ゼロ (urllib 標準ライブラリ) で動く。experimental は docstring に @experimental を付す。
//
// 実行: npm run build:sdk:py (build:openrpc の後)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC = resolve(ROOT, "schema", "openrpc.json");
const OUT = resolve(ROOT, "sdk", "python", "sesame_client.py");

const PY_KEYWORDS = new Set([
  "False","None","True","and","as","assert","async","await","break","class","continue","def","del",
  "elif","else","except","finally","for","from","global","if","import","in","is","lambda","nonlocal",
  "not","or","pass","raise","return","try","while","with","yield","match","case",
]);

/** OpenRPC param schema → Python 型 (不明は Any)。 */
function pyType(schema) {
  if (!schema || Object.keys(schema).length === 0) return "Any";
  switch (schema.type) {
    case "string": return schema.enum ? `Literal[${schema.enum.map((v) => JSON.stringify(v)).join(", ")}]` : "str";
    case "number": return schema.enum ? `Literal[${schema.enum.join(", ")}]` : "float";
    case "boolean": return "bool";
    case "array": return `list[${pyType(schema.items || {})}]`;
    case "object": return "dict[str, Any]";
    default: return "Any";
  }
}

/** result schema → Python 戻り型。形不明 (bare object/{}) は Any。object は dict[str, Any]
 * (Python はインライン object 型が無いため。完全な型は TypedDict 化が要るが現状はここまで)。 */
function pyResultType(schema) {
  if (!schema || typeof schema !== "object") return "Any";
  if (schema.properties) return "dict[str, Any]";
  switch (schema.type) {
    case "string": return "str";
    case "number": return "float";
    case "boolean": return "bool";
    case "array": return `list[${pyResultType(schema.items || {})}]`;
    default: return "Any"; // bare object / 型不明
  }
}

/** params 配列 → {usable, sig, body}。usable=false なら **params フォールバック。 */
function methodParams(params) {
  const real = (params || []).filter((p) => p.name && p.name !== "(params)");
  if (real.length === 0) {
    // 抽出済み param 無し (汎用 op) → **params
    return { generic: true };
  }
  if (real.some((p) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.name) || PY_KEYWORDS.has(p.name))) {
    return { generic: true }; // 識別子にできない名前があれば安全側で **params
  }
  // keyword-only。required は default 無し、optional は = None。
  const sig = real.map((p) => `${p.name}: ${p.required ? pyType(p.schema) : `${pyType(p.schema)} | None`}${p.required ? "" : " = None"}`);
  const dict = real.map((p) => `"${p.name}": ${p.name}`);
  return { generic: false, sig, dict };
}

function emitMethod(m, indent) {
  const mp = methodParams(m.params);
  const tag = m["x-stability"] === "experimental"
    ? `${indent}    """@experimental (${m["x-provenance"]}) — may change without notice."""\n`
    : "";
  const ret = pyResultType(m.result?.schema);
  if (mp.generic) {
    return `${indent}def ${m.op}(self, **params: Any) -> ${ret}:\n${tag}${indent}    return self._c._call(${JSON.stringify(m.name)}, params)`;
  }
  const sig = `self, *, ${mp.sig.join(", ")}`;
  return `${indent}def ${m.op}(${sig}) -> ${ret}:\n${tag}${indent}    return self._c._call(${JSON.stringify(m.name)}, _omit_none({${mp.dict.join(", ")}}))`;
}

/** OpenRPC spec → Python SDK ソース (決定的)。drift gate がこの純関数を再実行して比較する。 */
export function generateSdkPy(spec) {
  const groups = new Map();
  for (const m of [...spec.methods].sort((a, b) => a.name.localeCompare(b.name))) {
    const dot = m.name.indexOf(".");
    const ns = dot >= 0 ? m.name.slice(0, dot) : "";
    const op = dot >= 0 ? m.name.slice(dot + 1) : m.name;
    if (!groups.has(ns)) groups.set(ns, []);
    groups.get(ns).push({ ...m, op });
  }

  const nsClasses = [];
  const nsAttrs = [];
  for (const [ns, methods] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (ns === "") continue;
    const cls = `_${ns.charAt(0).toUpperCase()}${ns.slice(1)}`;
    nsClasses.push(`class ${cls}:\n    def __init__(self, c: "SesameClient") -> None:\n        self._c = c\n\n${methods.map((m) => emitMethod(m, "    ")).join("\n\n")}`);
    nsAttrs.push(`        self.${ns} = ${cls}(self)`);
  }
  // ルート直下メソッド (status 等) は SesameClient のメソッドとして出す。
  const rootMethods = (groups.get("") || []).map((m) => {
    const mp = methodParams(m.params);
    const tag = m["x-stability"] === "experimental" ? `        """@experimental (${m["x-provenance"]})."""\n` : "";
    const ret = pyResultType(m.result?.schema);
    if (mp.generic) return `    def ${m.op}(self, **params: Any) -> ${ret}:\n${tag}        return self._call(${JSON.stringify(m.name)}, params)`;
    return `    def ${m.op}(self, *, ${mp.sig.join(", ")}) -> ${ret}:\n${tag}        return self._call(${JSON.stringify(m.name)}, _omit_none({${mp.dict.join(", ")}}))`;
  }).join("\n\n");

  const stableCount = spec.methods.filter((m) => m["x-stability"] === "stable").length;
  // 購読可能 topic (event.ready 等の broadcast は含まない)。型もここから導出 = drift gate 対象。
  const eventTopics = spec["x-event-topics"] || [];
  const topicType = eventTopics.length ? `Literal[${eventTopics.map((t) => JSON.stringify(t)).join(", ")}]` : "str";

  return `# GENERATED by scripts/gen-sdk-py.mjs from schema/openrpc.json — DO NOT EDIT.
# apiVersion ${spec.info["x-apiVersion"]} · ${spec.methods.length} methods (${stableCount} stable).
# Regenerate: npm run build:sdk:py. Drift-gated by tests/sdk-py-contract.test.js.
#
# Self-hosted client for the \`sesame serve\` daemon (JSON-RPC over HTTP). Zero deps (urllib).
# Methods tagged @experimental are outside the API SemVer guarantee.
from __future__ import annotations

import json
import urllib.request
from urllib.parse import quote
from typing import Any, Callable, Literal  # noqa: F401  (Literal used by generated enums)

API_VERSION = ${JSON.stringify(spec.info["x-apiVersion"])}

# Subscribable event topics (event.ready and other broadcast notifications excluded).
SesameEventTopic = ${topicType}


class SesameRpcError(Exception):
    def __init__(self, message: str, code: int, data: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.data = data or {}
        self.kind = self.data.get("kind")
        self.retryable = self.data.get("retryable")


def _omit_none(d: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


${nsClasses.join("\n\n\n")}


class SesameClient:
    """Typed client for \`sesame serve\` (JSON-RPC over HTTP POST /rpc)."""

    def __init__(self, base_url: str, token: str | None = None) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._id = 0
${nsAttrs.join("\n")}

    def _call(self, method: str, params: Any) -> Any:
        self._id += 1
        body = json.dumps({"jsonrpc": "2.0", "id": self._id, "method": method, "params": params}).encode()
        headers = {"content-type": "application/json"}
        if self._token:
            headers["authorization"] = f"Bearer {self._token}"
        req = urllib.request.Request(f"{self._base_url}/rpc", data=body, headers=headers, method="POST")
        with urllib.request.urlopen(req) as resp:
            msg = json.loads(resp.read())
        if "error" in msg and msg["error"] is not None:
            err = msg["error"]
            raise SesameRpcError(err.get("message", "error"), err.get("code", -32000), err.get("data"))
        return msg.get("result")

    def stream_events(self, topics: list[SesameEventTopic], on_event: Callable[[dict[str, Any]], None]) -> None:
        """Stream server-sent events (SSE GET /events). Blocks; calls on_event(frame) per event
        ({"method": "event.<topic>", "params": ...}). The callback also receives event.ready on
        connect. Run in a thread if you need it non-blocking."""
        url = f"{self._base_url}/events?topics={quote(','.join(topics))}"
        headers = {"accept": "text/event-stream"}
        if self._token:
            headers["authorization"] = f"Bearer {self._token}"
        req = urllib.request.Request(url, headers=headers, method="GET")
        with urllib.request.urlopen(req) as resp:
            for raw in resp:
                line = raw.decode("utf-8", "replace").rstrip("\\r\\n")
                if line.startswith("data:"):  # ":" comment lines (heartbeat) ignored
                    payload = line[5:].strip()
                    if payload:
                        on_event(json.loads(payload))

${rootMethods}
`;
}

// CLI 実行時のみ生成・書き出し (import 時は generateSdkPy だけ使えるよう副作用を出さない)。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const spec = JSON.parse(readFileSync(SPEC, "utf8"));
  const out = generateSdkPy(spec);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, out);
  console.log(`wrote ${OUT} (apiVersion ${spec.info["x-apiVersion"]}, ${spec.methods.length} methods)`);
}
