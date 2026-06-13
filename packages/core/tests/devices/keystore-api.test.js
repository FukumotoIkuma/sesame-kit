// P3-2: 個人アカウント鍵ストア REST API (getDevicesList / putKey / removeKey) の単体テスト。
//
// transport の wire 形 (method/path/headers/body) を fake transport でキャプチャして固定する。
//
// 参照 (CHAPIClient.kt:22-46, CHAPIClientBiz.kt:99-109, CHUserKey.kt:36-46):
//   GET  /device/list  — getDevicesList (appidentifyid ヘッダ必須)
//   PUT  /device       — putKey (body: CHUserKey オブジェクト)
//   DELETE /device     — removeKey (body: deviceUUID JSON 文字列 "uuid")
//
// makeKeyStoreTransport は makeRegisterTransport と同基盤だが appidentifyid を付ける点が異なる。
// ここでは transport の振る舞いではなく「関数が正しいメソッド/パス/bodyで transport を呼ぶか」を固定。

import { describe, it, expect } from "vitest";
import { getDevicesList, putKey, removeKey } from "../../src/devices.js";
import { ERR } from "../../src/errors.js";

/**
 * transport fake: 呼び出された req を記録し、固定応答を返す。
 * @param {{status: number, json?: any, text?: string}} reply
 * @returns {{ transport: Function, calls: Array<{method:string, path:string, body?:any}> }}
 */
function makeFakeTransport(reply = { status: 200, json: null, text: "" }) {
  const calls = [];
  const transport = async (req) => {
    calls.push(req);
    return reply;
  };
  return { transport, calls };
}

// ---- CHUserKey フィクスチャ (CHUserKey.kt:36-46 から導出) ----
const SAMPLE_KEY = {
  deviceUUID: "AABBCCDD-1122-3344-5566-778899AABBCC",
  deviceModel: "sesame_5",
  keyIndex: "0001",
  secretKey: "00112233445566778899aabbccddeeff",
  sesame2PublicKey: "0011223344556677889900112233445566778899001122334455667788990011",
  deviceName: "Front Door",
  keyLevel: 2,
};

describe("P3-2: getDevicesList — GET /device/list (CHAPIClient.kt:36-39)", () => {
  it("GET /device/list を呼ぶ (path / method 固定)", async () => {
    const { transport, calls } = makeFakeTransport({ status: 200, json: [SAMPLE_KEY], text: JSON.stringify([SAMPLE_KEY]) });
    await getDevicesList(transport);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].path).toBe("/device/list");
    // GET に body は不要
    expect(calls[0].body).toBeUndefined();
  });

  it("応答 JSON 配列をそのまま返す", async () => {
    const { transport } = makeFakeTransport({ status: 200, json: [SAMPLE_KEY], text: "" });
    const result = await getDevicesList(transport);
    expect(result).toEqual([SAMPLE_KEY]);
  });

  it("応答が空配列でも [] を返す", async () => {
    const { transport } = makeFakeTransport({ status: 200, json: [], text: "[]" });
    const result = await getDevicesList(transport);
    expect(result).toEqual([]);
  });

  it("応答が配列でない場合は [] を返す", async () => {
    const { transport } = makeFakeTransport({ status: 200, json: null, text: "" });
    const result = await getDevicesList(transport);
    expect(result).toEqual([]);
  });

  it("4xx は assertHttpOk で throw する (status コード含む)", async () => {
    const { transport } = makeFakeTransport({ status: 403, json: { message: "Forbidden" }, text: "" });
    await expect(getDevicesList(transport)).rejects.toThrow(/getDevicesList/);
    await expect(getDevicesList(transport)).rejects.toThrow(/403/);
  });

  it("transport が関数でない場合は bad_request", async () => {
    await expect(getDevicesList(/** @type {any} */ (null))).rejects.toMatchObject({ code: ERR.BAD_REQUEST });
  });
});

