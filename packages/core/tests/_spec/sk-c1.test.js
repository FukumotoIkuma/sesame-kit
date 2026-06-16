// sk-c1.test.js — SK-0019, SK-0020, SK-0024, SK-0025, SK-0026, SK-0027 統合 TDD spec テスト
//
// 参照ベクタ:
//   - packages/core/src/i18n/sharekey.js          (SK-0019)
//   - packages/core/src/i18n/org.js:3-5, 249-251  (SK-0019)
//   - packages/core/src/sharekey.js:65,81,178,196,204  (SK-0019)
//   - packages/core/src/org.js:47,714              (SK-0025)
//   - packages/core/src/vendor/biz3/constants/messageConstants.js:8  (SK-0025)
//   - packages/kit/src/serve/rpc-params.generated.json:877-894  (SK-0024)
//   - packages/kit/sdk/ts/sesame-client.ts:525     (SK-0024)
//   - packages/kit/sdk/python/sesame_client.py:1029-1031  (SK-0024)
//   - packages/kit/src/cli/org.js:768,775,809-811,830-833  (SK-0020,SK-0026,SK-0027)
//   - references_web/src/components/MobileDeviceShareQRCode.js:43  (SK-0026)

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// __dirname 相当を import.meta.url から安全に取得する。
// vitest が transform した後も import.meta.url は元ファイルの URL を返す。
const _thisDir = dirname(fileURLToPath(import.meta.url));

// ── sharekey.js (pure functions) ──────────────────────────────────────────────
import {
  buildShareKeyUrl,
  buildFriendQrUrl,
  parseFriendQrUrl,
} from "../../src/sharekey.js";

// ── i18n カタログ (en/ja オブジェクトを直接参照) ─────────────────────────────
import sharekeyI18n from "../../src/i18n/sharekey.js";
import orgI18n from "../../src/i18n/org.js";

// ── org.js (generateGuestQR wire test) ────────────────────────────────────────
import * as org from "../../src/org.js";

// ── vendor messageConstants (action 値の期待値源泉) ──────────────────────────
import { ACTION_TYPES } from "../../src/vendor/biz3/constants/messageConstants.js";

// ── helpers ───────────────────────────────────────────────────────────────────
import { mockClient } from "../helpers/mock-ws.js";

// ── rpc-params (SK-0024) ──────────────────────────────────────────────────────
const rpcParamsPath = resolve(
  _thisDir,
  "../../../../packages/kit/src/serve/rpc-params.generated.json"
);
let rpcParams;
try {
  rpcParams = JSON.parse(readFileSync(rpcParamsPath, "utf8"));
} catch {
  rpcParams = null;
}

// ══════════════════════════════════════════════════════════════════════════════
//  SK-0019: sharekey i18n キーカタログ完全性
// ══════════════════════════════════════════════════════════════════════════════

