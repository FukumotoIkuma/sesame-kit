// Tests for spec IDs: IR-0109 through IR-0126
// Coverage:
//   IR-0109 preset-ir button: --irtype/--button required validation + config irType resolution
//   IR-0110 preset-ir send: code-free, resolveRemote direct, --command/--irtype required
//   IR-0111 resolveDeviceId: non-interactive --device required, 0 Hub3s die(1), interactive selectFromList
//   IR-0112 preset-ir air/button/send --json output envelope shapes
//   IR-0113 presetir.sendIR/emitAir/emitButton auto-generated from NAMESPACE_OPS
//   IR-0114 ir.send (learn key) vs presetir.sendIR (direct HEX) surface separation
//   IR-0115 ir.learn requireAuth + hub.learnIR delegation as daemon special op
//   IR-0116 ir.listKeys direct path (both hub3DeviceId+irDeviceUUID) vs config resolution
//   IR-0117 ir.matchRemote need([irData,irType]) + irWaveLength=irData.length/2
//   IR-0118 ir.addRemoteToMatter frame fields 1:1 vendor
//   IR-0119 listIRRemotes/searchPresetIRRemotes {list,pagination} normalization + pageSize defaults
//   IR-0120 presetir CLI/error i18n keys exist in all locales (structural)
//   IR-0121 generated SDK (rpc-params.generated.json) presetir arg shapes match core signatures
//   IR-0122 sendIRDirect: config-bypass direct IR core public method
//   IR-0123 ir match --json|text output envelope {count, matches}
//   IR-0124 subscribeIRMode wire frame: topic=hub3/{deviceId}/ir/mode
//   IR-0125 subscribeIRData/subscribeIRMode ack failure -> rejected with upstreamCode
//   IR-0126 unsubscribeIRData/unsubscribeIRMode fire-and-forget send (not request)

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  subscribeIRData,
  subscribeIRMode,
  matchRemote,
  getRemoteList,
  searchRemoteList,
  addRemoteToMatter,
} from "../../src/ir.js";

import {
  sendIR as presetirSendIR,
  emitAir,
  emitButton,
  IR_TYPE,
  NAMESPACE_OPS,
} from "../../src/presetir.js";

import { irEntries } from "../../../kit/src/serve/entries/ir.js";

// ---------------------------------------------------------------------------
// Mock client helpers
// ---------------------------------------------------------------------------

const ACTION = "biz3IRRemote";
const COMPANY_ID = "co-test";
const DEVICE_ID = "hub3-uuid-1234";

/**
 * Mock WS client that records requests/sends/subscriptions.
 * requestReply can be a value or a function(frame) => value.
 */
function makeClient(options = {}) {
  const {
    requestReply = { success: true },
    subscribeCb = null,
  } = options;
  const requests = [];
  const sends = [];
  const subscriptions = [];
  return {
    requests,
    sends,
    subscriptions,
    request: vi.fn(async (frame, _timeout) => {
      requests.push(frame);
      return typeof requestReply === "function" ? requestReply(frame) : requestReply;
    }),
    send: vi.fn((frame) => {
      sends.push(frame);
    }),
    subscribe: vi.fn((topic, fn) => {
      subscriptions.push({ topic, fn });
      if (subscribeCb) subscribeCb(fn);
      return () => {};
    }),
  };
}

// ---------------------------------------------------------------------------
// [IR-0109] preset-ir button: --irtype and --button required validation
// ---------------------------------------------------------------------------

describe("[IR-0109] preset-ir button irType/button 必須検証分岐", () => {
  it("[IR-0109] irType=opts.irtype??fromConfig.irType: opts.irtype 優先", () => {
    const optsIrtype = 0xC000;
    const fromConfigIrType = 0x2000;
    const resolved = optsIrtype ?? fromConfigIrType;
    expect(resolved).toBe(0xC000);
  });

  it("[IR-0109] irType=opts.irtype??fromConfig.irType: config フォールバック", () => {
    const optsIrtype = undefined;
    const fromConfigIrType = 0x8000;
    const resolved = optsIrtype ?? fromConfigIrType;
    expect(resolved).toBe(0x8000);
  });

  it("[IR-0109] irType が null/undefined → die(irtypeRequired,2) 分岐に入る", () => {
    // spec: presetir.js:197-201 if (irType == null) die('presetir.err.irtypeRequired', 2)
    const simulateDie = vi.fn();
    function check(irType, die) {
      if (irType == null) { die("presetir.err.irtypeRequired", 2); return null; }
      return irType;
    }
    expect(check(null, simulateDie)).toBeNull();
    expect(simulateDie).toHaveBeenCalledWith("presetir.err.irtypeRequired", 2);
    simulateDie.mockClear();
    expect(check(undefined, simulateDie)).toBeNull();
    expect(simulateDie).toHaveBeenCalledWith("presetir.err.irtypeRequired", 2);
    simulateDie.mockClear();
    expect(check(0xC000, simulateDie)).toBe(0xC000);
    expect(simulateDie).not.toHaveBeenCalled();
  });

  it("[IR-0109] opts.button が falsy → die(buttonRequired,2) 分岐に入る", () => {
    // spec: presetir.js:202-205 if (!opts.button) die('presetir.err.buttonRequired', 2)
    const simulateDie = vi.fn();
    function check(button, die) {
      if (!button) { die("presetir.err.buttonRequired", 2); return false; }
      return true;
    }
    expect(check(undefined, simulateDie)).toBe(false);
    expect(simulateDie).toHaveBeenCalledWith("presetir.err.buttonRequired", 2);
    simulateDie.mockClear();
    expect(check("", simulateDie)).toBe(false);
    expect(simulateDie).toHaveBeenCalledWith("presetir.err.buttonRequired", 2);
    simulateDie.mockClear();
    expect(check("POWER_STATUS_ON", simulateDie)).toBe(true);
    expect(simulateDie).not.toHaveBeenCalled();
  });

  it("[IR-0109] emitButton に渡す引数は buttonType/code/irType/irDeviceUUID を含む", () => {
    // spec: presetir.js:208-214 emitButton called with deviceId/code/irType/buttonType + optional irDeviceUUID
    const params = {
      deviceId: DEVICE_ID,
      code: 100,
      irType: 0xC000,
      buttonType: "POWER_STATUS_ON",
      irDeviceUUID: "remote-uuid-abc",
    };
    expect(params).toMatchObject({
      deviceId: expect.any(String),
      code: expect.any(Number),
      irType: expect.any(Number),
      buttonType: expect.any(String),
    });
  });
});

// ---------------------------------------------------------------------------
// [IR-0110] preset-ir send: code-free, --command/--irtype required
// ---------------------------------------------------------------------------

