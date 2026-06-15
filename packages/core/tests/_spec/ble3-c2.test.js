// BLE3 spec テスト: BLE3-0037, 0038, 0039, 0040, 0041, 0042, 0043, 0044, 0045, 0046,
//                   0051, 0052, 0053, 0054, 0055, 0056, 0057, 0060
//
// 実行: vitest run packages/core/tests/_spec/ble3-c2.test.js
// 方針: A 実装(純関数 unit テスト) と B 実装(MockSesame 統合テスト) の良い部分を統合。
//       TDD — spec assertion に忠実(red 許容)。実機/ネットワーク不使用。決定論的。

import { describe, it, expect, beforeEach } from "vitest";
import { Buffer } from "node:buffer";
import { createECDH } from "node:crypto";

// --- プロトコル純関数 ---
import {
  registrationData,
  registrationTimestampBytes,
  deriveSessionKeyFromEcdh,
  deriveSessionKey,
  ccmEncrypt,
  ccmDecrypt,
  splitSegments,
  SegmentAssembler,
  configureLockPositionData,
  opSensorControlData,
  bleTxPowerData,
  historyReadData,
  historyDeleteData,
  parseNetworkStatus,
  parseMechStatus,
  OP,
  ITEM,
  SEG,
} from "../../src/ble/protocol.js";

// --- セッション ---
import { SesameBleSession } from "../../src/ble/session.js";

// --- i18n ---
import { setLocale } from "../../src/i18n.js";

// ── 共通定数 ────────────────────────────────────────────────────────────────
const DEFAULT_SECRET = "0102030405060708090a0b0c0d0e0f10";
const DEFAULT_TOKEN  = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);

// ── i18n: 各テスト前に ja 固定 ───────────────────────────────────────────────
beforeEach(() => setLocale("ja"));

// ── MockSesame: encrypt/decrypt を正しく実装した最小 mock デバイス ────────────
// B 実装のパターンを踏襲し、write() でフレームを復号して応答を返す。
class MockSesame {
  constructor({ secret = DEFAULT_SECRET, token = DEFAULT_TOKEN, responseCode = 0 } = {}) {
    this.secret = Buffer.isBuffer(secret) ? secret : Buffer.from(secret, "hex");
    this.token  = Buffer.isBuffer(token)  ? token  : token;
    this.key    = deriveSessionKey(this.secret, this.token);
    this.asm    = new SegmentAssembler();
    this.encCount = 0;
    this.decCount = 0;
    this.onPacket = null;
    this.lastCommand = null;
    this.disconnected = false;
    this._responseCode = responseCode;
    this._responseQueue = new Map(); // item → Buffer
  }

  connect(onPacket) {
    this.onPacket = onPacket;
    // publish(PUBLISH=8) + INITIAL(14) + token4
    this._emitPlain(Buffer.concat([
      Buffer.from([OP.PUBLISH, ITEM.INITIAL]),
      this.token,
    ]));
    return Promise.resolve();
  }

  write(seg) {
    const a = this.asm.feed(Buffer.from(seg));
    if (!a) return;
    let frame;
    if (a.type === SEG.CIPHERTEXT) {
      frame = ccmDecrypt(this.key, this.decCount, this.token, a.data);
      this.decCount++;
    } else {
      frame = a.data;
    }
    const item = frame[0];
    if (item === ITEM.LOGIN) {
      this._emitCipher(Buffer.from([OP.RESPONSE, ITEM.LOGIN, this._responseCode,
        0x00, 0x00, 0x00, 0x00]));
      return;
    }
    this.lastCommand = { item, data: Buffer.from(frame.subarray(1)) };
    const queuedPayload = this._responseQueue.get(item) ?? Buffer.alloc(0);
    this._emitCipher(Buffer.concat([
      Buffer.from([OP.RESPONSE, item, this._responseCode]),
      queuedPayload,
    ]));
  }

  enqueueResponse(item, payload) {
    this._responseQueue.set(item, payload);
  }

  disconnect() {
    this.disconnected = true;
    return Promise.resolve();
  }

  _emitPlain(f) {
    for (const s of splitSegments(f, SEG.PLAINTEXT)) this.onPacket(s);
  }

  _emitCipher(f) {
    const ct = ccmEncrypt(this.key, this.encCount, this.token, f);
    this.encCount++;
    for (const s of splitSegments(ct, SEG.CIPHERTEXT)) this.onPacket(s);
  }
}

// ── ログイン済み SesameBleSession + MockSesame を返す ─────────────────────────
async function makeLoggedInSession({
  secret = DEFAULT_SECRET,
  token = DEFAULT_TOKEN,
  responseCode = 0,
  mechStatusKind = "lock",
} = {}) {
  const mock = new MockSesame({ secret, token, responseCode });
  const session = new SesameBleSession({
    transport: mock,
    secretKey: Buffer.isBuffer(secret) ? secret : Buffer.from(secret, "hex"),
    profile: "lock",
    syncTime: false,
    mechStatusKind,
  });
  await session.connect();
  return { session, mock };
}

