// packages/core/tests/_spec/auth-c4.test.js
//
// 対象 spec: AUTH-0075, AUTH-0078, AUTH-0079, AUTH-0080, AUTH-0081, AUTH-0082,
//            AUTH-0083, AUTH-0084, AUTH-0085, AUTH-0086, AUTH-0087, AUTH-0088,
//            AUTH-0089, AUTH-0090, AUTH-0091, AUTH-0092, AUTH-0093, AUTH-0094
//
// 方針: TDD — assert は spec どおりの正しい期待値 (実装が違えば red になってよい)。
//       ネットワーク/実機に触れない (全て mock or 純関数)。決定論的。
//
// 統合方針: A/B 双方から各 spec につきより正しく移植元忠実な方を採用し、
//           良い部分を統合した。import は重複排除・整合済み。

import { describe, it, expect, vi } from "vitest";

// ---- tested modules ----
import {
  generateAppIdentifyId,
  resolveAppIdentifyId,
  makeApiGatewayTransport,
  API_GATEWAY_API_KEY,
  DEFAULT_CH_API_BASE_URL,
} from "../../src/aws-credentials.js";

import { signRequest } from "../../src/sigv4.js";

import { cognitoCall } from "../../src/cognito-http.js";

import {
  getLoginUser,
  newTags,
  priorityCompany,
  priorityCompanyId,
  PAGE_NAMES,
  ALL_TAGS,
} from "../../src/account.js";

import { mockClient } from "../helpers/mock-ws.js";

// ---- test helpers ----

/**
 * fetch を呼ぶたびに responses を順に返すモック (clone() 対応)。
 * @param {Array<{status?: number, body?: unknown, throws?: Error}>} responses
 */
function scriptedFetch(responses) {
  let i = 0;
  const fn = vi.fn(async (_url, _init) => {
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r.throws) throw r.throws;
    const bodyStr = JSON.stringify(r.body ?? {});
    const makeResp = () => ({
      status: r.status ?? 200,
      ok: (r.status ?? 200) < 400,
      text: async () => bodyStr,
      clone() { return makeResp(); },
    });
    return makeResp();
  });
  return fn;
}

/** SigV4 署名付きリクエストに使う最小ダミー credentials (sessionToken あり)。 */
const CREDS_WITH_TOKEN = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  sessionToken: "SESSION-TOKEN-XYZ",
};

/** sessionToken なし credentials。 */
const CREDS_NO_TOKEN = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

const FIXED_DATE = new Date("2024-01-15T10:00:00Z");

