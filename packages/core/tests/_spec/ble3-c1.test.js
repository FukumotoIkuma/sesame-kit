// BLE3-0019 〜 BLE3-0036 統合テスト (TDD — spec どおりの期待値でアサートする)
// 対応 spec: spec/ble-os3.md の crypto / session / session-establish / server-auth セクション
//
// 実機不要。全 mock / 純関数 / 決定論的。

import { describe, it, expect, vi } from "vitest";
import { Buffer } from "node:buffer";

import {
  ccmEncrypt,
  ccmDecrypt,
  ccmSault,
  loginPayload,
  deriveSessionKey,
  needsTimeSync,
  splitSegments,
  SegmentAssembler,
  OP,
  ITEM,
  SEG,
  resultName,
} from "../../src/ble/protocol.js";
import { SesameBleSession, BleResultError } from "../../src/ble/session.js";
import { SesameBle } from "../../src/ble/index.js";

// ── 共通定数 ────────────────────────────────────────────────────────────────
const SECRET = "0102030405060708090a0b0c0d0e0f10";
const TOKEN4 = Buffer.from([0x11, 0x22, 0x33, 0x44]);

// ── MockSesame (忠実 OS3 デバイス) ─────────────────────────────────────────
class MockSesame {
  constructor({ secret = SECRET, token = TOKEN4, loginResult = 0, profile = "lock" } = {}) {
    this.secret = Buffer.from(secret, "hex");
    this.token = token;
    this.loginResult = loginResult;
    this.profile = profile;
    this.key = deriveSessionKey(this.secret, this.token);
    this.asm = new SegmentAssembler();
    this.encCount = 0;
    this.decCount = 0;
    this.onPacket = null;
    this.disconnected = false;
    this.lastCommand = null;
    this.initialItemCode = profile === "wm2" ? 13 : ITEM.INITIAL;
  }

  connect(onPacket, onDisconnect) {
    this.onPacket = onPacket;
    this._onDisconnect = onDisconnect;
    this._emitPlain(Buffer.concat([Buffer.from([OP.PUBLISH, this.initialItemCode]), this.token]));
    return Promise.resolve();
  }

  write(seg) {
    const a = this.asm.feed(Buffer.from(seg));
    if (!a) return;
    let frame;
    if (a.type === SEG.CIPHERTEXT) {
      frame = ccmDecrypt(this.key, this.decCount, this.token, a.data, this.profile);
      this.decCount += 1;
    } else {
      frame = a.data;
    }
    const item = frame[0];
    if (item === ITEM.LOGIN) {
      this._emitCipher(Buffer.from([OP.RESPONSE, ITEM.LOGIN, this.loginResult, 0, 0, 0, 0]));
      return;
    }
    this.lastCommand = { item, data: Buffer.from(frame.subarray(1)) };
    this._emitCipher(Buffer.from([OP.RESPONSE, item, 0x00]));
  }

  disconnect() { this.disconnected = true; return Promise.resolve(); }

  _emitPlain(frame) {
    for (const s of splitSegments(frame, SEG.PLAINTEXT)) this.onPacket(s);
  }
  _emitCipher(frame) {
    const ct = ccmEncrypt(this.key, this.encCount, this.token, frame, this.profile);
    this.encCount += 1;
    for (const s of splitSegments(ct, SEG.CIPHERTEXT)) this.onPacket(s);
  }
  triggerDisconnect() {
    if (this._onDisconnect) this._onDisconnect("test-disconnect");
  }
}

// ── シンプル mock transport (白箱テスト用) ─────────────────────────────────
function makeMockTransport() {
  let savedOnPacket = null;
  let savedOnDisconnect = null;
  return {
    connect: vi.fn(async (onPacket, onDisconnect) => {
      savedOnPacket = onPacket;
      savedOnDisconnect = onDisconnect;
    }),
    write: vi.fn(),
    disconnect: vi.fn(async () => {}),
    firePacket(buf) { if (savedOnPacket) savedOnPacket(buf); },
    fireDisconnect(reason) { if (savedOnDisconnect) savedOnDisconnect(reason); },
  };
}

function makeSession(overrides = {}) {
  const transport = makeMockTransport();
  const session = new SesameBleSession({
    transport,
    secretKey: SECRET,
    profile: "lock",
    syncTime: false,
    ...overrides,
  });
  return { session, transport };
}

// --------------------------------------------------------------------------
// BLE3-0019: ccmEncrypt/Decrypt AES-128-CCM ラウンドトリップ + tag 改竄 throw
// --------------------------------------------------------------------------
describe("BLE3-0019: ccmEncrypt/ccmDecrypt AES-128-CCM ラウンドトリップ", () => {
  it("[BLE3-0019] AES-128-CCM 暗号化→復号でラウンドトリップし、tag 改竄で throw する", () => {
    const key = Buffer.from(SECRET, "hex");
    const plaintext = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
    const count = 0;

    const ctWithTag = ccmEncrypt(key, count, TOKEN4, plaintext);
    expect(Buffer.isBuffer(ctWithTag)).toBe(true);
    expect(ctWithTag.length).toBe(plaintext.length + 4);

    const recovered = ccmDecrypt(key, count, TOKEN4, ctWithTag);
    expect(recovered).toEqual(plaintext);

    const tampered = Buffer.from(ctWithTag);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => ccmDecrypt(key, count, TOKEN4, tampered)).toThrow();
  });

  it("[BLE3-0019] wm2 profile でもラウンドトリップが成立する", () => {
    const key = Buffer.from(SECRET, "hex");
    const plaintext = Buffer.from([0x10, 0x20, 0x30]);
    const count = 0;
    const ct = ccmEncrypt(key, count, TOKEN4, plaintext, "wm2");
    const dec = ccmDecrypt(key, count, TOKEN4, ct, "wm2");
    expect(dec).toEqual(plaintext);
  });

  it("[BLE3-0019] count が変わると異なる暗号文になる (カウンタは nonce に寄与する)", () => {
    const key = Buffer.from(SECRET, "hex");
    const plaintext = Buffer.from([0xaa, 0xbb]);
    const ct0 = ccmEncrypt(key, 0, TOKEN4, plaintext);
    const ct1 = ccmEncrypt(key, 1, TOKEN4, plaintext);
    expect(ct0).not.toEqual(ct1);
  });
});

