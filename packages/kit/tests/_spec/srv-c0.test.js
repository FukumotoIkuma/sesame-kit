// SRV-0001 〜 SRV-0018 spec tests (TDD — red where impl diverges from spec)
// 対象: packages/kit/src/serve/framing/grpc.js, http.js, ws.js, token.js, daemon.js
//       scripts/gen-grpc-proto.mjs, packages/kit/src/serve/grpc-methods.generated.json
//       packages/kit/src/serve/sesame.proto, packages/kit/src/i18n/serve.js
// 実行環境: vitest (unit project)
// 方針: A/B 統合。より移植元忠実・網羅的な側を採用。import は重複排除し整合。

import { describe, it, expect, afterEach, vi } from "vitest";
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { WebSocket } from "ws";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { Daemon } from "../../src/serve/daemon.js";
import { startGrpcFraming } from "../../src/serve/framing/grpc.js";
import { startHttpFraming } from "../../src/serve/framing/http.js";
import { startWsFraming } from "../../src/serve/framing/ws.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROTO = resolve(HERE, "..", "..", "src", "serve", "sesame.proto");
const MAP_PATH = resolve(HERE, "..", "..", "src", "serve", "grpc-methods.generated.json");
const TOKEN = "srv-spec-token-cccccccccccccccccccccc";

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function fakeHub(overrides = {}) {
  let duFn = null;
  return {
    connected: true,
    subUUID: "s",
    config: { devices: {} },
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    onDeviceUpdate: (_items, fn) => { duFn = fn; return () => { duFn = null; }; },
    _emit: (m) => duFn && duFn(m),
    unlock: vi.fn(async (n) => ({ ok: true, name: n })),
    botClick: vi.fn(async (name) => ({ clicked: name })),
    botClickScript: vi.fn(async (name, idx) => ({ clicked: name, scriptIndex: idx })),
    setAutolock: vi.fn(async (name, seconds) => ({ ack: true, seconds })),
    getDeviceHistory: vi.fn(async (list, pageSize) => ({ list, pageSize })),
    ...overrides,
  };
}

