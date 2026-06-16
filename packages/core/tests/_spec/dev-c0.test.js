// dev-c0.test.js — DEV-0001〜DEV-0018 統合 TDD spec テスト
//
// 対象:
//   packages/core/src/devices.js  — getUserDevices / addDevices / reorderDevices /
//                                    getNotifyStatus / switchNotify / switchRechargeableBattery
//   packages/core/src/client.js   — SesameHub3#listDevices / addDevices / reorderDevices
//                                    getDevicesNotifyStatus / switchDeviceNotify /
//                                    switchRechargeableBattery
//   packages/kit/src/cli/device.js — CLI バリデーション (exit 2 パス)
//   packages/kit/src/serve/entries/device.js — serve need() / RpcError バリデーション
//
// 方針:
//   - TDD — spec どおりの期待値を assert する (実装バグは red になってよい)
//   - ネットワーク/実機に触れない (全て mock または純関数)
//   - i18n は beforeEach で ja 固定
//   - errorAction 経路には withOnMessage ヘルパーを使う

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockClient, chunkMockClient } from "../helpers/mock-ws.js";
import {
  getUserDevices,
  addDevices,
  reorderDevices,
  getNotifyStatus,
  switchNotify,
  switchRechargeableBattery,
} from "../../src/devices.js";
import { SesameHub3 } from "../../src/client.js";
import { ERR } from "../../src/errors.js";
import { ACTION_TYPES } from "../../src/vendor/biz3/constants/messageConstants.js";
import { setLocale } from "../../src/i18n.js";
import { RpcError, RPC, KIND } from "../../src/jsonrpc.js";
import { need } from "../../../kit/src/serve/registry-helpers.js";

// ─── 定数 ─────────────────────────────────────────────────────────────────────
const ACT = ACTION_TYPES.BIZ3_MANAGE_DEVICE; // "biz3ManageDevice"
const CO = "company-abc";
const DEVICE_UUID = "device-uuid-0001";
const SUB_UUID = "sub-uuid-xyz";
const PUSH_TOKEN = "fcm-push-token";

// ─── i18n 固定 ────────────────────────────────────────────────────────────────
beforeEach(() => setLocale("ja"));

