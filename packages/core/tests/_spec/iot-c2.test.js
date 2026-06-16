// packages/core/tests/_spec/iot-c2.test.js
//
// Spec-driven tests for IOT-0038 through IOT-0055.
// Each it() title is prefixed with its spec ID.
//
// Coverage:
//   IOT-0038  rpc-params + grpc-methods 10 op 1:1 with NAMESPACE_OPS
//   IOT-0039  sesame.proto Iot* RPC 10 methods 1:1
//   IOT-0040  proto Iot*Request field required/optional matches core args
//   IOT-0041  TS SDK iot.* 10 method signatures match rpc-params
//   IOT-0042  Python SDK iot.* 10 method signatures match rpc-params
//   IOT-0043  CLI led set/get branch and mapping
//   IOT-0044  CLI led arg/range validation (exit 2)
//   IOT-0045  CLI led --json envelope
//   IOT-0046  CLI relay state validation and send
//   IOT-0047  CLI relay --json envelope
//   IOT-0048  CLI firmware-update --wait progress aggregation and versionTag
//   IOT-0049  CLI wifi-clear fire-and-forget envelope
//   IOT-0050  CLI matter-code response shape
//   IOT-0051  CLI matter-open statusCode three-value judgment
//   IOT-0052  CLI add/rm-sesame required validation (exit 2)
//   IOT-0053  CLI add/rm-sesame --json envelope with ssks
//   IOT-0054  CLI raw payload normalization (hex→base64 / passthrough)
//   IOT-0055  CLI raw required / --wait dependency validation (exit 2)
//
// All tests are pure-function or mock-based — no network, no real device.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Command } from "commander";

// ── core source under test ────────────────────────────────────────────────────
import { NAMESPACE_OPS } from "../../src/iot.js";

// ── CLI registrar ─────────────────────────────────────────────────────────────
import { registerIotCommands } from "../../../kit/src/cli/iot.js";

// ── JSON contracts (static generated files) ───────────────────────────────────
const rpcParams = JSON.parse(readFileSync(new URL("../../../kit/src/serve/rpc-params.generated.json", import.meta.url)));
const grpcMethods = JSON.parse(readFileSync(new URL("../../../kit/src/serve/grpc-methods.generated.json", import.meta.url)));

// ── File paths for text-based contracts ───────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const KIT_SERVE = resolve(__dirname, "..", "..", "..", "kit", "src", "serve");
const KIT_SDK   = resolve(__dirname, "..", "..", "..", "kit", "sdk");

// ─────────────────────────────────────────────────────────────────────────────
// Shared CLI test helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal fake ctx.  withHub executes fn(hub, {opts}) immediately.
 * die() throws an Error with the exit-code attached so tests can catch it.
 * out() with json=true accumulates jsonObj into outputs array.
 */
function makeCtx({ hub, json = true } = {}) {
  const outputs = [];
  const ctx = {
    outputs,
    out: (_json, _humanFn, jsonObj) => { outputs.push(jsonObj); },
    die: (msg, code) => {
      const e = new Error(msg);
      e.code = code;
      throw e;
    },
    canPrompt: () => false,
    loadCtx: () => { throw new Error("loadCtx not used in this test"); },
    withHub: (fn) => fn(hub, { opts: { json } }),
    prompts: {
      promptText: vi.fn(),
      selectFromList: vi.fn(),
      confirm: vi.fn(),
      promptLine: vi.fn(),
    },
    makeBle: vi.fn(),
    parseJson: (raw) => JSON.parse(raw),
  };
  return ctx;
}

function buildProgram(ctx) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerIotCommands(program, ctx);
  return program;
}

/**
 * Minimal hub stub for iot commands.
 * hub.iot mock is wired with sane defaults; override per-test as needed.
 */
function makeHub(iotOverrides = {}) {
  return {
    listDevices: vi.fn(async () => [
      {
        deviceUUID: "11111111-2222-3333-4444-555555555555",
        secretKey: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
        deviceModel: "hub_3",
        deviceName: "test-hub",
      },
    ]),
    iot: {
      setHub3LedDuty:          vi.fn(async () => ({ ledDuty: 80 })),
      hub3RelaySwitch:         vi.fn(async () => undefined),
      startFirmwareUpdate:     vi.fn(() => () => {}),
      clearHub3WifiSsid:       vi.fn(async () => undefined),
      getMatterPairingCode:    vi.fn(async () => ({ qrCode: "MT:QRCODE", manualCode: "123-4567" })),
      openMatterPairingWindow: vi.fn(async () => ({ statusCode: 0 })),
      addSesameToHub3:         vi.fn(async () => ({ ssks: [{ id: 1 }] })),
      removeSesameFromHub3:    vi.fn(async () => ({ ssks: [] })),
      sendIotCmd:              vi.fn(),
      sendIotCmdAwait:         vi.fn(async (p) => ({ op: p.cmd, data: {} })),
      ...iotOverrides,
    },
  };
}

// Common --device / --secret args used in most CLI tests
const DEVICE_ID  = "11111111-2222-3333-4444-555555555555";
const SECRET_KEY = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const DEVICE_ARGS = ["--device", DEVICE_ID, "--secret", SECRET_KEY];

afterEach(() => vi.restoreAllMocks());

// ─────────────────────────────────────────────────────────────────────────────
// IOT-0038  rpc-params + grpc-methods 10 op 1:1 with NAMESPACE_OPS
// ─────────────────────────────────────────────────────────────────────────────

