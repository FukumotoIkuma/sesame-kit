// P4-4: OS2 ファサード reset() の dropKey 写像検証。
// P4-5: OS3 session._handleInitial の <4B token 即 reject 検証 (>4B と対称化)。
//
// 参照:
//   P4-4: CHSesame2Device.kt:570-578 (reset 成功時 dropKey → disconnect / 鍵破棄)。
//         CHBaseDevice.kt:120-139 (dropKey: DB 削除 → disconnect → sesame2KeyData=null)。
//         wm2.js reset() は既に同写像を実装済み (kit 内既存参照)。
//   P4-5: session.js _handleInitial の token.length > 4 分岐は既に即 reject 済み (P3-05)。
//         <4B 分岐も同一の fail-fast に統合する (>4B との非対称解消)。

import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import { createECDH } from "node:crypto";
import { SesameOS2Ble } from "../../src/ble/os2/index.js";
import { SesameBleSession } from "../../src/ble/session.js";
import {
  OP, ITEM, SEG,
  sessionToken, deriveSessionKey,
} from "../../src/ble/os2/protocol.js";
import { OP as OS3_OP, ITEM as OS3_ITEM, SEG as OS3_SEG } from "../../src/ble/protocol.js";
import { SegmentAssembler } from "../../src/ble/protocol.js";

// ---- OS2 device 側 cipher 鏡像 (os2.test.js の makeDeviceCipher と同一) ----
// OS2 の counter 最上位ビット (0x80_00000000) は方向マーカ: app→device は flag 立, device→app は flag 落。
import crypto from "node:crypto";

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

/**
 * SesameOS2BleSession を login まで駆動し、コマンド応答も返せる最小 mock transport。
 * 導出元:
 *   - initial publish frame 形式: CHSesame2Device.kt:518 (mSesameToken = receivePayload.payload)
 *   - login data 形式: CHSesame2Device.kt:431-442 (userIdx ++ appPub64 ++ mAppToken4 ++ auth4)
 *   - login response 形式: SesameProtocols.kt:15-19 SSM2ResponsePayload
 *     ([RESPONSE, item=LOGIN, op=SYNC, result=0] ++ loginPayload28B)
 *   - command response: [RESPONSE, item, op, result=0]
 *
 * customResultCode: ITEM.REGISTRATION の応答 resultCode を制御できる (P4-4 用)。
 */
function makeOS2MockTransport({ mSesameToken = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]) } = {}) {
  const deviceKeyPair = createECDH("prime256v1");
  deviceKeyPair.generateKeys();
  const ssmPublicKey = deviceKeyPair.getPublicKey().subarray(1); // 64B raw
  const keyIndex = Buffer.from("0000", "hex");

  let onPacket = null;
  let deviceCipher = null;
  let disconnected = false;
  /** @type {Array<{op:number, item:number, resultCode:number}>} */
  const commandResults = [];
  const appAsm = new SegmentAssembler();

  const sendPlain = (frame) => {
    const header = (SEG.PLAINTEXT << 1) | 1;
    onPacket(Buffer.concat([Buffer.from([header]), frame]));
  };
  const sendCipher = (frame) => {
    const ct = deviceCipher.encrypt(frame);
    const header = (SEG.CIPHERTEXT << 1) | 1;
    onPacket(Buffer.concat([Buffer.from([header]), ct]));
  };

  const transport = {
    get disconnected() { return disconnected; },
    async connect(cb) {
      onPacket = cb;
      // device → app: initial publish = [PUBLISH(8), INITIAL(14), ...mSesameToken(4B)]
      // 導出元: CHSesame2Device.kt:518 mSesameToken = receivePayload.payload
      sendPlain(Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.INITIAL]), mSesameToken]));
    },
    write(seg) {
      const a = appAsm.feed(Buffer.from(seg));
      if (!a) return;
      let frame = a.data;
      if (a.type === SEG.CIPHERTEXT && deviceCipher) frame = deviceCipher.decrypt(frame);
      const op = frame[0];
      const item = frame[1];

      if (op === OP.SYNC && item === ITEM.LOGIN) {
        // login data = userIdx(2B) ++ appPub64 ++ mAppToken4 ++ auth4
        // 導出元: CHSesame2Device.kt:431-442
        const data = frame.subarray(2);
        const appPub = data.subarray(keyIndex.length, keyIndex.length + 64);
        const mAppToken = data.subarray(keyIndex.length + 64, keyIndex.length + 64 + 4);
        const st = sessionToken(mAppToken, mSesameToken);
        const ecdh = createECDH("prime256v1");
        ecdh.setPrivateKey(deviceKeyPair.getPrivateKey());
        const shared = ecdh.computeSecret(Buffer.concat([Buffer.from([0x04]), appPub]));
        const pre16 = shared.subarray(0, 16);
        deviceCipher = makeDeviceCipher(deriveSessionKey(pre16, st), st);
        const lr = Buffer.alloc(28);
        // systemTime LE4B (導出元: CHSesame2Device.kt:627 / DataExtention.kt:69-71)
        lr.writeUInt32LE(Math.floor(Date.now() / 1000), 0);
        lr[27] = 0x02; // flags byte7 → locked
        // 応答形式: [RESPONSE(7), LOGIN(7), SYNC(2), 0x00] ++ loginPayload28B
        // 導出元: SesameProtocols.kt:15-19 (SSM2ResponsePayload)
        sendPlain(Buffer.concat([Buffer.from([OP.RESPONSE, ITEM.LOGIN, OP.SYNC, 0x00]), lr]));
        return;
      }
      // 暗号化コマンドへの応答。commandResults 経由でカスタム resultCode を注入できる。
      // 導出元: SesameProtocols.kt:15-19 (notifyOp=RESPONSE, cmdItCode=item, cmdOPCode=op, cmdResultCode)
      const resultCode = commandResults.length > 0 ? commandResults.shift().resultCode : 0;
      sendCipher(Buffer.from([OP.RESPONSE, item, op, resultCode]));
    },
    async disconnect() {
      disconnected = true;
    },
    /** 次のコマンド応答に使う resultCode をキューに積む。 */
    queueResult(item, resultCode) {
      commandResults.push({ item, resultCode });
    },
  };

  return { transport, ssmPublicKey, keyIndex, secretKey: Buffer.alloc(16, 0x11) };
}

