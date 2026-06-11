// P3-1 / P3-5 / P3-7 / P3-9 / P3-18: devices.js の biz3ManageDevice 残り op + ページング +
// エラーフレーム検知 + strict 緩和の単体テスト。
//
// frame fixture の導出元 (vendor の送信側コード):
//   - add:            useManageDevice.js:256-268 ({action, op:'add', items, companyID})
//   - reorderDevices: useManageDevice.js:270-285 (item.rank = 0 - index を採番して送る)
//   - notifyList:     useManageDevice.js:287-302 ({action, companyID, pushToken, items, op})
//   - notifyManage:   useManageDevice.js:304-320 ({action, companyID, enablePush, deviceUUID, pushToken, op})
//   - switchRecharge: useManageDevice.js:360-372 ({action, deviceUUID, isRechargeBattery:1|0, op}; companyID 無し)
//   - "Limit Exceeded": useManageDevice.js:28-30 (success:false 応答の message)
//   - fetchAllHistory: DeviceHistory.js:37-74 (res.length===pageSize で継続、lastKey=末尾 timestamp)
//   - pubUserDeviceChange: useIotCtrl.js:12,23-25 (biz3TriggerLocker action の push)
//   - battery/webapi の success 無視: MobileBatteryChart.js:39-50 / useDeveloper.js:18-31

import { describe, it, expect, vi } from "vitest";
import {
  addDevices, reorderDevices, getNotifyStatus, switchNotify, switchRechargeableBattery,
  getAllDeviceHistory, getBatteryRecord, invokeWebAPI, getUserDevices, subscribeUserDeviceChange,
} from "../../src/devices.js";
import { ERR } from "../../src/errors.js";

const ACT = "biz3ManageDevice";
const CO = "co-A";

/** 1 回の request に固定応答 (または応答列) を返す最小 mock client。 */
function makeClient(responses) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const requests = [];
  return {
    requests,
    request: vi.fn(async (frame, _timeoutMs) => {
      requests.push(frame);
      return queue.length > 1 ? queue.shift() : queue[0];
    }),
  };
}

describe("P3-1: addDevices", () => {
  it("frame 1:1 (useManageDevice.js:258-263): {action, op:'add', items, companyID}", async () => {
    const items = [{ deviceUUID: "d-1", secretKey: "s", deviceModel: "sesame_5" }];
    const client = makeClient({ action: ACT, op: "add", success: true });
    await addDevices(client, { companyID: CO, items });
    expect(client.requests[0]).toEqual({ action: ACT, op: "add", items, companyID: CO });
  });

  it("'Limit Exceeded' (success:false) はそのまま伝搬する (useManageDevice.js:28-30)", async () => {
    const client = makeClient({ action: ACT, op: "add", success: false, message: "Limit Exceeded" });
    await expect(addDevices(client, { companyID: CO, items: [{ deviceUUID: "d-1" }] }))
      .rejects.toMatchObject({ name: "SesameError", code: ERR.REJECTED });
    await expect(addDevices(client, { companyID: CO, items: [{ deviceUUID: "d-1" }] }))
      .rejects.toThrow(/Limit Exceeded/);
  });

  it("items が配列でなければ bad_request (送信前)", async () => {
    const client = makeClient({ success: true });
    await expect(addDevices(client, { companyID: CO, items: "x" }))
      .rejects.toMatchObject({ code: ERR.BAD_REQUEST });
    expect(client.requests).toHaveLength(0);
  });
});

describe("P3-1: reorderDevices", () => {
  it("rank = 0 - index を採番して送る (useManageDevice.js:272-274)", async () => {
    const items = [{ deviceUUID: "a" }, { deviceUUID: "b" }, { deviceUUID: "c" }];
    const client = makeClient({ action: ACT, op: "reorderDevices", success: true, data: ["sorted"] });
    const data = await reorderDevices(client, { companyID: CO, items });
    const f = client.requests[0];
    expect(f.action).toBe(ACT);
    expect(f.op).toBe("reorderDevices");
    expect(f.companyID).toBe(CO);
    expect(f.items).toEqual([
      { deviceUUID: "a", rank: 0 },
      { deviceUUID: "b", rank: -1 },
      { deviceUUID: "c", rank: -2 },
    ]);
    // 応答 data は並び替え後の一覧 (useManageDevice.js:80-81)
    expect(data).toEqual(["sorted"]);
  });

  it("呼び出し側の items を破壊しない (rank はコピーに付与)", async () => {
    const items = [{ deviceUUID: "a" }];
    const client = makeClient({ success: true, data: [] });
    await reorderDevices(client, { companyID: CO, items });
    expect(items[0]).toEqual({ deviceUUID: "a" }); // rank が混入しない
  });
});

