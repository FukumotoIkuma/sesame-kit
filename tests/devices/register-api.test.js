// tests/devices/register-api.test.js
//
// src/devices.js の BLE デバイス登録 REST API クライアント (reg-guestkey-sign-client) を検証する:
//   signGuestKey(transport, {deviceUUID, tokenHex, secretKey})        → session token (hex)
//   registerSesame5(transport, {deviceUUID, productType, serverSecret}) → サーバ応答
//   makeRegisterTransport({baseUrl, tokenStore, fetchImpl})           → transport 関数
//
// 原典 (CANDY-HOUSE SesameSDK):
//   co/candyhouse/sesame/server/CHAPIClient.kt:84-96 — エンドポイント:
//     POST /device/v1/sesame5/{device_id}, POST /device/v1/sesame2/sign
//   co/candyhouse/sesame/ble/os3/base/CHSesameOS3.kt:474-484 — signGuestKey:
//     CHRemoveSignKeyRequest(deviceId.uppercase(), mSesameToken.toHexString(), secretKey)
//     成功時 login(it.data) = 戻り String が session token (hex)
//   co/candyhouse/sesame/ble/os3/CHHub3Device.kt:183-186 — register:
//     CHOS3RegisterReq(productModel.productType().toString(), serverSecret)
//   co/candyhouse/sesame/server/dto/CHHistoryUploadRequest.kt:8 — CHRemoveSignKeyRequest(deviceId, token, secretKey)
//   co/candyhouse/sesame/server/dto/CHSS2RegisterReq.kt:5 — CHOS3RegisterReq(t, pk) → JSON {t, pk}
//
// ★検証範囲: fake transport を注入し **リクエスト整形のみ** を検証する
//   (フィールド名 / deviceId 大文字化 / token hex / パス / productType 文字列化)。
//   本番ホスト・API Gateway 認証方式は UNVERIFIED (src/devices.js のブロック注記参照)。

import { describe, it, expect } from "vitest";
import {
  signGuestKey,
  registerSesame5,
  makeRegisterTransport,
  resolveRegisterTransport,
} from "../../src/devices.js";
import { CONSUMER_CLIENT_ID } from "../../src/auth.js";
import { productTypeFromModelName } from "../../src/crypto.js";

const CONFIRMED_DEVICE = {
  deviceKey: "dev-key-abc",
  deviceGroupKey: "dev-group-abc",
  devicePassword: "dev-password-abc",
};

// fake transport: 受け取ったリクエストを記録し、固定応答を返す。
function makeFakeTransport(response) {
  const calls = [];
  const fn = async (req) => {
    calls.push(req);
    return response;
  };
  fn.calls = calls;
  return fn;
}

describe("signGuestKey (CHSesameOS3.kt:474-484)", () => {
  const args = {
    deviceUUID: "aabbccdd-1122-3344-5566-778899aabbcc", // 小文字 → 大文字化されること
    tokenHex: "0011223344556677",
    secretKey: "00112233445566778899aabbccddeeff",
  };

  it("CHRemoveSignKeyRequest 相当 {deviceId(大文字), token(hex), secretKey} を /device/v1/sesame2/sign へ POST する", async () => {
    const transport = makeFakeTransport({ status: 200, text: "deadbeefcafe", json: "deadbeefcafe" });
    await signGuestKey(transport, args);

    expect(transport.calls).toHaveLength(1);
    const req = transport.calls[0];
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/device/v1/sesame2/sign");
    // フィールド名は DTO そのまま、deviceId は大文字化、token は hex、secretKey はそのまま
    expect(req.body).toEqual({
      deviceId: "AABBCCDD-1122-3344-5566-778899AABBCC",
      token: "0011223344556677",
      secretKey: "00112233445566778899aabbccddeeff",
    });
  });

  it("戻り値 String (= login(it.data)) を session token として返す (素の json string)", async () => {
    const transport = makeFakeTransport({ status: 200, text: "deadbeefcafe", json: "deadbeefcafe" });
    const token = await signGuestKey(transport, args);
    expect(token).toBe("deadbeefcafe");
  });

  it("transport が body を JSON 文字列としてパースした場合は res.json(string) を採る", async () => {
    // vendor は素の String を返す (CHAPIClient.kt:95 `: String`)。{data:...} ラップは存在しない。
    // text が無く transport が body を JSON 文字列に decode したケースのみ res.json を使う。
    const transport = makeFakeTransport({ status: 200, text: "", json: "abc123" });
    const token = await signGuestKey(transport, args);
    expect(token).toBe("abc123");
  });

  it("json が無く text のみでも session token を解決する", async () => {
    const transport = makeFakeTransport({ status: 200, text: "rawtokenhex", json: null });
    const token = await signGuestKey(transport, args);
    expect(token).toBe("rawtokenhex");
  });

  it("session token が空なら明示エラー", async () => {
    const transport = makeFakeTransport({ status: 200, text: "", json: null });
    await expect(signGuestKey(transport, args)).rejects.toThrow(/no session token/);
  });

  it("非 2xx (エラー JSON ボディ) を session token として誤採用せず明示エラーで拒否する", async () => {
    // サーバが 403 をエラー JSON ボディで返すケース。旧実装は '{"message":"forbidden"}'
    // 相当の文字列を token として返してしまう silent failure があった。
    const transport = makeFakeTransport({
      status: 403,
      text: '{"message":"forbidden"}',
      json: { message: "forbidden" },
    });
    await expect(signGuestKey(transport, args)).rejects.toThrow(/HTTP 403/);
    await expect(signGuestKey(transport, args)).rejects.toThrow(/forbidden/);
  });

  it("非 2xx (5xx) も拒否する", async () => {
    const transport = makeFakeTransport({ status: 500, text: "internal error", json: null });
    await expect(signGuestKey(transport, args)).rejects.toThrow(/HTTP 500/);
  });

  it("入力バリデーション (transport / deviceUUID / tokenHex / secretKey)", async () => {
    const transport = makeFakeTransport({ status: 200, text: "x", json: "x" });
    await expect(signGuestKey(null, args)).rejects.toThrow(/transport required/);
    await expect(signGuestKey(transport, { ...args, deviceUUID: "" })).rejects.toThrow(/deviceUUID required/);
    await expect(signGuestKey(transport, { ...args, tokenHex: "" })).rejects.toThrow(/tokenHex required/);
    await expect(signGuestKey(transport, { ...args, secretKey: "" })).rejects.toThrow(/secretKey required/);
  });
});

