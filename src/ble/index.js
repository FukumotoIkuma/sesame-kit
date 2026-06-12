// SESAME BLE 直接制御の公開エントリ。
//
// クラウド (WebSocket/biz3) を介さず、PC の Bluetooth から登録済み SESAME を直接操作する。
// クラウドでは不可だった設定系 (autolock 等) も BLE なら本体に反映される。
//
// 使い方 (高レベル):
//   import { SesameBle } from "sesame-kit";        // もしくは: import { ble } from "sesame-kit"
//   await SesameBle.use({ deviceUUID, secretKey }, async (lock) => {
//     await lock.unlock();
//     await lock.autolock(30);              // ← クラウド不可・BLE 可
//     console.log(lock.lastStatus);
//   });
//
// 低レベル層 (protocol/session/transport) も個別 export。独自トランスポートを注入する場合は
// new SesameBle({ secretKey, transport }) で差し替え可能。

import { Buffer } from "node:buffer";
import { t } from "../i18n.js";
import { badRequest, timeoutError } from "../util.js";
import { SesameBleSession } from "./session.js";
import { createBleTransport } from "./transport.js";
import {
  ITEM, MECH_STATE, historyTagBLE,
} from "./protocol.js";
import { capabilitiesForModel, KIND } from "./devicemodel.js";
import { BiometricCommands } from "./biometric.js";
import { Bot2Commands, SCRIPT_RPC_OPS } from "./bot2.js";
import { WifiModule2, WM2_GATT } from "./wm2.js";
import { Hub3Commands } from "./hub3.js";
// SURF-08 段階3: 各 facade の RPC 公開仕様 (*_RPC_OPS) を集約して BLE_RPC_OPS を組む。
// 未記述のものは空 {} プレースホルダ (担当エージェントが各 facade で実体を埋め、import に差し替える)。
import { BIOMETRIC_RPC_OPS, FINGERPRINT_RPC_OPS, REMOTE_NANO_RPC_OPS } from "./biometric.js";
import { WM2_RPC_OPS } from "./wm2.js";
import { HUB3_RPC_OPS } from "./hub3.js";
import { updateFirmware as dfuUpdateFirmware, updateFirmwareBleOnly, updateFirmwareWM2 } from "./dfu.js";

import { scanSesames, listNearbyDevices, NobleTransport } from "./transport.js";
import { signGuestKey } from "../devices.js";

export { SesameBleSession, BleResultError } from "./session.js";
// SesameResultCode (デバイス層の結果コード taxonomy)。BLE エラーの .resultName で分岐可能。
export { RESULT as SESAME_RESULT_CODES, resultName } from "./protocol.js";
export { NobleTransport, createBleTransport, advToDeviceUUID, parseAdvertisement, scanSesames, listNearbyDevices, peripheralToDiscovery } from "./transport.js";
export * as protocol from "./protocol.js";
export * as devicemodel from "./devicemodel.js";
export { capabilitiesForModel, kindForModel, supportsOp, isOperable, transportsForOp, CONTROL_OPS, KIND, PRODUCT_TYPES, BIO_CAPABILITY, bioCapsForModel } from "./devicemodel.js";

// 生体・アクセス制御デバイス (Touch/Touch Pro/Face/Palm) の BLE 登録。BiometricCommands は
// SesameBle.biometric ゲッタ経由でも露出するが、純関数のペイロード生成器/publish ハンドラを
// 直接使いたい結線向けに本モジュールごと再公開する。
export {
  BiometricCommands, handleBiometricPublish, parseTouchCard, parseTouchFace,
  parseRemoteNanoTrigger, remoteNanoTriggerDelayData, radarSensitivityData,
  insertSesameData as biometricInsertSesameData,
  removeSesameData as biometricRemoveSesameData,
  createEnrollCollector,
} from "./biometric.js";
export * as biometric from "./biometric.js";

// SESAME Bot2/Bot3 のスクリプト機能 (click(index) / select / get / sendClickScript)。Bot2Commands は
// SesameBle.script ゲッタ経由でも露出するが、純関数の payload 生成器/parser を直接使いたい結線向けに
// 本モジュールごと再公開する (実体は src/ble/bot2.js)。
export {
  Bot2Commands, BOT_ACTION_TYPE,
  clickItemCode, bot2ActionToBytes, scriptToBytes,
  parseCurrentScript, parseScriptNameList,
} from "./bot2.js";
export * as bot2 from "./bot2.js";

// WifiModule2 (WM2) の BLE プロビジョニング (Wi-Fi 設定・子 Sesame 鍵登録)。WifiModule2 は
// SesameBle.wifi ゲッタ経由でも露出するが、純関数の data builder / publish parser を直接使いたい
// 結線向けに本モジュールごと再公開する。WM2 は専用 GATT (WM2_GATT) で接続する必要がある。
export {
  WifiModule2, WM2_GATT, WM2_ACTION,
  scanWifiSSIDData, setWifiSSIDData, setWifiPasswordData, connectWifiData,
  insertSesamesData, removeSesameData,
  parseScanWifiSSID, parseWifiSSIDPublish, parseWifiPasswordPublish,
  parseNetworkStatus, parseSesameKeys, parseWM2Publish,
} from "./wm2.js";
export * as wm2 from "./wm2.js";

// SESAME Hub3 / Hub3 LTE の BLE プロビジョニング (Wi-Fi 設定・SSID スキャン・子鍵削除・接続種別)。
// Hub3Commands は SesameBle.hub3 ゲッタ経由でも露出するが、純関数の data builder / publish parser を
// 直接使いたい結線向けに本モジュールごと再公開する。Hub3 は SESAME 既定 GATT (WM2 のような専用 GATT
// は不要) で接続し、Hub3 固有の SesameItemCode (itemcodes.js HUB3_*) を使う。
export {
  Hub3Commands,
  parseHub3Publish, parseNetworkType, parseMechSetting as parseHub3MechSetting,
  parseScanWifiSSID as parseHub3ScanWifiSSID, parseSesameKeys as parseHub3SesameKeys,
  networkTypeData,
} from "./hub3.js";
export * as hub3 from "./hub3.js";

// BLE 経由ファームウェア更新 (DFU/OTA)。SesameBle.updateFirmware() 経由でも露出するが、
// model 別の純ロジック (Hub3=BleOnly / WM2=WM2 / OS3 lock=transport ハンドル返し) と進捗購読
// ヘルパを直接使いたい結線向けに本モジュールごと再公開する (実体は src/ble/dfu.js)。
export {
  updateFirmware, updateFirmwareBleOnly, updateFirmwareWM2,
  onMoveToOtaProgress, onWM2OtaProgress,
} from "./dfu.js";
export * as dfu from "./dfu.js";

// OS2 デバイス (SESAME2/3/4・初代 Bot・初代 Bike) は別プロトコルの専用ファサードを使う。
// SesameBle (OS3) とは API は揃えてあるが login が ECDH 由来 (keyIndex/ssmPublicKey が必須) で別物。
export { SesameOS2Ble, SesameOS2BleSession, SesameOS2BleCipher } from "./os2/index.js";
export * as os2 from "./os2/index.js";

// ---------- RPC 公開面 allowlist (P4-1 段階3 / P4-2) ----------
//
// serve の `ble.invoke` / `ble.os2.invoke` はドット区切り op パスでファサードを動的に辿る。
// 旧実装はブロックリスト (`_`/constructor/prototype) のみの fail-open で、ファサードの全公開面
// (connect/close/register 等のライフサイクル管理 API や static 面) に到達できた (ARCH-14)。
// ここで「意図的に RPC へ公開する第 1 セグメント」を allowlist として単一定義し、
// registry.invokePath は非掲載パスを bad_params で拒否する (fail-closed)。
//
// 将来の「BLE 版 NAMESPACE_OPS」(facade メソッド表からの registry 自動生成、P4-1 段階3) も
// この表を単一の真実として使う。**ファサードに公開メソッドを足したらここにも足すこと**
// (tests/ble/rpc-allowlist.test.js が「表の全名が実在する」ことを固定している)。
//
// 意図的に**載せない**もの (理由):
//   - connect / close / use / register / registerOnce / connectMany / listNearby / fromDiscovery:
//     接続ライフサイクルと登録は ble.invoke の SesameBle.use() と ble.register RPC が管理する。
//     invoke 経由で二重 connect / 切断 / 再登録させない。
//   - onStatus: 購読 API。戻り値が unsubscribe 関数で 1 往復 RPC では意味を成さない。
/** SesameBle (OS3) ファサードの RPC 公開面 (op パス第 1 セグメント)。 */
export const BLE_RPC_ALLOWLIST = Object.freeze([
  // 制御 verb (CONTROL_OPS 系)
  "lock", "unlock", "click", "toggle", "autolock",
  // 状態取得
  "status", "lastStatus", "lastMechSetting", "lastOpsSetting", "isConnected",
  // 機種情報・能力
  "model", "capabilities", "supports",
  // 履歴・バージョン
  "history", "deleteHistory", "getVersionTag",
  // 設定・管理 (LOCK5 固有ガードは各メソッドが実施)
  "configureLockPosition", "magnet", "opSensorControl", "sendAdvProductType", "setBleTxPower",
  "reset", "updateFirmware", "resetWifiModule2",
  // サブファサード (biometric/fingerPrint/remoteNano/script は getter、wifi/hub3 はメソッド)
  "biometric", "fingerPrint", "remoteNano", "script", "wifi", "hub3",
]);

