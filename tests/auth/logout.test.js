// Unit tests for logout(store) in src/auth.js
//
// logout は best-effort でサーバ側もクリーンにする:
//   ForgetDevice (deviceKey があれば) → RevokeToken → ローカル clear/clearPending。
// Cognito 呼び出しは getValidIdToken.test.js と同じ方式で send() を差し替えて観測する。
import { describe, it, expect, beforeEach, vi } from "vitest";

const sendMock = vi.fn();

vi.mock("@aws-sdk/client-cognito-identity-provider", () => {
  class CognitoIdentityProviderClient {
    send(...args) { return sendMock(...args); }
  }
  const cmd = (name) => class { constructor(input) { this.input = input; this.__name = name; } };
  return {
    CognitoIdentityProviderClient,
    InitiateAuthCommand: cmd("InitiateAuthCommand"),
    RespondToAuthChallengeCommand: cmd("RespondToAuthChallengeCommand"),
    SignUpCommand: cmd("SignUpCommand"),
    ConfirmDeviceCommand: cmd("ConfirmDeviceCommand"),
    UpdateDeviceStatusCommand: cmd("UpdateDeviceStatusCommand"),
    ForgetDeviceCommand: cmd("ForgetDeviceCommand"),
    RevokeTokenCommand: cmd("RevokeTokenCommand"),
  };
});

const { logout, CONSUMER_CLIENT_ID } = await import("../../src/auth.js");

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
const names = () => sendMock.mock.calls.map((c) => c[0].__name);

describe("logout", () => {
  beforeEach(() => { sendMock.mockReset(); });

  it("トークン未保存なら no-op (サーバ呼び出し無し) だがローカル clear は実行する", async () => {
    const store = makeStore(null);
    const r = await logout(store);
    expect(r).toEqual({ forgotDevice: false, revokedToken: false });
    expect(sendMock).not.toHaveBeenCalled();
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
    sendMock.mockResolvedValue({});

    const r = await logout(store);

    expect(names()).toEqual(["ForgetDeviceCommand", "RevokeTokenCommand"]);
    const forget = sendMock.mock.calls[0][0].input;
    expect(forget).toEqual({ AccessToken: "at", DeviceKey: "dev-1" });
    const revoke = sendMock.mock.calls[1][0].input;
    expect(revoke).toEqual({ Token: "rt", ClientId: CONSUMER_CLIENT_ID });
    expect(r).toEqual({ forgotDevice: true, revokedToken: true });
    expect(store.clear).toHaveBeenCalledTimes(1);
    expect(store._peek()).toBeNull();
  });

  it("deviceKey 無しなら ForgetDevice はスキップし RevokeToken のみ", async () => {
    const now = Math.floor(Date.now() / 1000);
    const store = makeStore({ idToken: makeJwt(now + 3600), refreshToken: "rt", clientId: CONSUMER_CLIENT_ID });
    sendMock.mockResolvedValue({});

    const r = await logout(store);

    expect(names()).toEqual(["RevokeTokenCommand"]);
    expect(r).toEqual({ forgotDevice: false, revokedToken: true });
    expect(store.clear).toHaveBeenCalledTimes(1);
  });

  it("ForgetDevice が失敗しても best-effort: RevokeToken は実行し、ローカルは必ず消す", async () => {
    const now = Math.floor(Date.now() / 1000);
    const store = makeStore({
      idToken: makeJwt(now + 3600), refreshToken: "rt", accessToken: "at", deviceKey: "dev-1",
      clientId: CONSUMER_CLIENT_ID,
    });
    sendMock.mockImplementation((cmd) =>
      cmd.__name === "ForgetDeviceCommand" ? Promise.reject(new Error("boom")) : Promise.resolve({}),
    );

    const r = await logout(store);

    expect(r).toEqual({ forgotDevice: false, revokedToken: true });
    expect(names()).toEqual(["ForgetDeviceCommand", "RevokeTokenCommand"]);
    expect(store.clear).toHaveBeenCalledTimes(1);
    expect(store._peek()).toBeNull();
  });

  it("clientId 欠落時は idToken の aud から復元して RevokeToken に渡す", async () => {
    const now = Math.floor(Date.now() / 1000);
    const store = makeStore({
      idToken: makeJwt(now + 3600, { aud: "aud-client-xyz" }),
      refreshToken: "rt", // clientId 未設定
    });
    sendMock.mockResolvedValue({});

    await logout(store);

    expect(sendMock.mock.calls[0][0].input.ClientId).toBe("aud-client-xyz");
  });
});
