// SESAME Touch (Pro) のアクセス制御データ管理 — NFC カード / キーパッド暗証番号 (passcode)。
//
// Ported from biz3 (CANDY-HOUSE/biz3, MIT):
//   - vendor reference: references_web/src/api/useManageAuthData.js
//
// すべての op は WS action `biz3ManageAccessCtlAuthData` 上で動き、op で分岐する。
// ログイン済みセッションでサーバ側 DB を操作する層で、ここは「WS の DB 同期 op」に専念する。
//
// ⚠️ 2層構造の注意 (biz3 の設計):
//   カード/パスコードの実ファームウェア書き込みは BLE (iotCmd, topic=`stp${uuid}cmd`) 経由で行い、
//   本モジュールの WS op は「サーバ DB 側の同期」を担う。実機への add/delete の物理書き込みは
//   別モジュール (biz3OperateIoT 系) の責務であり、ここでは扱わない。
//   biz3 では BLE で実機を変更 → その ack コールバック内で本 WS op を投げて DB を追従させる。
//
//   ★ この CLI での BLE 経路の実体: src/ble/biometric.js (BiometricCommands)。
//     SesameBle.biometric.{cardAdd,cardDelete,cardBatchAdd,passcodeAdd,passcodeDelete,
//     passcodeBatchAdd,...} が実機への物理書き込みを行い、その完了後に本モジュールの
//     postCards/postPasscodes/delCards/delPasscodes で DB を追従させる (biz3 と同じ 2 段)。
//     旧称の「iotCmd / biz3OperateIoT」= SesameBle.biometric (BLE 直結経路) と読み替える。
//
//   ★ enroll (実機タップ登録) → DB 同期の実結線: BLE 側で出揃った登録レコードを本モジュールの
//     syncEnrolledCards/syncEnrolledPasscodes へ渡す。
//     BLE 側の集約は src/ble/biometric.js の createEnrollCollector / BiometricCommands.onEnroll が
//     行い、その onEnrolled コールバック内で本関数を呼ぶ (BLE→cloud の責務境界はその境目)。
//     タップ登録 (records) は biz3 と同じく ack の nameUUID を使った updateCardName 委譲、
//     一括投入 (list) のみ postCards/postPasscodes 委譲 (詳細は各関数の JSDoc)。
//
// ⚠️ 取得 (getCards/getPasscodes) の応答は **2系統** で届く (useManageAuthData.js:116-191):
//   (1) 完了通知:  { action, op:'getCards' }            ← data 本体なし。fetch 完了の合図のみ。
//   (2) データ本体: { action, op:'pubCardLinkedIDs', data:{ deviceUUID, page, list } }
//                  ← page===1 で list 置換、それ以外は累積 (ページング)。
//   passcode は op が 'getPasscodes' / 'pubPasscodeLinkedIDs' になる (同型)。
//   (1)/(2) の到着順序は参照から導出できず **未確認** (REFACTORING_PLAN §9 V8)。完了通知が
//   先に届く逆順サーバも許容するため、fetchAuthData は欠落デバイスがある間は短い grace
//   window で残 push を吸収してから確定する (P3-12)。

import { ACTION_TYPES } from "../vendor/biz3/constants/messageConstants.js";
import { assertSuccess, subscribeChunks, timeoutError, badRequest, rejected } from "./util.js";
import { t } from "./i18n.js";
import { generateUUID } from "./crypto.js";
import {
  makeCognitoCredentialsProvider,
  makeApiGatewayTransport,
  DEFAULT_CH_API_BASE_URL,
} from "./aws-credentials.js";

// action 文字列は vendor (biz3 messageConstants:9) から引く (手書きしない)。
const ACTION = ACTION_TYPES.BIZ3_MANAGE_AC_AUTHDATA; // "biz3ManageAccessCtlAuthData"

// async push の応答 op 名。biz3utils 由来の定数 (useManageAuthData.js:12-13)。
const PUB_CARD_LINKED_IDS = "pubCardLinkedIDs";
const PUB_PASSCODE_LINKED_IDS = "pubPasscodeLinkedIDs";

const DEFAULT_TIMEOUT_MS = 15_000;
// 完了通知が pub データ push より先に届いた場合に残 push を吸収する猶予 (P3-12)。
// 到着順序は参照から導出できないため (§9 V8)、逆順でも黙って空成功にならないよう設ける。
const DEFAULT_COMPLETION_GRACE_MS = 300;
const BIOMETRICS_PATH = "/device/v1/biometrics";

/**
 * REST /device/v1/biometrics transport の 1 リクエスト/応答。
 * @typedef {(req:{method:string,path:string,body?:object})=>Promise<{status:number,text:string,json:any}>} BiometricsTransport
 */

/**
 * 認証情報を含む biometrics transport 構築オプション。
 * 正準は SigV4 (credentialsProvider / getIdToken)。authorization 系は参照に無い互換注入口
 * (非推奨。makeBiometricsTransport の注記参照)。
 * @typedef {object} BiometricsAuthOptions
 * @property {BiometricsTransport} [transport] 既製 transport を注入 (テスト/特殊環境用)。
 * @property {string} [baseUrl] REST ルート URL (https のみ。既定 https://app.candyhouse.co/prod)。
 * @property {import("./aws-credentials.js").CredentialsProviderLike} [credentialsProvider] Identity Pool 一時 credentials の供給元。
 * @property {() => Promise<string>} [getIdToken] idToken 供給コールバック (credentialsProvider を内部構築)。
 * @property {string|null} [appIdentifyId] [互換・無視] /device/v1/biometrics に appidentifyid ヘッダは無い (CHAPIClient.kt:105-106。バックログ8)。
 * @property {import("./aws-credentials.js").AppIdConfigLike|null} [config] [互換・無視] 同上 (appidentifyid を付けないため未使用)。
 * @property {import("./aws-credentials.js").AppIdConfigStoreLike|null} [configStore] [互換・無視] 同上。
 * @property {string} [apiKey] x-api-key (省略時 app.properties:5 の実値)。
 * @property {string} [authorization] [非推奨] 完成済み Authorization ヘッダ値。
 * @property {string} [bearerToken] [非推奨] Bearer トークン (ヘッダ未指定時)。
 * @property {() => Promise<string>} [authorizationProvider] [非推奨] 都度 Authorization を解決する関数。
 * @property {typeof fetch} [fetchImpl] fetch 実装 (テスト差し替え用)。
 */

