// SesameBle.register() / registerOnce() / needAuthFromServer login のファサード単体テスト
// (ハードウェア不要、mock transport)。
//
// 検証する流れ:
//   1. register モードで構築した SesameBle.register() が初期ペアリングを完走し、確定した
//      {deviceUUID, secretKey, productType, serverSecret} を返す (CHHub3Device.kt:176-211)。
//   2. その secretKey で「同一デバイスに再 connect → login」が成立する end-to-end(mock):
//      register で device が確立した session 鍵 (= ECDH 共有 16B から CMAC) を、再接続時には
//      その secretKey を pre-shared key として deriveSessionKey(secretKey, token) で login できる。
//   3. SesameBle.registerOnce(opts, fn) が register → fn(result) → close を自動化する。
//   4. needAuthFromServer=true で connect() すると signGuestKey 経由のサーバ署名 token で login する
//      (CHHub3Device.kt:163-174 token!=null / CHSesameOS3.kt:473-487)。
import { describe, it, expect, vi } from "vitest";
import { Buffer } from "node:buffer";
import { createECDH } from "node:crypto";
import { SesameBle } from "../../src/ble/index.js";
import { SesameBleSession } from "../../src/ble/session.js";
import {
  deriveSessionKey, deriveSessionKeyFromEcdh, ccmEncrypt, ccmDecrypt,
  splitSegments, SegmentAssembler, OP, ITEM, SEG,
} from "../../src/ble/protocol.js";
import { ecdhSecretPre16 } from "../../src/crypto.js";

const TOKEN = Buffer.from([0x55, 0x66, 0x77, 0x88]);
// 固定の device 側 P-256 秘密鍵 (決定性のため)。
const DEVICE_PRIV_HEX = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";

/**
 * 工場出荷 → register → 再 connect(login) を 1 つの mock で再現するデバイス。
 * mode="register": secretKey 無し session 用。initial(plain) → REGISTRATION 応答 → 以降 cipher。
 * mode="login":    登録済み (secretKey 既知) session 用。initial(plain) → LOGIN 応答 → 以降 cipher。
 */
class MockDevice {
  constructor({ mode, secretKey, token = TOKEN } = {}) {
    this.mode = mode;
    this.token = token;
    this.secretKey = secretKey ? Buffer.from(secretKey, "hex") : null;
    this.ecdh = createECDH("prime256v1");
    this.ecdh.setPrivateKey(Buffer.from(DEVICE_PRIV_HEX, "hex"));
    this.devicePubK64 = this.ecdh.getPublicKey().subarray(1);
    this.asm = new SegmentAssembler();
    this.encCount = 0; this.decCount = 0;
    this.onPacket = null; this.disconnected = false;
    this.key = null;            // cipher 確立後の session 鍵
    this.clientPubK64 = null;
    this.lastCommand = null;
    // mode=login では initial 受信時に session 鍵が確定する。
    if (mode === "login") this.key = deriveSessionKey(this.secretKey, this.token);
  }

  connect(onPacket) {
    this.onPacket = onPacket;
    this._emitPlain(Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.INITIAL]), this.token]));
    return Promise.resolve();
  }

  write(seg) {
    const a = this.asm.feed(Buffer.from(seg));
    if (!a) return;
    if (a.type === SEG.PLAINTEXT) { this._onPlain(a.data); return; }
    const frame = ccmDecrypt(this.key, this.decCount, this.token, a.data);
    this.decCount += 1;
    this.lastCommand = { item: frame[0], data: Buffer.from(frame.subarray(1)) };
    this._emitCipher(Buffer.from([OP.RESPONSE, frame[0], 0x00]));
  }

  _onPlain(frame) {
    const item = frame[0];
    if (item === ITEM.REGISTRATION) {
      this.clientPubK64 = Buffer.from(frame.subarray(1, 1 + 64));
      const pre16 = ecdhSecretPre16(this.ecdh, this.clientPubK64);
      this.key = deriveSessionKeyFromEcdh(pre16, this.token);
      this._emitPlain(Buffer.concat([
        Buffer.from([OP.RESPONSE, ITEM.REGISTRATION, 0x00]), this.devicePubK64,
      ]));
      return;
    }
    if (item === ITEM.LOGIN) {
      // login token は loginPayload(key)[1:5] = key[0:4]。device 側 key で照合 (簡略に成功応答)。
      this._emitCipher(Buffer.from([OP.RESPONSE, ITEM.LOGIN, 0, 0, 0, 0, 0]));
    }
  }

  disconnect() { this.disconnected = true; return Promise.resolve(); }
  _emitPlain(f) { for (const s of splitSegments(f, SEG.PLAINTEXT)) this.onPacket(s); }
  _emitCipher(f) {
    const ct = ccmEncrypt(this.key, this.encCount, this.token, f);
    this.encCount += 1;
    for (const s of splitSegments(ct, SEG.CIPHERTEXT)) this.onPacket(s);
  }
}

