// src/aws-credentials.js — Cognito Identity Pool 一時 credentials 取得
// (CognitoCachingCredentialsProvider 相当) と appidentifyid 解決の単体テスト。
//
// 参照:
//   - _sesame_sdk_ref/app.properties:5,8,9 — API key / IdentityPool ID / UserPool ID の実値
//   - ApiClientConfigBuilder.kt:51-61 — CognitoCachingCredentialsProvider(identityPoolId, region)
//   - BaseApp.kt:95-102 — credentialsProvider = AWSMobileClient.getInstance()
//   - AppIdentifyIdUtil.kt:26-48 — appidentifyid の生成と永続化
// リクエスト形は AWS JSON 1.1 プロトコル (X-Amz-Target: AWSCognitoIdentityService.GetId /
// .GetCredentialsForIdentity, logins キー = "cognito-idp.<region>.amazonaws.com/<userPoolId>")。
import { describe, it, expect, vi } from "vitest";
import {
  makeCognitoCredentialsProvider,
  generateAppIdentifyId,
  resolveAppIdentifyId,
  makeApiGatewayTransport,
  IDENTITY_POOL_ID,
  USER_POOL_ID,
  API_GATEWAY_API_KEY,
  DEFAULT_CH_API_BASE_URL,
} from "../../src/aws-credentials.js";

const ENDPOINT = "https://cognito-identity.ap-northeast-1.amazonaws.com/";
const LOGIN_KEY = `cognito-idp.ap-northeast-1.amazonaws.com/${USER_POOL_ID}`;

/** 固定スクリプトの fetch モック。呼び出しを記録し、responses を順に返す。 */
function scriptedFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({
      url,
      method: init?.method,
      headers: { ...(init?.headers || {}) },
      body: init?.body ? JSON.parse(init.body) : null,
    });
    const r = responses.shift();
    if (!r) throw new Error(`unexpected fetch: ${url}`);
    return { status: r.status ?? 200, text: async () => JSON.stringify(r.body) };
  };
  fn.calls = calls;
  return fn;
}

/** 正常系 GetId / GetCredentialsForIdentity 応答 (Expiration は epoch 秒の double)。 */
function okIdentityResponses({ identityId = "ap-northeast-1:identity-1", expSec, sessionToken = "SESSION" } = {}) {
  return [
    { body: { IdentityId: identityId } },
    {
      body: {
        IdentityId: identityId,
        Credentials: {
          AccessKeyId: "ASIAEXAMPLE",
          SecretKey: "secret/Key",
          SessionToken: sessionToken,
          Expiration: expSec,
        },
      },
    },
  ];
}

