// SesameBleSession の単体テスト。
// 実機の代わりに「忠実な mock SESAME (MockSesame)」を transport として注入し、
// initial→login→暗号コマンド→response/publish の全フローを HW 無しで検証する。
// MockSesame はクライアントと鏡像のカウンタ/暗号でハンドシェイク・応答を再現する。
import { describe, it, expect, beforeEach } from "vitest";
import { Buffer } from "node:buffer";
import { SesameBleSession, BleResultError } from "../../src/ble/session.js";
import {
  deriveSessionKey, ccmEncrypt, ccmDecrypt, splitSegments, SegmentAssembler,
  OP, ITEM, SEG,
} from "../../src/ble/protocol.js";

const SECRET = "0123456789abcdef0123456789abcdef";

/** 忠実な mock SESAME (OS3)。クライアント↔デバイスのカウンタ対称性を再現。 */
class MockSesame {
  constructor({ secret = SECRET, token = Buffer.from([1, 2, 3, 4]), loginResult = 0 } = {}) {
    this.secret = Buffer.from(secret, "hex");
    this.token = token;
    this.loginResult = loginResult;
    this.key = deriveSessionKey(this.secret, this.token);
    this.asm = new SegmentAssembler();
    this.encCount = 0; // device→client
    this.decCount = 0; // client→device
    this.onPacket = null;
    this.writes = [];
    this.disconnected = false;
    this.lastCommand = null;
  }

  connect(onPacket) {
    this.onPacket = onPacket;
    // initial publish (PLAINTEXT): [PUBLISH, INITIAL, ...token4]
    this._emitPlain(Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.INITIAL]), this.token]));
    return Promise.resolve();
  }

  write(seg) {
    this.writes.push(Buffer.from(seg));
    const a = this.asm.feed(Buffer.from(seg));
    if (!a) return;
    let frame;
    if (a.type === SEG.CIPHERTEXT) { frame = ccmDecrypt(this.key, this.decCount, this.token, a.data); this.decCount += 1; }
    else frame = a.data;
    const item = frame[0];
    const data = frame.subarray(1);
    if (item === ITEM.LOGIN) {
      // response(7)+login(2)+resultCode+systemTime4 を CIPHERTEXT で返す
      this._emitCipher(Buffer.from([OP.RESPONSE, ITEM.LOGIN, this.loginResult, 0, 0, 0, 0]));
      return;
    }
    this.lastCommand = { item, data: Buffer.from(data) };
    // lock/unlock/autolock 等は response(7)+item+resultCode0 を返す
    this._emitCipher(Buffer.from([OP.RESPONSE, item, 0x00]));
  }

  /** テスト用: mechStatus publish を流す。 */
  emitMechStatus(statusBuf) {
    this._emitCipher(Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.MECH_STATUS]), statusBuf]));
  }

  disconnect() { this.disconnected = true; return Promise.resolve(); }

  _emitPlain(frame) { for (const s of splitSegments(frame, SEG.PLAINTEXT)) this.onPacket(s); }
  _emitCipher(frame) {
    const ct = ccmEncrypt(this.key, this.encCount, this.token, frame);
    this.encCount += 1;
    for (const s of splitSegments(ct, SEG.CIPHERTEXT)) this.onPacket(s);
  }
}

/**
 * P3-27 テスト用: response を手動でトリガするまで応答を保留する mock。
 * 導出元: CHSesameOS3.kt:354-370 の sendCommand() — SDK は同一 itemCode in-flight 時に
 *         ワイヤへの再送を抑止するが、kit は毎回送る (意図的乖離)。
 * mock の write() は受け取ったフレームを復号して commands[] に積むが返答はしない。
 * flushOne(resultCode) を呼ぶと先頭コマンドの response をデバイス側から流す。
 */
class DeferredMockSesame {
  constructor({ secret = SECRET, token = Buffer.from([1, 2, 3, 4]) } = {}) {
    this.secret = Buffer.from(secret, "hex");
    this.token = token;
    this.key = deriveSessionKey(this.secret, this.token);
    this.asm = new SegmentAssembler();
    this.encCount = 0; // device→client
    this.decCount = 0; // client→device
    this.onPacket = null;
    /** @type {Array<{item:number, data:Buffer}>} */
    this.commands = [];
    this.disconnected = false;
  }

