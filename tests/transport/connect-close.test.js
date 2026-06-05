// Unit tests for Hub3WsClient.connect() / close() lifecycle in src/transport.js
//
// Strategy:
//   - ws の WebSocketServer({port: 0}) を ephemeral 起動し、address().port で URL を組む。
//   - 実 WebSocket で transport.js を動かす (過剰な mock を避け、実コードに近い挙動を検証)。
//   - 各 it は独立。afterEach で client.close() + server.close() を確実に実行。
//   - autoReconnect: false でテストし、reconnect のタイマが背後で走らないようにする。
//   - keepalive (60s 間隔) は real timer のままだと flush しないので、ピン留めの必要なし
//     (各 it は数百 ms オーダーで終わる)。
//   - sleep detector (2s interval, unref'd) は close() で停止される事を別途確認。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocketServer } from "ws";
import { Hub3WsClient } from "../../src/transport.js";

/** @type {WebSocketServer | null} */
let server = null;
/** @type {number} */
let port = 0;
/** @type {Hub3WsClient | null} */
let client = null;

/** test server を立て、port が割り当てられたら resolve。 */
function startServer(onConnection) {
  return new Promise((resolve) => {
    const s = new WebSocketServer({ port: 0 });
    s.on("listening", () => {
      const addr = s.address();
      // address は { port, family, address } の object
      resolve({ server: s, port: addr.port });
    });
    if (onConnection) s.on("connection", onConnection);
  });
}

function makeClient(extra = {}) {
  return new Hub3WsClient({
    wsUrl: `ws://127.0.0.1:${port}`,
    idToken: "dummy.jwt.token",
    autoReconnect: false,
    ...extra,
  });
}

afterEach(async () => {
  // client は close() を冪等的に呼んでもよい
  if (client) {
    try { client.close(); } catch { /* ignore */ }
    client = null;
  }
  if (server) {
    await new Promise((resolve) => server.close(() => resolve()));
    server = null;
  }
  vi.useRealTimers();
});

