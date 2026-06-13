// P3-2: keystore RPC 経路テスト。
//
// 対象:
//   1. serve registry ハンドラ (keystore.list / keystore.put / keystore.remove) が
//      hub.keyStoreList / keyStorePut / keyStoreRemove へ委譲する wire 形を固定。
//   2. i18n 完全性 — locks.js が参照する 6 キーが cli.js カタログに存在する。
//   3. CLI 文言 — キー名ではなく自然な文言が返ること (キー名の素通し禁止)。
//
// fake transport/hub を使い実機 API Gateway は一切叩かない。

import { describe, it, expect, vi } from "vitest";
import { buildRegistry } from "../../src/serve/registry.js";
import { t, setLocale } from "@sesame-kit/core/i18n";

// requireAuth を通す最小 daemon。
const daemon = { authState: "ok", hub: { connected: true } };

// ---- CHUserKey フィクスチャ (CHUserKey.kt:36-46 から) ----
const SAMPLE_KEY = {
  deviceUUID:       "AABBCCDD-1122-3344-5566-778899AABBCC",
  deviceModel:      "sesame_5",
  keyIndex:         "0001",
  secretKey:        "00112233445566778899aabbccddeeff",
  sesame2PublicKey: "0011223344556677889900112233445566778899001122334455667788990011",
  deviceName:       "Front Door",
  keyLevel:         2,
};

// ---- 1. serve registry ハンドラ結線 ----

describe("P3-2 keystore.list — hub.keyStoreList() 委譲", () => {
  const reg = buildRegistry();
  const entry = reg.get("keystore.list");

  it("registry に登録されている", () => {
    expect(entry).toBeTruthy();
  });

  it("params スキーマ: appIdentifyId (optional string)", () => {
    const p = entry.params.find((x) => x.name === "appIdentifyId");
    expect(p).toBeTruthy();
    expect(p.required).toBe(false);
    expect(p.schema).toMatchObject({ type: "string" });
  });

  it("hub.keyStoreList() を呼び CHUserKey[] を返す", async () => {
    const keys = [SAMPLE_KEY];
    const hub = { keyStoreList: vi.fn(async () => keys) };
    const res = await entry.handler({ hub, daemon, params: {} });
    expect(hub.keyStoreList).toHaveBeenCalledWith({ appIdentifyId: undefined });
    expect(res).toEqual(keys);
  });

  it("appIdentifyId を params から透過する", async () => {
    const hub = { keyStoreList: vi.fn(async () => []) };
    await entry.handler({ hub, daemon, params: { appIdentifyId: "region:device-id" } });
    expect(hub.keyStoreList).toHaveBeenCalledWith({ appIdentifyId: "region:device-id" });
  });

  it("未認証 (authState 未設定) → requireAuth が throw", () => {
    const hub = { keyStoreList: vi.fn() };
    const unauthed = { authState: undefined, hub: { connected: false } };
    expect(() => entry.handler({ hub, daemon: unauthed, params: {} })).toThrow();
    expect(hub.keyStoreList).not.toHaveBeenCalled();
  });
});

describe("P3-2 keystore.put — hub.keyStorePut() 委譲", () => {
  const reg = buildRegistry();
  const entry = reg.get("keystore.put");

  it("registry に登録されている", () => {
    expect(entry).toBeTruthy();
  });

  it("必須 params: deviceUUID/deviceModel/keyIndex/secretKey/sesame2PublicKey/keyLevel", () => {
    const required = entry.params.filter((p) => p.required).map((p) => p.name);
    expect(required).toEqual(expect.arrayContaining([
      "deviceUUID", "deviceModel", "keyIndex", "secretKey", "sesame2PublicKey", "keyLevel",
    ]));
  });

  it("hub.keyStorePut(key, opts) を CHUserKey 形で呼ぶ", async () => {
    const hub = { keyStorePut: vi.fn(async () => ({ ok: true })) };
    const res = await entry.handler({ hub, daemon, params: { ...SAMPLE_KEY } });
    expect(hub.keyStorePut).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceUUID:       SAMPLE_KEY.deviceUUID,
        deviceModel:      SAMPLE_KEY.deviceModel,
        keyIndex:         SAMPLE_KEY.keyIndex,
        secretKey:        SAMPLE_KEY.secretKey,
        sesame2PublicKey: SAMPLE_KEY.sesame2PublicKey,
        keyLevel:         SAMPLE_KEY.keyLevel,
      }),
      { appIdentifyId: undefined },
    );
    expect(res).toMatchObject({ ok: true });
  });

  it("deviceUUID 欠落 → need() が throw (hub 未呼び出し)", () => {
    const hub = { keyStorePut: vi.fn() };
    const p = { ...SAMPLE_KEY };
    delete p.deviceUUID;
    expect(() => entry.handler({ hub, daemon, params: p })).toThrow();
    expect(hub.keyStorePut).not.toHaveBeenCalled();
  });

  it("keyLevel 欠落 (null) → RpcError が throw", () => {
    const hub = { keyStorePut: vi.fn() };
    const p = { ...SAMPLE_KEY, keyLevel: null };
    expect(() => entry.handler({ hub, daemon, params: p })).toThrow();
    expect(hub.keyStorePut).not.toHaveBeenCalled();
  });

  it("deviceName は optional (欠落で null になる)", async () => {
    const hub = { keyStorePut: vi.fn(async () => ({})) };
    const p = { ...SAMPLE_KEY };
    delete p.deviceName;
    await entry.handler({ hub, daemon, params: p });
    expect(hub.keyStorePut).toHaveBeenCalledWith(
      expect.objectContaining({ deviceName: null }),
      expect.anything(),
    );
  });
});