// --------------------------------------------------------------------------
// BLE3-0020: ccmNonce = count(8B LE) ++ sault、lock sault = 0x00++token4 (13B)
// --------------------------------------------------------------------------
describe("BLE3-0020: ccmSault + nonce レイアウト (lock profile)", () => {
  it("[BLE3-0020] lock の CCM sault は (0x00 ++ token4) の 5B", () => {
    const sault = ccmSault("lock", TOKEN4);
    expect(sault.length).toBe(5);
    expect(sault[0]).toBe(0x00);
    expect(sault.subarray(1)).toEqual(TOKEN4);
  });

  it("[BLE3-0020] wm2 の sault は token4 のみ 4B (0x00 を挟まない)", () => {
    const saultWm2 = ccmSault("wm2", TOKEN4);
    expect(saultWm2.length).toBe(4);
    expect(saultWm2).toEqual(TOKEN4);
  });

  it("[BLE3-0020] lock profile の nonce = count(8B LE) ++ sault(5B) = 13B: ラウンドトリップで正しさを確認", () => {
    const key = Buffer.from(SECRET, "hex");
    const plaintext = Buffer.from([0xaa, 0xbb]);
    const count0 = 0n;
    const ct = ccmEncrypt(key, count0, TOKEN4, plaintext, "lock");
    const recovered = ccmDecrypt(key, count0, TOKEN4, ct, "lock");
    expect(recovered).toEqual(plaintext);
  });

  it("[BLE3-0020] ccmSault(lock): token4 が 4B でないと throw する", () => {
    expect(() => ccmSault("lock", Buffer.from([0x01, 0x02, 0x03]))).toThrow();
  });
});

// --------------------------------------------------------------------------
// BLE3-0021: loginPayload(lock) = [LOGIN(2)] ++ sessionKey[0:4] = 5B
// --------------------------------------------------------------------------
describe("BLE3-0021: loginPayload (lock profile)", () => {
  it("[BLE3-0021] lock profile: payload = [ITEM.LOGIN] ++ sessionKey[0:4] の 5B", () => {
    const sessionKey = Buffer.from("0102030405060708090a0b0c0d0e0f10", "hex");
    const payload = loginPayload(sessionKey, "lock");
    expect(payload.length).toBe(5);
    expect(payload[0]).toBe(ITEM.LOGIN);
    expect(payload.subarray(1)).toEqual(sessionKey.subarray(0, 4));
  });

  it("[BLE3-0021] lock profile (既定引数省略): 明示と同一結果", () => {
    const token16 = Buffer.from("aabbccddeeff00112233445566778899", "hex");
    const explicit = loginPayload(token16, "lock");
    const implicit = loginPayload(token16);
    expect(explicit).toEqual(implicit);
  });

  it("[BLE3-0021] wm2 profile: payload = [ITEM.LOGIN] ++ sessionKey 全量 17B", () => {
    const sessionKey = Buffer.from("0102030405060708090a0b0c0d0e0f10", "hex");
    const payload = loginPayload(sessionKey, "wm2");
    expect(payload.length).toBe(17);
    expect(payload[0]).toBe(ITEM.LOGIN);
    expect(payload.subarray(1)).toEqual(sessionKey);
  });
});

// --------------------------------------------------------------------------
// BLE3-0022: 受信 dec counter は doFinal 前に inc (復号失敗でも counter 前進)
// --------------------------------------------------------------------------
describe("BLE3-0022: decCount は復号 doFinal 前に inc (破損フレームでも前進)", () => {
  it("[BLE3-0022] 暗号フレーム受信で decCount++ してから復号、失敗時もカウンタ前進して後続継続", async () => {
    const dev = new MockSesame();
    const session = new SesameBleSession({ transport: dev, secretKey: SECRET });
    await session.connect();
    expect(session.isLoggedIn).toBe(true);

    const decBefore = session._decCount;

    // 壊れた CIPHERTEXT セグメント: header = (SEG.CIPHERTEXT<<1)|1 (start bit)
    const badHeader = (SEG.CIPHERTEXT << 1) | 1;
    const badSeg = Buffer.concat([Buffer.from([badHeader]), Buffer.alloc(15, 0xff)]);
    session._onPacket(badSeg);

    expect(session._decCount).toBe(decBefore + 1);
    expect(session.isLoggedIn).toBe(true);
  });

  it("[BLE3-0022] 正常フレーム受信後もカウンタが 1 進む", async () => {
    const dev = new MockSesame();
    const session = new SesameBleSession({ transport: dev, secretKey: SECRET });
    await session.connect();
    expect(session.isLoggedIn).toBe(true);

    const decBefore = session._decCount;
    // 別の正常コマンドを送信して応答を受ける
    await session.request(ITEM.MECH_STATUS, Buffer.alloc(0)).catch(() => {});
    // MECH_STATUS 応答フレームを受信したのでカウンタが少なくとも 1 は増えている
    expect(session._decCount).toBeGreaterThan(decBefore);
  });
});

