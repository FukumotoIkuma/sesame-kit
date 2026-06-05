// Unit tests for Hub3WsClient message queue + _flushMessageQueue (src/transport.js).
//
// 対象動作:
//   1. status !== OPEN のとき send() / request() の payload は messageQueue に積まれる
//   2. connect が OPEN になると _onOpen → _flushMessageQueue で queue が server へ送出される
//   3. flush 時、enqueuedAt が 60s 超 (QUEUE_ENTRY_MAX_AGE_MS) の entry は drop される
//   4. close() で messageQueue は空になる
//   5. flush 中の ws.send 失敗で残りは unshift されてキューに戻る
//
// 戦略:
//   - 実 WebSocket を `ws` の WebSocketServer で ephemeral port に立てて、
//     server.on("message") で受信したものを集める。
//   - 時刻は基本 real timer。60s drop 判定は messageQueue に手動で古い
//     enqueuedAt の entry を仕込んで決定的に検証する (fake timer は ws の I/O と
//     相性が悪いため避ける)。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocketServer } from "ws";
import { Hub3WsClient } from "../../src/transport.js";

/** server 側で受信した payload (JSON parse 済) を順番に集める */
function startServer() {
  const received = [];
  const conns = [];
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (ws) => {
    conns.push(ws);
    ws.on("message", (raw) => {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      try {
        received.push(JSON.parse(text));
      } catch {
        received.push({ __raw: text });
      }
    });
  });
  return new Promise((resolve) => {
    wss.on("listening", () => {
      const port = wss.address().port;
      resolve({ wss, port, received, conns, url: `ws://127.0.0.1:${port}` });
    });
  });
}

async function stopServer(server) {
  if (!server) return;
  for (const ws of server.conns) {
    try { ws.terminate(); } catch { /* ignore */ }
  }
  await new Promise((resolve) => server.wss.close(() => resolve()));
}

/** server が n 個 keepalive 以外の payload を受け取るまで待つ */
async function waitForNonKeepalive(server, n, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const nonKa = server.received.filter((m) => m.action !== "biz3KeepAlive");
    if (nonKa.length >= n) return nonKa;
    await new Promise((r) => setTimeout(r, 10));
  }
  return server.received.filter((m) => m.action !== "biz3KeepAlive");
}

