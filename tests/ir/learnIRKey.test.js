// Unit tests for learnIRKey in src/ir.js
//
// 戦略:
//   - learnIRKey は client.request / client.subscribe / client.send だけを使うため、
//     ws server を立てる必要はない。最小 mock client (vi.fn ベース) で十分。
//   - mock client は op → response の dispatcher を持ち、subscribe は listener を保持して
//     テストから明示的に emit() できるようにする。
//   - timeout 経路は短い timeoutMs (例 20ms) を渡して real timer で検証する
//     (fake timer は await Promise との合成で flake が起きやすいので避ける)。
//   - 各 it で beforeEach により client を作り直し、互いに干渉しない。
//
// 検証する正常系シーケンス (biz3 公式準拠):
//   setIRMode(REGISTER) → subscribeIRData(ack) → onPrompt → 波形 emit (msg.data.data)
//   → unsubscribeIRData (send / fire-and-forget) → setIRMode(CONTROL)
//   → keyUUID をクライアント発番 → addIRCode({keyUUID, name, uuid, deviceId, data})
//   → 戻り値 {keyUUID, captured, saved} (captured = 生波形 = msg.data.data)

import { describe, it, expect, beforeEach, vi } from "vitest";
import { learnIRKey, MODE } from "../../src/ir.js";

const ACTION = "biz3IRRemote";

/** UUID v4 形式。biz3 generateUUID は .toUpperCase() で大文字を返すため大文字 hex を期待。 */
const UUID_RE = /^[0-9A-F-]{36}$/;

/**
 * subscribeIRDataRsp が運ぶ波形ペイロードを作る。
 * biz3: 生波形は response.data.data (= msg.data.data)。
 */
function rsp(deviceId, hexWaveform) {
  return { deviceId, data: { data: hexWaveform } };
}

/**
 * テスト用 mock client。
 *  - request(frame, timeout): op → response 表 (responses) に従って resolve/reject。
 *  - subscribe(topic, fn): listener を登録して unsubscribe 関数を返す。
 *  - send(frame): fire-and-forget。記録のみ。
 *  - emit(topic, msg): subscribe したコールバックを発火 (テスト用)。
 *
 * responses は op 名 → fn(frame) => result(Promise可) または直接 object。
 */
function makeClient(responses = {}) {
  const requests = [];
  const sends = [];
  const subscriptions = new Map(); // topic -> Set<fn>

  const client = {
    requests,
    sends,
    subscriptions,
    request: vi.fn(async (frame, _timeoutMs) => {
      requests.push(frame);
      const handler = responses[frame.op];
      if (!handler) {
        // default = success: true (空 body)
        return { success: true };
      }
      const r = typeof handler === "function" ? handler(frame) : handler;
      return await r;
    }),
    send: vi.fn((frame) => {
      sends.push(frame);
    }),
    subscribe: vi.fn((topic, fn) => {
      if (!subscriptions.has(topic)) subscriptions.set(topic, new Set());
      subscriptions.get(topic).add(fn);
      return () => {
        const s = subscriptions.get(topic);
        if (s) s.delete(fn);
      };
    }),
    emit(topic, msg) {
      const s = subscriptions.get(topic);
      if (!s) return;
      for (const fn of s) fn(msg);
    },
  };
  return client;
}

/**
 * sub.onData() の登録は onPrompt 呼び出し *後* なので、onPrompt 内で同期 emit すると拾えない。
 * テストでは setTimeout で 1ms 後に emit して Promise listener 登録を待つ。
 */
function scheduleEmit(client, topic, msg, delayMs = 1) {
  setTimeout(() => client.emit(topic, msg), delayMs);
}
const RSP_TOPIC = `${ACTION}:subscribeIRDataRsp`;

const DEVICE_ID = "hub3-dev-1";
const COMPANY_ID = "co-A";
const REMOTE_ID = "remote-uuid-1";

/** デフォルトの正常レスポンス set。 */
function defaultResponses() {
  return {
    setIRMode: { success: true },
    subscribeIRData: { success: true },
    addIRCode: { success: true, data: { keyUUID: "key-1" } },
  };
}

