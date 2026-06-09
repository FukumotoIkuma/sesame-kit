// SESAME デバイスの「型モデル」。公式 SesameSDK (Android) の CHProductModel
// (open/devices/base/CHDeivceProtocols.kt) と各デバイスの能力 (capability) を Node に移植したもの。
//
// SDK では能力 (lock/unlock/toggle/click/autolock) が「型ごとのインターフェース」に個別宣言されており、
// 共通基底 (CHDevices / CHSesameLock) は施錠操作を一切持たない。つまり型ごとに能力が非対称。
// ここではその非対称性をそのままテーブル化する (共通基底に lock を生やすのは原典と乖離するため避ける)。
//
// 出典: _sesame_sdk_ref/sesame-sdk/.../open/devices/{CHSesame5,CHSesameBot2,CHSesameBike2,...}.kt,
//       CHBleManager.kt (productModel.deviceFactory() で生成する実装クラス → OS世代/能力)。

/**
 * BLE 上の「デバイス種別 (kind)」。productType→実装クラスの多対一を、能力の単位でまとめたもの。
 * - lock5     : Sesame5/5Pro/6/6Pro/US/miwa, BLE Connector (OS3 ロック)
 * - bot2      : SESAME Bot2/Bot3 (OS3) — click のみ
 * - bike2     : SESAME Bike2 (OS3) — unlock のみ
 * - bike3     : SESAME Bike3 (OS3) — unlock + 指紋登録 (CHFingerPrintCapable mixin)。
 *               Bike3 は CHSesameBike3Device : CHSesameBike2Device(), CHFingerPrintCapable
 *               (CHSesameBike3Device.kt:20-24) で、Bike2 の解錠能力に指紋 capability のみを
 *               足した固有型。Bot/Bike2 と違い fingerPrint ゲッタを露出するため別 kind にする。
 * - sesame2   : Sesame2/3/4 (OS2 ロック) — BLE は別プロトコル (SesameOS2Ble facade)
 * - botOs2    : SESAME Bot1 (OS2) — BLE click (SesameOS2Ble facade)
 * - bikeOs2   : Bike1 (OS2) — BLE unlock (SesameOS2Ble facade)
 * - biometric : Touch/Face/OpenSensor/Remote (鍵束デバイス。施錠操作なし)
 * - hub3      : Hub3/Hub3 LTE (IoT 中継。BLE 施錠操作なし)
 * - wifi      : WifiModule2
 */
export const KIND = Object.freeze({
  LOCK5: "lock5", BOT2: "bot2", BIKE2: "bike2", BIKE3: "bike3",
  SESAME2: "sesame2", BOT_OS2: "botOs2", BIKE_OS2: "bikeOs2",
  BIOMETRIC: "biometric", HUB3: "hub3", WIFI: "wifi",
  UNKNOWN: "unknown", // テーブルに無い model。操作を捏造せず「操作なし」にする (lock5 に化けさせない)
});

