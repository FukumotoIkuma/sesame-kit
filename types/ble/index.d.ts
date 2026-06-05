export * as protocol from "./protocol.js";
export * as devicemodel from "./devicemodel.js";
/**
 * 登録済み SESAME を BLE で直接操作する高レベルファサード。
 */
export class SesameBle {
    /**
     * connect → fn → close を自動で行うヘルパー。
     * @param {object} opts コンストラクタ opts
     * @param {(lock:SesameBle)=>Promise<any>} fn
     */
    static use(opts: object, fn: (lock: SesameBle) => Promise<any>): Promise<any>;
    /**
     * 複数ロックに**1 回のスキャン**で同時接続する (逐次スキャンを避ける正攻法)。
     * 近接していないロックは結果に現れず即スキップ (per-device の scan timeout を払わない)。
     * 見つかったロックへは**並行接続** (login まで)。
     *
     * @param {Array<{name:string, deviceUUID:string, secretKey:string, model?:string}>} entries
     * @param {{debug?:boolean, scanTimeoutMs?:number}} [opts]
     * @returns {Promise<{connected: Map<string, SesameBle>, unreachable: string[], failed: Array<{name:string, error:Error}>}>}
     */
    static connectMany(entries: Array<{
        name: string;
        deviceUUID: string;
        secretKey: string;
        model?: string;
    }>, { debug, scanTimeoutMs }?: {
        debug?: boolean;
        scanTimeoutMs?: number;
    }): Promise<{
        connected: Map<string, SesameBle>;
        unreachable: string[];
        failed: Array<{
            name: string;
            error: Error;
        }>;
    }>;
    /**
     * @param {{
     *   secretKey: string|Buffer,   // 32hex のロック共通鍵 (cloud の `sesame devices` で取得済み)
     *   deviceUUID?: string,        // 対象識別 (advertise 照合)。複数 SESAME が近接する環境で必須
     *   address?: string,           // BLE アドレスで識別する代替
     *   debug?: boolean,
     *   transport?: object,         // 独自トランスポート (省略時 noble)
     * }} opts
     */
    constructor({ secretKey, deviceUUID, address, model, debug, scanTimeoutMs, transport }?: {
        secretKey: string | Buffer;
        deviceUUID?: string;
        address?: string;
        debug?: boolean;
        transport?: object;
    });
    _transport: any;
    _session: SesameBleSession;
    _model: any;
    _caps: {
        kind: string;
        os: number;
        cloud: string[];
        ble: string[];
        ops: string[];
        mechKind: string | null;
        bleSupported: boolean;
        label: string;
    };
    /** デバイスの model 文字列 (例 "sesame_5" / "bot_2")。未指定なら null。 */
    get model(): any;
    /** 型ごとの能力 { kind, os, ops, mechKind, bleSupported, label }。 */
    get capabilities(): {
        kind: string;
        os: number;
        cloud: string[];
        ble: string[];
        ops: string[];
        mechKind: string | null;
        bleSupported: boolean;
        label: string;
    };
    /** この操作を BLE で送れるか (このファサードは BLE 専用なので ble 能力で判定)。 */
    supports(op: any): boolean;
    /** BLE で送れない操作を弾く。SDK では型ごとに能力が非対称 (Bot は click のみ等)。 */
    _assertOp(op: any): void;
    /** mechStatus publish を購読 (戻り値 unsubscribe)。 */
    onStatus(fn: any): () => boolean;
    /** 最後に受信した mechStatus。 */
    get lastStatus(): {
        state: string;
        isInLockRange: boolean;
        target: number | null;
        position: number | null;
        isStop: boolean;
        isCritical: boolean;
        isBatteryCritical: boolean;
        batteryRaw: number;
        flags: number;
    };
    get isConnected(): boolean;
    /** 接続 + login。 */
    connect(): Promise<this>;
    /** 切断。 */
    close(): Promise<void>;
    /**
     * 施錠 (BLE item=82)。tag は履歴に残す任意ラベル。
     * @returns {Promise<{resultCode:number, payload:Buffer}>}
     */
    lock(tag: any): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /** 解錠 (BLE item=83)。Sesame5/6 ロックと Bike2 が対応。 */
    unlock(tag: any): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * SESAME Bot のクリック (BLE item=89)。Bot2/Bot3 のみ。
     * @param {Buffer} [tag] 履歴タグ (UUID バイト列)
     */
    click(tag?: Buffer): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * トグル (Sesame5/6 ロックのみ)。直近の mechStatus が無ければ status() を取得してから判定。
     * locked → unlock、それ以外 → lock (CHSesame5Device.kt:128-145 準拠)。
     */
    toggle(tag: any): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * オートロック設定 (BLE item=11、2byte LE 秒数。0=無効)。Sesame5/6 ロックのみ。
     * **BLE 経由なら実機に反映される** (クラウドの biz3TriggerLocker では ack のみで未反映だった機能)。
     * @param {number} seconds 0..65535
     */
    autolock(seconds: number): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * 現在の mechStatus を返す。未受信なら publish を待つ (timeout 付き)。
     * @param {{timeoutMs?:number}} [opts]
     * @returns {Promise<object>} parseMechStatus の結果
     */
    status({ timeoutMs }?: {
        timeoutMs?: number;
    }): Promise<object>;
    /**
     * 履歴を 1 バッチ取得 (BLE item=4)。payload の解析は呼び出し側 (生バイト返し)。
     * @returns {Promise<Buffer>}
     */
    history(): Promise<Buffer>;
}
import { Buffer } from "node:buffer";
export { SesameBleSession, BleResultError } from "./session.js";
export { RESULT as SESAME_RESULT_CODES, resultName } from "./protocol.js";
export { NobleTransport, createBleTransport, advToDeviceUUID, scanSesames } from "./transport.js";
export { capabilitiesForModel, kindForModel, supportsOp, isOperable, transportsForOp, KIND, PRODUCT_TYPES } from "./devicemodel.js";
//# sourceMappingURL=index.d.ts.map