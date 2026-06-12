// Cognito 認証。
//
// 規範 (REFACTORING_PLAN.md §0.1): ログイン/トークン管理は Android アプリ
// (AWSMobileClient 2.77.0 + CUSTOM_AUTH) のトレースとする。web (useAuthState.js) は使用禁止。
//   - 一次参照 (ワイヤ形・数式): _aws_sdk_ref/CognitoUser.java /
//     _aws_sdk_ref/ChallengeContinuation.java /
//     _aws_sdk_ref/CognitoIdentityProviderClientConfig.java
//     (AWSMobileClient 2.77.0 / release_v2.77.0 タグ)
//     注意: AuthenticationHelper は独立 .java ファイルではなく CognitoUser.java の
//     inner class(_aws_sdk_ref/CognitoUser.java:3979-4097)。
//   - アプリ側: _sesame_sdk_ref/app/.../account/LoginMailFG.kt
//     (signUp 先行 + "dummypwk" + SRP_A 付き CUSTOM_AUTH)
//
// AWS Mobile SDK は Android 前提のため Node では使えず、Cognito API を素 fetch
// (src/cognito-http.js, AWS JSON 1.1) で直叩きする。
// 振る舞いはアプリと同じ:
//   - User Pool: ap-northeast-1_bY2byhlCa (biz / consumer 共有)
//   - signUp 先行 (UsernameExistsException 容認) →
//     CUSTOM_AUTH (SRP_A 付き InitiateAuth):
//       LoginMailFG.kt:131 の signIn("mail","dummypwk",null,...) →
//       AWSMobileClient.java:1318-1322 (password!=null → 4引数 AuthenticationDetails) →
//       AuthenticationDetails.java:67-80 (authParams != null → setCustomChallenge("SRP_A")) →
//       CognitoUser.java:3492-3494 (AuthParams に SRP_A: A.toString(16) を注入)。
//     InitiateAuth 応答が PASSWORD_VERIFIER の場合は user SRP で回答してから CUSTOM_CHALLENGE
//     へ進む (_aws_sdk_ref/CognitoUser.java:3057-3071, 3588-3662)。現行 Cognito は
//     CUSTOM_CHALLENGE を直行することが多いが、両経路を処理する。
//   - CUSTOM_CHALLENGE → email にコード → コード回答 (LoginMailFG.kt:106-127)
//   - ログイン後に ConfirmDevice でデバイスを確定する (loginVerify / confirmDevice)。
//     デバイストラッキング有効 Pool では、これを省くと未確認の DEVICE_KEY で
//     REFRESH_TOKEN_AUTH が `Invalid Refresh Token` になり、idToken 失効後の初回
//     refresh で必ず落ちる。AWSMobileClient は handleChallenge 内で自動 ConfirmDevice
//     している (_aws_sdk_ref/CognitoUser.java:3130-3140)。
//   - Client ID は公式 iOS/Android/chat.candyhouse.co と同じ Consumer Client
//     `6ialca0p8u0lsgvbmvsljfm305` (アプリと同じトークン寿命)。
//
// 意図的逸脱:
//   - UserContextData: Android ASF 由来の端末フィンガープリント
//     (_aws_sdk_ref/CognitoUser.java:3505, CognitoUserPool.java:626-636) は
//     Node から忠実再現不能。非送出を意図的に採用 (規範2)。
//
// 状態は TokenStore (load/save/clear + loadPending/savePending/clearPending) に永続化を委譲。
// CLI からは FileTokenStore、ライブラリ消費者は独自実装を渡せる。

import { createHash, createHmac } from "node:crypto";
import { hostname } from "node:os";
import { cognitoCall } from "./cognito-http.js";
import {
  cognitoTimestamp,
  deviceAuthSecrets,
  devicePasswordSignature,
  generateDeviceVerifier,
  generateEphemeralA,
} from "./device-srp.js";
import { SesameError, ERR } from "./errors.js";
// i18n はエラーメッセージ文言の外出しだけに使用 (auth ロジックは不可侵)。
// この関数内のローカル変数 `t` (= store.load()) と衝突しないよう `tr` で取り込む。
import { t as tr } from "./i18n.js";

const COGNITO_REGION = "ap-northeast-1";
const USER_POOL_ID = "ap-northeast-1_bY2byhlCa";
// 公式アプリ (iOS/Android Sesame, chat.candyhouse.co) と同じ client。
// biz3 aws-exports.js:5 の userPoolWebClientId と一致 (一次資料で確認済み)。
export const CONSUMER_CLIENT_ID = "6ialca0p8u0lsgvbmvsljfm305";
// デフォルトは consumer (公式アプリと同じ寿命)
const DEFAULT_CLIENT_ID = CONSUMER_CLIENT_ID;
// 新規 sign-up 時のダミーパスワード (Cognito policy 通過用)。
// web=Aa123456 (references_web/src/api/useAuthState.js:110) / app=dummypwk
// (_sesame_sdk_ref/app/.../LoginMailFG.kt:110)。本 kit は app をトレースする (§0.1)。
const DUMMY_PASSWORD = "dummypwk";

// ---------------------------------------------------------------------------
// user SRP 用定数 (respondToPasswordVerifier 専用)。
// _aws_sdk_ref/CognitoUser.java:4005-4058 (AuthenticationHelper 内クラス) の 1:1。
// device-srp.js が保持する同一 N/G/K とは独立して定義し、エンコーディングを
// Java の BigInteger.toByteArray() (符号バイト付き Big-endian) に合わせる。
// ---------------------------------------------------------------------------

// SRP-6a 3072-bit group prime (_aws_sdk_ref/CognitoUser.java:4005-4021)。
const USER_SRP_N_HEX =
  "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1" +
  "29024E088A67CC74020BBEA63B139B22514A08798E3404DD" +
  "EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245" +
  "E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED" +
  "EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D" +
  "C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F" +
  "83655D23DCA3AD961C62F356208552BB9ED529077096966D" +
  "670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B" +
  "E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9" +
  "DE2BCBF6955817183995497CEA956AE515D2261898FA0510" +
  "15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64" +
  "ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7" +
  "ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6B" +
  "F12FFA06D98A0864D87602733EC86A64521F2B18177B200C" +
  "BBE117577A615D6C770988C0BAD946E208E24FA074E5AB31" +
  "43DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF";
const USER_SRP_N = BigInt("0x" + USER_SRP_N_HEX);
const USER_SRP_G = 2n;