/**
 * SesameOS2Ble ファサードの RPC 公開面 (op パス第 1 セグメント)。
 * 除外の方針は BLE_RPC_ALLOWLIST と同じ (connect/close/register 系・onStatus は載せない —
 * 登録は ble.os2.register RPC が担う)。
 */
export const OS2_BLE_RPC_ALLOWLIST = Object.freeze([
  // 制御 verb
  "lock", "unlock", "click", "toggle",
  // autolock 系 (OS2 は read/update が別メソッド)
  "autolock", "disableAutolock", "getAutolock",
  // 状態取得
  "status", "lastStatus", "loginInfo", "isConnected", "model",
  // 履歴・バージョン
  "history", "versionTag",
  // 設定・管理
  "configureLockPosition", "updateSetting", "reset", "updateFirmware",
]);

/**
 * BLE op の RPC 公開仕様 1 件 (SURF-08 段階3)。registry がこれを読み `ble.<op>` を
 * 型付き RPC/SDK メソッドに自動展開する。`params` の順序 = ファサードメソッドの位置引数の順序。
 * @typedef {Record<string, { params: Array<{name:string, type:("number"|"string"|"boolean"|"object"|"array"), required:boolean, desc?:string}>, result:("ack"|"raw"|string), summary?:string }>} BleRpcOpSpec
 */

/**
 * OS3 トップレベル op (サブファサードに属さない SesameBle 直下メソッド) の RPC 公開仕様。
 * 制御 verb (lock/unlock/click/toggle/autolock) と状態取得は cloud 側 lock.* / ble.invoke と
 * 重複するため **載せない** (混乱回避)。ここは BLE 固有の書き込み/管理系のみ。
 * configureLockPosition / reset / updateFirmware は専用 RPC (ble.position 等) が override する。
 * @type {BleRpcOpSpec}
 */
const OS3_TOPLEVEL_RPC_OPS = {
  // history(): item=4、payload は履歴 1 件分の生バイト (先頭 4B が recordId)。読み取り系。
  // src/ble/index.js:992 history()→session.readHistory() / session.js:569 / CHSesameOS3LockBase.kt:185-192
  "history": { params: [], result: "raw", summary: "read one BLE history record (OS3, raw bytes; first 4B = recordId)" },
  // deleteHistory(historyPayload): item=18。引数は **history() が返した payload Buffer 全体**
  // (session が先頭 4B を recordId として切り出す)。recordId 数値ではない。送信系 (ack)。
  // src/ble/index.js:999 deleteHistory(historyPayload) / session.js:582 / CHSesameOS3LockBase.kt:200-209
  "deleteHistory": { params: [{ name: "historyPayload", type: "object", required: true, desc: "the payload Buffer returned by history() (first 4B = recordId); JSON {$buffer} / {type:'Buffer',data} accepted" }], result: "ack" },
  // getVersionTag(): item=5、Promise<string> を返す読み取り系。
  // src/ble/index.js:985 getVersionTag()→session.getVersionTag() / session.js:556
  "getVersionTag": { params: [], result: "raw", summary: "read firmware version tag string (OS3)" },
  // magnet(): item=17、CHResult<CHEmpty> を返す**コマンド** (磁力操作)。読み取りではなく ack。
  // 空ペイロード送信、LOCK5 固有。src/ble/index.js:902 / CHSesame5Device.kt:118-126 / CHSesame5.kt:16
  "magnet": { params: [], result: "ack", summary: "send the magnet command (SESAME 5, LOCK5-only)" },
  // opSensorControl(seconds): item=92 OPS_CONTROL。引数は Int を 2B LE で送る Open Sensor 自動施錠
  // 秒数 (0..65535、0=無効)。boolean ではない。LOCK5 固有。
  // src/ble/index.js:915 opSensorControl(seconds) / CHSesame5Device.kt:107-116 (isEnable: Int)
  "opSensorControl": { params: [{ name: "seconds", type: "number", required: true, desc: "open-sensor auto-lock seconds (0..65535, 0 = disable)" }], result: "ack" },
  // sendAdvProductType(data): item=205 SET_ADV_PRODUCT_TYPE。引数 data (生バイト列 Buffer) が **必須**。
  // 引数なしではない。LOCK5 固有。src/ble/index.js:928 sendAdvProductType(data) /
  // CHSesame5Device.kt:85-94 sendAdvProductTypeCommand(data: ByteArray)
  "sendAdvProductType": { params: [{ name: "data", type: "object", required: true, desc: "raw advertised product-type bytes (Buffer); JSON {$buffer} / {type:'Buffer',data} accepted" }], result: "ack" },
  // setBleTxPower(txPower): item=206。引数は符号付き 1B (-128..127)。draft の "level" は誤名。
  // OS3 LOCK5 / biometric のみ露出。src/ble/index.js:942 setBleTxPower(txPower) /
  // CHSesameOS3LockBase.kt:62-71 setBleTxPower(txPower: Byte) / CHSesameBiometricDeviceImpl.kt:332-341
  "setBleTxPower": { params: [{ name: "txPower", type: "number", required: true, desc: "signed 1-byte BLE TX power (-128..127)" }], result: "ack" },
};

/**
 * OS2 トップレベル op (SesameOS2Ble) の RPC 公開仕様。OS2 は autolock の read/update が
 * 別メソッド。制御 verb は cloud lock.* と重複するため載せない。
 * @type {BleRpcOpSpec}
 */
const OS2_TOPLEVEL_RPC_OPS = {
  // autolock(seconds, tag): OP.update item=11、2B LE 秒数 ++ 履歴タグ。送信系 (ack)。
  // tag は履歴に残す任意 Buffer (省略可)。src/ble/os2/index.js:191 / CHSesame2Device.kt:141
  "autolock": { params: [
    { name: "seconds", type: "number", required: true, desc: "auto-lock delay seconds (0..65535, 0 = disable)" },
    { name: "tag", type: "object", required: false, desc: "optional history tag bytes (Buffer)" },
  ], result: "ack" },
  // disableAutolock(tag): autolock(0, tag) のショートカット。送信系。
  // src/ble/os2/index.js:194 / CHSesame2Device.kt:150-152
  "disableAutolock": { params: [{ name: "tag", type: "object", required: false, desc: "optional history tag bytes (Buffer)" }], result: "ack", summary: "disable auto-lock (= autolock(0)) (OS2)" },
  // getAutolock(): OP.read item=11、Promise<number> (現在の秒数)。読み取り系。
  // src/ble/os2/index.js:200 / CHSesame2Device.kt:157-160
  "getAutolock": { params: [], result: "raw", summary: "read the current auto-lock seconds (OS2)" },
  // history({ack}): OP.read item=4、Promise<Buffer> (履歴 1 バッチ生バイト)。読み取り系。
  // ack=true (既定) は取得後デバイス側で消す挙動。opts はオプションオブジェクト 1 引数。
  // src/ble/os2/index.js:236 history({ack=true}) / CHSesame2Device.kt:606-612
  "history": { params: [{ name: "opts", type: "object", required: false, desc: "{ ack?: boolean } — ack=false reads without deleting on-device (default true)" }], result: "raw", summary: "read one BLE history batch (OS2, raw bytes)" },
  // versionTag(): OP.read item=5、Promise<string>。読み取り系。
  // src/ble/os2/index.js:211 / CHSesame2Device.kt:131-133
  "versionTag": { params: [], result: "raw", summary: "read firmware version tag string (OS2)" },
  // updateSetting(setting, tag): OP.update item=80 mechSetting。Bot1 の mech_setting を更新する送信系。
  // setting は 7 フィールドの Bot1 設定オブジェクト (必須)、tag は履歴タグ (省略可)。Bot1 専用。
  // src/ble/os2/index.js:267 updateSetting(setting, tag) / CHSesameBotDevice.kt:418-430
  "updateSetting": { params: [
    { name: "setting", type: "object", required: true, desc: "Bot1 mech setting object {userPrefDir, lockSec, unlockSec, clickLockSec, clickHoldSec, clickUnlockSec, buttonMode}" },
    { name: "tag", type: "object", required: false, desc: "optional history tag bytes (Buffer)" },
  ], result: "ack" },
};

/**
 * OS3 ファサード (SesameBle) の全 op の RPC 公開仕様 (= 「BLE 版 NAMESPACE_OPS」)。
 * 各サブファサード/トップレベルの `*_RPC_OPS` を集約する。これにより `ble.<op>` の全体が
 * registry → openrpc/proto/SDK へ型付きで自動生成される (SURF-08 段階3)。すべて experimental。
 * @type {BleRpcOpSpec}
 */
export const BLE_RPC_OPS = Object.freeze({
  ...SCRIPT_RPC_OPS,
  ...BIOMETRIC_RPC_OPS,
  ...FINGERPRINT_RPC_OPS,
  ...REMOTE_NANO_RPC_OPS,
  ...WM2_RPC_OPS,
  ...HUB3_RPC_OPS,
  ...OS3_TOPLEVEL_RPC_OPS,
});

/**
 * OS2 ファサード (SesameOS2Ble) の全 op の RPC 公開仕様。
 * @type {BleRpcOpSpec}
 */
export const OS2_BLE_RPC_OPS = Object.freeze({ ...OS2_TOPLEVEL_RPC_OPS });

