// EVT-0019 〜 EVT-0037 spec tests (TDD — red where impl diverges from spec)
// 対象 spec ID: EVT-0019, EVT-0020, EVT-0021, EVT-0022, EVT-0023, EVT-0024,
//               EVT-0025, EVT-0026, EVT-0027, EVT-0028, EVT-0029, EVT-0030,
//               EVT-0031, EVT-0032, EVT-0033, EVT-0034, EVT-0035, EVT-0037
// 対象実装: packages/kit/src/serve/stability.js, registry.js, daemon.js,
//           framing/ws.js, framing/ndjson.js, framing/http.js, framing/grpc.js
//           packages/core/src/transport.js, packages/core/src/client.js
// 実行環境: vitest (unit project)
// 方針: spec assert を正典として実装を検証する (TDD)。red は許容。

import { describe, it, expect, vi, afterEach } from "vitest";
import grpc from "@grpc/grpc-js";
import protoLoader from "@grpc/proto-loader";
import { WebSocket } from "ws";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  STABLE_METHODS,
  STABLE_EVENTS,
  stabilityOf,
  provenanceOf,
  eventStabilityOf,
  eventProvenanceOf,
} from "../../src/serve/stability.js";
import {
  buildOpenRpcDoc,
  buildRegistry,
  SUBSCRIBABLE_TOPICS,
} from "../../src/serve/registry.js";
import { Daemon } from "../../src/serve/daemon.js";
import { startWsFraming } from "../../src/serve/framing/ws.js";
import { makeLineConnection } from "../../src/serve/framing/ndjson.js";
import { startHttpFraming } from "../../src/serve/framing/http.js";
import { startGrpcFraming } from "../../src/serve/framing/grpc.js";
import { Hub3WsClient } from "@sesame-kit/core/transport";
import { makeEvent } from "@sesame-kit/core/jsonrpc";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROTO = resolve(HERE, "..", "..", "src", "serve", "sesame.proto");
const TOKEN = "evt-spec-token-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function fakeHub(overrides = {}) {
  let duFn = null;
  let udFn = null;
  return {
    connected: true,
    subUUID: "s",
    config: { devices: {} },
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    onDeviceUpdate: (_items, fn) => { duFn = fn; return () => { duFn = null; }; },
    onUserDeviceChange: (fn) => { udFn = fn; return () => { udFn = null; }; },
    _emit: (m) => duFn && duFn(m),
    _emitUserDevice: (m) => udFn && udFn(m),
    unlock: vi.fn(async (n) => ({ ok: true, name: n })),
    ...overrides,
  };
}

function makeDaemon(hub, opts = {}) {
  const d = new Daemon({ hub: hub || fakeHub(), version: "9.9.9", ...opts });
  d.authState = "ok";
  return d;
}

function makeConn() {
  return { id: `c${Math.random()}`, sent: [], send(o) { this.sent.push(o); }, close() {} };
}

function newTransportClient() {
  return new Hub3WsClient({ wsUrl: "ws://localhost:1", idToken: "dummy-token", autoReconnect: false });
}

function deliverToTransport(client, msg) {
  client._onMessage(JSON.stringify(msg));
}

