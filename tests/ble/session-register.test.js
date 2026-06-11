// SesameBleSession.register() — 工場出荷 (未登録) デバイスの初期ペアリング /
// 登録ハンドシェイクの単体テスト (ハードウェア不要)。
//
// 検証する流れ (CHHub3Device.kt:176-211, CHSesameOS3.kt:468-492):
//   initial(14) publish 受信 → secretKey 無しのため login せず ReadyToRegister へ遷移
//   → register() が REGISTRATION(1) を PLAINTEXT 送出 (pubK64 ++ timestamp4)
//   → device が response(7)+REGISTRATION(1)+resultCode0+devicePubK(64B) を返す
//   → 両者の ECDH 共有秘密先頭 16B から secretKey(=wm2Key)/sessionKey を確定
//   → 以降は cipher (enc/decCount=0) で通信。
//
// MockRegisterSesame は固定の device 秘密鍵を使い、ECDH を鏡像で再現する
// (固定ベクタで secretKey / sessionKey の決定性を検証する)。
import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import { createECDH } from "node:crypto";
import { SesameBleSession, BleResultError } from "../../src/ble/session.js";
import {
  deriveSessionKeyFromEcdh, ccmEncrypt, ccmDecrypt, splitSegments, SegmentAssembler,
  OP, ITEM, SEG,
} from "../../src/ble/protocol.js";
import { ecdhSecretPre16 } from "../../src/crypto.js";

const TOKEN = Buffer.from([0x11, 0x22, 0x33, 0x44]);

// 固定の device 側 P-256 秘密鍵 (32B, スカラ 0x01..0x20)。決定性のためハードコード。
const DEVICE_PRIV_HEX = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";

// SS5 実機形 (77B) の register 応答先頭 13B。
//   mechStatus(7B): batteryRaw=0x0c80(LE), target=0x0000, position=0x0010, flags=0x02(isInLockRange)
//   mechSetting(6B): lockPosition=0x000a, unlockPosition=0x0014, autoLockSecond=0x001e
const SS5_MECH_STATUS_7B = Buffer.from([0x80, 0x0c, 0x00, 0x00, 0x10, 0x00, 0x02]);
const SS5_MECH_SETTING_6B = Buffer.from([0x0a, 0x00, 0x14, 0x00, 0x1e, 0x00]);

// Bot2/Bike2 形 (67B) の register 応答先頭 3B = CHSesameBot2MechStatus / CHSesameBike2MechStatus
// (CHSesameBot2Device.kt:216 / CHSesameBike2Device.kt:110: payload.sliceArray(0..2))。
//   data[0..1]=batteryRaw=0x0c80(LE), data[2]=flags=0x02 (bit1 isInLockRange)
const BOT2_MECH_STATUS_3B = Buffer.from([0x80, 0x0c, 0x02]);

/** 工場出荷 (未登録) デバイスを模す mock transport。固定 device 鍵で ECDH を鏡像再現。
 *  registerResponseShape:
 *    "hub3"(64B=pubkey 全体) | "ss5"(77B=mechStatus7++mechSetting6++pubkey64)
 *    | "bot2"(67B=mechStatus3++pubkey64、CHSesameBot2Device.kt:216-219 / CHSesameBike2Device.kt:110-113
 *      の catch 分岐から導出)。 */
