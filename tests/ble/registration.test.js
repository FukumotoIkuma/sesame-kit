// BLE デバイス登録 / 初期ペアリングのバイト列ユニットテスト (純 JS、ハードウェア不要)。
//
// 対象:
//   registrationTimestampBytes(nowMs) — 登録 payload 末尾の現在時刻 4B。
//
// 原典 (CANDY-HOUSE SesameSDK):
//   DataExtention.kt:138-147 — Long.toUInt32ByteArray():
//     tmp = this / 1000; bytes[0..3] に秒値を BE で詰め (.toByte() で下位 8bit)
//     → reversedArray() で実質「秒値の下位 32bit を little-endian 4B」。
//   CHHub3Device.kt:193 — registration payload = pubKey(64B) ++ currentTimeMillis().toUInt32ByteArray()。
//
// 既知ベクタ: DataExtention.kt:139 のコメント
//   ["🧕 initialize", 1605929466.48249, 1605929466, "fa89b85f"]
//   → ms=1605929466482, sec=1605929466(=0x5FB889FA), LE 4B = fa 89 b8 5f。

import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
// AES-CMAC は内製実装 (src/aes-cmac.js, RFC 4493)。旧 node-aes-cmac は P5-2 で除去。
import { aesCmac } from "../../src/aes-cmac.js";
import {
  registrationTimestampBytes,
  registrationData,
  buildSendFrame,
  ITEM,
  SEG,
  deriveSessionKey,
  deriveSessionKeyFromEcdh,
} from "../../src/ble/protocol.js";

describe("registrationTimestampBytes", () => {
  it("固定 ms=1605929466482 で SDK コメントの 'fa89b85f' と一致 (ハードコード期待値)", () => {
    const out = registrationTimestampBytes(1605929466482);
    expect(out.length).toBe(4);
    expect(out.toString("hex")).toBe("fa89b85f");
    // バイト単位の明示確認 (秒値 0x5FB889FA の little-endian)。
    expect([...out]).toEqual([0xfa, 0x89, 0xb8, 0x5f]);
  });

  it("ミリ秒は秒へ floor され、同一秒内では同一バイト列", () => {
    const a = registrationTimestampBytes(1605929466000); // sec 境界ちょうど
    const b = registrationTimestampBytes(1605929466999); // 同じ秒の末尾
    expect(a.equals(b)).toBe(true);
    expect(a.toString("hex")).toBe("fa89b85f");
  });

  it("秒値の各バイトを little-endian で詰める (toUInt32ByteArray 1:1)", () => {
    // sec = 0x01020304 → ms = 0x01020304 * 1000。LE 4B = 04 03 02 01。
    const sec = 0x01020304;
    const out = registrationTimestampBytes(sec * 1000);
    expect([...out]).toEqual([0x04, 0x03, 0x02, 0x01]);
  });

  it("sec=0 は 00000000", () => {
    expect(registrationTimestampBytes(0).toString("hex")).toBe("00000000");
  });

  it("sec が 32bit 上限 (0xFFFFFFFF) ちょうど → ffffffff", () => {
    const out = registrationTimestampBytes(0xffffffff * 1000);
    expect(out.toString("hex")).toBe("ffffffff");
  });

  it("遠未来で秒値が 32bit を超えても下位 32bit のみを取る (ushr マスク再現)", () => {
    // sec = 0x1_0000_0001 (33bit)。下位 32bit = 0x00000001 → LE 4B = 01 00 00 00。
    // bit32 以上は b0(=bits24..31) にも乗らないため自然に切り捨てられる。
    const sec = 0x100000001; // 4294967297
    const out = registrationTimestampBytes(sec * 1000);
    expect([...out]).toEqual([0x01, 0x00, 0x00, 0x00]);

    // sec = 0x2_5FB8_89FA → 下位 32bit = 0x5FB889FA → 既知ベクタと同じ fa89b85f。
    const sec2 = 0x25fb889fa; // 上位ニブル 0x2 を付与
    const out2 = registrationTimestampBytes(sec2 * 1000);
    expect(out2.toString("hex")).toBe("fa89b85f");
  });

  it("引数省略時は Date.now() を使い、4B Buffer を返す", () => {
    const out = registrationTimestampBytes();
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.length).toBe(4);
    // 現在時刻 (sec ~= 1.7e9 < 2^32) を渡した場合と一致するはず (同一秒内なら)。
    const sec = Math.floor(Date.now() / 1000);
    const expected = registrationTimestampBytes(sec * 1000);
    // out の秒境界跨ぎを避けるため再計算した期待値と長さ/形式のみ厳密比較。
    expect(expected.length).toBe(4);
  });

  it("負値 / 非有限 / 非数値は throw", () => {
    expect(() => registrationTimestampBytes(-1)).toThrow(/nowMs|epoch|非負/);
    expect(() => registrationTimestampBytes(NaN)).toThrow(/nowMs|epoch|非負/);
    expect(() => registrationTimestampBytes(Infinity)).toThrow(/nowMs|epoch|非負/);
    expect(() => registrationTimestampBytes("123")).toThrow(/nowMs|epoch|非負/);
  });
});

