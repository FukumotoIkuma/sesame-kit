// packages/core/tests/_spec/org-c2.test.js
// TDD テスト: ORG-0037 ~ ORG-0054 (employeeGroup / role / deviceGroup)
// 統合版: A/B 両実装の良い部分を統合。各 it 先頭に [<ID>] を付与。
// assert は spec に従い実装の現状に合わせず仕様値を採用 (red 許容)。
//
// 一次参照: packages/core/src/org.js / useManageEmployee.js / useManageGroup.js
// 実際の throw メッセージ: packages/core/src/i18n/org.js の en.* を参照。

import { describe, it, expect } from "vitest";
import * as org from "../../src/org.js";
import { mockClient } from "../helpers/mock-ws.js";

// ════════════════════════════ employeeGroup ════════════════════════════

describe("addEmployeeGroup (ORG-0037)", () => {
  it("[ORG-0037] data 欠落時は undefined を返す (resp 全体にフォールバックしない)", async () => {
    // ref: useManageEmployee.js:51-52 は message.data を無条件展開 (フォールバック無し)
    //      org.js:275 `return resp.data` もフォールバック無し
    const c = mockClient({ success: true }); // data フィールドなし
    const r = await org.addEmployeeGroup(c, { companyID: "ch_X", item: { name: "G" } });
    expect(r).toBeUndefined();
  });
});

describe("updateEmployeeGroup (ORG-0038)", () => {
  it("[ORG-0038] obj:{cid,...item} でラップ op:'update' が biz3 と一致する", async () => {
    // ref: useManageEmployee.js:230-246 postEmployeeGroupInfo が obj:{cid:companyID,...item}/op:'update'
    //      org.js:288 送信フレームと一致
    const c = mockClient({ success: true });
    await org.updateEmployeeGroup(c, { companyID: "ch_X", item: { gid: "g1", name: "NewName" } });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: "biz3ManageEmployeeGroup",
      obj: { cid: "ch_X", gid: "g1", name: "NewName" },
      op: "update",
    });
  });

  it("[ORG-0038] obj ネスト内に cid が入りトップレベルには cid が無い", async () => {
    // cid は obj 内のみ。トップレベルに cid は存在しない
    const c = mockClient({ success: true });
    await org.updateEmployeeGroup(c, { companyID: "ch_Y", item: { gid: "g2" } });
    expect(c.sent[0]).not.toHaveProperty("cid");
    expect(c.sent[0].obj.cid).toBe("ch_Y");
  });

  it("[ORG-0038] companyID 未指定で badRequest を throw し send しない", async () => {
    const c = mockClient({ success: true });
    await expect(org.updateEmployeeGroup(c, { item: { gid: "g1" } })).rejects.toThrow(
      /companyID required/,
    );
    expect(c.sent).toHaveLength(0);
  });
});