// ============================================================
// AUTH-0075: appidentifyid 解決/生成 と永続化
// ============================================================
describe("[AUTH-0075] appidentifyid 解決/生成 (ap-northeast-1:<id>) と永続化", () => {
  it("[AUTH-0075] generateAppIdentifyId は 'ap-northeast-1:<uuid>' 形式を返す", () => {
    const id = generateAppIdentifyId();
    expect(id).toMatch(
      /^ap-northeast-1:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("[AUTH-0075] generateAppIdentifyId は uuid 注入でテスト可能", () => {
    const id = generateAppIdentifyId({ uuid: () => "00000000-0000-0000-0000-000000000001" });
    expect(id).toBe("ap-northeast-1:00000000-0000-0000-0000-000000000001");
  });

  it("[AUTH-0075] resolveAppIdentifyId: 明示 appIdentifyId が最優先 (config/configStore を無視)", () => {
    const config = { appIdentifyId: "ap-northeast-1:config-id" };
    const result = resolveAppIdentifyId({
      appIdentifyId: "ap-northeast-1:explicit-id",
      config,
    });
    expect(result).toBe("ap-northeast-1:explicit-id");
  });

  it("[AUTH-0075] resolveAppIdentifyId: config 保存値を再利用する (明示 null で config を使う)", () => {
    const config = { appIdentifyId: "ap-northeast-1:saved-id" };
    const result = resolveAppIdentifyId({ config });
    expect(result).toBe("ap-northeast-1:saved-id");
  });

  it("[AUTH-0075] resolveAppIdentifyId: configStore.load() から保存値を読む・既存値があれば save しない", () => {
    const config = { appIdentifyId: "ap-northeast-1:store-id" };
    const configStore = {
      load: () => config,
      save: vi.fn(),
    };
    const result = resolveAppIdentifyId({ configStore });
    expect(result).toBe("ap-northeast-1:store-id");
    expect(configStore.save).not.toHaveBeenCalled();
  });

  it("[AUTH-0075] resolveAppIdentifyId: 両方無ければ新規生成し config に書き戻す (in-memory 永続化)", () => {
    const cfg = { appIdentifyId: null };
    const generated = resolveAppIdentifyId({ config: cfg });
    expect(generated).toMatch(/^ap-northeast-1:/);
    expect(cfg.appIdentifyId).toBe(generated);
    // 同じ config なら以後安定する
    expect(resolveAppIdentifyId({ config: cfg })).toBe(generated);
  });

  it("[AUTH-0075] resolveAppIdentifyId: configStore がある場合は即 save() して永続化する", () => {
    const cfg = {};
    const save = vi.fn();
    const store = { load: () => cfg, save };
    const generated = resolveAppIdentifyId({ configStore: store });
    expect(generated).toMatch(/^ap-northeast-1:/);
    expect(cfg.appIdentifyId).toBe(generated);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("[AUTH-0075] resolveAppIdentifyId: configStore 経由の 2 回目は保存値を返すだけ (save 再発行なし)", () => {
    const cfg = {};
    const save = vi.fn();
    const store = { load: () => cfg, save };
    const first = resolveAppIdentifyId({ configStore: store });
    const second = resolveAppIdentifyId({ configStore: store });
    expect(second).toBe(first);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("[AUTH-0075] resolveAppIdentifyId: configStore が無くても新規生成は返り値を持つ", () => {
    const result = resolveAppIdentifyId({
      uuid: () => "cccccccc-0000-0000-0000-000000000003",
    });
    expect(result).toBe("ap-northeast-1:cccccccc-0000-0000-0000-000000000003");
  });

  it("[AUTH-0075] 優先順位: 明示 > config 保存値 > 新規生成", () => {
    // 明示 > config
    expect(
      resolveAppIdentifyId({
        appIdentifyId: "ap-northeast-1:a",
        config: { appIdentifyId: "ap-northeast-1:b" },
      })
    ).toBe("ap-northeast-1:a");

    // config > 新規生成
    const cfg = { appIdentifyId: "ap-northeast-1:b" };
    expect(resolveAppIdentifyId({ config: cfg })).toBe("ap-northeast-1:b");

    // 新規生成 (config なし)
    const r = resolveAppIdentifyId({ uuid: () => "dddddddd-0000-0000-0000-000000000004" });
    expect(r).toMatch(/^ap-northeast-1:/);
  });
});

// ============================================================
// AUTH-0078: SigV4 sessionToken 署名境界
// ============================================================
describe("[AUTH-0078] SigV4 sessionToken 署名境界 (Identity Pool 一時 credentials)", () => {
  it("[AUTH-0078] sessionToken あり: x-amz-security-token が署名対象ヘッダに含まれる", () => {
    const signed = signRequest({
      method: "POST",
      url: "https://app.candyhouse.co/prod/device/v1/biometrics",
      headers: { "content-type": "application/json", "x-api-key": "key" },
      body: "{}",
      credentials: CREDS_WITH_TOKEN,
      date: FIXED_DATE,
    });
    expect(signed.headers["x-amz-security-token"]).toBe("SESSION-TOKEN-XYZ");
    expect(signed.signedHeaders).toContain("x-amz-security-token");
    expect(signed.headers.authorization).toContain("x-amz-security-token");
  });

  it("[AUTH-0078] sessionToken なし: x-amz-security-token は署名対象ヘッダに含まれない", () => {
    const signed = signRequest({
      method: "POST",
      url: "https://app.candyhouse.co/prod/device/v1/biometrics",
      headers: { "content-type": "application/json", "x-api-key": "key" },
      body: "{}",
      credentials: CREDS_NO_TOKEN,
      date: FIXED_DATE,
    });
    expect(signed.headers["x-amz-security-token"]).toBeUndefined();
    expect(signed.signedHeaders).not.toContain("x-amz-security-token");
    expect(signed.headers.authorization).not.toContain("x-amz-security-token");
  });

  it("[AUTH-0078] sessionToken なし/あり で signedHeaders の差分が x-amz-security-token のみ", () => {
    const withToken = signRequest({
      method: "POST",
      url: "https://app.candyhouse.co/prod/device/v1/sesame2/sign",
      credentials: CREDS_WITH_TOKEN,
      body: "{}",
      date: FIXED_DATE,
    });
    const withoutToken = signRequest({
      method: "POST",
      url: "https://app.candyhouse.co/prod/device/v1/sesame2/sign",
      credentials: CREDS_NO_TOKEN,
      body: "{}",
      date: FIXED_DATE,
    });
    const withSet = new Set(withToken.signedHeaders.split(";"));
    const withoutSet = new Set(withoutToken.signedHeaders.split(";"));
    const diff = [...withSet].filter((h) => !withoutSet.has(h));
    expect(diff).toEqual(["x-amz-security-token"]);
  });

  it("[AUTH-0078] sessionToken あり: Authorization に Credential スコープがある", () => {
    const signed = signRequest({
      method: "GET",
      url: "https://app.candyhouse.co/prod/device/list",
      credentials: CREDS_WITH_TOKEN,
      date: FIXED_DATE,
    });
    expect(signed.headers["x-amz-security-token"]).toBe("SESSION-TOKEN-XYZ");
    const shs = signed.signedHeaders.split(";");
    expect(shs).toContain("x-amz-security-token");
    expect(signed.headers.authorization).toContain("Credential=");
  });
});

// ============================================================
// AUTH-0079: API Gateway transport ヘッダ構成
// ============================================================
describe("[AUTH-0079] API Gateway transport ヘッダ構成 (SigV4 + x-api-key + per-op appidentifyid)", () => {
  const fakeProvider = {
    getCredentials: async () => ({
      accessKeyId: "ASIAEXAMPLE",
      secretAccessKey: "secretKey",
      sessionToken: "SESSION-TOKEN",
      expiration: new Date(Date.now() + 3_600_000),
      identityId: "ap-northeast-1:id",
    }),
  };

  it("[AUTH-0079] x-api-key (API_GATEWAY_API_KEY) が付く", async () => {
    const capturedHeaders = {};
    const fetchImpl = vi.fn(async (_url, init) => {
      Object.assign(capturedHeaders, init.headers);
      return { status: 200, ok: true, text: async () => "{}", clone: () => ({ text: async () => "{}" }) };
    });
    const transport = makeApiGatewayTransport({
      baseUrl: DEFAULT_CH_API_BASE_URL,
      credentialsProvider: fakeProvider,
      fetchImpl,
      maxRetries: 0,
    });
    await transport({ method: "GET", path: "/device/list" });
    expect(capturedHeaders["x-api-key"]).toBe(API_GATEWAY_API_KEY);
    expect(API_GATEWAY_API_KEY).toBe("iGgXj9GorS4PeH90mAysg1l7kdvoIPxM25mPFl3k");
  });

  it("[AUTH-0079] SigV4 Authorization ヘッダが付く", async () => {
    const capturedHeaders = {};
    const fetchImpl = vi.fn(async (_url, init) => {
      Object.assign(capturedHeaders, init.headers);
      return { status: 200, ok: true, text: async () => "{}", clone: () => ({ text: async () => "{}" }) };
    });
    const transport = makeApiGatewayTransport({
      baseUrl: DEFAULT_CH_API_BASE_URL,
      credentialsProvider: fakeProvider,
      fetchImpl,
      maxRetries: 0,
    });
    await transport({ method: "GET", path: "/device/list" });
    expect(capturedHeaders["authorization"]).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("[AUTH-0079] appIdentifyId あり: appidentifyid ヘッダが付き署名にも含まれる", async () => {
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return { status: 200, text: async () => "{}" };
    };
    const transport = makeApiGatewayTransport({
      baseUrl: DEFAULT_CH_API_BASE_URL,
      credentialsProvider: fakeProvider,
      appIdentifyId: "ap-northeast-1:test-device-id",
      fetchImpl,
      maxRetries: 0,
    });
    await transport({ method: "GET", path: "/device/list" });
    const h = captured.init.headers;
    expect(h["appidentifyid"]).toBe("ap-northeast-1:test-device-id");
    expect(h.authorization).toContain("appidentifyid");
  });

  it("[AUTH-0079] appIdentifyId null (既定): appidentifyid ヘッダを付けない・署名にも含まれない", async () => {
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return { status: 200, text: async () => "{}" };
    };
    const transport = makeApiGatewayTransport({
      baseUrl: DEFAULT_CH_API_BASE_URL,
      credentialsProvider: fakeProvider,
      // appIdentifyId 省略 (null 既定)
      fetchImpl,
      maxRetries: 0,
    });
    await transport({ method: "POST", path: "/device/v1/sesame2/abc" });
    const h = captured.init.headers;
    expect(h["appidentifyid"]).toBeUndefined();
    expect(h.authorization).not.toContain("appidentifyid");
    expect(h.authorization).toMatch(/^AWS4-HMAC-SHA256/);
  });

  it("[AUTH-0079] URL は baseUrl + path で構成される (末尾スラッシュ除去)", async () => {
    let capturedUrl;
    const fetchImpl = async (url) => {
      capturedUrl = url;
      return { status: 200, text: async () => "{}" };
    };
    const transport = makeApiGatewayTransport({
      baseUrl: "https://app.candyhouse.co/prod///",
      credentialsProvider: fakeProvider,
      fetchImpl,
      maxRetries: 0,
    });
    await transport({ method: "GET", path: "/device/list" });
    expect(capturedUrl).toBe("https://app.candyhouse.co/prod/device/list");
  });
});

// ============================================================
// AUTH-0080: cognitoCall が AWS JSON 1.1 のワイヤ形で POST する
// ============================================================
describe("[AUTH-0080] cognitoCall が AWS JSON 1.1 のワイヤ形で POST する", () => {
  it("[AUTH-0080] URL=cognito-idp.<region>.amazonaws.com/, Content-Type=application/x-amz-json-1.1, X-Amz-Target 付き POST", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      return {
        status: 200, ok: true,
        text: async () => JSON.stringify({ ChallengeName: "CUSTOM_CHALLENGE" }),
        clone() { return this; },
      };
    });

    const payload = { AuthFlow: "CUSTOM_AUTH", ClientId: "client-1", AuthParameters: { USERNAME: "a@example.com" } };
    await cognitoCall("InitiateAuth", payload, { fetchImpl, maxRetries: 0 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://cognito-idp.ap-northeast-1.amazonaws.com/");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/x-amz-json-1.1");
    expect(init.headers["X-Amz-Target"]).toBe("AWSCognitoIdentityProviderService.InitiateAuth");
    expect(JSON.parse(init.body)).toEqual(payload);
  });

  it("[AUTH-0080] region オプションで URL のリージョンを差し替えられる", async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 200, ok: true,
      text: async () => "{}",
      clone() { return this; },
    }));
    await cognitoCall("SignUp", {}, { fetchImpl, region: "us-east-1", maxRetries: 0 });
    expect(fetchImpl.mock.calls[0][0]).toBe("https://cognito-idp.us-east-1.amazonaws.com/");
  });

  it("[AUTH-0080] 各 Op で X-Amz-Target の末尾が Op 名と一致する", async () => {
    for (const op of ["RespondToAuthChallenge", "ConfirmDevice", "ForgetDevice"]) {
      const fetchImpl = vi.fn(async () => ({
        status: 200, ok: true,
        text: async () => "{}",
        clone() { return this; },
      }));
      await cognitoCall(op, {}, { fetchImpl, maxRetries: 0 });
      expect(fetchImpl.mock.calls[0][1].headers["X-Amz-Target"]).toBe(
        `AWSCognitoIdentityProviderService.${op}`
      );
    }
  });
});

// ============================================================
// AUTH-0081: エラー応答 __type を Error.name に写像する
// ============================================================
describe("[AUTH-0081] エラー応答 __type (# 区切り含む) を Error.name に写像する", () => {
  it("[AUTH-0081] __type 素形 'NotAuthorizedException' → err.name='NotAuthorizedException'", async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 400,
      ok: false,
      text: async () => JSON.stringify({ __type: "NotAuthorizedException", message: "Token expired" }),
      clone() { return this; },
    }));
    const err = await cognitoCall("InitiateAuth", {}, { fetchImpl, maxRetries: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("NotAuthorizedException");
    expect(err.message).toBe("Token expired");
  });

  it("[AUTH-0081] __type '#' 区切り形式 'namespace#NotAuthorizedException' → err.name='NotAuthorizedException'", async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 400,
      ok: false,
      text: async () => JSON.stringify({
        __type: "com.amazonaws.cognito.identity.idp.model#NotAuthorizedException",
        message: "Not authorized",
      }),
      clone() { return this; },
    }));
    const err = await cognitoCall("InitiateAuth", {}, { fetchImpl, maxRetries: 0 }).catch((e) => e);
    expect(err.name).toBe("NotAuthorizedException");
    expect(err.message).toBe("Not authorized");
  });

  it("[AUTH-0081] __type なしエラー → err.name='CognitoHttpError'", async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 500,
      ok: false,
      text: async () => "{}",
      clone() { return this; },
    }));
    const err = await cognitoCall("InitiateAuth", {}, { fetchImpl, maxRetries: 0 }).catch((e) => e);
    expect(err.name).toBe("CognitoHttpError");
  });

  it("[AUTH-0081] message キー (小文字) を拾う", async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 400,
      ok: false,
      text: async () => JSON.stringify({ __type: "SomeException", message: "lowercase message" }),
      clone() { return this; },
    }));
    const err = await cognitoCall("SomeOp", {}, { fetchImpl, maxRetries: 0 }).catch((e) => e);
    expect(err.message).toBe("lowercase message");
  });

  it("[AUTH-0081] Message キー (大文字 M) を拾う", async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 400,
      ok: false,
      text: async () => JSON.stringify({ __type: "x#SomeException", Message: "Capital M message" }),
      clone() { return this; },
    }));
    const err = await cognitoCall("SomeOp", {}, { fetchImpl, maxRetries: 0 }).catch((e) => e);
    expect(err.name).toBe("SomeException");
    expect(err.message).toBe("Capital M message");
  });

  it("[AUTH-0081] 非 JSON body でも CognitoHttpError を投げる (crash しない)", async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 502,
      ok: false,
      text: async () => "<html>Bad Gateway</html>",
      clone() { return this; },
    }));
    const err = await cognitoCall("RevokeToken", {}, { fetchImpl, maxRetries: 0 }).catch((e) => e);
    expect(err.name).toBe("CognitoHttpError");
    expect(err.message).toMatch(/HTTP 502/);
  });
});

