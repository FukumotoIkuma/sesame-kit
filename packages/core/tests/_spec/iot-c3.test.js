// packages/core/tests/_spec/iot-c3.test.js
//
// IOT spec TDD テスト: IOT-0056, IOT-0057, IOT-0058, IOT-0059, IOT-0062, IOT-0063
//
// 対象実装:
//   packages/core/src/iot.js             — NAMESPACE_OPS / startFirmwareUpdate など
//   packages/core/src/i18n/iot.js        — en/ja カタログ
//   packages/kit/src/cli/iot.js          — registerIotCommands / resolveTarget
//   schema/openrpc.json                  — iot.* 10 メソッド
//   packages/kit/src/serve/rpc-params.generated.json — iot.* パラメタ
//   packages/kit/sdk/ts/sesame-client.ts — iot 10 メソッド
//   packages/kit/sdk/python/sesame_client.py — iot 10 メソッド
//
// 全テストはネットワーク・実機不使用。mock / ファイル読み込みで完結。
// 期待値は spec どおり (TDD: red は許容)。

// ---------- crypto mock (import より前) ----------
import { describe, it, expect, vi, beforeAll } from "vitest";

vi.mock("../../src/crypto.js", async (importOriginal) => ({
  .../** @type {object} */ (await importOriginal()),
  cmacTime: () => "aabbccdd",
}));

// ---------- node imports ----------
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

// ---------- core imports ----------
import { NAMESPACE_OPS, startFirmwareUpdate, sendIotCmd } from "../../src/iot.js";
import iotI18n from "../../src/i18n/iot.js";

// ---------- kit CLI import ----------
import { registerIotCommands } from "../../../kit/src/cli/iot.js";

// ---------- mock helper ----------
import { chunkMockClient } from "../helpers/mock-ws.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// プロジェクトルート (packages/core/tests/_spec から 4 階層上)
const ROOT = join(__dirname, "../../../..");

// =====================================================================
// CLI ヘルパー
// =====================================================================

/**
 * fake ctx。withHub は即 fn(hub, {opts:{json:true}})。die は Error を throw し code を付与。
 */
function makeCtx({ hub, canPrompt = false } = {}) {
  const outputs = [];
  const dies = [];
  const ctx = {
    outputs,
    dies,
    out: (_json, _humanFn, jsonObj) => { outputs.push(jsonObj); },
    die: (msg, code) => {
      const e = new Error(msg);
      /** @type {any} */ (e).code = code;
      dies.push({ msg, code });
      throw e;
    },
    canPrompt: () => canPrompt,
    loadCtx: () => ({
      configStore: {
        load: () => ({ locks: {}, hub3s: {} }),
      },
    }),
    withHub: (fn) => fn(hub, { opts: { json: true } }),
    prompts: {
      promptText: vi.fn(),
      selectFromList: vi.fn(),
      confirm: vi.fn(),
      promptLine: vi.fn(),
    },
    makeBle: vi.fn(),
    parseJson: (raw) => JSON.parse(raw),
  };
  return { ctx, outputs, dies };
}

function buildProgram(ctx) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerIotCommands(program, ctx);
  return program;
}

// =====================================================================
// IOT-0056: sesame iot raw --wait/--cmd → sendIotCmdAwait。無しは fire-and-forget
// =====================================================================