describe("removeEmployeeGroups (ORG-0039, ORG-0040)", () => {
  it("[ORG-0039] objs(配列)+cid 直置き op:'deleteGroups' が biz3 と一致する", async () => {
    // ref: useManageEmployee.js:248-261 objs:gids(トップレベル配列)+cid:companyID 別キー直置き/op:'deleteGroups'
    //      org.js:307 と一致
    const c = mockClient({ success: true });
    await org.removeEmployeeGroups(c, { companyID: "ch_X", gids: ["g1", "g2"] });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: "biz3ManageEmployeeGroup",
      objs: ["g1", "g2"],
      cid: "ch_X",
      op: "deleteGroups",
    });
    // トップレベルに cid が別キーとして存在し、objs 内に cid を入れないこと
    expect(c.sent[0].cid).toBe("ch_X");
    expect(c.sent[0].objs).toEqual(["g1", "g2"]);
  });

  it("[ORG-0039] トップレベルに objs キーと cid キーが並立し obj(単数)は無い", async () => {
    const c = mockClient({ success: true });
    await org.removeEmployeeGroups(c, { companyID: "ch_X", gids: ["g3"] });
    expect(c.sent[0]).toHaveProperty("objs");
    expect(c.sent[0]).toHaveProperty("cid");
    expect(c.sent[0]).not.toHaveProperty("obj");
  });

  it("[ORG-0040] gids が配列でないとき WS 送信せず badRequest を throw する", async () => {
    // ref: org.js:305 `if (!Array.isArray(gids)) throw badRequest("org.req.gidsArray")` が client.request(:306)前
    const c = mockClient({});
    await expect(
      org.removeEmployeeGroups(c, { companyID: "ch_X", gids: "g1" }),
    ).rejects.toThrow(/gids must be an array/);
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0040] gids がオブジェクトでも WS 送信せず badRequest を throw する", async () => {
    const c = mockClient({});
    await expect(
      org.removeEmployeeGroups(c, { companyID: "ch_X", gids: { gid: "g1" } }),
    ).rejects.toThrow(/gids must be an array/);
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0040] gids が undefined でも badRequest を throw し send しない", async () => {
    const c = mockClient({});
    await expect(
      org.removeEmployeeGroups(c, { companyID: "ch_X", gids: undefined }),
    ).rejects.toThrow(/gids must be an array/);
    expect(c.sent).toHaveLength(0);
  });
});

describe("getEmployeeGroupBindDeviceGroup (ORG-0041, ORG-0042)", () => {
  it("[ORG-0041] gid のみ送り cid を含めない (biz3 getDeviceGroup と一致)", async () => {
    // ref: useManageEmployee.js:321-334 getDeviceGroup は gid と op:'getBindDeviceGroup' のみ
    //      org.js:324 も cid を送らず resp.data を返す(:329)
    const c = mockClient({ success: true, data: { x: 1 } });
    await org.getEmployeeGroupBindDeviceGroup(c, { gid: "g1" });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: "biz3ManageEmployeeGroup",
      gid: "g1",
      op: "getBindDeviceGroup",
    });
    expect(c.sent[0]).not.toHaveProperty("cid");
    expect(c.sent[0]).not.toHaveProperty("companyID");
  });

  it("[ORG-0041] resp.data を直返しする (resp 全体にフォールバックしない)", async () => {
    const c = mockClient({ success: true, data: { groups: ["dg1"] } });
    const r = await org.getEmployeeGroupBindDeviceGroup(c, { gid: "g1" });
    expect(r).toEqual({ groups: ["dg1"] });
  });

  it("[ORG-0041] data 欠落時は undefined (resp にフォールバックしない)", async () => {
    const c = mockClient({ success: true });
    const r = await org.getEmployeeGroupBindDeviceGroup(c, { gid: "g1" });
    expect(r).toBeUndefined();
  });

  it("[ORG-0042] gid 未指定時に WS 送信せず badRequest を throw する", async () => {
    // ref: org.js:322 `if (!gid) throw badRequest("org.req.gid")` が client.request(:323)前
    const c = mockClient({});
    await expect(
      org.getEmployeeGroupBindDeviceGroup(c, {}),
    ).rejects.toThrow(/gid required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0042] gid が空文字でも WS 送信せず badRequest を throw する", async () => {
    const c = mockClient({});
    await expect(
      org.getEmployeeGroupBindDeviceGroup(c, { gid: "" }),
    ).rejects.toThrow(/gid required/);
    expect(c.sent).toHaveLength(0);
  });
});

