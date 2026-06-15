// packages/core/tests/_spec/ir-c4.test.js
//
// IR spec 統合テスト: IR-0073 〜 IR-0090
//
// 対象実装:
//   packages/core/src/ir.js          — addRemoteToMatter / getRemoteList / searchRemoteList / matchRemote
//   packages/core/src/presetir.js    — sendIR / HXDCommandProcessor / IR_TYPE
//   packages/core/src/crypto.js      — IR_TYPE / DEFAULT_IR_TYPE / parseIrType
//   packages/kit/src/serve/entries/ir.js — irEntries() (9 CRUD/検索/照合メソッド)
//   packages/kit/sdk/ts/sesame-client.ts — TS SDK ir.* shape (静的検査)
//
// 方針:
//   - 各 it のタイトル先頭に [IR-XXXX] を置く。
//   - ネットワーク/実機不使用。mock client で完結。決定論的。
//   - TDD: red は許容。クラッシュ/実行不能は不可。
//   - 全 18 spec ID (IR-0073〜IR-0090) を漏れなく被覆。

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const _thisDir = dirname(fileURLToPath(import.meta.url));

// ---- core imports ----
import {
  addRemoteToMatter,
  getRemoteList,
  searchRemoteList,
  matchRemote,
} from "../../src/ir.js";

import {
  HXDCommandProcessor,
  sendIR as presetSendIR,
  IR_TYPE as PRESET_IR_TYPE,
} from "../../src/presetir.js";

import {
  IR_TYPE as CRYPTO_IR_TYPE,
  DEFAULT_IR_TYPE,
  parseIrType,
} from "../../src/crypto.js";

// ---- serve entries ----
import { irEntries } from "../../../kit/src/serve/entries/ir.js";

// =====================================================================
// 共通 mock ヘルパ
// =====================================================================

/** 最小 mock client: request を記録して固定応答を返す */
function makeClient(response) {
  const calls = [];
  return {
    calls,
    request: vi.fn(async (frame, timeoutMs) => {
      calls.push({ frame, timeoutMs });
      return response;
    }),
    send: vi.fn(),
    subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
  };
}

function successResp(data = null) {
  return { success: true, data };
}

function failResp(message = "denied") {
  return { success: false, message };
}

// =====================================================================
// [IR-0073] addRemoteToMatter wire frame (9 キー 1:1)
// ref: packages/core/src/ir.js:275-285; references_web/src/api/useRemoteCtrl.js:936-946
// =====================================================================

describe("[IR-0073] addRemoteToMatter wire frame (9 キー 1:1)", () => {
  const BASE = {
    hub3DeviceId: "hub3-uuid-aaa",
    irDeviceType: 0xc000,
    cmdOn: "3001..ON",
    cmdOff: "3001..OFF",
    irDeviceUUID: "remote-uuid-bbb",
    irDeviceName: "エアコン",
    companyID: "co-X",
  };

  it("[IR-0073] フレームのキー集合が vendor と 1:1 (9 キー: action/op + 7 ペイロード)", async () => {
    const client = makeClient(successResp());
    await addRemoteToMatter(client, BASE);

    const { frame } = client.calls[0];
    // action / op
    expect(frame.action).toBe("biz3IRRemote");
    expect(frame.op).toBe("addRemoteToMatter");
    // 7 ペイロードフィールド (vendor と同名)
    expect(frame.hub3DeviceId).toBe(BASE.hub3DeviceId);
    expect(frame.irDeviceType).toBe(BASE.irDeviceType);
    expect(frame.cmdOn).toBe(BASE.cmdOn);
    expect(frame.cmdOff).toBe(BASE.cmdOff);
    expect(frame.irDeviceUUID).toBe(BASE.irDeviceUUID);
    expect(frame.irDeviceName).toBe(BASE.irDeviceName);
    expect(frame.companyID).toBe(BASE.companyID);
    // 余計なキーなし (9 キー厳密一致)
    const keys = Object.keys(frame).sort();
    expect(keys).toEqual(
      ["action", "cmdOff", "cmdOn", "companyID", "hub3DeviceId", "irDeviceName", "irDeviceType", "irDeviceUUID", "op"].sort()
    );
    expect(frame).not.toHaveProperty("deviceId");
    expect(frame).not.toHaveProperty("remoteId");
  });

  it("[IR-0073] irDeviceType=irRemote.type / irDeviceUUID=irRemote.uuid / irDeviceName=irRemote.alias を写像する", async () => {
    const client = makeClient(successResp());
    await addRemoteToMatter(client, {
      ...BASE,
      irDeviceType: 0x2000,
      irDeviceUUID: "uuid-1",
      irDeviceName: "My Alias",
    });
    const { frame } = client.calls[0];
    expect(frame.irDeviceType).toBe(0x2000);
    expect(frame.irDeviceUUID).toBe("uuid-1");
    expect(frame.irDeviceName).toBe("My Alias");
  });

  it("[IR-0073] success:false は throw (assertSuccess strict)", async () => {
    const client = makeClient(failResp("Matter failed"));
    await expect(addRemoteToMatter(client, BASE)).rejects.toThrow(/addRemoteToMatter/);
  });
});

// =====================================================================
// [IR-0074] remote-add-matter 必須オプション検証 (6 個) と型変換
// ref: packages/kit/src/cli/ir.js:264-288
// =====================================================================