// K = SHA256(N.toByteArray() | G.toByteArray())
// _aws_sdk_ref/CognitoUser.java:4050-4054:
//   messageDigest.update(N.toByteArray()); digest(GG.toByteArray())
// Java の BigInteger.toByteArray() は最上位ビットが 1 のとき 0x00 を前置する (符号バイト)。
// N は FFFF... で始まるため toByteArray() は [0x00, 0xFF, 0xFF, ...] の 385B になる。
// G = 2 → toByteArray() = [0x02] の 1B。
const USER_SRP_K = BigInt("0x" + createHash("sha256")
  .update(Buffer.concat([Buffer.from([0x00]), Buffer.from(USER_SRP_N_HEX, "hex")])) // N.toByteArray() = 385B
  .update(Buffer.from([2]))                                                           // G.toByteArray() = [0x02]
  .digest("hex"));

/**
 * BigInt → Java の BigInteger.toByteArray() 相当 (符号付き Big-endian hex)。
 * 最上位ビットが 1 なら 0x00 を前置 (padHex と同じ動作)。
 * @param {bigint} n
 * @returns {string} 偶数長 hex
 */
function userSrpPadHex(n) {
  let hex = n.toString(16);
  if (hex.length % 2 === 1) hex = "0" + hex;
  else if ("89abcdef".includes(hex[0].toLowerCase())) hex = "00" + hex;
  return hex;
}

/**
 * モジュラ冪乗 (device-srp.js の modPow と同一)。
 * @param {bigint} base
 * @param {bigint} exp
 * @param {bigint} mod
 * @returns {bigint}
 */
function userSrpModPow(base, exp, mod) {
  let result = 1n;
  base = ((base % mod) + mod) % mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

/**
 * catch 節の unknown を `{ name?, message? }` として安全に読むためのナロー化。
 * @param {unknown} e
 * @returns {{ name?: string, message?: string }}
 */
function asErr(e) {
  return /** @type {{ name?: string, message?: string }} */ (e ?? {});
}

/**
 * JWT payload (base64url) をデコードして指定 claim の値を返す。
 * token が null/undefined/不正形式/JSON 不正 いずれでも null を返す (catch で包む)。
 * null/undefined → token.split が TypeError → catch → null の経路が意図的動作。
 * P5-5: jwtExp / jwtAud / jwtSub の共通基底として抽出。tokens.js も import して使用。
 * @param {string|null|undefined} token
 * @param {string} name  claim 名 (例: "exp", "aud", "sub")
 * @returns {string|number|null}
 */
export function jwtClaim(token, name) {
  try {
    // @ts-expect-error — null/undefined は token.split() で TypeError → catch → null
    const payload = token.split(".")[1];
    const json = Buffer.from(payload, "base64").toString("utf8");
    return JSON.parse(json)[name] || null;
  } catch {
    return null;
  }
}

/**
 * JWT を decode して exp を返す (秒、UNIX時間)。失敗時は 0。
 * null/undefined を渡した場合も 0 を返す。
 * @param {string|null|undefined} token
 * @returns {number}
 */
function jwtExp(token) { return /** @type {number} */ (jwtClaim(token, "exp")) || 0; }

/**
 * idToken の aud claim (= clientId) を返す。
 * null/undefined を渡した場合も null を返す。
 * @param {string|null|undefined} token
 * @returns {string|null}
 */
function jwtAud(token) { return /** @type {string|null} */ (jwtClaim(token, "aud")); }

/**
 * idToken の `sub` claim (= Cognito user UUID) を返す。
 * biz3 が `gStripe.customerInfo.subUUID` として使っている値と同じで、
 * `biz3TriggerLocker` の `history` フィールドに乗せる必要がある。
 * @param {string} token
 * @returns {string|null}
 */
export function jwtSub(token) { return /** @type {string|null} */ (jwtClaim(token, "sub")); }

/** @param {Partial<import("./tokens.js").StoredTokens>} tokens */
function resolvedClientId(tokens) {
  return tokens.clientId || (tokens.idToken ? jwtAud(tokens.idToken) : null) || DEFAULT_CLIENT_ID;
}

/** @param {Partial<import("./tokens.js").StoredTokens>} tokens */
function tokenAud(tokens) {
  return tokens.idToken ? jwtAud(tokens.idToken) : null;
}

/** @param {Partial<import("./tokens.js").StoredTokens>} tokens */
function hasConfirmedDevice(tokens) {
  return Boolean(tokens.deviceKey && tokens.deviceGroupKey && tokens.devicePassword);
}

/**
 * この CLI/library は公式アプリ相当の Consumer Client + ConfirmDevice 済み token だけを
 * 長期セッションとして扱う。biz/旧 localStorage dump を受け入れると refreshToken が
 * 24h 前後で `Invalid Refresh Token` になり、このツールの「ログイン済みを維持する」
 * 契約を破るため、入口で落とす。
 *
 * @param {Partial<import("./tokens.js").StoredTokens>} tokens
 * @param {string} source
 * @param {{ requireAud?: boolean, requireConfirmedDevice?: boolean }} [opts]
 */
function assertAppLoginTokens(tokens, source, { requireAud = false, requireConfirmedDevice = false } = {}) {
  const aud = tokenAud(tokens);
  if (requireAud && aud !== CONSUMER_CLIENT_ID) {
    throw new SesameError(`${source} must contain an idToken issued for the SESAME consumer app client. Run \`sesame login <email>\` so the app-compatible Cognito flow runs.`, { code: ERR.UNAUTHENTICATED });
  }
  if (aud && aud !== CONSUMER_CLIENT_ID) {
    throw new SesameError(`${source} was issued for a non-consumer Cognito client (${aud}). Run \`sesame login <email>\` so refresh tokens use the official app path.`, { code: ERR.UNAUTHENTICATED });
  }
  const clientId = resolvedClientId(tokens);
  if (clientId !== CONSUMER_CLIENT_ID) {
    throw new SesameError(`${source} uses unsupported Cognito clientId ${clientId}. Only the SESAME consumer app client is supported. Run \`sesame login <email>\`.`, { code: ERR.UNAUTHENTICATED });
  }
  if (requireConfirmedDevice && !hasConfirmedDevice(tokens)) {
    throw new SesameError(`${source} is missing confirmed Cognito device credentials. Run \`sesame login <email>\` so ConfirmDevice stores deviceKey/deviceGroupKey/devicePassword.`, { code: ERR.UNAUTHENTICATED });
  }
}

/**
 * 失効していない idToken を返す。必要なら refresh する。
 * 失効まで `marginSec` 以下なら早期 refresh する (デフォルト 120秒 =
 * AWSMobileClient 2.77.0 の REFRESH_THRESHOLD_DEFAULT、
 * _aws_sdk_ref/CognitoIdentityProviderClientConfig.java:40)。
 *
 * @param {import("./tokens.js").TokenStore} store
 * @param {{ marginSec?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function getValidIdToken(store, { marginSec = 120 } = {}) {
  const t = store.load();
  if (!t) {
    throw new SesameError(tr("auth.noTokens"), { code: ERR.UNAUTHENTICATED });
  }
  assertAppLoginTokens(t, "Stored tokens", { requireConfirmedDevice: true });

  const now = Math.floor(Date.now() / 1000);
  const exp = jwtExp(t.idToken);
  if (t.idToken && exp - now > marginSec) {
    return t.idToken;
  }

  if (!t.refreshToken) {
    // P5-1: i18n 化 (元の英語ハードコードを auth.noRefreshToken へ。serve 到達面)。
    throw new SesameError(tr("auth.noRefreshToken"), { code: ERR.UNAUTHENTICATED });
  }
  const clientId = CONSUMER_CLIENT_ID;
  /** @type {Record<string, string>} */
  const authParameters = { REFRESH_TOKEN: t.refreshToken };
  if (t.deviceKey) authParameters.DEVICE_KEY = t.deviceKey;

  let resp;
  try {
    resp = await cognitoCall("InitiateAuth", {
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: clientId,
      AuthParameters: authParameters,
    });
  } catch (e) {
    // refresh token 失効 (公式アプリで再ログイン等) は再ログインで復帰する認証エラー。
    // 参照 SDK は refresh が NotAuthorized / UserNotFound で落ちたら clearCachedTokens()
    // する (_aws_sdk_ref/CognitoUser.java:1306-1311)。
    // clearCachedTokens() は idToken / accessToken / refreshToken の 3 キーのみ remove
    // (_aws_sdk_ref/CognitoUser.java:2703-2720)。deviceKey / deviceGroupKey / devicePassword
    // は別ストアで温存され、clearCachedDevice は DEVICE_SRP_AUTH の NotAuthorized 時のみ
    // (_aws_sdk_ref/CognitoUser.java:3384-3396)。
    // kit 旧実装 store.clear() は device 3 点 + username まで消すため、refresh 失効のたびに
    // ConfirmDevice が新規発行されサーバに remembered device が累積していた (P2-3)。
    // 修正: idToken / accessToken / refreshToken / lastRefresh を null にし
    //       clientId / username / device 3 点 (deviceKey/deviceGroupKey/devicePassword) は温存した
    //       save を行う。tokens.js mergeStoredTokens の規則 2a により、merge がディスク側の
    //       古いトークンを復活させる競合も防ぐ。
    // pending verify 状態 (loginStatePath) は進行中の再ログインを壊さないよう残す
    // (clearPending しない)。
    const name = asErr(e).name;
    if (name === "NotAuthorizedException" || name === "UserNotFoundException") {
      // token 3 点 + lastRefresh を破棄し、device 3 点 + username + clientId を温存する。
      // idToken: null は mergeStoredTokens の規則 2a で「明示破棄」として扱われ、
      // ディスク側の古いトークンが merge で復活するのを防ぐ。
      store.save({
        clientId: t.clientId,
        username: t.username,
        idToken: null,
        accessToken: null,
        refreshToken: null,
        lastRefresh: null,
        deviceKey: t.deviceKey ?? null,
        deviceGroupKey: t.deviceGroupKey ?? null,
        devicePassword: t.devicePassword ?? null,
      });
      throw new SesameError(String(asErr(e).message || e), { code: ERR.UNAUTHENTICATED, cause: e });
    }
    throw e;
  }

  const r = resp.AuthenticationResult;
  if (!r?.IdToken) {
    throw new SesameError(`Cognito refresh returned no IdToken: ${JSON.stringify(resp)}`, { code: ERR.UNAUTHENTICATED });
  }

  t.idToken = r.IdToken;
  if (r.AccessToken)  t.accessToken  = r.AccessToken;
  // 参照 SDK は refresh 後も旧 refresh token を維持する (_aws_sdk_ref/CognitoUser.java:2873-2874) が、
  // ここは refresh token rotation (AWS 新機能) への前方互換として、応答に新 token が
  // 来たら意図的に取り込む (意図的逸脱)。
  if (r.RefreshToken) t.refreshToken = r.RefreshToken;
  t.lastRefresh = new Date().toISOString();
  store.save(t);
  return t.idToken;
}

