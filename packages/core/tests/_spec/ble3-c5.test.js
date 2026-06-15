// BLE3-0097 〜 BLE3-0114 spec ID に対応する単体テスト。
// 対象: wm2-publish (BLE3-0097〜0102) / hub3-itemcodes (BLE3-0103〜0104) /
//        hub3 コマンド send (BLE3-0105〜0110) / hub3-publish (BLE3-0111〜0114)。
// 全テストはネットワーク/実機に依存しない純 JS (mock or 純関数)。決定論的。

import { describe, it, expect, vi } from "vitest";
import { Buffer } from "node:buffer";

// wm2.js からのインポート
import {
  parseScanWifiSSID as wm2ParseScanWifiSSID,
  parseWifiSSIDPublish,
  parseWifiPasswordPublish,
  parseSesameKeys as wm2ParseSesameKeys,
  parseWM2Publish,
  WM2_ACTION,
} from "../../src/ble/wm2.js";

// hub3.js からのインポート
import {
  parseScanWifiSSID as hub3ParseScanWifiSSID,
  parseMechSetting,
  parseSesameKeys as hub3ParseSesameKeys,
  parseHub3Publish,
  Hub3Commands,
  scanWifiSSIDData,
  setWifiSSIDData,
  setWifiPasswordData,
  removeSesameData,
} from "../../src/ble/hub3.js";

// parseNetworkStatus は protocol.js にある共有関数 (BLE3-0099/0114)
import { parseNetworkStatus } from "../../src/ble/protocol.js";

// itemcodes
import { ITEM_CODES, UNVERIFIED_ITEM_CODES, WM2_ACTION_CODES } from "../../src/itemcodes.js";

// ---------------------------------------------------------------------------
// BLE3-0097: WM2 SCAN_WIFI_SSID publish = rssi(LE signed int16) + ssid(UTF-8)
// ---------------------------------------------------------------------------
describe("[BLE3-0097] WM2 SCAN_WIFI_SSID publish = rssi(LE signed int16) + ssid(UTF-8)", () => {
  it("[BLE3-0097] payload[0..1] を readInt16LE で rssi、drop(2) を UTF-8 で ssid", () => {
    // rssi = -50 = 0xffce (LE: [0xce, 0xff])
    const buf = Buffer.concat([
      Buffer.from([0xce, 0xff]),
      Buffer.from("HomeWiFi", "utf8"),
    ]);
    const result = wm2ParseScanWifiSSID(buf);
    expect(result.rssi).toBe(-50);
    expect(result.ssid).toBe("HomeWiFi");
  });

  it("[BLE3-0097] rssi=0 のケース (LE: [0x00, 0x00])", () => {
    const buf = Buffer.from([0x00, 0x00]);
    const result = wm2ParseScanWifiSSID(buf);
    expect(result.rssi).toBe(0);
    expect(result.ssid).toBe("");
  });

  it("[BLE3-0097] rssi 強 (=−1=0xffff LE) のケース", () => {
    const buf = Buffer.concat([
      Buffer.from([0xff, 0xff]),
      Buffer.from("Strong", "utf8"),
    ]);
    const result = wm2ParseScanWifiSSID(buf);
    expect(result.rssi).toBe(-1);
    expect(result.ssid).toBe("Strong");
  });

  it("[BLE3-0097] 大きな負の rssi 値 (-32768 = 0x0080 LE) を正しく読む", () => {
    // 0x0080 LE = buf[0]=0x00, buf[1]=0x80 → signed 16-bit = -32768
    const payload = Buffer.from([0x00, 0x80]);
    const result = wm2ParseScanWifiSSID(payload);
    expect(result.rssi).toBe(-32768);
  });

  it("[BLE3-0097] parseWM2Publish (SCAN_WIFI_SSID=19) が kind='scanWifiSSID' を返す", () => {
    const buf = Buffer.concat([
      Buffer.from([0xce, 0xff]),
      Buffer.from("net", "utf8"),
    ]);
    const result = parseWM2Publish({ itemCode: WM2_ACTION_CODES.SCAN_WIFI_SSID, body: buf });
    expect(result.kind).toBe("scanWifiSSID");
    expect(result.rssi).toBe(-50);
    expect(result.ssid).toBe("net");
  });
});

// ---------------------------------------------------------------------------
// BLE3-0098: WM2 UPDATE_WIFI_SSID/PASSWORD publish = 現在値の文字列
// ---------------------------------------------------------------------------
describe("[BLE3-0098] WM2 UPDATE_WIFI_SSID/PASSWORD publish = 現在値の文字列", () => {
  it("[BLE3-0098] UPDATE_WIFI_SSID(3) payload 全体を UTF-8 文字列で返す (kt:491-495)", () => {
    const ssid = "MyHomeNetwork";
    const buf = Buffer.from(ssid, "utf8");
    expect(parseWifiSSIDPublish(buf)).toBe(ssid);
  });

  it("[BLE3-0098] UPDATE_WIFI_PASSWORD(4) payload 全体を UTF-8 文字列で返す (kt:496-500)", () => {
    const pwd = "s3cr3t!";
    const buf = Buffer.from(pwd, "utf8");
    expect(parseWifiPasswordPublish(buf)).toBe(pwd);
  });

  it("[BLE3-0098] 空 payload の場合は空文字列を返す", () => {
    expect(parseWifiSSIDPublish(Buffer.alloc(0))).toBe("");
    expect(parseWifiPasswordPublish(Buffer.alloc(0))).toBe("");
  });

  it("[BLE3-0098] マルチバイト SSID (UTF-8 日本語) を正しく返す", () => {
    const ssid = "テストネット";
    expect(parseWifiSSIDPublish(Buffer.from(ssid, "utf8"))).toBe(ssid);
  });

  it("[BLE3-0098] parseWM2Publish: UPDATE_WIFI_SSID(3) → kind='wifiSSID'", () => {
    const buf = Buffer.from("SSID_VALUE", "utf8");
    const result = parseWM2Publish({ itemCode: WM2_ACTION_CODES.UPDATE_WIFI_SSID, body: buf });
    expect(result.kind).toBe("wifiSSID");
    expect(result.ssid).toBe("SSID_VALUE");
  });

  it("[BLE3-0098] parseWM2Publish: UPDATE_WIFI_PASSWORD(4) → kind='wifiPassword'", () => {
    const buf = Buffer.from("PW_VALUE", "utf8");
    const result = parseWM2Publish({ itemCode: WM2_ACTION_CODES.UPDATE_WIFI_PASSWORD, body: buf });
    expect(result.kind).toBe("wifiPassword");
    expect(result.password).toBe("PW_VALUE");
  });
});