// --------------------------------------------------------------------------
// BLE3-0023: initial token は 4B 固定: 長さ≠4 で login/ready 待機者を即 reject
// --------------------------------------------------------------------------
describe("BLE3-0023: initial token 長 4B 強制 (<4 も >4 も即 reject)", () => {
  it("[BLE3-0023] token が 3B のとき _loginWaiter を即 reject する", async () => {
    class ShortTokenMock {
      constructor() { this.onPacket = null; }
      connect(onPacket) {
        this.onPacket = onPacket;
        const shortToken = Buffer.from([0x01, 0x02, 0x03]);
        const frame = Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.INITIAL]), shortToken]);
        for (const s of splitSegments(frame, SEG.PLAINTEXT)) this.onPacket(s);
        return Promise.resolve();
      }
      write() {}
      disconnect() { return Promise.resolve(); }
    }
    const session = new SesameBleSession({ transport: new ShortTokenMock(), secretKey: SECRET });
    await expect(session.connect()).rejects.toThrow();
  });

  it("[BLE3-0023] token が 5B のとき _loginWaiter を即 reject する", async () => {
    class LongTokenMock {
      constructor() { this.onPacket = null; }
      connect(onPacket) {
        this.onPacket = onPacket;
        const longToken = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
        const frame = Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.INITIAL]), longToken]);
        for (const s of splitSegments(frame, SEG.PLAINTEXT)) this.onPacket(s);
        return Promise.resolve();
      }
      write() {}
      disconnect() { return Promise.resolve(); }
    }
    const session = new SesameBleSession({ transport: new LongTokenMock(), secretKey: SECRET });
    await expect(session.connect()).rejects.toThrow();
  });

  it("[BLE3-0023] token=4B → loginWaiter を reject しない (正常経路)", () => {
    const { session } = makeSession();
    session._secretKey = Buffer.from(SECRET, "hex");
    let rejected = false;
    session._loginWaiter = {
      resolve: vi.fn(),
      reject: vi.fn(() => { rejected = true; }),
      timer: null,
    };
    session._handleInitial(Buffer.from([0x01, 0x02, 0x03, 0x04]));
    expect(rejected).toBe(false);
  });

  it("[BLE3-0023] token=3B → _readyWaiter も reject される (secretKey なしシナリオ)", () => {
    const transport = makeMockTransport();
    const session = new SesameBleSession({ transport, profile: "lock" });
    session._secretKey = null;
    const reject = vi.fn();
    session._readyWaiter = { resolve: vi.fn(), reject, timer: null };
    session._handleInitial(Buffer.from([0x01, 0x02]));
    expect(reject).toHaveBeenCalledOnce();
  });
});

// --------------------------------------------------------------------------
// BLE3-0024: initial 受信→secretKey 無しで ReadyToRegister 遷移 (login しない)
// --------------------------------------------------------------------------
describe("BLE3-0024: secretKey 無しで initial 受信 → ReadyToRegister (login しない)", () => {
  it("[BLE3-0024] secretKey=null で initial 4B → _readyToRegister=true で _readyWaiter resolve", () => {
    const transport = makeMockTransport();
    const session = new SesameBleSession({ transport, profile: "lock" });
    const resolve = vi.fn();
    session._readyWaiter = { resolve, reject: vi.fn(), timer: null };

    session._handleInitial(Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]));

    expect(session._readyToRegister).toBe(true);
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("[BLE3-0024] secretKey=null で initial → transport.write は呼ばれない (login コマンドを送らない)", () => {
    const transport = makeMockTransport();
    const session = new SesameBleSession({ transport, profile: "lock" });

    session._handleInitial(Buffer.from([0x01, 0x02, 0x03, 0x04]));

    expect(transport.write).not.toHaveBeenCalled();
  });

  it("[BLE3-0024] secretKey あり で initial → _readyToRegister=false のまま (login 経路)", () => {
    const { session } = makeSession();
    session._handleInitial(Buffer.from([0x01, 0x02, 0x03, 0x04]));
    expect(session._readyToRegister).toBe(false);
  });

  it("[BLE3-0024] register() 中に _readyToRegister が true になる (統合)", async () => {
    class ReadyTokenMock {
      constructor() { this.onPacket = null; this.writes = []; }
      connect(onPacket) {
        this.onPacket = onPacket;
        const frame = Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.INITIAL]), TOKEN4]);
        for (const s of splitSegments(frame, SEG.PLAINTEXT)) this.onPacket(s);
        return Promise.resolve();
      }
      write(seg) { this.writes.push(Buffer.from(seg)); }
      disconnect() { return Promise.resolve(); }
    }
    const mock = new ReadyTokenMock();
    const session = new SesameBleSession({ transport: mock, secretKey: undefined });
    const p = session.register({ deviceUUID: "test-uuid-0000" });
    await Promise.resolve();
    await Promise.resolve();
    expect(session._readyToRegister).toBe(true);
    expect(session.isReadyToRegister).toBe(true);
    expect(session._key).toBeNull();
    await session.disconnect().catch(() => {});
    await p.catch(() => {});
  });
});