describe("P3-2 keystore.remove — hub.keyStoreRemove() 委譲", () => {
  const reg = buildRegistry();
  const entry = reg.get("keystore.remove");

  it("registry に登録されている", () => {
    expect(entry).toBeTruthy();
  });

  it("params: deviceUUID (required), appIdentifyId (optional)", () => {
    const p = (name) => entry.params.find((x) => x.name === name);
    expect(p("deviceUUID").required).toBe(true);
    expect(p("appIdentifyId").required).toBe(false);
  });

  it("hub.keyStoreRemove(deviceUUID, opts) を呼ぶ", async () => {
    const hub = { keyStoreRemove: vi.fn(async () => ({ removed: true })) };
    const res = await entry.handler({ hub, daemon, params: { deviceUUID: SAMPLE_KEY.deviceUUID } });
    expect(hub.keyStoreRemove).toHaveBeenCalledWith(
      SAMPLE_KEY.deviceUUID,
      { appIdentifyId: undefined },
    );
    expect(res).toMatchObject({ removed: true });
  });

  it("deviceUUID 欠落 → need() が throw", () => {
    const hub = { keyStoreRemove: vi.fn() };
    expect(() => entry.handler({ hub, daemon, params: {} })).toThrow();
    expect(hub.keyStoreRemove).not.toHaveBeenCalled();
  });

  it("appIdentifyId を params から透過する", async () => {
    const hub = { keyStoreRemove: vi.fn(async () => ({})) };
    await entry.handler({
      hub, daemon,
      params: { deviceUUID: SAMPLE_KEY.deviceUUID, appIdentifyId: "ap-northeast-1:abc" },
    });
    expect(hub.keyStoreRemove).toHaveBeenCalledWith(
      SAMPLE_KEY.deviceUUID,
      { appIdentifyId: "ap-northeast-1:abc" },
    );
  });
});

// ---- 2. i18n 完全性: locks.js が使う 6 キーが cli.js に存在する ----

describe("P3-2 i18n 完全性 — locks.js の 6 キーが cli.js カタログに存在する", () => {
  const REQUIRED_KEYS = [
    "cli.optLockPush",
    "cli.okLockPushed",
    "cli.warnLockPushFailed",
    "cli.descLockSyncFromAccount",
    "cli.syncFromAccountFailed",
    "cli.syncFromAccountDone",
  ];

  it("en: 全キーがキー名ではなく自然な文言を返す", () => {
    setLocale("en");
    for (const key of REQUIRED_KEYS) {
      const val = t(key);
      // キー名がそのまま返っていないこと (未定義フォールバックの検出)
      expect(val, `en: ${key} は未定義 (キー名が素通し)`).not.toBe(key);
      // 空文字列でないこと
      expect(val.trim().length, `en: ${key} が空文字`).toBeGreaterThan(0);
    }
  });

  it("ja: 全キーがキー名ではなく自然な文言を返す", () => {
    setLocale("ja");
    for (const key of REQUIRED_KEYS) {
      const val = t(key);
      expect(val, `ja: ${key} は未定義 (キー名が素通し)`).not.toBe(key);
      expect(val.trim().length, `ja: ${key} が空文字`).toBeGreaterThan(0);
    }
    setLocale("en"); // cleanup
  });
});

// ---- 3. CLI 文言サンプル確認 (補間が機能すること) ----

describe("P3-2 CLI 文言補間", () => {
  it("cli.okLockPushed: {name} を補間する (en)", () => {
    setLocale("en");
    const msg = t("cli.okLockPushed", { name: "front" });
    expect(msg).toContain("front");
    expect(msg).not.toContain("{name}");
  });

  it("cli.warnLockPushFailed: {name}/{message} を補間する (en)", () => {
    setLocale("en");
    const msg = t("cli.warnLockPushFailed", { name: "front", message: "timeout" });
    expect(msg).toContain("front");
    expect(msg).toContain("timeout");
    expect(msg).not.toContain("{name}");
    expect(msg).not.toContain("{message}");
  });

  it("cli.syncFromAccountDone: {total}/{added} を補間する (en)", () => {
    setLocale("en");
    const msg = t("cli.syncFromAccountDone", { total: 5, added: 3 });
    expect(msg).toContain("5");
    expect(msg).toContain("3");
  });

  it("cli.syncFromAccountFailed: {message} を補間する (ja)", () => {
    setLocale("ja");
    const msg = t("cli.syncFromAccountFailed", { message: "接続エラー" });
    expect(msg).toContain("接続エラー");
    expect(msg).not.toContain("{message}");
    setLocale("en");
  });
});
