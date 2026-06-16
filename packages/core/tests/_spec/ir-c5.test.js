// Tests for IR-0091 through IR-0108: HXDCommandProcessor, HXDParametersSwapper,
// builders (buildAirCommandHex / buildNonAirCommandHex / restoreAirState),
// sendIR / emitAir / emitButton / saveRemoteStateAfterEmit (via emitAir/emitButton),
// IR_TYPE constants, NAMESPACE_OPS, updateRemoteState wire frame, and CLI layer.
//
// Ref: packages/core/src/presetir.js
//      packages/core/src/ir.js
//      packages/kit/src/cli/presetir.js

import { describe, it, expect, vi } from "vitest";
import {
  HXDCommandProcessor,
  HXDParametersSwapper,
  buildAirCommandHex,
  buildNonAirCommandHex,
  restoreAirState,
  sendIR,
  emitAir,
  emitButton,
  IR_TYPE,
  NAMESPACE_OPS,
} from "../../src/presetir.js";
import { updateRemoteState } from "../../src/ir.js";
import { registerPresetIrCommands } from "../../../kit/src/cli/presetir.js";
import { Command } from "commander";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Minimal mock client. Records all request/send calls and returns a fixed reply.
 * reply can be a value or a function (frame) => reply for per-frame dispatch.
 */
function makeClient(reply = { success: true }) {
  const frames = [];
  return {
    frames,
    async request(frame, _timeoutMs) {
      frames.push({ kind: "request", frame });
      return typeof reply === "function" ? reply(frame) : reply;
    },
    send(frame) {
      frames.push({ kind: "send", frame });
    },
    subscribe() {
      return () => {};
    },
  };
}

const SUCCESS_REPLY = { action: "biz3IRRemote", op: "sendIR", success: true };

/** CLI test context factory. */
function makeCliCtx({ hub, canPrompt = false } = {}) {
  const outputs = [];
  const ctx = {
    out: (_json, _humanFn, jsonObj) => outputs.push(jsonObj),
    die: (msg, code) => {
      const e = new Error(msg);
      e.exitCode = code;
      throw e;
    },
    canPrompt: () => canPrompt,
    withHub: (fn) => fn(hub, { opts: { json: true } }),
    prompts: {
      selectFromList: vi.fn(),
      promptText: vi.fn(),
      confirm: vi.fn(),
    },
  };
  return { ctx, outputs };
}

function buildPresetIrProgram(ctx) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerPresetIrCommands(program, ctx);
  return program;
}

// ============================================================
// [IR-0091] parseAirCommand: two-stage guard + byte extraction
// ============================================================

describe("[IR-0091] HXDCommandProcessor.parseAirCommand guard + byte extraction", () => {
  const proc = new HXDCommandProcessor();

  it("[IR-0091] length<22 で null を返す", () => {
    // ref: packages/core/src/presetir.js:193
    expect(proc.parseAirCommand(null)).toBeNull();
    expect(proc.parseAirCommand("")).toBeNull();
    expect(proc.parseAirCommand("3001")).toBeNull();
    // length exactly 21 (below threshold)
    expect(proc.parseAirCommand("A".repeat(21))).toBeNull();
  });

  it("[IR-0091] 空文字 / null / undefined は null を返す", () => {
    expect(proc.parseAirCommand("")).toBeNull();
    expect(proc.parseAirCommand(null)).toBeNull();
    expect(proc.parseAirCommand(undefined)).toBeNull();
  });

  it("[IR-0091] bytes.length<11 または prefix 不一致で null を返す (第二段ガード)", () => {
    // ref: packages/core/src/presetir.js:195
    // Non-air prefix (0x30,0x00) — same length but wrong prefix[1]
    const nonAirHex = "3000000000000000000100010000FF31"; // 32 chars, bytes[1]=0x00
    expect(proc.parseAirCommand(nonAirHex)).toBeNull();
    // prefix[0] が 0x30 でない
    expect(proc.parseAirCommand("FF01000019010201000102010000FF51")).toBeNull();
  });

  it("[IR-0091] 正常 air command から temperature=b[4]…mode=b[10] を正しく抽出する", () => {
    // ref: packages/core/src/presetir.js:196-204
    const hex = buildAirCommandHex({
      code: 100,
      power: true,
      temperature: 24,
      mode: 1,           // getModeValue(1) = 0x02
      fanSpeed: 2,       // getFanSpeedValue(2) = 0x03
      windDirection: 0,  // getWindDirectionValue(0) = 0x01
      autoSwing: true,   // 0x01
      keyType: "MODE",   // getAirKey("MODE") = 0x02
    });
    const result = proc.parseAirCommand(hex);
    expect(result).not.toBeNull();
    expect(result.temperature).toBe(24);         // buf[4]
    expect(result.fanSpeed).toBe(0x03);           // buf[5]
    expect(result.windDirection).toBe(0x01);      // buf[6]
    expect(result.autoWindDirection).toBe(0x01);  // buf[7]
    expect(result.power).toBe(0x01);              // buf[8]
    expect(result.key).toBe(0x02);                // buf[9] — keyType MODE
    expect(result.mode).toBe(0x02);               // buf[10]
  });

  it("[IR-0091] 正常時: power=false は 0x00 で返る", () => {
    const hex = buildAirCommandHex({ code: 0, power: false, temperature: 25 });
    const result = proc.parseAirCommand(hex);
    expect(result).not.toBeNull();
    expect(result.power).toBe(0x00);
  });
});

// ============================================================
// [IR-0092] constructor defaults match biz3
// ============================================================

describe("[IR-0092] HXDCommandProcessor constructor defaults が biz3 と一致", () => {
  it("[IR-0092] 全 default フィールドが仕様値と一致する", () => {
    // ref: packages/core/src/presetir.js:62-75; vendor HXDCommandProcessor.js:3-15
    const p = new HXDCommandProcessor();
    expect(p.power).toBe(0x00);
    expect(p.temperature).toBe(25);
    expect(p.fanSpeed).toBe(0x01);
    expect(p.windDirection).toBe(0x02);
    expect(p.autoWindDirection).toBe(0x01);
    expect(p.mode).toBe(0x02);
    expect(p.key).toBe(0x01);
    expect(p.code).toBe(0x00);
    expect(p.AirPrefixCode).toEqual([0x30, 0x01]);
    expect(p.commonPrefixCode).toEqual([0x30, 0x00]);
  });
});

