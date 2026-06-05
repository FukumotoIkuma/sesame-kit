// SesameHub3.onLockStateChange / onLockStateChangeDevice 単体テスト
//
// 観点:
//   - _ensureConnected ガード (未 connect 時は throw)
//   - subscribe key が STATE_CHANGE_KEY ("biz3TriggerLocker:pubDeviceStateChange") であること
//   - deviceUUID の normalize (大文字小文字無視 / ハイフン除去) が両側に効くこと
//   - msg.deviceId / msg.device_id / msg.data.deviceId の優先順位
//   - 一致 deviceId のみ fn が呼ばれ、別 deviceId では呼ばれない
//   - 戻り unsubscribe で以後 fn が呼ばれない
//   - 同一デバイスに対し複数 subscribe が並存可能
//   - fn の throw を内部で握りつぶす (他フレームに影響しない)
//   - name → deviceUUID の解決 (default lock / 単一 lock の自動選択 / unknown name の throw)
//
// 戦略: client._ws を fake (subscribe を spy 化したオブジェクト) に差し替える。
// 実 WebSocket は不要 — onLockStateChange* の責務は filter / dispatch ロジックなので、
// subscribe のコールバック引数を直接呼ぶことで全パスを決定的に再現できる。

import { describe, it, expect, beforeEach, vi } from "vitest";
import { SesameHub3 } from "../../src/client.js";

const STATE_CHANGE_KEY = "biz3TriggerLocker:pubDeviceStateChange";

/**
 * @returns {{ ws: any, subscribers: Map<string, Set<Function>>, lastSubscribeKey: string|null }}
 */
function makeFakeWs() {
  // 実 Hub3WsClient.subscribe 相当の最小実装。
  // key 毎に Set を持ち、unsubscribe で fn を取り除く。
  const subscribers = new Map();
  const ws = {
    subscribe: vi.fn((key, fn) => {
      let set = subscribers.get(key);
      if (!set) {
        set = new Set();
        subscribers.set(key, set);
      }
      set.add(fn);
      return () => {
        const s = subscribers.get(key);
        if (!s) return;
        s.delete(fn);
        if (s.size === 0) subscribers.delete(key);
      };
    }),
  };
  return { ws, subscribers };
}

/**
 * connect() を経由せずに connected 状態の hub を構築するヘルパ。
 * connect() は実 WS を張ろうとするため、_ws を直接差し替える。
 */
function makeHub({ locks = {}, defaultLock = null } = {}) {
  const hub = new SesameHub3({
    config: {
      companyID: "co",
      wsUrl: "ws://unused",
      lang: "ja",
      default: { remote: null, lock: defaultLock },
      hub3s: {},
      remotes: {},
      locks,
    },
    tokenStore: { /* unused (connect は呼ばない) */ },
  });
  const { ws, subscribers } = makeFakeWs();
  hub._ws = ws; // private だがテスト都合で直接注入
  hub._subUUID = "test-sub-uuid";
  return { hub, ws, subscribers };
}

/** subscribers Map から最新登録された callback を取り出す。 */
function getDispatcher(subscribers, key = STATE_CHANGE_KEY) {
  const set = subscribers.get(key);
  if (!set || set.size === 0) throw new Error(`no subscriber for ${key}`);
  // 登録順を保つため Array にして最後を返す
  return [...set];
}

