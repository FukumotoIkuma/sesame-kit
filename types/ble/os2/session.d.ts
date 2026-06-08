/**
 * OS2 デバイスが非 0 の resultCode を返したときのエラー。
 * resultName (notFound/busy/invalidSig…) で機械的に分岐できる (SesameResultCode 由来)。
 */
export class BleResultError extends Error {
    /** @param {"login"|"command"|"registration"} phase @param {number} resultCode @param {number|null} itemCode */
    constructor(phase: "login" | "command" | "registration", resultCode: number, itemCode?: number | null);
    resultCode: number;
    resultName: any;
    itemCode: number;
}
/**
 * @typedef {object} BleTransport BLE 無線 I/O アダプタ (transport.js のアダプタが満たす契約)。
 * @property {(onPacket:(packet:Buffer)=>void, onDisconnect?:(reason:any)=>void)=>Promise<void>} connect
 *   接続+notify購読。各 notify を onPacket へ。リンク断 (相手側切断/圏外/write 失敗) で onDisconnect(reason) を 1 回呼ぶ。
 * @property {(bytes:Buffer)=>void|Promise<void>} write Write Without Response。
 * @property {()=>void|Promise<void>} disconnect 切断。
 */
export class SesameOS2BleSession {
    /**
     * @param {{
     *   transport: BleTransport,
     *   secretKey?: string|Buffer,        // 16B ロック共通鍵 (登録済みデバイスの login に必須)
     *   keyIndex?: string|Buffer,         // userIdx (sesame2KeyData.keyIndex)。login の signPayload に使う
     *   ssmPublicKey?: string|Buffer,     // デバイス公開鍵 64B (sesame2KeyData.sesame2PublicKey)。login の ECDH 相手
     *   debug?: boolean,
     *   defaultTimeoutMs?: number,
     * }} opts
     *   secretKey/keyIndex/ssmPublicKey は **登録済みデバイスの login 時のみ必須**。
     *   工場出荷 (未登録) デバイスを register() で登録する場合は secretKey を渡さずに構築する
     *   (initial 受信で login を試みず ReadyToRegister 状態へ遷移)。
     *
     *   注: 自動再接続はしない (OS3 session と同じ方針)。リンク断は _handleTransportDisconnect で
     *   pending/待機者を fail-fast するだけなので、再接続したい場合は呼び出し側が新しいインスタンスを
     *   構築し直す (使い捨てセッション)。
     */
    constructor({ transport, secretKey, keyIndex, ssmPublicKey, debug, defaultTimeoutMs }: {
        transport: BleTransport;
        secretKey?: string | Buffer;
        keyIndex?: string | Buffer;
        ssmPublicKey?: string | Buffer;
        debug?: boolean;
        defaultTimeoutMs?: number;
    });
    _transport: BleTransport;
    _secretKey: Buffer<ArrayBufferLike>;
    _keyIndex: Buffer<ArrayBufferLike>;
    _ssmPublicKey: Buffer<ArrayBufferLike>;
    _debug: boolean;
    _defaultTimeoutMs: number;
    _asm: SegmentAssembler;
    _mAppToken: NonSharedBuffer;
    _mSesameToken: Buffer<any>;
    _loginKeyPair: import("node:crypto").ECDH;
    _sessionToken: Buffer<ArrayBufferLike>;
    _cipher: SesameOS2BleCipher;
    _loggedIn: boolean;
    _readyToRegister: boolean;
    _readyWaiter: {
        resolve: (value: any) => void;
        reject: (reason?: any) => void;
        timer: NodeJS.Timeout;
    };
    _registerWaiter: {
        resolve: (value: any) => void;
        reject: (reason?: any) => void;
        timer: NodeJS.Timeout;
    };
    _loginWaiter: {
        resolve: (value: any) => void;
        reject: (reason?: any) => void;
        timer: NodeJS.Timeout;
    };
    /** @type {Map<number, Array<{resolve:Function, reject:Function, timer:any}>>} item → FIFO */
    _pending: Map<number, Array<{
        resolve: Function;
        reject: Function;
        timer: any;
    }>>;
    _statusListeners: Set<any>;
    _publishListeners: Set<any>;
    _lastStatus: any;
    _lastLoginResponse: {
        systemTime: number;
        fwVersion: number;
        historyCnt: number;
        mechSetting: Buffer;
        mechStatus: object;
    };
    _signLogin: (signPayloadHex: string) => Promise<string>;
    _registerServer: (req: {
        deviceUUID: string;
        ak: Buffer;
        mSesameToken: Buffer;
        ER: string;
        productType: (string | number | undefined);
        appPubK64: Buffer;
        appPubK64Base64: string;
    }) => Promise<{
        sig1: (string | Buffer);
        serverToken: (string | Buffer);
        sesamePublicKey: (string | Buffer);
    }>;
    _regKeyPair: import("node:crypto").ECDH;
    _log(...a: any[]): void;
    _isBusy(): boolean;
    get lastStatus(): any;
    get lastLoginResponse(): {
        systemTime: number;
        fwVersion: number;
        historyCnt: number;
        mechSetting: Buffer;
        mechStatus: object;
    };
    get isLoggedIn(): boolean;
    get isReadyToRegister(): boolean;
    onStatus(fn: any): () => boolean;
    onPublish(fn: any): () => boolean;
    /**
     * 接続して login まで完了させる (登録済みデバイス用)。secretKey/keyIndex/ssmPublicKey 必須。
     *
     * 通常 login (既定): sessionAuth = CMAC(secretKey, userIdx ++ appPubKey64 ++ sessionToken)
     *   をローカル計算 (CHSesame2Device.kt:243)。
     * サーバ認証 login (signLogin 指定時): signPayload (= userIdx ++ appPubKey64 ++ sessionToken) の
     *   hex を signLogin に渡し、サーバ署名済み sessionAuth (hex) を取得して使う
     *   (CHSesame2Device.kt:240,526-530)。
     *
     * @param {{signLogin?:(signPayloadHex:string)=>Promise<string>}} [opts]
     * @returns {Promise<void>} login 成功で resolve
     */
    connect({ signLogin }?: {
        signLogin?: (signPayloadHex: string) => Promise<string>;
    }): Promise<void>;
    /**
     * 工場出荷 (未登録) デバイスの登録ハンドシェイク (CHSesame2Device.kt:406-482)。
     * secretKey を渡さずに構築した session で呼ぶ。
     *
     * フロー:
     *   1. transport 接続 → initial(14) publish を待つ (secretKey 無し → ReadyToRegister)。
     *   2. READ IRER を PLAINTEXT 送出し、応答 payload から ER = payload.drop(16) を取り出す。
     *   3. registerServer({ deviceUUID, ak, mSesameToken, ER, productType }) を呼び、
     *      サーバから { sig1, serverToken(st), sesamePublicKey(pubkey) } を得る。
     *   4. ECDH(sesamePublicKey) → pre16。
     *   5. registerKey/ownerKey/sessionKey = deriveRegisterKeys(pre16, serverToken, mSesameToken)。
     *      cipher = (sessionKey, sessionToken)。
     *   6. payload = sig1[0:4] ++ appPubKey64 ++ serverToken、CREATE REGISTRATION を PLAINTEXT 送出。
     *   7. login publish (登録完了) を待ち、{deviceUUID, secretKey(=pre16 hex), ownerKey, sesamePublicKey} を返す。
     *
     * @param {{deviceUUID:string, productType?:(string|number),
     *          registerServer:(req:{deviceUUID:string, ak:Buffer, mSesameToken:Buffer, ER:string,
     *                                productType:(string|number|undefined),
     *                                appPubK64:Buffer, appPubK64Base64:string})=>Promise<{sig1:(string|Buffer),
     *                                serverToken:(string|Buffer), sesamePublicKey:(string|Buffer)}>,
     *          ak?:Buffer}} opts
     *   registerServer: myDevicesRegisterSesame2Post に相当する注入関数。base64/hex/Buffer いずれの
     *     戻りも受ける (内部で Buffer 化)。req には session が生成した app の登録用 ECDH 公開鍵
     *     (appPubK64 / その base64 appPubK64Base64) も載る。CHSesame2Device.kt は getRegisterKey の
     *     ak に EccKey.getRegisterAK() = base64(app 公開鍵) を使うため、ローカル実装
     *     (crypto.js makeLocalRegisterServer) はこの appPubK64 を ak に採用する。本番のサーバ実装は
     *     ak フィールド (または appPubK64) を使う/無視するを選べる。ak は EccKey.getRegisterAK() 相当
     *     (省略時は appPubK64 をローカル registerServer が使う)。
     * @returns {Promise<{deviceUUID:string, secretKey:string, ownerKey:string,
     *                    sesamePublicKey:string, serverSecret:string}>}
     */
    register({ deviceUUID, productType, registerServer, ak }?: {
        deviceUUID: string;
        productType?: (string | number);
        registerServer: (req: {
            deviceUUID: string;
            ak: Buffer;
            mSesameToken: Buffer;
            ER: string;
            productType: (string | number | undefined);
            appPubK64: Buffer;
            appPubK64Base64: string;
        }) => Promise<{
            sig1: (string | Buffer);
            serverToken: (string | Buffer);
            sesamePublicKey: (string | Buffer);
        }>;
        ak?: Buffer;
    }): Promise<{
        deviceUUID: string;
        secretKey: string;
        ownerKey: string;
        sesamePublicKey: string;
        serverSecret: string;
    }>;
    /** Node getPublicKey() (65B) から SDK 契約の 64B raw (prefix 無し) を取り出す。 */
    _appPubK64(keyPair: any): any;
    _rejectWaiter(field: any, err: any): void;
    /**
     * pending request と 3 待機者 (login/ready/register) を全て reject + timer clear し、
     * セッション状態フラグを倒す。能動 disconnect() と、transport からの非同期切断通知
     * (_handleTransportDisconnect) の両方が共有する内部解放処理 (transport.disconnect() は呼ばない)。
     * OS3 session._failAllPending と対称。
     * @param {Error} err pending/待機者へ渡す reject 理由
     */
    _failAllPending(err: Error): void;
    /**
     * transport を onPacket / onDisconnect 配線付きで接続する (connect()/register() 共通)。
     * onDisconnect: リンク断 (相手側切断 / 圏外 / write リトライ枯渇) で pending/待機者を即 reject し、
     * OS3 session 同様 timeout 宙づりを防ぐ (fail-fast)。transport が 2 引数 connect 非対応でも安全。
     */
    _connectTransport(): Promise<void>;
    /**
     * transport から「リンクが切れた」と通知されたときのハンドラ (transport.connect の onDisconnect)。
     * OS3 session._handleTransportDisconnect と同様、pending/待機者を即 reject して **timeout 宙づりを
     * 防ぐ** (fail-fast)。能動 disconnect() と異なり transport.disconnect() は呼ばない (既に切断済み・
     * 自分が起点ではないため)。何度呼ばれても安全 (待機者・pending が無ければ no-op)。
     * @param {any} reason 切断理由 (noble の reason 文字列等)
     */
    _handleTransportDisconnect(reason: any): void;
    disconnect(): Promise<void>;
    /**
     * 暗号化コマンドを送り、response(7)+item を待って返す。
     * OS2 はフレームに opCode を含むため (lock/unlock/click は async、read/update は対応 opCode)、
     * opCode を明示的に渡す。
     * @param {number} opCode OP.* (lock/unlock/click は OP.ASYNC、autolock は OP.UPDATE 等)
     * @param {number} itemCode ITEM.*
     * @param {Buffer} [data]
     * @param {{timeoutMs?:number}} [opts]
     * @returns {Promise<{resultCode:number, payload:Buffer}>}
     */
    request(opCode: number, itemCode: number, data?: Buffer, { timeoutMs }?: {
        timeoutMs?: number;
    }): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /** PLAINTEXT で送り、response(7)+item を待つ (register の IRER 読み出し等)。 */
    _requestPlain(opCode: any, itemCode: any, data: any, timeoutMs: any): Promise<any>;
    /** 暗号化なしで送る (login / registration / IRER 等のハンドシェイク用)。 */
    _sendPlain(frame: any): void;
    /** OS2 CCM 暗号化して送る (cipher 内部で encCount++)。 */
    _sendCipher(frame: any): void;
    _dequeue(itemCode: any, entry: any): void;
    _onPacket(packet: any): void;
    _handleInitial(token: any): void;
    /** login ハンドシェイク本体 (CHSesame2Device.kt:231-255)。signLogin 指定時は非同期で sessionAuth を取得。 */
    _startLogin(): void;
    _loginViaServer(signPayload: any, appPubK64: any): Promise<void>;
    /** login(2) を SYNC opCode で PLAINTEXT 送る (CHSesame2Device.kt:254-255)。 */
    _sendLogin(appPubK64: any, auth16: any): void;
    _handleLoginResponse(resultCode: any, payload: any): void;
    /** 登録直後はデバイスが response ではなく login **publish** で完了を知らせる (CHSesame2Device.kt:508-517)。 */
    _handleLoginPublish(payload: any): void;
    /** login response の systemTime と現在時刻の差が大きければ timePhone を送る (CHSesame2Device.kt:259-264)。 */
    _maybeSyncTime(): void;
    _resolveWaiter(field: any, value: any): void;
    _resolvePending(itemCode: any, resultCode: any, payload: any): void;
}
/**
 * BLE 無線 I/O アダプタ (transport.js のアダプタが満たす契約)。
 */
export type BleTransport = {
    /**
     *   接続+notify購読。各 notify を onPacket へ。リンク断 (相手側切断/圏外/write 失敗) で onDisconnect(reason) を 1 回呼ぶ。
     */
    connect: (onPacket: (packet: Buffer) => void, onDisconnect?: (reason: any) => void) => Promise<void>;
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
import { SesameOS2BleCipher } from "./cipher.js";
//# sourceMappingURL=session.d.ts.map