// ConfigStore の devices→config 同期メソッドの単体テスト。
// syncLocksFromDevices / syncHub3sFromDevices / syncRemotesFromServer。
// 実 IO (tmpdir) で原子性 (1 save) と冪等性・prune・更新を検証する。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, isLockModel, isHub3Model } from "../../src/config.js";

let workDir;
let configPath;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "sesame-sync-"));
  configPath = join(workDir, "config.json");
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function lockDev(uuid, name, model = "sesame_5_pro", secretKey = "00112233445566778899aabbccddeeff") {
  return { deviceUUID: uuid, deviceName: name, deviceModel: model, secretKey };
}
function hubDev(uuid, name) {
  return { deviceUUID: uuid, deviceName: name, deviceModel: "hub_3" };
}

describe("isLockModel / isHub3Model", () => {
  it("biz3 lockModelDevices ホワイトリストと一致 (gUtils.js:279-294)", () => {
    // ロックとして扱う 14 機種
    expect(isLockModel("sesame_5")).toBe(true);
    expect(isLockModel("sesame_6_pro")).toBe(true);
    expect(isLockModel("bot_2")).toBe(true);
    expect(isLockModel("bot_3")).toBe(true);
    expect(isLockModel("ssmbot_1")).toBe(true);
    expect(isLockModel("bike_2")).toBe(true);
    expect(isLockModel("bike_3")).toBe(true);
    expect(isLockModel("BLE_Connector_1")).toBe(true); // 旧 prefix では取りこぼしていた
    // ロックでないもの (旧 prefix マッチが誤判定していた典型)
    expect(isLockModel("wm_2")).toBe(false);            // WiFi モジュール
    expect(isLockModel("bike_1")).toBe(false);          // リストに無い
    expect(isLockModel("sesame_face")).toBe(false);     // 認証機 (isSesameAccessControlDevice)
    expect(isLockModel("sesame_face_2_pro")).toBe(false);
    expect(isLockModel("ssm_touch")).toBe(false);       // 認証機
    expect(isLockModel("sesame_miwa")).toBe(false);
    expect(isLockModel("hub_3")).toBe(false);
    expect(isLockModel("remote")).toBe(false);
    expect(isLockModel(undefined)).toBe(false);
  });
  it("Hub3 系 model を正しく判定", () => {
    expect(isHub3Model("hub_3")).toBe(true);
    expect(isHub3Model("hub_3_lte")).toBe(true);
    expect(isHub3Model("sesame_5")).toBe(false);
  });
});

