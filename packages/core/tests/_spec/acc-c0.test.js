// spec/access.md ACC-0001 〜 ACC-0018 の TDD テスト (統合版)
// 実装: packages/core/src/access.js
// 参照: references_web/src/api/useManageAuthData.js
// 実行可能・self-contained・決定論的 (ネットワーク/実機不使用)
import { describe, it, expect, vi } from "vitest";
import {
  getCards,
  getPasscodes,
  postCards,
  postPasscodes,
  delCards,
  delPasscodes,
  clearCards,
  clearPasscodes,
  updateCardName,
} from "../../src/access.js";
import { mockClient, chunkMockClient } from "../helpers/mock-ws.js";

// ---------- WS action 定数 ----------
// biz3 messageConstants.js:9  BIZ3_MANAGE_AC_AUTHDATA = 'biz3ManageAccessCtlAuthData'
const ACTION = "biz3ManageAccessCtlAuthData";

// ---------- クライアントファクトリ ----------

/** getCards/getPasscodes (subscribe+send) 用: request 誤用を throw で検知 */
function pushClient() {
  return chunkMockClient({ strictPushOnly: true });
}

/** postCards/postPasscodes/clearCards/clearPasscodes/updateCardName (request) 用: send 誤用を throw で検知 */
function requestClient(reply) {
  return mockClient(reply, { strictRequestOnly: true });
}

/** delCards/delPasscodes (fire-and-forget send) 用 */
function sendClient() {
  return chunkMockClient({ strictPushOnly: true });
}

// ---------- ACC-0001〜0006: getCards ----------