describe("IOT-0056: sesame iot raw 経路分岐 (--wait → await / 無し → fire-and-forget)", () => {
  it("[IOT-0056] --wait --cmd <n> 指定時は sendIotCmdAwait を呼び {ok,awaited:true,cmd,topic,response} を返す", async () => {
    const responseMsg = { op: 92, UUID: "u1", data: { ledDuty: 80 } };
    const hub = {
      iot: {
        sendIotCmd: vi.fn(),
        sendIotCmdAwait: vi.fn(async () => responseMsg),
      },
      listDevices: vi.fn(async () => []),
    };
    const { ctx, outputs } = makeCtx({ hub });
    await buildProgram(ctx).parseAsync(
      ["iot", "raw", "--topic", "wm2ABCcmd", "--payload", "deadbeef",
        "--wait", "--cmd", "92", "--device", "u1", "--timeout", "3000"],
      { from: "user" },
    );
    expect(hub.iot.sendIotCmdAwait).toHaveBeenCalledWith({
      topic: "wm2ABCcmd",
      payload: Buffer.from("deadbeef", "hex").toString("base64"),
      cmd: 92,
      deviceId: "u1",
      timeoutMs: 3000,
    });
    expect(hub.iot.sendIotCmd).not.toHaveBeenCalled();
    expect(outputs[0]).toMatchObject({
      ok: true,
      awaited: true,
      cmd: 92,
      topic: "wm2ABCcmd",
      response: responseMsg,
    });
  });

  it("[IOT-0056] --wait なしは sendIotCmd (fire-and-forget) を呼び {ok,awaited:false,topic,note} を返す", async () => {
    const hub = {
      iot: {
        sendIotCmd: vi.fn(),
        sendIotCmdAwait: vi.fn(),
      },
      listDevices: vi.fn(async () => []),
    };
    const { ctx, outputs } = makeCtx({ hub });
    await buildProgram(ctx).parseAsync(
      ["iot", "raw", "--topic", "wm2XYZcmd", "--payload", "0102"],
      { from: "user" },
    );
    expect(hub.iot.sendIotCmd).toHaveBeenCalledWith({
      topic: "wm2XYZcmd",
      payload: Buffer.from("0102", "hex").toString("base64"),
    });
    expect(hub.iot.sendIotCmdAwait).not.toHaveBeenCalled();
    expect(outputs[0]).toMatchObject({
      ok: true,
      awaited: false,
      topic: "wm2XYZcmd",
    });
    expect(typeof outputs[0].note).toBe("string");
    expect(outputs[0].note.length).toBeGreaterThan(0);
  });

  it("[IOT-0056] --wait --timeout 省略時は timeoutMs を渡さない (undefined)", async () => {
    const hub = {
      iot: {
        sendIotCmd: vi.fn(),
        sendIotCmdAwait: vi.fn(async () => ({ op: 3 })),
      },
      listDevices: vi.fn(async () => []),
    };
    const { ctx } = makeCtx({ hub });
    await buildProgram(ctx).parseAsync(
      ["iot", "raw", "--topic", "t", "--payload", "ff", "--wait", "--cmd", "3"],
      { from: "user" },
    );
    const call = hub.iot.sendIotCmdAwait.mock.calls[0][0];
    expect(call.timeoutMs).toBeUndefined();
  });
});

// =====================================================================
// IOT-0057: resolveTarget の補完優先順位
// =====================================================================

