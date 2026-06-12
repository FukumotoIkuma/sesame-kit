// device password verifier (Cognito ConfirmDevice 用) のユニットテスト。
//
// SRP verifier は salt とパスワードが毎回ランダムなので固定ベクタは取れない。代わりに
// 構造的不変条件を検証する:
//   - verifier = g^x mod N (3072-bit) なので base64 デコードで最大 384 bytes (+符号 pad)
//   - salt は 16 bytes 由来 (padHex で先頭 00 が付くと 17 bytes、先頭 0x00 で 15 bytes 以下も正常)
//   - 呼ぶたびに値が変わる (salt/password がランダム)
//   - verifier / salt が正しい base64 で再エンコード往復する
//
// P2-9: salt 長アサート flaky 修正 (R2:AUTH-08)
//   - 旧: `salt.length >= 16` — 先頭バイトが 0x00 のとき BigInt がゼロパディングを落とし
//     saltHex が 30 文字以下 → 15 bytes 以下になり約 0.4%/実行で偽赤になっていた。
//   - 修正: vi.mock('node:crypto') で randomBytes を固定ベクタ化し、
//     「上位バイト 0x00 のケース(salt < 16 bytes)」と「上位バイト 0x80+ のケース(salt = 17 bytes)」
//     をそれぞれ決定的に検証。不確定な range アサートを除去して確率的 flaky を根絶する。
//   - 参照: _aws_sdk_ref/CognitoDeviceHelper.java:347 (SALT_LENGTH_BITS = 128)
//           _aws_sdk_ref/CognitoDeviceHelper.java:373 (new BigInteger(SALT_LENGTH_BITS, SECURE_RANDOM))
//           —— Java の BigInteger(bitLen, random) は符号なし。toByteArray() は 2's complement で
//           返すため上位ビット次第で長さが変わる。JS 側 padHex も同じ分布を再現。
import { describe, expect, it, vi } from "vitest";

// node:crypto を部分モック。randomBytes だけ vi.fn() に差し替えて固定ベクタ注入を可能にする。
// createHash / createHmac / その他は実物を素通し(SRP 数学・HMAC の正確性を維持するため)。
//
// デフォルト実装は real.randomBytes に委譲するため、mockReturnValueOnce を使わないテスト
// (structural invariants / randomizes every call) は実乱数で動く。
// fixed-vector テストは mockReturnValueOnce を 2 回(1回目=40B、2回目=16B)キューし、
// generateDeviceVerifier の 2 回の randomBytes 呼び出しで消費される。
// キューが空になったあとは次のテストへの影響はない(実実装に委譲するデフォルトに戻る)。
vi.mock("node:crypto", async (importOriginal) => {
  const real = /** @type {typeof import("node:crypto")} */ (await importOriginal());
  return {
    ...real,
    randomBytes: vi.fn(real.randomBytes),
  };
});

// vi.mock は hoisted されるため以降の import は mock 適用後になる。
import { randomBytes } from "node:crypto";
import { generateDeviceVerifier } from "../../src/device-srp.js";

// SRP は 3072-bit BigInt modPow で CPU 重い。並列ユニット最大同時実行下では隣ワーカーの
// modPow に CPU を奪われ、軽いテストでも稀に既定 5s を超える (実機観測)。計算は正しく
// 短時間で終わるので、starvation で偽陽性にならないようファイル単位で余裕を持たせる。
vi.setConfig({ testTimeout: 20000 });

const GROUP = "ap-northeast-1_abcdEFGH";
const DEVKEY = "ap-northeast-1_11111111-2222-3333-4444-555555555555";

describe("generateDeviceVerifier — structural invariants (real randomBytes)", () => {
  it("verifier is SRP-3072 sized and base64 round-trips", () => {
    // mockReturnValueOnce は使わないため vi.fn(real.randomBytes) のデフォルト実装に委譲。
    const v = generateDeviceVerifier(GROUP, DEVKEY);

    const verifier = Buffer.from(v.passwordVerifier, "base64");

    // g^x mod N は最大 384 bytes、padHex の符号回避で稀に 385 bytes。
    expect(verifier.length).toBeGreaterThanOrEqual(383);
    expect(verifier.length).toBeLessThanOrEqual(385);

    // base64 往復が壊れていない。
    expect(verifier.toString("base64")).toBe(v.passwordVerifier);
    expect(Buffer.from(v.salt, "base64").toString("base64")).toBe(v.salt);

    // device password は 40 bytes の base64 (≒ 56 文字)。
    expect(Buffer.from(v.devicePassword, "base64").length).toBe(40);
  });

  it("randomizes every call", () => {
    // 2 回とも実乱数で動くため結果が異なることを確認。
    const a = generateDeviceVerifier(GROUP, DEVKEY);
    const b = generateDeviceVerifier(GROUP, DEVKEY);
    expect(a.passwordVerifier).not.toBe(b.passwordVerifier);
    expect(a.salt).not.toBe(b.salt);
    expect(a.devicePassword).not.toBe(b.devicePassword);
  });
});

