// SesameHub3.onDeviceUpdate 単体テスト
//
// 観点 (P1-4 / R2:CLOUD-01):
//   - _ensureConnected ガード (未 connect 時は throw)
//   - 購読時にサーバへ subscribeDevicesUpdate frame を 1 回送る
//   - subscribe key が "biz3TriggerLocker:pubDeviceStateChange" であること
//   - **P1-4: WS 再接続時に購読フレームを再送する**
//     (vendor: useManageDevice.js:352-358 — onConnectionIdChange → getCompanyDevices
//      → useManageDevice.js:48-51 で subscribeDevices() を再送)
//   - unsubscribe 後は再接続でもフレームを再送しない
//   - fn への push 配信: onUpdate が呼ばれる
//   - fn の throw は内部で握りつぶす
//   - 複数の items を渡したとき frame の items に全て乗る
//
// 戦略: client._ws を fake (subscribe/send を spy 化したオブジェクト) に差し替え、
//        hub._fireReconnect() を直接呼んで再接続イベントをシミュレートする。
// モック構造は onLockStateChange.test.js の makeFakeWs() と同型。

import { describe, it, expect, vi } from "vitest";
import { SesameHub3 } from "../../src/client.js";

const STATE_CHANGE_KEY = "biz3TriggerLocker:pubDeviceStateChange";

/**
 * vendor 形の pubDeviceStateChange フレームを作る (本体は data.deviceUUID)。
 * 導出元: useIotCtrl.js:20-21 (updateDeviceState(message.data))、
 *         useManageDevice.js:147 (updatedDevice.deviceUUID)。
 */
function stateMsg(deviceUUID, extra = {}) {
  return { action: "biz3TriggerLocker", op: "pubDeviceStateChange", data: { deviceUUID }, ...extra };
}

function makeFakeWs() {
  const subscribers = new Map();
  // P1-4: 購読 frame (subscribeDevicesUpdate) の送信を記録する。
  const sent = [];
  const ws = {
    sent,
    send: vi.fn((frame) => { sent.push(frame); }),
    subscribe: vi.fn((key, fn) => {
      let set = subscribers.get(key);
      if (!set) { set = new Set(); subscribers.set(key, set); }
      set.add(fn);
      return () => {
        const s = subscribers.get(key);
        if (!s) return;
        s.delete(fn);
        if (s.size === 0) subscribers.delete(key);
      };
    }),
  };
  return { ws, subscribers, sent };
}

/** connect() を経由せずに connected 状態の hub を構築するヘルパ。 */
function makeHub() {
  const hub = new SesameHub3({
    config: {
      companyID: "co-test", wsUrl: "ws://unused", lang: "ja",
      default: { remote: null, lock: null }, hub3s: {}, remotes: {}, locks: {},
    },
    tokenStore: {},
  });
  const { ws, subscribers, sent } = makeFakeWs();
  hub._ws = ws;
  hub._subUUID = "test-sub-uuid";
  return { hub, ws, subscribers, sent };
}

function getDispatchers(subscribers) {
  const set = subscribers.get(STATE_CHANGE_KEY);
  if (!set || set.size === 0) throw new Error(`no subscriber for ${STATE_CHANGE_KEY}`);
  return [...set];
}