/**
 * Step 1: アプリと同じ「signUp 先行 → CUSTOM_AUTH (SRP_A 付き) 開始」。
 *
 * フロー (アプリ忠実):
 *   1. SignUp (Password="dummypwk", UserAttributes=[{Name:"email"}]) を常に先に実行。
 *      既存ユーザーの UsernameExistsException は容認して signIn へ進む
 *      (_sesame_sdk_ref/app/.../LoginMailFG.kt:114-118)。
 *   2. InitiateAuth (CUSTOM_AUTH, AuthParameters={USERNAME, CHALLENGE_NAME:"SRP_A", SRP_A}).
 *      SRP_A は `generateEphemeralA()` で生成した A = g^a mod N の hex 文字列。
 *      _aws_sdk_ref/CognitoUser.java:3492-3494 の 1:1。
 *      DEVICE_KEY は initiate には入れない (_aws_sdk_ref/CognitoUser.java:3473-3507)。
 *   3a. 応答が CUSTOM_CHALLENGE → そのまま pending に保存して返す (現行 Cognito の観測形)。
 *   3b. 応答が PASSWORD_VERIFIER → user SRP で回答してから CUSTOM_CHALLENGE を待つ
 *      (_aws_sdk_ref/CognitoUser.java:3057-3071, 3588-3662)。
 *
 * @experimental 実機未検証 (§9 V13): アプリ形 InitiateAuth (SRP_A 付き) を実 Cognito が
 *   受理し CUSTOM_CHALLENGE を返すこと、および PASSWORD_VERIFIER 連鎖経路の実機確認が未実施。
 *   参照: _aws_sdk_ref/CognitoUser.java:3057-3071, 3588-3662。
 *
 * @param {import("./tokens.js").TokenStore} store
 * @param {string} username
 * @param {{ clientId?: string }} [opts] 互換用。Consumer Client 以外は拒否する。
 */
