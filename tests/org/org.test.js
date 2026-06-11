// org.js (組織管理) の単体テスト。
// biz3ManageEmployee / EmployeeGroup / Role / DeviceGroup / EmployeeDevice / GetDeviceEmployeeKeys
// の送信フレーム (action/op/フィールド名/ネスト構造) と応答パースを検証する。
//
// chunk 応答 (pubEmployees / pubQueryByCS) は send + subscribe の組合せ。
// mock client は request/send/subscribe を記録し、subscribe には登録された fn を
// テスト側から呼び出して push を疑似再現する。
import { describe, it, expect } from "vitest";
import * as org from "../../src/org.js";
// 共有 fake (P5-7 / ARCH-16): mockClient = 同期 op 用、chunkMockClient = push 集約 op 用。
import { mockClient, chunkMockClient } from "../helpers/mock-ws.js";

// ════════════════════════════ employee ════════════════════════════

describe("getEmployees", () => {
  it("companyID 必須", async () => {
    const c = mockClient({});
    await expect(org.getEmployees(c, {})).rejects.toThrow(/companyID required/);
  });

  it("send フレームは {action,companyID,op:'get'}、応答は pubEmployees chunk を集約", async () => {
    const c = chunkMockClient();
    const p = org.getEmployees(c, { companyID: "ch_X" });
    // send フレーム検証
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({ action: "biz3ManageEmployee", companyID: "ch_X", op: "get" });
    // pubEmployees を購読しているはず
    expect(c.hasSub("biz3ManageEmployee:pubEmployees")).toBe(true);
    // 2 ページに分けて push (totalCount=3)
    c.push("biz3ManageEmployee:pubEmployees", {
      action: "biz3ManageEmployee", op: "pubEmployees",
      data: { totalCount: 3, data: { list: [{ subUUID: "a" }, { subUUID: "b" }], page: 1 } },
    });
    c.push("biz3ManageEmployee:pubEmployees", {
      action: "biz3ManageEmployee", op: "pubEmployees",
      data: { totalCount: 3, data: { list: [{ subUUID: "c" }], page: 2 } },
    });
    const r = await p;
    expect(r.count).toBe(3);
    expect(r.list.map((e) => e.subUUID)).toEqual(["a", "b", "c"]);
  });

  it("totalCount=0 の単一 push で即完了", async () => {
    const c = chunkMockClient();
    const p = org.getEmployees(c, { companyID: "ch_X" });
    c.push("biz3ManageEmployee:pubEmployees", {
      data: { totalCount: 0, data: { list: [], page: 1 } },
    });
    const r = await p;
    expect(r).toEqual({ count: 0, list: [] });
  });

  it("success:false の push で reject", async () => {
    const c = chunkMockClient();
    const p = org.getEmployees(c, { companyID: "ch_X" });
    c.push("biz3ManageEmployee:pubEmployees", { success: false, message: "boom" });
    await expect(p).rejects.toThrow(/failed: boom/);
  });
});

describe("getCurrentUserInfo", () => {
  it("フレームは {action,op:'currentInfo'} (companyID/items 無し)", async () => {
    const c = mockClient({ success: true, data: { subUUID: "me" } });
    const r = await org.getCurrentUserInfo(c);
    expect(c.sent[0]).toEqual({ action: "biz3ManageEmployee", op: "currentInfo" });
    expect(r).toEqual({ subUUID: "me" });
  });
});

describe("addEmployees", () => {
  it("items をトップレベルに直置き (companyID は item 内)", async () => {
    const c = mockClient({ success: true });
    const items = [{ employeeEmail: "x@y.z", employeeName: "X", companyID: "ch_X", tag: [] }];
    await org.addEmployees(c, { items });
    expect(c.sent[0]).toEqual({ action: "biz3ManageEmployee", items, op: "add" });
    expect(c.sent[0]).not.toHaveProperty("companyID");
  });

  it("items が配列でなければ throw", async () => {
    const c = mockClient({});
    await expect(org.addEmployees(c, { items: {} })).rejects.toThrow(/items must be an array/);
  });

  it("Limit Exceeded は throw", async () => {
    const c = mockClient({ success: false, message: "Limit Exceeded" });
    await expect(org.addEmployees(c, { items: [] })).rejects.toThrow(/Limit Exceeded/);
  });
});

