// P3-2 / P3-3: updateRemoteState / addRemoteToMatter (src/ir.js) と
// presetir.emitAir/emitButton の state 自動保存・復元 (src/presetir.js) の単体テスト。
//
// frame fixture の導出元 (vendor の送信側コード):
//   - updateRemoteState: useRemoteCtrl.js:493-514
//       { action, op:'updateRemoteState', deviceId: hub3DeviceId, uuid: remoteId, state, companyID }
//   - addRemoteToMatter: useRemoteCtrl.js:933-955
//       { action, op:'addRemoteToMatter', hub3DeviceId, irDeviceType, cmdOn, cmdOff,
//         irDeviceUUID, irDeviceName, companyID }
//   - emit 後の自動保存: remote-air/index.js:371-383 / remote-non-air/index.js:158-166
//       sendIR 成功 && remote.uuid → updateRemoteState(hub3DeviceId, remote.uuid, cmd)
//   - state 復元: remote-air/index.js:108-113,564-581 (parseAirCommand → convertToUIState)

import { describe, it, expect, vi } from "vitest";
import { updateRemoteState, addRemoteToMatter } from "../../src/ir.js";
import {
  emitAir, emitButton, restoreAirState, buildAirCommandHex, IR_TYPE,
  HXDCommandProcessor, HXDParametersSwapper,
} from "../../src/presetir.js";
import { ERR } from "../../src/errors.js";

const ACTION = "biz3IRRemote";
const CO = "co-A";

/** request された frame を記録し、op ごとの固定応答を返す mock client。 */
function makeClient(responsesByOp = {}) {
  const requests = [];
  return {
    requests,
    request: vi.fn(async (frame, _timeoutMs) => {
      requests.push(frame);
      return responsesByOp[frame.op] ?? { action: ACTION, op: frame.op, success: true };
    }),
  };
}

describe("P3-2: updateRemoteState", () => {
  it("frame 1:1 (useRemoteCtrl.js:498-505): deviceId/uuid/state/companyID", async () => {
    const client = makeClient();
    await updateRemoteState(client, { hub3DeviceId: "hub-1", uuid: "r-1", state: "3001AABB", companyID: CO });
    expect(client.requests[0]).toEqual({
      action: ACTION,
      op: "updateRemoteState",
      deviceId: "hub-1", // フィールド名トラップ: hub3 は deviceId
      uuid: "r-1",
      state: "3001AABB",
      companyID: CO,
    });
  });

  it("success:false は reject (strict)", async () => {
    const client = makeClient({ updateRemoteState: { success: false, message: "nope" } });
    await expect(updateRemoteState(client, { hub3DeviceId: "h", uuid: "r", state: "s", companyID: CO }))
      .rejects.toMatchObject({ code: ERR.REJECTED });
  });
});

describe("P3-3: addRemoteToMatter", () => {
  it("frame 1:1 (useRemoteCtrl.js:938-948)", async () => {
    const client = makeClient();
    await addRemoteToMatter(client, {
      hub3DeviceId: "hub-1",
      irDeviceType: 0xc000,
      cmdOn: "3001ON",
      cmdOff: "3001OFF",
      irDeviceUUID: "r-1",
      irDeviceName: "Living AC",
      companyID: CO,
    });
    expect(client.requests[0]).toEqual({
      action: ACTION,
      op: "addRemoteToMatter",
      hub3DeviceId: "hub-1",
      irDeviceType: 0xc000,
      cmdOn: "3001ON",
      cmdOff: "3001OFF",
      irDeviceUUID: "r-1",
      irDeviceName: "Living AC",
      companyID: CO,
    });
  });
});

