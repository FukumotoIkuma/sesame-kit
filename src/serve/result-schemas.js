// stable メソッドの結果スキーマ (生成 SDK の型付き return 用)。
//
// 形は参照実装 (references_web / _sesame_sdk_ref) のトレースで確認した範囲だけを型にする。
// 中身が未確定のサブオブジェクト (stateInfo / quotas / data / lastEvaluatedKey) は bare
// { type: "object" } のまま = SDK では unknown/Any にして「推測しない」。
// 確信度: status/events = daemon 自前で確実 / devices.list・history・battery・whoami・
// lock.status = vendor 検証済 / lock.lock/unlock/toggle/click ack = vendor 非検証
// (web は trigger ack を読まない / src 観測のみ) なので全 optional の緩い型。

const STR = { type: "string" };
const NUM = { type: "number" };
const BOOL = { type: "boolean" };
const OBJ = { type: "object" }; // 中身未確定 → unknown/Any
const arr = (items) => ({ type: "array", items });
const obj = (properties, required = []) => ({ type: "object", properties, required });
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
    lastEvaluatedKey: nullable(OBJ), // opaque, DynamoDB ページ終端では null
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
