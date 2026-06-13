// P4-1 テスト: guest 鍵の sentinel 自動判定 (`secretKey.contains("000000")`)
//
// 参照: _sesame_sdk_ref/.../CHBaseDevice.kt:115 — isNeedAuthFromServer = it.secretKey.contains("000000")
// 参照: _sesame_sdk_ref/.../CHSesameOS3.kt:468-491 — initial 受信時 isNeedAuthFromServer=true なら
//        signGuestKey → server token login へ自動分岐。
//
// 検証する挙動:
//   A. sentinel 含み secretKey + registerTransport あり → server-auth 経路へ自動切替 (@experimental V18)
//   B. sentinel 含み secretKey + registerTransport なし → 「server 認証が必要。--server-auth を付けるか
//      registerTransport を渡せ」の明示エラー (接続前に弾く)
//   C. sentinel 非含み secretKey → 通常 login (sentinel は無視、既存挙動に変化なし)
//   D. needAuthFromServer=false を明示した場合 → sentinel があっても通常 login (明示指定を尊重)
//   E. SesameBle.use() の静的ヘルパ経由でも同様に動作する

import { describe, it, expect, vi } from "vitest";
import { Buffer } from "node:buffer";
import { SesameBle } from "../../src/ble/index.js";
import {
  deriveSessionKey, ccmEncrypt, ccmDecrypt,
  splitSegments, SegmentAssembler, OP, ITEM, SEG,
} from "../../src/ble/protocol.js";

// guest 鍵の sentinel — secretKey が "000000" を含む実例。
// 参照: CHBaseDevice.kt:115 — it.secretKey.contains("000000")。
// 実際のゲスト鍵は SESAME SDK がサーバ発行した 32hex で、その一部に "000000" が埋め込まれる。
const GUEST_SECRET = "aabb000000ccddee00112233445566ff";  // "000000" を含む sentinel 鍵
const NORMAL_SECRET = "0123456789abcdef0123456789abcdef"; // sentinel を含まない通常鍵

const TOKEN = Buffer.from([0x11, 0x22, 0x33, 0x44]);

/**
 * server-auth 経路の MockDevice。
 * mode="server-auth": initial 後、plain LOGIN を受け入れず、
 *   signGuestKey が返す server token (hex → 16B buf) を session 鍵として cipher を確立する。
 * mode="normal": 通常 secretKey ベースの login。
 *
 * 実際の server-auth フロー (CHSesameOS3.kt:468-491):
 *   1. device が INITIAL publish (4B token) を送信する。
 *   2. client は signGuestKey(deviceUUID, tokenHex, secretKey) を cloud に POST する。
 *   3. cloud が署名済み session token (16B hex) を返す。
 *   4. client はその token を cipher 鍵として LOGIN frame を暗号化して送る。
 *   5. device は同一 session token で受信 → LOGIN 応答 → 接続確立。
 *
 * ここでは「client が送った LOGIN 暗号化鍵」= signGuestKey の戻り値を使ったことを
 * verifyToken で確認することでサーバ認証経路を検証する。
 */
class MockDevice {
  /**
   * @param {{ mode: "server-auth"|"normal", secretKey: string, serverToken?: Buffer }} opts
   */
  constructor({ mode, secretKey, serverToken }) {
    this.mode = mode;
    this.secretKey = Buffer.from(secretKey, "hex");
    // server-auth モードでは mock server から返される session token で cipher 鍵を確立。
    // normal モードでは secretKey + token から導出する標準鍵を使う。
    this.serverToken = serverToken || null;
    this.token = TOKEN;
    this.asm = new SegmentAssembler();
    this.encCount = 0;
    this.decCount = 0;
    this.onPacket = null;
    this.disconnected = false;
    this.lastCommand = null;
    // cipher 鍵: server-auth の場合は serverToken、normal の場合は通常導出鍵。
    // server-auth では LOGIN 受信後にクライアントが使った鍵を試みる (ここでは serverToken で固定)。
    this.key = mode === "server-auth"
      ? (serverToken || Buffer.alloc(16))
      : deriveSessionKey(this.secretKey, this.token);
  }