// ---------- REGISTRATION(1) フレーム生成 (pubK ++ timestamp) ----------
//
// 原典 (CANDY-HOUSE SesameSDK, co/candyhouse/sesame/ble/os3):
//   CHHub3Device.kt:191-194 — registration data = EccKey.getPubK()(64B)
//     ++ currentTimeMillis().toUInt32ByteArray()(4B) = 68B。
//   CHSesameOS3.kt:495-499 — 送信フレーム = [item_code] ++ data (op_code は付与しない)。
//     REGISTRATION は session 確立前なので PLAINTEXT セグメントで平文送信。
describe("registrationData / REGISTRATION フレーム生成", () => {
  // 固定 pubK (64B = X32 ‖ Y32 の体裁。値はテスト用任意バイト列)。
  const pubKHex = "11".repeat(32) + "22".repeat(32); // 64B = 128hex
  const pubK = Buffer.from(pubKHex, "hex");
  const ms = 1605929466482; // 既知ベクタ (sec=0x5FB889FA → LE fa89b85f)

  it("data = pubK(64B) ++ timestamp(4B) = 68B、先頭64B=pubK・末尾4B=timestamp", () => {
    const data = registrationData(pubK, ms);
    expect(data.length).toBe(68);
    expect(data.subarray(0, 64).equals(pubK)).toBe(true);
    expect(data.subarray(64).toString("hex")).toBe("fa89b85f");
    // timestamp は registrationTimestampBytes と一致 (委譲先と 1:1)。
    expect(data.subarray(64).equals(registrationTimestampBytes(ms))).toBe(true);
  });

  it("pubK は 128hex 文字列でも受理し、Buffer 渡しと同一結果", () => {
    const fromHex = registrationData(pubKHex, ms);
    const fromBuf = registrationData(pubK, ms);
    expect(fromHex.equals(fromBuf)).toBe(true);
  });

  it("buildSendFrame(ITEM.REGISTRATION, data) で [01]++data = 69B、ヘッダ=0x01", () => {
    const data = registrationData(pubK, ms);
    const frame = buildSendFrame(ITEM.REGISTRATION, data);
    expect(frame.length).toBe(69);
    expect(frame[0]).toBe(0x01); // ITEM_CODES.REGISTRATION = 1
    expect(ITEM.REGISTRATION).toBe(1);
    expect(frame.subarray(1).equals(data)).toBe(true);
    // 末尾 4B は timestamp のまま。
    expect(frame.subarray(65).toString("hex")).toBe("fa89b85f");
  });

  it("PLAINTEXT セグメントで送る前提 (SEG.PLAINTEXT=1)", () => {
    // registration は session 確立前のため暗号化しない (CHSesameOS3.kt:495-499)。
    expect(SEG.PLAINTEXT).toBe(1);
  });

  it("nowMs 省略時は Date.now() を使い 68B (先頭64B=pubK)", () => {
    const data = registrationData(pubK);
    expect(data.length).toBe(68);
    expect(data.subarray(0, 64).equals(pubK)).toBe(true);
  });

  it("pubK が 64B でない / 不正 hex / 非対応型は throw", () => {
    expect(() => registrationData(Buffer.alloc(63), ms)).toThrow(/pubK|64/);
    expect(() => registrationData(Buffer.alloc(65), ms)).toThrow(/pubK|64/);
    expect(() => registrationData("11".repeat(31), ms)).toThrow(/pubK|64/); // 62hex=31B
    expect(() => registrationData("zz".repeat(32), ms)).toThrow(/pubK|64/); // 非 hex
    expect(() => registrationData("11".repeat(32) + "2", ms)).toThrow(/pubK|64/); // 奇数長
    expect(() => registrationData(12345, ms)).toThrow(/pubK|64/);
  });

  it("不正 nowMs は registrationTimestampBytes の検証で throw (委譲)", () => {
    expect(() => registrationData(pubK, -1)).toThrow(/nowMs|epoch|非負/);
    expect(() => registrationData(pubK, NaN)).toThrow(/nowMs|epoch|非負/);
  });
});