// ═════════════════════════════════════════════════════════════════════════════
// BLE3-0037  register: ECDH 生公開鍵は 0x04 prefix を剥がした 64B で送る
// ═════════════════════════════════════════════════════════════════════════════
describe("[BLE3-0037] register: ECDH 生公開鍵は 0x04 prefix を剥がした 64B で送る", () => {

  it("[BLE3-0037] 65B(prefix=0x04) を registrationData に渡すと throw (64B 契約)", () => {
    const pubK65 = Buffer.alloc(65, 0x04);
    expect(() => registrationData(pubK65, 0, "lock")).toThrow();
  });

  it("[BLE3-0037] 63B など非64B を registrationData に渡すと throw", () => {
    const pubK63 = Buffer.alloc(63, 0x01);
    expect(() => registrationData(pubK63, 0, "lock")).toThrow();
  });

  it("[BLE3-0037] 64B は registrationData を通過し先頭64B が pubK そのもの", () => {
    const pubK64 = Buffer.alloc(64, 0x02);
    const result = registrationData(pubK64, 0, "lock");
    expect(result.length).toBe(68);
    expect(result.subarray(0, 64)).toEqual(pubK64);
  });

  it("[BLE3-0037] register() の ECDH 送出 pubK は 0x04 prefix を含まない 64B (統合確認)", async () => {
    const token = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const mock = new MockSesame({ secret: DEFAULT_SECRET, token });

    // device 側 ECDH (mock が返す pubkey)
    const deviceEcdh = createECDH("prime256v1");
    deviceEcdh.generateKeys();
    const devicePubK64 = deviceEcdh.getPublicKey().subarray(1); // 64B raw

    let registrationFrame = null;
    const asm2 = new SegmentAssembler();
    mock.connect = function(onPacket) {
      this.onPacket = onPacket;
      this._emitPlain(Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.INITIAL]), this.token]));
      return Promise.resolve();
    };
    mock.write = function(seg) {
      const a = asm2.feed(Buffer.from(seg));
      if (!a) return;
      const frame = a.data; // initial/register は PLAINTEXT
      const item = frame[0];
      if (item === ITEM.REGISTRATION) {
        registrationFrame = Buffer.from(frame.subarray(1)); // data = pubK64 ++ ts4
        this._emitPlain(Buffer.concat([
          Buffer.from([OP.RESPONSE, ITEM.REGISTRATION, 0x00]),
          devicePubK64,
        ]));
      }
    };

    const session = new SesameBleSession({
      transport: mock,
      secretKey: undefined,
      profile: "lock",
      syncTime: false,
      mechStatusKind: "lock",
    });

    const result = await session.register({
      deviceUUID: "00000000-0000-0000-0000-000000000001",
      nowMs: 1605929466482,
    });

    expect(registrationFrame).not.toBeNull();
    expect(registrationFrame.length).toBe(68); // 64B pubK + 4B timestamp
    const sentPubK = registrationFrame.subarray(0, 64);
    expect(sentPubK.length).toBe(64);
    // prefix 0x04 を含まない raw 公開鍵 (EccKey.getPubK() は 64B X‖Y 形式)
    expect(sentPubK[0]).not.toBe(0x04);
    // secretKey は 32 hex 文字で返る
    expect(result.secretKey).toMatch(/^[0-9a-f]{32}$/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLE3-0038  registrationData(lock): pubK64 ++ timestamp4 = 68B、PLAINTEXT 送出
// ═════════════════════════════════════════════════════════════════════════════
describe("[BLE3-0038] registrationData(lock): pubK64 ++ timestamp4 = 68B", () => {

  it("[BLE3-0038] lock profile で 64B pubK → 68B (pubK64 ++ ts4)", () => {
    const pubK64 = Buffer.alloc(64, 0xab);
    const nowMs = 1605929466482;
    const data = registrationData(pubK64, nowMs, "lock");
    expect(data.length).toBe(68);
    expect(data.subarray(0, 64).equals(pubK64)).toBe(true);
    const ts = registrationTimestampBytes(nowMs);
    expect(data.subarray(64).equals(ts)).toBe(true);
  });

  it("[BLE3-0038] 先頭 64B は pubK そのもの (CHHub3Device.kt:197 EccKey.getPubK())", () => {
    const pubK64 = Buffer.from("a".repeat(128), "hex"); // 64B
    const result = registrationData(pubK64, 1605929466482, "lock");
    expect(result.subarray(0, 64)).toEqual(pubK64);
  });

  it("[BLE3-0038] 末尾 4B は registrationTimestampBytes と一致 (timestamp LE4B)", () => {
    const pubK64 = Buffer.alloc(64, 0x01);
    const nowMs = 1605929466482;
    const result = registrationData(pubK64, nowMs, "lock");
    const expected = registrationTimestampBytes(nowMs);
    expect(result.subarray(64, 68)).toEqual(expected);
  });

  it("[BLE3-0038] wm2 profile は timestamp を付けず 64B のみ返す (CHWifiModule2Device.kt:290)", () => {
    const pubK64 = Buffer.alloc(64, 0x02);
    const result = registrationData(pubK64, 1605929466482, "wm2");
    expect(result.length).toBe(64);
    expect(result.equals(pubK64)).toBe(true);
  });

  it("[BLE3-0038] pubK 長≠64 は throw する", () => {
    expect(() => registrationData(Buffer.alloc(63), Date.now(), "lock")).toThrow();
    expect(() => registrationData(Buffer.alloc(0), Date.now(), "lock")).toThrow();
    expect(() => registrationData(Buffer.alloc(65), Date.now(), "lock")).toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLE3-0039  registrationTimestampBytes: 秒値下位32bit を LE 4B (固定ベクタ fa89b85f)
// ═════════════════════════════════════════════════════════════════════════════
describe("[BLE3-0039] registrationTimestampBytes: 固定ベクタ fa89b85f", () => {

  it("[BLE3-0039] ms=1605929466482 → 'fa89b85f' (DataExtention.kt:139 コメントベクタ)", () => {
    const result = registrationTimestampBytes(1605929466482);
    expect(result.toString("hex")).toBe("fa89b85f");
  });

  it("[BLE3-0039] 返り値は 4B Buffer", () => {
    const result = registrationTimestampBytes(1605929466482);
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBe(4);
  });

  it("[BLE3-0039] ms=0 → 秒=0 → 00000000", () => {
    expect(registrationTimestampBytes(0).toString("hex")).toBe("00000000");
  });

  it("[BLE3-0039] ms=1000 → 秒=1 → 01000000 (LE)", () => {
    expect(registrationTimestampBytes(1000).toString("hex")).toBe("01000000");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLE3-0040  ECDH 共有秘密先頭16B → secretKey(wm2Key) を hex 確定
// ═════════════════════════════════════════════════════════════════════════════
describe("[BLE3-0040] ecdhSecretPre16 / session.register: secretKey=ECDH pre16 hex", () => {

  it("[BLE3-0040] ecdhSecretPre16 は双方から同一 16B 共有秘密を返す (ECDH 交換)", async () => {
    const { ecdhSecretPre16 } = await import("../../src/crypto.js");

    const kpA = createECDH("prime256v1");
    kpA.generateKeys();
    const kpB = createECDH("prime256v1");
    kpB.generateKeys();

    const pubB64 = kpB.getPublicKey().subarray(1); // prefix 剥がし
    const pubA64 = kpA.getPublicKey().subarray(1);

    const pre16A = ecdhSecretPre16(kpA, pubB64);
    const pre16B = ecdhSecretPre16(kpB, pubA64);

    expect(pre16A).toEqual(pre16B);
    expect(pre16A.length).toBe(16);
  });

  it("[BLE3-0040] secretKey = pre16.toString('hex') で 32 文字 hex になる (session.js:382)", () => {
    const pre16 = Buffer.alloc(16, 0xcd);
    const secretKey = pre16.toString("hex");
    expect(secretKey).toBe("cd".repeat(16));
    expect(secretKey.length).toBe(32);
  });

  it("[BLE3-0040] register 結果の secretKey は 32 hex 文字 (16B hex)", async () => {
    const token = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    const mock = new MockSesame({ secret: DEFAULT_SECRET, token });

    const deviceEcdh = createECDH("prime256v1");
    deviceEcdh.generateKeys();
    const devicePubK64 = deviceEcdh.getPublicKey().subarray(1);
    const asm2 = new SegmentAssembler();

    mock.connect = function(onPacket) {
      this.onPacket = onPacket;
      this._emitPlain(Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.INITIAL]), this.token]));
      return Promise.resolve();
    };
    mock.write = function(seg) {
      const a = asm2.feed(Buffer.from(seg));
      if (!a) return;
      const frame = a.data;
      const item = frame[0];
      if (item === ITEM.REGISTRATION) {
        this._emitPlain(Buffer.concat([
          Buffer.from([OP.RESPONSE, ITEM.REGISTRATION, 0x00]),
          devicePubK64,
        ]));
      }
    };

    const session = new SesameBleSession({
      transport: mock,
      secretKey: undefined,
      profile: "lock",
      syncTime: false,
      mechStatusKind: "lock",
    });

    const result = await session.register({
      deviceUUID: "00000000-0000-0000-0000-000000000002",
      nowMs: Date.now(),
    });

    expect(result.secretKey).toMatch(/^[0-9a-f]{32}$/);
    expect(result.deviceUUID).toBe("00000000-0000-0000-0000-000000000002");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLE3-0041  deriveSessionKeyFromEcdh: 登録後 session 鍵 = CMAC(ecdhPre16, token4)
// ═════════════════════════════════════════════════════════════════════════════
describe("[BLE3-0041] deriveSessionKeyFromEcdh: 登録後 session 鍵 = CMAC(ecdhPre16, token4)", () => {

  it("[BLE3-0041] ecdhPre16=16B + token4=4B → 16B セッション鍵を返す", () => {
    const pre16 = Buffer.from("0102030405060708090a0b0c0d0e0f10", "hex");
    const token4 = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
    const key = deriveSessionKeyFromEcdh(pre16, token4);
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(16);
  });

  it("[BLE3-0041] deriveSessionKey と同一結果 (内部委譲, CHHub3Device.kt:206)", () => {
    const pre16 = Buffer.from("aabbccddeeff00112233445566778899", "hex");
    const token4 = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const fromEcdh = deriveSessionKeyFromEcdh(pre16, token4);
    const direct = deriveSessionKey(pre16, token4);
    expect(fromEcdh).toEqual(direct);
  });

  it("[BLE3-0041] ecdhPre16 長≠16 は throw する", () => {
    const token4 = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    expect(() => deriveSessionKeyFromEcdh(Buffer.alloc(15), token4)).toThrow();
    expect(() => deriveSessionKeyFromEcdh(Buffer.alloc(17), token4)).toThrow();
    expect(() => deriveSessionKeyFromEcdh(Buffer.alloc(0), token4)).toThrow();
  });

  it("[BLE3-0041] ecdhPre16 が non-buffer の場合も throw する", () => {
    const token4 = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    expect(() => deriveSessionKeyFromEcdh("notabuffer", token4)).toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLE3-0042  register 応答 pubkey 抽出: 機種別レイアウト分岐 (64/67/77B)
// ═════════════════════════════════════════════════════════════════════════════
describe("[BLE3-0042] _extractRegisterDevicePubK: 機種別レイアウト分岐 (64/67/77B)", () => {

  /** REGISTRATION 応答に指定ペイロードを返す mock 経由で register() を実行 */
  async function runRegisterWithPayload(regPayload, profile = "lock") {
    const token = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const mock = new MockSesame({ secret: DEFAULT_SECRET, token });
    const asm2 = new SegmentAssembler();

    mock.connect = function(onPacket) {
      this.onPacket = onPacket;
      this._emitPlain(Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.INITIAL]), this.token]));
      return Promise.resolve();
    };
    mock.write = function(seg) {
      const a = asm2.feed(Buffer.from(seg));
      if (!a) return;
      const frame = a.data;
      const item = frame[0];
      if (item === ITEM.REGISTRATION) {
        this._emitPlain(Buffer.concat([
          Buffer.from([OP.RESPONSE, ITEM.REGISTRATION, 0x00]),
          regPayload,
        ]));
      }
    };

    const session = new SesameBleSession({
      transport: mock,
      secretKey: undefined,
      profile,
      syncTime: false,
      mechStatusKind: "lock",
    });
    return session.register({
      deviceUUID: "00000000-0000-0000-0000-000000000003",
      nowMs: Date.now(),
    });
  }

  it("[BLE3-0042] 64B payload → 全体が device pubkey (Hub3 等, CHHub3Device.kt:201)", async () => {
    const deviceEcdh = createECDH("prime256v1");
    deviceEcdh.generateKeys();
    const realPubK64 = deviceEcdh.getPublicKey().subarray(1);
    const result = await runRegisterWithPayload(realPubK64);
    expect(result.secretKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it("[BLE3-0042] 67B payload → [3..66] が device pubkey (Bot2/Bike2, CHSesameBot2Device.kt:216)", async () => {
    const deviceEcdh = createECDH("prime256v1");
    deviceEcdh.generateKeys();
    const realPubK64 = deviceEcdh.getPublicKey().subarray(1);
    // 67B = mechStatus(3B) ++ pubK(64B)
    const payload67 = Buffer.concat([Buffer.alloc(3, 0x00), realPubK64]);
    expect(payload67.length).toBe(67);
    const result = await runRegisterWithPayload(payload67);
    expect(result.secretKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it("[BLE3-0042] 77B payload → [13..76] が device pubkey (SS5, CHSesame5Device.kt:200)", async () => {
    const deviceEcdh = createECDH("prime256v1");
    deviceEcdh.generateKeys();
    const realPubK64 = deviceEcdh.getPublicKey().subarray(1);
    // 77B = mechStatus(7B) ++ mechSetting(6B) ++ pubK(64B)
    const payload77 = Buffer.concat([Buffer.alloc(13, 0x00), realPubK64]);
    expect(payload77.length).toBe(77);
    const result = await runRegisterWithPayload(payload77);
    expect(result.secretKey).toMatch(/^[0-9a-f]{32}$/);
  });

  it("[BLE3-0042] 60B などの未定義長さでは throw する", async () => {
    const deviceEcdh = createECDH("prime256v1");
    deviceEcdh.generateKeys();
    const realPubK64 = deviceEcdh.getPublicKey().subarray(1);
    // 65B は想定外レイアウト → throw
    const payload65 = Buffer.concat([Buffer.alloc(1, 0x00), realPubK64]);
    expect(payload65.length).toBe(65);
    await expect(runRegisterWithPayload(payload65)).rejects.toThrow();
  });

  it("[BLE3-0042] wm2 profile → payload 先頭 64B を返す (CHWifiModule2Device.kt:295)", async () => {
    // wm2 profile は initialItemCode=13 (WM2_ACTION_CODES.INITIAL) を使う。
    // 標準 MockSesame は ITEM.INITIAL=14 を emit するため wm2 では機能しない。
    // _extractRegisterDevicePubK の直接テストで代替する。
    const transport = { connect: async () => {}, write: () => {}, disconnect: async () => {} };
    const session = new SesameBleSession({ transport, secretKey: undefined, profile: "wm2" });
    const deviceEcdh = createECDH("prime256v1");
    deviceEcdh.generateKeys();
    const realPubK64 = deviceEcdh.getPublicKey().subarray(1);
    // wm2: 74B (64B pubK + 10B extra) → 先頭 64B を返す
    const payload74 = Buffer.concat([realPubK64, Buffer.alloc(10, 0x00)]);
    const result = session._extractRegisterDevicePubK(payload74);
    expect(result.length).toBe(64);
    expect(result.equals(realPubK64)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLE3-0043  register 失敗 (非0 resultCode/timeout) で REGISTRATION 待機者を reject
// ═════════════════════════════════════════════════════════════════════════════
describe("[BLE3-0043] register 失敗: 非0 resultCode / timeout で reject", () => {

  it("[BLE3-0043] resultCode=0 → _handleRegistrationResponse が resolve に Buffer payload を渡す", () => {
    const transport = { connect: async () => {}, write: () => {}, disconnect: async () => {} };
    const session = new SesameBleSession({ transport });
    const payload = Buffer.from([0x01, 0x02]);
    let resolved = null;
    session._registerWaiter = {
      resolve: (v) => { resolved = v; },
      reject: () => {},
      timer: null,
    };
    session._handleRegistrationResponse(0, payload);
    expect(resolved).not.toBeNull();
    expect(Buffer.isBuffer(resolved)).toBe(true);
    expect(resolved).toEqual(payload);
  });

  it("[BLE3-0043] resultCode=nonzero → BleResultError で reject", async () => {
    const token = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const mock = new MockSesame({ secret: DEFAULT_SECRET, token });
    const asm2 = new SegmentAssembler();

    mock.connect = function(onPacket) {
      this.onPacket = onPacket;
      this._emitPlain(Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.INITIAL]), this.token]));
      return Promise.resolve();
    };
    mock.write = function(seg) {
      const a = asm2.feed(Buffer.from(seg));
      if (!a) return;
      const frame = a.data;
      const item = frame[0];
      if (item === ITEM.REGISTRATION) {
        // resultCode=3 (非0)
        this._emitPlain(Buffer.concat([
          Buffer.from([OP.RESPONSE, ITEM.REGISTRATION, 0x03]),
        ]));
      }
    };

    const session = new SesameBleSession({
      transport: mock,
      secretKey: undefined,
      profile: "lock",
      syncTime: false,
      mechStatusKind: "lock",
    });

    await expect(
      session.register({ deviceUUID: "00000000-0000-0000-0000-000000000004", nowMs: Date.now() })
    ).rejects.toThrow();
  });

  it("[BLE3-0043] _registerWaiter が null なら no-op (unsolicited)", () => {
    const transport = { connect: async () => {}, write: () => {}, disconnect: async () => {} };
    const session = new SesameBleSession({ transport });
    expect(() => session._handleRegistrationResponse(0, Buffer.alloc(0))).not.toThrow();
  });

  it("[BLE3-0043] secretKey 付きセッションで register() → registerNeedsFactory で reject", async () => {
    const session = new SesameBleSession({
      transport: { connect() { return Promise.resolve(); }, write() {}, disconnect() { return Promise.resolve(); } },
      secretKey: Buffer.from(DEFAULT_SECRET, "hex"),
      profile: "lock",
      syncTime: false,
      mechStatusKind: "lock",
    });
    await expect(
      session.register({ deviceUUID: "00000000-0000-0000-0000-000000000005" })
    ).rejects.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLE3-0044  register: secretKey 付きで呼ぶと registerNeedsFactory で拒否
// ═════════════════════════════════════════════════════════════════════════════
describe("[BLE3-0044] register: secretKey 付きセッションは registerNeedsFactory で reject", () => {

  it("[BLE3-0044] secretKey 有 → register() は即 reject する (session.js:292)", async () => {
    const session = new SesameBleSession({
      transport: { connect() { return Promise.resolve(); }, write() {}, disconnect() { return Promise.resolve(); } },
      secretKey: Buffer.from(DEFAULT_SECRET, "hex"),
      profile: "lock",
      syncTime: false,
      mechStatusKind: "lock",
    });
    await expect(
      session.register({ deviceUUID: "aaaabbbb-0000-0000-0000-000000000000" })
    ).rejects.toThrow();
  });

  it("[BLE3-0044] deviceUUID 無しで register() → reject (registerDeviceUUIDRequired)", async () => {
    const session = new SesameBleSession({
      transport: { connect() { return Promise.resolve(); }, write() {}, disconnect() { return Promise.resolve(); } },
      secretKey: undefined,
      profile: "lock",
      syncTime: false,
      mechStatusKind: "lock",
    });
    await expect(
      session.register({})
    ).rejects.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLE3-0045  registerOnce: register reject 時も try/finally で必ず close
// ═════════════════════════════════════════════════════════════════════════════
describe("[BLE3-0045] registerOnce: reject 時も finally で close", () => {

  it("[BLE3-0045] registerOnce は register 失敗時にも close() を呼ぶ (index.js:1141-1147)", async () => {
    const { SesameBle } = await import("../../src/ble/index.js");

    let closeCalled = false;
    const token = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const asm2 = new SegmentAssembler();
    const transport = {
      onPacket: null,
      connect(onPacket) {
        this.onPacket = onPacket;
        for (const s of splitSegments(
          Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.INITIAL]), token]),
          SEG.PLAINTEXT,
        )) onPacket(s);
        return Promise.resolve();
      },
      write(seg) {
        const a = asm2.feed(Buffer.from(seg));
        if (!a) return;
        const frame = a.data;
        const item = frame[0];
        if (item === ITEM.REGISTRATION) {
          // resultCode=5 (失敗) で応答
          for (const s of splitSegments(
            Buffer.from([OP.RESPONSE, ITEM.REGISTRATION, 0x05]),
            SEG.PLAINTEXT,
          )) this.onPacket(s);
        }
      },
      disconnect() {
        closeCalled = true;
        return Promise.resolve();
      },
    };

    await expect(
      SesameBle.registerOnce({ deviceUUID: "00000000-0000-0000-0000-999999999999", nowMs: Date.now(), model: "sesame_5", transport })
    ).rejects.toThrow();

    // finally で close() → transport.disconnect() が呼ばれていること
    expect(closeCalled).toBe(true);
  });

  it("[BLE3-0045] secretKey 付きで register() が即 reject されてもセッション状態は一貫", async () => {
    const transport = { connect: async () => {}, write: () => {}, disconnect: async () => {} };
    const session = new SesameBleSession({
      transport,
      secretKey: Buffer.from(DEFAULT_SECRET, "hex"),
    });
    try {
      await session.register({ deviceUUID: "uuid" });
    } catch { /* expected */ }
    expect(session._loggedIn).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLE3-0046  request: item ごと FIFO キューで response を 1:1 消費
// ═════════════════════════════════════════════════════════════════════════════
describe("[BLE3-0046] request: item ごと FIFO キューで response を 1:1 消費", () => {

  it("[BLE3-0046] 未ログイン状態で request → notLoggedIn reject", async () => {
    const { session } = await makeLoggedInSession();
    session._loggedIn = false;
    await expect(session.request(ITEM.MAGNET)).rejects.toThrow();
  });

  it("[BLE3-0046] 同一 item の request は FIFO 順に 1:1 で消費する", async () => {
    const { session } = await makeLoggedInSession();

    const results = [];
    const r1 = session.request(ITEM.MECH_SETTING,
      configureLockPositionData(100, 200), { timeoutMs: 3000 })
      .then(r => { results.push({ seq: 1, code: r.resultCode }); return r; });
    const r2 = session.request(ITEM.MECH_SETTING,
      configureLockPositionData(300, 400), { timeoutMs: 3000 })
      .then(r => { results.push({ seq: 2, code: r.resultCode }); return r; });

    await Promise.all([r1, r2]);
    expect(results.map(r => r.code)).toEqual([0, 0]);
    expect(results[0].seq).toBe(1);
    expect(results[1].seq).toBe(2);
  });

  it("[BLE3-0046] _resolvePending: resultCode=0 → FIFO の先頭 entry を resolve", () => {
    const transport = { connect: async () => {}, write: () => {}, disconnect: async () => {} };
    const session = new SesameBleSession({ transport });
    session._loggedIn = true;
    const itemCode = 42;
    let resolved = null;
    session._pending.set(itemCode, [{
      resolve: (v) => { resolved = v; },
      reject: () => {},
      timer: null,
    }]);
    const payload = Buffer.from([0x01, 0x02]);
    session._resolvePending(itemCode, 0, payload);
    expect(resolved).not.toBeNull();
    expect(resolved.resultCode).toBe(0);
    expect(resolved.payload).toEqual(payload);
    expect(session._pending.has(itemCode)).toBe(false);
  });

  it("[BLE3-0046] _resolvePending: resultCode!=0 → BleResultError reject", () => {
    const transport = { connect: async () => {}, write: () => {}, disconnect: async () => {} };
    const session = new SesameBleSession({ transport });
    session._loggedIn = true;
    const itemCode = 43;
    let rejected = null;
    session._pending.set(itemCode, [{
      resolve: () => {},
      reject: (e) => { rejected = e; },
      timer: null,
    }]);
    session._resolvePending(itemCode, 2, Buffer.alloc(0));
    expect(rejected).not.toBeNull();
    expect(rejected.resultCode).toBe(2);
    expect(rejected.itemCode).toBe(itemCode);
  });

  it("[BLE3-0046] _resolvePending: 同一 item に 2 件 → FIFO 順に消費", () => {
    const transport = { connect: async () => {}, write: () => {}, disconnect: async () => {} };
    const session = new SesameBleSession({ transport });
    session._loggedIn = true;
    const itemCode = 44;
    const results = [];
    session._pending.set(itemCode, [
      { resolve: (v) => results.push({ n: 1, v }), reject: () => {}, timer: null },
      { resolve: (v) => results.push({ n: 2, v }), reject: () => {}, timer: null },
    ]);
    session._resolvePending(itemCode, 0, Buffer.from([0x01]));
    expect(results).toHaveLength(1);
    expect(results[0].n).toBe(1);
    expect(session._pending.get(itemCode)).toHaveLength(1);

    session._resolvePending(itemCode, 0, Buffer.from([0x02]));
    expect(results).toHaveLength(2);
    expect(results[1].n).toBe(2);
  });

  it("[BLE3-0046] _resolvePending: キュー空(unsolicited)で呼んでも no-op", () => {
    const transport = { connect: async () => {}, write: () => {}, disconnect: async () => {} };
    const session = new SesameBleSession({ transport });
    expect(() => session._resolvePending(99, 0, Buffer.alloc(0))).not.toThrow();
  });

  it("[BLE3-0046] resultCode 非0 → BleResultError で reject する (統合)", async () => {
    // LOGIN は resultCode=0 で成功させてから、MECH_SETTING への応答を非0にする。
    const { session, mock } = await makeLoggedInSession();
    // login 後に responseCode を変える
    mock._responseCode = 3;
    await expect(
      session.request(ITEM.MECH_SETTING, configureLockPositionData(10, 20), { timeoutMs: 2000 })
    ).rejects.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLE3-0051  configureLockPosition data = lockTarget(LE2B) ++ unlockTarget(LE2B) = 4B
// ═════════════════════════════════════════════════════════════════════════════
describe("[BLE3-0051] configureLockPosition data = lockTarget(LE2B) ++ unlockTarget(LE2B) = 4B", () => {

  it("[BLE3-0051] lockTarget=100, unlockTarget=-200 → 4B LE (CHSesame5Device.kt:69)", () => {
    const result = configureLockPositionData(100, -200);
    expect(result.length).toBe(4);
    expect(result[0]).toBe(0x64);
    expect(result[1]).toBe(0x00);
    expect(result[2]).toBe(0x38);
    expect(result[3]).toBe(0xff);
  });

  it("[BLE3-0051] configureLockPositionData 純関数: 4B LE 出力", () => {
    const data = configureLockPositionData(0x1234, -1);
    expect(data.length).toBe(4);
    expect(data.readInt16LE(0)).toBe(0x1234);
    expect(data.readInt16LE(2)).toBe(-1);
  });

  it("[BLE3-0051] lockTarget=0, unlockTarget=0 → 4B all zero", () => {
    expect(configureLockPositionData(0, 0)).toEqual(Buffer.alloc(4, 0x00));
  });

  it("[BLE3-0051] lockTarget=32767 (max) → LE2B=[0xFF, 0x7F]", () => {
    const result = configureLockPositionData(32767, 0);
    expect(result[0]).toBe(0xff);
    expect(result[1]).toBe(0x7f);
  });

  it("[BLE3-0051] lockTarget=-32768 (min) → LE2B=[0x00, 0x80]", () => {
    const result = configureLockPositionData(-32768, 0);
    expect(result[0]).toBe(0x00);
    expect(result[1]).toBe(0x80);
  });

  it("[BLE3-0051] 範囲外 (-32769 / 32768) は throw する", () => {
    expect(() => configureLockPositionData(32768, 0)).toThrow();
    expect(() => configureLockPositionData(-32769, 0)).toThrow();
    expect(() => configureLockPositionData(0, 32768)).toThrow();
  });

  it("[BLE3-0051] item=MECH_SETTING(80)、data=4B LE で送る (統合確認)", async () => {
    const { session, mock } = await makeLoggedInSession();
    await session.configureLockPosition(100, -200);
    expect(mock.lastCommand).not.toBeNull();
    expect(mock.lastCommand.item).toBe(ITEM.MECH_SETTING);
    expect(mock.lastCommand.data.length).toBe(4);
    expect(mock.lastCommand.data.readInt16LE(0)).toBe(100);
    expect(mock.lastCommand.data.readInt16LE(2)).toBe(-200);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLE3-0052  magnet: item=17 空 payload (session.js:557-559)
// ═════════════════════════════════════════════════════════════════════════════
describe("[BLE3-0052] magnet: item=MAGNET(17) を空 ByteArray で request", () => {

  it("[BLE3-0052] ITEM.MAGNET は 17 (itemcodes.js:28)", () => {
    expect(ITEM.MAGNET).toBe(17);
  });

  it("[BLE3-0052] session.magnet() は item=17、data=空 で request する (CHSesame5Device.kt:118-126)", async () => {
    const { session, mock } = await makeLoggedInSession();
    await session.magnet();
    expect(mock.lastCommand).not.toBeNull();
    expect(mock.lastCommand.item).toBe(ITEM.MAGNET);
    expect(mock.lastCommand.data.length).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLE3-0053  opSensorControl data = 2B LE 秒数 (UShort)
// ═════════════════════════════════════════════════════════════════════════════
describe("[BLE3-0053] opSensorControl data = 2B LE UShort", () => {

  it("[BLE3-0053] seconds=0 → [0x00, 0x00]", () => {
    const result = opSensorControlData(0);
    expect(result.length).toBe(2);
    expect(result).toEqual(Buffer.from([0x00, 0x00]));
  });

  it("[BLE3-0053] seconds=60 → LE2B=[0x3c, 0x00]", () => {
    const result = opSensorControlData(60);
    expect(result[0]).toBe(0x3c);
    expect(result[1]).toBe(0x00);
  });

  it("[BLE3-0053] seconds=65535 (max UShort) → [0xFF, 0xFF]", () => {
    expect(opSensorControlData(0xffff)).toEqual(Buffer.from([0xff, 0xff]));
  });

  it("[BLE3-0053] 範囲外 (-1 / 65536) は throw する", () => {
    expect(() => opSensorControlData(-1)).toThrow();
    expect(() => opSensorControlData(65536)).toThrow();
  });

  it("[BLE3-0053] ITEM.OPS_CONTROL は 92", () => {
    expect(ITEM.OPS_CONTROL).toBe(92);
  });

  it("[BLE3-0053] item=OPS_CONTROL(92)、data=2B LE で送る (統合確認)", async () => {
    const { session, mock } = await makeLoggedInSession();
    await session.opSensorControl(300);
    expect(mock.lastCommand.item).toBe(ITEM.OPS_CONTROL);
    expect(mock.lastCommand.data.length).toBe(2);
    expect(mock.lastCommand.data.readUInt16LE(0)).toBe(300);
  });

  it("[BLE3-0053] 成功時に _lastOpsSetting.opsLockSecond が更新される (CHSesame5Device.kt:113)", async () => {
    const { session } = await makeLoggedInSession();
    expect(session.lastOpsSetting).toBeNull();
    await session.opSensorControl(120);
    expect(session.lastOpsSetting).not.toBeNull();
    expect(session.lastOpsSetting.opsLockSecond).toBe(120);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLE3-0054  setBleTxPower data = 符号付き 1B
// ═════════════════════════════════════════════════════════════════════════════
describe("[BLE3-0054] setBleTxPower data = 符号付き 1B (BLE_TX_POWER_SETTING=206)", () => {

  it("[BLE3-0054] txPower=0 → [0x00]", () => {
    const result = bleTxPowerData(0);
    expect(result.length).toBe(1);
    expect(result[0]).toBe(0x00);
  });

  it("[BLE3-0054] txPower=4 → [0x04]", () => {
    expect(bleTxPowerData(4)[0]).toBe(0x04);
  });

  it("[BLE3-0054] txPower=-10 → 符号付き 1B 0xF6", () => {
    expect(bleTxPowerData(-10).readInt8(0)).toBe(-10);
  });

  it("[BLE3-0054] txPower=-128 (min) → readInt8(0)=-128", () => {
    expect(bleTxPowerData(-128).readInt8(0)).toBe(-128);
  });

  it("[BLE3-0054] txPower=127 (max) → [0x7F]", () => {
    expect(bleTxPowerData(127)[0]).toBe(0x7f);
  });

  it("[BLE3-0054] 範囲外 (-129 / 128) は throw する", () => {
    expect(() => bleTxPowerData(128)).toThrow();
    expect(() => bleTxPowerData(-129)).toThrow();
  });

  it("[BLE3-0054] ITEM.SSM3_ITEM_CODE_BLE_TX_POWER_SETTING は 206", () => {
    expect(ITEM.SSM3_ITEM_CODE_BLE_TX_POWER_SETTING).toBe(206);
  });

  it("[BLE3-0054] item=206、data=1B writeInt8 で送る (統合確認)", async () => {
    const { session, mock } = await makeLoggedInSession();
    await session.setBleTxPower(-4);
    expect(mock.lastCommand.item).toBe(ITEM.SSM3_ITEM_CODE_BLE_TX_POWER_SETTING);
    expect(mock.lastCommand.data.length).toBe(1);
    expect(mock.lastCommand.data.readInt8(0)).toBe(-4);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLE3-0055  sendAdvProductType: item=205 raw ByteArray 素通し、非Buffer で throw
// ═════════════════════════════════════════════════════════════════════════════
describe("[BLE3-0055] sendAdvProductType: item=SET_ADV_PRODUCT_TYPE(205) raw 素通し", () => {

  it("[BLE3-0055] ITEM.SS3_ITEM_CODE_SET_ADV_PRODUCT_TYPE は 205", () => {
    expect(ITEM.SS3_ITEM_CODE_SET_ADV_PRODUCT_TYPE).toBe(205);
  });

  it("[BLE3-0055] item=205、data=渡した Buffer そのまま (CHSesame5Device.kt:85-94)", async () => {
    const { session, mock } = await makeLoggedInSession();
    const payload = Buffer.from([0x01, 0x02, 0x03]);
    await session.sendAdvProductType(payload);
    expect(mock.lastCommand.item).toBe(ITEM.SS3_ITEM_CODE_SET_ADV_PRODUCT_TYPE);
    expect(mock.lastCommand.data.equals(payload)).toBe(true);
  });

  it("[BLE3-0055] 空 Buffer は素通し", async () => {
    const { session, mock } = await makeLoggedInSession();
    await session.sendAdvProductType(Buffer.alloc(0));
    expect(mock.lastCommand.item).toBe(ITEM.SS3_ITEM_CODE_SET_ADV_PRODUCT_TYPE);
    expect(mock.lastCommand.data.length).toBe(0);
  });

  it("[BLE3-0055] 非Buffer を渡すと throw する (session.js:606)", async () => {
    const { session } = await makeLoggedInSession();
    expect(() => session.sendAdvProductType("not-a-buffer")).toThrow();
    expect(() => session.sendAdvProductType(123)).toThrow();
    expect(() => session.sendAdvProductType(null)).toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLE3-0056  readHistory: item=4 data=[0x01]、payload 先頭4B=recordId
// ═════════════════════════════════════════════════════════════════════════════
describe("[BLE3-0056] readHistory: item=HISTORY(4) data=[0x01]", () => {

  it("[BLE3-0056] historyReadData() は [0x01] を返す (固定 1B)", () => {
    const result = historyReadData();
    expect(result.length).toBe(1);
    expect(result[0]).toBe(0x01);
  });

  it("[BLE3-0056] ITEM.HISTORY は 4", () => {
    expect(ITEM.HISTORY).toBe(4);
  });

  it("[BLE3-0056] item=4、data=[0x01] で送り payload がそのまま返る (統合確認)", async () => {
    const { session, mock } = await makeLoggedInSession();
    const histPayload = Buffer.from([0x11, 0x22, 0x33, 0x44, 0xde, 0xad]);
    mock.enqueueResponse(ITEM.HISTORY, histPayload);
    const result = await session.readHistory();
    expect(mock.lastCommand.item).toBe(ITEM.HISTORY);
    expect(mock.lastCommand.data.equals(Buffer.from([0x01]))).toBe(true);
    expect(result.equals(histPayload)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLE3-0057  deleteHistory: item=18 data=historyPayload[0..3] (recordId 4B)
// ═════════════════════════════════════════════════════════════════════════════
describe("[BLE3-0057] deleteHistory: item=HISTORY_DELETE(18) data=recordId(先頭4B)", () => {

  it("[BLE3-0057] 4B 以上の payload から先頭 4B を返す (CHSesameOS3LockBase.kt:204)", () => {
    const payload = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
    const result = historyDeleteData(payload);
    expect(result.length).toBe(4);
    expect(result).toEqual(Buffer.from([0x01, 0x02, 0x03, 0x04]));
  });

  it("[BLE3-0057] 4B ちょうどはそのまま返す", () => {
    const payload = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
    expect(historyDeleteData(payload)).toEqual(payload);
  });

  it("[BLE3-0057] 3B (< 4B) → throw", () => {
    expect(() => historyDeleteData(Buffer.alloc(3))).toThrow();
    expect(() => historyDeleteData(Buffer.alloc(0))).toThrow();
  });

  it("[BLE3-0057] 非Buffer → throw", () => {
    expect(() => historyDeleteData("aabbccdd")).toThrow();
    expect(() => historyDeleteData(null)).toThrow();
  });

  it("[BLE3-0057] ITEM.HISTORY_DELETE は 18", () => {
    expect(ITEM.HISTORY_DELETE).toBe(18);
  });

  it("[BLE3-0057] item=18、data=先頭4B で送る (統合確認)", async () => {
    const { session, mock } = await makeLoggedInSession();
    const histPayload = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0x01, 0x02]);
    await session.deleteHistory(histPayload);
    expect(mock.lastCommand.item).toBe(ITEM.HISTORY_DELETE);
    expect(mock.lastCommand.data.equals(histPayload.subarray(0, 4))).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLE3-0060  MECH_STATUS(81) の解釈は mechStatusKind で静的ディスパッチ
// ═════════════════════════════════════════════════════════════════════════════
describe("[BLE3-0060] MECH_STATUS(81) publish は mechStatusKind で静的ディスパッチ", () => {

  /**
   * 指定 mechStatusKind の session を login 済みにして MECH_STATUS(81) publish を注入する。
   * login 応答直後に mechPayload を暗号化 publish として送信する。
   */
  async function makeMechStatusSession(mechStatusKind, mechPayload) {
    const token = DEFAULT_TOKEN;
    const secretBuf = Buffer.from(DEFAULT_SECRET, "hex");
    const key = deriveSessionKey(secretBuf, token);
    let encCount = 0;
    let decCount = 0;
    let onPacketRef = null;

    const asm2 = new SegmentAssembler();

    const transport = {
      connect(onPacket) {
        onPacketRef = onPacket;
        for (const s of splitSegments(
          Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.INITIAL]), token]),
          SEG.PLAINTEXT,
        )) onPacket(s);
        return Promise.resolve();
      },
      write(seg) {
        const a = asm2.feed(Buffer.from(seg));
        if (!a) return;
        let frame;
        if (a.type === SEG.CIPHERTEXT) {
          frame = ccmDecrypt(key, decCount++, token, a.data);
        } else {
          frame = a.data;
        }
        const item = frame[0];
        if (item === ITEM.LOGIN) {
          // login 応答
          const resp = Buffer.from([OP.RESPONSE, ITEM.LOGIN, 0x00, 0x00, 0x00, 0x00, 0x00]);
          const ct = ccmEncrypt(key, encCount++, token, resp);
          for (const s of splitSegments(ct, SEG.CIPHERTEXT)) onPacketRef(s);
          // 直後に MECH_STATUS(81) publish を emit
          const pub = Buffer.concat([
            Buffer.from([OP.PUBLISH, ITEM.MECH_STATUS]),
            mechPayload,
          ]);
          const pubCt = ccmEncrypt(key, encCount++, token, pub);
          for (const s of splitSegments(pubCt, SEG.CIPHERTEXT)) onPacketRef(s);
        }
      },
      disconnect() { return Promise.resolve(); },
    };

    const session = new SesameBleSession({
      transport,
      secretKey: secretBuf,
      profile: "lock",
      syncTime: false,
      mechStatusKind,
    });

    let lastStatus = null;
    session.onStatus(s => { lastStatus = s; });
    await session.connect();
    return { session, getLastStatus: () => lastStatus };
  }

  it("[BLE3-0060] kind='lock' → parseMechStatus(7B) でロック形式解釈 (CHSesameOS3LockBase)", async () => {
    // 7B: batteryRaw=0x1770, target=0x0000, position=0x0010, flags=0b00000010 (isInLockRange)
    const mechPayload = Buffer.from([0x70, 0x17, 0x00, 0x00, 0x10, 0x00, 0b00000010]);
    const { getLastStatus } = await makeMechStatusSession("lock", mechPayload);
    const s = getLastStatus();
    expect(s).not.toBeNull();
    expect(s.state).toBe("locked");
    expect(typeof s.position).toBe("number");
    expect(s.isInLockRange).toBe(true);
  });

  it("[BLE3-0060] kind='hub3' → parseNetworkStatus(1B) でネットワーク bit flags 解釈 (CHHub3Device.kt:291-301)", async () => {
    // 1B: bit1=isAp + bit2=isNet = 0b00000110
    const mechPayload = Buffer.from([0b00000110]);
    const { getLastStatus } = await makeMechStatusSession("hub3", mechPayload);
    const s = getLastStatus();
    expect(s).not.toBeNull();
    expect(s.isAp).toBe(true);
    expect(s.isNet).toBe(true);
    expect(s.isIot).toBe(false);
  });

  it("[BLE3-0060] kind='hub3' で 1B が来ても biometric 形に入らない (P3-18 修正)", async () => {
    const mechPayload = Buffer.from([0b00000100]); // bit2=isNet のみ
    const { getLastStatus } = await makeMechStatusSession("hub3", mechPayload);
    const s = getLastStatus();
    expect(s).not.toBeNull();
    expect(s.isNet).toBe(true);
    // hub3 形なら isAp フィールドが存在する
    expect("isAp" in s).toBe(true);
  });

  it("[BLE3-0060] kind='biometric' → raw 素通し (CHSesameBiometricDeviceImpl.kt:214-217)", async () => {
    const mechPayload = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
    const { getLastStatus } = await makeMechStatusSession("biometric", mechPayload);
    const s = getLastStatus();
    expect(s).not.toBeNull();
    // biometric では isAp (hub3 固有) フィールドは無い
    expect("isAp" in s).toBe(false);
  });

  it("[BLE3-0060] kind='bot' → parseMechStatus(3B) で Bot 形式解釈 (CHSesameBot2MechStatus)", async () => {
    // 3B Bot 形式: batteryRaw=0x0000, flags=0b00000010 (isInLockRange)
    const mechPayload = Buffer.from([0x00, 0x00, 0b00000010]);
    const { getLastStatus } = await makeMechStatusSession("bot", mechPayload);
    const s = getLastStatus();
    expect(s).not.toBeNull();
    expect(s.isInLockRange).toBe(true);
    expect(s.state).toBe("locked");
  });

  it("[BLE3-0060] parseNetworkStatus: 空 payload は throw する", () => {
    expect(() => parseNetworkStatus(Buffer.alloc(0))).toThrow();
  });

  it("[BLE3-0060] parseNetworkStatus: bit flags 展開 (CHHub3Device.kt:293-299 と 1:1)", () => {
    const s = parseNetworkStatus(Buffer.from([0b11111110]));
    expect(s.isAp).toBe(true);
    expect(s.isNet).toBe(true);
    expect(s.isIot).toBe(true);
    expect(s.isAPCheck).toBe(true);
    expect(s.isAPConnecting).toBe(true);
    expect(s.isNETConnecting).toBe(true);
    expect(s.isIOTConnecting).toBe(true);

    const s2 = parseNetworkStatus(Buffer.from([0x00]));
    expect(s2.isAp).toBe(false);
    expect(s2.isNet).toBe(false);
    expect(s2.isIOTConnecting).toBe(false);

    // bit7 (isIOTConnecting) = 0x80
    const s3 = parseNetworkStatus(Buffer.from([0x80]));
    expect(s3.isIOTConnecting).toBe(true);
    expect(s3.isAp).toBe(false);
  });
});
