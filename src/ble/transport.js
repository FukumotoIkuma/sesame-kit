// BLE 無線トランスポートのアダプタ。
//
// セッション/プロトコル層 (session.js / protocol.js) は OS 非依存。物理 BLE I/O だけを
// このアダプタに閉じ込め、ライブラリ本体はどのアダプタにも**ハード依存しない**。
// 既定アダプタは @abandonware/noble (optionalDependency) を**遅延 require** する。
// 未導入・Bluetooth 権限なしのときは明確なエラーメッセージを出す。
//
// アダプタ契約 (session.js が要求):
//   connect(onPacket: (packet:Buffer)=>void, onDisconnect?: (reason)=>void): Promise<void>
//                                                              接続+notify購読。各 notify を onPacket へ。
//                                                              リンク切断時 (相手側 disconnect / 圏外 /
//                                                              write 連続失敗) は onDisconnect を 1 回呼ぶ。
//   write(bytes: Buffer): Promise<void>                        Write Without Response (順序保証)。
//   disconnect(): Promise<void>
//
// 自前/Web Bluetooth 等の別アダプタも、この 3 メソッドを満たせば session に注入できる
// (onDisconnect は任意。未対応アダプタでも従来どおり動く)。

import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { t } from "../i18n.js";
import { GATT, COMPANY_ID } from "./protocol.js";
import { PRODUCT_TYPES, KIND } from "./devicemodel.js";

// 既定 GATT は SESAME ロック (protocol.js fd81 系)。WM2 のように別サービス UUID で discover/
// subscribe する必要があるデバイスは、createBleTransport/NobleTransport/scanSesames に
// gatt: WM2_GATT を注入する (wm2.js WM2_GATT)。注入が無ければ従来どおり SESAME GATT を使う。
// これで transport は protocol.js の GATT に固定依存せず、{SERVICE,WRITE_CHAR,NOTIFY_CHAR} を
// 満たす任意の GATT で動く (SesameOS3 スタック自体はロックも WM2 も共通)。

// optionalDependency (@abandonware/noble) を ESM から遅延 require するためのブリッジ。
const require = createRequire(import.meta.url);

// ---------- noble の最小型定義 ----------
//
// @abandonware/noble は型定義を持たない (untyped CJS)。本アダプタが実際に触る
// メソッド/プロパティだけを最小 typedef として定義し、any を避ける。実装が露出する
// 全 API ではなく「ここで使うもの」だけを宣言する (過剰宣言しない)。

/**
 * @typedef {object} NobleCharacteristic noble の characteristic (使用メソッドのみ)。
 * @property {string} uuid
 * @property {(event:"data", listener:(data:Buffer)=>void)=>void} on
 * @property {()=>Promise<void>} subscribeAsync
 * @property {()=>Promise<void>} unsubscribeAsync
 * @property {(data:Buffer, withoutResponse:boolean)=>Promise<void>} writeAsync
 */

/**
 * @typedef {object} NobleAdvertisement noble の advertisement (使用フィールドのみ)。
 * @property {Buffer} [manufacturerData] company ID 2B を含む生バイト列。
 * @property {string} [localName]
 */

/**
 * @typedef {object} NoblePeripheral noble の peripheral (使用メソッド/プロパティのみ)。
 * @property {string} [address]
 * @property {string} [id]
 * @property {number} [rssi]
 * @property {number} [mtu]
 * @property {NobleAdvertisement} [advertisement]
 * @property {(event:"disconnect", listener:(reason:any)=>void)=>void} on
 * @property {(event:string, listener:(...args:any[])=>void)=>void} removeListener
 * @property {()=>Promise<void>} connectAsync
 * @property {()=>Promise<void>} disconnectAsync
 * @property {(serviceUUIDs:string[], characteristicUUIDs:string[])=>Promise<{characteristics:NobleCharacteristic[]}>} discoverSomeServicesAndCharacteristicsAsync
 */

/**
 * noble モジュール (@abandonware/noble) の使用メソッド/プロパティのみ。
 * @typedef {object} Noble
 * @property {string} state
 * @property {(event:string, listener:(...args:any[])=>void)=>void} on
 * @property {(event:string, listener:(...args:any[])=>void)=>void} removeListener
 * @property {()=>Promise<void>} stopScanningAsync
 * @property {(serviceUUIDs:string[], allowDuplicates:boolean)=>Promise<void>} startScanningAsync
 */

/**
 * @typedef {Error & {code?:string}} CodedError code 付きエラー (CLI が分岐に使う BLE_* コード)。
 */

/** noble 形式 (小文字・ハイフン無し) に正規化。 @param {string} u @returns {string} */
function nobleUuid(u) {
  return String(u).replace(/-/g, "").toLowerCase();
}

// ---------- advertise パース (Sesame2BleAdvertisement.kt CHadv の移植) ----------
//
// ★オフセット注意: Android の CHadv は advBytes = manufacturerSpecificData.valueAt(0) で
//   **company ID (LE 5A 05) を除いた** バイト列を扱う。一方 noble の
//   peripheral.advertisement.manufacturerData は company ID 2B を**含む**生バイト列。
//   よって Android の advBytes[i] は noble の md[i+2] に対応する (+2 オフセット)。
//   下では advBytes 座標 (SDK と同じ添字) で書き、ADV_OFF=2 を足してから md を読む。

const ADV_OFF = 2; // company ID 2B 分のオフセット (md[i+2] = advBytes[i])