export async function loginInitiate(store, username, { clientId = DEFAULT_CLIENT_ID } = {}) {
  if (clientId !== CONSUMER_CLIENT_ID) {
    throw new SesameError(`Unsupported Cognito clientId ${clientId}. Use the SESAME consumer app client via \`sesame login <email>\`.`, { code: ERR.UNAUTHENTICATED });
  }

  // アプリは常に signUp を先に実行し、既存ユーザーの UsernameExistsException だけを
  // 握って signIn に進む。それ以外の signUp エラーはユーザーに見せて中断する
  // (_sesame_sdk_ref/app/.../LoginMailFG.kt:106-127)。
  try {
    await cognitoCall("SignUp", {
      ClientId: clientId,
      Username: username,
      Password: DUMMY_PASSWORD,
      UserAttributes: [{ Name: "email", Value: username }], // LoginMailFG.kt:106-107
      // P2-6: アプリは validationData=mapOf() (空 Map) を渡す (LoginMailFG.kt:109 の第4引数)。
      // AWSMobileClient 4引数 signUp → Collections.emptyMap() として CognitoUserPool に渡す
      // (_aws_sdk_ref/AWSMobileClient.java:2184-2193)。
      // CognitoUserPool.signUpInternal は validationData != null なら空 List を構築して
      // withValidationData に渡す (_aws_sdk_ref/CognitoUserPool.java:531-552)。
      // SignUpRequestMarshaller は != null チェックのみ (size > 0 チェックなし) なので
      // 空 List でも ValidationData:[] をワイヤに書く
      // (_aws_sdk_ref/SignUpRequestMarshaller.java:95-106)。
      ValidationData: [],
      // P2-6: ClientMetadata も同様に空 Map → ClientMetadata:{} をワイヤに書く
      // (_aws_sdk_ref/AWSMobileClient.java:2191-2192 emptyMap() / SignUpRequestMarshaller.java:119-132)。
      ClientMetadata: {},
    });
  } catch (e) {
    if (asErr(e).name !== "UsernameExistsException") throw e;
  }

  // SRP_A を生成。アプリは CUSTOM_AUTH でも SRP_A を InitiateAuth に含める。
  // _aws_sdk_ref/AuthenticationDetails.java:67-80 →
  //   4引数 ctor (authParams != null) は setCustomChallenge("SRP_A") を実行し、
  //   authenticationParameters["CHALLENGE_NAME"] = "SRP_A" が設定される。
  // _aws_sdk_ref/CognitoUser.java:3492-3494 →
  //   customChallenge が "SRP_A" のとき authParams に SRP_A: A.toString(16) を注入。
  const { a, A } = generateEphemeralA();

  const resp = await cognitoCall("InitiateAuth", {
    AuthFlow: "CUSTOM_AUTH",
    ClientId: clientId,
    AuthParameters: {
      USERNAME: username,
      CHALLENGE_NAME: "SRP_A", // AuthenticationDetails.java:75,182-184 setCustomChallenge("SRP_A")
      SRP_A: A.toString(16),    // _aws_sdk_ref/CognitoUser.java:3493
    },
    // P2-6: アプリは clientMetadata を空 Map で渡す。
    // initiateCustomAuthRequest は setClientMetadata(clientMetadata) で null チェックなし注入
    // (_aws_sdk_ref/CognitoUser.java:3480)。
    // InitiateAuthRequestMarshaller は != null チェックのみなので
    // 空 Map でも ClientMetadata:{} をワイヤに書く
    // (_aws_sdk_ref/InitiateAuthRequestMarshaller.java:85-99)。
    ClientMetadata: {},
  });

  // PASSWORD_VERIFIER が返った場合: user SRP で回答してから CUSTOM_CHALLENGE を待つ。
  // _aws_sdk_ref/CognitoUser.java:3057-3071 の分岐。
  if (resp.ChallengeName === "PASSWORD_VERIFIER") {
    // ChallengeParameters フィールドは _aws_sdk_ref/CognitoUser.java:3594-3598 の
    // 読み取りから導出:
    //   challengeParameters.get("USERNAME")         → userId (内部ユーザー名)
    //   challengeParameters.get("USER_ID_FOR_SRP")  → SRP 計算用のユーザー ID
    //   challengeParameters.get("SRP_B")            → サーバ公開値 B (hex)
    //   challengeParameters.get("SALT")             → ソルト (hex)
    //   challengeParameters.get("SECRET_BLOCK")     → base64 秘密ブロック
    const verifierResp = await respondToPasswordVerifier({
      clientId,
      session: resp.Session,
      challengeParameters: resp.ChallengeParameters || {},
      a,
      A,
      password: DUMMY_PASSWORD,
    });

    // PASSWORD_VERIFIER 応答の次は CUSTOM_CHALLENGE が来るはず。
    // _aws_sdk_ref/CognitoUser.java:3071 → respondToChallenge → handleChallenge。
    if (verifierResp.ChallengeName !== "CUSTOM_CHALLENGE") {
      // P5-1 方針3: loginInitiate は serve 非到達 (CLI ログインフロー専用)。
      // Cognito から予期しないチャレンジ名が返った場合の内部不変条件違反。
      throw new Error(`Unexpected challenge after PASSWORD_VERIFIER: ${verifierResp.ChallengeName} (expected CUSTOM_CHALLENGE)`);
    }
    store.savePending({
      clientId,
      username,
      session: /** @type {string|undefined} */ (verifierResp.Session),
      initiatedAt: new Date().toISOString(),
    });
    return {
      challenge: /** @type {string} */ (verifierResp.ChallengeName),
      params: /** @type {Record<string,string>} */ (verifierResp.ChallengeParameters),
    };
  }

  if (resp.ChallengeName !== "CUSTOM_CHALLENGE") {
    // P5-1 方針3: loginInitiate は serve 非到達 (CLI ログインフロー専用)。内部不変条件。
    throw new Error(`Unexpected challenge: ${resp.ChallengeName} (expected CUSTOM_CHALLENGE)`);
  }
  store.savePending({
    clientId,
    username,
    session: resp.Session,
    initiatedAt: new Date().toISOString(),
  });
  return { challenge: resp.ChallengeName, params: resp.ChallengeParameters };
}

/**
 * PASSWORD_VERIFIER チャレンジに user SRP で回答する。
 * _aws_sdk_ref/CognitoUser.java:3588-3662 (userSrpAuthRequest) の 1:1。
 *
 * 数式は device-srp.js の SRP 実装 (generateEphemeralA) と同一の SRP-6a 3072-bit group だが、
 * ハッシュ計算のエンコーディングを Java の BigInteger.toByteArray() (バイナリ連結) に
 * 合わせて独立実装している (_aws_sdk_ref/CognitoUser.java:4060-4096)。
 *
 * @param {object} args
 * @param {string} args.clientId
 * @param {string|undefined} args.session
 * @param {Record<string,string>} args.challengeParameters Cognito から受け取った ChallengeParameters
 * @param {bigint} args.a クライアント秘密 (generateEphemeralA の a)
 * @param {bigint} args.A クライアント公開値 (generateEphemeralA の A)
 * @param {string} args.password ユーザーパスワード ("dummypwk")
 * @returns {Promise<Record<string,unknown>>} RespondToAuthChallenge の応答
 */
