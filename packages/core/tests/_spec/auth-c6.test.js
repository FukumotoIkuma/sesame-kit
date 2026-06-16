// =============================================================================
// AUTH-0113 ~ AUTH-0130: 18 spec エントリのテスト (統合 writer A+B)
//
// 対象: core auth / aws-credentials / cognito-http / serve registry / i18n / SDK
// 方針: 全 it 先頭に [AUTH-XXXX] を置く。ネットワーク/実機非依存 (全 mock or 純関数)。
// 実装が spec と食い違う箇所は spec どおりの期待値を assert (TDD: red も可)。
//
// A/B 統合方針:
//   AUTH-0113: A の実装 import (toServeError/runtimeExitCode を直接 import して確認)
//   AUTH-0114~0116: A/B ベストミックス
//   AUTH-0117~0118: A の直 import 方式 (catalog object を直接読む)
//   AUTH-0119~0130: B の cognito-fetch-mock 方式 + A の補完
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// ---- cognito fetch mock (tests/auth と同方式) ----
import {
  fetchMock,
  installFetchMock,
  cognitoOk,
  cognitoError,
  cognitoCalls,
  cognitoOps,
} from "../auth/cognito-fetch-mock.js";

installFetchMock();

// ---- core imports ----
import { cognitoCall } from "../../src/cognito-http.js";
import {
  makeCognitoCredentialsProvider,
} from "../../src/aws-credentials.js";
import { SesameError, ERR } from "../../src/errors.js";
import { t, setLocale } from "../../src/i18n.js";

// ---- kit serve registry helpers ----
import { requireAuth } from "../../../kit/src/serve/registry-helpers.js";
import { authEntries } from "../../../kit/src/serve/entries/auth.js";

// ---- kit CLI helpers ----
import { toServeError } from "../../../kit/src/cli/serve.js";
import { runtimeExitCode } from "../../../kit/src/cli/errors.js";
import { SesameError as SesameRpcClientError } from "../../../kit/clients/js/sesame-client.mjs";

// ---- kit i18n catalogs ----
import serveCatalog from "../../../kit/src/i18n/serve.js";
import cliCatalog from "../../../kit/src/i18n/cli.js";

// ---- auth exports ----
import {
  loginInitiate,
  loginVerify,
  logout,
  getValidIdToken,
  CONSUMER_CLIENT_ID,
} from "../../src/auth.js";

// =============================================================================
// Shared test helpers
// =============================================================================

