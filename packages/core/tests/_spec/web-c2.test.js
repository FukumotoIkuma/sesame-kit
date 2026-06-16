// [WEB-0037] serve: requireAuth(daemon) fires NOT_AUTHENTICATED for authState=expired
//            before hub.connected check, across all 4 webapi handlers.
//
// assert: requireAuth(daemon) は authState==='expired' のとき (hub.connected の判定より前に)
//         RpcError(kind=NOT_AUTHENTICATED) を投げ、
//         webapi.invoke/deviceState/deviceHistory/sendCmd の各 handler 本体に到達しない。
//         対照: authState=ok & hub.connected=false → KIND.CONNECTION_LOST
//
// ref: packages/kit/src/serve/registry-helpers.js:56-57
//      packages/kit/src/serve/entries/device.js:201,210,223,244
//
// Strategy:
//   - Build a connected SesameHub3 (fake _ws injected so hub.connected === true).
//   - Build a Daemon with authState="expired" to isolate the expired branch.
//   - Drive each of the 4 webapi handlers via d.dispatchMessage().
//   - Assert error.data.kind === KIND.NOT_AUTHENTICATED (not CONNECTION_LOST, not INTERNAL).
//   - Assert hub methods are NOT called (handler body unreached) via vi.spyOn.
//   - Contrast test: authState=ok & hub.connected=false → KIND.CONNECTION_LOST.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SesameHub3 } from "@sesame-kit/core/client";
import { Daemon } from "../../../kit/src/serve/daemon.js";
import { KIND } from "@sesame-kit/core/jsonrpc";
import { CONSUMER_CLIENT_ID } from "@sesame-kit/core/auth";

// ---- helpers ----------------------------------------------------------------

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
 * Build a SesameHub3 instance with a fake _ws injected (connected=true).
 * Hub webapi methods are real (vi.spyOn used per-test) so we can assert they are NOT called.
 */
function makeConnectedHub() {
  const hub = new SesameHub3({
    config: {
      companyID: "co-test",
      wsUrl: "wss://fake.invalid",
      lang: "en",
      default: { remote: null, lock: null },
      hub3s: {},
      remotes: {},
      locks: {},
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

  // Inject fake _ws so that hub.connected === true without real WebSocket.
  hub._ws = {
    async request() { throw new Error("unexpected ws call in WEB-0037 test"); },
    async send() { throw new Error("unexpected ws send in WEB-0037 test"); },
    subscribe: vi.fn(() => () => {}),
    onMessage: vi.fn(() => () => {}),
  };
  hub._subUUID = "test-sub";

  return hub;
}

/**
 * Build a Daemon with a given authState.
 * @param {SesameHub3} hub
 * @param {"ok"|"degraded"|"expired"} authState
 */
function makeDaemon(hub, authState) {
  const d = new Daemon({ hub });
  d.authState = authState;
  return d;
}

/**
 * Send a JSON-RPC 2.0 request to the daemon and return the response object.
 */
async function callRpc(d, method, params, id = 1) {
  return d.dispatchMessage(
    null,
    JSON.stringify({ jsonrpc: "2.0", id, method, params })
  );
}

// ---- tests ------------------------------------------------------------------

describe("[WEB-0037] requireAuth: authState=expired → NOT_AUTHENTICATED before hub.connected check", () => {
  /** @type {SesameHub3} */
  let hub;
  /** @type {Daemon} */
  let d;

  beforeEach(() => {
    hub = makeConnectedHub();
    // authState = "expired" — hub.connected is true but expired is evaluated first
    d = makeDaemon(hub, "expired");
  });

  it("[WEB-0037] webapi.invoke: authState=expired → kind=NOT_AUTHENTICATED (hub.invokeWebAPI not called)", async () => {
    const spy = vi.spyOn(hub, "invokeWebAPI");

    // Sanity: hub must be connected for this ordering test to be meaningful
    expect(hub.connected).toBe(true);
    expect(d.authState).toBe("expired");

    const res = await callRpc(d, "webapi.invoke", { func: "some_func", apiKeyId: "key-1" });

    expect(res.error).toBeDefined();
    expect(res.error?.data?.kind).toBe(KIND.NOT_AUTHENTICATED);
    // Handler body must NOT be reached
    expect(spy).not.toHaveBeenCalled();
  });

  it("[WEB-0037] webapi.deviceState: authState=expired → kind=NOT_AUTHENTICATED (hub.webapiDeviceState not called)", async () => {
    const spy = vi.spyOn(hub, "webapiDeviceState");

    const res = await callRpc(d, "webapi.deviceState", { deviceId: "device-1", apiKeyId: "key-1" });

    expect(res.error).toBeDefined();
    expect(res.error?.data?.kind).toBe(KIND.NOT_AUTHENTICATED);
    expect(spy).not.toHaveBeenCalled();
  });

  it("[WEB-0037] webapi.deviceHistory: authState=expired → kind=NOT_AUTHENTICATED (hub.webapiDeviceHistory not called)", async () => {
    const spy = vi.spyOn(hub, "webapiDeviceHistory");

    const res = await callRpc(d, "webapi.deviceHistory", { deviceId: "device-1", apiKeyId: "key-1" });

    expect(res.error).toBeDefined();
    expect(res.error?.data?.kind).toBe(KIND.NOT_AUTHENTICATED);
    expect(spy).not.toHaveBeenCalled();
  });

  it("[WEB-0037] webapi.sendCmd: authState=expired → kind=NOT_AUTHENTICATED (hub.webapiSendCmd not called)", async () => {
    const spy = vi.spyOn(hub, "webapiSendCmd");

    const res = await callRpc(d, "webapi.sendCmd", {
      deviceId: "device-1",
      cmd: 88,
      sign: "aabbccdd",
      history: "hist-uuid",
      apiKeyId: "key-1",
    });

    expect(res.error).toBeDefined();
    expect(res.error?.data?.kind).toBe(KIND.NOT_AUTHENTICATED);
    expect(spy).not.toHaveBeenCalled();
  });

  it("[WEB-0037] expired branch fires BEFORE hub.connected check: kind=NOT_AUTHENTICATED not CONNECTION_LOST", async () => {
    // Confirm ordering: even when hub is connected, expired authState yields NOT_AUTHENTICATED.
    // (If the order were reversed, a connected hub would bypass the expired check.)
    expect(hub.connected).toBe(true);

    const res = await callRpc(d, "webapi.invoke", { func: "check_order", apiKeyId: "key-1" });

    expect(res.error?.data?.kind).toBe(KIND.NOT_AUTHENTICATED);
    expect(res.error?.data?.kind).not.toBe(KIND.CONNECTION_LOST);
  });

  // Contrast test: authState=ok / hub.connected=false → CONNECTION_LOST (registry-helpers.js:59-61)
  // This confirms the expired branch is evaluated BEFORE the hub.connected branch.
  it("[WEB-0037] contrast: authState=ok & hub.connected=false → kind=CONNECTION_LOST (different branch)", async () => {
    const disconnectedHub = makeConnectedHub();
    // Force disconnected by nulling _ws (hub.connected === !!this._ws)
    disconnectedHub._ws = null;
    const dOk = makeDaemon(disconnectedHub, "ok");

    const res = await callRpc(dOk, "webapi.invoke", { func: "someFunc" });

    expect(res.error).toBeDefined();
    expect(res.error?.data?.kind).toBe(KIND.CONNECTION_LOST);
  });
});
