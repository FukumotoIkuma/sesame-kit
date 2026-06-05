// BLE 無線トランスポートのアダプタ。
//
// セッション/プロトコル層 (session.js / protocol.js) は OS 非依存。物理 BLE I/O だけを
// このアダプタに閉じ込め、ライブラリ本体はどのアダプタにも**ハード依存しない**。
// 既定アダプタは @abandonware/noble (optionalDependency) を**遅延 require** する。
// 未導入・Bluetooth 権限なしのときは明確なエラーメッセージを出す。
//
// アダプタ契約 (session.js が要求):
//   connect(onPacket: (packet:Buffer)=>void): Promise<void>   接続+notify購読。各 notify を onPacket へ。
//   write(bytes: Buffer): Promise<void>                        Write Without Response (順序保証)。
//   disconnect(): Promise<void>
//
// 自前/Web Bluetooth 等の別アダプタも、この 3 メソッドを満たせば session に注入できる。

import { Buffer } from "node:buffer";
import { createRequire } from "node:module";
import { GATT, COMPANY_ID } from "./protocol.js";

// optionalDependency (@abandonware/noble) を ESM から遅延 require するためのブリッジ。
const require = createRequire(import.meta.url);

/** noble 形式 (小文字・ハイフン無し) に正規化。 */
function nobleUuid(u) {
  return String(u).replace(/-/g, "").toLowerCase();
}

/**
 * SESAME の advertise manufacturerData から deviceUUID を抽出する。
 * noble の manufacturerData は company ID (LE 5A 05 = 0x055A) を含む生バイト列
 * (Sesame2BleAdvertisement.kt の valueAt(0) は company ID を除く点に注意 = こちらは +2 オフセット)。
 * SS5/Touch 系: company(2) + productType(1) + flags(2) + deviceID(16) → deviceID は md[5..21]。
 *
 * @param {Buffer|Uint8Array|null|undefined} md
 * @returns {string|null} "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" (小文字) or null
 */
