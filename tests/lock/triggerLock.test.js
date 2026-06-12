// Unit tests for triggerLock() in src/lock.js
//
// 実機観測 (2026, /production): biz3TriggerLocker は送信に対し
//   {action:"biz3TriggerLocker", code:200, data:{}, success:true} を**同期 ack** で返す。
//
// P3-6: ack には相関キーが無いため、subscribe (fan-out) で待つと並行 2 コマンドが同じ最初の
// ack で両方解決してしまう。現実装は transport の request() (key=`biz3TriggerLocker:` の FIFO、
// transport.js:243-259) で ack を待ち、pubDeviceStateChange (data.deviceUUID 一致) が来た場合は
// 補助的に解決する。
//
// Strategy: {getStatus, subscribe, send, request} の minimal mock client で挙動を検証する。
//   - ACK_KEY = "biz3TriggerLocker:" (op 無し ack) — request の FIFO pending で待つ
//   - STATE_KEY = "biz3TriggerLocker:pubDeviceStateChange" (任意の状態 push) — subscribe
// mock の request/emit は transport.js:243-259 (FIFO 登録 → 送信、受信時は FIFO 1 件解決 →
// subscriber fan-out) から導出している。

import { describe, it, expect, beforeEach } from "vitest";
import { triggerLock, lockLock, lockUnlock, lockToggle, botClick } from "../../src/lock.js";
import { CMD } from "../../src/crypto.js";
import { SesameError, ERR } from "../../src/errors.js";

const VALID_KEY = "0123456789abcdef0123456789abcdef";
const VALID_SUB = "11111111222233334444555566667777";
const VALID_DEVICE = "aaaaaaaabbbbccccddddeeeeeeeeffff";
const VALID_DEVICE_HYPHEN = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeffff";

const ACK_KEY = "biz3TriggerLocker:";
const STATE_KEY = "biz3TriggerLocker:pubDeviceStateChange";

/**
 * 最小 mock client。
 * request(payload) は transport.js:243-259 と同じく「FIFO pending 登録 → send」、
 * emit(key,msg) は _onMessage (transport.js:507-521) と同じく「FIFO 1 件解決 → subscriber 配信」。
 */
function makeMockClient(overrides = {}) {
  const handlers = new Map();
  const pending = new Map(); // key -> [{resolve, reject, to}]
  let nextId = 0;
  const sent = [];
  const client = {
    sent,
    handlers,
    status: "open",
    getStatus: overrides.getStatus ?? (() => client.status),
    subscribe: overrides.subscribe ?? ((key, fn) => {
      const id = nextId++;
      if (!handlers.has(key)) handlers.set(key, new Map());
      handlers.get(key).set(id, fn);
      return () => { const m = handlers.get(key); if (m) m.delete(id); };
    }),
    send: overrides.send ?? ((msg) => { sent.push(msg); }),
    request(payload, timeoutMs = 10_000) {
      const key = `${payload.action}:${payload.op || ""}`;
      return new Promise((resolve, reject) => {
        const entry = { resolve: null, to: null };
        entry.to = setTimeout(() => {
          const q = pending.get(key);
          if (q) { const i = q.indexOf(entry); if (i >= 0) q.splice(i, 1); }
          // transport.js timeoutErr 相当 (.code = TRANSPORT_TIMEOUT)
          const e = new Error(`request timeout: ${key}`);
          e.code = "TRANSPORT_TIMEOUT";
          reject(e);
        }, timeoutMs);
        entry.resolve = (msg) => { clearTimeout(entry.to); resolve(msg); };
        if (!pending.has(key)) pending.set(key, []);
        pending.get(key).push(entry);
        client.send(payload); // 登録後に送信 (transport.js:256-257 と同順)
      });
    },
    emit(key, msg) {
      // FIFO で 1 resolver 解決 (transport.js:508-513)
      const q = pending.get(key);
      if (q && q.length > 0) {
        const entry = q.shift();
        if (q.length === 0) pending.delete(key);
        entry.resolve(msg);
      }
      // 永続購読 fan-out (transport.js:518-521)
      const m = handlers.get(key);
      if (!m) return;
      for (const fn of [...m.values()]) fn(msg);
    },
    subCount(key) { const m = handlers.get(key); return m ? m.size : 0; },
    pendingCount(key) { const q = pending.get(key); return q ? q.length : 0; },
  };
  return client;
}

/** サーバの正常 ack。 */
const OK_ACK = { action: "biz3TriggerLocker", code: 200, data: {}, message: "", success: true };

