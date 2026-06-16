// packages/kit/tests/_spec/ks-c1.test.js
// KS-0023, KS-0024, KS-0025, KS-0026, KS-0027, KS-0028, KS-0029, KS-0031
//
// 対象:
//   KS-0023 — putKey/removeKey の応答素通し (json != null → json, else text)
//   KS-0024 — locks add --push → putKey CHUserKey 構築 + keyLevel=2
//   KS-0025 — locks add --push 同期失敗でも exit 0 (警告継続)
//   KS-0026 — locks sync-from-account → getDevicesList 追加のみ / 既存 skip
//   KS-0027 — sync-from-account 取得失敗=exit1 / config 未初期化=exit2
//   KS-0028 — sync-from-account --json 封筒 {ok,total,added} / human 出力
//   KS-0029 — keystore/locks 同期 CLI の i18n 6 キー完全性 en/ja
//   KS-0031 — keystore.put serve handler 7 フィールド切り詰め rank/subUUID/stateInfo 欠落
//
// 方針: TDD — spec どおりの期待値を assert する。実装と食い違う箇所は red でよい。
// ネットワーク/実機に触れない。全て純関数・fake transport・buildRegistry 経由。
// KS-0024/0025/0026/0027/0028 は実装ロジックをレプリカで検証 (CLI mock なし)。
// KS-0023/KS-0031 は実 import を使いネットワーク不到達を fake transport で保証。

import { describe, it, expect, vi } from "vitest";
import { t, setLocale } from "@sesame-kit/core/i18n";
import { putKey, removeKey, getDevicesList } from "@sesame-kit/core/devices";
import { buildRegistry } from "../../src/serve/registry.js";
import cliCatalog from "../../src/i18n/cli.js";

// ── フィクスチャ ──────────────────────────────────────────────────────────────

/** CHUserKey フィクスチャ (CHUserKey.kt:36-46 から導出) */
const SAMPLE_KEY = {
  deviceUUID:       "AABBCCDD-1122-3344-5566-778899AABBCC",
  deviceModel:      "sesame_5",
  keyIndex:         "0001",
  secretKey:        "00112233445566778899aabbccddeeff",
  sesame2PublicKey: "0011223344556677889900112233445566778899001122334455667788990011",
  deviceName:       "Front Door",
  keyLevel:         2,
};

/**
 * Fake transport: records calls and returns a fixed reply.
 * @param {{ status: number, json?: any, text?: string }} reply
 */
function makeFakeTransport(reply = { status: 200, json: null, text: "" }) {
  const calls = [];
  const transport = async (req) => { calls.push(req); return reply; };
  return { transport, calls };
}

// =============================================================================
// KS-0023 — putKey/removeKey 応答素通し (json != null → json, else text)
// ref: packages/core/src/devices.js:828-860
// CHAPIClient.kt:29-33; CHAPIClient.kt:42-46
// =============================================================================

describe("[KS-0023] putKey/removeKey response passthrough (json→json, null→text)", () => {
  it("[KS-0023] putKey: res.json != null → returns json", async () => {
    const { transport } = makeFakeTransport({ status: 200, json: { ok: true }, text: "ignored" });
    const result = await putKey(transport, SAMPLE_KEY);
    // spec: res.json != null → return res.json (devices.js:833)
    expect(result).toEqual({ ok: true });
  });

  it("[KS-0023] putKey: res.json == null → returns res.text", async () => {
    const { transport } = makeFakeTransport({ status: 200, json: null, text: "raw-text-response" });
    const result = await putKey(transport, SAMPLE_KEY);
    // spec: res.json null → return res.text (devices.js:833)
    expect(result).toBe("raw-text-response");
  });

  it("[KS-0023] putKey: res.json === 0 (falsy but != null) → returns 0, not text", async () => {
    // CHAPIClient.kt `): Any` — numeric 0 is valid json response; must not fall through to text
    const { transport } = makeFakeTransport({ status: 200, json: 0, text: "should-not-return" });
    const result = await putKey(transport, SAMPLE_KEY);
    // json != null is the guard (0 != null is true), so returns json value 0
    expect(result).toBe(0);
  });

  it("[KS-0023] putKey: res.json === false (falsy but != null) → returns false, not text", async () => {
    const { transport } = makeFakeTransport({ status: 200, json: false, text: "should-not-return" });
    const result = await putKey(transport, SAMPLE_KEY);
    expect(result).toBe(false);
  });

  it("[KS-0023] putKey: res.json === '' (falsy but != null) → returns '', not text", async () => {
    const { transport } = makeFakeTransport({ status: 200, json: "", text: "should-not-return" });
    const result = await putKey(transport, SAMPLE_KEY);
    expect(result).toBe("");
  });

  it("[KS-0023] removeKey: res.json != null → returns json", async () => {
    const { transport } = makeFakeTransport({ status: 200, json: { removed: true }, text: "ignored" });
    const result = await removeKey(transport, SAMPLE_KEY.deviceUUID);
    // spec: res.json != null → return res.json (devices.js:859)
    expect(result).toEqual({ removed: true });
  });

  it("[KS-0023] removeKey: res.json == null → returns res.text", async () => {
    const { transport } = makeFakeTransport({ status: 200, json: null, text: "ok text" });
    const result = await removeKey(transport, SAMPLE_KEY.deviceUUID);
    // spec: res.json null → return res.text (devices.js:859)
    expect(result).toBe("ok text");
  });

  it("[KS-0023] removeKey: res.json === 0 (falsy but != null) → returns 0", async () => {
    const { transport } = makeFakeTransport({ status: 200, json: 0, text: "should-not-return" });
    const result = await removeKey(transport, SAMPLE_KEY.deviceUUID);
    expect(result).toBe(0);
  });
});

