// lock-c0.test.js — LOCK-0001〜LOCK-0018 統合 TDD spec テスト
//
// 対象: packages/core/src/lock.js の triggerLock / lockLock / lockUnlock / lockToggle / botClick
// 方針: TDD — spec どおりの期待値を assert する (実装バグは red になってよい)
// mock: makeMockClient (FIFO pending, subscribe/emit fan-out) — ネットワーク/実機不使用
//
// A と B の統合方針:
//   - フレーム構造 / cmd 値 / FIFO 相関は B の実装 (より詳細なアサート) を基本に採用
//   - ack 解決 / state push / LOCK-0014 の reject 文言は実装の i18n テンプレート
//     ("triggerLock failed (cmd={cmd}): code={code} {message}") に合わせて修正
//   - LOCK-0016 の subscribe-before-send 検証は B (pendingCount + subCount) を採用
//   - import は重複排除し lock.js / crypto.js / messageConstants 一本化

import { describe, it, expect, beforeEach } from "vitest";
import { Buffer } from "node:buffer";
import { setLocale } from "../../src/i18n.js";
import {
  triggerLock,
  lockLock,
  lockUnlock,
  lockToggle,
  botClick,
} from "../../src/lock.js";
import { CMD, uuidToHistoryBase64, cmacTime, normalizeUuid } from "../../src/crypto.js";
import { ACTION_TYPES } from "../../src/vendor/biz3/constants/messageConstants.js";

// テスト全体で en ロケール固定 (setup.i18n.js が ja にするため beforeEach で上書き)
beforeEach(() => setLocale("en"));

// ---- フィクスチャ ----
const KEY    = "0123456789abcdef0123456789abcdef"; // 32hex, 16B
const SUB    = "11111111222233334444555566667777"; // subUUID 32hex (ハイフン無し)
const DEVICE = "aaaaaaaabbbbccccddddeeeeeeeeffff"; // deviceUUID 32hex
const DEVICE_HYPHEN = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeffff"; // ハイフン付き

// ack dispatch キー (transport.js の key = `${action}:${op||""}`)
const ACK_KEY   = "biz3TriggerLocker:";
const STATE_KEY = "biz3TriggerLocker:pubDeviceStateChange";

const OK_ACK = { action: "biz3TriggerLocker", code: 200, data: {}, message: "", success: true };

// ---- Mock クライアント ----
// transport.js の FIFO pending + subscriber fan-out を模倣した最小 mock。
// - request(payload, ms): FIFO 登録 → send → Promise を返す
// - emit(key, msg)      : FIFO 先頭 1 件解決 → subscriber fan-out
// - subscribe(key, fn)  : 永続購読 (unsubscribe 関数を返す)
// - getStatus()         : 'open' | 'closed'
function makeMockClient(overrides = {}) {
  const handlers = new Map(); // key -> Map<id, fn>
  const pending  = new Map(); // key -> [{resolve, to}]
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
          if (q) { const i = q.indexOf(entry); if (i >= 0) q.splice(i, 1); if (q.length === 0) pending.delete(key); }
          const e = new Error(`request timeout: ${key}`);
          e.code = "TRANSPORT_TIMEOUT";
          reject(e);
        }, timeoutMs);
        entry.resolve = (msg) => { clearTimeout(entry.to); resolve(msg); };
        if (!pending.has(key)) pending.set(key, []);
        pending.get(key).push(entry);
        client.send(payload); // pending 登録後に送信 (transport.js:256-257 と同順)
      });
    },
    emit(key, msg) {
      // FIFO 1 件解決 (transport.js:508-513)
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
    // テスト用カウンタ
    subCount(key)     { const m = handlers.get(key); return m ? m.size : 0; },
    pendingCount(key) { const q = pending.get(key); return q ? q.length : 0; },
  };
  return client;
}

// ============================================================
// ワイヤフレーム構造 (LOCK-0001〜LOCK-0005)
// ============================================================

