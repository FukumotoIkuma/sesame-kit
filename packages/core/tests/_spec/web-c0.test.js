// packages/core/tests/_spec/web-c0.test.js
// Spec-driven TDD tests for WEB-0001 through WEB-0018 (webapi domain).
//
// Coverage:
//   WEB-0001..0005 : devices.invokeWebAPI wire-fidelity and error-path
//   WEB-0006..0007 : devices.webapiDeviceState wire-fidelity
//   WEB-0008..0009 : devices.webapiDeviceHistory wire-fidelity and option-branch
//   WEB-0010..0011 : devices.webapiSendCmd wire-fidelity
//   WEB-0012..0017 : SesameHub3.invokeWebAPI / webapiDeviceState / webapiDeviceHistory / webapiSendCmd client guards
//   WEB-0018       : serve registry webapiEntries contract-existence + params schema
//
// Strategy:
//   WEB-0001..0011 — fake WS client (request mock) for devices.* pure-function tests
//   WEB-0012..0017 — hub._ws injection (deleteDevice pattern) for SesameHub3.* tests
//   WEB-0018       — webapiEntries() + buildRegistry() for contract-existence checks
//
// No network / BLE / real device. Deterministic.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { setLocale } from "../../src/i18n.js";
import {
  invokeWebAPI,
  webapiDeviceState,
  webapiDeviceHistory,
  webapiSendCmd,
} from "../../src/devices.js";
import { SesameHub3 } from "../../src/client.js";
import { ERR } from "../../src/errors.js";

// Fix locale to en so i18n error messages are deterministic.
beforeEach(() => setLocale("en"));

// ─── constants ────────────────────────────────────────────────────────────────
const ACT_WEBAPI = "biz3InvokeWebAPIs"; // messageConstants.js:18

// ─── shared fake-WS helpers (devices.* pure-function tests) ──────────────────

/**
 * Minimal fake WS client for devices.* functions.
 * request() resolves with the given fixed response.
 * Sent frames are captured in .requests[].
 */
function makeFakeClient(response = { action: ACT_WEBAPI, op: "webapi_test", data: {} }) {
  const requests = [];
  return {
    requests,
    request: vi.fn(async (frame, _timeoutMs) => {
      requests.push(frame);
      return response;
    }),
  };
}

// ─── SesameHub3 (client.js) helpers ──────────────────────────────────────────

/**
 * Build a SesameHub3 with fake _ws injected so _ensureConnected() succeeds.
 * Uses the same pattern as deleteDevice.test.js.
 */
function makeHub({ apiKeyId = undefined } = {}) {
  const ws = {
    requests: [],
    request: vi.fn(async (frame, _timeoutMs) => {
      ws.requests.push(frame);
      return { action: ACT_WEBAPI, op: frame.op ?? "", data: { result: "ok" } };
    }),
    send: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    onMessage: vi.fn(() => () => {}),
  };
  const hub = new SesameHub3({
    config: { companyID: "co-test", ...(apiKeyId ? { apiKeyId } : {}) },
    tokenStore: { load: () => ({}), save: () => {}, clear: () => {} },
  });
  hub._ws = ws;
  hub._subUUID = "sub-uuid-stub";
  return { hub, ws };
}

// ===========================================================================
// WEB-0001: invokeWebAPI フレーム形 — 全フィールド存在 (query+body 両指定)
// ===========================================================================

describe("[WEB-0001] invokeWebAPI フレーム形 {action:biz3InvokeWebAPIs, op:func, apiKeyId, body, query}", () => {
  it("[WEB-0001] query+body 両指定時に action/op/apiKeyId/body/query を全て含むフレームを送る", async () => {
    // ref: devices.js:484-490; messageConstants.js:18; useDeveloper.js:48,54
    const client = makeFakeClient({ action: ACT_WEBAPI, op: "myFunc", data: {} });
    await invokeWebAPI(client, {
      func: "myFunc",
      apiKeyId: "ak-123",
      query: { q: "qval" },
      body: { b: "bval" },
    });
    const frame = client.requests[0];
    expect(frame.action).toBe("biz3InvokeWebAPIs");
    expect(frame.op).toBe("myFunc");
    expect(frame.apiKeyId).toBe("ak-123");
    expect(frame.body).toEqual({ b: "bval" });
    expect(frame.query).toEqual({ q: "qval" });
  });
});