class MockRegisterSesame {
  constructor({ token = TOKEN, regResult = 0, registerResponseShape = "hub3" } = {}) {
    this.token = token;
    this.regResult = regResult;
    this.registerResponseShape = registerResponseShape;
    this.ecdh = createECDH("prime256v1");
    this.ecdh.setPrivateKey(Buffer.from(DEVICE_PRIV_HEX, "hex"));
    this.devicePubK65 = this.ecdh.getPublicKey();       // 0x04 ‖ X ‖ Y = 65B
    this.devicePubK64 = this.devicePubK65.subarray(1);  // SDK 契約 = prefix 無し 64B
    this.asm = new SegmentAssembler();
    this.encCount = 0; // device→client
    this.decCount = 0; // client→device (登録後の cipher 用)
    this.onPacket = null;
    this.writes = [];
    this.plainWrites = [];
    this.cipherWrites = [];
    this.disconnected = false;
    this.clientPubK64 = null; // REGISTRATION で受け取るクライアント公開鍵
    this.key = null;          // 確立後の session key
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
    if (a.type === SEG.PLAINTEXT) {
      this.plainWrites.push(Buffer.from(a.data));
      const frame = a.data;
      const item = frame[0];
      if (item === ITEM.REGISTRATION) {
        // data = pubK64(64B) ++ timestamp4
        this.clientPubK64 = Buffer.from(frame.subarray(1, 1 + 64));
        // device 側 ECDH: client pubK64 と device 秘密鍵で共有秘密先頭 16B。
        const pre16 = ecdhSecretPre16(this.ecdh, this.clientPubK64);
        this.key = deriveSessionKeyFromEcdh(pre16, this.token);
        // response(7)+REGISTRATION(1)+resultCode+payload を PLAINTEXT で返す
        // (cipher はまだ未確立 — registration 応答は平文)。
        //   hub3: payload = devicePubK64 (64B)
        //   ss5 : payload = mechStatus7 ++ mechSetting6 ++ devicePubK64 (77B)
        //   bot2: payload = mechStatus3 ++ devicePubK64 (67B)
        const regPayload = this.registerResponseShape === "ss5"
          ? Buffer.concat([SS5_MECH_STATUS_7B, SS5_MECH_SETTING_6B, this.devicePubK64])
          : this.registerResponseShape === "bot2"
            ? Buffer.concat([BOT2_MECH_STATUS_3B, this.devicePubK64])
            : this.devicePubK64;
        this._emitPlain(Buffer.concat([
          Buffer.from([OP.RESPONSE, ITEM.REGISTRATION, this.regResult]),
          regPayload,
        ]));
      }
      return;
    }
    // 登録後の cipher コマンド。
    const frame = ccmDecrypt(this.key, this.decCount, this.token, a.data);
    this.decCount += 1;
    this.cipherWrites.push(Buffer.from(frame));
    const item = frame[0];
    // 任意コマンドは response(7)+item+resultCode0 を cipher で返す。
    this._emitCipher(Buffer.from([OP.RESPONSE, item, 0x00]));
  }

  disconnect() { this.disconnected = true; return Promise.resolve(); }

  _emitPlain(frame) { for (const s of splitSegments(frame, SEG.PLAINTEXT)) this.onPacket(s); }
  _emitCipher(frame) {
    const ct = ccmEncrypt(this.key, this.encCount, this.token, frame);
    this.encCount += 1;
    for (const s of splitSegments(ct, SEG.CIPHERTEXT)) this.onPacket(s);
  }
}

// 固定ベクタ: client 秘密鍵を固定すれば secretKey/sessionKey は決定的になる。
// client 秘密鍵 0x21.. を固定し、session 構築後に内部 keyPair を差し替える…のは設計上
// できない (register() が内部生成) ため、ここでは「両者の ECDH が一致する」ことと
// 「ハードコードした device 鍵から導かれる secretKey が再現できる」ことを照合する。
// 決定性ベクタは device 鍵が固定なので、同一 client 鍵に対し常に同一値になる。