// Write Without Response の有限回リトライ (SDK CHSesameOS3.kt:321-346 transmit の輻輳耐性に相当)。
// SDK は writeCharacteristic が false (内部キュー輻輳) のとき最大 30000 回リトライしてから disconnect
// するが、これは Android の同期 writeCharacteristic が「投函できたか」だけを即時 bool で返す前提の
// 数値 (1 回のループが極めて軽い)。noble の writeAsync は OS にコールバックで完了通知させる非同期 API
// で、失敗は例外として返る (輻輳ではなく実エラー寄り)。よって SDK の 30000 をそのまま移植せず、
// 妥当な少数回の指数バックオフ付きリトライにする (調査仕様: 回数は妥当な範囲でよい)。
// 全リトライ失敗 = リンク断扱いとし、onDisconnect を発火させて pending を fail-fast させる。
const WRITE_MAX_RETRIES = 5;        // 初回 + この回数までリトライ
const WRITE_RETRY_BASE_MS = 20;     // バックオフ初期遅延 (20,40,80,160,320ms)

/**
 * hex 文字列 (32桁) を UUID 文字列に整形する (noHashtoUUID, DataExtention.kt:41-46)。
 * @param {string} hex 32 桁の hex
 * @returns {string} "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" (小文字)
 */
function hexToUuid(hex) {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// CHadv.deviceID の機種別 prefix (Sesame2BleAdvertisement.kt:49-66)。
// WM2 : "00000000055afd810001" + advBytes[3..9](6B hex)
// Hub3: "00000000055afd810d00" + advBytes[2..8](6B hex)
const WM2_UUID_PREFIX = "00000000055afd810001";
const HUB3_UUID_PREFIX = "00000000055afd810d00";

/**
 * SESAME の advertise manufacturerData を機種別レイアウトで解析する
 * (Sesame2BleAdvertisement.kt CHadv の移植)。WM2 / Hub3 / SS5(Touch/Face 等) の
 * 3 レイアウトと productType・registered フラグ・isConnectable を網羅する。
 *
 * レイアウト (advBytes 座標、md では +ADV_OFF):
 *   advBytes[0]            : productType (CHProductModel.getByValue, copyOfRange(0,1))
 *   advBytes[1]            : Hub3 系のみ registered bit (Matter 二合一広播で機型の保留字を圧縮、行40-44)
 *   advBytes[2]            : それ以外の registered bit0 / adv_tag_b1=bit1 (行33,43)
 *   WM2  deviceID          : advBytes[3..9) の 6B → WM2_UUID_PREFIX に連結 (行49-56)
 *   Hub3 deviceID          : advBytes[2..8) の 6B → HUB3_UUID_PREFIX に連結 (行58-66)
 *   SS5  deviceID          : advBytes[3..19) の 16B をそのまま UUID 化 (行76-89)
 *   WM2  isConnectable     : advBytes.last()==0 (行51)
 *
 * @param {Buffer|Uint8Array|null|undefined} md noble の manufacturerData (company ID 2B 含む)
 * @returns {{productType:number, model:(string|null), kind:string, isRegistered:boolean,
 *            advTagB1:boolean, isConnectable:boolean, deviceUUID:(string|null)}|null}
 *   SESAME でない (company 不一致 / 長さ不足) は null。
 */
export function parseAdvertisement(md) {
  if (!md) return null;
  const b = Buffer.isBuffer(md) ? md : Buffer.from(md);
  // company ID は LE で 5A 05 (= 0x055A)。先頭 2B が一致しなければ SESAME でない。
  if (b.length < ADV_OFF + 3) return null;
  if (b[0] !== (COMPANY_ID & 0xff) || b[1] !== ((COMPANY_ID >> 8) & 0xff)) return null;

  // advBytes[i] = b[i + ADV_OFF]。SDK と同じ添字で読めるヘルパ。
  const a = (/** @type {number} */ i) => b[i + ADV_OFF];
  const productType = a(0);
  const entry = /** @type {Record<number, {model:string, kind:string}>} */ (PRODUCT_TYPES)[productType] || null;
  const model = entry ? entry.model : null;
  const kind = entry ? entry.kind : KIND.UNKNOWN;

  // adv_tag_b1 = (advBytes[2] and 2) > 0 (行33)。履歴有無フラグ。
  const advTagB1 = (a(2) & 0b0000_0010) > 0;

  // isRegistered: Hub3/Hub3_LTE は advBytes[1] bit0、それ以外は advBytes[2] bit0 (行39-44)。
  const isHub3 = model === "hub_3" || model === "hub_3_lte";
  const isRegistered = isHub3 ? (a(1) & 1) > 0 : (a(2) & 1) > 0;

  // 機種別 deviceID。長さ不足や未知機種は deviceUUID=null (操作捏造を避ける)。
  let deviceUUID = null;
  let isConnectable = true;
  if (model === "wm_2") {
    // advBytes[3..9) = 6B、md では [5..11)。last() は advBytes 末尾 = b の最終バイト。
    if (b.length >= ADV_OFF + 9) {
      const idHex = b.subarray(ADV_OFF + 3, ADV_OFF + 9).toString("hex");
      deviceUUID = hexToUuid(WM2_UUID_PREFIX + idHex);
    }
    isConnectable = b[b.length - 1] === 0; // advBytes.last()?.toInt() == 0 (行51)
  } else if (isHub3) {
    // advBytes[2..8) = 6B、md では [4..10)。
    if (b.length >= ADV_OFF + 8) {
      const idHex = b.subarray(ADV_OFF + 2, ADV_OFF + 8).toString("hex");
      deviceUUID = hexToUuid(HUB3_UUID_PREFIX + idHex);
    }
  } else {
    // SS5/Touch/Face/Bot2/Bike2/OpenSensor/Remote 等: advBytes[3..18] (16B、inclusive) = md[5..21)。
    if (b.length >= ADV_OFF + 19) {
      const idHex = b.subarray(ADV_OFF + 3, ADV_OFF + 19).toString("hex");
      deviceUUID = hexToUuid(idHex);
    }
  }

  return { productType, model, kind, isRegistered, advTagB1, isConnectable, deviceUUID };
}

/**
 * SESAME の advertise manufacturerData から deviceUUID を抽出する (後方互換の薄いラッパ)。
 * 機種別レイアウトの全分岐は parseAdvertisement に集約し、ここはその deviceUUID だけを返す。
 * これにより SS5 だけでなく WM2/Hub3 でも正しい UUID が得られる (旧実装は SS5 レイアウト固定だった)。
 *
 * @param {Buffer|Uint8Array|null|undefined} md
 * @returns {string|null} "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" (小文字) or null
 */
export function advToDeviceUUID(md) {
  const parsed = parseAdvertisement(md);
  return parsed ? parsed.deviceUUID : null;
}

/**
 * 2 つの deviceUUID/アドレスを正規化比較 (ハイフン/大文字無視)。
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @returns {boolean}
 */
function idEquals(a, b) {
  if (!a || !b) return false;
  return nobleUuid(a) === nobleUuid(b);
}

// noble (CoreBluetooth バインディング) は一度ロードするとネイティブハンドルがイベントループに
// 残り、コマンド完了後も node が自然 exit しない。これを立ててエントリポイントで強制 exit を判断する。
let _nobleLoaded = false;
/** このプロセスで noble をロード済みか (= 通常 exit ではプロセスが終わらない)。 */
export function bleWasUsed() { return _nobleLoaded; }

// ---------- ネイティブ abort (SIGABRT) を JS で握れない問題への対策 ----------
//
// @abandonware/noble の CoreBluetooth バインディングは、Bluetooth 権限 (entitlement) が無い /
// アダプタが無い / サンドボックス環境では、ネイティブ central manager を初期化した瞬間に C++ の
// abort() を呼ぶ。これは JS の例外ではなくプロセスレベルの SIGABRT (終了コード 134) なので
// try/catch では一切握れず、stateChange イベントすら JS へ届かない (waitPoweredOn の unauthorized/
// unsupported ガードは発火できない)。実測 (darwin, 権限なし):
//   - require("@abandonware/noble")            → 安全 (バインディングは遅延初期化)
//   - noble.state を読む / on("stateChange")    → CBCentralManager 初期化 → SIGABRT
// つまり「require は安全だが、state を触った瞬間に落ちる」。本プロセスで state を触る前に、
// 同一バインディングを**子プロセス**で初期化させて生死を観測し、abort を**プロセス境界の外**で
// 起こさせてから親で安全/危険を判定する (親プロセスは決して巻き添えにならない)。
//
// 子の出力契約:
//   stdout "STATE:<s>" + exit 0  : central manager 初期化に成功し state を観測できた (アダプタ有り)。
//                                   親はそのまま in-process で noble を使ってよい (waitPoweredOn が
//                                   poweredOn/poweredOff/unauthorized 等を JS で正しく拾える)。
//   stdout "LOADERR:<msg>" + exit 3: require 自体が失敗 (未導入) → BLE_NO_ADAPTER。
//   それ以外 (SIGABRT / 非0 終了, STATE: 無し)         : ネイティブ abort → アダプタ無し/権限なし。
//                                   既存の BLE_UNAUTHORIZED / BLE_UNSUPPORTED へマップする。

// 子プロセスで実行するプローブ本体。noble を require し state を 1 度だけ観測して報告する。
// require は安全だが state アクセスで abort し得るため、その abort は**この子の中**で起き、
// 親には signal/exit code として伝わる (stdout に STATE: を出す前なら「危険」と判定される)。
// `-e '(function(){...})()'` で実行するため return を使える IIFE 本体として書く。
const BLE_PROBE_SRC = `(function () {
  var noble;
  try { noble = require("@abandonware/noble"); }
  catch (e) { process.stdout.write("LOADERR:" + String((e && e.message) || e).split("\\n")[0]); process.exit(3); }
  var report = function (s) { try { process.stdout.write("STATE:" + String(s)); } catch (_) {} process.exit(0); };
  try {
    // ここで state を触る = CBCentralManager 初期化 = 権限なしなら SIGABRT (この子が落ちる)。
    if (noble.state && noble.state !== "unknown") return report(noble.state);
    var done = false;
    var to = setTimeout(function () { if (!done) { done = true; report(noble.state || "timeout"); } }, 4000);
    noble.on("stateChange", function (s) { if (!done) { done = true; clearTimeout(to); report(s); } });
  } catch (e) {
    // state アクセスが JS 例外として返る稀な実装も BLE_UNSUPPORTED 相当 (STATE: を出さず非0 終了)。
    process.exit(2);
  }
})()`;

/**
 * @typedef {{kind:"ok", state:string} | {kind:"noAdapter", cause:string} | {kind:"aborted"}} ProbeResult
 */

// プローブ結果のキャッシュ (1 プロセス 1 回で十分。子 spawn のコストを毎回払わない)。
/** @type {ProbeResult|null} */
let _probeResult = null;

/**
 * noble のネイティブバインディングを子プロセスで初期化して生死を観測する。
 * abort はプロセス境界の外で起こさせ、親プロセスを巻き添えにしない。
 * @returns {{kind:"ok", state:string} | {kind:"noAdapter", cause:string} | {kind:"aborted"}}
 */
function probeBleAvailability() {
  if (_probeResult) return _probeResult;
  const r = spawnSync(process.execPath, ["-e", BLE_PROBE_SRC], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 8_000,
  });
  const stdout = String(r.stdout || "");
  if (stdout.startsWith("STATE:")) {
    _probeResult = { kind: "ok", state: stdout.slice("STATE:".length) };
  } else if (stdout.startsWith("LOADERR:")) {
    _probeResult = { kind: "noAdapter", cause: stdout.slice("LOADERR:".length) };
  } else {
    // signal (SIGABRT 等) / 非0 終了で STATE: が無い = ネイティブ abort。
    _probeResult = { kind: "aborted" };
  }
  return _probeResult;
}

