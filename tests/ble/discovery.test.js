// listNearbyDevices の中核を noble 非依存に切り出した peripheralToDiscovery の単体テスト。
// CHBleManager.kt:134-140 (CHadv(scanResult) → productModel/deviceID/rssi 抽出) と
// Sesame2BleAdvertisement.kt CHadv の機種別レイアウトに対する移植検証 (noble 実体は使わない)。
import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import { peripheralToDiscovery } from "../../src/ble/transport.js";

// noble peripheral 互換の最小モック (advertisement.manufacturerData / rssi / localName / address)。
function fakePeripheral({ md, rssi, localName, address } = {}) {
  return { advertisement: { manufacturerData: md, localName }, rssi, address };
}

// company ID = LE 5A 05。advBytes[i] = md[i+2]。
const CO = [0x5a, 0x05];

describe("peripheralToDiscovery", () => {
  it("SS5 (productType=5): 16B deviceID を UUID 化し model/kind/rssi/localName を返す", () => {
    // advBytes[0]=5 (sesame_5), advBytes[2]=registered bit0、advBytes[3..18]=16B deviceID。
    const deviceId = Buffer.from("112004230300020732000101ffffffff", "hex");
    const md = Buffer.concat([Buffer.from([...CO, 5, 0x00, 0x01]), deviceId]);
    const entry = peripheralToDiscovery(fakePeripheral({ md, rssi: -42, localName: "SS5", address: "aa:bb" }));
    expect(entry).toMatchObject({
      productType: 5,
      model: "sesame_5",
      kind: "lock5",
      isRegistered: true,            // advBytes[2] bit0 = 1
      deviceUUID: "11200423-0300-0207-3200-0101ffffffff",
      rssi: -42,
      localName: "SS5",
      address: "aa:bb",
    });
    expect(entry.peripheral).toBeTruthy(); // 再スキャン無し接続のため peripheral を引き継ぐ
  });

  it("Hub3 (productType=13): registered は advBytes[1] bit0、deviceID は advBytes[2..8) 6B", () => {
    // advBytes[0]=13 (hub_3), advBytes[1]=registered bit0=1, advBytes[2..8)=6B。
    const md = Buffer.from([...CO, 13, 0x01, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]);
    const entry = peripheralToDiscovery(fakePeripheral({ md, rssi: -60 }));
    expect(entry).toMatchObject({
      productType: 13,
      model: "hub_3",
      kind: "hub3",
      isRegistered: true, // advBytes[1] bit0
      deviceUUID: "00000000-055a-fd81-0d00-aabbccddeeff",
      rssi: -60,
      localName: null,    // localName 未提供 → null
    });
  });

  it("WM2 (productType=1): deviceID は advBytes[3..9) 6B、isConnectable は末尾==0", () => {
    // advBytes[0]=1 (wm_2), advBytes[3..9)=6B, 末尾=0 → connectable。
    const md = Buffer.from([...CO, 1, 0x00, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x00]);
    const entry = peripheralToDiscovery(fakePeripheral({ md }));
    expect(entry).toMatchObject({
      productType: 1,
      model: "wm_2",
      kind: "wifi",
      deviceUUID: "00000000-055a-fd81-0001-112233445566",
      isConnectable: true, // 末尾 == 0
    });
  });

  it("WM2 末尾 != 0 は isConnectable=false", () => {
    const md = Buffer.from([...CO, 1, 0x00, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x01]);
    const entry = peripheralToDiscovery(fakePeripheral({ md }));
    expect(entry.isConnectable).toBe(false);
  });

  it("company ID 不一致は null (SESAME でない)", () => {
    const md = Buffer.concat([Buffer.from([0x00, 0x00, 5, 0, 1]), Buffer.alloc(16)]);
    expect(peripheralToDiscovery(fakePeripheral({ md }))).toBeNull();
  });

  it("未知 productType は既定で除外 (SDK の productModel?.let フィルタ)、includeUnknown で含める", () => {
    // productType=99 は PRODUCT_TYPES に無い → model=null/kind=unknown。
    const deviceId = Buffer.from("112004230300020732000101ffffffff", "hex");
    const md = Buffer.concat([Buffer.from([...CO, 99, 0x00, 0x00]), deviceId]);
    expect(peripheralToDiscovery(fakePeripheral({ md }))).toBeNull(); // 既定除外
    const entry = peripheralToDiscovery(fakePeripheral({ md }), { includeUnknown: true });
    expect(entry).toMatchObject({ productType: 99, model: null, kind: "unknown" });
    expect(entry.deviceUUID).toBe("11200423-0300-0207-3200-0101ffffffff");
  });

  it("rssi が数値でなければ null に正規化", () => {
    const deviceId = Buffer.from("112004230300020732000101ffffffff", "hex");
    const md = Buffer.concat([Buffer.from([...CO, 5, 0x00, 0x00]), deviceId]);
    const entry = peripheralToDiscovery(fakePeripheral({ md })); // rssi 未提供
    expect(entry.rssi).toBeNull();
  });

  it("deviceUUID が取れない (長さ不足) は null", () => {
    // SS5 レイアウトで 16B に満たない → parseAdvertisement が deviceUUID=null。
    const md = Buffer.from([...CO, 5, 0x00, 0x00, 0x11, 0x22]);
    expect(peripheralToDiscovery(fakePeripheral({ md }))).toBeNull();
  });
});