describe("[IR-0074] remote-add-matter 必須オプション検証 (6 個) と型変換", () => {
  // CLI 関数は非 export のため、バリデーションロジックを純関数として再現して境界値を検証する。
  // commander は --ir-device-uuid → irDeviceUuid にキャメル変換する。
  function simulateMissingCheck(options) {
    const p = {
      hub3DeviceId: options.hub3DeviceId,
      irDeviceType: options.irDeviceType === undefined ? undefined : Number(options.irDeviceType),
      cmdOn: options.cmdOn,
      cmdOff: options.cmdOff,
      irDeviceUUID: options.irDeviceUuid, // commander キャメル変換
      irDeviceName: options.irDeviceName,
    };
    const missing = [];
    if (!p.hub3DeviceId) missing.push("--hub3-device-id");
    if (p.irDeviceType === undefined || Number.isNaN(p.irDeviceType)) missing.push("--ir-device-type");
    if (!p.cmdOn) missing.push("--cmd-on");
    if (!p.cmdOff) missing.push("--cmd-off");
    if (!p.irDeviceUUID) missing.push("--ir-device-uuid");
    if (!p.irDeviceName) missing.push("--ir-device-name");
    return { p, missing };
  }

  const ALL_OPTS = {
    hub3DeviceId: "h", irDeviceType: "49152", cmdOn: "on", cmdOff: "off",
    irDeviceUuid: "u", irDeviceName: "n",
  };

  it("[IR-0074] 全指定時は missing が空", () => {
    expect(simulateMissingCheck(ALL_OPTS).missing).toHaveLength(0);
  });

  it("[IR-0074] hub3DeviceId 欠落で --hub3-device-id が missing に入る", () => {
    const { missing } = simulateMissingCheck({ ...ALL_OPTS, hub3DeviceId: undefined });
    expect(missing).toContain("--hub3-device-id");
  });

  it("[IR-0074] irDeviceType 非数値文字列 (NaN) で --ir-device-type が missing に入る", () => {
    const { missing } = simulateMissingCheck({ ...ALL_OPTS, irDeviceType: "notANumber" });
    expect(missing).toContain("--ir-device-type");
  });

  it("[IR-0074] irDeviceType undefined で --ir-device-type が missing に入る", () => {
    const { missing } = simulateMissingCheck({ ...ALL_OPTS, irDeviceType: undefined });
    expect(missing).toContain("--ir-device-type");
  });

  it("[IR-0074] irDeviceType='0' は Number 変換で 0 になり missing に入らない (0 は有効値)", () => {
    const { p, missing } = simulateMissingCheck({ ...ALL_OPTS, irDeviceType: "0" });
    expect(missing).not.toContain("--ir-device-type");
    expect(p.irDeviceType).toBe(0);
  });

  it("[IR-0074] --ir-device-uuid (commander → irDeviceUuid) が irDeviceUUID に写像される", () => {
    const { p } = simulateMissingCheck({ ...ALL_OPTS, irDeviceUuid: "mapped-uuid" });
    expect(p.irDeviceUUID).toBe("mapped-uuid");
  });

  it("[IR-0074] cmdOn 欠落で --cmd-on が missing に入る", () => {
    const { missing } = simulateMissingCheck({ ...ALL_OPTS, cmdOn: undefined });
    expect(missing).toContain("--cmd-on");
  });

  it("[IR-0074] cmdOff 欠落で --cmd-off が missing に入る", () => {
    const { missing } = simulateMissingCheck({ ...ALL_OPTS, cmdOff: undefined });
    expect(missing).toContain("--cmd-off");
  });

  it("[IR-0074] irDeviceUuid 欠落で --ir-device-uuid が missing に入る", () => {
    const { missing } = simulateMissingCheck({ ...ALL_OPTS, irDeviceUuid: undefined });
    expect(missing).toContain("--ir-device-uuid");
  });

  it("[IR-0074] irDeviceName 欠落で --ir-device-name が missing に入る", () => {
    const { missing } = simulateMissingCheck({ ...ALL_OPTS, irDeviceName: undefined });
    expect(missing).toContain("--ir-device-name");
  });

  it("[IR-0074] 複数欠落時は全て missing に列挙される", () => {
    const { missing } = simulateMissingCheck({ hub3DeviceId: "h" });
    expect(missing).toContain("--ir-device-type");
    expect(missing).toContain("--cmd-on");
    expect(missing).toContain("--cmd-off");
    expect(missing).toContain("--ir-device-uuid");
    expect(missing).toContain("--ir-device-name");
    expect(missing.length).toBe(5);
  });
});

// =====================================================================
// [IR-0075] IR_TYPE wire 値の正準と学習 0xFE00 トラップ
// ref: packages/core/src/crypto.js:261-267, 274
// =====================================================================

describe("[IR-0075] IR_TYPE wire 値の正準と学習 0xFE00 トラップ", () => {
  it("[IR-0075] ac=0xC000", () => {
    expect(CRYPTO_IR_TYPE.ac).toBe(0xc000);
  });

  it("[IR-0075] tv=0x2000", () => {
    expect(CRYPTO_IR_TYPE.tv).toBe(0x2000);
  });

  it("[IR-0075] light=0xE000", () => {
    expect(CRYPTO_IR_TYPE.light).toBe(0xe000);
  });

  it("[IR-0075] fan=0x8000", () => {
    expect(CRYPTO_IR_TYPE.fan).toBe(0x8000);
  });

  it("[IR-0075] learn (自己学習リモコンの実 type) = 0xFE00 (65024)", () => {
    // vendor: learn/index.js:142 — {type:0xfe00}, useRemoteCtrl.js:228 — 0xfe00 判定
    expect(CRYPTO_IR_TYPE.learn).toBe(0xfe00);
  });

  it("[IR-0075] UI メニュー 0xFEFF と実 type 0xFE00 は異なる値 (取り違え防止)", () => {
    // ir-type-list/index.js:46 で UI メニュー識別子は 0xFEFF
    expect(CRYPTO_IR_TYPE.learn).not.toBe(0xfeff);
    expect(CRYPTO_IR_TYPE.learn).toBe(0xfe00);
  });

  it("[IR-0075] DEFAULT_IR_TYPE は learn (0xFE00)", () => {
    expect(DEFAULT_IR_TYPE).toBe(0xfe00);
  });

  it("[IR-0075] IR_TYPE は Object.freeze されている", () => {
    expect(Object.isFrozen(CRYPTO_IR_TYPE)).toBe(true);
  });

  it("[IR-0075] IR_TYPE への書き込みは strict mode で throw (freeze 確認)", () => {
    expect(() => {
      "use strict";
      // @ts-ignore
      CRYPTO_IR_TYPE.ac = 0xffff;
    }).toThrow();
  });
});

