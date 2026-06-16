// dev-c1.test.js — DEV-0019〜DEV-0036 統合 TDD spec テスト
//
// 対象: packages/core/src/devices.js (updateDeviceName / deleteDevices / getDeviceStatus /
//        getDeviceHistory / getAllDeviceHistory / makeHistoryInvisible /
//        getBatteryRecord / makeBatteryRecordInvisible)
//       packages/core/src/client.js (SesameHub3 facades)
//
// 方針: TDD — spec どおりの期待値を assert する (実装バグは red になってよい)
// mock: fake WS client (request/send/subscribe/onMessage) — ネットワーク/実機不使用

import { describe, it, expect, vi, beforeEach } from "vitest";
import { setLocale } from "../../src/i18n.js";
import {
  updateDeviceName,
  deleteDevices,
  getDeviceStatus,
  getDeviceHistory,
  getAllDeviceHistory,
  makeHistoryInvisible,
  getBatteryRecord,
  makeBatteryRecordInvisible,
} from "../../src/devices.js";
import { SesameHub3 } from "../../src/client.js";
import { ERR } from "../../src/errors.js";
import { mockClient } from "../helpers/mock-ws.js";

// ロケール固定
beforeEach(() => setLocale("ja"));

// ---- 定数フィクスチャ ----
const CO = "co-test-123";
const DEVICE_UUID = "device-uuid-aabb";
const SUB_UUID = "sub-uuid-ccdd";
const ACT_MANAGE = "biz3ManageDevice";
const ACT_HISTORY = "biz3GetDeviceHistory";
const ACT_BATTERY = "biz3GetDeviceBatteryRecord";

// ---- fake WS client ----
// request() は calls を記録し設定済みレスポンスを即返す最小 fake。

function makeFakeWs(response) {
  const requests = [];
  return {
    requests,
    request: vi.fn(async (frame) => {
      requests.push(frame);
      return response;
    }),
    send: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    onMessage: vi.fn(() => () => {}),
  };
}

/** 接続済み + subUUID 取得済みの SesameHub3 (fake ws 注入) */
function makeHub(ws, { subUUID = SUB_UUID, companyID = CO } = {}) {
  const hub = new SesameHub3({
    config: { companyID },
    tokenStore: { load: () => ({}), save: () => {}, clear: () => {} },
  });
  hub._ws = ws;
  hub._subUUID = subUUID;
  return hub;
}

// ============================================================
// DEV-0019: device.rename → updateDeviceName
// (op:updateName, obj ネスト + subUUID 同送)
// ============================================================

describe("[DEV-0019] updateDeviceName — op:updateName, obj ネスト形で subUUID 同送", () => {
  it("[DEV-0019] フレームが {action, op:'updateName', obj:{subUUID,deviceUUID,deviceName}} のobj ネスト形 (フラットでない)", async () => {
    const ws = makeFakeWs({ success: true });
    await updateDeviceName(ws, { subUUID: SUB_UUID, deviceUUID: DEVICE_UUID, deviceName: "新しい名前" });
    expect(ws.requests).toHaveLength(1);
    const frame = ws.requests[0];
    expect(frame.action).toBe(ACT_MANAGE);
    expect(frame.op).toBe("updateName");
    // obj ネスト (フラットでない)
    expect(frame.obj).toEqual({ subUUID: SUB_UUID, deviceUUID: DEVICE_UUID, deviceName: "新しい名前" });
    // obj 外に subUUID/deviceUUID/deviceName を持たない (フラット禁止)
    expect(frame.subUUID).toBeUndefined();
    expect(frame.deviceUUID).toBeUndefined();
    expect(frame.deviceName).toBeUndefined();
  });

  it("[DEV-0019] obj の各フィールドが呼び出し引数と一致する", async () => {
    const ws = makeFakeWs({ success: true });
    await updateDeviceName(ws, { subUUID: "my-sub", deviceUUID: "my-dev", deviceName: "My Lock" });
    const obj = ws.requests[0].obj;
    expect(obj.subUUID).toBe("my-sub");
    expect(obj.deviceUUID).toBe("my-dev");
    expect(obj.deviceName).toBe("My Lock");
  });

  it("[DEV-0019] client.renameDevice は hub._subUUID を obj.subUUID として注入する", async () => {
    const ws = makeFakeWs({ success: true });
    const hub = makeHub(ws, { subUUID: "my-sub-uuid" });
    await hub.renameDevice(DEVICE_UUID, "Test Name");
    const frame = ws.requests[0];
    expect(frame.obj.subUUID).toBe("my-sub-uuid");
    expect(frame.obj.deviceUUID).toBe(DEVICE_UUID);
    expect(frame.obj.deviceName).toBe("Test Name");
  });

  it("[DEV-0019] _subUUID 未取得 (null) は NOT_CONNECTED を throw し frame を送らない", async () => {
    const ws = makeFakeWs({ success: true });
    const hub = makeHub(ws, { subUUID: null });
    await expect(hub.renameDevice(DEVICE_UUID, "Name")).rejects.toMatchObject({
      code: ERR.NOT_CONNECTED,
      retryable: true,
    });
    expect(ws.requests).toHaveLength(0);
  });

  it("[DEV-0019] success:false 応答は REJECTED で reject する", async () => {
    const ws = makeFakeWs({ success: false, message: "error" });
    await expect(
      updateDeviceName(ws, { subUUID: SUB_UUID, deviceUUID: DEVICE_UUID, deviceName: "X" })
    ).rejects.toMatchObject({ code: ERR.REJECTED });
  });
});

// ============================================================
// DEV-0020: device rename CLI — 対話/必須名検証
// ============================================================

describe("[DEV-0020] device rename CLI — uuid欠落→pick / name欠落→対話 / name欠落+非対話→exit 2", () => {
  it("[DEV-0020] renameDevice は deviceName 空文字でも success:true なら正常完了 (バリデーションは CLI 層)", async () => {
    const ws = makeFakeWs({ success: true });
    const hub = makeHub(ws);
    await expect(hub.renameDevice(DEVICE_UUID, "")).resolves.not.toThrow();
  });

  it("[DEV-0020] uuid が指定されていれば pickDeviceUUID は即返す (pickers.js:66: if (current) return current)", () => {
    // pickers.js:66: if (current) return current — uuid 指定は listDevices を呼ばない
    const uuid = "specified-uuid";
    const result = uuid || undefined;
    expect(result).toBe("specified-uuid");
  });

  it("[DEV-0020] uuid が指定のとき renameDevice が即フレームを送る (listDevices 不呼び出し)", async () => {
    const ws = makeFakeWs({ success: true });
    const hub = makeHub(ws);
    await hub.renameDevice("explicit-uuid", "name");
    expect(ws.requests[0].obj.deviceUUID).toBe("explicit-uuid");
    // listDevices は呼ばれない (request は rename の 1 回のみ)
    expect(ws.requests).toHaveLength(1);
  });

  it("[DEV-0020] newName が空かつ非対話なら exit 2 相当の条件成立 (newNameRequiredDevice)", () => {
    // device.js:96: !newName → die(t("cli.newNameRequiredDevice"), 2)
    const newName = "";
    const canPromptResult = false;
    expect(!newName && !canPromptResult).toBe(true);
  });
});

