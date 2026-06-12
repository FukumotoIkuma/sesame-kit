// Unit tests for addIRRemote in src/ir.js (P3-1)。
//
// vendor 形の根拠:
//   references_web/src/pages/personal/devices/wifi-module/ir/learn/index.js:261-270
//   references_web/src/pages/personal/devices/wifi-module/ir/remote-air/index.js:512-521
//   references_web/src/pages/personal/devices/wifi-module/ir/remote-non-air/index.js:264-273
//
// いずれも送信直前に:
//   uuid: biz3utils.generateUUID()   — クライアント発番
//   model / state / alias / code / type — remote から抜き出し
//   deviceUUID: hub3DeviceId         — Hub3 の deviceId
//   keys: []
// の形に組み立ててから addIRRemote に渡す。
//
// テスト項目:
//   1. uuid 省略時は addIRRemote 内で UUID 補完されて frame に乗る。
//   2. uuid 指定時はそのまま使われる(上書きしない)。
//   3. deviceUUID 欠落時は badRequest (code="badRequest") を throw する。
//   4. 正常応答の resp.data が返る。
//   5. success:false は throw (assertSuccess strict)。

import { describe, it, expect, vi } from "vitest";
import { addIRRemote } from "../../src/ir.js";

const ACTION = "biz3IRRemote";
const COMPANY_ID = "co-A";
const HUB3_DEVICE_UUID = "hub3-device-uuid-1234";

/** 1 回の request に固定応答を返す最小 mock client。 */
function makeClient(response) {
  const requests = [];
  return {
    requests,
    request: vi.fn(async (frame, _timeoutMs) => {
      requests.push(frame);
      return response;
    }),
  };
}

/** vendor 成功応答 fixture。 */
function successResponse(data = null) {
  return { action: ACTION, op: "addIRRemote", success: true, data };
}

describe("addIRRemote (P3-1)", () => {
  it("uuid 未指定時は addIRRemote 内で UUID を補完して frame に乗せる", async () => {
    // references_web/src/pages/.../ir/learn/index.js:262 — biz3utils.generateUUID()
    const client = makeClient(successResponse({ saved: true }));
    const remote = {
      // uuid を意図的に省略
      model: "ACME-TV-100",
      state: "",
      alias: "リビングのテレビ",
      code: "preset-code-001",
      type: 0x2000,
      deviceUUID: HUB3_DEVICE_UUID,
      keys: [],
    };
    await addIRRemote(client, { remote, companyID: COMPANY_ID });

    const sentRemote = client.requests[0].remote;
    // uuid が補完されていること
    expect(typeof sentRemote.uuid).toBe("string");
    expect(sentRemote.uuid.length).toBeGreaterThan(0);
    // 他フィールドは元のまま
    expect(sentRemote.model).toBe("ACME-TV-100");
    expect(sentRemote.deviceUUID).toBe(HUB3_DEVICE_UUID);
  });

  it("uuid 指定時はそのまま使う (上書きしない)", async () => {
    // references_web/src/pages/.../ir/remote-air/index.js:513 — generateUUID() は呼び出し元で発番
    const client = makeClient(successResponse());
    const specifiedUuid = "my-fixed-uuid-5678";
    const remote = {
      uuid: specifiedUuid,
      model: "BRAND-AC-200",
      state: "aabbcc",
      alias: "エアコン",
      code: "ac-preset",
      type: 0xC000,
      deviceUUID: HUB3_DEVICE_UUID,
      keys: [],
    };
    await addIRRemote(client, { remote, companyID: COMPANY_ID });

    expect(client.requests[0].remote.uuid).toBe(specifiedUuid);
  });

  it("deviceUUID 欠落時は badRequest (code=badRequest) を throw する", async () => {
    // references_web の呼び出し元は常に deviceUUID: hub3DeviceId を渡す。
    // kit 側でその欠落を明示拒否する。
    const client = makeClient(successResponse());
    const remoteWithoutDeviceUUID = {
      uuid: "u-1",
      model: "TV",
      state: "",
      alias: "TV",
      code: "",
      type: 0x2000,
      // deviceUUID を意図的に省略
      keys: [],
    };
    await expect(
      addIRRemote(client, { remote: remoteWithoutDeviceUUID, companyID: COMPANY_ID })
    ).rejects.toMatchObject({ code: "bad_request" });
    // client.request は呼ばれないこと (送信前に拒否)
    expect(client.request).not.toHaveBeenCalled();
  });

  it("deviceUUID が空文字のときも badRequest を throw する", async () => {
    const client = makeClient(successResponse());
    const remote = {
      uuid: "u-2",
      model: "TV",
      state: "",
      alias: "TV",
      code: "",
      type: 0x2000,
      deviceUUID: "",
      keys: [],
    };
    await expect(
      addIRRemote(client, { remote, companyID: COMPANY_ID })
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(client.request).not.toHaveBeenCalled();
  });

  it("frame は vendor と同形 (action/op/companyID + remote オブジェクト)", async () => {
    // references_web/src/pages/.../ir/learn/index.js:271 — addIRRemote(remoteToSave, callback)
    // → kit の frame: { action:'biz3IRRemote', op:'addIRRemote', remote:{...}, companyID }
    const client = makeClient(successResponse());
    const remote = {
      uuid: "fixed-uuid-abc",
      model: "BRAND-FAN-300",
      state: "",
      alias: "扇風機",
      code: "fan-code",
      type: 0x8000,
      deviceUUID: HUB3_DEVICE_UUID,
      keys: [],
    };
    await addIRRemote(client, { remote, companyID: COMPANY_ID });

    expect(client.requests[0]).toMatchObject({
      action: ACTION,
      op: "addIRRemote",
      companyID: COMPANY_ID,
      remote: {
        uuid: "fixed-uuid-abc",
        model: "BRAND-FAN-300",
        state: "",
        alias: "扇風機",
        code: "fan-code",
        type: 0x8000,
        deviceUUID: HUB3_DEVICE_UUID,
        keys: [],
      },
    });
  });

  it("正常応答 resp.data を返す", async () => {
    const client = makeClient(successResponse({ remoteId: "srv-r-1" }));
    const remote = {
      uuid: "u-ok",
      model: "M",
      state: "",
      alias: "A",
      code: "c",
      type: 0xFE00,
      deviceUUID: HUB3_DEVICE_UUID,
      keys: [],
    };
    const result = await addIRRemote(client, { remote, companyID: COMPANY_ID });
    expect(result).toEqual({ remoteId: "srv-r-1" });
  });

  it("resp.data が null の場合は null を返す", async () => {
    const client = makeClient(successResponse(null));
    const remote = {
      uuid: "u-null",
      model: "M",
      state: "",
      alias: "A",
      code: "c",
      type: 0xFE00,
      deviceUUID: HUB3_DEVICE_UUID,
      keys: [],
    };
    const result = await addIRRemote(client, { remote, companyID: COMPANY_ID });
    expect(result).toBeNull();
  });

  it("success:false は throw (assertSuccess strict)", async () => {
    const client = makeClient({ action: ACTION, op: "addIRRemote", success: false, message: "denied" });
    const remote = {
      uuid: "u-fail",
      model: "M",
      state: "",
      alias: "A",
      code: "c",
      type: 0x2000,
      deviceUUID: HUB3_DEVICE_UUID,
      keys: [],
    };
    await expect(
      addIRRemote(client, { remote, companyID: COMPANY_ID })
    ).rejects.toThrow(/addIRRemote/);
  });
});
