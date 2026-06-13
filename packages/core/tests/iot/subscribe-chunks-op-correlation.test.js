// P3-3: subscribeChunks errorAction の op 相関絞り — 無関係な op の失敗フレームを無視する。
//
// 参照: references_web/src/api/useManageDevice.js:27-34
//   vendor の !message.success は action レベルの判定。kit は並行 RPC 環境のため、
//   同 action でも別 op の失敗応答で一覧取得が誤 reject しないよう op 相関を絞る。
//
// 見逃し根因: 既存テストは「同 action の success:false」を「常に失敗」と固定していたが、
//   「同 action / 別 op の success:false は無視」のケースが無かった。

import { describe, it, expect } from "vitest";
import { subscribeChunks } from "../../src/util.js";
import { ERR } from "../../src/errors.js";

const ACTION = "biz3ManageDevice";

/**
 * onMessage 対応の mock client (errorAction 経路テスト用)。
 */
function makeOnMessageClient() {
  /** @type {Map<string, Set<Function>>} */
  const subs = new Map();
  /** @type {Set<Function>} */
  const listeners = new Set();
  const sent = [];
  return {
    sent,
    send: (f) => sent.push(f),
    subscribe(key, fn) {
      if (!subs.has(key)) subs.set(key, new Set());
      subs.get(key).add(fn);
      return () => subs.get(key)?.delete(fn);
    },
    onMessage(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    // テスト用: key 購読者と全 onMessage リスナに push
    emit(key, msg) {
      for (const fn of [...(subs.get(key) ?? [])]) fn(msg);
      for (const fn of [...listeners]) fn(msg);
    },
    // テスト用: onMessage リスナのみに push (key なし)
    emitRaw(msg) {
      for (const fn of [...listeners]) fn(msg);
    },
  };
}

describe("P3-3: subscribeChunks errorAction op 相関絞り (useManageDevice.js:27-34)", () => {
  it("同 action / 同 op の success:false は失敗確定 (従来挙動維持)", async () => {
    const client = makeOnMessageClient();
    const p = subscribeChunks(client, {
      sendFrame: { action: ACTION, op: "getUserDevice" },
      subscriptions: [{ key: `${ACTION}:PubedUserDevice`, onMessage: () => {} }],
      timeoutMs: 5000,
      errorAction: ACTION,
      result: () => [],
    });
    // 自要求 op の失敗応答
    client.emitRaw({ action: ACTION, op: "getUserDevice", success: false, message: "server error" });
    await expect(p).rejects.toMatchObject({ code: ERR.REJECTED });
  });

  it("P3-3: 同 action / 別 op (del) の success:false は無視され、正常 push で完了する", async () => {
    // 並行 RPC 環境で一覧取得の 10 秒窓に同 action の del 失敗が届くケース
    const client = makeOnMessageClient();
    const collected = [];
    const p = subscribeChunks(client, {
      sendFrame: { action: ACTION, op: "getUserDevice" },
      subscriptions: [{
        key: `${ACTION}:PubedUserDevice`,
        onMessage(msg, finish) {
          collected.push(...(msg?.data?.data?.list ?? []));
          finish();
        },
      }],
      timeoutMs: 5000,
      errorAction: ACTION,
      result: () => collected,
    });
    // 別 op (del) の失敗 — 無視されるべき
    client.emitRaw({ action: ACTION, op: "del", success: false, message: "Device not found" });
    // 自要求の正常 push
    client.emit(`${ACTION}:PubedUserDevice`, {
      action: ACTION, op: "PubedUserDevice", success: true,
      data: { totalPage: 1, data: { list: [{ deviceUUID: "d-1" }], page: 1 } },
    });
    const result = await p;
    expect(result).toEqual([{ deviceUUID: "d-1" }]);
  });

  it("P3-3: 同 action / 別 op (updateName) の success:false は無視される", async () => {
    const client = makeOnMessageClient();
    const p = subscribeChunks(client, {
      sendFrame: { action: ACTION, op: "getUserDevice" },
      subscriptions: [{
        key: `${ACTION}:PubedUserDevice`,
        onMessage(msg, finish) { finish(); },
      }],
      timeoutMs: 5000,
      errorAction: ACTION,
      result: () => "ok",
    });
    client.emitRaw({ action: ACTION, op: "updateName", success: false, message: "Not found" });
    client.emit(`${ACTION}:PubedUserDevice`, { action: ACTION, op: "PubedUserDevice", success: true });
    await expect(p).resolves.toBe("ok");
  });

  it("op フィールドが無い success:false は従来どおり失敗確定 (op 欠落 = 自要求エラーとみなす)", async () => {
    const client = makeOnMessageClient();
    const p = subscribeChunks(client, {
      sendFrame: { action: ACTION, op: "getUserDevice" },
      subscriptions: [{ key: `${ACTION}:PubedUserDevice`, onMessage: () => {} }],
      timeoutMs: 5000,
      errorAction: ACTION,
      result: () => [],
    });
    // op フィールドなし (古いサーバの応答形式)
    client.emitRaw({ action: ACTION, success: false, message: "generic error" });
    await expect(p).rejects.toMatchObject({ code: ERR.REJECTED });
  });

  it("sendFrame に op が無い場合は op 絞りなし (従来挙動: 別 op でも失敗確定)", async () => {
    const client = makeOnMessageClient();
    // sendFrame に op なし → ownOp = null → op 絞り無効
    const p = subscribeChunks(client, {
      sendFrame: { action: ACTION }, // op なし
      subscriptions: [{ key: `${ACTION}:something`, onMessage: () => {} }],
      timeoutMs: 5000,
      errorAction: ACTION,
      result: () => [],
    });
    // 任意 op の失敗でも拾う (op 絞り無効)
    client.emitRaw({ action: ACTION, op: "del", success: false, message: "any op error" });
    await expect(p).rejects.toMatchObject({ code: ERR.REJECTED });
  });

  it("別 action の success:false は無視 (従来挙動維持)", async () => {
    const client = makeOnMessageClient();
    const p = subscribeChunks(client, {
      sendFrame: { action: ACTION, op: "getUserDevice" },
      subscriptions: [{
        key: `${ACTION}:PubedUserDevice`,
        onMessage(msg, finish) { finish(); },
      }],
      timeoutMs: 5000,
      errorAction: ACTION,
      result: () => "done",
    });
    client.emitRaw({ action: "biz3IRRemote", op: "x", success: false });
    client.emit(`${ACTION}:PubedUserDevice`, { action: ACTION });
    await expect(p).resolves.toBe("done");
  });
});