// ============================================================
// [IR-0093] getAirKey keyMap + default fallback (UI type trap)
// ============================================================

describe("[IR-0093] HXDParametersSwapper.getAirKey keyMap と default フォールバック", () => {
  const sw = new HXDParametersSwapper();

  it("[IR-0093] keyMap 定義キーが正しい値を返す", () => {
    // ref: packages/core/src/presetir.js:244-252; vendor HXDParametersSwapper.js:6-13
    expect(sw.getAirKey("POWER_STATUS_ON")).toBe(0x01);
    expect(sw.getAirKey("POWER_STATUS_OFF")).toBe(0x01);
    expect(sw.getAirKey("MODE")).toBe(0x02);
    expect(sw.getAirKey("FAN_SPEED")).toBe(0x03);
    expect(sw.getAirKey("WIND_DIRECTION")).toBe(0x04);
    expect(sw.getAirKey("AUTO_WIND_DIRECTION")).toBe(0x05);
    expect(sw.getAirKey("TEMP_CONTROL_ADD")).toBe(0x06);
    expect(sw.getAirKey("TEMP_CONTROL_REDUCE")).toBe(0x07);
  });

  it("[IR-0093] UI type 名 (keyMap 未定義) および undefined は default 0x01 にフォールバックする", () => {
    // biz3 既知トラップ: airControlItems の type 名は keyMap に無く 0x01 に落ちる
    expect(sw.getAirKey("POWER_ON")).toBe(0x01);
    expect(sw.getAirKey("POWER_OFF")).toBe(0x01);
    expect(sw.getAirKey("TEMP_ADD")).toBe(0x01);
    expect(sw.getAirKey("TEMP_REDUCE")).toBe(0x01);
    expect(sw.getAirKey("AUTO_SWING")).toBe(0x01);
    expect(sw.getAirKey(undefined)).toBe(0x01);
    expect(sw.getAirKey("UNKNOWN_KEY")).toBe(0x01);
  });
});

// ============================================================
// [IR-0094] mode/fanSpeed/windDirection index↔value + defaults
// ============================================================

describe("[IR-0094] HXDParametersSwapper mode/fanSpeed/windDirection 変換と default", () => {
  const sw = new HXDParametersSwapper();

  it("[IR-0094] getModeValue: index→HXD 値 (default 0x01 for unknown)", () => {
    // ref: packages/core/src/presetir.js:269-272; vendor HXDParametersSwapper.js:45-54
    expect(sw.getModeValue(0)).toBe(0x01);
    expect(sw.getModeValue(1)).toBe(0x02);
    expect(sw.getModeValue(2)).toBe(0x03);
    expect(sw.getModeValue(3)).toBe(0x04);
    expect(sw.getModeValue(4)).toBe(0x05);
    expect(sw.getModeValue(99)).toBe(0x01); // default
  });

  it("[IR-0094] getModeIndex: HXD 値→index (default 0 for unknown)", () => {
    // ref: packages/core/src/presetir.js:260-262; vendor HXDParametersSwapper.js:34-43
    expect(sw.getModeIndex(0x01)).toBe(0);
    expect(sw.getModeIndex(0x02)).toBe(1);
    expect(sw.getModeIndex(0x03)).toBe(2);
    expect(sw.getModeIndex(0x04)).toBe(3);
    expect(sw.getModeIndex(0x05)).toBe(4);
    expect(sw.getModeIndex(0xff)).toBe(0); // default
  });

  it("[IR-0094] getFanSpeedValue: index→HXD 値 (default 0x01)", () => {
    // ref: packages/core/src/presetir.js:287-290; vendor HXDParametersSwapper.js:67-75
    expect(sw.getFanSpeedValue(0)).toBe(0x01);
    expect(sw.getFanSpeedValue(1)).toBe(0x02);
    expect(sw.getFanSpeedValue(2)).toBe(0x03);
    expect(sw.getFanSpeedValue(3)).toBe(0x04);
    expect(sw.getFanSpeedValue(99)).toBe(0x01); // default
  });

  it("[IR-0094] getFanSpeedIndex: HXD 値→index (default 0)", () => {
    // ref: packages/core/src/presetir.js:278-281; vendor HXDParametersSwapper.js:57-65
    expect(sw.getFanSpeedIndex(0x01)).toBe(0);
    expect(sw.getFanSpeedIndex(0x02)).toBe(1);
    expect(sw.getFanSpeedIndex(0x03)).toBe(2);
    expect(sw.getFanSpeedIndex(0x04)).toBe(3);
    expect(sw.getFanSpeedIndex(0xff)).toBe(0); // default
  });

  it("[IR-0094] getWindDirectionValue: default は 0x02 (他 default 0x01 と非対称)", () => {
    // ref: packages/core/src/presetir.js:305-308; vendor HXDParametersSwapper.js:87-94
    expect(sw.getWindDirectionValue(0)).toBe(0x01);
    expect(sw.getWindDirectionValue(1)).toBe(0x02);
    expect(sw.getWindDirectionValue(2)).toBe(0x03);
    expect(sw.getWindDirectionValue(99)).toBe(0x02); // default — asymmetric!
  });

  it("[IR-0094] getWindDirectionIndex: HXD 値→index (default 0)", () => {
    // ref: packages/core/src/presetir.js:296-299; vendor HXDParametersSwapper.js:78-85
    expect(sw.getWindDirectionIndex(0x01)).toBe(0);
    expect(sw.getWindDirectionIndex(0x02)).toBe(1);
    expect(sw.getWindDirectionIndex(0x03)).toBe(2);
    expect(sw.getWindDirectionIndex(0xff)).toBe(0); // default
  });
});

// ============================================================
// [IR-0095] getLightKey / getTVKey / getFanKey — all items
// ============================================================

