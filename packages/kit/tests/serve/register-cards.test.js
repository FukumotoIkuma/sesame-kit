// access.registerCards (クラウド登録) — hub.registerCards 委譲 + serve registry handler。
//
// 設計: 読み取り (BLE) record をクラウド DB へ登録する convenience。新 WS op は捏造せず、
// タップ登録は vendor 検証済の「レコード毎 updateCardName」へ委譲する (P3-11:
// hub.registerCards → access.syncEnrolledCards(records) → updateCardName ×N、
// cards/index.js:104-136)。postCards はファームへ同一 nameUUID を書いた後の一括投入
// (list 指定) 専用。
import { describe, it, expect, vi } from "vitest";
import { SesameHub3 } from "@sesame-kit/core/client";
import { buildRegistry } from "../../src/serve/registry.js";

const ACTION = "biz3ManageAccessCtlAuthData";

/** request(frame) を記録して固定応答を返す fake _ws。 */
function makeHubWithWs(reply = { action: ACTION, op: "updateCardName", code: 200, success: true, data: {} }) {
  const hub = new SesameHub3({
    config: { companyID: "co", wsUrl: "ws://unused", lang: "ja", default: {}, hub3s: {}, remotes: {}, locks: {} },
    tokenStore: {},
  });
  const sent = [];
  hub._ws = { async request(frame) { sent.push(frame); return reply; }, send() { throw new Error("unexpected send"); } };
  return { hub, sent };
}

describe("SesameHub3.registerCards", () => {
  it("BLE 読み取り record をレコード毎の updateCardName へ写像して送る", async () => {
    const { hub, sent } = makeHubWithWs();
    const records = [
      { cardID: "AA11", cardName: "4e616d65", cardType: 1 },
      { cardID: "BB22", cardName: "", cardType: 0 },
    ];
    await hub.registerCards("dev-1", records);

    // vendor のタップ登録は 1 record = 1 updateCardName (cards/index.js:116-124)。
    expect(sent).toHaveLength(2);
    for (const frame of sent) expect(frame.op).toBe("updateCardName");
    // item 形: {cardID, name, cardNameUUID, timestamp, cardType, stpDeviceUUID}。
    expect(sent[0].obj).toMatchObject({ cardID: "AA11", name: "4e616d65", cardType: 1, stpDeviceUUID: "dev-1" });
    expect(typeof sent[0].obj.cardNameUUID).toBe("string");
    expect(typeof sent[0].obj.timestamp).toBe("number");
    expect(sent[1].obj).toMatchObject({ cardID: "BB22", cardType: 0, stpDeviceUUID: "dev-1" });
  });

  it("空配列なら何も送らず null を返す (no-op 契約)", async () => {
    const { hub, sent } = makeHubWithWs();
    expect(await hub.registerCards("dev-1", [])).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("接続前に呼ぶと not connected で throw", async () => {
    const hub = new SesameHub3({
      config: { companyID: "co", wsUrl: "ws://unused", lang: "ja", default: {}, hub3s: {}, remotes: {}, locks: {} },
      tokenStore: {},
    });
    await expect(hub.registerCards("dev-1", [{ cardID: "AA11" }])).rejects.toThrow(/not connected/i);
  });
});

describe("serve registry: access.registerCards", () => {
  const reg = buildRegistry();

  it("登録され experimental で hub.registerCards へ委譲する", async () => {
    const entry = reg.get("access.registerCards");
    expect(entry).toBeTruthy();

    const hub = { registerCards: vi.fn(async (uuid, cards) => ({ ok: true, uuid, count: cards.length })) };
    const daemon = { authState: "ready", hub: { connected: true } };
    const res = await entry.handler({ hub, daemon, params: { deviceUUID: "dev-1", cards: [{ cardID: "AA11" }] } });

    expect(hub.registerCards).toHaveBeenCalledWith("dev-1", [{ cardID: "AA11" }]);
    expect(res).toMatchObject({ ok: true, uuid: "dev-1", count: 1 });
  });

  it("deviceUUID / cards 欠落は bad_params", () => {
    const entry = reg.get("access.registerCards");
    const daemon = { authState: "ready", hub: { connected: true } };
    const hub = { registerCards: vi.fn() };
    expect(() => entry.handler({ hub, daemon, params: { cards: [{ cardID: "AA11" }] } })).toThrow();
    expect(() => entry.handler({ hub, daemon, params: { deviceUUID: "dev-1" } })).toThrow();
    expect(hub.registerCards).not.toHaveBeenCalled();
  });
});
