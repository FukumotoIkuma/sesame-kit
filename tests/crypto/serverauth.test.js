// tests/crypto/serverauth.test.js
//
// src/crypto.js のサーバ認証 (初期ペアリング sig1 生成 / reg-server-ecdh-auth) を検証する:
//   deriveRegisterPriKey(e)        → e から決定的に導出した 32B P-256 priKey
//   getRegisterKey({ak,n,e}, opts) → {sig1, st, pubkey} (すべて base64)
//
// 原典 (CANDY-HOUSE SesameSDK):
//   co/candyhouse/sesame/ble/os2/CHServerAuth.kt:41-65 — getRegisterKey()
//     priKey = CMAC("Sesame2_key_pair", e) ‖ CMAC(CMAC("Sesame2_key_pair", e), e)
//     pubKey = priKey の P-256 公開鍵 (SDK priKeyToPubKey は SPKI 91B の drop(27) =
//              **64B, X‖Y, prefix 無し**。CHServerAuth.kt:138。27B = ヘッダ 26B + 0x04 の 1B)
//     secret = ECDH(priKey, serverKey)[0..15]
//     serverToken = 4B 乱数; sessionToken = serverToken ‖ b64decode(n)
//     msg = b64decode(ak) ‖ sessionToken; sig1 = CMAC(secret, msg)[0..3]
//   CHServerAuth.kt:28-29 — serverKey (固定 65B 公開鍵)
//
// ★検証範囲の限界 (重要): 本テストは src/crypto.js の **内部整合性** のみを確認する。
//   refRegisterKey() は CHServerAuth.kt の「主張アルゴリズム」を生プリミティブで再実装した
//   ものなので、getRegisterKey と一致しても確認できるのは「実装が主張どおり動く」ことだけで、
//   その主張アルゴリズム自体が実機 SDK のバイト列 (token16/sig1) と一致するかは **未照合**。
//   原典 .kt はリポジトリに存在しない。移植忠実性の確定には実機キャプチャ or 別出所の
//   ゴールデンベクタが必要 (src/crypto.js の server-auth ブロック冒頭 TODO 参照)。
//   さらに原典 CHServerAuth.kt は OS2 実装であり、供給先 OS3 register との世代差も未照合
//   (照合は OS2 でなく OS3 実機キャプチャで行うこと)。e/ak/n の期待長 (16B) も UNVERIFIED。
//
// テスト方針:
//   - 固定 e で priKey が 32B かつ既知の決定値であること (oneKey‖twoKey 連結の回帰固定)
//   - 固定 (ak,n,e,serverToken) 注入で sig1/st/pubkey がゴールデンベクタと一致 (回帰固定)
//   - sig1/pubkey を本テスト内で **生プリミティブから独立再計算** し getRegisterKey と一致
//     (= 内部整合の確認。SDK バイト列との一致は別途要 E2E 検証、上記限界を参照)
//   - pubkey が 64B raw point (X ‖ Y, prefix 無し) であること (SDK drop(27) = 91-27 = 64B と一致)
//   - serverToken 省略時は 4B 乱数 (毎回変わり sig1/st も変わる)
//   - 入力バリデーション

import { describe, it, expect } from "vitest";
import { createECDH } from "node:crypto";
// AES-CMAC は内製実装 (src/aes-cmac.js, RFC 4493)。旧 node-aes-cmac は P5-2 で除去。
import { aesCmac } from "../../src/aes-cmac.js";
import { Buffer } from "node:buffer";
import {
  deriveRegisterPriKey,
  getRegisterKey,
  SERVER_AUTH_PUBKEY,
  assertValidP256Scalar,
  P256_ORDER,
} from "../../src/crypto.js";

// 32B big-endian Buffer をスカラ値から生成 (P-256 priKey 表現)。
function scalarBuf(v) {
  return Buffer.from(v.toString(16).padStart(64, "0"), "hex");
}

// ---- 固定ゴールデンベクタ (実装非依存に再計算可能な決定入力) ----
const E_HEX = "00112233445566778899aabbccddeeff";
const AK_B64 = Buffer.from("0102030405060708090a0b0c0d0e0f10", "hex").toString("base64");
const N_B64 = Buffer.from("aabbccddeeff00112233445566778899", "hex").toString("base64");
const SERVER_TOKEN = Buffer.from("deadbeef", "hex");