// ===========================================================================
// WEB-0002: body 未指定でも body:{} が常時フレームに存在する
// ===========================================================================

describe("[WEB-0002] invokeWebAPI: body 未指定でも body:{} が常時フレームに存在する", () => {
  it("[WEB-0002] body 省略時にフレームに body:{} が存在する (useDeveloper.js:46 body={} デフォルト相当)", async () => {
    // ref: devices.js:490 (`body: body ?? {}`); useDeveloper.js:46,52
    const client = makeFakeClient({ action: ACT_WEBAPI, op: "webapi_history_get", data: {} });
    await invokeWebAPI(client, { func: "webapi_history_get", apiKeyId: "k" });
    const frame = client.requests[0];
    expect("body" in frame).toBe(true);
    expect(frame.body).toEqual({});
  });

  it("[WEB-0002] body 省略かつ query あり でも body:{} が常時存在する", async () => {
    const client = makeFakeClient({ action: ACT_WEBAPI, op: "webapi_ssm_shadow_get", data: {} });
    await invokeWebAPI(client, { func: "webapi_ssm_shadow_get", apiKeyId: "k", query: { device_id: "d-1" } });
    expect(client.requests[0].body).toEqual({});
  });
});

// ===========================================================================
// WEB-0003: query 未指定時はフレームから query キーが脱落する (条件スプレッド)
// ===========================================================================

describe("[WEB-0003] invokeWebAPI: query 未指定時はフレームから query キーが脱落する (条件スプレッド)", () => {
  it("[WEB-0003] query 省略時はフレームに query キーが存在しない", async () => {
    // ref: devices.js:489 (`...(query !== undefined && { query })`); useDeveloper.js:46,51
    const client = makeFakeClient({ action: ACT_WEBAPI, op: "webapi_cmd_send", data: {} });
    await invokeWebAPI(client, { func: "webapi_cmd_send", apiKeyId: "k", body: { cmd: 82 } });
    expect("query" in client.requests[0]).toBe(false);
  });

  it("[WEB-0003] query も body も省略時は query キー不在 / body:{} は存在する (非対称)", async () => {
    const client = makeFakeClient({ action: ACT_WEBAPI, op: "webapi_history_get", data: {} });
    await invokeWebAPI(client, { func: "webapi_history_get", apiKeyId: "k" });
    const frame = client.requests[0];
    expect("query" in frame).toBe(false);
    expect(frame).toHaveProperty("body");
  });
});

// ===========================================================================
// WEB-0004: 応答に success フィールド無しでも reject せず data を返す (非strict)
// ===========================================================================

describe("[WEB-0004] invokeWebAPI: 応答に success フィールド無しでも reject せず data を返す (非strict)", () => {
  it("[WEB-0004] success フィールド欠落応答でも resolve して resp.data を返す", async () => {
    // ref: devices.js:498; util.js:34-35
    // util.js:35: failed = strict ? !resp?.success : !resp || resp.success===false
    // → success が undefined = failed 判定されない (非strict)
    const data = { ok: true };
    const client = makeFakeClient({ action: ACT_WEBAPI, op: "webapi_history_get", data }); // success フィールド無し
    const result = await invokeWebAPI(client, { func: "webapi_history_get", apiKeyId: "k" });
    expect(result).toEqual(data);
  });
});

// ===========================================================================
// WEB-0005: 応答 success:false なら reject (非strict でも明示失敗は拒否)
// ===========================================================================

describe("[WEB-0005] invokeWebAPI: 応答 success:false なら reject (非strict でも明示失敗は拒否)", () => {
  it("[WEB-0005] success:false 応答で SesameError(REJECTED) を throw する", async () => {
    // ref: devices.js:498; util.js:35 (`!resp || resp.success===false` → REJECTED)
    const client = makeFakeClient({ action: ACT_WEBAPI, op: "h", success: false, message: "api key invalid", data: null });
    await expect(
      invokeWebAPI(client, { func: "h", apiKeyId: "k" })
    ).rejects.toMatchObject({ code: ERR.REJECTED });
  });
});

// ===========================================================================
// WEB-0006: webapiDeviceState — op=webapi_ssm_shadow_get / query={device_id}
// ===========================================================================

