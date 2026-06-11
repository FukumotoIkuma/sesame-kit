// JWT decoder ユニットテスト
//
// 対象は src/auth.js 内の 3 関数 (密結合, 同じ base64url payload decode 路):
//   - jwtSub  (export 済)
//   - jwtAud  (内部 helper)  → export 関数 `bootstrap` の app-client guard 経由で挙動を検証
//   - jwtExp  (内部 helper)  → export 関数 `getValidIdToken` 経由で挙動を検証
//
// jwtAud/jwtExp は module-private のため、観測点を「これらを使う公開関数」に置き換えて
// 黒箱で振る舞いを検証する。3 関数の本体は同一構造 (split('.')[1] → Buffer.from(base64) →
// JSON.parse → claim || fallback、catch で fallback) なので、共通の failure path
// (segment 数不足、空文字、invalid base64, malformed JSON, claim 欠落) は jwtSub の
// 直接テストで網羅し、aud/exp 側は claim 抽出と fallback default だけ確認する。
//
// P2-2 以降 Cognito は素 fetch (src/cognito-http.js)。global.fetch を差し替え、
// InitiateAuth (X-Amz-Target) が呼ばれたかどうかで「refresh が走ったか = idToken が
// expired と判定されたか」を観測する。
//
// NOTE: jwtAud / jwtExp は module-private のため直接 import は不可能。
// テスト名で「(via bootstrap)」「(via getValidIdToken)」と明示する。

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchMock, installFetchMock, cognitoOk } from "./cognito-fetch-mock.js";

installFetchMock();

import { jwtSub, bootstrap, getValidIdToken, CONSUMER_CLIENT_ID } from "../../src/auth.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

const CONFIRMED_DEVICE = {
  deviceKey: "dev-key-abc",
  deviceGroupKey: "dev-group-abc",
  devicePassword: "dev-password-abc",
};

/** RFC 7515 base64url (padding 除去, '+/' → '-_'). Buffer.from(..., 'base64') は
 *  base64url も受け付けるので padding さえ落とせば decode 側は何もしなくて OK. */
