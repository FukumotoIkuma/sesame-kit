// src/optional-deps.js (optional peerDependencies の遅延 import ヘルパー, P5-1 段階1) の単体テスト。
// 「未導入 → 導入手順付きの明瞭なエラー」「無関係なエラーは握りつぶさず素通し」の 2 契約を固定する。

import { describe, it, expect } from "vitest";
import { importOptional, rethrowMissingOptional } from "../src/optional-deps.js";

describe("importOptional", () => {
  it("導入済みモジュールはそのまま import できる (node 組み込み)", async () => {
    const mod = await importOptional("node:path", "unused hint");
    expect(typeof mod.resolve).toBe("function");
  });

  it("未導入モジュールは hint メッセージ + ERR_OPTIONAL_DEP_MISSING に変換する", async () => {
    const hint = "npm i some-missing-pkg で --grpc が使えます";
    await expect(importOptional("some-missing-pkg-xyz", hint)).rejects.toMatchObject({
      message: hint,
      code: "ERR_OPTIONAL_DEP_MISSING",
      spec: "some-missing-pkg-xyz",
    });
  });
});

describe("rethrowMissingOptional", () => {
  // Node の ERR_MODULE_NOT_FOUND を模したエラー (メッセージにモジュール名を含む)。
  function moduleNotFound(spec) {
    const e = new Error(`Cannot find package '${spec}' imported from /x/session-ui.js`);
    /** @type {any} */ (e).code = "ERR_MODULE_NOT_FOUND";
    return e;
  }

  it("specs のいずれかが未導入なら hint エラーへ変換 (session-ui の ink/react 経路を想定)", () => {
    const hint = "npm i ink react ink-select-input ink-text-input で sesame session が使えます";
    const specs = ["ink", "react", "ink-select-input", "ink-text-input"];
    expect(() => rethrowMissingOptional(moduleNotFound("react"), specs, hint))
      .toThrow(hint);
    try {
      rethrowMissingOptional(moduleNotFound("ink"), specs, hint);
    } catch (e) {
      expect(/** @type {any} */ (e).code).toBe("ERR_OPTIONAL_DEP_MISSING");
      expect(/** @type {any} */ (e).spec).toBe("ink");
    }
  });

  it("無関係なエラー (構文エラー等) は原因をそのまま rethrow する (握りつぶし防止)", () => {
    const syntaxErr = new SyntaxError("Unexpected token");
    expect(() => rethrowMissingOptional(syntaxErr, ["ink"], "hint")).toThrow(syntaxErr);
    // code はあるがメッセージに spec を含まない (= 別モジュールの解決失敗) も素通し。
    const other = moduleNotFound("left-pad");
    expect(() => rethrowMissingOptional(other, ["ink-select-input"], "hint")).toThrow(other);
  });
});
