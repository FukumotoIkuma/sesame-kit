// device password verifier (Cognito ConfirmDevice 用) のユニットテスト。
//
// SRP verifier は salt とパスワードが毎回ランダムなので固定ベクタは取れない。代わりに
// 構造的不変条件を検証する:
//   - verifier = g^x mod N (3072-bit) なので base64 デコードで最大 384 bytes (+符号 pad)
//   - salt は 16 bytes 由来 (padHex で先頭 00 が付くと 17 bytes)
//   - 呼ぶたびに値が変わる (salt/password がランダム)
//   - verifier / salt が正しい base64 で再エンコード往復する
import { describe, expect, it, vi } from "vitest";
import { generateDeviceVerifier } from "../../src/device-srp.js";

// SRP は 3072-bit BigInt modPow で CPU 重い。並列ユニット最大同時実行下では隣ワーカーの
// modPow に CPU を奪われ、軽いテストでも稀に既定 5s を超える (実機観測)。計算は正しく
// 短時間で終わるので、starvation で偽陽性にならないようファイル単位で余裕を持たせる。
vi.setConfig({ testTimeout: 20000 });

const GROUP = "ap-northeast-1_abcdEFGH";
const DEVKEY = "ap-northeast-1_11111111-2222-3333-4444-555555555555";

describe("generateDeviceVerifier", () => {
  it("returns base64 fields with SRP-3072 sized verifier and 16-byte salt", () => {
    const v = generateDeviceVerifier(GROUP, DEVKEY);

    const verifier = Buffer.from(v.passwordVerifier, "base64");
    const salt = Buffer.from(v.salt, "base64");

    // g^x mod N は最大 384 bytes、padHex の符号回避で稀に 385 bytes。
    expect(verifier.length).toBeGreaterThanOrEqual(383);
    expect(verifier.length).toBeLessThanOrEqual(385);
    // 16-byte salt、padHex の符号回避で 17 bytes になり得る。
    expect(salt.length).toBeGreaterThanOrEqual(16);
    expect(salt.length).toBeLessThanOrEqual(17);

    // base64 往復が壊れていない。
    expect(verifier.toString("base64")).toBe(v.passwordVerifier);
    expect(salt.toString("base64")).toBe(v.salt);

    // device password は 40 bytes の base64 (≒ 56 文字)。
    expect(Buffer.from(v.devicePassword, "base64").length).toBe(40);
  });

  it("randomizes every call", () => {
    const a = generateDeviceVerifier(GROUP, DEVKEY);
    const b = generateDeviceVerifier(GROUP, DEVKEY);
    expect(a.passwordVerifier).not.toBe(b.passwordVerifier);
    expect(a.salt).not.toBe(b.salt);
    expect(a.devicePassword).not.toBe(b.devicePassword);
  });
});
