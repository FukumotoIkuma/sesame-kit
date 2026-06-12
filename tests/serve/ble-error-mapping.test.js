// SURF-11: BleResultError (デバイス結果コード付き BLE エラー) の RPC 透過テスト。
//
// 旧実装は errorFromThrow が BleResultError を kind=internal に潰し、resultCode/resultName が
// RPC 境界で失われていた。本テストは
//   - resultName → kind の写像 (busy/notFound 等 → rejected / invalidSig → not_authenticated /
//     invalidParam 系 → bad_params)
//   - error.data に {bleResultCode, bleResultName, itemCode} が透過されること
//   - OS3 / OS2 両方の BleResultError (別クラス・同形契約) が同様に扱われること
// を固定する。resultName の語彙は SesameResultCode (src/ble/protocol.js RESULT)。
import { describe, it, expect } from "vitest";
import { errorFromThrow, RPC } from "../../src/jsonrpc.js";
import { BleResultError } from "../../src/ble/session.js";
import { BleResultError as Os2BleResultError } from "../../src/ble/os2/session.js";

describe("errorFromThrow: BleResultError の透過 (SURF-11)", () => {
  it("busy(7) → rejected / retryable:true、data に結果コード一式", () => {
    const env = errorFromThrow(1, new BleResultError("command", 7, 82));
    expect(env.error.code).toBe(RPC.APP_ERROR);
    expect(env.error.data).toEqual({
      bleResultCode: 7,
      bleResultName: "busy",
      itemCode: 82,
      retryable: true,
      kind: "rejected",
    });
    // message にもデバイス由来の結果名が残る (人間向け)。
    expect(env.error.message).toContain("busy");
  });

  it("notFound(5) → rejected / retryable:false", () => {
    const env = errorFromThrow(1, new BleResultError("command", 5, 92));
    expect(env.error.data).toMatchObject({
      kind: "rejected", retryable: false, bleResultCode: 5, bleResultName: "notFound", itemCode: 92,
    });
  });

  it("invalidSig(4) (secretKey 不一致) → not_authenticated", () => {
    const env = errorFromThrow(1, new BleResultError("login", 4));
    expect(env.error.data).toMatchObject({
      kind: "not_authenticated", bleResultCode: 4, bleResultName: "invalidSig", itemCode: null,
    });
  });

  it("invalidFormat(1)/invalidParam(8) → bad_params + INVALID_PARAMS", () => {
    // SesameProtocols.kt:28-30 で確認済みの 1:1 写像 (P3-16: 検証済みコードのみ)。
    for (const [code, name] of [[1, "invalidFormat"], [8, "invalidParam"]]) {
      const env = errorFromThrow(1, new BleResultError("command", code, 11));
      expect(env.error.code).toBe(RPC.INVALID_PARAMS);
      expect(env.error.data).toMatchObject({ kind: "bad_params", bleResultCode: code, bleResultName: name });
    }
  });

  it("notSupported(2)/resultStorageFail(3)/unknown(6) → rejected", () => {
    for (const code of [2, 3, 6]) {
      const env = errorFromThrow(1, new BleResultError("command", code));
      expect(env.error.data).toMatchObject({ kind: "rejected", retryable: false, bleResultCode: code });
    }
  });

  it("コード9 (invalidAction) は未検証 (references_ios/ 不在) → resultName=unknown(9) → rejected にフォールバック (P3-16)", () => {
    // RESULT 本体は SesameProtocols.kt:28-30 と 1:1 で 8 で終端。コード 9 は UNVERIFIED_RESULT_NAMES に
    // 隔離されており resultName(9) = "unknown(9)" を返す。BLE_RESULT_TO_RPC に "unknown(9)" キーは
    // 存在しないため errorFromThrow の fallback (rejected) で処理される。
    const env = errorFromThrow(1, new BleResultError("command", 9, 11));
    expect(env.error.data).toMatchObject({
      kind: "rejected", bleResultCode: 9, bleResultName: "unknown(9)",
    });
    // bad_params には**ならない**こと (確証のある写像ではない)。
    expect(env.error.data.kind).not.toBe("bad_params");
  });

  it("未知の結果コード (resultName=unknown(N)) は rejected にフォールバック", () => {
    const env = errorFromThrow(1, new BleResultError("command", 99));
    expect(env.error.data).toMatchObject({
      kind: "rejected", bleResultCode: 99, bleResultName: "unknown(99)",
    });
  });

  it("OS2 の BleResultError (別クラス・同形契約) も同様に写像される", () => {
    const env = errorFromThrow(1, new Os2BleResultError("command", 7, 82));
    expect(env.error.data).toMatchObject({
      kind: "rejected", retryable: true, bleResultCode: 7, bleResultName: "busy", itemCode: 82,
    });
  });

  it("kind は契約フィールドとして caller data に上書きされない (makeError の規約)", () => {
    const env = errorFromThrow(1, new BleResultError("command", 7));
    // data.kind が必ず写像結果になっている (BleResultError 側の値に依らない)。
    expect(env.error.data.kind).toBe("rejected");
  });
});
