// P2-8: loginVerify 後の nickname 自動設定 (アプリ挙動の移植)。
//
// 参照: LoginVerifiCodeFG.kt:74-76, 112-150
//   confirmSignIn 成功後に updateNickNameIfNeeded() を呼ぶ。
//   - getUserAttributes() → nickname 空かつ email 非空 → updateUserAttributes({nickname: email local part})
//   - 失敗しても loginVerify 成功扱い (catch → 続行)
//
// ワイヤ形モック導出:
//   GetUser request:  {AccessToken}
//   GetUser response: {UserAttributes: [{Name:"nickname",Value:""}, {Name:"email",Value:"user@example.com"}]}
//     → _aws_sdk_ref/CognitoUser.java:1491-1492 (getUserDetailsInternal: setAccessToken)
//        _aws_sdk_ref/CognitoUser.java:1495 (userResult.getUserAttributes() = [{Name,Value},...])
//   UpdateUserAttributes request: {AccessToken, UserAttributes:[{Name:"nickname",Value:"user"}]}
//     → _aws_sdk_ref/CognitoUser.java:2228-2230 (updateAttributesInternal: setAccessToken/setUserAttributes)
//
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  fetchMock,
  installFetchMock,
  cognitoOk,
  cognitoError,
  cognitoCalls,
  cognitoOps,
} from "./cognito-fetch-mock.js";

installFetchMock();

vi.setConfig({ testTimeout: 20000 });

import { loginVerify, CONSUMER_CLIENT_ID } from "../../src/auth.js";

const EMAIL = "user@example.com";
const LOCAL_PART = "user"; // EMAIL の "@" より前

const PENDING = {
  clientId: CONSUMER_CLIENT_ID,
  username: EMAIL,
  session: "sess-1",
  initiatedAt: "2026-06-01T00:00:00.000Z",
};

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function makeJwt(exp = 9999999999, extra = {}) {
  return `${b64url({ alg: "RS256" })}.${b64url({ aud: CONSUMER_CLIENT_ID, exp, ...extra })}.sig`;
}

function makeStore({ tokens = null, pending = null } = {}) {
  let t = tokens ? { ...tokens } : null;
  let p = pending ? { ...pending } : null;
  return {
    load: vi.fn(() => (t ? { ...t } : null)),
    save: vi.fn((next) => { t = { ...next }; }),
    clear: vi.fn(() => { t = null; }),
    loadPending: vi.fn(() => (p ? { ...p } : null)),
    savePending: vi.fn((next) => { p = { ...next }; }),
    clearPending: vi.fn(() => { p = null; }),
    _peek: () => t,
    _peekPending: () => p,
  };
}

// GetUser 応答モック。
// ワイヤ形導出: _aws_sdk_ref/CognitoUser.java:1495 — userResult.getUserAttributes() は
//   List<AttributeType> = [{Name, Value}, ...]。AWS JSON 1.1 は UserAttributes フィールドに直列化。
function getUserOk({ nickname = "", email = EMAIL } = {}) {
  return cognitoOk({
    UserAttributes: [
      { Name: "email", Value: email },
      { Name: "nickname", Value: nickname },
    ],
  });
}

