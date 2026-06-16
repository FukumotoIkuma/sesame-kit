// cry-c0.test.js — CRY-0001 〜 CRY-0018 統合 TDD spec テスト
//
// 方針:
//   - 各 spec につき 1 個以上の it を書き、タイトル先頭に [<ID>] を置く。
//   - assert は spec どおりの期待値を検証 (実装の現状に合わせて歪めない)。
//   - ネットワーク/実機に触れない。全て純関数か fake timers で決定的に動く。
//   - ファイル自己完結 (先頭 import、describe でまとめ、各 it 独立)。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Buffer } from "node:buffer";
import { createHash, createHmac } from "node:crypto";

import { aesCmac } from "../../src/aes-cmac.js";
import {
  cmacTime,
  hexToBuf,
  bufToHex,
  uuidToHistoryBase64,
  normalizeUuid,
  hexToUuid,
  isUuidV4,
  generateUUID,
  formatPasscodeID,
  IR_TYPE,
  parseIrType,
} from "../../src/crypto.js";
import { srpPasswordSecrets, __srpTest } from "../../src/device-srp.js";

// ─────────────────────────────────────────────
// 共通フィクスチャ
// ─────────────────────────────────────────────

// RFC 4493 §4 共通 AES 鍵
const RFC_KEY = Buffer.from("2b7e151628aed2a6abf7158809cf4f3c", "hex");
const RFC_KEY_HEX = "2b7e151628aed2a6abf7158809cf4f3c";

// RFC 4493 §4 メッセージ M (64B 全量)
const M64 = Buffer.from(
  "6bc1bee22e409f96e93d7e117393172a" +
    "ae2d8a571e03ac9c9eb76fac45af8e51" +
    "30c81c46a35ce411e5fbc1191a0a52ef" +
    "f69f2445df4f9b17ad2b417be66c3710",
  "hex",
);

// ─────────────────────────────────────────────
// CRY-0001: aesCmac RFC 4493 §4 全既知応答ベクタ
// ─────────────────────────────────────────────

describe("CRY-0001 aesCmac RFC 4493 §4 全既知応答ベクタ (K1/K2 経路網羅)", () => {
  it("[CRY-0001] Example1: len=0 (空メッセージ, K2 パディング経路) → bb1d6929e95937287fa37d129b756746", () => {
    expect(aesCmac(RFC_KEY, Buffer.alloc(0)).toString("hex")).toBe(
      "bb1d6929e95937287fa37d129b756746",
    );
  });

  it("[CRY-0001] Example2: len=16 (完全 1 ブロック, K1 経路) → 070a16b46b4d4144f79bdd9dd04a287c", () => {
    expect(aesCmac(RFC_KEY, M64.subarray(0, 16)).toString("hex")).toBe(
      "070a16b46b4d4144f79bdd9dd04a287c",
    );
  });

  it("[CRY-0001] Example3: len=40 (不完全最終ブロック, K2 パディング経路) → dfa66747de9ae63030ca32611497c827", () => {
    expect(aesCmac(RFC_KEY, M64.subarray(0, 40)).toString("hex")).toBe(
      "dfa66747de9ae63030ca32611497c827",
    );
  });

  it("[CRY-0001] Example4: len=64 (完全 4 ブロック, K1 経路) → 51f0bebf7e3b9d92fc49741779363cfe", () => {
    expect(aesCmac(RFC_KEY, M64).toString("hex")).toBe(
      "51f0bebf7e3b9d92fc49741779363cfe",
    );
  });

  it("[CRY-0001] biz3 との等価性は先頭 4B (8hex) に限定: biz3 Cmac.js:139 は先頭 8hex のみ返す", () => {
    expect(aesCmac(RFC_KEY, Buffer.alloc(0)).toString("hex").slice(0, 8)).toBe("bb1d6929");
    expect(aesCmac(RFC_KEY, M64.subarray(0, 16)).toString("hex").slice(0, 8)).toBe("070a16b4");
    expect(aesCmac(RFC_KEY, M64.subarray(0, 40)).toString("hex").slice(0, 8)).toBe("dfa66747");
    expect(aesCmac(RFC_KEY, M64).toString("hex").slice(0, 8)).toBe("51f0bebf");
  });
});

// ─────────────────────────────────────────────
// CRY-0002: aesCmac 戻り値型・入力非破壊・Uint8Array 受理
// ─────────────────────────────────────────────

