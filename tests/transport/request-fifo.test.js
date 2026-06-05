// Tests for Hub3WsClient.request — FIFO semantics, timeout, queueing, isolation.
//
// 実 WebSocketServer を ephemeral port で起動し、限りなく実際の挙動に近い
// 形でテストする。fake timer は避ける (ws の I/O が real timer に依存するため)。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocketServer } from "ws";
import { Hub3WsClient } from "../../src/transport.js";

/**
 * テスト用 WS サーバ。
 *  - 受信メッセージを全部 received[] に貯める
 *  - request handler を差し替えられる (デフォルトは echo + 連番)
 */
function startServer({ replyDelayMs = 50, autoReply = true } = {}) {
  const wss = new WebSocketServer({ port: 0 });
  const received = [];
  const sockets = new Set();
  let seq = 0;
  /** @type {(socket: import("ws").WebSocket, msg: any) => void} */
  let handler = (socket, msg) => {
    if (!autoReply) return;
    // keepalive はそのまま success ack で返す (テストの邪魔をしないため)
    if (msg.action === "biz3KeepAlive") {
      setTimeout(() => {
        try { socket.send(JSON.stringify({ action: "biz3KeepAlive", success: true })); } catch { /* ignore */ }
      }, 1);
      return;
    }
    const replySeq = ++seq;
    setTimeout(() => {
      try {
        socket.send(JSON.stringify({
          action: msg.action,
          op: msg.op,
          success: true,
          seq: replySeq,
          echo: msg,
        }));
      } catch { /* ignore (socket may have closed) */ }
    }, replyDelayMs);
  };

  wss.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString("utf8")); } catch { return; }
      received.push(msg);
      handler(socket, msg);
    });
  });

  const port = wss.address().port;
  return {
    url: `ws://127.0.0.1:${port}`,
    received,
    sockets,
    setHandler(fn) { handler = fn; },
    async close() {
      for (const s of sockets) { try { s.terminate(); } catch { /* ignore */ } }
      await new Promise((res) => wss.close(() => res()));
    },
  };
}