describe("updateEmployee", () => {
  it("update のみ obj:{companyID,...data} でラップ", async () => {
    const c = mockClient({ success: true });
    await org.updateEmployee(c, { companyID: "ch_X", data: { Name: "nick", Value: "v" } });
    expect(c.sent[0]).toEqual({
      action: "biz3ManageEmployee",
      obj: { companyID: "ch_X", Name: "nick", Value: "v" },
      op: "update",
    });
  });
  it("companyID 必須", async () => {
    const c = mockClient({});
    await expect(org.updateEmployee(c, { data: {} })).rejects.toThrow(/companyID required/);
  });
});

describe("removeEmployees", () => {
  it("items 直置き op:'delete'", async () => {
    const c = mockClient({ success: true });
    const items = [{ subUUID: "u-1", companyID: "ch_X" }];
    await org.removeEmployees(c, { items });
    expect(c.sent[0]).toEqual({ action: "biz3ManageEmployee", items, op: "delete" });
  });
});

describe("reorderEmployees", () => {
  it("items {friendUUID,rank} 直置き op:'order'", async () => {
    const c = mockClient({ success: true });
    const items = [{ friendUUID: "u-1", rank: 0 }, { friendUUID: "u-2", rank: -1 }];
    await org.reorderEmployees(c, { items });
    expect(c.sent[0]).toEqual({ action: "biz3ManageEmployee", items, op: "order" });
  });
});