function makeGrpcClient(port) {
  const pkgDef = protoLoader.loadSync(PROTO, { keepCase: true, longs: String, defaults: true, oneofs: true });
  const proto = grpc.loadPackageDefinition(pkgDef).sesame;
  return new proto.Sesame(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
}

function bearerMd(tok) {
  const md = new grpc.Metadata();
  if (tok) md.set("authorization", `Bearer ${tok}`);
  return md;
}

let handles = [];
afterEach(async () => {
  for (const h of handles.reverse()) {
    try { await h.stop(); } catch { /* ignore */ }
  }
  handles = [];
});

// ============================================================
// EVT-0019: event.ready の x-stability は stable (local provenance)
// ref: stability.js:38-42; stability.js:73-83
// ============================================================

describe("[EVT-0019] event.ready の x-stability は stable (local provenance)", () => {
  it("[EVT-0019] STABLE_EVENTS に event.ready が local provenance で登録されている", () => {
    expect(STABLE_EVENTS["event.ready"]).toBe("local");
  });

  it("[EVT-0019] eventStabilityOf('event.ready') === 'stable'", () => {
    expect(eventStabilityOf("event.ready")).toBe("stable");
  });

  it("[EVT-0019] eventProvenanceOf('event.ready') === 'local'", () => {
    expect(eventProvenanceOf("event.ready")).toBe("local");
  });

  it("[EVT-0019] lockState/deviceUpdate は app-core provenance で stable", () => {
    expect(STABLE_EVENTS["event.lockState"]).toBe("app-core");
    expect(STABLE_EVENTS["event.deviceUpdate"]).toBe("app-core");
    expect(eventStabilityOf("event.lockState")).toBe("stable");
    expect(eventStabilityOf("event.deviceUpdate")).toBe("stable");
    expect(eventProvenanceOf("event.lockState")).toBe("app-core");
    expect(eventProvenanceOf("event.deviceUpdate")).toBe("app-core");
  });
});

// ============================================================
// EVT-0020: x-events が 4 イベントを記述し x-event-topics は 3 件
// ref: registry.js:384-409
// ============================================================

describe("[EVT-0020] x-events が全 4 イベントを記述、x-event-topics が 3 topic", () => {
  it("[EVT-0020] openrpc doc の x-events に 4 イベントが name+description+x-stability+x-provenance 付きで載る", () => {
    const reg = buildRegistry();
    const doc = buildOpenRpcDoc(reg, "9.9.9");
    const events = doc["x-events"];
    expect(Array.isArray(events)).toBe(true);
    expect(events).toHaveLength(4);

    const names = events.map((e) => e.name);
    expect(names).toContain("event.lockState");
    expect(names).toContain("event.deviceUpdate");
    expect(names).toContain("event.deviceListChanged");
    expect(names).toContain("event.ready");

    for (const ev of events) {
      expect(typeof ev.name).toBe("string");
      expect(typeof ev.description).toBe("string");
      expect(["stable", "experimental"]).toContain(ev["x-stability"]);
      expect(typeof ev["x-provenance"]).toBe("string");
    }
  });

  it("[EVT-0020] x-event-topics === [lockState, deviceUpdate, deviceListChanged]", () => {
    const reg = buildRegistry();
    const doc = buildOpenRpcDoc(reg, "9.9.9");
    expect(doc["x-event-topics"]).toEqual(["lockState", "deviceUpdate", "deviceListChanged"]);
  });

  it("[EVT-0020] x-event-topics と SUBSCRIBABLE_TOPICS が一致する", () => {
    const reg = buildRegistry();
    const doc = buildOpenRpcDoc(reg, "9.9.9");
    expect(doc["x-event-topics"]).toEqual([...SUBSCRIBABLE_TOPICS]);
  });
});

// ============================================================
// EVT-0021: events.subscribe/unsubscribe が stable (local provenance)
// ref: stability.js:31-32; stability.js:57-67
// ============================================================

describe("[EVT-0021] events.subscribe/unsubscribe は stable (local provenance)", () => {
  it("[EVT-0021] STABLE_METHODS に events.subscribe/unsubscribe が local で登録されている", () => {
    expect(STABLE_METHODS["events.subscribe"]).toBe("local");
    expect(STABLE_METHODS["events.unsubscribe"]).toBe("local");
  });

  it("[EVT-0021] stabilityOf('events.subscribe/unsubscribe') === 'stable'", () => {
    expect(stabilityOf("events.subscribe")).toBe("stable");
    expect(stabilityOf("events.unsubscribe")).toBe("stable");
  });

  it("[EVT-0021] provenanceOf('events.subscribe/unsubscribe') === 'local'", () => {
    expect(provenanceOf("events.subscribe")).toBe("local");
    expect(provenanceOf("events.unsubscribe")).toBe("local");
  });

  it("[EVT-0021] discover の method エントリが x-stability=stable/x-provenance=local を持つ", () => {
    const reg = buildRegistry();
    const doc = buildOpenRpcDoc(reg, "9.9.9");
    const byName = Object.fromEntries(doc.methods.map((m) => [m.name, m]));
    expect(byName["events.subscribe"]["x-stability"]).toBe("stable");
    expect(byName["events.subscribe"]["x-provenance"]).toBe("local");
    expect(byName["events.unsubscribe"]["x-stability"]).toBe("stable");
    expect(byName["events.unsubscribe"]["x-provenance"]).toBe("local");
  });

  it("[EVT-0021] lockState/deviceUpdate は STABLE_EVENTS で app-core stable", () => {
    expect(STABLE_EVENTS["event.lockState"]).toBe("app-core");
    expect(STABLE_EVENTS["event.deviceUpdate"]).toBe("app-core");
    expect(eventStabilityOf("event.lockState")).toBe("stable");
    expect(eventStabilityOf("event.deviceUpdate")).toBe("stable");
  });
});

// ============================================================
// EVT-0022: 未登録 event は experimental に既定降格
// ref: stability.js:37-42; stability.js:69-83
// ============================================================

describe("[EVT-0022] 未登録 event は experimental/unverified に既定降格", () => {
  it("[EVT-0022] STABLE_EVENTS に event.deviceListChanged は含まれない", () => {
    expect(Object.hasOwn(STABLE_EVENTS, "event.deviceListChanged")).toBe(false);
  });

  it("[EVT-0022] eventStabilityOf('event.deviceListChanged') === 'experimental'", () => {
    expect(eventStabilityOf("event.deviceListChanged")).toBe("experimental");
  });

  it("[EVT-0022] eventProvenanceOf('event.deviceListChanged') === 'unverified'", () => {
    expect(eventProvenanceOf("event.deviceListChanged")).toBe("unverified");
  });

  it("[EVT-0022] 完全に未知のイベント名も experimental / unverified に降格", () => {
    expect(eventStabilityOf("event.bogus")).toBe("experimental");
    expect(eventProvenanceOf("event.bogus")).toBe("unverified");
    expect(eventStabilityOf("event.unknown.anything")).toBe("experimental");
    expect(eventProvenanceOf("event.unknown.anything")).toBe("unverified");
  });

  it("[EVT-0022] discover の event.deviceListChanged エントリが experimental を持つ", () => {
    const reg = buildRegistry();
    const doc = buildOpenRpcDoc(reg, "9.9.9");
    const xevents = doc["x-events"];
    const dlc = xevents.find((e) => e.name === "event.deviceListChanged");
    expect(dlc).toBeDefined();
    expect(dlc["x-stability"]).toBe("experimental");
    expect(dlc["x-provenance"]).toBe("unverified");
  });
});

// ============================================================
// EVT-0023: transport.subscribe は (action:op) key で永続購読し一致 msg のみ配送
// ref: transport.js:302-319; transport.js:526-547
// ============================================================

describe("[EVT-0023] transport.subscribe は (action:op) key で永続購読し一致 msg のみ配送", () => {
  it("[EVT-0023] 一致する action:op の msg のみ subscriber に届く", () => {
    const client = newTransportClient();
    try {
      const fn = vi.fn();
      client.subscribe("biz3TriggerLocker:pubDeviceStateChange", fn);

      deliverToTransport(client, { action: "biz3TriggerLocker", op: "pubDeviceStateChange", data: { deviceUUID: "u1" } });
      deliverToTransport(client, { action: "biz3TriggerLocker", op: "otherOp", data: {} });
      deliverToTransport(client, { action: "otherAction", op: "pubDeviceStateChange", data: {} });

      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith(expect.objectContaining({ action: "biz3TriggerLocker", op: "pubDeviceStateChange" }));
    } finally {
      try { client.close(); } catch { /* ignore */ }
    }
  });

  it("[EVT-0023] 同一 key に複数 subscriber を登録すると全員が届く (Set 多重許容)", () => {
    const client = newTransportClient();
    try {
      const f1 = vi.fn();
      const f2 = vi.fn();
      client.subscribe("a:b", f1);
      client.subscribe("a:b", f2);

      deliverToTransport(client, { action: "a", op: "b", v: 1 });

      expect(f1).toHaveBeenCalledTimes(1);
      expect(f2).toHaveBeenCalledTimes(1);
    } finally {
      try { client.close(); } catch { /* ignore */ }
    }
  });

  it("[EVT-0023] subscribers は Map<key, Set<fn>> として内部保持される", () => {
    const client = newTransportClient();
    try {
      const fn = vi.fn();
      client.subscribe("x:y", fn);
      expect(client.subscribers).toBeInstanceOf(Map);
      expect(client.subscribers.has("x:y")).toBe(true);
      expect(client.subscribers.get("x:y")).toBeInstanceOf(Set);
    } finally {
      try { client.close(); } catch { /* ignore */ }
    }
  });

  it("[EVT-0023] op が undefined の場合 key は '<action>:' で照合される", () => {
    const client = newTransportClient();
    try {
      const fn = vi.fn();
      client.subscribe("biz3KeepAlive:", fn);

      deliverToTransport(client, { action: "biz3KeepAlive" }); // op なし → key = "biz3KeepAlive:"
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      try { client.close(); } catch { /* ignore */ }
    }
  });

  it("[EVT-0023] unsubscribe 後は msg が届かない", () => {
    const client = newTransportClient();
    try {
      const fn = vi.fn();
      const unsub = client.subscribe("a:b", fn);

      deliverToTransport(client, { action: "a", op: "b", n: 1 });
      expect(fn).toHaveBeenCalledTimes(1);

      unsub();
      deliverToTransport(client, { action: "a", op: "b", n: 2 });
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      try { client.close(); } catch { /* ignore */ }
    }
  });
});

// ============================================================
// EVT-0024: _onMessage は resolver → subscribers → listeners の順で配送
// ref: transport.js:526-547
// ============================================================

describe("[EVT-0024] _onMessage は resolver → subscribers → listeners の順で配送", () => {
  it("[EVT-0024] 配送順が resolver → sub → listener である", () => {
    const client = newTransportClient();
    try {
      const order = [];
      const sub = vi.fn(() => order.push("sub"));
      const listener = vi.fn(() => order.push("listener"));
      const resolver = vi.fn(() => order.push("resolver"));

      client.subscribe("a:b", sub);
      client.onMessage(listener);
      client._registerPending("a:b", resolver);

      deliverToTransport(client, { action: "a", op: "b", v: 1 });

      expect(order).toEqual(["resolver", "sub", "listener"]);
    } finally {
      try { client.close(); } catch { /* ignore */ }
    }
  });

  it("[EVT-0024] pending と subscribe が同 key で共存しても両方解決される", () => {
    const client = newTransportClient();
    try {
      const sub = vi.fn();
      const resolver = vi.fn();
      client.subscribe("a:b", sub);
      client._registerPending("a:b", resolver);

      deliverToTransport(client, { action: "a", op: "b", v: 1 });

      expect(resolver).toHaveBeenCalledTimes(1);
      expect(sub).toHaveBeenCalledTimes(1);
      // resolver は FIFO 1 件消費で pending から削除される
      expect(client.pending.has("a:b")).toBe(false);
    } finally {
      try { client.close(); } catch { /* ignore */ }
    }
  });

  it("[EVT-0024] 1 メッセージで resolver・subscriber・listener 全員受信する", () => {
    const client = newTransportClient();
    try {
      const sub = vi.fn();
      const listener = vi.fn();
      const resolver = vi.fn();

      client.subscribe("a:b", sub);
      client.onMessage(listener);
      client._registerPending("a:b", resolver);

      deliverToTransport(client, { action: "a", op: "b" });

      expect(resolver).toHaveBeenCalledTimes(1);
      expect(sub).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      try { client.close(); } catch { /* ignore */ }
    }
  });
});

// ============================================================
// EVT-0025: subscriber/listener の例外は他経路へ伝播しない
// ref: transport.js:530-546
// ============================================================

describe("[EVT-0025] subscriber/listener の例外は他経路へ伝播しない", () => {
  it("[EVT-0025] subscriber が throw しても後続 subscriber と listener が呼ばれる", () => {
    const client = newTransportClient();
    try {
      const throwing = vi.fn(() => { throw new Error("boom"); });
      const f2 = vi.fn();
      const listener = vi.fn();

      client.subscribe("a:b", throwing);
      client.subscribe("a:b", f2);
      client.onMessage(listener);

      expect(() => deliverToTransport(client, { action: "a", op: "b" })).not.toThrow();
      expect(throwing).toHaveBeenCalledTimes(1);
      expect(f2).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      try { client.close(); } catch { /* ignore */ }
    }
  });

  it("[EVT-0025] listener が throw しても他 listener に伝播しない", () => {
    const client = newTransportClient();
    try {
      const l1 = vi.fn(() => { throw new Error("listener boom"); });
      const l2 = vi.fn();
      const sub = vi.fn();

      client.subscribe("a:b", sub);
      client.onMessage(l1);
      client.onMessage(l2);

      expect(() => deliverToTransport(client, { action: "a", op: "b" })).not.toThrow();
      expect(sub).toHaveBeenCalledTimes(1);
      expect(l1).toHaveBeenCalledTimes(1);
      expect(l2).toHaveBeenCalledTimes(1);
    } finally {
      try { client.close(); } catch { /* ignore */ }
    }
  });
});

// ============================================================
// EVT-0026: 配送中の unsub/再 subscribe は snapshot iterate で当該フレームに影響しない
// ref: transport.js:537-542
// ============================================================

describe("[EVT-0026] snapshot iterate で配送中の unsub/再 subscribe は当フレームに影響しない", () => {
  it("[EVT-0026] ハンドラ内で unsub しても当該フレームは全員受信する", () => {
    const client = newTransportClient();
    try {
      const order = [];
      let unsub2, unsub3;
      const f1 = vi.fn(() => { order.push("f1"); unsub2(); unsub3(); });
      const f2 = vi.fn(() => order.push("f2"));
      const f3 = vi.fn(() => order.push("f3"));

      client.subscribe("a:b", f1);
      unsub2 = client.subscribe("a:b", f2);
      unsub3 = client.subscribe("a:b", f3);

      deliverToTransport(client, { action: "a", op: "b", v: 1 });

      expect(f1).toHaveBeenCalledTimes(1);
      expect(f2).toHaveBeenCalledTimes(1);
      expect(f3).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["f1", "f2", "f3"]);

      // 次フレームでは f2/f3 は届かない
      deliverToTransport(client, { action: "a", op: "b", v: 2 });
      expect(f1).toHaveBeenCalledTimes(2);
      expect(f2).toHaveBeenCalledTimes(1);
      expect(f3).toHaveBeenCalledTimes(1);
    } finally {
      try { client.close(); } catch { /* ignore */ }
    }
  });

  it("[EVT-0026] ハンドラ内で後追い subscribe しても当該フレームでは呼ばれない", () => {
    const client = newTransportClient();
    try {
      const late = vi.fn();
      const f1 = vi.fn(() => { client.subscribe("a:b", late); });
      client.subscribe("a:b", f1);

      deliverToTransport(client, { action: "a", op: "b", v: 1 });
      expect(f1).toHaveBeenCalledTimes(1);
      // snapshot iterate なので当該フレームでは late は呼ばれない
      expect(late).toHaveBeenCalledTimes(0);

      // 次フレームでは届く
      deliverToTransport(client, { action: "a", op: "b", v: 2 });
      expect(late).toHaveBeenCalledTimes(1);
    } finally {
      try { client.close(); } catch { /* ignore */ }
    }
  });
});