async function respondToPasswordVerifier({ clientId, session, challengeParameters, a, A, password }) {
  // ChallengeParameters フィールドは _aws_sdk_ref/CognitoUser.java:3594-3598 から導出。
  const userIdForSRP = challengeParameters.USER_ID_FOR_SRP || challengeParameters.USERNAME || "";
  const srpBHex = challengeParameters.SRP_B || "";
  const saltHex = challengeParameters.SALT || "";
  const secretBlockB64 = challengeParameters.SECRET_BLOCK || "";

  // B mod N == 0 ガード (_aws_sdk_ref/CognitoUser.java:3605-3608)。
  const serverB = BigInt("0x" + srpBHex);
  if (serverB % USER_SRP_N === 0n) {
    // P5-1 方針3: SRP 内部不変条件 (プログラマエラー/Cognito 異常)。serve 非到達。
    throw new Error("SRP error, B cannot be zero");
  }

  // poolName = USER_POOL_ID の "_" 以降 (_aws_sdk_ref/CognitoUser.java:3990-3994)。
  const poolName = USER_POOL_ID.includes("_") ? USER_POOL_ID.split("_").slice(1).join("_") : USER_POOL_ID;

  // x = H(salt.toByteArray() | H(poolName | userId | ":" | password))
  // _aws_sdk_ref/CognitoUser.java:4074-4083。
  // Java は toByteArray() バイナリ連結で計算する (device-srp.js の hexHash とは異なる)。

  // inner hash: SHA256(poolName | userId | ":" | password) — バイト列連結
  // _aws_sdk_ref/CognitoUser.java:4075-4079
  const innerHash = createHash("sha256")
    .update(Buffer.from(poolName, "utf8"))
    .update(Buffer.from(userIdForSRP, "utf8"))
    .update(Buffer.from(":", "utf8"))
    .update(Buffer.from(password, "utf8"))
    .digest();

  // outer hash: SHA256(salt.toByteArray() | innerHash)
  // _aws_sdk_ref/CognitoUser.java:4081-4083。
  // salt は hex 文字列 → padHex で BigInteger.toByteArray() 相当に変換。
  const saltBuf = Buffer.from(userSrpPadHex(BigInt("0x" + saltHex)), "hex");
  const x = BigInt("0x" + createHash("sha256").update(saltBuf).update(innerHash).digest("hex"));

  // u = H(A.toByteArray() | B.toByteArray()) — バイナリ連結
  // _aws_sdk_ref/CognitoUser.java:4066-4069。
  const u = BigInt("0x" + createHash("sha256")
    .update(Buffer.from(userSrpPadHex(A), "hex"))
    .update(Buffer.from(userSrpPadHex(serverB), "hex"))
    .digest("hex"));
  // P5-1 方針3: SRP 内部不変条件 (プログラマエラー/Cognito 異常)。serve 非到達。
  if (u === 0n) throw new Error("SRP error: u cannot be 0");

  // S = (B - k * g^x) ^ (a + u*x) mod N
  // _aws_sdk_ref/CognitoUser.java:4084-4085
  const gModPowXN = userSrpModPow(USER_SRP_G, x, USER_SRP_N);
  const base = ((serverB - USER_SRP_K * gModPowXN) % USER_SRP_N + USER_SRP_N) % USER_SRP_N;
  const sValue = userSrpModPow(base, a + u * x, USER_SRP_N);

  // HKDF: hkdf.init(s.toByteArray(), u.toByteArray()) → PRK = HMAC-SHA256(key=u, data=s)
  // _aws_sdk_ref/CognitoUser.java:4093, _aws_sdk_ref/Hkdf.java:64-86
  const sBuf = Buffer.from(userSrpPadHex(sValue), "hex");
  const uBuf = Buffer.from(userSrpPadHex(u), "hex");
  const prk = createHmac("sha256", uBuf).update(sBuf).digest();
  // deriveKey("Caldera Derived Key", 16): T(1) = HMAC-SHA256(key=PRK, data=info||0x01)[0:16]
  // _aws_sdk_ref/Hkdf.java:164-168
  const infoBuf = Buffer.concat([Buffer.from("Caldera Derived Key", "utf8"), Buffer.from([1])]);
  const hkdf = createHmac("sha256", prk).update(infoBuf).digest().subarray(0, 16);

  // 署名: HMAC-SHA256(hkdf, poolName | userId | secretBlock | timestamp)
  // _aws_sdk_ref/CognitoUser.java:3618-3633
  const timestamp = cognitoTimestamp();
  const hmac = createHmac("sha256", hkdf)
    .update(Buffer.from(poolName, "utf8"))
    .update(Buffer.from(userIdForSRP, "utf8"))
    .update(Buffer.from(secretBlockB64, "base64"))
    .update(Buffer.from(timestamp, "utf8"))
    .digest("base64");

  // ChallengeResponses: _aws_sdk_ref/CognitoUser.java:3638-3646
  /** @type {Record<string,string>} */
  const responses = {
    PASSWORD_CLAIM_SECRET_BLOCK: secretBlockB64,  // CHLG_RESP_PASSWORD_CLAIM_SECRET_BLOCK
    PASSWORD_CLAIM_SIGNATURE: hmac,                // CHLG_RESP_PASSWORD_CLAIM_SIGNATURE
    TIMESTAMP: timestamp,                          // CHLG_RESP_TIMESTAMP
    USERNAME: userIdForSRP,                        // CHLG_RESP_USERNAME
    // DEVICE_KEY は存在すれば付与 (_aws_sdk_ref/CognitoUser.java:3645)。
    // initiate 時点では pending にデバイス情報はないため省略 (意図的逸脱注記済み)。
  };

  return cognitoCall("RespondToAuthChallenge", {
    ClientId: clientId,
    ChallengeName: "PASSWORD_VERIFIER",
    ...(session ? { Session: session } : {}),
    ChallengeResponses: responses,
  });
}

/**
 * Step 2: email で受け取ったコードで CUSTOM_CHALLENGE を回答。
 * 成功するとトークンを保存し、pending 状態を消す。
 *
 * @param {import("./tokens.js").TokenStore} store
 * @param {string} code
 */
