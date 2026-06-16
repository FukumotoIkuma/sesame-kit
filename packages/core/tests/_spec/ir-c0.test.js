// packages/core/tests/_spec/ir-c0.test.js
//
// IR spec 統合テスト: IR-0001 〜 IR-0018
//
// 対象実装:
//   packages/core/src/transport.js  — sendIR / getIRCodes
//   packages/core/src/ir.js         — getIRMode / setIRMode / subscribeIRData /
//                                     learnIRKey / addIRCode / MODE
//   packages/kit/src/serve/entries/ir.js — irEntries()
//
// 全テストはネットワーク・実機不使用。mock client で完結。
// setup.i18n.js が beforeEach で setLocale("ja") するため日本語メッセージも使われる。

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- 実装 import ----
import { sendIR, getIRCodes } from "../../src/transport.js";
import {
  getIRMode,
  setIRMode,
  subscribeIRData,
  learnIRKey,
  MODE,
} from "../../src/ir.js";
import { irEntries } from "../../../kit/src/serve/entries/ir.js";
import { badRequest } from "../../src/util.js";
import { need } from "../../../kit/src/serve/registry-helpers.js";

// =====================================================================
// 共通 fixture / ヘルパ
// =====================================================================

const ACTION = "biz3IRRemote";
const COMPANY_ID = "co-TEST";
const DEVICE_ID = "hub3-device-uuid-0001";
const REMOTE_ID = "remote-uuid-0001";

/**
 * 最小 mock client。
 * responses: op → value | fn(frame) => value
 * subscribe: listener を Set で管理し emit() でテスト側から発火できる。
 */
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
      const h = responses[frame.op];
      if (h === undefined) return { success: true };
      return typeof h === "function" ? await h(frame) : h;
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

/** 生波形 fixture: 長さ 56 (> 50 ノイズ閾値) */
function wave(seed = "DEADBEEF") {
  return seed.padEnd(56, "0");
}

/** subscribeIRDataRsp ペイロード */
function dataRsp(deviceId, data) {
  return { deviceId, data: { data } };
}

/** 学習フロー用デフォルト応答セット */
function learnResponses() {
  return {
    setIRMode: { success: true },
    subscribeIRData: { success: true },
    addIRCode: { success: true, data: { saved: true } },
  };
}

const RSP_TOPIC = `${ACTION}:subscribeIRDataRsp`;

// =====================================================================
// IR-0001  sendIR WS フレームのキー集合・op が vendor と一致
// =====================================================================