describe("[IR-0095] HXDParametersSwapper getLightKey/getTVKey/getFanKey keyMap 全項目", () => {
  const sw = new HXDParametersSwapper();

  it("[IR-0095] getLightKey: 全 7 項目と default 0x01 が vendor と一致", () => {
    // ref: packages/core/src/presetir.js:335-343; vendor HXDParametersSwapper.js:116-122
    expect(sw.getLightKey("POWER_STATUS_ON")).toBe(0x01);
    expect(sw.getLightKey("POWER_STATUS_OFF")).toBe(0x02);
    expect(sw.getLightKey("MODE")).toBe(0x05);
    expect(sw.getLightKey("BRIGHTNESS_UP")).toBe(0x03);
    expect(sw.getLightKey("BRIGHTNESS_DOWN")).toBe(0x04);
    expect(sw.getLightKey("COLOR_TEMP_UP")).toBe(0x09);
    expect(sw.getLightKey("COLOR_TEMP_DOWN")).toBe(0x0a);
    expect(sw.getLightKey("UNKNOWN")).toBe(0x01); // default
  });

  it("[IR-0095] getTVKey: 15 項目と default 0x01 が vendor と一致", () => {
    // ref: packages/core/src/presetir.js:352-368; vendor HXDParametersSwapper.js:130-144
    expect(sw.getTVKey("POWER_STATUS_ON")).toBe(0x06);
    expect(sw.getTVKey("POWER_STATUS_OFF")).toBe(0x06);
    expect(sw.getTVKey("MUTE")).toBe(0x07);
    expect(sw.getTVKey("BACK")).toBe(0x14);
    expect(sw.getTVKey("UP")).toBe(0x16);
    expect(sw.getTVKey("MENU")).toBe(0x03);
    expect(sw.getTVKey("LEFT")).toBe(0x17);
    expect(sw.getTVKey("OK")).toBe(0x15);
    expect(sw.getTVKey("RIGHT")).toBe(0x18);
    expect(sw.getTVKey("VOLUME_UP")).toBe(0x05);
    expect(sw.getTVKey("DOWN")).toBe(0x19);
    expect(sw.getTVKey("CHANNEL_UP")).toBe(0x02);
    expect(sw.getTVKey("VOLUME_DOWN")).toBe(0x01);
    expect(sw.getTVKey("HOME")).toBe(0x1a);
    expect(sw.getTVKey("CHANNEL_DOWN")).toBe(0x04);
    expect(sw.getTVKey("UNKNOWN")).toBe(0x01); // default
  });

  it("[IR-0095] getFanKey: 8 項目と default 0x01 が vendor と一致", () => {
    // ref: packages/core/src/presetir.js:377-387; vendor HXDParametersSwapper.js:152-159
    expect(sw.getFanKey("POWER_STATUS_ON")).toBe(0x01);
    expect(sw.getFanKey("POWER_STATUS_OFF")).toBe(0x01);
    expect(sw.getFanKey("FAN_SPEED")).toBe(0x02);
    expect(sw.getFanKey("SHAKE_HEAD")).toBe(0x03);
    expect(sw.getFanKey("MODE")).toBe(0x04);
    expect(sw.getFanKey("LOW")).toBe(0x14);
    expect(sw.getFanKey("MIDDLE")).toBe(0x15);
    expect(sw.getFanKey("HIGH")).toBe(0x16);
    expect(sw.getFanKey("UNKNOWN")).toBe(0x01); // default
  });
});

// ============================================================
// [IR-0096] getKeyByDeviceType dispatch + unknown default
// ============================================================

describe("[IR-0096] HXDParametersSwapper.getKeyByDeviceType irType 分岐 + 未知 default", () => {
  const sw = new HXDParametersSwapper();

  it("[IR-0096] 0xc000→getAirKey, 0xe000→getLightKey, 0x2000→getTVKey, 0x8000→getFanKey", () => {
    // ref: packages/core/src/presetir.js:399-410; vendor HXDParametersSwapper.js:167-179
    expect(sw.getKeyByDeviceType(0xc000, "MODE")).toBe(sw.getAirKey("MODE"));       // 0x02
    expect(sw.getKeyByDeviceType(0xe000, "MODE")).toBe(sw.getLightKey("MODE"));     // 0x05
    expect(sw.getKeyByDeviceType(0x2000, "MUTE")).toBe(sw.getTVKey("MUTE"));        // 0x07
    expect(sw.getKeyByDeviceType(0x8000, "HIGH")).toBe(sw.getFanKey("HIGH"));       // 0x16
    expect(sw.getKeyByDeviceType(0x8000, "SHAKE_HEAD")).toBe(0x03);                 // getFanKey("SHAKE_HEAD")
  });

  it("[IR-0096] 未知 irType は 0x01 (vendor console.warn 相当だが warn 省略・値同一)", () => {
    // ref: packages/core/src/presetir.js:408-409; vendor HXDParametersSwapper.js:177
    expect(sw.getKeyByDeviceType(0xffff, "MODE")).toBe(0x01);
    expect(sw.getKeyByDeviceType(0xfe00, "POWER_STATUS_ON")).toBe(0x01);
    expect(sw.getKeyByDeviceType(0x0000, "X")).toBe(0x01);
  });
});

// ============================================================
// [IR-0097] convertToUIState HXD→UI mapping + null guard
// ============================================================

describe("[IR-0097] HXDParametersSwapper.convertToUIState HXD→UI 写像", () => {
  const sw = new HXDParametersSwapper();

  it("[IR-0097] null 入力は null を返す", () => {
    // ref: packages/core/src/presetir.js:319; vendor HXDParametersSwapper.js:222-224
    expect(sw.convertToUIState(null)).toBeNull();
    expect(sw.convertToUIState(undefined)).toBeNull();
  });

  it("[IR-0097] power=(b===0x01), autoSwing=(autoWindDirection===0x01)", () => {
    // ref: packages/core/src/presetir.js:321,326; vendor HXDParametersSwapper.js:225,232
    const onState = sw.convertToUIState({
      power: 0x01, temperature: 24, mode: 0x02, fanSpeed: 0x03,
      windDirection: 0x01, autoWindDirection: 0x01,
    });
    expect(onState.power).toBe(true);
    expect(onState.autoSwing).toBe(true);
    expect(onState.temperature).toBe(24);

    const offState = sw.convertToUIState({
      power: 0x00, temperature: 25, mode: 0x01, fanSpeed: 0x01,
      windDirection: 0x02, autoWindDirection: 0x00,
    });
    expect(offState.power).toBe(false);
    expect(offState.autoSwing).toBe(false);
  });

  it("[IR-0097] mode/fanSpeed/windDirection は *Index 変換で UI 値に写像される", () => {
    // ref: packages/core/src/presetir.js:323-325; vendor HXDParametersSwapper.js:228-231
    const state = sw.convertToUIState({
      power: 0x01, temperature: 22, mode: 0x03, fanSpeed: 0x04,
      windDirection: 0x02, autoWindDirection: 0x00,
    });
    expect(state.temperature).toBe(22);
    expect(state.mode).toBe(sw.getModeIndex(0x03));            // 2
    expect(state.fanSpeed).toBe(sw.getFanSpeedIndex(0x04));    // 3
    expect(state.windDirection).toBe(sw.getWindDirectionIndex(0x02)); // 1
  });
});

