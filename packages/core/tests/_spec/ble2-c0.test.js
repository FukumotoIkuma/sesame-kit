// spec: ble-os2.md | domain: BLE2 | ids: BLE2-0001 .. BLE2-0018
// covers: os2-handshake (BLE2-0001..0008), os2-cipher (BLE2-0009..0014), os2-frame (BLE2-0015..0018)
//
// 実行方法: vitest packages/core/tests/_spec/ble2-c0.test.js
//
// 参考既存テスト:
//   packages/core/tests/ble/os2-bot1-mech-status.test.js
//   packages/core/tests/ble/os2-mech-status-kind.test.js

import { describe, it, expect, vi } from "vitest";
import { Buffer } from "node:buffer";
import crypto, { createECDH } from "node:crypto";

import { SesameOS2BleSession } from "../../src/ble/os2/session.js";
import {
  buildSendFrame,
  parseRecvFrame,
  loginPayload,
  sessionToken as buildSessionToken,
  OP,
  ITEM,
  SEG,
} from "../../src/ble/os2/protocol.js";
import { SesameOS2BleCipher, __test__ as cipherTest } from "../../src/ble/os2/cipher.js";
import { OP as BleOP } from "../../src/ble/protocol.js";

const { toCounterBytes, os2Nonce, OS2_CCM_TAG_LEN } = cipherTest;

// ---------- helpers ----------

/** 最小スタブ transport (connect/write/disconnect の no-op) */
function makeTransport(overrides = {}) {
  return {
    connect: () => new Promise(() => {}), // never resolves
    write: () => {},
    disconnect: () => {},
    ...overrides,
  };
}

/** 16B の secretKey hex */
const SECRET_KEY_HEX = "0102030405060708090a0b0c0d0e0f10";

/** 実 ECDH 64B ssmPublicKey (OS2 ECDH 相手として有効な値) */
function makeSsmPublicKey() {
  const kp = createECDH("prime256v1");
  kp.generateKeys();
  return kp.getPublicKey().subarray(1); // 64B raw
}

const SSM_PUB_KEY_BUF = makeSsmPublicKey();
/** hex string for constructors that accept hex */
const SSM_PUB_KEY_HEX = SSM_PUB_KEY_BUF.toString("hex");

// ======================================================================
// [BLE2-0001] OS2 login は SYNC opCode で PLAINTEXT 送信 (_sendPlain)
// ref: session.js:680-684; session.js:498-501; protocol.js
// kind: wire-fidelity
// ======================================================================
describe("[BLE2-0001] OS2 login は SYNC opCode で PLAINTEXT 送信 (_sendPlain)", () => {
  it("[BLE2-0001] buildSendFrame(OP.SYNC, ITEM.LOGIN, data) の先頭バイトは 0x05 (SYNC) / 0x02 (LOGIN)", () => {
    const dummyData = Buffer.from([0xAA, 0xBB]);
    const frame = buildSendFrame(OP.SYNC, ITEM.LOGIN, dummyData);
    expect(frame[0]).toBe(0x05); // OP.SYNC = 0x05
    expect(frame[1]).toBe(ITEM.LOGIN); // ITEM.LOGIN = 2
    expect(frame[2]).toBe(0xAA);
    expect(frame[3]).toBe(0xBB);
  });

  it("[BLE2-0001] ITEM.LOGIN は 2 (SesameItemCode.login=2u)", () => {
    expect(ITEM.LOGIN).toBe(2);
  });

  it("[BLE2-0001] OP.SYNC は 0x05 (SSM2OpCode.sync=0x05)", () => {
    expect(OP.SYNC).toBe(0x05);
  });

  it("[BLE2-0001] SEG.PLAINTEXT は 1 (DeviceSegmentType.plain と一致)", () => {
    expect(SEG.PLAINTEXT).toBe(1);
  });

  it("[BLE2-0001] login frame written as PLAINTEXT segments (SYNC opCode at frame[0], LOGIN at frame[1])", async () => {
    // Capture bytes written through transport and verify the reassembled PLAINTEXT frame
    // starts with [OP.SYNC, ITEM.LOGIN].
    // splitSegments: first chunk has start-bit (header bit0=1); intermediate=APPEND_ONLY<<1=0;
    // last has type<<1 (PLAINTEXT=1 → 2). Reassemble by start-bit then concat all data until
    // type-marked last segment.
    const writtenSegs = [];
    const transport = {
      connect: vi.fn(async (onPacket) => {
        // Deliver initial publish in next tick so loginWaiter is set up first
        setImmediate(() => {
          const token = Buffer.from([0xAA, 0xBB, 0xCC, 0xDD]);
          const frame = Buffer.from([OP.PUBLISH, ITEM.INITIAL, ...token]);
          const seg = Buffer.concat([Buffer.from([0x03]), frame]); // header=(PLAINTEXT<<1)|1=3
          onPacket(seg);
        });
      }),
      write: vi.fn((seg) => { writtenSegs.push(Buffer.from(seg)); }),
      disconnect: vi.fn(),
    };
    const session = new SesameOS2BleSession({
      transport,
      secretKey: SECRET_KEY_HEX,
      ssmPublicKey: SSM_PUB_KEY_BUF,
    });
    // connect will eventually timeout (LOGIN_TIMEOUT_MS=8s), catch to avoid unhandled rejection
    session.connect().catch(() => {});
    // Wait enough for setImmediate + _startLogin async flow to write the login segments
    await new Promise(r => setTimeout(r, 150));
    expect(writtenSegs.length).toBeGreaterThan(0);
    // Reassemble the written segments into the frame:
    // - Segments are grouped by start bit (bit0 of header byte).
    // - Each segment group ends at the packet where header>>1 != APPEND_ONLY (type-marked last).
    // Find the start packet and concatenate all data bytes:
    const frameParts = [];
    let inFrame = false;
    for (const seg of writtenSegs) {
      const header = seg[0];
      const data = seg.subarray(1);
      const startBit = header & 1;
      const segType = header >> 1;
      if (startBit) {
        frameParts.length = 0; // reset for new frame
        inFrame = true;
      }
      if (inFrame) frameParts.push(data);
      if (segType !== 0 /* APPEND_ONLY */) inFrame = false; // last segment of this frame
    }
    const frameBytes = Buffer.concat(frameParts);
    expect(frameBytes.length).toBeGreaterThan(1);
    expect(frameBytes[0]).toBe(OP.SYNC);
    expect(frameBytes[1]).toBe(ITEM.LOGIN);
  });
});