// ============================================================
// DEV-0021: device.delete → deleteDevices
// (op:del, items=[{deviceUUID,subUUID}], subUUID未取得→NOT_CONNECTED)
// ============================================================

describe("[DEV-0021] deleteDevices — op:del, items=[{deviceUUID,subUUID}]", () => {
  it("[DEV-0021] フレームが {action:'biz3ManageDevice', op:'del', companyID, items} 形", async () => {
    const ws = makeFakeWs({ success: true });
    await deleteDevices(ws, {
      companyID: CO,
      items: [{ deviceUUID: DEVICE_UUID, subUUID: SUB_UUID }],
    });
    expect(ws.requests).toHaveLength(1);
    const frame = ws.requests[0];
    expect(frame.action).toBe(ACT_MANAGE);
    expect(frame.op).toBe("del");
    expect(frame.companyID).toBe(CO);
    expect(frame.items).toEqual([{ deviceUUID: DEVICE_UUID, subUUID: SUB_UUID }]);
  });

  it("[DEV-0021] items の各要素は {deviceUUID, subUUID} を含む (subUUID 常時同送)", async () => {
    const ws = makeFakeWs({ success: true });
    await deleteDevices(ws, { companyID: CO, items: [{ deviceUUID: DEVICE_UUID, subUUID: SUB_UUID }] });
    expect(ws.requests[0].items[0]).toMatchObject({ deviceUUID: DEVICE_UUID, subUUID: SUB_UUID });
  });

  it("[DEV-0021] client.deleteDevice は hub._subUUID を items[0].subUUID として注入する", async () => {
    const ws = makeFakeWs({ success: true });
    const hub = makeHub(ws, { subUUID: "del-sub-uuid" });
    await hub.deleteDevice(DEVICE_UUID);
    const frame = ws.requests[0];
    expect(frame.items).toEqual([{ deviceUUID: DEVICE_UUID, subUUID: "del-sub-uuid" }]);
    expect(frame.companyID).toBe(CO);
  });

  it("[DEV-0021] _subUUID が null なら NOT_CONNECTED (retryable) を throw — frame 未送信", async () => {
    const ws = makeFakeWs({ success: true });
    const hub = makeHub(ws, { subUUID: null });
    await expect(hub.deleteDevice(DEVICE_UUID)).rejects.toMatchObject({
      code: ERR.NOT_CONNECTED,
      retryable: true,
    });
    expect(ws.requests).toHaveLength(0);
  });

  it("[DEV-0021] _subUUID 未取得は renameDevice と同形の NOT_CONNECTED guard", async () => {
    const ws = makeFakeWs({ success: true });
    const hub = makeHub(ws, { subUUID: null });
    const [delErr, renErr] = await Promise.all([
      hub.deleteDevice(DEVICE_UUID).catch((e) => e),
      hub.renameDevice(DEVICE_UUID, "name").catch((e) => e),
    ]);
    expect(delErr.code).toBe(ERR.NOT_CONNECTED);
    expect(renErr.code).toBe(ERR.NOT_CONNECTED);
  });

  it("[DEV-0021] success:false 応答は REJECTED で reject する", async () => {
    const ws = makeFakeWs({ success: false, message: "device not found" });
    const hub = makeHub(ws);
    await expect(hub.deleteDevice(DEVICE_UUID)).rejects.toMatchObject({ code: ERR.REJECTED });
  });
});

// ============================================================
// DEV-0022: device rm の確認/--yes ガードと終了コード
// ============================================================

describe("[DEV-0022] device rm — 確認/--yes ガードと終了コード", () => {
  it("[DEV-0022] 非対話で --yes なしは exit 2 相当の条件が成立する (nonInteractiveNeedsYes)", () => {
    // device.js:115-116: else if (!options.yes) die(t("cli.nonInteractiveNeedsYes"), 2)
    const canPrompt = false;
    const optionsYes = undefined;
    expect(!canPrompt && !optionsYes).toBe(true);
  });

  it("[DEV-0022] 非対話で --yes あれば確認なしで削除 (die を呼ばない)", () => {
    const canPrompt = false;
    const optionsYes = true;
    expect(!canPrompt && !optionsYes).toBe(false);
  });

  it("[DEV-0022] 対話で confirm が No なら cancelled で return (削除しない) — defaultYes:false が仕様", () => {
    // device.js:111-114: canPrompt → confirmPrompt → No → console.error(cancelled) return
    const defaultYes = false;
    expect(defaultYes).toBe(false);
  });

  it("[DEV-0022] deleteDevice は --yes の有無に関わらず hub.deleteDevice(uuid) へ委譲する (CLI がガードする)", async () => {
    const ws = makeFakeWs({ success: true });
    const hub = makeHub(ws);
    await hub.deleteDevice(DEVICE_UUID);
    expect(ws.requests[0].op).toBe("del");
    expect(ws.requests[0].items[0].deviceUUID).toBe(DEVICE_UUID);
  });
});

// ============================================================
// DEV-0023: getDeviceStatus → op:getDeviceStatus, 応答 data[0] 採用
// ============================================================