describe("addEmployeeInGroup (ORG-0043)", () => {
  it("[ORG-0043] cid/gid/uuids/items 全直置き op:'addBindUser' が biz3 と一致する", async () => {
    // ref: useManageEmployee.js:336-352 biz3 src 343-346 / org.js frame は line 343
    //      items は絞り込まず透過する点が removeBindUser と異なる
    const c = mockClient({ success: true });
    const uuids = ["u1", "u2"];
    const items = [{ subUUID: "u1", extraField: "ignored" }, { subUUID: "u2", extraField: "also" }];
    await org.addEmployeeInGroup(c, { companyID: "ch_X", gid: "g1", uuids, items });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: "biz3ManageEmployeeGroup",
      cid: "ch_X",
      gid: "g1",
      uuids,
      items, // 透過: extraField も残る
      op: "addBindUser",
    });
  });

  it("[ORG-0043] items フィールドが絞り込まれていないこと (透過)", async () => {
    // addEmployeeInGroup は removeEmployeeInGroup と異なり items を写像しない
    const c = mockClient({ success: true });
    const items = [{ subUUID: "u1", employeeName: "Alice", department: "Eng" }];
    await org.addEmployeeInGroup(c, { companyID: "ch_X", gid: "g1", uuids: ["u1"], items });
    expect(c.sent[0].items[0]).toHaveProperty("employeeName", "Alice");
    expect(c.sent[0].items[0]).toHaveProperty("department", "Eng");
  });

  it("[ORG-0043] uuids と items が両方フレームに入る", async () => {
    const c = mockClient({ success: true });
    await org.addEmployeeInGroup(c, {
      companyID: "ch_X",
      gid: "g1",
      uuids: ["u1", "u2"],
      items: [{ subUUID: "u1" }, { subUUID: "u2" }],
    });
    expect(c.sent[0]).toHaveProperty("uuids");
    expect(c.sent[0]).toHaveProperty("items");
    expect(c.sent[0].uuids).toEqual(["u1", "u2"]);
  });
});

describe("removeEmployeeInGroup (ORG-0044, ORG-0045)", () => {
  it("[ORG-0044] items を {subUUID} のみに絞り込んで送る (biz3 と一致)", async () => {
    // ref: useManageEmployee.js:354-373, :358-360 が params=items.map(i=>({subUUID:i.subUUID}))
    //      org.js:362 が同写像 / frame line 364
    const c = mockClient({ success: true });
    await org.removeEmployeeInGroup(c, {
      companyID: "ch_X",
      gid: "g1",
      uuids: ["u1"],
      items: [{ subUUID: "u1", employeeName: "Alice", extra: 1 }],
    });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: "biz3ManageEmployeeGroup",
      cid: "ch_X",
      gid: "g1",
      uuids: ["u1"],
      items: [{ subUUID: "u1" }], // subUUID のみ
      op: "removeBindUser",
    });
    // 余分なフィールドが削除されていること
    expect(c.sent[0].items[0]).not.toHaveProperty("employeeName");
    expect(c.sent[0].items[0]).not.toHaveProperty("extra");
  });

  it("[ORG-0044] 複数要素でも各要素が {subUUID} のみになる", async () => {
    const c = mockClient({ success: true });
    await org.removeEmployeeInGroup(c, {
      companyID: "ch_X",
      gid: "g1",
      uuids: ["u1", "u2"],
      items: [
        { subUUID: "u1", name: "Alice" },
        { subUUID: "u2", name: "Bob" },
      ],
    });
    expect(c.sent[0].items).toEqual([{ subUUID: "u1" }, { subUUID: "u2" }]);
  });

  it("[ORG-0045] items が配列でないとき map 前に badRequest を throw する", async () => {
    // ref: org.js:360 が if(!Array.isArray(items)) throw badRequest('org.req.itemsArray'), map(line 362)より前
    const c = mockClient({});
    await expect(
      org.removeEmployeeInGroup(c, { companyID: "ch_X", gid: "g1", uuids: ["u1"], items: "not-array" }),
    ).rejects.toThrow(/items must be an array/);
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0045] items が null でも WS 送信せず badRequest を throw する", async () => {
    const c = mockClient({});
    await expect(
      org.removeEmployeeInGroup(c, { companyID: "ch_X", gid: "g1", uuids: ["u1"], items: null }),
    ).rejects.toThrow(/items must be an array/);
    expect(c.sent).toHaveLength(0);
  });
});