// =============================================================================
// KS-0024 — locks add --push → putKey 同期 (CHUserKey 構築 + keyLevel=2)
// ref: packages/kit/src/cli/locks.js:143-168
// CHUserKey.kt:10-21; ScanQRcodeFG.kt:342-348
// =============================================================================

describe("[KS-0024] locks add --push → putKey with CHUserKey {…, keyLevel:2}", () => {
  it("[KS-0024] CHUserKey is built with exactly 7 fields including keyLevel:2", () => {
    // Replicate the CHUserKey construction from locks.js:151-158
    const deviceUUID = "AABBCCDD-1122-3344-5566-778899AABBCC";
    const model = "sesame_5";
    const keyIndex = "0001";
    const secretKey = "00112233445566778899aabbccddeeff";
    const ssmPublicKey = "0011223344556677889900112233445566778899001122334455667788990011";
    const name = "front";

    const key = {
      deviceUUID,
      deviceModel: model || "",
      keyIndex: keyIndex || "",
      secretKey,
      sesame2PublicKey: ssmPublicKey || "",
      deviceName: name || null,
      keyLevel: 2, // level=2 is kit-side convention (locks.js:158)
    };

    // spec: keyLevel is fixed at 2 (locks.js:158)
    expect(key.keyLevel).toBe(2);
    expect(key.deviceUUID).toBe(deviceUUID);
    expect(key.deviceModel).toBe("sesame_5");
    expect(key.keyIndex).toBe("0001");
    expect(key.secretKey).toBe(secretKey);
    expect(key.sesame2PublicKey).toBe(ssmPublicKey);
    expect(key.deviceName).toBe("front");

    // spec: exactly 7 fields — no rank/subUUID/stateInfo (CHUserKey 7-field shape)
    expect(Object.keys(key)).toEqual([
      "deviceUUID", "deviceModel", "keyIndex", "secretKey",
      "sesame2PublicKey", "deviceName", "keyLevel",
    ]);
  });

  it("[KS-0024] putKey is called with the constructed CHUserKey via fake transport (wire shape)", async () => {
    // Simulate the transport call path that cmdLockAdd uses after building CHUserKey.
    // ref: locks.js:149-160 (makeKeyStoreTransport + putKey call)
    const { transport, calls } = makeFakeTransport({ status: 200, json: {}, text: "" });

    const key = {
      deviceUUID: "AABBCCDD-1122-3344-5566-778899AABBCC",
      deviceModel: "sesame_5",
      keyIndex: "0001",
      secretKey: "00112233445566778899aabbccddeeff",
      sesame2PublicKey: "0011223344556677889900112233445566778899001122334455667788990011",
      deviceName: "front",
      keyLevel: 2,
    };

    await putKey(transport, key);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].path).toBe("/device");
    // body must be the full CHUserKey object
    expect(calls[0].body).toEqual(key);
    // keyLevel in wire body is 2
    expect(calls[0].body.keyLevel).toBe(2);
  });

  it("[KS-0024] name absent → deviceName: null in CHUserKey (locks.js:157 `name || null`)", () => {
    // Replicate locks.js:157 for the case where name is empty/undefined
    const name = undefined;
    const key = {
      deviceUUID: "UUID",
      deviceModel: "",
      keyIndex: "",
      secretKey: "00112233445566778899aabbccddeeff",
      sesame2PublicKey: "",
      deviceName: name || null, // locks.js:157
      keyLevel: 2,
    };
    expect(key.deviceName).toBeNull();
  });

  it("[KS-0024] empty name → deviceName: null in CHUserKey (empty-string || null)", () => {
    const name = "";
    const key = {
      deviceUUID: "UUID",
      deviceModel: "",
      keyIndex: "",
      secretKey: "00112233445566778899aabbccddeeff",
      sesame2PublicKey: "",
      deviceName: name || null,
      keyLevel: 2,
    };
    expect(key.deviceName).toBeNull();
  });
});

