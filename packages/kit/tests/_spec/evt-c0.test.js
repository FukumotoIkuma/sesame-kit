// packages/kit/tests/_spec/evt-c0.test.js
// spec/events.md EVT-0001 〜 EVT-0018 の TDD テスト
// 対象実装: packages/kit/src/serve/entries/events.js
//           packages/kit/src/serve/daemon.js
//           packages/kit/src/serve/registry.js
//           packages/kit/src/serve/registry-helpers.js
//           packages/core/src/jsonrpc.js
//           packages/core/src/devices.js
// 実行環境: vitest (unit project) — KIT_SETUP により kit カタログ登録済み・ロケール ja 固定。
// 方針: TDD — spec と実装が食い違う箇所は spec どおりの期待値で assert する (red 許容)。
//       ネットワーク/実機不使用。self-contained で決定論的。

import { describe, it, expect, vi } from "vitest";
import { Daemon } from "../../src/serve/daemon.js";
import {
  buildRegistry,
  buildOpenRpcDoc,
  SUBSCRIBABLE_TOPICS,
  STATE_TOPICS,
} from "../../src/serve/registry.js";
import { asTopicList } from "../../src/serve/registry-helpers.js";
import { eventsEntries } from "../../src/serve/entries/events.js";
import { makeEvent, KIND, RPC } from "@sesame-kit/core/jsonrpc";

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/** 最小 fake hub。connected/devices を差し替え可能。 */
function makeFakeHub({ connected = true, devices = {}, over = {} } = {}) {
  let duFn = null;
  let udcFn = null;
  const hub = {
    connected,
    subUUID: "sub-1",
    config: { devices },
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    onDeviceUpdate: (_items, fn) => {
      duFn = fn;
      return () => { duFn = null; };
    },
    onUserDeviceChange: (fn) => {
      udcFn = fn;
      return () => { udcFn = null; };
    },
    onReconnect: vi.fn(),
    _emit: (msg) => { if (duFn) duFn(msg); },
    _emitUDC: (msg) => { if (udcFn) udcFn(msg); },
    // alias used in implementation B tests
    _emitUserDeviceChange: (msg) => { if (udcFn) udcFn(msg); },
    unlock: vi.fn(async (n) => ({ ok: true, name: n })),
    lock: vi.fn(async (n) => ({ ok: true, name: n })),
    listDevices: vi.fn(async () => [{ deviceUUID: "u1" }]),
    getLoginUser: vi.fn(async () => ({ companyID: "co" })),
    ...over,
  };
  for (const ns of ["schedule", "org", "company", "access", "iot", "presetir"]) {
    if (!hub[ns]) {
      hub[ns] = new Proxy({}, {
        get: (_t, op) => (params) => Promise.resolve({ ns, op: String(op), params }),
      });
    }
  }
  return hub;
}

/** テスト用 Daemon (authState=ok で返す)。 */
function makeDaemon(hubOpts = {}) {
  const hub = makeFakeHub(hubOpts);
  const d = new Daemon({ hub });
  d.authState = "ok";
  return d;
}

/** send を記録する最小 Connection。 */
function makeConn(opts = {}) {
  const sent = [];
  return {
    id: Math.random().toString(36).slice(2),
    send: (obj) => sent.push(obj),
    close: vi.fn(),
    sent,
    ...opts,
  };
}

// ---------------------------------------------------------------------------
// EVT-0001: events.subscribe topics param が SUBSCRIBABLE_TOPICS enum を要求する
// ref: entries/events.js:16-23; registry.js:265-267; registry.js:346; registry.js:409
// ---------------------------------------------------------------------------

describe("[EVT-0001] events.subscribe topics param の enum schema", () => {
  it("[EVT-0001] topics param schema が array<items.enum = SUBSCRIBABLE_TOPICS> で registry から導出される", () => {
    const reg = buildRegistry();
    const entry = reg.get("events.subscribe");
    expect(entry, "events.subscribe が registry に登録されている").toBeTruthy();
    const topicsParam = entry.params.find((p) => p.name === "topics");
    expect(topicsParam, "topics param が存在する").toBeTruthy();
    expect(topicsParam.schema).toBeTruthy();
    expect(topicsParam.schema.type).toBe("array");
    expect(topicsParam.schema.items).toBeTruthy();
    expect(topicsParam.schema.items.type).toBe("string");
    // enum が SUBSCRIBABLE_TOPICS と一致する (単一真実源)
    const enumValues = topicsParam.schema.items.enum;
    expect(enumValues).toEqual([...SUBSCRIBABLE_TOPICS]);
    // SUBSCRIBABLE_TOPICS は [lockState, deviceUpdate, deviceListChanged]
    expect(enumValues).toContain("lockState");
    expect(enumValues).toContain("deviceUpdate");
    expect(enumValues).toContain("deviceListChanged");
  });
});

