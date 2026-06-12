// WM2 専用セッション層 (profile "wm2") のハンドシェイクテスト (P1-6)。
//
// 重要: モック session 注入では「セッション確立がロックと共通」という誤解を検出できないため、
// ここでは **実セッション層 (SesameBleSession)** を mock transport で駆動し、ワイヤ上の
// バイト列を Kotlin の式から手計算した固定ベクタと突き合わせる。
//
// 参照 (すべて _sesame_sdk_ref/sesame-sdk/.../ble/os3/):
//   - CHWifiModule2Device.kt:279-312  register override (REGISTER_WM2(1) + pubK64 のみ /
//       応答 payload.sliceArray(0..63) を ECDH / cipher 鍵 = ecdhSecret_pre16 生)
//   - CHWifiModule2Device.kt:314-321  login override (loginTag = AesCmac(secretKey 生 16B)
//       .computeMac(mSesameToken) **16B 全量** / cipher 鍵 = secretKey 生 / sault = mSesameToken)
//   - CHWifiModule2Device.kt:521-528  INITIAL 判定 (cmdItCode == WM2ActionCode.INITIAL)
//   - CHWifiModule2Device.kt:539-541  WM2ActionCode enum (INITIAL=13, LOGIN_WM2=2, REGISTER_WM2=1)
//   - base/SesameOS3BleCipher.kt:8-32 nonce = encryptCounter.toBytes()(8B LE) + sault → WM2 は 12B
import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import { createECDH } from "node:crypto";
import { SesameBleSession, BleResultError } from "../../src/ble/session.js";
import {
  loginPayload, registrationData, ccmSault, ccmEncrypt, ccmDecrypt,
  splitSegments, SegmentAssembler, OP, ITEM, SEG, SESSION_PROFILES,
} from "../../src/ble/protocol.js";
import { ecdhSecretPre16 } from "../../src/crypto.js";

// ---------- 固定ベクタ (Kotlin の式から独立実装で導出) ----------
//
// secretKey = 00112233445566778899aabbccddeeff (16B) / mSesameToken = 01020304 (4B) として:
//
//   loginTag = AES-128-CMAC(secretKey, token4)            … CHWifiModule2Device.kt:316
//            = f50c4785a936182f84ace9dda414343f            (RFC4493 を AES-ECB から独立実装して算出。
//                                                          runtime の内製 aesCmac (src/aes-cmac.js) とも一致確認済み)
//   login frame = [LOGIN_WM2(2)] ++ loginTag 16B 全量      … kt:318 (先頭 4B に切り詰めない)
//   cipher 鍵 = secretKey 生 16B / sault = token4          … kt:317 (CMAC 鍵ではない・0x00 を挟まない)
//   nonce(count) = count 8B LE ++ token4 = 12B             … SesameOS3BleCipher.kt:13-14
//
//   client→device 暗号フレーム #0: 平文 [UPDATE_WIFI_SSID(3), 'n','e','t']
//     AES-128-CCM(key=secretKey, nonce=000000000000000001020304, AAD=[00], tag4)
//     = 36ffedd34f36bf53 (ct 4B ++ tag 4B)
//   device→client 暗号フレーム #0: 平文 [RESPONSE(7), LOGIN_WM2(2), success(0)]
//     = 3293883d4bed45
//   device→client 暗号フレーム #1: 平文 [RESPONSE(7), 3, 0]
//     = 45394f732dee90
const SECRET_HEX = "00112233445566778899aabbccddeeff";
const TOKEN = Buffer.from("01020304", "hex");
const LOGIN_TAG_HEX = "f50c4785a936182f84ace9dda414343f";
const EXPECTED_LOGIN_FRAME = Buffer.concat([Buffer.from([2]), Buffer.from(LOGIN_TAG_HEX, "hex")]); // 17B
const EXPECTED_CMD_CIPHER_HEX = "36ffedd34f36bf53";   // [3,"net"] @ enc count 0
const LOGIN_RESP_CIPHER_HEX = "3293883d4bed45";       // [7,2,0]   @ device enc count 0
const CMD_RESP_CIPHER_HEX = "45394f732dee90";         // [7,3,0]   @ device enc count 1

/**
 * WM2 鏡像 mock transport (login 用)。受信した login frame / 暗号コマンドの **生バイト列** を
 * 記録し、応答は上記の固定ベクタ (hex 直書き) をそのまま流す — つまりこの mock は自実装の
 * ccmEncrypt に依存せず device→client 方向のバイト列を固定する。
 */