describe("[WEB-0006] webapiDeviceState: op=webapi_ssm_shadow_get / query={device_id}", () => {
  it("[WEB-0006] func=webapi_ssm_shadow_get で query={device_id:<deviceId>} のフレームを送る", async () => {
    // ref: devices.js:511,513; useDeveloper.js:9,60,62
    const client = makeFakeClient({ action: ACT_WEBAPI, op: "webapi_ssm_shadow_get", data: { shadow: {} } });
    await webapiDeviceState(client, { apiKeyId: "k", deviceId: "dev-uuid-001" });
    const frame = client.requests[0];
    expect(frame.action).toBe("biz3InvokeWebAPIs");
    expect(frame.op).toBe("webapi_ssm_shadow_get");
    expect(frame.query).toEqual({ device_id: "dev-uuid-001" });
  });
});

// ===========================================================================
// WEB-0007: webapiDeviceState — device_id は無加工 (uppercase/normalizeUuid なし)
// ===========================================================================

describe("[WEB-0007] webapiDeviceState: device_id は無加工 (uppercase/normalizeUuid なし)", () => {
  it("[WEB-0007] 小文字のままの deviceId が query.device_id にそのまま乗る", async () => {
    // ref: devices.js:513; useDeveloper.js:62; (対比: devices.js:886 は toUpperCase)
    const rawId = "aabb-ccdd-1122-3344";
    const client = makeFakeClient({ action: ACT_WEBAPI, op: "webapi_ssm_shadow_get", data: {} });
    await webapiDeviceState(client, { apiKeyId: "k", deviceId: rawId });
    expect(client.requests[0].query.device_id).toBe(rawId);
  });

  it("[WEB-0007] 混合大小文字の deviceId もそのまま (uppercase 変換なし)", async () => {
    const mixedId = "aAbBcCdD-eeff-1234-5678-9900aaFFbbCC";
    const client = makeFakeClient({ action: ACT_WEBAPI, op: "webapi_ssm_shadow_get", data: {} });
    await webapiDeviceState(client, { apiKeyId: "k", deviceId: mixedId });
    expect(client.requests[0].query.device_id).toBe(mixedId);
  });
});

// ===========================================================================
// WEB-0008: webapiDeviceHistory — op=webapi_history_get / query 既定値
// ===========================================================================

describe("[WEB-0008] webapiDeviceHistory: op=webapi_history_get / query既定値 page=0/lg=5(数値)/isBiz=true", () => {
  it("[WEB-0008] page/lg/isBiz 省略時に query 既定値が正しく乗る", async () => {
    // ref: devices.js:524,527; useDeveloper.js:10,73,74,75
    // 注: lg は言語コードの数値 ID=5。旧実装の lg='ja'(文字列) は誤りで修正済み。
    const client = makeFakeClient({ action: ACT_WEBAPI, op: "webapi_history_get", data: {} });
    await webapiDeviceHistory(client, { apiKeyId: "k", deviceId: "dev-001" });
    const frame = client.requests[0];
    expect(frame.op).toBe("webapi_history_get");
    const q = frame.query;
    expect(q.device_id).toBe("dev-001");
    expect(q.page).toBe(0);
    expect(q.lg).toBe(5);       // 数値 (文字列 'ja' ではない)
    expect(typeof q.lg).toBe("number");
    expect(q.isBiz).toBe(true);
  });

  it("[WEB-0008] action は biz3InvokeWebAPIs", async () => {
    const client = makeFakeClient({ action: ACT_WEBAPI, op: "webapi_history_get", data: {} });
    await webapiDeviceHistory(client, { apiKeyId: "k", deviceId: "d" });
    expect(client.requests[0].action).toBe("biz3InvokeWebAPIs");
  });
});

// ===========================================================================
// WEB-0009: webapiDeviceHistory — page/lg/isBiz 明示値が既定を上書き
// ===========================================================================

describe("[WEB-0009] webapiDeviceHistory: page/lg/isBiz 明示値が既定を上書きして query に反映", () => {
  it("[WEB-0009] 明示した page/lg/isBiz が既定(0/5/true)ではなく query に乗る", async () => {
    // ref: devices.js:524 (デフォルト引数), 528 (query 組み立て)
    const client = makeFakeClient({ action: ACT_WEBAPI, op: "webapi_history_get", data: {} });
    await webapiDeviceHistory(client, { apiKeyId: "k", deviceId: "d-2", page: 3, lg: 10, isBiz: false });
    const q = client.requests[0].query;
    expect(q.page).toBe(3);
    expect(q.lg).toBe(10);
    expect(q.isBiz).toBe(false);
  });
});