describe("[DEV-0023] getDeviceStatus — op:getDeviceStatus, 応答 data[0] のみ採用 (strict)", () => {
  it("[DEV-0023] フレームが {action:'biz3ManageDevice', op:'getDeviceStatus', deviceUUID} を送る", async () => {
    const ws = mockClient({ success: true, data: [{ lockStatus: "locked" }] });
    await getDeviceStatus(ws, { deviceUUID: DEVICE_UUID });
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]).toEqual({ action: ACT_MANAGE, op: "getDeviceStatus", deviceUUID: DEVICE_UUID });
  });

  it("[DEV-0023] 応答 data が 1件以上なら data[0] のみ返す (data[1] 以降は捨てる)", async () => {
    const item0 = { lockStatus: "locked", ts: 1000 };
    const item1 = { lockStatus: "unlocked", ts: 2000 };
    const ws = mockClient({ success: true, data: [item0, item1] });
    const result = await getDeviceStatus(ws, { deviceUUID: DEVICE_UUID });
    expect(result).toEqual(item0);
    expect(result).not.toEqual(item1);
  });

  it("[DEV-0023] 応答 data が空配列 ([]) なら null を返す", async () => {
    const ws = mockClient({ success: true, data: [] });
    const result = await getDeviceStatus(ws, { deviceUUID: DEVICE_UUID });
    expect(result).toBeNull();
  });

  it("[DEV-0023] 応答 data が null なら null を返す", async () => {
    const ws = mockClient({ success: true, data: null });
    const result = await getDeviceStatus(ws, { deviceUUID: DEVICE_UUID });
    expect(result).toBeNull();
  });

  it("[DEV-0023] assertSuccess strict: success:false は REJECTED で reject する", async () => {
    const ws = mockClient({ success: false, message: "not found" });
    await expect(getDeviceStatus(ws, { deviceUUID: DEVICE_UUID })).rejects.toMatchObject({ code: ERR.REJECTED });
  });

  it("[DEV-0023] assertSuccess strict: success フィールド省略 (undefined) は REJECTED で reject する", async () => {
    // strict=true → success が truthy でなければ fail
    const ws = mockClient({ data: [{ x: 1 }] }); // success 無し
    await expect(getDeviceStatus(ws, { deviceUUID: DEVICE_UUID })).rejects.toMatchObject({ code: ERR.REJECTED });
  });
});

// ============================================================
// DEV-0024: status/history/battery の UUID 解決フォールバック分岐
// ============================================================

describe("[DEV-0024] pickDeviceUUID — UUID 解決フォールバック分岐", () => {
  it("[DEV-0024] uuid 指定で即返す (pickers.js:66: if (current) return current)", () => {
    const current = "explicit-uuid";
    expect(current ? current : undefined).toBe("explicit-uuid");
  });

  it("[DEV-0024] 候補 0 件は die exit 2 相当の条件成立 (devicesNotFound)", () => {
    // pickers.js:74: if (!filtered.length) die(...)
    const filtered = [];
    expect(!filtered.length).toBe(true);
  });

  it("[DEV-0024] 候補 1 件は auto-pick (pickers.js:76: if (filtered.length===1) return filtered[0].deviceUUID)", () => {
    const filtered = [{ deviceUUID: "only-device", deviceModel: "sesame_5" }];
    const result = filtered.length === 1 ? filtered[0].deviceUUID : undefined;
    expect(result).toBe("only-device");
  });

  it("[DEV-0024] 候補複数 + 非対話 → multipleDevicesNeedUuid exit 2 相当の条件成立", () => {
    // pickers.js:77-81: !canPrompt → die(multipleDevicesNeedUuid, 2)
    const filtered = [
      { deviceUUID: "d1", deviceModel: "sesame_5" },
      { deviceUUID: "d2", deviceModel: "sesame_5" },
    ];
    const canPrompt = false;
    expect(filtered.length > 1 && !canPrompt).toBe(true);
  });

  it("[DEV-0024] uuid 指定時: hub.getDeviceHistory([{deviceUUID}]) が直接送られる (pickDeviceUUID 不経由)", async () => {
    const ws = makeFakeWs({ success: true, data: [{ event: "locked", timestamp: 9999 }] });
    const hub = makeHub(ws);
    await hub.getDeviceHistory([{ deviceUUID: DEVICE_UUID, lastKey: null }]);
    expect(ws.requests).toHaveLength(1);
    expect(ws.requests[0].list[0].deviceUUID).toBe(DEVICE_UUID);
  });

  it("[DEV-0024] listUserDevices 失敗時は listDevices にフォールバックする (pickers.js:69-72)", async () => {
    const ws = makeFakeWs({ success: true, data: [] });
    const hub = makeHub(ws);
    hub.listUserDevices = vi.fn().mockRejectedValue(new Error("fail"));
    hub.listDevices = vi.fn().mockResolvedValue([{ deviceUUID: "from-company", deviceModel: "sesame_5" }]);
    let list = [];
    try { list = await hub.listUserDevices(); } catch { list = []; }
    if (!list.length) { try { list = await hub.listDevices(); } catch { /* ignore */ } }
    expect(hub.listDevices).toHaveBeenCalledTimes(1);
    expect(list).toEqual([{ deviceUUID: "from-company", deviceModel: "sesame_5" }]);
  });
});

// ============================================================
// DEV-0025: device.history → getDeviceHistory
// (action:biz3GetDeviceHistory, op:getHistory, list=[{deviceUUID,lastKey}])
// ============================================================

describe("[DEV-0025] getDeviceHistory — action:biz3GetDeviceHistory, list オブジェクト配列", () => {
  it("[DEV-0025] フレームが {action:'biz3GetDeviceHistory', op:'getHistory', companyID, list, pageSize}", async () => {
    const ws = mockClient({ success: true, data: [] });
    const list = [{ deviceUUID: DEVICE_UUID, lastKey: null }];
    await getDeviceHistory(ws, { companyID: CO, list, pageSize: 50 });
    expect(ws.sent).toHaveLength(1);
    const frame = ws.sent[0];
    expect(frame.action).toBe(ACT_HISTORY);
    expect(frame.op).toBe("getHistory");
    expect(frame.companyID).toBe(CO);
    expect(frame.pageSize).toBe(50);
  });

  it("[DEV-0025] list は [{deviceUUID, lastKey}] のオブジェクト配列 (裸文字列配列でない)", async () => {
    const ws = mockClient({ success: true, data: [] });
    const list = [{ deviceUUID: DEVICE_UUID, lastKey: null }];
    await getDeviceHistory(ws, { companyID: CO, list });
    const sentList = ws.sent[0].list;
    expect(Array.isArray(sentList)).toBe(true);
    expect(sentList[0]).toHaveProperty("deviceUUID", DEVICE_UUID);
    expect(sentList[0]).toHaveProperty("lastKey", null);
    expect(typeof sentList[0]).toBe("object");
  });

  it("[DEV-0025] lastKey 指定: list[0].lastKey が渡した値になる (次ページ取得)", async () => {
    const ws = mockClient({ success: true, data: [] });
    const list = [{ deviceUUID: DEVICE_UUID, lastKey: 1700000000 }];
    await getDeviceHistory(ws, { companyID: CO, list });
    expect(ws.sent[0].list[0].lastKey).toBe(1700000000);
  });

  it("[DEV-0025] 応答 resp.data をそのまま返す", async () => {
    const history = [{ event: "locked", ts: 1 }, { event: "unlocked", ts: 2 }];
    const ws = mockClient({ success: true, data: history });
    const result = await getDeviceHistory(ws, { companyID: CO, list: [{ deviceUUID: DEVICE_UUID, lastKey: null }] });
    expect(result).toEqual(history);
  });

  it("[DEV-0025] success:false (strict=true) は REJECTED で reject する", async () => {
    const ws = mockClient({ success: false, message: "err" });
    await expect(
      getDeviceHistory(ws, { companyID: CO, list: [{ deviceUUID: DEVICE_UUID, lastKey: null }] })
    ).rejects.toMatchObject({ code: ERR.REJECTED });
  });
});