// ============================================================
// [IR-0098] buildAirCommandHex: setter chain order + defaults
// ============================================================

describe("[IR-0098] buildAirCommandHex setter チェーン順序・既定値が biz3 と一致", () => {
  it("[IR-0098] code のみ指定: 全 default (windDirection index 1=0x02 が HXDCommandProcessor default と整合)", () => {
    // ref: packages/core/src/presetir.js:437-452; vendor remote-air/index.js:117-138
    expect(buildAirCommandHex({ code: 0 })).toBe("3001000019010200000101010000FF4F");
  });

  it("[IR-0098] フル指定: setter 順序が vendor と一致した HEX", () => {
    // ref: packages/core/src/presetir.js:440-450; vendor remote-air/index.js:123-132
    expect(buildAirCommandHex({
      code: 100,
      power: true,
      temperature: 24,
      mode: 1,
      fanSpeed: 2,
      windDirection: 0,
      autoSwing: true,
      keyType: "MODE",
    })).toBe("3001006418030101010202010000FFB7");
  });

  it("[IR-0098] windDirection 既定 index=1 は getWindDirectionValue(1)=0x02 (HXDCommandProcessor 既定と整合)", () => {
    // ref: packages/core/src/presetir.js:448 (??1); presetir.js:306 getWindDirectionValue(1)=0x02
    const hex = buildAirCommandHex({ code: 0 });
    const proc = new HXDCommandProcessor();
    const bytes = proc.hexStringToByteArray(hex);
    expect(bytes[6]).toBe(0x02); // windDirection=0x02 (default)
  });
});

// ============================================================
// [IR-0099] buildNonAirCommandHex: getKeyByDeviceType→setKey→setCode flow
// ============================================================

describe("[IR-0099] buildNonAirCommandHex フロー: getKeyByDeviceType→setKey→setCode→buildNonAirCommand→toHexString", () => {
  it("[IR-0099] TV POWER_STATUS_ON (key=0x06, code=1234) の固定 HEX が vendor と一致", () => {
    // ref: packages/core/src/presetir.js:484-490; vendor remote-non-air/index.js:117-118
    expect(buildNonAirCommandHex({ irType: IR_TYPE.TV, code: 1234, buttonType: "POWER_STATUS_ON" }))
      .toBe("300004D200000000000600010000FF0C");
  });

  it("[IR-0099] LIGHT BRIGHTNESS_UP (key=0x03): buf[9]=0x03", () => {
    // ref: packages/core/src/presetir.js:487-489
    const proc = new HXDCommandProcessor();
    const hex = buildNonAirCommandHex({ irType: IR_TYPE.LIGHT, code: 0, buttonType: "BRIGHTNESS_UP" });
    const bytes = proc.hexStringToByteArray(hex);
    expect(bytes[0]).toBe(0x30);
    expect(bytes[1]).toBe(0x00); // commonPrefixCode
    expect(bytes[9]).toBe(0x03); // getLightKey("BRIGHTNESS_UP")
  });

  it("[IR-0099] FAN HIGH (key=0x16): buf[9]=0x16 + checksum 正確", () => {
    const proc = new HXDCommandProcessor();
    const hex = buildNonAirCommandHex({ irType: IR_TYPE.FAN, code: 0, buttonType: "HIGH" });
    const bytes = proc.hexStringToByteArray(hex);
    expect(bytes[9]).toBe(0x16); // getFanKey("HIGH")=0x16
    expect(bytes[14]).toBe(0xff);
    const sum = bytes.slice(0, -1).reduce((s, b) => s + b, 0) & 0xff;
    expect(bytes[15]).toBe(sum);
  });

  it("[IR-0099] FAN SHAKE_HEAD (key=0x03): buf[9]=0x03", () => {
    const proc = new HXDCommandProcessor();
    const hex = buildNonAirCommandHex({ irType: IR_TYPE.FAN, code: 0, buttonType: "SHAKE_HEAD" });
    const bytes = proc.hexStringToByteArray(hex);
    expect(bytes[0]).toBe(0x30);
    expect(bytes[1]).toBe(0x00); // commonPrefixCode
    expect(bytes[9]).toBe(0x03); // getFanKey("SHAKE_HEAD")=0x03
  });
});

// ============================================================
// [IR-0100] restoreAirState: parseAirCommand→convertToUIState, null on invalid
// ============================================================

describe("[IR-0100] restoreAirState は parseAirCommand→convertToUIState、空/不正は null", () => {
  it("[IR-0100] 有効な air HEX から UI state を正しく復元する", () => {
    // ref: packages/core/src/presetir.js:466-471; vendor remote-air/index.js:108-113
    const hex = buildAirCommandHex({
      code: 100,
      power: true,
      temperature: 24,
      mode: 1,
      fanSpeed: 2,
      windDirection: 0,
      autoSwing: true,
    });
    const state = restoreAirState(hex);
    expect(state).not.toBeNull();
    expect(state.power).toBe(true);
    expect(state.temperature).toBe(24);
    expect(state.mode).toBe(1);    // getModeIndex(getModeValue(1))=1
    expect(state.fanSpeed).toBe(2);
    expect(state.windDirection).toBe(0);
    expect(state.autoSwing).toBe(true);
  });

  it("[IR-0100] 空/null/undefined は null を返す", () => {
    // ref: packages/core/src/presetir.js:467
    expect(restoreAirState(null)).toBeNull();
    expect(restoreAirState(undefined)).toBeNull();
    expect(restoreAirState("")).toBeNull();
  });

  it("[IR-0100] 不正 HEX (length < 22) は null を返す (parseAirCommand ガード)", () => {
    expect(restoreAirState("3001")).toBeNull();
  });

  it("[IR-0100] non-air prefix (0x30,0x00) は null を返す (prefix ガード)", () => {
    // non-air prefix 0x30,0x00 — parseAirCommand returns null → convertToUIState(null) = null
    expect(restoreAirState("3000000000000000000100010000FF31")).toBeNull();
  });
});

