// packages/core/tests/_spec/org-c5.test.js
//
// TDD spec テスト: ORG-0091 ~ ORG-0108 (18件) 統合版
//
// 対象実装:
//   packages/core/src/org.js        — updateGuestKeyTag / generateGuestQR / getDeviceEmployeeKeys / NAMESPACE_OPS
//   packages/kit/src/cli/org.js     — keys update-guest-tag / generate-guest-qr / device / share-url
//                                     device-group add (--uuids)
//   packages/kit/src/serve/grpc-methods.generated.json
//   packages/kit/src/serve/rpc-params.generated.json
//   packages/core/src/i18n/org.js   — i18n カタログ
//
// 採用方針:
//   - A/B 双方を比較し、spec に対してより忠実な方を採用。
//   - JSON ファイル (grpc-methods / rpc-params) は it() 内で動的 import (org-c0.test.js 準拠)。
//   - CLI テストは org-role-keys.test.js と同一の makeCtx/buildProgram パターン。
//   - 実装バグ疑い箇所 (ORG-0100) は spec どおりの正しい期待値を assert (red 許容 / TDD)。

import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";

import * as org from "../../src/org.js";
import { mockClient } from "../helpers/mock-ws.js";
import { registerOrgCommands } from "../../../kit/src/cli/org.js";
import i18n from "../../src/i18n/org.js";

// ─── CLI テスト共通ヘルパー (org-role-keys.test.js と同一形) ──────────────────

/** fake ctx。withAccount は即 fn(hub, {opts}) を呼ぶ。human 出力 (humanFn) を必ず実行する。 */
function makeCtx({ hub, json = false } = {}) {
  const outputs = [];
  const ctx = {
    outputs,
    out: (isJson, humanFn, jsonObj) => {
      outputs.push(jsonObj);
      if (!isJson) humanFn();
    },
    die: (msg, code) => {
      const e = new Error(msg);
      /** @type {any} */ (e).exitCode = code;
      throw e;
    },
    canPrompt: () => false,
    withHub: (fn) => fn(hub, { opts: { json } }),
    withAccount: (fn) => fn(hub, { opts: { json } }),
    prompts: {
      selectFromList: vi.fn(),
      promptText: vi.fn(),
      confirm: vi.fn(),
      promptLine: vi.fn(),
    },
    parseJson: (raw) => JSON.parse(raw),
  };
  return ctx;
}

function buildProgram(ctx) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerOrgCommands(program, ctx);
  return program;
}

afterEach(() => vi.restoreAllMocks());