describe("registerSesame5 (CHHub3Device.kt:183-186)", () => {
  const serverSecret = "ffeeddccbbaa99887766554433221100";
  const deviceUUID = "11223344-5566-7788-99aa-bbccddeeff00";

  it("CHOS3RegisterReq 相当 {t: productType文字列, pk: serverSecret} を /device/v1/sesame5/{device_id} へ POST する (model名 → productType)", async () => {
    const transport = makeFakeTransport({ status: 200, text: '{"ok":true}', json: { ok: true } });
    await registerSesame5(transport, { deviceUUID, productType: "sesame_5", serverSecret });

    expect(transport.calls).toHaveLength(1);
    const req = transport.calls[0];
    expect(req.method).toBe("POST");
    // device_id は大文字化しない (CHHub3Device.kt:184 deviceId.toString())
    expect(req.path).toBe(`/device/v1/sesame5/${deviceUUID}`);
    // productType("sesame_5") = 5 → "5"。Gson キーは {t, pk}。
    expect(req.body).toEqual({ t: String(productTypeFromModelName("sesame_5")), pk: serverSecret });
    expect(req.body.t).toBe("5");
  });

  it("数値 productType を直接渡しても文字列化して t に乗せる", async () => {
    const transport = makeFakeTransport({ status: 200, text: "", json: null });
    await registerSesame5(transport, { deviceUUID, productType: 7, serverSecret });
    expect(transport.calls[0].body).toEqual({ t: "7", pk: serverSecret });
  });

  it("数値文字列の productType もそのまま数値として扱う", async () => {
    const transport = makeFakeTransport({ status: 200, text: "", json: null });
    await registerSesame5(transport, { deviceUUID, productType: "13", serverSecret });
    expect(transport.calls[0].body.t).toBe("13");
  });

  it("応答 json があれば json を、無ければ text を返す", async () => {
    const t1 = makeFakeTransport({ status: 200, text: '{"ok":true}', json: { ok: true } });
    expect(await registerSesame5(t1, { deviceUUID, productType: "sesame_5", serverSecret })).toEqual({ ok: true });
    const t2 = makeFakeTransport({ status: 200, text: "accepted", json: null });
    expect(await registerSesame5(t2, { deviceUUID, productType: "sesame_5", serverSecret })).toBe("accepted");
  });

  it("未知の model 名は明示エラー", async () => {
    const transport = makeFakeTransport({ status: 200, text: "", json: null });
    await expect(
      registerSesame5(transport, { deviceUUID, productType: "no_such_model", serverSecret }),
    ).rejects.toThrow(/Unknown product model/);
  });

  it("非 2xx (エラーボディ) を成功応答として誤採用せず明示エラーで拒否する", async () => {
    const transport = makeFakeTransport({ status: 409, text: '{"message":"already registered"}', json: { message: "already registered" } });
    await expect(
      registerSesame5(transport, { deviceUUID, productType: "sesame_5", serverSecret }),
    ).rejects.toThrow(/HTTP 409/);
    await expect(
      registerSesame5(transport, { deviceUUID, productType: "sesame_5", serverSecret }),
    ).rejects.toThrow(/already registered/);
  });

  it("入力バリデーション (transport / deviceUUID / productType / serverSecret)", async () => {
    const transport = makeFakeTransport({ status: 200, text: "", json: null });
    await expect(registerSesame5(null, { deviceUUID, productType: "sesame_5", serverSecret })).rejects.toThrow(/transport required/);
    await expect(registerSesame5(transport, { deviceUUID: "", productType: "sesame_5", serverSecret })).rejects.toThrow(/deviceUUID required/);
    await expect(registerSesame5(transport, { deviceUUID, productType: null, serverSecret })).rejects.toThrow(/productType required/);
    await expect(registerSesame5(transport, { deviceUUID, productType: "sesame_5", serverSecret: "" })).rejects.toThrow(/serverSecret required/);
  });
});

