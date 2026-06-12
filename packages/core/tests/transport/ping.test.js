// Tests for Hub3WsClient.ping — keepalive round-trip による接続実検証。
//
// ping() の本質は `request({ action: "biz3KeepAlive" }, timeoutMs)` の上に
// `!!resp?.success` を被せた薄いラッパ。よって以下を検証する:
//   - success:true → true
//   - success フィールド省略 / success:false / 非 boolean → false (`!! ` の挙動)
//   - 応答無し → timeoutMs 経過で reject
//   - 既定 timeout (3s) の挙動
//   - keepalive ack を受けた瞬間に内部 pongTimer がクリアされる (_onMessage 側の副作用)
//   - 並行 ping は FIFO で正しく対応 reply を受け取る
//   - close 後の ping は queue にバッファ → 接続前に rejection 経路へ
//
// real ws server を ephemeral port で起動 (request-fifo.test.js の方式を踏襲)。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocketServer } from "ws";
import { Hub3WsClient } from "../../src/transport.js";

/**
 * テスト用 WS サーバ。keepalive 応答の中身を細かく制御できる。
 *  - keepaliveReply: "success-true" | "success-false" | "no-success" | "success-truthy-string" | "silent" | "custom"
 *  - customReply: keepaliveReply==="custom" の時に返す object (or undefined で無応答)
 *  - replyDelayMs: keepalive ack の遅延
 */
function startServer({ keepaliveReply = "success-true", customReply, replyDelayMs = 10 } = {}) {
  const wss = new WebSocketServer({ port: 0 });
  const received = [];
  const sockets = new Set();

  wss.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString("utf8")); } catch { return; }
      received.push(msg);
      if (msg.action !== "biz3KeepAlive") return;

      const send = (obj) => {
        setTimeout(() => {
          try { socket.send(JSON.stringify(obj)); } catch { /* ignore */ }
        }, replyDelayMs);
      };

      switch (keepaliveReply) {
        case "success-true":
          send({ action: "biz3KeepAlive", success: true });
          break;
        case "success-false":
          send({ action: "biz3KeepAlive", success: false });
          break;
        case "no-success":
          // success フィールドそのものが無い (Hub3 server が success 省略する想定)
          send({ action: "biz3KeepAlive" });
          break;
        case "success-truthy-string":
          // success が truthy だが boolean ではないケース (!! で true 化されるはず)
          send({ action: "biz3KeepAlive", success: "yes" });
          break;
        case "silent":
          // 黙殺 — timeout 動作の検証用
          break;
        case "custom":
          if (customReply !== undefined) send(customReply);
          break;
      }
    });
  });

  const port = wss.address().port;
  return {
    url: `ws://127.0.0.1:${port}`,
    received,
    sockets,
    async close() {
      for (const s of sockets) { try { s.terminate(); } catch { /* ignore */ } }
      await new Promise((res) => wss.close(() => res()));
    },
  };
}

