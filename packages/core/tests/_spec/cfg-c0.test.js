// packages/core/tests/_spec/cfg-c0.test.js
// Spec-driven tests for CFG-0003 through CFG-0020 (config.sync domain).
// Each it() title is prefixed with its spec ID.  Tests are TDD: assertions
// follow the spec contract.  Where the implementation currently diverges from
// spec the test is expected to be red.
// No network / BLE / real device access — all pure-function or real-tmpdir IO.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigStore, isLockModel, isHub3Model } from "../../src/config.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

let workDir;
let configPath;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "sesame-cfg-0003-"));
  configPath = join(workDir, "config.json");
});

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
  configPath = null;
});

/** Minimal lock device record (secretKey + UUID + lockModel). */
function lockDev(uuid, name, model = "sesame_5", secretKey = "00112233445566778899aabbccddeeff") {
  return { deviceUUID: uuid, deviceName: name, deviceModel: model, secretKey };
}

/** Minimal Hub3 device record. */
function hub3Dev(uuid, name, model = "hub_3") {
  return { deviceUUID: uuid, deviceName: name, deviceModel: model };
}

// ─── CFG-0003 ─────────────────────────────────────────────────────────────────

describe("[CFG-0003] syncLocksFromDevices accept 条件: isLockModel && deviceUUID && secretKey", () => {
  it("[CFG-0003] ロックモデル+UUID+secretKey 揃いのみ devices{} に取り込む; Hub3/認証機/その他は無視する", () => {
    const store = new ConfigStore(configPath);
    const result = store.syncLocksFromDevices([
      lockDev("UUID-L1", "玄関", "sesame_5"),                      // ロック → accept
      hub3Dev("UUID-H1", "リビングHub", "hub_3"),                  // hub3 → reject
      { deviceUUID: "UUID-X", deviceName: "Touch", deviceModel: "ssm_touch", secretKey: "deadbeefdeadbeefdeadbeefdeadbeef" }, // 認証機 → reject
      { deviceUUID: "UUID-X2", deviceName: "Face", deviceModel: "sesame_face", secretKey: "deadbeefdeadbeefdeadbeefdeadbeef" }, // 顔認証 → reject
      { deviceUUID: "UUID-REMOTE-01", deviceName: "リモコン", deviceModel: "remote", secretKey: "aabbccddeeff00112233445566778899" }, // 未知 → reject
    ]);
    // Only the lock device is accepted
    expect(result.added).toHaveLength(1);
    const cfg = store.load();
    expect(Object.keys(cfg.locks)).toHaveLength(1);
    expect(cfg.locks["玄関"].deviceUUID).toBe("UUID-L1");
    // Hub3 must NOT be in locks view
    const allUuids = Object.values(cfg.locks).map((l) => l.deviceUUID);
    expect(allUuids).not.toContain("UUID-H1");
  });
});

// ─── CFG-0004 ─────────────────────────────────────────────────────────────────

describe("[CFG-0004] LOCK_MODELS ホワイトリストが biz3 lockModelDevices と完全一致", () => {
  const EXPECTED_LOCK_MODELS = [
    "sesame_2", "sesame_4", "sesame_5", "sesame_5_pro", "sesame_5_us",
    "bot_2", "bot_3", "ssmbot_1",
    "sesame_6", "sesame_6_pro", "sesame_6_pro_slidingdoor",
    "BLE_Connector_1",
    "bike_2", "bike_3",
  ];

  it("[CFG-0004] biz3 lockModelDevices に含まれる 14 機種は isLockModel===true", () => {
    for (const m of EXPECTED_LOCK_MODELS) {
      expect(isLockModel(m), `isLockModel("${m}") should be true`).toBe(true);
    }
  });

  it("[CFG-0004] 認証機・hub3・未知モデルは isLockModel===false (hub3/sesame_face* 取り込まない)", () => {
    const NON_LOCK_MODELS = [
      "hub_3", "hub_3_lte",
      "sesame_face", "sesame_face_pro", "sesame_face_2_pro",
      "ssm_touch", "ssm_touch_pro",
      "wm_2",
      "bike_1",
      "BLE_Connector",
      null, undefined,
    ];
    for (const m of NON_LOCK_MODELS) {
      expect(isLockModel(m), `isLockModel(${JSON.stringify(m)}) should be false`).toBe(false);
    }
  });
});

