// presetir モジュールの単体テスト。
//
// 検証対象:
//   1. HXDCommandProcessor の byte 配置・checksum (biz3 を 1:1 移植)
//   2. HXDParametersSwapper の key テーブル / index→値変換 (default フォールバック含む)
//   3. buildAirCommandHex / buildNonAirCommandHex の HEX 文字列
//   4. sendIR / emitAir / emitButton の送信フレーム (action/op/フィールド名/値) と応答パース
//
// 期待 HEX は biz3 HXDCommandProcessor.js のアルゴリズムを手計算 + Node で再現した固定値。
import { describe, it, expect } from "vitest";
import {
  HXDCommandProcessor,
  HXDParametersSwapper,
  buildAirCommandHex,
  buildNonAirCommandHex,
  sendIR,
  emitAir,
  emitButton,
  IR_TYPE,
} from "../../src/presetir.js";

// 最小 mock client: request/send を記録し、固定応答を返す。
function mockClient(reply) {
  const sent = [];
  return {
    sent,
    async request(frame, timeoutMs) {
      sent.push({ frame, timeoutMs });
      return reply;
    },
    send(frame) {
      sent.push({ frame, fire: true });
    },
    subscribe() {
      return () => {};
    },
  };
}

// ---------- HXDCommandProcessor ----------