describe("queryByCS", () => {
  it("送信 op は queryByCS だが購読 op は pubQueryByCS、totalPage まで集約し list を返す", async () => {
    const c = chunkMockClient();
    const p = org.queryByCS(c, { keyword: "tanaka" });
    expect(c.sent[0]).toEqual({ action: "biz3ManageEmployee", keyword: "tanaka", op: "queryByCS" });
    expect(c.hasSub("biz3ManageEmployee:pubQueryByCS")).toBe(true);
    c.push("biz3ManageEmployee:pubQueryByCS", {
      data: { data: { list: [{ id: 1 }], page: 1 }, totalPage: 2 },
    });
    c.push("biz3ManageEmployee:pubQueryByCS", {
      data: { data: { list: [{ id: 2 }], page: 2 }, totalPage: 2 },
    });
    const r = await p;
    expect(r).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("keyword 必須", async () => {
    const c = chunkMockClient();
    await expect(org.queryByCS(c, { keyword: "" })).rejects.toThrow(/keyword required/);
  });
});

describe("confirmQueryByCS", () => {
  it("フレームは {action,email,op:'confirmQueryByCS'}", async () => {
    const c = mockClient({ success: true });
    await org.confirmQueryByCS(c, { email: "x@y.z" });
    expect(c.sent[0]).toEqual({ action: "biz3ManageEmployee", email: "x@y.z", op: "confirmQueryByCS" });
  });
});

// ════════════════════════════ employeeGroup ════════════════════════════

describe("getEmployeeGroups", () => {
  it("cid 直置き op:'getGroups'、応答 data 配列を返す", async () => {
    const c = mockClient({ success: true, data: [{ gid: "g1" }] });
    const r = await org.getEmployeeGroups(c, { companyID: "ch_X" });
    expect(c.sent[0]).toEqual({ action: "biz3ManageEmployeeGroup", cid: "ch_X", op: "getGroups" });
    expect(r).toEqual([{ gid: "g1" }]);
  });
});

describe("addEmployeeGroup", () => {
  it("obj:{cid,...item} でラップ、応答 data を返す", async () => {
    const c = mockClient({ success: true, data: { gid: "g-new" } });
    const r = await org.addEmployeeGroup(c, { companyID: "ch_X", item: { name: "G" } });
    expect(c.sent[0]).toEqual({
      action: "biz3ManageEmployeeGroup",
      obj: { cid: "ch_X", name: "G" },
      op: "add",
    });
    expect(r).toEqual({ gid: "g-new" });
  });
});

describe("updateEmployeeGroup", () => {
  it("obj:{cid,...item} でラップ op:'update'", async () => {
    const c = mockClient({ success: true });
    await org.updateEmployeeGroup(c, { companyID: "ch_X", item: { gid: "g1", name: "G2" } });
    expect(c.sent[0]).toEqual({
      action: "biz3ManageEmployeeGroup",
      obj: { cid: "ch_X", gid: "g1", name: "G2" },
      op: "update",
    });
  });
});

describe("removeEmployeeGroups", () => {
  it("objs(配列)+cid 直置き op:'deleteGroups'", async () => {
    const c = mockClient({ success: true });
    await org.removeEmployeeGroups(c, { companyID: "ch_X", gids: ["g1", "g2"] });
    expect(c.sent[0]).toEqual({
      action: "biz3ManageEmployeeGroup",
      objs: ["g1", "g2"],
      cid: "ch_X",
      op: "deleteGroups",
    });
  });
  it("gids が配列でなければ throw", async () => {
    const c = mockClient({});
    await expect(org.removeEmployeeGroups(c, { companyID: "ch_X", gids: "x" })).rejects.toThrow(/gids must be an array/);
  });
});

describe("getEmployeeGroupBindDeviceGroup", () => {
  it("gid のみ送り cid は含めない", async () => {
    const c = mockClient({ success: true, data: { x: 1 } });
    await org.getEmployeeGroupBindDeviceGroup(c, { gid: "g1" });
    expect(c.sent[0]).toEqual({ action: "biz3ManageEmployeeGroup", gid: "g1", op: "getBindDeviceGroup" });
    expect(c.sent[0]).not.toHaveProperty("cid");
  });
});

describe("addEmployeeInGroup", () => {
  it("cid/gid/uuids/items 直置き op:'addBindUser'", async () => {
    const c = mockClient({ success: true });
    await org.addEmployeeInGroup(c, { companyID: "ch_X", gid: "g1", uuids: ["u1"], items: [{ subUUID: "u1", x: 9 }] });
    expect(c.sent[0]).toEqual({
      action: "biz3ManageEmployeeGroup",
      cid: "ch_X",
      gid: "g1",
      uuids: ["u1"],
      items: [{ subUUID: "u1", x: 9 }],
      op: "addBindUser",
    });
  });
});

describe("removeEmployeeInGroup", () => {
  it("items を {subUUID} のみに絞り込んで送る", async () => {
    const c = mockClient({ success: true });
    await org.removeEmployeeInGroup(c, {
      companyID: "ch_X", gid: "g1", uuids: ["u1"],
      items: [{ subUUID: "u1", employeeName: "X", extra: 1 }],
    });
    expect(c.sent[0]).toEqual({
      action: "biz3ManageEmployeeGroup",
      cid: "ch_X",
      gid: "g1",
      uuids: ["u1"],
      items: [{ subUUID: "u1" }],
      op: "removeBindUser",
    });
  });
});

describe("removeEmployeeGroupBindDeviceGroup", () => {
  it("cid + ...data 直置き op:'removeBindDeviceGroup'", async () => {
    const c = mockClient({ success: true });
    await org.removeEmployeeGroupBindDeviceGroup(c, { companyID: "ch_X", data: { gid: "g1", dgid: "d1" } });
    expect(c.sent[0]).toEqual({
      action: "biz3ManageEmployeeGroup",
      cid: "ch_X",
      gid: "g1",
      dgid: "d1",
      op: "removeBindDeviceGroup",
    });
  });
});

// ════════════════════════════ role ════════════════════════════

describe("getTags", () => {
  it("companyID (cid ではない) 直置き op:'get'、応答 data 配列", async () => {
    const c = mockClient({ success: true, data: [{ id: "t1" }] });
    const r = await org.getTags(c, { companyID: "ch_X" });
    expect(c.sent[0]).toEqual({ action: "biz3ManageRole", companyID: "ch_X", op: "get" });
    expect(c.sent[0]).not.toHaveProperty("cid");
    expect(r).toEqual([{ id: "t1" }]);
  });
});

describe("postTag", () => {
  it("companyID + ...data 直置き、op:'post' は data の op を上書き", async () => {
    const c = mockClient({ success: true });
    await org.postTag(c, { companyID: "ch_X", data: { name: "role1", op: "should-be-overwritten" } });
    expect(c.sent[0]).toEqual({ action: "biz3ManageRole", companyID: "ch_X", name: "role1", op: "post" });
  });
});

describe("removeTag", () => {
  it("companyID + ...data 直置き op:'delete'", async () => {
    const c = mockClient({ success: true });
    await org.removeTag(c, { companyID: "ch_X", data: { id: "t1" } });
    expect(c.sent[0]).toEqual({ action: "biz3ManageRole", companyID: "ch_X", id: "t1", op: "delete" });
  });
});

// ════════════════════════════ deviceGroup ════════════════════════════

describe("getDeviceGroups", () => {
  it("cid 直置き op:'getGroups'、応答 data 配列", async () => {
    const c = mockClient({ success: true, data: [{ gid: "dg1" }] });
    const r = await org.getDeviceGroups(c, { companyID: "ch_X" });
    expect(c.sent[0]).toEqual({ action: "biz3ManageDeviceGroup", cid: "ch_X", op: "getGroups" });
    expect(r).toEqual([{ gid: "dg1" }]);
  });
});

describe("addDeviceGroup", () => {
  it("obj:{name,cid,uuids} でラップ op:'add'", async () => {
    const c = mockClient({ success: true });
    await org.addDeviceGroup(c, { companyID: "ch_X", name: "DG", uuids: ["d1", "d2"] });
    expect(c.sent[0]).toEqual({
      action: "biz3ManageDeviceGroup",
      obj: { name: "DG", cid: "ch_X", uuids: ["d1", "d2"] },
      op: "add",
    });
  });
  it("uuids 省略時は空配列", async () => {
    const c = mockClient({ success: true });
    await org.addDeviceGroup(c, { companyID: "ch_X", name: "DG" });
    expect(c.sent[0].obj.uuids).toEqual([]);
  });
});

describe("updateDeviceGroup", () => {
  it("obj:{cid,...item} でラップ op:'update'", async () => {
    const c = mockClient({ success: true });
    await org.updateDeviceGroup(c, { companyID: "ch_X", item: { gid: "dg1", name: "X" } });
    expect(c.sent[0]).toEqual({
      action: "biz3ManageDeviceGroup",
      obj: { cid: "ch_X", gid: "dg1", name: "X" },
      op: "update",
    });
  });
});

describe("removeDeviceGroups", () => {
  it("各 obj に cid をマージした objs(複数形) を送る", async () => {
    const c = mockClient({ success: true });
    await org.removeDeviceGroups(c, { companyID: "ch_X", groupIds: [{ gid: "dg1" }, { gid: "dg2" }] });
    expect(c.sent[0]).toEqual({
      action: "biz3ManageDeviceGroup",
      objs: [{ gid: "dg1", cid: "ch_X" }, { gid: "dg2", cid: "ch_X" }],
      op: "deleteGroups",
    });
  });
});

describe("addDeviceInGroup", () => {
  it("items は絞り込まず透過 (cid/gid/uuids/items 直置き)", async () => {
    const c = mockClient({ success: true });
    const items = [{ deviceUUID: "d1", secretKey: "s1", deviceName: "Door" }];
    await org.addDeviceInGroup(c, { companyID: "ch_X", gid: "dg1", uuids: ["d1"], items });
    expect(c.sent[0]).toEqual({
      action: "biz3ManageDeviceGroup",
      cid: "ch_X",
      gid: "dg1",
      uuids: ["d1"],
      items, // 透過 (deviceName も残る)
      op: "addBindDevice",
    });
  });
});

describe("removeDeviceInGroup", () => {
  it("items を {deviceUUID,secretKey} のみに絞り込んで送る", async () => {
    const c = mockClient({ success: true });
    await org.removeDeviceInGroup(c, {
      companyID: "ch_X", gid: "dg1", uuids: ["d1"],
      items: [{ deviceUUID: "d1", secretKey: "s1", deviceName: "Door", extra: 1 }],
    });
    expect(c.sent[0]).toEqual({
      action: "biz3ManageDeviceGroup",
      cid: "ch_X",
      gid: "dg1",
      uuids: ["d1"],
      items: [{ deviceUUID: "d1", secretKey: "s1" }],
      op: "removeBindDevice",
    });
  });
});

describe("getDeviceGroupBindUserGroup", () => {
  it("gid のみ送り cid 無し", async () => {
    const c = mockClient({ success: true, data: { x: 1 } });
    await org.getDeviceGroupBindUserGroup(c, { gid: "dg1" });
    expect(c.sent[0]).toEqual({ action: "biz3ManageDeviceGroup", gid: "dg1", op: "getBindUserGroup" });
    expect(c.sent[0]).not.toHaveProperty("cid");
  });
});

describe("removeDeviceGroupBindUserGroup", () => {
  it("cid + ...data 直置き op:'removeBindUserGroup'", async () => {
    const c = mockClient({ success: true });
    await org.removeDeviceGroupBindUserGroup(c, { companyID: "ch_X", data: { gid: "dg1", mid: "m1" } });
    expect(c.sent[0]).toEqual({
      action: "biz3ManageDeviceGroup",
      cid: "ch_X",
      gid: "dg1",
      mid: "m1",
      op: "removeBindUserGroup",
    });
  });
});

// ════════════════════════════ employeeDevice ════════════════════════════

describe("shareDeviceKeysToEmployees", () => {
  it("items 直置き op:'add'、companyID 無し", async () => {
    const c = mockClient({ success: true });
    const items = [{ deviceUUID: "d1", secretKey: "s1", subUUID: "u1", keyLevel: 1, startTime: "", endTime: "" }];
    await org.shareDeviceKeysToEmployees(c, { items });
    expect(c.sent[0]).toEqual({ action: "biz3ManageEmployeeDevice", items, op: "add" });
    expect(c.sent[0]).not.toHaveProperty("companyID");
  });
});

describe("shareDeviceGroupKeysToEmployeeGroup", () => {
  it("...item + companyID (cid ではない) 直置き op:'group'", async () => {
    const c = mockClient({ success: true });
    const item = { keyLevel: "1", members: ["u1"], devices: ["d1"], mid: "m1", dids: ["dg1"], startTime: "", endTime: "" };
    await org.shareDeviceGroupKeysToEmployeeGroup(c, { companyID: "ch_X", item });
    expect(c.sent[0]).toEqual({
      action: "biz3ManageEmployeeDevice",
      keyLevel: "1",
      members: ["u1"],
      devices: ["d1"],
      mid: "m1",
      dids: ["dg1"],
      startTime: "",
      endTime: "",
      companyID: "ch_X",
      op: "group",
    });
  });
});

describe("getEmployeeDeviceKeys", () => {
  it("subUUID のみ op:'get'、companyID 無し", async () => {
    const c = mockClient({ success: true, data: [{ deviceUUID: "d1" }] });
    const r = await org.getEmployeeDeviceKeys(c, { subUUID: "u1" });
    expect(c.sent[0]).toEqual({ action: "biz3ManageEmployeeDevice", subUUID: "u1", op: "get" });
    expect(c.sent[0]).not.toHaveProperty("companyID");
    expect(r).toEqual([{ deviceUUID: "d1" }]);
  });
});

describe("removeEmployeeDeviceKey", () => {
  it("通常削除 = {subUUID,deviceUUID} を spread op:'del'", async () => {
    const c = mockClient({ success: true });
    await org.removeEmployeeDeviceKey(c, { data: { subUUID: "u1", deviceUUID: "d1" } });
    expect(c.sent[0]).toEqual({ action: "biz3ManageEmployeeDevice", subUUID: "u1", deviceUUID: "d1", op: "del" });
  });
  it("ゲスト削除 = {guestKeyId,randomTag,deviceUUID} を spread", async () => {
    const c = mockClient({ success: true });
    await org.removeEmployeeDeviceKey(c, { data: { guestKeyId: "g1", randomTag: "rt", deviceUUID: "d1" } });
    expect(c.sent[0]).toEqual({
      action: "biz3ManageEmployeeDevice",
      guestKeyId: "g1",
      randomTag: "rt",
      deviceUUID: "d1",
      op: "del",
    });
  });
});

describe("updateGuestKeyTag", () => {
  it("{deviceUUID,guestKeyId,keyName} を spread op:'updateGuestTag'", async () => {
    const c = mockClient({ success: true });
    await org.updateGuestKeyTag(c, { data: { deviceUUID: "d1", guestKeyId: "g1", keyName: "新タグ" } });
    expect(c.sent[0]).toEqual({
      action: "biz3ManageEmployeeDevice",
      deviceUUID: "d1",
      guestKeyId: "g1",
      keyName: "新タグ",
      op: "updateGuestTag",
    });
  });
});

describe("generateGuestQR", () => {
  it("deviceKey 全体を spread op:'generateGuestQR'、応答 data(guestKeyId) を返す", async () => {
    const c = mockClient({ success: true, data: "GUEST_KEY_ID_123" });
    const data = { deviceUUID: "d1", secretKey: "s1", sesame2PublicKey: "pk", keyIndex: "00", deviceModel: "sesame_5" };
    const r = await org.generateGuestQR(c, { data });
    expect(c.sent[0]).toEqual({ action: "biz3ManageEmployeeDevice", ...data, op: "generateGuestQR" });
    expect(r).toBe("GUEST_KEY_ID_123");
  });
  it("success:false は throw", async () => {
    const c = mockClient({ success: false, message: "denied" });
    await expect(org.generateGuestQR(c, { data: { deviceUUID: "d1" } })).rejects.toThrow(/generateGuestQR failed: denied/);
  });
});

// ════════════════════════════ getDeviceEmployeeKeys ════════════════════════════

describe("getDeviceEmployeeKeys", () => {
  it("deviceUUID/companyID/limit 直置き op:'get'、応答 data 配列", async () => {
    const c = mockClient({ success: true, data: [{ subUUID: "u1", keyLevel: 2, guestKeyId: "g1" }] });
    const r = await org.getDeviceEmployeeKeys(c, { deviceUUID: "d1", companyID: "ch_X", limit: 5 });
    expect(c.sent[0]).toEqual({
      action: "biz3GetDeviceEmployeeKeys",
      deviceUUID: "d1",
      companyID: "ch_X",
      limit: 5,
      op: "get",
    });
    expect(r).toEqual([{ subUUID: "u1", keyLevel: 2, guestKeyId: "g1" }]);
  });
  it("limit 省略時は 0 (全件)", async () => {
    const c = mockClient({ success: true, data: [] });
    await org.getDeviceEmployeeKeys(c, { deviceUUID: "d1", companyID: "ch_X" });
    expect(c.sent[0].limit).toBe(0);
  });
  it("deviceUUID 必須", async () => {
    const c = mockClient({});
    await expect(org.getDeviceEmployeeKeys(c, { companyID: "ch_X" })).rejects.toThrow(/deviceUUID required/);
  });
  it("companyID 必須", async () => {
    const c = mockClient({});
    await expect(org.getDeviceEmployeeKeys(c, { deviceUUID: "d1" })).rejects.toThrow(/companyID required/);
  });
});