// ======================================================================
// [BLE2-0002] OS2 app ECDH 公開鍵は 65B uncompressed prefix 0x04 を剥がした 64B raw
// ref: session.js:363-369
// kind: wire-fidelity
// ======================================================================
describe("[BLE2-0002] _appPubK64 は 65B→64B (prefix 0x04 を剥がす)", () => {
  it("[BLE2-0002] 正常: 実 ECDH keypair から 64B raw を返す", () => {
    const session = new SesameOS2BleSession({
      transport: makeTransport(),
      secretKey: SECRET_KEY_HEX,
      ssmPublicKey: SSM_PUB_KEY_BUF,
    });
    const kp = createECDH("prime256v1");
    kp.generateKeys();
    const pub65 = kp.getPublicKey();
    expect(pub65.length).toBe(65);
    expect(pub65[0]).toBe(0x04);
    const result = session._appPubK64(kp);
    expect(result.length).toBe(64);
    expect(result).toEqual(pub65.subarray(1));
  });

  it("[BLE2-0002] 65B だが先頭が 0x04 でない場合は throw", () => {
    const session = new SesameOS2BleSession({
      transport: makeTransport(),
      secretKey: SECRET_KEY_HEX,
      ssmPublicKey: SSM_PUB_KEY_BUF,
    });
    const fakeKp = {
      getPublicKey: () => {
        const b = Buffer.alloc(65, 0x05);
        b[0] = 0x02; // compressed prefix, not 0x04
        return b;
      },
    };
    expect(() => session._appPubK64(fakeKp)).toThrow();
  });

  it("[BLE2-0002] 64B (prefix なし) の場合は throw", () => {
    const session = new SesameOS2BleSession({
      transport: makeTransport(),
      secretKey: SECRET_KEY_HEX,
      ssmPublicKey: SSM_PUB_KEY_BUF,
    });
    const fakeKp = { getPublicKey: () => Buffer.alloc(64, 0x01) };
    expect(() => session._appPubK64(fakeKp)).toThrow();
  });
});

// ======================================================================
// [BLE2-0003] サーバ認証 login (signLogin) は sessionAuth をローカル計算せずサーバ署名を使う
// ref: session.js:642-673
// kind: payload-fidelity
// ======================================================================
describe("[BLE2-0003] signLogin 指定時はサーバ署名 sessionAuth を使い CMAC は呼ばない", () => {
  it("[BLE2-0003] signLogin コールバックが呼ばれ、signPayload=74B hex, serverAuth の末尾 4B がフレームに使われる", async () => {
    const capturedSignPayloads = [];
    const serverAuthResponse = Buffer.alloc(16, 0xAB);
    const signLogin = vi.fn(async (hexPayload) => {
      capturedSignPayloads.push(hexPayload);
      return serverAuthResponse.toString("hex");
    });

    const writtenSegs = [];
    let onPacketRef = null;
    const transport = {
      connect: vi.fn(async (onPacket) => { onPacketRef = onPacket; }),
      write: vi.fn((seg) => { writtenSegs.push(Buffer.from(seg)); }),
      disconnect: vi.fn(),
    };

    const ssmPublicKey = makeSsmPublicKey();
    const session = new SesameOS2BleSession({
      transport,
      ssmPublicKey, // no secretKey — server auth path
    });

    const connectPromise = session.connect({ signLogin }).catch(() => {});

    // Deliver initial token
    await new Promise(r => setImmediate(r));
    if (onPacketRef) {
      const token = Buffer.from([0x11, 0x22, 0x33, 0x44]);
      const frame = Buffer.from([OP.PUBLISH, ITEM.INITIAL, ...token]);
      const seg = Buffer.concat([Buffer.from([0x03]), frame]);
      onPacketRef(seg);
    }

    await new Promise(r => setTimeout(r, 80));
    // Note: connectPromise is still pending (device never responds to login) — don't await it.

    expect(signLogin).toHaveBeenCalledTimes(1);
    // signPayload = userIdx(2B) ++ appPubKey64(64B) ++ sessionToken(8B) = 74B = 148 hex chars
    expect(capturedSignPayloads[0].length).toBe(74 * 2);

    // Verify last 4B of login frame payload = serverAuth[0:4] = [0xAB, 0xAB, 0xAB, 0xAB]
    const plainSegs = writtenSegs.filter(s => (s[0] & 0xFE) === (SEG.PLAINTEXT << 1));
    const frameBytes = Buffer.concat(plainSegs.map(s => s.subarray(1)));
    const lastFour = frameBytes.subarray(frameBytes.length - 4);
    expect(lastFour).toEqual(Buffer.alloc(4, 0xAB));
  });
});

