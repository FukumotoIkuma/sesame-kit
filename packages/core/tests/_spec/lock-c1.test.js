// テスト: lock.js — LOCK-0019〜LOCK-0036 (18件)
//
// 対象: packages/core/src/lock.js (triggerLock / botClickScript / triggerItemCommand / setAutolock)
// 方針: TDD — spec どおりの期待値を assert する (実装の現状に合わせない)。
//       ネットワーク/実機不使用。全て mock or 純関数。決定論的。
//
// i18n: テストは en ロケール固定 (autolock.test.js / session-ui.test.js に倣う)。

import { describe, it, expect, beforeEach } from "vitest";
import { Buffer } from "node:buffer";
import {
  triggerLock,
  botClickScript,
  triggerItemCommand,
  setAutolock,
} from "../../src/lock.js";
import { CMD } from "../../src/crypto.js";
import { SesameError, ERR } from "../../src/errors.js";
import { TRANSPORT_ERR } from "../../src/transport.js";
import { setLocale } from "../../src/i18n.js";

// ---- 定数 ----
const KEY = "0123456789abcdef0123456789abcdef";
const DEVICE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeffff";
const OTHER_DEVICE = "ffffffff-eeee-dddd-cccc-bbbbbbbbaaaa";
const DEVICE2 = OTHER_DEVICE; // alias for A-style tests
const SUB = "11111111222233334444555566667777";
const ACK_KEY = "biz3TriggerLocker:";
const STATE_KEY = "biz3TriggerLocker:pubDeviceStateChange";
const OK_ACK = { action: "biz3TriggerLocker", code: 200, data: {}, success: true };