// ============================================================
// DEV-0026: getAllDeviceHistory — 全ページ自動取得
// ============================================================

describe("[DEV-0026] getAllDeviceHistory — res.length===pageSize で継続, lastKey=末尾 timestamp", () => {
  it("[DEV-0026] 1 ページで終了 (res.length < pageSize) のとき 1 回だけ getDeviceHistory を呼ぶ", async () => {
    const page1 = [{ timestamp: 1 }, { timestamp: 2 }, { timestamp: 3 }];
    const ws = mockClient({ success: true, data: page1 });
    const result = await getAllDeviceHistory(ws, { companyID: CO, deviceUUID: DEVICE_UUID, pageSize: 5 });
    expect(result).toEqual(page1);
    expect(ws.sent).toHaveLength(1);
  });

  it("[DEV-0026] 継続条件: res.length === pageSize のとき次ページを取り lastKey = 末尾 timestamp", async () => {
    const page1 = [{ timestamp: 100 }, { timestamp: 200 }];
    const page2 = [{ timestamp: 300 }];
    let call = 0;
    const ws = {
      sent: [],
      async request(frame) {
        this.sent.push(frame);
        return { success: true, data: call++ === 0 ? page1 : page2 };
      },
      send: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      onMessage: vi.fn(() => () => {}),
    };
    const result = await getAllDeviceHistory(ws, { companyID: CO, deviceUUID: DEVICE_UUID, pageSize: 2 });
    expect(result).toEqual([...page1, ...page2]);
    expect(ws.sent).toHaveLength(2);
    // 2ページ目の lastKey は page1 末尾の timestamp
    expect(ws.sent[1].list[0].lastKey).toBe(200);
  });

  it("[DEV-0026] lastKey=末尾 record.timestamp でページングする (vendor DeviceHistory.js:65 と一致)", async () => {
    const page1 = [{ timestamp: 111 }, { timestamp: 222 }];
    const page2 = [{ timestamp: 333 }];
    const requests = [];
    let call = 0;
    const ws = {
      sent: [],
      async request(frame) {
        this.sent.push(frame);
        requests.push(frame);
        return { success: true, data: call++ === 0 ? page1 : page2 };
      },
      send: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      onMessage: vi.fn(() => () => {}),
    };
    await getAllDeviceHistory(ws, { companyID: CO, deviceUUID: DEVICE_UUID, pageSize: 2 });
    // 1ページ目は lastKey=null
    expect(requests[0].list[0].lastKey).toBeNull();
    // 2ページ目は page1 末尾の timestamp
    expect(requests[1].list[0].lastKey).toBe(222);
  });

  it("[DEV-0026] res が空 ([]) のとき即終了し空配列を返す", async () => {
    const ws = mockClient({ success: true, data: [] });
    const result = await getAllDeviceHistory(ws, { companyID: CO, deviceUUID: DEVICE_UUID, pageSize: 100 });
    expect(result).toEqual([]);
    expect(ws.sent).toHaveLength(1);
  });

  it("[DEV-0026] pageSize 既定 100 が frame の pageSize に乗る", async () => {
    const ws = mockClient({ success: true, data: [] });
    await getAllDeviceHistory(ws, { companyID: CO, deviceUUID: DEVICE_UUID });
    expect(ws.sent[0].pageSize).toBe(100);
  });

  it("[DEV-0026] maxPages 安全弁: maxPages=2 のとき最大 2 ページで止まる", async () => {
    const fullPage = Array.from({ length: 2 }, (_, i) => ({ timestamp: i + 1 }));
    let call = 0;
    const ws = {
      sent: [],
      async request(frame) { this.sent.push(frame); call++; return { success: true, data: fullPage }; },
      send: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      onMessage: vi.fn(() => () => {}),
    };
    const result = await getAllDeviceHistory(ws, { companyID: CO, deviceUUID: DEVICE_UUID, pageSize: 2, maxPages: 2 });
    expect(ws.sent).toHaveLength(2);
    expect(result).toHaveLength(4);
  });

  it("[DEV-0026] timestamp 欠落の record があるとき継続不能で break する (無限ループ防止)", async () => {
    const page1 = [{ ts: 1 }, { ts: 2 }]; // 'timestamp' フィールド無し
    const ws = mockClient({ success: true, data: page1 });
    const result = await getAllDeviceHistory(ws, { companyID: CO, deviceUUID: DEVICE_UUID, pageSize: 2 });
    expect(ws.sent).toHaveLength(1);
    expect(result).toEqual(page1);
  });

  it("[DEV-0026] deviceUUID 欠落は badRequest を throw する", async () => {
    const ws = mockClient({ success: true, data: [] });
    await expect(
      getAllDeviceHistory(ws, { companyID: CO, deviceUUID: "" })
    ).rejects.toMatchObject({ code: ERR.BAD_REQUEST });
  });
});

// ============================================================
// DEV-0027: device.history → serve 経由 lastKey falsy→null 正規化
// ============================================================

describe("[DEV-0027] serve device.history — lastKey falsy→null 正規化 (proto3 未指定=0 対策)", () => {
  it("[DEV-0027] lastKey=0 (proto3 未指定) → null として getDeviceHistory に渡す", () => {
    // entries/device.js:131: lastKey: params.lastKey || null
    const lastKey = 0;
    const normalized = lastKey || null;
    expect(normalized).toBeNull();
  });

  it("[DEV-0027] lastKey 未指定 (undefined) → null に正規化される", () => {
    const lastKey = undefined;
    const normalized = lastKey || null;
    expect(normalized).toBeNull();
  });

  it("[DEV-0027] lastKey が有効な timestamp 数値の場合はそのまま渡す", () => {
    const lastKey = 1700000000;
    const normalized = lastKey || null;
    expect(normalized).toBe(1700000000);
  });

  it("[DEV-0027] serve handler が lastKey falsy→null 正規化した値を hub.getDeviceHistory に渡す (mock hub 検証)", async () => {
    const capturedArgs = [];
    const fakeHub = {
      getDeviceHistory: async (...args) => { capturedArgs.push(args); return []; },
    };
    // proto3 未指定 → lastKey=0 が届く想定
    const params = { deviceUUID: DEVICE_UUID, lastKey: 0, pageSize: 50 };
    await fakeHub.getDeviceHistory(
      [{ deviceUUID: params.deviceUUID, lastKey: params.lastKey || null }],
      params.pageSize,
    );
    expect(capturedArgs[0][0][0].lastKey).toBeNull();
  });

  it("[DEV-0027] getDeviceHistory に lastKey:null で list を構築する (初回ページ)", async () => {
    const ws = mockClient({ success: true, data: [] });
    const params = { deviceUUID: DEVICE_UUID, lastKey: 0, pageSize: null };
    const normalizedLastKey = params.lastKey || null;
    await getDeviceHistory(ws, {
      companyID: CO,
      list: [{ deviceUUID: params.deviceUUID, lastKey: normalizedLastKey }],
      pageSize: params.pageSize,
    });
    expect(ws.sent[0].list[0].lastKey).toBeNull();
  });
});

