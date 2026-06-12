// SesameOS2BleSession.register() の server-auth 経路 (getRegisterKey 配線) end-to-end テスト。
//
// 検証する流れ (CHSesame2Device.kt:406-482 / CHServerAuth.kt:41-65):
//   initial(14) publish → secretKey 無しのため ReadyToRegister
//   → register() が READ IRER を PLAINTEXT 送出 → device が ER (= payload.drop(16)) を返す
//   → registerServer({ak, n=mSesameToken, e=ER, appPubK64, ...}) = getRegisterKey で {sig1, st, pubkey}
//   → app: ECDH(appKey, pubkey=登録公開鍵) → pre16、registerKey/ownerKey/sessionKey、cipher 確立
//   → CREATE REGISTRATION (sig1[0:4] ++ appPubK64 ++ serverToken) を PLAINTEXT 送出
//   → device が login publish (cipher) を返す → 登録完了。
//
// 配線の要点 (本テストの主眼):
//   - makeLocalRegisterServer (src/crypto.js) が getRegisterKey を registerServer 契約に適合させる。
//   - session が registerServer に渡す appPubK64 を ak として採用することで、
//     getRegisterKey の msg = decode(ak) ++ sessionToken と整合する (CHSesame2Device.kt の
//     ak=EccKey.getRegisterAK() = base64(app 公開鍵) と同じ意味)。
//
// ★UNVERIFIED: getRegisterKey の移植忠実性は未確定 (src/crypto.js のブロック注記参照)。
//   本テストは「kit 内で app↔device の鍵が一致し register が完走する」内部整合の確認であって、
//   実機 SESAME2/3/4 が返す sig1/pubkey との一致を保証するものではない。

import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import crypto, { createECDH } from "node:crypto";
// AES-CMAC は内製実装 (src/aes-cmac.js, RFC 4493)。旧 node-aes-cmac は P5-2 で除去。
import { aesCmac } from "../../src/aes-cmac.js";

import {
  OP, ITEM, SEG, SegmentAssembler, deriveRegisterKeys,
} from "../../src/ble/os2/protocol.js";
import { SesameOS2BleSession, BleResultError } from "../../src/ble/os2/session.js";
import { SesameOS2Ble } from "../../src/ble/os2/index.js";
import {
  deriveRegisterPriKey, ecdhSecretPre16, makeLocalRegisterServer,
} from "../../src/crypto.js";

// CMAC の戻りを Buffer に正規化 (device 側の独立再計算用)。
function cmacBuf(key, msg) {
  return aesCmac(key, msg); // 内製 aesCmac は常に Buffer を返す
}

// firmware 視点 cipher (os2.test.js と同じ鏡像 nonce: device→app は flag を落とす)。
function deviceNonce(counter, token8, flag) {
  const b = Buffer.alloc(5);
  let v = flag ? (counter | (0x80n << 32n)) : (counter & 0x7fffffffffn);
  for (let i = 0; i < 5; i++) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return Buffer.concat([b, token8]);
}
function makeDeviceCipher(key, token8) {
  let enc = 0n; let dec = 0n;
  return {
    encrypt(pt) {
      const iv = deviceNonce(enc, token8, false); enc += 1n;
      const c = crypto.createCipheriv("aes-128-ccm", key, iv, { authTagLength: 4 });
      c.setAAD(Buffer.from([0]), { plaintextLength: pt.length });
      return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
    },
    decrypt(ctTag) {
      const iv = deviceNonce(dec, token8, true); dec += 1n;
      const ct = ctTag.subarray(0, ctTag.length - 4);
      const tag = ctTag.subarray(ctTag.length - 4);
      const d = crypto.createDecipheriv("aes-128-ccm", key, iv, { authTagLength: 4 });
      d.setAAD(Buffer.from([0]), { plaintextLength: ct.length });
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]);
    },
  };
}

