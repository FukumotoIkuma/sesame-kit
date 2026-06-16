// ACC-0040 〜 ACC-0057 統合テスト (writer: merged A+B)
// spec: spec/access.md
// 実装参照:
//   packages/core/src/access.js         (updateAuthenticationName / authenticationNameRequest /
//                                         syncEnrolledCards / syncEnrolledPasscodes /
//                                         enrolledToCardList / enrolledToPasscodeList /
//                                         delCards / delPasscodes / NAMESPACE_OPS)
//   packages/core/src/client.js         (SesameHub3.registerCards / registerPasscodes)
//   packages/kit/src/serve/entries/device.js (deviceEntriesPre / accessAuthEntries)
//   packages/kit/src/serve/registry.js  (buildRegistry)
//   packages/kit/src/serve/registry-helpers.js (requireAuth / need)
//
// 全テストはネットワーク/実機に触れない (純関数 or mock)。

import { describe, it, expect, vi, afterEach } from "vitest";

// ---------- core access 関数 ----------
import {
  syncEnrolledCards,
  syncEnrolledPasscodes,
  updateAuthenticationName,
  enrolledToCardList,
  enrolledToPasscodeList,
  NAMESPACE_OPS,
} from "../../src/access.js";
import * as access from "../../src/access.js";

// ---------- core client ----------
import { SesameHub3 } from "../../src/client.js";

// ---------- jsonrpc (直接パス) ----------
import { RpcError, KIND } from "../../src/jsonrpc.js";

// ---------- serve 層 ----------
import { accessAuthEntries, deviceEntriesPre } from "../../../kit/src/serve/entries/device.js";
import { buildRegistry } from "../../../kit/src/serve/registry.js";
import { need, requireAuth } from "../../../kit/src/serve/registry-helpers.js";

// ---------- mock client helpers ----------
import { mockClient } from "../helpers/mock-ws.js";

// ============================================================
// 共通 fixture
// ============================================================

/** request 系専用 mock client (send/subscribe 誤用を throw で検知) */
function requestClient(reply = { success: true }) {
  return mockClient(reply, { strictRequestOnly: true });
}

/** updateAuthenticationName 用の注入 transport (body をキャプチャして 200 を返す) */
function captureTransport(calls = []) {
  return async (req) => {
    calls.push(req);
    return { status: 200, json: { data: { items: [] } } };
  };
}

/** daemon 最小 stub */
function makeDaemon({ authState = "ok", connected = true } = {}) {
  return { authState, hub: { connected } };
}

/** hub stub (serve エントリのハンドラ呼び出し用) */
function makeHubStub(overrides = {}) {
  return {
    registerCards: vi.fn(async () => ({ ok: true })),
    registerPasscodes: vi.fn(async () => ({ ok: true })),
    postAuthenticationData: vi.fn(async () => ({ items: [] })),
    putAuthenticationData: vi.fn(async () => ({ items: [] })),
    deleteAuthenticationData: vi.fn(async () => ({ items: [] })),
    updateAuthenticationName: vi.fn(async () => ({})),
    ...overrides,
  };
}

// ---------- shared constants ----------
const FW_NAME_UUID_HEX = "368154C128BC4BCDBE62F3B15C7496D0";
const FW_NAME_UUID_DASHED = "368154c1-28bc-4bcd-be62-f3b15c7496d0";