describe("makeCognitoCredentialsProvider", () => {
  it("GetId → GetCredentialsForIdentity を正しいリクエスト形で呼び、credentials を写像する", async () => {
    const expSec = Date.now() / 1000 + 3600;
    const fetchImpl = scriptedFetch(okIdentityResponses({ expSec }));
    const getIdToken = vi.fn(async () => "ID-TOKEN-1");
    const provider = makeCognitoCredentialsProvider({ getIdToken, fetchImpl });

    const creds = await provider.getCredentials();

    expect(fetchImpl.calls).toHaveLength(2);
    // ---- GetId (AWS JSON 1.1) ----
    const getId = fetchImpl.calls[0];
    expect(getId.url).toBe(ENDPOINT);
    expect(getId.method).toBe("POST");
    expect(getId.headers["content-type"]).toBe("application/x-amz-json-1.1");
    expect(getId.headers["x-amz-target"]).toBe("AWSCognitoIdentityService.GetId");
    expect(getId.body).toEqual({
      IdentityPoolId: IDENTITY_POOL_ID, // app.properties:8 の実値
      Logins: { [LOGIN_KEY]: "ID-TOKEN-1" },
    });
    expect(IDENTITY_POOL_ID).toBe("ap-northeast-1:0a1820f1-dbb3-4bca-9227-2a92f6abf0ae");
    // ---- GetCredentialsForIdentity ----
    const getCreds = fetchImpl.calls[1];
    expect(getCreds.headers["x-amz-target"]).toBe("AWSCognitoIdentityService.GetCredentialsForIdentity");
    expect(getCreds.body).toEqual({
      IdentityId: "ap-northeast-1:identity-1",
      Logins: { [LOGIN_KEY]: "ID-TOKEN-1" },
    });
    // ---- 写像 (応答フィールドは AccessKeyId / SecretKey / SessionToken / Expiration) ----
    expect(creds.accessKeyId).toBe("ASIAEXAMPLE");
    expect(creds.secretAccessKey).toBe("secret/Key");
    expect(creds.sessionToken).toBe("SESSION");
    expect(creds.identityId).toBe("ap-northeast-1:identity-1");
    expect(creds.expiration.getTime()).toBeCloseTo(expSec * 1000, -1);
  });

  it("失効まで余裕がある間はキャッシュを返す (追加 fetch なし)", async () => {
    const fetchImpl = scriptedFetch(okIdentityResponses({ expSec: Date.now() / 1000 + 3600 }));
    const provider = makeCognitoCredentialsProvider({ getIdToken: async () => "T", fetchImpl });
    const first = await provider.getCredentials();
    const second = await provider.getCredentials();
    expect(second).toBe(first);
    expect(fetchImpl.calls).toHaveLength(2); // GetId + GetCredentialsForIdentity の 1 往復のみ
  });

  it("Expiration の 500s 手前を切ったら自動再取得する (IdentityId は再利用し GetId は再発行しない)", async () => {
    // DEFAULT_REFRESH_MARGIN_MS = 500_000 ms (500s) — CognitoCredentialsProvider.java:67
    //   DEFAULT_THRESHOLD_SECONDS=500、:853-863 needsNewSession() の閾値に対応。
    let nowMs = 1_700_000_000_000;
    const expSec1 = nowMs / 1000 + 3600; // 1 回目: 1 時間有効
    const expSec2 = nowMs / 1000 + 7200;
    const fetchImpl = scriptedFetch([
      ...okIdentityResponses({ expSec: expSec1, sessionToken: "S1" }),
      // 2 回目は GetCredentialsForIdentity のみ
      {
        body: {
          IdentityId: "ap-northeast-1:identity-1",
          Credentials: { AccessKeyId: "AK2", SecretKey: "SK2", SessionToken: "S2", Expiration: expSec2 },
        },
      },
    ]);
    const getIdToken = vi.fn(async () => "T");
    const provider = makeCognitoCredentialsProvider({ getIdToken, fetchImpl, now: () => nowMs });

    const c1 = await provider.getCredentials();
    expect(c1.sessionToken).toBe("S1");

    // 失効 500s 前 (= margin 内) まで進める → 再取得が走る
    nowMs = (expSec1 - 250) * 1000;
    const c2 = await provider.getCredentials();
    expect(c2.sessionToken).toBe("S2");
    expect(getIdToken).toHaveBeenCalledTimes(2); // idToken は都度コールバックから供給
    expect(fetchImpl.calls).toHaveLength(3);
    expect(fetchImpl.calls[2].headers["x-amz-target"]).toBe("AWSCognitoIdentityService.GetCredentialsForIdentity");
  });

  it("並行呼び出しは single-flight で 1 回の取得に合流する", async () => {
    const fetchImpl = scriptedFetch(okIdentityResponses({ expSec: Date.now() / 1000 + 3600 }));
    const provider = makeCognitoCredentialsProvider({ getIdToken: async () => "T", fetchImpl });
    const [a, b] = await Promise.all([provider.getCredentials(), provider.getCredentials()]);
    expect(a).toBe(b);
    expect(fetchImpl.calls).toHaveLength(2);
  });

  it("エラー応答は __type を含む SesameError になる (NotAuthorized → unauthenticated)", async () => {
    const fetchImpl = scriptedFetch([
      { status: 400, body: { __type: "NotAuthorizedException", message: "Token expired" } },
    ]);
    const provider = makeCognitoCredentialsProvider({ getIdToken: async () => "T", fetchImpl });
    const err = await provider.getCredentials().catch((e) => e);
    expect(err.name).toBe("SesameError");
    expect(err.code).toBe("unauthenticated");
    expect(err.message).toMatch(/GetId/);
    expect(err.message).toMatch(/NotAuthorizedException/);
    expect(err.message).toMatch(/Token expired/);
    expect(err.data).toEqual({ op: "GetId", type: "NotAuthorizedException" });
  });

  it("__type の namespace prefix ('ns#Type') は '#' 以降を採る", async () => {
    const fetchImpl = scriptedFetch([
      { status: 400, body: { __type: "com.amazon.coral.service#ResourceNotFoundException", message: "gone" } },
    ]);
    const provider = makeCognitoCredentialsProvider({ getIdToken: async () => "T", fetchImpl });
    const err = await provider.getCredentials().catch((e) => e);
    expect(err.data.type).toBe("ResourceNotFoundException");
    expect(err.code).toBe("rejected");
  });

  it("キャッシュ済み IdentityId が失効していたら GetId からやり直して 1 回だけ再試行する", async () => {
    let nowMs = 1_700_000_000_000;
    const expSec1 = nowMs / 1000 + 3600;
    const fetchImpl = scriptedFetch([
      ...okIdentityResponses({ expSec: expSec1, sessionToken: "S1" }),
      // 失効後の再取得: 古い IdentityId は server 側で消えている
      { status: 400, body: { __type: "ResourceNotFoundException", message: "Identity not found" } },
      { body: { IdentityId: "ap-northeast-1:identity-2" } },
      {
        body: {
          IdentityId: "ap-northeast-1:identity-2",
          Credentials: { AccessKeyId: "AK2", SecretKey: "SK2", SessionToken: "S2", Expiration: nowMs / 1000 + 7200 },
        },
      },
    ]);
    const provider = makeCognitoCredentialsProvider({ getIdToken: async () => "T", fetchImpl, now: () => nowMs });

    await provider.getCredentials();
    nowMs = (expSec1 + 10) * 1000; // 完全失効
    const c2 = await provider.getCredentials();

    expect(c2.identityId).toBe("ap-northeast-1:identity-2");
    expect(c2.sessionToken).toBe("S2");
    expect(fetchImpl.calls).toHaveLength(5);
    expect(fetchImpl.calls[4].body.IdentityId).toBe("ap-northeast-1:identity-2");
  });

  it("不完全な Credentials 応答は明示エラー", async () => {
    const fetchImpl = scriptedFetch([
      { body: { IdentityId: "id" } },
      { body: { IdentityId: "id", Credentials: { AccessKeyId: "AK" } } }, // SecretKey 等欠落
    ]);
    const provider = makeCognitoCredentialsProvider({ getIdToken: async () => "T", fetchImpl });
    await expect(provider.getCredentials()).rejects.toThrow(/GetCredentialsForIdentity/);
  });

  it("入力バリデーション (getIdToken / fetchImpl)", () => {
    expect(() => makeCognitoCredentialsProvider({})).toThrow(/getIdToken/);
    expect(() => makeCognitoCredentialsProvider({ getIdToken: async () => "T", fetchImpl: null }))
      .toThrow(/fetchImpl/);
  });
});

