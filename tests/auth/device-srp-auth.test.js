// DEVICE_SRP_AUTH のクライアント実装 (src/device-srp.js) を、Cognito サーバ役を
// シミュレートして検証する。ライブ API に依存せず SRP-6a の整合を保証する。
//
// SRP-6a の不変条件:
//   client S = (B - k·g^x)^(a + u·x) mod N
//   server S = (A · v^u)^b        mod N      (v = g^x)
// この 2 つは一致する。一致すれば HKDF も署名も検証を通る (どちらも S の決定的関数)。
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import {
  generateDeviceVerifier,
  generateEphemeralA,
  deviceAuthSecrets,
  devicePasswordSignature,
  cognitoTimestamp,
  __srpTest,
} from "../../src/device-srp.js";

const { N, G, K, modPow, calculateU } = __srpTest;

const GROUP = "ap-northeast-1_grpABC";
const DEVKEY = "ap-northeast-1_11111111-2222-3333-4444-555555555555";

/** Cognito サーバが DEVICE_PASSWORD_VERIFIER で行う計算を再現する。 */
function serverSide({ verifier, A }) {
  const b = (BigInt("0x" + randomBytes(128).toString("hex")) % N) || 1n;
  const B = (K * verifier + modPow(G, b, N)) % N;
  const u = calculateU(A, B);
  // S = (A · v^u)^b mod N
  const S = modPow((A * modPow(verifier, u, N)) % N, b, N);
  return { B, S };
}

describe("device SRP (server simulation)", () => {
  it("client sValue equals the server's S (SRP exchange agrees)", () => {
    const v = generateDeviceVerifier(GROUP, DEVKEY);
    const verifier = BigInt("0x" + Buffer.from(v.passwordVerifier, "base64").toString("hex"));
    const salt = BigInt("0x" + Buffer.from(v.salt, "base64").toString("hex"));

    const { a, A } = generateEphemeralA();
    const { B, S: serverS } = serverSide({ verifier, A });

    const { sValue } = deviceAuthSecrets({
      deviceGroupKey: GROUP, deviceKey: DEVKEY, devicePassword: v.devicePassword,
      serverB: B, salt, a, A,
    });

    expect(sValue).toBe(serverS);
  });

  it("holds across many random rounds (a, b, salt, password all vary)", () => {
    // 3072-bit modPow は 1 ラウンド ~90ms と重い。並列スイート下で testTimeout を
    // 超えないよう回数は控えめに (ランダム性の網羅にはこれで十分)。
    for (let i = 0; i < 5; i++) {
      const v = generateDeviceVerifier(GROUP, `${DEVKEY}-${i}`);
      const verifier = BigInt("0x" + Buffer.from(v.passwordVerifier, "base64").toString("hex"));
      const salt = BigInt("0x" + Buffer.from(v.salt, "base64").toString("hex"));
      const { a, A } = generateEphemeralA();
      const { B, S: serverS } = serverSide({ verifier, A });
      const { sValue } = deviceAuthSecrets({
        deviceGroupKey: GROUP, deviceKey: `${DEVKEY}-${i}`, devicePassword: v.devicePassword,
        serverB: B, salt, a, A,
      });
      expect(sValue).toBe(serverS);
    }
  });

  it("a wrong device password does NOT agree with the server", () => {
    const v = generateDeviceVerifier(GROUP, DEVKEY);
    const verifier = BigInt("0x" + Buffer.from(v.passwordVerifier, "base64").toString("hex"));
    const salt = BigInt("0x" + Buffer.from(v.salt, "base64").toString("hex"));
    const { a, A } = generateEphemeralA();
    const { B, S: serverS } = serverSide({ verifier, A });
    const { sValue } = deviceAuthSecrets({
      deviceGroupKey: GROUP, deviceKey: DEVKEY, devicePassword: "wrong-password",
      serverB: B, salt, a, A,
    });
    expect(sValue).not.toBe(serverS);
  });

  it("generateEphemeralA: A = g^a mod N, non-zero, a < N", () => {
    const { a, A } = generateEphemeralA();
    expect(a < N).toBe(true);
    expect(A % N).not.toBe(0n);
    expect(modPow(G, a, N)).toBe(A);
  });

  it("devicePasswordSignature is deterministic base64 for the same inputs", () => {
    const hkdf = randomBytes(16);
    const args = { hkdf, deviceGroupKey: GROUP, deviceKey: DEVKEY, secretBlock: Buffer.from("blob").toString("base64"), timestamp: "Tue Mar 4 02:03:04 UTC 2026" };
    const a = devicePasswordSignature(args);
    const b = devicePasswordSignature(args);
    expect(a).toBe(b);
    expect(Buffer.from(a, "base64").length).toBe(32); // HMAC-SHA256
  });

  it("cognitoTimestamp matches Cognito's fixed format (day not zero-padded, UTC)", () => {
    // 2026-03-04T02:03:04Z = Wed
    const ts = cognitoTimestamp(new Date(Date.UTC(2026, 2, 4, 2, 3, 4)));
    expect(ts).toBe("Wed Mar 4 02:03:04 UTC 2026");
  });
});
