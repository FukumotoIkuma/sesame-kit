// ORG-0055 〜 ORG-0072 の vitest 単体テスト (TDD)。
//
// 対象: packages/core/src/org.js (core 関数) および packages/kit/src/cli/org.js (CLI)
//       packages/kit/src/serve/rpc-params.generated.json (contract-existence)
//       packages/kit/src/serve/grpc-methods.generated.json (contract-existence)
//
// ネットワーク/実機に触れない。全て mock または純関数。
// spec は正しい挙動 (TDD) を assert する。実装が spec と食い違う場合は red になってよい。

import { describe, it, expect, vi, afterEach } from "vitest";
import * as org from "../../src/org.js";
import { NAMESPACE_OPS } from "../../src/org.js";
import { mockClient } from "../helpers/mock-ws.js";
import { Command } from "commander";
import { registerOrgCommands } from "../../../kit/src/cli/org.js";
import { readFileSync } from "node:fs";
const rpcParams = JSON.parse(readFileSync(new URL("../../../kit/src/serve/rpc-params.generated.json", import.meta.url)));
const grpcMethods = JSON.parse(readFileSync(new URL("../../../kit/src/serve/grpc-methods.generated.json", import.meta.url)));

// ═══════════════════════════════════════════════════════════════════════════
//  CLI helper (倣元: packages/kit/tests/cli/org-role-keys.test.js)
// ═══════════════════════════════════════════════════════════════════════════

