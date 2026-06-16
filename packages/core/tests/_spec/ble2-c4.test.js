// BLE2 OS2 spec テスト — BLE2-0077, BLE2-0078
// ネットワーク/実機不使用。pure functions / mock のみ。決定論的。
//
// BLE2-0077: history() 手動読み出し payload (item=history(4) / ack byte 0x01|0x00)
//   surface: core | kind: payload-fidelity
//   ref: packages/core/src/ble/os2/index.js:262-265
//       _sesame_sdk_ref/.../ble/os2/CHSesame2Device.kt:602-612
//
// BLE2-0078: local CMAC login の sessionAuth 組み立て + loginPayload byte レイアウト
//   surface: core | kind: payload-fidelity
//   ref: packages/core/src/ble/os2/protocol.js:116-127 (sessionAuth)
//       packages/core/src/ble/os2/protocol.js:141-150 (loginPayload)
//       packages/core/src/ble/os2/session.js:650-651
//       _sesame_sdk_ref/.../ble/os2/CHSesame2Device.kt:238-243 (sessionAuth)
//       _sesame_sdk_ref/.../ble/os2/CHSesame2Device.kt:252 (loginPayload)

import { describe, it, expect, vi } from "vitest";
import { Buffer } from "node:buffer";
import { aesCmac } from "../../src/aes-cmac.js";
import {
  OP,
  ITEM,
  sessionAuth,
  loginPayload,
  sessionToken,
} from "../../src/ble/os2/protocol.js";
import { SesameOS2Ble } from "../../src/ble/os2/index.js";

// ============================================================
// ヘルパ: SesameOS2Ble の _session.request をスタブで差し替える
// ============================================================

function makeTransportStub() {
  return {
    connect: vi.fn(),
    write: vi.fn(),
    disconnect: vi.fn(),
  };
}

function makeConnectedFacade(overrides = {}) {
  const transport = makeTransportStub();
  const facade = new SesameOS2Ble({
    transport,
    secretKey: "0102030405060708090a0b0c0d0e0f10",
    keyIndex: "0000",
    ssmPublicKey: Buffer.alloc(64, 0xab).toString("hex"),
    model: "sesame_3",
    ...overrides,
  });
  return facade;
}

// ============================================================
// [BLE2-0077] history() 手動読み出し payload
//
// assert: history({ack=true}) は OP.READ item=history(4) に 1B [ack?0x01:0x00] を送り
//         raw payload を返す。ack 既定 true (読み出し後デバイス側削除)。
//         SDK readHistoryCommand は isInternetAvailable() で 0x01/0x00 を切替
//         (CHSesame2Device.kt:606-612)。
// ref:    packages/core/src/ble/os2/index.js:262-265
//         _sesame_sdk_ref/.../CHSesame2Device.kt:602-612
// ============================================================

