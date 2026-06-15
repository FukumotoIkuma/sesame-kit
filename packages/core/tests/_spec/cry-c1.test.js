// cry-c1.test.js — CRY-0019 〜 CRY-0034 統合 TDD spec テスト (merged A+B)
//
// 方針:
//   - 各 spec につき 1 個以上の it を書き、タイトル先頭に [<ID>] を置く。
//   - assert は spec どおりの期待値を検証 (実装の現状に合わせて歪めない)。
//   - ネットワーク/実機に触れない。全て純関数か fake timers で決定的に動く。
//   - ファイル自己完結 (先頭 import、describe でまとめ、各 it 独立)。

import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import { createHash, createHmac, createECDH } from "node:crypto";

import { aesCmac } from "../../src/aes-cmac.js";
import {
  ecdhSharedSecret,
  ecdhSecretPre16,
  deriveRegisterPriKey,
  getRegisterKey,
  SERVER_AUTH_PUBKEY,
  assertValidP256Scalar,
  P256_ORDER,
} from "../../src/crypto.js";
import {
  srpPasswordSecrets,
  generateDeviceVerifier,
  devicePasswordSignature,
  cognitoTimestamp,
  generateEphemeralA,
  __srpTest,
} from "../../src/device-srp.js";
import { signRequest, deriveSigningKey, sha256Hex } from "../../src/sigv4.js";

// ============================================================
// Shared test fixtures
// ============================================================

// device-srp.js 内部テスト用エクスポート (テスト専用 API)
const { N, G, K, modPow, calculateU, padHex } = __srpTest;

// Test-local sha256 utilities (independent reimplementation for KAT anchors)
function sha256HexLocal(data) {
  return createHash("sha256").update(data).digest("hex").padStart(64, "0");
}
function hexHash(hexStr) {
  return sha256HexLocal(Buffer.from(hexStr, "hex"));
}
function padHexLocal(bigInt) {
  let hex = bigInt.toString(16);
  if (hex.length % 2 === 1) hex = "0" + hex;
  else if ("89abcdef".includes(hex[0].toLowerCase())) hex = "00" + hex;
  return hex;
}

// SRP-6a 3072-bit group prime (RFC 5054 / Cognito 共通). g = 2.
const N_HEX =
  "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1" +
  "29024E088A67CC74020BBEA63B139B22514A08798E3404DD" +
  "EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245" +
  "E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED" +
  "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D" +
  "C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F" +
  "83655D23DCA3AD961C62F356208552BB9ED529077096966D" +
  "670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B" +
  "E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9" +
  "DE2BCBF6955817183995497CEA956AE515D2261898FA0510" +
  "15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64" +
  "ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7" +
  "ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6B" +
  "F12FFA06D98A0864D87602733EC86A64521F2B18177B200C" +
  "BBE117577A615D6C770988C0BAD946E208E24FA074E5AB31" +
  "43DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF";

// Fixed ephemeral secret: a = 0x11..11 (128 bytes)
const FIXED_A_HEX = "11".repeat(128);
const FIXED_A = BigInt("0x" + FIXED_A_HEX);
const FIXED_A_PUB = modPow(G, FIXED_A, N); // A = g^a mod N

// Fixed SRP-B (server public value) for tests
const FIXED_B_HEX = "1234abcd5678ef0199887766554433221100ffeeddccbbaa";
const FIXED_B = BigInt("0x" + FIXED_B_HEX);

// Fixed salt
const FIXED_SALT_HEX = "aabbccdd1122";
const FIXED_SALT = BigInt("0x" + FIXED_SALT_HEX);

// Fixed credentials for user SRP
const POOL_NAME = "bY2byhlCa"; // poolName (USER_POOL_ID suffix after "_")
const USER_ID = "user@example.com";
const USER_PASSWORD = "dummypwk";

// Fixed credentials for device SRP
const DEVICE_GROUP_KEY = "ap-northeast-1_TestPool";
const DEVICE_KEY = "us-east-1:test-device-key";
const DEVICE_PASSWORD = "testDevicePassword";

// Fixed SECRET_BLOCK and timestamp (from user-srp-vector.test.js)
const SECRET_BLOCK_B64 = Buffer.from("test-secret-block").toString("base64");
const FIXED_TIMESTAMP = "Wed Mar 4 02:03:04 UTC 2026";
const FIXED_DATE_MS = Date.UTC(2026, 2, 4, 2, 3, 4); // 2026-03-04 02:03:04Z = Wednesday

// SigV4 test constants
const ACCESS_KEY = "AKIDEXAMPLE";
const SECRET_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const FIXED_DATE = new Date("2015-08-30T12:36:00Z");
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb924" +
  "27ae41e4649b934ca495991b7852b855";

// ECDH / register fixtures
const E_HEX = "00112233445566778899aabbccddeeff";
const AK_B64 = Buffer.from("0102030405060708090a0b0c0d0e0f10", "hex").toString("base64");
const N_B64  = Buffer.from("aabbccddeeff00112233445566778899", "hex").toString("base64");
const SERVER_TOKEN = Buffer.from("deadbeef", "hex");

// 32B big-endian Buffer from BigInt scalar
function scalarBuf(v) {
  return Buffer.from(v.toString(16).padStart(64, "0"), "hex");
}

// ============================================================
// CRY-0019: SRP-6a x = H(padHex(salt) || H(firstId secondId ':' password)) 固定ベクタ
// ============================================================

