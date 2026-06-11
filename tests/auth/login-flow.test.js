// loginInitiate / loginVerify (src/auth.js) のフローテスト。
//
// 規範: Android アプリ + AWSMobileClient 2.77.0 の 1:1 トレース。
//   - P2-4: signUp 先行 (UsernameExistsException 容認) + Password "dummypwk" +
//     UserAttributes [{Name:"email"}] — LoginMailFG.kt:106-127
//   - P2-3: DEVICE_KEY は InitiateAuth には入れず (CognitoUser.java:3473-3507)、
//     チャレンジ回答 (ChallengeResponses) に入れる (CognitoUser.java:2919-2922 /
//     ChallengeContinuation.java:160-167)
//   - P2-6: DEVICE_SRP_AUTH が NotAuthorized なら device 3 点を破棄して
//     デバイス無し CUSTOM_AUTH を最初から再試行 (CognitoUser.java:3384-3396)
//
// Cognito は素 fetch (cognito-http.js) なので global.fetch を差し替えて観測する。
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

// DEVICE_SRP 経路は 3072-bit SRP modPow を実計算するため余裕を持たせる
// (device-srp.test.js と同じ理由)。
vi.setConfig({ testTimeout: 20000 });

import { loginInitiate, loginVerify, CONSUMER_CLIENT_ID } from "../../src/auth.js";

const EMAIL = "user@example.com";