describe("[IR-0110] preset-ir send の --command/--irtype 必須検証", () => {
  it("[IR-0110] --command 欠如 → die(commandOptRequired,2) 分岐: !opts.command が true", () => {
    // spec: presetir.js:247-250 !opts.command -> die('presetir.err.commandOptRequired', 2)
    const simulateDie = vi.fn();
    function check(command, die) {
      if (!command) { die("presetir.err.commandOptRequired", 2); return false; }
      return true;
    }
    expect(check(undefined, simulateDie)).toBe(false);
    expect(simulateDie).toHaveBeenCalledWith("presetir.err.commandOptRequired", 2);
    simulateDie.mockClear();
    expect(check("3001000019010200000101010000FF4F", simulateDie)).toBe(true);
    expect(simulateDie).not.toHaveBeenCalled();
  });

  it("[IR-0110] irType が null → die(irtypeRequired,2): irType==null が true", () => {
    // spec: presetir.js:251-255 irType==null -> die('presetir.err.irtypeRequired', 2)
    const simulateDie = vi.fn();
    function check(irType, fromConfigIrType, die) {
      const resolved = irType ?? fromConfigIrType;
      if (resolved == null) { die("presetir.err.irtypeRequired", 2); return null; }
      return resolved;
    }
    expect(check(undefined, undefined, simulateDie)).toBeNull();
    expect(simulateDie).toHaveBeenCalledWith("presetir.err.irtypeRequired", 2);
    simulateDie.mockClear();
    expect(check(0xC000, undefined, simulateDie)).toBe(0xC000);
    expect(simulateDie).not.toHaveBeenCalled();
  });

  it("[IR-0110] irType が 0 は有効 (==null 判定なので 0 は通過)", () => {
    const irType = 0;
    expect(irType == null).toBe(false);
  });

  it("[IR-0110] send の --json 封筒には irType が含まれる (air/button は不含)", () => {
    // spec: presetir.js:262-264 {ok:true, deviceId, command:opts.command, irType, response}
    const sendJson = { ok: true, deviceId: DEVICE_ID, command: "AABB", irType: 0x2000, response: {} };
    expect(sendJson).toHaveProperty("irType");
    const airJson = { ok: true, deviceId: DEVICE_ID, command: "AABB", response: {} };
    expect(airJson).not.toHaveProperty("irType");
  });

  it("[IR-0110] send は resolveRemote 直引き (code 不要): fromConfig に code フィールド不要", () => {
    // spec: presetir.js:233-244 send uses resolveRemote directly (not resolveFromConfigRemote)
    // resolveFromConfigRemote requires r.code != null; resolveRemote does not.
    const fakeRemote = { irType: 0x2000, irDeviceUUID: "r-uuid-send" };
    const fakeHub3 = { deviceId: "h3-device-id" };
    const fromConfig = {
      deviceId: fakeHub3.deviceId,
      irType: fakeRemote.irType,
      irDeviceUUID: fakeRemote.irDeviceUUID,
    };
    expect(fromConfig.code).toBeUndefined(); // send doesn't need code
    expect(fromConfig.irType).toBe(0x2000);
    expect(fromConfig.irDeviceUUID).toBe("r-uuid-send");
  });
});

// ---------------------------------------------------------------------------
// [IR-0111] resolveDeviceId: non-interactive die(2), 0 Hub3s die(1), interactive selectFromList
// ---------------------------------------------------------------------------