describe("CRY-0002 aesCmac 戻り値型・Uint8Array 受理・入力非破壊", () => {
  it("[CRY-0002] 戻り値は常に 16B Buffer (node-aes-cmac の hex/Buffer 揺れを排除)", () => {
    const mac = aesCmac(RFC_KEY, M64.subarray(0, 16));
    expect(Buffer.isBuffer(mac)).toBe(true);
    expect(mac.length).toBe(16);
  });

  it("[CRY-0002] Uint8Array 鍵・メッセージでも Buffer と同一 MAC (070a16b4…) を返す", () => {
    const mac = aesCmac(
      new Uint8Array(RFC_KEY),
      new Uint8Array(M64.subarray(0, 16)),
    );
    expect(Buffer.isBuffer(mac)).toBe(true);
    expect(mac.toString("hex")).toBe("070a16b46b4d4144f79bdd9dd04a287c");
  });

  it("[CRY-0002] 入力メッセージは in-place XOR 破壊されない", () => {
    const msg = Buffer.from(M64.subarray(0, 16));
    const snapshot = Buffer.from(msg);
    aesCmac(RFC_KEY, msg);
    expect(msg.equals(snapshot)).toBe(true);
  });
});

// ─────────────────────────────────────────────
// CRY-0003: aesCmac 鍵長/非バイト列メッセージの明示エラー
// ─────────────────────────────────────────────

describe("CRY-0003 aesCmac 鍵長エラー・非バイト列メッセージエラー", () => {
  it("[CRY-0003] 鍵 15B は /16-byte/ で throw する", () => {
    expect(() => aesCmac(Buffer.alloc(15), Buffer.alloc(0))).toThrow(/16-byte/);
  });

  it("[CRY-0003] 鍵 17B は /16-byte/ で throw する", () => {
    expect(() => aesCmac(Buffer.alloc(17), Buffer.alloc(0))).toThrow(/16-byte/);
  });

  it("[CRY-0003] 鍵が文字列のとき /16-byte/ で throw する (黙って誤 MAC を返さない)", () => {
    // @ts-expect-error 意図的型違反
    expect(() => aesCmac("2b7e151628aed2a6abf7158809cf4f3c", Buffer.alloc(0))).toThrow(/16-byte/);
  });

  it("[CRY-0003] message が文字列のとき /Buffer/ で throw する", () => {
    // @ts-expect-error 意図的型違反
    expect(() => aesCmac(RFC_KEY, "6bc1bee2")).toThrow(/Buffer/);
  });
});

// ─────────────────────────────────────────────
// CRY-0004: cmacTime 時刻パッキング既知ベクタ
// ─────────────────────────────────────────────

describe("CRY-0004 cmacTime 時刻パッキング既知ベクタ (4B LE → 上位 3B → CMAC[0..7])", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  // aesCmac 独立計算ヘルパ
  function computeExpected(hexKey, ts) {
    const key = Buffer.from(hexKey, "hex");
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(ts, 0);
    return aesCmac(key, buf.subarray(1, 4)).toString("hex").slice(0, 8);
  }

  it("[CRY-0004] ts=1700000000, RFC 鍵 → b40bcb3c (aesCmac 独立計算と一致)", () => {
    vi.setSystemTime(new Date(1700000000 * 1000));
    expect(cmacTime(RFC_KEY_HEX)).toBe("b40bcb3c");
    expect(computeExpected(RFC_KEY_HEX, 1700000000)).toBe("b40bcb3c");
  });

  it("[CRY-0004] ts=0 (epoch), RFC 鍵 → 71d22718 (独立計算と一致)", () => {
    vi.setSystemTime(new Date(0));
    expect(cmacTime(RFC_KEY_HEX)).toBe("71d22718");
    expect(computeExpected(RFC_KEY_HEX, 0)).toBe("71d22718");
  });

  it("[CRY-0004] key=0123…cdef, ts=1234567890 → a0c0ba15 (独立計算と一致)", () => {
    const key2 = "0123456789abcdef0123456789abcdef";
    vi.setSystemTime(new Date(1234567890 * 1000));
    expect(cmacTime(key2)).toBe("a0c0ba15");
    expect(computeExpected(key2, 1234567890)).toBe("a0c0ba15");
  });

  it("[CRY-0004] 手順検証: writeUInt32LE → subarray(1,4) → aesCmac → slice(0,8) (biz3 Cmac.cmacTime と同一)", () => {
    const ts = 1700000000;
    vi.setSystemTime(new Date(ts * 1000));
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(ts, 0);
    expect(buf.toString("hex")).toBe("00f15365"); // LE 確認
    const msg = buf.subarray(1, 4);
    expect(msg.toString("hex")).toBe("f15365"); // 上位 3B
    const mac = aesCmac(RFC_KEY, msg);
    expect(mac.toString("hex").slice(0, 8)).toBe(cmacTime(RFC_KEY_HEX));
  });
});

// ─────────────────────────────────────────────
// CRY-0005: cmacTime 256 秒粒度の境界
// ─────────────────────────────────────────────