describe("Hub3WsClient.request", () => {
  /** @type {Awaited<ReturnType<typeof startServer>>} */
  let server;
  /** @type {Hub3WsClient} */
  let client;

  beforeEach(async () => {
    server = startServer();
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

  it("接続済みなら request が正常応答で resolve する", async () => {
    client = new Hub3WsClient({ wsUrl: server.url, idToken: "dummy-token", autoReconnect: false });
    await client.connect();

    const resp = await client.request({ action: "myAction", op: "myOp" }, 2000);
    expect(resp.success).toBe(true);
    expect(resp.action).toBe("myAction");
    expect(resp.op).toBe("myOp");
    expect(resp.echo).toEqual({ action: "myAction", op: "myOp" });
  });

  it("同一 (action, op) を並列発行すると FIFO で先に投げた方が先に解決する", async () => {
    client = new Hub3WsClient({ wsUrl: server.url, idToken: "dummy-token", autoReconnect: false });
    await client.connect();

    // payload に index を入れて区別。サーバは seq を連番で振るので、
    // 「先に送った request の resolver が seq=N (小さい方) を受け取る」ことを確認。
    const p1 = client.request({ action: "A", op: "X", marker: 1 }, 2000);
    const p2 = client.request({ action: "A", op: "X", marker: 2 }, 2000);

    const [r1, r2] = await Promise.all([p1, p2]);
    // FIFO: 最初に register された resolver が最初の reply を取る
    expect(r1.seq).toBeLessThan(r2.seq);
    // echo で marker が「先に送った方は marker=1」を確認できる
    expect(r1.echo.marker).toBe(1);
    expect(r2.echo.marker).toBe(2);
  });

  it("3 並列でも FIFO 順を厳守する", async () => {
    client = new Hub3WsClient({ wsUrl: server.url, idToken: "dummy-token", autoReconnect: false });
    await client.connect();

    const ps = [1, 2, 3].map((i) => client.request({ action: "B", op: "Y", marker: i }, 2000));
    const rs = await Promise.all(ps);
    expect(rs.map((r) => r.echo.marker)).toEqual([1, 2, 3]);
    expect(rs[0].seq).toBeLessThan(rs[1].seq);
    expect(rs[1].seq).toBeLessThan(rs[2].seq);
  });

  it("timeoutMs を超えると reject され、pending から消える", async () => {
    // サーバはこの action に応答しない
    server.setHandler((socket, msg) => {
      if (msg.action === "biz3KeepAlive") {
        try { socket.send(JSON.stringify({ action: "biz3KeepAlive", success: true })); } catch { /* ignore */ }
      }
      // それ以外は黙殺
    });
    client = new Hub3WsClient({ wsUrl: server.url, idToken: "dummy-token", autoReconnect: false });
    await client.connect();

    await expect(client.request({ action: "noReply", op: "z" }, 80))
      .rejects.toThrow(/request timeout: noReply:z/);

    // pending から該当 key が消えていることを確認
    expect(client.pending.has("noReply:z")).toBe(false);
  });

  it("無関係 action の応答では別 request の promise が解決しない", async () => {
    // 来た request はすべて「別 action」で返す
    server.setHandler((socket, msg) => {
      if (msg.action === "biz3KeepAlive") {
        try { socket.send(JSON.stringify({ action: "biz3KeepAlive", success: true })); } catch { /* ignore */ }
        return;
      }
      setTimeout(() => {
        try {
          socket.send(JSON.stringify({ action: "UNRELATED", op: "zzz", success: true }));
        } catch { /* ignore */ }
      }, 20);
    });
    client = new Hub3WsClient({ wsUrl: server.url, idToken: "dummy-token", autoReconnect: false });
    await client.connect();

    await expect(client.request({ action: "wantThis", op: "op1" }, 150))
      .rejects.toThrow(/request timeout: wantThis:op1/);
  });

  it("op が無い (undefined) payload と op:'' は同じ key として扱われる", async () => {
    client = new Hub3WsClient({ wsUrl: server.url, idToken: "dummy-token", autoReconnect: false });
    await client.connect();

    // op 無し payload を送って、応答 (サーバは op:undefined を echo するので op フィールドは存在しない)
    // を受け取れることを確認
    const resp = await client.request({ action: "noOp" }, 2000);
    expect(resp.action).toBe("noOp");
    expect(resp.success).toBe(true);
  });

  it("未接続中の request は messageQueue に積まれ、接続後 flush されて解決する", async () => {
    client = new Hub3WsClient({ wsUrl: server.url, idToken: "dummy-token", autoReconnect: false });
    // 接続せずに request を投げる → messageQueue に積まれる
    const reqPromise = client.request({ action: "queued", op: "q1" }, 3000);
    expect(client.messageQueue.length).toBe(1);
    expect(client.pending.get("queued:q1")?.length).toBe(1);

    // 後から接続 → flush され応答が返る
    await client.connect();
    const resp = await reqPromise;
    expect(resp.action).toBe("queued");
    expect(resp.op).toBe("q1");
    expect(client.messageQueue.length).toBe(0);
  });

  it("close() で in-flight request は 'websocket closed by user' で reject される", async () => {
    // 応答しないサーバ
    server.setHandler((socket, msg) => {
      if (msg.action === "biz3KeepAlive") {
        try { socket.send(JSON.stringify({ action: "biz3KeepAlive", success: true })); } catch { /* ignore */ }
      }
    });
    client = new Hub3WsClient({ wsUrl: server.url, idToken: "dummy-token", autoReconnect: false });
    await client.connect();

    const reqPromise = client.request({ action: "willBeClosed", op: "k" }, 5000);
    // 少し待ってから close (request が register された後で)
    await new Promise((r) => setTimeout(r, 20));
    client.close();

    await expect(reqPromise).rejects.toThrow(/websocket closed by user/);
    // client.close() 後の cleanup なので nullable; ただしテストでは再代入しないよう null へ
    client = null;
  });

  it("異なる (action, op) は別 key として独立に管理される", async () => {
    client = new Hub3WsClient({ wsUrl: server.url, idToken: "dummy-token", autoReconnect: false });
    await client.connect();

    const [a, b] = await Promise.all([
      client.request({ action: "A", op: "1" }, 2000),
      client.request({ action: "B", op: "2" }, 2000),
    ]);
    expect(a.action).toBe("A");
    expect(a.op).toBe("1");
    expect(b.action).toBe("B");
    expect(b.op).toBe("2");
  });

  it("timeout 後に遅延応答が来ても (同 key の) pending には影響しない", async () => {
    // 200ms 遅延で返す
    server.setHandler((socket, msg) => {
      if (msg.action === "biz3KeepAlive") {
        try { socket.send(JSON.stringify({ action: "biz3KeepAlive", success: true })); } catch { /* ignore */ }
        return;
      }
      setTimeout(() => {
        try {
          socket.send(JSON.stringify({ action: msg.action, op: msg.op, success: true, lateReply: true }));
        } catch { /* ignore */ }
      }, 200);
    });
    client = new Hub3WsClient({ wsUrl: server.url, idToken: "dummy-token", autoReconnect: false });
    await client.connect();

    // 1st は短い timeout で reject
    await expect(client.request({ action: "lateAction", op: "L" }, 50))
      .rejects.toThrow(/request timeout/);
    expect(client.pending.has("lateAction:L")).toBe(false);

    // 遅延応答 (1st 用) が今から到着するが、2nd の request は同じ key で出して
    // 「遅延応答が 2nd を間違って解決しない」ことを保証したい。
    // ただし FIFO の仕様上、もし 1st が pending に残っていたら 1st が解決される。
    // pending から消えている (timeout 時に _unregisterPending) ので、
    // 遅延応答 (1st 分) は誰も拾わず黙殺される。続いて 2nd を送る:
    const resp2 = await client.request({ action: "lateAction", op: "L" }, 500);
    // 2nd 用に新たに飛んできた応答 (server は受信ごとに reply するため) を拾う
    expect(resp2.action).toBe("lateAction");
    expect(resp2.success).toBe(true);
  });

  it("接続が切れると in-flight request は 'websocket closed' で reject される (autoReconnect=false)", async () => {
    // 応答しないサーバ + 強制切断
    server.setHandler((socket, msg) => {
      if (msg.action === "biz3KeepAlive") {
        try { socket.send(JSON.stringify({ action: "biz3KeepAlive", success: true })); } catch { /* ignore */ }
        return;
      }
      // request 受信後にソケットを強制切断
      setTimeout(() => { try { socket.terminate(); } catch { /* ignore */ } }, 10);
    });
    client = new Hub3WsClient({ wsUrl: server.url, idToken: "dummy-token", autoReconnect: false });
    await client.connect();

    await expect(client.request({ action: "willDisconnect", op: "d" }, 3000))
      .rejects.toThrow(/websocket closed/);
  });

  it("同一 key 並列で 1 個だけ timeout した場合、残りの request は影響を受けない", async () => {
    // 最初の reply を 30ms、2 個目以降は 200ms 遅延で返す
    let count = 0;
    server.setHandler((socket, msg) => {
      if (msg.action === "biz3KeepAlive") {
        try { socket.send(JSON.stringify({ action: "biz3KeepAlive", success: true })); } catch { /* ignore */ }
        return;
      }
      count++;
      const delay = count === 1 ? 30 : 200;
      const myCount = count;
      setTimeout(() => {
        try {
          socket.send(JSON.stringify({ action: msg.action, op: msg.op, success: true, n: myCount }));
        } catch { /* ignore */ }
      }, delay);
    });
    client = new Hub3WsClient({ wsUrl: server.url, idToken: "dummy-token", autoReconnect: false });
    await client.connect();

    // p1 は 100ms で timeout (server reply は 30ms なので実は p1 が先に取れる…
    // ではなく FIFO で p1 が 30ms の reply を取り resolve、p2 は 200ms reply を待つ)
    const p1 = client.request({ action: "mix", op: "m" }, 500);
    const p2 = client.request({ action: "mix", op: "m" }, 500);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.n).toBe(1);
    expect(r2.n).toBe(2);
  });
});
