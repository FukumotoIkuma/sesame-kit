// auth-c0.test.js — AUTH-0001 〜 AUTH-0018 統合 TDD spec テスト
//
// 対象: packages/core/src/auth.js の loginInitiate / loginVerify
// 規範 (REFACTORING_PLAN.md §0.1): Android アプリ (AWSMobileClient 2.77.0 + CUSTOM_AUTH) 忠実。
// 一次参照: packages/core/src/auth.js / device-srp.js + _aws_sdk_ref/CognitoUser.java 他。
//
// モック方針: global.fetch を ../auth/cognito-fetch-mock.js で差し替え。ネットワーク・実機に触れない。
// SRP-6a (3072-bit modPow) を含むため testTimeout を 20000ms に緩める。
//
// TDD 方針: 実装が spec と食い違う箇所は正しい期待値(spec どおり)を assert する (red でよい)。

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

// SRP modPow は 3072-bit BigInt — タイムアウトを余裕をもって設定する。
vi.setConfig({ testTimeout: 20000 });

import { loginInitiate, loginVerify, CONSUMER_CLIENT_ID } from "../../src/auth.js";
import { generateEphemeralA, __srpTest } from "../../src/device-srp.js";

const { N, G, modPow } = __srpTest;

// ─────────────────────────────────────────────────────────────────────────────
// テスト共通ヘルパ
// ─────────────────────────────────────────────────────────────────────────────

const EMAIL = "user@example.com";
// pool が email → UUID 写像するケース用の内部ユーザー名
const INTERNAL_UUID = "550e8400-e29b-41d4-a716-446655440000";

const CONFIRMED_DEVICE = {
  deviceKey: "ap-northeast-1_DeviceKey111",
  deviceGroupKey: "ap-northeast-1_DeviceGroup111",
  devicePassword: "DevicePassword111+VGVzdA==",
};

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
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

// PASSWORD_VERIFIER チャレンジ用の標準パラメータ
const PV_CHALLENGE_PARAMS = {
  USERNAME: EMAIL,
  USER_ID_FOR_SRP: EMAIL,
  SRP_B: "1234abcd5678ef0199887766554433221100ffeeddccbbaa",
  SALT: "aabbccdd1122",
  SECRET_BLOCK: Buffer.from("test-secret-block").toString("base64"),
};

// UUID 形式の USERNAME を返す PASSWORD_VERIFIER チャレンジパラメータ
const PV_CHALLENGE_PARAMS_UUID = {
  USERNAME: INTERNAL_UUID,
  USER_ID_FOR_SRP: EMAIL,
  SRP_B: "1234abcd5678ef0199887766554433221100ffeeddccbbaa",
  SALT: "aabbccdd1122",
  SECRET_BLOCK: Buffer.from("test-secret-block").toString("base64"),
};

// loginVerify で使う pending の共通ベース
const PENDING_BASE = {
  clientId: CONSUMER_CLIENT_ID,
  username: EMAIL,
  session: "sess-1",
  initiatedAt: "2026-06-01T00:00:00.000Z",
};

// loginVerify が setNicknameIfNeeded → GetUser を呼ぶため、
// AuthenticationResult の次に GetUser の応答を必ずモックする (best-effort で .catch されるため
// undefined でも throw はしないが、mockResolvedValueOnce を付けることで余分な呼び出しを防ぐ)。
function mockGetUser() {
  fetchMock.mockResolvedValueOnce(cognitoOk({
    UserAttributes: [{ Name: "nickname", Value: "existing" }],
  }));
}

beforeEach(() => { fetchMock.mockReset(); });
afterAll(() => { vi.unstubAllGlobals(); });

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0001: loginInitiate が CUSTOM_AUTH の前に SignUp(dummypwk) を必ず送る
// ═════════════════════════════════════════════════════════════════════════════
describe("AUTH-0001: SignUp が InitiateAuth より前に実行される", () => {
  it("[AUTH-0001] loginInitiate は InitiateAuth より前に SignUp を送り Password=dummypwk / UserAttributes=[{Name:email,Value:username}]", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({ UserConfirmed: false, UserSub: "sub-001" })) // SignUp
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "CUSTOM_CHALLENGE",
        Session: "sess-001",
        ChallengeParameters: { email: EMAIL },
      })); // InitiateAuth

    const store = makeStore();
    await loginInitiate(store, EMAIL);

    // SignUp が InitiateAuth より前に呼ばれること
    expect(cognitoOps()).toEqual(["SignUp", "InitiateAuth"]);

    const [signUpCall] = cognitoCalls();
    expect(signUpCall.op).toBe("SignUp");
    // Password は "dummypwk" (LoginMailFG.kt:110 のアプリ値、web の "Aa123456" ではない)
    expect(signUpCall.input.Password).toBe("dummypwk");
    // UserAttributes は [{Name:"email", Value:username}] の形 (LoginMailFG.kt:106-107)
    expect(signUpCall.input.UserAttributes).toEqual([{ Name: "email", Value: EMAIL }]);
    expect(signUpCall.input.Username).toBe(EMAIL);
    expect(signUpCall.input.ClientId).toBe(CONSUMER_CLIENT_ID);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0002: SignUp に ValidationData:[] と ClientMetadata:{} を空のまま書き出す