describe("CRY-0005 cmacTime 256 秒粒度 (上位 3B) の境界", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("[CRY-0005] +255s では署名が変わらない (256s 境界をまたがない)", () => {
    const baseTs = Math.floor(1700000000 / 256) * 256;
    vi.setSystemTime(new Date(baseTs * 1000));
    const sig0 = cmacTime(RFC_KEY_HEX);
    vi.advanceTimersByTime(255 * 1000);
    expect(cmacTime(RFC_KEY_HEX)).toBe(sig0);
  });

  it("[CRY-0005] +256s では署名が変わる (256s 境界をまたぐ)", () => {
    const baseTs = Math.floor(1700000000 / 256) * 256;
    vi.setSystemTime(new Date(baseTs * 1000));
    const sig0 = cmacTime(RFC_KEY_HEX);
    vi.advanceTimersByTime(256 * 1000);
    expect(cmacTime(RFC_KEY_HEX)).not.toBe(sig0);
  });

  it("[CRY-0005] 同時刻反復は決定的に同値", () => {
    vi.setSystemTime(new Date(1700000000 * 1000));
    const a = cmacTime(RFC_KEY_HEX);
    const b = cmacTime(RFC_KEY_HEX);
    const c = cmacTime(RFC_KEY_HEX);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});

// ─────────────────────────────────────────────
// CRY-0006: cmacTime 戻り値フォーマット・鍵正規化・鍵長エラー
// ─────────────────────────────────────────────

describe("CRY-0006 cmacTime 戻り値フォーマット・鍵正規化・鍵長エラー", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1700000000 * 1000));
  });
  afterEach(() => { vi.useRealTimers(); });

  it("[CRY-0006] 戻り値は常に /^[0-9a-f]{8}$/ (8 文字小文字 hex)", () => {
    expect(cmacTime(RFC_KEY_HEX)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("[CRY-0006] 大文字 hex 鍵と小文字 hex 鍵で同一署名 (Buffer.from('hex') が両受理)", () => {
    expect(cmacTime(RFC_KEY_HEX.toUpperCase())).toBe(cmacTime(RFC_KEY_HEX.toLowerCase()));
  });

  it("[CRY-0006] 32 文字未満は /secretKey must be a 32-char hex string/ で throw", () => {
    expect(() => cmacTime("2b7e151628aed2a6abf7158809cf4f3")).toThrow(
      /secretKey must be a 32-char hex string/,
    );
  });

  it("[CRY-0006] エラーメッセージに length が含まれる (len=31 のケース)", () => {
    expect(() => cmacTime("2b7e151628aed2a6abf7158809cf4f3")).toThrow(/length 31/);
  });

  it("[CRY-0006] 32 文字超は /secretKey must be a 32-char hex string/ で throw", () => {
    expect(() => cmacTime("2b7e151628aed2a6abf7158809cf4f3cAA")).toThrow(
      /secretKey must be a 32-char hex string/,
    );
  });

  it("[CRY-0006] 32 文字だが非 hex は /secretKey must be a 32-char hex string/ で throw", () => {
    expect(() => cmacTime("z".repeat(32))).toThrow(/secretKey must be a 32-char hex string/);
  });

  it("[CRY-0006] 非文字列 (null) は /secretKey must be a 32-char hex string/ で throw", () => {
    // @ts-expect-error 意図的型違反
    expect(() => cmacTime(null)).toThrow(/secretKey must be a 32-char hex string/);
  });

  it("[CRY-0006] 非文字列 (Buffer) は /secretKey must be a 32-char hex string/ で throw", () => {
    // @ts-expect-error 意図的型違反
    expect(() => cmacTime(Buffer.from(RFC_KEY_HEX, "hex"))).toThrow(
      /secretKey must be a 32-char hex string/,
    );
  });
});

// ─────────────────────────────────────────────
// CRY-0007: uuidToHistoryBase64 prefix+16B → base64 既知ベクタ
// ─────────────────────────────────────────────

describe("CRY-0007 uuidToHistoryBase64 prefix+16B → base64 既知ベクタ", () => {
  const UUID_HYPHEN = "123e4567-e89b-12d3-a456-426614174000";
  const UUID_NO_HYPHEN = "123e4567e89b12d3a456426614174000";
  const UUID_UPPER = "123E4567-E89B-12D3-A456-426614174000";

  it("[CRY-0007] デフォルト prefix '000c' で 18B → base64 24 文字", () => {
    const result = uuidToHistoryBase64(UUID_HYPHEN);
    expect(typeof result).toBe("string");
    expect(result).toHaveLength(24);
  });

  it("[CRY-0007] decode 先頭 2B が 0x00 0x0c (prefix bytes = '000c')", () => {
    const decoded = Buffer.from(uuidToHistoryBase64(UUID_HYPHEN), "base64");
    expect(decoded).toHaveLength(18);
    expect(decoded[0]).toBe(0x00);
    expect(decoded[1]).toBe(0x0c);
  });

  it("[CRY-0007] decode 残り 16B が uuid バイト列に一致する", () => {
    const decoded = Buffer.from(uuidToHistoryBase64(UUID_HYPHEN), "base64");
    expect(decoded.subarray(2).toString("hex")).toBe(UUID_NO_HYPHEN);
  });

  it("[CRY-0007] ハイフン有/無で同値", () => {
    expect(uuidToHistoryBase64(UUID_HYPHEN)).toBe(uuidToHistoryBase64(UUID_NO_HYPHEN));
  });

  it("[CRY-0007] 大文字/小文字で同値", () => {
    expect(uuidToHistoryBase64(UUID_UPPER)).toBe(uuidToHistoryBase64(UUID_HYPHEN));
  });

  it("[CRY-0007] custom prefix '0001': 先頭 2B が 0x00 0x01 で uuid バイトも一致", () => {
    const decoded = Buffer.from(uuidToHistoryBase64(UUID_HYPHEN, "0001"), "base64");
    expect(decoded[0]).toBe(0x00);
    expect(decoded[1]).toBe(0x01);
    expect(decoded.subarray(2).toString("hex")).toBe(UUID_NO_HYPHEN);
  });

  it("[CRY-0007] custom prefix 'ffff': 先頭 2B が 0xff 0xff", () => {
    const decoded = Buffer.from(uuidToHistoryBase64(UUID_HYPHEN, "ffff"), "base64");
    expect(decoded[0]).toBe(0xff);
    expect(decoded[1]).toBe(0xff);
  });

  it("[CRY-0007] prefix 空文字: 16B のみ (uuid バイト列だけ)", () => {
    const decoded = Buffer.from(uuidToHistoryBase64(UUID_HYPHEN, ""), "base64");
    expect(decoded).toHaveLength(16);
    expect(decoded.toString("hex")).toBe(UUID_NO_HYPHEN);
  });
});

// ─────────────────────────────────────────────
// CRY-0008: uuidToHistoryBase64 長さ/型エラーと非 hex 打ち切り挙動
// ─────────────────────────────────────────────

describe("CRY-0008 uuidToHistoryBase64 長さ/型エラーと非 hex 打ち切り挙動の固定", () => {
  it("[CRY-0008] 非文字列 (undefined) は /uuid required \\(string\\)/ で throw", () => {
    // @ts-expect-error 意図的型違反
    expect(() => uuidToHistoryBase64(undefined)).toThrow(/uuid required \(string\)/);
  });

  it("[CRY-0008] 非文字列 (null) は /uuid required \\(string\\)/ で throw", () => {
    // @ts-expect-error 意図的型違反
    expect(() => uuidToHistoryBase64(null)).toThrow(/uuid required \(string\)/);
  });

  it("[CRY-0008] 非文字列 (数値) は /uuid required \\(string\\)/ で throw", () => {
    // @ts-expect-error 意図的型違反
    expect(() => uuidToHistoryBase64(123456)).toThrow(/uuid required \(string\)/);
  });

  it("[CRY-0008] ハイフン除去後 31hex は /got len=31/ で throw", () => {
    expect(() => uuidToHistoryBase64("0".repeat(31))).toThrow(/got len=31/);
  });

  it("[CRY-0008] ハイフン除去後 33hex は /got len=33/ で throw", () => {
    expect(() => uuidToHistoryBase64("0".repeat(33))).toThrow(/got len=33/);
  });

  it("[CRY-0008] 32 文字だが非 hex (z×32) は length チェックのみ通過し throw しない (打ち切り挙動の回帰固定)", () => {
    // 現状挙動の固定: hex 妥当性はチェックしない。Buffer.from の打ち切りで prefix のみ出力。
    const bogus = "z".repeat(32);
    expect(() => uuidToHistoryBase64(bogus)).not.toThrow();
    const decoded = Buffer.from(uuidToHistoryBase64(bogus), "base64");
    expect(decoded[0]).toBe(0x00);
    expect(decoded[1]).toBe(0x0c);
  });
});

// ─────────────────────────────────────────────
// CRY-0009: normalizeUuid ハイフン除去+小文字化
// ─────────────────────────────────────────────

describe("CRY-0009 normalizeUuid ハイフン除去+小文字化の照合用正規化", () => {
  const HYPHEN_UPPER = "123E4567-E89B-12D3-A456-426614174000";
  const HYPHEN_LOWER = "123e4567-e89b-12d3-a456-426614174000";
  const NO_HYPHEN    = "123e4567e89b12d3a456426614174000";
  const NO_HYPHEN_UP = "123E4567E89B12D3A456426614174000";

  it("[CRY-0009] 大文字/小文字・ハイフン有無の 4 形態が同一値に正規化されて比較一致", () => {
    expect(normalizeUuid(HYPHEN_UPPER)).toBe(NO_HYPHEN);
    expect(normalizeUuid(HYPHEN_LOWER)).toBe(NO_HYPHEN);
    expect(normalizeUuid(NO_HYPHEN_UP)).toBe(NO_HYPHEN);
    expect(normalizeUuid(NO_HYPHEN)).toBe(NO_HYPHEN);
  });

  it("[CRY-0009] 4 形態の相互比較がすべて一致 (照合用途)", () => {
    expect(normalizeUuid(HYPHEN_UPPER)).toBe(normalizeUuid(HYPHEN_LOWER));
    expect(normalizeUuid(HYPHEN_UPPER)).toBe(normalizeUuid(NO_HYPHEN));
    expect(normalizeUuid(NO_HYPHEN_UP)).toBe(normalizeUuid(NO_HYPHEN));
  });

  it("[CRY-0009] null → '' (空安全)", () => {
    // @ts-expect-error 意図的型違反
    expect(normalizeUuid(null)).toBe("");
  });

  it("[CRY-0009] undefined → '' (空安全)", () => {
    // @ts-expect-error 意図的型違反
    expect(normalizeUuid(undefined)).toBe("");
  });

  it("[CRY-0009] 数値 → '' (空安全)", () => {
    // @ts-expect-error 意図的型違反
    expect(normalizeUuid(42)).toBe("");
  });
});

// ─────────────────────────────────────────────
// CRY-0010: hexToUuid 32hex → 8-4-4-4-12 ダッシュ整形
// ─────────────────────────────────────────────

describe("CRY-0010 hexToUuid 32hex → 8-4-4-4-12 ダッシュ整形 (noHashtoUUID)", () => {
  it("[CRY-0010] a0b1c2d3e4f500112233445566778899 → a0b1c2d3-e4f5-0011-2233-445566778899", () => {
    expect(hexToUuid("a0b1c2d3e4f500112233445566778899")).toBe(
      "a0b1c2d3-e4f5-0011-2233-445566778899",
    );
  });

  it("[CRY-0010] 31桁 hex は throw する", () => {
    expect(() => hexToUuid("a".repeat(31))).toThrow();
  });

  it("[CRY-0010] 33桁 hex は throw する", () => {
    expect(() => hexToUuid("a".repeat(33))).toThrow();
  });

  it("[CRY-0010] 空文字は throw する (0B ≠ 16B)", () => {
    expect(() => hexToUuid("")).toThrow();
  });

  it("[CRY-0010] 非 hex 文字を含む 32 文字は throw する", () => {
    expect(() => hexToUuid("g".repeat(32))).toThrow();
  });

  it("[CRY-0010] normalizeUuid(hexToUuid(x)) === normalizeUuid(x) (往復べき等)", () => {
    const hex = "123e4567e89b12d3a456426614174000";
    expect(normalizeUuid(hexToUuid(hex))).toBe(normalizeUuid(hex));
  });

  it("[CRY-0010] SDK noHashtoUUID の 8-4-4-4-12 区切り構造と一致", () => {
    const hex = "deadbeefcafe00112233445566778899";
    const result = hexToUuid(hex);
    const parts = result.split("-");
    expect(parts).toHaveLength(5);
    expect(parts[0]).toHaveLength(8);
    expect(parts[1]).toHaveLength(4);
    expect(parts[2]).toHaveLength(4);
    expect(parts[3]).toHaveLength(4);
    expect(parts[4]).toHaveLength(12);
    expect(parts.join("")).toBe(hex);
  });
});

// ─────────────────────────────────────────────
// CRY-0011: isUuidV4 version/variant バイト判定
// ─────────────────────────────────────────────

describe("CRY-0011 isUuidV4 version/variant バイト判定 (byte6&0xf0==0x40, byte8&0xc0==0x80)", () => {
  // 既知 v4: byte[6]=0x41 → &0xf0=0x40, byte[8]=0xa7 → &0xc0=0x80
  const UUID_V4_STR = "550e8400-e29b-41d4-a716-446655440000";
  const UUID_V4_HEX = "550e8400e29b41d4a716446655440000";
  const UUID_V1 = "550e8400-e29b-11d4-a716-446655440000";
  const UUID_ZERO = "00000000-0000-0000-0000-000000000000";
  const UUID_BAD_VARIANT = "550e8400e29b41d47716446655440000";

  it("[CRY-0011] 有効な UUID v4 (ハイフン付き文字列) → true", () => {
    expect(isUuidV4(UUID_V4_STR)).toBe(true);
  });

  it("[CRY-0011] 有効な UUID v4 (32hex ノーハイフン) → true", () => {
    expect(isUuidV4(UUID_V4_HEX)).toBe(true);
  });

  it("[CRY-0011] 有効な UUID v4 (Buffer 16B) → true", () => {
    expect(isUuidV4(Buffer.from(UUID_V4_HEX, "hex"))).toBe(true);
  });

  it("[CRY-0011] UUID v1 (byte[6]&0xf0===0x10, version≠0x40) → false", () => {
    expect(isUuidV4(UUID_V1)).toBe(false);
  });

  it("[CRY-0011] 全ゼロ UUID (version=0x00) → false", () => {
    expect(isUuidV4(UUID_ZERO)).toBe(false);
  });

  it("[CRY-0011] variant bit が 0x80 でない (byte[8]=0x77) → false", () => {
    expect(isUuidV4(UUID_BAD_VARIANT)).toBe(false);
  });

  it("[CRY-0011] 非 16B Buffer (deadbeef=4B) → false", () => {
    expect(isUuidV4(Buffer.from("deadbeef", "hex"))).toBe(false);
  });

  it("[CRY-0011] null → false (falsy)", () => {
    expect(isUuidV4(null)).toBe(false);
  });

  it("[CRY-0011] '' → false (falsy)", () => {
    expect(isUuidV4("")).toBe(false);
  });

  it("[CRY-0011] undefined → false (falsy)", () => {
    expect(isUuidV4(undefined)).toBe(false);
  });
});

// ─────────────────────────────────────────────
// CRY-0012: generateUUID 大文字 v4 形式の契約
// ─────────────────────────────────────────────

describe("CRY-0012 generateUUID 大文字 v4 形式の契約", () => {
  it("[CRY-0012] 形式 /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/ を満たす", () => {
    const uuid = generateUUID();
    expect(uuid).toMatch(
      /^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/,
    );
  });

  it("[CRY-0012] isUuidV4(generateUUID()) === true (version/variant バイト検証)", () => {
    expect(isUuidV4(generateUUID())).toBe(true);
  });

  it("[CRY-0012] 大文字化 (biz3 generateUUID と同一の toUpperCase())", () => {
    const uuid = generateUUID();
    expect(uuid).toBe(uuid.toUpperCase());
  });

  it("[CRY-0012] 連続呼び出しで一意 (高確率)", () => {
    const uuids = new Set(Array.from({ length: 10 }, () => generateUUID()));
    expect(uuids.size).toBe(10);
  });
});

// ─────────────────────────────────────────────
// CRY-0013: formatPasscodeID 各桁→2桁 hex 既知ベクタ
// ─────────────────────────────────────────────

describe("CRY-0013 formatPasscodeID 各桁→2桁 hex 既知ベクタ", () => {
  it("[CRY-0013] '123' → '010203'", () => {
    expect(formatPasscodeID("123")).toBe("010203");
  });

  it("[CRY-0013] '0' → '00'", () => {
    expect(formatPasscodeID("0")).toBe("00");
  });

  it("[CRY-0013] '9' → '09'", () => {
    expect(formatPasscodeID("9")).toBe("09");
  });

  it("[CRY-0013] '0123456789' → '00010203040506070809'", () => {
    expect(formatPasscodeID("0123456789")).toBe("00010203040506070809");
  });

  it("[CRY-0013] 数値 123 → '010203' (toString() 経由, biz3utils.js:263 と同一)", () => {
    expect(formatPasscodeID(123)).toBe("010203");
  });

  it("[CRY-0013] '' → '' (空文字)", () => {
    expect(formatPasscodeID("")).toBe("");
  });

  it("[CRY-0013] 結果は大文字 (biz3utils.js:266 .toUpperCase() 仕様)", () => {
    const result = formatPasscodeID("123");
    expect(result).toBe(result.toUpperCase());
  });
});

// ─────────────────────────────────────────────
// CRY-0014: IR_TYPE / parseIrType wire 値マッピング
// ─────────────────────────────────────────────

describe("CRY-0014 IR_TYPE / parseIrType wire 値マッピングと解決の既知ベクタ", () => {
  it("[CRY-0014] IR_TYPE: frozen かつ各値が正しい wire 値", () => {
    expect(Object.isFrozen(IR_TYPE)).toBe(true);
    expect(IR_TYPE.ac).toBe(0xc000);    // 49152 エアコン
    expect(IR_TYPE.tv).toBe(0x2000);    //  8192 テレビ
    expect(IR_TYPE.light).toBe(0xe000); // 57344 照明
    expect(IR_TYPE.fan).toBe(0x8000);   // 32768 扇風機
    expect(IR_TYPE.learn).toBe(0xfe00); // 65024 自己学習リモコンの実 remote.type
  });

  it("[CRY-0014] learn の実 type は 0xFE00=65024 (UI 値 0xFEFF=65279 ではない)", () => {
    expect(IR_TYPE.learn).toBe(65024);
    expect(IR_TYPE.learn).not.toBe(65279);
    expect(IR_TYPE.learn).not.toBe(0xfeff);
  });

  it("[CRY-0014] parseIrType: 数値はそのまま素通し", () => {
    expect(parseIrType(49152)).toBe(49152);
    expect(parseIrType(0xfe00)).toBe(0xfe00);
    expect(parseIrType(12345)).toBe(12345);
  });

  it("[CRY-0014] parseIrType: エイリアス (大小/trim) を wire 値に解決", () => {
    expect(parseIrType("ac")).toBe(0xc000);
    expect(parseIrType("AC")).toBe(0xc000);
    expect(parseIrType("  tv  ")).toBe(0x2000);
    expect(parseIrType("learn")).toBe(0xfe00);
  });

  it("[CRY-0014] parseIrType: 数値文字列 '49152' → 49152", () => {
    expect(parseIrType("49152")).toBe(49152);
    expect(parseIrType("65024")).toBe(65024);
  });

  it("[CRY-0014] parseIrType: 未知エイリアス 'fridge' は候補付きで throw", () => {
    expect(() => parseIrType("fridge")).toThrow(/fridge/);
    expect(() => parseIrType("fridge")).toThrow(/ac/);
  });

  it("[CRY-0014] parseIrType: null/{} は /must be a string or number/ で throw", () => {
    // @ts-expect-error 意図的型違反
    expect(() => parseIrType(null)).toThrow(/must be a string or number/);
    // @ts-expect-error 意図的型違反
    expect(() => parseIrType({})).toThrow(/must be a string or number/);
  });
});

// ─────────────────────────────────────────────
// CRY-0015: hexToBuf 検証付き hex→Buffer デコードの境界
// ─────────────────────────────────────────────

describe("CRY-0015 hexToBuf 検証付き hex→Buffer デコードの境界", () => {
  it("[CRY-0015] 偶数長 hex を正しく Buffer に変換する", () => {
    const buf = hexToBuf("deadbeef");
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf).toHaveLength(4);
    expect(buf.toString("hex")).toBe("deadbeef");
  });

  it("[CRY-0015] 空文字 '' → 0B Buffer (エラーにならない)", () => {
    expect(hexToBuf("")).toHaveLength(0);
  });

  it("[CRY-0015] 奇数長 hex は /even-length/ で throw する", () => {
    expect(() => hexToBuf("abc")).toThrow(/even-length/);
  });

  it("[CRY-0015] 非 hex 文字は /non-hex characters found/ で throw する", () => {
    expect(() => hexToBuf("zz")).toThrow(/non-hex characters found/);
  });

  it("[CRY-0015] {bytes:n} 指定でデコード後バイト長不一致は /expected n byte/ で throw する", () => {
    expect(() => hexToBuf("deadbeef", { bytes: 2 })).toThrow(/expected 2 byte/);
    expect(() => hexToBuf("deadbeef", { bytes: 8 })).toThrow(/expected 8 byte/);
  });

  it("[CRY-0015] {bytes:n} が一致する場合は正常に返す", () => {
    expect(() => hexToBuf("deadbeef", { bytes: 4 })).not.toThrow();
    expect(hexToBuf("deadbeef", { bytes: 4 })).toHaveLength(4);
  });

  it("[CRY-0015] Buffer.from の黙った切り詰めを防ぐ (奇数長は throw)", () => {
    // Buffer.from('abc', 'hex') は 1B だけ返すが hexToBuf は throw する
    expect(() => hexToBuf("abc")).toThrow();
  });
});

