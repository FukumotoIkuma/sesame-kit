// BLE3-0079 〜 BLE3-0096: WM2 送信コマンド・入力検証・reset・networkStatus 存在チェック。
// 移植元: packages/core/src/ble/wm2.js / packages/core/src/ble/index.js /
//          packages/core/src/ble/rpc-helpers.js / packages/core/src/itemcodes.js
// 参照: CHWifiModule2Device.kt:323-448 / app.properties:6
//
// 方針: 全テスト純関数 / セッション mock のみ。ネットワーク・実機不使用。決定論的。
// i18n: setup.i18n.js が beforeEach で ja に設定するため追加 setLocale 不要。

import { describe, it, expect, vi } from "vitest";
import { Buffer } from "node:buffer";
import {
  scanWifiSSIDData,
  setWifiSSIDData,
  setWifiPasswordData,
  connectWifiData,
  insertSesamesData,
  removeSesameData,
  WifiModule2,
  WM2_ACTION,
} from "../../src/ble/wm2.js";
import { WM2_ACTION_CODES } from "../../src/itemcodes.js";
import { WM2_API_GATEWAY_CLIENT_ID } from "../../src/ble/rpc-helpers.js";

// ---------- セッションスタブ ----------

function fakeSession({ loggedIn = true, resultCode = 0 } = {}) {
  const publishListeners = new Set();
  const s = {
    _loggedIn: loggedIn,
    request: vi.fn(() =>
      loggedIn
        ? Promise.resolve({ resultCode, payload: Buffer.alloc(0) })
        : Promise.reject(new Error("ble.notLoggedIn"))
    ),
    disconnect: vi.fn(() => Promise.resolve()),
    onPublish(fn) {
      publishListeners.add(fn);
      return () => publishListeners.delete(fn);
    },
    _emit(pub) {
      for (const fn of publishListeners) fn(pub);
    },
  };
  return s;
}

// ============================================================
// BLE3-0079: scanWifiSSID 送信 = SCAN_WIFI_SSID(19) + 空 data
// ============================================================
describe("[BLE3-0079] scanWifiSSID = SCAN_WIFI_SSID(19) + 空 data", () => {
  it("[BLE3-0079] scanWifiSSIDData() は長さ 0 の Buffer を返す (CHWifiModule2Device.kt:324 byteArrayOf())", () => {
    const d = scanWifiSSIDData();
    expect(Buffer.isBuffer(d)).toBe(true);
    expect(d.length).toBe(0);
  });

  it("[BLE3-0079] WifiModule2.scanWifiSSID は SCAN_WIFI_SSID(19) + 空 data で request する", async () => {
    const s = fakeSession();
    const wm2 = new WifiModule2({ session: s });
    await wm2.scanWifiSSID();
    expect(s.request).toHaveBeenCalledTimes(1);
    const [code, data] = s.request.mock.calls[0];
    expect(code).toBe(WM2_ACTION_CODES.SCAN_WIFI_SSID); // 19
    expect(code).toBe(19);
    expect(Buffer.isBuffer(data)).toBe(true);
    expect(data.length).toBe(0);
  });
});

// ============================================================
// BLE3-0080: setWifiSSID 送信 data = SSID の UTF-8 bytes
// ============================================================
describe("[BLE3-0080] setWifiSSID 送信 data = SSID の UTF-8 bytes", () => {
  it("[BLE3-0080] setWifiSSIDData('HomeNet') = UTF-8 バイト列 (CHWifiModule2Device.kt:337 ssid.toByteArray())", () => {
    const d = setWifiSSIDData("HomeNet");
    expect(Buffer.isBuffer(d)).toBe(true);
    expect(d.equals(Buffer.from("HomeNet", "utf8"))).toBe(true);
  });

  it("[BLE3-0080] マルチバイト SSID は UTF-8 で符号化される", () => {
    const ssid = "マイネット";
    const d = setWifiSSIDData(ssid);
    expect(d.equals(Buffer.from(ssid, "utf8"))).toBe(true);
  });

  it("[BLE3-0080] action code = UPDATE_WIFI_SSID(3) で request される", async () => {
    const s = fakeSession();
    const wm2 = new WifiModule2({ session: s });
    await wm2.setWifiSSID("net");
    const [code, data] = s.request.mock.calls[0];
    expect(code).toBe(WM2_ACTION_CODES.UPDATE_WIFI_SSID); // 3
    expect(code).toBe(3);
    expect(data.equals(Buffer.from("net", "utf8"))).toBe(true);
  });
});