// ═════════════════════════════════════════════════════════════════════════════
describe("AUTH-0002: SignUp ペイロードに ValidationData:[] と ClientMetadata:{} が含まれる", () => {
  it("[AUTH-0002] SignUp ペイロードが ValidationData:[] と ClientMetadata:{} を含む (空コレクションを省略しない)", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({ UserConfirmed: false })) // SignUp
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "CUSTOM_CHALLENGE",
        Session: "sess-002",
        ChallengeParameters: {},
      })); // InitiateAuth

    const store = makeStore();
    await loginInitiate(store, EMAIL);

    const [signUpCall] = cognitoCalls();
    // ValidationData:[] — SignUpRequestMarshaller.java:95-106 の != null チェックのみで空でも書く
    expect(signUpCall.input.ValidationData).toEqual([]);
    // ClientMetadata:{} — SignUpRequestMarshaller.java:119-137 の != null チェックのみで空でも書く
    expect(signUpCall.input.ClientMetadata).toEqual({});
    // 両フィールドが存在すること (undefined/省略は spec 違反)
    expect(Object.prototype.hasOwnProperty.call(signUpCall.input, "ValidationData")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(signUpCall.input, "ClientMetadata")).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0003: UsernameExistsException を容認して InitiateAuth へ進む
// ═════════════════════════════════════════════════════════════════════════════
describe("AUTH-0003: UsernameExistsException は握りつぶして InitiateAuth へ進む", () => {
  it("[AUTH-0003] SignUp が UsernameExistsException を返したとき例外を握り潰して CUSTOM_AUTH InitiateAuth に進む", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoError("UsernameExistsException", "An account with the given email already exists.")) // SignUp → 既存ユーザー
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "CUSTOM_CHALLENGE",
        Session: "sess-003",
        ChallengeParameters: { email: EMAIL },
      })); // InitiateAuth

    const store = makeStore();
    // throw しないこと
    const out = await loginInitiate(store, EMAIL);

    expect(cognitoOps()).toEqual(["SignUp", "InitiateAuth"]);
    expect(out.challenge).toBe("CUSTOM_CHALLENGE");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0004: UsernameExists 以外の SignUp エラーは中断し伝播する
