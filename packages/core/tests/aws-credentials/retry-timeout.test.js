// P3-13: cognitoCall / cognitoIdentityCall / makeApiGatewayTransport の
// リトライ / タイムアウト検出テスト。
//
// 参照(モック導出元):
//   _aws_sdk_ref/ClientConfiguration.java:33,36 — DEFAULT_SOCKET_TIMEOUT = DEFAULT_CONNECTION_TIMEOUT = 15_000 ms
//   _aws_sdk_ref/PredefinedRetryPolicies.java:50 — DEFAULT_MAX_ERROR_RETRY = 3
//   _aws_sdk_ref/PredefinedRetryPolicies.java:154-194 — SDKDefaultRetryCondition:
//     HTTP 500/502/503/504 + Throttling/ThrottlingException/ProvisionedThroughputExceededException +
//     IOException のみリトライ。4xx 非 Throttling はリトライ禁止。
//   _aws_sdk_ref/RetryUtils.java:34-41 — isThrottlingException errorCode 集合
//   _aws_sdk_ref/RetryUtils.java:65-73 — isClockSkewError errorCode 集合 (SigV4 transport のみ)
//   _aws_sdk_ref/RetryUtils.java:82-101 — isInterrupted: SocketTimeoutException はリトライ除外
//
// 既存テスト (aws-credentials.test.js) が「成功する fetch」しかテストしておらず
// 失敗経路 (5xx / ネットワーク例外) をカバーしていなかったことが見逃しの根因。
import { describe, it, expect, vi } from "vitest";
import { cognitoCall } from "../../src/cognito-http.js";
import {
  makeCognitoCredentialsProvider,
  makeApiGatewayTransport,
  DEFAULT_CH_API_BASE_URL,
} from "../../src/aws-credentials.js";

// ---------- テストヘルパ ----------

/**
 * fetch を呼ぶたびに responses を順に返すモック。最後の1つは繰り返す。
 * レスポンスオブジェクトは clone() もサポート (Throttling 4xx 判定で使う)。
 * @param {Array<{status?: number, body?: unknown, throws?: Error}>} responses
 */