// 工場出荷 OS2 デバイスを模す mock。
//   - initial publish で mSesameToken を渡す。
//   - READ IRER に ER (= 16B junk ++ erHex) を PLAINTEXT 応答。
//   - CREATE REGISTRATION を受けたら、ER から登録 priKey を導出し、app 公開鍵と ECDH → pre16、
//     deriveRegisterKeys → sessionKey で mirror cipher を確立し、login publish (cipher) を返す。
function makeMockRegisterDevice({ mSesameToken, erHex }) {
  let onPacket = null;
  let deviceCipher = null;
  const appAsm = new SegmentAssembler();
  const seen = { irerRead: false, registration: null, ecdhPre16: null, sessionToken: null, ownerKey: null };

  const sendPlain = (frame) => {
    const header = (SEG.PLAINTEXT << 1) | 1;
    onPacket(Buffer.concat([Buffer.from([header]), frame]));
  };
  const sendCipher = (frame) => {
    const ct = deviceCipher.encrypt(frame);
    const header = (SEG.CIPHERTEXT << 1) | 1;
    onPacket(Buffer.concat([Buffer.from([header]), ct]));
  };

  const onAppSegment = (seg) => {
    const a = appAsm.feed(seg);
    if (!a) return;
    const frame = a.data; // register ハンドシェイクはすべて PLAINTEXT
    const op = frame[0];
    const item = frame[1];

    if (op === OP.READ && item === ITEM.IRER) {
      seen.irerRead = true;
      // payload = 16B (drop 対象) ++ ER。ER は erHex。
      const er = Buffer.from(erHex, "hex");
      const payload = Buffer.concat([Buffer.alloc(16, 0xaa), er]);
      // response = [RESPONSE, item, op, result, ...payload] (導出元: SesameProtocols.kt:15-19
      // SSM2ResponsePayload — cmdItCode=data[0], cmdOPCode=data[1], cmdResultCode=data[2])。
      sendPlain(Buffer.from([OP.RESPONSE, ITEM.IRER, OP.READ, 0x00, ...payload]));
      return;
    }

    if (op === OP.CREATE && item === ITEM.REGISTRATION) {
      // data = sig1[0:4] ++ appPubK64(64B) ++ serverToken(4B)。
      const data = frame.subarray(2);
      const sig1 = data.subarray(0, 4);
      const appPubK64 = data.subarray(4, 4 + 64);
      const serverToken = data.subarray(4 + 64);
      seen.registration = { sig1: Buffer.from(sig1), appPubK64: Buffer.from(appPubK64), serverToken: Buffer.from(serverToken) };

      // device は ER から登録 priKey を導出 (getRegisterKey が pubkey として返したのと同じ鍵)。
      const regPriKey = deriveRegisterPriKey(erHex);
      const devEcdh = createECDH("prime256v1");
      devEcdh.setPrivateKey(regPriKey);
      // app 公開鍵と ECDH → pre16 (app 側 ecdhSecretPre16(appKey, pubkey) と一致するはず)。
      const pre16 = ecdhSecretPre16(devEcdh, appPubK64);
      seen.ecdhPre16 = Buffer.from(pre16);
      const { ownerKey, sessionKey, sessionToken } = deriveRegisterKeys(pre16, serverToken, mSesameToken);
      // device 側も ownerKey を保持する (登録完了後の login で CMAC 鍵になる。CHSesame2Device.kt:453,462-469)。
      seen.ownerKey = Buffer.from(ownerKey);
      seen.sessionToken = Buffer.from(sessionToken);
      deviceCipher = makeDeviceCipher(sessionKey, sessionToken);

      // login publish (cipher) で登録完了を通知 (CHSesame2Device.kt:508-517)。
      const lr = Buffer.alloc(28);
      lr.writeUInt32BE(Math.floor(Date.now() / 1000), 0);
      lr[27] = 0x02; // mech_status flags = byte7 (CHSesame2.kt:37) → locked
      sendCipher(Buffer.from([OP.PUBLISH, ITEM.LOGIN, ...lr]));
      return;
    }
  };

  return {
    seen,
    transport: {
      async connect(cb) {
        onPacket = cb;
        sendPlain(Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.INITIAL]), mSesameToken]));
      },
      write(seg) { onAppSegment(Buffer.from(seg)); },
      async disconnect() {},
    },
  };
}

