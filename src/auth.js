// Cognito 認証。
//
// 規範 (REFACTORING_PLAN.md §0.1): ログイン/トークン管理は Android アプリ
// (AWSMobileClient 2.77.0 + CUSTOM_AUTH) のトレースとする。web (useAuthState.js) は使用禁止。
//   - 一次参照: AWSMobileClient 2.77.0 の CognitoUser.java / ChallengeContinuation.java /
//     CognitoIdentityProviderClientConfig.java (/tmp/aws-sdk-android/ に取得済み)
//   - アプリ側: _sesame_sdk_ref/app/.../account/LoginMailFG.kt (signUp 先行 + "dummypwk")
//
// AWS Mobile SDK は Android 前提のため Node では使えず、Cognito API を素 fetch
// (src/cognito-http.js, AWS JSON 1.1) で直叩きする。
// 振る舞いはアプリと同じ:
//   - User Pool: ap-northeast-1_bY2byhlCa (biz / consumer 共有)
//   - signUp 先行 (UsernameExistsException 容認) → CUSTOM_AUTH passwordless:
//     USERNAME → CUSTOM_CHALLENGE (email にコード) → コード回答 (LoginMailFG.kt:106-127)
//   - ログイン後に ConfirmDevice でデバイスを確定する (loginVerify / confirmDevice)。
//     デバイストラッキング有効 Pool では、これを省くと未確認の DEVICE_KEY で
//     REFRESH_TOKEN_AUTH が `Invalid Refresh Token` になり、idToken 失効後の初回
//     refresh で必ず落ちる。AWSMobileClient は handleChallenge 内で自動 ConfirmDevice
//     している (CognitoUser.java:3130-3140)。
//   - Client ID は公式 iOS/Android/chat.candyhouse.co と同じ Consumer Client
//     `6ialca0p8u0lsgvbmvsljfm305` (アプリと同じトークン寿命)。
//
// 状態は TokenStore (load/save/clear + loadPending/savePending/clearPending) に永続化を委譲。
// CLI からは FileTokenStore、ライブラリ消費者は独自実装を渡せる。

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

/**
 * catch 節の unknown を `{ name?, message? }` として安全に読むためのナロー化。
 * @param {unknown} e
 * @returns {{ name?: string, message?: string }}
 */
function asErr(e) {
  return /** @type {{ name?: string, message?: string }} */ (e ?? {});
}

/**
 * JWT を decode して exp を返す (秒、UNIX時間)。失敗時は 0。
 * @param {string} token
 * @returns {number}
 */
function jwtExp(token) {
  try {
    const payload = token.split(".")[1];
    const json = Buffer.from(payload, "base64").toString("utf8");
    return JSON.parse(json).exp || 0;
  } catch {
    return 0;
  }
}

/**
 * idToken の aud claim (= clientId) を返す。
 * @param {string} token
 * @returns {string|null}
 */
function jwtAud(token) {
  try {
    const payload = token.split(".")[1];
    const json = Buffer.from(payload, "base64").toString("utf8");
    return JSON.parse(json).aud || null;
  } catch {
    return null;
  }
}

/**
 * idToken の `sub` claim (= Cognito user UUID) を返す。
 * biz3 が `gStripe.customerInfo.subUUID` として使っている値と同じで、
 * `biz3TriggerLocker` の `history` フィールドに乗せる必要がある。
 * @param {string} token
 * @returns {string|null}
 */
export function jwtSub(token) {
  try {
    const payload = token.split(".")[1];
    const json = Buffer.from(payload, "base64").toString("utf8");
    return JSON.parse(json).sub || null;
  } catch {
    return null;
  }
}

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
 * CognitoIdentityProviderClientConfig.java:40)。
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
    throw new SesameError("idToken expired and no refreshToken. Re-run login.", { code: ERR.UNAUTHENTICATED });
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
    // する (CognitoUser.java:1306-1311)。同じく保存済みトークンを破棄して、失効トークンで
    // 以後のリクエストが落ち続けるのを防ぐ。pending verify 状態 (loginStatePath) は
    // 進行中の再ログインを壊さないよう残す (clearPending しない)。
    // 構造化して上位 (CLI 等) が message 文字列マッチ無しで分岐できるようにする。
    const name = asErr(e).name;
    if (name === "NotAuthorizedException" || name === "UserNotFoundException") {
      store.clear();
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
  // 参照 SDK は refresh 後も旧 refresh token を維持する (CognitoUser.java:2873-2874) が、
  // ここは refresh token rotation (AWS 新機能) への前方互換として、応答に新 token が
  // 来たら意図的に取り込む (意図的逸脱)。
  if (r.RefreshToken) t.refreshToken = r.RefreshToken;
  t.lastRefresh = new Date().toISOString();
  store.save(t);
  return t.idToken;
}