// ===========================================================================
// WEB-0010: webapiSendCmd — op=webapi_cmd_send / body={device_id,cmd,sign,history} 4キー
// ===========================================================================

describe("[WEB-0010] webapiSendCmd: op=webapi_cmd_send / body={device_id,cmd,sign,history} 4キー", () => {
  it("[WEB-0010] op=webapi_cmd_send で body が {device_id,cmd,sign,history} の4キーを持つ", async () => {
    // ref: devices.js:537,539,541; useDeveloper.js:11,83,90
    // vendor triggerDevice body と同一キー集合: {device_id, cmd, sign, history}
    const client = makeFakeClient({ action: ACT_WEBAPI, op: "webapi_cmd_send", data: {} });
    await webapiSendCmd(client, {
      apiKeyId: "k",
      deviceId: "dev-xyz",
      cmd: 88,
      sign: "cmac-stub",
      history: "history-b64-stub",
    });
    const frame = client.requests[0];
    expect(frame.op).toBe("webapi_cmd_send");
    const bodyKeys = Object.keys(frame.body).sort();
    expect(bodyKeys).toEqual(["cmd", "device_id", "history", "sign"]);
    expect(frame.body.cmd).toBe(88);
    expect(frame.body.sign).toBe("cmac-stub");
    expect(frame.body.history).toBe("history-b64-stub");
  });

  it("[WEB-0010] sign/history は呼び出し側組み立て値をそのまま body に乗せる (素通し)", async () => {
    const client = makeFakeClient({ action: ACT_WEBAPI, op: "webapi_cmd_send", data: {} });
    await webapiSendCmd(client, {
      apiKeyId: "k",
      deviceId: "d",
      cmd: 82,
      sign: "cmac-value",
      history: "uuid-b64-value",
    });
    expect(client.requests[0].body.sign).toBe("cmac-value");
    expect(client.requests[0].body.history).toBe("uuid-b64-value");
  });
});

// ===========================================================================
// WEB-0011: webapiSendCmd — device_id は無加工で body に乗る
// ===========================================================================

describe("[WEB-0011] webapiSendCmd: device_id は無加工で body に乗る", () => {
  it("[WEB-0011] deviceId が変換なしで body.device_id にそのまま乗る", async () => {
    // ref: devices.js:541; useDeveloper.js:84,90
    const rawId = "RaW-Dev-Id-NoConversion";
    const client = makeFakeClient({ action: ACT_WEBAPI, op: "webapi_cmd_send", data: {} });
    await webapiSendCmd(client, {
      apiKeyId: "k",
      deviceId: rawId,
      cmd: 88,
      sign: "s",
      history: "h",
    });
    expect(client.requests[0].body.device_id).toBe(rawId);
  });
});

// ===========================================================================
// WEB-0012: client.invokeWebAPI — apiKeyId は引数優先 → config.apiKeyId フォールバック
// ===========================================================================

describe("[WEB-0012] client.invokeWebAPI: apiKeyId は引数優先 → config.apiKeyId フォールバック", () => {
  it("[WEB-0012] apiKeyId 省略時は config.apiKeyId が使われる", async () => {
    // ref: client.js:1300,1302,1305
    const { hub, ws } = makeHub({ apiKeyId: "config-key" });
    await hub.invokeWebAPI({ func: "testFunc" }); // apiKeyId 省略
    expect(ws.requests[0].apiKeyId).toBe("config-key");
  });

  it("[WEB-0012] apiKeyId 引数明示時はそちらが優先される (config より引数が勝つ)", async () => {
    // ref: client.js:1302
    const { hub, ws } = makeHub({ apiKeyId: "config-key" });
    await hub.invokeWebAPI({ func: "testFunc", apiKeyId: "explicit-key" });
    expect(ws.requests[0].apiKeyId).toBe("explicit-key");
  });
});

// ===========================================================================
// WEB-0013: client.invokeWebAPI — apiKeyId 未解決で BAD_REQUEST
// ===========================================================================

