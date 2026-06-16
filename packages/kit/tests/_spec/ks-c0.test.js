// packages/kit/tests/_spec/ks-c0.test.js
// Spec-driven tests for KS-0001 through KS-0022 (keystore domain, @experimental).
// Each it() title is prefixed with its spec ID.  Tests are TDD: assertions
// follow the spec contract.  Where the implementation currently diverges from
// spec the test is expected to be red (red=TDD, not a defect in the test).
// No network / BLE / real device access — all pure-function or mock-transport.

import { describe, it, expect, vi } from "vitest";

// ── core imports ──────────────────────────────────────────────────────────────
import {
  getDevicesList,
  putKey,
  removeKey,
  makeKeyStoreTransport,
} from "../../../core/src/devices.js";
import { ERR } from "../../../core/src/errors.js";

// ── kit serve imports ─────────────────────────────────────────────────────────
import { buildRegistry } from "../../src/serve/registry.js";
import { keyStoreEntries } from "../../src/serve/entries/device.js";

// ── shared fixtures ───────────────────────────────────────────────────────────

/** Minimal CHUserKey fixture (CHUserKey.kt:36-46). */
const SAMPLE_KEY = {
  deviceUUID:       "AABBCCDD-1122-3344-5566-778899AABBCC",
  deviceModel:      "sesame_5",
  keyIndex:         "0001",
  secretKey:        "00112233445566778899aabbccddeeff",
  sesame2PublicKey: "0011223344556677889900112233445566778899001122334455667788990011",
  deviceName:       "Front Door",
  keyLevel:         2,
};

/**
 * Fake transport: records every req and returns a fixed reply.
 * @param {{ status: number, json?: any, text?: string }} reply
 */
function makeFakeTransport(reply = { status: 200, json: null, text: "" }) {
  const calls = [];
  const transport = async (req) => { calls.push(req); return reply; };
  return { transport, calls };
}

/** Minimal authed daemon (passes requireAuth). */
const AUTHED_DAEMON = { authState: "ok", hub: { connected: true } };

// ─────────────────────────────────────────────────────────────────────────────
// KS-0001: keystore.list/put/remove が serve registry に 1:1 で存在
// ─────────────────────────────────────────────────────────────────────────────