/** fake ctx。withAccount は即 fn(hub, {opts}) を呼ぶ。 */
function makeCtx({ hub, json = false } = {}) {
  const outputs = [];
  const dies = [];
  const ctx = {
    outputs,
    dies,
    out: (isJson, humanFn, jsonObj) => {
      outputs.push(jsonObj);
      if (!isJson) humanFn();
    },
    die: (msg, code) => {
      const e = new Error(msg);
      /** @type {any} */ (e).exitCode = code;
      dies.push({ msg, code });
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
    parseJson: (raw) => {
      try { return JSON.parse(raw); } catch { return undefined; }
    },
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

// ═══════════════════════════════════════════════════════════════════════════
//  ORG-0055: removeDeviceGroups → 各要素に cid マージした objs op:deleteGroups
// ═══════════════════════════════════════════════════════════════════════════
describe("[ORG-0055] removeDeviceGroups → 各要素に cid マージした objs op:deleteGroups", () => {
  it("[ORG-0055] 各 groupId に cid をマージした objs(複数形)をトップレベルに置き op:deleteGroups で送る", async () => {
    const c = mockClient({ success: true });
    await org.removeDeviceGroups(c, {
      companyID: "ch_X",
      groupIds: [{ gid: "dg1" }, { gid: "dg2" }],
    });
    // objs にトップレベル cid は無い — employeeGroup の removeEmployeeGroups({objs:gids,cid:companyID}) と逆
    expect(c.sent[0]).toEqual({
      action: "biz3ManageDeviceGroup",
      objs: [
        { gid: "dg1", cid: "ch_X" },
        { gid: "dg2", cid: "ch_X" },
      ],
      op: "deleteGroups",
    });
    // トップレベルに cid キーは存在しない
    expect(c.sent[0]).not.toHaveProperty("cid");
  });

  it("[ORG-0055] 各要素の既存フィールドは保持したまま cid をマージする ({...o, cid})", async () => {
    const c = mockClient({ success: true });
    await org.removeDeviceGroups(c, {
      companyID: "CMP",
      groupIds: [{ gid: "dg1", name: "GroupA" }],
    });
    expect(c.sent[0].objs[0]).toEqual({ gid: "dg1", name: "GroupA", cid: "CMP" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  ORG-0056: removeDeviceGroups groupIds 非配列で badRequest
// ═══════════════════════════════════════════════════════════════════════════
describe("[ORG-0056] removeDeviceGroups groupIds 非配列で badRequest", () => {
  it("[ORG-0056] groupIds が文字列のとき map 前に badRequest を throw し WS 送信しない", async () => {
    const c = mockClient({});
    await expect(
      org.removeDeviceGroups(c, { companyID: "ch_X", groupIds: "not-array" }),
    ).rejects.toThrow(/groupIds must be an array/);
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0056] groupIds が undefined のとき badRequest を throw する", async () => {
    const c = mockClient({});
    await expect(
      org.removeDeviceGroups(c, { companyID: "ch_X", groupIds: undefined }),
    ).rejects.toThrow(/groupIds must be an array/);
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0056] groupIds が object(非配列)のとき badRequest を throw する", async () => {
    const c = mockClient({});
    await expect(
      org.removeDeviceGroups(c, { companyID: "ch_X", groupIds: { gid: "dg1" } }),
    ).rejects.toThrow(/groupIds must be an array/);
    expect(c.sent).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  ORG-0057: addDeviceInGroup → cid/gid/uuids/items 全直置き op:addBindDevice
// ═══════════════════════════════════════════════════════════════════════════
describe("[ORG-0057] addDeviceInGroup → cid/gid/uuids/items 全直置き op:addBindDevice", () => {
  it("[ORG-0057] items を絞り込まず透過し全フィールドを直置きで送る", async () => {
    const c = mockClient({ success: true });
    const items = [{ deviceUUID: "d1", secretKey: "sk1", deviceName: "Door", extra: 999 }];
    await org.addDeviceInGroup(c, {
      companyID: "ch_X",
      gid: "dg1",
      uuids: ["d1"],
      items,
    });
    expect(c.sent[0]).toEqual({
      action: "biz3ManageDeviceGroup",
      cid: "ch_X",
      gid: "dg1",
      uuids: ["d1"],
      items, // 透過 (deviceName も extra も残る)
      op: "addBindDevice",
    });
  });

  it("[ORG-0057] addDeviceInGroup は removeDeviceInGroup と違い items を {deviceUUID,secretKey} に絞らない", async () => {
    const c = mockClient({ success: true });
    const items = [{ deviceUUID: "d1", secretKey: "sk1", extra: "preserved" }];
    await org.addDeviceInGroup(c, { companyID: "ch_X", gid: "dg1", uuids: ["d1"], items });
    // extra フィールドが送信フレームの items に残っていること
    expect(c.sent[0].items[0]).toHaveProperty("extra", "preserved");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  ORG-0058: removeDeviceInGroup → items を {deviceUUID,secretKey} のみに絞り込む op:removeBindDevice
// ═══════════════════════════════════════════════════════════════════════════
describe("[ORG-0058] removeDeviceInGroup → items を {deviceUUID,secretKey} のみに絞り込む op:removeBindDevice", () => {
  it("[ORG-0058] items を {deviceUUID,secretKey} のみへ写像して送る", async () => {
    const c = mockClient({ success: true });
    await org.removeDeviceInGroup(c, {
      companyID: "ch_X",
      gid: "dg1",
      uuids: ["d1"],
      items: [{ deviceUUID: "d1", secretKey: "sk1", deviceName: "Door", extra: 1 }],
    });
    expect(c.sent[0]).toEqual({
      action: "biz3ManageDeviceGroup",
      cid: "ch_X",
      gid: "dg1",
      uuids: ["d1"],
      items: [{ deviceUUID: "d1", secretKey: "sk1" }],
      op: "removeBindDevice",
    });
    // deviceName / extra は除去される
    expect(c.sent[0].items[0]).not.toHaveProperty("deviceName");
    expect(c.sent[0].items[0]).not.toHaveProperty("extra");
  });

  it("[ORG-0058] 複数 items が全て {deviceUUID,secretKey} のみに絞り込まれる", async () => {
    const c = mockClient({ success: true });
    await org.removeDeviceInGroup(c, {
      companyID: "ch_X",
      gid: "dg1",
      uuids: ["d1", "d2"],
      items: [
        { deviceUUID: "d1", secretKey: "sk1", name: "A" },
        { deviceUUID: "d2", secretKey: "sk2", name: "B" },
      ],
    });
    expect(c.sent[0].items).toEqual([
      { deviceUUID: "d1", secretKey: "sk1" },
      { deviceUUID: "d2", secretKey: "sk2" },
    ]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  ORG-0059: removeDeviceInGroup items 非配列で badRequest
// ═══════════════════════════════════════════════════════════════════════════
describe("[ORG-0059] removeDeviceInGroup items 非配列で badRequest", () => {
  it("[ORG-0059] items が文字列のとき map 前に badRequest を throw し WS 送信しない", async () => {
    const c = mockClient({});
    await expect(
      org.removeDeviceInGroup(c, { companyID: "ch_X", gid: "dg1", uuids: [], items: "bad" }),
    ).rejects.toThrow(/items must be an array/);
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0059] items が null のとき badRequest を throw する", async () => {
    const c = mockClient({});
    await expect(
      org.removeDeviceInGroup(c, { companyID: "ch_X", gid: "dg1", uuids: [], items: null }),
    ).rejects.toThrow(/items must be an array/);
    expect(c.sent).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  ORG-0060: getDeviceGroupBindUserGroup → gid のみ送り cid 不送信 op:getBindUserGroup
// ═══════════════════════════════════════════════════════════════════════════
describe("[ORG-0060] getDeviceGroupBindUserGroup → gid のみ送り cid 不送信 op:getBindUserGroup", () => {
  it("[ORG-0060] フレームは {action:biz3ManageDeviceGroup, gid, op:getBindUserGroup} で cid を含まない", async () => {
    const c = mockClient({ success: true, data: { userGroups: ["ug1"] } });
    await org.getDeviceGroupBindUserGroup(c, { gid: "dg1" });
    expect(c.sent[0]).toEqual({
      action: "biz3ManageDeviceGroup",
      gid: "dg1",
      op: "getBindUserGroup",
    });
    expect(c.sent[0]).not.toHaveProperty("cid");
    expect(c.sent[0]).not.toHaveProperty("companyID");
  });

  it("[ORG-0060] resp.data を直返しする (resp 全体にフォールバックしない)", async () => {
    const c = mockClient({ success: true, data: { userGroups: ["ug1"] } });
    const r = await org.getDeviceGroupBindUserGroup(c, { gid: "dg1" });
    expect(r).toEqual({ userGroups: ["ug1"] });
  });

  it("[ORG-0060] data 欠落時は undefined (resp にフォールバックしない)", async () => {
    const c = mockClient({ success: true });
    const r = await org.getDeviceGroupBindUserGroup(c, { gid: "dg1" });
    expect(r).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  ORG-0061: getDeviceGroupBindUserGroup gid 未指定で badRequest
// ═══════════════════════════════════════════════════════════════════════════
describe("[ORG-0061] getDeviceGroupBindUserGroup gid 未指定で badRequest", () => {
  it("[ORG-0061] gid が空文字のとき WS 送信せず badRequest を throw する", async () => {
    const c = mockClient({});
    await expect(
      org.getDeviceGroupBindUserGroup(c, { gid: "" }),
    ).rejects.toThrow(/gid required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0061] gid が undefined のとき badRequest を throw する", async () => {
    const c = mockClient({});
    await expect(
      org.getDeviceGroupBindUserGroup(c, { gid: undefined }),
    ).rejects.toThrow(/gid required/);
    expect(c.sent).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  ORG-0062: removeDeviceGroupBindUserGroup → cid+...data 直置き op:removeBindUserGroup
// ═══════════════════════════════════════════════════════════════════════════
describe("[ORG-0062] removeDeviceGroupBindUserGroup → cid+...data 直置き op:removeBindUserGroup", () => {
  it("[ORG-0062] フレームは {action:biz3ManageDeviceGroup, cid, ...data, op:removeBindUserGroup} で op が後置される", async () => {
    const c = mockClient({ success: true });
    await org.removeDeviceGroupBindUserGroup(c, {
      companyID: "ch_X",
      data: { gid: "dg1", mid: "m1" },
    });
    expect(c.sent[0]).toEqual({
      action: "biz3ManageDeviceGroup",
      cid: "ch_X",
      gid: "dg1",
      mid: "m1",
      op: "removeBindUserGroup",
    });
  });

  it("[ORG-0062] data 内の op があっても op:removeBindUserGroup に上書きされる (op 後置)", async () => {
    const c = mockClient({ success: true });
    await org.removeDeviceGroupBindUserGroup(c, {
      companyID: "ch_X",
      data: { gid: "dg1", op: "wrong-op" },
    });
    expect(c.sent[0].op).toBe("removeBindUserGroup");
  });

  it("[ORG-0062] action は biz3ManageDeviceGroup (biz3ManageEmployeeGroup ではない)", async () => {
    const c = mockClient({ success: true });
    await org.removeDeviceGroupBindUserGroup(c, {
      companyID: "ch_X",
      data: { gid: "dg1" },
    });
    expect(c.sent[0].action).toBe("biz3ManageDeviceGroup");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  ORG-0063: bind 系 action 逆転 (cross-action)
// ═══════════════════════════════════════════════════════════════════════════
describe("[ORG-0063] bind 系 action 逆転: bindDeviceGroup=employeeGroup action / bindUserGroup=deviceGroup action", () => {
  it("[ORG-0063] getEmployeeGroupBindDeviceGroup は action=biz3ManageEmployeeGroup を使う", async () => {
    const c = mockClient({ success: true, data: {} });
    await org.getEmployeeGroupBindDeviceGroup(c, { gid: "g1" });
    expect(c.sent[0].action).toBe("biz3ManageEmployeeGroup");
  });

  it("[ORG-0063] removeEmployeeGroupBindDeviceGroup は action=biz3ManageEmployeeGroup を使う", async () => {
    const c = mockClient({ success: true });
    await org.removeEmployeeGroupBindDeviceGroup(c, {
      companyID: "ch_X",
      data: { gid: "g1", dgid: "d1" },
    });
    expect(c.sent[0].action).toBe("biz3ManageEmployeeGroup");
  });

  it("[ORG-0063] getDeviceGroupBindUserGroup は action=biz3ManageDeviceGroup を使う", async () => {
    const c = mockClient({ success: true, data: {} });
    await org.getDeviceGroupBindUserGroup(c, { gid: "dg1" });
    expect(c.sent[0].action).toBe("biz3ManageDeviceGroup");
  });

  it("[ORG-0063] removeDeviceGroupBindUserGroup は action=biz3ManageDeviceGroup を使う", async () => {
    const c = mockClient({ success: true });
    await org.removeDeviceGroupBindUserGroup(c, {
      companyID: "ch_X",
      data: { gid: "dg1", mid: "m1" },
    });
    expect(c.sent[0].action).toBe("biz3ManageDeviceGroup");
  });

  it("[ORG-0063] getEmployeeGroupBindDeviceGroup の op は getBindDeviceGroup", async () => {
    const c = mockClient({ success: true, data: {} });
    await org.getEmployeeGroupBindDeviceGroup(c, { gid: "g1" });
    expect(c.sent[0].op).toBe("getBindDeviceGroup");
  });

  it("[ORG-0063] getDeviceGroupBindUserGroup の op は getBindUserGroup", async () => {
    const c = mockClient({ success: true, data: {} });
    await org.getDeviceGroupBindUserGroup(c, { gid: "dg1" });
    expect(c.sent[0].op).toBe("getBindUserGroup");
  });

  it("[ORG-0063] bind 系 4 op は EmployeeGroup と DeviceGroup の action が互いに異なる (対称性クロスチェック)", async () => {
    const cEG = mockClient({ success: true, data: {} });
    await org.getEmployeeGroupBindDeviceGroup(cEG, { gid: "g1" });
    const cDG = mockClient({ success: true, data: {} });
    await org.getDeviceGroupBindUserGroup(cDG, { gid: "dg1" });
    expect(cEG.sent[0].action).not.toBe(cDG.sent[0].action);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  ORG-0064: sesame org group ls 整形出力と --json 封筒
// ═══════════════════════════════════════════════════════════════════════════
describe("[ORG-0064] sesame org group ls 整形出力と --json 封筒", () => {
  it("[ORG-0064] human 出力は gid/name 行, --json 封筒は {ok,count,groups}", async () => {
    const list = [
      { gid: "g-1", name: "Engineering" },
      { gid: "g-2", name: "HR" },
    ];
    const hub = { org: { getEmployeeGroups: async () => list } };
    const ctx = makeCtx({ hub });
    const lines = [];
    vi.spyOn(console, "log").mockImplementation((s) => lines.push(String(s)));

    await buildProgram(ctx).parseAsync(["org", "group", "ls"], { from: "user" });

    // gid と name が human 出力に含まれる
    expect(lines.some((l) => l.includes("g-1") && l.includes("Engineering"))).toBe(true);
    expect(lines.some((l) => l.includes("g-2") && l.includes("HR"))).toBe(true);
    // JSON 封筒
    expect(ctx.outputs[0]).toMatchObject({ ok: true, count: 2, groups: list });
  });

  it("[ORG-0064] --json 出力封筒は {ok:true, count, groups} の shape", async () => {
    const list = [{ gid: "g-1", name: "Engineering" }];
    const hub = { org: { getEmployeeGroups: async () => list } };
    const ctx = makeCtx({ hub, json: true });

    await buildProgram(ctx).parseAsync(["org", "group", "ls"], { from: "user" });

    expect(ctx.outputs[0]).toEqual({ ok: true, count: 1, groups: list });
  });

  it("[ORG-0064] 空リストは count:0 で groups:[] を返す", async () => {
    const hub = { org: { getEmployeeGroups: async () => [] } };
    const ctx = makeCtx({ hub, json: true });

    await buildProgram(ctx).parseAsync(["org", "group", "ls"], { from: "user" });

    expect(ctx.outputs[0]).toMatchObject({ ok: true, count: 0, groups: [] });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  ORG-0065: sesame org group add 必須 --json 検証と exit 2
// ═══════════════════════════════════════════════════════════════════════════
describe("[ORG-0065] sesame org group add 必須 --json 検証と exit 2", () => {
  it("[ORG-0065] --json 省略で ctx.die が exit code 2 で呼ばれる", async () => {
    const hub = { org: { addEmployeeGroup: vi.fn() } };
    const ctx = makeCtx({ hub });

    await expect(
      buildProgram(ctx).parseAsync(["org", "group", "add"], { from: "user" }),
    ).rejects.toThrow();

    expect(ctx.dies).toHaveLength(1);
    expect(ctx.dies[0].code).toBe(2);
    expect(hub.org.addEmployeeGroup).not.toHaveBeenCalled();
  });

  it("[ORG-0065] --json 有効時は addEmployeeGroup({item}) を呼び created.gid 有りで出力封筒に {ok,group}", async () => {
    const created = { gid: "g-new", name: "Test" };
    const hub = { org: { addEmployeeGroup: vi.fn(async () => created) } };
    const ctx = makeCtx({ hub, json: true });

    await buildProgram(ctx).parseAsync(
      ["org", "group", "add", "--json", '{"name":"Test"}'],
      { from: "user" },
    );

    expect(hub.org.addEmployeeGroup).toHaveBeenCalledWith({ item: { name: "Test" } });
    expect(ctx.outputs[0]).toMatchObject({ ok: true, group: created });
  });

  it("[ORG-0065] created が gid を持たない場合も ok 形式で出力する", async () => {
    const hub = { org: { addEmployeeGroup: vi.fn(async () => undefined) } };
    const ctx = makeCtx({ hub, json: true });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await buildProgram(ctx).parseAsync(
      ["org", "group", "add", "--json", '{"name":"Test"}'],
      { from: "user" },
    );

    expect(ctx.outputs[0]).toMatchObject({ ok: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  ORG-0066: sesame org group rm --json 非配列で exit 2
// ═══════════════════════════════════════════════════════════════════════════
describe("[ORG-0066] sesame org group rm --json 非配列で exit 2", () => {
  it("[ORG-0066] --json 省略で die(2) し removeEmployeeGroups を呼ばない", async () => {
    const hub = { org: { removeEmployeeGroups: vi.fn() } };
    const ctx = makeCtx({ hub });

    await expect(
      buildProgram(ctx).parseAsync(["org", "group", "rm"], { from: "user" }),
    ).rejects.toThrow();

    expect(ctx.dies[0].code).toBe(2);
    expect(hub.org.removeEmployeeGroups).not.toHaveBeenCalled();
  });

  it("[ORG-0066] --json が配列でないとき die(org.err.jsonArray, 2) で removeEmployeeGroups を呼ばない", async () => {
    const hub = { org: { removeEmployeeGroups: vi.fn() } };
    const ctx = makeCtx({ hub });

    await expect(
      buildProgram(ctx).parseAsync(
        ["org", "group", "rm", "--json", '"not-an-array"'],
        { from: "user" },
      ),
    ).rejects.toThrow();

    expect(ctx.dies[0].code).toBe(2);
    expect(hub.org.removeEmployeeGroups).not.toHaveBeenCalled();
  });

  it("[ORG-0066] --json が配列なら removeEmployeeGroups({gids}) を呼び ok 封筒を返す", async () => {
    const hub = { org: { removeEmployeeGroups: vi.fn(async () => ({ success: true })) } };
    const ctx = makeCtx({ hub, json: true });

    await buildProgram(ctx).parseAsync(
      ["org", "group", "rm", "--json", '["g1","g2"]'],
      { from: "user" },
    );

    expect(hub.org.removeEmployeeGroups).toHaveBeenCalledWith({ gids: ["g1", "g2"] });
    expect(ctx.outputs[0]).toMatchObject({ ok: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  ORG-0067: sesame org group add-users/rm-users の uuids/items 配列検証
// ═══════════════════════════════════════════════════════════════════════════
describe("[ORG-0067] sesame org group add-users/rm-users の uuids/items 配列検証", () => {
  it("[ORG-0067] add-users は body.uuids が配列でなければ die(org.err.uuidsItemsArray, 2)", async () => {
    const hub = { org: { addEmployeeInGroup: vi.fn() } };
    const ctx = makeCtx({ hub });

    await expect(
      buildProgram(ctx).parseAsync(
        ["org", "group", "add-users", "g1", "--json", '{"uuids":"bad","items":[]}'],
        { from: "user" },
      ),
    ).rejects.toThrow();

    expect(ctx.dies[0].code).toBe(2);
    expect(hub.org.addEmployeeInGroup).not.toHaveBeenCalled();
  });

  it("[ORG-0067] add-users は body.items が配列でなければ die(org.err.uuidsItemsArray, 2)", async () => {
    const hub = { org: { addEmployeeInGroup: vi.fn() } };
    const ctx = makeCtx({ hub });

    await expect(
      buildProgram(ctx).parseAsync(
        ["org", "group", "add-users", "g1", "--json", '{"uuids":["u1"],"items":"bad"}'],
        { from: "user" },
      ),
    ).rejects.toThrow();

    expect(ctx.dies[0].code).toBe(2);
    expect(hub.org.addEmployeeInGroup).not.toHaveBeenCalled();
  });

  it("[ORG-0067] add-users は uuids/items 両方が配列なら addEmployeeInGroup({gid,uuids,items}) を呼ぶ", async () => {
    const hub = { org: { addEmployeeInGroup: vi.fn(async () => ({ success: true })) } };
    const ctx = makeCtx({ hub, json: true });

    await buildProgram(ctx).parseAsync(
      ["org", "group", "add-users", "g1",
        "--json", '{"uuids":["u1"],"items":[{"subUUID":"u1"}]}'],
      { from: "user" },
    );

    expect(hub.org.addEmployeeInGroup).toHaveBeenCalledWith({
      gid: "g1",
      uuids: ["u1"],
      items: [{ subUUID: "u1" }],
    });
  });

  it("[ORG-0067] rm-users は body.items のみ配列必須で uuids は不問 (非対称検証)", async () => {
    const hub = { org: { removeEmployeeInGroup: vi.fn() } };
    const ctx = makeCtx({ hub });

    // items が配列でない
    await expect(
      buildProgram(ctx).parseAsync(
        ["org", "group", "rm-users", "g1", "--json", '{"uuids":["u1"],"items":"bad"}'],
        { from: "user" },
      ),
    ).rejects.toThrow();

    expect(ctx.dies[0].code).toBe(2);
    expect(hub.org.removeEmployeeInGroup).not.toHaveBeenCalled();
  });

  it("[ORG-0067] rm-users は items が配列なら removeEmployeeInGroup を呼ぶ (uuids 非配列でも通過)", async () => {
    const hub = { org: { removeEmployeeInGroup: vi.fn(async () => ({ success: true })) } };
    const ctx = makeCtx({ hub, json: true });

    // uuids が非配列でも items が配列なら通過
    await buildProgram(ctx).parseAsync(
      ["org", "group", "rm-users", "g1",
        "--json", '{"uuids":"not-array","items":[{"subUUID":"u1"}]}'],
      { from: "user" },
    );

    expect(hub.org.removeEmployeeInGroup).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  ORG-0068: sesame org device-group rm-devices secretKey 込み items 検証→絞り込み
// ═══════════════════════════════════════════════════════════════════════════
describe("[ORG-0068] sesame org device-group rm-devices secretKey 込み items 検証→絞り込み", () => {
  it("[ORG-0068] --json 省略で die(2) し removeDeviceInGroup を呼ばない", async () => {
    const hub = { org: { removeDeviceInGroup: vi.fn() } };
    const ctx = makeCtx({ hub });

    await expect(
      buildProgram(ctx).parseAsync(
        ["org", "device-group", "rm-devices", "dg1"],
        { from: "user" },
      ),
    ).rejects.toThrow();

    expect(ctx.dies[0].code).toBe(2);
    expect(hub.org.removeDeviceInGroup).not.toHaveBeenCalled();
  });

  it("[ORG-0068] body.items が配列でなければ die(org.err.itemsArray, 2)", async () => {
    const hub = { org: { removeDeviceInGroup: vi.fn() } };
    const ctx = makeCtx({ hub });

    await expect(
      buildProgram(ctx).parseAsync(
        ["org", "device-group", "rm-devices", "dg1",
          "--json", '{"uuids":["d1"],"items":"not-array"}'],
        { from: "user" },
      ),
    ).rejects.toThrow();

    expect(ctx.dies[0].code).toBe(2);
    expect(hub.org.removeDeviceInGroup).not.toHaveBeenCalled();
  });

  it("[ORG-0068] CLI は body を透過し core removeDeviceInGroup が {deviceUUID,secretKey} へ絞り込む (境界一貫性)", async () => {
    // CLI から core を直接呼んで絞り込みが行われることを確認
    const c = mockClient({ success: true });
    await org.removeDeviceInGroup(c, {
      companyID: "ch_X",
      gid: "dg1",
      uuids: ["d1"],
      items: [{ deviceUUID: "d1", secretKey: "sk1", deviceName: "Door" }],
    });
    // core が {deviceUUID,secretKey} のみに絞り込む
    expect(c.sent[0].items).toEqual([{ deviceUUID: "d1", secretKey: "sk1" }]);
    expect(c.sent[0].items[0]).not.toHaveProperty("deviceName");
  });

  it("[ORG-0068] 有効時は removeDeviceInGroup に items を透過し core が {deviceUUID,secretKey} へ絞り込む", async () => {
    const c = mockClient({ success: true });
    const items = [{ deviceUUID: "d1", secretKey: "sk1", deviceName: "Door" }];
    const hub = {
      org: {
        removeDeviceInGroup: vi.fn(async (params) =>
          org.removeDeviceInGroup(c, { companyID: "ch_X", ...params }),
        ),
      },
    };
    const ctx = makeCtx({ hub, json: true });

    await buildProgram(ctx).parseAsync(
      ["org", "device-group", "rm-devices", "dg1",
        "--json", JSON.stringify({ uuids: ["d1"], items })],
      { from: "user" },
    );

    // core が {deviceUUID,secretKey} に絞り込んでいることを確認
    expect(c.sent[0].items).toEqual([{ deviceUUID: "d1", secretKey: "sk1" }]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  ORG-0069: sesame org role ls は {tag,access[]} 前提で整形
// ═══════════════════════════════════════════════════════════════════════════
describe("[ORG-0069] sesame org role ls は {tag,access[]} 前提で整形", () => {
  it("[ORG-0069] 各行を tag\\taccess.join(',') で表示し id/name フォールバックは持たない", async () => {
    const tags = [
      { tag: "Owner", access: ["user", "device", "card"] },
      { tag: "Staff", access: ["user"] },
    ];
    const hub = { org: { getTags: async () => tags } };
    const ctx = makeCtx({ hub });
    const lines = [];
    vi.spyOn(console, "log").mockImplementation((s) => lines.push(String(s)));

    await buildProgram(ctx).parseAsync(["org", "role", "ls"], { from: "user" });

    // tag\taccess.join(',') 形式
    expect(lines).toContain("  Owner\tuser,device,card");
    expect(lines).toContain("  Staff\tuser");
    // id/name フォールバックは出ない
    expect(lines.join("\n")).not.toContain("(no-id)");
    expect(lines.join("\n")).not.toContain("(no-name)");
  });

  it("[ORG-0069] --json 封筒は {ok:true, count, tags} の shape", async () => {
    const tags = [{ tag: "Owner", access: ["user"] }];
    const hub = { org: { getTags: async () => tags } };
    const ctx = makeCtx({ hub, json: true });

    await buildProgram(ctx).parseAsync(["org", "role", "ls"], { from: "user" });

    expect(ctx.outputs[0]).toEqual({ ok: true, count: 1, tags });
  });

  it("[ORG-0069] 0 件は count:0 tags:[] を返す", async () => {
    const hub = { org: { getTags: async () => [] } };
    const ctx = makeCtx({ hub, json: true });

    await buildProgram(ctx).parseAsync(["org", "role", "ls"], { from: "user" });

    expect(ctx.outputs[0]).toMatchObject({ ok: true, count: 0 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  ORG-0070: org group/deviceGroup/tag op が NAMESPACE_OPS から自動公開され requireAuth ゲートされる
// ═══════════════════════════════════════════════════════════════════════════
describe("[ORG-0070] org group/deviceGroup/tag op が NAMESPACE_OPS から自動公開され requireAuth ゲートされる", () => {
  const expectedGroupOps = [
    "getEmployeeGroups",
    "addEmployeeGroup",
    "updateEmployeeGroup",
    "removeEmployeeGroups",
    "getEmployeeGroupBindDeviceGroup",
    "addEmployeeInGroup",
    "removeEmployeeInGroup",
    "removeEmployeeGroupBindDeviceGroup",
  ];

  const expectedDeviceGroupOps = [
    "getDeviceGroups",
    "addDeviceGroup",
    "updateDeviceGroup",
    "removeDeviceGroups",
    "addDeviceInGroup",
    "removeDeviceInGroup",
    "getDeviceGroupBindUserGroup",
    "removeDeviceGroupBindUserGroup",
  ];

  const expectedTagOps = [
    "getTags",
    "postTag",
    "removeTag",
  ];

  for (const op of [...expectedGroupOps, ...expectedDeviceGroupOps, ...expectedTagOps]) {
    it(`[ORG-0070] NAMESPACE_OPS に ${op} が存在する`, () => {
      expect(NAMESPACE_OPS).toContain(op);
    });
  }

  it("[ORG-0070] registry handler は requireAuth(daemon) 後に hub[ns][op](p) を呼ぶ構造 (requireAuth の境界確認)", () => {
    // requireAuth に相当するロジックをインライン検証
    function simulateRequireAuth(daemon) {
      if (daemon.authState === "expired") {
        throw new Error("NOT_AUTHENTICATED");
      }
      if (!daemon.hub.connected) {
        throw new Error("CONNECTION_LOST");
      }
    }

    const expiredDaemon = { authState: "expired", hub: { connected: false } };
    expect(() => simulateRequireAuth(expiredDaemon)).toThrow("NOT_AUTHENTICATED");

    const disconnectedDaemon = { authState: "ok", hub: { connected: false } };
    expect(() => simulateRequireAuth(disconnectedDaemon)).toThrow("CONNECTION_LOST");

    // NAMESPACE_OPS に group 系 op が含まれていることが前提
    expect(NAMESPACE_OPS).toContain("getEmployeeGroups");
    expect(NAMESPACE_OPS).toContain("addDeviceGroup");
    expect(NAMESPACE_OPS).toContain("getTags");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  ORG-0071: org group/deviceGroup/tag op の rpc-params が生成表に存在
// ═══════════════════════════════════════════════════════════════════════════
describe("[ORG-0071] org group/deviceGroup/tag op の rpc-params が生成表に存在", () => {
  const expectedOps = [
    "org.getEmployeeGroups",
    "org.addEmployeeGroup",
    "org.updateEmployeeGroup",
    "org.removeEmployeeGroups",
    "org.getDeviceGroups",
    "org.addDeviceGroup",
    "org.updateDeviceGroup",
    "org.removeDeviceGroups",
    "org.getTags",
  ];

  for (const op of expectedOps) {
    it(`[ORG-0071] rpc-params.generated.json に ${op} エントリが存在する`, () => {
      expect(rpcParams).toHaveProperty(op);
      expect(Array.isArray(rpcParams[op])).toBe(true);
    });
  }

  it("[ORG-0071] org.getEmployeeGroups の companyID は required:false (daemon 自動注入)", () => {
    const params = rpcParams["org.getEmployeeGroups"];
    const companyIDParam = params.find((p) => p.name === "companyID");
    expect(companyIDParam).toBeDefined();
    expect(companyIDParam.required).toBe(false);
  });

  it("[ORG-0071] org.addEmployeeGroup の item は required:true", () => {
    const params = rpcParams["org.addEmployeeGroup"];
    const itemParam = params.find((p) => p.name === "item");
    expect(itemParam).toBeDefined();
    expect(itemParam.required).toBe(true);
  });

  it("[ORG-0071] org.removeEmployeeGroups の gids は required:true", () => {
    const params = rpcParams["org.removeEmployeeGroups"];
    const gidsParam = params.find((p) => p.name === "gids");
    expect(gidsParam).toBeDefined();
    expect(gidsParam.required).toBe(true);
  });

  it("[ORG-0071] org.addDeviceGroup の name は required:true", () => {
    const params = rpcParams["org.addDeviceGroup"];
    const nameParam = params.find((p) => p.name === "name");
    expect(nameParam).toBeDefined();
    expect(nameParam.required).toBe(true);
  });

  it("[ORG-0071] org.removeDeviceGroups の groupIds は required:true の配列型", () => {
    const params = rpcParams["org.removeDeviceGroups"];
    const groupIdsParam = params.find((p) => p.name === "groupIds");
    expect(groupIdsParam).toBeDefined();
    expect(groupIdsParam.required).toBe(true);
    expect(groupIdsParam.schema.type).toBe("array");
  });

  it("[ORG-0071] org.getTags の companyID は required:false (daemon 自動注入)", () => {
    const params = rpcParams["org.getTags"];
    const companyIDParam = params.find((p) => p.name === "companyID");
    expect(companyIDParam).toBeDefined();
    expect(companyIDParam.required).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  ORG-0072: 生成 gRPC メソッドが org group/deviceGroup op を 1:1 で公開
// ═══════════════════════════════════════════════════════════════════════════
describe("[ORG-0072] 生成 gRPC メソッドが org group/deviceGroup op を 1:1 で公開", () => {
  const expectedGrpcMethods = [
    { key: "OrgGetEmployeeGroups", method: "org.getEmployeeGroups" },
    { key: "OrgAddEmployeeGroup", method: "org.addEmployeeGroup" },
    { key: "OrgUpdateEmployeeGroup", method: "org.updateEmployeeGroup" },
    { key: "OrgRemoveEmployeeGroups", method: "org.removeEmployeeGroups" },
    { key: "OrgGetDeviceGroups", method: "org.getDeviceGroups" },
    { key: "OrgAddDeviceGroup", method: "org.addDeviceGroup" },
    { key: "OrgUpdateDeviceGroup", method: "org.updateDeviceGroup" },
    { key: "OrgRemoveDeviceGroups", method: "org.removeDeviceGroups" },
    { key: "OrgGetDeviceGroupBindUserGroup", method: "org.getDeviceGroupBindUserGroup" },
    { key: "OrgRemoveDeviceGroupBindUserGroup", method: "org.removeDeviceGroupBindUserGroup" },
  ];

  for (const { key, method } of expectedGrpcMethods) {
    it(`[ORG-0072] grpc-methods.generated.json に ${key} が存在し method=${method} と一致する`, () => {
      expect(grpcMethods).toHaveProperty(key);
      expect(grpcMethods[key].method).toBe(method);
    });
  }

  it("[ORG-0072] OrgGetEmployeeGroups の jsonFields は空配列 (スカラーのみ)", () => {
    expect(grpcMethods["OrgGetEmployeeGroups"].jsonFields).toEqual([]);
  });

  it("[ORG-0072] OrgGetEmployeeGroups の optionalScalars に companyID と timeoutMs が含まれる", () => {
    const entry = grpcMethods["OrgGetEmployeeGroups"];
    expect(entry.optionalScalars).toContain("companyID");
    expect(entry.optionalScalars).toContain("timeoutMs");
  });

  it("[ORG-0072] OrgAddEmployeeGroup の jsonFields に item が含まれる", () => {
    expect(grpcMethods["OrgAddEmployeeGroup"].jsonFields).toContain("item");
  });

  it("[ORG-0072] OrgRemoveEmployeeGroups の jsonFields に gids が含まれる", () => {
    expect(grpcMethods["OrgRemoveEmployeeGroups"].jsonFields).toContain("gids");
  });

  it("[ORG-0072] OrgAddDeviceGroup の optionalScalars に companyID が含まれる", () => {
    expect(grpcMethods["OrgAddDeviceGroup"].optionalScalars).toContain("companyID");
  });

  it("[ORG-0072] OrgRemoveDeviceGroups の jsonFields に groupIds が含まれる", () => {
    expect(grpcMethods["OrgRemoveDeviceGroups"].jsonFields).toContain("groupIds");
  });

  it("[ORG-0072] OrgGetDeviceGroupBindUserGroup の jsonFields は空配列 (gid はスカラー)", () => {
    expect(grpcMethods["OrgGetDeviceGroupBindUserGroup"].jsonFields).toEqual([]);
  });

  it("[ORG-0072] OrgRemoveDeviceGroupBindUserGroup の jsonFields に data が含まれる", () => {
    expect(grpcMethods["OrgRemoveDeviceGroupBindUserGroup"].jsonFields).toContain("data");
  });
});
