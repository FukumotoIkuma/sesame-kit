// listNearbyDevices の中核を noble 非依存に切り出した peripheralToDiscovery の単体テスト。
// CHBleManager.kt:134-140 (CHadv(scanResult) → productModel/deviceID/rssi 抽出) と
// Sesame2BleAdvertisement.kt CHadv の機種別レイアウトに対する移植検証 (noble 実体は使わない)。
import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import { peripheralToDiscovery, os2NameToUuid, advToDeviceUUID } from "../../src/ble/transport.js";

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

// ---------- OS2 機種の deviceID 導出テスト (P1-1 / R2:BLE2-10) ----------
//
// OS2 の deviceID は manufacturerData ではなく BLE advertise の deviceName (base64 22 文字) から導出する。
// 導出元: Sesame2BleAdvertisement.kt:68-74 / DataExtention.kt:36-46
//
// OS2 の manufacturerData は短く (companyID + productType + flags のみ)、16B UUID を含まない。
// UUID 導出式: (deviceName + "==").base64decode → 16B → hexToUuid
//
// テストデータのモック構造導出:
//   manufacturerData = [5A, 05, productType, 0x00, registeredBit] (company ID + 最低 3B advBytes)
//   localName = 16B UUID の base64エンコード (末尾 "==" を除いた 22 文字)
//   導出元: Sesame2BleAdvertisement.kt:31 (advBytes = scanRecord.manufacturerSpecificData.valueAt(0))
//          Sesame2BleAdvertisement.kt:36 (deviceName = scanRecord.deviceName)

describe("os2NameToUuid", () => {
  it("16B に対応する base64 22 文字 (+ '==' 補完) を UUID に変換する", () => {
    // 16B UUID バイト列を base64 エンコードすると 24 文字 (末尾 "==")。
    // deviceName は末尾 "==" を除いた 22 文字として BLE advertise に載る。
    // 導出元: Sesame2BleAdvertisement.kt:68-69 (deviceName + "==").base64decodeHex().noHashtoUUID()
    //         DataExtention.kt:36-46
    const uuidBytes = Buffer.from("11200423030002073200010100000000", "hex");
    const deviceName = uuidBytes.toString("base64").replace(/=+$/, "");
    expect(deviceName.length).toBe(22); // base64(16B) は必ず 22 文字になる
    expect(os2NameToUuid(deviceName)).toBe("11200423-0300-0207-3200-010100000000");
  });

  it("null / undefined → null", () => {
    expect(os2NameToUuid(null)).toBeNull();
    expect(os2NameToUuid(undefined)).toBeNull();
  });

  it("base64 decode 後が 16B でなければ null (Kotlin の catch→null 写像)", () => {
    // 8B → decode 後 6B。16B でないため null。
    // 導出元: Sesame2BleAdvertisement.kt:68-73 (catch → null)
    expect(os2NameToUuid("AAAAAAAA")).toBeNull();
  });

  it("不正な base64 文字列 → null (Kotlin の catch→null)", () => {
    // Node の Buffer.from(..., 'base64') は不正文字を無視して短いバッファを返すことがある。
    // 結果として長さ ≠ 16B になり null が返る。
    expect(os2NameToUuid("!!!invalid!!!")).toBeNull();
  });
});

describe("peripheralToDiscovery — OS2 機種 (P1-1)", () => {
  // OS2 の manufacturerData は短い: [company 2B][productType][flags]。16B UUID を含まない。
  // deviceID は localName (base64 22 文字) から導出する。
  // 導出元: Sesame2BleAdvertisement.kt:68-74

  // テスト用 16B UUID
  const UUID_BYTES = Buffer.from("aabbccddeeff00112233445566778899", "hex");
  const LOCAL_NAME = UUID_BYTES.toString("base64").replace(/=+$/, ""); // 22 文字
  const EXPECTED_UUID = "aabbccdd-eeff-0011-2233-445566778899";

  // OS2 の manufacturerData: company ID + productType + 登録ビット byte 2 つ (最小 advBytes 3B)
  // isRegistered = advBytes[2] bit0。productType は advBytes[0]。
  // 導出元: Sesame2BleAdvertisement.kt:31-44
  function os2Md(productType, registeredBit = 0) {
    return Buffer.from([...CO, productType, 0x00, registeredBit]);
  }

  it("SS2 (productType=0): localName から deviceUUID を導出し model/kind を返す", () => {
    const md = os2Md(0, 0x01); // sesame_2, registered
    const entry = peripheralToDiscovery(fakePeripheral({ md, localName: LOCAL_NAME, rssi: -55 }));
    expect(entry).toMatchObject({
      productType: 0,
      model: "sesame_2",
      kind: "sesame2",
      isRegistered: true,
      deviceUUID: EXPECTED_UUID,
      rssi: -55,
      localName: LOCAL_NAME,
    });
  });

  it("Bot1 (productType=2): localName から deviceUUID を導出し kind=botOs2", () => {
    const md = os2Md(2, 0x00); // ssmbot_1, not registered
    const entry = peripheralToDiscovery(fakePeripheral({ md, localName: LOCAL_NAME }));
    expect(entry).toMatchObject({
      productType: 2,
      model: "ssmbot_1",
      kind: "botOs2",
      isRegistered: false,
      deviceUUID: EXPECTED_UUID,
    });
  });

  it("Bike1 (productType=3): localName から deviceUUID を導出し kind=bikeOs2", () => {
    const md = os2Md(3, 0x00); // bike_1
    const entry = peripheralToDiscovery(fakePeripheral({ md, localName: LOCAL_NAME }));
    expect(entry).toMatchObject({
      productType: 3,
      model: "bike_1",
      kind: "bikeOs2",
      deviceUUID: EXPECTED_UUID,
    });
  });

  it("SS4 (productType=4): localName から deviceUUID を導出し kind=sesame2", () => {
    const md = os2Md(4, 0x00); // sesame_4
    const entry = peripheralToDiscovery(fakePeripheral({ md, localName: LOCAL_NAME }));
    expect(entry).toMatchObject({
      productType: 4,
      model: "sesame_4",
      kind: "sesame2",
      deviceUUID: EXPECTED_UUID,
    });
  });

  it("OS2: localName 不正 (decode≠16B) → deviceUUID=null → 列挙除外", () => {
    // peripheralToDiscovery は deviceUUID=null を除外する (操作を捏造しない)。
    const md = os2Md(0, 0x00);
    // 8 文字 base64 は decode 後 6B → 16B でないため null
    expect(peripheralToDiscovery(fakePeripheral({ md, localName: "AAAAAAAA" }))).toBeNull();
  });

  it("OS2: localName なし → deviceUUID=null → 列挙除外", () => {
    const md = os2Md(0, 0x00);
    expect(peripheralToDiscovery(fakePeripheral({ md, localName: undefined }))).toBeNull();
  });

  it("OS2: advToDeviceUUID は localName あり → UUID、なし → null", () => {
    // _scanForDevice の修正: isSesame は company ID 一致 (parseAdvertisement!=null) で判定するため、
    // advToDeviceUUID が null を返しても address 照合は通る。
    // このテストでは advToDeviceUUID の localName 配線を確認する。
    // 導出元: Sesame2BleAdvertisement.kt:68-74
    const md = os2Md(0, 0x00); // company ID 0x055A 含む
    // localName なし → UUID 取れない (OS2 はこうなる)
    expect(advToDeviceUUID(md, undefined)).toBeNull();
    // localName あり → UUID 取れる
    expect(advToDeviceUUID(md, LOCAL_NAME)).toBe(EXPECTED_UUID);
  });
});
