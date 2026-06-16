// packages/core/tests/_spec/auth-c2.test.js
//
// Spec AUTH-0038 〜 AUTH-0055 (18件) 統合テスト。
// A/B 両実装を統合し、各 spec につき最も移植元忠実な実装を採用。
// タイトル先頭に [<ID>] を付与 (TDD 規約)。
// 実装との不一致は spec どおりの期待値で red になってよい。
//
// fetch は cognito-fetch-mock.js で差し替える (P2-2 方式)。
// TokenStore は in-memory モック。JWT は本物の base64url payload で組む。

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  fetchMock,
  installFetchMock,
  cognitoOk,
  cognitoError,
  cognitoCalls,
  cognitoOps,
} from "../auth/cognito-fetch-mock.js";

installFetchMock();

vi.setConfig({ testTimeout: 20000 });

import {
  getValidIdToken,
  logout,
  loginVerify,
  CONSUMER_CLIENT_ID,
} from "../../src/auth.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

/** base64url encode (padding なし) */
function b64url(obj) {
  return Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * aud=CONSUMER_CLIENT_ID の最小 JWT を生成する。
 * @param {number} exp UNIX 秒
 * @param {object} [extra] payload に追加する claim
 */
function makeJwt(exp, extra = {}) {
  const header  = b64url({ alg: "RS256", typ: "JWT" });
  const payload = b64url({ aud: CONSUMER_CLIENT_ID, exp, ...extra });
  return `${header}.${payload}.sigsig`;
}

/**
 * aud を明示指定した JWT (non-consumer clientId テスト用)
 */
function makeJwtWithAud(exp, aud, extra = {}) {
  const header  = b64url({ alg: "RS256", typ: "JWT" });
  const payload = b64url({ aud, exp, ...extra });
  return `${header}.${payload}.sigsig`;
}

const CONFIRMED_DEVICE = {
  deviceKey:      "dev-key-abc",
  deviceGroupKey: "dev-group-abc",
  devicePassword: "dev-password-abc",
};

/**
 * in-memory TokenStore モック。
 * initial が渡された場合は CONFIRMED_DEVICE をデフォルトにマージする。
 * withDevice=false のとき CONFIRMED_DEVICE をマージしない。
 */
function makeStore(initial, { withDevice = true } = {}) {
  const base = withDevice ? { ...CONFIRMED_DEVICE } : {};
  let state = initial ? { ...base, ...initial } : null;
  return {
    load:         vi.fn(() => (state ? { ...state } : null)),
    save:         vi.fn((t) => { state = { ...t }; }),
    clear:        vi.fn(() => { state = null; }),
    loadPending:  vi.fn(() => null),
    savePending:  vi.fn(),
    clearPending: vi.fn(),
    _peek: () => state,
  };
}

/**
 * CONFIRMED_DEVICE なしの最小ストア (deviceKey=null)
 */
function makeDevicelessStore(extra = {}) {
  let state = {
    deviceKey:      null,
    deviceGroupKey: null,
    devicePassword: null,
    ...extra,
  };
  return {
    load:         vi.fn(() => state ? { ...state } : null),
    save:         vi.fn((t) => { state = { ...t }; }),
    clear:        vi.fn(() => { state = null; }),
    loadPending:  vi.fn(() => null),
    savePending:  vi.fn(),
    clearPending: vi.fn(),
    _peek: () => state,
  };
}

/**
 * in-memory TokenStore モック (loginVerify 用)。pending もサポート。
 */
function makeLoginVerifyStore({ tokens = null, pending = null } = {}) {
  let t = tokens ? { ...tokens } : null;
  let p = pending ? { ...pending } : null;
  return {
    load:         vi.fn(() => (t ? { ...t } : null)),
    save:         vi.fn((next) => { t = { ...next }; }),
    clear:        vi.fn(() => { t = null; }),
    loadPending:  vi.fn(() => (p ? { ...p } : null)),
    savePending:  vi.fn((next) => { p = { ...next }; }),
    clearPending: vi.fn(() => { p = null; }),
    _peek: () => t,
    _peekPending: () => p,
  };
}

// ─── setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  fetchMock.mockReset();
  vi.useRealTimers();
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0038: 早期 return (fresh token)
// ═════════════════════════════════════════════════════════════════════════════

describe("AUTH-0038: getValidIdToken — fresh-token early return", () => {

  it("[AUTH-0038] getValidIdToken fresh-token early return: exp - now > marginSec=120 なら refresh せずそのまま返す (AWSMobileClient REFRESH_THRESHOLD_DEFAULT=120*1000ms)", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    // exp - now = 121 > 120 → fresh → early return
    const idToken = makeJwt(now + 121);
    const store = makeStore({ idToken, refreshToken: "rt", clientId: CONSUMER_CLIENT_ID });

    const result = await getValidIdToken(store);

    expect(result).toBe(idToken);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });

  it("[AUTH-0038] getValidIdToken: 残り 3600 秒 (十分余裕あり) でも refresh しない", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const idToken = makeJwt(now + 3600);
    const store = makeStore({ idToken, refreshToken: "rt", clientId: CONSUMER_CLIENT_ID });

    const result = await getValidIdToken(store);

    expect(result).toBe(idToken);
    expect(fetchMock).not.toHaveBeenCalled();
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0039: early refresh 閾値境界
// ═════════════════════════════════════════════════════════════════════════════

describe("AUTH-0039: getValidIdToken — early refresh 閾値境界", () => {

  it("[AUTH-0039] getValidIdToken: exp - now = marginSec (=120) なら REFRESH_TOKEN_AUTH を 1 回起動する (境界: > でなく = はリフレッシュ対象)", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    // exp - now = 120 → 120 > 120 は false → refresh 起動
    const oldToken = makeJwt(now + 120);
    const newToken = makeJwt(now + 3600);
    const store = makeStore({ idToken: oldToken, refreshToken: "rt", clientId: CONSUMER_CLIENT_ID });

    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: { IdToken: newToken },
    }));

    const result = await getValidIdToken(store);

    expect(result).toBe(newToken);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cognitoOps()).toEqual(["InitiateAuth"]);
  });

  it("[AUTH-0039] getValidIdToken: marginSec 引数上書き: exp - now <= 引数値 なら refresh する", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    // exp - now = 299, marginSec=300 → 299 > 300 は false → refresh 起動
    const oldToken = makeJwt(now + 299);
    const newToken = makeJwt(now + 3600);
    const store = makeStore({ idToken: oldToken, refreshToken: "rt", clientId: CONSUMER_CLIENT_ID });

    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: { IdToken: newToken },
    }));

    const result = await getValidIdToken(store, { marginSec: 300 });

    expect(result).toBe(newToken);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("[AUTH-0039] getValidIdToken: marginSec 引数上書き: exp - now > 引数値 なら refresh しない", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    // exp - now = 301, marginSec=300 → 301 > 300 は true → no refresh
    const idToken = makeJwt(now + 301);
    const store = makeStore({ idToken, refreshToken: "rt", clientId: CONSUMER_CLIENT_ID });

    const result = await getValidIdToken(store, { marginSec: 300 });

    expect(result).toBe(idToken);
    expect(fetchMock).not.toHaveBeenCalled();
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0040: REFRESH_TOKEN_AUTH のワイヤ形
// ═════════════════════════════════════════════════════════════════════════════

describe("AUTH-0040: getValidIdToken — REFRESH_TOKEN_AUTH ワイヤ形", () => {

  it("[AUTH-0040] REFRESH_TOKEN_AUTH InitiateAuth ワイヤ形: AuthFlow='REFRESH_TOKEN_AUTH' / ClientId=CONSUMER_CLIENT_ID / AuthParameters.REFRESH_TOKEN が正しい", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const store = makeStore({
      idToken:      makeJwt(now - 1),
      refreshToken: "rt-test-0040",
      clientId:     CONSUMER_CLIENT_ID,
    });
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: { IdToken: makeJwt(now + 3600) },
    }));

    await getValidIdToken(store);

    const [call] = cognitoCalls();
    expect(call.input.AuthFlow).toBe("REFRESH_TOKEN_AUTH");
    expect(call.input.ClientId).toBe(CONSUMER_CLIENT_ID);
    expect(call.input.AuthParameters.REFRESH_TOKEN).toBe("rt-test-0040");
  });

  it("[AUTH-0040] REFRESH_TOKEN_AUTH: X-Amz-Target=AWSCognitoIdentityProviderService.InitiateAuth / Content-Type=application/x-amz-json-1.1 (AWS JSON 1.1 ワイヤ形)", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const store = makeStore({
      idToken:      makeJwt(now - 1),
      refreshToken: "rt",
      clientId:     CONSUMER_CLIENT_ID,
    });
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: { IdToken: makeJwt(now + 3600) },
    }));

    await getValidIdToken(store);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://cognito-idp.ap-northeast-1.amazonaws.com/");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/x-amz-json-1.1");
    expect(init.headers["X-Amz-Target"]).toBe("AWSCognitoIdentityProviderService.InitiateAuth");
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0041: REFRESH の DEVICE_KEY 条件付与
// ═════════════════════════════════════════════════════════════════════════════

