export { makeLocalRegisterServer } from "../../crypto.js";
export * as protocol from "./protocol.js";
export { SesameOS2BleCipher } from "./cipher.js";
/**
 * 登録済み OS2 SESAME を BLE で直接操作する高レベルファサード。
 * 操作の対応関係は SDK の各 OS2 デバイスクラスに準拠:
 *   - SESAME2/3/4 : lock / unlock / toggle / autolock / history
 *   - Bot1        : click (lock/unlock も内部的に同 motor 動作だが SDK は click を主とする)
 *   - Bike1       : unlock のみ (施錠は手動)
 */
/**
 * SesameOS2Ble のコンストラクタ opts。
 * @typedef {object} SesameOS2BleOptions
 * @property {string|Buffer} [secretKey] ロック共通鍵 (16B / 32hex)。login 必須、register モードでは不要。
 * @property {string|Buffer} [keyIndex] userIdx (sesame2KeyData.keyIndex)。login の signPayload に使う。既定 "0000" (CHSesame2Device.kt:465 の登録時永続値)。
 * @property {string|Buffer} [ssmPublicKey] デバイス公開鍵 (64B, sesame2KeyData.sesame2PublicKey)。login の ECDH 相手。
 * @property {string} [deviceUUID]
 * @property {string|null} [model] "sesame_2" / "sesame_3" / "sesame_4" / "ssmbot_1" / "bike_1"。
 * @property {boolean} [registerMode] 工場出荷デバイスの register() 用。
 * @property {Function|null} [registerServer] register() のサーバ登録コールバック (myDevicesRegisterSesame2Post 相当)。
 * @property {boolean} [localServerAuth] true で registerServer をローカル getRegisterKey から自動生成 (makeLocalRegisterServer)。registerServer 明示指定時はそちらを優先。UNVERIFIED。
 * @property {boolean} [needAuthFromServer] ゲスト鍵等: connect 時に signLogin でサーバ署名 sessionAuth を取得。
 * @property {((signPayloadHex:string)=>Promise<string>)|null} [signLogin] needAuthFromServer の署名コールバック。
 * @property {boolean} [debug]
 * @property {import("../session.js").BleTransport} [transport] BLE トランスポート (OS3 と共通の transport.js を注入)。実行時必須 (未指定はコンストラクタが throw)。
 */