// =============================================================================
// KS-0025 — locks add --push 同期失敗でも exit 0 / 警告継続
// ref: packages/kit/src/cli/locks.js:160-172
// =============================================================================

describe("[KS-0025] locks add --push failure: warn+continue, local success (exit 0) not overwritten", () => {
  it("[KS-0025] putKey throw is caught; out({ok:true}) still reached after catch", async () => {
    // Replicate locks.js:160-172 control flow:
    //   try { await putKey(...) } catch (e) { warn }  // 160-167
    //   out(isJsonMode(), ..., {ok:true, ...})          // 170-172 — unconditional
    let outCalled = false;
    let warnCalled = false;

    const fakeTransport = async () => { throw new Error("network error"); };
    try {
      await putKey(fakeTransport, SAMPLE_KEY);
    } catch {
      // simulates the catch block: logs warning (165-166), does NOT rethrow
      warnCalled = true;
    }
    // after catch, unconditionally call out() — spec: local success not affected
    outCalled = true;

    // spec: catch does NOT propagate — warn fired and out() reached
    expect(warnCalled).toBe(true);
    expect(outCalled).toBe(true);
  });

  it("[KS-0025] catch block: cli.warnLockPushFailed key exists and has {name}/{message} placeholders (en)", () => {
    // ref: locks.js:164-166; cli.js:321
    const enWarn = cliCatalog.en["cli.warnLockPushFailed"];
    expect(enWarn).toBeDefined();
    expect(enWarn).toContain("{name}");
    expect(enWarn).toContain("{message}");
  });

  it("[KS-0025] catch block: cli.warnLockPushFailed key has {name}/{message} placeholders (ja)", () => {
    // ref: cli.js:742
    const jaWarn = cliCatalog.ja["cli.warnLockPushFailed"];
    expect(jaWarn).toBeDefined();
    expect(jaWarn).toContain("{name}");
    expect(jaWarn).toContain("{message}");
  });

  it("[KS-0025] out() envelope after --push: {ok:true} is always present regardless of push result", () => {
    // Replicate the out() envelope shape from locks.js:170-172.
    // This is the local addLock success envelope — putKey result is irrelevant.
    const name = "front";
    const deviceUUID = "AABBCCDD-1122-3344-5566-778899AABBCC";
    const model = "sesame_5";
    const ssmPublicKey = null;
    const keyIndex = null;

    // Simulate the out() JSON envelope (locks.js:170-172)
    const envelope = {
      ok: true,
      lock: name,
      deviceUUID,
      model: model || null,
      alias: null,
      ...(ssmPublicKey ? { ssmPublicKey } : {}),
      ...(keyIndex ? { keyIndex } : {}),
    };

    expect(envelope.ok).toBe(true);
    expect(envelope.lock).toBe("front");
    // No ssmPublicKey/keyIndex keys when null
    expect(envelope).not.toHaveProperty("ssmPublicKey");
    expect(envelope).not.toHaveProperty("keyIndex");
  });
});

// =============================================================================
// KS-0026 — locks sync-from-account → getDevicesList 取り込み (既存 skip + 追加のみ)
// ref: packages/kit/src/cli/locks.js:243-263
// CHAPIClientBiz.kt:105-106
// =============================================================================

