// JSON-RPC 2.0 コア (src/serve/jsonrpc.js) の単体テスト。
import { describe, it, expect, vi } from "vitest";
import {
  RPC, KIND, RpcError, classify, handleMessage, makeResult, makeError, makeEvent, errorFromThrow,
} from "../../src/serve/jsonrpc.js";

describe("classify", () => {
  it("正常な request (id あり)", () => {
    const c = classify(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "lock.status", params: { name: "front" } }));
    expect(c).toEqual({ type: "request", id: 1, method: "lock.status", params: { name: "front" } });
  });
  it("通知 = id フィールド欠落", () => {
    const c = classify(JSON.stringify({ jsonrpc: "2.0", method: "events.subscribe", params: {} }));
    expect(c.type).toBe("notification");
    expect(c.method).toBe("events.subscribe");
  });
  it("id:null は通知ではなく request (id=null)", () => {
    const c = classify(JSON.stringify({ jsonrpc: "2.0", id: null, method: "x" }));
    expect(c.type).toBe("request");
    expect(c.id).toBeNull();
  });
  it("params 省略時は {} 既定", () => {
    const c = classify(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "devices.list" }));
    expect(c.params).toEqual({});
  });
  it("jsonrpc 欠落は invalid (id は拾う)", () => {
    const c = classify(JSON.stringify({ id: 5, method: "lock.status" }));
    expect(c).toEqual({ type: "invalid", id: 5 });
  });
  it('jsonrpc !== "2.0" は invalid', () => {
    const c = classify(JSON.stringify({ jsonrpc: "1.0", id: 6, method: "lock.status" }));
    expect(c.type).toBe("invalid");
    expect(c.id).toBe(6);
  });
  it("壊れた JSON は parse-error", () => {
    expect(classify("{not json").type).toBe("parse-error");
  });
  it("batch 配列は batch", () => {
    expect(classify("[1,2]").type).toBe("batch");
  });
  it("method 欠落は invalid (id は拾う)", () => {
    const c = classify(JSON.stringify({ jsonrpc: "2.0", id: 7 }));
    expect(c).toEqual({ type: "invalid", id: 7 });
  });
  it("不正な id 型は null に丸める", () => {
    const c = classify(JSON.stringify({ jsonrpc: "2.0", id: { weird: true }, method: "x" }));
    expect(c.id).toBeNull();
  });
});

describe("handleMessage", () => {
  it("request 成功 → result 応答", async () => {
    const res = await handleMessage(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
      async () => ({ ok: true }),
    );
    expect(res).toEqual({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  });

  it("request の handler が RpcError → error 応答 (kind 付き)", async () => {
    const res = await handleMessage(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "lock.unlock", params: {} }),
      async () => { throw new RpcError("not logged in", { code: RPC.APP_ERROR, kind: KIND.NOT_AUTHENTICATED }); },
    );
    expect(res.id).toBe(2);
    expect(res.error.code).toBe(RPC.APP_ERROR);
    expect(res.error.data.kind).toBe(KIND.NOT_AUTHENTICATED);
  });

  it("通知は実行されるが応答は null (エラーでも沈黙)", async () => {
    const spy = vi.fn(async () => { throw new Error("boom"); });
    const res = await handleMessage(
      JSON.stringify({ jsonrpc: "2.0", method: "events.subscribe", params: { topic: "lockState" } }),
      spy,
    );
    expect(res).toBeNull();
    expect(spy).toHaveBeenCalledOnce();
  });

  it("parse error → -32700 (id null)", async () => {
    const res = await handleMessage("{bad", async () => {});
    expect(res.error.code).toBe(RPC.PARSE_ERROR);
    expect(res.id).toBeNull();
  });

  it("batch → -32600 で拒否", async () => {
    const res = await handleMessage("[{}]", async () => {});
    expect(res.error.code).toBe(RPC.INVALID_REQUEST);
  });

  it("内部例外は INTERNAL_ERROR に正規化 (stack/params を漏らさない)", async () => {
    const res = await handleMessage(
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "x", params: { secretKey: "deadbeef" } }),
      async () => { throw new Error("kaboom"); },
    );
    expect(res.error.code).toBe(RPC.INTERNAL_ERROR);
    expect(JSON.stringify(res)).not.toContain("deadbeef"); // params を error に echo しない
  });
});

describe("makeError / errorFromThrow は params を echo しない", () => {
  it("errorFromThrow は RpcError.data のみ載せる", () => {
    const e = errorFromThrow(9, new RpcError("bad", { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS, data: { field: "uuid" } }));
    expect(e.error.data).toEqual({ kind: KIND.BAD_PARAMS, field: "uuid" });
  });
  it("makeResult は undefined を null 化", () => {
    expect(makeResult(1, undefined).result).toBeNull();
  });
});

describe("makeEvent", () => {
  it("予約名 event.<topic> の通知フレーム (id 無し)", () => {
    const ev = makeEvent("lockState", { deviceUUID: "u1", locked: true });
    expect(ev).toEqual({ jsonrpc: "2.0", method: "event.lockState", params: { deviceUUID: "u1", locked: true } });
    expect("id" in ev).toBe(false);
  });
});
