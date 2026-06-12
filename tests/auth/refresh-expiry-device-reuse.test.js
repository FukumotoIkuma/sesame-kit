// P2-3: refresh 失効後の device 温存 → 再ログインで device 再利用シナリオ。
//
// 受け入れ基準:
//   - refresh 失効 → 後始末 (idToken/accessToken/refreshToken/lastRefresh を null 化,
//                             device 3 点 + username + clientId は温存)
//   - 再ログイン (loginInitiate → loginVerify) で保存済み DEVICE_KEY を ChallengeResponses に付与
//   - サーバが DEVICE_SRP_AUTH を要求 → DEVICE_SRP 認証成立
//   - ConfirmDevice 不発行 (NewDeviceMetadata が返らないため)
//
// 参照:
//   _aws_sdk_ref/CognitoUser.java:2703-2720  clearCachedTokens (token 3 点のみ)
//   _aws_sdk_ref/CognitoUser.java:3384-3396  clearCachedDevice は DEVICE_SRP_AUTH NotAuthorized のみ

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  fetchMock,
  installFetchMock,
  cognitoOk,
  cognitoError,
  cognitoCalls,
  cognitoOps,
} from "./cognito-fetch-mock.js";

installFetchMock();

// DEVICE_SRP_AUTH は 3072-bit SRP modPow を実計算するため余裕を持たせる
vi.setConfig({ testTimeout: 20000 });

import { getValidIdToken, loginInitiate, loginVerify, CONSUMER_CLIENT_ID } from "../../src/auth.js";

const EMAIL = "user@example.com";

const EXISTING_DEVICE = {
  deviceKey: "dev-key-existing",
  deviceGroupKey: "dev-group-existing",
  devicePassword: "dev-password-existing",
};

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function makeJwt(exp = 9_999_999_999, extra = {}) {
  return `${b64url({ alg: "RS256" })}.${b64url({ aud: CONSUMER_CLIENT_ID, exp, ...extra })}.sig`;
}

/** in-memory TokenStore (tokens + pending 両対応) */
function makeStore({ tokens = null, pending = null } = {}) {
  let t = tokens ? { ...tokens } : null;
  let p = pending ? { ...pending } : null;
  return {
    load: vi.fn(() => (t ? { ...t } : null)),
    save: vi.fn((next) => { t = { ...next }; }),
    clear: vi.fn(() => { t = null; }),
    loadPending: vi.fn(() => (p ? { ...p } : null)),
    savePending: vi.fn((next) => { p = { ...next }; }),
    clearPending: vi.fn(() => { p = null; }),
    _peek: () => t,
    _peekPending: () => p,
  };
}

beforeEach(() => { fetchMock.mockReset(); });
afterAll(() => { vi.unstubAllGlobals(); });

describe("P2-3: refresh 失効後の後始末", () => {
  it("NotAuthorizedException で store.save() が呼ばれ store.clear() は呼ばれない", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const store = makeStore({
      tokens: {
        idToken: makeJwt(now - 1),
        refreshToken: "rt-expired",
        accessToken: "at-old",
        clientId: CONSUMER_CLIENT_ID,
        username: EMAIL,
        ...EXISTING_DEVICE,
        lastRefresh: new Date(now * 1000).toISOString(),
      },
    });

    fetchMock.mockResolvedValueOnce(cognitoError("NotAuthorizedException", "Refresh Token has been revoked"));

    await expect(getValidIdToken(store)).rejects.toThrow(/Refresh Token has been revoked/);

    // P2-3: store.clear() ではなく store.save() で後始末する
    expect(store.clear).not.toHaveBeenCalled();
    expect(store.save).toHaveBeenCalledTimes(1);

    const saved = store._peek();
    // トークン 3 点 + lastRefresh が null (_aws_sdk_ref/CognitoUser.java:2703-2720 clearCachedTokens)
    expect(saved?.idToken).toBeNull();
    expect(saved?.accessToken).toBeNull();
    expect(saved?.refreshToken).toBeNull();
    expect(saved?.lastRefresh).toBeNull();
    // device 3 点が温存される (_aws_sdk_ref/CognitoUser.java:3384-3396 参照: clearCachedDevice は別)
    expect(saved?.deviceKey).toBe(EXISTING_DEVICE.deviceKey);
    expect(saved?.deviceGroupKey).toBe(EXISTING_DEVICE.deviceGroupKey);
    expect(saved?.devicePassword).toBe(EXISTING_DEVICE.devicePassword);
    // username + clientId も温存
    expect(saved?.username).toBe(EMAIL);
    expect(saved?.clientId).toBe(CONSUMER_CLIENT_ID);

    vi.useRealTimers();
  });

  it("UserNotFoundException でもトークン 3 点破棄 + device 温存", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const store = makeStore({
      tokens: {
        idToken: makeJwt(now - 1),
        refreshToken: "rt-old",
        clientId: CONSUMER_CLIENT_ID,
        username: EMAIL,
        ...EXISTING_DEVICE,
      },
    });

    fetchMock.mockResolvedValueOnce(cognitoError("UserNotFoundException", "User does not exist."));

    await expect(getValidIdToken(store)).rejects.toThrow(/User does not exist/);
    expect(store.clear).not.toHaveBeenCalled();
    expect(store._peek()?.deviceKey).toBe(EXISTING_DEVICE.deviceKey);
    expect(store._peek()?.idToken).toBeNull();

    vi.useRealTimers();
  });
});

