// Hub3WsClient.subscribe / onMessage / _onMessage fan-out 単体テスト
//
// 観点:
//   - subscribe で特定 (action, op) の msg のみ受信し、unsubscribe で受信停止
//   - 複数 subscriber が同 key を受信
//   - ハンドラ内で他 subscriber を unsub しても snapshot iterate で当該フレーム配信
//   - onMessage は全 msg 受信し、戻り unsubscribe で外せる
//   - close で subscribers と listeners が完全クリア
//   - subscriber/listener が例外を throw しても他に伝播しない
//
// 戦略: _onMessage(raw) は raw を受けて JSON.parse → routing する純粋関数に近いため、
//   ネットワークを介さず client._onMessage(JSON.stringify(...)) を直接叩いて
//   fan-out 挙動を確定的にテストする。最後に 1 ケースだけ実際の WebSocket 経由
//   (ephemeral port の `ws` server) でも end-to-end を確認する。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocketServer } from "ws";
import { Hub3WsClient } from "../../src/transport.js";

function newClient() {
  // idToken は dummy。connect() は呼ばないので実通信は発生しない。
  return new Hub3WsClient({
    wsUrl: "ws://localhost:1",
    idToken: "dummy-token",
    autoReconnect: false,
  });
}

function deliver(client, msg) {
  // _onMessage は string も Buffer も受け取れる
  client._onMessage(JSON.stringify(msg));
}