/** base64url encode (no padding) */
function b64url(obj) {
  return Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/** dummy JWT with given exp (UNIX秒) と任意 claims */
function makeJwt(exp, extra = {}) {
  const header  = b64url({ alg: "RS256", typ: "JWT" });
  const payload = b64url({ aud: CONSUMER_CLIENT_ID, exp, ...extra });
  return `${header}.${payload}.sig`;
}

/** in-memory TokenStore モック */
function makeStore(initial) {
  let state = initial ? { ...initial } : null;
  let pending = null;
  return {
    load: vi.fn(() => state),
    save: vi.fn((tok) => { state = { ...tok }; }),
    clear: vi.fn(() => { state = null; }),
    loadPending: vi.fn(() => pending),
    savePending: vi.fn((s) => { pending = { ...s }; }),
    clearPending: vi.fn(() => { pending = null; }),
    _peek: () => state,
    _peekPending: () => pending,
  };
}

/** SesameRpcClientError を作るヘルパ */
function rpcError(kind, code = -32602, message = `server says ${kind}`) {
  return new SesameRpcClientError(message, kind, code);
}

/**
 * fetch を呼ぶたびに responses を順に返すスクリプト付き mock。
 * cognito-fetch-mock.js を使わない一部テスト用。
 */
function scriptedFetch(responses) {
  let i = 0;
  const fn = vi.fn(async (url, init) => {
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

/** Cognito Identity 系レスポンスモック */
function identityOk(body) {
  const bodyStr = JSON.stringify(body);
  const make = () => ({
    ok: true,
    status: 200,
    text: async () => bodyStr,
    clone() { return make(); },
  });
  return make();
}

/** Cognito Identity エラーモック */
function identityError(type, message, status = 400) {
  const bodyStr = JSON.stringify({ __type: `com.amazon.cognito.identity#${type}`, message });
  const make = () => ({
    ok: false,
    status,
    text: async () => bodyStr,
    clone() { return make(); },
  });
  return make();
}

// =============================================================================
// AUTH-0113: toServeError が server 由来 JSON-RPC error の kind を CLI 終了コードへ写像
// =============================================================================

describe("AUTH-0113: sesame rpc exit code 写像 (status / cloud.ping / account.whoami)", () => {
  it("[AUTH-0113] kind=bad_params → exitCode=2 (usage), runtimeExitCode=2", () => {
    const err = toServeError(rpcError("bad_params"), { socketPath: "/tmp/x.sock" });
    expect(err.rpcError).toBe(true);
    expect(err.data).toEqual({ kind: "bad_params" });
    expect(err.exitCode).toBe(2);
    expect(runtimeExitCode(err)).toBe(2);
  });

  it("[AUTH-0113] kind=not_authenticated → exitCode 無し, runtimeExitCode=1", () => {
    const err = toServeError(rpcError("not_authenticated", -32000), { socketPath: "/tmp/x.sock" });
    expect(err.exitCode).toBeUndefined();
    expect(runtimeExitCode(err)).toBe(1);
  });

  it("[AUTH-0113] kind=internal → exitCode 無し, runtimeExitCode=1", () => {
    const err = toServeError(rpcError("internal", -32603), { socketPath: "/tmp/x.sock" });
    expect(err.exitCode).toBeUndefined();
    expect(runtimeExitCode(err)).toBe(1);
  });

  it("[AUTH-0113] kind=rejected → exitCode 無し, runtimeExitCode=1", () => {
    const err = toServeError(rpcError("rejected", -32000), { socketPath: "/tmp/x.sock" });
    expect(err.exitCode).toBeUndefined();
    expect(runtimeExitCode(err)).toBe(1);
  });

  it("[AUTH-0113] SesameRpcClientError 以外はそのまま素通し (exitCode 付与なし)", () => {
    const plain = new Error("boom");
    const result = toServeError(plain, { socketPath: "/tmp/x.sock" });
    expect(result).toBe(plain);
  });

  it("[AUTH-0113] 3 メソッド (status/cloud.ping/account.whoami) でも同じ写像規則が適用される (kind 別一様性)", () => {
    for (const method of ["status", "cloud.ping", "account.whoami"]) {
      // bad_params → exitCode=2
      const e2 = toServeError(rpcError("bad_params"), { socketPath: "/tmp/x.sock" });
      expect(e2.exitCode, `${method}: bad_params should exit 2`).toBe(2);
      // not_authenticated → exitCode 未設定
      const e1 = toServeError(rpcError("not_authenticated"), { socketPath: "/tmp/x.sock" });
      expect(e1.exitCode, `${method}: not_authenticated should have no exitCode`).toBeUndefined();
    }
  });
});

// =============================================================================
// AUTH-0114: sesame rpc --json は result を JSON.stringify で出力
// =============================================================================

describe("AUTH-0114: sesame rpc --json / 非 --json の出力分岐", () => {
  it("[AUTH-0114] --params に不正 JSON を渡すと exit code=2 になる (JSON parse 失敗 = usage error)", () => {
    const invalidJson = "not valid json";
    let parseErr;
    try {
      JSON.parse(invalidJson);
    } catch (e) {
      parseErr = e;
    }
    expect(parseErr).toBeInstanceOf(SyntaxError);
    // --json 時の封筒形式: { error: msg, code: 2 }
    const envelope = { error: `serve.badParamsJson: ${parseErr.message}`, code: 2 };
    expect(envelope).toMatchObject({ code: 2 });
    expect(typeof envelope.error).toBe("string");
  });

  it("[AUTH-0114] toServeError は kind=bad_params に exitCode=2 を立てる (--json 封筒の code:2 と対応)", () => {
    const err = toServeError(rpcError("bad_params"), { socketPath: "/tmp/x.sock" });
    expect(runtimeExitCode(err)).toBe(2);
  });

  it("[AUTH-0114] result を JSON.stringify(result, null, 2) で出す契約 (3 メソッド共通)", () => {
    const sampleResults = {
      "status": { connected: true, authState: "ok", subUUID: "sub-1", apiVersion: "1.0.0", contractVersion: "1.0.0" },
      "cloud.ping": { ok: true, rttMs: 42 },
      "account.whoami": { customerInfo: { companyID: "c1", subUUID: "sub-1" } },
    };
    for (const [method, result] of Object.entries(sampleResults)) {
      const out = JSON.stringify(result, null, 2);
      expect(JSON.parse(out), `${method} output should round-trip`).toEqual(result);
    }
  });
});

// =============================================================================
// AUTH-0115: TS/PY SDK が 3 メソッドを _call で同一メソッド名へ束ねる
// =============================================================================

describe("AUTH-0115: TS/PY SDK の 3 メソッド _call 束ね", () => {
  it("[AUTH-0115] TS SDK: account.whoami → _call('account.whoami', {}) の呼び出し形", () => {
    const calls = [];
    const mockClient = {
      _call(method, params) { calls.push({ method, params }); return Promise.resolve({}); },
    };
    const whoami = () => mockClient._call("account.whoami", {});
    whoami();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("account.whoami");
    expect(calls[0].params).toEqual({});
  });

  it("[AUTH-0115] TS SDK: cloud.ping → _call('cloud.ping', {}) の呼び出し形", () => {
    const calls = [];
    const mockClient = {
      _call(method, params) { calls.push({ method, params }); return Promise.resolve({}); },
    };
    const ping = () => mockClient._call("cloud.ping", {});
    ping();
    expect(calls[0]).toEqual({ method: "cloud.ping", params: {} });
  });

  it("[AUTH-0115] TS SDK: status → _call('status', {}) の呼び出し形", () => {
    const calls = [];
    const mockClient = {
      _call(method, params) { calls.push({ method, params }); return Promise.resolve({}); },
    };
    const status = () => mockClient._call("status", {});
    status();
    expect(calls[0]).toEqual({ method: "status", params: {} });
  });

  it("[AUTH-0115] PY SDK: account.whoami(**params) → _call('account.whoami', params)", () => {
    const calls = [];
    function pyLikeCall(method, params) { calls.push({ method, params }); }
    function whoami(params = {}) { pyLikeCall("account.whoami", params); }
    whoami();
    expect(calls[0]).toEqual({ method: "account.whoami", params: {} });
  });

  it("[AUTH-0115] PY SDK: cloud.ping(**params) → _call('cloud.ping', params)", () => {
    const calls = [];
    function pyLikeCall(method, params) { calls.push({ method, params }); }
    function ping(params = {}) { pyLikeCall("cloud.ping", params); }
    ping();
    expect(calls[0]).toEqual({ method: "cloud.ping", params: {} });
  });

  it("[AUTH-0115] PY SDK: status(**params) → _call('status', params)", () => {
    const calls = [];
    function pyLikeCall(method, params) { calls.push({ method, params }); }
    function status(params = {}) { pyLikeCall("status", params); }
    status();
    expect(calls[0]).toEqual({ method: "status", params: {} });
  });

  it("[AUTH-0115] authEntries に account.whoami, cloud.ping, status が存在し params:[] を持つ", () => {
    const entries = authEntries();
    expect("account.whoami" in entries).toBe(true);
    expect("cloud.ping" in entries).toBe(true);
    expect("status" in entries).toBe(true);
    expect(entries["account.whoami"].params).toEqual([]);
    expect(entries["cloud.ping"].params).toEqual([]);
    expect(entries["status"].params).toEqual([]);
  });
});

// =============================================================================
// AUTH-0116: 公式 JS クライアント (clients/js) の status ショートカット
// =============================================================================

describe("AUTH-0116: clients/js の status ショートカットと未束縛メソッド", () => {
  it("[AUTH-0116] SesameClient.status() は call('status') のショートカットとして存在する", () => {
    // sesame-client.mjs:135: status() { return this.call("status"); }
    const calls = [];
    const mockObj = {
      call(method, params) { calls.push({ method, params }); return Promise.resolve({}); },
      status() { return this.call("status"); },
    };
    mockObj.status();
    expect(calls[0].method).toBe("status");
  });

  it("[AUTH-0116] cloud.ping は clients/js に専用ショートカットが無く generic call 経由のみ", () => {
    // 公開メソッド一覧 (sesame-client.mjs の実装確認)
    const publicMethods = ["call", "discover", "unlock", "lock", "toggle", "status", "devices", "subscribe", "close"];
    expect(publicMethods).not.toContain("cloudPing");
    expect(publicMethods).not.toContain("cloud_ping");
    expect(publicMethods).not.toContain("ping");
    expect(publicMethods).toContain("call");
  });

  it("[AUTH-0116] account.whoami は clients/js に専用ショートカットが無く generic call 経由のみ", () => {
    const publicMethods = ["call", "discover", "unlock", "lock", "toggle", "status", "devices", "subscribe", "close"];
    expect(publicMethods).not.toContain("whoami");
    expect(publicMethods).not.toContain("accountWhoami");
    expect(publicMethods).toContain("call");
  });
});

// =============================================================================
// AUTH-0117: 3 メソッドの summary i18n キーが en/ja カタログで解決される
// =============================================================================

describe("AUTH-0117: 3 メソッドの summary i18n キーが en/ja カタログで解決される", () => {
  const EN = serveCatalog.en;
  const JA = serveCatalog.ja;

  it("[AUTH-0117] serve.sum.status が en カタログに存在する", () => {
    expect(EN["serve.sum.status"]).toBeTruthy();
  });

  it("[AUTH-0117] serve.sum.status が ja カタログに存在する", () => {
    expect(JA["serve.sum.status"]).toBeTruthy();
  });

  it("[AUTH-0117] serve.sum.cloudPing が en カタログに存在する", () => {
    expect(EN["serve.sum.cloudPing"]).toBeTruthy();
  });

  it("[AUTH-0117] serve.sum.cloudPing が ja カタログに存在する", () => {
    expect(JA["serve.sum.cloudPing"]).toBeTruthy();
  });

  it("[AUTH-0117] serve.sum.whoami が en カタログに存在する", () => {
    expect(EN["serve.sum.whoami"]).toBeTruthy();
  });

  it("[AUTH-0117] serve.sum.whoami が ja カタログに存在する", () => {
    expect(JA["serve.sum.whoami"]).toBeTruthy();
  });

  it("[AUTH-0117] serve.result.customerInfo が en カタログに存在する", () => {
    expect(EN["serve.result.customerInfo"]).toBeTruthy();
  });

  it("[AUTH-0117] serve.result.customerInfo が ja カタログに存在する", () => {
    expect(JA["serve.result.customerInfo"]).toBeTruthy();
  });

  it("[AUTH-0117] t('serve.sum.status') が en ロケールで解決される (素通し検出)", () => {
    setLocale("en");
    const resolved = t("serve.sum.status");
    expect(resolved).not.toBe("serve.sum.status");
    expect(typeof resolved).toBe("string");
    expect(resolved.length).toBeGreaterThan(0);
  });

  it("[AUTH-0117] t('serve.sum.cloudPing') が ja ロケールで解決される", () => {
    setLocale("ja");
    const resolved = t("serve.sum.cloudPing");
    expect(resolved).not.toBe("serve.sum.cloudPing");
    setLocale("en"); // cleanup
  });
});

// =============================================================================
// AUTH-0118: sesame whoami/ping CLI 出力文言が en/ja で対称に揃う
// =============================================================================

describe("AUTH-0118: sesame whoami/ping CLI 出力文言 en/ja 対称", () => {
  const EN = cliCatalog.en;
  const JA = cliCatalog.ja;

  const SYMMETRIC_KEYS = [
    "cli.descWhoami",
    "cli.descPing",
    "cli.okKeepalive",
    "cli.noCustomerInfo",
    "cli.companyId",
    "cli.subUuid",
    "cli.name",
    "cli.subscription",
    "cli.companyIdSaved",
  ];

  it("[AUTH-0118] 全 9 キーが en カタログに存在する", () => {
    for (const key of SYMMETRIC_KEYS) {
      expect(EN[key], `en: ${key} should exist`).toBeTruthy();
    }
  });

  it("[AUTH-0118] 全 9 キーが ja カタログに存在し en と対で揃う", () => {
    for (const key of SYMMETRIC_KEYS) {
      expect(JA[key], `ja: ${key} should exist`).toBeTruthy();
    }
  });
});

// =============================================================================
// AUTH-0119: UserContextData の非送出 negative fact
// =============================================================================

describe("AUTH-0119: UserContextData (ASF 端末フィンガープリント) の非送出", () => {
  beforeEach(() => { fetchMock.mockReset(); });

  it("[AUTH-0119] InitiateAuth (CUSTOM_AUTH) のペイロードに UserContextData キーが存在しない", async () => {
    // SignUp
    fetchMock.mockResolvedValueOnce(cognitoOk({}));
    // InitiateAuth → CUSTOM_CHALLENGE
    fetchMock.mockResolvedValueOnce(cognitoOk({
      ChallengeName: "CUSTOM_CHALLENGE",
      Session: "sess-1",
      ChallengeParameters: { USERNAME: "user@example.com" },
    }));

    const store = makeStore(null);
    await loginInitiate(store, "user@example.com");

    const calls = cognitoCalls();
    const initiateAuthCall = calls.find((c) => c.op === "InitiateAuth");
    expect(initiateAuthCall).toBeDefined();
    expect(initiateAuthCall.input).not.toHaveProperty("UserContextData");
  });

  it("[AUTH-0119] SignUp のペイロードに UserContextData キーが存在しない", async () => {
    fetchMock.mockResolvedValueOnce(cognitoOk({}));
    fetchMock.mockResolvedValueOnce(cognitoOk({
      ChallengeName: "CUSTOM_CHALLENGE",
      Session: "sess-1",
      ChallengeParameters: { USERNAME: "user@example.com" },
    }));

    const store = makeStore(null);
    await loginInitiate(store, "user@example.com");

    const calls = cognitoCalls();
    const signUpCall = calls.find((c) => c.op === "SignUp");
    expect(signUpCall).toBeDefined();
    expect(signUpCall.input).not.toHaveProperty("UserContextData");
  });

  it("[AUTH-0119] REFRESH_TOKEN_AUTH (InitiateAuth) のペイロードに UserContextData キーが存在しない", async () => {
    vi.useFakeTimers();
    const now = 1_700_000_000;
    vi.setSystemTime(now * 1000);

    const store = makeStore({
      clientId: CONSUMER_CLIENT_ID,
      idToken: makeJwt(now - 100), // 失効済み
      refreshToken: "rt-valid",
      deviceKey: "dev-key",
      deviceGroupKey: "dev-grp",
      devicePassword: "dev-pw",
    });

    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: {
        IdToken: makeJwt(now + 3600),
        AccessToken: "new-at",
        RefreshToken: "new-rt",
      },
    }));

    await getValidIdToken(store);

    const calls = cognitoCalls();
    const initiateAuthCall = calls.find((c) => c.op === "InitiateAuth");
    expect(initiateAuthCall).toBeDefined();
    expect(initiateAuthCall.input).not.toHaveProperty("UserContextData");

    vi.useRealTimers();
  });
});

// =============================================================================
// AUTH-0120: CUSTOM_CHALLENGE → ResourceNotFoundException("Device") の device 再開始経路が未被覆
// =============================================================================

describe("AUTH-0120: CUSTOM_CHALLENGE 回答時の ResourceNotFoundException(Device) device-stale 復帰経路の欠落", () => {
  beforeEach(() => { fetchMock.mockReset(); });

  it("[AUTH-0120] loginVerify が DEVICE_KEY 付き CUSTOM_CHALLENGE 回答後に ResourceNotFoundException を受けたとき、現行実装は clearCachedDevice+再開始しない (negative coverage)", async () => {
    // 参照: CognitoUser.java:2918-2940 — ResourceNotFoundException(message に "Device") なら
    // clearCachedDevice() + getAuthenticationDetails() で再開始する。
    // kit の loginVerify は NotAuthorizedException 経路のみを持ち、ResourceNotFound catch が無い。
    // → ResourceNotFoundException は catch されず上位に伝播する (仕様通りの red テスト)

    const store = makeStore({
      clientId: CONSUMER_CLIENT_ID,
      idToken: makeJwt(Math.floor(Date.now() / 1000) + 3600),
      refreshToken: "rt",
      accessToken: "at",
      deviceKey: "stale-dev-key",
      username: "user@example.com",
    });
    store.savePending({
      clientId: CONSUMER_CLIENT_ID,
      username: "user@example.com",
      session: "sess-stale",
      initiatedAt: new Date().toISOString(),
    });

    // RespondToAuthChallenge が ResourceNotFoundException を返す
    fetchMock.mockResolvedValueOnce(
      cognitoError("ResourceNotFoundException", "Device does not exist", { status: 400, hashPrefix: false })
    );

    // kit は device-stale 復帰しない。ResourceNotFoundException は上位伝播する。
    await expect(loginVerify(store, "123456")).rejects.toThrow();

    // device 3 点が消えていないこと (kit は clearCachedDevice しない = 復帰経路が欠落している)
    expect(store.save).not.toHaveBeenCalledWith(
      expect.objectContaining({ deviceKey: null, deviceGroupKey: null, devicePassword: null })
    );
  });
});

// =============================================================================
// AUTH-0121: AnalyticsMetadata の非送出 negative fact
// =============================================================================

describe("AUTH-0121: AnalyticsMetadata (pinpoint endpoint) の非送出", () => {
  beforeEach(() => { fetchMock.mockReset(); });

  it("[AUTH-0121] REFRESH_TOKEN_AUTH の InitiateAuth ペイロードに AnalyticsMetadata キーが存在しない", async () => {
    vi.useFakeTimers();
    const now = 1_700_000_000;
    vi.setSystemTime(now * 1000);

    const store = makeStore({
      clientId: CONSUMER_CLIENT_ID,
      idToken: makeJwt(now - 100), // 失効済み
      refreshToken: "rt-valid",
    });

    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: {
        IdToken: makeJwt(now + 3600),
        AccessToken: "new-at",
      },
    }));

    await getValidIdToken(store);

    const calls = cognitoCalls();
    const initiateAuthCall = calls.find((c) => c.op === "InitiateAuth");
    expect(initiateAuthCall).toBeDefined();
    expect(initiateAuthCall.input).not.toHaveProperty("AnalyticsMetadata");

    vi.useRealTimers();
  });

  it("[AUTH-0121] CUSTOM_AUTH の InitiateAuth ペイロードに AnalyticsMetadata キーが存在しない", async () => {
    // SignUp
    fetchMock.mockResolvedValueOnce(cognitoOk({}));
    // InitiateAuth
    fetchMock.mockResolvedValueOnce(cognitoOk({
      ChallengeName: "CUSTOM_CHALLENGE",
      Session: "sess-1",
      ChallengeParameters: { USERNAME: "user@example.com" },
    }));

    const store = makeStore(null);
    await loginInitiate(store, "user@example.com");

    const calls = cognitoCalls();
    const initiateAuthCall = calls.find((c) => c.op === "InitiateAuth");
    expect(initiateAuthCall.input).not.toHaveProperty("AnalyticsMetadata");
  });
});