// CHServerAuth.kt と同一手順を生プリミティブで再現する独立リファレンス実装。
function cmac(key, msg) {
  const m = aesCmac(key, msg);
  return Buffer.isBuffer(m) ? m : Buffer.from(m, "hex");
}
function refPriKey(eHex) {
  const k = Buffer.from("Sesame2_key_pair");
  const e = Buffer.from(eHex, "hex");
  const one = cmac(k, e);
  const two = cmac(one, e);
  return Buffer.concat([one, two]);
}
function refRegisterKey(ak, n, eHex, serverToken) {
  const priKey = refPriKey(eHex);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(priKey);
  // SDK priKeyToPubKey = SPKI 91B の drop(27) = 64B (X‖Y, prefix 無し)。CHServerAuth.kt:138。
  // Node getPublicKey() は 04 prefix 付き 65B なので subarray(1) が等価。
  const pubKey = ecdh.getPublicKey().subarray(1); // 64B X‖Y
  const secret = ecdh.computeSecret(Buffer.from(SERVER_AUTH_PUBKEY, "hex")).subarray(0, 16);
  const sessionToken = Buffer.concat([serverToken, Buffer.from(n, "base64")]);
  const msg = Buffer.concat([Buffer.from(ak, "base64"), sessionToken]);
  const sig1 = cmac(secret, msg).subarray(0, 4);
  return {
    sig1: Buffer.from(sig1).toString("base64"),
    st: serverToken.toString("base64"),
    pubkey: pubKey.toString("base64"),
  };
}

describe("deriveRegisterPriKey (CHServerAuth.kt:43-50)", () => {
  it("固定 e で priKey が 32B かつ決定値", () => {
    const pri = deriveRegisterPriKey(E_HEX);
    expect(pri.length).toBe(32);
    // CMAC("Sesame2_key_pair", e) ‖ CMAC(oneKey, e) の連結。生プリミティブと一致。
    expect(pri.toString("hex")).toBe(
      "c3f6cacdb3ef42b307e657c8f0d2af10c28dfcd64c076dccf9259652c91c8a18",
    );
  });

  it("oneKey は CMAC('Sesame2_key_pair', e) の先頭 16B、twoKey は CMAC(oneKey, e)", () => {
    const pri = deriveRegisterPriKey(E_HEX);
    const ref = refPriKey(E_HEX);
    expect(pri.equals(ref)).toBe(true);
    expect(pri.subarray(0, 16).equals(ref.subarray(0, 16))).toBe(true); // oneKey
    expect(pri.subarray(16, 32).equals(ref.subarray(16, 32))).toBe(true); // twoKey
  });

  it("Buffer 入力でも hex 文字列と同一", () => {
    expect(deriveRegisterPriKey(Buffer.from(E_HEX, "hex")).equals(deriveRegisterPriKey(E_HEX))).toBe(true);
  });

  it("不正な e を弾く", () => {
    expect(() => deriveRegisterPriKey("zz")).toThrow();
    expect(() => deriveRegisterPriKey("abc")).toThrow(); // odd length
    expect(() => deriveRegisterPriKey(123)).toThrow();
  });

  it("e は可変長を受理する (ER = IRER payload.drop(16) は固定長でない。CHSesame2Device.kt:418)", () => {
    // 旧実装は 16B 固定を要求したが、一次資料照合で e は可変長と判明。15B/17B でも CMAC で導出でき、
    // 結果は 32B priKey になる (長さ非依存)。
    expect(deriveRegisterPriKey("00".repeat(15)).length).toBe(32);
    expect(deriveRegisterPriKey("00".repeat(17)).length).toBe(32);
    expect(deriveRegisterPriKey(Buffer.alloc(15)).length).toBe(32);
    expect(deriveRegisterPriKey(Buffer.alloc(17)).length).toBe(32);
  });

  it("空の e は明示エラー (下限のみ課す)", () => {
    // "" は hex regex (+ = 1 文字以上) で弾かれ、空 Buffer は下限 (>= 1 byte) で弾かれる。
    expect(() => deriveRegisterPriKey("")).toThrow(/hex|byte/);
    expect(() => deriveRegisterPriKey(Buffer.alloc(0))).toThrow(/>= 1 byte|byte/);
  });
});