/**
 * postAuthenticationData/putAuthenticationData/deleteAuthenticationData の params。
 * operation/deviceID は実行時に検証 (withSuffix が欠落で throw) するため型上は optional。
 * @typedef {BiometricsAuthOptions & {operation?:string, deviceID?:string, items?:object[]}} AuthDataParams
 */

/**
 * updateAuthenticationName の params。request を直接渡すか kind から組み立てる。
 * @typedef {BiometricsAuthOptions & {
 *   request?: object,
 *   kind?: 'card'|'face'|'fingerPrint'|'palm'|'passcode',
 *   timestamp?: number,
 *   subUUID?: string,
 *   stpDeviceUUID?: string,
 *   name?: string,
 *   nameUUID?: string,
 *   op?: string,
 *   type?: number,
 *   cardType?: number,
 *   cardNameUUID?: string,
 *   cardID?: string,
 *   faceNameUUID?: string,
 *   faceID?: string,
 *   fingerPrintNameUUID?: string,
 *   fingerPrintID?: string,
 *   palmNameUUID?: string,
 *   palmID?: string,
 *   keyBoardPassCodeNameUUID?: string,
 *   keyBoardPassCode?: string,
 * }} UpdateAuthNameParams
 */

/** @param {string} value @returns {string} */
function stripTrailingSlashes(value) {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 0x2f) end -= 1;
  return value.slice(0, end);
}

/** @param {unknown} baseUrl @returns {string} */
function normalizeBiometricsBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(String(baseUrl));
  } catch {
    throw badRequest("access.err.biometricsBaseUrlInvalid");
  }
  if (url.protocol !== "https:") throw badRequest("access.err.biometricsHttpsRequired");
  if (url.username || url.password || url.search || url.hash) {
    throw badRequest("access.err.biometricsBaseUrlInvalid");
  }
  const path = stripTrailingSlashes(url.pathname || "");
  return `${url.origin}${path === "/" ? "" : path}`;
}

/** @param {{status?:number, json?:any, text?:string}} res @param {string} op */
function assertHttpOk(res, op) {
  const status = res?.status;
  if (typeof status !== "number" || status < 200 || status >= 300) {
    const detail = res?.json?.message
      || (typeof res?.text === "string" && res.text)
      || (res?.json != null ? JSON.stringify(res.json) : "");
    throw rejected(`biometrics ${op} failed: HTTP ${status ?? "?"}${detail ? ` ${detail}` : ""}`, { status: status ?? null });
  }
}

/**
 * Kotlin SDK の CHAPIClient#biometricsOperation と同じ POST /device/v1/biometrics transport。
 *
 * 認可は公式アプリと同じ「SigV4 (Cognito Identity Pool の一時 credentials) + x-api-key」
 * (REFACTORING_PLAN P2-1 / BIZ-07。基盤 = src/aws-credentials.js + src/sigv4.js):
 *   - ApiClientConfigBuilder.kt:34-46 — credentialsProvider + apiKey + region
 *   - BaseApp.kt:95-102 — credentialsProvider = AWSMobileClient.getInstance(),
 *     apiKey = BuildConfig.API_GATEWAY_API_KEY
 *   - ホストは app.properties:3 (https://app.candyhouse.co/prod) を既定とする。
 * credentialsProvider か getIdToken (idToken 供給コールバック) のどちらかで SigV4 経路になる。
 *
 * appidentifyid は付けない (バックログ8: per-op 化)。POST /device/v1/biometrics
 * (CHAPIClient.kt:105-106 biometricsOperation) には @Parameter(name="appidentifyid") が無い
 * (付くのは /device 直下の鍵 CRUD・/device/list・/friend 系・/web_route のみ —
 * 全列挙表: aws-credentials.js makeApiGatewayTransport 冒頭)。旧実装は常時付与していたが
 * 参照より広かったため撤去。appIdentifyId / config / configStore は互換のため受理するが無視。
 *
 * 互換 (非推奨): authorization / bearerToken / authorizationProvider は Authorization ヘッダを
 * そのまま付ける旧経路。参照 SDK に idToken Bearer の REST 認可は存在せず実 API Gateway
 * (IAM 認可) には拒否される見込みのため、SesameClient (client.js:921) が SigV4 へ移行する
 * までの互換注入口としてのみ残す。
 *
 * @experimental SigV4 経路の実機 API Gateway での受理は未検証 (REFACTORING_PLAN §9 V4/V5)。
 *
 * @param {BiometricsAuthOptions} opts
 * @returns {BiometricsTransport}
 */