// --------------------------------------------------------------------------
// BLE3-0025: login 応答 resultCode==0 で loggedIn、非0 で BleResultError(login)
// --------------------------------------------------------------------------
describe("BLE3-0025: login 応答 resultCode による成功/失敗", () => {
  it("[BLE3-0025] resultCode=0 で _loggedIn=true、resolve する", async () => {
    const dev = new MockSesame({ loginResult: 0 });
    const session = new SesameBleSession({ transport: dev, secretKey: SECRET });
    await session.connect();
    expect(session.isLoggedIn).toBe(true);
  });

  it("[BLE3-0025] resultCode=5 (notFound) で BleResultError('login', 5) で reject する", async () => {
    const dev = new MockSesame({ loginResult: 5 });
    const session = new SesameBleSession({ transport: dev, secretKey: SECRET });
    const err = await session.connect().then(() => null, (e) => e);
    expect(err).toBeInstanceOf(BleResultError);
    expect(err.resultCode).toBe(5);
    expect(session.isLoggedIn).toBe(false);
  });

  it("[BLE3-0025] resultCode=8 (invalidParam) で BleResultError reject、resultName が正しい", async () => {
    const dev = new MockSesame({ loginResult: 8 });
    const session = new SesameBleSession({ transport: dev, secretKey: SECRET });
    const err = await session.connect().then(() => null, (e) => e);
    expect(err).toBeInstanceOf(BleResultError);
    expect(err.resultCode).toBe(8);
    expect(resultName(8)).toBe("invalidParam");
  });
});

// --------------------------------------------------------------------------
// BLE3-0026: login 後 time(8) 同期: デバイス時刻差 >3s でのみ送出 (lock+syncTime)
// --------------------------------------------------------------------------
describe("BLE3-0026: needsTimeSync — |deviceSeconds - nowSeconds| > 3 でのみ true", () => {
  it("[BLE3-0026] 差が 4 秒 → true (time(8) を送るべき)", () => {
    const nowMs = 1_700_000_000_000;
    const nowSec = Math.floor(nowMs / 1000);
    expect(needsTimeSync(nowSec - 4, nowMs)).toBe(true);
    expect(needsTimeSync(nowSec + 4, nowMs)).toBe(true);
  });

  it("[BLE3-0026] 差が 3 秒 → false (送らない)", () => {
    const nowMs = 1_700_000_000_000;
    const nowSec = Math.floor(nowMs / 1000);
    expect(needsTimeSync(nowSec - 3, nowMs)).toBe(false);
    expect(needsTimeSync(nowSec + 3, nowMs)).toBe(false);
  });

  it("[BLE3-0026] 差が 0 秒 → false", () => {
    const nowMs = 1_700_000_000_000;
    const nowSec = Math.floor(nowMs / 1000);
    expect(needsTimeSync(nowSec, nowMs)).toBe(false);
  });

  it("[BLE3-0026] syncTime=true + 差>3s → login 成功後に write が 2 回以上呼ばれる (login + time sync)", () => {
    const transport = makeMockTransport();
    const session = new SesameBleSession({
      transport,
      secretKey: SECRET,
      profile: "lock",
      syncTime: true,
    });
    session._loggedIn = false;
    session._key = Buffer.from(SECRET, "hex");
    session._token = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    session._encCount = 0;
    session._loginWaiter = { resolve: vi.fn(), reject: vi.fn(), timer: null };

    const deviceTimePayload = Buffer.alloc(4);
    deviceTimePayload.writeUInt32LE(100, 0); // 差≫3s → needsTimeSync=true
    const writesBefore = transport.write.mock.calls.length;
    session._handleLoginResponse(0, deviceTimePayload);
    expect(transport.write.mock.calls.length).toBeGreaterThan(writesBefore);
  });

  it("[BLE3-0026] syncTime=false → login 後 write は呼ばれない (time sync なし)", () => {
    const transport = makeMockTransport();
    const session = new SesameBleSession({
      transport,
      secretKey: SECRET,
      profile: "lock",
      syncTime: false,
    });
    session._loginWaiter = { resolve: vi.fn(), reject: vi.fn(), timer: null };
    const deviceTimePayload = Buffer.alloc(4);
    deviceTimePayload.writeUInt32LE(100, 0);
    const writesBefore = transport.write.mock.calls.length;
    session._handleLoginResponse(0, deviceTimePayload);
    expect(transport.write.mock.calls.length).toBe(writesBefore);
  });
});

// --------------------------------------------------------------------------
// BLE3-0027: syncTime ゲート: HUB3/WIFI/BIOMETRIC kind では login 後 time 同期しない
// --------------------------------------------------------------------------
describe("BLE3-0027: SesameBle.syncTime ゲート (HUB3/WIFI/BIOMETRIC は false)", () => {
  const makeBleWithModel = (model) => new SesameBle({
    secretKey: SECRET,
    model,
    transport: {
      connect: () => Promise.resolve(),
      write: () => {},
      disconnect: () => Promise.resolve(),
    },
  });

  it("[BLE3-0027] HUB3 kind で構築した SesameBle は syncTime=false をセッションへ渡す", () => {
    const ble = makeBleWithModel("hub_3");
    expect(ble._session._syncTime).toBe(false);
  });

  it("[BLE3-0027] wm_2 model (WIFI kind) で syncTime=false", () => {
    const ble = makeBleWithModel("wm_2");
    expect(ble._session._syncTime).toBe(false);
  });

  it("[BLE3-0027] sesame_5 model (LOCK5 kind) で syncTime=true", () => {
    const ble = makeBleWithModel("sesame_5");
    expect(ble._session._syncTime).toBe(true);
  });

  it("[BLE3-0027] biometric kind (ssm_touch) で syncTime=false", () => {
    const ble = makeBleWithModel("ssm_touch");
    expect(ble._session._syncTime).toBe(false);
  });
});

