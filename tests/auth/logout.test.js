// Unit tests for logout(store) in src/auth.js
//
// logout は best-effort でサーバ側もクリーンにする:
//   ForgetDevice (deviceKey があれば) → RevokeToken → ローカル clear/clearPending。
// P2-2 以降 Cognito は素 fetch (cognito-http.js) なので、global.fetch を差し替えて観測する。
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import {
  fetchMock,
  installFetchMock,
  cognitoOk,
  cognitoCalls,
  cognitoOps,
} from "./cognito-fetch-mock.js";

installFetchMock();

import { logout, CONSUMER_CLIENT_ID } from "../../src/auth.js";

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function makeJwt(exp, extra = {}) {
  return `${b64url({ alg: "RS256" })}.${b64url({ exp, ...extra })}.sig`;
}
function makeStore(initial) {
  let state = initial ? { ...initial } : null;
  return {
    load: vi.fn(() => state),
    save: vi.fn((t) => { state = { ...t }; }),
    clear: vi.fn(() => { state = null; }),
    loadPending: vi.fn(() => null),
    savePending: vi.fn(),
    clearPending: vi.fn(),
    _peek: () => state,
  };
}

describe("logout", () => {
  beforeEach(() => { fetchMock.mockReset(); });
  afterAll(() => { vi.unstubAllGlobals(); });

  it("トークン未保存なら no-op (サーバ呼び出し無し) だがローカル clear は実行する", async () => {
    const store = makeStore(null);
    const r = await logout(store);
    expect(r).toEqual({ forgotDevice: false, revokedToken: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.clear).toHaveBeenCalledTimes(1);
    expect(store.clearPending).toHaveBeenCalledTimes(1);
  });

  it("deviceKey 有り + 有効 idToken なら ForgetDevice + RevokeToken を呼び、ローカルを消す", async () => {
    const now = Math.floor(Date.now() / 1000);
    const store = makeStore({
      idToken: makeJwt(now + 3600), // 有効なので getValidIdToken は refresh しない
      refreshToken: "rt", accessToken: "at", deviceKey: "dev-1",
      clientId: CONSUMER_CLIENT_ID,
    });
    fetchMock.mockResolvedValue(cognitoOk({}));

    const r = await logout(store);

    expect(cognitoOps()).toEqual(["ForgetDevice", "RevokeToken"]);
    const [forget, revoke] = cognitoCalls();
    expect(forget.input).toEqual({ AccessToken: "at", DeviceKey: "dev-1" });
    expect(revoke.input).toEqual({ Token: "rt", ClientId: CONSUMER_CLIENT_ID });
    expect(r).toEqual({ forgotDevice: true, revokedToken: true });
    expect(store.clear).toHaveBeenCalledTimes(1);
    expect(store._peek()).toBeNull();
  });

  it("deviceKey 無しなら ForgetDevice はスキップし RevokeToken のみ", async () => {
    const now = Math.floor(Date.now() / 1000);
    const store = makeStore({ idToken: makeJwt(now + 3600), refreshToken: "rt", clientId: CONSUMER_CLIENT_ID });
    fetchMock.mockResolvedValue(cognitoOk({}));

    const r = await logout(store);

    expect(cognitoOps()).toEqual(["RevokeToken"]);
    expect(r).toEqual({ forgotDevice: false, revokedToken: true });
    expect(store.clear).toHaveBeenCalledTimes(1);
  });

  it("ForgetDevice が失敗しても best-effort: RevokeToken は実行し、ローカルは必ず消す", async () => {
    const now = Math.floor(Date.now() / 1000);
    const store = makeStore({
      idToken: makeJwt(now + 3600), refreshToken: "rt", accessToken: "at", deviceKey: "dev-1",
      clientId: CONSUMER_CLIENT_ID,
    });
    fetchMock.mockImplementation((url, init) =>
      String(init.headers["X-Amz-Target"]).endsWith("ForgetDevice")
        ? Promise.reject(new Error("boom"))
        : Promise.resolve(cognitoOk({})),
    );

    const r = await logout(store);

    expect(r).toEqual({ forgotDevice: false, revokedToken: true });
    expect(cognitoOps()).toEqual(["ForgetDevice", "RevokeToken"]);
    expect(store.clear).toHaveBeenCalledTimes(1);
    expect(store._peek()).toBeNull();
  });

  it("clientId 欠落時は idToken の aud から復元して RevokeToken に渡す", async () => {
    const now = Math.floor(Date.now() / 1000);
    const store = makeStore({
      idToken: makeJwt(now + 3600, { aud: "aud-client-xyz" }),
      refreshToken: "rt", // clientId 未設定
    });
    fetchMock.mockResolvedValue(cognitoOk({}));

    await logout(store);

    expect(cognitoCalls()[0].input.ClientId).toBe("aud-client-xyz");
  });
});