/**
 * deviceUUID 正規化 (照合用)。
 * @param {string} u
 * @returns {string}
 */
function normId(u) { return String(u).replace(/-/g, "").toLowerCase(); }

const STATUS_WAIT_MS = 4_000;

// 生体 capability → BiometricCommands のメソッド群 (P3-15)。
// SDK では capability ごとに CH*Capable インタフェースが分かれ、DeviceProfiles の集合に
// 含まれる capability のメソッドだけが機種に生える (CHSesameBiometricDevice.kt:28-57 /
// hasBiometricCapability)。kit ではこの表で BiometricCommands を「集合内のメソッドだけを持つ
// 限定ビュー」に絞る (既存 fingerPrint ゲッタと同型)。キーは devicemodel.js BIO_CAPABILITY の値。
const BIO_VIEW_METHODS = Object.freeze({
  // CHCardCapable (card 系 + batchAdd)
  card: Object.freeze(["cardModeSet", "cardModeGet", "cardGet", "cardAdd", "cardDelete", "cardMove", "cardChange", "cardChangeValue", "cardBatchAdd"]),
  // CHFingerPrintCapable
  fingerprint: Object.freeze(["fingerPrintModeSet", "fingerPrintModeGet", "fingerPrints", "fingerPrintDelete", "fingerPrintChange"]),
  // CHPassCodeCapable (passcode 系 + batchAdd)
  passcode: Object.freeze(["passcodeModeSet", "passcodeModeGet", "passcodeGet", "passcodeAdd", "passcodeDelete", "passcodeMove", "passcodeChange", "passcodeBatchAdd"]),
  // CHFaceCapable
  face: Object.freeze(["faceModeSet", "faceModeGet", "faceListGet", "faceChange", "faceDelete"]),
  // CHPalmCapable。palmChange は **SDK に送信実装が存在しない** ため表に無い (追加バックログ 3 で
  // 検証済み): CHPalmCapableImpl.kt:13-67 の送信は palmModeSet/palmModeGet/palmListGet/palmDelete
  // の 4 つのみで、PALM_CHANGE(162) は CHPalmEventHandlers.kt:16-18 が **受信専用** で
  // onPalmChanged へ流すだけ (faceChange (CHFaceCapableImpl.kt:50) に対応する palm 側の送信
  // メソッドは SDK に無い)。op を捏造しない方針 (§0.1) によりポートしない。
  palm: Object.freeze(["palmModeSet", "palmModeGet", "palmListGet", "palmDelete"]),
});

/**
 * biometric ゲッタが返す限定ビューの型。
 *
 * ★型は全 capability のメソッドを持つが、**実行時は bioCaps 集合内のメソッドだけが存在する**
 * (集合外は undefined — DeviceProfiles で機種ごとに静的に決まるため、モデルごとの部分型を
 * 静的に表現できない以上、型は上限・実体は機種別部分集合という関係になる)。集合外メソッドの
 * 呼び出しは TypeError になる (op を捏造して実機に送ることはない)。
 * @typedef {Pick<BiometricCommands,
 *   "cardModeSet"|"cardModeGet"|"cardGet"|"cardAdd"|"cardDelete"|"cardMove"|"cardChange"|"cardChangeValue"|"cardBatchAdd"
 *   |"fingerPrintModeSet"|"fingerPrintModeGet"|"fingerPrints"|"fingerPrintDelete"|"fingerPrintChange"
 *   |"passcodeModeSet"|"passcodeModeGet"|"passcodeGet"|"passcodeAdd"|"passcodeDelete"|"passcodeMove"|"passcodeChange"|"passcodeBatchAdd"
 *   |"faceModeSet"|"faceModeGet"|"faceListGet"|"faceChange"|"faceDelete"
 *   |"palmModeSet"|"palmModeGet"|"palmListGet"|"palmDelete"
 *   |"insertSesame"|"removeSesame"|"setRadarSensitivity"|"registerDelegate"|"onEnroll">} BiometricView
 */

/**
 * remoteNano ゲッタが返す限定ビューの型 (Remote / Remote Nano 専用面、追加バックログ 7)。
 * SDK が Remote 系 (CHSesameBiometricDeviceImpl) に与える公開面と 1:1:
 *   - setTriggerDelayTime: CHRemoteNanoCapable.kt:8 (送信 190)
 *   - insertSesame/removeSesame/setRadarSensitivity: CHSesameConnector (CHDeivceProtocols.kt:317-322)
 *   - registerDelegate: CHRemoteNanoCapable.registerEventDelegate 相当 (publish 191/201 等の受信結線)
 * setTriggerDelayTime は BiometricCommands.setTriggerDelay へ委譲し、request の ack
 * ({resultCode,payload}) をそのまま返す (SURF-08: `ble.remoteNano.setTriggerDelayTime` の
 * "ack" RPC 契約が bleCommandAck で {resultCode,resultName} を組めるようにするため。送信系の
 * BiometricCommands メソッドは ack を返す)。
 * @typedef {Pick<BiometricCommands, "insertSesame"|"removeSesame"|"setRadarSensitivity"|"registerDelegate">
 *   & {setTriggerDelayTime: (time:number)=>Promise<{resultCode:number, payload:import("node:buffer").Buffer}>}} RemoteNanoView
 */

/**
 * サーバ署名トランスポート (makeRegisterTransport の戻り)。signGuestKey / register に渡す。
 * 正準型は devices.js が所有する。
 * @typedef {import("../devices.js").RegisterTransport} RegisterTransport
 */

/**
 * 発見結果に含まれる noble peripheral ハンドル。正準型は transport.js が所有する。
 * @typedef {import("./transport.js").NoblePeripheral} NoblePeripheral
 */

/**
 * SesameBle コンストラクタ opts。
 * @typedef {Object} SesameBleOptions
 * @property {string|Buffer} [secretKey] ロック共通鍵 (32 文字 hex、cloud の `sesame devices` で取得済み)。register モードでは不要 (工場出荷デバイスは鍵が未確定)。
 * @property {string} [deviceUUID] 対象識別 (advertise 照合)。複数 SESAME が近接する環境で必須。
 * @property {string} [address] BLE アドレスで識別する代替。
 * @property {string|null} [model] デバイス model 文字列 (能力テーブル参照用)。
 * @property {boolean} [registerMode] true で工場出荷デバイスの register() 用 (secretKey 不要・session を鍵無しで構築)。
 * @property {boolean} [needAuthFromServer] 登録済みだが server 認証が要るデバイス (ゲスト鍵等) で connect 時に signGuestKey login。
 * @property {RegisterTransport|null} [registerTransport] makeRegisterTransport の戻り (needAuthFromServer の signGuestKey / register に使用)。
 * @property {boolean} [debug]
 * @property {number} [scanTimeoutMs] 既定 transport のスキャン timeout。
 * @property {import("./session.js").BleTransport} [transport] 独自トランスポート (省略時 noble)。
 */

/**
 * register() 確定結果。
 * @typedef {Object} RegisterResult
 * @property {string} deviceUUID
 * @property {string} secretKey
 * @property {string|number|undefined} productType
 * @property {string} serverSecret
 */

/**
 * listNearbyDevices() の発見結果 1 件 (advertise だけから判る属性)。
 * @typedef {Object} DiscoveryEntry
 * @property {string} deviceUUID
 * @property {number} [productType]
 * @property {string|null} [model]
 * @property {string} [kind]
 * @property {boolean} [isRegistered]
 * @property {NoblePeripheral} peripheral
 */

/**
 * 登録済み SESAME を BLE で直接操作する高レベルファサード。
 */