// ════════════════════════════════════════════════════════════════════════════
// ORG-0091 — updateGuestKeyTag wire: {action, ...data, op:'updateGuestTag'}
// ref: packages/core/src/org.js:689-697
//      references_web/src/api/useManageGroup.js:163-174
//      references_web/src/components/DeviceUserList.js:146-151
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0091] updateGuestKeyTag wire: {action, ...data, op:'updateGuestTag'}", () => {
  it("[ORG-0091] data={deviceUUID,guestKeyId,keyName} を spread し action=biz3ManageEmployeeDevice / op='updateGuestTag' で送る", async () => {
    const c = mockClient({ success: true });
    const data = { deviceUUID: "d-1", guestKeyId: "g-1", keyName: "新タグ" };
    await org.updateGuestKeyTag(c, { data });
    expect(c.sent[0]).toEqual({
      action: "biz3ManageEmployeeDevice",
      deviceUUID: "d-1",
      guestKeyId: "g-1",
      keyName: "新タグ",
      op: "updateGuestTag",
    });
    // data フィールドは spread されるのでトップレベル 'data' キーは存在しない
    expect(c.sent[0]).not.toHaveProperty("data");
  });

  it("[ORG-0091] companyID をフレームに含めない (biz3ManageEmployeeDevice の companyID 無し規約)", async () => {
    const c = mockClient({ success: true });
    await org.updateGuestKeyTag(c, { data: { deviceUUID: "d-1", guestKeyId: "g-1", keyName: "tag" } });
    expect(c.sent[0]).not.toHaveProperty("companyID");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0092 — updateGuestKeyTag error-path: data 非object / CLI --json 欠落
// ref: packages/core/src/org.js:690
//      packages/kit/src/cli/org.js:723-740
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0092] updateGuestKeyTag error-path", () => {
  it("[ORG-0092] core: data が null のとき badRequest('org.req.data') を throw (送信しない)", async () => {
    const c = mockClient({});
    await expect(org.updateGuestKeyTag(c, { data: null })).rejects.toThrow(/data required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0092] core: data が文字列(非 object)のとき badRequest を throw", async () => {
    const c = mockClient({});
    await expect(org.updateGuestKeyTag(c, { data: "not-an-object" })).rejects.toThrow(/data required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0092] CLI: --json 欠落のとき die(2) し updateGuestKeyTag を呼ばない", async () => {
    const updateGuestKeyTag = vi.fn();
    const hub = { org: { updateGuestKeyTag } };
    const ctx = makeCtx({ hub });
    await expect(
      buildProgram(ctx).parseAsync(["org", "keys", "update-guest-tag"], { from: "user" }),
    ).rejects.toThrow();
    expect(updateGuestKeyTag).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0093 — generateGuestQR wire: deviceKey 全体を spread op:'generateGuestQR'
// ref: packages/core/src/org.js:711-718
//      references_web/src/api/useManageGroup.js:176-187
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0093] generateGuestQR wire: deviceKey 全体 spread + resp.data(guestKeyId) を返す", () => {
  it("[ORG-0093] data(deviceKey)を spread し op='generateGuestQR'、resp.data を返す", async () => {
    const c = mockClient({ success: true, data: "GUEST_KEY_ID_123" });
    const data = {
      deviceUUID: "d-1",
      secretKey: "sk",
      sesame2PublicKey: "pk",
      keyIndex: "00",
      deviceModel: "sesame_5",
    };
    const result = await org.generateGuestQR(c, { data });
    expect(c.sent[0]).toEqual({
      action: "biz3ManageEmployeeDevice",
      deviceUUID: "d-1",
      secretKey: "sk",
      sesame2PublicKey: "pk",
      keyIndex: "00",
      deviceModel: "sesame_5",
      op: "generateGuestQR",
    });
    // data フィールドは spread → トップレベル 'data' キーは存在しない
    expect(c.sent[0]).not.toHaveProperty("data");
    // 戻り値は resp.data (guestKeyId 文字列)
    expect(result).toBe("GUEST_KEY_ID_123");
  });

  it("[ORG-0093] companyID をフレームに含めない (biz3ManageEmployeeDevice 規約)", async () => {
    const c = mockClient({ success: true, data: "GID" });
    await org.generateGuestQR(c, { data: { deviceUUID: "d-1" } });
    expect(c.sent[0]).not.toHaveProperty("companyID");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0094 — generateGuestQR error-path: data 非object / success:false
// ref: packages/core/src/org.js:712 (data チェック)
//      packages/core/src/org.js:717 (assertSuccess)
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0094] generateGuestQR error-path", () => {
  it("[ORG-0094] data が null のとき badRequest('org.req.data') を throw (送信しない)", async () => {
    const c = mockClient({});
    await expect(org.generateGuestQR(c, { data: null })).rejects.toThrow(/data required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0094] data が非 object(数値)のとき badRequest を throw (送信しない)", async () => {
    const c = mockClient({});
    await expect(org.generateGuestQR(c, { data: 42 })).rejects.toThrow(/data required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0094] success:false の応答で 'generateGuestQR failed: <msg>' を throw", async () => {
    const c = mockClient({ success: false, message: "denied" });
    await expect(
      org.generateGuestQR(c, { data: { deviceUUID: "d-1" } }),
    ).rejects.toThrow(/generateGuestQR failed: denied/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0095 — CLI generate-guest-qr: --json 必須 / 出力封筒 {ok, guestKeyId}
// ref: packages/kit/src/cli/org.js:742-760
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0095] CLI generate-guest-qr surface", () => {
  it("[ORG-0095] --json 欠落で die(2) し generateGuestQR を呼ばない", async () => {
    const generateGuestQR = vi.fn();
    const hub = { org: { generateGuestQR } };
    const ctx = makeCtx({ hub });
    await expect(
      buildProgram(ctx).parseAsync(["org", "keys", "generate-guest-qr"], { from: "user" }),
    ).rejects.toThrow();
    expect(generateGuestQR).not.toHaveBeenCalled();
  });

  it("[ORG-0095] --json 指定時に generateGuestQR を呼び {ok,guestKeyId} 封筒を出力する", async () => {
    const generateGuestQR = vi.fn(async () => "GUESTKEY-999");
    const hub = { org: { generateGuestQR } };
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["org", "keys", "generate-guest-qr", "--json", '{"deviceUUID":"d-1","secretKey":"sk"}'],
      { from: "user" },
    );
    expect(generateGuestQR).toHaveBeenCalledOnce();
    expect(ctx.outputs[0]).toEqual({ ok: true, guestKeyId: "GUESTKEY-999" });
  });

  it("[ORG-0095] human 出力 (--json なし) では guestKeyId を console.log に出す", async () => {
    const generateGuestQR = vi.fn(async () => "GUESTKEY-ABC");
    const hub = { org: { generateGuestQR } };
    const ctx = makeCtx({ hub, json: false });
    const lines = [];
    vi.spyOn(console, "log").mockImplementation((s) => lines.push(String(s)));
    await buildProgram(ctx).parseAsync(
      ["org", "keys", "generate-guest-qr", "--json", '{"deviceUUID":"d-1"}'],
      { from: "user" },
    );
    // human 出力には guestKeyId が含まれる
    expect(lines.some((l) => l.includes("GUESTKEY-ABC"))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0096 — getDeviceEmployeeKeys wire: {action:biz3GetDeviceEmployeeKeys, deviceUUID, companyID, limit, op:'get'}
// ref: packages/core/src/org.js:738-744
//      references_web/src/api/useManageGroup.js:260-275
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0096] getDeviceEmployeeKeys wire フレーム", () => {
  it("[ORG-0096] action=biz3GetDeviceEmployeeKeys / deviceUUID,companyID,limit 直置き / op='get' が biz3 と一致する", async () => {
    const c = mockClient({ success: true, data: [], hasMore: false });
    await org.getDeviceEmployeeKeys(c, { deviceUUID: "d-1", companyID: "ch_X", limit: 5 });
    expect(c.sent[0]).toEqual({
      action: "biz3GetDeviceEmployeeKeys",
      deviceUUID: "d-1",
      companyID: "ch_X",
      limit: 5,
      op: "get",
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0097 — getDeviceEmployeeKeys は {list:resp.data, hasMore:resp.hasMore} を返す
// ref: packages/core/src/org.js:745-752
//      references_web/src/components/DeviceUserList.js:29-31
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0097] getDeviceEmployeeKeys {list, hasMore} shape", () => {
  it("[ORG-0097] hasMore:true のとき {list:[...], hasMore:true} を返す", async () => {
    const items = [{ subUUID: "u1", keyLevel: 2, guestKeyId: "g1" }];
    const c = mockClient({ success: true, data: items, hasMore: true });
    const r = await org.getDeviceEmployeeKeys(c, { deviceUUID: "d-1", companyID: "ch_X" });
    expect(r).toEqual({ list: items, hasMore: true });
  });

  it("[ORG-0097] hasMore:false のとき {list:[...], hasMore:false} を返す", async () => {
    const c = mockClient({ success: true, data: [{ subUUID: "u2" }], hasMore: false });
    const r = await org.getDeviceEmployeeKeys(c, { deviceUUID: "d-1", companyID: "ch_X" });
    expect(r.hasMore).toBe(false);
  });

  it("[ORG-0097] hasMore フィールドなし(全件取得時)は hasMore:undefined", async () => {
    const c = mockClient({ success: true, data: [] });
    const r = await org.getDeviceEmployeeKeys(c, { deviceUUID: "d-1", companyID: "ch_X" });
    expect(r.hasMore).toBeUndefined();
  });

  it("[ORG-0097] data フィールドなし(resp.data undefined)のとき list は [] にフォールバックする", async () => {
    const c = mockClient({ success: true });
    const r = await org.getDeviceEmployeeKeys(c, { deviceUUID: "d-1", companyID: "ch_X" });
    expect(r.list).toEqual([]);
  });

  it("[ORG-0097] 戻り値は配列ではなく {list,hasMore} オブジェクトである (旧 data 直返し との差異)", async () => {
    const c = mockClient({ success: true, data: [{ subUUID: "u1" }], hasMore: false });
    const r = await org.getDeviceEmployeeKeys(c, { deviceUUID: "d-1", companyID: "ch_X" });
    expect(typeof r).toBe("object");
    expect(Array.isArray(r)).toBe(false);
    expect(Array.isArray(r.list)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0098 — getDeviceEmployeeKeys limit 既定値 0 / CLI --limit 変換
// ref: packages/core/src/org.js:738
//      packages/kit/src/cli/org.js:615
//      references_web/src/components/DeviceUserList.js:55-61
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0098] getDeviceEmployeeKeys limit 既定値と CLI --limit", () => {
  it("[ORG-0098] limit 省略時は 0 (全件) がフレームへ入る (core 既定)", async () => {
    const c = mockClient({ success: true, data: [] });
    await org.getDeviceEmployeeKeys(c, { deviceUUID: "d-1", companyID: "ch_X" });
    expect(c.sent[0].limit).toBe(0);
  });

  it("[ORG-0098] limit=5 を明示指定するとフレームへそのまま入る", async () => {
    const c = mockClient({ success: true, data: [], hasMore: true });
    await org.getDeviceEmployeeKeys(c, { deviceUUID: "d-1", companyID: "ch_X", limit: 5 });
    expect(c.sent[0].limit).toBe(5);
  });

  it("[ORG-0098] CLI keys device は --limit 省略時に 0 をデフォルトとして getDeviceEmployeeKeys に渡す", async () => {
    const getDeviceEmployeeKeys = vi.fn(async () => ({ list: [], hasMore: undefined }));
    const hub = { org: { getDeviceEmployeeKeys } };
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(["org", "keys", "device", "d-1"], { from: "user" });
    expect(getDeviceEmployeeKeys).toHaveBeenCalledWith(
      expect.objectContaining({ deviceUUID: "d-1", limit: 0 }),
    );
  });

  it("[ORG-0098] CLI keys device --limit 5 は数値 5 として getDeviceEmployeeKeys に渡す", async () => {
    const getDeviceEmployeeKeys = vi.fn(async () => ({ list: [], hasMore: true }));
    const hub = { org: { getDeviceEmployeeKeys } };
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(["org", "keys", "device", "d-1", "--limit", "5"], { from: "user" });
    expect(getDeviceEmployeeKeys).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5 }),
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0099 — getDeviceEmployeeKeys 必須検証: deviceUUID / companyID 欠落
// ref: packages/core/src/org.js:739-740
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0099] getDeviceEmployeeKeys 必須バリデーション", () => {
  it("[ORG-0099] deviceUUID 未指定で badRequest('org.req.deviceUUID') を throw (送信しない)", async () => {
    const c = mockClient({});
    await expect(
      org.getDeviceEmployeeKeys(c, { deviceUUID: "", companyID: "ch_X" }),
    ).rejects.toThrow(/deviceUUID required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0099] companyID 未指定で badRequest('org.req.companyID') を throw (送信しない)", async () => {
    const c = mockClient({});
    await expect(
      org.getDeviceEmployeeKeys(c, { deviceUUID: "d-1", companyID: "" }),
    ).rejects.toThrow(/companyID required/);
    expect(c.sent).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0100 — CLI keys device: {list,hasMore} 分割代入 + 表示ロジック
// ref: packages/core/src/org.js:749-752  (getDeviceEmployeeKeys は {list,hasMore} を返す)
//      packages/kit/src/cli/org.js:618-631
//      references_web/src/components/DeviceUserList.js:29-31,33,119
//
// 実装疑い (TDD red): CLI の org.js:618 が `const list = await hub.org.getDeviceEmployeeKeys(...)`
// で {list,hasMore} オブジェクトを直接 `list` に代入している場合、Array.isArray(list) が常に
// false となり none 表示/count:0 の退化が発生する。
// → assert は「正しい仕様(分割代入 + hasMore 透過)」を規定し、実装バグ時に red になる。
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0100] CLI keys device 表示ロジックと {list,hasMore} 透過", () => {
  it("[ORG-0100] 鍵保有者 0 件のとき none メッセージを表示する", async () => {
    const hub = { org: { getDeviceEmployeeKeys: async () => ({ list: [], hasMore: undefined }) } };
    const ctx = makeCtx({ hub, json: false });
    const lines = [];
    vi.spyOn(console, "log").mockImplementation((s) => lines.push(String(s)));
    await buildProgram(ctx).parseAsync(["org", "keys", "device", "d-1"], { from: "user" });
    expect(lines.some((l) => l.includes("no key holder") || l.includes("none"))).toBe(true);
  });

  it("[ORG-0100] guestKeyId.length>0 のエントリに ' [guest]' を付加する (DeviceUserList.js:119 準拠)", async () => {
    const keys = [
      { keyLevel: 2, subUUID: "u1", employeeName: "Alice", guestKeyId: "g-abc" },
      { keyLevel: 1, subUUID: "u2", employeeName: "Bob", guestKeyId: "" },
    ];
    const hub = { org: { getDeviceEmployeeKeys: async () => ({ list: keys, hasMore: false }) } };
    const ctx = makeCtx({ hub, json: false });
    const lines = [];
    vi.spyOn(console, "log").mockImplementation((s) => lines.push(String(s)));
    await buildProgram(ctx).parseAsync(["org", "keys", "device", "d-1"], { from: "user" });
    expect(lines.some((l) => l.includes("Alice") && l.includes("[guest]"))).toBe(true);
    expect(lines.some((l) => l.includes("Bob") && !l.includes("[guest]"))).toBe(true);
  });

  it("[ORG-0100] --json 出力封筒は {ok,count,keys:list} で count は鍵の件数", async () => {
    const keys = [{ keyLevel: 1, subUUID: "u1", employeeName: "Alice", guestKeyId: "" }];
    const hub = { org: { getDeviceEmployeeKeys: async () => ({ list: keys, hasMore: false }) } };
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(["org", "keys", "device", "d-1"], { from: "user" });
    expect(ctx.outputs[0].ok).toBe(true);
    expect(ctx.outputs[0].count).toBe(1);
    expect(ctx.outputs[0].keys).toEqual(keys);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0101 — CLI share-url: level=2 のみ generateGuestQR で guestKeyId 発行
// ref: packages/kit/src/cli/org.js:765-813
//      packages/core/src/sharekey.js:60-106
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0101] CLI share-url level 分岐: level=2 のみ generateGuestQR を呼ぶ", () => {
  const validDeviceKey = {
    deviceUUID: "01234567-89ab-cdef-0123-456789abcdef",
    secretKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    sesame2PublicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    keyIndex: "00",
    deviceModel: "sesame_5",
    deviceName: "TestDoor",
  };
  const deviceKeyJson = JSON.stringify(validDeviceKey);

  it("[ORG-0101] level=2 のとき generateGuestQR を呼んで guestKeyId を取得する", async () => {
    const generateGuestQR = vi.fn(async () => "GUEST-KEY-111");
    const hub = { org: { generateGuestQR } };
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["org", "keys", "share-url", "--json", deviceKeyJson, "--level", "2"],
      { from: "user" },
    );
    expect(generateGuestQR).toHaveBeenCalledOnce();
  });

  it("[ORG-0101] level=0 のとき generateGuestQR を呼ばない (secretKey そのままを使う)", async () => {
    const generateGuestQR = vi.fn();
    const hub = { org: { generateGuestQR } };
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["org", "keys", "share-url", "--json", deviceKeyJson, "--level", "0"],
      { from: "user" },
    );
    expect(generateGuestQR).not.toHaveBeenCalled();
  });

  it("[ORG-0101] level=1 のとき generateGuestQR を呼ばない", async () => {
    const generateGuestQR = vi.fn();
    const hub = { org: { generateGuestQR } };
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["org", "keys", "share-url", "--json", deviceKeyJson, "--level", "1"],
      { from: "user" },
    );
    expect(generateGuestQR).not.toHaveBeenCalled();
  });

  it("[ORG-0101] --json 出力に ok:true / url (ssm://UI?) が含まれる", async () => {
    const generateGuestQR = vi.fn(async () => "GUEST-KEY-222");
    const hub = { org: { generateGuestQR } };
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["org", "keys", "share-url", "--json", deviceKeyJson, "--level", "2"],
      { from: "user" },
    );
    expect(ctx.outputs[0].ok).toBe(true);
    expect(typeof ctx.outputs[0].url).toBe("string");
    expect(ctx.outputs[0].url).toMatch(/^ssm:\/\/UI\?/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0102 — CLI share-url deviceKey 解決優先順位: --json > --device 検索 > 対話選択
// ref: packages/kit/src/cli/org.js:780-803
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0102] CLI share-url deviceKey 解決優先順位", () => {
  const validDeviceKey = {
    deviceUUID: "01234567-89ab-cdef-0123-456789abcdef",
    secretKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    sesame2PublicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    keyIndex: "00",
    deviceModel: "sesame_5",
    deviceName: "Door",
  };
  const deviceKeyJson = JSON.stringify(validDeviceKey);

  it("[ORG-0102] --json 指定時は listDevices を呼ばない (最優先)", async () => {
    const listDevices = vi.fn(async () => []);
    const generateGuestQR = vi.fn(async () => "GK");
    const hub = { listDevices, org: { generateGuestQR } };
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["org", "keys", "share-url", "--json", deviceKeyJson],
      { from: "user" },
    );
    expect(listDevices).not.toHaveBeenCalled();
  });

  it("[ORG-0102] --device 指定で listDevices を検索し見つかれば使う", async () => {
    const listDevices = vi.fn(async () => [validDeviceKey]);
    const generateGuestQR = vi.fn(async () => "GK");
    const hub = { listDevices, org: { generateGuestQR } };
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["org", "keys", "share-url", "--device", validDeviceKey.deviceUUID],
      { from: "user" },
    );
    expect(listDevices).toHaveBeenCalledOnce();
    expect(ctx.outputs[0].ok).toBe(true);
  });

  it("[ORG-0102] --device 指定で listDevices に存在しない場合 die(2) し URL を出力しない", async () => {
    const listDevices = vi.fn(async () => [{ deviceUUID: "other-device", deviceModel: "sesame_5" }]);
    const hub = { listDevices, org: {} };
    const ctx = makeCtx({ hub, json: true });
    await expect(
      buildProgram(ctx).parseAsync(
        ["org", "keys", "share-url", "--device", "NONEXISTENT-UUID"],
        { from: "user" },
      ),
    ).rejects.toThrow();
    expect(ctx.outputs).toHaveLength(0);
  });

  it("[ORG-0102] --json/--device 無し かつ canPrompt=false のとき die(2) (needDeviceOrJson)", async () => {
    const hub = { listDevices: vi.fn(async () => [validDeviceKey]), org: {} };
    const ctx = makeCtx({ hub, json: true });
    await expect(
      buildProgram(ctx).parseAsync(["org", "keys", "share-url"], { from: "user" }),
    ).rejects.toThrow();
    expect(ctx.outputs).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0103 — CLI share-url --level 不正値 / --qr qrcode-terminal 未導入
// ref: packages/kit/src/cli/org.js:775-828
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0103] CLI share-url --level 不正値 / --qr error-path", () => {
  const deviceKeyJson = JSON.stringify({
    deviceUUID: "01234567-89ab-cdef-0123-456789abcdef",
    secretKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    sesame2PublicKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    keyIndex: "00",
    deviceModel: "sesame_5",
  });

  it("[ORG-0103] --level 3 (0/1/2 以外) で die(2) し URL を出力しない", async () => {
    const hub = { org: {} };
    const ctx = makeCtx({ hub, json: true });
    await expect(
      buildProgram(ctx).parseAsync(
        ["org", "keys", "share-url", "--json", deviceKeyJson, "--level", "3"],
        { from: "user" },
      ),
    ).rejects.toThrow();
    expect(ctx.outputs).toHaveLength(0);
  });

  it("[ORG-0103] --level -1 で die(2)", async () => {
    const hub = { org: {} };
    const ctx = makeCtx({ hub, json: true });
    await expect(
      buildProgram(ctx).parseAsync(
        ["org", "keys", "share-url", "--json", deviceKeyJson, "--level", "-1"],
        { from: "user" },
      ),
    ).rejects.toThrow();
    expect(ctx.outputs).toHaveLength(0);
  });

  it("[ORG-0103] --level 0/1/2 は全て有効 (die しない)", async () => {
    for (const level of ["0", "1", "2"]) {
      const generateGuestQR = level === "2" ? vi.fn(async () => "GK") : undefined;
      const hub = { org: generateGuestQR ? { generateGuestQR } : {} };
      const ctx = makeCtx({ hub, json: true });
      await buildProgram(ctx).parseAsync(
        ["org", "keys", "share-url", "--json", deviceKeyJson, "--level", level],
        { from: "user" },
      );
      expect(ctx.outputs[0].ok).toBe(true);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0104 — org スライス 7 op が NAMESPACE_OPS に列挙される (contract-existence)
// ref: packages/core/src/org.js:856-858
//      packages/kit/src/serve/registry.js:287-303
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0104] NAMESPACE_OPS に 7 op が全て列挙される", () => {
  const SEVEN_OPS = [
    "shareDeviceKeysToEmployees",
    "shareDeviceGroupKeysToEmployeeGroup",
    "getEmployeeDeviceKeys",
    "removeEmployeeDeviceKey",
    "updateGuestKeyTag",
    "generateGuestQR",
    "getDeviceEmployeeKeys",
  ];

  it("[ORG-0104] NAMESPACE_OPS は配列であり 7 op を全て含む", () => {
    expect(Array.isArray(org.NAMESPACE_OPS)).toBe(true);
    for (const op of SEVEN_OPS) {
      expect(org.NAMESPACE_OPS).toContain(op);
    }
  });

  it("[ORG-0104] 7 op がエクスポートされた関数として実装されている", () => {
    for (const op of SEVEN_OPS) {
      expect(typeof org[op]).toBe("function");
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0105 — gRPC proto / grpc-methods.generated に 7 op が 1:1 で存在
// ref: packages/kit/src/serve/sesame.proto:69-81
//      packages/kit/src/serve/grpc-methods.generated.json:272-334
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0105] grpc-methods.generated に 7 op が 1:1 で存在", () => {
  it("[ORG-0105] 7 op が grpc-methods.generated に method 1:1 で存在し jsonFields/optionalScalars を持つ", async () => {
    const grpcMethods = (await import(
      "../../../kit/src/serve/grpc-methods.generated.json",
      { assert: { type: "json" } }
    )).default;

    const EXPECTED = {
      OrgShareDeviceKeysToEmployees: "org.shareDeviceKeysToEmployees",
      OrgShareDeviceGroupKeysToEmployeeGroup: "org.shareDeviceGroupKeysToEmployeeGroup",
      OrgGetEmployeeDeviceKeys: "org.getEmployeeDeviceKeys",
      OrgRemoveEmployeeDeviceKey: "org.removeEmployeeDeviceKey",
      OrgUpdateGuestKeyTag: "org.updateGuestKeyTag",
      OrgGenerateGuestQR: "org.generateGuestQR",
      OrgGetDeviceEmployeeKeys: "org.getDeviceEmployeeKeys",
    };

    for (const [grpcName, methodName] of Object.entries(EXPECTED)) {
      const entry = grpcMethods[grpcName];
      expect(entry, `${grpcName} が grpc-methods.generated に存在しない`).toBeDefined();
      expect(entry.method).toBe(methodName);
      expect(entry).toHaveProperty("jsonFields");
      expect(entry).toHaveProperty("optionalScalars");
    }

    // jsonFields の主要 op
    expect(grpcMethods["OrgShareDeviceKeysToEmployees"].jsonFields).toContain("items");
    expect(grpcMethods["OrgShareDeviceGroupKeysToEmployeeGroup"].jsonFields).toContain("item");
    expect(grpcMethods["OrgRemoveEmployeeDeviceKey"].jsonFields).toContain("data");
    expect(grpcMethods["OrgUpdateGuestKeyTag"].jsonFields).toContain("data");
    expect(grpcMethods["OrgGenerateGuestQR"].jsonFields).toContain("data");

    // optionalScalars の主要 op
    expect(grpcMethods["OrgShareDeviceGroupKeysToEmployeeGroup"].optionalScalars).toContain("companyID");
    expect(grpcMethods["OrgGetDeviceEmployeeKeys"].optionalScalars).toContain("companyID");
    expect(grpcMethods["OrgGetDeviceEmployeeKeys"].optionalScalars).toContain("limit");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0106 — SDK rpc-params の companyID/subUUID は required:false / 身元すり替えハザード
// ref: packages/kit/src/serve/rpc-params.generated.json:795,822-832
//      packages/core/src/client.js:333-350
//      packages/core/src/org.js:633,649-650,740
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0106] rpc-params: companyID/subUUID required:false / 身元すり替えハザード", () => {
  it("[ORG-0106] org.shareDeviceGroupKeysToEmployeeGroup の companyID は required:false + auto-injected 注記", async () => {
    const rpcParams = (await import(
      "../../../kit/src/serve/rpc-params.generated.json",
      { assert: { type: "json" } }
    )).default;
    const shareGroupParams = rpcParams["org.shareDeviceGroupKeysToEmployeeGroup"];
    expect(shareGroupParams).toBeDefined();
    const companyIDParam = shareGroupParams.find((p) => p.name === "companyID");
    expect(companyIDParam).toBeDefined();
    expect(companyIDParam.required).toBe(false);
    expect(companyIDParam.desc).toMatch(/auto-injected/i);
  });

  it("[ORG-0106] org.getEmployeeDeviceKeys の subUUID は required:false (身元すり替えハザード: 省略時に呼び手自身が返る)", async () => {
    const rpcParams = (await import(
      "../../../kit/src/serve/rpc-params.generated.json",
      { assert: { type: "json" } }
    )).default;
    const empKeyParams = rpcParams["org.getEmployeeDeviceKeys"];
    expect(empKeyParams).toBeDefined();
    const subUUIDParam = empKeyParams.find((p) => p.name === "subUUID");
    expect(subUUIDParam).toBeDefined();
    expect(subUUIDParam.required).toBe(false);
    expect(subUUIDParam.desc).toMatch(/auto-injected/i);
  });

  it("[ORG-0106] org.getDeviceEmployeeKeys の companyID は required:false + auto-injected 注記", async () => {
    const rpcParams = (await import(
      "../../../kit/src/serve/rpc-params.generated.json",
      { assert: { type: "json" } }
    )).default;
    const devKeyParams = rpcParams["org.getDeviceEmployeeKeys"];
    expect(devKeyParams).toBeDefined();
    const companyIDParam = devKeyParams.find((p) => p.name === "companyID");
    expect(companyIDParam).toBeDefined();
    expect(companyIDParam.required).toBe(false);
    expect(companyIDParam.desc).toMatch(/auto-injected/i);
  });

  it("[ORG-0106] core 直叩き: getDeviceEmployeeKeys で companyID 未指定は throw (必須)", async () => {
    const c = mockClient({});
    await expect(
      org.getDeviceEmployeeKeys(c, { deviceUUID: "d-1" }),
    ).rejects.toThrow(/companyID required/);
  });

  it("[ORG-0106] core 直叩き: getDeviceEmployeeKeys で deviceUUID 未指定は throw (必須)", async () => {
    const c = mockClient({});
    await expect(
      org.getDeviceEmployeeKeys(c, { companyID: "ch_X" }),
    ).rejects.toThrow(/deviceUUID required/);
  });

  it("[ORG-0106] core 直叩き: shareDeviceGroupKeysToEmployeeGroup で companyID 欠落は throw (必須)", async () => {
    const c = mockClient({ success: true });
    await expect(
      org.shareDeviceGroupKeysToEmployeeGroup(c, { item: { keyLevel: "1" } }),
    ).rejects.toThrow(/companyID required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0106] core 直叩き: getEmployeeDeviceKeys で subUUID 欠落は throw (必須)", async () => {
    const c = mockClient({ success: true, data: [] });
    await expect(
      org.getEmployeeDeviceKeys(c, {}),
    ).rejects.toThrow(/subUUID required/);
    expect(c.sent).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0107 — i18n org.keys.* / org.employee.* / org.cmd.* の en/ja 完全性
// ref: packages/core/src/i18n/org.js:8 (en), packages/core/src/i18n/org.js:254 (ja)
//      packages/kit/src/cli/org.js:766-833 (keys 系最多参照)
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0107] i18n org.keys.* / org.employee.* / org.cmd.* en/ja 完全性", () => {
  const en = i18n.en;
  const ja = i18n.ja;

  it("[ORG-0107] en と ja のキー集合が完全一致する (欠落なし)", () => {
    const enKeys = Object.keys(en);
    const jaKeys = Object.keys(ja);
    const missingInJa = enKeys.filter((k) => !(k in ja));
    const missingInEn = jaKeys.filter((k) => !(k in en));
    expect(missingInJa).toEqual([]);
    expect(missingInEn).toEqual([]);
  });

  // org.cmd.* ファミリ
  const CMD_KEYS = [
    "org.cmd.org",
    "org.cmd.employee",
    "org.cmd.group",
    "org.cmd.role",
    "org.cmd.deviceGroup",
    "org.cmd.keys",
  ];

  for (const key of CMD_KEYS) {
    it(`[ORG-0107] '${key}' が en/ja 双方に定義される`, () => {
      expect(en).toHaveProperty(key);
      expect(ja).toHaveProperty(key);
    });
  }

  // org.employee.* ファミリ
  const EMPLOYEE_KEYS = [
    "org.employee.ls.desc",
    "org.employee.ls.none",
    "org.employee.ls.found",
    "org.employee.me.desc",
    "org.employee.add.desc",
    "org.employee.add.need",
    "org.employee.add.ok",
    "org.employee.update.desc",
    "org.employee.update.need",
    "org.employee.rm.desc",
    "org.employee.rm.need",
    "org.employee.rm.ok",
    "org.employee.reorder.desc",
    "org.employee.reorder.need",
    "org.employee.reorder.ok",
    "org.employee.search.desc",
    "org.employee.search.none",
    "org.employee.search.found",
    "org.employee.confirm.desc",
    "org.employee.confirm.prompt",
    "org.employee.confirm.aborted",
    "org.employee.confirm.ok",
  ];

  for (const key of EMPLOYEE_KEYS) {
    it(`[ORG-0107] '${key}' が en/ja 双方に定義される`, () => {
      expect(en).toHaveProperty(key);
      expect(ja).toHaveProperty(key);
    });
  }

  // org.keys.* ファミリ
  const KEYS_KEYS = [
    "org.keys.device.desc",
    "org.keys.device.none",
    "org.keys.device.found",
    "org.keys.employee.desc",
    "org.keys.share.desc",
    "org.keys.share.need",
    "org.keys.share.ok",
    "org.keys.shareGroup.desc",
    "org.keys.shareGroup.need",
    "org.keys.shareGroup.ok",
    "org.keys.rm.desc",
    "org.keys.rm.need",
    "org.keys.rm.ok",
    "org.keys.rm.deviceNotFound",
    "org.keys.rm.noSecretKey",
    "org.keys.updateGuestTag.desc",
    "org.keys.updateGuestTag.need",
    "org.keys.updateGuestTag.ok",
    "org.keys.generateGuestQr.desc",
    "org.keys.generateGuestQr.need",
    "org.keys.generateGuestQr.ok",
    "org.keys.shareUrl.desc",
    "org.keys.shareUrl.badLevel",
    "org.keys.shareUrl.deviceNotFound",
    "org.keys.shareUrl.noDevices",
    "org.keys.shareUrl.selectPrompt",
    "org.keys.shareUrl.cancelled",
    "org.keys.shareUrl.needDeviceOrJson",
    "org.keys.shareUrl.qrNotInstalled",
  ];

  for (const key of KEYS_KEYS) {
    it(`[ORG-0107] '${key}' が en/ja 双方に定義される`, () => {
      expect(en).toHaveProperty(key);
      expect(ja).toHaveProperty(key);
    });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0108 — CLI device-group add --uuids 非配列で die(exit 2, org.err.uuidsArray)
// ref: packages/kit/src/cli/org.js:483-485
//      packages/core/src/i18n/org.js:21 (en) / :267 (ja)
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0108] CLI device-group add --uuids 非配列で die(2)", () => {
  it("[ORG-0108] --uuids に配列でない JSON (オブジェクト) を渡すと die(2) し addDeviceGroup を呼ばない", async () => {
    const addDeviceGroup = vi.fn();
    const hub = { org: { addDeviceGroup } };
    const ctx = makeCtx({ hub, json: true });
    await expect(
      buildProgram(ctx).parseAsync(
        ["org", "device-group", "add", "TestGroup", "--uuids", '{"not":"array"}'],
        { from: "user" },
      ),
    ).rejects.toThrow();
    expect(addDeviceGroup).not.toHaveBeenCalled();
  });

  it("[ORG-0108] --uuids に文字列 JSON を渡すと die(2) し addDeviceGroup を呼ばない", async () => {
    const addDeviceGroup = vi.fn();
    const hub = { org: { addDeviceGroup } };
    const ctx = makeCtx({ hub, json: true });
    await expect(
      buildProgram(ctx).parseAsync(
        ["org", "device-group", "add", "TestGroup", "--uuids", '"not-an-array"'],
        { from: "user" },
      ),
    ).rejects.toThrow();
    expect(addDeviceGroup).not.toHaveBeenCalled();
  });

  it("[ORG-0108] --uuids '[]' (既定) は有効 → addDeviceGroup を呼ぶ", async () => {
    const addDeviceGroup = vi.fn(async () => ({ success: true }));
    const hub = { org: { addDeviceGroup } };
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["org", "device-group", "add", "TestGroup"],
      { from: "user" },
    );
    expect(addDeviceGroup).toHaveBeenCalledOnce();
    expect(addDeviceGroup).toHaveBeenCalledWith(expect.objectContaining({ name: "TestGroup", uuids: [] }));
  });

  it("[ORG-0108] --uuids '[\"d1\",\"d2\"]' は有効配列 → addDeviceGroup を呼ぶ", async () => {
    const addDeviceGroup = vi.fn(async () => ({ success: true }));
    const hub = { org: { addDeviceGroup } };
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["org", "device-group", "add", "TestGroup", "--uuids", '["d1","d2"]'],
      { from: "user" },
    );
    expect(addDeviceGroup).toHaveBeenCalledWith(expect.objectContaining({ uuids: ["d1", "d2"] }));
  });

  it("[ORG-0108] i18n キー 'org.err.uuidsArray' が en/ja 双方に定義される", () => {
    expect(i18n.en).toHaveProperty("org.err.uuidsArray");
    expect(i18n.ja).toHaveProperty("org.err.uuidsArray");
  });
});
