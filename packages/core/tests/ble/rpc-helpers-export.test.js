// P5-3 受け入れ基準テスト: BLE RPC ヘルパが ble/index.js から import 可能なこと (SURF-39 WiFi 収集部)。
//
// - invokePath / reviveJsonArg / collectWifiScan / wifiViewOf / bleCommandAck / WM2_API_GATEWAY_CLIENT_ID
//   が src/ble/index.js から named export されていること。
// - collectWifiScan が WM2 の publish ({kind:"scanWifiSSID"}) を収集し、Hub3 の末尾マーカーで
//   早期確定することの単体動作を確認する (実装は rpc-helpers.js に移設済み)。
// - invokePath が fail-closed (allowlist 非掲載は拒否) で動作することを確認する。
import { describe, it, expect } from "vitest";
import {
  invokePath,
  reviveJsonArg,
  collectWifiScan,
  wifiViewOf,
  bleCommandAck,
  WM2_API_GATEWAY_CLIENT_ID,
  BLE_RPC_ALLOWLIST,
  capabilitiesForModel,
} from "../../src/ble/index.js";
import { ITEM_CODES } from "../../src/itemcodes.js";

describe("P5-3: BLE RPC ヘルパが ble/index.js から import 可能 (SURF-39 WiFi 収集部)", () => {
  it("named export として存在する", () => {
    expect(typeof invokePath).toBe("function");
    expect(typeof reviveJsonArg).toBe("function");
    expect(typeof collectWifiScan).toBe("function");
    expect(typeof wifiViewOf).toBe("function");
    expect(typeof bleCommandAck).toBe("function");
    expect(typeof WM2_API_GATEWAY_CLIENT_ID).toBe("string");
  });

  it("WM2_API_GATEWAY_CLIENT_ID は既定の clientId 文字列", () => {
    // 出典: _sesame_sdk_ref/app.properties:6 `aws.apigateway.clientId`
    expect(WM2_API_GATEWAY_CLIENT_ID).toBe("ap-northeast-1:0a1820f1-dbb3-4bca-9227-2a92f6abf0ae");
  });

  it("bleCommandAck は resultCode から resultName を組む", () => {
    const ack = bleCommandAck({ resultCode: 0 });
    expect(ack).toMatchObject({ resultCode: 0, resultName: expect.any(String) });
  });

  it("reviveJsonArg は {$buffer:hex} を Buffer に復元する", () => {
    const buf = reviveJsonArg({ $buffer: "deadbeef" });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf).toEqual(Buffer.from("deadbeef", "hex"));
  });

  it("reviveJsonArg は prototype 汚染キーを拒否する", () => {
    // __proto__ は JS がオブジェクトリテラルで特別扱いするためエントリとして列挙されない。
    // constructor / prototype は通常のキーとして渡せばチェックされる。
    expect(() => reviveJsonArg({ constructor: "evil" })).toThrow();
    expect(() => reviveJsonArg({ prototype: "evil" })).toThrow();
  });

  it("invokePath は allowlist 非掲載の第1セグメントを bad_params で拒否 (fail-closed)", async () => {
    const root = { evil: async () => "pwned" };
    await expect(invokePath(root, "evil", [], BLE_RPC_ALLOWLIST)).rejects.toThrow("unsupported BLE op");
  });

  it("invokePath は allowlist 掲載 op を実行できる", async () => {
    const root = { lock: async () => ({ resultCode: 0, payload: Buffer.alloc(0) }) };
    const result = await invokePath(root, "lock", [], BLE_RPC_ALLOWLIST);
    expect(result).toMatchObject({ resultCode: 0 });
  });

  it("collectWifiScan は WM2 の scanWifiSSID publish を収集して ssids 配列を返す", async () => {
    let publishCb = null;
    const view = {
      onPublish: (fn) => { publishCb = fn; return () => { publishCb = null; }; },
      scanWifiSSID: async () => {
        // シミュレート: 即座に 2 件 publish し、収集タイムアウトで確定する
        publishCb({ kind: "scanWifiSSID", ssid: "MySSID", rssi: -60 });
        publishCb({ kind: "scanWifiSSID", ssid: "OtherSSID", rssi: -70 });
        return { resultCode: 0 };
      },
    };
    const { ssids } = await collectWifiScan(view, { collectMs: 50 });
    expect(ssids.length).toBe(2);
    expect(ssids.map((s) => s.ssid)).toContain("MySSID");
    expect(ssids.map((s) => s.ssid)).toContain("OtherSSID");
  });

  it("collectWifiScan は Hub3 の ssidMarker(SSID_LAST) で早期確定する", async () => {
    let publishCb = null;
    const view = {
      onPublish: (fn) => { publishCb = fn; return () => { publishCb = null; }; },
      scanWifiSSID: async () => {
        publishCb({ kind: "scanWifiSSID", ssid: "Hub3SSID", rssi: -55 });
        publishCb({ kind: "ssidMarker", itemCode: ITEM_CODES.HUB3_ITEM_CODE_SSID_LAST });
        return { resultCode: 0 };
      },
    };
    // collectMs を大きくしても ssidMarker で早期解決する
    const { ssids } = await collectWifiScan(view, { collectMs: 5000 });
    expect(ssids).toHaveLength(1);
    expect(ssids[0].ssid).toBe("Hub3SSID");
  });

  it("wifiViewOf は WM2 model で type:'wm2' を返し wifi() を companyId 付きで呼ぶ", () => {
    const caps = capabilitiesForModel("wm_2"); // 正しいモデル文字列 (devicemodel.js PRODUCT_TYPES[1])
    let capturedCompanyId = null;
    const ble = {
      capabilities: caps,
      wifi: ({ companyId }) => { capturedCompanyId = companyId; return { isWm2View: true }; },
      hub3: () => ({ isHub3View: true }),
    };
    const { type, view } = wifiViewOf(ble, {});
    expect(type).toBe("wm2");
    expect(view).toMatchObject({ isWm2View: true });
    // 既定 companyId は WM2_API_GATEWAY_CLIENT_ID
    expect(capturedCompanyId).toBe(WM2_API_GATEWAY_CLIENT_ID);
  });

  it("wifiViewOf は Hub3 model で type:'hub3' を返す", () => {
    const caps = capabilitiesForModel("hub_3");
    const ble = {
      capabilities: caps,
      wifi: () => ({ isWm2View: true }),
      hub3: () => ({ isHub3View: true }),
    };
    const { type, view } = wifiViewOf(ble, {});
    expect(type).toBe("hub3");
    expect(view).toMatchObject({ isHub3View: true });
  });

  it("wifiViewOf は非 WiFi/Hub3 model で bad_params エラーを投げる", () => {
    const caps = capabilitiesForModel("sesame_5");
    const ble = { capabilities: caps, wifi: () => {}, hub3: () => {} };
    expect(() => wifiViewOf(ble, {})).toThrow();
  });
});