export class SesameBle {
  /**
   * @param {SesameBleOptions} [opts]
   */
  constructor(opts = {}) {
    const { secretKey, deviceUUID, address, model = null, registerMode = false, needAuthFromServer = false, registerTransport = null, debug = false, scanTimeoutMs, transport } = opts;
    // register モードでは secretKey は未確定 (登録ハンドシェイクで導出する) ため要求しない。
    if (!registerMode && !secretKey) throw badRequest("ble.secretKeyRequired");
    // WM2 は SESAME ロックとは別 GATT サービス (WM2_GATT) で discover/subscribe する。
    // 既定 transport を作る場合のみ、WM2 model なら GATT を注入する (外部 transport 指定時は尊重)。
    const isWm2 = capabilitiesForModel(model).wifiProvisioning;
    this._transport = transport || createBleTransport({ deviceUUID, address, debug, scanTimeoutMs, gatt: isWm2 ? WM2_GATT : undefined });
    // register モードは secretKey 無しで session を構築 (SesameBleSession.register() の契約)。
    // WM2 (kind===WIFI) はセッション確立がロックと非互換 (initial=13 / 鍵=生16B / sault=token4。
    // CHWifiModule2Device.kt:279-321,521-528) のため profile "wm2" を渡す (P1-6)。
    const caps = capabilitiesForModel(model); // 型ごとの能力 (SDK CHProductModel 準拠)
    // P3-18: MECH_STATUS(81) の解釈 kind を caps.kind から静的に導出してセッションへ渡す。
    // SDK は具象クラスが型で 81 の意味を決める (CHHub3Device.kt:291-301 等)。
    // - LOCK5            : 7B ロック形式 (CHSesame5MechStatus)
    // - BOT2/BIKE2/BIKE3 : 3B Bot/Bike 形式 (CHSesameBot2MechStatus)
    // - HUB3             : 1B ネットワーク bit flags (CHWifiModule2NetWorkStatus)
    // - BIOMETRIC        : raw 素通し (CHSesameBiometricDeviceImpl.kt:214-217)
    const mechStatusKind = (() => {
      if (caps.kind === KIND.HUB3) return /** @type {"hub3"} */ ("hub3");
      if (caps.kind === KIND.BIOMETRIC) return /** @type {"biometric"} */ ("biometric");
      if (caps.kind === KIND.BOT2 || caps.kind === KIND.BIKE2 || caps.kind === KIND.BIKE3) return /** @type {"bot"} */ ("bot");
      return /** @type {"lock"} */ ("lock"); // LOCK5 および未知 kind はロック形式を既定とする
    })();
    this._session = new SesameBleSession({
      transport: this._transport,
      secretKey: registerMode ? undefined : secretKey,
      debug,
      profile: isWm2 ? "wm2" : "lock",
      // BLE3-03: login 後の time(8) 自動同期はロック系 (CHSesameOS3LockBase.kt:126-138) のみ。
      // handleLoginResponse (時刻同期) を持つのは CHSesameOS3LockBase 系
      // (SS5/Bot2/Bike2/Bike3 — CHSesame5Device.kt:34 / CHSesameBot2Device.kt:38 /
      // CHSesameBike2Device.kt:35)。次は login を override して時刻同期しない:
      //   - Hub3 (CHHub3Device.kt:167-178)
      //   - WM2 (CHWifiModule2Device.kt:314-321。profile="wm2" でも構造的に対象外だが明示)
      //   - 生体・アクセス制御 (CHSesameBiometricDeviceImpl.kt:67 は CHSesameOS3 直継承で
      //     :258-277 の login override はコールバックで deviceStatus 遷移のみ)
      syncTime: !(caps.kind === KIND.HUB3 || caps.kind === KIND.WIFI || caps.kind === KIND.BIOMETRIC),
      mechStatusKind,
    });
    this._model = model;
    this._caps = caps;
    this._deviceUUID = deviceUUID;
    this._registerMode = registerMode;
    this._secretKey = secretKey;
    this._needAuthFromServer = !!needAuthFromServer;
    this._registerTransport = registerTransport;
    this._debug = debug;
    /** @type {BiometricView|null} bioCaps 限定ビューの遅延生成キャッシュ (biometric ゲッタ)。 */
    this._biometric = null;
    /** @type {RemoteNanoView|null} Remote/Remote Nano 専用ビューの遅延生成キャッシュ (remoteNano ゲッタ)。 */
    this._remoteNano = null;
    this._bot2 = null;      // Bot2Commands の遅延生成キャッシュ (script ゲッタ)
    this._wifi = null;      // WifiModule2 の遅延生成キャッシュ (wifi ゲッタ)
    this._hub3 = null;      // Hub3Commands の遅延生成キャッシュ (hub3 ゲッタ)
    this._fingerPrint = null; // BiometricCommands (指紋サブセット) の遅延生成キャッシュ (fingerPrint ゲッタ)
  }

  /** デバイスの model 文字列 (例 "sesame_5" / "bot_2")。未指定なら null。 */
  get model() { return this._model; }
  /** 型ごとの能力 { kind, os, ops, mechKind, bleSupported, label }。 */
  get capabilities() { return this._caps; }
  /**
   * この操作を BLE で送れるか (このファサードは BLE 専用なので ble 能力で判定)。
   * @param {string} op
   * @returns {boolean}
   */
  supports(op) { return this._caps.ble.includes(op); }

  /**
   * 生体・アクセス制御デバイス (Touch/Touch Pro/Face/Palm 系) の BLE 登録 API。
   *
   * **機種別の capability 集合 (DeviceProfiles) で絞った限定ビュー** を返す (P3-15)。
   * SDK では capability 集合が機種ごとに deviceFactory() で固定され
   * (CHSesameBiometricDevice.kt:44-57 / CHDeivceProtocols.kt:77-216)、集合外の操作は存在しない。
   * kit でも bioCaps 集合内の capability のメソッド群 (BIO_VIEW_METHODS) だけを bind した
   * ビューを返す (既存 fingerPrint ゲッタと同型):
   *   - ssm_touch       → card + fingerprint (passcode 系は **見えない**)
   *   - ssm_touch_pro   → card + fingerprint + passcode
   *   - sesame_face     → card + fingerprint + palm + face
   *   - sesame_face_ai  → palm + face のみ (card 系は **見えない**)
   *   - sesame_face_Pro → 全部 / sesame_face_pro_ai → passcode + palm + face
   * 集合に依らない共通 API (CHSesameConnector / delegate 結線) は常に載る:
   *   insertSesame / removeSesame / setRadarSensitivity / registerDelegate / onEnroll
   *   (onEnroll の card/passcode 既定値は集合から導出され、集合外 kind は集約しない)。
   *
   * capabilitiesForModel(model).biometric が true の機種でのみ露出する。それ以外 (ロック/Bot/
   * Bike/Hub3/WiFi/未知) で参照すると enroll 非対応として明示エラーを投げる (op を捏造しない)。
   * **bioCaps が空集合の機種 (open_sensor_1/2, remote, remote_nano — CHDeivceProtocols.kt:81,112,
   * 118,172 で setOf()) でも明示エラーを投げる** (P3-15)。remote/remote_nano の専用面
   * (setTriggerDelayTime / connector 操作) は remoteNano ゲッタが露出する (追加バックログ 7)。
   * open sensor 系で connector 操作 (insertSesame 等) が必要な場合は
   * BiometricCommands(session, {model}) を直接構築すること。
   * connect() 前でも参照できる (session.request は connect 後に login 済みを要求する)。
   *
   * @returns {BiometricView} bioCaps で絞った BiometricCommands の限定ビュー
   *   (型は全 capability の上限。実行時に存在するのは集合内メソッドのみ — BiometricView 参照)
   */
  get biometric() {
    if (!this._caps.biometric) {
      throw badRequest("ble.biometricNotSupported", {
        label: this._caps.label,
        modelSuffix: this._model ? ` (${this._model})` : "",
      });
    }
    // 空集合機種 (open sensor / remote 系) は enroll API を一切持たない (DeviceProfiles の
    // setOf()) ため、何も持たないビューを返さず明示エラーにする (P3-15)。
    if (this._caps.bioCaps.length === 0) {
      throw badRequest("ble.biometricNoCaps", {
        label: this._caps.label,
        modelSuffix: this._model ? ` (${this._model})` : "",
      });
    }
    if (!this._biometric) {
      // model を渡して publish ディスパッチへ機種文脈を伝搬する (BLEP-09/BLEP-11)。
      const c = new BiometricCommands(this._session, { model: this._model });
      const caps = new Set(this._caps.bioCaps);
      /** @type {Record<string, Function>} */
      const view = {};
      for (const [capName, methods] of Object.entries(BIO_VIEW_METHODS)) {
        if (!caps.has(capName)) continue; // 集合外 capability のメソッドは持たせない
        for (const m of methods) view[m] = /** @type {any} */ (c)[m].bind(c);
      }
      // capability 非依存の共通 API (CHSesameConnector / CHDeviceConnectCapable / delegate 結線)。
      view.insertSesame = c.insertSesame.bind(c);
      view.removeSesame = c.removeSesame.bind(c);
      view.setRadarSensitivity = c.setRadarSensitivity.bind(c);
      view.registerDelegate = c.registerDelegate.bind(c);
      // onEnroll: 集合外 kind は集約しない (既定値を bioCaps から導出。明示指定があっても
      // 集合外は false に強制する — 集合に無い enroll publish は実機から来ない前提の安全側)。
      const hasCard = caps.has("card");
      const hasPasscode = caps.has("passcode");
      view.onEnroll = (/** @type {any} */ onEnrolled, /** @type {any} */ opts = {}) => c.onEnroll(onEnrolled, {
        ...opts,
        card: hasCard && (opts.card ?? true),
        passcode: hasPasscode && (opts.passcode ?? true),
      });
      // 動的に組んだ部分集合を BiometricView (型上限) へ確定する (実行時集合は bioCaps 準拠)。
      this._biometric = /** @type {BiometricView} */ (/** @type {unknown} */ (view));
    }
    return this._biometric;
  }

