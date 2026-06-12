// user SRP (PASSWORD_VERIFIER) の固定ベクタ回帰テスト。
//
// 目的: auth.js の respondToPasswordVerifier を device-srp.js の srpPasswordSecrets に
//   統合した際、PASSWORD_CLAIM_SIGNATURE が統合前と完全に同一であることを保証する
//   (バイト精度の回帰固定)。Cognito サーバ側検証はバイト一致が命なので、同じ入力
//   (poolName/username/password/salt/B/secretBlock/timestamp + 固定 a/A) に対し
//   署名が 1 bit でも変われば実機ログイン不能になる。
//
// ゴールデン値の出所:
//   統合前 auth.js の user-SRP アルゴリズム (Java BigInteger.toByteArray() バイナリ連結方式) を
//   独立に再実装して算出した値をハードコードしている。device-srp.js の実装には依存しない
//   アンカーなので、「統合により計算が変わっていない」ことの独立した証明になる。
//   - poolName       = "bY2byhlCa"  (USER_POOL_ID "ap-northeast-1_bY2byhlCa" の "_" 以降)
//   - userIdForSRP   = "user@example.com"
//   - password       = "dummypwk"
//   - a (固定)       = 0x11..11 (128 bytes) → A = g^a mod N (deterministic)
//   - salt           = "aabbccdd1122"
//   - SRP_B          = "1234abcd5678ef0199887766554433221100ffeeddccbbaa"
//   - SECRET_BLOCK   = base64("test-secret-block")
//   - timestamp      = "Wed Mar 4 02:03:04 UTC 2026"
//
// 参照: _aws_sdk_ref/CognitoUser.java:3588-3662 (userSrpAuthRequest),
//       _aws_sdk_ref/CognitoUser.java:4060-4096 (getPasswordAuthenticationKey)。
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  fetchMock,
  installFetchMock,
  cognitoOk,
  cognitoCalls,
} from "./cognito-fetch-mock.js";

installFetchMock();

// device-srp.js を部分モック: generateEphemeralA だけ固定 { a, A } を返すよう差し替える。
// SRP 数式本体 (srpPasswordSecrets / cognitoTimestamp など) は実物を素通しして、
// 統合済みの実コードを通したうえで署名が決定的になるようにする。
// 注意: vi.mock のファクトリは hoist されるため、トップレベル変数を参照できない。
//   固定 a の hex (= "11" × 128) はファクトリ内にインラインで持つ。
vi.mock("../../src/device-srp.js", async (importOriginal) => {
  const real = /** @type {typeof import("../../src/device-srp.js")} */ (await importOriginal());
  // a = 0x11..11 から A = g^a mod N を実 modPow で導出 (統合前ベクタ算出と同一手順)。
  const { N, G, modPow } = real.__srpTest;
  const a = BigInt("0x" + "11".repeat(128));
  const A = modPow(G, a, N);
  return {
    ...real,
    generateEphemeralA: () => ({ a, A }),
  };
});

// vi.mock は hoist されるため、auth.js の import は mock 適用後に解決される。
import { loginInitiate, CONSUMER_CLIENT_ID } from "../../src/auth.js";

vi.setConfig({ testTimeout: 20000 });

const EMAIL = "user@example.com";

// 統合前アルゴリズムから算出したゴールデン署名 (ハードコード回帰固定)。
const GOLDEN_SIGNATURE = "mvQ3Gy+v1fqNsbxv8tgnpjOfGqXfKOXYbV3XFzTqLGQ=";
const FIXED_TIMESTAMP = "Wed Mar 4 02:03:04 UTC 2026";
// cognitoTimestamp(new Date()) が FIXED_TIMESTAMP になる UTC 時刻 (2026-03-04 02:03:04Z = Wed)。
const FIXED_DATE_MS = Date.UTC(2026, 2, 4, 2, 3, 4);

const PV_CHALLENGE_PARAMS = {
  USERNAME: EMAIL,
  USER_ID_FOR_SRP: EMAIL,
  SRP_B: "1234abcd5678ef0199887766554433221100ffeeddccbbaa",
  SALT: "aabbccdd1122",
  SECRET_BLOCK: Buffer.from("test-secret-block").toString("base64"),
};

function makeStore() {
  let p = null;
  return {
    load: vi.fn(() => null),
    save: vi.fn(),
    clear: vi.fn(),
    loadPending: vi.fn(() => (p ? { ...p } : null)),
    savePending: vi.fn((next) => { p = { ...next }; }),
    clearPending: vi.fn(() => { p = null; }),
  };
}

beforeEach(() => { fetchMock.mockReset(); });
afterAll(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("user SRP PASSWORD_VERIFIER — 固定ベクタ回帰 (統合前後でバイト一致)", () => {
  it("固定入力に対し PASSWORD_CLAIM_SIGNATURE が統合前のゴールデン値と完全一致する", async () => {
    // timestamp を固定 (cognitoTimestamp は new Date() ベースなので時刻を凍結する)。
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_DATE_MS));

    try {
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

      const pvResp = cognitoCalls()[2];
      expect(pvResp.input.ChallengeName).toBe("PASSWORD_VERIFIER");
      // timestamp が固定値であること (前提条件の確認)。
      expect(pvResp.input.ChallengeResponses.TIMESTAMP).toBe(FIXED_TIMESTAMP);
      // 署名がゴールデン値とバイト一致すること (統合の回帰固定)。
      expect(pvResp.input.ChallengeResponses.PASSWORD_CLAIM_SIGNATURE).toBe(GOLDEN_SIGNATURE);
      // secretBlock / username はそのまま透過。
      expect(pvResp.input.ChallengeResponses.PASSWORD_CLAIM_SECRET_BLOCK).toBe(PV_CHALLENGE_PARAMS.SECRET_BLOCK);
      expect(pvResp.input.ChallengeResponses.USERNAME).toBe(EMAIL);
    } finally {
      vi.useRealTimers();
    }
  });
});