class FixedVectorWM2 {
  constructor({ emitInitial14First = false } = {}) {
    this.emitInitial14First = emitInitial14First;
    this.asm = new SegmentAssembler();
    this.onPacket = null;
    /** @type {Buffer[]} 完全フレームに組み上がった client→device 書き込み (平文/暗号文の生バイト) */
    this.frames = [];
    this.disconnected = false;
  }
  connect(onPacket) {
    this.onPacket = onPacket;
    if (this.emitInitial14First) {
      // ロックの INITIAL(14) を先に流す — wm2 profile はこれを initial として扱ってはならない
      this._emitPlain(Buffer.concat([Buffer.from([OP.PUBLISH, 14]), TOKEN]));
    }
    // WM2 の initial publish: [PUBLISH(8), WM2ActionCode.INITIAL(13), token4] (kt:521-528, 540)
    this._emitPlain(Buffer.concat([Buffer.from([OP.PUBLISH, 13]), TOKEN]));
    return Promise.resolve();
  }
  write(seg) {
    const a = this.asm.feed(Buffer.from(seg));
    if (!a) return;
    this.frames.push({ type: a.type, data: Buffer.from(a.data) });
    if (a.type === SEG.PLAINTEXT && a.data[0] === 2) {
      // login への応答 (固定ベクタ)。device 側 enc count 0。
      this._emitCipherRaw(Buffer.from(LOGIN_RESP_CIPHER_HEX, "hex"));
      return;
    }
    if (a.type === SEG.CIPHERTEXT) {
      // コマンドへの応答 (固定ベクタ)。device 側 enc count 1。
      this._emitCipherRaw(Buffer.from(CMD_RESP_CIPHER_HEX, "hex"));
    }
  }
  disconnect() { this.disconnected = true; return Promise.resolve(); }
  _emitPlain(f) { for (const s of splitSegments(f, SEG.PLAINTEXT)) this.onPacket(s); }
  _emitCipherRaw(ct) { for (const s of splitSegments(ct, SEG.CIPHERTEXT)) this.onPacket(s); }
}

describe("protocol.js プロファイル分岐 (P1-6 純関数)", () => {
  it("SESSION_PROFILES: initial itemCode は lock=14 / wm2=13 (WM2ActionCode.INITIAL, kt:540)", () => {
    expect(SESSION_PROFILES.lock.initialItemCode).toBe(14);
    expect(SESSION_PROFILES.wm2.initialItemCode).toBe(13);
  });

  it("loginPayload: lock は [2]++鍵[0:4]=5B (不変)、wm2 は [2]++CMAC16B 全量=17B (kt:318)", () => {
    const tag = Buffer.from(LOGIN_TAG_HEX, "hex");
    const lock = loginPayload(tag);
    expect(lock.length).toBe(5);
    expect(lock.equals(Buffer.concat([Buffer.from([2]), tag.subarray(0, 4)]))).toBe(true);
    const wm2 = loginPayload(tag, "wm2");
    expect(wm2.length).toBe(17);
    expect(wm2.equals(EXPECTED_LOGIN_FRAME)).toBe(true);
  });

  it("ccmSault: lock = 0x00++token (5B、CHHub3Device.kt:170,203)、wm2 = token 生 4B (kt:297,317)", () => {
    expect(ccmSault("lock", TOKEN).equals(Buffer.concat([Buffer.from([0]), TOKEN]))).toBe(true);
    expect(ccmSault("wm2", TOKEN).equals(TOKEN)).toBe(true);
    expect(() => ccmSault("nope", TOKEN)).toThrow(/profile/);
  });

  it("ccmEncrypt(profile=wm2) は 12B nonce で固定ベクタと一致 (SesameOS3BleCipher.kt:13)", () => {
    const key = Buffer.from(SECRET_HEX, "hex");
    const frame = Buffer.concat([Buffer.from([3]), Buffer.from("net", "utf8")]);
    expect(ccmEncrypt(key, 0, TOKEN, frame, "wm2").toString("hex")).toBe(EXPECTED_CMD_CIPHER_HEX);
    // lock profile (既定) は別バイト列になる (13B nonce) — sault 取り違えの検出
    expect(ccmEncrypt(key, 0, TOKEN, frame).toString("hex")).not.toBe(EXPECTED_CMD_CIPHER_HEX);
    // 復号も対称
    expect(ccmDecrypt(key, 0, TOKEN, Buffer.from(EXPECTED_CMD_CIPHER_HEX, "hex"), "wm2").equals(frame)).toBe(true);
  });

  it("registrationData: lock は pubK64++ts4=68B (不変)、wm2 は pubK64 のみ (kt:290)", () => {
    const pub = Buffer.alloc(64, 0xab);
    expect(registrationData(pub, 1605929466482).length).toBe(68);
    const wm2 = registrationData(pub, 1605929466482, "wm2");
    expect(wm2.length).toBe(64);
    expect(wm2.equals(pub)).toBe(true);
  });

  it("未知プロファイルは明示エラー (黙って lock 扱いしない)", () => {
    expect(() => new SesameBleSession({ transport: { connect() {}, write() {}, disconnect() {} }, profile: "x" }))
      .toThrow(/profile/);
  });
});