/**
 * kind ごとの能力定義。**経路 (cloud / ble) ごとに操作可能な op 集合**を持ち、
 * 実際にユーザーに見せる/送れる op は両者の **和集合** で決まる (どちらの経路でも操作できないものは出さない)。
 *  - os       : 世代 (2 | 3)
 *  - cloud    : この CLI が **クラウド経由**で送れる制御 op (biz3TriggerLocker: lock/unlock/toggle/click、
 *               Hub3 は biz3OperateIoT/IR: ir/relay/led)。autolock はクラウド中継で実機未反映なので含めない。
 *  - ble      : この CLI が **BLE 直接**で送れる制御 op。OS2 系は SesameOS2Ble (別プロトコル) で送る。
 *  - biometric: 生体・アクセス制御 (card/finger/passcode/face/palm) の BLE 登録 API を持つか。
 *               Touch/Touch Pro/Face/Palm/OpenSensor/Remote 系 (= BIOMETRIC kind) のみ true。
 *  - wifiProvisioning: WifiModule2 の BLE プロビジョニング API (Wi-Fi 設定・鍵登録) を持つか。
 *               WM2 (= WIFI kind) のみ true。ロック制御 op (lock/unlock 等) ではなく WM2 専用の
 *               action code (wm2.js WM2_ACTION) を使う別 API 面なので ble[] とは独立 (biometric と同型)。
 *  - hubProvisioning: SESAME Hub3 の BLE プロビジョニング API (Wi-Fi 設定・SSID スキャン・子鍵削除・
 *               接続種別) を持つか。Hub3 (= HUB3 kind) のみ true。Hub3 は CHSesameOS3 を継承するので
 *               connect/login/register/reset/OTA(MOVE_TO) は OS3 共通経路で動くが、ロック制御 op
 *               (lock/unlock 等) は持たない (ble[] は空)。WM2 の wifiProvisioning と同型で、Hub3 固有
 *               の itemCode (itemcodes.js HUB3_*) を使う別 API 面 (hub3.js Hub3Commands)。
 *  - script   : SESAME Bot2/Bot3 のスクリプト API (click(index)/selectScript/getCurrentScript/
 *               getScriptNameList/sendClickScript) を持つか。BOT2 kind のみ true。click(89) は ble[]
 *               に残しつつ、index 指定 click と script 管理は bot2.js の別 API 面 (biometric と同型)。
 *  - fingerprint : SESAME Bike3 の指紋登録 API (fingerPrints/Delete/Change/ModeGet/ModeSet) を
 *               持つか。BIKE3 kind のみ true。Bike3 は CHFingerPrintCapable のみ mixin する
 *               (CHSesameBike3Device.kt:20-24) ため、biometric (card/passcode/face/palm 全部) では
 *               なく指紋専用サブセットだけを露出する。実体は biometric.js BiometricCommands の
 *               fingerPrint 系メソッド (itemCode 115-122) を index.js の fingerPrint ゲッタで限定公開。
 *  - mechKind : mechStatus の解釈方法 ("os3lock" 7B / "os3bot" 3B / "os2lock" 8B / "os2bot" 7B / null)
 *  - label    : 表示用の種別名
 *
 * 出典: 型×経路の可否は調査で確定 (lock.js triggerLock=機種非依存に lock/unlock/toggle/click を中継、
 *       autolock はクラウド未反映=lock.js:127-131、Hub3 の ir/relay/led=iot.js/transport.js、
 *       OS2 BLE=ble/os2/* (SesameOS2Ble facade)、biometric は制御 op なし=管理のみ)。
 */
const CAPS = Object.freeze({
  [KIND.LOCK5]:    { os: 3, cloud: ["lock", "unlock", "toggle"], ble: ["lock", "unlock", "toggle", "autolock"], mechKind: "os3lock", label: "SESAME (lock)" },
  [KIND.BOT2]:     { os: 3, cloud: ["click"],                    ble: ["click"],                   script: true, mechKind: "os3bot",  label: "SESAME Bot" },
  [KIND.BIKE2]:    { os: 3, cloud: ["unlock"],                   ble: ["unlock"],                                mechKind: "os3bot",  label: "SESAME Bike" },
  [KIND.BIKE3]:    { os: 3, cloud: ["unlock"],                   ble: ["unlock"],                  fingerprint: true, mechKind: "os3bot",  label: "SESAME Bike 3" },
  [KIND.SESAME2]:  { os: 2, cloud: ["lock", "unlock", "toggle"], ble: ["lock", "unlock", "toggle", "autolock"], mechKind: "os2lock", label: "SESAME (OS2 lock)" },
  [KIND.BOT_OS2]:  { os: 2, cloud: ["click"],                    ble: ["click"],                                 mechKind: "os2bot",  label: "SESAME Bot (OS2)" },
  [KIND.BIKE_OS2]: { os: 2, cloud: ["unlock"],                   ble: ["unlock"],                                mechKind: "os2bot",  label: "SESAME Bike (OS2)" },
  [KIND.BIOMETRIC]:{ os: 3, cloud: [],                           ble: [],                          biometric: true, mechKind: null,      label: "SESAME Touch/Face/Sensor/Remote" },
  [KIND.HUB3]:     { os: 3, cloud: ["ir", "relay", "led"],       ble: [],                          hubProvisioning: true, mechKind: null,      label: "SESAME Hub3" },
  [KIND.WIFI]:     { os: 3, cloud: ["ir", "relay", "led"],       ble: [],                          wifiProvisioning: true, mechKind: null,      label: "WiFi Module 2" },
  [KIND.UNKNOWN]:  { os: 0, cloud: [],                           ble: [],                                        mechKind: null,      label: "(未知のデバイス)" },
});