describe("P3-2: putKey — PUT /device (CHAPIClient.kt:29-33, ScanQRcodeFG.kt:342-348)", () => {
  it("PUT /device を body=CHUserKey 形で呼ぶ", async () => {
    const { transport, calls } = makeFakeTransport({ status: 200, json: { ok: true }, text: "" });
    await putKey(transport, SAMPLE_KEY);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].path).toBe("/device");
    // body は CHUserKey オブジェクトそのまま (Gson 直列化は transport 側が行う)
    expect(calls[0].body).toEqual(SAMPLE_KEY);
  });

  it("応答 json を返す", async () => {
    const { transport } = makeFakeTransport({ status: 200, json: { ok: true }, text: "" });
    const result = await putKey(transport, SAMPLE_KEY);
    expect(result).toEqual({ ok: true });
  });

  it("deviceUUID 欠落は bad_request (transport 未呼び出し)", async () => {
    const { transport, calls } = makeFakeTransport({ status: 200, json: null, text: "" });
    await expect(putKey(transport, /** @type {any} */ ({ deviceModel: "sesame_5" }))).rejects.toMatchObject({ code: ERR.BAD_REQUEST });
    expect(calls).toHaveLength(0);
  });

  it("5xx は assertHttpOk で throw", async () => {
    const { transport } = makeFakeTransport({ status: 500, json: null, text: "internal" });
    await expect(putKey(transport, SAMPLE_KEY)).rejects.toThrow(/putKey/);
    await expect(putKey(transport, SAMPLE_KEY)).rejects.toThrow(/500/);
  });

  it("transport が関数でない場合は bad_request", async () => {
    await expect(putKey(/** @type {any} */ ("not-fn"), SAMPLE_KEY)).rejects.toMatchObject({ code: ERR.BAD_REQUEST });
  });
});

describe("P3-2: removeKey — DELETE /device (CHAPIClient.kt:42-46, CHDeviceViewModel.kt:567)", () => {
  // 参照: CHAPIClientBiz.kt:109 cHApiClient.removeKey(identifyId(), keyId)
  //   keyId = targetDevice.deviceId.toString() (CHDeviceViewModel.kt:567)。
  // Kotlin body:String → Gson → JSON string literal "uuid"。
  // makeApiGatewayTransport で JSON.stringify("uuid") = '"uuid"' がそのまま HTTP body になる (正)。

  it("DELETE /device を body=deviceUUID 文字列で呼ぶ", async () => {
    const { transport, calls } = makeFakeTransport({ status: 200, json: { ok: true }, text: "" });
    await removeKey(transport, SAMPLE_KEY.deviceUUID);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].path).toBe("/device");
    // body は deviceUUID 文字列 (Kotlin body:String → Gson → JSON string)
    expect(calls[0].body).toBe(SAMPLE_KEY.deviceUUID);
  });

  it("応答 json を返す", async () => {
    const { transport } = makeFakeTransport({ status: 200, json: { removed: true }, text: "" });
    const result = await removeKey(transport, SAMPLE_KEY.deviceUUID);
    expect(result).toEqual({ removed: true });
  });

  it("deviceUUID 空文字は bad_request", async () => {
    const { transport, calls } = makeFakeTransport({ status: 200, json: null, text: "" });
    await expect(removeKey(transport, "")).rejects.toMatchObject({ code: ERR.BAD_REQUEST });
    expect(calls).toHaveLength(0);
  });

  it("4xx は assertHttpOk で throw", async () => {
    const { transport } = makeFakeTransport({ status: 404, json: { message: "Not Found" }, text: "" });
    await expect(removeKey(transport, SAMPLE_KEY.deviceUUID)).rejects.toThrow(/removeKey/);
    await expect(removeKey(transport, SAMPLE_KEY.deviceUUID)).rejects.toThrow(/404/);
  });

  it("transport が関数でない場合は bad_request", async () => {
    await expect(removeKey(/** @type {any} */ ({}), SAMPLE_KEY.deviceUUID)).rejects.toMatchObject({ code: ERR.BAD_REQUEST });
  });
});
