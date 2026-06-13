// P3-10: チャレンジ応答の USERNAME が参照(内部ユーザー名)と不一致 の検出テスト
// P3-11: PASSWORD_VERIFIER 応答に保存済み DEVICE_KEY を注入しない の検出テスト
// P3-12: RespondToAuthChallenge 3 op で ClientMetadata:{} が欠落 の検出テスト
// P3-16: device 無しトークンの自己矛盾解消 の検出テスト
//
// 各修正の動機:
//   P3-10: _aws_sdk_ref/CognitoUser.java:3594-3600, 3644 —
//     usernameInternal = challengeParameters.get("USERNAME") を保持し、
//     PASSWORD_VERIFIER 応答の USERNAME に usernameInternal を使う。
//     pool が email → UUID 写像する設定のとき、旧実装は誤った値を送っていた。
//   P3-11: _aws_sdk_ref/CognitoUser.java:3645 —
//     srpAuthResponses.put(CHLG_RESP_DEVICE_KEY, deviceKey) で保存済み DEVICE_KEY を
//     PASSWORD_VERIFIER 応答に注入する。loginVerify は同条件で注入しており PASSWORD_VERIFIER
//     だけ非対称だった。
//   P3-12: _aws_sdk_ref/CognitoUser.java:3653, 3528, 3738 —
//     PASSWORD_VERIFIER / DEVICE_SRP_AUTH / DEVICE_PASSWORD_VERIFIER の 3 op に
//     ClientMetadata:{} を付与する (Java は空 Map をセットするため marshaller が書く)。
//     CUSTOM_CHALLENGE 応答には付けない (ChallengeContinuation.java:168-170 の isEmpty)。
//   P3-16: _aws_sdk_ref/CognitoUser.java:3130-3138, 3554-3564 —
//     NewDeviceMetadata が null なら confirm せず成功、REFRESH は deviceKey null なら省略。
//     「保存はできるが利用は必ず拒否」の自己矛盾を解消し device 無しトークンを一級市民に。

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  fetchMock,
  installFetchMock,
  cognitoOk,
  cognitoCalls,
} from "./cognito-fetch-mock.js";

installFetchMock();

// DEVICE_SRP 経路は 3072-bit SRP modPow を実計算するため余裕を持たせる
vi.setConfig({ testTimeout: 20000 });

import { loginInitiate, loginVerify, getValidIdToken, CONSUMER_CLIENT_ID } from "../../src/auth.js";

const EMAIL = "user@example.com";
// UUID 形式の内部ユーザー名 (pool が email → UUID 写像するケース)
const INTERNAL_UUID = "550e8400-e29b-41d4-a716-446655440000";

const CONFIRMED_DEVICE = {
  deviceKey: "ap-northeast-1_TestDeviceKey",
  deviceGroupKey: "ap-northeast-1_TestDeviceGroup",
  devicePassword: "TestDevicePassword+VGVzdA==",
};

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function makeJwt(exp = 9_999_999_999, extra = {}) {
  return `${b64url({ alg: "RS256" })}.${b64url({ aud: CONSUMER_CLIENT_ID, exp, ...extra })}.sig`;
}

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