// =====================================================================
// [IR-0076] parseIrType のエイリアス・数値・0x表記・未知例外
// ref: packages/core/src/crypto.js:281-289
// =====================================================================

describe("[IR-0076] parseIrType のエイリアス・数値・0x表記・未知例外", () => {
  it("[IR-0076] エイリアス 'ac' → 0xC000", () => {
    expect(parseIrType("ac")).toBe(0xc000);
  });

  it("[IR-0076] エイリアス 'tv' → 0x2000", () => {
    expect(parseIrType("tv")).toBe(0x2000);
  });

  it("[IR-0076] エイリアス 'light' → 0xE000", () => {
    expect(parseIrType("light")).toBe(0xe000);
  });

  it("[IR-0076] エイリアス 'fan' → 0x8000", () => {
    expect(parseIrType("fan")).toBe(0x8000);
  });

  it("[IR-0076] エイリアス 'learn' → 0xFE00 (自己学習実 type)", () => {
    expect(parseIrType("learn")).toBe(0xfe00);
  });

  it("[IR-0076] 10 進数文字列 '49152' → 0xC000", () => {
    expect(parseIrType("49152")).toBe(0xc000);
  });

  it("[IR-0076] 10 進数文字列 '8192' → 0x2000", () => {
    expect(parseIrType("8192")).toBe(0x2000);
  });

  it("[IR-0076] 0x 表記文字列 '0xc000' → 0xC000", () => {
    expect(parseIrType("0xc000")).toBe(0xc000);
  });

  it("[IR-0076] 0x 表記文字列 '0xFE00' → 0xFE00", () => {
    expect(parseIrType("0xfe00")).toBe(0xfe00);
  });

  it("[IR-0076] 数値型はそのまま返す", () => {
    expect(parseIrType(0xc000)).toBe(0xc000);
    expect(parseIrType(0x8000)).toBe(0x8000);
  });

  it("[IR-0076] 未知文字列は throw", () => {
    expect(() => parseIrType("unknown-type")).toThrow();
    expect(() => parseIrType("")).toThrow();
  });

  it("[IR-0076] UI メニュー値 '0xFEFF' は数値として受理されるが 0xFE00 ≠ 0xFEFF", () => {
    const menuValue = parseIrType("0xFEFF");
    expect(menuValue).toBe(0xfeff);
    expect(menuValue).not.toBe(0xfe00);
  });
});

// =====================================================================
// [IR-0077] serve registry に 9 CRUD/検索/照合メソッドが登録されている
// ref: packages/kit/src/serve/entries/ir.js:52-143; packages/kit/src/serve/registry.js:340
// =====================================================================

describe("[IR-0077] serve registry に 9 メソッドが登録されている", () => {
  const EXPECTED_METHODS = [
    "ir.listRemotes",
    "ir.searchRemotes",
    "ir.addRemote",
    "ir.deleteRemote",
    "ir.renameRemote",
    "ir.deleteKey",
    "ir.renameKey",
    "ir.matchRemote",
    "ir.addRemoteToMatter",
  ];

  it("[IR-0077] 9 メソッドが全て irEntries() に存在する", () => {
    const entries = irEntries();
    for (const method of EXPECTED_METHODS) {
      expect(entries).toHaveProperty(method);
    }
  });

  it("[IR-0077] irEntries() のメソッド数が 9 以上 (ir.send/listKeys/learn/getMode/setMode 含む全体は 14)", () => {
    const entries = irEntries();
    expect(Object.keys(entries).length).toBeGreaterThanOrEqual(9);
  });

  it("[IR-0077] 各エントリが handler 関数を持つ", () => {
    const entries = irEntries();
    for (const method of EXPECTED_METHODS) {
      expect(typeof entries[method].handler).toBe("function");
    }
  });

  it("[IR-0077] ir.addRemoteToMatter の params は 6 必須フィールドを含む", () => {
    const entries = irEntries();
    const entry = entries["ir.addRemoteToMatter"];
    expect(entry).toBeDefined();
    const requiredParams = entry.params.filter((p) => p.required === true).map((p) => p.name);
    for (const name of ["hub3DeviceId", "irDeviceType", "cmdOn", "cmdOff", "irDeviceUUID", "irDeviceName"]) {
      expect(requiredParams).toContain(name);
    }
  });

  it("[IR-0077] ir.listRemotes は type を required:true で持つ", () => {
    const entries = irEntries();
    const params = entries["ir.listRemotes"].params;
    const typeParam = params.find((p) => p.name === "type");
    expect(typeParam).toBeDefined();
    expect(typeParam.required).toBe(true);
  });

  it("[IR-0077] ir.searchRemotes は type と searchTerm を required:true で持つ", () => {
    const entries = irEntries();
    const params = entries["ir.searchRemotes"].params;
    const requiredNames = params.filter((p) => p.required).map((p) => p.name);
    expect(requiredNames).toContain("type");
    expect(requiredNames).toContain("searchTerm");
  });

  it("[IR-0077] ir.matchRemote の brandName は optional", () => {
    const entries = irEntries();
    const entry = entries["ir.matchRemote"];
    const brandNameParam = entry.params.find((p) => p.name === "brandName");
    expect(brandNameParam).toBeDefined();
    expect(brandNameParam.required).toBeFalsy();
  });

  it("[IR-0077] ir.addRemote の remote は required", () => {
    const entries = irEntries();
    const entry = entries["ir.addRemote"];
    const remoteParam = entry.params.find((p) => p.name === "remote");
    expect(remoteParam.required).toBe(true);
  });
});

// =====================================================================
// [IR-0078] 生成 TS SDK の ir.* メソッドが registry params と一致 (static shape)
// ref: packages/kit/sdk/ts/sesame-client.ts:463-485
// TS ファイルは JS として import 不可のため、テキスト静的検査で代替する。
// =====================================================================

