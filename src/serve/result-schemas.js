// stable メソッドの結果スキーマ (生成 SDK の型付き return 用)。
//
// ★ これは「結果の形」の**単一真実源**。配線: registry.js が OpenRPC の result.schema に載せ
//   (schema/openrpc.json) → gen-sdk-ts / gen-sdk-py が型付き return を生成、という 1 経路で
//   流れる。openrpc.json は CI でドリフトゲートされるため、ここを変えれば SDK/契約まで一貫追従する。
//
// ★ なぜ手書きか (生成しないのか): 結果の形は上流 (biz3 クラウド) の応答 shape であって、本 kit の
//   JS ソース/JSDoc からは導出できない (ドメイン関数は vendor の `resp.data` をそのまま返す)。
//   よって参照実装 (references_web / _sesame_sdk_ref) のトレースで確認した範囲だけを手で型にする。
//   この「観測 shape ↔ スキーマ」の一致は **conformance テスト** で守る:
//   tests/serve/upstream-canary-replay.test.js が記録済み応答 (tests/fixtures/upstream/*.json) を
//   本スキーマで検証する (scripts/canary-upstream.mjs --replay と同じロジック・creds 不要・CI 常時)。
//   live 版 canary (要 creds) は実上流の応答も同じく検証する。
//
// 中身が未確定のサブオブジェクト (stateInfo / quotas / data / lastEvaluatedKey) は bare
// { type: "object" } のまま = SDK では unknown/Any にして「推測しない」。
// 確信度: status/events = daemon 自前で確実 / devices.list・history・battery・whoami・
// lock.status = vendor 検証済 / lock.lock/unlock/toggle/click ack = vendor 非検証
// (web は trigger ack を読まない / src 観測のみ) なので全 optional の緩い型。

/** @typedef {Record<string, unknown>} JsonSchema JSON-Schema 風のスキーマ片 */

/** @type {JsonSchema} */
const STR = { type: "string" };
/** @type {JsonSchema} */
const NUM = { type: "number" };
/** @type {JsonSchema} */
const BOOL = { type: "boolean" };
/** @type {JsonSchema} */
const OBJ = { type: "object" }; // 中身未確定 → unknown/Any
/** @param {JsonSchema} items @returns {JsonSchema} */
const arr = (items) => ({ type: "array", items });
/** @param {Record<string, JsonSchema>} properties @param {string[]} [required] @returns {JsonSchema} */
const obj = (properties, required = []) => ({ type: "object", properties, required });
/** @param {JsonSchema} schema @returns {JsonSchema} */
const nullable = (schema) => ({ ...schema, nullable: true }); // 値が null になりうる (SDK で `| null` / `| None`)

// デバイス 1 件 (devices.list の要素 / lock.status の単機状態は同形)。stateInfo は内部形未確定。
const DEVICE = obj(
  { deviceUUID: STR, deviceName: STR, deviceModel: STR, secretKey: STR, keyLevel: NUM, rank: NUM, stateInfo: OBJ },
  ["deviceUUID"],
);

// lock.lock/unlock/toggle/click の ack。biz3 web は trigger ack を読まない (useIotCtrl.js は
// 非同期 pubDeviceStateChange のみ扱う) ため shape は src/lock.js の実機観測由来 = 全 optional。
const LOCK_ACK = obj(
  { action: STR, code: NUM, success: BOOL, message: STR, op: STR, data: OBJ },
  ["action"],
);

/** @type {Readonly<Record<string, JsonSchema>>} */
export const RESULT_SCHEMAS = Object.freeze({
  // daemon 自前 (確実)
  "status": obj(
    { connected: BOOL, authState: STR, subUUID: STR, apiVersion: STR, contractVersion: STR },
    ["connected", "authState", "apiVersion", "contractVersion"],
  ),
  "events.subscribe": obj({ subscribed: arr(STR) }, ["subscribed"]),
  "events.unsubscribe": obj({ subscribed: arr(STR) }, ["subscribed"]),

  // vendor 検証済
  "account.whoami": obj({
    customerInfo: obj({
      companyID: STR, subUUID: STR, subscriptionId: STR, name: STR, mainEmail: STR,
      employeeEmail: STR, employeeName: STR, access: arr(STR), tag: arr(STR),
      isAnonymous: BOOL, isRootUser: BOOL, isSesameApp: BOOL,
    }),
    quotas: OBJ, // 内部形 未確定
  }),
  "devices.list": arr(DEVICE),
  "device.history": arr(obj({
    timestamp: NUM, device_id: STR, record_id: STR, type: NUM,
    history_tag: STR, botHistoryMode: STR, botAlias: STR, botViaType: NUM,
  }, ["timestamp", "type"])),
  "device.battery": obj({
    records: arr(obj(
      { ts: NUM, light: NUM, heavy: NUM, lightPercentage: NUM, heavyPercentage: NUM },
      ["ts"],
    )),
    // DynamoDB のページングカーソル。最終ページでは null になる (getBatteryRecord も
    // `{records:[], lastEvaluatedKey:null}` を返す) ため null 許容。中身は opaque。
    lastEvaluatedKey: nullable(OBJ),
  }, ["records"]),

  // lock.status は vendor トレース確認済 (useManageDevice.js:84 が data[0]||null を消費) →
  // 単一 device-status または null。src/devices.js getDeviceStatus が data[0]??null を返す。
  "lock.status": nullable(DEVICE),

  // partial (vendor 非検証 / 中身未確定) — lock ack は trigger を web が読まないため src 観測由来。
  "lock.lock": LOCK_ACK,
  "lock.unlock": LOCK_ACK,
  "lock.toggle": LOCK_ACK,
  "lock.click": LOCK_ACK,
});