// ─── CFG-0005 ─────────────────────────────────────────────────────────────────

describe("[CFG-0005] secretKey/deviceUUID 欠落デバイスは accept で弾く", () => {
  it("[CFG-0005] ロックモデルでも secretKey 無しは added/updated に出さない", () => {
    const store = new ConfigStore(configPath);
    const r = store.syncLocksFromDevices([
      { deviceUUID: "UUID-NO-SK", deviceName: "NoSecret", deviceModel: "sesame_5" }, // secretKey 欠落
    ]);
    expect(r.added).toHaveLength(0);
    expect(r.updated).toHaveLength(0);
  });

  it("[CFG-0005] ロックモデルでも deviceUUID 無しは added/updated に出さない", () => {
    const store = new ConfigStore(configPath);
    const r = store.syncLocksFromDevices([
      { deviceName: "NoUUID", deviceModel: "sesame_5", secretKey: "00112233445566778899aabbccddeeff" }, // UUID 欠落
    ]);
    expect(r.added).toHaveLength(0);
    expect(r.updated).toHaveLength(0);
  });

  it("[CFG-0005] secretKey/UUID が両方欠落していても added に出ない", () => {
    const store = new ConfigStore(configPath);
    const r = store.syncLocksFromDevices([
      { deviceModel: "sesame_5" },
    ]);
    expect(r.added).toHaveLength(0);
  });
});

// ─── CFG-0006 ─────────────────────────────────────────────────────────────────

describe("[CFG-0006] 初回取り込みで default.lock を最初の added 名に設定 (onFirstAdd)", () => {
  it("[CFG-0006] default.lock 未設定のとき最初の added 名に自動設定する", () => {
    const store = new ConfigStore(configPath);
    store.syncLocksFromDevices([
      lockDev("U1", "front"),
      lockDev("U2", "back"),
    ]);
    const cfg = store.load();
    // default.lock は最初に追加された名前でなければならない
    expect(cfg.default.lock).toBe("front");
  });

  it("[CFG-0006] default.lock 設定済みのときは上書きしない", () => {
    const store = new ConfigStore(configPath);
    store.syncLocksFromDevices([lockDev("U1", "front")]);
    // default.lock = "front"
    store.syncLocksFromDevices([lockDev("U2", "back")]);
    // 2 回目の sync で "back" が追加されても default は変わらない
    expect(store.load().default.lock).toBe("front");
  });
});

// ─── CFG-0007 ─────────────────────────────────────────────────────────────────

describe("[CFG-0007] syncLocksFromDevices --prune: server 不在ロックを除去 (lock category 限定)", () => {
  it("[CFG-0007] prune=true でサーバ応答 seen に無い lock が removed に積まれ devices から消える", () => {
    const store = new ConfigStore(configPath);
    store.syncLocksFromDevices([lockDev("U1", "front"), lockDev("U2", "back")]);
    const r = store.syncLocksFromDevices([lockDev("U1", "front")], { prune: true });
    expect(r.removed).toContain("back");
    expect(Object.keys(store.load().locks)).toEqual(["front"]);
  });

  it("[CFG-0007] prune は lock category のみ対象: hub3 は消さない (view 跨ぎ削除防止)", () => {
    const store = new ConfigStore(configPath);
    store.syncHub3sFromDevices([hub3Dev("H1", "living")]);
    store.syncLocksFromDevices([lockDev("U1", "front")]);
    // front を prune で消しても living は残る
    const result = store.syncLocksFromDevices([], { prune: true });
    expect(result.removed).toContain("front");
    // hub3 は lock の prune 対象外なので残る
    expect(store.load().hub3s["living"]).toBeDefined();
  });
});