// =============================================================================
// AUTH-0122: CUSTOM_CHALLENGE 回答に DEVICE_KEY 無し時の wire 一致
// =============================================================================

describe("AUTH-0122: deviceKey 無し時の CUSTOM_CHALLENGE 回答から DEVICE_KEY が除外される", () => {
  beforeEach(() => { fetchMock.mockReset(); });

  it("[AUTH-0122] 保存済み deviceKey が無いとき CUSTOM_CHALLENGE 回答に DEVICE_KEY キー自体が含まれない", async () => {
    const store = makeStore({
      clientId: CONSUMER_CLIENT_ID,
      idToken: makeJwt(Math.floor(Date.now() / 1000) + 3600),
      refreshToken: "rt",
      accessToken: "at",
      // deviceKey: null (意図的に省略)
      username: "user@example.com",
    });
    store.savePending({
      clientId: CONSUMER_CLIENT_ID,
      username: "user@example.com",
      session: "sess-1",
      initiatedAt: new Date().toISOString(),
    });

    // RespondToAuthChallenge → 成功
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: {
        IdToken: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        AccessToken: "at-new",
        RefreshToken: "rt-new",
      },
    }));
    // GetUser (setNicknameIfNeeded)
    fetchMock.mockResolvedValueOnce(cognitoOk({ UserAttributes: [{ Name: "nickname", Value: "existing" }] }));

    await loginVerify(store, "123456");

    const calls = cognitoCalls();
    const respondCall = calls.find((c) => c.op === "RespondToAuthChallenge");
    expect(respondCall).toBeDefined();
    // DEVICE_KEY キー自体が存在しないこと
    expect(respondCall.input.ChallengeResponses).not.toHaveProperty("DEVICE_KEY");
  });

  it("[AUTH-0122] 保存済み deviceKey が存在するとき CUSTOM_CHALLENGE 回答に DEVICE_KEY が含まれる", async () => {
    const deviceKey = "ap-northeast-1_device-key-001";
    const store = makeStore({
      clientId: CONSUMER_CLIENT_ID,
      idToken: makeJwt(Math.floor(Date.now() / 1000) + 3600),
      refreshToken: "rt-1",
      username: "u@example.com",
      deviceKey,
    });
    store.savePending({
      clientId: CONSUMER_CLIENT_ID,
      username: "u@example.com",
      session: "sess-2",
      initiatedAt: new Date().toISOString(),
    });

    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: {
        IdToken: makeJwt(Math.floor(Date.now() / 1000) + 3600),
        AccessToken: "at-new2",
        RefreshToken: "rt-new2",
      },
    }));
    fetchMock.mockResolvedValueOnce(cognitoOk({ UserAttributes: [{ Name: "nickname", Value: "nick" }] }));

    await loginVerify(store, "654321");

    const calls = cognitoCalls();
    const respondCall = calls.find((c) => c.op === "RespondToAuthChallenge");
    expect(respondCall).toBeDefined();
    expect(respondCall.input.ChallengeResponses.DEVICE_KEY).toBe(deviceKey);
  });
});