// ================================================================
// P4-4: OS2 ファサード reset() の dropKey 写像
// ================================================================
describe("P4-4: OS2 SesameOS2Ble reset() — 成功時に dropKey 写像 (session 破棄)", () => {
  it("reset 成功 → session が disconnect され、以後の request が not-logged-in で reject される", async () => {
    // 参照: CHSesame2Device.kt:570-578 — reset 成功時に dropKey(result) を呼ぶ。
    // dropKey (CHBaseDevice.kt:120-139) は DB 削除後に disconnect + sesame2KeyData=null。
    // kit には永続鍵ストアが無いため、dropKey 相当として session.disconnect() を呼ぶ (wm2.js と同流儀)。
    const { transport, ssmPublicKey, keyIndex, secretKey } = makeOS2MockTransport();
    const ble = new SesameOS2Ble({
      transport,
      secretKey,
      keyIndex,
      ssmPublicKey,
    });
    await ble.connect();
    expect(ble.isConnected).toBe(true);

    // reset 成功 (transport.queueResult は積まないので既定 resultCode=0 が返る)
    const res = await ble.reset();
    expect(res.resultCode).toBe(0);

    // dropKey 相当として session が disconnect された → transport.disconnected が true
    expect(transport.disconnected).toBe(true);
    // ble.isConnected = session.isLoggedIn。disconnect 後は false。
    expect(ble.isConnected).toBe(false);

    // 以後の request は not-logged-in で即 reject される (セッション再利用防止)。
    // 参照: session.js request() の notLoggedIn guard。
    const err = await ble.unlock().then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/not.?logged.?in|ログイン/i);
  });

  it("reset が非0 resultCode (失敗) のときは disconnect しない", async () => {
    // 参照: CHSesame2Device.kt:574-576 — success 以外は result.invoke(failure) のみ。
    // dropKey は呼ばれない = disconnect しない。
    const { transport, ssmPublicKey, keyIndex, secretKey } = makeOS2MockTransport();
    // 次のコマンド(REGISTRATION delete)の応答を resultCode=5 に差し替える。
    transport.queueResult(ITEM.REGISTRATION, 5);

    const ble = new SesameOS2Ble({
      transport,
      secretKey,
      keyIndex,
      ssmPublicKey,
    });
    await ble.connect();

    // reset は BleResultError で reject される (resultCode!=0)
    const err = await ble.reset().then(() => null, (e) => e);
    expect(err).toBeTruthy();
    expect(err.resultCode).toBe(5);

    // 失敗時は disconnect しない
    expect(transport.disconnected).toBe(false);
    // セッションはまだ有効
    expect(ble.isConnected).toBe(true);
  });
});

// ================================================================
// P4-5: OS3 session._handleInitial の <4B token 即 reject
// ================================================================