describe("removeEmployeeGroupBindDeviceGroup (ORG-0046)", () => {
  it("[ORG-0046] cid + ...data 直置き op:'removeBindDeviceGroup' (op が data.op を上書き)", async () => {
    // ref: useManageEmployee.js:375-389 biz3 frame line 382 で cid,...data,op 後置
    //      op:'removeBindDeviceGroup' が ...data の後に置かれ data 内 op を上書き
    //      org.js:382 { action:ACT_EMPLOYEE_GROUP, cid:companyID, ...data, op:'removeBindDeviceGroup' }
    const c = mockClient({ success: true });
    await org.removeEmployeeGroupBindDeviceGroup(c, {
      companyID: "ch_X",
      data: { gid: "g1", dgid: "d1" },
    });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: "biz3ManageEmployeeGroup",
      cid: "ch_X",
      gid: "g1",
      dgid: "d1",
      op: "removeBindDeviceGroup",
    });
  });

  it("[ORG-0046] data に op が含まれていても op:'removeBindDeviceGroup' で上書きされる", async () => {
    // op 後置によりスプレッド後に op を配置し、data 内の op を上書きする契約
    const c = mockClient({ success: true });
    await org.removeEmployeeGroupBindDeviceGroup(c, {
      companyID: "ch_X",
      data: { gid: "g1", op: "should-be-overwritten" },
    });
    expect(c.sent[0].op).toBe("removeBindDeviceGroup");
  });

  it("[ORG-0046] companyID 未指定で WS 送信せず badRequest を throw する", async () => {
    const c = mockClient({});
    await expect(
      org.removeEmployeeGroupBindDeviceGroup(c, { data: { gid: "g1" } }),
    ).rejects.toThrow(/companyID required/);
    expect(c.sent).toHaveLength(0);
  });
});

// ════════════════════════════ role ════════════════════════════

describe("getTags (ORG-0047, ORG-0050)", () => {
  it("[ORG-0047] 送信フレームが {action:'biz3ManageRole', companyID, op:'get'} で companyID キー名が cid でない", async () => {
    // ref: useManageEmployee.js:35-43 sendMessage({action:BIZ3_MANAGE_ROLE, companyID, op:'get'})
    //      useManageEmployee.js:124-127 setTags(message.data)
    //      org.js:401-409 一致。role 系のみ companyID キー(employeeGroup/deviceGroup の cid と異なる)
    const c = mockClient({ success: true, data: [{ tag: "role1", access: ["lock"] }] });
    const r = await org.getTags(c, { companyID: "ch_X" });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: "biz3ManageRole",
      companyID: "ch_X",
      op: "get",
    });
    // cid キーでなく companyID キーであること
    expect(c.sent[0]).not.toHaveProperty("cid");
    expect(c.sent[0]).toHaveProperty("companyID", "ch_X");
    // 応答 data 配列を返す
    expect(r).toEqual([{ tag: "role1", access: ["lock"] }]);
  });

  it("[ORG-0047] data が null の場合は空配列を返す (??[] フォールバック)", async () => {
    const c = mockClient({ success: true, data: null });
    const r = await org.getTags(c, { companyID: "ch_X" });
    expect(r).toEqual([]);
  });

  it("[ORG-0047] data が空配列のとき空配列を返す", async () => {
    const c = mockClient({ success: true, data: [] });
    const r = await org.getTags(c, { companyID: "ch_X" });
    expect(r).toEqual([]);
  });

  it("[ORG-0050] companyID 未指定で WS 送信せず badRequest を throw する (getTags)", async () => {
    // ref: org.js:402 if(!companyID) throw badRequest('org.req.companyID') が client.request前
    const c = mockClient({});
    await expect(org.getTags(c, {})).rejects.toThrow(/companyID required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0050] companyID が空文字でも WS 送信せず badRequest を throw する (getTags)", async () => {
    const c = mockClient({});
    await expect(org.getTags(c, { companyID: "" })).rejects.toThrow(/companyID required/);
    expect(c.sent).toHaveLength(0);
  });
});