export async function loginVerify(store, code) {
  const s = store.loadPending();
  if (!s) {
    // P5-1 方針3: loginVerify は serve 非到達 (CLI ログインフロー専用) なので plain Error を維持。
    throw new Error(tr("auth.noPending"));
  }
  // 参照 SDK は全チャレンジ回答に保存済み DEVICE_KEY を注入する
  // (_aws_sdk_ref/CognitoUser.java:2919-2922 respondToChallenge /
  //  _aws_sdk_ref/ChallengeContinuation.java:160-167)。
  // Cognito はこれを見て、記憶済みデバイスなら次に DEVICE_SRP_AUTH を要求できる。
  // (Java は username 単位の CognitoDeviceHelper キャッシュ。ここでは同一 username の
  //  保存済みトークンが持つ deviceKey が相当する。)
  /** @type {Partial<import("./tokens.js").StoredTokens>} */
  const existing = store.load?.() || {};
  /** @type {Record<string, string>} */
  const challengeResponses = {
    USERNAME: s.username,
    ANSWER: code,
  };
  if (existing.username === s.username && existing.deviceKey) {
    challengeResponses.DEVICE_KEY = existing.deviceKey;
  }
  const resp = await cognitoCall("RespondToAuthChallenge", {
    ClientId: s.clientId,
    ChallengeName: "CUSTOM_CHALLENGE",
    Session: s.session,
    ChallengeResponses: challengeResponses,
  });

  let r = resp.AuthenticationResult;
  let device;

  if (r) {
    // デバイストラッキングが有効な Pool では NewDeviceMetadata が返る。ConfirmDevice で
    // デバイスを確定しないと REFRESH_TOKEN_AUTH が `Invalid Refresh Token` で落ちる
    // (参照 SDK は handleChallenge 内で自動 ConfirmDevice する:
    //  _aws_sdk_ref/CognitoUser.java:3130-3140)。
    device = await confirmDevice(r);
  } else if (resp.ChallengeName === "DEVICE_SRP_AUTH") {
    // 記憶済みデバイスの SRP 認証 (参照 SDK の runDeviceAuth と同じ device password チャレンジ)。
    /** @type {Partial<import("./tokens.js").StoredTokens>} */
    const ex = store.load?.() || {};
    try {
      r = await deviceSrpAuth({
        clientId: s.clientId,
        username: resp.ChallengeParameters?.USERNAME || s.username,
        deviceKey: ex.deviceKey,
        deviceGroupKey: ex.deviceGroupKey,
        devicePassword: ex.devicePassword,
        session: resp.Session,
      });
    } catch (e) {
      if (asErr(e).name === "NotAuthorizedException") {
        // 参照 SDK はデバイス認証が NotAuthorized になると clearCachedDevice して
        // 認証フローを最初からやり直す (_aws_sdk_ref/CognitoUser.java:3384-3396)。
        // 同じく失効した device 3 点 (deviceKey/deviceGroupKey/devicePassword) を破棄し、
        // デバイス無しの CUSTOM_AUTH を最初から再試行する。これをしないと
        // 「失効 → 再ログイン → 古い device で再失敗」が無限ループする。
        const stored = store.load?.();
        if (stored) {
          store.save({ ...stored, deviceKey: null, deviceGroupKey: null, devicePassword: null });
        }
        // デバイス無し CUSTOM_AUTH の再開始。新しい確認コードが email に届くので、
        // ユーザーは新コードで verify をやり直す (pending は新 Session に更新済み)。
        await loginInitiate(store, s.username, { clientId: s.clientId });
        throw new SesameError(tr("auth.staleDeviceRetry"), { code: ERR.UNAUTHENTICATED, cause: e });
      }
      throw e;
    }
    // DEVICE_SRP では NewDeviceMetadata は来ない。確定済みの既存デバイス情報を維持する。
    device = ex.deviceKey && ex.deviceGroupKey
      ? { deviceKey: ex.deviceKey, deviceGroupKey: ex.deviceGroupKey, devicePassword: ex.devicePassword }
      : await confirmDevice(r);
  } else if (resp.ChallengeName === "CUSTOM_CHALLENGE" && resp.Session) {
    // コード誤り/期限切れだと Cognito は新しい Session 付きで CUSTOM_CHALLENGE を再発行する
    // (既定 3 回)。古い Session は失効するので、新 Session を pending に書き戻して同じ
    // login のまま verify をやり直せるようにする (clearPending しない)。これをしないと
    // 1 文字のミスタイプで login からやり直しになる。
    store.savePending({ ...s, session: resp.Session, initiatedAt: new Date().toISOString() });
    // P5-1 方針3: loginVerify は serve 非到達 (CLI ログインフロー専用) なので plain Error を維持。
    throw new Error(tr("auth.wrongCodeRetry"));
  } else if (resp.ChallengeName) {
    // P5-1 方針3: 同上。Cognito からの予期しないチャレンジ応答。
    throw new Error(tr("auth.anotherChallenge", { name: resp.ChallengeName }));
  } else {
    // 内部不変条件: AuthenticationResult もチャレンジも来ない (Cognito 実装バグ)。
    throw new Error(`No AuthenticationResult: ${JSON.stringify(resp)}`);
  }

  /** @type {import("./tokens.js").StoredTokens} */
  const tokens = {
    clientId: s.clientId,
    // r は上の分岐で必ず IdToken 付きの AuthenticationResult に確定している。
    idToken: /** @type {string} */ (r.IdToken),
    refreshToken: r.RefreshToken,
    accessToken: r.AccessToken,
    // device は ConfirmDevice 成功時のみ非 null。確定できなかった deviceKey を保存すると
    // 未確認デバイスとして次回 refresh が落ちるため、ここでは確定済みのものだけ永続化する。
    deviceKey: device?.deviceKey ?? null,
    deviceGroupKey: device?.deviceGroupKey ?? null,
    devicePassword: device?.devicePassword ?? null,
    username: s.username,
    lastRefresh: new Date().toISOString(),
  };
  store.save(tokens);
  store.clearPending();

  // P2-8: ログイン直後の nickname 自動設定 (アプリ挙動の移植)。
  // 参照: LoginVerifiCodeFG.kt:74-76, 112-150 — confirmSignIn 成功後に updateNickNameIfNeeded() を呼ぶ。
  // best-effort: 失敗してもログイン成功扱いを変えない (アプリの catch→続行と同義)。
  if (tokens.accessToken) {
    await setNicknameIfNeeded(tokens.accessToken, s.username).catch(() => {});
  }

  return tokens;
}