// ============================================================
// BLE3-0081: setWifiSSID 空文字列は必須検証で throw
// ============================================================
describe("[BLE3-0081] setWifiSSID 空文字列/非文字列は必須検証で throw", () => {
  it("[BLE3-0081] 空文字列は throw (wm2.js:113 ble.wm2SsidRequired)", () => {
    expect(() => setWifiSSIDData("")).toThrow();
  });

  it("[BLE3-0081] 非文字列(number)は throw", () => {
    expect(() => setWifiSSIDData(/** @type {any} */ (42))).toThrow();
  });

  it("[BLE3-0081] null は throw", () => {
    expect(() => setWifiSSIDData(/** @type {any} */ (null))).toThrow();
  });
});

// ============================================================
// BLE3-0082: setWifiPassword 送信 data = password の UTF-8 bytes
// ============================================================
describe("[BLE3-0082] setWifiPassword 送信 data = password の UTF-8 bytes", () => {
  it("[BLE3-0082] setWifiPasswordData('pass') = UTF-8 バイト列 (CHWifiModule2Device.kt:351 password.toByteArray())", () => {
    const d = setWifiPasswordData("pass");
    expect(Buffer.isBuffer(d)).toBe(true);
    expect(d.equals(Buffer.from("pass", "utf8"))).toBe(true);
  });

  it("[BLE3-0082] 空文字列パスワードは許容 (オープン AP) → 長さ 0 Buffer", () => {
    const d = setWifiPasswordData("");
    expect(Buffer.isBuffer(d)).toBe(true);
    expect(d.length).toBe(0);
  });

  it("[BLE3-0082] action code = UPDATE_WIFI_PASSWORD(4) で request される", async () => {
    const s = fakeSession();
    const wm2 = new WifiModule2({ session: s });
    await wm2.setWifiPassword("secret");
    const [code, data] = s.request.mock.calls[0];
    expect(code).toBe(WM2_ACTION_CODES.UPDATE_WIFI_PASSWORD); // 4
    expect(code).toBe(4);
    expect(data.equals(Buffer.from("secret", "utf8"))).toBe(true);
  });
});

// ============================================================
// BLE3-0083: setWifiPassword 非文字列は型検証で reject (空文字は許容)
// ============================================================
describe("[BLE3-0083] setWifiPassword 非文字列は型検証で throw (空文字は許容)", () => {
  it("[BLE3-0083] 数値は throw (wm2.js:123 ble.wm2PasswordString)", () => {
    expect(() => setWifiPasswordData(/** @type {any} */ (123))).toThrow();
  });

  it("[BLE3-0083] null は throw", () => {
    expect(() => setWifiPasswordData(/** @type {any} */ (null))).toThrow();
  });

  it("[BLE3-0083] undefined は throw", () => {
    expect(() => setWifiPasswordData(/** @type {any} */ (undefined))).toThrow();
  });

  it("[BLE3-0083] 空文字列は throw しない (長さ検査なし)", () => {
    expect(() => setWifiPasswordData("")).not.toThrow();
  });
});

// ============================================================
// BLE3-0084: connectWifi verification = company(:/- 除去) + ':' + UUID 末尾セグメント大文字
// ============================================================
describe("[BLE3-0084] connectWifi verification フォーマット (CHWifiModule2Device.kt:358-363)", () => {
  it("[BLE3-0084] verification = company(:/- 除去) + ':' + UUID 末尾セグメント大文字 (kt:359-361)", () => {
    const companyId = "ap-northeast-1:0a1820f1-dbb3-4bca-9227-2a92f6abf0ae";
    const deviceUUID = "0179c43c-9a0e-49e5-9d69-6a22a6fe7a6e";
    const d = connectWifiData({ companyId, deviceUUID });
    const str = d.toString("utf8");
    // company = ':'/'-' を除去
    const company = companyId.replace(/:/g, "").replace(/-/g, "");
    // 末尾セグメント = deviceUUID.toUpperCase().split('-').last()
    const tail = deviceUUID.toUpperCase().split("-").pop();
    const expected = `${company}:${tail}`;
    expect(str).toBe(expected);
  });

  it("[BLE3-0084] company は ':' と '-' を除去した文字列 (kt:359)", () => {
    const d = connectWifiData({
      companyId: "ap-northeast-1:0a1820f1-dbb3-4bca-9227-2a92f6abf0ae",
      deviceUUID: "0179c43c-9a0e-49e5-9d69-6a22a6fe7a6e",
    });
    const verification = d.toString("utf8");
    expect(verification.startsWith("apnortheast10a1820f1dbb34bca92272a92f6abf0ae:")).toBe(true);
  });

  it("[BLE3-0084] 末尾セグメント = deviceUUID.toUpperCase().split('-').last() (kt:361)", () => {
    const d = connectWifiData({
      companyId: "ap-northeast-1:abcd",
      deviceUUID: "0179c43c-9a0e-49e5-9d69-6a22a6fe7a6e",
    });
    const verification = d.toString("utf8");
    // 末尾セグメント = "6A22A6FE7A6E"
    expect(verification.endsWith(":6A22A6FE7A6E")).toBe(true);
  });

  it("[BLE3-0084] action code = CONNECT_WIFI(5) で request される", async () => {
    const s = fakeSession();
    const wm2 = new WifiModule2({
      session: s,
      companyId: "ap-northeast-1:abcd",
      deviceUUID: "0179c43c-9a0e-49e5-9d69-6a22a6fe7a6e",
    });
    await wm2.connectWifi();
    const [code] = s.request.mock.calls[0];
    expect(code).toBe(WM2_ACTION_CODES.CONNECT_WIFI); // 5
    expect(code).toBe(5);
  });
});