describe("learnIRKey", () => {
  let client;

  beforeEach(() => {
    client = makeClient(defaultResponses());
  });

  it("正常系: REGISTER → subscribe → 波形受信 → unsubscribe → CONTROL → addIRCode の順で実行される", async () => {
    // onPrompt は sub.onData() 登録 *前* に呼ばれるため、emit は非同期 (setTimeout) で遅延させる
    const onPrompt = vi.fn(() => {
      setTimeout(() => {
        client.emit(RSP_TOPIC, rsp(DEVICE_ID, "AABBCC"));
      }, 1);
    });

    const result = await learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "Power",
      irType: 7,
      companyID: COMPANY_ID,
      timeoutMs: 500,
      onPrompt,
    });

    // 戻り値の形: keyUUID はクライアント発番、captured は生波形 (msg.data.data)、saved は addIRCode 応答
    expect(result.keyUUID).toMatch(UUID_RE);
    expect(result.captured).toBe("AABBCC");
    expect(result.saved).toEqual({ keyUUID: "key-1" });

    // op の順序検証
    const ops = client.requests.map((f) => f.op);
    expect(ops).toEqual(["setIRMode", "subscribeIRData", "setIRMode", "addIRCode"]);

    // 1 回目の setIRMode は REGISTER
    expect(client.requests[0]).toMatchObject({
      action: ACTION,
      op: "setIRMode",
      deviceId: DEVICE_ID,
      mode: MODE.REGISTER,
      companyID: COMPANY_ID,
    });
    // 2 回目の setIRMode は CONTROL
    expect(client.requests[2]).toMatchObject({
      op: "setIRMode",
      mode: MODE.CONTROL,
    });

    // unsubscribe (send: fire-and-forget) が呼ばれている
    const unsubSend = client.sends.find((f) => f.op === "unsubscribeIRData");
    expect(unsubSend).toBeDefined();
    expect(unsubSend).toMatchObject({
      action: ACTION,
      op: "unsubscribeIRData",
      deviceId: DEVICE_ID,
      companyID: COMPANY_ID,
    });

    // addIRCode の中身検証 (biz3 公式 irCode フィールド)
    const addFrame = client.requests[3];
    expect(addFrame).toMatchObject({
      op: "addIRCode",
      companyID: COMPANY_ID,
      irCode: {
        keyUUID: result.keyUUID,
        name: "Power",
        uuid: REMOTE_ID,
        deviceId: DEVICE_ID,
        data: "AABBCC",
      },
    });
    // 旧仕様のフィールドは存在しない
    expect(addFrame.irCode).not.toHaveProperty("irData");
    expect(addFrame.irCode).not.toHaveProperty("irWaveLength");
    expect(addFrame.irCode).not.toHaveProperty("irType");
    expect(addFrame.irCode).not.toHaveProperty("hub3DeviceId");
    expect(addFrame.irCode).not.toHaveProperty("remoteId");
  });

  it("keyUUID はクライアントが発番する (サーバ応答の keyUUID は使わない)", async () => {
    // addIRCode は keyUUID を含まない応答を返すが、戻り値には発番済み keyUUID が載る
    client = makeClient({
      setIRMode: { success: true },
      subscribeIRData: { success: true },
      addIRCode: { success: true, data: { ok: true } },
    });

    const onPrompt = () => scheduleEmit(client, RSP_TOPIC, rsp(DEVICE_ID, "AABBCC"));

    const result = await learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "Power",
      irType: 7,
      companyID: COMPANY_ID,
      timeoutMs: 500,
      onPrompt,
    });

    expect(result.keyUUID).toMatch(UUID_RE);
    // addIRCode フレームに乗った keyUUID と戻り値が一致する
    const addFrame = client.requests.find((f) => f.op === "addIRCode");
    expect(addFrame.irCode.keyUUID).toBe(result.keyUUID);
  });

  it("irCode.uuid は remoteId、irCode.deviceId は hub3DeviceId、irCode.data は msg.data.data になる", async () => {
    const onPrompt = () => scheduleEmit(client, RSP_TOPIC, rsp(DEVICE_ID, "DEADBEEF"));

    await learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "Vol+",
      irType: 1,
      companyID: COMPANY_ID,
      timeoutMs: 500,
      onPrompt,
    });

    const addFrame = client.requests.find((f) => f.op === "addIRCode");
    expect(addFrame.irCode.uuid).toBe(REMOTE_ID);
    expect(addFrame.irCode.deviceId).toBe(DEVICE_ID);
    expect(addFrame.irCode.data).toBe("DEADBEEF");
    expect(addFrame.irCode.name).toBe("Vol+");
  });

  it("onPrompt は REGISTER モードに入った直後 (subscribe 完了後) に呼ばれる", async () => {
    const callOrder = [];
    client = makeClient({
      setIRMode: (frame) => {
        callOrder.push(`setIRMode(${frame.mode})`);
        return { success: true };
      },
      subscribeIRData: () => {
        callOrder.push("subscribeIRData");
        return { success: true };
      },
      addIRCode: () => ({ success: true, data: { keyUUID: "k" } }),
    });

    const onPrompt = vi.fn(() => {
      callOrder.push("onPrompt");
      // 非同期 emit (listener 登録を待つ)
      scheduleEmit(client, RSP_TOPIC, rsp(DEVICE_ID, "DEADBEEF"));
    });

    await learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "Vol+",
      irType: 1,
      companyID: COMPANY_ID,
      timeoutMs: 500,
      onPrompt,
    });

    // REGISTER → subscribe → onPrompt の順
    expect(callOrder.slice(0, 3)).toEqual([
      `setIRMode(${MODE.REGISTER})`,
      "subscribeIRData",
      "onPrompt",
    ]);
    expect(onPrompt).toHaveBeenCalledTimes(1);
  });

  it("onPrompt が throw しても学習は継続する (try/catch で握りつぶす)", async () => {
    const onPrompt = vi.fn(() => {
      // throw する前に非同期 emit を schedule (Promise listener 登録後に発火)
      scheduleEmit(client, RSP_TOPIC, rsp(DEVICE_ID, "FF"));
      throw new Error("UI render failed");
    });

    const result = await learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "Power",
      irType: 1,
      companyID: COMPANY_ID,
      timeoutMs: 500,
      onPrompt,
    });

    expect(result.captured).toBe("FF");
    expect(onPrompt).toHaveBeenCalled();
  });

  it("onPrompt 未指定でも動作する", async () => {
    // setImmediate / queueMicrotask 相当で emit (await を切ってから)
    setTimeout(() => {
      client.emit(RSP_TOPIC, rsp(DEVICE_ID, "01"));
    }, 5);

    const result = await learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "k",
      irType: 1,
      companyID: COMPANY_ID,
      timeoutMs: 500,
    });
    expect(result.captured).toBe("01");
  });

  it("timeout 経過しても波形が来なければ reject される。reject 時も unsubscribe と CONTROL 復帰は実行される", async () => {
    // 何もしない onPrompt
    const onPrompt = vi.fn();

    const p = learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "Power",
      irType: 1,
      companyID: COMPANY_ID,
      timeoutMs: 20, // 短く
      onPrompt,
    });

    await expect(p).rejects.toThrow(/learn timeout/);

    // finally で unsubscribe と setIRMode(CONTROL) が走っているはず
    const ops = client.requests.map((f) => f.op);
    expect(ops).toEqual(["setIRMode", "subscribeIRData", "setIRMode"]);
    expect(client.requests[2].mode).toBe(MODE.CONTROL);

    // addIRCode は呼ばれない
    expect(ops).not.toContain("addIRCode");

    // unsubscribe (send) は呼ばれている
    expect(client.sends.some((f) => f.op === "unsubscribeIRData")).toBe(true);
  });

  it("timeoutMs 省略時はデフォルト 60s (LEARN_DEFAULT_TIMEOUT_MS) が使われる — 直後に emit すれば即解決", async () => {
    // ここでは timeout の数値そのものは外部から観測できないので、
    // 短時間で emit すれば確実に resolve することを確認する。
    setTimeout(() => {
      client.emit(RSP_TOPIC, rsp(DEVICE_ID, "AA"));
    }, 5);

    const start = Date.now();
    const result = await learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "K",
      irType: 1,
      companyID: COMPANY_ID,
      // timeoutMs 省略
    });
    const elapsed = Date.now() - start;

    expect(result.captured).toBe("AA");
    // 当然 60s ずっと待たない
    expect(elapsed).toBeLessThan(1000);
  });

  it("setIRMode(REGISTER) が失敗 (success:false) すると例外を投げ、後続の subscribe / addIRCode は呼ばれない", async () => {
    client = makeClient({
      setIRMode: () => ({ success: false, message: "device busy" }),
    });

    const p = learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "K",
      irType: 1,
      companyID: COMPANY_ID,
      timeoutMs: 100,
    });

    await expect(p).rejects.toThrow(/setIRMode failed/);

    const ops = client.requests.map((f) => f.op);
    // REGISTER 1 回だけ。subscribe にも到達しない。
    expect(ops).toEqual(["setIRMode"]);
    expect(client.sends).toEqual([]);
  });

  it("subscribeIRData の ack が失敗するとエラー。setIRMode(CONTROL) で best-effort 復帰はされない (subscribe 前なので finally に到達しない)", async () => {
    client = makeClient({
      setIRMode: { success: true },
      subscribeIRData: () => ({ success: false, message: "topic busy" }),
    });

    const p = learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "K",
      irType: 1,
      companyID: COMPANY_ID,
      timeoutMs: 100,
    });

    await expect(p).rejects.toThrow(/subscribeIRData failed/);

    // REGISTER と subscribeIRData の 2 op。CONTROL 復帰は走らない。
    const ops = client.requests.map((f) => f.op);
    expect(ops).toEqual(["setIRMode", "subscribeIRData"]);
  });

  it("addIRCode が失敗すると例外。ただし mode は CONTROL に戻り、unsubscribe も完了している (finally 経由)", async () => {
    client = makeClient({
      setIRMode: { success: true },
      subscribeIRData: { success: true },
      addIRCode: () => ({ success: false, message: "quota exceeded" }),
    });

    const onPrompt = () => scheduleEmit(client, RSP_TOPIC, rsp(DEVICE_ID, "11"));

    const p = learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "K",
      irType: 1,
      companyID: COMPANY_ID,
      timeoutMs: 200,
      onPrompt,
    });

    await expect(p).rejects.toThrow(/addIRCode failed/);

    const ops = client.requests.map((f) => f.op);
    // setIRMode(REGISTER) → subscribe → setIRMode(CONTROL) → addIRCode の 4 op
    expect(ops).toEqual(["setIRMode", "subscribeIRData", "setIRMode", "addIRCode"]);
    expect(client.requests[2].mode).toBe(MODE.CONTROL);
    expect(client.sends.some((f) => f.op === "unsubscribeIRData")).toBe(true);
  });

  it("finally 内の setIRMode(CONTROL) 自体が失敗しても、captured 後なら addIRCode に進み正常終了する (best-effort)", async () => {
    let modeCallCount = 0;
    client = makeClient({
      setIRMode: (frame) => {
        modeCallCount++;
        if (frame.mode === MODE.CONTROL) {
          // best-effort で握りつぶされるはず
          return { success: false, message: "control restore failed" };
        }
        return { success: true };
      },
      subscribeIRData: { success: true },
      addIRCode: { success: true, data: { keyUUID: "k-ok" } },
    });

    const onPrompt = () => scheduleEmit(client, RSP_TOPIC, rsp(DEVICE_ID, "22"));

    const result = await learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "K",
      irType: 1,
      companyID: COMPANY_ID,
      timeoutMs: 200,
      onPrompt,
    });

    expect(result.saved).toEqual({ keyUUID: "k-ok" });
    expect(result.captured).toBe("22");
    expect(modeCallCount).toBe(2);
  });

  it("他デバイス向けの subscribeIRDataRsp は無視され、timeout する", async () => {
    const onPrompt = () => {
      // 別デバイスからの emit
      client.emit(RSP_TOPIC, rsp("other-device", "FF"));
    };

    const p = learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "K",
      irType: 1,
      companyID: COMPANY_ID,
      timeoutMs: 30,
      onPrompt,
    });

    await expect(p).rejects.toThrow(/learn timeout/);
  });

  it("波形は msg.data.data から取り出される (トップレベル data 直下ではない)", async () => {
    const onPrompt = () => {
      // biz3: 生波形は response.data.data に入る。msg.data.data を captured/irCode.data にする。
      scheduleEmit(client, RSP_TOPIC, {
        deviceId: DEVICE_ID,
        data: { data: "C0FFEE", extra: "ignored" },
      });
    };

    const result = await learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "K",
      irType: 1,
      companyID: COMPANY_ID,
      timeoutMs: 200,
      onPrompt,
    });

    // captured は msg.data.data そのもの (msg や msg.data ではない)
    expect(result.captured).toBe("C0FFEE");
    const addFrame = client.requests.find((f) => f.op === "addIRCode");
    expect(addFrame.irCode.data).toBe("C0FFEE");
  });

  it("msg.data.data が無い場合は captured / irCode.data が undefined になる", async () => {
    const onPrompt = () => {
      // data フィールド無し → msg.data.data は undefined
      scheduleEmit(client, RSP_TOPIC, { deviceId: DEVICE_ID });
    };

    const result = await learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "K",
      irType: 1,
      companyID: COMPANY_ID,
      timeoutMs: 200,
      onPrompt,
    });

    expect(result.captured).toBeUndefined();
    const addFrame = client.requests.find((f) => f.op === "addIRCode");
    expect(addFrame.irCode.data).toBeUndefined();
    // 旧仕様の irWaveLength 概念は無い
    expect(addFrame.irCode).not.toHaveProperty("irWaveLength");
  });

  it("複数の subscribeIRDataRsp が連続して来ても、最初の 1 個だけが captured になる", async () => {
    const onPrompt = () => {
      // 連続 2 個 (どちらも非同期 emit)。最初の resolve のみ採用される。
      setTimeout(() => {
        client.emit(RSP_TOPIC, rsp(DEVICE_ID, "FIRST"));
        client.emit(RSP_TOPIC, rsp(DEVICE_ID, "SECOND"));
      }, 1);
    };

    const result = await learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "K",
      irType: 1,
      companyID: COMPANY_ID,
      timeoutMs: 200,
      onPrompt,
    });

    // Promise は 1 回 resolve したらそれ以降の resolve は noop なので、最初の値が勝つ
    expect(result.captured).toBe("FIRST");
    const addFrame = client.requests.find((f) => f.op === "addIRCode");
    expect(addFrame.irCode.data).toBe("FIRST");
  });

  it("client.send (unsubscribeIRData) が throw しても learnIRKey 自体は成功する (try/catch で握りつぶす)", async () => {
    client = makeClient(defaultResponses());
    // send を throw に差し替え
    client.send = vi.fn(() => {
      throw new Error("ws closed");
    });

    const onPrompt = () => scheduleEmit(client, RSP_TOPIC, rsp(DEVICE_ID, "AA"));

    const result = await learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "K",
      irType: 1,
      companyID: COMPANY_ID,
      timeoutMs: 200,
      onPrompt,
    });

    expect(result.captured).toBe("AA");
    expect(client.send).toHaveBeenCalled();
  });

  it("companyID / deviceId / keyName / remoteId がすべてのフレームに正しく載る", async () => {
    const onPrompt = () => scheduleEmit(client, RSP_TOPIC, rsp(DEVICE_ID, "AB"));

    await learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "Mute",
      irType: 42,
      companyID: COMPANY_ID,
      timeoutMs: 200,
      onPrompt,
    });

    for (const f of client.requests) {
      expect(f.companyID).toBe(COMPANY_ID);
    }
    // setIRMode フレームは deviceId
    expect(client.requests[0].deviceId).toBe(DEVICE_ID);
    expect(client.requests[2].deviceId).toBe(DEVICE_ID);
    // subscribe フレームは deviceId
    expect(client.requests[1]).toMatchObject({
      op: "subscribeIRData",
      deviceId: DEVICE_ID,
      topic: `hub3/${DEVICE_ID}/ir/learned/data`,
    });
    // addIRCode の irCode (biz3 公式フィールド)
    expect(client.requests[3].irCode).toMatchObject({
      deviceId: DEVICE_ID,
      uuid: REMOTE_ID,
      name: "Mute",
    });
    // unsubscribeIRData の send
    const unsub = client.sends.find((f) => f.op === "unsubscribeIRData");
    expect(unsub).toMatchObject({
      deviceId: DEVICE_ID,
      companyID: COMPANY_ID,
      topic: `hub3/${DEVICE_ID}/ir/learned/data`,
    });
  });
});