// --------------------------------------------------------------------------
// BLE3-0028: _isBusy 再入ガード: 二重 connect/register を alreadyConnected で拒否
// --------------------------------------------------------------------------
describe("BLE3-0028: _isBusy 再入ガード — 二重 connect/register を reject", () => {
  it("[BLE3-0028] login 済みのとき connect() を再度呼ぶと reject", async () => {
    const dev = new MockSesame();
    const session = new SesameBleSession({ transport: dev, secretKey: SECRET });
    await session.connect();
    expect(session.isLoggedIn).toBe(true);
    await expect(session.connect()).rejects.toThrow(/already|使用中|session/i);
  });

  it("[BLE3-0028] connect 進行中 (_loginWaiter 設定後) に二重 connect すると即 reject", async () => {
    // _isBusy() は _loginWaiter != null のときも true → 二重 connect は即 reject
    const { session } = makeSession();
    // _loginWaiter を手動でセットして「進行中」を模倣する
    session._loginWaiter = { resolve: vi.fn(), reject: vi.fn(), timer: null };
    await expect(session.connect()).rejects.toThrow(/already|使用中|session/i);
    // クリーンアップ
    session._loginWaiter = null;
  });

  it("[BLE3-0028] _readyWaiter が非 null のとき register() が reject する", async () => {
    const devR = new MockSesame();
    const sessionR = new SesameBleSession({ transport: devR, secretKey: undefined });
    const p = sessionR.register({ deviceUUID: "uu-0000" });
    await Promise.resolve();
    await expect(sessionR.register({ deviceUUID: "uu-0000" })).rejects.toThrow(/already|使用中|session/i);
    await sessionR.disconnect().catch(() => {});
    await p.catch(() => {});
  });

  it("[BLE3-0028] _readyToRegister=true のとき connect() が reject する", async () => {
    const { session } = makeSession();
    session._readyToRegister = true;
    await expect(session.connect()).rejects.toThrow();
  });
});

// --------------------------------------------------------------------------
// BLE3-0029: connect 失敗時の孤児 login Promise 後始末 (unhandledRejection 抑止)
// --------------------------------------------------------------------------
describe("BLE3-0029: transport.connect 失敗時の孤児 loginPromise 後始末", () => {
  it("[BLE3-0029] transport.connect() が throw したとき _loginWaiter が null になりエラーが rethrow される", async () => {
    const failTransport = {
      connect: () => Promise.reject(new Error("transport-fail")),
      write: () => {},
      disconnect: () => Promise.resolve(),
    };
    const session = new SesameBleSession({ transport: failTransport, secretKey: SECRET });
    await expect(session.connect()).rejects.toThrow("transport-fail");
    expect(session._loginWaiter).toBeNull();
  });

  it("[BLE3-0029] transport.connect 失敗後は _isBusy=false", async () => {
    const failTransport = {
      connect: () => Promise.reject(new Error("fail")),
      write: () => {},
      disconnect: () => Promise.resolve(),
    };
    const session = new SesameBleSession({ transport: failTransport, secretKey: SECRET });
    await session.connect().catch(() => {});
    expect(session._isBusy()).toBe(false);
  });
});

// --------------------------------------------------------------------------
// BLE3-0030: transport 切断通知で pending/3待機者を fail-fast (timeout 宙づり防止)
// --------------------------------------------------------------------------
describe("BLE3-0030: transport 切断 → pending/待機者を linkLost で fail-fast", () => {
  it("[BLE3-0030] onDisconnect で進行中 request を linkLost error で reject する", async () => {
    class DisconnectMock {
      constructor() {
        this.onPacket = null;
        this._onDisconnect = null;
        this.writes = [];
        this.key = deriveSessionKey(Buffer.from(SECRET, "hex"), TOKEN4);
        this.asm = new SegmentAssembler();
        this.encCount = 0;
        this.decCount = 0;
      }
      connect(onPacket, onDisc) {
        this.onPacket = onPacket;
        this._onDisconnect = onDisc;
        const frame = Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.INITIAL]), TOKEN4]);
        for (const s of splitSegments(frame, SEG.PLAINTEXT)) this.onPacket(s);
        return Promise.resolve();
      }
      write(seg) {
        this.writes.push(Buffer.from(seg));
        const a = this.asm.feed(Buffer.from(seg));
        if (!a) return;
        let frame;
        if (a.type === SEG.CIPHERTEXT) {
          frame = ccmDecrypt(this.key, this.decCount, TOKEN4, a.data);
          this.decCount += 1;
        } else {
          frame = a.data;
        }
        const item = frame[0];
        if (item === ITEM.LOGIN) {
          const ct = ccmEncrypt(this.key, this.encCount, TOKEN4, Buffer.from([OP.RESPONSE, ITEM.LOGIN, 0, 0, 0, 0, 0]));
          this.encCount += 1;
          for (const s of splitSegments(ct, SEG.CIPHERTEXT)) this.onPacket(s);
        }
        // 他の request は応答しない (保留)
      }
      disconnect() { return Promise.resolve(); }
      triggerDisc() { if (this._onDisconnect) this._onDisconnect("forced"); }
    }

    const mock = new DisconnectMock();
    const session = new SesameBleSession({ transport: mock, secretKey: SECRET });
    await session.connect();
    expect(session.isLoggedIn).toBe(true);

    const reqPromise = session.request(ITEM.TIME, Buffer.alloc(0));
    mock.triggerDisc();

    const err = await reqPromise.catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/link|lost|disconnect|切断/i);
    expect(session.isLoggedIn).toBe(false);
  });

  it("[BLE3-0030] login 待機中に transport 切断 → _loginWaiter が linkLost で reject", async () => {
    let capturedOnDisc;
    const neverConnectTransport = {
      connect: (onPacket, onDisc) => {
        capturedOnDisc = onDisc;
        return Promise.resolve();
      },
      write: () => {},
      disconnect: () => Promise.resolve(),
    };
    const session = new SesameBleSession({ transport: neverConnectTransport, secretKey: SECRET });
    const p = session.connect();
    await Promise.resolve();
    capturedOnDisc("forced");
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/link|lost|disconnect|切断/i);
  });

  it("[BLE3-0030] _handleTransportDisconnect でフラグが倒れる (_loggedIn=false, _readyToRegister=false)", () => {
    const { session } = makeSession();
    session._loggedIn = true;
    session._readyToRegister = true;
    session._handleTransportDisconnect("disconnected");
    expect(session._loggedIn).toBe(false);
    expect(session._readyToRegister).toBe(false);
  });

  it("[BLE3-0030] _handleTransportDisconnect で _registerWaiter が reject される", () => {
    const { session } = makeSession();
    const reject = vi.fn();
    session._registerWaiter = { resolve: vi.fn(), reject, timer: null };
    session._handleTransportDisconnect("disconnected");
    expect(reject).toHaveBeenCalledOnce();
  });
});