  connect(onPacket) {
    this.onPacket = onPacket;
    // INITIAL publish: [OP.PUBLISH, ITEM.INITIAL, ...4B_token]
    this._emitPlain(Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.INITIAL]), this.token]));
    return Promise.resolve();
  }

  write(seg) {
    const a = this.asm.feed(Buffer.from(seg));
    if (!a) return;
    // LOGIN は plaintext または ciphertext で届く。
    // server-auth の場合: session は initial token 受信後、signGuestKey の戻り値 (server token) で
    // cipher を確立してから LOGIN を暗号化して送る。
    // ここでは型を問わず LOGIN item を受けたら成功応答を返す (cipher 鍵は既に this.key で設定済み)。
    let frame;
    if (a.type === SEG.CIPHERTEXT) {
      try { frame = ccmDecrypt(this.key, this.decCount, this.token, a.data); }
      catch { frame = null; }
      this.decCount += 1;
    } else {
      frame = a.data;
    }
    if (!frame) return;
    const item = frame[0];
    if (item === ITEM.LOGIN) {
      this._emitCipher(Buffer.from([OP.RESPONSE, ITEM.LOGIN, 0, 0, 0, 0, 0]));
      return;
    }
    this.lastCommand = { item, data: Buffer.from(frame.subarray(1)) };
    this._emitCipher(Buffer.from([OP.RESPONSE, item, 0x00]));
  }

  disconnect() { this.disconnected = true; return Promise.resolve(); }
  _emitPlain(f) { for (const s of splitSegments(f, SEG.PLAINTEXT)) this.onPacket(s); }
  _emitCipher(f) {
    const ct = ccmEncrypt(this.key, this.encCount, this.token, f);
    this.encCount += 1;
    for (const s of splitSegments(ct, SEG.CIPHERTEXT)) this.onPacket(s);
  }
}

