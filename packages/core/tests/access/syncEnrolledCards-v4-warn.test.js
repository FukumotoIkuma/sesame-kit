// P3-9: syncEnrolledCards が非 v4 nameUUID を検出した場合に stderr 警告を出すことを検証。
//
// 参照: references_web/src/api/useManageAuthData.js:438-471 — biz3 の updateItemName は
//   isUUIDV4(uuidValue) を判定し、非 v4 なら BLE SSM_OS3_CARD_CHANGE(107) で v4 を
//   書き込んでから WS 更新する二段 composite を行う。
//
// kit はオプトイン (BLE composite は呼び出し側責務)。
// 本テストは「警告が出る + WS 送信は通常通り行われる」を固定する。

import { describe, it, expect, vi, afterEach } from "vitest";
import { syncEnrolledCards } from "../../src/access.js";
import { mockClient } from "../helpers/mock-ws.js";

// updateCardName が送るフレームに success:true を返す stub
function makeRequestClient() {
  return mockClient({ success: true, reqContext: {} });
}

// 有効な UUID v4 hex (ハイフン無し): byte[6]=0x41 & 0xf0=0x40, byte[8]=0xa7 & 0xc0=0x80
const V4_NAMEUUID = "550e8400e29b41d4a716446655440000"; // version=0x41, variant=0xa7
// 非 v4: byte[6]=0x11 → version=0x10 ≠ 0x40
const NON_V4_NAMEUUID = "550e8400e29b11d4a716446655440000";

describe("P3-9: syncEnrolledCards — 非 v4 nameUUID 検出時に警告", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("非 v4 nameUUID の records があると stderr に警告が書き込まれる", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const client = makeRequestClient();

    await syncEnrolledCards(client, {
      deviceUUID: "dev-001",
      records: [
        { cardID: "010203", cardName: "Card A", cardType: 0, nameUUID: NON_V4_NAMEUUID },
      ],
    });

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("SSM_OS3_CARD_CHANGE"),
    );
    // normalizeNameUUID が ノーハイフン hex → ハイフン付き形式に変換するため、
    // cardID のみ確認し nameUUID はフォーマット変換後の形を含む文字列で確認する。
    const warnMsg = stderrSpy.mock.calls[0][0];
    expect(typeof warnMsg).toBe("string");
    expect(warnMsg).toContain("cardID=010203");
    // ログに "is not UUID v4" が含まれることで非 v4 警告の発火を確認
    expect(warnMsg).toContain("is not UUID v4");
  });

  it("v4 nameUUID の records では stderr 警告が出ない", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const client = makeRequestClient();

    await syncEnrolledCards(client, {
      deviceUUID: "dev-001",
      records: [
        { cardID: "010203", cardName: "Card A", cardType: 0, nameUUID: V4_NAMEUUID },
      ],
    });

    // v4 は正常なので警告なし
    const warnCalls = stderrSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("SSM_OS3_CARD_CHANGE"),
    );
    expect(warnCalls).toHaveLength(0);
  });

  it("警告が出ても WS 送信 (updateCardName) は実行される", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const client = makeRequestClient();

    await syncEnrolledCards(client, {
      deviceUUID: "dev-001",
      records: [
        { cardID: "010203", cardName: "Card A", cardType: 0, nameUUID: NON_V4_NAMEUUID },
      ],
    });

    // updateCardName が送ったフレームが記録されているか確認
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]).toMatchObject({
      action: "biz3ManageAccessCtlAuthData",
      op: "updateCardName",
    });
  });

  it("nameUUID 欠落 (enrolledToCardList が generateUUID で補完) → 補完 v4 なので警告なし", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const client = makeRequestClient();

    await syncEnrolledCards(client, {
      deviceUUID: "dev-001",
      // nameUUID 欠落 → enrolledToCardList が generateUUID() で補完 (常に v4)
      records: [{ cardID: "010203", cardName: "Card A", cardType: 0 }],
    });

    const warnCalls = stderrSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes("SSM_OS3_CARD_CHANGE"),
    );
    expect(warnCalls).toHaveLength(0);
  });
});
