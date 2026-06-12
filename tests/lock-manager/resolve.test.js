// P5-4 (ARCH-05): LockManager.resolveLock が ConfigStore と同じ resolveByName +
// 同じ i18n キー (domain.config.*) に一本化されたことを固定する。
// (旧実装は domain.client.unknownLock / noLockNoDefault の重複キーで別実装だった)
import { describe, it, expect } from "vitest";
import { LockManager } from "../../src/lock-manager.js";
import { SesameError, ERR } from "../../src/errors.js";

/** @param {object} cfg */
function makeManager(cfg) {
  return new LockManager({
    getWs: () => null,
    getConfig: () => /** @type {any} */ (cfg),
    getSubUUID: () => "sub",
    ensureConnected: () => {},
  });
}

describe("LockManager.resolveLock (resolveByName 委譲)", () => {
  const locks = {
    front: { deviceUUID: "u-front", secretKey: "k", model: null, alias: null },
    back: { deviceUUID: "u-back", secretKey: "k", model: null, alias: null },
  };

  it("明示 name → default → 単一フォールバックの解決順", () => {
    const m = makeManager({ locks, default: { lock: "back", remote: null } });
    expect(m.resolveLock("front").name).toBe("front");
    expect(m.resolveLock(null).name).toBe("back");
    const single = makeManager({ locks: { only: locks.front }, default: { lock: null, remote: null } });
    expect(single.resolveLock().name).toBe("only");
  });

  it("未知名は SesameError(BAD_REQUEST) + ConfigStore と同一メッセージ (キー統一)", () => {
    const m = makeManager({ locks, default: { lock: null, remote: null } });
    try {
      m.resolveLock("missing");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SesameError);
      expect(e.code).toBe(ERR.BAD_REQUEST);
      // domain.config.unknownLock (正準キー) の文言。設定済み一覧付き。
      expect(e.message).toMatch(/Unknown lock "missing"/);
      expect(e.message).toContain("front, back");
    }
  });

  it("未指定 + default 無し + 複数は SesameError(BAD_REQUEST)", () => {
    const m = makeManager({ locks, default: { lock: null, remote: null } });
    try {
      m.resolveLock();
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SesameError);
      expect(e.code).toBe(ERR.BAD_REQUEST);
      expect(e.message).toMatch(/No lock specified/);
    }
  });
});