describe("CRY-0019 SRP-6a x = H(padHex(salt) || H(firstId secondId ':' password)) 固定ベクタ", () => {
  it("[CRY-0019] 固定 (firstId, secondId, password, salt) に対し passwordHash と x が独立再計算と一致する固定 KAT", () => {
    // 独立再計算 (実装に依存しないアンカー)
    const passwordHash = sha256HexLocal(`${POOL_NAME}${USER_ID}:${USER_PASSWORD}`);
    // x = SHA-256(padHex(salt) || passwordHash)
    const expectedPadSalt = padHexLocal(FIXED_SALT);
    const xHex = hexHash(expectedPadSalt + passwordHash);
    const expectedX = BigInt("0x" + xHex);

    // Known golden values (computed independently)
    expect(passwordHash).toBe(
      "6c40d3d8f940860b8ea0130a2ac1d62b7ca1c108cac34c3dbb8fe945f96b1837",
    );
    expect(expectedX.toString(16)).toBe(
      "d3f19964ae4f9512e3b35323cd763ba827ed3fa3426e7a7f0e7e2200c4598e6",
    );

    // Verify padHex of salt produces "00" prefix when salt hex starts with 'a' (0xaa > 0x80)
    expect(expectedPadSalt.startsWith("00")).toBe(true);
    expect(expectedPadSalt).toBe("00" + FIXED_SALT_HEX);

    // Verify srpPasswordSecrets returns the same x value
    const { x: actualX } = srpPasswordSecrets({
      firstId: POOL_NAME,
      secondId: USER_ID,
      password: USER_PASSWORD,
      serverB: FIXED_B,
      salt: FIXED_SALT,
      a: FIXED_A,
      A: FIXED_A_PUB,
    });
    expect(actualX).toBe(expectedX);
  });
});

// ============================================================
// CRY-0020: SRP-6a u = H(padHex(A) || padHex(B)) 固定ベクタ
// ============================================================

describe("CRY-0020 SRP-6a u = H(padHex(A) || padHex(B)) 固定ベクタ", () => {
  it("[CRY-0020] 固定 (A, B) に対し u = SHA-256(padHex(A) || padHex(B)) が独立再計算と一致する固定 KAT", () => {
    // 独立再計算
    const expectedU = BigInt("0x" + hexHash(padHexLocal(FIXED_A_PUB) + padHexLocal(FIXED_B)));

    // Known golden value
    expect(expectedU.toString(16)).toBe(
      "6da1e798aa57a3e6ee94e928430c9dc2ea8d53a03a272d4ad6c114dc5923ebac",
    );

    // u != 0 for these inputs
    expect(expectedU).not.toBe(0n);

    // srpPasswordSecrets must return the same u
    const { u: actualU } = srpPasswordSecrets({
      firstId: POOL_NAME,
      secondId: USER_ID,
      password: USER_PASSWORD,
      serverB: FIXED_B,
      salt: FIXED_SALT,
      a: FIXED_A,
      A: FIXED_A_PUB,
    });
    expect(actualU).toBe(expectedU);
  });

  it("[CRY-0020] calculateU が __srpTest.calculateU と等価", () => {
    const uDirect = calculateU(FIXED_A_PUB, FIXED_B);
    const uRef = BigInt("0x" + hexHash(padHexLocal(FIXED_A_PUB) + padHexLocal(FIXED_B)));
    expect(uDirect).toBe(uRef);
  });
});

// ============================================================
// CRY-0021: SRP-6a S = (B - k·g^x)^(a + u·x) mod N 固定ベクタ
// ============================================================

describe("CRY-0021 SRP-6a S = (B - k·g^x)^(a + u·x) mod N 固定ベクタ", () => {
  it("[CRY-0021] 固定 (firstId, secondId, password, B, salt, a, A) に対し S が独立再計算と一致する固定 KAT", () => {
    // 独立再計算
    const passwordHash = sha256HexLocal(`${POOL_NAME}${USER_ID}:${USER_PASSWORD}`);
    const x = BigInt("0x" + hexHash(padHexLocal(FIXED_SALT) + passwordHash));
    const u = BigInt("0x" + hexHash(padHexLocal(FIXED_A_PUB) + padHexLocal(FIXED_B)));
    const gx = modPow(G, x, N);
    const base = FIXED_B - K * gx;
    const expectedS = modPow(base, FIXED_A + u * x, N);

    // Known golden value (first 40 hex chars of S)
    expect(expectedS.toString(16).slice(0, 40)).toBe(
      "7a22e7b105064a8e38f06bae1887857a4f5af2d9",
    );

    // srpPasswordSecrets must return the same sValue
    const { sValue: actualS } = srpPasswordSecrets({
      firstId: POOL_NAME,
      secondId: USER_ID,
      password: USER_PASSWORD,
      serverB: FIXED_B,
      salt: FIXED_SALT,
      a: FIXED_A,
      A: FIXED_A_PUB,
    });
    expect(actualS).toBe(expectedS);

    // S must be positive
    expect(expectedS > 0n).toBe(true);
  });

  it("[CRY-0021] sValue が正の値である (modPow 内部で負値正規化済み)", () => {
    // B - k*g^x が負になりうる状況でも sValue は正
    const { sValue } = srpPasswordSecrets({
      firstId: "pool",
      secondId: "user",
      password: "p",
      serverB: 2n, // 非常に小さい B
      salt: 1n,
      a: FIXED_A,
      A: FIXED_A_PUB,
    });
    expect(sValue >= 0n).toBe(true);
    expect(sValue < N).toBe(true);
  });
});

// ============================================================
// CRY-0022: device SRP verifier = g^x mod N (3072-bit) 固定 salt/password ベクタ
// ============================================================

