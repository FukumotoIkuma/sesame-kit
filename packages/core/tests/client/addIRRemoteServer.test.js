// Unit tests for SesameHub3.addIRRemoteServer (P3-2)。
//
// 上限ロジック出典: references_web/src/api/useRemoteCtrl.js:226-255 (canAddMoreRemote),
//                   同 :525-531 (addIRRemote が送信前にこのガードを通す)。
//
// テスト項目:
//   1. currentRemoteList 省略時は上限チェックをスキップして送信する (後方互換)。
//   2. プリセット 2 個 + 追加 → 3 個未満なので許可して送信する。
//   3. プリセット 3 個到達 → 4 個目を badRequest で拒否する (送信なし)。
//   4. type=0xfe00 (自己学習) は上限 3 個到達でも許可する。
//   5. プリセット 3 個到達 + type=0xfe00 → 許可。

import { describe, it, expect, vi } from "vitest";
import { WebSocketServer } from "ws";
import { SesameHub3 } from "../../src/client.js";
import { CONSUMER_CLIENT_ID } from "../../src/auth.js";

const COMPANY_ID = "co-test";
const HUB3_DEVICE_UUID = "hub3-uuid-abc";

/**
 * JWT stub (Cognito 経路を避けるため exp を十分未来に)。
 */
function makeIdToken() {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64");
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const payload = Buffer.from(JSON.stringify({ aud: CONSUMER_CLIENT_ID, sub: "test-sub", exp })).toString("base64");
  return `${header}.${payload}.sig`;
}

function makeTokenStore() {
  const idToken = makeIdToken();
  return {
    load: vi.fn(() => ({
      idToken,
      refreshToken: "r",
      clientId: CONSUMER_CLIENT_ID,
      deviceKey: "dk",
      deviceGroupKey: "dgk",
      devicePassword: "dp",
    })),
    save: vi.fn(),
    clear: vi.fn(),
    loadPending: vi.fn(() => null),
    savePending: vi.fn(),
    clearPending: vi.fn(),
  };
}

/**
 * 最小 WebSocket サーバを立ち上げて SesameHub3 に接続させるヘルパ。
 * addIRRemote frame が届いたら success:true で返す。
 * @param {(frames: object[]) => void} [onAddFrame] addIRRemote frame 受信コールバック
 */
async function withHub(fn) {
  /** @type {object[]} */
  const sentFrames = [];
  const server = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => server.on("listening", resolve));
  const port = server.address().port;

  server.on("connection", (ws) => {
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      sentFrames.push(msg);
      // 全メッセージに success:true で応答 (最小スタブ)
      ws.send(JSON.stringify({ ...msg, success: true, data: { saved: true } }));
    });
  });

  const tokenStore = makeTokenStore();
  const hub = new SesameHub3({
    config: {
      companyID: COMPANY_ID,
      wsUrl: `ws://localhost:${port}`,
      lang: "en",
      default: { remote: null, lock: null },
      hub3s: {},
      remotes: {},
      locks: {},
    },
    tokenStore,
  });
  await hub.connect();
  try {
    await fn(hub, sentFrames);
  } finally {
    await hub.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

/** remoteList のヘルパ */
function makeRemoteList(...types) {
  return types.map((type) => ({ type }));
}

describe("addIRRemoteServer (P3-2)", () => {
  it("currentRemoteList 省略時は上限チェックをスキップして送信する (後方互換)", async () => {
    await withHub(async (hub, frames) => {
      const remote = {
        uuid: "r-1",
        type: 0x8000,
        deviceUUID: HUB3_DEVICE_UUID,
        model: "M",
        state: "",
        alias: "扇風機",
        code: "c",
        keys: [],
      };
      // currentRemoteList を省略
      await hub.addIRRemoteServer(remote);
      const addFrame = frames.find((f) => f.op === "addIRRemote");
      expect(addFrame).toBeDefined();
      expect(addFrame.remote.uuid).toBe("r-1");
    });
  });

  it("プリセット 2 個 + 追加 → 許可して送信する", async () => {
    // references_web/src/api/useRemoteCtrl.js:252: counts < 3 → true
    await withHub(async (hub, frames) => {
      const remote = {
        uuid: "r-new",
        type: 0x2000,
        deviceUUID: HUB3_DEVICE_UUID,
        model: "TV",
        state: "",
        alias: "テレビ",
        code: "c",
        keys: [],
      };
      await hub.addIRRemoteServer(remote, {
        currentRemoteList: makeRemoteList(0x8000, 0xc000), // 2 個
      });
      const addFrame = frames.find((f) => f.op === "addIRRemote");
      expect(addFrame).toBeDefined();
    });
  });

  it("プリセット 3 個到達 → 4 個目を badRequest (code=bad_request) で拒否する", async () => {
    // references_web/src/api/useRemoteCtrl.js:244-252: counts >= 3 → false → 拒否
    await withHub(async (hub, frames) => {
      const remote = {
        uuid: "r-over",
        type: 0xc000,
        deviceUUID: HUB3_DEVICE_UUID,
        model: "AC",
        state: "",
        alias: "エアコン",
        code: "c",
        keys: [],
      };
      await expect(
        hub.addIRRemoteServer(remote, {
          currentRemoteList: makeRemoteList(0x8000, 0x2000, 0xe000), // 3 個 = 上限
        })
      ).rejects.toMatchObject({ code: "bad_request" });
      // 送信されていないこと
      expect(frames.find((f) => f.op === "addIRRemote")).toBeUndefined();
    });
  });

  it("type=0xfe00 (自己学習) はプリセット 3 個到達でも許可して送信する", async () => {
    // references_web/src/api/useRemoteCtrl.js:228-231: type === 0xfe00 → true (無制限)
    await withHub(async (hub, frames) => {
      const remote = {
        uuid: "r-learn",
        type: 0xfe00,
        deviceUUID: HUB3_DEVICE_UUID,
        model: "LEARN",
        state: "",
        alias: "学習",
        code: "",
        keys: [],
      };
      await hub.addIRRemoteServer(remote, {
        currentRemoteList: makeRemoteList(0x8000, 0x2000, 0xe000), // 3 個 = 上限
      });
      const addFrame = frames.find((f) => f.op === "addIRRemote");
      expect(addFrame).toBeDefined();
      expect(addFrame.remote.type).toBe(0xfe00);
    });
  });

  it("既存リスト内の 0xfe00 はカウントに含まれない (プリセット 2 個 + 学習 3 個でも許可)", async () => {
    await withHub(async (hub, frames) => {
      const remote = {
        uuid: "r-ac",
        type: 0xc000,
        deviceUUID: HUB3_DEVICE_UUID,
        model: "AC",
        state: "",
        alias: "エアコン",
        code: "c",
        keys: [],
      };
      await hub.addIRRemoteServer(remote, {
        currentRemoteList: makeRemoteList(0x8000, 0x2000, 0xfe00, 0xfe00, 0xfe00),
      });
      const addFrame = frames.find((f) => f.op === "addIRRemote");
      expect(addFrame).toBeDefined();
    });
  });
});