describe("syncLocksFromDevices", () => {
  it("ロック系のみ取り込み、Hub3/その他は無視", () => {
    const store = new ConfigStore(configPath);
    const r = store.syncLocksFromDevices([
      lockDev("AAAA1111-0000-0000-0000-000000000001", "玄関"),
      hubDev("BBBB2222-0000-0000-0000-000000000002", "リビングHub"),
      { deviceUUID: "CCCC", deviceName: "リモコン", deviceModel: "remote" },
    ]);
    expect(r.added).toHaveLength(1);
    const cfg = store.load();
    expect(Object.keys(cfg.locks)).toHaveLength(1);
    expect(cfg.locks["玄関"].deviceUUID).toBe("AAAA1111-0000-0000-0000-000000000001");
  });

  it("secretKey / deviceUUID が欠けた device はスキップ", () => {
    const store = new ConfigStore(configPath);
    const r = store.syncLocksFromDevices([
      { deviceUUID: "X", deviceModel: "sesame_5" }, // secretKey 無し
      { deviceModel: "sesame_5", secretKey: "k" },  // UUID 無し
    ]);
    expect(r.added).toHaveLength(0);
  });

  it("初回取り込みで default.lock が設定される", () => {
    const store = new ConfigStore(configPath);
    store.syncLocksFromDevices([lockDev("U1", "front")]);
    expect(store.load().default.lock).toBe("front");
  });

  it("冪等: 同じ deviceUUID を再 sync しても重複しない", () => {
    const store = new ConfigStore(configPath);
    store.syncLocksFromDevices([lockDev("U1", "front")]);
    const r2 = store.syncLocksFromDevices([lockDev("U1", "front")]);
    expect(r2.added).toHaveLength(0);
    expect(r2.updated).toHaveLength(0);
    expect(Object.keys(store.load().locks)).toHaveLength(1);
  });

  it("secretKey が変わると updated として反映", () => {
    const store = new ConfigStore(configPath);
    store.syncLocksFromDevices([lockDev("U1", "front", "sesame_5", "old0000000000000000000000000000")]);
    const r = store.syncLocksFromDevices([lockDev("U1", "front", "sesame_5", "new0000000000000000000000000000")]);
    expect(r.updated).toContain("front");
    expect(store.load().locks["front"].secretKey).toBe("new0000000000000000000000000000");
  });

  it("ハイフン有無が違っても同一デバイスと認識して重複しない", () => {
    const store = new ConfigStore(configPath);
    store.syncLocksFromDevices([lockDev("AABBCCDD-1111-2222-3333-444455556666", "front")]);
    const r = store.syncLocksFromDevices([lockDev("aabbccdd1111222233334444555566 66".replace(" ", ""), "front")]);
    // 正規化で一致 → 追加されない
    expect(r.added).toHaveLength(0);
  });

  it("名前衝突時はユニーク化 (name, name-2)", () => {
    const store = new ConfigStore(configPath);
    store.syncLocksFromDevices([
      lockDev("U1", "ドア"),
      lockDev("U2", "ドア"),
    ]);
    const names = Object.keys(store.load().locks);
    expect(names).toContain("ドア");
    expect(names).toContain("ドア-2");
  });

  it("prune: server に無いロックを除去", () => {
    const store = new ConfigStore(configPath);
    store.syncLocksFromDevices([lockDev("U1", "front"), lockDev("U2", "back")]);
    const r = store.syncLocksFromDevices([lockDev("U1", "front")], { prune: true });
    expect(r.removed).toContain("back");
    expect(Object.keys(store.load().locks)).toEqual(["front"]);
  });

  it("prune で default.lock が消えたら null に戻す", () => {
    const store = new ConfigStore(configPath);
    store.syncLocksFromDevices([lockDev("U1", "front")]);
    expect(store.load().default.lock).toBe("front");
    store.syncLocksFromDevices([lockDev("U2", "back")], { prune: true });
    const cfg = store.load();
    expect(cfg.default.lock).toBeNull();
    expect(Object.keys(cfg.locks)).toEqual(["back"]);
  });

  it("結果がファイルに永続化される (再読込で残る)", () => {
    const store = new ConfigStore(configPath);
    store.syncLocksFromDevices([lockDev("U1", "front")]);
    // 永続化されるのは正準ソースの devices{} のみ (locks は派生 view なので書かない)。
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    expect(raw.devices["front"].deviceUUID).toBe("U1");
    expect(raw.locks).toBeUndefined();
    // 再読込で locks view に復元されることまで確認 (round-trip)。
    const reloaded = new ConfigStore(configPath).load();
    expect(reloaded.locks["front"].deviceUUID).toBe("U1");
  });

  it("prune は category で対象を選ぶので、手動追加 (model 未指定) のロックも対称に除去される", () => {
    const store = new ConfigStore(configPath);
    // addLock は model 未指定 (null)。accept(isLockModel(null)=false) では prune を逃れてしまうが、
    // category="lock" による prune なら server に無い手動ロックも正しく除去される。
    store.addLock("manual", { deviceUUID: "M1", secretKey: "ff112233445566778899aabbccddeeff" });
    store.syncLocksFromDevices([lockDev("U1", "front")]); // server には別ロックだけ
    const r = store.syncLocksFromDevices([lockDev("U1", "front")], { prune: true });
    expect(r.removed).toContain("manual");
    expect(Object.keys(store.load().locks)).toEqual(["front"]);
  });

  it("lock の sync は hub3 を prune しない (view 跨ぎで消さない)", () => {
    const store = new ConfigStore(configPath);
    store.syncHub3sFromDevices([hubDev("H1", "living")]);
    store.syncLocksFromDevices([lockDev("U1", "front")], { prune: true });
    // hub3 は lock の prune 対象外なので残る。
    expect(Object.keys(store.load().hub3s)).toEqual(["living"]);
  });

  it("更新でサーバ側から消えたフィールドは追従して消し、ローカル注釈 (category) は維持する", () => {
    const store = new ConfigStore(configPath);
    // 手動追加 (category="lock" が付く) → 同 deviceUUID を battery 付きで sync。
    store.addLock("front", { deviceUUID: "U1", secretKey: "00112233445566778899aabbccddeeff", model: "sesame_5_pro" });
    store.syncLocksFromDevices([{ ...lockDev("U1", "front"), battery: 80 }]);
    expect(store.load().devices["front"].battery).toBe(80);
    expect(store.load().devices["front"].category).toBe("lock");
    // 次の sync で battery が消えた応答 → 追従して消える。ローカル注釈 category は残る。
    store.syncLocksFromDevices([lockDev("U1", "front")]);
    const rec = store.load().devices["front"];
    expect(rec.battery).toBeUndefined();
    expect(rec.category).toBe("lock");
    // view も維持 (操作対象として残る)。
    expect(store.load().locks["front"].deviceUUID).toBe("U1");
  });
});