describe("[BLE2-0077] SesameOS2Ble.history — ack byte (0x01|0x00) and return payload", () => {
  it("[BLE2-0077] history(ack=true 既定) は OP.READ, ITEM.HISTORY, [0x01] を session.request に渡す", async () => {
    // 出典: index.js:262-265 (ack=true → Buffer.from([0x01]))
    // SDK: CHSesame2Device.kt:610 `byteArrayOf(1)` (isInternetAvailable=true 経路)
    const facade = makeConnectedFacade();
    const fakePayload = Buffer.from([0xde, 0xad, 0xbe, 0xef]);

    const requestSpy = vi.fn().mockResolvedValue({ resultCode: 0, payload: fakePayload });
    facade._session.request = requestSpy;

    const result = await facade.history(); // ack 既定 = true

    expect(requestSpy).toHaveBeenCalledTimes(1);
    const [opArg, itemArg, dataArg] = requestSpy.mock.calls[0];
    expect(opArg).toBe(OP.READ);
    expect(itemArg).toBe(ITEM.HISTORY);
    expect(Buffer.isBuffer(dataArg)).toBe(true);
    expect(dataArg.length).toBe(1);
    expect(dataArg[0]).toBe(0x01);
    expect(result).toStrictEqual(fakePayload);
  });

  it("[BLE2-0077] history({ack:false}) は data=[0x00] を送る (読み出しのみ、デバイス削除なし)", async () => {
    // 出典: index.js:263 `ack ? 0x01 : 0x00`
    // SDK: CHSesame2Device.kt:608 `byteArrayOf(0)` (isInternetAvailable=false 経路)
    const facade = makeConnectedFacade();
    const fakePayload = Buffer.from([0x11, 0x22]);

    const requestSpy = vi.fn().mockResolvedValue({ resultCode: 0, payload: fakePayload });
    facade._session.request = requestSpy;

    const result = await facade.history({ ack: false });

    const [opArg, itemArg, dataArg] = requestSpy.mock.calls[0];
    expect(opArg).toBe(OP.READ);
    expect(itemArg).toBe(ITEM.HISTORY);
    expect(dataArg[0]).toBe(0x00);
    expect(result).toStrictEqual(fakePayload);
  });

  it("[BLE2-0077] history({ack:true}) は data=[0x01] を送る (明示 true)", async () => {
    const facade = makeConnectedFacade();
    const fakePayload = Buffer.from([0xaa]);

    const requestSpy = vi.fn().mockResolvedValue({ resultCode: 0, payload: fakePayload });
    facade._session.request = requestSpy;

    const result = await facade.history({ ack: true });

    const [, , dataArg] = requestSpy.mock.calls[0];
    expect(dataArg[0]).toBe(0x01);
    expect(result).toStrictEqual(fakePayload);
  });

  it("[BLE2-0077] history() は session.request の payload をそのまま返す (raw 返却、コピーしない)", async () => {
    // ack byte は 1B のみ。payload は response.payload そのまま (raw 返却)
    const rawPayload = Buffer.from("deadbeef1234", "hex");
    const facade = makeConnectedFacade();

    facade._session.request = () => Promise.resolve({ resultCode: 0, payload: rawPayload });

    const result = await facade.history({ ack: true });

    expect(result).toEqual(rawPayload);
    expect(result).toBe(rawPayload); // 同一参照 (コピーしない)
  });

  it("[BLE2-0077] ITEM.HISTORY の数値は 4 (SesameItemCode.history=4, BLE2-0019 と整合)", () => {
    // 出典: itemcodes.js history=4 / CHSesame2Device.kt:602-612
    expect(ITEM.HISTORY).toBe(4);
  });

  it("[BLE2-0077] OP.READ の数値は 0x02 (BLE2-0018 と整合)", () => {
    // 出典: protocol.js OP.READ = 0x02 / SDK SSM2OpCode.read = 2
    expect(OP.READ).toBe(0x02);
  });
});

// ============================================================
// [BLE2-0078] local CMAC login の sessionAuth 組み立て + loginPayload byte レイアウト
//
// assert: ローカル認証 login (isNeedAuthFromServer=false) は
//   sessionAuth = AES-128-CMAC(secretKey, userIdx ++ appPubKey64 ++ sessionToken8)
//   loginPayload = userIdx ++ appPubKey64 ++ mAppToken4 ++ sessionAuth[0:4]
//   (SDK CHSesame2Device.kt:238-243 sessionAuth + :252 loginPayload と一致)
// ref:    packages/core/src/ble/os2/protocol.js:116-127 (sessionAuth)
//         packages/core/src/ble/os2/protocol.js:141-150 (loginPayload)
//         _sesame_sdk_ref/.../CHSesame2Device.kt:238-243, :252
// ============================================================

