// src/util.js subscribeChunks の境界テスト (REFACTORING_PLAN P5-7 / ARCH-17)。
// biz3 のページング/集約パターンの共通ライフサイクルの防御要所を直接検証する:
//   - finish の二重呼び (二重解決ガード)
//   - onMessage 内 throw → reject
//   - timeout 後の push 無視 (timeout で reject 済みなら後続 push は何もしない)
//   - errorAction (同 action の success:false フレームで即時失敗)
import { describe, it, expect, vi, afterEach } from "vitest";
import { subscribeChunks } from "../../src/util.js";
import { SesameError, ERR } from "../../src/errors.js";
// 共有 fake (P5-7 / ARCH-16) を土台に、subscribeChunks 固有の onMessage (errorAction 経路) を
// 必要なテストだけ withOnMessage() で追加する。
import { chunkMockClient } from "../helpers/mock-ws.js";

afterEach(() => {
  vi.useRealTimers();
});

/** errorAction 経路用: client.onMessage(fn) (全受信フック) を chunkMockClient に追加する。 */
function withOnMessage(client) {
  /** @type {Set<Function>} */
  const listeners = new Set();
  return {
    ...client,
    /** @param {Function} fn */
    onMessage(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** テスト用: 全受信フックへ生フレームを流す (dispatch key を介さない)。 */
    raw(msg) {
      for (const fn of [...listeners]) fn(msg);
    },
    listeners,
  };
}

describe("subscribeChunks: 正常系と finish 二重呼び", () => {
  it("onMessage が finish() を呼んだら result() の値で resolve し、購読を解除する", async () => {
    const c = chunkMockClient();
    /** @type {string[]} */
    const acc = [];
    const p = subscribeChunks(c, {
      sendFrame: { action: "a", op: "get" },
      subscriptions: [{
        key: "a:pub",
        onMessage: (msg, finish) => {
          acc.push(msg.v);
          if (msg.last) finish();
        },
      }],
      timeoutMs: 1000,
      result: () => acc,
    });
    expect(c.sent).toEqual([{ action: "a", op: "get" }]); // sendFrame は購読登録後に送られる
    expect(c.hasSub("a:pub")).toBe(true);
    c.push("a:pub", { v: "x" });
    c.push("a:pub", { v: "y", last: true });
    await expect(p).resolves.toEqual(["x", "y"]);
    expect(c.hasSub("a:pub")).toBe(false); // cleanup で unsubscribe 済み
  });

  it("finish を二重に呼んでも 1 回目だけが有効 (result も 1 回しか呼ばれない)", async () => {
    const c = chunkMockClient();
    const result = vi.fn(() => "ok");
    const p = subscribeChunks(c, {
      sendFrame: { action: "a", op: "get" },
      subscriptions: [{
        key: "a:pub",
        onMessage: (_msg, finish) => {
          finish();
          finish(new Error("二重呼びは無視されるべき"));
        },
      }],
      timeoutMs: 1000,
      result,
    });
    c.push("a:pub", {});
    await expect(p).resolves.toBe("ok"); // 2 回目の finish(err) で reject に化けない
    expect(result).toHaveBeenCalledTimes(1);
  });

  it("finish() 確定後の後続 push は無視される (done ガード)", async () => {
    const c = chunkMockClient();
    const onMessage = vi.fn((_msg, finish) => finish());
    const p = subscribeChunks(c, {
      sendFrame: { action: "a", op: "get" },
      subscriptions: [{ key: "a:pub", onMessage }],
      timeoutMs: 1000,
      result: () => "ok",
    });
    c.push("a:pub", {});
    await p;
    c.push("a:pub", {}); // unsubscribe 済みなので届かない
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it("finish(err) で reject する", async () => {
    const c = chunkMockClient();
    const p = subscribeChunks(c, {
      sendFrame: { action: "a", op: "get" },
      subscriptions: [{ key: "a:pub", onMessage: (_msg, finish) => finish(new Error("boom")) }],
      timeoutMs: 1000,
      result: () => "unreachable",
    });
    c.push("a:pub", {});
    await expect(p).rejects.toThrow(/boom/);
  });
});

describe("subscribeChunks: onMessage 内 throw", () => {
  it("onMessage が throw したら reject し、購読も解除される", async () => {
    const c = chunkMockClient();
    const p = subscribeChunks(c, {
      sendFrame: { action: "a", op: "get" },
      subscriptions: [{
        key: "a:pub",
        onMessage: () => {
          throw new Error("handler exploded");
        },
      }],
      timeoutMs: 1000,
      result: () => "unreachable",
    });
    c.push("a:pub", {});
    await expect(p).rejects.toThrow(/handler exploded/);
    expect(c.hasSub("a:pub")).toBe(false);
  });
});

describe("subscribeChunks: timeout", () => {
  it("timeout で reject (既定は code=timeout の SesameError) し、後続 push は無視される", async () => {
    vi.useFakeTimers();
    const c = chunkMockClient();
    const onMessage = vi.fn();
    const p = subscribeChunks(c, {
      sendFrame: { action: "a", op: "get" },
      subscriptions: [{ key: "a:pub", onMessage }],
      timeoutMs: 500,
      result: () => "unreachable",
    });
    vi.advanceTimersByTime(500);
    await expect(p).rejects.toSatisfy((e) => e instanceof SesameError && e.code === ERR.TIMEOUT);
    // timeout 確定後の push は unsubscribe 済み + done ガードで完全に無視される
    c.push("a:pub", { v: "late" });
    expect(onMessage).not.toHaveBeenCalled();
    expect(c.hasSub("a:pub")).toBe(false);
  });

  it("onTimeout 指定時はその Error で reject する", async () => {
    vi.useFakeTimers();
    const c = chunkMockClient();
    const p = subscribeChunks(c, {
      sendFrame: { action: "a", op: "get" },
      subscriptions: [{ key: "a:pub", onMessage: () => {} }],
      timeoutMs: 500,
      onTimeout: () => new Error("カスタム timeout"),
      result: () => "unreachable",
    });
    vi.advanceTimersByTime(500);
    await expect(p).rejects.toThrow(/カスタム timeout/);
  });

  it("finish 確定済みなら timer 発火しても何も起きない (clearTimeout 済み)", async () => {
    vi.useFakeTimers();
    const c = chunkMockClient();
    const p = subscribeChunks(c, {
      sendFrame: { action: "a", op: "get" },
      subscriptions: [{ key: "a:pub", onMessage: (_m, finish) => finish() }],
      timeoutMs: 500,
      result: () => "ok",
    });
    c.push("a:pub", {});
    await expect(p).resolves.toBe("ok");
    vi.advanceTimersByTime(1000); // 発火しない (clearTimeout 済み)。p は resolve のまま
  });
});

describe("subscribeChunks: partialOnTimeout (BIZ-14 / バックログ6)", () => {
  it("timeout 時に reject せず {partial:true, ...集約済み結果} で resolve し、購読も解除される", async () => {
    vi.useFakeTimers();
    const c = chunkMockClient();
    /** @type {string[]} */
    const acc = [];
    const p = subscribeChunks(c, {
      sendFrame: { action: "a", op: "get" },
      subscriptions: [{
        key: "a:pub",
        // 完了条件 (finish) を満たさないまま chunk だけ蓄積する
        onMessage: (msg) => { acc.push(msg.v); },
      }],
      timeoutMs: 500,
      partialOnTimeout: true,
      result: () => ({ partial: false, list: acc }),
    });
    c.push("a:pub", { v: "x" });
    c.push("a:pub", { v: "y" });
    vi.advanceTimersByTime(500);
    // 部分蓄積が partial:true 付きで返る (spread が result() の partial:false を上書きする)
    await expect(p).resolves.toEqual({ partial: true, list: ["x", "y"] });
    expect(c.hasSub("a:pub")).toBe(false); // cleanup 済み
  });

  it("完了 (finish) が先なら従来どおり result() のまま resolve する (partial:true は付かない)", async () => {
    vi.useFakeTimers();
    const c = chunkMockClient();
    const p = subscribeChunks(c, {
      sendFrame: { action: "a", op: "get" },
      subscriptions: [{ key: "a:pub", onMessage: (_m, finish) => finish() }],
      timeoutMs: 500,
      partialOnTimeout: true,
      result: () => ({ partial: false, list: ["done"] }),
    });
    c.push("a:pub", {});
    await expect(p).resolves.toEqual({ partial: false, list: ["done"] });
    vi.advanceTimersByTime(1000); // clearTimeout 済みなので二重 resolve しない
  });

  it("既定 (partialOnTimeout 未指定) は従来どおり timeout で reject する (後方互換)", async () => {
    vi.useFakeTimers();
    const c = chunkMockClient();
    const p = subscribeChunks(c, {
      sendFrame: { action: "a", op: "get" },
      subscriptions: [{ key: "a:pub", onMessage: () => {} }],
      timeoutMs: 500,
      result: () => "unreachable",
    });
    c.push("a:pub", {});
    vi.advanceTimersByTime(500);
    await expect(p).rejects.toSatisfy((e) => e instanceof SesameError && e.code === ERR.TIMEOUT);
  });
});

describe("subscribeChunks: errorAction (P3-9)", () => {
  it("同 action の success:false フレームで code=rejected の SesameError で即時 reject", async () => {
    const c = withOnMessage(chunkMockClient());
    const p = subscribeChunks(c, {
      sendFrame: { action: "biz3X", op: "get" },
      subscriptions: [{ key: "biz3X:pub", onMessage: () => {} }],
      timeoutMs: 1000,
      errorAction: "biz3X",
      result: () => "unreachable",
    });
    c.raw({ action: "biz3X", success: false, message: "denied", code: 403 });
    await expect(p).rejects.toSatisfy(
      (e) => e instanceof SesameError && e.code === ERR.REJECTED && /denied/.test(e.message)
        && e.data?.upstreamCode === 403,
    );
    // onMessage フックも cleanup で解除される
    expect(c.listeners.size).toBe(0);
  });

  it("別 action / success:false でないフレームは無視される", async () => {
    const c = withOnMessage(chunkMockClient());
    const p = subscribeChunks(c, {
      sendFrame: { action: "biz3X", op: "get" },
      subscriptions: [{ key: "biz3X:pub", onMessage: (_m, finish) => finish() }],
      timeoutMs: 1000,
      errorAction: "biz3X",
      result: () => "ok",
    });
    c.raw({ action: "biz3Y", success: false }); // 別 action → 無視
    c.raw({ action: "biz3X", success: true }); // 成功フレーム → 無視
    c.push("biz3X:pub", {}); // 正常完了
    await expect(p).resolves.toBe("ok");
  });

  it("client が onMessage を持たない場合は errorAction を黙ってスキップする (後方互換)", async () => {
    const c = chunkMockClient(); // onMessage 無し
    const p = subscribeChunks(c, {
      sendFrame: { action: "biz3X", op: "get" },
      subscriptions: [{ key: "biz3X:pub", onMessage: (_m, finish) => finish() }],
      timeoutMs: 1000,
      errorAction: "biz3X",
      result: () => "ok",
    });
    c.push("biz3X:pub", {});
    await expect(p).resolves.toBe("ok");
  });
});