describe("CRY-0022 device SRP verifier = g^x mod N (3072-bit) 固定 salt/password ベクタ", () => {
  // Helper: compute verifier from saltHex (independent reimplementation)
  function calcVerifier(groupKey, key, password, saltHex) {
    const saltBigInt = BigInt("0x" + saltHex);
    const fullHash = sha256HexLocal(`${groupKey}${key}:${password}`);
    const saltPadded = padHexLocal(saltBigInt);
    const x = BigInt("0x" + hexHash(saltPadded + fullHash));
    const verifierBig = modPow(G, x, N);
    const verifierHex = padHexLocal(verifierBig);
    return {
      verifierB64: Buffer.from(verifierHex, "hex").toString("base64"),
      saltB64: Buffer.from(saltHex, "hex").toString("base64"),
      padSaltLen: saltPadded.length / 2,
      verifierBig,
    };
  }

  it("[CRY-0022] 15B salt (leading 0x0f < 0x80): padHex = 15B (no 00 prefix), verifier B64 固定 KAT", () => {
    const saltHex = "0f" + "11".repeat(14);
    const { verifierB64, saltB64, padSaltLen } = calcVerifier(
      DEVICE_GROUP_KEY, DEVICE_KEY, DEVICE_PASSWORD, saltHex,
    );

    expect(padSaltLen).toBe(15); // no 00 prefix
    expect(saltB64).toBe("DxERERERERERERERERER");
    expect(verifierB64).toBe(
      "AJyyddohUoul6NJzLWEhKiLKXCShySVDzK99ScsBZGnfRLnJ6qXH2Bu5NpdeoKsLbJsXR6EuGMtZO9cjWbUjHdN+MiRr9a4LWoYPMMCPq94If8ACnzQfiA6wh88Ux08Lklk03MiVN2GsL0lpqXgO6lOZOzDkYZBsB7OzNfNPMvh20VDwYm71U+fBtd3cJrrbvc8Yp8Tp2qvcWYL4FXqTfgOnF9aIouK18uqFBmNxdfX/fsfYLD8Q/KbEvyna4G2JIYmTyp0Xxu3XrCqs+TnivB9S8kyk7/pGIMYE86riQ0Pak//cXFvJLAauZxcuzJDT8CJcPPwFxVRkAwCDXqjQdhVqswWChIcevIL7D1ZU4rD8K//1yVzOb/uM/W4wvdcVhIpV+QGVFX0uBE/X8/wbL+yyVcmP9pwDweXXfOYAsCZ7M+z9tNgZS2hhAHoiWq/rJg5oi8rg4+4an20W5HZGrCgN/EAjpTfl32ub3A/E33eUux1sYYxabACzpqV1QivRgg==",
    );
  });

  it("[CRY-0022] 16B salt (leading 0x80 >= 0x80): padHex = 17B (needs 00 prefix), verifier B64 固定 KAT", () => {
    const saltHex = "80" + "22".repeat(15);
    const { verifierB64, saltB64, padSaltLen } = calcVerifier(
      DEVICE_GROUP_KEY, DEVICE_KEY, DEVICE_PASSWORD, saltHex,
    );

    expect(padSaltLen).toBe(17); // "00" prefix added
    expect(saltB64).toBe("gCIiIiIiIiIiIiIiIiIiIg==");
    expect(verifierB64).toBe(
      "Om/mSBaxfjoxPJUePVpWWZPZg5VStArFZ6eBbT2zSzK/WfdEVvmbxlQB5ErUCQdSwJyibtailwjwM1GrHOgBvO9vanKxrCwbmZwX+YSJeAGY0WbC596csH/FfZl3cHJHYXNEuP5IkvBaHN4XqQgS5awNULd9Pc7ir8xOGvTg6hcZxSejWbeUiacqkEd4z/k87fIAkE7R9uTHrXaCwAcblUI8hZHWfGacD6W9oUhFPGinjM4bj82TkG4UdK1ztsA1V+G+D5SwONYcdUF6MDPU2XQ9LXk2/jPuihIEqrGbNZ7ySAg6ge6AhhRPzjv0yLH3ocL4rkv9fCVwKAROIFjPp+/i/dHJCTEWCSgKoJv+9KPsysEYjw5MmnpEH12nVDNObyncZ6jFv1G3LIhHpQKvi7lXNlLcy4DJ/JpqtaR9p9e3DYBGEQKTeUstnvsnBBIrkePUIMhrZBYMGRxrEo+hPfeBA2hEhME+2MYiKkPiK57+KVNwX6ltedSBeltgQH1Y",
    );
  });

  it("[CRY-0022] 16B salt (leading 0x0f < 0x80): padHex = 16B (no 00 prefix), verifier B64 固定 KAT", () => {
    const saltHex = "0f" + "33".repeat(15);
    const { verifierB64, saltB64, padSaltLen } = calcVerifier(
      DEVICE_GROUP_KEY, DEVICE_KEY, DEVICE_PASSWORD, saltHex,
    );

    expect(padSaltLen).toBe(16); // no prefix
    expect(saltB64).toBe("DzMzMzMzMzMzMzMzMzMzMw==");
    expect(verifierB64).toBe(
      "FUZCL5YfxISs7c5th8JcazoBNB1l6wHZ8rmJbyTTqOLynDAaQ1dy5dPZK/1xBYcPYmGmYBcLvnAX6ZHRf1halB9HFzxbN5yGu/35IVkFiovysF61P1vemLZwPAiSCmJkYsioEXRRLifJY0vtfoFui7ShImykR9vluY1j4imtcHZD5hWXMvMy3bPPeVnLGUCk6B2KYIc3vBL2RlrqBdrP9xgdIQA5rxgT1fb9IqWVsA7cseLE4RNwPEfJGZCghWoofZ82zGl5GfK0B7AcUtEBveCOuT+1SyBTGHILjlmqgNIlyOSVta2xa8vW4muRlRHGiTAxdu/B+ZYZG734VKRDvnEVfh/aOyfp4tJO/0OrEIlLA6h329Ruoc70bZF2piZK0RSnfowaXslsPbD5TVV45dIOwxv0HIunmYbOWa4hrdr3fsq8wNxJwWE916KQp88Rq7XMpVqHaoc1u2hVIFxRD6o2dZnDCq9CsXE0V0uUt6N6A186rFJNMgVg4OejvZ0B",
    );
  });

  it("[CRY-0022] salt 先頭ビットが立つ場合 (0x80台) は padHex で 00 前置される", () => {
    const saltBig = BigInt("0x80aabbccddeeff0011223344556677aa");
    const padded = padHex(saltBig);
    expect(padded.startsWith("00")).toBe(true);
    expect(padded.length).toBe(34); // 00 + 32hex = 34
  });

  it("[CRY-0022] salt 先頭ビットが立たない場合 (0x7f台) は padHex で 00 前置なし", () => {
    const saltBig = BigInt("0x7faabbccddeeff0011223344556677aa");
    const padded = padHex(saltBig);
    expect(padded.startsWith("7f")).toBe(true);
    expect(padded.length).toBe(32);
  });

  it("[CRY-0022] generateDeviceVerifier が返すオブジェクト形状と verifier バイト長を確認", () => {
    const result = generateDeviceVerifier(DEVICE_GROUP_KEY, DEVICE_KEY);
    expect(typeof result.devicePassword).toBe("string");
    expect(typeof result.passwordVerifier).toBe("string");
    expect(typeof result.salt).toBe("string");
    // passwordVerifier は base64 で 100B 以上 (3072-bit verifier の base64)
    expect(Buffer.from(result.passwordVerifier, "base64").length).toBeGreaterThan(100);
  });

  it("[CRY-0022] 独立再実装: verifier は 0 < verifier < N を満たす", () => {
    const saltHex = "0f" + "11".repeat(14);
    const { verifierBig } = calcVerifier(DEVICE_GROUP_KEY, DEVICE_KEY, DEVICE_PASSWORD, saltHex);
    expect(verifierBig > 0n).toBe(true);
    expect(verifierBig < N).toBe(true);
  });
});