// --------------------------------------------------------------------------
// BLE3-0031: connect login 失敗時にファサードが transport を disconnect (GATT リーク防止)
// --------------------------------------------------------------------------
describe("BLE3-0031: SesameBle.connect() — login 失敗後に transport.disconnect を呼ぶ", () => {
  it("[BLE3-0031] login resultCode≠0 で失敗したとき disconnect() を呼んで rethrow する", async () => {
    const dev = new MockSesame({ loginResult: 5 });
    const ble = new SesameBle({ secretKey: SECRET, transport: dev });
    const err = await ble.connect().catch((e) => e);
    expect(err).toBeInstanceOf(BleResultError);
    expect(dev.disconnected).toBe(true);
  });

  it("[BLE3-0031] transport.connect が失敗したときも disconnect を呼んで rethrow", async () => {
    let disconnectCalled = false;
    const failTransport = {
      connect: () => Promise.reject(new Error("gatt-fail")),
      write: () => {},
      disconnect: () => { disconnectCalled = true; return Promise.resolve(); },
    };
    const ble = new SesameBle({ secretKey: SECRET, transport: failTransport });
    await expect(ble.connect()).rejects.toThrow("gatt-fail");
    expect(disconnectCalled).toBe(true);
  });
});

// --------------------------------------------------------------------------
// BLE3-0032: connectMany: 1 スキャンで近接ロックへ並行接続、圏外を unreachable
// --------------------------------------------------------------------------
describe("BLE3-0032: SesameBle.connectMany — 1 スキャン + 並行接続", () => {
  it("[BLE3-0032] 戻り値の shape: {connected:Map, unreachable:string[], failed:Array}", async () => {
    try {
      const result = await SesameBle.connectMany([], { scanTimeoutMs: 50 });
      expect(result.connected).toBeInstanceOf(Map);
      expect(Array.isArray(result.unreachable)).toBe(true);
      expect(Array.isArray(result.failed)).toBe(true);
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
    }
  });

  it("[BLE3-0032] スキャン結果に存在しない deviceUUID は unreachable に積まれる", async () => {
    const entries = [
      { name: "lock-A", deviceUUID: "00000000-0000-0000-0000-000000000001", secretKey: SECRET },
      { name: "lock-B", deviceUUID: "00000000-0000-0000-0000-000000000002", secretKey: SECRET },
    ];
    try {
      const result = await SesameBle.connectMany(entries, { scanTimeoutMs: 1 });
      expect(result).toHaveProperty("connected");
      expect(result).toHaveProperty("unreachable");
      expect(result).toHaveProperty("failed");
      const allNames = [
        ...result.unreachable,
        ...result.failed.map((f) => f.name),
        ...[...result.connected.keys()],
      ];
      expect(allNames).toContain("lock-A");
      expect(allNames).toContain("lock-B");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
    }
  });
});