// ============================================================
// [IR-0101] emitAir: state→sendIR(irType=AIR)→stateSaved, return {command,response,stateSaved}
// ============================================================

describe("[IR-0101] emitAir: state生成→sendIR(irType=AIR)→保存 の複合フロー", () => {
  it("[IR-0101] irType=IR_TYPE.AIR(0xc000) で sendIR を発射し {command,response,stateSaved} を返す", async () => {
    // ref: packages/core/src/presetir.js:592-618; vendor remote-air/index.js:356-385
    const client = makeClient(SUCCESS_REPLY);
    const result = await emitAir(client, {
      deviceId: "hub3",
      companyID: "ch",
      code: 100,
      power: true,
      temperature: 24,
      mode: 1,
      fanSpeed: 2,
      windDirection: 0,
      autoSwing: true,
      keyType: "MODE",
    });
    expect(result).toHaveProperty("command");
    expect(result).toHaveProperty("response");
    expect(result).toHaveProperty("stateSaved");
    expect(result.command).toBe("3001006418030101010202010000FFB7");
    const frame = client.frames[0].frame;
    expect(frame.irType).toBe(IR_TYPE.AIR);
    expect(frame.irType).toBe(0xc000);
    expect(frame.command).toBe(result.command);
    expect(frame.deviceId).toBe("hub3");
    expect(frame.companyID).toBe("ch");
  });

  it("[IR-0101] 戻り値は {command, response, stateSaved} の 3 キー構成", async () => {
    const client = makeClient(SUCCESS_REPLY);
    const result = await emitAir(client, {
      deviceId: "hub3",
      companyID: "ch",
      code: 0,
    });
    expect(result).toHaveProperty("command");
    expect(result).toHaveProperty("response");
    expect(result).toHaveProperty("stateSaved");
  });

  it("[IR-0101] irDeviceUUID なし → stateSaved=false (updateRemoteState を呼ばない)", async () => {
    // ref: packages/core/src/presetir.js:563-564 (saveRemoteStateAfterEmit)
    const client = makeClient(SUCCESS_REPLY);
    const result = await emitAir(client, {
      deviceId: "hub3",
      companyID: "ch",
      code: 0,
    });
    expect(result.stateSaved).toBe(false);
    expect(client.frames.every((f) => f.frame.op !== "updateRemoteState")).toBe(true);
  });

  it("[IR-0101] irDeviceUUID 指定時は sendIR 後に updateRemoteState を呼ぶ", async () => {
    // ref: packages/core/src/presetir.js:614-616 (saveRemoteStateAfterEmit 呼出)
    const client = makeClient((f) => ({ success: true, op: f.op }));
    const result = await emitAir(client, {
      deviceId: "hub3",
      companyID: "ch",
      code: 100,
      irDeviceUUID: "remote-r1",
    });
    expect(result.stateSaved).toBe(true);
    const saveFrame = client.frames.find((f) => f.frame.op === "updateRemoteState")?.frame;
    expect(saveFrame).toBeDefined();
    expect(saveFrame.uuid).toBe("remote-r1");
  });

  it("[IR-0101] savedState 復元: 明示指定が ?? で復元値より優先される", async () => {
    // ref: packages/core/src/presetir.js:594-603
    const savedHex = buildAirCommandHex({ code: 100, power: true, temperature: 24, mode: 0, fanSpeed: 0, windDirection: 0, autoSwing: false });
    const client = makeClient(SUCCESS_REPLY);
    const result = await emitAir(client, {
      deviceId: "hub3",
      companyID: "ch",
      code: 100,
      savedState: savedHex,
      // power/temperature を明示しないため savedState から復元
    });
    const proc = new HXDCommandProcessor();
    const bytes = proc.hexStringToByteArray(result.command);
    expect(bytes[4]).toBe(24); // temperature buf[4] — restored from savedState
  });

  it("[IR-0101] savedState あり: 明示指定 temperature が復元値を上書き (?? 演算子)", async () => {
    // ref: packages/core/src/presetir.js:594-603
    const savedHex = buildAirCommandHex({ code: 100, power: false, temperature: 20, mode: 0, fanSpeed: 0, windDirection: 0, autoSwing: false });
    const client = makeClient(SUCCESS_REPLY);
    const result = await emitAir(client, {
      deviceId: "hub3",
      companyID: "ch",
      code: 100,
      temperature: 26, // explicit override
      savedState: savedHex,
    });
    const proc = new HXDCommandProcessor();
    const bytes = proc.hexStringToByteArray(result.command);
    expect(bytes[4]).toBe(26); // temperature explicitly set
  });
});

// ============================================================
// [IR-0102] emitButton: command→sendIR(same irType)→stateSaved, return shape
// ============================================================

describe("[IR-0102] emitButton: command生成→sendIR(渡された irType)→保存の複合フロー", () => {
  it("[IR-0102] 渡された irType を sendIR にそのまま渡す (AIR に固定しない)", async () => {
    // ref: packages/core/src/presetir.js:632-650; vendor remote-non-air/index.js:140-166
    const client = makeClient(SUCCESS_REPLY);
    const result = await emitButton(client, {
      deviceId: "hub3",
      companyID: "ch",
      code: 1234,
      irType: IR_TYPE.TV,
      buttonType: "POWER_STATUS_ON",
    });
    expect(result.command).toBe("300004D200000000000600010000FF0C");
    expect(result).toHaveProperty("response");
    expect(result).toHaveProperty("stateSaved");
    const frame = client.frames[0].frame;
    expect(frame.irType).toBe(IR_TYPE.TV);
    expect(frame.irType).toBe(0x2000);
    expect(frame.command).toBe(result.command);
    expect(frame.operation).toBe("remoteEmit");
  });

  it("[IR-0102] 戻り値は {command, response, stateSaved} の 3 キー構成", async () => {
    const client = makeClient(SUCCESS_REPLY);
    const result = await emitButton(client, {
      deviceId: "hub3",
      companyID: "ch",
      code: 1234,
      irType: IR_TYPE.TV,
      buttonType: "POWER_STATUS_ON",
    });
    expect(result).toHaveProperty("command");
    expect(result).toHaveProperty("response");
    expect(result).toHaveProperty("stateSaved");
  });

  it("[IR-0102] irDeviceUUID 指定時は sendIR 後に updateRemoteState を呼ぶ (state 保存)", async () => {
    // ref: packages/core/src/presetir.js:643,646-648
    const client = makeClient((f) => ({ success: true, op: f.op }));
    const result = await emitButton(client, {
      deviceId: "hub3",
      companyID: "ch",
      code: 1234,
      irType: IR_TYPE.TV,
      buttonType: "POWER_STATUS_ON",
      irDeviceUUID: "r-uuid",
    });
    expect(result.stateSaved).toBe(true);
    const saveFrame = client.frames.find((f) => f.frame.op === "updateRemoteState")?.frame;
    expect(saveFrame).toBeDefined();
    expect(saveFrame.state).toBe("300004D200000000000600010000FF0C");
  });

  it("[IR-0102] irDeviceUUID なし → stateSaved=false", async () => {
    const client = makeClient(SUCCESS_REPLY);
    const result = await emitButton(client, {
      deviceId: "hub3",
      companyID: "ch",
      code: 1234,
      irType: IR_TYPE.TV,
      buttonType: "POWER_STATUS_ON",
    });
    expect(result.stateSaved).toBe(false);
  });
});

