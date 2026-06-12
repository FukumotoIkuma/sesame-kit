// botClickScript() の単体テスト (Bot2/Bot3 台本の番号指定実行, cloud 経由)。
//
// 参照 CHSesameBot2Device.kt:73-97 click(index): itemCode = RUN_SCRIPT_0(170) + index。
// BLE 不可時は同じ itemCode をクラウドへ送る (kt:84-89)。cloud は biz3TriggerLocker の
// cmd に 170+index を乗せる。フレームは lock/unlock と同型で、同期 ack を待って解決する。
import { describe, it, expect, beforeEach } from "vitest";
import { botClickScript } from "../../src/lock.js";

const VALID_KEY = "0123456789abcdef0123456789abcdef";
const VALID_DEVICE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeffff";
const VALID_SUB = "11111111222233334444555566667777";
const ACK_KEY = "biz3TriggerLocker:";
const OK_ACK = { action: "biz3TriggerLocker", code: 200, data: {}, message: "", success: true };

/** triggerLock.test.js と同型の最小 mock (request=FIFO, emit=1件解決+fan-out)。 */
function makeMockClient() {
  const handlers = new Map();
  const pending = new Map();
  const sent = [];
  const client = {
    sent,
    status: "open",
    getStatus: () => client.status,
    subscribe(key, fn) {
      if (!handlers.has(key)) handlers.set(key, new Map());
      const id = Symbol();
      handlers.get(key).set(id, fn);
      return () => handlers.get(key)?.delete(id);
    },
    send(msg) { sent.push(msg); },
    request(payload, timeoutMs = 10_000) {
      const key = `${payload.action}:${payload.op || ""}`;
      return new Promise((resolve, reject) => {
        const entry = { resolve: null, to: null };
        entry.to = setTimeout(() => reject(Object.assign(new Error(`request timeout: ${key}`), { code: "TRANSPORT_TIMEOUT" })), timeoutMs);
        entry.resolve = (msg) => { clearTimeout(entry.to); resolve(msg); };
        if (!pending.has(key)) pending.set(key, []);
        pending.get(key).push(entry);
        client.send(payload);
      });
    },
    emit(key, msg) {
      const q = pending.get(key);
      if (q && q.length) { const e = q.shift(); if (!q.length) pending.delete(key); e.resolve(msg); }
      const m = handlers.get(key);
      if (m) for (const fn of [...m.values()]) fn(msg);
    },
  };
  return client;
}

describe("botClickScript", () => {
  let client;
  beforeEach(() => { client = makeMockClient(); });

  it("cmd = 170 + scriptIndex を送る (台本0 = RUN_SCRIPT_0 = 170)", async () => {
    const p = botClickScript(client, { deviceId: VALID_DEVICE, secretKey: VALID_KEY, subUUID: VALID_SUB, scriptIndex: 0 });
    client.emit(ACK_KEY, OK_ACK);
    await p;
    expect(client.sent[0].cmd).toBe(170);
    expect(client.sent[0].action).toBe("biz3TriggerLocker");
    expect(client.sent[0].device_id).toBe(VALID_DEVICE);
  });

  it("台本9 = 179 を送る", async () => {
    const p = botClickScript(client, { deviceId: VALID_DEVICE, secretKey: VALID_KEY, subUUID: VALID_SUB, scriptIndex: 9 });
    client.emit(ACK_KEY, OK_ACK);
    await p;
    expect(client.sent[0].cmd).toBe(179);
  });

  it.each([-1, 10, 1.5, NaN, "0"])("範囲外/非整数の scriptIndex=%s は送信前に throw", (idx) => {
    // バリデーションは triggerLock 到達前 (同期) に throw する。
    expect(() => botClickScript(client, { deviceId: VALID_DEVICE, secretKey: VALID_KEY, subUUID: VALID_SUB, scriptIndex: idx }))
      .toThrow(/scriptIndex/);
    expect(client.sent.length).toBe(0);
  });
});
