// gRPC フレーミング: **型付き**。op ごとに型付き Request message + 型付き service メソッドを
// 生成 (scripts/gen-grpc-proto.mjs)。利用者は `LockUnlock({name})` のように型付きで呼べる。
//   - request: scalar/string配列は protobuf 型、object/動的な葉は JSON 文字列 field (glue が parse)
//   - response: 動的なので JsonRpc{json} で運ぶ (1 回 JSON.parse)
//   - Subscribe: topics 購読 → Event{topic, json} stream
//   - Invoke: 後方互換の汎用 JSON-RPC 経路
// loopback token を metadata (authorization: Bearer) か SubReq.token で要求。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tokenMatches, parseBearer } from "./token.js";
import { errorFromThrow } from "../jsonrpc.js";
import { t } from "../../i18n.js";
// @grpc/grpc-js / @grpc/proto-loader は optional peerDependencies (REFACTORING_PLAN P5-1):
// ライブラリ利用者に gRPC スタックを強制しないため、トップレベル import せず
// startGrpcFraming() 内で遅延 import する。未導入時は importOptional が
// 「npm i @grpc/grpc-js @grpc/proto-loader で --grpc が使える」案内エラーを投げる。
import { importOptional } from "../../optional-deps.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = resolve(HERE, "..", "sesame.proto");
const MAP_PATH = resolve(HERE, "..", "grpc-methods.generated.json");

/**
 * proto-loader が動的生成する gRPC call の、本ファイルが触る面だけの最小型。
 * proto から生成される具体型は静的に分からないため、ここで構造的に定義する。
 * @typedef {object} GrpcCall
 * @property {Record<string, any>} request デコード済みリクエスト message
 * @property {{ get?: (k: string) => unknown[] }} [metadata]
 * @property {(event: string, payload?: unknown) => void} emit
 * @property {(event: string, cb: (...args: any[]) => void) => void} on
 * @property {(chunk: { topic: string, json: string }) => boolean} write
 * @property {() => void} end
 */

/**
 * unary handler の callback (err-first)。
 * @typedef {(err: (import("@grpc/grpc-js").ServiceError | Partial<import("@grpc/grpc-js").ServiceError>) | null, value?: { json: string }) => void} GrpcUnaryCallback
 */

/** server streaming で非 OK status を返す。grpc-js (1.14) では `call.destroy()` は status を
 *  クライアントに伝えず黙ってハングするため、`emit("error", {code, details})` で返す (実測で確認)。
 * @param {GrpcCall} call
 * @param {number} code
 * @param {string} message
 */
function endStreamWithError(call, code, message) {
  call.emit("error", { code, details: message });
}

/**
 * @param {GrpcCall} call
 * @returns {string}
 */
function metaToken(call) {
  const md = call.metadata?.get?.("authorization");
  const raw = md && md[0] ? String(md[0]) : "";
  // Bearer 解析は token.js の parseBearer に一本化 (REFACTORING_PLAN P1-17)。
  // 旧 `/^Bearer\s+(.+)$/i` は token.js が ReDoS を実測して廃止した禁止パターンの再実装だった。
  return parseBearer(raw) ?? "";
}

/**
 * @param {import("../daemon.js").Daemon} daemon
 * @param {{ bind?:string, port:number, token:string }} opts
 * @returns {Promise<{ port:number, stop:()=>Promise<void> }>}
 */
