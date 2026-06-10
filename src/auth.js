// Cognito 認証。
//
// Ported from biz3 (CANDY-HOUSE/biz3, MIT):
//   - vendor reference: references_web/src/api/useAuthState.js (AWS Amplify Auth.signIn / Auth.signUp ベース)
//   - vendor reference: references_web/src/aws-exports.js (region / UserPool / Client ID)
//
// Amplify はブラウザ前提 (localStorage / IndexedDB) のため Node では使えず、
// @aws-sdk/client-cognito-identity-provider 直叩きに置換している。
// 振る舞いは biz3 と同じ:
//   - User Pool: ap-northeast-1_bY2byhlCa (biz / consumer 共有)
//   - CUSTOM_AUTH passwordless: USERNAME → CUSTOM_CHALLENGE (email にコード) → コード回答
//   - 新規ユーザーは dummy password "Aa123456" で SignUp してから sign-in (useAuthState.js:109-122)
//
// biz3 との機能的相違:
//   1. Client ID を biz3 の `21u50hboia4s5q0sbk6pbdfmss` から、公式
//      iOS/Android/chat.candyhouse.co と同じ Consumer Client
//      `6ialca0p8u0lsgvbmvsljfm305` に差し替え (アプリと同じトークン寿命)。
//   2. ログイン後に ConfirmDevice でデバイスを確定する (loginVerify / confirmDevice)。
//      デバイストラッキング有効 Pool では、これを省くと未確認の DEVICE_KEY で
//      REFRESH_TOKEN_AUTH が `Invalid Refresh Token` になり、idToken 失効後の初回
//      refresh で必ず落ちる。公式アプリ (Amplify) は自動で ConfirmDevice している。
//
// 状態は TokenStore (load/save/clear + loadPending/savePending/clearPending) に永続化を委譲。
// CLI からは FileTokenStore、ライブラリ消費者は独自実装を渡せる。