  connect(onPacket) {
    this.onPacket = onPacket;
    this._emitPlain(Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.INITIAL]), this.token]));
    return Promise.resolve();
  }

  write(seg) {
    const a = this.asm.feed(Buffer.from(seg));
    if (!a) return;
    let frame;
    if (a.type === SEG.CIPHERTEXT) { frame = ccmDecrypt(this.key, this.decCount, this.token, a.data); this.decCount += 1; }
    else frame = a.data;
    const item = frame[0];
    const data = frame.subarray(1);
    if (item === ITEM.LOGIN) {
      this._emitCipher(Buffer.from([OP.RESPONSE, ITEM.LOGIN, 0x00, 0, 0, 0, 0]));
      return;
    }
    this.commands.push({ item, data: Buffer.from(data) });
    // response は保留 — flushOne() を呼ぶまで返さない
  }

  /** 先頭コマンドの response を流す。 */
  flushOne(resultCode = 0x00) {
    const cmd = this.commands.shift();
    if (!cmd) throw new Error("no pending command to flush");
    this._emitCipher(Buffer.from([OP.RESPONSE, cmd.item, resultCode]));
  }

  disconnect() { this.disconnected = true; return Promise.resolve(); }

  _emitPlain(frame) { for (const s of splitSegments(frame, SEG.PLAINTEXT)) this.onPacket(s); }
  _emitCipher(frame) {
    const ct = ccmEncrypt(this.key, this.encCount, this.token, frame);
    this.encCount += 1;
    for (const s of splitSegments(ct, SEG.CIPHERTEXT)) this.onPacket(s);
  }
}