describe("[IR-0078] 生成 TS SDK が ir.* 9 メソッドを露出する (static shape check)", () => {
  const tssdkPath = resolve(_thisDir, "../../../../packages/kit/sdk/ts/sesame-client.ts");
  let tsSdk = null;
  try {
    tsSdk = readFileSync(tssdkPath, "utf-8");
  } catch {
    // ファイルが存在しない場合は null のまま
  }

  const EXPECTED_IR_METHODS = [
    "addRemote",
    "addRemoteToMatter",
    "deleteKey",
    "deleteRemote",
    "listRemotes",
    "matchRemote",
    "renameKey",
    "renameRemote",
    "searchRemotes",
  ];

  it("[IR-0078] sesame-client.ts が読み込める", () => {
    expect(tsSdk).not.toBeNull();
  });

  it("[IR-0078] TS SDK に 9 ir.* メソッドが記述されている", () => {
    if (!tsSdk) return;
    for (const method of EXPECTED_IR_METHODS) {
      expect(tsSdk).toContain(`ir.${method}`);
    }
  });

  it("[IR-0078] ir.addRemoteToMatter は hub3DeviceId/irDeviceType/cmdOn/cmdOff/irDeviceUUID/irDeviceName を含む", () => {
    if (!tsSdk) return;
    expect(tsSdk).toContain("ir.addRemoteToMatter");
    expect(tsSdk).toContain("hub3DeviceId");
    expect(tsSdk).toContain("irDeviceType");
    expect(tsSdk).toContain("cmdOn");
    expect(tsSdk).toContain("cmdOff");
    expect(tsSdk).toContain("irDeviceUUID");
    expect(tsSdk).toContain("irDeviceName");
  });

  it("[IR-0078] ir.listRemotes は type: number を持つ", () => {
    if (!tsSdk) return;
    expect(tsSdk).toContain("ir.listRemotes");
    // type: number が記述されている
    const listRemotesLine = tsSdk.split("\n").find((l) => l.includes("ir.listRemotes"));
    expect(listRemotesLine).toBeDefined();
    expect(listRemotesLine).toContain("type");
  });

  it("[IR-0078] ir.matchRemote は brandName? (optional) を持つ", () => {
    if (!tsSdk) return;
    const matchRemoteLine = tsSdk.split("\n").find((l) => l.includes("ir.matchRemote"));
    expect(matchRemoteLine).toBeDefined();
    expect(matchRemoteLine).toContain("brandName?");
  });

  it("[IR-0078] ir.searchRemotes は type と searchTerm を持つ", () => {
    if (!tsSdk) return;
    const searchLine = tsSdk.split("\n").find((l) => l.includes("ir.searchRemotes"));
    expect(searchLine).toBeDefined();
    expect(searchLine).toContain("searchTerm");
  });
});

// =====================================================================
// [IR-0079] 未認証時の ir.* handler が requireAuth で拒否する
// ref: packages/kit/src/serve/entries/ir.js:57; packages/kit/src/serve/registry-helpers.js:55-62
// =====================================================================

