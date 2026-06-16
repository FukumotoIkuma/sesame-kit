// org-c0.test.js — ORG-0001 〜 ORG-0018 統合 TDD spec テスト
//
// 対象: packages/core/src/org.js の getEmployees / getCurrentUserInfo /
//        addEmployees / updateEmployee / removeEmployees
//        および packages/kit/src/cli/org.js の CLI パス
//
// 統合方針:
//   - A/B 両実装を比較し、各 spec につきより正しく移植元忠実な方を採用。
//   - import は packages/core/tests 内の相対パスに統一 (既存 _spec テストの慣習)。
//   - i18n は ja 固定 (setup.i18n.js と同じ契約)。
//   - ネットワーク・実機に触れない。全て mock または純関数。
//
// TDD 方針: 実装が spec と食い違う箇所は正しい期待値 (spec どおり) を assert する (red でよい)。

import { describe, it, expect, vi, afterEach } from "vitest";
import * as org from "../../src/org.js";
import { NAMESPACE_OPS } from "../../src/org.js";
import { ACTION_TYPES } from "../../src/vendor/biz3/constants/messageConstants.js";
import { SesameError, ERR } from "../../src/errors.js";
import { mockClient, chunkMockClient } from "../helpers/mock-ws.js";

// action 定数 (vendor から引く — 手書きしない)
const ACT_EMPLOYEE = ACTION_TYPES.BIZ3_MANAGE_EMPLOYEE; // "biz3ManageEmployee"

