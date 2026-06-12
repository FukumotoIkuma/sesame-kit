// Unit tests for getRemoteList / searchRemoteList in src/ir.js (P1-12)。
//
// fixture の導出元 (vendor の応答処理):
//   references_web/src/api/useRemoteCtrl.js:43-57 (getRemoteList):
//     const responseData = message.data || {};
//     const list = responseData.data || [];
//     const paginationInfo = responseData.pagination || {};
//     const currentPage = paginationInfo.currentPage || 1;  // page1=置換 / page>1=追記
//   references_web/src/api/useRemoteCtrl.js:59-63 (searchRemoteList):
//     const searchList = searchResponseData.data || [];
// → サーバ応答 message.data は {data:[...], pagination:{...}} の **ラッパー** であり、
//   一覧本体は message.data.data。旧実装の `return resp.data || []` はラッパーをそのまま
//   返していたため、消費側 (CLI for...of / syncRemotesFromServer) が崩壊していた。
//
// 送信 frame の導出元:
//   useRemoteCtrl.js:362-370 (getRemoteList: pagination:{page,pageSize}, 既定 page=1/pageSize=200)
//   useRemoteCtrl.js:404-414 (searchRemoteList: searchTerm + pagination:{page:1,pageSize:1000} 固定)

import { describe, it, expect, vi } from "vitest";
import { getRemoteList, searchRemoteList, matchRemote } from "../../src/ir.js";

const ACTION = "biz3IRRemote";
const COMPANY_ID = "co-A";

/** 1 回の request に固定応答を返す最小 mock client。 */
function makeClient(response) {
  const requests = [];
  return {
    requests,
    request: vi.fn(async (frame, _timeoutMs) => {
      requests.push(frame);
      return response;
    }),
  };
}

/**
 * vendor 応答 fixture (useRemoteCtrl.js:43-57 の読み取り対象と同形)。
 * pagination のフィールド名は loadMoreRemotes (useRemoteCtrl.js:431-441) が読む
 * currentPage / pageSize / hasMore。
 */
function remoteListResponse() {
  return {
    action: ACTION,
    op: "getRemoteList",
    success: true,
    data: {
      data: [
        { uuid: "r-1", type: 0xfe00, alias: "Learned 1" },
        { uuid: "r-2", type: 0xfe00, alias: "Learned 2" },
      ],
      pagination: { currentPage: 1, pageSize: 200, hasMore: true },
    },
  };
}

describe("getRemoteList (P1-12)", () => {
  it("{data:{data:[...], pagination:{...}}} 応答から {list, pagination} を返す", async () => {
    const client = makeClient(remoteListResponse());
    const result = await getRemoteList(client, { type: 0xfe00, companyID: COMPANY_ID });

    expect(result.list).toEqual([
      { uuid: "r-1", type: 0xfe00, alias: "Learned 1" },
      { uuid: "r-2", type: 0xfe00, alias: "Learned 2" },
    ]);
    expect(result.pagination).toEqual({ currentPage: 1, pageSize: 200, hasMore: true });
    // ラッパーをそのまま返さない (旧バグ: result が {data, pagination} オブジェクトだった)
    expect(Array.isArray(result.list)).toBe(true);
    expect(result).not.toHaveProperty("data");
  });

  it("frame は vendor と同形 (pagination:{page,pageSize} / 既定 page=1, pageSize=200)", async () => {
    const client = makeClient(remoteListResponse());
    await getRemoteList(client, { type: 0xc000, companyID: COMPANY_ID });
    expect(client.requests[0]).toEqual({
      action: ACTION,
      op: "getRemoteList",
      type: 0xc000,
      companyID: COMPANY_ID,
      pagination: { page: 1, pageSize: 200 },
    });
  });

  it("page/pageSize 引数が frame の pagination に乗る (loadMoreRemotes 相当: currentPage+1 を渡す)", async () => {
    const client = makeClient(remoteListResponse());
    // vendor loadMoreRemotes (useRemoteCtrl.js:438-439): nextPage = pagination.currentPage + 1
    await getRemoteList(client, { type: 0xc000, companyID: COMPANY_ID, page: 2, pageSize: 50 });
    expect(client.requests[0].pagination).toEqual({ page: 2, pageSize: 50 });
  });

  it("data.data が無い応答は list=[] / pagination=null (vendor の || [] / || {} と同じ防御)", async () => {
    const client = makeClient({ action: ACTION, op: "getRemoteList", success: true, data: {} });
    const result = await getRemoteList(client, { type: 0xfe00, companyID: COMPANY_ID });
    expect(result).toEqual({ list: [], pagination: null });
  });

  it("data 自体が無い応答でも throw せず list=[]", async () => {
    const client = makeClient({ action: ACTION, op: "getRemoteList", success: true });
    const result = await getRemoteList(client, { type: 0xfe00, companyID: COMPANY_ID });
    expect(result).toEqual({ list: [], pagination: null });
  });

  it("success:false は throw (assertSuccess strict)", async () => {
    const client = makeClient({ action: ACTION, op: "getRemoteList", success: false, message: "denied" });
    await expect(getRemoteList(client, { type: 0xfe00, companyID: COMPANY_ID })).rejects.toThrow(/getRemoteList/);
  });
});