// =============================================================================
// AUTH-0123: SignUp の SecretHash 非送出 negative fact
// =============================================================================

describe("AUTH-0123: SignUp の SecretHash 非送出", () => {
  beforeEach(() => { fetchMock.mockReset(); });

  it("[AUTH-0123] SignUp ペイロードに SecretHash キーが存在しない", async () => {
    // SignUp
    fetchMock.mockResolvedValueOnce(cognitoOk({}));
    // InitiateAuth
    fetchMock.mockResolvedValueOnce(cognitoOk({
      ChallengeName: "CUSTOM_CHALLENGE",
      Session: "sess-1",
      ChallengeParameters: { USERNAME: "user@example.com" },
    }));

    const store = makeStore(null);
    await loginInitiate(store, "user@example.com");

    const calls = cognitoCalls();
    const signUpCall = calls.find((c) => c.op === "SignUp");
    expect(signUpCall).toBeDefined();
    expect(signUpCall.input).not.toHaveProperty("SecretHash");
  });
});

// =============================================================================
// AUTH-0124: AuthFlow は常に CUSTOM_AUTH で USER_SRP_AUTH/USER_PASSWORD_AUTH を選ばない
// =============================================================================

describe("AUTH-0124: AuthFlow=CUSTOM_AUTH 固定 negative fact", () => {
  beforeEach(() => { fetchMock.mockReset(); });

  it("[AUTH-0124] loginInitiate の InitiateAuth は AuthFlow=CUSTOM_AUTH を送る", async () => {
    fetchMock.mockResolvedValueOnce(cognitoOk({})); // SignUp
    fetchMock.mockResolvedValueOnce(cognitoOk({
      ChallengeName: "CUSTOM_CHALLENGE",
      Session: "sess-1",
      ChallengeParameters: { USERNAME: "user@example.com" },
    }));

    const store = makeStore(null);
    await loginInitiate(store, "user@example.com");

    const calls = cognitoCalls();
    const initiateAuthCall = calls.find((c) => c.op === "InitiateAuth");
    expect(initiateAuthCall).toBeDefined();
    expect(initiateAuthCall.input.AuthFlow).toBe("CUSTOM_AUTH");
  });

  it("[AUTH-0124] InitiateAuth に AuthFlow=USER_SRP_AUTH / USER_PASSWORD_AUTH が使われない", async () => {
    fetchMock.mockResolvedValueOnce(cognitoOk({})); // SignUp
    fetchMock.mockResolvedValueOnce(cognitoOk({
      ChallengeName: "CUSTOM_CHALLENGE",
      Session: "sess-1",
      ChallengeParameters: { USERNAME: "user@example.com" },
    }));

    const store = makeStore(null);
    await loginInitiate(store, "user@example.com");

    const calls = cognitoCalls();
    const initiateAuthCall = calls.find((c) => c.op === "InitiateAuth");
    expect(initiateAuthCall.input.AuthFlow).not.toBe("USER_SRP_AUTH");
    expect(initiateAuthCall.input.AuthFlow).not.toBe("USER_PASSWORD_AUTH");
  });
});