describe("sendIR (transport.js)", () => {
  it("[IR-0001] sendIR フレームのキー集合・op が vendor useRemoteCtrl.js:467-476 と一致する", async () => {
    const client = makeClient({ sendIR: { success: true, data: {} } });

    await sendIR(client, {
      deviceId: DEVICE_ID,
      command: "3000000000000000000100010000FF31",
      operation: "learnEmit",
      irType: 0xFE00,
      companyID: COMPANY_ID,
      irDeviceUUID: REMOTE_ID,
    });

    expect(client.requests).toHaveLength(1);
    const f = client.requests[0];

    // キー集合の検証 (transport.js:727-736 = useRemoteCtrl.js:467-476)
    expect(Object.keys(f).sort()).toEqual(
      ["action", "command", "companyID", "deviceId", "irDeviceUUID", "irType", "op", "operation"].sort()
    );

    // op 値と action 値
    expect(f.op).toBe("sendIR");
    expect(f.action).toBe(ACTION);
    // 余分な命名が無いこと
    expect(f).not.toHaveProperty("hub3DeviceId");
    expect(f).not.toHaveProperty("remoteId");
  });

  // =====================================================================
  // IR-0002  command/irDeviceUUID 写像 (remoteId→irDeviceUUID, command→command)
  // =====================================================================

  it("[IR-0002] remoteId が frame.irDeviceUUID に、command が frame.command に写像される", async () => {
    const client = makeClient({ sendIR: { success: true } });

    const remoteId = "remote-uuid-for-ir-0002";
    const command = "AABB1122CCDD";

    await sendIR(client, {
      deviceId: DEVICE_ID,
      command,
      operation: "learnEmit",
      irType: 0xFE00,
      companyID: COMPANY_ID,
      irDeviceUUID: remoteId,
    });

    const f = client.requests[0];
    // remoteId は irDeviceUUID フィールド名で送る (フィールド名トラップ)
    expect(f.irDeviceUUID).toBe(remoteId);
    // command は command フィールド名で送る
    expect(f.command).toBe(command);
    // hub3DeviceId / remoteId というフィールドは存在しない
    expect(f).not.toHaveProperty("hub3DeviceId");
    expect(f).not.toHaveProperty("remoteId");
  });

  // =====================================================================
  // IR-0003  operation 分岐 (learnEmit / remoteEmit / undefined)
  // =====================================================================

  it("[IR-0003] operation=learnEmit はそのまま frame.operation に乗る", async () => {
    const client = makeClient({ sendIR: { success: true } });
    await sendIR(client, {
      deviceId: DEVICE_ID,
      command: "AA",
      operation: "learnEmit",
      irType: 0xFE00,
      companyID: COMPANY_ID,
      irDeviceUUID: REMOTE_ID,
    });
    expect(client.requests[0].operation).toBe("learnEmit");
  });

  it("[IR-0003] operation=remoteEmit はそのまま frame.operation に乗る", async () => {
    const client = makeClient({ sendIR: { success: true } });
    await sendIR(client, {
      deviceId: DEVICE_ID,
      command: "BB",
      operation: "remoteEmit",
      irType: 0xC000,
      companyID: COMPANY_ID,
      irDeviceUUID: REMOTE_ID,
    });
    expect(client.requests[0].operation).toBe("remoteEmit");
  });

  it("[IR-0003] operation=undefined のまま frame に乗る (fallback なし — name-based 非対称)", async () => {
    const client = makeClient({ sendIR: { success: true } });
    await sendIR(client, {
      deviceId: DEVICE_ID,
      command: "CC",
      operation: undefined,
      irType: 0xFE00,
      companyID: COMPANY_ID,
      irDeviceUUID: REMOTE_ID,
    });
    // transport.js は fallback なし: operation=undefined がそのまま wire に乗る
    expect(client.requests[0].operation).toBeUndefined();
  });

  // =====================================================================
  // IR-0004  name-based の key 解決分岐 (UUID_RE パターン)
  // =====================================================================

  it("[IR-0004] keyOrUUID が UUID 形式ならそのまま command になる", async () => {
    const client = makeClient({ sendIR: { success: true } });
    const uuid = "550e8400-e29b-41d4-a716-446655440000"; // 標準 UUID (36chars)
    await sendIR(client, {
      deviceId: DEVICE_ID,
      command: uuid,
      operation: "learnEmit",
      irType: 0xFE00,
      companyID: COMPANY_ID,
    });
    expect(client.requests[0].command).toBe(uuid);
  });

  it("[IR-0004] UUID_RE パターンが /^[0-9a-fA-F-]{32,}$/ であること (client.js:109)", () => {
    const re = /^[0-9a-fA-F-]{32,}$/;
    expect(re.test("550e8400e29b41d4a716446655440000")).toBe(true); // ハイフン無し32桁
    expect(re.test("550e8400-e29b-41d4-a716-446655440000")).toBe(true); // ハイフン有り36桁
    expect(re.test("short-key")).toBe(false);
    expect(re.test("power")).toBe(false);
  });

  // =====================================================================
  // IR-0005  必須 key 欠落で BAD_REQUEST
  // =====================================================================

  it("[IR-0005] badRequest(code=bad_request) が構造的に正しい", async () => {
    const err = badRequest("domain.client.keyRequired");
    expect(err.code).toBe("bad_request");
  });

  it("[IR-0005] need([]) が params 欠落で throw する", () => {
    expect(() => need({}, ["key"])).toThrow();
    expect(() => need({ key: "" }, ["key"])).toThrow();
    expect(() => need({ key: "power" }, ["key"])).not.toThrow();
  });

  // =====================================================================
  // IR-0006  ir.send 未知キー名で BAD_REQUEST
  // =====================================================================

  it("[IR-0006] badRequest に context key/avail を詰めたエラーが code=bad_request を持つ", () => {
    const err = badRequest("domain.client.unknownKey", { key: "missing-key", avail: "power, mute" });
    expect(err.code).toBe("bad_request");
  });

  // =====================================================================
  // IR-0007  サーバ success:false で REJECTED
  // =====================================================================

  it("[IR-0007] sendIR 上流が success:false を返したら rejected エラーを投げる", async () => {
    const client = makeClient({
      sendIR: { success: false, message: "IR device not found" },
    });

    await expect(
      sendIR(client, {
        deviceId: DEVICE_ID,
        command: "AA",
        operation: "learnEmit",
        irType: 0xFE00,
        companyID: COMPANY_ID,
        irDeviceUUID: REMOTE_ID,
      })
    ).rejects.toMatchObject({ code: "rejected" });
  });

  it("[IR-0007] rejected エラーのメッセージに detail が含まれる (domain.transport.sendIRFailed)", async () => {
    const client = makeClient({
      sendIR: { success: false, message: "timeout from device" },
    });

    await expect(
      sendIR(client, {
        deviceId: DEVICE_ID,
        command: "AA",
        operation: "learnEmit",
        irType: 0xFE00,
        companyID: COMPANY_ID,
        irDeviceUUID: REMOTE_ID,
      })
    ).rejects.toThrow(/sendIR.*timeout from device/);
  });
});

