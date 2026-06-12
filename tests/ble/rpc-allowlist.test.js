// BLE RPC 公開面 allowlist (P4-1 段階3 / P4-2) の整合テスト。
//
// BLE_RPC_ALLOWLIST / OS2_BLE_RPC_ALLOWLIST は serve の invokePath が fail-closed 照合に使う
// 「ファサードの意図的公開面」の単一の真実。ここでは
//   (1) 表の全名が実ファサードに実在する (typo / リネーム漏れで op が無言で死ぬのを防ぐ)
//   (2) 接続ライフサイクル・登録系・購読 API が表に**載っていない** (fail-closed の意図を固定)
// を固定する。
import { describe, it, expect } from "vitest";
import {
  SesameBle, SesameOS2Ble, BLE_RPC_ALLOWLIST, OS2_BLE_RPC_ALLOWLIST,
} from "../../src/ble/index.js";

/** 接続しないダミー transport (コンストラクタ要求を満たすだけ)。 */
const fakeTransport = {
  connect: async () => {},
  write: () => {},
  disconnect: async () => {},
};

describe("BLE_RPC_ALLOWLIST (OS3 SesameBle)", () => {
  // registerMode: secretKey 無しで構築できる (公開面の存在確認に login は不要)。
  const ble = new SesameBle({ registerMode: true, model: "sesame_5", transport: fakeTransport });

  it("表の全名が SesameBle ファサードに実在する (getter 実行はしない)", () => {
    for (const name of BLE_RPC_ALLOWLIST) {
      // `in` は getter を実行せずに存在確認できる (biometric 等は機種ガードで throw するため)。
      expect(name in ble, `BLE_RPC_ALLOWLIST の "${name}" が SesameBle に存在しない`).toBe(true);
    }
  });

  it("接続ライフサイクル・登録・購読 API は載っていない (fail-closed の意図)", () => {
    for (const name of ["connect", "close", "use", "register", "registerOnce", "connectMany", "listNearby", "fromDiscovery", "onStatus", "constructor"]) {
      expect(BLE_RPC_ALLOWLIST).not.toContain(name);
    }
  });

  it("意図的公開面の代表 op を網羅している", () => {
    for (const name of [
      "lock", "unlock", "click", "toggle", "autolock", "status",
      "history", "deleteHistory", "getVersionTag", "reset", "updateFirmware",
      "setBleTxPower", "configureLockPosition", "magnet", "opSensorControl", "sendAdvProductType",
      "biometric", "fingerPrint", "remoteNano", "script", "wifi", "hub3",
    ]) {
      expect(BLE_RPC_ALLOWLIST).toContain(name);
    }
  });
});

describe("OS2_BLE_RPC_ALLOWLIST (SesameOS2Ble)", () => {
  const ble = new SesameOS2Ble({ registerMode: true, model: "sesame_3", transport: fakeTransport });

  it("表の全名が SesameOS2Ble ファサードに実在する", () => {
    for (const name of OS2_BLE_RPC_ALLOWLIST) {
      expect(name in ble, `OS2_BLE_RPC_ALLOWLIST の "${name}" が SesameOS2Ble に存在しない`).toBe(true);
    }
  });

  it("接続ライフサイクル・登録・購読 API は載っていない", () => {
    for (const name of ["connect", "close", "use", "register", "registerOnce", "onStatus", "constructor"]) {
      expect(OS2_BLE_RPC_ALLOWLIST).not.toContain(name);
    }
  });

  it("意図的公開面の代表 op を網羅している", () => {
    for (const name of [
      "lock", "unlock", "click", "toggle", "autolock", "disableAutolock", "getAutolock",
      "status", "history", "versionTag", "reset", "configureLockPosition", "updateSetting", "updateFirmware",
    ]) {
      expect(OS2_BLE_RPC_ALLOWLIST).toContain(name);
    }
  });
});
