/**
 * BLE デバイスが非 0 の resultCode を返したときのエラー。
 * `resultName` (notFound/busy/invalidSig…) で機械的に分岐できる (SesameResultCode 由来)。
 */
export class BleResultError extends Error {
    /** @param {"login"|"command"} phase @param {number} resultCode @param {number|null} itemCode */
    constructor(phase: "login" | "command", resultCode: number, itemCode?: number | null);
    resultCode: number;
    resultName: any;
    itemCode: number;
}
/**
 * @typedef {object} BleTransport BLE 無線 I/O アダプタ (transport.js のアダプタが満たす契約)。
 * @property {(onPacket:(packet:Buffer)=>void)=>Promise<void>} connect 接続+notify購読。各 notify を onPacket へ。
 * @property {(bytes:Buffer)=>void|Promise<void>} write Write Without Response。
 * @property {()=>void|Promise<void>} disconnect 切断。
 */
export class SesameBleSession {
    /**
     * @param {{transport:BleTransport, secretKey:string|Buffer, debug?:boolean,
     *          defaultTimeoutMs?:number}} opts
     */
    constructor({ transport, secretKey, debug, defaultTimeoutMs }: {
        transport: BleTransport;
        secretKey: string | Buffer;
        debug?: boolean;
        defaultTimeoutMs?: number;
    });
    _transport: BleTransport;
    _secretKey: Buffer<ArrayBufferLike>;
    _debug: boolean;
    _defaultTimeoutMs: number;
    _asm: SegmentAssembler;
    _token: Buffer<any>;
    _key: Buffer<ArrayBufferLike>;
    _encCount: number;
    _decCount: number;
    _loggedIn: boolean;
    /** @type {Map<number, Array<{resolve:Function, reject:Function, timer:any}>>} item → FIFO */
    _pending: Map<number, Array<{
        resolve: Function;
        reject: Function;
        timer: any;
    }>>;
    _statusListeners: Set<any>;
    _publishListeners: Set<any>;
    _lastStatus: {
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
    _loginWaiter: {
        resolve: (value: any) => void;
        reject: (reason?: any) => void;
        timer: NodeJS.Timeout;
    };
    _log(...a: any[]): void;
    /** 最後に受信した mechStatus (parseMechStatus の結果)。未受信なら null。 */
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
    get isLoggedIn(): boolean;
    /** mechStatus publish を購読。戻り値 unsubscribe。 */
    onStatus(fn: any): () => boolean;
    /** 任意 publish を購読 ({opCode,itemCode,body})。戻り値 unsubscribe。 */
    onPublish(fn: any): () => boolean;
    /**
     * 接続して login まで完了させる。
     * @returns {Promise<void>} login 成功で resolve
     */
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    /**
     * 暗号化コマンドを送り、response(7)+item を待って返す。
     * @param {number} itemCode
     * @param {Buffer} [data]
     * @param {{timeoutMs?:number}} [opts]
     * @returns {Promise<{resultCode:number, payload:Buffer}>}
     */
    request(itemCode: number, data?: Buffer, { timeoutMs }?: {
        timeoutMs?: number;
    }): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /** 暗号化なしで item+data を送る (login 等のハンドシェイク用低レベル)。 */
    _sendPlain(frame: any): void;
    /** CCM 暗号化して送る (encCount++)。 */
    _sendCipher(frame: any): void;
    _dequeue(itemCode: any, entry: any): void;
    _onPacket(packet: any): void;
    _handleInitial(token: any): void;
    _handleLoginResponse(resultCode: any): void;
    _resolvePending(itemCode: any, resultCode: any, payload: any): void;
}
/**
 * BLE 無線 I/O アダプタ (transport.js のアダプタが満たす契約)。
 */
export type BleTransport = {
    /**
     * 接続+notify購読。各 notify を onPacket へ。
     */
    connect: (onPacket: (packet: Buffer) => void) => Promise<void>;
    /**
     * Write Without Response。
     */
    write: (bytes: Buffer) => void | Promise<void>;
    /**
     * 切断。
     */
    disconnect: () => void | Promise<void>;
};
import { Buffer } from "node:buffer";
import { SegmentAssembler } from "./protocol.js";
//# sourceMappingURL=session.d.ts.map