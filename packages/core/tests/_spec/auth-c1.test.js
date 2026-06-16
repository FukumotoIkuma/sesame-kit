// auth-c1.test.js — AUTH-0019 〜 AUTH-0037 統合 TDD spec テスト (merged A+B)
//
// 対象 spec: AUTH-0019, AUTH-0020, AUTH-0021, AUTH-0022, AUTH-0023, AUTH-0024,
//            AUTH-0025, AUTH-0026, AUTH-0027, AUTH-0028, AUTH-0029, AUTH-0030,
//            AUTH-0031, AUTH-0032, AUTH-0033, AUTH-0034, AUTH-0036, AUTH-0037
//
// TDD 方針: spec どおりの期待値を assert する。実装と spec が食い違う場合は red になってよい。
// ネットワーク/実機不使用。全て fetch mock または純関数で決定論的に。

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  fetchMock,
  installFetchMock,
  cognitoOk,
  cognitoError,
  cognitoCalls,
  cognitoOps,
} from "../auth/cognito-fetch-mock.js";

installFetchMock();

// DEVICE_SRP 経路は 3072-bit SRP modPow を実計算するため余裕を持たせる
vi.setConfig({ testTimeout: 30000 });

import { loginVerify, CONSUMER_CLIENT_ID } from "../../src/auth.js";
import {
  generateDeviceVerifier,
  generateEphemeralA,
  deviceAuthSecrets,
  devicePasswordSignature,
  __srpTest,
} from "../../src/device-srp.js";

// ─── 共通ヘルパー ────────────────────────────────────────────────────────────

const EMAIL = "user@example.com";
const INTERNAL_UUID = "550e8400-e29b-41d4-a716-446655440000";
const CONSUMER = CONSUMER_CLIENT_ID;

const CONFIRMED_DEVICE = {
  deviceKey: "ap-northeast-1_device-key-111",
  deviceGroupKey: "ap-northeast-1_device-group-111",
  devicePassword: "device-password-aaaaaaaaa==",
};

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
function makeJwt(exp = 9_999_999_999, extra = {}) {
  return `${b64url({ alg: "RS256" })}.${b64url({ aud: CONSUMER, exp, ...extra })}.sig`;
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

/** 標準 pending 状態 */
const BASE_PENDING = {
  clientId: CONSUMER,
  username: EMAIL,
  session: "sess-1",
  initiatedAt: "2026-06-01T00:00:00.000Z",
};

/** usernameInternal (UUID) 付き pending */
const PENDING_WITH_INTERNAL = {
  ...BASE_PENDING,
  usernameInternal: INTERNAL_UUID,
};

// DEVICE_SRP 経路で使う共通モック応答
const DEVICE_SRP_AUTH_RESPONSE = {
  ChallengeName: "DEVICE_SRP_AUTH",
  Session: "sess-srp-1",
  ChallengeParameters: { USERNAME: EMAIL },
};

// DEVICE_PASSWORD_VERIFIER チャレンジ (SRP_B / SALT は非ゼロ hex)
const DEVICE_PV_CHALLENGE = {
  ChallengeName: "DEVICE_PASSWORD_VERIFIER",
  Session: "sess-srp-2",
  ChallengeParameters: {
    USERNAME: EMAIL,
    SRP_B: "1234abcd5678ef",
    SALT: "aabbccdd1122",
    SECRET_BLOCK: Buffer.from("test-secret-block").toString("base64"),
  },
};

beforeEach(() => { fetchMock.mockReset(); });
afterAll(() => { vi.unstubAllGlobals(); });

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0019: CUSTOM_CHALLENGE 回答への DEVICE_KEY 付与条件
// ═════════════════════════════════════════════════════════════════════════════
describe("[AUTH-0019] CUSTOM_CHALLENGE 回答への DEVICE_KEY 付与条件", () => {
  it("[AUTH-0019] 同一 username の deviceKey がある時のみ ChallengeResponses に DEVICE_KEY を付与する", async () => {
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: { IdToken: makeJwt(), AccessToken: "at", RefreshToken: "rt" },
    }));
    const store = makeStore({
      tokens: {
        idToken: makeJwt(), refreshToken: "rt0", username: EMAIL,
        clientId: CONSUMER, ...CONFIRMED_DEVICE,
      },
      pending: BASE_PENDING,
    });
    await loginVerify(store, "123456");
    const call = cognitoCalls()[0];
    expect(call.op).toBe("RespondToAuthChallenge");
    expect(call.input.ChallengeName).toBe("CUSTOM_CHALLENGE");
    expect(call.input.ChallengeResponses.DEVICE_KEY).toBe(CONFIRMED_DEVICE.deviceKey);
  });

  it("[AUTH-0019] 別 username のトークンが保存されていても DEVICE_KEY は付与しない", async () => {
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: { IdToken: makeJwt(), AccessToken: "at", RefreshToken: "rt" },
    }));
    const store = makeStore({
      tokens: {
        idToken: makeJwt(), refreshToken: "rt0",
        username: "other@example.com", // 不一致
        clientId: CONSUMER, ...CONFIRMED_DEVICE,
      },
      pending: BASE_PENDING,
    });
    await loginVerify(store, "123456");
    const call = cognitoCalls()[0];
    expect(call.input.ChallengeResponses.DEVICE_KEY).toBeUndefined();
  });

  it("[AUTH-0019] usernameInternal (UUID) 一致でも DEVICE_KEY を付与する", async () => {
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: { IdToken: makeJwt(), AccessToken: "at", RefreshToken: "rt" },
    }));
    // existing.username === usernameInternal のケース
    const store = makeStore({
      tokens: {
        idToken: makeJwt(), refreshToken: "rt0",
        username: INTERNAL_UUID,
        clientId: CONSUMER, ...CONFIRMED_DEVICE,
      },
      pending: PENDING_WITH_INTERNAL,
    });
    await loginVerify(store, "123456");
    const call = cognitoCalls()[0];
    expect(call.input.ChallengeResponses.DEVICE_KEY).toBe(CONFIRMED_DEVICE.deviceKey);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0020: CUSTOM_CHALLENGE 回答には ClientMetadata を付けない