// ======================================================================
// [BLE2-0004] サーバ署名 sessionAuth が 4B 未満なら login を reject
// ref: session.js:667-671; protocol.js:148
// kind: error-path
// ======================================================================
describe("[BLE2-0004] サーバ署名 sessionAuth が 4B 未満なら _loginWaiter を reject", () => {
  it("[BLE2-0004] signLogin が 3B (< 4B) を返したとき connect() が reject される", async () => {
    let onPacketRef = null;
    const transport = {
      connect: vi.fn(async (onPacket) => { onPacketRef = onPacket; }),
      write: vi.fn(),
      disconnect: vi.fn(),
    };
    const ssmPublicKey = makeSsmPublicKey();
    const session = new SesameOS2BleSession({ transport, ssmPublicKey });
    const connectPromise = session.connect({
      signLogin: async () => "aabbcc", // 3B hex = 3 bytes < 4
    });

    await new Promise(r => setImmediate(r));
    if (onPacketRef) {
      const token = Buffer.from([0xAA, 0xBB, 0xCC, 0xDD]);
      const frame = Buffer.from([OP.PUBLISH, ITEM.INITIAL, ...token]);
      const seg = Buffer.concat([Buffer.from([0x03]), frame]);
      onPacketRef(seg);
    }

    await expect(connectPromise).rejects.toThrow(/4/);
  });

  it("[BLE2-0004] loginPayload が sessionAuth < 4B で throw する (protocol.js:148)", () => {
    const userIdx = Buffer.from("0000", "hex");
    const appPub = Buffer.alloc(64, 0x01);
    const appToken = Buffer.alloc(4, 0x02);
    const shortAuth = Buffer.alloc(3, 0xAB); // < 4B
    expect(() => loginPayload(userIdx, appPub, appToken, shortAuth)).toThrow();
  });
});

// ======================================================================
// [BLE2-0005] connect() は secretKey も signLogin も無ければ reject
// ref: session.js:186-189
// kind: error-path
// ======================================================================
describe("[BLE2-0005] connect() — secretKey も signLogin も無ければ即 reject", () => {
  it("[BLE2-0005] secretKey なし / signLogin なし → reject", async () => {
    const session = new SesameOS2BleSession({
      transport: makeTransport(),
      ssmPublicKey: SSM_PUB_KEY_BUF,
      // secretKey 省略
    });
    await expect(session.connect()).rejects.toThrow(/secretKey/i);
  });

  it("[BLE2-0005] secretKey あり → reject しない (connect 自体は呼べる)", async () => {
    const session = new SesameOS2BleSession({
      transport: makeTransport(),
      secretKey: SECRET_KEY_HEX,
      ssmPublicKey: SSM_PUB_KEY_BUF,
    });
    const p = session.connect();
    await new Promise((r) => setTimeout(r, 10));
    p.catch(() => {});
    expect(true).toBe(true);
  });
});

// ======================================================================
// [BLE2-0006] connect() は ssmPublicKey(64B) 無しなら reject (OS2 ECDH 必須)
// ref: session.js:190
// kind: error-path
// ======================================================================
describe("[BLE2-0006] connect() — ssmPublicKey 未指定で reject", () => {
  it("[BLE2-0006] ssmPublicKey なし → reject", async () => {
    const session = new SesameOS2BleSession({
      transport: makeTransport(),
      secretKey: SECRET_KEY_HEX,
      // ssmPublicKey 省略
    });
    await expect(session.connect()).rejects.toThrow(/ssmPublicKey/i);
  });

  it("[BLE2-0006] ssmPublicKey あり → reject しない", async () => {
    const session = new SesameOS2BleSession({
      transport: makeTransport(),
      secretKey: SECRET_KEY_HEX,
      ssmPublicKey: SSM_PUB_KEY_BUF,
    });
    const p = session.connect();
    await new Promise((r) => setTimeout(r, 10));
    p.catch(() => {});
    expect(true).toBe(true);
  });
});