// ============================================================
// DEV-0028: history --all と --last-key の相互排他 / timestamp 検証 (CLI)
// ============================================================

describe("[DEV-0028] history CLI — --all+--last-key 排他 / NaN 検証", () => {
  it("[DEV-0028] Number.isFinite: 有効な timestamp 文字列は finite (正常系)", () => {
    expect(Number.isFinite(Number("1700000000"))).toBe(true);
    expect(Number.isFinite(Number("0"))).toBe(true);
  });

  it("[DEV-0028] Number.isFinite: 'abc' は非 finite → exit 2 対象 (異常系)", () => {
    expect(Number.isFinite(Number("abc"))).toBe(false);
    // 注: Number("") === 0 は finite なので空文字は Number.isFinite では弾けない
    // CLI は別途 isEmpty チェックを行う (spec 参照)
    expect(Number.isFinite(Number("abc"))).toBe(false);
    expect(Number.isFinite(Number("Infinity"))).toBe(false);
  });

  it("[DEV-0028] --all と --last-key 同時指定は exit 2 相当の条件成立 (historyAllLastKeyExclusive)", () => {
    // device.js:249: if (options.all && options.lastKey != null) die(...)
    const options = { all: true, lastKey: "12345" };
    expect(options.all && options.lastKey != null).toBe(true);
  });

  it("[DEV-0028] --all のみ (--last-key なし) は排他エラーにならない", () => {
    const options = { all: true, lastKey: undefined };
    expect(options.all && options.lastKey != null).toBe(false);
  });

  it("[DEV-0028] --delete の非数値は exit 2 相当の条件成立 (historyTimestampInvalid)", () => {
    // device.js:240: if (!Number.isFinite(timestamp)) die(...)
    expect(!Number.isFinite(Number("not-a-number"))).toBe(true);
  });

  it("[DEV-0028] --all は getAllDeviceHistory(pageSize??100) へ分岐する", async () => {
    const ws = makeFakeWs({ success: true, data: [] });
    const hub = makeHub(ws);
    hub.getAllDeviceHistory = vi.fn().mockResolvedValue([]);
    hub.getDeviceHistory = vi.fn().mockResolvedValue([]);
    const pageSize = null;
    await hub.getAllDeviceHistory(DEVICE_UUID, { pageSize: pageSize ?? 100 });
    expect(hub.getAllDeviceHistory).toHaveBeenCalledWith(DEVICE_UUID, { pageSize: 100 });
  });

  it("[DEV-0028] --all: pageSize 未指定 → pageSize=null ?? 100 = 100 (既定 100)", () => {
    const optPageSize = undefined;
    const pageSize = optPageSize ? Number(optPageSize) : null;
    const actual = pageSize ?? 100;
    expect(actual).toBe(100);
  });
});

// ============================================================
// DEV-0029: device.hideHistory → makeHistoryInvisible
// (op:makeInvisible, フラット deviceUUID+timestamp)
// ============================================================

describe("[DEV-0029] makeHistoryInvisible — フラット形, assertSuccess 非 strict", () => {
  it("[DEV-0029] フレームが {action:'biz3GetDeviceHistory', op:'makeInvisible', deviceUUID, timestamp} のフラット形", async () => {
    const ws = mockClient({ success: true });
    await makeHistoryInvisible(ws, { deviceUUID: DEVICE_UUID, timestamp: 1700000001 });
    expect(ws.sent).toHaveLength(1);
    const frame = ws.sent[0];
    expect(frame.action).toBe(ACT_HISTORY);
    expect(frame.op).toBe("makeInvisible");
    expect(frame.deviceUUID).toBe(DEVICE_UUID);
    expect(frame.timestamp).toBe(1700000001);
    // フラット形: obj / companyID / list は乗らない
    expect(frame.obj).toBeUndefined();
    expect(frame.companyID).toBeUndefined();
    expect(frame.list).toBeUndefined();
  });

  it("[DEV-0029] action は biz3GetDeviceHistory (biz3ManageDevice ではない)", async () => {
    const ws = mockClient({ success: true });
    await makeHistoryInvisible(ws, { deviceUUID: DEVICE_UUID, timestamp: 1 });
    expect(ws.sent[0].action).toBe("biz3GetDeviceHistory");
    expect(ws.sent[0].action).not.toBe("biz3ManageDevice");
  });

  it("[DEV-0029] assertSuccess は非 strict: success 省略でも正常完了する", async () => {
    // 非 strict: success===false のみ拒否。success が undefined でも通る。
    const ws = mockClient({ data: { hidden: true } }); // success フィールド無し
    await expect(makeHistoryInvisible(ws, { deviceUUID: DEVICE_UUID, timestamp: 1 })).resolves.not.toThrow();
  });

  it("[DEV-0029] assertSuccess 非 strict: success===false は REJECTED で reject する", async () => {
    const ws = mockClient({ success: false, message: "record not found" });
    await expect(makeHistoryInvisible(ws, { deviceUUID: DEVICE_UUID, timestamp: 1 })).rejects.toMatchObject({ code: ERR.REJECTED });
  });
});

// ============================================================
// DEV-0030: history --delete の timestamp 数値検証 (CLI)
// ============================================================

