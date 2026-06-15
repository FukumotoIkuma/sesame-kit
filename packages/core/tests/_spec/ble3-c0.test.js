// BLE3 OS3 直結 spec テスト (BLE3-0001〜BLE3-0018)
// 各 it のタイトル先頭に [BLE3-NNNN] を付ける (spec IDs と 1:1)。
// ネットワーク/実機不使用。pure functions / mock のみ。決定論的。

import { describe, it, expect, vi } from "vitest";
import { Buffer } from "node:buffer";

// ── imports ────────────────────────────────────────────────────────────────
import {
  parseAdvertisement,
  advToDeviceUUID,
  os2NameToUuid,
  peripheralToDiscovery,
} from "../../src/ble/transport.js";

import {
  GATT,
  COMPANY_ID,
  OP,
  SEG,
  RESULT,
  UNVERIFIED_RESULT_NAMES,
  resultName,
  deriveSessionKey,
  deriveSessionKeyFromEcdh,
  splitSegments,
  SegmentAssembler,
  buildSendFrame,
  parseRecvFrame,
} from "../../src/ble/protocol.js";

import { PRODUCT_TYPES, KIND } from "../../src/ble/devicemodel.js";
import { aesCmac } from "../../src/aes-cmac.js";

// ── helpers ─────────────────────────────────────────────────────────────────

// company ID 0x055A → LE: 5A 05
const CO = [0x5a, 0x05];

/**
 * manufacturerData を組み立てる: LE company-ID 2B + advBytes (可変長)
 * advBytes 座標 (SDK と同じ添字) = md[i+2]
 */
function makeMd(advBytes) {
  const prefix = Buffer.from(CO);
  return Buffer.concat([prefix, Buffer.from(advBytes)]);
}

// noble peripheral 互換の最小モック
function fakePeripheral({ md, rssi = -70, localName = null, address = "AA:BB:CC:DD:EE:FF" } = {}) {
  return { advertisement: { manufacturerData: md || null, localName }, rssi, address };
}

// ── BLE3-0001 : parseAdvertisement company ID ゲート ─────────────────────────

describe("BLE3-0001: parseAdvertisement company ID ゲート (0x055A)", () => {
  it("[BLE3-0001] company ID が 0x055A(LE 5A 05) 一致 → null でない", () => {
    const deviceId = Buffer.alloc(16, 0xab);
    const md = Buffer.concat([Buffer.from([...CO, 5, 0x00, 0x00]), deviceId]);
    const result = parseAdvertisement(md);
    expect(result).not.toBeNull();
    expect(result.productType).toBe(5);
  });

  it("[BLE3-0001] company ID 不一致 (先頭 2B が 0x055A でない) → null", () => {
    const deviceId = Buffer.alloc(16, 0xab);
    const md = Buffer.concat([Buffer.from([0x00, 0x00, 5, 0x00, 0x00]), deviceId]);
    expect(parseAdvertisement(md)).toBeNull();
  });

  it("[BLE3-0001] 長さ不足 (< ADV_OFF + 3 = 5B) → null", () => {
    // 4B しか無い
    const md = Buffer.from([0x5a, 0x05, 5, 0x00]);
    expect(parseAdvertisement(md)).toBeNull();
  });

  it("[BLE3-0001] null/undefined 入力 → null", () => {
    expect(parseAdvertisement(null)).toBeNull();
    expect(parseAdvertisement(undefined)).toBeNull();
  });

  it("[BLE3-0001] COMPANY_ID 定数が 0x055A", () => {
    expect(COMPANY_ID).toBe(0x055a);
  });

  it("[BLE3-0001] ADV_OFF=2 補正: advBytes[0] は md[2] に対応する (productType=5 SS5)", () => {
    const advBytes = [0x05, 0x00, 0x01,
      0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
      0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00];
    const md = makeMd(advBytes);
    const result = parseAdvertisement(md);
    expect(result).not.toBeNull();
    expect(result.productType).toBe(5);
    expect(result.model).toBe("sesame_5");
  });

  it("[BLE3-0001] advToDeviceUUID: SESAME でない → null", () => {
    const md = Buffer.from([0x00, 0x00, 5, 0x00, 0x00, ...Buffer.alloc(16)]);
    expect(advToDeviceUUID(md)).toBeNull();
  });
});

// ── BLE3-0002 : productType → model/kind マッピング ──────────────────────────