describe("biz3TriggerLocker ワイヤフレーム構造", () => {
  let client;
  beforeEach(() => { client = makeMockClient(); });

  it("[LOCK-0001] triggerLock → フレームキーが {action,cmd,sign,history,device_id} のみ (op 無し)", async () => {
    // 送信フレームのキー集合が {action, cmd, sign, history, device_id} で op フィールドを含まない。
    // ref: lock.js:89; useIotCtrl.js:41-48 (sendCommandToWM2 同型)
    const p = triggerLock(client, {
      deviceId: DEVICE, secretKey: KEY, subUUID: SUB,
      cmd: CMD.LOCK, timeoutMs: 50,
    });
    const frame = client.sent[0];
    expect(frame).toHaveProperty("action");
    expect(frame).toHaveProperty("cmd");
    expect(frame).toHaveProperty("sign");
    expect(frame).toHaveProperty("history");
    expect(frame).toHaveProperty("device_id");
    // op フィールドは存在しない (biz3TriggerLocker は op 無し)
    expect(frame).not.toHaveProperty("op");
    // フレームのキー集合が 5 個だけであること (順序も確認)
    expect(Object.keys(frame).sort()).toEqual(["action", "cmd", "device_id", "history", "sign"]);
    await expect(p).rejects.toThrow(/timeout/i);
  });

  it("[LOCK-0002] action は ACTION_TYPES.BIZ3_TRIGGER_LOCKER = 'biz3TriggerLocker' リテラル", async () => {
    // frame.action が 'biz3TriggerLocker' (ACTION_TYPES.BIZ3_TRIGGER_LOCKER) と一致する。
    // ref: lock.js:31; messageConstants.js:16
    const p = triggerLock(client, {
      deviceId: DEVICE, secretKey: KEY, subUUID: SUB,
      cmd: CMD.LOCK, timeoutMs: 50,
    });
    const frame = client.sent[0];
    // vendor 定数の値を直接参照して突き合わせ
    expect(frame.action).toBe(ACTION_TYPES.BIZ3_TRIGGER_LOCKER);
    // 文字列リテラルとも一致を確認
    expect(frame.action).toBe("biz3TriggerLocker");
    await expect(p).rejects.toThrow(/timeout/i);
  });

  it("[LOCK-0003] history = uuidToHistoryBase64(subUUID) — 24文字 base64, prefix 000c (2B)", async () => {
    // frame.history が uuidToHistoryBase64(subUUID) = base64('000c'+subUUID) で 24 文字。
    // ref: lock.js:134; crypto.js:126-133; biz3utils.js:455-458
    const expected = uuidToHistoryBase64(SUB);
    // 24 文字 base64 であることを確認 (18B → base64 = 24 文字)
    expect(expected).toHaveLength(24);
    // prefix '000c' (2B) + subUUID 16B = 18B
    const decoded = Buffer.from(expected, "base64");
    expect(decoded).toHaveLength(18);
    expect(decoded[0]).toBe(0x00);
    expect(decoded[1]).toBe(0x0c);

    const p = triggerLock(client, {
      deviceId: DEVICE, secretKey: KEY, subUUID: SUB,
      cmd: CMD.LOCK, timeoutMs: 50,
    });
    expect(client.sent[0].history).toBe(expected);
    await expect(p).rejects.toThrow(/timeout/i);
  });

  it("[LOCK-0004] sign = cmacTime(secretKey) の 8文字 hex (256秒粒度 CMAC)", async () => {
    // frame.sign が cmacTime(secretKey) の 4B/8hex。
    // ref: lock.js:133; crypto.js:55-73
    const p = triggerLock(client, {
      deviceId: DEVICE, secretKey: KEY, subUUID: SUB,
      cmd: CMD.LOCK, timeoutMs: 50,
    });
    const frame = client.sent[0];
    // 8 文字 hex であること
    expect(frame.sign).toMatch(/^[0-9a-f]{8}$/);
    // cmacTime と同じ生成規則 (同一ミリ秒内なら一致するはず)
    const expected = cmacTime(KEY);
    expect(frame.sign).toBe(expected);
    await expect(p).rejects.toThrow(/timeout/i);
  });

  it("[LOCK-0005] device_id は引数 deviceId をそのまま (大小/ハイフン変換なし)", async () => {
    // frame.device_id が引数 deviceId 文字列を無加工で載せる。
    // ref: lock.js:89; useIotCtrl.js:46 (device_id をそのまま渡す)
    const p = triggerLock(client, {
      deviceId: DEVICE_HYPHEN, secretKey: KEY, subUUID: SUB,
      cmd: CMD.LOCK, timeoutMs: 50,
    });
    const frame = client.sent[0];
    // ハイフン付きそのままで載ること (normalize されない)
    expect(frame.device_id).toBe(DEVICE_HYPHEN);
    await expect(p).rejects.toThrow(/timeout/i);
  });
});

// ============================================================
// cmd 値 — ラッパ関数 (LOCK-0006〜LOCK-0010)
// ============================================================

