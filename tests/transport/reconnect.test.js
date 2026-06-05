// Unit tests for Hub3WsClient._handleReconnect + token refresh in src/transport.js
//
// Strategy:
//   - vi.mock("ws") で WebSocket を fake に差し替え。テストごとに「次の接続が
//     即 close する / open するか」を切り替えるためにグローバルな mock state を
//     使う。
//   - vi.useFakeTimers() を全 it で使い、reconnect backoff の delay を正確に
//     advanceTimersByTime / runAllTimersAsync で進める。
//   - autoReconnect=true で初回 connect() を即 close させ、その後の
//     _handleReconnect サイクルを観測する。
//   - retryCount, _refreshedThisCycle, idToken, onTokenRefreshNeeded 呼出を
//     直接 (client.xxx) と spy で観測する。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------- mock "ws" -------------------------------------------------
//
// FakeWebSocket は EventEmitter ライクな最小 API:
//   - constructor(url): __instances に push。url を保持
//   - once("open"|...), on(event, fn): リスナ登録
//   - removeAllListeners(event?): 登録解除
//   - close(): _emit("close", 1006, Buffer.from(""))
//   - send(): no-op (テストでは observed via __sentFrames)
//
// テスト本体で `wsMockMode` を切り替えることで、各インスタンス生成直後の
// 挙動を決める:
//   - "immediate-close": new した直後 (microtask) で close を emit
//   - "open": new した直後で open を emit (success path 用)
//   - "manual": テストが手動で fire する (詳細制御)

let wsMockMode = "immediate-close";
const __instances = [];

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this._listeners = new Map(); // event -> Array<{fn, once}>
    this.readyState = 0;
    this.__sentFrames = [];
    __instances.push(this);

    // 自動 fire は queueMicrotask 1tick 遅らせる (実 ws と同じく next tick で event)
    queueMicrotask(() => {
      if (wsMockMode === "immediate-close") {
        this._emit("close", 1006, Buffer.from("immediate fail"));
      } else if (wsMockMode === "open") {
        this.readyState = 1;
        this._emit("open");
      }
      // "manual" の場合は何もしない
    });
  }

  _register(event, fn, once) {
    let arr = this._listeners.get(event);
    if (!arr) { arr = []; this._listeners.set(event, arr); }
    arr.push({ fn, once });
  }

  on(event, fn) { this._register(event, fn, false); return this; }
  once(event, fn) { this._register(event, fn, true); return this; }

  removeAllListeners(event) {
    if (event === undefined) { this._listeners.clear(); }
    else { this._listeners.delete(event); }
    return this;
  }

  _emit(event, ...args) {
    const arr = this._listeners.get(event);
    if (!arr) return;
    const snapshot = [...arr];
    // once は呼ぶ前に削除
    this._listeners.set(event, arr.filter((e) => !e.once));
    for (const { fn } of snapshot) {
      try { fn(...args); } catch { /* ignore */ }
    }
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    // 同期 close emit (実 ws では非同期だが、テスト都合で同期にしておく)
    this._emit("close", 1000, Buffer.from(""));
  }

  send(payload) {
    this.__sentFrames.push(payload);
  }
}

vi.mock("ws", () => {
  return { default: FakeWebSocket, WebSocket: FakeWebSocket };
});

// ---------- helpers ---------------------------------------------------

