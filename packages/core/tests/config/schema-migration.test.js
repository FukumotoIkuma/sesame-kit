// P5-6 (ARCH-12): config のスキーマバージョンとマイグレーション体系を固定する。
//   - schemaVersion: 2 の付与 (emptyConfig / save)
//   - save() の未知キー保持 (ホワイトリストは派生 view の除外専用)
//   - v1 (locks/hub3s トップレベル永続化) → v2 (devices 単一真実) の移行
//   - ダウングレード安全 (新しい版が書いたキー/版数を古い版が消さない)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigStore, migrateConfig, normalizeConfig, SCHEMA_VERSION } from "../../src/config.js";

let workDir;
let configPath;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "sesame-schema-"));
  configPath = join(workDir, "config.json");
});

afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
  configPath = null;
});

/** ディスク上の config.json を読む。 */
function onDisk() {
  return JSON.parse(readFileSync(configPath, "utf8"));
}

describe("schemaVersion の付与", () => {
  it("現行スキーマ版数は 2", () => {
    expect(SCHEMA_VERSION).toBe(2);
  });

  it("init() で schemaVersion: 2 が書かれる", () => {
    const store = new ConfigStore(configPath);
    store.init();
    expect(onDisk().schemaVersion).toBe(2);
  });

  it("schemaVersion 無しの config も load→save で 2 が付与される", () => {
    writeFileSync(configPath, JSON.stringify({ companyID: "co" }));
    const store = new ConfigStore(configPath);
    store.load();
    store.save();
    expect(onDisk().schemaVersion).toBe(2);
    expect(onDisk().companyID).toBe("co");
  });
});

describe("save() の未知キー保持 (P5-6)", () => {
  it("未知のトップレベルキーは load→save で消えない", () => {
    writeFileSync(configPath, JSON.stringify({
      companyID: "co",
      futureFeatureFlag: { enabled: true, mode: "x" }, // 将来バージョンが書いた未知キー
      anotherUnknown: "keep-me",
    }));
    const store = new ConfigStore(configPath);
    store.load();
    store.save();
    const disk = onDisk();
    expect(disk.futureFeatureFlag).toEqual({ enabled: true, mode: "x" });
    expect(disk.anotherUnknown).toBe("keep-me");
  });

  it("ドメイン操作 (addLock) を経ても未知キーは保持される", () => {
    writeFileSync(configPath, JSON.stringify({ futureKey: 42 }));
    const store = new ConfigStore(configPath);
    store.addLock("L1", { deviceUUID: "u-1", secretKey: "0123456789abcdef0123456789abcdef" });
    const disk = onDisk();
    expect(disk.futureKey).toBe(42);
    expect(disk.devices.L1.deviceUUID).toBe("u-1");
  });

  it("派生 view (locks/hub3s) だけは保存されない (除外はブラックリスト限定)", () => {
    const store = new ConfigStore(configPath);
    store.addLock("L1", { deviceUUID: "u-1", secretKey: "0123456789abcdef0123456789abcdef" });
    store.addHub3("H1", { deviceId: "dev-h1" });
    const disk = onDisk();
    expect(disk.locks).toBeUndefined();
    expect(disk.hub3s).toBeUndefined();
    expect(Object.keys(disk.devices).sort()).toEqual(["H1", "L1"]);
  });
});

describe("v1 → v2 マイグレーション (MIGRATIONS テーブル)", () => {
  it("v1 shape (locks/hub3s トップレベル) は devices{} へ移行され view から見える", () => {
    // schemaVersion 無し = v1。旧 CLI が書いた locks/hub3s 永続化 shape。
    writeFileSync(configPath, JSON.stringify({
      companyID: "co",
      locks: { front: { deviceUUID: "u-front", secretKey: "0123456789abcdef0123456789abcdef", model: "sesame_5", alias: "玄関" } },
      hub3s: { hub: { deviceId: "u-hub", name: "Hub" } },
      default: { lock: "front", remote: null },
    }));
    const store = new ConfigStore(configPath);
    const cfg = store.load();
    // devices が単一の真実になり、view (locks/hub3s) は再投影で復元される
    expect(cfg.devices.front).toMatchObject({ deviceUUID: "u-front", deviceModel: "sesame_5", deviceName: "玄関", category: "lock" });
    expect(cfg.devices.hub).toMatchObject({ deviceUUID: "u-hub", deviceModel: "hub_3", category: "hub3" });
    expect(cfg.locks.front.model).toBe("sesame_5");
    expect(cfg.hub3s.hub.deviceId).toBe("u-hub");
    // save() でディスク上も v2 になる (locks/hub3s キーは消え、schemaVersion: 2 が付く)
    store.save();
    const disk = onDisk();
    expect(disk.schemaVersion).toBe(2);
    expect(disk.locks).toBeUndefined();
    expect(disk.hub3s).toBeUndefined();
    expect(disk.devices.front.secretKey).toBe("0123456789abcdef0123456789abcdef");
  });

  it("既に devices に居る UUID は legacy locks から重複移行しない", () => {
    writeFileSync(configPath, JSON.stringify({
      devices: { front: { deviceUUID: "U-1", secretKey: "new", category: "lock" } },
      locks: { stale: { deviceUUID: "u1", secretKey: "old" } }, // UUID 正規化で同一
    }));
    const cfg = new ConfigStore(configPath).load();
    expect(cfg.devices.stale).toBeUndefined();
    expect(cfg.devices.front.secretKey).toBe("new");
  });

  it("migrateConfig は純関数として v1 入力を v2 へ写す (embedded 利用)", () => {
    const migrated = migrateConfig({
      locks: { L: { deviceUUID: "u", secretKey: "s" } },
    });
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.devices.L).toMatchObject({ deviceUUID: "u", category: "lock" });
    expect(migrated.locks).toBeUndefined();
  });

  it("normalizeConfig は最新 shape の正規化のみ (legacy locks は解釈しない)", () => {
    // P5-6 の契約変更: 旧 shape の解釈は migrateConfig が担う。normalizeConfig 単体に
    // legacy locks を渡しても devices へは取り込まれない (view は devices からのみ再投影)。
    const cfg = normalizeConfig({ locks: { L: { deviceUUID: "u", secretKey: "s" } } });
    expect(cfg.devices.L).toBeUndefined();
    expect(cfg.locks).toEqual({});
  });
});

describe("ダウングレード安全", () => {
  it("schemaVersion が現行より新しい config は版数を巻き戻さず、新キーも保持する", () => {
    writeFileSync(configPath, JSON.stringify({
      schemaVersion: 99,
      companyID: "co",
      v99OnlyField: { future: true },
    }));
    const store = new ConfigStore(configPath);
    const cfg = store.load();
    expect(cfg.schemaVersion).toBe(99); // 巻き戻さない
    store.save();
    const disk = onDisk();
    expect(disk.schemaVersion).toBe(99);
    expect(disk.v99OnlyField).toEqual({ future: true });
  });
});
