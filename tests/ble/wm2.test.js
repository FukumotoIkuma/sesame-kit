// WifiModule2 (WM2) BLE コアの単体テスト (純 JS、ハードウェア不要)。
// 移植元 CHWifiModule2Device.kt のバイト列・分岐を assert する。
import { describe, it, expect, vi } from "vitest";
import { Buffer } from "node:buffer";
import {
  WM2_GATT, WM2_ACTION,
  scanWifiSSIDData, setWifiSSIDData, setWifiPasswordData, connectWifiData,
  insertSesamesData, removeSesameData,
  parseScanWifiSSID, parseWifiSSIDPublish, parseWifiPasswordPublish,
  parseNetworkStatus, parseSesameKeys, parseWM2Publish, WifiModule2,
} from "../../src/ble/wm2.js";
import { WM2_ACTION_CODES } from "../../src/itemcodes.js";

describe("WM2_GATT / WM2_ACTION", () => {
  it("Wm2Chracs の UUID と一致 (CHWifiModule2Device.kt:534-536)", () => {
    expect(WM2_GATT.SERVICE).toBe("1b7e8251-2877-41c3-b46e-cf057c562524");
    expect(WM2_GATT.WRITE_CHAR).toBe("aca0ef7c-eeaa-48ad-9508-19a6cef6b356");
    expect(WM2_GATT.NOTIFY_CHAR).toBe("8ac32d3f-5cb9-4d44-bec2-ee689169f626");
  });

  it("action code は itemcodes.js の WM2_ACTION_CODES を参照", () => {
    expect(WM2_ACTION).toBe(WM2_ACTION_CODES);
    expect(WM2_ACTION.SCAN_WIFI_SSID).toBe(19);
    expect(WM2_ACTION.UPDATE_WIFI_SSID).toBe(3);
    expect(WM2_ACTION.CONNECT_WIFI).toBe(5);
    expect(WM2_ACTION.ADD_SESAME).toBe(8);
    expect(WM2_ACTION.DELETE_SESAME).toBe(7);
  });
});

describe("コマンド data 生成", () => {
  it("scanWifiSSID は空 data", () => {
    expect(scanWifiSSIDData().length).toBe(0);
  });

  it("setWifiSSID = SSID の UTF-8 bytes", () => {
    expect(setWifiSSIDData("MyＳＳＩＤ").equals(Buffer.from("MyＳＳＩＤ", "utf8"))).toBe(true);
    expect(() => setWifiSSIDData("")).toThrow();
  });

  it("setWifiPassword = password の UTF-8 bytes (空文字許容)", () => {
    expect(setWifiPasswordData("p@ss").equals(Buffer.from("p@ss", "utf8"))).toBe(true);
    expect(setWifiPasswordData("").length).toBe(0);
    expect(() => setWifiPasswordData(123)).toThrow();
  });

  it("connectWifi = company(\":\"/\"-\" 除去) + ':' + UUID 末尾セグメント大文字 (kt:359-361)", () => {
    const d = connectWifiData({
      companyId: "ap-northeast-1:abcd-ef01",
      deviceUUID: "0179c43c-9a0e-49e5-9d69-6a22a6fe7a6e",
    });
    expect(d.toString("utf8")).toBe("apnortheast1abcdef01:6A22A6FE7A6E");
    expect(() => connectWifiData({ companyId: "", deviceUUID: "x" })).toThrow();
    expect(() => connectWifiData({ companyId: "x", deviceUUID: "" })).toThrow();
  });

  it("removeSesame = sesameKeyTag を大文字化した UTF-8 (kt:415)", () => {
    expect(removeSesameData("abc-Def").toString("utf8")).toBe("ABC-DEF");
    expect(() => removeSesameData("")).toThrow();
  });
});

