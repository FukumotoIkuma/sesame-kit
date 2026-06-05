// gRPC フレーミング: **型付き**。op ごとに型付き Request message + 型付き service メソッドを
// 生成 (scripts/gen-grpc-proto.mjs)。利用者は `LockUnlock({name})` のように型付きで呼べる。
//   - request: scalar/string配列は protobuf 型、object/動的な葉は JSON 文字列 field (glue が parse)
//   - response: 動的なので JsonRpc{json} で運ぶ (1 回 JSON.parse)
//   - Subscribe: topics 購読 → Event{topic, json} stream
//   - Invoke: 後方互換の汎用 JSON-RPC 経路
// loopback token を metadata (authorization: Bearer) か SubReq.token で要求。

import { readFileSync } from "node:fs";
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tokenMatches } from "./token.js";
import { RpcError } from "../jsonrpc.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = resolve(HERE, "..", "sesame.proto");
const MAP_PATH = resolve(HERE, "..", "grpc-methods.generated.json");

/** server streaming で非 OK status を返す。grpc-js (1.14) では `call.destroy()` は status を
 *  クライアントに伝えず黙ってハングするため、`emit("error", {code, details})` で返す (実測で確認)。 */
function endStreamWithError(call, code, message) {
  call.emit("error", { code, details: message });
}

/** RpcError.kind → gRPC status (gRPC の作法に沿って status でエラーを返す)。 */
function grpcStatusFor(kind) {
  switch (kind) {
    case "not_authenticated": return grpc.status.UNAUTHENTICATED;
    case "bad_params": return grpc.status.INVALID_ARGUMENT;
    case "not_implemented": return grpc.status.UNIMPLEMENTED;
    case "connection_lost":
    case "timeout": return grpc.status.UNAVAILABLE;
    default: return grpc.status.INTERNAL;
  }
}

function metaToken(call) {
  const md = call.metadata?.get?.("authorization");
  const raw = md && md[0] ? String(md[0]) : "";
  return /^Bearer\s+(.+)$/i.exec(raw)?.[1] || "";
}

/**
 * @param {import("../daemon.js").Daemon} daemon
 * @param {{ bind?:string, port:number, token:string }} opts
 * @returns {Promise<{ port:number, stop:()=>Promise<void> }>}
 */
export async function startGrpcFraming(daemon, { bind = "127.0.0.1", port, token }) {
  const pkgDef = protoLoader.loadSync(PROTO_PATH, { keepCase: true, longs: String, defaults: true });
  const proto = grpc.loadPackageDefinition(pkgDef).sesame;
  const methodMap = JSON.parse(readFileSync(MAP_PATH, "utf8")); // Pascal → {method, jsonFields}
  const server = new grpc.Server();

  const impl = {};

  // 型付き unary メソッドを一括登録 (handler は generic に daemon.invoke へ委譲)。
  for (const [pascal, { method, jsonFields }] of Object.entries(methodMap)) {
    impl[pascal] = async (call, callback) => {
      if (!tokenMatches(metaToken(call), token)) return callback({ code: grpc.status.UNAUTHENTICATED, message: "unauthorized" });
      const params = { ...call.request };
      for (const f of jsonFields) {
        if (params[f] === undefined || params[f] === "") { delete params[f]; continue; } // 空=未指定
        try { params[f] = JSON.parse(params[f]); } catch { return callback({ code: grpc.status.INVALID_ARGUMENT, message: `field "${f}" must be JSON` }); }
      }
      const conn = { id: "grpc", ephemeral: true, send() {}, close() {} };
      daemon.addConnection(conn);
      try {
        const result = await daemon.invoke(method, params, conn);
        callback(null, { json: JSON.stringify(result ?? null) });
      } catch (e) {
        const kind = e instanceof RpcError ? e.kind : "internal";
        const md = new grpc.Metadata(); if (kind) md.set("kind", kind);
        callback({ code: grpcStatusFor(kind), message: e?.message || "error", metadata: md });
      } finally {
        daemon.removeConnection(conn);
      }
    };
  }

  // 後方互換: 任意の JSON-RPC を文字列で運ぶ。
  impl.Invoke = async (call, callback) => {
    if (!tokenMatches(metaToken(call), token)) return callback({ code: grpc.status.UNAUTHENTICATED, message: "unauthorized" });
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
    if (!tokenMatches(provided, token)) { endStreamWithError(call, grpc.status.UNAUTHENTICATED, "unauthorized"); return; }
    let buffered = 0;
    const MAX_BUFFERED = 4 * 1024 * 1024;
    call.on("drain", () => { buffered = 0; });
    const conn = {
      id: "grpc-sub",
      send: (obj) => {
        const topic = String(obj.method || "").replace(/^event\./, "");
        const json = JSON.stringify(obj.params ?? null);
        try { const ok = call.write({ topic, json }); if (!ok) { buffered += json.length; if (buffered > MAX_BUFFERED) conn.close(); } }
        catch { /* closed */ }
      },
      close: () => { try { call.end(); } catch { /* ignore */ } },
    };
    daemon.addConnection(conn);
    const topics = (call.request.topics || []).filter(Boolean);
    // 不正 topic は黙殺せず INVALID_ARGUMENT でストリームを閉じる (WS/SSE と同じく拒否。
    // 黙ってハングするストリームを返すと『gRPC だけイベントが来ない』のデバッグが不能になる)。
    // daemon.subscribe 自体は検証しないので、ここで daemon.topics に対して明示検証する。
    const bad = topics.filter((t) => !daemon.topics.includes(t));
    if (bad.length) {
      daemon.removeConnection(conn);
      endStreamWithError(call, grpc.status.INVALID_ARGUMENT, `unknown topic(s): ${bad.join(",")}`);
      return;
    }
    if (topics.length) daemon.subscribe(conn, topics);
    call.on("cancelled", () => daemon.removeConnection(conn));
    call.on("close", () => daemon.removeConnection(conn));
  };

  server.addService(proto.Sesame.service, impl);

  const boundPort = await new Promise((resolve2, reject) => {
    server.bindAsync(`${bind}:${port}`, grpc.ServerCredentials.createInsecure(), (err, p) => {
      if (err) reject(err); else resolve2(p);
    });
  });
  return {
    port: boundPort,
    // tryShutdown は Subscribe ストリームが開いている限り待ち続けるため、まず graceful を試み、
    // 1s で畳めなければ forceShutdown で全 call を即キャンセルしてハングを断つ。
    stop: () => new Promise((resolve2) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve2(); } };
      const t = setTimeout(() => { try { server.forceShutdown(); } catch { /* ignore */ } finish(); }, 1000);
      t.unref?.();
      server.tryShutdown(() => { clearTimeout(t); finish(); });
    }),
  };
}