// ============================================================
// [ACC-0040] authenticationNameRequest: timestamp 既定 Date.now()、cardType は cardType??type??0
// ref: packages/core/src/access.js:742,752
// ============================================================
describe("[ACC-0040] authenticationNameRequest: timestamp 既定 Date.now()、cardType fallback", () => {
  // updateAuthenticationName(_client, params) — 第1引数は未使用 (_client = null)
  it("[ACC-0040] timestamp 未指定時は Date.now() 相当の数値が body に載る", async () => {
    const calls = [];
    const before = Date.now();
    await updateAuthenticationName(null, {
      kind: "card",
      cardID: "c1",
      name: "test",
      transport: captureTransport(calls),
    });
    const after = Date.now();
    const ts = calls[0].body.timestamp;
    expect(typeof ts).toBe("number");
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("[ACC-0040] timestamp 指定時はその値をそのまま使う", async () => {
    const calls = [];
    await updateAuthenticationName(null, {
      kind: "card",
      cardID: "c1",
      name: "test",
      timestamp: 12345678,
      transport: captureTransport(calls),
    });
    expect(calls[0].body.timestamp).toBe(12345678);
  });

  it("[ACC-0040] cardType 指定 → cardType を使う", async () => {
    const calls = [];
    await updateAuthenticationName(null, {
      kind: "card",
      cardID: "c1",
      name: "test",
      cardType: 3,
      type: 99,
      transport: captureTransport(calls),
    });
    expect(calls[0].body.cardType).toBe(3);
  });

  it("[ACC-0040] cardType 欠落・type 指定 → type にフォールバック", async () => {
    const calls = [];
    await updateAuthenticationName(null, {
      kind: "card",
      cardID: "c1",
      name: "test",
      type: 2,
      transport: captureTransport(calls),
    });
    expect(calls[0].body.cardType).toBe(2);
  });

  it("[ACC-0040] cardType/type 両欠落 → 0 (既定値)", async () => {
    const calls = [];
    await updateAuthenticationName(null, {
      kind: "card",
      cardID: "c1",
      name: "test",
      transport: captureTransport(calls),
    });
    expect(calls[0].body.cardType).toBe(0);
  });
});

// ============================================================
// [ACC-0041] syncEnrolledCards(records): updateCardName 委譲・cardNameUUID/timestamp/stpDeviceUUID
// ref: packages/core/src/access.js:908-947
// ============================================================
describe("[ACC-0041] syncEnrolledCards(records): updateCardName へ委譲し ack 由来 nameUUID を cardNameUUID に載せる", () => {
  it("[ACC-0041] records 経路は updateCardName (op='updateCardName') を送る", async () => {
    const c = requestClient({ success: true });
    await syncEnrolledCards(c, {
      deviceUUID: "dev1",
      records: [{ cardID: "aa", cardName: "n1", cardType: 1, nameUUID: FW_NAME_UUID_HEX }],
    });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0].op).toBe("updateCardName");
  });

  it("[ACC-0041] cardNameUUID にファームウェア採番 nameUUID (正規化済み) を載せる", async () => {
    const c = requestClient({ success: true });
    await syncEnrolledCards(c, {
      deviceUUID: "dev1",
      records: [{ cardID: "aa", cardName: "n1", cardType: 1, nameUUID: FW_NAME_UUID_HEX }],
    });
    expect(c.sent[0].obj.cardNameUUID).toBe(FW_NAME_UUID_DASHED);
  });

  it("[ACC-0041] stpDeviceUUID=deviceUUID, timestamp は数値", async () => {
    const c = requestClient({ success: true });
    await syncEnrolledCards(c, {
      deviceUUID: "dev-x",
      records: [{ cardID: "aa", cardName: "n1", cardType: 1 }],
    });
    expect(c.sent[0].obj.stpDeviceUUID).toBe("dev-x");
    expect(typeof c.sent[0].obj.timestamp).toBe("number");
  });

  it("[ACC-0041] timestamp = Date.now() 相当 (new Date().getTime())", async () => {
    const before = Date.now();
    const c = requestClient({ success: true });
    await syncEnrolledCards(c, {
      deviceUUID: "dev-aaa",
      records: [{ cardID: "AA01", cardName: "Card1", cardType: 1 }],
    });
    const after = Date.now();
    expect(c.sent[0].obj.timestamp).toBeGreaterThanOrEqual(before);
    expect(c.sent[0].obj.timestamp).toBeLessThanOrEqual(after);
  });

  it("[ACC-0041] 複数 records はそれぞれ updateCardName を送る", async () => {
    const c = requestClient({ success: true });
    await syncEnrolledCards(c, {
      deviceUUID: "dev1",
      records: [
        { cardID: "aa", cardName: "n1", cardType: 1 },
        { cardID: "bb", cardName: "n2", cardType: 0 },
      ],
    });
    expect(c.sent).toHaveLength(2);
    expect(c.sent.map((f) => f.op)).toEqual(["updateCardName", "updateCardName"]);
  });

  it("[ACC-0041] 戻り値は updateCardName 応答の配列", async () => {
    const c = requestClient({ success: true });
    const res = await syncEnrolledCards(c, {
      deviceUUID: "dev1",
      records: [{ cardID: "aa", cardName: "n1", cardType: 1 }],
    });
    expect(Array.isArray(res)).toBe(true);
    expect(res).toHaveLength(1);
  });
});

// ============================================================
// [ACC-0042] syncEnrolledCards(list): postCards 委譲のみ
// ref: packages/core/src/access.js:908-912
// ============================================================
describe("[ACC-0042] syncEnrolledCards(list): postCards へそのまま流す", () => {
  it("[ACC-0042] list を渡すと op='postCards' を送る", async () => {
    const c = requestClient({ success: true });
    const list = [{ cardID: "C1", nameUUID: "u1", name: "x", cardType: 1 }];
    await syncEnrolledCards(c, { deviceUUID: "dev1", list });
    expect(c.sent[0].op).toBe("postCards");
  });

  it("[ACC-0042] list の内容をそのまま postCards に渡す (nameUUID 採番しない)", async () => {
    const c = requestClient({ success: true });
    const list = [{ cardID: "C1", nameUUID: "existing-uuid", name: "x", cardType: 1 }];
    await syncEnrolledCards(c, { deviceUUID: "dev1", list });
    expect(c.sent[0].list).toEqual(list);
  });

  it("[ACC-0042] list 渡し時は deviceUUID がフレームに載る", async () => {
    const c = requestClient({ success: true });
    await syncEnrolledCards(c, {
      deviceUUID: "dev-x",
      list: [{ cardID: "C1", nameUUID: "u1", name: "n", cardType: 0 }],
    });
    expect(c.sent[0].deviceUUID).toBe("dev-x");
  });

  it("[ACC-0042] list が有れば records を無視する", async () => {
    const c = requestClient({ success: true });
    const list = [{ cardID: "C1", nameUUID: "u1", name: "x", cardType: 1 }];
    await syncEnrolledCards(c, {
      deviceUUID: "dev1",
      list,
      records: [{ cardID: "bb", cardName: "n2", cardType: 1 }],
    });
    expect(c.sent[0].op).toBe("postCards");
    expect(c.sent).toHaveLength(1);
  });
});