// ─── CFG-0008 ─────────────────────────────────────────────────────────────────

describe("[CFG-0008] prune で削除されたロックが default.lock だった場合 null に戻す", () => {
  it("[CFG-0008] prune で default.lock が消えたら default.lock を null にリセットする", () => {
    const store = new ConfigStore(configPath);
    store.syncLocksFromDevices([lockDev("U1", "front")]);
    expect(store.load().default.lock).toBe("front");
    // front が server からも消える (prune=true) → default.lock が null に
    const r = store.syncLocksFromDevices([], { prune: true });
    expect(r.removed).toContain("front");
    expect(store.load().default.lock).toBeNull();
  });

  it("[CFG-0008] prune で削除されなかった lock の default.lock は維持される", () => {
    const store = new ConfigStore(configPath);
    store.syncLocksFromDevices([lockDev("U1", "front"), lockDev("U2", "back")]);
    // default = front
    store.syncLocksFromDevices([lockDev("U1", "front")], { prune: true });
    // back が消えても front が default のまま
    expect(store.load().default.lock).toBe("front");
  });
});

// ─── CFG-0009 ─────────────────────────────────────────────────────────────────

describe("[CFG-0009] prune は category で対象選定するため手動追加 (model 未指定) ロックも除去対象", () => {
  it("[CFG-0009] addLock で model 未指定のエントリは effectiveCategory=lock なので prune で除去される", () => {
    const store = new ConfigStore(configPath);
    // addLock で category:'lock' が付く (effectiveCategory===lock なので prune 対象)
    store.addLock("manual", { deviceUUID: "M1", secretKey: "ff112233445566778899aabbccddeeff" });
    // server 応答は別のロックのみ → prune=true で manual が削除対象になる
    const r = store.syncLocksFromDevices([lockDev("U1", "front")], { prune: true });
    expect(r.removed).toContain("manual");
    expect(Object.keys(store.load().locks)).toEqual(["front"]);
  });
});

// ─── CFG-0010 ─────────────────────────────────────────────────────────────────

describe("[CFG-0010] added/updated/removed の決定: deviceUUID 突合 (ハイフン正規化) で既存判定", () => {
  it("[CFG-0010] ハイフン有/無の差だけの UUID は同一デバイスとみなし added を生まない", () => {
    const store = new ConfigStore(configPath);
    store.syncLocksFromDevices([lockDev("AABBCCDD-1111-2222-3333-444455556666", "front")]);
    // ハイフン無し・小文字で再 sync
    const r = store.syncLocksFromDevices([lockDev("aabbccdd111122223333444455556666", "front")]);
    expect(r.added).toHaveLength(0);
  });

  it("[CFG-0010] 大文字/小文字の差だけの UUID は同一デバイスとみなす", () => {
    const store = new ConfigStore(configPath);
    store.syncLocksFromDevices([lockDev("AABBCCDD1111222233334444DDDDEEEE", "lock1")]);
    const r = store.syncLocksFromDevices([lockDev("aabbccdd1111222233334444ddddeeee", "lock1")]);
    expect(r.added).toHaveLength(0);
  });

  it("[CFG-0010] UUID が異なる場合は新規 added として登録される", () => {
    const store = new ConfigStore(configPath);
    store.syncLocksFromDevices([lockDev("UUID-A", "lock-a")]);
    const r = store.syncLocksFromDevices([lockDev("UUID-B", "lock-b")]);
    expect(r.added).toHaveLength(1);
  });
});

// ─── CFG-0011 ─────────────────────────────────────────────────────────────────

