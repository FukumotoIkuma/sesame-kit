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
 * - bike2     : SESAME Bike2/Bike3 (OS3) — unlock のみ
 * - sesame2   : Sesame2/3/4 (OS2 ロック) — BLE は別プロトコル (未実装)
 * - botOs2    : SESAME Bot1 (OS2) — BLE 未実装
 * - bikeOs2   : Bike1 (OS2) — BLE 未実装
 * - biometric : Touch/Face/OpenSensor/Remote (鍵束デバイス。施錠操作なし)
 * - hub3      : Hub3/Hub3 LTE (IoT 中継。BLE 施錠操作なし)
 * - wifi      : WifiModule2
 */
export const KIND = Object.freeze({
  LOCK5: "lock5", BOT2: "bot2", BIKE2: "bike2",
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
 *  - ble      : この CLI が **BLE 直接**で送れる制御 op。OS2 系は BLE プロトコル未実装なので空。
 *  - mechKind : mechStatus の解釈方法 ("os3lock" 7B / "os3bot" 3B / null)
 *  - label    : 表示用の種別名
 *
 * 出典: 型×経路の可否は調査で確定 (lock.js triggerLock=機種非依存に lock/unlock/toggle/click を中継、
 *       autolock はクラウド未反映=lock.js:127-131、Hub3 の ir/relay/led=iot.js/transport.js、
 *       OS2 BLE 未実装=ble/* 、biometric は制御 op なし=管理のみ)。
 */
const CAPS = Object.freeze({
  [KIND.LOCK5]:    { os: 3, cloud: ["lock", "unlock", "toggle"], ble: ["lock", "unlock", "toggle", "autolock"], mechKind: "os3lock", label: "SESAME (lock)" },
  [KIND.BOT2]:     { os: 3, cloud: ["click"],                    ble: ["click"],                                 mechKind: "os3bot",  label: "SESAME Bot" },
  [KIND.BIKE2]:    { os: 3, cloud: ["unlock"],                   ble: ["unlock"],                                mechKind: "os3bot",  label: "SESAME Bike" },
  [KIND.SESAME2]:  { os: 2, cloud: ["lock", "unlock", "toggle"], ble: [],                                        mechKind: null,      label: "SESAME (OS2 lock)" },
  [KIND.BOT_OS2]:  { os: 2, cloud: ["click"],                    ble: [],                                        mechKind: null,      label: "SESAME Bot (OS2)" },
  [KIND.BIKE_OS2]: { os: 2, cloud: ["unlock"],                   ble: [],                                        mechKind: null,      label: "SESAME Bike (OS2)" },
  [KIND.BIOMETRIC]:{ os: 3, cloud: [],                           ble: [],                                        mechKind: null,      label: "SESAME Touch/Face/Sensor/Remote" },
  [KIND.HUB3]:     { os: 3, cloud: ["ir", "relay", "led"],       ble: [],                                        mechKind: null,      label: "SESAME Hub3" },
  [KIND.WIFI]:     { os: 3, cloud: ["ir", "relay", "led"],       ble: [],                                        mechKind: null,      label: "WiFi Module 2" },
  [KIND.UNKNOWN]:  { os: 0, cloud: [],                           ble: [],                                        mechKind: null,      label: "(未知のデバイス)" },
});

/** cloud と ble の op を和集合し、自然な提示順で返す (ble 由来を先、cloud 固有を後)。 */
function unionOps(caps) {
  const seen = new Set();
  const out = [];
  for (const o of [...caps.ble, ...caps.cloud]) if (!seen.has(o)) { seen.add(o); out.push(o); }
  return out;
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
  33: { model: "bike_3",                    kind: KIND.BIKE2 },
  35: { model: "bot_3",                     kind: KIND.BOT2 },
  36: { model: "hub_3_lte",                 kind: KIND.HUB3 },
});

/** model 文字列 → kind の逆引き表。 */
const KIND_BY_MODEL = Object.freeze(
  Object.fromEntries(Object.values(PRODUCT_TYPES).map((v) => [v.model, v.kind])),
);

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
 * @param {string|null|undefined} model
 * @returns {{kind:string, os:number, cloud:string[], ble:string[], ops:string[], mechKind:string|null, bleSupported:boolean, label:string}}
 */
export function capabilitiesForModel(model) {
  const kind = kindForModel(model);
  const caps = CAPS[kind];
  return { kind, ...caps, ops: unionOps(caps), bleSupported: caps.ble.length > 0 };
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
