// P2-7: SesameHub3.connect() が Hub3WsClient に渡す onTokenRefreshNeeded の方針テスト。
//
// 参照: references_web/src/api/useAuthState.js:50-60 (handleConnectionFailure →
// checkTokenExpiration) — WS 再接続リトライが閾値に達しても、token の exp が期限内なら
// refresh せず現 token を維持し backoff を継続する。期限切れの時だけ refresh する。
// (旧実装は marginSec:999999 で無条件 refresh しており、リトライのたびに不要な
//  Cognito 呼び出しが走っていた。)
//
// Strategy:
//   - vi.mock で transport.js の Hub3WsClient をコンストラクタ引数キャプチャ用の
//     fake に差し替え、connect() が渡した onTokenRefreshNeeded を直接呼んで観測する。
//   - Cognito refresh は素 fetch (cognito-http.js) なので global.fetch を stub して
//     「refresh が走ったか」を fetch 呼び出し回数で判定する。
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const captured = { cfg: null };

vi.mock("../../src/transport.js", async (importOriginal) => {
  /** @type {Record<string, unknown>} */
  const orig = await importOriginal();
  class FakeHub3WsClient {
    constructor(cfg) {
      captured.cfg = cfg;
      this.idToken = cfg.idToken;
    }
    async connect() {}
    close() {}
  }
  return { ...orig, Hub3WsClient: FakeHub3WsClient };
});

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const { SesameHub3 } = await import("../../src/client.js");
const { CONSUMER_CLIENT_ID } = await import("../../src/auth.js");

const CONFIRMED_DEVICE = {
  deviceKey: "dev-key-abc",
  deviceGroupKey: "dev-group-abc",
  devicePassword: "dev-password-abc",
};

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function makeJwt(exp, extra = {}) {
  return `${b64url({ alg: "RS256" })}.${b64url({ aud: CONSUMER_CLIENT_ID, sub: "sub-1", exp, ...extra })}.sig`;
}
function cognitoOk(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}
function cognitoError(name, message) {
  return { ok: false, status: 400, text: async () => JSON.stringify({ __type: `x#${name}`, message }) };
}

function makeTokenStore(initialTokens) {
  let state = { ...initialTokens };
  return {
    load: vi.fn(() => ({ ...state })),
    save: vi.fn((t) => { state = { ...t }; }),
    clear: vi.fn(() => { state = null; }),
    loadPending: vi.fn(() => null),
    savePending: vi.fn(),
    clearPending: vi.fn(),
    _peek: () => state,
  };
}

const CONFIG = { wsUrl: "wss://example.invalid/ws", companyID: "co-1" };

async function connectedRefreshCb(tokenStore) {
  const hub = new SesameHub3({ config: CONFIG, tokenStore });
  await hub.connect();
  expect(captured.cfg).not.toBeNull();
  return captured.cfg.onTokenRefreshNeeded;
}

describe("onTokenRefreshNeeded (P2-7 refresh 方針)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    captured.cfg = null;
    vi.useRealTimers();
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("exp が期限内 (margin 120s 超の余裕) なら refresh せず現 token を返す", async () => {
    const now = Math.floor(Date.now() / 1000);
    const idToken = makeJwt(now + 3600);
    const tokenStore = makeTokenStore({
      idToken, refreshToken: "rt", clientId: CONSUMER_CLIENT_ID, ...CONFIRMED_DEVICE,
    });

    const cb = await connectedRefreshCb(tokenStore);
    const got = await cb(idToken);

    // 同一 token が返る → transport 側は差し替えず backoff 継続 (useAuthState.js:52-55 と同方針)
    expect(got).toBe(idToken);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exp が期限切れなら REFRESH_TOKEN_AUTH で refresh して新 token を返す", async () => {
    vi.useFakeTimers();
    const fixed = 1_700_000_000;
    vi.setSystemTime(fixed * 1000);

    const expired = makeJwt(fixed + 3600);
    const tokenStore = makeTokenStore({
      idToken: expired, refreshToken: "rt", clientId: CONSUMER_CLIENT_ID, ...CONFIRMED_DEVICE,
    });

    const cb = await connectedRefreshCb(tokenStore);

    // 接続後に時間が進み token が失効したケース
    vi.setSystemTime((fixed + 7200) * 1000);
    const fresh = makeJwt(fixed + 7200 + 3600);
    fetchMock.mockResolvedValueOnce(cognitoOk({ AuthenticationResult: { IdToken: fresh } }));

    const got = await cb(expired);

    expect(got).toBe(fresh);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers["X-Amz-Target"]).toBe("AWSCognitoIdentityProviderService.InitiateAuth");
    expect(JSON.parse(init.body).AuthFlow).toBe("REFRESH_TOKEN_AUTH");
  });

  it("refresh が NotAuthorized で失敗したら null を返す (transport は backoff 継続)", async () => {
    vi.useFakeTimers();
    const fixed = 1_700_000_000;
    vi.setSystemTime(fixed * 1000);

    const expired = makeJwt(fixed + 3600);
    const tokenStore = makeTokenStore({
      idToken: expired, refreshToken: "rt-dead", clientId: CONSUMER_CLIENT_ID, ...CONFIRMED_DEVICE,
    });

    const cb = await connectedRefreshCb(tokenStore);

    vi.setSystemTime((fixed + 7200) * 1000);
    fetchMock.mockResolvedValueOnce(cognitoError("NotAuthorizedException", "Refresh Token has been revoked"));

    const got = await cb(expired);
    expect(got).toBeNull();
  });
});