describe("AUTH-0041: getValidIdToken — DEVICE_KEY 条件付与", () => {

  it("[AUTH-0041] REFRESH: deviceKey が存在する場合 AuthParameters.DEVICE_KEY を付与する (CognitoUser.java:3554-3565)", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    // makeStore(withDevice=true) → CONFIRMED_DEVICE がマージされる
    const store = makeStore({
      idToken:      makeJwt(now - 1),
      refreshToken: "rt",
      clientId:     CONSUMER_CLIENT_ID,
    });
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: { IdToken: makeJwt(now + 3600) },
    }));

    await getValidIdToken(store);

    const call = cognitoCalls()[0];
    expect(call.input.AuthParameters.DEVICE_KEY).toBe(CONFIRMED_DEVICE.deviceKey);
    expect(call.input.AuthParameters.REFRESH_TOKEN).toBe("rt");
  });

  it("[AUTH-0041] REFRESH: deviceKey が存在しない場合 AuthParameters.DEVICE_KEY を省略する (device-less token, CognitoUser.java:3554-3564)", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const store = makeDevicelessStore({
      idToken:      makeJwt(now - 1),
      refreshToken: "rt",
      clientId:     CONSUMER_CLIENT_ID,
    });
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: { IdToken: makeJwt(now + 3600) },
    }));

    await getValidIdToken(store);

    const call = cognitoCalls()[0];
    expect(call.input.AuthParameters.DEVICE_KEY).toBeUndefined();
    expect(call.input.AuthParameters.REFRESH_TOKEN).toBe("rt");
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0042: refresh 後 token 取り込み
// ═════════════════════════════════════════════════════════════════════════════

