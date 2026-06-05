// Unit tests for triggerLock() in src/lock.js
//
// 実機観測 (2026, /production): biz3TriggerLocker は送信に対し
//   {action:"biz3TriggerLocker", code:200, data:{}, success:true} を**同期 ack** で返す。
// 旧実装は pubDeviceStateChange push を待ち timeout 誤判定していた。現実装は ack で解決し、
// state push (data.deviceUUID 一致) が来た場合も補助的に解決する。
//
// Strategy: {getStatus, subscribe, send} の minimal mock client で挙動を検証する。
//   - ACK_KEY = "biz3TriggerLocker:" (op 無し ack)
//   - STATE_KEY = "biz3TriggerLocker:pubDeviceStateChange" (任意の状態 push)

import { describe, it, expect, beforeEach } from "vitest";
import { triggerLock, lockLock, lockUnlock, lockToggle, botClick } from "../../src/lock.js";
import { CMD } from "../../src/crypto.js";

const VALID_KEY = "0123456789abcdef0123456789abcdef";
const VALID_SUB = "11111111222233334444555566667777";
const VALID_DEVICE = "aaaaaaaabbbbccccddddeeeeeeeeffff";
const VALID_DEVICE_HYPHEN = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeffff";

const ACK_KEY = "biz3TriggerLocker:";
const STATE_KEY = "biz3TriggerLocker:pubDeviceStateChange";

/** 最小 mock client。subscribe(key,fn) を記録し、emit(key,msg) で手動配信。 */
function makeMockClient(overrides = {}) {
  const handlers = new Map();
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
    emit(key, msg) {
      const m = handlers.get(key);
      if (!m) return 0;
      let n = 0;
      for (const fn of [...m.values()]) { fn(msg); n++; }
      return n;
    },
    subCount(key) { const m = handlers.get(key); return m ? m.size : 0; },
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

    it("subscribe は send より前 (ack/state 両方を張ってから送る)", async () => {
      let ackAtSend = -1, stateAtSend = -1;
      const c = makeMockClient({
        send: (msg) => { ackAtSend = c.subCount(ACK_KEY); stateAtSend = c.subCount(STATE_KEY); c.sent.push(msg); },
      });
      c.sent = [];
      const p = triggerLock(c, { deviceId: VALID_DEVICE, secretKey: VALID_KEY, subUUID: VALID_SUB, cmd: CMD.LOCK, timeoutMs: 50 });
      expect(ackAtSend).toBe(1);
      expect(stateAtSend).toBe(1);
      await expect(p).rejects.toThrow(/timeout/);
    });
  });

  describe("正常系: 同期 ack で resolve", () => {
    it("ACK (success:true) で resolve し、両 key とも unsub される", async () => {
      const p = triggerLock(client, { deviceId: VALID_DEVICE, secretKey: VALID_KEY, subUUID: VALID_SUB, cmd: CMD.UNLOCK, timeoutMs: 200 });
      client.emit(ACK_KEY, OK_ACK);
      await expect(p).resolves.toMatchObject({ success: true, code: 200 });
      expect(client.subCount(ACK_KEY)).toBe(0);
      expect(client.subCount(STATE_KEY)).toBe(0);
    });

    it("ACK は cmd や deviceUUID を問わず resolve (data:{} でも OK)", async () => {
      const p = triggerLock(client, { deviceId: VALID_DEVICE, secretKey: VALID_KEY, subUUID: VALID_SUB, cmd: CMD.LOCK, timeoutMs: 200 });
      client.emit(ACK_KEY, { action: "biz3TriggerLocker", code: 200, data: {}, success: true });
      await expect(p).resolves.toBeTruthy();
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
      expect(client.subCount(ACK_KEY)).toBe(0);
      expect(client.subCount(STATE_KEY)).toBe(0);
    });

    it("timeout 経過で reject し unsub される", async () => {
      const p = triggerLock(client, { deviceId: VALID_DEVICE, secretKey: VALID_KEY, subUUID: VALID_SUB, cmd: CMD.LOCK, timeoutMs: 30 });
      await expect(p).rejects.toThrow(/triggerLock timeout/);
      expect(client.subCount(ACK_KEY)).toBe(0);
      expect(client.subCount(STATE_KEY)).toBe(0);
    });

    it("timeout メッセージに cmd と device が含まれる", async () => {
      const p = triggerLock(client, { deviceId: VALID_DEVICE, secretKey: VALID_KEY, subUUID: VALID_SUB, cmd: CMD.UNLOCK, timeoutMs: 30 });
      await expect(p).rejects.toThrow(new RegExp(`cmd=${CMD.UNLOCK}`));
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