describe("Hub3WsClient message queue + _flushMessageQueue", () => {
  /** @type {Awaited<ReturnType<typeof startServer>> | null} */
  let server = null;
  /** @type {Hub3WsClient | null} */
  let client = null;

  beforeEach(async () => {
    server = await startServer();
  });

  afterEach(async () => {
    if (client) {
      try { client.close(); } catch { /* ignore */ }
      client = null;
    }
    await stopServer(server);
    server = null;
  });

  it("未接続中の send() は messageQueue に積まれ ws.send は呼ばれない", () => {
    client = new Hub3WsClient({
      wsUrl: server.url,
      idToken: "dummy.jwt.token",
      autoReconnect: false,
    });
    expect(client.getStatus()).toBe("disconnected");

    client.send({ action: "foo", op: "bar", n: 1 });
    client.send({ action: "foo", op: "bar", n: 2 });

    expect(client.messageQueue).toHaveLength(2);
    expect(client.messageQueue[0].payload).toEqual({ action: "foo", op: "bar", n: 1 });
    expect(client.messageQueue[1].payload).toEqual({ action: "foo", op: "bar", n: 2 });
    expect(typeof client.messageQueue[0].enqueuedAt).toBe("number");
  });

  it("未接続中の request() は payload を messageQueue に積み pending にも登録する", () => {
    client = new Hub3WsClient({
      wsUrl: server.url,
      idToken: "dummy.jwt.token",
      autoReconnect: false,
    });
    // 失敗時のテストノイズを避けるため reject は黙殺
    client.request({ action: "ping", op: "" }, 60_000).catch(() => {});

    expect(client.messageQueue).toHaveLength(1);
    expect(client.messageQueue[0].payload).toEqual({ action: "ping", op: "" });
    expect(client.pending.get("ping:")).toBeDefined();
    expect(client.pending.get("ping:")).toHaveLength(1);
  });

  it("connect 成功で messageQueue は FIFO で server に flush され空になる", async () => {
    client = new Hub3WsClient({
      wsUrl: server.url,
      idToken: "dummy.jwt.token",
      autoReconnect: false,
    });

    client.send({ action: "first", n: 1 });
    client.send({ action: "second", n: 2 });
    client.send({ action: "third", n: 3 });
    expect(client.messageQueue).toHaveLength(3);

    await client.connect();
    // open 直後の keepalive を除いて 3 件届くはず
    const got = await waitForNonKeepalive(server, 3);
    expect(got).toHaveLength(3);
    expect(got[0]).toMatchObject({ action: "first", n: 1 });
    expect(got[1]).toMatchObject({ action: "second", n: 2 });
    expect(got[2]).toMatchObject({ action: "third", n: 3 });
    expect(client.messageQueue).toHaveLength(0);
  });

  it("queue が空のまま connect しても flush は何も送らずエラーも出さない", async () => {
    client = new Hub3WsClient({
      wsUrl: server.url,
      idToken: "dummy.jwt.token",
      autoReconnect: false,
    });
    await client.connect();
    // keepalive 以外は到着していないこと
    await new Promise((r) => setTimeout(r, 50));
    const got = server.received.filter((m) => m.action !== "biz3KeepAlive");
    expect(got).toHaveLength(0);
    expect(client.messageQueue).toHaveLength(0);
  });

  it("enqueuedAt が 60s より古い entry は flush 時に drop され、新しい entry のみ送信される", async () => {
    client = new Hub3WsClient({
      wsUrl: server.url,
      idToken: "dummy.jwt.token",
      autoReconnect: false,
    });

    // 接続前に古い entry を直接ねじ込む (60s+1s 前)。
    const now = Date.now();
    client.messageQueue.push({ payload: { action: "stale1" }, enqueuedAt: now - 61_000 });
    client.messageQueue.push({ payload: { action: "stale2" }, enqueuedAt: now - 70_000 });
    // 新しい entry は send() 経由で正規に
    client.send({ action: "fresh", n: 1 });
    client.send({ action: "fresh", n: 2 });

    expect(client.messageQueue).toHaveLength(4);

    await client.connect();
    const got = await waitForNonKeepalive(server, 2);
    expect(got).toHaveLength(2);
    expect(got.map((m) => m.action)).toEqual(["fresh", "fresh"]);
    expect(got.map((m) => m.n)).toEqual([1, 2]);
    // queue は空になっている (stale は drop、fresh は送信済)
    expect(client.messageQueue).toHaveLength(0);
  });

  it("drop ロジックは先頭から順に評価し、古→新の境界で止まる (新しい entry の後ろに古い entry があれば残る)", async () => {
    // _flushMessageQueue の実装は while で先頭だけ見て drop するため、
    // 先頭が新しければ後ろが古くても drop されず送信される (= FIFO 順守)
    client = new Hub3WsClient({
      wsUrl: server.url,
      idToken: "dummy.jwt.token",
      autoReconnect: false,
    });

    const now = Date.now();
    client.messageQueue.push({ payload: { action: "newish", n: 0 }, enqueuedAt: now });
    client.messageQueue.push({ payload: { action: "oldButAfter", n: 1 }, enqueuedAt: now - 99_000 });

    await client.connect();
    const got = await waitForNonKeepalive(server, 2);
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ action: "newish", n: 0 });
    expect(got[1]).toMatchObject({ action: "oldButAfter", n: 1 });
  });

  it("ちょうど 60_000ms ピッタリの entry は drop されない (境界条件: 厳密 >)", async () => {
    client = new Hub3WsClient({
      wsUrl: server.url,
      idToken: "dummy.jwt.token",
      autoReconnect: false,
    });

    // 実装は `now - enqueuedAt > QUEUE_ENTRY_MAX_AGE_MS` (strict >).
    // ピッタリ 60s 前なら残る。少し余裕を持って 59.5s 前を入れる
    // (test 実行中に 500ms 以上経過して 60s 超になる事故を避けるため)。
    const now = Date.now();
    client.messageQueue.push({ payload: { action: "borderline" }, enqueuedAt: now - 59_500 });

    await client.connect();
    const got = await waitForNonKeepalive(server, 1);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ action: "borderline" });
  });

  it("close() で messageQueue は空になる", () => {
    client = new Hub3WsClient({
      wsUrl: server.url,
      idToken: "dummy.jwt.token",
      autoReconnect: false,
    });

    client.send({ action: "x", n: 1 });
    client.send({ action: "x", n: 2 });
    client.send({ action: "x", n: 3 });
    expect(client.messageQueue).toHaveLength(3);

    client.close();

    expect(client.messageQueue).toHaveLength(0);
    expect(client.getStatus()).toBe("disconnected");
  });

  it("接続後の send() は queue を経由せず直接 ws に送信される (queue は積まれない)", async () => {
    client = new Hub3WsClient({
      wsUrl: server.url,
      idToken: "dummy.jwt.token",
      autoReconnect: false,
    });
    await client.connect();
    // OPEN 状態を確認
    expect(client.getStatus()).toBe("open");

    client.send({ action: "live", n: 1 });
    // _sendOrQueue の OPEN ブランチは queue に積まないはず
    expect(client.messageQueue).toHaveLength(0);

    const got = await waitForNonKeepalive(server, 1);
    expect(got[0]).toMatchObject({ action: "live", n: 1 });
  });

  it("ws.send が flush 中に throw した場合、entry は unshift で先頭に戻され queue が残る", () => {
    // 実 server に対して flush 中に throw させるのは難しいので、
    // ws を fake で差し替えて status=OPEN を作り、_flushMessageQueue を直接呼ぶ。
    client = new Hub3WsClient({
      wsUrl: server.url,
      idToken: "dummy.jwt.token",
      autoReconnect: false,
    });

    let sendCallCount = 0;
    const fakeWs = {
      send(_data) {
        sendCallCount++;
        if (sendCallCount === 2) {
          throw new Error("simulated send failure");
        }
        // 1 回目は成功
      },
    };
    client.ws = fakeWs;
    client.status = "open";

    const now = Date.now();
    client.messageQueue.push({ payload: { action: "a", n: 1 }, enqueuedAt: now });
    client.messageQueue.push({ payload: { action: "b", n: 2 }, enqueuedAt: now });
    client.messageQueue.push({ payload: { action: "c", n: 3 }, enqueuedAt: now });

    client._flushMessageQueue();

    // 1 個目は送信成功で消費、2 個目で throw → unshift で戻る、3 個目はそのまま残る
    expect(sendCallCount).toBe(2);
    expect(client.messageQueue).toHaveLength(2);
    expect(client.messageQueue[0].payload).toEqual({ action: "b", n: 2 });
    expect(client.messageQueue[1].payload).toEqual({ action: "c", n: 3 });
  });

  it("status !== OPEN だと _flushMessageQueue は何もしない (queue を消費しない)", () => {
    client = new Hub3WsClient({
      wsUrl: server.url,
      idToken: "dummy.jwt.token",
      autoReconnect: false,
    });

    // ws はあるが CONNECTING
    let sendCalled = false;
    client.ws = { send() { sendCalled = true; } };
    client.status = "connecting";

    const now = Date.now();
    client.messageQueue.push({ payload: { action: "x", n: 1 }, enqueuedAt: now });

    client._flushMessageQueue();

    expect(sendCalled).toBe(false);
    expect(client.messageQueue).toHaveLength(1);
  });

  it("ws=null だと _flushMessageQueue は何もしない", () => {
    client = new Hub3WsClient({
      wsUrl: server.url,
      idToken: "dummy.jwt.token",
      autoReconnect: false,
    });

    client.ws = null;
    client.status = "open"; // ありえない組合せだが防御をテスト

    const now = Date.now();
    client.messageQueue.push({ payload: { action: "x", n: 1 }, enqueuedAt: now });

    client._flushMessageQueue();

    expect(client.messageQueue).toHaveLength(1);
  });

  it("queue が全て stale でも flush は安全に空になる (drop のみで終わる)", () => {
    client = new Hub3WsClient({
      wsUrl: server.url,
      idToken: "dummy.jwt.token",
      autoReconnect: false,
    });

    let sendCalled = false;
    client.ws = { send() { sendCalled = true; } };
    client.status = "open";

    const now = Date.now();
    client.messageQueue.push({ payload: { action: "old1" }, enqueuedAt: now - 120_000 });
    client.messageQueue.push({ payload: { action: "old2" }, enqueuedAt: now - 90_000 });
    client.messageQueue.push({ payload: { action: "old3" }, enqueuedAt: now - 61_000 });

    client._flushMessageQueue();

    expect(client.messageQueue).toHaveLength(0);
    expect(sendCalled).toBe(false);
  });
});