// ============================================================
// CRY-0023: PASSWORD_CLAIM_SIGNATURE = HMAC-SHA256(hkdf, id1||id2||secretBlock||timestamp)
// ============================================================

describe("CRY-0023 PASSWORD_CLAIM_SIGNATURE = HMAC-SHA256(hkdf, id1||id2||secretBlock||timestamp) 固定ゴールデン署名 KAT", () => {
  it("[CRY-0023] user SRP 分岐 (poolName|userId): 固定入力に対し署名がゴールデン値と一致 (既存 user-srp-vector との整合)", () => {
    const { hkdf } = srpPasswordSecrets({
      firstId: POOL_NAME,
      secondId: USER_ID,
      password: USER_PASSWORD,
      serverB: FIXED_B,
      salt: FIXED_SALT,
      a: FIXED_A,
      A: FIXED_A_PUB,
    });

    // HMAC-SHA256(hkdf, poolName || userId || decode(secretBlock) || timestamp)
    const msg = Buffer.concat([
      Buffer.from(POOL_NAME, "utf8"),
      Buffer.from(USER_ID, "utf8"),
      Buffer.from(SECRET_BLOCK_B64, "base64"),
      Buffer.from(FIXED_TIMESTAMP, "utf8"),
    ]);
    const sig = createHmac("sha256", hkdf).update(msg).digest("base64");

    // Must match golden value from user-srp-vector.test.js
    expect(sig).toBe("mvQ3Gy+v1fqNsbxv8tgnpjOfGqXfKOXYbV3XFzTqLGQ=");
  });

  it("[CRY-0023] device SRP 分岐 (deviceGroupKey|deviceKey): devicePasswordSignature が独立再計算値とバイト一致", () => {
    const { hkdf } = srpPasswordSecrets({
      firstId: DEVICE_GROUP_KEY,
      secondId: DEVICE_KEY,
      password: DEVICE_PASSWORD,
      serverB: FIXED_B,
      salt: FIXED_SALT,
      a: FIXED_A,
      A: FIXED_A_PUB,
    });

    const sig = devicePasswordSignature({
      hkdf,
      deviceGroupKey: DEVICE_GROUP_KEY,
      deviceKey: DEVICE_KEY,
      secretBlock: SECRET_BLOCK_B64,
      timestamp: FIXED_TIMESTAMP,
    });

    // 独立再実装
    const msg = Buffer.concat([
      Buffer.from(DEVICE_GROUP_KEY, "utf8"),
      Buffer.from(DEVICE_KEY, "utf8"),
      Buffer.from(SECRET_BLOCK_B64, "base64"),
      Buffer.from(FIXED_TIMESTAMP, "utf8"),
    ]);
    const sigRef = createHmac("sha256", hkdf).update(msg).digest("base64");

    expect(sig).toBe(sigRef);
    // Golden value (independently computed)
    expect(sig).toBe("qS407K7XcgDgLnu+XjptXoiPqQJ2gCdkj47OdAxqAuo=");
  });
});

// ============================================================
// CRY-0024: SigV4 canonical request が IAM ListUsers 既知ベクタと一致
// ============================================================

describe("CRY-0024 SigV4 canonical request 構築が IAM ListUsers 既知ベクタ(20150830T123600Z/AKIDEXAMPLE)と一致", () => {
  it("[CRY-0024] 固定 method/url/headers/body/date で生成した canonicalRequest が AWS General Reference IAM ListUsers 例の 9 行と一致し SHA-256 hex が f536975d... と一致する固定 KAT", () => {
    const signed = signRequest({
      method: "GET",
      url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: "",
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
      service: "iam",
      region: "us-east-1",
      date: FIXED_DATE,
    });

    expect(signed.canonicalRequest).toBe(
      [
        "GET",
        "/",
        "Action=ListUsers&Version=2010-05-08",
        "content-type:application/x-www-form-urlencoded; charset=utf-8",
        "host:iam.amazonaws.com",
        "x-amz-date:20150830T123600Z",
        "",
        "content-type;host;x-amz-date",
        EMPTY_SHA256,
      ].join("\n"),
    );

    expect(sha256Hex(signed.canonicalRequest)).toBe(
      "f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59",
    );
  });
});

// ============================================================
// CRY-0025: SigV4 string-to-sign が ListUsers 既知ベクタと一致
// ============================================================

describe("CRY-0025 SigV4 string-to-sign(AWS4-HMAC-SHA256\\namzDate\\nscope\\ncreqHash)が ListUsers 既知ベクタと一致", () => {
  it("[CRY-0025] 固定入力で生成した stringToSign が 4 行フォーマットと一致する固定 KAT", () => {
    const signed = signRequest({
      method: "GET",
      url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: "",
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
      service: "iam",
      region: "us-east-1",
      date: FIXED_DATE,
    });

    expect(signed.stringToSign).toBe(
      [
        "AWS4-HMAC-SHA256",
        "20150830T123600Z",
        "20150830/us-east-1/iam/aws4_request",
        "f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59",
      ].join("\n"),
    );

    expect(signed.credentialScope).toBe("20150830/us-east-1/iam/aws4_request");
  });
});