/** cloud と ble の op を和集合し、自然な提示順で返す (ble 由来を先、cloud 固有を後)。 */
function unionOps(caps) {
  const seen = new Set();
  const out = [];
  for (const o of [...caps.ble, ...caps.cloud]) if (!seen.has(o)) { seen.add(o); out.push(o); }
  return out;
}

// Hub3/WM2 の IR/リレー/LED は「別 API 面」(biz3OperateIoT) であって、ロック系デバイス制御
// (`sesame <device> <action>`) の動詞ではない。制御 op 語彙からは除外する。
const IOT_OPS = Object.freeze(["ir", "relay", "led"]);

/**
 * 全 kind の能力テーブル (CAPS) から、ロック系デバイス制御 op の語彙を **導出** する。
 * CLI の `sesame <device> <action>` で受理する動詞や、機種別能力ゲートの対象集合は、ここ
 * (= 能力の単一真実源) から引く。kind に新しい制御 op を足せば CLI へ自動的に波及し、
 * cli.js 側でのハードコード二重管理 (旧 DEVICE_ACTIONS / BLE_OPS) を不要にする。
 * 提示順は自然順 (lock→unlock→toggle→click→autolock)。未知 op は末尾に積む (将来追加への保険)。
 */
function deriveControlOps() {
  const order = ["lock", "unlock", "toggle", "click", "autolock"];
  const all = new Set();
  for (const caps of Object.values(CAPS)) {
    for (const o of [...caps.ble, ...caps.cloud]) if (!IOT_OPS.includes(o)) all.add(o);
  }
  const ordered = order.filter((o) => all.has(o));
  for (const o of all) if (!ordered.includes(o)) ordered.push(o);
  return Object.freeze(ordered);
}

/**
 * productType (整数) → { model, kind }。
 * 値は CHProductModel enum (CHDeivceProtocols.kt:28-252) と deviceFactory() の生成クラスに準拠。
 * pType 12 は SDK でも欠番。
 */
export const PRODUCT_TYPES = Object.freeze({
  0:  { model: "sesame_2",                 kind: KIND.SESAME2 },
  1:  { model: "wm_2",                      kind: KIND.WIFI },
  2:  { model: "ssmbot_1",                  kind: KIND.BOT_OS2 },
  3:  { model: "bike_1",                    kind: KIND.BIKE_OS2 },
  4:  { model: "sesame_4",                  kind: KIND.SESAME2 },
  5:  { model: "sesame_5",                  kind: KIND.LOCK5 },
  6:  { model: "bike_2",                    kind: KIND.BIKE2 },
  7:  { model: "sesame_5_pro",              kind: KIND.LOCK5 },
  8:  { model: "open_sensor_1",             kind: KIND.BIOMETRIC },
  9:  { model: "ssm_touch_pro",             kind: KIND.BIOMETRIC },
  10: { model: "ssm_touch",                 kind: KIND.BIOMETRIC },
  11: { model: "BLE_Connector_1",           kind: KIND.LOCK5 },
  13: { model: "hub_3",                     kind: KIND.HUB3 },
  14: { model: "remote",                    kind: KIND.BIOMETRIC },
  15: { model: "remote_nano",               kind: KIND.BIOMETRIC },
  16: { model: "sesame_5_us",               kind: KIND.LOCK5 },
  17: { model: "bot_2",                     kind: KIND.BOT2 },
  18: { model: "sesame_face_Pro",           kind: KIND.BIOMETRIC },
  19: { model: "sesame_face",               kind: KIND.BIOMETRIC },
  20: { model: "sesame_6",                  kind: KIND.LOCK5 },
  21: { model: "sesame_6_pro",              kind: KIND.LOCK5 },
  22: { model: "sesame_face_pro_ai",        kind: KIND.BIOMETRIC },
  23: { model: "sesame_face_ai",            kind: KIND.BIOMETRIC },
  24: { model: "open_sensor_2",             kind: KIND.BIOMETRIC },
  25: { model: "ssm_touch_2",               kind: KIND.BIOMETRIC },
  26: { model: "ssm_touch_2_pro",           kind: KIND.BIOMETRIC },
  27: { model: "sesame_face_2",             kind: KIND.BIOMETRIC },
  28: { model: "ssm_face_2_pro",            kind: KIND.BIOMETRIC },
  29: { model: "sesame_miwa",               kind: KIND.LOCK5 },
  30: { model: "sesame_face_2_ai",          kind: KIND.BIOMETRIC },
  31: { model: "sesame_face_2_pro_ai",      kind: KIND.BIOMETRIC },
  32: { model: "sesame_6_pro_slidingdoor",  kind: KIND.LOCK5 },
  33: { model: "bike_3",                    kind: KIND.BIKE3 },
  35: { model: "bot_3",                     kind: KIND.BOT2 },
  36: { model: "hub_3_lte",                 kind: KIND.HUB3 },
});