// ---- mock client factory ----
// autolock.test.js / botClickScript.test.js と同型の最小 mock。
// request=FIFO ack 相関, emit=1件解決+fan-out, subscribe=解除可能。
function makeMockClient(status = "open") {
  const handlers = new Map();
  const pending = new Map();
  let nextId = 0;
  const sent = [];
  const client = {
    sent,
    _status: status,
    getStatus() { return client._status; },
    subscribe(key, fn) {
      const id = nextId++;
      if (!handlers.has(key)) handlers.set(key, new Map());
      handlers.get(key).set(id, fn);
      return () => {
        const m = handlers.get(key);
        if (m) m.delete(id);
      };
    },
    send(msg) { sent.push(msg); },
    request(payload, timeoutMs = 10_000) {
      const key = `${payload.action}:${payload.op || ""}`;
      return new Promise((resolve, reject) => {
        const entry = { resolve: null, to: null };
        entry.to = setTimeout(() => {
          const q = pending.get(key);
          if (q) { const i = q.indexOf(entry); if (i >= 0) q.splice(i, 1); }
          const e = Object.assign(new Error(`request timeout: ${key}`), { code: TRANSPORT_ERR.TIMEOUT });
          reject(e);
        }, timeoutMs);
        entry.resolve = (msg) => { clearTimeout(entry.to); resolve(msg); };
        if (!pending.has(key)) pending.set(key, []);
        pending.get(key).push(entry);
        client.send(payload);
      });
    },
    // ack 配信: FIFO 1 件解決 + subscribe ハンドラ fan-out
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

// ---- setup ----
beforeEach(() => { setLocale("en"); });

// ============================================================
// LOCK-0019〜LOCK-0020: state push の deviceUUID 一致判定 / 二重解決ガード
// ============================================================

describe("dispatchTrigger — state push フィルタ / 二重解決ガード", () => {
  let c;
  beforeEach(() => { c = makeMockClient(); });

  it("[LOCK-0019] 別 deviceUUID の state push は無視 (ack 無ければ timeout)", async () => {
    // DEVICE2 の push が来ても DEVICE の promise は resolve しない
    const p = triggerLock(c, {
      deviceId: DEVICE,
      secretKey: KEY,
      subUUID: SUB,
      cmd: CMD.LOCK,
      timeoutMs: 300,
    });
    // 別デバイスの state push を流す → 無視されるはず
    c.emit(STATE_KEY, {
      action: "biz3TriggerLocker",
      op: "pubDeviceStateChange",
      data: { deviceUUID: DEVICE2 },
    });
    // ack も来ないので timeout で reject する
    await expect(p).rejects.toMatchObject({ code: ERR.TIMEOUT });
  });

  it("[LOCK-0020] state push 先行解決後の request timeout は reject に化けない (done ガード)", async () => {
    // state push で先に done になり、その後 request が TRANSPORT_TIMEOUT になっても reject しない
    const p = triggerLock(c, {
      deviceId: DEVICE,
      secretKey: KEY,
      subUUID: SUB,
      cmd: CMD.LOCK,
      timeoutMs: 50,
    });
    // state push (正しい deviceUUID) で先に resolve させる
    c.emit(STATE_KEY, {
      action: "biz3TriggerLocker",
      op: "pubDeviceStateChange",
      data: { deviceUUID: DEVICE },
    });
    // promise は state push で既に resolve — timeout を待っても reject に化けてはいけない
    const result = await p;
    expect(result).toBeDefined();
    // 解決メッセージに deviceUUID が含まれる
    expect(result?.data?.deviceUUID).toBe(DEVICE);
  });
});

// ============================================================
// LOCK-0021: ack success:false で REJECTED reject
// ============================================================

describe("dispatchTrigger — ack success:false", () => {
  let c;
  beforeEach(() => { c = makeMockClient(); });

  it("[LOCK-0021] ack success:false で REJECTED reject (code/message 反映)", async () => {
    const p = triggerLock(c, {
      deviceId: DEVICE,
      secretKey: KEY,
      subUUID: SUB,
      cmd: CMD.LOCK,
    });
    c.emit(ACK_KEY, {
      action: "biz3TriggerLocker",
      code: 403,
      message: "forbidden by server",
      success: false,
    });
    let err;
    try { await p; } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.REJECTED);
    expect(err.retryable).toBe(false);
    expect(err.data?.upstreamCode).toBe(403);
    // 文言に cmd=82, code=403, message を含む
    expect(err.message).toMatch(/82/);
    expect(err.message).toMatch(/403/);
    expect(err.message).toMatch(/forbidden by server/);
  });
});

// ============================================================
// LOCK-0022 / LOCK-0023: timeout / 文言
// ============================================================

describe("dispatchTrigger — timeout", () => {
  let c;
  beforeEach(() => { c = makeMockClient(); });

  it("[LOCK-0022] timeout 経過で TIMEOUT reject し retryable:true", async () => {
    const p = triggerLock(c, {
      deviceId: DEVICE,
      secretKey: KEY,
      subUUID: SUB,
      cmd: CMD.LOCK,
      timeoutMs: 30,
    });
    let err;
    try { await p; } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.TIMEOUT);
    expect(err.retryable).toBe(true);
  });

  it("[LOCK-0023] timeout 文言に cmd と正規化 device を含む", async () => {
    const p = triggerLock(c, {
      deviceId: DEVICE,
      secretKey: KEY,
      subUUID: SUB,
      cmd: CMD.LOCK,
      timeoutMs: 30,
    });
    let err;
    try { await p; } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.message).toMatch(/timeout/i);
    expect(err.message).toMatch(/82/); // cmd=LOCK=82
    // 正規化 UUID (ハイフン除去・小文字)
    const normalizedDevice = DEVICE.replace(/-/g, "").toLowerCase();
    expect(err.message).toContain(normalizedDevice);
  });
});

// ============================================================
// LOCK-0024: 非 TIMEOUT の transport エラーはそのまま伝播
// ============================================================

describe("dispatchTrigger — transport CLOSED エラーの伝播", () => {
  it("[LOCK-0024] request が TRANSPORT_ERR.TIMEOUT 以外 (CLOSED 等) で reject したときは timeout 文言へ写像せずそのまま伝播", async () => {
    // request が CLOSED コードで reject する mock
    const c = {
      sent: [],
      getStatus: () => "open",
      subscribe(_key, _fn) { return () => {}; },
      request(_payload, _timeoutMs) {
        return Promise.reject(Object.assign(new Error("websocket closed"), { code: TRANSPORT_ERR.CLOSED }));
      },
    };
    const p = triggerLock(c, { deviceId: DEVICE, secretKey: KEY, subUUID: SUB, cmd: CMD.LOCK });
    let err;
    try { await p; } catch (e) { err = e; }
    // TIMEOUT への写像は行わない → ERR.TIMEOUT code を付けない
    expect(err.code).not.toBe(ERR.TIMEOUT);
    // CLOSED エラーメッセージがそのまま伝播する
    expect(err.message).toMatch(/websocket closed/i);
  });
});

