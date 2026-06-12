/**
 * OS2 デバイスが非 0 の resultCode を返したときのエラー。
 * resultName (notFound/busy/invalidSig…) で機械的に分岐できる (SesameResultCode 由来)。
 */
export class BleResultError extends Error {
    /** @param {"login"|"command"|"registration"} phase @param {number} resultCode @param {number|null} itemCode */
    constructor(phase: "login" | "command" | "registration", resultCode: number, itemCode?: number | null);
    resultCode: number;
    resultName: string;
    itemCode: number | null;
}
/**
 * @typedef {object} BleTransport BLE 無線 I/O アダプタ (transport.js のアダプタが満たす契約)。
 * @property {(onPacket:(packet:Buffer)=>void, onDisconnect?:(reason:any)=>void)=>Promise<void>} connect
 *   接続+notify購読。各 notify を onPacket へ。リンク断 (相手側切断/圏外/write 失敗) で onDisconnect(reason) を 1 回呼ぶ。
 * @property {(bytes:Buffer)=>void|Promise<void>} write Write Without Response。
 * @property {()=>void|Promise<void>} disconnect 切断。
 */
/**
 * @typedef {object} Os2Waiter ハンドシェイク待機者 (login/ready/register の Promise 制御)。
 * @property {(value?:any)=>void} resolve
 * @property {(err:Error)=>void} reject
 * @property {any} timer setTimeout ハンドル。
 */
export class SesameOS2BleSession {
    /**
     * @param {{
     *   transport: BleTransport,
     *   secretKey?: string|Buffer,        // 16B ロック共通鍵 (登録済みデバイスの login に必須)
     *   keyIndex?: string|Buffer,         // userIdx (sesame2KeyData.keyIndex)。login の signPayload に使う。既定 "0000" (2B)。空は明示エラー
     *   ssmPublicKey?: string|Buffer,     // デバイス公開鍵 64B (sesame2KeyData.sesame2PublicKey)。login の ECDH 相手
     *   model?: string|null,              // 機種識別子 ("ssmbot_1"/"bike_1" で timePhone 条件が変わる)
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
    constructor({ transport, secretKey, keyIndex, ssmPublicKey, model, debug, defaultTimeoutMs }: {
        transport: BleTransport;
        secretKey?: string | Buffer;
        keyIndex?: string | Buffer;
        ssmPublicKey?: string | Buffer;
        model?: string | null;
        debug?: boolean;
        defaultTimeoutMs?: number;
    });
    get lastStatus(): any;
    get lastLoginResponse(): {
        systemTime: number;
        fwVersion: number;
        historyCnt: number;
        mechSetting: ReturnType<typeof import("./protocol.js").parseMechSettingSesame2>;
        mechSettingBot: ReturnType<typeof import("./protocol.js").parseMechSettingBot>;
        mechSettingBytes: Buffer;
        isConfigured: boolean;
        mechStatus: object;
    } | null;
    get isLoggedIn(): boolean;
    get isReadyToRegister(): boolean;
    /** @param {(status:any)=>void} fn */
    onStatus(fn: (status: any) => void): () => boolean;
    /** @param {(pub:{itemCode:number, payload:Buffer})=>void} fn */
    onPublish(fn: (pub: {
        itemCode: number;
        payload: Buffer;
    }) => void): () => boolean;
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
     *   7. login publish (登録完了) を待ち、{deviceUUID, secretKey(=ownerKey hex), keyIndex("0000"),
     *      ecdhSecret(=pre16 hex), ownerKey, sesamePublicKey} を返す。
     *      SDK が登録完了時に永続化するのは keyIndex="0000" / secretKey=ownerKey.toHexString()
     *      (CHSesame2Device.kt:462-469 CHDevice(..., "0000", ownerKey.toHexString(), ...)) であり、
     *      次回 login の CMAC(secretKey, ...) も ownerKey を使う (CHSesame2Device.kt:233-252)。
     *
     * @param {{deviceUUID?:string, productType?:(string|number),
     *          registerServer?:(req:{deviceUUID:string, ak:(Buffer|undefined), mSesameToken:Buffer, ER:string,
     *                                productType:(string|number|undefined),
     *                                appPubK64:Buffer, appPubK64Base64:string})=>Promise<{sig1:(string|Buffer),
     *                                serverToken?:(string|Buffer), st?:(string|Buffer),
     *                                sesamePublicKey?:(string|Buffer), pubkey?:(string|Buffer)}>,
     *          ak?:Buffer}} [opts]
     *   registerServer: myDevicesRegisterSesame2Post に相当する注入関数。base64/hex/Buffer いずれの
     *     戻りも受ける (内部で Buffer 化)。req には session が生成した app の登録用 ECDH 公開鍵
     *     (appPubK64 / その base64 appPubK64Base64) も載る。CHSesame2Device.kt は getRegisterKey の
     *     ak に EccKey.getRegisterAK() = base64(app 公開鍵) を使うため、ローカル実装
     *     (crypto.js makeLocalRegisterServer) はこの appPubK64 を ak に採用する。本番のサーバ実装は
     *     ak フィールド (または appPubK64) を使う/無視するを選べる。ak は EccKey.getRegisterAK() 相当
     *     (省略時は appPubK64 をローカル registerServer が使う)。
     * @returns {Promise<{deviceUUID:string, secretKey:string, keyIndex:string, ownerKey:string,
     *                    ecdhSecret:string, sesamePublicKey:string, serverSecret:string}>}
     *   secretKey は **ownerKey の hex** (次回 login にそのまま使う鍵)。ecdhSecret は ECDH pre16 の
     *   hex (登録ハンドシェイク中間値。login には使えない — CMAC(pre16,…) は invalidSig になる)。
     */
    register({ deviceUUID, productType, registerServer, ak }?: {
        deviceUUID?: string;
        productType?: (string | number);
        registerServer?: (req: {
            deviceUUID: string;
            ak: (Buffer | undefined);
            mSesameToken: Buffer;
            ER: string;
            productType: (string | number | undefined);
            appPubK64: Buffer;
            appPubK64Base64: string;
        }) => Promise<{
            sig1: (string | Buffer);
            serverToken?: (string | Buffer);
            st?: (string | Buffer);
            sesamePublicKey?: (string | Buffer);
            pubkey?: (string | Buffer);
        }>;
        ak?: Buffer;
    }): Promise<{
        deviceUUID: string;
        secretKey: string;
        keyIndex: string;
        ownerKey: string;
        ecdhSecret: string;
        sesamePublicKey: string;
        serverSecret: string;
    }>;
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
/**
 * ハンドシェイク待機者 (login/ready/register の Promise 制御)。
 */
export type Os2Waiter = {
    resolve: (value?: any) => void;
    reject: (err: Error) => void;
    /**
     * setTimeout ハンドル。
     */
    timer: any;
};
import { Buffer } from "node:buffer";
import { SegmentAssembler } from "./protocol.js";
import { SesameOS2BleCipher } from "./cipher.js";
//# sourceMappingURL=session.d.ts.map