describe("ACC-0001〜0006: getCards (WS フレーム・集約・タイムアウト)", () => {
  // ACC-0001: 送信フレームの action / op / obj.devices (カンマ連結文字列)
  // ref: access.js:318-322; useManageAuthData.js:54-62; messageConstants.js:9
  it("[ACC-0001] getCards 送信フレーム = {action:'biz3ManageAccessCtlAuthData', obj:{devices:'uuid1,uuid2'}, op:'getCards'}", async () => {
    const c = pushClient();
    const p = getCards(c, { deviceUUIDs: ["uuid1", "uuid2"] });

    // 送信直後にフレームを検証 (Promise を await する前)
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: ACTION,
      obj: { devices: "uuid1,uuid2" },
      op: "getCards",
    });
    // obj.devices は文字列 (配列ではない)
    expect(typeof c.sent[0].obj.devices).toBe("string");
    expect(c.sent[0].obj.devices).toBe("uuid1,uuid2");

    // 完了通知で Promise を確定させる
    c.push(`${ACTION}:getCards`, { action: ACTION, op: "getCards" });
    await p;
  });

  // ACC-0002: op='pubCardLinkedIDs' の data{deviceUUID,page,list} を
  //   page===1 で置換・それ以外で累積する (biz3 handleDeviceCardData:126 と一致)
  // ref: access.js:332-342; useManageAuthData.js:116-131
  it("[ACC-0002] getCards: pubCardLinkedIDs push を page で集約 (page===1 置換 / 他累積)", async () => {
    const c = pushClient();
    const p = getCards(c, { deviceUUIDs: ["dev1"] });

    // page 1: 置換
    c.push(`${ACTION}:pubCardLinkedIDs`, {
      action: ACTION,
      op: "pubCardLinkedIDs",
      data: { deviceUUID: "dev1", page: 1, list: [{ cardID: "OLD" }] },
    });
    // page 1 再来: 置換 (累積ではない)
    c.push(`${ACTION}:pubCardLinkedIDs`, {
      action: ACTION,
      op: "pubCardLinkedIDs",
      data: { deviceUUID: "dev1", page: 1, list: [{ cardID: "C1" }] },
    });
    // page 2: 累積
    c.push(`${ACTION}:pubCardLinkedIDs`, {
      action: ACTION,
      op: "pubCardLinkedIDs",
      data: { deviceUUID: "dev1", page: 2, list: [{ cardID: "C2" }] },
    });

    c.push(`${ACTION}:getCards`, { action: ACTION, op: "getCards" });
    const r = await p;

    // page 1 は最後の値で置換 (OLD は消える)、page 2 は累積
    expect(r.byDevice.dev1.map((x) => x.cardID)).toEqual(["C1", "C2"]);
  });

  // ACC-0003: byDevice の list を cardID 単位に集約し uuids(該当 deviceUUID 群)を付与
  // ref: access.js:371-385; useManageAuthData.js:155-174
  it("[ACC-0003] getCards: items 集約 (cardID 単位に uuids 群を付与)", async () => {
    const c = pushClient();
    const p = getCards(c, { deviceUUIDs: ["dev1", "dev2"] });

    // C1 を dev1/dev2 で共有 (横断集約で uuids が 2 件になる)
    c.push(`${ACTION}:pubCardLinkedIDs`, {
      data: { deviceUUID: "dev1", page: 1, list: [{ cardID: "C1", name: "card1" }] },
    });
    c.push(`${ACTION}:pubCardLinkedIDs`, {
      data: { deviceUUID: "dev2", page: 1, list: [{ cardID: "C1", name: "card1" }] },
    });
    // C2 は dev1 のみ
    c.push(`${ACTION}:pubCardLinkedIDs`, {
      data: { deviceUUID: "dev1", page: 2, list: [{ cardID: "C2", name: "card2" }] },
    });

    c.push(`${ACTION}:getCards`, { action: ACTION, op: "getCards" });
    const r = await p;

    // C1 は dev1/dev2 の両方を含む
    const c1Items = r.items.filter((x) => x.cardID === "C1");
    expect(c1Items.length).toBeGreaterThanOrEqual(1);
    // 全 C1 要素の uuids が dev1/dev2 両方を含む
    const allUuids = new Set(c1Items.flatMap((x) => x.uuids));
    expect([...allUuids].sort()).toEqual(["dev1", "dev2"]);

    // C2 の uuids は dev1 のみ
    const c2Items = r.items.filter((x) => x.cardID === "C2");
    expect(c2Items.length).toBeGreaterThanOrEqual(1);
    expect(c2Items[0].uuids).toEqual(["dev1"]);

    // byDevice 構造も検証
    expect(r.byDevice.dev1.map((x) => x.cardID)).toEqual(["C1", "C2"]);
    expect(r.byDevice.dev2.map((x) => x.cardID)).toEqual(["C1"]);
  });

  // ACC-0004: 完了通知 op='getCards'(data無し) で確定、欠落デバイスは graceMs 吸収してから resolve
  // ref: access.js:349-356; useManageAuthData.js:179-185
  it("[ACC-0004] getCards: 完了通知 op='getCards' で確定 / 欠落時 grace window で残 push を吸収", async () => {
    const c = pushClient();
    // graceMs を短く設定して grace window が働くことを検証
    const p = getCards(c, { deviceUUIDs: ["dev1", "dev2"], graceMs: 60 });

    // dev1 のみ push (dev2 は欠落)
    c.push(`${ACTION}:pubCardLinkedIDs`, {
      data: { deviceUUID: "dev1", page: 1, list: [{ cardID: "C1" }] },
    });
    // 完了通知: dev2 欠落のため grace timer が起動する
    c.push(`${ACTION}:getCards`, { action: ACTION, op: "getCards" });
    // grace window 内に dev2 が届く
    c.push(`${ACTION}:pubCardLinkedIDs`, {
      data: { deviceUUID: "dev2", page: 1, list: [{ cardID: "C2" }] },
    });

    const r = await p;
    // grace window 内で dev2 の push を吸収して resolve
    expect(r.byDevice.dev1).toHaveLength(1);
    expect(r.byDevice.dev2).toHaveLength(1);
    expect(r.byDevice.dev1[0].cardID).toBe("C1");
    expect(r.byDevice.dev2[0].cardID).toBe("C2");
  });

  // ACC-0005: deviceUUIDs 空なら送信せず {byDevice:{},items:[]} を返す
  // ref: access.js:299-301; useManageAuthData.js:51-53
  it("[ACC-0005] getCards: deviceUUIDs 空なら送信せず空集合を返す", async () => {
    // 空配列
    const c1 = pushClient();
    const r1 = await getCards(c1, { deviceUUIDs: [] });
    expect(c1.sent).toHaveLength(0);
    expect(r1).toEqual({ byDevice: {}, items: [] });

    // partialOnTimeout=true でも送信しない
    const c2 = pushClient();
    const r2 = await getCards(c2, { deviceUUIDs: [], partialOnTimeout: true });
    expect(c2.sent).toHaveLength(0);
    expect(r2).toEqual({ partial: false, byDevice: {}, items: [] });

    // 非配列も同様
    const c3 = pushClient();
    // @ts-ignore
    const r3 = await getCards(c3, { deviceUUIDs: null });
    expect(c3.sent).toHaveLength(0);
    expect(r3).toEqual({ byDevice: {}, items: [] });
  });

  // ACC-0006: timeout 時 reject / partialOnTimeout=true 時は部分結果 resolve
  // ref: access.js:322-328; util.js:147-154; access.js:402-411
  it("[ACC-0006] getCards: timeout 時 reject (既定)", async () => {
    const c = pushClient();
    await expect(
      getCards(c, { deviceUUIDs: ["dev1"], timeoutMs: 20 }),
    ).rejects.toThrow(/getCards timeout|timeout/i);
  });

  it("[ACC-0006] getCards: partialOnTimeout=true なら部分結果 {partial:true,byDevice,items} で resolve", async () => {
    vi.useFakeTimers();
    const c = pushClient();
    const p = getCards(c, {
      deviceUUIDs: ["dev1", "dev2"],
      timeoutMs: 500,
      partialOnTimeout: true,
    });

    // dev1 の push だけ届き、dev2 と完了通知が来ないまま timeout
    c.push(`${ACTION}:pubCardLinkedIDs`, {
      data: { deviceUUID: "dev1", page: 1, list: [{ cardID: "C1" }] },
    });
    vi.advanceTimersByTime(500);
    const r = await p;
    vi.useRealTimers();

    expect(r.partial).toBe(true);
    expect(r.byDevice.dev1.map((x) => x.cardID)).toEqual(["C1"]);
    expect(r.byDevice.dev2).toBeUndefined();
    expect(r.items.map((x) => x.cardID)).toContain("C1");
  });
});