/**
 * ネイティブ abort を検知したときに投げる、導線付きエラーを組み立てる。
 * macOS は Bluetooth 権限 (entitlement) 不足が最頻なので BLE_UNAUTHORIZED、それ以外
 * (Linux/RPi/headless: アダプタ無し・権限不足) は BLE_UNSUPPORTED にマップする。
 * いずれも waitPoweredOn の既存 i18n 文言を流用し、abort 由来の追加ヒントを添える。
 */
/** @returns {CodedError} */
function bleAbortError() {
  if (process.platform === "darwin") {
    const e = /** @type {CodedError} */ (new Error(`${t("ble.bluetoothUnauthorized")} ${t("ble.nativeAbortHint")}`));
    e.code = "BLE_UNAUTHORIZED"; // CLI 側で設定ペインを開く判定に使う (waitPoweredOn と同じ)
    return e;
  }
  const e = /** @type {CodedError} */ (new Error(`${t("ble.bluetoothUnsupported")} ${t("ble.nativeAbortHint")}`));
  e.code = "BLE_UNSUPPORTED";
  return e;
}

/**
 * noble を遅延ロードする。未導入・ロード失敗時は導線付きエラー。
 *
 * ★ require() の前に必ず子プロセスプローブを通す。noble の state を本プロセスで触ると
 * 権限/アダプタ無し環境では SIGABRT (exit 134, JS で握れない) で**無言クラッシュ**するため、
 * 危険判定は子プロセスに肩代わりさせ、本プロセスは安全と分かってからのみ noble を初期化する。
 * @returns {Noble} noble モジュール
 */