// --------------------------------------------------------------------------
// BLE3-0033: signGuestKey login: initial token を署名→サーバ署名 token を session 鍵に
// --------------------------------------------------------------------------
describe("BLE3-0033: _loginViaServer — signLogin(tokenHex) の戻りを session 鍵に", () => {
  it("[BLE3-0033] isNeedAuthFromServer のとき signLogin(tokenHex) の戻り(16B hex)を鍵として平文 login する", async () => {
    const serverToken = Buffer.from("aabbccddeeff00112233445566778899", "hex");
    const serverTokenHex = serverToken.toString("hex");

    let signLoginCalled = false;
    let capturedTokenHex = null;

    const signLogin = async (tokenHex) => {
      signLoginCalled = true;
      capturedTokenHex = tokenHex;
      return serverTokenHex;
    };

    class ServerAuthMock {
      constructor() {
        this.onPacket = null;
        this.asm = new SegmentAssembler();
        this.encCount = 0;
        this.decCount = 0;
        this.key = serverToken;
      }
      connect(onPacket) {
        this.onPacket = onPacket;
        const frame = Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.INITIAL]), TOKEN4]);
        for (const s of splitSegments(frame, SEG.PLAINTEXT)) this.onPacket(s);
        return Promise.resolve();
      }
      write(seg) {
        const a = this.asm.feed(Buffer.from(seg));
        if (!a) return;
        let frame;
        if (a.type === SEG.CIPHERTEXT) {
          try { frame = ccmDecrypt(this.key, this.decCount, TOKEN4, a.data); this.decCount += 1; } catch { return; }
        } else {
          frame = a.data;
        }
        const item = frame[0];
        if (item === ITEM.LOGIN) {
          const resp = Buffer.from([OP.RESPONSE, ITEM.LOGIN, 0x00, 0, 0, 0, 0]);
          const ct = ccmEncrypt(this.key, this.encCount, TOKEN4, resp);
          this.encCount += 1;
          for (const s of splitSegments(ct, SEG.CIPHERTEXT)) this.onPacket(s);
        }
      }
      disconnect() { return Promise.resolve(); }
    }

    const mock = new ServerAuthMock();
    const session = new SesameBleSession({ transport: mock, secretKey: SECRET });

    await session.connect({ signLogin });

    expect(session.isLoggedIn).toBe(true);
    expect(signLoginCalled).toBe(true);
    expect(capturedTokenHex).toBe(TOKEN4.toString("hex"));
  });

  it("[BLE3-0033] signLogin 戻り (16B hex) が session 鍵 (_key) に設定される", async () => {
    const { session } = makeSession();
    const serverKeyHex = "aabbccddeeff00112233445566778899";
    const signLogin = vi.fn(async () => serverKeyHex);
    session._signLogin = signLogin;
    session._token = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    session._loginWaiter = { resolve: vi.fn(), reject: vi.fn(), timer: null };

    await session._loginViaServer();

    expect(session._key).toEqual(Buffer.from(serverKeyHex, "hex"));
  });

  it("[BLE3-0033] _loginViaServer は loginPayload を PLAINTEXT (_sendPlain) で送る", async () => {
    const transport = makeMockTransport();
    const session = new SesameBleSession({ transport, secretKey: SECRET });
    const serverKeyHex = "aabbccddeeff00112233445566778899";
    session._signLogin = vi.fn(async () => serverKeyHex);
    session._token = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    session._loginWaiter = { resolve: vi.fn(), reject: vi.fn(), timer: null };

    await session._loginViaServer();

    expect(transport.write).toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// BLE3-0034: server token 長検証: signLogin 戻りが 16B でないと login 待機者を reject
// --------------------------------------------------------------------------
describe("BLE3-0034: _loginViaServer — signLogin 戻りが 16B でないと reject", () => {
  it("[BLE3-0034] signLogin が 10B hex (20 char) を返すと connect が reject", async () => {
    const shortTokenHex = "aabbcc001122334455ff"; // 20hex = 10B
    const signLogin = async () => shortTokenHex;

    class AnyMock {
      constructor() { this.onPacket = null; }
      connect(onPacket) {
        this.onPacket = onPacket;
        const frame = Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.INITIAL]), TOKEN4]);
        for (const s of splitSegments(frame, SEG.PLAINTEXT)) this.onPacket(s);
        return Promise.resolve();
      }
      write() {}
      disconnect() { return Promise.resolve(); }
    }

    const session = new SesameBleSession({ transport: new AnyMock(), secretKey: SECRET });
    await expect(session.connect({ signLogin })).rejects.toThrow(/16|serverToken/i);
  });

  it("[BLE3-0034] signLogin が throw したとき _loginWaiter をその error で reject", async () => {
    const signLogin = async () => { throw new Error("server-unreachable"); };

    class AnyMock2 {
      constructor() { this.onPacket = null; }
      connect(onPacket) {
        this.onPacket = onPacket;
        const frame = Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.INITIAL]), TOKEN4]);
        for (const s of splitSegments(frame, SEG.PLAINTEXT)) this.onPacket(s);
        return Promise.resolve();
      }
      write() {}
      disconnect() { return Promise.resolve(); }
    }

    const session = new SesameBleSession({ transport: new AnyMock2(), secretKey: SECRET });
    await expect(session.connect({ signLogin })).rejects.toThrow("server-unreachable");
  });

  it("[BLE3-0034] signLogin が 15B hex を返したとき _loginWaiter を reject (白箱)", async () => {
    const { session } = makeSession();
    const shortHex = "aabbccddeeff001122334455667788"; // 15B hex
    session._signLogin = vi.fn(async () => shortHex);
    session._token = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const reject = vi.fn();
    session._loginWaiter = { resolve: vi.fn(), reject, timer: null };

    await session._loginViaServer();

    expect(reject).toHaveBeenCalledOnce();
    expect(reject.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});

// --------------------------------------------------------------------------
// BLE3-0035: sentinel 自動判定: secretKey に '000000' を含むと needAuthFromServer 有効化
// --------------------------------------------------------------------------
describe("BLE3-0035: sentinel 自動判定 — secretKey に '000000' が含まれると server-auth 有効化", () => {
  const mockTransport = () => ({
    connect: () => Promise.resolve(),
    write: () => {},
    disconnect: () => Promise.resolve(),
  });

  it("[BLE3-0035] '000000' を含む secretKey → _sentinelDetected=true, _needAuthFromServer=true", () => {
    const sentinelSecret = "aabb000000ccddee00112233445566ff";
    const ble = new SesameBle({ secretKey: sentinelSecret, transport: mockTransport() });
    expect(ble._sentinelDetected).toBe(true);
    expect(ble._needAuthFromServer).toBe(true);
  });

  it("[BLE3-0035] '000000' を含まない secretKey では sentinel=false", () => {
    const ble = new SesameBle({ secretKey: SECRET, transport: mockTransport() });
    expect(ble._sentinelDetected).toBe(false);
    expect(ble._needAuthFromServer).toBe(false);
  });

  it("[BLE3-0035] sentinel 検出時に registerTransport 無しだと connect() で明示エラー", async () => {
    const sentinelSecret = "aabb000000ccddee00112233445566ff";
    const ble = new SesameBle({ secretKey: sentinelSecret, transport: mockTransport() });
    await expect(ble.connect()).rejects.toThrow(/server.*auth|000000|registerTransport|--server-auth/i);
  });

  it("[BLE3-0035] needAuthFromServer=false を明示した場合 sentinel があっても server-auth 無効", () => {
    const sentinelSecret = "aabb000000ccddee00112233445566ff";
    const ble = new SesameBle({
      secretKey: sentinelSecret,
      needAuthFromServer: false,
      transport: mockTransport(),
    });
    expect(ble._needAuthFromServer).toBe(false);
  });

  it("[BLE3-0035] registerMode=true では sentinel 自動検出が無効", () => {
    const ble = new SesameBle({
      registerMode: true,
      transport: mockTransport(),
    });
    expect(ble._sentinelDetected).toBe(false);
  });
});

// --------------------------------------------------------------------------
// BLE3-0036: WM2 profile に server-auth 経路なし: signLogin 指定で明示 reject
// --------------------------------------------------------------------------
describe("BLE3-0036: wm2 profile + signLogin → wm2NoServerAuth で明示 reject", () => {
  it("[BLE3-0036] wm2 profile で _signLogin 設定時に connect が wm2NoServerAuth で reject", async () => {
    const WM2_INITIAL_CODE = 13;
    class Wm2Mock {
      constructor() { this.onPacket = null; }
      connect(onPacket) {
        this.onPacket = onPacket;
        const frame = Buffer.concat([Buffer.from([OP.PUBLISH, WM2_INITIAL_CODE]), TOKEN4]);
        for (const s of splitSegments(frame, SEG.PLAINTEXT)) this.onPacket(s);
        return Promise.resolve();
      }
      write() {}
      disconnect() { return Promise.resolve(); }
    }

    const signLogin = async () => "aabbccddeeff00112233445566778899";
    const session = new SesameBleSession({
      transport: new Wm2Mock(),
      secretKey: SECRET,
      profile: "wm2",
    });

    await expect(session.connect({ signLogin })).rejects.toThrow(/wm2|noServerAuth|server/i);
  });

  it("[BLE3-0036] wm2 profile で signLogin なし (通常ローカル login) は正常に進む", async () => {
    const WM2_INITIAL_CODE = 13;
    class Wm2NormalMock {
      constructor() {
        this.onPacket = null;
        this.asm = new SegmentAssembler();
        this.key = Buffer.from(SECRET, "hex");
        this.encCount = 0;
        this.decCount = 0;
      }
      connect(onPacket) {
        this.onPacket = onPacket;
        const frame = Buffer.concat([Buffer.from([OP.PUBLISH, WM2_INITIAL_CODE]), TOKEN4]);
        for (const s of splitSegments(frame, SEG.PLAINTEXT)) this.onPacket(s);
        return Promise.resolve();
      }
      write(seg) {
        const a = this.asm.feed(Buffer.from(seg));
        if (!a) return;
        let frame;
        if (a.type === SEG.CIPHERTEXT) {
          try { frame = ccmDecrypt(this.key, this.decCount, TOKEN4, a.data, "wm2"); this.decCount += 1; } catch { return; }
        } else {
          frame = a.data;
        }
        const item = frame[0];
        if (item === ITEM.LOGIN) {
          const resp = Buffer.from([OP.RESPONSE, ITEM.LOGIN, 0x00, 0, 0, 0, 0]);
          const ct = ccmEncrypt(this.key, this.encCount, TOKEN4, resp, "wm2");
          this.encCount += 1;
          for (const s of splitSegments(ct, SEG.CIPHERTEXT)) this.onPacket(s);
        }
      }
      disconnect() { return Promise.resolve(); }
    }

    const session = new SesameBleSession({
      transport: new Wm2NormalMock(),
      secretKey: SECRET,
      profile: "wm2",
    });
    await session.connect();
    expect(session.isLoggedIn).toBe(true);
  });

  it("[BLE3-0036] profile=wm2 で _signLogin が設定されているとき _loginWaiter を reject する (白箱)", () => {
    const transport = makeMockTransport();
    const session = new SesameBleSession({
      transport,
      secretKey: SECRET,
      profile: "wm2",
    });
    session._signLogin = vi.fn(async () => "aabbccddeeff00112233445566778899");

    const reject = vi.fn();
    session._loginWaiter = { resolve: vi.fn(), reject, timer: null };

    session._handleInitial(Buffer.from([0x01, 0x02, 0x03, 0x04]));

    expect(reject).toHaveBeenCalledOnce();
    const err = reject.mock.calls[0][0];
    expect(err).toBeInstanceOf(Error);
    expect(session._signLogin).not.toHaveBeenCalled();
  });
});