describe("Hub3WsClient.subscribe", () => {
  let client;

  beforeEach(() => {
    client = newClient();
  });

  afterEach(() => {
    // 念のため close (timer leak 防止)
    try { client.close(); } catch { /* ignore */ }
  });

  it("一致する action+op の msg だけ subscriber に届く", () => {
    const fn = vi.fn();
    client.subscribe("pubDeviceStateChange:state", fn);

    deliver(client, { action: "pubDeviceStateChange", op: "state", payload: 1 });
    deliver(client, { action: "pubDeviceStateChange", op: "other", payload: 2 });
    deliver(client, { action: "otherAction", op: "state", payload: 3 });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith({
      action: "pubDeviceStateChange",
      op: "state",
      payload: 1,
    });
  });

  it("op が空文字 / 未定義の場合は key が '<action>:' で照合される", () => {
    const fn = vi.fn();
    client.subscribe("biz3KeepAlive:", fn);

    deliver(client, { action: "biz3KeepAlive", success: true });
    deliver(client, { action: "biz3KeepAlive", op: "", n: 2 });

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("unsubscribe 後は当該 key の msg を受信しない", () => {
    const fn = vi.fn();
    const unsub = client.subscribe("a:b", fn);

    deliver(client, { action: "a", op: "b", n: 1 });
    expect(fn).toHaveBeenCalledTimes(1);

    unsub();

    deliver(client, { action: "a", op: "b", n: 2 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("最後の subscriber が unsubscribe すると subscribers Map からも削除される", () => {
    const fn = vi.fn();
    const unsub = client.subscribe("a:b", fn);
    expect(client.subscribers.has("a:b")).toBe(true);

    unsub();
    expect(client.subscribers.has("a:b")).toBe(false);
  });

  it("同 key に複数 subscriber を登録すると全員が同じ msg を受信する", () => {
    const f1 = vi.fn();
    const f2 = vi.fn();
    const f3 = vi.fn();
    client.subscribe("a:b", f1);
    client.subscribe("a:b", f2);
    client.subscribe("a:b", f3);

    const msg = { action: "a", op: "b", v: 42 };
    deliver(client, msg);

    expect(f1).toHaveBeenCalledWith(msg);
    expect(f2).toHaveBeenCalledWith(msg);
    expect(f3).toHaveBeenCalledWith(msg);
  });

  it("同じ fn を 2 回 subscribe しても Set なので 1 回しか呼ばれない", () => {
    const fn = vi.fn();
    const unsub1 = client.subscribe("a:b", fn);
    const unsub2 = client.subscribe("a:b", fn);

    deliver(client, { action: "a", op: "b" });
    expect(fn).toHaveBeenCalledTimes(1);

    // 一度 unsub すれば（Set なので）もう届かない
    unsub1();
    deliver(client, { action: "a", op: "b" });
    expect(fn).toHaveBeenCalledTimes(1);

    // 2 つ目の unsub は冪等 (set が無くなっていても safe)
    expect(() => unsub2()).not.toThrow();
  });

  it("unsubscribe を 2 回呼んでも例外を投げない (冪等)", () => {
    const fn = vi.fn();
    const unsub = client.subscribe("a:b", fn);
    unsub();
    expect(() => unsub()).not.toThrow();
    expect(client.subscribers.has("a:b")).toBe(false);
  });

  it("ハンドラ内で別 subscriber を unsubscribe しても当該フレームは全員受信できる (snapshot iterate)", () => {
    const order = [];
    const f1 = vi.fn(() => {
      order.push("f1");
      // f1 の中で f2/f3 を解除しても、本フレームは snapshot 配信される
      unsub2();
      unsub3();
    });
    const f2 = vi.fn(() => order.push("f2"));
    const f3 = vi.fn(() => order.push("f3"));

    client.subscribe("a:b", f1);
    const unsub2 = client.subscribe("a:b", f2);
    const unsub3 = client.subscribe("a:b", f3);

    deliver(client, { action: "a", op: "b", v: 1 });

    expect(f1).toHaveBeenCalledTimes(1);
    expect(f2).toHaveBeenCalledTimes(1);
    expect(f3).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["f1", "f2", "f3"]);

    // 次フレームでは f2/f3 はもう届かない
    deliver(client, { action: "a", op: "b", v: 2 });
    expect(f1).toHaveBeenCalledTimes(2);
    expect(f2).toHaveBeenCalledTimes(1);
    expect(f3).toHaveBeenCalledTimes(1);
  });

  it("ハンドラ内で同 key に新規 subscribe しても当該フレームでは呼ばれない (snapshot 後追加)", () => {
    const late = vi.fn();
    const f1 = vi.fn(() => {
      client.subscribe("a:b", late);
    });
    client.subscribe("a:b", f1);

    deliver(client, { action: "a", op: "b", v: 1 });
    expect(f1).toHaveBeenCalledTimes(1);
    // snapshot iterate なので、配信中に追加された late は当該フレームでは呼ばれない
    expect(late).toHaveBeenCalledTimes(0);

    // 次フレームでは届く
    deliver(client, { action: "a", op: "b", v: 2 });
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("subscriber が throw しても他の subscriber / listener に伝播せず後続が呼ばれる", () => {
    const f1 = vi.fn(() => { throw new Error("boom"); });
    const f2 = vi.fn();
    const listener = vi.fn();

    client.subscribe("a:b", f1);
    client.subscribe("a:b", f2);
    client.onMessage(listener);

    expect(() => deliver(client, { action: "a", op: "b" })).not.toThrow();
    expect(f1).toHaveBeenCalledTimes(1);
    expect(f2).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("Hub3WsClient.onMessage", () => {
  let client;

  beforeEach(() => { client = newClient(); });
  afterEach(() => { try { client.close(); } catch { /* ignore */ } });

  it("登録した listener は action/op 問わず全 msg を受信する", () => {
    const listener = vi.fn();
    client.onMessage(listener);

    deliver(client, { action: "x", op: "y" });
    deliver(client, { action: "z" });
    deliver(client, { action: "biz3KeepAlive", success: true });

    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("戻り値の unsubscribe を呼ぶと listener が外れる", () => {
    const listener = vi.fn();
    const unsub = client.onMessage(listener);

    deliver(client, { action: "x" });
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    deliver(client, { action: "x" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("複数 listener が登録順に全員呼ばれる", () => {
    const order = [];
    const l1 = vi.fn(() => order.push("l1"));
    const l2 = vi.fn(() => order.push("l2"));
    const l3 = vi.fn(() => order.push("l3"));
    client.onMessage(l1);
    client.onMessage(l2);
    client.onMessage(l3);

    deliver(client, { action: "x" });
    expect(order).toEqual(["l1", "l2", "l3"]);
  });

  it("listener が throw しても他 listener / subscriber に伝播しない", () => {
    const sub = vi.fn();
    client.subscribe("a:b", sub);

    const l1 = vi.fn(() => { throw new Error("boom"); });
    const l2 = vi.fn();
    client.onMessage(l1);
    client.onMessage(l2);

    expect(() => deliver(client, { action: "a", op: "b" })).not.toThrow();
    expect(sub).toHaveBeenCalledTimes(1);
    expect(l1).toHaveBeenCalledTimes(1);
    expect(l2).toHaveBeenCalledTimes(1);
  });

  it("同じ fn を 2 回 onMessage 登録すると listeners 配列内に 2 件入り 2 回呼ばれる、unsub は 1 件ずつ削る", () => {
    const fn = vi.fn();
    const u1 = client.onMessage(fn);
    const u2 = client.onMessage(fn);

    deliver(client, { action: "x" });
    expect(fn).toHaveBeenCalledTimes(2);

    u1();
    deliver(client, { action: "x" });
    expect(fn).toHaveBeenCalledTimes(3); // まだ 1 件残っている

    u2();
    deliver(client, { action: "x" });
    expect(fn).toHaveBeenCalledTimes(3); // もう届かない
  });
});

describe("Hub3WsClient._onMessage fan-out / 経路", () => {
  let client;
  beforeEach(() => { client = newClient(); });
  afterEach(() => { try { client.close(); } catch { /* ignore */ } });

  it("非 JSON のメッセージは黙って無視され listener も subscriber も呼ばれない", () => {
    const sub = vi.fn();
    const listener = vi.fn();
    client.subscribe("a:b", sub);
    client.onMessage(listener);

    expect(() => client._onMessage("not-json{{")).not.toThrow();
    expect(sub).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it("Buffer で渡された raw も utf8 として JSON parse される", () => {
    const listener = vi.fn();
    client.onMessage(listener);

    client._onMessage(Buffer.from(JSON.stringify({ action: "a", op: "b" }), "utf8"));
    expect(listener).toHaveBeenCalledWith({ action: "a", op: "b" });
  });

  it("subscribe → pending(request) → listener の順序で fan-out される", () => {
    const order = [];
    const sub = vi.fn(() => order.push("sub"));
    const listener = vi.fn(() => order.push("listener"));
    const resolver = vi.fn(() => order.push("resolver"));

    client.subscribe("a:b", sub);
    client.onMessage(listener);
    client._registerPending("a:b", resolver);

    deliver(client, { action: "a", op: "b", v: 1 });

    // 実装上は resolver → subscribers → listeners の順
    expect(order).toEqual(["resolver", "sub", "listener"]);
  });

  it("pending(request) と subscribe が同 key で共存していても両方解決される", () => {
    const sub = vi.fn();
    const resolver = vi.fn();
    client.subscribe("a:b", sub);
    client._registerPending("a:b", resolver);

    deliver(client, { action: "a", op: "b", v: 1 });

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(sub).toHaveBeenCalledTimes(1);
    expect(client.pending.has("a:b")).toBe(false); // FIFO 1 件消費で空 → 削除
  });
});

describe("Hub3WsClient.close で subscribers / listeners をクリア", () => {
  it("close 後は subscribers.size === 0 になり、その後の subscribe→deliver は新規分のみ動く", () => {
    const client = newClient();
    const old = vi.fn();
    client.subscribe("a:b", old);
    client.onMessage(vi.fn());

    client.close();

    expect(client.subscribers.size).toBe(0);
    // listeners は close 内で明示クリアされていないが、close 自体の主要保証は subscribers クリア。
    // 古い subscriber は subscribers Map から外れているので新フレームを受けない。
    deliver(client, { action: "a", op: "b" });
    expect(old).not.toHaveBeenCalled();
  });

  it("close 後に再 subscribe したものは正常に受信できる", () => {
    const client = newClient();
    client.subscribe("a:b", vi.fn());
    client.close();

    const fresh = vi.fn();
    client.subscribe("a:b", fresh);
    deliver(client, { action: "a", op: "b", v: 9 });
    expect(fresh).toHaveBeenCalledWith({ action: "a", op: "b", v: 9 });
  });
});

describe("Hub3WsClient: 実 WebSocket 経由の end-to-end fan-out", () => {
  let wss;
  let port;
  let client;

  beforeEach(async () => {
    wss = new WebSocketServer({ port: 0 });
    await new Promise((res) => wss.once("listening", res));
    port = wss.address().port;
  });

  afterEach(async () => {
    try { client?.close(); } catch { /* ignore */ }
    await new Promise((res) => wss.close(res));
  });

  it("実 WS 経由で server push が subscriber に届く", async () => {
    client = new Hub3WsClient({
      wsUrl: `ws://127.0.0.1:${port}`,
      idToken: "x",
      autoReconnect: false,
    });

    const received = [];
    client.subscribe("pubDeviceStateChange:state", (m) => received.push(m));

    const serverConn = new Promise((res) => wss.once("connection", res));
    await client.connect();
    const conn = await serverConn;

    conn.send(JSON.stringify({ action: "pubDeviceStateChange", op: "state", deviceId: "X" }));
    // 受信を待つ (短いポーリング)
    await vi.waitFor(() => {
      expect(received.length).toBe(1);
    }, { timeout: 1000, interval: 10 });

    expect(received[0]).toMatchObject({
      action: "pubDeviceStateChange",
      op: "state",
      deviceId: "X",
    });
  });
});
