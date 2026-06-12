// tests/crypto/ecdh.test.js
//
// src/crypto.js の ECDH 共有鍵導出 (BLE デバイス登録 / 初期ペアリング) を検証する:
//   ecdhSharedSecret(keyPair, remotePubKey64) → 32B 生 ECDH 出力 (P-256 共有点の X 座標)
//   ecdhSecretPre16(keyPair, remotePubKey64)  → 上記の先頭 16B
//
// 原典 (CANDY-HOUSE SesameSDK):
//   EccKey.kt:27-33 — remote(64B raw) に X509 fixheader (末尾 04 = uncompressed prefix)
//     を前置し KeyAgreement("ECDH").generateSecret()。Node では 04+64B を computeSecret に
//     渡すのと等価。
//   CHHub3Device.kt:197 — ecdh().sliceArray(0..15) = 先頭 16B。
//
// テスト方針:
//   - 2 鍵ペアで A.ecdh(B.pub) == B.ecdh(A.pub) (ECDH の対称性)
//   - 出力長 32B / pre16 が 16B / pre16 が共有秘密の先頭一致
//   - 既知 NIST P-256 ECDH ベクタで生 X 座標が一致 (KDF を挟まない raw ECDH の確証)
//   - remote pubkey の受理形態 (64B Buffer / 128hex / 04 prefix 付き 65B)
//   - 入力バリデーション

import { describe, it, expect } from "vitest";
import { createECDH } from "node:crypto";
import { ecdhSharedSecret, ecdhSecretPre16 } from "../../src/crypto.js";

// 呼び出し側が用意する keyPair 相当 (P-256 = prime256v1)。
function newKeyPair() {
  const k = createECDH("prime256v1");
  k.generateKeys();
  return k;
}

// keyPair の公開鍵を SDK の remote 形式 (64B raw = X‖Y, prefix 無し) で取り出す。
// Node の getPublicKey() は既定で uncompressed (0x04 ‖ X ‖ Y, 65B)。
function rawPub64(keyPair) {
  const uncompressed = keyPair.getPublicKey(); // 65B
  expect(uncompressed.length).toBe(65);
  expect(uncompressed[0]).toBe(0x04);
  return uncompressed.subarray(1); // 64B
}

