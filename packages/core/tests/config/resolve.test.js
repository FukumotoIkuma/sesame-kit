// P5-4 (ARCH-05): name 解決の一本化 (src/resolve.js resolveByName) と
// SesameError(BAD_REQUEST) 統一を固定する。
//   - resolveByName 純関数の解決順 (明示 name → default → 単一フォールバック)
//   - ConfigStore.resolveLock / resolveRemote が BAD_REQUEST を投げる
//     (旧実装の plain Error は serve で kind=internal に潰れていた)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveByName, LOCK_RESOLVE_ERRORS, REMOTE_RESOLVE_ERRORS } from "../../src/resolve.js";
import { ConfigStore } from "../../src/config.js";
import { SesameError, ERR } from "../../src/errors.js";

describe("resolveByName (純関数)", () => {
  const errs = {
    noneSpecified: (names) => new Error(`none: [${names.join(",")}]`),
    unknown: (name, names) => new Error(`unknown ${name}: [${names.join(",")}]`),
  };

  it("明示 name が最優先", () => {
    const r = resolveByName({ a: 1, b: 2 }, "b", "a", errs);
    expect(r).toEqual({ name: "b", entry: 2 });
  });

  it("name 省略時は defaultName", () => {
    expect(resolveByName({ a: 1, b: 2 }, null, "a", errs)).toEqual({ name: "a", entry: 1 });
  });

  it("default も無く登録が 1 件だけならそれ", () => {
    expect(resolveByName({ only: 7 }, null, null, errs)).toEqual({ name: "only", entry: 7 });
  });

  it("default 無し + 複数登録は noneSpecified", () => {
    expect(() => resolveByName({ a: 1, b: 2 }, null, null, errs)).toThrow(/none: \[a,b\]/);
  });

  it("map が空/null でも noneSpecified", () => {
    expect(() => resolveByName({}, null, null, errs)).toThrow(/none: \[\]/);
    expect(() => resolveByName(null, null, null, errs)).toThrow(/none/);
  });

  it("未知の明示 name は unknown", () => {
    expect(() => resolveByName({ a: 1 }, "x", null, errs)).toThrow(/unknown x: \[a\]/);
  });

  it("標準 errFactory は SesameError(BAD_REQUEST) を生成する", () => {
    for (const f of [LOCK_RESOLVE_ERRORS, REMOTE_RESOLVE_ERRORS]) {
      const e1 = f.noneSpecified([]);
      const e2 = f.unknown("x", ["a"]);
      expect(e1).toBeInstanceOf(SesameError);
      expect(e2).toBeInstanceOf(SesameError);
      expect(/** @type {SesameError} */ (e1).code).toBe(ERR.BAD_REQUEST);
      expect(/** @type {SesameError} */ (e2).code).toBe(ERR.BAD_REQUEST);
    }
  });
});

describe("ConfigStore の name 解決が SesameError(BAD_REQUEST) になる (serve で bad_params)", () => {
  let workDir, store;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "sesame-resolve-"));
    store = new ConfigStore(join(workDir, "config.json"));
  });
  afterEach(() => {
    if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
    workDir = null;
  });

  it("resolveLock: 未知名は code=bad_request", () => {
    store.addLock("L1", { deviceUUID: "u", secretKey: "0123456789abcdef0123456789abcdef" });
    try {
      store.resolveLock("missing");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SesameError);
      expect(e.code).toBe(ERR.BAD_REQUEST);
      expect(e.message).toMatch(/Unknown lock "missing"/);
    }
  });

  it("resolveRemote: 未指定 + 登録無しも code=bad_request", () => {
    try {
      store.resolveRemote();
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SesameError);
      expect(e.code).toBe(ERR.BAD_REQUEST);
      expect(e.message).toMatch(/No remote specified/);
    }
  });

  it("ドメイン操作 (setDefaultLock 未知名) も code=bad_request (P5-5)", () => {
    try {
      store.setDefaultLock("nope");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SesameError);
      expect(e.code).toBe(ERR.BAD_REQUEST);
    }
  });
});
