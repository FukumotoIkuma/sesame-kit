// BLE 接続堅牢性 (切断伝播 / write リトライ / fail-fast) の単体テスト。
// SDK CHSesameOS3.kt:228-263 (onConnectionStateChange) / :321-346 (transmit リトライ→disconnect) の移植検証。
// 実機 (noble) は使わず、(1) session には onDisconnect を発火できる mock transport を注入し、
// (2) NobleTransport には writeAsync を差し替えた fake peripheral/characteristic を注入する。
import { describe, it, expect, vi } from "vitest";
import { Buffer } from "node:buffer";
import { SesameBleSession } from "../../src/ble/session.js";
import { NobleTransport } from "../../src/ble/transport.js";
import {
  deriveSessionKey, ccmEncrypt, ccmDecrypt, splitSegments, SegmentAssembler,
  OP, ITEM, SEG,
} from "../../src/ble/protocol.js";

const SECRET = "0123456789abcdef0123456789abcdef";

// ---- (1) session の fail-fast: transport が onDisconnect を呼ぶと pending が即 reject される ----

/** onDisconnect を保持して任意に発火できる、login まで通る最小 mock SESAME。 */
class DisconnectableMock {
  constructor() {
    this.secret = Buffer.from(SECRET, "hex");
    this.token = Buffer.from([1, 2, 3, 4]);
    this.key = deriveSessionKey(this.secret, this.token);
    this.asm = new SegmentAssembler();
    this.encCount = 0;
    this.decCount = 0;
    this.onPacket = null;
    this.onDisconnect = null;
    this.disconnected = false;
    this.respondToCommands = false; // false の間 command は応答しない (pending を残す)
  }
  connect(onPacket, onDisconnect) {
    this.onPacket = onPacket;
    this.onDisconnect = onDisconnect;
    this._emitPlain(Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.INITIAL]), this.token]));
    return Promise.resolve();
  }
  write(seg) {
    const a = this.asm.feed(Buffer.from(seg));
    if (!a) return;
    let frame;
    if (a.type === SEG.CIPHERTEXT) { frame = ccmDecrypt(this.key, this.decCount, this.token, a.data); this.decCount += 1; }
    else frame = a.data;
    if (frame[0] === ITEM.LOGIN) {
      this._emitCipher(Buffer.from([OP.RESPONSE, ITEM.LOGIN, 0, 0, 0, 0, 0]));
    }
    // command には respondToCommands=false の間は応答しない → pending が残る。
  }
  disconnect() { this.disconnected = true; return Promise.resolve(); }
  /** 外部から「リンクが切れた」を模す。 */
  triggerLinkLost(reason = "peer") { if (this.onDisconnect) this.onDisconnect(reason); }
  _emitPlain(frame) { for (const s of splitSegments(frame, SEG.PLAINTEXT)) this.onPacket(s); }
  _emitCipher(frame) { const ct = ccmEncrypt(this.key, this.encCount, this.token, frame); this.encCount += 1; for (const s of splitSegments(ct, SEG.CIPHERTEXT)) this.onPacket(s); }
}

describe("session fail-fast on transport disconnect", () => {
  it("onDisconnect で進行中の request が即 reject される (timeout 宙づりを防ぐ)", async () => {
    const dev = new DisconnectableMock();
    const session = new SesameBleSession({ transport: dev, secretKey: SECRET });
    await session.connect();
    expect(session.isLoggedIn).toBe(true);

    // 応答が返らない request を投げ、長い timeout を持たせる (切断で割れることを見たい)。
    const p = session.request(ITEM.LOCK, Buffer.alloc(0), { timeoutMs: 60_000 });
    // リンク断を発火 → 待たずに reject されるはず。
    dev.triggerLinkLost("out-of-range");
    const err = await p.then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/link lost|リンク/);
    // セッション状態も倒れている (再 connect は新インスタンス前提)。
    expect(session.isLoggedIn).toBe(false);
  });

  it("connect 中 (login 待ち) の onDisconnect は login 待機者を reject する", async () => {
    // login 応答を返さない transport: initial だけ出して以降沈黙 → connect は loginWaiter で待つ。
    const dev = {
      onDisconnect: null,
      connect(onPacket, onDisconnect) {
        this.onDisconnect = onDisconnect;
        // initial を出さない = ready/login どちらの待機者も残す。すぐ切断する。
        setTimeout(() => onDisconnect("immediate"), 0);
        return Promise.resolve();
      },
      write() {},
      disconnect() { return Promise.resolve(); },
    };
    const session = new SesameBleSession({ transport: dev, secretKey: SECRET });
    const err = await session.connect().then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/link lost|リンク/);
  });
});

// ---- (2) NobleTransport の write リトライ: writeAsync 失敗→有限回再送→全失敗で onDisconnect ----

/** noble peripheral/characteristic の最小 fake。writeAsync の挙動を注入で差し替える。 */
function makeFakeTransport({ writeImpl }) {
  const tr = new NobleTransport({ debug: false });
  // connect を経ずに write 経路だけ検証するため、必要な内部状態を直接差し込む。
  tr._writeChar = { writeAsync: writeImpl };
  return tr;
}

describe("NobleTransport write retry (SDK CHSesameOS3 transmit 相当)", () => {
  it("一時失敗は数回リトライして最終的に成功する", async () => {
    let calls = 0;
    const tr = makeFakeTransport({
      writeImpl: vi.fn(async () => { calls++; if (calls < 3) throw new Error("EAGAIN"); }),
    });
    await tr.write(Buffer.from([1, 2, 3]));
    expect(calls).toBe(3); // 2 回失敗 → 3 回目で成功
    expect(tr._disconnected).toBe(false);
  });

  it("全リトライ失敗で onDisconnect を 1 回発火し、最後のエラーを投げる", async () => {
    const onDisconnect = vi.fn();
    const tr = makeFakeTransport({ writeImpl: vi.fn(async () => { throw new Error("link down"); }) });
    tr._onDisconnect = onDisconnect;
    const err = await tr.write(Buffer.from([9])).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/link down/);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(tr._disconnected).toBe(true);
    // 切断後の write は再送せず即エラー。
    const err2 = await tr.write(Buffer.from([0])).then(() => null, (e) => e);
    expect(err2).toBeInstanceOf(Error);
  });
});
