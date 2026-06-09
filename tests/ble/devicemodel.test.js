// デバイス型モデル (SDK CHProductModel 移植) の単体テスト。
import { describe, it, expect } from "vitest";
import {
  KIND, PRODUCT_TYPES, kindForModel, capabilitiesForModel, supportsOp, CONTROL_OPS,
} from "../../src/ble/devicemodel.js";

describe("CONTROL_OPS (制御 op 語彙の単一真実源)", () => {
  it("CAPS から導出され lock/unlock/toggle/click/autolock になる", () => {
    expect(CONTROL_OPS).toEqual(["lock", "unlock", "toggle", "click", "autolock"]);
  });
  it("IoT 中継 op (ir/relay/led) と status は含まない", () => {
    for (const o of ["ir", "relay", "led", "status"]) expect(CONTROL_OPS).not.toContain(o);
  });
  it("全 kind の各制御 op が CONTROL_OPS に含まれる (導出の網羅性)", () => {
    for (const m of ["sesame_5", "bot_2", "bike_2", "bike_3", "sesame_2", "ssmbot_1", "bike_1"]) {
      for (const op of capabilitiesForModel(m).ops) {
        if (["ir", "relay", "led"].includes(op)) continue;
        expect(CONTROL_OPS).toContain(op);
      }
    }
  });
  it("凍結されている (誤改変を防ぐ)", () => {
    expect(Object.isFrozen(CONTROL_OPS)).toBe(true);
  });
});

describe("kindForModel", () => {
  it("OS3 ロックは lock5", () => {
    for (const m of ["sesame_5", "sesame_5_pro", "sesame_6", "sesame_6_pro", "sesame_5_us", "sesame_miwa", "BLE_Connector_1"]) {
      expect(kindForModel(m)).toBe(KIND.LOCK5);
    }
  });
  it("Bot2/Bot3 は bot2、Bike2 は bike2、Bike3 は bike3 (指紋固有型)", () => {
    expect(kindForModel("bot_2")).toBe(KIND.BOT2);
    expect(kindForModel("bot_3")).toBe(KIND.BOT2);
    expect(kindForModel("bike_2")).toBe(KIND.BIKE2);
    // Bike3 は CHSesameBike3Device : CHSesameBike2Device(), CHFingerPrintCapable で
    // 指紋 capability を足した固有型なので Bike2 と同一視せず別 kind。
    expect(kindForModel("bike_3")).toBe(KIND.BIKE3);
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
  it("OS2 ロックは cloud + BLE (SesameOS2Ble) で操作可", () => {
    const c = capabilitiesForModel("sesame_2");
    expect(c.ble).toEqual(["lock", "unlock", "toggle", "autolock"]); // OS2 BLE 直接制御 (autolock 含む)
    expect(c.cloud).toEqual(["lock", "unlock", "toggle"]);
    // 和集合 = ble (lock/unlock/toggle/autolock) + cloud 固有 (なし)。autolock は BLE 専用。
    expect(c.ops).toEqual(["lock", "unlock", "toggle", "autolock"]);
    expect(c.bleSupported).toBe(true);
  });
  it("Bike2 = unlock のみ (指紋なし)、Bike3 = unlock + fingerprint", () => {
    const b2 = capabilitiesForModel("bike_2");
    expect(b2.ble).toEqual(["unlock"]);
    expect(b2.ops).toEqual(["unlock"]);
    expect(b2.fingerprint).toBe(false); // Bike2 は CHFingerPrintCapable を持たない
    const b3 = capabilitiesForModel("bike_3");
    expect(b3.kind).toBe(KIND.BIKE3);
    expect(b3.ble).toEqual(["unlock"]);   // 解錠能力は Bike2 を継承
    expect(b3.ops).toEqual(["unlock"]);
    expect(b3.fingerprint).toBe(true);    // 指紋登録 API のみ追加で持つ
    expect(b3.biometric).toBe(false);     // card/passcode/face/palm は持たない (指紋専用)
    expect(b3.mechKind).toBe("os3bot");   // mechStatus 解釈は Bike2 と同じ 3B
  });
  it("OS2 Bot1 = click / Bike1 = unlock (ble+cloud)", () => {
    expect(capabilitiesForModel("ssmbot_1").ble).toEqual(["click"]);
    expect(capabilitiesForModel("ssmbot_1").ops).toEqual(["click"]);
    expect(capabilitiesForModel("bike_1").ble).toEqual(["unlock"]);
    expect(capabilitiesForModel("bike_1").ops).toEqual(["unlock"]);
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
    expect(transportsForOp("sesame_2", "lock").sort()).toEqual(["ble", "cloud"]); // OS2 lock は ble+cloud
    expect(transportsForOp("sesame_2", "autolock")).toEqual(["ble"]);          // OS2 autolock も BLE 専用
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
    // OS2 系の代表キーだけでなく ITEM_CODES 全件を走査し、OS3 で追加された
    // CARD_*/FINGERPRINT_*/PASSCODE_*/FACE_*/PALM_* / ADD_SESAME 等も
    // CMD ≡ ITEM ≡ ITEM_CODES の不変条件が崩れないことを担保する。
    for (const k of Object.keys(ITEM_CODES)) {
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
    expect(PRODUCT_TYPES[33].model).toBe("bike_3");
    expect(PRODUCT_TYPES[33].kind).toBe(KIND.BIKE3); // Bike3 は固有 kind (指紋)
    expect(PRODUCT_TYPES[6].kind).toBe(KIND.BIKE2);  // Bike2 は従来どおり
    expect(PRODUCT_TYPES[13].model).toBe("hub_3");
    expect(PRODUCT_TYPES[10].model).toBe("ssm_touch");
  });
  it("pType 12 は欠番", () => {
    expect(PRODUCT_TYPES[12]).toBeUndefined();
  });
});
