// P3-14: Identity Pool 再解決 recoverable 条件の修正テスト
// P3-15: identityId / credentials 永続化テスト
//
// 参照(モック導出元):
//   _aws_sdk_ref/CognitoCredentialsProvider.java:789-803 — recoverable は
//     ResourceNotFoundException と ValidationException のみ。NotAuthorizedException は即 throw。
//   _aws_sdk_ref/CognitoCachingCredentialsProvider.java:86-98 — キー定数
//   _aws_sdk_ref/CognitoCachingCredentialsProvider.java:434-435 — initialize 時の読み込み
//   _aws_sdk_ref/CognitoCachingCredentialsProvider.java:473-505 — loadCachedCredentials
//   _aws_sdk_ref/CognitoCachingCredentialsProvider.java:638-646 — saveCredentials
//   _aws_sdk_ref/CognitoCachingCredentialsProvider.java:655-659 — saveIdentityId
//
// 既存テストが recoverable に NotAuthorizedException を含めており (誤実装)、
// かつ永続化を全くテストしていなかったことが見逃しの根因。
import { describe, it, expect, vi } from "vitest";
import { makeCognitoCredentialsProvider } from "../../src/aws-credentials.js";

/** fetch を順に返すモック。 */
function scriptedFetch(responses) {
  let i = 0;
  const fn = vi.fn(async () => {
    const r = responses[Math.min(i++, responses.length - 1)];
    if (r.throws) throw r.throws;
    return {
      status: r.status ?? 200,
      ok: (r.status ?? 200) < 400,
      text: async () => JSON.stringify(r.body ?? {}),
    };
  });
  return fn;
}