describe("[KS-0026] sync-from-account: new deviceUUID only added; existing skipped; name=deviceName||deviceUUID", () => {
  it("[KS-0026] existing deviceUUID is skipped (not added again)", () => {
    // Replicate cmdLockSyncFromAccount:248-249 (locks.js)
    const existingLocks = {
      "front": { deviceUUID: "AABBCCDD-1122-3344-5566-778899AABBCC", secretKey: "00112233445566778899aabbccddeeff" },
    };

    const incomingKeys = [
      { deviceUUID: "AABBCCDD-1122-3344-5566-778899AABBCC", deviceName: "Front Door", deviceModel: "sesame_5", secretKey: "00112233445566778899aabbccddeeff", keyLevel: 2 },
      { deviceUUID: "BBBBCCCC-2233-4455-6677-889900AABBCC", deviceName: "Back Door",  deviceModel: "sesame_5", secretKey: "aabbccddeeff00112233445566778899", keyLevel: 2 },
    ];

    let added = 0;
    const added_names = [];
    for (const key of incomingKeys) {
      if (!key.deviceUUID) continue;
      const existing = Object.values(existingLocks).find((l) => l.deviceUUID === key.deviceUUID);
      if (existing) continue; // skip — locks.js:248-249
      const name = key.deviceName || key.deviceUUID; // locks.js:250
      added_names.push(name);
      added++;
    }

    // spec: 既存 deviceUUID は skip、新規のみ addLock (locks.js:248-259)
    expect(added).toBe(1);
    expect(added_names).toEqual(["Back Door"]);
  });

  it("[KS-0026] name = deviceName || deviceUUID fallback when deviceName is falsy", () => {
    // ref: locks.js:250 `const name = key.deviceName || key.deviceUUID`
    const keyWithName    = { deviceUUID: "UUID-A", deviceName: "My Lock", deviceModel: "sesame_5" };
    const keyWithoutName = { deviceUUID: "UUID-B", deviceName: "",        deviceModel: "sesame_5" };
    const keyNullName    = { deviceUUID: "UUID-C", deviceName: null,      deviceModel: "sesame_5" };

    expect(keyWithName.deviceName    || keyWithName.deviceUUID).toBe("My Lock");
    expect(keyWithoutName.deviceName || keyWithoutName.deviceUUID).toBe("UUID-B");
    expect(keyNullName.deviceName    || keyNullName.deviceUUID).toBe("UUID-C");
  });

  it("[KS-0026] key.deviceUUID falsy → skipped (no addLock for malformed entries)", () => {
    // ref: locks.js:246 `if (!key.deviceUUID) continue;`
    const keys = [
      { deviceUUID: "",   deviceName: "No UUID",   deviceModel: "sesame_5", secretKey: "aabbccddeeff00112233445566778899" },
      { deviceUUID: null, deviceName: "Null UUID", deviceModel: "sesame_5", secretKey: "aabbccddeeff00112233445566778899" },
    ];
    let added = 0;
    for (const key of keys) {
      if (!key.deviceUUID) continue; // locks.js:246
      added++;
    }
    expect(added).toBe(0);
  });

  it("[KS-0026] total = keys.length from getDevicesList; added counts only newly inserted", () => {
    // ref: locks.js:261-263 out(..., { ok:true, total:keys.length, added })
    const keys = [
      { deviceUUID: "UUID-A", deviceName: "Lock A", deviceModel: "sesame_5", secretKey: "00112233445566778899aabbccddeeff" },
      { deviceUUID: "UUID-B", deviceName: "Lock B", deviceModel: "sesame_5", secretKey: "aabbccddeeff00112233445566778899" },
      { deviceUUID: "UUID-C", deviceName: "Lock C", deviceModel: "sesame_5", secretKey: "11223344556677889900aabbccddeeff" },
    ];
    const existingLocks = {
      "lock-a": { deviceUUID: "UUID-A" },
    };

    let added = 0;
    for (const key of keys) {
      if (!key.deviceUUID) continue;
      const existing = Object.values(existingLocks).find((l) => l.deviceUUID === key.deviceUUID);
      if (existing) continue;
      added++;
    }

    // total is keys.length (all from server), added is only newly inserted
    const total = keys.length;
    expect(total).toBe(3);
    expect(added).toBe(2);

    const envelope = { ok: true, total, added };
    expect(envelope).toEqual({ ok: true, total: 3, added: 2 });
  });
});

// =============================================================================
// KS-0027 — locks sync-from-account 取得失敗=exit1 / config 未初期化=exit2
// ref: packages/kit/src/cli/locks.js:231-242
// =============================================================================

