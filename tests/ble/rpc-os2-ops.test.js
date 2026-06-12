// P4-5: OS2 管理系 op (reset / configureLockPosition) の typed RPC 結線テスト。
//
// OS2_TOPLEVEL_RPC_OPS に追記した reset / configureLockPosition が
//   (1) registry に `ble.os2.reset` / `ble.os2.configureLockPosition` として登録されること
//   (2) experimental であること
//   (3) SesameOS2Ble.use スタブ経由で正しい位置引数がファサードに届くこと
//   (4) configureLockPosition の必須 param 欠落は bad_params になること
//   (5) 制御 verb と status は OS2_TOPLEVEL_RPC_OPS から生成されないこと (既存テストと合わせた整合)
// を固定する。
//
// 手本: tests/serve/ble-toplevel-rpc-generated.test.js の OS2 セクション
//        / tests/serve/ble-rpc-generated.test.js (invokePath 結線確認パターン)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildRegistry } from "../../src/serve/registry.js";
import { stabilityOf } from "../../src/serve/stability.js";
import { SesameOS2Ble } from "../../src/ble/index.js";

const daemon = { authState: "ok", hub: { connected: true } };

// OS2 対象指定 (keyIndex / ssmPublicKey は os2UseRun の need() が要求する)。
const OS2_TARGET = {
  secretKey: "00".repeat(16),
  keyIndex: "0000",
  ssmPublicKey: "11".repeat(64),
  deviceUUID: "U-os2",
  model: "sesame_3",
};

/** SesameOS2Ble.use を乗っ取り、fake facade を fn へ渡す。 */
function stubOs2(fake) {
  return vi.spyOn(SesameOS2Ble, "use").mockImplementation(async (_opts, fn) => fn(fake));
}

const ackResp = () => ({ resultCode: 0, payload: Buffer.alloc(0) });

describe("P4-5: 生成された OS2 管理系 ble.os2.reset / ble.os2.configureLockPosition", () => {
  let reg;
  beforeEach(() => { reg = buildRegistry(); });
  afterEach(() => { vi.restoreAllMocks(); });

  // --- 登録・experimental 確認 ---

  it("ble.os2.reset が registry に登録され experimental", () => {
    expect(reg.get("ble.os2.reset"), "ble.os2.reset が未登録").toBeTruthy();
    expect(stabilityOf("ble.os2.reset")).toBe("experimental");
  });

  it("ble.os2.configureLockPosition が registry に登録され experimental", () => {
    expect(reg.get("ble.os2.configureLockPosition"), "ble.os2.configureLockPosition が未登録").toBeTruthy();
    expect(stabilityOf("ble.os2.configureLockPosition")).toBe("experimental");
  });

  // --- ble.os2.reset の結線 ---

  it("ble.os2.reset は引数なしでファサード reset() を呼び ack を返す", async () => {
    // SesameOS2Ble.reset() の移植元: CHSesame2Device.kt:570-578 (OP.delete, ITEM.REGISTRATION)。
    const reset = vi.fn(async () => ackResp());
    stubOs2({ reset });
    const r = await reg.get("ble.os2.reset").handler({ hub: {}, daemon, params: { ...OS2_TARGET } });
    expect(reset).toHaveBeenCalledWith();
    expect(r).toMatchObject({ resultCode: 0, resultName: expect.any(String) });
  });

  // --- ble.os2.configureLockPosition の結線 ---

  it("ble.os2.configureLockPosition は (lockDeg, unlockDeg) の順で位置引数化し ack を返す", async () => {
    // SesameOS2Ble.configureLockPosition(lockDeg, unlockDeg) の移植元:
    // CHSesame2Device.kt:556-568 (OP.update, ITEM.mechSetting, lockPositionConfiguration(deg))。
    const configureLockPosition = vi.fn(async () => ackResp());
    stubOs2({ configureLockPosition });
    const r = await reg.get("ble.os2.configureLockPosition").handler({
      hub: {}, daemon, params: { ...OS2_TARGET, lockDeg: 90, unlockDeg: -90 },
    });
    expect(configureLockPosition).toHaveBeenCalledWith(90, -90);
    expect(r).toMatchObject({ resultCode: 0, resultName: expect.any(String) });
  });

  it("ble.os2.configureLockPosition は lockDeg 欠落で bad_params (必須引数)", async () => {
    stubOs2({ configureLockPosition: vi.fn() });
    await expect(
      reg.get("ble.os2.configureLockPosition").handler({
        hub: {}, daemon, params: { ...OS2_TARGET, unlockDeg: -90 },
      }),
    ).rejects.toMatchObject({ name: "RpcError", kind: "bad_params" });
  });

  it("ble.os2.configureLockPosition は unlockDeg 欠落で bad_params (必須引数)", async () => {
    stubOs2({ configureLockPosition: vi.fn() });
    await expect(
      reg.get("ble.os2.configureLockPosition").handler({
        hub: {}, daemon, params: { ...OS2_TARGET, lockDeg: 90 },
      }),
    ).rejects.toMatchObject({ name: "RpcError", kind: "bad_params" });
  });

  it("lockDeg=0 は有効値 (0 は bad_params にならない)", async () => {
    // 0 度は有効な角度。bleOpEntries は undefined/null のみ欠落扱い (0/false は通す)。
    const configureLockPosition = vi.fn(async () => ackResp());
    stubOs2({ configureLockPosition });
    const r = await reg.get("ble.os2.configureLockPosition").handler({
      hub: {}, daemon, params: { ...OS2_TARGET, lockDeg: 0, unlockDeg: 180 },
    });
    expect(configureLockPosition).toHaveBeenCalledWith(0, 180);
    expect(r).toMatchObject({ resultCode: 0 });
  });

  // --- spec が registry に乗ることの整合 ---

  it("OS2_TOPLEVEL_RPC_OPS の reset / configureLockPosition キーが OS2_BLE_RPC_OPS に含まれる", async () => {
    // 生成物 (schema/openrpc.json 等) は統括が npm run build で再生成するため直接検査しないが、
    // spec の registry 経路への結線がここで確認できる。
    const { OS2_BLE_RPC_OPS } = await import("../../src/ble/index.js");
    expect(Object.keys(OS2_BLE_RPC_OPS)).toContain("reset");
    expect(Object.keys(OS2_BLE_RPC_OPS)).toContain("configureLockPosition");
  });

  it("OS2_BLE_RPC_ALLOWLIST に reset / configureLockPosition が掲載済み", async () => {
    // allowlist は既存から掲載済み。この assert は P4-5 後の状態を固定する回帰ガード。
    const { OS2_BLE_RPC_ALLOWLIST } = await import("../../src/ble/index.js");
    expect(OS2_BLE_RPC_ALLOWLIST).toContain("reset");
    expect(OS2_BLE_RPC_ALLOWLIST).toContain("configureLockPosition");
  });
});
