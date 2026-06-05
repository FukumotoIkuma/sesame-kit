// デバイス型モデル (SDK CHProductModel 移植) の単体テスト。
import { describe, it, expect } from "vitest";
import {
  KIND, PRODUCT_TYPES, kindForModel, capabilitiesForModel, supportsOp,
} from "../../src/ble/devicemodel.js";

describe("kindForModel", () => {
  it("OS3 ロックは lock5", () => {
    for (const m of ["sesame_5", "sesame_5_pro", "sesame_6", "sesame_6_pro", "sesame_5_us", "sesame_miwa", "BLE_Connector_1"]) {
      expect(kindForModel(m)).toBe(KIND.LOCK5);
    }
  });
  it("Bot2/Bot3 は bot2、Bike2/Bike3 は bike2", () => {
    expect(kindForModel("bot_2")).toBe(KIND.BOT2);
    expect(kindForModel("bot_3")).toBe(KIND.BOT2);
    expect(kindForModel("bike_2")).toBe(KIND.BIKE2);
    expect(kindForModel("bike_3")).toBe(KIND.BIKE2);
  });
  it("OS2 系は sesame2/botOs2/bikeOs2", () => {
    expect(kindForModel("sesame_2")).toBe(KIND.SESAME2);
    expect(kindForModel("sesame_4")).toBe(KIND.SESAME2);
    expect(kindForModel("ssmbot_1")).toBe(KIND.BOT_OS2);
    expect(kindForModel("bike_1")).toBe(KIND.BIKE_OS2);
  });
  it("Touch/Face/Sensor/Remote は biometric、Hub3 は hub3、WM2 は wifi", () => {
    expect(kindForModel("ssm_touch")).toBe(KIND.BIOMETRIC);
    expect(kindForModel("sesame_face")).toBe(KIND.BIOMETRIC);
    expect(kindForModel("open_sensor_1")).toBe(KIND.BIOMETRIC);
    expect(kindForModel("remote")).toBe(KIND.BIOMETRIC);
    expect(kindForModel("hub_3")).toBe(KIND.HUB3);
    expect(kindForModel("wm_2")).toBe(KIND.WIFI);
  });
  it("未指定 (null) は lock5 (facade/旧 config 互換)、未知の文字列は UNKNOWN (lock を捏造しない)", () => {
    expect(kindForModel(null)).toBe(KIND.LOCK5);
    expect(kindForModel(undefined)).toBe(KIND.LOCK5);
    expect(kindForModel("unknown_xyz")).toBe(KIND.UNKNOWN); // 未知機種を勝手にロック扱いしない
  });
});

describe("capabilitiesForModel / supportsOp (型×経路の和集合)", () => {
  it("Sesame5: ble=lock/unlock/toggle/autolock, cloud=lock/unlock/toggle, ops=和集合, 7B mech", () => {
    const c = capabilitiesForModel("sesame_5");
    expect(c.ble).toEqual(["lock", "unlock", "toggle", "autolock"]);
    expect(c.cloud).toEqual(["lock", "unlock", "toggle"]);
    expect(c.ops).toEqual(["lock", "unlock", "toggle", "autolock"]); // 和集合 (ble 先)
    expect(c.mechKind).toBe("os3lock");
    expect(c.bleSupported).toBe(true);
  });
  it("Bot2 = click のみ (ble+cloud)", () => {
    const c = capabilitiesForModel("bot_2");
    expect(c.ops).toEqual(["click"]);
    expect(supportsOp("bot_2", "click")).toBe(true);
    expect(supportsOp("bot_2", "lock")).toBe(false);
  });
  it("OS2 ロックは cloud のみ操作可 (BLE 未実装)", () => {
    const c = capabilitiesForModel("sesame_2");
    expect(c.ble).toEqual([]);
    expect(c.cloud).toEqual(["lock", "unlock", "toggle"]);
    expect(c.ops).toEqual(["lock", "unlock", "toggle"]); // cloud だけでも操作可能 = 和集合に出る
    expect(c.bleSupported).toBe(false);
  });
  it("Hub3 は cloud で ir/relay/led", () => {
    const c = capabilitiesForModel("hub_3");
    expect(c.cloud).toEqual(["ir", "relay", "led"]);
    expect(c.ble).toEqual([]);
    expect(c.ops).toEqual(["ir", "relay", "led"]);
  });
  it("Touch/Face/Sensor/Remote は操作不可 (ops 空)", () => {
    for (const m of ["ssm_touch", "sesame_face", "open_sensor_1", "remote"]) {
      expect(capabilitiesForModel(m).ops).toEqual([]);
    }
  });
});

describe("transportsForOp (型×op→経路) / isOperable", () => {
  it("型ごとに op の経路が変わる", async () => {
    const { transportsForOp, isOperable } = await import("../../src/ble/devicemodel.js");
    expect(transportsForOp("sesame_5", "autolock")).toEqual(["ble"]);          // ロックの autolock は BLE 専用
    expect(transportsForOp("sesame_5", "lock").sort()).toEqual(["ble", "cloud"]);
    expect(transportsForOp("sesame_2", "lock")).toEqual(["cloud"]);            // OS2 は cloud のみ
    expect(transportsForOp("hub_3", "ir")).toEqual(["cloud"]);                 // Hub3 IR は cloud
    expect(transportsForOp("sesame_5", "ir")).toEqual([]);                     // ロックに ir は無い
    expect(isOperable("sesame_2")).toBe(true);   // cloud で操作可
    expect(isOperable("ssm_touch")).toBe(false); // 操作不可
  });
});

describe("itemCode 一本化 (CMD === ITEM)", () => {
  it("クラウド CMD と BLE ITEM は同一の正準ソースを指す", async () => {
    const { CMD } = await import("../../src/crypto.js");
    const { ITEM } = await import("../../src/ble/protocol.js");
    const { ITEM_CODES } = await import("../../src/itemcodes.js");
    for (const k of ["AUTOLOCK", "LOCK", "UNLOCK", "TOGGLE", "CLICK", "MECH_STATUS"]) {
      expect(CMD[k]).toBe(ITEM_CODES[k]);
      expect(ITEM[k]).toBe(ITEM_CODES[k]);
    }
    expect(CMD.LOCK).toBe(82);
    expect(CMD.CLICK).toBe(89); // 旧 BOT_CLICK
  });
});

describe("PRODUCT_TYPES", () => {
  it("主要 productType→model が SDK 値と一致", () => {
    expect(PRODUCT_TYPES[5].model).toBe("sesame_5");
    expect(PRODUCT_TYPES[7].model).toBe("sesame_5_pro");
    expect(PRODUCT_TYPES[17].model).toBe("bot_2");
    expect(PRODUCT_TYPES[35].model).toBe("bot_3");
    expect(PRODUCT_TYPES[13].model).toBe("hub_3");
    expect(PRODUCT_TYPES[10].model).toBe("ssm_touch");
  });
  it("pType 12 は欠番", () => {
    expect(PRODUCT_TYPES[12]).toBeUndefined();
  });
});