  /**
   * Remote / Remote Nano の専用 API (追加バックログ 7)。
   *
   * SDK では remote(pType 14) と remote_nano(pType 15) はどちらも BiometricDeviceType.REMOTE の
   * CHSesameBiometricDeviceImpl として生成され (CHDeivceProtocols.kt:112,118)、capability 集合は
   * 空 (setOf())。そのため biometric ゲッタは明示エラーを投げ (P3-15)、Remote 系が SDK 上で持つ
   * 次の公開面が facade から不達になっていた。ここで 1:1 に露出する (実在するもののみ):
   *   - setTriggerDelayTime(time): トリガ遅延の設定 — REMOTE_NANO_ITEM_CODE_SET_TRIGGER_DELAYTIME
   *     (190) + [time(UByte 1B)] (CHRemoteNanoCapable.kt:8 / CHRemoteNanoCapableImpl.kt:19-28)。
   *     **読み出しコマンドは SDK に存在しない**: 現在値は PUB_TRIGGER_DELAYTIME(191) publish が
   *     運び、registerDelegate の onTriggerDelaySecondReceived で受ける
   *     (CHRemoteNanoEventHandler.kt:15-21 — isRemote() の機種でのみ dispatch)。
   *   - insertSesame / removeSesame / setRadarSensitivity: CHSesameConnector 共通面
   *     (CHDeivceProtocols.kt:317-322。実装は CHDeviceConnectCapableImpl.kt:23-95 を
   *     CHSesameBiometricDeviceImpl.kt:411-412 が委譲し、Remote 系もこの実装クラスで生成される)。
   *     **radar 感度の読み出しコマンドも SDK に存在しない**: RADAR_PARAM_PUBLISH(201) publish を
   *     registerDelegate の onRadarReceive で受けるのみ (CHSesameBiometricDeviceImpl.kt:176,210-212)。
   *   - registerDelegate(delegate, device): publish 受信の delegate 結線
   *     (CHRemoteNanoCapable.registerEventDelegate 相当)。
   *
   * capabilitiesForModel(model).isRemote が true の機種 (= remote / remote_nano) でのみ露出する。
   * それ以外 (ロック/Bot/Bike/Touch/Face/open sensor/Hub3/WM2/未知) で参照すると明示エラーを投げる
   * (op を捏造しない)。open sensor 系は Remote ではない (BiometricDeviceType.OPEN_SENSOR/_2) ため
   * ここでは露出しない — SDK にも open sensor 固有の Capable interface は無く、connector 操作が
   * 必要な場合は new BiometricCommands(session, {model}) を直接構築する (biometric ゲッタの注記)。
   * connect() 前でも参照できる (session.request は connect 後に login 済みを要求する)。
   *
   * @experimental Remote 系 BLE 経路は SDK Kotlin の静的読みからの移植で **実機未検証**
   *   (参照: CHRemoteNanoCapableImpl.kt:19-28 / CHDeviceConnectCapableImpl.kt:23-95)。
   * @returns {RemoteNanoView}
   */
  get remoteNano() {
    if (!this._caps.isRemote) {
      throw badRequest("ble.remoteNanoNotSupported", {
        label: this._caps.label,
        modelSuffix: this._model ? ` (${this._model})` : "",
      });
    }
    if (!this._remoteNano) {
      // model を渡して publish ディスパッチへ機種文脈を伝搬する (isRemote=true →
      // TRIGGER_DELAYTIME(191) が onTriggerDelaySecondReceived へ届く。BLEP-09)。
      const c = new BiometricCommands(this._session, { model: this._model });
      this._remoteNano = {
        // 公開名は SDK の CHRemoteNanoCapable.kt:8 と 1:1 (setTriggerDelayTime)。
        // 実体は BiometricCommands.setTriggerDelay (itemCode 190 + [time 1B])。
        setTriggerDelayTime: (/** @type {number} */ time) => c.setTriggerDelay(time),
        insertSesame: c.insertSesame.bind(c),
        removeSesame: c.removeSesame.bind(c),
        setRadarSensitivity: c.setRadarSensitivity.bind(c),
        registerDelegate: c.registerDelegate.bind(c),
      };
    }
    return this._remoteNano;
  }

  /**
   * SESAME Bike3 の指紋登録 API (CHSesameBike3Device.kt:20-24 が mixin する CHFingerPrintCapable と 1:1)。
   *
   * Bike3 は Bike2 (解錠のみ) に CHFingerPrintCapable **だけ**を足した固有型で、card/passcode/face/palm
   * は持たない。よって biometric ゲッタ (生体全機能) ではなく、指紋サブセットのみを露出する:
   *   fingerPrints() / fingerPrintDelete(id) / fingerPrintChange(id, hexName) /
   *   fingerPrintModeGet() / fingerPrintModeSet(mode) と、publish 受信を delegate に流す
   *   registerDelegate()。実体は biometric.js の BiometricCommands (itemCode 115-122) を共用する
   *   (重複実装しない) が、ここでは指紋系メソッドだけを通す薄いビューに絞る。
   *
   * capabilitiesForModel(model).fingerprint が true の機種 (= Bike3) でのみ露出する。それ以外
   * (ロック/Bot/Bike2/biometric/Hub3/WiFi/未知) で参照すると非対応として明示エラーを投げる (op を捏造しない)。
   * connect() 前でも参照できる (session.request は connect 後に login 済みを要求する)。
   *
   * @returns {{fingerPrints:Function, fingerPrintDelete:Function, fingerPrintChange:Function, fingerPrintModeGet:Function, fingerPrintModeSet:Function, registerDelegate:Function}}
   */
  get fingerPrint() {
    if (!this._caps.fingerprint) {
      throw badRequest("ble.fingerPrintNotSupported", {
        label: this._caps.label,
        modelSuffix: this._model ? ` (${this._model})` : "",
      });
    }
    if (!this._fingerPrint) {
      // BiometricCommands を共用しつつ、指紋系メソッドだけを bind した限定ビューを返す
      // (card/passcode/face/palm を露出しないことで Bike3 の能力を SDK 通り絞る)。
      // model を渡して publish ディスパッチへ機種文脈を伝搬 (BLEP-09: Bike3 は非 Remote なので
      // TRIGGER_DELAYTIME(191) は黙殺される)。
      const c = new BiometricCommands(this._session, { model: this._model });
      this._fingerPrint = {
        fingerPrints: c.fingerPrints.bind(c),
        fingerPrintDelete: c.fingerPrintDelete.bind(c),
        fingerPrintChange: c.fingerPrintChange.bind(c),
        fingerPrintModeGet: c.fingerPrintModeGet.bind(c),
        fingerPrintModeSet: c.fingerPrintModeSet.bind(c),
        registerDelegate: c.registerDelegate.bind(c),
      };
    }
    return this._fingerPrint;
  }

  /**
   * SESAME Bot2 / Bot3 のスクリプト API (CHSesameBot2Device.kt:73-193 と 1:1)。
   *
   * click(index, tag) / sendClickScript(index, script) / selectScript(index) /
   * getCurrentScript(index) / getScriptNameList() と、直近の SCRIPT_NAME_LIST 結果を保持する
   * scripts プロパティを持つ Bot2Commands を返す (実体は src/ble/bot2.js、契約は session.request に乗る)。
   *
   * capabilitiesForModel(model).script が true の機種 (= Bot2/Bot3) でのみ露出する。それ以外
   * (ロック/Bike/biometric/Hub3/WiFi/未知) で参照すると非対応として明示エラーを投げる (op を捏造しない)。
   * connect() 前でも参照できる (session.request は connect 後に login 済みを要求する)。
   *
   * 注: ファサードの click(tag) (CLICK=89) は従来通り残す (index 無しの単純クリック)。index 指定 click と
   * スクリプト管理はこの script ゲッタ経由で行う。
   *
   * @returns {Bot2Commands}
   */
  get script() {
    if (!this._caps.script) {
      throw badRequest("ble.bot2NotSupported", {
        label: this._caps.label,
        modelSuffix: this._model ? ` (${this._model})` : "",
      });
    }
    if (!this._bot2) this._bot2 = new Bot2Commands(this._session, historyTagBLE);
    return this._bot2;
  }

  /**
   * WifiModule2 (WM2) の BLE プロビジョニング API。
   *
   * scanWifiSSID / setWifiSSID / setWifiPassword / connectWifi / insertSesames / removeSesame と、
   * 正規化済み WM2 publish ({kind, ...}; networkStatus は受信専用) を購読する onPublish を持つ
   * WifiModule2 を返す (実体は src/ble/wm2.js、契約は session.request / session.onPublish に乗る)。
   *
   * capabilitiesForModel(model).wifiProvisioning が true の機種 (= WM2) でのみ露出する。それ以外
   * (ロック/Bot/Bike/biometric/Hub3/未知) で参照すると非対応として明示エラーを投げる (op を捏造しない)。
   * connectWifi の companyId (= BuildConfig.API_GATEWAY_CLIENT_ID) と deviceUUID はここで束ねて
   * WifiModule2 に渡す (本番では config/env から供給する想定)。
   *
   * 注: WM2 は専用 GATT (WM2_GATT) で接続する必要がある。SesameBle を WM2 model で構築すると
   * 既定 transport に WM2_GATT が注入される (constructor)。connect() 前でも参照できる
   * (session.request は connect 後に login 済みを要求する)。
   *
   * @param {{companyId?:string}} [opts] connectWifi 用 companyId (API_GATEWAY_CLIENT_ID) の上書き。
   * @returns {WifiModule2}
   */
  wifi({ companyId } = {}) {
    if (!this._caps.wifiProvisioning) {
      throw badRequest("ble.wm2NotSupported", {
        label: this._caps.label,
        modelSuffix: this._model ? ` (${this._model})` : "",
      });
    }
    if (!this._wifi) {
      this._wifi = new WifiModule2({ session: this._session, companyId, deviceUUID: this._deviceUUID });
    }
    return this._wifi;
  }

  /**
   * WM2 を工場出荷状態へリセットする (CHWifiModule2Device.kt:437-448 reset() と 1:1)。
   *
   * RESET_WM2(18) を送り、成功時にセッションを破棄する (= SDK の dropKey 相当)。詳細は
   * WifiModule2.reset() を参照。wifiProvisioning 非対応機種では wifi() と同じく明示エラーを投げる。
   *
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<{resultCode:number, payload:Buffer}>} RESET_WM2 の応答 (成功時 resultCode=0)
   */
  resetWifiModule2(opts = {}) {
    return this.wifi().reset(opts);
  }

