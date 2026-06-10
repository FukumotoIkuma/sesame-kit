// Unit tests for getValidIdToken(store, {marginSec}) in src/auth.js
//
// Strategy:
//   - vi.mock("@aws-sdk/client-cognito-identity-provider") で
//     CognitoIdentityProviderClient.send() を差し替え、Cognito 呼び出しを観測可能にする。
//   - InitiateAuthCommand は実体 (引数を保持する単純な class) を差し替えて、
//     send() に渡された input を取り出せるようにする。
//   - in-memory TokenStore モックを毎テスト fresh に作る。
//   - JWT は本物の base64url payload を組み立てて jwtExp が exp を取れるようにする
//     (本当の署名検証はしないので header / signature は dummy で OK)。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// --- mock @aws-sdk/client-cognito-identity-provider ----------------------------------
//
// CognitoIdentityProviderClient: send() を vi.fn() で持つコンストラクタ。
// InitiateAuthCommand: input を保持する単純な class (元実装も実質これ)。
// 他のコマンドも空 class でスタブしておく (auth.js が import している)。
//
// auth.js は `new CognitoIdentityProviderClient(...)` をモジュール先頭で 1 回呼び、
// そのインスタンスを使い回す。だから sendMock を module スコープで保持し、
// 各 it で mockReset() する。

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-cognito-identity-provider", () => {
  class CognitoIdentityProviderClient {
    constructor(cfg) {
      this.cfg = cfg;
    }
    send(...args) {
      return sendMock(...args);
    }
  }
  class InitiateAuthCommand {
    constructor(input) {
      this.input = input;
      this.__name = "InitiateAuthCommand";
    }
  }
  class RespondToAuthChallengeCommand {
    constructor(input) { this.input = input; this.__name = "RespondToAuthChallengeCommand"; }
  }
  class SignUpCommand {
    constructor(input) { this.input = input; this.__name = "SignUpCommand"; }
  }
  const command = (name) => class {
    constructor(input) { this.input = input; this.__name = name; }
  };
  return {
    CognitoIdentityProviderClient,
    InitiateAuthCommand,
    RespondToAuthChallengeCommand,
    SignUpCommand,
    ConfirmDeviceCommand: command("ConfirmDeviceCommand"),
    UpdateDeviceStatusCommand: command("UpdateDeviceStatusCommand"),
    ForgetDeviceCommand: command("ForgetDeviceCommand"),
    RevokeTokenCommand: command("RevokeTokenCommand"),
  };
});

// auth.js は mock 後に import する (vi.mock は hoist されるので順序は OK だが明示的に下に置く)
const { getValidIdToken, CONSUMER_CLIENT_ID } = await import("../../src/auth.js");

// --- helpers ------------------------------------------------------------------------

const CONFIRMED_DEVICE = {
  deviceKey: "dev-key-abc",
  deviceGroupKey: "dev-group-abc",
  devicePassword: "dev-password-abc",
};