const CONFIRMED_DEVICE = {
  deviceKey: "dev-key-old",
  deviceGroupKey: "dev-group-old",
  devicePassword: "dev-password-old",
};

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function makeJwt(exp = 9999999999, extra = {}) {
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

// ═════════════════════════════════════════════════════════════════════════════
// loginInitiate (P2-4: signUp 先行 / P2-3: initiate に DEVICE_KEY を入れない)
// ═════════════════════════════════════════════════════════════════════════════
describe("loginInitiate", () => {
  it("P2-4: signUp を先に実行し、リクエスト形が LoginMailFG.kt:106-127 と一致する", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({ UserConfirmed: false, UserSub: "sub-1" })) // SignUp
      .mockResolvedValueOnce(cognitoOk({ ChallengeName: "CUSTOM_CHALLENGE", Session: "sess-1", ChallengeParameters: { email: EMAIL } }));

    const store = makeStore();
    const out = await loginInitiate(store, EMAIL);

    expect(cognitoOps()).toEqual(["SignUp", "InitiateAuth"]);
    const [signUp, initiate] = cognitoCalls();
    // signUp: Password="dummypwk" (app 値。web の "Aa123456" ではない) + email 属性
    expect(signUp.input).toEqual({
      ClientId: CONSUMER_CLIENT_ID,
      Username: EMAIL,
      Password: "dummypwk",
      UserAttributes: [{ Name: "email", Value: EMAIL }],
    });
    // initiate: AuthParameters は USERNAME のみ (DEVICE_KEY 無し)
    expect(initiate.input).toEqual({
      AuthFlow: "CUSTOM_AUTH",
      ClientId: CONSUMER_CLIENT_ID,
      AuthParameters: { USERNAME: EMAIL },
    });
    expect(out).toEqual({ challenge: "CUSTOM_CHALLENGE", params: { email: EMAIL } });
    expect(store._peekPending()).toMatchObject({
      clientId: CONSUMER_CLIENT_ID,
      username: EMAIL,
      session: "sess-1",
    });
  });

  it("P2-3: 保存済み deviceKey があっても InitiateAuth には DEVICE_KEY を入れない (CognitoUser.java:3473-3507)", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoError("UsernameExistsException", "exists"))
      .mockResolvedValueOnce(cognitoOk({ ChallengeName: "CUSTOM_CHALLENGE", Session: "s" }));

    const store = makeStore({
      tokens: { idToken: makeJwt(), refreshToken: "rt", username: EMAIL, clientId: CONSUMER_CLIENT_ID, ...CONFIRMED_DEVICE },
    });
    await loginInitiate(store, EMAIL);

    const initiate = cognitoCalls()[1];
    expect(initiate.op).toBe("InitiateAuth");
    expect(initiate.input.AuthParameters).toEqual({ USERNAME: EMAIL });
    expect(initiate.input.AuthParameters.DEVICE_KEY).toBeUndefined();
  });

  it("既存ユーザーの UsernameExistsException は容認して signIn へ進む (LoginMailFG.kt:114-118)", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoError("UsernameExistsException", "An account with the given email already exists."))
      .mockResolvedValueOnce(cognitoOk({ ChallengeName: "CUSTOM_CHALLENGE", Session: "sess-2" }));

    const store = makeStore();
    const out = await loginInitiate(store, EMAIL);

    expect(cognitoOps()).toEqual(["SignUp", "InitiateAuth"]);
    expect(out.challenge).toBe("CUSTOM_CHALLENGE");
  });

  it("UsernameExists 以外の signUp エラーは中断する (アプリはトーストを出して終了)", async () => {
    fetchMock.mockResolvedValueOnce(cognitoError("InvalidParameterException", "bad email"));

    const store = makeStore();
    await expect(loginInitiate(store, "broken")).rejects.toThrow(/bad email/);
    expect(cognitoOps()).toEqual(["SignUp"]); // InitiateAuth まで進まない
    expect(store.savePending).not.toHaveBeenCalled();
  });

  it("CUSTOM_CHALLENGE 以外のチャレンジが返ったら throw する", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({}))
      .mockResolvedValueOnce(cognitoOk({ ChallengeName: "PASSWORD_VERIFIER" }));

    const store = makeStore();
    await expect(loginInitiate(store, EMAIL)).rejects.toThrow(/Unexpected challenge: PASSWORD_VERIFIER/);
    expect(store.savePending).not.toHaveBeenCalled();
  });

  it("Consumer Client 以外の clientId は拒否する", async () => {
    const store = makeStore();
    await expect(loginInitiate(store, EMAIL, { clientId: "biz-client" })).rejects.toThrow(/Unsupported Cognito clientId/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// loginVerify (P2-3: ChallengeResponses に DEVICE_KEY / P2-5: remembered 化なし /
//              P2-6: 失効 device の後始末)
// ═════════════════════════════════════════════════════════════════════════════
describe("loginVerify", () => {
  const PENDING = { clientId: CONSUMER_CLIENT_ID, username: EMAIL, session: "sess-1", initiatedAt: "2026-06-01T00:00:00.000Z" };

  it("pending が無ければ throw する", async () => {
    const store = makeStore();
    await expect(loginVerify(store, "123456")).rejects.toThrow(/No pending sign-in/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("P2-3: 同一 username の保存済み DEVICE_KEY を ChallengeResponses に含める (ChallengeContinuation.java:160-167)", async () => {
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: { IdToken: makeJwt(), AccessToken: "at", RefreshToken: "rt" },
    }));

    const store = makeStore({
      tokens: { idToken: makeJwt(), refreshToken: "rt0", username: EMAIL, clientId: CONSUMER_CLIENT_ID, ...CONFIRMED_DEVICE },
      pending: PENDING,
    });
    await loginVerify(store, "123456");

    const call = cognitoCalls()[0];
    expect(call.op).toBe("RespondToAuthChallenge");
    expect(call.input.ChallengeResponses).toEqual({
      USERNAME: EMAIL,
      ANSWER: "123456",
      DEVICE_KEY: CONFIRMED_DEVICE.deviceKey,
    });
  });

  it("保存済みトークンの username が違う場合は DEVICE_KEY を付けない", async () => {
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: { IdToken: makeJwt(), AccessToken: "at", RefreshToken: "rt" },
    }));

    const store = makeStore({
      tokens: { idToken: makeJwt(), refreshToken: "rt0", username: "other@example.com", clientId: CONSUMER_CLIENT_ID, ...CONFIRMED_DEVICE },
      pending: PENDING,
    });
    await loginVerify(store, "123456");

    expect(cognitoCalls()[0].input.ChallengeResponses).toEqual({
      USERNAME: EMAIL,
      ANSWER: "123456",
    });
  });

  it("P2-5: NewDeviceMetadata → ConfirmDevice のみ。UserConfirmationNecessary でも UpdateDeviceStatus は送らない (CognitoUser.java:3140-3151)", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({
        AuthenticationResult: {
          IdToken: makeJwt(),
          AccessToken: "at-1",
          RefreshToken: "rt-1",
          NewDeviceMetadata: { DeviceKey: "dev-new", DeviceGroupKey: "grp-new" },
        },
      }))
      // ConfirmDevice: User Opt-In Pool 相当の UserConfirmationNecessary=true を返しても
      // 参照 SDK は remembered 化 (UpdateDeviceStatus) しない。
      .mockResolvedValueOnce(cognitoOk({ UserConfirmationNecessary: true }));

    const store = makeStore({ pending: PENDING });
    const tokens = await loginVerify(store, "123456");

    expect(cognitoOps()).toEqual(["RespondToAuthChallenge", "ConfirmDevice"]);
    const confirm = cognitoCalls()[1];
    expect(confirm.input.AccessToken).toBe("at-1");
    expect(confirm.input.DeviceKey).toBe("dev-new");
    expect(confirm.input.DeviceSecretVerifierConfig.PasswordVerifier).toBeTypeOf("string");
    expect(confirm.input.DeviceSecretVerifierConfig.Salt).toBeTypeOf("string");
    // 確定した device 3 点が永続化される
    expect(tokens.deviceKey).toBe("dev-new");
    expect(tokens.deviceGroupKey).toBe("grp-new");
    expect(tokens.devicePassword).toBeTypeOf("string");
    expect(store.clearPending).toHaveBeenCalledTimes(1);
  });

  it("コード誤り (CUSTOM_CHALLENGE 再発行) は新 Session を pending に書き戻して throw する", async () => {
    fetchMock.mockResolvedValueOnce(cognitoOk({ ChallengeName: "CUSTOM_CHALLENGE", Session: "sess-retry" }));

    const store = makeStore({ pending: PENDING });
    await expect(loginVerify(store, "000000")).rejects.toThrow(/Incorrect code|コードが違います/);
    expect(store._peekPending().session).toBe("sess-retry");
    expect(store.clearPending).not.toHaveBeenCalled();
  });

  describe("DEVICE_SRP_AUTH", () => {
    // SRP_B / SALT は 16 進文字列、SECRET_BLOCK は base64 (サーバ検証はしないので任意値)
    const SRP_CHALLENGE = {
      ChallengeName: "DEVICE_PASSWORD_VERIFIER",
      Session: "sess-srp-2",
      ChallengeParameters: {
        USERNAME: EMAIL,
        SRP_B: "1234abcd5678ef",
        SALT: "aabbccdd",
        SECRET_BLOCK: Buffer.from("secret-block").toString("base64"),
      },
    };

    it("記憶済みデバイスで DEVICE_SRP_AUTH → DEVICE_PASSWORD_VERIFIER を回答し、両方に DEVICE_KEY を含める", async () => {
      fetchMock
        .mockResolvedValueOnce(cognitoOk({ ChallengeName: "DEVICE_SRP_AUTH", Session: "sess-srp-1", ChallengeParameters: { USERNAME: EMAIL } }))
        .mockResolvedValueOnce(cognitoOk(SRP_CHALLENGE))
        .mockResolvedValueOnce(cognitoOk({
          AuthenticationResult: { IdToken: makeJwt(), AccessToken: "at-2", RefreshToken: "rt-2" },
        }));

      const store = makeStore({
        tokens: { idToken: makeJwt(), refreshToken: "rt0", username: EMAIL, clientId: CONSUMER_CLIENT_ID, ...CONFIRMED_DEVICE },
        pending: PENDING,
      });
      const tokens = await loginVerify(store, "123456");

      expect(cognitoOps()).toEqual(["RespondToAuthChallenge", "RespondToAuthChallenge", "RespondToAuthChallenge"]);
      const [, srpA, verifier] = cognitoCalls();
      expect(srpA.input.ChallengeName).toBe("DEVICE_SRP_AUTH");
      expect(srpA.input.ChallengeResponses.DEVICE_KEY).toBe(CONFIRMED_DEVICE.deviceKey);
      expect(srpA.input.ChallengeResponses.SRP_A).toBeTypeOf("string");
      expect(verifier.input.ChallengeName).toBe("DEVICE_PASSWORD_VERIFIER");
      expect(verifier.input.ChallengeResponses.DEVICE_KEY).toBe(CONFIRMED_DEVICE.deviceKey);
      expect(verifier.input.ChallengeResponses.PASSWORD_CLAIM_SIGNATURE).toBeTypeOf("string");
      // 確定済みの既存デバイス情報を維持
      expect(tokens.deviceKey).toBe(CONFIRMED_DEVICE.deviceKey);
      expect(tokens.deviceGroupKey).toBe(CONFIRMED_DEVICE.deviceGroupKey);
    });

    it("P2-6: NotAuthorized なら device 3 点を破棄しデバイス無し CUSTOM_AUTH を再開始する (CognitoUser.java:3384-3396)", async () => {
      fetchMock
        // 1. CUSTOM_CHALLENGE 回答 → DEVICE_SRP_AUTH 要求
        .mockResolvedValueOnce(cognitoOk({ ChallengeName: "DEVICE_SRP_AUTH", Session: "sess-srp-1", ChallengeParameters: { USERNAME: EMAIL } }))
        // 2. DEVICE_SRP_AUTH → 失効 device で NotAuthorized
        .mockResolvedValueOnce(cognitoError("NotAuthorizedException", "Device does not exist."))
        // 3-4. 再開始 (loginInitiate): SignUp (既存容認) → InitiateAuth
        .mockResolvedValueOnce(cognitoError("UsernameExistsException", "exists"))
        .mockResolvedValueOnce(cognitoOk({ ChallengeName: "CUSTOM_CHALLENGE", Session: "sess-fresh" }));

      const store = makeStore({
        tokens: { idToken: makeJwt(), refreshToken: "rt0", username: EMAIL, clientId: CONSUMER_CLIENT_ID, ...CONFIRMED_DEVICE },
        pending: PENDING,
      });

      await expect(loginVerify(store, "123456")).rejects.toThrow(/new sign-in code|新しい確認コード/);

      expect(cognitoOps()).toEqual(["RespondToAuthChallenge", "RespondToAuthChallenge", "SignUp", "InitiateAuth"]);
      // 失効した device 3 点は null 化 (clearCachedDevice 相当)
      expect(store._peek().deviceKey).toBeNull();
      expect(store._peek().deviceGroupKey).toBeNull();
      expect(store._peek().devicePassword).toBeNull();
      // 再開始の InitiateAuth は DEVICE_KEY 無し
      expect(cognitoCalls()[3].input.AuthParameters).toEqual({ USERNAME: EMAIL });
      // pending は新 Session に更新済み (新コードで verify をやり直せる)
      expect(store._peekPending().session).toBe("sess-fresh");
    });

    it("P2-6: 後始末後の再 verify は DEVICE_KEY 無しで成立する (失効→再ログイン→古い device で再失敗、のループが消える)", async () => {
      // --- 1 回目: 失効 device で失敗 → 後始末 + 再開始 ---
      fetchMock
        .mockResolvedValueOnce(cognitoOk({ ChallengeName: "DEVICE_SRP_AUTH", Session: "s1", ChallengeParameters: { USERNAME: EMAIL } }))
        .mockResolvedValueOnce(cognitoError("NotAuthorizedException", "Device does not exist."))
        .mockResolvedValueOnce(cognitoError("UsernameExistsException", "exists"))
        .mockResolvedValueOnce(cognitoOk({ ChallengeName: "CUSTOM_CHALLENGE", Session: "sess-fresh" }));

      const store = makeStore({
        tokens: { idToken: makeJwt(), refreshToken: "rt0", username: EMAIL, clientId: CONSUMER_CLIENT_ID, ...CONFIRMED_DEVICE },
        pending: PENDING,
      });
      await expect(loginVerify(store, "123456")).rejects.toThrow();

      // --- 2 回目: 新コードで verify。古い DEVICE_KEY は送られず、素直に成功する ---
      fetchMock
        .mockResolvedValueOnce(cognitoOk({
          AuthenticationResult: {
            IdToken: makeJwt(),
            AccessToken: "at-new",
            RefreshToken: "rt-new",
            NewDeviceMetadata: { DeviceKey: "dev-brand-new", DeviceGroupKey: "grp-brand-new" },
          },
        }))
        .mockResolvedValueOnce(cognitoOk({})); // ConfirmDevice

      const tokens = await loginVerify(store, "654321");

      const secondVerify = cognitoCalls()[4];
      expect(secondVerify.op).toBe("RespondToAuthChallenge");
      // 古い device が破棄済みなので DEVICE_KEY は付かない → DEVICE_SRP_AUTH ループに入らない
      expect(secondVerify.input.ChallengeResponses).toEqual({ USERNAME: EMAIL, ANSWER: "654321" });
      expect(secondVerify.input.Session).toBe("sess-fresh");
      // 新デバイスが確定・永続化される
      expect(tokens.deviceKey).toBe("dev-brand-new");
      expect(store._peek().deviceKey).toBe("dev-brand-new");
      expect(store._peekPending()).toBeNull();
    });

    it("NotAuthorized 以外の DEVICE_SRP エラーは後始末せずそのまま伝播する", async () => {
      fetchMock
        .mockResolvedValueOnce(cognitoOk({ ChallengeName: "DEVICE_SRP_AUTH", Session: "s1", ChallengeParameters: { USERNAME: EMAIL } }))
        .mockResolvedValueOnce(cognitoError("InternalErrorException", "boom", { status: 500 }));

      const store = makeStore({
        tokens: { idToken: makeJwt(), refreshToken: "rt0", username: EMAIL, clientId: CONSUMER_CLIENT_ID, ...CONFIRMED_DEVICE },
        pending: PENDING,
      });
      await expect(loginVerify(store, "123456")).rejects.toThrow(/boom/);
      // device 3 点は維持
      expect(store._peek().deviceKey).toBe(CONFIRMED_DEVICE.deviceKey);
      expect(cognitoOps()).toEqual(["RespondToAuthChallenge", "RespondToAuthChallenge"]);
    });
  });
});