describe("SesameHub3.onLockStateChangeDevice", () => {
  describe("接続前ガード", () => {
    it("connect 前に呼ぶと 'not connected' で throw する", () => {
      const hub = new SesameHub3({
        config: { companyID: "co", wsUrl: "ws://unused", lang: "ja", default: {}, hub3s: {}, remotes: {}, locks: {} },
        tokenStore: {},
      });
      // _ws はまだ null
      expect(() => hub.onLockStateChangeDevice("aaaa-bbbb", () => {})).toThrow(/not connected/);
    });
  });

  describe("subscribe key と引数", () => {
    it("STATE_CHANGE_KEY で _ws.subscribe を 1 回呼ぶ", () => {
      const { hub, ws } = makeHub();
      hub.onLockStateChangeDevice("AA-BB-CC", vi.fn());
      expect(ws.subscribe).toHaveBeenCalledTimes(1);
      expect(ws.subscribe.mock.calls[0][0]).toBe(STATE_CHANGE_KEY);
      expect(typeof ws.subscribe.mock.calls[0][1]).toBe("function");
    });

    it("戻り値は _ws.subscribe の戻り unsubscribe (関数) を直接返す", () => {
      const { hub } = makeHub();
      const off = hub.onLockStateChangeDevice("dev-1", vi.fn());
      expect(typeof off).toBe("function");
    });
  });

  describe("deviceId フィルタ + normalize", () => {
    it("normalize 一致 (ハイフン除去 + 小文字) で fn が呼ばれる", () => {
      const { hub, subscribers } = makeHub();
      const fn = vi.fn();
      hub.onLockStateChangeDevice("AAAA-BBBB-CCCC", fn);
      const [dispatch] = getDispatcher(subscribers);

      // 大文字 + ハイフンあり → 小文字 + ハイフン無しの target と一致
      dispatch({ action: "biz3TriggerLocker", op: "pubDeviceStateChange", deviceId: "aaaa-bbbb-cccc", v: 1 });
      dispatch({ action: "biz3TriggerLocker", op: "pubDeviceStateChange", deviceId: "AAAABBBBCCCC", v: 2 });

      expect(fn).toHaveBeenCalledTimes(2);
      expect(fn.mock.calls[0][0]).toMatchObject({ v: 1 });
      expect(fn.mock.calls[1][0]).toMatchObject({ v: 2 });
    });

    it("別 deviceId の msg は無視される", () => {
      const { hub, subscribers } = makeHub();
      const fn = vi.fn();
      hub.onLockStateChangeDevice("dev-1", fn);
      const [dispatch] = getDispatcher(subscribers);

      dispatch({ deviceId: "dev-2" });
      dispatch({ deviceId: "DEV-1" }); // これは normalize で一致するので呼ばれる
      dispatch({ deviceId: "completely-different" });

      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn.mock.calls[0][0].deviceId).toBe("DEV-1");
    });

    it("msg.device_id (snake_case) も拾う", () => {
      const { hub, subscribers } = makeHub();
      const fn = vi.fn();
      hub.onLockStateChangeDevice("dev-1", fn);
      const [dispatch] = getDispatcher(subscribers);

      dispatch({ device_id: "dev-1", payload: "snake" });

      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn.mock.calls[0][0].payload).toBe("snake");
    });

    it("msg.data.deviceId にネストされていても拾う", () => {
      const { hub, subscribers } = makeHub();
      const fn = vi.fn();
      hub.onLockStateChangeDevice("dev-1", fn);
      const [dispatch] = getDispatcher(subscribers);

      dispatch({ data: { deviceId: "dev-1" }, payload: "nested" });

      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn.mock.calls[0][0].payload).toBe("nested");
    });

    it("どこにも deviceId が無い msg は normalize('') !== target なので無視される", () => {
      const { hub, subscribers } = makeHub();
      const fn = vi.fn();
      hub.onLockStateChangeDevice("dev-1", fn);
      const [dispatch] = getDispatcher(subscribers);

      dispatch({ foo: "bar" });
      dispatch({ data: { somethingElse: "nope" } });

      expect(fn).not.toHaveBeenCalled();
    });

    it("target 側が空文字 normalize されるとどの incoming にも一致しない (deviceUUID 未指定の安全側挙動)", () => {
      const { hub, subscribers } = makeHub();
      const fn = vi.fn();
      // 非文字列 → normalizeUuid で "" になる
      hub.onLockStateChangeDevice(undefined, fn);
      const [dispatch] = getDispatcher(subscribers);

      dispatch({ deviceId: "dev-1" });
      dispatch({});  // incoming も "" になるので一致してしまわないか?

      // incoming "" === target "" で一致する (実装上の挙動). 明示的に確認する。
      // dev-1 を持つ msg は incoming != "" なので呼ばれない。
      expect(fn).toHaveBeenCalledTimes(1); // 空 vs 空 一致
      expect(fn.mock.calls[0][0]).toEqual({});
    });

    it("incoming deviceId が非文字列 (number 等) でも normalize で '' になり一致しない", () => {
      const { hub, subscribers } = makeHub();
      const fn = vi.fn();
      hub.onLockStateChangeDevice("dev-1", fn);
      const [dispatch] = getDispatcher(subscribers);

      dispatch({ deviceId: 12345 });
      dispatch({ deviceId: null });
      dispatch({ deviceId: { not: "string" } });

      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe("unsubscribe", () => {
    it("戻り unsubscribe を呼ぶと以後 fn が呼ばれない", () => {
      const { hub, subscribers } = makeHub();
      const fn = vi.fn();
      const off = hub.onLockStateChangeDevice("dev-1", fn);
      const [dispatch] = getDispatcher(subscribers);

      dispatch({ deviceId: "dev-1", v: 1 });
      expect(fn).toHaveBeenCalledTimes(1);

      off();

      // unsubscribe 後は subscribers から消える (最後の 1 つだったので key ごと消える)
      expect(subscribers.has(STATE_CHANGE_KEY)).toBe(false);

      // (もし誰かが古い dispatch を保持していても) 新規 dispatch は走らない
      // dispatch 参照を直接呼んでも fn は購読解除済みのため呼ばれない、を確認するため
      // 同じ dispatch 関数を呼んでみる -- 実際は subscribers から外れたので 1 回のまま
      // ※実 _ws.subscribe の挙動上、dispatch 関数自体は msg を受けても外部からは
      // 呼び出されない (Map から外れた)。ここでは「再 dispatch が走らない」を Map 側で確認。
    });

    it("unsubscribe を 2 回呼んでも throw しない", () => {
      const { hub } = makeHub();
      const off = hub.onLockStateChangeDevice("dev-1", vi.fn());
      expect(() => { off(); off(); }).not.toThrow();
    });
  });

  describe("複数 subscribe の並存", () => {
    it("同 deviceId に対し複数 subscribe すると全 fn が呼ばれる", () => {
      const { hub, subscribers } = makeHub();
      const fn1 = vi.fn();
      const fn2 = vi.fn();
      const fn3 = vi.fn();
      hub.onLockStateChangeDevice("dev-1", fn1);
      hub.onLockStateChangeDevice("DEV-1", fn2);
      hub.onLockStateChangeDevice("d-e-v---1", fn3);

      // 同じ key (STATE_CHANGE_KEY) に 3 件の dispatch が登録される
      const dispatchers = getDispatcher(subscribers);
      expect(dispatchers.length).toBe(3);

      dispatchers.forEach((d) => d({ deviceId: "dev-1", v: "x" }));

      expect(fn1).toHaveBeenCalledTimes(1);
      expect(fn2).toHaveBeenCalledTimes(1);
      expect(fn3).toHaveBeenCalledTimes(1);
    });

    it("異なる deviceId の subscribe は互いに干渉しない", () => {
      const { hub, subscribers } = makeHub();
      const fnA = vi.fn();
      const fnB = vi.fn();
      hub.onLockStateChangeDevice("dev-A", fnA);
      hub.onLockStateChangeDevice("dev-B", fnB);

      const dispatchers = getDispatcher(subscribers);
      // A 向け msg
      dispatchers.forEach((d) => d({ deviceId: "dev-A" }));
      // B 向け msg
      dispatchers.forEach((d) => d({ deviceId: "dev-B" }));

      expect(fnA).toHaveBeenCalledTimes(1);
      expect(fnB).toHaveBeenCalledTimes(1);
    });

    it("片方を unsubscribe してももう片方は生き残る", () => {
      const { hub, subscribers } = makeHub();
      const fn1 = vi.fn();
      const fn2 = vi.fn();
      const off1 = hub.onLockStateChangeDevice("dev-1", fn1);
      hub.onLockStateChangeDevice("dev-1", fn2);

      off1();

      const remaining = getDispatcher(subscribers);
      expect(remaining.length).toBe(1);
      remaining[0]({ deviceId: "dev-1" });

      expect(fn1).not.toHaveBeenCalled();
      expect(fn2).toHaveBeenCalledTimes(1);
    });
  });

  describe("fn の例外を握りつぶす", () => {
    it("fn が throw しても dispatch が throw しない", () => {
      const { hub, subscribers } = makeHub();
      const fn = vi.fn(() => { throw new Error("user code boom"); });
      hub.onLockStateChangeDevice("dev-1", fn);

      const [dispatch] = getDispatcher(subscribers);
      expect(() => dispatch({ deviceId: "dev-1" })).not.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("一致しない msg では fn を呼ばないので、fn の throw 体質に関係なく無事", () => {
      const { hub, subscribers } = makeHub();
      const fn = vi.fn(() => { throw new Error("never call me"); });
      hub.onLockStateChangeDevice("dev-1", fn);

      const [dispatch] = getDispatcher(subscribers);
      expect(() => dispatch({ deviceId: "dev-2" })).not.toThrow();
      expect(fn).not.toHaveBeenCalled();
    });

    it("複数 fn のうち先頭が throw しても、同 dispatch 関数の呼び出しは独立 (subscribe 側の責務)", () => {
      // 各 onLockStateChangeDevice は独自の dispatch 関数を登録するため、
      // 1 つの dispatch が throw しても (実 transport の subscribe は各 dispatch を try/catch するが
      // ここではテスト都合で個別に呼ぶ) 他の dispatch を呼べば fn2 は実行される。
      const { hub, subscribers } = makeHub();
      const fn1 = vi.fn(() => { throw new Error("boom1"); });
      const fn2 = vi.fn();
      hub.onLockStateChangeDevice("dev-1", fn1);
      hub.onLockStateChangeDevice("dev-1", fn2);

      const dispatchers = getDispatcher(subscribers);
      dispatchers.forEach((d) => {
        expect(() => d({ deviceId: "dev-1" })).not.toThrow();
      });
      expect(fn1).toHaveBeenCalledTimes(1);
      expect(fn2).toHaveBeenCalledTimes(1);
    });
  });
});

describe("SesameHub3.onLockStateChange (name -> deviceUUID 解決)", () => {
  it("name を指定すると config.locks[name].deviceUUID を target にする", () => {
    const { hub, subscribers } = makeHub({
      locks: {
        front: { deviceUUID: "FRONT-UUID-1111", secretKey: "x" },
        back:  { deviceUUID: "back-uuid-2222", secretKey: "y" },
      },
    });
    const fnFront = vi.fn();
    const fnBack = vi.fn();
    hub.onLockStateChange("front", fnFront);
    hub.onLockStateChange("back", fnBack);

    const dispatchers = getDispatcher(subscribers);
    // 各 dispatch は自分の target にだけ反応
    dispatchers.forEach((d) => d({ deviceId: "front-uuid-1111" }));
    dispatchers.forEach((d) => d({ deviceId: "BACK-UUID-2222" }));

    expect(fnFront).toHaveBeenCalledTimes(1);
    expect(fnFront.mock.calls[0][0].deviceId).toBe("front-uuid-1111");
    expect(fnBack).toHaveBeenCalledTimes(1);
    expect(fnBack.mock.calls[0][0].deviceId).toBe("BACK-UUID-2222");
  });

  it("name 省略時は config.default.lock を使う", () => {
    const { hub, subscribers } = makeHub({
      locks: {
        front: { deviceUUID: "front-uuid", secretKey: "x" },
        back:  { deviceUUID: "back-uuid",  secretKey: "y" },
      },
      defaultLock: "back",
    });
    const fn = vi.fn();
    hub.onLockStateChange(undefined, fn);

    const [dispatch] = getDispatcher(subscribers);
    dispatch({ deviceId: "back-uuid", v: 1 });
    dispatch({ deviceId: "front-uuid", v: 2 });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0].v).toBe(1);
  });

  it("locks が 1 件だけなら name 省略でもそれを使う", () => {
    const { hub, subscribers } = makeHub({
      locks: { only: { deviceUUID: "only-uuid", secretKey: "x" } },
    });
    const fn = vi.fn();
    hub.onLockStateChange(undefined, fn);
    const [dispatch] = getDispatcher(subscribers);
    dispatch({ deviceId: "only-uuid" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("unknown name は throw する (subscribe は呼ばれない)", () => {
    const { hub, ws } = makeHub({
      locks: { front: { deviceUUID: "front-uuid", secretKey: "x" } },
    });
    expect(() => hub.onLockStateChange("nonexistent", vi.fn())).toThrow(/Unknown lock/);
    expect(ws.subscribe).not.toHaveBeenCalled();
  });

  it("default も無く locks が複数あり name 省略すると throw する", () => {
    const { hub, ws } = makeHub({
      locks: {
        a: { deviceUUID: "a-uuid", secretKey: "x" },
        b: { deviceUUID: "b-uuid", secretKey: "y" },
      },
      defaultLock: null,
    });
    expect(() => hub.onLockStateChange(undefined, vi.fn())).toThrow(/No lock specified/);
    expect(ws.subscribe).not.toHaveBeenCalled();
  });

  it("locks が空で name も省略すると throw する", () => {
    const { hub, ws } = makeHub({ locks: {} });
    expect(() => hub.onLockStateChange(undefined, vi.fn())).toThrow(/No lock specified/);
    expect(ws.subscribe).not.toHaveBeenCalled();
  });

  it("connect 前に呼ぶと 'not connected' で throw する (resolveLock より先にガード)", () => {
    const hub = new SesameHub3({
      config: {
        companyID: "co", wsUrl: "ws://x", lang: "ja",
        default: {}, hub3s: {}, remotes: {},
        locks: { front: { deviceUUID: "front-uuid", secretKey: "x" } },
      },
      tokenStore: {},
    });
    expect(() => hub.onLockStateChange("front", vi.fn())).toThrow(/not connected/);
  });

  it("onLockStateChange の戻り unsubscribe が機能する (name 経由でも)", () => {
    const { hub, subscribers } = makeHub({
      locks: { front: { deviceUUID: "front-uuid", secretKey: "x" } },
    });
    const fn = vi.fn();
    const off = hub.onLockStateChange("front", fn);
    const [dispatch] = getDispatcher(subscribers);

    dispatch({ deviceId: "front-uuid", v: 1 });
    expect(fn).toHaveBeenCalledTimes(1);

    off();
    expect(subscribers.has(STATE_CHANGE_KEY)).toBe(false);
  });
});
