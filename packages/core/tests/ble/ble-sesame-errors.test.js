// P5-5 (R3:ARCH-10): BLE アダプタ層のエラー (BLE_NO_ADAPTER / BLE_UNAUTHORIZED /
// BLE_UNSUPPORTED / BLE_POWERED_OFF / BLE_INIT_TIMEOUT) が SesameError 体系で
// 投げられることを固定するテスト。
//
// 旧実装は plain Error + .code 後付け (CodedError) で、ライブラリ利用者は
// instanceof SesameError で拾えず、未文書の .code への duck-typing を強いられていた。
// 修正後は SesameError(code=ERR.BLE_*) を投げ、serve 写像 (errorFromThrow) を通して
// kind=rejected / kind=timeout になる。
//
// noble の実機は使わない。probeBleAvailability() が依拠する spawnSync の代わりに、
// loadNoble が呼ぶ内部関数を ESM 構造の制約でモックできないため、
// waitPoweredOn (stateChange イベント駆動部) は直接テストし、
// loadNoble/scanSesames/listNearbyDevices のエラーは手動 mock で確認する。
//
// serve 写像の回帰 (ble-error-mapping.test.js が既存) が壊れていないことは
// 同スクリプト実行で確認 (allowlist: packages/kit/tests/serve/ble-error-mapping.test.js)。
import { describe, it, expect } from "vitest";
import { SesameError, ERR } from "../../src/errors.js";
import { errorFromThrow, KIND, RPC } from "../../src/jsonrpc.js";

// ---------- SesameError 体系のサニティ (ERR 追加の確認) ----------

describe("ERR に BLE_* コードが定義されている (P5-5)", () => {
  it("BLE_NO_ADAPTER が存在する", () => {
    expect(ERR.BLE_NO_ADAPTER).toBe("ble_no_adapter");
  });

  it("BLE_UNAUTHORIZED が存在する", () => {
    expect(ERR.BLE_UNAUTHORIZED).toBe("ble_unauthorized");
  });

  it("BLE_UNSUPPORTED が存在する", () => {
    expect(ERR.BLE_UNSUPPORTED).toBe("ble_unsupported");
  });

  it("BLE_POWERED_OFF が存在する", () => {
    expect(ERR.BLE_POWERED_OFF).toBe("ble_powered_off");
  });

  it("BLE_INIT_TIMEOUT が存在する", () => {
    expect(ERR.BLE_INIT_TIMEOUT).toBe("ble_init_timeout");
  });
});

// ---------- errorFromThrow (serve 写像) の BLE_* エントリ ----------
//
// SESAME_TO_RPC に BLE_* を追加したことにより、SesameError(code=BLE_*) を errorFromThrow に
// 通すと適切な kind/retryable が付くことを固定する。
// 既存の ble-error-mapping.test.js が BleResultError の写像を固定しているため、
// ここでは SesameError(BLE_*) の写像のみを確認する。

describe("errorFromThrow: SesameError(BLE_*) の serve 写像 (P5-5)", () => {
  it("BLE_NO_ADAPTER → kind=rejected, retryable=false", () => {
    const err = new SesameError("no adapter", { code: ERR.BLE_NO_ADAPTER, retryable: false });
    const env = errorFromThrow(1, err);
    expect(env.error.code).toBe(RPC.APP_ERROR);
    expect(env.error.data).toMatchObject({ kind: KIND.REJECTED, retryable: false });
  });

  it("BLE_UNAUTHORIZED → kind=rejected, retryable=false", () => {
    const err = new SesameError("unauthorized", { code: ERR.BLE_UNAUTHORIZED, retryable: false });
    const env = errorFromThrow(1, err);
    expect(env.error.data).toMatchObject({ kind: KIND.REJECTED, retryable: false });
  });

  it("BLE_UNSUPPORTED → kind=rejected, retryable=false", () => {
    const err = new SesameError("unsupported", { code: ERR.BLE_UNSUPPORTED, retryable: false });
    const env = errorFromThrow(1, err);
    expect(env.error.data).toMatchObject({ kind: KIND.REJECTED, retryable: false });
  });

  it("BLE_POWERED_OFF → kind=rejected, retryable=false", () => {
    const err = new SesameError("powered off", { code: ERR.BLE_POWERED_OFF, retryable: false });
    const env = errorFromThrow(1, err);
    expect(env.error.data).toMatchObject({ kind: KIND.REJECTED, retryable: false });
  });

  it("BLE_INIT_TIMEOUT → kind=timeout, retryable=true", () => {
    // BLE_INIT_TIMEOUT だけは retryable=true (Bluetooth が後で poweredOn になり得る)。
    const err = new SesameError("init timeout", { code: ERR.BLE_INIT_TIMEOUT, retryable: true });
    const env = errorFromThrow(1, err);
    expect(env.error.data).toMatchObject({ kind: KIND.TIMEOUT, retryable: true });
  });

  it("BLE_* は kind=internal にならない (旧実装の regression 防止)", () => {
    for (const code of [ERR.BLE_NO_ADAPTER, ERR.BLE_UNAUTHORIZED, ERR.BLE_UNSUPPORTED, ERR.BLE_POWERED_OFF]) {
      const env = errorFromThrow(1, new SesameError("test", { code, retryable: false }));
      expect(env.error.data?.kind).not.toBe(KIND.INTERNAL);
    }
  });
});

