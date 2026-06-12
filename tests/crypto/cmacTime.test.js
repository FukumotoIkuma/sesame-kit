// tests/crypto/cmacTime.test.js
//
// src/crypto.js の cmacTime(hexKey) を単体検証する。
// cmacTime は内部で:
//   ts = floor(Date.now()/1000) → 4B LE → 上位 3B (index 1-3)
//   AES-CMAC(key, msg=3B) → hex → 先頭 8 文字
// を返す。
//
// テスト方針:
//   - 入力バリデーション (key length / type)
//   - 戻り値フォーマット (8 文字 hex)
//   - useFakeTimers で時刻固定し、同時刻 → 同値 / 時刻変化 → 値変化
//   - 256s 粒度: writeUInt32LE 後 subarray(1,4) は上位 3B = floor(ts/256) 相当
//     (LE で index 0 が最下位 byte なので index 1-3 が「上位 3B」= ts>>8)
//   - RFC 4493 Test Vector 2 を aesCmac 直叩きで検証 (ライブラリ健全性)
//   - aesCmac で独立計算した期待 MAC と cmacTime 出力が一致

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
// AES-CMAC は内製実装 (src/aes-cmac.js, RFC 4493)。旧 node-aes-cmac は P5-2 で除去。
import { aesCmac } from "../../src/aes-cmac.js";
import { cmacTime } from "../../src/crypto.js";

// RFC 4493 §4 Test Vector 共通鍵
const RFC_KEY_HEX = "2b7e151628aed2a6abf7158809cf4f3c";

function computeExpectedFromTs(hexKey, ts) {
  const key = Buffer.from(hexKey, "hex");
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(ts, 0);
  const msg = buf.subarray(1, 4);
  const mac = aesCmac(key, msg);
  const macBuf = Buffer.isBuffer(mac) ? mac : Buffer.from(mac, "hex");
  return macBuf.toString("hex").slice(0, 8);
}