describe("P3-2: emitAir/emitButton の state 自動保存", () => {
  it("emitAir 成功後、irDeviceUUID があれば command を updateRemoteState で保存する (remote-air:371-383)", async () => {
    const client = makeClient();
    const { command, stateSaved } = await emitAir(client, {
      deviceId: "hub-1", companyID: CO, code: 1234, irDeviceUUID: "r-1", power: true,
    });
    expect(stateSaved).toBe(true);
    expect(client.requests).toHaveLength(2);
    expect(client.requests[0].op).toBe("sendIR");
    expect(client.requests[1]).toEqual({
      action: ACTION, op: "updateRemoteState",
      deviceId: "hub-1", uuid: "r-1", state: command, companyID: CO,
    });
  });

  it("irDeviceUUID 無し (未保存リモコン) なら保存しない (vendor: remote.uuid || '' の分岐)", async () => {
    const client = makeClient();
    const { stateSaved } = await emitAir(client, { deviceId: "hub-1", companyID: CO, code: 1234 });
    expect(stateSaved).toBe(false);
    expect(client.requests).toHaveLength(1); // sendIR のみ
  });

  it("updateRemoteState 失敗でも emit は成功扱い (vendor は console.error のみ)", async () => {
    const client = makeClient({ updateRemoteState: { success: false, message: "boom" } });
    const r = await emitAir(client, { deviceId: "hub-1", companyID: CO, code: 1234, irDeviceUUID: "r-1" });
    expect(r.stateSaved).toBe(false);
    expect(r.response).toMatchObject({ success: true });
  });

  it("emitButton も成功後に保存する (remote-non-air:158-166)", async () => {
    const client = makeClient();
    const { command, stateSaved } = await emitButton(client, {
      deviceId: "hub-1", companyID: CO, code: 99, irType: IR_TYPE.TV, buttonType: "POWER_STATUS_ON",
      irDeviceUUID: "r-2",
    });
    expect(stateSaved).toBe(true);
    expect(client.requests[1]).toMatchObject({ op: "updateRemoteState", uuid: "r-2", state: command });
  });
});

describe("P3-2: restoreAirState (remote.state からの復元)", () => {
  it("buildAirCommandHex の出力を parse → UI state へ往復できる (convertToUIState 1:1)", () => {
    const hex = buildAirCommandHex({
      code: 1234, power: true, temperature: 27, mode: 2, fanSpeed: 3, windDirection: 2, autoSwing: true,
    });
    const restored = restoreAirState(hex);
    expect(restored).toEqual({
      power: true, temperature: 27, mode: 2, fanSpeed: 3, windDirection: 2, autoSwing: true,
    });
  });

  it("不正/空 HEX は null (vendor も復元せず既定値のまま)", () => {
    expect(restoreAirState("")).toBeNull();
    expect(restoreAirState(null)).toBeNull();
    expect(restoreAirState("00FF")).toBeNull();      // 短すぎ
    expect(restoreAirState("30000000000000000000000000000000")).toBeNull(); // prefix 0x30,0x00 (非 Air)
  });

  it("convertToUIState の逆写像は getModeIndex/getFanSpeedIndex/getWindDirectionIndex (HXDParametersSwapper:34-85)", () => {
    const sw = new HXDParametersSwapper();
    expect(sw.getModeIndex(0x05)).toBe(4);
    expect(sw.getModeIndex(0x99)).toBe(0); // 未知は default 0
    expect(sw.getFanSpeedIndex(0x04)).toBe(3);
    expect(sw.getWindDirectionIndex(0x03)).toBe(2);
  });

  it("emitAir は savedState を既定値に使い、明示指定が上書きする", async () => {
    // 保存 state: power=ON temp=27 mode=2 fan=3 wind=2 swing=true
    const saved = buildAirCommandHex({
      code: 1234, power: true, temperature: 27, mode: 2, fanSpeed: 3, windDirection: 2, autoSwing: true,
    });
    const client = makeClient();
    // temperature だけ明示 → 残りは saved から復元される
    const { command } = await emitAir(client, {
      deviceId: "hub-1", companyID: CO, code: 1234, savedState: saved, temperature: 20,
    });
    const parsed = new HXDCommandProcessor().parseAirCommand(command);
    expect(parsed).toMatchObject({
      temperature: 20,        // 明示上書き
      power: 0x01,            // saved から復元
      mode: 0x03,             // UI index 2 → HXD 0x03
      fanSpeed: 0x04,         // UI index 3 → HXD 0x04
      windDirection: 0x03,    // UI index 2 → HXD 0x03
      autoWindDirection: 0x01,
    });
  });

  it("savedState が不正なら従来既定値で発射する (復元失敗を黙って握りつぶさず既定動作)", async () => {
    const client = makeClient();
    const { command } = await emitAir(client, {
      deviceId: "hub-1", companyID: CO, code: 1234, savedState: "garbage",
    });
    const noSaved = await emitAir(makeClient(), { deviceId: "hub-1", companyID: CO, code: 1234 });
    expect(command).toBe(noSaved.command);
  });
});