// ============================================================
// [ACC-0043] syncEnrolledCards: 非v4 nameUUID で stderr 警告、処理は続行
// ref: packages/core/src/access.js:918-933
// ============================================================
describe("[ACC-0043] syncEnrolledCards: 非 v4 nameUUID 検出時 stderr 警告 (処理継続)", () => {
  // version nibble が 0x4x でない hex → v1
  const NON_V4_UUID_HEX = "550e8400e29b11d4a716446655440000"; // version byte = 0x11 (v1)
  // version nibble = 0x4x, variant = 0x8x-0xbx → v4
  const V4_UUID_HEX = "550e8400e29b41d4a716446655440000";

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("[ACC-0043] 非v4 nameUUID のとき stderr に SSM_OS3_CARD_CHANGE を含む警告を書き出す", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const c = requestClient({ success: true });
    await syncEnrolledCards(c, {
      deviceUUID: "dev1",
      records: [{ cardID: "aa", cardName: "n1", cardType: 1, nameUUID: NON_V4_UUID_HEX }],
    });
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("SSM_OS3_CARD_CHANGE"));
  });

  it("[ACC-0043] 警告メッセージに syncEnrolledCards が含まれる", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const c = requestClient({ success: true });
    await syncEnrolledCards(c, {
      deviceUUID: "dev1",
      records: [{ cardID: "aa", cardName: "n1", cardType: 1, nameUUID: NON_V4_UUID_HEX }],
    });
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("syncEnrolledCards"));
  });

  it("[ACC-0043] 非v4 でも updateCardName は呼ばれる (処理継続)", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const c = requestClient({ success: true });
    await syncEnrolledCards(c, {
      deviceUUID: "dev1",
      records: [{ cardID: "aa", cardName: "n1", cardType: 1, nameUUID: NON_V4_UUID_HEX }],
    });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0].op).toBe("updateCardName");
  });

  it("[ACC-0043] v4 nameUUID では SSM_OS3_CARD_CHANGE 警告を出さない", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const c = requestClient({ success: true });
    await syncEnrolledCards(c, {
      deviceUUID: "dev1",
      records: [{ cardID: "aa", cardName: "n1", cardType: 1, nameUUID: V4_UUID_HEX }],
    });
    const warnCalls = stderrSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("SSM_OS3_CARD_CHANGE"),
    );
    expect(warnCalls).toHaveLength(0);
  });
});

// ============================================================
// [ACC-0044] syncEnrolledPasscodes: postPasscodes 委譲のみ (updateCardName 経路なし)
// ref: packages/core/src/access.js:963-966
// ============================================================
describe("[ACC-0044] syncEnrolledPasscodes: postPasscodes 委譲のみ (updateCardName 経路なし)", () => {
  it("[ACC-0044] records 経路でも op='postPasscodes' を送る (updateCardName ではない)", async () => {
    const c = requestClient({ success: true });
    await syncEnrolledPasscodes(c, {
      deviceUUID: "dev1",
      records: [{ cardID: "0102", cardName: "70", cardType: 0, nameUUID: FW_NAME_UUID_HEX }],
    });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0].op).toBe("postPasscodes");
  });

  it("[ACC-0044] updateCardName は送らない", async () => {
    const c = requestClient({ success: true });
    await syncEnrolledPasscodes(c, {
      deviceUUID: "dev1",
      records: [{ cardID: "0102", cardName: "70", cardType: 0, nameUUID: FW_NAME_UUID_HEX }],
    });
    const hasUpdateCardName = c.sent.some((f) => f.op === "updateCardName");
    expect(hasUpdateCardName).toBe(false);
  });

  it("[ACC-0044] records を {passwordID,name,nameUUID} に写像して postPasscodes へ渡す", async () => {
    const c = requestClient({ success: true });
    await syncEnrolledPasscodes(c, {
      deviceUUID: "dev1",
      records: [{ cardID: "0102", cardName: "70", cardType: 0, nameUUID: FW_NAME_UUID_HEX }],
    });
    expect(c.sent[0].list[0]).toEqual({
      passwordID: "0102",
      name: "70",
      nameUUID: FW_NAME_UUID_DASHED,
    });
  });

  it("[ACC-0044] list 経路も postPasscodes 委譲", async () => {
    const c = requestClient({ success: true });
    const list = [{ passwordID: "p1", name: "mypin", nameUUID: FW_NAME_UUID_DASHED }];
    await syncEnrolledPasscodes(c, { deviceUUID: "dev1", list });
    expect(c.sent[0].op).toBe("postPasscodes");
    expect(c.sent[0].list).toEqual(list);
  });

  it("[ACC-0044] keyBoardPassCode/keyBoardPassCodeNameUUID/type は postPasscodes に送らない", async () => {
    const c = requestClient({ success: true });
    await syncEnrolledPasscodes(c, {
      deviceUUID: "dev1",
      records: [{ cardID: "0102", cardName: "70", cardType: 0, nameUUID: FW_NAME_UUID_HEX }],
    });
    expect(c.sent[0].list[0]).not.toHaveProperty("keyBoardPassCode");
    expect(c.sent[0].list[0]).not.toHaveProperty("keyBoardPassCodeNameUUID");
    expect(c.sent[0].list[0]).not.toHaveProperty("type");
  });
});