// ---------- ACC-0007: getPasscodes ----------

describe("ACC-0007: getPasscodes (op/pubOp/idKey)", () => {
  // ACC-0007: getPasscodes が getCards と同型で op='getPasscodes'/pubOp='pubPasscodeLinkedIDs'/集約キー='passwordID'
  // ref: access.js:428-438; useManageAuthData.js:134-153; useManageAuthData.js:189-191
  it("[ACC-0007] getPasscodes 送信フレーム = op:'getPasscodes', pub op='pubPasscodeLinkedIDs', idKey='passwordID'", async () => {
    const c = pushClient();
    const p = getPasscodes(c, { deviceUUIDs: ["dev1"] });

    // 送信フレーム検証
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: ACTION,
      obj: { devices: "dev1" },
      op: "getPasscodes",
    });

    // pubPasscodeLinkedIDs で passwordID を集約
    c.push(`${ACTION}:pubPasscodeLinkedIDs`, {
      data: {
        deviceUUID: "dev1",
        page: 1,
        list: [
          { passwordID: "P1", keyBoardPassCode: "0102", name: "pin1" },
          { passwordID: "P2", keyBoardPassCode: "0304", name: "pin2" },
        ],
      },
    });
    // 完了通知は op='getPasscodes'
    c.push(`${ACTION}:getPasscodes`, { action: ACTION, op: "getPasscodes" });
    const r = await p;

    expect(r.byDevice.dev1).toHaveLength(2);
    // passwordID 単位に集約 (uuids 付与)
    expect(r.items[0].passwordID).toBe("P1");
    expect(r.items[0].uuids).toEqual(["dev1"]);
    expect(r.items[1].passwordID).toBe("P2");

    // items の集約キーは passwordID (cardID ではない)
    expect(r.items.every((x) => "passwordID" in x)).toBe(true);
  });
});

