// Unit tests for SesameHub3.listDevices() の複数ページ蓄積 (P1-13)。
//
// fixture の導出元 (vendor の応答処理): references_web/src/api/useManageDevice.js:36-55
//   case PubedCompanyDevice:
//     const { totalPage, data: { list, page } } = message.data;
//     if (page === 1) tmpRef.current = [...list];          // page1 = 置換
//     else tmpRef.current = [...tmpRef.current, ...list];  // page>1 = 追記
//     if (totalPage === page) setCompanyDevices(tmpRef.current);  // 確定
// → PubedCompanyDevice は {totalPage, data:{list, page}} の page 単位 push であり、
//   最初の push で即 resolve すると 1 ページ超のアカウントで一覧が切り詰められる。
//
// 戦略: 実 WS を立てず、SesameHub3 に最小 fake ws (subscribe/send/emit) を注入して
//   subscribeChunks 経由の蓄積・完了判定・timeout だけを検証する
//   (transport の dispatch key `${action}:${op}` 機構は tests/transport で検証済み)。

import { describe, it, expect, beforeEach, vi } from "vitest";
import { SesameHub3 } from "../../src/client.js";

const ACTION = "biz3ManageDevice";
const PUBED_KEY = `${ACTION}:PubedCompanyDevice`;

/**
 * subscribeChunks が要求する最小 fake ws (subscribe/send + テスト用 emit)。
 * onMessage は util.subscribeChunks の errorAction 機構 (P1-5) が使う全受信フック。
 * 導出元: src/transport.js の Hub3WsClient.onMessage / subscribeChunks:165-173 の
 * `typeof client.onMessage === "function"` ガード。
 */
function makeFakeWs() {
  const sends = [];
  const subscriptions = new Map(); // key -> Set<fn>
  const msgListeners = []; // onMessage ハンドラのリスト (errorAction 機構用)
  return {
    sends,
    send: vi.fn((frame) => { sends.push(frame); }),
    subscribe: vi.fn((key, fn) => {
      if (!subscriptions.has(key)) subscriptions.set(key, new Set());
      subscriptions.get(key).add(fn);
      return () => subscriptions.get(key)?.delete(fn);
    }),
    /** transport.js Hub3WsClient.onMessage と同型: リスナー登録 + unsubscribe 返却。 */
    onMessage: vi.fn((fn) => {
      msgListeners.push(fn);
      return () => {
        const i = msgListeners.indexOf(fn);
        if (i >= 0) msgListeners.splice(i, 1);
      };
    }),
    emit(key, msg) {
      for (const fn of subscriptions.get(key) ?? []) fn(msg);
    },
    /** onMessage ハンドラ全員に msg を配信 (errorAction の success:false 検知に使う)。 */
    emitRaw(msg) {
      for (const fn of [...msgListeners]) fn(msg);
    },
    /** 現在の購読数 (unsubscribe 漏れ検出用)。 */
    subCount(key) { return subscriptions.get(key)?.size ?? 0; },
  };
}

/** 接続済み状態の SesameHub3 (fake ws 注入)。実 fs / 実 WS には触らない。 */
function makeHub(ws) {
  const hub = new SesameHub3({
    config: { companyID: "co-A" },
    tokenStore: { load: () => ({}), save: () => {}, clear: () => {} },
  });
  hub._ws = ws; // _ensureConnected を通すための直接注入 (connect はネットワークを要するため)
  return hub;
}

/**
 * vendor push fixture (useManageDevice.js:36-55 の分割代入対象と同形):
 *   message.data = { totalPage, data: { list, page } }
 */
function pubed(totalPage, page, list) {
  return { action: ACTION, op: "PubedCompanyDevice", success: true, data: { totalPage, data: { list, page } } };
}

const D = (n) => ({ deviceUUID: `uuid-${n}`, deviceName: `dev-${n}` });

describe("SesameHub3.listDevices (P1-13: 複数ページ蓄積)", () => {
  let ws;
  let hub;

  beforeEach(() => {
    ws = makeFakeWs();
    hub = makeHub(ws);
  });

  it("getCompanyDevice frame を送り、単一ページ (totalPage===page===1) で全件 resolve する", async () => {
    const p = hub.listDevices({ timeoutMs: 500 });
    ws.emit(PUBED_KEY, pubed(1, 1, [D(1), D(2)]));
    await expect(p).resolves.toEqual([D(1), D(2)]);
    expect(ws.sends[0]).toEqual({ action: ACTION, op: "getCompanyDevice", companyID: "co-A" });
  });

  it("複数ページ push (totalPage=3) を全ページ蓄積し、totalPage===page で確定する", async () => {
    const p = hub.listDevices({ timeoutMs: 500 });
    ws.emit(PUBED_KEY, pubed(3, 1, [D(1), D(2)]));
    ws.emit(PUBED_KEY, pubed(3, 2, [D(3)]));
    // まだ resolve しない (page 2/3) — 旧実装は最初の push で即 resolve していた
    ws.emit(PUBED_KEY, pubed(3, 3, [D(4), D(5)]));
    await expect(p).resolves.toEqual([D(1), D(2), D(3), D(4), D(5)]);
  });

  it("page===1 の再 push は蓄積を置換する (vendor: tmpRef.current = [...list])", async () => {
    const p = hub.listDevices({ timeoutMs: 500 });
    ws.emit(PUBED_KEY, pubed(2, 1, [D(1)]));
    // サーバ再送等で page1 がもう一度来たら置換 (重複させない)
    ws.emit(PUBED_KEY, pubed(2, 1, [D(10)]));
    ws.emit(PUBED_KEY, pubed(2, 2, [D(11)]));
    await expect(p).resolves.toEqual([D(10), D(11)]);
  });

  it("totalPage が無い push は単一 chunk とみなし即完了 (getUserDevices と同型)", async () => {
    const p = hub.listDevices({ timeoutMs: 500 });
    ws.emit(PUBED_KEY, { action: ACTION, op: "PubedCompanyDevice", success: true, data: { data: { list: [D(1)], page: 1 } } });
    await expect(p).resolves.toEqual([D(1)]);
  });

  it("最終ページが来なければ timeout で reject する", async () => {
    const p = hub.listDevices({ timeoutMs: 30 });
    ws.emit(PUBED_KEY, pubed(2, 1, [D(1)]));
    await expect(p).rejects.toThrow(/getCompanyDevice timeout/);
  });

  it("完了後に購読は解除される (listener leak しない)", async () => {
    const p = hub.listDevices({ timeoutMs: 500 });
    expect(ws.subCount(PUBED_KEY)).toBe(1);
    ws.emit(PUBED_KEY, pubed(1, 1, [D(1)]));
    await p;
    expect(ws.subCount(PUBED_KEY)).toBe(0);
  });

  it("list が空のページも壊れず空配列で確定する", async () => {
    const p = hub.listDevices({ timeoutMs: 500 });
    ws.emit(PUBED_KEY, pubed(1, 1, []));
    await expect(p).resolves.toEqual([]);
  });
});