import {
  CognitoIdentityProviderClient,
  ConfirmDeviceCommand,
  ForgetDeviceCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  RevokeTokenCommand,
  SignUpCommand,
  UpdateDeviceStatusCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { hostname } from "node:os";
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
// 公式が新規 sign-up 時に使う ダミーパスワード (Cognito policy 通過用)
const DUMMY_PASSWORD = "Aa123456";

const cognito = new CognitoIdentityProviderClient({ region: COGNITO_REGION });

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
 * 失効まで `marginSec` 以下なら早期 refresh する (デフォルト 60秒)。
 *
 * @param {import("./tokens.js").TokenStore} store
 * @param {{ marginSec?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function getValidIdToken(store, { marginSec = 60 } = {}) {
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
    resp = await cognito.send(
      new InitiateAuthCommand({
        AuthFlow: "REFRESH_TOKEN_AUTH",
        ClientId: clientId,
        AuthParameters: authParameters,
      }),
    );
  } catch (e) {
    // refresh token 失効 (公式アプリで再ログイン等) は再ログインで復帰する認証エラー。
    // 構造化して上位 (CLI 等) が message 文字列マッチ無しで分岐できるようにする。
    if (asErr(e).name === "NotAuthorizedException") {
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
  if (r.RefreshToken) t.refreshToken = r.RefreshToken; // rotation 対応
  // refresh で稀にデバイスキーがローテートされる。来たら再 ConfirmDevice しないと
  // 未確認デバイス状態になり、次回 refresh が Invalid Refresh Token で落ちる。
  if (r.NewDeviceMetadata?.DeviceKey) {
    const device = await confirmDevice(r);
    if (device) {
      t.deviceKey = device.deviceKey;
      t.deviceGroupKey = device.deviceGroupKey;
      t.devicePassword = device.devicePassword;
    }
  }
  t.lastRefresh = new Date().toISOString();
  store.save(t);
  return t.idToken;
}

/**
 * Step 1: CUSTOM_AUTH を開始。Cognito が email に確認コードを送る。
 * 新規ユーザーの場合は SignUp してから retry。
 *
 * @param {import("./tokens.js").TokenStore} store
 * @param {string} username
 * @param {{ clientId?: string }} [opts] 互換用。Consumer Client 以外は拒否する。
 */
export async function loginInitiate(store, username, { clientId = DEFAULT_CLIENT_ID } = {}) {
  if (clientId !== CONSUMER_CLIENT_ID) {
    throw new SesameError(`Unsupported Cognito clientId ${clientId}. Use the SESAME consumer app client via \`sesame login <email>\`.`, { code: ERR.UNAUTHENTICATED });
  }
  // 同じユーザーの記憶済みデバイスがあれば DEVICE_KEY を渡す (公式アプリ=Amplify と同じ)。
  // Cognito はこれを見てコード回答後に DEVICE_SRP_AUTH を要求できる。
  const existing = store.load?.();
  /** @type {Record<string, string>} */
  const authParameters = { USERNAME: username };
  if (existing?.username === username && existing?.deviceKey) {
    authParameters.DEVICE_KEY = existing.deviceKey;
  }
  const initiate = () =>
    cognito.send(
      new InitiateAuthCommand({
        AuthFlow: "CUSTOM_AUTH",
        ClientId: clientId,
        AuthParameters: authParameters,
      }),
    );

  let resp;
  try {
    resp = await initiate();
  } catch (e) {
    if (asErr(e).name === "UserNotFoundException") {
      // 公式アプリと同じ自動 sign-up
      await cognito.send(
        new SignUpCommand({
          ClientId: clientId,
          Username: username,
          Password: DUMMY_PASSWORD,
        }),
      );
      resp = await initiate();
    } else {
      throw e;
    }
  }

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
  const resp = await cognito.send(
    new RespondToAuthChallengeCommand({
      ClientId: s.clientId,
      ChallengeName: "CUSTOM_CHALLENGE",
      Session: s.session,
      ChallengeResponses: {
        USERNAME: s.username,
        ANSWER: code,
      },
    }),
  );

  let r = resp.AuthenticationResult;
  let device;

  if (r) {
    // デバイストラッキングが有効な Pool では NewDeviceMetadata が返る。ConfirmDevice で
    // デバイスを確定しないと REFRESH_TOKEN_AUTH が `Invalid Refresh Token` で落ちる
    // (公式アプリ=Amplify は自動で ConfirmDevice する)。ここで同じ確定を行う。
    device = await confirmDevice(r);
  } else if (resp.ChallengeName === "DEVICE_SRP_AUTH") {
    // 記憶済みデバイスの SRP 認証 (公式アプリ=Amplify と同じ device password チャレンジ)。
    /** @type {Partial<import("./tokens.js").StoredTokens>} */
    const ex = store.load?.() || {};
    r = await deviceSrpAuth({
      clientId: s.clientId,
      username: resp.ChallengeParameters?.USERNAME || s.username,
      deviceKey: ex.deviceKey,
      deviceGroupKey: ex.deviceGroupKey,
      devicePassword: ex.devicePassword,
      session: resp.Session,
    });
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
 * NewDeviceMetadata を持つ認証結果に対し ConfirmDevice (+ 必要なら remembered 化) を行う。
 * デバイストラッキング無効の Pool では NewDeviceMetadata が無いので no-op。
 *
 * @param {import("@aws-sdk/client-cognito-identity-provider").AuthenticationResultType} authResult Cognito AuthenticationResult
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

  const resp = await cognito.send(
    new ConfirmDeviceCommand({
      AccessToken: authResult.AccessToken,
      DeviceKey: meta.DeviceKey,
      DeviceName: hostname() || "sesame-cli",
      DeviceSecretVerifierConfig: { PasswordVerifier: passwordVerifier, Salt: salt },
    }),
  );

  // User Opt-In Pool では確定だけでは remembered にならないため明示的に remembered 化する
  // (公式アプリの "このデバイスを記憶する" 相当)。これをしないと refresh が device に
  // 紐づかず失効する。
  if (resp.UserConfirmationNecessary) {
    await cognito.send(
      new UpdateDeviceStatusCommand({
        AccessToken: authResult.AccessToken,
        DeviceKey: meta.DeviceKey,
        DeviceRememberedStatus: "remembered",
      }),
    );
  }

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
 * @returns {Promise<import("@aws-sdk/client-cognito-identity-provider").AuthenticationResultType>} Cognito AuthenticationResult
 */
async function deviceSrpAuth({ clientId, username, deviceKey, deviceGroupKey, devicePassword, session }) {
  if (!deviceKey || !deviceGroupKey || !devicePassword) {
    throw new Error("DEVICE_SRP_AUTH requested but no stored device credentials. Re-run `sesame login`.");
  }

  const { a, A } = generateEphemeralA();

  // 1) SRP_A を送り、サーバから SRP_B / SALT / SECRET_BLOCK を受け取る。
  const srp = await cognito.send(
    new RespondToAuthChallengeCommand({
      ClientId: clientId,
      ChallengeName: "DEVICE_SRP_AUTH",
      ...(session ? { Session: session } : {}),
      ChallengeResponses: { USERNAME: username, DEVICE_KEY: deviceKey, SRP_A: A.toString(16) },
    }),
  );
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

  const verify = await cognito.send(
    new RespondToAuthChallengeCommand({
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
    }),
  );
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
          await cognito.send(new ForgetDeviceCommand({ AccessToken: accessToken, DeviceKey: t.deviceKey }));
          result.forgotDevice = true;
        } catch { /* best-effort */ }
      }
    }

    // refresh で token がローテートされている可能性があるので最新を読み直して失効させる。
    const refreshToken = store.load()?.refreshToken || t.refreshToken;
    if (refreshToken) {
      try {
        await cognito.send(new RevokeTokenCommand({ Token: refreshToken, ClientId: clientId }));
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