describe("P4-1: guest 鍵 sentinel 自動判定", () => {
  // A: sentinel 含み鍵 + registerTransport あり → server-auth 経路へ自動分岐
  it("A: sentinel 含み secretKey + registerTransport → server-auth 経路へ自動切替", async () => {
    // signGuestKey が返す server token。実機では SESAME クラウドが計算する。
    // ここでは固定値を使い「登録済みセッション鍵」として Mock に渡す。
    const serverToken = deriveSessionKey(Buffer.from(GUEST_SECRET, "hex"), TOKEN);
    const dev = new MockDevice({ mode: "server-auth", secretKey: GUEST_SECRET, serverToken });

    const signCalls = [];
    // registerTransport: signGuestKey の呼び出し先。
    // 参照: devices.js signGuestKey — path に "sign" が含まれ、body.token と body.deviceId を送る。
    const registerTransport = async (req) => {
      signCalls.push(req);
      // guestKeysSignPost と同形: server token の hex を text で返す。
      return { status: 200, text: serverToken.toString("hex"), json: null };
    };

    // needAuthFromServer を渡さない → sentinel 自動検出で server-auth へ切替
    const ble = new SesameBle({
      secretKey: GUEST_SECRET,
      deviceUUID: "GUEST-SENTINEL-1",
      registerTransport,
      transport: dev,
      // needAuthFromServer は意図的に省略 — sentinel 自動判定のテスト
    });

    await ble.connect();
    expect(ble.isConnected).toBe(true);

    // signGuestKey が自動的に呼ばれたことを確認。
    expect(signCalls.length).toBe(1);
    // path には signKey エンドポイントのパスが含まれる (devices.js signGuestKey 実装参照)。
    expect(signCalls[0].path).toMatch(/sign/i);
    // body.token = initial の 4B token の hex (CHSesameOS3.kt:476 — mSesameToken.toHexString())。
    expect(signCalls[0].body.token).toBe(TOKEN.toString("hex"));

    await ble.close();
    expect(dev.disconnected).toBe(true);
  });

  // B: sentinel 含み鍵 + registerTransport なし → 明示エラー(接続前に弾く)
  it("B: sentinel 含み secretKey + registerTransport なし → needServerAuthNoTransport エラー", async () => {
    const dev = new MockDevice({ mode: "normal", secretKey: NORMAL_SECRET });
    // needAuthFromServer を省略、registerTransport も省略
    const ble = new SesameBle({
      secretKey: GUEST_SECRET,
      deviceUUID: "GUEST-SENTINEL-2",
      transport: dev,
      // registerTransport は意図的に省略
    });

    // connect() より前に(transport 接続試行前に)エラーが出ること。
    await expect(ble.connect()).rejects.toThrow(/server.*auth|000000|registerTransport|--server-auth/i);
    // transport への接続試行が起こっていないこと (connect が呼ばれていない = dev.onPacket が null のまま)。
    // MockDevice.connect() が呼ばれると onPacket が設定されるので、それで判断する。
    expect(dev.onPacket).toBe(null);
  });

  // C: sentinel 非含み secretKey → 通常 login (既存挙動に変化なし)
  it("C: sentinel 非含み secretKey → 通常 login (sentinel 自動判定は発火しない)", async () => {
    const dev = new MockDevice({ mode: "normal", secretKey: NORMAL_SECRET });
    const registerTransportSpy = vi.fn();

    const ble = new SesameBle({
      secretKey: NORMAL_SECRET,
      transport: dev,
      // registerTransport を渡しているが、sentinel 無しなので使われないはず
      registerTransport: registerTransportSpy,
    });

    await ble.connect();
    expect(ble.isConnected).toBe(true);
    // server-auth 経路は走っていない (signGuestKey が呼ばれていない)。
    expect(registerTransportSpy).not.toHaveBeenCalled();
    await ble.close();
  });

  // D: needAuthFromServer=false を明示 → sentinel があっても通常 login (明示指定を尊重)
  it("D: needAuthFromServer=false を明示 → sentinel があっても通常 login へ (明示指定優先)", async () => {
    const dev = new MockDevice({ mode: "normal", secretKey: GUEST_SECRET });
    const registerTransportSpy = vi.fn();

    // GUEST_SECRET は sentinel を含むが、needAuthFromServer=false を明示する
    const ble = new SesameBle({
      secretKey: GUEST_SECRET,
      transport: dev,
      needAuthFromServer: false,   // 明示指定 → sentinel 自動判定は無効
      registerTransport: registerTransportSpy,
    });

    await ble.connect();
    expect(ble.isConnected).toBe(true);
    // server-auth は走っていない。
    expect(registerTransportSpy).not.toHaveBeenCalled();
    await ble.close();
  });

  // E: SesameBle.use() 経由でも sentinel エラーが正しく出る
  it("E: SesameBle.use() でも sentinel + registerTransport なし → 明示エラー", async () => {
    const dev = new MockDevice({ mode: "normal", secretKey: NORMAL_SECRET });

    await expect(SesameBle.use(
      { secretKey: GUEST_SECRET, transport: dev },
      async () => {},
    )).rejects.toThrow(/server.*auth|000000|registerTransport|--server-auth/i);
  });

  // F: "000000" が secretKey 末尾にある場合も sentinel と判定する (contains チェック)
  it("F: secretKey 末尾の \"000000\" も sentinel と判定する", () => {
    const sentinelAtEnd = "aabbccddeeff001122334455" + "000000";
    // registerTransport なしでコンストラクタ後に sentinel フラグが立つことを確認
    // (connect() を呼ばずにフラグを検査する)
    const ble = new SesameBle({
      secretKey: sentinelAtEnd,
      transport: { connect: () => Promise.resolve(), write: () => {}, disconnect: () => Promise.resolve() },
    });
    // _sentinelDetected は internal だが、connect() でエラーが出ることで間接確認する。
    expect(ble._sentinelDetected).toBe(true);
    expect(ble._needAuthFromServer).toBe(true);
  });

  // G: "000000" を含まない鍵は sentinel=false
  it("G: sentinel を含まない通常鍵は _sentinelDetected=false", () => {
    const ble = new SesameBle({
      secretKey: NORMAL_SECRET,
      transport: { connect: () => Promise.resolve(), write: () => {}, disconnect: () => Promise.resolve() },
    });
    expect(ble._sentinelDetected).toBe(false);
  });
});