// 登録済み OS2 デバイスを模す login 用 mock (register→login 連続シナリオの後半)。
// device は登録時に保存した secretKey(=ownerKey) と、ER 由来の登録鍵ペア (sesame2PublicKey の
// 対になる秘密鍵) を持ち、Kotlin の login 検証手順 (CHSesame2Device.kt:233-252) を独立再計算する:
//   sessionToken = mAppToken4 ++ mSesameToken4
//   sessionAuth  = CMAC(secretKey=ownerKey, userIdx ++ appPub64 ++ sessionToken) の先頭 4B 一致
//   sessionKey   = CMAC(ECDH(regPriKey, appPub64)[0:16], sessionToken)
function makeMockLoginDevice({ deviceSecretKey, regPriKey, mSesameToken }) {
  let onPacket = null;
  let deviceCipher = null;
  const appAsm = new SegmentAssembler();
  const commands = [];

  const sendPlain = (frame) => {
    const header = (SEG.PLAINTEXT << 1) | 1;
    onPacket(Buffer.concat([Buffer.from([header]), frame]));
  };
  const sendCipher = (frame) => {
    const ct = deviceCipher.encrypt(frame);
    const header = (SEG.CIPHERTEXT << 1) | 1;
    onPacket(Buffer.concat([Buffer.from([header]), ct]));
  };

  const onAppSegment = (seg) => {
    const a = appAsm.feed(seg);
    if (!a) return;
    let frame = a.data;
    if (a.type === SEG.CIPHERTEXT) frame = deviceCipher.decrypt(frame);
    const op = frame[0];
    const item = frame[1];

    if (op === OP.SYNC && item === ITEM.LOGIN) {
      // loginPayload = userIdx(2B) ++ appPub64 ++ mAppToken4 ++ sessionAuth[0:4] (CHSesame2Device.kt:252)。
      const data = frame.subarray(2);
      const userIdx = data.subarray(0, 2);          // keyIndex "0000" = 2B
      const appPub = data.subarray(2, 2 + 64);
      const mAppToken = data.subarray(66, 70);
      const auth4 = data.subarray(70, 74);
      const st = Buffer.concat([mAppToken, mSesameToken]); // CHSesame2Device.kt:237
      // device 側検証: sessionAuth = CMAC(secretKey, userIdx ++ appPub ++ st) (CHSesame2Device.kt:238-243)。
      const expect4 = cmacBuf(deviceSecretKey, Buffer.concat([userIdx, appPub, st])).subarray(0, 4);
      if (!expect4.equals(auth4)) {
        // invalidSig(4) (SesameProtocols.kt:29 SesameResultCode)。
        sendPlain(Buffer.from([OP.RESPONSE, ITEM.LOGIN, OP.SYNC, 0x04]));
        return;
      }
      // sessionKey = CMAC(ECDH pre16, sessionToken) (CHSesame2Device.kt:246-251)。
      const devEcdh = createECDH("prime256v1");
      devEcdh.setPrivateKey(regPriKey);
      const pre16 = devEcdh.computeSecret(Buffer.concat([Buffer.from([0x04]), appPub])).subarray(0, 16);
      deviceCipher = makeDeviceCipher(cmacBuf(pre16, st), st);
      const lr = Buffer.alloc(28);
      lr.writeUInt32BE(Math.floor(Date.now() / 1000), 0);
      lr[27] = 0x02; // mech_status flags = byte7 (CHSesame2.kt:37) → locked
      // response = [RESPONSE, item, op, result] (SesameProtocols.kt:15-19)。
      sendPlain(Buffer.concat([Buffer.from([OP.RESPONSE, ITEM.LOGIN, OP.SYNC, 0x00]), lr]));
      return;
    }
    // 暗号化コマンド応答 (SesameProtocols.kt:15-19 の itemCode 先頭順)。
    commands.push(Buffer.from(frame));
    sendCipher(Buffer.from([OP.RESPONSE, item, op, 0x00]));
  };

  return {
    commands,
    transport: {
      async connect(cb) {
        onPacket = cb;
        sendPlain(Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.INITIAL]), mSesameToken]));
      },
      write(seg) { onAppSegment(Buffer.from(seg)); },
      async disconnect() {},
    },
  };
}

