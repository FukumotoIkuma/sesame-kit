// Unit tests for subscribeIRData / subscribeIRMode (P5-6)
//
// 両関数は makeIrSubscription (ir.js 内 private) に共通化された。
// ここではファクトリ経由の挙動が subscribeIRData/subscribeIRMode 双方で
// 正しく動くことを確認する。
//
// 検証するポイント:
//   - ack 成功時に onData/unsubscribe を持つオブジェクトを返す
//   - ack 失敗時に rejected エラーを投げる
//   - onData コールバックが push イベントで呼ばれる
//   - 他デバイス向け push は無視される
//   - unsubscribe() が unsub + send(unsubOp) を発火する
//   - send が throw しても unsubscribe 自体はエラーを外に伝播しない
//   - subscribeIRData と subscribeIRMode で op / topic / rspKey が正しく使い分けられる

import { describe, it, expect, vi, beforeEach } from "vitest";
import { subscribeIRData, subscribeIRMode } from "../../src/ir.js";

const ACTION = "biz3IRRemote";
const DEVICE_ID = "hub3-dev-1";
const COMPANY_ID = "co-A";

function makeClient(responses = {}) {
  const requests = [];
  const sends = [];
  const subscriptions = new Map();

  const client = {
    requests,
    sends,
    subscriptions,
    request: vi.fn(async (frame, _timeout) => {
      requests.push(frame);
      const handler = responses[frame.op];
      if (!handler) return { success: true };
      return typeof handler === "function" ? handler(frame) : handler;
    }),
    send: vi.fn((frame) => { sends.push(frame); }),
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

// ---------- subscribeIRData ----------

describe("subscribeIRData", () => {
  let client;

  beforeEach(() => {
    client = makeClient({ subscribeIRData: { success: true } });
  });

  it("ack 成功: subscribeIRData op を送り onData/unsubscribe を返す", async () => {
    const sub = await subscribeIRData(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID });

    expect(sub).toHaveProperty("onData");
    expect(sub).toHaveProperty("unsubscribe");

    const req = client.requests[0];
    expect(req).toMatchObject({
      action: ACTION,
      op: "subscribeIRData",
      topic: `hub3/${DEVICE_ID}/ir/learned/data`,
      deviceId: DEVICE_ID,
      companyID: COMPANY_ID,
    });
  });

  it("ack 失敗: rejected エラーを投げる", async () => {
    client = makeClient({ subscribeIRData: { success: false, message: "overload" } });
    await expect(subscribeIRData(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID }))
      .rejects.toThrow(/subscribeIRData failed.*overload/);
  });

  it("onData コールバックが subscribeIRDataRsp push で呼ばれる", async () => {
    const sub = await subscribeIRData(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID });
    const fn = vi.fn();
    sub.onData(fn);

    const msg = { deviceId: DEVICE_ID, data: { data: "AABB" } };
    client.emit(`${ACTION}:subscribeIRDataRsp`, msg);

    expect(fn).toHaveBeenCalledWith(msg);
  });

  it("他デバイスへの push は無視される", async () => {
    const sub = await subscribeIRData(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID });
    const fn = vi.fn();
    sub.onData(fn);

    client.emit(`${ACTION}:subscribeIRDataRsp`, { deviceId: "other-device", data: {} });
    expect(fn).not.toHaveBeenCalled();
  });

  it("unsubscribe() は unsub と unsubscribeIRData の send を実行する", async () => {
    const sub = await subscribeIRData(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID });
    sub.unsubscribe();

    const unsub = client.sends.find((f) => f.op === "unsubscribeIRData");
    expect(unsub).toMatchObject({
      action: ACTION,
      op: "unsubscribeIRData",
      topic: `hub3/${DEVICE_ID}/ir/learned/data`,
      deviceId: DEVICE_ID,
      companyID: COMPANY_ID,
    });
  });

  it("unsubscribe() 後は onData コールバックが呼ばれない (listeners.clear)", async () => {
    const sub = await subscribeIRData(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID });
    const fn = vi.fn();
    sub.onData(fn);
    sub.unsubscribe();

    client.emit(`${ACTION}:subscribeIRDataRsp`, { deviceId: DEVICE_ID, data: {} });
    expect(fn).not.toHaveBeenCalled();
  });

  it("send が throw しても unsubscribe 自体はエラーを伝播しない", async () => {
    const sub = await subscribeIRData(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID });
    client.send = vi.fn(() => { throw new Error("ws closed"); });

    expect(() => sub.unsubscribe()).not.toThrow();
  });
});