function loadNoble() {
  const probe = probeBleAvailability();
  if (probe.kind === "noAdapter") {
    const err = /** @type {CodedError} */ (new Error(t("ble.noAdapter", { cause: probe.cause })));
    err.code = "BLE_NO_ADAPTER";
    throw err;
  }
  if (probe.kind === "aborted") {
    // 本プロセスで state を触れば同じ SIGABRT で無言クラッシュする。触る前に導線付きで止める。
    throw bleAbortError();
  }
  // probe.kind === "ok": 子プロセスで central manager 初期化に成功している → 本プロセスでも安全。
  try {
    // @abandonware/noble は optionalDependency。未導入なら下で握る (通常はプローブが先に検知する)。
    // noble は untyped CJS。最小 typedef (Noble) として扱う。
    const noble = /** @type {Noble} */ (require("@abandonware/noble"));
    _nobleLoaded = true;
    return noble;
  } catch (e) {
    // MODULE_NOT_FOUND の message は require stack を含むので 1 行目だけ拾う。
    const cause = String(/** @type {{message?:string}} */ (e)?.message || e).split("\n")[0];
    const err = /** @type {CodedError} */ (new Error(t("ble.noAdapter", { cause })));
    err.code = "BLE_NO_ADAPTER";
    throw err;
  }
}

/**
 * Bluetooth が poweredOn になるまで待つ (権限/未対応は導線付きエラー)。
 * @param {Noble} noble
 * @param {(...a:any[])=>void} [log]
 * @returns {Promise<void>}
 */
function waitPoweredOn(noble, log = () => {}) {
  return new Promise((resolve, reject) => {
    if (noble.state === "poweredOn") return resolve();
    const to = setTimeout(() => { noble.removeListener("stateChange", onState); reject(new Error(t("ble.bluetoothInitTimeout"))); }, 10_000);
    /** @param {string} state */
    const onState = (state) => {
      log("noble state", state);
      if (state === "poweredOn") { clearTimeout(to); noble.removeListener("stateChange", onState); resolve(); }
      else if (state === "unauthorized") {
        clearTimeout(to); noble.removeListener("stateChange", onState);
        const e = /** @type {CodedError} */ (new Error(t("ble.bluetoothUnauthorized")));
        e.code = "BLE_UNAUTHORIZED"; // CLI 側で設定ペインを開く判定に使う
        reject(e);
      }
      else if (state === "poweredOff") {
        clearTimeout(to); noble.removeListener("stateChange", onState);
        const e = /** @type {CodedError} */ (new Error(t("ble.bluetoothPoweredOff")));
        e.code = "BLE_POWERED_OFF";
        reject(e);
      }
      else if (state === "unsupported") {
        clearTimeout(to); noble.removeListener("stateChange", onState);
        const e = /** @type {CodedError} */ (new Error(t("ble.bluetoothUnsupported")));
        e.code = "BLE_UNSUPPORTED";
        reject(e);
      }
    };
    noble.on("stateChange", onState);
  });
}