describe("SesameHub3.onDeviceUpdate", () => {
  describe("接続前ガード", () => {
    it("connect 前に呼ぶと 'not connected' で throw する", () => {
      const hub = new SesameHub3({
        config: { companyID: "co", wsUrl: "ws://unused", lang: "ja", default: {}, hub3s: {}, remotes: {}, locks: {} },
        tokenStore: {},
      });
      expect(() => hub.onDeviceUpdate([{ deviceUUID: "d-1" }], () => {})).toThrow(/not connected/);
    });
  });

  describe("購読フレームの送信", () => {
    it("購読時にサーバへ subscribeDevicesUpdate frame を 1 回送る (useManageDevice.js:325-331)", () => {
      const { hub, sent } = makeHub();
      hub.onDeviceUpdate([{ deviceUUID: "d-1", deviceModel: "sesame_5" }], vi.fn());
      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual({
        action: "biz3ManageDevice",
        op: "subscribeDevicesUpdate",
        items: [{ deviceUUID: "d-1", deviceModel: "sesame_5" }],
        companyID: "co-test",
      });
    });

    it("複数 items を渡したとき frame.items に全て含まれる", () => {
      const { hub, sent } = makeHub();
      const items = [
        { deviceUUID: "d-1", deviceModel: "sesame_5" },
        { deviceUUID: "d-2", deviceModel: "sesame_5_pro" },
        { deviceUUID: "d-3" },
      ];
      hub.onDeviceUpdate(items, vi.fn());
      expect(sent[0].items).toEqual(items);
    });

    it("subscribe key が STATE_CHANGE_KEY であること", () => {
      const { hub, ws } = makeHub();
      hub.onDeviceUpdate([{ deviceUUID: "d-1" }], vi.fn());
      expect(ws.subscribe).toHaveBeenCalledTimes(1);
      expect(ws.subscribe.mock.calls[0][0]).toBe(STATE_CHANGE_KEY);
    });
  });

  describe("P1-4: WS 再接続後の購読フレーム再送", () => {
    // vendor: useManageDevice.js:352-358 — WebSocketManager.onConnectionIdChange(() => getCompanyDevices())
    //         → useManageDevice.js:48-51 で subscribeDevices(devices) を再送。
    // サーバは新接続を覚えていないため、再接続後は必ずフレームを再送しなければならない。

    it("WS 再接続時に購読フレームを再送する (_fireReconnect でシミュレート)", () => {
      const { hub, sent } = makeHub();
      hub.onDeviceUpdate([{ deviceUUID: "d-1" }], vi.fn());
      expect(sent).toHaveLength(1);
      hub._fireReconnect();
      expect(sent).toHaveLength(2);
      // 再送フレームは初回と同形
      expect(sent[1]).toEqual(sent[0]);
    });

    it("unsubscribe 後は再接続でもフレームを再送しない", () => {
      const { hub, sent } = makeHub();
      const off = hub.onDeviceUpdate([{ deviceUUID: "d-1" }], vi.fn());
      expect(sent).toHaveLength(1);
      off();
      hub._fireReconnect();
      expect(sent).toHaveLength(1); // 初回のみ
    });

    it("再接続でも購読 key に変化なし (フレーム再送のみ)", () => {
      const { hub, sent, subscribers } = makeHub();
      hub.onDeviceUpdate([{ deviceUUID: "d-1" }], vi.fn());
      hub._fireReconnect();
      // subscribe は 1 回のみ呼ばれる (再接続でも再購読しない)
      expect(subscribers.get(STATE_CHANGE_KEY)?.size).toBe(1);
      // フレームは 2 回
      expect(sent).toHaveLength(2);
    });
  });

  describe("push 配信", () => {
    it("pubDeviceStateChange push を onUpdate へ流す", () => {
      const { hub, subscribers } = makeHub();
      const fn = vi.fn();
      hub.onDeviceUpdate([{ deviceUUID: "d-1" }], fn);
      const [dispatch] = getDispatchers(subscribers);
      const msg = stateMsg("d-1", { extra: "payload" });
      dispatch(msg);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn.mock.calls[0][0]).toMatchObject({ extra: "payload" });
    });

    it("onUpdate の throw は内部で握りつぶす (他フレームに影響しない)", () => {
      const { hub, subscribers } = makeHub();
      const fn = vi.fn(() => { throw new Error("user code boom"); });
      hub.onDeviceUpdate([{ deviceUUID: "d-1" }], fn);
      const [dispatch] = getDispatchers(subscribers);
      expect(() => dispatch(stateMsg("d-1"))).not.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe("unsubscribe", () => {
    it("戻り値は unsubscribe 関数", () => {
      const { hub } = makeHub();
      const off = hub.onDeviceUpdate([{ deviceUUID: "d-1" }], vi.fn());
      expect(typeof off).toBe("function");
    });

    it("unsubscribe 後は onUpdate が呼ばれない", () => {
      const { hub, subscribers } = makeHub();
      const fn = vi.fn();
      const off = hub.onDeviceUpdate([{ deviceUUID: "d-1" }], fn);
      const [dispatch] = getDispatchers(subscribers);
      dispatch(stateMsg("d-1", { v: 1 }));
      expect(fn).toHaveBeenCalledTimes(1);
      off();
      expect(subscribers.has(STATE_CHANGE_KEY)).toBe(false);
    });

    it("unsubscribe を 2 回呼んでも throw しない", () => {
      const { hub } = makeHub();
      const off = hub.onDeviceUpdate([{ deviceUUID: "d-1" }], vi.fn());
      expect(() => { off(); off(); }).not.toThrow();
    });
  });
});