// ═════════════════════════════════════════════════════════════════════════════
describe("[AUTH-0020] CUSTOM_CHALLENGE 回答には ClientMetadata を付けない", () => {
  it("[AUTH-0020] RespondToAuthChallenge(CUSTOM_CHALLENGE) のペイロードに ClientMetadata キーが存在しない", async () => {
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: { IdToken: makeJwt(), AccessToken: "at", RefreshToken: "rt" },
    }));
    const store = makeStore({ pending: BASE_PENDING });
    await loginVerify(store, "123456");
    const call = cognitoCalls()[0];
    expect(call.op).toBe("RespondToAuthChallenge");
    expect(call.input.ChallengeName).toBe("CUSTOM_CHALLENGE");
    // CUSTOM_CHALLENGE 回答は ClientMetadata を含まない
    expect(Object.prototype.hasOwnProperty.call(call.input, "ClientMetadata")).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0021: コード誤り/期限切れ → CUSTOM_CHALLENGE 再発行 → 新 Session を pending に書き戻す
// ═════════════════════════════════════════════════════════════════════════════
describe("[AUTH-0021] 誤コードの CUSTOM_CHALLENGE 再発行で新 Session を pending に書き戻す", () => {
  it("[AUTH-0021] 新 Session 付き CUSTOM_CHALLENGE 再発行時は新 Session を pending に保存し clearPending せず throw する", async () => {
    const newSession = "sess-retry-new";
    fetchMock.mockResolvedValueOnce(cognitoOk({
      ChallengeName: "CUSTOM_CHALLENGE",
      Session: newSession,
    }));
    const store = makeStore({ pending: BASE_PENDING });
    await expect(loginVerify(store, "000000")).rejects.toThrow();
    // 新 Session が pending に書き戻されている
    expect(store._peekPending()).not.toBeNull();
    expect(store._peekPending().session).toBe(newSession);
    // clearPending は呼ばれていない
    expect(store.clearPending).not.toHaveBeenCalled();
  });

  it("[AUTH-0021] wrongCodeRetry のエラーメッセージ (Incorrect code|コードが違います) で throw する", async () => {
    fetchMock.mockResolvedValueOnce(cognitoOk({
      ChallengeName: "CUSTOM_CHALLENGE",
      Session: "sess-new-retry",
    }));
    const store = makeStore({ pending: BASE_PENDING });
    await expect(loginVerify(store, "000000")).rejects.toThrow(
      /Incorrect code|コードが違います/,
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0022: pending が無ければ loginVerify は throw する
// ═════════════════════════════════════════════════════════════════════════════
describe("[AUTH-0022] pending が無ければ loginVerify は throw する", () => {
  it("[AUTH-0022] loadPending()==null で loginVerify を呼ぶと auth.noPending で throw し RespondToAuthChallenge を送らない", async () => {
    const store = makeStore(); // pending なし
    await expect(loginVerify(store, "123456")).rejects.toThrow(
      /No pending sign-in/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0023: 予期しないチャレンジ名/空応答は throw する
// ═════════════════════════════════════════════════════════════════════════════
describe("[AUTH-0023] 予期しないチャレンジ名/空応答は throw する", () => {
  it("[AUTH-0023] CUSTOM_CHALLENGE でも DEVICE_SRP_AUTH でもないチャレンジ (SMS_MFA) が返ると throw する", async () => {
    fetchMock.mockResolvedValueOnce(cognitoOk({
      ChallengeName: "SMS_MFA",
      Session: "sess-x",
    }));
    const store = makeStore({ pending: BASE_PENDING });
    await expect(loginVerify(store, "123456")).rejects.toThrow(
      /SMS_MFA|Another challenge/,
    );
  });

  it("[AUTH-0023] AuthenticationResult もチャレンジも無い空応答で throw する", async () => {
    fetchMock.mockResolvedValueOnce(cognitoOk({}));
    const store = makeStore({ pending: BASE_PENDING });
    await expect(loginVerify(store, "123456")).rejects.toThrow(
      /No AuthenticationResult/,
    );
  });

  it("[AUTH-0023] NEW_PASSWORD_REQUIRED チャレンジでも throw する", async () => {
    fetchMock.mockResolvedValueOnce(cognitoOk({
      ChallengeName: "NEW_PASSWORD_REQUIRED",
      Session: "sess-np",
    }));
    const store = makeStore({ pending: BASE_PENDING });
    await expect(loginVerify(store, "123456")).rejects.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0024: 記憶済みデバイスで DEVICE_SRP_AUTH→DEVICE_PASSWORD_VERIFIER の 2 段を回答する
// ═════════════════════════════════════════════════════════════════════════════
describe("[AUTH-0024] 記憶済みデバイスで DEVICE_SRP_AUTH→DEVICE_PASSWORD_VERIFIER の 2 段を回答する", () => {
  it("[AUTH-0024] loginVerify 後に DEVICE_SRP_AUTH が来たら 2 コールを送り両回答に DEVICE_KEY を含める", async () => {
    fetchMock
      // 1. CUSTOM_CHALLENGE 回答 → DEVICE_SRP_AUTH
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "DEVICE_SRP_AUTH",
        Session: "sess-srp-1",
        ChallengeParameters: { USERNAME: EMAIL },
      }))
      // 2. DEVICE_SRP_AUTH → DEVICE_PASSWORD_VERIFIER
      .mockResolvedValueOnce(cognitoOk(DEVICE_PV_CHALLENGE))
      // 3. DEVICE_PASSWORD_VERIFIER → 成功
      .mockResolvedValueOnce(cognitoOk({
        AuthenticationResult: { IdToken: makeJwt(), AccessToken: "at", RefreshToken: "rt" },
      }))
      // 4. GetUser (nickname best-effort)
      .mockResolvedValueOnce(cognitoOk({
        UserAttributes: [{ Name: "nickname", Value: "existing" }],
      }));

    const store = makeStore({
      tokens: {
        idToken: makeJwt(), refreshToken: "rt0",
        username: EMAIL, clientId: CONSUMER,
        ...CONFIRMED_DEVICE,
      },
      pending: BASE_PENDING,
    });
    await loginVerify(store, "123456");

    const ops = cognitoOps();
    // RespondToAuthChallenge × 3 + GetUser
    expect(ops).toContain("RespondToAuthChallenge");
    expect(ops.filter((o) => o === "RespondToAuthChallenge").length).toBeGreaterThanOrEqual(3);

    const calls = cognitoCalls().filter((c) => c.op === "RespondToAuthChallenge");
    const srpACall = calls.find((c) => c.input.ChallengeName === "DEVICE_SRP_AUTH");
    const verifierCall = calls.find((c) => c.input.ChallengeName === "DEVICE_PASSWORD_VERIFIER");
    expect(srpACall).toBeTruthy();
    expect(verifierCall).toBeTruthy();
    expect(srpACall.input.ChallengeResponses.DEVICE_KEY).toBe(CONFIRMED_DEVICE.deviceKey);
    expect(verifierCall.input.ChallengeResponses.DEVICE_KEY).toBe(CONFIRMED_DEVICE.deviceKey);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0025: DEVICE_SRP_AUTH の ChallengeResponses {USERNAME, DEVICE_KEY, SRP_A}
// ═════════════════════════════════════════════════════════════════════════════
describe("[AUTH-0025] DEVICE_SRP_AUTH の ChallengeResponses {USERNAME, DEVICE_KEY, SRP_A} と USERNAME=内部ユーザー名", () => {
  it("[AUTH-0025] 1 段目 DEVICE_SRP_AUTH の ChallengeResponses が {USERNAME, DEVICE_KEY, SRP_A} の 3 フィールド", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "DEVICE_SRP_AUTH",
        Session: "sess-srp-1",
        ChallengeParameters: { USERNAME: EMAIL },
      }))
      .mockResolvedValueOnce(cognitoOk(DEVICE_PV_CHALLENGE))
      .mockResolvedValueOnce(cognitoOk({
        AuthenticationResult: { IdToken: makeJwt(), AccessToken: "at", RefreshToken: "rt" },
      }))
      .mockResolvedValueOnce(cognitoOk({
        UserAttributes: [{ Name: "nickname", Value: "x" }],
      }));

    const store = makeStore({
      tokens: {
        idToken: makeJwt(), refreshToken: "rt0",
        username: EMAIL, clientId: CONSUMER, ...CONFIRMED_DEVICE,
      },
      pending: BASE_PENDING,
    });
    await loginVerify(store, "123456");

    const calls = cognitoCalls().filter((c) => c.op === "RespondToAuthChallenge");
    const srpACall = calls.find((c) => c.input.ChallengeName === "DEVICE_SRP_AUTH");
    expect(srpACall).toBeTruthy();
    const cr = srpACall.input.ChallengeResponses;
    expect(cr.USERNAME).toBeDefined();
    expect(cr.DEVICE_KEY).toBe(CONFIRMED_DEVICE.deviceKey);
    expect(cr.SRP_A).toBeTypeOf("string");
    expect(cr.SRP_A.length).toBeGreaterThan(0);
    // 余分なフィールドは存在しない (3 フィールドのみ)
    const keys = Object.keys(cr).sort();
    expect(keys).toEqual(["DEVICE_KEY", "SRP_A", "USERNAME"]);
  });

  it("[AUTH-0025] USERNAME は ChallengeParameters.USERNAME (usernameInternal/UUID) を優先する", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "DEVICE_SRP_AUTH",
        Session: "sess-srp-1",
        ChallengeParameters: { USERNAME: INTERNAL_UUID }, // UUID 形式の内部ユーザー名
      }))
      .mockResolvedValueOnce(cognitoOk(DEVICE_PV_CHALLENGE))
      .mockResolvedValueOnce(cognitoOk({
        AuthenticationResult: { IdToken: makeJwt(), AccessToken: "at", RefreshToken: "rt" },
      }))
      .mockResolvedValueOnce(cognitoOk({
        UserAttributes: [{ Name: "nickname", Value: "x" }],
      }));

    const store = makeStore({
      tokens: {
        idToken: makeJwt(), refreshToken: "rt0",
        username: EMAIL, clientId: CONSUMER, ...CONFIRMED_DEVICE,
      },
      pending: BASE_PENDING,
    });
    await loginVerify(store, "123456");

    const calls = cognitoCalls().filter((c) => c.op === "RespondToAuthChallenge");
    const srpACall = calls.find((c) => c.input.ChallengeName === "DEVICE_SRP_AUTH");
    // USERNAME は ChallengeParameters.USERNAME (= usernameInternal/UUID) を優先
    expect(srpACall.input.ChallengeResponses.USERNAME).toBe(INTERNAL_UUID);
  });

  it("[AUTH-0025] ChallengeParameters.USERNAME が無ければ pending.username (email) をフォールバックに使う", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "DEVICE_SRP_AUTH",
        Session: "sess-srp-1",
        ChallengeParameters: {}, // USERNAME 無し
      }))
      .mockResolvedValueOnce(cognitoOk(DEVICE_PV_CHALLENGE))
      .mockResolvedValueOnce(cognitoOk({
        AuthenticationResult: { IdToken: makeJwt(), AccessToken: "at", RefreshToken: "rt" },
      }))
      .mockResolvedValueOnce(cognitoOk({
        UserAttributes: [{ Name: "nickname", Value: "x" }],
      }));

    const store = makeStore({
      tokens: {
        idToken: makeJwt(), refreshToken: "rt0",
        username: EMAIL, clientId: CONSUMER, ...CONFIRMED_DEVICE,
      },
      pending: BASE_PENDING,
    });
    await loginVerify(store, "123456");

    const calls = cognitoCalls().filter((c) => c.op === "RespondToAuthChallenge");
    const srpACall = calls.find((c) => c.input.ChallengeName === "DEVICE_SRP_AUTH");
    // ChallengeParameters.USERNAME が無いので pending.username (= email) を使う
    expect(srpACall.input.ChallengeResponses.USERNAME).toBe(EMAIL);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0026: DEVICE_PASSWORD_VERIFIER の ChallengeResponses キー集合と device 署名
// ═════════════════════════════════════════════════════════════════════════════
describe("[AUTH-0026] DEVICE_PASSWORD_VERIFIER の ChallengeResponses キー集合と device 署名", () => {
  it("[AUTH-0026] 2 段目 ChallengeResponses が {USERNAME, DEVICE_KEY, PASSWORD_CLAIM_SECRET_BLOCK, PASSWORD_CLAIM_SIGNATURE, TIMESTAMP} を含む", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk(DEVICE_SRP_AUTH_RESPONSE))
      .mockResolvedValueOnce(cognitoOk(DEVICE_PV_CHALLENGE))
      .mockResolvedValueOnce(cognitoOk({
        AuthenticationResult: { IdToken: makeJwt(), AccessToken: "at", RefreshToken: "rt" },
      }))
      .mockResolvedValueOnce(cognitoOk({
        UserAttributes: [{ Name: "nickname", Value: "x" }],
      }));

    const store = makeStore({
      tokens: {
        idToken: makeJwt(), refreshToken: "rt0",
        username: EMAIL, clientId: CONSUMER, ...CONFIRMED_DEVICE,
      },
      pending: BASE_PENDING,
    });
    await loginVerify(store, "123456");

    const calls = cognitoCalls().filter((c) => c.op === "RespondToAuthChallenge");
    const verifierCall = calls.find((c) => c.input.ChallengeName === "DEVICE_PASSWORD_VERIFIER");
    expect(verifierCall).toBeTruthy();
    const cr = verifierCall.input.ChallengeResponses;
    expect(cr.USERNAME).toBeTypeOf("string");
    expect(cr.DEVICE_KEY).toBe(CONFIRMED_DEVICE.deviceKey);
    expect(cr.PASSWORD_CLAIM_SECRET_BLOCK).toBeDefined();
    expect(cr.PASSWORD_CLAIM_SIGNATURE).toBeTypeOf("string");
    expect(cr.PASSWORD_CLAIM_SIGNATURE.length).toBeGreaterThan(0);
    expect(cr.TIMESTAMP).toBeTypeOf("string");
    expect(cr.TIMESTAMP.length).toBeGreaterThan(0);
    // 5 フィールドのみ
    const keys = Object.keys(cr);
    expect(keys).toHaveLength(5);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0027: device SRP の HKDF 鍵が実 Cognito の S と一致する (SRP 一致検証)
// ═════════════════════════════════════════════════════════════════════════════
describe("[AUTH-0027] device SRP の HKDF 鍵が実 Cognito の S と一致する (SRP 一致検証)", () => {
  const { N, G, K, modPow, calculateU } = __srpTest;

  it("[AUTH-0027] x=H(padHex(salt)|H(group key ':' password)), S=(B-k·g^x)^(a+u·x) mod N, HKDF がサーバ S と数式等価", () => {
    const { randomBytes } = require("node:crypto");

    const GROUP = CONFIRMED_DEVICE.deviceGroupKey;
    const DEVKEY = CONFIRMED_DEVICE.deviceKey;

    const v = generateDeviceVerifier(GROUP, DEVKEY);
    const verifier = BigInt("0x" + Buffer.from(v.passwordVerifier, "base64").toString("hex"));

    const { a, A } = generateEphemeralA();
    const b = (BigInt("0x" + randomBytes(128).toString("hex")) % N) || 1n;
    const B = (K * verifier + modPow(G, b, N)) % N;
    const u = calculateU(A, B);
    const serverS = modPow((A * modPow(verifier, u, N)) % N, b, N);

    const { sValue, hkdf } = deviceAuthSecrets({
      deviceGroupKey: GROUP,
      deviceKey: DEVKEY,
      devicePassword: v.devicePassword,
      serverB: B,
      salt: BigInt("0x" + Buffer.from(v.salt, "base64").toString("hex")),
      a,
      A,
    });

    // クライアント側 S がサーバ側 S と一致する
    expect(sValue).toBe(serverS);
    // HKDF が 16 バイト (Caldera Derived Key 長)
    expect(hkdf.length).toBe(16);
  });

  it("[AUTH-0027] devicePasswordSignature は HMAC-SHA256(hkdf, groupKey|devKey|secretBlock|timestamp) の base64 で決定論的", () => {
    const { randomBytes } = require("node:crypto");
    const hkdf = randomBytes(16);
    const args = {
      hkdf,
      deviceGroupKey: CONFIRMED_DEVICE.deviceGroupKey,
      deviceKey: CONFIRMED_DEVICE.deviceKey,
      secretBlock: Buffer.from("secret-block-data").toString("base64"),
      timestamp: "Tue Mar 4 02:03:04 UTC 2026",
    };
    const sig1 = devicePasswordSignature(args);
    const sig2 = devicePasswordSignature(args);
    expect(sig1).toBe(sig2);
    // HMAC-SHA256 の出力は 32 バイト
    expect(Buffer.from(sig1, "base64").length).toBe(32);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0028: DEVICE_SRP_AUTH 送信に ClientMetadata:{} を含める
// ═════════════════════════════════════════════════════════════════════════════
describe("[AUTH-0028] DEVICE_SRP_AUTH / DEVICE_PASSWORD_VERIFIER に ClientMetadata:{} を含める", () => {
  it("[AUTH-0028] DEVICE_SRP_AUTH と DEVICE_PASSWORD_VERIFIER の両回答が ClientMetadata:{} を含む", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk(DEVICE_SRP_AUTH_RESPONSE))
      .mockResolvedValueOnce(cognitoOk(DEVICE_PV_CHALLENGE))
      .mockResolvedValueOnce(cognitoOk({
        AuthenticationResult: { IdToken: makeJwt(), AccessToken: "at", RefreshToken: "rt" },
      }))
      .mockResolvedValueOnce(cognitoOk({
        UserAttributes: [{ Name: "nickname", Value: "x" }],
      }));

    const store = makeStore({
      tokens: {
        idToken: makeJwt(), refreshToken: "rt0",
        username: EMAIL, clientId: CONSUMER, ...CONFIRMED_DEVICE,
      },
      pending: BASE_PENDING,
    });
    await loginVerify(store, "123456");

    const calls = cognitoCalls().filter((c) => c.op === "RespondToAuthChallenge");
    const srpACall = calls.find((c) => c.input.ChallengeName === "DEVICE_SRP_AUTH");
    const verifierCall = calls.find((c) => c.input.ChallengeName === "DEVICE_PASSWORD_VERIFIER");
    // 両方に ClientMetadata:{} が存在する
    expect(srpACall.input.ClientMetadata).toEqual({});
    expect(verifierCall.input.ClientMetadata).toEqual({});
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0029: DEVICE_SRP_AUTH の応答が DEVICE_PASSWORD_VERIFIER でなければ throw する
// ═════════════════════════════════════════════════════════════════════════════
describe("[AUTH-0029] DEVICE_SRP_AUTH の応答が DEVICE_PASSWORD_VERIFIER でなければ throw する", () => {
  it("[AUTH-0029] 1 段目 DEVICE_SRP_AUTH の応答 ChallengeName が DEVICE_PASSWORD_VERIFIER でない場合に throw する", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk(DEVICE_SRP_AUTH_RESPONSE))
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "SMS_MFA", // 想定外
        Session: "sess-unexpected",
      }));

    const store = makeStore({
      tokens: {
        idToken: makeJwt(), refreshToken: "rt0",
        username: EMAIL, clientId: CONSUMER, ...CONFIRMED_DEVICE,
      },
      pending: BASE_PENDING,
    });
    await expect(loginVerify(store, "123456")).rejects.toThrow(
      /DEVICE_SRP_AUTH.*unexpected|unexpected.*DEVICE_SRP_AUTH/i,
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0030: device 資格情報欠落時は UNAUTHENTICATED で拒否する
// ═════════════════════════════════════════════════════════════════════════════
describe("[AUTH-0030] device 資格情報欠落時は UNAUTHENTICATED で拒否する", () => {
  it("[AUTH-0030] deviceKey が null なら auth.noDeviceCredentials で throw する", async () => {
    fetchMock.mockResolvedValueOnce(cognitoOk(DEVICE_SRP_AUTH_RESPONSE));
    const store = makeStore({
      tokens: {
        idToken: makeJwt(), refreshToken: "rt0",
        username: EMAIL, clientId: CONSUMER,
        deviceKey: null,
        deviceGroupKey: CONFIRMED_DEVICE.deviceGroupKey,
        devicePassword: CONFIRMED_DEVICE.devicePassword,
      },
      pending: BASE_PENDING,
    });
    await expect(loginVerify(store, "123456")).rejects.toThrow(
      /No stored device credentials|デバイス資格情報/,
    );
  });

  it("[AUTH-0030] deviceGroupKey が null でも throw する", async () => {
    fetchMock.mockResolvedValueOnce(cognitoOk(DEVICE_SRP_AUTH_RESPONSE));
    const store = makeStore({
      tokens: {
        idToken: makeJwt(), refreshToken: "rt0",
        username: EMAIL, clientId: CONSUMER,
        deviceKey: CONFIRMED_DEVICE.deviceKey,
        deviceGroupKey: null,
        devicePassword: CONFIRMED_DEVICE.devicePassword,
      },
      pending: BASE_PENDING,
    });
    await expect(loginVerify(store, "123456")).rejects.toThrow(
      /No stored device credentials|デバイス資格情報/,
    );
  });

  it("[AUTH-0030] devicePassword が null でも throw する", async () => {
    fetchMock.mockResolvedValueOnce(cognitoOk(DEVICE_SRP_AUTH_RESPONSE));
    const store = makeStore({
      tokens: {
        idToken: makeJwt(), refreshToken: "rt0",
        username: EMAIL, clientId: CONSUMER,
        deviceKey: CONFIRMED_DEVICE.deviceKey,
        deviceGroupKey: CONFIRMED_DEVICE.deviceGroupKey,
        devicePassword: null,
      },
      pending: BASE_PENDING,
    });
    await expect(loginVerify(store, "123456")).rejects.toThrow(
      /No stored device credentials|デバイス資格情報/,
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0031: DEVICE_SRP の NotAuthorized で device 3 点を破棄しデバイス無し CUSTOM_AUTH を再開始する
// ═════════════════════════════════════════════════════════════════════════════
describe("[AUTH-0031] DEVICE_SRP の NotAuthorized で device 3 点を破棄しデバイス無し CUSTOM_AUTH を再開始する", () => {
  it("[AUTH-0031] NotAuthorizedException で deviceKey/deviceGroupKey/devicePassword を null 保存し loginInitiate を再試行して staleDeviceRetry を throw する", async () => {
    fetchMock
      // 1. CUSTOM_CHALLENGE 回答 → DEVICE_SRP_AUTH
      .mockResolvedValueOnce(cognitoOk(DEVICE_SRP_AUTH_RESPONSE))
      // 2. DEVICE_SRP_AUTH → NotAuthorized
      .mockResolvedValueOnce(cognitoError("NotAuthorizedException", "Device does not exist."))
      // 3-4. 再開始 (loginInitiate): SignUp 既存容認 → InitiateAuth
      .mockResolvedValueOnce(cognitoError("UsernameExistsException", "exists"))
      .mockResolvedValueOnce(cognitoOk({ ChallengeName: "CUSTOM_CHALLENGE", Session: "sess-fresh" }));

    const store = makeStore({
      tokens: {
        idToken: makeJwt(), refreshToken: "rt0",
        username: EMAIL, clientId: CONSUMER, ...CONFIRMED_DEVICE,
      },
      pending: BASE_PENDING,
    });

    await expect(loginVerify(store, "123456")).rejects.toThrow(
      /new sign-in code|新しい確認コード|staleDevice/i,
    );

    // device 3 点が null に破棄されている
    const saved = store._peek();
    expect(saved.deviceKey).toBeNull();
    expect(saved.deviceGroupKey).toBeNull();
    expect(saved.devicePassword).toBeNull();

    // SignUp + InitiateAuth が発行されている (再開始)
    const ops = cognitoOps();
    expect(ops).toContain("SignUp");
    expect(ops).toContain("InitiateAuth");

    // pending は新 Session に更新済み
    expect(store._peekPending().session).toBe("sess-fresh");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0032: DEVICE_SRP の NotAuthorized 以外のエラーは後始末せず伝播する
// ═════════════════════════════════════════════════════════════════════════════
describe("[AUTH-0032] DEVICE_SRP の NotAuthorized 以外のエラーは後始末せず伝播する", () => {
  it("[AUTH-0032] NetworkError 等 NotAuthorized 以外で落ちた場合は device 3 点を破棄せず例外をそのまま伝播する", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk(DEVICE_SRP_AUTH_RESPONSE))
      .mockResolvedValueOnce(cognitoError("InternalErrorException", "server error", { status: 500 }));

    const store = makeStore({
      tokens: {
        idToken: makeJwt(), refreshToken: "rt0",
        username: EMAIL, clientId: CONSUMER, ...CONFIRMED_DEVICE,
      },
      pending: BASE_PENDING,
    });

    await expect(loginVerify(store, "123456")).rejects.toThrow(/server error/);

    // device 3 点は維持される
    const saved = store._peek();
    expect(saved.deviceKey).toBe(CONFIRMED_DEVICE.deviceKey);
    expect(saved.deviceGroupKey).toBe(CONFIRMED_DEVICE.deviceGroupKey);
    expect(saved.devicePassword).toBe(CONFIRMED_DEVICE.devicePassword);

    // SignUp/InitiateAuth は呼ばれていない (再開始しない)
    const ops = cognitoOps();
    expect(ops).not.toContain("SignUp");
    expect(ops).not.toContain("InitiateAuth");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0033: NewDeviceMetadata→ConfirmDevice のみ (UpdateDeviceStatus は送らない)
// ═════════════════════════════════════════════════════════════════════════════
describe("[AUTH-0033] NewDeviceMetadata→ConfirmDevice のみ (UpdateDeviceStatus は送らない)", () => {
  it("[AUTH-0033] ログイン成功応答に NewDeviceMetadata がある時 ConfirmDevice のみ発行し UpdateDeviceStatus を一切送らない", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({
        AuthenticationResult: {
          IdToken: makeJwt(),
          AccessToken: "at-dev",
          RefreshToken: "rt-dev",
          NewDeviceMetadata: { DeviceKey: "dev-new-key", DeviceGroupKey: "dev-new-group" },
        },
      }))
      .mockResolvedValueOnce(cognitoOk({ UserConfirmationNecessary: true })) // ConfirmDevice
      .mockResolvedValueOnce(cognitoOk({
        UserAttributes: [{ Name: "nickname", Value: "existing" }],
      })); // GetUser

    const store = makeStore({ pending: BASE_PENDING });
    const tokens = await loginVerify(store, "123456");

    const ops = cognitoOps();
    expect(ops).toContain("ConfirmDevice");
    // UpdateDeviceStatus は発行されない
    expect(ops).not.toContain("UpdateDeviceStatus");
    // device 3 点が保存される
    expect(tokens.deviceKey).toBe("dev-new-key");
    expect(tokens.deviceGroupKey).toBe("dev-new-group");
    expect(tokens.devicePassword).toBeTypeOf("string");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0034: ConfirmDevice のペイロード形
// ═════════════════════════════════════════════════════════════════════════════
describe("[AUTH-0034] ConfirmDevice のペイロード形 {AccessToken/DeviceKey/DeviceName/DeviceSecretVerifierConfig}", () => {
  it("[AUTH-0034] ConfirmDevice が {AccessToken, DeviceKey, DeviceName, DeviceSecretVerifierConfig:{PasswordVerifier, Salt}} の形で送られる", async () => {
    const accessToken = "at-confirm-test";
    const deviceKey = "dev-confirm-key";
    const deviceGroupKey = "dev-confirm-group";

    fetchMock
      .mockResolvedValueOnce(cognitoOk({
        AuthenticationResult: {
          IdToken: makeJwt(),
          AccessToken: accessToken,
          RefreshToken: "rt-confirm",
          NewDeviceMetadata: { DeviceKey: deviceKey, DeviceGroupKey: deviceGroupKey },
        },
      }))
      .mockResolvedValueOnce(cognitoOk({})) // ConfirmDevice
      .mockResolvedValueOnce(cognitoOk({
        UserAttributes: [{ Name: "nickname", Value: "x" }],
      })); // GetUser

    const store = makeStore({ pending: BASE_PENDING });
    await loginVerify(store, "123456");

    const calls = cognitoCalls();
    const confirmCall = calls.find((c) => c.op === "ConfirmDevice");
    expect(confirmCall).toBeTruthy();

    const input = confirmCall.input;
    expect(input.AccessToken).toBe(accessToken);
    expect(input.DeviceKey).toBe(deviceKey);
    expect(input.DeviceName).toBeTypeOf("string");
    expect(input.DeviceName.length).toBeGreaterThan(0);
    // DeviceSecretVerifierConfig は PasswordVerifier と Salt を持つ
    expect(input.DeviceSecretVerifierConfig).toBeTruthy();
    expect(input.DeviceSecretVerifierConfig.PasswordVerifier).toBeTypeOf("string");
    expect(input.DeviceSecretVerifierConfig.Salt).toBeTypeOf("string");
    // base64 として有効 (デコード可能)
    expect(() => Buffer.from(input.DeviceSecretVerifierConfig.PasswordVerifier, "base64")).not.toThrow();
    expect(() => Buffer.from(input.DeviceSecretVerifierConfig.Salt, "base64")).not.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0036: NewDeviceMetadata 無し (デバイストラッキング無効) は ConfirmDevice を送らない
// ═════════════════════════════════════════════════════════════════════════════
describe("[AUTH-0036] NewDeviceMetadata 無し (デバイストラッキング無効) は ConfirmDevice を送らず device 無しで成立", () => {
  it("[AUTH-0036] 応答に NewDeviceMetadata が無いときは ConfirmDevice を送らず device 無しトークンを保存する", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({
        AuthenticationResult: {
          IdToken: makeJwt(),
          AccessToken: "at-nodev",
          RefreshToken: "rt-nodev",
          // NewDeviceMetadata なし
        },
      }))
      .mockResolvedValueOnce(cognitoOk({
        UserAttributes: [{ Name: "nickname", Value: "x" }],
      })); // GetUser

    const store = makeStore({ pending: BASE_PENDING });
    const tokens = await loginVerify(store, "123456");

    // ConfirmDevice は発行されない
    expect(cognitoOps()).not.toContain("ConfirmDevice");
    // device 情報は null
    expect(tokens.deviceKey).toBeNull();
    expect(tokens.deviceGroupKey).toBeNull();
    expect(tokens.devicePassword).toBeNull();
    // トークン保存は成立
    expect(tokens.idToken).toBeTypeOf("string");
    expect(store.clearPending).toHaveBeenCalledTimes(1);
  });

  it("[AUTH-0036] NewDeviceMetadata があっても DeviceKey が欠落していれば ConfirmDevice を送らない", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({
        AuthenticationResult: {
          IdToken: makeJwt(),
          AccessToken: "at-nodevkey",
          RefreshToken: "rt-nodevkey",
          NewDeviceMetadata: { DeviceGroupKey: "grp-only" }, // DeviceKey 無し
        },
      }))
      .mockResolvedValueOnce(cognitoOk({
        UserAttributes: [{ Name: "nickname", Value: "x" }],
      })); // GetUser

    const store = makeStore({ pending: BASE_PENDING });
    const tokens = await loginVerify(store, "123456");

    expect(cognitoOps()).not.toContain("ConfirmDevice");
    expect(tokens.deviceKey).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0037: NewDeviceMetadata はあるが AccessToken 欠落は fail-fast で throw する
// ═════════════════════════════════════════════════════════════════════════════
describe("[AUTH-0037] NewDeviceMetadata はあるが AccessToken 欠落は fail-fast で throw する", () => {
  it("[AUTH-0037] NewDeviceMetadata があるのに AccessToken が無い異常系で throw し未確認 deviceKey を保存させない", async () => {
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: {
        IdToken: makeJwt(),
        // AccessToken なし
        RefreshToken: "rt-noat",
        NewDeviceMetadata: { DeviceKey: "dev-no-at", DeviceGroupKey: "grp-no-at" },
      },
    }));

    const store = makeStore({ pending: BASE_PENDING });
    await expect(loginVerify(store, "123456")).rejects.toThrow(
      /device confirmation failed|AccessToken|NewDeviceMetadata/i,
    );

    // ConfirmDevice は発行されていない
    expect(cognitoOps()).not.toContain("ConfirmDevice");
    // 未確認 deviceKey は保存されていない
    expect(store.save).not.toHaveBeenCalled();
    expect(store.clearPending).not.toHaveBeenCalled();
  });
});