function scriptedFetch(responses) {
  let i = 0;
  const calls = [];
  const fn = vi.fn(async (url, init) => {
    calls.push({ url, init });
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
  fn.calls = calls;
  return fn;
}

/** 正常な Identity 応答 (GetId + GetCredentialsForIdentity)。 */
function _okIdentitySeq(expSec = Date.now() / 1000 + 3600) {
  return [
    { status: 200, body: { IdentityId: "ap-northeast-1:id-ok" } },
    {
      status: 200,
      body: {
        IdentityId: "ap-northeast-1:id-ok",
        Credentials: { AccessKeyId: "AK", SecretKey: "SK", SessionToken: "ST", Expiration: expSec },
      },
    },
  ];
}

// ---------- P3-13: cognitoCall リトライ ----------

describe("P3-13: cognitoCall — リトライ / タイムアウト", () => {
  it("500 → 200 の 2 段で成功し 2 回 fetch が発生する (DEFAULT_MAX_ERROR_RETRY=3)", async () => {
    // 参照: PredefinedRetryPolicies.java:50 DEFAULT_MAX_ERROR_RETRY = 3
    //       PredefinedRetryPolicies.java:175-179 HTTP 500 はリトライ対象
    const fetchImpl = scriptedFetch([
      { status: 500, body: { Message: "transient error" } },
      { status: 200, body: { ChallengeName: "CUSTOM_CHALLENGE" } },
    ]);
    // timeoutMs / maxRetries を最小値に固定してテストを高速化
    const result = await cognitoCall("InitiateAuth", { AuthFlow: "CUSTOM_AUTH" }, {
      fetchImpl,
      timeoutMs: 100,
      maxRetries: 3,
    });
    expect(result.ChallengeName).toBe("CUSTOM_CHALLENGE");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("503 を 3 回リトライして全て失敗するとエラーを投げる", async () => {
    // 参照: PredefinedRetryPolicies.java:176 HTTP_UNAVAILABLE = 503
    const fetchImpl = scriptedFetch([
      { status: 503, body: {} },
    ]);
    await expect(
      cognitoCall("InitiateAuth", {}, { fetchImpl, timeoutMs: 100, maxRetries: 3 }),
    ).rejects.toThrow();
    // 1 回初回 + 3 回リトライ = 計 4 回
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("NotAuthorizedException (401) はリトライしない — 4xx 禁止 (参照: SDKDefaultRetryCondition)", async () => {
    // 参照: PredefinedRetryPolicies.java:154-194 — 4xx 認証エラーはリトライ禁止
    const fetchImpl = scriptedFetch([
      { status: 400, body: { __type: "NotAuthorizedException", message: "Token expired" } },
    ]);
    await expect(
      cognitoCall("InitiateAuth", {}, { fetchImpl, timeoutMs: 100, maxRetries: 3 }),
    ).rejects.toThrow("Token expired");
    // 1 回のみ
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("ネットワーク例外 (TypeError) はリトライ対象 (参照: IOException 相当)", async () => {
    // 参照: PredefinedRetryPolicies.java:163-168 IOException はリトライ
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

  it("AbortError (ユーザキャンセル) はリトライしない (1試行のみ)", async () => {
    // 参照: RetryUtils.java:82-101 — isInterrupted: AbortedException は即リトライ禁止
    const abortErr = Object.assign(new Error("timeout"), { name: "AbortError" });
    const fetchImpl = scriptedFetch([{ throws: abortErr }]);
    await expect(
      cognitoCall("InitiateAuth", {}, { fetchImpl, timeoutMs: 100, maxRetries: 3 }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // FIN-AUTH-02: TimeoutError (AbortSignal.timeout 発火) はリトライしない
  it("TimeoutError (AbortSignal.timeout 発火) はリトライしない — 1試行のみ (FIN-AUTH-02)", async () => {
    // 参照: RetryUtils.java:82-101 — SocketTimeoutException は InterruptedIOException
    // サブクラスでリトライ除外。Node undici は AbortSignal.timeout 発火時 name="TimeoutError" を投げる。
    const timeoutErr = Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
    const fetchImpl = scriptedFetch([{ throws: timeoutErr }]);
    await expect(
      cognitoCall("InitiateAuth", {}, { fetchImpl, timeoutMs: 100, maxRetries: 3 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    // TimeoutError はリトライしない — 1試行のみ
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // FIN-AUTH-01: Throttling 4xx がリトライされる
  it("Throttling __type の 400 応答 → リトライして 2 回目で成功する (FIN-AUTH-01)", async () => {
    // 参照: RetryUtils.java:34-41 — isThrottlingException: "Throttling" errorCode
    //       PredefinedRetryPolicies.java:187-189 — Throttling は 4xx でもリトライ対象
    const fetchImpl = scriptedFetch([
      { status: 400, body: { __type: "Throttling", message: "Rate exceeded" } },
      { status: 200, body: { ChallengeName: "CUSTOM_CHALLENGE" } },
    ]);
    const result = await cognitoCall("InitiateAuth", {}, { fetchImpl, timeoutMs: 100, maxRetries: 3 });
    expect(result.ChallengeName).toBe("CUSTOM_CHALLENGE");
    // 1回目 Throttling + 2回目 成功 = 2回
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("ThrottlingException __type の 400 応答 → リトライして成功する (FIN-AUTH-01)", async () => {
    // 参照: RetryUtils.java:40 — "ThrottlingException" も isThrottlingException 対象
    const fetchImpl = scriptedFetch([
      { status: 400, body: { __type: "com.amazonaws.cognito.idp#ThrottlingException", message: "Throttled" } },
      { status: 200, body: { ChallengeName: "CUSTOM_CHALLENGE" } },
    ]);
    const result = await cognitoCall("InitiateAuth", {}, { fetchImpl, timeoutMs: 100, maxRetries: 3 });
    expect(result.ChallengeName).toBe("CUSTOM_CHALLENGE");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("NotAuthorizedException 400 → リトライしない (非 Throttling 4xx 禁止)", async () => {
    // 参照: PredefinedRetryPolicies.java:154-194 — 非 Throttling 4xx はリトライ禁止
    const fetchImpl = scriptedFetch([
      { status: 400, body: { __type: "NotAuthorizedException", message: "Token expired" } },
    ]);
    await expect(
      cognitoCall("InitiateAuth", {}, { fetchImpl, timeoutMs: 100, maxRetries: 3 }),
    ).rejects.toThrow("Token expired");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

// ---------- P3-13: cognitoIdentityCall (aws-credentials) リトライ ----------

describe("P3-13: makeCognitoCredentialsProvider — cognitoIdentityCall のリトライ", () => {
  it("GetId が 500 → 200 の 2 段で成功 (リトライ経由)", async () => {
    const expSec = Date.now() / 1000 + 3600;
    const fetchImpl = scriptedFetch([
      { status: 500, body: {} }, // GetId 1 回目: 500
      { status: 200, body: { IdentityId: "ap-northeast-1:id-retry" } }, // GetId 2 回目: 成功
      // GetCredentialsForIdentity
      {
        status: 200,
        body: {
          IdentityId: "ap-northeast-1:id-retry",
          Credentials: { AccessKeyId: "AK", SecretKey: "SK", SessionToken: "ST", Expiration: expSec },
        },
      },
    ]);
    const provider = makeCognitoCredentialsProvider({
      getIdToken: async () => "T",
      fetchImpl,
    });
    const creds = await provider.getCredentials();
    expect(creds.identityId).toBe("ap-northeast-1:id-retry");
    // GetId 2 回 + GetCredentialsForIdentity 1 回 = 3 回
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("NotAuthorizedException はリトライせず即 throw (4xx 認証エラー禁止)", async () => {
    const fetchImpl = scriptedFetch([
      { status: 400, body: { __type: "NotAuthorizedException", message: "Token expired" } },
    ]);
    const provider = makeCognitoCredentialsProvider({
      getIdToken: async () => "T",
      fetchImpl,
    });
    await expect(provider.getCredentials()).rejects.toMatchObject({ code: "unauthenticated" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // FIN-AUTH-02: TimeoutError はリトライしない (cognitoIdentityCall)
  it("TimeoutError はリトライしない — 1試行のみ (FIN-AUTH-02, cognitoIdentityCall)", async () => {
    // 参照: RetryUtils.java:82-101 — SocketTimeoutException はリトライ除外
    const timeoutErr = Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
    const fetchImpl = scriptedFetch([{ throws: timeoutErr }]);
    const provider = makeCognitoCredentialsProvider({
      getIdToken: async () => "T",
      fetchImpl,
    });
    await expect(provider.getCredentials()).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // FIN-AUTH-01: Throttling 4xx がリトライされる (cognitoIdentityCall)
  it("Throttling __type の 400 → リトライして GetId 成功 (FIN-AUTH-01, cognitoIdentityCall)", async () => {
    // 参照: RetryUtils.java:34-41 — isThrottlingException
    //       PredefinedRetryPolicies.java:187-189 — Throttling は 4xx でもリトライ対象
    const expSec = Date.now() / 1000 + 3600;
    const fetchImpl = scriptedFetch([
      { status: 400, body: { __type: "ThrottlingException", message: "Rate exceeded" } }, // GetId 1回目
      { status: 200, body: { IdentityId: "ap-northeast-1:id-throttle" } },                // GetId 2回目
      {
        status: 200,
        body: {
          IdentityId: "ap-northeast-1:id-throttle",
          Credentials: { AccessKeyId: "AK", SecretKey: "SK", SessionToken: "ST", Expiration: expSec },
        },
      },
    ]);
    const provider = makeCognitoCredentialsProvider({
      getIdToken: async () => "T",
      fetchImpl,
    });
    const creds = await provider.getCredentials();
    expect(creds.identityId).toBe("ap-northeast-1:id-throttle");
    // GetId 2回 (1回目 Throttling リトライ) + GetCredentials 1回 = 3回
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

// ---------- P3-13: makeApiGatewayTransport リトライ ----------

describe("P3-13: makeApiGatewayTransport — リトライ", () => {
  const fakeProvider = {
    getCredentials: async () => ({
      accessKeyId: "AK",
      secretAccessKey: "SK",
      sessionToken: "ST",
      expiration: new Date(Date.now() + 3600_000),
      identityId: "ap-northeast-1:id",
    }),
  };

  it("502 → 200 の 2 段で成功", async () => {
    // 参照: PredefinedRetryPolicies.java:177 HTTP_BAD_GATEWAY = 502
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

  it("4xx は 1 回で確定 (リトライなし)", async () => {
    const fetchImpl = scriptedFetch([{ status: 403, body: { error: "Forbidden" } }]);
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

  it("ネットワーク例外から 1 回リトライして成功", async () => {
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

  // FIN-AUTH-02: TimeoutError はリトライしない (makeApiGatewayTransport)
  it("TimeoutError はリトライしない — 1試行のみ (FIN-AUTH-02, makeApiGatewayTransport)", async () => {
    // 参照: RetryUtils.java:82-101 — SocketTimeoutException はリトライ除外
    const timeoutErr = Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
    const fetchImpl = scriptedFetch([{ throws: timeoutErr }]);
    const transport = makeApiGatewayTransport({
      baseUrl: DEFAULT_CH_API_BASE_URL,
      credentialsProvider: fakeProvider,
      fetchImpl,
      timeoutMs: 100,
      maxRetries: 3,
    });
    await expect(transport({ method: "GET", path: "/device/list" })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // FIN-AUTH-01: Throttling 4xx がリトライされる (makeApiGatewayTransport)
  it("Throttling __type の 400 → リトライして成功 (FIN-AUTH-01, makeApiGatewayTransport)", async () => {
    // 参照: RetryUtils.java:34-41 — isThrottlingException
    //       PredefinedRetryPolicies.java:187-189 — Throttling は 4xx でもリトライ対象
    const fetchImpl = scriptedFetch([
      { status: 400, body: { __type: "ProvisionedThroughputExceededException", message: "Throughput exceeded" } },
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

  it("非 Throttling 4xx (403 Forbidden) はリトライしない (FIN-AUTH-01 対比)", async () => {
    // 参照: PredefinedRetryPolicies.java:154-194 — 非 Throttling 4xx はリトライ禁止
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

  // ClockSkew リトライ (SigV4 固有。RetryUtils.java:65-73 — isClockSkewError)
  it("SignatureDoesNotMatch (clock skew) → リトライして成功 (makeApiGatewayTransport, ClockSkew)", async () => {
    // 参照: RetryUtils.java:65-73 — isClockSkewError: SignatureDoesNotMatch
    //       PredefinedRetryPolicies.java:193-197 — clock skew はリトライ対象
    const fetchImpl = scriptedFetch([
      { status: 403, body: { __type: "SignatureDoesNotMatch", message: "Signature mismatch" } },
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

  it("RequestTimeTooSkewed (clock skew) → リトライして成功 (ClockSkew)", async () => {
    // 参照: RetryUtils.java:70 — "RequestTimeTooSkewed"
    const fetchImpl = scriptedFetch([
      { status: 400, body: { __type: "RequestTimeTooSkewed", message: "Request time too skewed" } },
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
});