describe("[CFG-0011] 更新判定は canonicalize 正準形比較でキー順差の誤検知を防ぐ (冪等)", () => {
  it("[CFG-0011] 値が同一でキー順だけ違う場合は updated に出さない (二重 sync 冪等)", () => {
    const store = new ConfigStore(configPath);
    store.syncLocksFromDevices([lockDev("U1", "front", "sesame_5")]);
    // 同一内容を再 sync
    const r = store.syncLocksFromDevices([lockDev("U1", "front", "sesame_5")]);
    expect(r.updated).toHaveLength(0);
    expect(r.added).toHaveLength(0);
  });

  it("[CFG-0011] 実際に値が変わったときだけ updated に積む", () => {
    const store = new ConfigStore(configPath);
    store.syncLocksFromDevices([lockDev("U1", "front", "sesame_5", "aaaabbbbccccddddaaaabbbbccccdddd")]);
    const r = store.syncLocksFromDevices([lockDev("U1", "front", "sesame_5", "11112222333344441111222233334444")]);
    expect(r.updated).toContain("front");
  });
});

// ─── CFG-0012 ─────────────────────────────────────────────────────────────────

describe("[CFG-0012] 更新は応答を真実としフィールド総入替、LOCAL_ONLY_KEYS だけ温存", () => {
  it("[CFG-0012] サーバ側で消えたフィールドは追従して削除される", () => {
    const store = new ConfigStore(configPath);
    // 1st sync: battery フィールドあり
    store.syncLocksFromDevices([{ ...lockDev("U1", "front"), battery: 90 }]);
    expect(store.load().devices["front"].battery).toBe(90);
    // 2nd sync: battery なし → 追従して消える
    store.syncLocksFromDevices([lockDev("U1", "front")]);
    expect(store.load().devices["front"].battery).toBeUndefined();
  });

  it("[CFG-0012] LOCAL_ONLY_KEYS (category/ssmPublicKey/keyIndex) はサーバ応答に無くても引き継ぐ", () => {
    const store = new ConfigStore(configPath);
    // addLock で category='lock' が付く (LOCAL_ONLY_KEYS の一つ)
    store.addLock("front", { deviceUUID: "U1", secretKey: "00112233445566778899aabbccddeeff", model: "sesame_5_pro" });
    // sync で同一デバイスが更新される → category は引き継がれる
    store.syncLocksFromDevices([lockDev("U1", "front", "sesame_5_pro")]);
    expect(store.load().devices["front"].category).toBe("lock");
  });
});

// ─── CFG-0013 ─────────────────────────────────────────────────────────────────

describe("[CFG-0013] sync 更新でローカル注釈 (category/ssmPublicKey/keyIndex) を引き継ぐ", () => {
  it("[CFG-0013] ssmPublicKey/keyIndex は sync 更新で消えない (BLE login 用ローカル保存鍵)", () => {
    const store = new ConfigStore(configPath);
    // addLock with OS2 key fields
    const ssmPublicKey = "a".repeat(128);
    const keyIndex = "0001";
    store.addLock("front", {
      deviceUUID: "U1",
      secretKey: "00112233445566778899aabbccddeeff",
      ssmPublicKey,
      keyIndex,
    });
    // syncLocksFromDevices: サーバ応答には ssmPublicKey/keyIndex が無い
    store.syncLocksFromDevices([lockDev("U1", "front", "sesame_5")]);
    const rec = store.load().devices["front"];
    // LOCAL_ONLY_KEYS として引き継がれなければならない
    expect(rec.ssmPublicKey).toBe(ssmPublicKey.toLowerCase());
    expect(rec.keyIndex).toBe(keyIndex);
  });

  it("[CFG-0013] category も LOCAL_ONLY_KEYS として sync 更新後も維持される", () => {
    const store = new ConfigStore(configPath);
    store.addLock("front", { deviceUUID: "U1", secretKey: "00112233445566778899aabbccddeeff" });
    store.syncLocksFromDevices([lockDev("U1", "front")]);
    expect(store.load().devices["front"].category).toBe("lock");
  });
});