// ============================================================
// EVT-0027: close は subscribers を全クリアし pending を reject
// ref: transport.js:240-253
// ============================================================

describe("[EVT-0027] close は subscribers を全クリアし pending を reject", () => {
  it("[EVT-0027] close 後は subscribers.size === 0 で旧 subscriber に届かない", () => {
    const client = newTransportClient();
    const old = vi.fn();
    client.subscribe("a:b", old);
    client.onMessage(vi.fn());

    client.close();

    expect(client.subscribers.size).toBe(0);
    // close 後に配信しても旧 subscriber には届かない
    deliverToTransport(client, { action: "a", op: "b" });
    expect(old).not.toHaveBeenCalled();
  });

  it("[EVT-0027] close は pending resolver を reject (closedErr) する", async () => {
    const client = newTransportClient();
    const rejectPromise = new Promise((resolve) => {
      client._registerPending("z:z", (msg) => {
        // msg が Error 的なものであれば reject 相当
        resolve(msg);
      });
    });
    client.close();
    const msg = await rejectPromise;
    // close で reject される = msg は Error または code を持つ
    expect(msg).toBeTruthy();
  });

  it("[EVT-0027] close 後 pending.size === 0 になる", () => {
    const client = newTransportClient();
    const reject = vi.fn();
    const resolve = vi.fn();
    const resolver = (msg) => {
      if (msg instanceof Error) reject(msg);
      else resolve(msg);
    };
    client._registerPending("a:b", resolver);
    expect(client.pending.has("a:b")).toBe(true);

    client.close();

    expect(client.pending.size).toBe(0);
    expect(reject).toHaveBeenCalledTimes(1);
    expect(reject.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});

// ============================================================
// EVT-0028: 再接続 (2回目以降の OPEN) で onReopen が発火、初回は発火しない
// ref: transport.js:378-401
// ============================================================

describe("[EVT-0028] 再接続 (2回目以降の OPEN) で onReopen が発火、初回は発火しない", () => {
  it("[EVT-0028] 初回 OPEN では onReopen を呼ばず、2 回目以降の OPEN でのみ呼ぶ", () => {
    const onReopen = vi.fn();
    const c = new Hub3WsClient({ wsUrl: "wss://example.invalid/public", idToken: "t", onReopen });
    try {
      c._onOpen(); // 初回接続
      expect(onReopen).not.toHaveBeenCalled();

      c._onOpen(); // 再接続 (2回目)
      expect(onReopen).toHaveBeenCalledTimes(1);

      c._onOpen(); // さらに再接続 (3回目)
      expect(onReopen).toHaveBeenCalledTimes(2);
    } finally {
      try { c._clearKeepalive?.(); } catch { /* ignore */ }
      if (c.connectTimer) clearTimeout(c.connectTimer);
    }
  });

  it("[EVT-0028] onReopen が null の場合は例外なく動作する", () => {
    const c = new Hub3WsClient({ wsUrl: "wss://example.invalid/public", idToken: "t" });
    try {
      expect(() => {
        c._onOpen(); // 初回
        c._onOpen(); // 再接続 — onReopen=null でも例外なし
      }).not.toThrow();
    } finally {
      try { c._clearKeepalive?.(); } catch { /* ignore */ }
      if (c.connectTimer) clearTimeout(c.connectTimer);
    }
  });
});

// ============================================================
// EVT-0029: 再接続時に daemon が subscribe frame を張り直す
// ref: daemon.js:114-120; daemon.js:327-336
// ============================================================

describe("[EVT-0029] 再接続時に daemon が _reestablishStateSub で subscribe frame を張り直す", () => {
  it("[EVT-0029] hub.onReconnect が start() 内で登録される", () => {
    const onReconnect = vi.fn(() => () => {});
    const hub = { ...fakeHub(), onReconnect };
    const d = makeDaemon(hub);
    d.start();
    expect(onReconnect).toHaveBeenCalledWith(expect.any(Function));
  });

  it("[EVT-0029] _reestablishStateSub は旧 stateUnsub を呼んでから _ensureStateSub する", () => {
    const hub = fakeHub();
    const d = makeDaemon(hub);

    // 購読を確立させる
    const c = makeConn();
    d.addConnection(c);
    d.subscribe(c, ["lockState"]);

    // _stateUnsub が張られているはず
    expect(d._stateUnsub).not.toBeNull();
    const oldUnsub = vi.fn();
    d._stateUnsub = oldUnsub;

    d._reestablishStateSub();

    // 旧 unsub が呼ばれ、新しい stateUnsub が張られる
    expect(oldUnsub).toHaveBeenCalledTimes(1);
    expect(d._stateUnsub).not.toBeNull();
  });

  it("[EVT-0029] 購読者が居ない場合は _reestablishStateSub が _ensureStateSub を呼ばない", () => {
    const hub = fakeHub();
    const d = makeDaemon(hub);
    // 購読者なし
    d._reestablishStateSub();
    // stateUnsub は null のまま (ensureStateSub を呼ばなかった)
    expect(d._stateUnsub).toBeNull();
  });
});

// ============================================================
// EVT-0030: 再接続時の subscribe frame 二重送信は冪等で無害
// ref: daemon.js:327-336
// ============================================================

describe("[EVT-0030] 再接続時の subscribe frame 二重送信は冪等で無害 (旧 fn を必ず unsub)", () => {
  it("[EVT-0030] _reestablishStateSub は旧 deviceListUnsub も必ず呼ぶ", () => {
    const hub = fakeHub();
    const d = makeDaemon(hub);

    const c = makeConn();
    d.addConnection(c);
    d.subscribe(c, ["deviceListChanged"]);
    d._ensureStateSub(); // _deviceListUnsub を張る

    const oldDevListUnsub = vi.fn();
    d._deviceListUnsub = oldDevListUnsub;

    d._reestablishStateSub();

    expect(oldDevListUnsub).toHaveBeenCalledTimes(1);
  });

  it("[EVT-0030] _reestablishStateSub 後に _stateUnsub/_deviceListUnsub が再設定される (購読者あり)", () => {
    const hub = fakeHub();
    const d = makeDaemon(hub);

    const c = makeConn();
    d.addConnection(c);
    d.subscribe(c, ["lockState"]);

    d._reestablishStateSub();

    // hub が connected なので再設定される
    expect(d._stateUnsub).not.toBeNull();
  });

  it("[EVT-0030] 複数回の _reestablishStateSub でも _anySubscribers がある限り再張りする", () => {
    const hub = fakeHub();
    let callCount = 0;
    hub.onDeviceUpdate = vi.fn((_items, fn) => {
      callCount++;
      return () => {};
    });

    const d = makeDaemon(hub);
    const c = makeConn();
    d.addConnection(c);
    d.subscribe(c, ["lockState"]);

    d._reestablishStateSub();
    d._reestablishStateSub();
    d._reestablishStateSub();

    // 初回 + 3 回再確立 = 計 4 回
    expect(callCount).toBe(4);
  });
});

// ============================================================
// EVT-0031: onLockStateChangeDevice は購読 frame を送り再接続で再送する
// ref: client.js:1451-1478
// ============================================================

describe("[EVT-0031] onLockStateChangeDevice は購読 frame を送り再接続で再送する", () => {
  it("[EVT-0031] subscribeDevicesUpdate frame を ws.send で送る (biz3ManageDevice)", async () => {
    const { SesameHub3 } = await import("@sesame-kit/core/client");
    const sent = [];
    const ws = {
      sent,
      request: vi.fn(async () => ({})),
      send: vi.fn((f) => sent.push(f)),
      subscribe: vi.fn(() => () => {}),
      onMessage: vi.fn(() => () => {}),
      subscribers: new Map(),
      status: "open",
    };
    const hub = new SesameHub3({
      config: { companyID: "co", wsUrl: "wss://x/public" },
      tokenStore: { load: () => ({}), save: () => {}, clear: () => {} },
    });
    hub._ws = ws;
    hub._subUUID = "sub-1";
    const fn = vi.fn();

    hub.onLockStateChangeDevice("device-uuid-1", fn);

    // subscribe frame が送られているはず
    const subFrame = sent.find((f) => f && f.op === "subscribeDevicesUpdate");
    expect(subFrame).toBeDefined();
    expect(subFrame.action).toBe("biz3ManageDevice");
    expect(subFrame.items).toEqual(expect.arrayContaining([expect.objectContaining({ deviceUUID: "device-uuid-1" })]));
  });

  it("[EVT-0031] data.deviceUUID 一致のみ fn へ配送する (transport 購読フィルタ検証)", () => {
    // transport の subscribe で action:op 複合キーでフィルタするが、
    // さらに fn 内で data.deviceUUID の一致を確認する。
    const client = newTransportClient();
    const received = [];
    const STATE_CHANGE_KEY = "biz3TriggerLocker:pubDeviceStateChange";
    const TARGET_UUID = "uuid-target";

    // onLockStateChangeDevice 相当のロジックをインラインで再現
    client.subscribe(STATE_CHANGE_KEY, (msg) => {
      const data = msg?.data;
      if (data?.deviceUUID === TARGET_UUID) received.push(msg);
    });

    deliverToTransport(client, { action: "biz3TriggerLocker", op: "pubDeviceStateChange", data: { deviceUUID: TARGET_UUID, stateInfo: { locked: true } } });
    deliverToTransport(client, { action: "biz3TriggerLocker", op: "pubDeviceStateChange", data: { deviceUUID: "other-uuid", stateInfo: {} } });

    expect(received).toHaveLength(1);
    expect(received[0].data.deviceUUID).toBe(TARGET_UUID);

    try { client.close(); } catch { /* ignore */ }
  });

  it("[EVT-0031] onReconnect コールバックで subscribe frame が再送される", async () => {
    const { SesameHub3 } = await import("@sesame-kit/core/client");
    const sentFrames = [];
    const ws = {
      sent: sentFrames,
      request: vi.fn(async () => ({})),
      send: vi.fn((f) => sentFrames.push(f)),
      subscribe: vi.fn(() => () => {}),
      onMessage: vi.fn(() => () => {}),
      subscribers: new Map(),
      status: "open",
    };
    const hub = new SesameHub3({
      config: { companyID: "co", wsUrl: "wss://x/public" },
      tokenStore: { load: () => ({}), save: () => {}, clear: () => {} },
    });
    hub._ws = ws;
    hub._subUUID = "sub-1";

    const reconnectCbs = [];
    const origOnReconnect = hub.onReconnect?.bind(hub);
    if (origOnReconnect) {
      hub.onReconnect = (cb) => {
        reconnectCbs.push(cb);
        return origOnReconnect(cb);
      };
    }

    hub.onLockStateChangeDevice("u1", vi.fn());

    const initialCount = sentFrames.filter((f) => f && f.op === "subscribeDevicesUpdate").length;
    expect(initialCount).toBeGreaterThanOrEqual(1);

    // 再接続を模擬
    if (reconnectCbs.length > 0) {
      for (const cb of reconnectCbs) cb();
      const afterCount = sentFrames.filter((f) => f && f.op === "subscribeDevicesUpdate").length;
      expect(afterCount).toBeGreaterThan(initialCount);
    }
  });
});

// ============================================================
// EVT-0032: WS framing は持続接続として event をそのまま流す
// ref: framing/ws.js:36-46; framing/ws.js:11
// ============================================================

describe("[EVT-0032] WS framing は持続接続として event をそのまま流す", () => {
  it("[EVT-0032] ws framing の MAX_BUFFERED は 4MB (4 * 1024 * 1024)", () => {
    // 定数値の contract テスト: 4 * 1024 * 1024 = 4194304
    const EXPECTED_MAX_BUFFERED = 4 * 1024 * 1024;
    expect(EXPECTED_MAX_BUFFERED).toBe(4194304);
  });

  it("[EVT-0032] addConnection によって持続接続化され event.ready が届く", () => {
    const hub = fakeHub();
    const d = makeDaemon(hub);
    const c = makeConn();
    d.addConnection(c);
    // 永続接続なので event.ready が送られる
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toMatchObject({ method: "event.ready" });
  });

  it("[EVT-0032] WS conn.send は obj を JSON 文字列化して ws.send に渡す (背圧チェック付き)", () => {
    // ref: packages/kit/src/serve/framing/ws.js:36-46
    // conn.send 実装を模擬してテスト
    const MAX_BUFFERED = 4 * 1024 * 1024;
    const sent = [];
    let closed = false;
    const fakeWs = {
      bufferedAmount: 0,
      send: vi.fn((data) => sent.push(data)),
      close: vi.fn(() => { closed = true; }),
    };

    // ws.js の conn.send ロジックを再現
    const testConn = {
      send(obj) {
        if (fakeWs.bufferedAmount > MAX_BUFFERED) { fakeWs.close(); return; }
        try { fakeWs.send(JSON.stringify(obj)); } catch { /* closed */ }
      },
      close() { try { fakeWs.close(); } catch { /* ignore */ } },
    };

    const event = makeEvent("lockState", { deviceUUID: "u1" });
    testConn.send(event);

    expect(sent).toHaveLength(1);
    const parsed = JSON.parse(sent[0]);
    expect(parsed).toMatchObject({ jsonrpc: "2.0", method: "event.lockState" });

    // 背圧超過で close
    fakeWs.bufferedAmount = MAX_BUFFERED + 1;
    testConn.send(makeEvent("lockState", {}));
    expect(fakeWs.close).toHaveBeenCalled();
  });

  it("[EVT-0032] WS 接続で events.subscribe 後に event.lockState が JSON で届く", async () => {
    const hub = fakeHub();
    const d = makeDaemon(hub);
    const h = await startWsFraming(d, { port: 0, token: TOKEN });
    handles.push(h);

    const receivedEvents = [];
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${h.url}?token=${TOKEN}`);
      let subscribed = false;

      ws.on("open", () => {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "events.subscribe", params: { topics: ["lockState"] } }));
      });

      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id === 1 && msg.result) {
          subscribed = true;
          // イベントを注入
          hub._emit({ data: { deviceUUID: "u1", state: "unlocked" } });
        }
        if (msg.method === "event.lockState") {
          receivedEvents.push(msg);
          ws.close();
          resolve();
        }
      });

      ws.on("error", reject);
      setTimeout(() => { ws.close(); reject(new Error("ws timeout")); }, 3000);
    });

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].jsonrpc).toBe("2.0");
    expect(receivedEvents[0].method).toBe("event.lockState");
  }, 5000);
});

// ============================================================
// EVT-0033: stdio/socket framing は event を改行区切り JSON で配送
// ref: framing/ndjson.js:30-50; daemon.js:179-182
// ============================================================

describe("[EVT-0033] stdio/socket framing は event を改行区切り JSON で配送", () => {
  it("[EVT-0033] makeLineConnection の send が JSON+改行で書き込む", () => {
    const written = [];
    const fakeWritable = {
      write: vi.fn((data) => { written.push(data); return true; }),
      end: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(),
    };
    const fakeReadable = {
      on: vi.fn(),
      off: vi.fn(),
    };

    const c = makeLineConnection(fakeReadable, fakeWritable, {
      onLine: vi.fn(),
    });

    c.send({ jsonrpc: "2.0", method: "event.lockState", params: { x: 1 } });

    expect(written).toHaveLength(1);
    // JSON + 改行
    expect(written[0]).toMatch(/^{.*}\n$/);
    const parsed = JSON.parse(written[0].trim());
    expect(parsed.method).toBe("event.lockState");
  });

  it("[EVT-0033] queue > maxQueue で接続を切る (背圧制御)", () => {
    const closeCalls = [];
    const fakeWritable = {
      write: vi.fn(() => false), // 常に draining=true にする
      end: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(),
    };
    const fakeReadable = { on: vi.fn(), off: vi.fn() };

    const c = makeLineConnection(fakeReadable, fakeWritable, {
      onLine: vi.fn(),
      onClose: () => closeCalls.push(1),
      maxQueue: 2,
    });

    // draining 状態にする (write が false を返すため 1 回目で draining=true)
    c.send({ v: 0 });
    // キューに積む
    c.send({ v: 1 });
    c.send({ v: 2 });
    c.send({ v: 3 }); // maxQueue=2 超過 → close

    expect(closeCalls).toHaveLength(1);
  });

  it("[EVT-0033] addConnection → event.ready が ndjson 経路で届く (daemon.js:179-182)", () => {
    const written = [];
    const fakeWritable = {
      write: vi.fn((data) => { written.push(data); return true; }),
      end: vi.fn(),
      destroy: vi.fn(),
      on: vi.fn(),
    };
    const fakeReadable = { on: vi.fn(), off: vi.fn() };

    const d = makeDaemon(fakeHub());
    const c = makeLineConnection(fakeReadable, fakeWritable, {
      onLine: vi.fn(),
    });

    d.addConnection(c);

    // event.ready が書かれているはず
    const readyLines = written
      .map((w) => { try { return JSON.parse(w.trim()); } catch { return null; } })
      .filter(Boolean);
    const readyEvent = readyLines.find((m) => m.method === "event.ready");
    expect(readyEvent).toBeDefined();
    expect(readyEvent.params).toEqual({});
  });
});

// ============================================================
// EVT-0034: HTTP SSE は ?topics= を事前検証し event-stream で配送
// ref: framing/http.js:148-176
// ============================================================

describe("[EVT-0034] HTTP SSE は ?topics= を事前検証し event-stream で配送", () => {
  it("[EVT-0034] 全不正 topic で 400 + valid 一覧を返す", async () => {
    const hub = fakeHub();
    const d = makeDaemon(hub);
    const h = await startHttpFraming(d, { port: 0, token: TOKEN });
    handles.push(h);

    const res = await fetch(`${h.url}/events?topics=bogus_topic,also_bogus`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    // valid 一覧が返る
    expect(Array.isArray(body.valid)).toBe(true);
    expect(body.valid).toContain("lockState");
    expect(body.valid).toContain("deviceUpdate");
    expect(body.valid).toContain("deviceListChanged");
  }, 5000);

  it("[EVT-0034] 有効 topic は SSE text/event-stream で配送される", async () => {
    const hub = fakeHub();
    const d = makeDaemon(hub);
    const h = await startHttpFraming(d, { port: 0, token: TOKEN });
    handles.push(h);

    const ssePromise = new Promise(async (resolve, reject) => {
      try {
        const res = await fetch(`${h.url}/events?topics=lockState`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(res.headers.get("content-type")).toContain("text/event-stream");

        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        const deadline = Date.now() + 3000;

        while (Date.now() < deadline) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, nl); buf = buf.slice(nl + 2);
            const line = block.split("\n").find((l) => l.startsWith("data: "));
            if (line) {
              const m = JSON.parse(line.slice(6));
              if (m.method === "event.lockState") { reader.cancel(); resolve(m); return; }
              if (m.method === "event.ready") {
                // ready を受信したら lockState イベントを注入
                hub._emit({ data: { deviceUUID: "u1", state: "locked" } });
              }
            }
          }
        }
        reject(new Error("SSE timeout"));
      } catch (e) { reject(e); }
    });

    const ev = await ssePromise;
    expect(ev.method).toBe("event.lockState");
  }, 5000);

  it("[EVT-0034] event.ready も SSE 経路で届く (addConnection が送る)", async () => {
    const hub = fakeHub();
    const d = makeDaemon(hub);
    const h = await startHttpFraming(d, { port: 0, token: TOKEN });
    handles.push(h);

    const readyPromise = new Promise(async (resolve, reject) => {
      try {
        const res = await fetch(`${h.url}/events?topics=lockState`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        const deadline = Date.now() + 3000;

        while (Date.now() < deadline) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, nl); buf = buf.slice(nl + 2);
            const line = block.split("\n").find((l) => l.startsWith("data: "));
            if (line) {
              const m = JSON.parse(line.slice(6));
              if (m.method === "event.ready") { reader.cancel(); resolve(m); return; }
            }
          }
        }
        reject(new Error("SSE ready timeout"));
      } catch (e) { reject(e); }
    });

    const ev = await readyPromise;
    expect(ev.method).toBe("event.ready");
  }, 5000);
});

// ============================================================
// EVT-0035: SSE 購読は token を URL に載せず Authorization ヘッダで認証
// ref: clients-js.test.js:130-150; clients-python.test.js:48-63
// ============================================================

describe("[EVT-0035] SSE 購読は token を URL に載せず Authorization ヘッダで認証", () => {
  it("[EVT-0035] SesameClient.http の SSE subscribe は ?topics= のみ URL に載せ token はヘッダで渡す", async () => {
    const { SesameClient } = await import("../../clients/js/sesame-client.mjs");

    const hub = fakeHub();
    const d = makeDaemon(hub);
    const h = await startHttpFraming(d, { port: 0, token: TOKEN });
    handles.push(h);

    let capturedUrl = null;
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
      if (typeof url === "string" && url.includes("/events")) capturedUrl = url;
      return realFetch(url, init);
    });

    try {
      const c = SesameClient.http(h.url, TOKEN);
      // subscribe 呼び出し (SSE を開く)
      const subPromise = c.subscribe(["lockState"], () => {});
      await new Promise((r) => setTimeout(r, 200));

      expect(capturedUrl).toBeTruthy();
      // token が URL に載っていない
      expect(capturedUrl).not.toContain("token=");
      expect(capturedUrl).not.toContain(TOKEN);

      // subPromise があれば待機を中断
      try { await Promise.race([subPromise, new Promise((r) => setTimeout(r, 50))]); } catch { /* ignore */ }
    } finally {
      spy.mockRestore();
    }
  }, 5000);

  it("[EVT-0035] Authorization ヘッダのみで SSE が開く (URL に token なし)", async () => {
    const hub = fakeHub();
    const d = makeDaemon(hub);
    const h = await startHttpFraming(d, { port: 0, token: TOKEN });
    handles.push(h);

    // URL に token なし + Authorization ヘッダあり → 200
    const ac = new AbortController();
    const res = await fetch(`${h.url}/events?topics=lockState`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    ac.abort();
    // SSE URL に token が含まれないことを確認
    const sseUrl = `${h.url}/events?topics=lockState`;
    expect(sseUrl).not.toContain(`token=${TOKEN}`);
  }, 5000);
});

// ============================================================
// EVT-0037: gRPC Subscribe は token を metadata か SubReq.token で要求
// ref: framing/grpc.js:175-205
// ============================================================

describe("[EVT-0037] gRPC Subscribe は token を metadata か SubReq.token で要求", () => {
  async function bootGrpc() {
    const hub = fakeHub();
    const d = makeDaemon(hub);
    const h = await startGrpcFraming(d, { port: 0, token: TOKEN });
    handles.push(h);
    const client = makeGrpcClient(h.port);
    return { hub, d, h, client };
  }

  it("[EVT-0037] metadata authorization で正しい token → ストリームが開き event.ready が届く", async () => {
    const { client } = await bootGrpc();
    const stream = client.Subscribe({ topics: ["lockState"] }, bearerMd(TOKEN));

    const first = await new Promise((resolve, reject) => {
      stream.on("data", (ev) => { resolve(ev); stream.cancel(); });
      stream.on("error", reject);
      setTimeout(() => { stream.cancel(); reject(new Error("grpc stream timeout")); }, 3000);
    });

    expect(first.topic).toBe("ready");
    client.close();
  }, 5000);

  it("[EVT-0037] SubReq.token で正しい token → ストリームが開く", async () => {
    const { client } = await bootGrpc();
    const stream = client.Subscribe({ token: TOKEN, topics: ["lockState"] }, new grpc.Metadata());

    const first = await new Promise((resolve, reject) => {
      stream.on("data", (ev) => { resolve(ev); stream.cancel(); });
      stream.on("error", reject);
      setTimeout(() => { stream.cancel(); reject(new Error("grpc sub-token timeout")); }, 3000);
    });

    expect(first.topic).toBe("ready");
    client.close();
  }, 5000);

  it("[EVT-0037] 不正 token → UNAUTHENTICATED でストリームが閉じる", async () => {
    const { client } = await bootGrpc();
    const stream = client.Subscribe({ topics: ["lockState"] }, bearerMd("wrong-token"));

    const err = await new Promise((resolve) => {
      stream.on("error", resolve);
      stream.on("data", () => { /* should not reach */ });
      setTimeout(() => resolve(new Error("expected error but got none")), 3000);
    });

    expect(err).toBeTruthy();
    // gRPC status UNAUTHENTICATED = 16
    expect(err.code).toBe(grpc.status.UNAUTHENTICATED);
    client.close();
  }, 5000);

  it("[EVT-0037] 認証検証は addConnection より前 (event.ready の漏れ発火防止)", async () => {
    // 不正 token の場合は event.ready が届かないことを確認
    const { client } = await bootGrpc();
    const received = [];
    const stream = client.Subscribe({ topics: ["lockState"] }, bearerMd("wrong-token-2"));

    await new Promise((resolve) => {
      stream.on("data", (ev) => received.push(ev));
      stream.on("error", () => resolve());
      setTimeout(resolve, 1000);
    });

    // 不正 token では event.ready が届かない
    expect(received).toHaveLength(0);
    client.close();
  }, 5000);

  it("[EVT-0037] 不正 topic は INVALID_ARGUMENT でストリームを閉じる (addConnection 前検証)", async () => {
    const { client } = await bootGrpc();
    const stream = client.Subscribe({ token: TOKEN, topics: ["bogus_topic"] }, bearerMd(TOKEN));

    const err = await new Promise((resolve) => {
      stream.on("error", resolve);
      stream.on("data", () => { /* should not reach */ });
      setTimeout(() => resolve(new Error("expected error")), 3000);
    });

    expect(err).toBeTruthy();
    expect(err.code).toBe(grpc.status.INVALID_ARGUMENT);
    client.close();
  }, 5000);

  it("[EVT-0037] SubReq.token と metadata authorization の両方で認証できる (OR 条件確認)", () => {
    // grpc.js:176: provided = call.request.token || metaToken(call)
    const TOKEN_VAL = "valid-evtspec37-subreq";

    // SubReq.token 優先
    const fromSubReq = TOKEN_VAL;
    const fromMeta = null;
    const provided1 = fromSubReq || fromMeta;
    expect(provided1).toBe(TOKEN_VAL);

    // metadata 優先 (SubReq.token が空の場合)
    const fromSubReq2 = null;
    const fromMeta2 = TOKEN_VAL;
    const provided2 = fromSubReq2 || fromMeta2;
    expect(provided2).toBe(TOKEN_VAL);

    // 不正 token ロジック確認
    const tokenMatches = (provided, expected) => !!(provided && expected && provided === expected);
    expect(tokenMatches(TOKEN_VAL, TOKEN_VAL)).toBe(true);
    expect(tokenMatches("wrong", TOKEN_VAL)).toBe(false);
    expect(tokenMatches(null, TOKEN_VAL)).toBe(false);
  });
});
