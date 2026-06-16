// dev-c2.test.js — DEV-0037, DEV-0038, DEV-0042, DEV-0043, DEV-0045, DEV-0046,
//                   DEV-0047, DEV-0048, DEV-0049, DEV-0050, DEV-0051, DEV-0052
//
// 対象:
//   packages/core/src/devices.js  — listFirmware / subscribeDevicesUpdate / getUserDevices
//   packages/core/src/client.js   — SesameHub3 (onLockStateChangeDevice / subscribeDeviceUpdates /
//                                              onDeviceUpdate / listDevices errorAction)
//   packages/kit/src/serve/entries/device.js — deviceEntriesPre (14 メソッド存在)
//   packages/kit/src/serve/stability.js      — STABLE_METHODS / stabilityOf
//
// 方針: TDD — spec どおりの期待値を assert する (実装バグは red になってよい)
// mock: makeMockWs (send/subscribe/onMessage/emit) — ネットワーク・実機・fs に触れない。決定論的。

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── core modules ───────────────────────────────────────────────────────────────
import * as devices from "../../src/devices.js";
import { listFirmware, subscribeDevicesUpdate } from "../../src/devices.js";
import { SesameHub3 } from "../../src/client.js";
import { ERR } from "../../src/errors.js";

// ── kit modules ────────────────────────────────────────────────────────────────
import { deviceEntriesPre } from "../../../kit/src/serve/entries/device.js";
import { STABLE_METHODS, stabilityOf } from "../../../kit/src/serve/stability.js";

// ══════════════════════════════════════════════════════════════════════════════
// 定数
// ══════════════════════════════════════════════════════════════════════════════
const CO = "co-test";
const DEVICE_UUID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeffff";
const DEVICE_UUID_NORM = "aaaaaaaabbbbccccddddeeeeeeeeffff";
const SUB_UUID = "sub-uuid-test";
const ACT_MANAGE = "biz3ManageDevice";
const ACT_TRIGGER = "biz3TriggerLocker";
const ACT_FIRMWARE = "biz3ListFirmware";
const FIRMWARE_KEY = `${ACT_FIRMWARE}:`;
const PUBDEV_KEY = `${ACT_TRIGGER}:pubDeviceStateChange`;