describe("cmacTime(hexKey)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ---------- 入力バリデーション ----------

  describe("入力バリデーション", () => {
    it("32 文字未満の hex 文字列は throw する", () => {
      expect(() => cmacTime("2b7e151628aed2a6abf7158809cf4f3")).toThrow(
        /secretKey must be a 32-char hex string/,
      );
    });

    it("32 文字超の hex 文字列は throw する", () => {
      expect(() => cmacTime("2b7e151628aed2a6abf7158809cf4f3cAA")).toThrow(
        /secretKey must be a 32-char hex string/,
      );
    });

    it("空文字列は throw する", () => {
      expect(() => cmacTime("")).toThrow(/secretKey must be a 32-char hex string/);
    });

    it("undefined は throw する", () => {
      expect(() => cmacTime(undefined)).toThrow(/secretKey must be a 32-char hex string/);
    });

    it("null は throw する", () => {
      expect(() => cmacTime(null)).toThrow(/secretKey must be a 32-char hex string/);
    });

    it("Buffer (非 string) は throw する", () => {
      expect(() => cmacTime(Buffer.from(RFC_KEY_HEX, "hex"))).toThrow(
        /secretKey must be a 32-char hex string/,
      );
    });

    it("number は throw する", () => {
      expect(() => cmacTime(12345)).toThrow(/secretKey must be a 32-char hex string/);
    });

    it("エラーメッセージに長さが含まれる (len=31)", () => {
      const short = "2b7e151628aed2a6abf7158809cf4f3"; // 31 chars
      expect(() => cmacTime(short)).toThrow(/length 31/);
    });
  });

  // ---------- 戻り値フォーマット ----------

  describe("戻り値フォーマット", () => {
    it("戻り値は 8 文字の hex string", () => {
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
      const sig = cmacTime(RFC_KEY_HEX);
      expect(typeof sig).toBe("string");
      expect(sig).toHaveLength(8);
      expect(sig).toMatch(/^[0-9a-f]{8}$/);
    });

    it("異なる時刻でも常に 8 文字 hex を返す", () => {
      const samples = [0, 1, 256, 65535, 1_700_000_000, 4_000_000_000];
      for (const ts of samples) {
        vi.setSystemTime(new Date(ts * 1000));
        const sig = cmacTime(RFC_KEY_HEX);
        expect(sig).toMatch(/^[0-9a-f]{8}$/);
      }
    });
  });

  // ---------- 時刻依存性 ----------

  describe("時刻依存性 (fake timers)", () => {
    it("同じ時刻なら何度呼んでも同じ署名 (決定的)", () => {
      vi.setSystemTime(new Date("2024-06-01T12:34:56Z"));
      const a = cmacTime(RFC_KEY_HEX);
      const b = cmacTime(RFC_KEY_HEX);
      const c = cmacTime(RFC_KEY_HEX);
      expect(a).toBe(b);
      expect(b).toBe(c);
    });

    it("255 秒進めても 256s 粒度なので同じ署名 (上位 3B 不変)", () => {
      // floor(ts/256) が変わらないように、256 の倍数 + 0 から +255 まで進める
      const base = Math.floor(new Date("2024-06-01T12:34:56Z").getTime() / 1000);
      // base 自身は floor(base/256) のスタート時刻。256 境界に揃える。
      const aligned = Math.floor(base / 256) * 256;
      vi.setSystemTime(new Date(aligned * 1000));
      const sigStart = cmacTime(RFC_KEY_HEX);

      vi.advanceTimersByTime(255 * 1000);
      const sig255 = cmacTime(RFC_KEY_HEX);

      expect(sig255).toBe(sigStart);
    });

    it("256 秒進めると署名が変わる (上位 3B が変化)", () => {
      const base = Math.floor(new Date("2024-06-01T12:34:56Z").getTime() / 1000);
      const aligned = Math.floor(base / 256) * 256;
      vi.setSystemTime(new Date(aligned * 1000));
      const sigStart = cmacTime(RFC_KEY_HEX);

      vi.advanceTimersByTime(256 * 1000);
      const sig256 = cmacTime(RFC_KEY_HEX);

      expect(sig256).not.toBe(sigStart);
    });

    it("1 秒だけ進めても 256s 粒度のため (boundary またがない限り) 同じ", () => {
      const aligned = Math.floor(Date.now() / 1000);
      // 256 境界に揃えて余裕を持って 1 秒進める
      const alignedBase = Math.floor(aligned / 256) * 256 + 10; // boundary から余裕
      vi.setSystemTime(new Date(alignedBase * 1000));
      const sigA = cmacTime(RFC_KEY_HEX);

      vi.advanceTimersByTime(1000);
      const sigB = cmacTime(RFC_KEY_HEX);
      expect(sigB).toBe(sigA);
    });

    it("大きく時刻を変えると署名が変わる (1 時間進める)", () => {
      vi.setSystemTime(new Date("2024-06-01T12:00:00Z"));
      const sigA = cmacTime(RFC_KEY_HEX);

      vi.advanceTimersByTime(3600 * 1000);
      const sigB = cmacTime(RFC_KEY_HEX);
      expect(sigB).not.toBe(sigA);
    });
  });

  // ---------- 異なる鍵 ----------

  describe("鍵依存性", () => {
    it("同じ時刻でも鍵が違えば署名が違う (高確率)", () => {
      vi.setSystemTime(new Date("2024-06-01T12:34:56Z"));
      const sigA = cmacTime("00000000000000000000000000000000");
      const sigB = cmacTime("ffffffffffffffffffffffffffffffff");
      const sigC = cmacTime(RFC_KEY_HEX);
      // 32bit 出力で衝突する確率は 2^-32 なので実質ありえない
      expect(sigA).not.toBe(sigB);
      expect(sigA).not.toBe(sigC);
      expect(sigB).not.toBe(sigC);
    });

    it("大文字 hex も小文字 hex も受け付ける (Buffer.from('hex') は両方 OK)", () => {
      vi.setSystemTime(new Date("2024-06-01T12:34:56Z"));
      const lower = cmacTime(RFC_KEY_HEX);
      const upper = cmacTime(RFC_KEY_HEX.toUpperCase());
      expect(upper).toBe(lower);
    });
  });

  // ---------- AES-CMAC 期待値との一致 ----------

  describe("AES-CMAC 期待値検証", () => {
    it("aesCmac で独立計算した期待値と一致する (ts=1_700_000_000)", () => {
      const ts = 1_700_000_000;
      vi.setSystemTime(new Date(ts * 1000));
      const actual = cmacTime(RFC_KEY_HEX);
      const expected = computeExpectedFromTs(RFC_KEY_HEX, ts);
      expect(actual).toBe(expected);
    });

    it("aesCmac 期待値と一致 (ts=0 = epoch)", () => {
      vi.setSystemTime(new Date(0));
      const actual = cmacTime(RFC_KEY_HEX);
      const expected = computeExpectedFromTs(RFC_KEY_HEX, 0);
      expect(actual).toBe(expected);
    });

    it("aesCmac 期待値と一致 (異なる鍵)", () => {
      const ts = 1_234_567_890;
      vi.setSystemTime(new Date(ts * 1000));
      const key = "0123456789abcdef0123456789abcdef";
      const actual = cmacTime(key);
      const expected = computeExpectedFromTs(key, ts);
      expect(actual).toBe(expected);
    });

    it("RFC 4493 Test Vector 2 を aesCmac 単体で検証 (ライブラリ健全性)", () => {
      // RFC 4493 §4 Vector 2:
      //   K   = 2b7e151628aed2a6abf7158809cf4f3c
      //   M   = 6bc1bee2 2e409f96 e93d7e11 7393172a  (16B)
      //   MAC = 070a16b4 6b4d4144 f79bdd9d d04a287c
      const key = Buffer.from(RFC_KEY_HEX, "hex");
      const msg = Buffer.from("6bc1bee22e409f96e93d7e117393172a", "hex");
      const mac = aesCmac(key, msg);
      const macHex = Buffer.isBuffer(mac)
        ? mac.toString("hex")
        : Buffer.from(mac, "hex").toString("hex");
      expect(macHex.toLowerCase()).toBe("070a16b46b4d4144f79bdd9dd04a287c");
    });
  });
});