// ============================================================
// [ACC-0045] enrolledToCardList: nameUUID 正規化透過・欠落時 v4 採番
// ref: packages/core/src/access.js:826-861
// ============================================================
describe("[ACC-0045] enrolledToCardList: nameUUID 正規化透過・欠落時 v4 採番", () => {
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  it("[ACC-0045] 32hex nameUUID は insertUUIDIsolationCharacter 同形の小文字ハイフン区切りへ整形して透過", () => {
    const list = enrolledToCardList([
      { cardID: "aa", cardName: "n1", cardType: 1, nameUUID: FW_NAME_UUID_HEX },
    ]);
    expect(list[0].nameUUID).toBe(FW_NAME_UUID_DASHED);
  });

  it("[ACC-0045] 既ハイフン付き nameUUID は小文字化のみ", () => {
    const list = enrolledToCardList([
      { cardID: "aa", nameUUID: "368154C1-28BC-4BCD-BE62-F3B15C7496D0" },
    ]);
    expect(list[0].nameUUID).toBe(FW_NAME_UUID_DASHED);
  });

  it("[ACC-0045] nameUUID 欠落時のみ generateUUID() (v4) を採番する", () => {
    const list = enrolledToCardList([{ cardID: "aa", cardName: "n1", cardType: 1 }]);
    expect(list[0].nameUUID).toMatch(UUID_V4);
  });

  it("[ACC-0045] nameUUID がある場合は新規採番しない (ファームウェアと DB の一致不変条件)", () => {
    const list = enrolledToCardList([{ cardID: "aa", nameUUID: FW_NAME_UUID_HEX }]);
    // 正規化後は FW_NAME_UUID_DASHED。v4 採番値 (ランダム) ではない。
    expect(list[0].nameUUID).toBe(FW_NAME_UUID_DASHED);
  });

  it("[ACC-0045] 非配列入力は空配列", () => {
    expect(enrolledToCardList(undefined)).toEqual([]);
    expect(enrolledToCardList(null)).toEqual([]);
  });
});

// ============================================================
// [ACC-0046] enrolledToPasscodeList: {passwordID,name,nameUUID} のみ、passwordID→cardID フォールバック
// ref: packages/core/src/access.js:876-887
// ============================================================
describe("[ACC-0046] enrolledToPasscodeList: {passwordID,name,nameUUID} のみ、keyBoardPassCode 系なし", () => {
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  it("[ACC-0046] 写像キーは {passwordID,name,nameUUID} のみ", () => {
    const list = enrolledToPasscodeList([
      { cardID: "0102", cardName: "70", cardType: 0, nameUUID: FW_NAME_UUID_HEX },
    ]);
    expect(Object.keys(list[0]).sort()).toEqual(["name", "nameUUID", "passwordID"]);
  });

  it("[ACC-0046] passwordID フィールドが有れば passwordID を使う", () => {
    const list = enrolledToPasscodeList([
      { passwordID: "p1", cardID: "c1", cardName: "n", nameUUID: FW_NAME_UUID_HEX },
    ]);
    expect(list[0].passwordID).toBe("p1");
  });

  it("[ACC-0046] passwordID 欠落時は cardID へフォールバック", () => {
    const list = enrolledToPasscodeList([
      { cardID: "0102", cardName: "70", nameUUID: FW_NAME_UUID_HEX },
    ]);
    expect(list[0].passwordID).toBe("0102");
  });

  it("[ACC-0046] nameUUID は 32hex を正規化して透過する", () => {
    const list = enrolledToPasscodeList([
      { cardID: "0102", cardName: "70", nameUUID: FW_NAME_UUID_HEX },
    ]);
    expect(list[0].nameUUID).toBe(FW_NAME_UUID_DASHED);
  });

  it("[ACC-0046] nameUUID 欠落時は v4 採番する", () => {
    const list = enrolledToPasscodeList([{ cardID: "0102", cardName: "70" }]);
    expect(list[0].nameUUID).toMatch(UUID_V4);
  });

  it("[ACC-0046] keyBoardPassCode/keyBoardPassCodeNameUUID/type を含めない", () => {
    const list = enrolledToPasscodeList([
      { cardID: "0102", cardName: "70", cardType: 0, nameUUID: FW_NAME_UUID_HEX },
    ]);
    expect(list[0]).not.toHaveProperty("keyBoardPassCode");
    expect(list[0]).not.toHaveProperty("keyBoardPassCodeNameUUID");
    expect(list[0]).not.toHaveProperty("type");
  });
});