describe("P3-1: getNotifyStatus / switchNotify / switchRechargeableBattery", () => {
  it("notifyList frame 1:1 (useManageDevice.js:291-297)", async () => {
    const items = [{ deviceUUID: "d-1", deviceModel: "sesame_5" }];
    const client = makeClient({ success: true, data: [{ deviceUUID: "d-1", enablePush: 1 }] });
    const data = await getNotifyStatus(client, { companyID: CO, pushToken: "tok-1", items });
    expect(client.requests[0]).toEqual({ action: ACT, companyID: CO, pushToken: "tok-1", items, op: "notifyList" });
    expect(data).toEqual([{ deviceUUID: "d-1", enablePush: 1 }]);
  });

  it("notifyManage frame 1:1 (useManageDevice.js:308-315)。boolean は 1/0 へ正規化", async () => {
    const client = makeClient({ success: true });
    await switchNotify(client, { companyID: CO, pushToken: "tok-1", deviceUUID: "d-1", enablePush: true });
    expect(client.requests[0]).toEqual({
      action: ACT, companyID: CO, enablePush: 1, deviceUUID: "d-1", pushToken: "tok-1", op: "notifyManage",
    });
    await switchNotify(client, { companyID: CO, pushToken: "tok-1", deviceUUID: "d-1", enablePush: 0 });
    expect(client.requests[1].enablePush).toBe(0);
  });

  it("switchRecharge frame 1:1 (useManageDevice.js:362-367)。companyID は乗らない", async () => {
    const client = makeClient({ success: true });
    await switchRechargeableBattery(client, { deviceUUID: "d-1", isRechargeBattery: true });
    expect(client.requests[0]).toEqual({ action: ACT, deviceUUID: "d-1", isRechargeBattery: 1, op: "switchRecharge" });
    expect(client.requests[0]).not.toHaveProperty("companyID");
    await switchRechargeableBattery(client, { deviceUUID: "d-1", isRechargeBattery: false });
    expect(client.requests[1].isRechargeBattery).toBe(0);
  });
});

describe("P3-7: getAllDeviceHistory (vendor fetchAllHistory 相当)", () => {
  /** pageSize 件の履歴ページを作る (timestamp 降順相当のダミー)。 */
  const page = (startTs, n) => Array.from({ length: n }, (_, i) => ({ timestamp: startTs - i, type: 1 }));

  it("res.length===pageSize の間継続し、lastKey に末尾 timestamp を渡す (DeviceHistory.js:56-70)", async () => {
    const p1 = page(1000, 3);
    const p2 = page(900, 3);
    const p3 = page(800, 2); // 満たない → 終端
    const client = makeClient([
      { success: true, data: p1 },
      { success: true, data: p2 },
      { success: true, data: p3 },
    ]);
    const all = await getAllDeviceHistory(client, { companyID: CO, deviceUUID: "d-1", pageSize: 3 });
    expect(all).toEqual([...p1, ...p2, ...p3]);
    expect(client.requests).toHaveLength(3);
    // 初回 lastKey=null、以降は直前ページ末尾の timestamp
    expect(client.requests[0].list).toEqual([{ deviceUUID: "d-1", lastKey: null }]);
    expect(client.requests[1].list).toEqual([{ deviceUUID: "d-1", lastKey: 998 }]);
    expect(client.requests[2].list).toEqual([{ deviceUUID: "d-1", lastKey: 898 }]);
    expect(client.requests[0].pageSize).toBe(3);
  });

  it("最初のページが空なら 1 回で終わる", async () => {
    const client = makeClient({ success: true, data: [] });
    const all = await getAllDeviceHistory(client, { companyID: CO, deviceUUID: "d-1", pageSize: 3 });
    expect(all).toEqual([]);
    expect(client.requests).toHaveLength(1);
  });

  it("maxPages を超えたら打ち切る (安全弁)", async () => {
    const client = makeClient({ success: true, data: page(1000, 2) }); // 常に満杯
    const all = await getAllDeviceHistory(client, { companyID: CO, deviceUUID: "d-1", pageSize: 2, maxPages: 4 });
    expect(client.requests).toHaveLength(4);
    expect(all).toHaveLength(8);
  });
});