/**
 * Step 1: アプリと同じ「signUp 先行 → CUSTOM_AUTH 開始」(LoginMailFG.kt:106-127 の 1:1)。
 * Cognito が email に確認コードを送る。
 *
 * フロー (アプリ忠実):
 *   1. SignUp (Password="dummypwk", UserAttributes=[{Name:"email"}]) を常に先に実行。
 *      既存ユーザーの UsernameExistsException は容認して signIn へ進む
 *      (LoginMailFG.kt:114-118)。
 *   2. InitiateAuth (CUSTOM_AUTH, AuthParameters={USERNAME})。
 *      DEVICE_KEY は initiate には入れない — 参照 SDK の initiateCustomAuthRequest は
 *      DEVICE_KEY を同梱しない (CognitoUser.java:3473-3507)。DEVICE_KEY は全チャレンジ
 *      回答側に注入される (CognitoUser.java:2919-2922 / ChallengeContinuation.java:160-167)。
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
  // (LoginMailFG.kt:106-127)。
  try {
    await cognitoCall("SignUp", {
      ClientId: clientId,
      Username: username,
      Password: DUMMY_PASSWORD,
      UserAttributes: [{ Name: "email", Value: username }], // LoginMailFG.kt:106-107
    });
  } catch (e) {
    if (asErr(e).name !== "UsernameExistsException") throw e;
  }

  const resp = await cognitoCall("InitiateAuth", {
    AuthFlow: "CUSTOM_AUTH",
    ClientId: clientId,
    AuthParameters: { USERNAME: username },
  });

  if (resp.ChallengeName !== "CUSTOM_CHALLENGE") {
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
 * Step 2: email で受け取ったコードで CUSTOM_CHALLENGE を回答。
 * 成功するとトークンを保存し、pending 状態を消す。
 *
 * @param {import("./tokens.js").TokenStore} store
 * @param {string} code
 */
export async function loginVerify(store, code) {
  const s = store.loadPending();
  if (!s) {
    throw new Error(tr("auth.noPending"));
  }
  // 参照 SDK は全チャレンジ回答に保存済み DEVICE_KEY を注入する
  // (CognitoUser.java:2919-2922 respondToChallenge / ChallengeContinuation.java:160-167)。
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
    // (参照 SDK は handleChallenge 内で自動 ConfirmDevice する: CognitoUser.java:3130-3140)。
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
        // 認証フローを最初からやり直す (CognitoUser.java:3384-3396)。同じく失効した
        // device 3 点 (deviceKey/deviceGroupKey/devicePassword) を破棄し、デバイス無しの
        // CUSTOM_AUTH を最初から再試行する。これをしないと「失効 → 再ログイン → 古い
        // device で再失敗」が無限ループする。
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
    throw new Error(tr("auth.wrongCodeRetry"));
  } else if (resp.ChallengeName) {
    throw new Error(tr("auth.anotherChallenge", { name: resp.ChallengeName }));
  } else {
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
  return tokens;
}

/**
 * NewDeviceMetadata を持つ認証結果に対し ConfirmDevice を行う。
 * デバイストラッキング無効の Pool では NewDeviceMetadata が無いので no-op。
 *
 * 参照 SDK は ConfirmDevice のみで、UserConfirmationNecessary でも UpdateDeviceStatus
 * ("remembered" 化) は行わない (CognitoUser.java:3140-3151 は newDevice を callback に
 * 渡すだけ)。旧実装の remembered 化分岐は参照に無い独自防御だったため削除した。
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
    throw new Error("device confirmation failed: auth result has NewDeviceMetadata but no AccessToken");
  }

  const { devicePassword, passwordVerifier, salt } = generateDeviceVerifier(
    meta.DeviceGroupKey,
    meta.DeviceKey,
  );

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
    throw new Error("DEVICE_SRP_AUTH requested but no stored device credentials. Re-run `sesame login`.");
  }

  const { a, A } = generateEphemeralA();

  // 1) SRP_A を送り、サーバから SRP_B / SALT / SECRET_BLOCK を受け取る。
  //    DEVICE_KEY を回答に含めるのは参照どおり (CognitoUser.java:2919-2922 が全チャレンジ
  //    回答に注入する DEVICE_KEY と同じ配置)。
  const srp = await cognitoCall("RespondToAuthChallenge", {
    ClientId: clientId,
    ChallengeName: "DEVICE_SRP_AUTH",
    ...(session ? { Session: session } : {}),
    ChallengeResponses: { USERNAME: username, DEVICE_KEY: deviceKey, SRP_A: A.toString(16) },
  });
  if (srp.ChallengeName !== "DEVICE_PASSWORD_VERIFIER") {
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
    throw new Error(`DEVICE_PASSWORD_VERIFIER failed: ${JSON.stringify(verify)}`);
  }
  return verify.AuthenticationResult;
}

/**
 * ログアウト。公式アプリ相当にサーバ側もクリーンにする:
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