/**
 * **1 回のスキャン**で近接 SESAME を集める (マルチ接続用)。逐次スキャンを避けるための要。
 * deviceUUIDs を指定すると、それらが**全て見つかった時点で即終了**、または timeout で打ち切り。
 * 空指定なら timeout まで全 SESAME を収集。圏外のデバイスは結果に含まれない (= 即スキップ可)。
 *
 * @param {{deviceUUIDs?:string[], timeoutMs?:number, debug?:boolean, gatt?:{SERVICE:string}}} opts
 *   gatt: スキャンフィルタに使う service UUID (省略時 SESAME GATT fd81)。WM2 は WM2_GATT を渡す。
 *     advertise の company ID (0x055A) は全 SESAME 共通なので parse は機種別に分岐する (gatt 非依存)。
 * @returns {Promise<Map<string, NoblePeripheral>>} key = deviceUUID(小文字ダッシュ付き) → noble peripheral
 */
export async function scanSesames({ deviceUUIDs = [], timeoutMs = 8_000, debug = false, gatt = GATT } = {}) {
  const noble = loadNoble();
  const log = debug ? (/** @type {any[]} */ ...a) => console.error("[ble:scan]", ...a) : () => {};
  await waitPoweredOn(noble, log);
  const want = new Set(deviceUUIDs.map(nobleUuid));
  /** @type {Map<string, NoblePeripheral>} */
  const found = new Map(); // deviceUUID(dashed lower) -> peripheral

  return new Promise((resolve) => {
    let done = false;
    const finish = async () => {
      if (done) return; done = true;
      clearTimeout(to);
      noble.removeListener("discover", onDiscover);
      await noble.stopScanningAsync().catch(() => {});
      resolve(found);
    };
    const to = setTimeout(finish, timeoutMs);
    /** @param {NoblePeripheral} p */
    const onDiscover = (p) => {
      const uuid = advToDeviceUUID(p.advertisement?.manufacturerData);
      if (!uuid) return; // SESAME でない
      if (want.size && !want.has(nobleUuid(uuid))) return; // 対象外
      if (!found.has(uuid)) { found.set(uuid, p); log("found", uuid); }
      // 目的の全 UUID が揃ったら早期終了
      if (want.size && want.size <= found.size && [...want].every((w) => [...found.keys()].some((k) => nobleUuid(k) === w))) {
        finish();
      }
    };
    noble.on("discover", onDiscover);
    noble.startScanningAsync([nobleUuid(gatt.SERVICE)], false).catch((/** @type {any} */ e) => {
      log("scan start failed", e?.message);
      finish();
    });
  });
}

/**
 * noble peripheral 1 件を「型付き発見結果」に変換する純関数 (listNearbyDevices の中核を
 * noble 非依存に切り出したもの)。SDK CHBleManager.kt:134-140 の `CHadv(scanResult)` →
 * productModel/deviceID/rssi 抽出と 1:1。advertise が SESAME でない / deviceUUID=null /
 * (includeUnknown=false で) 未知機種 のときは null を返す (列挙対象外)。
 *
 * @param {{advertisement?:{manufacturerData?:any, localName?:string}, rssi?:number, address?:string}} p
 *   noble peripheral 互換オブジェクト (テストでは plain object を渡せる)。
 * @param {{includeUnknown?:boolean}} [opts]
 * @returns {{deviceUUID:string, productType:number, model:(string|null), kind:string,
 *           isRegistered:boolean, advTagB1:boolean, isConnectable:boolean, rssi:(number|null),
 *           localName:(string|null), address:(string|null), peripheral:any}|null}
 */
export function peripheralToDiscovery(p, { includeUnknown = false } = {}) {
  const parsed = parseAdvertisement(p?.advertisement?.manufacturerData);
  if (!parsed) return null;            // SESAME でない (company 不一致 / 長さ不足)
  if (!parsed.deviceUUID) return null; // deviceID=null は列挙しない (操作を捏造しない)
  // SDK の onScanResult は productModel?.let で未知機種を無視する。既定はそれに倣い model=null を除外。
  if (!includeUnknown && parsed.model === null) return null;
  return {
    deviceUUID: parsed.deviceUUID,
    productType: parsed.productType,
    model: parsed.model,
    kind: parsed.kind,
    isRegistered: parsed.isRegistered,
    advTagB1: parsed.advTagB1,
    isConnectable: parsed.isConnectable,
    rssi: typeof p?.rssi === "number" ? p.rssi : null,  // CHadv.rssi = scanResult.rssi
    localName: p?.advertisement?.localName || null,     // CHadv.deviceName 相当 (出ない広播もある)
    address: p?.address || null,
    peripheral: p,                                      // 再スキャン無しで NobleTransport へ渡せる
  };
}