// ---------------------------------------------------------------------------
// EVT-0002: events.subscribe が daemon.subscribe へ正規化済み topics を渡し subscribed を返す
// ref: entries/events.js:25-34; registry-helpers.js:46-49; daemon.js:275-281
// ---------------------------------------------------------------------------

describe("[EVT-0002] events.subscribe → daemon.subscribe → {subscribed}", () => {
  it("[EVT-0002] handler が asTopicList 正規化後 daemon.subscribe を呼び {subscribed} 全体を返す", () => {
    const daemon = makeDaemon();
    const conn = makeConn();
    daemon.addConnection(conn);

    // subscribe → {subscribed: [...set]} を返す
    const result = daemon.subscribe(conn, ["lockState"]);
    expect(result).toMatchObject({ subscribed: expect.arrayContaining(["lockState"]) });
    expect(Array.isArray(result.subscribed)).toBe(true);

    // 追加購読で Set 全体が返る
    const result2 = daemon.subscribe(conn, ["deviceUpdate"]);
    // set は lockState + deviceUpdate の両方を含む
    expect(result2.subscribed).toContain("lockState");
    expect(result2.subscribed).toContain("deviceUpdate");
    expect(result2.subscribed).toHaveLength(2);
  });

  it("[EVT-0002] asTopicList は単一値も配列に包んで正規化する", () => {
    expect(asTopicList("lockState")).toEqual(["lockState"]);
    expect(asTopicList(["lockState", "deviceUpdate"])).toEqual(["lockState", "deviceUpdate"]);
  });

  it("[EVT-0002] events.subscribe handler が asTopicList 後 daemon.subscribe を呼ぶ (handler 経由)", async () => {
    const hub = makeFakeHub();
    const d = new Daemon({ hub });
    d.authState = "ok";
    const conn = makeConn();
    d.addConnection(conn);

    const result = await d.invoke("events.subscribe", { topics: ["lockState"] }, conn);
    expect(result).toMatchObject({ subscribed: expect.arrayContaining(["lockState"]) });
  });
});

// ---------------------------------------------------------------------------
// EVT-0003: events.subscribe を ephemeral 接続で呼ぶと INVALID_REQUEST/bad_params
// ref: entries/events.js:26-29; framing/http.js:130-133; framing/grpc.js:141-142
// ---------------------------------------------------------------------------