/** 正常な GetCredentialsForIdentity 応答を 1 件返す。 */
function credsResp(id = "ap-northeast-1:id-1", expSec = Date.now() / 1000 + 3600) {
  return {
    status: 200,
    body: {
      IdentityId: id,
      Credentials: { AccessKeyId: "AK", SecretKey: "SK", SessionToken: "ST", Expiration: expSec },
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// P3-14: recoverable 条件
// ──────────────────────────────────────────────────────────────────────────
describe("P3-14: Identity Pool 再解決 recoverable 条件", () => {
  it("ValidationException → GetId からやり直す (recoverable=true)", async () => {
    // 参照: CognitoCredentialsProvider.java:796-800
    //   catch (AmazonServiceException) where errorCode == "ValidationException" → retryGetCredentialsForIdentity()
    const nowMs = Date.now();
    const fetchImpl = scriptedFetch([
      // 1. GetId 成功
      { status: 200, body: { IdentityId: "ap-northeast-1:id-stale" } },
      // 2. GetCredentialsForIdentity → ValidationException
      { status: 400, body: { __type: "ValidationException", message: "corrupted identity" } },
      // 3. GetId やり直し
      { status: 200, body: { IdentityId: "ap-northeast-1:id-fresh" } },
      // 4. GetCredentialsForIdentity 成功
      credsResp("ap-northeast-1:id-fresh", nowMs / 1000 + 3600),
    ]);
    const provider = makeCognitoCredentialsProvider({
      getIdToken: async () => "T",
      fetchImpl,
      now: () => nowMs,
    });
    const creds = await provider.getCredentials();
    expect(creds.identityId).toBe("ap-northeast-1:id-fresh");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("NotAuthorizedException → 即 throw (recoverable=false、1 回で止まる)", async () => {
    // 参照: CognitoCredentialsProvider.java:789-803 — NotAuthorizedException は throw ase
    // v2 の誤実装は NotAuthorizedException を recoverable に含めており再試行していた。
    const nowMs = Date.now();
    const fetchImpl = scriptedFetch([
      // 1. GetId 成功
      { status: 200, body: { IdentityId: "ap-northeast-1:id-1" } },
      // 2. GetCredentialsForIdentity → NotAuthorizedException
      { status: 400, body: { __type: "NotAuthorizedException", message: "Token expired" } },
      // (3. GetId やり直しは起こらない)
    ]);
    const provider = makeCognitoCredentialsProvider({
      getIdToken: async () => "T",
      fetchImpl,
      now: () => nowMs,
    });
    const err = await provider.getCredentials().catch((e) => e);
    expect(err.code).toBe("unauthenticated");
    // GetId 1 回 + GetCredentialsForIdentity 1 回 = 2 回 (GetId 再発行なし)
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("ResourceNotFoundException → GetId からやり直す (既存動作の維持確認)", async () => {
    // 参照: CognitoCredentialsProvider.java:792-795
    //   catch (ResourceNotFoundException) → retryGetCredentialsForIdentity()
    const nowMs = Date.now();
    const fetchImpl = scriptedFetch([
      { status: 200, body: { IdentityId: "ap-northeast-1:id-gone" } },
      { status: 400, body: { __type: "ResourceNotFoundException", message: "Identity not found" } },
      { status: 200, body: { IdentityId: "ap-northeast-1:id-new" } },
      credsResp("ap-northeast-1:id-new", nowMs / 1000 + 3600),
    ]);
    const provider = makeCognitoCredentialsProvider({
      getIdToken: async () => "T",
      fetchImpl,
      now: () => nowMs,
    });
    const creds = await provider.getCredentials();
    expect(creds.identityId).toBe("ap-northeast-1:id-new");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// P3-15: identityId / credentials の永続化
// ──────────────────────────────────────────────────────────────────────────
describe("P3-15: identityId / credentials の永続化 (CognitoCachingCredentialsProvider)", () => {
  /** in-memory の credentialsStore fake。 */
  function makeStore(initial = null) {
    let stored = initial;
    return {
      saved: [],
      loadAwsCredentials: vi.fn(() => stored),
      saveAwsCredentials: vi.fn((c) => { stored = c; }),
      get current() { return stored; },
    };
  }

  it("credentials 取得後に credentialsStore.saveAwsCredentials が呼ばれる (saveCredentials 相当)", async () => {
    // 参照: CognitoCachingCredentialsProvider.java:515-521 — refresh 後 saveCredentials を呼ぶ
    const store = makeStore();
    const expSec = Date.now() / 1000 + 3600;
    const fetchImpl = scriptedFetch([
      { status: 200, body: { IdentityId: "ap-northeast-1:id-1" } },
      credsResp("ap-northeast-1:id-1", expSec),
    ]);
    const provider = makeCognitoCredentialsProvider({
      getIdToken: async () => "T",
      fetchImpl,
      credentialsStore: store,
    });
    await provider.getCredentials();
    expect(store.saveAwsCredentials).toHaveBeenCalledTimes(1);
    const saved = store.current;
    expect(saved).not.toBeNull();
    expect(saved.identityId).toBe("ap-northeast-1:id-1");
    expect(saved.accessKeyId).toBe("AK");
    expect(saved.secretAccessKey).toBe("SK");
    expect(saved.sessionToken).toBe("ST");
    expect(typeof saved.expirationMs).toBe("number");
  });

  it("2 つ目の provider インスタンス (プロセス再起動模擬) が GetId をスキップする", async () => {
    // 参照: CognitoCachingCredentialsProvider.java:434-435 — initialize 内で getCachedIdentityId
    //       loadCachedCredentials を呼び起動時に注入
    const nowMs = Date.now();
    const expSec = nowMs / 1000 + 3600;
    const store = makeStore({
      identityId: "ap-northeast-1:id-persisted",
      accessKeyId: "AK-cached",
      secretAccessKey: "SK-cached",
      sessionToken: "ST-cached",
      expirationMs: expSec * 1000, // まだ有効
    });
    const fetchImpl = vi.fn();
    const provider = makeCognitoCredentialsProvider({
      getIdToken: async () => "T",
      fetchImpl,
      credentialsStore: store,
      now: () => nowMs,
    });
    const creds = await provider.getCredentials();
    // キャッシュが有効なので fetch は 1 回も発生しない (GetId スキップ)
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(creds.identityId).toBe("ap-northeast-1:id-persisted");
    expect(creds.accessKeyId).toBe("AK-cached");
  });

  it("永続化 credentials が期限切れの場合は再取得し GetId は identityId 再利用でスキップ", async () => {
    // 参照: CognitoCachingCredentialsProvider.java:473-476 — loadCachedCredentials で expiration チェック
    // 期限切れ credentials を持つストア
    const nowMs = Date.now();
    const expiredMs = nowMs - 10_000; // 10 秒前に失効
    const store = makeStore({
      identityId: "ap-northeast-1:id-cached",
      accessKeyId: "AK-old",
      secretAccessKey: "SK-old",
      sessionToken: "ST-old",
      expirationMs: expiredMs,
    });
    const newExpSec = nowMs / 1000 + 3600;
    const fetchImpl = scriptedFetch([
      // GetId は呼ばれない (identityId が永続化されているため)
      credsResp("ap-northeast-1:id-cached", newExpSec),
    ]);
    // refreshMarginMs = 500_000 ms。expired なので再取得が走る。
    const provider = makeCognitoCredentialsProvider({
      getIdToken: async () => "T",
      fetchImpl,
      credentialsStore: store,
      now: () => nowMs,
      refreshMarginMs: 500_000,
    });
    const creds = await provider.getCredentials();
    // GetCredentialsForIdentity 1 回のみ (GetId は 0 回)
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(creds.sessionToken).toBe("ST");
    // 保存も行われる
    expect(store.saveAwsCredentials).toHaveBeenCalledTimes(1);
  });

  it("clearCache() は saveAwsCredentials(null) を呼び永続化を削除する", async () => {
    const store = makeStore({ identityId: "ap-northeast-1:id-1", accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST", expirationMs: Date.now() + 3600_000 });
    const fetchImpl = vi.fn();
    const provider = makeCognitoCredentialsProvider({
      getIdToken: async () => "T",
      fetchImpl,
      credentialsStore: store,
    });
    provider.clearCache();
    expect(store.saveAwsCredentials).toHaveBeenCalledWith(null);
  });

  it("credentialsStore 省略時は in-memory のみで動く (後方互換)", async () => {
    const expSec = Date.now() / 1000 + 3600;
    const fetchImpl = scriptedFetch([
      { status: 200, body: { IdentityId: "ap-northeast-1:id-1" } },
      credsResp("ap-northeast-1:id-1", expSec),
    ]);
    const provider = makeCognitoCredentialsProvider({
      getIdToken: async () => "T",
      fetchImpl,
      // credentialsStore は省略
    });
    const creds = await provider.getCredentials();
    expect(creds.identityId).toBe("ap-northeast-1:id-1");
    // 2 回目はキャッシュから (fetch なし)
    const second = await provider.getCredentials();
    expect(second).toBe(creds);
  });
});
