// tests/auth 共通: Cognito 生 HTTP (src/cognito-http.js) 用の fetch モック。
//
// P2-2 で auth.js は @aws-sdk/client-cognito-identity-provider から素 fetch
// (POST https://cognito-idp.<region>.amazonaws.com/ + X-Amz-Target) に移行した。
// テスト側も SDK の Command モックではなく global.fetch を差し替えて観測する。
// 応答形 (AuthenticationResult / ChallengeName / __type エラー) は AWS JSON 1.1 の
// 実ワイヤ形から導出している。
import { vi } from "vitest";

/** @type {import("vitest").Mock} */
export const fetchMock = vi.fn();

/** global.fetch を fetchMock に差し替える (afterAll で vi.unstubAllGlobals() を推奨)。 */
export function installFetchMock() {
  vi.stubGlobal("fetch", fetchMock);
}

/** 2xx の Cognito 応答 (Response 互換の最小形。clone() を含む)。 */
export function cognitoOk(body = {}) {
  const bodyStr = JSON.stringify(body);
  const make = () => ({
    ok: true,
    status: 200,
    text: async () => bodyStr,
    clone() { return make(); },
  });
  return make();
}

/**
 * Cognito エラー応答。実ワイヤでは __type は
 * "com.amazonaws...#NotAuthorizedException" の "#" 付き形式が一般的。
 * clone() を含む (Throttling 4xx 判定で res.clone().text() を呼ぶため)。
 * @param {string} name 例外名 (例: "NotAuthorizedException")
 * @param {string} [message]
 * @param {{ status?: number, hashPrefix?: boolean }} [opts]
 */
export function cognitoError(name, message = `${name}: simulated`, { status = 400, hashPrefix = true } = {}) {
  const __type = hashPrefix ? `com.amazonaws.cognito.identity.idp.model#${name}` : name;
  const bodyStr = JSON.stringify({ __type, message });
  const make = () => ({
    ok: false,
    status,
    text: async () => bodyStr,
    clone() { return make(); },
  });
  return make();
}

/**
 * fetchMock の呼び出し履歴を { op, input, url, headers } の配列に整形する。
 * op は X-Amz-Target の末尾 (例: "InitiateAuth")、input は body の JSON。
 */
export function cognitoCalls() {
  return fetchMock.mock.calls.map(([url, init]) => ({
    url,
    headers: init.headers,
    op: String(init.headers["X-Amz-Target"] || "").split(".").pop(),
    input: JSON.parse(init.body),
  }));
}

/** op 名の配列 (呼び出し順)。 */
export function cognitoOps() {
  return cognitoCalls().map((c) => c.op);
}