describe("OS2 register — server-auth (getRegisterKey 配線) over mock transport", () => {
  const mSesameToken = Buffer.from("99887766", "hex");
  // ER は可変長で良い (CMAC は長さ非依存)。実機相当に 16B 程度の hex を使う。
  const erHex = "00112233445566778899aabbccddeeff";

  it("makeLocalRegisterServer を registerServer に渡すと register() が完走し鍵が一致する", async () => {
    const mock = makeMockRegisterDevice({ mSesameToken, erHex });
    const session = new SesameOS2BleSession({ transport: mock.transport });

    const registerServer = makeLocalRegisterServer(); // getRegisterKey ベースのローカルアダプタ
    const res = await session.register({ deviceUUID: "OS2-REG-1", productType: "sesame_3", registerServer });

    // 戻り値の形 (CHSesame2Device.kt:462-469: CHDevice(..., keyIndex="0000",
    // secretKey=ownerKey.toHexString(), sesame2PublicKey))。
    expect(res.deviceUUID).toBe("OS2-REG-1");
    expect(res.secretKey).toMatch(/^[0-9a-f]{32}$/);  // ownerKey hex (16B)
    expect(res.keyIndex).toBe("0000");                // CHSesame2Device.kt:465
    expect(res.ownerKey).toBe(res.secretKey);         // secretKey = ownerKey (BLE2-04)
    expect(res.ecdhSecret).toMatch(/^[0-9a-f]{32}$/); // ECDH pre16 hex (中間値)
    expect(res.sesamePublicKey).toMatch(/^[0-9a-f]+$/);
    expect(res.serverSecret).toBe(mSesameToken.toString("hex"));
    expect(session.isLoggedIn).toBe(true);

    // ハンドシェイク順序: IRER read → REGISTRATION。
    expect(mock.seen.irerRead).toBe(true);
    expect(mock.seen.registration).not.toBeNull();

    // app↔device の ECDH pre16 が一致し (鍵配線の核心)、secretKey は pre16 ではなく
    // device 側が独立導出した ownerKey と一致する (CHSesame2Device.kt:453)。
    expect(res.ecdhSecret).toBe(mock.seen.ecdhPre16.toString("hex"));
    expect(res.secretKey).toBe(mock.seen.ownerKey.toString("hex"));
    expect(res.secretKey).not.toBe(res.ecdhSecret);
  });

  it("REGISTRATION payload の pubkey は getRegisterKey の pubkey (= ER 由来) と一致する", async () => {
    const mock = makeMockRegisterDevice({ mSesameToken, erHex });
    const session = new SesameOS2BleSession({ transport: mock.transport });
    const res = await session.register({
      deviceUUID: "OS2-REG-2", registerServer: makeLocalRegisterServer(),
    });

    // app が ECDH した相手 (sesamePublicKey) は、ER から導いた登録鍵の公開鍵。
    // getRegisterKey の pubkey は SDK priKeyToPubKey の drop(27) = **64B (X‖Y, prefix 無し)**
    // (CHServerAuth.kt:138。SPKI 91B − 27B。EccKey.ecdh の fixheader が 04 を補う)。
    const regPriKey = deriveRegisterPriKey(erHex);
    const devEcdh = createECDH("prime256v1");
    devEcdh.setPrivateKey(regPriKey);
    const expectedPub64 = devEcdh.getPublicKey().subarray(1); // X ‖ Y 64B = drop(27)
    expect(res.sesamePublicKey).toBe(expectedPub64.toString("hex"));
    expect(Buffer.from(res.sesamePublicKey, "hex").length).toBe(64);
  });

  it("register → login 連続: 戻り値 {secretKey, keyIndex, sesamePublicKey} をそのまま login に使える (acceptance)", async () => {
    // 前半: register (工場出荷 mock)。
    const mock = makeMockRegisterDevice({ mSesameToken, erHex });
    const session = new SesameOS2BleSession({ transport: mock.transport });
    const res = await session.register({ deviceUUID: "OS2-REG-LOGIN", registerServer: makeLocalRegisterServer() });
    await session.disconnect();

    // 後半: device は登録時に保存した ownerKey と ER 由来の登録鍵で login に応じる
    // (CHSesame2Device.kt:233-252 の検証手順を device 側で独立再計算)。
    const loginMock = makeMockLoginDevice({
      deviceSecretKey: mock.seen.ownerKey,          // device が保存した secretKey = ownerKey
      regPriKey: deriveRegisterPriKey(erHex),       // sesame2PublicKey の対になる秘密鍵
      mSesameToken,
    });
    const ble = new SesameOS2Ble({
      transport: loginMock.transport,
      secretKey: res.secretKey,           // ← register 戻り値をそのまま使う
      keyIndex: res.keyIndex,             // "0000"
      ssmPublicKey: res.sesamePublicKey,  // 64B hex
    });
    await ble.connect();
    expect(ble.isConnected).toBe(true);
    // 暗号化コマンドも往復する = sessionKey (ECDH 経由) も一致している。
    const r = await ble.lock();
    expect(r.resultCode).toBe(0);
    expect(loginMock.commands.at(-1)[1]).toBe(ITEM.LOCK);
    await ble.close();
  });

  it("旧契約の誤用 (ecdhSecret=pre16 を secretKey に使う) は device 側 invalidSig で拒否される", async () => {
    // BLE2-04 の根本原因の再現: 旧 register は pre16 を secretKey として返しており、
    // それを login に渡すと CMAC(pre16,…) ≠ CMAC(ownerKey,…) で実機は invalidSig を返す。
    const mock = makeMockRegisterDevice({ mSesameToken, erHex });
    const session = new SesameOS2BleSession({ transport: mock.transport });
    const res = await session.register({ deviceUUID: "OS2-REG-BAD", registerServer: makeLocalRegisterServer() });
    await session.disconnect();

    const loginMock = makeMockLoginDevice({
      deviceSecretKey: mock.seen.ownerKey,
      regPriKey: deriveRegisterPriKey(erHex),
      mSesameToken,
    });
    const ble = new SesameOS2Ble({
      transport: loginMock.transport,
      secretKey: res.ecdhSecret, // ← 誤用: pre16 を渡す
      keyIndex: res.keyIndex,
      ssmPublicKey: res.sesamePublicKey,
    });
    const err = await ble.connect().then(() => null, (e) => e);
    expect(err).toBeInstanceOf(BleResultError);
    expect(err.resultName).toBe("invalidSig");
  });

  it("ファサード localServerAuth:true で registerServer を自動生成して register できる", async () => {
    const mock = makeMockRegisterDevice({ mSesameToken, erHex });
    const ble = new SesameOS2Ble({
      transport: mock.transport, registerMode: true, localServerAuth: true, model: "sesame_4",
    });
    const res = await ble.register({ deviceUUID: "OS2-REG-3" });
    expect(res.secretKey).toMatch(/^[0-9a-f]{32}$/);
    // secretKey = ownerKey (CHSesame2Device.kt:466)。pre16 は ecdhSecret として別フィールド。
    expect(res.secretKey).toBe(mock.seen.ownerKey.toString("hex"));
    expect(res.ecdhSecret).toBe(mock.seen.ecdhPre16.toString("hex"));
    await ble.close();
  });

  it("registerOnce + localServerAuth で scan 無し (transport 注入) register が完走する", async () => {
    const mock = makeMockRegisterDevice({ mSesameToken, erHex });
    const saved = [];
    const res = await SesameOS2Ble.registerOnce(
      { transport: mock.transport, localServerAuth: true, deviceUUID: "OS2-REG-4" },
      async (r) => { saved.push(r); },
    );
    expect(res.secretKey).toMatch(/^[0-9a-f]{32}$/);
    expect(saved).toHaveLength(1);
    expect(saved[0].secretKey).toBe(res.secretKey);
  });

  it("既存の BLE-only register は不変: registerServer も localServerAuth も無いと明示エラー", async () => {
    const mock = makeMockRegisterDevice({ mSesameToken, erHex });
    // session 直叩き: registerServer 無しは従来どおり明示エラー (後方互換)。
    const session = new SesameOS2BleSession({ transport: mock.transport });
    await expect(session.register({ deviceUUID: "X" })).rejects.toThrow(/registerServer/);

    // ファサード: localServerAuth も registerServer も無ければ register() は従来どおり拒否。
    const mock2 = makeMockRegisterDevice({ mSesameToken, erHex });
    const ble = new SesameOS2Ble({ transport: mock2.transport, registerMode: true });
    await expect(ble.register({ deviceUUID: "X" })).rejects.toThrow(/registerServer/);
  });

  it("明示 registerServer は localServerAuth より優先される", async () => {
    const mock = makeMockRegisterDevice({ mSesameToken, erHex });
    let explicitCalled = false;
    // 明示 registerServer は getRegisterKey を内部で使いつつ呼ばれたことを記録する。
    const explicit = (req) => { explicitCalled = true; return makeLocalRegisterServer()(req); };
    const ble = new SesameOS2Ble({
      transport: mock.transport, registerMode: true,
      registerServer: explicit, localServerAuth: true, // 両方指定 → explicit 優先
    });
    const res = await ble.register({ deviceUUID: "OS2-REG-5" });
    expect(explicitCalled).toBe(true);
    expect(res.secretKey).toMatch(/^[0-9a-f]{32}$/);
    await ble.close();
  });
});