describe("[BLE2-0078] protocol.sessionAuth — AES-128-CMAC(secretKey, userIdx++appPubKey64++sessionToken8)", () => {
  // 固定テストベクタ (純粋関数なので決定論的)
  const SECRET_KEY      = Buffer.alloc(16, 0x01);                // 16B secretKey
  const USER_IDX        = Buffer.from("0000", "hex");            // 2B keyIndex
  const APP_PUB_64      = Buffer.alloc(64, 0x02);                // 64B appPublicKey64 (X‖Y prefix なし)
  const SESAME_TOKEN    = Buffer.alloc(4, 0x03);                 // 4B mSesameToken
  const APP_TOKEN       = Buffer.alloc(4, 0x04);                 // 4B mAppToken
  // sessionToken8 = mAppToken4 ++ mSesameToken4 (sessionToken() の戻り)
  const SESSION_TOKEN_8 = Buffer.concat([APP_TOKEN, SESAME_TOKEN]); // 8B

  it("[BLE2-0078] sessionAuth は AES-128-CMAC(secretKey, userIdx++appPubKey64++sessionToken8)", () => {
    // 出典: protocol.js:116-127 / SDK CHSesame2Device.kt:238-243
    //   signPayload = keyIndex ++ appPublicKey ++ sessionToken   (CHSesame2Device.kt:238)
    //   sessionAuth = AesCmac(secretKey, signPayload)           (CHSesame2Device.kt:243)
    const signPayload = Buffer.concat([USER_IDX, APP_PUB_64, SESSION_TOKEN_8]);
    const expected = aesCmac(SECRET_KEY, signPayload); // 16B

    const actual = sessionAuth(SECRET_KEY, USER_IDX, APP_PUB_64, SESSION_TOKEN_8);

    expect(actual.length).toBe(16);
    expect(actual).toStrictEqual(expected);
  });

  it("[BLE2-0078] sessionAuth signPayload = userIdx ++ appPubKey64 ++ sessionToken8 (結合順の固定)", () => {
    // signPayload の結合順が逆だと別の CMAC 値になる。ここでは順序を検証する
    const signPayload = Buffer.concat([USER_IDX, APP_PUB_64, SESSION_TOKEN_8]);
    expect(signPayload.length).toBe(2 + 64 + 8); // 74B

    // 順序を意図的に逆にした signPayload は異なる CMAC を出す
    const wrongOrder = Buffer.concat([SESSION_TOKEN_8, APP_PUB_64, USER_IDX]);
    const correctAuth = aesCmac(SECRET_KEY, signPayload);
    const wrongAuth   = aesCmac(SECRET_KEY, wrongOrder);
    expect(correctAuth).not.toStrictEqual(wrongAuth);

    // sessionAuth() の戻りは正しい順序
    const actual = sessionAuth(SECRET_KEY, USER_IDX, APP_PUB_64, SESSION_TOKEN_8);
    expect(actual).toStrictEqual(correctAuth);
  });

  it("[BLE2-0078] sessionAuth の戻りは 16B (AES-128-CMAC 出力長)", () => {
    const actual = sessionAuth(SECRET_KEY, USER_IDX, APP_PUB_64, SESSION_TOKEN_8);
    expect(actual.length).toBe(16);
  });

  it("[BLE2-0078] secretKey が 16B 以外なら throw (防御的検証)", () => {
    // 出典: protocol.js:118 `if (key.length !== 16) throw`
    const badKey = Buffer.alloc(8, 0x01); // 8B
    expect(() => sessionAuth(badKey, USER_IDX, APP_PUB_64, SESSION_TOKEN_8)).toThrow();
  });

  it("[BLE2-0078] appPublicKey64 が 64B 以外なら throw (64B raw X‖Y 必須)", () => {
    // 出典: protocol.js:121-122 `if (pub.length !== 64) throw`
    const badPub65 = Buffer.alloc(65, 0x02); // 65B (0x04 prefix 付きの誤り形式)
    expect(() => sessionAuth(SECRET_KEY, USER_IDX, badPub65, SESSION_TOKEN_8)).toThrow();
    const badPub63 = Buffer.alloc(63, 0x02); // 63B
    expect(() => sessionAuth(SECRET_KEY, USER_IDX, badPub63, SESSION_TOKEN_8)).toThrow();
  });

  it("[BLE2-0078] sessionToken が 8B 以外なら throw (8B 必須: mAppToken4++mSesameToken4)", () => {
    // 出典: protocol.js:122-124 `sessionToken must be 8 bytes`
    const badToken4 = Buffer.alloc(4, 0x03); // 4B (片方しか連結されていない誤り)
    expect(() => sessionAuth(SECRET_KEY, USER_IDX, APP_PUB_64, badToken4)).toThrow();
    const badToken7 = Buffer.alloc(7, 0x03); // 7B
    expect(() => sessionAuth(SECRET_KEY, USER_IDX, APP_PUB_64, badToken7)).toThrow();
  });

  it("[BLE2-0078] 異なる secretKey で auth が変わる (鍵識別テスト / 回帰防止)", () => {
    // pre16 を secretKey に誤って渡すと異なる auth になり login が失敗する (BLE2-0025 の補強)
    const wrongKey = Buffer.alloc(16, 0xff);
    const auth1 = sessionAuth(SECRET_KEY, USER_IDX, APP_PUB_64, SESSION_TOKEN_8);
    const auth2 = sessionAuth(wrongKey, USER_IDX, APP_PUB_64, SESSION_TOKEN_8);
    expect(auth1).not.toStrictEqual(auth2);
  });
});

