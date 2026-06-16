// web-c1.test.js — WEB-0019 〜 WEB-0036 spec 統合テスト (TDD)
//
// 対象実装:
//   packages/kit/src/serve/entries/device.js   (webapiEntries)
//   packages/kit/src/serve/registry-helpers.js  (need / requireAuth)
//   packages/kit/src/serve/registry.js          (buildRegistry)
//   packages/kit/src/serve/grpc-methods.generated.json
//   packages/kit/sdk/ts/sesame-client.ts
//   packages/kit/sdk/python/sesame_client.py
//   packages/kit/src/cli/device.js              (cmdWebapi / registerDeviceCommands)
//   packages/kit/src/cli/ctx.js                 (out)
//   packages/core/src/transport.js              (request correlation key)
//   packages/core/src/devices.js               (invokeWebAPI action/op)
//
// 実行環境: vitest (unit project — KIT_SETUP により i18n ja 固定)
// TDD: assertion は spec どおり (red になってよい)。クラッシュ/実行不能は不可。

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { buildRegistry } from "../../../kit/src/serve/registry.js";
import { need, requireAuth } from "../../../kit/src/serve/registry-helpers.js";
import { KIND, RPC, RpcError } from "@sesame-kit/core/jsonrpc";
import { SesameHub3 } from "@sesame-kit/core/client";
import { Daemon } from "../../../kit/src/serve/daemon.js";
import { CONSUMER_CLIENT_ID } from "@sesame-kit/core/auth";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const KIT_ROOT = resolve(__dirname, "..", "..", "..", "kit");

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const CONFIRMED_DEVICE = {
  deviceKey: "dev-key",
  deviceGroupKey: "dev-group",
  devicePassword: "dev-password",
};

function makeIdToken({ expOffsetSec = 3600 } = {}) {
  const exp = Math.floor(Date.now() / 1000) + expOffsetSec;
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64");
  const payload = Buffer.from(
    JSON.stringify({ aud: CONSUMER_CLIENT_ID, sub: "test-sub", exp })
  ).toString("base64");
  return `${header}.${payload}.sig`;
}

/**
 * 呼び出しを記録するシンプルな fake hub。
 * 各メソッドは呼び出し引数を calls に記録し Promise resolve する。
 */
function makeHub(overrides = {}) {
  const calls = [];
  const rec = (name) => (arg) => {
    calls.push([name, arg]);
    return Promise.resolve({ ok: true, name });
  };
  return {
    calls,
    invokeWebAPI: rec("invokeWebAPI"),
    webapiDeviceState: rec("webapiDeviceState"),
    webapiDeviceHistory: rec("webapiDeviceHistory"),
    webapiSendCmd: rec("webapiSendCmd"),
    ...overrides,
  };
}

/**
 * 接続済み SesameHub3 (hub._ws に fake WS を注入)。
 * apiKeyId は config に任意で設定できる。
 */
function makeConnectedHub({ apiKeyId } = {}) {
  const hub = new SesameHub3({
    config: {
      companyID: "co_test",
      wsUrl: "wss://fake.invalid",
      lang: "en",
      default: { remote: null, lock: null },
      hub3s: {},
      remotes: {},
      locks: {},
      ...(apiKeyId ? { apiKeyId } : {}),
    },
    tokenStore: {
      load: () => ({
        idToken: makeIdToken(),
        refreshToken: "r",
        clientId: CONSUMER_CLIENT_ID,
        ...CONFIRMED_DEVICE,
      }),
      save() {},
      clear() {},
    },
  });
  hub._ws = {
    async request() { throw new Error("unexpected ws call in unit test"); },
    async send() { throw new Error("unexpected ws send in unit test"); },
  };
  hub._subUUID = "test-sub";
  return hub;
}

/**
 * Daemon を authState="ok" で作る (requireAuth を通す)。
 */
function makeActiveDaemon(hub) {
  const d = new Daemon({ hub });
  d.authState = "ok";
  return d;
}

/**
 * dispatchMessage ヘルパ: JSON-RPC メッセージを文字列として送り応答を返す。
 * (WEB-0021 など dispatchMessage 経路で応答形式を確認する用途)
 */
async function callRpc(d, method, params, id = 1) {
  return d.dispatchMessage(null, JSON.stringify({ jsonrpc: "2.0", id, method, params }));
}

// ---------------------------------------------------------------------------
// [WEB-0019] serve webapi.invoke → hub.invokeWebAPI({func,query,body,apiKeyId})
// ---------------------------------------------------------------------------

describe("[WEB-0019] serve webapi.invoke → hub.invokeWebAPI 委譲", () => {
  it("[WEB-0019] registry に webapi.invoke エントリが存在し params 順は [func,query,body,apiKeyId]", () => {
    const reg = buildRegistry();
    const e = reg.get("webapi.invoke");
    expect(e).toBeTruthy();
    expect(e.params.map((p) => p.name)).toEqual(["func", "query", "body", "apiKeyId"]);
  });

  it("[WEB-0019] func は required:true", () => {
    const reg = buildRegistry();
    const e = reg.get("webapi.invoke");
    const funcParam = e.params.find((p) => p.name === "func");
    expect(funcParam).toBeTruthy();
    expect(funcParam.required).toBe(true);
  });

  it("[WEB-0019] handler が hub.invokeWebAPI({func,query,body,apiKeyId}) へ委譲する", async () => {
    const hub = makeHub();
    const reg = buildRegistry();
    const e = reg.get("webapi.invoke");
    const daemon = { authState: "ok", hub: { connected: true } };
    await e.handler({
      hub,
      daemon,
      params: { func: "myFunc", query: { a: 1 }, body: { b: 2 }, apiKeyId: "key-1" },
    });
    expect(hub.calls).toHaveLength(1);
    const [name, arg] = hub.calls[0];
    expect(name).toBe("invokeWebAPI");
    expect(arg).toEqual({ func: "myFunc", query: { a: 1 }, body: { b: 2 }, apiKeyId: "key-1" });
  });

  it("[WEB-0019] requireAuth を先頭で呼ぶ (hub 未接続で CONNECTION_LOST を先に投げる)", async () => {
    const hub = makeHub();
    const reg = buildRegistry();
    const e = reg.get("webapi.invoke");
    const daemonDisconnected = { authState: "ok", hub: { connected: false } };
    await expect(
      Promise.resolve().then(() => e.handler({ hub, daemon: daemonDisconnected, params: { func: "f", apiKeyId: "k" } }))
    ).rejects.toMatchObject({ kind: KIND.CONNECTION_LOST });
  });
});