// ---------- ACC-0008〜0009: postCards ----------

describe("ACC-0008〜0009: postCards", () => {
  // ACC-0008: obj でラップせず deviceUUID と list をトップレベルに置く非対称フレーム
  // ref: access.js:473-476; useManageAuthData.js:379-394
  it("[ACC-0008] postCards 送信フレーム = {action, deviceUUID, list, op:'postCards'} (obj ラップ無し)", async () => {
    const c = requestClient({ success: true });
    const list = [{ cardID: "C1", nameUUID: "n1", name: "card1", cardType: 1 }];
    await postCards(c, { deviceUUID: "dev1", list });

    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: ACTION,
      deviceUUID: "dev1",
      list,
      op: "postCards",
    });
    // obj ラップがない
    expect(c.sent[0]).not.toHaveProperty("obj");
    // deviceUUID がトップレベル
    expect(c.sent[0].deviceUUID).toBe("dev1");
    // list がトップレベル
    expect(Array.isArray(c.sent[0].list)).toBe(true);
  });

  // ACC-0009: list が非配列 or length<1 なら WS を送らず null を返す
  // ref: access.js:474; useManageAuthData.js:381-383
  it("[ACC-0009] postCards: list 空(<1)なら送信せず null を返す", async () => {
    // 空配列
    const c1 = requestClient({ success: true });
    const r1 = await postCards(c1, { deviceUUID: "dev1", list: [] });
    expect(r1).toBeNull();
    expect(c1.sent).toHaveLength(0);

    // 非配列 (null)
    const c2 = requestClient({ success: true });
    // @ts-ignore
    const r2 = await postCards(c2, { deviceUUID: "dev1", list: null });
    expect(r2).toBeNull();
    expect(c2.sent).toHaveLength(0);

    // 非配列 (文字列)
    const c3 = requestClient({ success: true });
    // @ts-ignore
    const r3 = await postCards(c3, { deviceUUID: "dev1", list: "not-an-array" });
    expect(r3).toBeNull();
    expect(c3.sent).toHaveLength(0);
  });
});

// ---------- ACC-0010〜0011: postPasscodes ----------

