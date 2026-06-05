/**
 * SESAME の advertise manufacturerData から deviceUUID を抽出する。
 * noble の manufacturerData は company ID (LE 5A 05 = 0x055A) を含む生バイト列
 * (Sesame2BleAdvertisement.kt の valueAt(0) は company ID を除く点に注意 = こちらは +2 オフセット)。
 * SS5/Touch 系: company(2) + productType(1) + flags(2) + deviceID(16) → deviceID は md[5..21]。
 *
 * @param {Buffer|Uint8Array|null|undefined} md
 * @returns {string|null} "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" (小文字) or null
 */
export function advToDeviceUUID(md: Buffer | Uint8Array | null | undefined): string | null;
/** このプロセスで noble をロード済みか (= 通常 exit ではプロセスが終わらない)。 */
export function bleWasUsed(): boolean;
/**
 * **1 回のスキャン**で近接 SESAME を集める (マルチ接続用)。逐次スキャンを避けるための要。
 * deviceUUIDs を指定すると、それらが**全て見つかった時点で即終了**、または timeout で打ち切り。
 * 空指定なら timeout まで全 SESAME を収集。圏外のデバイスは結果に含まれない (= 即スキップ可)。
 *
 * @param {{deviceUUIDs?:string[], timeoutMs?:number, debug?:boolean}} opts
 * @returns {Promise<Map<string, any>>} key = deviceUUID(小文字ダッシュ付き) → noble peripheral
 */
export function scanSesames({ deviceUUIDs, timeoutMs, debug }?: {
    deviceUUIDs?: string[];
    timeoutMs?: number;
    debug?: boolean;
}): Promise<Map<string, any>>;
/**
 * 既定の BLE トランスポートを生成する (noble を遅延ロード)。
 * @param {object} opts NobleTransport の opts
 * @returns {NobleTransport}
 */
export function createBleTransport(opts?: object): NobleTransport;
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
    constructor(opts?: {});
    _opts: {};
    _noble: any;
    _peripheral: any;
    _scanned: boolean;
    _writeChar: any;
    _notifyChar: any;
    _writeChain: Promise<void>;
    _debug: boolean;
    _log(...a: any[]): void;
    /** @param {(packet:Buffer)=>void} onPacket */
    connect(onPacket: (packet: Buffer) => void): Promise<void>;
    /** Write Without Response。順序保証のため直列化。 */
    write(bytes: any): Promise<void>;
    disconnect(): Promise<void>;
    _waitPoweredOn(noble: any): Promise<any>;
    _scanForDevice(noble: any, { deviceUUID, address, scanTimeoutMs }: {
        deviceUUID: any;
        address: any;
        scanTimeoutMs: any;
    }): Promise<any>;
}
import { Buffer } from "node:buffer";
//# sourceMappingURL=transport.d.ts.map