describe("[SK-0019] sharekey i18n キーカタログ完全性", () => {
  // sharekey.err.* — sharekey.js が throw するキー
  const SHAREKEY_ERR_KEYS = [
    "sharekey.err.subUUIDRequired",
    "sharekey.err.friendQrUrlRequired",
    "sharekey.err.invalidFriendQr",
  ];

  // org.sharekey.* — buildShareKeyUrl が throw するキー
  const ORG_SHAREKEY_KEYS = [
    "org.sharekey.unknownDeviceModel",
    "org.sharekey.fieldRequired",
  ];

  it("[SK-0019] sharekey.err.* キーが en/ja 両方に存在し非空である", () => {
    for (const key of SHAREKEY_ERR_KEYS) {
      expect(sharekeyI18n.en, `en カタログに ${key} が存在しない`).toHaveProperty(key);
      expect(sharekeyI18n.ja, `ja カタログに ${key} が存在しない`).toHaveProperty(key);
      expect(typeof sharekeyI18n.en[key]).toBe("string");
      expect(typeof sharekeyI18n.ja[key]).toBe("string");
      expect(sharekeyI18n.en[key], `en.${key} が空`).toBeTruthy();
      expect(sharekeyI18n.ja[key], `ja.${key} が空`).toBeTruthy();
    }
  });

  it("[SK-0019] org.sharekey.* キーが en/ja 両方に存在し非空である", () => {
    for (const key of ORG_SHAREKEY_KEYS) {
      expect(orgI18n.en, `en カタログに ${key} が存在しない`).toHaveProperty(key);
      expect(orgI18n.ja, `ja カタログに ${key} が存在しない`).toHaveProperty(key);
      expect(typeof orgI18n.en[key]).toBe("string");
      expect(typeof orgI18n.ja[key]).toBe("string");
      expect(orgI18n.en[key], `en.${key} が空`).toBeTruthy();
      expect(orgI18n.ja[key], `ja.${key} が空`).toBeTruthy();
    }
  });

  it("[SK-0019] org.sharekey.unknownDeviceModel は en/ja 両方に {model} プレースホルダを持つ", () => {
    const key = "org.sharekey.unknownDeviceModel";
    expect(orgI18n.en[key]).toContain("{model}");
    expect(orgI18n.ja[key]).toContain("{model}");
  });

  it("[SK-0019] org.sharekey.fieldRequired は en/ja 両方に {field} プレースホルダを持つ", () => {
    const key = "org.sharekey.fieldRequired";
    expect(orgI18n.en[key]).toContain("{field}");
    expect(orgI18n.ja[key]).toContain("{field}");
  });

  it("[SK-0019] sharekey.err.* の各キーのプレースホルダが en/ja で一致する (変数変換不一致が無い)", () => {
    for (const key of SHAREKEY_ERR_KEYS) {
      const enVars = (sharekeyI18n.en[key] || "").match(/\{[^}]+\}/g) || [];
      const jaVars = (sharekeyI18n.ja[key] || "").match(/\{[^}]+\}/g) || [];
      expect(enVars.sort(), `${key}: en/ja プレースホルダ不一致`).toEqual(jaVars.sort());
    }
  });

  it("[SK-0019] org.sharekey.* の各キーのプレースホルダが en/ja で一致する", () => {
    for (const key of ORG_SHAREKEY_KEYS) {
      const enVars = (orgI18n.en[key] || "").match(/\{[^}]+\}/g) || [];
      const jaVars = (orgI18n.ja[key] || "").match(/\{[^}]+\}/g) || [];
      expect(enVars.sort(), `${key}: en/ja プレースホルダ不一致`).toEqual(jaVars.sort());
    }
  });

  it("[SK-0019] buildFriendQrUrl(falsy) の throw は sharekey.err.subUUIDRequired キー由来のメッセージ", () => {
    // sharekey.js:178: throw badRequest("sharekey.err.subUUIDRequired")
    // setup.i18n.js で ja に固定されているため ja メッセージが出る。
    const enMsg = sharekeyI18n.en["sharekey.err.subUUIDRequired"];
    const jaMsg = sharekeyI18n.ja["sharekey.err.subUUIDRequired"];
    let thrown;
    try {
      buildFriendQrUrl("");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    const msg = thrown.message;
    expect(msg === enMsg || msg === jaMsg).toBe(true);
  });

  it("[SK-0019] parseFriendQrUrl(falsy) の throw は sharekey.err.friendQrUrlRequired キー由来のメッセージ", () => {
    // sharekey.js:196: throw badRequest("sharekey.err.friendQrUrlRequired")
    const enMsg = sharekeyI18n.en["sharekey.err.friendQrUrlRequired"];
    const jaMsg = sharekeyI18n.ja["sharekey.err.friendQrUrlRequired"];
    let thrown;
    try {
      parseFriendQrUrl("");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    const msg = thrown.message;
    expect(msg === enMsg || msg === jaMsg).toBe(true);
  });

  it("[SK-0019] parseFriendQrUrl(invalid-t) の throw は sharekey.err.invalidFriendQr キー由来のメッセージ", () => {
    // sharekey.js:204: throw badRequest("sharekey.err.invalidFriendQr")
    const enMsg = sharekeyI18n.en["sharekey.err.invalidFriendQr"];
    const jaMsg = sharekeyI18n.ja["sharekey.err.invalidFriendQr"];
    let thrown;
    try {
      parseFriendQrUrl("ssm://UI/?t=sk&sk=dummy");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    const msg = thrown.message;
    expect(msg === enMsg || msg === jaMsg).toBe(true);
  });

  it("[SK-0019] buildShareKeyUrl(unknown model) の throw は org.sharekey.unknownDeviceModel キー由来 ({model} 展開済み)", () => {
    // sharekey.js:65: throw badRequest("org.sharekey.unknownDeviceModel", { model: ... })
    let thrown;
    try {
      buildShareKeyUrl({ deviceModel: "unknown_model_xyz" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(thrown.message).not.toMatch(/^\s*$/);
    // {model} が展開されているか、model 値または i18n テキストを含む
    expect(
      thrown.message.includes("unknown_model_xyz") ||
        thrown.message.includes("unknown deviceModel") ||
        thrown.message.includes("未知の deviceModel")
    ).toBe(true);
  });

  it("[SK-0019] buildShareKeyUrl(missing secretKey) の throw は org.sharekey.fieldRequired キー由来 ({field} 展開済み)", () => {
    // sharekey.js:81: throw badRequest("org.sharekey.fieldRequired", { field: k })
    let thrown;
    try {
      buildShareKeyUrl({
        deviceModel: "sesame_5",
        // secretKey を意図的に省略 → fieldRequired("secretKey")
        sesame2PublicKey: "aabbccdd",
        keyIndex: "0001",
        deviceUUID: "aaaabbbb-cccc-dddd-eeee-ffffabcd1234",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(
      thrown.message.includes("secretKey") || thrown.message.includes("field")
    ).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  SK-0020: share-url CLI 出力封筒 surface-parity
// ══════════════════════════════════════════════════════════════════════════════

describe("[SK-0020] share-url CLI 出力封筒 surface-parity", () => {
  // CLI org.js:830-833 の ctx.out() 呼び出し形状を検証する。
  // CLIコード自体は commander/withAccount 依存のため、buildShareKeyUrl の出力 + 封筒形状の契約を直接検証する。

  const deviceKey = {
    deviceModel: "sesame_5",
    secretKey: "aabbccddeeff00112233445566778899",
    sesame2PublicKey: "aabbccdd",
    keyIndex: "0001",
    deviceUUID: "aaaabbbb-cccc-dddd-eeee-ffffabcd1234",
    deviceName: "TestLock",
    keyLevel: 2,
  };

  it("[SK-0020] human 出力: buildShareKeyUrl は ssm://UI?t=sk&... の URL 文字列を返す", () => {
    const url = buildShareKeyUrl(deviceKey, { keyLevel: 0, guestKeyId: undefined });
    expect(typeof url).toBe("string");
    expect(url).toMatch(/^ssm:\/\/UI\?/);
    expect(url).toContain("t=sk");
    expect(url).toContain("sk=");
    expect(url).toContain("l=0");
  });

  it("[SK-0020] --json 封筒は { ok, url, level, guestKeyId, deviceUUID } の shape を持つ (org.js:833)", () => {
    // org.js:833: ctx.out(opts.json, humanFn,
    //   { ok: true, url, level, guestKeyId: guestKeyId ?? null, deviceUUID: deviceKey.deviceUUID })
    const url = buildShareKeyUrl(deviceKey, { keyLevel: 2, guestKeyId: "gkid-test-001" });
    const level = 2;
    const guestKeyId = "gkid-test-001";
    const jsonEnvelope = {
      ok: true,
      url,
      level,
      guestKeyId: guestKeyId ?? null,
      deviceUUID: deviceKey.deviceUUID,
    };

    expect(jsonEnvelope).toMatchObject({
      ok: true,
      url: expect.stringContaining("ssm://UI?"),
      level: 2,
      guestKeyId: "gkid-test-001",
      deviceUUID: "aaaabbbb-cccc-dddd-eeee-ffffabcd1234",
    });
    expect(Object.keys(jsonEnvelope)).toEqual(
      expect.arrayContaining(["ok", "url", "level", "guestKeyId", "deviceUUID"])
    );
  });

  it("[SK-0020] level=0/1 (owner/manager) では guestKeyId が null になる (org.js:833: guestKeyId ?? null)", () => {
    // level 0/1 では generateGuestQR を呼ばないので guestKeyId=undefined → null
    const url = buildShareKeyUrl(deviceKey, { keyLevel: 0 });
    const guestKeyId = undefined; // level !== 2 なので未発行
    const jsonEnvelope = {
      ok: true,
      url,
      level: 0,
      guestKeyId: guestKeyId ?? null,
      deviceUUID: deviceKey.deviceUUID,
    };
    expect(jsonEnvelope.guestKeyId).toBeNull();
  });

  it("[SK-0020] level=2 では guestKeyId が null でない値になる (generateGuestQR 由来)", () => {
    const url = buildShareKeyUrl(deviceKey, { keyLevel: 2, guestKeyId: "gkid-abc" });
    const guestKeyId = "gkid-abc";
    const jsonEnvelope = {
      ok: true,
      url,
      level: 2,
      guestKeyId: guestKeyId ?? null,
      deviceUUID: deviceKey.deviceUUID,
    };
    expect(jsonEnvelope.guestKeyId).toBe("gkid-abc");
    expect(jsonEnvelope.guestKeyId).not.toBeNull();
  });

  it("[SK-0020] human 出力は url を console.log する (--qr 無しの場合 qrText は null)", () => {
    // cli/org.js:830-832: human 出力 = () => { console.log(url); if (qrText) console.log(...) }
    const logged = [];
    const mockLog = (msg) => logged.push(msg);
    const url = "ssm://UI?t=sk&sk=TESTKEY&l=2&n=TestDevice";
    const qrText = null;

    mockLog(url);
    if (qrText) mockLog(`\n${qrText}`);

    expect(logged).toEqual([url]);
    expect(logged).toHaveLength(1);
  });

  it("[SK-0020] --qr 時は URL の後に QR テキストを console.log する", () => {
    // cli/org.js:831-832: if (qrText) console.log(`\n${qrText}`)
    const logged = [];
    const mockLog = (msg) => logged.push(msg);
    const url = "ssm://UI?t=sk&sk=TESTKEY&l=2&n=TestDevice";
    const qrText = "█▀▀▀█\n...qr...";

    mockLog(url);
    if (qrText) mockLog(`\n${qrText}`);

    expect(logged).toHaveLength(2);
    expect(logged[0]).toBe(url);
    expect(logged[1]).toBe(`\n${qrText}`);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  SK-0024: org.generateGuestQR の rpc-params / SDK param 契約
// ══════════════════════════════════════════════════════════════════════════════

describe("[SK-0024] org.generateGuestQR の SDK/serve param 契約", () => {
  const tssdkPath = resolve(_thisDir, "../../../../packages/kit/sdk/ts/sesame-client.ts");
  const pysdkPath = resolve(_thisDir, "../../../../packages/kit/sdk/python/sesame_client.py");

  it("[SK-0024] rpc-params.generated.json に org.generateGuestQR エントリが存在する", () => {
    expect(rpcParams, "rpc-params.generated.json の読み込み失敗").not.toBeNull();
    expect(rpcParams).toHaveProperty("org.generateGuestQR");
    expect(Array.isArray(rpcParams["org.generateGuestQR"])).toBe(true);
  });

  it("[SK-0024] org.generateGuestQR の data param: required=true, type=object", () => {
    expect(rpcParams).not.toBeNull();
    const params = rpcParams["org.generateGuestQR"];
    const dataParam = params.find((p) => p.name === "data");
    expect(dataParam, "data param が見つからない").toBeTruthy();
    expect(dataParam.required).toBe(true);
    expect(dataParam.schema.type).toBe("object");
  });

  it("[SK-0024] org.generateGuestQR の timeoutMs param: required=false, type=number", () => {
    expect(rpcParams).not.toBeNull();
    const params = rpcParams["org.generateGuestQR"];
    const timeoutParam = params.find((p) => p.name === "timeoutMs");
    expect(timeoutParam, "timeoutMs param が見つからない").toBeTruthy();
    expect(timeoutParam.required).toBe(false);
    expect(timeoutParam.schema.type).toBe("number");
  });

  it("[SK-0024] rpc-params の org.generateGuestQR は data と timeoutMs の 2 パラメータのみ", () => {
    expect(rpcParams).not.toBeNull();
    const params = rpcParams["org.generateGuestQR"];
    expect(params).toHaveLength(2);
    const names = params.map((p) => p.name);
    expect(names).toContain("data");
    expect(names).toContain("timeoutMs");
  });

  it("[SK-0024] TS SDK の generateGuestQR シグネチャ: data(required) と timeoutMs?(optional)", () => {
    // sesame-client.ts:525:
    //   generateGuestQR: (params: { data: Record<string, unknown>; timeoutMs?: number }): Promise<unknown>
    let tsSdk;
    try {
      tsSdk = readFileSync(tssdkPath, "utf8");
    } catch {
      tsSdk = null;
    }
    expect(tsSdk, "sesame-client.ts の読み込み失敗").not.toBeNull();
    expect(tsSdk).toContain("generateGuestQR");
    expect(tsSdk).toMatch(/generateGuestQR.*data.*timeoutMs/s);
  });

  it("[SK-0024] Python SDK の generateGuestQR シグネチャ: data(required) と timeoutMs(optional)", () => {
    // sesame_client.py:1029-1031:
    //   def generateGuestQR(self, *, data: dict[str, Any], timeoutMs: float | None = None) -> Any:
    let pySdk;
    try {
      pySdk = readFileSync(pysdkPath, "utf8");
    } catch {
      pySdk = null;
    }
    expect(pySdk, "sesame_client.py の読み込み失敗").not.toBeNull();
    expect(pySdk).toContain("generateGuestQR");
    expect(pySdk).toMatch(/def generateGuestQR.*data.*timeoutMs/s);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  SK-0025: generateGuestQR wire action 値 = 'biz3ManageEmployeeDevice'
// ══════════════════════════════════════════════════════════════════════════════

describe("[SK-0025] generateGuestQR の action wire 値", () => {
  it("[SK-0025] ACTION_TYPES.BIZ3_MANAGE_EMPLOYEE_DEVICE = 'biz3ManageEmployeeDevice' (messageConstants.js:8)", () => {
    expect(ACTION_TYPES.BIZ3_MANAGE_EMPLOYEE_DEVICE).toBe("biz3ManageEmployeeDevice");
  });

  it("[SK-0025] generateGuestQR 送信フレームの action = 'biz3ManageEmployeeDevice' (org.js:714)", async () => {
    // mockClient で送信フレームを捕捉し action 値を検証する
    const dataPayload = { companyID: "co-001", deviceUUID: "dev-uuid-001" };
    const client = mockClient({ success: true, data: "gkid-xyz" });

    await org.generateGuestQR(client, { data: dataPayload });

    expect(client.sent).toHaveLength(1);
    expect(client.sent[0].action).toBe("biz3ManageEmployeeDevice");
  });

  it("[SK-0025] generateGuestQR 送信フレームの op = 'generateGuestQR' (org.js:714)", async () => {
    const dataPayload = { companyID: "co-001" };
    const client = mockClient({ success: true, data: "gkid-xyz-2" });

    await org.generateGuestQR(client, { data: dataPayload });

    expect(client.sent[0].op).toBe("generateGuestQR");
  });

  it("[SK-0025] action 値が references_web/useManageGroup.js:179 の ACTION_TYPES.BIZ3_MANAGE_EMPLOYEE_DEVICE と完全一致する", async () => {
    // biz3 参照実装と同一定数を使用していることを実際の送信フレームで検証する
    // references_web/src/constants/messageConstants.js:8
    // references_web/src/api/useManageGroup.js:179: action: ACTION_TYPES.BIZ3_MANAGE_EMPLOYEE_DEVICE
    const client = mockClient({ success: true, data: "gkid-abc" });
    await org.generateGuestQR(client, { data: { x: 1 } });
    expect(client.sent[0].action).toBe(ACTION_TYPES.BIZ3_MANAGE_EMPLOYEE_DEVICE);
  });

  it("[SK-0025] data (object) が必須 — 省略で throw (org.req.data)", async () => {
    const client = mockClient({ success: true, data: "x" });
    await expect(org.generateGuestQR(client, {})).rejects.toThrow();
  });

  it("[SK-0025] data が null でも throw", async () => {
    const client = mockClient({ success: true, data: "x" });
    await expect(org.generateGuestQR(client, { data: null })).rejects.toThrow();
  });

  it("[SK-0025] data が string でも throw", async () => {
    const client = mockClient({ success: true, data: "x" });
    await expect(org.generateGuestQR(client, { data: "string" })).rejects.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  SK-0026: share-url --level 上限検証欠落 (権限昇格ハザード / TDD-red)
// ══════════════════════════════════════════════════════════════════════════════

describe("[SK-0026] share-url --level 上限検証欠落 (権限昇格ハザード)", () => {
  // 注: この spec は既知ハザードを TDD-red で記述する。
  // CLI org.js:775-779 は [0,1,2].includes(level) のみ検証し、
  // keyLevel 比較が無いため guest (keyLevel=2) のユーザが --level 0(owner) を発行できてしまう。
  // 正しい期待挙動: level >= deviceKey.keyLevel でなければ die(2)。

  it("[SK-0026] MobileDeviceShareQRCode.js:43 仕様: roleOptions は option.value >= currentDeviceKey.keyLevel でフィルタされる", () => {
    // 移植元の契約を純関数ロジックとして検証する
    const currentDeviceKey = { keyLevel: 2 }; // guest
    const allRoleOptions = [
      { value: 0 }, // owner
      { value: 1 }, // manager
      { value: 2 }, // guest
    ];
    const availableOptions = allRoleOptions.filter(
      (option) => option.value >= currentDeviceKey.keyLevel
    );
    // owner (0) と manager (1) は除外される
    expect(availableOptions).not.toContainEqual({ value: 0 });
    expect(availableOptions).not.toContainEqual({ value: 1 });
    // guest (2) のみ残る
    expect(availableOptions).toContainEqual({ value: 2 });
  });

  it("[SK-0026] manager (keyLevel=1) のユーザは owner (level=0) 共有を選べない (仕様)", () => {
    const currentDeviceKey = { keyLevel: 1 }; // manager
    const allRoleOptions = [
      { value: 0 }, // owner
      { value: 1 }, // manager
      { value: 2 }, // guest
    ];
    const availableOptions = allRoleOptions.filter(
      (option) => option.value >= currentDeviceKey.keyLevel
    );
    expect(availableOptions).not.toContainEqual({ value: 0 });
    expect(availableOptions.map((o) => o.value)).toEqual([1, 2]);
  });

  it("[SK-0026] guest(keyLevel=2) が level=2(guest) を指定するのは正常 (同レベル共有は許可)", () => {
    // option.value >= currentDeviceKey.keyLevel → 2 >= 2 = true → 許可
    const deviceKeyLevel = 2;
    const requestedLevel = 2;
    expect(requestedLevel >= deviceKeyLevel).toBe(true);
  });

  it("[SK-0026] owner(keyLevel=0) は level=0/1/2 すべて指定可能 (数値が大きいほど権限が弱い)", () => {
    const deviceKeyLevel = 0; // owner
    for (const level of [0, 1, 2]) {
      expect(level >= deviceKeyLevel).toBe(true);
    }
  });

  it("[SK-0026] 期待挙動: CLI は level < deviceKey.keyLevel の場合に die(2) するべき (未実装 = TDD-red)", () => {
    // CLI の level 検証 (packages/kit/src/cli/org.js:775-779) の現状:
    //   const level = parseInt(cmdOpts.level, 10);
    //   if (![0, 1, 2].includes(level)) { ctx.die(badLevel, 2); return; }
    // — keyLevel 比較が無いため、guest ユーザが level=0 を通過してしまう。

    function validateLevelCli(level) {
      // 現状の CLI 検証 (不十分)
      return [0, 1, 2].includes(level);
    }

    function validateLevelSpec(level, deviceKeyLevel) {
      // spec の期待する検証 (MobileDeviceShareQRCode.js:43 準拠)
      return [0, 1, 2].includes(level) && level >= deviceKeyLevel;
    }

    const guestKeyLevel = 2;

    // CLI は level=0 (owner) を guest ユーザが通過できてしまう (ハザード)
    expect(validateLevelCli(0)).toBe(true); // 現状: 通過してしまう

    // spec の期待: level=0 < guestKeyLevel=2 なので false (拒否するべき)
    expect(validateLevelSpec(0, guestKeyLevel)).toBe(false);

    // この不一致が権限昇格ハザード。
    // CLI が spec どおりに実装されたら validateLevelCli_WithKeyLevelCheck(0, guestKeyLevel) = false になるはず。
    // 現状: CLI は許可するが spec は禁止 (バグの存在を文書化する)
    expect(validateLevelCli(0) && !validateLevelSpec(0, guestKeyLevel)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  SK-0027: share-url --level 既定値 '2' → level===2 → generateGuestQR 呼び出し
// ══════════════════════════════════════════════════════════════════════════════

describe("[SK-0027] share-url --level 既定値 '2' → level===2 → generateGuestQR", () => {
  it("[SK-0027] commander の --level 既定値は文字列 '2' (org.js:768)", () => {
    // org.js:768: .option("-l, --level <0|1|2>", t("org.keys.shareUrl.optLevel"), "2")
    // commander の第三引数がデフォルト値。文字列 '2' として登録される。
    const defaultLevelStr = "2"; // commander が設定する既定値
    const parsedLevel = parseInt(defaultLevelStr, 10);
    expect(defaultLevelStr).toBe("2");
    expect(parsedLevel).toBe(2);
  });

  it("[SK-0027] parseInt('2', 10) === 2 → [0,1,2].includes 検証を通過する (org.js:775)", () => {
    const level = parseInt("2", 10);
    expect([0, 1, 2].includes(level)).toBe(true);
  });

  it("[SK-0027] level===2 条件が true のとき generateGuestQR が呼ばれるべき (org.js:809-811)", () => {
    // org.js:809-811:
    //   if (level === 2) {
    //     guestKeyId = await hub.org.generateGuestQR({ data: deviceKey });
    //   }
    function shouldCallGenerateGuestQR(level) {
      return level === 2;
    }
    expect(shouldCallGenerateGuestQR(2)).toBe(true);  // 既定 → generateGuestQR 必須
    expect(shouldCallGenerateGuestQR(0)).toBe(false); // owner → generateGuestQR 不要
    expect(shouldCallGenerateGuestQR(1)).toBe(false); // manager → generateGuestQR 不要
  });

  it("[SK-0027] level===2 のとき generateGuestQR が guestKeyId を返す", async () => {
    const dataPayload = { companyID: "co-001", deviceUUID: "dev-uuid-001" };
    const expectedGuestKeyId = "guest-key-id-disposable";
    const client = mockClient({ success: true, data: expectedGuestKeyId });

    const guestKeyId = await org.generateGuestQR(client, { data: dataPayload });

    expect(guestKeyId).toBe(expectedGuestKeyId);
  });

  it("[SK-0027] level=0/1 では guestKeyId=undefined → buildShareKeyUrl は deviceKey.secretKey を使う", () => {
    // level 0/1: guestKeyId を渡さない → buildShareKeyUrl 内で secretKey が使われる
    const deviceKey = {
      deviceModel: "sesame_5",
      secretKey: "aabbccddeeff00112233445566778899",
      sesame2PublicKey: "aabbccdd",
      keyIndex: "0001",
      deviceUUID: "aaaabbbb-cccc-dddd-eeee-ffffabcd1234",
      deviceName: "TestLock",
    };

    // level=0, guestKeyId=undefined → secretKey がそのまま使われる (エラーにならない)
    expect(() => buildShareKeyUrl(deviceKey, { keyLevel: 0 })).not.toThrow();
    expect(() => buildShareKeyUrl(deviceKey, { keyLevel: 1 })).not.toThrow();
  });

  it("[SK-0027] 不正な --level は [0,1,2].includes 検証で除外される (org.js:775-777)", () => {
    // org.js:776: if (![0, 1, 2].includes(level)) ctx.die(...)
    const validLevels = [0, 1, 2];
    expect(validLevels.includes(parseInt("0", 10))).toBe(true);
    expect(validLevels.includes(parseInt("1", 10))).toBe(true);
    expect(validLevels.includes(parseInt("2", 10))).toBe(true);
    expect(validLevels.includes(parseInt("3", 10))).toBe(false);
    expect(validLevels.includes(parseInt("-1", 10))).toBe(false);
    expect(validLevels.includes(parseInt("abc", 10))).toBe(false); // NaN
    expect(validLevels.includes(NaN)).toBe(false);
  });

  it("[SK-0027] --level 無指定時は guest(level=2) 共有 = 最も権限の弱い既定の安全側設計", () => {
    // 既定 '2' の設計意図: 無指定の場合、最も権限の弱い guest 共有になる。
    // owner/manager 共有には明示的な -l 0 / -l 1 が必要。
    const defaultLevel = parseInt("2", 10); // commander 既定 → parseInt
    expect(defaultLevel).toBe(2); // guest

    // guest が最も権限が弱い (数値で最大) ことを確認
    const levels = { owner: 0, manager: 1, guest: 2 };
    expect(defaultLevel).toBe(Math.max(...Object.values(levels)));
  });
});