  /**
   * SESAME Hub3 / Hub3 LTE の BLE プロビジョニング API (CHHub3Device.kt の Wi-Fi/SSID/子鍵/接続種別と 1:1)。
   *
   * scanWifiSSID / setWifiSSID / setWifiPassword / removeSesame / networkType と、正規化済み Hub3
   * publish ({kind, ...}) を購読する onPublish を持つ Hub3Commands を返す (実体は src/ble/hub3.js、
   * 契約は session.request / session.onPublish に乗る)。
   *
   * capabilitiesForModel(model).hubProvisioning が true の機種 (= Hub3/Hub3 LTE) でのみ露出する。
   * それ以外 (ロック/Bot/Bike/biometric/WM2/未知) で参照すると非対応として明示エラーを投げる (op を捏造しない)。
   *
   * 注: Hub3 は SESAME 既定 GATT で接続する (WM2 のような専用 GATT は不要)。connect() 前でも参照できる
   * (session.request は connect 後に login 済みを要求する)。Hub3 は BLE 施錠制御 op (lock/unlock 等) を
   * 持たない (ble[] は空) が、connect/login/register/reset/updateFirmware は OS3 共通経路で動く。
   *
   * @returns {Hub3Commands}
   */
  hub3() {
    if (!this._caps.hubProvisioning) {
      throw badRequest("ble.hub3NotSupported", {
        label: this._caps.label,
        modelSuffix: this._model ? ` (${this._model})` : "",
      });
    }
    if (!this._hub3) {
      this._hub3 = new Hub3Commands({ session: this._session });
    }
    return this._hub3;
  }

  /**
   * BLE 経由ファームウェア更新 (DFU/OTA) を開始する。model で経路が分岐する (SDK と 1:1):
   *   - WM2 (wifiProvisioning)  → OPEN_OTA_SERVER(126) を送る updateFirmwareWM2
   *                               (CHWifiModule2Device.kt:450-458)
   *   - Hub3                    → MOVE_TO(84) を送る updateFirmwareBleOnly
   *                               (CHHub3Device.kt:217-230。MOVE_TO 送出は **Hub3 専用**)
   *   - OS3 lock / Bot2 / Bike2/3 / biometric
   *                             → **命令を一切送らず** デバイスハンドル ({session}) を返す
   *                               dfu.updateFirmware (CHSesameOS3.kt:441-449 の共通 no-op 経路。
   *                               実際の DFU バイナリ転送は Nordic DFU 相当が別 GATT で行う前提で、
   *                               本 kit は未実装 — ハンドル返しまで)。
   *
   * 進捗 (Hub3/WM2) は publish の payload 先頭バイト (onProgress(progress, body))。応答が来た時点
   * (OTA サーバ起動完了) で内部購読は停止する。100% 完了まで進捗を取り続けたい場合は
   * ble.onMoveToOtaProgress / ble.onWM2OtaProgress を直接購読する。
   *
   * OTA 経路を持たない機種 (OS2 系・未知) は明示エラーを投げる (op を捏造しない)。
   *
   * @param {{onProgress?:(progress:number|null, body:Buffer)=>void, timeoutMs?:number}} [opts]
   * @returns {Promise<{resultCode:number, payload:Buffer, session:object}>
   *           |{session:import("./session.js").SesameBleSession}}
   *   Hub3/WM2 はコマンド応答 + session の Promise。OS3 lock 系は同期で {session} (命令無送信)。
   */
  updateFirmware(opts = {}) {
    // 経路は kind で判定する (mechSetting を autolock 能力で弾くのと同じ流儀)。
    // 旧実装は LOCK5 も MOVE_TO(84) へ流していたが、MOVE_TO はモーター駆動命令の番号域で
    // SDK は SS5 系に送らない (CHSesameOS3.kt:441-449 は no-op でハンドル返し)。P1-7 で修正。
    const kind = this._caps.kind;
    if (this._caps.wifiProvisioning || kind === KIND.WIFI) {
      return updateFirmwareWM2(this._session, opts);
    }
    if (kind === KIND.HUB3) {
      return updateFirmwareBleOnly(this._session, opts);
    }
    if (kind === KIND.LOCK5 || kind === KIND.BIOMETRIC || kind === KIND.BIKE2 || kind === KIND.BIKE3 || kind === KIND.BOT2) {
      // CHSesameOS3.kt:441-449: コマンド無送信・カウンタ消費無し。接続ハンドルを返すのみ。
      return dfuUpdateFirmware(this._session);
    }
    throw badRequest("ble.dfuNotSupported", {
      label: this._caps.label,
      modelSuffix: this._model ? ` (${this._model})` : "",
    });
  }

  /**
   * BLE で送れない操作を弾く。SDK では型ごとに能力が非対称 (Bot は click のみ等)。
   * @param {string} op
   */
  _assertOp(op) {
    if (!this._caps.ble.includes(op)) {
      const ok = this._caps.ble.length ? this._caps.ble.join("/") : t("ble.noBleLockOps");
      throw badRequest("ble.opNotSupported", {
        label: this._caps.label,
        modelSuffix: this._model ? ` (${this._model})` : "",
        op,
        ok,
      });
    }
  }

  /**
   * Sesame5/6 系 OS3 ロック (LOCK5 kind) 固有の BLE コマンドを弾く。
   * SDK では magnet(17)/OPS_CONTROL(92)/SET_ADV_PRODUCT_TYPE(205)/mechSetting(80) の itemCode は
   * CHSesame5 インターフェース (open/devices/CHSesame5.kt:16/19/21) にのみ宣言され、実装も
   * ble/os3/CHSesame5Device.kt のみ。OS2 ロック (CHSesame2Device) や Bot/Bike/biometric/Hub3/WM2 は
   * 持たない。autolock 能力は OS2 SESAME2/4 も持つため _assertOp("autolock") では弾けない
   * (over-exposure)。setBleTxPower と同様に os===3 && kind===LOCK5 で明示判定する。
   * @param {string} api エラー文に出すメソッド名
   */
  _assertLock5(api) {
    if (!(this._caps.os === 3 && this._caps.kind === KIND.LOCK5)) {
      throw badRequest("ble.lock5OnlyNotSupported", {
        label: this._caps.label,
        modelSuffix: this._model ? ` (${this._model})` : "",
        api,
      });
    }
  }

  /**
   * mechStatus publish を購読 (戻り値 unsubscribe)。
   * @param {(status: unknown) => void} fn
   * @returns {() => void}
   */
  onStatus(fn) { return this._session.onStatus(fn); }
  /** 最後に受信した mechStatus。 */
  get lastStatus() { return this._session.lastStatus; }
  /** 最後に受信した mechSetting (角度キャリブレーション lockPosition/unlockPosition/autoLockSecond)。未受信なら null。 */
  get lastMechSetting() { return this._session.lastMechSetting; }
  /** 最後に受信した opsSetting (opsLockSecond)。未受信なら null。 */
  get lastOpsSetting() { return this._session.lastOpsSetting; }
  get isConnected() { return this._session.isLoggedIn; }

  /**
   * 接続 + login。
   *
   * needAuthFromServer=true (かつ registerTransport 指定) のとき、initial token を
   * signGuestKey に渡してサーバ署名済み session token を取得する経路で login する
   * (CHHub3Device.kt:163-174 token!=null / CHSesameOS3.kt:473-487)。登録済みだが
   * ゲスト鍵・期限付き鍵などで secretKey 単体では session を確立できないデバイス向け。
   * needAuthFromServer=false の通常デバイスは secretKey からローカルに session 鍵を導出する。
   */
  async connect() {
    // login が失敗 (login timeout / signLogin throw / 非0 resultCode) すると、その時点で
    // transport.connect() は既に実 GATT 接続を確立済み (transport.js:189)。失敗パスで
    // disconnect しないと BLE 接続 + notify 購読がリークするため、必ずクリーンアップしてから
    // rethrow する (connectMany / use の失敗パスと対称)。disconnect 自体のエラーは握り潰す
    // (本来の login エラーを覆い隠さないため)。
    try {
      if (this._needAuthFromServer) {
        if (typeof this._registerTransport !== "function") throw badRequest("ble.needAuthRequiresTransport");
        if (!this._deviceUUID) throw badRequest("ble.registerDeviceUUIDRequired");
        // narrow した値をクロージャ捕捉前に局所束縛する (型ガードはクロージャ内へ伝播しないため)。
        const registerTransport = this._registerTransport;
        const deviceUUID = this._deviceUUID;
        // 非 registerMode (= needAuthFromServer もこちら) は constructor が secretKey 必須を保証するので
        // ここでは string 確定。型上の string|undefined を invariant に従って string へ絞る。
        const secretKeyHex = /** @type {string} */ (
          Buffer.isBuffer(this._secretKey) ? this._secretKey.toString("hex") : this._secretKey
        );
        // signLogin: 4B token の hex を受け取り、サーバ署名済み session token (hex) を返す。
        await this._session.connect({
          signLogin: (/** @type {string} */ tokenHex) => signGuestKey(registerTransport, {
            deviceUUID, tokenHex, secretKey: secretKeyHex,
          }),
        });
      } else {
        await this._session.connect();
      }
    } catch (err) {
      await this._session.disconnect().catch(() => {});
      throw err;
    }
    return this;
  }
  /** 切断。 */
  async close() { await this._session.disconnect(); }

