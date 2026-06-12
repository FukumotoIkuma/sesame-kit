// triggerItemCommand / setAutolock の単体テスト (汎用 ItemCode レール + autolock)。
//
// autolock = ItemCode 11、payload = 2byte LE 秒数 (Android SesameSDK autolock_jp.md / SesameProtocols.kt)。
// フレームは biz3TriggerLocker と同型 {action, cmd, sign, history:base64(payload), device_id}。
// lock/unlock と同じ同期 ack {action:"biz3TriggerLocker", success:true} を待って解決する。
import { describe, it, expect, beforeEach } from "vitest";
import { Buffer } from "node:buffer";
import { triggerItemCommand, setAutolock } from "../../src/lock.js";
import { CMD } from "../../src/crypto.js";

const KEY = "0123456789abcdef0123456789abcdef";
const DEVICE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeffff";
const SUB = "11111111222233334444555566667777";
const ACK_KEY = "biz3TriggerLocker:";
const OK_ACK = { action: "biz3TriggerLocker", code: 200, data: {}, success: true };

/**
 * subscribe/emit/send/request を備えた最小 mock。
 * request/emit は transport.js:243-259 / 507-521 (FIFO 登録 → send、受信は FIFO 1 件解決 →
 * subscriber 配信) から導出 (P3-6 で ack 待ちが client.request ベースになったため)。
 */
function makeMockClient(status = "open") {
  const handlers = new Map();
  const pending = new Map(); // key -> [{resolve, to}]
  let nextId = 0;
  const sent = [];
  const client = {
    sent,
    getStatus: () => status,
    subscribe(key, fn) {
      const id = nextId++;
      if (!handlers.has(key)) handlers.set(key, new Map());
      handlers.get(key).set(id, fn);
      return () => { const m = handlers.get(key); if (m) m.delete(id); };
    },
    send(m) { sent.push(m); },
    request(payload, timeoutMs = 10_000) {
      const key = `${payload.action}:${payload.op || ""}`;
      return new Promise((resolve, reject) => {
        const entry = { resolve: null, to: null };
        entry.to = setTimeout(() => {
          const q = pending.get(key);
          if (q) { const i = q.indexOf(entry); if (i >= 0) q.splice(i, 1); }
          const e = new Error(`request timeout: ${key}`);
          e.code = "TRANSPORT_TIMEOUT"; // transport.js timeoutErr 相当
          reject(e);
        }, timeoutMs);
        entry.resolve = (msg) => { clearTimeout(entry.to); resolve(msg); };
        if (!pending.has(key)) pending.set(key, []);
        pending.get(key).push(entry);
        client.send(payload);
      });
    },
    emit(key, msg) {
      const q = pending.get(key);
      if (q && q.length > 0) {
        const entry = q.shift();
        if (q.length === 0) pending.delete(key);
        entry.resolve(msg);
      }
      const m = handlers.get(key);
      if (!m) return;
      for (const fn of [...m.values()]) fn(msg);
    },
  };
  return client;
}