/** model 文字列 → kind の逆引き表。 */
const KIND_BY_MODEL = Object.freeze(
  Object.fromEntries(Object.values(PRODUCT_TYPES).map((v) => [v.model, v.kind])),
);

/**
 * ロック系デバイス制御 op の語彙 (CAPS から導出した単一真実源)。
 * 現状 = ["lock", "unlock", "toggle", "click", "autolock"]。
 * Hub3/WM2 の ir/relay/led は含まない (別 API 面)。"status" は制御 op ではなく状態取得なので含まない。
 * CLI の `sesame <device> <action>` 受理動詞・機種別能力ゲートはこれを参照し、二重定義を排する。
 * @type {readonly string[]}
 */
export const CONTROL_OPS = deriveControlOps();

/**
 * model 文字列から kind を返す。
 *   - model 未指定 (null/空) → lock5 (SesameBle の config-less 利用 & 既存ロック config の後方互換。
 *     config.locks は同期時にロック機種のみ whitelist + model 保存なので、ここに来るのは実質ロック)。
 *   - model 文字列がテーブルに無い → **UNKNOWN (操作なし)**。未知機種を勝手にロック扱いして解錠等を
 *     捏造しない (Hub3 が解錠を出していた類のバグを構造的に防ぐ)。
 * @param {string|null|undefined} model
 * @returns {string} KIND
 */
export function kindForModel(model) {
  if (!model) return KIND.LOCK5;
  return KIND_BY_MODEL[model] || KIND.UNKNOWN;
}

/**
 * model 文字列から能力定義を返す。
 *   - cloud / ble : 各経路で操作可能な op
 *   - ops         : 和集合 (UI で見せる操作・提示順)
 *   - bleSupported: BLE 制御を実装しているか (= ble.length>0)
 *   - biometric   : 生体・アクセス制御の BLE 登録 API を持つか (BIOMETRIC kind のみ true)
 *   - wifiProvisioning: WM2 の BLE プロビジョニング API を持つか (WIFI kind のみ true)
 *   - script      : Bot2/Bot3 のスクリプト API を持つか (BOT2 kind のみ true)
 *   - fingerprint : Bike3 の指紋登録 API を持つか (BIKE3 kind のみ true)
 *   - hubProvisioning: Hub3 の BLE プロビジョニング API を持つか (HUB3 kind のみ true)
 * @param {string|null|undefined} model
 * @returns {{kind:string, os:number, cloud:string[], ble:string[], ops:string[], mechKind:string|null, bleSupported:boolean, biometric:boolean, wifiProvisioning:boolean, hubProvisioning:boolean, script:boolean, fingerprint:boolean, label:string}}
 */
export function capabilitiesForModel(model) {
  const kind = kindForModel(model);
  const caps = CAPS[kind];
  return { kind, ...caps, ops: unionOps(caps), bleSupported: caps.ble.length > 0, biometric: !!caps.biometric, wifiProvisioning: !!caps.wifiProvisioning, hubProvisioning: !!caps.hubProvisioning, script: !!caps.script, fingerprint: !!caps.fingerprint };
}

/** その model が op を (いずれかの経路で) 操作できるか。 */
export function supportsOp(model, op) {
  return capabilitiesForModel(model).ops.includes(op);
}

/** その model が (いずれかの経路で) 何か操作できるか。session の対象判定に使う。 */
export function isOperable(model) {
  return capabilitiesForModel(model).ops.length > 0;
}

/**
 * その model の op を運べる transport 一覧 (型×経路の能力テーブルから導出)。
 * 例: lock5 の autolock は ["ble"]、lock は ["ble","cloud"]、hub3 の ir は ["cloud"]。
 * @param {string|null|undefined} model
 * @param {string} op
 * @returns {string[]} ("ble" / "cloud" の部分集合)
 */
export function transportsForOp(model, op) {
  const caps = capabilitiesForModel(model);
  const t = [];
  if (caps.ble.includes(op)) t.push("ble");
  if (caps.cloud.includes(op)) t.push("cloud");
  return t;
}