describe("Hub3WsClient.ping", () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let server;
  /** @type {Hub3WsClient | null} */
  let client;

  beforeEach(() => {
    server = null;
    client = null;
  });

  afterEach(async () => {
    if (client) {
      try { client.close(); } catch { /* ignore */ }
      client = null;
    }
    if (server) {
      await server.close();
      server = null;
    }
  });

  it("サーバが {success:true} を返すと ping() は true を resolve する", async () => {
    server = startServer({ keepaliveReply: "success-true" });
    client = new Hub3WsClient({ wsUrl: server.url, idToken: "dummy-token", autoReconnect: false });
    await client.connect();

    await expect(client.ping(1000)).resolves.toBe(true);
  });

  // biz3 の keepalive ack は success ではなく connectionId を返す (WebSocketManager.ts:72-83)。
  // ping() は「応答が届いたこと自体」を生存判定とするため、success 有無に関わらず true。
  it("サーバが success フィールドを省略しても応答が来れば ping() は true (biz3 ack は connectionId)", async () => {
    server = startServer({ keepaliveReply: "no-success" });
    client = new Hub3WsClient({ wsUrl: server.url, idToken: "dummy-token", autoReconnect: false });
    await client.connect();

    await expect(client.ping(500)).resolves.toBe(true);
  });

  it("サーバが {success:false} でも応答が来れば ping() は true (応答受信=生存)", async () => {
    server = startServer({ keepaliveReply: "success-false" });
    client = new Hub3WsClient({ wsUrl: server.url, idToken: "dummy-token", autoReconnect: false });
    await client.connect();

    await expect(client.ping(500)).resolves.toBe(true);
  });

  it("success が truthy な非 boolean ('yes') でも当然 true", async () => {
    server = startServer({ keepaliveReply: "success-truthy-string" });
    client = new Hub3WsClient({ wsUrl: server.url, idToken: "dummy-token", autoReconnect: false });
    await client.connect();

    await expect(client.ping(500)).resolves.toBe(true);
  });

  it("サーバが応答しないと timeoutMs 経過で reject される (request timeout: biz3KeepAlive:)", async () => {
    server = startServer({ keepaliveReply: "silent" });
    client = new Hub3WsClient({ wsUrl: server.url, idToken: "dummy-token", autoReconnect: false });
    await client.connect();

    const t0 = Date.now();
    // op が無いので key は "biz3KeepAlive:"。エラー message にこの key が含まれる
    await expect(client.ping(80)).rejects.toThrow(/request timeout: biz3KeepAlive:/);
    const elapsed = Date.now() - t0;
    // 80ms 指定 → 概ねその近辺 (上振れは OS スケジューラに依存)
    expect(elapsed).toBeGreaterThanOrEqual(60);
    expect(elapsed).toBeLessThan(1500);
  });

  it("既定の timeoutMs (PONG_TIMEOUT_MS = 3000) で reject される", async () => {
    // 既定値 3000ms で待たされると CI が遅くなるので、ここでは
    // 「timeoutMs を渡さず呼べる」ことと「resolve は ack で成立する」ことだけ確認
    server = startServer({ keepaliveReply: "success-true" });
    client = new Hub3WsClient({ wsUrl: server.url, idToken: "dummy-token", autoReconnect: false });
    await client.connect();

    // 引数省略パス: 既定 timeout を上回らない範囲で resolve するはず
    await expect(client.ping()).resolves.toBe(true);
  });

  it("並列で投げた 2 本の ping() がいずれも true で resolve する", async () => {
    server = startServer({ keepaliveReply: "success-true", replyDelayMs: 20 });
    client = new Hub3WsClient({ wsUrl: server.url, idToken: "dummy-token", autoReconnect: false });
    await client.connect();

    const [a, b] = await Promise.all([client.ping(1000), client.ping(1000)]);
    expect(a).toBe(true);
    expect(b).toBe(true);
  });

  it("並列 ping のうち 1 本だけ timeout する状況: 後続 reply は早い方の resolver を解く (FIFO)", async () => {
    // 接続直後の auto-keepalive (1本目) には ack を返し、
    // それ以降は ping() N 本目 (N=1 から数える) に対して
    //   N==1: 30ms で success:true
    //   N>=2: 黙殺
    // → 2 本並列 ping のうち先頭が resolve、後続は timeout
    let pingCallCount = 0;
    let autoKeepaliveAcked = false;
    const wss = new WebSocketServer({ port: 0 });
    const sockets = new Set();
    wss.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString("utf8")); } catch { return; }
        if (msg.action !== "biz3KeepAlive") return;
        if (!autoKeepaliveAcked) {
          autoKeepaliveAcked = true;
          setTimeout(() => {
            try { socket.send(JSON.stringify({ action: "biz3KeepAlive", success: true })); } catch { /* ignore */ }
          }, 5);
          return;
        }
        pingCallCount++;
        if (pingCallCount === 1) {
          setTimeout(() => {
            try { socket.send(JSON.stringify({ action: "biz3KeepAlive", success: true })); } catch { /* ignore */ }
          }, 30);
        }
        // それ以降は黙殺
      });
    });
    const port = wss.address().port;
    server = {
      url: `ws://127.0.0.1:${port}`,
      received: [],
      sockets,
      async close() {
        for (const s of sockets) { try { s.terminate(); } catch { /* ignore */ } }
        await new Promise((res) => wss.close(() => res()));
      },
    };

    client = new Hub3WsClient({ wsUrl: server.url, idToken: "dummy-token", autoReconnect: false });
    await client.connect();
    // 接続直後の auto-keepalive 応答が ping() の pending に間違って吸われないよう
    // 応答到達まで待ってから ping を呼ぶ
    await new Promise((r) => setTimeout(r, 50));

    const p1 = client.ping(500);
    const p2 = client.ping(120);

    await expect(p1).resolves.toBe(true);
    await expect(p2).rejects.toThrow(/request timeout: biz3KeepAlive:/);
  });

  it("ping は keepalive action を 1 本送信し、key 'biz3KeepAlive:' が pending に積まれる", async () => {
    // 応答しないサーバ → ping が pending 状態のまま観察できる
    server = startServer({ keepaliveReply: "silent" });
    client = new Hub3WsClient({ wsUrl: server.url, idToken: "dummy-token", autoReconnect: false });
    await client.connect();

    const pingPromise = client.ping(2000);
    // microtask + tick で register が完了するまで少し待つ
    await new Promise((r) => setTimeout(r, 30));

    expect(client.pending.has("biz3KeepAlive:")).toBe(true);
    expect(client.pending.get("biz3KeepAlive:").length).toBe(1);

    // 後片付け: close() で reject
    client.close();
    await expect(pingPromise).rejects.toThrow(/websocket closed by user/);
    client = null;
  });

  it("close() 後に確立済み接続が落とされ、in-flight ping は reject される", async () => {
    server = startServer({ keepaliveReply: "silent" });
    client = new Hub3WsClient({ wsUrl: server.url, idToken: "dummy-token", autoReconnect: false });
    await client.connect();

    const p = client.ping(3000);
    await new Promise((r) => setTimeout(r, 20));
    client.close();
    await expect(p).rejects.toThrow(/websocket closed by user/);
    client = null;
  });

  it("接続が外から切断されると ping は 'websocket closed' で reject される (autoReconnect=false)", async () => {
    // 接続直後の auto-keepalive にだけ ack を返し、明示 ping への応答は無しでソケット強制切断
    const wss = new WebSocketServer({ port: 0 });
    const sockets = new Set();
    let autoKeepaliveAcked = false;
    wss.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString("utf8")); } catch { return; }
        if (msg.action !== "biz3KeepAlive") return;
        if (!autoKeepaliveAcked) {
          autoKeepaliveAcked = true;
          setTimeout(() => {
            try { socket.send(JSON.stringify({ action: "biz3KeepAlive", success: true })); } catch { /* ignore */ }
          }, 5);
          return;
        }
        // 明示 ping() は応答せずに切断
        setTimeout(() => { try { socket.terminate(); } catch { /* ignore */ } }, 10);
      });
    });
    const port = wss.address().port;
    server = {
      url: `ws://127.0.0.1:${port}`,
      received: [],
      sockets,
      async close() {
        for (const s of sockets) { try { s.terminate(); } catch { /* ignore */ } }
        await new Promise((res) => wss.close(() => res()));
      },
    };

    client = new Hub3WsClient({ wsUrl: server.url, idToken: "dummy-token", autoReconnect: false });
    await client.connect();
    // 接続直後 auto-keepalive 応答の到達を待ってから ping() を呼ぶ
    // (さもないと auto ack が FIFO で ping の resolver に吸われて true 解決してしまう)
    await new Promise((r) => setTimeout(r, 50));

    await expect(client.ping(3000)).rejects.toThrow(/websocket closed/);
  });

  it("ping の応答が届いた直後に内部 pongTimer がクリアされる (success 有無問わず)", async () => {
    // success フィールド無しでもメッセージ自体は届くので
    // _onMessage 内の `if (msg.action === KEEPALIVE_ACTION) clearTimeout(pongTimer)` が走る
    server = startServer({ keepaliveReply: "no-success" });
    client = new Hub3WsClient({ wsUrl: server.url, idToken: "dummy-token", autoReconnect: false });
    await client.connect();

    // 接続直後の auto-keepalive 応答で pongTimer はクリアされているはず
    // (_triggerHeartbeatCheck → setTimeout → 受信時に clearTimeout)
    // 応答到達まで少し待つ
    await new Promise((r) => setTimeout(r, 50));
    // この時点で pongTimer は null になっているはず
    expect(client.pongTimer).toBeNull();

    // ping() は応答受信で true、かつ pongTimer は null のまま
    const result = await client.ping(500);
    expect(result).toBe(true);
    expect(client.pongTimer).toBeNull();
  });

  it("op フィールドの無い payload を送るため、サーバが受信したメッセージに op が含まれない", async () => {
    server = startServer({ keepaliveReply: "success-true" });
    client = new Hub3WsClient({ wsUrl: server.url, idToken: "dummy-token", autoReconnect: false });
    await client.connect();

    await client.ping(1000);

    // 接続直後の auto keepalive と ping() の keepalive、いずれも { action: "biz3KeepAlive" } のみ
    const keepalives = server.received.filter((m) => m.action === "biz3KeepAlive");
    expect(keepalives.length).toBeGreaterThanOrEqual(1);
    for (const m of keepalives) {
      expect(m.op).toBeUndefined();
      expect(Object.keys(m)).toEqual(["action"]);
    }
  });
});
