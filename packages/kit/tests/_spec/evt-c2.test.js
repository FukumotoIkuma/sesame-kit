// EVT-0038 〜 EVT-0047 spec tests (TDD — red where impl diverges from spec)
// 対象: scripts/gen-grpc-proto.mjs, scripts/gen-sdk-ts.mjs, scripts/gen-sdk-py.mjs
//       packages/kit/src/serve/daemon.js, packages/kit/src/serve/entries/events.js
//       packages/kit/src/serve/registry-helpers.js, packages/kit/src/cli/serve.js
//       packages/core/src/transport.js
// 実行環境: vitest (unit project) — KIT_SETUP により kit カタログ登録済み・ロケール ja 固定。
// 方針: 全テスト self-contained、ネットワーク/実機不使用、決定論的。

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..", ".."); // repo root (sesami_hub3_app)

// ---------------------------------------------------------------------------
// Shared fakes / helpers
// ---------------------------------------------------------------------------

/** 最小 fake Connection (persistent, ephemeral:false) */
function makeConn(opts = {}) {
  const sent = [];
  return {
    id: opts.id ?? "c1",
    ephemeral: opts.ephemeral ?? false,
    sent,
    send(obj) { this.sent.push(obj); },
    close() {},
    ...opts,
  };
}

/** 最小 fake Hub。onDeviceUpdate / onUserDeviceChange を持つ。 */
function makeFakeHub(overrides = {}) {
  let duFn = null;
  return {
    connected: true,
    subUUID: "sub-uuid",
    config: { devices: {} },
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    onDeviceUpdate: (_items, fn) => { duFn = fn; return () => { duFn = null; }; },
    onUserDeviceChange: (fn) => { return () => {}; },
    tokenStore: { load: () => ({}), save: () => {}, clear: () => {} },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// EVT-0038: events.* op は gRPC unary に生成されず Subscribe ストリーム専用
// ---------------------------------------------------------------------------

describe("[EVT-0038] gen-grpc-proto: events.* は unary から除外・Subscribe ストリームのみ", () => {
  it("[EVT-0038] generateProto が events.* を continue で除外し Subscribe ストリームのみを宣言する", async () => {
    // scripts/gen-grpc-proto.mjs:58 で name.startsWith('events.') を continue で除外する。
    // scripts/gen-grpc-proto.mjs:109-110 で唯一のストリーム RPC を宣言する。
    const { generateProto } = await import("../../../../scripts/gen-grpc-proto.mjs");
    const { protoText, nameMap } = await generateProto();

    // events.subscribe / events.unsubscribe が nameMap (unary) に含まれないこと
    const unaryKeys = Object.values(nameMap).map((v) => v.method);
    expect(unaryKeys).not.toContain("events.subscribe");
    expect(unaryKeys).not.toContain("events.unsubscribe");

    // protoText には Subscribe ストリームが宣言されていること (109-110)
    expect(protoText).toMatch(/rpc\s+Subscribe\s*\(\s*SubReq\s*\)\s*returns\s*\(\s*stream\s+Event\s*\)/);

    // protoText には EventsSubscribe や EventsUnsubscribe という unary が無いこと
    expect(protoText).not.toMatch(/rpc\s+EventsSubscribe\s*\(/);
    expect(protoText).not.toMatch(/rpc\s+EventsUnsubscribe\s*\(/);
    // events.* のどんな unary も生成されていない
    expect(protoText).not.toMatch(/rpc\s+Events[A-Z]/);
  });
});

// ---------------------------------------------------------------------------
// EVT-0039: SDK の SesameEventTopic 型が x-event-topics から導出される
// ---------------------------------------------------------------------------

describe("[EVT-0039] SDK SesameEventTopic は x-event-topics から導出 (drift gate 対象)", () => {
  it("[EVT-0039] TS SDK の SesameEventTopic 型が spec の x-event-topics から導出される (drift gate)", async () => {
    // scripts/gen-sdk-ts.mjs:102 が spec['x-event-topics'] を読み SesameEventTopic を生成する。
    const { generateSdk } = await import("../../../../scripts/gen-sdk-ts.mjs");

    const topics = ["lockState", "deviceUpdate", "deviceListChanged"];
    const minSpec = {
      info: { version: "0.0.0", "x-apiVersion": "0.0.0" },
      "x-event-topics": topics,
      "x-events": [],
      methods: [],
    };

    const out = generateSdk(minSpec);

    // SesameEventTopic 型が x-event-topics の値から成る union であること
    expect(out).toContain("SesameEventTopic");
    for (const t of topics) {
      expect(out).toContain(JSON.stringify(t));
    }
    // 型宣言として SesameEventTopic が登場すること
    expect(out).toContain("export type SesameEventTopic =");
  });

  it("[EVT-0039] Python SDK の SesameEventTopic 型が spec の x-event-topics から導出される", async () => {
    // scripts/gen-sdk-py.mjs:172 が spec['x-event-topics'] を読み Literal[] を生成する。
    const { generateSdkPy } = await import("../../../../scripts/gen-sdk-py.mjs");

    const topics = ["lockState", "deviceUpdate", "deviceListChanged"];
    const minSpec = {
      info: { version: "0.0.0", "x-apiVersion": "0.0.0" },
      "x-event-topics": topics,
      "x-events": [],
      methods: [],
    };

    const out = generateSdkPy(minSpec);

    // SesameEventTopic = Literal["lockState", "deviceUpdate", "deviceListChanged"]
    expect(out).toContain("SesameEventTopic");
    // Python Literal 形式であること
    expect(out).toContain("Literal[");
    for (const t of topics) {
      expect(out).toContain(JSON.stringify(t));
    }
  });

  it("[EVT-0039] x-event-topics === [lockState, deviceUpdate, deviceListChanged] (spec 契約の全件固定)", () => {
    const spec = JSON.parse(readFileSync(resolve(ROOT, "schema", "openrpc.json"), "utf8"));
    expect(spec["x-event-topics"]).toEqual(["lockState", "deviceUpdate", "deviceListChanged"]);
  });

  it("[EVT-0039] x-event-topics は ready を含まない (broadcast 非購読)", () => {
    const spec = JSON.parse(readFileSync(resolve(ROOT, "schema", "openrpc.json"), "utf8"));
    expect(spec["x-event-topics"]).not.toContain("ready");
  });
});

// ---------------------------------------------------------------------------
// EVT-0040: SDK streamEvents は ready も含めて全 event を on_event へ渡す
// ---------------------------------------------------------------------------

describe("[EVT-0040] SDK streamEvents/stream_events は全 event (ready 含む) を onEvent へ透過", () => {
  it("[EVT-0040] TS SDK: streamEvents は GET /events?topics= を開き data: 行を onEvent に渡す (ready フィルタ無し)", async () => {
    // scripts/gen-sdk-ts.mjs:245 が GET /events?topics= を開き、
    // scripts/gen-sdk-ts.mjs:268-271 が data: 行を JSON.parse して onEvent へ渡す。
    const { generateSdk } = await import("../../../../scripts/gen-sdk-ts.mjs");

    const topics = ["lockState", "deviceUpdate", "deviceListChanged"];
    const minSpec = {
      info: { version: "0.0.0", "x-apiVersion": "0.0.0" },
      "x-event-topics": topics,
      "x-events": [],
      methods: [],
    };

    const out = generateSdk(minSpec);

    // streamEvents メソッドが存在する
    expect(out).toContain("streamEvents(");
    // GET /events を使うこと
    expect(out).toContain("/events");
    // data: 行をパースする実装が含まれる
    expect(out).toContain('startsWith("data:")');
    // JSON.parse + onEvent が含まれる
    expect(out).toMatch(/JSON\.parse.*onEvent|onEvent.*JSON\.parse/s);
    // Authorization ヘッダで認証 (token を URL に載せない)
    expect(out).toContain("authorization");
    expect(out).toContain("Bearer");
    // ready のフィルタは存在しない (全 event 透過)
    expect(out).not.toMatch(/topic.*===.*['"]ready['"]/);
    expect(out).not.toMatch(/\.method.*===.*['"]event\.ready['"]/);
  });

  it("[EVT-0040] Python SDK: stream_events は GET /events?topics= を開き data: 行を on_event に渡す (ready フィルタ無し)", async () => {
    // scripts/gen-sdk-py.mjs:327 が GET /events?topics= を開き、
    // scripts/gen-sdk-py.mjs:341-344 が data: 行を json.loads して on_event へ渡す。
    const { generateSdkPy } = await import("../../../../scripts/gen-sdk-py.mjs");

    const topics = ["lockState", "deviceUpdate", "deviceListChanged"];
    const minSpec = {
      info: { version: "0.0.0", "x-apiVersion": "0.0.0" },
      "x-event-topics": topics,
      "x-events": [],
      methods: [],
    };

    const out = generateSdkPy(minSpec);

    // stream_events メソッドが定義されていること
    expect(out).toContain("def stream_events(");
    // GET /events を使うこと
    expect(out).toContain("/events");
    // data: 行の処理
    expect(out).toContain('startswith("data:")');
    // json.loads + on_event
    expect(out).toMatch(/json\.loads.*on_event|on_event.*json\.loads/s);
    // Authorization ヘッダで認証
    expect(out).toContain("authorization");
    expect(out).toContain("Bearer");
    // ready フィルタなし (全 event 透過)
    expect(out).not.toMatch(/==\s*["']ready["']/);
    expect(out).not.toMatch(/["']event\.ready["']/);
  });
});

// ---------------------------------------------------------------------------
// EVT-0041: CLI sesame rpc --subscribe は UDS で購読し1行JSONで出力
// ---------------------------------------------------------------------------

describe("[EVT-0041] CLI rpc --subscribe: UDS 購読・{topic,payload} 1行JSON出力・ready 除外・--http は exit 2", () => {
  it("[EVT-0041] rpcSubscribe が topic==='ready' を return で除外して {topic,payload} を console.log する", () => {
    // packages/kit/src/cli/serve.js:220 で topic==='ready' を return で除外
    // packages/kit/src/cli/serve.js:221 で console.log(JSON.stringify({topic,payload}))
    const src = readFileSync(
      resolve(HERE, "..", "..", "src", "cli", "serve.js"),
      "utf8"
    );
    // topic === "ready" の分岐が存在する
    expect(src).toMatch(/topic\s*===\s*["']ready["']/);
    // JSON.stringify({topic, payload}) が含まれる
    expect(src).toContain("JSON.stringify({ topic, payload })");

    // ロジック再現: ready フィルタの境界を純粋関数で検証
    const logged = [];
    const callback = (topic, payload) => {
      if (topic === "ready") return; // serve.js:220
      logged.push(JSON.stringify({ topic, payload })); // serve.js:221
    };

    callback("ready", {});
    callback("lockState", { data: { deviceUUID: "u1" } });

    // event.ready は出力されない
    expect(logged).toHaveLength(1);
    // lockState は {topic, payload} の 1 行 JSON として出力される
    const parsed = JSON.parse(logged[0]);
    expect(parsed).toMatchObject({ topic: "lockState", payload: { data: { deviceUUID: "u1" } } });
  });

  it("[EVT-0041] --http オプション指定時は subscribeHttpUnsupported を出力して exit 2 する (serve.js:302-305)", () => {
    const src = readFileSync(
      resolve(HERE, "..", "..", "src", "cli", "serve.js"),
      "utf8"
    );
    // subscribeHttpUnsupported を console.error し process.exit(2) する経路がある
    expect(src).toContain("subscribeHttpUnsupported");
    expect(src).toMatch(/process\.exit\(2\)/);
    // --http 分岐と process.exit(2) が近傍にある
    expect(src).toMatch(/opts\.http[\s\S]{0,200}process\.exit\(2\)/);

    // 分岐ロジック再現 (serve.js:299-309)
    function handleSubscribe(opts, rpcSubscribeFn, subscribeHttpUnsupportedFn, exitFn) {
      if (opts.http) {
        subscribeHttpUnsupportedFn();
        exitFn(2);
        return;
      }
      rpcSubscribeFn(opts.topics);
    }

    const rpcSubscribeMock = vi.fn();
    const subscribeHttpUnsupportedMock = vi.fn();
    const exitMock = vi.fn();

    // --http 時は subscribeHttpUnsupported を出して exit 2
    handleSubscribe(
      { http: "http://localhost:8080", subscribe: "lockState", topics: ["lockState"] },
      rpcSubscribeMock, subscribeHttpUnsupportedMock, exitMock
    );

    expect(subscribeHttpUnsupportedMock).toHaveBeenCalledTimes(1);
    expect(exitMock).toHaveBeenCalledWith(2);
    expect(rpcSubscribeMock).not.toHaveBeenCalled();
  });

  it("[EVT-0041] rpcSubscribe は SesameClient.unix を使って UDS 接続する (serve.js:217)", () => {
    const src = readFileSync(
      resolve(HERE, "..", "..", "src", "cli", "serve.js"),
      "utf8"
    );
    expect(src).toContain("SesameClient.unix(socketPath)");
    // client.subscribe(topics, ...) を呼ぶ
    expect(src).toMatch(/\.subscribe\(topics,/);
  });
});

// ---------------------------------------------------------------------------
// EVT-0042: sesame rpc で events.subscribe/unsubscribe を直接メソッド指定すると拒否
// ---------------------------------------------------------------------------

describe("[EVT-0042] sesame rpc events.subscribe/unsubscribe を直接指定すると rpcEventsPersistent + exit 2", () => {
  it("[EVT-0042] m==='events.subscribe' のとき rpcEventsPersistent を console.error して exit 2 する (serve.js:326-329)", () => {
    const src = readFileSync(
      resolve(HERE, "..", "..", "src", "cli", "serve.js"),
      "utf8"
    );
    // events.subscribe の直接呼び出し拒否
    expect(src).toMatch(/m\s*===\s*["']events\.subscribe["']/);
    // events.unsubscribe も同様
    expect(src).toMatch(/m\s*===\s*["']events\.unsubscribe["']/);
    // rpcEventsPersistent を console.error して exit 2
    expect(src).toContain("rpcEventsPersistent");
    expect(src).toMatch(/process\.exit\(2\)/);

    // m === 'events.subscribe' ブロック内に exit(2) が近い
    const match = src.match(/m\s*===\s*["']events\.subscribe["'][\s\S]{0,300}process\.exit\(2\)/);
    expect(match).toBeTruthy();

    // 分岐ロジック再現 (serve.js:326-329)
    function handleRpcMethod(m, rpcEventsPersistentFn, exitFn, rpcCallFn) {
      if (m === "events.subscribe" || m === "events.unsubscribe") {
        rpcEventsPersistentFn();
        exitFn(2);
        return;
      }
      return rpcCallFn(m);
    }

    const persistentMock = vi.fn();
    const exitMock = vi.fn();
    const rpcCallMock = vi.fn();

    // events.subscribe は拒否
    handleRpcMethod("events.subscribe", persistentMock, exitMock, rpcCallMock);
    expect(persistentMock).toHaveBeenCalledTimes(1);
    expect(exitMock).toHaveBeenCalledWith(2);
    expect(rpcCallMock).not.toHaveBeenCalled();

    persistentMock.mockClear(); exitMock.mockClear(); rpcCallMock.mockClear();

    // events.unsubscribe も拒否
    handleRpcMethod("events.unsubscribe", persistentMock, exitMock, rpcCallMock);
    expect(persistentMock).toHaveBeenCalledTimes(1);
    expect(exitMock).toHaveBeenCalledWith(2);
    expect(rpcCallMock).not.toHaveBeenCalled();

    persistentMock.mockClear(); exitMock.mockClear(); rpcCallMock.mockClear();

    // 通常メソッドは rpcCall へ
    handleRpcMethod("lock.unlock", persistentMock, exitMock, rpcCallMock);
    expect(persistentMock).not.toHaveBeenCalled();
    expect(exitMock).not.toHaveBeenCalled();
    expect(rpcCallMock).toHaveBeenCalledWith("lock.unlock");
  });
});

// ---------------------------------------------------------------------------
// EVT-0043: keepalive ack は success に依存せず connectionId 受信で生存判定
// ---------------------------------------------------------------------------

describe("[EVT-0043] keepalive ack: success 非依存・connectionId 受信で pong timer クリア", () => {
  it("[EVT-0043] ping() は !!resp (応答受信自体) を生存判定とし success フィールドに非依存 (transport.js:327-330)", async () => {
    // packages/core/src/transport.js:327-330
    // ping() は response の受信自体で生存判定し、success フィールドを見ない
    const { Hub3WsClient } = await import("../../../../packages/core/src/transport.js");

    const client = new Hub3WsClient({
      wsUrl: "wss://example.invalid/",
      idToken: "fake-token",
    });

    // request を差し替えて connectionId のみ返すレスポンス (success フィールド無し)
    const mockResponse = { action: "biz3KeepAlive", connectionId: "conn-abc-123" };
    client.request = vi.fn(async () => mockResponse);

    const result = await client.ping();

    // 応答受信 = 生存 (!!resp)。success フィールド非依存
    expect(result).toBe(true);
    expect(client.request).toHaveBeenCalledWith(
      { action: "biz3KeepAlive" },
      expect.any(Number),
    );
  });

  it("[EVT-0043] _onMessage は KEEPALIVE_ACTION で pongTimer を clear する (success 有無問わず) (transport.js:520-524)", async () => {
    // packages/core/src/transport.js:520-524
    // msg.action===KEEPALIVE_ACTION で success 有無問わず pongTimer を clear
    const { Hub3WsClient } = await import("../../../../packages/core/src/transport.js");

    const client = new Hub3WsClient({
      wsUrl: "wss://example.invalid/",
      idToken: "fake-token",
    });

    // pongTimer をセット (clearTimeout されるかを確認)
    const fakeTimer = setTimeout(() => {}, 100000);
    client.pongTimer = fakeTimer;

    // _onMessage を呼んでタイマーがクリアされることを確認
    // success フィールドが無いメッセージで検証
    // _onMessage は Buffer|string を直接受け取る (Node ws ライブラリ方式)
    const msgWithoutSuccess = { action: "biz3KeepAlive", connectionId: "conn-123" };
    client._onMessage(JSON.stringify(msgWithoutSuccess));

    // pongTimer が null (クリア済み) であること
    expect(client.pongTimer).toBeNull();
  });

  it("[EVT-0043] KEEPALIVE_ACTION は biz3KeepAlive (vendor ACTION_TYPES.BIZ3_KEEP_ALIVE と同値) (transport.js:69)", () => {
    const src = readFileSync(
      resolve(ROOT, "packages", "core", "src", "transport.js"),
      "utf8"
    );
    // KEEPALIVE_ACTION = ACTION_TYPES.BIZ3_KEEP_ALIVE
    expect(src).toMatch(/KEEPALIVE_ACTION\s*=\s*ACTION_TYPES\.BIZ3_KEEP_ALIVE/);
    // コメントに biz3KeepAlive と記述されている
    expect(src).toContain("biz3KeepAlive");
  });
});

// ---------------------------------------------------------------------------
// EVT-0044: keepalive frame の action が biz3KeepAlive (vendor 同値)
// ---------------------------------------------------------------------------

describe("[EVT-0044] keepalive frame: action=biz3KeepAlive, 60s 間隔 + 3s pong timeout", () => {
  it("[EVT-0044] _triggerHeartbeatCheck が {action:'biz3KeepAlive'} を ws.send する (transport.js:650)", async () => {
    // packages/core/src/transport.js:69 KEEPALIVE_ACTION='biz3KeepAlive'
    // packages/core/src/transport.js:650 ws.send({action:KEEPALIVE_ACTION})
    const { Hub3WsClient } = await import("../../../../packages/core/src/transport.js");

    const client = new Hub3WsClient({
      wsUrl: "wss://example.invalid/",
      idToken: "fake-token",
    });

    // fake WS を注入
    const sentFrames = [];
    client.ws = {
      send: (data) => { sentFrames.push(JSON.parse(data)); },
      readyState: 1, // OPEN
    };
    client.pongTimer = null;

    client._triggerHeartbeatCheck();

    // 送信 frame に action:'biz3KeepAlive' が含まれること
    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0]).toEqual({ action: "biz3KeepAlive" });

    // クリーンアップ
    if (client.pongTimer) { clearTimeout(client.pongTimer); client.pongTimer = null; }
  });

  it("[EVT-0044] KEEPALIVE_INTERVAL_MS = 60000 (60秒間隔) (transport.js:56)", () => {
    const src = readFileSync(
      resolve(ROOT, "packages", "core", "src", "transport.js"),
      "utf8"
    );
    // KEEPALIVE_INTERVAL_MS = 60_000 または 60000
    expect(src).toMatch(/KEEPALIVE_INTERVAL_MS\s*=\s*60[_]?000/);
  });

  it("[EVT-0044] PONG_TIMEOUT_MS = 3000 (3秒 pong タイムアウト) (transport.js:57)", () => {
    const src = readFileSync(
      resolve(ROOT, "packages", "core", "src", "transport.js"),
      "utf8"
    );
    // PONG_TIMEOUT_MS = 3_000 または 3000
    expect(src).toMatch(/PONG_TIMEOUT_MS\s*=\s*3[_]?000/);
  });

  it("[EVT-0044] pong timeout 後に _reconnect() を呼ぶ半開検知 (transport.js:655-658)", () => {
    const src = readFileSync(
      resolve(ROOT, "packages", "core", "src", "transport.js"),
      "utf8"
    );
    // pongTimer が PONG_TIMEOUT_MS 後に _reconnect を呼ぶ
    // 実装: setTimeout(() => { this._reconnect(); }, PONG_TIMEOUT_MS)
    // _reconnect() は PONG_TIMEOUT_MS より前に出現する (setTimeout の引数順序)
    expect(src).toMatch(/_reconnect\(\)[\s\S]{0,100}PONG_TIMEOUT_MS/);
  });

  it("[EVT-0044] keepalive timer は KEEPALIVE_INTERVAL_MS 間隔の setInterval で発火 (transport.js:640)", () => {
    const src = readFileSync(
      resolve(ROOT, "packages", "core", "src", "transport.js"),
      "utf8"
    );
    // setInterval(tick, KEEPALIVE_INTERVAL_MS)
    expect(src).toMatch(/setInterval\([^,]+,\s*KEEPALIVE_INTERVAL_MS\)/);
  });

  it("[EVT-0044] _triggerHeartbeatCheck が呼ばれると pongTimer がセットされる (PONG_TIMEOUT_MS 後に _reconnect)", async () => {
    const { Hub3WsClient } = await import("../../../../packages/core/src/transport.js");

    const client = new Hub3WsClient({
      wsUrl: "wss://example.invalid/",
      idToken: "fake-token",
    });

    client.ws = {
      send: vi.fn(),
      readyState: 1,
    };
    client.pongTimer = null;

    // _triggerHeartbeatCheck を呼び pongTimer がセットされることを確認
    client._triggerHeartbeatCheck();

    // pongTimer が null でない = setTimeout で張られた (PONG_TIMEOUT_MS 後に _reconnect)
    expect(client.pongTimer).not.toBeNull();

    // クリーンアップ
    if (client.pongTimer) { clearTimeout(client.pongTimer); client.pongTimer = null; }
  });
});

// ---------------------------------------------------------------------------
// EVT-0046: events.subscribe/unsubscribe は requireAuth を呼ばず authState を問わず受理
// ---------------------------------------------------------------------------

describe("[EVT-0046] events.subscribe/unsubscribe は requireAuth を呼ばず authState に非依存", () => {
  it("[EVT-0046] events.js が requireAuth を import すらしない (events.js:25-34)", () => {
    const src = readFileSync(
      resolve(HERE, "..", "..", "src", "serve", "entries", "events.js"),
      "utf8"
    );
    // requireAuth の import が無い
    expect(src).not.toMatch(/import[^;]*requireAuth/);
    // requireAuth の呼び出しも無い
    expect(src).not.toMatch(/requireAuth\s*\(/);
  });

  it("[EVT-0046] events.subscribe ハンドラは requireAuth を呼ばず authState=expired でも購読を記録する", async () => {
    // packages/kit/src/serve/entries/events.js:25-34 — requireAuth を import も呼びもしない
    // packages/kit/src/serve/daemon.js:275-281 — authState を見ず set.add のみ
    const { Daemon } = await import("../../src/serve/daemon.js");

    const hub = makeFakeHub();
    const daemon = new Daemon({ hub });
    // authState を expired に設定 (通常 namespace op は requireAuth で NOT_AUTHENTICATED を投げる)
    daemon.authState = "expired";

    const conn = makeConn();
    daemon.addConnection(conn);

    // events.subscribe を invoke する (daemon.invoke 経由でリアルな経路を辿る)
    const result = await daemon.invoke("events.subscribe", { topics: ["lockState"] }, conn);

    // requireAuth ゲートが無いため NOT_AUTHENTICATED を投げず購読が記録される
    expect(result).toMatchObject({ subscribed: expect.arrayContaining(["lockState"]) });

    // _subs に conn の購読が記録されていること
    const set = daemon._subs.get(conn);
    expect(set).toBeDefined();
    expect(set.has("lockState")).toBe(true);
  });

  it("[EVT-0046] hub 未接続 (connected=false) の間は _ensureStateSub が早期 return し購読 topic のみ記録される (daemon.js:303)", async () => {
    // packages/kit/src/serve/daemon.js:303 — !hub.connected で early return
    // 購読は記録されるが subscribe frame は送られない
    const { Daemon } = await import("../../src/serve/daemon.js");

    const hub = makeFakeHub({ connected: false });
    const daemon = new Daemon({ hub });
    daemon.authState = "expired";

    const conn = makeConn();
    daemon.addConnection(conn);

    const result = await daemon.invoke("events.subscribe", { topics: ["lockState"] }, conn);

    // 購読 topic は記録される
    expect(result).toMatchObject({ subscribed: expect.arrayContaining(["lockState"]) });

    // hub が未接続なので _stateUnsub は null (frame は送られていない)
    expect(daemon._stateUnsub).toBeNull();
  });

  it("[EVT-0046] events.unsubscribe ハンドラも requireAuth を呼ばず authState=expired でも実行される", async () => {
    // packages/kit/src/serve/entries/events.js:41-44 — requireAuth なし
    const { Daemon } = await import("../../src/serve/daemon.js");

    const hub = makeFakeHub();
    const daemon = new Daemon({ hub });
    daemon.authState = "expired";

    const conn = makeConn();
    daemon.addConnection(conn);

    // まず購読しておく
    daemon.subscribe(conn, ["lockState"]);

    // unsubscribe も authState に関係なく動く
    const result = await daemon.invoke("events.unsubscribe", { topics: ["lockState"] }, conn);
    expect(result).toMatchObject({ subscribed: [] });
  });

  it("[EVT-0046] namespace op (registry.js:302) は requireAuth を通す (非対称の対照確認)", async () => {
    // registry-helpers.js の requireAuth は authState=expired で NOT_AUTHENTICATED を投げる
    const { requireAuth } = await import("../../src/serve/registry-helpers.js");
    const { RpcError } = await import("@sesame-kit/core/jsonrpc");
    const fakeDaemon = { authState: "expired", hub: { connected: false } };
    expect(() => requireAuth(fakeDaemon)).toThrow(RpcError);
  });

  it("[EVT-0046] daemon.subscribe は authState を見ず set.add のみ実行する (daemon.js:275-281)", async () => {
    const { Daemon } = await import("../../src/serve/daemon.js");
    const hub = makeFakeHub({ connected: false });
    const daemon = new Daemon({ hub });
    const conn = makeConn();
    daemon.addConnection(conn); // _subs に登録

    // subscribe は authState を見ずに set.add する
    const result = daemon.subscribe(conn, ["lockState"]);
    expect(result.subscribed).toContain("lockState");
  });
});

// ---------------------------------------------------------------------------
// EVT-0047: events.unsubscribe は未知 topic を検証せず黙って no-op (subscribe の拒否と非対称)
// ---------------------------------------------------------------------------

describe("[EVT-0047] events.unsubscribe は未知 topic を検証せず黙って no-op (subscribe の未知 topic 拒否と非対称)", () => {
  it("[EVT-0047] events.unsubscribe に未知 topic を渡してもエラーを投げず {subscribed} を返す (daemon.js:288-294)", async () => {
    // packages/kit/src/serve/entries/events.js:41-44 — TOPICS 検証なし
    // packages/kit/src/serve/daemon.js:288-294 — set.delete(未知 topic) が空振りして no-op
    const { Daemon } = await import("../../src/serve/daemon.js");

    const hub = makeFakeHub();
    const daemon = new Daemon({ hub });
    daemon.authState = "ok";

    const conn = makeConn();
    daemon.addConnection(conn);

    // 未知 topic で unsubscribe
    const result = await daemon.invoke("events.unsubscribe", { topics: ["bogus_topic_xyz"] }, conn);

    // エラーにならず {subscribed: []} を返す (no-op)
    expect(result).toMatchObject({ subscribed: [] });
  });

  it("[EVT-0047] events.subscribe は未知 topic で INVALID_PARAMS を投げる (subscribe との非対称確認)", async () => {
    // packages/kit/src/serve/entries/events.js:31-32 — bad = topics.filter(!TOPICS.includes) → throw
    // subscribe は INVALID_PARAMS で拒否する (unsubscribe の no-op と非対称)
    const { Daemon } = await import("../../src/serve/daemon.js");
    const { RPC } = await import("@sesame-kit/core/jsonrpc");

    const hub = makeFakeHub();
    const daemon = new Daemon({ hub });
    daemon.authState = "ok";

    const conn = makeConn();
    daemon.addConnection(conn);

    // subscribe は未知 topic で INVALID_PARAMS を投げる
    await expect(
      daemon.invoke("events.subscribe", { topics: ["bogus_topic_xyz"] }, conn),
    ).rejects.toMatchObject({ code: RPC.INVALID_PARAMS });
  });

  it("[EVT-0047] unsubscribe の未知 topic は set.delete の空振りで処理され残存 subscribed に影響しない", async () => {
    // daemon.unsubscribe (daemon.js:288-294) は set.delete(t) を回すだけで throw しない
    const { Daemon } = await import("../../src/serve/daemon.js");

    const hub = makeFakeHub();
    const daemon = new Daemon({ hub });
    daemon.authState = "ok";

    const conn = makeConn();
    daemon.addConnection(conn);

    // 有効 topic を購読しておく
    daemon.subscribe(conn, ["lockState"]);

    // 未知 topic で unsubscribe しても lockState は残存する
    const result = await daemon.invoke("events.unsubscribe", { topics: ["bogus_topic_xyz"] }, conn);
    expect(result).toMatchObject({ subscribed: expect.arrayContaining(["lockState"]) });

    // lockState は引き続き購読されていること
    const set = daemon._subs.get(conn);
    expect(set.has("lockState")).toBe(true);
  });

  it("[EVT-0047] events.unsubscribe ハンドラソースに TOPICS 検証 (bad-filter) が存在しない (events.js:41-44)", () => {
    const src = readFileSync(
      resolve(HERE, "..", "..", "src", "serve", "entries", "events.js"),
      "utf8"
    );
    // unsubscribe handler は filter で TOPICS.includes を呼ばない
    const unsubBlock = src.match(/"events\.unsubscribe"[\s\S]{0,600}?\},\s*\}/)?.[0] ?? "";
    expect(unsubBlock).not.toMatch(/TOPICS\.includes/);
    expect(unsubBlock).not.toMatch(/filter.*TOPICS/);
  });

  it("[EVT-0047] daemon.unsubscribe: conn 未登録では throw せず {subscribed:[]} を返す (daemon.js:289-290)", async () => {
    const { Daemon } = await import("../../src/serve/daemon.js");
    const hub = makeFakeHub({ connected: false });
    const daemon = new Daemon({ hub });
    const unknownConn = makeConn();
    // _subs に登録していない conn で unsubscribe → throw しない
    const result = daemon.unsubscribe(unknownConn, ["lockState"]);
    expect(result).toEqual({ subscribed: [] });
  });

  it("[EVT-0047] daemon.unsubscribe: 既知も未知も混ぜても throw せず残存 topic のみ返す", async () => {
    const { Daemon } = await import("../../src/serve/daemon.js");
    const hub = makeFakeHub({ connected: false });
    const daemon = new Daemon({ hub });
    const conn = makeConn();
    daemon.addConnection(conn);
    daemon.subscribe(conn, ["lockState"]);

    // 全く登録していない topic を unsubscribe → throw しない
    const result1 = daemon.unsubscribe(conn, ["totally_unknown_topic"]);
    expect(result1).toEqual({ subscribed: ["lockState"] }); // lockState は残存

    // 既知も未知も混ぜても throw しない
    const result2 = daemon.unsubscribe(conn, ["lockState", "another_unknown"]);
    expect(result2).toEqual({ subscribed: [] }); // lockState は削除され unknown は空振り
  });
});