// ═════════════════════════════════════════════════════════════════════════════
describe("AUTH-0004: UsernameExists 以外の SignUp エラーは throw して InitiateAuth に進まない", () => {
  it("[AUTH-0004] InvalidPasswordException 等 UsernameExists 以外の SignUp エラーで loginInitiate が throw し InitiateAuth に進まない", async () => {
    fetchMock.mockResolvedValueOnce(
      cognitoError("InvalidPasswordException", "Password does not conform to policy.")
    );

    const store = makeStore();
    await expect(loginInitiate(store, EMAIL)).rejects.toThrow(/Password does not conform to policy/);
    // InitiateAuth には進まない
    expect(cognitoOps()).toEqual(["SignUp"]);
    expect(store.savePending).not.toHaveBeenCalled();
  });

  it("[AUTH-0004] TooManyRequestsException (UsernameExists 以外) でも同様に中断する", async () => {
    fetchMock.mockResolvedValueOnce(
      cognitoError("TooManyRequestsException", "Rate exceeded")
    );

    const store = makeStore();
    await expect(loginInitiate(store, EMAIL)).rejects.toThrow(/Rate exceeded/);
    expect(cognitoOps()).toEqual(["SignUp"]);
  });

  it("[AUTH-0004] InvalidParameterException も中断する (UsernameExists 以外の分類)", async () => {
    fetchMock.mockResolvedValueOnce(
      cognitoError("InvalidParameterException", "bad email format")
    );

    const store = makeStore();
    await expect(loginInitiate(store, EMAIL)).rejects.toThrow(/bad email format/);
    expect(cognitoOps()).toEqual(["SignUp"]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0005: InitiateAuth が AuthFlow=CUSTOM_AUTH + AuthParameters{USERNAME,CHALLENGE_NAME:SRP_A,SRP_A}
// ═════════════════════════════════════════════════════════════════════════════
describe("AUTH-0005: InitiateAuth の AuthParameters キー集合と CHALLENGE_NAME 値", () => {
  it("[AUTH-0005] InitiateAuth の AuthParameters が {USERNAME, CHALLENGE_NAME:'SRP_A', SRP_A} で AuthFlow=CUSTOM_AUTH", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({})) // SignUp
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "CUSTOM_CHALLENGE",
        Session: "sess-005",
        ChallengeParameters: {},
      })); // InitiateAuth

    const store = makeStore();
    await loginInitiate(store, EMAIL);

    const [, initiateCall] = cognitoCalls();
    expect(initiateCall.op).toBe("InitiateAuth");
    // AuthFlow は CUSTOM_AUTH
    expect(initiateCall.input.AuthFlow).toBe("CUSTOM_AUTH");
    expect(initiateCall.input.ClientId).toBe(CONSUMER_CLIENT_ID);
    // AuthParameters のキー集合は {USERNAME, CHALLENGE_NAME, SRP_A} の 3 つ
    const params = initiateCall.input.AuthParameters;
    expect(params.USERNAME).toBe(EMAIL);
    // CHALLENGE_NAME は "SRP_A" (AuthenticationDetails.java:75, 182-184 の setCustomChallenge("SRP_A"))
    expect(params.CHALLENGE_NAME).toBe("SRP_A");
    // SRP_A は非空 hex 文字列 (CognitoUser.java:3493 の A.toString(16))
    expect(typeof params.SRP_A).toBe("string");
    expect(params.SRP_A.length).toBeGreaterThan(0);
    // DEVICE_KEY は含まない (CognitoUser.java:3473-3507)
    expect(params.DEVICE_KEY).toBeUndefined();
    // 余分なキーがないこと (3 キーのみ)
    expect(Object.keys(params).sort()).toEqual(["CHALLENGE_NAME", "SRP_A", "USERNAME"]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0006: SRP_A は A=g^a mod N の 16進文字列で、A≠0 を保証する
// ═════════════════════════════════════════════════════════════════════════════
describe("AUTH-0006: generateEphemeralA の数学的性質 (SRP-6a 3072-bit group)", () => {
  it("[AUTH-0006] SRP_A の値が generateEphemeralA() の A=g^a mod N を .toString(16) した hex で A%N!=0 (リトライループの保証)", () => {
    // 複数回実行して確率的に検証 (決定論的性質の確認)
    for (let i = 0; i < 5; i++) {
      const { a, A } = generateEphemeralA();
      // A = g^a mod N であること (__srpTest.modPow で直接確認)
      expect(modPow(G, a, N)).toBe(A);
      // A mod N != 0 であること (リトライループの保証)
      expect(A % N).not.toBe(0n);
      // a < N であること
      expect(a < N).toBe(true);
      // A の型とサイズ確認
      expect(typeof A).toBe("bigint");
      expect(A > 0n).toBe(true);
      // A.toString(16) が非空 hex 文字列であること
      const srpAHex = A.toString(16);
      expect(srpAHex).toMatch(/^[0-9a-f]+$/);
      expect(srpAHex.length).toBeGreaterThan(0);
    }
  });

  it("[AUTH-0006] loginInitiate が送る SRP_A が g^a mod N の hex に対応する (wire で確認)", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({})) // SignUp
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "CUSTOM_CHALLENGE",
        Session: "sess-006",
        ChallengeParameters: {},
      }));

    const store = makeStore();
    await loginInitiate(store, EMAIL);

    const [, initiateCall] = cognitoCalls();
    const srpAHex = initiateCall.input.AuthParameters.SRP_A;
    // hex 文字列であること
    expect(srpAHex).toMatch(/^[0-9a-f]+$/i);
    // A = BigInt("0x" + hex) として A mod N != 0 を確認
    const A = BigInt("0x" + srpAHex);
    expect(A % N).not.toBe(0n);
    // g^a mod N の範囲内 (0 < A < N)
    expect(A).toBeGreaterThan(0n);
    expect(A).toBeLessThan(N);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0007: InitiateAuth(CUSTOM_AUTH) には DEVICE_KEY を入れない
// ═════════════════════════════════════════════════════════════════════════════
describe("AUTH-0007: InitiateAuth の AuthParameters に DEVICE_KEY を含めない", () => {
  it("[AUTH-0007] store に同一 username の deviceKey が保存済みでも InitiateAuth の AuthParameters に DEVICE_KEY を含めない", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoError("UsernameExistsException", "exists")) // SignUp
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "CUSTOM_CHALLENGE",
        Session: "sess-007",
        ChallengeParameters: {},
      })); // InitiateAuth

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

    const [, initiateCall] = cognitoCalls();
    expect(initiateCall.op).toBe("InitiateAuth");
    // DEVICE_KEY は含まない (CognitoUser.java:3473-3507 の initiateCustomAuthRequest 仕様)
    expect(initiateCall.input.AuthParameters.DEVICE_KEY).toBeUndefined();
    expect(Object.keys(initiateCall.input.AuthParameters)).not.toContain("DEVICE_KEY");
    // 3 フィールドのみ
    expect(Object.keys(initiateCall.input.AuthParameters).sort()).toEqual([
      "CHALLENGE_NAME", "SRP_A", "USERNAME",
    ]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0008: InitiateAuth に ClientMetadata:{} を空のまま書き出す
// ═════════════════════════════════════════════════════════════════════════════
describe("AUTH-0008: InitiateAuth ペイロードに ClientMetadata:{} が含まれる", () => {
  it("[AUTH-0008] InitiateAuth ペイロードが ClientMetadata:{} を含む (空 Map でも書き出す)", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({})) // SignUp
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "CUSTOM_CHALLENGE",
        Session: "sess-008",
        ChallengeParameters: {},
      }));

    const store = makeStore();
    await loginInitiate(store, EMAIL);

    const [, initiateCall] = cognitoCalls();
    expect(initiateCall.op).toBe("InitiateAuth");
    // ClientMetadata:{} — CognitoUser.java:3480 / InitiateAuthRequestMarshaller.java:85-99
    // isEmpty ガード無しで空 Map でも {} を書く
    expect(initiateCall.input.ClientMetadata).toEqual({});
    expect(Object.prototype.hasOwnProperty.call(initiateCall.input, "ClientMetadata")).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0009: CUSTOM_CHALLENGE 直行応答を pending に保存して返す
// ═════════════════════════════════════════════════════════════════════════════
describe("AUTH-0009: CUSTOM_CHALLENGE 直行応答を pending に保存して返す", () => {
  it("[AUTH-0009] InitiateAuth 応答が CUSTOM_CHALLENGE のとき Session と usernameInternal を pending に保存し {challenge,params} を返す", async () => {
    const challengeParams = { USERNAME: INTERNAL_UUID, email: EMAIL };
    fetchMock
      .mockResolvedValueOnce(cognitoOk({})) // SignUp
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "CUSTOM_CHALLENGE",
        Session: "sess-009",
        ChallengeParameters: challengeParams,
      }));

    const store = makeStore();
    const out = await loginInitiate(store, EMAIL);

    // 戻り値
    expect(out).toEqual({ challenge: "CUSTOM_CHALLENGE", params: challengeParams });

    // pending に保存された値
    const pending = store._peekPending();
    expect(pending).not.toBeNull();
    expect(pending.clientId).toBe(CONSUMER_CLIENT_ID);
    expect(pending.username).toBe(EMAIL);
    expect(pending.session).toBe("sess-009");
    // ChallengeParameters.USERNAME が usernameInternal として保存される
    // (CognitoUser.java:3948-3962 の updateInternalUsername と一致)
    expect(pending.usernameInternal).toBe(INTERNAL_UUID);
  });

  it("[AUTH-0009] ChallengeParameters.USERNAME が無い場合は usernameInternal を保存しない", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({})) // SignUp
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "CUSTOM_CHALLENGE",
        Session: "sess-009b",
        ChallengeParameters: { email: EMAIL }, // USERNAME キー無し
      }));

    const store = makeStore();
    await loginInitiate(store, EMAIL);

    const pending = store._peekPending();
    expect(pending.session).toBe("sess-009b");
    expect(pending.usernameInternal).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0010: 想定外チャレンジ(CUSTOM_CHALLENGE/PASSWORD_VERIFIER 以外)は throw する