  /**
   * 工場出荷 (未登録) デバイスの初期ペアリング / 登録 (ECDH + サーバ認証)。
   * `registerMode: true` で構築した SesameBle で呼ぶ (secretKey 無し)。
   *
   * フロー (CHHub3Device.kt:176-211): connect(register モード) → session.register() で
   * REGISTRATION ハンドシェイク → 確定した {deviceUUID, secretKey, productType, serverSecret} を返す。
   * 戻り値の secretKey を保存すれば、以降は通常の SesameBle({ secretKey }).connect() で操作できる。
   *
   * @param {{deviceUUID?:string, productType?:(string|number), nowMs?:number}} [opts]
   *   deviceUUID 省略時はコンストラクタの deviceUUID を使用。
   * @returns {Promise<{deviceUUID:string, secretKey:string, productType:(string|number|undefined), serverSecret:string}>}
   */
  async register({ deviceUUID, productType, nowMs } = {}) {
    // ファサード文脈のガード: secretKey 付き (= 非 registerMode) で構築した SesameBle で
    // register() を呼ぶのは誤用。session 層へ素通しすると低レベルの registerNeedsFactory
    // (「session を鍵無しで構築せよ」) が表面化し、ファサード利用者に session を直せと誤誘導する。
    // ここで registerMode: true を渡せ / secretKey 無しで構築せよ、というファサード文脈の案内を出す
    // (session.register の _secretKey ガードに到達する前に弾く)。
    if (!this._registerMode && this._secretKey) throw badRequest("ble.registerNeedsFactoryFacade");
    return this._session.register({
      // session.register() は実行時に !deviceUUID を自前で reject する (session.js:213) ため undefined 流入は
      // 正規の制御フロー。session.register の opts.deviceUUID 契約が string 必須なのは過剰に厳しく、本来は
      // string|undefined であるべき (cross-file blocker: session.js は別エージェント所有)。invariant に従い絞る。
      deviceUUID: /** @type {string} */ (deviceUUID || this._deviceUUID),
      productType: productType ?? this._model ?? undefined,
      registerTransport: typeof this._registerTransport === "function" ? this._registerTransport : undefined,
      nowMs,
    });
  }

  /**
   * 施錠 (BLE item=82)。tag は履歴に残す任意ラベル。
   * @param {Buffer} [tag] 履歴タグ (UUID バイト列)
   * @returns {Promise<{resultCode:number, payload:Buffer}>}
   */
  lock(tag) { this._assertOp("lock"); return this._session.request(ITEM.LOCK, historyTagBLE(tag)); }

  /**
   * 解錠 (BLE item=83)。Sesame5/6 ロックと Bike2 が対応。
   * @param {Buffer} [tag] 履歴タグ (UUID バイト列)
   */
  unlock(tag) { this._assertOp("unlock"); return this._session.request(ITEM.UNLOCK, historyTagBLE(tag)); }

  /**
   * SESAME Bot のクリック (BLE item=89)。Bot2/Bot3 のみ。
   * @param {Buffer} [tag] 履歴タグ (UUID バイト列)
   */
  click(tag) { this._assertOp("click"); return this._session.request(ITEM.CLICK, historyTagBLE(tag)); }

  /**
   * トグル (Sesame5/6 ロックのみ)。直近の mechStatus が無ければ status() を取得してから判定。
   * locked → unlock、それ以外 → lock (CHSesame5Device.kt:128-145 準拠)。
   * @param {Buffer} [tag] 履歴タグ (UUID バイト列)
   */
  async toggle(tag) {
    this._assertOp("toggle");
    /** @type {unknown} */
    let s = this.lastStatus;
    if (!s) s = await this.status().catch(() => null);
    if (s && typeof s === "object" && "state" in s && s.state === MECH_STATE.LOCKED) {
      return this._session.request(ITEM.UNLOCK, historyTagBLE(tag));
    }
    return this._session.request(ITEM.LOCK, historyTagBLE(tag));
  }

  /**
   * オートロック設定 (BLE item=11、2byte LE 秒数。0=無効)。Sesame5/6 ロックのみ。
   * **BLE 経由なら実機に反映される** (クラウドの biz3TriggerLocker では ack のみで未反映だった機能)。
   * 成功後に lastMechSetting キャッシュの autoLockSecond も更新される (SDK と同じ局所更新)。
   * @param {number} seconds 0..65535
   * @param {{timeoutMs?:number}} [opts]
   */
  autolock(seconds, opts) { this._assertOp("autolock"); return this._session.autolock(seconds, opts); }

  /**
   * 現在の mechStatus を返す。未受信なら publish を待つ (timeout 付き)。
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<unknown>} parseMechStatus の結果
   */
  status({ timeoutMs = STATUS_WAIT_MS } = {}) {
    if (this._session.lastStatus) return Promise.resolve(this._session.lastStatus);
    return new Promise((resolve, reject) => {
      // P5-5: 応答待ちタイムアウトは SesameError(TIMEOUT, retryable=true) (serve 経由で kind=timeout)。
      const to = setTimeout(() => { off(); reject(timeoutError(t("ble.mechStatusTimeout"))); }, timeoutMs);
      const off = this._session.onStatus((/** @type {unknown} */ s) => { clearTimeout(to); off(); resolve(s); });
    });
  }

  /**
   * mechSetting (角度キャリブレーション) を書き込む (BLE item=80)。Sesame5/6 系ロックのみ。
   * **BLE 経由のみ**で本体に反映される (クラウド経路には存在しない設定)。
   * lockTarget/unlockTarget は施錠/解錠位置のエンコーダ角 (符号付き 16bit)。
   * 成功時は lastMechSetting キャッシュの lock/unlock 位置も更新される (SDK と同じ局所更新)。
   * @param {number} lockTarget   施錠目標角 (-32768..32767)
   * @param {number} unlockTarget 解錠目標角 (-32768..32767)
   * @returns {Promise<{resultCode:number, payload:Buffer}>}
   */
  configureLockPosition(lockTarget, unlockTarget) {
    // mechSetting (item=80) は CHSesame5 固有 (CHSesame5.kt)。OS2 SESAME2/4 も autolock を持つため
    // _assertOp("autolock") では OS2 ロックを通してしまう。os===3 && kind===LOCK5 で厳密に弾く。
    this._assertLock5("configureLockPosition");
    return this._session.configureLockPosition(lockTarget, unlockTarget);
  }

  /**
   * magnet コマンドを送る (BLE item=17、CHSesame5Device.kt:118-126 magnet() と 1:1)。
   * 引数なし・空ペイロード。magnet() は CHSesame5 固有 (CHSesame5.kt:16) のため
   * os===3 && kind===LOCK5 で厳密に弾く (OS2 SESAME2/4 も autolock を持つので op では弾けない)。
   * @returns {Promise<{resultCode:number, payload:Buffer}>}
   */
  magnet() {
    this._assertLock5("magnet");
    return this._session.magnet();
  }

  /**
   * opSensorControl(seconds) — Open Sensor の自動施錠秒数を設定する (BLE item=92、
   * CHSesame5Device.kt:107-116 と 1:1)。OPS_CONTROL は CHSesame5 固有 (CHSesame5.kt:19) のため
   * os===3 && kind===LOCK5 で厳密に弾く (OS2 SESAME2/4 も autolock を持つので op では弾けない)。
   * 成功時は lastOpsSetting キャッシュの opsLockSecond も更新される (SDK と同じ局所更新)。
   * @param {number} seconds 0..65535 (0 = 無効)
   * @returns {Promise<{resultCode:number, payload:Buffer}>}
   */
  opSensorControl(seconds) {
    this._assertLock5("opSensorControl");
    return this._session.opSensorControl(seconds);
  }

  /**
   * sendAdvProductType(data) — LOCK5 のアドバタイズ productType を書き換える (BLE item=205、
   * CHSesame5Device.kt:85-94 と 1:1)。data は機種固有の生バイト列をそのまま送る。
   * SET_ADV_PRODUCT_TYPE は CHSesame5 固有 (CHSesame5.kt:21) のため os===3 && kind===LOCK5 で
   * 厳密に弾く (OS2 SESAME2/4 も autolock を持つので op では弾けない)。
   * @param {Buffer} data 送信する生バイト列
   * @returns {Promise<{resultCode:number, payload:Buffer}>}
   */
  sendAdvProductType(data) {
    this._assertLock5("sendAdvProductType");
    return this._session.sendAdvProductType(data);
  }

  /**
   * setBleTxPower(txPower) — BLE 送信出力を設定する (BLE item=206)。
   * SDK では OS3 ロック (CHSesameOS3LockBase.kt:62-71) と生体・アクセス制御デバイス
   * (CHSesameBiometricDeviceImpl.kt:332-341) の双方が実装する。よって OS3 の
   * LOCK5 または biometric kind のみで露出し、それ以外 (OS2 系・Bot/Bike・Hub3・WM2・未知) は
   * 明示エラーを投げる (op を捏造しない)。txPower は符号付き 1B (-128..127)。
   * @param {number} txPower -128..127
   * @returns {Promise<{resultCode:number, payload:Buffer}>}
   */
  setBleTxPower(txPower) {
    if (!(this._caps.os === 3 && (this._caps.kind === KIND.LOCK5 || this._caps.biometric))) {
      throw badRequest("ble.txPowerNotSupported", {
        label: this._caps.label,
        modelSuffix: this._model ? ` (${this._model})` : "",
      });
    }
    return this._session.setBleTxPower(txPower);
  }