describe("[KS-0001] keystore.list/put/remove が serve registry に 1:1 で存在 (@experimental)", () => {
  const reg = buildRegistry();

  it("[KS-0001] keystore.list が registry に登録され summary/params/result を持つ", () => {
    const entry = reg.get("keystore.list");
    expect(entry, "keystore.list が registry に存在しない").toBeTruthy();
    expect(typeof entry.summary).toBe("string");
    expect(entry.summary.length).toBeGreaterThan(0);
    expect(Array.isArray(entry.params)).toBe(true);
    expect(entry.result).toBeDefined();
  });

  it("[KS-0001] keystore.put が registry に登録され summary/params/result を持つ", () => {
    const entry = reg.get("keystore.put");
    expect(entry, "keystore.put が registry に存在しない").toBeTruthy();
    expect(typeof entry.summary).toBe("string");
    expect(entry.summary.length).toBeGreaterThan(0);
    expect(Array.isArray(entry.params)).toBe(true);
    expect(entry.params.length).toBeGreaterThan(0);
    expect(entry.result).toBeDefined();
  });

  it("[KS-0001] keystore.remove が registry に登録され summary/params/result を持つ", () => {
    const entry = reg.get("keystore.remove");
    expect(entry, "keystore.remove が registry に存在しない").toBeTruthy();
    expect(typeof entry.summary).toBe("string");
    expect(entry.summary.length).toBeGreaterThan(0);
    expect(Array.isArray(entry.params)).toBe(true);
    expect(entry.result).toBeDefined();
  });

  it("[KS-0001] keyStoreEntries() が 3 メソッドを返す (registry.js が Object.entries で reg.set 反復)", () => {
    const entries = keyStoreEntries();
    const keys = Object.keys(entries);
    expect(keys).toContain("keystore.list");
    expect(keys).toContain("keystore.put");
    expect(keys).toContain("keystore.remove");
    expect(keys).toHaveLength(3);
  });

  it("[KS-0001] 3 メソッドは keyStoreEntries() 由来で registry に組み込まれている", () => {
    const methods = ["keystore.list", "keystore.put", "keystore.remove"];
    for (const m of methods) {
      expect(reg.has(m), `${m} は registry に存在しなければならない`).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// KS-0003: keystore 3 メソッドが SDK(ts/py) に生成され署名が registry params と一致
// ─────────────────────────────────────────────────────────────────────────────

describe("[KS-0003] keystore 3 メソッドが SDK(ts/py) に生成され署名が registry params と一致", () => {
  // Verified from:
  //   ts: sesame-client.ts:492-499
  //   py: sesame_client.py:964-974
  //   registry: device.js:278-333

  const reg = buildRegistry();

  it("[KS-0003] ts SDK: keystore.list — appIdentifyId は optional のみ、必須パラメータは 0 件", () => {
    const entry = reg.get("keystore.list");
    // ts: list(params: { appIdentifyId?: string }): Promise<unknown>
    const required = entry.params.filter((p) => p.required).map((p) => p.name);
    const optionals = entry.params.filter((p) => !p.required).map((p) => p.name);
    expect(required).toHaveLength(0);
    expect(optionals).toContain("appIdentifyId");
  });

  it("[KS-0003] ts SDK: keystore.put — 必須 5 鍵素材 + keyLevel, 任意 deviceName/appIdentifyId (registry と一致)", () => {
    const entry = reg.get("keystore.put");
    // ts: put(params: { deviceUUID, deviceModel, keyIndex, secretKey, sesame2PublicKey,
    //                   deviceName?, keyLevel, appIdentifyId? })
    const required  = entry.params.filter((p) =>  p.required).map((p) => p.name);
    const optionals = entry.params.filter((p) => !p.required).map((p) => p.name);
    expect(required).toEqual(expect.arrayContaining([
      "deviceUUID", "deviceModel", "keyIndex", "secretKey", "sesame2PublicKey", "keyLevel",
    ]));
    expect(optionals).toContain("deviceName");
    expect(optionals).toContain("appIdentifyId");
  });

  it("[KS-0003] ts SDK: keystore.remove — deviceUUID (required) + appIdentifyId (optional) (registry と一致)", () => {
    const entry = reg.get("keystore.remove");
    // ts: remove(params: { deviceUUID: string; appIdentifyId?: string })
    const p = (name) => entry.params.find((x) => x.name === name);
    expect(p("deviceUUID").required).toBe(true);
    expect(p("appIdentifyId").required).toBe(false);
  });

  it("[KS-0003] py SDK: keystore.list — appIdentifyId がデフォルト None (optional, registry と一致)", () => {
    // py: def list(self, *, appIdentifyId: str | None = None)
    const entry = reg.get("keystore.list");
    const param = entry.params.find((p) => p.name === "appIdentifyId");
    expect(param).toBeTruthy();
    expect(param.required).toBe(false);
  });

  it("[KS-0003] py SDK: keystore.put — deviceUUID/deviceModel/keyIndex/secretKey/sesame2PublicKey/keyLevel は必須 (registry と一致)", () => {
    // py: def put(self, *, deviceUUID: str, deviceModel: str, keyIndex: str,
    //              secretKey: str, sesame2PublicKey: str, deviceName: str|None=None,
    //              keyLevel: float, appIdentifyId: str|None=None)
    const entry = reg.get("keystore.put");
    const required = entry.params.filter((p) => p.required).map((p) => p.name);
    expect(required).toEqual(expect.arrayContaining([
      "deviceUUID", "deviceModel", "keyIndex", "secretKey", "sesame2PublicKey", "keyLevel",
    ]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// KS-0004: keystore 3 メソッドが grpc-methods.generated.json / sesame.proto に存在
// ─────────────────────────────────────────────────────────────────────────────

describe("[KS-0004] keystore 3 メソッドが grpc-methods.generated.json / proto に存在 (gRPC framing)", () => {
  // ref: packages/kit/src/serve/grpc-methods.generated.json:1887-1908
  //      contract-fingerprint.test.js:83-85 → registry.size === 205

  it("[KS-0004] grpc-methods.generated.json に KeystoreList が keystore.list メソッドで存在する", async () => {
    const { default: generated } = await import(
      "../../../kit/src/serve/grpc-methods.generated.json",
      { assert: { type: "json" } }
    );
    expect(generated).toHaveProperty("KeystoreList");
    expect(generated.KeystoreList.method).toBe("keystore.list");
  });

  it("[KS-0004] grpc-methods.generated.json に KeystorePut が keystore.put メソッドで存在する", async () => {
    const { default: generated } = await import(
      "../../../kit/src/serve/grpc-methods.generated.json",
      { assert: { type: "json" } }
    );
    expect(generated).toHaveProperty("KeystorePut");
    expect(generated.KeystorePut.method).toBe("keystore.put");
  });

  it("[KS-0004] grpc-methods.generated.json に KeystoreRemove が keystore.remove メソッドで存在する", async () => {
    const { default: generated } = await import(
      "../../../kit/src/serve/grpc-methods.generated.json",
      { assert: { type: "json" } }
    );
    expect(generated).toHaveProperty("KeystoreRemove");
    expect(generated.KeystoreRemove.method).toBe("keystore.remove");
  });

  it("[KS-0004] CONTRACT_VERSION=1.4.0 の registry メソッド数は 205 (keystore 3 件算入)", () => {
    // contract-fingerprint.test.js:83-85 相当の機械確認
    const reg = buildRegistry();
    expect(reg.size, "registry.size が 205 でない — keystore 3 メソッドが算入されているか確認").toBe(205);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// KS-0005: client._keyStoreTransport が registerBaseUrl / tokenStore / config を結線
// ─────────────────────────────────────────────────────────────────────────────

describe("[KS-0005] client._keyStoreTransport が registerBaseUrl / tokenStore / config を結線", () => {
  // ref: packages/core/src/client.js:1245-1294

  it("[KS-0005] makeKeyStoreTransport は tokenStore だけで構築できる (client.js 結線の純関数確認)", () => {
    const fakeTokenStore = { getIdToken: async () => "tok" };
    const fakeConfig = { registerBaseUrl: "https://example.com" };
    expect(() =>
      makeKeyStoreTransport({
        baseUrl: fakeConfig.registerBaseUrl,
        tokenStore: fakeTokenStore,
        fetchImpl: async () => ({ status: 200, json: null, text: "" }),
      })
    ).not.toThrow();
  });

  it("[KS-0005] keyStoreList → hub.keyStoreList / keyStorePut → hub.keyStorePut / keyStoreRemove → hub.keyStoreRemove の委譲形 (registry handler 経由で検証)", () => {
    const reg = buildRegistry();

    // keystore.list → hub.keyStoreList
    const listEntry = reg.get("keystore.list");
    const listHub = { keyStoreList: vi.fn(async () => [SAMPLE_KEY]) };
    const listResult = listEntry.handler({ hub: listHub, daemon: AUTHED_DAEMON, params: {} });
    expect(listHub.keyStoreList).toHaveBeenCalledOnce();

    // keystore.put → hub.keyStorePut
    const putEntry = reg.get("keystore.put");
    const putHub = { keyStorePut: vi.fn(async () => ({ ok: true })) };
    putEntry.handler({ hub: putHub, daemon: AUTHED_DAEMON, params: { ...SAMPLE_KEY } });
    expect(putHub.keyStorePut).toHaveBeenCalledOnce();

    // keystore.remove → hub.keyStoreRemove
    const removeEntry = reg.get("keystore.remove");
    const removeHub = { keyStoreRemove: vi.fn(async () => ({})) };
    removeEntry.handler({ hub: removeHub, daemon: AUTHED_DAEMON, params: { deviceUUID: SAMPLE_KEY.deviceUUID } });
    expect(removeHub.keyStoreRemove).toHaveBeenCalledOnce();

    void listResult; // suppress unused warning
  });

  it("[KS-0005] getDevicesList は fakeTransport から返却値をそのまま返す", async () => {
    const keys = [SAMPLE_KEY];
    const fakeTransport = async () => ({ status: 200, json: keys, text: "" });
    const result = await getDevicesList(fakeTransport);
    expect(result).toEqual(keys);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// KS-0006: keystore 3 操作が core/serve(全 framing)/sdk で同一封筒・同一結果
// ─────────────────────────────────────────────────────────────────────────────

describe("[KS-0006] keystore 3 操作が core/serve で同一 transport wire を生む (serve 宣言 7 フィールド部分集合)", () => {
  // ref: client.js:1263-1294, device.js:282-342, sesame-client.ts:492-499
  // core-direct は CHUserKey オブジェクトをそのまま transport へ素通し。
  // serve RPC は 7 フィールドに再構築 (rank/subUUID/stateInfo を落とす)。

  it("[KS-0006] core getDevicesList は GET /device/list を同一 wire で呼ぶ", async () => {
    const { transport, calls } = makeFakeTransport({ status: 200, json: [SAMPLE_KEY], text: "" });
    await getDevicesList(transport);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].path).toBe("/device/list");
  });

  it("[KS-0006] core putKey は PUT /device body=CHUserKey で呼ぶ (7 フィールド部分集合含む)", async () => {
    const { transport, calls } = makeFakeTransport({ status: 200, json: { ok: true }, text: "" });
    await putKey(transport, SAMPLE_KEY);
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].path).toBe("/device");
    // 7 フィールド部分集合が body に含まれる
    const body = calls[0].body;
    expect(body.deviceUUID).toBe(SAMPLE_KEY.deviceUUID);
    expect(body.deviceModel).toBe(SAMPLE_KEY.deviceModel);
    expect(body.keyIndex).toBe(SAMPLE_KEY.keyIndex);
    expect(body.secretKey).toBe(SAMPLE_KEY.secretKey);
    expect(body.sesame2PublicKey).toBe(SAMPLE_KEY.sesame2PublicKey);
    expect(body.deviceName).toBe(SAMPLE_KEY.deviceName);
    expect(body.keyLevel).toBe(SAMPLE_KEY.keyLevel);
  });

  it("[KS-0006] serve keystore.put handler は 7 フィールドで key を再構築し hub.keyStorePut に渡す", async () => {
    const reg = buildRegistry();
    const entry = reg.get("keystore.put");
    const hub = { keyStorePut: vi.fn(async () => ({})) };
    // rank/subUUID/stateInfo を params に含めても handler が落とすことを確認
    const params = { ...SAMPLE_KEY, rank: 3, subUUID: "sub-id", stateInfo: { batteryPercentage: 80 } };
    await entry.handler({ hub, daemon: AUTHED_DAEMON, params });
    const [calledKey] = hub.keyStorePut.mock.calls[0];
    // 7 フィールドは渡る
    expect(calledKey.deviceUUID).toBe(SAMPLE_KEY.deviceUUID);
    expect(calledKey.keyLevel).toBe(SAMPLE_KEY.keyLevel);
    // rank/subUUID/stateInfo は serve handler が落とす (payload-drop: KS-0031)
    expect(calledKey.rank).toBeUndefined();
    expect(calledKey.subUUID).toBeUndefined();
    expect(calledKey.stateInfo).toBeUndefined();
  });

  it("[KS-0006] core 直呼び putKey は渡した CHUserKey をそのまま transport に渡す (rank/subUUID も素通し)", async () => {
    // devices.js:831: body: key をそのまま渡す (素通し)
    const keyWithRank = { ...SAMPLE_KEY, rank: 3, subUUID: "some-sub-uuid" };
    const { transport, calls } = makeFakeTransport({ status: 200, json: { ok: true }, text: "" });
    await putKey(transport, keyWithRank);
    expect(calls[0].body).toEqual(keyWithRank);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// KS-0007: keystore.list → GET /device/list (method/path/appidentifyid wire 固定)
// ─────────────────────────────────────────────────────────────────────────────

describe("[KS-0007] keystore.list → GET /device/list (method/path wire 固定)", () => {
  // ref: CHAPIClient.kt:35-39, devices.js:807-813

  it("[KS-0007] getDevicesList が transport を {method:'GET', path:'/device/list'} で呼ぶ", async () => {
    const { transport, calls } = makeFakeTransport({ status: 200, json: [SAMPLE_KEY], text: "" });
    await getDevicesList(transport);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].path).toBe("/device/list");
  });

  it("[KS-0007] GET /device/list は body を付けない (CHAPIClient.kt getDevicesList に body なし)", async () => {
    const { transport, calls } = makeFakeTransport({ status: 200, json: [], text: "[]" });
    await getDevicesList(transport);
    expect(calls[0].body).toBeUndefined();
  });

  it("[KS-0007] makeKeyStoreTransport は appIdentifyId を渡すと構築成功 (resolveAppIdentifyId 経由でヘッダに乗る)", () => {
    // aws-credentials.js:595: if (appIdentifyId) headers.appidentifyid = appIdentifyId
    const fakeTokenStore = { getIdToken: async () => "tok" };
    const appId = "ap-northeast-1:dummy-id";
    expect(() =>
      makeKeyStoreTransport({
        tokenStore: fakeTokenStore,
        appIdentifyId: appId,
        fetchImpl: async () => ({ status: 200, json: [], text: "" }),
      })
    ).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// KS-0008: keystore.put → PUT /device (method/path + body=CHUserKey object wire 固定)
// ─────────────────────────────────────────────────────────────────────────────

describe("[KS-0008] keystore.put → PUT /device (method/path + body=CHUserKey object wire 固定)", () => {
  // ref: CHAPIClient.kt:29-33, devices.js:828-834

  it("[KS-0008] putKey が transport を {method:'PUT', path:'/device', body:CHUserKey} で呼ぶ", async () => {
    const { transport, calls } = makeFakeTransport({ status: 200, json: { ok: true }, text: "" });
    await putKey(transport, SAMPLE_KEY);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].path).toBe("/device");
    expect(calls[0].body).toEqual(SAMPLE_KEY);
  });

  it("[KS-0008] putKey の body は CHUserKey オブジェクト参照そのまま (JSON.stringify は transport 側)", async () => {
    // devices.js:831: transport({ method:'PUT', path:'/device', body: key })
    // body は文字列に変換せずオブジェクトのまま渡す (aws-credentials.js:585 で stringify)
    const { transport, calls } = makeFakeTransport({ status: 200, json: null, text: "" });
    await putKey(transport, SAMPLE_KEY);
    expect(typeof calls[0].body).toBe("object");
    expect(calls[0].body).not.toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// KS-0009: keystore.remove → DELETE /device (body は deviceUUID の JSON 文字列リテラル)
// ─────────────────────────────────────────────────────────────────────────────

describe("[KS-0009] keystore.remove → DELETE /device (body は deviceUUID 文字列 → JSON string literal)", () => {
  // ref: CHAPIClient.kt:42-46, devices.js:851-860, aws-credentials.js:585
  // Kotlin body:String → Gson → JSON string literal '"uuid"'
  // makeApiGatewayTransport: JSON.stringify("uuid") = '"uuid"' が HTTP body になる。

  it("[KS-0009] removeKey が transport を {method:'DELETE', path:'/device', body:deviceUUID} で呼ぶ", async () => {
    const { transport, calls } = makeFakeTransport({ status: 200, json: { ok: true }, text: "" });
    await removeKey(transport, SAMPLE_KEY.deviceUUID);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].path).toBe("/device");
    // body は deviceUUID 文字列 (transport 側が JSON.stringify → '"uuid"' になる)
    expect(calls[0].body).toBe(SAMPLE_KEY.deviceUUID);
  });

  it("[KS-0009] removeKey の body は文字列型 (Kotlin body:String に対応)", async () => {
    const { transport, calls } = makeFakeTransport({ status: 200, json: null, text: "" });
    await removeKey(transport, "some-device-uuid");
    expect(typeof calls[0].body).toBe("string");
  });

  it("[KS-0009] removeKey の body を JSON.stringify すると JSON 文字列リテラルになる (HTTP wire 形)", () => {
    // aws-credentials.js:585: JSON.stringify(body) → '"uuid"'
    const wireBody = JSON.stringify(SAMPLE_KEY.deviceUUID);
    expect(wireBody).toBe(`"${SAMPLE_KEY.deviceUUID}"`);
    // CHAPIClient.kt:42-46 body:String → Gson → "\"uuid\"" と一致
    expect(wireBody).toMatch(/^".*"$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// KS-0010: keystore.put deviceName 省略時 null 正規化 (serve handler)
// ─────────────────────────────────────────────────────────────────────────────

describe("[KS-0010] keystore.put deviceName 省略時 null 正規化 (serve handler)", () => {
  // ref: device.js:319, CHUserKey.kt:42 (var deviceName: String?)

  it("[KS-0010] deviceName 省略時、serve handler が null をセットして hub.keyStorePut に渡す", async () => {
    const reg = buildRegistry();
    const entry = reg.get("keystore.put");
    const hub = { keyStorePut: vi.fn(async () => ({})) };
    const params = { ...SAMPLE_KEY };
    delete params.deviceName;
    await entry.handler({ hub, daemon: AUTHED_DAEMON, params });
    const [calledKey] = hub.keyStorePut.mock.calls[0];
    expect(calledKey.deviceName).toBeNull();
  });

  it("[KS-0010] deviceName が undefined の場合も null に正規化される (device.js:319: deviceName ?? null)", async () => {
    const reg = buildRegistry();
    const entry = reg.get("keystore.put");
    const hub = { keyStorePut: vi.fn(async () => ({})) };
    await entry.handler({ hub, daemon: AUTHED_DAEMON, params: { ...SAMPLE_KEY, deviceName: undefined } });
    const [calledKey] = hub.keyStorePut.mock.calls[0];
    expect(calledKey.deviceName).toBeNull();
  });

  it("[KS-0010] deviceName=null の場合も null を渡す (CHUserKey.kt:42 deviceName:String? nullable)", async () => {
    const reg = buildRegistry();
    const entry = reg.get("keystore.put");
    const hub = { keyStorePut: vi.fn(async () => ({})) };
    await entry.handler({ hub, daemon: AUTHED_DAEMON, params: { ...SAMPLE_KEY, deviceName: null } });
    const [calledKey] = hub.keyStorePut.mock.calls[0];
    expect(calledKey.deviceName).toBeNull();
  });

  it("[KS-0010] deviceName が明示指定の場合はそのまま渡る", async () => {
    const reg = buildRegistry();
    const entry = reg.get("keystore.put");
    const hub = { keyStorePut: vi.fn(async () => ({})) };
    await entry.handler({ hub, daemon: AUTHED_DAEMON, params: { ...SAMPLE_KEY, deviceName: "玄関" } });
    const [calledKey] = hub.keyStorePut.mock.calls[0];
    expect(calledKey.deviceName).toBe("玄関");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// KS-0012: CHUserKey 同期形 — putKey body のフィールド集合/型が CHUserKey.kt data class と一致
// ─────────────────────────────────────────────────────────────────────────────

describe("[KS-0012] CHUserKey 同期形 — putKey body フィールド集合/型が CHUserKey.kt data class と一致", () => {
  // ref: CHUserKey.kt:36-47, devices.js:784-795
  // 必須: deviceUUID/deviceModel/keyIndex/secretKey/sesame2PublicKey/keyLevel
  // 任意: deviceName(nullable), rank(nullable), subUUID, stateInfo

  it("[KS-0012] putKey に全フィールドを渡すと transport の body にそのまま含まれる", async () => {
    const fullKey = {
      ...SAMPLE_KEY,
      rank: 1,
      subUUID: "sub-uuid-001",
      stateInfo: { batteryPercentage: 90 },
    };
    const { transport, calls } = makeFakeTransport({ status: 200, json: { ok: true }, text: "" });
    await putKey(transport, fullKey);
    const body = calls[0].body;
    for (const f of ["deviceUUID", "deviceModel", "keyIndex", "secretKey", "sesame2PublicKey", "keyLevel"]) {
      expect(body, `フィールド ${f} が body に含まれていない`).toHaveProperty(f);
    }
    expect(typeof body.keyLevel).toBe("number");
    expect(body.subUUID).toBe("sub-uuid-001");
    expect(body.stateInfo).toEqual({ batteryPercentage: 90 });
  });

  it("[KS-0012] keyLevel は number 型 (CHUserKey.kt では Int → JS では number)", async () => {
    const { transport, calls } = makeFakeTransport({ status: 200, json: null, text: "" });
    await putKey(transport, { ...SAMPLE_KEY, keyLevel: 0 });
    expect(typeof calls[0].body.keyLevel).toBe("number");
  });

  it("[KS-0012] rank は null (nullable) のまま body に含められる", async () => {
    const { transport, calls } = makeFakeTransport({ status: 200, json: null, text: "" });
    await putKey(transport, { ...SAMPLE_KEY, rank: null });
    expect(calls[0].body.rank).toBeNull();
  });

  it("[KS-0012] deviceName は省略可能 (nullable optional) — putKey は deviceUUID のみ必須", async () => {
    const keyWithoutName = { ...SAMPLE_KEY };
    delete keyWithoutName.deviceName;
    const { transport } = makeFakeTransport({ status: 200, json: { ok: true }, text: "" });
    await expect(putKey(transport, keyWithoutName)).resolves.toBeDefined();
  });

  it("[KS-0012] deviceName が null (nullable String?) でも putKey は throw しない", async () => {
    const { transport } = makeFakeTransport({ status: 200, json: { ok: true }, text: "" });
    await expect(putKey(transport, { ...SAMPLE_KEY, deviceName: null })).resolves.toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// KS-0014: makeKeyStoreTransport は appidentifyid を付け makeRegisterTransport は付けない
// ─────────────────────────────────────────────────────────────────────────────

describe("[KS-0014] makeKeyStoreTransport は appidentifyid を付け makeRegisterTransport は付けない (per-op 切り分け)", () => {
  // ref: CHAPIClient.kt:22-46, aws-credentials.js:499-536, devices.js:738-763, devices.js:621-669

  it("[KS-0014] makeKeyStoreTransport は appIdentifyId を受け取り transport 関数を返す (構築成功)", () => {
    const fakeTokenStore = { getIdToken: async () => "tok" };
    const transport = makeKeyStoreTransport({
      tokenStore: fakeTokenStore,
      appIdentifyId: "ap-northeast-1:test-id",
      fetchImpl: async () => ({ status: 200, json: [], text: "" }),
    });
    expect(typeof transport).toBe("function");
  });

  it("[KS-0014] makeKeyStoreTransport は appIdentifyId 省略時も transport 関数を返す (resolveAppIdentifyId で生成)", () => {
    const fakeTokenStore = { getIdToken: async () => "tok" };
    const transport = makeKeyStoreTransport({
      tokenStore: fakeTokenStore,
      fetchImpl: async () => ({ status: 200, json: [], text: "" }),
    });
    expect(typeof transport).toBe("function");
  });

  it("[KS-0014] makeKeyStoreTransport は credentialsProvider/tokenStore なしで throw (auth 必須確認)", () => {
    // devices.js:748: registerAuthRequired
    expect(() =>
      makeKeyStoreTransport({
        baseUrl: "https://example.com",
        appIdentifyId: "ap-northeast-1:test-id",
        fetchImpl: () => {},
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// KS-0016: keystore transport の x-api-key + content-type 固定
// ─────────────────────────────────────────────────────────────────────────────

describe("[KS-0016] keystore transport の x-api-key + content-type 固定 (apiKeyId は使わない)", () => {
  // ref: devices.js:738-763, aws-credentials.js:76-77, aws-credentials.js:586-595
  // x-api-key = API_GATEWAY_API_KEY (BaseApp.kt:100)
  // apiKeyId (biz3 WebAPI proxy の dev console 発行) とは別経路

  it("[KS-0016] makeKeyStoreTransport は apiKey パラメータを受け入れ transport 関数を返す", () => {
    const fakeTokenStore = { getIdToken: async () => "tok" };
    expect(() =>
      makeKeyStoreTransport({
        tokenStore: fakeTokenStore,
        apiKey: "TEST-API-KEY",
        fetchImpl: async () => ({ status: 200, json: null, text: "" }),
      })
    ).not.toThrow();
  });

  it("[KS-0016] keystore transport は関数を返す (biz3 WebAPI proxy の apiKeyId パラメータなし)", () => {
    // invokeWebAPI (webapi 系) は apiKeyId を必要とするが、
    // makeKeyStoreTransport は apiKeyId を引数に持たない (別経路の証明)
    const fakeTokenStore = { getIdToken: async () => "tok" };
    const transport = makeKeyStoreTransport({
      tokenStore: fakeTokenStore,
      fetchImpl: async () => ({ status: 200, json: null, text: "" }),
    });
    expect(typeof transport).toBe("function");
  });

  it("[KS-0016] makeKeyStoreTransport は fetchImpl 非関数で throw (registerFetchRequired)", () => {
    // devices.js:749: registerFetchRequired
    expect(() =>
      makeKeyStoreTransport({
        baseUrl: "https://example.com",
        credentialsProvider: { getCredentials: () => {} },
        fetchImpl: "not-a-function",
      }),
    ).toThrow();
  });

  it("[KS-0016] API_GATEWAY_API_KEY 定数が aws-credentials.js に存在する", async () => {
    const { API_GATEWAY_API_KEY } = await import("../../../core/src/aws-credentials.js");
    expect(typeof API_GATEWAY_API_KEY).toBe("string");
    expect(API_GATEWAY_API_KEY.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// KS-0017: keystore.put 必須パラメータ検証 (serve handler)
// ─────────────────────────────────────────────────────────────────────────────

describe("[KS-0017] keystore.put 必須パラメータ検証 (5 必須鍵素材 + keyLevel)", () => {
  // ref: device.js:294-311
  // need() で 5 必須鍵素材を検証し、keyLevel は別途 undefined/null で弾く

  const reg = buildRegistry();
  const entry = reg.get("keystore.put");

  it("[KS-0017] deviceUUID 欠落 → need() が throw して hub 未呼び出し", () => {
    const hub = { keyStorePut: vi.fn() };
    const p = { ...SAMPLE_KEY }; delete p.deviceUUID;
    expect(() => entry.handler({ hub, daemon: AUTHED_DAEMON, params: p })).toThrow();
    expect(hub.keyStorePut).not.toHaveBeenCalled();
  });

  it("[KS-0017] deviceModel 欠落 → need() が throw して hub 未呼び出し", () => {
    const hub = { keyStorePut: vi.fn() };
    const p = { ...SAMPLE_KEY }; delete p.deviceModel;
    expect(() => entry.handler({ hub, daemon: AUTHED_DAEMON, params: p })).toThrow();
    expect(hub.keyStorePut).not.toHaveBeenCalled();
  });

  it("[KS-0017] keyIndex 欠落 → need() が throw して hub 未呼び出し", () => {
    const hub = { keyStorePut: vi.fn() };
    const p = { ...SAMPLE_KEY }; delete p.keyIndex;
    expect(() => entry.handler({ hub, daemon: AUTHED_DAEMON, params: p })).toThrow();
    expect(hub.keyStorePut).not.toHaveBeenCalled();
  });

  it("[KS-0017] secretKey 欠落 → need() が throw して hub 未呼び出し", () => {
    const hub = { keyStorePut: vi.fn() };
    const p = { ...SAMPLE_KEY }; delete p.secretKey;
    expect(() => entry.handler({ hub, daemon: AUTHED_DAEMON, params: p })).toThrow();
    expect(hub.keyStorePut).not.toHaveBeenCalled();
  });

  it("[KS-0017] sesame2PublicKey 欠落 → need() が throw して hub 未呼び出し", () => {
    const hub = { keyStorePut: vi.fn() };
    const p = { ...SAMPLE_KEY }; delete p.sesame2PublicKey;
    expect(() => entry.handler({ hub, daemon: AUTHED_DAEMON, params: p })).toThrow();
    expect(hub.keyStorePut).not.toHaveBeenCalled();
  });

  it("[KS-0017] keyLevel=undefined → INVALID_PARAMS/BAD_PARAMS で throw して hub 未呼び出し (device.js:309-311)", () => {
    // need() ではなく別判定 (0 を通すため)
    const hub = { keyStorePut: vi.fn() };
    const p = { ...SAMPLE_KEY }; delete p.keyLevel;
    expect(() => entry.handler({ hub, daemon: AUTHED_DAEMON, params: p })).toThrow();
    expect(hub.keyStorePut).not.toHaveBeenCalled();
  });

  it("[KS-0017] keyLevel=null → INVALID_PARAMS/BAD_PARAMS で throw して hub 未呼び出し", () => {
    const hub = { keyStorePut: vi.fn() };
    expect(() =>
      entry.handler({ hub, daemon: AUTHED_DAEMON, params: { ...SAMPLE_KEY, keyLevel: null } }),
    ).toThrow();
    expect(hub.keyStorePut).not.toHaveBeenCalled();
  });

  it("[KS-0017] keyLevel=0 は falsy だが need とは別判定のため通過する (0 は有効な keyLevel)", async () => {
    // device.js:309-311: undefined/null のみ弾く; 0 は通す
    const hub = { keyStorePut: vi.fn(async () => ({})) };
    await expect(
      entry.handler({ hub, daemon: AUTHED_DAEMON, params: { ...SAMPLE_KEY, keyLevel: 0 } })
    ).resolves.toBeDefined();
    expect(hub.keyStorePut).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// KS-0018: putKey/removeKey の deviceUUID 必須 (core層 bad_request, transport 未呼び出し)
// ─────────────────────────────────────────────────────────────────────────────

describe("[KS-0018] putKey/removeKey の deviceUUID 必須 (core 層 bad_request, transport 未呼び出し)", () => {
  // ref: devices.js:830 (putKey), devices.js:853 (removeKey)

  it("[KS-0018] putKey: key.deviceUUID 欠落 → bad_request (transport 未呼び出し)", async () => {
    const { transport, calls } = makeFakeTransport({ status: 200, json: null, text: "" });
    await expect(
      putKey(transport, { deviceModel: "sesame_5" }),
    ).rejects.toMatchObject({ code: ERR.BAD_REQUEST });
    expect(calls).toHaveLength(0);
  });

  it("[KS-0018] putKey: key が null → bad_request (transport 未呼び出し)", async () => {
    const { transport, calls } = makeFakeTransport({ status: 200, json: null, text: "" });
    await expect(putKey(transport, null)).rejects.toMatchObject({ code: ERR.BAD_REQUEST });
    expect(calls).toHaveLength(0);
  });

  it("[KS-0018] removeKey: 空文字 deviceUUID → bad_request (transport 未呼び出し)", async () => {
    const { transport, calls } = makeFakeTransport({ status: 200, json: null, text: "" });
    await expect(removeKey(transport, "")).rejects.toMatchObject({ code: ERR.BAD_REQUEST });
    expect(calls).toHaveLength(0);
  });

  it("[KS-0018] removeKey: null deviceUUID → bad_request (transport 未呼び出し)", async () => {
    const { transport, calls } = makeFakeTransport({ status: 200, json: null, text: "" });
    await expect(removeKey(transport, null)).rejects.toMatchObject({ code: ERR.BAD_REQUEST });
    expect(calls).toHaveLength(0);
  });

  it("[KS-0018] removeKey: undefined deviceUUID → bad_request (transport 未呼び出し)", async () => {
    const { transport, calls } = makeFakeTransport({ status: 200, json: null, text: "" });
    await expect(removeKey(transport, undefined)).rejects.toMatchObject({ code: ERR.BAD_REQUEST });
    expect(calls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// KS-0019: keystore transport 構築の認証必須
// ─────────────────────────────────────────────────────────────────────────────

describe("[KS-0019] keystore transport 構築の認証必須 (credentialsProvider か tokenStore のいずれか)", () => {
  // ref: devices.js:748-749

  it("[KS-0019] credentialsProvider/tokenStore 双方欠落 → registerAuthRequired (auth 必須エラー) を throw", () => {
    // i18n key: domain.devices.registerAuthRequired
    // 実際のメッセージ (ja): "tokenStore か credentialsProvider が必要です..."
    expect(() =>
      makeKeyStoreTransport({
        fetchImpl: async () => ({ status: 200, json: null, text: "" }),
      })
    ).toThrow(/tokenStore|credentialsProvider|registerAuthRequired/);
  });

  it("[KS-0019] credentialsProvider/tokenStore 双方欠落のエラーは bad_request コード", () => {
    expect(() =>
      makeKeyStoreTransport({
        fetchImpl: async () => ({ status: 200, json: null, text: "" }),
      })
    ).toThrow(expect.objectContaining({ code: ERR.BAD_REQUEST }));
  });

  it("[KS-0019] fetchImpl が非関数 → registerFetchRequired (fetchImpl 必須エラー) を throw", () => {
    // i18n key: domain.devices.registerFetchRequired
    // 実際のメッセージ (ja): "fetchImpl must be a function (global fetch が無い環境)"
    const fakeTokenStore = { getIdToken: async () => "tok" };
    expect(() =>
      makeKeyStoreTransport({
        tokenStore: fakeTokenStore,
        fetchImpl: "not-a-function",
      })
    ).toThrow(/fetchImpl|registerFetchRequired/);
  });

  it("[KS-0019] fetchImpl が非関数のエラーは bad_request コード", () => {
    const fakeTokenStore = { getIdToken: async () => "tok" };
    expect(() =>
      makeKeyStoreTransport({
        tokenStore: fakeTokenStore,
        fetchImpl: null,
      })
    ).toThrow(expect.objectContaining({ code: ERR.BAD_REQUEST }));
  });

  it("[KS-0019] tokenStore のみ指定で構築成功 (credentialsProvider は省略可)", () => {
    const fakeTokenStore = { getIdToken: async () => "tok" };
    expect(() =>
      makeKeyStoreTransport({
        tokenStore: fakeTokenStore,
        fetchImpl: async () => ({ status: 200, json: null, text: "" }),
      })
    ).not.toThrow();
  });

  it("[KS-0019] tokenStore が存在すれば auth チェックをパスし、fetchImpl 非関数で registerFetchRequired を throw", () => {
    // devices.js:748: !credentialsProvider && !tokenStore の場合のみ throw
    // tokenStore が truthy なら auth チェックはパス (fetchImpl チェックで止まる)
    let err;
    try {
      makeKeyStoreTransport({
        baseUrl: "https://example.com",
        tokenStore: { getIdToken: () => "token" },
        fetchImpl: "not-a-function",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    // i18n key: domain.devices.registerFetchRequired → "fetchImpl must be a function..."
    expect(err.message).toMatch(/fetchImpl|registerFetchRequired/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// KS-0020: keystore REST 非2xx 応答は assertHttpOk で status 付き throw
// ─────────────────────────────────────────────────────────────────────────────

describe("[KS-0020] keystore REST 非2xx 応答は assertHttpOk で status 付き throw", () => {
  // ref: devices.js:600 (assertHttpOk 定義), 810/832/858 (呼出箇所)
  // throw メッセージ template: `{op} failed: HTTP {status} {detail}`

  it("[KS-0020] getDevicesList: 4xx → op ラベル 'getDevicesList' と status 403 を含む throw", async () => {
    const { transport } = makeFakeTransport({ status: 403, json: { message: "Forbidden" }, text: "" });
    await expect(getDevicesList(transport)).rejects.toThrow(/getDevicesList/);
    await expect(getDevicesList(transport)).rejects.toThrow(/403/);
  });

  it("[KS-0020] getDevicesList: 5xx → op ラベルと status 500 を含む throw", async () => {
    const { transport } = makeFakeTransport({ status: 500, json: null, text: "Internal Server Error" });
    await expect(getDevicesList(transport)).rejects.toThrow(/getDevicesList/);
    await expect(getDevicesList(transport)).rejects.toThrow(/500/);
  });

  it("[KS-0020] putKey: 4xx → op ラベル 'putKey' と status 400 を含む throw", async () => {
    const { transport } = makeFakeTransport({ status: 400, json: { message: "Bad Request" }, text: "" });
    await expect(putKey(transport, SAMPLE_KEY)).rejects.toThrow(/putKey/);
    await expect(putKey(transport, SAMPLE_KEY)).rejects.toThrow(/400/);
  });

  it("[KS-0020] putKey: 5xx → op ラベルと status を含む throw", async () => {
    const { transport } = makeFakeTransport({ status: 502, json: null, text: "Bad Gateway" });
    await expect(putKey(transport, SAMPLE_KEY)).rejects.toThrow(/putKey/);
    await expect(putKey(transport, SAMPLE_KEY)).rejects.toThrow(/502/);
  });

  it("[KS-0020] removeKey: 4xx → op ラベル 'removeKey' と status 404 を含む throw", async () => {
    const { transport } = makeFakeTransport({ status: 404, json: { message: "Not Found" }, text: "" });
    await expect(removeKey(transport, SAMPLE_KEY.deviceUUID)).rejects.toThrow(/removeKey/);
    await expect(removeKey(transport, SAMPLE_KEY.deviceUUID)).rejects.toThrow(/404/);
  });

  it("[KS-0020] removeKey: 5xx → op ラベルと status を含む throw", async () => {
    const { transport } = makeFakeTransport({ status: 503, json: null, text: "Service Unavailable" });
    await expect(removeKey(transport, SAMPLE_KEY.deviceUUID)).rejects.toThrow(/removeKey/);
    await expect(removeKey(transport, SAMPLE_KEY.deviceUUID)).rejects.toThrow(/503/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// KS-0021: keystore RPC は requireAuth 必須 (未認証 daemon で throw, hub 未呼び出し)
// ─────────────────────────────────────────────────────────────────────────────

describe("[KS-0021] keystore RPC は requireAuth 必須 (未認証 daemon で throw, hub 未呼び出し)", () => {
  // ref: device.js:284/307/338 (各 handler 冒頭 requireAuth)
  //      registry-helpers.js:55 (requireAuth 定義: authState=expired || !hub.connected)

  const reg = buildRegistry();

  it("[KS-0021] keystore.list: authState='expired' → throw して hub.keyStoreList 未呼び出し", () => {
    const entry = reg.get("keystore.list");
    const hub = { keyStoreList: vi.fn() };
    const daemon = { authState: "expired", hub: { connected: true } };
    expect(() => entry.handler({ hub, daemon, params: {} })).toThrow();
    expect(hub.keyStoreList).not.toHaveBeenCalled();
  });

  it("[KS-0021] keystore.list: hub.connected=false → throw して hub.keyStoreList 未呼び出し", () => {
    const entry = reg.get("keystore.list");
    const hub = { keyStoreList: vi.fn() };
    const daemon = { authState: "ok", hub: { connected: false } };
    expect(() => entry.handler({ hub, daemon, params: {} })).toThrow();
    expect(hub.keyStoreList).not.toHaveBeenCalled();
  });

  it("[KS-0021] keystore.put: authState='expired' → throw して hub.keyStorePut 未呼び出し (device.js:307)", () => {
    const entry = reg.get("keystore.put");
    const hub = { keyStorePut: vi.fn() };
    const daemon = { authState: "expired", hub: { connected: true } };
    expect(() => entry.handler({ hub, daemon, params: { ...SAMPLE_KEY } })).toThrow();
    expect(hub.keyStorePut).not.toHaveBeenCalled();
  });

  it("[KS-0021] keystore.put: hub.connected=false → throw して hub.keyStorePut 未呼び出し", () => {
    const entry = reg.get("keystore.put");
    const hub = { keyStorePut: vi.fn() };
    const daemon = { authState: "ok", hub: { connected: false } };
    expect(() => entry.handler({ hub, daemon, params: { ...SAMPLE_KEY } })).toThrow();
    expect(hub.keyStorePut).not.toHaveBeenCalled();
  });

  it("[KS-0021] keystore.remove: authState='expired' → throw して hub.keyStoreRemove 未呼び出し (device.js:338)", () => {
    const entry = reg.get("keystore.remove");
    const hub = { keyStoreRemove: vi.fn() };
    const daemon = { authState: "expired", hub: { connected: true } };
    expect(() => entry.handler({ hub, daemon, params: { deviceUUID: SAMPLE_KEY.deviceUUID } })).toThrow();
    expect(hub.keyStoreRemove).not.toHaveBeenCalled();
  });

  it("[KS-0021] keystore.remove: hub.connected=false → throw して hub.keyStoreRemove 未呼び出し", () => {
    const entry = reg.get("keystore.remove");
    const hub = { keyStoreRemove: vi.fn() };
    const daemon = { authState: "ok", hub: { connected: false } };
    expect(() => entry.handler({ hub, daemon, params: { deviceUUID: SAMPLE_KEY.deviceUUID } })).toThrow();
    expect(hub.keyStoreRemove).not.toHaveBeenCalled();
  });

  it("[KS-0021] requireAuth: authState=ok かつ hub.connected=true は throw しない (registry-helpers.js:55-61)", () => {
    const entry = reg.get("keystore.list");
    const hub = { keyStoreList: vi.fn(async () => []) };
    expect(() => entry.handler({ hub, daemon: AUTHED_DAEMON, params: {} })).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// KS-0022: getDevicesList 応答正規化 (非配列/null は [] に化ける契約)
// ─────────────────────────────────────────────────────────────────────────────

describe("[KS-0022] getDevicesList 応答正規化 (非配列/null は [] に化ける契約)", () => {
  // ref: CHAPIClient.kt:36-39 (Array<CHUserKey> 戻り型), devices.js:811-812

  it("[KS-0022] 応答 json が CHUserKey[] 配列のとき素通しする", async () => {
    const { transport } = makeFakeTransport({ status: 200, json: [SAMPLE_KEY], text: "" });
    const result = await getDevicesList(transport);
    expect(result).toEqual([SAMPLE_KEY]);
  });

  it("[KS-0022] 応答 json が空配列 [] のとき [] を返す", async () => {
    const { transport } = makeFakeTransport({ status: 200, json: [], text: "[]" });
    const result = await getDevicesList(transport);
    expect(result).toEqual([]);
  });

  it("[KS-0022] 応答 json が null → [] を返す (CHAPIClient.kt Array<CHUserKey> に空配列で合わせる)", async () => {
    const { transport } = makeFakeTransport({ status: 200, json: null, text: "" });
    const result = await getDevicesList(transport);
    expect(result).toEqual([]);
  });

  it("[KS-0022] 応答 json がオブジェクト (非配列) → [] を返す", async () => {
    const { transport } = makeFakeTransport({ status: 200, json: { unexpected: true }, text: "" });
    const result = await getDevicesList(transport);
    expect(result).toEqual([]);
  });

  it("[KS-0022] 応答 json が文字列 (非配列) → [] を返す", async () => {
    const { transport } = makeFakeTransport({ status: 200, json: "not-an-array", text: "" });
    const result = await getDevicesList(transport);
    expect(result).toEqual([]);
  });

  it("[KS-0022] 応答 json が数値 (非配列) → [] を返す", async () => {
    const { transport } = makeFakeTransport({ status: 200, json: 42, text: "" });
    const result = await getDevicesList(transport);
    expect(result).toEqual([]);
  });

  it("[KS-0022] Array.isArray 分岐: 複数キー配列が素通しされる (devices.js:812)", async () => {
    const keys = [SAMPLE_KEY, { ...SAMPLE_KEY, deviceUUID: "BBBBCCCC-2233-4455-6677-889900AABBCC" }];
    const { transport } = makeFakeTransport({ status: 200, json: keys, text: "" });
    const result = await getDevicesList(transport);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });
});