describe("postTag (ORG-0048, ORG-0050)", () => {
  it("[ORG-0048] 送信フレームが {action:'biz3ManageRole', companyID, ...data, op:'post'} で op が data.op を上書きする", async () => {
    // ref: useManageEmployee.js:289-303 biz3 frame line 297-298 で ...data 後に op:'post' 後置
    //      org.js:422 が同順。フィールド出現順(op 後置)が一次資料どおり load-bearing
    const c = mockClient({ success: true });
    await org.postTag(c, { companyID: "ch_X", data: { tag: "role1", access: ["lock"], op: "should-be-overwritten" } });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: "biz3ManageRole",
      companyID: "ch_X",
      tag: "role1",
      access: ["lock"],
      op: "post",
    });
    // op が 'post' に上書きされていること
    expect(c.sent[0].op).toBe("post");
  });

  it("[ORG-0048] data に op がなくても op:'post' で送信される", async () => {
    const c = mockClient({ success: true });
    await org.postTag(c, { companyID: "ch_X", data: { tag: "newRole" } });
    expect(c.sent[0].op).toBe("post");
    expect(c.sent[0]).toHaveProperty("tag", "newRole");
  });

  it("[ORG-0048] data にフィールドが多くても companyID/action/op は固定位置", async () => {
    const c = mockClient({ success: true });
    await org.postTag(c, {
      companyID: "ch_Y",
      data: { name: "r2", color: "#fff", tagType: 1 },
    });
    expect(c.sent[0].action).toBe("biz3ManageRole");
    expect(c.sent[0].companyID).toBe("ch_Y");
    expect(c.sent[0].op).toBe("post");
    expect(c.sent[0].name).toBe("r2");
    expect(c.sent[0].color).toBe("#fff");
  });

  it("[ORG-0050] companyID 未指定で WS 送信せず badRequest を throw する (postTag)", async () => {
    // ref: org.js:420 if(!companyID) throw badRequest('org.req.companyID') が client.request前
    const c = mockClient({});
    await expect(org.postTag(c, { data: { tag: "role1" } })).rejects.toThrow(/companyID required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0050] companyID が空文字でも badRequest を throw する (postTag)", async () => {
    const c = mockClient({});
    await expect(org.postTag(c, { companyID: "", data: { name: "r" } })).rejects.toThrow(
      /companyID required/,
    );
    expect(c.sent).toHaveLength(0);
  });
});

describe("removeTag (ORG-0049, ORG-0050)", () => {
  it("[ORG-0049] 送信フレームが {action:'biz3ManageRole', companyID, ...data, op:'delete'} で data に tagSetting 全体を載せる", async () => {
    // ref: useManageEmployee.js:305-319 biz3 frame line 313-314 で ...data 後に op:'delete' 後置
    //      data 形 {tag, access[]} は DataTableColumns.js:627 で tagSetting 全体が spread されること
    //      org.js:436-444 が同形
    const c = mockClient({ success: true });
    const tagSetting = { tag: "role1", access: ["lock", "unlock"], isShowAdd: true };
    await org.removeTag(c, { companyID: "ch_X", data: tagSetting });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: "biz3ManageRole",
      companyID: "ch_X",
      tag: "role1",
      access: ["lock", "unlock"],
      isShowAdd: true,
      op: "delete",
    });
    // op が後置されて 'delete' であること
    expect(c.sent[0].op).toBe("delete");
  });

  it("[ORG-0049] data に op が含まれていても op:'delete' で上書きされる", async () => {
    const c = mockClient({ success: true });
    await org.removeTag(c, { companyID: "ch_X", data: { tag: "r1", access: [], op: "wrong" } });
    expect(c.sent[0].op).toBe("delete");
  });

  it("[ORG-0049] data 内に isShowAdd 等の追加フィールドも透過される", async () => {
    const c = mockClient({ success: true });
    await org.removeTag(c, {
      companyID: "ch_X",
      data: { tag: "manager", access: ["lock", "unlock"], isShowAdd: false },
    });
    expect(c.sent[0]).toEqual({
      action: "biz3ManageRole",
      companyID: "ch_X",
      tag: "manager",
      access: ["lock", "unlock"],
      isShowAdd: false,
      op: "delete",
    });
  });

  it("[ORG-0050] companyID 未指定で WS 送信せず badRequest を throw する (removeTag)", async () => {
    // ref: org.js:437 if(!companyID) throw badRequest('org.req.companyID') が client.request前
    const c = mockClient({});
    await expect(org.removeTag(c, { data: { tag: "r1" } })).rejects.toThrow(/companyID required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0050] companyID が空文字でも badRequest を throw する (removeTag)", async () => {
    const c = mockClient({});
    await expect(
      org.removeTag(c, { companyID: "", data: { tag: "t1" } }),
    ).rejects.toThrow(/companyID required/);
    expect(c.sent).toHaveLength(0);
  });
});

