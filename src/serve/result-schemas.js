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

// BLE 専用 RPC (ble.reset / ble.position / ble.wifi.set*/connect) の ack。
// registry.bleCommandAck が組む {resultCode, resultName} (SesameResultCode taxonomy —
// src/ble/protocol.js RESULT)。kit 自前の整形なので shape は確実 (上流応答ではない)。
const BLE_ACK = obj({ resultCode: NUM, resultName: STR }, ["resultCode", "resultName"]);

/** @type {Readonly<Record<string, JsonSchema>>} */
export const RESULT_SCHEMAS = Object.freeze({
  // daemon 自前 (確実)
  // authState の 3 値は daemon.js の this.authState 定義 (コンストラクタ・_connect の遷移) から導出。
  //   "ok"       — 接続・認証完了 (daemon.js: authState = "ok")
  //   "degraded" — 接続失敗かつトークンあり (daemon.js: _hasStoredTokens() が true のとき)
  //   "expired"  — 接続失敗かつトークン無し (daemon.js: _hasStoredTokens() が false のとき)
  // subUUID は hub.subUUID で、未接続時は null になるため nullable。
  "status": obj(
    {
      connected: BOOL,
      authState: { type: "string", enum: ["ok", "degraded", "expired"] },
      subUUID: nullable(STR),
      apiVersion: STR,
      contractVersion: STR,
    },
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

  // BLE 専用 RPC (P4-1 段階2 / P1-7)。kit 自前の整形 (registry の handler が組む) なので形は確実。
  // experimental だが SDK の戻り型を Any に劣化させないためスキーマを出す。

  // P1-7 (R2:SURF-25): ble.scan — 近接デバイス発見一覧。scrubDiscovery が組む {ok, count, devices[]}。
  // devices の各要素の形は listNearbyDevices の DiscoveryEntry から peripheral を除いたもの。
  // peripheral は JSON 不可 (noble 内部オブジェクト) なので除外する。
  "ble.scan": obj(
    {
      ok: BOOL,
      count: NUM,
      devices: arr(obj({
        deviceUUID: STR,
        productType: NUM,
        model: nullable(STR),
        kind: STR,
        isRegistered: BOOL,
        rssi: nullable(NUM),
        localName: nullable(STR),
        address: nullable(STR),
      }, ["deviceUUID"])),
    },
    ["ok", "count", "devices"],
  ),
  "ble.reset": BLE_ACK,
  "ble.position": BLE_ACK,
  "ble.wifi.setSsid": BLE_ACK,
  "ble.wifi.setPassword": BLE_ACK,
  "ble.wifi.connect": BLE_ACK,
  // OS3 ロック系は SDK 同様コマンド無送信 (commandSent=false, resultCode/Name=null)。
  "ble.updateFirmware": obj(
    { commandSent: BOOL, resultCode: nullable(NUM), resultName: nullable(STR) },
    ["commandSent"],
  ),
  "ble.wifi.scan": obj(
    { ssids: arr(obj({ ssid: STR, rssi: NUM }, ["ssid", "rssi"])) },
    ["ssids"],
  ),

  // P1-8 (R2:SURF-26 + R2:SURF-39): 生体一覧専用収集ハンドラの戻り型。
  // records 配列: card/passcode/finger は {id, name, type} (collectBiometricList の整形)、
  // face/palm は parseTouchFace の戻り値オブジェクト (フィールド未確定 → OBJ)。
  // handler が組む {records:[...]} は kit 自前なので形は確実。
  "ble.biometric.cardGet": obj({ records: arr(obj({ id: STR, name: STR, type: NUM }, ["id"])) }, ["records"]),
  "ble.biometric.passcodeGet": obj({ records: arr(obj({ id: STR, name: STR, type: NUM }, ["id"])) }, ["records"]),
  "ble.biometric.faceListGet": obj({ records: arr(OBJ) }, ["records"]),
  "ble.biometric.palmListGet": obj({ records: arr(OBJ) }, ["records"]),
  "ble.fingerPrint.fingerPrints": obj({ records: arr(obj({ id: STR, name: STR, type: NUM }, ["id"])) }, ["records"]),
});
