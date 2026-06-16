// packages/core/tests/_spec/org-c6.test.js
//
// TDD spec テスト: ORG-0109 / ORG-0110
// 対象実装: packages/core/src/org.js
//
// ORG-0109: group/deviceGroup 系 9 op が companyID 欠落で badRequest('org.req.companyID') を
//           throw し WS 送信しないこと (send 前ガード)。
// ORG-0110: removeEmployeeGroupBindDeviceGroup が gid 欠落で badRequest('org.req.gid') を
//           throw し WS 送信しないこと (send 前ガード)。
//           実装は companyID ガードのみ持ち gid ガードを欠く可能性があるため TDD (red 許容)。
//
// 参照:
//   packages/core/src/org.js:268, 286, 341, 359, 380, 477, 494, 533, 589 (companyID ガード行)
//   packages/core/src/util.js:54-56 (badRequest 定義)
//   packages/core/src/i18n/org.js  ("org.req.companyID" / "org.req.gid")

import { describe, it, expect } from "vitest";
import * as org from "../../src/org.js";
import { mockClient } from "../helpers/mock-ws.js";

// ════════════════════════════════════════════════════════════════════════════
// [ORG-0109] group/deviceGroup 9 op の companyID 必須検証 (badRequest, send 前)
// assert: 上記 9 op は client.request より前に `if (!companyID) throw badRequest('org.req.companyID')`
//         を実行し WS 送信しないこと。
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0109] group/deviceGroup 9 op の companyID 必須検証 (badRequest, send 前)", () => {
  // addEmployeeGroup — org.js:268
  it("[ORG-0109] addEmployeeGroup: companyID 欠落で badRequest を throw し send しない", async () => {
    const c = mockClient({}, { strictRequestOnly: true });
    await expect(
      org.addEmployeeGroup(c, { companyID: "", item: { name: "G" } }),
    ).rejects.toThrow(/companyID required/);
    expect(c.sent).toHaveLength(0);
  });

  // updateEmployeeGroup — org.js:286
  it("[ORG-0109] updateEmployeeGroup: companyID 欠落で badRequest を throw し send しない", async () => {
    const c = mockClient({}, { strictRequestOnly: true });
    await expect(
      org.updateEmployeeGroup(c, { companyID: "", item: { gid: "g1", name: "G2" } }),
    ).rejects.toThrow(/companyID required/);
    expect(c.sent).toHaveLength(0);
  });

  // addEmployeeInGroup — org.js:341
  it("[ORG-0109] addEmployeeInGroup: companyID 欠落で badRequest を throw し send しない", async () => {
    const c = mockClient({}, { strictRequestOnly: true });
    await expect(
      org.addEmployeeInGroup(c, { companyID: "", gid: "g1", uuids: ["u1"], items: [{ subUUID: "u1" }] }),
    ).rejects.toThrow(/companyID required/);
    expect(c.sent).toHaveLength(0);
  });

  // removeEmployeeInGroup — org.js:359
  it("[ORG-0109] removeEmployeeInGroup: companyID 欠落で badRequest を throw し send しない", async () => {
    const c = mockClient({}, { strictRequestOnly: true });
    await expect(
      org.removeEmployeeInGroup(c, { companyID: "", gid: "g1", uuids: ["u1"], items: [{ subUUID: "u1" }] }),
    ).rejects.toThrow(/companyID required/);
    expect(c.sent).toHaveLength(0);
  });

  // removeEmployeeGroupBindDeviceGroup — org.js:380
  it("[ORG-0109] removeEmployeeGroupBindDeviceGroup: companyID 欠落で badRequest を throw し send しない", async () => {
    const c = mockClient({}, { strictRequestOnly: true });
    await expect(
      org.removeEmployeeGroupBindDeviceGroup(c, { companyID: "", data: { gid: "g1", dgid: "d1" } }),
    ).rejects.toThrow(/companyID required/);
    expect(c.sent).toHaveLength(0);
  });

  // addDeviceGroup — org.js:477
  it("[ORG-0109] addDeviceGroup: companyID 欠落で badRequest を throw し send しない", async () => {
    const c = mockClient({}, { strictRequestOnly: true });
    await expect(
      org.addDeviceGroup(c, { companyID: "", name: "DG" }),
    ).rejects.toThrow(/companyID required/);
    expect(c.sent).toHaveLength(0);
  });

  // updateDeviceGroup — org.js:494
  it("[ORG-0109] updateDeviceGroup: companyID 欠落で badRequest を throw し send しない", async () => {
    const c = mockClient({}, { strictRequestOnly: true });
    await expect(
      org.updateDeviceGroup(c, { companyID: "", item: { gid: "dg1", name: "X" } }),
    ).rejects.toThrow(/companyID required/);
    expect(c.sent).toHaveLength(0);
  });

  // addDeviceInGroup — org.js:533
  it("[ORG-0109] addDeviceInGroup: companyID 欠落で badRequest を throw し send しない", async () => {
    const c = mockClient({}, { strictRequestOnly: true });
    await expect(
      org.addDeviceInGroup(c, { companyID: "", gid: "dg1", uuids: ["d1"], items: [{ deviceUUID: "d1", secretKey: "s1" }] }),
    ).rejects.toThrow(/companyID required/);
    expect(c.sent).toHaveLength(0);
  });

  // removeDeviceGroupBindUserGroup — org.js:589
  it("[ORG-0109] removeDeviceGroupBindUserGroup: companyID 欠落で badRequest を throw し send しない", async () => {
    const c = mockClient({}, { strictRequestOnly: true });
    await expect(
      org.removeDeviceGroupBindUserGroup(c, { companyID: "", data: { gid: "dg1", mid: "m1" } }),
    ).rejects.toThrow(/companyID required/);
    expect(c.sent).toHaveLength(0);
  });

  // null を渡した場合も同様に弾くこと (falsy の境界確認)
  it("[ORG-0109] addEmployeeGroup: companyID=null でも badRequest を throw し send しない", async () => {
    const c = mockClient({}, { strictRequestOnly: true });
    await expect(
      org.addEmployeeGroup(c, { companyID: null, item: { name: "G" } }),
    ).rejects.toThrow(/companyID required/);
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0109] addDeviceGroup: companyID=null でも badRequest を throw し send しない", async () => {
    const c = mockClient({}, { strictRequestOnly: true });
    await expect(
      org.addDeviceGroup(c, { companyID: null, name: "DG" }),
    ).rejects.toThrow(/companyID required/);
    expect(c.sent).toHaveLength(0);
  });

  // companyID が有効なら送信は行われること (ガードが誤って弾かないことの境界確認)
  it("[ORG-0109] addEmployeeGroup: companyID 有効なら throw せず request を呼ぶ", async () => {
    const c = mockClient({ success: true, data: { gid: "g-new" } });
    await expect(
      org.addEmployeeGroup(c, { companyID: "ch_X", item: { name: "G" } }),
    ).resolves.not.toThrow();
    expect(c.sent).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// [ORG-0110] removeEmployeeGroupBindDeviceGroup の gid 必須検証 (badRequest, send 前)
// assert: removeEmployeeGroupBindDeviceGroup は client.request より前に必須 ID (gid) を
//         検証し、欠落時は WS 送信せず badRequest('org.req.gid') を throw すること。
// note: ORG-0042/0061 (各 get*Bind* の gid 必須) と対称の純ローカル付加契約。
//       実装に gid ガードが無い場合は red になる (TDD)。
// ════════════════════════════════════════════════════════════════════════════

describe("[ORG-0110] removeEmployeeGroupBindDeviceGroup: gid 必須検証 (badRequest, send 前)", () => {
  // gid 欠落 (空文字) で throw し send しない
  it("[ORG-0110] gid='' で badRequest を throw し WS 送信しない", async () => {
    const c = mockClient({}, { strictRequestOnly: true });
    await expect(
      org.removeEmployeeGroupBindDeviceGroup(c, { companyID: "ch_X", data: { gid: "", dgid: "d1" } }),
    ).rejects.toThrow(/gid required/);
    expect(c.sent).toHaveLength(0);
  });

  // gid が data オブジェクトに存在しない (undefined) 場合も throw する
  it("[ORG-0110] data に gid キーが無い場合も badRequest を throw し WS 送信しない", async () => {
    const c = mockClient({}, { strictRequestOnly: true });
    await expect(
      org.removeEmployeeGroupBindDeviceGroup(c, { companyID: "ch_X", data: { dgid: "d1" } }),
    ).rejects.toThrow(/gid required/);
    expect(c.sent).toHaveLength(0);
  });

  // gid=null でも同様に throw する (falsy の境界確認)
  it("[ORG-0110] data.gid=null でも badRequest を throw し WS 送信しない", async () => {
    const c = mockClient({}, { strictRequestOnly: true });
    await expect(
      org.removeEmployeeGroupBindDeviceGroup(c, { companyID: "ch_X", data: { gid: null, dgid: "d1" } }),
    ).rejects.toThrow(/gid required/);
    expect(c.sent).toHaveLength(0);
  });

  // gid が有効なら throw せず request を呼ぶこと (ガードが誤って弾かない境界確認)
  it("[ORG-0110] companyID/gid ともに有効なら throw せず request を呼ぶ", async () => {
    const c = mockClient({ success: true });
    await expect(
      org.removeEmployeeGroupBindDeviceGroup(c, { companyID: "ch_X", data: { gid: "g1", dgid: "d1" } }),
    ).resolves.not.toThrow();
    expect(c.sent).toHaveLength(1);
    // gid が spread されてトップレベルに入り、フレームに含まれること
    expect(c.sent[0]).toMatchObject({
      action: "biz3ManageEmployeeGroup",
      cid: "ch_X",
      gid: "g1",
      dgid: "d1",
      op: "removeBindDeviceGroup",
    });
  });
});