describe("IOT-0057: iot resolveTarget 優先順位 (明示 → listDevices → config → die)", () => {
  it("[IOT-0057] --device + --secret 両方指定は即採用し listDevices を呼ばない", async () => {
    let listDevicesCalled = false;
    const hub = {
      listDevices: async () => { listDevicesCalled = true; return []; },
      iot: {
        setHub3LedDuty: vi.fn(async () => ({ ledDuty: 100 })),
      },
    };
    const { ctx } = makeCtx({ hub });
    await buildProgram(ctx).parseAsync(
      ["iot", "led", "100",
        "--device", "11111111-2222-3333-4444-555555555555",
        "--secret", "00112233445566778899aabbccddeeff"],
      { from: "user" },
    );
    expect(listDevicesCalled).toBe(false);
    const call = hub.iot.setHub3LedDuty.mock.calls[0][0];
    expect(call.deviceId).toBe("11111111-2222-3333-4444-555555555555");
    expect(call.secretKey).toBe("00112233445566778899aabbccddeeff");
  });

  it("[IOT-0057] listDevices が 1 件を返せば自動採用する", async () => {
    const hub = {
      iot: { setHub3LedDuty: vi.fn(async () => ({ ledDuty: 75 })) },
      listDevices: vi.fn(async () => [
        {
          deviceUUID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          secretKey: "ffeeddccbbaa99887766554433221100",
          deviceModel: "hub_3",
          deviceName: "my hub",
        },
      ]),
    };
    const { ctx } = makeCtx({ hub });
    await buildProgram(ctx).parseAsync(
      ["iot", "led", "50"],
      { from: "user" },
    );
    expect(hub.listDevices).toHaveBeenCalledOnce();
    expect(hub.iot.setHub3LedDuty).toHaveBeenCalledOnce();
    const call = hub.iot.setHub3LedDuty.mock.calls[0][0];
    expect(call.deviceId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(call.secretKey).toBe("ffeeddccbbaa99887766554433221100");
  });

  it("[IOT-0057] listDevices が 0 件 + config にもデバイス無しなら die(2)", async () => {
    const hub = {
      iot: { setHub3LedDuty: vi.fn() },
      listDevices: vi.fn(async () => []),
    };
    const { ctx, dies } = makeCtx({ hub, canPrompt: false });
    await expect(
      buildProgram(ctx).parseAsync(["iot", "led", "50"], { from: "user" }),
    ).rejects.toThrow();
    expect(dies[0].code).toBe(2);
    expect(hub.iot.setHub3LedDuty).not.toHaveBeenCalled();
  });

  it("[IOT-0057] listDevices が複数件 + 非対話なら die(2)", async () => {
    const hub = {
      iot: { setHub3LedDuty: vi.fn() },
      listDevices: vi.fn(async () => [
        { deviceUUID: "u1", secretKey: "s1", deviceModel: "hub_3", deviceName: "A" },
        { deviceUUID: "u2", secretKey: "s2", deviceModel: "hub_3", deviceName: "B" },
      ]),
    };
    const { ctx, dies } = makeCtx({ hub, canPrompt: false });
    await expect(
      buildProgram(ctx).parseAsync(["iot", "led", "50"], { from: "user" }),
    ).rejects.toThrow();
    expect(dies[0].code).toBe(2);
    expect(hub.iot.setHub3LedDuty).not.toHaveBeenCalled();
  });

  it("[IOT-0057] hub3s は secretKey を持たない (config 仕様)。secretKey 必須 op では --secret が要る", async () => {
    const hub = {
      iot: { setHub3LedDuty: vi.fn() },
      listDevices: vi.fn(async () => []),
    };
    const outputs = [];
    const dies = [];
    const ctx = {
      outputs,
      dies,
      out: (_json, _humanFn, jsonObj) => { outputs.push(jsonObj); },
      die: (msg, code) => {
        const e = new Error(msg);
        /** @type {any} */ (e).code = code;
        dies.push({ msg, code });
        throw e;
      },
      canPrompt: () => false,
      loadCtx: () => ({
        configStore: {
          load: () => ({
            locks: {},
            hub3s: {
              myHub: { deviceId: "hub3-uuid-0001", name: "my hub" },
            },
          }),
        },
      }),
      withHub: (fn) => fn(hub, { opts: { json: true } }),
      prompts: {
        promptText: vi.fn(),
        selectFromList: vi.fn(),
        confirm: vi.fn(),
        promptLine: vi.fn(),
      },
      makeBle: vi.fn(),
      parseJson: (raw) => JSON.parse(raw),
    };
    await expect(
      buildProgram(ctx).parseAsync(["iot", "led", "50"], { from: "user" }),
    ).rejects.toThrow();
    expect(dies[0].code).toBe(2);
    expect(hub.iot.setHub3LedDuty).not.toHaveBeenCalled();
  });
});

// =====================================================================
// IOT-0058: iot op が core/serve/sdk/cli で同一封筒 (surface-parity)
// =====================================================================

describe("IOT-0058: iot op が core/serve/sdk/cli で同一封筒 (NAMESPACE_OPS 単一真実源)", () => {
  it("[IOT-0058] NAMESPACE_OPS に 10 op が含まれ、serve/SDK の公開 op と一致する", () => {
    const expected = [
      "sendIotCmd", "sendIotCmdAwait",
      "setHub3LedDuty", "hub3RelaySwitch",
      "addSesameToHub3", "removeSesameFromHub3",
      "startFirmwareUpdate", "clearHub3WifiSsid",
      "getMatterPairingCode", "openMatterPairingWindow",
    ];
    expect(NAMESPACE_OPS).toHaveLength(10);
    for (const op of expected) {
      expect(NAMESPACE_OPS).toContain(op);
    }
  });

  it("[IOT-0058] core sendIotCmd が {action:'biz3OperateIoT',topic,payload,op:'cmd'} を送出する (共通ワイヤフレーム)", () => {
    const c = chunkMockClient();
    sendIotCmd(c, { topic: "wm2ABCDEFGHIJKLcmd", payload: "QQ==" });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: "biz3OperateIoT",
      topic: "wm2ABCDEFGHIJKLcmd",
      payload: "QQ==",
      op: "cmd",
    });
  });

  it("[IOT-0058] NAMESPACE_OPS に buildIotTopic / buildIotPayload / subscribeIotResponse / __internal が含まれない", () => {
    expect(NAMESPACE_OPS).not.toContain("buildIotTopic");
    expect(NAMESPACE_OPS).not.toContain("buildIotPayload");
    expect(NAMESPACE_OPS).not.toContain("subscribeIotResponse");
    expect(NAMESPACE_OPS).not.toContain("__internal");
  });

  it("[IOT-0058] rpc-params の iot.* キーが NAMESPACE_OPS と 1:1 で一致する", () => {
    const rpcParamsPath = join(ROOT, "packages/kit/src/serve/rpc-params.generated.json");
    const rpcParams = JSON.parse(readFileSync(rpcParamsPath, "utf8"));
    const iotKeys = Object.keys(rpcParams).filter((k) => k.startsWith("iot."));
    const iotOps = iotKeys.map((k) => k.slice("iot.".length));
    for (const op of NAMESPACE_OPS) {
      expect(iotOps, `rpc-params に iot.${op} が無い`).toContain(op);
    }
    for (const op of iotOps) {
      expect(NAMESPACE_OPS, `NAMESPACE_OPS に ${op} が無い (rpc-params に余分)`).toContain(op);
    }
    expect(iotOps).toHaveLength(NAMESPACE_OPS.length);
  });

  it("[IOT-0058] TS SDK の iot オブジェクトが NAMESPACE_OPS と 1:1 のメソッドを持つ", () => {
    const tsPath = join(ROOT, "packages/kit/sdk/ts/sesame-client.ts");
    const ts = readFileSync(tsPath, "utf8");
    for (const op of NAMESPACE_OPS) {
      expect(ts, `TS SDK に iot.${op} が無い`).toMatch(new RegExp(`\\b${op}\\s*:`));
    }
  });
});