describe("Hub3WsClient.connect()", () => {
  beforeEach(async () => {
    const started = await startServer();
    server = started.server;
    port = started.port;
  });

  it("connect 成功で status が 'open' になる", async () => {
    client = makeClient();
    expect(client.getStatus()).toBe("disconnected");
    await client.connect();
    expect(client.getStatus()).toBe("open");
  });

  it("connect 成功後、ws インスタンスが生成されている", async () => {
    client = makeClient();
    await client.connect();
    expect(client.ws).not.toBeNull();
    // 接続成功で retryCount は 0 リセット
    expect(client.retryCount).toBe(0);
    // closedByUser は接続開始で false にリセット
    expect(client.closedByUser).toBe(false);
  });

  it("connect URL に token と lang が含まれる (server 側 req.url で検証)", async () => {
    // 新しい server を connection ハンドラ付きで立て直す
    await new Promise((resolve) => server.close(() => resolve()));
    const reqUrls = [];
    const started = await startServer((ws, req) => {
      reqUrls.push(req.url);
    });
    server = started.server;
    port = started.port;

    client = makeClient({ idToken: "tok-abc", lang: "en" });
    await client.connect();
    expect(reqUrls.length).toBe(1);
    expect(reqUrls[0]).toContain("token=tok-abc");
    expect(reqUrls[0]).toContain("lang=en");
  });

  it("既に OPEN の状態で connect() を呼んでも即 resolve し、ws インスタンスは差し替わらない", async () => {
    client = makeClient();
    await client.connect();
    const ws1 = client.ws;
    expect(client.getStatus()).toBe("open");

    // 2 回目の connect() は早期 return
    await client.connect();
    expect(client.ws).toBe(ws1);
    expect(client.getStatus()).toBe("open");
  });

  it("並行に 2 回 connect() を呼ぶと同じ Promise を共有する (二重接続しない)", async () => {
    // server 側で接続数をカウント
    await new Promise((resolve) => server.close(() => resolve()));
    let connCount = 0;
    const started = await startServer(() => { connCount++; });
    server = started.server;
    port = started.port;

    client = makeClient();
    const p1 = client.connect();
    const p2 = client.connect();
    // connect() は async なので外側 Promise は別だが、内部の _connectPromise は
    // 共有され、二重に WebSocket を作らない事 (Review C-2) を確認する。
    await Promise.all([p1, p2]);
    // 接続も 1 回しか起こらない
    expect(connCount).toBe(1);
    expect(client.getStatus()).toBe("open");
  });

  it("不正な URL に対して connect() は reject する", async () => {
    // 存在しない port を狙う (server を閉じてから別の client で接続試行)
    const badPort = port;
    await new Promise((resolve) => server.close(() => resolve()));
    server = null;
    client = new Hub3WsClient({
      wsUrl: `ws://127.0.0.1:${badPort}`,
      idToken: "dummy",
      autoReconnect: false,
    });
    await expect(client.connect()).rejects.toThrow(/websocket closed before open/);
    expect(client.getStatus()).toBe("disconnected");
    // _initialConnect{Resolve,Reject} は両方 null に戻っている
    expect(client._initialConnectReject).toBeNull();
    expect(client._initialConnectResolve).toBeNull();
  });

  it("connect() 後、_connectPromise は finally で null に戻る", async () => {
    client = makeClient();
    await client.connect();
    expect(client._connectPromise).toBeNull();
  });

  it("connect() reject 後にもう一度 connect() を呼ぶと新規 promise として動く", async () => {
    // 一度 reject させる: server が立っていない port を指定
    const closedPort = port;
    await new Promise((resolve) => server.close(() => resolve()));
    server = null;

    client = new Hub3WsClient({
      wsUrl: `ws://127.0.0.1:${closedPort}`,
      idToken: "dummy",
      autoReconnect: false,
    });
    await expect(client.connect()).rejects.toThrow();
    expect(client._connectPromise).toBeNull();

    // 改めて server を別 port で立て直し、wsUrl を差し替える形は不可なので、
    // 同じ instance に対して closedByUser=true がついた状態 (close ハンドラ経由) で
    // 再 connect() できるか確認する。
    // _onClose の "!wasOpen + _initialConnectReject" 分岐で closedByUser=true が
    // セットされるため、ここでは「再 connect() で closedByUser が false にリセットされる」
    // という事だけ確認する。
    expect(client.closedByUser).toBe(true);

    // 同じ port では繋がらないので reject するが、connect() を呼んだ事自体で
    // closedByUser=false に戻る (closedByUser のリセットは connect() 冒頭で行われる)
    const p = client.connect();
    expect(client.closedByUser).toBe(false);
    await expect(p).rejects.toThrow();
  });
});

