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
export function parseAdvertisement(md: Buffer | Uint8Array | null | undefined): {
    productType: number;
    model: (string | null);
    kind: string;
    isRegistered: boolean;
    advTagB1: boolean;
    isConnectable: boolean;
    deviceUUID: (string | null);
} | null;
/**
 * SESAME の advertise manufacturerData から deviceUUID を抽出する (後方互換の薄いラッパ)。
 * 機種別レイアウトの全分岐は parseAdvertisement に集約し、ここはその deviceUUID だけを返す。
 * これにより SS5 だけでなく WM2/Hub3 でも正しい UUID が得られる (旧実装は SS5 レイアウト固定だった)。
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
 * @param {{deviceUUIDs?:string[], timeoutMs?:number, debug?:boolean, gatt?:{SERVICE:string}}} opts
 *   gatt: スキャンフィルタに使う service UUID (省略時 SESAME GATT fd81)。WM2 は WM2_GATT を渡す。
 *     advertise の company ID (0x055A) は全 SESAME 共通なので parse は機種別に分岐する (gatt 非依存)。
 * @returns {Promise<Map<string, any>>} key = deviceUUID(小文字ダッシュ付き) → noble peripheral
 */
export function scanSesames({ deviceUUIDs, timeoutMs, debug, gatt }?: {
    deviceUUIDs?: string[];
    timeoutMs?: number;
    debug?: boolean;
    gatt?: {
        SERVICE: string;
    };
}): Promise<Map<string, any>>;
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
export function peripheralToDiscovery(p: {
    advertisement?: {
        manufacturerData?: any;
        localName?: string;
    };
    rssi?: number;
    address?: string;
}, { includeUnknown }?: {
    includeUnknown?: boolean;
}): {
    deviceUUID: string;
    productType: number;
    model: (string | null);
    kind: string;
    isRegistered: boolean;
    advTagB1: boolean;
    isConnectable: boolean;
    rssi: (number | null);
    localName: (string | null);
    address: (string | null);
    peripheral: any;
} | null;
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
export function listNearbyDevices({ timeoutMs, debug, includeUnknown, gatt }?: {
    timeoutMs?: number;
    debug?: boolean;
    includeUnknown?: boolean;
    gatt?: {
        SERVICE: string;
    };
}): Promise<Array<{
    deviceUUID: string;
    productType: number;
    model: (string | null);
    kind: string;
    isRegistered: boolean;
    advTagB1: boolean;
    isConnectable: boolean;
    rssi: (number | null);
    localName: (string | null);
    address: (string | null);
    peripheral: any;
}>>;
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
 *   gatt?: {SERVICE:string, WRITE_CHAR:string, NOTIFY_CHAR:string}, // discover/subscribe する GATT
 *                          // (省略時 SESAME GATT fd81)。WM2 は WM2_GATT を渡す。
 * }} opts
 */
export class NobleTransport {
    constructor(opts?: {});
    _log(...a: any[]): void;
    /**
     * @param {(packet:Buffer)=>void} onPacket notify 1 件ごとに呼ばれる
     * @param {(reason:any)=>void} [onDisconnect] リンク切断時 (相手側/圏外/write 連続失敗) に 1 回だけ呼ばれる。
     *   session 側はこれを受けて pending request を fail-fast し、timeout 宙づりを防ぐ。
     */
    connect(onPacket: (packet: Buffer) => void, onDisconnect?: (reason: any) => void): Promise<void>;
    /**
     * Write Without Response。順序保証のため直列化。
     * writeAsync が失敗したら有限回 (WRITE_MAX_RETRIES) 指数バックオフで再送し、それでも失敗すれば
     * リンク断扱い (_handleDisconnect) として onDisconnect を発火させ、最後のエラーを投げる。
     * SDK CHSesameOS3.kt:321-346 transmit の「リトライ→最終的に失敗で disconnect」と同じ流儀
     * (回数は noble の非同期 writeAsync に合わせて妥当な少数に縮小。仕様で許容)。
     */
    write(bytes: any): Promise<void>;
    /** writeAsync を有限回リトライ。全失敗で _handleDisconnect → 最後のエラーを rethrow。 */
    _writeWithRetry(buf: any): Promise<void>;
    /**
     * リンク切断 (peripheral 'disconnect' / write 連続失敗) を 1 回だけ session に伝播する。
     * SDK の onConnectionStateChange STATE_DISCONNECTED 側 (cmdCallBack.clear) に相当。
     * @param {any} reason 切断理由 (noble の reason 文字列 or write 失敗エラー)
     */
    _handleDisconnect(reason: any): void;
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