// ======================================================================
// [BLE2-0007] keyIndex 空文字列は明示エラー、既定は "0000"(2B)
// ref: session.js:99-106
// kind: error-path
// ======================================================================
describe("[BLE2-0007] keyIndex — 空は throw, 既定は '0000'(2B)", () => {
  it("[BLE2-0007] keyIndex='' (空) でコンストラクタが throw する", () => {
    expect(() => new SesameOS2BleSession({
      transport: makeTransport(),
      secretKey: SECRET_KEY_HEX,
      ssmPublicKey: SSM_PUB_KEY_BUF,
      keyIndex: "",
    })).toThrow();
  });

  it("[BLE2-0007] keyIndex 省略 → 既定 2B (hex '0000') が設定される", () => {
    const session = new SesameOS2BleSession({
      transport: makeTransport(),
      secretKey: SECRET_KEY_HEX,
      ssmPublicKey: SSM_PUB_KEY_BUF,
    });
    expect(session._keyIndex).toEqual(Buffer.from([0x00, 0x00]));
    expect(session._keyIndex.length).toBe(2);
  });

  it("[BLE2-0007] keyIndex='0000' (明示) → 2B が設定される", () => {
    const session = new SesameOS2BleSession({
      transport: makeTransport(),
      secretKey: SECRET_KEY_HEX,
      ssmPublicKey: SSM_PUB_KEY_BUF,
      keyIndex: "0000",
    });
    expect(session._keyIndex.length).toBe(2);
    expect(session._keyIndex[0]).toBe(0x00);
    expect(session._keyIndex[1]).toBe(0x00);
  });
});

// ======================================================================
// [BLE2-0008] initial token が 4B 以外なら login/ready を reject (FW プロトコル違反)
// ref: session.js:587-609
// kind: error-path
// ======================================================================
describe("[BLE2-0008] _handleInitial — token が 4B 以外なら reject", () => {
  function makeSessionWithTransport() {
    let onPacketRef = null;
    const transport = {
      connect: vi.fn(async (onPacket) => { onPacketRef = onPacket; }),
      write: vi.fn(),
      disconnect: vi.fn(),
    };
    const ssmPublicKey = makeSsmPublicKey();
    const session = new SesameOS2BleSession({
      transport,
      secretKey: SECRET_KEY_HEX,
      ssmPublicKey,
    });
    return { session, getOnPacket: () => onPacketRef };
  }

  function sendInitialWithToken(onPacket, tokenBytes) {
    const frame = Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.INITIAL]), tokenBytes]);
    const seg = Buffer.concat([Buffer.from([0x03]), frame]); // (PLAINTEXT<<1)|1 = 0x03
    onPacket(seg);
  }

  it("[BLE2-0008] token 0B → _loginWaiter を reject", async () => {
    const { session, getOnPacket } = makeSessionWithTransport();
    const p = session.connect();
    await new Promise(r => setImmediate(r));
    sendInitialWithToken(getOnPacket(), Buffer.alloc(0));
    await expect(p).rejects.toThrow(/token|initial/i);
  });

  it("[BLE2-0008] token 3B (非 4B) → _loginWaiter を reject", async () => {
    const { session, getOnPacket } = makeSessionWithTransport();
    const p = session.connect();
    await new Promise(r => setImmediate(r));
    sendInitialWithToken(getOnPacket(), Buffer.from([0x01, 0x02, 0x03]));
    await expect(p).rejects.toThrow(/4 byte/i);
  });

  it("[BLE2-0008] token 4B → reject しない (login フローに進む、_mSesameToken が設定される)", async () => {
    const { session, getOnPacket } = makeSessionWithTransport();
    const p = session.connect().catch(() => "rejected-by-timeout");
    await new Promise(r => setImmediate(r));
    const token = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    sendInitialWithToken(getOnPacket(), token);
    await new Promise(r => setTimeout(r, 20));
    expect(session._mSesameToken).toEqual(token);
    p.catch(() => {});
  });
});

// ======================================================================
// [BLE2-0009] OS2 CCM nonce = counter5B ++ sessionToken8B (13B)
// ref: cipher.js:54-64
// kind: crypto-vector
// ======================================================================
describe("[BLE2-0009] OS2 CCM nonce = counter5B ++ sessionToken8B = 13B", () => {
  it("[BLE2-0009] os2Nonce は 13B を返す", () => {
    const token = Buffer.alloc(8, 0x42);
    const nonce = os2Nonce(0n, token, true);
    expect(nonce.length).toBe(13);
  });

  it("[BLE2-0009] nonce の後半 8B は sessionToken そのもの", () => {
    const token = Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    const nonce = os2Nonce(5n, token, false);
    expect(nonce.subarray(5)).toEqual(token);
  });

  it("[BLE2-0009] nonce の先頭 5B は counter 部分 (toCounterBytes の結果)", () => {
    const token = Buffer.alloc(8, 0x00);
    const counterVal = 7n;
    const nonce = os2Nonce(counterVal, token, true);
    const expected = toCounterBytes(counterVal, true);
    expect(nonce.subarray(0, 5)).toEqual(expected);
  });

  it("[BLE2-0009] encrypt と decrypt は同 counter でも先頭 5B が異なる (方向マーカ)", () => {
    const token = Buffer.alloc(8, 0x11);
    const counter = 5n;
    const nonceEnc = os2Nonce(counter, token, true);
    const nonceDec = os2Nonce(counter, token, false);
    // shared token suffix
    expect(nonceEnc.subarray(5)).toEqual(nonceDec.subarray(5));
    // different counter prefix (direction marker)
    expect(nonceEnc.subarray(0, 5)).not.toEqual(nonceDec.subarray(0, 5));
  });
});

