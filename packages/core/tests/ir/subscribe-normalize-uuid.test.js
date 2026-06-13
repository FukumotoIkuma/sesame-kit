// P3-5: subscribeIRData / subscribeIRMode の deviceId フィルタが normalizeUuid 同士比較に
// なったことを検証するテスト。
//
// 参照: references_web/src/api/useRemoteCtrl.js:306-333 (vendor はフィルタなし全配布)。
// 本実装は多デバイス購読の利便として独自フィルタを維持するが、大文字小文字・ハイフン差を
// normalizeUuid で吸収する (P3-5 修正)。
//
// モック由来: subscribeIRData/subscribeIRMode の ack フレームは
//   references_web/src/api/useRemoteCtrl.js:698-717 / 666-684 の request/response 相当。
//   push (subscribeIRDataRsp / subscribeIRModeRsp) の deviceId フィールドは
//   サーバが返す WS メッセージのトップレベルキー (vendor: irDataSubscriptions.forEach で
//   msg 全体を渡す。useRemoteCtrl.js:322-332)。

import { describe, it, expect, vi } from "vitest";
import { subscribeIRData, subscribeIRMode } from "../../src/ir.js";

const ACTION = "biz3IRRemote";

function makeClient() {
  const subscriptions = new Map();
  return {
    async request(_frame) { return { success: true }; },
    send: vi.fn(),
    subscribe: vi.fn((key, fn) => {
      if (!subscriptions.has(key)) subscriptions.set(key, new Set());
      subscriptions.get(key).add(fn);
      return () => subscriptions.get(key)?.delete(fn);
    }),
    emit(key, msg) {
      const s = subscriptions.get(key);
      if (s) for (const fn of s) fn(msg);
    },
  };
}

describe("P3-5: subscribeIRData deviceId フィルタ — normalizeUuid 比較", () => {
  it("登録は小文字 UUID、push は大文字 UUID → onData が発火する", async () => {
    const client = makeClient();
    const DEVICE_ID = "aabbccdd-eeff-0011-2233-445566778899"; // 小文字ハイフン付き
    const sub = await subscribeIRData(client, { deviceId: DEVICE_ID, companyID: "co-A" });
    const fn = vi.fn();
    sub.onData(fn);

    // サーバが大文字で返す (P3-5 で修正前は無視されていた)
    client.emit(`${ACTION}:subscribeIRDataRsp`, {
      deviceId: "AABBCCDD-EEFF-0011-2233-445566778899",
      data: { data: "CAFE" },
    });

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("登録は大文字 UUID、push は小文字 UUID → onData が発火する", async () => {
    const client = makeClient();
    const DEVICE_ID = "AABBCCDD-EEFF-0011-2233-445566778899";
    const sub = await subscribeIRData(client, { deviceId: DEVICE_ID, companyID: "co-A" });
    const fn = vi.fn();
    sub.onData(fn);

    client.emit(`${ACTION}:subscribeIRDataRsp`, {
      deviceId: "aabbccdd-eeff-0011-2233-445566778899",
      data: { data: "CAFE" },
    });

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("ハイフン有無の差異を吸収する (push が 32hex ノーハイフン形式)", async () => {
    const client = makeClient();
    const DEVICE_ID = "aabbccdd-eeff-0011-2233-445566778899";
    const sub = await subscribeIRData(client, { deviceId: DEVICE_ID, companyID: "co-A" });
    const fn = vi.fn();
    sub.onData(fn);

    // ハイフン無し大文字 32hex
    client.emit(`${ACTION}:subscribeIRDataRsp`, {
      deviceId: "AABBCCDDEEFF00112233445566778899",
      data: { data: "BEEF" },
    });

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("異なるデバイスへの push は引き続き無視される", async () => {
    const client = makeClient();
    const sub = await subscribeIRData(client, { deviceId: "dev-A", companyID: "co-A" });
    const fn = vi.fn();
    sub.onData(fn);

    client.emit(`${ACTION}:subscribeIRDataRsp`, {
      deviceId: "totally-different-device",
      data: { data: "DEAD" },
    });

    expect(fn).not.toHaveBeenCalled();
  });

  it("deviceId なし push は全リスナーに届く (参照挙動との整合)", async () => {
    const client = makeClient();
    const sub = await subscribeIRData(client, { deviceId: "dev-A", companyID: "co-A" });
    const fn = vi.fn();
    sub.onData(fn);

    // msg.deviceId が falsy なら無視せず全配布 (参照: vendor も全配布)
    client.emit(`${ACTION}:subscribeIRDataRsp`, { data: { data: "DEAD" } });

    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("P3-5: subscribeIRMode deviceId フィルタ — normalizeUuid 比較", () => {
  it("大文字小文字が混在していても onData が発火する", async () => {
    const client = makeClient();
    const DEVICE_ID = "aabbccdd-0000-0000-0000-000000000001";
    const sub = await subscribeIRMode(client, { deviceId: DEVICE_ID, companyID: "co-A" });
    const fn = vi.fn();
    sub.onData(fn);

    client.emit(`${ACTION}:subscribeIRModeRsp`, {
      deviceId: "AABBCCDD-0000-0000-0000-000000000001",
      mode: 0,
    });

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("異なるデバイスへの push は無視される", async () => {
    const client = makeClient();
    const sub = await subscribeIRMode(client, { deviceId: "dev-X", companyID: "co-A" });
    const fn = vi.fn();
    sub.onData(fn);

    client.emit(`${ACTION}:subscribeIRModeRsp`, { deviceId: "dev-Y", mode: 1 });

    expect(fn).not.toHaveBeenCalled();
  });
});