describe("appidentifyid (AppIdentifyIdUtil.kt 相当)", () => {
  it("generateAppIdentifyId は 'ap-northeast-1:<uuid>' 形式 (AppIdentifyIdUtil.kt:42)", () => {
    const id = generateAppIdentifyId();
    expect(id).toMatch(/^ap-northeast-1:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("resolveAppIdentifyId: 明示注入 > config 保存値 > 新規生成 (config へ書き戻し)", () => {
    // 明示注入が最優先
    expect(resolveAppIdentifyId({ appIdentifyId: "ap-northeast-1:explicit", config: { appIdentifyId: "ap-northeast-1:stored" } }))
      .toBe("ap-northeast-1:explicit");
    // config 保存値を再利用
    expect(resolveAppIdentifyId({ config: { appIdentifyId: "ap-northeast-1:stored" } }))
      .toBe("ap-northeast-1:stored");
    // どちらも無ければ生成して config に書き戻す (次回 save() で永続化される)
    const cfg = { appIdentifyId: null };
    const generated = resolveAppIdentifyId({ config: cfg });
    expect(generated).toMatch(/^ap-northeast-1:/);
    expect(cfg.appIdentifyId).toBe(generated);
    // 同じ config なら以後安定
    expect(resolveAppIdentifyId({ config: cfg })).toBe(generated);
  });

  it("resolveAppIdentifyId: configStore 経由なら即 save して永続化する", () => {
    const cfg = {};
    const save = vi.fn();
    const store = { load: () => cfg, save };
    const generated = resolveAppIdentifyId({ configStore: store });
    expect(cfg.appIdentifyId).toBe(generated);
    expect(save).toHaveBeenCalledTimes(1);
    // 2 回目は保存値を返すだけ (save 再発行なし)
    expect(resolveAppIdentifyId({ configStore: store })).toBe(generated);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe("makeApiGatewayTransport (ApiClientFactory 相当)", () => {
  const fakeProvider = {
    getCredentials: async () => ({
      accessKeyId: "ASIAEXAMPLE",
      secretAccessKey: "secretKey",
      sessionToken: "SESSION-TOKEN",
      expiration: new Date(Date.now() + 3600_000),
      identityId: "ap-northeast-1:id",
    }),
  };

  it("appIdentifyId を渡した transport は SigV4 + x-api-key + appidentifyid のヘッダ一式を組む", async () => {
    // appidentifyid が「あり」のエンドポイント用 (per-op 表: /device/list GET —
    // CHAPIClient.kt:36-39。表は src/aws-credentials.js makeApiGatewayTransport 冒頭)。
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return { status: 200, text: async () => "{}" };
    };
    const transport = makeApiGatewayTransport({
      baseUrl: DEFAULT_CH_API_BASE_URL,
      credentialsProvider: fakeProvider,
      appIdentifyId: "ap-northeast-1:fixed-id",
      fetchImpl,
    });
    await transport({ method: "GET", path: "/device/list" });

    expect(captured.url).toBe("https://app.candyhouse.co/prod/device/list");
    const h = captured.init.headers;
    // x-api-key は app.properties:5 の実値が既定 (BaseApp.kt:100 API_GATEWAY_API_KEY)
    expect(h["x-api-key"]).toBe(API_GATEWAY_API_KEY);
    expect(API_GATEWAY_API_KEY).toBe("iGgXj9GorS4PeH90mAysg1l7kdvoIPxM25mPFl3k");
    expect(h.appidentifyid).toBe("ap-northeast-1:fixed-id");
    expect(h["x-amz-security-token"]).toBe("SESSION-TOKEN");
    expect(h["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
    // Authorization: SigV4 scope = <date>/ap-northeast-1/execute-api/aws4_request
    expect(h.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=ASIAEXAMPLE\/\d{8}\/ap-northeast-1\/execute-api\/aws4_request, SignedHeaders=appidentifyid;content-type;host;x-amz-date;x-amz-security-token;x-api-key, Signature=[0-9a-f]{64}$/,
    );
  });

  it("appIdentifyId 省略 (既定 null) なら appidentifyid ヘッダを付けず署名にも含めない (バックログ8)", async () => {
    // appidentifyid が「なし」のエンドポイント用 (per-op 表: /device/v1/** には付かない —
    // 例 /device/v1/sesame2/sign CHAPIClient.kt:95-96)。
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return { status: 200, text: async () => "{}" };
    };
    const transport = makeApiGatewayTransport({
      baseUrl: DEFAULT_CH_API_BASE_URL,
      credentialsProvider: fakeProvider,
      fetchImpl,
    });
    await transport({ method: "POST", path: "/device/v1/sesame2/sign", body: { a: 1 } });

    const h = captured.init.headers;
    expect(h.appidentifyid).toBeUndefined();
    expect(h.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=ASIAEXAMPLE\/\d{8}\/ap-northeast-1\/execute-api\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-api-key, Signature=[0-9a-f]{64}$/,
    );
    expect(captured.init.body).toBe('{"a":1}');
  });

  it("path 未指定は fetch せず明示エラー / 末尾スラッシュは除去", async () => {
    let called = false;
    const fetchImpl = async () => { called = true; return { status: 200, text: async () => "" }; };
    const transport = makeApiGatewayTransport({
      baseUrl: "https://app.candyhouse.co/prod///",
      credentialsProvider: fakeProvider,
      fetchImpl,
    });
    await expect(transport({ method: "POST" })).rejects.toThrow(/path required/);
    expect(called).toBe(false);
  });

  it("入力バリデーション (baseUrl / credentialsProvider / fetchImpl)", () => {
    expect(() => makeApiGatewayTransport({ credentialsProvider: fakeProvider, fetchImpl: () => {} }))
      .toThrow(/baseUrl required/);
    expect(() => makeApiGatewayTransport({ baseUrl: "https://x", fetchImpl: () => {} }))
      .toThrow(/credentialsProvider required/);
    expect(() => makeApiGatewayTransport({ baseUrl: "https://x", credentialsProvider: fakeProvider, fetchImpl: null }))
      .toThrow(/fetchImpl/);
  });
});