describe("WM2 handshake — 実セッション層 × 固定ベクタ (P1-6)", () => {
  it("INITIAL(13) → login 17B 平文 → 暗号コマンドが Kotlin 由来ベクタと byte 一致で完走する", async () => {
    const dev = new FixedVectorWM2();
    const session = new SesameBleSession({ transport: dev, secretKey: SECRET_HEX, profile: "wm2" });
    await session.connect();
    expect(session.isLoggedIn).toBe(true);

    // login frame: [LOGIN_WM2(2)] ++ CMAC(secretKey, token) 16B 全量 (kt:316-318)。
    // 旧 lock 実装の [2]++CMAC[0:4] (5B) では一致しない。
    const login = dev.frames.find((f) => f.type === SEG.PLAINTEXT);
    expect(login).toBeTruthy();
    expect(login.data.toString("hex")).toBe(EXPECTED_LOGIN_FRAME.toString("hex"));

    // device→client の固定ベクタ応答 (鍵 = secretKey 生 / nonce 12B) を復号できた = login 成立。
    // 続けてコマンドを送り、client→device の暗号バイト列がベクタと一致することを確認。
    const res = await session.request(3, Buffer.from("net", "utf8")); // UPDATE_WIFI_SSID(3)
    expect(res.resultCode).toBe(0);
    const cipherFrames = dev.frames.filter((f) => f.type === SEG.CIPHERTEXT);
    expect(cipherFrames.length).toBe(1);
    expect(cipherFrames[0].data.toString("hex")).toBe(EXPECTED_CMD_CIPHER_HEX);
  });

  it("wm2 profile はロックの INITIAL(14) を initial として扱わない (kt:521-528 は 13 のみ)", async () => {
    const dev = new FixedVectorWM2({ emitInitial14First: true });
    const session = new SesameBleSession({ transport: dev, secretKey: SECRET_HEX, profile: "wm2" });
    await session.connect();
    // INITIAL(14) では login を送らず、13 を受けてから 1 回だけ login する。
    const logins = dev.frames.filter((f) => f.type === SEG.PLAINTEXT && f.data[0] === 2);
    expect(logins.length).toBe(1);
    expect(logins[0].data.length).toBe(17);
  });

  it("wm2 profile は signLogin (サーバ認証 login) を明示エラーで拒否する (kt に該当経路なし)", async () => {
    const dev = new FixedVectorWM2();
    const session = new SesameBleSession({ transport: dev, secretKey: SECRET_HEX, profile: "wm2" });
    await expect(session.connect({ signLogin: async () => "00".repeat(16) }))
      .rejects.toThrow(/signLogin|server-auth|サーバ認証/);
  });

  it("login 応答が非 0 resultCode なら BleResultError (固定ベクタの resultCode を書き換え)", async () => {
    // [7,2,4(invalidSig)] @ device enc count 0 を鍵=secret生/nonce12B で暗号化 (鏡像)。
    class FailLogin extends FixedVectorWM2 {
      write(seg) {
        const a = this.asm.feed(Buffer.from(seg));
        if (!a) return;
        if (a.type === SEG.PLAINTEXT && a.data[0] === 2) {
          const ct = ccmEncrypt(Buffer.from(SECRET_HEX, "hex"), 0, TOKEN, Buffer.from([OP.RESPONSE, 2, 4]), "wm2");
          this._emitCipherRaw(ct);
        }
      }
    }
    const session = new SesameBleSession({ transport: new FailLogin(), secretKey: SECRET_HEX, profile: "wm2" });
    const err = await session.connect().then(() => null, (e) => e);
    expect(err).toBeInstanceOf(BleResultError);
    expect(err.resultCode).toBe(4);
    expect(err.resultName).toBe("invalidSig");
  });
});