describe("ACC-0010〜0011: postPasscodes", () => {
  // ACC-0010: postPasscodes が postCards と同型(obj ラップ無し・トップレベル deviceUUID/list)
  //   で op='postPasscodes' を送り list 空なら null を返す
  // ref: access.js:490-493; useManageAuthData.js:396-411
  it("[ACC-0010] postPasscodes 送信フレーム = {action, deviceUUID, list, op:'postPasscodes'} (obj ラップ無し) / list 空なら null", async () => {
    // 通常送信
    const c = requestClient({ success: true });
    const list = [{ passwordID: "P1", name: "pin1", nameUUID: "11111111-1111-4111-8111-111111111111" }];
    await postPasscodes(c, { deviceUUID: "dev1", list });

    expect(c.sent[0]).toEqual({
      action: ACTION,
      deviceUUID: "dev1",
      list,
      op: "postPasscodes",
    });
    // obj ラップがない
    expect(c.sent[0]).not.toHaveProperty("obj");

    // list 空は null
    const c2 = requestClient({ success: true });
    const r2 = await postPasscodes(c2, { deviceUUID: "dev1", list: [] });
    expect(r2).toBeNull();
    expect(c2.sent).toHaveLength(0);

    // 非配列も null
    const c3 = requestClient({ success: true });
    // @ts-ignore
    const r3 = await postPasscodes(c3, { deviceUUID: "dev1", list: null });
    expect(r3).toBeNull();
    expect(c3.sent).toHaveLength(0);
  });

  // ACC-0011: postPasscodes の list 要素は {passwordID, name, nameUUID} に
  //   insertUUIDIsolationCharacter 整形が適用された形 (biz3 passwords.js:103-108 と一致)
  // ref: access.js:486-487; passwords.js:103-108; biz3utils.js:236-238
  it("[ACC-0011] postPasscodes list 要素 = {passwordID,name,nameUUID}(insertUUIDIsolationCharacter 整形)", async () => {
    const c = requestClient({ success: true });
    // passwords.js:103-108 の serverList は {...item, nameUUID:insertUUIDIsolationCharacter(...)} 形
    // insertUUIDIsolationCharacter は ハイフン区切り小文字 UUID 形式
    const formattedNameUUID = "12345678-1234-4234-8234-123456789abc";
    const list = [
      {
        passwordID: "P1",
        name: "pin1",
        nameUUID: formattedNameUUID,
      },
    ];
    await postPasscodes(c, { deviceUUID: "dev1", list });

    const sentList = c.sent[0].list;
    expect(sentList).toHaveLength(1);

    // list 要素は {passwordID, name, nameUUID} を含む
    expect(sentList[0].passwordID).toBe("P1");
    expect(sentList[0].name).toBe("pin1");
    expect(sentList[0].nameUUID).toBe(formattedNameUUID);

    // postPasscodes はリスト要素を透過するため、渡されていないフィールドは送られない
    expect(sentList[0]).not.toHaveProperty("keyBoardPassCode");
    expect(sentList[0]).not.toHaveProperty("keyBoardPassCodeNameUUID");
    expect(sentList[0]).not.toHaveProperty("type");
  });
});

// ---------- ACC-0012〜0013: delCards ----------

describe("ACC-0012〜0013: delCards", () => {
  // ACC-0012: fire-and-forget send {action, items, op:'delCards'} (deviceID/cardID)
  //   biz3 は応答ハンドラが空 → request ではなく send
  // ref: access.js:514-518; useManageAuthData.js:355-365; useManageAuthData.js:265-267
  it("[ACC-0012] delCards: fire-and-forget send {action, items, op:'delCards'} (deviceID/cardID)", () => {
    const c = sendClient();
    const items = [{ deviceID: "dev1", cardID: "C1" }];
    const result = delCards(c, { items });

    // fire-and-forget: send のみ (request は呼ばない)
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: ACTION,
      items,
      op: "delCards",
    });
    // items がトップレベル (obj ラップなし)
    expect(c.sent[0]).not.toHaveProperty("obj");
    expect(c.sent[0]).not.toHaveProperty("deviceUUID");
    // items 要素は {deviceID, cardID} (deviceUUID ではなく deviceID)
    expect(c.sent[0].items[0]).toHaveProperty("deviceID");
    expect(c.sent[0].items[0]).toHaveProperty("cardID");
    expect(c.sent[0].items[0]).not.toHaveProperty("deviceUUID");

    // 送信した場合は true
    expect(result).toBe(true);
  });

  // ACC-0013: items が非配列 or 空なら send せず false / 非空なら send して true
  // ref: access.js:515-517; useManageAuthData.js:356-358
  it("[ACC-0013] delCards: items 空なら送信せず false / 非空で true", () => {
    // 空配列 → false
    const c1 = sendClient();
    expect(delCards(c1, { items: [] })).toBe(false);
    expect(c1.sent).toHaveLength(0);

    // 非配列 (null) → false
    const c2 = sendClient();
    // @ts-ignore
    expect(delCards(c2, { items: null })).toBe(false);
    expect(c2.sent).toHaveLength(0);

    // 非配列 (undefined) → false
    const c3 = sendClient();
    // @ts-ignore
    expect(delCards(c3, { items: undefined })).toBe(false);
    expect(c3.sent).toHaveLength(0);

    // 非空 → true、send 実行
    const c4 = sendClient();
    expect(delCards(c4, { items: [{ deviceID: "dev1", cardID: "C1" }] })).toBe(true);
    expect(c4.sent).toHaveLength(1);
  });
});