// ════════════════════════════ deviceGroup ════════════════════════════

describe("getDeviceGroups (ORG-0051)", () => {
  it("[ORG-0051] 送信フレームが {action:'biz3ManageDeviceGroup', cid:companyID, op:'getGroups'} で cid キー直置き", async () => {
    // ref: useManageGroup.js:11-19 biz3 web 14-18 が cid 直置き
    //      useManageGroup.js:27-33 が message.data 読取
    //      org.js:461 一致。action 文字列値 'biz3ManageDeviceGroup' は messageConstants.js:11
    const c = mockClient({ success: true, data: [{ gid: "dg1", name: "DG1" }] });
    const r = await org.getDeviceGroups(c, { companyID: "ch_X" });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: "biz3ManageDeviceGroup",
      cid: "ch_X",
      op: "getGroups",
    });
    // cid キーで companyID を送り、companyID キーでないこと
    expect(c.sent[0]).toHaveProperty("cid", "ch_X");
    expect(c.sent[0]).not.toHaveProperty("companyID");
    // 応答 data 配列を返す
    expect(r).toEqual([{ gid: "dg1", name: "DG1" }]);
  });

  it("[ORG-0051] companyID 未指定で badRequest を throw する", async () => {
    const c = mockClient({});
    await expect(org.getDeviceGroups(c, {})).rejects.toThrow(/companyID required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0051] data が null の場合は空配列を返す (??[] フォールバック)", async () => {
    const c = mockClient({ success: true, data: null });
    const r = await org.getDeviceGroups(c, { companyID: "ch_X" });
    expect(r).toEqual([]);
  });

  it("[ORG-0051] data が空配列のとき空配列を返す", async () => {
    const c = mockClient({ success: true, data: [] });
    const r = await org.getDeviceGroups(c, { companyID: "ch_X" });
    expect(r).toEqual([]);
  });
});