// ═════════════════════════════════════════════════════════════════════════════
describe("AUTH-0010: InitiateAuth が想定外チャレンジを返した場合は throw する", () => {
  it("[AUTH-0010] InitiateAuth が CUSTOM_CHALLENGE でも PASSWORD_VERIFIER でもないチャレンジ名を返したとき throw する", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({})) // SignUp
      .mockResolvedValueOnce(cognitoOk({ ChallengeName: "SMS_MFA", Session: "sess-010" }));

    const store = makeStore();
    await expect(loginInitiate(store, EMAIL)).rejects.toThrow(/Unexpected challenge.*SMS_MFA/);
    expect(store.savePending).not.toHaveBeenCalled();
  });

  it("[AUTH-0010] NEW_PASSWORD_REQUIRED も throw する", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({})) // SignUp
      .mockResolvedValueOnce(cognitoOk({ ChallengeName: "NEW_PASSWORD_REQUIRED" }));

    const store = makeStore();
    await expect(loginInitiate(store, EMAIL)).rejects.toThrow(/Unexpected challenge/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0011: InitiateAuth→PASSWORD_VERIFIER 応答に user SRP で RespondToAuthChallenge する
// ═════════════════════════════════════════════════════════════════════════════
describe("AUTH-0011: PASSWORD_VERIFIER 応答に RespondToAuthChallenge(PASSWORD_VERIFIER) を送る", () => {
  it("[AUTH-0011] InitiateAuth → PASSWORD_VERIFIER → RespondToAuthChallenge(PV) → CUSTOM_CHALLENGE の 3 コール連鎖", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({})) // SignUp
      .mockResolvedValueOnce(cognitoOk({    // InitiateAuth → PASSWORD_VERIFIER
        ChallengeName: "PASSWORD_VERIFIER",
        Session: "sess-pv-011",
        ChallengeParameters: PV_CHALLENGE_PARAMS,
      }))
      .mockResolvedValueOnce(cognitoOk({   // RespondToAuthChallenge → CUSTOM_CHALLENGE
        ChallengeName: "CUSTOM_CHALLENGE",
        Session: "sess-cc-011",
        ChallengeParameters: { email: EMAIL },
      }));

    const store = makeStore();
    const out = await loginInitiate(store, EMAIL);

    // 3 コール: SignUp / InitiateAuth / RespondToAuthChallenge(PASSWORD_VERIFIER)
    expect(cognitoOps()).toEqual(["SignUp", "InitiateAuth", "RespondToAuthChallenge"]);

    const [, , pvCall] = cognitoCalls();
    // RespondToAuthChallenge の ChallengeName が PASSWORD_VERIFIER
    expect(pvCall.input.ChallengeName).toBe("PASSWORD_VERIFIER");
    // Session が引き継がれること
    expect(pvCall.input.Session).toBe("sess-pv-011");

    // 最終的に CUSTOM_CHALLENGE を受けて pending に保存
    expect(out).toEqual({ challenge: "CUSTOM_CHALLENGE", params: { email: EMAIL } });
    expect(store._peekPending()).toMatchObject({
      clientId: CONSUMER_CLIENT_ID,
      username: EMAIL,
      session: "sess-cc-011",
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0012: PASSWORD_VERIFIER の ChallengeResponses キー集合と PASSWORD_CLAIM_SIGNATURE 形
// ═════════════════════════════════════════════════════════════════════════════
describe("AUTH-0012: PASSWORD_VERIFIER の ChallengeResponses キー集合と署名形式", () => {
  it("[AUTH-0012] ChallengeResponses が {PASSWORD_CLAIM_SECRET_BLOCK, PASSWORD_CLAIM_SIGNATURE, TIMESTAMP, USERNAME} を含み署名は base64 HMAC-SHA256", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({})) // SignUp
      .mockResolvedValueOnce(cognitoOk({    // InitiateAuth → PASSWORD_VERIFIER
        ChallengeName: "PASSWORD_VERIFIER",
        Session: "sess-pv-012",
        ChallengeParameters: PV_CHALLENGE_PARAMS,
      }))
      .mockResolvedValueOnce(cognitoOk({   // RespondToAuthChallenge → CUSTOM_CHALLENGE
        ChallengeName: "CUSTOM_CHALLENGE",
        Session: "sess-cc-012",
        ChallengeParameters: {},
      }));

    const store = makeStore();
    await loginInitiate(store, EMAIL);

    const [, , pvCall] = cognitoCalls();
    const cr = pvCall.input.ChallengeResponses;

    // 4 必須フィールド (CognitoUser.java:3638-3644)
    expect(cr.PASSWORD_CLAIM_SECRET_BLOCK).toBe(PV_CHALLENGE_PARAMS.SECRET_BLOCK);
    // PASSWORD_CLAIM_SIGNATURE は HMAC-SHA256(hkdf, poolName|userIdForSRP|secretBlock|timestamp) の base64
    expect(typeof cr.PASSWORD_CLAIM_SIGNATURE).toBe("string");
    // base64 デコードで 32 byte (HMAC-SHA256 の出力長)
    expect(Buffer.from(cr.PASSWORD_CLAIM_SIGNATURE, "base64").length).toBe(32);
    // TIMESTAMP は Cognito タイムスタンプ形式 "ddd MMM D HH:mm:ss UTC yyyy"
    expect(typeof cr.TIMESTAMP).toBe("string");
    expect(cr.TIMESTAMP).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2} UTC \d{4}$/);
    // USERNAME は usernameInternal または userIdForSRP (ここでは EMAIL)
    expect(typeof cr.USERNAME).toBe("string");
    expect(cr.USERNAME.length).toBeGreaterThan(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0013: PASSWORD_VERIFIER の USERNAME は usernameInternal(ChallengeParameters.USERNAME) を使う
// ═════════════════════════════════════════════════════════════════════════════
describe("AUTH-0013: PASSWORD_VERIFIER の ChallengeResponses.USERNAME は usernameInternal を使う", () => {
  it("[AUTH-0013] ChallengeParameters.USERNAME が UUID の場合 PASSWORD_VERIFIER 応答の USERNAME は UUID (usernameInternal)", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({})) // SignUp
      .mockResolvedValueOnce(cognitoOk({    // InitiateAuth → PASSWORD_VERIFIER (UUID内部名)
        ChallengeName: "PASSWORD_VERIFIER",
        Session: "sess-pv-013a",
        ChallengeParameters: PV_CHALLENGE_PARAMS_UUID,
      }))
      .mockResolvedValueOnce(cognitoOk({   // RespondToAuthChallenge → CUSTOM_CHALLENGE
        ChallengeName: "CUSTOM_CHALLENGE",
        Session: "sess-cc-013a",
        ChallengeParameters: {},
      }));

    const store = makeStore();
    await loginInitiate(store, EMAIL);

    const [, , pvCall] = cognitoCalls();
    // USERNAME は ChallengeParameters.USERNAME (UUID) であること
    // 参照: CognitoUser.java:3644 — srpAuthResponses.put(USERNAME, usernameInternal)
    expect(pvCall.input.ChallengeResponses.USERNAME).toBe(INTERNAL_UUID);
    expect(pvCall.input.ChallengeResponses.USERNAME).not.toBe(EMAIL);
  });

  it("[AUTH-0013] ChallengeParameters.USERNAME が無い場合 USER_ID_FOR_SRP にフォールバックする", async () => {
    // USERNAME キーが無い場合のフォールバック確認
    const paramsNoUsername = {
      USER_ID_FOR_SRP: EMAIL,
      SRP_B: "1234abcd5678ef0199887766554433221100ffeeddccbbaa",
      SALT: "aabbccdd1122",
      SECRET_BLOCK: Buffer.from("test-secret-block").toString("base64"),
    };

    fetchMock
      .mockResolvedValueOnce(cognitoOk({})) // SignUp
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "PASSWORD_VERIFIER",
        Session: "sess-pv-013b",
        ChallengeParameters: paramsNoUsername,
      }))
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "CUSTOM_CHALLENGE",
        Session: "sess-cc-013b",
        ChallengeParameters: {},
      }));

    const store = makeStore();
    await loginInitiate(store, EMAIL);

    const [, , pvCall] = cognitoCalls();
    // USERNAME なし → USER_ID_FOR_SRP (= EMAIL) にフォールバック
    expect(pvCall.input.ChallengeResponses.USERNAME).toBe(EMAIL);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0014: PASSWORD_VERIFIER 応答への DEVICE_KEY 付与条件
// ═════════════════════════════════════════════════════════════════════════════
describe("AUTH-0014: PASSWORD_VERIFIER の DEVICE_KEY 付与条件", () => {
  it("[AUTH-0014] store に同一 username(email) の deviceKey がある時のみ DEVICE_KEY を付与する", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({})) // SignUp
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "PASSWORD_VERIFIER",
        Session: "sess-pv-014a",
        ChallengeParameters: PV_CHALLENGE_PARAMS,
      }))
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "CUSTOM_CHALLENGE",
        Session: "sess-cc-014a",
        ChallengeParameters: {},
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

    const [, , pvCall] = cognitoCalls();
    // 同一 username → DEVICE_KEY を付与 (CognitoUser.java:3645)
    expect(pvCall.input.ChallengeResponses.DEVICE_KEY).toBe(CONFIRMED_DEVICE.deviceKey);
  });

  it("[AUTH-0014] store が空 (初回ログイン) なら DEVICE_KEY を付与しない", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({})) // SignUp
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "PASSWORD_VERIFIER",
        Session: "sess-pv-014b",
        ChallengeParameters: PV_CHALLENGE_PARAMS,
      }))
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "CUSTOM_CHALLENGE",
        Session: "sess-cc-014b",
        ChallengeParameters: {},
      }));

    const store = makeStore(); // トークン無し
    await loginInitiate(store, EMAIL);

    const [, , pvCall] = cognitoCalls();
    expect(pvCall.input.ChallengeResponses.DEVICE_KEY).toBeUndefined();
  });

  it("[AUTH-0014] 別 username のトークンが保存されていても DEVICE_KEY は付与しない (username 不一致)", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({})) // SignUp
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "PASSWORD_VERIFIER",
        Session: "sess-pv-014c",
        ChallengeParameters: PV_CHALLENGE_PARAMS,
      }))
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "CUSTOM_CHALLENGE",
        Session: "sess-cc-014c",
        ChallengeParameters: {},
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

    const [, , pvCall] = cognitoCalls();
    // 別ユーザーの device なので付与しない
    expect(pvCall.input.ChallengeResponses.DEVICE_KEY).toBeUndefined();
  });

  it("[AUTH-0014] store に同一 username(usernameInternal=UUID) の deviceKey がある時も DEVICE_KEY を付与する", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({})) // SignUp
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "PASSWORD_VERIFIER",
        Session: "sess-pv-014d",
        // ChallengeParameters.USERNAME が UUID (内部ユーザー名)
        ChallengeParameters: PV_CHALLENGE_PARAMS_UUID,
      }))
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "CUSTOM_CHALLENGE",
        Session: "sess-cc-014d",
        ChallengeParameters: {},
      }));

    // store.username が EMAIL で一致 (usernameInternal=UUID でも EMAIL で一致する)
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

    const [, , pvCall] = cognitoCalls();
    // pvLookupName = usernameInternal (UUID) or username (EMAIL)、
    // existingForPv.username === username (EMAIL) で一致 → DEVICE_KEY 付与
    expect(pvCall.input.ChallengeResponses.DEVICE_KEY).toBe(CONFIRMED_DEVICE.deviceKey);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0015: PASSWORD_VERIFIER 応答に ClientMetadata:{} を含める