// =====================================================================
// IOT-0059: iot.err.* / iot.*.* CLI メッセージの en/ja カタログ完全性
// =====================================================================

describe("IOT-0059: iot i18n カタログ en/ja 完全性", () => {
  const en = iotI18n.en;
  const ja = iotI18n.ja;

  it("[IOT-0059] en と ja のキー集合が完全一致 (欠落無し)", () => {
    const enKeys = new Set(Object.keys(en));
    const jaKeys = new Set(Object.keys(ja));
    const enOnlyKeys = [...enKeys].filter((k) => !jaKeys.has(k));
    const jaOnlyKeys = [...jaKeys].filter((k) => !enKeys.has(k));
    expect(enOnlyKeys, `ja に欠落しているキー: ${enOnlyKeys.join(", ")}`).toHaveLength(0);
    expect(jaOnlyKeys, `en に欠落しているキー: ${jaOnlyKeys.join(", ")}`).toHaveLength(0);
  });

  it("[IOT-0059] iot.err.* の全必須キーが en/ja に存在する", () => {
    const requiredErrKeys = [
      "iot.err.invalidHexString",
      "iot.err.hub3IdRequiredTopic",
      "iot.err.cmdRequired",
      "iot.err.deviceIdRequired",
      "iot.err.secretKeyRequiredCmac",
      "iot.err.topicRequired",
      "iot.err.payloadRequiredBase64",
      "iot.err.cmdTimeout",
      "iot.err.opDutyRequired",
      "iot.err.opDutyRange",
      "iot.err.opRange",
      "iot.err.nicknameTooLong",
      "iot.err.unknownModel",
      "iot.err.hub3IdRequired",
      "iot.err.sesameIdRequired",
      "iot.err.ssmSecKaRequired",
      "iot.err.deviceModelRequired",
    ];
    for (const key of requiredErrKeys) {
      expect(en[key], `en missing: ${key}`).toBeTruthy();
      expect(ja[key], `ja missing: ${key}`).toBeTruthy();
    }
  });

  it("[IOT-0059] cmdTimeout プレースホルダ {cmd}{topic} が en/ja 両方に含まれる", () => {
    expect(en["iot.err.cmdTimeout"]).toContain("{cmd}");
    expect(en["iot.err.cmdTimeout"]).toContain("{topic}");
    expect(ja["iot.err.cmdTimeout"]).toContain("{cmd}");
    expect(ja["iot.err.cmdTimeout"]).toContain("{topic}");
  });

  it("[IOT-0059] unknownModel プレースホルダ {model} が en/ja 両方に含まれる", () => {
    expect(en["iot.err.unknownModel"]).toContain("{model}");
    expect(ja["iot.err.unknownModel"]).toContain("{model}");
  });

  it("[IOT-0059] iot.err.* 値が空文字でない (全キーが non-empty string)", () => {
    for (const [key, val] of Object.entries(en)) {
      if (!key.startsWith("iot.err.")) continue;
      expect(typeof val, `en ${key} is not string`).toBe("string");
      expect(val.length, `en ${key} is empty`).toBeGreaterThan(0);
    }
    for (const [key, val] of Object.entries(ja)) {
      if (!key.startsWith("iot.err.")) continue;
      expect(typeof val, `ja ${key} is not string`).toBe("string");
      expect(val.length, `ja ${key} is empty`).toBeGreaterThan(0);
    }
  });

  it("[IOT-0059] CLI メッセージキーが en/ja 両方に存在する (iot.led.* / iot.relay.* / iot.firmware.* 等)", () => {
    const cliKeys = [
      "iot.led.needDuty", "iot.led.dutyRange", "iot.led.get", "iot.led.set",
      "iot.relay.badState", "iot.relay.sent",
      "iot.firmware.progress", "iot.firmware.done", "iot.firmware.timeout",
      "iot.wifiClear.sent",
      "iot.matterCode.qr", "iot.matterCode.manual",
      "iot.matterOpen.ok", "iot.matterOpen.failed", "iot.matterOpen.unknownStatus",
      "iot.sesame.ok", "iot.sesame.missing",
      "iot.raw.topicRequired", "iot.raw.payloadRequired", "iot.raw.cmdRequired",
    ];
    for (const key of cliKeys) {
      expect(en[key], `en missing: ${key}`).toBeTruthy();
      expect(ja[key], `ja missing: ${key}`).toBeTruthy();
    }
  });
});