describe("[BLE2-0078] protocol.loginPayload — byte レイアウト検証", () => {
  // 固定テストベクタ
  const USER_IDX    = Buffer.from("0000", "hex");  // 2B
  const APP_PUB_64  = Buffer.alloc(64, 0x02);       // 64B
  const M_APP_TOKEN = Buffer.alloc(4, 0x04);         // 4B mAppToken
  const AUTH_16     = Buffer.alloc(16, 0xcc);         // 16B (sessionAuth の戻りを模擬)

  it("[BLE2-0078] loginPayload = userIdx ++ appPubKey64 ++ mAppToken4 ++ sessionAuth[0:4] (SDK :252 一致)", () => {
    // 出典: protocol.js:141-150 / SDK CHSesame2Device.kt:252
    //   loginPayload = userIdx(keyIndex) ++ appPublicKey ++ mAppToken4 ++ sessionAuth.sliceArray(0..3)
    const result = loginPayload(USER_IDX, APP_PUB_64, M_APP_TOKEN, AUTH_16);

    // 総 byte 長 = 2 + 64 + 4 + 4 = 74B
    expect(result.length).toBe(74);

    // 各フィールドの位置を検証
    expect(result.subarray(0, 2)).toStrictEqual(USER_IDX);
    expect(result.subarray(2, 66)).toStrictEqual(APP_PUB_64);
    expect(result.subarray(66, 70)).toStrictEqual(M_APP_TOKEN);
    // sessionAuth[0:4] = 先頭 4B のみ (SDK sliceArray(0..3))
    expect(result.subarray(70, 74)).toStrictEqual(AUTH_16.subarray(0, 4));
  });

  it("[BLE2-0078] loginPayload の先頭 2B は userIdx (keyIndex)", () => {
    const lp = loginPayload(USER_IDX, APP_PUB_64, M_APP_TOKEN, AUTH_16);
    expect(lp.subarray(0, 2)).toStrictEqual(USER_IDX);
  });

  it("[BLE2-0078] loginPayload の [2:66] は appPublicKey64 (64B 公開鍵 raw)", () => {
    const lp = loginPayload(USER_IDX, APP_PUB_64, M_APP_TOKEN, AUTH_16);
    expect(lp.subarray(2, 66)).toStrictEqual(APP_PUB_64);
  });

  it("[BLE2-0078] loginPayload の [66:70] は mAppToken4 (アプリ側ランダム token 4B)", () => {
    const lp = loginPayload(USER_IDX, APP_PUB_64, M_APP_TOKEN, AUTH_16);
    expect(lp.subarray(66, 70)).toStrictEqual(M_APP_TOKEN);
  });

  it("[BLE2-0078] loginPayload の末尾 4B は sessionAuth[0:4] のみ (sliceArray(0..3)、16B 全体ではない)", () => {
    // SDK :252 `sessionAuth!!.sliceArray(0..3)` は先頭 4B のみ使う
    const lp = loginPayload(USER_IDX, APP_PUB_64, M_APP_TOKEN, AUTH_16);
    expect(lp.subarray(70, 74)).toStrictEqual(AUTH_16.subarray(0, 4));
    expect(lp.length).toBe(74); // 2+64+4+4 (16B auth 全体は含まない)
  });

  it("[BLE2-0078] mAppToken4 が 4B 以外なら throw (protocol.js:147)", () => {
    // 出典: protocol.js:147 `if (app.length !== 4) throw`
    const bad8 = Buffer.alloc(8, 0x04);
    expect(() => loginPayload(USER_IDX, APP_PUB_64, bad8, AUTH_16)).toThrow();
    const bad3 = Buffer.alloc(3, 0x01);
    expect(() => loginPayload(USER_IDX, APP_PUB_64, bad3, AUTH_16)).toThrow();
  });

  it("[BLE2-0078] sessionAuth が 4B 未満なら throw (sliceArray(0..3) 前提を守る)", () => {
    // 出典: protocol.js:148 `if (auth.length < 4) throw`
    const shortAuth = Buffer.alloc(3, 0x01);
    expect(() => loginPayload(USER_IDX, APP_PUB_64, M_APP_TOKEN, shortAuth)).toThrow();
  });

  it("[BLE2-0078] appPubKey64 が 64B 以外なら throw (protocol.js:146)", () => {
    // 出典: protocol.js:146 `if (pub.length !== 64) throw`
    const badPub = Buffer.alloc(32, 0x02);
    expect(() => loginPayload(USER_IDX, badPub, M_APP_TOKEN, AUTH_16)).toThrow();
  });

  it("[BLE2-0078] sessionAuth を 4B ちょうど渡しても throw しない (境界値 = 4B OK)", () => {
    // 4B はギリギリ許容 (sliceArray(0..3) のために最低 4B 必要)
    const auth4 = Buffer.alloc(4, 0xcc);
    expect(() => loginPayload(USER_IDX, APP_PUB_64, M_APP_TOKEN, auth4)).not.toThrow();
    const result = loginPayload(USER_IDX, APP_PUB_64, M_APP_TOKEN, auth4);
    expect(result.subarray(70, 74)).toStrictEqual(auth4);
  });

  it("[BLE2-0078] sessionToken8 = sessionToken(mAppToken4, mSsmToken4) で 8B 構成を確認", () => {
    // 出典: protocol.js:78-84 / SDK CHSesame2Device.kt:237 `val sessionToken = mAppToken + mSesameToken`
    const mApp = Buffer.alloc(4, 0x04);
    const mSsm = Buffer.alloc(4, 0x03);
    const st = sessionToken(mApp, mSsm);
    expect(st.length).toBe(8);
    expect(st.subarray(0, 4)).toStrictEqual(mApp);
    expect(st.subarray(4)).toStrictEqual(mSsm);
  });
});

