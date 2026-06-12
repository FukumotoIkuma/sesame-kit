// mechSetting 角度キャリブレーション + 基盤コマンド (time/versionTag/history/adv) の単体テスト。
// 原典 SDK のバイト列・分岐に対する 1:1 移植であることを既知ベクタで確認する。
import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import {
  configureLockPositionData, parseMechSetting, parseOpsSetting,
  timeSyncData, parseDeviceTimeSeconds, needsTimeSync,
  historyReadData, historyDeleteData,
} from "../../src/ble/protocol.js";
import { parseAdvertisement, advToDeviceUUID } from "../../src/ble/transport.js";

describe("configureLockPositionData (CHSesame5Device.kt:69-73)", () => {
  it("lockTarget/unlockTarget を LE 2B ずつ連結する", () => {
    // 256 = 0x0100 → LE 0001、-256 = 0xFF00 → LE 00ff
    expect(configureLockPositionData(256, -256).toString("hex")).toBe("000100ff");
  });
  it("範囲外は throw", () => {
    expect(() => configureLockPositionData(40000, 0)).toThrow();
    expect(() => configureLockPositionData(0, -40000)).toThrow();
  });
});

describe("parseMechSetting (CHSesame5MechSettings, CHSesame5.kt:34-38)", () => {
  it("lock/unlock/autoLock を i16 LE で読む", () => {
    const buf = Buffer.from("000100ff7800", "hex"); // lock=256, unlock=-256, auto=120
    expect(parseMechSetting(buf)).toEqual({ lockPosition: 256, unlockPosition: -256, autoLockSecond: 120 });
  });
  it("6B 未満は throw", () => {
    expect(() => parseMechSetting(Buffer.alloc(5))).toThrow();
  });
});

describe("parseOpsSetting (CHSesame5OpsSettings, CHSesame5.kt:40-42)", () => {
  it("opsLockSecond を u16 LE で読む", () => {
    expect(parseOpsSetting(Buffer.from("2c01", "hex"))).toEqual({ opsLockSecond: 300 });
  });
});

describe("time 同期 (CHSesameOS3LockBase.kt:126-138 / DataExtention.kt:138-147)", () => {
  it("timeSyncData は秒値の下位32bitを LE 4B (既知ベクタ fa89b85f)", () => {
    expect(timeSyncData(1605929466482).toString("hex")).toBe("fa89b85f");
  });
  it("parseDeviceTimeSeconds は payload[0..3] を LE u32 (秒)", () => {
    expect(parseDeviceTimeSeconds(Buffer.from("fa89b85f", "hex"))).toBe(1605929466);
    expect(parseDeviceTimeSeconds(Buffer.alloc(3))).toBeNull();
  });
  it("needsTimeSync は差 >3 秒で true", () => {
    const now = Date.now();
    expect(needsTimeSync(Math.floor(now / 1000), now)).toBe(false);
    expect(needsTimeSync(Math.floor(now / 1000) - 2, now)).toBe(false); // 差2秒は許容
    expect(needsTimeSync(Math.floor(now / 1000) - 10, now)).toBe(true);
  });
});

describe("history (CHSesameOS3LockBase.kt:185-209)", () => {
  it("historyReadData = [0x01]", () => {
    expect(historyReadData().toString("hex")).toBe("01");
  });
  it("historyDeleteData = payload[0..3] (recordId)", () => {
    expect(historyDeleteData(Buffer.from("11223344aabb", "hex")).toString("hex")).toBe("11223344");
  });
  it("4B 未満の payload は throw", () => {
    expect(() => historyDeleteData(Buffer.from("1122", "hex"))).toThrow();
  });
});

describe("parseAdvertisement (Sesame2BleAdvertisement.kt CHadv 全機種)", () => {
  it("SS5: productType + 16B deviceID + registered/b1 フラグ", () => {
    // md = [5a 05][05=ss5][00][03=registered+b1][16B id]
    const id16 = "0102030405060708090a0b0c0d0e0f10";
    const md = Buffer.from("5a05" + "05" + "00" + "03" + id16, "hex");
    const adv = parseAdvertisement(md);
    expect(adv.productType).toBe(5);
    expect(adv.model).toBe("sesame_5");
    expect(adv.kind).toBe("lock5");
    expect(adv.isRegistered).toBe(true);
    expect(adv.advTagB1).toBe(true);
    expect(adv.deviceUUID).toBe("01020304-0506-0708-090a-0b0c0d0e0f10");
  });

  it("Hub3: registered は advBytes[1]、deviceID は advBytes[2..8) を prefix に連結", () => {
    // md = [5a 05][0d=hub3][01=registered][6B id]
    const md = Buffer.from("5a05" + "0d" + "01" + "0d00aabbccdd", "hex");
    const adv = parseAdvertisement(md);
    expect(adv.model).toBe("hub_3");
    expect(adv.isRegistered).toBe(true);
    expect(adv.deviceUUID).toBe("00000000-055a-fd81-0d00-0d00aabbccdd");
  });

  it("WM2: deviceID は advBytes[3..9)、last()==0 で connectable", () => {
    // md = [5a 05][01=wm2][00][00][6B id (末尾0)]
    const md = Buffer.from("5a05" + "01" + "00" + "00" + "112233445500", "hex");
    const adv = parseAdvertisement(md);
    expect(adv.model).toBe("wm_2");
    expect(adv.kind).toBe("wifi");
    expect(adv.isConnectable).toBe(true);
    expect(adv.deviceUUID).toBe("00000000-055a-fd81-0001-112233445500");
  });

  it("WM2: last()!=0 で not connectable", () => {
    const md = Buffer.from("5a05" + "01" + "00" + "00" + "112233445501", "hex");
    expect(parseAdvertisement(md).isConnectable).toBe(false);
  });

  it("company ID 不一致は null / 短すぎは null", () => {
    expect(parseAdvertisement(Buffer.from("ffff050000", "hex"))).toBeNull();
    expect(parseAdvertisement(Buffer.from("5a05", "hex"))).toBeNull();
    expect(parseAdvertisement(null)).toBeNull();
  });

  it("advToDeviceUUID は parseAdvertisement の deviceUUID を返す (後方互換)", () => {
    const id16 = "112004230300020732000101ffffffff";
    const md = Buffer.from("5a05" + "05" + "00" + "00" + id16, "hex");
    expect(advToDeviceUUID(md)).toBe("11200423-0300-0207-3200-0101ffffffff");
  });
});