describe("WM2 register — 実セッション層 (P1-6)", () => {
  // 固定の device 側 P-256 秘密鍵 (決定性のためハードコード。session-register.test.js と同値)。
  const DEVICE_PRIV_HEX = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";

  /** WM2 register の鏡像 mock。REGISTER_WM2(1)+pubK64 を受け、devicePubK64 を平文で返す。
   *  登録後の cipher は **鍵 = ecdhSecret_pre16 生 / sault = token4** (kt:295-297) を鏡像実装。 */
  class RegisterWM2 {
    constructor() {
      this.ecdh = createECDH("prime256v1");
      this.ecdh.setPrivateKey(Buffer.from(DEVICE_PRIV_HEX, "hex"));
      this.devicePubK64 = this.ecdh.getPublicKey().subarray(1); // 0x04 prefix を剥がした 64B
      this.asm = new SegmentAssembler();
      this.onPacket = null;
      this.plainWrites = [];
      this.cipherWrites = [];
      this.clientPubK64 = null;
      this.pre16 = null;
      this.encCount = 0;
      this.decCount = 0;
      this.disconnected = false;
    }
    connect(onPacket) {
      this.onPacket = onPacket;
      this._emitPlain(Buffer.concat([Buffer.from([OP.PUBLISH, 13]), TOKEN])); // INITIAL=13
      return Promise.resolve();
    }
    write(seg) {
      const a = this.asm.feed(Buffer.from(seg));
      if (!a) return;
      if (a.type === SEG.PLAINTEXT) {
        this.plainWrites.push(Buffer.from(a.data));
        if (a.data[0] === ITEM.REGISTRATION) {
          // data は pubK64 **のみ** (timestamp 無し、kt:290)。65B 超過 = lock 形 (68B+1) は弾く。
          this.clientPubK64 = Buffer.from(a.data.subarray(1));
          // device 側 ECDH → pre16 (kt:295: EccKey.ecdh(payload[0..63]).sliceArray(0..15) の鏡像)
          this.pre16 = ecdhSecretPre16(this.ecdh, this.clientPubK64.subarray(0, 64));
          // 応答は平文: [RESPONSE(7), REGISTRATION(1), 0] ++ devicePubK64
          this._emitPlain(Buffer.concat([Buffer.from([OP.RESPONSE, ITEM.REGISTRATION, 0]), this.devicePubK64]));
        }
        return;
      }
      // 登録後 cipher: 鍵 = pre16 **生** / sault = token4 (kt:295-297)。
      const frame = ccmDecrypt(this.pre16, this.decCount, TOKEN, a.data, "wm2");
      this.decCount += 1;
      this.cipherWrites.push(Buffer.from(frame));
      const ct = ccmEncrypt(this.pre16, this.encCount, TOKEN, Buffer.from([OP.RESPONSE, frame[0], 0]), "wm2");
      this.encCount += 1;
      for (const s of splitSegments(ct, SEG.CIPHERTEXT)) this.onPacket(s);
    }
    disconnect() { this.disconnected = true; return Promise.resolve(); }
    _emitPlain(f) { for (const s of splitSegments(f, SEG.PLAINTEXT)) this.onPacket(s); }
  }

  it("REGISTER data は [1]++pubK64 (65B、timestamp 無し) で、登録後は pre16 生鍵 + 12B nonce で往復する", async () => {
    const dev = new RegisterWM2();
    const session = new SesameBleSession({ transport: dev, profile: "wm2" });
    const res = await session.register({ deviceUUID: "WM2-1", productType: "wm_2" });

    // 送信フレーム = [REGISTRATION(1)] ++ pubK64 のみ = 65B (lock の 69B = [1]++64++ts4 ではない)。
    expect(dev.plainWrites.length).toBe(1);
    expect(dev.plainWrites[0].length).toBe(1 + 64);
    expect(dev.plainWrites[0][0]).toBe(ITEM.REGISTRATION);

    // secretKey(=wm2Key) = ECDH 共有秘密の先頭 16B の hex (kt:295-296)。
    const expectedPre16 = ecdhSecretPre16(dev.ecdh, dev.clientPubK64);
    expect(res.secretKey).toBe(expectedPre16.toString("hex"));
    expect(res.serverSecret).toBe(TOKEN.toString("hex"));
    expect(session.isLoggedIn).toBe(true);

    // 登録直後の暗号コマンドが「鍵 = pre16 生 / sault = token4」の鏡像 cipher で復号できる
    // (lock の CMAC(pre16, token) 鍵・13B nonce では device 側 ccmDecrypt が tag 不一致で throw する)。
    const r = await session.request(6, Buffer.alloc(0)); // NETWORK_STATUS(6)
    expect(r.resultCode).toBe(0);
    expect(dev.cipherWrites.length).toBe(1);
    expect(dev.cipherWrites[0][0]).toBe(6);
  });

  it("register 応答が 64B 未満なら registerDevicePubKeyLen で reject (kt:295 sliceArray(0..63))", async () => {
    class ShortResp extends RegisterWM2 {
      write(seg) {
        const a = this.asm.feed(Buffer.from(seg));
        if (!a || a.type !== SEG.PLAINTEXT || a.data[0] !== ITEM.REGISTRATION) return;
        this._emitPlain(Buffer.concat([Buffer.from([OP.RESPONSE, ITEM.REGISTRATION, 0]), Buffer.alloc(32)]));
      }
    }
    const session = new SesameBleSession({ transport: new ShortResp(), profile: "wm2" });
    await expect(session.register({ deviceUUID: "X" })).rejects.toThrow(/64/);
  });
});