describe("[WEB-0013] client.invokeWebAPI: apiKeyId 未解決 (引数・config 共に無) で BAD_REQUEST", () => {
  it("[WEB-0013] apiKeyId が引数にも config にも無いとき BAD_REQUEST を throw する", async () => {
    // ref: client.js:1302,1304
    const { hub } = makeHub(); // config.apiKeyId なし
    await expect(
      hub.invokeWebAPI({ func: "testFunc" }) // apiKeyId 引数もなし
    ).rejects.toMatchObject({ code: ERR.BAD_REQUEST });
  });
});

// ===========================================================================
// WEB-0014: client.webapiDeviceState — apiKeyId 未解決で BAD_REQUEST
// ===========================================================================

describe("[WEB-0014] client.webapiDeviceState: apiKeyId 未解決で BAD_REQUEST", () => {
  it("[WEB-0014] apiKeyId なし & config なし で BAD_REQUEST", async () => {
    // ref: client.js:1311,1312
    const { hub } = makeHub();
    await expect(
      hub.webapiDeviceState({ deviceId: "dev-1" })
    ).rejects.toMatchObject({ code: ERR.BAD_REQUEST });
  });
});

// ===========================================================================
// WEB-0015: client.webapiDeviceHistory — apiKeyId 未解決で BAD_REQUEST
// ===========================================================================

describe("[WEB-0015] client.webapiDeviceHistory: apiKeyId 未解決で BAD_REQUEST", () => {
  it("[WEB-0015] apiKeyId なし & config なし で BAD_REQUEST", async () => {
    // ref: client.js:1319,1320
    const { hub } = makeHub();
    await expect(
      hub.webapiDeviceHistory({ deviceId: "dev-1" })
    ).rejects.toMatchObject({ code: ERR.BAD_REQUEST });
  });
});

// ===========================================================================
// WEB-0016: client.webapiSendCmd — apiKeyId 未解決で BAD_REQUEST
// ===========================================================================

describe("[WEB-0016] client.webapiSendCmd: apiKeyId 未解決で BAD_REQUEST", () => {
  it("[WEB-0016] apiKeyId なし & config なし で BAD_REQUEST", async () => {
    // ref: client.js:1327,1328
    const { hub } = makeHub();
    await expect(
      hub.webapiSendCmd({ deviceId: "dev-1", cmd: 88, sign: "s", history: "h" })
    ).rejects.toMatchObject({ code: ERR.BAD_REQUEST });
  });
});

// ===========================================================================
// WEB-0017: client.invokeWebAPI — 未接続で NOT_CONNECTED (retryable:true)
// ===========================================================================

describe("[WEB-0017] client.invokeWebAPI: 未接続で NOT_CONNECTED (retryable:true)", () => {
  it("[WEB-0017] connect() 前に invokeWebAPI を呼ぶと NOT_CONNECTED を throw する", async () => {
    // ref: client.js:1301; client.js:306,310
    // _ws = null のまま (connect() 未呼び出し)
    const hub = new SesameHub3({
      config: { companyID: "co-test" },
      tokenStore: { load: () => ({}), save: () => {}, clear: () => {} },
    });
    await expect(
      hub.invokeWebAPI({ func: "testFunc", apiKeyId: "k" })
    ).rejects.toMatchObject({ code: ERR.NOT_CONNECTED });
  });

  it("[WEB-0017] NOT_CONNECTED は retryable:true", async () => {
    const hub = new SesameHub3({
      config: { companyID: "co-test" },
      tokenStore: { load: () => ({}), save: () => {}, clear: () => {} },
    });
    await expect(
      hub.invokeWebAPI({ func: "testFunc", apiKeyId: "k" })
    ).rejects.toMatchObject({ code: ERR.NOT_CONNECTED, retryable: true });
  });

  it("[WEB-0017] 未接続での webapiDeviceState も NOT_CONNECTED (retryable:true)", async () => {
    // ref: client.js:1310
    const hub = new SesameHub3({
      config: { companyID: "co-test" },
      tokenStore: { load: () => ({}), save: () => {}, clear: () => {} },
    });
    await expect(
      hub.webapiDeviceState({ deviceId: "d", apiKeyId: "k" })
    ).rejects.toMatchObject({ code: ERR.NOT_CONNECTED, retryable: true });
  });

  it("[WEB-0017] 未接続での webapiDeviceHistory も NOT_CONNECTED (retryable:true)", async () => {
    // ref: client.js:1318
    const hub = new SesameHub3({
      config: { companyID: "co-test" },
      tokenStore: { load: () => ({}), save: () => {}, clear: () => {} },
    });
    await expect(
      hub.webapiDeviceHistory({ deviceId: "d", apiKeyId: "k" })
    ).rejects.toMatchObject({ code: ERR.NOT_CONNECTED, retryable: true });
  });

  it("[WEB-0017] 未接続での webapiSendCmd も NOT_CONNECTED (retryable:true)", async () => {
    // ref: client.js:1326
    const hub = new SesameHub3({
      config: { companyID: "co-test" },
      tokenStore: { load: () => ({}), save: () => {}, clear: () => {} },
    });
    await expect(
      hub.webapiSendCmd({ deviceId: "d", cmd: 88, sign: "s", history: "h", apiKeyId: "k" })
    ).rejects.toMatchObject({ code: ERR.NOT_CONNECTED, retryable: true });
  });
});

