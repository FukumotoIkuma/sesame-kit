// 内製 AES-128-CMAC (src/aes-cmac.js) の RFC 4493 準拠検証。
//
// ベクタ出典: RFC 4493 §4 "Test Vectors" (Example 1-4 全件)。
// 旧依存 node-aes-cmac の置き換え (REFACTORING_PLAN P5-2) の受け入れテスト。
// 既存の tests/crypto/cmacTime.test.js (Test Vector 2) もこの実装経由で通ること。

import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import { aesCmac } from "../../src/aes-cmac.js";

// RFC 4493 §4 共通鍵 K
const K = Buffer.from("2b7e151628aed2a6abf7158809cf4f3c", "hex");
// §4 の M (64B 全量)。各 Example はこの先頭から len バイトを取る。
const M64 = Buffer.from(
  "6bc1bee22e409f96e93d7e117393172a" +
    "ae2d8a571e03ac9c9eb76fac45af8e51" +
    "30c81c46a35ce411e5fbc1191a0a52ef" +
    "f69f2445df4f9b17ad2b417be66c3710",
  "hex",
);

describe("aesCmac (RFC 4493)", () => {
  it("Example 1: len = 0 (空メッセージ)", () => {
    expect(aesCmac(K, Buffer.alloc(0)).toString("hex")).toBe(
      "bb1d6929e95937287fa37d129b756746",
    );
  });

  it("Example 2: len = 16 (完全 1 ブロック)", () => {
    expect(aesCmac(K, M64.subarray(0, 16)).toString("hex")).toBe(
      "070a16b46b4d4144f79bdd9dd04a287c",
    );
  });

  it("Example 3: len = 40 (不完全最終ブロック → K2 パディング経路)", () => {
    expect(aesCmac(K, M64.subarray(0, 40)).toString("hex")).toBe(
      "dfa66747de9ae63030ca32611497c827",
    );
  });

  it("Example 4: len = 64 (完全 4 ブロック → K1 経路)", () => {
    expect(aesCmac(K, M64).toString("hex")).toBe(
      "51f0bebf7e3b9d92fc49741779363cfe",
    );
  });

  it("戻り値は常に 16B Buffer (node-aes-cmac の hex/Buffer 揺れを排除)", () => {
    const mac = aesCmac(K, M64.subarray(0, 16));
    expect(Buffer.isBuffer(mac)).toBe(true);
    expect(mac.length).toBe(16);
  });

  it("Uint8Array 入力も受理する (Buffer と同一 MAC)", () => {
    const mac = aesCmac(new Uint8Array(K), new Uint8Array(M64.subarray(0, 16)));
    expect(mac.toString("hex")).toBe("070a16b46b4d4144f79bdd9dd04a287c");
  });

  it("鍵長 16B 以外 / 非バイト列メッセージは明示エラー", () => {
    expect(() => aesCmac(Buffer.alloc(15), Buffer.alloc(0))).toThrow(/16-byte/);
    expect(() => aesCmac(Buffer.alloc(17), Buffer.alloc(0))).toThrow(/16-byte/);
    // @ts-expect-error 意図的な型違反 (実行時検証の確認)
    expect(() => aesCmac("2b7e151628aed2a6abf7158809cf4f3c", Buffer.alloc(0))).toThrow(/16-byte/);
    // @ts-expect-error 意図的な型違反 (実行時検証の確認)
    expect(() => aesCmac(K, "6bc1bee2")).toThrow(/Buffer/);
  });

  it("MAC は入力メッセージのバイト列を変更しない (XOR の in-place 破壊なし)", () => {
    const msg = Buffer.from(M64.subarray(0, 16));
    aesCmac(K, msg);
    expect(msg.equals(M64.subarray(0, 16))).toBe(true);
  });
});