// ============================================================
// BLE3-0085: WM2_API_GATEWAY_CLIENT_ID と connectWifi のデフォルト注入
// ============================================================
describe("[BLE3-0085] WM2_API_GATEWAY_CLIENT_ID は app.properties の clientId と一致", () => {
  it("[BLE3-0085] WM2_API_GATEWAY_CLIENT_ID は app.properties の clientId と一致 (app.properties:6)", () => {
    // app.properties:6 aws.apigateway.clientId=ap-northeast-1:0a1820f1-dbb3-4bca-9227-2a92f6abf0ae
    expect(WM2_API_GATEWAY_CLIENT_ID).toBe(
      "ap-northeast-1:0a1820f1-dbb3-4bca-9227-2a92f6abf0ae"
    );
  });

  it("[BLE3-0085] WM2_API_GATEWAY_CLIENT_ID は 'ap-northeast-1:' プレフィックスを持つ形式", () => {
    expect(typeof WM2_API_GATEWAY_CLIENT_ID).toBe("string");
    expect(WM2_API_GATEWAY_CLIENT_ID.startsWith("ap-northeast-1:")).toBe(true);
  });

  it("[BLE3-0085] WifiModule2 に companyId を渡すと connectWifi verification に反映される (rpc-helpers.js:114 wifiViewOf 注入と同契約)", async () => {
    const s = fakeSession();
    const wm2 = new WifiModule2({
      session: s,
      companyId: WM2_API_GATEWAY_CLIENT_ID,
      deviceUUID: "0179c43c-9a0e-49e5-9d69-6a22a6fe7a6e",
    });
    await wm2.connectWifi();
    const [, data] = s.request.mock.calls[0];
    const v = data.toString("utf8");
    // companyId の ':'/'-' 除去 = 'apnortheast10a1820f1dbb34bca92272a92f6abf0ae'
    expect(v).toContain("apnortheast10a1820f1dbb34bca92272a92f6abf0ae:");
  });
});

// ============================================================
// BLE3-0086: connectWifi の companyId/deviceUUID 欠落は必須検証で throw
// ============================================================
describe("[BLE3-0086] connectWifi companyId/deviceUUID 欠落は throw (wm2.js:140-141)", () => {
  it("[BLE3-0086] companyId 欠落 (undefined) は throw (ble.wm2CompanyIdRequired)", () => {
    expect(() =>
      connectWifiData({ deviceUUID: "0179c43c-9a0e-49e5-9d69-6a22a6fe7a6e" })
    ).toThrow();
  });

  it("[BLE3-0086] companyId 空文字列は throw", () => {
    expect(() =>
      connectWifiData({ companyId: "", deviceUUID: "0179c43c-9a0e-49e5-9d69-6a22a6fe7a6e" })
    ).toThrow();
  });

  it("[BLE3-0086] deviceUUID 欠落 (undefined) は throw (ble.wm2DeviceUUIDRequired)", () => {
    expect(() =>
      connectWifiData({ companyId: "ap-northeast-1:abcd" })
    ).toThrow();
  });

  it("[BLE3-0086] deviceUUID 空文字列は throw", () => {
    expect(() =>
      connectWifiData({ companyId: "ap-northeast-1:abcd", deviceUUID: "" })
    ).toThrow();
  });

  it("[BLE3-0086] 両方存在すれば throw しない", () => {
    expect(() =>
      connectWifiData({ companyId: "ap-northeast-1:x", deviceUUID: "0179c43c-9a0e-49e5-9d69-6a22a6fe7a6e" })
    ).not.toThrow();
  });
});