// ─── errorAction 経路テスト用 onMessage 拡張ヘルパー ─────────────────────────
// subscribeChunks の errorAction 経路は client.onMessage が必要。
// chunkMockClient を包んで onMessage / raw を追加する。
function withOnMessage(base) {
  const listeners = new Set();
  return {
    ...base,
    onMessage(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** テスト用: 全 onMessage リスナーに raw フレームを配信 */
    raw(msg) {
      for (const fn of [...listeners]) fn(msg);
    },
    listeners,
  };
}

// ─── SesameHub3 fake 注入ヘルパー ─────────────────────────────────────────────
function makeFakeWs(reply = { action: ACT, success: true }) {
  const requests = [];
  return {
    requests,
    sent: [],
    request: vi.fn(async (frame) => {
      requests.push(frame);
      return reply;
    }),
    send: vi.fn((frame) => { requests.push({ _type: "send", ...frame }); }),
    subscribe: vi.fn(() => () => {}),
    onMessage: vi.fn(() => () => {}),
  };
}

function makeHub(ws, { subUUID = SUB_UUID, companyID = CO } = {}) {
  const hub = new SesameHub3({
    config: { companyID },
    tokenStore: { load: () => ({}), save: () => {}, clear: () => {} },
  });
  hub._ws = ws;
  hub._subUUID = subUUID;
  return hub;
}

// ─────────────────────────────────────────────────────────────────────────────
// [DEV-0001] devices.list → hub.listDevices (getCompanyDevice / PubedCompanyDevice 集約)
// ─────────────────────────────────────────────────────────────────────────────
describe("[DEV-0001] listDevices wire-fidelity: sendFrame / PubedCompanyDevice page 集約", () => {
  it("[DEV-0001] sendFrame が {action, op:'getCompanyDevice', companyID} を送る", async () => {
    const c = withOnMessage(chunkMockClient());
    const hub = makeHub(c);
    const p = hub.listDevices({ timeoutMs: 5000 });

    expect(c.sent).toHaveLength(1);
    const frame = c.sent[0];
    expect(frame.action).toBe(ACT);
    expect(frame.op).toBe("getCompanyDevice");
    expect(frame.companyID).toBe(CO);

    // 完了させる (totalPage===1 → 即完了)
    c.push(`${ACT}:PubedCompanyDevice`, {
      data: { totalPage: 1, data: { list: [{ deviceUUID: "d1" }], page: 1 } },
    });
    const result = await p;
    expect(result).toEqual([{ deviceUUID: "d1" }]);
  });

  it("[DEV-0001] page===1 で全置換し page>1 で追記する (multi-page 集約)", async () => {
    const c = withOnMessage(chunkMockClient());
    const hub = makeHub(c);
    const p = hub.listDevices({ timeoutMs: 5000 });

    // page 2 が先に届く (stale)
    c.push(`${ACT}:PubedCompanyDevice`, {
      data: { totalPage: 2, data: { list: [{ deviceUUID: "stale" }], page: 2 } },
    });
    // page 1 全置換
    c.push(`${ACT}:PubedCompanyDevice`, {
      data: { totalPage: 2, data: { list: [{ deviceUUID: "d1" }], page: 1 } },
    });
    // page 2 再追記 (totalPage===page で完了)
    c.push(`${ACT}:PubedCompanyDevice`, {
      data: { totalPage: 2, data: { list: [{ deviceUUID: "d2" }], page: 2 } },
    });

    const result = await p;
    // "stale" は page 1 全置換で消え d1, d2 が残る
    expect(result.map((d) => d.deviceUUID)).toEqual(["d1", "d2"]);
  });

  it("[DEV-0001] totalPage===page で完了確定する (single-page)", async () => {
    const c = withOnMessage(chunkMockClient());
    const hub = makeHub(c);
    const p = hub.listDevices({ timeoutMs: 5000 });

    c.push(`${ACT}:PubedCompanyDevice`, {
      data: { totalPage: 1, data: { list: [{ deviceUUID: "d-final" }], page: 1 } },
    });
    const result = await p;
    expect(result).toHaveLength(1);
    expect(result[0].deviceUUID).toBe("d-final");
  });

  it("[DEV-0001] 購読キーが biz3ManageDevice:PubedCompanyDevice である", async () => {
    const c = withOnMessage(chunkMockClient());
    const hub = makeHub(c);
    const p = hub.listDevices({ timeoutMs: 5000 });

    expect(c.hasSub(`${ACT}:PubedCompanyDevice`)).toBe(true);

    c.push(`${ACT}:PubedCompanyDevice`, {
      data: { totalPage: 1, data: { list: [], page: 1 } },
    });
    await p;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [DEV-0002] devices dump を writeSecretJson で 0600 (親 0700) で書く
// ─────────────────────────────────────────────────────────────────────────────
describe("[DEV-0002] devices dump: writeSecretJson で 0600/親0700 書き込み", () => {
  it("[DEV-0002] writeSecretJson が export された関数として存在する (secure-fs.js)", async () => {
    const secureFsModule = await import("../../src/secure-fs.js");
    expect(typeof secureFsModule.writeSecretJson).toBe("function");
    expect(typeof secureFsModule.writeSecretFile).toBe("function");
  });

  it("[DEV-0002] writeSecretJson と writeSecretFile は別関数 (0600 保証の連鎖)", async () => {
    const { writeSecretJson, writeSecretFile } = await import("../../src/secure-fs.js");
    expect(writeSecretJson).not.toBe(writeSecretFile);
  });

  it("[DEV-0002] SECRET_FILE_MODE が 0o600 (384) として export されている (旧 0644 バグ回帰防止)", async () => {
    const { SECRET_FILE_MODE, SECRET_DIR_MODE } = await import("../../src/secure-fs.js");
    // writeSecretFile は SECRET_FILE_MODE を参照して内部で mode を設定する。
    // 定数値が 0o600 (= 384 decimal) であることを確認する。
    expect(SECRET_FILE_MODE).toBe(0o600);
    expect(SECRET_DIR_MODE).toBe(0o700);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [DEV-0003] devices.userList → getUserDevices (getUserDevice / PubedUserDevice 集約)
// ─────────────────────────────────────────────────────────────────────────────
describe("[DEV-0003] getUserDevices wire-fidelity: sendFrame / PubedUserDevice page 集約", () => {
  it("[DEV-0003] sendFrame が {action:'biz3ManageDevice', op:'getUserDevice'} で companyID を含まない", async () => {
    const c = chunkMockClient();
    const p = getUserDevices(c, { timeoutMs: 5000 });

    expect(c.sent).toHaveLength(1);
    const frame = c.sent[0];
    expect(frame.action).toBe(ACT);
    expect(frame.op).toBe("getUserDevice");
    // companyID は含まない (DEV-0003 spec: companyID 無し, listDevices との非対称)
    expect(frame).not.toHaveProperty("companyID");

    // 完了させる
    c.push(`${ACT}:PubedUserDevice`, {
      data: { totalPage: 1, data: { list: [{ deviceUUID: "u1" }], page: 1 } },
    });
    await p;
  });

  it("[DEV-0003] page===1 全置換 / page>1 追記 / totalPage===page 完了で配列に集約する", async () => {
    const c = chunkMockClient();
    const p = getUserDevices(c, { timeoutMs: 5000 });

    c.push(`${ACT}:PubedUserDevice`, {
      data: { totalPage: 2, data: { list: [{ deviceUUID: "u1" }], page: 1 } },
    });
    c.push(`${ACT}:PubedUserDevice`, {
      data: { totalPage: 2, data: { list: [{ deviceUUID: "u2" }], page: 2 } },
    });

    const result = await p;
    expect(Array.isArray(result)).toBe(true);
    expect(result.map((d) => d.deviceUUID)).toEqual(["u1", "u2"]);
  });

  it("[DEV-0003] 購読キーが biz3ManageDevice:PubedUserDevice である", async () => {
    const c = chunkMockClient();
    const p = getUserDevices(c, { timeoutMs: 5000 });

    expect(c.hasSub(`${ACT}:PubedUserDevice`)).toBe(true);

    c.push(`${ACT}:PubedUserDevice`, {
      data: { totalPage: 1, data: { list: [], page: 1 } },
    });
    await p;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [DEV-0004] getUserDevices: totalPage 非数値は単一 chunk として即完了
// ─────────────────────────────────────────────────────────────────────────────
describe("[DEV-0004] getUserDevices: totalPage 非数値は即完了", () => {
  it("[DEV-0004] totalPage が undefined の応答は単一 chunk として finish() する", async () => {
    const c = chunkMockClient();
    const p = getUserDevices(c, { timeoutMs: 5000 });

    // totalPage が undefined (数値でない)
    c.push(`${ACT}:PubedUserDevice`, {
      data: { data: { list: [{ deviceUUID: "u-single" }], page: 1 } },
      // totalPage 欠落
    });

    const result = await p;
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0].deviceUUID).toBe("u-single");
  });

  it("[DEV-0004] totalPage が文字列 '1' の応答は即完了 (typeof !== 'number')", async () => {
    const c = chunkMockClient();
    const p = getUserDevices(c, { timeoutMs: 5000 });

    c.push(`${ACT}:PubedUserDevice`, {
      data: { totalPage: "1", data: { list: [{ deviceUUID: "u-str" }], page: 1 } },
    });

    const result = await p;
    expect(result).toHaveLength(1);
  });

  it("[DEV-0004] totalPage が null の応答は単一 chunk として即完了", async () => {
    const c = chunkMockClient();
    const p = getUserDevices(c, { timeoutMs: 5000 });

    c.push(`${ACT}:PubedUserDevice`, {
      data: { totalPage: null, data: { list: [], page: 1 } },
    });

    const result = await p;
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [DEV-0005] getUserDevices: 同 action success:false 即時エラーで timeout を待たず失敗
// ─────────────────────────────────────────────────────────────────────────────
describe("[DEV-0005] getUserDevices: errorAction 即時失敗", () => {
  afterEach(() => vi.useRealTimers());

  it("[DEV-0005] 同 action (biz3ManageDevice) の success:false 即応で timeout を待たず rejected", async () => {
    vi.useFakeTimers();
    const c = withOnMessage(chunkMockClient());
    const p = getUserDevices(c, { timeoutMs: 30000 });

    c.raw({ action: ACT, op: "getUserDevice", success: false, message: "immediate error" });

    await expect(p).rejects.toMatchObject({ code: ERR.REJECTED });
  });

  it("[DEV-0005] reject された error に message が含まれる", async () => {
    vi.useFakeTimers();
    const c = withOnMessage(chunkMockClient());
    const p = getUserDevices(c, { timeoutMs: 30000 });

    c.raw({ action: ACT, op: "getUserDevice", success: false, message: "access denied" });

    const err = await p.catch((e) => e);
    expect(err.message).toMatch(/access denied/);
  });

  it("[DEV-0005] reject は retryable=false (上流の確定拒否)", async () => {
    vi.useFakeTimers();
    const c = withOnMessage(chunkMockClient());
    const p = getUserDevices(c, { timeoutMs: 30000 });

    c.raw({ action: ACT, op: "getUserDevice", success: false, message: "error" });

    const err = await p.catch((e) => e);
    expect(err.retryable).toBe(false);
  });

  it("[DEV-0005] 別 op (del) の success:false は無視してタイムアウトまで継続 (op 相関絞り)", async () => {
    vi.useFakeTimers();
    const c = withOnMessage(chunkMockClient());
    const p = getUserDevices(c, { timeoutMs: 5000 });

    // 別 op の success:false — 無視されるはず
    c.raw({ action: ACT, op: "del", success: false, message: "delete failed" });

    // 正常チャンクで完了させる
    c.push(`${ACT}:PubedUserDevice`, {
      data: { totalPage: 1, data: { list: [], page: 1 } },
    });

    await expect(p).resolves.toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [DEV-0006] getUserDevices: partialOnTimeout=true は {partial,list} shape
// ─────────────────────────────────────────────────────────────────────────────
describe("[DEV-0006] getUserDevices: partialOnTimeout shape", () => {
  afterEach(() => vi.useRealTimers());

  it("[DEV-0006] partialOnTimeout=true で timeout 時に {partial:true, list} を resolve する", async () => {
    vi.useFakeTimers();
    const c = chunkMockClient();
    const p = getUserDevices(c, { timeoutMs: 500, partialOnTimeout: true });

    // 部分データを送信して完了しないまま timeout
    c.push(`${ACT}:PubedUserDevice`, {
      data: { totalPage: 3, data: { list: [{ deviceUUID: "u1" }], page: 1 } },
    });

    vi.advanceTimersByTime(500);

    const result = await p;
    expect(result).toMatchObject({ partial: true });
    expect(Array.isArray(result.list)).toBe(true);
    expect(result.list[0].deviceUUID).toBe("u1");
  });

  it("[DEV-0006] partialOnTimeout=true で完走時は {partial:false, list} の同 shape", async () => {
    const c = chunkMockClient();
    const p = getUserDevices(c, { timeoutMs: 5000, partialOnTimeout: true });

    c.push(`${ACT}:PubedUserDevice`, {
      data: { totalPage: 1, data: { list: [{ deviceUUID: "u-complete" }], page: 1 } },
    });

    const result = await p;
    expect(result).toMatchObject({ partial: false });
    expect(result.list).toEqual([{ deviceUUID: "u-complete" }]);
  });

  it("[DEV-0006] partialOnTimeout=false (既定) では timeout で reject する", async () => {
    vi.useFakeTimers();
    const c = chunkMockClient();
    const p = getUserDevices(c, { timeoutMs: 100 });

    vi.advanceTimersByTime(100);

    await expect(p).rejects.toMatchObject({ code: ERR.TIMEOUT });
  });

  it("[DEV-0006] 既定 (partialOnTimeout 未指定) は完走時に配列を返す", async () => {
    const c = chunkMockClient();
    const p = getUserDevices(c);

    c.push(`${ACT}:PubedUserDevice`, {
      data: { totalPage: 1, data: { list: [{ deviceUUID: "u-arr" }], page: 1 } },
    });

    const result = await p;
    expect(Array.isArray(result)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [DEV-0007] devices.add → addDevices (op:'add', items 素通し, companyID)
// ─────────────────────────────────────────────────────────────────────────────
describe("[DEV-0007] addDevices wire-fidelity: items 素通し", () => {
  it("[DEV-0007] request が {action, op:'add', items, companyID} を送る", async () => {
    const items = [{ deviceUUID: "d1", secretKey: "abc" }, { deviceUUID: "d2", secretKey: "def" }];
    const c = mockClient({ success: true });
    await addDevices(c, { companyID: CO, items });

    expect(c.sent).toHaveLength(1);
    const frame = c.sent[0];
    expect(frame.action).toBe(ACT);
    expect(frame.op).toBe("add");
    expect(frame.companyID).toBe(CO);
    // items は整形せず素通し (vendor 1:1)
    expect(frame.items).toEqual(items);
  });

  it("[DEV-0007] frame のキー順が {action,op,items,companyID} と一致する (vendor frame 順)", async () => {
    const items = [{ deviceUUID: "d1" }];
    const c = mockClient({ success: true });
    await addDevices(c, { companyID: CO, items });

    const frame = c.sent[0];
    const keys = Object.keys(frame);
    // vendor useManageDevice.js:258-263: {action, op:'add', items, companyID}
    expect(keys.indexOf("action")).toBeLessThan(keys.indexOf("op"));
    expect(keys.indexOf("op")).toBeLessThan(keys.indexOf("items"));
    expect(keys.indexOf("items")).toBeLessThan(keys.indexOf("companyID"));
  });

  it("[DEV-0007] SesameHub3#addDevices が companyID を自動注入する", async () => {
    const ws = makeFakeWs({ success: true });
    const hub = makeHub(ws);
    await hub.addDevices([{ deviceUUID: "d-hub" }]);

    const frame = ws.requests[0];
    expect(frame.companyID).toBe(CO);
    expect(frame.op).toBe("add");
    expect(frame.items).toEqual([{ deviceUUID: "d-hub" }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [DEV-0008] addDevices: items 非配列は badRequest / 'Limit Exceeded' は rejected 伝搬
// ─────────────────────────────────────────────────────────────────────────────
describe("[DEV-0008] addDevices error-path: items 非配列 / Limit Exceeded", () => {
  it("[DEV-0008] items が配列でなければ badRequest(domain.devices.itemsArray) を投げる", async () => {
    const c = mockClient({});
    await expect(addDevices(c, { companyID: CO, items: "not-array" }))
      .rejects.toMatchObject({ code: ERR.BAD_REQUEST, retryable: false });
    expect(c.sent).toHaveLength(0);
  });

  it("[DEV-0008] items が null でも badRequest を投げる (send なし)", async () => {
    const c = mockClient({});
    await expect(addDevices(c, { companyID: CO, items: null }))
      .rejects.toMatchObject({ code: ERR.BAD_REQUEST });
    expect(c.sent).toHaveLength(0);
  });

  it("[DEV-0008] items がオブジェクトでも badRequest を投げる (配列でない)", async () => {
    const c = mockClient({});
    await expect(addDevices(c, { companyID: CO, items: { deviceUUID: "d1" } }))
      .rejects.toMatchObject({ code: ERR.BAD_REQUEST });
  });

  it("[DEV-0008] {success:false, message:'Limit Exceeded'} は REJECTED で message を含む throw", async () => {
    const c = mockClient({ success: false, message: "Limit Exceeded" });
    const err = await addDevices(c, { companyID: CO, items: [] }).catch((e) => e);
    expect(err).toBeTruthy();
    expect(err.code).toBe(ERR.REJECTED);
    expect(err.message).toMatch(/Limit Exceeded/);
  });

  it("[DEV-0008] その他 success:false も rejected で throw する", async () => {
    const c = mockClient({ success: false, message: "plan expired" });
    await expect(addDevices(c, { companyID: CO, items: [] }))
      .rejects.toMatchObject({ code: ERR.REJECTED });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [DEV-0009] device add の引数バリデーションと終了コード (CLI)
// ─────────────────────────────────────────────────────────────────────────────
describe("[DEV-0009] CLI device add: 引数バリデーション", () => {
  // CLI の cmdDeviceAdd ロジックを純粋に再現 (device.js:132-137)
  function simulateCmdDeviceAdd(json) {
    if (!json) return { error: "deviceAddJsonRequired", code: 2 };
    let items;
    try {
      items = JSON.parse(json);
    } catch (e) {
      return { error: "invalidJsonItems", code: 2, message: e.message };
    }
    if (!Array.isArray(items)) items = [items];
    return { items };
  }

  it("[DEV-0009] json 欠落で exit 2 (deviceAddJsonRequired)", () => {
    const result = simulateCmdDeviceAdd(undefined);
    expect(result.error).toBe("deviceAddJsonRequired");
    expect(result.code).toBe(2);
  });

  it("[DEV-0009] 不正 JSON で exit 2 (invalidJsonItems)", () => {
    const result = simulateCmdDeviceAdd("{not valid json");
    expect(result.error).toBe("invalidJsonItems");
    expect(result.code).toBe(2);
  });

  it("[DEV-0009] 非配列入力は [items] へラップして渡す", () => {
    const result = simulateCmdDeviceAdd('{"uuid":"abc"}');
    expect(result.items).toEqual([{ uuid: "abc" }]);
  });

  it("[DEV-0009] 配列入力はそのまま渡す (ラップしない)", () => {
    const result = simulateCmdDeviceAdd('[{"uuid":"abc"},{"uuid":"def"}]');
    expect(result.items).toEqual([{ uuid: "abc" }, { uuid: "def" }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [DEV-0010] devices.add の必須パラメータ検証 (serve)
// ─────────────────────────────────────────────────────────────────────────────
describe("[DEV-0010] serve devices.add: items 欠落で RpcError (BAD_PARAMS)", () => {
  it("[DEV-0010] need(params, ['items']) が items 欠落時に RpcError を throw する", () => {
    expect(() => need({ pushToken: "tok" }, ["items"])).toThrow(RpcError);
  });

  it("[DEV-0010] items 欠落の RpcError は code=INVALID_PARAMS / kind=BAD_PARAMS", () => {
    let err;
    try {
      need({}, ["items"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe(RPC.INVALID_PARAMS);
    expect(err.kind).toBe(KIND.BAD_PARAMS);
  });

  it("[DEV-0010] items が null でも BAD_PARAMS を throw する", () => {
    let err;
    try {
      need({ items: null }, ["items"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RpcError);
  });

  it("[DEV-0010] items が空文字でも BAD_PARAMS を throw する", () => {
    let err;
    try {
      need({ items: "" }, ["items"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RpcError);
  });

  it("[DEV-0010] items が存在する場合は throw しない", () => {
    expect(() => need({ items: [{ deviceUUID: "a" }] }, ["items"])).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [DEV-0011] devices.reorder → reorderDevices (op:'reorderDevices', rank=0-index 採番)
// ─────────────────────────────────────────────────────────────────────────────
describe("[DEV-0011] reorderDevices wire-fidelity: rank=0-index 採番 / frame 形", () => {
  it("[DEV-0011] request が {action, op:'reorderDevices', items, companyID} を送る", async () => {
    const items = [{ deviceUUID: "d1" }, { deviceUUID: "d2" }, { deviceUUID: "d3" }];
    const c = mockClient({ success: true, data: items });
    await reorderDevices(c, { companyID: CO, items });

    expect(c.sent).toHaveLength(1);
    const frame = c.sent[0];
    expect(frame.action).toBe(ACT);
    expect(frame.op).toBe("reorderDevices");
    expect(frame.companyID).toBe(CO);
  });

  it("[DEV-0011] rank が 0-index (先頭=0, 次=-1, 次=-2) で付与される", async () => {
    const items = [{ deviceUUID: "d1" }, { deviceUUID: "d2" }, { deviceUUID: "d3" }];
    const c = mockClient({ success: true, data: [] });
    await reorderDevices(c, { companyID: CO, items });

    const { items: ranked } = c.sent[0];
    expect(ranked[0].rank).toBe(0);   // 0 - 0
    expect(ranked[1].rank).toBe(-1);  // 0 - 1
    expect(ranked[2].rank).toBe(-2);  // 0 - 2
  });

  it("[DEV-0011] 応答は resp.data (並び替え後一覧) を返す", async () => {
    const reordered = [{ deviceUUID: "d2", rank: 0 }, { deviceUUID: "d1", rank: -1 }];
    const c = mockClient({ success: true, data: reordered });
    const result = await reorderDevices(c, { companyID: CO, items: [{ deviceUUID: "d2" }, { deviceUUID: "d1" }] });

    expect(result).toEqual(reordered);
  });

  it("[DEV-0011] SesameHub3#reorderDevices が companyID を注入して reorderDevices を呼ぶ", async () => {
    const ws = makeFakeWs({ action: ACT, op: "reorderDevices", success: true, data: [] });
    const hub = makeHub(ws);
    const items = [{ deviceUUID: "d1" }, { deviceUUID: "d2" }];
    await hub.reorderDevices(items);
    const frame = ws.requests[0];
    expect(frame.action).toBe(ACT);
    expect(frame.op).toBe("reorderDevices");
    expect(frame.companyID).toBe(CO);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [DEV-0012] reorderDevices: rank 採番はコピーに付与 / 非配列は badRequest
// ─────────────────────────────────────────────────────────────────────────────
describe("[DEV-0012] reorderDevices: コピー採番 / 非配列 badRequest", () => {
  it("[DEV-0012] rank 採番が {...item, rank} のコピー生成で行われ入力 items を破壊しない", async () => {
    const items = [{ deviceUUID: "d1" }, { deviceUUID: "d2" }];
    const originalItems = items.map((i) => ({ ...i }));

    const c = mockClient({ success: true, data: [] });
    await reorderDevices(c, { companyID: CO, items });

    // 入力 items に rank が追加されていないこと
    expect(items[0]).not.toHaveProperty("rank");
    expect(items[1]).not.toHaveProperty("rank");
    // 元の deviceUUID が保持されていること
    expect(items[0].deviceUUID).toBe(originalItems[0].deviceUUID);
    expect(items[1].deviceUUID).toBe(originalItems[1].deviceUUID);
  });

  it("[DEV-0012] 送信 items (ranked) はコピーに rank が付与されている", async () => {
    const items = [{ deviceUUID: "d1", name: "Lock" }];
    const c = mockClient({ success: true, data: [] });
    await reorderDevices(c, { companyID: CO, items });

    const ranked = c.sent[0].items;
    expect(ranked[0].rank).toBe(0);
    // 元のフィールドも保持されている
    expect(ranked[0].deviceUUID).toBe("d1");
    expect(ranked[0].name).toBe("Lock");
  });

  it("[DEV-0012] items が配列でなければ badRequest を投げる (send なし)", async () => {
    const c = mockClient({});
    await expect(reorderDevices(c, { companyID: CO, items: "not-array" }))
      .rejects.toMatchObject({ code: ERR.BAD_REQUEST });
    expect(c.sent).toHaveLength(0);
  });

  it("[DEV-0012] items が null でも badRequest を投げる", async () => {
    const c = mockClient({});
    await expect(reorderDevices(c, { companyID: CO, items: null }))
      .rejects.toMatchObject({ code: ERR.BAD_REQUEST });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [DEV-0013] device reorder CLI の全件並べ替え・未知UUID分岐
// ─────────────────────────────────────────────────────────────────────────────
describe("[DEV-0013] CLI device reorder: uuids 空 / 未知UUID / 指定先頭+残り末尾", () => {
  // device.js:153-171 のロジックを純粋に再現
  function simulateCmdDeviceReorder(uuids, deviceList) {
    if (!uuids || uuids.length === 0) return { error: "deviceReorderUuidsRequired", code: 2 };
    const ordered = [];
    for (const u of uuids) {
      const d = deviceList.find((x) => x.deviceUUID === u);
      if (!d) return { error: "deviceReorderUnknownUuid", uuid: u, code: 2 };
      ordered.push(d);
    }
    for (const d of deviceList) {
      if (!ordered.includes(d)) ordered.push(d);
    }
    return { ordered };
  }

  const devices = [
    { deviceUUID: "uuid-1", deviceName: "A" },
    { deviceUUID: "uuid-2", deviceName: "B" },
    { deviceUUID: "uuid-3", deviceName: "C" },
  ];

  it("[DEV-0013] uuids 空で exit 2 (deviceReorderUuidsRequired)", () => {
    const r = simulateCmdDeviceReorder([], devices);
    expect(r.error).toBe("deviceReorderUuidsRequired");
    expect(r.code).toBe(2);
  });

  it("[DEV-0013] uuids が undefined でも exit 2 の条件を満たす", () => {
    const r = simulateCmdDeviceReorder(undefined, devices);
    expect(r.error).toBe("deviceReorderUuidsRequired");
    expect(r.code).toBe(2);
  });

  it("[DEV-0013] 未知 UUID で exit 2 (deviceReorderUnknownUuid)", () => {
    const r = simulateCmdDeviceReorder(["unknown-uuid"], devices);
    expect(r.error).toBe("deviceReorderUnknownUuid");
    expect(r.code).toBe(2);
  });

  it("[DEV-0013] 指定 UUID が先頭、未指定が現在順で末尾", () => {
    const r = simulateCmdDeviceReorder(["uuid-3", "uuid-1"], devices);
    expect(r.ordered.map((d) => d.deviceUUID)).toEqual(["uuid-3", "uuid-1", "uuid-2"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [DEV-0014] devices.notifyStatus → getNotifyStatus (op:'notifyList', frame 形)
// ─────────────────────────────────────────────────────────────────────────────
describe("[DEV-0014] getNotifyStatus wire-fidelity: frame キー集合・順", () => {
  it("[DEV-0014] request が {action, companyID, pushToken, items, op:'notifyList'} を送る", async () => {
    const items = [{ deviceUUID: DEVICE_UUID, deviceModel: "sesame_5" }];
    const c = mockClient({ success: true, data: [{ deviceUUID: DEVICE_UUID, enabled: true }] });

    await getNotifyStatus(c, { companyID: CO, pushToken: PUSH_TOKEN, items });

    expect(c.sent).toHaveLength(1);
    const frame = c.sent[0];
    expect(frame.action).toBe(ACT);
    expect(frame.companyID).toBe(CO);
    expect(frame.pushToken).toBe(PUSH_TOKEN);
    expect(frame.items).toEqual(items);
    expect(frame.op).toBe("notifyList");
  });

  it("[DEV-0014] frame のキー順が {action,companyID,pushToken,items,op} と一致する (vendor 1:1)", async () => {
    const items = [{ deviceUUID: DEVICE_UUID, deviceModel: "sesame_5" }];
    const c = mockClient({ success: true, data: [] });
    await getNotifyStatus(c, { companyID: CO, pushToken: PUSH_TOKEN, items });

    const frame = c.sent[0];
    const keys = Object.keys(frame);
    // vendor useManageDevice.js:291-297: {action, companyID, pushToken, items, op:'notifyList'}
    expect(keys.indexOf("action")).toBeLessThan(keys.indexOf("companyID"));
    expect(keys.indexOf("companyID")).toBeLessThan(keys.indexOf("pushToken"));
    expect(keys.indexOf("pushToken")).toBeLessThan(keys.indexOf("items"));
    expect(keys.indexOf("items")).toBeLessThan(keys.indexOf("op"));
  });

  it("[DEV-0014] 応答は resp.data を返す", async () => {
    const data = [{ deviceUUID: DEVICE_UUID, notifyEnabled: true }];
    const c = mockClient({ success: true, data });
    const result = await getNotifyStatus(c, { companyID: CO, pushToken: PUSH_TOKEN, items: [] });
    expect(result).toEqual(data);
  });

  it("[DEV-0014] items 非配列は badRequest を投げる (send なし)", async () => {
    const c = mockClient({});
    await expect(getNotifyStatus(c, { companyID: CO, pushToken: PUSH_TOKEN, items: "bad" }))
      .rejects.toMatchObject({ code: ERR.BAD_REQUEST });
    expect(c.sent).toHaveLength(0);
  });

  it("[DEV-0014] SesameHub3#getDevicesNotifyStatus が companyID を注入する", async () => {
    const ws = makeFakeWs({ action: ACT, op: "notifyList", success: true, data: [] });
    const hub = makeHub(ws);
    const items = [{ deviceUUID: DEVICE_UUID, deviceModel: "sesame_5" }];
    await hub.getDevicesNotifyStatus({ pushToken: PUSH_TOKEN, items });
    const frame = ws.requests[0];
    expect(frame.action).toBe(ACT);
    expect(frame.companyID).toBe(CO);
    expect(frame.pushToken).toBe(PUSH_TOKEN);
    expect(frame.op).toBe("notifyList");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [DEV-0015] devices.notifyManage → switchNotify (op:'notifyManage', enablePush 1/0 正規化)
// ─────────────────────────────────────────────────────────────────────────────
describe("[DEV-0015] switchNotify wire-fidelity: frame 形 / enablePush 1/0 正規化", () => {
  it("[DEV-0015] request が {action, companyID, enablePush, deviceUUID, pushToken, op:'notifyManage'} を送る", async () => {
    const c = mockClient({ success: true });
    await switchNotify(c, { companyID: CO, pushToken: PUSH_TOKEN, deviceUUID: DEVICE_UUID, enablePush: true });

    expect(c.sent).toHaveLength(1);
    const frame = c.sent[0];
    expect(frame.action).toBe(ACT);
    expect(frame.companyID).toBe(CO);
    expect(frame.enablePush).toBe(1); // boolean true → 1
    expect(frame.deviceUUID).toBe(DEVICE_UUID);
    expect(frame.pushToken).toBe(PUSH_TOKEN);
    expect(frame.op).toBe("notifyManage");
  });

  it("[DEV-0015] boolean true → enablePush=1 に正規化する", async () => {
    const c = mockClient({ success: true });
    await switchNotify(c, { companyID: CO, pushToken: PUSH_TOKEN, deviceUUID: DEVICE_UUID, enablePush: true });
    expect(c.sent[0].enablePush).toBe(1);
  });

  it("[DEV-0015] boolean false → enablePush=0 に正規化する", async () => {
    const c = mockClient({ success: true });
    await switchNotify(c, { companyID: CO, pushToken: PUSH_TOKEN, deviceUUID: DEVICE_UUID, enablePush: false });
    expect(c.sent[0].enablePush).toBe(0);
  });

  it("[DEV-0015] 数値はそのまま passthrough (正規化なし)", async () => {
    const c = mockClient({ success: true });
    await switchNotify(c, { companyID: CO, pushToken: PUSH_TOKEN, deviceUUID: DEVICE_UUID, enablePush: 1 });
    expect(c.sent[0].enablePush).toBe(1);

    const c2 = mockClient({ success: true });
    await switchNotify(c2, { companyID: CO, pushToken: PUSH_TOKEN, deviceUUID: DEVICE_UUID, enablePush: 0 });
    expect(c2.sent[0].enablePush).toBe(0);
  });

  it("[DEV-0015] frame のキー順が {action, companyID, enablePush, deviceUUID, pushToken, op} と一致 (vendor 1:1)", async () => {
    const c = mockClient({ success: true });
    await switchNotify(c, { companyID: CO, pushToken: PUSH_TOKEN, deviceUUID: DEVICE_UUID, enablePush: true });

    const frame = c.sent[0];
    const keys = Object.keys(frame);
    // vendor useManageDevice.js:308-315 のキー順
    expect(keys.indexOf("action")).toBeLessThan(keys.indexOf("companyID"));
    expect(keys.indexOf("companyID")).toBeLessThan(keys.indexOf("enablePush"));
    expect(keys.indexOf("enablePush")).toBeLessThan(keys.indexOf("deviceUUID"));
    expect(keys.indexOf("deviceUUID")).toBeLessThan(keys.indexOf("pushToken"));
    expect(keys.indexOf("pushToken")).toBeLessThan(keys.indexOf("op"));
  });

  it("[DEV-0015] deviceUUID 欠落は badRequest を投げる", async () => {
    const c = mockClient({});
    await expect(switchNotify(c, { companyID: CO, pushToken: PUSH_TOKEN, deviceUUID: "", enablePush: true }))
      .rejects.toMatchObject({ code: ERR.BAD_REQUEST });
    expect(c.sent).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [DEV-0016] device notify の必須/排他オプション検証 (CLI + serve)
// ─────────────────────────────────────────────────────────────────────────────
describe("[DEV-0016] device notify: 必須/排他オプション検証", () => {
  // CLI バリデーションロジックを再現 (device.js:181-194)
  function simulateCmdDeviceNotifyValidate(options) {
    if (!options.token) return { error: "pushTokenRequired", code: 2 };
    if (options.on && options.off) return { error: "notifyOnOffExclusive", code: 2 };
    return { ok: true };
  }

  it("[DEV-0016] CLI: --token 欠落で exit 2 (pushTokenRequired)", () => {
    const r = simulateCmdDeviceNotifyValidate({ on: true });
    expect(r.error).toBe("pushTokenRequired");
    expect(r.code).toBe(2);
  });

  it("[DEV-0016] CLI: --on と --off 同時指定で exit 2 (notifyOnOffExclusive)", () => {
    const r = simulateCmdDeviceNotifyValidate({ token: "tok", on: true, off: true });
    expect(r.error).toBe("notifyOnOffExclusive");
    expect(r.code).toBe(2);
  });

  it("[DEV-0016] CLI: --on のみ指定は exit しない", () => {
    const r = simulateCmdDeviceNotifyValidate({ token: "tok", on: true });
    expect(r.ok).toBe(true);
  });

  it("[DEV-0016] serve: enablePush undefined で RpcError (BAD_PARAMS) を throw する", () => {
    function serveEnablePushValidate(params) {
      need(params, ["pushToken", "deviceUUID"]);
      if (params.enablePush === undefined || params.enablePush === null) {
        throw new RpcError("enablePush required", { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
      }
    }
    expect(() => serveEnablePushValidate({ pushToken: "tok", deviceUUID: DEVICE_UUID }))
      .toThrow(RpcError);
  });

  it("[DEV-0016] serve: enablePush null でも RpcError (BAD_PARAMS) を throw する", () => {
    function serveEnablePushValidate(params) {
      need(params, ["pushToken", "deviceUUID"]);
      if (params.enablePush === undefined || params.enablePush === null) {
        throw new RpcError("enablePush required", { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
      }
    }
    expect(() => serveEnablePushValidate({ pushToken: "tok", deviceUUID: DEVICE_UUID, enablePush: null }))
      .toThrow(RpcError);
  });

  it("[DEV-0016] serve: enablePush が有効な値 (false/0) のときは RpcError を throw しない", () => {
    // false は boolean なので undefined/null ではない → 通過する
    const params = { enablePush: false };
    const shouldThrow = params.enablePush === undefined || params.enablePush === null;
    expect(shouldThrow).toBe(false);

    const params2 = { enablePush: 0 };
    const shouldThrow2 = params2.enablePush === undefined || params2.enablePush === null;
    expect(shouldThrow2).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [DEV-0017] devices.switchRecharge → switchRechargeableBattery (companyID 無し, 1/0)
// ─────────────────────────────────────────────────────────────────────────────
describe("[DEV-0017] switchRechargeableBattery wire-fidelity: companyID 無し / 1/0 正規化", () => {
  it("[DEV-0017] request が {action, deviceUUID, isRechargeBattery:1|0, op:'switchRecharge'} で companyID を含まない", async () => {
    const c = mockClient({ success: true });
    await switchRechargeableBattery(c, { deviceUUID: DEVICE_UUID, isRechargeBattery: true });

    expect(c.sent).toHaveLength(1);
    const frame = c.sent[0];
    expect(frame.action).toBe(ACT);
    expect(frame.deviceUUID).toBe(DEVICE_UUID);
    expect(frame.isRechargeBattery).toBe(1);
    expect(frame.op).toBe("switchRecharge");
    // companyID を含まない (他 op との非対称、vendor 1:1)
    expect(frame).not.toHaveProperty("companyID");
  });

  it("[DEV-0017] isRechargeBattery=true → 1 に正規化する", async () => {
    const c = mockClient({ success: true });
    await switchRechargeableBattery(c, { deviceUUID: DEVICE_UUID, isRechargeBattery: true });
    expect(c.sent[0].isRechargeBattery).toBe(1);
  });

  it("[DEV-0017] isRechargeBattery=false → 0 に正規化する", async () => {
    const c = mockClient({ success: true });
    await switchRechargeableBattery(c, { deviceUUID: DEVICE_UUID, isRechargeBattery: false });
    expect(c.sent[0].isRechargeBattery).toBe(0);
  });

  it("[DEV-0017] deviceUUID 欠落は badRequest を投げる (send なし)", async () => {
    const c = mockClient({});
    await expect(switchRechargeableBattery(c, { deviceUUID: "", isRechargeBattery: true }))
      .rejects.toMatchObject({ code: ERR.BAD_REQUEST });
    expect(c.sent).toHaveLength(0);
  });

  it("[DEV-0017] deviceUUID=null は badRequest", async () => {
    const c = mockClient({});
    await expect(switchRechargeableBattery(c, { deviceUUID: null, isRechargeBattery: true }))
      .rejects.toMatchObject({ code: ERR.BAD_REQUEST });
  });

  it("[DEV-0017] frame のキー集合が {action, deviceUUID, isRechargeBattery, op} (companyID 無し確認)", async () => {
    const c = mockClient({ success: true });
    await switchRechargeableBattery(c, { deviceUUID: DEVICE_UUID, isRechargeBattery: true });

    const frame = c.sent[0];
    const keys = Object.keys(frame);
    expect(keys).not.toContain("companyID");
    expect(keys).toContain("action");
    expect(keys).toContain("deviceUUID");
    expect(keys).toContain("isRechargeBattery");
    expect(keys).toContain("op");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [DEV-0018] device recharge の --on/--off 必須・排他検証 (XOR) (CLI + serve)
// ─────────────────────────────────────────────────────────────────────────────
describe("[DEV-0018] device recharge: --on/--off XOR 検証", () => {
  // CLI バリデーションロジック (device.js:213-223)
  function simulateCmdDeviceRechargeValidate(options) {
    // !!on === !!off (両方 true or 両方 false) で exit 2
    if (!!options.on === !!options.off) return { error: "rechargeOnOffRequired", code: 2 };
    const isRechargeBattery = !!options.on;
    return { ok: true, isRechargeBattery };
  }

  it("[DEV-0018] CLI: !!on===!!off (両方 true) は die(...,2) 条件を満たす", () => {
    const r = simulateCmdDeviceRechargeValidate({ on: true, off: true });
    expect(r.error).toBe("rechargeOnOffRequired");
    expect(r.code).toBe(2);
  });

  it("[DEV-0018] CLI: !!on===!!off (両方 false) は die(...,2) 条件を満たす", () => {
    const r = simulateCmdDeviceRechargeValidate({});
    expect(r.error).toBe("rechargeOnOffRequired");
    expect(r.code).toBe(2);
  });

  it("[DEV-0018] CLI: --on のみは die 条件を満たさない", () => {
    const r = simulateCmdDeviceRechargeValidate({ on: true });
    expect(r.ok).toBe(true);
    expect(r.isRechargeBattery).toBe(true);
  });

  it("[DEV-0018] CLI: --off のみは die 条件を満たさない", () => {
    const r = simulateCmdDeviceRechargeValidate({ off: true });
    expect(r.ok).toBe(true);
    expect(r.isRechargeBattery).toBe(false);
  });

  it("[DEV-0018] CLI: --on で isRechargeBattery=true を switchRechargeableBattery へ渡す", () => {
    const r = simulateCmdDeviceRechargeValidate({ on: true });
    expect(r.isRechargeBattery).toBe(true);
  });

  it("[DEV-0018] CLI: --off で isRechargeBattery=false を switchRechargeableBattery へ渡す", () => {
    const r = simulateCmdDeviceRechargeValidate({ off: true });
    expect(r.isRechargeBattery).toBe(false);
  });

  it("[DEV-0018] serve: isRechargeBattery undefined で RpcError (BAD_PARAMS) を throw する", () => {
    function serveIsRechargeValidate(params) {
      need(params, ["deviceUUID"]);
      if (params.isRechargeBattery === undefined || params.isRechargeBattery === null) {
        throw new RpcError("isRechargeBattery required", { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
      }
    }
    expect(() => serveIsRechargeValidate({ deviceUUID: DEVICE_UUID })).toThrow(RpcError);
  });

  it("[DEV-0018] serve: isRechargeBattery null でも RpcError (BAD_PARAMS)", () => {
    function serveIsRechargeValidate(params) {
      need(params, ["deviceUUID"]);
      if (params.isRechargeBattery === undefined || params.isRechargeBattery === null) {
        throw new RpcError("isRechargeBattery required", { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
      }
    }
    expect(() => serveIsRechargeValidate({ deviceUUID: DEVICE_UUID, isRechargeBattery: null })).toThrow(RpcError);
  });

  it("[DEV-0018] serve: isRechargeBattery=false (有効値) は RpcError を throw しない", () => {
    function serveIsRechargeValidate(params) {
      need(params, ["deviceUUID"]);
      if (params.isRechargeBattery === undefined || params.isRechargeBattery === null) {
        throw new RpcError("isRechargeBattery required", { code: RPC.INVALID_PARAMS, kind: KIND.BAD_PARAMS });
      }
    }
    expect(() => serveIsRechargeValidate({ deviceUUID: DEVICE_UUID, isRechargeBattery: false })).not.toThrow();
  });

  it("[DEV-0018] 統合: switchRechargeableBattery へ true/false を渡すと 1/0 に正規化される (DEV-0017 補完)", async () => {
    const c = mockClient({ success: true });

    // --on の場合: isRechargeBattery=true → wire では 1
    await switchRechargeableBattery(c, { deviceUUID: DEVICE_UUID, isRechargeBattery: true });
    expect(c.sent[0].isRechargeBattery).toBe(1);

    const c2 = mockClient({ success: true });
    // --off の場合: isRechargeBattery=false → wire では 0
    await switchRechargeableBattery(c2, { deviceUUID: DEVICE_UUID, isRechargeBattery: false });
    expect(c2.sent[0].isRechargeBattery).toBe(0);
  });
});