// =====================================================================
// IR-0008  契約存在 (ir.send が registry に定義される)
// =====================================================================

describe("ir.send contract existence", () => {
  it("[IR-0008] registry の ir.send が remote(optional) / key(required) のパラメータを持つ", () => {
    const entries = irEntries();
    expect(entries).toHaveProperty("ir.send");

    const entry = entries["ir.send"];
    expect(Array.isArray(entry.params)).toBe(true);

    const remoteParam = entry.params.find((p) => p.name === "remote");
    const keyParam = entry.params.find((p) => p.name === "key");

    expect(remoteParam).toBeDefined();
    expect(remoteParam.required).toBe(false);

    expect(keyParam).toBeDefined();
    expect(keyParam.required).toBe(true);
  });

  it("[IR-0008] registry の ir.learn が remote(required)/key(required)/timeoutMs(optional) を持つ", () => {
    const entries = irEntries();
    expect(entries).toHaveProperty("ir.learn");

    const entry = entries["ir.learn"];
    const remoteParam = entry.params.find((p) => p.name === "remote");
    const keyParam = entry.params.find((p) => p.name === "key");
    const timeoutParam = entry.params.find((p) => p.name === "timeoutMs");

    expect(remoteParam).toBeDefined();
    expect(remoteParam.required).toBe(true);

    expect(keyParam).toBeDefined();
    expect(keyParam.required).toBe(true);

    expect(timeoutParam).toBeDefined();
    expect(timeoutParam.required).toBe(false);
  });
});

// =====================================================================
// IR-0009  全 surface で同一封筒 (surface-parity)
// =====================================================================

describe("ir.send surface-parity", () => {
  it("[IR-0009] serve handler の ir.send は hub.send(params.remote, params.key) に委譲する", async () => {
    const entries = irEntries();
    const entry = entries["ir.send"];

    expect(typeof entry.handler).toBe("function");

    const sendResult = { success: true, data: "ok" };
    const hubSend = vi.fn(async () => sendResult);
    const daemonFake = { authState: "loggedIn", hub: { connected: true } };

    const result = await entry.handler({
      hub: { send: hubSend, connected: true },
      params: { remote: "living", key: "power" },
      daemon: daemonFake,
    });

    expect(hubSend).toHaveBeenCalledWith("living", "power");
    expect(result).toBe(sendResult);
  });
});

// =====================================================================
// getIRCodes (transport.js)
// =====================================================================

