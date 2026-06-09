// serve 境界でのエラー写像。ライブラリの SesameError が internal に潰れず、
// 正しい JSON-RPC error.data.kind / retryable / 付随 data に写ることを保証する (ii-b)。
//
// 純ロジックなので unit project (tests/serve/ 外) に置く。
import { describe, it, expect } from "vitest";
import { errorFromThrow, RpcError, RPC, KIND } from "../src/serve/jsonrpc.js";
import { SesameError, ERR } from "../src/errors.js";

describe("errorFromThrow: SesameError → JSON-RPC", () => {
  const kindOf = (err) => errorFromThrow(1, err).error;

  it("not_connected → connection_lost, retryable=true", () => {
    const e = kindOf(new SesameError("x", { code: ERR.NOT_CONNECTED, retryable: true }));
    expect(e.data.kind).toBe(KIND.CONNECTION_LOST);
    expect(e.data.retryable).toBe(true);
    expect(e.code).toBe(RPC.APP_ERROR);
  });

  it("timeout → timeout, retryable=true", () => {
    const e = kindOf(new SesameError("x", { code: ERR.TIMEOUT, retryable: true }));
    expect(e.data.kind).toBe(KIND.TIMEOUT);
    expect(e.data.retryable).toBe(true);
  });

  it("rejected → rejected, retryable=false, 付随 data を保持", () => {
    const e = kindOf(new SesameError("x", { code: ERR.REJECTED, retryable: false, data: { upstreamCode: 403 } }));
    expect(e.data.kind).toBe(KIND.REJECTED);
    expect(e.data.retryable).toBe(false);
    expect(e.data.upstreamCode).toBe(403);
  });

  it("bad_request → bad_params, code=-32602", () => {
    const e = kindOf(new SesameError("x", { code: ERR.BAD_REQUEST }));
    expect(e.data.kind).toBe(KIND.BAD_PARAMS);
    expect(e.code).toBe(RPC.INVALID_PARAMS);
  });

  it("unauthenticated → not_authenticated", () => {
    const e = kindOf(new SesameError("x", { code: ERR.UNAUTHENTICATED }));
    expect(e.data.kind).toBe(KIND.NOT_AUTHENTICATED);
  });

  it("未知 code は internal にフォールバック (潰れるのは想定外のみ)", () => {
    const e = kindOf(new SesameError("x", { code: "totally_unknown" }));
    expect(e.data.kind).toBe(KIND.INTERNAL);
    expect(e.code).toBe(RPC.INTERNAL_ERROR);
  });

  it("素の Error は従来どおり internal", () => {
    const e = kindOf(new Error("boom"));
    expect(e.data.kind).toBe(KIND.INTERNAL);
  });

  it("RpcError はそのまま (kind 維持)", () => {
    const e = kindOf(new RpcError("x", { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS }));
    expect(e.data.kind).toBe(KIND.BAD_PARAMS);
  });

  it("data.kind は caller data に上書きされない", () => {
    const e = kindOf(new SesameError("x", { code: ERR.REJECTED, data: { kind: "spoofed" } }));
    expect(e.data.kind).toBe(KIND.REJECTED);
  });
});