// ---------- subscribeIRMode ----------

describe("subscribeIRMode", () => {
  let client;

  beforeEach(() => {
    client = makeClient({ subscribeIRMode: { success: true } });
  });

  it("ack 成功: subscribeIRMode op を送り onData/unsubscribe を返す", async () => {
    const sub = await subscribeIRMode(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID });

    expect(sub).toHaveProperty("onData");
    expect(sub).toHaveProperty("unsubscribe");

    const req = client.requests[0];
    expect(req).toMatchObject({
      action: ACTION,
      op: "subscribeIRMode",
      topic: `hub3/${DEVICE_ID}/ir/mode`,
      deviceId: DEVICE_ID,
      companyID: COMPANY_ID,
    });
  });

  it("ack 失敗: rejected エラーを投げる", async () => {
    client = makeClient({ subscribeIRMode: { success: false, message: "topic busy" } });
    await expect(subscribeIRMode(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID }))
      .rejects.toThrow(/subscribeIRMode failed.*topic busy/);
  });

  it("onData コールバックが subscribeIRModeRsp push で呼ばれる", async () => {
    const sub = await subscribeIRMode(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID });
    const fn = vi.fn();
    sub.onData(fn);

    const msg = { deviceId: DEVICE_ID, mode: 0 };
    client.emit(`${ACTION}:subscribeIRModeRsp`, msg);

    expect(fn).toHaveBeenCalledWith(msg);
  });

  it("他デバイスへの push は無視される", async () => {
    const sub = await subscribeIRMode(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID });
    const fn = vi.fn();
    sub.onData(fn);

    client.emit(`${ACTION}:subscribeIRModeRsp`, { deviceId: "other-device", mode: 1 });
    expect(fn).not.toHaveBeenCalled();
  });

  it("unsubscribe() は unsub と unsubscribeIRMode の send を実行する", async () => {
    const sub = await subscribeIRMode(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID });
    sub.unsubscribe();

    const unsub = client.sends.find((f) => f.op === "unsubscribeIRMode");
    expect(unsub).toMatchObject({
      action: ACTION,
      op: "unsubscribeIRMode",
      topic: `hub3/${DEVICE_ID}/ir/mode`,
      deviceId: DEVICE_ID,
      companyID: COMPANY_ID,
    });
  });

  it("unsubscribe() 後は onData コールバックが呼ばれない (listeners.clear)", async () => {
    const sub = await subscribeIRMode(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID });
    const fn = vi.fn();
    sub.onData(fn);
    sub.unsubscribe();

    client.emit(`${ACTION}:subscribeIRModeRsp`, { deviceId: DEVICE_ID, mode: 0 });
    expect(fn).not.toHaveBeenCalled();
  });

  it("send が throw しても unsubscribe 自体はエラーを伝播しない", async () => {
    const sub = await subscribeIRMode(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID });
    client.send = vi.fn(() => { throw new Error("ws closed"); });

    expect(() => sub.unsubscribe()).not.toThrow();
  });

  it("subscribeIRData と subscribeIRMode は互いの push トピックを汚染しない", async () => {
    const clientBoth = makeClient({
      subscribeIRData: { success: true },
      subscribeIRMode: { success: true },
    });

    const dataSub = await subscribeIRData(clientBoth, { deviceId: DEVICE_ID, companyID: COMPANY_ID });
    const modeSub = await subscribeIRMode(clientBoth, { deviceId: DEVICE_ID, companyID: COMPANY_ID });

    const dataFn = vi.fn();
    const modeFn = vi.fn();
    dataSub.onData(dataFn);
    modeSub.onData(modeFn);

    // subscribeIRDataRsp は dataFn のみ呼ぶ
    clientBoth.emit(`${ACTION}:subscribeIRDataRsp`, { deviceId: DEVICE_ID });
    expect(dataFn).toHaveBeenCalledTimes(1);
    expect(modeFn).toHaveBeenCalledTimes(0);

    // subscribeIRModeRsp は modeFn のみ呼ぶ
    clientBoth.emit(`${ACTION}:subscribeIRModeRsp`, { deviceId: DEVICE_ID });
    expect(dataFn).toHaveBeenCalledTimes(1);
    expect(modeFn).toHaveBeenCalledTimes(1);
  });
});
