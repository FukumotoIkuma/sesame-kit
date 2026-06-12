// P5-1 回帰テスト: 呼び出し側不正が serve 経由で kind=internal に化けないことを保証。
//
// 「serve 到達面の代表 method × bad input で error.data.kind !== "internal"」のテーブル駆動テスト。
// SesameHub3 + Daemon + dispatchMessage を通して実際の errorFromThrow の写像を確認する。
//
// テスト戦略:
//   - SesameHub3 を最小 config で直構築し、hub._ws にフェイク WS を注入して "接続済み" に見せる。
//   - Daemon.authState = "ok" にして requireAuth ガードを通す。
//   - d.dispatchMessage(null, jsonString) → error.data.kind を検証。
//   - kind=internal が返ったら P5-1 の修正が効いていない。
import { describe, it, expect, beforeEach } from "vitest";
import { SesameHub3 } from "../../src/client.js";
import { Daemon } from "../../src/serve/daemon.js";
import { KIND } from "../../src/jsonrpc.js";
import { CONSUMER_CLIENT_ID } from "../../src/auth.js";

// ---- helper ----------------------------------------------------------------

const CONFIRMED_DEVICE = {
  deviceKey: "dev-key",
  deviceGroupKey: "dev-group",
  devicePassword: "dev-password",
};

function makeIdToken({ sub = "test-sub", expOffsetSec = 3600 } = {}) {
  const exp = Math.floor(Date.now() / 1000) + expOffsetSec;
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64");
  const payload = Buffer.from(JSON.stringify({ aud: CONSUMER_CLIENT_ID, sub, exp })).toString("base64");
  return `${header}.${payload}.sig`;
}

/**
 * 接続済みの SesameHub3 インスタンスを作る。
 * hub._ws に最小フェイク WS を注入することで connected=true にする。
 * remotes に "default" を持ち、その keys に "ac-off" → "cmd-uuid" がある config。
 * @param {object} [cfgOverride]
 */
function makeConnectedHub(cfgOverride = {}) {
  const hub = new SesameHub3({
    config: {
      companyID: "ch_test",
      wsUrl: "wss://fake.invalid",
      lang: "en",
      default: { remote: "default", lock: null },
      hub3s: { "main": { deviceId: "aabb" } },
      remotes: {
        "default": {
          hub3: "main",
          irDeviceUUID: "00000000-0000-0000-0000-000000000000",
          irType: "0xc000",
          irOperation: "remoteEmit",
          keys: { "ac-off": "cmd-uuid-0000" },
        },
      },
      locks: {},
      ...cfgOverride,
    },
    tokenStore: {
      load: () => ({ idToken: makeIdToken(), refreshToken: "r", clientId: CONSUMER_CLIENT_ID, ...CONFIRMED_DEVICE }),
      save() {},
      clear() {},
    },
  });
  // _ws フェイクを直注入して connected = true にする。
  // フェイクは request() を reject する (実際の WS 通信は走らない)。
  hub._ws = {
    async request() { throw new Error("unexpected ws call in unit test"); },
    async send() { throw new Error("unexpected ws send in unit test"); },
  };
  hub._subUUID = "test-sub";
  return hub;
}

/**
 * Daemon を "ok" 状態で作る。
 * @param {SesameHub3} hub
 */
function makeActiveDaemon(hub) {
  const d = new Daemon({ hub });
  d.authState = "ok";
  return d;
}

/**
 * dispatchMessage ヘルパ: JSON-RPC メッセージを文字列として送り、応答を返す。
 * @param {Daemon} d
 * @param {string} method
 * @param {Record<string, unknown>} params
 * @param {number} [id]
 * @returns {Promise<{error?: {data?: {kind?: string}}}>}
 */
async function callRpc(d, method, params, id = 1) {
  return d.dispatchMessage(null, JSON.stringify({ jsonrpc: "2.0", id, method, params }));
}

// ---- tests -----------------------------------------------------------------

describe("P5-1: serve 到達面の代表 method × bad input → kind !== internal", () => {
  /** @type {SesameHub3} */
  let hub;
  /** @type {Daemon} */
  let d;

  beforeEach(() => {
    hub = makeConnectedHub();
    d = makeActiveDaemon(hub);
  });

  // テーブル: [ケース名, method, params, expected kind]
  const CASES = [
    [
      "ir.send: key が空文字 → BAD_REQUEST (keyRequired)",
      "ir.send",
      { key: "" },
      KIND.BAD_PARAMS,
    ],
    [
      "ir.send: 存在しないキー名 → BAD_REQUEST (unknownKey)",
      "ir.send",
      { key: "totally-nonexistent-key" },
      KIND.BAD_PARAMS,
    ],
    [
      "webapi.invoke: apiKeyId 未設定 → BAD_REQUEST",
      "webapi.invoke",
      { func: "someFunc" },
      KIND.BAD_PARAMS,
    ],
    [
      "webapi.deviceState: apiKeyId 未設定 → BAD_REQUEST",
      "webapi.deviceState",
      { deviceId: "device-1" },
      KIND.BAD_PARAMS,
    ],
    [
      "webapi.deviceHistory: apiKeyId 未設定 → BAD_REQUEST",
      "webapi.deviceHistory",
      { deviceId: "device-1" },
      KIND.BAD_PARAMS,
    ],
    [
      "webapi.sendCmd: apiKeyId 未設定 → BAD_REQUEST",
      "webapi.sendCmd",
      { deviceId: "device-1" },
      KIND.BAD_PARAMS,
    ],
  ];

  for (const [name, method, params, expectedKind] of CASES) {
    it(name, async () => {
      const res = await callRpc(d, method, params);
      expect(res).toBeDefined();
      expect(res.error).toBeDefined();
      const actualKind = res.error?.data?.kind;
      expect(
        actualKind,
        `expected kind="${expectedKind}" but got "${actualKind}" for ${method} (P5-1: 呼び出し側不正は internal に化けてはいけない)`,
      ).toBe(expectedKind);
    });
  }

  it("device.rename: subUUID なし → connection_lost (NOT_CONNECTED)", async () => {
    // subUUID を null にして「接続済みだが subUUID 未取得」状態をシミュレート
    hub._subUUID = null;
    const res = await callRpc(d, "device.rename", { deviceUUID: "uuid-1", deviceName: "myLock" });
    expect(res.error?.data?.kind).toBe(KIND.CONNECTION_LOST);
  });

  it("素の Error は依然 internal (方針3 確認: 内部不変条件はそのまま)", async () => {
    // hub に内部エラーを返す fake メソッドを注入してテスト
    // listDevices は registry で devices.list → hub.listDevices に委譲されている。
    hub.listDevices = async () => { throw new Error("internal invariant violated"); };
    const res = await callRpc(d, "devices.list", {});
    expect(res.error?.data?.kind).toBe(KIND.INTERNAL);
  });
});