describe("[IOT-0038] rpc-params.generated.json と grpc-methods.generated.json が NAMESPACE_OPS 10 op と 1:1", () => {
  it("[IOT-0038] rpc-params に iot.* 10 op がすべて存在する", () => {
    for (const op of NAMESPACE_OPS) {
      const key = `iot.${op}`;
      expect(Object.keys(rpcParams)).toContain(key);
    }
  });

  it("[IOT-0038] rpc-params に余分な iot.* エントリが無い (NAMESPACE_OPS と完全一致)", () => {
    const iotKeys = Object.keys(rpcParams).filter((k) => k.startsWith("iot.")).map((k) => k.slice(4));
    expect(iotKeys.sort()).toEqual([...NAMESPACE_OPS].sort());
  });

  it("[IOT-0038] setHub3LedDuty rpc-params で op/duty が required, hub3Id/timeoutMs が optional", () => {
    const params = rpcParams["iot.setHub3LedDuty"];
    expect(Array.isArray(params)).toBe(true);
    const byName = Object.fromEntries(params.map((p) => [p.name, p]));
    expect(byName.op.required).toBe(true);
    expect(byName.duty.required).toBe(true);
    expect(byName.hub3Id.required).toBe(false);
    expect(byName.timeoutMs.required).toBe(false);
  });

  it("[IOT-0038] addSesameToHub3 rpc-params: hub3Id/secretKey/sesameId/ssmSecKa/deviceModel required, nickName/timeoutMs optional", () => {
    const params = rpcParams["iot.addSesameToHub3"];
    expect(params).toBeDefined();
    const byName = Object.fromEntries(params.map((p) => [p.name, p]));
    expect(byName.hub3Id.required).toBe(true);
    expect(byName.secretKey.required).toBe(true);
    expect(byName.sesameId.required).toBe(true);
    expect(byName.ssmSecKa.required).toBe(true);
    expect(byName.deviceModel.required).toBe(true);
    expect(byName.nickName.required).toBe(false);
    expect(byName.timeoutMs.required).toBe(false);
  });

  it("[IOT-0038] startFirmwareUpdate rpc-params: hub3Id optional, onProgress なし", () => {
    const params = rpcParams["iot.startFirmwareUpdate"];
    expect(params).toBeDefined();
    const byName = Object.fromEntries(params.map((p) => [p.name, p]));
    expect(byName.hub3Id.required).toBe(false);
    // onProgress は rpc-params に存在しない (serve/sdk 越しには progress 観測不能)
    expect(byName.onProgress).toBeUndefined();
  });

  it("[IOT-0038] grpc-methods に Iot* 10 エントリが存在し method が 1:1 対応", () => {
    const expectedRpcNames = NAMESPACE_OPS.map(
      (op) => "Iot" + op.charAt(0).toUpperCase() + op.slice(1),
    );
    for (const rpcName of expectedRpcNames) {
      expect(grpcMethods, `grpc-methods should contain ${rpcName}`).toHaveProperty(rpcName);
    }
    // 余分な Iot* エントリが無いこと
    const iotEntries = Object.keys(grpcMethods).filter((k) => k.startsWith("Iot"));
    expect(iotEntries).toHaveLength(NAMESPACE_OPS.length);
  });

  it("[IOT-0038] grpc-methods の IotSetHub3LedDuty: optionalScalars が hub3Id/timeoutMs", () => {
    const entry = grpcMethods["IotSetHub3LedDuty"];
    expect(entry).toBeDefined();
    expect(entry.optionalScalars).toContain("hub3Id");
    expect(entry.optionalScalars).toContain("timeoutMs");
    expect(entry.optionalScalars).not.toContain("op");
    expect(entry.optionalScalars).not.toContain("duty");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IOT-0039  sesame.proto Iot* RPC 10 methods 1:1
// ─────────────────────────────────────────────────────────────────────────────

describe("[IOT-0039] sesame.proto に Iot* RPC が NAMESPACE_OPS の 10 op と 1:1 で存在する", () => {
  it("[IOT-0039] proto に 10 件の Iot* rpc 行がある (subscribeIotResponse 除外)", () => {
    const proto = readFileSync(resolve(KIT_SERVE, "sesame.proto"), "utf8");
    const iotRpcs = [...proto.matchAll(/^\s*rpc\s+(Iot\w+)\s*\(/gm)].map((m) => m[1]);
    expect(iotRpcs).toHaveLength(10);
    const expectedRpcNames = NAMESPACE_OPS.map(
      (op) => "Iot" + op.charAt(0).toUpperCase() + op.slice(1),
    );
    expect(iotRpcs.sort()).toEqual(expectedRpcNames.sort());
  });

  it("[IOT-0039] subscribeIotResponse は proto RPC に含まれない", () => {
    const proto = readFileSync(resolve(KIT_SERVE, "sesame.proto"), "utf8");
    expect(proto).not.toMatch(/rpc\s+IotSubscribeIotResponse\s*\(/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IOT-0040  proto Iot*Request field required/optional matches core args
// ─────────────────────────────────────────────────────────────────────────────

describe("[IOT-0040] proto Iot*Request フィールドの required/optional が core 引数形と一致", () => {
  let proto;

  beforeEach(() => {
    proto = readFileSync(resolve(KIT_SERVE, "sesame.proto"), "utf8");
  });

  it("[IOT-0040] IotSendIotCmdRequest: topic/payload required, op optional", () => {
    const block = proto.match(/message\s+IotSendIotCmdRequest\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(block).toMatch(/string\s+topic/);
    expect(block).toMatch(/string\s+payload/);
    expect(block).toMatch(/optional\s+string\s+op/);
    // topic and payload must NOT be optional
    expect(block).not.toMatch(/optional\s+string\s+topic/);
    expect(block).not.toMatch(/optional\s+string\s+payload/);
  });

  it("[IOT-0040] IotSendIotCmdAwaitRequest: topic/payload/cmd required; deviceId/timeoutMs optional", () => {
    const block = proto.match(/message\s+IotSendIotCmdAwaitRequest\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(block).toMatch(/string\s+topic/);
    expect(block).toMatch(/string\s+payload/);
    expect(block).toMatch(/double\s+cmd/);
    expect(block).toMatch(/optional\s+string\s+deviceId/);
    expect(block).toMatch(/optional\s+double\s+timeoutMs/);
    expect(block).not.toMatch(/optional\s+string\s+topic/);
    expect(block).not.toMatch(/optional\s+string\s+payload/);
    expect(block).not.toMatch(/optional\s+double\s+cmd\b/);
  });

  it("[IOT-0040] IotSetHub3LedDutyRequest: op/duty required; hub3Id/timeoutMs optional", () => {
    const block = proto.match(/message\s+IotSetHub3LedDutyRequest\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(block).toMatch(/double\s+op/);
    expect(block).toMatch(/double\s+duty/);
    expect(block).toMatch(/optional\s+string\s+hub3Id/);
    expect(block).toMatch(/optional\s+double\s+timeoutMs/);
    // required fields must NOT have optional keyword
    expect(block).not.toMatch(/optional\s+double\s+op\b/);
    expect(block).not.toMatch(/optional\s+double\s+duty\b/);
  });

  it("[IOT-0040] IotAddSesameToHub3Request: hub3Id/secretKey/sesameId/ssmSecKa/deviceModel required; nickName/timeoutMs optional", () => {
    const block = proto.match(/message\s+IotAddSesameToHub3Request\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(block).toMatch(/string\s+hub3Id/);
    expect(block).toMatch(/string\s+secretKey/);
    expect(block).toMatch(/string\s+sesameId/);
    expect(block).toMatch(/string\s+ssmSecKa/);
    expect(block).toMatch(/string\s+deviceModel/);
    expect(block).toMatch(/optional\s+string\s+nickName/);
    expect(block).toMatch(/optional\s+double\s+timeoutMs/);
    expect(block).not.toMatch(/optional\s+string\s+hub3Id/);
    expect(block).not.toMatch(/optional\s+string\s+deviceModel/);
  });

  it("[IOT-0040] IotStartFirmwareUpdateRequest: hub3Id optional, onProgress フィールドなし", () => {
    const block = proto.match(/message\s+IotStartFirmwareUpdateRequest\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(block).toMatch(/optional\s+string\s+hub3Id/);
    // onProgress は proto に存在しない
    expect(block).not.toMatch(/onProgress/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IOT-0041  TS SDK iot.* 10 method signatures match rpc-params
// ─────────────────────────────────────────────────────────────────────────────

describe("[IOT-0041] TS SDK に iot.* 10 メソッドが生成され required/optional が rpc-params と一致", () => {
  let ts;

  beforeEach(() => {
    ts = readFileSync(resolve(KIT_SDK, "ts/sesame-client.ts"), "utf8");
  });

  it("[IOT-0041] sesame-client.ts に readonly iot = { ... } ブロックが存在する", () => {
    expect(ts).toMatch(/readonly\s+iot\s*=/);
  });

  it("[IOT-0041] TS SDK iot.* 10 op が存在し _call する", () => {
    for (const op of NAMESPACE_OPS) {
      expect(ts, `TS SDK should define ${op}:`).toMatch(new RegExp(`${op}:\\s*\\(params:`));
      expect(ts, `TS SDK should _call("iot.${op}", ...)`).toMatch(
        new RegExp(`_call\\("iot\\.${op}"`),
      );
    }
  });

  it("[IOT-0041] addSesameToHub3: hub3Id/secretKey/sesameId/ssmSecKa/deviceModel required, nickName/timeoutMs optional", () => {
    const block = ts.match(/addSesameToHub3:\s*\(params:\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(block).toMatch(/hub3Id:\s*string/);
    expect(block).toMatch(/secretKey:\s*string/);
    expect(block).toMatch(/sesameId:\s*string/);
    expect(block).toMatch(/ssmSecKa:\s*string/);
    expect(block).toMatch(/deviceModel:\s*string/);
    expect(block).toMatch(/nickName\?:\s*string/);
    expect(block).toMatch(/timeoutMs\?:\s*number/);
    expect(block).not.toMatch(/hub3Id\?/);
    expect(block).not.toMatch(/deviceModel\?/);
  });

  it("[IOT-0041] setHub3LedDuty: op/duty required, hub3Id/timeoutMs optional", () => {
    const block = ts.match(/setHub3LedDuty:\s*\(params:\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(block).toMatch(/op:\s*number/);
    expect(block).toMatch(/duty:\s*number/);
    expect(block).toMatch(/hub3Id\?:\s*string/);
    expect(block).toMatch(/timeoutMs\?:\s*number/);
    expect(block).not.toMatch(/op\?/);
    expect(block).not.toMatch(/duty\?/);
  });

  it("[IOT-0041] startFirmwareUpdate: hub3Id optional, onProgress なし", () => {
    const block = ts.match(/startFirmwareUpdate:\s*\(params:\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(block).toMatch(/hub3Id\?/);
    expect(block).not.toMatch(/onProgress/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IOT-0042  Python SDK iot.* 10 method signatures match rpc-params
// ─────────────────────────────────────────────────────────────────────────────

describe("[IOT-0042] Python SDK に iot.* 10 メソッドが生成され required/optional が rpc-params と一致", () => {
  let py;

  beforeEach(() => {
    py = readFileSync(resolve(KIT_SDK, "python/sesame_client.py"), "utf8");
  });

  it("[IOT-0042] sesame_client.py に class _Iot が存在する", () => {
    expect(py).toMatch(/class\s+_Iot/);
  });

  it("[IOT-0042] Python SDK _Iot クラスに 10 メソッドが存在する", () => {
    const classBlock = py.match(/class _Iot[\s\S]+?(?=\nclass )/)?.[0] ?? "";
    const methods = [...classBlock.matchAll(/^\s+def (\w+)\(/gm)]
      .map((m) => m[1])
      .filter((n) => n !== "__init__");
    expect(methods.sort()).toEqual([...NAMESPACE_OPS].sort());
  });

  it("[IOT-0042] Python SDK iot 10 op が _call する", () => {
    for (const op of NAMESPACE_OPS) {
      expect(py, `Python SDK should define def ${op}(`).toMatch(new RegExp(`def ${op}\\(`));
      expect(py, `Python SDK should _call("iot.${op}", ...)`).toMatch(
        new RegExp(`"iot\\.${op}"`),
      );
    }
  });

  it("[IOT-0042] setHub3LedDuty: op/duty required (no default), hub3Id/timeoutMs = None (optional)", () => {
    const line = py.match(/def setHub3LedDuty\(self,\s*\*,([^)]+)\)/)?.[1] ?? "";
    expect(line).toMatch(/op:\s*float/);
    expect(line).toMatch(/duty:\s*float/);
    expect(line).toMatch(/hub3Id.*None/);
    expect(line).toMatch(/timeoutMs.*None/);
    // required params must NOT have | None
    expect(line).not.toMatch(/op:\s*float \| None/);
    expect(line).not.toMatch(/duty:\s*float \| None/);
  });

  it("[IOT-0042] addSesameToHub3: hub3Id/secretKey/sesameId/ssmSecKa/deviceModel required; nickName/timeoutMs = None", () => {
    const line = py.match(/def addSesameToHub3\(self,\s*\*,([^)]+)\)/)?.[1] ?? "";
    expect(line).toMatch(/hub3Id:\s*str/);
    expect(line).toMatch(/secretKey:\s*str/);
    expect(line).toMatch(/sesameId:\s*str/);
    expect(line).toMatch(/ssmSecKa:\s*str/);
    expect(line).toMatch(/deviceModel:\s*str/);
    expect(line).toMatch(/nickName.*None/);
    expect(line).toMatch(/timeoutMs.*None/);
    expect(line).not.toMatch(/hub3Id:\s*str \| None/);
    expect(line).not.toMatch(/deviceModel:\s*str \| None/);
  });

  it("[IOT-0042] startFirmwareUpdate: hub3Id = None, onProgress なし", () => {
    const line = py.match(/def startFirmwareUpdate\(self,\s*\*,([^)]+)\)/)?.[1] ?? "";
    expect(line).toMatch(/hub3Id.*None/);
    expect(line).not.toMatch(/onProgress/);
  });

  it("[IOT-0042] _omit_none が定義・使用されている", () => {
    expect(py).toMatch(/def _omit_none/);
    expect(py).toMatch(/_omit_none\(\{/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IOT-0043  CLI led set/get branch and mapping
// ─────────────────────────────────────────────────────────────────────────────

describe("[IOT-0043] sesame iot led set/get 分岐と setHub3LedDuty への写像", () => {
  it("[IOT-0043] duty 指定 (set): op=0x01, duty=dutyNum で setHub3LedDuty を呼ぶ", async () => {
    const hub = makeHub();
    const ctx = makeCtx({ hub });
    await buildProgram(ctx).parseAsync(
      ["iot", "led", "100", ...DEVICE_ARGS],
      { from: "user" },
    );
    expect(hub.iot.setHub3LedDuty).toHaveBeenCalledWith(
      expect.objectContaining({ op: 0x01, duty: 100 }),
    );
    expect(ctx.outputs[0]).toMatchObject({ ok: true, op: "set", duty: 100 });
  });

  it("[IOT-0043] --get: op=0x02 で setHub3LedDuty を呼ぶ", async () => {
    const hub = makeHub();
    const ctx = makeCtx({ hub });
    await buildProgram(ctx).parseAsync(
      ["iot", "led", "--get", ...DEVICE_ARGS],
      { from: "user" },
    );
    expect(hub.iot.setHub3LedDuty).toHaveBeenCalledWith(
      expect.objectContaining({ op: 0x02 }),
    );
    expect(ctx.outputs[0]).toMatchObject({ ok: true, op: "get" });
  });

  it("[IOT-0043] get 時 duty は封筒に含まれない (undefined)", async () => {
    const hub = makeHub();
    const ctx = makeCtx({ hub });
    await buildProgram(ctx).parseAsync(
      ["iot", "led", "--get", ...DEVICE_ARGS],
      { from: "user" },
    );
    expect(ctx.outputs[0].duty).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IOT-0044  CLI led arg/range validation (exit 2)
// ─────────────────────────────────────────────────────────────────────────────

describe("[IOT-0044] sesame iot led 引数/範囲検証 (exit 2)", () => {
  it("[IOT-0044] set モードで duty 未指定は die(2)", async () => {
    const hub = makeHub();
    const ctx = makeCtx({ hub });
    await expect(
      buildProgram(ctx).parseAsync(["iot", "led", ...DEVICE_ARGS], { from: "user" }),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.iot.setHub3LedDuty).not.toHaveBeenCalled();
  });

  it("[IOT-0044] duty が 255 超 (256) で die(2)", async () => {
    const hub = makeHub();
    const ctx = makeCtx({ hub });
    await expect(
      buildProgram(ctx).parseAsync(["iot", "led", "256", ...DEVICE_ARGS], { from: "user" }),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.iot.setHub3LedDuty).not.toHaveBeenCalled();
  });

  it("[IOT-0044] duty が 0 未満 (-1) で die(2)", async () => {
    const hub = makeHub();
    const ctx = makeCtx({ hub });
    await expect(
      buildProgram(ctx).parseAsync(["iot", "led", "-1", ...DEVICE_ARGS], { from: "user" }),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.iot.setHub3LedDuty).not.toHaveBeenCalled();
  });

  it("[IOT-0044] 境界値 duty=0 は許可", async () => {
    const hub = makeHub();
    const ctx = makeCtx({ hub });
    await buildProgram(ctx).parseAsync(
      ["iot", "led", "0", ...DEVICE_ARGS],
      { from: "user" },
    );
    expect(hub.iot.setHub3LedDuty).toHaveBeenCalledWith(
      expect.objectContaining({ duty: 0 }),
    );
  });

  it("[IOT-0044] 境界値 duty=255 は許可", async () => {
    const hub = makeHub();
    const ctx = makeCtx({ hub });
    await buildProgram(ctx).parseAsync(
      ["iot", "led", "255", ...DEVICE_ARGS],
      { from: "user" },
    );
    expect(hub.iot.setHub3LedDuty).toHaveBeenCalledWith(
      expect.objectContaining({ duty: 255 }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IOT-0045  CLI led --json envelope
// ─────────────────────────────────────────────────────────────────────────────

describe("[IOT-0045] sesame iot led --json 封筒", () => {
  it("[IOT-0045] set --json: {ok:true, op:'set', duty:<n>, ledDuty:<n>}", async () => {
    const hub = makeHub({
      setHub3LedDuty: vi.fn(async () => ({ ledDuty: 75 })),
    });
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["iot", "led", "50", ...DEVICE_ARGS],
      { from: "user" },
    );
    expect(ctx.outputs[0]).toEqual({ ok: true, op: "set", duty: 50, ledDuty: 75 });
  });

  it("[IOT-0045] get --json: {ok:true, op:'get', duty:undefined, ledDuty:<n>}", async () => {
    const hub = makeHub({
      setHub3LedDuty: vi.fn(async () => ({ ledDuty: 60 })),
    });
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["iot", "led", "--get", ...DEVICE_ARGS],
      { from: "user" },
    );
    expect(ctx.outputs[0]).toEqual({ ok: true, op: "get", duty: undefined, ledDuty: 60 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IOT-0046  CLI relay state validation and send
// ─────────────────────────────────────────────────────────────────────────────

describe("[IOT-0046] sesame iot relay <state> 検証と送信", () => {
  it("[IOT-0046] state=toggle で hub3RelaySwitch(op:0x01) を fire-and-forget", async () => {
    const hub = makeHub();
    const ctx = makeCtx({ hub });
    await buildProgram(ctx).parseAsync(
      ["iot", "relay", "toggle", ...DEVICE_ARGS],
      { from: "user" },
    );
    expect(hub.iot.hub3RelaySwitch).toHaveBeenCalledWith(
      expect.objectContaining({ op: 0x01 }),
    );
    expect(ctx.outputs[0]).toMatchObject({ ok: true, sent: true, state: "toggle" });
  });

  it("[IOT-0046] state=on で hub3RelaySwitch(op:0x01) を呼ぶ", async () => {
    const hub = makeHub();
    const ctx = makeCtx({ hub });
    await buildProgram(ctx).parseAsync(
      ["iot", "relay", "on", ...DEVICE_ARGS],
      { from: "user" },
    );
    expect(hub.iot.hub3RelaySwitch).toHaveBeenCalledWith(
      expect.objectContaining({ op: 0x01 }),
    );
    expect(ctx.outputs[0]).toMatchObject({ ok: true, sent: true, state: "on" });
  });

  it("[IOT-0046] 無効な state (e.g. 'off') は die(2) し hub3RelaySwitch は呼ばれない", async () => {
    const hub = makeHub();
    const ctx = makeCtx({ hub });
    await expect(
      buildProgram(ctx).parseAsync(
        ["iot", "relay", "off", ...DEVICE_ARGS],
        { from: "user" },
      ),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.iot.hub3RelaySwitch).not.toHaveBeenCalled();
  });

  it("[IOT-0046] state 大文字小文字は正規化 (TOGGLE → toggle) される", async () => {
    const hub = makeHub();
    const ctx = makeCtx({ hub });
    await buildProgram(ctx).parseAsync(
      ["iot", "relay", "TOGGLE", ...DEVICE_ARGS],
      { from: "user" },
    );
    expect(hub.iot.hub3RelaySwitch).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IOT-0047  CLI relay --json envelope
// ─────────────────────────────────────────────────────────────────────────────

describe("[IOT-0047] sesame iot relay --json 封筒 (fire-and-forget 注記)", () => {
  it("[IOT-0047] --json が {ok:true, sent:true, state, op:0x01, note:'fire-and-forget (応答未確認)'} を返す", async () => {
    const hub = makeHub();
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["iot", "relay", "toggle", ...DEVICE_ARGS],
      { from: "user" },
    );
    expect(ctx.outputs[0]).toEqual({
      ok: true,
      sent: true,
      state: "toggle",
      op: 0x01,
      note: "fire-and-forget (応答未確認)",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IOT-0048  CLI firmware-update --wait progress aggregation and versionTag
// ─────────────────────────────────────────────────────────────────────────────

describe("[IOT-0048] sesame iot firmware-update --wait progress 集約と versionTag 早期終了", () => {
  it("[IOT-0048] versionTag 受信で completed:true、events に全 progress が含まれる", async () => {
    const hub = makeHub({
      startFirmwareUpdate: vi.fn((params) => {
        // fire progress events synchronously
        params.onProgress?.({ progress: 50 });
        params.onProgress?.({ progress: 100, versionTag: "1.2.3" });
        return () => {};
      }),
    });
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["iot", "firmware-update", "--wait", "1", ...DEVICE_ARGS],
      { from: "user" },
    );
    expect(ctx.outputs[0]).toMatchObject({ ok: true, completed: true });
    expect(ctx.outputs[0].events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ progress: 50 }),
        expect.objectContaining({ versionTag: "1.2.3" }),
      ]),
    );
    expect(ctx.outputs[0].events.length).toBeGreaterThanOrEqual(2);
  });

  it("[IOT-0048] versionTag なしで timeout した場合は completed:false", async () => {
    vi.useFakeTimers();
    const hub = makeHub({
      startFirmwareUpdate: vi.fn((params) => {
        params.onProgress?.({ progress: 20 });
        return () => {};
      }),
    });
    const ctx = makeCtx({ hub, json: true });
    const parsePromise = buildProgram(ctx).parseAsync(
      ["iot", "firmware-update", "--wait", "1", ...DEVICE_ARGS],
      { from: "user" },
    );
    // Advance timers past the 1-second timeout (waitForCompletion interval is 250ms)
    await vi.advanceTimersByTimeAsync(2000);
    await parsePromise;
    vi.useRealTimers();
    expect(ctx.outputs[0]).toMatchObject({ ok: true, completed: false });
  });

  it("[IOT-0048] startFirmwareUpdate の戻り値 (unsub) が waitForCompletion 後に呼ばれる", async () => {
    const unsub = vi.fn();
    const hub = makeHub({
      startFirmwareUpdate: vi.fn((params) => {
        params.onProgress?.({ progress: 100, versionTag: "2.0.0" });
        return unsub;
      }),
    });
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["iot", "firmware-update", "--wait", "1", ...DEVICE_ARGS],
      { from: "user" },
    );
    expect(unsub).toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IOT-0049  CLI wifi-clear fire-and-forget
// ─────────────────────────────────────────────────────────────────────────────

describe("[IOT-0049] sesame iot wifi-clear fire-and-forget", () => {
  it("[IOT-0049] clearHub3WifiSsid を呼び {ok:true,sent:true,note:'fire-and-forget (応答未確認)'} 封筒", async () => {
    const hub = makeHub();
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["iot", "wifi-clear", ...DEVICE_ARGS],
      { from: "user" },
    );
    expect(hub.iot.clearHub3WifiSsid).toHaveBeenCalled();
    expect(ctx.outputs[0]).toMatchObject({
      ok: true,
      sent: true,
      note: "fire-and-forget (応答未確認)",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IOT-0050  CLI matter-code response shape
// ─────────────────────────────────────────────────────────────────────────────

describe("[IOT-0050] sesame iot matter-code 応答整形", () => {
  it("[IOT-0050] getMatterPairingCode を await し {ok:true, qrCode, manualCode} 封筒", async () => {
    const hub = makeHub({
      getMatterPairingCode: vi.fn(async () => ({ qrCode: "MT:XXXX", manualCode: "123-456" })),
    });
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["iot", "matter-code", ...DEVICE_ARGS],
      { from: "user" },
    );
    expect(hub.iot.getMatterPairingCode).toHaveBeenCalled();
    expect(ctx.outputs[0]).toEqual({ ok: true, qrCode: "MT:XXXX", manualCode: "123-456" });
  });

  it("[IOT-0050] qrCode/manualCode が undefined の場合もクラッシュしない (data 欠落)", async () => {
    const hub = makeHub({
      getMatterPairingCode: vi.fn(async () => ({})),
    });
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["iot", "matter-code", ...DEVICE_ARGS],
      { from: "user" },
    );
    expect(ctx.outputs[0]).toMatchObject({ ok: true });
    expect(ctx.outputs[0].qrCode).toBeUndefined();
    expect(ctx.outputs[0].manualCode).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IOT-0051  CLI matter-open statusCode three-value judgment
// ─────────────────────────────────────────────────────────────────────────────

describe("[IOT-0051] sesame iot matter-open statusCode 三値判定", () => {
  it("[IOT-0051] statusCode===0: {ok:true, statusCode:0}", async () => {
    const hub = makeHub({
      openMatterPairingWindow: vi.fn(async () => ({ statusCode: 0 })),
    });
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["iot", "matter-open", ...DEVICE_ARGS],
      { from: "user" },
    );
    expect(ctx.outputs[0]).toMatchObject({ ok: true, statusCode: 0 });
  });

  it("[IOT-0051] statusCode 非0 (e.g. 5): {ok:false, statusCode:5}", async () => {
    const hub = makeHub({
      openMatterPairingWindow: vi.fn(async () => ({ statusCode: 5 })),
    });
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["iot", "matter-open", ...DEVICE_ARGS],
      { from: "user" },
    );
    expect(ctx.outputs[0]).toMatchObject({ ok: false, statusCode: 5 });
  });

  it("[IOT-0051] statusCode 欠落: ok:null — 失敗と断定しない", async () => {
    const hub = makeHub({
      openMatterPairingWindow: vi.fn(async () => ({})),
    });
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["iot", "matter-open", ...DEVICE_ARGS],
      { from: "user" },
    );
    // hasStatus=false → ok:null (cli/iot.js の三値判定)
    expect(ctx.outputs[0]).toMatchObject({ ok: null });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IOT-0052  CLI add/rm-sesame required validation (exit 2)
// ─────────────────────────────────────────────────────────────────────────────

describe("[IOT-0052] sesame iot add/rm-sesame 明示必須 (対話補完なし)・exit2", () => {
  const FULL_SESAME_ARGS = [
    "--hub3",   "11111111-2222-3333-4444-555555555555",
    "--secret", SECRET_KEY,
    "--sesame", "aabbccdd-eeff-0011-2233-445566778899",
    "--ssm-sec","ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100",
    "--model",  "sesame_5",
  ];

  it("[IOT-0052] 必須5項目が揃えば add-sesame は addSesameToHub3 を呼ぶ", async () => {
    const hub = makeHub();
    const ctx = makeCtx({ hub });
    await buildProgram(ctx).parseAsync(
      ["iot", "add-sesame", ...FULL_SESAME_ARGS],
      { from: "user" },
    );
    expect(hub.iot.addSesameToHub3).toHaveBeenCalled();
    expect(ctx.outputs[0]).toMatchObject({ ok: true, mode: "add" });
  });

  it("[IOT-0052] rm-sesame 5項目揃い: removeSesameFromHub3 を呼ぶ", async () => {
    const hub = makeHub();
    const ctx = makeCtx({ hub });
    await buildProgram(ctx).parseAsync(
      ["iot", "rm-sesame", ...FULL_SESAME_ARGS],
      { from: "user" },
    );
    expect(hub.iot.removeSesameFromHub3).toHaveBeenCalled();
    expect(ctx.outputs[0]).toMatchObject({ ok: true, mode: "remove" });
  });

  it("[IOT-0052] --hub3 欠落で die(2)", async () => {
    const hub = makeHub();
    const ctx = makeCtx({ hub });
    const idx = FULL_SESAME_ARGS.indexOf("--hub3");
    const args = FULL_SESAME_ARGS.filter((_, i) => i !== idx && i !== idx + 1);
    await expect(
      buildProgram(ctx).parseAsync(["iot", "add-sesame", ...args], { from: "user" }),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.iot.addSesameToHub3).not.toHaveBeenCalled();
  });

  it("[IOT-0052] --secret 欠落で die(2)", async () => {
    const hub = makeHub();
    const ctx = makeCtx({ hub });
    const idx = FULL_SESAME_ARGS.indexOf("--secret");
    const args = FULL_SESAME_ARGS.filter((_, i) => i !== idx && i !== idx + 1);
    await expect(
      buildProgram(ctx).parseAsync(["iot", "add-sesame", ...args], { from: "user" }),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.iot.addSesameToHub3).not.toHaveBeenCalled();
  });

  it("[IOT-0052] --sesame 欠落で die(2)", async () => {
    const hub = makeHub();
    const ctx = makeCtx({ hub });
    const idx = FULL_SESAME_ARGS.indexOf("--sesame");
    const args = FULL_SESAME_ARGS.filter((_, i) => i !== idx && i !== idx + 1);
    await expect(
      buildProgram(ctx).parseAsync(["iot", "add-sesame", ...args], { from: "user" }),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.iot.addSesameToHub3).not.toHaveBeenCalled();
  });

  it("[IOT-0052] --model 欠落で die(2)", async () => {
    const hub = makeHub();
    const ctx = makeCtx({ hub });
    const idx = FULL_SESAME_ARGS.indexOf("--model");
    const args = FULL_SESAME_ARGS.filter((_, i) => i !== idx && i !== idx + 1);
    await expect(
      buildProgram(ctx).parseAsync(["iot", "add-sesame", ...args], { from: "user" }),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.iot.addSesameToHub3).not.toHaveBeenCalled();
  });

  it("[IOT-0052] rm-sesame: --hub3 欠落で die(2)", async () => {
    const hub = makeHub();
    const ctx = makeCtx({ hub });
    const idx = FULL_SESAME_ARGS.indexOf("--hub3");
    const args = FULL_SESAME_ARGS.filter((_, i) => i !== idx && i !== idx + 1);
    await expect(
      buildProgram(ctx).parseAsync(["iot", "rm-sesame", ...args], { from: "user" }),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.iot.removeSesameFromHub3).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IOT-0053  CLI add/rm-sesame --json envelope with ssks
// ─────────────────────────────────────────────────────────────────────────────

describe("[IOT-0053] sesame iot add/rm-sesame --json 封筒 (ssks 含む)", () => {
  const FULL_SESAME_ARGS = [
    "--hub3",   "11111111-2222-3333-4444-555555555555",
    "--secret", SECRET_KEY,
    "--sesame", "aabbccdd-eeff-0011-2233-445566778899",
    "--ssm-sec","ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100",
    "--model",  "sesame_5",
  ];

  it("[IOT-0053] add-sesame --json: {ok:true, mode:'add', sesameId, hub3Id, ssks}", async () => {
    const hub = makeHub({
      addSesameToHub3: vi.fn(async () => ({ ssks: [{ id: 1 }, { id: 2 }] })),
    });
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["iot", "add-sesame", ...FULL_SESAME_ARGS],
      { from: "user" },
    );
    expect(ctx.outputs[0]).toMatchObject({
      ok: true,
      mode: "add",
      sesameId: "aabbccdd-eeff-0011-2233-445566778899",
      hub3Id: "11111111-2222-3333-4444-555555555555",
      ssks: [{ id: 1 }, { id: 2 }],
    });
  });

  it("[IOT-0053] rm-sesame --json: {ok:true, mode:'remove', ssks}", async () => {
    const hub = makeHub({
      removeSesameFromHub3: vi.fn(async () => ({ ssks: [] })),
    });
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["iot", "rm-sesame", ...FULL_SESAME_ARGS],
      { from: "user" },
    );
    expect(ctx.outputs[0]).toMatchObject({ ok: true, mode: "remove", ssks: [] });
  });

  it("[IOT-0053] ssks が undefined の場合も ok:true で返す (undefined はそのまま封筒に)", async () => {
    const hub = makeHub({
      addSesameToHub3: vi.fn(async () => ({})),
    });
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["iot", "add-sesame", ...FULL_SESAME_ARGS],
      { from: "user" },
    );
    expect(ctx.outputs[0]).toMatchObject({ ok: true, mode: "add" });
    expect(Object.prototype.hasOwnProperty.call(ctx.outputs[0], "ssks")).toBe(true);
    expect(ctx.outputs[0].ssks).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IOT-0054  CLI raw payload normalization (hex→base64 / passthrough)
// ─────────────────────────────────────────────────────────────────────────────

describe("[IOT-0054] sesame iot raw payload 正規化 (hex→base64 / 透過)", () => {
  it("[IOT-0054] 偶数長 hex は base64 化して sendIotCmd へ渡す", async () => {
    const hub = makeHub();
    const ctx = makeCtx({ hub });
    await buildProgram(ctx).parseAsync(
      ["iot", "raw", "--topic", "wm2ABC123cmd", "--payload", "deadbeef"],
      { from: "user" },
    );
    const expectedBase64 = Buffer.from("deadbeef", "hex").toString("base64");
    expect(hub.iot.sendIotCmd).toHaveBeenCalledWith({
      topic: "wm2ABC123cmd",
      payload: expectedBase64,
    });
  });

  it("[IOT-0054] 奇数長 hex (3文字) は hex パターン不一致で透過 (そのまま渡す)", async () => {
    const hub = makeHub();
    const ctx = makeCtx({ hub });
    await buildProgram(ctx).parseAsync(
      ["iot", "raw", "--topic", "t", "--payload", "abc"],
      { from: "user" },
    );
    expect(hub.iot.sendIotCmd).toHaveBeenCalledWith({ topic: "t", payload: "abc" });
  });

  it("[IOT-0054] base64 文字列 ('3q2+7w==') はそのまま透過", async () => {
    const hub = makeHub();
    const ctx = makeCtx({ hub });
    await buildProgram(ctx).parseAsync(
      ["iot", "raw", "--topic", "t", "--payload", "3q2+7w=="],
      { from: "user" },
    );
    expect(hub.iot.sendIotCmd).toHaveBeenCalledWith({ topic: "t", payload: "3q2+7w==" });
  });

  it("[IOT-0054] --wait --cmd 92 は sendIotCmdAwait へ委譲 (hex payload base64 化)", async () => {
    const hub = makeHub();
    const ctx = makeCtx({ hub });
    await buildProgram(ctx).parseAsync(
      ["iot", "raw", "--topic", "t", "--payload", "00ff", "--wait", "--cmd", "92", "--device", DEVICE_ID],
      { from: "user" },
    );
    expect(hub.iot.sendIotCmdAwait).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "t",
        payload: Buffer.from("00ff", "hex").toString("base64"),
        cmd: 92,
      }),
    );
    expect(ctx.outputs[0]).toMatchObject({ ok: true, awaited: true, cmd: 92 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// IOT-0055  CLI raw required / --wait dependency validation (exit 2)
// ─────────────────────────────────────────────────────────────────────────────

describe("[IOT-0055] sesame iot raw 必須/--wait 依存検証 (exit 2)", () => {
  it("[IOT-0055] --topic 欠落は die(2) し sendIotCmd は呼ばれない", async () => {
    const hub = makeHub();
    const ctx = makeCtx({ hub });
    await expect(
      buildProgram(ctx).parseAsync(
        ["iot", "raw", "--payload", "deadbeef"],
        { from: "user" },
      ),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.iot.sendIotCmd).not.toHaveBeenCalled();
    expect(hub.iot.sendIotCmdAwait).not.toHaveBeenCalled();
  });

  it("[IOT-0055] --payload 欠落は die(2) し sendIotCmd は呼ばれない", async () => {
    const hub = makeHub();
    const ctx = makeCtx({ hub });
    await expect(
      buildProgram(ctx).parseAsync(
        ["iot", "raw", "--topic", "t"],
        { from: "user" },
      ),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.iot.sendIotCmd).not.toHaveBeenCalled();
  });

  it("[IOT-0055] --wait 指定で --cmd なしは die(2) し sendIotCmdAwait は呼ばれない", async () => {
    const hub = makeHub();
    const ctx = makeCtx({ hub });
    await expect(
      buildProgram(ctx).parseAsync(
        ["iot", "raw", "--topic", "t", "--payload", "00", "--wait"],
        { from: "user" },
      ),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.iot.sendIotCmdAwait).not.toHaveBeenCalled();
  });

  it("[IOT-0055] --wait 指定で --cmd が非整数 (e.g. '1.5') は die(2)", async () => {
    const hub = makeHub();
    const ctx = makeCtx({ hub });
    await expect(
      buildProgram(ctx).parseAsync(
        ["iot", "raw", "--topic", "t", "--payload", "00", "--wait", "--cmd", "1.5"],
        { from: "user" },
      ),
    ).rejects.toMatchObject({ code: 2 });
    expect(hub.iot.sendIotCmdAwait).not.toHaveBeenCalled();
  });

  it("[IOT-0055] --wait + 整数 --cmd: die せず sendIotCmdAwait を呼ぶ (正常経路の確認)", async () => {
    const hub = makeHub();
    const ctx = makeCtx({ hub });
    await buildProgram(ctx).parseAsync(
      ["iot", "raw", "--topic", "t", "--payload", "00ff", "--wait", "--cmd", "92"],
      { from: "user" },
    );
    expect(hub.iot.sendIotCmdAwait).toHaveBeenCalledWith(
      expect.objectContaining({ cmd: 92, topic: "t" }),
    );
  });

  it("[IOT-0055] 検証はすべて withHub(=接続) の前に行われる (hub.iot は一切呼ばれない)", async () => {
    // topic / payload 欠落 → die(2) が withHub より先に発火する
    const hub = makeHub();
    let withHubCalled = false;
    const ctx = makeCtx({ hub });
    const origWithHub = ctx.withHub;
    ctx.withHub = (...args) => {
      withHubCalled = true;
      return origWithHub(...args);
    };
    await expect(
      buildProgram(ctx).parseAsync(
        ["iot", "raw", "--payload", "ff"],
        { from: "user" },
      ),
    ).rejects.toMatchObject({ code: 2 });
    expect(withHubCalled).toBe(false);
  });
});
