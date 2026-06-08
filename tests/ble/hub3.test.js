// SESAME Hub3 BLE コアの単体テスト (純 JS、ハードウェア不要)。
// 移植元 CHHub3Device.kt のバイト列・分岐・itemCode を assert する。
import { describe, it, expect, vi } from "vitest";
import { Buffer } from "node:buffer";
import {
  scanWifiSSIDData, setWifiSSIDData, setWifiPasswordData, removeSesameData, networkTypeData,
  parseScanWifiSSID, parseNetworkType, parseMechSetting, parseSesameKeys, parseHub3Publish,
  Hub3Commands,
} from "../../src/ble/hub3.js";
import { ITEM_CODES } from "../../src/itemcodes.js";
import { capabilitiesForModel } from "../../src/ble/devicemodel.js";

describe("itemcodes: Hub3 固有 (SesameProtocols.kt:40,52)", () => {
  it("131-136 / 208-209 が SDK 値と一致", () => {
    expect(ITEM_CODES.HUB3_ITEM_CODE_WIFI_SSID).toBe(131);
    expect(ITEM_CODES.HUB3_ITEM_CODE_SSID_FIRST).toBe(132);
    expect(ITEM_CODES.HUB3_ITEM_CODE_SSID_NOTIFY).toBe(133);
    expect(ITEM_CODES.HUB3_ITEM_CODE_SSID_LAST).toBe(134);
    expect(ITEM_CODES.HUB3_ITEM_CODE_WIFI_PASSWORD).toBe(135);
    expect(ITEM_CODES.HUB3_UPDATE_WIFI_SSID).toBe(136);
    expect(ITEM_CODES.HUB3_ITEM_CODE_RELAY_SWITCH).toBe(208);
    expect(ITEM_CODES.HUB3_ITEM_CODE_NETWORK_TYPE).toBe(209);
  });
});

describe("devicemodel: Hub3 の能力", () => {
  it("hub3 は ble[] 空・cloud は ir/relay/led・hubProvisioning=true (WM2 と同型)", () => {
    const c = capabilitiesForModel("hub_3");
    expect(c.ble).toEqual([]);              // BLE 施錠制御 op は無い (SDK と同じ)
    expect(c.cloud).toEqual(["ir", "relay", "led"]);
    expect(c.hubProvisioning).toBe(true);   // 新フラグ (Wi-Fi プロビジョニング API を持つ)
    expect(c.wifiProvisioning).toBe(false); // WM2 専用フラグは false (GATT は既定 GATT)
    expect(capabilitiesForModel("hub_3_lte").hubProvisioning).toBe(true);
    // 非 Hub3 は false
    expect(capabilitiesForModel("sesame_5").hubProvisioning).toBe(false);
    expect(capabilitiesForModel("wm_2").hubProvisioning).toBe(false);
  });
});

describe("コマンド data 生成 (CHHub3Device.kt)", () => {
  it("scanWifiSSID / networkType は空 data", () => {
    expect(scanWifiSSIDData().length).toBe(0); // kt:241 byteArrayOf()
    expect(networkTypeData().length).toBe(0);
  });

  it("setWifiSSID = SSID の UTF-8 bytes (kt:256)", () => {
    expect(setWifiSSIDData("MyＳＳＩＤ").equals(Buffer.from("MyＳＳＩＤ", "utf8"))).toBe(true);
    expect(() => setWifiSSIDData("")).toThrow();
  });

  it("setWifiPassword = password の UTF-8 bytes (空文字許容) (kt:247)", () => {
    expect(setWifiPasswordData("p@ss").equals(Buffer.from("p@ss", "utf8"))).toBe(true);
    expect(setWifiPasswordData("").length).toBe(0);
    expect(() => setWifiPasswordData(123)).toThrow();
  });

  it("removeSesame = dash 除去 UUID(32hex) を decode した生 16B (kt:230-232)", () => {
    // WM2 (大文字 UTF-8) とは異なり、Hub3 は noDashUUID.hexStringToByteArray() = 生バイト。
    const uuid = "0179c43c-9a0e-49e5-9d69-6a22a6fe7a6e";
    const d = removeSesameData(uuid);
    expect(d.length).toBe(16);
    expect(d.equals(Buffer.from(uuid.replace(/-/g, ""), "hex"))).toBe(true);
    // dash なしでも同じ結果
    expect(removeSesameData(uuid.replace(/-/g, "")).equals(d)).toBe(true);
    expect(() => removeSesameData("")).toThrow();
  });
});

