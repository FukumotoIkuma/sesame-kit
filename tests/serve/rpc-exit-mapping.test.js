// バックログ5: `sesame rpc` のサーバ側エラー → 終了コード写像。
// toServeError (src/cli/serve.js) がサーバ由来 JSON-RPC error の kind を CLI の終了コード契約
// (0=成功 / 1=ランタイム / 2=usage) へ橋渡しする:
//   - kind=bad_params (引数不正/未知 op) は呼び出し方の誤り → exitCode=2 (usage)
//   - internal / not_authenticated / rejected 等は実行時障害のまま 1 (exitCode を立てない)
// run() の catch は die(withStaleHint(err), runtimeExitCode(err)) で exitCode を尊重する。
import { describe, it, expect } from "vitest";
import { toServeError } from "../../src/cli/serve.js";
import { runtimeExitCode } from "../../src/cli/errors.js";
import { SesameError as SesameRpcClientError } from "sesame-kit/client";

/** clients/js の SesameError (kind/code 付き) を作る。 */
function rpcError(kind, code = -32602, message = `server says ${kind}`) {
  return new SesameRpcClientError(message, kind, code);
}

describe("バックログ5: sesame rpc の exit code 写像 (toServeError)", () => {
  it("kind=bad_params は exitCode=2 (usage) を立て、runtimeExitCode が 2 を返す", () => {
    const err = toServeError(rpcError("bad_params"), { socketPath: "/tmp/x.sock" });
    expect(err.rpcError).toBe(true);
    expect(err.data).toEqual({ kind: "bad_params" });
    expect(err.exitCode).toBe(2);
    expect(runtimeExitCode(err)).toBe(2); // run() の catch 経由で exit 2 になる
  });

  it("kind=internal / rejected / not_implemented は exitCode を立てない → exit 1", () => {
    for (const kind of ["internal", "rejected", "not_implemented"]) {
      const err = toServeError(rpcError(kind, -32603), { socketPath: "/tmp/x.sock" });
      expect(err.rpcError).toBe(true);
      expect(err.exitCode).toBeUndefined();
      expect(runtimeExitCode(err)).toBe(1);
    }
  });

  it("kind=not_authenticated (UDS 経路) も runtime 扱いで exit 1", () => {
    const err = toServeError(rpcError("not_authenticated", -32000), { socketPath: "/tmp/x.sock" });
    expect(err.exitCode).toBeUndefined();
    expect(runtimeExitCode(err)).toBe(1);
  });

  it("kind=not_authenticated (HTTP 経路) は token 案内メッセージへ写像し exit 1", () => {
    const err = toServeError(rpcError("not_authenticated", 401), { url: "http://127.0.0.1:8080" });
    expect(err.exitCode).toBeUndefined();
    expect(runtimeExitCode(err)).toBe(1);
    expect(err.rpcError).toBeUndefined(); // 人間向け案内 (httpUnauthorized) へ差し替え
  });

  it("接続不能 (connection_lost) / timeout は従来どおり案内メッセージ + exit 1", () => {
    for (const [kind, where] of [
      ["connection_lost", { socketPath: "/tmp/x.sock" }],
      ["timeout", { socketPath: "/tmp/x.sock" }],
    ]) {
      const err = toServeError(rpcError(kind, undefined), where);
      expect(err.exitCode).toBeUndefined();
      expect(runtimeExitCode(err)).toBe(1);
    }
  });

  it("SesameRpcClientError 以外はそのまま素通しする", () => {
    const plain = new Error("boom");
    expect(toServeError(plain, {})).toBe(plain);
  });
});