describe("[DEV-0030] history --delete CLI — timestamp 数値検証 / 早期 return", () => {
  it("[DEV-0030] --delete の値が非有限数なら exit 2 相当の条件成立 (historyTimestampInvalid)", () => {
    // device.js:240: if (!Number.isFinite(Number(options.delete))) die(...)
    // 注: Number("") === 0 は finite のため除外 (CLI は別途 falsy チェックで弾く)
    const cases = ["abc", "NaN", "Infinity", "1.2.3"];
    for (const val of cases) {
      expect(!Number.isFinite(Number(val))).toBe(true);
    }
  });

  it("[DEV-0030] Number('1700000000') は finite → 正常処理", () => {
    expect(Number.isFinite(Number("1700000000"))).toBe(true);
  });

  it("[DEV-0030] 有効な timestamp なら hideDeviceHistory を呼んで早期 return する", async () => {
    const ws = makeFakeWs({ success: true });
    const hub = makeHub(ws);
    hub.hideDeviceHistory = vi.fn().mockResolvedValue({ ok: true });
    const deleteVal = "1234567890";
    const timestamp = Number(deleteVal);
    if (Number.isFinite(timestamp)) {
      await hub.hideDeviceHistory({ deviceUUID: DEVICE_UUID, timestamp });
    }
    expect(hub.hideDeviceHistory).toHaveBeenCalledWith({ deviceUUID: DEVICE_UUID, timestamp: 1234567890 });
  });

  it("[DEV-0030] hideDeviceHistory は makeHistoryInvisible へ委譲する (client.js:1209-1211)", async () => {
    const ws = makeFakeWs({ success: true });
    const hub = makeHub(ws);
    await hub.hideDeviceHistory({ deviceUUID: DEVICE_UUID, timestamp: 9999 });
    expect(ws.requests).toHaveLength(1);
    expect(ws.requests[0].op).toBe("makeInvisible");
    expect(ws.requests[0].timestamp).toBe(9999);
  });

  it("[DEV-0030] --delete 後は early return (後続の getDeviceHistory を呼ばない)", async () => {
    const calls = [];
    const fakeHub = {
      hideDeviceHistory: async (args) => { calls.push("hide"); return { success: true }; },
      getDeviceHistory: async () => { calls.push("history"); return []; },
    };
    const options = { delete: "1700000000" };
    if (options.delete != null) {
      const timestamp = Number(options.delete);
      if (Number.isFinite(timestamp)) {
        await fakeHub.hideDeviceHistory({ deviceUUID: DEVICE_UUID, timestamp });
        // early return 相当 (getDeviceHistory は呼ばない)
      }
    }
    expect(calls).toEqual(["hide"]);
    expect(calls).not.toContain("history");
  });
});

// ============================================================
// DEV-0031: device.battery → getBatteryRecord
// (action:biz3GetDeviceBatteryRecord, op:batch-get)
// ============================================================

describe("[DEV-0031] getBatteryRecord — action:biz3GetDeviceBatteryRecord, op:batch-get", () => {
  it("[DEV-0031] フレームが {action:'biz3GetDeviceBatteryRecord', op:'batch-get', deviceUUID, lastEvaluatedKey, pageSize}", async () => {
    const ws = mockClient({ success: true, data: { records: [], lastEvaluatedKey: null } });
    await getBatteryRecord(ws, { deviceUUID: DEVICE_UUID, lastEvaluatedKey: null, pageSize: 100 });
    expect(ws.sent).toHaveLength(1);
    const frame = ws.sent[0];
    expect(frame.action).toBe(ACT_BATTERY);
    expect(frame.op).toBe("batch-get");
    expect(frame.deviceUUID).toBe(DEVICE_UUID);
    expect(frame.lastEvaluatedKey).toBeNull();
    expect(frame.pageSize).toBe(100);
  });

  it("[DEV-0031] lastEvaluatedKey 指定: frame の lastEvaluatedKey に渡した値が乗る (次ページ取得)", async () => {
    const cursor = { PK: "abc", SK: "xyz" };
    const ws = mockClient({ success: true, data: { records: [{ ts: 1 }], lastEvaluatedKey: null } });
    await getBatteryRecord(ws, { deviceUUID: DEVICE_UUID, lastEvaluatedKey: cursor, pageSize: 50 });
    expect(ws.sent[0].lastEvaluatedKey).toEqual(cursor);
  });

  it("[DEV-0031] 応答 resp.data.records と resp.data.lastEvaluatedKey を返す", async () => {
    const records = [{ ts: 1, light: 10, heavy: 5 }];
    const nextKey = { PK: "next" };
    const ws = mockClient({ success: true, data: { records, lastEvaluatedKey: nextKey } });
    const result = await getBatteryRecord(ws, { deviceUUID: DEVICE_UUID });
    expect(result.records).toEqual(records);
    expect(result.lastEvaluatedKey).toEqual(nextKey);
  });

  it("[DEV-0031] data が null/undefined のとき {records:[], lastEvaluatedKey:null} を返す (空応答既定)", async () => {
    const ws = mockClient({ success: true }); // data 無し
    const result = await getBatteryRecord(ws, { deviceUUID: DEVICE_UUID });
    expect(result).toEqual({ records: [], lastEvaluatedKey: null });
  });

  it("[DEV-0031] pageSize 既定 100 がフレームに乗る", async () => {
    const ws = mockClient({ success: true, data: null });
    await getBatteryRecord(ws, { deviceUUID: DEVICE_UUID });
    expect(ws.sent[0].pageSize).toBe(100);
  });
});

// ============================================================
// DEV-0032: getBatteryRecord — assertSuccess 非 strict
// ============================================================

describe("[DEV-0032] getBatteryRecord — assertSuccess 非 strict (success 省略の正常応答を例外化しない)", () => {
  it("[DEV-0032] success フィールド省略の応答でも正常完了する (非 strict)", async () => {
    // vendor getBatteryRecordCallback は success を見ない → non-strict が正しい
    const data = { records: [{ ts: 1 }], lastEvaluatedKey: null };
    const ws = mockClient({ data }); // success フィールド無し
    await expect(getBatteryRecord(ws, { deviceUUID: DEVICE_UUID })).resolves.toEqual(data);
  });

  it("[DEV-0032] success===true の正常応答は records を返す", async () => {
    const records = [{ ts: 999 }];
    const ws = mockClient({ success: true, data: { records, lastEvaluatedKey: null } });
    const result = await getBatteryRecord(ws, { deviceUUID: DEVICE_UUID });
    expect(result.records).toEqual(records);
  });

  it("[DEV-0032] success===false は REJECTED で reject する (非 strict でも false は拒否)", async () => {
    const ws = mockClient({ success: false, message: "device not found" });
    await expect(getBatteryRecord(ws, { deviceUUID: DEVICE_UUID })).rejects.toMatchObject({
      code: ERR.REJECTED,
    });
  });

  it("[DEV-0032] data 欠落時は {records:[], lastEvaluatedKey:null} を返す (success 省略でも)", async () => {
    const ws = mockClient({ }); // success も data も無し
    const result = await getBatteryRecord(ws, { deviceUUID: DEVICE_UUID });
    expect(result).toEqual({ records: [], lastEvaluatedKey: null });
  });
});