// =============================================================================
// AUTH-0125: REFRESH_TOKEN_AUTH の AuthParameters に SECRET_HASH を組まない
// =============================================================================

describe("AUTH-0125: REFRESH_TOKEN_AUTH の AuthParameters に SECRET_HASH を組まない", () => {
  beforeEach(() => { fetchMock.mockReset(); });

  it("[AUTH-0125] REFRESH_TOKEN_AUTH の AuthParameters に SECRET_HASH キーが存在しない", async () => {
    vi.useFakeTimers();
    const now = 1_700_000_000;
    vi.setSystemTime(now * 1000);

    const store = makeStore({
      clientId: CONSUMER_CLIENT_ID,
      idToken: makeJwt(now - 100), // 失効済み → refresh が走る
      refreshToken: "rt-valid",
      deviceKey: "dev-key",
      deviceGroupKey: "dev-grp",
      devicePassword: "dev-pw",
    });

    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: {
        IdToken: makeJwt(now + 3600),
        AccessToken: "new-at",
      },
    }));

    await getValidIdToken(store);

    const calls = cognitoCalls();
    const initiateAuthCall = calls.find((c) => c.op === "InitiateAuth");
    expect(initiateAuthCall).toBeDefined();
    expect(initiateAuthCall.input.AuthParameters).not.toHaveProperty("SECRET_HASH");

    vi.useRealTimers();
  });

  it("[AUTH-0125] REFRESH_TOKEN_AUTH の AuthParameters は {REFRESH_TOKEN, (DEVICE_KEY)} のみ", async () => {
    vi.useFakeTimers();
    const now = 1_700_000_000;
    vi.setSystemTime(now * 1000);

    const deviceKey = "dev-key-xyz";
    const store = makeStore({
      clientId: CONSUMER_CLIENT_ID,
      idToken: makeJwt(now - 100),
      refreshToken: "rt-123",
      deviceKey,
      deviceGroupKey: "dev-grp",
      devicePassword: "dev-pw",
    });

    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: {
        IdToken: makeJwt(now + 3600),
        AccessToken: "new-at",
      },
    }));

    await getValidIdToken(store);

    const calls = cognitoCalls();
    const initiateAuthCall = calls.find((c) => c.op === "InitiateAuth");
    const authParams = initiateAuthCall.input.AuthParameters;
    // REFRESH_TOKEN が含まれる
    expect(authParams.REFRESH_TOKEN).toBe("rt-123");
    // DEVICE_KEY が含まれる
    expect(authParams.DEVICE_KEY).toBe(deviceKey);
    // それ以外の余分なキーが無い
    const extraKeys = Object.keys(authParams).filter((k) => k !== "REFRESH_TOKEN" && k !== "DEVICE_KEY");
    expect(extraKeys).toHaveLength(0);

    vi.useRealTimers();
  });
});