export function makeBiometricsTransport({
  baseUrl = DEFAULT_CH_API_BASE_URL,
  credentialsProvider,
  getIdToken,
  apiKey,
  authorization,
  bearerToken,
  authorizationProvider,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") throw badRequest("access.err.fetchRequired");
  const root = normalizeBiometricsBaseUrl(baseUrl || DEFAULT_CH_API_BASE_URL);

  // ---- 正準経路: SigV4 + x-api-key (devices.js register と同じ基盤) ----
  if (credentialsProvider || typeof getIdToken === "function") {
    const provider = credentialsProvider
      || makeCognitoCredentialsProvider({
        getIdToken: /** @type {() => Promise<string>} */ (getIdToken),
        fetchImpl,
      });
    return makeApiGatewayTransport({
      baseUrl: root,
      credentialsProvider: provider,
      // appIdentifyId は渡さない (既定 null = ヘッダ無し)。/device/v1/biometrics に
      // appidentifyid は参照に存在しない (CHAPIClient.kt:105-106)。
      apiKey,
      fetchImpl,
    });
  }

  // ---- 互換経路 (非推奨): 呼び出し側が組んだ Authorization をそのまま付ける ----
  if (!authorization && !bearerToken && typeof authorizationProvider !== "function") {
    throw badRequest("access.err.biometricsAuthorizationRequired");
  }
  return async ({ method, path, body }) => {
    // 上の guard で authorization / bearerToken / authorizationProvider のいずれかは必ず存在する。
    const auth = authorization
      || (bearerToken ? `Bearer ${bearerToken}` : await /** @type {() => Promise<string>} */ (authorizationProvider)());
    const res = await fetchImpl(`${root}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "authorization": auth,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    return { status: res.status, text, json };
  };
}

/** @param {BiometricsAuthOptions} opts @returns {BiometricsTransport} */
function resolveBiometricsTransport({ transport, ...opts }) {
  if (typeof transport === "function") return transport;
  return makeBiometricsTransport(opts);
}

/**
 * operation に op サフィックスを連結する。
 * Kotlin SDK は `request.operation += "_post"` のように **無条件連結** する
 * (CHDataSynchronizeCapableImpl.kt:17,32,44)。既に suffix が付いていても二重連結になるのが
 * 参照の挙動なので、ここでも条件分岐せず 1:1 で連結する (BIZ-08)。
 * operation 欠落時の throw は kit 側の入力検証 (参照は型で非 null を保証)。
 * @param {string|undefined} operation @param {string} suffix @returns {string}
 */
function withSuffix(operation, suffix) {
  if (!operation) throw badRequest("access.err.operationRequired");
  return `${operation}${suffix}`;
}

/** @param {BiometricsTransport} transport @param {object} body @param {string} opLabel */
async function postBiometrics(transport, body, opLabel) {
  const res = await transport({ method: "POST", path: BIOMETRICS_PATH, body });
  // injected test transports may return the already-unwrapped body.
  if (!res || typeof res.status !== "number") return res;
  assertHttpOk(res, opLabel);
  return res.json ?? res.text ?? null;
}

// ---------- 内部: getXxx (完了通知 + pub データ push の集約) ----------

/**
 * getCards / getPasscodes を投げ、pub*LinkedIDs の async push をページング集約して返す共通処理。
 *
 * biz3 (useManageAuthData.js:50-63,116-132,176-191) のフロー:
 *   1. { action, obj:{ devices: 'uuid1,uuid2,...' }, op } を送信 (devices はカンマ連結文字列)。
 *   2. サーバは対象デバイスごとに op='pubCardLinkedIDs'/'pubPasscodeLinkedIDs' で
 *      { data:{ deviceUUID, page, list } } を複数回 push (page でページング)。
 *   3. 完了通知 { op:'getCards'/'getPasscodes' } (data 無し) が届く。
 *      ⚠️ 完了通知と pub push の到着順序は参照 (web は両方を独立に処理するだけ) から
 *      導出できず **未確認** (REFACTORING_PLAN §9 V8)。「完了通知は必ず全 push の後」とは
 *      仮定しない。
 *
 * CLI では (1) 送信 → (2) pub を集約 → (3) 完了通知 or timeout で確定、という流れで
 * デバイス横断の一覧をまとめて返す。biz3 の handleDeviceCardData (124-131) と同じく
 * deviceUUID ごとに page===1 で置換 / それ以外で追記する。
 * (3) では要求 deviceUUIDs が byDevice に揃っているかを検査し、欠落がある場合のみ
 * graceMs の grace window で残 push を吸収してから確定する (P3-12。逆順サーバでも
 * 黙って空成功にならない)。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {object} cfg
 * @param {string} cfg.op            送信 op ('getCards' | 'getPasscodes')
 * @param {string} cfg.pubOp         データ push の op ('pubCardLinkedIDs' | 'pubPasscodeLinkedIDs')
 * partialOnTimeout (BIZ-14 / バックログ6, オプトイン): true なら timeout 時に reject せず、
 * その時点までの蓄積を `{partial:true, byDevice, items}` で resolve する (util.subscribeChunks
 * の同名オプションに透過。参照 UI は pub push のたびに表示へ反映するため、完了通知が来なくても
 * 部分蓄積が残る — useManageAuthData.js:116-131 / useManageEmployee.js:70-88 と同パターン)。
 * 指定時は完走しても `{partial:false, ...}` の同 shape で返る。既定 (false) は従来どおり reject。
 *
 * @param {string} cfg.idKey         集約キー ('cardID' | 'passwordID')
 * @param {string[]} cfg.deviceUUIDs 対象 deviceUUID 配列
 * @param {number} cfg.timeoutMs
 * @param {number} [cfg.graceMs]     完了通知時に欠落デバイスがある場合の残 push 吸収猶予 (テスト注入用)
 * @param {boolean} [cfg.partialOnTimeout] timeout 時に部分結果で resolve (オプトイン)
 * @returns {Promise<{byDevice: Record<string, object[]>, items: object[], partial?:boolean}>}
 *   byDevice: deviceUUID → そのデバイスに紐づく要素配列
 *   items:    idKey 単位に集約し uuids(=該当 deviceUUID 群) を付与した横断リスト
 */
async function fetchAuthData(client, { op, pubOp, idKey, deviceUUIDs, timeoutMs, graceMs = DEFAULT_COMPLETION_GRACE_MS, partialOnTimeout = false }) {
  if (!Array.isArray(deviceUUIDs) || deviceUUIDs.length === 0) {
    return partialOnTimeout ? { partial: false, byDevice: {}, items: [] } : { byDevice: {}, items: [] };
  }
  const deviceIds = deviceUUIDs.join(","); // biz3: devices.map(d=>d.deviceUUID).join(',') (54)

  /** @type {Record<string, object[]>} deviceUUID → list (ページング累積) */
  const byDevice = {};
  // 完了通知後の grace timer (欠落デバイスがある時のみ起動。finish は冪等なので多重発火は無害)。
  // タイマーは Promise 解決後に .finally で必ずクリアする (タイマーリーク防止 — P3-7)。
  /** @type {ReturnType<typeof setTimeout>|null} */
  let graceTimer = null;
  // 「(1) 取得 send → (2) pub データ push を集約 → (3) 完了通知 op で確定」の 2 購読モデル。
  // ライフサイクル (Promise/cleanup/timeout/二重解決) は util.subscribeChunks に委譲する。
  //
  // ⚠️ ページ粒度は grace 保護対象外 (P3-7 §9 V8):
  //   grace window は「要求デバイスへの pub が 1 件も届いていない (byDevice[u] === undefined)」
  //   場合のみ起動する。完了通知より後に届く page≥2 の追加ページは保護されない。
  //   参照 (useManageAuthData.js:179-185) は完了通知を受けたら即 done:true とするのみで
  //   ページ継続を保護する機構を持たないため、本挙動は参照に整合する (逸脱なし)。
  return subscribeChunks(client, {
    // (1) 取得リクエスト送信 (useManageAuthData.js:55-62)。obj.devices にカンマ連結文字列。
    sendFrame: { action: ACTION, obj: { devices: deviceIds }, op },
    timeoutMs,
    onTimeout: () => timeoutError(t("access.err.opTimeout", { op })),
    partialOnTimeout,
    // partialOnTimeout 時は partial:false を含めて shape を固定 (timeout 確定時は
    // subscribeChunks 側の spread が partial:true へ上書きする)。
    result: () => (partialOnTimeout
      ? { partial: false, byDevice, items: aggregate(byDevice, idKey) }
      : { byDevice, items: aggregate(byDevice, idKey) }),
    subscriptions: [
      // (2) データ本体 push の集約 (useManageAuthData.js:116-131)。完了はさせない
      //     (完了通知後の残 push も grace window 内ならここで吸収される)。
      {
        key: `${ACTION}:${pubOp}`,
        onMessage: (msg) => {
          const data = msg?.data;
          if (!data) return;
          const { deviceUUID, page, list = [] } = data;
          if (!deviceUUID) return;
          const current = byDevice[deviceUUID] || [];
          // page===1 なら置換、それ以外は累積 (biz3:126)。
          byDevice[deviceUUID] = page === 1 ? [...list] : [...current, ...list];
        },
      },
      // (3) 完了通知 (useManageAuthData.js:179-185)。data 本体は無い。
      //     要求した全デバイスの push が揃っていれば即確定。欠落があれば graceMs だけ
      //     残 push を吸収してから確定する (到着順序が未確認のため。§9 V8)。
      //     注: データ 0 件のデバイスには pub が来ない可能性もあるため、欠落時も
      //     reject はせず grace 経過後に手持ちの結果で resolve する。
      {
        key: `${ACTION}:${op}`,
        onMessage: (_msg, finish) => {
          const missing = deviceUUIDs.some((u) => byDevice[u] === undefined);
          if (!missing) { finish(); return; }
          if (graceTimer == null) graceTimer = setTimeout(() => finish(), graceMs);
        },
      },
    ],
  // graceTimer は subscribeChunks 内部の cleanup では clear できないため、Promise 解決後に
  // 必ず clearTimeout する (タイムアウトによる reject / 即時 finish / grace 完了のいずれでも動作)。
  // 既に発火済みの場合は clearTimeout は無害 (P3-7)。
  }).finally(() => { if (graceTimer != null) clearTimeout(graceTimer); });
}

/**
 * deviceUUID ごとの list を idKey 単位に集約し、uuids(該当 deviceUUID 群)を付与する。
 * biz3 nfcCards / passcodes useMemo (useManageAuthData.js:134-174) と同じ集約ロジック。
 * @param {Record<string, object[]>} byDevice
 * @param {string} idKey 'cardID' | 'passwordID'
 * @returns {object[]}
 */
function aggregate(byDevice, idKey) {
  /** @type {Record<string, Set<string>>} */
  const idMap = {};
  /** @type {Array<Record<string, unknown>>} */
  const cards = [];
  for (const [deviceUUID, list] of Object.entries(byDevice)) {
    for (const card of /** @type {Array<Record<string, unknown>>} */ (list)) {
      const id = String(card[idKey]);
      if (!idMap[id]) idMap[id] = new Set();
      idMap[id].add(deviceUUID);
      cards.push(card);
    }
  }
  return cards.map((card) => ({ ...card, uuids: Array.from(idMap[String(card[idKey])]) }));
}

// ---------- カード: 取得 ----------

/**
 * 対象デバイスの NFC カード一覧を取得する。
 * 応答は op='pubCardLinkedIDs' の async push で deviceUUID/page ごとに届くため、
 * 内部で集約してから完了通知 or timeout で確定する (useManageAuthData.js:50-191)。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{deviceUUIDs:string[], timeoutMs?:number, graceMs?:number, partialOnTimeout?:boolean}} params
 *   graceMs: 完了通知が pub より先行した場合の残 push 吸収猶予 (既定 300ms。テスト注入用)。
 *   partialOnTimeout: true なら timeout 時に reject せず {partial:true, byDevice, items} で
 *     resolve する (BIZ-14。完走時は {partial:false, ...} の同 shape)。既定 false (reject)。
 * @returns {Promise<{byDevice: Record<string, object[]>, items: object[], partial?:boolean}>}
 *   items の各要素: { cardID, nameUUID, name, cardType, subUUID, ..., uuids:string[] }
 */
export async function getCards(client, { deviceUUIDs, timeoutMs = DEFAULT_TIMEOUT_MS, graceMs, partialOnTimeout }) {
  return fetchAuthData(client, {
    op: "getCards",
    pubOp: PUB_CARD_LINKED_IDS,
    idKey: "cardID",
    deviceUUIDs,
    timeoutMs,
    graceMs,
    partialOnTimeout,
  });
}

// ---------- パスコード: 取得 ----------

/**
 * 対象デバイスの暗証番号 (passcode) 一覧を取得する。getCards と同型。
 * 応答データ本体は op='pubPasscodeLinkedIDs' で届く (useManageAuthData.js:189-191)。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{deviceUUIDs:string[], timeoutMs?:number, graceMs?:number, partialOnTimeout?:boolean}} params
 *   graceMs: 完了通知が pub より先行した場合の残 push 吸収猶予 (既定 300ms。テスト注入用)。
 *   partialOnTimeout: true なら timeout 時に reject せず {partial:true, byDevice, items} で
 *     resolve する (BIZ-14。完走時は {partial:false, ...} の同 shape)。既定 false (reject)。
 * @returns {Promise<{byDevice: Record<string, object[]>, items: object[], partial?:boolean}>}
 *   items の各要素: { passwordID, keyBoardPassCode, keyBoardPassCodeNameUUID, name, nameUUID, subUUID, ..., uuids:string[] }
 */
export async function getPasscodes(client, { deviceUUIDs, timeoutMs = DEFAULT_TIMEOUT_MS, graceMs, partialOnTimeout }) {
  return fetchAuthData(client, {
    op: "getPasscodes",
    pubOp: PUB_PASSCODE_LINKED_IDS,
    idKey: "passwordID",
    deviceUUIDs,
    timeoutMs,
    graceMs,
    partialOnTimeout,
  });
}

// ---------- 内部: op 付き同期応答を待つ共通処理 ----------

/**
 * action+op 一致の同期応答を request で待つ。biz3 は invokeCallbacks(message) で
 * コールバック発火しているだけだが (useManageAuthData.js:260-271)、CLI では
 * 応答メッセージ (reqContext 含む) を呼び出し側に返す。
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {import("./transport.js").WsFrame} frame
 * @param {string} opLabel
 * @param {number} [timeoutMs]
 * @returns {Promise<object>} 応答メッセージ
 */
async function requestOp(client, frame, opLabel, timeoutMs) {
  const resp = await client.request(frame, timeoutMs);
  return assertSuccess(resp, opLabel);
}

// ---------- カード: 登録 (DB 同期) ----------

/**
 * カードをサーバ DB に登録する (postCards)。
 *
 * ⚠️ getCards/clearCards と異なり obj でラップせず、deviceUUID と list を
 *    トップレベルに置く非対称構造 (useManageAuthData.js:379-394)。混同しないこと。
 * ⚠️ これは「DB への登録」のみ。実ファームウェア書き込みは別途 BLE
 *    (SesameBle.biometric.cardAdd / cardBatchAdd, src/ble/biometric.js) で行う 2 段構造。
 *    list.length < 1 なら何もしない (biz3:381)。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{deviceUUID:string, list:object[], timeoutMs?:number}} params
 *   list 要素: { cardID, nameUUID, name, cardType, memberID? } 等 (cards/index.js:268-286)
 * @returns {Promise<object|null>} 応答メッセージ。list 空のときは null。
 */
export async function postCards(client, { deviceUUID, list, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!Array.isArray(list) || list.length < 1) return null;
  return requestOp(client, { action: ACTION, deviceUUID, list, op: "postCards" }, "postCards", timeoutMs);
}

// ---------- パスコード: 登録 (DB 同期) ----------

/**
 * パスコードをサーバ DB に登録する (postPasscodes)。postCards と同型 (useManageAuthData.js:396-411)。
 * obj ラップ無し、deviceUUID と list をトップレベルに置く。list.length < 1 なら何もしない。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{deviceUUID:string, list:object[], timeoutMs?:number}} params
 *   list 要素: { passwordID, name, nameUUID } (references_web/src/pages/biz/access-control/password/passwords.js:101-113)。
 *   nameUUID は biz3utils.insertUUIDIsolationCharacter 整形済み UUID 文字列。
 * @returns {Promise<object|null>}
 */
export async function postPasscodes(client, { deviceUUID, list, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!Array.isArray(list) || list.length < 1) return null;
  return requestOp(client, { action: ACTION, deviceUUID, list, op: "postPasscodes" }, "postPasscodes", timeoutMs);
}

// ---------- カード: 削除 (DB 同期) ----------

/**
 * カードをサーバ DB から削除する (delCards)。
 *
 * ⚠️ obj/deviceUUID ラップ無し、items 配列をトップレベルに置く (useManageAuthData.js:355-365)。
 *    items 要素は { deviceID, cardID } (deviceUUID ではなく deviceID)。
 * ⚠️ これは「BLE 削除 ack 後の DB 後始末」。実削除は BLE
 *    (SesameBle.biometric.cardDelete, src/ble/biometric.js) 経由で行う 2 段構造。
 *    !items.length なら何もしない (biz3:356)。
 * ⚠️ biz3 の応答ハンドラには `case 'delCards':` が存在するが中身は空で、コールバック登録も
 *    無い (useManageAuthData.js:265-267) — つまり参照は応答を**無視**する (サーバが応答 op を
 *    返すかどうかは参照からは確定できない)。biz3 と同じく **fire-and-forget (send)** にする
 *    (request で待つ設計は参照に無い)。!items.length なら何もしない。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{items:Array<{deviceID:string, cardID:string}>}} params
 * @returns {boolean} 送信したら true、items 空で何もしなければ false
 */
export function delCards(client, { items }) {
  if (!Array.isArray(items) || items.length === 0) return false;
  client.send({ action: ACTION, items, op: "delCards" });
  return true;
}

// ---------- パスコード: 削除 (DB 同期) ----------

/**
 * パスコードをサーバ DB から削除する (delPasscodes)。delCards と同型 (useManageAuthData.js:367-377)。
 * items 要素は { deviceID, passwordID }。!items.length なら何もしない。
 *
 * ⚠️ biz3 では delPasscodes の応答ハンドラに専用 case が無く default に落ちる (272-273)。
 *    = 参照は専用応答を期待せず無視する (サーバが応答 op を返すかは参照から確定できない)。
 *    delCards と同様 **fire-and-forget (send)** にする。!items.length なら何もしない。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{items:Array<{deviceID:string, passwordID:string}>}} params
 * @returns {boolean} 送信したら true、items 空で何もしなければ false
 */
export function delPasscodes(client, { items }) {
  if (!Array.isArray(items) || items.length === 0) return false;
  client.send({ action: ACTION, items, op: "delPasscodes" });
  return true;
}

// ---------- カード: 全クリア ----------

/**
 * 指定デバイスのカードを全削除する (clearCards)。
 *
 * ⚠️ obj.devices は **単一 deviceUUID 文字列** (getCards のようなカンマ連結ではない:
 *    useManageAuthData.js:295-311)。!deviceUUID なら何もしない。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{deviceUUID:string, timeoutMs?:number}} params
 * @returns {Promise<object|null>}
 */
export async function clearCards(client, { deviceUUID, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!deviceUUID) return null;
  return requestOp(client, { action: ACTION, obj: { devices: deviceUUID }, op: "clearCards" }, "clearCards", timeoutMs);
}

// ---------- パスコード: 全クリア ----------

/**
 * 指定デバイスのパスコードを全削除する (clearPasscodes)。clearCards と同型。
 * obj.devices は単一 deviceUUID 文字列 (useManageAuthData.js:313-329)。
 * 注: biz3 の関数名は clearPasswords だが op は 'clearPasscodes'。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{deviceUUID:string, timeoutMs?:number}} params
 * @returns {Promise<object|null>}
 */
export async function clearPasscodes(client, { deviceUUID, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!deviceUUID) return null;
  return requestOp(client, { action: ACTION, obj: { devices: deviceUUID }, op: "clearPasscodes" }, "clearPasscodes", timeoutMs);
}

// ---------- カード: 名前 / nameUUID 更新 ----------

/**
 * カード名 (と nameUUID) を更新する (updateCardName)。
 *
 * biz3 handlePutCardName (useManageAuthData.js:331-344) は { action, obj:{...item}, op } を送る。
 * item には { cardID, name, cardNameUUID, timestamp, cardType, stpDeviceUUID } を入れる
 * (carddetails.js:79-87,177-184)。応答は reqContext に送ったフィールドが echo back される
 * (useManageAuthData.js:192-234)。
 *
 * ⚠️ biz3 の updateItemName (438-471) は **cardNameUUID が UUIDv4 形式でない場合**、
 *    WS を直接投げず先に BLE (SSM_OS3_CARD_CHANGE=107) で nameUUID を v4 化する分岐がある。
 *    その BLE payload 構築は SesameBle.biometric.cardChange (CARD_CHANGE=107, src/ble/biometric.js)
 *    の責務。本関数は **WS の updateCardName 送信のみ** を行う。CLI で BLE 前段を回避するには、
 *    呼び出し側が cardNameUUID に v4 UUID を渡すこと (crypto.generateUUID() で生成可)。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{item:object, timeoutMs?:number}} params
 *   item: { cardID, name, cardNameUUID, timestamp?, cardType?, stpDeviceUUID }
 * @returns {Promise<object>} 応答メッセージ (reqContext 含む)
 */
export async function updateCardName(client, { item, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return requestOp(client, { action: ACTION, obj: { ...item }, op: "updateCardName" }, "updateCardName", timeoutMs);
}

// ---------- パスコード: 名前 / nameUUID 更新 ----------

/**
 * パスコード名 (と nameUUID) を更新する (updatePasscodeName)。updateCardName と同型。
 * item には { stpDeviceUUID, keyBoardPassCode, keyBoardPassCodeNameUUID, name } を入れる
 * (useManageAuthData.js:201-210,331-344)。
 *
 * ⚠️ keyBoardPassCodeNameUUID が UUIDv4 形式でない場合、biz3 は先に BLE
 *    (SSM_OS3_PASSCODE_CHANGE=123) で v4 化する分岐がある
 *    (SesameBle.biometric.passcodeChange, src/ble/biometric.js の責務)。
 *    本関数は WS 送信のみ。v4 UUID を渡せば BLE 前段を回避できる。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{item:object, timeoutMs?:number}} params
 *   item: { stpDeviceUUID, keyBoardPassCode, keyBoardPassCodeNameUUID, name }
 * @returns {Promise<object>}
 */
export async function updatePasscodeName(client, { item, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return requestOp(client, { action: ACTION, obj: { ...item }, op: "updatePasscodeName" }, "updatePasscodeName", timeoutMs);
}

// ---------- カード: 所有者割当 ----------

/**
 * カードの所有者 (メンバー) を割り当てる (updateCardOwner)。これは WS のみで完結 (BLE 不要)。
 *
 * biz3 (useManageAuthData.js:346-353) は 'ownerSubUUID' in item の時だけ送る。
 * ownerSubUUID は割り当てるメンバーの subUUID。空文字 '' でも送信 = 未割当解除。
 *
 * 送信フレーム: { action, obj:{...item}, op:'updateCardOwner' }
 * 参照: useManageAuthData.js:346-353 は updateCardOwner(item, cb) を受け、
 *       handlePutCardName (同 331-343) が obj:{...item} をそのまま送る。
 *       呼び出し元 cards/index.js:385-396 は item として
 *       { cardID, name, cardNameUUID, ownerSubUUID, timestamp, cardType, stpDeviceUUID }
 *       の全フィールドを渡す。2 フィールド固定 (旧実装) ではこのフレームを再現できない。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{item?: object, cardID?: string, ownerSubUUID?: string, timeoutMs?: number}} params
 *   推奨: item に全フィールドを持つオブジェクトを渡す (cards/index.js:385-396 相当)。
 *   後方互換: item 省略時は { cardID, ownerSubUUID } を item として合成する。
 *   ownerSubUUID が item に存在しない (undefined) 場合は送信しない。
 *   '' は送信して未割当解除 (useManageAuthData.js:348: 'ownerSubUUID' in item のみ送る)。
 * @returns {Promise<object|null>} ownerSubUUID が item に存在しなければ null。
 */
export async function updateCardOwner(client, { item, cardID, ownerSubUUID, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  // item を持つ呼び出し (cards/index.js:385-396 相当) と、後方互換の直接指定呼び出しを
  // 両方サポートする。
  if (item !== undefined) {
    // --- item 透過パス (biz3 参照実装の正規経路) ---
    // useManageAuthData.js:346-353: 'ownerSubUUID' in item の時だけ送る。
    // handlePutCardName (同 331-343) は obj:{...item} をそのまま送る。
    if (!('ownerSubUUID' in item)) return null;
    return requestOp(
      client,
      { action: ACTION, obj: { ...item }, op: "updateCardOwner" },
      "updateCardOwner",
      timeoutMs,
    );
  }

  // --- 後方互換パス: item 省略時は { cardID, ownerSubUUID } を合成 ---
  // 旧シグネチャ updateCardOwner(client, { cardID, ownerSubUUID }) の呼び出し元
  // (src/cli/access.js) を壊さないための互換層。
  // ownerSubUUID undefined は「キー不在」扱いと同義 (useManageAuthData.js:348 と等価)。
  if (ownerSubUUID === undefined) return null;
  return requestOp(
    client,
    { action: ACTION, obj: { cardID, ownerSubUUID }, op: "updateCardOwner" },
    "updateCardOwner",
    timeoutMs,
  );
}

// ---------- Kotlin SDK biometric credential sync (REST /device/v1/biometrics) ----------

/**
 * Kotlin SDK CHDataSynchronizeCapable.postAuthenticationData と同じ REST 操作。
 * body = { op: `${operation}_post`, deviceID, items } を POST /device/v1/biometrics へ送る。
 *
 * @param {import("./transport.js").Hub3WsClient|null} _client WS 互換のため未使用
 * @param {AuthDataParams} params
 * @returns {Promise<object[]>} response.data.items (CHDataSynchronizeCapableImpl.kt:23: `responses.data.items`)
 */
export async function postAuthenticationData(_client, params) {
  const transport = resolveBiometricsTransport(params);
  const body = {
    op: withSuffix(params.operation, "_post"),
    deviceID: params.deviceID,
    items: Array.isArray(params.items) ? params.items : [],
  };
  const resp = await postBiometrics(transport, body, "postAuthenticationData");
  // 参照は無条件に responses.data.items を読む (CHDataSynchronizeCapableImpl.kt:23)。
  // フォールバック `?? resp` は出典なし — 撤去。
  return resp?.data?.items;
}

/**
 * Kotlin SDK CHDataSynchronizeCapable.putAuthenticationData と同じ REST 操作。
 * body = { op: `${operation}_put`, deviceID, items }。
 * @param {import("./transport.js").Hub3WsClient|null} _client WS 互換のため未使用
 * @param {AuthDataParams} params
 */
export async function putAuthenticationData(_client, params) {
  const transport = resolveBiometricsTransport(params);
  const body = {
    op: withSuffix(params.operation, "_put"),
    deviceID: params.deviceID,
    items: Array.isArray(params.items) ? params.items : [],
  };
  return postBiometrics(transport, body, "putAuthenticationData");
}

/**
 * Kotlin SDK CHDataSynchronizeCapable.deleteAuthenticationData と同じ REST 操作。
 * body = { op: `${operation}_delete`, deviceID, items }。
 * @param {import("./transport.js").Hub3WsClient|null} _client WS 互換のため未使用
 * @param {AuthDataParams} params
 */
export async function deleteAuthenticationData(_client, params) {
  const transport = resolveBiometricsTransport(params);
  const body = {
    op: withSuffix(params.operation, "_delete"),
    deviceID: params.deviceID,
    items: Array.isArray(params.items) ? params.items : [],
  };
  return postBiometrics(transport, body, "deleteAuthenticationData");
}

/**
 * Kotlin SDK CHDataSynchronizeCapable.updateAuthenticationName と同じ REST 操作。
 * CHAuthenticationNameRequest.* が作る request object をそのまま POST /device/v1/biometrics へ送る。
 * 便利指定として `kind` を渡すと SDK companion の既定 op を補完する。
 *
 * @param {import("./transport.js").Hub3WsClient|null} _client WS 互換のため未使用
 * @param {UpdateAuthNameParams} params
 */
export async function updateAuthenticationName(_client, params) {
  const transport = resolveBiometricsTransport(params);
  const body = params.request ? { ...params.request } : authenticationNameRequest(params);
  return postBiometrics(transport, body, "updateAuthenticationName");
}

/** @param {UpdateAuthNameParams} params */
function authenticationNameRequest(params) {
  const now = params.timestamp ?? Date.now();
  const common = {
    subUUID: params.subUUID,
    stpDeviceUUID: params.stpDeviceUUID,
    name: params.name,
    timestamp: now,
  };
  switch (params.kind) {
    case "card":
      return {
        cardType: params.cardType ?? params.type ?? 0,
        cardNameUUID: params.cardNameUUID ?? params.nameUUID,
        cardID: params.cardID,
        op: params.op ?? "nfc_card_putname",
        ...common,
      };
    case "face":
      return {
        type: params.type ?? 0,
        faceNameUUID: params.faceNameUUID ?? params.nameUUID,
        faceID: params.faceID,
        op: params.op ?? "face_putname",
        ...common,
      };
    case "fingerPrint":
      return {
        type: params.type ?? 0,
        fingerPrintNameUUID: params.fingerPrintNameUUID ?? params.nameUUID,
        fingerPrintID: params.fingerPrintID,
        op: params.op ?? "fingerprint_putname",
        ...common,
      };
    case "palm":
      return {
        type: params.type ?? 0,
        palmNameUUID: params.palmNameUUID ?? params.nameUUID,
        palmID: params.palmID,
        op: params.op ?? "palm_putname",
        ...common,
      };
    case "passcode":
      return {
        type: params.type ?? 0,
        keyBoardPassCodeNameUUID: params.keyBoardPassCodeNameUUID ?? params.nameUUID,
        keyBoardPassCode: params.keyBoardPassCode,
        op: params.op ?? "passcode_putname",
        ...common,
      };
    default:
      throw badRequest("access.err.kindRequired");
  }
}

// ---------- enroll → DB 同期ブリッジ (BLE で実機登録 → 本 WS op で DB 追従) ----------
//
// biz3 の 2 段構造の **2 段目** (DB 同期) を、BLE 1 段目 (実機タップ登録) の集約結果に
// 接続する糊。BLE 側の集約は src/ble/biometric.js の createEnrollCollector /
// BiometricCommands.onEnroll が担い、その onEnrolled コールバック内で本関数を呼ぶ想定。
//
// 責務分担 (本ファイル冒頭の 2 層構造コメントの通り):
//   - 実機への物理書き込み = BLE (SesameBle.biometric.cardAdd 等)。本関数は一切触らない。
//   - DB 同期            = 本関数 (既存 WS op への委譲のみ。新しい WS op は増やさない)。
//
// biz3 の DB 同期は経路が 2 つあり、nameUUID の出所が異なる (P3-11 / BIZ-04):
//   (a) タップ登録 (実機側でファームが nameUUID を採番):
//       BLE ack (NOTIFY) の cardInfo.nameUUID を使い **updateCardName** で DB を追従させる
//       (cards/index.js:104-136 batchLinkCardCallback)。postCards は使わない。
//   (b) 一括投入 (web/CSV 側で nameUUID を採番してファームへ書き込む):
//       buildNameUUIDMappedDataList で採番 → ファームへ書込 → 同一 nameUUID を
//       **postCards/postPasscodes** で DB へ送る (cards/index.js:264-295, passwords.js:101-113)。
// どちらも「ファームと DB の nameUUID が一致する」ことが不変条件。BLE enroll 後に DB 側で
// 新規採番すると恒久不一致になるため、records には NOTIFY 由来の nameUUID を含める契約
// (src/ble/biometric.js の enroll collector が付与。ファームウェア採番値)。

/**
 * nameUUID をサーバ DB 形 (小文字 + ハイフン区切り) に正規化する。
 * biz3 は両経路ともサーバへ送る前にこの形へ揃える:
 *   - タップ登録: parseHexStrToCardInfo が insertUUIDIsolationCharacter で整形 (biz3utils.js:382)
 *   - 一括投入:   insertUUIDIsolationCharacter(item.nameUUID.toLowerCase())
 *                (cards/index.js:275, passwords.js:106)
 * BLE collector (src/ble/biometric.js) は NOTIFY の nameUUID を hex のまま渡すため、ここで整形する。
 * @param {unknown} nameUUID
 * @returns {string|null} 正規化済み nameUUID。非文字列/空は null。
 */
function normalizeNameUUID(nameUUID) {
  if (typeof nameUUID !== "string" || nameUUID === "") return null;
  const lower = nameUUID.toLowerCase();
  // 32 hex (ハイフン無し) なら biz3utils.insertUUIDIsolationCharacter と同じ整形を適用。
  return /^[0-9a-f]{32}$/.test(lower)
    ? lower.replace(/^(\w{8})(\w{4})(\w{4})(\w{4})(\w{12})$/, "$1-$2-$3-$4-$5")
    : lower;
}

/**
 * createEnrollCollector の records ({cardID, cardName, cardType, nameUUID?}) を DB 同期用の
 * list 要素 ({ cardID, name, cardType, nameUUID }) へ写像する純関数。
 *
 * nameUUID は record.nameUUID (= BLE NOTIFY 由来の **ファームウェア採番値**。
 * cards/index.js:264-295 の不変条件「ファームと DB の nameUUID 一致」の根拠) があれば
 * それを正規化して使う。
 *
 * ⚠️ record.nameUUID 欠落時のみ v4 UUID を新規採番する (旧 BLE collector との後方互換)。
 *   この場合 DB の nameUUID はファームウェア側の採番値と **不一致になる可能性** があり、
 *   以後の名前更新 (updateCardName の v4 化分岐) 等で齟齬が出得る。nameUUID を含む
 *   collector (src/ble/biometric.js) との併用を推奨。
 * ⚠️ 未確認 (実機検証要): NOTIFY 由来の cardName は hex 文字列で届くため、name には
 *   そのまま cardName を載せる。表示名の補正が必要な運用では呼び出し側で list を補正すること。
 *
 * @param {Array<{cardID:string, cardName:string, cardType:number, nameUUID?:string}>} [records]
 * @returns {Array<{cardID:string, name:string, cardType:number, nameUUID:string}>}
 */
export function enrolledToCardList(records) {
  if (!Array.isArray(records)) return [];
  return records.map((r) => ({
    cardID: r.cardID,
    name: r.cardName,
    cardType: r.cardType,
    nameUUID: normalizeNameUUID(r.nameUUID) ?? generateUUID(),
  }));
}

/**
 * enroll records を postPasscodes 用 list に写像する。
 * 要素は {passwordID, name, nameUUID} のみ (passwords.js:101-113 で postPasscodes に渡る
 * serverList = buildNameUUIDMappedDataList 由来の {passwordID, name} + nameUUID。
 * keyBoardPassCode / keyBoardPassCodeNameUUID / type は **送らない** — それらは
 * updatePasscodeName 等の別 op のフィールドで、postPasscodes の参照経路には現れない)。
 *
 * nameUUID は record.nameUUID (ファームウェア採番。NOTIFY 由来) を優先し、欠落時のみ
 * v4 UUID を採番する (enrolledToCardList と同じ注意 — ファーム不一致の可能性あり)。
 *
 * @param {Array<{cardID?:string,passwordID?:string,cardName?:string,name?:string,nameUUID?:string}>} [records]
 * @returns {Array<{passwordID:string,name:string,nameUUID:string}>}
 */
export function enrolledToPasscodeList(records) {
  if (!Array.isArray(records)) return [];
  return records.map((r) => {
    const passwordID = r.passwordID || r.cardID || "";
    const nameUUID = normalizeNameUUID(r.nameUUID) ?? generateUUID();
    return {
      passwordID,
      name: r.name ?? r.cardName ?? nameUUID,
      nameUUID,
    };
  });
}

/**
 * BLE で実機登録 (タップ) されたカードの集約結果を DB へ同期する。
 * BiometricCommands.onEnroll の onEnrolled({kind:'card', records}) からそのまま呼べる。
 *
 * 経路は引数で分かれる (公開シグネチャは従来どおり):
 *   - records (タップ登録): biz3 のタップ登録 (cards/index.js:104-136) と同じく、レコード
 *     1 件ごとに **updateCardName** で DB を追従させる。cardNameUUID には BLE ack 由来の
 *     ファームウェア採番 nameUUID (enrolledToCardList が解決) を載せる。
 *   - list (一括投入): **postCards 委譲**。これは「ファームへ同一 nameUUID を書き込んだ後の
 *     一括投入」(cards/index.js:264-295) 専用。呼び出し側がファームに書いたものと同じ
 *     nameUUID を list 要素に入れて渡すこと (ここでは採番しない)。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{deviceUUID:string, records?:Array<{cardID:string,cardName:string,cardType:number,nameUUID?:string}>, list?:object[], timeoutMs?:number}} params
 *   list を渡すと records を無視して postCards へそのまま流す (一括投入経路)。
 * @returns {Promise<object[]|object|null>}
 *   records 経路: updateCardName 応答の配列 (records 空のときは null)。
 *   list 経路:   postCards の戻り (list 空のときは null)。
 */
export async function syncEnrolledCards(client, { deviceUUID, records, list, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  // 一括投入経路: ファームへ書いた nameUUID と同一の list をそのまま DB へ (biz3 (b) 経路)。
  if (Array.isArray(list)) {
    return postCards(client, { deviceUUID, list, timeoutMs });
  }
  // タップ登録経路: ack の nameUUID で updateCardName (biz3 (a) 経路, cards/index.js:116-124)。
  const items = enrolledToCardList(records);
  if (items.length === 0) return null;
  const responses = [];
  for (const it of items) {
    responses.push(await updateCardName(client, {
      item: {
        cardID: it.cardID,
        name: it.name,
        cardNameUUID: it.nameUUID,
        timestamp: Date.now(), // cards/index.js:120 (new Date().getTime())
        cardType: it.cardType,
        stpDeviceUUID: deviceUUID,
      },
      timeoutMs,
    }));
  }
  return responses;
}

/**
 * BLE で実機登録された暗証番号の集約結果を DB へ同期する (postPasscodes への委譲)。
 *
 * passcode の参照 (passwords.js:94-115) には card のような「タップ登録 → updateCardName」の
 * DB 同期経路が無く、postPasscodes は一括投入 (ファームへ書いた nameUUID と同一の list を
 * 送る) のみ。よって本関数は postPasscodes 委譲のままとし、records からの自動変換は
 * record.nameUUID (ファームウェア採番) を透過する {passwordID, name, nameUUID} の最小写像
 * (enrolledToPasscodeList) に留める。
 *
 * @param {import("./transport.js").Hub3WsClient} client
 * @param {{deviceUUID:string, records?:Array<{cardID?:string,passwordID?:string,cardName?:string,nameUUID?:string}>, list?:object[], timeoutMs?:number}} params
 *   list を渡せば変換をスキップしてそのまま postPasscodes へ流す (一括投入経路)。
 * @returns {Promise<object|null>}
 */
export async function syncEnrolledPasscodes(client, { deviceUUID, records, list, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const payload = Array.isArray(list) ? list : enrolledToPasscodeList(records);
  return postPasscodes(client, { deviceUUID, list: payload, timeoutMs });
}

// 公開 op の allowlist (SesameHub3._bindNs / serve registry が参照する単一の真実)。
// syncEnrolledCards/Passcodes は WS op を増やさず既存 op (updateCardName / postCards /
// postPasscodes) へ委譲する糊なので allowlist には載せない (新 op を捏造しない)。
// enrolledToCardList/enrolledToPasscodeList は純関数 (op ではない)。
export const NAMESPACE_OPS = [
  "getCards", "getPasscodes", "postCards", "postPasscodes",
  "delCards", "delPasscodes", "clearCards", "clearPasscodes",
  "updateCardName", "updatePasscodeName", "updateCardOwner",
];
