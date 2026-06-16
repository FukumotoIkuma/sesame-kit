// BLE3-0115..BLE3-0133: Hub3 publish ディスパッチ・wifi 共有・card/passcode write バイト列テスト
//
// 対象実装:
//   packages/core/src/ble/hub3.js
//   packages/core/src/ble/biometric.js
//   packages/core/src/ble/rpc-helpers.js
//   packages/core/src/ble/wm2.js
//   packages/core/src/itemcodes.js

import { describe, it, expect, vi } from "vitest";
import { Buffer } from "node:buffer";
import {
  parseSesameKeys,
  parseHub3Publish,
  parseNetworkType,
  Hub3Commands,
} from "../../src/ble/hub3.js";
import {
  cardAddData,
  passcodeAddData,
  cardDeleteData,
  passcodeDeleteData,
  cardMoveData,
  passcodeMoveData,
  cardChangeData,
  passcodeChangeData,
  cardChangeValueData,
} from "../../src/ble/biometric.js";
import { WifiModule2 } from "../../src/ble/wm2.js";
import { wifiViewOf, collectWifiScan } from "../../src/ble/rpc-helpers.js";
import { ITEM_CODES, UNVERIFIED_ITEM_CODES } from "../../src/itemcodes.js";

// ── ヘルパ ────────────────────────────────────────────────────────────────

/**
 * 最小限の SesameBleSession スタブ (Hub3Commands / WifiModule2 向け)。
 * session.request は即時 resolve、onPublish は Set で管理し _emit で手動発火できる。
 */