describe("getRegisterKey (CHServerAuth.kt:41-65)", () => {
  it("固定 (ak,n,e,serverToken) でゴールデンベクタと一致", () => {
    const out = getRegisterKey({ ak: AK_B64, n: N_B64, e: E_HEX }, { serverToken: SERVER_TOKEN });
    expect(out).toEqual({
      sig1: "1xo/Zw==",
      st: "3q2+7w==",
      // 64B (X‖Y, prefix 無し) の base64。SDK priKeyToPubKey の drop(27) = 91-27 = 64B
      // (CHServerAuth.kt:138)。sig1/st は pubkey 形式に依存しないので旧 golden から不変。
      pubkey: "wUSqynjpOdJCV+B5v59ol/5iUr+ILyH+VWeBCiuwtjPSXQuKbDDo4RStdoVdLBksj5s+AJZgCbpUbsfCZOR8ow==",
    });
  });

  it("生プリミティブからの独立再計算 (SDK 手順) と一致", () => {
    const out = getRegisterKey({ ak: AK_B64, n: N_B64, e: E_HEX }, { serverToken: SERVER_TOKEN });
    const ref = refRegisterKey(AK_B64, N_B64, E_HEX, SERVER_TOKEN);
    expect(out).toEqual(ref);
  });

  it("pubkey は 64B raw point (X ‖ Y, prefix 無し) = SDK drop(27) (CHServerAuth.kt:138)", () => {
    const out = getRegisterKey({ ak: AK_B64, n: N_B64, e: E_HEX }, { serverToken: SERVER_TOKEN });
    const pub = Buffer.from(out.pubkey, "base64");
    // SPKI 91B − drop(27) = 64B。27B には uncompressed prefix 0x04 が含まれる
    // (EccKey.kt fixheader "3059…03420004" と同じ区切り) ため 04 は **含まれない**。
    expect(pub.length).toBe(64);
    // 同じ priKey から Node が返す 65B の subarray(1) と一致 (= X‖Y そのもの)。
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(refPriKey(E_HEX));
    expect(pub.equals(ecdh.getPublicKey().subarray(1))).toBe(true);
  });

  it("st は注入した serverToken の base64", () => {
    const out = getRegisterKey({ ak: AK_B64, n: N_B64, e: E_HEX }, { serverToken: SERVER_TOKEN });
    expect(Buffer.from(out.st, "base64").equals(SERVER_TOKEN)).toBe(true);
  });

  it("sig1 は secret=ECDH(priKey, serverKey)[0..15] による CMAC(msg)[0..3]", () => {
    // SERVER_AUTH_PUBKEY 定数が CHServerAuth.serverKey と一致していること。
    expect(SERVER_AUTH_PUBKEY).toBe(
      "04a040fcc7386b2a08304a3a2f0834df575c936794209729f0d42bd84218b35803932bea522200b2ebcbf17ab57c4509b4a3f1e268b2489eb3b75f7a765adbe181",
    );
    const out = getRegisterKey({ ak: AK_B64, n: N_B64, e: E_HEX }, { serverToken: SERVER_TOKEN });
    expect(Buffer.from(out.sig1, "base64").length).toBe(4);
  });

  it("serverToken 省略時は 4B 乱数 (st が毎回変わり sig1 も変わる)", () => {
    const a = getRegisterKey({ ak: AK_B64, n: N_B64, e: E_HEX });
    const b = getRegisterKey({ ak: AK_B64, n: N_B64, e: E_HEX });
    expect(Buffer.from(a.st, "base64").length).toBe(4);
    // 乱数 4B が衝突する確率は 2^-32。pubkey は e のみ依存なので不変。
    expect(a.pubkey).toBe(b.pubkey);
    expect(a.st === b.st && a.sig1 === b.sig1).toBe(false);
  });

  it("注入 serverToken が同じなら結果は決定的に再現", () => {
    const a = getRegisterKey({ ak: AK_B64, n: N_B64, e: E_HEX }, { serverToken: SERVER_TOKEN });
    const b = getRegisterKey({ ak: AK_B64, n: N_B64, e: E_HEX }, { serverToken: SERVER_TOKEN });
    expect(a).toEqual(b);
  });

  it("入力バリデーション", () => {
    expect(() => getRegisterKey(null)).toThrow();
    expect(() => getRegisterKey({ n: N_B64, e: E_HEX })).toThrow(); // ak 欠落
    expect(() => getRegisterKey({ ak: AK_B64, e: E_HEX })).toThrow(); // n 欠落
    expect(() => getRegisterKey({ ak: AK_B64, n: N_B64 })).toThrow(); // e 欠落
    // 不正長 serverToken
    expect(() =>
      getRegisterKey({ ak: AK_B64, n: N_B64, e: E_HEX }, { serverToken: Buffer.alloc(3) }),
    ).toThrow();
  });

  it("ak/n は可変長を受理する (実 wire は ak=64B app公開鍵 / n=4B token。CHSesame2Device.kt:424-428)", () => {
    // 旧実装は ak/n を 16B 固定で要求したが、一次資料照合で固定長でないと判明。15B/17B でも計算でき、
    // sig1 は 4B / st は 4B / pubkey は e のみ依存で不変 (ak/n は CMAC msg に入るだけ)。
    const ak15 = Buffer.alloc(15, 0x11).toString("base64");
    const n17 = Buffer.alloc(17, 0x22).toString("base64");
    const out = getRegisterKey({ ak: ak15, n: n17, e: E_HEX }, { serverToken: SERVER_TOKEN });
    expect(Buffer.from(out.sig1, "base64").length).toBe(4);
    expect(Buffer.from(out.st, "base64").length).toBe(4);
    // 実 wire 長 (ak=64B / n=4B) でも問題なく計算できる。
    const ak64 = Buffer.alloc(64, 0x33).toString("base64");
    const n4 = Buffer.alloc(4, 0x44).toString("base64");
    const out2 = getRegisterKey({ ak: ak64, n: n4, e: E_HEX }, { serverToken: SERVER_TOKEN });
    expect(Buffer.from(out2.sig1, "base64").length).toBe(4);
  });

  it("空 ak / 空 n は明示エラー (下限のみ課す)", () => {
    const empty = Buffer.alloc(0).toString("base64");
    expect(() =>
      getRegisterKey({ ak: empty, n: N_B64, e: E_HEX }, { serverToken: SERVER_TOKEN }),
    ).toThrow(/ak must decode to >= 1/);
    expect(() =>
      getRegisterKey({ ak: AK_B64, n: empty, e: E_HEX }, { serverToken: SERVER_TOKEN }),
    ).toThrow(/n must decode to >= 1/);
  });
});