// =====================================================================
// IOT-0062: schema/openrpc.json に iot.* 10 op が NAMESPACE_OPS と 1:1 で存在
// =====================================================================

describe("IOT-0062: openrpc.json の iot.* 10 メソッドと params/required が NAMESPACE_OPS と 1:1 一致", () => {
  let openrpcDoc;

  beforeAll(() => {
    const openrpcPath = join(ROOT, "schema/openrpc.json");
    openrpcDoc = JSON.parse(readFileSync(openrpcPath, "utf8"));
  });

  it("[IOT-0062] openrpc.json に iot.* メソッドが NAMESPACE_OPS と 1:1 で存在する (10 件)", () => {
    const methods = Array.isArray(openrpcDoc.methods) ? openrpcDoc.methods : Object.values(openrpcDoc.methods ?? openrpcDoc);
    const iotMethods = methods.filter((m) => typeof m.name === "string" && m.name.startsWith("iot."));
    const iotMethodNames = iotMethods.map((m) => m.name.slice("iot.".length));

    expect(iotMethods, "openrpc.json の iot.* メソッド数が 10 でない").toHaveLength(10);
    for (const op of NAMESPACE_OPS) {
      expect(iotMethodNames, `openrpc.json に iot.${op} が無い`).toContain(op);
    }
    for (const name of iotMethodNames) {
      expect(NAMESPACE_OPS, `openrpc.json に余分な iot.${name} がある`).toContain(name);
    }
  });

  it("[IOT-0062] iot.setHub3LedDuty の params に deviceId/secretKey/op/duty が required, hub3Id/timeoutMs が optional", () => {
    const methods = Array.isArray(openrpcDoc.methods) ? openrpcDoc.methods : Object.values(openrpcDoc.methods ?? openrpcDoc);
    const method = methods.find((m) => m.name === "iot.setHub3LedDuty");
    expect(method, "iot.setHub3LedDuty が openrpc.json に無い").toBeDefined();
    const byName = Object.fromEntries(method.params.map((p) => [p.name, p]));

    expect(byName.deviceId?.required).toBe(true);
    expect(byName.secretKey?.required).toBe(true);
    expect(byName.op?.required).toBe(true);
    expect(byName.duty?.required).toBe(true);
    expect(byName.hub3Id?.required).toBe(false);
    expect(byName.timeoutMs?.required).toBe(false);
  });

  it("[IOT-0062] iot.addSesameToHub3 の params: hub3Id/secretKey/sesameId/ssmSecKa/deviceModel required, nickName/timeoutMs optional", () => {
    const methods = Array.isArray(openrpcDoc.methods) ? openrpcDoc.methods : Object.values(openrpcDoc.methods ?? openrpcDoc);
    const method = methods.find((m) => m.name === "iot.addSesameToHub3");
    expect(method, "iot.addSesameToHub3 が openrpc.json に無い").toBeDefined();
    const byName = Object.fromEntries(method.params.map((p) => [p.name, p]));

    expect(byName.hub3Id?.required).toBe(true);
    expect(byName.secretKey?.required).toBe(true);
    expect(byName.sesameId?.required).toBe(true);
    expect(byName.ssmSecKa?.required).toBe(true);
    expect(byName.deviceModel?.required).toBe(true);
    expect(byName.nickName?.required).toBe(false);
    expect(byName.timeoutMs?.required).toBe(false);
  });

  it("[IOT-0062] iot.startFirmwareUpdate の params: deviceId/secretKey required, hub3Id optional (onProgress は無い)", () => {
    const methods = Array.isArray(openrpcDoc.methods) ? openrpcDoc.methods : Object.values(openrpcDoc.methods ?? openrpcDoc);
    const method = methods.find((m) => m.name === "iot.startFirmwareUpdate");
    expect(method, "iot.startFirmwareUpdate が openrpc.json に無い").toBeDefined();
    const byName = Object.fromEntries(method.params.map((p) => [p.name, p]));

    expect(byName.deviceId?.required).toBe(true);
    expect(byName.secretKey?.required).toBe(true);
    expect(byName.hub3Id?.required).toBe(false);
    expect(byName.onProgress).toBeUndefined();
  });

  it("[IOT-0062] openrpc.json が result-schemas.js の上流として存在する (ファイルが読める)", () => {
    const rsPath = join(ROOT, "packages/kit/src/serve/result-schemas.js");
    const rs = readFileSync(rsPath, "utf8");
    expect(rs).toMatch(/openrpc\.json/);
  });
});