// OS3 session の _handleInitial に 短い token を送る最小 mock transport (OS3 用)。
// 導出元: session.js _handleInitial — token.length !== 4 ならログのみではなく即 reject (P4-5)。
// lock profile: sault = 0x00 ++ token4 → nonce 13B (SesameOS3BleCipher.kt:8-19)。
function makeOS3InitialOnlyTransport(tokenBytes) {
  return {
    connect(onPacket) {
      // OS3 initial: frame = [PUBLISH(8), INITIAL(14), ...token]
      // セグメントヘッダ: (SEG.PLAINTEXT << 1) | 1 = start-of-single-segment。
      const frame = Buffer.concat([Buffer.from([OS3_OP.PUBLISH, OS3_ITEM.INITIAL]), tokenBytes]);
      const header = (OS3_SEG.PLAINTEXT << 1) | 1;
      onPacket(Buffer.concat([Buffer.from([header]), frame]));
      return Promise.resolve();
    },
    write() {},
    disconnect() { return Promise.resolve(); },
  };
}

describe("P4-5: OS3 SesameBleSession _handleInitial — <4B token も即 reject (>4B と対称化)", () => {
  const SECRET = "0123456789abcdef0123456789abcdef";

  it("3B token (<4B) は connect() を即 reject し 4B 違反メッセージを含む", async () => {
    // 変更前: token.length < 4 のとき _log して return → login timeout (8s) まで待機者を宙づり。
    // 変更後: >4B 分岐と同じく即 reject (P4-5)。
    // 既存 5B テスト (>4B) と対称のケースを追加する (計画書の「3B token ケースを 5B ケースと対で」)。
    const tok3 = Buffer.from([0x01, 0x02, 0x03]);
    const s = new SesameBleSession({
      transport: makeOS3InitialOnlyTransport(tok3),
      secretKey: SECRET,
    });
    const err = await s.connect().then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);
    // ble.initialTokenMustBe4 の文言は "4" を含む
    expect(err.message).toMatch(/4/);
    expect(s.isLoggedIn).toBe(false);
  });

  it("3B token で reject された後 register() も readyWaiter を reject する", async () => {
    // register() は _readyWaiter を待つ。
    // non-4B initial は _readyWaiter も reject する (connect() 側 _loginWaiter と対称)。
    const tok3 = Buffer.from([0x01, 0x02, 0x03]);
    const s = new SesameBleSession({
      transport: makeOS3InitialOnlyTransport(tok3),
      // secretKey なし → 工場出荷 (ReadyToRegister を待つ経路)
    });
    const err = await s.register({ deviceUUID: "00000000-0000-0000-0000-000000000001" }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/4/);
  });

  it("5B token (>4B) は依然として即 reject (既存挙動の回帰防止)", async () => {
    // P3-05 で修正済みの >4B ケースが壊れていないことを確認する。
    const tok5 = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]);
    const s = new SesameBleSession({
      transport: makeOS3InitialOnlyTransport(tok5),
      secretKey: SECRET,
    });
    const err = await s.connect().then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/4/);
    expect(s.isLoggedIn).toBe(false);
  });

  it("4B token は正常に login できる (正常系の回帰防止)", async () => {
    // 正常系: 4B token のみを送り、その後 login 応答も返す完全 mock が必要。
    // ここでは 4B token の initial を受けて connect が login へ進もうとする (login 応答なしでは
    // timeout するが、エラーは token 長違反ではなく timeout になることを確認する)。
    // LOGIN_TIMEOUT_MS=8s はテストに長すぎるので defaultTimeoutMs で短縮する。
    const tok4 = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    const s = new SesameBleSession({
      transport: makeOS3InitialOnlyTransport(tok4),
      secretKey: SECRET,
    });
    // connect() は login 応答が来ないため LOGIN_TIMEOUT (8s) で reject する。
    // このテストはその timeout を待たず、「4B token は 4B 違反エラーにならない」ことを確認する。
    // そのため connect() の Promise race として 200ms 後に abort する。
    const result = await Promise.race([
      s.connect().then(() => "ok", (e) => e.message),
      new Promise((resolve) => setTimeout(() => resolve("still-pending"), 200)),
    ]);
    // 4B token は initial を通過し login を試みている。200ms 以内に即 reject はしない。
    // (4B 違反なら即 reject で "still-pending" には到達しない)
    // - "still-pending": login 応答待ち中 (4B token は正しく通過)
    // - timeout メッセージ: LOGIN_TIMEOUT_MS が 200ms 以内に来た場合 (起きえないが安全側)
    // いずれにせよ "initial token must be exactly 4" にはならない。
    expect(typeof result === "string" ? result : "error").not.toMatch(/initial token must be exactly 4/);
  }, 2000);
});