describe("Hub3WsClient.close()", () => {
  beforeEach(async () => {
    const started = await startServer();
    server = started.server;
    port = started.port;
  });

  it("close() で status が 'disconnected' に戻る", async () => {
    client = makeClient();
    await client.connect();
    expect(client.getStatus()).toBe("open");
    client.close();
    expect(client.getStatus()).toBe("disconnected");
    expect(client.ws).toBeNull();
  });

  it("close() で closedByUser=true、auto-reconnect が抑止される", async () => {
    client = makeClient();
    await client.connect();
    client.close();
    expect(client.closedByUser).toBe(true);
    // reconnectTimer などの再接続タイマも生成されない
    expect(client.reconnectTimer).toBeNull();
  });

  it("close() は messageQueue を空にし subscribers も clear する", async () => {
    client = makeClient();
    await client.connect();
    // 接続前に積まれる queue を作るため、いったん send だけ (open 中なので即送信)
    // pre-close 状態を作る: subscribe を 1 個入れる
    const sub = vi.fn();
    client.subscribe("foo:bar", sub);
    expect(client.subscribers.size).toBeGreaterThan(0);

    // queue を作る: 一度 close→再接続せずに状態だけ ws を null 扱いに
    // ここでは未接続中の send が queue に積まれる事だけ示す
    client.close();
    client.send({ action: "x" });
    // close 後の send で queue に積まれている (closedByUser でも _sendOrQueue は止まらない)
    // ただし close() 自体で messageQueue=[] にリセットされた事は確認できる:
    // close 直後 (上の send 前) は 0 個。send は 1 個追加された。
    expect(client.messageQueue.length).toBe(1);
    // subscribers は close() でクリアされた
    expect(client.subscribers.size).toBe(0);
  });

  it("close() は pending request を全て reject する", async () => {
    client = makeClient();
    await client.connect();
    // 応答が来ない request を 2 つ積む
    const p1 = client.request({ action: "no-reply", op: "a" }, 60_000);
    const p2 = client.request({ action: "no-reply", op: "b" }, 60_000);
    expect(client.pending.size).toBe(2);

    client.close();
    await expect(p1).rejects.toThrow(/closed by user/);
    await expect(p2).rejects.toThrow(/closed by user/);
    expect(client.pending.size).toBe(0);
  });

  it("connect() 中に close() を呼ぶと connect() が reject される", async () => {
    // 接続が完了する前に close する: 別の方法として、connect() の途中 (status===CONNECTING)
    // で close() を呼ぶ。ephemeral server だと open まで非常に速いので、
    // server を閉じておいて connect が hang する状態を作る。
    await new Promise((resolve) => server.close(() => resolve()));
    server = null;

    client = new Hub3WsClient({
      // 接続中で hang する port (closed なので即 close イベントになる事もあるが、
      // open まで行かない事自体は保証される)
      wsUrl: `ws://127.0.0.1:${port}`,
      idToken: "dummy",
      autoReconnect: false,
    });

    const connectPromise = client.connect();
    // 接続前 ws の参照を保持し、close() 直後に no-op error listener を付けて
    // "WebSocket was closed before the connection was established" の uncaught を suppress。
    // (transport.js の close() は removeAllListeners("error") 後に ws.close() するため、
    // async に emit される error を誰も拾わない。production では _initialConnectReject
    // 経由で connect() の reject に変換されるので副作用なし。)
    const wsRef = client.ws;
    // 同期的に close (status は CONNECTING のはず)
    client.close();
    if (wsRef) wsRef.on("error", () => {});

    // close() 側の "_initialConnectReject" 分岐 もしくは _onClose の "wasOpen=false" 分岐
    // のどちらかで reject される。メッセージは "closed before initial connect resolved"
    // または "websocket closed before open"。
    await expect(connectPromise).rejects.toThrow(
      /closed before initial connect resolved|websocket closed before open/,
    );
    expect(client._connectPromise).toBeNull();
    expect(client._initialConnectResolve).toBeNull();
    expect(client._initialConnectReject).toBeNull();
  });

  it("close() を 2 回呼んでも例外を投げない (冪等)", async () => {
    client = makeClient();
    await client.connect();
    client.close();
    expect(() => client.close()).not.toThrow();
    expect(client.getStatus()).toBe("disconnected");
  });

  it("connect 前の close() を呼んでも例外を投げない", () => {
    client = makeClient();
    expect(() => client.close()).not.toThrow();
    expect(client.getStatus()).toBe("disconnected");
    expect(client.closedByUser).toBe(true);
  });

  it("close 後に再度 connect() できる", async () => {
    client = makeClient();
    await client.connect();
    expect(client.getStatus()).toBe("open");
    client.close();
    expect(client.getStatus()).toBe("disconnected");

    // 同じ server に再接続
    await client.connect();
    expect(client.getStatus()).toBe("open");
    expect(client.closedByUser).toBe(false);
  });

  it("close() で sleepDetector / keepalive タイマが停止する", async () => {
    client = makeClient();
    await client.connect();
    expect(client.sleepDetectorTimer).not.toBeNull();
    expect(client.keepaliveTimer).not.toBeNull();
    client.close();
    expect(client.sleepDetectorTimer).toBeNull();
    expect(client.keepaliveTimer).toBeNull();
    expect(client.pongTimer).toBeNull();
    expect(client.connectTimer).toBeNull();
    expect(client.reconnectTimer).toBeNull();
  });
});

describe("Hub3WsClient constructor validation", () => {
  it("wsUrl が無いと throw", () => {
    expect(() => new Hub3WsClient({ idToken: "x" })).toThrow(/wsUrl required/);
  });
  it("idToken が無いと throw", () => {
    expect(() => new Hub3WsClient({ wsUrl: "ws://x" })).toThrow(/idToken required/);
  });
  it("default で autoReconnect=true, lang='ja', debug=false", () => {
    const c = new Hub3WsClient({ wsUrl: "ws://x", idToken: "t" });
    expect(c.cfg.autoReconnect).toBe(true);
    expect(c.cfg.lang).toBe("ja");
    expect(c.cfg.debug).toBe(false);
    expect(c.getStatus()).toBe("disconnected");
  });
});