beforeEach(() => { fetchMock.mockReset(); });
afterAll(() => { vi.unstubAllGlobals(); });

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOM_CHALLENGE 認証成功後の nickname 自動設定
// ─────────────────────────────────────────────────────────────────────────────
describe("P2-8: nickname 自動設定 (loginVerify 後)", () => {
  it("GetUser で nickname が空 → UpdateUserAttributes を発行し email local part を設定する", async () => {
    fetchMock
      // 1. RespondToAuthChallenge (CUSTOM_CHALLENGE 回答) → AuthenticationResult
      .mockResolvedValueOnce(cognitoOk({
        AuthenticationResult: {
          IdToken: makeJwt(),
          AccessToken: "at-new",
          RefreshToken: "rt-new",
        },
      }))
      // 2. GetUser (nickname 空)
      // モック導出: _aws_sdk_ref/CognitoUser.java:1495 getUserAttributes() → [{Name,Value}]
      .mockResolvedValueOnce(getUserOk({ nickname: "" }))
      // 3. UpdateUserAttributes
      // モック導出: _aws_sdk_ref/CognitoUser.java:2228-2230 updateAttributesInternal
      .mockResolvedValueOnce(cognitoOk({}));

    const store = makeStore({ pending: PENDING });
    const tokens = await loginVerify(store, "123456");

    // ログイン自体は成功
    expect(tokens.idToken).toBeTypeOf("string");

    // GetUser → UpdateUserAttributes の順で呼ばれること
    expect(cognitoOps()).toEqual([
      "RespondToAuthChallenge",
      "GetUser",
      "UpdateUserAttributes",
    ]);

    // GetUser リクエスト: AccessToken のみ
    // 参照: _aws_sdk_ref/CognitoUser.java:1491-1492
    const getUser = cognitoCalls()[1];
    expect(getUser.op).toBe("GetUser");
    expect(getUser.input).toEqual({ AccessToken: "at-new" });

    // UpdateUserAttributes リクエスト: AccessToken + UserAttributes [{Name:"nickname", Value:<local>}]
    // 参照: _aws_sdk_ref/CognitoUser.java:2228-2230
    const update = cognitoCalls()[2];
    expect(update.op).toBe("UpdateUserAttributes");
    expect(update.input).toEqual({
      AccessToken: "at-new",
      UserAttributes: [{ Name: "nickname", Value: LOCAL_PART }],
    });
  });

  it("GetUser で nickname が既に設定されている → UpdateUserAttributes を発行しない", async () => {
    fetchMock
      // 1. RespondToAuthChallenge → AuthenticationResult
      .mockResolvedValueOnce(cognitoOk({
        AuthenticationResult: {
          IdToken: makeJwt(),
          AccessToken: "at-new",
          RefreshToken: "rt-new",
        },
      }))
      // 2. GetUser (nickname 設定済み)
      // モック導出: _aws_sdk_ref/CognitoUser.java:1495 getUserAttributes()
      .mockResolvedValueOnce(getUserOk({ nickname: "existing-nick" }));

    const store = makeStore({ pending: PENDING });
    const tokens = await loginVerify(store, "123456");

    // ログイン成功
    expect(tokens.idToken).toBeTypeOf("string");

    // GetUser のみ呼ばれ、UpdateUserAttributes は呼ばれないこと
    expect(cognitoOps()).toEqual([
      "RespondToAuthChallenge",
      "GetUser",
    ]);
    expect(cognitoOps()).not.toContain("UpdateUserAttributes");
  });

  it("GetUser が失敗しても loginVerify は成功を返す (best-effort: LoginVerifiCodeFG.kt:121-123 の catch→続行)", async () => {
    fetchMock
      // 1. RespondToAuthChallenge → AuthenticationResult
      .mockResolvedValueOnce(cognitoOk({
        AuthenticationResult: {
          IdToken: makeJwt(),
          AccessToken: "at-new",
          RefreshToken: "rt-new",
        },
      }))
      // 2. GetUser → エラー (ネットワーク断・サーバエラー等)
      .mockResolvedValueOnce(cognitoError("InternalErrorException", "server error", { status: 500 }));

    const store = makeStore({ pending: PENDING });
    // loginVerify はエラーを throw しないこと
    const tokens = await loginVerify(store, "123456");

    expect(tokens.idToken).toBeTypeOf("string");
    // UpdateUserAttributes は呼ばれていない (GetUser で止まった)
    expect(cognitoOps()).toEqual([
      "RespondToAuthChallenge",
      "GetUser",
    ]);
    expect(cognitoOps()).not.toContain("UpdateUserAttributes");
  });

  it("UpdateUserAttributes が失敗しても loginVerify は成功を返す (best-effort)", async () => {
    fetchMock
      .mockResolvedValueOnce(cognitoOk({
        AuthenticationResult: {
          IdToken: makeJwt(),
          AccessToken: "at-new",
          RefreshToken: "rt-new",
        },
      }))
      .mockResolvedValueOnce(getUserOk({ nickname: "" }))
      // UpdateUserAttributes → エラー
      .mockResolvedValueOnce(cognitoError("NotAuthorizedException", "unauthorized"));

    const store = makeStore({ pending: PENDING });
    const tokens = await loginVerify(store, "123456");

    expect(tokens.idToken).toBeTypeOf("string");
    expect(cognitoOps()).toEqual([
      "RespondToAuthChallenge",
      "GetUser",
      "UpdateUserAttributes",
    ]);
  });
});