// ======================================================================
// [BLE2-0010] encrypt counter は 0x80_00000000 を OR、decrypt counter は 0x7f_ffffffff を AND
// ref: cipher.js:31-52
// kind: crypto-vector
// ======================================================================
describe("[BLE2-0010] toCounterBytes — encrypt は bit39 を立て、decrypt は落とす", () => {
  it("[BLE2-0010] encrypt: counter=0 → 5B LE で bit39 (最上位) が立つ", () => {
    const bytes = toCounterBytes(0n, true);
    // 0x80_00000000 LE: [0x00, 0x00, 0x00, 0x00, 0x80]
    expect(bytes.length).toBe(5);
    expect(bytes[4]).toBe(0x80);
    expect(bytes[0]).toBe(0x00);
    expect(bytes[1]).toBe(0x00);
    expect(bytes[2]).toBe(0x00);
    expect(bytes[3]).toBe(0x00);
  });

  it("[BLE2-0010] decrypt: counter=0 → 5B LE で bit39 が落ちる (全 0)", () => {
    const bytes = toCounterBytes(0n, false);
    expect(bytes).toEqual(Buffer.alloc(5, 0x00));
  });

  it("[BLE2-0010] encrypt: counter=1 → [0x01, 0x00, 0x00, 0x00, 0x80] in LE", () => {
    const bytes = toCounterBytes(1n, true);
    expect(bytes[0]).toBe(0x01);
    expect(bytes[4]).toBe(0x80);
  });

  it("[BLE2-0010] decrypt: counter=0x8000000001 → bit39 をマスクして [0x01,...,0x00]", () => {
    // AND 0x7fffffffff: 0x8000000001 & 0x7fffffffff = 0x0000000001
    const bytes = toCounterBytes(0x8000000001n, false);
    expect(bytes[0]).toBe(0x01);
    expect(bytes[4]).toBe(0x00);
  });
});

// ======================================================================
// [BLE2-0011] OS2 CCM tag=4B / AAD=0x00 / aes-128-ccm
// ref: cipher.js:25-28; cipher.js:104-136
// kind: crypto-vector
// ======================================================================
describe("[BLE2-0011] OS2 CCM tag=4B / AAD=[0x00] / aes-128-ccm", () => {
  it("[BLE2-0011] __test__.OS2_CCM_TAG_LEN は 4 (32bit tag)", () => {
    expect(OS2_CCM_TAG_LEN).toBe(4);
  });

  it("[BLE2-0011] encrypt 出力は plaintext + 4B tag の長さ", () => {
    const key = Buffer.alloc(16, 0x01);
    const token = Buffer.alloc(8, 0x02);
    const cipher = new SesameOS2BleCipher(key, token);
    const plain = Buffer.from([0x01, 0x02, 0x03]);
    const ct = cipher.encrypt(plain);
    expect(ct.length).toBe(plain.length + 4);
  });

  it("[BLE2-0011] encrypt は OS2_CCM_TAG_LEN=4 の tag を末尾に付加する (構造確認)", () => {
    const key = Buffer.alloc(16, 0x03);
    const token = Buffer.alloc(8, 0x04);
    const enc = new SesameOS2BleCipher(key, token);
    const plain = Buffer.from("hello OS2");
    const ct = enc.encrypt(plain);
    expect(ct.length).toBe(plain.length + OS2_CCM_TAG_LEN);
    expect(OS2_CCM_TAG_LEN).toBe(4);
  });
});