describe("cmd 値 — ラッパ関数", () => {
  let client;
  beforeEach(() => { client = makeMockClient(); });

  it("[LOCK-0006] lockLock cmd=82 (LOCK)", async () => {
    // frame.cmd === 82 (ITEM_CODES.LOCK)
    // ref: lock.js:145; itemcodes.js:34
    const p = lockLock(client, {
      deviceId: DEVICE, secretKey: KEY, subUUID: SUB, timeoutMs: 50,
    });
    expect(client.sent[0].cmd).toBe(82);
    expect(CMD.LOCK).toBe(82); // 定数値の確認
    await expect(p).rejects.toThrow(/timeout/i);
  });

  it("[LOCK-0007] lockUnlock cmd=83 (UNLOCK)", async () => {
    // frame.cmd === 83 (ITEM_CODES.UNLOCK)
    // ref: lock.js:147; itemcodes.js:35
    const p = lockUnlock(client, {
      deviceId: DEVICE, secretKey: KEY, subUUID: SUB, timeoutMs: 50,
    });
    expect(client.sent[0].cmd).toBe(83);
    expect(CMD.UNLOCK).toBe(83);
    await expect(p).rejects.toThrow(/timeout/i);
  });

  it("[LOCK-0008] lockToggle cmd=88 (TOGGLE, cloud 合成命令)", async () => {
    // frame.cmd === 88 (ITEM_CODES.TOGGLE) を送る。cloud のみ、サーバが LOCK/UNLOCK を判定。
    // ref: lock.js:149; itemcodes.js:40; useIotCtrl.js:37
    const p = lockToggle(client, {
      deviceId: DEVICE, secretKey: KEY, subUUID: SUB, timeoutMs: 50,
    });
    expect(client.sent[0].cmd).toBe(88);
    expect(CMD.TOGGLE).toBe(88);
    await expect(p).rejects.toThrow(/timeout/i);
  });

  it("[LOCK-0009] botClick cmd=89 (CLICK / BOT_CLICK)", async () => {
    // frame.cmd === 89 (ITEM_CODES.CLICK, biz3 web 呼称 BOT_CLICK)
    // ref: lock.js:151; itemcodes.js:41
    const p = botClick(client, {
      deviceId: DEVICE, secretKey: KEY, subUUID: SUB, timeoutMs: 50,
    });
    expect(client.sent[0].cmd).toBe(89);
    expect(CMD.CLICK).toBe(89);
    await expect(p).rejects.toThrow(/timeout/i);
  });

  it("[LOCK-0010] wrapper の cmd は呼び出し元 cmd を強制上書きする", async () => {
    // lockLock/lockUnlock/lockToggle/botClick が triggerLock に渡す cmd で params.cmd を強制上書き。
    // ref: lock.js:145-151
    const base = { deviceId: DEVICE, secretKey: KEY, subUUID: SUB, timeoutMs: 50 };

    // lockLock: たとえ cmd:999 を渡しても 82 で上書きされる
    const p1 = lockLock(client, { ...base, cmd: 999 });
    expect(client.sent[0].cmd).toBe(CMD.LOCK);   // 82
    await expect(p1).rejects.toThrow(/timeout/i);

    const c2 = makeMockClient();
    const p2 = lockUnlock(c2, { ...base, cmd: 0 });
    expect(c2.sent[0].cmd).toBe(CMD.UNLOCK);  // 83
    await expect(p2).rejects.toThrow(/timeout/i);

    const c3 = makeMockClient();
    const p3 = lockToggle(c3, { ...base, cmd: 0 });
    expect(c3.sent[0].cmd).toBe(CMD.TOGGLE);  // 88
    await expect(p3).rejects.toThrow(/timeout/i);

    const c4 = makeMockClient();
    const p4 = botClick(c4, { ...base, cmd: 0 });
    expect(c4.sent[0].cmd).toBe(CMD.CLICK);   // 89
    await expect(p4).rejects.toThrow(/timeout/i);
  });
});

// ============================================================
// ack 解決 / FIFO 相関 (LOCK-0011〜LOCK-0015)
// ============================================================