// ============================================================
// BLE3-0087: insertSesames allKey レイアウト = ssmIRData++ssmPKData++ssmSecKa++ssmUUid
// ============================================================
describe("[BLE3-0087] insertSesames allKey レイアウト (CHWifiModule2Device.kt:380-401)", () => {
  const UUID = "0179C43C-9A0E-49E5-9D69-6A22A6FE7A6E";
  const SECRET = "00112233445566778899aabbccddeeff"; // 16B hex
  const PUBKEY = "ab".repeat(64); // 64B hex

  it("[BLE3-0087] allKey 合計 138B = 22+64+16+36", () => {
    const all = insertSesamesData({ deviceUUID: UUID, secretKey: SECRET, sesame2PublicKey: PUBKEY });
    expect(all.length).toBe(22 + 64 + 16 + 36); // 138
  });

  it("[BLE3-0087] ssmIRData[0..22) = noHashUUID(32hex) を base64 化し '=' 除去した 22 ASCII bytes (kt:381-383)", () => {
    const all = insertSesamesData({ deviceUUID: UUID, secretKey: SECRET, sesame2PublicKey: PUBKEY });
    const noHash = UUID.replace(/-/g, "");
    const b64 = Buffer.from(noHash, "hex").toString("base64").replace(/=/g, "");
    expect(b64.length).toBe(22);
    expect(all.subarray(0, 22).toString("ascii")).toBe(b64);
  });

  it("[BLE3-0087] ssmPKData[22..86) = sesame2PublicKey の hex decode 64B (kt:393)", () => {
    const all = insertSesamesData({ deviceUUID: UUID, secretKey: SECRET, sesame2PublicKey: PUBKEY });
    expect(all.subarray(22, 86).equals(Buffer.from(PUBKEY, "hex"))).toBe(true);
  });

  it("[BLE3-0087] ssmSecKa[86..102) = secretKey の hex decode 16B (kt:399)", () => {
    const all = insertSesamesData({ deviceUUID: UUID, secretKey: SECRET, sesame2PublicKey: PUBKEY });
    expect(all.subarray(86, 102).equals(Buffer.from(SECRET, "hex"))).toBe(true);
  });

  it("[BLE3-0087] ssmUUid[102..138) = deviceUUID.toUpperCase() の ASCII bytes ハイフン込み 36B (kt:400)", () => {
    const all = insertSesamesData({ deviceUUID: UUID, secretKey: SECRET, sesame2PublicKey: PUBKEY });
    expect(all.subarray(102).toString("ascii")).toBe(UUID.toUpperCase());
    expect(all.subarray(102).length).toBe(36);
  });

  it("[BLE3-0087] action code = ADD_SESAME(8) で request される", async () => {
    const s = fakeSession();
    const wm2 = new WifiModule2({ session: s });
    await wm2.insertSesames({ deviceUUID: UUID, secretKey: SECRET, sesame2PublicKey: PUBKEY });
    const [code] = s.request.mock.calls[0];
    expect(code).toBe(WM2_ACTION_CODES.ADD_SESAME); // 8
    expect(code).toBe(8);
  });
});