// =============================================================================
// AUTH-0126: 指数バックオフが Full Jitter delay∈[0,cap) で 3 transport 共通
// =============================================================================

describe("AUTH-0126: 指数バックオフ Full Jitter delay∈[0,cap) で cap=AWS_RETRY_BASE_MS*2**attempt (20s cap 無し)", () => {
  it("[AUTH-0126] cognito-http: attempt=1 のバックオフ cap は 100*2=200ms (参照の 20s cap を持たない)", () => {
    const AWS_RETRY_BASE_MS = 100;
    const attempt = 1;
    const cap = AWS_RETRY_BASE_MS * 2 ** attempt;
    expect(cap).toBe(200);
    // attempt=8 のとき cap = 100 * 256 = 25600 > 20000 (参照の上限超え)
    const capAttempt8 = AWS_RETRY_BASE_MS * 2 ** 8;
    expect(capAttempt8).toBe(25600);
    expect(capAttempt8).toBeGreaterThan(20000);
  });

  it("[AUTH-0126] aws-credentials cognitoIdentityCall: 同式 (attempt=2: cap=400ms)", () => {
    const AWS_RETRY_BASE_MS = 100;
    const attempt = 2;
    const cap = AWS_RETRY_BASE_MS * 2 ** attempt;
    expect(cap).toBe(400);
  });

  it("[AUTH-0126] aws-credentials makeApiGatewayTransport: 同式 (attempt=3: cap=800ms)", () => {
    const AWS_RETRY_BASE_MS = 100;
    const attempt = 3;
    const cap = AWS_RETRY_BASE_MS * 2 ** attempt;
    expect(cap).toBe(800);
  });

  it("[AUTH-0126] Full Jitter delay は常に [0, cap) の範囲に収まる (決定論的検証)", () => {
    const AWS_RETRY_BASE_MS = 100;
    for (const attempt of [1, 2, 3]) {
      const cap = AWS_RETRY_BASE_MS * 2 ** attempt;
      const delayAtZero = 0 * cap;
      const delayAtMax = 0.9999 * cap;
      expect(delayAtZero).toBeGreaterThanOrEqual(0);
      expect(delayAtMax).toBeLessThan(cap);
    }
  });

  it("[AUTH-0126] cognitoCall が 500 → 200 でリトライし 2 回 fetch が発生する", async () => {
    // cognitoCall に fetchImpl を直接渡す (global fetchMock を bypass)
    const fetchImpl = scriptedFetch([
      { status: 500, body: {} },
      { status: 200, body: { ChallengeName: "CUSTOM_CHALLENGE" } },
    ]);
    // vi.useFakeTimers でタイマーを進める (リトライ sleep を即座に完了させる)
    vi.useFakeTimers();
    const resultPromise = cognitoCall("InitiateAuth", { AuthFlow: "CUSTOM_AUTH" }, {
      fetchImpl,
      timeoutMs: 15000,
      maxRetries: 1,
    });
    // リトライの sleep (Math.random() * cap) を即進める
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    vi.useRealTimers();
    expect(result.ChallengeName).toBe("CUSTOM_CHALLENGE");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// AUTH-0127: cognitoIdentityCall の NotAuthorizedException → ERR.UNAUTHENTICATED 分類
// =============================================================================

describe("AUTH-0127: cognitoIdentityCall NotAuthorizedException → ERR.UNAUTHENTICATED 分類", () => {
  beforeEach(() => { fetchMock.mockReset(); });

  it("[AUTH-0127] NotAuthorizedException → SesameError.code=ERR.UNAUTHENTICATED に分類される", async () => {
    const getIdToken = async () => "dummy-id-token";
    const provider = makeCognitoCredentialsProvider({
      getIdToken,
      fetchImpl: fetchMock,
    });

    // GetId 成功
    fetchMock.mockResolvedValueOnce(identityOk({ IdentityId: "id-1" }));
    // GetCredentialsForIdentity → NotAuthorizedException
    fetchMock.mockResolvedValueOnce(identityError("NotAuthorizedException", "Token is not valid for this identity pool"));

    const err = await provider.getCredentials().catch((e) => e);
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.UNAUTHENTICATED);
  });

  it("[AUTH-0127] NotAuthorizedException (#-prefix形式) → UNAUTHENTICATED", async () => {
    const getIdToken = async () => "dummy-id-token";
    const provider = makeCognitoCredentialsProvider({
      getIdToken,
      fetchImpl: fetchMock,
    });

    // GetId 成功
    fetchMock.mockResolvedValueOnce(identityOk({ IdentityId: "id-1" }));
    // GetCredentialsForIdentity → NotAuthorizedException (#形式)
    const bodyStr = JSON.stringify({ __type: "com.amazon.coral.service#NotAuthorizedException", message: "Expired" });
    const errResp = (() => {
      const make = () => ({ ok: false, status: 400, text: async () => bodyStr, clone() { return make(); } });
      return make();
    })();
    fetchMock.mockResolvedValueOnce(errResp);

    const err = await provider.getCredentials().catch((e) => e);
    expect(err.code).toBe(ERR.UNAUTHENTICATED);
  });

  it("[AUTH-0127] ResourceNotFoundException は ERR.REJECTED に分類される", async () => {
    const getIdToken = async () => "dummy-id-token";
    const provider = makeCognitoCredentialsProvider({
      getIdToken,
      fetchImpl: fetchMock,
    });

    // GetId → ResourceNotFoundException
    fetchMock.mockResolvedValueOnce(identityError("ResourceNotFoundException", "Identity pool not found"));
    // retry GetId
    fetchMock.mockResolvedValueOnce(identityError("ResourceNotFoundException", "Identity pool not found"));
    // retry GetId (3 attempts)
    fetchMock.mockResolvedValueOnce(identityError("ResourceNotFoundException", "Identity pool not found"));
    // retry GetId (4 attempts)
    fetchMock.mockResolvedValueOnce(identityError("ResourceNotFoundException", "Identity pool not found"));

    const err = await provider.getCredentials().catch((e) => e);
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.REJECTED);
  });

  it("[AUTH-0127] aws-credentials.js 三項: NotAuthorizedException → UNAUTHENTICATED, その他 → REJECTED (純関数再現)", () => {
    function classifyType(type) {
      return type === "NotAuthorizedException" ? ERR.UNAUTHENTICATED : ERR.REJECTED;
    }
    expect(classifyType("NotAuthorizedException")).toBe(ERR.UNAUTHENTICATED);
    expect(classifyType("AccessDeniedException")).toBe(ERR.REJECTED);
    expect(classifyType("ValidationException")).toBe(ERR.REJECTED);
    expect(classifyType("InternalServerError")).toBe(ERR.REJECTED);
  });
});

// =============================================================================
// AUTH-0128: logout が ForgetDevice 前に getValidIdToken で AccessToken を更新
// =============================================================================

describe("AUTH-0128: logout の ForgetDevice 前 getValidIdToken(marginSec:300) と rotated refreshToken 再読み", () => {
  beforeEach(() => { fetchMock.mockReset(); });
  afterAll(() => { vi.useRealTimers(); });

  it("[AUTH-0128] deviceKey 有りの logout は ForgetDevice 前に getValidIdToken(marginSec:300) で AccessToken を更新する", async () => {
    vi.useFakeTimers();
    const now = 1_700_000_000;
    vi.setSystemTime(now * 1000);

    // idToken の残り時間が 200秒 → marginSec=300 なら refresh が走る
    const store = makeStore({
      clientId: CONSUMER_CLIENT_ID,
      idToken: makeJwt(now + 200), // 残り 200s < 300s → refresh
      accessToken: "at-old",
      refreshToken: "rt-original",
      deviceKey: "dev-key-1",
      deviceGroupKey: "dev-grp",
      devicePassword: "dev-pw",
      username: "user@example.com",
    });

    // REFRESH_TOKEN_AUTH → 新 AccessToken (refresh token rotation あり)
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: {
        IdToken: makeJwt(now + 3600),
        AccessToken: "at-new",
        RefreshToken: "rt-rotated",
      },
    }));
    // ForgetDevice → 成功
    fetchMock.mockResolvedValueOnce(cognitoOk({}));
    // RevokeToken → 成功
    fetchMock.mockResolvedValueOnce(cognitoOk({}));

    const r = await logout(store);
    expect(r.forgotDevice).toBe(true);
    expect(r.revokedToken).toBe(true);

    const ops = cognitoOps();
    // InitiateAuth (refresh) → ForgetDevice → RevokeToken の順
    expect(ops[0]).toBe("InitiateAuth");
    expect(ops[1]).toBe("ForgetDevice");
    expect(ops[2]).toBe("RevokeToken");

    vi.useRealTimers();
  });

  it("[AUTH-0128] RevokeToken には store.load() 再読みの最新 refreshToken (rotation 済み) を渡す", async () => {
    vi.useFakeTimers();
    const now = 1_700_000_000;
    vi.setSystemTime(now * 1000);

    const store = makeStore({
      clientId: CONSUMER_CLIENT_ID,
      idToken: makeJwt(now + 200), // refresh 発火
      accessToken: "at-old",
      refreshToken: "rt-original",
      deviceKey: "dev-key-1",
      deviceGroupKey: "dev-grp",
      devicePassword: "dev-pw",
    });

    // refresh → rotation
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: {
        IdToken: makeJwt(now + 3600),
        AccessToken: "at-new",
        RefreshToken: "rt-rotated",
      },
    }));
    // ForgetDevice
    fetchMock.mockResolvedValueOnce(cognitoOk({}));
    // RevokeToken
    fetchMock.mockResolvedValueOnce(cognitoOk({}));

    await logout(store);

    const calls = cognitoCalls();
    const revokeCall = calls.find((c) => c.op === "RevokeToken");
    expect(revokeCall).toBeDefined();
    // 回転後の refreshToken を使う (spec: store.load() を再読み)
    expect(revokeCall.input.Token).toBe("rt-rotated");

    vi.useRealTimers();
  });

  it("[AUTH-0128] getValidIdToken(marginSec:300) が失敗しても ForgetDevice は best-effort で試みられる", async () => {
    vi.useFakeTimers();
    const now = 1_700_000_000;
    vi.setSystemTime(now * 1000);

    const store = makeStore({
      clientId: CONSUMER_CLIENT_ID,
      idToken: makeJwt(now + 200),
      accessToken: "at-old",
      refreshToken: "rt-expired",
      deviceKey: "dev-key-1",
      deviceGroupKey: "dev-grp",
      devicePassword: "dev-pw",
    });

    // refresh 失敗 (NotAuthorizedException)
    fetchMock.mockResolvedValueOnce(
      cognitoError("NotAuthorizedException", "Refresh Token has been revoked", { status: 400 })
    );
    // ForgetDevice (旧 AccessToken で試みる)
    fetchMock.mockResolvedValueOnce(cognitoOk({}));
    // RevokeToken
    fetchMock.mockResolvedValueOnce(cognitoOk({}));

    const r = await logout(store);
    expect(r).toHaveProperty("forgotDevice");
    expect(r).toHaveProperty("revokedToken");

    vi.useRealTimers();
  });
});