describe("publish 解析 (onGattSesamePublish, kt:268-340)", () => {
  it("SSID_NOTIFY: rssi(LE signed short) + ssid (kt:322-326)", () => {
    const buf = Buffer.concat([Buffer.from([0xce, 0xff]), Buffer.from("HomeWiFi", "utf8")]);
    expect(parseScanWifiSSID(buf)).toEqual({ rssi: -50, ssid: "HomeWiFi" });
  });

  it("NETWORK_TYPE: payload[0]=wifi, payload[1]=lte (==1 で接続) (kt:328-333)", () => {
    expect(parseNetworkType(Buffer.from([1, 0]))).toEqual({ isWifiConnected: true, isLTEConnected: false });
    expect(parseNetworkType(Buffer.from([0, 1]))).toEqual({ isWifiConnected: false, isLTEConnected: true });
    expect(parseNetworkType(Buffer.from([1, 1]))).toEqual({ isWifiConnected: true, isLTEConnected: true });
    // 1 以外 (例 2) は false
    expect(parseNetworkType(Buffer.from([2, 2]))).toEqual({ isWifiConnected: false, isLTEConnected: false });
    expect(() => parseNetworkType(Buffer.from([1]))).toThrow();
  });

  it("mechSetting: 旧ファーム(60B)は SSID[0..29]/PW[30..59] (kt:273-277)", () => {
    const ssid = "myssid";
    const pwd = "mypassword";
    const buf = Buffer.alloc(60); // < 96 → 旧ファーム経路
    Buffer.from(ssid, "utf8").copy(buf, 0);
    Buffer.from(pwd, "utf8").copy(buf, 30);
    expect(parseMechSetting(buf)).toEqual({ wifiSSID: ssid, wifiPassWord: pwd });
  });

  it("mechSetting: 新ファーム(96B)は SSID[0..31]/PW[32..95] (kt:278-283)", () => {
    const ssid = "myssid32";
    const pwd = "longerpassword";
    const buf = Buffer.alloc(96); // >= 96 → 新ファーム経路
    Buffer.from(ssid, "utf8").copy(buf, 0);
    Buffer.from(pwd, "utf8").copy(buf, 32);
    expect(parseMechSetting(buf)).toEqual({ wifiSSID: ssid, wifiPassWord: pwd });
  });

  it("mechSetting: 末尾の 0x00 と '?' を trim する (trimEnd(0, '?'))", () => {
    const buf = Buffer.alloc(60);
    Buffer.from("ssid??", "utf8").copy(buf, 0); // 末尾 '?' は trim 対象
    Buffer.from("pw", "utf8").copy(buf, 30);
    const r = parseMechSetting(buf);
    expect(r.wifiSSID).toBe("ssid");
    expect(r.wifiPassWord).toBe("pw");
  });

  it("PUB_KEY_SESAME: 23B チャンク, status!=0 のみ {deviceUUID, index} (kt:299-314)", () => {
    const uuid = "0179c43c-9a0e-49e5-9d69-6a22a6fe7a6e";
    const id16 = Buffer.from(uuid.replace(/-/g, ""), "hex"); // 16B 生 UUID
    // 1 エントリ = [id16][6B 任意][status 1B] = 23B
    const mk = (status) => Buffer.concat([id16, Buffer.alloc(6), Buffer.from([status])]);
    const payload = Buffer.concat([mk(1), mk(0), mk(2)]); // index 0=有効, 1=除外, 2=有効
    const keys = parseSesameKeys(payload);
    // index は全エントリで採番 (forEachIndexed)。status!=0 のみ残す。
    expect(keys).toEqual([
      { deviceUUID: uuid, index: 0 },
      { deviceUUID: uuid, index: 2 },
    ]);
  });

  it("PUB_KEY_SESAME: 端数 (23B 未満) は無視", () => {
    expect(parseSesameKeys(Buffer.alloc(10))).toEqual([]);
  });

  it("parseHub3Publish のディスパッチ", () => {
    expect(parseHub3Publish({ itemCode: ITEM_CODES.HUB3_ITEM_CODE_SSID_NOTIFY, body: Buffer.concat([Buffer.from([0xce, 0xff]), Buffer.from("x", "utf8")]) }).kind).toBe("scanWifiSSID");
    expect(parseHub3Publish({ itemCode: ITEM_CODES.HUB3_ITEM_CODE_NETWORK_TYPE, body: Buffer.from([1, 0]) })).toEqual({ kind: "networkType", isWifiConnected: true, isLTEConnected: false });
    expect(parseHub3Publish({ itemCode: ITEM_CODES.MOVE_TO, body: Buffer.from([42]) })).toEqual({ kind: "otaProgress", progress: 42 });
    expect(parseHub3Publish({ itemCode: ITEM_CODES.MECH_SETTING, body: Buffer.alloc(60) }).kind).toBe("mechSetting");
    expect(parseHub3Publish({ itemCode: ITEM_CODES.PUB_KEY_SESAME, body: Buffer.alloc(0) }).kind).toBe("sesameKeys");
    // SSID_FIRST / SSID_LAST はマーカー (SDK は no-op)
    expect(parseHub3Publish({ itemCode: ITEM_CODES.HUB3_ITEM_CODE_SSID_FIRST, body: Buffer.alloc(0) }).kind).toBe("ssidMarker");
    expect(parseHub3Publish({ itemCode: ITEM_CODES.HUB3_ITEM_CODE_SSID_LAST, body: Buffer.alloc(0) }).kind).toBe("ssidMarker");
    expect(parseHub3Publish({ itemCode: 99, body: Buffer.alloc(0) }).kind).toBe("unknown");
  });
});