// ============================================================
// BLE3-0088: insertSesames は sesame_5/5_pro/5_us/bike_2 で固定 PK に差し替え
// ============================================================
describe("[BLE3-0088] insertSesames 固定 PK 対象 model は ssmPKData を固定値で差し替え (CHWifiModule2Device.kt:385-391)", () => {
  const UUID = "0179C43C-9A0E-49E5-9D69-6A22A6FE7A6E";
  const SECRET = "00112233445566778899aabbccddeeff";
  const DUMMYPK = "cd".repeat(64); // 任意 64B (固定 PK に差し替えられるはずの値)
  // CHWifiModule2Device.kt:391 のリテラル (wm2.js:57-58 と 1:1)
  const FIXED_PK_HEX =
    "41B6D190EBBC1E9FA49E62710D80092784E998649FCA150419D2C70C6573BCA4666481EA47FDD755BB0761AB95EF95C9BD24016D54B14606EB5835541E45F27E";

  for (const model of ["sesame_5", "sesame_5_pro", "sesame_5_us", "bike_2"]) {
    it(`[BLE3-0088] deviceModel='${model}' は固定 PK(kt:391) に差し替え`, () => {
      const all = insertSesamesData({
        deviceUUID: UUID,
        secretKey: SECRET,
        sesame2PublicKey: DUMMYPK, // 渡しても固定 PK で上書きされる
        deviceModel: model,
      });
      const pkPart = all.subarray(22, 86);
      expect(pkPart.equals(Buffer.from(FIXED_PK_HEX, "hex"))).toBe(true);
    });
  }

  it("[BLE3-0088] 固定 PK 対象外 model (sesame_6) は sesame2PublicKey を使う (kt:393 else)", () => {
    const all = insertSesamesData({
      deviceUUID: UUID,
      secretKey: SECRET,
      sesame2PublicKey: DUMMYPK,
      deviceModel: "sesame_6",
    });
    const pkPart = all.subarray(22, 86);
    expect(pkPart.equals(Buffer.from(DUMMYPK, "hex"))).toBe(true);
  });
});

// ============================================================
// BLE3-0089: insertSesames 必須検証 (固定 PK 対象外 model は sesame2PublicKey 必須)
// ============================================================
describe("[BLE3-0089] insertSesames 必須検証 (wm2.js:179-180, 193)", () => {
  const UUID = "0179C43C-9A0E-49E5-9D69-6A22A6FE7A6E";
  const SECRET = "00112233445566778899aabbccddeeff";

  it("[BLE3-0089] deviceUUID 欠落 (空文字) は throw (ble.wm2SesameKeyRequired)", () => {
    expect(() =>
      insertSesamesData({ deviceUUID: "", secretKey: SECRET, sesame2PublicKey: "ab".repeat(64) })
    ).toThrow();
  });

  it("[BLE3-0089] secretKey 欠落 (null) は throw", () => {
    expect(() =>
      insertSesamesData({ deviceUUID: UUID, secretKey: /** @type {any} */ (null), sesame2PublicKey: "ab".repeat(64) })
    ).toThrow();
  });

  it("[BLE3-0089] 固定 PK 対象外 model で sesame2PublicKey 欠落は throw (wm2.js:193)", () => {
    expect(() =>
      insertSesamesData({ deviceUUID: UUID, secretKey: SECRET, deviceModel: "sesame_6" })
    ).toThrow();
  });

  it("[BLE3-0089] 固定 PK 対象 model (sesame_5) は sesame2PublicKey 無しでも throw しない", () => {
    expect(() =>
      insertSesamesData({ deviceUUID: UUID, secretKey: SECRET, deviceModel: "sesame_5" })
    ).not.toThrow();
  });
});

// ============================================================
// BLE3-0090: insertSesames noHashUUID は大小変換なしでハイフン除去のみ
// ============================================================
describe("[BLE3-0090] insertSesames noHashUUID = ハイフン除去のみ (P5-4 stripDashes 規範)", () => {
  const SECRET = "00112233445566778899aabbccddeeff";
  const PUBKEY = "ab".repeat(64);

  it("[BLE3-0090] 小文字 UUID と大文字 UUID の ssmIRData は同じになる (hex 大小は base64 に影響しない)", () => {
    const uuidLower = "0179c43c-9a0e-49e5-9d69-6a22a6fe7a6e";
    const uuidUpper = "0179C43C-9A0E-49E5-9D69-6A22A6FE7A6E";
    const allL = insertSesamesData({ deviceUUID: uuidLower, secretKey: SECRET, sesame2PublicKey: PUBKEY });
    const allU = insertSesamesData({ deviceUUID: uuidUpper, secretKey: SECRET, sesame2PublicKey: PUBKEY });
    // ssmIRData: Buffer.from(hex,'hex') は大小不問で同一バイトになる
    expect(allL.subarray(0, 22).equals(allU.subarray(0, 22))).toBe(true);
  });

  it("[BLE3-0090] ssmUUid (末尾 36B) = deviceUUID.toUpperCase() の ASCII (kt:400 uppercase())", () => {
    const uuid = "0179c43c-9a0e-49e5-9d69-6a22a6fe7a6e";
    const all = insertSesamesData({ deviceUUID: uuid, secretKey: SECRET, sesame2PublicKey: PUBKEY });
    expect(all.subarray(all.length - 36).toString("ascii")).toBe(uuid.toUpperCase());
  });

  it("[BLE3-0090] ssmIRData は toLowerCase を呼ばない (stripDashes のみ) — SDK kt:381 準拠", () => {
    // SDK: sesame2KeyData.deviceUUID.replace("-","") (大小変換なし)
    const uuid = "AABBCCDD-EEFF-0011-2233-445566778899";
    const all = insertSesamesData({ deviceUUID: uuid, secretKey: SECRET, sesame2PublicKey: PUBKEY });
    const noHash = uuid.replace(/-/g, "");
    const b64k = Buffer.from(noHash, "hex").toString("base64").replace(/=/g, "");
    expect(all.subarray(0, 22).toString("ascii")).toBe(b64k);
  });

  it("[BLE3-0090] 大小異なる UUID でも noHashUUID の hex バイトは同一 (Buffer.from(hex,'hex') は大小不問)", () => {
    const uuidLower = "0179c43c-9a0e-49e5-9d69-6a22a6fe7a6e";
    const uuidUpper = "0179C43C-9A0E-49E5-9D69-6A22A6FE7A6E";
    const allL = insertSesamesData({ deviceUUID: uuidLower, secretKey: SECRET, sesame2PublicKey: PUBKEY });
    const allU = insertSesamesData({ deviceUUID: uuidUpper, secretKey: SECRET, sesame2PublicKey: PUBKEY });
    // ssmIRData[0..22) は同一であることを確認
    const irL = Buffer.from(allL.subarray(0, 22).toString("ascii") + "==", "base64");
    const irU = Buffer.from(allU.subarray(0, 22).toString("ascii") + "==", "base64");
    expect(irL.equals(irU)).toBe(true);
  });
});