describe("ack 解決 / FIFO 相関", () => {
  let client;
  beforeEach(() => { client = makeMockClient(); });

  it("[LOCK-0011] 同期 ack {code:200,data:{},success:true} で resolve する", async () => {
    // サーバの即時 ack で resolve し、pending/state 購読が解放される。
    // ref: lock.js:87-99
    const p = triggerLock(client, {
      deviceId: DEVICE, secretKey: KEY, subUUID: SUB, cmd: CMD.LOCK, timeoutMs: 200,
    });
    client.emit(ACK_KEY, OK_ACK);
    const result = await p;
    expect(result).toMatchObject({ action: "biz3TriggerLocker", code: 200, data: {}, success: true });
    // pending と購読が解放されていること
    expect(client.pendingCount(ACK_KEY)).toBe(0);
    expect(client.subCount(STATE_KEY)).toBe(0);
  });

  it("[LOCK-0012] ack 相関キーは 'biz3TriggerLocker:' (op 空) で FIFO 1 件解決", async () => {
    // request の相関キーが `biz3TriggerLocker:` (action+空op) で生成される。
    // ref: lock.js:31-34,89; transport.js:262-278,527-533
    const p = triggerLock(client, {
      deviceId: DEVICE, secretKey: KEY, subUUID: SUB, cmd: CMD.LOCK, timeoutMs: 200,
    });
    // 送信直後は FIFO pending が 1 件登録されていること
    expect(client.pendingCount(ACK_KEY)).toBe(1);
    // 送信フレームの action が ACK_KEY のプレフィックスと一致
    expect(`${client.sent[0].action}:`).toBe(ACK_KEY);
    // op 無し ack (key = "biz3TriggerLocker:") で解決されること
    client.emit(ACK_KEY, OK_ACK);
    await expect(p).resolves.toMatchObject({ success: true });
    expect(client.pendingCount(ACK_KEY)).toBe(0);
  });

  it("[LOCK-0013] 並行 2 コマンドは送信順=解決順 (FIFO) で別 ack を受ける", async () => {
    // ack に相関情報が無いため、並行 2 リクエストは transport の FIFO pending で送信順に解決。
    // ref: lock.js:87-89; transport.js:526-533,553-557
    const base = { deviceId: DEVICE, secretKey: KEY, subUUID: SUB, timeoutMs: 500 };
    const p1 = triggerLock(client, { ...base, cmd: CMD.LOCK });
    const p2 = triggerLock(client, { ...base, cmd: CMD.UNLOCK });
    // 2 件の pending が FIFO キューに積まれていること
    expect(client.pendingCount(ACK_KEY)).toBe(2);
    // 送信順確認
    expect(client.sent[0].cmd).toBe(82);
    expect(client.sent[1].cmd).toBe(83);
    // 別々の ack (seq で区別) を送信順に届ける
    const ack1 = { ...OK_ACK, data: { seq: 1 } };
    const ack2 = { ...OK_ACK, data: { seq: 2 } };
    client.emit(ACK_KEY, ack1);
    client.emit(ACK_KEY, ack2);
    const [r1, r2] = await Promise.all([p1, p2]);
    // 送信順 (p1→seq:1, p2→seq:2) で解決されること
    expect(r1.data.seq).toBe(1);
    expect(r2.data.seq).toBe(2);
  });

  it("[LOCK-0014] 並行 2 件で先着 ack が success:false → 先頭 1 件だけ reject、2 件目は次 ack で resolve", async () => {
    // 先着 ack が success:false でも FIFO 先頭の 1 件のみ reject され、
    // もう一方は次 ack で resolve する。
    // ref: lock.js:91-99; transport.js:526-533
    // i18n template: "triggerLock failed (cmd={cmd}): code={code} {message}"
    const base = { deviceId: DEVICE, secretKey: KEY, subUUID: SUB, timeoutMs: 500 };
    const p1 = triggerLock(client, { ...base, cmd: CMD.LOCK });
    const p2 = triggerLock(client, { ...base, cmd: CMD.UNLOCK });
    // 先頭の p1 へ success:false ack を届ける
    client.emit(ACK_KEY, { action: "biz3TriggerLocker", code: 403, message: "forbidden", success: false });
    // 次の p2 へ正常 ack を届ける
    client.emit(ACK_KEY, { ...OK_ACK, data: { seq: 2 } });
    // p1 だけ reject (文言テンプレートに合う正規表現)
    await expect(p1).rejects.toThrow(/triggerLock failed/);
    // p2 は resolve
    await expect(p2).resolves.toMatchObject({ data: { seq: 2 } });
  });

  it("[LOCK-0015] ack は cmd/deviceUUID を問わず resolve (data:{} 許容)", async () => {
    // ack に cmd echo / deviceUUID が無く data:{} 空でも success!==false なら resolve する。
    // ref: lock.js:90-98
    const p = triggerLock(client, {
      deviceId: DEVICE, secretKey: KEY, subUUID: SUB, cmd: CMD.LOCK, timeoutMs: 200,
    });
    // 最小 ack (cmd/deviceUUID echo なし、data 空)
    client.emit(ACK_KEY, { action: "biz3TriggerLocker", code: 200, data: {}, success: true });
    const result = await p;
    expect(result).toMatchObject({ success: true });
    // data は空でよい
    expect(result.data).toEqual({});
  });
});

// ============================================================
// state 購読タイミング (LOCK-0016)
// ============================================================