describe("syncHub3sFromDevices", () => {
  it("hub_3 / hub_3_lte のみ取り込む", () => {
    const store = new ConfigStore(configPath);
    const r = store.syncHub3sFromDevices([
      hubDev("H1", "living"),
      { deviceUUID: "H2", deviceName: "lte", deviceModel: "hub_3_lte" },
      lockDev("L1", "front"),
    ]);
    expect(r.added).toHaveLength(2);
    expect(Object.keys(store.load().hub3s)).toHaveLength(2);
  });

  it("prune で参照中の hub3 は残す (整合性保護)", () => {
    const store = new ConfigStore(configPath);
    store.syncHub3sFromDevices([hubDev("H1", "living")]);
    // living を参照する remote を作る
    store.addRemote("ac", { hub3: "living", irDeviceUUID: "R1", irType: 65024, keys: {} });
    // H1 が server から消えても、ac が参照しているので残る
    const r = store.syncHub3sFromDevices([], { prune: true });
    expect(r.removed).not.toContain("living");
    expect(store.load().hub3s["living"]).toBeDefined();
  });
});

describe("syncRemotesFromDevices (device-driven, irType 引数不要)", () => {
  // Hub3 デバイスが stateInfo.remoteList に配下リモコンを {uuid, type, alias} で持つ
  function hubWithRemotes(uuid, name, remotes) {
    return { deviceUUID: uuid, deviceName: name, deviceModel: "hub_3", stateInfo: { remoteList: remotes } };
  }

  it("Hub3 の stateInfo.remoteList から irType 込みで取り込む", () => {
    const store = new ConfigStore(configPath);
    const devices = [
      hubWithRemotes("H1", "living", [
        { uuid: "R1", type: 65024, alias: "エアコン" },
        { uuid: "R2", type: 65280, alias: "TV" },
      ]),
    ];
    store.syncHub3sFromDevices(devices);
    const r = store.syncRemotesFromDevices(devices);
    expect(r.added).toHaveLength(2);
    const cfg = store.load();
    const ac = Object.values(cfg.remotes).find((x) => x.irDeviceUUID === "R1");
    expect(ac.irType).toBe(65024);
    expect(ac.alias).toBe("エアコン");
    expect(ac.hub3).toBe("living");
    const tv = Object.values(cfg.remotes).find((x) => x.irDeviceUUID === "R2");
    expect(tv.irType).toBe(65280);
  });

  it("hub3 未登録の Hub3 のリモコンはスキップ (先に hub3 sync が必要)", () => {
    const store = new ConfigStore(configPath);
    const devices = [hubWithRemotes("H1", "living", [{ uuid: "R1", type: 65024 }])];
    // syncHub3s を呼ばずにいきなり remote sync → hub3 未登録なのでスキップ
    const r = store.syncRemotesFromDevices(devices);
    expect(r.added).toHaveLength(0);
  });

  it("冪等: 再 sync で重複しない", () => {
    const store = new ConfigStore(configPath);
    const devices = [hubWithRemotes("H1", "living", [{ uuid: "R1", type: 65024, alias: "AC" }])];
    store.syncHub3sFromDevices(devices);
    store.syncRemotesFromDevices(devices);
    const r2 = store.syncRemotesFromDevices(devices);
    expect(r2.added).toHaveLength(0);
    expect(Object.keys(store.load().remotes)).toHaveLength(1);
  });

  it("irType / alias の変更を updated として反映", () => {
    const store = new ConfigStore(configPath);
    store.syncHub3sFromDevices([hubWithRemotes("H1", "living", [])]);
    store.syncRemotesFromDevices([hubWithRemotes("H1", "living", [{ uuid: "R1", type: 65024, alias: "旧" }])]);
    const r = store.syncRemotesFromDevices([hubWithRemotes("H1", "living", [{ uuid: "R1", type: 65280, alias: "新" }])]);
    expect(r.updated).toHaveLength(1);
    const rm = Object.values(store.load().remotes).find((x) => x.irDeviceUUID === "R1");
    expect(rm.irType).toBe(65280);
    expect(rm.alias).toBe("新");
  });

  it("remoteList が無い Hub3 は何もしない", () => {
    const store = new ConfigStore(configPath);
    store.syncHub3sFromDevices([{ deviceUUID: "H1", deviceName: "living", deviceModel: "hub_3" }]);
    const r = store.syncRemotesFromDevices([{ deviceUUID: "H1", deviceName: "living", deviceModel: "hub_3" }]);
    expect(r.added).toHaveLength(0);
  });

  it("初回取り込みで default.remote が設定される", () => {
    const store = new ConfigStore(configPath);
    store.syncHub3sFromDevices([hubWithRemotes("H1", "living", [])]);
    store.syncRemotesFromDevices([hubWithRemotes("H1", "living", [{ uuid: "R1", type: 65024, alias: "AC" }])]);
    expect(store.load().default.remote).toBeTruthy();
  });
});