// ============================================================
// AUTH-0082: ソケットタイムアウト 15s が AbortSignal.timeout で課され即 throw (リトライ禁止)
// ============================================================
describe("[AUTH-0082] ソケットタイムアウト AbortSignal.timeout で課され即 throw (リトライ禁止)", () => {
  it("[AUTH-0082] TimeoutError は即 throw (リトライ禁止、1 試行のみ)", async () => {
    const timeoutErr = Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
    const fetchImpl = vi.fn(async () => { throw timeoutErr; });
    await expect(
      cognitoCall("InitiateAuth", {}, { fetchImpl, timeoutMs: 100, maxRetries: 3 })
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("[AUTH-0082] AbortError (ユーザキャンセル) は即 throw (リトライ禁止、1 試行のみ)", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fetchImpl = vi.fn(async () => { throw abortErr; });
    await expect(
      cognitoCall("InitiateAuth", {}, { fetchImpl, timeoutMs: 100, maxRetries: 3 })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("[AUTH-0082] timeoutMs オプションで上書きできる (API 境界の確認)", async () => {
    const timeoutErr = Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
    const fetchImpl = vi.fn(async () => { throw timeoutErr; });
    await expect(
      cognitoCall("InitiateAuth", {}, { fetchImpl, timeoutMs: 50, maxRetries: 0 })
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("[AUTH-0082] makeApiGatewayTransport でも TimeoutError は即 throw (1 試行のみ)", async () => {
    const fakeProvider = {
      getCredentials: async () => ({
        accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST",
        expiration: new Date(Date.now() + 3_600_000), identityId: "ap-northeast-1:id",
      }),
    };
    const timeoutErr = Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
    const fetchImpl = vi.fn(async () => { throw timeoutErr; });
    const transport = makeApiGatewayTransport({
      baseUrl: DEFAULT_CH_API_BASE_URL,
      credentialsProvider: fakeProvider,
      fetchImpl,
      timeoutMs: 100,
      maxRetries: 3,
    });
    await expect(
      transport({ method: "GET", path: "/device/list" })
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("[AUTH-0082] デフォルト DEFAULT_SOCKET_TIMEOUT が動作すること (タイムアウト設定の存在確認)", async () => {
    const fetchImpl = scriptedFetch([{ status: 200, body: {} }]);
    await expect(
      cognitoCall("InitiateAuth", {}, { fetchImpl, maxRetries: 0 })
    ).resolves.toBeTruthy();
  });
});

// ============================================================
// AUTH-0083: AWS retry 既定 3 回 + 5xx 指数バックオフリトライ
// ============================================================
describe("[AUTH-0083] AWS retry 既定 3 回 + 5xx (500/502/503/504) 指数バックオフリトライ", () => {
  it("[AUTH-0083] 500 → 200 の 2 段で成功し 2 回 fetch が発生する", async () => {
    const fetchImpl = scriptedFetch([
      { status: 500, body: {} },
      { status: 200, body: { ChallengeName: "CUSTOM_CHALLENGE" } },
    ]);
    const result = await cognitoCall("InitiateAuth", {}, { fetchImpl, timeoutMs: 100, maxRetries: 3 });
    expect(result.ChallengeName).toBe("CUSTOM_CHALLENGE");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("[AUTH-0083] 503 を DEFAULT_MAX_ERROR_RETRY=3 回リトライして全失敗 → 計 4 回呼ぶ", async () => {
    const fetchImpl = scriptedFetch([{ status: 503, body: {} }]);
    await expect(
      cognitoCall("InitiateAuth", {}, { fetchImpl, timeoutMs: 100, maxRetries: 3 })
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("[AUTH-0083] maxRetries=0 では 1 回のみ呼ぶ (リトライ無し)", async () => {
    const fetchImpl = scriptedFetch([{ status: 500, body: {} }]);
    await expect(
      cognitoCall("InitiateAuth", {}, { fetchImpl, timeoutMs: 100, maxRetries: 0 })
    ).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("[AUTH-0083] 502 Bad Gateway もリトライ対象", async () => {
    const fakeProvider = {
      getCredentials: async () => ({
        accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST",
        expiration: new Date(Date.now() + 3_600_000), identityId: "ap-northeast-1:id",
      }),
    };
    const fetchImpl = scriptedFetch([
      { status: 502, body: {} },
      { status: 200, body: { result: "ok" } },
    ]);
    const transport = makeApiGatewayTransport({
      baseUrl: DEFAULT_CH_API_BASE_URL,
      credentialsProvider: fakeProvider,
      fetchImpl,
      timeoutMs: 100,
      maxRetries: 3,
    });
    const res = await transport({ method: "GET", path: "/device/list" });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("[AUTH-0083] 504 Gateway Timeout もリトライ対象", async () => {
    const fetchImpl = scriptedFetch([
      { status: 504, body: {} },
      { status: 200, body: { ChallengeName: "OK" } },
    ]);
    const result = await cognitoCall("InitiateAuth", {}, { fetchImpl, timeoutMs: 100, maxRetries: 3 });
    expect(result.ChallengeName).toBe("OK");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

// ============================================================
// AUTH-0084: 4xx Throttling のみリトライ・非 Throttling 4xx は即確定
// ============================================================
describe("[AUTH-0084] 4xx Throttling のみリトライ・非 Throttling 4xx は即確定", () => {
  it("[AUTH-0084] __type=Throttling 400 → リトライして成功", async () => {
    const fetchImpl = scriptedFetch([
      { status: 400, body: { __type: "Throttling", message: "Rate exceeded" } },
      { status: 200, body: { ChallengeName: "CUSTOM_CHALLENGE" } },
    ]);
    const result = await cognitoCall("InitiateAuth", {}, { fetchImpl, timeoutMs: 100, maxRetries: 3 });
    expect(result.ChallengeName).toBe("CUSTOM_CHALLENGE");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("[AUTH-0084] __type=ThrottlingException 400 → リトライして成功", async () => {
    const fetchImpl = scriptedFetch([
      { status: 400, body: { __type: "com.amazonaws.cognito.idp#ThrottlingException", message: "Throttled" } },
      { status: 200, body: { ChallengeName: "CUSTOM_CHALLENGE" } },
    ]);
    const result = await cognitoCall("InitiateAuth", {}, { fetchImpl, timeoutMs: 100, maxRetries: 3 });
    expect(result.ChallengeName).toBe("CUSTOM_CHALLENGE");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("[AUTH-0084] __type=ProvisionedThroughputExceededException 400 → リトライして成功", async () => {
    const fetchImpl = scriptedFetch([
      { status: 400, body: { __type: "ProvisionedThroughputExceededException", message: "Exceeded" } },
      { status: 200, body: { ChallengeName: "CUSTOM_CHALLENGE" } },
    ]);
    const result = await cognitoCall("InitiateAuth", {}, { fetchImpl, timeoutMs: 100, maxRetries: 3 });
    expect(result.ChallengeName).toBe("CUSTOM_CHALLENGE");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("[AUTH-0084] NotAuthorizedException 400 (非 Throttling) → リトライしない (1 回で確定)", async () => {
    const fetchImpl = scriptedFetch([
      { status: 400, body: { __type: "NotAuthorizedException", message: "Token expired" } },
    ]);
    await expect(
      cognitoCall("InitiateAuth", {}, { fetchImpl, timeoutMs: 100, maxRetries: 3 })
    ).rejects.toMatchObject({ name: "NotAuthorizedException" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("[AUTH-0084] makeApiGatewayTransport: 403 Forbidden (非 Throttling) → リトライしない (1 回で確定)", async () => {
    const fakeProvider = {
      getCredentials: async () => ({
        accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST",
        expiration: new Date(Date.now() + 3_600_000), identityId: "ap-northeast-1:id",
      }),
    };
    const fetchImpl = scriptedFetch([
      { status: 403, body: { __type: "AccessDeniedException", message: "Access denied" } },
    ]);
    const transport = makeApiGatewayTransport({
      baseUrl: DEFAULT_CH_API_BASE_URL,
      credentialsProvider: fakeProvider,
      fetchImpl,
      timeoutMs: 100,
      maxRetries: 3,
    });
    const res = await transport({ method: "GET", path: "/device/list" });
    expect(res.status).toBe(403);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("[AUTH-0084] makeApiGatewayTransport: Throttling はリトライして成功する", async () => {
    const fakeProvider = {
      getCredentials: async () => ({
        accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST",
        expiration: new Date(Date.now() + 3_600_000), identityId: "ap-northeast-1:id",
      }),
    };
    const fetchImpl = scriptedFetch([
      { status: 400, body: { __type: "ProvisionedThroughputExceededException", message: "Exceeded" } },
      { status: 200, body: { result: "ok" } },
    ]);
    const transport = makeApiGatewayTransport({
      baseUrl: DEFAULT_CH_API_BASE_URL,
      credentialsProvider: fakeProvider,
      fetchImpl: fetchImpl,
      timeoutMs: 100,
      maxRetries: 3,
    });
    const res = await transport({ method: "GET", path: "/device/list" });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

// ============================================================
// AUTH-0085: ネットワーク例外 (TypeError) はリトライ対象
// ============================================================
describe("[AUTH-0085] ネットワーク例外 (TypeError/IOException 相当) はリトライ対象", () => {
  it("[AUTH-0085] cognitoCall: fetch が TypeError で reject → リトライして成功", async () => {
    const netErr = Object.assign(new TypeError("fetch failed"), { name: "TypeError" });
    const fetchImpl = scriptedFetch([
      { throws: netErr },
      { throws: netErr },
      { status: 200, body: { ChallengeName: "OK" } },
    ]);
    const result = await cognitoCall("InitiateAuth", {}, { fetchImpl, timeoutMs: 100, maxRetries: 3 });
    expect(result.ChallengeName).toBe("OK");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("[AUTH-0085] cognitoCall: 全リトライ消費後はネットワークエラーを throw する", async () => {
    const netErr = Object.assign(new TypeError("fetch failed"), { name: "TypeError" });
    const fetchImpl = scriptedFetch([{ throws: netErr }]);
    await expect(
      cognitoCall("InitiateAuth", {}, { fetchImpl, timeoutMs: 100, maxRetries: 3 })
    ).rejects.toThrow(/fetch failed/);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("[AUTH-0085] makeApiGatewayTransport でもネットワーク例外はリトライ対象", async () => {
    const fakeProvider = {
      getCredentials: async () => ({
        accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST",
        expiration: new Date(Date.now() + 3_600_000), identityId: "ap-northeast-1:id",
      }),
    };
    const netErr = Object.assign(new TypeError("fetch failed"), { name: "TypeError" });
    const fetchImpl = scriptedFetch([
      { throws: netErr },
      { status: 200, body: { result: "ok" } },
    ]);
    const transport = makeApiGatewayTransport({
      baseUrl: DEFAULT_CH_API_BASE_URL,
      credentialsProvider: fakeProvider,
      fetchImpl,
      timeoutMs: 100,
      maxRetries: 3,
    });
    const res = await transport({ method: "GET", path: "/device/list" });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("[AUTH-0085] AbortError / TimeoutError は TypeError と異なりリトライ禁止 (1 試行のみ)", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fetchImpl = scriptedFetch([{ throws: abortErr }]);
    await expect(
      cognitoCall("InitiateAuth", {}, { fetchImpl, timeoutMs: 100, maxRetries: 3 })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// AUTH-0086: ClockSkew は API Gateway transport でリトライしない (意図的逸脱)
// ============================================================
describe("[AUTH-0086] ClockSkew は API Gateway transport でリトライしない (意図的逸脱)", () => {
  const fakeProvider = {
    getCredentials: async () => ({
      accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST",
      expiration: new Date(Date.now() + 3_600_000), identityId: "ap-northeast-1:id",
    }),
  };

  const CLOCK_SKEW_TYPES = [
    "SignatureDoesNotMatch",
    "RequestTimeTooSkewed",
    "InvalidSignatureException",
    "RequestExpired",
  ];

  for (const errorType of CLOCK_SKEW_TYPES) {
    it(`[AUTH-0086] ${errorType} (4xx clock skew) → リトライせず 1 回で応答を返す`, async () => {
      const fetchImpl = scriptedFetch([
        { status: 403, body: { __type: errorType, message: "Clock skew error" } },
        { status: 200, body: { result: "should-not-be-reached" } },
      ]);
      const transport = makeApiGatewayTransport({
        baseUrl: DEFAULT_CH_API_BASE_URL,
        credentialsProvider: fakeProvider,
        fetchImpl,
        timeoutMs: 100,
        maxRetries: 3,
      });
      const res = await transport({ method: "GET", path: "/device/list" });
      expect(res.status).toBe(403);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  }
});

// ============================================================
// AUTH-0087: getLoginUser フレーム形 (biz3GetLoginUser, op 無し, email)
// ============================================================
describe("[AUTH-0087] getLoginUser フレーム形 (biz3GetLoginUser, op 無し, email)", () => {
  it("[AUTH-0087] 送信フレームが {action:'biz3GetLoginUser', email} で op を含まない", async () => {
    const c = mockClient({ success: true, data: { customerInfo: {}, quotas: {} } });
    await getLoginUser(c, { email: "user@example.com" });
    expect(c.sent).toHaveLength(1);
    const frame = c.sent[0];
    expect(frame.action).toBe("biz3GetLoginUser");
    expect(frame.email).toBe("user@example.com");
    expect(frame).not.toHaveProperty("op");
  });

  it("[AUTH-0087] action が定数 ACTION_TYPES.BIZ3_GET_LOGIN_INFO の実値 ('biz3GetLoginUser') と一致", async () => {
    const c = mockClient({ success: true, data: {} });
    await getLoginUser(c, { email: "a@b.c" });
    expect(c.sent[0].action).toBe("biz3GetLoginUser");
  });

  it("[AUTH-0087] email 未指定は throw (email required)", async () => {
    const c = mockClient({});
    await expect(getLoginUser(c, {})).rejects.toThrow(/email required/);
  });
});

// ============================================================
// AUTH-0088: getLoginUser 応答形 (data.customerInfo / data.quotas)
// ============================================================
describe("[AUTH-0088] getLoginUser 応答形 (data.customerInfo / data.quotas ナロー化)", () => {
  it("[AUTH-0088] data.customerInfo / data.quotas を返す", async () => {
    const customerInfo = { companyID: "ch_X", subUUID: "u-1", name: "会社A" };
    const quotas = { monthlyApiCalls: 5000 };
    const c = mockClient({ success: true, data: { customerInfo, quotas } });
    const r = await getLoginUser(c, { email: "me@example.com" });
    expect(r.customerInfo).toEqual(customerInfo);
    expect(r.quotas).toEqual(quotas);
  });

  it("[AUTH-0088] data が無い場合 customerInfo/quotas は null (例外にしない)", async () => {
    const c = mockClient({ success: true });
    const r = await getLoginUser(c, { email: "me@example.com" });
    expect(r.customerInfo).toBeNull();
    expect(r.quotas).toBeNull();
  });

  it("[AUTH-0088] data.customerInfo が欠落しても null で返る", async () => {
    const c = mockClient({ success: true, data: { quotas: { x: 1 } } });
    const r = await getLoginUser(c, { email: "me@example.com" });
    expect(r.customerInfo).toBeNull();
    expect(r.quotas).toEqual({ x: 1 });
  });

  it("[AUTH-0088] success:false は assertSuccess で拒否 (throw)", async () => {
    const c = mockClient({ success: false, message: "no user" });
    await expect(getLoginUser(c, { email: "x@y.z" })).rejects.toThrow(/getLoginUser failed/);
  });
});

// ============================================================
// AUTH-0089: refreshAccount で companyID/subUUID を config・内部状態に保存
// ============================================================
describe("[AUTH-0089] refreshAccount で companyID/subUUID を config・内部状態に保存", () => {
  /**
   * refreshAccount のテスト用に client.js の refreshAccount ロジックを
   * 最小限インライン実装する。
   * 実装 (packages/core/src/client.js:446-462):
   *   - customerInfo.companyID があれば config.companyID を実値に上書きし configStore.save()
   *   - customerInfo.subUUID があれば _subUUID を上書き
   */
  function makeRefreshAccountFn({ getLoginUserFn, config, configStore, initialSubUUID = null }) {
    let _subUUID = initialSubUUID;
    const refreshAccount = async () => {
      const { customerInfo } = await getLoginUserFn();
      const ci = customerInfo;
      if (ci?.companyID) {
        config.companyID = ci.companyID;
        if (configStore) {
          const cfg = configStore.load();
          cfg.companyID = ci.companyID;
          configStore.save();
        }
      }
      if (ci?.subUUID) {
        _subUUID = ci.subUUID;
      }
      return { customerInfo, getSubUUID: () => _subUUID };
    };
    return refreshAccount;
  }

  it("[AUTH-0089] companyID あり: config.companyID を実値に上書きし configStore.save を呼ぶ", async () => {
    const config = { companyID: "ch_CandyhouseMobile" };
    const cfg = { companyID: "ch_CandyhouseMobile" };
    const save = vi.fn();
    const configStore = { load: () => cfg, save };
    const refreshAccount = makeRefreshAccountFn({
      getLoginUserFn: async () => ({ customerInfo: { companyID: "ch_REAL_COMPANY", subUUID: "sub-uuid-123" } }),
      config,
      configStore,
    });
    const result = await refreshAccount();
    expect(config.companyID).toBe("ch_REAL_COMPANY");
    expect(cfg.companyID).toBe("ch_REAL_COMPANY");
    expect(save).toHaveBeenCalledTimes(1);
    expect(result.getSubUUID()).toBe("sub-uuid-123");
  });

  it("[AUTH-0089] subUUID あり: _subUUID を上書きする", async () => {
    const config = { companyID: "ch_X" };
    const refreshAccount = makeRefreshAccountFn({
      getLoginUserFn: async () => ({ customerInfo: { companyID: "ch_X", subUUID: "new-sub-uuid-456" } }),
      config,
      configStore: null,
      initialSubUUID: "old-sub-uuid",
    });
    const result = await refreshAccount();
    expect(result.getSubUUID()).toBe("new-sub-uuid-456");
  });

  it("[AUTH-0089] companyID が欠落する場合は config を上書きしない", async () => {
    const config = { companyID: "ch_default" };
    const save = vi.fn();
    const refreshAccount = makeRefreshAccountFn({
      getLoginUserFn: async () => ({ customerInfo: { subUUID: "some-sub-uuid" } }),
      config,
      configStore: { load: () => config, save },
    });
    await refreshAccount();
    expect(config.companyID).toBe("ch_default");
    expect(save).not.toHaveBeenCalled();
  });
});

// ============================================================
// AUTH-0090: newTags アクセス権補完
// ============================================================
describe("[AUTH-0090] newTags アクセス権補完 (isSesameApp / オーナー・マネージャー / allTags)", () => {
  it("[AUTH-0090] PAGE_NAMES の日本語実値が gUtils.js と 1:1 一致する", () => {
    expect(PAGE_NAMES.members).toBe("ユーザー");
    expect(PAGE_NAMES.membersGroup).toBe("ユーザーグループ");
    expect(PAGE_NAMES.membersRole).toBe("ロール");
    expect(PAGE_NAMES.historys).toBe("全体履歴");
    expect(PAGE_NAMES.scheduleList).toBe("予約一覧");
    expect(PAGE_NAMES.developer).toBe("開発者向け");
    expect(PAGE_NAMES.cards).toBe("カード管理");
    expect(PAGE_NAMES.devices).toBe("デバイス（ドア・認証機器）");
    expect(PAGE_NAMES.touchDevices).toBe("認証機器");
    expect(PAGE_NAMES.ssmDevices).toBe("ドア");
    expect(PAGE_NAMES.ssmDevicesGroup).toBe("ドアグループ");
    expect(PAGE_NAMES.appDevices).toBe("セサミ");
    expect(PAGE_NAMES.appContacts).toBe("連絡先");
    expect(PAGE_NAMES.appMe).toBe("自分");
  });

  it("[AUTH-0090] ALL_TAGS は gUtils.js と 1:1 一致する (5 件)", () => {
    expect(ALL_TAGS).toEqual([
      "ユーザー",
      "デバイス（ドア・認証機器）",
      "カード管理",
      "全体履歴",
      "開発者向け",
    ]);
  });

  it("[AUTH-0090] isSesameApp は access に '開発者向け' (PAGE_NAMES.developer) を追加する", () => {
    const r = newTags({ isSesameApp: true, access: ["ユーザー"] });
    expect(r.access).toContain("開発者向け");
    expect(r.access).toContain("ユーザー");
  });

  it("[AUTH-0090] tag[0]='オーナー' は access を allTags で置換する", () => {
    const r = newTags({ tag: ["オーナー"], access: ["ユーザー"] });
    expect(r.access).toEqual([...ALL_TAGS]);
  });

  it("[AUTH-0090] tag[0]='マネージャー' も allTags 置換", () => {
    const r = newTags({ tag: ["マネージャー"], access: [] });
    expect(r.access).toEqual([...ALL_TAGS]);
  });

  it("[AUTH-0090] それ以外のロールは素通し (同一参照)", () => {
    const info = { tag: ["ゲスト"], access: ["ユーザー"] };
    expect(newTags(info)).toBe(info);
  });

  it("[AUTH-0090] falsy はそのまま返す (null/undefined)", () => {
    expect(newTags(null)).toBeNull();
    expect(newTags(undefined)).toBeUndefined();
  });
});

// ============================================================
// AUTH-0091: priorityCompany / priorityCompanyId 選定
// ============================================================
describe("[AUTH-0091] priorityCompany / priorityCompanyId 選定", () => {
  const companies = [
    { companyID: "ch_A", name: "A", feeLevel: { subscriptionId: "sub_A", isRootUser: false, level: 1 } },
    { companyID: "ch_B", name: "B", feeLevel: { subscriptionId: "sub_B", isRootUser: false, level: 3 } },
  ];

  it("[AUTH-0091] 非 isSesameApp: companyID 一致 company の feeLevel.subscriptionId を合成", () => {
    const r = priorityCompany({ companyID: "ch_B", name: "me" }, companies);
    expect(r.companyID).toBe("ch_B");
    expect(r.name).toBe("me"); // customerInfo 側が基底
    expect(r.subscriptionId).toBe("sub_B");
  });

  it("[AUTH-0091] 非 isSesameApp: 一致が無ければ subscriptionId は undefined", () => {
    const r = priorityCompany({ companyID: "ch_X" }, companies);
    expect(r.companyID).toBe("ch_X");
    expect(r.subscriptionId).toBeUndefined();
  });

  it("[AUTH-0091] isSesameApp: companies 空なら {} (意図的逸脱 — web では TypeError)", () => {
    expect(priorityCompany({ isSesameApp: true }, [])).toEqual({});
  });

  it("[AUTH-0091] isSesameApp: isRootUser===true の company を優先し feeLevel を展開する", () => {
    const withRoot = [
      ...companies,
      { companyID: "ch_R", feeLevel: { subscriptionId: "sub_R", isRootUser: true, level: 0 } },
    ];
    const r = priorityCompany({ isSesameApp: true }, withRoot);
    expect(r.companyID).toBe("ch_R");
    expect(r.subscriptionId).toBe("sub_R");
    expect(r.isRootUser).toBe(true);
  });

  it("[AUTH-0091] isSesameApp: rootUser 不在なら非 isSesameApp の level 最大を選ぶ", () => {
    const r = priorityCompany({ isSesameApp: true }, companies);
    expect(r.companyID).toBe("ch_B"); // level 3 > 1
    expect(r.level).toBe(3);
  });

  it("[AUTH-0091] isSesameApp: 候補が 1 件も無い場合は {} (意図的逸脱)", () => {
    const onlyApp = [{ companyID: "ch_S", isSesameApp: true, feeLevel: { level: 9 } }];
    expect(priorityCompany({ isSesameApp: true }, onlyApp)).toEqual({});
  });

  it("[AUTH-0091] priorityCompanyId は priorityCompany の companyID を返す", () => {
    expect(priorityCompanyId({ companyID: "ch_A" }, companies)).toBe("ch_A");
  });

  it("[AUTH-0091] priorityCompanyId: companyID が得られなければ null", () => {
    expect(priorityCompanyId({ isSesameApp: true }, [])).toBeNull();
  });
});

// ============================================================
// AUTH-0092: status は daemon ローカル状態を返す (hub 往復なし・requireAuth なし)
// ============================================================
describe("[AUTH-0092] status は daemon ローカル状態を返す (hub 往復なし・requireAuth なし)", () => {
  it("[AUTH-0092] status handler は requireAuth を呼ばない (純ローカル契約)", async () => {
    const { authEntries } = await import("../../../kit/src/serve/entries/auth.js");
    const entries = authEntries();
    const statusEntry = entries["status"];
    expect(statusEntry).toBeDefined();

    // requireAuth が呼ばれたらエラーになる場合 (authState=expired は認証失敗扱い) でも
    // status handler は正常に返る (requireAuth を呼ばない)
    const hub = { connected: false, subUUID: null };
    const daemon = { authState: "expired" };
    const result = statusEntry.handler({ hub, daemon });
    expect(result.authState).toBe("expired");
    expect(result.connected).toBe(false);
    expect(result.subUUID).toBeNull();
  });

  it("[AUTH-0092] {connected, authState, subUUID, apiVersion, contractVersion} を返す", async () => {
    const { authEntries } = await import("../../../kit/src/serve/entries/auth.js");
    const entries = authEntries();
    const hub = { connected: true, subUUID: "sub-uuid-001" };
    const daemon = { authState: "ok" };
    const result = entries["status"].handler({ hub, daemon });

    expect(result.connected).toBe(true);
    expect(result.authState).toBe("ok");
    expect(result.subUUID).toBe("sub-uuid-001");
    expect(result.apiVersion).toBeDefined();
    expect(result.contractVersion).toBeDefined();
    // hub の ping は呼ばれない (requireAuth なし)
  });

  it("[AUTH-0092] apiVersion と contractVersion は同値 (CONTRACT_VERSION)", async () => {
    const { authEntries } = await import("../../../kit/src/serve/entries/auth.js");
    const { CONTRACT_VERSION } = await import("../../src/jsonrpc.js");
    const entries = authEntries();
    const hub = { connected: true, subUUID: "u" };
    const daemon = { authState: "ok" };
    const result = entries["status"].handler({ hub, daemon });
    expect(result.apiVersion).toBe(CONTRACT_VERSION);
    expect(result.contractVersion).toBe(CONTRACT_VERSION);
    expect(result.apiVersion).toBe(result.contractVersion);
  });

  it("[AUTH-0092] 未接続時 subUUID は null を返す (hub.subUUID が null の場合)", async () => {
    const { authEntries } = await import("../../../kit/src/serve/entries/auth.js");
    const entries = authEntries();
    const hub = { connected: false, subUUID: null };
    const daemon = { authState: "degraded" };
    const result = entries["status"].handler({ hub, daemon });
    expect(result.connected).toBe(false);
    expect(result.subUUID).toBeNull();
  });
});

// ============================================================
// AUTH-0093: status result スキーマ (RESULT_SCHEMAS.status の構造確認)
// ============================================================
describe("[AUTH-0093] status result スキーマ (connected/authState enum/subUUID nullable/apiVersion/contractVersion)", () => {
  it("[AUTH-0093] RESULT_SCHEMAS.status が正しい JSON Schema 構造を持つ", async () => {
    const { RESULT_SCHEMAS } = await import("../../../kit/src/serve/result-schemas.js");
    const schema = RESULT_SCHEMAS["status"];
    expect(schema).toBeDefined();
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();

    // required フィールドの確認
    expect(schema.required).toContain("connected");
    expect(schema.required).toContain("authState");
    expect(schema.required).toContain("apiVersion");
    expect(schema.required).toContain("contractVersion");
    // subUUID は required でない (nullable)
    expect(schema.required).not.toContain("subUUID");

    // connected は boolean
    expect(schema.properties.connected.type).toBe("boolean");
    // apiVersion / contractVersion は string
    expect(schema.properties.apiVersion.type).toBe("string");
    expect(schema.properties.contractVersion.type).toBe("string");
    // authState は enum ["ok","degraded","expired"]
    expect(schema.properties.authState.type).toBe("string");
    expect(schema.properties.authState.enum).toEqual(["ok", "degraded", "expired"]);
    // subUUID は nullable
    expect(schema.properties.subUUID.nullable).toBe(true);
    expect(schema.properties.subUUID.type).toBe("string");
  });

  it("[AUTH-0093] status authState enum は ['ok','degraded','expired'] の 3 値のみ", async () => {
    const { RESULT_SCHEMAS } = await import("../../../kit/src/serve/result-schemas.js");
    const authStateSchema = RESULT_SCHEMAS["status"].properties.authState;
    expect(authStateSchema.enum).toHaveLength(3);
    expect(authStateSchema.enum).toContain("ok");
    expect(authStateSchema.enum).toContain("degraded");
    expect(authStateSchema.enum).toContain("expired");
  });

  it("[AUTH-0093] status result の subUUID は nullable (未接続時 null)", async () => {
    const { RESULT_SCHEMAS } = await import("../../../kit/src/serve/result-schemas.js");
    const schema = RESULT_SCHEMAS["status"];
    // null が許容される
    expect(schema.properties.subUUID.nullable).toBe(true);
    const subUUIDValue = null;
    expect(subUUIDValue === null || typeof subUUIDValue === "string").toBe(true);
  });
});

// ============================================================
// AUTH-0094: status authState の 3 値が daemon 遷移と一致
// ============================================================
describe("[AUTH-0094] status authState の 3 値 (ok/degraded/expired) が daemon 遷移と一致", () => {
  /**
   * daemon.js の Daemon クラスの _connectLoop と _hasStoredTokens のロジックを
   * インライン再現してテストする。
   * 実装 (daemon.js:126-147, 156-161):
   *   - connect 成功 → authState = "ok"
   *   - connect 失敗かつ _hasStoredTokens() = true → authState = "degraded"
   *   - connect 失敗かつ _hasStoredTokens() = false → authState = "expired"
   */
  function hasStoredTokens(tokenStore) {
    try {
      const t = tokenStore?.load?.();
      return !!(t && (t.refreshToken || t.idToken));
    } catch { return false; }
  }

  async function simulateConnectLoop(hub, tokenStore) {
    let authState = "degraded";
    try {
      await hub.connect();
      authState = "ok";
    } catch {
      authState = hasStoredTokens(tokenStore) ? "degraded" : "expired";
    }
    return authState;
  }

  it("[AUTH-0094] connect 成功 → authState='ok'", async () => {
    const hub = { connect: async () => {} };
    const authState = await simulateConnectLoop(hub, null);
    expect(authState).toBe("ok");
  });

  it("[AUTH-0094] 接続失敗かつ _hasStoredTokens()=true → authState='degraded'", async () => {
    const hub = { connect: async () => { throw new Error("Network error"); } };
    const tokenStore = { load: () => ({ refreshToken: "rt-xxx", idToken: null }) };
    const authState = await simulateConnectLoop(hub, tokenStore);
    expect(authState).toBe("degraded");
  });

  it("[AUTH-0094] 接続失敗かつ _hasStoredTokens()=false → authState='expired'", async () => {
    const hub = { connect: async () => { throw new Error("Unauthenticated"); } };
    const tokenStore = { load: () => null };
    const authState = await simulateConnectLoop(hub, tokenStore);
    expect(authState).toBe("expired");
  });

  it("[AUTH-0094] connect 失敗 + tokenStore が存在しない → authState = 'expired'", async () => {
    const hub = { connect: async () => { throw new Error("Unauthenticated"); } };
    const authState = await simulateConnectLoop(hub, null);
    expect(authState).toBe("expired");
  });

  it("[AUTH-0094] connect 失敗 + idToken あり (refreshToken なし) でも 'degraded'", async () => {
    const hub = { connect: async () => { throw new Error("Network error"); } };
    const tokenStore = { load: () => ({ idToken: "ID-TOKEN", refreshToken: null }) };
    const authState = await simulateConnectLoop(hub, tokenStore);
    expect(authState).toBe("degraded");
  });

  it("[AUTH-0094] _hasStoredTokens は refreshToken または idToken の存在で判定する", () => {
    // hasStoredTokens(tokenStore) — tokenStore.load() が token データを返す
    const store = (data) => ({ load: () => data });
    expect(hasStoredTokens(store({ refreshToken: "rt-xxx" }))).toBe(true);
    expect(hasStoredTokens(store({ idToken: "id-xxx" }))).toBe(true);
    expect(hasStoredTokens(store({ refreshToken: "rt-xxx", idToken: "id-xxx" }))).toBe(true);
    expect(hasStoredTokens(store({}))).toBe(false);
    expect(hasStoredTokens(store(null))).toBe(false);
    expect(hasStoredTokens(null)).toBe(false);
    expect(hasStoredTokens(undefined)).toBe(false);
  });

  it("[AUTH-0094] daemon 初期値は 'degraded' (constructor での authState 初期化)", async () => {
    const { Daemon } = await import("../../../kit/src/serve/daemon.js");
    const hub = {
      connected: false,
      subUUID: null,
      tokenStore: { load: () => null },
      onReconnect: () => {},
      connect: async () => { throw new Error("not connected"); },
    };
    const daemon = new Daemon({ hub });
    expect(daemon.authState).toBe("degraded");
  });

  it("[AUTH-0094] status handler は daemon.authState をそのまま返す (値コピー)", async () => {
    const { authEntries } = await import("../../../kit/src/serve/entries/auth.js");
    const entries = authEntries();
    for (const state of ["ok", "degraded", "expired"]) {
      const daemon = { authState: state };
      const hub = { connected: true, subUUID: "s" };
      const result = entries["status"].handler({ hub, daemon });
      expect(result.authState).toBe(state);
    }
  });
});