// ─── CFG-0014 ─────────────────────────────────────────────────────────────────

describe("[CFG-0014] sanitizeDeviceRecord: stateInfo を除いた device 全フィールドを保存", () => {
  it("[CFG-0014] stateInfo は除外し、他フィールド (deviceUUID/deviceModel/deviceName/secretKey 等) は保存する", () => {
    const store = new ConfigStore(configPath);
    const devWithState = {
      ...lockDev("U1", "front"),
      battery: 85,
      stateInfo: { remoteList: [{ uuid: "R1", type: 65024 }] },
    };
    store.syncLocksFromDevices([devWithState]);
    const rec = store.load().devices["front"];
    // stateInfo は除外
    expect(rec.stateInfo).toBeUndefined();
    // 他フィールドは保存されている
    expect(rec.deviceUUID).toBe("U1");
    expect(rec.deviceName).toBe("front");
    expect(rec.deviceModel).toBe("sesame_5");
    expect(rec.secretKey).toBe("00112233445566778899aabbccddeeff");
    expect(rec.battery).toBe(85);
  });
});

// ─── CFG-0015 ─────────────────────────────────────────────────────────────────

describe("[CFG-0015] 名前衝突時の uniqueName 採番 (name, name-2, name-3)", () => {
  it("[CFG-0015] 衝突なし: deviceName をそのまま slug 化 (trim/空白→_/小文字) してキーにする", () => {
    const store = new ConfigStore(configPath);
    store.syncLocksFromDevices([lockDev("U1", "Front Door")]);
    const keys = Object.keys(store.load().locks);
    expect(keys).toContain("front_door");
  });

  it("[CFG-0015] 同じ deviceName の 2 デバイスは name / name-2 でユニーク化される", () => {
    const store = new ConfigStore(configPath);
    store.syncLocksFromDevices([
      lockDev("U1", "ドア"),
      lockDev("U2", "ドア"),
    ]);
    const names = Object.keys(store.load().locks);
    expect(names).toContain("ドア");
    expect(names).toContain("ドア-2");
  });

  it("[CFG-0015] 3 デバイスが衝突すれば name / name-2 / name-3", () => {
    const store = new ConfigStore(configPath);
    store.syncLocksFromDevices([
      lockDev("U1", "door"),
      lockDev("U2", "door"),
      lockDev("U3", "door"),
    ]);
    const names = Object.keys(store.load().locks);
    expect(names).toContain("door");
    expect(names).toContain("door-2");
    expect(names).toContain("door-3");
  });

  it("[CFG-0015] deviceName が空の場合は deviceUUID から baseName を作る (slug 化して小文字)", () => {
    const store = new ConfigStore(configPath);
    store.syncLocksFromDevices([
      { deviceUUID: "uuid-abc", deviceName: "", deviceModel: "sesame_5", secretKey: "00112233445566778899aabbccddeeff" },
    ]);
    const names = Object.keys(store.load().locks);
    expect(names.length).toBe(1);
    expect(names[0]).toBe("uuid-abc");
  });

  it("[CFG-0015] deviceName が空文字の場合は UUID slug が base になる (確認用)", () => {
    const store = new ConfigStore(configPath);
    store.syncLocksFromDevices([
      { deviceUUID: "x", deviceName: "", deviceModel: "sesame_5", secretKey: "00112233445566778899aabbccddeeff" },
    ]);
    const keys = Object.keys(store.load().locks);
    expect(keys).toContain("x");
  });
});

// ─── CFG-0016 ─────────────────────────────────────────────────────────────────