// ============================================================
// LOCK-0025: 未接続 (getStatus !== 'open') で即 NOT_CONNECTED
// ============================================================

describe("dispatchTrigger — 未接続ガード", () => {
  it("[LOCK-0025] 未接続 (getStatus!=='open') は queue せず即 NOT_CONNECTED", async () => {
    const closedClient = makeMockClient("closed");
    let err;
    try {
      await triggerLock(closedClient, { deviceId: DEVICE, secretKey: KEY, subUUID: SUB, cmd: CMD.LOCK });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.NOT_CONNECTED);
    expect(err.retryable).toBe(true);
    // 送信は行っていない
    expect(closedClient.sent).toHaveLength(0);
  });
});

// ============================================================
// LOCK-0026: getStatus 未実装でも送信まで走る
// ============================================================

describe("dispatchTrigger — getStatus 未実装", () => {
  it("[LOCK-0026] getStatus 未実装でも落ちず送信まで走る (timeout で reject)", async () => {
    // getStatus が undefined のとき接続チェックをスキップして送信まで進む
    const handlers = new Map();
    const pending = new Map();
    const sent = [];
    const c = {
      sent,
      // getStatus は意図的に未定義 (undefined)
      subscribe(key, fn) {
        if (!handlers.has(key)) handlers.set(key, new Map());
        const id = Symbol();
        handlers.get(key).set(id, fn);
        return () => handlers.get(key)?.delete(id);
      },
      request(payload, timeoutMs = 10_000) {
        const key = `${payload.action}:${payload.op || ""}`;
        return new Promise((resolve, reject) => {
          const entry = { resolve: null, to: null };
          entry.to = setTimeout(() => {
            const e = Object.assign(new Error(`request timeout: ${key}`), { code: TRANSPORT_ERR.TIMEOUT });
            reject(e);
          }, timeoutMs);
          entry.resolve = (msg) => { clearTimeout(entry.to); resolve(msg); };
          if (!pending.has(key)) pending.set(key, []);
          pending.get(key).push(entry);
          sent.push(payload);
        });
      },
    };

    const p = triggerLock(c, {
      deviceId: DEVICE,
      secretKey: KEY,
      subUUID: SUB,
      cmd: CMD.LOCK,
      timeoutMs: 30,
    });
    // timeout で reject (= 送信まで走った証拠) だが NOT_CONNECTED ではない
    let err;
    try { await p; } catch (e) { err = e; }
    expect(err.code).toBe(ERR.TIMEOUT);
    // 送信フレームが積まれている
    expect(sent.length).toBeGreaterThan(0);
  });
});

// ============================================================
// LOCK-0027: triggerLock 引数必須バリデーション
// ============================================================

