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
// ★検証範囲: fake transport / fetch モックで **リクエスト整形とヘッダ構成** を検証する
//   (フィールド名 / deviceId 大文字化 / token hex / パス / productType 文字列化 /
//    SigV4 + x-api-key + appidentifyid)。実機 API Gateway での受理は未検証
//   (REFACTORING_PLAN §9 V4/V5。src/devices.js のブロック注記参照)。

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

describe("makeRegisterTransport (SigV4 + x-api-key + appidentifyid)", () => {
  // 認可方式の出典 (REFACTORING_PLAN P2-1):
  //   ApiClientConfigBuilder.kt:34-46 (credentialsProvider + apiKey + region),
  //   BaseApp.kt:95-102 (apiKey = API_GATEWAY_API_KEY), AppIdentifyIdUtil.kt:42,
  //   app.properties:2-5,8-9 (ホスト / API key / IdentityPool / UserPool の実値)。

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
  /** Identity Pool を経由しない注入 provider (ヘッダ検証用の固定 credentials)。 */
  const fakeCredentialsProvider = {
    getCredentials: async () => ({
      accessKeyId: "ASIAEXAMPLE",
      secretAccessKey: "fakeSecret",
      sessionToken: "SESSION-TOKEN",
      expiration: new Date(Date.now() + 3600_000),
      identityId: "ap-northeast-1:identity",
    }),
  };

  it("既定ホスト app.candyhouse.co/prod (app.properties:3) へ SigV4 + x-api-key + appidentifyid を付けて送る", async () => {
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return { status: 200, text: async () => '{"data":"tok"}' };
    };
    const transport = makeRegisterTransport({
      credentialsProvider: fakeCredentialsProvider,
      appIdentifyId: "ap-northeast-1:fixed-id",
      fetchImpl,
    });
    const res = await transport({ method: "POST", path: "/device/v1/sesame2/sign", body: { a: 1 } });

    // baseUrl 未指定でも既定ホストが使われる (旧「baseUrl 必須 throw」は撤廃)
    expect(captured.url).toBe("https://app.candyhouse.co/prod/device/v1/sesame2/sign");
    expect(captured.init.method).toBe("POST");
    const h = captured.init.headers;
    // idToken Bearer は撤去済み (参照 SDK に存在しない認可方式)
    expect(h.authorization).not.toMatch(/^Bearer /);
    // SigV4: credential scope = <date>/ap-northeast-1/execute-api/aws4_request
    expect(h.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=ASIAEXAMPLE\/\d{8}\/ap-northeast-1\/execute-api\/aws4_request, SignedHeaders=appidentifyid;content-type;host;x-amz-date;x-amz-security-token;x-api-key, Signature=[0-9a-f]{64}$/,
    );
    expect(h["x-api-key"]).toBe("iGgXj9GorS4PeH90mAysg1l7kdvoIPxM25mPFl3k"); // app.properties:5
    expect(h.appidentifyid).toBe("ap-northeast-1:fixed-id");
    expect(h["x-amz-security-token"]).toBe("SESSION-TOKEN");
    expect(h["content-type"]).toBe("application/json");
    expect(captured.init.body).toBe(JSON.stringify({ a: 1 }));
    expect(res).toEqual({ status: 200, text: '{"data":"tok"}', json: { data: "tok" } });
  });

  it("tokenStore 経路: idToken を Identity Pool (GetId/GetCredentialsForIdentity) に連携して署名する", async () => {
    const calls = [];
    const expSec = Date.now() / 1000 + 3600;
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (url.startsWith("https://cognito-identity.ap-northeast-1.amazonaws.com/")) {
        const target = init.headers["x-amz-target"];
        if (target === "AWSCognitoIdentityService.GetId") {
          return { status: 200, text: async () => JSON.stringify({ IdentityId: "ap-northeast-1:id-1" }) };
        }
        return {
          status: 200,
          text: async () => JSON.stringify({
            IdentityId: "ap-northeast-1:id-1",
            Credentials: { AccessKeyId: "AKFROMPOOL", SecretKey: "SK", SessionToken: "ST", Expiration: expSec },
          }),
        };
      }
      return { status: 200, text: async () => "{}" };
    };
    const tokenStore = makeTokenStore();
    const transport = makeRegisterTransport({ tokenStore, appIdentifyId: "ap-northeast-1:x", fetchImpl });
    await transport({ method: "POST", path: "/device/v1/sesame2/sign", body: { k: "v" } });

    // GetId → GetCredentialsForIdentity → API 本体 の 3 リクエスト
    expect(calls).toHaveLength(3);
    const getIdBody = JSON.parse(calls[0].init.body);
    // logins = "cognito-idp.ap-northeast-1.amazonaws.com/<userPoolId>" → 保存済み idToken
    expect(getIdBody.Logins["cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_bY2byhlCa"])
      .toBe(tokenStore.load().idToken);
    expect(getIdBody.IdentityPoolId).toBe("ap-northeast-1:0a1820f1-dbb3-4bca-9227-2a92f6abf0ae"); // app.properties:8
    // API 本体は Identity Pool から得た AccessKeyId で署名されている
    const apiCall = calls[2];
    expect(apiCall.url).toBe("https://app.candyhouse.co/prod/device/v1/sesame2/sign");
    expect(apiCall.init.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKFROMPOOL\//);
    expect(apiCall.init.headers["x-amz-security-token"]).toBe("ST");
  });

  it("appIdentifyId 未注入なら config から解決し、無ければ生成して config に書き戻す", async () => {
    let captured;
    const fetchImpl = async (url, init) => { captured = { url, init }; return { status: 200, text: async () => "{}" }; };
    const config = { appIdentifyId: null };
    const transport = makeRegisterTransport({ credentialsProvider: fakeCredentialsProvider, config, fetchImpl });
    await transport({ method: "POST", path: "/x" });
    // ANDROID_ID 相当: "ap-northeast-1:<uuid>" を初回生成して config に保持 (AppIdentifyIdUtil.kt:42)
    expect(config.appIdentifyId).toMatch(/^ap-northeast-1:/);
    expect(captured.init.headers.appidentifyid).toBe(config.appIdentifyId);
  });

  it("不正 JSON 応答は json:null として text を保持する", async () => {
    const fetchImpl = async () => ({ status: 502, text: async () => "<html>bad gateway" });
    const transport = makeRegisterTransport({ credentialsProvider: fakeCredentialsProvider, fetchImpl });
    const res = await transport({ method: "POST", path: "/x" });
    expect(res.status).toBe(502);
    expect(res.json).toBeNull();
    expect(res.text).toBe("<html>bad gateway");
  });

  it("path 未指定 (undefined) なら fetch せず明示エラー (base + undefined URL を作らない)", async () => {
    let called = false;
    const fetchImpl = async () => { called = true; return { status: 200, text: async () => "" }; };
    const transport = makeRegisterTransport({ credentialsProvider: fakeCredentialsProvider, fetchImpl });
    await expect(transport({ method: "POST" })).rejects.toThrow(/path required/);
    await expect(transport({ method: "POST", path: "" })).rejects.toThrow(/path required/);
    expect(called).toBe(false);
  });

  it("入力バリデーション (認可材料 / fetchImpl)", () => {
    // tokenStore も credentialsProvider も無ければ署名できない
    expect(() => makeRegisterTransport({ fetchImpl: () => {} })).toThrow(/credentialsProvider/);
    expect(() => makeRegisterTransport({ tokenStore: {}, fetchImpl: null })).toThrow(/fetchImpl must be a function/);
  });

  it("resolveRegisterTransport は config.registerBaseUrl で既定ホストを上書きできる", async () => {
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return { status: 200, text: async () => "{}" };
    };
    const transport = resolveRegisterTransport({
      config: { registerBaseUrl: "https://register.example.invalid/root/" }, // 末尾スラッシュは除去される
      credentialsProvider: fakeCredentialsProvider,
      fetchImpl,
    });
    expect(typeof transport).toBe("function");

    await transport({ method: "POST", path: "/device/v1/sesame2/sign", body: { k: "v" } });
    expect(captured.url).toBe("https://register.example.invalid/root/device/v1/sesame2/sign");
    expect(captured.init.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(captured.init.body).toBe(JSON.stringify({ k: "v" }));
  });

  it("resolveRegisterTransport は baseUrl 未設定でも既定ホストで常に transport を返す", async () => {
    let captured;
    const fetchImpl = async (url, init) => { captured = { url, init }; return { status: 200, text: async () => "{}" }; };
    const transport = resolveRegisterTransport({
      config: {},
      credentialsProvider: fakeCredentialsProvider,
      fetchImpl,
    });
    expect(typeof transport).toBe("function");
    await transport({ method: "POST", path: "/x" });
    expect(captured.url).toBe("https://app.candyhouse.co/prod/x");
  });
});