// ============================================================
// [ACC-0047] client.registerCards → access.syncEnrolledCards(records) 配線
// ref: packages/core/src/client.js:970-976
// ============================================================
describe("[ACC-0047] SesameHub3.registerCards: syncEnrolledCards(records) へ配線", () => {
  it("[ACC-0047] registerCards メソッドが SesameHub3 プロトタイプに存在する", () => {
    expect(typeof SesameHub3.prototype.registerCards).toBe("function");
  });

  it("[ACC-0047] registerCards が syncEnrolledCards へ委譲し records を渡す", async () => {
    const syncSpy = vi.spyOn(access, "syncEnrolledCards").mockResolvedValue([{ ok: true }]);

    // コンストラクタを経由せず prototype から最小インスタンスを作成 (_ws のみ必要)
    const hub = Object.create(SesameHub3.prototype);
    const fakeWs = mockClient({ success: true });
    hub._ws = fakeWs;

    const cards = [{ cardID: "AA01", cardName: "n1", cardType: 1 }];
    await hub.registerCards("dev-uuid", cards);

    expect(syncSpy).toHaveBeenCalledTimes(1);
    // 第1引数は ws client、第2引数に deviceUUID と records
    const [, params] = syncSpy.mock.calls[0];
    expect(params.deviceUUID).toBe("dev-uuid");
    expect(params.records).toEqual(cards);

    syncSpy.mockRestore();
  });
});

// ============================================================
// [ACC-0048] client.registerPasscodes → access.syncEnrolledPasscodes(records) 配線
// ref: packages/core/src/client.js:992-995
// ============================================================
describe("[ACC-0048] SesameHub3.registerPasscodes: syncEnrolledPasscodes(records) へ配線", () => {
  it("[ACC-0048] registerPasscodes メソッドが SesameHub3 プロトタイプに存在する", () => {
    expect(typeof SesameHub3.prototype.registerPasscodes).toBe("function");
  });

  it("[ACC-0048] registerPasscodes が syncEnrolledPasscodes へ委譲し records を渡す", async () => {
    const syncSpy = vi.spyOn(access, "syncEnrolledPasscodes").mockResolvedValue({ ok: true });

    // コンストラクタを経由せず prototype から最小インスタンスを作成 (_ws のみ必要)
    const hub = Object.create(SesameHub3.prototype);
    const fakeWs = mockClient({ success: true });
    hub._ws = fakeWs;

    const passcodes = [{ cardID: "0102", cardName: "70", cardType: 0 }];
    await hub.registerPasscodes("dev-uuid", passcodes);

    expect(syncSpy).toHaveBeenCalledTimes(1);
    const [, params] = syncSpy.mock.calls[0];
    expect(params.deviceUUID).toBe("dev-uuid");
    expect(params.records).toEqual(passcodes);

    syncSpy.mockRestore();
  });
});

// ============================================================
// [ACC-0049] serve access.registerCards エントリ params/handler
// ref: packages/kit/src/serve/entries/device.js:94-102; registry.js:337
// ============================================================
describe("[ACC-0049] serve access.registerCards エントリの params/handler が hub.registerCards に 1:1", () => {
  it("[ACC-0049] deviceEntriesPre に access.registerCards エントリが存在する", () => {
    const entries = deviceEntriesPre();
    expect("access.registerCards" in entries).toBe(true);
  });

  it("[ACC-0049] params に deviceUUID (required) と cards (required) が宣言されている", () => {
    const entry = deviceEntriesPre()["access.registerCards"];
    const paramMap = Object.fromEntries(entry.params.map((p) => [p.name, p]));
    expect(paramMap.deviceUUID).toBeDefined();
    expect(paramMap.deviceUUID.required).toBe(true);
    expect(paramMap.cards).toBeDefined();
    expect(paramMap.cards.required).toBe(true);
  });

  it("[ACC-0049] handler が hub.registerCards(deviceUUID, cards) を呼ぶ", async () => {
    const entry = deviceEntriesPre()["access.registerCards"];
    const hub = makeHubStub();
    const daemon = makeDaemon();
    const params = { deviceUUID: "u1", cards: [{ cardID: "aa" }] };
    await entry.handler({ hub, params, daemon });
    expect(hub.registerCards).toHaveBeenCalledWith("u1", [{ cardID: "aa" }]);
  });

  it("[ACC-0049] 未認証 daemon は NOT_AUTHENTICATED を投げる", () => {
    const entry = deviceEntriesPre()["access.registerCards"];
    const hub = makeHubStub();
    const daemon = makeDaemon({ authState: "expired" });
    expect(() => entry.handler({ hub, params: { deviceUUID: "u1", cards: [] }, daemon }))
      .toThrow();
  });

  it("[ACC-0049] registry に access.registerCards が登録されている", () => {
    const reg = buildRegistry();
    expect(reg.has("access.registerCards")).toBe(true);
  });
});

// ============================================================
// [ACC-0050] serve access.registerPasscodes エントリ
// ref: packages/kit/src/serve/entries/device.js:106-114
// ============================================================
describe("[ACC-0050] serve access.registerPasscodes エントリの params/handler が hub.registerPasscodes に 1:1", () => {
  it("[ACC-0050] deviceEntriesPre に access.registerPasscodes エントリが存在する", () => {
    const entries = deviceEntriesPre();
    expect("access.registerPasscodes" in entries).toBe(true);
  });

  it("[ACC-0050] params に deviceUUID (required) と passcodes (required) が宣言されている", () => {
    const entry = deviceEntriesPre()["access.registerPasscodes"];
    const paramMap = Object.fromEntries(entry.params.map((p) => [p.name, p]));
    expect(paramMap.deviceUUID).toBeDefined();
    expect(paramMap.deviceUUID.required).toBe(true);
    expect(paramMap.passcodes).toBeDefined();
    expect(paramMap.passcodes.required).toBe(true);
  });

  it("[ACC-0050] handler が hub.registerPasscodes(deviceUUID, passcodes) を呼ぶ", async () => {
    const entry = deviceEntriesPre()["access.registerPasscodes"];
    const hub = makeHubStub();
    const daemon = makeDaemon();
    const params = { deviceUUID: "u1", passcodes: [{ cardID: "01" }] };
    await entry.handler({ hub, params, daemon });
    expect(hub.registerPasscodes).toHaveBeenCalledWith("u1", [{ cardID: "01" }]);
  });

  it("[ACC-0050] registry に access.registerPasscodes が登録されている", () => {
    const reg = buildRegistry();
    expect(reg.has("access.registerPasscodes")).toBe(true);
  });
});