describe("triggerLock — 引数必須バリデーション", () => {
  let c;
  beforeEach(() => { c = makeMockClient(); });

  it("[LOCK-0027] deviceId 欠落で BAD_REQUEST (送信前)", async () => {
    let err;
    try { await triggerLock(c, { secretKey: KEY, subUUID: SUB, cmd: CMD.LOCK }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(c.sent).toHaveLength(0);
  });

  it("[LOCK-0027] secretKey 欠落で BAD_REQUEST (送信前)", async () => {
    let err;
    try { await triggerLock(c, { deviceId: DEVICE, subUUID: SUB, cmd: CMD.LOCK }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(c.sent).toHaveLength(0);
  });

  it("[LOCK-0027] subUUID 欠落で BAD_REQUEST (送信前)", async () => {
    let err;
    try { await triggerLock(c, { deviceId: DEVICE, secretKey: KEY, cmd: CMD.LOCK }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(c.sent).toHaveLength(0);
  });

  it("[LOCK-0027] cmd が number でない場合は BAD_REQUEST (送信前)", async () => {
    let err;
    try { await triggerLock(c, { deviceId: DEVICE, secretKey: KEY, subUUID: SUB, cmd: "82" }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(c.sent).toHaveLength(0);
  });
});

// ============================================================
// LOCK-0028: 投げられるのは SesameError インスタンス
// ============================================================

describe("lock 系エラーはすべて SesameError インスタンス", () => {
  let c;
  beforeEach(() => { c = makeMockClient(); });

  it("[LOCK-0028] BAD_REQUEST (引数不正) は SesameError インスタンス", async () => {
    await expect(triggerLock(c, { secretKey: KEY, subUUID: SUB, cmd: CMD.LOCK }))
      .rejects.toBeInstanceOf(SesameError);
  });

  it("[LOCK-0028] REJECTED (ack success:false) は SesameError インスタンス", async () => {
    const p = triggerLock(c, { deviceId: DEVICE, secretKey: KEY, subUUID: SUB, cmd: CMD.LOCK });
    c.emit(ACK_KEY, { success: false, code: 500, message: "server error" });
    await expect(p).rejects.toBeInstanceOf(SesameError);
  });

  it("[LOCK-0028] TIMEOUT は SesameError インスタンスで code/retryable/data フィールドを持つ", async () => {
    const p = triggerLock(c, { deviceId: DEVICE, secretKey: KEY, subUUID: SUB, cmd: CMD.LOCK, timeoutMs: 30 });
    let err;
    try { await p; } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SesameError);
    expect(typeof err.code).toBe("string");
    expect(typeof err.retryable).toBe("boolean");
    // data フィールドが存在する (null でも OK)
    expect("data" in err).toBe(true);
  });

  it("[LOCK-0028] NOT_CONNECTED は SesameError インスタンス", async () => {
    const closed = makeMockClient("closed");
    await expect(triggerLock(closed, { deviceId: DEVICE, secretKey: KEY, subUUID: SUB, cmd: CMD.LOCK }))
      .rejects.toBeInstanceOf(SesameError);
  });
});

// ============================================================
// LOCK-0029: botClickScript cmd = 170 + scriptIndex
// ============================================================

describe("botClickScript — cmd = BOT2_ITEM_CODE_RUN_SCRIPT_0(170) + scriptIndex", () => {
  let c;
  beforeEach(() => { c = makeMockClient(); });

  it("[LOCK-0029] scriptIndex=0 → cmd=170 (RUN_SCRIPT_0) を biz3TriggerLocker に乗せる", async () => {
    const p = botClickScript(c, { deviceId: DEVICE, secretKey: KEY, subUUID: SUB, scriptIndex: 0 });
    c.emit(ACK_KEY, OK_ACK);
    await p;
    expect(c.sent[0].cmd).toBe(170);
    expect(c.sent[0].action).toBe("biz3TriggerLocker");
    expect(c.sent[0].device_id).toBe(DEVICE);
  });

  it("[LOCK-0029] scriptIndex=9 → cmd=179 (RUN_SCRIPT_9) を送る", async () => {
    const p = botClickScript(c, { deviceId: DEVICE, secretKey: KEY, subUUID: SUB, scriptIndex: 9 });
    c.emit(ACK_KEY, OK_ACK);
    await p;
    expect(c.sent[0].cmd).toBe(179);
  });

  it("[LOCK-0029] 中間値 scriptIndex=5 → cmd=175 を送る", async () => {
    const p = botClickScript(c, { deviceId: DEVICE, secretKey: KEY, subUUID: SUB, scriptIndex: 5 });
    c.emit(ACK_KEY, OK_ACK);
    await p;
    expect(c.sent[0].cmd).toBe(175);
  });
});

// ============================================================
// LOCK-0030: botClickScript 範囲外/非整数は BAD_REQUEST
// ============================================================

describe("botClickScript — scriptIndex バリデーション", () => {
  let c;
  beforeEach(() => { c = makeMockClient(); });

  it.each([-1, 10, 1.5, NaN, "0"])(
    "[LOCK-0030] scriptIndex=%s は送信前に SesameError(BAD_REQUEST) を投げる",
    (idx) => {
      expect(() =>
        botClickScript(c, { deviceId: DEVICE, secretKey: KEY, subUUID: SUB, scriptIndex: idx })
      ).toThrow(SesameError);
      // 送信されていない
      expect(c.sent).toHaveLength(0);
    }
  );

  it("[LOCK-0030] BAD_REQUEST の code が設定されている", () => {
    let err;
    try {
      botClickScript(c, { deviceId: DEVICE, secretKey: KEY, subUUID: SUB, scriptIndex: -1 });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
  });

  it("[LOCK-0030] 文言に scriptIndex 範囲 (0..9) を含む", () => {
    let err;
    try {
      botClickScript(c, { deviceId: DEVICE, secretKey: KEY, subUUID: SUB, scriptIndex: 10 });
    } catch (e) { err = e; }
    // domain.lock.scriptIndexRange: "scriptIndex must be an integer 0..9 (got {index})"
    expect(err.message).toMatch(/scriptIndex/i);
  });
});

// ============================================================
// LOCK-0031: triggerItemCommand 汎用レール — フレーム構造 (wire-fidelity)
// ============================================================

describe("triggerItemCommand — フレーム構造 (wire-fidelity)", () => {
  let c;
  beforeEach(() => { c = makeMockClient(); });

  it("[LOCK-0031] frame が {action, cmd, sign, history:base64(payload), device_id} で lock/unlock と同型", async () => {
    const payload = Buffer.from([0x1e, 0x00]); // 30 LE
    const p = triggerItemCommand(c, { deviceId: DEVICE, secretKey: KEY, cmd: CMD.AUTOLOCK, payload });
    c.emit(ACK_KEY, OK_ACK);
    const ack = await p;
    const f = c.sent[0];
    // フレーム構造検証: {action, cmd, sign, history, device_id}
    expect(f.action).toBe("biz3TriggerLocker");
    expect(f.cmd).toBe(CMD.AUTOLOCK); // 11
    expect(typeof f.sign).toBe("string");
    expect(f.sign.length).toBeGreaterThan(0);
    expect(f.device_id).toBe(DEVICE);
    // history = base64(payload)
    expect(Buffer.from(f.history, "base64")).toEqual(payload);
    // op フィールドは無い (biz3TriggerLocker は op 無しフレーム)
    expect(f).not.toHaveProperty("op");
    // ack で resolve
    expect(ack).toMatchObject({ success: true });
  });

  it("[LOCK-0031] sign は 8 文字の hex 文字列 (cmacTime = 4B hex)", async () => {
    const p = triggerItemCommand(c, { deviceId: DEVICE, secretKey: KEY, cmd: CMD.LOCK, payload: Buffer.from([0]) });
    c.emit(ACK_KEY, OK_ACK);
    await p;
    expect(c.sent[0].sign).toMatch(/^[0-9a-f]{8}$/);
  });
});

// ============================================================
// LOCK-0032: triggerItemCommand payload 省略時は subUUID の history タグ / 両方無は BAD_REQUEST
// ============================================================

describe("triggerItemCommand — payload 省略時の subUUID フォールバック", () => {
  let c;
  beforeEach(() => { c = makeMockClient(); });

  it("[LOCK-0032] payload 未指定で subUUID 指定なら history=uuidToHistoryBase64(subUUID) (24文字 base64)", async () => {
    const p = triggerItemCommand(c, { deviceId: DEVICE, secretKey: KEY, cmd: CMD.LOCK, subUUID: SUB });
    c.emit(ACK_KEY, OK_ACK);
    await p;
    const f = c.sent[0];
    // history が Truthy (base64 文字列)
    expect(typeof f.history).toBe("string");
    expect(f.history.length).toBeGreaterThan(0);
    // uuidToHistoryBase64 の出力: 16バイト → base64 24文字
    expect(f.history.length).toBe(24);
  });

  it("[LOCK-0032] payload も subUUID も無ければ BAD_REQUEST を投げる (送信前)", async () => {
    let err;
    try {
      await triggerItemCommand(c, { deviceId: DEVICE, secretKey: KEY, cmd: CMD.LOCK });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    // 文言に "payload または subUUID" の趣旨を含む
    expect(err.message).toMatch(/payload|subUUID/i);
    expect(c.sent).toHaveLength(0);
  });
});

// ============================================================
// LOCK-0033: triggerItemCommand 必須バリデーション
// ============================================================

describe("triggerItemCommand — 必須引数バリデーション", () => {
  let c;
  beforeEach(() => { c = makeMockClient(); });

  it("[LOCK-0033] deviceId 欠落で BAD_REQUEST (送信前)", async () => {
    let err;
    try {
      await triggerItemCommand(c, { secretKey: KEY, cmd: CMD.AUTOLOCK, payload: Buffer.from([0]) });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(err.message).toMatch(/deviceId/i);
    expect(c.sent).toHaveLength(0);
  });

  it("[LOCK-0033] secretKey 欠落で BAD_REQUEST (送信前)", async () => {
    let err;
    try {
      await triggerItemCommand(c, { deviceId: DEVICE, cmd: CMD.AUTOLOCK, payload: Buffer.from([0]) });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(err.message).toMatch(/secretKey/i);
    expect(c.sent).toHaveLength(0);
  });

  it("[LOCK-0033] cmd が number でない場合は BAD_REQUEST (送信前)", async () => {
    let err;
    try {
      await triggerItemCommand(c, { deviceId: DEVICE, secretKey: KEY, payload: Buffer.from([0]) });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(err.message).toMatch(/cmd/i);
    expect(c.sent).toHaveLength(0);
  });
});

// ============================================================
// LOCK-0034: triggerItemCommand ack success:false で reject / timeout で reject
// ============================================================

describe("triggerItemCommand — ack success:false / timeout", () => {
  let c;
  beforeEach(() => { c = makeMockClient(); });

  it("[LOCK-0034] ack.success===false で SesameError(REJECTED) を reject する", async () => {
    const p = triggerItemCommand(c, {
      deviceId: DEVICE, secretKey: KEY, cmd: CMD.AUTOLOCK, payload: Buffer.from([0]),
    });
    c.emit(ACK_KEY, { action: "biz3TriggerLocker", code: 400, message: "bad cmd", success: false });
    let err;
    try { await p; } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.REJECTED);
  });

  it("[LOCK-0034] ack が来なければ (サーバ非対応の兆候) timeout で SesameError(TIMEOUT) を reject する", async () => {
    const p = triggerItemCommand(c, {
      deviceId: DEVICE, secretKey: KEY, cmd: CMD.AUTOLOCK, payload: Buffer.from([0]), timeoutMs: 30,
    });
    await expect(p).rejects.toMatchObject({ code: ERR.TIMEOUT });
  });
});

// ============================================================
// LOCK-0035: setAutolock cmd=11 / payload=2byte LE 秒数 / 戻り値
// ============================================================

describe("setAutolock — wire-fidelity (cmd=11, 2byte LE payload)", () => {
  let c;
  beforeEach(() => { c = makeMockClient(); });

  it("[LOCK-0035] frame.cmd===AUTOLOCK(11) で history=base64([sec&0xff,(sec>>8)&0xff])、戻り値 {ack,cmd:11,seconds}", async () => {
    const seconds = 300;
    const p = setAutolock(c, { deviceId: DEVICE, secretKey: KEY, seconds });
    c.emit(ACK_KEY, OK_ACK);
    const r = await p;
    // 戻り値
    expect(r.cmd).toBe(11); // CMD.AUTOLOCK = 11
    expect(r.seconds).toBe(seconds);
    expect(r.ack).toMatchObject({ success: true });
    // フレーム
    const frame = c.sent[0];
    expect(frame.cmd).toBe(11);
    // payload = 2byte LE
    const decoded = Buffer.from(frame.history, "base64");
    expect([...decoded]).toEqual([seconds & 0xff, (seconds >> 8) & 0xff]);
  });

  it("[LOCK-0035] seconds=1 (1byte 境界) → payload [0x01, 0x00]", async () => {
    const p = setAutolock(c, { deviceId: DEVICE, secretKey: KEY, seconds: 1 });
    c.emit(ACK_KEY, OK_ACK);
    await p;
    expect([...Buffer.from(c.sent[0].history, "base64")]).toEqual([0x01, 0x00]);
  });

  it("[LOCK-0035] seconds=65535 (上限) → payload [0xff, 0xff]", async () => {
    const p = setAutolock(c, { deviceId: DEVICE, secretKey: KEY, seconds: 65535 });
    c.emit(ACK_KEY, OK_ACK);
    await p;
    expect([...Buffer.from(c.sent[0].history, "base64")]).toEqual([0xff, 0xff]);
  });
});

// ============================================================
// LOCK-0036: setAutolock seconds=0 で無効化 (payload 00 00)
// ============================================================

describe("setAutolock — seconds=0 で autolock 無効化", () => {
  let c;
  beforeEach(() => { c = makeMockClient(); });

  it("[LOCK-0036] seconds=0 は autolock 無効化で payload が 00 00", async () => {
    const p = setAutolock(c, { deviceId: DEVICE, secretKey: KEY, seconds: 0 });
    c.emit(ACK_KEY, OK_ACK);
    const r = await p;
    expect(r.seconds).toBe(0);
    expect([...Buffer.from(c.sent[0].history, "base64")]).toEqual([0x00, 0x00]);
  });
});