describe("P2-3: 失効後の再ログインで DEVICE_KEY 付き回答 → DEVICE_SRP_AUTH 成立 (ConfirmDevice 不発行)", () => {
  it("失効後始末 → loginInitiate → loginVerify が DEVICE_SRP_AUTH で成立し ConfirmDevice が発行されない", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    // Step 1: refresh 失効 → 後始末 (device 温存)
    const store = makeStore({
      tokens: {
        idToken: makeJwt(now - 1),
        refreshToken: "rt-expired",
        clientId: CONSUMER_CLIENT_ID,
        username: EMAIL,
        ...EXISTING_DEVICE,
      },
    });

    fetchMock.mockResolvedValueOnce(cognitoError("NotAuthorizedException", "Refresh Token has been revoked"));
    await expect(getValidIdToken(store)).rejects.toThrow(/Refresh Token has been revoked/);

    // device が温存されていることを確認
    expect(store._peek()?.deviceKey).toBe(EXISTING_DEVICE.deviceKey);
    expect(store._peek()?.idToken).toBeNull();

    // Step 2: loginInitiate (SignUp + InitiateAuth)
    fetchMock
      .mockResolvedValueOnce(cognitoError("UsernameExistsException", "exists"))  // SignUp: 既存ユーザー
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "CUSTOM_CHALLENGE",
        Session: "sess-relogin",
        ChallengeParameters: { email: EMAIL },
      })); // InitiateAuth → CUSTOM_CHALLENGE

    await loginInitiate(store, EMAIL);
    expect(store._peekPending()?.session).toBe("sess-relogin");
    // loginInitiate 後も device は温存されたまま
    expect(store._peek()?.deviceKey).toBe(EXISTING_DEVICE.deviceKey);

    // Step 3: loginVerify でコード送信
    // 保存済み device が username 一致 → DEVICE_KEY が ChallengeResponses に付く
    // → サーバが DEVICE_SRP_AUTH を要求 (remember device あり)
    const SRP_CHALLENGE = {
      ChallengeName: "DEVICE_PASSWORD_VERIFIER",
      Session: "sess-srp-dev",
      ChallengeParameters: {
        USERNAME: EMAIL,
        SRP_B: "1234abcd5678ef",
        SALT: "aabbccdd",
        SECRET_BLOCK: Buffer.from("secret-block").toString("base64"),
      },
    };
    fetchMock
      // CUSTOM_CHALLENGE 回答 → DEVICE_SRP_AUTH (サーバが記憶済み device を認識)
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "DEVICE_SRP_AUTH",
        Session: "sess-srp-1",
        ChallengeParameters: { USERNAME: EMAIL },
      }))
      // DEVICE_SRP_AUTH → DEVICE_PASSWORD_VERIFIER
      .mockResolvedValueOnce(cognitoOk(SRP_CHALLENGE))
      // DEVICE_PASSWORD_VERIFIER → AuthenticationResult (NewDeviceMetadata なし = ConfirmDevice 不要)
      .mockResolvedValueOnce(cognitoOk({
        AuthenticationResult: {
          IdToken: makeJwt(now + 3600),
          AccessToken: "at-new",
          RefreshToken: "rt-new",
          // NewDeviceMetadata は返らない (既存 device が再利用された)
        },
      }));

    const tokens = await loginVerify(store, "123456");

    // DEVICE_KEY が ChallengeResponses に含まれた
    const customChallengeCall = cognitoCalls().find((c) => c.op === "RespondToAuthChallenge" && c.input.ChallengeName === "CUSTOM_CHALLENGE");
    expect(customChallengeCall?.input.ChallengeResponses.DEVICE_KEY).toBe(EXISTING_DEVICE.deviceKey);

    // DEVICE_SRP_AUTH フローが実行された
    expect(cognitoOps().filter((op) => op === "RespondToAuthChallenge").length).toBe(3);

    // ConfirmDevice は呼ばれない (NewDeviceMetadata がないため)
    expect(cognitoOps()).not.toContain("ConfirmDevice");

    // 再ログイン後のトークンに既存 device が引き継がれる
    expect(tokens.deviceKey).toBe(EXISTING_DEVICE.deviceKey);
    expect(tokens.deviceGroupKey).toBe(EXISTING_DEVICE.deviceGroupKey);
    expect(tokens.devicePassword).toBe(EXISTING_DEVICE.devicePassword);
    expect(tokens.idToken).toBe(makeJwt(now + 3600));

    vi.useRealTimers();
  });

  it("失効後始末後の getValidIdToken は 'idToken expired and no refreshToken' を返し再ログインを促す", async () => {
    // 後始末後は idToken=null, refreshToken=null のため、refresh せず再ログイン要求となる
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const store = makeStore({
      tokens: {
        idToken: makeJwt(now - 1),
        refreshToken: "rt-expired",
        clientId: CONSUMER_CLIENT_ID,
        username: EMAIL,
        ...EXISTING_DEVICE,
      },
    });

    // 1回目: refresh 失効 → 後始末
    fetchMock.mockResolvedValueOnce(cognitoError("NotAuthorizedException", "Refresh Token has been revoked"));
    await expect(getValidIdToken(store)).rejects.toThrow(/Refresh Token has been revoked/);

    // 2回目: 後始末後の getValidIdToken は refreshToken=null なので別エラーを返す
    // (assertAppLoginTokens の requireConfirmedDevice は device が温存されているので通過)
    // P5-1: メッセージは i18n 化済み。コード (UNAUTHENTICATED) で安定確認する。
    await expect(getValidIdToken(store)).rejects.toMatchObject({ code: "unauthenticated" });
    // 2回目は fetch を呼ばない (refreshToken がないため Cognito にリクエストしない)
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});