export async function startGrpcFraming(daemon, { bind = "127.0.0.1", port, token }) {
  // optional peerDependencies の遅延 import (P5-1)。未導入なら importOptional が
  // i18n 済みの導入案内エラー (serve.grpc.missingDeps) を投げ、--grpc 以外の経路は影響を受けない。
  const missingHint = t("serve.grpc.missingDeps");
  const grpc = /** @type {typeof import("@grpc/grpc-js")} */ (
    (await importOptional("@grpc/grpc-js", missingHint)).default
  );
  const protoLoader = /** @type {typeof import("@grpc/proto-loader")} */ (
    (await importOptional("@grpc/proto-loader", missingHint)).default
  );

  /** RpcError.kind → gRPC status (gRPC の作法に沿って status でエラーを返す)。
   * grpc が遅延 import になったため module スコープから本関数スコープへ移動 (P5-1)。
   * @param {string} kind
   * @returns {number}
   */
  const grpcStatusFor = (kind) => {
    switch (kind) {
      case "not_authenticated": return grpc.status.UNAUTHENTICATED;
      case "bad_params": return grpc.status.INVALID_ARGUMENT;
      case "not_implemented": return grpc.status.UNIMPLEMENTED;
      case "connection_lost":
      case "timeout": return grpc.status.UNAVAILABLE;
      case "rejected": return grpc.status.FAILED_PRECONDITION; // 上流が明示的に拒否 (server bug ではない)
      default: return grpc.status.INTERNAL;
    }
  };

  const pkgDef = protoLoader.loadSync(PROTO_PATH, { keepCase: true, longs: String, defaults: true });
  // loadPackageDefinition は GrpcObject を返すが各ノードの具体型は動的なので Record で受ける。
  const proto = /** @type {Record<string, any>} */ (grpc.loadPackageDefinition(pkgDef)).sesame;
  /** @type {Record<string, { method: string, jsonFields: string[] }>} */
  const methodMap = JSON.parse(readFileSync(MAP_PATH, "utf8")); // Pascal → {method, jsonFields}
  const server = new grpc.Server();

  // handler は構造的 GrpcCall で型付けする (proto 生成の具体 call 型は静的に分からない)。
  // grpc-js は実行時に call 形を解決するため、addService 時に UntypedServiceImplementation へ橋渡しする。
  /** @type {Record<string, (call: GrpcCall, callback: GrpcUnaryCallback) => unknown>} */
  const impl = {};

  // 型付き unary メソッドを一括登録 (handler は generic に daemon.invoke へ委譲)。
  for (const [pascal, { method, jsonFields }] of Object.entries(methodMap)) {
    impl[pascal] = async (call, callback) => {
      if (!tokenMatches(metaToken(call), token)) return callback({ code: grpc.status.UNAUTHENTICATED, message: t("serve.grpc.unauthorized") });
      const params = { ...call.request };
      for (const f of jsonFields) {
        if (params[f] === undefined || params[f] === "") { delete params[f]; continue; } // 空=未指定
        try { params[f] = JSON.parse(params[f]); } catch { return callback({ code: grpc.status.INVALID_ARGUMENT, message: t("serve.grpc.fieldMustBeJson", { f }) }); }
      }
      /** @type {import("../daemon.js").Connection} */
      const conn = { id: "grpc", ephemeral: true, send() {}, close() {} };
      daemon.addConnection(conn);
      try {
        const result = await daemon.invoke(method, params, conn);
        callback(null, { json: JSON.stringify(result ?? null) });
      } catch (e) {
        // HTTP/WS/stdio と同じ単一写像 (errorFromThrow) を通す。これにより SesameError も
        // 正しい kind になり、gRPC だけ internal に潰れる穴を防ぐ。
        const norm = errorFromThrow(null, e).error;
        const kind = String(norm.data?.kind || "internal");
        const md = new grpc.Metadata();
        md.set("kind", kind);
        if (typeof norm.data?.retryable === "boolean") md.set("retryable", String(norm.data.retryable));
        callback({ code: grpcStatusFor(kind), message: norm.message || "error", metadata: md });
      } finally {
        daemon.removeConnection(conn);
      }
    };
  }

  // 後方互換: 任意の JSON-RPC を文字列で運ぶ。
  impl.Invoke = async (call, callback) => {
    if (!tokenMatches(metaToken(call), token)) return callback({ code: grpc.status.UNAUTHENTICATED, message: t("serve.grpc.unauthorized") });
    /** @type {import("../daemon.js").Connection} */
    const conn = { id: "grpc", ephemeral: true, send() {}, close() {} };
    daemon.addConnection(conn);
    let out;
    try { out = await daemon.dispatchMessage(conn, call.request.json || ""); }
    finally { daemon.removeConnection(conn); }
    callback(null, { json: out === null ? "" : JSON.stringify(out) });
  };

  // イベント購読ストリーム。
  impl.Subscribe = (call) => {
    const provided = call.request.token || metaToken(call);
    if (!tokenMatches(provided, token)) { endStreamWithError(call, grpc.status.UNAUTHENTICATED, t("serve.grpc.unauthorized")); return; }
    let buffered = 0;
    const MAX_BUFFERED = 4 * 1024 * 1024;
    call.on("drain", () => { buffered = 0; });
    /** @type {import("../daemon.js").Connection} */
    const conn = {
      id: "grpc-sub",
      /** @param {unknown} obj */
      send: (obj) => {
        const ev = /** @type {{ method?: unknown, params?: unknown }} */ (obj);
        const topic = String(ev.method || "").replace(/^event\./, "");
        const json = JSON.stringify(ev.params ?? null);
        try { const ok = call.write({ topic, json }); if (!ok) { buffered += json.length; if (buffered > MAX_BUFFERED) conn.close(); } }
        catch { /* closed */ }
      },
      close: () => { try { call.end(); } catch { /* ignore */ } },
    };
    /** @type {string[]} */
    const topics = (call.request.topics || []).filter(Boolean);
    // 不正 topic は黙殺せず INVALID_ARGUMENT でストリームを閉じる (WS/SSE と同じく拒否。
    // 黙ってハングするストリームを返すと『gRPC だけイベントが来ない』のデバッグが不能になる)。
    // daemon.subscribe 自体は検証しないので、ここで daemon.topics に対して明示検証する。
    // addConnection の前に検証する: 通すと addConnection が event.ready を 1 本流してしまう。
    const bad = topics.filter((t) => !daemon.topics.includes(t));
    if (bad.length) {
      endStreamWithError(call, grpc.status.INVALID_ARGUMENT, t("serve.grpc.unknownTopics", { topics: bad.join(",") }));
      return;
    }
    daemon.addConnection(conn); // ここで event.ready が 1 本流れる
    if (topics.length) daemon.subscribe(conn, topics);
    call.on("cancelled", () => daemon.removeConnection(conn));
    call.on("close", () => daemon.removeConnection(conn));
  };

  // proto.Sesame.service と impl はどちらも proto-loader 由来の動的サーフェス。構造的に
  // 型付けした impl を grpc-js の UntypedServiceImplementation へ橋渡しする (実行時に call 形を解決)。
  server.addService(
    proto.Sesame.service,
    /** @type {import("@grpc/grpc-js").UntypedServiceImplementation} */ (/** @type {unknown} */ (impl)),
  );

  const boundPort = await /** @type {Promise<number>} */ (new Promise((resolve2, reject) => {
    server.bindAsync(`${bind}:${port}`, grpc.ServerCredentials.createInsecure(), (err, p) => {
      if (err) reject(err); else resolve2(p);
    });
  }));
  return {
    port: boundPort,
    // tryShutdown は Subscribe ストリームが開いている限り待ち続けるため、まず graceful を試み、
    // 1s で畳めなければ forceShutdown で全 call を即キャンセルしてハングを断つ。
    stop: () => /** @type {Promise<void>} */ (new Promise((resolve2) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve2(); } };
      const t = setTimeout(() => { try { server.forceShutdown(); } catch { /* ignore */ } finish(); }, 1000);
      t.unref?.();
      server.tryShutdown(() => { clearTimeout(t); finish(); });
    })),
  };
}