// ---------- ACC-0014: delPasscodes ----------

describe("ACC-0014: delPasscodes", () => {
  // ACC-0014: delPasscodes が delCards と同型の fire-and-forget(send) で op='delPasscodes'
  //   items 要素 {deviceID, passwordID}・items 空で false を返す
  // ref: access.js:534-538; useManageAuthData.js:367-377; useManageAuthData.js:272-273
  it("[ACC-0014] delPasscodes: fire-and-forget send {action, items, op:'delPasscodes'} (deviceID/passwordID) / items 空なら false", () => {
    // 通常送信
    const c = sendClient();
    const items = [{ deviceID: "dev1", passwordID: "P1" }];
    const result = delPasscodes(c, { items });

    expect(result).toBe(true);
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: ACTION,
      items,
      op: "delPasscodes",
    });
    // items 要素は {deviceID, passwordID} (cardID ではない)
    expect(c.sent[0].items[0]).toHaveProperty("deviceID");
    expect(c.sent[0].items[0]).toHaveProperty("passwordID");
    expect(c.sent[0].items[0]).not.toHaveProperty("cardID");
    // obj ラップなし
    expect(c.sent[0]).not.toHaveProperty("obj");

    // items 空 → false
    const c2 = sendClient();
    expect(delPasscodes(c2, { items: [] })).toBe(false);
    expect(c2.sent).toHaveLength(0);

    // 非配列 → false
    const c3 = sendClient();
    // @ts-ignore
    expect(delPasscodes(c3, { items: null })).toBe(false);
    expect(c3.sent).toHaveLength(0);
  });
});

// ---------- ACC-0015〜0016: clearCards ----------

describe("ACC-0015〜0016: clearCards", () => {
  // ACC-0015: clearCards の obj.devices は単一 deviceUUID 文字列 (getCards のカンマ連結ではない)
  // ref: access.js:552-555; useManageAuthData.js:295-311; useManageAuthData.js:54
  it("[ACC-0015] clearCards 送信フレーム = {action, obj:{devices:<単一uuid文字列>}, op:'clearCards'}", async () => {
    const c = requestClient({ success: true });
    await clearCards(c, { deviceUUID: "dev1" });

    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: ACTION,
      obj: { devices: "dev1" },
      op: "clearCards",
    });
    // obj.devices は単一文字列 (カンマ連結でない)
    expect(typeof c.sent[0].obj.devices).toBe("string");
    expect(c.sent[0].obj.devices).toBe("dev1");
    // カンマを含まない (getCards の複数デバイス連結形ではない)
    expect(c.sent[0].obj.devices).not.toContain(",");
  });

  // ACC-0016: !deviceUUID なら WS を送らず null を返す
  // ref: access.js:553; useManageAuthData.js:297-299
  it("[ACC-0016] clearCards: deviceUUID 無しなら送信せず null", async () => {
    // 空文字
    const c1 = requestClient({ success: true });
    const r1 = await clearCards(c1, { deviceUUID: "" });
    expect(r1).toBeNull();
    expect(c1.sent).toHaveLength(0);

    // undefined
    const c2 = requestClient({ success: true });
    // @ts-ignore
    const r2 = await clearCards(c2, { deviceUUID: undefined });
    expect(r2).toBeNull();
    expect(c2.sent).toHaveLength(0);

    // null
    const c3 = requestClient({ success: true });
    // @ts-ignore
    const r3 = await clearCards(c3, { deviceUUID: null });
    expect(r3).toBeNull();
    expect(c3.sent).toHaveLength(0);
  });
});

// ---------- ACC-0017: clearPasscodes ----------