// ===========================================================================
// WEB-0018: serve registry — webapi 4 メソッドの登録確認 + params schema
// ===========================================================================

describe("[WEB-0018] serve: webapi 4 メソッドが registry に登録される", () => {
  it("[WEB-0018] registry に webapi.invoke が存在する", async () => {
    // ref: device.js:191,193; registry.js:339
    const { buildRegistry } = await import("../../../kit/src/serve/registry.js");
    const reg = buildRegistry();
    expect(reg.has("webapi.invoke"), "webapi.invoke が registry に無い").toBe(true);
  });

  it("[WEB-0018] registry に webapi.deviceState が存在する", async () => {
    const { buildRegistry } = await import("../../../kit/src/serve/registry.js");
    const reg = buildRegistry();
    expect(reg.has("webapi.deviceState"), "webapi.deviceState が registry に無い").toBe(true);
  });

  it("[WEB-0018] registry に webapi.deviceHistory が存在する", async () => {
    const { buildRegistry } = await import("../../../kit/src/serve/registry.js");
    const reg = buildRegistry();
    expect(reg.has("webapi.deviceHistory"), "webapi.deviceHistory が registry に無い").toBe(true);
  });

  it("[WEB-0018] registry に webapi.sendCmd が存在する", async () => {
    const { buildRegistry } = await import("../../../kit/src/serve/registry.js");
    const reg = buildRegistry();
    expect(reg.has("webapi.sendCmd"), "webapi.sendCmd が registry に無い").toBe(true);
  });

  it("[WEB-0018] webapi.invoke の params が [func, query, body, apiKeyId] の順で定義される", async () => {
    // ref: device.js:195-200; params 順は SDK 生成に影響するため固定する
    const { buildRegistry } = await import("../../../kit/src/serve/registry.js");
    const reg = buildRegistry();
    const entry = reg.get("webapi.invoke");
    expect(entry).toBeDefined();
    expect(entry.params.map((p) => p.name)).toEqual(["func", "query", "body", "apiKeyId"]);
    // func は required:true
    expect(entry.params.find((p) => p.name === "func")?.required).toBe(true);
    // query/body/apiKeyId は optional
    expect(entry.params.find((p) => p.name === "query")?.required).toBe(false);
    expect(entry.params.find((p) => p.name === "body")?.required).toBe(false);
    expect(entry.params.find((p) => p.name === "apiKeyId")?.required).toBe(false);
  });

  it("[WEB-0018] webapi.sendCmd の params が [deviceId, cmd, sign, history, apiKeyId] / cmd=N(数値型) 定義", async () => {
    // ref: device.js:236-240
    const { buildRegistry } = await import("../../../kit/src/serve/registry.js");
    const reg = buildRegistry();
    const entry = reg.get("webapi.sendCmd");
    expect(entry).toBeDefined();
    const paramNames = entry.params.map((p) => p.name);
    expect(paramNames).toEqual(["deviceId", "cmd", "sign", "history", "apiKeyId"]);
    // 必須キー
    for (const k of ["deviceId", "cmd", "sign", "history"]) {
      expect(entry.params.find((p) => p.name === k)?.required, `${k} は required のはず`).toBe(true);
    }
    // apiKeyId は optional
    expect(entry.params.find((p) => p.name === "apiKeyId")?.required).toBe(false);
    // cmd は数値型 (N) schema
    const cmdParam = entry.params.find((p) => p.name === "cmd");
    expect(cmdParam?.schema?.type).toBe("number");
  });
});