function b64urlEncode(str) {
  return Buffer.from(str, "utf8")
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/** header.payload.signature 形式の "見た目だけ" JWT を作る。署名検証はしないので適当でよい. */
function makeJwt(payloadObj, { header = { alg: "none", typ: "JWT" } } = {}) {
  const h = b64urlEncode(JSON.stringify(header));
  const p = b64urlEncode(JSON.stringify(payloadObj));
  return `${h}.${p}.sig`;
}

/** in-memory token store。auth.js が要求する {load, save, loadPending, savePending,
 *  clearPending, clear} を満たす最小実装. */
function makeMemStore(initial = null) {
  let t = initial ? { ...CONFIRMED_DEVICE, ...initial } : null;
  let pending = null;
  return {
    load: () => (t ? { ...t } : null),
    save: vi.fn((next) => {
      t = { ...next };
    }),
    clear: () => {
      t = null;
    },
    loadPending: () => pending,
    savePending: (p) => {
      pending = p;
    },
    clearPending: () => {
      pending = null;
    },
    /** test 観測用 */
    _peek: () => t,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.useRealTimers();
});

// ═════════════════════════════════════════════════════════════════════════════
// jwtSub  (直接 export されているので素直に呼ぶ)
// ═════════════════════════════════════════════════════════════════════════════
describe("jwtSub", () => {
  it("正常な JWT から sub (UUID) を抽出する", () => {
    const uuid = "8b8e2a3f-0f4f-4d3e-9a3a-1234567890ab";
    const token = makeJwt({ sub: uuid, aud: "client", exp: 9999999999 });
    expect(jwtSub(token)).toBe(uuid);
  });

  it("payload に sub claim が無い場合は null を返す (|| null fallback)", () => {
    const token = makeJwt({ aud: "client", exp: 9999999999 });
    expect(jwtSub(token)).toBeNull();
  });

  it("payload.sub が空文字なら null を返す (falsy → || null)", () => {
    const token = makeJwt({ sub: "" });
    expect(jwtSub(token)).toBeNull();
  });

  it("token が segment 1 つだけ (ドット無し) なら null", () => {
    // split('.')[1] === undefined → Buffer.from(undefined, 'base64') が throw → catch → null
    expect(jwtSub("not-a-jwt")).toBeNull();
  });

  it("token が空文字なら null", () => {
    expect(jwtSub("")).toBeNull();
  });

  it("token が undefined なら null (token.split で TypeError → catch)", () => {
    expect(jwtSub(undefined)).toBeNull();
  });

  it("token が null なら null (token.split で TypeError → catch)", () => {
    expect(jwtSub(null)).toBeNull();
  });

  it("payload 部が JSON として不正なら null (JSON.parse SyntaxError → catch)", () => {
    // header.payload.sig だが payload は valid base64 だが JSON で無い
    const garbage = Buffer.from("not json at all", "utf8").toString("base64").replace(/=+$/, "");
    const token = `aaa.${garbage}.sig`;
    expect(jwtSub(token)).toBeNull();
  });

  it("payload 部が空文字でも crash せず null を返す", () => {
    // split('.')[1] === '' → Buffer.from('', 'base64') === '' → JSON.parse('') throw → catch
    expect(jwtSub("header..sig")).toBeNull();
  });

  it("base64url の非標準文字 ('-' / '_') を含む payload を decode できる", () => {
    // sub に長い文字列を入れて + / が出るような payload を作って - _ 化
    const sub = "ZZ??>>aa::あいうえお漢字混じり"; // multibyte 入りで '/' '+' が出やすい
    const token = makeJwt({ sub });
    expect(jwtSub(token)).toBe(sub);
  });

  it("3 segment 目 (signature) が無くても payload さえ valid なら sub を返す", () => {
    // 関数は split('.')[1] しか見ないので signature 欠落でも OK
    const uuid = "deadbeef-1234-5678-9abc-def012345678";
    const payload = b64urlEncode(JSON.stringify({ sub: uuid }));
    expect(jwtSub(`hdr.${payload}`)).toBe(uuid);
  });

  it("複数回呼んでも副作用が無い (idempotent)", () => {
    const token = makeJwt({ sub: "same" });
    expect(jwtSub(token)).toBe("same");
    expect(jwtSub(token)).toBe("same");
    expect(jwtSub(token)).toBe("same");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// jwtAud  (bootstrap 経由で観測)
//
// bootstrap は旧 localStorage dump の安全でない直接注入を塞ぐ互換口。idToken の aud が
// Consumer Client で、かつ ConfirmDevice 済み device credentials が揃う場合だけ保存する。
// ═════════════════════════════════════════════════════════════════════════════
describe("jwtAud (via bootstrap)", () => {
  it("Consumer Client + ConfirmDevice 済み token set だけを保存する", () => {
    const store = makeMemStore();
    bootstrap(store, {
      idToken: makeJwt({ aud: CONSUMER_CLIENT_ID, sub: "u", exp: 9 }),
      refreshToken: "rt",
      ...CONFIRMED_DEVICE,
    });
    expect(store._peek()).toMatchObject({
      clientId: CONSUMER_CLIENT_ID,
      ...CONFIRMED_DEVICE,
    });
  });

  it("biz client aud は保存せず拒否する", () => {
    const store = makeMemStore();
    expect(() => bootstrap(store, {
      idToken: makeJwt({ aud: "21u50hboia4s5q0sbk6pbdfmss", sub: "u", exp: 9 }),
      refreshToken: "rt",
      ...CONFIRMED_DEVICE,
    })).toThrow(/non-consumer Cognito client|consumer app client/);
    expect(store._peek()).toBeNull();
  });

  it("aud claim 無しは保存せず拒否する", () => {
    const store = makeMemStore();
    expect(() => bootstrap(store, {
      idToken: makeJwt({ sub: "u", exp: 9 }), // aud なし
      refreshToken: "rt",
      ...CONFIRMED_DEVICE,
    })).toThrow(/consumer app client/);
    expect(store._peek()).toBeNull();
  });

  it("aud が空文字なら保存せず拒否する", () => {
    const store = makeMemStore();
    expect(() => bootstrap(store, {
      idToken: makeJwt({ aud: "", sub: "u" }),
      refreshToken: "rt",
      ...CONFIRMED_DEVICE,
    })).toThrow(/consumer app client/);
    expect(store._peek()).toBeNull();
  });

  it("idToken が malformed (ドット無し) なら保存せず拒否する", () => {
    const store = makeMemStore();
    expect(() => bootstrap(store, {
      idToken: "totally-not-a-jwt",
      refreshToken: "rt",
      ...CONFIRMED_DEVICE,
    })).toThrow(/consumer app client/);
    expect(store._peek()).toBeNull();
  });

  it("payload が valid base64 だが invalid JSON なら保存せず拒否する", () => {
    const store = makeMemStore();
    const garbage = Buffer.from("xxx", "utf8").toString("base64").replace(/=+$/, "");
    expect(() => bootstrap(store, {
      idToken: `hdr.${garbage}.sig`,
      refreshToken: "rt",
      ...CONFIRMED_DEVICE,
    })).toThrow(/consumer app client/);
    expect(store._peek()).toBeNull();
  });

  it("ConfirmDevice 済み device credentials が揃わなければ保存せず拒否する", () => {
    const store = makeMemStore();
    expect(() => bootstrap(store, {
      idToken: makeJwt({ aud: CONSUMER_CLIENT_ID, sub: "u", exp: 9 }),
      refreshToken: "rt",
      deviceKey: "dev-key-only",
    })).toThrow(/missing confirmed Cognito device credentials/);
    expect(store._peek()).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// jwtExp  (getValidIdToken 経由で観測)
//
// getValidIdToken(store, {marginSec}) のロジック:
//   - exp - now > marginSec  → そのまま return  (refresh しない = fetchMock 呼ばれない)
//   - それ以外               → refresh 試行       (fetchMock 呼ばれる)
// jwtExp が壊れる入力では戻り値 0 となり、0 - now < margin で必ず refresh path に入る。
// ═════════════════════════════════════════════════════════════════════════════
describe("jwtExp (via getValidIdToken)", () => {
  // 共通の fake refresh 結果 (refresh 経路に入ったか観測したいだけ)
  function setRefreshSuccess(newIdToken = "new-id-token") {
    fetchMock.mockResolvedValueOnce(cognitoOk({
      AuthenticationResult: { IdToken: newIdToken },
    }));
  }

  it("exp が十分先 (now+1h) なら refresh せずそのまま返す", async () => {
    // 固定時刻にしないと now が動いて flaky になる
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    const now = Math.floor(Date.now() / 1000);
    const idToken = makeJwt({ sub: "u", exp: now + 3600 });
    const store = makeMemStore({ idToken, refreshToken: "rt" });

    const out = await getValidIdToken(store);
    expect(out).toBe(idToken);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exp が既定 margin (120s) ぎりぎりなら refresh が走る", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    const now = Math.floor(Date.now() / 1000);
    const idToken = makeJwt({ sub: "u", exp: now + 30 }); // margin 120 以下
    const store = makeMemStore({ idToken, refreshToken: "rt" });

    setRefreshSuccess("refreshed");
    const out = await getValidIdToken(store);
    expect(out).toBe("refreshed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("exp が過去 (期限切れ) なら refresh が走る", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    const now = Math.floor(Date.now() / 1000);
    const idToken = makeJwt({ sub: "u", exp: now - 1 });
    const store = makeMemStore({ idToken, refreshToken: "rt" });

    setRefreshSuccess("refreshed-expired");
    const out = await getValidIdToken(store);
    expect(out).toBe("refreshed-expired");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("idToken に exp claim が無い → jwtExp が 0 → 必ず refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    const idToken = makeJwt({ sub: "u" }); // exp 無し
    const store = makeMemStore({ idToken, refreshToken: "rt" });

    setRefreshSuccess("refreshed-no-exp");
    const out = await getValidIdToken(store);
    expect(out).toBe("refreshed-no-exp");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("idToken が malformed → jwtExp が catch → 0 → 必ず refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    const store = makeMemStore({ idToken: "bogus-token", refreshToken: "rt" });

    setRefreshSuccess("refreshed-bogus");
    const out = await getValidIdToken(store);
    expect(out).toBe("refreshed-bogus");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("marginSec を明示的に 0 にすると exp が 1 秒先でも refresh しない", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    const now = Math.floor(Date.now() / 1000);
    const idToken = makeJwt({ sub: "u", exp: now + 1 });
    const store = makeMemStore({ idToken, refreshToken: "rt" });

    const out = await getValidIdToken(store, { marginSec: 0 });
    expect(out).toBe(idToken);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marginSec を大きく (=3600) すると 30 分先 exp でも refresh が走る", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    const now = Math.floor(Date.now() / 1000);
    const idToken = makeJwt({ sub: "u", exp: now + 1800 });
    const store = makeMemStore({ idToken, refreshToken: "rt" });

    setRefreshSuccess("refreshed-large-margin");
    const out = await getValidIdToken(store, { marginSec: 3600 });
    expect(out).toBe("refreshed-large-margin");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("時刻が進んで exp を跨ぐと、同じ token でも次回呼出しで refresh される", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));
    const now = Math.floor(Date.now() / 1000);
    const idToken = makeJwt({ sub: "u", exp: now + 3600 });
    const store = makeMemStore({ idToken, refreshToken: "rt" });

    // 1 回目: まだ有効
    const out1 = await getValidIdToken(store);
    expect(out1).toBe(idToken);
    expect(fetchMock).not.toHaveBeenCalled();

    // 時計を 2 時間進める → exp 過去 → refresh
    vi.setSystemTime(new Date("2026-06-01T02:00:00Z"));
    setRefreshSuccess("refreshed-after-advance");
    const out2 = await getValidIdToken(store);
    expect(out2).toBe("refreshed-after-advance");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