describe("AUTH-0042: getValidIdToken — refresh 後 token 取り込み", () => {

  it("[AUTH-0042] refresh 後: IdToken を新 idToken に採り AccessToken があれば更新する", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const store = makeStore({
      idToken:      makeJwt(now - 1),
      refreshToken: "rt-old",
      accessToken:  "at-old",
      clientId:     CONSUMER_CLIENT_ID,
    });
    const newToken = makeJwt(now + 3600);
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: {
        IdToken:     newToken,
        AccessToken: "at-new",
      },
    }));

    const result = await getValidIdToken(store);

    expect(result).toBe(newToken);
    expect(store._peek().idToken).toBe(newToken);
    expect(store._peek().accessToken).toBe("at-new");
  });

  it("[AUTH-0042] refresh rotation: 応答に RefreshToken があれば取り込む (意図的逸脱: 参照 SDK CognitoUser.java:2873-2874 は旧 token 維持だが rotation 前方互換)", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const store = makeStore({
      idToken:      makeJwt(now - 1),
      refreshToken: "rt-old",
      clientId:     CONSUMER_CLIENT_ID,
    });
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: {
        IdToken:      makeJwt(now + 3600),
        RefreshToken: "rt-rotated",
      },
    }));

    await getValidIdToken(store);

    expect(store._peek().refreshToken).toBe("rt-rotated");
  });

  it("[AUTH-0042] refresh rotation 無し: 応答に RefreshToken が無ければ旧 refreshToken を維持する (CognitoUser.java:2873-2874)", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const store = makeStore({
      idToken:      makeJwt(now - 1),
      refreshToken: "rt-keep",
      clientId:     CONSUMER_CLIENT_ID,
    });
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: { IdToken: makeJwt(now + 3600) },
    }));

    await getValidIdToken(store);

    expect(store._peek().refreshToken).toBe("rt-keep");
  });

  it("[AUTH-0042] refresh 後: lastRefresh を now の ISO 文字列で更新する", async () => {
    const fixedMs = Date.UTC(2026, 5, 10, 9, 0, 0); // 2026-06-10T09:00:00.000Z
    vi.useFakeTimers();
    vi.setSystemTime(fixedMs);

    const now = Math.floor(fixedMs / 1000);
    const store = makeStore({
      idToken:      makeJwt(now - 1),
      refreshToken: "rt",
      clientId:     CONSUMER_CLIENT_ID,
    });
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: { IdToken: makeJwt(now + 3600) },
    }));

    await getValidIdToken(store);

    expect(store._peek().lastRefresh).toBe("2026-06-10T09:00:00.000Z");
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0043: refresh 応答に IdToken 無し → UNAUTHENTICATED
// ═════════════════════════════════════════════════════════════════════════════