  /**
   * reset() — OS3 デバイスを工場出荷状態へ戻す (BLE item=104、CHSesameOS3.kt:420-439 と 1:1)。
   * SDK の reset() は CHSesameOS3 の open fun で、全 OS3 デバイス (LOCK5/Bot2/Bike2/Bike3/
   * biometric/Hub3) が継承する。OS2 系 (CHSesame2/Bot/Bike) は別の reset 系統なので弾く。
   *
   * **WM2 (wifiProvisioning) は RESET_WM2(18) 経路へ自動ルーティングする**: CHWifiModule2Device は
   * reset() を override して WM2ActionCode.RESET_WM2(18) を空ペイロードで送り、成功時に dropKey
   * (CHWifiModule2Device.kt:437-448)。WM2 の action code 空間で 104 は未定義のため、汎用
   * Reset(104) を送る旧挙動は SDK と乖離していた (追加バックログ 1)。実装は WifiModule2.reset()
   * (wm2.js — 成功時 session.disconnect = dropKey 相当) に委譲する。
   *
   * 成功時はセッションが破棄される (session.reset / WifiModule2.reset 内で disconnect 相当、
   * dropKey に対応)。鍵レコードの削除そのものは呼び出し側の責務。
   * @returns {Promise<{resultCode:number, payload:Buffer}>}
   */
  reset() {
    if (this._caps.os !== 3) {
      throw badRequest("ble.resetNotSupported", {
        label: this._caps.label,
        modelSuffix: this._model ? ` (${this._model})` : "",
      });
    }
    // WM2 は RESET_WM2(18) override (CHWifiModule2Device.kt:437-448) と 1:1 にルーティング。
    if (this._caps.wifiProvisioning) {
      return this.resetWifiModule2();
    }
    return this._session.reset();
  }

  /**
   * versionTag (ファームウェアバージョン文字列) を取得する (BLE item=5)。
   * @returns {Promise<string>}
   */
  getVersionTag() { return this._session.getVersionTag(); }

  /**
   * 履歴を 1 件取得 (BLE item=4)。payload の解析は呼び出し側 (生バイト返し)。
   * 先頭 4B が recordId で、deleteHistory に渡せばその 1 件をデバイスから削除できる。
   * @returns {Promise<Buffer>}
   */
  history() { return this._session.readHistory(); }

  /**
   * 履歴 1 件をデバイスから削除する (BLE item=18)。
   * @param {Buffer} historyPayload history() が返した payload (先頭 4B が recordId)
   * @returns {Promise<{resultCode:number, payload:Buffer}>}
   */
  deleteHistory(historyPayload) { return this._session.deleteHistory(historyPayload); }

  /**
   * connect → fn → close を自動で行うヘルパー。
   * @param {object} opts コンストラクタ opts
   * @param {(lock:SesameBle)=>Promise<any>} fn
   */
  static async use(opts, fn) {
    const lock = new SesameBle(opts);
    await lock.connect();
    try { return await fn(lock); }
    finally { await lock.close(); }
  }

  /**
   * 工場出荷 (未登録) デバイスを scan → connect → register → close まで自動化する。
   * register モードで SesameBle を構築し、登録ハンドシェイクを実行して確定した鍵を返す。
   *
   * @param {{deviceUUID?:string, address?:string, productType?:(string|number),
   *          registerTransport?:RegisterTransport, debug?:boolean, scanTimeoutMs?:number,
   *          transport?:import("./session.js").BleTransport, nowMs?:number}} [opts]
   *   deviceUUID/address はスキャン照合用。registerTransport を渡すと register() 内で
   *   サーバ側 registerSesame5 もコールする (失敗してもログのみで継続)。
   * @param {(result:RegisterResult)=>Promise<unknown>} [fn]
   *   登録結果を受け取る任意のコールバック (鍵の保存など)。close 前に実行される。
   * @returns {Promise<RegisterResult>}
   *   登録結果 (fn 指定時もこの結果を返す)。
   */
  static async registerOnce(opts = {}, fn) {
    const { productType, nowMs, ...ctorOpts } = opts;
    const ble = new SesameBle({ ...ctorOpts, registerMode: true });
    // register() は内部で transport.connect() 済み (session.js:192) なので、その後の例外
    // (registerTimeout / registerNotReady / device pubkey 長エラー / ECDH 失敗) でも実 GATT
    // 接続が開いたまま残る。ble 構築直後から try/finally で囲み、register の reject 時も含めて
    // 必ず close() する (connect() の失敗パスと対称・取りこぼし防止)。
    try {
      // session.register() が transport.connect → initial 待ち → ハンドシェイクまで一括で行う。
      const result = await ble.register({ productType, nowMs });
      if (typeof fn === "function") await fn(result);
      return result;
    } finally {
      await ble.close().catch(() => {});
    }
  }

  /**
   * 複数ロックに**1 回のスキャン**で同時接続する (逐次スキャンを避ける正攻法)。
   * 近接していないロックは結果に現れず即スキップ (per-device の scan timeout を払わない)。
   * 見つかったロックへは**並行接続** (login まで)。
   *
   * @param {Array<{name:string, deviceUUID:string, secretKey:string, model?:string}>} entries
   * @param {{debug?:boolean, scanTimeoutMs?:number}} [opts]
   * @returns {Promise<{connected: Map<string, SesameBle>, unreachable: string[], failed: Array<{name:string, error:Error}>}>}
   */
  static async connectMany(entries, { debug = false, scanTimeoutMs = 8_000 } = {}) {
    const found = await scanSesames({ deviceUUIDs: entries.map((e) => e.deviceUUID), timeoutMs: scanTimeoutMs, debug });
    const byNorm = new Map([...found.entries()].map(([uuid, p]) => [normId(uuid), p]));

    /** @type {Map<string, SesameBle>} */
    const connected = new Map();
    /** @type {string[]} */
    const unreachable = [];
    /** @type {Array<{name:string, error:Error}>} */
    const failed = [];

    const inRange = entries.filter((e) => byNorm.has(normId(e.deviceUUID)));
    for (const e of entries) if (!byNorm.has(normId(e.deviceUUID))) unreachable.push(e.name);

    // 見つかったものは並行で connect+login (別 peripheral なので同時接続可)。
    await Promise.all(inRange.map(async (e) => {
      const peripheral = byNorm.get(normId(e.deviceUUID));
      const ble = new SesameBle({ secretKey: e.secretKey, deviceUUID: e.deviceUUID, model: e.model, debug, transport: new NobleTransport({ peripheral, debug }) });
      // connect() は失敗時 Error を rethrow する (catch 変数の unknown を契約上の Error に絞る純キャスト)。
      try { await ble.connect(); connected.set(e.name, ble); }
      catch (error) { failed.push({ name: e.name, error: /** @type {Error} */ (error) }); await ble.close().catch(() => {}); }
    }));

    return { connected, unreachable, failed };
  }

  /**
   * 近接 SESAME を**鍵無しで**列挙する (transport.listNearbyDevices の薄いファサード)。
   * scanSesames が deviceUUID→peripheral の Map しか返さないのに対し、こちらは advertise だけから
   * 判る属性 ({deviceUUID, productType, model, kind, isRegistered, advTagB1, isConnectable, rssi,
   * localName, address, peripheral}) を機種付きで返す (CHBleManager.kt の chDeviceMap 構築に対応)。
   *
   * 用途: 登録前 (工場出荷) デバイスの発見 (isRegistered=false を拾って registerOnce へ)、
   * 鍵を持たない近接デバイスの可視化、接続前の機種判定など。返り値の peripheral を
   * SesameBle.fromDiscovery() / connectMany / NobleTransport に渡せば**再スキャン無しで**接続できる。
   *
   * @param {{timeoutMs?:number, debug?:boolean, includeUnknown?:boolean}} [opts]
   * @returns {Promise<Array<object>>} listNearbyDevices の発見結果配列
   */
  static listNearby(opts = {}) {
    return listNearbyDevices(opts);
  }

  /**
   * listNearbyDevices() / listNearby() の発見結果 1 件から、**再スキャン無しで**接続可能な
   * SesameBle を構築する。発見結果の peripheral・deviceUUID・model をそのまま引き継ぎ、
   * secretKey など鍵情報は呼び出し側が補う (発見段階では鍵は未知)。
   *
   * @param {DiscoveryEntry} entry listNearbyDevices() の要素 ({deviceUUID, model, peripheral, ...})
   * @param {{secretKey?:string|Buffer, registerMode?:boolean, needAuthFromServer?:boolean,
   *          registerTransport?:RegisterTransport, debug?:boolean}} [opts]
   *   secretKey 等の鍵/モード指定。registerMode:true なら工場出荷デバイスの register() 用 (鍵不要)。
   * @returns {SesameBle}
   */
  static fromDiscovery(entry, opts = {}) {
    if (!entry || !entry.peripheral) throw badRequest("ble.discoveryEntryRequired");
    const { debug = false, ...rest } = opts;
    return new SesameBle({
      deviceUUID: entry.deviceUUID,
      model: entry.model,
      debug,
      // 発見済み peripheral を注入 = connect() 時にスキャンを省略する (connectMany と同じ高速パス)。
      transport: new NobleTransport({ peripheral: entry.peripheral, debug }),
      ...rest,
    });
  }
}