// ============================================================
// [ACC-0051] serve access.postAuthenticationData エントリ
// ref: packages/kit/src/serve/entries/device.js:352-357; registry.js:341
// ============================================================
describe("[ACC-0051] serve access.postAuthenticationData エントリの params/handler が hub.postAuthenticationData に 1:1", () => {
  it("[ACC-0051] accessAuthEntries に access.postAuthenticationData が存在する", () => {
    const entries = accessAuthEntries();
    expect("access.postAuthenticationData" in entries).toBe(true);
  });

  it("[ACC-0051] operation/deviceID/items が required、baseUrl が optional", () => {
    const entry = accessAuthEntries()["access.postAuthenticationData"];
    const paramMap = Object.fromEntries(entry.params.map((p) => [p.name, p]));
    expect(paramMap.operation.required).toBe(true);
    expect(paramMap.deviceID.required).toBe(true);
    expect(paramMap.items.required).toBe(true);
    expect(paramMap.baseUrl.required).toBe(false);
  });

  it("[ACC-0051] handler が requireAuth → need(['operation','deviceID','items']) → hub.postAuthenticationData(params) を呼ぶ", async () => {
    const entry = accessAuthEntries()["access.postAuthenticationData"];
    const hub = makeHubStub();
    const daemon = makeDaemon();
    const params = { operation: "nfc_card", deviceID: "d1", items: [] };
    await entry.handler({ hub, params, daemon });
    expect(hub.postAuthenticationData).toHaveBeenCalledWith(params);
  });

  it("[ACC-0051] registry に access.postAuthenticationData が登録されている", () => {
    const reg = buildRegistry();
    expect(reg.has("access.postAuthenticationData")).toBe(true);
  });
});

// ============================================================
// [ACC-0052] serve access.put/deleteAuthenticationData エントリ存在と 1:1 配線
// ref: packages/kit/src/serve/entries/device.js:358-369
// ============================================================
describe("[ACC-0052] serve access.put/deleteAuthenticationData エントリ存在と 1:1 配線", () => {
  it("[ACC-0052] accessAuthEntries に put/delete 両エントリが存在する", () => {
    const entries = accessAuthEntries();
    expect("access.putAuthenticationData" in entries).toBe(true);
    expect("access.deleteAuthenticationData" in entries).toBe(true);
  });

  it("[ACC-0052] put: operation/deviceID/items が required", () => {
    const entry = accessAuthEntries()["access.putAuthenticationData"];
    const paramMap = Object.fromEntries(entry.params.map((p) => [p.name, p]));
    expect(paramMap.operation.required).toBe(true);
    expect(paramMap.deviceID.required).toBe(true);
    expect(paramMap.items.required).toBe(true);
  });

  it("[ACC-0052] delete: operation/deviceID/items が required", () => {
    const entry = accessAuthEntries()["access.deleteAuthenticationData"];
    const paramMap = Object.fromEntries(entry.params.map((p) => [p.name, p]));
    expect(paramMap.operation.required).toBe(true);
    expect(paramMap.deviceID.required).toBe(true);
    expect(paramMap.items.required).toBe(true);
  });

  it("[ACC-0052] put handler が hub.putAuthenticationData(params) を呼ぶ", async () => {
    const entry = accessAuthEntries()["access.putAuthenticationData"];
    const hub = makeHubStub();
    const daemon = makeDaemon();
    const params = { operation: "fp", deviceID: "d1", items: [] };
    await entry.handler({ hub, params, daemon });
    expect(hub.putAuthenticationData).toHaveBeenCalledWith(params);
  });

  it("[ACC-0052] delete handler が hub.deleteAuthenticationData(params) を呼ぶ", async () => {
    const entry = accessAuthEntries()["access.deleteAuthenticationData"];
    const hub = makeHubStub();
    const daemon = makeDaemon();
    const params = { operation: "fp", deviceID: "d1", items: [] };
    await entry.handler({ hub, params, daemon });
    expect(hub.deleteAuthenticationData).toHaveBeenCalledWith(params);
  });
});

