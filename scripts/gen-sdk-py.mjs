// schema/openrpc.json から型付き Python SDK を生成する (packages/kit/sdk/python/sesame_client.py)。
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
const OUT = resolve(ROOT, "packages", "kit", "sdk", "python", "sesame_client.py");

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

/** PascalCase 連結でクラス名を作る (path セグメントから決定的に・識別子に正規化)。 */
function pyClassName(s) {
  return String(s).replace(/[^A-Za-z0-9]+/g, " ").trim().split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}

function pyIdentifier(s) {
  let out = String(s).replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!out) out = "call";
  if (/^[0-9]/.test(out)) out = `_${out}`;
  if (PY_KEYWORDS.has(out)) out = `${out}_`;
  return out;
}

/** result schema → Python 戻り型。properties 付き object は TypedDict を classes に登録して
 * そのクラス名を返す (= 完全型付け)。形不明 (bare object / {}) は Any (嘘をつかない)。
 * nullable:true は `| None` を付す。`classes`: Map<className, {fields}|null(予約中)>。 */
function pyResultType(schema, prefix, classes) {
  if (!schema || typeof schema !== "object") return "Any";
  const base = pyResultTypeBase(schema, prefix, classes);
  return schema.nullable ? `${base} | None` : base;
}

function pyResultTypeBase(schema, prefix, classes) {
  if (schema.properties) return registerTypedDict(schema, prefix, classes);
  switch (schema.type) {
    case "string": return "str";
    case "number": return "float";
    case "boolean": return "bool";
    case "array": return `list[${pyResultType(schema.items || {}, `${prefix}Item`, classes)}]`;
    default: return "Any"; // bare object (中身未確定) / 型不明 → Any
  }
}

/** properties 付き object を TypedDict として classes に登録し、クラス名を返す (冪等)。
 * Python 識別子にできないキーが 1 つでもあれば TypedDict 化を諦め dict[str, Any] に落とす
 * (functional TypedDict は __future__ annotations 下で NotRequired を評価できず 3.10 で壊れるため)。 */