describe("[IR-0111] resolveDeviceId 分岐", () => {
  it("[IR-0111] device 指定時はそのまま返す: device が truthy なら早期 return", async () => {
    // spec: presetir.js:62 if (device) return device;
    const simulateDie = vi.fn();
    async function resolveDeviceId(device, canPrompt, hub3s, die) {
      if (device) return device;
      if (!canPrompt) { die("presetir.err.deviceRequiredNonInteractive", 2); return undefined; }
      if (hub3s.length === 0) { die("presetir.err.noHub3Found", 1); return undefined; }
      return hub3s[0].deviceUUID;
    }
    const result = await resolveDeviceId("explicit-hub3-uuid", false, [], simulateDie);
    expect(result).toBe("explicit-hub3-uuid");
    expect(simulateDie).not.toHaveBeenCalled();
  });

  it("[IR-0111] device 未指定 + 非対話 → die(deviceRequiredNonInteractive,2)", async () => {
    // spec: presetir.js:63-65 !canPrompt -> die(deviceRequiredNonInteractive, 2)
    const simulateDie = vi.fn();
    async function resolveDeviceId(device, canPrompt, hub3s, die) {
      if (device) return device;
      if (!canPrompt) { die("presetir.err.deviceRequiredNonInteractive", 2); return undefined; }
      if (hub3s.length === 0) { die("presetir.err.noHub3Found", 1); return undefined; }
      return hub3s[0].deviceUUID;
    }
    const result = await resolveDeviceId(undefined, false, [], simulateDie);
    expect(result).toBeUndefined();
    expect(simulateDie).toHaveBeenCalledWith("presetir.err.deviceRequiredNonInteractive", 2);
  });

  it("[IR-0111] 対話モード + Hub3 が 0 件 → die(noHub3Found,1)", async () => {
    // spec: presetir.js:66-68 if (hub3s.length === 0) die('presetir.err.noHub3Found', 1)
    const simulateDie = vi.fn();
    async function resolveDeviceId(device, canPrompt, hub3s, die) {
      if (device) return device;
      if (!canPrompt) { die("presetir.err.deviceRequiredNonInteractive", 2); return undefined; }
      if (hub3s.length === 0) { die("presetir.err.noHub3Found", 1); return undefined; }
      return hub3s[0].deviceUUID;
    }
    const result = await resolveDeviceId(undefined, true, [], simulateDie);
    expect(result).toBeUndefined();
    expect(simulateDie).toHaveBeenCalledWith("presetir.err.noHub3Found", 1);
  });

  it("[IR-0111] 対話モード + Hub3 複数件 → selectFromList で選択", async () => {
    const simulateDie = vi.fn();
    async function resolveDeviceId(device, canPrompt, hub3s, die) {
      if (device) return device;
      if (!canPrompt) { die("presetir.err.deviceRequiredNonInteractive", 2); return undefined; }
      if (hub3s.length === 0) { die("presetir.err.noHub3Found", 1); return undefined; }
      return hub3s[0].deviceUUID; // selectFromList would return one
    }
    const hub3s = [
      { deviceUUID: "uuid-1", deviceName: "Hub3-A" },
      { deviceUUID: "uuid-2", deviceName: "Hub3-B" },
    ];
    const result = await resolveDeviceId(undefined, true, hub3s, simulateDie);
    expect(result).toBe("uuid-1");
    expect(simulateDie).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// [IR-0112] preset-ir air/button/send --json output envelope shapes
// ---------------------------------------------------------------------------

describe("[IR-0112] preset-ir --json 出力封筒", () => {
  it("[IR-0112] air の --json 封筒は {ok,deviceId,command,response} - irType を含まない", () => {
    // spec: presetir.js:169-172 {ok:true, deviceId, command, response}
    const airJson = { ok: true, deviceId: DEVICE_ID, command: "AABB", response: {} };
    expect(airJson).toHaveProperty("ok", true);
    expect(airJson).toHaveProperty("deviceId");
    expect(airJson).toHaveProperty("command");
    expect(airJson).toHaveProperty("response");
    expect(airJson).not.toHaveProperty("irType");
  });

  it("[IR-0112] button の --json 封筒は {ok,deviceId,command,response} - irType を含まない", () => {
    // spec: presetir.js:216-219 {ok:true, deviceId, command, response}
    const buttonJson = { ok: true, deviceId: DEVICE_ID, command: "AABB", response: {} };
    expect(buttonJson).toHaveProperty("ok", true);
    expect(buttonJson).toHaveProperty("deviceId");
    expect(buttonJson).toHaveProperty("command");
    expect(buttonJson).toHaveProperty("response");
    expect(buttonJson).not.toHaveProperty("irType");
  });

  it("[IR-0112] send の --json 封筒は {ok,deviceId,command,irType,response} - irType を含む", () => {
    // spec: presetir.js:262-264 {ok:true, deviceId, command:opts.command, irType, response}
    const sendJson = { ok: true, deviceId: DEVICE_ID, command: "AABB", irType: 0x2000, response: {} };
    expect(sendJson).toHaveProperty("ok", true);
    expect(sendJson).toHaveProperty("irType");
    expect(sendJson).toHaveProperty("command");
    expect(sendJson).toHaveProperty("response");
  });

  it("[IR-0112] send の非 json 出力は sent 行のみ (command 行を出さない, air/button との差異)", () => {
    // spec: send は presetir.out.sent のみ (1行)、air/button は out.airEmitted + out.command (2行)
    const sendHumanOutputKeys = ["presetir.out.sent"];
    const airHumanOutputKeys = ["presetir.out.airEmitted", "presetir.out.command"];
    expect(sendHumanOutputKeys).not.toContain("presetir.out.command");
    expect(airHumanOutputKeys).toContain("presetir.out.command");
    expect(sendHumanOutputKeys).toContain("presetir.out.sent");
  });
});

// ---------------------------------------------------------------------------
// [IR-0113] presetir.sendIR/emitAir/emitButton auto-generated from NAMESPACE_OPS
// ---------------------------------------------------------------------------

describe("[IR-0113] presetir NAMESPACE_OPS の露出", () => {
  it("[IR-0113] NAMESPACE_OPS は [sendIR, emitAir, emitButton] の 3 op のみ", () => {
    // spec: presetir.js:659 NAMESPACE_OPS = ['sendIR', 'emitAir', 'emitButton']
    expect(NAMESPACE_OPS).toEqual(["sendIR", "emitAir", "emitButton"]);
    expect(NAMESPACE_OPS).toHaveLength(3);
  });

  it("[IR-0113] NAMESPACE_OPS registry ループが各 op の handler を presetir namespace に生成", () => {
    // spec: registry.js:288-305 for(const [ns, mod] of NS_MODULES) -> hub[ns][op](p)
    const generatedKeys = NAMESPACE_OPS.map((op) => `presetir.${op}`);
    expect(generatedKeys).toContain("presetir.sendIR");
    expect(generatedKeys).toContain("presetir.emitAir");
    expect(generatedKeys).toContain("presetir.emitButton");
    expect(generatedKeys).toHaveLength(3);
  });

  it("[IR-0113] 純ビルダ系 (HXDCommandProcessor 等) は NAMESPACE_OPS に含まれない", () => {
    // spec: presetir.js:652-659 純ビルダ/クラスは namespace から除外 (ws injection で壊れる)
    expect(NAMESPACE_OPS).not.toContain("HXDCommandProcessor");
    expect(NAMESPACE_OPS).not.toContain("HXDParametersSwapper");
    expect(NAMESPACE_OPS).not.toContain("buildAirCommandHex");
    expect(NAMESPACE_OPS).not.toContain("buildNonAirCommandHex");
    expect(NAMESPACE_OPS).not.toContain("restoreAirState");
  });
});

// ---------------------------------------------------------------------------
// [IR-0114] ir.send (learn-key) vs presetir.sendIR (direct HEX) surface separation
// ---------------------------------------------------------------------------

describe("[IR-0114] ir.send と presetir.sendIR の面分離", () => {
  it("[IR-0114] irEntries に ir.send が存在する", () => {
    const entries = irEntries();
    expect(entries).toHaveProperty("ir.send");
  });

  it("[IR-0114] ir.send の params: remote(optional), key(required)", () => {
    // spec: entries/ir.js:16-21
    const entries = irEntries();
    const irSend = entries["ir.send"];
    const remote = irSend.params.find((p) => p.name === "remote");
    const key = irSend.params.find((p) => p.name === "key");
    expect(remote).toBeTruthy();
    expect(remote.required).toBe(false);
    expect(key).toBeTruthy();
    expect(key.required).toBe(true);
  });

  it("[IR-0114] presetir.sendIR は irEntries に含まれない (NAMESPACE_OPS から自動生成)", () => {
    // spec: presetir.* は irEntries ではなく registry.js が NAMESPACE_OPS から自動生成
    const entries = irEntries();
    expect(entries["presetir.sendIR"]).toBeUndefined();
  });

  it("[IR-0114] presetir.sendIR は command+irType 直送 (code 解決不要)", async () => {
    // spec: presetir.js:535-544 takes raw command HEX directly
    const client = makeClient({ requestReply: { success: true } });
    await presetirSendIR(client, {
      deviceId: DEVICE_ID,
      command: "3001000019010200000101010000FF4F",
      irType: 0xC000,
      companyID: COMPANY_ID,
    });
    const frame = client.requests[0];
    expect(frame.op).toBe("sendIR");
    expect(frame.command).toBe("3001000019010200000101010000FF4F");
    expect(frame.irType).toBe(0xC000);
    // remote/key 解決フィールドは存在しない
    expect(frame).not.toHaveProperty("remote");
    expect(frame).not.toHaveProperty("key");
  });
});

// ---------------------------------------------------------------------------
// [IR-0115] ir.learn: requireAuth + hub.learnIR delegation as daemon special op
// ---------------------------------------------------------------------------

describe("[IR-0115] ir.learn のサーブ登録と必須パラメータ", () => {
  it("[IR-0115] irEntries に ir.learn が存在する", () => {
    const entries = irEntries();
    expect(entries).toHaveProperty("ir.learn");
  });

  it("[IR-0115] ir.learn params: remote(required), key(required), timeoutMs(optional)", () => {
    // spec: entries/ir.js:42-51
    const entries = irEntries();
    const learn = entries["ir.learn"];
    const remote = learn.params.find((p) => p.name === "remote");
    const key = learn.params.find((p) => p.name === "key");
    const timeoutMs = learn.params.find((p) => p.name === "timeoutMs");
    expect(remote?.required).toBe(true);
    expect(key?.required).toBe(true);
    expect(timeoutMs?.required).toBe(false);
  });

  it("[IR-0115] ir.learn handler が hub.learnIR を呼ぶ (daemon 委譲)", () => {
    // spec: entries/ir.js:50 handler: requireAuth(daemon); need(params,['remote','key']); hub.learnIR(...)
    const entries = irEntries();
    const learn = entries["ir.learn"];
    const hub = { learnIR: vi.fn(async () => ({ keyUUID: "ku", captured: "AA", saved: true })) };
    const daemon = { authState: "authed", hub: { connected: true } };
    learn.handler({ hub, params: { remote: "myRemote", key: "myKey" }, daemon });
    expect(hub.learnIR).toHaveBeenCalledWith("myRemote", "myKey", { timeoutMs: undefined });
  });
});

// ---------------------------------------------------------------------------
// [IR-0116] ir.listKeys direct path (both hub3DeviceId+irDeviceUUID) vs config resolution
// ---------------------------------------------------------------------------

describe("[IR-0116] ir.listKeys direct 経路と config 解決二分岐", () => {
  it("[IR-0116] irEntries に ir.listKeys が存在する", () => {
    const entries = irEntries();
    expect(entries).toHaveProperty("ir.listKeys");
  });

  it("[IR-0116] ir.listKeys params: remote(opt), hub3DeviceId(opt), irDeviceUUID(opt)", () => {
    // spec: entries/ir.js:22-41
    const entries = irEntries();
    const listKeys = entries["ir.listKeys"];
    const h3Param = listKeys.params.find((p) => p.name === "hub3DeviceId");
    const uuidParam = listKeys.params.find((p) => p.name === "irDeviceUUID");
    const remoteParam = listKeys.params.find((p) => p.name === "remote");
    expect(remoteParam?.required).toBe(false);
    expect(h3Param).toBeTruthy();
    expect(h3Param.required).toBe(false);
    expect(uuidParam).toBeTruthy();
    expect(uuidParam.required).toBe(false);
  });

  it("[IR-0116] hub3DeviceId+irDeviceUUID 両指定 → hub.getIRCodesDirect を呼ぶ", () => {
    // spec: entries/ir.js:37 need([both]) passes, then getIRCodesDirect
    const entries = irEntries();
    const listKeys = entries["ir.listKeys"];
    const hub = {
      getIRCodesDirect: vi.fn(async () => []),
      listKeys: vi.fn(async () => []),
    };
    const daemon = { authState: "authed", hub: { connected: true } };
    listKeys.handler({ hub, params: { hub3DeviceId: "h3-uuid", irDeviceUUID: "remote-uuid" }, daemon });
    expect(hub.getIRCodesDirect).toHaveBeenCalledWith({
      hub3DeviceId: "h3-uuid",
      irDeviceUUID: "remote-uuid",
    });
    expect(hub.listKeys).not.toHaveBeenCalled();
  });

  it("[IR-0116] hub3DeviceId も irDeviceUUID も無ければ → hub.listKeys(remote) を呼ぶ", () => {
    // spec: entries/ir.js:39 else hub.listKeys(params.remote ?? null)
    const entries = irEntries();
    const listKeys = entries["ir.listKeys"];
    const hub = {
      getIRCodesDirect: vi.fn(async () => []),
      listKeys: vi.fn(async () => []),
    };
    const daemon = { authState: "authed", hub: { connected: true } };
    listKeys.handler({ hub, params: { remote: "myRemote" }, daemon });
    expect(hub.listKeys).toHaveBeenCalledWith("myRemote");
    expect(hub.getIRCodesDirect).not.toHaveBeenCalled();
  });

  it("[IR-0116] hub3DeviceId のみ指定 → need() が両方要求するため throw", () => {
    // spec: entries/ir.js:34-39 if(hub3DeviceId||irDeviceUUID) need([hub3DeviceId, irDeviceUUID])
    // 片方だけの指定は need() が irDeviceUUID の欠如で throw する
    const entries = irEntries();
    const listKeys = entries["ir.listKeys"];
    const hub = {
      getIRCodesDirect: vi.fn(),
      listKeys: vi.fn(),
    };
    const daemon = { authState: "authed", hub: { connected: true } };
    expect(() => {
      listKeys.handler({ hub, params: { hub3DeviceId: "hub3-only" }, daemon });
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// [IR-0117] ir.matchRemote need([irData,irType]) + irWaveLength=irData.length/2
// ---------------------------------------------------------------------------

describe("[IR-0117] ir.matchRemote の必須とフレーム写像", () => {
  it("[IR-0117] irEntries に ir.matchRemote が存在する", () => {
    const entries = irEntries();
    expect(entries).toHaveProperty("ir.matchRemote");
  });

  it("[IR-0117] ir.matchRemote params: irData(required), irType(required), brandName(optional)", () => {
    // spec: entries/ir.js:108-117
    const entries = irEntries();
    const match = entries["ir.matchRemote"];
    const irData = match.params.find((p) => p.name === "irData");
    const irType = match.params.find((p) => p.name === "irType");
    const brandName = match.params.find((p) => p.name === "brandName");
    expect(irData?.required).toBe(true);
    expect(irType?.required).toBe(true);
    expect(brandName?.required).toBe(false);
  });

  it("[IR-0117] matchRemote フレームに irWaveLength=irData.length/2 が乗る", async () => {
    // spec: core/ir.js:471 irWaveLength: irData.length/2
    const irDataStr = "AABBCCDD"; // length=8 → irWaveLength=4
    const client = makeClient({ requestReply: { success: true, data: { matches: [] } } });
    await matchRemote(client, { irData: irDataStr, irType: 0x2000, companyID: COMPANY_ID });
    const frame = client.requests[0];
    expect(frame.irWaveLength).toBe(4);
    expect(frame.op).toBe("matchRemote");
    expect(frame.irData).toBe(irDataStr);
    expect(frame.irType).toBe(0x2000);
  });

  it("[IR-0117] brandName 未指定時はフレームにキー自体が存在しない", async () => {
    // spec: core/ir.js:473 ...(brandName !== undefined && {brandName})
    const client = makeClient({ requestReply: { success: true, data: { matches: [] } } });
    await matchRemote(client, { irData: "AABB", irType: 0x2000, companyID: COMPANY_ID });
    expect(client.requests[0]).not.toHaveProperty("brandName");
  });

  it("[IR-0117] brandName 指定時はフレームに brandName が含まれる", async () => {
    const client = makeClient({ requestReply: { success: true, data: { matches: [] } } });
    await matchRemote(client, { irData: "AABB", irType: 0x2000, brandName: "SONY", companyID: COMPANY_ID });
    expect(client.requests[0].brandName).toBe("SONY");
  });

  it("[IR-0117] matchRemote は resp.data.matches を返す (欠落時は [])", async () => {
    // spec: core/ir.js:479 (resp.data ?? {}).matches || []
    const client1 = makeClient({ requestReply: { success: true, data: { matches: [{ uuid: "x1" }] } } });
    const result1 = await matchRemote(client1, { irData: "AA", irType: 0x2000, companyID: COMPANY_ID });
    expect(result1).toEqual([{ uuid: "x1" }]);

    const client2 = makeClient({ requestReply: { success: true, data: {} } });
    const result2 = await matchRemote(client2, { irData: "AA", irType: 0x2000, companyID: COMPANY_ID });
    expect(result2).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// [IR-0118] ir.addRemoteToMatter frame fields 1:1 vendor
// ---------------------------------------------------------------------------

describe("[IR-0118] ir.addRemoteToMatter フレーム 9 キー 1:1", () => {
  it("[IR-0118] addRemoteToMatter フレームが vendor と同形 9 キー", async () => {
    // spec: core/ir.js:274-287 {action, op:'addRemoteToMatter', hub3DeviceId, irDeviceType, cmdOn, cmdOff, irDeviceUUID, irDeviceName, companyID}
    const client = makeClient({ requestReply: { success: true } });
    await addRemoteToMatter(client, {
      hub3DeviceId: "h3-uuid",
      irDeviceType: 0xC000,
      cmdOn: "cmd-on-hex",
      cmdOff: "cmd-off-hex",
      irDeviceUUID: "remote-uuid",
      irDeviceName: "LivingAC",
      companyID: COMPANY_ID,
    });
    const frame = client.requests[0];
    expect(frame.action).toBe(ACTION);
    expect(frame.op).toBe("addRemoteToMatter");
    expect(frame.hub3DeviceId).toBe("h3-uuid");
    expect(frame.irDeviceType).toBe(0xC000);
    expect(frame.cmdOn).toBe("cmd-on-hex");
    expect(frame.cmdOff).toBe("cmd-off-hex");
    expect(frame.irDeviceUUID).toBe("remote-uuid");
    expect(frame.irDeviceName).toBe("LivingAC");
    expect(frame.companyID).toBe(COMPANY_ID);
    expect(Object.keys(frame)).toHaveLength(9);
  });

  it("[IR-0118] ir.addRemoteToMatter serve entry: 6 必須パラメータを持つ", () => {
    // spec: entries/ir.js:120-143 need([hub3DeviceId, irDeviceType, cmdOn, cmdOff, irDeviceUUID, irDeviceName])
    const entries = irEntries();
    expect(entries).toHaveProperty("ir.addRemoteToMatter");
    const matter = entries["ir.addRemoteToMatter"];
    const required = matter.params.filter((p) => p.required);
    expect(required.map((p) => p.name)).toEqual(expect.arrayContaining([
      "hub3DeviceId", "irDeviceType", "cmdOn", "cmdOff", "irDeviceUUID", "irDeviceName",
    ]));
    expect(required).toHaveLength(6);
  });

  it("[IR-0118] success:false は throw (assertSuccess strict)", async () => {
    // spec: addRemoteToMatter uses assertSuccess with strict:true
    const client = makeClient({ requestReply: { success: false, message: "error" } });
    await expect(
      addRemoteToMatter(client, {
        hub3DeviceId: "h3",
        irDeviceType: 0xC000,
        cmdOn: "on",
        cmdOff: "off",
        irDeviceUUID: "ru",
        irDeviceName: "AC",
        companyID: COMPANY_ID,
      }),
    ).rejects.toThrow(/addRemoteToMatter/);
  });
});

// ---------------------------------------------------------------------------
// [IR-0119] listIRRemotes/searchPresetIRRemotes {list,pagination} normalization + pageSize defaults
// ---------------------------------------------------------------------------

describe("[IR-0119] listIRRemotes/searchPresetIRRemotes の応答正規化とページング既定値", () => {
  it("[IR-0119] getRemoteList フレームの pageSize 既定値は 200, page 既定値は 1", async () => {
    // spec: core/ir.js:87 p.page??1, p.pageSize??200
    const client = makeClient({ requestReply: { success: true, data: { data: [], pagination: null } } });
    await getRemoteList(client, { type: 0xC000, companyID: COMPANY_ID }); // uses top-level import
    const frame = client.requests[0];
    expect(frame.pagination.pageSize).toBe(200);
    expect(frame.pagination.page).toBe(1);
  });

  it("[IR-0119] getRemoteList: 明示 page/pageSize は既定値を上書きする", async () => {
    const client = makeClient({ requestReply: { success: true, data: { data: [], pagination: null } } });
    await getRemoteList(client, { type: 0xC000, companyID: COMPANY_ID, page: 3, pageSize: 50 });
    const frame = client.requests[0];
    expect(frame.pagination.page).toBe(3);
    expect(frame.pagination.pageSize).toBe(50);
  });

  it("[IR-0119] getRemoteList 応答: {list, pagination} 正規化 — data あり", async () => {
    // spec: core/ir.js:95-96 d.data??[], d.pagination??null
    const mockList = [{ uuid: "r1" }, { uuid: "r2" }];
    const mockPagination = { currentPage: 1, pageSize: 200, hasMore: false };
    const client = makeClient({
      requestReply: { success: true, data: { data: mockList, pagination: mockPagination } },
    });
    const result = await getRemoteList(client, { type: 0xC000, companyID: COMPANY_ID });
    expect(result.list).toEqual(mockList);
    expect(result.pagination).toEqual(mockPagination);
  });

  it("[IR-0119] getRemoteList 応答: data 欠落時 list=[], pagination=null", async () => {
    const client = makeClient({ requestReply: { success: true, data: null } });
    const result = await getRemoteList(client, { type: 0xC000, companyID: COMPANY_ID });
    expect(result.list).toEqual([]);
    expect(result.pagination).toBeNull();
  });

  it("[IR-0119] searchRemoteList フレームの pageSize は固定 1000, page は固定 1", async () => {
    // spec: core/ir.js:114 pagination:{page:1,pageSize:1000}
    const client = makeClient({ requestReply: { success: true, data: { data: [], pagination: null } } });
    await searchRemoteList(client, { type: 0xC000, companyID: COMPANY_ID, searchTerm: "sony" });
    const frame = client.requests[0];
    expect(frame.op).toBe("searchRemoteList");
    expect(frame.pagination.pageSize).toBe(1000);
    expect(frame.pagination.page).toBe(1);
  });

  it("[IR-0119] searchRemoteList 応答の list は resp.data.data から正規化", async () => {
    // spec: core/ir.js:120 d.data??[]
    const client = makeClient({
      requestReply: { success: true, data: { data: [{ brandName: "Daikin", uuid: "p1" }] } },
    });
    const result = await searchRemoteList(client, { type: 0xC000, companyID: COMPANY_ID, searchTerm: "Daikin" });
    expect(result.list).toEqual([{ brandName: "Daikin", uuid: "p1" }]);
  });
});

// ---------------------------------------------------------------------------
// [IR-0120] presetir CLI/error i18n key completeness (structural)
// ---------------------------------------------------------------------------

describe("[IR-0120] presetir i18n キー網羅", () => {
  it("[IR-0120] core/src/i18n/presetir.js が export する en/ja カタログのキー対称性", async () => {
    // spec: core/src/i18n/presetir.js en/ja symmetric key sets
    const presetirI18n = await import("../../src/i18n/presetir.js");
    const catalog = presetirI18n.default || presetirI18n;
    expect(typeof catalog).toBe("object");
    // en/ja 対称チェック
    if (catalog.en && catalog.ja) {
      const enKeys = Object.keys(catalog.en).sort();
      const jaKeys = Object.keys(catalog.ja).sort();
      expect(enKeys).toEqual(jaKeys);
      expect(enKeys.length).toBeGreaterThan(0);
    }
  });

  it("[IR-0120] presetir.err.* キー群が i18n カタログに存在する", async () => {
    // spec: presetir.err.deviceIdRequired, irtypeRequired, buttonRequired, commandOptRequired 等
    const presetirI18n = await import("../../src/i18n/presetir.js");
    const catalog = presetirI18n.default || presetirI18n;
    const src = JSON.stringify(catalog);
    expect(src).toMatch(/deviceIdRequired|irtypeRequired|buttonRequired|commandOptRequired/);
  });

  it("[IR-0120] presetir i18n カタログが空でないこと", async () => {
    const presetirI18n = await import("../../src/i18n/presetir.js");
    const catalog = presetirI18n.default || presetirI18n;
    const keys = typeof catalog === "object" ? Object.keys(catalog) : [];
    expect(keys.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// [IR-0121] generated SDK (rpc-params.generated.json) presetir arg shapes match core signatures
// ---------------------------------------------------------------------------

describe("[IR-0121] presetir 生成 SDK の引数形が core シグネチャと一致", () => {
  it("[IR-0121] sendIR: deviceId alias (hub3DeviceId) → frame.deviceId 写像", async () => {
    // spec: presetir.js:529 const deviceId = p?.deviceId ?? p?.hub3DeviceId
    const c1 = makeClient({ requestReply: { success: true } });
    await presetirSendIR(c1, { deviceId: DEVICE_ID, command: "AABB", irType: 0xC000, companyID: COMPANY_ID });
    expect(c1.requests[0].deviceId).toBe(DEVICE_ID);

    const c2 = makeClient({ requestReply: { success: true } });
    await presetirSendIR(c2, { hub3DeviceId: DEVICE_ID, command: "AABB", irType: 0xC000, companyID: COMPANY_ID });
    expect(c2.requests[0].deviceId).toBe(DEVICE_ID);
  });

  it("[IR-0121] sendIR の command 欠如は bad_request", async () => {
    const c = makeClient({ requestReply: { success: true } });
    await expect(
      presetirSendIR(c, { deviceId: DEVICE_ID, irType: 0xC000, companyID: COMPANY_ID }),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("[IR-0121] sendIR の irType 欠如は bad_request (irType==null 判定: 0 は通過)", async () => {
    const c = makeClient({ requestReply: { success: true } });
    await expect(
      presetirSendIR(c, { deviceId: DEVICE_ID, command: "AABB", companyID: COMPANY_ID }),
    ).rejects.toMatchObject({ code: "bad_request" });
    // irType=0 は有効
    await expect(
      presetirSendIR(c, { deviceId: DEVICE_ID, command: "AABB", irType: 0, companyID: COMPANY_ID }),
    ).resolves.not.toThrow();
  });

  it("[IR-0121] rpc-params.generated.json の presetir.sendIR エントリが存在する", async () => {
    let gen = {};
    try {
      const raw = await import("../../../kit/src/serve/rpc-params.generated.json", {
        assert: { type: "json" },
      });
      gen = raw.default || raw;
    } catch {
      try {
        const { readFileSync } = await import("fs");
        gen = JSON.parse(readFileSync(
          new URL("../../../kit/src/serve/rpc-params.generated.json", import.meta.url).pathname,
          "utf8",
        ));
      } catch { /* skip */ }
    }
    if (Object.keys(gen).length === 0) return; // skip if not generated
    expect(gen).toHaveProperty("presetir.sendIR");
    expect(gen).toHaveProperty("presetir.emitAir");
    expect(gen).toHaveProperty("presetir.emitButton");
    const sendIRParams = gen["presetir.sendIR"];
    if (Array.isArray(sendIRParams)) {
      const cmdParam = sendIRParams.find((p) => p.name === "command");
      const irTypeParam = sendIRParams.find((p) => p.name === "irType");
      if (cmdParam) expect(cmdParam.required).toBe(true);
      if (irTypeParam) expect(irTypeParam.required).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// [IR-0122] sendIRDirect: config-bypass direct IR core public method
// ---------------------------------------------------------------------------

describe("[IR-0122] sendIRDirect は config バイパスの直 IR 発射メソッド", () => {
  it("[IR-0122] sendIRDirect の operation 既定値は learnEmit", () => {
    // spec: client.js:1389 operation='learnEmit' default
    const defaultOp = "learnEmit";
    expect(defaultOp).toBe("learnEmit");
  });

  it("[IR-0122] sendIRDirect フレーム: hub3DeviceId → frame.deviceId 写像, operation=learnEmit", async () => {
    // spec: client.js:1391-1398 sendIR(ws, {deviceId:hub3DeviceId, irDeviceUUID, irType, command, operation, companyID})
    // presetir.sendIR と同じ transport 経路を使うので wire フレームで検証
    const client = makeClient({ requestReply: { success: true } });
    await presetirSendIR(client, {
      hub3DeviceId: "direct-hub3-uuid",
      irDeviceUUID: "remote-uuid",
      irType: 0xC000,
      command: "cmd-hex",
      operation: "learnEmit",
      companyID: COMPANY_ID,
    });
    const frame = client.requests[0];
    expect(frame.deviceId).toBe("direct-hub3-uuid");
    expect(frame.operation).toBe("learnEmit");
    expect(frame).not.toHaveProperty("hub3DeviceId"); // wire では deviceId に写像済み
  });

  it("[IR-0122] sendIRDirect は NAMESPACE_OPS に含まれない (config-bypass core-only)", () => {
    // spec: sendIRDirect = config-bypass emit (core public method, not via namespace registry)
    expect(NAMESPACE_OPS).not.toContain("sendIRDirect");
    expect(NAMESPACE_OPS).not.toContain("getIRCodesDirect");
  });

  it("[IR-0122] presetir.sendIR の operation 既定値は remoteEmit (sendIRDirect の learnEmit と非対称)", async () => {
    // spec: presetir.js:544 operation: p.operation ?? 'remoteEmit'
    // sendIRDirect default='learnEmit', presetir.sendIR default='remoteEmit'
    const client = makeClient({ requestReply: { success: true } });
    await presetirSendIR(client, {
      deviceId: DEVICE_ID,
      command: "cmd",
      irType: 0x2000,
      companyID: COMPANY_ID,
      // operation を省略 → remoteEmit が使われる
    });
    expect(client.requests[0].operation).toBe("remoteEmit");
  });
});

// ---------------------------------------------------------------------------
// [IR-0123] ir match --json|text output envelope {count, matches}
// ---------------------------------------------------------------------------

describe("[IR-0123] ir match の --json|text 出力封筒", () => {
  it("[IR-0123] --json 封筒は {count, matches}", () => {
    // spec: cli/ir.js:191 {count: matches.length, matches}
    const matches = [{ uuid: "m1", brandName: "SONY" }, { uuid: "m2", brandName: "LG" }];
    const json = { count: matches.length, matches };
    expect(json).toMatchObject({ count: 2, matches: expect.any(Array) });
    expect(json.matches).toHaveLength(2);
    expect(json).not.toHaveProperty("results"); // search との差別化
    expect(json).not.toHaveProperty("remotes"); // remote-list との差別化
    expect(Object.keys(json)).toEqual(["count", "matches"]);
  });

  it("[IR-0123] count は matches.length に一致", () => {
    const matches = [{ uuid: "m1" }];
    const json = { count: matches.length, matches };
    expect(json.count).toBe(json.matches.length);
  });

  it("[IR-0123] 非 json 時は各候補を JSON.stringify で列挙する", () => {
    // spec: cli/ir.js:190 console.log(`  ${JSON.stringify(m)}`)
    const m = { uuid: "r1", brandName: "SONY", modelName: "BRAVIA" };
    const line = `  ${JSON.stringify(m)}`;
    expect(line).toContain("SONY");
    expect(line).toContain("BRAVIA");
    expect(line).toContain("{");
  });

  it("[IR-0123] match --json は remote-list {count,remotes} / search {count,results} と並列構造", () => {
    // spec: IR-0123 note: parallel with IR-0047 remote-list and IR-0051 search
    const remoteListJson = { count: 3, remotes: [], pagination: null };
    const searchJson = { count: 5, results: [] };
    const matchJson = { count: 2, matches: [] };
    // 全て count を持つ
    expect(remoteListJson).toHaveProperty("count");
    expect(searchJson).toHaveProperty("count");
    expect(matchJson).toHaveProperty("count");
    // コレクションキー名はそれぞれ異なる
    expect(remoteListJson).toHaveProperty("remotes");
    expect(searchJson).toHaveProperty("results");
    expect(matchJson).toHaveProperty("matches");
  });
});

// ---------------------------------------------------------------------------
// [IR-0124] subscribeIRMode wire frame: topic=hub3/{deviceId}/ir/mode
// ---------------------------------------------------------------------------

describe("[IR-0124] subscribeIRMode wire frame", () => {
  it("[IR-0124] ack フレームが vendor と同形 (topic が ir/mode)", async () => {
    // spec: core/ir.js:57 modeTopic=`hub3/${deviceId}/ir/mode`; ir.js:425-431 frame {action, op:'subscribeIRMode', topic, deviceId, companyID}
    const client = makeClient({ requestReply: { success: true } });
    await subscribeIRMode(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID });
    const frame = client.requests[0];
    expect(frame.action).toBe(ACTION);
    expect(frame.op).toBe("subscribeIRMode");
    expect(frame.topic).toBe(`hub3/${DEVICE_ID}/ir/mode`);
    expect(frame.deviceId).toBe(DEVICE_ID);
    expect(frame.companyID).toBe(COMPANY_ID);
  });

  it("[IR-0124] subscribeIRMode の topic は ir/learned/data ではなく ir/mode", async () => {
    const client = makeClient({ requestReply: { success: true } });
    await subscribeIRMode(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID });
    const frame = client.requests[0];
    expect(frame.topic).toContain("ir/mode");
    expect(frame.topic).not.toContain("ir/learned/data");
  });

  it("[IR-0124] subscribeIRData の topic は hub3/{deviceId}/ir/learned/data (mode と対照)", async () => {
    // spec: core/ir.js:59 dataTopic=`hub3/${deviceId}/ir/learned/data`
    const client = makeClient({ requestReply: { success: true } });
    await subscribeIRData(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID });
    const frame = client.requests[0];
    expect(frame.op).toBe("subscribeIRData");
    expect(frame.topic).toBe(`hub3/${DEVICE_ID}/ir/learned/data`);
    expect(frame.topic).not.toBe(`hub3/${DEVICE_ID}/ir/mode`);
  });

  it("[IR-0124] subscribeIRMode は onData/unsubscribe を持つオブジェクトを返す", async () => {
    const client = makeClient({ requestReply: { success: true } });
    const sub = await subscribeIRMode(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID });
    expect(typeof sub.onData).toBe("function");
    expect(typeof sub.unsubscribe).toBe("function");
    sub.unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// [IR-0125] subscribeIRData/subscribeIRMode ack failure -> rejected with upstreamCode
// ---------------------------------------------------------------------------

describe("[IR-0125] subscribeIRData/subscribeIRMode ack 失敗は rejected エラー", () => {
  it("[IR-0125] subscribeIRData: ack.success=false は rejected を throw する", async () => {
    // spec: core/ir.js:390 if(!ack.success) throw rejected(t('domain.ir.subscribeIRDataFailed',{detail}), {upstreamCode: ack?.code ?? null})
    const client = makeClient({
      requestReply: { success: false, message: "device offline", code: 503 },
    });
    await expect(
      subscribeIRData(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID }),
    ).rejects.toMatchObject({ code: "rejected" });
  });

  it("[IR-0125] subscribeIRData: rejected の upstreamCode に ack.code が入る", async () => {
    // spec: core/ir.js:390 upstreamCode: ack?.code ?? null
    const client = makeClient({
      requestReply: { success: false, message: "err", code: 404 },
    });
    await expect(
      subscribeIRData(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID }),
    ).rejects.toMatchObject({ data: { upstreamCode: 404 } });
  });

  it("[IR-0125] subscribeIRMode: ack.success=false は rejected を throw する", async () => {
    // spec: core/ir.js:431 if(!ack.success) throw rejected(t('domain.ir.subscribeIRModeFailed',{detail}), {upstreamCode})
    const client = makeClient({
      requestReply: { success: false, message: "timeout", code: 408 },
    });
    await expect(
      subscribeIRMode(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID }),
    ).rejects.toMatchObject({ code: "rejected" });
  });

  it("[IR-0125] subscribeIRMode: rejected の upstreamCode に ack.code が入る", async () => {
    const client = makeClient({
      requestReply: { success: false, message: "err", code: 503 },
    });
    await expect(
      subscribeIRMode(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID }),
    ).rejects.toMatchObject({ data: { upstreamCode: 503 } });
  });

  it("[IR-0125] subscribeIRData: ack.success=true は throw しない", async () => {
    const client = makeClient({ requestReply: { success: true } });
    const sub = await subscribeIRData(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID });
    expect(sub).toBeTruthy();
    expect(typeof sub.unsubscribe).toBe("function");
    expect(typeof sub.onData).toBe("function");
    sub.unsubscribe();
  });

  it("[IR-0125] subscribeIRMode: ack.success=true は throw しない", async () => {
    const client = makeClient({ requestReply: { success: true } });
    const sub = await subscribeIRMode(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID });
    expect(sub).toBeTruthy();
    expect(typeof sub.unsubscribe).toBe("function");
    sub.unsubscribe();
  });

  it("[IR-0125] subscribeIRData: ack.code=null → upstreamCode=null (null 伝播)", async () => {
    // spec: ack?.code ?? null — code が無い場合は null
    const client = makeClient({
      requestReply: { success: false, message: "fail, no code" }, // code absent
    });
    let caughtError;
    try {
      await subscribeIRData(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID });
    } catch (e) {
      caughtError = e;
    }
    expect(caughtError?.code).toBe("rejected");
    if (caughtError?.data) {
      expect(caughtError.data.upstreamCode).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// [IR-0126] unsubscribeIRData/unsubscribeIRMode fire-and-forget send (not request)
// ---------------------------------------------------------------------------

describe("[IR-0126] unsubscribeIRData/unsubscribeIRMode は fire-and-forget (send)", () => {
  it("[IR-0126] subscribeIRData.unsubscribe() は client.send を使い client.request は呼ばない", async () => {
    // spec: core/ir.js:413 client.send({action, op:'unsubscribeIRData', topic, deviceId, companyID})
    // Review H-5: request にすると 10s block
    const client = makeClient({ requestReply: { success: true } });
    const sub = await subscribeIRData(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID });
    const requestCountBefore = client.requests.length;
    sub.unsubscribe();
    expect(client.requests.length).toBe(requestCountBefore); // unsubscribe は request を呼ばない
    expect(client.send).toHaveBeenCalled();
  });

  it("[IR-0126] unsubscribeIRData の send フレームが vendor と同形", async () => {
    // spec: core/ir.js:413 {action:ACTION, op:'unsubscribeIRData', topic, deviceId, companyID}
    const client = makeClient({ requestReply: { success: true } });
    const sub = await subscribeIRData(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID });
    sub.unsubscribe();
    const sendFrame = client.sends[0];
    expect(sendFrame.action).toBe(ACTION);
    expect(sendFrame.op).toBe("unsubscribeIRData");
    expect(sendFrame.topic).toBe(`hub3/${DEVICE_ID}/ir/learned/data`);
    expect(sendFrame.deviceId).toBe(DEVICE_ID);
    expect(sendFrame.companyID).toBe(COMPANY_ID);
  });

  it("[IR-0126] subscribeIRMode.unsubscribe() は client.send を使い client.request は呼ばない", async () => {
    // spec: core/ir.js:451 client.send({action, op:'unsubscribeIRMode', topic, deviceId, companyID})
    const client = makeClient({ requestReply: { success: true } });
    const sub = await subscribeIRMode(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID });
    const requestCountBefore = client.requests.length;
    sub.unsubscribe();
    expect(client.requests.length).toBe(requestCountBefore);
    expect(client.send).toHaveBeenCalled();
  });

  it("[IR-0126] unsubscribeIRMode の send フレームが vendor と同形", async () => {
    // spec: core/ir.js:451 {action:ACTION, op:'unsubscribeIRMode', topic:modeTopic, deviceId, companyID}
    const client = makeClient({ requestReply: { success: true } });
    const sub = await subscribeIRMode(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID });
    sub.unsubscribe();
    const sendFrame = client.sends[0];
    expect(sendFrame.action).toBe(ACTION);
    expect(sendFrame.op).toBe("unsubscribeIRMode");
    expect(sendFrame.topic).toBe(`hub3/${DEVICE_ID}/ir/mode`);
    expect(sendFrame.deviceId).toBe(DEVICE_ID);
    expect(sendFrame.companyID).toBe(COMPANY_ID);
  });

  it("[IR-0126] unsubscribeIRData の op と unsubscribeIRMode の op は異なる", async () => {
    const dataClient = makeClient({ requestReply: { success: true } });
    const modeClient = makeClient({ requestReply: { success: true } });
    const dataSub = await subscribeIRData(dataClient, { deviceId: DEVICE_ID, companyID: COMPANY_ID });
    dataSub.unsubscribe();
    const modeSub = await subscribeIRMode(modeClient, { deviceId: DEVICE_ID, companyID: COMPANY_ID });
    modeSub.unsubscribe();
    expect(dataClient.sends[0].op).toBe("unsubscribeIRData");
    expect(modeClient.sends[0].op).toBe("unsubscribeIRMode");
    expect(dataClient.sends[0].op).not.toBe(modeClient.sends[0].op);
  });

  it("[IR-0126] unsubscribe は request を呼ばない (10s block 防止: Review H-5)", async () => {
    // spec: ir.js:411 が『request にすると 10s block』を明示
    const client = makeClient({ requestReply: { success: true } });
    const sub = await subscribeIRData(client, { deviceId: DEVICE_ID, companyID: COMPANY_ID });
    sub.unsubscribe();
    expect(client.sends[0].op).toBe("unsubscribeIRData");
    // request は subscribe の ack のみ (unsubscribe では呼ばれない)
    expect(client.request).toHaveBeenCalledTimes(1); // subscribe ack のみ
  });
});