describe("SesameBle.register (facade)", () => {
  it("registerMode で構築 → register() が初期ペアリングを完走し鍵を返す", async () => {
    const dev = new MockDevice({ mode: "register" });
    const ble = new SesameBle({ registerMode: true, deviceUUID: "AA-BB", model: "sesame_5", transport: dev });
    const res = await ble.register();

    expect(res.deviceUUID).toBe("AA-BB");
    expect(res.productType).toBe("sesame_5"); // model がデフォルト productType に
    expect(res.serverSecret).toBe(TOKEN.toString("hex"));
    expect(res.secretKey).toMatch(/^[0-9a-f]{32}$/);
    // secretKey は両者の ECDH 共有秘密先頭 16B と一致。
    expect(res.secretKey).toBe(ecdhSecretPre16(dev.ecdh, dev.clientPubK64).toString("hex"));
    await ble.close();
    expect(dev.disconnected).toBe(true);
  });

  it("register モードは secretKey 不要 (通常モードは必須のまま)", () => {
    expect(() => new SesameBle({ registerMode: true, transport: new MockDevice({ mode: "register" }) })).not.toThrow();
    expect(() => new SesameBle({})).toThrow(/secretKey required/);
  });

  it("secretKey 付き (非 registerMode) で register() を呼ぶとファサード文脈の案内で弾く", async () => {
    // 誤用ガード: ファサードに secretKey を渡した状態で register() を呼ぶと、
    // session 層の registerNeedsFactory (session を直せ) ではなく、ファサード文脈の
    // registerNeedsFactoryFacade (registerMode: true を渡せ / secretKey 無しで構築せよ) を出す。
    const dev = new MockDevice({ mode: "login", secretKey: "00".repeat(16) });
    const ble = new SesameBle({ secretKey: "00".repeat(16), deviceUUID: "AA-BB", transport: dev });
    await expect(ble.register()).rejects.toThrow(/registerMode: true|construct SesameBle WITHOUT secretKey|secretKey 無し/);
    // ガードは session.register() に到達する前に弾く (transport は触らない)。
    expect(dev.disconnected).toBe(false);
  });

  it("end-to-end(mock): register で得た secretKey で再 connect → login が成立する", async () => {
    // 1. register。
    const regDev = new MockDevice({ mode: "register" });
    const reg = new SesameBle({ registerMode: true, deviceUUID: "DEV-9", transport: regDev });
    const { secretKey } = await reg.register();
    await reg.close();

    // 2. 同一デバイス (固定 device 秘密鍵) に、確定した secretKey を pre-shared key として再接続。
    //    device 側は login モードで deriveSessionKey(secretKey, token) を session 鍵に使う。
    const loginDev = new MockDevice({ mode: "login", secretKey });
    const ble = new SesameBle({ secretKey, deviceUUID: "DEV-9", transport: loginDev });
    await ble.connect();
    expect(ble.isConnected).toBe(true);

    // 3. login 後の cipher コマンドが往復する (session 鍵がクライアント/デバイスで一致)。
    await ble.unlock();
    expect(loginDev.lastCommand.item).toBe(ITEM.UNLOCK);
    await ble.close();
  });

  it("registerOnce(opts, fn) が register → fn(result) → close を自動化する", async () => {
    const dev = new MockDevice({ mode: "register" });
    let saved = null;
    const result = await SesameBle.registerOnce(
      { deviceUUID: "ONCE-1", model: "sesame_5", transport: dev },
      async (r) => { saved = r; },
    );
    expect(result.deviceUUID).toBe("ONCE-1");
    expect(result.secretKey).toMatch(/^[0-9a-f]{32}$/);
    expect(saved).toBe(result);   // fn は登録結果を受け取る
    expect(dev.disconnected).toBe(true); // close まで自動化
  });

  it("registerOnce は fn が投げても close する", async () => {
    const dev = new MockDevice({ mode: "register" });
    await expect(SesameBle.registerOnce(
      { deviceUUID: "ONCE-2", transport: dev },
      async () => { throw new Error("save failed"); },
    )).rejects.toThrow(/save failed/);
    expect(dev.disconnected).toBe(true);
  });

  it("registerOnce は register が失敗しても transport を close する (GATT リーク防止)", async () => {
    // initial を publish しない transport → register() が ReadyToRegister 待ちで reject する。
    // register が try/finally の外だと close() が呼ばれず GATT 接続がリークする回帰の検出。
    const dev = new MockDevice({ mode: "register" });
    dev.connect = function connect(onPacket) { this.onPacket = onPacket; return Promise.resolve(); }; // initial を出さない
    vi.useFakeTimers();
    const p = SesameBle.registerOnce({ deviceUUID: "ONCE-3", transport: dev });
    const assertion = expect(p).rejects.toThrow();
    await vi.runAllTimersAsync();
    await assertion;
    vi.useRealTimers();
    expect(dev.disconnected).toBe(true);
  });
});