// ─── errorAction 経路テスト用 onMessage 拡張ヘルパー ───────────────────────────
// subscribeChunks の errorAction 経路は client.onMessage が必要。
// chunkMockClient を包んで onMessage / raw を追加する。
function withOnMessage(base) {
  const listeners = new Set();
  return {
    ...base,
    onMessage(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** テスト用: 登録済み onMessage リスナー全員に raw フレームを配信 */
    raw(msg) {
      for (const fn of [...listeners]) fn(msg);
    },
    listeners,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ORG-0001  getEmployees 送信フレーム
// ═══════════════════════════════════════════════════════════════════════════════
describe("[ORG-0001] getEmployees wire frame", () => {
  it("[ORG-0001] 送信フレームのキー集合と値が {action:biz3ManageEmployee, companyID, op:'get'} で companyID はトップレベル直置き", async () => {
    const c = chunkMockClient();
    const p = org.getEmployees(c, { companyID: "cmp-001" });

    // フレームが即時 send される
    expect(c.sent).toHaveLength(1);
    const frame = c.sent[0];

    // action は vendor 定数から解決された値であること
    expect(frame.action).toBe(ACT_EMPLOYEE);
    expect(frame.action).toBe("biz3ManageEmployee");

    // companyID はトップレベル直置き
    expect(frame.companyID).toBe("cmp-001");

    // op
    expect(frame.op).toBe("get");

    // items/obj ラップがないこと
    expect(frame).not.toHaveProperty("items");
    expect(frame).not.toHaveProperty("obj");

    // キー集合: action, companyID, op のみ
    expect(Object.keys(frame).sort()).toEqual(["action", "companyID", "op"].sort());

    // Promise を解決してクリーンアップ
    c.push(`${ACT_EMPLOYEE}:pubEmployees`, {
      data: { totalCount: 0, data: { list: [], page: 1 } },
    });
    await p;
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ORG-0002  getEmployees は pubEmployees push を購読し page chunk を集約する
// ═══════════════════════════════════════════════════════════════════════════════
describe("[ORG-0002] getEmployees pubEmployees 集約規則", () => {
  it("[ORG-0002] 送信 op=get に対し pubEmployees を subscribe し、page===1 全置換・page>1 追記で集約する", async () => {
    const c = chunkMockClient();
    const p = org.getEmployees(c, { companyID: "cmp-002" });

    // 購読が張られていること
    expect(c.sent[0].op).toBe("get");
    expect(c.hasSub(`${ACT_EMPLOYEE}:pubEmployees`)).toBe(true);

    // page 2 が先に届いた後 page 1 が届く (page===1 で全置換)
    c.push(`${ACT_EMPLOYEE}:pubEmployees`, {
      data: { totalCount: 3, data: { list: [{ subUUID: "stale" }], page: 2 } },
    });
    c.push(`${ACT_EMPLOYEE}:pubEmployees`, {
      data: { totalCount: 3, data: { list: [{ subUUID: "a" }, { subUUID: "b" }], page: 1 } },
    });
    // page 1 全置換後、page 2 を追記
    c.push(`${ACT_EMPLOYEE}:pubEmployees`, {
      data: { totalCount: 3, data: { list: [{ subUUID: "c" }], page: 2 } },
    });

    const r = await p;
    // "stale" は page 1 全置換で消え a,b,c が残る
    expect(r.list.map((e) => e.subUUID)).toEqual(["a", "b", "c"]);
    expect(r.count).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ORG-0003  getEmployees 完了判定: acc.length >= totalCount で resolve
// ═══════════════════════════════════════════════════════════════════════════════
describe("[ORG-0003] getEmployees 完了判定", () => {
  it("[ORG-0003] totalCount=0 の単一 push で即完了し {count:0, list:[]} を返す", async () => {
    const c = chunkMockClient();
    const p = org.getEmployees(c, { companyID: "cmp-003a" });

    c.push(`${ACT_EMPLOYEE}:pubEmployees`, {
      data: { totalCount: 0, data: { list: [], page: 1 } },
    });

    const r = await p;
    expect(r).toEqual({ count: 0, list: [] });
  });

  it("[ORG-0003] 蓄積件数 >= totalCount で finish し {count:totalCount, list} を返す", async () => {
    const c = chunkMockClient();
    const p = org.getEmployees(c, { companyID: "cmp-003b" });

    // totalCount=2、1件目
    c.push(`${ACT_EMPLOYEE}:pubEmployees`, {
      data: { totalCount: 2, data: { list: [{ subUUID: "a" }], page: 1 } },
    });
    // 2件目で完了
    c.push(`${ACT_EMPLOYEE}:pubEmployees`, {
      data: { totalCount: 2, data: { list: [{ subUUID: "b" }], page: 2 } },
    });

    const r = await p;
    expect(r.count).toBe(2);
    expect(r.list).toHaveLength(2);
    expect(r.list.map((e) => e.subUUID)).toEqual(["a", "b"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ORG-0004  getEmployees partialOnTimeout=true
// ═══════════════════════════════════════════════════════════════════════════════
describe("[ORG-0004] getEmployees partialOnTimeout オプション", () => {
  afterEach(() => vi.useRealTimers());

  it("[ORG-0004] partialOnTimeout=true 指定時、timeout でも {partial:true, count, list} で resolve する", async () => {
    vi.useFakeTimers();
    const c = chunkMockClient();
    const p = org.getEmployees(c, { companyID: "cmp-004a", timeoutMs: 500, partialOnTimeout: true });

    // totalCount=3 のうち 2 件だけ届いて完了しないまま timeout
    c.push(`${ACT_EMPLOYEE}:pubEmployees`, {
      data: { totalCount: 3, data: { list: [{ subUUID: "a" }, { subUUID: "b" }], page: 1 } },
    });

    vi.advanceTimersByTime(500);

    await expect(p).resolves.toEqual({
      partial: true,
      count: 3,
      list: [{ subUUID: "a" }, { subUUID: "b" }],
    });
  });

  it("[ORG-0004] partialOnTimeout=true で完走時は {partial:false, count, list} の同 shape", async () => {
    const c = chunkMockClient();
    const p = org.getEmployees(c, { companyID: "cmp-004b", partialOnTimeout: true });

    c.push(`${ACT_EMPLOYEE}:pubEmployees`, {
      data: { totalCount: 1, data: { list: [{ subUUID: "z" }], page: 1 } },
    });

    await expect(p).resolves.toEqual({
      partial: false,
      count: 1,
      list: [{ subUUID: "z" }],
    });
  });

  it("[ORG-0004] partialOnTimeout=false (既定) では timeout で reject される", async () => {
    vi.useFakeTimers();
    const c = chunkMockClient();
    const p = org.getEmployees(c, { companyID: "cmp-004c", timeoutMs: 100 });

    // push なし → timeout
    vi.advanceTimersByTime(100);

    await expect(p).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ORG-0005  getEmployees: success:false push rejects; errorAction ignores unrelated op
// ═══════════════════════════════════════════════════════════════════════════════
describe("[ORG-0005] getEmployees error-path (success:false)", () => {
  it("[ORG-0005] push chunk の success===false で SesameError(code=rejected, retryable=false) を throw する", async () => {
    const c = chunkMockClient();
    const p = org.getEmployees(c, { companyID: "cmp-005a" });

    c.push(`${ACT_EMPLOYEE}:pubEmployees`, { success: false, message: "server error" });

    await expect(p).rejects.toMatchObject({
      code: "rejected",
      retryable: false,
    });
  });

  it("[ORG-0005] immediate success:false action-level response (errorAction path) rejects without waiting for timeout", async () => {
    vi.useFakeTimers();
    const c = withOnMessage(chunkMockClient());
    const p = org.getEmployees(c, { companyID: "cmp-005b", timeoutMs: 30000 });

    // 同 op (get) の success:false フレームが action レベルで届く
    c.raw({ action: ACT_EMPLOYEE, op: "get", success: false, message: "immediate error" });

    // タイマー進行なしで reject されるはず
    await expect(p).rejects.toMatchObject({ code: "rejected" });

    vi.useRealTimers();
  });

  it("[ORG-0005] op-相関ガード: 異なる op の success:false は errorAction で無視される (誤 reject しない)", async () => {
    vi.useFakeTimers();
    const c = withOnMessage(chunkMockClient());
    const p = org.getEmployees(c, { companyID: "cmp-005c", timeoutMs: 5000 });

    // 別の op ('delete') の success:false フレーム — 無視されるはず
    c.raw({
      action: ACT_EMPLOYEE,
      op: "delete", // send op は 'get'、異なる op
      success: false,
      message: "other op failed",
    });

    // 正常チャンクを送って正常完了させる
    c.push(`${ACT_EMPLOYEE}:pubEmployees`, {
      data: { totalCount: 0, data: { list: [], page: 1 } },
    });

    await expect(p).resolves.toEqual({ count: 0, list: [] });

    vi.useRealTimers();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ORG-0006  getEmployees: companyID 欠落 → bad_request (no send)
// ═══════════════════════════════════════════════════════════════════════════════
describe("[ORG-0006] getEmployees companyID バリデーション", () => {
  it("[ORG-0006] companyID 未指定で SesameError(code=bad_request, retryable=false) を throw し send しない", async () => {
    const c = mockClient({});
    let err;
    try {
      await org.getEmployees(c, {});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/companyID required/);
    // send されていない
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0006] falsy companyID (空文字) も bad_request を throw する", async () => {
    const c = mockClient({});
    await expect(org.getEmployees(c, { companyID: "" })).rejects.toMatchObject({
      code: "bad_request",
    });
    expect(c.sent).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ORG-0007  getEmployees 露出パリティ (NAMESPACE_OPS / grpc-methods / rpc-params)
// ═══════════════════════════════════════════════════════════════════════════════
describe("[ORG-0007] getEmployees 露出パリティ", () => {
  it("[ORG-0007] NAMESPACE_OPS に 'getEmployees' が含まれる", () => {
    expect(Array.isArray(NAMESPACE_OPS)).toBe(true);
    expect(NAMESPACE_OPS).toContain("getEmployees");
  });

  it("[ORG-0007] NAMESPACE_OPS に 8 つの employee op が全て含まれる", () => {
    const expected8 = [
      "getEmployees",
      "getCurrentUserInfo",
      "addEmployees",
      "updateEmployee",
      "removeEmployees",
      "reorderEmployees",
      "queryByCS",
      "confirmQueryByCS",
    ];
    for (const op of expected8) {
      expect(NAMESPACE_OPS, `NAMESPACE_OPS should contain '${op}'`).toContain(op);
    }
  });

  it("[ORG-0007] grpc-methods.generated.json に OrgGetEmployees が存在する", async () => {
    const grpcMethods = (await import("../../../kit/src/serve/grpc-methods.generated.json", { assert: { type: "json" } })).default;
    expect(grpcMethods).toHaveProperty("OrgGetEmployees");
    expect(grpcMethods["OrgGetEmployees"].method).toBe("org.getEmployees");
  });

  it("[ORG-0007] rpc-params.generated.json に org.getEmployees の param が存在する", async () => {
    const rpcParams = (await import("../../../kit/src/serve/rpc-params.generated.json", { assert: { type: "json" } })).default;
    expect(rpcParams).toHaveProperty("org.getEmployees");
    const params = rpcParams["org.getEmployees"];
    const names = params.map((p) => p.name);
    expect(names).toContain("companyID");
    expect(names).toContain("timeoutMs");
    expect(names).toContain("partialOnTimeout");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ORG-0008  getCurrentUserInfo wire frame
// ═══════════════════════════════════════════════════════════════════════════════
describe("[ORG-0008] getCurrentUserInfo wire frame", () => {
  it("[ORG-0008] フレームが {action:biz3ManageEmployee, op:'currentInfo'} のみで companyID/items/obj を含まない", async () => {
    const c = mockClient({ success: true, data: { nickname: "Taro" } });

    await org.getCurrentUserInfo(c);

    expect(c.sent).toHaveLength(1);
    const frame = c.sent[0];

    expect(frame.action).toBe(ACT_EMPLOYEE);
    expect(frame.op).toBe("currentInfo");

    // companyID/items/obj を一切含まない
    expect(frame).not.toHaveProperty("companyID");
    expect(frame).not.toHaveProperty("items");
    expect(frame).not.toHaveProperty("obj");

    // フレームのキーが action と op のみ
    expect(Object.keys(frame).sort()).toEqual(["action", "op"].sort());
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ORG-0009  getCurrentUserInfo は request (同期応答) で 1 件待ち resp.data を返す
// ═══════════════════════════════════════════════════════════════════════════════
describe("[ORG-0009] getCurrentUserInfo 同期応答", () => {
  it("[ORG-0009] client.request で受信し res.data を返す", async () => {
    const data = { subUUID: "me-001", nickname: "Alice", email: "alice@example.com" };
    const c = mockClient({ success: true, data });

    const r = await org.getCurrentUserInfo(c);

    // 戻り値は resp.data そのもの
    expect(r).toEqual(data);
    // request が 1 回だけ呼ばれた
    expect(c.sent).toHaveLength(1);
  });

  it("[ORG-0009] resp.data が undefined の場合は undefined を返す (resp 全体ではなく data を返す契約)", async () => {
    // data フィールドがない場合は undefined
    const c = mockClient({ success: true }); // data なし
    const r = await org.getCurrentUserInfo(c);
    expect(r).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ORG-0010  getCurrentUserInfo error paths
// ═══════════════════════════════════════════════════════════════════════════════
describe("[ORG-0010] getCurrentUserInfo error-path", () => {
  it("[ORG-0010] success===false なら SesameError(code=rejected, retryable=false) を throw する", async () => {
    const c = mockClient({ success: false, message: "not found" });
    let err;
    try {
      await org.getCurrentUserInfo(c);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.REJECTED);
    expect(err.retryable).toBe(false);
  });

  it("[ORG-0010] 応答無しは transport の timeoutErr (code=TRANSPORT_TIMEOUT) で reject される", async () => {
    vi.useFakeTimers();
    // request が timeoutMs 後にタイムアウトエラーを投げる mock client
    const neverClient = {
      sent: [],
      async request(frame, timeoutMs) {
        this.sent.push(frame);
        return new Promise((_resolve, reject) => {
          setTimeout(() => {
            const e = Object.assign(new Error("request timeout"), { code: "TRANSPORT_TIMEOUT" });
            reject(e);
          }, timeoutMs);
        });
      },
    };

    const p = org.getCurrentUserInfo(neverClient, { timeoutMs: 100 });
    vi.advanceTimersByTime(100);

    await expect(p).rejects.toMatchObject({ code: "TRANSPORT_TIMEOUT" });

    vi.useRealTimers();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ORG-0011  addEmployees wire frame
// ═══════════════════════════════════════════════════════════════════════════════
describe("[ORG-0011] addEmployees wire frame", () => {
  it("[ORG-0011] items をトップレベルに直置きし companyID は各 item 内に含める (トップレベル companyID 無し)", async () => {
    const items = [
      { employeeEmail: "bob@example.com", employeeName: "Bob", tag: ["Admin"], companyID: "cmp-011" },
    ];
    const c = mockClient({ success: true });

    await org.addEmployees(c, { items });

    expect(c.sent).toHaveLength(1);
    const frame = c.sent[0];

    expect(frame.action).toBe(ACT_EMPLOYEE);
    expect(frame.op).toBe("add");

    // items はトップレベル直置き
    expect(frame.items).toEqual(items);

    // トップレベルに companyID がないこと
    expect(frame).not.toHaveProperty("companyID");

    // obj ラップなし
    expect(frame).not.toHaveProperty("obj");

    // companyID は item 内にある
    expect(frame.items[0].companyID).toBe("cmp-011");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ORG-0012  addEmployees: 非配列 items → bad_request
// ═══════════════════════════════════════════════════════════════════════════════
describe("[ORG-0012] addEmployees items バリデーション", () => {
  it("[ORG-0012] Array.isArray(items)===false で SesameError(code=bad_request, retryable=false) を throw し send しない", async () => {
    const c = mockClient({});
    let err;
    try {
      await org.addEmployees(c, { items: {} });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/items must be an array/);
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0012] items が null でも bad_request を throw する", async () => {
    const c = mockClient({});
    await expect(org.addEmployees(c, { items: null })).rejects.toMatchObject({
      code: ERR.BAD_REQUEST,
    });
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0012] items が文字列でも bad_request を throw する", async () => {
    const c = mockClient({});
    await expect(org.addEmployees(c, { items: "[]" })).rejects.toMatchObject({
      code: ERR.BAD_REQUEST,
    });
    expect(c.sent).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ORG-0013  addEmployees: 'Limit Exceeded' 応答 → rejected
// ═══════════════════════════════════════════════════════════════════════════════
describe("[ORG-0013] addEmployees Limit Exceeded エラー", () => {
  it("[ORG-0013] success:false message='Limit Exceeded' で error が throw され message が伝播する", async () => {
    const c = mockClient({ success: false, message: "Limit Exceeded" });

    const err = await org.addEmployees(c, { items: [] }).catch((e) => e);

    expect(err).toBeTruthy();
    expect(err.message).toMatch(/Limit Exceeded/);
  });

  it("[ORG-0013] success:false message='Limit Exceeded' は SesameError(code=rejected, retryable=false) を throw する", async () => {
    const c = mockClient({ success: false, message: "Limit Exceeded" });

    await expect(org.addEmployees(c, { items: [] })).rejects.toMatchObject({
      code: ERR.REJECTED,
      retryable: false,
    });
  });

  it("[ORG-0013] その他 success:false も rejected として throw する", async () => {
    const c = mockClient({ success: false, message: "plan expired" });
    await expect(org.addEmployees(c, { items: [] })).rejects.toMatchObject({
      code: ERR.REJECTED,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ORG-0014  CLI add --friend-qr: parseFriendQrUrl → items=[{friendID, companyID}]
// ═══════════════════════════════════════════════════════════════════════════════
describe("[ORG-0014] CLI add --friend-qr フレンド QR 解析", () => {
  it("[ORG-0014] parseFriendQrUrl で解析し items=[{friendID,companyID}] を合成 (friendID は toLowerCase)", async () => {
    const { parseFriendQrUrl } = await import("../../src/sharekey.js");

    // 有効なフレンド QR URL (biz3utils.js:158: friendID = friendUUID.toLowerCase())
    const friendUUID = "550e8400-e29b-41d4-a716-446655440000";
    const url = `ssm://UI/?t=friend&friend=${friendUUID}`;

    const parsed = parseFriendQrUrl(url);

    // friendID は小文字
    expect(parsed.friendID).toBe(friendUUID.toLowerCase());

    // CLI は items=[{friendID, companyID}] を合成する
    const companyID = "cmp-014";
    const items = [{ friendID: parsed.friendID, companyID }];
    expect(items[0]).toEqual({ friendID: friendUUID.toLowerCase(), companyID });
  });

  it("[ORG-0014] 大文字 UUID も friendID = toLowerCase() で正規化される", async () => {
    const { parseFriendQrUrl } = await import("../../src/sharekey.js");

    const friendUUID = "AABB1122-3344-5566-7788-AABBCCDDEEFF";
    const url = `ssm://UI/?t=friend&friend=${friendUUID}`;

    const parsed = parseFriendQrUrl(url);
    expect(parsed.friendID).toBe(friendUUID.toLowerCase());
  });

  it("[ORG-0014] 無効 URL では parseFriendQrUrl が throw する", async () => {
    const { parseFriendQrUrl } = await import("../../src/sharekey.js");
    expect(() => parseFriendQrUrl("https://not-a-friend-qr.example.com")).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ORG-0015  CLI add: companyID 後置補完 (it.companyID || hub.config.companyID)
// ═══════════════════════════════════════════════════════════════════════════════
describe("[ORG-0015] CLI add companyID 後置補完", () => {
  it("[ORG-0015] companyID なし item は hub.config.companyID で補完される", () => {
    const hubCompanyID = "hub-cmp-015";
    const items = [{ employeeEmail: "x@y.z" }]; // companyID なし
    const withCid = items.map((it) => ({ ...it, companyID: it.companyID || hubCompanyID }));
    expect(withCid[0].companyID).toBe(hubCompanyID);
  });

  it("[ORG-0015] 明示的 companyID がある item は hub 値よりそちらが優先される (truthy 値が勝つ)", () => {
    const hubCompanyID = "hub-cmp-015";
    const itemCompanyID = "item-cmp-015";
    const items = [{ employeeEmail: "x@y.z", companyID: itemCompanyID }];
    const withCid = items.map((it) => ({ ...it, companyID: it.companyID || hubCompanyID }));
    expect(withCid[0].companyID).toBe(itemCompanyID);
  });

  it("[ORG-0015] 空文字 companyID は falsy なので hub 値で上書きされる", () => {
    const hubCompanyID = "hub-cmp-015";
    const items = [{ employeeEmail: "x@y.z", companyID: "" }];
    const withCid = items.map((it) => ({ ...it, companyID: it.companyID || hubCompanyID }));
    expect(withCid[0].companyID).toBe(hubCompanyID);
  });

  it("[ORG-0015] null companyID は falsy なので hub 値で上書きされる", () => {
    const hubCompanyID = "hub-cmp-015";
    const items = [{ employeeEmail: "x@y.z", companyID: null }];
    const withCid = items.map((it) => ({ ...it, companyID: it.companyID || hubCompanyID }));
    expect(withCid[0].companyID).toBe(hubCompanyID);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ORG-0016  updateEmployee wire frame: obj:{companyID,...data} ラップ op:'update'
// ═══════════════════════════════════════════════════════════════════════════════
describe("[ORG-0016] updateEmployee wire frame", () => {
  it("[ORG-0016] update のみ obj:{companyID,...data} でラップ (他 op の直置き/items とは異なる唯一のネスト差異)", async () => {
    const c = mockClient({ success: true });

    await org.updateEmployee(c, {
      companyID: "cmp-016",
      data: { Name: "nickname", Value: "Bob" },
    });

    expect(c.sent).toHaveLength(1);
    const frame = c.sent[0];

    expect(frame.action).toBe(ACT_EMPLOYEE);
    expect(frame.op).toBe("update");

    // obj:{companyID,...data} でラップされていること
    expect(frame).toHaveProperty("obj");
    expect(frame.obj.companyID).toBe("cmp-016");
    expect(frame.obj.Name).toBe("nickname");
    expect(frame.obj.Value).toBe("Bob");

    // トップレベルに companyID がないこと
    expect(frame).not.toHaveProperty("companyID");

    // items がないこと
    expect(frame).not.toHaveProperty("items");
  });

  it("[ORG-0016] {Name, Value} フィールド形式が obj 内で正しく合成される (postEmployeeInfo 契約)", async () => {
    const c = mockClient({ success: true });

    await org.updateEmployee(c, {
      companyID: "cmp-016b",
      data: { Name: "department", Value: "Engineering" },
    });

    const { obj } = c.sent[0];
    expect(obj).toMatchObject({ companyID: "cmp-016b", Name: "department", Value: "Engineering" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ORG-0017  updateEmployee: companyID 欠落 → bad_request (no send)
// ═══════════════════════════════════════════════════════════════════════════════
describe("[ORG-0017] updateEmployee companyID バリデーション", () => {
  it("[ORG-0017] companyID 未指定で SesameError(code=bad_request, retryable=false) を throw し send しない", async () => {
    const c = mockClient({});
    let err;
    try {
      await org.updateEmployee(c, { data: { Name: "nickname", Value: "X" } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/companyID required/);
    // send されていない
    expect(c.sent).toHaveLength(0);
  });

  it("[ORG-0017] 空文字 companyID も bad_request を throw する", async () => {
    const c = mockClient({});
    await expect(org.updateEmployee(c, { companyID: "", data: {} })).rejects.toMatchObject({
      code: ERR.BAD_REQUEST,
      retryable: false,
    });
    expect(c.sent).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  ORG-0018  removeEmployees wire frame: items トップレベル直置き op:'delete'
// ═══════════════════════════════════════════════════════════════════════════════
describe("[ORG-0018] removeEmployees wire frame", () => {
  it("[ORG-0018] items をトップレベル直置きし op:'delete' (トップレベル companyID 無し)", async () => {
    const items = [{ subUUID: "u-001", companyID: "cmp-018" }];
    const c = mockClient({ success: true });

    await org.removeEmployees(c, { items });

    expect(c.sent).toHaveLength(1);
    const frame = c.sent[0];

    expect(frame.action).toBe(ACT_EMPLOYEE);
    expect(frame.op).toBe("delete");

    // items はトップレベル直置き (obj ラップなし)
    expect(frame.items).toEqual(items);

    // トップレベルに companyID がないこと
    expect(frame).not.toHaveProperty("companyID");

    // obj ラップなし
    expect(frame).not.toHaveProperty("obj");
  });

  it("[ORG-0018] items が [{subUUID, companyID}] 形式でも正しく送信され全フィールドが通過する", async () => {
    const items = [
      { subUUID: "u-002", companyID: "cmp-018b", employeeName: "Alice" },
    ];
    const c = mockClient({ success: true });

    await org.removeEmployees(c, { items });

    // 全フィールドが as-is で通過する
    expect(c.sent[0].items[0]).toEqual({ subUUID: "u-002", companyID: "cmp-018b", employeeName: "Alice" });
  });
});