// ═════════════════════════════════════════════════════════════════════════════
describe("AUTH-0015: RespondToAuthChallenge(PASSWORD_VERIFIER) に ClientMetadata:{} を含める", () => {
  it("[AUTH-0015] RespondToAuthChallenge(PASSWORD_VERIFIER) が ClientMetadata:{} を含む", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({})) // SignUp
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "PASSWORD_VERIFIER",
        Session: "sess-pv-015",
        ChallengeParameters: PV_CHALLENGE_PARAMS,
      }))
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "CUSTOM_CHALLENGE",
        Session: "sess-cc-015",
        ChallengeParameters: {},
      }));

    const store = makeStore();
    await loginInitiate(store, EMAIL);

    const [, , pvCall] = cognitoCalls();
    expect(pvCall.input.ChallengeName).toBe("PASSWORD_VERIFIER");
    // ClientMetadata:{} — CognitoUser.java:3653 / RespondToAuthChallengeRequestMarshaller.java:110-124
    // Java は空 Map をセットし marshaller が isEmpty ガード無しで {} を書く
    expect(pvCall.input.ClientMetadata).toEqual({});
    expect(Object.prototype.hasOwnProperty.call(pvCall.input, "ClientMetadata")).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0016: PASSWORD_VERIFIER の後に CUSTOM_CHALLENGE 以外が来たら throw する
