// src/cognito-http.js (P2-2: Cognito SDK の生 HTTP 化) のユニットテスト。
//
// 検証点:
//   - リクエスト形: POST https://cognito-idp.<region>.amazonaws.com/ +
//     Content-Type: application/x-amz-json-1.1 + X-Amz-Target:
//     AWSCognitoIdentityProviderService.<Op> (AWS JSON 1.1 ワイヤ形)
//   - エラー互換: 応答 body の __type ("#" 付き形式含む) が Error.name に写像され、
//     既存の `err.name === "NotAuthorizedException"` ハンドラが無変更で動くこと。
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  fetchMock,
  installFetchMock,
  cognitoOk,
  cognitoError,
} from "./cognito-fetch-mock.js";

installFetchMock();

import { cognitoCall } from "../../src/cognito-http.js";

describe("cognitoCall", () => {
  beforeEach(() => { fetchMock.mockReset(); });
  afterAll(() => { vi.unstubAllGlobals(); });

  it("AWS JSON 1.1 のワイヤ形で POST する (URL / Content-Type / X-Amz-Target / body)", async () => {
    fetchMock.mockResolvedValueOnce(cognitoOk({ ChallengeName: "CUSTOM_CHALLENGE" }));

    await cognitoCall("InitiateAuth", {
      AuthFlow: "CUSTOM_AUTH",
      ClientId: "client-1",
      AuthParameters: { USERNAME: "a@example.com" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://cognito-idp.ap-northeast-1.amazonaws.com/");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/x-amz-json-1.1");
    expect(init.headers["X-Amz-Target"]).toBe("AWSCognitoIdentityProviderService.InitiateAuth");
    expect(JSON.parse(init.body)).toEqual({
      AuthFlow: "CUSTOM_AUTH",
      ClientId: "client-1",
      AuthParameters: { USERNAME: "a@example.com" },
    });
  });

  it("region オプションで URL のリージョンを差し替えられる", async () => {
    fetchMock.mockResolvedValueOnce(cognitoOk({}));
    await cognitoCall("SignUp", {}, { region: "us-east-1" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://cognito-idp.us-east-1.amazonaws.com/");
  });

  it("2xx 応答の JSON body をそのまま返す", async () => {
    const body = {
      ChallengeName: "CUSTOM_CHALLENGE",
      Session: "sess-1",
      ChallengeParameters: { USERNAME: "u" },
    };
    fetchMock.mockResolvedValueOnce(cognitoOk(body));
    await expect(cognitoCall("InitiateAuth", {})).resolves.toEqual(body);
  });

  it("空 body の 2xx (ForgetDevice 等) は {} を返す", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => "" });
    await expect(cognitoCall("ForgetDevice", {})).resolves.toEqual({});
  });

  it('エラー __type の "#" 付き形式 (com.amazonaws...#NotAuthorizedException) を err.name に写像する', async () => {
    fetchMock.mockResolvedValueOnce(cognitoError("NotAuthorizedException", "Refresh Token has been revoked", { hashPrefix: true }));

    const err = await cognitoCall("InitiateAuth", {}).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("NotAuthorizedException"); // 既存ハンドラの `err.name === ...` 互換
    expect(err.message).toBe("Refresh Token has been revoked");
  });

  it('エラー __type の素形式 ("NotAuthorizedException") も err.name に写像する', async () => {
    fetchMock.mockResolvedValueOnce(cognitoError("UsernameExistsException", "User already exists", { hashPrefix: false }));

    const err = await cognitoCall("SignUp", {}).catch((e) => e);
    expect(err.name).toBe("UsernameExistsException");
    expect(err.message).toBe("User already exists");
  });

  it('"Message" (大文字 M) キーのエラーメッセージも拾う', async () => {
    // maxRetries:0 — このテストはエラーハンドリング (メッセージキー) を検証する。
    // リトライは retry-timeout.test.js で行う。
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ __type: "x#SomeException", Message: "capital M" }),
    });
    const err = await cognitoCall("InitiateAuth", {}, { maxRetries: 0 }).catch((e) => e);
    expect(err.name).toBe("SomeException");
    expect(err.message).toBe("capital M");
  });

  it("__type 無しのエラー応答は name=CognitoHttpError + HTTP status 入りメッセージ", async () => {
    // maxRetries:0 — このテストはリトライ動作ではなくエラーハンドリングを検証する。
    // 5xx がリトライ対象であっても、リトライは cognito-http のリトライ専用テストで検証する。
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => "{}" });
    const err = await cognitoCall("InitiateAuth", {}, { maxRetries: 0 }).catch((e) => e);
    expect(err.name).toBe("CognitoHttpError");
    expect(err.message).toMatch(/InitiateAuth failed: HTTP 500/);
  });

  it("非 JSON のエラー body でも crash せず CognitoHttpError を投げる", async () => {
    // maxRetries:0 — このテストはリトライ動作ではなくエラーハンドリングを検証する。
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, text: async () => "<html>Bad Gateway</html>" });
    const err = await cognitoCall("RevokeToken", {}, { maxRetries: 0 }).catch((e) => e);
    expect(err.name).toBe("CognitoHttpError");
    expect(err.message).toMatch(/HTTP 502/);
  });

  it("ネットワークエラー (fetch reject) はそのまま伝播する", async () => {
    // maxRetries:0 — 「ネットワークエラーが最終的に伝播する」を単一試行で検証する。
    // リトライ後の伝播はリトライ専用テストで確認する。
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(cognitoCall("InitiateAuth", {}, { maxRetries: 0 })).rejects.toThrow(/fetch failed/);
  });
});