function makeSession() {
  const listeners = new Set();
  return {
    request: vi.fn().mockResolvedValue({ resultCode: 0, payload: Buffer.alloc(0) }),
    onPublish(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    _emit(pub) {
      for (const fn of listeners) fn(pub);
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════
// BLE3-0115: Hub3 PUB_KEY_SESAME(102) publish = 23B チャンク・生16B UUID・status!=0 のみ
// ══════════════════════════════════════════════════════════════════════════

describe("[BLE3-0115] parseSesameKeys: 23B チャンク・生16B UUID・status!=0 のみ返す", () => {
  it("[BLE3-0115] status=0 のエントリは除外し status!=0 のみ返す (index は全体採番)", () => {
    // 3 エントリ: index 0=status 0(除外), index 1=status 1(含), index 2=status 2(含)
    const e0 = Buffer.alloc(23, 0x00); // status=0 → skip
    const e1 = Buffer.alloc(23, 0xaa);
    e1.fill(0xbb, 0, 16);  // ss5_id: 16B = 0xbb...
    e1[22] = 1;             // lockStatus=1
    const e2 = Buffer.alloc(23, 0xcc);
    e2.fill(0xdd, 0, 16);  // ss5_id: 16B = 0xdd...
    e2[22] = 2;             // lockStatus=2

    const payload = Buffer.concat([e0, e1, e2]);
    const result = parseSesameKeys(payload);

    expect(result).toHaveLength(2);
    // index は全エントリで採番 (forEachIndexed 相当) → e1=index 1, e2=index 2
    expect(result[0].index).toBe(1);
    expect(result[1].index).toBe(2);
    // deviceUUID は先頭16B を hex→ハイフン付き UUID で返す
    expect(result[0].deviceUUID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    // 内容確認: e1 の先頭16B=0xbb
    expect(result[0].deviceUUID.replace(/-/g, "")).toBe("bb".repeat(16));
    expect(result[1].deviceUUID.replace(/-/g, "")).toBe("dd".repeat(16));
  });

  it("[BLE3-0115] 全エントリ status=0 なら空配列を返す", () => {
    const payload = Buffer.concat([Buffer.alloc(23, 0x00), Buffer.alloc(23, 0x00)]);
    expect(parseSesameKeys(payload)).toEqual([]);
  });

  it("[BLE3-0115] 23B 未満の端数は無視 (divideArray(23) の切り捨て相当)", () => {
    // 1エントリ(23B) + 端数5B
    const e = Buffer.alloc(23, 0xff);
    e[22] = 3;
    const payload = Buffer.concat([e, Buffer.alloc(5, 0x01)]);
    const result = parseSesameKeys(payload);
    expect(result).toHaveLength(1);
    expect(result[0].index).toBe(0);
  });

  it("[BLE3-0115] WM2 base64 経路と異なり Hub3 は先頭16B を生 UUID バイトとして使う", () => {
    const id16 = Buffer.from("aabbccddeeff00112233445566778899", "hex");
    const chunk = Buffer.concat([id16, Buffer.alloc(6), Buffer.from([1])]); // status=1
    const keys = parseSesameKeys(chunk);
    expect(keys).toHaveLength(1);
    expect(keys[0].deviceUUID).toBe("aabbccdd-eeff-0011-2233-445566778899");
    expect(keys[0].index).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// BLE3-0116: Hub3 MOVE_TO(84) publish = OTA 進捗 1B
// ══════════════════════════════════════════════════════════════════════════

describe("[BLE3-0116] parseHub3Publish: MOVE_TO(84) → {kind:'otaProgress', progress}", () => {
  it("[BLE3-0116] MOVE_TO publish の payload.first() を progress として返す (CHHub3Device.kt:320-322)", () => {
    const pub = { itemCode: ITEM_CODES.MOVE_TO, body: Buffer.from([42]) };
    const result = parseHub3Publish(pub);
    expect(result.kind).toBe("otaProgress");
    expect(result.progress).toBe(42);
  });

  it("[BLE3-0116] 空 payload のとき progress=0 (防御的フォールバック)", () => {
    const pub = { itemCode: ITEM_CODES.MOVE_TO, body: Buffer.alloc(0) };
    const result = parseHub3Publish(pub);
    expect(result.kind).toBe("otaProgress");
    expect(result.progress).toBe(0);
  });

  it("[BLE3-0116] MOVE_TO=84 が SDK 値と一致する", () => {
    expect(ITEM_CODES.MOVE_TO).toBe(84);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// BLE3-0117: Hub3 parseHub3Publish の itemCode ディスパッチ網羅と unknown fallback
// ══════════════════════════════════════════════════════════════════════════

describe("[BLE3-0117] parseHub3Publish: itemCode ディスパッチ網羅と unknown fallback", () => {
  it("[BLE3-0117] MECH_SETTING(80) → {kind:'mechSetting'}", () => {
    // 60B の旧ファームウェア形式 (ssid 30B + pwd 30B)
    const buf = Buffer.alloc(60, 0x00);
    Buffer.from("myssid", "utf8").copy(buf, 0);
    const r = parseHub3Publish({ itemCode: ITEM_CODES.MECH_SETTING, body: buf });
    expect(r.kind).toBe("mechSetting");
  });

  it("[BLE3-0117] MECH_STATUS(81) → {kind:'networkStatus'} (Hub3 では networkStatus, CHHub3Device.kt:291-301)", () => {
    const r = parseHub3Publish({ itemCode: ITEM_CODES.MECH_STATUS, body: Buffer.from([0b00000010]) });
    expect(r.kind).toBe("networkStatus");
  });

  it("[BLE3-0117] PUB_KEY_SESAME(102) → {kind:'sesameKeys'}", () => {
    const r = parseHub3Publish({ itemCode: ITEM_CODES.PUB_KEY_SESAME, body: Buffer.alloc(0) });
    expect(r.kind).toBe("sesameKeys");
    expect(Array.isArray(r.keys)).toBe(true);
  });

  it("[BLE3-0117] MOVE_TO(84) → {kind:'otaProgress'}", () => {
    const r = parseHub3Publish({ itemCode: ITEM_CODES.MOVE_TO, body: Buffer.from([99]) });
    expect(r.kind).toBe("otaProgress");
  });

  it("[BLE3-0117] HUB3_ITEM_CODE_SSID_NOTIFY(133) → {kind:'scanWifiSSID'}", () => {
    const body = Buffer.concat([Buffer.from([0xce, 0xff]), Buffer.from("TestAP", "utf8")]);
    const r = parseHub3Publish({ itemCode: ITEM_CODES.HUB3_ITEM_CODE_SSID_NOTIFY, body });
    expect(r.kind).toBe("scanWifiSSID");
  });

  it("[BLE3-0117] SSID_FIRST(132) → {kind:'ssidMarker'} (SDK は no-op, impl は marker 返し)", () => {
    const r = parseHub3Publish({ itemCode: ITEM_CODES.HUB3_ITEM_CODE_SSID_FIRST, body: Buffer.alloc(0) });
    expect(r.kind).toBe("ssidMarker");
    expect(r.itemCode).toBe(ITEM_CODES.HUB3_ITEM_CODE_SSID_FIRST);
  });

  it("[BLE3-0117] SSID_LAST(134) → {kind:'ssidMarker'} (SDK は no-op)", () => {
    const r = parseHub3Publish({ itemCode: ITEM_CODES.HUB3_ITEM_CODE_SSID_LAST, body: Buffer.alloc(0) });
    expect(r.kind).toBe("ssidMarker");
    expect(r.itemCode).toBe(ITEM_CODES.HUB3_ITEM_CODE_SSID_LAST);
  });

  it("[BLE3-0117] NETWORK_TYPE(209) → {kind:'networkType'} (@experimental 別経路, UNVERIFIED_ITEM_CODES 隔離)", () => {
    const r = parseHub3Publish({
      itemCode: UNVERIFIED_ITEM_CODES.HUB3_ITEM_CODE_NETWORK_TYPE,
      body: Buffer.from([1, 0]),
    });
    expect(r.kind).toBe("networkType");
  });

  it("[BLE3-0117] 未知 itemCode → {kind:'unknown'}", () => {
    const r = parseHub3Publish({ itemCode: 9999, body: Buffer.from([0xab]) });
    expect(r.kind).toBe("unknown");
    expect(r.itemCode).toBe(9999);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// BLE3-0119: Hub3 parseNetworkType payload = [isWifiConnected 1B][isLTEConnected 1B]
// ══════════════════════════════════════════════════════════════════════════

describe("[BLE3-0119] parseNetworkType: 2B payload を解析・2B 未満は throw", () => {
  it("[BLE3-0119] payload[0]==1→isWifiConnected / payload[1]==1→isLTEConnected (hub3.js:152-159)", () => {
    expect(parseNetworkType(Buffer.from([1, 0]))).toEqual({ isWifiConnected: true, isLTEConnected: false });
    expect(parseNetworkType(Buffer.from([0, 1]))).toEqual({ isWifiConnected: false, isLTEConnected: true });
    expect(parseNetworkType(Buffer.from([1, 1]))).toEqual({ isWifiConnected: true, isLTEConnected: true });
    expect(parseNetworkType(Buffer.from([0, 0]))).toEqual({ isWifiConnected: false, isLTEConnected: false });
  });

  it("[BLE3-0119] 1 以外の値は false", () => {
    expect(parseNetworkType(Buffer.from([2, 3]))).toEqual({ isWifiConnected: false, isLTEConnected: false });
  });

  it("[BLE3-0119] 1B payload → hub3NetworkTypeShort で throw", () => {
    expect(() => parseNetworkType(Buffer.from([1]))).toThrow();
  });

  it("[BLE3-0119] 空 payload → hub3NetworkTypeShort で throw", () => {
    expect(() => parseNetworkType(Buffer.alloc(0))).toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// BLE3-0120: collectWifiScan — SSID 重複統合・Hub3 SSID_LAST 早期確定/WM2 打ち切り
// ══════════════════════════════════════════════════════════════════════════

describe("[BLE3-0120] collectWifiScan: SSID 収集・重複統合・Hub3 SSID_LAST 早期確定", () => {
  it("[BLE3-0120] Hub3: SSID_LAST マーカーで早期確定し同一 SSID は rssi を更新 (CHHub3Device.kt:325)", async () => {
    const listeners = new Set();
    const view = {
      onPublish(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      scanWifiSSID: vi.fn().mockResolvedValue({}),
    };

    const scanPromise = collectWifiScan(view, { collectMs: 5000 });

    // 2件のSSIDを publish (HomeNet は重複でrssi上書き)
    for (const fn of listeners) fn({ kind: "scanWifiSSID", ssid: "HomeNet", rssi: -70 });
    for (const fn of listeners) fn({ kind: "scanWifiSSID", ssid: "WorkNet", rssi: -80 });
    for (const fn of listeners) fn({ kind: "scanWifiSSID", ssid: "HomeNet", rssi: -65 }); // rssi 更新
    // SSID_LAST マーカーで早期確定
    for (const fn of listeners) fn({ kind: "ssidMarker", itemCode: ITEM_CODES.HUB3_ITEM_CODE_SSID_LAST });

    const result = await scanPromise;
    expect(result.ssids).toHaveLength(2);
    const homeNet = result.ssids.find((s) => s.ssid === "HomeNet");
    expect(homeNet).toBeDefined();
    expect(homeNet.rssi).toBe(-65); // rssi が更新された
  });

  it("[BLE3-0120] WM2: collectMs タイムアウトで打ち切る (SSID_LAST が来ない場合)", async () => {
    const listeners = new Set();
    const view = {
      onPublish(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      scanWifiSSID: vi.fn().mockResolvedValue({}),
    };

    const scanPromise = collectWifiScan(view, { collectMs: 50 }); // 短いタイムアウト
    for (const fn of listeners) fn({ kind: "scanWifiSSID", ssid: "OpenNet", rssi: -55 });

    const result = await scanPromise;
    expect(result.ssids).toHaveLength(1);
    expect(result.ssids[0].ssid).toBe("OpenNet");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// BLE3-0121: collectWifiScan — scanWifiSSID ack 失敗は収集を打ち切って伝搬
// ══════════════════════════════════════════════════════════════════════════

describe("[BLE3-0121] collectWifiScan: scanWifiSSID ack 失敗は収集を打ち切り error を伝搬", () => {
  it("[BLE3-0121] scanWifiSSID が reject したとき collectWifiScan も reject する (rpc-helpers.js:154-160)", async () => {
    const scanError = new Error("BleResultError: scan failed");
    const listeners = new Set();
    const view = {
      onPublish(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      scanWifiSSID: vi.fn().mockRejectedValue(scanError),
    };

    await expect(collectWifiScan(view, { collectMs: 5000 })).rejects.toThrow("scan failed");
  });
});

// ══════════════════════════════════════════════════════════════════════════
// BLE3-0122: wifiViewOf — model 能力で WM2/Hub3 を判別し非対応は bad_params
// ══════════════════════════════════════════════════════════════════════════

describe("[BLE3-0122] wifiViewOf: model 能力で WM2/Hub3 を判別・非対応は bad_params", () => {
  function makeBle({ wifiProvisioning = false, hubProvisioning = false } = {}) {
    return {
      capabilities: { wifiProvisioning, hubProvisioning, label: "test-device" },
      wifi: vi.fn().mockReturnValue({ scanWifiSSID: vi.fn(), onPublish: vi.fn() }),
      hub3: vi.fn().mockReturnValue({ scanWifiSSID: vi.fn(), onPublish: vi.fn() }),
    };
  }

  it("[BLE3-0122] wifiProvisioning=true → type='wm2' (rpc-helpers.js:114)", () => {
    const ble = makeBle({ wifiProvisioning: true });
    const { type } = wifiViewOf(ble);
    expect(type).toBe("wm2");
    expect(ble.wifi).toHaveBeenCalled();
  });

  it("[BLE3-0122] hubProvisioning=true → type='hub3' (rpc-helpers.js:115)", () => {
    const ble = makeBle({ hubProvisioning: true });
    const { type } = wifiViewOf(ble);
    expect(type).toBe("hub3");
    expect(ble.hub3).toHaveBeenCalled();
  });

  it("[BLE3-0122] 両方 false → bad_params (RpcError) を throw (rpc-helpers.js:116)", () => {
    const ble = makeBle({ wifiProvisioning: false, hubProvisioning: false });
    expect(() => wifiViewOf(ble)).toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// BLE3-0123: WifiModule2/Hub3Commands が session publish を正規化中継し dispose で外す
// ══════════════════════════════════════════════════════════════════════════

describe("[BLE3-0123] WifiModule2/Hub3Commands: session publish 正規化中継・dispose 冪等", () => {
  it("[BLE3-0123] Hub3Commands が session publish を parseHub3Publish で正規化して購読者へ中継する", () => {
    const session = makeSession();
    const hub3 = new Hub3Commands({ session });
    const received = [];
    hub3.onPublish((p) => received.push(p));

    // MOVE_TO publish を session 経由で emit
    session._emit({ itemCode: ITEM_CODES.MOVE_TO, body: Buffer.from([77]) });

    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe("otaProgress");
    expect(received[0].progress).toBe(77);
    hub3.dispose();
  });

  it("[BLE3-0123] Hub3Commands: dispose 後は publish が届かない", () => {
    const session = makeSession();
    const hub3 = new Hub3Commands({ session });
    const received = [];
    hub3.onPublish((p) => received.push(p));
    hub3.dispose();

    session._emit({ itemCode: ITEM_CODES.MOVE_TO, body: Buffer.from([99]) });
    expect(received).toHaveLength(0);
  });

  it("[BLE3-0123] Hub3Commands: dispose を複数回呼んでもエラーにならない (冪等, hub3.js:328)", () => {
    const session = makeSession();
    const hub3 = new Hub3Commands({ session });
    expect(() => { hub3.dispose(); hub3.dispose(); hub3.dispose(); }).not.toThrow();
  });

  it("[BLE3-0123] WifiModule2 も session publish を正規化中継する (wm2.js:378-393)", () => {
    const session = makeSession();
    const wm2 = new WifiModule2({ session });
    const received = [];
    wm2.onPublish((p) => received.push(p));

    // WM2 の NETWORK_STATUS(6) publish
    session._emit({ itemCode: 6, body: Buffer.from([0b00000010]) });
    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe("networkStatus");
    wm2.dispose();
  });

  it("[BLE3-0123] WifiModule2: dispose 後は publish が届かない", () => {
    const session = makeSession();
    const wm2 = new WifiModule2({ session });
    const received = [];
    wm2.onPublish((p) => received.push(p));
    wm2.dispose();

    session._emit({ itemCode: 6, body: Buffer.from([0b00000010]) });
    expect(received).toHaveLength(0);
  });

  it("[BLE3-0123] 購読者の例外が他の購読者へ波及しない (hub3.js:320)", () => {
    const session = makeSession();
    const hub3 = new Hub3Commands({ session });
    const received = [];
    hub3.onPublish(() => { throw new Error("listener error"); });
    hub3.onPublish((p) => received.push(p));

    expect(() => session._emit({ itemCode: ITEM_CODES.MOVE_TO, body: Buffer.from([10]) })).not.toThrow();
    expect(received).toHaveLength(1);
    hub3.dispose();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// BLE3-0124: WifiModule2/Hub3Commands は session 無しで構築 throw
// ══════════════════════════════════════════════════════════════════════════

describe("[BLE3-0124] WifiModule2/Hub3Commands: session 無しで構築すると throw", () => {
  it("[BLE3-0124] Hub3Commands: session 未指定で ble.hub3SessionRequired を throw (hub3.js:312)", () => {
    expect(() => new Hub3Commands()).toThrow();
  });

  it("[BLE3-0124] Hub3Commands: session=null で throw", () => {
    expect(() => new Hub3Commands({ session: null })).toThrow();
  });

  it("[BLE3-0124] WifiModule2: session 未指定で ble.wm2SessionRequired を throw (wm2.js:369)", () => {
    expect(() => new WifiModule2()).toThrow();
  });

  it("[BLE3-0124] WifiModule2: session=undefined で throw", () => {
    expect(() => new WifiModule2({ session: undefined })).toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// BLE3-0125: cardAdd payload = [F0][00][idLen] ++ id.padEnd(16) ++ [nameLen] ++ name.padEnd(16)
// ══════════════════════════════════════════════════════════════════════════

describe("[BLE3-0125] cardAddData: [F0][00][idLen] ++ id.padEnd(16) ++ [nameLen] ++ name.padEnd(16)", () => {
  it("[BLE3-0125] 固定ヘッダ F0/00 + idLen/nameLen と 16B パディング (CHCardCapableImpl.kt:83-91)", () => {
    const id = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const name = "abc"; // UTF-8 3B
    const result = cardAddData(id, name);

    // 固定ヘッダ
    expect(result[0]).toBe(0xf0); // CARD_DATA_USED
    expect(result[1]).toBe(0x00); // TYPE_CLOUD_BASE
    expect(result[2]).toBe(4);    // idLen=4
    // id 16B 枠 (4B + 12B zeros)
    expect(result.subarray(3, 7)).toEqual(Buffer.from([0x01, 0x02, 0x03, 0x04]));
    expect(result.subarray(7, 19)).toEqual(Buffer.alloc(12, 0x00));
    // nameLen = 3 (UTF-8 "abc" = 3B)
    expect(result[19]).toBe(3);
    // name 16B 枠 (3B + 13B zeros)
    expect(result.subarray(20, 23)).toEqual(Buffer.from("abc", "utf8"));
    expect(result.subarray(23, 36)).toEqual(Buffer.alloc(13, 0x00));
    // 合計長: 3(header) + 16(id枠) + 1(nameLen) + 16(name枠) = 36B
    expect(result.length).toBe(36);
  });

  it("[BLE3-0125] id が 16B 以上なら切らずそのまま (padEnd は伸長のみ)", () => {
    const id16 = Buffer.alloc(16, 0xaa);
    const result = cardAddData(id16, "name");
    expect(result[2]).toBe(16); // idLen
    expect(result.subarray(3, 19)).toEqual(id16); // そのまま
  });

  it("[BLE3-0125] CARD_ADD itemCode=140 が SDK 値と一致 (SesameProtocols.kt:40)", () => {
    expect(ITEM_CODES.CARD_ADD).toBe(140);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// BLE3-0126: passcodeAdd payload = [F0][00][idLen] ++ id.padEnd(16) ++ [nameLen] ++ name.padEnd(16)
// ══════════════════════════════════════════════════════════════════════════

describe("[BLE3-0126] passcodeAddData: card と同一レイアウト (KB_* 定数)", () => {
  it("[BLE3-0126] passcodeAddData と cardAddData は同一レイアウト (CHPassCodeCapableImpl.kt:44-49)", () => {
    const id = Buffer.from([0x10, 0x20]);
    const hexName = "PIN";
    const cardResult = cardAddData(id, hexName);
    const passcodeResult = passcodeAddData(id, hexName);
    // バイト列が完全一致 (定数名のみ異なる KB_DATA_USED=0xF0/KB_TYPE_CLOUD=0x00)
    expect(passcodeResult).toEqual(cardResult);
  });

  it("[BLE3-0126] 固定ヘッダ F0/00 が KB_DATA_USED/KB_TYPE_CLOUD と同値", () => {
    const id = Buffer.from([0xab]);
    const result = passcodeAddData(id, "test");
    expect(result[0]).toBe(0xf0); // KB_DATA_USED
    expect(result[1]).toBe(0x00); // KB_TYPE_CLOUD
  });

  it("[BLE3-0126] PASSCODE_ADD itemCode=138 が SDK 値と一致 (SesameProtocols.kt:40)", () => {
    expect(ITEM_CODES.PASSCODE_ADD).toBe(138);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// BLE3-0127: cardDelete payload = cardID(hex→bytes)、itemCode CARD_DELETE=108
// ══════════════════════════════════════════════════════════════════════════

describe("[BLE3-0127] cardDeleteData: cardID hex → bytes のみ (ヘッダ無し)", () => {
  it("[BLE3-0127] cardID hex を生バイトへ変換するだけ (CHCardCapableImpl.kt:60-70)", () => {
    const cardID = "deadbeef";
    const result = cardDeleteData(cardID);
    expect(result).toEqual(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    expect(result.length).toBe(4);
  });

  it("[BLE3-0127] 固定ヘッダ (F0 等) は乗らない", () => {
    const result = cardDeleteData("aabb");
    expect(result[0]).toBe(0xaa);
    expect(result.length).toBe(2);
  });

  it("[BLE3-0127] CARD_DELETE itemCode=108 が SDK 値と一致", () => {
    expect(ITEM_CODES.CARD_DELETE).toBe(108);
  });

  it("[BLE3-0127] 16B hex (UUID 相当) も変換できる", () => {
    const hex = "0102030405060708090a0b0c0d0e0f10";
    const result = cardDeleteData(hex);
    expect(result.length).toBe(16);
    expect(result[0]).toBe(0x01);
    expect(result[15]).toBe(0x10);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// BLE3-0128: passcodeDelete payload = id(hex→bytes)、itemCode PASSCODE_DELETE=124
// ══════════════════════════════════════════════════════════════════════════

describe("[BLE3-0128] passcodeDeleteData: id hex → bytes のみ、PASSCODE_DELETE=124", () => {
  it("[BLE3-0128] id hex を生バイトへ変換するだけ (deviceId 第2引数は payload に乗らない, CHPassCodeCapableImpl.kt:104)", () => {
    const id = "cafebabe";
    const result = passcodeDeleteData(id);
    expect(result).toEqual(Buffer.from([0xca, 0xfe, 0xba, 0xbe]));
  });

  it("[BLE3-0128] PASSCODE_DELETE itemCode=124 が SDK 値と一致", () => {
    expect(ITEM_CODES.PASSCODE_DELETE).toBe(124);
  });

  it("[BLE3-0128] cardDeleteData と同一アルゴリズム (deviceId は含まれない)", () => {
    const hex = "cafebabe";
    expect(passcodeDeleteData(hex)).toEqual(cardDeleteData(hex));
  });
});

// ══════════════════════════════════════════════════════════════════════════
// BLE3-0129: cardMove payload = [idLen] ++ id(hex→bytes) ++ touchProUUID(UTF-8)
// ══════════════════════════════════════════════════════════════════════════

describe("[BLE3-0129] cardMoveData: [idLen] ++ id(hex→bytes) ++ touchProUUID(UTF-8)", () => {
  it("[BLE3-0129] [id.size]++id.hexStringToByteArray()++touchProUUID.toByteArray() (CHCardCapableImpl.kt:72-81)", () => {
    const cardId = "deadbeef"; // 4B
    const uuid = "12345678-1234-1234-1234-123456789abc";
    const result = cardMoveData(cardId, uuid);

    expect(result[0]).toBe(4); // idLen=4
    expect(result.subarray(1, 5)).toEqual(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    // touchProUUID は UTF-8 文字列 (ハイフン保持、uuidToBytes しない)
    const uuidBytes = Buffer.from(uuid, "utf8");
    expect(result.subarray(5)).toEqual(uuidBytes);
    expect(result.length).toBe(1 + 4 + uuidBytes.length);
  });

  it("[BLE3-0129] touchProUUID は UTF-8 文字列そのまま (uuidToBytes 化しない, ハイフン込み 36 文字)", () => {
    const cardId = "01";
    const uuidStr = "aabbccdd-eeff-0011-2233-445566778899";
    const result = cardMoveData(cardId, uuidStr);
    // ハイフンが生きている (36文字UTF-8)
    const tail = result.subarray(2).toString("utf8");
    expect(tail).toBe(uuidStr);
  });

  it("[BLE3-0129] CARD_MOVE itemCode=141 が SDK 値と一致", () => {
    expect(ITEM_CODES.CARD_MOVE).toBe(141);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// BLE3-0130: passcodeMove payload = [idLen] ++ id(hex→bytes) ++ touchProUUID(UTF-8)
// ══════════════════════════════════════════════════════════════════════════

describe("[BLE3-0130] passcodeMoveData: card.move と同一アルゴリズム (CHPassCodeCapableImpl.kt:119-128)", () => {
  it("[BLE3-0130] passcodeMoveData と cardMoveData は同一レイアウト", () => {
    const id = "1234abcd";
    const uuid = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    expect(passcodeMoveData(id, uuid)).toEqual(cardMoveData(id, uuid));
  });

  it("[BLE3-0130] PASSCODE_MOVE itemCode=142 が SDK 値と一致", () => {
    expect(ITEM_CODES.PASSCODE_MOVE).toBe(142);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// BLE3-0131: cardChange payload = [idLen] ++ id(hex→bytes) ++ hexName(chunked(2) 畳み込み)
// ══════════════════════════════════════════════════════════════════════════

describe("[BLE3-0131] cardChangeData: [idLen] ++ id(hex→bytes) ++ hexName(2文字/byte 畳み込み)", () => {
  it("[BLE3-0131] [id.size]++id(hex→bytes)++hexName.chunked(2).map{toInt(16)} (CHCardCapableImpl.kt:162)", () => {
    const ID = "aabb";       // 2B
    const hexName = "deadbeef"; // 4B 分の hex → 4B bytes
    const result = cardChangeData(ID, hexName);

    // byte0 = idLen = 2
    expect(result[0]).toBe(2);
    // [1..2] = id
    expect(result[1]).toBe(0xaa);
    expect(result[2]).toBe(0xbb);
    // hexName 畳み込み: de=0xde, ad=0xad, be=0xbe, ef=0xef
    expect(result[3]).toBe(0xde);
    expect(result[4]).toBe(0xad);
    expect(result[5]).toBe(0xbe);
    expect(result[6]).toBe(0xef);
    expect(result.length).toBe(7);
  });

  it("[BLE3-0131] CARD_CHANGE itemCode=107 が SDK 値と一致", () => {
    expect(ITEM_CODES.CARD_CHANGE).toBe(107);
  });

  it("[BLE3-0131] hexName 奇数長末尾 1 文字も byte 化 (chunked(2) 末尾 1 文字相当, 'abc'→['ab','c']→[0xab,0x0c])", () => {
    // Kotlin chunked(2) は "abc" → ["ab","c"] — "c"→0x0c
    const result = cardChangeData("01", "abc");
    // id: [1, 0x01]、hexName: [0xab, 0x0c]
    expect(result[0]).toBe(1);    // idLen=1
    expect(result[1]).toBe(0x01); // id=0x01
    expect(result[2]).toBe(0xab); // "ab"→0xab
    expect(result[3]).toBe(0x0c); // "c"→parseInt("c",16)=12=0x0c
  });
});

// ══════════════════════════════════════════════════════════════════════════
// BLE3-0132: passcodeChange payload = [idLen] ++ id(hex→bytes) ++ hexName(chunked(2) 畳み込み)
// ══════════════════════════════════════════════════════════════════════════

describe("[BLE3-0132] passcodeChangeData: card と同一アルゴリズム、PASSCODE_CHANGE=123", () => {
  it("[BLE3-0132] passcodeChangeData と cardChangeData は同一レイアウト (CHPassCodeCapableImpl.kt:130-137)", () => {
    const ID = "ff00";
    const hexName = "cafe1234";
    expect(passcodeChangeData(ID, hexName)).toEqual(cardChangeData(ID, hexName));
  });

  it("[BLE3-0132] PASSCODE_CHANGE itemCode=123 が SDK 値と一致", () => {
    expect(ITEM_CODES.PASSCODE_CHANGE).toBe(123);
  });

  it("[BLE3-0132] 奇数長 hexName も末尾 1 文字を byte 化 (chunked(2) 末尾相当)", () => {
    const result = passcodeChangeData("02", "f");
    expect(result[0]).toBe(1);    // idLen=1
    expect(result[1]).toBe(0x02); // id byte
    expect(result[2]).toBe(0x0f); // "f"→parseInt("f",16)=15=0x0f
  });
});

// ══════════════════════════════════════════════════════════════════════════
// BLE3-0133: cardChangeValue payload = [idLen] ++ id(hex→bytes) ++ newID(UTF-8)
// ══════════════════════════════════════════════════════════════════════════

describe("[BLE3-0133] cardChangeValueData: newID は UTF-8 そのまま (cardChange の hex 畳み込みとは別物)", () => {
  it("[BLE3-0133] [id.size]++id(hex→bytes)++newID.toByteArray()(UTF-8) のレイアウト (CHCardCapableImpl.kt:169-178)", () => {
    const ID = "aabb";    // 2B
    const newID = "hello"; // UTF-8 5B
    const result = cardChangeValueData(ID, newID);

    expect(result[0]).toBe(2);    // idLen=2
    expect(result[1]).toBe(0xaa);
    expect(result[2]).toBe(0xbb);
    // newID は UTF-8 文字列 ('h'=0x68, 'e'=0x65, 'l'=0x6c, 'l'=0x6c, 'o'=0x6f)
    expect(result.subarray(3).toString("utf8")).toBe("hello");
    expect(result.length).toBe(8);
  });

  it("[BLE3-0133] CARD_CHANGE_VALUE itemCode=139 が SDK 値と一致 (SesameProtocols.kt:40)", () => {
    expect(ITEM_CODES.CARD_CHANGE_VALUE).toBe(139);
  });

  it("[BLE3-0133] cardChange(hexName 畳み込み) と cardChangeValue(UTF-8) は同入力で異なる出力", () => {
    // 同じ ID / name 文字列で呼んだとき出力が異なる (CHANGE=hex畳み込み / CHANGE_VALUE=UTF-8)
    const ID = "ff";
    const nameStr = "deadbeef";

    const changeResult = cardChangeData(ID, nameStr);      // hex 畳み込み → 4B
    const changeValueResult = cardChangeValueData(ID, nameStr); // UTF-8 → 8B

    const changeNamePart = changeResult.subarray(2);           // hex畳み: [0xde, 0xad, 0xbe, 0xef] = 4B
    const changeValueNamePart = changeValueResult.subarray(2); // UTF-8: "deadbeef" = 8B
    expect(changeNamePart.length).toBe(4);
    expect(changeValueNamePart.length).toBe(8);
    expect(changeNamePart).not.toEqual(changeValueNamePart);
  });

  it("[BLE3-0133] newID が UUID 文字列の場合 UTF-8 のままバイト化する (ハイフン込み 36 文字)", () => {
    const id = "abcd";
    const newID = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx";
    const result = cardChangeValueData(id, newID);
    // ハイフン込み 36 文字の UTF-8
    expect(result.subarray(3).toString("utf8")).toBe(newID);
    expect(result.subarray(3).length).toBe(36);
  });
});