/**
 * **1 回のスキャン**で近接 SESAME を「型付き発見結果」として列挙する高レベル API
 * (CHBleManager.kt bleScanner.onScanResult → chDeviceMap 構築の移植)。
 *
 * scanSesames は deviceUUID→peripheral の Map しか返さないため、呼び出し側は鍵が無いと
 * 機種 (productModel)・登録状態 (isRegistered) を知る術が無かった。本 API は SDK が
 * onScanResult で `CHadv(scanResult)` を組み立てて `chDeviceMap.getOrPut(deviceID){...}` に
 * 蓄える流れと 1:1 で、advertise だけから判る属性 (機種/登録/接続可否/rssi) を**鍵無しで**返す。
 *
 * SDK 忠実点 (CHBleManager.kt:129-146):
 *   - onScanResult は `CHadv(scanResult).productModel?.let { ... }` で **productModel が判る
 *     ものだけ**を chDeviceMap に入れる (未知機種は無視)。本 API も model===null (PRODUCT_TYPES
 *     に無い productType) を結果から除外し、操作を捏造しない (UNKNOWN を化けさせない)。
 *   - chDeviceMap は `getOrPut(deviceID.toString())` で deviceID をキーに**重複排除**する。
 *     本 API も deviceUUID で dedup し、後勝ちで rssi/localName を更新する (再受信の最新値)。
 *   - rssi は scanResult.rssi (CHadv.rssi)。noble では peripheral.rssi に入る。
 *   - isRegistered / isConnectable / productType / model / advTagB1 は parseAdvertisement
 *     (= Sesame2BleAdvertisement.kt CHadv の移植) の結果をそのまま使う (機種別バイト座標は集約済み)。
 *
 * 返り値の peripheral を NobleTransport({peripheral}) / connectMany に渡せば**再スキャン無しで**
 * 接続できる (scanSesames の peripheral と同じ noble オブジェクト)。
 *
 * 実機 (noble) 未検証: スキャン挙動・rssi/localName の取得は noble の peripheral 形状に依存する
 * (CoreBluetooth では localName が出ない広播もある)。単体テストは parseAdvertisement と
 * onDiscover の集約ロジックに対して行い、noble 実体は使わない。
 *
 * @param {{timeoutMs?:number, debug?:boolean, includeUnknown?:boolean, gatt?:{SERVICE:string}}} opts
 *   timeoutMs       : スキャン打ち切り (既定 8s)。scanSesames と異なり対象 UUID を絞らず全 SESAME を収集する。
 *   includeUnknown  : true で PRODUCT_TYPES に無い機種 (model=null/kind=unknown) も含める
 *                     (既定 false = SDK の productModel?.let フィルタに合わせて除外)。
 *   gatt            : スキャンフィルタの service UUID (省略時 SESAME GATT fd81)。company ID(0x055A) は
 *                     全 SESAME 共通なので parse は機種非依存 (scanSesames と同じ注意書き)。
 * @returns {Promise<Array<{deviceUUID:string, productType:number, model:(string|null), kind:string,
 *           isRegistered:boolean, advTagB1:boolean, isConnectable:boolean, rssi:(number|null),
 *           localName:(string|null), address:(string|null), peripheral:any}>>}
 *   発見順 (最初に見つかった順)。deviceUUID が取れない (SDK で deviceID=null になる長さ不足/未知) ものは含まない。
 */
export async function listNearbyDevices({ timeoutMs = 8_000, debug = false, includeUnknown = false, gatt = GATT } = {}) {
  const noble = loadNoble();
  const log = debug ? (/** @type {any[]} */ ...a) => console.error("[ble:list]", ...a) : () => {};
  await waitPoweredOn(noble, log);
  // deviceUUID(dashed lower) -> 発見結果。SDK の chDeviceMap.getOrPut(deviceID) と同じく dedup する。
  /** @type {Map<string, NonNullable<ReturnType<typeof peripheralToDiscovery>>>} */
  const found = new Map();

  return new Promise((resolve) => {
    let done = false;
    const finish = async () => {
      if (done) return; done = true;
      clearTimeout(to);
      noble.removeListener("discover", onDiscover);
      await noble.stopScanningAsync().catch(() => {});
      resolve([...found.values()]);
    };
    const to = setTimeout(finish, timeoutMs);
    /** @param {NoblePeripheral} p */
    const onDiscover = (p) => {
      const entry = peripheralToDiscovery(p, { includeUnknown });
      if (!entry) return; // SESAME でない / deviceUUID=null / (既定で) 未知機種
      const key = entry.deviceUUID;
      // SDK chDeviceMap.getOrPut(deviceID) と同じく dedup。再受信時は最新 rssi/localName/peripheral
      // で上書きしつつ、最初の発見順を保つ (Map は挿入順)。
      const existing = found.get(key);
      if (!existing) { found.set(key, entry); log("found", key, entry.model); }
      else { Object.assign(existing, { rssi: entry.rssi, localName: entry.localName, peripheral: entry.peripheral }); }
    };
    noble.on("discover", onDiscover);
    noble.startScanningAsync([nobleUuid(gatt.SERVICE)], false).catch((/** @type {any} */ e) => {
      log("scan start failed", e?.message);
      finish();
    });
  });
}

/**
 * @typedef {object} Gatt discover/subscribe する GATT (省略時 SESAME GATT fd81)。
 * @property {string} SERVICE
 * @property {string} WRITE_CHAR
 * @property {string} NOTIFY_CHAR
 */

/**
 * NobleTransport のコンストラクタ opts。
 * @typedef {object} NobleTransportOpts
 * @property {string} [deviceUUID] 対象 SESAME の deviceUUID (advertise から照合)。
 * @property {string} [address] BLE アドレスで照合 (deviceUUID が取れない環境向け)。
 * @property {NoblePeripheral} [peripheral] 既にスキャン済みの noble peripheral (scanSesames の結果)。あればスキャンしない。
 * @property {number} [scanTimeoutMs]
 * @property {boolean} [debug]
 * @property {Gatt} [gatt] discover/subscribe する GATT (省略時 SESAME GATT fd81)。WM2 は WM2_GATT を渡す。
 */

/**
 * noble (@abandonware/noble) ベースの BLE トランスポート。
 */