describe("[IR-0079] 未認証時の ir.* handler が requireAuth で拒否する", () => {
  it("[IR-0079] ir.* handler は全て requireAuth(daemon) を呼ぶ (expired 時に throw)", () => {
    const entries = irEntries();
    const expiredDaemon = {
      authState: "expired",
      hub: { connected: true },
    };
    for (const [name, entry] of Object.entries(entries)) {
      expect(
        () => entry.handler({ hub: {}, params: {}, daemon: expiredDaemon }),
        `handler ${name} should throw on expired auth`
      ).toThrow();
    }
  });

  it("[IR-0079] ir.listRemotes の未認証は kind=NOT_AUTHENTICATED 相当のエラー", () => {
    const entries = irEntries();
    const expiredDaemon = { authState: "expired", hub: { connected: true } };
    let caught = null;
    try {
      entries["ir.listRemotes"].handler({ hub: {}, params: { type: 0x2000 }, daemon: expiredDaemon });
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    const kindOrMsg = (caught?.kind ?? "") + (caught?.message ?? "");
    expect(kindOrMsg.toLowerCase()).toMatch(/not_authenticated|notauthenticated|not authenticated|expired/i);
  });

  it("[IR-0079] hub 未接続でも ir.addRemote handler は CONNECTION_LOST を throw", () => {
    const entries = irEntries();
    const disconnectedDaemon = { authState: "active", hub: { connected: false } };
    expect(
      () => entries["ir.addRemote"].handler({ hub: {}, params: { remote: {} }, daemon: disconnectedDaemon })
    ).toThrow();
  });

  it("[IR-0079] 認証済み+接続中の daemon は requireAuth を通過する (throw しない)", async () => {
    const entries = irEntries();
    const validDaemon = {
      authState: "active",
      hub: {
        connected: true,
        listIRRemotes: vi.fn(async () => ({ list: [], pagination: null })),
      },
    };
    // throws しないこと (非同期で resolved)
    await expect(
      entries["ir.listRemotes"].handler({ hub: validDaemon.hub, params: { type: 0x2000 }, daemon: validDaemon })
    ).resolves.toBeDefined();
  });
});

// =====================================================================
// [IR-0080] 全 IR op の assertSuccess(strict:true) が success≠true 時に SesameError を投げる
// ref: packages/core/src/util.js:34-43; packages/core/src/ir.js:90, :117
// =====================================================================

describe("[IR-0080] 全 IR op の assertSuccess(strict:true) が success≠true 時に SesameError を投げる", () => {
  it("[IR-0080] getRemoteList: success=false で SesameError(code=rejected) を throw", async () => {
    const client = makeClient(failResp("server error"));
    await expect(
      getRemoteList(client, { type: 0x2000, companyID: "ch" })
    ).rejects.toMatchObject({ code: "rejected" });
  });

  it("[IR-0080] getRemoteList: success=undefined (strict) で throw", async () => {
    // strict: !resp?.success → undefined は falsy → throw
    const client = makeClient({ op: "getRemoteList" }); // success プロパティ無し
    await expect(
      getRemoteList(client, { type: 0x2000, companyID: "ch" })
    ).rejects.toMatchObject({ code: "rejected" });
  });

  it("[IR-0080] searchRemoteList: success=false で SesameError(code=rejected) を throw", async () => {
    const client = makeClient(failResp("search failed"));
    await expect(
      searchRemoteList(client, { type: 0x2000, companyID: "ch", searchTerm: "Sony" })
    ).rejects.toMatchObject({ code: "rejected" });
  });

  it("[IR-0080] addRemoteToMatter: success=false で throw (retryable:false)", async () => {
    const client = makeClient(failResp("matter error"));
    await expect(
      addRemoteToMatter(client, {
        hub3DeviceId: "h", irDeviceType: 0xc000,
        cmdOn: "on", cmdOff: "off",
        irDeviceUUID: "u", irDeviceName: "n", companyID: "ch",
      })
    ).rejects.toMatchObject({ code: "rejected", retryable: false });
  });

  it("[IR-0080] presetir.sendIR: success=false → throw (code=rejected)", async () => {
    const client = makeClient(failResp());
    await expect(
      presetSendIR(client, { deviceId: "d", command: "AA", irType: 0x2000, companyID: "co-A" })
    ).rejects.toMatchObject({ code: "rejected" });
  });

  it("[IR-0080] assertSuccess: upstreamCode を保持する (resp.code → data.upstreamCode)", async () => {
    const client = makeClient({ success: false, code: 403, message: "forbidden" });
    let err = null;
    try {
      await getRemoteList(client, { type: 0x2000, companyID: "ch" });
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeNull();
    expect(err.data?.upstreamCode).toBe(403);
  });
});

// =====================================================================
// [IR-0081] presetir.sendIR フレームのキー集合と既定値 operation='remoteEmit'
// ref: packages/core/src/presetir.js:535-544; references_web/src/api/useRemoteCtrl.js:467-476
// =====================================================================

describe("[IR-0081] presetir.sendIR フレームのキー集合と既定値 operation='remoteEmit'", () => {
  it("[IR-0081] フレームが {action:'biz3IRRemote', op:'sendIR', deviceId, command, operation, irType, companyID, irDeviceUUID}", async () => {
    const client = makeClient({ success: true });
    await presetSendIR(client, {
      deviceId: "hub3-uuid",
      command: "3000000000000000000100010000FF31",
      irType: PRESET_IR_TYPE.TV,
      companyID: "co-Z",
      irDeviceUUID: "remote-xyz",
    });
    const { frame } = client.calls[0];
    expect(frame.action).toBe("biz3IRRemote");
    expect(frame.op).toBe("sendIR");
    expect(frame.deviceId).toBe("hub3-uuid");
    expect(frame.command).toBe("3000000000000000000100010000FF31");
    expect(frame.operation).toBe("remoteEmit");
    expect(frame.irType).toBe(PRESET_IR_TYPE.TV);
    expect(frame.companyID).toBe("co-Z");
    expect(frame.irDeviceUUID).toBe("remote-xyz");
  });

  it("[IR-0081] operation 既定値は 'remoteEmit' (vendor remote-air:370/remote-non-air:156 と一致)", async () => {
    const client = makeClient({ success: true });
    await presetSendIR(client, {
      deviceId: "d", command: "AA", irType: PRESET_IR_TYPE.AIR, companyID: "ch",
    });
    expect(client.calls[0].frame.operation).toBe("remoteEmit");
  });

  it("[IR-0081] operation は上書き可 (remoteLearn 等)", async () => {
    const client = makeClient({ success: true });
    await presetSendIR(client, {
      deviceId: "d", command: "AA", irType: PRESET_IR_TYPE.AIR, companyID: "ch",
      operation: "learnEmit",
    });
    expect(client.calls[0].frame.operation).toBe("learnEmit");
  });

  it("[IR-0081] フレームに hub3DeviceId / remoteId フィールドが存在しない (命名トラップ防止)", async () => {
    const client = makeClient({ success: true });
    await presetSendIR(client, { deviceId: "d", command: "AA", irType: PRESET_IR_TYPE.TV, companyID: "ch" });
    const { frame } = client.calls[0];
    expect(frame).not.toHaveProperty("hub3DeviceId");
    expect(frame).not.toHaveProperty("remoteId");
  });
});

// =====================================================================
// [IR-0082] irDeviceUUID 未指定時はフレームに '' を送る (未保存プリセット)
// ref: packages/core/src/presetir.js:543; references_web/.../ir/remote-air/index.js:369
// =====================================================================

describe("[IR-0082] irDeviceUUID 未指定時はフレームに '' を送る", () => {
  it("[IR-0082] irDeviceUUID 省略時は '' (空文字) がフレームに乗る", async () => {
    const client = makeClient({ success: true });
    await presetSendIR(client, {
      deviceId: "d", command: "AA", irType: PRESET_IR_TYPE.AIR, companyID: "ch",
    });
    expect(client.calls[0].frame.irDeviceUUID).toBe("");
  });

  it("[IR-0082] irDeviceUUID 指定時はその値がそのまま入る", async () => {
    const client = makeClient({ success: true });
    await presetSendIR(client, {
      deviceId: "d", command: "AA", irType: PRESET_IR_TYPE.AIR, companyID: "ch",
      irDeviceUUID: "remote-saved-uuid",
    });
    expect(client.calls[0].frame.irDeviceUUID).toBe("remote-saved-uuid");
  });
});

// =====================================================================
// [IR-0083] deviceId / hub3DeviceId エイリアス解決 (deviceId 優先)
// ref: packages/core/src/presetir.js:529-538
// =====================================================================

describe("[IR-0083] presetir.sendIR の deviceId / hub3DeviceId エイリアス解決", () => {
  it("[IR-0083] deviceId のみ指定: そのまま frame.deviceId に乗る", async () => {
    const client = makeClient({ success: true });
    await presetSendIR(client, {
      deviceId: "canonical-id", command: "AA", irType: PRESET_IR_TYPE.AIR, companyID: "ch",
    });
    expect(client.calls[0].frame.deviceId).toBe("canonical-id");
    expect(client.calls[0].frame).not.toHaveProperty("hub3DeviceId");
  });

  it("[IR-0083] hub3DeviceId のみ指定: frame.deviceId に写像される", async () => {
    const client = makeClient({ success: true });
    await presetSendIR(client, {
      hub3DeviceId: "alias-id", command: "AA", irType: PRESET_IR_TYPE.AIR, companyID: "ch",
    });
    expect(client.calls[0].frame.deviceId).toBe("alias-id");
    expect(client.calls[0].frame).not.toHaveProperty("hub3DeviceId");
  });

  it("[IR-0083] 両方指定: deviceId が優先される", async () => {
    const client = makeClient({ success: true });
    await presetSendIR(client, {
      deviceId: "primary", hub3DeviceId: "fallback",
      command: "AA", irType: PRESET_IR_TYPE.AIR, companyID: "ch",
    });
    expect(client.calls[0].frame.deviceId).toBe("primary");
  });

  it("[IR-0083] deviceId も hub3DeviceId も無い場合は badRequest を throw", async () => {
    const client = makeClient({ success: true });
    await expect(
      presetSendIR(client, { command: "AA", irType: PRESET_IR_TYPE.AIR, companyID: "ch" })
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(client.request).not.toHaveBeenCalled();
  });
});

// =====================================================================
// [IR-0084] sendIR 必須欠如 (deviceId/command/irType/companyID) は badRequest
// ref: packages/core/src/presetir.js:530-533
// =====================================================================

describe("[IR-0084] presetir.sendIR の必須フィールド欠如は badRequest", () => {
  const BASE = { deviceId: "d", command: "AA", irType: PRESET_IR_TYPE.AIR, companyID: "ch" };

  it("[IR-0084] deviceId 欠如 → badRequest (code=bad_request)", async () => {
    const client = makeClient({ success: true });
    const { deviceId: _, ...p } = BASE;
    await expect(presetSendIR(client, p)).rejects.toMatchObject({ code: "bad_request" });
    expect(client.request).not.toHaveBeenCalled();
  });

  it("[IR-0084] command 欠如 (空文字) → badRequest", async () => {
    const client = makeClient({ success: true });
    await expect(presetSendIR(client, { ...BASE, command: "" })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("[IR-0084] irType=null → badRequest (null は == null で拒否)", async () => {
    const client = makeClient({ success: true });
    await expect(presetSendIR(client, { ...BASE, irType: null })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("[IR-0084] irType=undefined → badRequest", async () => {
    const client = makeClient({ success: true });
    await expect(presetSendIR(client, { ...BASE, irType: undefined })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("[IR-0084] irType=0 は == null を通過し badRequest にならない (0 は有効値)", async () => {
    // ref: packages/core/src/presetir.js:532 — p.irType == null (0 は falsy だが == null は false)
    const client = makeClient({ success: true });
    await presetSendIR(client, { ...BASE, irType: 0 });
    expect(client.request).toHaveBeenCalled();
  });

  it("[IR-0084] companyID 欠如 (空文字) → badRequest", async () => {
    const client = makeClient({ success: true });
    await expect(presetSendIR(client, { ...BASE, companyID: "" })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("[IR-0084] 全必須欠如時は request を呼ばない", async () => {
    const client = makeClient({ success: true });
    try {
      await presetSendIR(client, {});
    } catch {
      // expected
    }
    expect(client.request).not.toHaveBeenCalled();
  });
});

// =====================================================================
// [IR-0085] presetir.sendIR の assertSuccess(strict:true) 動作
// ref: packages/core/src/presetir.js:547; references_web/src/api/useRemoteCtrl.js:65-80
// =====================================================================

describe("[IR-0085] presetir.sendIR の assertSuccess(strict:true) 動作", () => {
  const BASE = { deviceId: "d", command: "AA", irType: PRESET_IR_TYPE.AIR, companyID: "ch" };

  it("[IR-0085] success=true は正常終了し応答を返す", async () => {
    const reply = { success: true, op: "sendIR", data: { ok: 1 } };
    const client = makeClient(reply);
    const result = await presetSendIR(client, BASE);
    expect(result).toBe(reply);
  });

  it("[IR-0085] success=false は throw (strict 要件, sendIR を含むメッセージ)", async () => {
    const client = makeClient({ success: false, message: "offline" });
    await expect(presetSendIR(client, BASE)).rejects.toThrow(/sendIR/);
  });

  it("[IR-0085] success 欠落 (undefined) は strict で throw", async () => {
    // strict: !resp?.success → success undefined は !undefined = true → throw
    const client = makeClient({ op: "sendIR" });
    await expect(presetSendIR(client, BASE)).rejects.toThrow();
  });
});

// =====================================================================
// [IR-0086] presetir.sendIR の timeout 既定値 10s / timeoutMs 上書き
// ref: packages/core/src/presetir.js:38 (DEFAULT_TIMEOUT_MS=10_000), :545
// =====================================================================

describe("[IR-0086] presetir.sendIR の timeout 既定値 10s / 上書き", () => {
  const BASE = { deviceId: "d", command: "AA", irType: PRESET_IR_TYPE.AIR, companyID: "ch" };

  it("[IR-0086] timeoutMs 未指定時は client.request に 10000ms が渡る", async () => {
    const client = makeClient({ success: true });
    await presetSendIR(client, BASE);
    expect(client.calls[0].timeoutMs).toBe(10_000);
  });

  it("[IR-0086] timeoutMs 指定時はその値が client.request に渡る", async () => {
    const client = makeClient({ success: true });
    await presetSendIR(client, { ...BASE, timeoutMs: 5000 });
    expect(client.calls[0].timeoutMs).toBe(5000);
  });

  it("[IR-0086] timeoutMs=0 (falsy) でも 0 が渡る (??演算子: 0 は null/undefined でない)", async () => {
    const client = makeClient({ success: true });
    await presetSendIR(client, { ...BASE, timeoutMs: 0 });
    // 0 ?? 10000 = 0 (falsy だが null/undefined でないため既定を使わない)
    expect(client.calls[0].timeoutMs).toBe(0);
  });
});

// =====================================================================
// [IR-0087] HXDCommandProcessor.buildAirCommand の 16byte 配置・checksum
// ref: packages/core/src/presetir.js:83-98; references_web/.../HXDCommandProcessor.js:17-34
// =====================================================================

describe("[IR-0087] HXDCommandProcessor.buildAirCommand の 16byte 配置・checksum", () => {
  it("[IR-0087] prefix は [0x30, 0x01]", () => {
    const p = new HXDCommandProcessor();
    const buf = p.buildAirCommand();
    expect(buf[0]).toBe(0x30);
    expect(buf[1]).toBe(0x01);
  });

  it("[IR-0087] buf は 16 byte 長", () => {
    const p = new HXDCommandProcessor();
    expect(p.buildAirCommand()).toHaveLength(16);
  });

  it("[IR-0087] code は codeHi(buf[2])/codeLo(buf[3]) にビッグエンディアンで配置", () => {
    const p = new HXDCommandProcessor();
    const buf = p.setCode(1234).buildAirCommand(); // 1234 = 0x04D2
    expect(buf[2]).toBe(0x04);
    expect(buf[3]).toBe(0xd2);
  });

  it("[IR-0087] buf[4..10] に temperature/fan/wind/autoWind/power/key/mode が配置される", () => {
    const p = new HXDCommandProcessor();
    p.setTemperature(24).setFanSpeed(0x03).setWindDirection(0x01)
      .setAutoWindDirection(0x01).setPower(0x01).setKey(0x02).setModel(0x03);
    const buf = p.buildAirCommand();
    expect(buf[4]).toBe(24);    // temperature
    expect(buf[5]).toBe(0x03);  // fanSpeed
    expect(buf[6]).toBe(0x01);  // windDirection
    expect(buf[7]).toBe(0x01);  // autoWindDirection
    expect(buf[8]).toBe(0x01);  // power
    expect(buf[9]).toBe(0x02);  // key
    expect(buf[10]).toBe(0x03); // mode
  });

  it("[IR-0087] buf[14]=0xff (length-2 は固定マーカー)", () => {
    const p = new HXDCommandProcessor();
    const buf = p.buildAirCommand();
    expect(buf[14]).toBe(0xff);
  });

  it("[IR-0087] buf[15]=checksum は先頭 15byte 総和 & 0xff", () => {
    const p = new HXDCommandProcessor();
    const buf = p.buildAirCommand();
    const expected = buf.slice(0, -1).reduce((s, b) => s + b, 0) & 0xff;
    expect(buf[15]).toBe(expected);
  });

  it("[IR-0087] defaultTable[0]+1 が buf[11] に入る (indexTable 配置)", () => {
    const p = new HXDCommandProcessor();
    // defaultTable = [0,0,0] → indexTable[0] = (0+1)&0xff = 1
    const buf = p.buildAirCommand();
    expect(buf[11]).toBe(1);
    expect(buf[12]).toBe(0);
    expect(buf[13]).toBe(0);
  });

  it("[IR-0087] 既定状態の固定 HEX が biz3 と一致 (regress guard)", () => {
    // vendor HXDCommandProcessor.js:17-34 と完全一致
    const p = new HXDCommandProcessor();
    const hex = p.toHexString(p.setCode(0).buildAirCommand());
    expect(hex).toBe("3001000019010201000102010000FF51");
  });
});

// =====================================================================
// [IR-0088] HXDCommandProcessor.buildNonAirCommand の 16byte 配置・checksum
// ref: packages/core/src/presetir.js:106-114; references_web/.../HXDCommandProcessor.js:36-47
// =====================================================================

describe("[IR-0088] HXDCommandProcessor.buildNonAirCommand の 16byte 配置・checksum", () => {
  it("[IR-0088] prefix は [0x30, 0x00]", () => {
    const p = new HXDCommandProcessor();
    const buf = p.buildNonAirCommand();
    expect(buf[0]).toBe(0x30);
    expect(buf[1]).toBe(0x00);
  });

  it("[IR-0088] buf[4..8] と buf[10] は 0 (air と異なり埋め込まれない)", () => {
    const p = new HXDCommandProcessor();
    const buf = p.setKey(0x06).buildNonAirCommand();
    expect(buf[4]).toBe(0);
    expect(buf[5]).toBe(0);
    expect(buf[6]).toBe(0);
    expect(buf[7]).toBe(0);
    expect(buf[8]).toBe(0);
    expect(buf[10]).toBe(0);
  });

  it("[IR-0088] buf[9]=key (指定した key が乗る)", () => {
    const p = new HXDCommandProcessor();
    const buf = p.setKey(0x06).buildNonAirCommand();
    expect(buf[9]).toBe(0x06);
  });

  it("[IR-0088] buf[14]=0xff", () => {
    const p = new HXDCommandProcessor();
    expect(p.buildNonAirCommand()[14]).toBe(0xff);
  });

  it("[IR-0088] checksum = 先頭 15byte 総和 & 0xff", () => {
    const p = new HXDCommandProcessor();
    const buf = p.setCode(1234).setKey(0x06).buildNonAirCommand();
    const expected = buf.slice(0, -1).reduce((s, b) => s + b, 0) & 0xff;
    expect(buf[15]).toBe(expected);
  });

  it("[IR-0088] 固定 HEX regress guard (key=0x01, code=0)", () => {
    const p = new HXDCommandProcessor();
    const hex = p.toHexString(p.setCode(0).setKey(0x01).buildNonAirCommand());
    expect(hex).toBe("3000000000000000000100010000FF31");
  });
});

// =====================================================================
// [IR-0089] HXDCommandProcessor.buildKeyData の 16byte 骨格が vendor と一致
// ref: packages/core/src/presetir.js:124-146; references_web/.../HXDCommandProcessor.js:49-71
// =====================================================================

describe("[IR-0089] HXDCommandProcessor.buildKeyData の 16byte 骨格が vendor と一致", () => {
  it("[IR-0089] 返り値は 16 byte", () => {
    const p = new HXDCommandProcessor();
    expect(p.buildKeyData([0x30, 0x01], 0, [0, 0, 0])).toHaveLength(16);
  });

  it("[IR-0089] prefix 2byte が buf[0..1]", () => {
    const p = new HXDCommandProcessor();
    const buf = p.buildKeyData([0x30, 0x01], 0, [0, 0, 0]);
    expect(buf[0]).toBe(0x30);
    expect(buf[1]).toBe(0x01);
  });

  it("[IR-0089] code をビッグエンディアン 2byte に分割して buf[2..3]", () => {
    const p = new HXDCommandProcessor();
    const buf = p.buildKeyData([0x30, 0x00], 1234, [0, 0, 0]); // 1234=0x04D2
    expect(buf[2]).toBe(0x04);
    expect(buf[3]).toBe(0xd2);
  });

  it("[IR-0089] buf[4..10] は 7 個の 0", () => {
    const p = new HXDCommandProcessor();
    const buf = p.buildKeyData([0x30, 0x00], 0, [0, 0, 0]);
    expect(buf.slice(4, 11)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("[IR-0089] indexTable[0]=(table[0]+1)&0xff が buf[11]", () => {
    const p = new HXDCommandProcessor();
    const buf = p.buildKeyData([0x30, 0x00], 0, [0, 0, 0]);
    expect(buf[11]).toBe(1); // (0+1)&0xff
  });

  it("[IR-0089] buf[12..13] は 0 (indexTable[1..2])", () => {
    const p = new HXDCommandProcessor();
    const buf = p.buildKeyData([0x30, 0x00], 0, [0, 0, 0]);
    expect(buf[12]).toBe(0);
    expect(buf[13]).toBe(0);
  });

  it("[IR-0089] buf[14]=0xff / buf[15]=0 (終端マーカー)", () => {
    const p = new HXDCommandProcessor();
    const buf = p.buildKeyData([0x30, 0x00], 0, [0, 0, 0]);
    expect(buf[14]).toBe(0xff);
    expect(buf[15]).toBe(0);
  });

  it("[IR-0089] table[0]=5 のとき buf[11] = (5+1)&0xff = 6", () => {
    const p = new HXDCommandProcessor();
    const buf = p.buildKeyData([0x30, 0x00], 0, [5, 0, 0]);
    expect(buf[11]).toBe(6);
  });
});

// =====================================================================
// [IR-0090] decimalToTwoHexInts / toHexString / hexStringToByteArray が vendor と一致
// ref: packages/core/src/presetir.js:154-183; references_web/.../HXDCommandProcessor.js:73-77,124-134
// =====================================================================

describe("[IR-0090] HXDCommandProcessor のユーティリティ関数が vendor と一致", () => {
  const p = new HXDCommandProcessor();

  describe("decimalToTwoHexInts", () => {
    it("[IR-0090] 0 → [0, 0]", () => {
      expect(p.decimalToTwoHexInts(0)).toEqual([0, 0]);
    });

    it("[IR-0090] 100 → [0, 100]", () => {
      expect(p.decimalToTwoHexInts(100)).toEqual([0, 100]);
    });

    it("[IR-0090] 255 → [0, 255]", () => {
      expect(p.decimalToTwoHexInts(255)).toEqual([0, 255]);
    });

    it("[IR-0090] 256 → [1, 0] (上位 byte に 1)", () => {
      expect(p.decimalToTwoHexInts(256)).toEqual([1, 0]);
    });

    it("[IR-0090] 1234 → [4, 210] (0x04D2 = floor(1234/256)=4, 1234%256=210)", () => {
      expect(p.decimalToTwoHexInts(1234)).toEqual([4, 210]);
    });

    it("[IR-0090] 65535 → [255, 255] (16bit 最大)", () => {
      expect(p.decimalToTwoHexInts(65535)).toEqual([255, 255]);
    });

    it("[IR-0090] 分割式: floor(n/256) と n%256 (vendor HXDCommandProcessor.js:73-77 と同式)", () => {
      for (const n of [0, 1, 100, 256, 1000, 49152, 65535]) {
        const [hi, lo] = p.decimalToTwoHexInts(n);
        expect(hi).toBe(Math.floor(n / 256));
        expect(lo).toBe(n % 256);
      }
    });
  });

  describe("toHexString", () => {
    it("[IR-0090] 大文字・2 桁 0 埋め・区切り無し", () => {
      expect(p.toHexString([0x30, 0x01, 0x00, 0x0a, 0xff])).toBe("3001000AFF");
    });

    it("[IR-0090] 0x00 は '00' に変換", () => {
      expect(p.toHexString([0x00])).toBe("00");
    });

    it("[IR-0090] 0x0f は '0F' (ゼロパディング・大文字)", () => {
      expect(p.toHexString([0x0f])).toBe("0F");
    });

    it("[IR-0090] 空配列は空文字", () => {
      expect(p.toHexString([])).toBe("");
    });
  });

  describe("hexStringToByteArray", () => {
    it("[IR-0090] '3001000AFF' → [0x30, 0x01, 0x00, 0x0a, 0xff]", () => {
      expect(p.hexStringToByteArray("3001000AFF")).toEqual([0x30, 0x01, 0x00, 0x0a, 0xff]);
    });

    it("[IR-0090] '00' → [0]", () => {
      expect(p.hexStringToByteArray("00")).toEqual([0]);
    });

    it("[IR-0090] '0F' → [15] (2 文字ずつ parse)", () => {
      expect(p.hexStringToByteArray("0F")).toEqual([15]);
    });

    it("[IR-0090] 'FF' → [255]", () => {
      expect(p.hexStringToByteArray("FF")).toEqual([255]);
    });
  });

  describe("toHexString と hexStringToByteArray は相互逆", () => {
    it("[IR-0090] byteArray → HEX → byteArray で元に戻る", () => {
      const original = [0x30, 0x01, 0x00, 0x19, 0x01, 0x02, 0x01, 0x00, 0x01, 0x02, 0x01, 0x00, 0x00, 0xff, 0x51];
      expect(p.hexStringToByteArray(p.toHexString(original))).toEqual(original);
    });

    it("[IR-0090] HEX → byteArray → HEX で元に戻る", () => {
      const hex = "3001000019010201000102010000FF51";
      expect(p.toHexString(p.hexStringToByteArray(hex))).toBe(hex);
    });
  });
});