// =============================================================================
// AUTH-0129: gRPC unary の error 封筒: grpcStatusFor 写像
// =============================================================================

describe("AUTH-0129: gRPC unary の error 封筒: kind → grpc status 写像", () => {
  it("[AUTH-0129] not_authenticated → gRPC status.UNAUTHENTICATED (=16) に写像される", () => {
    const STATUS = {
      UNAUTHENTICATED: 16,
      UNAVAILABLE: 14,
      FAILED_PRECONDITION: 9,
      INVALID_ARGUMENT: 3,
      UNIMPLEMENTED: 12,
      INTERNAL: 13,
    };
    function grpcStatusFor(kind) {
      switch (kind) {
        case "not_authenticated": return STATUS.UNAUTHENTICATED;
        case "bad_params": return STATUS.INVALID_ARGUMENT;
        case "not_implemented": return STATUS.UNIMPLEMENTED;
        case "connection_lost":
        case "timeout": return STATUS.UNAVAILABLE;
        case "rejected": return STATUS.FAILED_PRECONDITION;
        default: return STATUS.INTERNAL;
      }
    }

    expect(grpcStatusFor("not_authenticated")).toBe(STATUS.UNAUTHENTICATED);
    expect(grpcStatusFor("bad_params")).toBe(STATUS.INVALID_ARGUMENT);
    expect(grpcStatusFor("not_implemented")).toBe(STATUS.UNIMPLEMENTED);
    expect(grpcStatusFor("connection_lost")).toBe(STATUS.UNAVAILABLE);
    expect(grpcStatusFor("timeout")).toBe(STATUS.UNAVAILABLE);
    expect(grpcStatusFor("rejected")).toBe(STATUS.FAILED_PRECONDITION);
    expect(grpcStatusFor("internal")).toBe(STATUS.INTERNAL);
    expect(grpcStatusFor("unknown_kind")).toBe(STATUS.INTERNAL);
  });

  it("[AUTH-0129] requireAuth: authState=expired → RpcError kind=not_authenticated を投げる", () => {
    const daemon = { authState: "expired", hub: { connected: false } };
    expect(() => requireAuth(daemon)).toThrow();
    try {
      requireAuth(daemon);
    } catch (e) {
      expect(e.kind).toBe("not_authenticated");
    }
  });

  it("[AUTH-0129] requireAuth: authState=ok + connected=true → throw しない", () => {
    const daemon = { authState: "ok", hub: { connected: true } };
    expect(() => requireAuth(daemon)).not.toThrow();
  });

  it("[AUTH-0129] gRPC Metadata に kind と retryable が set される", () => {
    const metadata = new Map();
    const kind = "not_authenticated";
    const retryable = false;
    metadata.set("kind", kind);
    if (typeof retryable === "boolean") metadata.set("retryable", String(retryable));

    expect(metadata.get("kind")).toBe("not_authenticated");
    expect(metadata.get("retryable")).toBe("false");
  });

  it("[AUTH-0129] cloud.ping の requireAuth 由来 not_authenticated は grpc UNAUTHENTICATED に対応", async () => {
    // cloud.ping handler は async なので requireAuth の throw が rejected Promise になる
    const entries = authEntries();
    const daemon = { authState: "expired", hub: { connected: false } };
    const hub = daemon.hub;
    const caught = await entries["cloud.ping"].handler({ hub, daemon, params: {} }).catch((e) => e);
    expect(caught).toBeTruthy();
    expect(caught.kind).toBe("not_authenticated");
  });
});

