// P5-5 (ARCH-09): SesameBle 公開ファサード入口 (コンストラクタ / op ゲート / サブファサード
// ゲート) の throw が SesameError(BAD_REQUEST) になったことを固定する。
// 旧実装は plain Error で、serve 経由では kind=internal に潰れていた (→ bad_params へ)。
// 注: セッション層の BleResultError は対象外 (Phase 4 で RPC 写像済み — 包み直さない)。
import { describe, it, expect } from "vitest";
import { SesameBle } from "../../src/ble/index.js";
import { SesameError, ERR } from "../../src/errors.js";

/** @param {unknown} fn */
function expectBadRequest(fn) {
  try {
    /** @type {Function} */ (fn)();
    expect.unreachable();
  } catch (e) {
    expect(e).toBeInstanceOf(SesameError);
    expect(/** @type {SesameError} */ (e).code).toBe(ERR.BAD_REQUEST);
  }
}

describe("SesameBle ファサード入口の SesameError(BAD_REQUEST) 化 (P5-5)", () => {
  it("コンストラクタ: secretKey 欠落 (非 register モード)", () => {
    expectBadRequest(() => new SesameBle({}));
  });

  it("op ゲート: 非対応 op (Bot2 に lock)", () => {
    const bot = new SesameBle({ secretKey: "00".repeat(16), model: "bot_2" });
    expectBadRequest(() => bot.lock());
    expectBadRequest(() => bot.autolock(30));
  });

  it("LOCK5 固有ゲート: magnet / configureLockPosition (Bot2)", () => {
    const bot = new SesameBle({ secretKey: "00".repeat(16), model: "bot_2" });
    expectBadRequest(() => bot.magnet());
    expectBadRequest(() => bot.configureLockPosition(0, 0));
  });

  it("サブファサードゲート: biometric / fingerPrint / script / wifi / hub3 (ロックで参照)", () => {
    const lock = new SesameBle({ secretKey: "00".repeat(16), model: "sesame_5" });
    expectBadRequest(() => lock.biometric);
    expectBadRequest(() => lock.fingerPrint);
    expectBadRequest(() => lock.script);
    expectBadRequest(() => lock.wifi());
    expectBadRequest(() => lock.hub3());
  });

  it("DFU / reset / TxPower ゲート: OS2 機種", () => {
    const os2 = new SesameBle({ secretKey: "00".repeat(16), model: "sesame_4" });
    expectBadRequest(() => os2.updateFirmware());
    expectBadRequest(() => os2.reset());
    expectBadRequest(() => os2.setBleTxPower(0));
  });

  it("register 誤用ゲート: secretKey 付きで register()", async () => {
    const lock = new SesameBle({ secretKey: "00".repeat(16), model: "sesame_5" });
    await expect(lock.register()).rejects.toMatchObject({ name: "SesameError", code: ERR.BAD_REQUEST });
  });

  it("fromDiscovery: peripheral 欠落", () => {
    expectBadRequest(() => SesameBle.fromDiscovery(/** @type {any} */ ({})));
  });
});