describe("addDeviceGroup (ORG-0052, ORG-0053)", () => {
  it("[ORG-0052] 送信フレームが {action:'biz3ManageDeviceGroup', obj:{name,cid,uuids}, op:'add'} でキー順が一致する", async () => {
    // ref: useManageGroup.js:84-102 biz3 88-92 で data={name,cid,uuids}, 95 で obj:{...data}
    //      org.js:479 が name,cid,uuids キー順一致
    //      employeeGroup add は obj:{cid,...item}。deviceGroup add は name/uuids を明示フィールドで持つ差異
    const c = mockClient({ success: true });
    await org.addDeviceGroup(c, { companyID: "ch_X", name: "DG", uuids: ["d1", "d2"] });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: "biz3ManageDeviceGroup",
      obj: { name: "DG", cid: "ch_X", uuids: ["d1", "d2"] },
      op: "add",
    });
    // obj 内のキー順: name, cid, uuids の順に存在すること
    const objKeys = Object.keys(c.sent[0].obj);
    expect(objKeys).toEqual(["name", "cid", "uuids"]);
  });

  it("[ORG-0052] obj はネストされトップレベルに cid/name は無い", async () => {
    // obj 内に name/cid/uuids、トップレベルには存在しない
    const c = mockClient({ success: true });
    await org.addDeviceGroup(c, { companyID: "ch_X", name: "DG-B", uuids: [] });
    expect(c.sent[0]).not.toHaveProperty("cid");
    expect(c.sent[0]).not.toHaveProperty("name");
    expect(c.sent[0]).toHaveProperty("obj");
  });

  it("[ORG-0052] employeeGroup addEmployeeGroup と異なり obj 内が name/cid/uuids 明示フィールド", async () => {
    // employeeGroup は obj:{cid,...item} だが deviceGroup は obj:{name,cid,uuids} と明示
    const c = mockClient({ success: true });
    await org.addDeviceGroup(c, { companyID: "ch_Y", name: "MyGroup", uuids: [] });
    expect(c.sent[0].obj).toHaveProperty("name", "MyGroup");
    expect(c.sent[0].obj).toHaveProperty("cid", "ch_Y");
    expect(c.sent[0].obj).toHaveProperty("uuids");
  });

  it("[ORG-0053] uuids 省略時は既定 [] が obj.uuids に入る (core 既定値 uuids=[])", async () => {
    // ref: org.js:476 引数既定 uuids=[]
    const c = mockClient({ success: true });
    await org.addDeviceGroup(c, { companyID: "ch_X", name: "DG" }); // uuids 省略
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0].obj.uuids).toEqual([]);
  });

  it("[ORG-0053] uuids を明示指定した場合はその値が使われる", async () => {
    const c = mockClient({ success: true });
    await org.addDeviceGroup(c, { companyID: "ch_X", name: "DG", uuids: ["d1"] });
    expect(c.sent[0].obj.uuids).toEqual(["d1"]);
  });

  it("[ORG-0053] uuids を複数指定したときも全て obj.uuids に入る", async () => {
    const c = mockClient({ success: true });
    await org.addDeviceGroup(c, { companyID: "ch_X", name: "DG-D", uuids: ["d3", "d4", "d5"] });
    expect(c.sent[0].obj.uuids).toEqual(["d3", "d4", "d5"]);
  });

  it("[ORG-0053] companyID 未指定で badRequest を throw する", async () => {
    const c = mockClient({});
    await expect(org.addDeviceGroup(c, { name: "DG" })).rejects.toThrow(/companyID required/);
    expect(c.sent).toHaveLength(0);
  });
});

describe("updateDeviceGroup (ORG-0054)", () => {
  it("[ORG-0054] 送信フレームが {action:'biz3ManageDeviceGroup', obj:{cid:companyID, ...item}, op:'update'} と一致する", async () => {
    // ref: useManageGroup.js:310-326 biz3 postDeviceGroupInfo 314-321 が obj:{cid,...item} op:'update'
    //      org.js:496 一致
    const c = mockClient({ success: true });
    await org.updateDeviceGroup(c, { companyID: "ch_X", item: { gid: "dg1", name: "Updated" } });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: "biz3ManageDeviceGroup",
      obj: { cid: "ch_X", gid: "dg1", name: "Updated" },
      op: "update",
    });
  });

  it("[ORG-0054] obj 内が {cid,...item} の形でラップされ item が展開されること", async () => {
    const c = mockClient({ success: true });
    const item = { gid: "dg2", name: "NewName", extra: "val" };
    await org.updateDeviceGroup(c, { companyID: "ch_X", item });
    expect(c.sent[0].obj).toEqual({ cid: "ch_X", gid: "dg2", name: "NewName", extra: "val" });
  });

  it("[ORG-0054] obj はネストされトップレベルに cid は無い", async () => {
    const c = mockClient({ success: true });
    await org.updateDeviceGroup(c, { companyID: "ch_Y", item: { gid: "dg2" } });
    expect(c.sent[0]).not.toHaveProperty("cid");
    expect(c.sent[0].obj.cid).toBe("ch_Y");
  });

  it("[ORG-0054] companyID 未指定で WS 送信せず badRequest を throw する", async () => {
    const c = mockClient({});
    await expect(org.updateDeviceGroup(c, { item: { gid: "dg1" } })).rejects.toThrow(
      /companyID required/,
    );
    expect(c.sent).toHaveLength(0);
  });
});