describe("SesameBleSession.register (登録ハンドシェイク)", () => {
  it("secretKey 無しで構築 → connect 不要で register() が初期ペアリングを完走する", async () => {
    const dev = new MockRegisterSesame();
    const session = new SesameBleSession({ transport: dev });
    expect(session.isReadyToRegister).toBe(false);

    const res = await session.register({ deviceUUID: "AA-BB", productType: "sesame_5" });

    // 戻り値の形 (CHHub3Device.kt:196-208)。
    expect(res.deviceUUID).toBe("AA-BB");
    expect(res.productType).toBe("sesame_5");
    expect(res.serverSecret).toBe(TOKEN.toString("hex")); // = mSesameToken hex
    expect(typeof res.secretKey).toBe("string");
    expect(res.secretKey).toMatch(/^[0-9a-f]{32}$/); // 16B hex

    // secretKey は両者の ECDH 共有秘密先頭 16B と一致する (決定性照合)。
    const expectedPre16 = ecdhSecretPre16(dev.ecdh, dev.clientPubK64);
    expect(res.secretKey).toBe(expectedPre16.toString("hex"));

    // ハンドシェイクのバイト順序: initial → REGISTRATION(plain) → response → cipher。
    expect(dev.plainWrites.length).toBe(1); // client が送った plain は REGISTRATION のみ
    expect(dev.plainWrites[0][0]).toBe(ITEM.REGISTRATION);
    // REGISTRATION data = pubK64(64B) ++ timestamp4 = 68B。
    expect(dev.plainWrites[0].length).toBe(1 + 64 + 4);
  });

  it("register 完走後は cipher セッションが確立し request が暗号で往復する", async () => {
    const dev = new MockRegisterSesame();
    const session = new SesameBleSession({ transport: dev });
    await session.register({ deviceUUID: "AA-BB" });

    expect(session.isLoggedIn).toBe(true);
    // 登録直後は cipher 未送信。
    expect(dev.cipherWrites.length).toBe(0);

    const r = await session.request(ITEM.LOCK, Buffer.from([0x00, 0x0e]));
    expect(r.resultCode).toBe(0);
    // device が cipher を復号して LOCK を受け取れた = sessionKey/カウンタが一致。
    expect(dev.cipherWrites.length).toBe(1);
    expect(dev.cipherWrites[0][0]).toBe(ITEM.LOCK);
  });

  it("client/device の sessionKey は固定 token で deriveSessionKeyFromEcdh と一致する", async () => {
    const dev = new MockRegisterSesame();
    const session = new SesameBleSession({ transport: dev });
    const res = await session.register({ deviceUUID: "AA-BB" });

    // device 側が導いた key は client 側 (register 内) と同一のはず。
    const pre16 = ecdhSecretPre16(dev.ecdh, dev.clientPubK64);
    const sessionKey = deriveSessionKeyFromEcdh(pre16, TOKEN);
    expect(dev.key.equals(sessionKey)).toBe(true);
    // secretKey も pre16 hex と一致。
    expect(res.secretKey).toBe(pre16.toString("hex"));
  });

  it("registerTransport 指定時は registerSesame5 をコールし、失敗してもログのみで継続", async () => {
    const dev = new MockRegisterSesame();
    const session = new SesameBleSession({ transport: dev });
    const calls = [];
    // 常に失敗する register transport。register() は握りつぶして継続するはず。
    const failingTransport = async (req) => { calls.push(req); throw new Error("boom"); };

    const res = await session.register({
      deviceUUID: "DEV-1",
      productType: 0, // sesame_5 系の productType を数値で
      registerTransport: failingTransport,
    });

    expect(calls.length).toBe(1); // registerSesame5 がコールされた
    expect(calls[0].method).toBe("POST");
    expect(calls[0].path).toContain("DEV-1");
    // 失敗しても BLE 登録自体は完走する。
    expect(res.secretKey).toMatch(/^[0-9a-f]{32}$/);
    expect(session.isLoggedIn).toBe(true);
  });

  it("device が REGISTRATION に非0 resultCode を返すと BleResultError で reject", async () => {
    const dev = new MockRegisterSesame({ regResult: 5 }); // notFound
    const session = new SesameBleSession({ transport: dev });
    const err = await session.register({ deviceUUID: "AA-BB" }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(BleResultError);
    expect(err.resultCode).toBe(5);
    expect(err.itemCode).toBe(ITEM.REGISTRATION);
    expect(session.isLoggedIn).toBe(false);
  });

  it("secretKey 付きで構築した session の register() は工場出荷専用エラーで reject", async () => {
    const dev = new MockRegisterSesame();
    const session = new SesameBleSession({ transport: dev, secretKey: "00".repeat(16) });
    await expect(session.register({ deviceUUID: "AA-BB" })).rejects.toThrow(/factory|工場出荷/);
  });

  it("deviceUUID 無しの register() は reject", async () => {
    const dev = new MockRegisterSesame();
    const session = new SesameBleSession({ transport: dev });
    await expect(session.register({})).rejects.toThrow(/deviceUUID/);
  });

  it("既存 connect()/login (secretKey 必須) は不変: secretKey 無し connect は reject", async () => {
    const dev = new MockRegisterSesame();
    const session = new SesameBleSession({ transport: dev });
    await expect(session.connect()).rejects.toThrow(/secretKey/);
  });

  it("ready 待機中に disconnect() されると register() の await が reject される (ハング防止)", async () => {
    // initial を流さない transport にすることで register() を readyPromise 待機で止める。
    class SilentTransport {
      connect(onPacket) { this.onPacket = onPacket; return Promise.resolve(); }
      write() {}
      disconnect() { return Promise.resolve(); }
    }
    const session = new SesameBleSession({ transport: new SilentTransport() });
    const regP = session.register({ deviceUUID: "AA-BB" });
    // microtask を 1 周回して readyPromise 待機 (_readyWaiter 登録) に入らせる。
    await Promise.resolve();
    await session.disconnect();
    await expect(regP).rejects.toThrow(/disconnect/i);
  });

  it("login 待機中に disconnect() されると connect() の await が reject される (ハング防止)", async () => {
    // initial を流さない transport で connect() を loginPromise 待機で止める。
    class SilentTransport {
      connect(onPacket) { this.onPacket = onPacket; return Promise.resolve(); }
      write() {}
      disconnect() { return Promise.resolve(); }
    }
    const session = new SesameBleSession({ transport: new SilentTransport(), secretKey: "00".repeat(16) });
    const connP = session.connect();
    await Promise.resolve();
    await session.disconnect();
    await expect(connP).rejects.toThrow(/disconnect/i);
  });

  it("SS5 実機形 (77B) 応答: mechStatus/mechSetting を parse しつつ末尾64Bで ECDH 完走", async () => {
    const dev = new MockRegisterSesame({ registerResponseShape: "ss5" });
    const session = new SesameBleSession({ transport: dev });
    const res = await session.register({ deviceUUID: "SS5-1", productType: "sesame_5" });

    // 末尾 64B を device pubkey として ECDH → secretKey は Hub3 形と同じ導出 (= pre16 hex)。
    const expectedPre16 = ecdhSecretPre16(dev.ecdh, dev.clientPubK64);
    expect(res.secretKey).toBe(expectedPre16.toString("hex"));
    expect(session.isLoggedIn).toBe(true);

    // 先頭 7B mechStatus が parse されキャッシュへ (flags bit1 = isInLockRange)。
    expect(session.lastStatus).not.toBeNull();
    expect(session.lastStatus.isInLockRange).toBe(true);
    expect(session.lastStatus.state).toBe("locked");
    expect(session.lastStatus.position).toBe(0x0010);
    expect(session.lastStatus.batteryRaw).toBe(0x0c80);

    // 次 6B mechSetting も parse されキャッシュへ (LE i16)。
    expect(session.lastMechSetting).toEqual({
      lockPosition: 0x000a,
      unlockPosition: 0x0014,
      autoLockSecond: 0x001e,
    });

    // cipher セッションが確立し request が暗号往復する (sessionKey 一致の確認)。
    const r = await session.request(ITEM.LOCK, Buffer.from([0x00, 0x0e]));
    expect(r.resultCode).toBe(0);
    expect(dev.cipherWrites[0][0]).toBe(ITEM.LOCK);
  });

  it("Bot2/Bike2 形 (67B) 応答: 先頭 3B を mechStatus として parse し、payload[3..66] で ECDH 完走 (P1-8)", async () => {
    // 導出元: CHSesameBot2Device.kt:216-219 / CHSesameBike2Device.kt:110-113 (catch 分岐) —
    //   mechStatus = CHSesameBot2MechStatus(payload.sliceArray(0..2))
    //   ecdhSecretPre16 = EccKey.ecdh(payload.sliceArray(3..66)).sliceArray(0..15)
    const dev = new MockRegisterSesame({ registerResponseShape: "bot2" });
    const session = new SesameBleSession({ transport: dev });
    const res = await session.register({ deviceUUID: "BOT2-1", productType: "bot_2" });

    // payload[3..66] を device pubkey として ECDH → secretKey = pre16 hex (Hub3/SS5 形と同じ導出)。
    const expectedPre16 = ecdhSecretPre16(dev.ecdh, dev.clientPubK64);
    expect(res.secretKey).toBe(expectedPre16.toString("hex"));
    expect(session.isLoggedIn).toBe(true);

    // 先頭 3B mechStatus が parse されキャッシュへ (3B → parseMechStatusBot: flags=data[2])。
    expect(session.lastStatus).not.toBeNull();
    expect(session.lastStatus.isInLockRange).toBe(true);
    expect(session.lastStatus.state).toBe("locked");
    expect(session.lastStatus.batteryRaw).toBe(0x0c80);
    expect(session.lastStatus.position).toBeNull(); // Bot/Bike に position/target は無い
    // mechSetting は同梱されない (67B 形に mechSetting 領域は無い)。
    expect(session.lastMechSetting).toBeNull();

    // cipher セッションが確立し request が暗号往復する (sessionKey = CMAC(pre16, token) は lock 共通)。
    const r = await session.request(ITEM.CLICK, Buffer.from([0x00, 0x0e]));
    expect(r.resultCode).toBe(0);
    expect(dev.cipherWrites[0][0]).toBe(ITEM.CLICK);
  });

  it("SS5 形 (77B) と Hub3 形 (64B) は同一 device 鍵なら同じ secretKey を導く", async () => {
    const hub3 = new MockRegisterSesame({ registerResponseShape: "hub3" });
    const ss5 = new MockRegisterSesame({ registerResponseShape: "ss5" });
    const sHub3 = new SesameBleSession({ transport: hub3 });
    const sSs5 = new SesameBleSession({ transport: ss5 });
    const rHub3 = await sHub3.register({ deviceUUID: "H" });
    const rSs5 = await sSs5.register({ deviceUUID: "S" });
    // device 鍵は同一 (DEVICE_PRIV_HEX 固定)。client 鍵は各 register で別生成なので secretKey 自体は
    // 異なるが、どちらも「自身の client 鍵 × 同一 device 鍵」の pre16 hex (16B/32hex) に一致する。
    expect(rHub3.secretKey).toMatch(/^[0-9a-f]{32}$/);
    expect(rSs5.secretKey).toMatch(/^[0-9a-f]{32}$/);
    // Hub3 形は mechStatus/mechSetting を応答から取らない (publish 経由) → キャッシュは null のまま。
    expect(sHub3.lastStatus).toBeNull();
    expect(sHub3.lastMechSetting).toBeNull();
    // SS5 形は応答同梱を parse 済み。
    expect(sSs5.lastStatus).not.toBeNull();
    expect(sSs5.lastMechSetting).not.toBeNull();
  });

  it("register 応答が 64/67/77 以外の長さなら registerDevicePubKeyLen で reject", async () => {
    // 応答 payload を 50B にする変則 transport。
    class BadLenTransport extends MockRegisterSesame {
      write(seg) {
        this.writes.push(Buffer.from(seg));
        const a = this.asm.feed(Buffer.from(seg));
        if (!a || a.type !== SEG.PLAINTEXT) return;
        const frame = a.data;
        if (frame[0] !== ITEM.REGISTRATION) return;
        this.clientPubK64 = Buffer.from(frame.subarray(1, 1 + 64));
        this._emitPlain(Buffer.concat([
          Buffer.from([OP.RESPONSE, ITEM.REGISTRATION, 0x00]),
          Buffer.alloc(50),
        ]));
      }
    }
    const dev = new BadLenTransport();
    const session = new SesameBleSession({ transport: dev });
    await expect(session.register({ deviceUUID: "X" })).rejects.toThrow(/64|77/);
    expect(session.isLoggedIn).toBe(false);
  });

  it("initial 受信で ReadyToRegister へ遷移する (login を試みない)", async () => {
    const dev = new MockRegisterSesame();
    const session = new SesameBleSession({ transport: dev });
    // connect() は secretKey 必須なので transport を直接駆動して initial だけ流す。
    await dev.connect((p) => session._onPacket(p));
    expect(session.isReadyToRegister).toBe(true);
    expect(session.isLoggedIn).toBe(false);
    // login(2) を平文送出していないこと。
    expect(dev.plainWrites.length).toBe(0);
    expect(dev.writes.length).toBe(0);
  });
});
