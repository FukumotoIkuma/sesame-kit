// OS2 セッションの fail-fast 検証 (OS3 の transport-robustness.test.js と対称)。
// transport が onDisconnect(reason) を呼ぶと、OS2 session は pending request と login 待機者を
// 即 reject し、timeout 宙づりを防ぐ (src/ble/os2/session.js _handleTransportDisconnect/_failAllPending)。
// 実機 (noble) は使わず、onDisconnect を保持して任意発火できる最小 mock SESAME を注入する。
import { describe, it, expect } from "vitest";
import { Buffer } from "node:buffer";
import { createECDH } from "node:crypto";
import { SesameOS2BleSession } from "../../src/ble/os2/session.js";
import { OP, ITEM, SEG } from "../../src/ble/os2/protocol.js";
import { SegmentAssembler } from "../../src/ble/protocol.js";

/**
 * login まで通る最小 mock OS2 SESAME。connect の 2 引数 (onPacket, onDisconnect) を保持し、
 * triggerLinkLost() で外部から「リンク断」を模す。
 *
 * login 応答は PLAINTEXT で返すため device 側 cipher は不要。コマンド (UNLOCK 等) には応答せず
 * pending を残す (= 切断で fail-fast されることを観測するため)。ssmPublicKey は実 EC 鍵にするので
 * session 側の ECDH 鍵導出は成功する (暗号フレームの往復はしないため device 鍵一致は不要)。
 */
class DisconnectableOS2Mock {
  constructor({ mSesameToken }) {
    this._mSesameToken = mSesameToken;     // initial publish に載せる device トークン (4B)
    this.appAsm = new SegmentAssembler();
    this.onPacket = null;
    this.onDisconnect = null;
    this.disconnected = false;
  }

  async connect(onPacket, onDisconnect) {
    this.onPacket = onPacket;
    this.onDisconnect = onDisconnect;
    // device → app: initial publish ([PUBLISH, INITIAL, ...mSesameToken])。
    this._sendPlain(Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.INITIAL]), this._mSesameToken]));
    return undefined;
  }

  write(seg) {
    const a = this.appAsm.feed(Buffer.from(seg));
    if (!a) return;
    // login (PLAINTEXT, SYNC+LOGIN) のみ応答。暗号化コマンドは無視 → pending を残す。
    if (a.type === SEG.PLAINTEXT && a.data[0] === OP.SYNC && a.data[1] === ITEM.LOGIN) {
      const lr = Buffer.alloc(28);
      lr.writeUInt32BE(Math.floor(Date.now() / 1000), 0);
      lr[27] = 0x02; // mech_status flags = byte7 (CHSesame2.kt:37) → locked
      // response = [RESPONSE, item, op, result] (導出元: SesameProtocols.kt:15-19
      // SSM2ResponsePayload — cmdItCode=data[0], cmdOPCode=data[1], cmdResultCode=data[2])。
      this._sendPlain(Buffer.concat([Buffer.from([OP.RESPONSE, ITEM.LOGIN, OP.SYNC, 0x00]), lr]));
    }
  }

  async disconnect() { this.disconnected = true; }

  /** 外部から「リンクが切れた」を模す (相手側切断 / 圏外 / write リトライ枯渇)。 */
  triggerLinkLost(reason = "peer") { if (this.onDisconnect) this.onDisconnect(reason); }

  _sendPlain(frame) {
    const header = (SEG.PLAINTEXT << 1) | 1; // single segment + start bit
    this.onPacket(Buffer.concat([Buffer.from([header]), frame]));
  }
}

/** ssmPublicKey (device 公開鍵 64B raw) を生成する。 */
function makeSsmPublicKey() {
  const kp = createECDH("prime256v1");
  kp.generateKeys();
  return kp.getPublicKey().subarray(1); // 先頭 0x04 を除いた 64B
}

describe("OS2 session fail-fast on transport disconnect", () => {
  it("onDisconnect で進行中の OS2 request が即 reject される (timeout 宙づりを防ぐ)", async () => {
    const dev = new DisconnectableOS2Mock({ mSesameToken: Buffer.from([1, 2, 3, 4]) });
    const session = new SesameOS2BleSession({
      transport: dev,
      secretKey: Buffer.alloc(16, 0x33),
      keyIndex: Buffer.from("0002", "hex"),
      ssmPublicKey: makeSsmPublicKey(),
    });
    await session.connect();
    expect(session.isLoggedIn).toBe(true);

    // 応答が返らない unlock を長い timeout で投げる (切断で割れることを見たい)。
    const p = session.request(OP.ASYNC, ITEM.UNLOCK, Buffer.alloc(0), { timeoutMs: 60_000 });
    // リンク断を発火 → 60s timeout を待たずに即 reject されるはず。
    dev.triggerLinkLost("out-of-range");
    const err = await p.then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/link lost|リンク/); // ble.linkLost (en/ja)
    // セッション状態も倒れている (再 connect は新インスタンス前提)。
    expect(session.isLoggedIn).toBe(false);
  });

  it("connect 中 (login 待ち) の onDisconnect は login 待機者を即 reject する", async () => {
    // initial を出さず、すぐ切断する transport: login/ready の待機者が残ったまま切れる。
    const dev = {
      onDisconnect: null,
      async connect(onPacket, onDisconnect) {
        this.onDisconnect = onDisconnect;
        setTimeout(() => onDisconnect("immediate"), 0);
      },
      write() {},
      async disconnect() {},
    };
    const session = new SesameOS2BleSession({
      transport: dev,
      secretKey: Buffer.alloc(16, 0x33),
      keyIndex: Buffer.from("0002", "hex"),
      ssmPublicKey: makeSsmPublicKey(),
    });
    const err = await session.connect().then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/link lost|リンク/);
  });
});