// ---------------------------------------------------------------------------
// BLE3-0099: WM2 NETWORK_STATUS publish の payload[0] ビットフラグ解析
// ---------------------------------------------------------------------------
describe("[BLE3-0099] WM2 NETWORK_STATUS publish の payload[0] ビットフラグ解析", () => {
  // bit1=2 isAp, bit2=4 isNet, bit3=8 isIot, bit4=16 isAPCheck,
  // bit5=32 isAPConnecting, bit6=64 isNETConnecting, bit7=0x80 isIOTConnecting
  it("[BLE3-0099] bit1(2): isAp=true (kt:503)", () => {
    const r = parseNetworkStatus(Buffer.from([2]));
    expect(r.isAp).toBe(true);
    expect(r.isNet).toBe(false);
  });

  it("[BLE3-0099] bit2(4): isNet=true (kt:504)", () => {
    const r = parseNetworkStatus(Buffer.from([4]));
    expect(r.isNet).toBe(true);
  });

  it("[BLE3-0099] bit3(8): isIot=true (kt:505)", () => {
    const r = parseNetworkStatus(Buffer.from([8]));
    expect(r.isIot).toBe(true);
  });

  it("[BLE3-0099] bit4(16): isAPCheck=true (kt:506)", () => {
    const r = parseNetworkStatus(Buffer.from([16]));
    expect(r.isAPCheck).toBe(true);
  });

  it("[BLE3-0099] bit5(32): isAPConnecting=true (kt:507)", () => {
    const r = parseNetworkStatus(Buffer.from([32]));
    expect(r.isAPConnecting).toBe(true);
  });

  it("[BLE3-0099] bit6(64): isNETConnecting=true (kt:508)", () => {
    const r = parseNetworkStatus(Buffer.from([64]));
    expect(r.isNETConnecting).toBe(true);
  });

  it("[BLE3-0099] bit7(0x80): isIOTConnecting=true (Kotlin signed byte<0 と等価) (kt:509)", () => {
    const r = parseNetworkStatus(Buffer.from([0x80]));
    expect(r.isIOTConnecting).toBe(true);
  });

  it("[BLE3-0099] 全ビット組み合わせ 0xFE: 全フラグ true (isAp..isIOTConnecting)", () => {
    const r = parseNetworkStatus(Buffer.from([0xfe]));
    expect(r.isAp).toBe(true);
    expect(r.isNet).toBe(true);
    expect(r.isIot).toBe(true);
    expect(r.isAPCheck).toBe(true);
    expect(r.isAPConnecting).toBe(true);
    expect(r.isNETConnecting).toBe(true);
    expect(r.isIOTConnecting).toBe(true);
  });

  it("[BLE3-0099] 空 payload で throw (parseNetworkStatus ガード)", () => {
    expect(() => parseNetworkStatus(Buffer.alloc(0))).toThrow();
  });

  it("[BLE3-0099] parseWM2Publish: NETWORK_STATUS(6) → kind='networkStatus'", () => {
    const result = parseWM2Publish({ itemCode: WM2_ACTION_CODES.NETWORK_STATUS, body: Buffer.from([0x0e]) });
    // 0x0e = bit1+bit2+bit3 → isAp/isNet/isIot = true
    expect(result.kind).toBe("networkStatus");
    expect(result.isAp).toBe(true);
    expect(result.isNet).toBe(true);
    expect(result.isIot).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BLE3-0100: WM2 SESAME_KEYS publish = 23B チャンク → base64 decode で {deviceUUID,status}
// ---------------------------------------------------------------------------
describe("[BLE3-0100] WM2 SESAME_KEYS publish = 23B チャンク → base64 decode で {deviceUUID,status}", () => {
  const uuid = "0179c43c-9a0e-49e5-9d69-6a22a6fe7a6e";

  function makeEntry(status) {
    // 16B UUID hex を base64 化 (末尾 '=' 除去) → 22B ASCII = ss2_ir_22
    const ir22 = Buffer.from(uuid.replace(/-/g, ""), "hex")
      .toString("base64")
      .replace(/=/g, "")
      .slice(0, 22);
    return Buffer.concat([Buffer.from(ir22, "ascii"), Buffer.from([status])]);
  }

  it("[BLE3-0100] 正常エントリ: base64 decode→16B→UUID + status を返す (kt:476-480)", () => {
    const payload = makeEntry(2); // status=2 (login 成功)
    const keys = wm2ParseSesameKeys(payload);
    expect(keys).toHaveLength(1);
    expect(keys[0].deviceUUID).toBe(uuid);
    expect(keys[0].status).toBe(2);
  });

  it("[BLE3-0100] status=0 のエントリも返す (WM2 は Hub3 と異なり status でフィルタしない)", () => {
    const payload = makeEntry(0);
    const keys = wm2ParseSesameKeys(payload);
    expect(keys).toHaveLength(1);
    expect(keys[0].status).toBe(0);
  });

  it("[BLE3-0100] 複数エントリを順に返す (kt:473-480 forEachIndexed 相当)", () => {
    const p1 = makeEntry(1);
    const p2 = makeEntry(2);
    const keys = wm2ParseSesameKeys(Buffer.concat([p1, p2]));
    expect(keys).toHaveLength(2);
    expect(keys[0].status).toBe(1);
    expect(keys[1].status).toBe(2);
  });

  it("[BLE3-0100] 壊れたエントリ (base64 decode が 16B でない) はスキップ (kt:479-480 try/catch)", () => {
    // '!' は base64 アルファベット外: decode 結果が 16B にならない
    const bad22 = Buffer.from("!".repeat(22), "latin1");
    const badEntry = Buffer.concat([bad22, Buffer.from([1])]);
    const goodEntry = makeEntry(3);
    const keys = wm2ParseSesameKeys(Buffer.concat([badEntry, goodEntry]));
    // 壊れたエントリはスキップ、正常エントリのみ
    expect(keys.every((k) => k.deviceUUID === uuid)).toBe(true);
    expect(keys.some((k) => k.status === 3)).toBe(true);
  });

  it("[BLE3-0100] 端数 (23B 未満) は無視", () => {
    expect(wm2ParseSesameKeys(Buffer.alloc(10))).toEqual([]);
  });

  it("[BLE3-0100] parseWM2Publish: SESAME_KEYS(16) → kind='sesameKeys'", () => {
    const result = parseWM2Publish({ itemCode: WM2_ACTION_CODES.SESAME_KEYS, body: makeEntry(1) });
    expect(result.kind).toBe("sesameKeys");
    expect(result.keys).toHaveLength(1);
    expect(result.keys[0].deviceUUID).toBe(uuid);
  });
});

// ---------------------------------------------------------------------------
// BLE3-0101: WM2 OPEN_OTA_SERVER publish = 進捗 1B
// ---------------------------------------------------------------------------
describe("[BLE3-0101] WM2 OPEN_OTA_SERVER publish = 進捗 1B", () => {
  it("[BLE3-0101] payload.first() の進捗 1B として {kind:'otaProgress', progress} に正規化 (kt:465-467)", () => {
    const result = parseWM2Publish({
      itemCode: WM2_ACTION_CODES.OPEN_OTA_SERVER,
      body: Buffer.from([42]),
    });
    expect(result.kind).toBe("otaProgress");
    expect(result.progress).toBe(42);
  });

  it("[BLE3-0101] progress=0 (先頭バイト 0)", () => {
    const result = parseWM2Publish({
      itemCode: WM2_ACTION_CODES.OPEN_OTA_SERVER,
      body: Buffer.from([0]),
    });
    expect(result.kind).toBe("otaProgress");
    expect(result.progress).toBe(0);
  });

  it("[BLE3-0101] progress=255 (最大) の場合も正しく返す", () => {
    const result = parseWM2Publish({
      itemCode: WM2_ACTION_CODES.OPEN_OTA_SERVER,
      body: Buffer.from([255]),
    });
    expect(result.kind).toBe("otaProgress");
    expect(result.progress).toBe(255);
  });
});

// ---------------------------------------------------------------------------
// BLE3-0102: WM2 parseWM2Publish の itemCode ディスパッチ網羅と unknown fallback
// ---------------------------------------------------------------------------
describe("[BLE3-0102] WM2 parseWM2Publish の itemCode ディスパッチ網羅と unknown fallback", () => {
  it("[BLE3-0102] SCAN_WIFI_SSID(19) → kind='scanWifiSSID'", () => {
    const body = Buffer.concat([Buffer.from([0xce, 0xff]), Buffer.from("ssid", "utf8")]);
    expect(parseWM2Publish({ itemCode: 19, body }).kind).toBe("scanWifiSSID");
  });

  it("[BLE3-0102] UPDATE_WIFI_SSID(3) → kind='wifiSSID'", () => {
    expect(parseWM2Publish({ itemCode: 3, body: Buffer.from("net", "utf8") }).kind).toBe("wifiSSID");
  });

  it("[BLE3-0102] UPDATE_WIFI_PASSWORD(4) → kind='wifiPassword'", () => {
    expect(parseWM2Publish({ itemCode: 4, body: Buffer.from("pw", "utf8") }).kind).toBe("wifiPassword");
  });

  it("[BLE3-0102] NETWORK_STATUS(6) → kind='networkStatus'", () => {
    expect(parseWM2Publish({ itemCode: 6, body: Buffer.from([0]) }).kind).toBe("networkStatus");
  });

  it("[BLE3-0102] SESAME_KEYS(16) → kind='sesameKeys'", () => {
    expect(parseWM2Publish({ itemCode: 16, body: Buffer.alloc(0) }).kind).toBe("sesameKeys");
  });

  it("[BLE3-0102] OPEN_OTA_SERVER(126) → kind='otaProgress'", () => {
    expect(parseWM2Publish({ itemCode: 126, body: Buffer.from([50]) }).kind).toBe("otaProgress");
  });

  it("[BLE3-0102] 未対応 itemCode → { kind:'unknown', itemCode, body } (wm2.js:351)", () => {
    const body = Buffer.from([1, 2, 3]);
    const result = parseWM2Publish({ itemCode: 99, body });
    expect(result.kind).toBe("unknown");
    expect(result.itemCode).toBe(99);
    expect(result.body).toBeDefined();
  });

  it("[BLE3-0102] INITIAL(13) は parseWM2Publish では unknown (session 層で処理)", () => {
    // INITIAL は session.js が初期化フローで処理するため parseWM2Publish では unknown 扱い
    const result = parseWM2Publish({ itemCode: WM2_ACTION_CODES.INITIAL, body: Buffer.from([0]) });
    expect(result.kind).toBe("unknown");
    expect(result.itemCode).toBe(WM2_ACTION_CODES.INITIAL);
  });
});

// ---------------------------------------------------------------------------
// BLE3-0103: Hub3 Wi-Fi itemCode が SesameItemCode と 1:1
// ---------------------------------------------------------------------------
describe("[BLE3-0103] Hub3 Wi-Fi itemCode が SesameItemCode と 1:1 (SesameProtocols.kt:40)", () => {
  it("[BLE3-0103] HUB3_ITEM_CODE_WIFI_SSID=131 (SesameProtocols.kt:40)", () => {
    expect(ITEM_CODES.HUB3_ITEM_CODE_WIFI_SSID).toBe(131);
  });

  it("[BLE3-0103] HUB3_ITEM_CODE_SSID_FIRST=132 (SesameProtocols.kt:40)", () => {
    expect(ITEM_CODES.HUB3_ITEM_CODE_SSID_FIRST).toBe(132);
  });

  it("[BLE3-0103] HUB3_ITEM_CODE_SSID_NOTIFY=133 (SesameProtocols.kt:40)", () => {
    expect(ITEM_CODES.HUB3_ITEM_CODE_SSID_NOTIFY).toBe(133);
  });

  it("[BLE3-0103] HUB3_ITEM_CODE_SSID_LAST=134 (SesameProtocols.kt:40)", () => {
    expect(ITEM_CODES.HUB3_ITEM_CODE_SSID_LAST).toBe(134);
  });

  it("[BLE3-0103] HUB3_ITEM_CODE_WIFI_PASSWORD=135 (SesameProtocols.kt:40)", () => {
    expect(ITEM_CODES.HUB3_ITEM_CODE_WIFI_PASSWORD).toBe(135);
  });

  it("[BLE3-0103] HUB3_UPDATE_WIFI_SSID=136 (SesameProtocols.kt:40)", () => {
    expect(ITEM_CODES.HUB3_UPDATE_WIFI_SSID).toBe(136);
  });

  it("[BLE3-0103] 6 値が全て揃っている (131/132/133/134/135/136)", () => {
    const expected = [131, 132, 133, 134, 135, 136];
    const actual = [
      ITEM_CODES.HUB3_ITEM_CODE_WIFI_SSID,
      ITEM_CODES.HUB3_ITEM_CODE_SSID_FIRST,
      ITEM_CODES.HUB3_ITEM_CODE_SSID_NOTIFY,
      ITEM_CODES.HUB3_ITEM_CODE_SSID_LAST,
      ITEM_CODES.HUB3_ITEM_CODE_WIFI_PASSWORD,
      ITEM_CODES.HUB3_UPDATE_WIFI_SSID,
    ];
    expect(actual).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// BLE3-0104: Hub3 は SESAME 既定 GATT を使う (WM2 専用 GATT は使わない)
// ---------------------------------------------------------------------------
describe("[BLE3-0104] Hub3 は SESAME 既定 GATT を使う (WM2 専用 GATT は使わない)", () => {
  it("[BLE3-0104] Hub3Commands は WM2_GATT を export しない / wm2.js に依存しない", async () => {
    // hub3.js が WM2_GATT を export しないことを確認
    const hub3Module = await import("../../src/ble/hub3.js");
    expect(/** @type {any} */ (hub3Module).WM2_GATT).toBeUndefined();
  });

  it("[BLE3-0104] Hub3 コマンドは SESAME SesameItemCode の空間を使う (WM2_ACTION_CODES ではない)", () => {
    // Hub3 の itemCode は ITEM_CODES (SesameItemCode 由来)
    // WM2 の itemCode は WM2_ACTION_CODES (別 enum)
    // Hub3 WIFI_SSID=131 は WM2 には存在しない → 空間が独立している
    expect(ITEM_CODES.HUB3_ITEM_CODE_WIFI_SSID).toBe(131);
    expect(WM2_ACTION_CODES.SCAN_WIFI_SSID).toBe(19);
    // 重複がないことの確認: WM2 に 131 の名前は存在しない
    const wm2Values = Object.values(WM2_ACTION_CODES);
    expect(wm2Values).not.toContain(131);
  });

  it("[BLE3-0104] Hub3Commands は session に WM2_ACTION_CODES でなく ITEM_CODES で request する", async () => {
    const session = {
      request: vi.fn(() => Promise.resolve({ resultCode: 0, payload: Buffer.alloc(0) })),
      disconnect: vi.fn(() => Promise.resolve()),
      onPublish(fn) { return () => {}; },
    };
    const hub = new Hub3Commands({ session });
    await hub.scanWifiSSID();
    // ITEM_CODES.HUB3_ITEM_CODE_WIFI_SSID=131 (SesameItemCode 系)
    // WM2_ACTION_CODES.SCAN_WIFI_SSID=19 (WM2 別 enum)
    const itemCode = session.request.mock.calls[0][0];
    expect(itemCode).toBe(ITEM_CODES.HUB3_ITEM_CODE_WIFI_SSID); // 131
    expect(itemCode).not.toBe(WM2_ACTION_CODES.SCAN_WIFI_SSID);  // 19 ではない
  });
});

// ---------------------------------------------------------------------------
// BLE3-0105: Hub3 scanWifiSSID 送信 = HUB3_ITEM_CODE_WIFI_SSID(131) + 空 data
// ---------------------------------------------------------------------------
describe("[BLE3-0105] Hub3 scanWifiSSID 送信 = HUB3_ITEM_CODE_WIFI_SSID(131) + 空 data", () => {
  it("[BLE3-0105] scanWifiSSIDData() は長さ 0 の Buffer (CHHub3Device.kt:245 byteArrayOf())", () => {
    const data = scanWifiSSIDData();
    expect(data.length).toBe(0);
  });

  it("[BLE3-0105] Hub3Commands.scanWifiSSID が itemCode=131 + 空 data で request する (kt:245)", async () => {
    const session = {
      request: vi.fn(() => Promise.resolve({ resultCode: 0, payload: Buffer.alloc(0) })),
      disconnect: vi.fn(),
      onPublish(fn) { return () => {}; },
    };
    const hub = new Hub3Commands({ session });
    await hub.scanWifiSSID();
    expect(session.request).toHaveBeenCalledOnce();
    const [itemCode, data] = session.request.mock.calls[0];
    expect(itemCode).toBe(131); // HUB3_ITEM_CODE_WIFI_SSID
    expect(data.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// BLE3-0106: Hub3 setWifiSSID 送信 = HUB3_UPDATE_WIFI_SSID(136) + SSID の UTF-8
// ---------------------------------------------------------------------------
describe("[BLE3-0106] Hub3 setWifiSSID 送信 = HUB3_UPDATE_WIFI_SSID(136) + SSID の UTF-8", () => {
  it("[BLE3-0106] setWifiSSIDData('MySsid') = UTF-8 bytes (CHHub3Device.kt:260 ssid.toByteArray())", () => {
    const data = setWifiSSIDData("MySsid");
    expect(data.equals(Buffer.from("MySsid", "utf8"))).toBe(true);
  });

  it("[BLE3-0106] 日本語 SSID も UTF-8 で正しく encode", () => {
    const ssid = "日本語ＳＳＩＤテスト";
    const data = setWifiSSIDData(ssid);
    expect(data.equals(Buffer.from(ssid, "utf8"))).toBe(true);
  });

  it("[BLE3-0106] 空文字列は throw (ble.wm2SsidRequired)", () => {
    expect(() => setWifiSSIDData("")).toThrow();
  });

  it("[BLE3-0106] Hub3Commands.setWifiSSID が itemCode=136 + UTF-8 data で request する (kt:260)", async () => {
    const session = {
      request: vi.fn(() => Promise.resolve({ resultCode: 0, payload: Buffer.alloc(0) })),
      disconnect: vi.fn(),
      onPublish(fn) { return () => {}; },
    };
    const hub = new Hub3Commands({ session });
    await hub.setWifiSSID("HomeNet");
    const [itemCode, data] = session.request.mock.calls[0];
    expect(itemCode).toBe(136); // HUB3_UPDATE_WIFI_SSID
    expect(data.equals(Buffer.from("HomeNet", "utf8"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BLE3-0107: Hub3 setWifiPassword 送信 = HUB3_ITEM_CODE_WIFI_PASSWORD(135) + password の UTF-8
// ---------------------------------------------------------------------------
describe("[BLE3-0107] Hub3 setWifiPassword 送信 = HUB3_ITEM_CODE_WIFI_PASSWORD(135) + password の UTF-8", () => {
  it("[BLE3-0107] setWifiPasswordData('pass123') = UTF-8 bytes (CHHub3Device.kt:251 password.toByteArray())", () => {
    const data = setWifiPasswordData("pass123");
    expect(data.equals(Buffer.from("pass123", "utf8"))).toBe(true);
  });

  it("[BLE3-0107] 空パスワードも許容 (オープン AP 対応)", () => {
    const data = setWifiPasswordData("");
    expect(data.length).toBe(0);
  });

  it("[BLE3-0107] 非文字列は throw (ble.wm2PasswordString)", () => {
    expect(() => setWifiPasswordData(/** @type {any} */ (123))).toThrow();
  });

  it("[BLE3-0107] Hub3Commands.setWifiPassword が itemCode=135 + UTF-8 data で request する (kt:251)", async () => {
    const session = {
      request: vi.fn(() => Promise.resolve({ resultCode: 0, payload: Buffer.alloc(0) })),
      disconnect: vi.fn(),
      onPublish(fn) { return () => {}; },
    };
    const hub = new Hub3Commands({ session });
    await hub.setWifiPassword("s3cr3t");
    const [itemCode, data] = session.request.mock.calls[0];
    expect(itemCode).toBe(135); // HUB3_ITEM_CODE_WIFI_PASSWORD
    expect(data.equals(Buffer.from("s3cr3t", "utf8"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BLE3-0108: Hub3 removeSesame 送信 = REMOVE_SESAME(103) + dash 除去 UUID を decode した生 16B
// ---------------------------------------------------------------------------
describe("[BLE3-0108] Hub3 removeSesame 送信 = REMOVE_SESAME(103) + dash 除去 UUID decode した生 16B", () => {
  const uuid = "0179c43c-9a0e-49e5-9d69-6a22a6fe7a6e";

  it("[BLE3-0108] removeSesameData(uuid) は 16B 生バイト (CHHub3Device.kt:234-236)", () => {
    const data = removeSesameData(uuid);
    expect(data.length).toBe(16);
    expect(data.equals(Buffer.from(uuid.replace(/-/g, ""), "hex"))).toBe(true);
  });

  it("[BLE3-0108] dash なし UUID でも同じ結果", () => {
    const noDash = uuid.replace(/-/g, "");
    expect(removeSesameData(noDash).equals(removeSesameData(uuid))).toBe(true);
  });

  it("[BLE3-0108] WM2 の UTF-8 大文字文字列とは異なる経路 (WM2: toByteArray UTF-8、Hub3: hexDecode 生 16B)", () => {
    const hub3Data = removeSesameData(uuid);
    // WM2 経路: sesameKeyTag.uppercase().toByteArray() = ASCII/UTF-8 文字列
    // Hub3 経路: noDashUUID.hexStringToByteArray() = 生 16B バイナリ
    // 両者は異なる (length でも確認)
    const wm2Data = Buffer.from(uuid.toUpperCase(), "utf8"); // WM2 相当 (wm2.js の removeSesameData)
    expect(hub3Data.length).toBe(16);
    expect(wm2Data.length).not.toBe(16); // UUID 文字列 ASCII は 36B
    expect(hub3Data.equals(wm2Data)).toBe(false);
  });

  it("[BLE3-0108] Hub3Commands.removeSesame が itemCode=103 + 生 16B data で request する", async () => {
    const session = {
      request: vi.fn(() => Promise.resolve({ resultCode: 0, payload: Buffer.alloc(0) })),
      disconnect: vi.fn(),
      onPublish(fn) { return () => {}; },
    };
    const hub = new Hub3Commands({ session });
    await hub.removeSesame(uuid);
    const [itemCode, data] = session.request.mock.calls[0];
    expect(itemCode).toBe(ITEM_CODES.REMOVE_SESAME); // 103
    expect(data.length).toBe(16);
    expect(data.equals(Buffer.from(uuid.replace(/-/g, ""), "hex"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BLE3-0109: Hub3 removeSesame 空タグは必須検証で reject
// ---------------------------------------------------------------------------
describe("[BLE3-0109] Hub3 removeSesame 空タグは必須検証で reject", () => {
  it("[BLE3-0109] 空文字列は ble.wm2SesameKeyTagRequired で throw (hub3.js:99)", () => {
    expect(() => removeSesameData("")).toThrow();
  });

  it("[BLE3-0109] 非文字列は throw", () => {
    expect(() => removeSesameData(/** @type {any} */ (null))).toThrow();
    expect(() => removeSesameData(/** @type {any} */ (undefined))).toThrow();
    expect(() => removeSesameData(/** @type {any} */ (123))).toThrow();
  });

  it("[BLE3-0109] 正常な UUID 文字列は throw しない", () => {
    expect(() => removeSesameData("0179c43c-9a0e-49e5-9d69-6a22a6fe7a6e")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// BLE3-0110: Hub3 に connectWifi は存在しない (WM2 のみ CONNECT_WIFI)
// ---------------------------------------------------------------------------
describe("[BLE3-0110] Hub3 に connectWifi は存在しない (WM2 のみ CONNECT_WIFI)", () => {
  it("[BLE3-0110] Hub3Commands クラスに connectWifi メソッドは存在しない (CHHub3Device.kt:232-269 参照)", () => {
    const session = {
      request: vi.fn(),
      disconnect: vi.fn(),
      onPublish(fn) { return () => {}; },
    };
    const hub = new Hub3Commands({ session });
    expect(typeof /** @type {any} */ (hub).connectWifi).toBe("undefined");
  });

  it("[BLE3-0110] Hub3Commands prototype の公開メソッドには connectWifi が含まれない", () => {
    const methods = Object.getOwnPropertyNames(Hub3Commands.prototype);
    expect(methods).not.toContain("connectWifi");
  });

  it("[BLE3-0110] Hub3Commands が CONNECT_WIFI(5) を request することはない", async () => {
    const session = {
      request: vi.fn(() => Promise.resolve({ resultCode: 0, payload: Buffer.alloc(0) })),
      disconnect: vi.fn(),
      onPublish(fn) { return () => {}; },
    };
    const hub = new Hub3Commands({ session });
    // 全コマンドを呼んでも CONNECT_WIFI(5) は送られない
    await hub.scanWifiSSID();
    await hub.setWifiSSID("net");
    await hub.setWifiPassword("pw");
    await hub.removeSesame("0179c43c-9a0e-49e5-9d69-6a22a6fe7a6e");
    const calledItemCodes = session.request.mock.calls.map((c) => c[0]);
    expect(calledItemCodes).not.toContain(5); // CONNECT_WIFI=5 (WM2 専用)
  });
});

// ---------------------------------------------------------------------------
// BLE3-0111: Hub3 SSID_NOTIFY(133) publish = rssi(LE signed int16) + ssid(UTF-8)
// ---------------------------------------------------------------------------
describe("[BLE3-0111] Hub3 SSID_NOTIFY(133) publish = rssi(LE signed int16) + ssid(UTF-8)", () => {
  it("[BLE3-0111] payload[0..1] を readInt16LE で rssi、残りを UTF-8 で ssid (CHHub3Device.kt:327-328)", () => {
    // rssi=-50=0xffce LE: [0xce, 0xff]
    const buf = Buffer.concat([
      Buffer.from([0xce, 0xff]),
      Buffer.from("OfficeWiFi", "utf8"),
    ]);
    const result = hub3ParseScanWifiSSID(buf);
    expect(result.rssi).toBe(-50);
    expect(result.ssid).toBe("OfficeWiFi");
  });

  it("[BLE3-0111] WM2 の parseScanWifiSSID と同一ロジック (DataExtention.kt:99-102 LE signed short)", () => {
    const buf = Buffer.concat([Buffer.from([0x38, 0xff]), Buffer.from("same", "utf8")]);
    // -200 = 0xFF38 in LE: buf[0]=0x38, buf[1]=0xFF
    const h = hub3ParseScanWifiSSID(buf);
    const w = wm2ParseScanWifiSSID(buf);
    expect(h.rssi).toBe(w.rssi);
    expect(h.ssid).toBe(w.ssid);
  });

  it("[BLE3-0111] parseHub3Publish: SSID_NOTIFY(133) → { kind:'scanWifiSSID', rssi, ssid }", () => {
    const buf = Buffer.concat([
      Buffer.from([0xce, 0xff]),
      Buffer.from("net", "utf8"),
    ]);
    const result = parseHub3Publish({ itemCode: ITEM_CODES.HUB3_ITEM_CODE_SSID_NOTIFY, body: buf });
    expect(result.kind).toBe("scanWifiSSID");
    expect(result.rssi).toBe(-50);
    expect(result.ssid).toBe("net");
  });
});

// ---------------------------------------------------------------------------
// BLE3-0112: Hub3 SSID_FIRST(132)/SSID_LAST(134) publish はマーカー (SDK no-op)
// ---------------------------------------------------------------------------
describe("[BLE3-0112] Hub3 SSID_FIRST(132)/SSID_LAST(134) publish はマーカー (SDK no-op)", () => {
  it("[BLE3-0112] SSID_FIRST(132) → { kind:'ssidMarker', itemCode:132 } (CHHub3Device.kt:324 空ブロック)", () => {
    const result = parseHub3Publish({ itemCode: 132, body: Buffer.alloc(0) });
    expect(result.kind).toBe("ssidMarker");
    expect(result.itemCode).toBe(132);
  });

  it("[BLE3-0112] SSID_LAST(134) → { kind:'ssidMarker', itemCode:134 } (CHHub3Device.kt:325 空ブロック)", () => {
    const result = parseHub3Publish({ itemCode: 134, body: Buffer.alloc(0) });
    expect(result.kind).toBe("ssidMarker");
    expect(result.itemCode).toBe(134);
  });

  it("[BLE3-0112] SSID_FIRST と SSID_LAST は itemCode で区別される", () => {
    const first = parseHub3Publish({ itemCode: ITEM_CODES.HUB3_ITEM_CODE_SSID_FIRST, body: Buffer.alloc(0) });
    const last = parseHub3Publish({ itemCode: ITEM_CODES.HUB3_ITEM_CODE_SSID_LAST, body: Buffer.alloc(0) });
    expect(first.itemCode).not.toBe(last.itemCode);
  });

  it("[BLE3-0112] SSID_LAST(134) は collectWifiScan の早期確定トリガになる (itemCode で識別)", () => {
    // SSID_LAST マーカー itemCode を確認 (rpc-helpers.js:148 で p.itemCode===HUB3_ITEM_CODE_SSID_LAST を検証)
    expect(ITEM_CODES.HUB3_ITEM_CODE_SSID_LAST).toBe(134);
    const result = parseHub3Publish({ itemCode: ITEM_CODES.HUB3_ITEM_CODE_SSID_LAST, body: Buffer.alloc(0) });
    expect(result.kind).toBe("ssidMarker");
    expect(result.itemCode).toBe(ITEM_CODES.HUB3_ITEM_CODE_SSID_LAST);
  });
});

// ---------------------------------------------------------------------------
// BLE3-0113: Hub3 mechSetting(80) publish = SSID/パスワード (旧60B/新96B ファーム分岐)
// ---------------------------------------------------------------------------
describe("[BLE3-0113] Hub3 mechSetting(80) publish = SSID/パスワード (旧60B/新96B ファーム分岐)", () => {
  it("[BLE3-0113] payload<96B (旧ファーム): SSID=[0..29]/PW=[30..59] (CHHub3Device.kt:277-280)", () => {
    const buf = Buffer.alloc(60);
    Buffer.from("mySSID", "utf8").copy(buf, 0);
    Buffer.from("myPassword", "utf8").copy(buf, 30);
    const result = parseMechSetting(buf);
    expect(result.wifiSSID).toBe("mySSID");
    expect(result.wifiPassWord).toBe("myPassword");
  });

  it("[BLE3-0113] payload>=96B (新ファーム): SSID=[0..31]/PW=[32..95] (CHHub3Device.kt:282-286)", () => {
    const buf = Buffer.alloc(96);
    Buffer.from("newSSID", "utf8").copy(buf, 0);
    Buffer.from("newPassword", "utf8").copy(buf, 32);
    const result = parseMechSetting(buf);
    expect(result.wifiSSID).toBe("newSSID");
    expect(result.wifiPassWord).toBe("newPassword");
  });

  it("[BLE3-0113] 末尾の 0x00 と '?' を trim する (Kotlin trimEnd(0.toChar(), '?'))", () => {
    const buf = Buffer.alloc(60);
    Buffer.from("net??\x00", "utf8").copy(buf, 0); // 末尾 '?' と 0x00 は trim 対象
    Buffer.from("pw", "utf8").copy(buf, 30);
    const result = parseMechSetting(buf);
    expect(result.wifiSSID).toBe("net"); // '?' と 0x00 が trim される
    expect(result.wifiPassWord).toBe("pw");
  });

  it("[BLE3-0113] parseHub3Publish: MECH_SETTING(80) → kind='mechSetting'", () => {
    const body = Buffer.alloc(60);
    Buffer.from("ssid", "utf8").copy(body, 0);
    const result = parseHub3Publish({ itemCode: ITEM_CODES.MECH_SETTING, body });
    expect(result.kind).toBe("mechSetting");
    expect(result.wifiSSID).toBe("ssid");
  });

  it("[BLE3-0113] payload ちょうど 95B (<96) は旧ファーム経路 (境界値)", () => {
    const buf = Buffer.alloc(95, 0x00);
    Buffer.from("ssid", "utf8").copy(buf, 0);
    Buffer.from("pw", "utf8").copy(buf, 30);
    const result = parseMechSetting(buf);
    expect(result.wifiSSID).toBe("ssid");
    expect(result.wifiPassWord).toBe("pw");
  });

  it("[BLE3-0113] 新ファーム 96B ちょうど: SSID 枠=32B/パスワード枠=64B の境界", () => {
    const buf = Buffer.alloc(96);
    const ssid = "a".repeat(32);
    Buffer.from(ssid, "utf8").copy(buf, 0);
    const pwd = "b".repeat(20);
    Buffer.from(pwd, "utf8").copy(buf, 32);
    const result = parseMechSetting(buf);
    expect(result.wifiSSID).toBe(ssid);
    expect(result.wifiPassWord).toBe(pwd);
  });
});

// ---------------------------------------------------------------------------
// BLE3-0114: Hub3 mechStatus(81) publish = ネットワーク状態 bit ベクタ (WM2 と同 layout)
// ---------------------------------------------------------------------------
describe("[BLE3-0114] Hub3 mechStatus(81) publish = ネットワーク状態 bit ベクタ (WM2 と同 layout)", () => {
  it("[BLE3-0114] MECH_STATUS(81) は payload[0] のネットワーク状態 bit フラグ (CHHub3Device.kt:291-301)", () => {
    // Hub3 の 81 は lock/bot の mechStatus (7B/3B) ではなくネットワーク状態 bit ベクタ
    const result = parseHub3Publish({ itemCode: ITEM_CODES.MECH_STATUS, body: Buffer.from([0x0e]) });
    // 0x0e = bit1(2)+bit2(4)+bit3(8) → isAp/isNet/isIot = true
    expect(result.kind).toBe("networkStatus");
    expect(result.isAp).toBe(true);
    expect(result.isNet).toBe(true);
    expect(result.isIot).toBe(true);
  });

  it("[BLE3-0114] WM2 NETWORK_STATUS(6) と同一 bit layout の共有 parser (protocol.js:807-826, P3-16)", () => {
    // WM2 parseNetworkStatus と Hub3 MECH_STATUS(81) は同一の parseNetworkStatus を使う
    const payload = Buffer.from([0b1000_0010]); // bit1=isAp, bit7=isIOTConnecting
    // 共有 parseNetworkStatus 直接呼び出し
    const shared = parseNetworkStatus(payload);
    // Hub3 parseHub3Publish(MECH_STATUS) 経由
    const hub3Result = parseHub3Publish({ itemCode: 81, body: payload });
    // 同じ結果になるはず
    expect(hub3Result.kind).toBe("networkStatus");
    expect(hub3Result.isAp).toBe(shared.isAp);
    expect(hub3Result.isIOTConnecting).toBe(shared.isIOTConnecting);
  });

  it("[BLE3-0114] bit1(2): isAp=true (kt:293)", () => {
    const r = parseHub3Publish({ itemCode: 81, body: Buffer.from([2]) });
    expect(r.isAp).toBe(true);
    expect(r.isNet).toBe(false);
  });

  it("[BLE3-0114] bit7(0x80): isIOTConnecting=true (Kotlin signed byte<0 と等価) (kt:299)", () => {
    const r = parseHub3Publish({ itemCode: 81, body: Buffer.from([0x80]) });
    expect(r.isIOTConnecting).toBe(true);
  });

  it("[BLE3-0114] 全 bit 0: 全フラグ false", () => {
    const r = parseHub3Publish({ itemCode: 81, body: Buffer.from([0]) });
    expect(r.kind).toBe("networkStatus");
    expect(r.isAp).toBe(false);
    expect(r.isNet).toBe(false);
    expect(r.isIot).toBe(false);
    expect(r.isAPCheck).toBe(false);
    expect(r.isAPConnecting).toBe(false);
    expect(r.isNETConnecting).toBe(false);
    expect(r.isIOTConnecting).toBe(false);
  });

  it("[BLE3-0114] payload が 0B の場合 throw (parseNetworkStatus はペイロード最低 1B)", () => {
    expect(() => parseHub3Publish({ itemCode: ITEM_CODES.MECH_STATUS, body: Buffer.alloc(0) })).toThrow();
  });

  it("[BLE3-0114] MECH_STATUS itemCode 値 = 81 (SesameItemCode として ITEM_CODES に存在)", () => {
    expect(ITEM_CODES.MECH_STATUS).toBe(81);
  });
});