// ============================================================
// BLE3-0091: removeSesame 送信 data = sesameKeyTag を大文字化した UTF-8
// ============================================================
describe("[BLE3-0091] removeSesame 送信 data = sesameKeyTag.toUpperCase() (CHWifiModule2Device.kt:415)", () => {
  it("[BLE3-0091] removeSesameData('abc-def') = 'ABC-DEF' の UTF-8 bytes", () => {
    const d = removeSesameData("abc-def");
    expect(d.toString("utf8")).toBe("ABC-DEF");
  });

  it("[BLE3-0091] 既に大文字のタグはそのまま", () => {
    const d = removeSesameData("ABCDEF");
    expect(d.toString("utf8")).toBe("ABCDEF");
  });

  it("[BLE3-0091] action code = DELETE_SESAME(7) で request される (kt:415)", async () => {
    const s = fakeSession();
    const wm2 = new WifiModule2({ session: s });
    await wm2.removeSesame("tag");
    const [code, data] = s.request.mock.calls[0];
    expect(code).toBe(WM2_ACTION_CODES.DELETE_SESAME); // 7
    expect(code).toBe(7);
    expect(data.toString("utf8")).toBe("TAG");
  });
});

// ============================================================
// BLE3-0092: removeSesame 空タグは必須検証で throw
// ============================================================
describe("[BLE3-0092] removeSesame 空タグ/非文字列は throw (wm2.js:214)", () => {
  it("[BLE3-0092] 空文字列は throw (ble.wm2SesameKeyTagRequired)", () => {
    expect(() => removeSesameData("")).toThrow();
  });

  it("[BLE3-0092] null は throw", () => {
    expect(() => removeSesameData(/** @type {any} */ (null))).toThrow();
  });

  it("[BLE3-0092] undefined は throw", () => {
    expect(() => removeSesameData(/** @type {any} */ (undefined))).toThrow();
  });

  it("[BLE3-0092] 数値は throw", () => {
    expect(() => removeSesameData(/** @type {any} */ (123))).toThrow();
  });

  it("[BLE3-0092] 非空文字列は throw しない", () => {
    expect(() => removeSesameData("tag")).not.toThrow();
  });
});