describe("[BLE2-0078] sessionAuth + loginPayload 結合 E2E — ローカル CMAC login 経路", () => {
  // SDK CHSesame2Device.kt:238-252 の local-auth 経路を純関数レベルで再現する
  const SECRET_KEY    = Buffer.from("aabbccddeeff00112233445566778899", "hex"); // 16B
  const KEY_IDX       = Buffer.from("0000", "hex");                              // 2B
  const APP_PUB_64    = Buffer.alloc(64, 0x7f);                                  // 64B
  const M_APP_TOKEN_4 = Buffer.from([0x10, 0x20, 0x30, 0x40]);                  // 4B
  const M_SSM_TOKEN_4 = Buffer.from([0xa1, 0xb2, 0xc3, 0xd4]);                  // 4B
  const SESSION_TOKEN = Buffer.concat([M_APP_TOKEN_4, M_SSM_TOKEN_4]);            // 8B

  it("[BLE2-0078] E2E: sessionAuth+loginPayload の組み立てが SDK :238-252 と 1:1 一致する", () => {
    // Step 1: signPayload を組み立て (SDK :238)
    const signPayload = Buffer.concat([KEY_IDX, APP_PUB_64, SESSION_TOKEN]);
    expect(signPayload.length).toBe(74); // 2+64+8

    // Step 2: sessionAuth = CMAC(secretKey, signPayload) (SDK :243)
    const auth = sessionAuth(SECRET_KEY, KEY_IDX, APP_PUB_64, SESSION_TOKEN);
    const expectedAuth = aesCmac(SECRET_KEY, signPayload);
    expect(auth).toStrictEqual(expectedAuth);

    // Step 3: loginPayload = keyIndex ++ appPublicKeyBytes ++ mAppToken4 ++ sessionAuth[0:4] (SDK :252)
    const lp = loginPayload(KEY_IDX, APP_PUB_64, M_APP_TOKEN_4, auth);
    expect(lp.length).toBe(74); // 2+64+4+4

    expect(lp.subarray(0,  2)).toStrictEqual(KEY_IDX);
    expect(lp.subarray(2,  66)).toStrictEqual(APP_PUB_64);
    expect(lp.subarray(66, 70)).toStrictEqual(M_APP_TOKEN_4);
    expect(lp.subarray(70, 74)).toStrictEqual(auth.subarray(0, 4));
  });

  it("[BLE2-0078] loginPayload の末尾 4B = sessionAuth 先頭 4B (sessionToken8 全体ではない)", () => {
    // SDK :252 は sliceArray(0..3) — sessionToken の最後 4B ではなく sessionAuth の先頭 4B
    // 両者は異なる値なので混同をここで防ぐ
    const auth = sessionAuth(SECRET_KEY, KEY_IDX, APP_PUB_64, SESSION_TOKEN);
    const lp   = loginPayload(KEY_IDX, APP_PUB_64, M_APP_TOKEN_4, auth);

    const tailInPayload = lp.subarray(70, 74);
    const authFirst4    = auth.subarray(0, 4);
    const tokenFirst4   = SESSION_TOKEN.subarray(0, 4); // mAppToken4

    expect(tailInPayload).toStrictEqual(authFirst4);
    // sessionAuth[0:4] と SESSION_TOKEN[0:4] は異なることを確認
    expect(tailInPayload).not.toStrictEqual(tokenFirst4);
  });
});
