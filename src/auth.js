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
// biz3 との唯一の機能的相違: Client ID を biz3 の `21u50hboia4s5q0sbk6pbdfmss` から、
// 公式 iOS/Android/chat.candyhouse.co と同じ Consumer Client `6ialca0p8u0lsgvbmvsljfm305` に
// 差し替え。これで refreshToken が事実上失効しなくなる。
//
// 状態は TokenStore (load/save/clear + loadPending/savePending/clearPending) に永続化を委譲。
// CLI からは FileTokenStore、ライブラリ消費者は独自実装を渡せる。

import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";
// i18n はエラーメッセージ文言の外出しだけに使用 (auth ロジックは不可侵)。
// この関数内のローカル変数 `t` (= store.load()) と衝突しないよう `tr` で取り込む。
import { t as tr } from "./i18n.js";

const COGNITO_REGION = "ap-northeast-1";
const USER_POOL_ID = "ap-northeast-1_bY2byhlCa";
// 公式アプリ (iOS/Android Sesame, chat.candyhouse.co) と同じ client。
// biz3 aws-exports.js:5 の userPoolWebClientId と一致 (一次資料で確認済み)。
export const CONSUMER_CLIENT_ID = "6ialca0p8u0lsgvbmvsljfm305";
// 注 (出所未確認): biz.candyhouse.co の管理 web client とされる値だが、
// biz3 の現行ソース (references_web) には 1 件も現れない (旧実装由来の値)。
// デフォルトでは使われず export のみ。biz3 web 自体も aws-exports の consumer client を使う。
export const BIZ_CLIENT_ID = "21u50hboia4s5q0sbk6pbdfmss";
// デフォルトは consumer (公式アプリと同じ寿命)
const DEFAULT_CLIENT_ID = CONSUMER_CLIENT_ID;
// 公式が新規 sign-up 時に使う ダミーパスワード (Cognito policy 通過用)
const DUMMY_PASSWORD = "Aa123456";

const cognito = new CognitoIdentityProviderClient({ region: COGNITO_REGION });

/** JWT を decode して exp を返す (秒、UNIX時間)。失敗時は 0。 */
function jwtExp(token) {
  try {
    const payload = token.split(".")[1];
    const json = Buffer.from(payload, "base64").toString("utf8");
    return JSON.parse(json).exp || 0;
  } catch {
    return 0;
  }
}

/** idToken の aud claim (= clientId) を返す。 */
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

/**
 * 失効していない idToken を返す。必要なら refresh する。
 * 失効まで `marginSec` 以下なら早期 refresh する (デフォルト 60秒)。
 *
 * @param {{load:Function, save:Function}} store
 */
export async function getValidIdToken(store, { marginSec = 60 } = {}) {
  const t = store.load();
  if (!t) {
    throw new Error(tr("auth.noTokens"));
  }

  const now = Math.floor(Date.now() / 1000);
  const exp = jwtExp(t.idToken);
  if (t.idToken && exp - now > marginSec) {
    return t.idToken;
  }

  if (!t.refreshToken) {
    throw new Error("idToken expired and no refreshToken. Re-run login.");
  }

  const clientId = t.clientId || DEFAULT_CLIENT_ID;
  const authParameters = { REFRESH_TOKEN: t.refreshToken };
  if (t.deviceKey) authParameters.DEVICE_KEY = t.deviceKey;

  const resp = await cognito.send(
    new InitiateAuthCommand({
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: clientId,
      AuthParameters: authParameters,
    }),
  );

  const r = resp.AuthenticationResult;
  if (!r?.IdToken) {
    throw new Error(`Cognito refresh returned no IdToken: ${JSON.stringify(resp)}`);
  }

  t.idToken = r.IdToken;
  if (r.AccessToken)  t.accessToken  = r.AccessToken;
  if (r.RefreshToken) t.refreshToken = r.RefreshToken; // rotation 対応
  t.lastRefresh = new Date().toISOString();
  store.save(t);
  return t.idToken;
}

/**
 * Step 1: CUSTOM_AUTH を開始。Cognito が email に確認コードを送る。
 * 新規ユーザーの場合は SignUp してから retry。
 *
 * @param {{savePending:Function}} store
 */
export async function loginInitiate(store, username, { clientId = DEFAULT_CLIENT_ID } = {}) {
  const initiate = () =>
    cognito.send(
      new InitiateAuthCommand({
        AuthFlow: "CUSTOM_AUTH",
        ClientId: clientId,
        AuthParameters: { USERNAME: username },
      }),
    );

  let resp;
  try {
    resp = await initiate();
  } catch (e) {
    if (e.name === "UserNotFoundException") {
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
 * @param {{loadPending:Function, save:Function, clearPending:Function}} store
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

  if (!resp.AuthenticationResult) {
    if (resp.ChallengeName) {
      throw new Error(tr("auth.anotherChallenge", { name: resp.ChallengeName }));
    }
    throw new Error(`No AuthenticationResult: ${JSON.stringify(resp)}`);
  }

  const r = resp.AuthenticationResult;
  const tokens = {
    clientId: s.clientId,
    idToken: r.IdToken,
    refreshToken: r.RefreshToken,
    accessToken: r.AccessToken,
    deviceKey: r.NewDeviceMetadata?.DeviceKey || null,
    deviceGroupKey: r.NewDeviceMetadata?.DeviceGroupKey || null,
    username: s.username,
    lastRefresh: new Date().toISOString(),
  };
  store.save(tokens);
  store.clearPending();
  return tokens;
}

/**
 * 既存の localStorage ダンプから bootstrap (互換用)。
 *
 * @param {{save:Function}} store
 */
export function bootstrap(store, values) {
  if (!values.idToken)      throw new Error("idToken required");
  if (!values.refreshToken) throw new Error("refreshToken required");
  const clientId = jwtAud(values.idToken) || DEFAULT_CLIENT_ID;
  const t = {
    clientId,
    idToken:      values.idToken,
    refreshToken: values.refreshToken,
    accessToken:  values.accessToken || null,
    deviceKey:    values.deviceKey   || null,
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
  bizClientId: BIZ_CLIENT_ID,
};