// ═════════════════════════════════════════════════════════════════════════════
describe("AUTH-0016: RespondToAuthChallenge(PV) の応答が CUSTOM_CHALLENGE でない場合は throw する", () => {
  it("[AUTH-0016] RespondToAuthChallenge(PV) の応答が CUSTOM_CHALLENGE でない場合に throw する", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({})) // SignUp
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "PASSWORD_VERIFIER",
        Session: "sess-pv-016",
        ChallengeParameters: PV_CHALLENGE_PARAMS,
      }))
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "NEW_PASSWORD_REQUIRED", // 想定外
        Session: "sess-np-016",
      }));

    const store = makeStore();
    await expect(loginInitiate(store, EMAIL)).rejects.toThrow(
      /Unexpected challenge after PASSWORD_VERIFIER: NEW_PASSWORD_REQUIRED/
    );
    expect(store.savePending).not.toHaveBeenCalled();
  });

  it("[AUTH-0016] SMS_MFA が来た場合も throw する", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({})) // SignUp
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "PASSWORD_VERIFIER",
        Session: "sess-pv-016b",
        ChallengeParameters: PV_CHALLENGE_PARAMS,
      }))
      .mockResolvedValueOnce(cognitoOk({
        ChallengeName: "SMS_MFA",
        Session: "sess-sms-016",
      }));

    const store = makeStore();
    await expect(loginInitiate(store, EMAIL)).rejects.toThrow(
      /Unexpected challenge after PASSWORD_VERIFIER: SMS_MFA/
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0017: loginVerify が RespondToAuthChallenge(CUSTOM_CHALLENGE) を ANSWER 形で送る
// ═════════════════════════════════════════════════════════════════════════════
describe("AUTH-0017: loginVerify の RespondToAuthChallenge(CUSTOM_CHALLENGE) 形式", () => {
  it("[AUTH-0017] ChallengeResponses のキー集合が {USERNAME, ANSWER} で ChallengeName=CUSTOM_CHALLENGE / Session=pending.session", async () => {
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: {
        IdToken: makeJwt(),
        AccessToken: "at-017",
        RefreshToken: "rt-017",
      },
    }));
    // setNicknameIfNeeded → GetUser (best-effort)
    mockGetUser();

    const store = makeStore({
      pending: {
        clientId: CONSUMER_CLIENT_ID,
        username: EMAIL,
        session: "sess-017",
        initiatedAt: "2026-06-01T00:00:00.000Z",
      },
    });
    await loginVerify(store, "123456");

    const [call] = cognitoCalls();
    expect(call.op).toBe("RespondToAuthChallenge");
    expect(call.input.ChallengeName).toBe("CUSTOM_CHALLENGE");
    expect(call.input.Session).toBe("sess-017");
    expect(call.input.ClientId).toBe(CONSUMER_CLIENT_ID);
    // ChallengeResponses は {USERNAME, ANSWER} (DEVICE_KEY なし)
    expect(call.input.ChallengeResponses.USERNAME).toBe(EMAIL);
    expect(call.input.ChallengeResponses.ANSWER).toBe("123456");
    // DEVICE_KEY は store にトークンが無いので付かない
    expect(call.input.ChallengeResponses.DEVICE_KEY).toBeUndefined();
    // CUSTOM_CHALLENGE 応答に ClientMetadata を付けない
    // (ChallengeContinuation.java:168-170 の isEmpty ガード)
    expect(call.input.ClientMetadata).toBeUndefined();
  });

  it("[AUTH-0017] 保存済み deviceKey (同一 username) がある場合は DEVICE_KEY も ChallengeResponses に含まれる", async () => {
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: {
        IdToken: makeJwt(),
        AccessToken: "at-017b",
        RefreshToken: "rt-017b",
      },
    }));
    mockGetUser();

    const store = makeStore({
      tokens: {
        idToken: makeJwt(),
        refreshToken: "rt",
        username: EMAIL,
        clientId: CONSUMER_CLIENT_ID,
        ...CONFIRMED_DEVICE,
      },
      pending: {
        clientId: CONSUMER_CLIENT_ID,
        username: EMAIL,
        session: "sess-017b",
        initiatedAt: "2026-06-01T00:00:00.000Z",
      },
    });
    await loginVerify(store, "654321");

    const [call] = cognitoCalls();
    expect(call.op).toBe("RespondToAuthChallenge");
    expect(call.input.ChallengeName).toBe("CUSTOM_CHALLENGE");
    expect(call.input.ChallengeResponses.USERNAME).toBe(EMAIL);
    expect(call.input.ChallengeResponses.ANSWER).toBe("654321");
    expect(call.input.ChallengeResponses.DEVICE_KEY).toBe(CONFIRMED_DEVICE.deviceKey);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0018: CUSTOM_CHALLENGE 回答の USERNAME は usernameInternal を優先する