// ─────────────────────────────────────────────
// CRY-0016: bufToHex Buffer/Uint8Array→小文字 hex と型エラー
// ─────────────────────────────────────────────

describe("CRY-0016 bufToHex Buffer/Uint8Array→小文字 hex と型エラー", () => {
  it("[CRY-0016] Buffer 入力を小文字 hex 文字列に変換する (SDK toHexString 相当)", () => {
    expect(bufToHex(Buffer.from([0xde, 0xad, 0xbe, 0xef]))).toBe("deadbeef");
  });

  it("[CRY-0016] Uint8Array 入力でも同一の小文字 hex を返す", () => {
    expect(bufToHex(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe("deadbeef");
  });

  it("[CRY-0016] 非 Buffer/Uint8Array (文字列) は /buf must be a Buffer\\/Uint8Array/ で throw する", () => {
    // @ts-expect-error 意図的型違反
    expect(() => bufToHex("deadbeef")).toThrow(/buf must be a Buffer\/Uint8Array/);
  });

  it("[CRY-0016] 非 Buffer/Uint8Array (数値) は /buf must be a Buffer\\/Uint8Array/ で throw する", () => {
    // @ts-expect-error 意図的型違反
    expect(() => bufToHex(12345)).toThrow(/buf must be a Buffer\/Uint8Array/);
  });

  it("[CRY-0016] hexToBuf → bufToHex の往復一致", () => {
    const hex = "deadbeef1234abcd";
    expect(bufToHex(hexToBuf(hex))).toBe(hex);
  });

  it("[CRY-0016] 空 Buffer → '' (空文字)", () => {
    expect(bufToHex(Buffer.alloc(0))).toBe("");
  });
});

// ─────────────────────────────────────────────
// CRY-0017: HKDF(SHA-256) 'Caldera Derived Key' 16B 導出の固定 KAT
// ─────────────────────────────────────────────

describe("CRY-0017 HKDF(SHA-256) 'Caldera Derived Key' 16B 導出 (Hkdf.java extract→expand と一致)", () => {
  // Hkdf.java 忠実実装 (extract+expand, 1 ブロック完結)
  const INFO_BITS = Buffer.from("Caldera Derived Key", "utf8");

  function hkdfExtract(ikm, salt) {
    return createHmac("sha256", salt).update(ikm).digest();
  }

  function hkdfExpand16(prk) {
    return createHmac("sha256", prk)
      .update(Buffer.concat([INFO_BITS, Buffer.from([1])]))
      .digest()
      .subarray(0, 16);
  }

  function hkdfSha256_16(ikm, salt) {
    return hkdfExpand16(hkdfExtract(ikm, salt));
  }

  // 固定 KAT 入力: S=12345678901234567890n, u=9876543210n
  // padHex(S) = "00ab54a98ceb1f0ad2", padHex(u) = "024cb016ea"
  const ikmHex = "00ab54a98ceb1f0ad2";
  const saltHex = "024cb016ea";
  const ikm = Buffer.from(ikmHex, "hex");
  const salt = Buffer.from(saltHex, "hex");

  it("[CRY-0017] PRK = HMAC-SHA256(salt, ikm) が独立計算と一致 (Hkdf.java:init/extract ステップ)", () => {
    const prk = hkdfExtract(ikm, salt);
    expect(prk.toString("hex")).toBe(
      "11bed31fbe8f26e2fad95077e93f6efdb68a097466d23e456705287afb960b89",
    );
  });

  it("[CRY-0017] OKM = HMAC-SHA256(PRK, 'Caldera Derived Key'||0x01)[0..15] が独立計算と一致 (Hkdf.java:deriveKey/expand ステップ)", () => {
    const okm = hkdfSha256_16(ikm, salt);
    expect(okm).toHaveLength(16);
    expect(okm.toString("hex")).toBe("e3e270695263a5252e23b48a446a5ec9");
  });

  it("[CRY-0017] length=16 <= macLen(32) なので 1 ブロックで完結する境界を確認", () => {
    const prk = hkdfExtract(ikm, salt);
    const t1Full = createHmac("sha256", prk)
      .update(Buffer.concat([INFO_BITS, Buffer.from([1])]))
      .digest();
    expect(t1Full).toHaveLength(32);
    expect(t1Full.subarray(0, 16).toString("hex")).toBe("e3e270695263a5252e23b48a446a5ec9");
  });

  it("[CRY-0017] srpPasswordSecrets の hkdf 出力が同一 HKDF 計算と一致 (固定ベクタで内部整合)", () => {
    const { N, G, modPow, padHex } = __srpTest;
    // 固定 a, A = g^a mod N
    const a = 3n;
    const A = modPow(G, a, N);
    // 固定 B (ゼロにならない valid 値)
    const serverB = modPow(G, 5n, N);
    const fixedSalt = 7n;

    const result = srpPasswordSecrets({
      firstId: "testGroup",
      secondId: "testKey",
      password: "testPassword",
      serverB,
      salt: fixedSalt,
      a,
      A,
    });

    expect(Buffer.isBuffer(result.hkdf)).toBe(true);
    expect(result.hkdf).toHaveLength(16);

    // 独立計算で一致を確認
    const independentHkdf = hkdfSha256_16(
      Buffer.from(padHex(result.sValue), "hex"),
      Buffer.from(padHex(result.u), "hex"),
    );
    expect(result.hkdf.toString("hex")).toBe(independentHkdf.toString("hex"));
  });
});

// ─────────────────────────────────────────────
// CRY-0018: K = H(N,g) SRP-6a 乗数 K の固定 KAT
// ─────────────────────────────────────────────

describe("CRY-0018 HKDF k = H(N,g) (SRP-6a 乗数 K) が padHex(N)||padHex(G) の SHA-256 で Java KK と一致する固定値", () => {
  const { K, N: SRP_N, G: SRP_G, padHex } = __srpTest;

  it("[CRY-0018] K の型が BigInt である", () => {
    expect(typeof K).toBe("bigint");
  });

  it("[CRY-0018] K の SHA-256 hex が既知固定値 538282c4…ee6 (ゴールデン回帰)", () => {
    expect(K.toString(16)).toBe(
      "538282c4354742d7cbbde2359fcf67f9f5b3a6b08791e5011b43b8a5b66d9ee6",
    );
  });

  it("[CRY-0018] 独立に SHA-256(padHex(N)||padHex(G)) を計算して K と一致 (Java KK とバイト等価)", () => {
    const combined = padHex(SRP_N) + padHex(SRP_G);
    const input = Buffer.from(combined, "hex");
    const hashHex = createHash("sha256").update(input).digest("hex").padStart(64, "0");
    expect(BigInt("0x" + hashHex)).toBe(K);
  });

  it("[CRY-0018] padHex(G=2) = '02' (最上位ビット立たず, 符号前置不要)", () => {
    expect(padHex(SRP_G)).toBe("02");
  });

  it("[CRY-0018] padHex(N) の先頭が '00ff' (MSB=1 のため符号ゼロ前置あり)", () => {
    const nHex = padHex(SRP_N);
    expect(nHex.startsWith("00ff")).toBe(true);
    // 3072-bit = 384 bytes → hex は 768 chars。符号前置で 770 chars
    expect(nHex).toHaveLength(770);
  });
});