describe("P3-18: battery / webapi の strict 緩和 (success===false のみ拒否)", () => {
  it("getBatteryRecord は success 欠落でも data を返す (MobileBatteryChart.js:39-50 は success を見ない)", async () => {
    const data = { records: [{ ts: 1 }], lastEvaluatedKey: null };
    const client = makeClient({ action: "biz3GetDeviceBatteryRecord", op: "batch-get", data }); // success 無し
    await expect(getBatteryRecord(client, { deviceUUID: "d-1" })).resolves.toEqual(data);
  });

  it("getBatteryRecord は success:false なら reject", async () => {
    const client = makeClient({ success: false, message: "boom" });
    await expect(getBatteryRecord(client, { deviceUUID: "d-1" }))
      .rejects.toMatchObject({ code: ERR.REJECTED });
  });

  it("invokeWebAPI は success 欠落でも data を返す (useDeveloper.js:18-31 は success を見ない)", async () => {
    const client = makeClient({ action: "biz3InvokeWebAPIs", op: "webapi_history_get", data: { histories: [] } });
    await expect(invokeWebAPI(client, { func: "webapi_history_get", apiKeyId: "k" }))
      .resolves.toEqual({ histories: [] });
  });

  it("invokeWebAPI は success:false なら reject", async () => {
    const client = makeClient({ success: false, message: "no api key" });
    await expect(invokeWebAPI(client, { func: "webapi_history_get", apiKeyId: "k" }))
      .rejects.toMatchObject({ code: ERR.REJECTED });
  });
});

describe("P3-9: getUserDevices の同 action エラーフレーム検知 (errorAction)", () => {
  /** subscribe + onMessage を備えた push 系 mock client。 */
  function makePushClient() {
    const subs = new Map();
    const listeners = new Set();
    const sent = [];
    return {
      sent,
      send: (f) => sent.push(f),
      subscribe(key, fn) {
        if (!subs.has(key)) subs.set(key, new Set());
        subs.get(key).add(fn);
        return () => subs.get(key)?.delete(fn);
      },
      onMessage(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      emit(key, msg) {
        for (const fn of [...(subs.get(key) ?? [])]) fn(msg);
        for (const fn of [...listeners]) fn(msg);
      },
      emitRaw(msg) { for (const fn of [...listeners]) fn(msg); },
    };
  }

  it("同 action の success:false フレームで timeout を待たず reject (useManageDevice.js:27-34)", async () => {
    const client = makePushClient();
    const p = getUserDevices(client, { timeoutMs: 5000 });
    // サーバの即時エラーは push op ではなく要求 op (getUserDevice) で返る
    client.emitRaw({ action: ACT, op: "getUserDevice", success: false, message: "Limit Exceeded" });
    await expect(p).rejects.toThrow(/Limit Exceeded/);
  });

  it("別 action の success:false は無視され、正常 push で完了する", async () => {
    const client = makePushClient();
    const p = getUserDevices(client, { timeoutMs: 5000 });
    client.emitRaw({ action: "biz3IRRemote", op: "x", success: false, message: "unrelated" });
    client.emit(`${ACT}:PubedUserDevice`, {
      action: ACT, op: "PubedUserDevice", success: true,
      data: { totalPage: 1, data: { list: [{ deviceUUID: "d-1" }], page: 1 } },
    });
    await expect(p).resolves.toEqual([{ deviceUUID: "d-1" }]);
  });
});

describe("P3-5: subscribeUserDeviceChange", () => {
  it("biz3TriggerLocker:pubUserDeviceChange を購読し、push を onChange へ流す (useIotCtrl.js:12,23-25)", () => {
    const subs = new Map();
    const client = {
      subscribe(key, fn) {
        if (!subs.has(key)) subs.set(key, new Set());
        subs.get(key).add(fn);
        return () => subs.get(key)?.delete(fn);
      },
    };
    const seen = [];
    const off = subscribeUserDeviceChange(client, { onChange: (m) => seen.push(m) });
    expect(subs.has("biz3TriggerLocker:pubUserDeviceChange")).toBe(true);
    const msg = { action: "biz3TriggerLocker", op: "pubUserDeviceChange" };
    for (const fn of subs.get("biz3TriggerLocker:pubUserDeviceChange")) fn(msg);
    expect(seen).toEqual([msg]);
    off();
    expect(subs.get("biz3TriggerLocker:pubUserDeviceChange").size).toBe(0);
  });

  it("onChange の throw は購読を壊さない", () => {
    const subs = new Set();
    const client = { subscribe: (_k, fn) => { subs.add(fn); return () => subs.delete(fn); } };
    subscribeUserDeviceChange(client, { onChange: () => { throw new Error("boom"); } });
    expect(() => { for (const fn of subs) fn({}); }).not.toThrow();
  });
});