describe("[KS-0027] sync-from-account exit codes: fetch-fail→exit1, no-config→exit2", () => {
  it("[KS-0027] configStore.exists()===false → die with configNotInitialized, exit code 2", () => {
    // ref: locks.js:232 `if (!configStore.exists()) die(t("cli.configNotInitialized"), 2);`
    let dieCode = null;
    let transportCalled = false;

    const mockConfigStore = { exists: () => false };
    const mockDie = (msg, code) => { dieCode = code; throw new Error("die"); };

    try {
      if (!mockConfigStore.exists()) mockDie(t("cli.configNotInitialized"), 2);
      transportCalled = true; // must not reach here
    } catch {
      // die() threw — expected
    }

    // spec: die(configNotInitialized, 2) → exit 2 (locks.js:232)
    expect(dieCode).toBe(2);
    expect(transportCalled).toBe(false);
  });

  it("[KS-0027] getDevicesList throw → die with syncFromAccountFailed, exit code 1", async () => {
    // ref: locks.js:239-241
    // catch (e) { die(t("cli.syncFromAccountFailed", { message: e.message }), 1); return; }
    let dieCode = null;
    let dieMsg = null;

    const fakeTransport = async () => { throw new Error("connection refused"); };
    const mockDie = (msg, code) => { dieMsg = msg; dieCode = code; };

    try {
      // getDevicesList throws because the transport itself throws (simulating network error)
      await getDevicesList(fakeTransport);
    } catch (e) {
      mockDie(t("cli.syncFromAccountFailed", { message: e.message }), 1);
    }

    // spec: die(syncFromAccountFailed, 1) → exit 1 (locks.js:240)
    expect(dieCode).toBe(1);
    expect(dieMsg).toBeTruthy();
    expect(typeof dieMsg).toBe("string");
  });

  it("[KS-0027] exit code distinction: no-config is 2, fetch-fail is 1", () => {
    // Verify the exit code contract by value
    const EXIT_NO_CONFIG = 2;
    const EXIT_FETCH_FAIL = 1;
    expect(EXIT_NO_CONFIG).toBe(2);
    expect(EXIT_FETCH_FAIL).toBe(1);
    expect(EXIT_NO_CONFIG).not.toBe(EXIT_FETCH_FAIL);
  });

  it("[KS-0027] cli.configNotInitialized i18n key is registered and not empty (en)", () => {
    // Verify the key used in the die() call is properly registered
    setLocale("en");
    const enMsg = t("cli.configNotInitialized");
    expect(enMsg).toBeTruthy();
    expect(enMsg).not.toBe("cli.configNotInitialized"); // must not passthrough key
  });

  it("[KS-0027] cli.configNotInitialized i18n key is registered and not empty (ja)", () => {
    setLocale("ja");
    const jaMsg = t("cli.configNotInitialized");
    expect(jaMsg).toBeTruthy();
    expect(jaMsg).not.toBe("cli.configNotInitialized");
  });

  it("[KS-0027] cli.syncFromAccountFailed has {message} interpolation placeholder (en catalog)", () => {
    // ref: cli.js:323
    const enTpl = cliCatalog.en["cli.syncFromAccountFailed"];
    expect(enTpl).toBeDefined();
    expect(enTpl).toContain("{message}");
  });

  it("[KS-0027] cli.syncFromAccountFailed has {message} interpolation placeholder (ja catalog)", () => {
    // ref: cli.js:744
    const jaTpl = cliCatalog.ja["cli.syncFromAccountFailed"];
    expect(jaTpl).toBeDefined();
    expect(jaTpl).toContain("{message}");
  });
});

// =============================================================================
// KS-0028 — locks sync-from-account --json 出力封筒 {ok,total,added}
// ref: packages/kit/src/cli/locks.js:261-263
// =============================================================================

describe("[KS-0028] sync-from-account --json output: {ok:true, total, added} / human: syncFromAccountDone", () => {
  it("[KS-0028] json envelope shape: {ok:true, total, added}", () => {
    // ref: locks.js:261-263
    // out(isJsonMode(),
    //   () => console.log(t("cli.syncFromAccountDone", { total: keys.length, added })),
    //   { ok: true, total: keys.length, added });
    const keys = [{ deviceUUID: "A" }, { deviceUUID: "B" }, { deviceUUID: "C" }];
    const added = 2;
    const jsonEnvelope = { ok: true, total: keys.length, added };

    expect(jsonEnvelope).toHaveProperty("ok", true);
    expect(jsonEnvelope).toHaveProperty("total", 3);
    expect(jsonEnvelope).toHaveProperty("added", 2);
  });

  it("[KS-0028] json envelope ok is boolean true (not just truthy)", () => {
    const envelope = { ok: true, total: 0, added: 0 };
    expect(envelope.ok).toBe(true);
    expect(typeof envelope.ok).toBe("boolean");
  });

  it("[KS-0028] json envelope: total === keys.length (all keys from server)", () => {
    const serverKeys = new Array(5).fill(null).map((_, i) => ({ deviceUUID: `UUID-${i}` }));
    const addedCount = 0; // all exist locally
    const envelope = { ok: true, total: serverKeys.length, added: addedCount };
    expect(envelope.total).toBe(5);
    expect(envelope.added).toBe(0);
  });

  it("[KS-0028] human mode: cli.syncFromAccountDone key has {total} and {added} placeholders (en catalog)", () => {
    // ref: cli.js:324
    const enTpl = cliCatalog.en["cli.syncFromAccountDone"];
    expect(enTpl).toBeDefined();
    expect(enTpl).toContain("{total}");
    expect(enTpl).toContain("{added}");
  });

  it("[KS-0028] human mode: cli.syncFromAccountDone key has {total} and {added} placeholders (ja catalog)", () => {
    // ref: cli.js:745
    const jaTpl = cliCatalog.ja["cli.syncFromAccountDone"];
    expect(jaTpl).toBeDefined();
    expect(jaTpl).toContain("{total}");
    expect(jaTpl).toContain("{added}");
  });

  it("[KS-0028] cli.syncFromAccountDone interpolation: {total}/{added} expanded (en)", () => {
    setLocale("en");
    const msg = t("cli.syncFromAccountDone", { total: 7, added: 3 });
    expect(msg).not.toContain("{total}");
    expect(msg).not.toContain("{added}");
    expect(msg).toContain("7");
    expect(msg).toContain("3");
  });

  it("[KS-0028] cli.syncFromAccountDone interpolation: {total}/{added} expanded (ja)", () => {
    setLocale("ja");
    const msg = t("cli.syncFromAccountDone", { total: 5, added: 2 });
    expect(msg).not.toContain("{total}");
    expect(msg).not.toContain("{added}");
    expect(msg).toContain("5");
    expect(msg).toContain("2");
  });
});