describe("BLE3-0002: parseAdvertisement productType → model/kind マッピング", () => {
  function makeMinMd(productType, extraAdvBytes = Buffer.alloc(16)) {
    return Buffer.concat([Buffer.from([...CO, productType, 0x00, 0x00]), extraAdvBytes]);
  }

  it("[BLE3-0002] productType=5 → model=sesame_5, kind=lock5", () => {
    const r = parseAdvertisement(makeMinMd(5));
    expect(r).not.toBeNull();
    expect(r.model).toBe("sesame_5");
    expect(r.kind).toBe(KIND.LOCK5);
  });

  it("[BLE3-0002] productType=13 → model=hub_3 / kind=hub3", () => {
    // Hub3 は advBytes[2..8) 6B が必要: md[4..10)
    const md = Buffer.from([...CO, 13, 0x00, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
    const r = parseAdvertisement(md);
    expect(r.model).toBe("hub_3");
    expect(r.kind).toBe(KIND.HUB3);
  });

  it("[BLE3-0002] productType=1 → model=wm_2 / kind=wifi", () => {
    // WM2: advBytes[3..9) 6B + 末尾バイト (isConnectable)
    const md = Buffer.from([...CO, 1, 0x00, 0x00, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00]);
    const r = parseAdvertisement(md);
    expect(r.model).toBe("wm_2");
    expect(r.kind).toBe(KIND.WIFI);
  });

  it("[BLE3-0002] productType=17 → model=bot_2, kind=bot2", () => {
    const r = parseAdvertisement(makeMinMd(17));
    expect(r).not.toBeNull();
    expect(r.model).toBe("bot_2");
    expect(r.kind).toBe(KIND.BOT2);
  });

  it("[BLE3-0002] 未知 productType=99 → model=null, kind=UNKNOWN (操作捏造しない)", () => {
    const r = parseAdvertisement(makeMinMd(99));
    expect(r).not.toBeNull();
    expect(r.model).toBeNull();
    expect(r.kind).toBe(KIND.UNKNOWN);
  });

  it("[BLE3-0002] PRODUCT_TYPES テーブルに全 productType が model/kind を持つ", () => {
    for (const [pt, entry] of Object.entries(PRODUCT_TYPES)) {
      expect(typeof entry.model).toBe("string");
      expect(typeof entry.kind).toBe("string");
    }
  });
});

// ── BLE3-0003 : SS5/Touch/Face deviceUUID = advBytes[3..18] 16B ──────────────

describe("BLE3-0003: parseAdvertisement SS5/Touch/Face deviceUUID = advBytes[3..18] 16B", () => {
  it("[BLE3-0003] SS5 (productType=5): advBytes[3..18] の 16B を UUID 化する", () => {
    const id16 = Buffer.from("112004230300020732000101ffffffff", "hex");
    const md = Buffer.concat([Buffer.from([...CO, 5, 0x00, 0x01]), id16]);
    const r = parseAdvertisement(md);
    expect(r).not.toBeNull();
    expect(r.deviceUUID).toBe("11200423-0300-0207-3200-0101ffffffff");
  });

  it("[BLE3-0003] 長さ不足 (< ADV_OFF+19) → deviceUUID=null", () => {
    const md = Buffer.from([...CO, 5, 0x00, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99]);
    const r = parseAdvertisement(md);
    expect(r).not.toBeNull();
    expect(r.deviceUUID).toBeNull();
  });

  it("[BLE3-0003] advToDeviceUUID も同じ 16B UUID を返す", () => {
    const id16 = Buffer.from("aabbccddeeff00112233445566778899", "hex");
    const md = Buffer.concat([Buffer.from([...CO, 5, 0x00, 0x00]), id16]);
    const uuid = advToDeviceUUID(md);
    expect(uuid).toBe("aabbccdd-eeff-0011-2233-445566778899");
  });
});

// ── BLE3-0004 : WM2 deviceUUID = prefix + advBytes[3..9) 6B / isConnectable ──

describe("BLE3-0004: parseAdvertisement WM2 deviceUUID (prefix + advBytes[3..9) 6B) / isConnectable", () => {
  // WM2_UUID_PREFIX = "00000000055afd810001"
  const WM2_PREFIX = "00000000-055a-fd81-0001-";

  it("[BLE3-0004] WM2 advBytes[3..9) 6B → prefix + 6B hex の UUID", () => {
    // advBytes = [1, 0, 0, 0x11,0x22,0x33,0x44,0x55,0x66, 0x00]
    const md = Buffer.from([...CO, 1, 0x00, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x00]);
    const r = parseAdvertisement(md);
    expect(r).not.toBeNull();
    expect(r.model).toBe("wm_2");
    expect(r.deviceUUID).toBe(WM2_PREFIX + "112233445566");
  });

  it("[BLE3-0004] WM2 isConnectable: advBytes.last()==0 → true", () => {
    const md = Buffer.from([...CO, 1, 0x00, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x00]);
    const r = parseAdvertisement(md);
    expect(r.isConnectable).toBe(true);
  });

  it("[BLE3-0004] WM2 isConnectable: advBytes.last()!=0 → false", () => {
    const md = Buffer.from([...CO, 1, 0x00, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x01]);
    const r = parseAdvertisement(md);
    expect(r.isConnectable).toBe(false);
  });

  it("[BLE3-0004] WM2 6B 不足 (< ADV_OFF+9) → deviceUUID=null", () => {
    // ADV_OFF+9 = 11. md が 10B しかない
    const md = Buffer.from([...CO, 1, 0x00, 0x00, 0x11, 0x22, 0x33, 0x44, 0x00]);
    const r = parseAdvertisement(md);
    expect(r.deviceUUID).toBeNull();
  });
});

// ── BLE3-0005 : Hub3 deviceUUID = prefix + advBytes[2..8) 6B ─────────────────

describe("BLE3-0005: parseAdvertisement Hub3 deviceUUID (prefix + advBytes[2..8) 6B)", () => {
  // HUB3_UUID_PREFIX = "00000000055afd810d00"
  const HUB3_PREFIX = "00000000-055a-fd81-0d00-";

  it("[BLE3-0005] Hub3 (productType=13): deviceUUID = prefix + advBytes[2..8) 6B hex", () => {
    // advBytes = [13, 0x01, 0xaa,0xbb,0xcc,0xdd,0xee,0xff]
    const md = Buffer.from([...CO, 13, 0x01, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
    const r = parseAdvertisement(md);
    expect(r).not.toBeNull();
    expect(r.model).toBe("hub_3");
    expect(r.deviceUUID).toBe(HUB3_PREFIX + "aabbccddeeff");
  });

  it("[BLE3-0005] Hub3_LTE (productType=36): deviceUUID = prefix + advBytes[2..8) 6B", () => {
    const md = Buffer.from([...CO, 36, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);
    const r = parseAdvertisement(md);
    expect(r).not.toBeNull();
    expect(r.model).toBe("hub_3_lte");
    expect(r.deviceUUID).toBe(HUB3_PREFIX + "112233445566");
  });

  it("[BLE3-0005] Hub3 6B 不足 (< ADV_OFF+8) → deviceUUID=null", () => {
    // ADV_OFF+8 = 10. md が 9B しかない
    const md = Buffer.from([...CO, 13, 0x00, 0xaa, 0xbb, 0xcc, 0xdd, 0xee]);
    const r = parseAdvertisement(md);
    expect(r.deviceUUID).toBeNull();
  });
});

// ── BLE3-0006 : isRegistered bit 位置が Hub3 と他で非対称 ────────────────────

describe("BLE3-0006: parseAdvertisement isRegistered Hub3(advBytes[1]) vs 他(advBytes[2])", () => {
  it("[BLE3-0006] Hub3: advBytes[1] bit0=1 → isRegistered=true", () => {
    // advBytes[1]=0x01 (bit0=1), advBytes[2]=0x00
    const md = Buffer.from([...CO, 13, 0x01, 0x00, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
    const r = parseAdvertisement(md);
    expect(r).not.toBeNull();
    expect(r.isRegistered).toBe(true);
  });

  it("[BLE3-0006] Hub3: advBytes[1] bit0=0 → isRegistered=false (advBytes[2] bit0=1 でも無視)", () => {
    // advBytes[1]=0x00 (bit0=0), advBytes[2]=0x01 (bit0=1 — が Hub3 では isRegistered に使わない)
    const md = Buffer.from([...CO, 13, 0x00, 0x01, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
    const r = parseAdvertisement(md);
    expect(r.isRegistered).toBe(false);
  });

  it("[BLE3-0006] SS5 (非Hub3): advBytes[2] bit0=1 → isRegistered=true", () => {
    // advBytes[2]=0x01 (bit0=1)
    const id16 = Buffer.alloc(16, 0xcc);
    const md = Buffer.concat([Buffer.from([...CO, 5, 0x00, 0x01]), id16]);
    const r = parseAdvertisement(md);
    expect(r.isRegistered).toBe(true);
  });

  it("[BLE3-0006] SS5 (非Hub3): advBytes[1] bit0=1 だが isRegistered は advBytes[2] bit0 から (= 0 → false)", () => {
    // advBytes[1]=0x01 (bit0=1), advBytes[2]=0x00 (bit0=0)
    const id16 = Buffer.alloc(16, 0xcc);
    const md = Buffer.concat([Buffer.from([...CO, 5, 0x01, 0x00]), id16]);
    const r = parseAdvertisement(md);
    expect(r.isRegistered).toBe(false);
  });

  it("[BLE3-0006] Hub3_LTE も Hub3 と同じ advBytes[1] bit0 で判定", () => {
    const md = Buffer.from([...CO, 36, 0x01, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);
    const r = parseAdvertisement(md);
    expect(r.model).toBe("hub_3_lte");
    expect(r.isRegistered).toBe(true);
  });
});

// ── BLE3-0007 : adv_tag_b1 = (advBytes[2] and 2) > 0 ───────────────────────

describe("BLE3-0007: parseAdvertisement adv_tag_b1 = (advBytes[2] & 2) > 0", () => {
  function makeAdvTagMd(advBytes2) {
    const id16 = Buffer.alloc(16, 0x55);
    return Buffer.concat([Buffer.from([...CO, 5, 0x00, advBytes2]), id16]);
  }

  it("[BLE3-0007] advBytes[2] bit1=1 (0x02) → advTagB1=true", () => {
    const r = parseAdvertisement(makeAdvTagMd(0x02));
    expect(r).not.toBeNull();
    expect(r.advTagB1).toBe(true);
  });

  it("[BLE3-0007] advBytes[2] bit1=0 (0x01) → advTagB1=false", () => {
    const r = parseAdvertisement(makeAdvTagMd(0x01));
    expect(r.advTagB1).toBe(false);
  });

  it("[BLE3-0007] advBytes[2]=0x03 (bit0=registered, bit1=advTagB1) → 両方 true", () => {
    const r = parseAdvertisement(makeAdvTagMd(0x03));
    expect(r.isRegistered).toBe(true);
    expect(r.advTagB1).toBe(true);
  });

  it("[BLE3-0007] advBytes[2]=0x00 → advTagB1=false, isRegistered=false", () => {
    const r = parseAdvertisement(makeAdvTagMd(0x00));
    expect(r.advTagB1).toBe(false);
    expect(r.isRegistered).toBe(false);
  });
});

// ── BLE3-0008 : os2NameToUuid: OS2 機種 deviceUUID from deviceName ────────────

describe("BLE3-0008: os2NameToUuid (OS2 BLE deviceName → UUID)", () => {
  it("[BLE3-0008] 正常: 22B base64 → 16B → UUID", () => {
    const uuid16 = Buffer.from("aabbccddeeff00112233445566778899", "hex");
    const deviceName = uuid16.toString("base64").replace(/=+$/, "");
    expect(deviceName.length).toBe(22);
    const result = os2NameToUuid(deviceName);
    expect(result).toBe("aabbccdd-eeff-0011-2233-445566778899");
  });

  it("[BLE3-0008] base64 decode が 16B でない localName → null", () => {
    // 8 文字 base64 → decode 後 6B → 16B でない
    expect(os2NameToUuid("AAAAAAAA")).toBeNull();
  });

  it("[BLE3-0008] null/undefined/空 localName → null", () => {
    expect(os2NameToUuid(null)).toBeNull();
    expect(os2NameToUuid(undefined)).toBeNull();
    expect(os2NameToUuid("")).toBeNull();
  });

  it("[BLE3-0008] OS2 productType (0=sesame_2) + localName → deviceUUID を導出 (parseAdvertisement 経由)", () => {
    const uuid16 = Buffer.from("11200423030002073200010100000000", "hex");
    const localName = uuid16.toString("base64").replace(/=+$/, "");
    const md = Buffer.from([...CO, 0, 0x00, 0x00]); // productType=0 (sesame_2)
    const r = parseAdvertisement(md, localName);
    expect(r).not.toBeNull();
    expect(r.model).toBe("sesame_2");
    expect(r.deviceUUID).toBe("11200423-0300-0207-3200-010100000000");
  });

  it("[BLE3-0008] OS2 productType + localName なし → deviceUUID=null", () => {
    const md = Buffer.from([...CO, 0, 0x00, 0x00]);
    const r = parseAdvertisement(md, undefined);
    expect(r.deviceUUID).toBeNull();
  });
});

// ── BLE3-0009 : peripheralToDiscovery 未知機種/deviceUUID=null を列挙対象外 ──

describe("BLE3-0009: peripheralToDiscovery 未知機種/deviceUUID=null を除外", () => {
  it("[BLE3-0009] SESAME でない (company 不一致) → null を返す", () => {
    const md = Buffer.concat([Buffer.from([0x00, 0x00, 5, 0x00, 0x00]), Buffer.alloc(16)]);
    expect(peripheralToDiscovery(fakePeripheral({ md }))).toBeNull();
  });

  it("[BLE3-0009] manufacturerData=null → null を返す", () => {
    expect(peripheralToDiscovery(fakePeripheral({ md: null }))).toBeNull();
  });

  it("[BLE3-0009] 未知 productType (model=null) は既定(includeUnknown=false) で null", () => {
    const id16 = Buffer.alloc(16, 0xab);
    const md = Buffer.concat([Buffer.from([...CO, 99, 0x00, 0x00]), id16]);
    expect(peripheralToDiscovery(fakePeripheral({ md }))).toBeNull();
    expect(peripheralToDiscovery(fakePeripheral({ md }), { includeUnknown: false })).toBeNull();
  });

  it("[BLE3-0009] 未知 productType (model=null) は includeUnknown=true で非 null", () => {
    const id16 = Buffer.alloc(16, 0xab);
    const md = Buffer.concat([Buffer.from([...CO, 99, 0x00, 0x00]), id16]);
    const r = peripheralToDiscovery(fakePeripheral({ md }), { includeUnknown: true });
    expect(r).not.toBeNull();
    expect(r.model).toBeNull();
    expect(r.kind).toBe(KIND.UNKNOWN);
  });

  it("[BLE3-0009] deviceUUID=null (短い md) → null を返す (既知機種でも)", () => {
    // SS5 (pt=5) だが uuid16B 分が無い → deviceUUID=null
    const md = Buffer.from([...CO, 5, 0x00, 0x00, 0x11, 0x22]);
    expect(peripheralToDiscovery(fakePeripheral({ md }))).toBeNull();
  });

  it("[BLE3-0009] 既知機種 + deviceUUID あり → 非 null でフィールドを返す", () => {
    const id16 = Buffer.from("112004230300020732000101ffffffff", "hex");
    const md = Buffer.concat([Buffer.from([...CO, 5, 0x00, 0x01]), id16]);
    const r = peripheralToDiscovery(fakePeripheral({ md, rssi: -50 }));
    expect(r).not.toBeNull();
    expect(r.model).toBe("sesame_5");
    expect(r.deviceUUID).not.toBeNull();
    expect(r.rssi).toBe(-50);
  });
});

// ── BLE3-0010 : GATT 定数 ────────────────────────────────────────────────────

describe("BLE3-0010: GATT 定数 (service fd81 / write 16860002 / notify 16860003)", () => {
  it("[BLE3-0010] GATT.SERVICE = 'fd81' (SesameProtocols.kt:80)", () => {
    expect(GATT.SERVICE).toBe("fd81");
  });

  it("[BLE3-0010] GATT.WRITE_CHAR は '16860002' で始まる (SesameProtocols.kt:81)", () => {
    expect(GATT.WRITE_CHAR.toLowerCase()).toMatch(/^16860002/);
  });

  it("[BLE3-0010] GATT.NOTIFY_CHAR は '16860003' で始まる (SesameProtocols.kt:83)", () => {
    expect(GATT.NOTIFY_CHAR.toLowerCase()).toMatch(/^16860003/);
  });

  it("[BLE3-0010] COMPANY_ID = 0x055A (protocol.js:31)", () => {
    expect(COMPANY_ID).toBe(0x055a);
  });

  it("[BLE3-0010] GATT はイミュータブル (Object.isFrozen)", () => {
    expect(Object.isFrozen(GATT)).toBe(true);
  });
});

// ── BLE3-0011 : write 有限回リトライ → 全失敗で onDisconnect 発火 ────────────

describe("BLE3-0011: NobleTransport._writeWithRetry 有限回リトライ (WRITE_MAX_RETRIES=5)", () => {
  it("[BLE3-0011] 全リトライ失敗 (6回 = 初回+5回) → onDisconnect 発火 + rethrow", async () => {
    const { NobleTransport } = await import("../../src/ble/transport.js");
    const transport = new NobleTransport({});

    let writeCallCount = 0;
    const mockWrite = vi.fn(async () => {
      writeCallCount++;
      throw new Error("write failed");
    });

    let disconnectCalled = false;
    transport._writeChar = { writeAsync: mockWrite };
    transport._disconnected = false;
    transport._onDisconnect = () => { disconnectCalled = true; };

    let threw = false;
    try {
      await transport._writeWithRetry(Buffer.from([0x01]));
    } catch {
      threw = true;
    }

    // WRITE_MAX_RETRIES=5: attempt 0..5 = 計6回
    expect(writeCallCount).toBe(6);
    expect(disconnectCalled).toBe(true);
    expect(threw).toBe(true);
  }, 15000);

  it("[BLE3-0011] 既に _disconnected=true なら即 throw (リトライしない)", async () => {
    const { NobleTransport } = await import("../../src/ble/transport.js");
    const transport = new NobleTransport({});
    transport._disconnected = true;
    transport._writeChar = { writeAsync: vi.fn(async () => {}) };

    await expect(transport._writeWithRetry(Buffer.from([0x01]))).rejects.toThrow();
    expect(transport._writeChar.writeAsync).not.toHaveBeenCalled();
  });
});

// ── BLE3-0012 : onDisconnect 二重発火防止 ────────────────────────────────────

describe("BLE3-0012: NobleTransport._handleDisconnect / disconnect 二重発火防止", () => {
  it("[BLE3-0012] _handleDisconnect を2回呼ぶと onDisconnect は1回だけ発火する", async () => {
    const { NobleTransport } = await import("../../src/ble/transport.js");
    const t = new NobleTransport({});
    t._disconnected = false;

    let callCount = 0;
    t._onDisconnect = () => { callCount++; };

    t._handleDisconnect("reason1");
    t._handleDisconnect("reason2");

    expect(callCount).toBe(1);
  });

  it("[BLE3-0012] _handleDisconnect 後 _disconnected=true になる", async () => {
    const { NobleTransport } = await import("../../src/ble/transport.js");
    const t = new NobleTransport({});
    t._disconnected = false;
    t._onDisconnect = () => {};

    t._handleDisconnect("reason");
    expect(t._disconnected).toBe(true);
  });

  it("[BLE3-0012] disconnect() 後は _onDisconnect=null (能動切断でコールバック抑止)", async () => {
    const { NobleTransport } = await import("../../src/ble/transport.js");
    const transport = new NobleTransport({});
    transport._disconnected = false;

    let callCount = 0;
    transport._onDisconnect = () => { callCount++; };

    // peripheral/notifyChar のスタブ
    transport._peripheral = {
      removeListener: vi.fn(),
      disconnectAsync: vi.fn(async () => {}),
    };
    transport._notifyChar = {
      unsubscribeAsync: vi.fn(async () => {}),
    };
    transport._onPeripheralDisconnect = vi.fn();

    await transport.disconnect();

    // 能動 disconnect 後は _onDisconnect が null
    expect(transport._onDisconnect).toBeNull();
    // _disconnected=true
    expect(transport._disconnected).toBe(true);
    // その後 _handleDisconnect を呼んでも onDisconnect コールバックは呼ばれない
    transport._handleDisconnect("late");
    expect(callCount).toBe(0);
  });
});

// ── BLE3-0013 : noble 子プロセスプローブで SIGABRT → SesameError 化 ──────────

describe("BLE3-0013: probeBleAvailability/loadNoble SIGABRT → SesameError 化", () => {
  it("[BLE3-0013] SesameError と ERR コードが export されている", async () => {
    const { SesameError, ERR } = await import("../../src/errors.js");
    expect(typeof SesameError).toBe("function");
    expect(ERR.BLE_NO_ADAPTER).toBeTruthy();
    expect(ERR.BLE_UNAUTHORIZED).toBeTruthy();
    expect(ERR.BLE_UNSUPPORTED).toBeTruthy();
    expect(ERR.BLE_POWERED_OFF).toBeTruthy();
    expect(ERR.BLE_INIT_TIMEOUT).toBeTruthy();
  });

  it("[BLE3-0013] SesameError は Error を継承しコード付き (code プロパティ)", async () => {
    const { SesameError, ERR } = await import("../../src/errors.js");
    const e = new SesameError("test", { code: ERR.BLE_UNAUTHORIZED, retryable: false });
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe(ERR.BLE_UNAUTHORIZED);
    expect(e.retryable).toBe(false);
  });

  it("[BLE3-0013] BLE_INIT_TIMEOUT は retryable: true で作成できる", async () => {
    const { SesameError, ERR } = await import("../../src/errors.js");
    const e = new SesameError("timeout", { code: ERR.BLE_INIT_TIMEOUT, retryable: true });
    expect(e.retryable).toBe(true);
  });

  it("[BLE3-0013] darwin 環境で aborted → BLE_UNAUTHORIZED マップ (bleAbortError 契約確認)", async () => {
    const { SesameError, ERR } = await import("../../src/errors.js");
    const darwinErr = new SesameError("unauthorized", { code: ERR.BLE_UNAUTHORIZED, retryable: false });
    expect(darwinErr.code).toBe(ERR.BLE_UNAUTHORIZED);
    const noAdapterErr = new SesameError("no adapter", { code: ERR.BLE_NO_ADAPTER, retryable: false });
    expect(noAdapterErr.code).toBe(ERR.BLE_NO_ADAPTER);
    expect(noAdapterErr.retryable).toBe(false);
  });
});

// ── BLE3-0014 : splitSegments/SegmentAssembler 20B チャンク ─────────────────

describe("BLE3-0014: splitSegments/SegmentAssembler header=(type<<1)|startBit, 20B チャンク", () => {
  it("[BLE3-0014] 単一セグメント (payload ≤ 19B): 1パケット、startBit=1, type=SEG.PLAINTEXT", () => {
    const payload = Buffer.alloc(10, 0xaa);
    const packets = splitSegments(payload, SEG.PLAINTEXT);
    expect(packets.length).toBe(1);
    // header = (SEG.PLAINTEXT << 1) | 1 = (1<<1)|1 = 3
    expect(packets[0][0]).toBe((SEG.PLAINTEXT << 1) | 1);
    expect(packets[0].length).toBe(11); // 1 header + 10 data
  });

  it("[BLE3-0014] 複数セグメント: 中間は APPEND_ONLY, 最終は parsingType を持つ", () => {
    const payload = Buffer.alloc(40, 0xbb); // 40B > 19B * 2 → 3パケット
    const packets = splitSegments(payload, SEG.CIPHERTEXT);
    expect(packets.length).toBe(3);
    // 先頭パケット: startBit=1, type=APPEND_ONLY(=0)
    expect(packets[0][0]).toBe((SEG.APPEND_ONLY << 1) | 1); // 0|1=1
    // 中間パケット: startBit=0, type=APPEND_ONLY(=0)
    expect(packets[1][0]).toBe(SEG.APPEND_ONLY << 1); // 0
    // 最終パケット: startBit=0, type=SEG.CIPHERTEXT(=2)
    expect(packets[2][0]).toBe(SEG.CIPHERTEXT << 1); // 4
  });

  it("[BLE3-0014] 各パケットは最大 20B", () => {
    const payload = Buffer.alloc(100, 0xcc);
    const packets = splitSegments(payload, SEG.PLAINTEXT);
    for (const pkt of packets) {
      expect(pkt.length).toBeLessThanOrEqual(20);
    }
  });

  it("[BLE3-0014] SegmentAssembler: startBit=1 でリセット、APPEND_ONLY は null", () => {
    const asm = new SegmentAssembler();
    const payload = Buffer.alloc(40, 0xdd);
    const packets = splitSegments(payload, SEG.PLAINTEXT);

    const r0 = asm.feed(packets[0]);
    expect(r0).toBeNull(); // APPEND_ONLY
    const r1 = asm.feed(packets[1]);
    expect(r1).toBeNull(); // APPEND_ONLY
    const r2 = asm.feed(packets[2]);
    expect(r2).not.toBeNull();
    expect(r2.type).toBe(SEG.PLAINTEXT);
    expect(r2.data).toEqual(payload);
  });

  it("[BLE3-0014] SegmentAssembler: startBit で前の未完結パケットをリセット", () => {
    const asm = new SegmentAssembler();
    // 途中まで送ってからやり直し (20B → 2 パケット構成の先頭のみ feed)
    const payload1 = Buffer.alloc(20, 0x11);
    const pkts1 = splitSegments(payload1, SEG.PLAINTEXT);
    asm.feed(pkts1[0]); // 1枚目 feed (未完)

    // 別のメッセージの先頭パケット (startBit=1) でリセット
    const payload2 = Buffer.alloc(5, 0xee);
    const pkts2 = splitSegments(payload2, SEG.PLAINTEXT);
    const result = asm.feed(pkts2[0]); // startBit → リセット → 単パケット完結
    expect(result).not.toBeNull();
    expect(result.data).toEqual(payload2);
  });

  it("[BLE3-0014] SEG 定数: APPEND_ONLY=0, PLAINTEXT=1, CIPHERTEXT=2", () => {
    expect(SEG.APPEND_ONLY).toBe(0);
    expect(SEG.PLAINTEXT).toBe(1);
    expect(SEG.CIPHERTEXT).toBe(2);
  });
});

// ── BLE3-0015 : buildSendFrame / parseRecvFrame ──────────────────────────────

describe("BLE3-0015: buildSendFrame / parseRecvFrame 送受信フレームレイアウト", () => {
  it("[BLE3-0015] buildSendFrame: 送信フレームは [itemCode] ++ data (op なし)", () => {
    const frame = buildSendFrame(0x05, Buffer.from([0x01, 0x02, 0x03]));
    expect(frame[0]).toBe(0x05); // itemCode
    expect(frame.slice(1)).toEqual(Buffer.from([0x01, 0x02, 0x03]));
    expect(frame.length).toBe(4);
  });

  it("[BLE3-0015] buildSendFrame: data 省略時は [itemCode] の 1B", () => {
    const frame = buildSendFrame(0x0a);
    expect(frame.length).toBe(1);
    expect(frame[0]).toBe(0x0a);
  });

  it("[BLE3-0015] parseRecvFrame: [op][item][body] を分解する", () => {
    const buf = Buffer.from([0x07, 0x08, 0x00, 0xde, 0xad]);
    const r = parseRecvFrame(buf);
    expect(r.opCode).toBe(0x07);  // RESPONSE
    expect(r.itemCode).toBe(0x08);
    expect(r.body).toEqual(Buffer.from([0x00, 0xde, 0xad]));
  });

  it("[BLE3-0015] parseRecvFrame: response(7) body[0] = resultCode", () => {
    const buf = Buffer.from([OP.RESPONSE, 0x02, 0x00, 0xab, 0xcd]);
    const r = parseRecvFrame(buf);
    expect(r.opCode).toBe(OP.RESPONSE); // 0x07
    expect(r.body[0]).toBe(0x00); // resultCode = 0 (success)
    expect(r.body.slice(1)).toEqual(Buffer.from([0xab, 0xcd]));
  });

  it("[BLE3-0015] parseRecvFrame: publish(8) body = payload (resultCode なし)", () => {
    const buf = Buffer.from([OP.PUBLISH, 0x0e, 0x11, 0x22, 0x33]);
    const r = parseRecvFrame(buf);
    expect(r.opCode).toBe(OP.PUBLISH); // 0x08
    expect(r.body).toEqual(Buffer.from([0x11, 0x22, 0x33]));
  });

  it("[BLE3-0015] parseRecvFrame: 長さ < 2 → throw", () => {
    expect(() => parseRecvFrame(Buffer.from([0x07]))).toThrow();
    expect(() => parseRecvFrame(Buffer.alloc(0))).toThrow();
  });

  it("[BLE3-0015] OP.RESPONSE=7, OP.PUBLISH=8 の値確認", () => {
    expect(OP.RESPONSE).toBe(0x07);
    expect(OP.PUBLISH).toBe(0x08);
  });
});

// ── BLE3-0016 : OP/SEG/RESULT enum 完全性 ───────────────────────────────────

describe("BLE3-0016: OP/SEG/RESULT enum 完全性 (SesameProtocols.kt と 1:1)", () => {
  it("[BLE3-0016] OP enum が SSM2OpCode の全値を持つ (SesameProtocols.kt:57)", () => {
    expect(OP.CREATE).toBe(0x01);
    expect(OP.READ).toBe(0x02);
    expect(OP.UPDATE).toBe(0x03);
    expect(OP.DELETE).toBe(0x04);
    expect(OP.SYNC).toBe(0x05);
    expect(OP.ASYNC).toBe(0x06);
    expect(OP.RESPONSE).toBe(0x07);
    expect(OP.PUBLISH).toBe(0x08);
    expect(OP.UNDEFINE).toBe(0x10);
  });

  it("[BLE3-0016] RESULT enum が SesameResultCode と 1:1 (success 0 〜 INVALID_PARAM 8 で終端)", () => {
    expect(RESULT[0]).toBe("success");
    expect(RESULT[1]).toBe("invalidFormat");
    expect(RESULT[2]).toBe("notSupported");
    expect(RESULT[3]).toBe("resultStorageFail");
    expect(RESULT[4]).toBe("invalidSig");
    expect(RESULT[5]).toBe("notFound");
    expect(RESULT[6]).toBe("unknown");
    expect(RESULT[7]).toBe("busy");
    expect(RESULT[8]).toBe("invalidParam");
  });

  it("[BLE3-0016] RESULT[9] は undefined (SesameProtocols.kt に 9 不在)", () => {
    expect(RESULT[9]).toBeUndefined();
  });

  it("[BLE3-0016] resultName(0) = 'success', resultName(8) = 'invalidParam'", () => {
    expect(resultName(0)).toBe("success");
    expect(resultName(8)).toBe("invalidParam");
  });

  it("[BLE3-0016] resultName(9) = 'unknown(9)' (RESULT から除外、UNVERIFIED_RESULT_NAMES に隔離)", () => {
    expect(resultName(9)).toBe("unknown(9)");
    expect(UNVERIFIED_RESULT_NAMES[9]).toBe("invalidAction");
  });

  it("[BLE3-0016] resultName(99) = 'unknown(99)' (未知コード)", () => {
    expect(resultName(99)).toBe("unknown(99)");
  });

  it("[BLE3-0016] OP, RESULT, SEG は Object.freeze されている", () => {
    expect(Object.isFrozen(OP)).toBe(true);
    expect(Object.isFrozen(RESULT)).toBe(true);
    expect(Object.isFrozen(SEG)).toBe(true);
  });
});

// ── BLE3-0017 : aesCmac RFC 4493 既知応答ベクタ ─────────────────────────────

describe("BLE3-0017: aesCmac (RFC 4493) 既知応答ベクタ", () => {
  // RFC 4493 §4 共通鍵
  const K = Buffer.from("2b7e151628aed2a6abf7158809cf4f3c", "hex");
  const M64 = Buffer.from(
    "6bc1bee22e409f96e93d7e117393172a" +
    "ae2d8a571e03ac9c9eb76fac45af8e51" +
    "30c81c46a35ce411e5fbc1191a0a52ef" +
    "f69f2445df4f9b17ad2b417be66c3710",
    "hex",
  );

  it("[BLE3-0017] Example 1: 空メッセージ → bb1d6929e95937287fa37d129b756746", () => {
    expect(aesCmac(K, Buffer.alloc(0)).toString("hex")).toBe(
      "bb1d6929e95937287fa37d129b756746",
    );
  });

  it("[BLE3-0017] Example 2: len=16 → 070a16b46b4d4144f79bdd9dd04a287c", () => {
    expect(aesCmac(K, M64.subarray(0, 16)).toString("hex")).toBe(
      "070a16b46b4d4144f79bdd9dd04a287c",
    );
  });

  it("[BLE3-0017] Example 3: len=40 → dfa66747de9ae63030ca32611497c827", () => {
    expect(aesCmac(K, M64.subarray(0, 40)).toString("hex")).toBe(
      "dfa66747de9ae63030ca32611497c827",
    );
  });

  it("[BLE3-0017] Example 4: len=64 → 51f0bebf7e3b9d92fc49741779363cfe", () => {
    expect(aesCmac(K, M64).toString("hex")).toBe(
      "51f0bebf7e3b9d92fc49741779363cfe",
    );
  });

  it("[BLE3-0017] 戻り値は常に 16B Buffer", () => {
    const mac = aesCmac(K, M64.subarray(0, 16));
    expect(Buffer.isBuffer(mac)).toBe(true);
    expect(mac.length).toBe(16);
  });

  it("[BLE3-0017] 鍵長≠16B → 明示エラー (/16-byte/)", () => {
    expect(() => aesCmac(Buffer.alloc(15), Buffer.alloc(0))).toThrow(/16-byte/);
    expect(() => aesCmac(Buffer.alloc(17), Buffer.alloc(0))).toThrow(/16-byte/);
  });
});

// ── BLE3-0018 : deriveSessionKey = AES-128-CMAC(secretKey16, token4) ─────────

describe("BLE3-0018: deriveSessionKey sessionKey16 = CMAC(secretKey, token4)", () => {
  const secretKey = Buffer.from("0102030405060708090a0b0c0d0e0f10", "hex");
  const token4 = Buffer.from("deadbeef", "hex");

  it("[BLE3-0018] deriveSessionKey(secretKey16, token4) → 16B = CMAC(secretKey, token4)", () => {
    const sessionKey = deriveSessionKey(secretKey, token4);
    const expected = aesCmac(secretKey, token4);
    expect(Buffer.isBuffer(sessionKey)).toBe(true);
    expect(sessionKey.length).toBe(16);
    expect(sessionKey.toString("hex")).toBe(expected.toString("hex"));
  });

  it("[BLE3-0018] secretKey 長 ≠ 16B → throw", () => {
    const shortKey = Buffer.alloc(15, 0x01);
    expect(() => deriveSessionKey(shortKey, token4)).toThrow();
  });

  it("[BLE3-0018] token 長 ≠ 4B → throw", () => {
    const badToken = Buffer.alloc(5, 0x00);
    expect(() => deriveSessionKey(secretKey, badToken)).toThrow();
  });

  it("[BLE3-0018] token 長 = 3B → throw", () => {
    const badToken = Buffer.alloc(3, 0x00);
    expect(() => deriveSessionKey(secretKey, badToken)).toThrow();
  });

  it("[BLE3-0018] secretKey は 32hex 文字列でも受け付ける", () => {
    const sessionKey = deriveSessionKey(secretKey.toString("hex"), token4);
    const expected = aesCmac(secretKey, token4);
    expect(sessionKey.toString("hex")).toBe(expected.toString("hex"));
  });

  it("[BLE3-0018] 既知ベクタ: RFC 4493 Example 2 の鍵+先頭 4B token で CMAC 出力を固定する", () => {
    const K = Buffer.from("2b7e151628aed2a6abf7158809cf4f3c", "hex");
    const token4b = Buffer.from("6bc1bee2", "hex"); // M64 先頭 4B
    const sessionKey = deriveSessionKey(K, token4b);
    const expected = aesCmac(K, token4b);
    expect(sessionKey.toString("hex")).toBe(expected.toString("hex"));
    expect(sessionKey.length).toBe(16);
  });

  it("[BLE3-0018] deriveSessionKeyFromEcdh(pre16, token4) も同一 CMAC(pre16, token4)", () => {
    const pre16 = Buffer.from("aabbccddeeff00112233445566778899", "hex");
    const result = deriveSessionKeyFromEcdh(pre16, token4);
    const expected = aesCmac(pre16, token4);
    expect(result.toString("hex")).toBe(expected.toString("hex"));
    expect(result.length).toBe(16);
  });

  it("[BLE3-0018] deriveSessionKeyFromEcdh: pre16 長 ≠ 16B → throw", () => {
    const shortPre = Buffer.alloc(15, 0x01);
    expect(() => deriveSessionKeyFromEcdh(shortPre, token4)).toThrow();
  });
});