describe("ecdhSharedSecret / ecdhSecretPre16", () => {
  describe("ECDH 対称性", () => {
    it("A.ecdh(B.pub) == B.ecdh(A.pub)", () => {
      const a = newKeyPair();
      const b = newKeyPair();
      const sAB = ecdhSharedSecret(a, rawPub64(b));
      const sBA = ecdhSharedSecret(b, rawPub64(a));
      expect(sAB.equals(sBA)).toBe(true);
    });

    it("複数ペアでも常に対称 (10 試行)", () => {
      for (let i = 0; i < 10; i++) {
        const a = newKeyPair();
        const b = newKeyPair();
        expect(ecdhSharedSecret(a, rawPub64(b)).equals(ecdhSharedSecret(b, rawPub64(a)))).toBe(true);
      }
    });

    it("異なる相手鍵だと共有秘密が異なる", () => {
      const a = newKeyPair();
      const b = newKeyPair();
      const c = newKeyPair();
      const sAB = ecdhSharedSecret(a, rawPub64(b));
      const sAC = ecdhSharedSecret(a, rawPub64(c));
      expect(sAB.equals(sAC)).toBe(false);
    });
  });

  describe("出力フォーマット", () => {
    it("共有秘密は 32B (P-256 X 座標)", () => {
      const a = newKeyPair();
      const b = newKeyPair();
      const s = ecdhSharedSecret(a, rawPub64(b));
      expect(Buffer.isBuffer(s)).toBe(true);
      expect(s.length).toBe(32);
    });

    it("pre16 は 16B", () => {
      const a = newKeyPair();
      const b = newKeyPair();
      const pre = ecdhSecretPre16(a, rawPub64(b));
      expect(Buffer.isBuffer(pre)).toBe(true);
      expect(pre.length).toBe(16);
    });

    it("pre16 は共有秘密の先頭 16B と一致 (sliceArray(0..15))", () => {
      const a = newKeyPair();
      const b = newKeyPair();
      const remote = rawPub64(b);
      const full = ecdhSharedSecret(a, remote);
      const pre = ecdhSecretPre16(a, remote);
      expect(pre.equals(full.subarray(0, 16))).toBe(true);
    });

    // 原典 Kotlin sliceArray(0..15) は copy。pre16 は full(32B) の subarray view では
    // なく独立コピーを返し、共有秘密の backing ArrayBuffer を共有してはならない。
    // (view だと pre.buffer 経由で捨てたはずの後半 16B が露出しうる)。
    it("pre16 は full と backing を共有しない独立コピー (copy セマンティクス)", () => {
      const a = newKeyPair();
      const b = newKeyPair();
      const remote = rawPub64(b);
      const full = ecdhSharedSecret(a, remote);
      const pre = ecdhSecretPre16(a, remote);
      // backing が full と別なら、full の後半 16B が pre.buffer に同居しない。
      expect(pre.buffer).not.toBe(full.buffer);
    });

    // copy であることの直接確認: full をゼロ化しても pre は不変。
    // (view ならゼロ化が伝播して落ちる)。
    it("pre16 は full の後続変更に影響されない (view ではない)", () => {
      const a = newKeyPair();
      const b = newKeyPair();
      const remote = rawPub64(b);
      const full = ecdhSharedSecret(a, remote);
      const pre = ecdhSecretPre16(a, remote);
      const snapshot = Buffer.from(pre);
      full.fill(0);
      expect(pre.equals(snapshot)).toBe(true);
    });
  });

  describe("既知 NIST P-256 ECDH ベクタ (生 X 座標一致)", () => {
    // NIST CAVP / RFC ECDH P-256 既知ベクタ:
    //   dA  (private) = 7d7dc5f7...
    //   QB  (peer pub)= (700c48f7..., db71e509...)
    //   Z   (shared X)= 46fc6210...
    // raw ECDH (KDF なし) なら共有秘密 = 共有点 X 座標 = Z に一致する。
    const dA = "7d7dc5f71eb29ddaf80d6214632eeae03d9058af1fb6d22ed80badb62bc1a534";
    const QBx = "700c48f77f56584c5cc632ca65640db91b6bacce3a4df6b42ce7cc838833d287";
    const QBy = "db71e509e3fd9b060ddb20ba5c51dcc5948d46fbf640dfe0441782cab85fa4ac";
    const expectedZ = "46fc62106420ff012e54a434fbdd2d25ccc5852060561e68040dd7778997bd7b";

    it("ecdhSharedSecret の生出力が NIST 期待 Z と一致", () => {
      const kp = createECDH("prime256v1");
      kp.setPrivateKey(Buffer.from(dA, "hex"));
      const remote64 = Buffer.from(QBx + QBy, "hex"); // 64B raw (prefix 無し)
      const z = ecdhSharedSecret(kp, remote64);
      expect(z.toString("hex")).toBe(expectedZ);
    });

    it("pre16 が NIST 期待 Z の先頭 16B と一致", () => {
      const kp = createECDH("prime256v1");
      kp.setPrivateKey(Buffer.from(dA, "hex"));
      const remote64 = Buffer.from(QBx + QBy, "hex");
      const pre = ecdhSecretPre16(kp, remote64);
      expect(pre.toString("hex")).toBe(expectedZ.slice(0, 32));
    });
  });

  describe("remote 公開鍵の受理形態", () => {
    it("64B raw Buffer (SDK の remote 形式) を受理", () => {
      const a = newKeyPair();
      const b = newKeyPair();
      const remote = rawPub64(b);
      expect(remote.length).toBe(64);
      expect(() => ecdhSharedSecret(a, remote)).not.toThrow();
    });

    it("128hex 文字列でも 64B Buffer と同一結果", () => {
      const a = newKeyPair();
      const b = newKeyPair();
      const remote = rawPub64(b);
      const viaBuf = ecdhSharedSecret(a, remote);
      const viaHex = ecdhSharedSecret(a, remote.toString("hex"));
      expect(viaHex.equals(viaBuf)).toBe(true);
    });

    // 65B (0x04 prefix 付き) 受理は SDK 形式 (= 64B raw) ではなく、本ラッパ独自の
    // 寛容受理 (利便機能)。SDK 契約の正規形は 64B raw である点に注意。
    it("既に 0x04 prefix 付き (65B uncompressed) でも同一結果 (ラッパの寛容受理, SDK 形式ではない)", () => {
      const a = newKeyPair();
      const b = newKeyPair();
      const raw64 = rawPub64(b);
      const uncompressed65 = Buffer.concat([Buffer.from([0x04]), raw64]);
      const viaRaw = ecdhSharedSecret(a, raw64);
      const via65 = ecdhSharedSecret(a, uncompressed65);
      expect(via65.equals(viaRaw)).toBe(true);
    });

    it("keyPair を {ecdh} ラッパで渡しても動く", () => {
      const a = newKeyPair();
      const b = newKeyPair();
      const remote = rawPub64(b);
      const direct = ecdhSharedSecret(a, remote);
      const wrapped = ecdhSharedSecret({ ecdh: a }, remote);
      expect(wrapped.equals(direct)).toBe(true);
    });
  });

  describe("入力バリデーション", () => {
    it("keyPair が未指定なら throw", () => {
      const b = newKeyPair();
      expect(() => ecdhSharedSecret(null, rawPub64(b))).toThrow(/keyPair required/);
    });

    it("computeSecret を持たない keyPair は throw", () => {
      const b = newKeyPair();
      expect(() => ecdhSharedSecret({}, rawPub64(b))).toThrow(/computeSecret/);
    });

    it("63B など長さ不正の remote は throw", () => {
      const a = newKeyPair();
      expect(() => ecdhSharedSecret(a, Buffer.alloc(63))).toThrow(/64B raw public key/);
    });

    it("奇数長 hex の remote は throw", () => {
      const a = newKeyPair();
      expect(() => ecdhSharedSecret(a, "abc")).toThrow(/even-length hex/);
    });

    it("非 hex 文字列の remote は throw", () => {
      const a = newKeyPair();
      expect(() => ecdhSharedSecret(a, "zz".repeat(64))).toThrow(/even-length hex/);
    });

    it("Buffer/string 以外の remote は throw", () => {
      const a = newKeyPair();
      expect(() => ecdhSharedSecret(a, 12345)).toThrow(/Buffer or hex string/);
    });
  });
});