describe("Hub3Commands ファサード (session 注入)", () => {
  function fakeSession() {
    const publishListeners = new Set();
    return {
      request: vi.fn(() => Promise.resolve({ resultCode: 0, payload: Buffer.alloc(0) })),
      disconnect: vi.fn(() => Promise.resolve()),
      onPublish(fn) { publishListeners.add(fn); return () => publishListeners.delete(fn); },
      _emit(pub) { for (const fn of publishListeners) fn(pub); },
    };
  }

  it("各コマンドが正しい itemCode + data で request する (SesameItemCode 直)", async () => {
    const s = fakeSession();
    const hub = new Hub3Commands({ session: s });
    const uuid = "0179c43c-9a0e-49e5-9d69-6a22a6fe7a6e";
    await hub.scanWifiSSID();
    await hub.setWifiSSID("net");
    await hub.setWifiPassword("pw");
    await hub.removeSesame(uuid);
    await hub.networkType();

    const calls = s.request.mock.calls.map((c) => c[0]);
    expect(calls).toEqual([
      ITEM_CODES.HUB3_ITEM_CODE_WIFI_SSID,
      ITEM_CODES.HUB3_UPDATE_WIFI_SSID,
      ITEM_CODES.HUB3_ITEM_CODE_WIFI_PASSWORD,
      ITEM_CODES.REMOVE_SESAME,
      ITEM_CODES.HUB3_ITEM_CODE_NETWORK_TYPE,
    ]);
    // removeSesame の data = 生 16B
    const rmCall = s.request.mock.calls.find((c) => c[0] === ITEM_CODES.REMOVE_SESAME);
    expect(rmCall[1].length).toBe(16);
    expect(rmCall[1].equals(Buffer.from(uuid.replace(/-/g, ""), "hex"))).toBe(true);
  });

  it("publish を正規化して購読者へ中継する", () => {
    const s = fakeSession();
    const hub = new Hub3Commands({ session: s });
    const seen = [];
    hub.onPublish((p) => seen.push(p));
    s._emit({ itemCode: ITEM_CODES.HUB3_ITEM_CODE_NETWORK_TYPE, body: Buffer.from([1, 0]) });
    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe("networkType");
    expect(seen[0].isWifiConnected).toBe(true);
  });

  it("dispose で session の publish 中継を外す", () => {
    const s = fakeSession();
    const hub = new Hub3Commands({ session: s });
    const seen = [];
    hub.onPublish((p) => seen.push(p));
    hub.dispose();
    s._emit({ itemCode: ITEM_CODES.HUB3_ITEM_CODE_NETWORK_TYPE, body: Buffer.from([1, 0]) });
    expect(seen).toHaveLength(0);
  });

  it("session 無しで構築は throw", () => {
    expect(() => new Hub3Commands({})).toThrow();
  });
});