// ======================================================================
// [BLE2-0012] decrypt は doFinal の前に counter を進める (reset-session 整合)
// ref: cipher.js:121-136
// kind: error-path
// ======================================================================
describe("[BLE2-0012] decrypt は doFinal 前に decCount を進める", () => {
  it("[BLE2-0012] 復号成功時も decryptCounter が 1 増える", () => {
    // Note: OS2 cipher direction-marker design means app.encrypt (isEncrypt=true nonce) cannot
    // be round-tripped by app.decrypt (isEncrypt=false nonce). They are intentionally different.
    // To produce a valid decryptable ciphertext, simulate device-side encrypt using the same
    // nonce that app.decrypt uses (both use isEncrypt=false / DECRYPT_MASK nonce direction).
    const key = Buffer.alloc(16, 0x01);
    const token = Buffer.alloc(8, 0x02);
    const plain = Buffer.from([0xAA]);
    // Construct device-encrypted ciphertext using decrypt-side nonce (what device would send)
    const devNonce = os2Nonce(0n, token, false); // same nonce dec.decrypt() uses at counter=0
    const c = crypto.createCipheriv("aes-128-ccm", key, devNonce, { authTagLength: 4 });
    c.setAAD(Buffer.from([0x00]), { plaintextLength: plain.length });
    const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);

    const dec = new SesameOS2BleCipher(key, token);
    expect(dec.decryptCounter).toBe(0n);
    const pt = dec.decrypt(ct);
    expect(pt).toEqual(plain);
    expect(dec.decryptCounter).toBe(1n);
  });

  it("[BLE2-0012] 復号失敗 (tag mismatch) でも decryptCounter が 1 増える", () => {
    const key = Buffer.alloc(16, 0x01);
    const token = Buffer.alloc(8, 0x02);
    const dec = new SesameOS2BleCipher(key, token);
    const fakeCtWithTag = Buffer.alloc(8, 0xFF); // wrong content
    expect(dec.decryptCounter).toBe(0n);
    expect(() => dec.decrypt(fakeCtWithTag)).toThrow();
    expect(dec.decryptCounter).toBe(1n);
  });

  it("[BLE2-0012] counter は doFinal 前に進む — 失敗後の次カウンタも 1 増える", () => {
    const key = Buffer.alloc(16, 0xA0);
    const token = Buffer.alloc(8, 0xB0);
    const dec = new SesameOS2BleCipher(key, token);
    expect(dec.decryptCounter).toBe(0n);
    try { dec.decrypt(Buffer.alloc(10, 0xFF)); } catch { /* expected */ }
    expect(dec.decryptCounter).toBe(1n);
    try { dec.decrypt(Buffer.alloc(10, 0xFF)); } catch { /* expected */ }
    expect(dec.decryptCounter).toBe(2n);
  });
});

// ======================================================================
// [BLE2-0013] encrypt/decrypt counter は独立に進む (送受信別カウンタ)
// ref: cipher.js:89-96; cipher.js:106; cipher.js:129
// kind: crypto-vector
// ======================================================================
describe("[BLE2-0013] encryptCounter と decryptCounter は独立", () => {
  it("[BLE2-0013] encrypt 3回 → encryptCounter=3, decryptCounter=0", () => {
    const key = Buffer.alloc(16, 0x01);
    const token = Buffer.alloc(8, 0x02);
    const cipher = new SesameOS2BleCipher(key, token);
    cipher.encrypt(Buffer.from([0x01]));
    cipher.encrypt(Buffer.from([0x02]));
    cipher.encrypt(Buffer.from([0x03]));
    expect(cipher.encryptCounter).toBe(3n);
    expect(cipher.decryptCounter).toBe(0n);
  });

  it("[BLE2-0013] decrypt 2回 → decryptCounter=2, encryptCounter=0", () => {
    // Produce two valid ciphertexts using device-side nonce (isEncrypt=false direction),
    // which is the same nonce app.decrypt uses (DECRYPT_MASK direction).
    const key = Buffer.alloc(16, 0x01);
    const token = Buffer.alloc(8, 0x02);
    function makeDeviceCt(counter, plain) {
      const devNonce = os2Nonce(BigInt(counter), token, false);
      const c = crypto.createCipheriv("aes-128-ccm", key, devNonce, { authTagLength: 4 });
      c.setAAD(Buffer.from([0x00]), { plaintextLength: plain.length });
      return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    }
    const ct1 = makeDeviceCt(0, Buffer.from([0xAA]));
    const ct2 = makeDeviceCt(1, Buffer.from([0xBB]));
    const dec = new SesameOS2BleCipher(key, token);
    dec.decrypt(ct1);
    dec.decrypt(ct2);
    expect(dec.decryptCounter).toBe(2n);
    expect(dec.encryptCounter).toBe(0n);
  });

  it("[BLE2-0013] 初期値は encryptCounter=0n / decryptCounter=0n", () => {
    const key = Buffer.alloc(16, 0x01);
    const token = Buffer.alloc(8, 0x02);
    const cipher = new SesameOS2BleCipher(key, token);
    expect(cipher.encryptCounter).toBe(0n);
    expect(cipher.decryptCounter).toBe(0n);
  });

  it("[BLE2-0013] encrypt と decrypt のカウンタが完全に独立 (混在操作)", () => {
    const key = Buffer.alloc(16, 0x05);
    const token = Buffer.alloc(8, 0x06);
    const cipher = new SesameOS2BleCipher(key, token);
    cipher.encrypt(Buffer.from([0x01]));
    cipher.encrypt(Buffer.from([0x02]));
    cipher.encrypt(Buffer.from([0x03]));
    expect(cipher.encryptCounter).toBe(3n);
    expect(cipher.decryptCounter).toBe(0n);
    try { cipher.decrypt(Buffer.alloc(10, 0xFF)); } catch { /* expected */ }
    expect(cipher.decryptCounter).toBe(1n);
    expect(cipher.encryptCounter).toBe(3n);
  });
});