/**
 * ログイン直後の nickname 自動設定 (アプリ挙動の移植)。
 *
 * 参照: LoginVerifiCodeFG.kt:112-150 — getUserAttributes() → nickname が空かつ
 *   email 非空なら updateUserAttributes({nickname: email の "@" 前}) を best-effort 実行。
 *
 * ワイヤ形 (AWS JSON 1.1):
 *   GetUser:              {AccessToken}
 *     → {UserAttributes: [{Name, Value}, ...]}
 *     (_aws_sdk_ref/CognitoUser.java:1491-1492 getUserDetailsInternal:
 *       getUserRequest.setAccessToken(session.getAccessToken().getJWTToken()))
 *   UpdateUserAttributes: {AccessToken, UserAttributes: [{Name:"nickname", Value:<local>}]}
 *     (_aws_sdk_ref/CognitoUser.java:2228-2230 updateAttributesInternal:
 *       setAccessToken / setUserAttributes(attributes.getAttributesList()))
 *
 * @param {string} accessToken 直前のログインで得た AccessToken
 * @param {string} username ログインユーザー (email)。GetUser が失敗したときの email フォールバック用。
 * @returns {Promise<void>}
 */
async function setNicknameIfNeeded(accessToken, username) {
  // GetUser でユーザー属性一覧を取得する。
  // リクエスト: {AccessToken} のみ。
  // 参照: _aws_sdk_ref/CognitoUser.java:1491-1492 (getUserDetailsInternal)
  const getUserResp = await cognitoCall("GetUser", { AccessToken: accessToken });

  // 応答の UserAttributes は [{Name, Value}, ...] の配列。
  // 参照: _aws_sdk_ref/CognitoUser.java:1495 userResult.getUserAttributes()
  const attrs = /** @type {{ Name: string; Value: string }[]} */ (getUserResp.UserAttributes ?? []);
  const nickname = attrs.find((a) => a.Name === "nickname")?.Value ?? "";
  const emailAttr = attrs.find((a) => a.Name === "email")?.Value ?? "";
  // email 属性が取れなければ引数の username (= ログイン email) を使う。
  const email = emailAttr || username || "";

  // nickname が空かつ email が非空のときだけ設定する。
  // 参照: LoginVerifiCodeFG.kt:118 — nickname.isNullOrEmpty() && !email.isNullOrEmpty()
  if (nickname !== "" || email === "") return;

  const localPart = email.split("@")[0] ?? "";
  if (!localPart) return;

  // UpdateUserAttributes: UserAttributes は [{Name, Value}] の配列。
  // 参照: _aws_sdk_ref/CognitoUser.java:2228-2230 (updateAttributesInternal)
  //   setAccessToken / setUserAttributes(attributes.getAttributesList())
  await cognitoCall("UpdateUserAttributes", {
    AccessToken: accessToken,
    UserAttributes: [{ Name: "nickname", Value: localPart }],
  });
}

/**
 * NewDeviceMetadata を持つ認証結果に対し ConfirmDevice を行う。
 * デバイストラッキング無効の Pool では NewDeviceMetadata が無いので no-op。
 *
 * 参照 SDK は ConfirmDevice のみで、UserConfirmationNecessary でも UpdateDeviceStatus
 * ("remembered" 化) は行わない (_aws_sdk_ref/CognitoUser.java:3140-3151 は newDevice を
 * callback に渡すだけ)。旧実装の remembered 化分岐は参照に無い独自防御だったため削除した。
 *
 * @param {import("./cognito-http.js").CognitoAuthResult} authResult Cognito AuthenticationResult
 * @returns {Promise<{deviceKey:string, deviceGroupKey:string, devicePassword:string}|null>}
 *   確定したデバイス情報。デバイストラッキング無効 (NewDeviceMetadata 無し) なら null。
 */
async function confirmDevice(authResult) {
  const meta = authResult?.NewDeviceMetadata;
  if (!meta?.DeviceKey || !meta?.DeviceGroupKey) return null; // デバイストラッキング無効
  if (!authResult.AccessToken) {
    // NewDeviceMetadata は来たのに ConfirmDevice 用の AccessToken が無い異常系。ここで
    // 黙って deviceKey を保存させると未確認デバイスになり次回 refresh が落ちる。確定不能を
    // 明示的に失敗させ、呼び出し側が deviceKey を永続化しないようにする。
    // P5-1 方針3: Cognito の応答異常 (内部不変条件)。serve 非到達 (loginVerify 専用)。
    throw new Error("device confirmation failed: auth result has NewDeviceMetadata but no AccessToken");
  }

  const { devicePassword, passwordVerifier, salt } = generateDeviceVerifier(
    meta.DeviceGroupKey,
    meta.DeviceKey,
  );

  // 【意図的逸脱】参照 SDK (_aws_sdk_ref/CognitoUser.java:3861-3868) は ConfirmDevice 呼び出しを
  // try/catch で包み、失敗時は例外を握りつぶして null を返す(best-effort)。その null を受け取った
  // 呼び出し元 (_aws_sdk_ref/CognitoUser.java:3140-3158) はデバイス未確定のまま onSuccess を
  // 呼び出し、ログイン自体は成功扱いにする(未確認 device はキャッシュされないだけ)。
  //
  // 本 kit では try/catch を設けず、ConfirmDevice 失敗(ネットワーク断・サーバエラー含む)を
  // loginVerify 全体の失敗として伝播させる(fail-fast)。理由: kit のトークン永続化モデルでは、
  // NewDeviceMetadata があるにもかかわらず deviceKey が null のまま保存されると、次回
  // REFRESH_TOKEN_AUTH が "Invalid Refresh Token" で落ちる。参照は Android SharedPreferences に
  // deviceKey/GroupKey/Password を別途キャッシュするため未確認でも後続処理が成立するが、
  // kit はトークンストアだけが状態の唯一の保持場所であり、未確認 device の永続化を防ぐには
  // fail-fast が最も安全な選択である。
  await cognitoCall("ConfirmDevice", {
    AccessToken: authResult.AccessToken,
    DeviceKey: meta.DeviceKey,
    DeviceName: hostname() || "sesame-cli",
    DeviceSecretVerifierConfig: { PasswordVerifier: passwordVerifier, Salt: salt },
  });

  return { deviceKey: meta.DeviceKey, deviceGroupKey: meta.DeviceGroupKey, devicePassword };
}

/**
 * DEVICE_SRP_AUTH → DEVICE_PASSWORD_VERIFIER の 2 段チャレンジに応答してトークンを得る。
 * amazon-cognito-identity-js の device 認証フローをそのまま再現 (公式アプリと同じ)。
 *
 * @param {object} args
 * @param {string} args.clientId
 * @param {string} args.username
 * @param {string|null|undefined} args.deviceKey
 * @param {string|null|undefined} args.deviceGroupKey
 * @param {string|null|undefined} args.devicePassword
 * @param {string|undefined} args.session
 * @returns {Promise<import("./cognito-http.js").CognitoAuthResult>} Cognito AuthenticationResult
 */