/** base64url encode (no padding) */
function b64url(obj) {
  return Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/** dummy JWT with given exp (UNIX秒) と任意 claims */
function makeJwt(exp, extra = {}) {
  const header  = b64url({ alg: "RS256", typ: "JWT" });
  const payload = b64url({ aud: CONSUMER_CLIENT_ID, exp, ...extra });
  const sig     = "sigsig";
  return `${header}.${payload}.${sig}`;
}

/** in-memory TokenStore mock */
function makeStore(initial) {
  let state = initial ? { ...CONFIRMED_DEVICE, ...initial } : null;
  return {
    load: vi.fn(() => state),
    save: vi.fn((t) => { state = { ...t }; }),
    clear: vi.fn(() => { state = null; }),
    // pending 系は getValidIdToken では使わないが、interface 互換のため
    loadPending: vi.fn(() => null),
    savePending: vi.fn(),
    clearPending: vi.fn(),
    // テスト側から覗くためのアクセサ
    _peek: () => state,
  };
}

// --- tests --------------------------------------------------------------------------

describe("getValidIdToken", () => {
  beforeEach(() => {
    sendMock.mockReset();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("正常系: refresh 不要", () => {
    it("有効期限まで marginSec より大きい余裕がある idToken をそのまま返す", async () => {
      const now = 1_700_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);

      const idToken = makeJwt(now + 3600); // 1h 先
      const store = makeStore({
        idToken,
        refreshToken: "rt-xxx",
        clientId: CONSUMER_CLIENT_ID,
      });

      const got = await getValidIdToken(store);

      expect(got).toBe(idToken);
      expect(sendMock).not.toHaveBeenCalled();
      expect(store.save).not.toHaveBeenCalled();
    });

    it("marginSec をカスタム値にしても、それより余裕があれば refresh しない", async () => {
      const now = 1_700_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);

      const idToken = makeJwt(now + 600); // 10 分先
      const store = makeStore({ idToken, refreshToken: "rt", clientId: CONSUMER_CLIENT_ID });

      const got = await getValidIdToken(store, { marginSec: 300 }); // 5 分

      expect(got).toBe(idToken);
      expect(sendMock).not.toHaveBeenCalled();
    });

    it("未失効 idToken でも ConfirmDevice 済み device credentials が無ければ拒否する", async () => {
      const now = 1_700_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);

      const idToken = makeJwt(now + 3600);
      const store = makeStore({
        idToken,
        refreshToken: "rt",
        clientId: CONSUMER_CLIENT_ID,
        deviceKey: null,
        deviceGroupKey: null,
        devicePassword: null,
      });

      await expect(getValidIdToken(store)).rejects.toThrow(/missing confirmed Cognito device credentials/);
      expect(sendMock).not.toHaveBeenCalled();
    });
  });

  describe("異常系: store の状態", () => {
    it("store.load() が null を返したら 'No tokens stored' で throw", async () => {
      const store = makeStore(null);
      await expect(getValidIdToken(store)).rejects.toThrow(/No tokens stored/);
      expect(sendMock).not.toHaveBeenCalled();
    });

    it("idToken は expired だが refreshToken が無いと throw", async () => {
      const now = 1_700_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);

      const idToken = makeJwt(now - 10); // すでに過去
      const store = makeStore({ idToken, refreshToken: null, clientId: CONSUMER_CLIENT_ID });

      await expect(getValidIdToken(store)).rejects.toThrow(/idToken expired and no refreshToken/);
      expect(sendMock).not.toHaveBeenCalled();
    });

    it("idToken が壊れていて exp=0 (= 大過去扱い) + refreshToken 無しでも throw", async () => {
      const store = makeStore({ idToken: "not-a-jwt", refreshToken: null });
      await expect(getValidIdToken(store)).rejects.toThrow(/idToken expired and no refreshToken/);
    });
  });

  describe("refresh 経路", () => {
    it("margin 以内なら REFRESH_TOKEN_AUTH で refresh して新 idToken を返す", async () => {
      const now = 1_700_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);

      const oldToken = makeJwt(now + 30); // 30秒後 (margin 60 以内)
      const newToken = makeJwt(now + 3600);
      const store = makeStore({
        idToken: oldToken,
        refreshToken: "rt-old",
        clientId: CONSUMER_CLIENT_ID,
      });

      sendMock.mockResolvedValueOnce({
        AuthenticationResult: {
          IdToken: newToken,
          AccessToken: "at-new",
        },
      });

      const got = await getValidIdToken(store);

      expect(got).toBe(newToken);
      expect(sendMock).toHaveBeenCalledTimes(1);
      const cmd = sendMock.mock.calls[0][0];
      expect(cmd.__name).toBe("InitiateAuthCommand");
      expect(cmd.input).toEqual({
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: CONSUMER_CLIENT_ID,
        AuthParameters: { REFRESH_TOKEN: "rt-old", DEVICE_KEY: CONFIRMED_DEVICE.deviceKey },
      });
      expect(store.save).toHaveBeenCalledTimes(1);
      expect(store._peek().idToken).toBe(newToken);
      expect(store._peek().accessToken).toBe("at-new");
    });

    it("すでに expired でも refreshToken があれば refresh する", async () => {
      const now = 1_700_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);

      const expired = makeJwt(now - 1000);
      const fresh   = makeJwt(now + 3600);
      const store = makeStore({ idToken: expired, refreshToken: "rt", clientId: CONSUMER_CLIENT_ID });

      sendMock.mockResolvedValueOnce({ AuthenticationResult: { IdToken: fresh } });

      const got = await getValidIdToken(store);
      expect(got).toBe(fresh);
      expect(sendMock).toHaveBeenCalledTimes(1);
    });

    it("ConfirmDevice 済み token は AuthParameters に DEVICE_KEY を含める", async () => {
      const now = 1_700_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);

      const store = makeStore({
        idToken: makeJwt(now - 1),
        refreshToken: "rt",
        clientId: CONSUMER_CLIENT_ID,
      });
      sendMock.mockResolvedValueOnce({ AuthenticationResult: { IdToken: makeJwt(now + 3600) } });

      await getValidIdToken(store);

      const cmd = sendMock.mock.calls[0][0];
      expect(cmd.input.AuthParameters).toEqual({
        REFRESH_TOKEN: "rt",
        DEVICE_KEY: CONFIRMED_DEVICE.deviceKey,
      });
    });

    it("store.clientId が無い場合は DEFAULT_CLIENT_ID (= CONSUMER_CLIENT_ID) を使う", async () => {
      const now = 1_700_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);

      const store = makeStore({
        idToken: makeJwt(now - 1),
        refreshToken: "rt",
        // clientId 未設定
      });
      sendMock.mockResolvedValueOnce({ AuthenticationResult: { IdToken: makeJwt(now + 3600) } });

      await getValidIdToken(store);

      const cmd = sendMock.mock.calls[0][0];
      expect(cmd.input.ClientId).toBe(CONSUMER_CLIENT_ID);
    });

    it("store.clientId が Consumer Client 以外なら refresh せず拒否する", async () => {
      const now = 1_700_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);

      const customClient = "custom-client-id-xyz";
      const store = makeStore({
        idToken: makeJwt(now - 1, { aud: CONSUMER_CLIENT_ID }),
        refreshToken: "rt",
        clientId: customClient,
      });
      sendMock.mockResolvedValueOnce({ AuthenticationResult: { IdToken: makeJwt(now + 3600) } });

      await expect(getValidIdToken(store)).rejects.toThrow(/unsupported Cognito clientId|Only the SESAME consumer app client/);
      expect(sendMock).not.toHaveBeenCalled();
    });

    it("refresh 前に ConfirmDevice 済み device credentials が無ければ拒否する", async () => {
      const now = 1_700_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);

      const store = makeStore({
        idToken: makeJwt(now - 1),
        refreshToken: "rt",
        clientId: CONSUMER_CLIENT_ID,
        deviceKey: null,
        deviceGroupKey: null,
        devicePassword: null,
      });

      await expect(getValidIdToken(store)).rejects.toThrow(/missing confirmed Cognito device credentials/);
      expect(sendMock).not.toHaveBeenCalled();
    });

    it("rotation: response.RefreshToken があれば store に新 refreshToken を保存する", async () => {
      const now = 1_700_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);

      const store = makeStore({
        idToken: makeJwt(now - 1),
        refreshToken: "rt-old",
        clientId: CONSUMER_CLIENT_ID,
      });
      sendMock.mockResolvedValueOnce({
        AuthenticationResult: {
          IdToken: makeJwt(now + 3600),
          AccessToken: "at-new",
          RefreshToken: "rt-new-rotated",
        },
      });

      await getValidIdToken(store);

      expect(store._peek().refreshToken).toBe("rt-new-rotated");
      expect(store._peek().accessToken).toBe("at-new");
    });

    it("rotation 無し (response.RefreshToken 欠落) でも既存 refreshToken は維持される", async () => {
      const now = 1_700_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);

      const store = makeStore({
        idToken: makeJwt(now - 1),
        refreshToken: "rt-old-keep",
        clientId: CONSUMER_CLIENT_ID,
      });
      sendMock.mockResolvedValueOnce({
        AuthenticationResult: { IdToken: makeJwt(now + 3600) },
      });

      await getValidIdToken(store);

      expect(store._peek().refreshToken).toBe("rt-old-keep");
    });

    it("lastRefresh を ISO 文字列で更新する", async () => {
      const fixedMs = Date.UTC(2026, 5, 1, 12, 0, 0); // 2026-06-01T12:00:00.000Z
      vi.useFakeTimers();
      vi.setSystemTime(fixedMs);

      const now = Math.floor(fixedMs / 1000);
      const store = makeStore({
        idToken: makeJwt(now - 1),
        refreshToken: "rt",
        clientId: CONSUMER_CLIENT_ID,
      });
      sendMock.mockResolvedValueOnce({
        AuthenticationResult: { IdToken: makeJwt(now + 3600) },
      });

      await getValidIdToken(store);

      expect(store._peek().lastRefresh).toBe("2026-06-01T12:00:00.000Z");
    });
  });

  describe("Cognito エラー伝播", () => {
    it("AuthenticationResult が無い response は throw する", async () => {
      const now = 1_700_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);

      const store = makeStore({
        idToken: makeJwt(now - 1),
        refreshToken: "rt",
        clientId: CONSUMER_CLIENT_ID,
      });
      sendMock.mockResolvedValueOnce({ ChallengeName: "SOMETHING_ELSE" });

      await expect(getValidIdToken(store)).rejects.toThrow(/Cognito refresh returned no IdToken/);
      expect(store.save).not.toHaveBeenCalled();
    });

    it("AuthenticationResult.IdToken が空でも throw する", async () => {
      const now = 1_700_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);

      const store = makeStore({
        idToken: makeJwt(now - 1),
        refreshToken: "rt",
        clientId: CONSUMER_CLIENT_ID,
      });
      sendMock.mockResolvedValueOnce({ AuthenticationResult: { AccessToken: "at" } });

      await expect(getValidIdToken(store)).rejects.toThrow(/no IdToken/);
      expect(store.save).not.toHaveBeenCalled();
    });

    it("cognito.send が reject したら、その error をそのまま伝播し store.save は呼ばれない", async () => {
      const now = 1_700_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);

      const store = makeStore({
        idToken: makeJwt(now - 1),
        refreshToken: "rt-bad",
        clientId: CONSUMER_CLIENT_ID,
      });
      const err = Object.assign(new Error("NotAuthorizedException: refresh token expired"), {
        name: "NotAuthorizedException",
      });
      sendMock.mockRejectedValueOnce(err);

      await expect(getValidIdToken(store)).rejects.toThrow(/NotAuthorizedException/);
      expect(store.save).not.toHaveBeenCalled();
    });
  });

  describe("並行呼び出し", () => {
    it("同じ store に対して同時 2 回 refresh しても、両方が新 idToken を返す (現実装は de-dup しない)", async () => {
      const now = 1_700_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);

      const store = makeStore({
        idToken: makeJwt(now - 1),
        refreshToken: "rt",
        clientId: CONSUMER_CLIENT_ID,
      });

      const newToken1 = makeJwt(now + 3600, { iat: 1 });
      const newToken2 = makeJwt(now + 3600, { iat: 2 });
      sendMock
        .mockResolvedValueOnce({ AuthenticationResult: { IdToken: newToken1 } })
        .mockResolvedValueOnce({ AuthenticationResult: { IdToken: newToken2 } });

      const [a, b] = await Promise.all([getValidIdToken(store), getValidIdToken(store)]);

      // 現実装は per-call cognito.send なので 2 回叩かれる (de-dup なし) ことを確認
      expect(sendMock).toHaveBeenCalledTimes(2);
      // 両方とも有効な idToken を返す
      expect([newToken1, newToken2]).toContain(a);
      expect([newToken1, newToken2]).toContain(b);
      // save も 2 回 (最後勝ち)
      expect(store.save).toHaveBeenCalledTimes(2);
    });
  });
});