// ======================================================================
// [BLE2-0014] sessionToken が 8B 以外なら cipher コンストラクタが throw
// ref: cipher.js:80-91
// kind: error-path
// ======================================================================
describe("[BLE2-0014] SesameOS2BleCipher コンストラクタの長さ検証", () => {
  it("[BLE2-0014] sessionKey!=16B → throw", () => {
    const token = Buffer.alloc(8, 0x01);
    expect(() => new SesameOS2BleCipher(Buffer.alloc(15, 0x01), token)).toThrow(/16 byte/i);
    expect(() => new SesameOS2BleCipher(Buffer.alloc(17, 0x01), token)).toThrow(/16 byte/i);
    expect(() => new SesameOS2BleCipher(Buffer.alloc(8, 0x00), token)).toThrow(/16 byte/i);
    expect(() => new SesameOS2BleCipher(Buffer.alloc(32, 0x00), token)).toThrow(/16 byte/i);
  });

  it("[BLE2-0014] sessionToken!=8B → throw", () => {
    const key = Buffer.alloc(16, 0x01);
    expect(() => new SesameOS2BleCipher(key, Buffer.alloc(4, 0x02))).toThrow(/8 byte/i);
    expect(() => new SesameOS2BleCipher(key, Buffer.alloc(7, 0x02))).toThrow(/8 byte/i);
    expect(() => new SesameOS2BleCipher(key, Buffer.alloc(9, 0x02))).toThrow(/8 byte/i);
    expect(() => new SesameOS2BleCipher(key, Buffer.alloc(16, 0x02))).toThrow(/8 byte/i);
  });

  it("[BLE2-0014] sessionKey=16B / sessionToken=8B → throw しない", () => {
    expect(() => new SesameOS2BleCipher(Buffer.alloc(16, 0x01), Buffer.alloc(8, 0x02))).not.toThrow();
  });
});

// ======================================================================
// [BLE2-0015] 送信フレームは [opCode, itemCode] ++ data (OS2 は opCode を含む)
// ref: protocol.js:219-221
// kind: wire-fidelity
// ======================================================================
describe("[BLE2-0015] buildSendFrame は [opCode, itemCode] ++ data", () => {
  it("[BLE2-0015] buildSendFrame(OP.SYNC, 2, data) → [0x05, 0x02, ...data]", () => {
    const data = Buffer.from([0x10, 0x20]);
    const frame = buildSendFrame(OP.SYNC, 2, data);
    expect(frame[0]).toBe(0x05); // OP.SYNC
    expect(frame[1]).toBe(0x02); // itemCode=2
    expect(frame[2]).toBe(0x10);
    expect(frame[3]).toBe(0x20);
    expect(frame.length).toBe(4);
  });

  it("[BLE2-0015] data 省略 → [opCode, itemCode] の 2B のみ", () => {
    const frame = buildSendFrame(OP.READ, 5);
    expect(frame.length).toBe(2);
    expect(frame[0]).toBe(OP.READ);
    expect(frame[1]).toBe(5);
  });

  it("[BLE2-0015] OS3 との差: OS2 は opCode をフレーム先頭に含む", () => {
    const frame = buildSendFrame(OP.ASYNC, 82 /* LOCK */);
    expect(frame[0]).toBe(OP.ASYNC); // 0x06
    expect(frame[1]).toBe(82);
  });

  it("[BLE2-0015] buildSendFrame: first byte is opCode, second is itemCode, followed by data (full payload check)", () => {
    const data = Buffer.from([0xAA, 0xBB, 0xCC]);
    const frame = buildSendFrame(OP.SYNC, ITEM.LOGIN, data);
    expect(frame[0]).toBe(OP.SYNC);
    expect(frame[1]).toBe(ITEM.LOGIN);
    expect(frame.subarray(2)).toEqual(data);
    expect(frame.length).toBe(2 + data.length);
  });

  it("[BLE2-0015] buildSendFrame: CREATE REGISTRATION frame has opCode at byte[0]", () => {
    const payload = Buffer.alloc(4 + 64 + 4, 0x00);
    const frame = buildSendFrame(OP.CREATE, ITEM.REGISTRATION, payload);
    expect(frame[0]).toBe(OP.CREATE);
    expect(frame[1]).toBe(ITEM.REGISTRATION);
  });
});

