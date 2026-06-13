// P1-5: SesameHub3#deleteDevice — del フレームの items 形 (subUUID 同送) 検証。
//
// 参照 (items の正準形): references_web/src/components/MobileRemoveDevice.js:58-64
//   gManageDevice.removeSesameDevices([{ deviceUUID, subUUID }], ...)
//   → subUUID (操作者 UUID) を必ず同送する。
//   useManageDevice.js:228-237 は items を素通しして frame に乗せる。
//
// 戦略: fake WS client に hub._ws を直接注入。
//   - _subUUID を hub に注入して「接続済み + subUUID 取得済み」状態を再現。
//   - request() で送った frame をキャプチャし items 形を固定。
//   - _subUUID 未設定時に NOT_CONNECTED が throw されることを固定。

import { describe, it, expect, vi } from "vitest";
import { SesameHub3 } from "../../src/client.js";
import { ERR } from "../../src/errors.js";

const CO = "co-A";
const DEVICE_UUID = "device-uuid-123";
const SUB_UUID = "sub-uuid-abc";
const ACT = "biz3ManageDevice";

/**
 * 最小 fake WS client。request/send/subscribe/onMessage を実装。
 * deleteDevices は client.request() を 1 回呼ぶため、request mock のみで十分。
 */
function makeFakeWs(response = { action: ACT, op: "del", success: true }) {
  const requests = [];
  return {
    requests,
    request: vi.fn(async (frame, _timeoutMs) => {
      requests.push(frame);
      return response;
    }),
    send: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    onMessage: vi.fn(() => () => {}),
  };
}

/** 接続済み + subUUID 取得済みの SesameHub3 (fake ws 注入)。実 fs / 実 WS に触らない。 */
function makeHub(ws, { subUUID = SUB_UUID } = {}) {
  const hub = new SesameHub3({
    config: { companyID: CO },
    tokenStore: { load: () => ({}), save: () => {}, clear: () => {} },
  });
  // connect() をスキップして接続済み状態を再現 (tests/client の他テストと同じ手法)。
  hub._ws = ws;
  hub._subUUID = subUUID;
  return hub;
}

describe("P1-5: SesameHub3#deleteDevice — del フレームの items 形", () => {
  it("items に { deviceUUID, subUUID } が乗った frame を送る (MobileRemoveDevice.js:58-64)", async () => {
    const ws = makeFakeWs();
    const hub = makeHub(ws);
    await hub.deleteDevice(DEVICE_UUID);
    expect(ws.requests).toHaveLength(1);
    const frame = ws.requests[0];
    // frame 1:1 (useManageDevice.js:232):
    //   { action: ACT_MANAGE, op: 'del', companyID, items }
    expect(frame.action).toBe(ACT);
    expect(frame.op).toBe("del");
    expect(frame.companyID).toBe(CO);
    // items の要素は { deviceUUID, subUUID } (MobileRemoveDevice.js:59-63)
    expect(frame.items).toEqual([{ deviceUUID: DEVICE_UUID, subUUID: SUB_UUID }]);
  });

  it("subUUID が hub の _subUUID から自動注入される", async () => {
    const ws = makeFakeWs();
    const hub = makeHub(ws, { subUUID: "other-sub-uuid" });
    await hub.deleteDevice(DEVICE_UUID);
    expect(ws.requests[0].items[0].subUUID).toBe("other-sub-uuid");
  });

  it("success:false 応答は SesameError(REJECTED) で reject する", async () => {
    const ws = makeFakeWs({ action: ACT, op: "del", success: false, message: "not found" });
    const hub = makeHub(ws);
    await expect(hub.deleteDevice(DEVICE_UUID)).rejects.toMatchObject({ code: ERR.REJECTED });
  });
});

describe("P1-5: SesameHub3#deleteDevice — subUUID 未取得時の NOT_CONNECTED guard", () => {
  it("_subUUID が null の場合 NOT_CONNECTED を throw し、frame は送らない (renameDevice と同形)", async () => {
    const ws = makeFakeWs();
    const hub = makeHub(ws, { subUUID: null });
    // _subUUID 未取得 = 未接続相当
    hub._subUUID = null;
    await expect(hub.deleteDevice(DEVICE_UUID)).rejects.toMatchObject({ code: ERR.NOT_CONNECTED });
    expect(ws.requests).toHaveLength(0); // frame 未送信
  });

  it("NOT_CONNECTED は retryable フラグを持つ", async () => {
    const ws = makeFakeWs();
    const hub = makeHub(ws, { subUUID: null });
    hub._subUUID = null;
    await expect(hub.deleteDevice(DEVICE_UUID)).rejects.toMatchObject({ retryable: true });
  });

  it("_ws が null (未接続) なら _ensureConnected が先に NOT_CONNECTED を throw する", async () => {
    const hub = new SesameHub3({
      config: { companyID: CO },
      tokenStore: { load: () => ({}), save: () => {}, clear: () => {} },
    });
    // _ws = null のまま (connect() 未呼び出し)
    await expect(hub.deleteDevice(DEVICE_UUID)).rejects.toMatchObject({ code: ERR.NOT_CONNECTED });
  });
});