describe("makeRegisterTransport (Cognito idToken 再利用 + fetch 注入)", () => {
  // idToken 検証 (exp claim) を通すため getValidIdToken が refresh せず返せる token を用意する。
  // exp が十分未来の JWT を組む (署名検証はしないので header/payload のみで足りる)。
  function fakeJwt(expSec) {
    const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return `${b64u({ alg: "none" })}.${b64u({ aud: CONSUMER_CLIENT_ID, exp: expSec, sub: "u" })}.`;
  }
  function makeTokenStore() {
    const far = Math.floor(Date.now() / 1000) + 3600;
    const data = { idToken: fakeJwt(far), refreshToken: "r", clientId: CONSUMER_CLIENT_ID, ...CONFIRMED_DEVICE };
    return { load: () => data, save: () => {} };
  }

  it("baseUrl + path を結合し Authorization: Bearer <idToken> と JSON body を fetch に渡す", async () => {
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return { status: 200, text: async () => '{"data":"tok"}' };
    };
    const transport = makeRegisterTransport({
      baseUrl: "https://example.invalid/api/",   // 末尾スラッシュは除去されること
      tokenStore: makeTokenStore(),
      fetchImpl,
    });
    const res = await transport({ method: "POST", path: "/device/v1/sesame2/sign", body: { a: 1 } });

    // 末尾スラッシュ除去の確認: base "https://example.invalid/api" + path
    expect(captured.url).toBe("https://example.invalid/api/device/v1/sesame2/sign");
    expect(captured.init.method).toBe("POST");
    expect(captured.init.headers.authorization).toMatch(/^Bearer /);
    expect(captured.init.headers["content-type"]).toBe("application/json");
    expect(captured.init.body).toBe(JSON.stringify({ a: 1 }));
    expect(res).toEqual({ status: 200, text: '{"data":"tok"}', json: { data: "tok" } });
  });

  it("不正 JSON 応答は json:null として text を保持する", async () => {
    const fetchImpl = async () => ({ status: 502, text: async () => "<html>bad gateway" });
    const transport = makeRegisterTransport({
      baseUrl: "https://example.invalid",
      tokenStore: makeTokenStore(),
      fetchImpl,
    });
    const res = await transport({ method: "POST", path: "/x" });
    expect(res.status).toBe(502);
    expect(res.json).toBeNull();
    expect(res.text).toBe("<html>bad gateway");
  });

  it("path 未指定 (undefined) なら fetch せず明示エラー (base + undefined URL を作らない)", async () => {
    let called = false;
    const fetchImpl = async () => { called = true; return { status: 200, text: async () => "" }; };
    const transport = makeRegisterTransport({
      baseUrl: "https://example.invalid",
      tokenStore: makeTokenStore(),
      fetchImpl,
    });
    await expect(transport({ method: "POST" })).rejects.toThrow(/path required/);
    await expect(transport({ method: "POST", path: "" })).rejects.toThrow(/path required/);
    expect(called).toBe(false);
  });

  it("入力バリデーション (baseUrl / tokenStore / fetchImpl)", () => {
    expect(() => makeRegisterTransport({ tokenStore: {}, fetchImpl: () => {} })).toThrow(/baseUrl required/);
    expect(() => makeRegisterTransport({ baseUrl: "x", fetchImpl: () => {} })).toThrow(/tokenStore required/);
    expect(() => makeRegisterTransport({ baseUrl: "x", tokenStore: {}, fetchImpl: null })).toThrow(/fetchImpl must be a function/);
  });

  it("resolveRegisterTransport は config.registerBaseUrl と既存 TokenStore から transport を作る", async () => {
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return { status: 200, text: async () => "{}" };
    };
    const transport = resolveRegisterTransport({
      config: { registerBaseUrl: "https://register.example.invalid/root/" },
      tokenStore: makeTokenStore(),
      fetchImpl,
    });
    expect(typeof transport).toBe("function");

    await transport({ method: "POST", path: "/device/v1/sesame2/sign", body: { k: "v" } });
    expect(captured.url).toBe("https://register.example.invalid/root/device/v1/sesame2/sign");
    expect(captured.init.headers.authorization).toMatch(/^Bearer /);
    expect(captured.init.body).toBe(JSON.stringify({ k: "v" }));
  });

  it("resolveRegisterTransport は baseUrl 未設定なら任意時 undefined / 必須時エラー", () => {
    expect(resolveRegisterTransport({ config: {}, tokenStore: makeTokenStore() })).toBeUndefined();
    expect(() => resolveRegisterTransport({ config: {}, tokenStore: makeTokenStore(), required: true })).toThrow(/baseUrl required/);
  });
});