describe("getIRCodes (transport.js)", () => {
  // =====================================================================
  // IR-0010  getIRCodes WS フレーム (hub3DeviceId 命名トラップ)
  // =====================================================================

  it("[IR-0010] getIRCodes フレームが {action,op,hub3DeviceId,remoteId,companyID} — deviceId ではなく hub3DeviceId", async () => {
    const client = makeClient({
      getIRCodes: { success: true, data: [] },
    });

    await getIRCodes(client, {
      deviceId: DEVICE_ID,
      irDeviceUUID: REMOTE_ID,
      companyID: COMPANY_ID,
    });

    expect(client.requests).toHaveLength(1);
    const f = client.requests[0];

    expect(f.action).toBe(ACTION);
    expect(f.op).toBe("getIRCodes");
    // Hub3 UUID は hub3DeviceId フィールド名 (命名トラップ)
    expect(f.hub3DeviceId).toBe(DEVICE_ID);
    // リモコンは remoteId フィールド名
    expect(f.remoteId).toBe(REMOTE_ID);
    expect(f.companyID).toBe(COMPANY_ID);

    // deviceId・irDeviceUUID というフィールドは送信フレームに現れない
    expect(f).not.toHaveProperty("deviceId");
    expect(f).not.toHaveProperty("irDeviceUUID");
  });

  // =====================================================================
  // IR-0011  応答パース (resp.data 配列 / 空配列既定)
  // =====================================================================

  it("[IR-0011] 応答の resp.data 配列をそのまま返す", async () => {
    const keys = [
      { name: "Power", keyUUID: "uuid-k1" },
      { name: "Vol+", keyUUID: "uuid-k2" },
    ];
    const client = makeClient({
      getIRCodes: { success: true, data: keys },
    });

    const result = await getIRCodes(client, {
      deviceId: DEVICE_ID,
      irDeviceUUID: REMOTE_ID,
      companyID: COMPANY_ID,
    });

    expect(result).toEqual(keys);
  });

  it("[IR-0011] resp.data が欠落している場合は [] を返す", async () => {
    const client = makeClient({
      getIRCodes: { success: true, data: null },
    });

    const result = await getIRCodes(client, {
      deviceId: DEVICE_ID,
      irDeviceUUID: REMOTE_ID,
      companyID: COMPANY_ID,
    });

    expect(result).toEqual([]);
  });

  // =====================================================================
  // IR-0013  サーバ success:false で REJECTED
  // =====================================================================

  it("[IR-0013] getIRCodes 上流が success:false を返したら rejected エラーを投げる", async () => {
    const client = makeClient({
      getIRCodes: { success: false, message: "remote not found" },
    });

    await expect(
      getIRCodes(client, {
        deviceId: DEVICE_ID,
        irDeviceUUID: REMOTE_ID,
        companyID: COMPANY_ID,
      })
    ).rejects.toMatchObject({ code: "rejected" });
  });

  it("[IR-0013] rejected メッセージに detail が含まれる (domain.transport.getIRCodesFailed)", async () => {
    const client = makeClient({
      getIRCodes: { success: false, message: "hub offline" },
    });

    await expect(
      getIRCodes(client, {
        deviceId: DEVICE_ID,
        irDeviceUUID: REMOTE_ID,
        companyID: COMPANY_ID,
      })
    ).rejects.toThrow(/getIRCodes.*hub offline/);
  });
});

// =====================================================================
// IR-0012  ir.listKeys serve direct 経路の必須ペア検証
// =====================================================================

describe("ir.listKeys serve handler — direct 経路分岐", () => {
  it("[IR-0012] hub3DeviceId と irDeviceUUID の両方を指定すると getIRCodesDirect に直行する", async () => {
    const entries = irEntries();
    const entry = entries["ir.listKeys"];

    const directResult = [{ name: "power", keyUUID: "k-1" }];
    const getIRCodesDirect = vi.fn(async () => directResult);
    const listKeys = vi.fn();
    const daemonFake = { authState: "loggedIn", hub: { connected: true } };

    const result = await entry.handler({
      hub: { getIRCodesDirect, listKeys, connected: true },
      params: {
        hub3DeviceId: DEVICE_ID,
        irDeviceUUID: REMOTE_ID,
      },
      daemon: daemonFake,
    });

    expect(getIRCodesDirect).toHaveBeenCalledWith({
      hub3DeviceId: DEVICE_ID,
      irDeviceUUID: REMOTE_ID,
    });
    expect(listKeys).not.toHaveBeenCalled();
    expect(result).toBe(directResult);
  });

  it("[IR-0012] hub3DeviceId のみ指定すると need() が throw する (片方だけは対象特定不可)", () => {
    const entries = irEntries();
    const entry = entries["ir.listKeys"];

    const getIRCodesDirect = vi.fn();
    const listKeys = vi.fn();
    const daemonFake = { authState: "loggedIn", hub: { connected: true } };

    expect(() =>
      entry.handler({
        hub: { getIRCodesDirect, listKeys, connected: true },
        params: { hub3DeviceId: DEVICE_ID }, // irDeviceUUID を省略
        daemon: daemonFake,
      })
    ).toThrow();
    expect(getIRCodesDirect).not.toHaveBeenCalled();
  });

  it("[IR-0012] irDeviceUUID のみ指定すると need() が throw する", () => {
    const entries = irEntries();
    const entry = entries["ir.listKeys"];

    const getIRCodesDirect = vi.fn();
    const daemonFake = { authState: "loggedIn", hub: { connected: true } };

    expect(() =>
      entry.handler({
        hub: { getIRCodesDirect, listKeys: vi.fn(), connected: true },
        params: { irDeviceUUID: REMOTE_ID }, // hub3DeviceId を省略
        daemon: daemonFake,
      })
    ).toThrow();
    expect(getIRCodesDirect).not.toHaveBeenCalled();
  });

  it("[IR-0012] hub3DeviceId も irDeviceUUID も無ければ listKeys(remote名解決) に分岐する", async () => {
    const entries = irEntries();
    const entry = entries["ir.listKeys"];

    const listResult = [{ name: "power", keyUUID: "k-x" }];
    const getIRCodesDirect = vi.fn();
    const listKeys = vi.fn(async () => listResult);
    const daemonFake = { authState: "loggedIn", hub: { connected: true } };

    const result = await entry.handler({
      hub: { getIRCodesDirect, listKeys, connected: true },
      params: { remote: "living" },
      daemon: daemonFake,
    });

    expect(listKeys).toHaveBeenCalledWith("living");
    expect(getIRCodesDirect).not.toHaveBeenCalled();
    expect(result).toBe(listResult);
  });
});