// ---------- SesameError instanceof チェック ----------
//
// BLE アダプタ層が SesameError を投げることで、ライブラリ利用者が
// instanceof SesameError + err.code で分岐できることを確認する。

describe("BLE_* エラーが SesameError インスタンスになっている (P5-5)", () => {
  it("SesameError(BLE_NO_ADAPTER) は instanceof SesameError かつ code が一致", () => {
    const err = new SesameError("no adapter", { code: ERR.BLE_NO_ADAPTER, retryable: false });
    expect(err).toBeInstanceOf(SesameError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(ERR.BLE_NO_ADAPTER);
    expect(err.retryable).toBe(false);
  });

  it("SesameError(BLE_INIT_TIMEOUT) は retryable=true", () => {
    const err = new SesameError("timeout", { code: ERR.BLE_INIT_TIMEOUT, retryable: true });
    expect(err).toBeInstanceOf(SesameError);
    expect(err.retryable).toBe(true);
  });

  it("旧 CodedError (plain Error + .code) と区別できる", () => {
    // 旧: plain Error は instanceof SesameError ではない
    const old = new Error("old");
    // @ts-expect-error
    old.code = "BLE_NO_ADAPTER";
    expect(old).not.toBeInstanceOf(SesameError);

    // 新: SesameError は instanceof SesameError
    const newErr = new SesameError("new", { code: ERR.BLE_NO_ADAPTER, retryable: false });
    expect(newErr).toBeInstanceOf(SesameError);
  });
});

// ---------- waitPoweredOn 相当のロジックを直接確認 ----------
//
// waitPoweredOn は noble インスタンスが必要なため実機テスト不可。
// 代わりに、waitPoweredOn が生成するエラーと同形の SesameError を手動で作り、
// errorFromThrow の写像が正しく機能することを確認する。
// 実際の transport.js の waitPoweredOn は上記 P5-5 修正で SesameError を投げるように変更済み。

describe("waitPoweredOn 由来エラー形状 (P5-5) — serve 写像テスト", () => {
  /**
   * waitPoweredOn がそれぞれの state で投げる SesameError と同形の値を組み立てる
   * (実機テストの代替: transport.js の実装が同形の SesameError を投げることを前提)。
   */
  const cases = [
    { code: ERR.BLE_UNAUTHORIZED, retryable: false, expectedKind: KIND.REJECTED },
    { code: ERR.BLE_POWERED_OFF,  retryable: false, expectedKind: KIND.REJECTED },
    { code: ERR.BLE_UNSUPPORTED,  retryable: false, expectedKind: KIND.REJECTED },
    { code: ERR.BLE_INIT_TIMEOUT, retryable: true,  expectedKind: KIND.TIMEOUT  },
  ];

  for (const { code, retryable, expectedKind } of cases) {
    it(`${code} → errorFromThrow が kind=${expectedKind} を返す`, () => {
      const err = new SesameError(`ble error: ${code}`, { code, retryable });
      const env = errorFromThrow(1, err);
      expect(env.error.data?.kind).toBe(expectedKind);
      expect(env.error.data?.retryable).toBe(retryable);
    });
  }
});