export class NobleTransport {
  /** @param {NobleTransportOpts} [opts] */
  constructor(opts = {}) {
    this._opts = opts;
    /** @type {Noble|null} */
    this._noble = null;
    /** @type {NoblePeripheral|null} */
    this._peripheral = opts.peripheral || null; // 事前スキャン済みなら受け取る
    this._scanned = false; // 自前でスキャンしたか (disconnect 時の stopScanning 判定)
    this._gatt = opts.gatt || GATT; // discover/subscribe する GATT (WM2 は WM2_GATT を注入)
    /** @type {NobleCharacteristic|null} */
    this._writeChar = null;
    /** @type {NobleCharacteristic|null} */
    this._notifyChar = null;
    /** @type {Promise<void>} */
    this._writeChain = Promise.resolve();
    this._debug = !!opts.debug;
    /** @type {((reason:any)=>void)|null} */
    this._onDisconnect = null;     // session が connect() 時に渡す切断ハンドラ
    this._disconnected = false;    // 切断検知済みか (onDisconnect の二重発火・以後の write を防ぐ)
    /** @type {((reason:any)=>void)|null} */
    this._onPeripheralDisconnect = null; // peripheral 'disconnect' リスナ (解除用に保持)
  }

  /** @param {...any} a */
  _log(...a) { if (this._debug) console.error("[ble:noble]", ...a); }

  /**
   * @param {(packet:Buffer)=>void} onPacket notify 1 件ごとに呼ばれる
   * @param {(reason:any)=>void} [onDisconnect] リンク切断時 (相手側/圏外/write 連続失敗) に 1 回だけ呼ばれる。
   *   session 側はこれを受けて pending request を fail-fast し、timeout 宙づりを防ぐ。
   */
  async connect(onPacket, onDisconnect) {
    this._onDisconnect = typeof onDisconnect === "function" ? onDisconnect : null;
    this._disconnected = false;
    // peripheral が渡されていれば (scanSesames 経由) スキャンを省略 = マルチ接続の高速パス。
    if (!this._peripheral) {
      const noble = (this._noble = loadNoble());
      const { deviceUUID, address, scanTimeoutMs = 15_000 } = this._opts;
      await this._waitPoweredOn(noble);
      this._scanned = true;
      this._peripheral = await this._scanForDevice(noble, { deviceUUID, address, scanTimeoutMs });
    }
    // この時点で _peripheral は必ず非 null (上で peripheral 受領 or scan 済み)。型のみ非 null 化。
    const peripheral = /** @type {NoblePeripheral} */ (this._peripheral);
    this._log("connecting to", peripheral.address || peripheral.id);

    // 切断イベント購読 (noble peripheral.js:69-77 / noble.js:245-251 で OS の切断通知が 'disconnect'
    // として emit される)。SDK CHSesameOS3.kt:228-263 onConnectionStateChange の STATE_DISCONNECTED 分岐
    // (connectR.remove / cmdCallBack.clear) に相当: ここでは session の pending を fail-fast させる。
    // connectAsync の **前** に登録する (接続直後の早期切断も取りこぼさない)。
    this._onPeripheralDisconnect = (reason) => this._handleDisconnect(reason);
    peripheral.on("disconnect", this._onPeripheralDisconnect);

    await peripheral.connectAsync();

    // MTU ネゴシエーション (SDK CHSesameOS3.kt:231-235: Touch/Face 系は requestMtu(251) を明示要求)。
    // noble (CoreBluetooth バインディング) には能動的な requestMtu API が無く、MTU は OS が自動協商する
    // (SDK コメント "iOS会自動協商" と同じ挙動。Android だけが手動要求を要する)。協商後の値は
    // peripheral.mtu (noble.js:592-594 onMtu で設定) に入るため、参照のみ行いログに残す。
    // 実機での MTU 値検証は未了 (能動要求できないため誇張しない)。
    if (this._debug && peripheral.mtu != null) this._log("negotiated MTU (auto, CoreBluetooth)", peripheral.mtu);

    // 3) service / characteristic を取得
    const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
      [nobleUuid(this._gatt.SERVICE)],
      [nobleUuid(this._gatt.WRITE_CHAR), nobleUuid(this._gatt.NOTIFY_CHAR)],
    );
    this._writeChar = characteristics.find((c) => idEquals(c.uuid, this._gatt.WRITE_CHAR)) || null;
    this._notifyChar = characteristics.find((c) => idEquals(c.uuid, this._gatt.NOTIFY_CHAR)) || null;
    if (!this._writeChar || !this._notifyChar) {
      throw new Error(t("ble.gattNotFound"));
    }