// ---------------------------------------------------------------------------
// [WEB-0020] serve webapi.invoke: func 欠落で bad_params (INVALID_PARAMS)
// ---------------------------------------------------------------------------

describe("[WEB-0020] serve webapi.invoke: func 欠落で bad_params", () => {
  it("[WEB-0020] params が空 ({}) のとき need が RpcError(kind=BAD_PARAMS) を throw する", () => {
    expect(() => need({}, ["func"])).toThrow(RpcError);
  });

  it("[WEB-0020] need の throw は kind=BAD_PARAMS を持つ", () => {
    let err;
    try { need({}, ["func"]); } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(err.kind).toBe(KIND.BAD_PARAMS);
  });

  it("[WEB-0020] func='' (空文字) は BAD_PARAMS", () => {
    expect(() => need({ func: "" }, ["func"])).toThrow(RpcError);
  });

  it("[WEB-0020] func=null は BAD_PARAMS", () => {
    expect(() => need({ func: null }, ["func"])).toThrow(RpcError);
  });

  it("[WEB-0020] func=undefined は BAD_PARAMS", () => {
    expect(() => need({ func: undefined }, ["func"])).toThrow(RpcError);
  });

  it("[WEB-0020] func が有効値のとき throw しない", () => {
    expect(() => need({ func: "myFunc" }, ["func"])).not.toThrow();
  });

  it("[WEB-0020] handler に func なし params を渡すと BAD_PARAMS で reject する", async () => {
    const hub = makeHub();
    const reg = buildRegistry();
    const e = reg.get("webapi.invoke");
    const daemon = { authState: "ok", hub: { connected: true } };
    await expect(
      Promise.resolve().then(() => e.handler({ hub, daemon, params: {} }))
    ).rejects.toMatchObject({ kind: KIND.BAD_PARAMS });
  });
});

// ---------------------------------------------------------------------------
// [WEB-0021] serve webapi.invoke: apiKeyId 未設定 → bad_params 写像
// ---------------------------------------------------------------------------

