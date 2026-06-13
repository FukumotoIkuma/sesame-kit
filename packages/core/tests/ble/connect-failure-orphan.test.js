// P1-1 / P1-2: BLE 接続失敗時の孤児 Promise unhandledRejection 防止テスト。
//
// 問題: transport.connect() が reject した場合、connect()/register() が生成した loginPromise /
//   readyPromise が孤児になり、後続の _failAllPending() や 8 秒タイマが
//   その孤児を reject したとき unhandledRejection が発生し CLI/デーモン/ライブラリ利用者の
//   プロセスが落ちていた (R3:BUG-01 / P1-1)。
//
// P1-2: OS2 session の _sendPlain/_sendCipher が transport.write の reject を握っておらず、
//   write 失敗時に unhandledRejection が発生していた (R3:BUG-02 / P1-2)。
//
// 検証方法:
//   - process.on("unhandledRejection") スパイを登録して不発火を確認する。
//   - fake timer (vi.useFakeTimers) で 9 秒進め、タイマが孤児 Promise の reject を
//     トリガしても unhandledRejection が起きないことを確認する。
//
// 「失敗 transport ヘルパ」: connect が throw、write が Promise.reject の最小 mock。
// 全 4 経路 (OS3 connect/register + OS2 connect/register) + ファサード SesameBle.use を網羅。

import { describe, it, expect, vi, afterEach } from "vitest";
import { Buffer } from "node:buffer";
import { createECDH } from "node:crypto";

import { SesameBleSession } from "../../src/ble/session.js";
import { SesameOS2BleSession } from "../../src/ble/os2/session.js";
import { SesameBle } from "../../src/ble/index.js";

// ---- 共通失敗 transport ヘルパ ----

/**
 * connect が必ず throw する失敗 transport。
 * P1-1 の「圏外デバイス / Bluetooth OFF / scan timeout」相当のモック。
 * @param {Error|null} [writeErr] 指定すると write が Promise.reject するよう追加 (P1-2 用)。
 * @returns {import("../../src/ble/session.js").BleTransport}
 */
function makeFailConnectTransport(writeErr = null) {
  return {
    async connect() { throw new Error("nope"); },
    write: writeErr
      ? () => Promise.reject(writeErr)
      : () => undefined,
    async disconnect() {},
  };
}

/** OS2 login まで通す最小 mock (ssmPublicKey 生成ヘルパ)。 */
function makeSsmPublicKey() {
  const kp = createECDH("prime256v1");
  kp.generateKeys();
  return kp.getPublicKey().subarray(1); // 先頭 0x04 を除いた 64B
}

// ---- unhandledRejection スパイのセットアップ ----

/** process.on("unhandledRejection") を登録して不発火を確認するためのスパイ。 */
function setupUnhandledRejectionSpy() {
  const spy = vi.fn();
  process.on("unhandledRejection", spy);
  return {
    spy,
    teardown() { process.off("unhandledRejection", spy); },
  };
}