describe("searchRemoteList (P1-12)", () => {
  it("{data:{data:[...]}} 応答から {list, pagination} を返す (useRemoteCtrl.js:59-63)", async () => {
    const client = makeClient({
      action: ACTION,
      op: "searchRemoteList",
      success: true,
      data: {
        data: [{ uuid: "p-1", brandName: "ACME", model: "X-100" }],
        pagination: { currentPage: 1, pageSize: 1000, hasMore: false },
      },
    });
    const result = await searchRemoteList(client, { type: 0xc000, companyID: COMPANY_ID, searchTerm: "acme" });
    expect(result.list).toEqual([{ uuid: "p-1", brandName: "ACME", model: "X-100" }]);
    expect(result.pagination).toEqual({ currentPage: 1, pageSize: 1000, hasMore: false });
  });

  it("frame は vendor と同形 (searchTerm + pagination:{page:1,pageSize:1000} 固定)", async () => {
    const client = makeClient({ action: ACTION, op: "searchRemoteList", success: true, data: { data: [] } });
    await searchRemoteList(client, { type: 0xc000, companyID: COMPANY_ID, searchTerm: "acme" });
    expect(client.requests[0]).toEqual({
      action: ACTION,
      op: "searchRemoteList",
      type: 0xc000,
      companyID: COMPANY_ID,
      searchTerm: "acme",
      pagination: { page: 1, pageSize: 1000 },
    });
  });

  it("data.data が無い応答は list=[] / pagination=null", async () => {
    const client = makeClient({ action: ACTION, op: "searchRemoteList", success: true, data: {} });
    const result = await searchRemoteList(client, { type: 0xc000, companyID: COMPANY_ID, searchTerm: "x" });
    expect(result).toEqual({ list: [], pagination: null });
  });

  it("success:false は throw (assertSuccess strict)", async () => {
    const client = makeClient({ action: ACTION, op: "searchRemoteList", success: false, message: "denied" });
    await expect(searchRemoteList(client, { type: 0xc000, companyID: COMPANY_ID, searchTerm: "x" })).rejects.toThrow(/searchRemoteList/);
  });
});

describe("P3-10: matchRemote のワイヤ形 — brandName 未指定時はキー省略 (useRemoteCtrl.js:785-797)", () => {
  // 導出元: useRemoteCtrl.js:785-797 (references_web/src/api/useRemoteCtrl.js)
  // brandName は常に値あり (model パラメータから来る) で送信されており、
  // brandName 未指定時は空文字でなくキー自体を省くことで 1:1 逸脱を解消する。

  const IR_DATA = "deadbeef".repeat(8); // 64 chars, length/2 = 32

  it("brandName あり: フレームに brandName が存在する", async () => {
    const client = makeClient({ action: ACTION, op: "matchRemote", success: true, data: { matches: [{ id: "r-1" }] } });
    const result = await matchRemote(client, { irData: IR_DATA, irType: 1, brandName: "Panasonic", companyID: COMPANY_ID });
    const frame = client.requests[0];
    expect(frame.brandName).toBe("Panasonic");
    expect(result).toEqual([{ id: "r-1" }]);
  });

  it("brandName 未指定: brandName キーがフレームに不在", async () => {
    const client = makeClient({ action: ACTION, op: "matchRemote", success: true, data: { matches: [] } });
    await matchRemote(client, { irData: IR_DATA, irType: 1, companyID: COMPANY_ID });
    const frame = client.requests[0];
    expect("brandName" in frame).toBe(false);
  });

  it("brandName が空文字でも旧実装の空文字キー送出になる (非 undefined → キー存在)", async () => {
    // 呼び出し元が明示的に "" を渡した場合はキーを送る (undefined とは異なる)。
    const client = makeClient({ action: ACTION, op: "matchRemote", success: true, data: {} });
    await matchRemote(client, { irData: IR_DATA, irType: 1, brandName: "", companyID: COMPANY_ID });
    const frame = client.requests[0];
    expect("brandName" in frame).toBe(true);
    expect(frame.brandName).toBe("");
  });

  it("irWaveLength は irData.length / 2", async () => {
    const client = makeClient({ action: ACTION, op: "matchRemote", success: true, data: {} });
    await matchRemote(client, { irData: IR_DATA, irType: 2, companyID: COMPANY_ID });
    expect(client.requests[0].irWaveLength).toBe(IR_DATA.length / 2);
  });
});