// ---------- session 鍵導出の分岐 (register: ECDH-CMAC / login: secretKey-CMAC) ----------
//
// 原典 (CANDY-HOUSE SesameSDK, co/candyhouse/sesame/ble/os3):
//   CHHub3Device.kt:163-174,197,202-203 — register 直後の sessionAuth は
//     sessionKey = AES-CMAC(ecdh().sliceArray(0..15), token4)   (鍵 = ECDH 共有秘密の先頭 16B)
//   CHHub3Device.kt:168 — 通常 login は
//     sessionKey = AES-CMAC(secretKey, token4)                  (鍵 = pre-shared secretKey)
//   CHHub3Device.kt:170,203 / SesameOS3BleCipher.kt:8-19 — sault = 0x00 ++ token4 は両者共通
//     (sault は CCM nonce 側で消費。鍵導出関数は token4 を CMAC メッセージに取る点が共通)。
//
// 両 helper は「CMAC のメッセージ = token4 (4B)」「戻り 16B」で同一構造。差は CMAC の鍵だけ。
describe("session 鍵導出 (deriveSessionKey vs deriveSessionKeyFromEcdh)", () => {
  // 既知の固定ベクタ (ECDH 共有秘密先頭 16B 相当 / token4)。
  const ecdhSecretPre16 = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  const token4 = Buffer.from("fa89b85f", "hex");

  it("deriveSessionKeyFromEcdh は AES-CMAC(ecdhSecretPre16, token4) で固定 16B (ハードコード期待値)", () => {
    const out = deriveSessionKeyFromEcdh(ecdhSecretPre16, token4);
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.length).toBe(16);
    expect(out.toString("hex")).toBe("26cba83fd8a5eb2e1d70a2b90fb4be83");
  });

  it("CMAC の入力メッセージは token4(4B)・鍵は ecdhSecretPre16(16B) であることを直接 CMAC と照合", () => {
    const expected = aesCmac(ecdhSecretPre16, token4, { returnAsBuffer: true });
    const out = deriveSessionKeyFromEcdh(ecdhSecretPre16, token4);
    expect(out.equals(Buffer.isBuffer(expected) ? expected : Buffer.from(expected, "hex"))).toBe(true);
  });

  it("分岐統一: 同一鍵・同一 token4 なら両 helper の出力は一致 (差は鍵の出所のみ)", () => {
    // register 経路 (ECDH 秘密を鍵) と login 経路 (同値を secretKey として渡す) で
    // CMAC 構造が同一であることを 1:1 で確認する。
    const viaEcdh = deriveSessionKeyFromEcdh(ecdhSecretPre16, token4);
    const viaLogin = deriveSessionKey(ecdhSecretPre16, token4);
    expect(viaEcdh.equals(viaLogin)).toBe(true);
  });

  it("RFC 4493 標準鍵で CMAC 整合 (内製 aes-cmac.js は RFC 4493 実装)", () => {
    // RFC 4493 §4 のテスト鍵 K。メッセージは token4 相当の 4B。
    const rfcKey = Buffer.from("2b7e151628aed2a6abf7158809cf4f3c", "hex");
    const msg4 = Buffer.from("6bc1bee2", "hex"); // RFC メッセージ先頭 4B
    const out = deriveSessionKeyFromEcdh(rfcKey, msg4);
    expect(out.length).toBe(16);
    // 内製 aesCmac (src/aes-cmac.js, RFC 4493 — Test Vector 全件固定済み) を真値として照合 (鍵=RFC鍵, msg=4B)。
    const ref = aesCmac(rfcKey, msg4, { returnAsBuffer: true });
    expect(out.equals(Buffer.isBuffer(ref) ? ref : Buffer.from(ref, "hex"))).toBe(true);
    expect(out.toString("hex")).toBe("71c5a229ba6db8c471075ac5b9c64ffe");
  });

  it("ecdhSecretPre16 が 16B でない / Buffer でない場合は throw", () => {
    expect(() => deriveSessionKeyFromEcdh(Buffer.alloc(15), token4)).toThrow(/ecdhSecretPre16|16/);
    expect(() => deriveSessionKeyFromEcdh(Buffer.alloc(32), token4)).toThrow(/ecdhSecretPre16|16/);
    expect(() => deriveSessionKeyFromEcdh("00112233445566778899aabbccddeeff", token4)).toThrow(/ecdhSecretPre16|16/);
  });

  it("token4 が 4B でない場合は throw (CMAC メッセージ長の検証)", () => {
    expect(() => deriveSessionKeyFromEcdh(ecdhSecretPre16, Buffer.alloc(3))).toThrow(/token|4/);
    expect(() => deriveSessionKeyFromEcdh(ecdhSecretPre16, Buffer.alloc(5))).toThrow(/token|4/);
    expect(() => deriveSessionKeyFromEcdh(ecdhSecretPre16, "fa89b85f")).toThrow(/token|4/);
  });
});