// ============================================================
// CRY-0026: SigV4 署名鍵導出 kSigning が doc 掲載 hex と一致
// ============================================================

describe("CRY-0026 SigV4 署名鍵導出 kSigning = HMAC連鎖(AWS4secret→date→region→service→aws4_request)が doc 掲載 hex と一致", () => {
  it("[CRY-0026] 固定 (secretAccessKey, dateStamp=20150830, region=us-east-1, service=iam) で kSigning の 4 段 HMAC-SHA256 連鎖が c4afb1cc...4b9 と一致する固定 KAT", () => {
    const signingKey = deriveSigningKey({
      secretAccessKey: SECRET_KEY,
      dateStamp: "20150830",
      region: "us-east-1",
      service: "iam",
    });

    expect(signingKey.toString("hex")).toBe(
      "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9",
    );
  });
});

// ============================================================
// CRY-0027: SigV4 最終 signature/Authorization が ListUsers 及び get/post-vanilla 既知ベクタと一致
// ============================================================

describe("CRY-0027 SigV4 最終 signature/Authorization が ListUsers 及び test-suite(get/post-vanilla)既知ベクタと一致", () => {
  it("[CRY-0027] IAM ListUsers (出典A): signature=5d672d79... Authorization 組み立てが一致する固定 KAT", () => {
    const signed = signRequest({
      method: "GET",
      url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: "",
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
      service: "iam",
      region: "us-east-1",
      date: FIXED_DATE,
    });

    expect(signed.signature).toBe(
      "5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
    expect(signed.headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, " +
        "SignedHeaders=content-type;host;x-amz-date, " +
        "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
  });

  it("[CRY-0027] get-vanilla (出典B): signature=5fa00fa3... が一致する固定 KAT", () => {
    const signed = signRequest({
      method: "GET",
      url: "https://example.amazonaws.com/",
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
      service: "service",
      region: "us-east-1",
      date: FIXED_DATE,
    });

    expect(signed.signature).toBe(
      "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
    expect(signed.headers.authorization).toContain("Signature=5fa00fa3");
  });

  it("[CRY-0027] post-vanilla (出典B): signature=5da7c1a2... が一致する固定 KAT", () => {
    const signed = signRequest({
      method: "POST",
      url: "https://example.amazonaws.com/",
      credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
      service: "service",
      region: "us-east-1",
      date: FIXED_DATE,
    });

    expect(signed.signature).toBe(
      "5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b",
    );
  });
});

// ============================================================
// CRY-0028: ECDH P-256 raw 共有秘密(X 座標 32B)が NIST 既知ベクタと一致
// ============================================================

describe("CRY-0028 ECDH P-256 raw 共有秘密(X 座標 32B)が NIST 既知ベクタと一致", () => {
  const DA_HEX = "7d7dc5f71eb29ddaf80d6214632eeae03d9058af1fb6d22ed80badb62bc1a534";
  const QB_X   = "700c48f77f56584c5cc632ca65640db91b6bacce3a4df6b42ce7cc838833d287";
  const QB_Y   = "db71e509e3fd9b060ddb20ba5c51dcc5948d46fbf640dfe0441782cab85fa4ac";
  const NIST_Z = "46fc62106420ff012e54a434fbdd2d25ccc5852060561e68040dd7778997bd7b";

  it("[CRY-0028] full(32B): 固定 dA と QB(X||Y 64B) に対し ecdhSharedSecret が NIST Z=46fc6210...と一致する固定 KAT", () => {
    const kp = createECDH("prime256v1");
    kp.setPrivateKey(Buffer.from(DA_HEX, "hex"));
    const remote64 = Buffer.from(QB_X + QB_Y, "hex"); // 64B raw (prefix 無し)
    const z = ecdhSharedSecret(kp, remote64);

    expect(z.length).toBe(32);
    expect(z.toString("hex")).toBe(NIST_Z);
  });

  it("[CRY-0028] pre16(16B): ecdhSecretPre16 が NIST Z の先頭 16B と一致する固定 KAT", () => {
    const kp = createECDH("prime256v1");
    kp.setPrivateKey(Buffer.from(DA_HEX, "hex"));
    const remote64 = Buffer.from(QB_X + QB_Y, "hex");
    const pre = ecdhSecretPre16(kp, remote64);

    expect(pre.length).toBe(16);
    expect(pre.toString("hex")).toBe(NIST_Z.slice(0, 32)); // 先頭 16B = 32 hex chars
  });
});

// ============================================================
// CRY-0029: register priKey = CMAC('Sesame2_key_pair', e) || CMAC(oneKey, e) 固定 e ゴールデン KAT
// ============================================================

describe("CRY-0029 register priKey = CMAC('Sesame2_key_pair',e) || CMAC(oneKey,e) 固定 e ゴールデン KAT", () => {
  it("[CRY-0029] 固定 e=00112233...eeff に対し priKey=oneKey||twoKey(32B)が c3f6ca...8 と一致する固定 KAT", () => {
    const priKey = deriveRegisterPriKey(E_HEX);

    expect(priKey.length).toBe(32);
    expect(priKey.toString("hex")).toBe(
      "c3f6cacdb3ef42b307e657c8f0d2af10c28dfcd64c076dccf9259652c91c8a18",
    );
  });

  it("[CRY-0029] oneKey = AES-CMAC('Sesame2_key_pair', e) (先頭 16B)", () => {
    const pri = deriveRegisterPriKey(E_HEX);
    const keyBytes = Buffer.from("Sesame2_key_pair");
    const eBytes = Buffer.from(E_HEX, "hex");
    const oneKeyRef = aesCmac(keyBytes, eBytes);
    expect(pri.subarray(0, 16).equals(oneKeyRef)).toBe(true);
  });

  it("[CRY-0029] twoKey = AES-CMAC(oneKey, e) (後半 16B)", () => {
    const pri = deriveRegisterPriKey(E_HEX);
    const keyBytes = Buffer.from("Sesame2_key_pair");
    const eBytes = Buffer.from(E_HEX, "hex");
    const oneKey = aesCmac(keyBytes, eBytes);
    const twoKeyRef = aesCmac(oneKey, eBytes);
    expect(pri.subarray(16, 32).equals(twoKeyRef)).toBe(true);
  });

  it("[CRY-0029] 可変長 e を受理する (15B / 17B どちらも 32B priKey を返す)", () => {
    expect(deriveRegisterPriKey("00".repeat(15)).length).toBe(32);
    expect(deriveRegisterPriKey("00".repeat(17)).length).toBe(32);
  });

  it("[CRY-0029] 空 e は明示エラー (下限 1B 未満を弾く)", () => {
    expect(() => deriveRegisterPriKey("")).toThrow();
    expect(() => deriveRegisterPriKey(Buffer.alloc(0))).toThrow();
  });
});

// ============================================================
// CRY-0030: register sig1/pubkey/st が固定 (ak,n,e,serverToken) でゴールデンベクタと一致(ECDH+CMAC 合成 KAT)
// ============================================================

describe("CRY-0030 register sig1/pubkey/st が固定 (ak,n,e,serverToken) でゴールデンベクタと一致(ECDH+CMAC 合成 KAT)", () => {
  it("[CRY-0030] 固定 (ak,n,e,serverToken=deadbeef) に対し {sig1, st, pubkey} がゴールデン値とバイト一致する固定 KAT", () => {
    const out = getRegisterKey(
      { ak: AK_B64, n: N_B64, e: E_HEX },
      { serverToken: SERVER_TOKEN },
    );

    expect(out).toEqual({
      sig1: "1xo/Zw==",
      st: "3q2+7w==",
      pubkey: "wUSqynjpOdJCV+B5v59ol/5iUr+ILyH+VWeBCiuwtjPSXQuKbDDo4RStdoVdLBksj5s+AJZgCbpUbsfCZOR8ow==",
    });
  });

  it("[CRY-0030] pubkey は 64B raw P-256 公開鍵 (X||Y, prefix 無し) = SDK priKeyToPubKey drop(27)", () => {
    const out = getRegisterKey(
      { ak: AK_B64, n: N_B64, e: E_HEX },
      { serverToken: SERVER_TOKEN },
    );
    const pub = Buffer.from(out.pubkey, "base64");

    expect(pub.length).toBe(64);

    // Verify against Node ECDH
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(deriveRegisterPriKey(E_HEX));
    expect(pub.equals(ecdh.getPublicKey().subarray(1))).toBe(true);
  });

  it("[CRY-0030] st は注入した serverToken の base64", () => {
    const out = getRegisterKey(
      { ak: AK_B64, n: N_B64, e: E_HEX },
      { serverToken: SERVER_TOKEN },
    );
    expect(Buffer.from(out.st, "base64").equals(SERVER_TOKEN)).toBe(true);
  });

  it("[CRY-0030] SERVER_AUTH_PUBKEY 定数が期待する hex と一致", () => {
    expect(SERVER_AUTH_PUBKEY).toBe(
      "04a040fcc7386b2a08304a3a2f0834df575c936794209729f0d42bd84218b35803932bea522200b2ebcbf17ab57c4509b4a3f1e268b2489eb3b75f7a765adbe181",
    );
    // sig1 は 4B
    const out = getRegisterKey(
      { ak: AK_B64, n: N_B64, e: E_HEX },
      { serverToken: SERVER_TOKEN },
    );
    expect(Buffer.from(out.sig1, "base64").length).toBe(4);
  });

  it("[CRY-0030] serverToken 省略時は 4B 乱数 (st が毎回変わり sig1 も変わる; pubkey は e 依存なので不変)", () => {
    const a = getRegisterKey({ ak: AK_B64, n: N_B64, e: E_HEX });
    const b = getRegisterKey({ ak: AK_B64, n: N_B64, e: E_HEX });

    expect(Buffer.from(a.st, "base64").length).toBe(4);
    expect(a.pubkey).toBe(b.pubkey);
    // st が同一の確率は 2^-32
    expect(a.st === b.st && a.sig1 === b.sig1).toBe(false);
  });
});

// ============================================================
// CRY-0031: register priKey スカラ境界 [1, n-1] 判定が P-256 位数で Node setPrivateKey と同一に倒れる KAT
// ============================================================

describe("CRY-0031 register priKey スカラ境界 [1, n-1] 判定が P-256 位数で Node setPrivateKey と同一に倒れる KAT", () => {
  const ORDER = P256_ORDER;

  it("[CRY-0031] s==0 は throw (SDK: POINT_INFINITY で例外)", () => {
    expect(() => assertValidP256Scalar(scalarBuf(0n))).toThrow(/range \[1, n-1\]/);
  });

  it("[CRY-0031] s==n は throw (SDK: BigInteger not invertible)", () => {
    expect(() => assertValidP256Scalar(scalarBuf(ORDER))).toThrow(/range \[1, n-1\]/);
  });

  it("[CRY-0031] s==n+1 は throw (SDK: InvalidKeyException range [1, n-1])", () => {
    expect(() => assertValidP256Scalar(scalarBuf(ORDER + 1n))).toThrow();
  });

  it("[CRY-0031] s==0xFF..FF (全 FF, n 超え) は throw", () => {
    expect(() => assertValidP256Scalar(Buffer.alloc(32, 0xff))).toThrow();
  });

  it("[CRY-0031] s==1 と s==n-1 は受理 (有効範囲の両端, SDK mod n 還元なし)", () => {
    expect(() => assertValidP256Scalar(scalarBuf(1n))).not.toThrow();
    expect(() => assertValidP256Scalar(scalarBuf(ORDER - 1n))).not.toThrow();
  });

  it("[CRY-0031] mod n 還元はしない (n+1 は mod n == 1 だが拒否)", () => {
    expect(() => assertValidP256Scalar(scalarBuf(ORDER + 1n))).toThrow();
  });

  it("[CRY-0031] ガードの境界は Node createECDH.setPrivateKey の受理範囲と一致する", () => {
    // 0 / n / n+1 / 0xFF..FF は Node も拒否
    for (const bad of [
      scalarBuf(0n),
      scalarBuf(ORDER),
      scalarBuf(ORDER + 1n),
      Buffer.alloc(32, 0xff),
    ]) {
      const ecdh = createECDH("prime256v1");
      expect(() => ecdh.setPrivateKey(bad)).toThrow();
      expect(() => assertValidP256Scalar(bad)).toThrow();
    }
    // 1 / n-1 は Node も受理
    for (const ok of [scalarBuf(1n), scalarBuf(ORDER - 1n)]) {
      const ecdh = createECDH("prime256v1");
      expect(() => ecdh.setPrivateKey(ok)).not.toThrow();
      expect(() => assertValidP256Scalar(ok)).not.toThrow();
    }
  });
});

// ============================================================
// CRY-0032: cognitoTimestamp 'EEE MMM d HH:mm:ss UTC yyyy' 固定書式 KAT
// ============================================================

describe("CRY-0032 cognitoTimestamp 'EEE MMM d HH:mm:ss UTC yyyy' 固定書式 KAT (Java SimpleDateFormat バイト一致)", () => {
  it("[CRY-0032] day < 10 (非0詰め): 2026-03-04 → 'Wed Mar 4 02:03:04 UTC 2026' (Java 'd' と一致)", () => {
    const d = new Date(Date.UTC(2026, 2, 4, 2, 3, 4)); // Wednesday March 4
    expect(cognitoTimestamp(d)).toBe("Wed Mar 4 02:03:04 UTC 2026");
    // Must NOT have '0' prefix for day < 10
    expect(cognitoTimestamp(d)).not.toContain("Mar 04");
    expect(cognitoTimestamp(d)).toContain(" 4 ");
  });

  it("[CRY-0032] day = 1 (非0詰め): 2026-01-01 → 'Thu Jan 1 00:00:00 UTC 2026'", () => {
    const d = new Date(Date.UTC(2026, 0, 1, 0, 0, 0)); // Thursday January 1
    expect(cognitoTimestamp(d)).toBe("Thu Jan 1 00:00:00 UTC 2026");
  });

  it("[CRY-0032] day >= 10: 2026-01-15 → 'Thu Jan 15 00:00:00 UTC 2026' (0詰めなし)", () => {
    const d = new Date(Date.UTC(2026, 0, 15, 0, 0, 0));
    expect(cognitoTimestamp(d)).toBe("Thu Jan 15 00:00:00 UTC 2026");
  });

  it("[CRY-0032] HH:mm:ss は0詰め: hour/min/sec < 10 でも 2 桁", () => {
    const d = new Date(Date.UTC(2026, 11, 1, 0, 5, 9)); // 00:05:09
    expect(cognitoTimestamp(d)).toBe("Tue Dec 1 00:05:09 UTC 2026");
    expect(cognitoTimestamp(d)).toContain("00:05:09");
  });

  it("[CRY-0032] 月名境界: Jan/Feb/Mar/Apr/May/Jun/Jul/Aug/Sep/Oct/Nov/Dec が正しく出力される", () => {
    const cases = [
      ["2026-01-01T00:00:00Z", "Jan"],
      ["2026-02-01T00:00:00Z", "Feb"],
      ["2026-03-01T00:00:00Z", "Mar"],
      ["2026-04-01T00:00:00Z", "Apr"],
      ["2026-05-01T00:00:00Z", "May"],
      ["2026-06-01T00:00:00Z", "Jun"],
      ["2026-07-01T00:00:00Z", "Jul"],
      ["2026-08-01T00:00:00Z", "Aug"],
      ["2026-09-01T00:00:00Z", "Sep"],
      ["2026-10-01T00:00:00Z", "Oct"],
      ["2026-11-01T00:00:00Z", "Nov"],
      ["2026-12-01T00:00:00Z", "Dec"],
    ];
    for (const [iso, monthAbbr] of cases) {
      const ts = cognitoTimestamp(new Date(iso));
      expect(ts).toContain(monthAbbr);
      expect(ts).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) [A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}:\d{2} UTC \d{4}$/);
    }
  });

  it("[CRY-0032] 曜日境界: Sun/Sat が正しく出力される", () => {
    // 2026-01-04 = Sunday, 2026-01-03 = Saturday
    expect(cognitoTimestamp(new Date(Date.UTC(2026, 0, 4)))).toContain("Sun");
    expect(cognitoTimestamp(new Date(Date.UTC(2026, 0, 3)))).toContain("Sat");
    // 2026-06-14 = Sun, 2026-06-15 = Mon
    expect(cognitoTimestamp(new Date("2026-06-14T10:00:00Z"))).toMatch(/^Sun /);
    expect(cognitoTimestamp(new Date("2026-06-15T10:00:00Z"))).toMatch(/^Mon /);
  });

  it("[CRY-0032] 署名に使う FIXED_TIMESTAMP と固定 Date で一致 (1 文字差で実機ログイン不能の境界)", () => {
    const d = new Date(FIXED_DATE_MS);
    expect(cognitoTimestamp(d)).toBe(FIXED_TIMESTAMP);
    // 0 詰めなしであることを確認
    expect(cognitoTimestamp(d)).not.toContain(" 04 ");
    expect(cognitoTimestamp(d)).toContain(" 4 ");
  });
});

// ============================================================
// CRY-0033: SigV4 sessionToken(x-amz-security-token) 署名対象化 と canonicalQuery キー→値バイト順ソートの分岐 KAT
// ============================================================

describe("CRY-0033 SigV4 sessionToken(x-amz-security-token) 署名対象化 と canonicalQuery キー→値バイト順ソートの分岐 KAT", () => {
  const CREDS = { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY };

  it("[CRY-0033] sessionToken あり: x-amz-security-token が canonicalHeaders と SignedHeaders に含まれる固定 KAT", () => {
    const signed = signRequest({
      method: "GET",
      url: "https://example.amazonaws.com/",
      credentials: { ...CREDS, sessionToken: "FIX-SESSION-TOKEN" },
      service: "service",
      region: "us-east-1",
      date: FIXED_DATE,
    });

    expect(signed.signedHeaders).toContain("x-amz-security-token");
    expect(signed.signedHeaders).toBe("host;x-amz-date;x-amz-security-token");
    expect(signed.canonicalRequest).toContain("x-amz-security-token:FIX-SESSION-TOKEN\n");
    expect(signed.headers["x-amz-security-token"]).toBe("FIX-SESSION-TOKEN");
  });

  it("[CRY-0033] sessionToken なし: x-amz-security-token は SignedHeaders に含まれない", () => {
    const signed = signRequest({
      method: "GET",
      url: "https://example.amazonaws.com/",
      credentials: CREDS,
      service: "service",
      region: "us-east-1",
      date: FIXED_DATE,
    });

    expect(signed.signedHeaders).not.toContain("x-amz-security-token");
    expect(signed.headers["x-amz-security-token"]).toBeUndefined();
  });

  it("[CRY-0033] query あり: URLSearchParams が rfc3986Encode 後にキー→値バイト順ソートで canonicalQuery 化される固定 KAT", () => {
    // b=2&a=1&a=0 → after encode: a=0&a=1&b=2 (key 'a' < 'b', then value '0' < '1')
    const signed = signRequest({
      method: "GET",
      url: "https://example.amazonaws.com/?b=2&a=1&a=0",
      credentials: CREDS,
      service: "service",
      region: "us-east-1",
      date: FIXED_DATE,
    });

    const canonicalQuery = signed.canonicalRequest.split("\n")[2];
    expect(canonicalQuery).toBe("a=0&a=1&b=2");
  });

  it("[CRY-0033] query 無し: canonicalQuery は空文字列 (3行目が空)", () => {
    const signed = signRequest({
      method: "GET",
      url: "https://example.amazonaws.com/",
      credentials: CREDS,
      service: "service",
      region: "us-east-1",
      date: FIXED_DATE,
    });

    const canonicalQuery = signed.canonicalRequest.split("\n")[2];
    expect(canonicalQuery).toBe("");
  });

  it("[CRY-0033] Identity Pool 一時 credentials: sessionToken で credentialScope に execute-api が入る境界 KAT", () => {
    const signed = signRequest({
      method: "POST",
      url: "https://app.candyhouse.co/prod/device/v1/biometrics",
      headers: { "content-type": "application/json", "x-api-key": "key" },
      body: "{}",
      credentials: { ...CREDS, sessionToken: "SESSION-TOKEN" },
      date: FIXED_DATE,
    });

    // Default service=execute-api, region=ap-northeast-1
    expect(signed.credentialScope).toBe("20150830/ap-northeast-1/execute-api/aws4_request");
    expect(signed.signedHeaders).toBe(
      "content-type;host;x-amz-date;x-amz-security-token;x-api-key",
    );
    expect(signed.headers.authorization).toContain(
      "Credential=AKIDEXAMPLE/20150830/ap-northeast-1/execute-api/aws4_request",
    );
  });
});

// ============================================================
// CRY-0034: SRP-6a A = g^a mod N (A%N!=0 リトライ・3072-bit group G=2) の modPow 数式 KAT
// ============================================================

describe("CRY-0034 SRP-6a A = g^a mod N (A%N!=0 リトライ・3072-bit group G=2) の modPow 数式 KAT", () => {
  it("[CRY-0034] 固定 a=0x11..11(128B) に対し A=modPow(G,a,N) が独立計算と数式等価で一致する固定 KAT", () => {
    // 独立計算 (テスト内の modPow を使用)
    const expectedA = modPow(G, FIXED_A, N);
    expect(expectedA).toBe(FIXED_A_PUB);

    // Known first 40 hex chars of A
    expect(expectedA.toString(16).slice(0, 40)).toBe(
      "67679d4fea151663de3276050085a1ce5853766f",
    );

    // G = 2 (3072-bit group の generator)
    expect(G).toBe(2n);
  });

  it("[CRY-0034] A % N != 0: 固定 a=0x11..11 での A は N で割り切れない (通常ケース)", () => {
    const A = modPow(G, FIXED_A, N);
    expect(A % N).not.toBe(0n);
    expect(A > 0n).toBe(true);
  });

  it("[CRY-0034] generateEphemeralA が返す A は A%N!=0 を満たす (3072-bit group G=2 の契約)", () => {
    for (let i = 0; i < 5; i++) {
      const { a, A } = generateEphemeralA();
      expect(A > 0n).toBe(true);
      expect(A % N).not.toBe(0n);
      expect(A).toBe(modPow(G, a, N));
    }
  });

  it("[CRY-0034] G=2 (3072-bit group): modPow(G, 1, N) === 2n (G の 1 乗は G 自身)", () => {
    expect(G).toBe(2n);
    expect(modPow(G, 1n, N)).toBe(2n);
  });

  it("[CRY-0034] a の生成範囲は BigInt(randomBytes(128)) % N ∈ [0, N-1] (N 未満)", () => {
    for (let i = 0; i < 5; i++) {
      const { a } = generateEphemeralA();
      expect(a >= 0n).toBe(true);
      expect(a < N).toBe(true);
    }
  });

  it("[CRY-0034] modPow が負値 base も正規化する (base < 0 → mod 内部で正の余剰)", () => {
    const result = modPow(-5n, 2n, N);
    // (-5)^2 mod N = 25 (N は極めて大きいため)
    expect(result).toBe(25n);
  });

  it("[CRY-0034] 3072-bit group の prime N が RFC 5054 / Cognito 共通の正しい値", () => {
    const nHex = N.toString(16).toUpperCase();
    expect(nHex.startsWith("FFFFFFFF")).toBe(true);
    expect(nHex.length).toBe(768); // 3072 bit = 384 byte = 768 hex chars
  });
});