    // 4) notify 購読 → 各パケットを onPacket へ
    this._notifyChar.on("data", (data) => {
      try { onPacket(Buffer.isBuffer(data) ? data : Buffer.from(data)); }
      catch (e) { this._log("onPacket threw", e); }
    });
    await this._notifyChar.subscribeAsync();
    this._log("connected + subscribed");
  }

  /**
   * Write Without Response。順序保証のため直列化。
   * writeAsync が失敗したら有限回 (WRITE_MAX_RETRIES) 指数バックオフで再送し、それでも失敗すれば
   * リンク断扱い (_handleDisconnect) として onDisconnect を発火させ、最後のエラーを投げる。
   * SDK CHSesameOS3.kt:321-346 transmit の「リトライ→最終的に失敗で disconnect」と同じ流儀
   * (回数は noble の非同期 writeAsync に合わせて妥当な少数に縮小。仕様で許容)。
   * @param {Buffer|Uint8Array} bytes
   * @returns {Promise<void>}
   */
  write(bytes) {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    this._writeChain = this._writeChain.then(() => this._writeWithRetry(buf));
    return this._writeChain;
  }

  /**
   * writeAsync を有限回リトライ。全失敗で _handleDisconnect → 最後のエラーを rethrow。
   * @param {Buffer} buf
   * @returns {Promise<void>}
   */
  async _writeWithRetry(buf) {
    if (this._disconnected) throw new Error(t("ble.notConnected")); // 既に切断 → 再送しない
    if (!this._writeChar) throw new Error(t("ble.notConnected"));
    /** @type {unknown} */
    let lastErr = null;
    for (let attempt = 0; attempt <= WRITE_MAX_RETRIES; attempt++) {
      try {
        await this._writeChar.writeAsync(buf, true); // true = without response
        return;
      } catch (e) {
        lastErr = e;
        if (this._disconnected) break; // リトライ中に切断検知したら即諦める
        if (attempt < WRITE_MAX_RETRIES) {
          const delay = WRITE_RETRY_BASE_MS * (1 << attempt); // 20,40,80,160,320ms
          this._log("write failed, retrying", { attempt: attempt + 1, delay, cause: /** @type {{message?:string}} */ (e)?.message });
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    // 全リトライ失敗 = リンク断とみなす (SDK: 最終的に disconnect)。session に fail-fast させる。
    this._log("write failed after retries; treating as disconnect", /** @type {{message?:string}} */ (lastErr)?.message);
    this._handleDisconnect(lastErr);
    throw lastErr || new Error(t("ble.notConnected"));
  }

  /**
   * リンク切断 (peripheral 'disconnect' / write 連続失敗) を 1 回だけ session に伝播する。
   * SDK の onConnectionStateChange STATE_DISCONNECTED 側 (cmdCallBack.clear) に相当。
   * @param {any} reason 切断理由 (noble の reason 文字列 or write 失敗エラー)
   */
  _handleDisconnect(reason) {
    if (this._disconnected) return; // 二重発火防止 (write 失敗と peripheral 'disconnect' の競合)
    this._disconnected = true;
    this._log("link disconnected", reason);
    const cb = this._onDisconnect;
    if (cb) { try { cb(reason); } catch (e) { this._log("onDisconnect threw", e); } }
  }

  async disconnect() {
    // 能動切断: これ以降の write を弾き、peripheral 'disconnect' の onDisconnect コールバックも抑止する
    // (こちらから切るので session の pending は session.disconnect() 側が既に解放済み)。
    this._disconnected = true;
    this._onDisconnect = null; // 能動切断時は session へのコールバックを発火させない (二重処理回避)
    // peripheral 'disconnect' リスナを外してから切断する (listener リーク / 切断時の二重発火防止)。
    if (this._peripheral && this._onPeripheralDisconnect) {
      try { this._peripheral.removeListener("disconnect", this._onPeripheralDisconnect); } catch { /* ignore */ }
    }
    this._onPeripheralDisconnect = null;
    try { if (this._notifyChar) await this._notifyChar.unsubscribeAsync().catch(() => {}); } catch { /* ignore */ }
    try { if (this._peripheral) await this._peripheral.disconnectAsync(); } catch { /* ignore */ }
    // 自前スキャンした場合のみ stopScanning (scanSesames 経由は既に停止済み)。
    try { if (this._scanned && this._noble) await this._noble.stopScanningAsync().catch(() => {}); } catch { /* ignore */ }
    this._peripheral = null;
    this._writeChar = null;
    this._notifyChar = null;
  }

  /** @param {Noble} noble */
  _waitPoweredOn(noble) { return waitPoweredOn(noble, (/** @type {any[]} */ ...a) => this._log(...a)); }

  /**
   * @param {Noble} noble
   * @param {{deviceUUID?:string, address?:string, scanTimeoutMs:number}} opts
   * @returns {Promise<NoblePeripheral>}
   */
  _scanForDevice(noble, { deviceUUID, address, scanTimeoutMs }) {
    return new Promise((resolve, reject) => {
      const to = setTimeout(async () => {
        noble.removeListener("discover", onDiscover);
        await noble.stopScanningAsync().catch(() => {});
        reject(new Error(t("ble.deviceNotFound", { scanTimeoutMs })));
      }, scanTimeoutMs);

      /** @param {NoblePeripheral} peripheral */
      const onDiscover = async (peripheral) => {
        const md = peripheral.advertisement?.manufacturerData;
        const advUuid = advToDeviceUUID(md);
        // 照合: deviceUUID 指定があれば advertise の deviceUUID か BLE アドレスで一致、
        // どちらも未指定なら最初に見つかった SESAME (company 0x055A) を採用。
        const isSesame = advUuid != null;
        if (!isSesame) return;
        const match =
          (!deviceUUID && !address) ||
          (deviceUUID && advUuid && idEquals(advUuid, deviceUUID)) ||
          (address && idEquals(peripheral.address, address));
        if (!match) return;
        clearTimeout(to);
        noble.removeListener("discover", onDiscover);
        await noble.stopScanningAsync().catch(() => {});
        resolve(peripheral);
      };

      noble.on("discover", onDiscover);
      noble.startScanningAsync([nobleUuid(this._gatt.SERVICE)], false).catch((/** @type {any} */ e) => {
        clearTimeout(to);
        noble.removeListener("discover", onDiscover);
        reject(new Error(t("ble.scanStartFailed", { cause: e?.message || e })));
      });
    });
  }
}

/**
 * 既定の BLE トランスポートを生成する (noble を遅延ロード)。
 * @param {NobleTransportOpts} [opts] NobleTransport の opts
 * @returns {NobleTransport}
 */
export function createBleTransport(opts = {}) {
  return new NobleTransport(opts);
}