function registerTypedDict(schema, name, classes) {
  const props = Object.entries(schema.properties);
  const unsafe = props.some(([k]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || PY_KEYWORDS.has(k));
  if (unsafe) return "dict[str, Any]";
  if (!classes.has(name)) {
    classes.set(name, null); // 予約 (再帰/循環での重複登録を防ぐ)
    const req = schema.required || [];
    const fields = props.map(([k, v]) => ({
      name: k,
      type: pyResultType(v, `${name}${pyClassName(k)}`, classes),
      required: req.includes(k),
    }));
    classes.set(name, { fields });
  }
  return name;
}

/** メソッドの戻り型を解決 (root の命名規則を与える)。`classes` に TypedDict を副作用で登録。 */
function methodReturnType(schema, methodName, classes) {
  return pyResultType(schema, `${pyClassName(methodName)}Result`, classes);
}

/** 収集した TypedDict 定義をソース化。optional フィールドは NotRequired[...] (3.11+ 型;
 * __future__ annotations で注釈は文字列化されるため 3.10 ランタイムでも安全)。 */
function emitTypedDicts(classes) {
  const blocks = [];
  for (const [name, def] of classes) {
    if (!def) continue;
    const lines = def.fields.map((f) => `    ${f.name}: ${f.required ? f.type : `NotRequired[${f.type}]`}`);
    blocks.push(`class ${name}(TypedDict):\n${lines.length ? lines.join("\n") : "    pass"}`);
  }
  return blocks.join("\n\n\n");
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

function emitMethod(m, indent, classes) {
  const mp = methodParams(m.params);
  const tag = m["x-stability"] === "experimental"
    ? `${indent}    """@experimental (${m["x-provenance"]}) — may change without notice."""\n`
    : "";
  const ret = methodReturnType(m.result?.schema, m.name, classes);
  const op = pyIdentifier(m.op);
  if (mp.generic) {
    return `${indent}def ${op}(self, **params: Any) -> ${ret}:\n${tag}${indent}    return self._c._call(${JSON.stringify(m.name)}, params)`;
  }
  const sig = `self, *, ${mp.sig.join(", ")}`;
  return `${indent}def ${op}(${sig}) -> ${ret}:\n${tag}${indent}    return self._c._call(${JSON.stringify(m.name)}, _omit_none({${mp.dict.join(", ")}}))`;
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

  // result schema 由来の TypedDict を収集 (メソッド emit の副作用で登録される)。
  // 登録順 = namespace ソート → root の決定的順で drift gate と一致する。
  const classes = new Map();

  const nsClasses = [];
  const nsAttrs = [];
  for (const [ns, methods] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (ns === "") continue;
    const cls = `_${ns.charAt(0).toUpperCase()}${ns.slice(1)}`;
    nsClasses.push(`class ${cls}:\n    def __init__(self, c: "SesameClient") -> None:\n        self._c = c\n\n${methods.map((m) => emitMethod(m, "    ", classes)).join("\n\n")}`);
    nsAttrs.push(`        self.${ns} = ${cls}(self)`);
  }
  // ルート直下メソッド (status 等) は SesameClient のメソッドとして出す。
  const rootMethods = (groups.get("") || []).map((m) => {
    const mp = methodParams(m.params);
    const tag = m["x-stability"] === "experimental" ? `        """@experimental (${m["x-provenance"]})."""\n` : "";
    const ret = methodReturnType(m.result?.schema, m.name, classes);
    const op = pyIdentifier(m.op);
    if (mp.generic) return `    def ${op}(self, **params: Any) -> ${ret}:\n${tag}        return self._call(${JSON.stringify(m.name)}, params)`;
    return `    def ${op}(self, *, ${mp.sig.join(", ")}) -> ${ret}:\n${tag}        return self._call(${JSON.stringify(m.name)}, _omit_none({${mp.dict.join(", ")}}))`;
  }).join("\n\n");

  const typedDicts = emitTypedDicts(classes);
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
import urllib.error
import urllib.request
from urllib.parse import quote
from typing import TYPE_CHECKING, Any, Callable, Literal, TypedDict  # noqa: F401  (Literal used by generated enums)

if TYPE_CHECKING:  # NotRequired は 3.11+ だが __future__ annotations で注釈は文字列化され 3.10 でも安全。
    from typing import NotRequired  # noqa: F401

API_VERSION = ${JSON.stringify(spec.info["x-apiVersion"])}

# Subscribable event topics (event.ready and other broadcast notifications excluded).
SesameEventTopic = ${topicType}


class SesameRpcError(Exception):
    def __init__(self, message: str, code: int | None, data: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.data = data if isinstance(data, dict) else {}
        kind = self.data.get("kind")
        self.kind = kind if isinstance(kind, str) else None
        retryable = self.data.get("retryable")
        self.retryable = retryable if isinstance(retryable, bool) else None


# HTTP status → machine-readable error kind (matches src/serve/jsonrpc.js KIND taxonomy and
# docs/en/integration.md). Used only when an HTTP-level failure has no JSON-RPC error body.
# Shared by all four client implementations (sdk/ts, sdk/python, clients/js, clients/python).
# Canonical table: REFACTORING_PLAN.md P4-5/SURF-10, pinned by tests/fixtures/http-kind-map.json.
#   400/413/415 → bad_params · 401/403 → not_authenticated · 404 → not_implemented
#   408/429/5xx → connection_lost (retryable) · anything else → internal (not retryable)
_HTTP_STATUS_KIND = {
    400: "bad_params",
    401: "not_authenticated",
    403: "not_authenticated",
    404: "not_implemented",
    408: "connection_lost",
    413: "bad_params",
    415: "bad_params",
    429: "connection_lost",
}


def _http_error_kind(status: int) -> str:
    if status >= 500:  # all 5xx are transient from the client's view
        return "connection_lost"
    return _HTTP_STATUS_KIND.get(status, "internal")


def _raise_http_error(e: "urllib.error.HTTPError") -> "SesameRpcError":
    """Translate a urllib HTTPError into a typed SesameRpcError.

    The \`sesame serve\` daemon answers JSON-RPC faults with HTTP 200 + an \`error\` body, but
    transport-level rejections (auth, oversized body, unknown route) come back as real HTTP
    status codes with a plain \`{"error","hint"}\` body — or no parseable body at all. Either
    way the consumer gets a SesameRpcError carrying \`.kind\`/\`.retryable\`/\`.code\`.
    """
    raw = b""
    try:
        raw = e.read() or b""
    except Exception:  # noqa: BLE001  (body already consumed / connection torn down)
        raw = b""
    body: Any = None
    if raw:
        try:
            body = json.loads(raw)
        except (ValueError, TypeError):
            body = None
    # A genuine JSON-RPC error body can ride on a non-200 status — honor it verbatim.
    if isinstance(body, dict) and isinstance(body.get("error"), dict):
        err = body["error"]
        return SesameRpcError(err.get("message", "error"), err.get("code", -32000), err.get("data"))
    status = e.code
    kind = _http_error_kind(status)
    retryable = kind == "connection_lost"  # 408/429/5xx are transient; other 4xx are caller errors
    hint = ""
    detail = ""
    if isinstance(body, dict):
        if isinstance(body.get("error"), str):
            detail = body["error"]
        if isinstance(body.get("hint"), str):
            hint = body["hint"]
    message = f"HTTP {status}"
    if detail:
        message += f": {detail}"
    if hint:
        message += f" ({hint})"
    return SesameRpcError(message, None, {"kind": kind, "retryable": retryable, "httpStatus": status})


def _raise_url_error(e: "urllib.error.URLError") -> "SesameRpcError":
    """Translate a connection-level failure (refused / DNS / reset) into a typed error."""
    reason = getattr(e, "reason", e)
    return SesameRpcError(
        f"connection failed: {reason}", None, {"kind": "connection_lost", "retryable": True},
    )


def _omit_none(d: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in d.items() if v is not None}


# Result shapes (TypedDict) for stable methods — derived from the traced response shapes in
# src/serve/result-schemas.js. Fields whose interior shape isn't pinned stay Any / dict[str, Any].
${typedDicts}


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
        try:
            with urllib.request.urlopen(req) as resp:
                msg = json.loads(resp.read())
        except urllib.error.HTTPError as e:  # 401/413/404/... — transport-level reject
            raise _raise_http_error(e) from None
        except urllib.error.URLError as e:  # connection refused / DNS / reset
            raise _raise_url_error(e) from None
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
        try:
            resp = urllib.request.urlopen(req)
        except urllib.error.HTTPError as e:  # 401 (bad token) / 400 (unknown topics)
            raise _raise_http_error(e) from None
        except urllib.error.URLError as e:  # daemon down / connection reset
            raise _raise_url_error(e) from None
        with resp:
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