async function flushMicrotasks(times = 5) {
  for (let i = 0; i < times; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

// import target AFTER vi.mock
const { Hub3WsClient } = await import("../../src/transport.js");

const BASE_CFG = {
  wsUrl: "ws://example.test/biz3",
  idToken: "tok-initial",
  autoReconnect: true,
  debug: false,
};

// ---------- tests -----------------------------------------------------

describe("Hub3WsClient._handleReconnect + token refresh", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    wsMockMode = "immediate-close";
    __instances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ----- backoff scheduling --------------------------------------------

  describe("exponential backoff", () => {
    it("初回 reconnect は 1000ms delay でスケジュールされる", async () => {
      const client = new Hub3WsClient(BASE_CFG);
      // 初回 connect → 即 close → _onClose が _handleReconnect 呼ぶ前に
      // _initialConnectReject 経路へ抜ける (wasOpen=false) ため
      // reconnect は走らない。なので autoReconnect 直接検証のため
      // 強制的に retryCount=0 と open 経験後の状態を作って _handleReconnect
      // を直接呼ぶ。
      client.retryCount = 0;
      client.closedByUser = false;
      client._handleReconnect();

      // delay = min(1000 * 1.5^0, 10000) = 1000ms
      // setTimeout 直後では retryCount はまだ 0
      expect(client.retryCount).toBe(0);
      expect(client.reconnectTimer).not.toBeNull();

      // 999ms では発火しない
      await vi.advanceTimersByTimeAsync(999);
      expect(client.retryCount).toBe(0);

      // ちょうど 1000ms で発火 (retryCount++)
      await vi.advanceTimersByTimeAsync(1);
      expect(client.retryCount).toBe(1);

      client.close();
    });

    it("retryCount が増えるごとに delay が 1.5 倍になる (1000ms → 1500ms → 2250ms)", async () => {
      const client = new Hub3WsClient(BASE_CFG);
      const delays = [];

      // 純粋に delay を観測したいので setTimeout を spy
      const realSetTimeout = globalThis.setTimeout;
      const spy = vi.spyOn(globalThis, "setTimeout");

      // retry 0 → delay = 1000
      client.retryCount = 0;
      client._handleReconnect();
      // 最後の setTimeout 呼出が reconnectTimer
      const call0 = spy.mock.calls[spy.mock.calls.length - 1];
      delays.push(call0[1]);
      clearTimeout(client.reconnectTimer);
      client.reconnectTimer = null;

      // retry 1 → delay = 1500
      client.retryCount = 1;
      client._handleReconnect();
      const call1 = spy.mock.calls[spy.mock.calls.length - 1];
      delays.push(call1[1]);
      clearTimeout(client.reconnectTimer);
      client.reconnectTimer = null;

      // retry 2 → delay = 2250
      client.retryCount = 2;
      client._handleReconnect();
      const call2 = spy.mock.calls[spy.mock.calls.length - 1];
      delays.push(call2[1]);
      clearTimeout(client.reconnectTimer);
      client.reconnectTimer = null;

      expect(delays[0]).toBe(1000);
      expect(delays[1]).toBe(1500);
      expect(delays[2]).toBe(2250);

      spy.mockRestore();
      // restore for safety
      void realSetTimeout;
      client.close();
    });

    it("delay は MAX_RECONNECT_DELAY_MS (10000ms) で上限される", async () => {
      const client = new Hub3WsClient(BASE_CFG);
      const spy = vi.spyOn(globalThis, "setTimeout");

      // 1000 * 1.5^10 ≈ 57665 → cap at 10000
      client.retryCount = 10;
      client._handleReconnect();
      const lastCall = spy.mock.calls[spy.mock.calls.length - 1];
      expect(lastCall[1]).toBe(10000);

      // さらに上げても 10000 のまま
      clearTimeout(client.reconnectTimer);
      client.reconnectTimer = null;
      client.retryCount = 100;
      client._handleReconnect();
      const cappedCall = spy.mock.calls[spy.mock.calls.length - 1];
      expect(cappedCall[1]).toBe(10000);

      spy.mockRestore();
      client.close();
    });

    it("closedByUser=true の時は何もしない (timer も新規作成しない)", () => {
      const client = new Hub3WsClient(BASE_CFG);
      const spy = vi.spyOn(globalThis, "setTimeout");
      const before = spy.mock.calls.length;

      client.closedByUser = true;
      client._handleReconnect();

      expect(client.reconnectTimer).toBeNull();
      expect(spy.mock.calls.length).toBe(before);
      spy.mockRestore();
    });

    it("reconnectTimer が既にセットされていれば再スケジュールしない", () => {
      const client = new Hub3WsClient(BASE_CFG);
      client.retryCount = 0;
      client._handleReconnect();
      const firstTimer = client.reconnectTimer;
      expect(firstTimer).not.toBeNull();

      // 2 回目呼出は no-op
      client._handleReconnect();
      expect(client.reconnectTimer).toBe(firstTimer);

      client.close();
    });

    it("CONNECTING 中 (ws ありかつ status=connecting) は再スケジュールしない", () => {
      const client = new Hub3WsClient(BASE_CFG);
      client.ws = { dummy: true };
      client.status = "connecting";

      client._handleReconnect();
      expect(client.reconnectTimer).toBeNull();
    });
  });

  // ----- token refresh threshold ---------------------------------------

  describe("token refresh threshold (MAX_RETRIES_BEFORE_TOKEN_CHECK=3)", () => {
    it("retryCount が 3 に達した瞬間に onTokenRefreshNeeded が呼ばれる", async () => {
      const refresh = vi.fn().mockResolvedValue(null);
      const client = new Hub3WsClient({ ...BASE_CFG, onTokenRefreshNeeded: refresh });
      // _initWebSocket を no-op に (ws が走らないように)
      client._initWebSocket = vi.fn(() => { client.status = "connecting"; });

      // 2 回連続失敗状態を作る → retryCount=2
      client.retryCount = 2;
      client._refreshedThisCycle = false;
      client._handleReconnect();

      // 1500 * 1.5^2 ... 実際は retryCount=2 で delay = 1000 * 1.5^2 = 2250ms
      await vi.advanceTimersByTimeAsync(2250);
      await flushMicrotasks();

      expect(refresh).toHaveBeenCalledTimes(1);
      expect(refresh).toHaveBeenCalledWith("tok-initial");
      expect(client.retryCount).toBe(3);
      expect(client._refreshedThisCycle).toBe(true);

      client.close();
    });

    it("onTokenRefreshNeeded が新 token を返したら idToken 差し替えと retryCount リセットが行われる", async () => {
      const refresh = vi.fn().mockResolvedValue("tok-fresh");
      const client = new Hub3WsClient({ ...BASE_CFG, onTokenRefreshNeeded: refresh });
      client._initWebSocket = vi.fn(() => { client.status = "connecting"; });

      client.retryCount = 2;
      client._refreshedThisCycle = false;
      client._handleReconnect();
      await vi.advanceTimersByTimeAsync(2250);
      await flushMicrotasks();

      expect(client.idToken).toBe("tok-fresh");
      expect(client.retryCount).toBe(0);
      expect(client._initWebSocket).toHaveBeenCalled();
      client.close();
    });

    it("onTokenRefreshNeeded が null を返したら idToken は変更されず backoff 継続", async () => {
      const refresh = vi.fn().mockResolvedValue(null);
      const client = new Hub3WsClient({ ...BASE_CFG, onTokenRefreshNeeded: refresh });
      client._initWebSocket = vi.fn(() => { client.status = "connecting"; });

      client.retryCount = 2;
      client._refreshedThisCycle = false;
      client._handleReconnect();
      await vi.advanceTimersByTimeAsync(2250);
      await flushMicrotasks();

      expect(client.idToken).toBe("tok-initial");
      expect(client.retryCount).toBe(3); // リセットされない
      expect(client._initWebSocket).toHaveBeenCalled();
      client.close();
    });

    it("onTokenRefreshNeeded が同じ token を返した場合も差し替えは起きない (== は !== fresh)", async () => {
      const refresh = vi.fn().mockResolvedValue("tok-initial"); // 同じ
      const client = new Hub3WsClient({ ...BASE_CFG, onTokenRefreshNeeded: refresh });
      client._initWebSocket = vi.fn(() => { client.status = "connecting"; });

      client.retryCount = 2;
      client._refreshedThisCycle = false;
      client._handleReconnect();
      await vi.advanceTimersByTimeAsync(2250);
      await flushMicrotasks();

      expect(client.idToken).toBe("tok-initial");
      expect(client.retryCount).toBe(3); // リセットされない
      client.close();
    });

    it("onTokenRefreshNeeded が throw しても catch されて backoff 継続", async () => {
      const refresh = vi.fn().mockRejectedValue(new Error("network down"));
      const client = new Hub3WsClient({ ...BASE_CFG, onTokenRefreshNeeded: refresh });
      client._initWebSocket = vi.fn(() => { client.status = "connecting"; });

      client.retryCount = 2;
      client._refreshedThisCycle = false;
      client._handleReconnect();
      await vi.advanceTimersByTimeAsync(2250);
      await flushMicrotasks();

      expect(refresh).toHaveBeenCalled();
      expect(client.idToken).toBe("tok-initial");
      expect(client.retryCount).toBe(3); // リセットなし
      expect(client._refreshedThisCycle).toBe(true); // throw でもフラグは立つ
      // _initWebSocket は呼ばれる (catch 後に進む)
      expect(client._initWebSocket).toHaveBeenCalled();
      client.close();
    });

    it("onTokenRefreshNeeded callback が未設定なら閾値到達でも何もしない", async () => {
      const client = new Hub3WsClient({ ...BASE_CFG }); // onTokenRefreshNeeded なし
      client._initWebSocket = vi.fn(() => { client.status = "connecting"; });

      client.retryCount = 2;
      client._refreshedThisCycle = false;
      client._handleReconnect();
      await vi.advanceTimersByTimeAsync(2250);
      await flushMicrotasks();

      expect(client.retryCount).toBe(3);
      expect(client._refreshedThisCycle).toBe(false); // フラグ立たない
      expect(client._initWebSocket).toHaveBeenCalled();
      client.close();
    });

    it("_refreshedThisCycle=true なら閾値ヒットでも refresh callback は呼ばれない", async () => {
      const refresh = vi.fn().mockResolvedValue("tok-fresh");
      const client = new Hub3WsClient({ ...BASE_CFG, onTokenRefreshNeeded: refresh });
      client._initWebSocket = vi.fn(() => { client.status = "connecting"; });

      client.retryCount = 2;
      client._refreshedThisCycle = true; // 既に refresh 済
      client._handleReconnect();
      await vi.advanceTimersByTimeAsync(2250);
      await flushMicrotasks();

      expect(refresh).not.toHaveBeenCalled();
      expect(client.idToken).toBe("tok-initial");
      expect(client.retryCount).toBe(3);
      client.close();
    });

    it("1 サイクルで 5 回連続失敗しても refresh callback は 1 回だけ呼ばれる", async () => {
      const refresh = vi.fn().mockResolvedValue(null); // null = リセットなし
      const client = new Hub3WsClient({ ...BASE_CFG, onTokenRefreshNeeded: refresh });
      client._initWebSocket = vi.fn(() => { client.status = "connecting"; });

      // 5 サイクル分手動でループ。retryCount 0→1→2→3 (refresh)→4→5
      client.retryCount = 0;
      client._refreshedThisCycle = false;

      for (let i = 0; i < 5; i++) {
        client._handleReconnect();
        // 上限なし delay の上限まで一気に進める (10s 以上 advance すれば足りる)
        await vi.advanceTimersByTimeAsync(11_000);
        await flushMicrotasks();
      }

      // retryCount は 0 リセット無いので 5
      expect(client.retryCount).toBe(5);
      // refresh は 1 回だけ
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(client._refreshedThisCycle).toBe(true);
      client.close();
    });

    it("retryCount が 3 を通り越して 4 になっても再度 refresh は呼ばれない (== 3 のみ)", async () => {
      const refresh = vi.fn().mockResolvedValue(null);
      const client = new Hub3WsClient({ ...BASE_CFG, onTokenRefreshNeeded: refresh });
      client._initWebSocket = vi.fn(() => { client.status = "connecting"; });

      // 既に 3 を超えている状態でスタート
      client.retryCount = 3;
      client._refreshedThisCycle = false;
      client._handleReconnect();
      await vi.advanceTimersByTimeAsync(11_000);
      await flushMicrotasks();

      // retryCount は 4 になる。閾値 == 3 とのチェックなので呼ばれない
      expect(client.retryCount).toBe(4);
      expect(refresh).not.toHaveBeenCalled();
      expect(client._refreshedThisCycle).toBe(false);
      client.close();
    });
  });

  // ----- cycle reset behavior ------------------------------------------

  describe("_refreshedThisCycle reset", () => {
    it("_onOpen が呼ばれると _refreshedThisCycle が false にリセットされる", () => {
      const client = new Hub3WsClient(BASE_CFG);
      // _onOpen 内で this.ws.send が呼ばれる (_startKeepalive→_triggerHeartbeatCheck)
      // のでダミー ws を差しておく
      client.ws = { send: vi.fn(), readyState: 1 };
      client.status = "connecting";
      client._refreshedThisCycle = true;
      client.retryCount = 7;

      client._onOpen();

      expect(client._refreshedThisCycle).toBe(false);
      expect(client.retryCount).toBe(0);
      expect(client.status).toBe("open");
      client._clearAllTimers();
    });

    it("_reconnect() (能動再接続) が呼ばれると _refreshedThisCycle が false にリセットされる", () => {
      const client = new Hub3WsClient(BASE_CFG);
      // _initWebSocket を mock して副作用回避
      client._initWebSocket = vi.fn(() => { client.status = "connecting"; });
      client._refreshedThisCycle = true;
      client.retryCount = 5;
      client.ws = null;

      client._reconnect();

      expect(client._refreshedThisCycle).toBe(false);
      expect(client.retryCount).toBe(0);
      expect(client._initWebSocket).toHaveBeenCalled();
    });

    it("能動再接続 → 再度失敗時に refresh callback が呼べる (サイクルがリセットされている証拠)", async () => {
      const refresh = vi.fn().mockResolvedValue(null);
      const client = new Hub3WsClient({ ...BASE_CFG, onTokenRefreshNeeded: refresh });
      // _initWebSocket は no-op
      client._initWebSocket = vi.fn(() => { client.status = "connecting"; });

      // サイクル 1: 既に refresh 済の状態
      client._refreshedThisCycle = true;
      client.retryCount = 2;
      client._handleReconnect();
      await vi.advanceTimersByTimeAsync(2250);
      await flushMicrotasks();
      expect(refresh).not.toHaveBeenCalled(); // refreshedThisCycle ガード

      // 能動再接続で新サイクル開始
      client._reconnect();
      expect(client._refreshedThisCycle).toBe(false);
      expect(client.retryCount).toBe(0);

      // 新サイクルで 3 回失敗まで進める
      for (let i = 0; i < 3; i++) {
        client._handleReconnect();
        await vi.advanceTimersByTimeAsync(11_000);
        await flushMicrotasks();
      }

      // 今度は呼ばれる
      expect(refresh).toHaveBeenCalledTimes(1);
      client.close();
    });
  });

  // ----- integration with real WebSocket mock + connect() ---------------

  describe("integration: connect() failures and reconnect cycle", () => {
    it("autoReconnect=false なら _handleReconnect は呼ばれない", async () => {
      const client = new Hub3WsClient({ ...BASE_CFG, autoReconnect: false });
      const spy = vi.spyOn(client, "_handleReconnect");

      // 既に OPEN した接続が close する状況を作る
      client.status = "open";
      client.ws = null;
      client._onClose(1006, Buffer.from("dropped"));

      expect(spy).not.toHaveBeenCalled();
      client.close();
    });

    it("autoReconnect=true で OPEN 後 close されたら _handleReconnect が呼ばれる", () => {
      const client = new Hub3WsClient({ ...BASE_CFG, autoReconnect: true });
      const spy = vi.spyOn(client, "_handleReconnect").mockImplementation(() => {});

      client.status = "open";
      client.ws = null;
      client._initialConnectReject = null; // OPEN 経験済を示す
      client._onClose(1006, Buffer.from("dropped"));

      expect(spy).toHaveBeenCalled();
      client.close();
    });

    it("close() が呼ばれた後の _handleReconnect は何もしない", () => {
      const client = new Hub3WsClient(BASE_CFG);
      client.close();
      expect(client.closedByUser).toBe(true);

      const spy = vi.spyOn(globalThis, "setTimeout");
      const before = spy.mock.calls.length;
      client._handleReconnect();
      expect(client.reconnectTimer).toBeNull();
      expect(spy.mock.calls.length).toBe(before);
      spy.mockRestore();
    });
  });
});