// ═════════════════════════════════════════════════════════════════════════════
describe("AUTH-0018: loginVerify の ChallengeResponses.USERNAME は usernameInternal を優先する", () => {
  it("[AUTH-0018] pending.usernameInternal がある場合 ChallengeResponses.USERNAME は UUID (usernameInternal) を使う", async () => {
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: {
        IdToken: makeJwt(),
        AccessToken: "at-018a",
        RefreshToken: "rt-018a",
      },
    }));
    mockGetUser();

    const store = makeStore({
      pending: {
        clientId: CONSUMER_CLIENT_ID,
        username: EMAIL,
        usernameInternal: INTERNAL_UUID, // 内部 UUID が pending に格納済み
        session: "sess-018a",
        initiatedAt: "2026-06-01T00:00:00.000Z",
      },
    });
    await loginVerify(store, "111111");

    const [call] = cognitoCalls();
    expect(call.op).toBe("RespondToAuthChallenge");
    // USERNAME は usernameInternal (UUID) であること
    // 参照: ChallengeContinuation.java:162 (username に usernameInternal が入る)
    //       CognitoUser.java:3948-3962 (updateInternalUsername)
    expect(call.input.ChallengeResponses.USERNAME).toBe(INTERNAL_UUID);
    expect(call.input.ChallengeResponses.USERNAME).not.toBe(EMAIL);
    expect(call.input.ChallengeResponses.ANSWER).toBe("111111");
  });

  it("[AUTH-0018] pending.usernameInternal が無い場合は pending.username (email) にフォールバックする", async () => {
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: {
        IdToken: makeJwt(),
        AccessToken: "at-018b",
        RefreshToken: "rt-018b",
      },
    }));
    mockGetUser();

    const store = makeStore({
      pending: {
        clientId: CONSUMER_CLIENT_ID,
        username: EMAIL,
        // usernameInternal なし (写像無し Pool)
        session: "sess-018b",
        initiatedAt: "2026-06-01T00:00:00.000Z",
      },
    });
    await loginVerify(store, "222222");

    const [call] = cognitoCalls();
    // usernameInternal が無ければ username (email) を使う
    expect(call.input.ChallengeResponses.USERNAME).toBe(EMAIL);
    expect(call.input.ChallengeResponses.ANSWER).toBe("222222");
  });

  it("[AUTH-0018] usernameInternal がある場合 DEVICE_KEY 照合も usernameInternal で行う", async () => {
    // pending.usernameInternal (UUID) と existing.username (UUID) が一致するケース
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: {
        IdToken: makeJwt(),
        AccessToken: "at-018c",
        RefreshToken: "rt-018c",
      },
    }));
    mockGetUser();

    const store = makeStore({
      tokens: {
        idToken: makeJwt(),
        refreshToken: "rt",
        username: INTERNAL_UUID, // 保存トークンの username は UUID
        clientId: CONSUMER_CLIENT_ID,
        ...CONFIRMED_DEVICE,
      },
      pending: {
        clientId: CONSUMER_CLIENT_ID,
        username: EMAIL,
        usernameInternal: INTERNAL_UUID, // pending の内部ユーザー名も UUID
        session: "sess-018c",
        initiatedAt: "2026-06-01T00:00:00.000Z",
      },
    });
    await loginVerify(store, "333333");

    const [call] = cognitoCalls();
    // USERNAME は usernameInternal (UUID)
    expect(call.input.ChallengeResponses.USERNAME).toBe(INTERNAL_UUID);
    // 同一 usernameInternal → DEVICE_KEY も付与
    expect(call.input.ChallengeResponses.DEVICE_KEY).toBe(CONFIRMED_DEVICE.deviceKey);
    expect(call.input.ChallengeResponses.ANSWER).toBe("333333");
  });
});