// ─────────────────────────────────────────────────────────────────────────────
// P3-10: usernameInternal の保存と利用
// ─────────────────────────────────────────────────────────────────────────────
describe("P3-10: usernameInternal (内部ユーザー名の伝播)", () => {
  // CUSTOM_CHALLENGE 直行経路: ChallengeParameters.USERNAME に内部 UUID が来る
  it("loginInitiate で ChallengeParameters.USERNAME を pending.usernameInternal に保存する", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({})) // SignUp
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "CUSTOM_CHALLENGE",
        Session: "sess-1",
        // pool が email → UUID 写像: ChallengeParameters.USERNAME は UUID
        ChallengeParameters: { USERNAME: INTERNAL_UUID, email: EMAIL },
      }));

    const store = makeStore();
    await loginInitiate(store, EMAIL);

    // pending に usernameInternal が保存されていること
    expect(store._peekPending()?.usernameInternal).toBe(INTERNAL_UUID);
    expect(store._peekPending()?.username).toBe(EMAIL); // 入力 email も維持
  });

  it("USERNAME と email が同じ (写像無し Pool) なら usernameInternal は保存しない", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({})) // SignUp
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "CUSTOM_CHALLENGE",
        Session: "sess-1",
        // 写像無し Pool: ChallengeParameters.USERNAME は email 自身 (またはなし)
        ChallengeParameters: { email: EMAIL },
      }));

    const store = makeStore();
    await loginInitiate(store, EMAIL);

    // usernameInternal が無い場合は保存しない (undefined)
    expect(store._peekPending()?.usernameInternal).toBeUndefined();
  });

  it("loginVerify の CUSTOM_CHALLENGE 回答 USERNAME は usernameInternal を優先する (pool 写像あり)", async () => {
    // pool が email → UUID 写像する場合: RespondToAuthChallenge の USERNAME は UUID
    // 参照: _aws_sdk_ref/CognitoUser.java:3644 (srpAuthResponses.put(USERNAME, usernameInternal))
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: {
        IdToken: makeJwt(),
        AccessToken: "at",
        RefreshToken: "rt",
      },
    }));

    const store = makeStore({
      pending: {
        clientId: CONSUMER_CLIENT_ID,
        username: EMAIL,
        usernameInternal: INTERNAL_UUID, // P3-10: pending に保存済みの内部ユーザー名
        session: "sess-1",
        initiatedAt: new Date().toISOString(),
      },
    });
    await loginVerify(store, "123456");

    const call = cognitoCalls()[0];
    expect(call.op).toBe("RespondToAuthChallenge");
    // USERNAME は usernameInternal (UUID) であること (email ではない)
    expect(call.input.ChallengeResponses.USERNAME).toBe(INTERNAL_UUID);
    expect(call.input.ChallengeResponses.USERNAME).not.toBe(EMAIL);
    expect(call.input.ChallengeResponses.ANSWER).toBe("123456");
  });

  it("loginVerify の USERNAME は usernameInternal が無い場合 email (s.username) を使う", async () => {
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: { IdToken: makeJwt(), AccessToken: "at", RefreshToken: "rt" },
    }));

    const store = makeStore({
      pending: {
        clientId: CONSUMER_CLIENT_ID,
        username: EMAIL,
        // usernameInternal なし (写像無し Pool)
        session: "sess-1",
        initiatedAt: new Date().toISOString(),
      },
    });
    await loginVerify(store, "123456");

    const call = cognitoCalls()[0];
    expect(call.input.ChallengeResponses.USERNAME).toBe(EMAIL);
  });

  // PASSWORD_VERIFIER 経路: ChallengeParameters.USERNAME が usernameInternal として伝播する
  describe("PASSWORD_VERIFIER → CUSTOM_CHALLENGE 連鎖での usernameInternal 伝播", () => {
    // _aws_sdk_ref/CognitoUser.java:3594-3600:
    //   userId = challengeParameters.get("USERNAME")  → usernameInternal
    //   userIdForSRP = challengeParameters.get("USER_ID_FOR_SRP")  → SRP 計算に使う
    const PV_CHALLENGE_PARAMS_UUID = {
      USERNAME: INTERNAL_UUID,     // 内部 UUID ユーザー名
      USER_ID_FOR_SRP: EMAIL,       // SRP 計算には email を使う場合もある
      SRP_B: "1234abcd5678ef01",
      SALT: "aabbccdd1122",
      SECRET_BLOCK: Buffer.from("test-secret-block").toString("base64"),
    };

    it("PASSWORD_VERIFIER 応答の USERNAME は ChallengeParameters.USERNAME (UUID) を使う", async () => {
      fetchMock
        .mockResolvedValueOnce(cognitoOk({})) // SignUp
        .mockResolvedValueOnce(cognitoOk({    // InitiateAuth → PASSWORD_VERIFIER
          ChallengeName: "PASSWORD_VERIFIER",
          Session: "sess-pv",
          ChallengeParameters: PV_CHALLENGE_PARAMS_UUID,
        }))
        .mockResolvedValueOnce(cognitoOk({    // RespondToAuthChallenge → CUSTOM_CHALLENGE
          ChallengeName: "CUSTOM_CHALLENGE",
          Session: "sess-cc",
          ChallengeParameters: { email: EMAIL },
        }));

      const store = makeStore();
      await loginInitiate(store, EMAIL);

      const [, , pvResp] = cognitoCalls();
      // P3-10: PASSWORD_VERIFIER 応答の USERNAME は usernameInternal (UUID)
      // 参照: _aws_sdk_ref/CognitoUser.java:3644 — srpAuthResponses.put(USERNAME, usernameInternal)
      expect(pvResp.input.ChallengeResponses.USERNAME).toBe(INTERNAL_UUID);
      expect(pvResp.input.ChallengeResponses.USERNAME).not.toBe(EMAIL);

      // pending に usernameInternal が保存されること
      expect(store._peekPending()?.usernameInternal).toBe(INTERNAL_UUID);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P3-11: PASSWORD_VERIFIER 応答への DEVICE_KEY 注入
// ─────────────────────────────────────────────────────────────────────────────
describe("P3-11: PASSWORD_VERIFIER 応答への DEVICE_KEY 注入", () => {
  const PV_CHALLENGE_PARAMS = {
    USERNAME: EMAIL,
    USER_ID_FOR_SRP: EMAIL,
    SRP_B: "1234abcd5678ef01",
    SALT: "aabbccdd1122",
    SECRET_BLOCK: Buffer.from("test-secret-block").toString("base64"),
  };

  it("store に同一 username の保存済み deviceKey があれば PASSWORD_VERIFIER 応答に DEVICE_KEY を注入する", async () => {
    // 参照: _aws_sdk_ref/CognitoUser.java:3601-3602 — userSrpAuthRequest は
    //   challengeParameters から usernameInternal を取得した直後に
    //   CognitoDeviceHelper.getDeviceKey() で deviceKey を取得する (:3645 で注入)。
    fetchMock
      .mockResolvedValueOnce(cognitoOk({})) // SignUp
      .mockResolvedValueOnce(cognitoOk({    // InitiateAuth → PASSWORD_VERIFIER
        ChallengeName: "PASSWORD_VERIFIER",
        Session: "sess-pv-1",
        ChallengeParameters: PV_CHALLENGE_PARAMS,
      }))
      .mockResolvedValueOnce(cognitoOk({    // RespondToAuthChallenge → CUSTOM_CHALLENGE
        ChallengeName: "CUSTOM_CHALLENGE",
        Session: "sess-cc-1",
        ChallengeParameters: { email: EMAIL },
      }));

    const store = makeStore({
      tokens: {
        idToken: makeJwt(),
        refreshToken: "rt",
        username: EMAIL,
        clientId: CONSUMER_CLIENT_ID,
        ...CONFIRMED_DEVICE,
      },
    });
    await loginInitiate(store, EMAIL);

    const [, , pvResp] = cognitoCalls();
    // P3-11: 保存済み DEVICE_KEY が注入されること
    // 参照: _aws_sdk_ref/CognitoUser.java:3645 (srpAuthResponses.put(CHLG_RESP_DEVICE_KEY, deviceKey))
    expect(pvResp.input.ChallengeResponses.DEVICE_KEY).toBe(CONFIRMED_DEVICE.deviceKey);
  });

  it("store が空 (初回ログイン) なら PASSWORD_VERIFIER 応答に DEVICE_KEY を付けない", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({})) // SignUp
      .mockResolvedValueOnce(cognitoOk({    // InitiateAuth → PASSWORD_VERIFIER
        ChallengeName: "PASSWORD_VERIFIER",
        Session: "sess-pv-2",
        ChallengeParameters: PV_CHALLENGE_PARAMS,
      }))
      .mockResolvedValueOnce(cognitoOk({    // RespondToAuthChallenge → CUSTOM_CHALLENGE
        ChallengeName: "CUSTOM_CHALLENGE",
        Session: "sess-cc-2",
        ChallengeParameters: { email: EMAIL },
      }));

    const store = makeStore(); // トークン無し (初回ログイン)
    await loginInitiate(store, EMAIL);

    const [, , pvResp] = cognitoCalls();
    // 保存済み deviceKey が無いので DEVICE_KEY は付かない
    expect(pvResp.input.ChallengeResponses.DEVICE_KEY).toBeUndefined();
  });

  it("別 username のトークンが保存されていても DEVICE_KEY は付けない (username 不一致)", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({})) // SignUp
      .mockResolvedValueOnce(cognitoOk({    // InitiateAuth → PASSWORD_VERIFIER
        ChallengeName: "PASSWORD_VERIFIER",
        Session: "sess-pv-3",
        ChallengeParameters: PV_CHALLENGE_PARAMS,
      }))
      .mockResolvedValueOnce(cognitoOk({    // RespondToAuthChallenge → CUSTOM_CHALLENGE
        ChallengeName: "CUSTOM_CHALLENGE",
        Session: "sess-cc-3",
        ChallengeParameters: { email: EMAIL },
      }));

    const store = makeStore({
      tokens: {
        idToken: makeJwt(),
        refreshToken: "rt",
        username: "other@example.com", // 別ユーザー
        clientId: CONSUMER_CLIENT_ID,
        ...CONFIRMED_DEVICE,
      },
    });
    await loginInitiate(store, EMAIL);

    const [, , pvResp] = cognitoCalls();
    // 別ユーザーの device なので注入しない
    expect(pvResp.input.ChallengeResponses.DEVICE_KEY).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P3-12: ClientMetadata:{} の有無
// ─────────────────────────────────────────────────────────────────────────────
describe("P3-12: RespondToAuthChallenge 3 op の ClientMetadata:{}",  () => {
  const PV_CHALLENGE_PARAMS = {
    USERNAME: EMAIL,
    USER_ID_FOR_SRP: EMAIL,
    SRP_B: "1234abcd5678ef01",
    SALT: "aabbccdd1122",
    SECRET_BLOCK: Buffer.from("test-secret-block-p12").toString("base64"),
  };

  it("PASSWORD_VERIFIER 応答に ClientMetadata:{} を含める (_aws_sdk_ref/CognitoUser.java:3653)", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({})) // SignUp
      .mockResolvedValueOnce(cognitoOk({    // InitiateAuth → PASSWORD_VERIFIER
        ChallengeName: "PASSWORD_VERIFIER",
        Session: "sess-pv",
        ChallengeParameters: PV_CHALLENGE_PARAMS,
      }))
      .mockResolvedValueOnce(cognitoOk({    // RespondToAuthChallenge → CUSTOM_CHALLENGE
        ChallengeName: "CUSTOM_CHALLENGE",
        Session: "sess-cc",
        ChallengeParameters: { email: EMAIL },
      }));

    const store = makeStore();
    await loginInitiate(store, EMAIL);

    const [, , pvResp] = cognitoCalls();
    expect(pvResp.input.ChallengeName).toBe("PASSWORD_VERIFIER");
    // P3-12: ClientMetadata:{} が含まれること
    expect(pvResp.input.ClientMetadata).toEqual({});
  });

  it("CUSTOM_CHALLENGE 応答には ClientMetadata を付けない (ChallengeContinuation.java:168-170 isEmpty ガード)", async () => {
    // CUSTOM_CHALLENGE 応答はアプリと一致させるため ClientMetadata を付けない。
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: { IdToken: makeJwt(), AccessToken: "at", RefreshToken: "rt" },
    }));

    const store = makeStore({
      pending: {
        clientId: CONSUMER_CLIENT_ID,
        username: EMAIL,
        session: "sess-1",
        initiatedAt: new Date().toISOString(),
      },
    });
    await loginVerify(store, "123456");

    const call = cognitoCalls()[0];
    expect(call.op).toBe("RespondToAuthChallenge");
    expect(call.input.ChallengeName).toBe("CUSTOM_CHALLENGE");
    // CUSTOM_CHALLENGE には ClientMetadata を付けない
    expect(call.input.ClientMetadata).toBeUndefined();
  });

  it("DEVICE_SRP_AUTH 送信に ClientMetadata:{} を含める (_aws_sdk_ref/CognitoUser.java:3528)", async () => {
    // 参照: _aws_sdk_ref/CognitoUser.java:3528 —
    //   initiateDevicesAuthRequest.setClientMetadata(clientMetadata) で空 Map を注入。
    fetchMock
      .mockResolvedValueOnce(cognitoOk({  // CUSTOM_CHALLENGE 回答 → DEVICE_SRP_AUTH
        ChallengeName: "DEVICE_SRP_AUTH",
        Session: "sess-srp-1",
        ChallengeParameters: { USERNAME: EMAIL },
      }))
      .mockResolvedValueOnce(cognitoOk({  // DEVICE_SRP_AUTH → DEVICE_PASSWORD_VERIFIER
        ChallengeName: "DEVICE_PASSWORD_VERIFIER",
        Session: "sess-srp-2",
        ChallengeParameters: {
          USERNAME: EMAIL,
          SRP_B: "1234abcd5678ef",
          SALT: "aabbccdd",
          SECRET_BLOCK: Buffer.from("secret-block").toString("base64"),
        },
      }))
      .mockResolvedValueOnce(cognitoOk({  // DEVICE_PASSWORD_VERIFIER → 成功
        AuthenticationResult: { IdToken: makeJwt(), AccessToken: "at-srp", RefreshToken: "rt-srp" },
      }))
      .mockResolvedValueOnce(cognitoOk({  // P2-8: GetUser (nickname)
        UserAttributes: [{ Name: "nickname", Value: "existing" }],
      }));

    const store = makeStore({
      tokens: {
        idToken: makeJwt(),
        refreshToken: "rt0",
        username: EMAIL,
        clientId: CONSUMER_CLIENT_ID,
        ...CONFIRMED_DEVICE,
      },
      pending: {
        clientId: CONSUMER_CLIENT_ID,
        username: EMAIL,
        session: "sess-1",
        initiatedAt: new Date().toISOString(),
      },
    });
    await loginVerify(store, "123456");

    const calls = cognitoCalls();
    // calls[0] = RespondToAuthChallenge(CUSTOM_CHALLENGE)
    // calls[1] = RespondToAuthChallenge(DEVICE_SRP_AUTH)
    // calls[2] = RespondToAuthChallenge(DEVICE_PASSWORD_VERIFIER)
    const srpAuth = calls[1];
    const srpVerifier = calls[2];

    expect(srpAuth.input.ChallengeName).toBe("DEVICE_SRP_AUTH");
    // P3-12: DEVICE_SRP_AUTH に ClientMetadata:{} が含まれること
    expect(srpAuth.input.ClientMetadata).toEqual({});

    expect(srpVerifier.input.ChallengeName).toBe("DEVICE_PASSWORD_VERIFIER");
    // P3-12: DEVICE_PASSWORD_VERIFIER に ClientMetadata:{} が含まれること
    expect(srpVerifier.input.ClientMetadata).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P3-16: device 無しトークンの自己矛盾解消
// ─────────────────────────────────────────────────────────────────────────────
describe("P3-16: device 無しトークンを一級市民として扱う", () => {
  // getValidIdToken のヘルパ (token ストアのみ)
  function makeTokenStore(initial) {
    let state = initial ? { ...initial } : null;
    return {
      load: vi.fn(() => state),
      save: vi.fn((t) => { state = { ...t }; }),
      clear: vi.fn(() => { state = null; }),
      loadPending: vi.fn(() => null),
      savePending: vi.fn(),
      clearPending: vi.fn(),
      _peek: () => state,
    };
  }

  it("NewDeviceMetadata 無し (device 無し) の loginVerify 成功 → getValidIdToken も成功する (自己矛盾の解消)", async () => {
    // 旧実装: loginVerify は deviceKey:null で保存 OK だが、
    // getValidIdToken は requireConfirmedDevice:true で常に拒否 → 無限ループ。
    // P3-16: device 無し (deviceKey=null) は一級市民として getValidIdToken を通過する。
    // 参照: _aws_sdk_ref/CognitoUser.java:3130-3138 (NewDeviceMetadata==null なら confirm 不要),
    //        :3554-3564 (REFRESH は deviceKey null なら DEVICE_KEY を省略)。
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    // --- Step 1: loginVerify で device 無しトークンを保存 ---
    fetchMock
      .mockResolvedValueOnce(cognitoOk({  // RespondToAuthChallenge
        AuthenticationResult: {
          IdToken: makeJwt(now + 3600),
          AccessToken: "at",
          RefreshToken: "rt",
          // NewDeviceMetadata 無し = デバイストラッキング無効 Pool
        },
      }))
      .mockResolvedValueOnce(cognitoOk({  // GetUser (nickname)
        UserAttributes: [{ Name: "nickname", Value: "existing" }],
      }));

    const store = makeStore({
      pending: {
        clientId: CONSUMER_CLIENT_ID,
        username: EMAIL,
        session: "sess-1",
        initiatedAt: new Date().toISOString(),
      },
    });
    const tokens = await loginVerify(store, "123456");
    // NewDeviceMetadata 無し → device 3 点は null
    expect(tokens.deviceKey).toBeNull();
    expect(tokens.deviceGroupKey).toBeNull();

    vi.useRealTimers();

    // --- Step 2: 保存されたトークンで getValidIdToken が成功する ---
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const tokenStore = makeTokenStore(store._peek());
    const got = await getValidIdToken(tokenStore);
    expect(got).toBe(tokens.idToken);
    // device 無しなので fetch (refresh) は呼ばれない
    expect(fetchMock).toHaveBeenCalledTimes(2); // loginVerify の 2 コールのみ

    vi.useRealTimers();
  });

  it("device 無しトークンの REFRESH は DEVICE_KEY を含まない (_aws_sdk_ref/CognitoUser.java:3554-3564)", async () => {
    // 参照: _aws_sdk_ref/CognitoUser.java:3554-3564 — initiateRefreshTokenAuthRequest は
    //   deviceKey が null なら DEVICE_KEY パラメータを addAuthParametersEntry しない。
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const expiredJwt = makeJwt(now - 1); // 失効済み
    const newJwt = makeJwt(now + 3600);

    const store = makeTokenStore({
      clientId: CONSUMER_CLIENT_ID,
      idToken: expiredJwt,
      refreshToken: "rt-device-less",
      accessToken: null,
      deviceKey: null,       // device 無し
      deviceGroupKey: null,
      devicePassword: null,
      username: EMAIL,
    });

    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: { IdToken: newJwt },
    }));

    const got = await getValidIdToken(store);
    expect(got).toBe(newJwt);

    const call = cognitoCalls()[0];
    expect(call.op).toBe("InitiateAuth");
    expect(call.input.AuthFlow).toBe("REFRESH_TOKEN_AUTH");
    // DEVICE_KEY は付かない (deviceKey=null なので)
    expect(call.input.AuthParameters.DEVICE_KEY).toBeUndefined();
    expect(call.input.AuthParameters.REFRESH_TOKEN).toBe("rt-device-less");

    vi.useRealTimers();
  });

  it("deviceKey が存在するが deviceGroupKey/devicePassword が欠ける (不整合) は拒否する", async () => {
    // P3-16: 「deviceKey が存在する場合のみ 3 点整合チェック」。
    // deviceKey あり + 残り欠けは不整合 = 拒否 (旧動作と変わらない境界ケース)。
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const store = makeTokenStore({
      clientId: CONSUMER_CLIENT_ID,
      idToken: makeJwt(now + 3600),
      refreshToken: "rt",
      deviceKey: "dev-key-only",  // deviceGroupKey / devicePassword が欠ける
      deviceGroupKey: null,
      devicePassword: null,
      username: EMAIL,
    });

    await expect(getValidIdToken(store)).rejects.toThrow(/has a deviceKey but is missing/);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  it("device 3 点が全て揃っているなら通常どおり通過する (P3-16 で既存動作を壊さない)", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const idToken = makeJwt(now + 3600);
    const store = makeTokenStore({
      clientId: CONSUMER_CLIENT_ID,
      idToken,
      refreshToken: "rt",
      ...CONFIRMED_DEVICE,
      username: EMAIL,
    });

    const got = await getValidIdToken(store);
    expect(got).toBe(idToken);
    expect(fetchMock).not.toHaveBeenCalled(); // 未失効なので refresh しない

    vi.useRealTimers();
  });
});