export class SesameOS2Ble {
    /**
     * connect → fn → close を自動で行うヘルパー。
     * @param {SesameOS2BleOptions} opts コンストラクタ opts
     * @param {(lock:SesameOS2Ble)=>Promise<any>} fn
     */
    static use(opts: SesameOS2BleOptions, fn: (lock: SesameOS2Ble) => Promise<any>): Promise<any>;
    /**
     * 工場出荷デバイスを connect → register → close まで自動化する。
     * @param {SesameOS2BleOptions & {productType?:(string|number), ak?:Buffer}} opts コンストラクタ opts (registerServer 必須)
     * @param {(result:object)=>Promise<any>} [fn] 登録結果コールバック (鍵の保存など)
     * @returns {Promise<object>} 登録結果
     */
    static registerOnce(opts?: SesameOS2BleOptions & {
        productType?: (string | number);
        ak?: Buffer;
    }, fn?: (result: object) => Promise<any>): Promise<object>;
    /**
     * @param {SesameOS2BleOptions} [opts]
     */
    constructor(opts?: SesameOS2BleOptions);
    get model(): string | null;
    get isConnected(): boolean;
    get lastStatus(): any;
    /**
     * login response (systemTime / fwVersion / historyCnt / mechSetting / mechSettingBot /
     * mechSettingBytes / isConfigured / mechStatus)。BLE2-07 で mechSetting は解析済みオブジェクト
     * (Sesame2: {lockPosition, unlockPosition, isConfigured} — 度数、CHSesame2.kt:24-28 /
     * Bot1 は mechSettingBot の 7 フィールド — CHSesameBikeDevice.kt:520)。
     * `loginInfo.isConfigured === false` は角度未キャリブレーション (SDK の NoSettings 状態、
     * CHSesame2Device.kt:268)。
     */
    get loginInfo(): {
        systemTime: number;
        fwVersion: number;
        historyCnt: number;
        mechSetting: ReturnType<typeof import("./protocol.js").parseMechSettingSesame2>;
        mechSettingBot: ReturnType<typeof import("./protocol.js").parseMechSettingBot>;
        mechSettingBytes: Buffer;
        isConfigured: boolean;
        mechStatus: object;
    } | null;
    /** @param {(status:any)=>void} fn */
    onStatus(fn: (status: any) => void): () => boolean;
    /**
     * 接続 + login。needAuthFromServer=true のときは signLogin 経由でサーバ署名 sessionAuth を使う。
     */
    connect(): Promise<this>;
    close(): Promise<void>;
    /**
     * 工場出荷 (未登録) デバイスの登録 (ECDH + サーバ認証)。registerMode:true で構築した場合に呼ぶ。
     * 戻り値の {secretKey(=ownerKey hex), keyIndex("0000"), sesamePublicKey} はそのまま次回 login の
     * コンストラクタ {secretKey, keyIndex, ssmPublicKey} に渡せる (CHSesame2Device.kt:462-469 の
     * CHDevice 永続化フィールドと同じ契約)。
     * @param {{deviceUUID?:string, productType?:(string|number), ak?:Buffer}} [opts]
     * @returns {Promise<{deviceUUID:string, secretKey:string, keyIndex:string, ownerKey:string,
     *                    ecdhSecret:string, sesamePublicKey:string, serverSecret:string}>}
     */
    register({ deviceUUID, productType, ak }?: {
        deviceUUID?: string;
        productType?: (string | number);
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
    /**
     * 施錠 (OP.async, item=82)。SESAME2/3/4。tag は履歴に残す任意バイト列。
     * data = createHistag(tag) の **22B 固定** (CHSesame2Device.kt:185: SSM2OpCode.async, lock,
     * sesame2KeyData.createHistag(historytag) / Bot は CHSesameBotDevice.kt:370)。
     * @param {Buffer|Uint8Array} [tag]
     */
    lock(tag?: Buffer | Uint8Array): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * 解錠 (OP.async, item=83)。SESAME2/3/4 と Bike1。data = createHistag(tag) 22B
     * (CHSesame2Device.kt:201 / Bot CHSesameBotDevice.kt:387 / Bike CHSesameBikeDevice.kt:311)。
     * @param {Buffer|Uint8Array} [tag]
     */
    unlock(tag?: Buffer | Uint8Array): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * SESAME Bot1 のクリック (OP.async, item=89)。data = createHistag(tag) 22B
     * (CHSesameBotDevice.kt:408)。
     * @param {Buffer|Uint8Array} [tag]
     */
    click(tag?: Buffer | Uint8Array): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * トグル (SESAME2/3/4)。直近の mechStatus が無ければ status() を取得してから判定。
     * locked → unlock、それ以外 → lock (CHSesame2Device.kt:165-178 / 172-176)。
     * @param {Buffer|Uint8Array} [tag]
     */
    toggle(tag?: Buffer | Uint8Array): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * オートロック設定 (OP.update, item=11、2byte LE 秒数 ++ createHistag(tag) = 24B。0=無効。
     * CHSesame2Device.kt:141)。SESAME2/3/4。
     * **BLE 経由なら実機に反映される** (クラウドの biz3TriggerLocker では ack のみで未反映だった機能)。
     * @param {number} seconds 0..65535
     * @param {Buffer|Uint8Array} [tag]
     */
    autolock(seconds: number, tag?: Buffer | Uint8Array): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /** オートロック無効化 (= autolock(0))。CHSesame2Device.kt:150-152。 @param {Buffer|Uint8Array} [tag] */
    disableAutolock(tag?: Buffer | Uint8Array): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * 現在のオートロック秒数を取得 (OP.read, item=11)。応答 payload は LE 秒数 (CHSesame2Device.kt:157-160)。
     * @returns {Promise<number>}
     */
    getAutolock(): Promise<number>;
    /**
     * versionTag を取得 (OP.read, item=5)。payload[4..15] が ASCII version 文字列 (CHSesame2Device.kt:131-133)。
     * @returns {Promise<string>}
     */
    versionTag(): Promise<string>;
    /**
     * 現在の mechStatus を返す。未受信なら publish を待つ (timeout 付き)。
     * @param {{timeoutMs?:number}} [opts]
     * @returns {Promise<object>} parseMechStatus の結果
     */
    status({ timeoutMs }?: {
        timeoutMs?: number;
    }): Promise<object>;
    /**
     * 履歴を 1 バッチ取得 (OP.read, item=4)。payload の解析は呼び出し側 (生バイト返し)。
     * SDK は isInternetAvailable() で 0x01/0x00 を切り替える (CHSesame2Device.kt:606-612)。
     * BLE 直接用途では既定 0x01 (取得後デバイス側で消す挙動) を送る。
     * @param {{ack?:boolean}} [opts] ack=false で 0x00 (消さずに読むだけ)
     * @returns {Promise<Buffer>}
     */
    history({ ack }?: {
        ack?: boolean;
    }): Promise<Buffer>;
    /** 工場出荷状態へリセット (OP.delete, item=registration)。CHSesame2Device.kt:570-578。 */
    reset(): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * SESAME2/3/4 の施錠/解錠角を設定する (OP.update, item=80=mechSetting)。
     * CHSesame2Device.kt:556-568 を 1:1 で移植。送信 data = lockPositionConfiguration(deg) ++ createHistag(null)
     * (12B 角設定 ++ 22B 履歴タグ枠 = 34B)。引数は度数で、内部で tick (deg*1024/360) と ±150 range に変換する。
     * @param {number} lockDeg   施錠角 (度)
     * @param {number} unlockDeg 解錠角 (度)
     * @returns {Promise<{resultCode:number, payload:Buffer}>}
     */
    configureLockPosition(lockDeg: number, unlockDeg: number): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * 初代 SESAME Bot の mech_setting を更新する (OP.update, item=80=mechSetting)。
     * CHSesameBotDevice.kt:418-430 を 1:1 で移植。送信 data = setting.data() ++ createHistag(tag)
     * (12B 設定 ++ 22B 履歴タグ枠 = 34B)。Bot 以外では呼ばない (SDK は CHSesameBot 専用)。
     * @param {{userPrefDir:number, lockSec:number, unlockSec:number, clickLockSec:number,
     *          clickHoldSec:number, clickUnlockSec:number, buttonMode:number}} setting
     * @param {Buffer} [tag] 履歴タグ
     * @returns {Promise<{resultCode:number, payload:Buffer}>}
     */
    updateSetting(setting: {
        userPrefDir: number;
        lockSec: number;
        unlockSec: number;
        clickLockSec: number;
        clickHoldSec: number;
        clickUnlockSec: number;
        buttonMode: number;
    }, tag?: Buffer): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * BLE DFU (ファームウェア更新) を開始する (OP.update, item=7=enableDFU、payload "01")。
     * CHSesame2Device.kt:580-599 を移植。login 済みデバイスを前提とし暗号化経路で開始コマンドを送る
     * (SDK の isRegistered=true 経路、:584)。未登録時の平文経路 (:592) はこのファサードの対象外。
     *
     * ★本メソッドは **DFU 開始コマンドの送信のみ** を行う。開始後デバイスは DFU ブートローダへ
     *   遷移し切断される想定で、本体ファーム (Nordic DFU 等の OTA バイナリ) の転送は
     *   別 GATT サービスを扱う外部 DFU 層の責務。実機での DFU 完遂は未検証。
     * @returns {Promise<{resultCode:number, payload:Buffer}>}
     */
    updateFirmware(): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
}
/**
 * SesameOS2Ble のコンストラクタ opts。
 */
export type SesameOS2BleOptions = {
    /**
     * ロック共通鍵 (16B / 32hex)。login 必須、register モードでは不要。
     */
    secretKey?: string | Buffer<ArrayBufferLike> | undefined;
    /**
     * userIdx (sesame2KeyData.keyIndex)。login の signPayload に使う。既定 "0000" (CHSesame2Device.kt:465 の登録時永続値)。
     */
    keyIndex?: string | Buffer<ArrayBufferLike> | undefined;
    /**
     * デバイス公開鍵 (64B, sesame2KeyData.sesame2PublicKey)。login の ECDH 相手。
     */
    ssmPublicKey?: string | Buffer<ArrayBufferLike> | undefined;
    deviceUUID?: string | undefined;
    /**
     * "sesame_2" / "sesame_3" / "sesame_4" / "ssmbot_1" / "bike_1"。
     */
    model?: string | null | undefined;
    /**
     * 工場出荷デバイスの register() 用。
     */
    registerMode?: boolean | undefined;
    /**
     * register() のサーバ登録コールバック (myDevicesRegisterSesame2Post 相当)。
     */
    registerServer?: Function | null | undefined;
    /**
     * true で registerServer をローカル getRegisterKey から自動生成 (makeLocalRegisterServer)。registerServer 明示指定時はそちらを優先。UNVERIFIED。
     */
    localServerAuth?: boolean | undefined;
    /**
     * ゲスト鍵等: connect 時に signLogin でサーバ署名 sessionAuth を取得。
     */
    needAuthFromServer?: boolean | undefined;
    /**
     * needAuthFromServer の署名コールバック。
     */
    signLogin?: ((signPayloadHex: string) => Promise<string>) | null | undefined;
    debug?: boolean | undefined;
    /**
     * BLE トランスポート (OS3 と共通の transport.js を注入)。実行時必須 (未指定はコンストラクタが throw)。
     */
    transport?: import("../session.js").BleTransport | undefined;
};
import { Buffer } from "node:buffer";
export { SesameOS2BleSession, BleResultError } from "./session.js";
export { RESULT as SESAME_RESULT_CODES, resultName, OP, ITEM, MECH_STATE } from "./protocol.js";
//# sourceMappingURL=index.d.ts.map