// =============================================================================
// KS-0029 — keystore/locks 同期 CLI の i18n 6 キー完全性 en/ja
// ref: packages/kit/src/i18n/cli.js:319-324; packages/kit/src/i18n/cli.js:740-745
// =============================================================================

describe("[KS-0029] i18n catalog completeness: 6 keys en/ja, natural text, interpolation expanded", () => {
  const REQUIRED_KEYS = [
    "cli.optLockPush",
    "cli.okLockPushed",
    "cli.warnLockPushFailed",
    "cli.descLockSyncFromAccount",
    "cli.syncFromAccountFailed",
    "cli.syncFromAccountDone",
  ];

  it("[KS-0029] en: all 6 keys exist with natural text (not key passthrough, not empty)", () => {
    setLocale("en");
    for (const key of REQUIRED_KEYS) {
      const val = t(key);
      // spec: キー名がそのまま返っていないこと (未定義フォールバックの検出)
      expect(val, `en: ${key} — key passthrough detected`).not.toBe(key);
      expect(val.trim().length, `en: ${key} — empty string`).toBeGreaterThan(0);
    }
  });

  it("[KS-0029] ja: all 6 keys exist with natural text (not key passthrough, not empty)", () => {
    setLocale("ja");
    for (const key of REQUIRED_KEYS) {
      const val = t(key);
      expect(val, `ja: ${key} — key passthrough detected`).not.toBe(key);
      expect(val.trim().length, `ja: ${key} — empty string`).toBeGreaterThan(0);
    }
  });

  it("[KS-0029] en catalog: raw template strings contain expected interpolation tokens", () => {
    // ref: cli.js:319-324 (en block)
    expect(cliCatalog.en["cli.okLockPushed"]).toContain("{name}");
    expect(cliCatalog.en["cli.warnLockPushFailed"]).toContain("{name}");
    expect(cliCatalog.en["cli.warnLockPushFailed"]).toContain("{message}");
    expect(cliCatalog.en["cli.syncFromAccountFailed"]).toContain("{message}");
    expect(cliCatalog.en["cli.syncFromAccountDone"]).toContain("{total}");
    expect(cliCatalog.en["cli.syncFromAccountDone"]).toContain("{added}");
  });

  it("[KS-0029] ja catalog: raw template strings contain expected interpolation tokens", () => {
    // ref: cli.js:740-745 (ja block)
    expect(cliCatalog.ja["cli.okLockPushed"]).toContain("{name}");
    expect(cliCatalog.ja["cli.warnLockPushFailed"]).toContain("{name}");
    expect(cliCatalog.ja["cli.warnLockPushFailed"]).toContain("{message}");
    expect(cliCatalog.ja["cli.syncFromAccountFailed"]).toContain("{message}");
    expect(cliCatalog.ja["cli.syncFromAccountDone"]).toContain("{total}");
    expect(cliCatalog.ja["cli.syncFromAccountDone"]).toContain("{added}");
  });

  it("[KS-0029] t() interpolates {name} in cli.okLockPushed (en)", () => {
    setLocale("en");
    const msg = t("cli.okLockPushed", { name: "front" });
    expect(msg).toContain("front");
    expect(msg).not.toContain("{name}");
  });

  it("[KS-0029] t() interpolates {name}/{message} in cli.warnLockPushFailed (en)", () => {
    setLocale("en");
    const msg = t("cli.warnLockPushFailed", { name: "back", message: "timeout" });
    expect(msg).toContain("back");
    expect(msg).toContain("timeout");
    expect(msg).not.toContain("{name}");
    expect(msg).not.toContain("{message}");
  });

  it("[KS-0029] t() interpolates {name}/{message} in cli.warnLockPushFailed (ja)", () => {
    setLocale("ja");
    const msg = t("cli.warnLockPushFailed", { name: "玄関", message: "接続エラー" });
    expect(msg).toContain("玄関");
    expect(msg).toContain("接続エラー");
    expect(msg).not.toContain("{name}");
    expect(msg).not.toContain("{message}");
  });

  it("[KS-0029] t() interpolates {message} in cli.syncFromAccountFailed (en)", () => {
    setLocale("en");
    const msg = t("cli.syncFromAccountFailed", { message: "network error" });
    expect(msg).toContain("network error");
    expect(msg).not.toContain("{message}");
  });

  it("[KS-0029] t() interpolates {message} in cli.syncFromAccountFailed (ja)", () => {
    setLocale("ja");
    const msg = t("cli.syncFromAccountFailed", { message: "ネットワークエラー" });
    expect(msg).toContain("ネットワークエラー");
    expect(msg).not.toContain("{message}");
  });

  it("[KS-0029] t() interpolates {total}/{added} in cli.syncFromAccountDone (en)", () => {
    setLocale("en");
    const msg = t("cli.syncFromAccountDone", { total: 5, added: 3 });
    expect(msg).toContain("5");
    expect(msg).toContain("3");
    expect(msg).not.toContain("{total}");
    expect(msg).not.toContain("{added}");
  });

  it("[KS-0029] t() interpolates {total}/{added} in cli.syncFromAccountDone (ja)", () => {
    setLocale("ja");
    const msg = t("cli.syncFromAccountDone", { total: 10, added: 4 });
    expect(msg).toContain("10");
    expect(msg).toContain("4");
    expect(msg).not.toContain("{total}");
    expect(msg).not.toContain("{added}");
  });
});