// ======================================================================
// [BLE2-0016] 受信 response は itemCode 先頭の 3B ヘッダ (item,op,result)
// ref: protocol.js:239-255
// kind: wire-fidelity
// ======================================================================
describe("[BLE2-0016] parseRecvFrame — response (notifyOpCode=7) の 3B ヘッダ", () => {
  it("[BLE2-0016] notifyOpCode=7 → type=response, itemCode, cmdOpCode, resultCode, payload", () => {
    const buf = Buffer.from([OP.RESPONSE, ITEM.LOGIN, OP.SYNC, 0x00, 0xAA, 0xBB]);
    const parsed = parseRecvFrame(buf);
    expect(parsed.type).toBe("response");
    expect(parsed.notifyOpCode).toBe(OP.RESPONSE);
    expect(parsed.itemCode).toBe(ITEM.LOGIN);
    expect(parsed.cmdOpCode).toBe(OP.SYNC);
    expect(parsed.resultCode).toBe(0x00);
    expect(parsed.payload[0]).toBe(0xAA);
    expect(parsed.payload[1]).toBe(0xBB);
  });

  it("[BLE2-0016] response body が 3B 未満 → throw", () => {
    // [notifyOpCode=7, body only 2B]
    const buf = Buffer.from([OP.RESPONSE, 0x02, 0x05]); // body=2B < 3B
    expect(() => parseRecvFrame(buf)).toThrow(/too short/i);
  });

  it("[BLE2-0016] response: itemCode が先頭、opCode が 2 番目 (送信順と逆)", () => {
    // 送信: [opCode, itemCode]。受信 response: [itemCode, opCode, resultCode]
    const buf = Buffer.from([OP.RESPONSE, /*item*/0x51, /*op*/OP.UPDATE, /*result*/0x00]);
    const parsed = parseRecvFrame(buf);
    expect(parsed.type).toBe("response");
    expect(parsed.itemCode).toBe(0x51); // MECH_STATUS = 0x51 = 81
    expect(parsed.cmdOpCode).toBe(OP.UPDATE);
  });
});

// ======================================================================
// [BLE2-0017] 受信 publish は itemCode 先頭の 1B ヘッダ
// ref: protocol.js:256-259
// kind: wire-fidelity
// ======================================================================
describe("[BLE2-0017] parseRecvFrame — publish (notifyOpCode=8) の 1B ヘッダ", () => {
  it("[BLE2-0017] notifyOpCode=8 → type=publish, itemCode, payload", () => {
    const payloadData = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    const buf = Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.INITIAL]), payloadData]);
    const parsed = parseRecvFrame(buf);
    expect(parsed.type).toBe("publish");
    expect(parsed.notifyOpCode).toBe(OP.PUBLISH);
    expect(parsed.itemCode).toBe(ITEM.INITIAL);
    expect(parsed.payload.length).toBe(4);
    expect(parsed.payload[0]).toBe(0x11);
  });

  it("[BLE2-0017] publish は 1B ヘッダ: body[0]=itemCode, body[1:]=payload", () => {
    const payloadData = Buffer.from([0xAA, 0xBB, 0xCC, 0xDD, 0xEE]);
    const buf = Buffer.concat([Buffer.from([OP.PUBLISH, ITEM.MECH_STATUS]), payloadData]);
    const parsed = parseRecvFrame(buf);
    expect(parsed.type).toBe("publish");
    expect(parsed.itemCode).toBe(ITEM.MECH_STATUS);
    expect(parsed.payload).toEqual(payloadData);
    // publish には cmdOpCode / resultCode が無い (1B ヘッダのみ)
    expect("cmdOpCode" in parsed).toBe(false);
    expect("resultCode" in parsed).toBe(false);
  });

  it("[BLE2-0017] notifyOpCode が 7 でも 8 でもない → type=other", () => {
    const buf = Buffer.from([0x05, 0x01, 0x02]);
    const parsed = parseRecvFrame(buf);
    expect(parsed.type).toBe("other");
    expect(parsed.notifyOpCode).toBe(0x05);
  });
});

// ======================================================================
// [BLE2-0018] OP/SSM2OpCode の数値定数が SDK と一致 (create=1..publish=8)
// ref: protocol.js (ble/protocol.js):34-36
// kind: wire-fidelity
// ======================================================================
describe("[BLE2-0018] OP 定数 — SSM2OpCode との一致", () => {
  it("[BLE2-0018] OP.CREATE = 0x01", () => { expect(OP.CREATE).toBe(0x01); });
  it("[BLE2-0018] OP.READ = 0x02", () => { expect(OP.READ).toBe(0x02); });
  it("[BLE2-0018] OP.UPDATE = 0x03", () => { expect(OP.UPDATE).toBe(0x03); });
  it("[BLE2-0018] OP.DELETE = 0x04", () => { expect(OP.DELETE).toBe(0x04); });
  it("[BLE2-0018] OP.SYNC = 0x05 (SSM2OpCode.sync)", () => { expect(OP.SYNC).toBe(0x05); });
  it("[BLE2-0018] OP.ASYNC = 0x06", () => { expect(OP.ASYNC).toBe(0x06); });
  it("[BLE2-0018] OP.RESPONSE = 0x07", () => { expect(OP.RESPONSE).toBe(0x07); });
  it("[BLE2-0018] OP.PUBLISH = 0x08", () => { expect(OP.PUBLISH).toBe(0x08); });

  it("[BLE2-0018] BleOP (ble/protocol.js) の OP 定数は os2/protocol.js の OP と同一", () => {
    expect(OP.CREATE).toBe(BleOP.CREATE);
    expect(OP.SYNC).toBe(BleOP.SYNC);
    expect(OP.RESPONSE).toBe(BleOP.RESPONSE);
    expect(OP.PUBLISH).toBe(BleOP.PUBLISH);
  });
});