// ============================================================
// [ACC-0053] serve access.updateAuthenticationName: 全 params optional、need() 呼ばず hub へ素通し
// ref: packages/kit/src/serve/entries/device.js:370-397
// ============================================================
describe("[ACC-0053] serve access.updateAuthenticationName: 全 params optional、need() 無し", () => {
  it("[ACC-0053] accessAuthEntries に access.updateAuthenticationName が存在する", () => {
    const entries = accessAuthEntries();
    expect("access.updateAuthenticationName" in entries).toBe(true);
  });

  it("[ACC-0053] 全 params が required:false", () => {
    const entry = accessAuthEntries()["access.updateAuthenticationName"];
    for (const p of entry.params) {
      expect(p.required, `param ${p.name} should be required:false`).toBe(false);
    }
  });

  it("[ACC-0053] request/kind/各 *NameUUID/*ID/cardType/type/op 等が params に宣言されている", () => {
    const entry = accessAuthEntries()["access.updateAuthenticationName"];
    const names = entry.params.map((p) => p.name);
    for (const n of [
      "request", "kind", "cardNameUUID", "fingerPrintNameUUID", "palmNameUUID",
      "keyBoardPassCodeNameUUID", "cardID", "fingerPrintID", "palmID",
      "keyBoardPassCode", "cardType", "type", "op", "subUUID", "stpDeviceUUID", "name",
    ]) {
      expect(names, `missing param: ${n}`).toContain(n);
    }
  });

  it("[ACC-0053] handler が need() を呼ばず hub.updateAuthenticationName(params) へ素通しする", async () => {
    const entry = accessAuthEntries()["access.updateAuthenticationName"];
    const hub = makeHubStub();
    const daemon = makeDaemon();
    // kind もなく request もない — need() を呼ばないので欠落でエラーにならない
    const params = { kind: "card", cardID: "C1" };
    await entry.handler({ hub, params, daemon });
    expect(hub.updateAuthenticationName).toHaveBeenCalledWith(params);
  });
});

// ============================================================
// [ACC-0054] serve registry: access.* 11 op が NAMESPACE_OPS から自動公開
// ref: packages/kit/src/serve/registry.js:287-303; packages/core/src/access.js:972-976
// ============================================================
describe("[ACC-0054] serve registry: access.* 11 op が NAMESPACE_OPS から自動公開", () => {
  const EXPECTED_OPS = [
    "getCards", "getPasscodes", "postCards", "postPasscodes",
    "delCards", "delPasscodes", "clearCards", "clearPasscodes",
    "updateCardName", "updatePasscodeName", "updateCardOwner",
  ];

  it("[ACC-0054] NAMESPACE_OPS がちょうど 11 op を宣言している", () => {
    expect(NAMESPACE_OPS).toHaveLength(11);
    expect([...NAMESPACE_OPS].sort()).toEqual([...EXPECTED_OPS].sort());
  });

  it("[ACC-0054] NAMESPACE_OPS に定義外の op が混入していない", () => {
    const extra = NAMESPACE_OPS.filter((op) => !EXPECTED_OPS.includes(op));
    expect(extra).toEqual([]);
  });

  it("[ACC-0054] registry に access.<op> が全 11 op 登録されている", () => {
    const reg = buildRegistry();
    for (const op of EXPECTED_OPS) {
      expect(reg.has(`access.${op}`), `access.${op} が registry に存在しない`).toBe(true);
    }
  });

  it("[ACC-0054] syncEnrolledCards/syncEnrolledPasscodes は registry に登録されない (allowlist 外)", () => {
    const reg = buildRegistry();
    expect(reg.has("access.syncEnrolledCards")).toBe(false);
    expect(reg.has("access.syncEnrolledPasscodes")).toBe(false);
  });

  it("[ACC-0054] syncEnrolledCards/syncEnrolledPasscodes は NAMESPACE_OPS に含まれない", () => {
    expect(NAMESPACE_OPS).not.toContain("syncEnrolledCards");
    expect(NAMESPACE_OPS).not.toContain("syncEnrolledPasscodes");
  });
});

// ============================================================
// [ACC-0055] serve: access.delCards/delPasscodes の boolean 戻り
// ref: packages/core/src/access.js:514-518; packages/kit/src/serve/registry.js:287-303
// ============================================================
describe("[ACC-0055] serve: access.delCards/delPasscodes の boolean 戻り", () => {
  it("[ACC-0055] access.delCards が registry に登録されている", () => {
    const reg = buildRegistry();
    expect(reg.has("access.delCards")).toBe(true);
  });

  it("[ACC-0055] access.delPasscodes が registry に登録されている", () => {
    const reg = buildRegistry();
    expect(reg.has("access.delPasscodes")).toBe(true);
  });

  it("[ACC-0055] items 非空なら true を返す (core boolean 契約)", async () => {
    const { delCards } = await import("../../src/access.js");
    // delCards は send (fire-and-forget) なので strictRequestOnly=false の mockClient を使う
    const c = mockClient({ success: true });
    const result = await delCards(c, {
      items: [{ deviceID: "d1", cardID: "c1" }],
    });
    expect(result).toBe(true);
  });

  it("[ACC-0055] items 空なら false を返す (core boolean 契約)", async () => {
    const { delCards } = await import("../../src/access.js");
    const c = mockClient({ success: true });
    const result = await delCards(c, { items: [] });
    expect(result).toBe(false);
  });

  it("[ACC-0055] delPasscodes: items 非空なら true", async () => {
    const { delPasscodes } = await import("../../src/access.js");
    const c = mockClient({ success: true });
    const result = await delPasscodes(c, {
      items: [{ deviceID: "d1", passwordID: "p1" }],
    });
    expect(result).toBe(true);
  });

  it("[ACC-0055] delPasscodes: items 空なら false", async () => {
    const { delPasscodes } = await import("../../src/access.js");
    const c = mockClient({ success: true });
    const result = await delPasscodes(c, { items: [] });
    expect(result).toBe(false);
  });
});