export function advToDeviceUUID(md) {
  if (!md) return null;
  const b = Buffer.isBuffer(md) ? md : Buffer.from(md);
  if (b.length < 21) return null;
  // company ID は LE で 5A 05 (= 0x055A)
  if (b[0] !== (COMPANY_ID & 0xff) || b[1] !== ((COMPANY_ID >> 8) & 0xff)) return null;
  const hex = b.subarray(5, 21).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** 2 つの deviceUUID/アドレスを正規化比較 (ハイフン/大文字無視)。 */
function idEquals(a, b) {
  if (!a || !b) return false;
  return nobleUuid(a) === nobleUuid(b);
}

// noble (CoreBluetooth バインディング) は一度ロードするとネイティブハンドルがイベントループに
// 残り、コマンド完了後も node が自然 exit しない。これを立ててエントリポイントで強制 exit を判断する。
let _nobleLoaded = false;
/** このプロセスで noble をロード済みか (= 通常 exit ではプロセスが終わらない)。 */
export function bleWasUsed() { return _nobleLoaded; }

/**
 * noble を遅延ロードする。未導入・ロード失敗時は導線付きエラー。
 * @returns {any} noble モジュール
 */
function loadNoble() {
  try {
    // @abandonware/noble は optionalDependency。未導入なら下で握る。
    const noble = require("@abandonware/noble");
    _nobleLoaded = true;
    return noble;
  } catch (e) {
    // MODULE_NOT_FOUND の message は require stack を含むので 1 行目だけ拾う。
    const cause = String(e?.message || e).split("\n")[0];
    const err = new Error(
      "BLE アダプタ (@abandonware/noble) が未導入です。\n" +
        "  導入: npm i @abandonware/noble  (repo 内で実行 / npm link 環境ならそのまま使えます)\n" +
        `  (${cause})`,
    );
    err.code = "BLE_NO_ADAPTER";
    throw err;
  }
}

/** Bluetooth が poweredOn になるまで待つ (権限/未対応は導線付きエラー)。 */
function waitPoweredOn(noble, log = () => {}) {
  return new Promise((resolve, reject) => {
    if (noble.state === "poweredOn") return resolve();
    const to = setTimeout(() => { noble.removeListener("stateChange", onState); reject(new Error("Bluetooth 初期化タイムアウト")); }, 10_000);
    const onState = (state) => {
      log("noble state", state);
      if (state === "poweredOn") { clearTimeout(to); noble.removeListener("stateChange", onState); resolve(); }
      else if (state === "unauthorized") {
        clearTimeout(to); noble.removeListener("stateChange", onState);
        const e = new Error("Bluetooth 権限がありません。macOS: システム設定→プライバシーとセキュリティ→Bluetooth で実行中のターミナルを許可してください。");
        e.code = "BLE_UNAUTHORIZED"; // CLI 側で設定ペインを開く判定に使う
        reject(e);
      }
      else if (state === "poweredOff") {
        clearTimeout(to); noble.removeListener("stateChange", onState);
        const e = new Error("Bluetooth がオフです。オンにして再実行してください。");
        e.code = "BLE_POWERED_OFF";
        reject(e);
      }
      else if (state === "unsupported") {
        clearTimeout(to); noble.removeListener("stateChange", onState);
        const e = new Error("この環境では BLE が利用できません (unsupported)。");
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
 * @param {{deviceUUIDs?:string[], timeoutMs?:number, debug?:boolean}} opts
 * @returns {Promise<Map<string, any>>} key = deviceUUID(小文字ダッシュ付き) → noble peripheral
 */
export async function scanSesames({ deviceUUIDs = [], timeoutMs = 8_000, debug = false } = {}) {
  const noble = loadNoble();
  const log = debug ? (...a) => console.error("[ble:scan]", ...a) : () => {};
  await waitPoweredOn(noble, log);
  const want = new Set(deviceUUIDs.map(nobleUuid));
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
    noble.startScanningAsync([nobleUuid(GATT.SERVICE)], false).catch((e) => {
      log("scan start failed", e?.message);
      finish();
    });
  });
}

/**
 * @abandonware/noble ベースの BLE トランスポート。
 *
 * @param {{
 *   deviceUUID?: string,   // 対象 SESAME の deviceUUID (advertise から照合)
 *   address?: string,      // BLE アドレスで照合 (deviceUUID が取れない環境向け)
 *   peripheral?: object,   // 既にスキャン済みの noble peripheral (scanSesames の結果)。あればスキャンしない
 *   scanTimeoutMs?: number,
 *   debug?: boolean,
 * }} opts
 */
export class NobleTransport {
  constructor(opts = {}) {
    this._opts = opts;
    this._noble = null;
    this._peripheral = opts.peripheral || null; // 事前スキャン済みなら受け取る
    this._scanned = false; // 自前でスキャンしたか (disconnect 時の stopScanning 判定)
    this._writeChar = null;
    this._notifyChar = null;
    this._writeChain = Promise.resolve();
    this._debug = !!opts.debug;
  }

  _log(...a) { if (this._debug) console.error("[ble:noble]", ...a); }

  /** @param {(packet:Buffer)=>void} onPacket */
  async connect(onPacket) {
    // peripheral が渡されていれば (scanSesames 経由) スキャンを省略 = マルチ接続の高速パス。
    if (!this._peripheral) {
      const noble = (this._noble = loadNoble());
      const { deviceUUID, address, scanTimeoutMs = 15_000 } = this._opts;
      await this._waitPoweredOn(noble);
      this._scanned = true;
      this._peripheral = await this._scanForDevice(noble, { deviceUUID, address, scanTimeoutMs });
    }
    const peripheral = this._peripheral;
    this._log("connecting to", peripheral.address || peripheral.id);
    await peripheral.connectAsync();

    // 3) service / characteristic を取得
    const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
      [nobleUuid(GATT.SERVICE)],
      [nobleUuid(GATT.WRITE_CHAR), nobleUuid(GATT.NOTIFY_CHAR)],
    );
    this._writeChar = characteristics.find((c) => idEquals(c.uuid, GATT.WRITE_CHAR));
    this._notifyChar = characteristics.find((c) => idEquals(c.uuid, GATT.NOTIFY_CHAR));
    if (!this._writeChar || !this._notifyChar) {
      throw new Error("SESAME GATT characteristic が見つかりません (write/notify)");
    }

    // 4) notify 購読 → 各パケットを onPacket へ
    this._notifyChar.on("data", (data) => {
      try { onPacket(Buffer.isBuffer(data) ? data : Buffer.from(data)); }
      catch (e) { this._log("onPacket threw", e); }
    });
    await this._notifyChar.subscribeAsync();
    this._log("connected + subscribed");
  }

  /** Write Without Response。順序保証のため直列化。 */
  write(bytes) {
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    this._writeChain = this._writeChain.then(() => {
      if (!this._writeChar) throw new Error("not connected");
      return this._writeChar.writeAsync(buf, true); // true = without response
    });
    return this._writeChain;
  }

  async disconnect() {
    try { if (this._notifyChar) await this._notifyChar.unsubscribeAsync().catch(() => {}); } catch { /* ignore */ }
    try { if (this._peripheral) await this._peripheral.disconnectAsync(); } catch { /* ignore */ }
    // 自前スキャンした場合のみ stopScanning (scanSesames 経由は既に停止済み)。
    try { if (this._scanned && this._noble) await this._noble.stopScanningAsync().catch(() => {}); } catch { /* ignore */ }
    this._peripheral = null;
    this._writeChar = null;
    this._notifyChar = null;
  }

  _waitPoweredOn(noble) { return waitPoweredOn(noble, (...a) => this._log(...a)); }

  _scanForDevice(noble, { deviceUUID, address, scanTimeoutMs }) {
    return new Promise((resolve, reject) => {
      const to = setTimeout(async () => {
        noble.removeListener("discover", onDiscover);
        await noble.stopScanningAsync().catch(() => {});
        reject(new Error(`SESAME が見つかりません (scan ${scanTimeoutMs}ms タイムアウト)。対象が近くにあり登録済みか確認してください。`));
      }, scanTimeoutMs);

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
      noble.startScanningAsync([nobleUuid(GATT.SERVICE)], false).catch((e) => {
        clearTimeout(to);
        noble.removeListener("discover", onDiscover);
        reject(new Error(`BLE スキャン開始に失敗: ${e?.message || e}`));
      });
    });
  }
}

/**
 * 既定の BLE トランスポートを生成する (noble を遅延ロード)。
 * @param {object} opts NobleTransport の opts
 * @returns {NobleTransport}
 */
export function createBleTransport(opts = {}) {
  return new NobleTransport(opts);
}