async function deviceSrpAuth({ clientId, username, deviceKey, deviceGroupKey, devicePassword, session }) {
  if (!deviceKey || !deviceGroupKey || !devicePassword) {
    // P5-1: 呼び出し側不正 (デバイス資格情報なし) = UNAUTHENTICATED + i18n 化。
    // loginVerify 経由の CLI パスが主。ConfirmDevice 未完了やトークン欠損で到達する。
    throw new SesameError(tr("auth.noDeviceCredentials"), { code: ERR.UNAUTHENTICATED });
  }

  const { a, A } = generateEphemeralA();

  // 1) SRP_A を送り、サーバから SRP_B / SALT / SECRET_BLOCK を受け取る。
  //    DEVICE_KEY を回答に含めるのは参照どおり (_aws_sdk_ref/CognitoUser.java:2919-2922 が
  //    全チャレンジ回答に注入する DEVICE_KEY と同じ配置)。
  const srp = await cognitoCall("RespondToAuthChallenge", {
    ClientId: clientId,
    ChallengeName: "DEVICE_SRP_AUTH",
    ...(session ? { Session: session } : {}),
    ChallengeResponses: { USERNAME: username, DEVICE_KEY: deviceKey, SRP_A: A.toString(16) },
  });
  if (srp.ChallengeName !== "DEVICE_PASSWORD_VERIFIER") {
    // P5-1 方針3: Cognito からの予期しないチャレンジ応答 (内部不変条件)。serve 非到達。
    throw new Error(`DEVICE_SRP_AUTH: unexpected challenge ${srp.ChallengeName}`);
  }
  const cp = srp.ChallengeParameters || {};

  // 2) HKDF 鍵を導出し、device password の所持証明 (PASSWORD_CLAIM_SIGNATURE) を送る。
  const { hkdf } = deviceAuthSecrets({
    deviceGroupKey,
    deviceKey,
    devicePassword,
    serverB: BigInt("0x" + cp.SRP_B),
    salt: BigInt("0x" + cp.SALT),
    a,
    A,
  });
  const timestamp = cognitoTimestamp();
  const signature = devicePasswordSignature({
    hkdf,
    deviceGroupKey,
    deviceKey,
    secretBlock: cp.SECRET_BLOCK,
    timestamp,
  });

  const verify = await cognitoCall("RespondToAuthChallenge", {
    ClientId: clientId,
    ChallengeName: "DEVICE_PASSWORD_VERIFIER",
    Session: srp.Session,
    ChallengeResponses: {
      USERNAME: cp.USERNAME || username,
      DEVICE_KEY: deviceKey,
      PASSWORD_CLAIM_SECRET_BLOCK: cp.SECRET_BLOCK,
      PASSWORD_CLAIM_SIGNATURE: signature,
      TIMESTAMP: timestamp,
    },
  });
  if (!verify.AuthenticationResult?.IdToken) {
    // P5-1 方針3: Cognito が IdToken を返さなかった (内部不変条件)。serve 非到達。
    throw new Error(`DEVICE_PASSWORD_VERIFIER failed: ${JSON.stringify(verify)}`);
  }
  return verify.AuthenticationResult;
}

/**
 * ログアウト。公式アプリは**ローカル signOut のみ**で、以下のサーバ側クリーンアップは
 * 本 kit の意図的な強化 (公式挙動の再現ではない):
 *   1. ForgetDevice — このデバイスの remembered 登録を解除 (ConfirmDevice の対。これが無いと
 *      login のたびに remembered device がアカウントに溜まり続ける)。
 *   2. RevokeToken  — この refresh token を失効 (ローカル削除だけでは生き残るため)。
 * サーバ呼び出しは best-effort (失敗してもローカルは必ず消す)。どちらも対象はこのセッション/
 * このデバイスのみで、公式アプリ等の別セッションには影響しない (GlobalSignOut は使わない)。
 *
 * @param {import("./tokens.js").TokenStore} store
 * @returns {Promise<{forgotDevice:boolean, revokedToken:boolean}>}
 */
export async function logout(store) {
  const t = store.load();
  const result = { forgotDevice: false, revokedToken: false };
  if (t) {
    const clientId = t.clientId || jwtAud(t.idToken) || DEFAULT_CLIENT_ID;

    // ForgetDevice には有効な AccessToken が要る。可能なら refresh で更新してから使う。
    if (t.deviceKey) {
      let accessToken = t.accessToken;
      try {
        await getValidIdToken(store, { marginSec: 300 });
        accessToken = store.load()?.accessToken || accessToken;
      } catch { /* refresh token 失効済みなら ForgetDevice は諦める */ }
      if (accessToken) {
        try {
          await cognitoCall("ForgetDevice", { AccessToken: accessToken, DeviceKey: t.deviceKey });
          result.forgotDevice = true;
        } catch { /* best-effort */ }
      }
    }

    // refresh で token がローテートされている可能性があるので最新を読み直して失効させる。
    const refreshToken = store.load()?.refreshToken || t.refreshToken;
    if (refreshToken) {
      try {
        await cognitoCall("RevokeToken", { Token: refreshToken, ClientId: clientId });
        result.revokedToken = true;
      } catch { /* best-effort */ }
    }
  }
  store.clear();
  store.clearPending();
  return result;
}

/**
 * 既存の localStorage ダンプから bootstrap (互換用)。
 *
 * @param {import("./tokens.js").TokenStore} store
 * @param {Partial<import("./tokens.js").StoredTokens>} values
 * @returns {import("./tokens.js").StoredTokens}
 */
export function bootstrap(store, values) {
  // P5-1 方針3: bootstrap は CLI の migrate パスのみ。serve 非到達。
  // 必須引数の欠落は呼び出し側のプログラマエラーとして plain Error を維持。
  if (!values.idToken)      throw new Error("idToken required");
  if (!values.refreshToken) throw new Error("refreshToken required");
  assertAppLoginTokens(values, "bootstrap input", { requireAud: true, requireConfirmedDevice: true });
  const t = {
    clientId: CONSUMER_CLIENT_ID,
    idToken:      values.idToken,
    refreshToken: values.refreshToken,
    accessToken:  values.accessToken || null,
    deviceKey:    values.deviceKey,
    deviceGroupKey: values.deviceGroupKey,
    devicePassword: values.devicePassword,
    username:     values.username    || null,
    lastRefresh:  new Date().toISOString(),
  };
  store.save(t);
  return t;
}

export const CONFIG_META = {
  region: COGNITO_REGION,
  userPoolId: USER_POOL_ID,
  consumerClientId: CONSUMER_CLIENT_ID,
};