describe("[WEB-0021] serve webapi.invoke: apiKeyId 未設定 → kind=bad_params 写像", () => {
  it("[WEB-0021] func あり apiKeyId なし (引数・config 両方なし) → kind=bad_params で reject", async () => {
    // config に apiKeyId がない hub + 引数も無し → hub 層 badRequest → BAD_PARAMS
    const hub = makeConnectedHub(); // apiKeyId なし
    const d = makeActiveDaemon(hub);
    const res = await callRpc(d, "webapi.invoke", { func: "someFunc" });
    expect(res).toBeDefined();
    expect(res.error).toBeDefined();
    expect(res.error?.data?.kind).toBe(KIND.BAD_PARAMS);
  });

  it("[WEB-0021] apiKeyId を config に設定すれば hub 呼び出しまで到達する", async () => {
    const hub = makeConnectedHub({ apiKeyId: "myKeyId" });
    hub.invokeWebAPI = vi.fn(async () => ({ result: "ok" }));
    const daemon = makeActiveDaemon(hub);
    const reg = buildRegistry();
    const e = reg.get("webapi.invoke");
    await expect(
      e.handler({ hub, daemon, params: { func: "someFunc" } })
    ).resolves.toBeDefined();
    expect(hub.invokeWebAPI).toHaveBeenCalledOnce();
  });

  it("[WEB-0021] apiKeyId を引数に渡せば hub 呼び出しまで到達する", async () => {
    const hub = makeConnectedHub();
    hub.invokeWebAPI = vi.fn(async () => ({ result: "ok" }));
    const daemon = makeActiveDaemon(hub);
    const reg = buildRegistry();
    const e = reg.get("webapi.invoke");
    await expect(
      e.handler({ hub, daemon, params: { func: "someFunc", apiKeyId: "explicit-key" } })
    ).resolves.toBeDefined();
    expect(hub.invokeWebAPI).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// [WEB-0022] serve webapi.invoke: 未接続 daemon で requireAuth が CONNECTION_LOST
// ---------------------------------------------------------------------------

describe("[WEB-0022] serve webapi.invoke: 未接続で requireAuth が CONNECTION_LOST", () => {
  it("[WEB-0022] hub.connected=false のとき requireAuth が RpcError(kind=connection_lost) を throw する", () => {
    const daemonDisconnected = { authState: "ok", hub: { connected: false } };
    expect(() => requireAuth(daemonDisconnected)).toThrow(RpcError);
    let err;
    try { requireAuth(daemonDisconnected); } catch (e) { err = e; }
    expect(err?.kind).toBe(KIND.CONNECTION_LOST);
  });

  it("[WEB-0022] handler は requireAuth を handler 本体の前に呼ぶ (hub 未接続でハンドラ本体未到達)", async () => {
    const hub = makeHub();
    const reg = buildRegistry();
    const e = reg.get("webapi.invoke");
    const daemonDisconnected = { authState: "ok", hub: { connected: false } };
    await expect(
      Promise.resolve().then(() => e.handler({ hub, daemon: daemonDisconnected, params: { func: "f", apiKeyId: "k" } }))
    ).rejects.toMatchObject({ kind: KIND.CONNECTION_LOST });
    expect(hub.calls).toHaveLength(0);
  });

  it("[WEB-0022] hub.connected=true のとき requireAuth は throw しない", () => {
    const daemonConnected = { authState: "ok", hub: { connected: true } };
    expect(() => requireAuth(daemonConnected)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// [WEB-0023] serve webapi.deviceState → hub.webapiDeviceState / deviceId 必須
// ---------------------------------------------------------------------------

describe("[WEB-0023] serve webapi.deviceState → hub.webapiDeviceState 委譲 / deviceId 必須", () => {
  it("[WEB-0023] registry に webapi.deviceState エントリが存在する", () => {
    const reg = buildRegistry();
    expect(reg.get("webapi.deviceState")).toBeTruthy();
  });

  it("[WEB-0023] params は [deviceId, apiKeyId] の 2 件", () => {
    const reg = buildRegistry();
    const e = reg.get("webapi.deviceState");
    expect(e.params.map((p) => p.name)).toEqual(["deviceId", "apiKeyId"]);
  });

  it("[WEB-0023] deviceId は required:true", () => {
    const reg = buildRegistry();
    const e = reg.get("webapi.deviceState");
    const p = e.params.find((p) => p.name === "deviceId");
    expect(p).toBeTruthy();
    expect(p.required).toBe(true);
  });

  it("[WEB-0023] handler が hub.webapiDeviceState({deviceId,apiKeyId}) へ委譲する", async () => {
    const hub = makeHub();
    const reg = buildRegistry();
    const e = reg.get("webapi.deviceState");
    const daemon = { authState: "ok", hub: { connected: true } };
    await e.handler({ hub, daemon, params: { deviceId: "dev-1", apiKeyId: "k1" } });
    expect(hub.calls).toHaveLength(1);
    const [name, arg] = hub.calls[0];
    expect(name).toBe("webapiDeviceState");
    expect(arg).toEqual({ deviceId: "dev-1", apiKeyId: "k1" });
  });

  it("[WEB-0023] deviceId 欠落で bad_params (hub は呼ばれない)", async () => {
    const hub = makeHub();
    const reg = buildRegistry();
    const e = reg.get("webapi.deviceState");
    const daemon = { authState: "ok", hub: { connected: true } };
    await expect(
      Promise.resolve().then(() => e.handler({ hub, daemon, params: { apiKeyId: "k1" } }))
    ).rejects.toMatchObject({ kind: KIND.BAD_PARAMS });
    expect(hub.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// [WEB-0024] serve webapi.deviceHistory → hub 委譲 / deviceId 必須・page/lg/isBiz/apiKeyId 任意
// ---------------------------------------------------------------------------

describe("[WEB-0024] serve webapi.deviceHistory → hub 委譲 / deviceId 必須 / page/lg/isBiz optional", () => {
  it("[WEB-0024] registry に webapi.deviceHistory エントリが存在する", () => {
    const reg = buildRegistry();
    expect(reg.get("webapi.deviceHistory")).toBeTruthy();
  });

  it("[WEB-0024] params は [deviceId, page, lg, isBiz, apiKeyId] の 5 件", () => {
    const reg = buildRegistry();
    const e = reg.get("webapi.deviceHistory");
    expect(e.params.map((p) => p.name)).toEqual(["deviceId", "page", "lg", "isBiz", "apiKeyId"]);
  });

  it("[WEB-0024] deviceId は required:true / page/lg/isBiz/apiKeyId は required:false", () => {
    const reg = buildRegistry();
    const e = reg.get("webapi.deviceHistory");
    expect(e.params.find((p) => p.name === "deviceId")?.required).toBe(true);
    for (const name of ["page", "lg", "isBiz", "apiKeyId"]) {
      expect(e.params.find((p) => p.name === name)?.required).toBe(false);
    }
  });

  it("[WEB-0024] handler が hub.webapiDeviceHistory へ全パラメータを委譲する", async () => {
    const hub = makeHub();
    const reg = buildRegistry();
    const e = reg.get("webapi.deviceHistory");
    const daemon = { authState: "ok", hub: { connected: true } };
    await e.handler({
      hub,
      daemon,
      params: { deviceId: "dev-1", page: 2, lg: 5, isBiz: true, apiKeyId: "k1" },
    });
    const [name, arg] = hub.calls[0];
    expect(name).toBe("webapiDeviceHistory");
    expect(arg).toEqual({ deviceId: "dev-1", page: 2, lg: 5, isBiz: true, apiKeyId: "k1" });
  });

  it("[WEB-0024] deviceId 欠落で bad_params", async () => {
    const hub = makeHub();
    const reg = buildRegistry();
    const e = reg.get("webapi.deviceHistory");
    const daemon = { authState: "ok", hub: { connected: true } };
    await expect(
      Promise.resolve().then(() => e.handler({ hub, daemon, params: { page: 1 } }))
    ).rejects.toMatchObject({ kind: KIND.BAD_PARAMS });
  });
});

// ---------------------------------------------------------------------------
// [WEB-0025] serve webapi.sendCmd → hub.webapiSendCmd 委譲
// ---------------------------------------------------------------------------

describe("[WEB-0025] serve webapi.sendCmd → hub.webapiSendCmd({deviceId,cmd,sign,history,apiKeyId})", () => {
  it("[WEB-0025] registry に webapi.sendCmd エントリが存在する", () => {
    const reg = buildRegistry();
    expect(reg.get("webapi.sendCmd")).toBeTruthy();
  });

  it("[WEB-0025] params は [deviceId, cmd, sign, history, apiKeyId] の 5 件", () => {
    const reg = buildRegistry();
    const e = reg.get("webapi.sendCmd");
    expect(e.params.map((p) => p.name)).toEqual(["deviceId", "cmd", "sign", "history", "apiKeyId"]);
  });

  it("[WEB-0025] deviceId/cmd/sign/history は required:true / apiKeyId は required:false", () => {
    const reg = buildRegistry();
    const e = reg.get("webapi.sendCmd");
    for (const name of ["deviceId", "cmd", "sign", "history"]) {
      expect(e.params.find((p) => p.name === name)?.required).toBe(true);
    }
    expect(e.params.find((p) => p.name === "apiKeyId")?.required).toBe(false);
  });

  it("[WEB-0025] handler が hub.webapiSendCmd へ全パラメータを委譲する", async () => {
    const hub = makeHub();
    const reg = buildRegistry();
    const e = reg.get("webapi.sendCmd");
    const daemon = { authState: "ok", hub: { connected: true } };
    await e.handler({
      hub,
      daemon,
      params: { deviceId: "dev-1", cmd: 88, sign: "cmac-hex", history: "uuid-buf", apiKeyId: "k" },
    });
    const [name, arg] = hub.calls[0];
    expect(name).toBe("webapiSendCmd");
    expect(arg).toEqual({
      deviceId: "dev-1",
      cmd: 88,
      sign: "cmac-hex",
      history: "uuid-buf",
      apiKeyId: "k",
    });
  });
});

// ---------------------------------------------------------------------------
// [WEB-0026] serve webapi.sendCmd: 必須キー欠落で bad_params / cmd は number 型
// ---------------------------------------------------------------------------

describe("[WEB-0026] serve webapi.sendCmd: 必須 4 キー欠落で bad_params / cmd は number 型 schema", () => {
  it("[WEB-0026] cmd パラメータの schema type が 'number' である", () => {
    const reg = buildRegistry();
    const e = reg.get("webapi.sendCmd");
    const cmdParam = e.params.find((p) => p.name === "cmd");
    expect(cmdParam).toBeTruthy();
    expect(cmdParam.required).toBe(true);
    expect(cmdParam.schema?.type).toBe("number");
  });

  it("[WEB-0026] deviceId 欠落で BAD_PARAMS (hub は呼ばれない)", async () => {
    const hub = makeHub();
    const reg = buildRegistry();
    const e = reg.get("webapi.sendCmd");
    const daemon = { authState: "ok", hub: { connected: true } };
    await expect(
      Promise.resolve().then(() => e.handler({ hub, daemon, params: { cmd: 88, sign: "s", history: "h" } }))
    ).rejects.toMatchObject({ kind: KIND.BAD_PARAMS });
    expect(hub.calls).toHaveLength(0);
  });

  it("[WEB-0026] cmd 欠落で BAD_PARAMS", async () => {
    const hub = makeHub();
    const reg = buildRegistry();
    const e = reg.get("webapi.sendCmd");
    const daemon = { authState: "ok", hub: { connected: true } };
    await expect(
      Promise.resolve().then(() => e.handler({ hub, daemon, params: { deviceId: "d", sign: "s", history: "h" } }))
    ).rejects.toMatchObject({ kind: KIND.BAD_PARAMS });
  });

  it("[WEB-0026] sign 欠落で BAD_PARAMS", async () => {
    const hub = makeHub();
    const reg = buildRegistry();
    const e = reg.get("webapi.sendCmd");
    const daemon = { authState: "ok", hub: { connected: true } };
    await expect(
      Promise.resolve().then(() => e.handler({ hub, daemon, params: { deviceId: "d", cmd: 88, history: "h" } }))
    ).rejects.toMatchObject({ kind: KIND.BAD_PARAMS });
  });

  it("[WEB-0026] history 欠落で BAD_PARAMS", async () => {
    const hub = makeHub();
    const reg = buildRegistry();
    const e = reg.get("webapi.sendCmd");
    const daemon = { authState: "ok", hub: { connected: true } };
    await expect(
      Promise.resolve().then(() => e.handler({ hub, daemon, params: { deviceId: "d", cmd: 88, sign: "s" } }))
    ).rejects.toMatchObject({ kind: KIND.BAD_PARAMS });
  });

  it("[WEB-0026] need(['deviceId','cmd','sign','history']) が全欠落時に RpcError を throw する", () => {
    expect(() => need({}, ["deviceId", "cmd", "sign", "history"])).toThrow(RpcError);
  });
});

// ---------------------------------------------------------------------------
// [WEB-0027] grpc-methods.generated: webapi 4 メソッドの jsonFields/optionalScalars 整合
// ---------------------------------------------------------------------------

describe("[WEB-0027] grpc-methods.generated.json: webapi 4 メソッドの jsonFields/optionalScalars 整合", () => {
  const MAP_PATH = resolve(KIT_ROOT, "src", "serve", "grpc-methods.generated.json");
  const grpcMap = JSON.parse(readFileSync(MAP_PATH, "utf8"));

  it("[WEB-0027] WebapiInvoke.method = 'webapi.invoke'", () => {
    expect(grpcMap.WebapiInvoke?.method).toBe("webapi.invoke");
  });

  it("[WEB-0027] WebapiInvoke.jsonFields = ['query', 'body']", () => {
    expect(grpcMap.WebapiInvoke?.jsonFields).toEqual(["query", "body"]);
  });

  it("[WEB-0027] WebapiInvoke.optionalScalars = ['query', 'body', 'apiKeyId']", () => {
    expect(grpcMap.WebapiInvoke?.optionalScalars).toEqual(["query", "body", "apiKeyId"]);
  });

  it("[WEB-0027] WebapiDeviceState.method = 'webapi.deviceState' かつ optionalScalars=['apiKeyId']", () => {
    expect(grpcMap.WebapiDeviceState?.method).toBe("webapi.deviceState");
    expect(grpcMap.WebapiDeviceState?.optionalScalars).toEqual(["apiKeyId"]);
  });

  it("[WEB-0027] WebapiDeviceState.jsonFields=[] (query/body フィールドなし)", () => {
    expect(grpcMap.WebapiDeviceState?.jsonFields).toEqual([]);
  });

  it("[WEB-0027] WebapiDeviceHistory.method = 'webapi.deviceHistory' かつ optionalScalars=['page','lg','isBiz','apiKeyId']", () => {
    expect(grpcMap.WebapiDeviceHistory?.method).toBe("webapi.deviceHistory");
    expect(grpcMap.WebapiDeviceHistory?.optionalScalars).toEqual(["page", "lg", "isBiz", "apiKeyId"]);
  });

  it("[WEB-0027] WebapiSendCmd.method = 'webapi.sendCmd' かつ jsonFields=[] / optionalScalars=['apiKeyId']", () => {
    expect(grpcMap.WebapiSendCmd?.method).toBe("webapi.sendCmd");
    expect(grpcMap.WebapiSendCmd?.jsonFields).toEqual([]);
    expect(grpcMap.WebapiSendCmd?.optionalScalars).toEqual(["apiKeyId"]);
  });
});

// ---------------------------------------------------------------------------
// [WEB-0028] sdk(ts): client.webapi.{invoke,deviceState,deviceHistory,sendCmd} のシグネチャ整合
// ---------------------------------------------------------------------------

describe("[WEB-0028] sdk(ts): sesame-client.ts webapi.* 4 メソッドのシグネチャ整合", () => {
  const TS_PATH = resolve(KIT_ROOT, "sdk", "ts", "sesame-client.ts");
  const src = readFileSync(TS_PATH, "utf8");

  it("[WEB-0028] readonly webapi ブロックが存在する", () => {
    expect(src).toMatch(/readonly webapi\s*=\s*\{/);
  });

  it("[WEB-0028] webapi.invoke は func: string を持ち _call('webapi.invoke') へ委譲する", () => {
    expect(src).toMatch(/invoke.*func.*string/s);
    expect(src).toContain('"webapi.invoke"');
  });

  it("[WEB-0028] webapi.invoke の query/body/apiKeyId は optional (?)", () => {
    expect(src).toMatch(/invoke.*query\?:/s);
    expect(src).toMatch(/invoke.*body\?:/s);
    expect(src).toMatch(/invoke.*apiKeyId\?:/s);
  });

  it("[WEB-0028] webapi.deviceState は deviceId: string と apiKeyId? を持つ", () => {
    expect(src).toMatch(/deviceState.*deviceId:\s*string/s);
    expect(src).toMatch(/deviceState.*apiKeyId\?:/s);
    expect(src).toContain('"webapi.deviceState"');
  });

  it("[WEB-0028] webapi.deviceHistory は deviceId: string と page?/lg?/isBiz?/apiKeyId? を持つ", () => {
    expect(src).toMatch(/deviceHistory.*deviceId:\s*string/s);
    expect(src).toMatch(/deviceHistory.*page\?:/s);
    expect(src).toMatch(/deviceHistory.*lg\?:/s);
    expect(src).toMatch(/deviceHistory.*isBiz\?:/s);
    expect(src).toMatch(/deviceHistory.*apiKeyId\?:/s);
    expect(src).toContain('"webapi.deviceHistory"');
  });

  it("[WEB-0028] webapi.sendCmd は deviceId/cmd(number)/sign/history を必須として持ち apiKeyId? は optional", () => {
    expect(src).toMatch(/sendCmd.*deviceId:\s*string/s);
    expect(src).toMatch(/sendCmd.*cmd:\s*number/s);
    expect(src).toMatch(/sendCmd.*sign:\s*string/s);
    expect(src).toMatch(/sendCmd.*history:\s*string/s);
    expect(src).toMatch(/sendCmd.*apiKeyId\?:/s);
    expect(src).toContain('"webapi.sendCmd"');
  });
});

// ---------------------------------------------------------------------------
// [WEB-0029] sdk(py): _Webapi が 4 メソッドを _omit_none で _c._call へ委譲
// ---------------------------------------------------------------------------

describe("[WEB-0029] sdk(py): sesame_client.py _Webapi 4 メソッドのシグネチャ整合", () => {
  const PY_PATH = resolve(KIT_ROOT, "sdk", "python", "sesame_client.py");
  const src = readFileSync(PY_PATH, "utf8");

  it("[WEB-0029] _omit_none ユーティリティが存在し None を落とす", () => {
    expect(src).toMatch(/def _omit_none\(/);
    expect(src).toMatch(/v is not None/);
  });

  it("[WEB-0029] _Webapi.invoke は func を必須引数に持つ", () => {
    expect(src).toMatch(/def invoke\(.*func.*str/s);
  });

  it("[WEB-0029] _Webapi.invoke の query/body/apiKeyId は None デフォルト (optional)", () => {
    expect(src).toMatch(/invoke.*query.*None/s);
    expect(src).toMatch(/invoke.*body.*None/s);
    expect(src).toMatch(/invoke.*apiKeyId.*None/s);
  });

  it("[WEB-0029] _Webapi.invoke は _omit_none と _c._call('webapi.invoke') を使う", () => {
    expect(src).toMatch(/_c\._call\(\s*["']webapi\.invoke["']/);
    expect(src).toMatch(/invoke.*_omit_none/s);
  });

  it("[WEB-0029] _Webapi.deviceState は deviceId を必須引数に持ち apiKeyId は optional", () => {
    expect(src).toMatch(/def deviceState\(.*deviceId.*str/s);
    expect(src).toMatch(/deviceState.*apiKeyId.*None/s);
    expect(src).toMatch(/_c\._call\(\s*["']webapi\.deviceState["']/);
  });

  it("[WEB-0029] _Webapi.deviceHistory は deviceId 必須・page/lg/isBiz/apiKeyId は optional", () => {
    expect(src).toMatch(/def deviceHistory\(.*deviceId.*str/s);
    expect(src).toMatch(/deviceHistory.*page.*None/s);
    expect(src).toMatch(/deviceHistory.*lg.*None/s);
    expect(src).toMatch(/deviceHistory.*isBiz.*None/s);
    expect(src).toMatch(/deviceHistory.*apiKeyId.*None/s);
    expect(src).toMatch(/_c\._call\(\s*["']webapi\.deviceHistory["']/);
  });

  it("[WEB-0029] _Webapi.sendCmd は deviceId/cmd/sign/history 必須・apiKeyId optional", () => {
    expect(src).toMatch(/def sendCmd\(.*deviceId.*str/s);
    expect(src).toMatch(/sendCmd.*cmd:/s);
    expect(src).toMatch(/sendCmd.*sign.*str/s);
    expect(src).toMatch(/sendCmd.*history.*str/s);
    expect(src).toMatch(/sendCmd.*apiKeyId.*None/s);
    expect(src).toMatch(/_c\._call\(\s*["']webapi\.sendCmd["']/);
  });

  it("[WEB-0029] invoke の _omit_none が _call 引数に入っている", () => {
    const invokeSection = src.slice(src.indexOf("def invoke("));
    expect(invokeSection).toMatch(/_omit_none\(\{/);
  });
});

// ---------------------------------------------------------------------------
// [WEB-0030] cli: `sesame webapi <func>` → hub.invokeWebAPI({func,query,body,apiKeyId})
// ---------------------------------------------------------------------------

describe("[WEB-0030] cli: `sesame webapi <func>` の hub 委譲", () => {
  const CLI_PATH = resolve(KIT_ROOT, "src", "cli", "device.js");
  const src = readFileSync(CLI_PATH, "utf8");

  it("[WEB-0030] program.command('webapi <func>') が登録されている", () => {
    expect(src).toMatch(/program\.command\(["']webapi <func>["']\)/);
  });

  it("[WEB-0030] cmdWebapi 関数が device.js に存在する", () => {
    expect(src).toContain("cmdWebapi");
  });

  it("[WEB-0030] hub.invokeWebAPI({ func, ... }) への委譲が存在する", () => {
    expect(src).toMatch(/hub\.invokeWebAPI\(\s*\{\s*func/);
  });

  it("[WEB-0030] --query/--body/--api-key オプションが登録されている", () => {
    expect(src).toContain("--query <json>");
    expect(src).toContain("--body <json>");
    expect(src).toContain("--api-key <id>");
  });

  it("[WEB-0030] query/body/apiKeyId が invokeWebAPI に渡される", () => {
    expect(src).toMatch(/invokeWebAPI\([^)]*query[^)]*body[^)]*\)/s);
  });
});

// ---------------------------------------------------------------------------
// [WEB-0031] cli webapi: func 未指定で exit code 2
// ---------------------------------------------------------------------------

describe("[WEB-0031] cli webapi: func 未指定は commander.missingArgument 経由で exit 2 になる", () => {
  it("[WEB-0031] 位置引数 <func> が必須 (commander <func> 記法) で登録されている", () => {
    const CLI_PATH = resolve(KIT_ROOT, "src", "cli", "device.js");
    const src = readFileSync(CLI_PATH, "utf8");
    expect(src).toContain('"webapi <func>"');
  });

  it("[WEB-0031] device.js の cmdWebapi に !func ガードが存在する", () => {
    const CLI_PATH = resolve(KIT_ROOT, "src", "cli", "device.js");
    const src = readFileSync(CLI_PATH, "utf8");
    expect(src).toMatch(/if\s*\(!func\)/);
    expect(src).toMatch(/funcRequired/);
  });

  it("[WEB-0031] COMMANDER_USAGE_CODES に 'commander.missingArgument' が含まれる", () => {
    const ERRORS_PATH = resolve(KIT_ROOT, "src", "cli", "errors.js");
    const errSrc = readFileSync(ERRORS_PATH, "utf8");
    expect(errSrc).toMatch(/commander\.missingArgument/);
  });

  it("[WEB-0031] EXIT.USAGE = 2 が定義されている", () => {
    const ERRORS_PATH = resolve(KIT_ROOT, "src", "cli", "errors.js");
    const errSrc = readFileSync(ERRORS_PATH, "utf8");
    expect(errSrc).toMatch(/USAGE.*2/);
  });
});

// ---------------------------------------------------------------------------
// [WEB-0032] cli webapi: --query/--body の不正 JSON で exit code 2
// ---------------------------------------------------------------------------

describe("[WEB-0032] cli webapi: --query/--body の不正 JSON で die(invalidJsonQueryBody, 2)", () => {
  const CLI_PATH = resolve(KIT_ROOT, "src", "cli", "device.js");
  const src = readFileSync(CLI_PATH, "utf8");

  it("[WEB-0032] JSON.parse の try/catch が存在する", () => {
    expect(src).toContain("JSON.parse");
    expect(src).toMatch(/try\s*\{/);
    expect(src).toMatch(/catch/);
  });

  it("[WEB-0032] catch ブロック内で invalidJsonQueryBody を die に渡す", () => {
    expect(src).toContain("invalidJsonQueryBody");
    expect(src).toMatch(/die\(/);
  });

  it("[WEB-0032] die の第 2 引数が 2 (exit code 2)", () => {
    // die(t('cli.invalidJsonQueryBody', {...}), 2) — ネスト括弧を含むため .* で一致させる
    expect(src).toMatch(/die\(.*invalidJsonQueryBody.*,\s*2\s*\)/s);
  });

  it("[WEB-0032] i18n キー cli.invalidJsonQueryBody が cli i18n ファイルに実在する", () => {
    const CLI_I18N_PATH = resolve(KIT_ROOT, "src", "i18n", "cli.js");
    const i18nSrc = readFileSync(CLI_I18N_PATH, "utf8");
    expect(i18nSrc).toMatch(/invalidJsonQueryBody/);
  });
});

// ---------------------------------------------------------------------------
// [WEB-0033] cli webapi: --query/--body 省略時は {} で hub へ渡る
// ---------------------------------------------------------------------------

describe("[WEB-0033] cli webapi: --query/--body 省略時は {} の初期値が hub に渡る", () => {
  const CLI_PATH = resolve(KIT_ROOT, "src", "cli", "device.js");
  const src = readFileSync(CLI_PATH, "utf8");

  it("[WEB-0033] let query = {} の初期化が cmdWebapi に存在する", () => {
    expect(src).toMatch(/let\s+query\s*=\s*\{\s*\}/);
  });

  it("[WEB-0033] let body = {} の初期化が cmdWebapi に存在する", () => {
    expect(src).toMatch(/let\s+body\s*=\s*\{\s*\}/);
  });

  it("[WEB-0033] options.query が truthy のときのみ JSON.parse を呼ぶ", () => {
    expect(src).toMatch(/if\s*\(\s*options\.query\s*\)/);
    expect(src).toMatch(/if\s*\(\s*options\.body\s*\)/);
  });

  it("[WEB-0033] query と body が invokeWebAPI 呼び出しに渡される", () => {
    expect(src).toMatch(/invokeWebAPI\([^)]*query[^)]*body[^)]*\)/s);
  });
});

// ---------------------------------------------------------------------------
// [WEB-0034] cli webapi: --json で応答 data を {data} ラップ JSON 出力
// ---------------------------------------------------------------------------

describe("[WEB-0034] cli webapi: out(opts.json, humanFn, {data}) の --json 分岐", () => {
  it("[WEB-0034] out(json=true, humanFn, {data}) は JSON 出力し humanFn を呼ばない", async () => {
    const { out } = await import("../../../kit/src/cli/ctx.js");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const mockHumanFn = vi.fn();
    const dataObj = { foo: "bar" };
    out(true, mockHumanFn, { data: dataObj });
    expect(spy).toHaveBeenCalledWith(JSON.stringify({ data: dataObj }, null, 2));
    expect(mockHumanFn).not.toHaveBeenCalled();
  });

  it("[WEB-0034] out(json=false, humanFn, ...) は humanFn を呼び console.log しない", async () => {
    const { out } = await import("../../../kit/src/cli/ctx.js");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const mockHumanFn = vi.fn();
    out(false, mockHumanFn, { data: "x" });
    expect(mockHumanFn).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalled();
  });

  it("[WEB-0034] cmdWebapi の humanFn が JSON.stringify(data,null,2) を console.log する", () => {
    const CLI_PATH = resolve(KIT_ROOT, "src", "cli", "device.js");
    const src = readFileSync(CLI_PATH, "utf8");
    expect(src).toMatch(/JSON\.stringify\(data,\s*null,\s*2\)/);
    expect(src).toMatch(/out\(opts\.json/);
    expect(src).toMatch(/\{\s*data\s*\}/);
  });

  it("[WEB-0034] ctx.js の out 関数が json=true 時に JSON.stringify(jsonObj) を出力する", () => {
    const CTX_PATH = resolve(KIT_ROOT, "src", "cli", "ctx.js");
    const ctxSrc = readFileSync(CTX_PATH, "utf8");
    expect(ctxSrc).toMatch(/if\s*\(\s*json\s*\)/);
    expect(ctxSrc).toMatch(/JSON\.stringify\s*\(\s*jsonObj/);
    expect(ctxSrc).toContain("humanFn");
  });
});

// ---------------------------------------------------------------------------
// [WEB-0035] invokeWebAPI: 応答相関キーは `biz3InvokeWebAPIs:<func>` (op-keyed)
// ---------------------------------------------------------------------------

describe("[WEB-0035] invokeWebAPI: 応答相関キーは `biz3InvokeWebAPIs:<func>` (action+op FIFO)", () => {
  it("[WEB-0035] transport.js の request が key=`${payload.action}:${payload.op||''}` を使う", () => {
    const TRANSPORT_PATH = resolve(KIT_ROOT, "..", "core", "src", "transport.js");
    const transportSrc = readFileSync(TRANSPORT_PATH, "utf8");
    expect(transportSrc).toMatch(/`\$\{payload\.action\}:\$\{payload\.op/);
  });

  it("[WEB-0035] devices.js の invokeWebAPI が action:ACT_WEBAPI / op:func をセットする", () => {
    const DEVICES_PATH = resolve(KIT_ROOT, "..", "core", "src", "devices.js");
    const devicesSrc = readFileSync(DEVICES_PATH, "utf8");
    expect(devicesSrc).toMatch(/action:\s*ACT_WEBAPI/);
    expect(devicesSrc).toMatch(/op:\s*func/);
  });

  it("[WEB-0035] invokeWebAPI が送出する frame.action='biz3InvokeWebAPIs', frame.op=func", async () => {
    const { invokeWebAPI } = await import(
      resolve(KIT_ROOT, "..", "core", "src", "devices.js")
    );
    const sentFrames = [];
    const fakeWs = {
      async request(frame) {
        sentFrames.push(frame);
        return { action: "biz3InvokeWebAPIs", op: frame.op, success: true, data: { result: "ok" } };
      },
    };
    await invokeWebAPI(fakeWs, { func: "webapi_ssm_shadow_get", apiKeyId: "k" });
    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0].action).toBe("biz3InvokeWebAPIs");
    expect(sentFrames[0].op).toBe("webapi_ssm_shadow_get");
  });

  it("[WEB-0035] 相関キーが action+':'+func になる (biz3InvokeWebAPIs:webapi_ssm_shadow_get)", async () => {
    const { invokeWebAPI } = await import(
      resolve(KIT_ROOT, "..", "core", "src", "devices.js")
    );
    const sentFrames = [];
    const fakeWs = {
      async request(frame) {
        sentFrames.push(frame);
        return { action: frame.action, op: frame.op, success: true, data: {} };
      },
    };
    await invokeWebAPI(fakeWs, { func: "webapi_ssm_shadow_get", apiKeyId: "k" });
    const correlationKey = `${sentFrames[0].action}:${sentFrames[0].op}`;
    expect(correlationKey).toBe("biz3InvokeWebAPIs:webapi_ssm_shadow_get");
  });

  it("[WEB-0035] 異なる func は異なる相関キーになる", async () => {
    const { invokeWebAPI } = await import(
      resolve(KIT_ROOT, "..", "core", "src", "devices.js")
    );
    const keys = [];
    const fakeWs = {
      async request(frame) {
        keys.push(`${frame.action}:${frame.op}`);
        return { action: frame.action, op: frame.op, success: true, data: {} };
      },
    };
    await invokeWebAPI(fakeWs, { func: "webapi_history_get", apiKeyId: "k" });
    await invokeWebAPI(fakeWs, { func: "webapi_cmd_send", apiKeyId: "k" });
    expect(keys[0]).toBe("biz3InvokeWebAPIs:webapi_history_get");
    expect(keys[1]).toBe("biz3InvokeWebAPIs:webapi_cmd_send");
    expect(keys[0]).not.toBe(keys[1]);
  });
});

// ---------------------------------------------------------------------------
// [WEB-0036] cli: webapi 系の CLI 露出は `webapi <func>` 1 本のみ
// ---------------------------------------------------------------------------

describe("[WEB-0036] cli: webapi 系 CLI は webapi <func> 1 本のみ (deviceState/deviceHistory/sendCmd 専用コマンド不在)", () => {
  const CLI_PATH = resolve(KIT_ROOT, "src", "cli", "device.js");
  const src = readFileSync(CLI_PATH, "utf8");

  it("[WEB-0036] registerDeviceCommands に 'webapi <func>' が 1 件登録されている", () => {
    const matches = src.match(/program\.command\(["']webapi /g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("[WEB-0036] 'webapi.deviceState' 専用コマンドが CLI に登録されていない", () => {
    expect(src).not.toContain('"webapi deviceState"');
    expect(src).not.toContain('"webapi-device-state"');
    expect(src).not.toContain("cmdWebapiDeviceState");
  });

  it("[WEB-0036] 'webapi.deviceHistory' 専用コマンドが CLI に登録されていない", () => {
    expect(src).not.toContain('"webapi deviceHistory"');
    expect(src).not.toContain('"webapi-device-history"');
    expect(src).not.toContain("cmdWebapiDeviceHistory");
  });

  it("[WEB-0036] 'webapi.sendCmd' 専用コマンドが CLI に登録されていない", () => {
    expect(src).not.toContain('"webapi sendCmd"');
    expect(src).not.toContain('"webapi-send-cmd"');
    expect(src).not.toContain("cmdWebapiSendCmd");
  });

  it("[WEB-0036] serve は webapi.{invoke,deviceState,deviceHistory,sendCmd} の 4 メソッドを公開している", () => {
    const reg = buildRegistry();
    expect(reg.get("webapi.invoke")).toBeTruthy();
    expect(reg.get("webapi.deviceState")).toBeTruthy();
    expect(reg.get("webapi.deviceHistory")).toBeTruthy();
    expect(reg.get("webapi.sendCmd")).toBeTruthy();
  });

  it("[WEB-0036] ts SDK は webapi.* の 4 メソッドを公開している (CLI の 1 本と面非対称)", () => {
    const TS_PATH = resolve(KIT_ROOT, "sdk", "ts", "sesame-client.ts");
    const tsSrc = readFileSync(TS_PATH, "utf8");
    expect(tsSrc).toContain('"webapi.invoke"');
    expect(tsSrc).toContain('"webapi.deviceState"');
    expect(tsSrc).toContain('"webapi.deviceHistory"');
    expect(tsSrc).toContain('"webapi.sendCmd"');
  });

  it("[WEB-0036] py SDK は _Webapi.* の 4 メソッドを公開している (CLI の 1 本と面非対称)", () => {
    const PY_PATH = resolve(KIT_ROOT, "sdk", "python", "sesame_client.py");
    const pySrc = readFileSync(PY_PATH, "utf8");
    expect(pySrc).toMatch(/_c\._call\(\s*["']webapi\.invoke["']/);
    expect(pySrc).toMatch(/_c\._call\(\s*["']webapi\.deviceState["']/);
    expect(pySrc).toMatch(/_c\._call\(\s*["']webapi\.deviceHistory["']/);
    expect(pySrc).toMatch(/_c\._call\(\s*["']webapi\.sendCmd["']/);
  });
});