describe("[EVT-0003] ephemeral 接続で events.subscribe を呼ぶと INVALID_REQUEST/BAD_PARAMS", () => {
  it("[EVT-0003] conn.ephemeral=true ならば eventsNeedPersistent エラーを投げ購読を張らない", async () => {
    const hub = makeFakeHub();
    const d = new Daemon({ hub });
    d.authState = "ok";
    const ephemeralConn = makeConn({ ephemeral: true });
    d.addConnection(ephemeralConn);

    await expect(
      d.invoke("events.subscribe", { topics: ["lockState"] }, ephemeralConn)
    ).rejects.toMatchObject({
      code: RPC.INVALID_REQUEST,
      kind: KIND.BAD_PARAMS,
    });

    // 購読が記録されていない
    expect(d._subs.get(ephemeralConn).size).toBe(0);
  });

  it("[EVT-0003] ephemeral 接続では購読 Set に topic が追加されない", async () => {
    const hub = makeFakeHub();
    const d = new Daemon({ hub });
    d.authState = "ok";
    const ephemeralConn = makeConn({ ephemeral: true });
    d.addConnection(ephemeralConn);

    try {
      await d.invoke("events.subscribe", { topics: ["lockState"] }, ephemeralConn);
    } catch { /* expected */ }

    const set = d._subs.get(ephemeralConn);
    expect(set?.size ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// EVT-0004: events.subscribe の未知 topic は INVALID_PARAMS で拒否
// ref: entries/events.js:30-32; tests/serve/clients-js.test.js:99-105
// ---------------------------------------------------------------------------

describe("[EVT-0004] 未知 topic は INVALID_PARAMS/BAD_PARAMS で拒否する", () => {
  it("[EVT-0004] TOPICS に無い topic を含むと unknownTopics エラーを投げ黙殺しない", async () => {
    const hub = makeFakeHub();
    const d = new Daemon({ hub });
    d.authState = "ok";
    const conn = makeConn();
    d.addConnection(conn);

    await expect(
      d.invoke("events.subscribe", { topics: ["bogus_topic"] }, conn)
    ).rejects.toMatchObject({
      code: RPC.INVALID_PARAMS,
      kind: KIND.BAD_PARAMS,
    });
  });

  it("[EVT-0004] 有効 topic と未知 topic を混在させると未知 topic 名を列挙してエラー", async () => {
    const hub = makeFakeHub();
    const d = new Daemon({ hub });
    d.authState = "ok";
    const conn = makeConn();
    d.addConnection(conn);

    const err = await d.invoke(
      "events.subscribe",
      { topics: ["lockState", "bogus_topic"] },
      conn
    ).catch((e) => e);

    expect(err.code).toBe(RPC.INVALID_PARAMS);
    expect(err.kind).toBe(KIND.BAD_PARAMS);
    // 悪い topic 名が message に含まれる (黙殺しない)
    expect(err.message).toMatch(/bogus_topic/);
  });
});

// ---------------------------------------------------------------------------
// EVT-0005: events.unsubscribe が daemon.unsubscribe を呼び残存 subscribed を返す
// ref: entries/events.js:36-44; daemon.js:288-294; phase4-surfaces.test.js:458-459
// ---------------------------------------------------------------------------

describe("[EVT-0005] events.unsubscribe → daemon.unsubscribe → {subscribed: 残存}", () => {
  it("[EVT-0005] unsubscribe 後は削除した topic が subscribed に含まれず残存のみ返す", () => {
    const daemon = makeDaemon();
    const conn = makeConn();
    daemon.addConnection(conn);
    daemon.subscribe(conn, ["lockState", "deviceUpdate"]);

    const result = daemon.unsubscribe(conn, ["lockState"]);
    // lockState は削除され deviceUpdate のみ残る
    expect(result).toMatchObject({ subscribed: ["deviceUpdate"] });
    expect(result.subscribed).not.toContain("lockState");
  });

  it("[EVT-0005] unsubscribe の topics enum schema も SUBSCRIBABLE_TOPICS と一致する (subscribe と対称)", () => {
    const reg = buildRegistry();
    const entry = reg.get("events.unsubscribe");
    const topicsParam = entry.params.find((p) => p.name === "topics");
    expect(topicsParam).toBeTruthy();
    expect(topicsParam.schema.type).toBe("array");
    expect(topicsParam.schema.items.enum).toEqual([...SUBSCRIBABLE_TOPICS]);
  });

  it("[EVT-0005] events.unsubscribe handler 経由でも {subscribed} を返す", async () => {
    const hub = makeFakeHub();
    const d = new Daemon({ hub });
    d.authState = "ok";
    const conn = makeConn();
    d.addConnection(conn);

    await d.invoke("events.subscribe", { topics: ["lockState", "deviceUpdate"] }, conn);
    const result = await d.invoke("events.unsubscribe", { topics: ["lockState"] }, conn);
    expect(result).toMatchObject({ subscribed: ["deviceUpdate"] });
  });
});

// ---------------------------------------------------------------------------
// EVT-0006: events.unsubscribe は未登録接続でも空 subscribed を返す (寛容)
// ref: daemon.js:288-294; daemon.js:275-281
// ---------------------------------------------------------------------------

describe("[EVT-0006] events.unsubscribe は未登録接続でも throw せず {subscribed:[]} を返す", () => {
  it("[EVT-0006] _subs に無い conn でも unsubscribe は {subscribed:[]} を返す", () => {
    const daemon = makeDaemon();
    // addConnection を呼ばない → _subs に登録されていない
    const conn = makeConn();
    const result = daemon.unsubscribe(conn, ["lockState"]);
    expect(result).toEqual({ subscribed: [] });
  });

  it("[EVT-0006] 対比: subscribe は未登録接続で INTERNAL を投げる (非対称)", () => {
    const daemon = makeDaemon();
    const conn = makeConn();
    // addConnection せずに subscribe → INTERNAL
    expect(() => daemon.subscribe(conn, ["lockState"])).toThrow(
      expect.objectContaining({ kind: KIND.INTERNAL })
    );
  });
});

// ---------------------------------------------------------------------------
// EVT-0007: 購読リースは接続単位 Map<Connection,Set<topic>> で daemon が一元所有
// ref: daemon.js:94-95; daemon.js:177-190; daemon.js:275-294; daemon.js:361-368
// ---------------------------------------------------------------------------

describe("[EVT-0007] 購読リースは接続単位 Map<Connection,Set<topic>>", () => {
  it("[EVT-0007] _subs は Map で、addConnection で new Set を作り removeConnection で delete する", () => {
    const daemon = makeDaemon();
    const conn = makeConn();

    // 初期状態: _subs に conn は無い
    expect(daemon._subs.has(conn)).toBe(false);

    // addConnection: new Set が作られる
    daemon.addConnection(conn);
    expect(daemon._subs.has(conn)).toBe(true);
    expect(daemon._subs.get(conn)).toBeInstanceOf(Set);
    expect(daemon._subs.get(conn).size).toBe(0);

    // subscribe: topic が Set に追加される
    daemon.subscribe(conn, ["lockState"]);
    expect(daemon._subs.get(conn).has("lockState")).toBe(true);

    // unsubscribe: topic が Set から削除される
    daemon.unsubscribe(conn, ["lockState"]);
    expect(daemon._subs.get(conn).has("lockState")).toBe(false);

    // removeConnection: Set が _subs から削除される
    daemon.removeConnection(conn);
    expect(daemon._subs.has(conn)).toBe(false);
  });

  it("[EVT-0007] 複数接続は別々の Set を持つ (一元所有で fan-out)", () => {
    const hub = makeFakeHub();
    const d = new Daemon({ hub });
    const a = makeConn(), b = makeConn();
    d.addConnection(a); d.addConnection(b);

    d.subscribe(a, ["lockState"]);
    d.subscribe(b, ["deviceUpdate"]);

    expect(d._subs.get(a).has("lockState")).toBe(true);
    expect(d._subs.get(a).has("deviceUpdate")).toBe(false);
    expect(d._subs.get(b).has("deviceUpdate")).toBe(true);
    expect(d._subs.get(b).has("lockState")).toBe(false);
  });

  it("[EVT-0007] hub への購読 (onDeviceUpdate) は 1 本だけ張られる (fan-out 構造)", () => {
    const hub = makeFakeHub({
      connected: true,
      devices: { front: { deviceUUID: "u1", deviceModel: "sesame_5" } },
    });
    let duCount = 0;
    hub.onDeviceUpdate = (_items, fn) => {
      duCount++;
      return () => {};
    };
    const daemon = new Daemon({ hub });
    const a = makeConn(), b = makeConn();
    daemon.addConnection(a);
    daemon.addConnection(b);
    daemon.subscribe(a, ["lockState"]);
    daemon.subscribe(b, ["deviceUpdate"]);
    // hub への購読は 1 本だけ
    expect(duCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// EVT-0008: subscribe は hub 未接続なら subscribe frame を遅延し接続時に張る
// ref: daemon.js:301-325; daemon.js:122-154; daemon.js:114-120
// ---------------------------------------------------------------------------

describe("[EVT-0008] hub 未接続なら _ensureStateSub が早期 return し遅延張りになる", () => {
  it("[EVT-0008] hub.connected=false の間 _stateUnsub は null のまま (subscribe frame 未送)", () => {
    const hub = makeFakeHub({ connected: false });
    let duCallCount = 0;
    hub.onDeviceUpdate = (_items, fn) => { duCallCount++; return () => {}; };

    const daemon = new Daemon({ hub });
    const conn = makeConn();
    daemon.addConnection(conn);
    daemon.subscribe(conn, ["lockState"]);

    // hub 未接続なので onDeviceUpdate は呼ばれていない
    expect(duCallCount).toBe(0);
    expect(daemon._stateUnsub).toBeNull();
  });

  it("[EVT-0008] 購読 topic は hub 未接続でも _subs に記録される", () => {
    const hub = makeFakeHub({ connected: false });
    const daemon = new Daemon({ hub });
    const conn = makeConn();
    daemon.addConnection(conn);
    daemon.subscribe(conn, ["lockState"]);

    // topic は記録されている
    expect(daemon._subs.get(conn).has("lockState")).toBe(true);
    // だが hub フレームは張られていない
    expect(daemon._stateUnsub).toBeNull();
  });

  it("[EVT-0008] hub 接続後に _ensureStateSub を呼ぶと hub フレームが張られる", () => {
    const hub = makeFakeHub({ connected: false });
    const d = new Daemon({ hub });
    const conn = makeConn();
    d.addConnection(conn);
    d.subscribe(conn, ["lockState"]);

    // hub が接続状態に変わったと仮定
    hub.connected = true;
    d._ensureStateSub();
    expect(d._stateUnsub).not.toBeNull();
  });

  it("[EVT-0008] start() が onReconnect を hub に登録し接続復帰時に _reestablishStateSub を呼ぶ", () => {
    const hub = makeFakeHub({ connected: false });
    let reconnectCb = null;
    hub.onReconnect = vi.fn((cb) => { reconnectCb = cb; });
    hub.connect = vi.fn(async () => {});

    const daemon = new Daemon({ hub });
    daemon.start();

    // onReconnect が登録されている
    expect(hub.onReconnect).toHaveBeenCalled();
    expect(typeof reconnectCb).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// EVT-0009: 最後の購読者が外れたら hub 状態購読を teardown
// ref: daemon.js:296-299; daemon.js:338-350; daemon.js:187-190
// ---------------------------------------------------------------------------

describe("[EVT-0009] 最後の購読者離脱で hub 状態購読を teardown", () => {
  it("[EVT-0009] unsubscribe で _anySubscribers()=false になると _stateUnsub が null になる", () => {
    const hub = makeFakeHub({ connected: true, devices: {} });
    const daemon = new Daemon({ hub });
    const conn = makeConn();
    daemon.addConnection(conn);
    daemon.subscribe(conn, ["lockState"]);
    expect(daemon._stateUnsub).not.toBeNull();

    daemon.unsubscribe(conn, ["lockState"]);
    expect(daemon._stateUnsub).toBeNull();
  });

  it("[EVT-0009] removeConnection でも最後の購読者離脱なら teardown される", () => {
    const hub = makeFakeHub({ connected: true, devices: {} });
    const daemon = new Daemon({ hub });
    const conn = makeConn();
    daemon.addConnection(conn);
    daemon.subscribe(conn, ["lockState"]);
    expect(daemon._stateUnsub).not.toBeNull();

    daemon.removeConnection(conn);
    expect(daemon._stateUnsub).toBeNull();
  });

  it("[EVT-0009] _anySubscribers() は誰か購読していれば true、全員ゼロなら false", () => {
    const daemon = makeDaemon();
    const a = makeConn(), b = makeConn();
    daemon.addConnection(a);
    daemon.addConnection(b);
    // 初期: 全員ゼロ
    expect(daemon._anySubscribers()).toBe(false);

    daemon.subscribe(a, ["lockState"]);
    expect(daemon._anySubscribers()).toBe(true);

    daemon.unsubscribe(a, ["lockState"]);
    expect(daemon._anySubscribers()).toBe(false);
  });

  it("[EVT-0009] 複数購読者の最後が外れた時のみ teardown (途中は維持)", () => {
    const hub = makeFakeHub();
    const d = new Daemon({ hub });
    const a = makeConn(), b = makeConn();
    d.addConnection(a); d.addConnection(b);

    d.subscribe(a, ["lockState"]);
    d.subscribe(b, ["deviceUpdate"]);
    expect(d._stateUnsub).not.toBeNull();

    // a を解除してもまだ b がいる → teardown しない
    d.unsubscribe(a, ["lockState"]);
    expect(d._stateUnsub).not.toBeNull();

    // b も解除 → teardown
    d.unsubscribe(b, ["deviceUpdate"]);
    expect(d._stateUnsub).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// EVT-0010: hub 状態購読の subscribeDevicesUpdate frame が vendor と同形
// ref: core/src/devices.js:295-307; core/src/client.js:1550-1560
// ---------------------------------------------------------------------------

describe("[EVT-0010] subscribeDevicesUpdate frame が {action:'biz3ManageDevice', op:'subscribeDevicesUpdate', items, companyID}", () => {
  it("[EVT-0010] subscribeDevicesUpdate の送信 frame 形が vendor と一致する", async () => {
    const { subscribeDevicesUpdate } = await import("@sesame-kit/core/devices");
    const sent = [];
    const fakeClient = {
      send: (frame) => sent.push(frame),
      subscribe: vi.fn(() => () => {}),
      onMessage: vi.fn(() => () => {}),
    };
    subscribeDevicesUpdate(fakeClient, {
      companyID: "co-test",
      items: [{ deviceUUID: "u1", deviceModel: "sesame_5" }],
      onUpdate: () => {},
    });

    expect(sent).toHaveLength(1);
    const frame = sent[0];
    // vendor: useManageDevice.js:325-331
    expect(frame.action).toBe("biz3ManageDevice");
    expect(frame.op).toBe("subscribeDevicesUpdate");
    expect(frame.companyID).toBe("co-test");
    expect(frame.items).toEqual([{ deviceUUID: "u1", deviceModel: "sesame_5" }]);
  });
});

// ---------------------------------------------------------------------------
// EVT-0011: config.devices から subscribe frame の items を構築する
// ref: daemon.js:302-314; references_web/src/api/useManageDevice.js:336-350
// ---------------------------------------------------------------------------

describe("[EVT-0011] config.devices → Object.values → {deviceUUID, deviceModel} items", () => {
  it("[EVT-0011] _ensureStateSub が hub.config.devices を Object.values で items に写像する", () => {
    const devices = {
      front: { deviceUUID: "u1", deviceModel: "sesame_5", name: "front door" },
      back: { deviceUUID: "u2", deviceModel: "sesame_4", name: "back door" },
    };
    const hub = makeFakeHub({ connected: true, devices });
    let capturedItems = null;
    hub.onDeviceUpdate = (items, fn) => {
      capturedItems = items;
      return () => {};
    };
    const daemon = new Daemon({ hub });
    const conn = makeConn();
    daemon.addConnection(conn);
    daemon.subscribe(conn, ["lockState"]);

    // items は {deviceUUID, deviceModel} の配列 (name 等の余分なフィールドを含まない)
    expect(capturedItems).toHaveLength(2);
    for (const item of capturedItems) {
      expect(item).toHaveProperty("deviceUUID");
      expect(item).toHaveProperty("deviceModel");
      // name フィールドは items に含まれない (vendor の map と一致)
      expect(item).not.toHaveProperty("name");
    }
    const uuids = capturedItems.map((i) => i.deviceUUID).sort();
    expect(uuids).toEqual(["u1", "u2"]);
  });
});

// ---------------------------------------------------------------------------
// EVT-0012: state push の購読 key が biz3TriggerLocker:pubDeviceStateChange
// ref: core/src/devices.js:277-307; core/src/devices.js:284; core/src/client.js:98
// ---------------------------------------------------------------------------

describe("[EVT-0012] state push 受信 key は biz3TriggerLocker:pubDeviceStateChange", () => {
  it("[EVT-0012] subscribeDevicesUpdate が subscribe key 'biz3TriggerLocker:pubDeviceStateChange' を使う", async () => {
    const { subscribeDevicesUpdate } = await import("@sesame-kit/core/devices");
    const subscribed = [];
    const fakeClient = {
      send: () => {},
      subscribe: vi.fn((key, fn) => { subscribed.push(key); return () => {}; }),
    };
    subscribeDevicesUpdate(fakeClient, {
      companyID: "co",
      items: [],
      onUpdate: () => {},
    });
    expect(subscribed).toContain("biz3TriggerLocker:pubDeviceStateChange");
  });

  it("[EVT-0012] push 本体 {deviceUUID, stateInfo} が onUpdate へ素通し配送される", async () => {
    const { subscribeDevicesUpdate } = await import("@sesame-kit/core/devices");
    const received = [];
    let subscriberFn = null;
    const fakeClient = {
      send: () => {},
      subscribe: (key, fn) => { subscriberFn = fn; return () => {}; },
    };
    subscribeDevicesUpdate(fakeClient, {
      companyID: "co",
      items: [],
      onUpdate: (msg) => received.push(msg),
    });

    const push = { deviceUUID: "u1", stateInfo: { locked: true } };
    subscriberFn(push);
    expect(received).toHaveLength(1);
    expect(received[0]).toHaveProperty("deviceUUID", "u1");
    expect(received[0]).toHaveProperty("stateInfo");
  });
});

// ---------------------------------------------------------------------------
// EVT-0013: lockState と deviceUpdate は同一ストリームを別ラベルで配送 (二重配信しない)
// ref: daemon.js:352-368; registry.js:264-265
// ---------------------------------------------------------------------------

describe("[EVT-0013] 両 topic 購読接続には STATE_TOPICS.find で 1 回だけ event を送る", () => {
  it("[EVT-0013] lockState と deviceUpdate を両方購読しても 1 push で event は 1 件 (二重配信なし)", () => {
    const hub = makeFakeHub({ connected: true, devices: {} });
    const daemon = new Daemon({ hub });
    const conn = makeConn();
    daemon.addConnection(conn);
    daemon.subscribe(conn, ["lockState", "deviceUpdate"]);

    // event.ready を除いたイベントをフィルタ
    const events = () => conn.sent.filter((m) => m.method !== "event.ready");
    expect(events()).toHaveLength(0);

    hub._emit({ deviceUUID: "u1", stateInfo: {} });
    // 1 メッセージにつき 1 件だけ配信 (二重配信しない)
    expect(events()).toHaveLength(1);
    // STATE_TOPICS.find で最初に一致する topic (lockState) のラベルで配信
    expect(events()[0].method).toBe("event.lockState");
  });

  it("[EVT-0013] STATE_TOPICS は [lockState, deviceUpdate] の 2 件", () => {
    expect(STATE_TOPICS).toEqual(["lockState", "deviceUpdate"]);
  });
});

// ---------------------------------------------------------------------------
// EVT-0014: _fanout は購読 topic を持つ接続だけに makeEvent 封筒を送る
// ref: daemon.js:360-368; core/src/jsonrpc.js:377-379
// ---------------------------------------------------------------------------

describe("[EVT-0014] _fanout は購読接続のみへ {jsonrpc:'2.0',method:'event.<topic>',params:msg} を送る", () => {
  it("[EVT-0014] 購読していない接続には push されず、購読接続には makeEvent 封筒が届く", () => {
    const hub = makeFakeHub({ connected: true, devices: {} });
    const daemon = new Daemon({ hub });
    const subscriber = makeConn();
    const nonSubscriber = makeConn();
    daemon.addConnection(subscriber);
    daemon.addConnection(nonSubscriber);

    daemon.subscribe(subscriber, ["lockState"]);
    // nonSubscriber は購読しない

    const subEvents = () => subscriber.sent.filter((m) => m.method !== "event.ready");
    const nonSubEvents = () => nonSubscriber.sent.filter((m) => m.method !== "event.ready");

    hub._emit({ deviceUUID: "u1" });

    // 購読接続には 1 件届く
    expect(subEvents()).toHaveLength(1);
    expect(subEvents()[0]).toMatchObject({
      jsonrpc: "2.0",
      method: "event.lockState",
    });
    // 非購読接続には届かない
    expect(nonSubEvents()).toHaveLength(0);
  });

  it("[EVT-0014] makeEvent は {jsonrpc:'2.0', method:'event.<topic>', params:payload} を返す", () => {
    const ev = makeEvent("lockState", { deviceUUID: "u1" });
    expect(ev).toEqual({
      jsonrpc: "2.0",
      method: "event.lockState",
      params: { deviceUUID: "u1" },
    });
  });

  it("[EVT-0014] _fanout が topic=undefined (非購読) の接続を skip する", () => {
    const hub = makeFakeHub({ connected: true, devices: {} });
    const d = new Daemon({ hub });
    const conn = makeConn();
    d.addConnection(conn);
    // 購読しない (Set は空)

    hub._emit({ deviceUUID: "u1" });
    const events = conn.sent.filter((m) => m.method !== "event.ready");
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// EVT-0015: deviceListChanged は pubUserDeviceChange 源の別ストリームとして fan-out
// ref: daemon.js:315-324; daemon.js:370-380; core/src/devices.js:309-329
// ---------------------------------------------------------------------------

describe("[EVT-0015] deviceListChanged は pubUserDeviceChange 源の別ストリーム (_fanoutTopic)", () => {
  it("[EVT-0015] onUserDeviceChange コールバックが _fanoutTopic('deviceListChanged') を呼ぶ", () => {
    const hub = makeFakeHub({ connected: true, devices: {} });
    const daemon = new Daemon({ hub });
    const conn = makeConn();
    daemon.addConnection(conn);
    daemon.subscribe(conn, ["deviceListChanged"]);

    // event.ready を除くイベント
    const dlcEvents = () => conn.sent.filter((m) => m.method === "event.deviceListChanged");
    expect(dlcEvents()).toHaveLength(0);

    // pubUserDeviceChange を模擬
    hub._emitUDC({ deviceUUID: "u2", op: "pubUserDeviceChange" });
    expect(dlcEvents()).toHaveLength(1);
    expect(dlcEvents()[0]).toMatchObject({
      jsonrpc: "2.0",
      method: "event.deviceListChanged",
    });
  });

  it("[EVT-0015] subscribeUserDeviceChange の subscribe key が biz3TriggerLocker:pubUserDeviceChange", async () => {
    const subscribeKeys = [];
    const fakeWsClient = {
      subscribe: (key, _fn) => { subscribeKeys.push(key); return () => {}; },
    };
    const { subscribeUserDeviceChange } = await import("@sesame-kit/core/devices");
    subscribeUserDeviceChange(fakeWsClient, { onChange: vi.fn() });

    expect(subscribeKeys).toContain("biz3TriggerLocker:pubUserDeviceChange");
  });

  it("[EVT-0015] deviceListChanged は STATE_TOPICS (pubDeviceStateChange 源) では配送されない", () => {
    const hub = makeFakeHub({ connected: true, devices: {} });
    const daemon = new Daemon({ hub });
    const conn = makeConn();
    daemon.addConnection(conn);
    daemon.subscribe(conn, ["deviceListChanged"]);

    const dlcEvents = () => conn.sent.filter((m) => m.method === "event.deviceListChanged");
    // STATE 源 (pubDeviceStateChange) のイベント emit
    hub._emit({ deviceUUID: "u1", stateInfo: {} });
    // deviceListChanged は届かない (別ストリーム)
    expect(dlcEvents()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// EVT-0016: deviceListChanged 購読は SUBSCRIBABLE_TOPICS に含まれるが STATE_TOPICS には含まれない
// ref: registry.js:264-267; entries/events.js:22,30-33; daemon.js:361-380
// ---------------------------------------------------------------------------

describe("[EVT-0016] deviceListChanged は SUBSCRIBABLE_TOPICS にあるが STATE_TOPICS には無い", () => {
  it("[EVT-0016] SUBSCRIBABLE_TOPICS に deviceListChanged が含まれる", () => {
    expect(SUBSCRIBABLE_TOPICS).toContain("deviceListChanged");
  });

  it("[EVT-0016] STATE_TOPICS に deviceListChanged は含まれない", () => {
    expect(STATE_TOPICS).not.toContain("deviceListChanged");
  });

  it("[EVT-0016] events.subscribe は deviceListChanged を受理する (enum に含まれる)", async () => {
    const hub = makeFakeHub();
    const d = new Daemon({ hub });
    d.authState = "ok";
    const conn = makeConn();
    d.addConnection(conn);

    // throw しないことを確認
    const result = await d.invoke(
      "events.subscribe",
      { topics: ["deviceListChanged"] },
      conn
    );
    expect(result).toMatchObject({ subscribed: ["deviceListChanged"] });
  });

  it("[EVT-0016] _fanout (STATE_TOPICS) は deviceListChanged を配送せず _fanoutTopic のみが担う", () => {
    const hub = makeFakeHub({ connected: true, devices: {} });
    const daemon = new Daemon({ hub });
    const conn = makeConn();
    daemon.addConnection(conn);
    daemon.subscribe(conn, ["deviceListChanged"]);

    // _fanout 経路 (STATE 源) では deviceListChanged は届かない
    const dlcViaState = () => conn.sent.filter((m) => m.method === "event.deviceListChanged");
    hub._emit({ deviceUUID: "u1" });
    expect(dlcViaState()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// EVT-0017: event.ready は全永続接続の確立時に 1 本だけ発火、ephemeral には送らない
// ref: daemon.js:177-184; tests/serve/daemon.test.js:213-223
// ---------------------------------------------------------------------------

describe("[EVT-0017] event.ready は永続接続確立時に 1 本だけ発火", () => {
  it("[EVT-0017] addConnection が非 ephemeral 接続へ makeEvent('ready',{}) を 1 本送る", () => {
    const daemon = makeDaemon();
    const conn = makeConn();
    daemon.addConnection(conn);

    expect(conn.sent).toHaveLength(1);
    expect(conn.sent[0]).toMatchObject({
      jsonrpc: "2.0",
      method: "event.ready",
      params: {},
    });
    // 通知 (RPC id 無し)
    expect(conn.sent[0]).not.toHaveProperty("id");
  });

  it("[EVT-0017] ephemeral 接続には event.ready を送らない", () => {
    const daemon = makeDaemon();
    const ephemeral = makeConn({ ephemeral: true });
    daemon.addConnection(ephemeral);
    // ephemeral には何も送らない
    expect(ephemeral.sent).toHaveLength(0);
  });

  it("[EVT-0017] makeEvent('ready', {}) の形が {jsonrpc:2.0, method:event.ready, params:{}}", () => {
    const ev = makeEvent("ready", {});
    expect(ev).toEqual({ jsonrpc: "2.0", method: "event.ready", params: {} });
  });
});

// ---------------------------------------------------------------------------
// EVT-0018: event.ready は購読不可な broadcast で x-event-topics に含めない
// ref: registry.js:401-409; daemon.js:179-183
// ---------------------------------------------------------------------------

describe("[EVT-0018] event.ready は x-events に載るが x-event-topics には含めない", () => {
  it("[EVT-0018] openrpc doc の x-events に event.ready が含まれる", async () => {
    const hub = makeFakeHub();
    const d = new Daemon({ hub, version: "1.0.0" });
    d.authState = "ok";
    const doc = await d.invoke("rpc.discover", {}, null);
    const eventNames = doc["x-events"].map((e) => e.name);
    expect(eventNames).toContain("event.ready");
  });

  it("[EVT-0018] x-event-topics に ready は含まれない (購読不可な broadcast)", async () => {
    const hub = makeFakeHub();
    const d = new Daemon({ hub, version: "1.0.0" });
    d.authState = "ok";
    const doc = await d.invoke("rpc.discover", {}, null);
    expect(doc["x-event-topics"]).not.toContain("ready");
    expect(doc["x-event-topics"]).not.toContain("event.ready");
  });

  it("[EVT-0018] x-event-topics は SUBSCRIBABLE_TOPICS と一致する (lockState/deviceUpdate/deviceListChanged)", async () => {
    const hub = makeFakeHub();
    const d = new Daemon({ hub, version: "1.0.0" });
    d.authState = "ok";
    const doc = await d.invoke("rpc.discover", {}, null);
    expect(doc["x-event-topics"]).toEqual([...SUBSCRIBABLE_TOPICS]);
    expect(doc["x-event-topics"]).toContain("lockState");
    expect(doc["x-event-topics"]).toContain("deviceUpdate");
    expect(doc["x-event-topics"]).toContain("deviceListChanged");
  });
});