// ============================================================
// [IR-0103] saveRemoteStateAfterEmit: no uuid → no save, failure → swallowed
// ============================================================

describe("[IR-0103] saveRemoteStateAfterEmit: uuid無しは保存しない、失敗は throw せず stateSaved:false", () => {
  it("[IR-0103] irDeviceUUID 空文字 → updateRemoteState を呼ばず stateSaved=false", async () => {
    // ref: packages/core/src/presetir.js:563-564
    const client = makeClient(SUCCESS_REPLY);
    const result = await emitButton(client, {
      deviceId: "hub3",
      companyID: "ch",
      code: 0,
      irType: IR_TYPE.LIGHT,
      buttonType: "POWER_STATUS_ON",
      irDeviceUUID: "", // 空文字 = 未保存
    });
    expect(result.stateSaved).toBe(false);
    expect(client.frames.every((f) => f.frame.op !== "updateRemoteState")).toBe(true);
  });

  it("[IR-0103] updateRemoteState 失敗は throw せず stateSaved=false で発射成功扱い", async () => {
    // ref: packages/core/src/presetir.js:568-570; vendor remote-air/index.js:380-382
    // updateRemoteState で success:false → assertSuccess(strict) が throw するが emitButton は握りつぶす
    const client = {
      frames: [],
      async request(frame) {
        client.frames.push(frame);
        if (frame.op === "updateRemoteState") {
          return { success: false, message: "update failed" };
        }
        return { success: true };
      },
      subscribe() { return () => {}; },
    };
    // Must not throw — call directly (vitest expect(async fn).not.toThrow() is unreliable for async)
    const result = await emitButton(client, {
      deviceId: "hub3",
      companyID: "ch",
      code: 0,
      irType: IR_TYPE.TV,
      buttonType: "MUTE",
      irDeviceUUID: "r-uuid",
    });
    expect(result.stateSaved).toBe(false);
  });

  it("[IR-0103] emitAir での updateRemoteState 失敗も throw せず stateSaved:false で返す", async () => {
    // ref: packages/core/src/presetir.js:568-570; vendor remote-air/index.js:380-382
    const client = {
      frames: [],
      async request(frame) {
        client.frames.push(frame);
        if (frame.op === "updateRemoteState") {
          throw new Error("update failed");
        }
        return SUCCESS_REPLY;
      },
      subscribe() { return () => {}; },
    };
    // Must not throw — call directly
    const result = await emitAir(client, {
      deviceId: "hub3",
      companyID: "ch",
      code: 0,
      irDeviceUUID: "some-uuid",
    });
    expect(result.stateSaved).toBe(false);
    expect(result.response).toBe(SUCCESS_REPLY);
  });
});

// ============================================================
// [IR-0104] updateRemoteState wire frame key names
// ============================================================

describe("[IR-0104] updateRemoteState フレーム: hub3DeviceId が deviceId キーで送られる", () => {
  it("[IR-0104] frame が {op:'updateRemoteState', deviceId:hub3DeviceId, uuid, state, companyID} で一致", async () => {
    // ref: packages/core/src/ir.js:246-258; vendor useRemoteCtrl.js:501 — deviceId:hub3DeviceId
    const client = makeClient({ success: true, op: "updateRemoteState" });
    await updateRemoteState(client, {
      hub3DeviceId: "h3-device-id",
      uuid: "remote-uuid",
      state: "AABBCC1234",
      companyID: "company-X",
    });
    const f = client.frames[0].frame;
    expect(f.action).toBe("biz3IRRemote");
    expect(f.op).toBe("updateRemoteState");
    expect(f.deviceId).toBe("h3-device-id");  // hub3DeviceId が deviceId キーで送られる (命名トラップ)
    expect(f.uuid).toBe("remote-uuid");
    expect(f.state).toBe("AABBCC1234");
    expect(f.companyID).toBe("company-X");
    // hub3DeviceId というキーは wire 上に存在しない
    expect(f).not.toHaveProperty("hub3DeviceId");
  });

  it("[IR-0104] emitAir 経由: updateRemoteState frame に hub3DeviceId が deviceId として乗る", async () => {
    // ref: packages/core/src/presetir.js:566; packages/core/src/ir.js:246-258
    const frames = [];
    const client = {
      frames,
      async request(frame) {
        frames.push({ kind: "request", frame });
        if (frame.op === "updateRemoteState") {
          return { success: true, op: "updateRemoteState" };
        }
        return SUCCESS_REPLY;
      },
      subscribe() { return () => {}; },
    };
    const expectedCommand = buildAirCommandHex({ code: 0 });
    await emitAir(client, {
      deviceId: "hub3-the-device",
      companyID: "co-X",
      code: 0,
      irDeviceUUID: "remote-uuid-for-save",
    });
    const updateFrame = frames.find((f) => f.frame.op === "updateRemoteState")?.frame;
    expect(updateFrame).toBeDefined();
    // hub3DeviceId must arrive as "deviceId" on the wire (naming trap)
    expect(updateFrame.deviceId).toBe("hub3-the-device");
    expect(updateFrame).not.toHaveProperty("hub3DeviceId");
    expect(updateFrame.uuid).toBe("remote-uuid-for-save");
    expect(updateFrame.state).toBe(expectedCommand);
    expect(updateFrame.companyID).toBe("co-X");
  });
});