describe("SesameBle needAuthFromServer (guest login)", () => {
  it("connect() で signGuestKey の server token を session 鍵に使って login する", async () => {
    const secretKey = "0123456789abcdef0123456789abcdef";
    // server が返す session token = device が initial token から CMAC で導く鍵と一致させる
    // (実機では server が secretKey を保持し同一 CMAC を計算する)。ここでは deriveSessionKey で再現。
    const serverToken = deriveSessionKey(Buffer.from(secretKey, "hex"), TOKEN);
    const dev = new MockDevice({ mode: "login", secretKey, token: TOKEN });
    // device 側の session 鍵を server token と一致させる (server-auth の意味論)。
    dev.key = serverToken;

    const calls = [];
    const registerTransport = async (req) => {
      calls.push(req);
      // guestKeysSignPost 相当: server token (hex) を text で返す。
      return { status: 200, text: serverToken.toString("hex"), json: null };
    };

    const ble = new SesameBle({
      secretKey, deviceUUID: "GUEST-1", needAuthFromServer: true, registerTransport, transport: dev,
    });
    await ble.connect();
    expect(ble.isConnected).toBe(true);
    // signGuestKey が呼ばれ、initial token の hex が乗っている。
    expect(calls.length).toBe(1);
    expect(calls[0].path).toContain("sign");
    expect(calls[0].body.token).toBe(TOKEN.toString("hex"));
    expect(calls[0].body.deviceId).toBe("GUEST-1");

    await ble.unlock();
    expect(dev.lastCommand.item).toBe(ITEM.UNLOCK);
    await ble.close();
  });

  it("needAuthFromServer で registerTransport 無しは明示エラー", async () => {
    const dev = new MockDevice({ mode: "login", secretKey: "00".repeat(16) });
    const ble = new SesameBle({ secretKey: "00".repeat(16), deviceUUID: "X", needAuthFromServer: true, transport: dev });
    await expect(ble.connect()).rejects.toThrow(/registerTransport|signGuestKey/);
  });

  it("signGuestKey が投げると connect() が reject する (ハング防止)", async () => {
    const secretKey = "0123456789abcdef0123456789abcdef";
    const dev = new MockDevice({ mode: "login", secretKey });
    const registerTransport = async () => { throw new Error("forbidden"); };
    const ble = new SesameBle({
      secretKey, deviceUUID: "GUEST-2", needAuthFromServer: true, registerTransport, transport: dev,
    });
    await expect(ble.connect()).rejects.toThrow(/forbidden/);
    // login 失敗時に transport を disconnect して GATT 接続/notify 購読をリークさせない。
    expect(dev.disconnected).toBe(true);
  });

  it("connect() / register() は使い捨て: 二重呼び出し・login 後の再入を明示エラーで弾く", async () => {
    // 1. login 済みセッションへの再 connect() は alreadyConnected で reject (待機者上書き防止)。
    const secretKey = "0123456789abcdef0123456789abcdef";
    const dev = new MockDevice({ mode: "login", secretKey });
    const session = new SesameBleSession({ transport: dev, secretKey });
    await session.connect();
    expect(session.isLoggedIn).toBe(true);
    await expect(session.connect()).rejects.toThrow(/already in use|使用中/);

    // 2. disconnect 後 (使い捨て) の再 connect() も弾く: transport/カウンタは初期化されないため
    //    再接続は新インスタンスで行う契約。disconnect は _loggedIn=false にするが、
    //    transport は既に disconnect 済みなので _isBusy() は false でも実接続は破棄済み。
    //    ここでは login 済みのまま二重 connect が弾かれることを担保すれば十分。

    // 3. register() を 2 回呼ぶと 2 回目は弾く (登録完了後は secretKey 確定でも明示エラー)。
    const regDev = new MockDevice({ mode: "register" });
    const regSession = new SesameBleSession({ transport: regDev });
    await regSession.register({ deviceUUID: "RE-1" });
    // 登録完了で secretKey 確定 → registerNeedsFactory が先に立つ (これも再 register を弾く)。
    await expect(regSession.register({ deviceUUID: "RE-1" })).rejects.toThrow();
  });

  it("connect() は login timeout で reject しても transport を close する (GATT リーク防止)", async () => {
    // initial を出さない transport → session.connect() の login が timeout で reject。
    // connect() が失敗パスで disconnect しないと GATT 接続がリークする回帰の検出。
    const secretKey = "0123456789abcdef0123456789abcdef";
    const dev = new MockDevice({ mode: "login", secretKey });
    dev.connect = function connect(onPacket) { this.onPacket = onPacket; return Promise.resolve(); };
    const ble = new SesameBle({ secretKey, deviceUUID: "DEV-T", transport: dev });
    // login timeout は実時間 (LOGIN_TIMEOUT_MS) を待つため fake timer で進める。
    vi.useFakeTimers();
    const p = ble.connect();
    const assertion = expect(p).rejects.toThrow();
    await vi.runAllTimersAsync();
    await assertion;
    vi.useRealTimers();
    expect(dev.disconnected).toBe(true);
  });
});