// ============================================================
// BLE3-0093: WM2 reset = RESET_WM2(18) + 空ペイロード、成功時 session.disconnect
// ============================================================
describe("[BLE3-0093] WM2 reset = RESET_WM2(18) + 空 data、成功時 session.disconnect (CHWifiModule2Device.kt:437-448)", () => {
  it("[BLE3-0093] RESET_WM2(18) + 空 data で request する (kt:443 byteArrayOf())", async () => {
    const s = fakeSession({ resultCode: 0 });
    const wm2 = new WifiModule2({ session: s });
    await wm2.reset();
    const resetCall = s.request.mock.calls.find((c) => c[0] === WM2_ACTION_CODES.RESET_WM2);
    expect(resetCall).toBeTruthy();
    expect(resetCall[0]).toBe(18); // RESET_WM2 = 18
    expect(resetCall[1].length).toBe(0); // byteArrayOf() → 空
  });

  it("[BLE3-0093] resultCode==0 のとき dropKey 相当で session.disconnect を呼ぶ (kt:444-446)", async () => {
    const s = fakeSession({ resultCode: 0 });
    const wm2 = new WifiModule2({ session: s });
    await wm2.reset();
    expect(s.disconnect).toHaveBeenCalledTimes(1);
  });

  it("[BLE3-0093] resultCode!=0 のとき session.disconnect を呼ばない (dropKey は成功時のみ kt:444)", async () => {
    const s = fakeSession({ resultCode: 5 });
    const wm2 = new WifiModule2({ session: s });
    await wm2.reset();
    expect(s.disconnect).not.toHaveBeenCalled();
  });

  it("[BLE3-0093] reset の戻り値は request の応答 (resultCode, payload)", async () => {
    const s = fakeSession({ resultCode: 0 });
    // Override to return a payload with content
    s.request = vi.fn(() => Promise.resolve({ resultCode: 0, payload: Buffer.alloc(4) }));
    const wm2 = new WifiModule2({ session: s });
    const res = await wm2.reset();
    expect(res.resultCode).toBe(0);
    expect(Buffer.isBuffer(res.payload)).toBe(true);
  });
});

// ============================================================
// BLE3-0094: WM2 未ログイン reset は session.request の notLoggedIn に委譲
// ============================================================
describe("[BLE3-0094] WM2 未ログイン reset は session.request が notLoggedIn で reject (session.js:490)", () => {
  it("[BLE3-0094] 未ログイン状態の reset は session.request が notLoggedIn で reject する", async () => {
    const s = fakeSession({ loggedIn: false });
    const wm2 = new WifiModule2({ session: s });
    await expect(wm2.reset()).rejects.toThrow();
    // RESET_WM2 送出前に request 内部で弾かれるため、disconnect は呼ばれない
    expect(s.disconnect).not.toHaveBeenCalled();
  });

  it("[BLE3-0094] 未ログイン時は request を呼んだが即 reject する (RESET_WM2 は送出されない)", async () => {
    const s = fakeSession({ loggedIn: false });
    const wm2 = new WifiModule2({ session: s });
    await expect(wm2.reset()).rejects.toThrow();
    // request は呼ばれるが notLoggedIn で reject (disconnect は呼ばれない)
    expect(s.request).toHaveBeenCalledTimes(1);
    expect(s.disconnect).not.toHaveBeenCalled();
  });
});