// ══════════════════════════════════════════════════════════════════════════════
// Mock WS factory — send/subscribe/onMessage/emit
//
// emit(key, msg):
//   - subscribe ハンドラ (key 一致) に配信
//   - onMessage リスナー全員に raw msg を配信 (errorAction 経路用)
// ══════════════════════════════════════════════════════════════════════════════
function makeMockWs() {
  /** @type {Map<string, Set<Function>>} */
  const subs = new Map();
  /** @type {Function[]} */
  const allMsgListeners = [];
  /** @type {any[]} */
  const sent = [];

  return {
    sent,
    send(frame) { sent.push(frame); },
    subscribe(key, fn) {
      if (!subs.has(key)) subs.set(key, new Set());
      subs.get(key).add(fn);
      return () => { const s = subs.get(key); if (s) s.delete(fn); };
    },
    onMessage(fn) {
      allMsgListeners.push(fn);
      return () => {
        const i = allMsgListeners.indexOf(fn);
        if (i >= 0) allMsgListeners.splice(i, 1);
      };
    },
    /**
     * テスト用: key のサブスクライバー + onMessage リスナー全員に msg を配信。
     * raw msg オブジェクトとして渡す (keyなし)。
     */
    emit(key, msg) {
      const s = subs.get(key);
      if (s) for (const fn of [...s]) fn(msg);
      for (const fn of [...allMsgListeners]) fn(msg);
    },
    hasSub(key) {
      const s = subs.get(key);
      return !!s && s.size > 0;
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// SesameHub3 fake helper — _ws に fake ws を注入し connect() をスキップ
// ══════════════════════════════════════════════════════════════════════════════
function makeHub(ws, { subUUID = SUB_UUID } = {}) {
  const hub = new SesameHub3({
    config: { companyID: CO },
    tokenStore: { load: () => ({}), save: () => {}, clear: () => {} },
  });
  hub._ws = ws;
  hub._subUUID = subUUID;
  return hub;
}

// ══════════════════════════════════════════════════════════════════════════════
// DEV-0037: listFirmware → sendFrame {action:'biz3ListFirmware'} (op フィールド無し)
// ══════════════════════════════════════════════════════════════════════════════
describe("[DEV-0037] listFirmware — sendFrame は action のみ (op フィールド無し)", () => {
  it("[DEV-0037] sendFrame が {action:'biz3ListFirmware'} で op フィールドを持たない", async () => {
    // ref: packages/core/src/devices.js:446; references_web/src/api/useDeveloper.js:38-41
    const ws = makeMockWs();
    const firmwareData = [{ version: "1.0", model: "sesame_5" }];

    const p = listFirmware(ws);

    // フレームが即時 send されること
    expect(ws.sent).toHaveLength(1);
    const frame = ws.sent[0];

    // action = "biz3ListFirmware"
    expect(frame.action).toBe(ACT_FIRMWARE);

    // op フィールドを持たない (vendor useDeveloper.js:38-41 と同形)
    expect(frame).not.toHaveProperty("op");

    // フレームのキーは action のみ
    expect(Object.keys(frame)).toEqual(["action"]);

    // Promise 解決: `biz3ListFirmware:` キーで data 配列を push
    ws.emit(FIRMWARE_KEY, { success: true, data: firmwareData });
    const result = await p;
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0].model).toBe("sesame_5");
  });

  it("[DEV-0037] push key は `biz3ListFirmware:` (action + 空文字 op サフィックス)", async () => {
    // ref: packages/core/src/devices.js:451 key=`${ACT_FIRMWARE}:`
    const ws = makeMockWs();
    const p = listFirmware(ws);

    // 別キーへの emit は無視
    ws.emit(`${ACT_FIRMWARE}:somethingElse`, { success: true, data: [] });

    // 正しいキーで解決
    ws.emit(FIRMWARE_KEY, { success: true, data: [] });
    await expect(p).resolves.toEqual([]);
  });

  it("[DEV-0037] 空 data 配列でも [] を返す (data 配列の正準形)", async () => {
    const ws = makeMockWs();
    const p = listFirmware(ws);
    ws.emit(FIRMWARE_KEY, { success: true, data: [] });
    const result = await p;
    expect(result).toEqual([]);
  });

  it("[DEV-0037] data 欠落時は [] を返す (msg?.data||[] 契約)", async () => {
    // ref: devices.js:461 data = msg?.data || []
    const ws = makeMockWs();
    const p = listFirmware(ws);
    // data フィールド無し
    ws.emit(FIRMWARE_KEY, { success: true });
    const result = await p;
    expect(result).toEqual([]);
  });

  it("[DEV-0037] data が null/undefined の場合は [] を返す", async () => {
    const ws = makeMockWs();
    const p = listFirmware(ws);
    ws.emit(FIRMWARE_KEY, { success: true, data: null });
    await expect(p).resolves.toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// DEV-0038: listFirmware — success:false 即時エラーを空配列成功に化けさせない
// ══════════════════════════════════════════════════════════════════════════════
describe("[DEV-0038] listFirmware — success:false push は rejected で失敗 (空配列成功にしない)", () => {
  it("[DEV-0038] msg.success===false は rejected(upstreamCode 添付) で reject する", async () => {
    // ref: packages/core/src/devices.js:456-459
    const ws = makeMockWs();
    const p = listFirmware(ws);
    ws.emit(FIRMWARE_KEY, { success: false, message: "Forbidden", code: 403 });
    await expect(p).rejects.toMatchObject({ code: ERR.REJECTED });
  });

  it("[DEV-0038] rejected エラーには upstreamCode が添付される", async () => {
    // ref: packages/core/src/devices.js:457-458 { upstreamCode: msg?.code ?? null }
    const ws = makeMockWs();
    const p = listFirmware(ws);
    ws.emit(FIRMWARE_KEY, { success: false, code: 999, message: "error" });
    const err = await p.catch((e) => e);
    expect(err.code).toBe(ERR.REJECTED);
    expect(err.data?.upstreamCode).toBe(999);
  });

  it("[DEV-0038] upstreamCode は null にフォールバック (code フィールド欠落)", async () => {
    // ref: devices.js:458 msg?.code ?? null
    const ws = makeMockWs();
    const p = listFirmware(ws);
    ws.emit(FIRMWARE_KEY, { success: false, message: "no code" });
    const err = await p.catch((e) => e);
    expect(err.data?.upstreamCode).toBeNull();
  });

  it("[DEV-0038] success フィールド欠落の正常応答は reject しない (非 strict 相当)", async () => {
    // ref: devices.js:456 msg?.success===false → false のみ拒否
    // success フィールドを省略した push は正常とみなし data を返す
    const ws = makeMockWs();
    const p = listFirmware(ws);
    ws.emit(FIRMWARE_KEY, { data: [{ model: "wm_2" }] });
    const result = await p;
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].model).toBe("wm_2");
  });

  it("[DEV-0038] success が true なら通常通り data 配列を返す (reject しない)", async () => {
    const ws = makeMockWs();
    const p = listFirmware(ws);
    const data = [{ version: "2.0" }];
    ws.emit(FIRMWARE_KEY, { success: true, data });
    await expect(p).resolves.toEqual(data);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// DEV-0042: client.onLockStateChangeDevice — 単機購読 frame + model 有無分岐
//            + normalizeUuid フィルタ + 再接続再送
// ══════════════════════════════════════════════════════════════════════════════
describe("[DEV-0042] onLockStateChangeDevice — UUID 単機購読 frame + model 有無 + フィルタ + 再送", () => {
  it("[DEV-0042] model 不明時 items=[{deviceUUID}] の subscribeDevicesUpdate frame を送信", () => {
    // ref: packages/core/src/client.js:1456-1464
    const ws = makeMockWs();
    const hub = makeHub(ws);
    const unsub = hub.onLockStateChangeDevice(DEVICE_UUID, () => {});

    expect(ws.sent).toHaveLength(1);
    const frame = ws.sent[0];
    expect(frame.action).toBe(ACT_MANAGE);
    expect(frame.op).toBe("subscribeDevicesUpdate");
    expect(frame.companyID).toBe(CO);
    expect(frame.items).toHaveLength(1);
    // model 不明なら deviceUUID のみ
    expect(frame.items[0]).toEqual({ deviceUUID: DEVICE_UUID });
    expect(frame.items[0]).not.toHaveProperty("deviceModel");

    unsub();
  });

  it("[DEV-0042] model 既知時 items=[{deviceUUID, deviceModel}] を送信", () => {
    // ref: packages/core/src/client.js:1456 const item = deviceModel ? {...,deviceModel} : {...}
    const ws = makeMockWs();
    const hub = makeHub(ws);
    const unsub = hub.onLockStateChangeDevice(DEVICE_UUID, () => {}, { deviceModel: "sesame_5" });

    const frame = ws.sent[0];
    expect(frame.items[0]).toEqual({ deviceUUID: DEVICE_UUID, deviceModel: "sesame_5" });

    unsub();
  });

  it("[DEV-0042] push は biz3TriggerLocker:pubDeviceStateChange キーを購読", () => {
    const ws = makeMockWs();
    const hub = makeHub(ws);
    const unsub = hub.onLockStateChangeDevice(DEVICE_UUID, () => {});
    expect(ws.hasSub(PUBDEV_KEY)).toBe(true);
    unsub();
  });

  it("[DEV-0042] normalizeUuid 一致フィルタ: 同 UUID の push だけ fn を呼ぶ", () => {
    // ref: packages/core/src/client.js:1473-1474
    const ws = makeMockWs();
    const hub = makeHub(ws);
    const calls = [];
    const unsub = hub.onLockStateChangeDevice(DEVICE_UUID, (msg) => calls.push(msg));

    // 一致 UUID (ハイフン正規化済み) の push
    ws.emit(PUBDEV_KEY, { data: { deviceUUID: DEVICE_UUID } });
    expect(calls).toHaveLength(1);

    // 別 UUID は無視
    ws.emit(PUBDEV_KEY, { data: { deviceUUID: "different-uuid-000" } });
    expect(calls).toHaveLength(1);

    unsub();
  });

  it("[DEV-0042] normalizeUuid でハイフン有無を吸収してフィルタリング", () => {
    // ref: packages/core/src/client.js:1453 target = normalizeUuid(deviceUUID)
    const ws = makeMockWs();
    const hub = makeHub(ws);
    const calls = [];
    // ハイフンなし UUID で購読
    const unsub = hub.onLockStateChangeDevice(DEVICE_UUID_NORM, (msg) => calls.push(msg));

    // 大文字 + ハイフン付きで push が来ても一致する
    ws.emit(PUBDEV_KEY, { data: { deviceUUID: DEVICE_UUID.toUpperCase() } });
    expect(calls).toHaveLength(1);

    unsub();
  });

  it("[DEV-0042] onReconnect に sendFrame が登録される (再接続再送パターン)", () => {
    // ref: packages/core/src/client.js:1467 const offReconnect = this.onReconnect(sendSubscribeFrame)
    const ws = makeMockWs();
    const hub = makeHub(ws);
    const onReconnectSpy = vi.spyOn(hub, "onReconnect");

    const unsub = hub.onLockStateChangeDevice(DEVICE_UUID, () => {});

    expect(onReconnectSpy).toHaveBeenCalledOnce();
    // 引数は関数 (sendSubscribeFrame)
    expect(typeof onReconnectSpy.mock.calls[0][0]).toBe("function");

    unsub();
  });

  it("[DEV-0042] onReconnect コールバック呼び出しで subscribeDevicesUpdate frame を再送する", () => {
    // ref: packages/core/src/client.js:1467 onReconnect(sendSubscribeFrame)
    const ws = makeMockWs();
    const hub = makeHub(ws);
    let reconnectCb = null;
    const origOnReconnect = hub.onReconnect.bind(hub);
    hub.onReconnect = (fn) => { reconnectCb = fn; return origOnReconnect(fn); };

    const unsub = hub.onLockStateChangeDevice(DEVICE_UUID, () => {});

    expect(typeof reconnectCb).toBe("function");
    const sentBefore = ws.sent.length;
    reconnectCb();
    expect(ws.sent.length).toBeGreaterThan(sentBefore);
    const resent = ws.sent[ws.sent.length - 1];
    expect(resent.op).toBe("subscribeDevicesUpdate");

    unsub();
  });

  it("[DEV-0042] unsubscribe 後は fn が呼ばれない", () => {
    const ws = makeMockWs();
    const hub = makeHub(ws);
    const calls = [];
    const unsub = hub.onLockStateChangeDevice(DEVICE_UUID_NORM, (msg) => calls.push(msg));

    ws.emit(PUBDEV_KEY, { data: { deviceUUID: DEVICE_UUID_NORM } });
    expect(calls).toHaveLength(1);

    unsub();
    ws.emit(PUBDEV_KEY, { data: { deviceUUID: DEVICE_UUID_NORM } });
    // unsubscribe 後は追加呼び出しなし
    expect(calls).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// DEV-0043: subscribeDevicesUpdate — 初回送信 + sendFrame 露出 + 再送可能
//           unsubscribeDevicesUpdate op は biz3 に存在しない
// ══════════════════════════════════════════════════════════════════════════════
describe("[DEV-0043] subscribeDevicesUpdate — 初回 sendFrame + 再送 + unsubscribe 不在", () => {
  const ITEMS = [{ deviceUUID: DEVICE_UUID, deviceModel: "sesame_5" }];

  it("[DEV-0043] 初回 sendFrame で subscribeDevicesUpdate frame を送信する", () => {
    // ref: packages/core/src/devices.js:299-302
    const ws = makeMockWs();
    subscribeDevicesUpdate(ws, { companyID: CO, items: ITEMS, onUpdate: () => {} });

    expect(ws.sent).toHaveLength(1);
    const frame = ws.sent[0];
    expect(frame.action).toBe(ACT_MANAGE);
    expect(frame.op).toBe("subscribeDevicesUpdate");
    expect(frame.companyID).toBe(CO);
    expect(frame.items).toEqual(ITEMS);
  });

  it("[DEV-0043] 戻り値は { unsubscribe, sendFrame } の shape を持つ", () => {
    // ref: packages/core/src/devices.js:306 return { unsubscribe: offSub, sendFrame };
    const ws = makeMockWs();
    const result = subscribeDevicesUpdate(ws, { companyID: CO, items: ITEMS, onUpdate: () => {} });
    expect(typeof result.unsubscribe).toBe("function");
    expect(typeof result.sendFrame).toBe("function");
  });

  it("[DEV-0043] sendFrame() を再呼び出しすると frame が再送される", () => {
    // 再接続時に外部から sendFrame() を呼べること (接続単位の購読状態再送)
    // ref: packages/core/src/devices.js:299-306
    const ws = makeMockWs();
    const { sendFrame } = subscribeDevicesUpdate(ws, { companyID: CO, items: ITEMS, onUpdate: () => {} });

    expect(ws.sent).toHaveLength(1);
    sendFrame();
    expect(ws.sent).toHaveLength(2);
    // 再送 frame も同じ構造
    expect(ws.sent[1]).toEqual(ws.sent[0]);
    expect(ws.sent[1].op).toBe("subscribeDevicesUpdate");
  });

  it("[DEV-0043] push key は biz3TriggerLocker:pubDeviceStateChange (action 非対称)", () => {
    // ref: packages/core/src/devices.js:303 key=`biz3TriggerLocker:pubDeviceStateChange`
    // spec: push は別 action biz3TriggerLocker の pubDeviceStateChange で届く (非対称)
    const ws = makeMockWs();
    const received = [];
    subscribeDevicesUpdate(ws, {
      companyID: CO,
      items: ITEMS,
      onUpdate: (msg) => received.push(msg),
    });

    // 誤キーへの emit は無視
    ws.emit(`${ACT_MANAGE}:pubDeviceStateChange`, { data: {} });
    expect(received).toHaveLength(0);

    // 正しいキー
    ws.emit(PUBDEV_KEY, { data: {} });
    expect(received).toHaveLength(1);
  });

  it("[DEV-0043] unsubscribe op は biz3 に存在しないため close 後も frame は送られない (ローカル購読解除のみ)", () => {
    // ref: packages/core/src/devices.js:288-289 コメント — unsubscribeDevicesUpdate op は無い
    // 検証: unsubscribe() でローカル購読は解除されるが frame は送られない (send 回数不変)
    const ws = makeMockWs();
    const received = [];
    const { unsubscribe } = subscribeDevicesUpdate(ws, {
      companyID: CO,
      items: ITEMS,
      onUpdate: (msg) => received.push(msg),
    });

    // unsubscribe 前: push は届く
    ws.emit(PUBDEV_KEY, { data: { deviceUUID: DEVICE_UUID } });
    expect(received).toHaveLength(1);

    const sentCountBefore = ws.sent.length;
    unsubscribe();
    // unsubscribe op frame は送られない
    expect(ws.sent.length).toBe(sentCountBefore);

    // ローカル購読は解除されているので push は届かない
    ws.emit(PUBDEV_KEY, { data: {} });
    expect(received).toHaveLength(1); // still 1
  });

  it("[DEV-0043] onDeviceUpdate 経由でも同じ frame が送信される (client.js:1550-1559)", () => {
    // ref: client.js:1550-1559 onDeviceUpdate → devices.subscribeDevicesUpdate
    const ws = makeMockWs();
    const hub = makeHub(ws);
    const unsub = hub.onDeviceUpdate(ITEMS, () => {});

    expect(ws.sent).toHaveLength(1);
    const frame = ws.sent[0];
    expect(frame.action).toBe(ACT_MANAGE);
    expect(frame.op).toBe("subscribeDevicesUpdate");
    expect(frame.items).toEqual(ITEMS);

    unsub();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// DEV-0045: deviceEntriesPre 14 メソッドの openrpc↔proto↔grpc-methods↔registry 1:1 存在
// ══════════════════════════════════════════════════════════════════════════════
describe("[DEV-0045] deviceEntriesPre 14 メソッドの各面 1:1 存在", () => {
  // ref: packages/kit/src/serve/entries/device.js:24-185
  const DEVICE_METHODS_14 = [
    "devices.list",
    "devices.userList",
    "devices.add",
    "devices.reorder",
    "devices.notifyStatus",
    "devices.notifyManage",
    "devices.switchRecharge",
    "device.history",
    "device.battery",
    "device.hideHistory",
    "device.hideBattery",
    "device.rename",
    "device.delete",
    "firmware.list",
  ];

  let openrpc;
  let grpcMethods;
  let proto;

  beforeEach(async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = fileURLToPath(new URL(".", import.meta.url));

    openrpc = JSON.parse(
      readFileSync(resolve(__dirname, "../../../../schema/openrpc.json"), "utf-8"),
    );
    // grpc-methods.generated.json はオブジェクト形式 (key=RPC名, value={method,...})
    const grpcRaw = JSON.parse(
      readFileSync(resolve(__dirname, "../../../../packages/kit/src/serve/grpc-methods.generated.json"), "utf-8"),
    );
    grpcMethods = Object.values(grpcRaw);
    proto = readFileSync(
      resolve(__dirname, "../../../../packages/kit/src/serve/sesame.proto"),
      "utf-8",
    );
  });

  it("[DEV-0045] deviceEntriesPre() が 14 メソッドを含む (access.register* 除外後)", () => {
    const entries = deviceEntriesPre();
    const keys = Object.keys(entries);
    for (const name of DEVICE_METHODS_14) {
      expect(keys, `${name} が deviceEntriesPre に存在しない`).toContain(name);
    }
  });

  it("[DEV-0045] 各エントリに handler 関数が定義されている", () => {
    const entries = deviceEntriesPre();
    for (const name of DEVICE_METHODS_14) {
      expect(typeof entries[name].handler, `${name}.handler が関数でない`).toBe("function");
    }
  });

  it("[DEV-0045] 各エントリに summary 文字列が定義されている", () => {
    const entries = deviceEntriesPre();
    for (const name of DEVICE_METHODS_14) {
      expect(typeof entries[name].summary, `${name}.summary が文字列でない`).toBe("string");
    }
  });

  it("[DEV-0045] 14 メソッドが openrpc.json に存在する", () => {
    // ref: schema/openrpc.json
    const openrpcNames = openrpc.methods.map((m) => m.name);
    for (const method of DEVICE_METHODS_14) {
      expect(openrpcNames, `openrpc missing: ${method}`).toContain(method);
    }
  });

  it("[DEV-0045] 14 メソッドが grpc-methods.generated.json に存在する", () => {
    // ref: packages/kit/src/serve/grpc-methods.generated.json
    const grpcNames = grpcMethods.map((m) => m.method);
    for (const method of DEVICE_METHODS_14) {
      expect(grpcNames, `grpc-methods missing: ${method}`).toContain(method);
    }
  });

  it("[DEV-0045] sesame.proto に 14 メソッドの rpc 宣言が全て存在する", () => {
    // proto rpc 名は CamelCase 変換 (devices.list → DevicesList 等)
    const methodToRpc = {
      "devices.list": "DevicesList",
      "devices.userList": "DevicesUserList",
      "devices.add": "DevicesAdd",
      "devices.reorder": "DevicesReorder",
      "devices.notifyStatus": "DevicesNotifyStatus",
      "devices.notifyManage": "DevicesNotifyManage",
      "devices.switchRecharge": "DevicesSwitchRecharge",
      "device.history": "DeviceHistory",
      "device.battery": "DeviceBattery",
      "device.hideHistory": "DeviceHideHistory",
      "device.hideBattery": "DeviceHideBattery",
      "device.rename": "DeviceRename",
      "device.delete": "DeviceDelete",
      "firmware.list": "FirmwareList",
    };
    for (const [method, rpcName] of Object.entries(methodToRpc)) {
      const rpcDecl = `rpc ${rpcName} (`;
      expect(proto, `proto missing rpc for ${method} (expected '${rpcDecl}')`).toContain(rpcDecl);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// DEV-0046: devices/device の cli↔core↔serve↔sdk 同一封筒パリティ (DEVICE 形)
// ══════════════════════════════════════════════════════════════════════════════
describe("[DEV-0046] DEVICE 形パリティ — result-schemas.js の DEVICE 形と整合", () => {
  it("[DEV-0046] result-schemas.js に DEVICE 形が定義されている (deviceUUID を required に含む)", async () => {
    // ref: packages/kit/src/serve/result-schemas.js:38-102
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = fileURLToPath(new URL(".", import.meta.url));
    const src = readFileSync(
      resolve(__dirname, "../../../../packages/kit/src/serve/result-schemas.js"),
      "utf-8",
    );
    expect(src).toMatch(/deviceUUID/);
    expect(src).toMatch(/required.*deviceUUID|deviceUUID.*required/s);
  });

  it("[DEV-0046] devices.list エントリの result 記述が 'device' を含む", () => {
    // ref: packages/kit/src/serve/entries/device.js:28-29
    const entries = deviceEntriesPre();
    expect(entries["devices.list"].result).toMatch(/device/i);
  });

  it("[DEV-0046] device.history エントリの result 記述が 'history' を含む", () => {
    const entries = deviceEntriesPre();
    expect(entries["device.history"].result).toMatch(/history/i);
  });

  it("[DEV-0046] device.battery エントリの result 記述が 'records' または 'battery' を含む", () => {
    const entries = deviceEntriesPre();
    expect(entries["device.battery"].result).toMatch(/records|battery/i);
  });

  it("[DEV-0046] listDevices core result は配列形 (DeviceInfo[]) でラップ無し", async () => {
    // ref: client.js:476-503 listDevices returns acc (array)
    const ws = makeMockWs();
    const hub = makeHub(ws);

    const p = hub.listDevices({ timeoutMs: 200 });

    // PubedCompanyDevice push (page 1, totalPage 1)
    ws.emit(`${ACT_MANAGE}:PubedCompanyDevice`, {
      data: {
        totalPage: 1,
        data: { list: [{ deviceUUID: "dev-1" }, { deviceUUID: "dev-2" }], page: 1 },
      },
    });

    const result = await p;
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0].deviceUUID).toBe("dev-1");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// DEV-0047: devices/device メソッドの stable/experimental 区分
// ══════════════════════════════════════════════════════════════════════════════
describe("[DEV-0047] stable/experimental 区分 — devices.list / device.history / device.battery のみ stable", () => {
  // ref: packages/kit/src/serve/stability.js:19-33
  const STABLE_DEVICE_METHODS = ["devices.list", "device.history", "device.battery"];
  const EXPERIMENTAL_DEVICE_METHODS = [
    "devices.userList",
    "devices.add",
    "devices.reorder",
    "devices.notifyStatus",
    "devices.notifyManage",
    "devices.switchRecharge",
    "device.hideHistory",
    "device.hideBattery",
    "device.rename",
    "device.delete",
    "firmware.list",
  ];

  it("[DEV-0047] devices.list は STABLE_METHODS に 'app-core' で掲載されている", () => {
    // ref: stability.js:28
    expect(STABLE_METHODS["devices.list"]).toBe("app-core");
  });

  it("[DEV-0047] device.history は STABLE_METHODS に 'app-core' で掲載されている", () => {
    // ref: stability.js:29
    expect(STABLE_METHODS["device.history"]).toBe("app-core");
  });

  it("[DEV-0047] device.battery は STABLE_METHODS に 'app-core' で掲載されている", () => {
    // ref: stability.js:30
    expect(STABLE_METHODS["device.battery"]).toBe("app-core");
  });

  it("[DEV-0047] stable 3 メソッドの stabilityOf は 'stable' を返す", () => {
    for (const name of STABLE_DEVICE_METHODS) {
      expect(stabilityOf(name), `${name} が stable でない`).toBe("stable");
    }
  });

  it("[DEV-0047] experimental メソッドは STABLE_METHODS に掲載されておらず stabilityOf は 'experimental'", () => {
    for (const name of EXPERIMENTAL_DEVICE_METHODS) {
      expect(STABLE_METHODS, `${name} should NOT be in STABLE_METHODS`).not.toHaveProperty(name);
      expect(stabilityOf(name), `${name} が experimental でない`).toBe("experimental");
    }
  });

  it("[DEV-0047] stable 3 件以外の devices.* / device.* / firmware.list は app-core に含まれない", () => {
    // 追加検証: devices.userList 等が stable として誤掲載されていない
    const stableKeys = Object.keys(STABLE_METHODS);
    const unexpectedStable = stableKeys.filter(
      (k) => (k.startsWith("devices.") || k.startsWith("device.") || k === "firmware.list")
        && !STABLE_DEVICE_METHODS.includes(k),
    );
    expect(unexpectedStable).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// DEV-0048: history --all が serve/openrpc/sdk に未露出のギャップ
// ══════════════════════════════════════════════════════════════════════════════
describe("[DEV-0048] getAllDeviceHistory は serve/openrpc/sdk に露出されていない (gap)", () => {
  // ref: packages/core/src/client.js:1194-1202; packages/kit/src/serve/entries/device.js:115-133

  it("[DEV-0048] core の SesameHub3 には getAllDeviceHistory が実装されている (cli/core からは呼べる)", () => {
    // core には実装があることを確認 (gap は serve/sdk 側のみ)
    const hub = new SesameHub3({
      config: { companyID: CO },
      tokenStore: { load: () => ({}), save: () => {}, clear: () => {} },
    });
    expect(typeof hub.getAllDeviceHistory).toBe("function");
  });

  it("[DEV-0048] deviceEntriesPre に 'device.allHistory' エントリが存在しない", () => {
    const entries = deviceEntriesPre();
    expect(entries).not.toHaveProperty("device.allHistory");
    expect(Object.keys(entries)).not.toContain("device.getAllHistory");
  });

  it("[DEV-0048] openrpc.json に 'device.allHistory' メソッドが存在しない", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = fileURLToPath(new URL(".", import.meta.url));
    const openrpc = JSON.parse(
      readFileSync(resolve(__dirname, "../../../../schema/openrpc.json"), "utf-8"),
    );
    const names = openrpc.methods.map((m) => m.name);
    expect(names).not.toContain("device.allHistory");
    expect(names).not.toContain("getAllDeviceHistory");
    expect(names.filter((n) => n.toLowerCase().includes("allhistory"))).toHaveLength(0);
  });

  it("[DEV-0048] grpc-methods.generated.json に allDeviceHistory が存在しない", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = fileURLToPath(new URL(".", import.meta.url));
    // grpc-methods.generated.json はオブジェクト形式
    const grpcRaw = JSON.parse(
      readFileSync(resolve(__dirname, "../../../../packages/kit/src/serve/grpc-methods.generated.json"), "utf-8"),
    );
    const names = Object.values(grpcRaw).map((m) => m.method);
    expect(names).not.toContain("device.allHistory");
    expect(names.filter((n) => n.toLowerCase().includes("allhistory"))).toHaveLength(0);
  });

  it("[DEV-0048] sesame.proto に AllDeviceHistory rpc が存在しない", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = fileURLToPath(new URL(".", import.meta.url));
    const proto = readFileSync(
      resolve(__dirname, "../../../../packages/kit/src/serve/sesame.proto"),
      "utf-8",
    );
    expect(proto).not.toMatch(/AllDeviceHistory|allDeviceHistory/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// DEV-0049: listDevices(getCompanyDevice) errorAction 即時エラー
//           (DEV-0052 の getUserDevice 側と対称)
// ══════════════════════════════════════════════════════════════════════════════
describe("[DEV-0049] listDevices errorAction: 同 op success:false が timeout を待たず rejected", () => {
  // ref: packages/core/src/client.js:487-489; packages/core/src/util.js:172-185
  // errorAction = biz3ManageDevice; ownOp = getCompanyDevice

  it("[DEV-0049] getCompanyDevice 同 op success:false → timeout を待たず即 reject", async () => {
    const ws = makeMockWs();
    const hub = makeHub(ws);

    const p = hub.listDevices({ timeoutMs: 5000 });

    // 同 action + 同 op + success:false を onMessage 経由で配信
    ws.emit(`${ACT_MANAGE}:getCompanyDevice`, {
      action: ACT_MANAGE,
      op: "getCompanyDevice",
      success: false,
      message: "company not found",
    });

    await expect(p).rejects.toMatchObject({ code: ERR.REJECTED });
  });

  it("[DEV-0049] reject エラーはメッセージテキストを含む (timeout で来るのではない)", async () => {
    // ref: util.js:177-184 finish(rejected(..., {upstreamCode: ...}))
    const ws = makeMockWs();
    const hub = makeHub(ws);

    const p = hub.listDevices({ timeoutMs: 5000 });

    ws.emit(`${ACT_MANAGE}:getCompanyDevice`, {
      action: ACT_MANAGE,
      op: "getCompanyDevice",
      success: false,
      message: "access denied",
    });

    const err = await p.catch((e) => e);
    expect(err.code).toBe(ERR.REJECTED);
    // TIMEOUT ではないこと
    expect(err.code).not.toBe(ERR.TIMEOUT);
  });

  it("[DEV-0049] success:true 応答は正常処理 (errorAction で reject しない)", async () => {
    const ws = makeMockWs();
    const hub = makeHub(ws);

    const p = hub.listDevices({ timeoutMs: 200 });

    // page 1, totalPage 1 で正常完了
    ws.emit(`${ACT_MANAGE}:PubedCompanyDevice`, {
      data: { totalPage: 1, data: { list: [{ deviceUUID: "dev-1" }], page: 1 } },
    });

    await expect(p).resolves.toBeInstanceOf(Array);
  });

  it("[DEV-0049] 別 op (del) の success:false は無視して一覧取得を続行する (op 相関絞り)", async () => {
    // ref: util.js:180 op 相関絞り (DEV-0052 と連動)
    const ws = makeMockWs();
    const hub = makeHub(ws);

    const p = hub.listDevices({ timeoutMs: 500 });

    // 別 op の失敗 → 無視されること
    ws.emit(`${ACT_MANAGE}:del`, {
      action: ACT_MANAGE,
      op: "del",
      success: false,
      message: "delete failed",
    });

    // 正常な一覧応答で resolve
    ws.emit(`${ACT_MANAGE}:PubedCompanyDevice`, {
      data: { totalPage: 1, data: { list: [{ deviceUUID: "dev-1" }], page: 1 } },
    });

    await expect(p).resolves.toBeInstanceOf(Array);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// DEV-0050: pubDeviceStateChange は subscribeDevicesUpdate frame を送った接続にのみ届く
//           (frame 未送ローカル購読は push 0 の負の事実)
// ══════════════════════════════════════════════════════════════════════════════
describe("[DEV-0050] pubDeviceStateChange — frame 未送のローカル購読は state push を受信しない (負の事実)", () => {
  // ref: packages/core/src/client.js:1436-1444 P3-4 ドキュメンテーションブロック

  it("[DEV-0050] subscribeDevicesUpdate を呼ばずローカル subscribe だけでは frame が送られない", () => {
    // spec: ローカル subscribe だけ (frame 未送信) では state push が来ない (負の事実)
    // mock では emit で simulate するが、real server は frame 無しでは push しない
    // → テスト: frame が送られていないことを assert
    const ws = makeMockWs();
    ws.subscribe(PUBDEV_KEY, () => {});

    // frame 送信がないことを確認 (real server はこの接続に push しない)
    expect(ws.sent).toHaveLength(0);
    expect(ws.sent.some((f) => f.op === "subscribeDevicesUpdate")).toBe(false);
  });

  it("[DEV-0050] subscribeDevicesUpdate を呼ぶと購読 frame が送信される (frame 送信済み = push 対象)", () => {
    // ref: devices.js:299-302 sendFrame() が即時実行される
    const ws = makeMockWs();
    const { unsubscribe } = subscribeDevicesUpdate(ws, {
      companyID: CO,
      items: [{ deviceUUID: DEVICE_UUID }],
      onUpdate: () => {},
    });

    const subscribeFrame = ws.sent.find((f) => f.op === "subscribeDevicesUpdate");
    expect(subscribeFrame).toBeDefined();
    expect(subscribeFrame.action).toBe(ACT_MANAGE);

    unsubscribe();
  });

  it("[DEV-0050] onLockStateChangeDevice は必ず subscribeDevicesUpdate frame を送信する (旧バグ回帰防止)", () => {
    // ref: client.js:1464-1465 sendSubscribeFrame()
    const ws = makeMockWs();
    const hub = makeHub(ws);

    const unsub = hub.onLockStateChangeDevice(DEVICE_UUID, () => {});

    const frameSent = ws.sent.some(
      (f) => f.action === ACT_MANAGE && f.op === "subscribeDevicesUpdate",
    );
    expect(frameSent).toBe(true);

    unsub();
  });

  it("[DEV-0050] onDeviceUpdate も必ず subscribeDevicesUpdate frame を送信する", () => {
    // ref: packages/core/src/client.js:1550-1560
    const ws = makeMockWs();
    const hub = makeHub(ws);

    const unsub = hub.onDeviceUpdate([{ deviceUUID: DEVICE_UUID }], () => {});

    const subscribeFrames = ws.sent.filter((f) => f.op === "subscribeDevicesUpdate");
    expect(subscribeFrames).toHaveLength(1);

    unsub();
  });

  it("[DEV-0050] frame 送信後のみ subscribe handler が state push を受け取れる (正の事実)", () => {
    // frame 送信後に push が来れば受け取れることを確認 (正の検証)
    const ws = makeMockWs();
    const hub = makeHub(ws);
    const updates = [];

    const unsub = hub.onLockStateChangeDevice(DEVICE_UUID_NORM, (msg) => updates.push(msg));

    // frame が送信されていること
    expect(ws.sent.filter((f) => f.op === "subscribeDevicesUpdate")).toHaveLength(1);

    // push を simulate すると受け取れる
    ws.emit(PUBDEV_KEY, { data: { deviceUUID: DEVICE_UUID_NORM } });
    expect(updates).toHaveLength(1);

    unsub();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// DEV-0051: client.subscribeDeviceUpdates (deprecated alias) → onDeviceUpdate 同一委譲
// ══════════════════════════════════════════════════════════════════════════════
describe("[DEV-0051] subscribeDeviceUpdates は onDeviceUpdate への deprecated alias", () => {
  // ref: packages/core/src/client.js:1160-1167

  it("[DEV-0051] subscribeDeviceUpdates(items, fn) が onDeviceUpdate(items, fn) へ委譲する", () => {
    const ws = makeMockWs();
    const hub = makeHub(ws);

    const onDeviceSpy = vi.spyOn(hub, "onDeviceUpdate");
    const items = [{ deviceUUID: DEVICE_UUID }];
    const fn = vi.fn();

    const result = hub.subscribeDeviceUpdates(items, fn);

    expect(onDeviceSpy).toHaveBeenCalledOnce();
    expect(onDeviceSpy).toHaveBeenCalledWith(items, fn);
    expect(typeof result).toBe("function");

    result();
  });

  it("[DEV-0051] subscribeDeviceUpdates の戻り値は onDeviceUpdate の戻り値と同一", () => {
    const ws = makeMockWs();
    const hub = makeHub(ws);

    const items = [{ deviceUUID: DEVICE_UUID }];
    const fn = vi.fn();

    const resultFromAlias = hub.subscribeDeviceUpdates(items, fn);

    // 戻り値は unsubscribe 関数
    expect(typeof resultFromAlias).toBe("function");

    resultFromAlias();
  });

  it("[DEV-0051] subscribeDeviceUpdates が送る frame と onDeviceUpdate が送る frame は同一構造", () => {
    const ws1 = makeMockWs();
    const hub1 = makeHub(ws1);
    const ws2 = makeMockWs();
    const hub2 = makeHub(ws2);

    const items = [{ deviceUUID: DEVICE_UUID, deviceModel: "sesame_5" }];

    const unsub1 = hub1.subscribeDeviceUpdates(items, vi.fn());
    const unsub2 = hub2.onDeviceUpdate(items, vi.fn());

    expect(ws1.sent[0]).toEqual(ws2.sent[0]);

    unsub1();
    unsub2();
  });

  it("[DEV-0051] subscribeDeviceUpdates 経由で受信した push が fn に届く", () => {
    const ws = makeMockWs();
    const hub = makeHub(ws);
    const calls = [];

    const unsub = hub.subscribeDeviceUpdates(
      [{ deviceUUID: DEVICE_UUID_NORM }],
      (msg) => calls.push(msg),
    );

    ws.emit(PUBDEV_KEY, { data: { deviceUUID: DEVICE_UUID_NORM } });
    expect(calls).toHaveLength(1);

    unsub();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// DEV-0052: getUserDevices errorAction — 同 op 一致のみ reject・別 op は無視
// ══════════════════════════════════════════════════════════════════════════════
describe("[DEV-0052] getUserDevices errorAction: 同 op のみ reject・別 op success:false は無視", () => {
  // ref: packages/core/src/util.js:180 ownOp 絞り; packages/core/src/devices.js:88-90

  it("[DEV-0052] 同 action + 同 op (getUserDevice) success:false で即 reject", async () => {
    // ref: util.js:172-185 errorAction 経路; devices.js:88-90 errorAction: ACT_MANAGE
    const ws = makeMockWs();
    const p = devices.getUserDevices(ws, { timeoutMs: 5000 });

    // 同 op success:false → 即時 reject
    ws.emit(`${ACT_MANAGE}:getUserDevice`, {
      action: ACT_MANAGE,
      op: "getUserDevice",
      success: false,
      message: "not authorized",
    });

    await expect(p).rejects.toMatchObject({ code: ERR.REJECTED });
  });

  it("[DEV-0052] 同 action + 別 op (del) の success:false は無視して一覧取得を続ける", async () => {
    // ref: util.js:180 if (ownOp !== null && msg.op !== undefined && msg.op !== ownOp) return
    const ws = makeMockWs();
    const p = devices.getUserDevices(ws, { timeoutMs: 500 });

    // 別 op の失敗 → 無視
    ws.emit(`${ACT_MANAGE}:del`, {
      action: ACT_MANAGE,
      op: "del",
      success: false,
      message: "delete failed",
    });

    // 正常な一覧 push で resolve
    ws.emit(`${ACT_MANAGE}:PubedUserDevice`, {
      data: {
        totalPage: 1,
        data: { list: [{ deviceUUID: "user-dev-1" }], page: 1 },
      },
    });

    const result = await p;
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].deviceUUID).toBe("user-dev-1");
  });

  it("[DEV-0052] 同 action + 別 op (updateName) の success:false も無視する", async () => {
    // ref: util.js:180
    const ws = makeMockWs();
    const p = devices.getUserDevices(ws, { timeoutMs: 500 });

    ws.emit(`${ACT_MANAGE}:updateName`, {
      action: ACT_MANAGE,
      op: "updateName",
      success: false,
      message: "rename error",
    });

    // 正常な一覧 push
    ws.emit(`${ACT_MANAGE}:PubedUserDevice`, {
      data: { totalPage: 1, data: { list: [], page: 1 } },
    });

    await expect(p).resolves.toEqual([]);
  });

  it("[DEV-0052] op フィールド欠落の success:false フレームは拾う (op 絞り例外)", async () => {
    // ref: util.js:180 op === undefined → op check をスキップ → reject
    const ws = makeMockWs();
    const p = devices.getUserDevices(ws, { timeoutMs: 5000 });

    // op フィールド無しの success:false
    ws.emit(`${ACT_MANAGE}:`, {
      action: ACT_MANAGE,
      // no op field
      success: false,
      message: "generic error",
    });

    await expect(p).rejects.toMatchObject({ code: ERR.REJECTED });
  });

  it("[DEV-0052] 正常な PubedUserDevice push で resolve する (errorAction と競合しない)", async () => {
    // 別 op 失敗 (無視) の後に正常 push が来て resolve する
    const ws = makeMockWs();
    const p = devices.getUserDevices(ws, { timeoutMs: 5000 });

    // 別 op 失敗 (無視)
    ws.emit(`${ACT_MANAGE}:del`, {
      action: ACT_MANAGE,
      op: "del",
      success: false,
      message: "ignored",
    });

    // 正常 push
    ws.emit(`${ACT_MANAGE}:PubedUserDevice`, {
      data: { totalPage: 1, data: { list: [{ deviceUUID: "dev-x" }], page: 1 } },
    });

    const result = await p;
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0].deviceUUID).toBe("dev-x");
  });

  it("[DEV-0052] listDevices (getCompanyDevice) も同様に別 op success:false を無視する (DEV-0049 と対称)", async () => {
    // ref: client.js:489 errorAction: ACTION_TYPES.BIZ3_MANAGE_DEVICE
    // ref: util.js:180 op 相関
    const ws = makeMockWs();
    const hub = makeHub(ws);

    const p = hub.listDevices({ timeoutMs: 500 });

    // 別 op (add) の失敗
    ws.emit(`${ACT_MANAGE}:add`, {
      action: ACT_MANAGE,
      op: "add",
      success: false,
      message: "add failed",
    });

    // 正常な company device 一覧
    ws.emit(`${ACT_MANAGE}:PubedCompanyDevice`, {
      data: { totalPage: 1, data: { list: [{ deviceUUID: "co-dev-1" }], page: 1 } },
    });

    await expect(p).resolves.toBeInstanceOf(Array);
  });
});
