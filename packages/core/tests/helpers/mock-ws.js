// テスト共有の WS クライアント fake。
//
// org/access/iot/payment/company/schedule/account の各テストで個別に再実装されていた
// 「sent[] 記録 + request 固定応答 + subscribe/push 疑似配信」を 1 箇所に集約する。
// ベースは最も完全だった tests/org/org.test.js 版。差分はオプションで吸収する:
//   - mockClient(reply, { strictRequestOnly })
//       request 系 op 用。strictRequestOnly=true で send/subscribe の誤用を throw で検知
//       (旧 tests/access/access.test.js の requestClient 相当)。
//   - chunkMockClient({ strictPushOnly })
//       send + subscribe (push 集約) 系 op 用。subscribe は key ごとに複数ハンドラを保持し
//       (旧 iot/access 版の Set 方式 — org 版の「1 key 1 fn」の上位互換)、push(key, msg) で
//       テスト側から疑似配信できる。strictPushOnly=true で request の誤用を throw で検知
//       (旧 tests/access/access.test.js の pushClient 相当)。
//
// 【集約せず残した独自実装と理由】
//   - tests/presetir/presetir.test.js: sent に frame そのものではなく {frame, timeoutMs} /
//     {frame, fire:true} を記録し request の timeout 引数まで検証する独自形。
//   - tests/lock/autolock.test.js / triggerLock.test.js: mechStatus 購読と CHSesame2 風の
//     デバイス状態機械を再現する高機能 fake で、ここの「フレーム記録」fake とは目的が異なる。
//   - tests/util/subscribeChunks.test.js: client.onMessage (errorAction 経路) など
//     subscribeChunks 固有の拡張が必要なため、chunkMockClient を内部で包んで使う。

/**
 * 同期 (request/response) op 用 mock client。
 * request(frame) を sent に記録し、固定 reply を返す。
 *
 * @param {unknown} reply request が返す固定応答
 * @param {{ strictRequestOnly?: boolean }} [opts]
 *        strictRequestOnly: send/subscribe が呼ばれたら throw (request 系 op が誤って
 *        push 経路に入っていないことを検知する)。
 */
export function mockClient(reply, { strictRequestOnly = false } = {}) {
  /** @type {any[]} */
  const sent = [];
  return {
    sent,
    /** @param {object} frame */
    async request(frame) {
      sent.push(frame);
      return reply;
    },
    /** @param {object} frame */
    send(frame) {
      if (strictRequestOnly) throw new Error("unexpected send() call");
      sent.push(frame);
    },
    subscribe() {
      if (strictRequestOnly) throw new Error("unexpected subscribe() call");
      return () => {};
    },
  };
}

/**
 * chunk (send + subscribe push 集約) op 用 mock client。
 * subscribe(key, fn) でハンドラを登録し、テスト側から push(key, msg) で疑似配信する。
 *
 * @param {{ strictPushOnly?: boolean }} [opts]
 *        strictPushOnly: request が呼ばれたら throw (push 系 op が誤って request 経路に
 *        入っていないことを検知する)。
 */
export function chunkMockClient({ strictPushOnly = false } = {}) {
  /** @type {any[]} */
  const sent = [];
  /** @type {Map<string, Set<Function>>} */
  const subs = new Map();
  return {
    sent,
    subs,
    /** @param {object} frame */
    async request(frame) {
      if (strictPushOnly) throw new Error("unexpected request() call");
      sent.push(frame);
    },
    /** @param {object} frame */
    send(frame) {
      sent.push(frame);
    },
    /**
     * @param {string} key dispatch key (`${action}:${op}`)
     * @param {Function} fn
     */
    subscribe(key, fn) {
      let set = subs.get(key);
      if (!set) {
        set = new Set();
        subs.set(key, set);
      }
      set.add(fn);
      return () => set.delete(fn);
    },
    /**
     * テスト用: 指定 key の購読者全員に push を流す。
     * @param {string} key
     * @param {unknown} msg
     */
    push(key, msg) {
      const set = subs.get(key);
      if (set) for (const fn of [...set]) fn(msg);
    },
    /**
     * テスト用: 指定 key に生きた購読があるか。
     * @param {string} key
     */
    hasSub(key) {
      const set = subs.get(key);
      return !!set && set.size > 0;
    },
  };
}