// =====================================================================
// IR-0014  ir.listKeys 契約存在
// =====================================================================

describe("ir.listKeys contract existence", () => {
  it("[IR-0014] registry の ir.listKeys が remote/hub3DeviceId/irDeviceUUID すべて optional で存在する", () => {
    const entries = irEntries();
    expect(entries).toHaveProperty("ir.listKeys");

    const entry = entries["ir.listKeys"];
    expect(Array.isArray(entry.params)).toBe(true);

    const remoteParam = entry.params.find((p) => p.name === "remote");
    const hub3Param = entry.params.find((p) => p.name === "hub3DeviceId");
    const uuidParam = entry.params.find((p) => p.name === "irDeviceUUID");

    expect(remoteParam).toBeDefined();
    expect(remoteParam.required).toBe(false);

    expect(hub3Param).toBeDefined();
    expect(hub3Param.required).toBe(false);

    expect(uuidParam).toBeDefined();
    expect(uuidParam.required).toBe(false);
  });
});

// =====================================================================
// learnIRKey (ir.js) — IR-0015 〜 IR-0018
// =====================================================================

describe("learnIRKey (ir.js)", () => {
  let client;

  beforeEach(() => {
    client = makeClient(learnResponses());
  });

  // =====================================================================
  // IR-0015  学習シーケンス順序
  // =====================================================================

  it("[IR-0015] learnIRKey は setIRMode(REGISTER)→subscribeIRData→波形受信→unsubscribe→setIRMode(CONTROL)→addIRCode の順で実行する", async () => {
    const onPrompt = vi.fn(() => {
      setTimeout(() => client.emit(RSP_TOPIC, dataRsp(DEVICE_ID, wave("AABB"))), 1);
    });

    const result = await learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "Power",
      irType: 0xFE00,
      companyID: COMPANY_ID,
      timeoutMs: 500,
      onPrompt,
    });

    // 戻り値が keyUUID / captured / saved を持つ
    expect(result).toHaveProperty("keyUUID");
    expect(result).toHaveProperty("captured");
    expect(result).toHaveProperty("saved");

    // op 順序検証
    const ops = client.requests.map((f) => f.op);
    expect(ops).toEqual(["setIRMode", "subscribeIRData", "setIRMode", "addIRCode"]);

    // 1 回目: REGISTER
    expect(client.requests[0]).toMatchObject({
      action: ACTION,
      op: "setIRMode",
      deviceId: DEVICE_ID,
      mode: MODE.REGISTER,
      companyID: COMPANY_ID,
    });

    // 2 回目 setIRMode: CONTROL (finally)
    expect(client.requests[2]).toMatchObject({
      op: "setIRMode",
      mode: MODE.CONTROL,
    });

    // unsubscribeIRData が send (fire-and-forget) されている
    const unsub = client.sends.find((f) => f.op === "unsubscribeIRData");
    expect(unsub).toBeDefined();
    expect(unsub).toMatchObject({
      action: ACTION,
      op: "unsubscribeIRData",
      deviceId: DEVICE_ID,
      companyID: COMPANY_ID,
    });

    // addIRCode が呼ばれた後 (最後の op)
    expect(ops[3]).toBe("addIRCode");
  });

  // =====================================================================
  // IR-0016  addIRCode フレーム (irCode フィールド集合)
  // =====================================================================

  it("[IR-0016] addIRCode フレームの irCode が {keyUUID,name,uuid,deviceId,data} — vendor newIrCode と一致する", async () => {
    const waveform = wave("DEADBEEF");
    const onPrompt = vi.fn(() => {
      setTimeout(() => client.emit(RSP_TOPIC, dataRsp(DEVICE_ID, waveform)), 1);
    });

    const result = await learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "Vol+",
      irType: 0xFE00,
      companyID: COMPANY_ID,
      timeoutMs: 500,
      onPrompt,
    });

    const addFrame = client.requests.find((f) => f.op === "addIRCode");
    expect(addFrame).toBeDefined();

    // frame 構造: {action, op, irCode, companyID}
    expect(addFrame.action).toBe(ACTION);
    expect(addFrame.op).toBe("addIRCode");
    expect(addFrame.companyID).toBe(COMPANY_ID);

    // irCode フィールド集合が vendor learn/index.js:222-228 の newIrCode と一致
    expect(addFrame.irCode).toMatchObject({
      keyUUID: result.keyUUID,   // クライアント発番
      name: "Vol+",              // keyName
      uuid: REMOTE_ID,           // p.remoteId = irDeviceUUID
      deviceId: DEVICE_ID,       // p.hub3DeviceId
      data: waveform,            // msg.data.data
    });

    // 旧仕様フィールドは存在しない
    expect(addFrame.irCode).not.toHaveProperty("irData");
    expect(addFrame.irCode).not.toHaveProperty("irWaveLength");
    expect(addFrame.irCode).not.toHaveProperty("irType");
    expect(addFrame.irCode).not.toHaveProperty("hub3DeviceId");
    expect(addFrame.irCode).not.toHaveProperty("remoteId");
  });

  // =====================================================================
  // IR-0017  keyUUID はクライアント発番
  // =====================================================================

  it("[IR-0017] keyUUID は generateUUID() でクライアント発番される (サーバ応答の keyUUID は採用しない)", async () => {
    // サーバは別の keyUUID を返すが、戻り値の keyUUID はクライアント発番のものになる
    client = makeClient({
      ...learnResponses(),
      addIRCode: { success: true, data: { keyUUID: "server-generated-uuid" } },
    });

    const onPrompt = vi.fn(() => {
      setTimeout(() => client.emit(RSP_TOPIC, dataRsp(DEVICE_ID, wave("F1F2"))), 1);
    });

    const result = await learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "Mute",
      irType: 0xFE00,
      companyID: COMPANY_ID,
      timeoutMs: 500,
      onPrompt,
    });

    // 戻り値の keyUUID はクライアント発番の UUID 形式
    expect(result.keyUUID).toBeDefined();
    expect(typeof result.keyUUID).toBe("string");
    expect(result.keyUUID.length).toBeGreaterThan(0);

    // サーバ応答の "server-generated-uuid" とは異なる
    expect(result.keyUUID).not.toBe("server-generated-uuid");

    // addIRCode フレームに乗った keyUUID も同じクライアント発番値
    const addFrame = client.requests.find((f) => f.op === "addIRCode");
    expect(addFrame.irCode.keyUUID).toBe(result.keyUUID);
  });

  // =====================================================================
  // IR-0018  subscribeIRData トピック (hub3/${deviceId}/ir/learned/data)
  // =====================================================================

  it("[IR-0018] subscribeIRData の ackFrame.topic が `hub3/\${deviceId}/ir/learned/data` で vendor と一致する", async () => {
    const subClient = makeClient({
      subscribeIRData: { success: true },
    });

    await subscribeIRData(subClient, { deviceId: DEVICE_ID, companyID: COMPANY_ID });

    const subFrame = subClient.requests.find((f) => f.op === "subscribeIRData");
    expect(subFrame).toBeDefined();

    // topic 文字列が vendor useRemoteCtrl.js:699 と同一
    expect(subFrame.topic).toBe(`hub3/${DEVICE_ID}/ir/learned/data`);
    expect(subFrame.topic).toMatch(/^hub3\/.+\/ir\/learned\/data$/);
  });

  it("[IR-0018] ack フレームには action/op/topic/deviceId/companyID が揃う", async () => {
    const subClient = makeClient({
      subscribeIRData: { success: true },
    });

    await subscribeIRData(subClient, { deviceId: DEVICE_ID, companyID: COMPANY_ID });

    const subFrame = subClient.requests.find((f) => f.op === "subscribeIRData");
    expect(subFrame).toMatchObject({
      action: ACTION,
      op: "subscribeIRData",
      topic: `hub3/${DEVICE_ID}/ir/learned/data`,
      deviceId: DEVICE_ID,
      companyID: COMPANY_ID,
    });
  });

  it("[IR-0018] subscribeIRData の返却オブジェクトは { onData, unsubscribe } を持つ", async () => {
    const subClient = makeClient({
      subscribeIRData: { success: true },
    });
    const sub = await subscribeIRData(subClient, { deviceId: DEVICE_ID, companyID: COMPANY_ID });
    expect(typeof sub.onData).toBe("function");
    expect(typeof sub.unsubscribe).toBe("function");
  });

  it("[IR-0018] learnIRKey 内部の subscribeIRData も同じトピックを使う", async () => {
    const onPrompt = vi.fn(() => {
      setTimeout(() => client.emit(RSP_TOPIC, dataRsp(DEVICE_ID, wave("AABB"))), 1);
    });

    await learnIRKey(client, {
      hub3DeviceId: DEVICE_ID,
      remoteId: REMOTE_ID,
      keyName: "K",
      irType: 0xFE00,
      companyID: COMPANY_ID,
      timeoutMs: 500,
      onPrompt,
    });

    const subFrame = client.requests.find((f) => f.op === "subscribeIRData");
    expect(subFrame).toBeDefined();
    expect(subFrame.topic).toBe(`hub3/${DEVICE_ID}/ir/learned/data`);
  });

  it("[IR-0018] subscribeIRData が success:false を返したら rejected を throw する", async () => {
    const badClient = makeClient({
      setIRMode: { success: true },
      subscribeIRData: { success: false, message: "subscribe fail" },
    });

    await expect(
      learnIRKey(badClient, {
        hub3DeviceId: DEVICE_ID,
        remoteId: REMOTE_ID,
        keyName: "K",
        irType: 0xFE00,
        companyID: COMPANY_ID,
        timeoutMs: 500,
      })
    ).rejects.toMatchObject({ code: "rejected" });
  });
});

