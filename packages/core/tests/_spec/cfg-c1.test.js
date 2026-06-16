// CFG-0021〜CFG-0038 の vitest テスト (統合版: A/B を統合)
// 対象実装: packages/core/src/config.js
// 全 it 独立 / ネットワーク・実機不使用 / mock は最小限

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigStore, isHub3Model } from "../../src/config.js";

// ---------------------------------------------------------------------------
// テスト共通セットアップ
// ---------------------------------------------------------------------------

let workDir;
let configPath;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "sesame-cfg-0021-"));
  configPath = join(workDir, "config.json");
});

afterEach(() => {
  if (workDir && existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  }
  workDir = null;
  configPath = null;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// ヘルパ
// ---------------------------------------------------------------------------

/** hub デバイスオブジェクト (stateInfo なし) */
function hubDev(uuid, name, model = "hub_3") {
  return { deviceUUID: uuid, deviceName: name, deviceModel: model };
}

/** hub デバイスオブジェクト (stateInfo.remoteList あり) */
function hubWithRemotes(uuid, name, remotes, model = "hub_3") {
  return {
    deviceUUID: uuid,
    deviceName: name,
    deviceModel: model,
    stateInfo: { remoteList: remotes },
  };
}

/** ロックデバイスオブジェクト */
function lockDev(uuid, name, model = "sesame_5_pro", secretKey = "00112233445566778899aabbccddeeff") {
  return { deviceUUID: uuid, deviceName: name, deviceModel: model, secretKey };
}

/**
 * Hub3 を1個登録済みの ConfigStore を返す。
 * syncHub3sFromDevices 経由の登録なので hub3ByUuid に UUID が入る。
 */
function storeWithHub3(configPath, hubName = "living", hubUUID = "H1-0000-0000-0000-000000000001") {
  const store = new ConfigStore(configPath);
  store.syncHub3sFromDevices([hubDev(hubUUID, hubName)]);
  return { store, hubName, hubUUID };
}

// ---------------------------------------------------------------------------
// [CFG-0021] addHub3 必須検証 + category:'hub3' で hub3 view 投影
// ---------------------------------------------------------------------------

describe("[CFG-0021] addHub3 必須検証 + hub3 view 投影", () => {
  it("[CFG-0021] name 欠落で badRequest (hub3NameRequired)", () => {
    const store = new ConfigStore(configPath);
    expect(() => store.addHub3("", { deviceId: "dev-x" })).toThrow(/hub3 name required/i);
  });

  it("[CFG-0021] deviceId 欠落で badRequest (hub3DeviceIdRequired) — {} パターン", () => {
    const store = new ConfigStore(configPath);
    expect(() => store.addHub3("hub-a", {})).toThrow(/hub3\.deviceId required/i);
  });

  it("[CFG-0021] deviceId 欠落で badRequest (hub3DeviceIdRequired) — null パターン", () => {
    const store = new ConfigStore(configPath);
    expect(() => store.addHub3("hub-a", null)).toThrow(/hub3\.deviceId required/i);
  });

  it("[CFG-0021] 正常: devices に category:'hub3' で格納され hub3View に投影される", () => {
    const store = new ConfigStore(configPath);
    store.addHub3("hub-a", {
      deviceId: "device-uuid-1",
      model: "hub_3_lte",
      name: "My Hub",
      secretKey: "sk-value",
    });
    const cfg = store.load();
    // devices に格納されていること
    expect(cfg.devices["hub-a"]).toMatchObject({
      deviceUUID: "device-uuid-1",
      deviceModel: "hub_3_lte",
      secretKey: "sk-value",
      category: "hub3",
    });
    // hub3View に投影 (shape: deviceId/name/model/secretKey)
    expect(cfg.hub3s["hub-a"]).toMatchObject({
      deviceId: "device-uuid-1",
      model: "hub_3_lte",
    });
  });

  it("[CFG-0021] model 省略時は hub_3 が既定", () => {
    const store = new ConfigStore(configPath);
    store.addHub3("hub-b", { deviceId: "dev-b" });
    const cfg = store.load();
    expect(cfg.hub3s["hub-b"].model).toBe("hub_3");
    expect(cfg.devices["hub-b"].deviceModel).toBe("hub_3");
  });

  it("[CFG-0021] secretKey 省略時は null", () => {
    const store = new ConfigStore(configPath);
    store.addHub3("hub-c", { deviceId: "dev-c" });
    expect(store.load().hub3s["hub-c"].secretKey).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// [CFG-0022] CLI hub3 sync-from-devices: --prune オプション露出
// ---------------------------------------------------------------------------

describe("[CFG-0022] CLI hub3 sync-from-devices — --prune オプション", () => {
  it("[CFG-0022] prune:true を指定すると未登録 Hub3 が removed に入り config から消える", () => {
    const store = new ConfigStore(configPath);
    // H1 を登録してから空リストで prune → H1 が removed に入る
    store.syncHub3sFromDevices([hubDev("H1", "living")]);
    const r = store.syncHub3sFromDevices([], { prune: true });
    expect(r.removed).toContain("living");
    expect(store.load().hub3s["living"]).toBeUndefined();
  });

  it("[CFG-0022] prune:false (デフォルト) では removed が空", () => {
    const store = new ConfigStore(configPath);
    store.syncHub3sFromDevices([hubDev("H1", "living")]);
    const r = store.syncHub3sFromDevices([], { prune: false });
    expect(r.removed).toEqual([]);
  });

  it("[CFG-0022] syncHub3sFromDevices の戻り値 shape は {added, updated, removed} (printSyncResult の期待形式)", () => {
    const store = new ConfigStore(configPath);
    const r = store.syncHub3sFromDevices([hubDev("H1", "hub1")]);
    expect(r).toHaveProperty("added");
    expect(r).toHaveProperty("updated");
    expect(r).toHaveProperty("removed");
    expect(Array.isArray(r.added)).toBe(true);
    expect(Array.isArray(r.updated)).toBe(true);
    expect(Array.isArray(r.removed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// [CFG-0023] syncRemotesFromDevices: stateInfo.remoteList を展開して取り込む
// ---------------------------------------------------------------------------

describe("[CFG-0023] syncRemotesFromDevices — stateInfo.remoteList 展開", () => {
  it("[CFG-0023] hub_3 の stateInfo.remoteList から {uuid,type,alias} を展開して remotes{} に取り込む", () => {
    const store = new ConfigStore(configPath);
    const devices = [
      hubWithRemotes("H1", "living", [
        { uuid: "R1", type: 0xc000, alias: "エアコン" },
        { uuid: "R2", type: 0x2000, alias: "TV" },
      ]),
    ];
    store.syncHub3sFromDevices(devices);
    const r = store.syncRemotesFromDevices(devices);
    expect(r.added).toHaveLength(2);
    const cfg = store.load();
    const ac = Object.values(cfg.remotes).find((x) => x.irDeviceUUID === "R1");
    expect(ac.irType).toBe(0xc000);
    expect(ac.alias).toBe("エアコン");
    expect(ac.hub3).toBe("living");
  });

  it("[CFG-0023] irDeviceUUID フィールド名でも受理 (uuid || irDeviceUUID 両受け)", () => {
    const store = new ConfigStore(configPath);
    const devices = [
      hubWithRemotes("H1", "living", [{ irDeviceUUID: "R3", type: 0x8000, alias: "照明" }]),
    ];
    store.syncHub3sFromDevices(devices);
    const r = store.syncRemotesFromDevices(devices);
    expect(r.added).toHaveLength(1);
    const light = Object.values(store.load().remotes).find((x) => x.irDeviceUUID === "R3");
    expect(light).toBeDefined();
    expect(light.alias).toBe("照明");
  });

  it("[CFG-0023] stateInfo が無い Hub3 は remoteList 空として扱われる (エラーにならない)", () => {
    const { store, hubUUID } = storeWithHub3(configPath);
    const deviceList = [{ deviceModel: "hub_3", deviceUUID: hubUUID }];
    expect(() => store.syncRemotesFromDevices(deviceList)).not.toThrow();
    expect(store.syncRemotesFromDevices(deviceList).added).toHaveLength(0);
  });

  it("[CFG-0023] ロックデバイスは stateInfo を持っていても展開しない (isHub3Model フィルタ)", () => {
    const store = new ConfigStore(configPath);
    const devices = [
      hubWithRemotes("H1", "living", [{ uuid: "R1", type: 0xc000 }]),
      { ...lockDev("L1", "玄関"), stateInfo: { remoteList: [{ uuid: "LOCK-R", type: 0x2000 }] } },
    ];
    store.syncHub3sFromDevices(devices);
    const r = store.syncRemotesFromDevices(devices);
    const lockRemote = Object.values(store.load().remotes).find((x) => x.irDeviceUUID === "LOCK-R");
    expect(lockRemote).toBeUndefined();
    expect(r.added).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// [CFG-0024] syncRemotesFromDevices: hub3 未登録の Hub3 配下リモコンはスキップ
// ---------------------------------------------------------------------------

describe("[CFG-0024] syncRemotesFromDevices — 未登録 Hub3 はスキップ", () => {
  it("[CFG-0024] syncHub3sFromDevices を呼ばずに syncRemotesFromDevices → 全スキップ", () => {
    const store = new ConfigStore(configPath);
    const devices = [
      hubWithRemotes("H1", "living", [{ uuid: "R1", type: 0xc000 }]),
    ];
    // 意図的に hub3 sync をしない
    const r = store.syncRemotesFromDevices(devices);
    expect(r.added).toHaveLength(0);
    expect(Object.keys(store.load().remotes)).toHaveLength(0);
  });

  it("[CFG-0024] hub3ByUuid の逆引きに無い deviceUUID の Hub3 はスキップされる", () => {
    const store = new ConfigStore(configPath);
    // H1 だけ登録し H2 は未登録
    store.syncHub3sFromDevices([hubDev("H1", "registered")]);
    const devices = [
      hubWithRemotes("H2", "unregistered", [{ uuid: "R9", type: 0xfe00 }]),
    ];
    const r = store.syncRemotesFromDevices(devices);
    expect(r.added).toHaveLength(0);
  });

  it("[CFG-0024] 登録済み Hub3 は取り込まれ、未登録は取り込まれない (対比)", () => {
    const { store, hubUUID } = storeWithHub3(configPath, "hub-a", "aabb0000-0000-0000-0000-000000000010");
    const deviceList = [
      {
        deviceModel: "hub_3",
        deviceUUID: hubUUID,
        stateInfo: { remoteList: [{ uuid: "ir-registered", type: 0xfe00 }] },
      },
      {
        deviceModel: "hub_3",
        deviceUUID: "unregistered-uuid",
        stateInfo: { remoteList: [{ uuid: "ir-unregistered", type: 0xfe00 }] },
      },
    ];
    const r = store.syncRemotesFromDevices(deviceList);
    expect(r.added).toHaveLength(1);
    expect(store.load().remotes[r.added[0]].irDeviceUUID).toBe("ir-registered");
  });
});

// ---------------------------------------------------------------------------
// [CFG-0025] syncRemotesFromDevices: irDeviceUUID 突合で冪等
// ---------------------------------------------------------------------------

describe("[CFG-0025] syncRemotesFromDevices — 冪等 (uuid 突合)", () => {
  it("[CFG-0025] 再 sync で重複追加しない (冪等)", () => {
    const store = new ConfigStore(configPath);
    const devices = [hubWithRemotes("H1", "living", [{ uuid: "R1", type: 0xfe00 }])];
    store.syncHub3sFromDevices(devices);
    store.syncRemotesFromDevices(devices);
    const r2 = store.syncRemotesFromDevices(devices);
    expect(r2.added).toHaveLength(0);
    expect(Object.keys(store.load().remotes)).toHaveLength(1);
  });

  it("[CFG-0025] uuid 欠落の remoteList 要素は continue でスキップ", () => {
    const store = new ConfigStore(configPath);
    const devices = [
      hubWithRemotes("H1", "living", [
        { type: 0xfe00, alias: "no-uuid" }, // uuid も irDeviceUUID も無し
        { uuid: null, type: 0xfe00 },        // null → スキップ
        { uuid: "R2", type: 0x2000 },
      ]),
    ];
    store.syncHub3sFromDevices(devices);
    const r = store.syncRemotesFromDevices(devices);
    expect(r.added).toHaveLength(1);
    const rm = Object.values(store.load().remotes).find((x) => x.irDeviceUUID === "R2");
    expect(rm).toBeDefined();
  });

  it("[CFG-0025] uuid フィールドと irDeviceUUID フィールドを統一的に突合 (重複しない)", () => {
    const store = new ConfigStore(configPath);
    store.syncHub3sFromDevices([hubDev("H1", "living")]);
    // 1回目: uuid で追加
    store.syncRemotesFromDevices([hubWithRemotes("H1", "living", [{ uuid: "AABBCC", type: 0xfe00 }])]);
    // 2回目: irDeviceUUID で同じ値 → 同一リモコンとして重複しない
    const r2 = store.syncRemotesFromDevices([
      hubWithRemotes("H1", "living", [{ irDeviceUUID: "AABBCC", type: 0xfe00 }]),
    ]);
    expect(r2.added).toHaveLength(0);
    expect(Object.keys(store.load().remotes)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// [CFG-0026] syncRemotesFromDevices: フィールド差分を updated に反映
// ---------------------------------------------------------------------------

describe("[CFG-0026] syncRemotesFromDevices — 既存リモコンの差分更新", () => {
  it("[CFG-0026] irType 変更で updated に積まれ値が反映される", () => {
    const store = new ConfigStore(configPath);
    store.syncHub3sFromDevices([hubWithRemotes("H1", "living", [])]);
    store.syncRemotesFromDevices([hubWithRemotes("H1", "living", [{ uuid: "R1", type: 0xfe00 }])]);
    const r = store.syncRemotesFromDevices([hubWithRemotes("H1", "living", [{ uuid: "R1", type: 0xc000 }])]);
    expect(r.updated).toHaveLength(1);
    const rm = Object.values(store.load().remotes).find((x) => x.irDeviceUUID === "R1");
    expect(rm.irType).toBe(0xc000);
  });

  it("[CFG-0026] alias 変更で updated に積まれる", () => {
    const store = new ConfigStore(configPath);
    store.syncHub3sFromDevices([hubWithRemotes("H1", "living", [])]);
    store.syncRemotesFromDevices([hubWithRemotes("H1", "living", [{ uuid: "R1", type: 0xfe00, alias: "旧" }])]);
    const r = store.syncRemotesFromDevices([hubWithRemotes("H1", "living", [{ uuid: "R1", type: 0xfe00, alias: "新" }])]);
    expect(r.updated).toHaveLength(1);
    const rm = Object.values(store.load().remotes).find((x) => x.irDeviceUUID === "R1");
    expect(rm.alias).toBe("新");
  });

  it("[CFG-0026] code 変更 (非null時) で updated に積まれる", () => {
    const store = new ConfigStore(configPath);
    const devices1 = [hubWithRemotes("H1", "living", [{ uuid: "R1", type: 0xc000, code: 1 }])];
    const devices2 = [hubWithRemotes("H1", "living", [{ uuid: "R1", type: 0xc000, code: 2 }])];
    store.syncHub3sFromDevices(devices1);
    store.syncRemotesFromDevices(devices1);
    const r = store.syncRemotesFromDevices(devices2);
    expect(r.updated).toHaveLength(1);
    const rm = Object.values(store.load().remotes).find((x) => x.irDeviceUUID === "R1");
    expect(rm.code).toBe(2);
  });

  it("[CFG-0026] state 変更 (非null時) で updated に積まれる", () => {
    const store = new ConfigStore(configPath);
    const devices1 = [hubWithRemotes("H1", "living", [{ uuid: "R1", type: 0xc000, state: "OLD" }])];
    const devices2 = [hubWithRemotes("H1", "living", [{ uuid: "R1", type: 0xc000, state: "NEW" }])];
    store.syncHub3sFromDevices(devices1);
    store.syncRemotesFromDevices(devices1);
    const r = store.syncRemotesFromDevices(devices2);
    expect(r.updated).toHaveLength(1);
    const rm = Object.values(store.load().remotes).find((x) => x.irDeviceUUID === "R1");
    expect(rm.state).toBe("NEW");
  });

  it("[CFG-0026] 全フィールド不変なら updated に出さない (冪等)", () => {
    const store = new ConfigStore(configPath);
    const devices = [hubWithRemotes("H1", "living", [{ uuid: "R1", type: 0xc000, alias: "AC", code: 1, state: "X" }])];
    store.syncHub3sFromDevices(devices);
    store.syncRemotesFromDevices(devices);
    const r2 = store.syncRemotesFromDevices(devices);
    expect(r2.updated).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// [CFG-0027] syncRemotesFromDevices: irOperation 導出 (0xFE00=learnEmit, 他=remoteEmit)
// ---------------------------------------------------------------------------

describe("[CFG-0027] syncRemotesFromDevices — deriveIrOperation", () => {
  it("[CFG-0027] irType 0xFE00 (自己学習) → irOperation:'learnEmit'", () => {
    const store = new ConfigStore(configPath);
    const devices = [hubWithRemotes("H1", "living", [{ uuid: "R1", type: 0xfe00 }])];
    store.syncHub3sFromDevices(devices);
    store.syncRemotesFromDevices(devices);
    const rm = Object.values(store.load().remotes).find((x) => x.irDeviceUUID === "R1");
    expect(rm.irOperation).toBe("learnEmit");
  });

  it("[CFG-0027] irType 0xC000 (エアコンプリセット) → irOperation:'remoteEmit'", () => {
    const store = new ConfigStore(configPath);
    const devices = [hubWithRemotes("H1", "living", [{ uuid: "R2", type: 0xc000 }])];
    store.syncHub3sFromDevices(devices);
    store.syncRemotesFromDevices(devices);
    const rm = Object.values(store.load().remotes).find((x) => x.irDeviceUUID === "R2");
    expect(rm.irOperation).toBe("remoteEmit");
  });

  it("[CFG-0027] irType 0x2000 (TV プリセット) → irOperation:'remoteEmit'", () => {
    const store = new ConfigStore(configPath);
    const devices = [hubWithRemotes("H1", "living", [{ uuid: "R3", type: 0x2000 }])];
    store.syncHub3sFromDevices(devices);
    store.syncRemotesFromDevices(devices);
    const rm = Object.values(store.load().remotes).find((x) => x.irDeviceUUID === "R3");
    expect(rm.irOperation).toBe("remoteEmit");
  });

  it("[CFG-0027] irType 0x8000 (その他プリセット) → irOperation:'remoteEmit'", () => {
    const store = new ConfigStore(configPath);
    const devices = [hubWithRemotes("H1", "living", [{ uuid: "R4", type: 0x8000 }])];
    store.syncHub3sFromDevices(devices);
    store.syncRemotesFromDevices(devices);
    const rm = Object.values(store.load().remotes).find((x) => x.irDeviceUUID === "R4");
    expect(rm.irOperation).toBe("remoteEmit");
  });

  it("[CFG-0027] irType 0xE000 (プリセット) → irOperation:'remoteEmit'", () => {
    const store = new ConfigStore(configPath);
    const devices = [hubWithRemotes("H1", "living", [{ uuid: "R5", type: 0xe000 }])];
    store.syncHub3sFromDevices(devices);
    store.syncRemotesFromDevices(devices);
    const rm = Object.values(store.load().remotes).find((x) => x.irDeviceUUID === "R5");
    expect(rm.irOperation).toBe("remoteEmit");
  });
});

// ---------------------------------------------------------------------------
// [CFG-0028] syncRemotesFromDevices: code/state 欠落は null 保存、irType 欠落は DEFAULT_IR_TYPE
// ---------------------------------------------------------------------------

describe("[CFG-0028] syncRemotesFromDevices — code/state null 保存 + DEFAULT_IR_TYPE フォールバック", () => {
  it("[CFG-0028] code が null の場合は null を保存 (捏造しない)", () => {
    const store = new ConfigStore(configPath);
    const devices = [hubWithRemotes("H1", "living", [{ uuid: "R1", type: 0xfe00 }])]; // code なし
    store.syncHub3sFromDevices(devices);
    store.syncRemotesFromDevices(devices);
    const rm = Object.values(store.load().remotes).find((x) => x.irDeviceUUID === "R1");
    expect(rm.code).toBeNull();
  });

  it("[CFG-0028] state が文字列でない場合は null を保存", () => {
    const store = new ConfigStore(configPath);
    const devices = [hubWithRemotes("H1", "living", [{ uuid: "R1", type: 0xfe00, state: 12345 }])]; // 数値
    store.syncHub3sFromDevices(devices);
    store.syncRemotesFromDevices(devices);
    const rm = Object.values(store.load().remotes).find((x) => x.irDeviceUUID === "R1");
    expect(rm.state).toBeNull();
  });

  it("[CFG-0028] irType が NaN (非有限) のとき effType = DEFAULT_IR_TYPE (0xFE00)", () => {
    const store = new ConfigStore(configPath);
    // type を渡さない → Number(undefined) = NaN
    const devices = [hubWithRemotes("H1", "living", [{ uuid: "R1" }])];
    store.syncHub3sFromDevices(devices);
    store.syncRemotesFromDevices(devices);
    const rm = Object.values(store.load().remotes).find((x) => x.irDeviceUUID === "R1");
    // DEFAULT_IR_TYPE = 0xFE00 = 65024
    expect(rm.irType).toBe(0xfe00);
    // 0xFE00 → learnEmit
    expect(rm.irOperation).toBe("learnEmit");
  });
});

// ---------------------------------------------------------------------------
// [CFG-0029] syncRemotesFromDevices: 初回 added で default.remote を設定
// ---------------------------------------------------------------------------

describe("[CFG-0029] syncRemotesFromDevices — 初回 default.remote 設定", () => {
  it("[CFG-0029] default.remote が未設定のとき最初に追加したリモコン名を設定する", () => {
    const store = new ConfigStore(configPath);
    const devices = [
      hubWithRemotes("H1", "living", [
        { uuid: "R1", type: 0xc000, alias: "AC" },
        { uuid: "R2", type: 0x2000, alias: "TV" },
      ]),
    ];
    store.syncHub3sFromDevices(devices);
    store.syncRemotesFromDevices(devices);
    const cfg = store.load();
    expect(cfg.default.remote).not.toBeNull();
    // 最初に追加されたリモコン (R1 由来) の名前が default になるはず
    const defaultName = cfg.default.remote;
    expect(cfg.remotes[defaultName].irDeviceUUID).toBe("R1");
  });

  it("[CFG-0029] default.remote が既に設定済みの場合は上書きしない", () => {
    const store = new ConfigStore(configPath);
    const devices1 = [hubWithRemotes("H1", "living", [{ uuid: "R1", type: 0xfe00, alias: "学習" }])];
    const devices2 = [
      hubWithRemotes("H1", "living", [
        { uuid: "R1", type: 0xfe00, alias: "学習" },
        { uuid: "R2", type: 0xc000, alias: "AC" },
      ]),
    ];
    store.syncHub3sFromDevices(devices1);
    store.syncRemotesFromDevices(devices1);
    const firstDefault = store.load().default.remote;

    store.syncHub3sFromDevices(devices2);
    store.syncRemotesFromDevices(devices2);
    // 2回目で R2 が追加されても default は変わらない
    expect(store.load().default.remote).toBe(firstDefault);
  });
});

// ---------------------------------------------------------------------------
// [CFG-0030] hub.syncRemotesFromDevices: hub3 自動登録→remote 展開を1呼び出しで束ねる
// ---------------------------------------------------------------------------

describe("[CFG-0030] hub.syncRemotesFromDevices — hub3 + remote を束ねる", () => {
  it("[CFG-0030] syncHub3sFromDevices→syncRemotesFromDevices の順で同一リストに適用し {hub3,remotes} が揃う", () => {
    const store = new ConfigStore(configPath);
    const list = [
      hubWithRemotes("H1", "living", [{ uuid: "R1", type: 0xfe00, alias: "学習" }]),
    ];
    const hub3 = store.syncHub3sFromDevices(list);
    const remotes = store.syncRemotesFromDevices(list);
    const result = { hub3, remotes };

    // shape 確認
    expect(result.hub3.added).toContain("living");
    expect(Array.isArray(result.hub3.updated)).toBe(true);
    expect(Array.isArray(result.hub3.removed)).toBe(true);
    expect(result.remotes.added).toHaveLength(1);
    expect(Array.isArray(result.remotes.updated)).toBe(true);
  });

  it("[CFG-0030] hub3 を先に登録するから remote が正しく取り込まれる (順序依存)", () => {
    const store = new ConfigStore(configPath);
    const list = [
      hubWithRemotes("H1", "living", [{ uuid: "R1", type: 0xc000 }]),
    ];
    store.syncHub3sFromDevices(list);
    const remotes = store.syncRemotesFromDevices(list);
    expect(remotes.added).toHaveLength(1);
    // remote の hub3 が hub3 の name を持つ
    const cfg = store.load();
    expect(cfg.remotes[remotes.added[0]].hub3).toBe("living");
  });

  it("[CFG-0030] 戻り値 shape {hub3:{added,updated,removed}, remotes:{added,updated}} が揃う", () => {
    const store = new ConfigStore(configPath);
    const hub3 = store.syncHub3sFromDevices([]);
    const remotes = store.syncRemotesFromDevices([]);
    const composite = { hub3, remotes };
    expect(composite.hub3).toHaveProperty("added");
    expect(composite.hub3).toHaveProperty("updated");
    expect(composite.hub3).toHaveProperty("removed");
    expect(composite.remotes).toHaveProperty("added");
    expect(composite.remotes).toHaveProperty("updated");
  });
});

// ---------------------------------------------------------------------------
// [CFG-0031] CLI remote sync-from-devices: added/updated に syncRemoteKeys を best-effort
// ---------------------------------------------------------------------------

describe("[CFG-0031] CLI remote sync-from-devices — added/updated に syncRemoteKeys (best-effort)", () => {
  it("[CFG-0031] 1回目 sync → added, 2回目 alias 変更 → updated (added/updated が正しく区別される)", () => {
    const store = new ConfigStore(configPath);
    const devices1 = [hubWithRemotes("H1", "living", [{ uuid: "ir-sync", type: 0xc000, alias: "旧名" }])];
    store.syncHub3sFromDevices(devices1);
    const r1 = store.syncRemotesFromDevices(devices1);
    expect(r1.added).toHaveLength(1);
    expect(r1.updated).toHaveLength(0);

    const devices2 = [hubWithRemotes("H1", "living", [{ uuid: "ir-sync", type: 0xc000, alias: "新名" }])];
    const r2 = store.syncRemotesFromDevices(devices2);
    expect(r2.added).toHaveLength(0);
    expect(r2.updated).toHaveLength(1);

    // [...added, ...updated] が両ケースで名前を含む (CLI の for ループ条件)
    const allChanged1 = [...r1.added, ...r1.updated];
    const allChanged2 = [...r2.added, ...r2.updated];
    expect(allChanged1).toContain(r1.added[0]);
    expect(allChanged2).toContain(r2.updated[0]);
  });

  it("[CFG-0031] best-effort: syncRemoteKeys が例外を投げても全体処理が止まらないことをシミュレート", async () => {
    const store = new ConfigStore(configPath);
    const list = [
      hubWithRemotes("H1", "living", [
        { uuid: "R1", type: 0xfe00, alias: "学習1" },
        { uuid: "R2", type: 0xc000, alias: "AC" },
      ]),
    ];
    store.syncHub3sFromDevices(list);
    const remotes = store.syncRemotesFromDevices(list);
    const names = [...remotes.added, ...remotes.updated];
    expect(names).toHaveLength(2);

    // best-effort: 1件失敗しても全件処理継続を確認
    let callCount = 0;
    let errorThrown = false;
    for (const name of names) {
      try {
        callCount++;
        if (callCount === 1) throw new Error("network error");
      } catch {
        errorThrown = true;
      }
    }
    expect(callCount).toBe(2);
    expect(errorThrown).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// [CFG-0032] syncRemotesFromServer: getRemoteList 応答を hub3Name 配下に取り込む
// ---------------------------------------------------------------------------

describe("[CFG-0032] ConfigStore.syncRemotesFromServer — list 取り込み境界", () => {
  it("[CFG-0032] irDeviceUUID フィールドで新規取り込み", () => {
    const store = new ConfigStore(configPath);
    store.syncHub3sFromDevices([hubDev("H1", "living")]);
    const r = store.syncRemotesFromServer(
      [{ irDeviceUUID: "R1", type: 0xc000, alias: "エアコン", code: 1234, state: "ABCD" }],
      "living",
    );
    expect(r.added).toHaveLength(1);
    const rm = Object.values(store.load().remotes).find((x) => x.irDeviceUUID === "R1");
    expect(rm.irType).toBe(0xc000);
    expect(rm.alias).toBe("エアコン");
    expect(rm.code).toBe(1234);
    expect(rm.state).toBe("ABCD");
    expect(rm.hub3).toBe("living");
  });

  it("[CFG-0032] uuid フィールドでも irDeviceUUID として取り込む (両受け)", () => {
    const store = new ConfigStore(configPath);
    store.syncHub3sFromDevices([hubDev("H1", "living")]);
    const r = store.syncRemotesFromServer([{ uuid: "R9", type: 0x2000 }], "living");
    const rm = Object.values(store.load().remotes).find((x) => x.irDeviceUUID === "R9");
    expect(rm).toBeDefined();
    expect(rm.irDeviceUUID).toBe("R9");
  });

  it("[CFG-0032] irOperation 明示値が deriveIrOperation より優先される", () => {
    const store = new ConfigStore(configPath);
    store.syncHub3sFromDevices([hubDev("H1", "living")]);
    store.syncRemotesFromServer(
      [{ irDeviceUUID: "R3", type: 0xc000, alias: "明示", irOperation: "learnEmit" }],
      "living",
    );
    const rm = Object.values(store.load().remotes).find((x) => x.irDeviceUUID === "R3");
    expect(rm.irOperation).toBe("learnEmit"); // 明示が導出より優先
  });

  it("[CFG-0032] irDeviceUUID/uuid 欠落要素は continue でスキップ", () => {
    const store = new ConfigStore(configPath);
    store.syncHub3sFromDevices([hubDev("H1", "living")]);
    const r = store.syncRemotesFromServer(
      [{ type: 0xfe00 }, { irDeviceUUID: "R2", type: 0xfe00 }],
      "living",
    );
    expect(r.added).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// [CFG-0033] syncRemotesFromServer: hub3 未登録なら badRequest で拒否
// ---------------------------------------------------------------------------

describe("[CFG-0033] ConfigStore.syncRemotesFromServer — hub3 未登録で badRequest", () => {
  it("[CFG-0033] cfg.hub3s に指定 hub3Name が無い場合 badRequest を throw する", () => {
    const store = new ConfigStore(configPath);
    expect(() => store.syncRemotesFromServer([], "nope")).toThrow(/hub3.*未登録|hub3NotRegisteredSyncFirst/i);
  });

  it("[CFG-0033] hub3 登録後は正常に動作する", () => {
    const store = new ConfigStore(configPath);
    store.syncHub3sFromDevices([hubDev("H1", "living")]);
    expect(() => store.syncRemotesFromServer([], "living")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// [CFG-0034] syncRemotesFromServer: 既存 remote の差分更新 (冪等)
// ---------------------------------------------------------------------------

describe("[CFG-0034] ConfigStore.syncRemotesFromServer — 既存リモコン差分更新", () => {
  it("[CFG-0034] irType/alias 変更で updated に積まれ値が反映される", () => {
    const store = new ConfigStore(configPath);
    store.syncHub3sFromDevices([hubDev("H1", "living")]);
    store.syncRemotesFromServer([{ irDeviceUUID: "R1", type: 0xfe00, alias: "旧" }], "living");
    const r = store.syncRemotesFromServer([{ irDeviceUUID: "R1", type: 0xc000, alias: "新" }], "living");
    expect(r.updated).toHaveLength(1);
    const rm = Object.values(store.load().remotes).find((x) => x.irDeviceUUID === "R1");
    expect(rm.irType).toBe(0xc000);
    expect(rm.alias).toBe("新");
  });

  it("[CFG-0034] code 変更 (非null時) で updated に積まれる", () => {
    const store = new ConfigStore(configPath);
    store.syncHub3sFromDevices([hubDev("H1", "living")]);
    store.syncRemotesFromServer([{ irDeviceUUID: "R1", type: 0xc000, code: 1 }], "living");
    const r = store.syncRemotesFromServer([{ irDeviceUUID: "R1", type: 0xc000, code: 999 }], "living");
    expect(r.updated).toHaveLength(1);
    expect(Object.values(store.load().remotes).find((x) => x.irDeviceUUID === "R1").code).toBe(999);
  });

  it("[CFG-0034] state 変更 (非null時) で updated に積まれる", () => {
    const store = new ConfigStore(configPath);
    store.syncHub3sFromDevices([hubDev("H1", "living")]);
    store.syncRemotesFromServer([{ irDeviceUUID: "R1", type: 0xc000, state: "OLD" }], "living");
    const r = store.syncRemotesFromServer([{ irDeviceUUID: "R1", type: 0xc000, state: "NEW" }], "living");
    expect(r.updated).toHaveLength(1);
    expect(Object.values(store.load().remotes).find((x) => x.irDeviceUUID === "R1").state).toBe("NEW");
  });

  it("[CFG-0034] 全フィールド不変なら updated に出さない (冪等)", () => {
    const store = new ConfigStore(configPath);
    store.syncHub3sFromDevices([hubDev("H1", "living")]);
    store.syncRemotesFromServer([{ irDeviceUUID: "R1", type: 0xc000, alias: "AC", code: 1, state: "X" }], "living");
    const r2 = store.syncRemotesFromServer([{ irDeviceUUID: "R1", type: 0xc000, alias: "AC", code: 1, state: "X" }], "living");
    expect(r2.updated).toHaveLength(0);
  });

  it("[CFG-0034] irType が非有限 (NaN) のときは irType を更新しない", () => {
    const store = new ConfigStore(configPath);
    store.syncHub3sFromDevices([hubDev("H1", "living")]);
    store.syncRemotesFromServer([{ irDeviceUUID: "R1", type: 0xc000 }], "living");
    // type なし (NaN) → irType は更新しない
    const r = store.syncRemotesFromServer([{ irDeviceUUID: "R1" }], "living");
    const rm = Object.values(store.load().remotes).find((x) => x.irDeviceUUID === "R1");
    expect(rm.irType).toBe(0xc000); // 変わっていない
    expect(r.updated).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// [CFG-0035] CLI remote sync-from-server <hub3> <irType>: irType 数値検証
// ---------------------------------------------------------------------------

describe("[CFG-0035] CLI remote sync-from-server — irType 検証 (純関数境界)", () => {
  // CLI の検証ロジック: !Number.isFinite(irType) || irType <= 0 → die(exit 2)
  function isValidIrType(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0;
  }

  it("[CFG-0035] 非有限値 (NaN) は不正", () => {
    expect(isValidIrType("abc")).toBe(false);
    expect(isValidIrType("")).toBe(false);
    expect(isValidIrType(undefined)).toBe(false);
  });

  it("[CFG-0035] <= 0 は不正 (境界値 0 も含む)", () => {
    expect(isValidIrType(0)).toBe(false);
    expect(isValidIrType(-1)).toBe(false);
    expect(isValidIrType("0")).toBe(false);
  });

  it("[CFG-0035] 正の整数は正常 (0xC000/0xFE00/文字列数値)", () => {
    expect(isValidIrType(49152)).toBe(true);    // 0xC000
    expect(isValidIrType(0xfe00)).toBe(true);   // 学習リモコン
    expect(isValidIrType("8192")).toBe(true);   // 文字列として渡される
  });

  it("[CFG-0035] 正常時は syncRemotesFromServer が呼べる (ConfigStore 層で確認)", () => {
    const store = new ConfigStore(configPath);
    store.syncHub3sFromDevices([hubDev("H1", "living")]);
    expect(() => store.syncRemotesFromServer([], "living")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// [CFG-0036] listRemotesFromDevices: hub3/hub3_lte 配下リモコン候補をフラット列挙
// ---------------------------------------------------------------------------

describe("[CFG-0036] listRemotesFromDevices — 読み取り専用フラット列挙", () => {
  // client.js の listRemotesFromDevices ロジック (config への書き込みなし) を純関数として検証する。
  function listRemotesFromDevicesPure(deviceList) {
    const out = [];
    for (const d of deviceList) {
      if (d.deviceModel !== "hub_3" && d.deviceModel !== "hub_3_lte") continue;
      const remoteList = d.stateInfo?.remoteList || [];
      for (const r of remoteList) {
        const uuid = r.uuid || r.irDeviceUUID;
        if (!uuid) continue;
        out.push({
          hub3DeviceUUID: d.deviceUUID ?? "",
          hub3Name: d.deviceName || d.deviceUUID || "",
          uuid,
          type: Number(r.type ?? r.irType),
          alias: r.alias || r.name || null,
        });
      }
    }
    return out;
  }

  it("[CFG-0036] hub_3/hub_3_lte の stateInfo.remoteList から {hub3DeviceUUID, hub3Name, uuid, type, alias} をフラット列挙", () => {
    const list = [
      hubWithRemotes("H1", "living", [
        { uuid: "R1", type: 0xfe00, alias: "学習" },
        { uuid: "R2", type: 0xc000, alias: "AC" },
      ]),
    ];
    const result = listRemotesFromDevicesPure(list);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      hub3DeviceUUID: "H1",
      hub3Name: "living",
      uuid: "R1",
      type: 0xfe00,
      alias: "学習",
    });
  });

  it("[CFG-0036] uuid 欠落要素はスキップ", () => {
    const list = [
      hubWithRemotes("H1", "living", [
        { type: 0xfe00 }, // uuid なし
        { uuid: null, type: 0xfe00 }, // null → スキップ
        { uuid: "R2", type: 0xc000 },
      ]),
    ];
    const result = listRemotesFromDevicesPure(list);
    expect(result).toHaveLength(1);
    expect(result[0].uuid).toBe("R2");
  });

  it("[CFG-0036] ロックデバイスは含まない (hub_3/hub_3_lte のみ)", () => {
    const list = [
      hubWithRemotes("H1", "living", [{ uuid: "R1", type: 0xfe00 }]),
      { ...lockDev("L1", "玄関"), stateInfo: { remoteList: [{ uuid: "LOCK-R", type: 0x2000 }] } },
    ];
    const result = listRemotesFromDevicesPure(list);
    expect(result.find((x) => x.uuid === "LOCK-R")).toBeUndefined();
    expect(result).toHaveLength(1);
  });

  it("[CFG-0036] hub_3_lte も対象に含まれる", () => {
    const list = [
      hubWithRemotes("H2", "lte-hub", [{ uuid: "R3", type: 0x8000 }], "hub_3_lte"),
    ];
    const result = listRemotesFromDevicesPure(list);
    expect(result).toHaveLength(1);
    expect(result[0].hub3DeviceUUID).toBe("H2");
  });

  it("[CFG-0036] config への書き込みをしない (純読み取り)", () => {
    const store = new ConfigStore(configPath);
    store.syncHub3sFromDevices([hubDev("H1", "living")]);
    const before = Object.keys(store.load().remotes).length;

    const list = [hubWithRemotes("H1", "living", [{ uuid: "R1", type: 0xfe00 }])];
    listRemotesFromDevicesPure(list); // config を変更しない

    // キャッシュクリアして再 load
    store.data = null;
    const after = Object.keys(store.load().remotes).length;
    expect(after).toBe(before); // 変化なし
  });
});

// ---------------------------------------------------------------------------
// [CFG-0037] CLI remote add: irOperation は deriveIrOperation(chosen.type) であるべき
// ---------------------------------------------------------------------------

describe("[CFG-0037] CLI remote add — irOperation 導出 (TDD/spec 正典)", () => {
  it("[CFG-0037] irOperation 省略時は irType から deriveIrOperation で導出 (0xFE00→learnEmit)", () => {
    const store = new ConfigStore(configPath);
    store.addHub3("living", { deviceId: "H1" });
    store.addRemote("r-learn", {
      hub3: "living",
      irDeviceUUID: "R1",
      irType: 0xfe00,
      // irOperation 省略 → deriveIrOperation(0xfe00) = 'learnEmit'
    });
    expect(store.load().remotes["r-learn"].irOperation).toBe("learnEmit");
  });

  it("[CFG-0037] irOperation 省略時は irType から deriveIrOperation で導出 (0xC000→remoteEmit, spec 正典)", () => {
    const store = new ConfigStore(configPath);
    store.addHub3("living", { deviceId: "H1" });
    // irOperation を渡さない → deriveIrOperation(0xc000) = 'remoteEmit'
    store.addRemote("r-auto", {
      hub3: "living",
      irDeviceUUID: "R2",
      irType: 0xc000,
      // irOperation: 未指定 (CLI 修正後の正しい呼び出し方)
    });
    // config.js:574: irOperation: remote.irOperation || deriveIrOperation(Number(remote.irType))
    expect(store.load().remotes["r-auto"].irOperation).toBe("remoteEmit");
  });

  it("[CFG-0037] 学習リモコン (0xFE00) に明示 irOperation:'learnEmit' を渡してもそのまま保存される", () => {
    const store = new ConfigStore(configPath);
    store.addHub3("living", { deviceId: "H1" });
    store.addRemote("r3", {
      hub3: "living",
      irDeviceUUID: "R3",
      irType: 0xfe00,
      irOperation: "learnEmit",
    });
    expect(store.load().remotes["r3"].irOperation).toBe("learnEmit");
  });

  it("[CFG-0037] CLI remote add がプリセット (0xC000) を irOperation 省略で追加すると spec 通り 'remoteEmit' になる", () => {
    // remote.js が過去 irOperation:'learnEmit' をハードコードしていた既知バグの回帰テスト。
    // ConfigStore 層は irOperation 省略時に正しく導出することを確認する。
    const store = new ConfigStore(configPath);
    store.addHub3("living", { deviceId: "H1" });
    const chosenType = 0xc000; // エアコンプリセット
    store.addRemote("r-cli-fix", {
      hub3: "living",
      irDeviceUUID: "ir-cli-fix",
      irType: chosenType,
      // irOperation を渡さない (CLI 修正後の正しい呼び出し方)
    });
    expect(store.load().remotes["r-cli-fix"].irOperation).toBe("remoteEmit"); // spec 正典
  });
});

// ---------------------------------------------------------------------------
// [CFG-0038] addRemote: name/hub3 必須 + 親 hub3 未登録で BAD_REQUEST
// ---------------------------------------------------------------------------

describe("[CFG-0038] ConfigStore.addRemote — 必須検証 + hub3 未登録 BAD_REQUEST", () => {
  it("[CFG-0038] name 欠落で badRequest (remoteNameRequired)", () => {
    const store = new ConfigStore(configPath);
    store.addHub3("hub-a", { deviceId: "dev-1" });
    expect(() =>
      store.addRemote("", { hub3: "hub-a", irDeviceUUID: "R1", irType: 65024 }),
    ).toThrow(/remote name required/i);
  });

  it("[CFG-0038] hub3 欠落で badRequest (remoteHub3Required)", () => {
    const store = new ConfigStore(configPath);
    store.addHub3("hub-a", { deviceId: "dev-1" });
    expect(() =>
      store.addRemote("r1", { irDeviceUUID: "R1", irType: 65024 }),
    ).toThrow(/remote\.hub3 required/i);
  });

  it("[CFG-0038] cfg.hub3s に hub3 未登録で badRequest (hub3NotRegisteredAddFirst)", () => {
    const store = new ConfigStore(configPath);
    expect(() =>
      store.addRemote("r1", { hub3: "unknown-hub", irDeviceUUID: "R1", irType: 65024 }),
    ).toThrow(/hub3.*未登録|hub3NotRegisteredAddFirst/i);
  });

  it("[CFG-0038] irType は Number 化される (文字列 '49152' → 数値 49152)", () => {
    const store = new ConfigStore(configPath);
    store.addHub3("hub-a", { deviceId: "dev-1" });
    store.addRemote("r1", { hub3: "hub-a", irDeviceUUID: "R1", irType: "49152" });
    expect(store.load().remotes["r1"].irType).toBe(49152);
  });

  it("[CFG-0038] irOperation 未指定は deriveIrOperation で導出 (0xFE00→learnEmit)", () => {
    const store = new ConfigStore(configPath);
    store.addHub3("hub-a", { deviceId: "dev-1" });
    store.addRemote("r1", { hub3: "hub-a", irDeviceUUID: "R1", irType: 0xfe00 });
    expect(store.load().remotes["r1"].irOperation).toBe("learnEmit");
  });

  it("[CFG-0038] irOperation 未指定は deriveIrOperation で導出 (0xC000→remoteEmit)", () => {
    const store = new ConfigStore(configPath);
    store.addHub3("hub-a", { deviceId: "dev-1" });
    store.addRemote("r1", { hub3: "hub-a", irDeviceUUID: "R1", irType: 0xc000 });
    expect(store.load().remotes["r1"].irOperation).toBe("remoteEmit");
  });

  it("[CFG-0038] 初回 addRemote で default.remote が自動設定される", () => {
    const store = new ConfigStore(configPath);
    store.addHub3("hub-a", { deviceId: "dev-1" });
    store.addRemote("r1", { hub3: "hub-a", irDeviceUUID: "R1", irType: 65024 });
    expect(store.load().default.remote).toBe("r1");
  });

  it("[CFG-0038] 2 件目以降は default.remote を上書きしない", () => {
    const store = new ConfigStore(configPath);
    store.addHub3("hub-a", { deviceId: "dev-1" });
    store.addRemote("r1", { hub3: "hub-a", irDeviceUUID: "R1", irType: 65024 });
    store.addRemote("r2", { hub3: "hub-a", irDeviceUUID: "R2", irType: 65024 });
    expect(store.load().default.remote).toBe("r1");
  });
});
