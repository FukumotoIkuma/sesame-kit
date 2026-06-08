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
export class SesameOS2Ble {
    /**
     * connect → fn → close を自動で行うヘルパー。
     * @param {object} opts コンストラクタ opts
     * @param {(lock:SesameOS2Ble)=>Promise<any>} fn
     */
    static use(opts: object, fn: (lock: SesameOS2Ble) => Promise<any>): Promise<any>;
    /**
     * 工場出荷デバイスを connect → register → close まで自動化する。
     * @param {object} opts コンストラクタ opts (registerServer 必須)
     * @param {(result:object)=>Promise<any>} [fn] 登録結果コールバック (鍵の保存など)
     * @returns {Promise<object>} 登録結果
     */
    static registerOnce(opts?: object, fn?: (result: object) => Promise<any>): Promise<object>;
    /**
     * @param {{
     *   secretKey?: string|Buffer,   // 16B / 32hex ロック共通鍵 (login 必須、register モードでは不要)
     *   keyIndex?: string|Buffer,    // userIdx (sesame2KeyData.keyIndex)。login の signPayload に使う
     *   ssmPublicKey?: string|Buffer,// デバイス公開鍵 64B (sesame2KeyData.sesame2PublicKey)。login の ECDH 相手
     *   deviceUUID?: string,
     *   model?: string,              // "sesame_2" / "sesame_3" / "sesame_4" / "ssmbot_1" / "bike_1"
     *   registerMode?: boolean,      // 工場出荷デバイスの register() 用
     *   registerServer?: Function,   // register() のサーバ登録コールバック (myDevicesRegisterSesame2Post 相当)
     *   localServerAuth?: boolean,   // true で registerServer をローカル getRegisterKey から自動生成
     *                                //   (makeLocalRegisterServer)。クラウド不要のオフライン server-auth register。
     *                                //   registerServer 明示指定時はそちらを優先 (この自動生成は使わない)。
     *                                //   ★UNVERIFIED: getRegisterKey の移植忠実性は未確定 (crypto.js 注記参照)。
     *   needAuthFromServer?: boolean,// ゲスト鍵等: connect 時に signLogin でサーバ署名 sessionAuth を取得
     *   signLogin?: (signPayloadHex:string)=>Promise<string>, // needAuthFromServer の署名コールバック
     *   debug?: boolean,
     *   transport: object,           // BLE トランスポート (OS3 と共通の transport.js を注入)
     * }} opts
     */
    constructor({ secretKey, keyIndex, ssmPublicKey, deviceUUID, model, registerMode, registerServer, localServerAuth, needAuthFromServer, signLogin, debug, transport, }?: {
        secretKey?: string | Buffer;
        keyIndex?: string | Buffer;
        ssmPublicKey?: string | Buffer;
        deviceUUID?: string;
        model?: string;
        registerMode?: boolean;
        registerServer?: Function;
        localServerAuth?: boolean;
    });
    _transport: any;
    _session: SesameOS2BleSession;
    _model: string;
    _deviceUUID: string;
    _registerMode: boolean;
    _registerServer: Function;
    _needAuthFromServer: boolean;
    _signLogin: any;
    _debug: any;
    get model(): string;
    get isConnected(): boolean;
    get lastStatus(): any;
    /** login response (systemTime / fwVersion / historyCnt / mechSetting / mechStatus)。 */
    get loginInfo(): {
        systemTime: number;
        fwVersion: number;
        historyCnt: number;
        mechSetting: Buffer;
        mechStatus: object;
    };
    onStatus(fn: any): () => boolean;
    /**
     * 接続 + login。needAuthFromServer=true のときは signLogin 経由でサーバ署名 sessionAuth を使う。
     */
    connect(): Promise<this>;
    close(): Promise<void>;
    /**
     * 工場出荷 (未登録) デバイスの登録 (ECDH + サーバ認証)。registerMode:true で構築した場合に呼ぶ。
     * @param {{deviceUUID?:string, productType?:(string|number), ak?:Buffer}} [opts]
     * @returns {Promise<{deviceUUID:string, secretKey:string, ownerKey:string, sesamePublicKey:string, serverSecret:string}>}
     */
    register({ deviceUUID, productType, ak }?: {
        deviceUUID?: string;
        productType?: (string | number);
        ak?: Buffer;
    }): Promise<{
        deviceUUID: string;
        secretKey: string;
        ownerKey: string;
        sesamePublicKey: string;
        serverSecret: string;
    }>;
    /** 施錠 (OP.async, item=82)。SESAME2/3/4。tag は履歴に残す任意バイト列。 */
    lock(tag: any): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /** 解錠 (OP.async, item=83)。SESAME2/3/4 と Bike1。 */
    unlock(tag: any): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /** SESAME Bot1 のクリック (OP.async, item=89)。 */
    click(tag: any): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * トグル (SESAME2/3/4)。直近の mechStatus が無ければ status() を取得してから判定。
     * locked → unlock、それ以外 → lock (CHSesame2Device.kt:165-178 / 172-176)。
     */
    toggle(tag: any): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * オートロック設定 (OP.update, item=11、2byte LE 秒数 ++ historyTag。0=無効)。SESAME2/3/4。
     * **BLE 経由なら実機に反映される** (クラウドの biz3TriggerLocker では ack のみで未反映だった機能)。
     * @param {number} seconds 0..65535
     * @param {Buffer} [tag]
     */
    autolock(seconds: number, tag?: Buffer): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /** オートロック無効化 (= autolock(0))。CHSesame2Device.kt:150-152。 */
    disableAutolock(tag: any): Promise<{
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
     *   遷移し切断される想定で、本体ファーム (Nordic DFU 等の OTA バイナリ) の転送は範囲外 (未実装)。
     *   実機での DFU 完遂は未検証。
     * @returns {Promise<{resultCode:number, payload:Buffer}>}
     */
    updateFirmware(): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
}
import { Buffer } from "node:buffer";
export { SesameOS2BleSession, BleResultError } from "./session.js";
export { RESULT as SESAME_RESULT_CODES, resultName, OP, ITEM, MECH_STATE } from "./protocol.js";
//# sourceMappingURL=index.d.ts.map