// バックログ4: OS2 鍵素材 (ssmPublicKey / keyIndex) の config 保存。
// - addLock で保存でき、ディスク永続化 → 再ロードで locks 派生 view に投影される
// - 形式不正 (128 hex / 4 hex 以外) は保存前に badRequest で弾く
// - 未指定ならキー自体を作らない (既存 lock エントリの shape を汚さない)
// - sync 更新 (サーバ応答にはこれらのフィールドが無い) でもローカル注釈として残る
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigStore } from "../../src/config.js";

const SSM_PUB = "ab".repeat(64); // 64B = 128 hex
const KEY_IDX = "0001";

let workDir;
let configPath;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "sesame-os2cfg-"));
  configPath = join(workDir, "config.json");
});

afterEach(() => {
  if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  workDir = null;
  configPath = null;
});

function validLock(overrides = {}) {
  return {
    deviceUUID: "00000000-0000-0000-0000-000000000001",
    secretKey: "0123456789abcdef0123456789abcdef",
    ...overrides,
  };
}

describe("ConfigStore: OS2 鍵フィールドの保存 (バックログ4)", () => {
  it("addLock で ssmPublicKey/keyIndex を保存し、locks view に投影する", () => {
    const store = new ConfigStore(configPath);
    store.addLock("os2lock", validLock({ ssmPublicKey: SSM_PUB, keyIndex: KEY_IDX }));

    // 派生 view (locks) に載る (resolveBleEntry / os2-invoke が読む面)
    const cfg = store.load();
    expect(cfg.locks.os2lock.ssmPublicKey).toBe(SSM_PUB);
    expect(cfg.locks.os2lock.keyIndex).toBe(KEY_IDX);

    // ディスクに永続化され、別インスタンスの再ロードでも復元される
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    expect(raw.devices.os2lock.ssmPublicKey).toBe(SSM_PUB);
    expect(raw.devices.os2lock.keyIndex).toBe(KEY_IDX);
    const reloaded = new ConfigStore(configPath).load();
    expect(reloaded.locks.os2lock.ssmPublicKey).toBe(SSM_PUB);
    expect(reloaded.locks.os2lock.keyIndex).toBe(KEY_IDX);
  });

  it("hex は小文字へ正規化して保存する", () => {
    const store = new ConfigStore(configPath);
    store.addLock("os2lock", validLock({ ssmPublicKey: "AB".repeat(64), keyIndex: "00FF" }));
    const cfg = store.load();
    expect(cfg.locks.os2lock.ssmPublicKey).toBe("ab".repeat(64));
    expect(cfg.locks.os2lock.keyIndex).toBe("00ff");
  });

  it("未指定ならキー自体を作らない (OS3 lock の shape を汚さない)", () => {
    const store = new ConfigStore(configPath);
    store.addLock("os3lock", validLock());
    const cfg = store.load();
    expect("ssmPublicKey" in cfg.locks.os3lock).toBe(false);
    expect("keyIndex" in cfg.locks.os3lock).toBe(false);
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    expect("ssmPublicKey" in raw.devices.os3lock).toBe(false);
    expect("keyIndex" in raw.devices.os3lock).toBe(false);
  });

  it("ssmPublicKey の形式不正 (128 hex 以外) は保存前に弾く", () => {
    const store = new ConfigStore(configPath);
    for (const bad of ["zz".repeat(64), "ab".repeat(63), "ab".repeat(65), "not-hex"]) {
      expect(() => store.addLock("x", validLock({ ssmPublicKey: bad }))).toThrow(/ssmPublicKey/);
    }
    expect(store.load().devices.x).toBeUndefined(); // 1 件も保存されていない
  });

  it("keyIndex の形式不正 (4 hex 以外) は保存前に弾く", () => {
    const store = new ConfigStore(configPath);
    for (const bad of ["0", "00000", "zzzz", "0x00"]) {
      expect(() =>
        store.addLock("x", validLock({ ssmPublicKey: SSM_PUB, keyIndex: bad })),
      ).toThrow(/keyIndex/);
    }
    expect(store.load().devices.x).toBeUndefined();
  });

  it("sync 更新 (サーバ応答に OS2 フィールド無し) でもローカル注釈として残る", () => {
    const store = new ConfigStore(configPath);
    const uuid = "00000000-0000-0000-0000-000000000001";
    store.addLock("os2lock", validLock({ deviceUUID: uuid, ssmPublicKey: SSM_PUB, keyIndex: KEY_IDX }));
    // サーバ応答相当 (ssmPublicKey/keyIndex を持たない) で同一 device を sync 更新する
    store.syncLocksFromDevices([
      {
        deviceUUID: uuid,
        secretKey: "ff".repeat(16),
        deviceModel: "sesame_4",
        deviceName: "renamed",
      },
    ]);
    const cfg = store.load();
    expect(cfg.locks.os2lock.secretKey).toBe("ff".repeat(16)); // サーバ由来は追従
    expect(cfg.locks.os2lock.ssmPublicKey).toBe(SSM_PUB); // ローカル注釈は引き継ぐ
    expect(cfg.locks.os2lock.keyIndex).toBe(KEY_IDX);
  });
});