describe("送信前の state 購読タイミング", () => {
  it("[LOCK-0016] 送信 (request) 前に pubDeviceStateChange 購読を張り、その後 pending を登録する", async () => {
    // dispatchTrigger の実装: subscribe(STATE_EVENT_KEY, ...) → request(...)
    // subscribe が先に呼ばれるため、send に積まれる前に subCount が増えているはず。
    // ref: lock.js:78-89
    let ackPendingAtSend = -1;
    let stateSubAtSend   = -1;
    const c = makeMockClient({
      send: (msg) => {
        // send が呼ばれた時点 (= request 内の pending 登録直後) の状態を記録
        ackPendingAtSend = c.pendingCount(ACK_KEY);
        stateSubAtSend   = c.subCount(STATE_KEY);
        c.sent.push(msg);
      },
    });
    c.sent = [];
    const p = triggerLock(c, {
      deviceId: DEVICE, secretKey: KEY, subUUID: SUB, cmd: CMD.LOCK, timeoutMs: 50,
    });
    // 送信時点で ack pending が 1 件、state 購読が 1 件張られていること
    expect(ackPendingAtSend).toBe(1);
    expect(stateSubAtSend).toBe(1);
    await expect(p).rejects.toThrow(/timeout/i);
  });
});

// ============================================================
// state push 補助解決 (LOCK-0017〜LOCK-0018)
// ============================================================

describe("state push 補助解決", () => {
  let client;
  beforeEach(() => { client = makeMockClient(); });

  it("[LOCK-0017] pubDeviceStateChange (data.deviceUUID 一致) でも resolve する", async () => {
    // 購読キー biz3TriggerLocker:pubDeviceStateChange の push が来て
    // data.deviceUUID が target と一致すれば resolve する。
    // ref: lock.js:36,78-85; useIotCtrl.js:11,17-22
    const p = triggerLock(client, {
      deviceId: DEVICE, secretKey: KEY, subUUID: SUB, cmd: CMD.LOCK, timeoutMs: 200,
    });
    const push = {
      action: "biz3TriggerLocker",
      op: "pubDeviceStateChange",
      data: { deviceUUID: DEVICE },
    };
    client.emit(STATE_KEY, push);
    const result = await p;
    expect(result).toMatchObject({ op: "pubDeviceStateChange" });
    // 購読が解放されていること
    expect(client.subCount(STATE_KEY)).toBe(0);
  });

  it("[LOCK-0018] state push の deviceUUID は normalizeUuid で照合し、大文字/ハイフン付きでも一致する", async () => {
    // push の data.deviceUUID をハイフン除去+小文字化して target と比較し、
    // 大文字/ハイフン付き UUID でも一致する。
    // ref: lock.js:82-84; crypto.js:153-155

    // DEVICE_HYPHEN を target に指定 → normalizeUuid で 32hex 小文字に正規化
    const p = triggerLock(client, {
      deviceId: DEVICE_HYPHEN,
      secretKey: KEY,
      subUUID: SUB,
      cmd: CMD.UNLOCK,
      timeoutMs: 200,
    });
    // 大文字 + ハイフン付き UUID の push でも一致すること
    const upperHyphenUUID = DEVICE_HYPHEN.toUpperCase(); // "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEFFFF"
    client.emit(STATE_KEY, {
      action: "biz3TriggerLocker",
      op: "pubDeviceStateChange",
      data: { deviceUUID: upperHyphenUUID },
    });
    const result = await p;
    expect(result).toMatchObject({ op: "pubDeviceStateChange" });

    // ハイフン無し大文字でも一致すること
    const c2 = makeMockClient();
    const p2 = triggerLock(c2, {
      deviceId: DEVICE, secretKey: KEY, subUUID: SUB,
      cmd: CMD.LOCK, timeoutMs: 200,
    });
    const noHyphenUpper = DEVICE.toUpperCase(); // ハイフン無し・大文字
    c2.emit(STATE_KEY, {
      action: "biz3TriggerLocker",
      op: "pubDeviceStateChange",
      data: { deviceUUID: noHyphenUpper },
    });
    const result2 = await p2;
    expect(result2).toMatchObject({ op: "pubDeviceStateChange" });

    // 別の deviceUUID では一致しないこと (timeout になる)
    const c3 = makeMockClient();
    const p3 = triggerLock(c3, {
      deviceId: DEVICE, secretKey: KEY, subUUID: SUB,
      cmd: CMD.LOCK, timeoutMs: 80,
    });
    c3.emit(STATE_KEY, { data: { deviceUUID: "ffffffffffffffffffffffffffffffff" } });
    await expect(p3).rejects.toThrow(/timeout/i);
  });
});