describe("syncRemotesFromServer", () => {
  it("hub3 未登録ならエラー", () => {
    const store = new ConfigStore(configPath);
    expect(() => store.syncRemotesFromServer([], "nope")).toThrow(/hub3 "nope" 未登録/);
  });

  it("server リモコン一覧から remote 定義を生成 (irDeviceUUID/type/alias)", () => {
    const store = new ConfigStore(configPath);
    store.syncHub3sFromDevices([hubDev("H1", "living")]);
    const r = store.syncRemotesFromServer(
      [{ irDeviceUUID: "R1", type: 65024, alias: "エアコン" }],
      "living",
    );
    expect(r.added).toHaveLength(1);
    const remote = store.load().remotes[r.added[0]];
    expect(remote.hub3).toBe("living");
    expect(remote.irDeviceUUID).toBe("R1");
    expect(remote.irType).toBe(65024);
    expect(remote.alias).toBe("エアコン");
  });

  it("uuid フィールド名でも irDeviceUUID として取り込む", () => {
    const store = new ConfigStore(configPath);
    store.syncHub3sFromDevices([hubDev("H1", "living")]);
    const r = store.syncRemotesFromServer([{ uuid: "R9", type: 65280, name: "TV" }], "living");
    const remote = store.load().remotes[r.added[0]];
    expect(remote.irDeviceUUID).toBe("R9");
    expect(remote.irType).toBe(65280);
  });

  it("既存 remote の irType/alias 更新を反映", () => {
    const store = new ConfigStore(configPath);
    store.syncHub3sFromDevices([hubDev("H1", "living")]);
    store.syncRemotesFromServer([{ irDeviceUUID: "R1", type: 65024, alias: "旧" }], "living");
    const r = store.syncRemotesFromServer([{ irDeviceUUID: "R1", type: 65280, alias: "新" }], "living");
    expect(r.updated).toHaveLength(1);
    const remote = Object.values(store.load().remotes).find((x) => x.irDeviceUUID === "R1");
    expect(remote.irType).toBe(65280);
    expect(remote.alias).toBe("新");
  });
});