describe("triggerLock", () => {
  let client;
  beforeEach(() => { client = makeMockClient(); });

  describe("引数バリデーション", () => {
    it("deviceId が無ければ throw", async () => {
      await expect(triggerLock(client, { secretKey: VALID_KEY, subUUID: VALID_SUB, cmd: CMD.LOCK }))
        .rejects.toThrow(/deviceId required/);
    });
    it("secretKey が無ければ throw", async () => {
      await expect(triggerLock(client, { deviceId: VALID_DEVICE, subUUID: VALID_SUB, cmd: CMD.LOCK }))
        .rejects.toThrow(/secretKey required/);
    });
    it("subUUID が無ければ throw", async () => {
      await expect(triggerLock(client, { deviceId: VALID_DEVICE, secretKey: VALID_KEY, cmd: CMD.LOCK }))
        .rejects.toThrow(/subUUID required/);
    });
    it("cmd が number でなければ throw", async () => {
      await expect(triggerLock(client, { deviceId: VALID_DEVICE, secretKey: VALID_KEY, subUUID: VALID_SUB, cmd: "LOCK" }))
        .rejects.toThrow(/cmd required \(number\)/);
    });
  });

  describe("接続状態チェック", () => {
    it("getStatus() が 'open' でなければ throw", async () => {
      client.status = "closed";
      await expect(triggerLock(client, { deviceId: VALID_DEVICE, secretKey: VALID_KEY, subUUID: VALID_SUB, cmd: CMD.LOCK }))
        .rejects.toThrow(/not connected/);
    });
    it("getStatus 未実装でも落ちず send まで走る (timeout で reject)", async () => {
      const c = makeMockClient();
      c.getStatus = undefined;
      const p = triggerLock(c, { deviceId: VALID_DEVICE, secretKey: VALID_KEY, subUUID: VALID_SUB, cmd: CMD.LOCK, timeoutMs: 50 });
      await expect(p).rejects.toThrow(/timeout/);
      expect(c.sent.length).toBe(1);
    });
  });

  describe("送信ペイロード", () => {
    it("send に action/cmd/sign/history/device_id が載る", async () => {
      const p = triggerLock(client, { deviceId: VALID_DEVICE, secretKey: VALID_KEY, subUUID: VALID_SUB, cmd: CMD.LOCK, timeoutMs: 50 });
      expect(client.sent.length).toBe(1);
      const msg = client.sent[0];
      expect(msg.action).toBe("biz3TriggerLocker");
      expect(msg.cmd).toBe(CMD.LOCK);
      expect(msg.sign.length).toBe(8); // 4B hex
      expect(typeof msg.history).toBe("string");
      expect(msg.device_id).toBe(VALID_DEVICE);
      await expect(p).rejects.toThrow(/timeout/);
    });

    it("送信時点で state 購読と ack の FIFO pending が両方張られている", async () => {
      let ackAtSend = -1, stateAtSend = -1;
      const c = makeMockClient({
        send: (msg) => { ackAtSend = c.pendingCount(ACK_KEY); stateAtSend = c.subCount(STATE_KEY); c.sent.push(msg); },
      });
      c.sent = [];
      const p = triggerLock(c, { deviceId: VALID_DEVICE, secretKey: VALID_KEY, subUUID: VALID_SUB, cmd: CMD.LOCK, timeoutMs: 50 });
      expect(ackAtSend).toBe(1);
      expect(stateAtSend).toBe(1);
      await expect(p).rejects.toThrow(/timeout/);
    });
  });

  describe("正常系: 同期 ack で resolve", () => {
    it("ACK (success:true) で resolve し、pending と state 購読が解放される", async () => {
      const p = triggerLock(client, { deviceId: VALID_DEVICE, secretKey: VALID_KEY, subUUID: VALID_SUB, cmd: CMD.UNLOCK, timeoutMs: 200 });
      client.emit(ACK_KEY, OK_ACK);
      await expect(p).resolves.toMatchObject({ success: true, code: 200 });
      expect(client.pendingCount(ACK_KEY)).toBe(0);
      expect(client.subCount(STATE_KEY)).toBe(0);
    });

    it("ACK は cmd や deviceUUID を問わず resolve (data:{} でも OK)", async () => {
      const p = triggerLock(client, { deviceId: VALID_DEVICE, secretKey: VALID_KEY, subUUID: VALID_SUB, cmd: CMD.LOCK, timeoutMs: 200 });
      client.emit(ACK_KEY, { action: "biz3TriggerLocker", code: 200, data: {}, success: true });
      await expect(p).resolves.toBeTruthy();
    });
  });

  describe("P3-6: 並行コマンドの ack 取り違え回帰", () => {
    it("並行 2 コマンドは送信順 = 解決順 (FIFO) で別々の ack を受け取る", async () => {
      // 旧実装 (subscribe fan-out) では最初の ack が両方の pending に配られ、
      // 2 コマンドが同じ応答で解決していた。FIFO 化 (client.request) で送信順に 1:1 対応する。
      const p1 = triggerLock(client, { deviceId: VALID_DEVICE, secretKey: VALID_KEY, subUUID: VALID_SUB, cmd: CMD.LOCK, timeoutMs: 500 });
      const p2 = triggerLock(client, { deviceId: VALID_DEVICE, secretKey: VALID_KEY, subUUID: VALID_SUB, cmd: CMD.UNLOCK, timeoutMs: 500 });
      const ack1 = { ...OK_ACK, data: { seq: 1 } };
      const ack2 = { ...OK_ACK, data: { seq: 2 } };
      client.emit(ACK_KEY, ack1);
      client.emit(ACK_KEY, ack2);
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.data.seq).toBe(1);
      expect(r2.data.seq).toBe(2);
    });

    it("並行 2 コマンドの片方が success:false なら、その 1 件だけ reject される", async () => {
      const p1 = triggerLock(client, { deviceId: VALID_DEVICE, secretKey: VALID_KEY, subUUID: VALID_SUB, cmd: CMD.LOCK, timeoutMs: 500 });
      const p2 = triggerLock(client, { deviceId: VALID_DEVICE, secretKey: VALID_KEY, subUUID: VALID_SUB, cmd: CMD.UNLOCK, timeoutMs: 500 });
      client.emit(ACK_KEY, { action: "biz3TriggerLocker", code: 403, message: "forbidden", success: false });
      client.emit(ACK_KEY, { ...OK_ACK, data: { seq: 2 } });
      await expect(p1).rejects.toThrow(/code=403 forbidden/);
      await expect(p2).resolves.toMatchObject({ data: { seq: 2 } });
    });
  });

  describe("補助系: state push (data.deviceUUID 一致) でも resolve", () => {
    it("対象 deviceUUID の state push で resolve", async () => {
      const p = triggerLock(client, { deviceId: VALID_DEVICE, secretKey: VALID_KEY, subUUID: VALID_SUB, cmd: CMD.LOCK, timeoutMs: 200 });
      const push = { action: "biz3TriggerLocker", op: "pubDeviceStateChange", data: { deviceUUID: VALID_DEVICE } };
      client.emit(STATE_KEY, push);
      await expect(p).resolves.toBe(push);
      expect(client.subCount(STATE_KEY)).toBe(0);
    });

    it("state push 解決後に request 側が timeout しても reject に化けない", async () => {
      const p = triggerLock(client, { deviceId: VALID_DEVICE, secretKey: VALID_KEY, subUUID: VALID_SUB, cmd: CMD.LOCK, timeoutMs: 30 });
      client.emit(STATE_KEY, { data: { deviceUUID: VALID_DEVICE } });
      await expect(p).resolves.toBeTruthy();
      // request の timeout (30ms) を跨いでも結果は変わらない (done ガード)
      await new Promise((r) => setTimeout(r, 60));
      await expect(p).resolves.toBeTruthy();
    });

    it("ハイフン/大文字の deviceUUID でも一致 (normalizeUuid)", async () => {
      const p = triggerLock(client, { deviceId: VALID_DEVICE_HYPHEN, secretKey: VALID_KEY, subUUID: VALID_SUB, cmd: CMD.UNLOCK, timeoutMs: 200 });
      client.emit(STATE_KEY, { data: { deviceUUID: VALID_DEVICE.toUpperCase() } });
      await expect(p).resolves.toBeTruthy();
    });

    it("別 deviceUUID の state push は無視 (ack 来なければ timeout)", async () => {
      const p = triggerLock(client, { deviceId: VALID_DEVICE, secretKey: VALID_KEY, subUUID: VALID_SUB, cmd: CMD.LOCK, timeoutMs: 80 });
      client.emit(STATE_KEY, { data: { deviceUUID: "ffffffffffffffffffffffffffffffff" } });
      await expect(p).rejects.toThrow(/timeout/);
      expect(client.subCount(STATE_KEY)).toBe(0);
    });
  });

  describe("エラー系", () => {
    it("ACK success:false で reject (code/message を含む)", async () => {
      const p = triggerLock(client, { deviceId: VALID_DEVICE, secretKey: VALID_KEY, subUUID: VALID_SUB, cmd: CMD.LOCK, timeoutMs: 200 });
      client.emit(ACK_KEY, { action: "biz3TriggerLocker", code: 403, message: "forbidden", success: false });
      await expect(p).rejects.toThrow(/triggerLock failed \(cmd=82\): code=403 forbidden/);
      expect(client.pendingCount(ACK_KEY)).toBe(0);
      expect(client.subCount(STATE_KEY)).toBe(0);
    });

    it("timeout 経過で reject し pending/購読が解放される", async () => {
      const p = triggerLock(client, { deviceId: VALID_DEVICE, secretKey: VALID_KEY, subUUID: VALID_SUB, cmd: CMD.LOCK, timeoutMs: 30 });
      await expect(p).rejects.toThrow(/triggerLock timeout/);
      expect(client.pendingCount(ACK_KEY)).toBe(0);
      expect(client.subCount(STATE_KEY)).toBe(0);
    });

    it("timeout メッセージに cmd と device が含まれる", async () => {
      const p = triggerLock(client, { deviceId: VALID_DEVICE, secretKey: VALID_KEY, subUUID: VALID_SUB, cmd: CMD.UNLOCK, timeoutMs: 30 });
      await expect(p).rejects.toThrow(new RegExp(`cmd=${CMD.UNLOCK}`));
    });
  });

  describe("型付きエラー (SesameError: code/retryable/data)", () => {
    const base = { deviceId: VALID_DEVICE, secretKey: VALID_KEY, subUUID: VALID_SUB };

    it("バリデーション失敗は code=bad_request", async () => {
      await expect(triggerLock(client, { secretKey: VALID_KEY, subUUID: VALID_SUB, cmd: CMD.LOCK }))
        .rejects.toMatchObject({ name: "SesameError", code: ERR.BAD_REQUEST });
    });

    it("未接続は code=not_connected, retryable=true", async () => {
      client.status = "closed";
      await expect(triggerLock(client, { ...base, cmd: CMD.LOCK }))
        .rejects.toMatchObject({ code: ERR.NOT_CONNECTED, retryable: true });
    });

    it("timeout は code=timeout, retryable=true", async () => {
      const p = triggerLock(client, { ...base, cmd: CMD.LOCK, timeoutMs: 20 });
      await expect(p).rejects.toMatchObject({ code: ERR.TIMEOUT, retryable: true });
    });

    it("上流 success:false は code=rejected, retryable=false, data.upstreamCode", async () => {
      const p = triggerLock(client, { ...base, cmd: CMD.LOCK, timeoutMs: 200 });
      client.emit(ACK_KEY, { action: "biz3TriggerLocker", code: 403, message: "forbidden", success: false });
      await expect(p).rejects.toMatchObject({
        name: "SesameError", code: ERR.REJECTED, retryable: false, data: { upstreamCode: 403 },
      });
    });

    it("投げられるのは SesameError インスタンス", async () => {
      const err = await triggerLock(client, { ...base, cmd: CMD.LOCK, timeoutMs: 20 }).catch((e) => e);
      expect(err).toBeInstanceOf(SesameError);
    });
  });

  describe("convenience wrappers", () => {
    const base = { deviceId: VALID_DEVICE, secretKey: VALID_KEY, subUUID: VALID_SUB, timeoutMs: 50 };
    it("lockLock は cmd=LOCK", async () => {
      const p = lockLock(client, base); expect(client.sent[0].cmd).toBe(CMD.LOCK); await expect(p).rejects.toThrow(/timeout/);
    });
    it("lockUnlock は cmd=UNLOCK", async () => {
      const p = lockUnlock(client, base); expect(client.sent[0].cmd).toBe(CMD.UNLOCK); await expect(p).rejects.toThrow(/timeout/);
    });
    it("lockToggle は cmd=TOGGLE", async () => {
      const p = lockToggle(client, base); expect(client.sent[0].cmd).toBe(CMD.TOGGLE); await expect(p).rejects.toThrow(/timeout/);
    });
    it("botClick は cmd=CLICK (89)", async () => {
      const p = botClick(client, base); expect(client.sent[0].cmd).toBe(CMD.CLICK); await expect(p).rejects.toThrow(/timeout/);
    });
    it("呼び出し元の cmd は wrapper の cmd で上書きされる", async () => {
      const p = lockLock(client, { ...base, cmd: 999 }); expect(client.sent[0].cmd).toBe(CMD.LOCK); await expect(p).rejects.toThrow(/timeout/);
    });
  });
});