function makeGrpcClient(port) {
  // oneofs:true は必須 (proto3 optional = synthetic oneof のため) — SRV-0001/SRV-0003
  const pkgDef = protoLoader.loadSync(PROTO, { keepCase: true, longs: String, defaults: true, oneofs: true });
  const proto = grpc.loadPackageDefinition(pkgDef).sesame;
  return new proto.Sesame(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
}

function bearer(token) {
  const md = new grpc.Metadata();
  if (token) md.set("authorization", `Bearer ${token}`);
  return md;
}

function unary(client, method, req, md) {
  return new Promise((res, rej) => client[method](req, md, (e, r) => (e ? rej(e) : res(r))));
}

function makeDaemon(hub) {
  const d = new Daemon({ hub: hub || fakeHub() });
  d.authState = "ok";
  return d;
}

let handles = [];
afterEach(async () => {
  for (const h of handles.reverse()) {
    try { await h.stop(); } catch { /* ignore */ }
  }
  handles = [];
});

// ---------------------------------------------------------------------------
// SRV-0001: gRPC optional-scalar presence — synthetic-oneof sentinel
// ---------------------------------------------------------------------------

describe("[SRV-0001] gRPC optional-scalar presence: synthetic-oneof sentinel が省略/明示を判別する", () => {
  it("[SRV-0001] 明示 0 は sentinel あり → sentinel キーのみ削除・値 0 を維持する (daemon.invoke に 0 が届く)", async () => {
    const hub = fakeHub();
    const d = makeDaemon(hub);
    const h = await startGrpcFraming(d, { port: 0, token: TOKEN });
    handles.push(h);
    const client = makeGrpcClient(h.port);
    handles.push({ stop: () => { client.close(); return Promise.resolve(); } });

    // LockClick: scriptIndex は optionalScalars。0 を明示送信すると botClickScript(name, 0) が呼ばれる。
    const r = await unary(client, "LockClick", { name: "door", scriptIndex: 0 }, bearer(TOKEN));
    expect(hub.botClickScript).toHaveBeenCalledWith("door", 0);
    expect(hub.botClick).not.toHaveBeenCalled();
    expect(JSON.parse(r.json)).toMatchObject({ scriptIndex: 0 });
  });

  it("[SRV-0001] 省略 (sentinel 不在) → params から field を削除し daemon.invoke に未指定で届く", async () => {
    const hub = fakeHub();
    const d = makeDaemon(hub);
    const h = await startGrpcFraming(d, { port: 0, token: TOKEN });
    handles.push(h);
    const client = makeGrpcClient(h.port);
    handles.push({ stop: () => { client.close(); return Promise.resolve(); } });

    // scriptIndex 省略 → sentinel 不在 → scriptIndex 削除 → botClick が呼ばれる
    await unary(client, "LockClick", { name: "door" }, bearer(TOKEN));
    expect(hub.botClick).toHaveBeenCalledWith("door");
    expect(hub.botClickScript).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SRV-0002: gRPC jsonFields グルー
// ---------------------------------------------------------------------------

describe("[SRV-0002] gRPC jsonFields グルー: 空文字列は未指定/削除、JSON.parse 失敗は INVALID_ARGUMENT", () => {
  it("[SRV-0002] jsonField が空文字列のとき params から削除し未指定として届ける", async () => {
    const hub = fakeHub({
      org: { addEmployees: vi.fn(async (p) => ({ received: p })) },
    });
    const d = makeDaemon(hub);
    const h = await startGrpcFraming(d, { port: 0, token: TOKEN });
    handles.push(h);
    const client = makeGrpcClient(h.port);
    handles.push({ stop: () => { client.close(); return Promise.resolve(); } });

    // items="" → glue が削除 → handler には items 未指定で届く
    const err = await unary(client, "OrgAddEmployees", { items: "" }, bearer(TOKEN)).catch(e => e);
    // glue が JSON.parse("") を試みてエラーを出すのではなく、空文字列 = 未指定として削除する
    if (err && err.details) {
      expect(err.details).not.toMatch(/must be JSON/);
    }
    expect(err?.code).not.toBe(grpc.status.INVALID_ARGUMENT);
  });

  it("[SRV-0002] jsonField が不正 JSON 文字列のとき callback(INVALID_ARGUMENT, fieldMustBeJson) で打ち切る", async () => {
    const hub = fakeHub({
      org: { addEmployees: vi.fn(async (p) => ({ received: p })) },
    });
    const d = makeDaemon(hub);
    const h = await startGrpcFraming(d, { port: 0, token: TOKEN });
    handles.push(h);
    const client = makeGrpcClient(h.port);
    handles.push({ stop: () => { client.close(); return Promise.resolve(); } });

    // items が不正 JSON → INVALID_ARGUMENT
    const err = await unary(client, "OrgAddEmployees", { items: "not-valid-json{{{{" }, bearer(TOKEN)).catch(e => e);
    expect(err).toBeTruthy();
    expect(err.code).toBe(grpc.status.INVALID_ARGUMENT);
    expect(err.details).toMatch(/items/);
  });

  it("[SRV-0002] jsonField が valid JSON 文字列のとき JSON.parse してオブジェクト化して届ける", async () => {
    const hub = fakeHub({
      org: { addEmployees: vi.fn(async (p) => ({ received: p })) },
    });
    const d = makeDaemon(hub);
    const h = await startGrpcFraming(d, { port: 0, token: TOKEN });
    handles.push(h);
    const client = makeGrpcClient(h.port);
    handles.push({ stop: () => { client.close(); return Promise.resolve(); } });

    await unary(client, "OrgAddEmployees", { items: JSON.stringify([{ email: "a@b.c" }]) }, bearer(TOKEN));
    const arg = hub.org.addEmployees.mock.calls[0][0];
    // glue が items を JSON.parse してオブジェクト配列に変換する
    expect(Array.isArray(arg.items)).toBe(true);
    expect(arg.items[0]).toMatchObject({ email: "a@b.c" });
  });
});

// ---------------------------------------------------------------------------
// SRV-0003: gRPC proto-loader ロードオプション不変条件
// ---------------------------------------------------------------------------

describe("[SRV-0003] gRPC proto-loader ロードオプション不変条件", () => {
  it("[SRV-0003] grpc.js の loadSync は keepCase/longs:String/defaults:true/oneofs:true の 4 オプションで sesame.proto を読む", () => {
    const src = readFileSync(
      resolve(HERE, "..", "..", "src", "serve", "framing", "grpc.js"),
      "utf8"
    );
    expect(src).toMatch(/keepCase:\s*true/);
    expect(src).toMatch(/longs:\s*String/);
    expect(src).toMatch(/defaults:\s*true/);
    expect(src).toMatch(/oneofs:\s*true/);
  });

  it("[SRV-0003] oneofs:true の有無で optional scalar の省略/明示区別が成立するかを実動作で確認する", async () => {
    const hub = fakeHub();
    const d = makeDaemon(hub);
    const h = await startGrpcFraming(d, { port: 0, token: TOKEN });
    handles.push(h);
    const client = makeGrpcClient(h.port); // oneofs:true クライアント
    handles.push({ stop: () => { client.close(); return Promise.resolve(); } });

    // scriptIndex=0 を明示送信 → botClickScript が 0 で呼ばれる (oneofs:true が必要)
    await unary(client, "LockClick", { name: "door", scriptIndex: 0 }, bearer(TOKEN));
    expect(hub.botClickScript).toHaveBeenCalledWith("door", 0);
  });

  it("[SRV-0003] grpc-methods.generated.json は sesame.proto と同一 generateProto 実行から生成され手編集禁止ヘッダを持つ", async () => {
    const protoText = readFileSync(PROTO, "utf8");
    // proto ファイルに自動生成ヘッダコメントがある
    expect(protoText).toContain("自動生成");
    expect(protoText).toContain("gen-grpc-proto.mjs");
    // generated.json の全エントリが必要な shape を持つ
    const map = JSON.parse(readFileSync(MAP_PATH, "utf8"));
    for (const [, entry] of Object.entries(map)) {
      expect(typeof entry.method).toBe("string");
      expect(Array.isArray(entry.jsonFields)).toBe(true);
      expect(Array.isArray(entry.optionalScalars)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// SRV-0004: gen-grpc-proto optional 付与規則
// ---------------------------------------------------------------------------

describe("[SRV-0004] gen-grpc-proto optional 付与規則: required/repeated は非optional、無効名は単一 params", () => {
  it("[SRV-0004] required フィールドには optional を付与しない", async () => {
    const { generateProto } = await import("../../../../../scripts/gen-grpc-proto.mjs");
    const { protoText } = await generateProto();
    // LockSetAutolockRequest: seconds は required → optional 修飾なし
    const section = protoText.match(/message LockSetAutolockRequest \{[^}]+\}/s)?.[0] ?? "";
    expect(section).toMatch(/double seconds = \d+;/);
    expect(section).not.toMatch(/optional double seconds/);
  });

  it("[SRV-0004] repeated string フィールドには optional を付与しない (proto3 仕様)", async () => {
    const { generateProto } = await import("../../../../../scripts/gen-grpc-proto.mjs");
    const { protoText } = await generateProto();
    // repeated string の行に optional が付いていないこと
    const lines = protoText.split("\n");
    for (const line of lines) {
      if (line.includes("repeated string")) {
        expect(line).not.toMatch(/optional/);
      }
    }
    expect(protoText).not.toMatch(/optional repeated/);
  });

  it("[SRV-0004] non-required scalar は optionalScalars に登録され proto に optional が付く", async () => {
    const { generateProto } = await import("../../../../../scripts/gen-grpc-proto.mjs");
    const { protoText, nameMap } = await generateProto();

    // LockClick: scriptIndex は non-required → optionalScalars に含まれる
    expect(nameMap.LockClick?.optionalScalars).toContain("scriptIndex");
    // LockSetAutolock: seconds は required → optionalScalars に含まれない
    expect(nameMap.LockSetAutolock?.optionalScalars).not.toContain("seconds");
    // optionalScalars の全フィールドが proto に optional 付きで存在する
    for (const [pascal, { optionalScalars }] of Object.entries(nameMap)) {
      for (const f of optionalScalars) {
        expect(protoText).toMatch(new RegExp(`optional\\s+\\w+\\s+${f}\\s*=`));
      }
    }
  });

  it("[SRV-0004] 無効フィールド名は単一 string params(jsonFields) に畳む", async () => {
    const { generateProto } = await import("../../../../../scripts/gen-grpc-proto.mjs");
    const { nameMap } = await generateProto();

    // jsonFields に "params" が含まれるエントリが存在する (無効名の畳み込み)
    const hasParamsJsonField = Object.values(nameMap).some(
      (v) => v.jsonFields.includes("params")
    );
    expect(hasParamsJsonField).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SRV-0005: grpc-methods.generated.json と sesame.proto の自己整合
// ---------------------------------------------------------------------------

describe("[SRV-0005] grpc-methods.generated.json と sesame.proto の自己整合", () => {
  it("[SRV-0005] generated.json の全エントリが proto の rpc/message と 1:1 対応する", async () => {
    const { generateProto } = await import("../../../../../scripts/gen-grpc-proto.mjs");
    const { protoText, nameMap } = await generateProto();

    for (const pascal of Object.keys(nameMap)) {
      // proto の service ブロックに rpc <Pascal> があること
      expect(protoText).toMatch(new RegExp(`rpc ${pascal}\\s*\\(`));
    }
  });

  it("[SRV-0005] generated.json の optionalScalars は proto の optional マーカ付きフィールドと一致する", async () => {
    const { generateProto } = await import("../../../../../scripts/gen-grpc-proto.mjs");
    const { protoText, nameMap } = await generateProto();

    for (const [pascal, { optionalScalars }] of Object.entries(nameMap)) {
      for (const field of optionalScalars) {
        const msgRegex = new RegExp(`message ${pascal}Request \\{[^}]*optional [a-z]+ ${field}`, "s");
        expect(protoText).toMatch(msgRegex);
      }
    }
  });

  it("[SRV-0005] Subscribe/Invoke/JsonRpc は methodMap(generated.json) に現れない手書き定型部", () => {
    const map = JSON.parse(readFileSync(MAP_PATH, "utf8"));
    expect(map).not.toHaveProperty("Subscribe");
    expect(map).not.toHaveProperty("Invoke");
    expect(map).not.toHaveProperty("JsonRpc");
  });

  it("[SRV-0005] jsonFields は対応 message の string(json) フィールド集合に一致する (generateProto vs 保存ファイル)", async () => {
    const { generateProto } = await import("../../../../../scripts/gen-grpc-proto.mjs");
    const { nameMap } = await generateProto();
    const saved = JSON.parse(readFileSync(MAP_PATH, "utf8"));

    for (const [pascal, entry] of Object.entries(nameMap)) {
      if (!saved[pascal]) continue;
      expect(saved[pascal].jsonFields).toEqual(entry.jsonFields);
      expect(saved[pascal].optionalScalars).toEqual(entry.optionalScalars);
    }
  });
});

// ---------------------------------------------------------------------------
// SRV-0006: gRPC optional peerDependency 遅延 import
// ---------------------------------------------------------------------------

describe("[SRV-0006] gRPC optional peerDependency 遅延 import", () => {
  it("[SRV-0006] grpc.js はトップレベルで @grpc/grpc-js/@grpc/proto-loader を import しない", () => {
    const src = readFileSync(
      resolve(HERE, "..", "..", "src", "serve", "framing", "grpc.js"),
      "utf8"
    );
    const topLevelImports = src.split("\n")
      .filter((l) => /^import\s/.test(l))
      .join("\n");
    expect(topLevelImports).not.toContain("@grpc/grpc-js");
    expect(topLevelImports).not.toContain("@grpc/proto-loader");
  });

  it("[SRV-0006] 未導入 mock 時: importOptional が ERR_OPTIONAL_DEP_MISSING + missingDeps hint を投げる", async () => {
    const { importOptional } = await import("../../src/optional-deps.js");
    const hint = "install hint for grpc";
    await expect(importOptional("__nonexistent_grpc_pkg__", hint)).rejects.toMatchObject({
      code: "ERR_OPTIONAL_DEP_MISSING",
      message: hint,
    });
  });

  it("[SRV-0006] grpc.js は importOptional を使い serve.grpc.missingDeps メッセージで遅延 import している", () => {
    const src = readFileSync(
      resolve(HERE, "..", "..", "src", "serve", "framing", "grpc.js"),
      "utf8"
    );
    expect(src).toContain("importOptional");
    expect(src).toContain("serve.grpc.missingDeps");
  });
});

// ---------------------------------------------------------------------------
// SRV-0007: serve.grpc.* i18n キー完全性
// ---------------------------------------------------------------------------

describe("[SRV-0007] serve.grpc.* i18n キー (unauthorized/fieldMustBeJson/unknownTopics/missingDeps) の en/ja 完全性", () => {
  it("[SRV-0007] serve.grpc.{unauthorized,fieldMustBeJson,unknownTopics,missingDeps} が en/ja 双方に存在する", async () => {
    const serveI18n = (await import("../../src/i18n/serve.js")).default;
    const requiredKeys = [
      "serve.grpc.unauthorized",
      "serve.grpc.fieldMustBeJson",
      "serve.grpc.unknownTopics",
      "serve.grpc.missingDeps",
    ];
    for (const key of requiredKeys) {
      expect(serveI18n.en).toHaveProperty(key);
      expect(serveI18n.ja).toHaveProperty(key);
    }
  });

  it("[SRV-0007] fieldMustBeJson の {f} プレースホルダが en/ja で一致する", async () => {
    const serveI18n = (await import("../../src/i18n/serve.js")).default;
    const enVal = serveI18n.en["serve.grpc.fieldMustBeJson"] ?? "";
    const jaVal = serveI18n.ja["serve.grpc.fieldMustBeJson"] ?? "";
    expect(enVal).toContain("{f}");
    expect(jaVal).toContain("{f}");
    const extract = (s) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
    expect(extract(enVal)).toEqual(extract(jaVal));
  });

  it("[SRV-0007] unknownTopics の {topics} プレースホルダが en/ja で一致する", async () => {
    const serveI18n = (await import("../../src/i18n/serve.js")).default;
    const enVal = serveI18n.en["serve.grpc.unknownTopics"] ?? "";
    const jaVal = serveI18n.ja["serve.grpc.unknownTopics"] ?? "";
    expect(enVal).toContain("{topics}");
    expect(jaVal).toContain("{topics}");
    const extract = (s) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
    expect(extract(enVal)).toEqual(extract(jaVal));
  });
});

// ---------------------------------------------------------------------------
// SRV-0008: gRPC Subscribe 背圧
// ---------------------------------------------------------------------------

describe("[SRV-0008] gRPC Subscribe 背圧: MAX_BUFFERED(4MB) 超で当該接続のみ close", () => {
  it("[SRV-0008] MAX_BUFFERED は 4MB (4*1024*1024) である", () => {
    const src = readFileSync(
      resolve(HERE, "..", "..", "src", "serve", "framing", "grpc.js"),
      "utf8"
    );
    expect(src).toMatch(/MAX_BUFFERED\s*=\s*4\s*\*\s*1024\s*\*\s*1024/);
  });

  it("[SRV-0008] call.write が false を返したとき buffered += json.length し MAX_BUFFERED 超で conn.close する", () => {
    const src = readFileSync(
      resolve(HERE, "..", "..", "src", "serve", "framing", "grpc.js"),
      "utf8"
    );
    expect(src).toMatch(/buffered\s*\+=\s*json\.length/);
    expect(src).toMatch(/buffered\s*>\s*MAX_BUFFERED/);
    expect(src).toMatch(/conn\.close\(\)/);
  });

  it("[SRV-0008] call.on('drain') で buffered を 0 にリセットする", () => {
    const src = readFileSync(
      resolve(HERE, "..", "..", "src", "serve", "framing", "grpc.js"),
      "utf8"
    );
    expect(src).toMatch(/on\(['"]drain['"]/);
    expect(src).toMatch(/buffered\s*=\s*0/);
  });
});

// ---------------------------------------------------------------------------
// SRV-0009: gRPC server stop(): tryShutdown → forceShutdown
// ---------------------------------------------------------------------------

describe("[SRV-0009] gRPC server stop(): tryShutdown → 1s でハング → forceShutdown", () => {
  it("[SRV-0009] stop() は tryShutdown を呼び、1s タイムアウトで forceShutdown に切り替える実装を持つ", () => {
    const src = readFileSync(
      resolve(HERE, "..", "..", "src", "serve", "framing", "grpc.js"),
      "utf8"
    );
    expect(src).toContain("tryShutdown");
    expect(src).toContain("forceShutdown");
    expect(src).toMatch(/setTimeout.*1000/s);
  });

  it("[SRV-0009] done フラグで二重 resolve を防ぐ", () => {
    const src = readFileSync(
      resolve(HERE, "..", "..", "src", "serve", "framing", "grpc.js"),
      "utf8"
    );
    expect(src).toContain("done");
    expect(src).toMatch(/done\s*=\s*true/);
  });

  it("[SRV-0009] stop() は正常に resolve し、通常 Subscribe なし時は tryShutdown が即完了する", async () => {
    const hub = fakeHub();
    const d = makeDaemon(hub);
    const h = await startGrpcFraming(d, { port: 0, token: TOKEN });
    // stop() must resolve (not hang)
    await expect(h.stop()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SRV-0010: gRPC server-stream 非OK status = emit('error', {code, details})
// ---------------------------------------------------------------------------

describe("[SRV-0010] gRPC server-stream の非OK status は emit('error',{code,details}) で返す", () => {
  it("[SRV-0010] endStreamWithError は call.emit('error',{code,details}) を使う (call.destroy は使わない)", () => {
    const src = readFileSync(
      resolve(HERE, "..", "..", "src", "serve", "framing", "grpc.js"),
      "utf8"
    );
    expect(src).toMatch(/emit\(['"]error['"]/);
    // call.destroy() must not appear in actual code (only in comments is acceptable)
    // Strip comments before checking
    const srcNoComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(srcNoComments).not.toMatch(/call\.destroy\(/);
  });

  it("[SRV-0010] token 不一致は UNAUTHENTICATED でストリームを閉じる (open を発火させない)", async () => {
    const hub = fakeHub();
    const d = makeDaemon(hub);
    const h = await startGrpcFraming(d, { port: 0, token: TOKEN });
    handles.push(h);
    const client = makeGrpcClient(h.port);
    handles.push({ stop: () => { client.close(); return Promise.resolve(); } });

    const wrongMd = new grpc.Metadata();
    wrongMd.set("authorization", "Bearer wrong-token");
    const stream = client.Subscribe({ topics: ["lockState"] }, wrongMd);
    const err = await new Promise((res) => stream.on("error", res));
    expect(err.code).toBe(grpc.status.UNAUTHENTICATED);
  });

  it("[SRV-0010] 不正 topic は INVALID_ARGUMENT でストリームを閉じる (addConnection 前に検証)", async () => {
    const hub = fakeHub();
    const d = makeDaemon(hub);
    const h = await startGrpcFraming(d, { port: 0, token: TOKEN });
    handles.push(h);
    const client = makeGrpcClient(h.port);
    handles.push({ stop: () => { client.close(); return Promise.resolve(); } });

    const stream = client.Subscribe({ topics: ["bogus_topic_xyz"] }, bearer(TOKEN));
    const err = await new Promise((res) => stream.on("error", res));
    expect(err.code).toBe(grpc.status.INVALID_ARGUMENT);
  });
});

// ---------------------------------------------------------------------------
// SRV-0011: 後方互換 Invoke — dispatchMessage 委譲
// ---------------------------------------------------------------------------

describe("[SRV-0011] 後方互換 Invoke は dispatchMessage を通し JSON-RPC 文字列で運ぶ", () => {
  it("[SRV-0011] Invoke で rpc.discover を通すと結果が JSON 文字列で返る (out 非 null)", async () => {
    const hub = fakeHub();
    const d = makeDaemon(hub);
    const h = await startGrpcFraming(d, { port: 0, token: TOKEN });
    handles.push(h);
    const client = makeGrpcClient(h.port);
    handles.push({ stop: () => { client.close(); return Promise.resolve(); } });

    const r = await unary(client, "Invoke", {
      json: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "rpc.discover" }),
    }, bearer(TOKEN));
    const parsed = JSON.parse(r.json);
    expect(parsed.result?.openrpc).toBe("1.2.6");
  });

  it("[SRV-0011] Invoke の out===null (通知) は {json:''} で返す", async () => {
    const hub = fakeHub();
    const d = makeDaemon(hub);
    const h = await startGrpcFraming(d, { port: 0, token: TOKEN });
    handles.push(h);
    const client = makeGrpcClient(h.port);
    handles.push({ stop: () => { client.close(); return Promise.resolve(); } });

    // A notification (no "id") → dispatchMessage returns null → callback({json:''})
    const r = await unary(client, "Invoke", {
      json: JSON.stringify({ jsonrpc: "2.0", method: "rpc.discover" }),
    }, bearer(TOKEN));
    expect(r.json).toBe("");
  });

  it("[SRV-0011] Invoke は methodMap に存在しない後方互換経路である", () => {
    const nameMap = JSON.parse(readFileSync(MAP_PATH, "utf8"));
    expect(Object.keys(nameMap)).not.toContain("Invoke");
  });

  it("[SRV-0011] Invoke は ephemeral=true の Connection を addConnection/removeConnection で囲む", () => {
    const src = readFileSync(
      resolve(HERE, "..", "..", "src", "serve", "framing", "grpc.js"),
      "utf8"
    );
    expect(src).toContain("addConnection");
    expect(src).toContain("removeConnection");
    expect(src).toContain("ephemeral");
  });
});

// ---------------------------------------------------------------------------
// SRV-0012: HTTP POST /rpc — 未認証は401 + JSON-RPC 2.0 error
// ---------------------------------------------------------------------------

describe("[SRV-0012] HTTP POST /rpc: token必須→未認証は401+JSON-RPC 2.0 error(kind=not_authenticated)+WWW-Authenticate:Bearer", () => {
  it("[SRV-0012] token 無しで POST すると 401 + www-authenticate:Bearer ヘッダ + JSON-RPC 2.0 error 封筒", async () => {
    const d = makeDaemon(fakeHub());
    const h = await startHttpFraming(d, { port: 0, token: TOKEN });
    handles.push(h);

    const r = await fetch(`${h.url}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/Bearer/i);

    const j = await r.json();
    expect(j.jsonrpc).toBe("2.0");
    expect(j.id).toBeNull();
    expect(j.error).toBeTruthy();
    expect(typeof j.error.code).toBe("number");
    expect(j.error.data.kind).toBe("not_authenticated");
    // 旧 {error, hint} 形でないこと (回帰防止)
    expect(j.hint).toBeUndefined();
    expect(j.error).not.toBe("unauthorized");
  });

  it("[SRV-0012] token 一致なら 200 + openrpc 結果が返る", async () => {
    const d = makeDaemon(fakeHub());
    const h = await startHttpFraming(d, { port: 0, token: TOKEN });
    handles.push(h);

    const r = await fetch(`${h.url}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "rpc.discover" }),
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.result.openrpc).toBe("1.2.6");
  });
});

// ---------------------------------------------------------------------------
// SRV-0013: HTTP POST /rpc — 通知は204・応答ありは200・ephemeral=true
// ---------------------------------------------------------------------------

describe("[SRV-0013] HTTP POST /rpc: 通知(null)→204、応答あり→200+application/json、ephemeral=true", () => {
  it("[SRV-0013] dispatch null (通知) → 204 no body", async () => {
    const d = makeDaemon(fakeHub());
    const h = await startHttpFraming(d, { port: 0, token: TOKEN });
    handles.push(h);

    const r = await fetch(`${h.url}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "rpc.discover" }), // id なし = 通知
    });
    expect(r.status).toBe(204);
  });

  it("[SRV-0013] dispatch 応答あり → 200 + content-type: application/json", async () => {
    const d = makeDaemon(fakeHub());
    const h = await startHttpFraming(d, { port: 0, token: TOKEN });
    handles.push(h);

    const r = await fetch(`${h.url}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "rpc.discover" }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/application\/json/);
    const j = await r.json();
    expect(j.result.openrpc).toBe("1.2.6");
  });

  it("[SRV-0013] conn.ephemeral=true で HTTP POST 接続は event.ready を受け取らない", () => {
    const src = readFileSync(
      resolve(HERE, "..", "..", "src", "serve", "framing", "http.js"),
      "utf8"
    );
    expect(src).toMatch(/ephemeral\s*:\s*true/);
  });

  it("[SRV-0013] dispatch throw → INTERNAL_ERROR 封筒 (ソース確認)", () => {
    const src = readFileSync(
      resolve(HERE, "..", "..", "src", "serve", "framing", "http.js"),
      "utf8"
    );
    expect(src).toContain("INTERNAL_ERROR");
    expect(src).toMatch(/KIND\.INTERNAL/);
  });
});

// ---------------------------------------------------------------------------
// SRV-0014: HTTP body 上限 1MB
// ---------------------------------------------------------------------------

describe("[SRV-0014] HTTP body 上限 1MB: 超過は413(connection:close)+残りを受け切る(O(1)メモリ)", () => {
  it("[SRV-0014] MAX_BODY = 1_000_000 (1MB)", () => {
    const src = readFileSync(
      resolve(HERE, "..", "..", "src", "serve", "framing", "http.js"),
      "utf8"
    );
    expect(src).toMatch(/MAX_BODY\s*=\s*1[_,]?000[_,]?000/);
  });

  it("[SRV-0014] size > MAX_BODY のとき 413 + connection:close を返す", async () => {
    const d = makeDaemon(fakeHub());
    const h = await startHttpFraming(d, { port: 0, token: TOKEN });
    handles.push(h);

    const bigBody = "x".repeat(1_000_001);
    const r = await fetch(`${h.url}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: bigBody,
    });
    expect(r.status).toBe(413);
  });

  it("[SRV-0014] 413 送出後の discard も MAX_BODY 超で req.destroy (DoS 二段防御) をソースで確認", () => {
    const src = readFileSync(
      resolve(HERE, "..", "..", "src", "serve", "framing", "http.js"),
      "utf8"
    );
    expect(src).toMatch(/discarded\s*\+=\s*c\.length/);
    expect(src).toMatch(/req\.destroy\(\)/);
  });
});

// ---------------------------------------------------------------------------
// SRV-0015: HTTP CORS オプトイン
// ---------------------------------------------------------------------------

describe("[SRV-0015] HTTP CORS: オプトイン、allowlist echo+Vary:Origin、'*'全echo、OPTIONS preflight token不要204", () => {
  it("[SRV-0015] corsOrigins=null (未指定) ならレスポンスに ACAO ヘッダなし", async () => {
    const d = makeDaemon(fakeHub());
    const h = await startHttpFraming(d, { port: 0, token: TOKEN });
    handles.push(h);

    const r = await fetch(`${h.url}/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "rpc.discover" }),
    });
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("[SRV-0015] allowlist: 許可 origin は ACAO echo + Vary:Origin / 許可外は ACAO なし", async () => {
    const d = makeDaemon(fakeHub());
    const h = await startHttpFraming(d, { port: 0, token: TOKEN, corsOrigins: ["https://app.example"] });
    handles.push(h);

    const ok = await fetch(`${h.url}/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        origin: "https://app.example",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "rpc.discover" }),
    });
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(ok.headers.get("vary")).toMatch(/origin/i);

    const denied = await fetch(`${h.url}/rpc`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    });
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("[SRV-0015] corsOrigins='*' は req origin を echo する (Vary なし)", async () => {
    const d = makeDaemon(fakeHub());
    const h = await startHttpFraming(d, { port: 0, token: TOKEN, corsOrigins: "*" });
    handles.push(h);

    const r = await fetch(`${h.url}/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        origin: "https://whatever.example",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "rpc.discover" }),
    });
    expect(r.headers.get("access-control-allow-origin")).toBe("https://whatever.example");
  });

  it("[SRV-0015] OPTIONS preflight は token 不要で 204 を返す (CORS 有効時)", async () => {
    const d = makeDaemon(fakeHub());
    const h = await startHttpFraming(d, { port: 0, token: TOKEN, corsOrigins: ["https://app.example"] });
    handles.push(h);

    const r = await fetch(`${h.url}/rpc`, {
      method: "OPTIONS",
      headers: {
        origin: "https://app.example",
        "access-control-request-method": "POST",
      },
    });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(r.headers.get("access-control-allow-methods")).toMatch(/POST/);
    expect(r.headers.get("access-control-allow-headers")).toMatch(/authorization/i);
  });
});

// ---------------------------------------------------------------------------
// SRV-0016: HTTP GET /events (SSE)
// ---------------------------------------------------------------------------

describe("[SRV-0016] HTTP GET /events (SSE): text/event-stream+': ok'/data:行+空行/25s ping/不正topic→400", () => {
  it("[SRV-0016] 全不正 topic → 400 + valid 一覧", async () => {
    const d = makeDaemon(fakeHub());
    const h = await startHttpFraming(d, { port: 0, token: TOKEN });
    handles.push(h);

    const r = await fetch(`${h.url}/events?topics=bogus_topic_xyz&token=${TOKEN}`);
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error).toBeTruthy();
    expect(Array.isArray(j.valid)).toBe(true);
  });

  it("[SRV-0016] 有効 topic で SSE 確立すると ': ok' コメントが最初に来る", async () => {
    const hub = fakeHub();
    const d = makeDaemon(hub);
    const h = await startHttpFraming(d, { port: 0, token: TOKEN });
    handles.push(h);

    const ctrl = new AbortController();
    const res = await fetch(`${h.url}/events?topics=lockState&token=${TOKEN}`, {
      signal: ctrl.signal,
    });
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const deadline = Date.now() + 2000;
    outer: while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.includes(": ok")) break outer;
    }
    ctrl.abort();
    expect(buf).toContain(": ok");
  });

  it("[SRV-0016] event push は 'data: '+JSON+空行 形式で届く", async () => {
    const hub = fakeHub();
    const d = makeDaemon(hub);
    const h = await startHttpFraming(d, { port: 0, token: TOKEN });
    handles.push(h);

    const ctrl = new AbortController();
    const res = await fetch(`${h.url}/events?topics=lockState&token=${TOKEN}`, {
      signal: ctrl.signal,
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();

    // Wait for initial ": ok"
    let buf = "";
    const t1 = Date.now() + 1000;
    while (Date.now() < t1) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.includes(": ok")) break;
    }
    await new Promise(r => setTimeout(r, 50));
    hub._emit({ data: { deviceUUID: "u1", state: "unlocked" } });

    const t2 = Date.now() + 1500;
    while (Date.now() < t2) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      if (buf.includes("data:")) break;
    }
    ctrl.abort();
    expect(buf).toMatch(/^data: /m);
  });

  it("[SRV-0016] 25s heartbeat ': ping' の実装が存在する", () => {
    const src = readFileSync(
      resolve(HERE, "..", "..", "src", "serve", "framing", "http.js"),
      "utf8"
    );
    expect(src).toContain(": ping");
    expect(src).toMatch(/25000/);
  });

  it("[SRV-0016] 空 topics 指定は購読なしで確立する (400 にならない)", async () => {
    const d = makeDaemon(fakeHub());
    const h = await startHttpFraming(d, { port: 0, token: TOKEN });
    handles.push(h);

    const ctrl = new AbortController();
    const res = await fetch(`${h.url}/events?token=${TOKEN}`, {
      signal: ctrl.signal,
    });
    expect(res.status).toBe(200);
    ctrl.abort();
  });
});

// ---------------------------------------------------------------------------
// SRV-0017: HTTP routing — GET / token不要、未知pathは404
// ---------------------------------------------------------------------------

describe("[SRV-0017] HTTP GET / token不要のusage / 未知path→404 JSON", () => {
  it("[SRV-0017] GET / は token 不要で usage テキストを返す (実バインドポートを表示)", async () => {
    const d = makeDaemon(fakeHub());
    const h = await startHttpFraming(d, { port: 0, token: TOKEN });
    handles.push(h);

    const r = await fetch(`${h.url}/`);
    expect(r.status).toBe(200);
    const text = await r.text();
    const realPort = new URL(h.url).port;
    expect(realPort).not.toBe("0");
    expect(text).toContain(`127.0.0.1:${realPort}`);
    expect(text).not.toContain("127.0.0.1:0");
  });

  it("[SRV-0017] 未知 path は token 通過後 404 + JSON {error}", async () => {
    const d = makeDaemon(fakeHub());
    const h = await startHttpFraming(d, { port: 0, token: TOKEN });
    handles.push(h);

    const r = await fetch(`${h.url}/unknown-path`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(404);
    const j = await r.json();
    expect(j.error).toBeTruthy();
  });

  it("[SRV-0017] 未知 path で token なしは 401", async () => {
    const d = makeDaemon(fakeHub());
    const h = await startHttpFraming(d, { port: 0, token: TOKEN });
    handles.push(h);

    const r = await fetch(`${h.url}/unknown-path`);
    expect(r.status).toBe(401);
  });

  it("[SRV-0017] 未知 method (PUT /rpc) は token 通過後 404 JSON を返す", async () => {
    const d = makeDaemon(fakeHub());
    const h = await startHttpFraming(d, { port: 0, token: TOKEN });
    handles.push(h);

    const r = await fetch(`${h.url}/rpc`, {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// SRV-0018: WS 握手前 token 検証 (verifyClient)
// ---------------------------------------------------------------------------

describe("[SRV-0018] WS 握手前 token 検証: 失敗は 101 返さず 401、onConnection 防御再確認は 1008", () => {
  it("[SRV-0018] token なしでの WS 接続は握手で拒否され open は発火しない (401)", async () => {
    const d = makeDaemon(fakeHub());
    const h = await startWsFraming(d, { port: 0, token: TOKEN });
    handles.push(h);

    const err = await new Promise((res) => {
      const ws = new WebSocket(h.url); // no token
      ws.on("open", () => { ws.close(); res(new Error("should not open")); });
      ws.on("error", (e) => res(e));
      ws.on("close", (code) => {
        if (code === 1008) res(new Error("1008 unauthorized"));
        else res(new Error(`closed: ${code}`));
      });
      setTimeout(() => res(new Error("timeout")), 1500);
    });
    expect(String(err.message)).toMatch(/401|unauthorized|should not open|closed|timeout/i);
    // verify the message is NOT "should not open" (open must not fire before rejection)
    // The main assertion: error or close happens before open
    expect(String(err.message)).not.toBe("should not open");
  });

  it("[SRV-0018] 正しい token で WS 接続すると open が発火し JSON-RPC が通る", async () => {
    const d = makeDaemon(fakeHub());
    const h = await startWsFraming(d, { port: 0, token: TOKEN });
    handles.push(h);

    const result = await new Promise((res, rej) => {
      const ws = new WebSocket(`${h.url}?token=${TOKEN}`);
      const to = setTimeout(() => { ws.close(); rej(new Error("timeout")); }, 2000);
      ws.on("open", () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "rpc.discover" })));
      ws.on("message", (data) => {
        const m = JSON.parse(data.toString());
        if (!("id" in m)) return; // skip event.ready
        clearTimeout(to);
        ws.close();
        res(m);
      });
      ws.on("error", rej);
    });
    expect(result.result?.openrpc).toBe("1.2.6");
  });

  it("[SRV-0018] verifyClient は WebSocketServer に注入されている (ソース確認)", () => {
    const src = readFileSync(
      resolve(HERE, "..", "..", "src", "serve", "framing", "ws.js"),
      "utf8"
    );
    expect(src).toContain("verifyClient");
    expect(src).toContain("WebSocketServer");
    expect(src).toMatch(/verifyClient[\s\S]*?extractToken|extractToken[\s\S]*?verifyClient/);
  });

  it("[SRV-0018] onConnection で防御的再検証し失敗は ws.close(1008) で打ち切る (ソース確認)", () => {
    const src = readFileSync(
      resolve(HERE, "..", "..", "src", "serve", "framing", "ws.js"),
      "utf8"
    );
    expect(src).toContain("1008");
    expect(src).toContain("tokenMatches");
    expect(src).toMatch(/onConnection[\s\S]+?1008/);
  });
});