// ============================================================
// [IR-0105] IR_TYPE constants: AIR/FAN/LIGHT/TV real values
// ============================================================

describe("[IR-0105] presetir IR_TYPE 実値 (AIR/FAN/LIGHT/TV) が確定値と一致", () => {
  it("[IR-0105] AIR=0xc000, FAN=0x8000, LIGHT=0xe000, TV=0x2000 — 学習用 0xFE00/UI 0xFEFF は含めない", () => {
    // ref: packages/core/src/presetir.js:45-50; vendor useRemoteCtrl.js:228
    expect(IR_TYPE.AIR).toBe(0xc000);
    expect(IR_TYPE.FAN).toBe(0x8000);
    expect(IR_TYPE.LIGHT).toBe(0xe000);
    expect(IR_TYPE.TV).toBe(0x2000);
    expect(Object.values(IR_TYPE)).not.toContain(0xfe00);
    expect(Object.values(IR_TYPE)).not.toContain(0xfeff);
    expect(IR_TYPE).not.toHaveProperty("LEARN");
  });

  it("[IR-0105] IR_TYPE は freeze されている (追加・変更不可)", () => {
    // ref: packages/core/src/presetir.js:45 Object.freeze
    expect(Object.isFrozen(IR_TYPE)).toBe(true);
    const tryMutate = () => { IR_TYPE.AIR = 0; };
    try { tryMutate(); } catch (_) { /* frozen */ }
    expect(IR_TYPE.AIR).toBe(0xc000);
  });
});

// ============================================================
// [IR-0106] NAMESPACE_OPS: only sendIR/emitAir/emitButton exposed
// ============================================================

describe("[IR-0106] presetir NAMESPACE_OPS は [sendIR,emitAir,emitButton] のみ露出", () => {
  it("[IR-0106] NAMESPACE_OPS に sendIR/emitAir/emitButton の 3 op のみが含まれる", () => {
    // ref: packages/core/src/presetir.js:659; packages/core/src/client.js:333-368
    expect(NAMESPACE_OPS).toEqual(["sendIR", "emitAir", "emitButton"]);
    expect(NAMESPACE_OPS).toContain("sendIR");
    expect(NAMESPACE_OPS).toContain("emitAir");
    expect(NAMESPACE_OPS).toContain("emitButton");
    expect(NAMESPACE_OPS).toHaveLength(3);
  });

  it("[IR-0106] 純ビルダ / クラスは NAMESPACE_OPS に含まれない", () => {
    // ref: packages/core/src/presetir.js:652-658
    const forbidden = [
      "buildAirCommandHex",
      "buildNonAirCommandHex",
      "HXDCommandProcessor",
      "HXDParametersSwapper",
      "restoreAirState",
    ];
    for (const name of forbidden) {
      expect(NAMESPACE_OPS).not.toContain(name);
    }
  });
});

// ============================================================
// [IR-0107] CLI preset-ir air — option mapping + priority resolution
// ============================================================

describe("[IR-0107] CLI preset-ir air — オプション写像と解決優先順", () => {
  it("[IR-0107] --device と --code 指定で emitAir に deviceId/code が渡る", async () => {
    // ref: packages/kit/src/cli/presetir.js:139,141,167
    const emitAirCalls = [];
    const hub = {
      presetir: {
        emitAir: async (p) => {
          emitAirCalls.push(p);
          return { command: "AA", response: {} };
        },
      },
      resolveRemote: () => { throw new Error("no remote"); },
    };
    const { ctx } = makeCliCtx({ hub });
    const program = buildPresetIrProgram(ctx);
    await program.parseAsync(
      ["preset-ir", "air", "--device", "dev-uuid", "--code", "100"],
      { from: "user" },
    );
    expect(emitAirCalls).toHaveLength(1);
    expect(emitAirCalls[0].deviceId).toBe("dev-uuid");
    expect(emitAirCalls[0].code).toBe(100);
  });

  it("[IR-0107] --power/--temp/--mode/--fan/--wind/--swing は指定時のみ params に載る", async () => {
    // ref: packages/kit/src/cli/presetir.js:157-162
    const emitAirCalls = [];
    const hub = {
      presetir: {
        emitAir: async (p) => {
          emitAirCalls.push(p);
          return { command: "AA", response: {} };
        },
      },
      resolveRemote: () => { throw new Error("no remote"); },
    };
    const { ctx } = makeCliCtx({ hub });
    const program = buildPresetIrProgram(ctx);
    await program.parseAsync(
      ["preset-ir", "air", "--device", "d", "--code", "0", "--power", "--temp", "24", "--mode", "1"],
      { from: "user" },
    );
    const p = emitAirCalls[0];
    expect(p.power).toBe(true);
    expect(p.temperature).toBe(24);
    expect(p.mode).toBe(1);
    // 未指定の fanSpeed/windDirection/autoSwing は含まれない
    expect(p.fanSpeed).toBeUndefined();
    expect(p.windDirection).toBeUndefined();
    expect(p.autoSwing).toBeUndefined();
  });

  it("[IR-0107] --remote 指定時は config から deviceId/code が解決され明示 --device が優先", async () => {
    // ref: packages/kit/src/cli/presetir.js:137-141
    const emitAirCalls = [];
    const hub = {
      presetir: {
        emitAir: async (p) => {
          emitAirCalls.push(p);
          return { command: "AA", response: {} };
        },
      },
      resolveRemote: (_name) => ({
        remote: { code: 200, irDeviceUUID: "r-uuid", irType: 0xc000, state: null },
        hub3: { deviceId: "config-hub3" },
      }),
    };
    const { ctx } = makeCliCtx({ hub });
    const program = buildPresetIrProgram(ctx);
    await program.parseAsync(
      ["preset-ir", "air", "--remote", "my-ac", "--device", "explicit-hub3"],
      { from: "user" },
    );
    expect(emitAirCalls[0].deviceId).toBe("explicit-hub3"); // 明示優先
    expect(emitAirCalls[0].code).toBe(200);                  // config から解決
  });

  it("[IR-0107] config の state が savedState に渡る", async () => {
    // ref: packages/kit/src/cli/presetir.js:156
    const savedHex = buildAirCommandHex({ code: 100, power: true, temperature: 24 });
    const emitAirCalls = [];
    const hub = {
      presetir: {
        emitAir: async (p) => {
          emitAirCalls.push(p);
          return { command: "AA", response: {} };
        },
      },
      resolveRemote: () => ({
        remote: { code: 100, irDeviceUUID: "r-uuid", irType: 0xc000, state: savedHex },
        hub3: { deviceId: "h3" },
      }),
    };
    const { ctx } = makeCliCtx({ hub });
    const program = buildPresetIrProgram(ctx);
    await program.parseAsync(
      ["preset-ir", "air", "--remote", "my-ac"],
      { from: "user" },
    );
    expect(emitAirCalls[0].savedState).toBe(savedHex);
  });

  it("[IR-0107] savedState 復元値は明示指定で ?? 上書き、null/undefined のみ復元値を採用 (core 層検証)", async () => {
    // ref: packages/core/src/presetir.js:594-603; packages/kit/src/cli/presetir.js:156
    const savedHex = buildAirCommandHex({ code: 200, power: true, temperature: 20, mode: 0, fanSpeed: 0, windDirection: 1, autoSwing: false });
    const client = makeClient(SUCCESS_REPLY);
    // Explicit temperature=26 must override restored 20; power not specified → uses restored true
    const result = await emitAir(client, {
      deviceId: "d",
      companyID: "ch",
      code: 200,
      temperature: 26,   // explicit → must win
      savedState: savedHex,
    });
    const proc = new HXDCommandProcessor();
    const bytes = proc.hexStringToByteArray(result.command);
    expect(bytes[4]).toBe(26);   // temperature override applied
    expect(bytes[8]).toBe(0x01); // restored power=true → 0x01
  });

  it("[IR-0107] code は params から直接 buildAirCommandHex に渡される", async () => {
    // ref: packages/kit/src/cli/presetir.js:141,604
    const client = makeClient(SUCCESS_REPLY);
    await emitAir(client, { deviceId: "d", companyID: "ch", code: 1234 });
    const proc = new HXDCommandProcessor();
    const bytes = proc.hexStringToByteArray(client.frames[0].frame.command);
    // code=1234 → [4, 0xD2] in buf[2,3]
    expect(bytes[2]).toBe(4);
    expect(bytes[3]).toBe(0xd2);
  });
});