describe("insertSesames allKey 組み立て (kt:380-401)", () => {
  const uuid = "0179C43C-9A0E-49E5-9D69-6A22A6FE7A6E";
  const secretKey = "00112233445566778899aabbccddeeff"; // 16B
  const pubkey = "ab".repeat(64); // 64B

  it("ssmIRData(22 ascii) ++ ssmPKData(64) ++ ssmSecKa(16) ++ ssmUUid(36 ascii) = 138B", () => {
    const all = insertSesamesData({ deviceUUID: uuid, secretKey, sesame2PublicKey: pubkey });
    // 16B UUID → base64 (24 chars, 2 padding) → strip '=' → 22 ascii bytes
    const ir = Buffer.from(uuid.replace(/-/g, ""), "hex").toString("base64").replace(/=/g, "");
    expect(ir.length).toBe(22);
    expect(all.length).toBe(22 + 64 + 16 + 36);
    // 先頭 22B = IR ascii
    expect(all.subarray(0, 22).toString("ascii")).toBe(ir);
    // 次 64B = pubkey
    expect(all.subarray(22, 86).equals(Buffer.from(pubkey, "hex"))).toBe(true);
    // 次 16B = secretKey
    expect(all.subarray(86, 102).equals(Buffer.from(secretKey, "hex"))).toBe(true);
    // 末尾 = 大文字 UUID 文字列 (ハイフン込み) の ascii
    expect(all.subarray(102).toString("ascii")).toBe(uuid);
  });

  it("sesame_5/5_pro/5_us/bike_2 は固定 PK に差し替え (kt:385-391)", () => {
    const fixed = "41B6D190EBBC1E9FA49E62710D80092784E998649FCA150419D2C70C6573BCA4666481EA47FDD755BB0761AB95EF95C9BD24016D54B14606EB5835541E45F27E";
    for (const m of ["sesame_5", "sesame_5_pro", "sesame_5_us", "bike_2"]) {
      const all = insertSesamesData({ deviceUUID: uuid, secretKey, sesame2PublicKey: pubkey, deviceModel: m });
      expect(all.subarray(22, 86).equals(Buffer.from(fixed, "hex"))).toBe(true);
    }
  });

  it("固定 PK 対象外 model は sesame2PublicKey 必須", () => {
    expect(() => insertSesamesData({ deviceUUID: uuid, secretKey, deviceModel: "sesame_6" })).toThrow();
  });
});

describe("publish 解析 (onGattWM2Publish, kt:461-529)", () => {
  it("SCAN_WIFI_SSID: rssi(LE signed short) + ssid (kt:486-490)", () => {
    const buf = Buffer.concat([Buffer.from([0xce, 0xff]), Buffer.from("HomeWiFi", "utf8")]);
    expect(parseScanWifiSSID(buf)).toEqual({ rssi: -50, ssid: "HomeWiFi" });
  });

  it("UPDATE_WIFI_SSID / PASSWORD publish = 文字列 (kt:491-500)", () => {
    expect(parseWifiSSIDPublish(Buffer.from("net1", "utf8"))).toBe("net1");
    expect(parseWifiPasswordPublish(Buffer.from("pw1", "utf8"))).toBe("pw1");
  });

  it("NETWORK_STATUS のビットフラグ (kt:502-510)", () => {
    // bit1=2 isAp, bit2=4 isNet, bit3=8 isIot, bit4=16 APCheck, bit5=32, bit6=64, bit7=0x80 IOTConnecting
    const s = parseNetworkStatus(Buffer.from([2 | 8 | 16]));
    expect(s.isAp).toBe(true);
    expect(s.isNet).toBe(false);
    expect(s.isIot).toBe(true);
    expect(s.isAPCheck).toBe(true);
    expect(parseNetworkStatus(Buffer.from([0x80])).isIOTConnecting).toBe(true);
    expect(parseNetworkStatus(Buffer.from([64])).isNETConnecting).toBe(true);
    expect(() => parseNetworkStatus(Buffer.alloc(0))).toThrow();
  });

  it("SESAME_KEYS: 23B チャンク → {deviceUUID, status} (kt:468-485)", () => {
    const uuid = "0179c43c-9a0e-49e5-9d69-6a22a6fe7a6e";
    const ir = Buffer.from(uuid.replace(/-/g, ""), "hex").toString("base64").replace(/=/g, "");
    const ir22 = Buffer.from(ir.slice(0, 22), "ascii");
    const e1 = Buffer.concat([ir22, Buffer.from([2])]); // status=2 (login 成功)
    const e2 = Buffer.concat([ir22, Buffer.from([0])]);
    const keys = parseSesameKeys(Buffer.concat([e1, e2]));
    expect(keys).toEqual([
      { deviceUUID: uuid, status: 2 },
      { deviceUUID: uuid, status: 0 },
    ]);
  });

  it("SESAME_KEYS: 壊れたエントリはスキップ", () => {
    // 23B 未満の端数は無視。base64 デコード不正もスキップ。
    expect(parseSesameKeys(Buffer.alloc(10))).toEqual([]);
  });

  it("parseWM2Publish のディスパッチ", () => {
    expect(parseWM2Publish({ itemCode: WM2_ACTION.NETWORK_STATUS, body: Buffer.from([8]) }).kind).toBe("networkStatus");
    expect(parseWM2Publish({ itemCode: WM2_ACTION.OPEN_OTA_SERVER, body: Buffer.from([42]) })).toEqual({ kind: "otaProgress", progress: 42 });
    expect(parseWM2Publish({ itemCode: 99, body: Buffer.alloc(0) }).kind).toBe("unknown");
  });
});