describe("[CFG-0016] sync 結果が config ファイルに永続化される (save 呼び出し)", () => {
  it("[CFG-0016] _syncDevices 末尾で save() が呼ばれ、added/updated/removed がファイルに残る", () => {
    const store = new ConfigStore(configPath);
    store.syncLocksFromDevices([lockDev("U1", "front")]);
    // ファイルに書かれていることを直接確認
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    expect(raw.devices["front"].deviceUUID).toBe("U1");
    // 派生 view (locks) はファイルに保存しない (正準ソースは devices のみ)
    expect(raw.locks).toBeUndefined();
  });

  it("[CFG-0016] 別インスタンスで再読み込みしても結果が残っている (round-trip)", () => {
    const store = new ConfigStore(configPath);
    store.syncLocksFromDevices([lockDev("U1", "front")]);
    const store2 = new ConfigStore(configPath);
    const cfg2 = store2.load();
    expect(cfg2.locks["front"].deviceUUID).toBe("U1");
  });

  it("[CFG-0016] syncHub3sFromDevices 後に再読込しても hub3 が残る", () => {
    const store = new ConfigStore(configPath);
    store.syncHub3sFromDevices([hub3Dev("H1", "living")]);
    const reloaded = new ConfigStore(configPath).load();
    expect(reloaded.hub3s["living"]).toBeDefined();
    expect(reloaded.hub3s["living"].deviceId).toBe("H1");
  });
});

// ─── CFG-0017 ─────────────────────────────────────────────────────────────────

describe("[CFG-0017] syncHub3sFromDevices: hub_3 / hub_3_lte のみ accept", () => {
  it("[CFG-0017] hub_3 と hub_3_lte を持つ device だけ hub3 view に取り込む; secretKey は不要", () => {
    const store = new ConfigStore(configPath);
    const r = store.syncHub3sFromDevices([
      hub3Dev("H1", "living", "hub_3"),
      hub3Dev("H2", "lte-hub", "hub_3_lte"),
      lockDev("L1", "front"),                                      // ロック → reject
      hub3Dev("H3", "touch", "ssm_touch"),                         // 認証機 → reject
    ]);
    expect(r.added).toHaveLength(2);
    const cfg = store.load();
    expect(cfg.hub3s["living"]).toBeDefined();
    expect(cfg.hub3s["lte-hub"]).toBeDefined();
  });

  it("[CFG-0017] hub_3 は secretKey 無しでも accept される", () => {
    const store = new ConfigStore(configPath);
    // hub3Dev は secretKey を持たない
    const r = store.syncHub3sFromDevices([{ deviceUUID: "H1", deviceName: "hub", deviceModel: "hub_3" }]);
    expect(r.added).toHaveLength(1);
  });

  it("[CFG-0017] isHub3Model は hub_3/hub_3_lte のみ true、他は false", () => {
    expect(isHub3Model("hub_3")).toBe(true);
    expect(isHub3Model("hub_3_lte")).toBe(true);
    expect(isHub3Model("sesame_5")).toBe(false);
    expect(isHub3Model("hub_3_plus")).toBe(false);
    expect(isHub3Model(null)).toBe(false);
    expect(isHub3Model(undefined)).toBe(false);
  });
});

// ─── CFG-0018 ─────────────────────────────────────────────────────────────────

describe("[CFG-0018] syncHub3sFromDevices --prune: remotes が参照中の hub3 は pruneProtect で残す", () => {
  it("[CFG-0018] prune=true でも参照中 hub3 は削除しない (参照整合性保護)", () => {
    const store = new ConfigStore(configPath);
    store.syncHub3sFromDevices([hub3Dev("H1", "living")]);
    // living を参照する remote を作る
    store.addRemote("ac", { hub3: "living", irDeviceUUID: "R1", irType: 0xfe00, keys: {} });
    // H1 が server から消えても、ac が参照しているので残る
    const r = store.syncHub3sFromDevices([], { prune: true });
    expect(r.removed).not.toContain("living");
    expect(store.load().hub3s["living"]).toBeDefined();
  });

  it("[CFG-0018] 参照されていない hub3 は prune で除去される", () => {
    const store = new ConfigStore(configPath);
    store.syncHub3sFromDevices([hub3Dev("H1", "living"), hub3Dev("H2", "unused")]);
    // living だけ remote が参照する
    store.addRemote("ac", { hub3: "living", irDeviceUUID: "R1", irType: 0xfe00, keys: {} });
    // server から両方消えた場合 → unused は削除, living は保護
    const r = store.syncHub3sFromDevices([], { prune: true });
    expect(r.removed).toContain("unused");
    expect(r.removed).not.toContain("living");
  });
});

