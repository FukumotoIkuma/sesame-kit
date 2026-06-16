// packages/core/tests/_spec/org-c4.test.js
// TDD テスト: ORG-0073 〜 ORG-0090
//
// 統合方針:
//   - A/B 両実装を読み比べ、spec・実装忠実性の高い方を採用。
//   - 各 it 先頭に [<ID>] を付与。全 18 spec を 1 ファイルで被覆。
//   - assert は spec どおりの期待値 (実装の現状に合わせず red 許容)。
//   - ネットワーク/実機不使用 — mock/純関数のみ。
//
// 一次参照:
//   packages/core/src/org.js:612-679
//   packages/core/src/client.js:333-353 (_bindNs)
//   packages/core/src/i18n/org.js
//   packages/kit/src/cli/org.js:635-718
//   references_web/src/api/useManageGroup.js:106-161

import { describe, it, expect, vi, afterEach } from "vitest";
import * as org from "../../src/org.js";
import { mockClient } from "../helpers/mock-ws.js";
import { cmacTime } from "../../src/crypto.js";
import { Command } from "commander";
import { registerOrgCommands } from "../../../kit/src/cli/org.js";
import i18nCatalogue from "../../src/i18n/org.js";

// ─── CLI test infrastructure ──────────────────────────────────────────────────

/**
 * 最小限の CLI ctx を生成する。
 * die() は Error を throw するため parseAsync() が reject する (expect().rejects で検証可)。
 */