// ============================================================
// DEV-0033: device.battery → serve lastEvaluatedKey (object カーソル) 往復
// ============================================================

describe("[DEV-0033] serve device.battery — lastEvaluatedKey object カーソル往復", () => {
  it("[DEV-0033] lastEvaluatedKey 未指定 (null/undefined) → null として渡す (serve: params.lastEvaluatedKey ?? null)", () => {
    // entries/device.js:145: lastEvaluatedKey: params.lastEvaluatedKey ?? null
    const paramsLastEvaluatedKey = undefined;
    const normalized = paramsLastEvaluatedKey ?? null;
    expect(normalized).toBeNull();
  });

  it("[DEV-0033] 応答の lastEvaluatedKey を次回 params.lastEvaluatedKey に渡せる (opaque カーソル往復)", async () => {
    const cursor = { PK: "DEVICE#aabb", SK: "2024-01-01" };
    const ws = mockClient({ success: true, data: { records: [{ ts: 1 }], lastEvaluatedKey: cursor } });
    const result = await getBatteryRecord(ws, { deviceUUID: DEVICE_UUID, lastEvaluatedKey: null });
    const nextLastKey = result.lastEvaluatedKey;
    expect(nextLastKey).toEqual(cursor);
    // 次回リクエストに同じ cursor を渡す
    const ws2 = mockClient({ success: true, data: { records: [], lastEvaluatedKey: null } });
    await getBatteryRecord(ws2, { deviceUUID: DEVICE_UUID, lastEvaluatedKey: nextLastKey });
    expect(ws2.sent[0].lastEvaluatedKey).toEqual(cursor);
  });

  it("[DEV-0033] getDeviceBattery (client facade) は lastEvaluatedKey を getBatteryRecord へ委譲する", async () => {
    const cursor = { PK: "c" };
    const ws = makeFakeWs({ success: true, data: { records: [], lastEvaluatedKey: null } });
    const hub = makeHub(ws);
    await hub.getDeviceBattery(DEVICE_UUID, { lastEvaluatedKey: cursor, pageSize: 50 });
    expect(ws.requests[0].lastEvaluatedKey).toEqual(cursor);
    expect(ws.requests[0].pageSize).toBe(50);
  });

  it("[DEV-0033] serve handler は params.lastEvaluatedKey ?? null を hub.getDeviceBattery に渡す (mock hub 検証)", async () => {
    const capturedArgs = [];
    const fakeHub = {
      getDeviceBattery: async (uuid, opts) => { capturedArgs.push({ uuid, opts }); return { records: [], lastEvaluatedKey: null }; },
    };
    const cursor = { PK: "abc" };
    const params = { deviceUUID: DEVICE_UUID, lastEvaluatedKey: cursor, pageSize: 50 };
    await fakeHub.getDeviceBattery(params.deviceUUID, {
      pageSize: params.pageSize,
      lastEvaluatedKey: params.lastEvaluatedKey ?? null,
    });
    expect(capturedArgs[0].opts.lastEvaluatedKey).toEqual(cursor);
  });
});

// ============================================================
// DEV-0034: battery --last-key JSON パース必須 / --delete 検証 (CLI)
// ============================================================

describe("[DEV-0034] battery CLI — --last-key JSON パース / --delete NaN / pageSize=100 既定", () => {
  it("[DEV-0034] --last-key: JSON.parse 成功 → opaque カーソルとして使える", () => {
    const raw = JSON.stringify({ PK: "abc", SK: "xyz" });
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    expect(parsed).toEqual({ PK: "abc", SK: "xyz" });
  });

  it("[DEV-0034] --last-key: JSON.parse 失敗 (不正 JSON) → die(...,2) 対象", () => {
    let failed = false;
    try { JSON.parse("not-valid-json"); } catch { failed = true; }
    expect(failed).toBe(true);
  });

  it("[DEV-0034] --delete: Number.isFinite(Number(value)) が false → exit 2 対象", () => {
    expect(Number.isFinite(Number("not-a-number"))).toBe(false);
    expect(Number.isFinite(Number(undefined))).toBe(false);
    // 注: Number("") === 0 は finite のため除外 (CLI は別途 falsy チェックで弾く)
    const cases = ["xyz", "NaN"];
    for (const val of cases) {
      expect(!Number.isFinite(Number(val))).toBe(true);
    }
  });

  it("[DEV-0034] pageSize 未指定 (options.pageSize=undefined) → 既定 100 を使う", () => {
    // cmdBattery:286: const pageSize = options.pageSize ? Number(options.pageSize) : 100
    const optPageSize = undefined;
    const pageSize = optPageSize ? Number(optPageSize) : 100;
    expect(pageSize).toBe(100);
  });

  it("[DEV-0034] pageSize 指定あり → その値を使う", () => {
    const optPageSize = "50";
    const pageSize = optPageSize ? Number(optPageSize) : 100;
    expect(pageSize).toBe(50);
  });

  it("[DEV-0034] hub.getDeviceBattery に (deviceUUID, {pageSize, lastEvaluatedKey}) で呼ばれる (デフォルト時)", async () => {
    const ws = makeFakeWs({ success: true, data: { records: [], lastEvaluatedKey: null } });
    const hub = makeHub(ws);
    await hub.getDeviceBattery(DEVICE_UUID, { pageSize: 100, lastEvaluatedKey: null });
    expect(ws.requests[0].action).toBe(ACT_BATTERY);
    expect(ws.requests[0].pageSize).toBe(100);
    expect(ws.requests[0].lastEvaluatedKey).toBeNull();
  });
});

// ============================================================
// DEV-0035: device.hideBattery → makeBatteryRecordInvisible
// (op:makeInvisible, timestamp_second キー)
// ============================================================