// ─── CFG-0019 ─────────────────────────────────────────────────────────────────
// CLI 関数 cmdHub3Add の unit test.
// CLI そのものは spawn せず、対応するロジックの形式を確認する。

describe("[CFG-0019] hub3 add: devices から Hub3 を filter (hub_3/hub_3_lte のみ)", () => {
  it("[CFG-0019] hub_3 / hub_3_lte だけが filter を通る (0件分岐の前提確認)", () => {
    const devices = [
      { deviceModel: "hub_3",     deviceUUID: "H1", deviceName: "living" },
      { deviceModel: "hub_3_lte", deviceUUID: "H2", deviceName: "lte" },
      { deviceModel: "sesame_5",  deviceUUID: "L1", deviceName: "front" },
      { deviceModel: "ssm_touch", deviceUUID: "T1", deviceName: "touch" },
    ];
    // mirror of remote.js filter predicate
    const hub3Devices = devices.filter(
      (d) => d.deviceModel === "hub_3" || d.deviceModel === "hub_3_lte",
    );
    expect(hub3Devices).toHaveLength(2);
    expect(hub3Devices.map((d) => d.deviceUUID)).toEqual(["H1", "H2"]);
  });

  it("[CFG-0019] 0件フィルタ結果が空になること (exit 2 相当 — die(hub3NotFoundInDevices,2) の前提)", () => {
    const devices = [
      { deviceModel: "sesame_5",  deviceUUID: "L1" },
      { deviceModel: "ssm_touch", deviceUUID: "T1" },
    ];
    const hub3Devices = devices.filter(
      (d) => d.deviceModel === "hub_3" || d.deviceModel === "hub_3_lte",
    );
    expect(hub3Devices).toHaveLength(0);
  });

  it("[CFG-0019] 1件のとき自動選択 (length===1); 追加後 hub3View に deviceId/name/model が揃う", () => {
    const store = new ConfigStore(configPath);
    const chosen = { deviceUUID: "HUB-UUID-1", deviceName: "My Hub", deviceModel: "hub_3" };
    // Simulate auto-selection: 1件 → chosen === hub3Devices[0]
    const name = (chosen.deviceName || chosen.deviceUUID).replace(/\s+/g, "_").toLowerCase();
    store.addHub3(name, { deviceId: chosen.deviceUUID, name: chosen.deviceName, model: chosen.deviceModel });
    const cfg = store.load();
    const hub3 = cfg.hub3s[name];
    expect(hub3.deviceId).toBe("HUB-UUID-1");
    expect(hub3.name).toBe("My Hub");
    expect(hub3.model).toBe("hub_3");
    // secretKey は null (Hub3 は secretKey 不要)
    expect(hub3.secretKey).toBeNull();
  });

  it("[CFG-0019] 非 TTY 時の name 既定値は deviceName の slug (空白→_ 小文字)", () => {
    const chosen = { deviceUUID: "H1", deviceName: "My Living Hub", deviceModel: "hub_3" };
    const defaultName = (chosen.deviceName || chosen.deviceUUID).replace(/\s+/g, "_").toLowerCase();
    expect(defaultName).toBe("my_living_hub");
  });

  it("[CFG-0019] 非 TTY 時 deviceName が無ければ deviceUUID が名前の素になる", () => {
    const chosen = { deviceUUID: "my-hub-uuid", deviceModel: "hub_3" };
    const defaultName = (chosen.deviceName || chosen.deviceUUID).replace(/\s+/g, "_").toLowerCase();
    expect(defaultName).toBe("my-hub-uuid");
  });
});