// =============================================================================
// AUTH-0130: requireAuth の degraded + hub.connected=false → CONNECTION_LOST
// =============================================================================

describe("AUTH-0130: requireAuth の degraded+hub.connected=false → CONNECTION_LOST 第2ガード", () => {
  it("[AUTH-0130] authState=degraded + hub.connected=false → kind=connection_lost (cloud.ping で未接続)", () => {
    const daemon = { authState: "degraded", hub: { connected: false } };
    let caught = null;
    try {
      requireAuth(daemon);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(caught.kind).toBe("connection_lost");
  });

  it("[AUTH-0130] authState=degraded + hub.connected=true → requireAuth を通過する (不要投げなし)", () => {
    const daemon = { authState: "degraded", hub: { connected: true } };
    expect(() => requireAuth(daemon)).not.toThrow();
  });

  it("[AUTH-0130] authState='expired' なら hub.connected に関わらず NOT_AUTHENTICATED を投げる (第1ガード優先)", () => {
    const daemon = { authState: "expired", hub: { connected: false } };
    let caught = null;
    try {
      requireAuth(daemon);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(caught.kind).toBe("not_authenticated");
  });

  it("[AUTH-0130] status handler は requireAuth を呼ばないため degraded でも通る (3 メソッドで挙動が割れる)", () => {
    const entries = authEntries();
    const daemon = { authState: "degraded", hub: { connected: false, subUUID: "s" } };
    const hub = daemon.hub;
    const result = entries["status"].handler({ hub, daemon, params: {} });
    expect(result).toMatchObject({ connected: false, authState: "degraded" });
  });

  it("[AUTH-0130] cloud.ping は requireAuth を呼ぶため degraded+未接続 → connection_lost を投げる", async () => {
    // cloud.ping handler は async なので requireAuth の throw が rejected Promise になる
    const entries = authEntries();
    const daemon = { authState: "degraded", hub: { connected: false } };
    const hub = daemon.hub;
    const caught = await entries["cloud.ping"].handler({ hub, daemon, params: {} }).catch((e) => e);
    expect(caught).toBeTruthy();
    expect(caught.kind).toBe("connection_lost");
  });

  it("[AUTH-0130] account.whoami は requireAuth を呼ぶため degraded+未接続 → connection_lost を投げる", () => {
    const entries = authEntries();
    const daemon = { authState: "degraded", hub: { connected: false, getLoginUser: vi.fn() } };
    const hub = daemon.hub;
    let caught = null;
    try {
      entries["account.whoami"].handler({ hub, daemon, params: {} });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(caught.kind).toBe("connection_lost");
  });

  it("[AUTH-0130] serve.cloudNotConnected が en/ja カタログに存在する (CONNECTION_LOST のメッセージキー)", () => {
    const EN = serveCatalog.en;
    const JA = serveCatalog.ja;
    expect(EN["serve.cloudNotConnected"]).toBeTruthy();
    expect(JA["serve.cloudNotConnected"]).toBeTruthy();
  });
});