describe("ACC-0017: clearPasscodes", () => {
  // ACC-0017: clearPasscodes が clearCards と同型(単一 deviceUUID 文字列の obj.devices)で
  //   op='clearPasscodes' を送る。biz3 関数名 clearPasswords だが op は clearPasscodes
  // ref: access.js:568-571; useManageAuthData.js:313-329
  it("[ACC-0017] clearPasscodes 送信フレーム = {action, obj:{devices:<単一uuid>}, op:'clearPasscodes'} / deviceUUID 欠落で null", async () => {
    // 通常送信
    const c = requestClient({ success: true });
    await clearPasscodes(c, { deviceUUID: "dev1" });

    expect(c.sent[0]).toEqual({
      action: ACTION,
      obj: { devices: "dev1" },
      op: "clearPasscodes",
    });
    // op は 'clearPasscodes' (biz3 関数名 clearPasswords だが op 文字列はこちら)
    expect(c.sent[0].op).toBe("clearPasscodes");
    // obj.devices は単一文字列
    expect(typeof c.sent[0].obj.devices).toBe("string");
    expect(c.sent[0].obj.devices).toBe("dev1");

    // deviceUUID 欠落 → null
    const c2 = requestClient({ success: true });
    const r2 = await clearPasscodes(c2, { deviceUUID: "" });
    expect(r2).toBeNull();
    expect(c2.sent).toHaveLength(0);
  });
});

// ---------- ACC-0018: updateCardName ----------

describe("ACC-0018: updateCardName", () => {
  // ACC-0018: updateCardName は item を obj に展開して送る (biz3 handlePutCardName)
  //   item は {cardID,name,cardNameUUID,timestamp,cardType,stpDeviceUUID}
  // ref: access.js:594-596; useManageAuthData.js:331-344; cards.js:221-231
  it("[ACC-0018] updateCardName 送信フレーム = {action, obj:{...item}, op:'updateCardName'}", async () => {
    const c = requestClient({ success: true, reqContext: {} });
    const item = {
      cardID: "C1",
      name: "テストカード",
      cardNameUUID: "11111111-1111-4111-8111-111111111111",
      timestamp: 1700000000000,
      cardType: 1,
      stpDeviceUUID: "dev1",
    };
    await updateCardName(c, { item });

    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]).toEqual({
      action: ACTION,
      obj: { ...item },
      op: "updateCardName",
    });
    // item の全フィールドが obj に展開されている (biz3 handlePutCardName obj:{...item})
    expect(c.sent[0].obj.cardID).toBe("C1");
    expect(c.sent[0].obj.name).toBe("テストカード");
    expect(c.sent[0].obj.cardNameUUID).toBe("11111111-1111-4111-8111-111111111111");
    expect(c.sent[0].obj.timestamp).toBe(1700000000000);
    expect(c.sent[0].obj.cardType).toBe(1);
    expect(c.sent[0].obj.stpDeviceUUID).toBe("dev1");
    // item はトップレベルに展開されず obj 内に収まる
    expect(c.sent[0]).not.toHaveProperty("cardID");
    expect(c.sent[0]).not.toHaveProperty("name");
  });

  it("[ACC-0018] updateCardName: 追加フィールドを持つ item も全透過 (cards.js:221-231 の 6〜7 フィールド形)", async () => {
    // cards.js:221-231 の呼び出しは ownerSubUUID も含む 7 フィールドを渡す。
    // updateCardName は obj:{...item} で透過するため追加フィールドも送られる。
    const c = requestClient({ success: true, reqContext: {} });
    const item = {
      cardID: "C2",
      name: "Alice",
      cardNameUUID: "22222222-2222-4222-8222-222222222222",
      timestamp: 1700000000001,
      cardType: 2,
      stpDeviceUUID: "dev2",
      ownerSubUUID: "sub-alice",
    };
    await updateCardName(c, { item });

    // 全フィールドが obj に展開されている
    expect(c.sent[0].obj).toEqual({ ...item });
    expect(c.sent[0].obj.ownerSubUUID).toBe("sub-alice");
    expect(c.sent[0].op).toBe("updateCardName");
    expect(c.sent[0].action).toBe(ACTION);
  });
});