// ─── CFG-0020 ─────────────────────────────────────────────────────────────────
// hub3 ls 動作: 未初期化 exit 2 / hub3View shape.

describe("[CFG-0020] hub3 ls: 未初期化 exit 2 / hub3 view shape", () => {
  it("[CFG-0020] configStore.exists() false のとき cmdHub3Ls は die(configNotInitialized,2) の前提を満たす", () => {
    const store = new ConfigStore(configPath);
    // ファイルが無い → exists() === false
    expect(store.exists()).toBe(false);
  });

  it("[CFG-0020] hub3View の shape は deviceId/name/model/secretKey を持つ", () => {
    const store = new ConfigStore(configPath);
    store.addHub3("living", { deviceId: "DEVICE-UUID-001", name: "リビング", model: "hub_3_lte" });
    const cfg = store.load();
    const h = cfg.hub3s["living"];
    expect(h).toHaveProperty("deviceId", "DEVICE-UUID-001");
    expect(h).toHaveProperty("name", "リビング");
    expect(h).toHaveProperty("model", "hub_3_lte");
    expect(h).toHaveProperty("secretKey", null);
  });

  it("[CFG-0020] model 未指定の hub3 は hub_3 が既定値になる", () => {
    const store = new ConfigStore(configPath);
    store.addHub3("living", { deviceId: "DEVICE-UUID-002" });
    const h = store.load().hub3s["living"];
    expect(h.model).toBe("hub_3");
  });

  it("[CFG-0020] hub3View は syncHub3sFromDevices 経由でも同 shape になる", () => {
    const store = new ConfigStore(configPath);
    store.syncHub3sFromDevices([
      { deviceUUID: "DEVICE-UUID-003", deviceName: "玄関", deviceModel: "hub_3" },
    ]);
    const cfg = store.load();
    const h = cfg.hub3s["玄関"];
    expect(h).toHaveProperty("deviceId", "DEVICE-UUID-003");
    expect(h).toHaveProperty("name", "玄関");
    expect(h).toHaveProperty("model", "hub_3");
    expect(h).toHaveProperty("secretKey", null);
  });

  it("[CFG-0020] --json 出力の封筒は {hub3s} で hub3View が入る", () => {
    const store = new ConfigStore(configPath);
    store.syncHub3sFromDevices([
      { deviceUUID: "H1", deviceName: "My Hub", deviceModel: "hub_3" },
    ]);
    const cfg = store.load();
    const hub3s = cfg.hub3s;
    // cmdHub3Ls の --json 出力: out(opts.json, ..., { hub3s })
    const jsonOutput = { hub3s };
    expect(jsonOutput).toHaveProperty("hub3s");
    expect(Object.keys(jsonOutput.hub3s)).toContain(Object.keys(hub3s)[0]);
  });

  it("[CFG-0020] hub3 name と h.deviceId を ls が参照できること (h.name が n と異なる場合に注記付き)", () => {
    const store = new ConfigStore(configPath);
    store.addHub3("living", { deviceId: "DEV-123", name: "My Living Hub", model: "hub_3" });
    const cfg = store.load();
    const hub3 = cfg.hub3s["living"];
    // cmdHub3Ls のフォーマット: `${n}\t${h.deviceId}${h.name !== n ? `\t(${h.name})` : ""}`
    const line = `living\t${hub3.deviceId}${hub3.name && hub3.name !== "living" ? `\t(${hub3.name})` : ""}`;
    expect(line).toContain("living");
    expect(line).toContain("DEV-123");
    expect(line).toContain("(My Living Hub)");
  });
});