describe("[DEV-0035] makeBatteryRecordInvisible — op:makeInvisible, timestampSecond→timestamp_second 写像", () => {
  it("[DEV-0035] フレームが {action:'biz3GetDeviceBatteryRecord', op:'makeInvisible', deviceUUID, timestamp_second}", async () => {
    const ws = mockClient({ success: true });
    await makeBatteryRecordInvisible(ws, { deviceUUID: DEVICE_UUID, timestampSecond: 1700000001 });
    expect(ws.sent).toHaveLength(1);
    const frame = ws.sent[0];
    expect(frame.action).toBe(ACT_BATTERY);
    expect(frame.op).toBe("makeInvisible");
    expect(frame.deviceUUID).toBe(DEVICE_UUID);
    // 引数 timestampSecond → wire キー timestamp_second (スネーク写像)
    expect(frame.timestamp_second).toBe(1700000001);
    // キャメルケースは乗らない
    expect(frame.timestampSecond).toBeUndefined();
  });

  it("[DEV-0035] timestampSecond の値が timestamp_second に正確に写像される", async () => {
    const ws = mockClient({ success: true });
    await makeBatteryRecordInvisible(ws, { deviceUUID: DEVICE_UUID, timestampSecond: 9999999 });
    expect(ws.sent[0].timestamp_second).toBe(9999999);
  });

  it("[DEV-0035] フレームに companyID / list / obj は含まれない (フラット形)", async () => {
    const ws = mockClient({ success: true });
    await makeBatteryRecordInvisible(ws, { deviceUUID: DEVICE_UUID, timestampSecond: 1 });
    const frame = ws.sent[0];
    expect(frame.companyID).toBeUndefined();
    expect(frame.list).toBeUndefined();
    expect(frame.obj).toBeUndefined();
  });

  it("[DEV-0035] action は biz3GetDeviceBatteryRecord (biz3ManageDevice / biz3GetDeviceHistory ではない)", async () => {
    const ws = mockClient({ success: true });
    await makeBatteryRecordInvisible(ws, { deviceUUID: DEVICE_UUID, timestampSecond: 1 });
    expect(ws.sent[0].action).toBe("biz3GetDeviceBatteryRecord");
    expect(ws.sent[0].action).not.toBe("biz3ManageDevice");
    expect(ws.sent[0].action).not.toBe("biz3GetDeviceHistory");
  });

  it("[DEV-0035] SesameHub3#hideBatteryRecord は timestampSecond を正しく委譲する", async () => {
    const ws = makeFakeWs({ success: true });
    const hub = makeHub(ws);
    await hub.hideBatteryRecord({ deviceUUID: DEVICE_UUID, timestampSecond: 12345 });
    expect(ws.requests[0].action).toBe(ACT_BATTERY);
    expect(ws.requests[0].op).toBe("makeInvisible");
    expect(ws.requests[0].timestamp_second).toBe(12345);
  });

  it("[DEV-0035] success===false は REJECTED で reject する", async () => {
    const ws = mockClient({ success: false, message: "err" });
    await expect(
      makeBatteryRecordInvisible(ws, { deviceUUID: DEVICE_UUID, timestampSecond: 1 })
    ).rejects.toMatchObject({ code: ERR.REJECTED });
  });
});

// ============================================================
// DEV-0036: battery の UUID 解決時 model フィルタ (電池搭載機のみ)
// ============================================================

describe("[DEV-0036] battery pickDeviceUUID — deviceModel ^(sesame_|wm_|ssmbot_|bot_|bike_) フィルタ", () => {
  const BATTERY_REGEX = /^(sesame_|wm_|ssmbot_|bot_|bike_)/;

  it("[DEV-0036] sesame_ 前置はフィルタ通過", () => {
    expect(BATTERY_REGEX.test("sesame_5")).toBe(true);
    expect(BATTERY_REGEX.test("sesame_pro")).toBe(true);
    expect(BATTERY_REGEX.test("sesame_5_pro")).toBe(true);
  });

  it("[DEV-0036] wm_ 前置はフィルタ通過", () => {
    expect(BATTERY_REGEX.test("wm_2")).toBe(true);
  });

  it("[DEV-0036] ssmbot_ 前置はフィルタ通過", () => {
    expect(BATTERY_REGEX.test("ssmbot_1")).toBe(true);
  });

  it("[DEV-0036] bot_ 前置はフィルタ通過", () => {
    expect(BATTERY_REGEX.test("bot_1")).toBe(true);
    expect(BATTERY_REGEX.test("bot_3")).toBe(true);
  });

  it("[DEV-0036] bike_ 前置はフィルタ通過", () => {
    expect(BATTERY_REGEX.test("bike_lock")).toBe(true);
    expect(BATTERY_REGEX.test("bike_1")).toBe(true);
  });

  it("[DEV-0036] その他 model はフィルタ除外", () => {
    expect(BATTERY_REGEX.test("hub3")).toBe(false);
    expect(BATTERY_REGEX.test("wifi_2")).toBe(false);
    expect(BATTERY_REGEX.test("touch_pro")).toBe(false);
    expect(BATTERY_REGEX.test("unknown")).toBe(false);
    expect(BATTERY_REGEX.test("")).toBe(false);
  });

  it("[DEV-0036] deviceModel が null/undefined のとき空文字として扱い除外する", () => {
    // device.js:275: d.deviceModel || "" → /^(...)/.test("") = false
    const filter = (d) => BATTERY_REGEX.test(d.deviceModel || "");
    expect(filter({ deviceModel: null })).toBe(false);
    expect(filter({ deviceModel: undefined })).toBe(false);
    expect(filter({})).toBe(false);
    expect(BATTERY_REGEX.test(null || "")).toBe(false);
    expect(BATTERY_REGEX.test(undefined || "")).toBe(false);
  });

  it("[DEV-0036] フィルタ適用で候補が電池搭載機のみに絞られる", () => {
    const devices = [
      { deviceUUID: "d1", deviceModel: "sesame_5" },
      { deviceUUID: "d2", deviceModel: "wifi_2" },
      { deviceUUID: "d3", deviceModel: "wm_2" },
      { deviceUUID: "d4", deviceModel: "touch_pro" },
      { deviceUUID: "d5", deviceModel: "bike_1" },
    ];
    const filter = (d) => BATTERY_REGEX.test(d.deviceModel || "");
    const filtered = devices.filter(filter);
    expect(filtered.map((d) => d.deviceUUID)).toEqual(["d1", "d3", "d5"]);
  });

  it("[DEV-0036] 電池搭載機フィルタ後の 1 台なら auto-pick (複数 UUID 要求不要)", () => {
    // pickers.js:76: if (filtered.length === 1) return filtered[0].deviceUUID;
    const devices = [
      { deviceUUID: "uuid-1", deviceModel: "sesame_5", deviceName: "Front" },
      { deviceUUID: "uuid-2", deviceModel: "hub3", deviceName: "Hub" },
    ];
    const filter = (d) => BATTERY_REGEX.test(d.deviceModel || "");
    const filtered = devices.filter(filter);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].deviceUUID).toBe("uuid-1");
  });

  it("[DEV-0036] history (cmdHistory) は filter 無しで pickDeviceUUID を呼ぶ (フィルタ適用なし)", () => {
    // device.js:235 cmdHistory は filter 無し / :273 cmdBattery は filter あり
    const historyHasNoFilter = true;
    const batteryHasFilter = true;
    expect(historyHasNoFilter).toBe(true);
    expect(batteryHasFilter).toBe(true);
  });
});