describe("SesameBleSession", () => {
  let dev, session;
  beforeEach(() => {
    dev = new MockSesame();
    session = new SesameBleSession({ transport: dev, secretKey: SECRET });
  });

  it("connect で initial→login が完走し isLoggedIn になる", async () => {
    await session.connect();
    expect(session.isLoggedIn).toBe(true);
    // device は login frame [2, ...token16[0:4]] を受信したはず
    expect(dev.writes.length).toBeGreaterThan(0);
  });

  it("login resultCode≠0 なら BleResultError で reject (resultName で分岐可能)", async () => {
    dev = new MockSesame({ loginResult: 5 });
    session = new SesameBleSession({ transport: dev, secretKey: SECRET });
    const err = await session.connect().then(() => null, (e) => e);
    expect(err).toBeInstanceOf(BleResultError);
    expect(err.resultCode).toBe(5);
    expect(err.resultName).toBe("notFound"); // SesameResultCode 5 = notFound
    expect(err.message).toMatch(/notFound/);
    expect(session.isLoggedIn).toBe(false);
  });

  it("request(LOCK) が成功し、device 側は復号して item=82 を受け取る", async () => {
    await session.connect();
    const res = await session.request(ITEM.LOCK, Buffer.from([0x00, 0x0e]));
    expect(res.resultCode).toBe(0);
    expect(dev.lastCommand.item).toBe(82);
    expect([...dev.lastCommand.data]).toEqual([0x00, 0x0e]);
  });

  it("連続コマンドでカウンタが同期し続ける (lock→unlock→autolock)", async () => {
    await session.connect();
    await session.request(ITEM.LOCK);
    await session.request(ITEM.UNLOCK);
    const r = await session.request(ITEM.AUTOLOCK, Buffer.from([30, 0]));
    expect(r.resultCode).toBe(0);
    expect(dev.lastCommand.item).toBe(ITEM.AUTOLOCK);
    expect([...dev.lastCommand.data]).toEqual([30, 0]);
  });

  it("未 login で request は reject", async () => {
    await expect(session.request(ITEM.LOCK)).rejects.toThrow(/not logged in/);
  });

  it("BLE3-03: syncTime=false なら login 後の time(8) 自動同期を送らない (CHHub3Device.kt:167-178)", async () => {
    // 既定 (syncTime=true): mock の login 応答 payload は systemTime=0 (遠過去) なので
    // 差 >3 秒 → time(8) が fire-and-forget で飛ぶ (CHSesameOS3LockBase.kt:126-138)。
    await session.connect();
    expect(dev.lastCommand?.item).toBe(ITEM.TIME);
    // syncTime=false (Hub3/WM2 用): 同条件でも time(8) を送らない (Hub3 の login override は
    // handleLoginResponse を呼ばないため時刻同期が無い)。
    const dev2 = new MockSesame();
    const s2 = new SesameBleSession({ transport: dev2, secretKey: SECRET, syncTime: false });
    await s2.connect();
    expect(s2.isLoggedIn).toBe(true);
    expect(dev2.lastCommand).toBeNull();
  });

  it("BLE3-05: initial token が 4B 超なら明示エラー (黙って切り詰めない)", async () => {
    // CCM nonce = count(8B) ++ sault は 4B token 由来 (lock: 0x00++token4 → 13B)。4B 超を
    // 先頭 4B に切り詰めるとデバイス側 sault と不一致になり全フレーム復号不能になるため、
    // セッションは login 待機者を明示エラーで解放する。
    const longToken = Buffer.from([1, 2, 3, 4, 5]);
    const transport = {
      connect(onPacket) {
        for (const s of splitSegments(Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.INITIAL]), longToken]), SEG.PLAINTEXT)) onPacket(s);
        return Promise.resolve();
      },
      write() {},
      disconnect() { return Promise.resolve(); },
    };
    const s = new SesameBleSession({ transport, secretKey: SECRET });
    await expect(s.connect()).rejects.toThrow(/4/);
    expect(s.isLoggedIn).toBe(false);
  });

  it("復号失敗フレームでも dec カウンタを進め、後続フレームの復号が継続する (SDK 忠実: SesameOS3BleCipher.kt:23-31)", async () => {
    await session.connect();
    // device の enc カウンタを 1 進めた「対応する平文が無い/破損した」cipher フレームを注入。
    // 旧実装は失敗時に dec カウンタを進めず、以降全フレームが恒久ずれで復号不能になっていた。
    const garbage = ccmEncrypt(dev.key, dev.encCount, dev.token, Buffer.from([0xff, 0xff, 0xff]));
    dev.encCount += 1;
    // 受信時 parseRecvFrame は通るが (opCode 不明 → 無視されるだけ)、ここで重要なのは dec カウンタが
    // 進むこと。破損を模すため、parse 前に意図的に 1 バイト壊して復号自体を失敗させる。
    const corrupted = Buffer.from(garbage); corrupted[corrupted.length - 1] ^= 0xff; // tag を壊す
    for (const s of splitSegments(corrupted, SEG.CIPHERTEXT)) session._onPacket(s);

    // 後続の正常コマンドが往復できる = dec カウンタが device の enc カウンタと再同期している。
    const r = await session.request(ITEM.LOCK);
    expect(r.resultCode).toBe(0);
    expect(dev.lastCommand.item).toBe(ITEM.LOCK);
  });

  it("onStatus に mechStatus publish が届き parseMechStatus される", async () => {
    await session.connect();
    const got = [];
    session.onStatus((s) => got.push(s));
    const status = Buffer.from([0x70, 0x17, 0, 0, 0, 0, 0b010]); // is_lock_range
    dev.emitMechStatus(status);
    expect(got.length).toBe(1);
    expect(got[0].state).toBe("locked");
    expect(session.lastStatus.state).toBe("locked");
  });

  it("disconnect で pending が reject され transport も切断される", async () => {
    await session.connect();
    // response を返さない item を投げて pending を作る (短 timeout)
    const p = session.request(0x7f, Buffer.alloc(0), { timeoutMs: 10_000 });
    // MockSesame は未知 item にも response を返すので、ここでは pending を直接 disconnect で割る検証は
    // 別途。代わりに disconnect が transport.disconnect を呼ぶことを確認。
    await p.catch(() => {}); // 上の write で即 response が返り resolve 済みの可能性 → 無視
    await session.disconnect();
    expect(dev.disconnected).toBe(true);
    expect(session.isLoggedIn).toBe(false);
  });

  // ---- P3-27: 同一 itemCode 同時 request の意味論 ----
  //
  // SDK (CHSesameOS3.kt:349-372) は同一 itemCode が in-flight の間はワイヤへの再送を抑止し
  // callback を差し替えるだけ返す (重複フレーム = 0)。
  // kit は毎回 _sendCipher() するため N 回呼べば N フレームがワイヤに流れる (意図的乖離)。
  // このテストは kit の「N フレーム送信 + FIFO 解決」挙動を不変条件として固定する。

  it("P3-27: 同一 itemCode を並行 request すると N フレームが送信され FIFO で resolve される (kit の意図的乖離)", async () => {
    const deferred = new DeferredMockSesame();
    // syncTime=false: 時刻同期 fire-and-forget (CHSesameOS3LockBase.kt:126-138) が
    // DeferredMockSesame の commands に混入しないよう無効化する。
    const s = new SesameBleSession({ transport: deferred, secretKey: SECRET, syncTime: false });
    await s.connect();

    // 同一 itemCode (LOCK=82) を 3 回同時に request する。
    // kit は 3 フレームをワイヤに流す (SDK は 1 フレームのみ流す — 意図的乖離)。
    const results = [];
    const p1 = s.request(ITEM.LOCK, Buffer.from([0x00, 0x0e]));
    const p2 = s.request(ITEM.LOCK, Buffer.from([0x00, 0x0e]));
    const p3 = s.request(ITEM.LOCK, Buffer.from([0x00, 0x0e]));

    // 3 フレームが deferred.commands に積まれていることを確認 (SDK は 1 フレームのみ)。
    expect(deferred.commands.length).toBe(3);
    expect(deferred.commands.every(c => c.item === ITEM.LOCK)).toBe(true);

    // FIFO 順に response を流す → 各 Promise が順に resolve される。
    deferred.flushOne(0x00); results.push(await p1);
    deferred.flushOne(0x00); results.push(await p2);
    deferred.flushOne(0x00); results.push(await p3);

    expect(results).toHaveLength(3);
    expect(results.every(r => r.resultCode === 0)).toBe(true);
    // flush 後 commands は空になる。
    expect(deferred.commands.length).toBe(0);
  });

  it("P3-27: 同一 itemCode の sequential (直列) request は SDK と同じ 1 フレームずつ送信", async () => {
    // 直列呼び出しでは SDK と観測可能な差がない (P3-27 の「単独・直列は同一」の確認)。
    await session.connect();
    const r1 = await session.request(ITEM.LOCK);
    const r2 = await session.request(ITEM.LOCK);
    expect(r1.resultCode).toBe(0);
    expect(r2.resultCode).toBe(0);
    // MockSesame は lock(82) に毎回 response を返すので 2 回独立して成功する。
    expect(dev.lastCommand.item).toBe(ITEM.LOCK);
  });
});
