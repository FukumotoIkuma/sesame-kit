// C1 検証: Hub3WsClient は「初回 OPEN では onReopen を呼ばず、再接続 (2 回目以降の
// OPEN) でのみ呼ぶ」。_onOpen を直接叩いて _everConnected ゲートの挙動を確認する。
import { describe, it, expect, vi } from "vitest";
import { Hub3WsClient } from "../../src/transport.js";

describe("Hub3WsClient onReopen (C1)", () => {
  it("初回 OPEN では呼ばれず、2 回目 (再接続) で呼ばれる", () => {
    const onReopen = vi.fn();
    const c = new Hub3WsClient({ wsUrl: "wss://example.invalid/public", idToken: "t", onReopen });
    try {
      c._onOpen();                       // 初回接続
      expect(onReopen).not.toHaveBeenCalled();
      c._onOpen();                       // 再接続
      expect(onReopen).toHaveBeenCalledTimes(1);
      c._onOpen();                       // さらに再接続
      expect(onReopen).toHaveBeenCalledTimes(2);
    } finally {
      c._clearKeepalive?.();             // _onOpen が張った keepalive タイマを掃除
      if (c.connectTimer) clearTimeout(c.connectTimer);
    }
  });
});