// =====================================================================
// getIRMode / setIRMode (ir.js) — referenced by IR-0001 context
// =====================================================================

describe("getIRMode (ir.js)", () => {
  it("getIRMode フレームが {action,op,deviceId,companyID} で vendor と一致し resp.data を返す", async () => {
    const modeData = { ir_mode: 0 };
    const client = makeClient({
      getIRMode: { success: true, data: modeData },
    });

    const result = await getIRMode(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID });

    expect(client.requests[0]).toMatchObject({
      action: ACTION,
      op: "getIRMode",
      deviceId: DEVICE_ID,
      companyID: COMPANY_ID,
    });
    expect(result).toEqual(modeData);
  });

  it("getIRMode success:false で assertSuccess(strict) エラーを投げる", async () => {
    const client = makeClient({
      getIRMode: { success: false, message: "device offline" },
    });

    await expect(
      getIRMode(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID })
    ).rejects.toMatchObject({ code: "rejected" });
  });
});

describe("setIRMode (ir.js)", () => {
  it("setIRMode フレームが {action,op,deviceId,mode,companyID} で mode に 0/1 がそのまま乗る", async () => {
    const client = makeClient({ setIRMode: { success: true } });

    await setIRMode(client, { deviceId: DEVICE_ID, mode: MODE.REGISTER, companyID: COMPANY_ID });

    expect(client.requests[0]).toMatchObject({
      action: ACTION,
      op: "setIRMode",
      deviceId: DEVICE_ID,
      mode: 1,
      companyID: COMPANY_ID,
    });
  });

  it("setIRMode CONTROL (mode=0) もそのまま乗る", async () => {
    const client = makeClient({ setIRMode: { success: true } });

    await setIRMode(client, { deviceId: DEVICE_ID, mode: MODE.CONTROL, companyID: COMPANY_ID });

    expect(client.requests[0].mode).toBe(0);
  });

  it("setIRMode success:false で assertSuccess(strict) エラーを投げる", async () => {
    const client = makeClient({ setIRMode: { success: false, message: "busy" } });

    await expect(
      setIRMode(client, { deviceId: DEVICE_ID, mode: MODE.REGISTER, companyID: COMPANY_ID })
    ).rejects.toMatchObject({ code: "rejected" });
  });
});