function makeCtx({ hub, json = false } = {}) {
  const outputs = [];
  return {
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
// ORG-0073  hub.org.* 経由で companyID/subUUID 自動注入 (_bindNs)
// ref: packages/core/src/client.js:333-353
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0073] hub.org.* companyID/subUUID 自動注入 (_bindNs)", () => {
  // _bindNs の動作:
  //   out[name] = (params = {}) => fn(ws, { companyID, subUUID, ...params })
  // params が優先するため、明示指定で上書きできる。

  it("[ORG-0073] companyID が省略されると config の companyID が注入される", async () => {
    const sent = [];
    const fakeWs = {
      async request(frame) { sent.push(frame); return { success: true, data: [] }; },
      send() {},
      subscribe() { return () => {}; },
    };
    // _bindNs が注入する companyID/subUUID をシミュレート
    const companyID = "ch_injected";
    const subUUID = "sub_injected";
    const injectedCall = (params = {}) =>
      org.getEmployeeGroups(fakeWs, { companyID, subUUID, ...params });

    await injectedCall();
    // getEmployeeGroups は cid: companyID でフレームを送る
    expect(sent[0]).toMatchObject({ action: "biz3ManageEmployeeGroup", cid: "ch_injected" });
  });

  it("[ORG-0073] params で明示した companyID は注入値を上書きする (params 優先)", async () => {
    const sent = [];
    const fakeWs = {
      async request(frame) { sent.push(frame); return { success: true, data: [] }; },
      send() {},
      subscribe() { return () => {}; },
    };
    const companyID = "ch_injected";
    const subUUID = "sub_injected";
    const injectedCall = (params = {}) =>
      org.getEmployeeGroups(fakeWs, { companyID, subUUID, ...params });

    await injectedCall({ companyID: "ch_override" });
    expect(sent[0]).toMatchObject({ cid: "ch_override" });
  });

  it("[ORG-0073] subUUID も同様に注入される (getEmployeeDeviceKeys の場合)", async () => {
    const sent = [];
    const fakeWs = {
      async request(frame) { sent.push(frame); return { success: true, data: [] }; },
      send() {},
      subscribe() { return () => {}; },
    };
    const companyID = "ch_X";
    const subUUID = "sub_Y";
    // _bindNs: { companyID, subUUID, ...params } で spread するため
    // params.subUUID が undefined のとき注入値が残る
    const injectedCall = (params = {}) =>
      org.getEmployeeDeviceKeys(fakeWs, { companyID, subUUID, ...params });

    await injectedCall();
    expect(sent[0]).toMatchObject({ subUUID: "sub_Y" });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0074  i18n org.group/role/deviceGroup/err カタログ en/ja 完全性
// ref: packages/core/src/i18n/org.js
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0074] i18n org.group*/org.role*/org.deviceGroup* en/ja 完全性", () => {
  const { en, ja } = i18nCatalogue;

  // spec で必須と明示されたキー群
  const requiredKeys = [
    // org.req.*
    "org.req.gidsArray",
    "org.req.groupIdsArray",
    // org.err.*
    "org.err.uuidsItemsArray",
    // org.group.*
    "org.group.ls.desc",
    "org.group.ls.none",
    "org.group.ls.found",
    "org.group.add.desc",
    "org.group.add.need",
    "org.group.add.ok",
    "org.group.add.okId",
    "org.group.rm.desc",
    "org.group.rm.need",
    "org.group.rm.ok",
    "org.group.addUsers.desc",
    "org.group.addUsers.need",
    "org.group.addUsers.ok",
    "org.group.rmUsers.desc",
    "org.group.rmUsers.need",
    "org.group.rmUsers.ok",
    "org.group.rmDeviceGroup.desc",
    // org.role.*
    "org.role.ls.desc",
    "org.role.ls.none",
    "org.role.ls.found",
    "org.role.post.desc",
    "org.role.post.need",
    "org.role.post.ok",
    "org.role.rm.desc",
    "org.role.rm.need",
    "org.role.rm.ok",
    // org.deviceGroup.*
    "org.deviceGroup.ls.desc",
    "org.deviceGroup.ls.none",
    "org.deviceGroup.ls.found",
    "org.deviceGroup.add.desc",
    "org.deviceGroup.add.ok",
    "org.deviceGroup.rm.desc",
    "org.deviceGroup.rm.need",
    "org.deviceGroup.rm.ok",
    "org.deviceGroup.addDevices.desc",
    "org.deviceGroup.addDevices.need",
    "org.deviceGroup.addDevices.ok",
    "org.deviceGroup.rmDevices.desc",
    "org.deviceGroup.rmDevices.need",
    "org.deviceGroup.rmDevices.ok",
  ];

  it("[ORG-0074] en ブロックに必須キーが全て存在する", () => {
    for (const key of requiredKeys) {
      expect(en, `missing en key: ${key}`).toHaveProperty(key);
      expect(typeof en[key]).toBe("string");
    }
  });

  it("[ORG-0074] ja ブロックに必須キーが全て存在する", () => {
    for (const key of requiredKeys) {
      expect(ja, `missing ja key: ${key}`).toHaveProperty(key);
      expect(typeof ja[key]).toBe("string");
    }
  });

  it("[ORG-0074] org.req.gidsArray が en/ja 双方で定義される", () => {
    expect(en["org.req.gidsArray"]).toBeTruthy();
    expect(ja["org.req.gidsArray"]).toBeTruthy();
  });

  it("[ORG-0074] org.req.groupIdsArray が en/ja 双方で定義される", () => {
    expect(en["org.req.groupIdsArray"]).toBeTruthy();
    expect(ja["org.req.groupIdsArray"]).toBeTruthy();
  });

  it("[ORG-0074] org.err.uuidsItemsArray が en/ja 双方で定義される", () => {
    expect(en["org.err.uuidsItemsArray"]).toBeTruthy();
    expect(ja["org.err.uuidsItemsArray"]).toBeTruthy();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0075  shareDeviceKeysToEmployees wire:
//           {action:'biz3ManageEmployeeDevice', items, op:'add'} で companyID を送らない
// ref: packages/core/src/org.js:612; references_web/src/api/useManageGroup.js:106-119
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0075] shareDeviceKeysToEmployees wire フレーム (companyID 無し)", () => {
  it("[ORG-0075] フレームが {action:'biz3ManageEmployeeDevice', items, op:'add'} でトップレベル companyID を持たない", async () => {
    const items = [
      { deviceUUID: "d1", secretKey: "sk1", subUUID: "u1", keyLevel: 1, startTime: "", endTime: "" },
    ];
    const c = mockClient({ success: true });
    await org.shareDeviceKeysToEmployees(c, { items });
    expect(c.sent).toHaveLength(1);
    const frame = c.sent[0];
    expect(frame.action).toBe("biz3ManageEmployeeDevice");
    expect(frame.items).toEqual(items);
    expect(frame.op).toBe("add");
    expect(frame).not.toHaveProperty("companyID");
  });

  it("[ORG-0075] items が配列でなければ badRequest を throw する", async () => {
    const c = mockClient({});
    await expect(
      org.shareDeviceKeysToEmployees(c, { items: { not: "array" } }),
    ).rejects.toThrow(/items must be an array/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0076  shareDeviceKeysToEmployees item 構築: startTime/endTime の条件分岐
//           常時利用は空文字 ''、一時利用は epoch 秒
// ref: references_web/src/pages/biz/devices/device-share/DeviceShare.js:65-76
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0076] shareDeviceKeysToEmployees item 構築 (startTime/endTime 契約)", () => {
  it("[ORG-0076] 常時利用 (keyLevel=1, startTime/endTime='') は空文字のまま透過される", async () => {
    const items = [
      { deviceUUID: "d1", secretKey: "sk1", subUUID: "u1", keyLevel: 1, startTime: "", endTime: "" },
    ];
    const c = mockClient({ success: true });
    await org.shareDeviceKeysToEmployees(c, { items });
    expect(c.sent[0].items[0].startTime).toBe("");
    expect(c.sent[0].items[0].endTime).toBe("");
    expect(c.sent[0].items[0].keyLevel).toBe(1);
  });

  it("[ORG-0076] 一時利用 (keyLevel=2, epoch 秒) の item はそのまま透過する", async () => {
    const c = mockClient({ success: true });
    const now = Math.floor(Date.now() / 1000);
    const items = [
      {
        deviceUUID: "d1", secretKey: "sk1", subUUID: "u1",
        keyLevel: 2,
        startTime: now,
        endTime: now + 3600,
      },
    ];
    await org.shareDeviceKeysToEmployees(c, { items });
    expect(c.sent[0].items[0].keyLevel).toBe(2);
    expect(typeof c.sent[0].items[0].startTime).toBe("number");
    expect(typeof c.sent[0].items[0].endTime).toBe("number");
  });

  it("[ORG-0076] device と user の spread 結果が item に統合されて透過される", async () => {
    const device = { deviceUUID: "d1", secretKey: "sk1", sesame2PublicKey: "pk1" };
    const user = { subUUID: "u1", employeeName: "Yamada" };
    const item = { ...device, ...user, keyLevel: 0, startTime: "", endTime: "" };
    const c = mockClient({ success: true });
    await org.shareDeviceKeysToEmployees(c, { items: [item] });
    const sentItem = c.sent[0].items[0];
    expect(sentItem.deviceUUID).toBe("d1");
    expect(sentItem.secretKey).toBe("sk1");
    expect(sentItem.subUUID).toBe("u1");
    expect(sentItem.employeeName).toBe("Yamada");
    expect(sentItem.keyLevel).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0077  CLI sesame org keys share: --json 必須・配列でないと exit 2
// ref: packages/kit/src/cli/org.js:647-665
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0077] sesame org keys share: --json 必須・非配列で die(2)", () => {
  it("[ORG-0077] --json 未指定で die (exit 2)", async () => {
    const hub = { org: { shareDeviceKeysToEmployees: vi.fn() } };
    const ctx = makeCtx({ hub });
    await expect(
      buildProgram(ctx).parseAsync(["org", "keys", "share"], { from: "user" }),
    ).rejects.toThrow();
    expect(hub.org.shareDeviceKeysToEmployees).not.toHaveBeenCalled();
  });

  it("[ORG-0077] --json が配列でなければ die (exit 2)", async () => {
    const hub = { org: { shareDeviceKeysToEmployees: vi.fn() } };
    const ctx = makeCtx({ hub });
    await expect(
      buildProgram(ctx).parseAsync(
        ["org", "keys", "share", "--json", '{"not":"array"}'],
        { from: "user" },
      ),
    ).rejects.toThrow();
    expect(hub.org.shareDeviceKeysToEmployees).not.toHaveBeenCalled();
  });

  it("[ORG-0077] 配列なら shareDeviceKeysToEmployees に items を渡す", async () => {
    const hub = {
      org: { shareDeviceKeysToEmployees: vi.fn(async () => ({ success: true })) },
    };
    const ctx = makeCtx({ hub, json: true });
    const items = [
      { deviceUUID: "d1", subUUID: "u1", keyLevel: 1, startTime: "", endTime: "" },
    ];
    await buildProgram(ctx).parseAsync(
      ["org", "keys", "share", "--json", JSON.stringify(items)],
      { from: "user" },
    );
    expect(hub.org.shareDeviceKeysToEmployees).toHaveBeenCalledWith({ items });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0078  CLI sesame org keys share 出力封筒:
//           human=org.keys.share.ok(n) / --json={ok:true,response}
// ref: packages/kit/src/cli/org.js:660-663
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0078] sesame org keys share 出力封筒 (human / --json)", () => {
  it("[ORG-0078] --json 時に {ok:true, response} 封筒を返す", async () => {
    const mockResp = { success: true };
    const hub = {
      org: { shareDeviceKeysToEmployees: vi.fn(async () => mockResp) },
    };
    const ctx = makeCtx({ hub, json: true });
    const items = [{ deviceUUID: "d1", subUUID: "u1", keyLevel: 1, startTime: "", endTime: "" }];
    await buildProgram(ctx).parseAsync(
      ["org", "keys", "share", "--json", JSON.stringify(items)],
      { from: "user" },
    );
    expect(ctx.outputs[0]).toEqual({ ok: true, response: mockResp });
  });

  it("[ORG-0078] human 出力時は console.log にメッセージを出力する (n=2 含む)", async () => {
    const hub = {
      org: { shareDeviceKeysToEmployees: vi.fn(async () => ({ success: true })) },
    };
    const ctx = makeCtx({ hub, json: false });
    const lines = [];
    vi.spyOn(console, "log").mockImplementation((s) => lines.push(String(s)));
    const items = [
      { deviceUUID: "d1", subUUID: "u1", keyLevel: 1, startTime: "", endTime: "" },
      { deviceUUID: "d2", subUUID: "u2", keyLevel: 1, startTime: "", endTime: "" },
    ];
    await buildProgram(ctx).parseAsync(
      ["org", "keys", "share", "--json", JSON.stringify(items)],
      { from: "user" },
    );
    // org.keys.share.ok(n=2) を含む行が出力されること
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes("2"))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0079  shareDeviceGroupKeysToEmployeeGroup wire:
//           {action:'biz3ManageEmployeeDevice', ...item, companyID, op:'group'}
//           キー名は 'companyID' (cid ではない)
// ref: packages/core/src/org.js:632-640; references_web/src/api/useManageGroup.js:121-135
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0079] shareDeviceGroupKeysToEmployeeGroup wire フレーム", () => {
  it("[ORG-0079] フレームは {action, ...item, companyID(cid 不可), op:'group'}", async () => {
    const item = {
      keyLevel: "1",
      members: ["u1"],
      devices: ["d1"],
      mid: "m1",
      dids: ["dg1"],
      startTime: "",
      endTime: "",
    };
    const c = mockClient({ success: true });
    await org.shareDeviceGroupKeysToEmployeeGroup(c, { companyID: "cmp-X", item });
    const frame = c.sent[0];
    expect(frame.action).toBe("biz3ManageEmployeeDevice");
    expect(frame.op).toBe("group");
    expect(frame.companyID).toBe("cmp-X");
    // item の全フィールドが spread されてフレーム直置き
    expect(frame.keyLevel).toBe("1");
    expect(frame.members).toEqual(["u1"]);
    expect(frame.devices).toEqual(["d1"]);
    expect(frame.mid).toBe("m1");
    expect(frame.dids).toEqual(["dg1"]);
    // 'cid' キーは使わない
    expect(frame).not.toHaveProperty("cid");
    // item オブジェクトそのものではなくスプレッドされていること
    expect(frame).not.toHaveProperty("item");
    // Must use 'companyID', not 'cid'
    expect(frame).toHaveProperty("companyID", "cmp-X");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0080  shareDeviceGroupKeysToEmployeeGroup item 構築の透過検証:
//           keyLevel(文字列)・devices は dedup・startTime/endTime は keyLevel==='2' のみ
// ref: references_web/src/pages/biz/devices/group-share/GroupShare.js:72-95
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0080] shareDeviceGroupKeysToEmployeeGroup item 構築の透過検証", () => {
  it("[ORG-0080] keyLevel は文字列 '2' のとき startTime/endTime が epoch 秒で透過される", async () => {
    const epochStart = 1700000000;
    const epochEnd = 1700003600;
    const item = {
      keyLevel: "2",
      members: ["u1"],
      devices: ["d1"],
      mid: "m1",
      dids: ["dg1"],
      startTime: epochStart,
      endTime: epochEnd,
    };
    const c = mockClient({ success: true });
    await org.shareDeviceGroupKeysToEmployeeGroup(c, { companyID: "cmp-X", item });
    expect(c.sent[0].keyLevel).toBe("2");
    expect(c.sent[0].startTime).toBe(epochStart);
    expect(c.sent[0].endTime).toBe(epochEnd);
    expect(typeof c.sent[0].startTime).toBe("number");
    expect(typeof c.sent[0].endTime).toBe("number");
  });

  it("[ORG-0080] keyLevel='1' のとき startTime/endTime='' で透過される (常時利用)", async () => {
    const item = {
      keyLevel: "1",
      members: ["u1"],
      devices: ["d1", "d2"],
      mid: "m1",
      dids: ["dg1"],
      startTime: "",
      endTime: "",
    };
    const c = mockClient({ success: true });
    await org.shareDeviceGroupKeysToEmployeeGroup(c, { companyID: "cmp-X", item });
    expect(c.sent[0].keyLevel).toBe("1");
    expect(c.sent[0].startTime).toBe("");
    expect(c.sent[0].endTime).toBe("");
  });

  it("[ORG-0080] devices 重複 (dedup) は呼出側が [...new Set] で適用し透過される", async () => {
    // dedup は web 側 GroupShare.js の責務。core は渡された配列をそのまま透過する。
    const dedupDevices = [...new Set(["d1", "d2", "d1"])]; // => ["d1","d2"]
    const item = { keyLevel: "1", members: ["u1"], devices: dedupDevices, mid: "m1", dids: ["dg1"], startTime: "", endTime: "" };
    const c = mockClient({ success: true });
    await org.shareDeviceGroupKeysToEmployeeGroup(c, { companyID: "cmp-X", item });
    expect(c.sent[0].devices).toEqual(["d1", "d2"]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0081  shareDeviceGroupKeysToEmployeeGroup: companyID 必須 (badRequest)
// ref: packages/core/src/org.js:633
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0081] shareDeviceGroupKeysToEmployeeGroup: companyID 欠落で badRequest", () => {
  it("[ORG-0081] companyID 未指定で badRequest を throw し send しない", async () => {
    const c = mockClient({});
    await expect(
      org.shareDeviceGroupKeysToEmployeeGroup(c, { item: { keyLevel: "1" } }),
    ).rejects.toThrow(/companyID required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0081] companyID が空文字でも badRequest を throw する", async () => {
    const c = mockClient({});
    await expect(
      org.shareDeviceGroupKeysToEmployeeGroup(c, {
        companyID: "",
        item: { keyLevel: "1", members: [], devices: [], mid: "m1", dids: [] },
      }),
    ).rejects.toThrow(/companyID required/);
    expect(c.sent).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0082  CLI sesame org keys share-group: --json 必須で欠落時 exit 2
// ref: packages/kit/src/cli/org.js:667-684
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0082] sesame org keys share-group: --json 必須 / 欠落 die(2)", () => {
  it("[ORG-0082] --json 未指定で die し shareDeviceGroupKeysToEmployeeGroup を呼ばない", async () => {
    const hub = { org: { shareDeviceGroupKeysToEmployeeGroup: vi.fn() } };
    const ctx = makeCtx({ hub });
    await expect(
      buildProgram(ctx).parseAsync(["org", "keys", "share-group"], { from: "user" }),
    ).rejects.toThrow();
    expect(hub.org.shareDeviceGroupKeysToEmployeeGroup).not.toHaveBeenCalled();
  });

  it("[ORG-0082] 指定時は parse した item を shareDeviceGroupKeysToEmployeeGroup に渡す", async () => {
    const hub = {
      org: {
        shareDeviceGroupKeysToEmployeeGroup: vi.fn(async () => ({ success: true })),
      },
    };
    const ctx = makeCtx({ hub, json: true });
    const item = { keyLevel: "1", members: ["u1"], devices: ["d1"], mid: "m1", dids: ["dg1"], startTime: "", endTime: "" };
    await buildProgram(ctx).parseAsync(
      ["org", "keys", "share-group", "--json", JSON.stringify(item)],
      { from: "user" },
    );
    expect(hub.org.shareDeviceGroupKeysToEmployeeGroup).toHaveBeenCalledWith({ item });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0083  getEmployeeDeviceKeys wire:
//           {action:'biz3ManageEmployeeDevice', subUUID, op:'get'} で companyID を送らない
// ref: packages/core/src/org.js:649-655; references_web/src/api/useManageGroup.js:137-148
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0083] getEmployeeDeviceKeys wire フレーム (companyID 無し)", () => {
  it("[ORG-0083] フレームが {action:'biz3ManageEmployeeDevice', subUUID, op:'get'} で companyID を持たない", async () => {
    const c = mockClient({ success: true, data: [{ deviceUUID: "d1" }] });
    await org.getEmployeeDeviceKeys(c, { subUUID: "sub-1" });
    expect(c.sent).toHaveLength(1);
    const frame = c.sent[0];
    expect(frame.action).toBe("biz3ManageEmployeeDevice");
    expect(frame.subUUID).toBe("sub-1");
    expect(frame.op).toBe("get");
    expect(frame).not.toHaveProperty("companyID");
  });

  it("[ORG-0083] subUUID 未指定で badRequest を throw する", async () => {
    const c = mockClient({});
    await expect(
      org.getEmployeeDeviceKeys(c, { subUUID: "" }),
    ).rejects.toThrow(/subUUID required/);
    expect(c.sent).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0084  getEmployeeDeviceKeys は resp.data を無条件パススルー (data 欠落は undefined)
// ref: packages/core/src/org.js:656-657; references_web/src/pages/biz/employees/list-item/EmployeeItem.js:72-83
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0084] getEmployeeDeviceKeys payload-fidelity: resp.data パススルー", () => {
  it("[ORG-0084] data が存在するとき resp.data をそのまま返す", async () => {
    const data = [{ deviceUUID: "d1", keyLevel: 1 }];
    const c = mockClient({ success: true, data });
    const result = await org.getEmployeeDeviceKeys(c, { subUUID: "sub-1" });
    expect(result).toEqual(data);
  });

  it("[ORG-0084] data 欠落時は undefined を返す (resp 全体へフォールバックしない)", async () => {
    const c = mockClient({ success: true }); // data フィールドなし
    const result = await org.getEmployeeDeviceKeys(c, { subUUID: "sub-1" });
    expect(result).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0085  CLI sesame org keys employee <subUUID>: 位置引数で subUUID を渡し JSON 整形出力
// ref: packages/kit/src/cli/org.js:635-645
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0085] sesame org keys employee <subUUID> 出力封筒 (human / --json)", () => {
  it("[ORG-0085] 位置引数 subUUID が getEmployeeDeviceKeys に渡される", async () => {
    const data = [{ deviceUUID: "d1", keyLevel: 1 }];
    const hub = { org: { getEmployeeDeviceKeys: vi.fn(async () => data) } };
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(["org", "keys", "employee", "sub-123"], { from: "user" });
    expect(hub.org.getEmployeeDeviceKeys).toHaveBeenCalledWith({ subUUID: "sub-123" });
  });

  it("[ORG-0085] --json 時に {ok:true, subUUID, keys:data} 封筒を返す", async () => {
    const data = [{ deviceUUID: "d1", keyLevel: 1 }];
    const hub = { org: { getEmployeeDeviceKeys: vi.fn(async () => data) } };
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(["org", "keys", "employee", "sub-123"], { from: "user" });
    expect(ctx.outputs[0]).toEqual({ ok: true, subUUID: "sub-123", keys: data });
  });

  it("[ORG-0085] human 出力時は JSON.stringify(keys) が含まれる", async () => {
    const data = [{ deviceUUID: "d1", keyLevel: 1 }];
    const hub = { org: { getEmployeeDeviceKeys: vi.fn(async () => data) } };
    const ctx = makeCtx({ hub, json: false });
    const lines = [];
    vi.spyOn(console, "log").mockImplementation((s) => lines.push(String(s)));
    await buildProgram(ctx).parseAsync(["org", "keys", "employee", "sub-123"], { from: "user" });
    expect(lines.join("\n")).toContain("d1");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0086  removeEmployeeDeviceKey wire:
//           {action:'biz3ManageEmployeeDevice', ...data, op:'del'} で companyID 無し
// ref: packages/core/src/org.js:671-679
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0086] removeEmployeeDeviceKey wire フレーム (2 パターン)", () => {
  it("[ORG-0086] 従業員削除パターン: {subUUID,deviceUUID} を spread し op='del'・companyID 無し", async () => {
    const c = mockClient({ success: true });
    await org.removeEmployeeDeviceKey(c, { data: { subUUID: "u1", deviceUUID: "d1" } });
    const frame = c.sent[0];
    expect(frame.action).toBe("biz3ManageEmployeeDevice");
    expect(frame.subUUID).toBe("u1");
    expect(frame.deviceUUID).toBe("d1");
    expect(frame.op).toBe("del");
    expect(frame).not.toHaveProperty("companyID");
  });

  it("[ORG-0086] ゲスト鍵削除パターン: {guestKeyId,randomTag,deviceUUID} を spread し op='del'・companyID 無し", async () => {
    const c = mockClient({ success: true });
    await org.removeEmployeeDeviceKey(c, {
      data: { guestKeyId: "gk-1", randomTag: "cafebabe", deviceUUID: "d1" },
    });
    const frame = c.sent[0];
    expect(frame.action).toBe("biz3ManageEmployeeDevice");
    expect(frame.guestKeyId).toBe("gk-1");
    expect(frame.randomTag).toBe("cafebabe");
    expect(frame.deviceUUID).toBe("d1");
    expect(frame.op).toBe("del");
    expect(frame).not.toHaveProperty("companyID");
    // subUUID はゲスト削除パターンに存在しないこと (data spread のみ)
    expect(frame).not.toHaveProperty("subUUID");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0087  removeEmployeeDeviceKey: data が object でないと badRequest
// ref: packages/core/src/org.js:672
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0087] removeEmployeeDeviceKey: data 非 object で badRequest", () => {
  it("[ORG-0087] data が null のとき badRequest を throw し send しない", async () => {
    const c = mockClient({});
    await expect(
      org.removeEmployeeDeviceKey(c, { data: null }),
    ).rejects.toThrow(/data required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0087] data が文字列のとき badRequest を throw する", async () => {
    const c = mockClient({});
    await expect(
      org.removeEmployeeDeviceKey(c, { data: "not-an-object" }),
    ).rejects.toThrow(/data required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0087] data が undefined のとき badRequest を throw する", async () => {
    const c = mockClient({});
    await expect(
      org.removeEmployeeDeviceKey(c, {}),
    ).rejects.toThrow(/data required/);
    expect(c.sent).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0088  CLI sesame org keys rm: guestKeyId あり & randomTag 未指定 → cmacTime 自動補完
// ref: packages/kit/src/cli/org.js:702-715
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0088] sesame org keys rm: ゲスト鍵 randomTag の cmacTime 自動補完", () => {
  const SECRET = "00112233445566778899aabbccddeeff";

  it("[ORG-0088] guestKeyId あり + randomTag 未指定なら listDevices の secretKey で cmacTime を補完", async () => {
    /** @type {any} */
    let received = null;
    const hub = {
      listDevices: vi.fn(async () => [{ deviceUUID: "DEV-1", secretKey: SECRET }]),
      org: {
        removeEmployeeDeviceKey: vi.fn(async (p) => {
          received = p;
          return { success: true };
        }),
      },
    };
    const ctx = makeCtx({ hub, json: true });

    const before = cmacTime(SECRET);
    await buildProgram(ctx).parseAsync(
      ["org", "keys", "rm", "--json", '{"guestKeyId":"g-1","deviceUUID":"DEV-1"}'],
      { from: "user" },
    );
    const after = cmacTime(SECRET);

    expect(hub.listDevices).toHaveBeenCalledTimes(1);
    expect(received.data.guestKeyId).toBe("g-1");
    expect(received.data.randomTag).toMatch(/^[0-9a-f]{8}$/);
    // DeviceUserList.js と同じ cmacTime 計算であること
    expect([before, after]).toContain(received.data.randomTag);
  });

  it("[ORG-0088] randomTag が明示されていれば listDevices を呼ばず randomTag をそのまま使う", async () => {
    /** @type {any} */
    let received = null;
    const hub = {
      listDevices: vi.fn(async () => []),
      org: {
        removeEmployeeDeviceKey: vi.fn(async (p) => {
          received = p;
          return { success: true };
        }),
      },
    };
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["org", "keys", "rm", "--json", '{"guestKeyId":"g-1","deviceUUID":"DEV-1","randomTag":"cafebabe"}'],
      { from: "user" },
    );
    expect(hub.listDevices).not.toHaveBeenCalled();
    expect(received.data.randomTag).toBe("cafebabe");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0089  CLI sesame org keys rm: 従業員削除 (subUUID) は randomTag 補完経路に入らない
// ref: packages/kit/src/cli/org.js:702
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0089] sesame org keys rm: subUUID 経路は listDevices を呼ばない", () => {
  it("[ORG-0089] guestKeyId なし (subUUID) のとき listDevices を呼ばず data をそのまま渡す", async () => {
    /** @type {any} */
    let received = null;
    const hub = {
      listDevices: vi.fn(async () => []),
      org: {
        removeEmployeeDeviceKey: vi.fn(async (p) => {
          received = p;
          return { success: true };
        }),
      },
    };
    const ctx = makeCtx({ hub, json: true });
    await buildProgram(ctx).parseAsync(
      ["org", "keys", "rm", "--json", '{"subUUID":"s-1","deviceUUID":"DEV-1"}'],
      { from: "user" },
    );
    expect(hub.listDevices).not.toHaveBeenCalled();
    expect(received.data).toEqual({ subUUID: "s-1", deviceUUID: "DEV-1" });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ORG-0090  CLI sesame org keys rm: error-path — --json 欠落 / device 不在 / secretKey 欠落 で die(2)
// ref: packages/kit/src/cli/org.js:692-714
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0090] sesame org keys rm error-path (--json 欠落 / device 不在 / secretKey 欠落)", () => {
  it("[ORG-0090] --json 未指定で die し removeEmployeeDeviceKey を呼ばない", async () => {
    const hub = {
      listDevices: vi.fn(),
      org: { removeEmployeeDeviceKey: vi.fn() },
    };
    const ctx = makeCtx({ hub });
    await expect(
      buildProgram(ctx).parseAsync(["org", "keys", "rm"], { from: "user" }),
    ).rejects.toThrow();
    expect(hub.org.removeEmployeeDeviceKey).not.toHaveBeenCalled();
  });

  it("[ORG-0090] listDevices に指定 deviceUUID が無ければ die し removeEmployeeDeviceKey を呼ばない", async () => {
    const hub = {
      listDevices: vi.fn(async () => [{ deviceUUID: "OTHER", secretKey: "sk" }]),
      org: { removeEmployeeDeviceKey: vi.fn() },
    };
    const ctx = makeCtx({ hub, json: true });
    await expect(
      buildProgram(ctx).parseAsync(
        ["org", "keys", "rm", "--json", '{"guestKeyId":"g-1","deviceUUID":"DEV-1"}'],
        { from: "user" },
      ),
    ).rejects.toThrow(/DEV-1/);
    expect(hub.org.removeEmployeeDeviceKey).not.toHaveBeenCalled();
  });

  it("[ORG-0090] デバイスに secretKey が無ければ die し removeEmployeeDeviceKey を呼ばない", async () => {
    const hub = {
      listDevices: vi.fn(async () => [{ deviceUUID: "DEV-1" }]), // secretKey なし
      org: { removeEmployeeDeviceKey: vi.fn() },
    };
    const ctx = makeCtx({ hub, json: true });
    await expect(
      buildProgram(ctx).parseAsync(
        ["org", "keys", "rm", "--json", '{"guestKeyId":"g-1","deviceUUID":"DEV-1"}'],
        { from: "user" },
      ),
    ).rejects.toThrow(/secretKey/);
    expect(hub.org.removeEmployeeDeviceKey).not.toHaveBeenCalled();
  });
});