describe("HXDCommandProcessor", () => {
  it("constructor の既定値が biz3 と一致", () => {
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

  it("decimalToTwoHexInts は 16bit ビッグエンディアン分割", () => {
    const p = new HXDCommandProcessor();
    expect(p.decimalToTwoHexInts(0)).toEqual([0, 0]);
    expect(p.decimalToTwoHexInts(100)).toEqual([0, 100]);
    expect(p.decimalToTwoHexInts(1234)).toEqual([4, 210]); // 0x04, 0xd2
    expect(p.decimalToTwoHexInts(65535)).toEqual([255, 255]);
  });

  it("buildKeyData は 16 byte で prefix/code/0x7/indexTable/終端を配置", () => {
    const p = new HXDCommandProcessor();
    const buf = p.buildKeyData([0x30, 0x00], 0, [0, 0, 0]);
    expect(buf).toHaveLength(16);
    expect(buf.slice(0, 2)).toEqual([0x30, 0x00]); // prefix
    expect(buf.slice(2, 4)).toEqual([0, 0]); // code
    expect(buf.slice(4, 11)).toEqual([0, 0, 0, 0, 0, 0, 0]); // 7 個の 0
    expect(buf.slice(11, 14)).toEqual([1, 0, 0]); // indexTable[0]=(0+1)
    expect(buf[14]).toBe(0xff);
    expect(buf[15]).toBe(0);
  });

  it("buildNonAirCommand: code0/key0x01 の固定 HEX と checksum", () => {
    const p = new HXDCommandProcessor();
    const hex = p.toHexString(p.setCode(0).setKey(0x01).buildNonAirCommand());
    expect(hex).toBe("3000000000000000000100010000FF31");
    // checksum: 先頭 15 byte の総和 0x131 & 0xff = 0x31
  });

  it("buildNonAirCommand: key が buf[9] に入り checksum が追従", () => {
    const p = new HXDCommandProcessor();
    const buf = p.setCode(1234).setKey(0x06).buildNonAirCommand();
    expect(buf[0]).toBe(0x30);
    expect(buf[1]).toBe(0x00);
    expect(buf[2]).toBe(0x04); // 1234 上位
    expect(buf[3]).toBe(0xd2); // 1234 下位
    expect(buf[9]).toBe(0x06); // key
    expect(buf[14]).toBe(0xff);
    const sum = buf.slice(0, -1).reduce((s, b) => s + b, 0) & 0xff;
    expect(buf[15]).toBe(sum);
    expect(buf[15]).toBe(0x0c);
  });

  it("buildAirCommand: 既定値の固定 HEX", () => {
    const p = new HXDCommandProcessor();
    const hex = p.toHexString(p.setCode(0).buildAirCommand());
    // temp25=0x19, fan0x01, wind0x02, autoWind0x01, power0x00, key0x01, mode0x02
    expect(hex).toBe("3001000019010201000102010000FF51");
  });

  it("buildAirCommand: 状態が buf[4..10] へ直接書き込まれる", () => {
    const p = new HXDCommandProcessor();
    const buf = p
      .setCode(100)
      .setKey(0x02)
      .setTemperature(24)
      .setFanSpeed(0x03)
      .setWindDirection(0x01)
      .setAutoWindDirection(0x01)
      .setPower(0x01)
      .setModel(0x02)
      .buildAirCommand();
    expect(buf.slice(0, 4)).toEqual([0x30, 0x01, 0x00, 0x64]);
    expect(buf[4]).toBe(24); // temperature
    expect(buf[5]).toBe(0x03); // fanSpeed
    expect(buf[6]).toBe(0x01); // windDirection
    expect(buf[7]).toBe(0x01); // autoWindDirection
    expect(buf[8]).toBe(0x01); // power
    expect(buf[9]).toBe(0x02); // key
    expect(buf[10]).toBe(0x02); // mode
    expect(buf[14]).toBe(0xff);
    expect(buf[15]).toBe(buf.slice(0, -1).reduce((s, b) => s + b, 0) & 0xff);
  });

  it("toHexString は大文字・2 桁 0 埋め・区切り無し", () => {
    const p = new HXDCommandProcessor();
    expect(p.toHexString([0x30, 0x01, 0x00, 0x0a, 0xff])).toBe("3001000AFF");
  });

  it("hexStringToByteArray は toHexString の逆", () => {
    const p = new HXDCommandProcessor();
    expect(p.hexStringToByteArray("3001000AFF")).toEqual([0x30, 0x01, 0x00, 0x0a, 0xff]);
  });

  it("parseAirCommand: 生成した air command を復元できる", () => {
    const p = new HXDCommandProcessor();
    const hex = buildAirCommandHex({
      code: 100,
      power: true,
      temperature: 24,
      mode: 1, // -> 0x02
      fanSpeed: 2, // -> 0x03
      windDirection: 0, // -> 0x01
      autoSwing: true, // -> 0x01
    });
    expect(p.parseAirCommand(hex)).toEqual({
      temperature: 24,
      fanSpeed: 0x03,
      windDirection: 0x01,
      autoWindDirection: 0x01,
      power: 0x01,
      key: 0x01, // keyType 未指定 -> default
      mode: 0x02,
    });
  });

  it("parseAirCommand: 短すぎる/prefix 不一致は null", () => {
    const p = new HXDCommandProcessor();
    expect(p.parseAirCommand("3001")).toBeNull();
    expect(p.parseAirCommand("3000000000000000000100010000FF31")).toBeNull(); // non-air prefix
  });
});

// ---------- HXDParametersSwapper ----------

describe("HXDParametersSwapper", () => {
  const sw = new HXDParametersSwapper();

  it("getAirKey: keyMap 一致 / 未知は default 0x01 (UI type トラップ)", () => {
    expect(sw.getAirKey("MODE")).toBe(0x02);
    expect(sw.getAirKey("FAN_SPEED")).toBe(0x03);
    expect(sw.getAirKey("WIND_DIRECTION")).toBe(0x04);
    expect(sw.getAirKey("AUTO_WIND_DIRECTION")).toBe(0x05);
    expect(sw.getAirKey("TEMP_CONTROL_ADD")).toBe(0x06);
    expect(sw.getAirKey("TEMP_CONTROL_REDUCE")).toBe(0x07);
    expect(sw.getAirKey("POWER_STATUS_ON")).toBe(0x01);
    // UI 由来の type 名 (remote-air) は keyMap に無く default
    expect(sw.getAirKey("POWER_ON")).toBe(0x01);
    expect(sw.getAirKey("TEMP_ADD")).toBe(0x01);
    expect(sw.getAirKey("AUTO_SWING")).toBe(0x01);
    expect(sw.getAirKey(undefined)).toBe(0x01);
  });

  it("getModeValue / getFanSpeedValue / getWindDirectionValue", () => {
    expect([0, 1, 2, 3, 4].map((i) => sw.getModeValue(i))).toEqual([0x01, 0x02, 0x03, 0x04, 0x05]);
    expect(sw.getModeValue(99)).toBe(0x01);
    expect([0, 1, 2, 3].map((i) => sw.getFanSpeedValue(i))).toEqual([0x01, 0x02, 0x03, 0x04]);
    expect(sw.getFanSpeedValue(99)).toBe(0x01);
    expect([0, 1, 2].map((i) => sw.getWindDirectionValue(i))).toEqual([0x01, 0x02, 0x03]);
    expect(sw.getWindDirectionValue(99)).toBe(0x02); // default 0x02
  });

  it("getLightKey", () => {
    expect(sw.getLightKey("POWER_STATUS_ON")).toBe(0x01);
    expect(sw.getLightKey("POWER_STATUS_OFF")).toBe(0x02);
    expect(sw.getLightKey("MODE")).toBe(0x05);
    expect(sw.getLightKey("BRIGHTNESS_UP")).toBe(0x03);
    expect(sw.getLightKey("BRIGHTNESS_DOWN")).toBe(0x04);
    expect(sw.getLightKey("COLOR_TEMP_UP")).toBe(0x09);
    expect(sw.getLightKey("COLOR_TEMP_DOWN")).toBe(0x0a);
    expect(sw.getLightKey("???")).toBe(0x01);
  });

  it("getTVKey", () => {
    expect(sw.getTVKey("POWER_STATUS_ON")).toBe(0x06);
    expect(sw.getTVKey("POWER_STATUS_OFF")).toBe(0x06);
    expect(sw.getTVKey("MUTE")).toBe(0x07);
    expect(sw.getTVKey("VOLUME_UP")).toBe(0x05);
    expect(sw.getTVKey("VOLUME_DOWN")).toBe(0x01);
    expect(sw.getTVKey("CHANNEL_UP")).toBe(0x02);
    expect(sw.getTVKey("CHANNEL_DOWN")).toBe(0x04);
    expect(sw.getTVKey("HOME")).toBe(0x1a);
    expect(sw.getTVKey("OK")).toBe(0x15);
    expect(sw.getTVKey("???")).toBe(0x01);
  });

  it("getFanKey", () => {
    expect(sw.getFanKey("POWER_STATUS_ON")).toBe(0x01);
    expect(sw.getFanKey("FAN_SPEED")).toBe(0x02);
    expect(sw.getFanKey("SHAKE_HEAD")).toBe(0x03);
    expect(sw.getFanKey("MODE")).toBe(0x04);
    expect(sw.getFanKey("LOW")).toBe(0x14);
    expect(sw.getFanKey("MIDDLE")).toBe(0x15);
    expect(sw.getFanKey("HIGH")).toBe(0x16);
    expect(sw.getFanKey("???")).toBe(0x01);
  });

  it("getKeyByDeviceType は irType で分岐 / 未知は 0x01", () => {
    expect(sw.getKeyByDeviceType(0xc000, "MODE")).toBe(0x02); // air
    expect(sw.getKeyByDeviceType(0xe000, "MODE")).toBe(0x05); // light
    expect(sw.getKeyByDeviceType(0x2000, "MUTE")).toBe(0x07); // tv
    expect(sw.getKeyByDeviceType(0x8000, "HIGH")).toBe(0x16); // fan
    expect(sw.getKeyByDeviceType(0xffff, "X")).toBe(0x01);
  });
});

// ---------- IR_TYPE ----------

describe("IR_TYPE", () => {
  it("実値が確定値と一致", () => {
    expect(IR_TYPE.AIR).toBe(0xc000);
    expect(IR_TYPE.FAN).toBe(0x8000);
    expect(IR_TYPE.LIGHT).toBe(0xe000);
    expect(IR_TYPE.TV).toBe(0x2000);
  });
});

// ---------- buildAirCommandHex / buildNonAirCommandHex ----------

describe("buildAirCommandHex", () => {
  it("既定パラメータ (code のみ)", () => {
    expect(buildAirCommandHex({ code: 0 })).toBe("3001000019010200000101010000FF4F");
  });

  it("フル指定 (フローが biz3 buildCommand と一致)", () => {
    const hex = buildAirCommandHex({
      code: 100,
      power: true,
      temperature: 24,
      mode: 1,
      fanSpeed: 2,
      windDirection: 0,
      autoSwing: true,
      keyType: "MODE",
    });
    expect(hex).toBe("3001006418030101010202010000FFB7");
  });
});

describe("buildNonAirCommandHex", () => {
  it("TV 電源 (code1234, POWER_STATUS_ON->0x06)", () => {
    expect(buildNonAirCommandHex({ irType: IR_TYPE.TV, code: 1234, buttonType: "POWER_STATUS_ON" })).toBe(
      "300004D200000000000600010000FF0C",
    );
  });

  it("扇風機 首振り (SHAKE_HEAD->0x03)", () => {
    const hex = buildNonAirCommandHex({ irType: IR_TYPE.FAN, code: 0, buttonType: "SHAKE_HEAD" });
    const p = new HXDCommandProcessor();
    const bytes = p.hexStringToByteArray(hex);
    expect(bytes[0]).toBe(0x30);
    expect(bytes[1]).toBe(0x00);
    expect(bytes[9]).toBe(0x03); // key
  });
});

// ---------- sendIR (frame 正確性) ----------

describe("sendIR", () => {
  it("必須フィールド欠如は throw", async () => {
    const c = mockClient({ success: true });
    await expect(sendIR(c, { command: "AA", irType: 0x2000, companyID: "ch" })).rejects.toThrow(/deviceId required/);
    await expect(sendIR(c, { deviceId: "d", irType: 0x2000, companyID: "ch" })).rejects.toThrow(/command required/);
    await expect(sendIR(c, { deviceId: "d", command: "AA", companyID: "ch" })).rejects.toThrow(/irType required/);
    await expect(sendIR(c, { deviceId: "d", command: "AA", irType: 0x2000 })).rejects.toThrow(/companyID required/);
  });

  it("frame は biz3 useRemoteCtrl.js:467-476 と完全一致", async () => {
    const c = mockClient({ success: true, data: { ok: 1 } });
    await sendIR(c, {
      deviceId: "hub3-uuid",
      command: "300004D200000000000600010000FF0C",
      irType: IR_TYPE.TV,
      companyID: "ch_X",
      irDeviceUUID: "remote-uuid",
    });
    expect(c.sent).toHaveLength(1);
    const f = c.sent[0].frame;
    expect(f.action).toBe("biz3IRRemote");
    expect(f.op).toBe("sendIR");
    expect(f.deviceId).toBe("hub3-uuid"); // hub3DeviceId ではなく deviceId
    expect(f.command).toBe("300004D200000000000600010000FF0C");
    expect(f.operation).toBe("remoteEmit");
    expect(f.irType).toBe(0x2000);
    expect(f.companyID).toBe("ch_X");
    expect(f.irDeviceUUID).toBe("remote-uuid");
    // フィールド名の取り違え防止 (hub3DeviceId / remoteId は存在しない)
    expect(f).not.toHaveProperty("hub3DeviceId");
    expect(f).not.toHaveProperty("remoteId");
  });

  it("irDeviceUUID 省略時は空文字 '' (未保存プリセット)", async () => {
    const c = mockClient({ success: true });
    await sendIR(c, { deviceId: "d", command: "AA", irType: IR_TYPE.AIR, companyID: "ch" });
    expect(c.sent[0].frame.irDeviceUUID).toBe("");
  });

  it("operation は既定 remoteEmit / 上書き可", async () => {
    const c = mockClient({ success: true });
    await sendIR(c, { deviceId: "d", command: "AA", irType: IR_TYPE.AIR, companyID: "ch", operation: "remoteLearn" });
    expect(c.sent[0].frame.operation).toBe("remoteLearn");
  });

  it("success:false は throw", async () => {
    const c = mockClient({ success: false, message: "device offline" });
    await expect(
      sendIR(c, { deviceId: "d", command: "AA", irType: IR_TYPE.AIR, companyID: "ch" }),
    ).rejects.toThrow(/sendIR failed: device offline/);
  });

  // P4-10: hub3DeviceId alias
  it("hub3DeviceId は deviceId の alias として受理され、ワイヤには deviceId で送る", async () => {
    // ir.listKeys/learn/addRemoteToMatter は hub3DeviceId を使うため、
    // sendIR も hub3DeviceId を受理できることで呼び出し側の名前統一が可能になる。
    const c = mockClient({ success: true });
    await sendIR(c, { hub3DeviceId: "hub3-uuid", command: "AA", irType: IR_TYPE.AIR, companyID: "ch" });
    const f = c.sent[0].frame;
    // ワイヤには正準名 deviceId で送信する (useRemoteCtrl.js:467 の field 名と一致)。
    expect(f.deviceId).toBe("hub3-uuid");
    expect(f).not.toHaveProperty("hub3DeviceId");
  });

  it("deviceId と hub3DeviceId 両方ある場合は deviceId が優先される", async () => {
    const c = mockClient({ success: true });
    await sendIR(c, { deviceId: "canonical", hub3DeviceId: "alias", command: "AA", irType: IR_TYPE.AIR, companyID: "ch" });
    expect(c.sent[0].frame.deviceId).toBe("canonical");
  });

  it("deviceId も hub3DeviceId も無い場合は throw (既存エラーと同一)", async () => {
    const c = mockClient({ success: true });
    await expect(sendIR(c, { command: "AA", irType: IR_TYPE.AIR, companyID: "ch" })).rejects.toThrow(/deviceId required/);
  });

  it("応答をそのまま返す", async () => {
    const reply = { success: true, op: "sendIR", data: { result: "ok" } };
    const c = mockClient(reply);
    const r = await sendIR(c, { deviceId: "d", command: "AA", irType: IR_TYPE.AIR, companyID: "ch" });
    expect(r).toBe(reply);
  });
});

// ---------- emitAir / emitButton (複合) ----------

describe("emitAir", () => {
  it("command 生成 + sendIR (irType=AIR 固定)", async () => {
    const c = mockClient({ success: true });
    const { command, response } = await emitAir(c, {
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
    expect(command).toBe("3001006418030101010202010000FFB7");
    const f = c.sent[0].frame;
    expect(f.irType).toBe(IR_TYPE.AIR);
    expect(f.command).toBe(command);
    expect(f.deviceId).toBe("hub3");
    expect(f.irDeviceUUID).toBe("");
    expect(response.success).toBe(true);
  });

  it("irDeviceUUID を渡せる (保存済みリモコン)", async () => {
    const c = mockClient({ success: true });
    await emitAir(c, { deviceId: "hub3", companyID: "ch", code: 0, irDeviceUUID: "r-1" });
    expect(c.sent[0].frame.irDeviceUUID).toBe("r-1");
  });
});

describe("emitButton", () => {
  it("TV 電源 command 生成 + sendIR", async () => {
    const c = mockClient({ success: true });
    const { command } = await emitButton(c, {
      deviceId: "hub3",
      companyID: "ch",
      code: 1234,
      irType: IR_TYPE.TV,
      buttonType: "POWER_STATUS_ON",
    });
    expect(command).toBe("300004D200000000000600010000FF0C");
    const f = c.sent[0].frame;
    expect(f.irType).toBe(IR_TYPE.TV);
    expect(f.command).toBe(command);
    expect(f.operation).toBe("remoteEmit");
  });

  it("ライト MODE は key 0x05 が buf[9] に乗る", async () => {
    const c = mockClient({ success: true });
    const { command } = await emitButton(c, {
      deviceId: "hub3",
      companyID: "ch",
      code: 0,
      irType: IR_TYPE.LIGHT,
      buttonType: "MODE",
    });
    const bytes = new HXDCommandProcessor().hexStringToByteArray(command);
    expect(bytes[9]).toBe(0x05);
    expect(c.sent[0].frame.irType).toBe(IR_TYPE.LIGHT);
  });
});