// ============================================================
// [IR-0108] preset-ir air error paths: code unresolved / non-numeric
// ============================================================

describe("[IR-0108] preset-ir air の code 未解決・非数値異常系と終了コード", () => {
  it("[IR-0108] --device のみで --code を省略 → die(codeRequired, 2)", async () => {
    // ref: packages/kit/src/cli/presetir.js:142-145
    const hub = {
      presetir: { emitAir: async () => ({ command: "AA", response: {} }) },
      resolveRemote: () => { throw new Error("no remote"); },
    };
    const { ctx } = makeCliCtx({ hub });
    const program = buildPresetIrProgram(ctx);
    const err = await program
      .parseAsync(["preset-ir", "air", "--device", "dev-uuid"], { from: "user" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.exitCode).toBe(2);
  });

  it("[IR-0108] --code に非数値 → toInt が throw → エラーが発生する", async () => {
    // ref: packages/kit/src/cli/presetir.js:43-50 (toInt)
    const hub = {
      presetir: { emitAir: async () => ({ command: "AA", response: {} }) },
      resolveRemote: () => { throw new Error("no remote"); },
    };
    const { ctx } = makeCliCtx({ hub });
    const program = buildPresetIrProgram(ctx);
    const err = await program
      .parseAsync(["preset-ir", "air", "--device", "dev-uuid", "--code", "abc"], { from: "user" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/数値を指定してください|notANumber|Please specify a number/i);
  });

  it("[IR-0108] --remote で config remote.code==null → die(remoteNoCode, 2)", async () => {
    // ref: packages/kit/src/cli/presetir.js:98-102
    const hub = {
      presetir: { emitAir: async () => ({ command: "AA", response: {} }) },
      resolveRemote: () => ({
        remote: { code: null, irDeviceUUID: "r-uuid", irType: 0xc000, state: null },
        hub3: { deviceId: "h3" },
      }),
    };
    const { ctx } = makeCliCtx({ hub });
    const program = buildPresetIrProgram(ctx);
    const err = await program
      .parseAsync(["preset-ir", "air", "--remote", "my-remote"], { from: "user" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.exitCode).toBe(2);
    expect(err.message).toMatch(/code/i);
  });

  it("[IR-0108] deviceId 欠落 (deviceId も hub3DeviceId も無し) は badRequest を throw する", async () => {
    // ref: packages/core/src/presetir.js:530 — deviceId required
    const client = makeClient(SUCCESS_REPLY);
    await expect(
      emitAir(client, { companyID: "ch", code: 0 }) // no deviceId
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("[IR-0108] companyID 欠落は badRequest を throw する (sendIR 必須検証)", async () => {
    // ref: packages/core/src/presetir.js:533
    const client = makeClient(SUCCESS_REPLY);
    await expect(
      emitAir(client, { deviceId: "d", code: 0 }) // no companyID
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("[IR-0108] sendIR success:false はエラーを throw する (strict assertSuccess)", async () => {
    // ref: packages/core/src/presetir.js:547
    const failClient = makeClient({ success: false, message: "device offline" });
    await expect(
      emitAir(failClient, { deviceId: "d", companyID: "ch", code: 0 })
    ).rejects.toThrow();
  });

  it("[IR-0108] irType==null は badRequest を throw する (0 は通過)", async () => {
    // ref: packages/core/src/presetir.js:532 — p.irType==null (== null で 0 は通過)
    const client = makeClient(SUCCESS_REPLY);
    await expect(
      sendIR(client, { deviceId: "d", command: "AA", irType: null, companyID: "ch" })
    ).rejects.toMatchObject({ code: "bad_request" });
    await expect(
      sendIR(client, { deviceId: "d", command: "AA", irType: undefined, companyID: "ch" })
    ).rejects.toMatchObject({ code: "bad_request" });
    // irType=0 must pass the null check (0 is valid)
    const zeroClient = makeClient(SUCCESS_REPLY);
    await expect(
      sendIR(zeroClient, { deviceId: "d", command: "AA", irType: 0, companyID: "ch" })
    ).resolves.toBeDefined();
  });
});