// =====================================================================
// IOT-0063: startFirmwareUpdate は serve/sdk 経由で onProgress を観測できない (負事実)
// =====================================================================

describe("IOT-0063: startFirmwareUpdate は serve/SDK 経由で progress/versionTag を観測できない (負事実)", () => {
  it("[IOT-0063] core startFirmwareUpdate は onProgress 無しで呼ばれると購読せず fire-and-forget を送出する", () => {
    const c = chunkMockClient();
    const unsub = startFirmwareUpdate(c, {
      deviceId: "11111111-2222-3333-4444-555555555555",
      secretKey: "00112233445566778899aabbccddeeff",
      // onProgress 省略
    });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0].action).toBe("biz3OperateIoT");
    expect(typeof unsub).toBe("function");
    expect(c.hasSub("biz3OperateIoT:3")).toBe(false);
  });

  it("[IOT-0063] core startFirmwareUpdate は onProgress 有りでのみ購読を張る (serve 経路との非対称を確認)", () => {
    const c = chunkMockClient();
    const received = [];
    const unsub = startFirmwareUpdate(c, {
      deviceId: "11111111-2222-3333-4444-555555555555",
      secretKey: "00112233445566778899aabbccddeeff",
      onProgress: (d) => received.push(d),
    });
    expect(c.hasSub("biz3OperateIoT:3")).toBe(true);
    c.push("biz3OperateIoT:3", { op: 3, UUID: "11111111-2222-3333-4444-555555555555", data: { progress: 50 } });
    expect(received).toHaveLength(1);
    unsub();
    expect(c.hasSub("biz3OperateIoT:3")).toBe(false);
  });

  it("[IOT-0063] rpc-params の iot.startFirmwareUpdate に onProgress フィールドが無い (serve 経由では progress 不能)", () => {
    const rpcParamsPath = join(ROOT, "packages/kit/src/serve/rpc-params.generated.json");
    const rpcParams = JSON.parse(readFileSync(rpcParamsPath, "utf8"));
    const params = rpcParams["iot.startFirmwareUpdate"];
    expect(params, "iot.startFirmwareUpdate が rpc-params に無い").toBeDefined();
    const names = params.map((p) => p.name);
    expect(names).not.toContain("onProgress");
    expect(names).toContain("deviceId");
    expect(names).toContain("secretKey");
    expect(names).toContain("hub3Id");
  });

  it("[IOT-0063] TS SDK の iot.startFirmwareUpdate シグネチャに onProgress が無い", () => {
    const tsPath = join(ROOT, "packages/kit/sdk/ts/sesame-client.ts");
    const ts = readFileSync(tsPath, "utf8");
    const match = ts.match(/startFirmwareUpdate:\s*\(params:[^)]+\)/);
    expect(match, "TS SDK に startFirmwareUpdate が無い").toBeTruthy();
    const paramsText = match ? match[0] : "";
    expect(paramsText).not.toMatch(/onProgress/);
    expect(paramsText).toMatch(/deviceId/);
    expect(paramsText).toMatch(/secretKey/);
  });

  it("[IOT-0063] Python SDK の iot.startFirmwareUpdate シグネチャに onProgress が無い", () => {
    const pyPath = join(ROOT, "packages/kit/sdk/python/sesame_client.py");
    const py = readFileSync(pyPath, "utf8");
    const match = py.match(/def startFirmwareUpdate\([^)]+\)/);
    expect(match, "Python SDK に startFirmwareUpdate が無い").toBeTruthy();
    const sigText = match ? match[0] : "";
    expect(sigText).not.toMatch(/onProgress/);
    expect(sigText).toMatch(/deviceId/);
    expect(sigText).toMatch(/secretKey/);
  });

  it("[IOT-0063] serve/registry の汎用ループは onProgress を持たないため core が購読しない (負事実・アーキテクチャ境界)", () => {
    const registryPath = join(ROOT, "packages/kit/src/serve/registry.js");
    const src = readFileSync(registryPath, "utf8");
    expect(src).not.toMatch(/startFirmwareUpdate.*onProgress/);
    expect(src).not.toMatch(/onProgress.*startFirmwareUpdate/);
  });
});