/** イベントループを 1 tick 以上回して pending microtask を flush する。 */
async function nextTick(n = 5) {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

// ---- OS3 SesameBleSession ----

describe("P1-1: OS3 SesameBleSession.connect() — transport 失敗時に unhandledRejection が出ない", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("connect が throw → 呼び出し元への単一 reject のみ、unhandledRejection 0 件", async () => {
    // 導出元: NobleTransport.connect() が reject する経路 (圏外 / BT OFF / scan timeout)。
    const { spy, teardown } = setupUnhandledRejectionSpy();
    try {
      const session = new SesameBleSession({
        transport: makeFailConnectTransport(),
        secretKey: Buffer.alloc(16, 0x42),
      });
      const err = await session.connect().then(() => null, (e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/nope/);

      // fake timer で LOGIN_TIMEOUT_MS (8s) + 1s 進めて孤児タイマが発火してもスパイ不発火を確認。
      vi.useFakeTimers();
      vi.advanceTimersByTime(9_000);
      vi.useRealTimers();
      await nextTick();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      teardown();
    }
  });
});

describe("P1-1: OS3 SesameBleSession.register() — transport 失敗時に unhandledRejection が出ない", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("connect が throw → 呼び出し元への単一 reject のみ、unhandledRejection 0 件", async () => {
    // 導出元: NobleTransport.connect() が reject する経路 (register モード)。
    const { spy, teardown } = setupUnhandledRejectionSpy();
    try {
      const session = new SesameBleSession({
        transport: makeFailConnectTransport(),
        // secretKey なし = 工場出荷 (register 用)
      });
      const err = await session.register({ deviceUUID: "00000000-0000-0000-0000-000000000001" }).then(() => null, (e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/nope/);

      vi.useFakeTimers();
      vi.advanceTimersByTime(9_000);
      vi.useRealTimers();
      await nextTick();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      teardown();
    }
  });
});

// ---- OS2 SesameOS2BleSession ----

describe("P1-1: OS2 SesameOS2BleSession.connect() — transport 失敗時に unhandledRejection が出ない", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("connect が throw → 呼び出し元への単一 reject のみ、unhandledRejection 0 件", async () => {
    // 導出元: NobleTransport.connect() が reject する経路 (OS2)。
    const { spy, teardown } = setupUnhandledRejectionSpy();
    try {
      const session = new SesameOS2BleSession({
        transport: makeFailConnectTransport(),
        secretKey: Buffer.alloc(16, 0x33),
        keyIndex: Buffer.from("0000", "hex"),
        ssmPublicKey: makeSsmPublicKey(),
      });
      const err = await session.connect().then(() => null, (e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/nope/);

      vi.useFakeTimers();
      vi.advanceTimersByTime(9_000);
      vi.useRealTimers();
      await nextTick();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      teardown();
    }
  });
});

describe("P1-1: OS2 SesameOS2BleSession.register() — transport 失敗時に unhandledRejection が出ない", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("connect が throw → 呼び出し元への単一 reject のみ、unhandledRejection 0 件", async () => {
    // 導出元: NobleTransport.connect() が reject する経路 (OS2 register モード)。
    const { spy, teardown } = setupUnhandledRejectionSpy();
    try {
      // secretKey なし = 工場出荷
      const session = new SesameOS2BleSession({
        transport: makeFailConnectTransport(),
      });
      const err = await session.register({
        deviceUUID: "00000000-0000-0000-0000-000000000002",
        registerServer: async () => ({ sig1: "AAAA", serverToken: "BBBB", sesamePublicKey: "CCCC" }),
      }).then(() => null, (e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/nope/);

      vi.useFakeTimers();
      vi.advanceTimersByTime(9_000);
      vi.useRealTimers();
      await nextTick();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      teardown();
    }
  });
});

// ---- ファサード SesameBle.use ----

describe("P1-1: SesameBle.use — transport 失敗時に unhandledRejection が出ない", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("SesameBle.use の transport connect 失敗 → 単一 reject、unhandledRejection 0 件", async () => {
    // 導出元: セクション「影響②: @sesame-kit/core 利用者が SesameBle.use() しただけで
    //   利用者のプロセスが落ちる」(R3:BUG-01)。
    const { spy, teardown } = setupUnhandledRejectionSpy();
    try {
      const err = await SesameBle.use(
        { secretKey: Buffer.alloc(16, 0x42), transport: makeFailConnectTransport() },
        async () => {},
      ).then(() => null, (e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/nope/);

      vi.useFakeTimers();
      vi.advanceTimersByTime(9_000);
      vi.useRealTimers();
      await nextTick();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      teardown();
    }
  });
});

// ---- P1-2: OS2 _sendPlain/_sendCipher の write 失敗で unhandledRejection が出ない ----
//
// OS2 _writeSeg() のテスト戦略:
//   (a) write: () => Promise.reject(...) の mock で OS2 session を構築し、
//       initial 受信 → login 送信 (_sendPlain → _writeSeg) の後 onDisconnect で
//       loginWaiter を解放する。unhandledRejection スパイが不発火であることを確認。
//   (b) login 後のコマンド送信 (_sendCipher → _writeSeg) でも同様に確認。
//
// 既存の DisconnectableOS2Mock (os2-robustness.test.js) を参考に、SegmentAssembler で
// セグメントを組み立てて login フレームを判定する。

import { SegmentAssembler } from "../../src/ble/protocol.js";
import { OP as OS2_OP, ITEM as OS2_ITEM, SEG as OS2_SEG } from "../../src/ble/os2/protocol.js";

/**
 * OS2 login まで通す最小 mock。write は login 以外を reject させることができる。
 * SegmentAssembler でセグメントを組み立て、SYNC+LOGIN を判定してから login 応答を返す。
 * 導出元: DisconnectableOS2Mock (packages/core/tests/ble/os2-robustness.test.js) と同型。
 */
class OS2MinimalMock {
  /**
   * @param {{ token: Buffer, rejectCipherWrite?: boolean }} opts
   *   rejectCipherWrite: true なら CIPHERTEXT write (コマンド送信) を reject する。
   */
  constructor({ token, rejectCipherWrite = false }) {
    this._token = token;
    this._rejectCipherWrite = rejectCipherWrite;
    this._asm = new SegmentAssembler();
    /** @type {((b:Buffer)=>void)|null} */
    this._onPacket = null;
    /** @type {((r:any)=>void)|null} */
    this._onDisconnect = null;
  }

  async connect(onPacket, onDisconnect) {
    this._onPacket = onPacket;
    this._onDisconnect = onDisconnect;
    // initial publish: [PUBLISH(8), INITIAL(14), ...token4]
    this._sendPlain(Buffer.concat([Buffer.from([OS2_OP.PUBLISH, OS2_ITEM.INITIAL]), this._token]));
  }

  write(seg) {
    const a = this._asm.feed(Buffer.from(seg));
    if (!a) return undefined;
    if (a.type === OS2_SEG.PLAINTEXT && a.data[0] === OS2_OP.SYNC && a.data[1] === OS2_ITEM.LOGIN) {
      // PLAINTEXT login フレーム: login response を返す (DisconnectableOS2Mock と同形)。
      const lr = Buffer.alloc(28);
      lr.writeUInt32LE(Math.floor(Date.now() / 1000), 0);
      lr[27] = 0x02; // locked
      this._sendPlain(Buffer.concat([
        Buffer.from([OS2_OP.RESPONSE, OS2_ITEM.LOGIN, OS2_OP.SYNC, 0x00]), lr,
      ]));
      return undefined;
    }
    // CIPHERTEXT (コマンド送信): reject させてもよい。
    if (a.type === OS2_SEG.CIPHERTEXT && this._rejectCipherWrite) {
      return Promise.reject(new Error("link lost after login"));
    }
    return undefined;
  }

  async disconnect() {}

  /** onDisconnect を外部から発火して fail-fast をトリガする。 */
  triggerLinkLost(reason = "link-lost") { this._onDisconnect?.(reason); }

  _sendPlain(frame) {
    const h = (OS2_SEG.PLAINTEXT << 1) | 1;
    this._onPacket?.(Buffer.concat([Buffer.from([h]), frame]));
  }
}

/**
 * OS2 connect (write が常に reject) の最小 mock。
 * initial を送るが login 応答の write が reject する → loginWaiter は onDisconnect で解放。
 */
class OS2WriteRejectMock {
  /** @param {Buffer} token */
  constructor(token) {
    this._token = token;
    /** @type {((b:Buffer)=>void)|null} */
    this._onPacket = null;
    /** @type {((r:any)=>void)|null} */
    this._onDisconnect = null;
  }

  async connect(onPacket, onDisconnect) {
    this._onPacket = onPacket;
    this._onDisconnect = onDisconnect;
    // initial publish
    const h = (OS2_SEG.PLAINTEXT << 1) | 1;
    const frame = Buffer.concat([Buffer.from([OS2_OP.PUBLISH, OS2_ITEM.INITIAL]), this._token]);
    onPacket(Buffer.concat([Buffer.from([h]), frame]));
  }

  write() { return Promise.reject(new Error("link lost")); }

  async disconnect() {}

  triggerLinkLost(reason = "link-lost") { this._onDisconnect?.(reason); }
}

describe("P1-2: OS2 SesameOS2BleSession._writeSeg() — write reject を握り unhandledRejection が出ない", () => {
  it("login 送信の write reject で unhandledRejection 0 件 (onDisconnect で loginWaiter を解放)", async () => {
    // 導出元: NobleTransport.write() がリトライ枯渇で reject する経路 (P1-2 / R3:BUG-02)。
    // OS2 login は _sendPlain → _writeSeg → transport.write と流れる。
    // write が reject しても _writeSeg が握るため unhandledRejection は出ない。
    // loginWaiter は onDisconnect 経由の _failAllPending で解放する。
    const { spy, teardown } = setupUnhandledRejectionSpy();
    try {
      const mock = new OS2WriteRejectMock(Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]));
      const session = new SesameOS2BleSession({
        transport: mock,
        secretKey: Buffer.alloc(16, 0x33),
        keyIndex: Buffer.from("0000", "hex"),
        ssmPublicKey: makeSsmPublicKey(),
      });

      // connect() を開始: initial 受信 → login 送信 (write reject) → loginWaiter 待ち。
      const connectPromise = session.connect();

      // microtask を flush: write の reject が _writeSeg に届く。
      await nextTick(5);

      // unhandledRejection はまだ出ていない (write reject は _writeSeg が握る)。
      expect(spy).not.toHaveBeenCalled();

      // onDisconnect を発火して loginWaiter を解放する (NobleTransport が write 失敗後に呼ぶ経路と等価)。
      mock.triggerLinkLost("write-failed");
      const err = await connectPromise.then(() => null, (e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/link lost|リンク/);

      // 最後まで unhandledRejection は出ない。
      await nextTick(5);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      teardown();
    }
  });

  it("request 中のコマンド送信 write reject で unhandledRejection 0 件 (onDisconnect で pending 解放)", async () => {
    // 導出元: login 後にコマンド送信 (_sendCipher → _writeSeg) が reject → 握り潰し。
    // pending の解放は onDisconnect 経由 (NobleTransport が write 失敗後に onDisconnect を呼ぶ)。
    const { spy, teardown } = setupUnhandledRejectionSpy();
    try {
      // login は成功させ、コマンド送信のみ reject する mock。
      const mock = new OS2MinimalMock({
        token: Buffer.from([0x11, 0x22, 0x33, 0x44]),
        rejectCipherWrite: false, // まず login まで正常通過させる
      });

      const session = new SesameOS2BleSession({
        transport: mock,
        secretKey: Buffer.alloc(16, 0x33),
        keyIndex: Buffer.from("0000", "hex"),
        ssmPublicKey: makeSsmPublicKey(),
      });
      await session.connect();
      expect(session.isLoggedIn).toBe(true);

      // コマンド送信 (write が reject する): _sendCipher → _writeSeg が握る。
      mock._rejectCipherWrite = true;

      // request は pending に入るがコマンド write が reject する (60s timeout)。
      const reqPromise = session.request(OS2_OP.ASYNC, OS2_ITEM.UNLOCK, Buffer.alloc(0), { timeoutMs: 60_000 });

      // write reject の microtask を flush する。
      await nextTick(5);

      // unhandledRejection が出ていないことを確認 (write reject は _writeSeg で握られている)。
      expect(spy).not.toHaveBeenCalled();

      // onDisconnect を発火して pending を解放 (正規の fail-fast 経路)。
      mock.triggerLinkLost("write-link-lost");
      const err = await reqPromise.then(() => null, (e) => e);
      expect(err).toBeInstanceOf(Error);

      // 最後まで unhandledRejection は出ない。
      await nextTick(5);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      teardown();
    }
  });
});