describe("triggerItemCommand", () => {
  let c;
  beforeEach(() => { c = makeMockClient(); });

  it("payload を base64 で history に載せ、ack で resolve する", async () => {
    const payload = Buffer.from([0x1e, 0x00]); // 30 LE
    const p = triggerItemCommand(c, { deviceId: DEVICE, secretKey: KEY, cmd: CMD.AUTOLOCK, payload });
    c.emit(ACK_KEY, OK_ACK);
    const ack = await p;
    expect(ack).toMatchObject({ success: true });
    const f = c.sent[0];
    expect(f.action).toBe("biz3TriggerLocker");
    expect(f.cmd).toBe(11);
    expect(f.device_id).toBe(DEVICE);
    expect(typeof f.sign).toBe("string");
    expect(Buffer.from(f.history, "base64")).toEqual(payload);
    expect(f).not.toHaveProperty("op");
  });

  it("payload 省略時は subUUID の history タグを使う", async () => {
    const p = triggerItemCommand(c, { deviceId: DEVICE, secretKey: KEY, cmd: CMD.LOCK, subUUID: SUB });
    c.emit(ACK_KEY, OK_ACK);
    await p;
    expect(c.sent[0].history).toBeTruthy();
    expect(c.sent[0].cmd).toBe(82);
  });

  it("ack success:false で reject", async () => {
    const p = triggerItemCommand(c, { deviceId: DEVICE, secretKey: KEY, cmd: CMD.AUTOLOCK, payload: Buffer.from([0]), timeoutMs: 200 });
    c.emit(ACK_KEY, { action: "biz3TriggerLocker", code: 400, message: "bad cmd", success: false });
    await expect(p).rejects.toThrow(/triggerLock failed \(cmd=11\): code=400 bad cmd/);
  });

  it("ack が来なければ timeout で reject (= サーバ非対応の兆候)", async () => {
    const p = triggerItemCommand(c, { deviceId: DEVICE, secretKey: KEY, cmd: CMD.AUTOLOCK, payload: Buffer.from([0]), timeoutMs: 30 });
    await expect(p).rejects.toThrow(/timeout/);
  });

  it("payload も subUUID も無ければ throw", async () => {
    await expect(triggerItemCommand(c, { deviceId: DEVICE, secretKey: KEY, cmd: 11 }))
      .rejects.toThrow(/payload または subUUID/);
  });

  it("未接続 (getStatus!=open) は queue せず即 reject", async () => {
    const closed = makeMockClient("closed");
    await expect(triggerItemCommand(closed, { deviceId: DEVICE, secretKey: KEY, cmd: 11, payload: Buffer.from([0]) }))
      .rejects.toThrow(/not connected/);
    expect(closed.sent).toHaveLength(0);
  });

  it("deviceId / secretKey / cmd 必須", async () => {
    await expect(triggerItemCommand(c, { secretKey: KEY, cmd: 11, payload: Buffer.from([0]) })).rejects.toThrow(/deviceId required/);
    await expect(triggerItemCommand(c, { deviceId: DEVICE, cmd: 11, payload: Buffer.from([0]) })).rejects.toThrow(/secretKey required/);
    await expect(triggerItemCommand(c, { deviceId: DEVICE, secretKey: KEY, payload: Buffer.from([0]) })).rejects.toThrow(/cmd required/);
  });
});

describe("setAutolock", () => {
  let c;
  beforeEach(() => { c = makeMockClient(); });

  it("seconds を 2byte LE payload にして cmd=11 を送り、ack で {ack,cmd,seconds} を返す", async () => {
    const p = setAutolock(c, { deviceId: DEVICE, secretKey: KEY, seconds: 300 });
    c.emit(ACK_KEY, OK_ACK);
    const r = await p;
    expect(r.cmd).toBe(11);
    expect(r.seconds).toBe(300);
    expect(r.ack).toMatchObject({ success: true });
    expect([...Buffer.from(c.sent[0].history, "base64")]).toEqual([300 & 0xff, (300 >> 8) & 0xff]); // 0x2c,0x01
    expect(c.sent[0].cmd).toBe(11);
  });

  it("seconds=0 は無効化 (payload 00 00)", async () => {
    const p = setAutolock(c, { deviceId: DEVICE, secretKey: KEY, seconds: 0 });
    c.emit(ACK_KEY, OK_ACK);
    await p;
    expect([...Buffer.from(c.sent[0].history, "base64")]).toEqual([0, 0]);
  });

  it("範囲外 / 非整数の seconds は throw (送信前)", async () => {
    for (const bad of [-1, 65536, 1.5, NaN, "30"]) {
      await expect(setAutolock(c, { deviceId: DEVICE, secretKey: KEY, seconds: bad })).rejects.toThrow(/0\.\.65535/);
    }
    expect(c.sent).toHaveLength(0);
  });
});