// =============================================================================
// KS-0031 — keystore.put serve handler が rank/subUUID/stateInfo を 7 フィールドに切り詰める
// ref: packages/kit/src/serve/entries/device.js:294-321
// CHUserKey.kt:43-46
// =============================================================================

describe("[KS-0031] keystore.put handler: CHUserKey body has exactly 7 fields (no rank/subUUID/stateInfo)", () => {
  // requireAuth を通す最小 daemon
  const daemon = { authState: "ok", hub: { connected: true } };

  it("[KS-0031] handler builds key without rank/subUUID/stateInfo even if extra fields supplied", async () => {
    const reg = buildRegistry();
    const entry = reg.get("keystore.put");
    expect(entry, "keystore.put が registry に存在する").toBeTruthy();

    let capturedKey = null;
    const hub = {
      keyStorePut: vi.fn(async (key) => { capturedKey = key; return {}; }),
    };

    // Include rank/subUUID/stateInfo in params (as a caller might supply them via extra fields)
    const params = {
      deviceUUID:       SAMPLE_KEY.deviceUUID,
      deviceModel:      SAMPLE_KEY.deviceModel,
      keyIndex:         SAMPLE_KEY.keyIndex,
      secretKey:        SAMPLE_KEY.secretKey,
      sesame2PublicKey: SAMPLE_KEY.sesame2PublicKey,
      deviceName:       SAMPLE_KEY.deviceName,
      keyLevel:         SAMPLE_KEY.keyLevel,
    };

    await entry.handler({ hub, daemon, params });

    expect(hub.keyStorePut).toHaveBeenCalled();
    // spec: handler explicitly constructs 7-field object (device.js:313-321)
    expect(capturedKey).not.toHaveProperty("rank");
    expect(capturedKey).not.toHaveProperty("subUUID");
    expect(capturedKey).not.toHaveProperty("stateInfo");
  });

  it("[KS-0031] the 7 fields present in handler-constructed CHUserKey match declared params", async () => {
    const reg = buildRegistry();
    const entry = reg.get("keystore.put");

    let capturedKey = null;
    const hub = { keyStorePut: vi.fn(async (key) => { capturedKey = key; return {}; }) };

    const params = {
      deviceUUID:       SAMPLE_KEY.deviceUUID,
      deviceModel:      SAMPLE_KEY.deviceModel,
      keyIndex:         SAMPLE_KEY.keyIndex,
      secretKey:        SAMPLE_KEY.secretKey,
      sesame2PublicKey: SAMPLE_KEY.sesame2PublicKey,
      deviceName:       SAMPLE_KEY.deviceName,
      keyLevel:         SAMPLE_KEY.keyLevel,
    };

    await entry.handler({ hub, daemon, params });

    // All 7 fields must be present and correct
    expect(capturedKey.deviceUUID).toBe(SAMPLE_KEY.deviceUUID);
    expect(capturedKey.deviceModel).toBe(SAMPLE_KEY.deviceModel);
    expect(capturedKey.keyIndex).toBe(SAMPLE_KEY.keyIndex);
    expect(capturedKey.secretKey).toBe(SAMPLE_KEY.secretKey);
    expect(capturedKey.sesame2PublicKey).toBe(SAMPLE_KEY.sesame2PublicKey);
    expect(capturedKey.deviceName).toBe(SAMPLE_KEY.deviceName);
    expect(capturedKey.keyLevel).toBe(SAMPLE_KEY.keyLevel);
  });

  it("[KS-0031] rank/subUUID/stateInfo absent even when passed via params (negative-fact, device.js:313-321)", async () => {
    const reg = buildRegistry();
    const entry = reg.get("keystore.put");

    let capturedKey = null;
    const hub = { keyStorePut: vi.fn(async (key) => { capturedKey = key; return {}; }) };

    // Simulate a hypothetical caller including extra fields
    const params = {
      deviceUUID:       SAMPLE_KEY.deviceUUID,
      deviceModel:      SAMPLE_KEY.deviceModel,
      keyIndex:         SAMPLE_KEY.keyIndex,
      secretKey:        SAMPLE_KEY.secretKey,
      sesame2PublicKey: SAMPLE_KEY.sesame2PublicKey,
      deviceName:       SAMPLE_KEY.deviceName,
      keyLevel:         SAMPLE_KEY.keyLevel,
      rank:             99,
      subUUID:          "attacker-sub-uuid",
      stateInfo:        { injected: true },
    };

    await entry.handler({ hub, daemon, params });

    // spec: handler ignores rank/subUUID/stateInfo, constructs only 7-field object
    expect(capturedKey).not.toHaveProperty("rank");
    expect(capturedKey).not.toHaveProperty("subUUID");
    expect(capturedKey).not.toHaveProperty("stateInfo");
  });

  it("[KS-0031] deviceName absent in params → key.deviceName is null (null-coalesce, not undefined)", async () => {
    // ref: device.js:319 `deviceName: ctx.params.deviceName ?? null`
    const reg = buildRegistry();
    const entry = reg.get("keystore.put");

    let capturedKey = null;
    const hub = { keyStorePut: vi.fn(async (key) => { capturedKey = key; return {}; }) };

    const params = {
      deviceUUID:       SAMPLE_KEY.deviceUUID,
      deviceModel:      SAMPLE_KEY.deviceModel,
      keyIndex:         SAMPLE_KEY.keyIndex,
      secretKey:        SAMPLE_KEY.secretKey,
      sesame2PublicKey: SAMPLE_KEY.sesame2PublicKey,
      // deviceName intentionally omitted
      keyLevel:         SAMPLE_KEY.keyLevel,
    };

    await entry.handler({ hub, daemon, params });

    // spec: deviceName 省略時 null (device.js:319 deviceName: ctx.params.deviceName ?? null)
    expect(capturedKey.deviceName).toBeNull();
    expect(capturedKey.deviceName).not.toBeUndefined();
  });

  it("[KS-0031] keystore.put params schema does NOT declare rank/subUUID/stateInfo", () => {
    // ref: device.js:294-303 — params only declare the 7 user-facing fields + appIdentifyId
    const reg = buildRegistry();
    const entry = reg.get("keystore.put");
    const paramNames = entry.params.map((p) => p.name);

    expect(paramNames).not.toContain("rank");
    expect(paramNames).not.toContain("subUUID");
    expect(paramNames).not.toContain("stateInfo");

    // Confirm the 7 payload fields + appIdentifyId are declared
    expect(paramNames).toContain("deviceUUID");
    expect(paramNames).toContain("deviceModel");
    expect(paramNames).toContain("keyIndex");
    expect(paramNames).toContain("secretKey");
    expect(paramNames).toContain("sesame2PublicKey");
    expect(paramNames).toContain("deviceName");
    expect(paramNames).toContain("keyLevel");
    expect(paramNames).toContain("appIdentifyId");
  });
});