describe("AUTH-0043: getValidIdToken — refresh 応答の IdToken 欠落", () => {

  it("[AUTH-0043] refresh 応答に AuthenticationResult.IdToken が欠落する場合 ERR.UNAUTHENTICATED の SesameError を投げる (auth.js:276-279)", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const store = makeStore({
      idToken:      makeJwt(now - 1),
      refreshToken: "rt",
      clientId:     CONSUMER_CLIENT_ID,
    });
    // IdToken なし (AccessToken のみ)
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: { AccessToken: "at-only" },
    }));

    const err = await getValidIdToken(store).catch((e) => e);
    expect(err.code).toBe("unauthenticated");
    expect(err.message).toMatch(/no IdToken/i);
    // save は呼ばれない
    expect(store.save).not.toHaveBeenCalled();
  });

  it("[AUTH-0043] refresh 応答に AuthenticationResult 自体が無い場合も UNAUTHENTICATED を throw する", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const store = makeStore({
      idToken:      makeJwt(now - 1),
      refreshToken: "rt",
      clientId:     CONSUMER_CLIENT_ID,
    });
    fetchMock.mockResolvedValueOnce(cognitoOk({ ChallengeName: "SOMETHING" }));

    const err = await getValidIdToken(store).catch((e) => e);
    expect(err.code).toBe("unauthenticated");
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0044: NotAuthorized/UserNotFound → clearCachedTokens 相当
// ═════════════════════════════════════════════════════════════════════════════

describe("AUTH-0044: getValidIdToken — NotAuthorized/UserNotFound エラー処理", () => {

  it("[AUTH-0044] refresh NotAuthorizedException: token 3 点 + lastRefresh を null 化し clientId/username/device 3 点を温存して save する (CognitoUser.java:1306-1311 / :2703-2720)", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const store = makeStore({
      idToken:      makeJwt(now - 1),
      refreshToken: "rt-bad",
      accessToken:  "at-bad",
      lastRefresh:  "2026-01-01T00:00:00.000Z",
      clientId:     CONSUMER_CLIENT_ID,
      username:     "user@example.com",
    });
    fetchMock.mockResolvedValueOnce(cognitoError("NotAuthorizedException", "Refresh Token has been revoked"));

    await expect(getValidIdToken(store)).rejects.toThrow(/Refresh Token has been revoked/);

    // store.clear() は呼ばない (device 温存のため)
    expect(store.clear).not.toHaveBeenCalled();
    // store.save() でトークン 3 点 + lastRefresh が null になる
    expect(store.save).toHaveBeenCalledTimes(1);
    // clearPending しない (pending verify 状態は壊さない)
    expect(store.clearPending).not.toHaveBeenCalled();

    const saved = store._peek();
    // token 3 点 + lastRefresh は null
    expect(saved.idToken).toBeNull();
    expect(saved.accessToken).toBeNull();
    expect(saved.refreshToken).toBeNull();
    expect(saved.lastRefresh).toBeNull();
    // device 3 点は温存
    expect(saved.deviceKey).toBe(CONFIRMED_DEVICE.deviceKey);
    expect(saved.deviceGroupKey).toBe(CONFIRMED_DEVICE.deviceGroupKey);
    expect(saved.devicePassword).toBe(CONFIRMED_DEVICE.devicePassword);
    // username + clientId も温存
    expect(saved.username).toBe("user@example.com");
    expect(saved.clientId).toBe(CONSUMER_CLIENT_ID);
  });

  it("[AUTH-0044] refresh UserNotFoundException: 同様に token 3 点破棄 + device 温存 (CognitoUser.java:1309-1311)", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const store = makeStore({
      idToken:      makeJwt(now - 1),
      refreshToken: "rt",
      clientId:     CONSUMER_CLIENT_ID,
      username:     "ghost@example.com",
    });
    fetchMock.mockResolvedValueOnce(cognitoError("UserNotFoundException", "User does not exist."));

    await expect(getValidIdToken(store)).rejects.toThrow(/User does not exist/);

    expect(store.clear).not.toHaveBeenCalled();
    expect(store.save).toHaveBeenCalledTimes(1);

    const saved = store._peek();
    expect(saved.idToken).toBeNull();
    expect(saved.refreshToken).toBeNull();
    // device 3 点は温存
    expect(saved.deviceKey).toBe(CONFIRMED_DEVICE.deviceKey);
    expect(saved.deviceGroupKey).toBe(CONFIRMED_DEVICE.deviceGroupKey);
    expect(saved.devicePassword).toBe(CONFIRMED_DEVICE.devicePassword);
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0045: その他例外は再 throw (token を破棄しない)
// ═════════════════════════════════════════════════════════════════════════════

describe("AUTH-0045: getValidIdToken — 非認証エラーは再 throw", () => {

  it("[AUTH-0045] refresh: NotAuthorized/UserNotFound 以外の例外 (InternalErrorException 等) は token を破棄せずそのまま再 throw する (CognitoUser.java:1306-1313)", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const store = makeStore({
      idToken:      makeJwt(now - 1),
      refreshToken: "rt",
      clientId:     CONSUMER_CLIENT_ID,
    });
    fetchMock.mockResolvedValueOnce(cognitoError("InternalErrorException", "server error", { status: 500 }));

    const err = await getValidIdToken(store).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    // token は破棄しない
    expect(store.clear).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
    expect(store._peek().refreshToken).toBe("rt");
  });

  it("[AUTH-0045] refresh: ThrottlingException でも store を変更しない", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const store = makeStore({
      idToken:      makeJwt(now - 1),
      refreshToken: "rt",
      clientId:     CONSUMER_CLIENT_ID,
    });
    fetchMock.mockResolvedValueOnce(cognitoError("ThrottlingException", "Too many requests"));

    await expect(getValidIdToken(store)).rejects.toThrow(/Too many requests/);
    expect(store.save).not.toHaveBeenCalled();
    expect(store.clear).not.toHaveBeenCalled();
  });

  it("[AUTH-0045] refresh: ネットワーク例外 (TypeError) も token を破棄せず再 throw する", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const store = makeStore({
      idToken:      makeJwt(now - 1),
      refreshToken: "rt",
      clientId:     CONSUMER_CLIENT_ID,
    });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));

    const err = await getValidIdToken(store).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(store.save).not.toHaveBeenCalled();
    expect(store.clear).not.toHaveBeenCalled();
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0046: token 不在 → UNAUTHENTICATED
// ═════════════════════════════════════════════════════════════════════════════

describe("AUTH-0046: getValidIdToken — token 不在エラー", () => {

  it("[AUTH-0046] store.load() が null なら ERR.UNAUTHENTICATED を throw し refresh を起動しない (auth.noTokens, auth.js:208-210)", async () => {
    const store = makeStore(null);

    const err = await getValidIdToken(store).catch((e) => e);
    expect(err.code).toBe("unauthenticated");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("[AUTH-0046] refreshToken が存在しない場合 ERR.UNAUTHENTICATED を throw し refresh を起動しない (auth.noRefreshToken, auth.js:220-223)", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    // idToken が expired かつ refreshToken なし
    const store = makeDevicelessStore({
      idToken:      makeJwt(now - 10),
      refreshToken: null,
      clientId:     CONSUMER_CLIENT_ID,
    });

    const err = await getValidIdToken(store).catch((e) => e);
    expect(err.code).toBe("unauthenticated");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("[AUTH-0046] idToken が存在せず refreshToken も無い場合 (auth.noTokens / noRefreshToken どちらか) UNAUTHENTICATED で落ちる", async () => {
    const store = makeStore({
      idToken:      null,
      refreshToken: null,
      clientId:     CONSUMER_CLIENT_ID,
    }, { withDevice: false });

    const err = await getValidIdToken(store).catch((e) => e);
    expect(err.code).toBe("unauthenticated");
    expect(fetchMock).not.toHaveBeenCalled();
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0047: app-login token のみ許容
// ═════════════════════════════════════════════════════════════════════════════

describe("AUTH-0047: getValidIdToken — app-login token guard", () => {

  it("[AUTH-0047] idToken の aud が CONSUMER_CLIENT_ID 以外 (biz/web token 等) なら UNAUTHENTICATED で拒否する (auth.js:182-184)", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const store = makeDevicelessStore({
      idToken:      makeJwtWithAud(now + 3600, "biz-client-id-xyz"),
      refreshToken: "rt",
      clientId:     CONSUMER_CLIENT_ID,
    });

    const err = await getValidIdToken(store).catch((e) => e);
    expect(err.code).toBe("unauthenticated");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("[AUTH-0047] clientId が CONSUMER_CLIENT_ID 以外なら UNAUTHENTICATED で拒否する (auth.js:186-188)", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const store = makeDevicelessStore({
      idToken:      makeJwt(now + 3600),
      refreshToken: "rt",
      clientId:     "non-consumer-client",
    });

    const err = await getValidIdToken(store).catch((e) => e);
    expect(err.code).toBe("unauthenticated");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("[AUTH-0047] deviceKey が存在するが deviceGroupKey が欠ける不整合 token は UNAUTHENTICATED で拒否する (auth.js:192-194)", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const store = makeStore({
      idToken:        makeJwt(now + 3600),
      refreshToken:   "rt",
      clientId:       CONSUMER_CLIENT_ID,
      deviceKey:      "dev-key",
      deviceGroupKey: null,
      devicePassword: "dev-pw",
    }, { withDevice: false });

    const err = await getValidIdToken(store).catch((e) => e);
    expect(err.code).toBe("unauthenticated");
    expect(err.message).toMatch(/has a deviceKey but is missing/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("[AUTH-0047] deviceKey 無し (NewDeviceMetadata==null Pool) は device 無しトークンとして合法に通す (P3-16, CognitoUser.java:3130-3138)", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const idToken = makeJwt(now + 3600);
    const store = makeDevicelessStore({
      idToken,
      refreshToken: "rt",
      clientId:     CONSUMER_CLIENT_ID,
    });

    const result = await getValidIdToken(store);
    expect(result).toBe(idToken);
    expect(fetchMock).not.toHaveBeenCalled();
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0048: application 層リトライ無効化 (maxRetries:0)
// ═════════════════════════════════════════════════════════════════════════════

describe("AUTH-0048: getValidIdToken — application 層リトライ無効化", () => {

  it("[AUTH-0048] getValidIdToken は cognitoCall を maxRetries:0 で呼ぶ — fake timer 下でも deadlock しない (auth.js:232-238)", async () => {
    // maxRetries:0 を確認するために 500 エラーを 1 回返す。
    // maxRetries > 0 なら setTimeout が fake timer 下で止まり test が deadlock する。
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const store = makeStore({
      idToken:      makeJwt(now - 1),
      refreshToken: "rt",
      clientId:     CONSUMER_CLIENT_ID,
    });

    // 500 エラーを 1 回だけ用意。maxRetries > 0 なら再試行でもう 1 回 fetch が呼ばれる。
    fetchMock.mockResolvedValueOnce(cognitoError("InternalErrorException", "boom", { status: 500 }));

    await expect(getValidIdToken(store)).rejects.toThrow();

    // maxRetries:0 なら fetch は 1 回だけ呼ばれる
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("[AUTH-0048] fake timer 下でも deadlock せず 1 回試行で完結する (成功ケース)", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const store = makeStore({
      idToken:      makeJwt(now - 1),
      refreshToken: "rt",
      clientId:     CONSUMER_CLIENT_ID,
    });

    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: { IdToken: makeJwt(now + 3600) },
    }));

    // fake timers 下で setTimeout が進まなくてもリトライしないため完結できる
    const result = await getValidIdToken(store);
    expect(result).toBeTypeOf("string");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0049: Consumer Client 以外を入口で拒否する
// ═════════════════════════════════════════════════════════════════════════════

describe("AUTH-0049: app-login token guard — Consumer Client 以外を拒否", () => {

  it("[AUTH-0049] app-login token guard: idToken の aud が CONSUMER_CLIENT_ID(6ialca0p8u0lsgvbmvsljfm305) でない場合 UNAUTHENTICATED で拒否し再ログインを促す (biz/web token 弾き規範)", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const store = makeDevicelessStore({
      idToken:      makeJwtWithAud(now + 3600, "web-client-id-000"),
      refreshToken: "rt",
    });

    const err = await getValidIdToken(store).catch((e) => e);
    expect(err.code).toBe("unauthenticated");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("[AUTH-0049] app-login token guard: clientId が CONSUMER_CLIENT_ID でない場合 UNAUTHENTICATED で拒否する (auth.js:315-318 loginInitiate 相当)", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const store = makeDevicelessStore({
      idToken:      makeJwt(now + 3600),
      refreshToken: "rt",
      clientId:     "other-client-id",
    });

    const err = await getValidIdToken(store).catch((e) => e);
    expect(err.code).toBe("unauthenticated");
  });

  it("[AUTH-0049] app-login token guard: aud 欠落 (aud claim が無い) + clientId=CONSUMER_CLIENT_ID は通る (aud なしは非ブロック)", async () => {
    // aud が null/undefined: jwtAud → null → aud !== CONSUMER_CLIENT_ID 判定をスキップ
    // clientId=CONSUMER_CLIENT_ID なので resolvedClientId チェックも通る
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const header  = b64url({ alg: "RS256", typ: "JWT" });
    const payload = b64url({ exp: now + 3600, sub: "user-uuid" }); // aud なし
    const idToken = `${header}.${payload}.sig`;

    const store = makeDevicelessStore({
      idToken,
      refreshToken: "rt",
      clientId:     CONSUMER_CLIENT_ID,
    });

    const got = await getValidIdToken(store);
    expect(got).toBe(idToken);
    expect(fetchMock).not.toHaveBeenCalled();
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0050: device 不整合トークンを拒否する
// ═════════════════════════════════════════════════════════════════════════════

describe("AUTH-0050: app-login token guard — deviceKey 有り + device 3 点不整合", () => {

  it("[AUTH-0050] app-login token guard: deviceKey があるのに deviceGroupKey が欠ける不整合 token は UNAUTHENTICATED で拒否する (auth.js:189-194, CognitoUser.java:3130-3138)", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const store = makeStore({
      idToken:        makeJwt(now + 3600),
      refreshToken:   "rt",
      clientId:       CONSUMER_CLIENT_ID,
      deviceKey:      "dev-key",
      deviceGroupKey: null,   // 欠ける
      devicePassword: "dev-pw",
    }, { withDevice: false });

    const err = await getValidIdToken(store).catch((e) => e);
    expect(err.code).toBe("unauthenticated");
    expect(err.message).toMatch(/has a deviceKey but is missing/);
  });

  it("[AUTH-0050] app-login token guard: deviceKey があるのに devicePassword が欠ける不整合 token は UNAUTHENTICATED で拒否する", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const store = makeStore({
      idToken:        makeJwt(now + 3600),
      refreshToken:   "rt",
      clientId:       CONSUMER_CLIENT_ID,
      deviceKey:      "dev-key",
      deviceGroupKey: "dev-group",
      devicePassword: null,   // 欠ける
    }, { withDevice: false });

    const err = await getValidIdToken(store).catch((e) => e);
    expect(err.code).toBe("unauthenticated");
  });

  it("[AUTH-0050] app-login token guard: deviceKey 無し (トラッキング無効 Pool) は device 無しトークンとして合法に通す (P3-16)", async () => {
    const now = 1_700_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);

    const idToken = makeJwt(now + 3600);
    const store = makeDevicelessStore({
      idToken,
      refreshToken: "rt",
      clientId:     CONSUMER_CLIENT_ID,
    });

    const result = await getValidIdToken(store);
    expect(result).toBe(idToken);
    // 拒否されない (UNAUTHENTICATED を throw しない)
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0051: logout は ForgetDevice + RevokeToken を送り GlobalSignOut を送らない
// ═════════════════════════════════════════════════════════════════════════════

describe("AUTH-0051: logout — ForgetDevice + RevokeToken (GlobalSignOut なし)", () => {

  it("[AUTH-0051] logout: ForgetDevice(AccessToken,DeviceKey) と RevokeToken(Token,ClientId) を送り GlobalSignOut を一切送らない (このデバイス/セッション限定の意図的強化, auth.js:875-910)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const store = makeStore({
      idToken:      makeJwt(now + 3600),
      refreshToken: "rt-0051",
      accessToken:  "at-0051",
      clientId:     CONSUMER_CLIENT_ID,
      // CONFIRMED_DEVICE が withDevice=true でマージ済み
    });

    fetchMock.mockResolvedValue(cognitoOk({}));

    const result = await logout(store);

    const ops = cognitoOps();
    // GlobalSignOut は呼ばれない
    expect(ops).not.toContain("GlobalSignOut");
    // ForgetDevice + RevokeToken は呼ばれる
    expect(ops).toContain("ForgetDevice");
    expect(ops).toContain("RevokeToken");

    const calls = cognitoCalls();
    const forgetCall = calls.find((c) => c.op === "ForgetDevice");
    const revokeCall = calls.find((c) => c.op === "RevokeToken");

    // ForgetDevice: AccessToken + DeviceKey
    expect(forgetCall.input.DeviceKey).toBe(CONFIRMED_DEVICE.deviceKey);
    expect(forgetCall.input.AccessToken).toBe("at-0051");
    // RevokeToken: refreshToken + ClientId
    expect(revokeCall.input.Token).toBe("rt-0051");
    expect(revokeCall.input.ClientId).toBe(CONSUMER_CLIENT_ID);

    expect(result.forgotDevice).toBe(true);
    expect(result.revokedToken).toBe(true);

    expect(store.clear).toHaveBeenCalledTimes(1);
    expect(store._peek()).toBeNull();
  });

  it("[AUTH-0051] logout: ForgetDevice の body は {AccessToken, DeviceKey}、RevokeToken は {Token, ClientId}", async () => {
    const now = Math.floor(Date.now() / 1000);
    const store = makeStore({
      idToken:      makeJwt(now + 3600),
      accessToken:  "at-local",
      refreshToken: "rt-local",
      clientId:     CONSUMER_CLIENT_ID,
    });

    fetchMock.mockResolvedValue(cognitoOk({}));

    await logout(store);

    const calls = cognitoCalls();
    const forget = calls.find((c) => c.op === "ForgetDevice");
    const revoke  = calls.find((c) => c.op === "RevokeToken");

    expect(forget).toBeDefined();
    expect(forget.input.DeviceKey).toBe(CONFIRMED_DEVICE.deviceKey);
    expect(forget.input.AccessToken).toBeTypeOf("string");

    expect(revoke).toBeDefined();
    expect(revoke.input.Token).toBe("rt-local");
    expect(revoke.input.ClientId).toBe(CONSUMER_CLIENT_ID);
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0052: deviceKey 無しなら ForgetDevice をスキップし RevokeToken のみ送る
// ═════════════════════════════════════════════════════════════════════════════

describe("AUTH-0052: logout — deviceKey 無しなら ForgetDevice スキップ", () => {

  it("[AUTH-0052] logout: deviceKey 無しなら ForgetDevice をスキップし RevokeToken のみ送る (auth.js:882-905)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const store = makeDevicelessStore({
      idToken:      makeJwt(now + 3600),
      refreshToken: "rt",
      clientId:     CONSUMER_CLIENT_ID,
    });

    fetchMock.mockResolvedValue(cognitoOk({}));

    const result = await logout(store);

    const ops = cognitoOps();
    expect(ops).not.toContain("ForgetDevice");
    expect(ops).toContain("RevokeToken");
    expect(result.forgotDevice).toBe(false);
    expect(result.revokedToken).toBe(true);
  });

  it("[AUTH-0052] logout: device 無し token でもローカル clear は必ず実行する", async () => {
    const now = Math.floor(Date.now() / 1000);
    const store = makeDevicelessStore({
      idToken:      makeJwt(now + 3600),
      refreshToken: "rt",
      clientId:     CONSUMER_CLIENT_ID,
    });

    fetchMock.mockResolvedValue(cognitoOk({}));

    await logout(store);

    expect(store.clear).toHaveBeenCalledTimes(1);
    expect(store._peek()).toBeNull();
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0053: best-effort + ローカル clear 必ず実行
// ═════════════════════════════════════════════════════════════════════════════

describe("AUTH-0053: logout — best-effort & ローカル clear 保証", () => {

  it("[AUTH-0053] logout: ForgetDevice が失敗しても RevokeToken + ローカル clear を実行する (best-effort, auth.js:875-909)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const store = makeStore({
      idToken:      makeJwt(now + 3600),
      refreshToken: "rt",
      accessToken:  "at",
      clientId:     CONSUMER_CLIENT_ID,
    });

    fetchMock.mockImplementation((_url, init) => {
      const target = String(init?.headers?.["X-Amz-Target"] || "");
      if (target.endsWith("ForgetDevice")) return Promise.reject(new Error("network error"));
      return Promise.resolve(cognitoOk({}));
    });

    const result = await logout(store);

    expect(result.forgotDevice).toBe(false);
    expect(result.revokedToken).toBe(true);
    expect(store.clear).toHaveBeenCalledTimes(1);
    expect(store._peek()).toBeNull();
  });

  it("[AUTH-0053] logout: RevokeToken が失敗してもローカル clear は必ず実行する (best-effort)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const store = makeDevicelessStore({
      idToken:      makeJwt(now + 3600),
      refreshToken: "rt",
      clientId:     CONSUMER_CLIENT_ID,
    });

    fetchMock.mockRejectedValue(new Error("network error"));

    const result = await logout(store);

    expect(result.revokedToken).toBe(false);
    expect(store.clear).toHaveBeenCalledTimes(1);
  });

  it("[AUTH-0053] logout: token 未保存ならサーバ呼び出し無しでローカル clear のみ行う", async () => {
    const store = makeStore(null);

    const result = await logout(store);

    expect(result).toEqual({ forgotDevice: false, revokedToken: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.clear).toHaveBeenCalledTimes(1);
    expect(store.clearPending).toHaveBeenCalledTimes(1);
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0054: logout の clientId 復元
// ═════════════════════════════════════════════════════════════════════════════

describe("AUTH-0054: logout — clientId 欠落時 idToken.aud から復元", () => {

  it("[AUTH-0054] logout: store.clientId が欠落していても idToken の aud から clientId を復元して RevokeToken に渡す (auth.js:879 / auth.js:128-134)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const audClientId = "aud-recovered-client-0054";
    const header  = b64url({ alg: "RS256" });
    const payload = b64url({ aud: audClientId, exp: now + 3600 });
    const idToken = `${header}.${payload}.sig`;

    const store = makeStore({
      idToken,
      refreshToken: "rt",
      // clientId は設定しない
    }, { withDevice: false });

    fetchMock.mockResolvedValue(cognitoOk({}));

    await logout(store);

    const revokeCall = cognitoCalls().find((c) => c.op === "RevokeToken");
    expect(revokeCall).toBeDefined();
    expect(revokeCall.input.ClientId).toBe(audClientId);
  });

  it("[AUTH-0054] logout: store.clientId も aud も無ければ DEFAULT_CLIENT_ID (= CONSUMER_CLIENT_ID) を RevokeToken に渡す", async () => {
    const now = Math.floor(Date.now() / 1000);
    // aud フィールドが無い JWT
    const header  = b64url({ alg: "RS256" });
    const payload = b64url({ exp: now + 3600 }); // aud なし
    const noAudToken = `${header}.${payload}.sig`;

    const store = makeStore({
      idToken:      noAudToken,
      refreshToken: "rt",
      // clientId も無し
    }, { withDevice: false });

    fetchMock.mockResolvedValue(cognitoOk({}));

    await logout(store);

    const revokeCall = cognitoCalls().find((c) => c.op === "RevokeToken");
    expect(revokeCall).toBeDefined();
    expect(revokeCall.input.ClientId).toBe(CONSUMER_CLIENT_ID);
  });

});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH-0055: loginVerify 後の nickname 自動設定 (GetUser→UpdateUserAttributes)
// ═════════════════════════════════════════════════════════════════════════════

describe("AUTH-0055: loginVerify 後の nickname 自動設定 (setNicknameIfNeeded)", () => {

  const EMAIL_0055       = "nick-test@example.com";
  const LOCAL_PART_0055  = "nick-test"; // EMAIL_0055 の "@" 前

  const PENDING_0055 = {
    clientId:    CONSUMER_CLIENT_ID,
    username:    EMAIL_0055,
    session:     "sess-0055",
    initiatedAt: "2026-06-01T00:00:00.000Z",
  };

  it("[AUTH-0055] GetUser({AccessToken}) → nickname 空 + email 非空 → UpdateUserAttributes({AccessToken, UserAttributes:[{Name:'nickname',Value:email の@前}]}) を送る (LoginVerifiCodeFG.kt:112-150 / CognitoUser.java:1491-1492 / :2228-2230)", async () => {
    const store = makeLoginVerifyStore({ pending: PENDING_0055 });

    fetchMock.mockReset();
    // 1. RespondToAuthChallenge (CUSTOM_CHALLENGE 回答) → AuthenticationResult
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: {
        IdToken:      makeJwt(9999999999),
        AccessToken:  "at-0055",
        RefreshToken: "rt-0055",
      },
    }));
    // 2. GetUser → nickname 空
    fetchMock.mockResolvedValueOnce(cognitoOk({
      UserAttributes: [
        { Name: "email",    Value: EMAIL_0055 },
        { Name: "nickname", Value: "" },
      ],
    }));
    // 3. UpdateUserAttributes
    fetchMock.mockResolvedValueOnce(cognitoOk({}));

    const tokens = await loginVerify(store, "123456");

    expect(tokens.idToken).toBeTypeOf("string");

    const ops = cognitoOps();
    expect(ops).toContain("RespondToAuthChallenge");
    expect(ops).toContain("GetUser");
    expect(ops).toContain("UpdateUserAttributes");

    const calls = cognitoCalls();

    // GetUser: AccessToken のみ (CognitoUser.java:1491-1492)
    const getUserCall = calls.find((c) => c.op === "GetUser");
    expect(getUserCall).toBeDefined();
    expect(getUserCall.input).toEqual({ AccessToken: "at-0055" });

    // UpdateUserAttributes: AccessToken + UserAttributes=[{Name:nickname, Value:local}]
    const updateCall = calls.find((c) => c.op === "UpdateUserAttributes");
    expect(updateCall).toBeDefined();
    expect(updateCall.input).toEqual({
      AccessToken:    "at-0055",
      UserAttributes: [{ Name: "nickname", Value: LOCAL_PART_0055 }],
    });
  });

  it("[AUTH-0055] nickname が既に設定されている場合は UpdateUserAttributes を発行しない", async () => {
    const store = makeLoginVerifyStore({ pending: PENDING_0055 });

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: {
        IdToken:      makeJwt(9999999999),
        AccessToken:  "at-0055b",
        RefreshToken: "rt",
      },
    }));
    fetchMock.mockResolvedValueOnce(cognitoOk({
      UserAttributes: [
        { Name: "email",    Value: EMAIL_0055 },
        { Name: "nickname", Value: "already-set" },
      ],
    }));

    const tokens = await loginVerify(store, "123456");

    expect(tokens.idToken).toBeTypeOf("string");
    expect(cognitoOps()).toContain("GetUser");
    expect(cognitoOps()).not.toContain("UpdateUserAttributes");
  });

  it("[AUTH-0055] email が空の場合は UpdateUserAttributes を発行しない (local part が取れない)", async () => {
    const pendingNoEmail = { ...PENDING_0055, username: "" };
    const store = makeLoginVerifyStore({ pending: pendingNoEmail });

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: {
        IdToken:      makeJwt(9999999999),
        AccessToken:  "at-0055c",
        RefreshToken: "rt",
      },
    }));
    fetchMock.mockResolvedValueOnce(cognitoOk({
      UserAttributes: [
        { Name: "email",    Value: "" },
        { Name: "nickname", Value: "" },
      ],
    }));

    const tokens = await loginVerify(store, "123456");
    expect(tokens.idToken).toBeTypeOf("string");
    expect(cognitoOps()).not.toContain("UpdateUserAttributes");
  });

  it("[AUTH-0055] GetUser が失敗しても loginVerify は成功を返す (best-effort: LoginVerifiCodeFG.kt:121-123 catch→続行)", async () => {
    const store = makeLoginVerifyStore({ pending: PENDING_0055 });

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: {
        IdToken:      makeJwt(9999999999),
        AccessToken:  "at-0055d",
        RefreshToken: "rt",
      },
    }));
    // GetUser がエラーを返す
    fetchMock.mockResolvedValueOnce(cognitoError("InternalErrorException", "GetUser failed", { status: 500 }));

    // loginVerify は throw しない
    const tokens = await loginVerify(store, "123456");
    expect(tokens.idToken).toBeTypeOf("string");
    expect(cognitoOps()).not.toContain("UpdateUserAttributes");
  });

  it("[AUTH-0055] UpdateUserAttributes が失敗しても loginVerify は成功を返す (best-effort)", async () => {
    const store = makeLoginVerifyStore({ pending: PENDING_0055 });

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: {
        IdToken:      makeJwt(9999999999),
        AccessToken:  "at-0055e",
        RefreshToken: "rt",
      },
    }));
    fetchMock.mockResolvedValueOnce(cognitoOk({
      UserAttributes: [
        { Name: "email",    Value: EMAIL_0055 },
        { Name: "nickname", Value: "" },
      ],
    }));
    // UpdateUserAttributes がエラーを返す
    fetchMock.mockResolvedValueOnce(cognitoError("NotAuthorizedException", "unauthorized"));

    const tokens = await loginVerify(store, "123456");
    expect(tokens.idToken).toBeTypeOf("string");
    // UpdateUserAttributes は呼ばれている (失敗したが loginVerify は成功)
    expect(cognitoOps()).toContain("UpdateUserAttributes");
  });

});