// ---------------------------------------------------------------------------
// P2-9 固定ベクタテスト: salt の先頭バイトが 0x00 または 0x80+ のケースを決定的に検証。
//
// generateDeviceVerifier の randomBytes 呼び出し順序 (generateDeviceVerifier 関数を参照):
//   1回目: randomBytes(40) → devicePassword 原料
//   2回目: randomBytes(16) → salt 原料
//
// padHex の挙動 (device-srp.js の padHex 関数):
//   - BigInt は先頭の 0x00 を落とす → salt バイト列が 16 bytes を下回ることがある (正常)
//   - 先頭ビットが立つ場合は "00" を前置 → 17 bytes になることがある (正常)
//
// 参照: _aws_sdk_ref/CognitoDeviceHelper.java:347 (SALT_LENGTH_BITS = 128)
//       _aws_sdk_ref/CognitoDeviceHelper.java:373 (new BigInteger(SALT_LENGTH_BITS, SECURE_RANDOM))
//       Java BigInteger(128, SECURE_RANDOM).toByteArray() は 2's complement のため
//       上位ビット次第で長さが変わる。JS 側 padHex も同じ分布を再現。
// ---------------------------------------------------------------------------

// 固定 devicePassword 原料 (40 bytes、任意の定数値)。
const FIXED_PASSWORD_BYTES = Buffer.alloc(40, 0x42);

describe("generateDeviceVerifier — fixed-vector salt edge cases (P2-9)", () => {
  it("upper byte 0x00: salt is shorter than 16 bytes and base64 round-trips", () => {
    // ケースA: salt の先頭バイト = 0x00
    //   randomBytes(16) → [0x00, 0x01, ..., 0x0f]
    //   BigInt("0x000102030405060708090a0b0c0d0e0f") → 先頭ゼロが消え 15-byte 相当の値
    //   padHex → "0102030405060708090a0b0c0d0e0f" (30 文字、偶数、先頭'0' は高ビット無し)
    //   → 15 bytes の base64 → 旧アサート `>=16` で偽赤になっていた経路
    // 参照: _aws_sdk_ref/CognitoDeviceHelper.java:373 (BigInteger が同じく 0 プレフィックスを落とす)
    const saltBytesA = Buffer.from([
      0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
      0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
    ]);
    vi.mocked(randomBytes)
      .mockReturnValueOnce(FIXED_PASSWORD_BYTES)  // 1回目(40B): devicePassword 原料
      .mockReturnValueOnce(saltBytesA);            // 2回目(16B): salt 原料、先頭 0x00

    const v = generateDeviceVerifier(GROUP, DEVKEY);
    const salt = Buffer.from(v.salt, "base64");

    // 先頭 0x00 が BigInt に渡ると剥落するため saltHex は 30 文字 → 15 bytes。
    expect(salt.length).toBe(15);
    // base64 往復の整合性。
    expect(salt.toString("base64")).toBe(v.salt);
    // devicePassword は常に 40 bytes。
    expect(Buffer.from(v.devicePassword, "base64").length).toBe(40);
  });

  it("upper byte 0x80: padHex adds 0x00 prefix, salt is 17 bytes and base64 round-trips", () => {
    // ケースB: salt の先頭バイト = 0x80 (高ビットが立つ)
    //   randomBytes(16) → [0x80, 0x01, ..., 0x0f]
    //   BigInt("0x800102030405060708090a0b0c0d0e0f") → 16-byte 値、先頭ビット立つ
    //   padHex → "00800102030405060708090a0b0c0d0e0f" (34 文字) → 17 bytes の base64。
    // 参照: _aws_sdk_ref/CognitoDeviceHelper.java:373 (BigInteger.toByteArray() の符号バイト相当)
    const saltBytesB = Buffer.from([
      0x80, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
      0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
    ]);
    vi.mocked(randomBytes)
      .mockReturnValueOnce(FIXED_PASSWORD_BYTES)  // 1回目(40B): devicePassword 原料
      .mockReturnValueOnce(saltBytesB);            // 2回目(16B): salt 原料、先頭 0x80

    const v = generateDeviceVerifier(GROUP, DEVKEY);
    const salt = Buffer.from(v.salt, "base64");

    // 先頭ビットが立つため padHex が "00" を前置 → saltHex は 34 文字 → 17 bytes。
    expect(salt.length).toBe(17);
    // base64 往復の整合性。
    expect(salt.toString("base64")).toBe(v.salt);
    // devicePassword は常に 40 bytes。
    expect(Buffer.from(v.devicePassword, "base64").length).toBe(40);
  });
});