// ============================================================
// [ACC-0056] access.* RPC は未認証で NOT_AUTHENTICATED、未接続で CONNECTION_LOST
// ref: packages/kit/src/serve/entries/device.js:101,356; registry-helpers.js:55-62
// ============================================================
describe("[ACC-0056] access.* RPC: 未認証で NOT_AUTHENTICATED、未接続で CONNECTION_LOST", () => {
  it("[ACC-0056] requireAuth: authState='expired' で NOT_AUTHENTICATED を throw", () => {
    const daemon = makeDaemon({ authState: "expired" });
    expect(() => requireAuth(daemon)).toThrow();
    try {
      requireAuth(daemon);
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      expect(e.kind).toBe(KIND.NOT_AUTHENTICATED);
    }
  });

  it("[ACC-0056] requireAuth: hub.connected=false で CONNECTION_LOST を throw", () => {
    const daemon = makeDaemon({ authState: "ok", connected: false });
    expect(() => requireAuth(daemon)).toThrow();
    try {
      requireAuth(daemon);
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      expect(e.kind).toBe(KIND.CONNECTION_LOST);
    }
  });

  it("[ACC-0056] access.registerCards handler: 未認証で NOT_AUTHENTICATED", () => {
    const entry = deviceEntriesPre()["access.registerCards"];
    const hub = makeHubStub();
    const daemon = makeDaemon({ authState: "expired" });
    let caught = null;
    try {
      entry.handler({ hub, params: { deviceUUID: "u1", cards: [] }, daemon });
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught.kind).toBe(KIND.NOT_AUTHENTICATED);
  });

  it("[ACC-0056] access.postAuthenticationData handler: 未接続で CONNECTION_LOST", () => {
    const entry = accessAuthEntries()["access.postAuthenticationData"];
    const hub = makeHubStub();
    const daemon = makeDaemon({ authState: "ok", connected: false });
    let caught = null;
    try {
      entry.handler({ hub, params: { operation: "nfc_card", deviceID: "d1", items: [] }, daemon });
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught.kind).toBe(KIND.CONNECTION_LOST);
  });
});

// ============================================================
// [ACC-0057] access.* RPC は必須欠落で INVALID_PARAMS/BAD_PARAMS
// ref: packages/kit/src/serve/entries/device.js:101,356; registry-helpers.js:32-38
// ============================================================
describe("[ACC-0057] access.* RPC: 必須欠落で BAD_PARAMS (need())", () => {
  it("[ACC-0057] need(): 欠落キーで RpcError(kind:BAD_PARAMS) を throw", () => {
    expect(() => need({ deviceUUID: "u1" }, ["deviceUUID", "cards"])).toThrow();
    try {
      need({ deviceUUID: "u1" }, ["deviceUUID", "cards"]);
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      expect(e.kind).toBe(KIND.BAD_PARAMS);
    }
  });

  it("[ACC-0057] need(): undefined は欠落と見なす", () => {
    expect(() => need({ deviceUUID: undefined }, ["deviceUUID"])).toThrow();
  });

  it("[ACC-0057] need(): null 値は欠落とみなす", () => {
    expect(() => need({ deviceUUID: null }, ["deviceUUID"])).toThrow();
    try {
      need({ deviceUUID: null, cards: [] }, ["deviceUUID", "cards"]);
    } catch (e) {
      expect(e.kind).toBe(KIND.BAD_PARAMS);
    }
  });

  it("[ACC-0057] need(): 空文字は欠落とみなす", () => {
    expect(() => need({ deviceUUID: "" }, ["deviceUUID"])).toThrow();
    try {
      need({ deviceUUID: "", cards: [] }, ["deviceUUID", "cards"]);
    } catch (e) {
      expect(e.kind).toBe(KIND.BAD_PARAMS);
    }
  });

  it("[ACC-0057] need(): 全キー揃っていれば throw しない", () => {
    expect(() => need({ deviceUUID: "u1", cards: [{}] }, ["deviceUUID", "cards"])).not.toThrow();
  });

  it("[ACC-0057] access.registerCards handler: deviceUUID 欠落で BAD_PARAMS", () => {
    const entry = deviceEntriesPre()["access.registerCards"];
    const hub = makeHubStub();
    const daemon = makeDaemon();
    let caught = null;
    try {
      entry.handler({ hub, params: { cards: [{}] }, daemon });
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught.kind).toBe(KIND.BAD_PARAMS);
  });

  it("[ACC-0057] access.postAuthenticationData handler: items 欠落で BAD_PARAMS", () => {
    const entry = accessAuthEntries()["access.postAuthenticationData"];
    const hub = makeHubStub();
    const daemon = makeDaemon();
    let caught = null;
    try {
      entry.handler({ hub, params: { operation: "nfc_card", deviceID: "d1" }, daemon });
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught.kind).toBe(KIND.BAD_PARAMS);
  });
});