describe("WifiModule2 ファサード (session 注入)", () => {
  function fakeSession() {
    const publishListeners = new Set();
    return {
      request: vi.fn(() => Promise.resolve({ resultCode: 0, payload: Buffer.alloc(0) })),
      disconnect: vi.fn(() => Promise.resolve()),
      onPublish(fn) { publishListeners.add(fn); return () => publishListeners.delete(fn); },
      _emit(pub) { for (const fn of publishListeners) fn(pub); },
    };
  }

  it("各コマンドが正しい action code + data で request する", async () => {
    const s = fakeSession();
    const wm2 = new WifiModule2({ session: s, companyId: "ap-northeast-1:abcd", deviceUUID: "0179c43c-9a0e-49e5-9d69-6a22a6fe7a6e" });
    await wm2.scanWifiSSID();
    await wm2.setWifiSSID("net");
    await wm2.setWifiPassword("pw");
    await wm2.connectWifi();
    await wm2.removeSesame("tag1");

    const calls = s.request.mock.calls.map((c) => c[0]);
    expect(calls).toEqual([
      WM2_ACTION.SCAN_WIFI_SSID, WM2_ACTION.UPDATE_WIFI_SSID, WM2_ACTION.UPDATE_WIFI_PASSWORD,
      WM2_ACTION.CONNECT_WIFI, WM2_ACTION.DELETE_SESAME,
    ]);
    // connectWifi の data 検証
    const cwCall = s.request.mock.calls.find((c) => c[0] === WM2_ACTION.CONNECT_WIFI);
    expect(cwCall[1].toString("utf8")).toBe("apnortheast1abcd:6A22A6FE7A6E");
  });

  // P3-20: WifiModule2 は networkStatus() 送信メソッドを持たない。
  // SDK に NETWORK_STATUS 送信経路は無い (CHWifiModule2Device.kt:502-510 受信専用)。
  // 状態は onPublish の {kind:"networkStatus"} で受信する。
  it("networkStatus() メソッドは存在しない (P3-20: 送信経路は SDK 非存在)", () => {
    const s = fakeSession();
    const wm2 = new WifiModule2({ session: s });
    expect(typeof (/** @type {any} */ (wm2).networkStatus)).toBe("undefined");
  });

  it("publish を正規化して購読者へ中継する", () => {
    const s = fakeSession();
    const wm2 = new WifiModule2({ session: s });
    const seen = [];
    wm2.onPublish((p) => seen.push(p));
    s._emit({ itemCode: WM2_ACTION.NETWORK_STATUS, body: Buffer.from([8]) });
    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe("networkStatus");
    expect(seen[0].isIot).toBe(true);
  });

  it("dispose で session の publish 中継を外す", () => {
    const s = fakeSession();
    const wm2 = new WifiModule2({ session: s });
    const seen = [];
    wm2.onPublish((p) => seen.push(p));
    wm2.dispose();
    s._emit({ itemCode: WM2_ACTION.NETWORK_STATUS, body: Buffer.from([8]) });
    expect(seen).toHaveLength(0);
  });

  it("reset = RESET_WM2 を空ペイロードで送り、成功時に session.disconnect する (kt:437-448)", async () => {
    const s = fakeSession();
    const wm2 = new WifiModule2({ session: s });
    const res = await wm2.reset();
    // RESET_WM2(18) + 空 data で request (kt:443)。
    const call = s.request.mock.calls.find((c) => c[0] === WM2_ACTION.RESET_WM2);
    expect(call).toBeTruthy();
    expect(call[1].length).toBe(0);
    // cmdResultCode==success のとき dropKey 相当 = session.disconnect (kt:444-446)。
    expect(s.disconnect).toHaveBeenCalledTimes(1);
    expect(res.resultCode).toBe(0);
  });

  it("reset が非0 resultCode のときは disconnect しない (dropKey は成功時のみ kt:444)", async () => {
    const s = fakeSession();
    s.request = vi.fn(() => Promise.resolve({ resultCode: 5, payload: Buffer.alloc(0) }));
    const wm2 = new WifiModule2({ session: s });
    const res = await wm2.reset();
    expect(res.resultCode).toBe(5);
    expect(s.disconnect).not.toHaveBeenCalled();
  });

  it("session 無しで構築は throw", () => {
    expect(() => new WifiModule2({})).toThrow();
  });
});