// priKey スカラの境界 [1, n-1]。
//
// deriveRegisterPriKey は e から CMAC で 32B の「実質ランダムな」スカラを作るため、
// ~2^-32 の確率で scalar==0 / scalar>=n になり setPrivateKey が不透明な例外を投げる。
// 原典 SDK (CHServerAuth.priKeyToPubKey の JCA 経路) を実機 JDK で再現すると、同じ境界で
// 例外に倒れる (s==0: POINT_INFINITY / s==n: not invertible / s>n: range [1,n-1]) ことを実測で確認した。
// SDK は mod n 還元を **しない** ので、本実装も還元せず「範囲外なら明示エラー」に揃える。
// (還元を入れると SDK と異なる鍵を生む退行になるため行わない。)
describe("assertValidP256Scalar — priKey スカラ境界 (SDK JCA と同一の [1, n-1])", () => {
  const N = P256_ORDER;

  it("scalar==0 は拒否 (SDK: POINT_INFINITY で例外)", () => {
    expect(() => assertValidP256Scalar(scalarBuf(0n))).toThrow(/range \[1, n-1\]/);
  });

  it("scalar==n は拒否 (SDK: BigInteger not invertible)", () => {
    expect(() => assertValidP256Scalar(scalarBuf(N))).toThrow(/range \[1, n-1\]/);
  });

  it("scalar==n+1 は拒否 (SDK: InvalidKeyException range [1, n-1])", () => {
    expect(() => assertValidP256Scalar(scalarBuf(N + 1n))).toThrow();
  });

  it("scalar==0xFF..FF (全 FF, n 超え) は拒否", () => {
    expect(() => assertValidP256Scalar(Buffer.alloc(32, 0xff))).toThrow();
  });

  it("scalar==1 と scalar==n-1 は受理 (有効範囲の両端)", () => {
    expect(() => assertValidP256Scalar(scalarBuf(1n))).not.toThrow();
    expect(() => assertValidP256Scalar(scalarBuf(N - 1n))).not.toThrow();
  });

  it("通常 e 由来の priKey は範囲内で受理される", () => {
    expect(() => assertValidP256Scalar(deriveRegisterPriKey(E_HEX))).not.toThrow();
  });

  it("ガードの境界は Node setPrivateKey の受理範囲と一致する", () => {
    // 0 / n / n+1 / 0xFF..FF は setPrivateKey も throw、n-1 / 1 は受理。
    // ガードが OpenSSL の不透明エラーに依存せず同じ境界を先に弾くことを保証する。
    for (const bad of [scalarBuf(0n), scalarBuf(N), scalarBuf(N + 1n), Buffer.alloc(32, 0xff)]) {
      const ecdh = createECDH("prime256v1");
      expect(() => ecdh.setPrivateKey(bad)).toThrow(); // Node も拒否
      expect(() => assertValidP256Scalar(bad)).toThrow(); // ガードも拒否
    }
    for (const ok of [scalarBuf(1n), scalarBuf(N - 1n)]) {
      const ecdh = createECDH("prime256v1");
      expect(() => ecdh.setPrivateKey(ok)).not.toThrow(); // Node 受理
      expect(() => assertValidP256Scalar(ok)).not.toThrow(); // ガードも受理
    }
  });
});
