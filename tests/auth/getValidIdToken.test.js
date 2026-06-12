// Unit tests for getValidIdToken(store, {marginSec}) in src/auth.js
//
// Strategy:
//   - P2-2: auth.js は Cognito を素 fetch (src/cognito-http.js) で叩くため、
//     global.fetch を vi.stubGlobal で差し替えて観測する (cognito-fetch-mock.js)。
//     アサート対象のリクエスト形 (AuthFlow / AuthParameters 等) は SDK 時代と不変。
//   - in-memory TokenStore モックを毎テスト fresh に作る。
//   - JWT は本物の base64url payload を組み立てて jwtExp が exp を取れるようにする
//     (本当の署名検証はしないので header / signature は dummy で OK)。

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  fetchMock,
  installFetchMock,
  cognitoOk,
  cognitoError,
  cognitoCalls,
} from "./cognito-fetch-mock.js";

installFetchMock();

import { getValidIdToken, CONSUMER_CLIENT_ID } from "../../src/auth.js";

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
    fetchMock.mockReset();
    vi.useRealTimers();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
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
      expect(fetchMock).not.toHaveBeenCalled();
      expect(store.save).not.toHaveBeenCalled();
    });

    it("既定 marginSec=120 (CognitoIdentityProviderClientConfig.java:40): 残り 121 秒なら refresh しない", async () => {
      const now = 1_700_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);

      const idToken = makeJwt(now + 121); // 120 より 1 秒だけ余裕
      const store = makeStore({ idToken, refreshToken: "rt", clientId: CONSUMER_CLIENT_ID });

      const got = await getValidIdToken(store);

      expect(got).toBe(idToken);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("marginSec をカスタム値にしても、それより余裕があれば refresh しない", async () => {
      const now = 1_700_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);

      const idToken = makeJwt(now + 600); // 10 分先
      const store = makeStore({ idToken, refreshToken: "rt", clientId: CONSUMER_CLIENT_ID });

      const got = await getValidIdToken(store, { marginSec: 300 }); // 5 分

      expect(got).toBe(idToken);
      expect(fetchMock).not.toHaveBeenCalled();
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
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("異常系: store の状態", () => {
    it("store.load() が null を返したら 'No tokens stored' で throw", async () => {
      const store = makeStore(null);
      await expect(getValidIdToken(store)).rejects.toThrow(/No tokens stored/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("idToken は expired だが refreshToken が無いと throw", async () => {
      const now = 1_700_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);

      const idToken = makeJwt(now - 10); // すでに過去
      const store = makeStore({ idToken, refreshToken: null, clientId: CONSUMER_CLIENT_ID });

      await expect(getValidIdToken(store)).rejects.toThrow(/idToken expired and no refreshToken/);
      expect(fetchMock).not.toHaveBeenCalled();
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

      const oldToken = makeJwt(now + 30); // 30秒後 (margin 120 以内)
      const newToken = makeJwt(now + 3600);
      const store = makeStore({
        idToken: oldToken,
        refreshToken: "rt-old",
        clientId: CONSUMER_CLIENT_ID,
      });

      fetchMock.mockResolvedValueOnce(cognitoOk({
        AuthenticationResult: {
          IdToken: newToken,
          AccessToken: "at-new",
        },
      }));

      const got = await getValidIdToken(store);

      expect(got).toBe(newToken);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = cognitoCalls()[0];
      expect(call.op).toBe("InitiateAuth");
      expect(call.input).toEqual({
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: CONSUMER_CLIENT_ID,
        AuthParameters: { REFRESH_TOKEN: "rt-old", DEVICE_KEY: CONFIRMED_DEVICE.deviceKey },
      });
      expect(store.save).toHaveBeenCalledTimes(1);
      expect(store._peek().idToken).toBe(newToken);
      expect(store._peek().accessToken).toBe("at-new");
    });

    it("既定 marginSec=120: 残り 100 秒 (60 < 100 < 120) でも refresh する", async () => {
      const now = 1_700_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);

      const oldToken = makeJwt(now + 100);
      const newToken = makeJwt(now + 3600);
      const store = makeStore({ idToken: oldToken, refreshToken: "rt", clientId: CONSUMER_CLIENT_ID });
      fetchMock.mockResolvedValueOnce(cognitoOk({ AuthenticationResult: { IdToken: newToken } }));

      const got = await getValidIdToken(store);
      expect(got).toBe(newToken);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("すでに expired でも refreshToken があれば refresh する", async () => {
      const now = 1_700_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);

      const expired = makeJwt(now - 1000);
      const fresh   = makeJwt(now + 3600);
      const store = makeStore({ idToken: expired, refreshToken: "rt", clientId: CONSUMER_CLIENT_ID });

      fetchMock.mockResolvedValueOnce(cognitoOk({ AuthenticationResult: { IdToken: fresh } }));

      const got = await getValidIdToken(store);
      expect(got).toBe(fresh);
      expect(fetchMock).toHaveBeenCalledTimes(1);
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
      fetchMock.mockResolvedValueOnce(cognitoOk({ AuthenticationResult: { IdToken: makeJwt(now + 3600) } }));

      await getValidIdToken(store);

      expect(cognitoCalls()[0].input.AuthParameters).toEqual({
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
      fetchMock.mockResolvedValueOnce(cognitoOk({ AuthenticationResult: { IdToken: makeJwt(now + 3600) } }));

      await getValidIdToken(store);

      expect(cognitoCalls()[0].input.ClientId).toBe(CONSUMER_CLIENT_ID);
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
      fetchMock.mockResolvedValueOnce(cognitoOk({ AuthenticationResult: { IdToken: makeJwt(now + 3600) } }));

      await expect(getValidIdToken(store)).rejects.toThrow(/unsupported Cognito clientId|Only the SESAME consumer app client/);
      expect(fetchMock).not.toHaveBeenCalled();
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
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rotation: response.RefreshToken があれば store に新 refreshToken を保存する (参照 SDK は旧 token 維持だが意図的逸脱)", async () => {
      const now = 1_700_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);

      const store = makeStore({
        idToken: makeJwt(now - 1),
        refreshToken: "rt-old",
        clientId: CONSUMER_CLIENT_ID,
      });
      fetchMock.mockResolvedValueOnce(cognitoOk({
        AuthenticationResult: {
          IdToken: makeJwt(now + 3600),
          AccessToken: "at-new",
          RefreshToken: "rt-new-rotated",
        },
      }));

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
      fetchMock.mockResolvedValueOnce(cognitoOk({
        AuthenticationResult: { IdToken: makeJwt(now + 3600) },
      }));

      await getValidIdToken(store);

      expect(store._peek().refreshToken).toBe("rt-old-keep");
    });

    it("P2-5: refresh 応答に NewDeviceMetadata が来ても再 ConfirmDevice しない (CognitoUser.java:2865-2876 に処理は無い)", async () => {
      const now = 1_700_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);

      const store = makeStore({
        idToken: makeJwt(now - 1),
        refreshToken: "rt",
        clientId: CONSUMER_CLIENT_ID,
      });
      fetchMock.mockResolvedValueOnce(cognitoOk({
        AuthenticationResult: {
          IdToken: makeJwt(now + 3600),
          AccessToken: "at",
          NewDeviceMetadata: { DeviceKey: "rotated-dev", DeviceGroupKey: "rotated-grp" },
        },
      }));

      await getValidIdToken(store);

      // ConfirmDevice の追加 fetch は発生せず、保存済み device 3 点は不変
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(cognitoCalls().map((c) => c.op)).toEqual(["InitiateAuth"]);
      expect(store._peek().deviceKey).toBe(CONFIRMED_DEVICE.deviceKey);
      expect(store._peek().deviceGroupKey).toBe(CONFIRMED_DEVICE.deviceGroupKey);
      expect(store._peek().devicePassword).toBe(CONFIRMED_DEVICE.devicePassword);
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
      fetchMock.mockResolvedValueOnce(cognitoOk({
        AuthenticationResult: { IdToken: makeJwt(now + 3600) },
      }));

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
      fetchMock.mockResolvedValueOnce(cognitoOk({ ChallengeName: "SOMETHING_ELSE" }));

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
      fetchMock.mockResolvedValueOnce(cognitoOk({ AuthenticationResult: { AccessToken: "at" } }));

      await expect(getValidIdToken(store)).rejects.toThrow(/no IdToken/);
      expect(store.save).not.toHaveBeenCalled();
    });

    it("P2-3: NotAuthorizedException でトークン 3 点 + lastRefresh を破棄し device 3 点 + username を温存する (CognitoUser.java:1306-1311 clearCachedTokens / :2703-2720)", async () => {
      // _aws_sdk_ref/CognitoUser.java:2703-2720: clearCachedTokens は
      // idToken / accessToken / refreshToken の 3 キーのみ remove。device は別ストアで温存。
      // _aws_sdk_ref/CognitoUser.java:3384-3396: clearCachedDevice は
      // DEVICE_SRP_AUTH が NotAuthorized の時のみ。refresh 失効では device は消さない。
      const now = 1_700_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);

      const store = makeStore({
        idToken: makeJwt(now - 1),
        refreshToken: "rt-bad",
        clientId: CONSUMER_CLIENT_ID,
        username: "user@example.com",
      });
      fetchMock.mockResolvedValueOnce(cognitoError("NotAuthorizedException", "Refresh Token has been revoked"));

      await expect(getValidIdToken(store)).rejects.toThrow(/Refresh Token has been revoked/);
      // store.clear() は呼ばない (device 温存のため save に変更)
      expect(store.clear).not.toHaveBeenCalled();
      // store.save() でトークン 3 点 + lastRefresh が null になる
      expect(store.save).toHaveBeenCalledTimes(1);
      // pending verify 状態は壊さない (clearPending しない)
      expect(store.clearPending).not.toHaveBeenCalled();
      // idToken / accessToken / refreshToken / lastRefresh が null
      const saved = store._peek();
      expect(saved?.idToken).toBeNull();
      expect(saved?.accessToken).toBeNull();
      expect(saved?.refreshToken).toBeNull();
      expect(saved?.lastRefresh).toBeNull();
      // device 3 点 + username は温存
      expect(saved?.deviceKey).toBe(CONFIRMED_DEVICE.deviceKey);
      expect(saved?.deviceGroupKey).toBe(CONFIRMED_DEVICE.deviceGroupKey);
      expect(saved?.devicePassword).toBe(CONFIRMED_DEVICE.devicePassword);
      expect(saved?.username).toBe("user@example.com");
      // clientId も温存
      expect(saved?.clientId).toBe(CONSUMER_CLIENT_ID);
    });

    it("P2-3: UserNotFoundException でもトークン 3 点破棄 + device 温存する (CognitoUser.java:1309-1311)", async () => {
      const now = 1_700_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);

      const store = makeStore({
        idToken: makeJwt(now - 1),
        refreshToken: "rt",
        clientId: CONSUMER_CLIENT_ID,
        username: "user@example.com",
      });
      fetchMock.mockResolvedValueOnce(cognitoError("UserNotFoundException", "User does not exist."));

      await expect(getValidIdToken(store)).rejects.toThrow(/User does not exist/);
      expect(store.clear).not.toHaveBeenCalled();
      expect(store.save).toHaveBeenCalledTimes(1);
      expect(store.clearPending).not.toHaveBeenCalled();
      // device 3 点が温存されている
      expect(store._peek()?.deviceKey).toBe(CONFIRMED_DEVICE.deviceKey);
      expect(store._peek()?.idToken).toBeNull();
      expect(store._peek()?.refreshToken).toBeNull();
    });

    it("その他のエラー (例: InternalErrorException) では store.clear() しない", async () => {
      const now = 1_700_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);

      const store = makeStore({
        idToken: makeJwt(now - 1),
        refreshToken: "rt",
        clientId: CONSUMER_CLIENT_ID,
      });
      fetchMock.mockResolvedValueOnce(cognitoError("InternalErrorException", "boom", { status: 500 }));

      await expect(getValidIdToken(store)).rejects.toThrow(/boom/);
      expect(store.clear).not.toHaveBeenCalled();
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
      fetchMock
        .mockResolvedValueOnce(cognitoOk({ AuthenticationResult: { IdToken: newToken1 } }))
        .mockResolvedValueOnce(cognitoOk({ AuthenticationResult: { IdToken: newToken2 } }));

      const [a, b] = await Promise.all([getValidIdToken(store), getValidIdToken(store)]);

      // 現実装は per-call fetch なので 2 回叩かれる (de-dup なし) ことを確認
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // 両方とも有効な idToken を返す
      expect([newToken1, newToken2]).toContain(a);
      expect([newToken1, newToken2]).toContain(b);
      // save も 2 回 (最後勝ち)
      expect(store.save).toHaveBeenCalledTimes(2);
    });
  });
});
