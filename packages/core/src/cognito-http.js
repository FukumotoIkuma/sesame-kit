// Cognito Identity Provider を素の HTTP (fetch) で呼ぶ互換層。
//
// 背景 (REFACTORING_PLAN.md P2-2 / ARCH-02):
//   auth.js が使う Cognito API は現在 8 種 (InitiateAuth / RespondToAuthChallenge / SignUp /
//   ConfirmDevice / ForgetDevice / RevokeToken / GetUser / UpdateUserAttributes) で、
//   すべて SigV4 署名不要の匿名 API。
//   (UpdateDeviceStatus は v1 P2-5 で撤去済み。GetUser / UpdateUserAttributes は P2-8 で追加。)
//   `@aws-sdk/client-cognito-identity-provider` (transitive 約 30 パッケージ) を引き込む必要はなく、
//   AWS JSON 1.1 プロトコルの素 fetch で完全置換できる。
//
// ワイヤ形状 (AWS JSON 1.1):
//   POST https://cognito-idp.<region>.amazonaws.com/
//   Content-Type: application/x-amz-json-1.1
//   X-Amz-Target: AWSCognitoIdentityProviderService.<Op>
//   body: リクエストパラメータの JSON
//
// エラー互換:
//   エラー応答 body の `__type` (例: "NotAuthorizedException"、
//   "com.amazonaws.cognito...#NotAuthorizedException" の "#" 付き形式もある) を
//   Error.name に写像する。これにより AWS SDK 時代の
//   `err.name === "NotAuthorizedException"` 等の既存ハンドラが無変更で動く。

const DEFAULT_REGION = "ap-northeast-1";

/**
 * Cognito AuthenticationResult (旧 @aws-sdk AuthenticationResultType 互換の最小形)。
 * @typedef {object} CognitoAuthResult
 * @property {string} [IdToken]
 * @property {string} [AccessToken]
 * @property {string} [RefreshToken]
 * @property {string} [TokenType]
 * @property {number} [ExpiresIn]
 * @property {{ DeviceKey?: string, DeviceGroupKey?: string }} [NewDeviceMetadata]
 */

/**
 * auth.js が読む Cognito 応答フィールドの和集合 (op ごとに使う部分だけ読む)。
 * @typedef {object} CognitoResponse
 * @property {string} [ChallengeName]
 * @property {Record<string, string>} [ChallengeParameters]
 * @property {string} [Session]
 * @property {CognitoAuthResult} [AuthenticationResult]
 * @property {boolean} [UserConfirmationNecessary]
 * @property {boolean} [UserConfirmed]
 * @property {string} [UserSub]
 * @property {{ Name: string; Value: string }[]} [UserAttributes]
 */

/**
 * Cognito Identity Provider の 1 オペレーションを呼ぶ。
 *
 * @param {string} op オペレーション名 (例: "InitiateAuth")。X-Amz-Target の末尾になる。
 * @param {object} payload リクエストパラメータ (AWS SDK の Command input と同形)
 * @param {{ region?: string, fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<CognitoResponse>}
 * @throws {Error} エラー応答時。`name` に Cognito の例外名 (__type の "#" 以降) を写像。
 */
export async function cognitoCall(op, payload, { region = DEFAULT_REGION, fetchImpl } = {}) {
  const doFetch = fetchImpl ?? fetch;
  const resp = await doFetch(`https://cognito-idp.${region}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `AWSCognitoIdentityProviderService.${op}`,
    },
    body: JSON.stringify(payload ?? {}),
  });

  const text = await resp.text();
  /** @type {Record<string, unknown>} */
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      // 非 JSON 応答 (ゲートウェイエラー等)。ok ならそのまま空 body、エラーなら下で扱う。
      body = {};
    }
  }

  if (!resp.ok) {
    // __type は "NotAuthorizedException" の素形と
    // "com.amazonaws.cognito.idp...#NotAuthorizedException" の "#" 付き形式の両方がある。
    const rawType = typeof body.__type === "string" ? body.__type : "";
    const name = rawType.split("#").pop() || "CognitoHttpError";
    // メッセージのキーは "message" が標準だが、一部 API は "Message" を返す。
    const message =
      (typeof body.message === "string" && body.message) ||
      (typeof body.Message === "string" && body.Message) ||
      `Cognito ${op} failed: HTTP ${resp.status}`;
    const err = new Error(message);
    err.name = name; // 既存の `err.name === "NotAuthorizedException"` 等のハンドラ互換
    throw err;
  }

  return /** @type {CognitoResponse} */ (body);
}