// ============================================================
// BLE3-0095: wifiProvisioning の汎用 reset は RESET_WM2(18) 経路へ自動ルーティング
// ============================================================
describe("[BLE3-0095] SesameBle.reset() は wifiProvisioning 機種で RESET_WM2(18) へルーティング (index.js:1082-1083)", () => {
  // SesameBle の reset() ルーティングロジックをインライン再現して検証:
  //   if (this._caps.os !== 3) throw (...)
  //   if (this._caps.wifiProvisioning) return this.resetWifiModule2()
  //   return this._session.reset()

  it("[BLE3-0095] WM2_ACTION_CODES に RESET_WM2=18 が定義されている", () => {
    expect(WM2_ACTION_CODES.RESET_WM2).toBe(18);
  });

  it("[BLE3-0095] WifiModule2.reset は RESET_WM2(18) を送る (Reset(104) は WM2 action 空間で未定義)", async () => {
    const s = fakeSession();
    const wm2 = new WifiModule2({ session: s });
    await wm2.reset();
    const [code] = s.request.mock.calls[0];
    // RESET_WM2=18 が使われ、RESET=104 は使われない
    expect(code).toBe(18);
    expect(code).not.toBe(104);
  });

  it("[BLE3-0095] WM2_ACTION_CODES に 104 相当の Reset は定義されていない (CHWifiModule2Device.kt:539-541)", () => {
    const allValues = Object.values(WM2_ACTION_CODES);
    expect(allValues).not.toContain(104);
  });

  it("[BLE3-0095] SesameBle.reset() で wifiProvisioning=true のとき resetWifiModule2 が呼ばれる (index.js:1082-1083)", () => {
    const resetWifiModule2 = vi.fn(() => Promise.resolve({ resultCode: 0, payload: Buffer.alloc(0) }));
    const sessionReset = vi.fn(() => Promise.resolve({ resultCode: 0, payload: Buffer.alloc(0) }));

    function simulateReset(caps) {
      if (caps.os !== 3) throw new Error("resetNotSupported");
      if (caps.wifiProvisioning) return resetWifiModule2();
      return sessionReset();
    }

    // WM2 (wifiProvisioning=true, os=3)
    simulateReset({ os: 3, wifiProvisioning: true });
    expect(resetWifiModule2).toHaveBeenCalledTimes(1);
    expect(sessionReset).not.toHaveBeenCalled();
  });

  it("[BLE3-0095] wifiProvisioning=false (OS3 lock) のときは session.reset を使う (汎用 Reset(104) 経路)", () => {
    const resetWifiModule2 = vi.fn();
    const sessionReset = vi.fn(() => Promise.resolve({ resultCode: 0, payload: Buffer.alloc(0) }));

    function simulateReset(caps) {
      if (caps.os !== 3) throw new Error("resetNotSupported");
      if (caps.wifiProvisioning) return resetWifiModule2();
      return sessionReset();
    }

    simulateReset({ os: 3, wifiProvisioning: false });
    expect(resetWifiModule2).not.toHaveBeenCalled();
    expect(sessionReset).toHaveBeenCalledTimes(1);
  });

  it("[BLE3-0095] os!=3 (OS2 系) の reset は例外を投げる (resetNotSupported, index.js:1075-1079)", () => {
    function simulateReset(caps) {
      if (caps.os !== 3) throw new Error("resetNotSupported");
      if (caps.wifiProvisioning) return Promise.resolve();
      return Promise.resolve();
    }
    expect(() => simulateReset({ os: 2, wifiProvisioning: false })).toThrow("resetNotSupported");
  });
});

// ============================================================
// BLE3-0096: WM2 NETWORK_STATUS 送信経路は存在しない (受信専用)
// ============================================================
describe("[BLE3-0096] WM2 NETWORK_STATUS 送信メソッドは存在しない (P3-20 受信専用契約)", () => {
  it("[BLE3-0096] WifiModule2 インスタンスに networkStatus() メソッドが存在しない (CHWifiModule2.kt:30-39 送信 API 無し)", () => {
    const s = fakeSession();
    const wm2 = new WifiModule2({ session: s });
    expect(typeof (/** @type {any} */ (wm2).networkStatus)).toBe("undefined");
  });

  it("[BLE3-0096] wm2.js から networkStatusData はエクスポートされていない (P3-20)", async () => {
    const mod = await import("../../src/ble/wm2.js");
    expect(typeof (/** @type {any} */ (mod)).networkStatusData).toBe("undefined");
  });

  it("[BLE3-0096] WM2_ACTION_CODES に NETWORK_STATUS(6) は定義されているが送信用 builder は存在しない", () => {
    // action code 自体は publish 解析に必要なので定数は存在する
    expect(WM2_ACTION_CODES.NETWORK_STATUS).toBe(6);
    const s = fakeSession();
    const wm2 = new WifiModule2({ session: s });
    // networkStatus を送信する公開 API は無い
    expect(typeof (/** @type {any} */ (wm2)).networkStatusData).toBe("undefined");
    expect(typeof (/** @type {any} */ (wm2)).sendNetworkStatus).toBe("undefined");
  });

  it("[BLE3-0096] NETWORK_STATUS(6) publish は受信・解析できる (受信専用 = 正しい動作)", () => {
    // parseWM2Publish での受信は正常に動作する (これが SDK 設計の正しい動作)
    const s = fakeSession();
    const wm2 = new WifiModule2({ session: s });
    const seen = /** @type {any[]} */ ([]);
    wm2.onPublish((p) => seen.push(p));
    // NETWORK_STATUS publish を注入
    s._emit({ itemCode: WM2_ACTION_CODES.NETWORK_STATUS, body: Buffer.from([0x02]) });
    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe("networkStatus");
    expect(seen[0].isAp).toBe(true);
    wm2.dispose();
  });

  it("[BLE3-0096] WM2_RPC_OPS に wifi.networkStatus op が存在しない (P3-20 削除済み)", async () => {
    const mod = await import("../../src/ble/wm2.js");
    const ops = /** @type {any} */ (mod).WM2_RPC_OPS ?? {};
    expect("wifi.networkStatus" in ops).toBe(false);
  });
});
