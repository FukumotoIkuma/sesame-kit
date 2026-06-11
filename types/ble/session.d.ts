/**
 * BLE デバイスが非 0 の resultCode を返したときのエラー。
 * `resultName` (notFound/busy/invalidSig…) で機械的に分岐できる (SesameResultCode 由来)。
 */
export class BleResultError extends Error {
    /** @param {"login"|"command"} phase @param {number} resultCode @param {number|null} itemCode */
    constructor(phase: "login" | "command", resultCode: number, itemCode?: number | null);
    resultCode: number;
    resultName: string;
    itemCode: number | null;
}
/**
 * @typedef {object} BleTransport BLE 無線 I/O アダプタ (transport.js のアダプタが満たす契約)。
 * @property {(onPacket:(packet:Buffer)=>void, onDisconnect?:(reason:any)=>void)=>Promise<void>} connect
 *   接続+notify購読。各 notify を onPacket へ。リンク断時は onDisconnect(reason) を 1 回呼ぶ (任意)。
 * @property {(bytes:Buffer)=>void|Promise<void>} write Write Without Response。
 * @property {()=>void|Promise<void>} disconnect 切断。
 */
/**
 * @typedef {object} Waiter ハンドシェイク待機者 (login/ready/register の Promise 制御)。
 * @property {(value?:any)=>void} resolve
 * @property {(err:Error)=>void} reject
 * @property {any} timer setTimeout ハンドル。
 */
export class SesameBleSession {
    /**
     * @param {{transport:BleTransport, secretKey?:string|Buffer, debug?:boolean,
     *          defaultTimeoutMs?:number, profile?:("lock"|"wm2"), syncTime?:boolean}} opts
     *   secretKey は **登録済みデバイスへのログイン時のみ必須**。工場出荷 (未登録) デバイスを
     *   register() で登録する場合は secretKey を渡さずに構築する (initial 受信で login を試みず
     *   ReadyToRegister 状態へ遷移する。CHSesameOS3.kt:468-491 isRegistered=false 相当)。
     *
     *   profile はセッション確立のワイヤ形状 (protocol.js SESSION_PROFILES):
     *     - "lock" (既定): CHSesameOS3 基底のロック系 (SESAME5/Hub3/Bot2/Bike2/3/biometric)。
     *     - "wm2": WifiModule2。CHWifiModule2Device.kt は initial(13)/login/register を
     *       オーバーライドしており非互換 (kt:279-321,521-528)。鍵 = secretKey/pre16 **生 16B**、
     *       login payload = CMAC 16B 全量、register data = pubK64 のみ、CCM sault = token4 (12B nonce)。
     *       @experimental WM2 profile は SDK Kotlin の静的読みからの移植で **実機未検証**
     *       (参照: CHWifiModule2Device.kt:279-321 / SesameOS3BleCipher.kt:8-32)。
     *
     *   syncTime (既定 true): login 成功後の time(8) 自動同期を行うか (BLE3-03)。
     *     CHSesameOS3LockBase.kt:126-138 handleLoginResponse の時刻同期は **ロック系のみ** の挙動で、
     *     Hub3 は login を override して handleLoginResponse を呼ばない (CHHub3Device.kt:167-178 —
     *     login 応答はコールバックで deviceStatus 遷移のみ)。WM2 も同様 (CHWifiModule2Device.kt:314-321。
     *     こちらは profile="wm2" で構造的に対象外)。ファサード (index.js) は kind が HUB3/WIFI の
     *     とき false を渡す。
     */
    constructor({ transport, secretKey, debug, defaultTimeoutMs, profile, syncTime }: {
        transport: BleTransport;
        secretKey?: string | Buffer;
        debug?: boolean;
        defaultTimeoutMs?: number;
        profile?: ("lock" | "wm2");
        syncTime?: boolean;
    });
    /** 最後に受信した mechStatus (parseMechStatus の結果)。未受信なら null。 */
    get lastStatus(): any;
    /** 最後に受信した mechSetting (parseMechSetting の結果)。未受信なら null。 */
    get lastMechSetting(): {
        lockPosition: number;
        unlockPosition: number;
        autoLockSecond: number;
    } | null;
    /** 最後に受信した opsSetting (parseOpsSetting の結果)。未受信なら null。 */
    get lastOpsSetting(): {
        opsLockSecond: number;
    } | null;
    get isLoggedIn(): boolean;
    /** initial(14) を受信したが secretKey 未設定で login を試みていない状態 (register 待ち)。 */
    get isReadyToRegister(): boolean;
    /** mechStatus publish を購読。戻り値 unsubscribe。 @param {(status:any)=>void} fn */
    onStatus(fn: (status: any) => void): () => boolean;
    /** 任意 publish を購読 ({opCode,itemCode,body})。戻り値 unsubscribe。 @param {(pub:{opCode:number, itemCode:number, body:Buffer})=>void} fn */
    onPublish(fn: (pub: {
        opCode: number;
        itemCode: number;
        body: Buffer;
    }) => void): () => boolean;
    /**
     * 接続して login まで完了させる (登録済みデバイス用)。secretKey 必須。
     *
     * 通常 login (既定): session 鍵 = deriveSessionKey(secretKey, token4) = CMAC(secretKey, token4)
     *   をローカル計算し、loginPayload で平文 login する (CHHub3Device.kt:168-172 token==null 経路)。
     *
     * サーバ認証 login (signLogin 指定時): isNeedAuthFromServer 相当。initial で得た token を
     *   signLogin(tokenHex) に渡して**サーバ署名済み session token (hex)** を取得し、それを session 鍵
     *   として login する (CHHub3Device.kt:163-174 token!=null / CHSesameOS3.kt:473-487 の
     *   signGuestKey→login(it.data) 経路)。ゲスト鍵・期限付き鍵など secretKey 単体では session を
     *   確立できないデバイス向け。
     *
     * @param {{signLogin?:(tokenHex:string)=>Promise<string>}} [opts]
     *   signLogin: 4B initial token の hex を受け取り、サーバ署名済み session token (16B/32hex) を返す
     *     非同期関数。省略時は通常 login。
     * @returns {Promise<void>} login 成功で resolve
     */
    connect({ signLogin }?: {
        signLogin?: (tokenHex: string) => Promise<string>;
    }): Promise<void>;
    /**
     * 工場出荷 (未登録) デバイスの初期ペアリング / 登録ハンドシェイク。
     * secretKey を渡さずに構築した session で呼ぶ (CHHub3Device.kt:176-211)。
     *
     * フロー (CHHub3Device.kt:176-211, CHSesameOS3.kt:468-492):
     *   1. transport 接続 → device の initial(14) publish を待つ。secretKey 無しのため login せず
     *      ReadyToRegister へ遷移 (_handleInitial の分岐, CHSesameOS3.kt:468-491 isRegistered=false)。
     *   2. (任意) registerSesame5 をコール (CHHub3Device.kt:187-189: 失敗してもログのみで継続)。
     *   3. ECDH 鍵ペア (P-256) を生成し、生公開鍵 64B (X‖Y) を registrationData(pubK, ts) に乗せて
     *      REGISTRATION(1) を **PLAINTEXT** 送出 (CHHub3Device.kt:191-194 / CHSesameOS3.kt:495-499)。
     *   4. response(7)+REGISTRATION(1)+resultCode+devicePubK(64B) を待つ。
     *   5. ecdhSecretPre16(keyPair, devicePubK) = ECDH 共有秘密の先頭 16B (CHHub3Device.kt:197)。
     *      secretKey(=wm2Key) = pre16 の hex で確定 (CHHub3Device.kt:198-200)。
     *   6. sessionKey = deriveSessionKeyFromEcdh(pre16, token4) (CHHub3Device.kt:202-203)。
     *      sault = 0x00 ++ token4 は CCM nonce 側 (ccmEncrypt/ccmDecrypt) が消費する。
     *      enc/decCount=0 で cipher を確立し、以降のコマンドは暗号化される。
     *      wm2 profile は鍵 = pre16 生 16B / sault = token4 / register data = pubK64 のみ
     *      (CHWifiModule2Device.kt:279-312。詳細はコンストラクタ JSDoc と protocol.js SESSION_PROFILES)。
     *   7. {deviceUUID, secretKey, productType, serverSecret(=token hex)} を返す
     *      (CHHub3Device.kt:196-208。serverSecret は mSesameToken.toHexString())。
     *
     * @param {{deviceUUID?:string, productType?:(string|number),
     *          registerTransport?:(req:any)=>Promise<any>, nowMs?:number}} [opts]
     *   - deviceUUID: 登録対象の UUID (戻り値・任意の registerSesame5 で使用)。必須 (未指定は reject)。
     *   - productType: 戻り値に載せる model 名 or 数値 productType (任意)。
     *   - registerTransport: 渡された場合のみ registerSesame5 をコール (失敗はログのみ)。
     *   - nowMs: registration timestamp (テスト用に注入可、既定 Date.now())。
     * @returns {Promise<{deviceUUID:string, secretKey:string, productType:(string|number|undefined),
     *                    serverSecret:string}>}
     */
    register({ deviceUUID, productType, registerTransport, nowMs }?: {
        deviceUUID?: string;
        productType?: (string | number);
        registerTransport?: (req: any) => Promise<any>;
        nowMs?: number;
    }): Promise<{
        deviceUUID: string;
        secretKey: string;
        productType: (string | number | undefined);
        serverSecret: string;
    }>;
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
    /**
     * mechSetting (角度キャリブレーション) を書き込む。
     *   data = configureLockPositionData(lockTarget, unlockTarget) (CHSesame5Device.kt:69-83)。
     * 成功時はキャッシュ (_lastMechSetting) の lock/unlock 位置も更新する (SDK と同じ局所更新)。
     * @param {number} lockTarget   施錠目標角 (-32768..32767)
     * @param {number} unlockTarget 解錠目標角 (-32768..32767)
     * @param {{timeoutMs?:number}} [opts]
     * @returns {Promise<{resultCode:number, payload:Buffer}>}
     */
    configureLockPosition(lockTarget: number, unlockTarget: number, opts?: {
        timeoutMs?: number;
    }): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * magnet — LOCK5 系ロック固有のコマンド (CHSesame5Device.kt:118-126 magnet() と 1:1)。
     *   item = magnet(17)、data = 空 ByteArray。引数なし・cipher セグメントで送り、成功で解決する。
     * @param {{timeoutMs?:number}} [opts]
     * @returns {Promise<{resultCode:number, payload:Buffer}>}
     */
    magnet(opts?: {
        timeoutMs?: number;
    }): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * opSensorControl(isEnable) — Open Sensor の自動施錠秒数を設定する
     * (CHSesame5Device.kt:107-116 と 1:1)。
     *   item = OPS_CONTROL(92)、data = opSensorControlData(seconds) (2B LE)。
     * SDK は成功時に opsSetting?.opsLockSecond = isEnable.toUShort() でキャッシュを局所更新する。
     * 本実装も成功 (resultCode==0) のとき _lastOpsSetting.opsLockSecond を更新する。
     * @param {number} seconds 0..65535 (0 = 無効)
     * @param {{timeoutMs?:number}} [opts]
     * @returns {Promise<{resultCode:number, payload:Buffer}>}
     */
    opSensorControl(seconds: number, opts?: {
        timeoutMs?: number;
    }): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * setBleTxPower(txPower) — BLE 送信出力を設定する
     * (CHSesameOS3LockBase.kt:62-71 / CHSesameBiometricDeviceImpl.kt:332-341 と 1:1)。
     *   item = SSM3_ITEM_CODE_BLE_TX_POWER_SETTING(206)、data = bleTxPowerData(txPower) (符号付き 1B)。
     * SDK は応答を待たず空コールバック ({}) で送りっぱなしにするが、本 kit の request() は
     * response(7)+item を待つ共通実装なので、ここでもそれに従い応答を返す (より堅牢、後方互換)。
     * @param {number} txPower -128..127
     * @param {{timeoutMs?:number}} [opts]
     * @returns {Promise<{resultCode:number, payload:Buffer}>}
     */
    setBleTxPower(txPower: number, opts?: {
        timeoutMs?: number;
    }): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * sendAdvProductType(data) — LOCK5 のアドバタイズ productType を書き換える
     * (CHSesame5Device.kt:85-94 と 1:1)。
     *   item = SS3_ITEM_CODE_SET_ADV_PRODUCT_TYPE(205)、data = 任意 ByteArray をそのまま。
     * 中身の意味は機種固有 (SDK も raw ByteArray を素通し) のため、呼び出し側が組み立てた
     * Buffer をそのまま送る。
     * @param {Buffer} data 送信する生バイト列
     * @param {{timeoutMs?:number}} [opts]
     * @returns {Promise<{resultCode:number, payload:Buffer}>}
     */
    sendAdvProductType(data: Buffer, opts?: {
        timeoutMs?: number;
    }): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * reset() — OS3 デバイスを工場出荷状態へ戻す (CHSesameOS3.kt:420-439 と 1:1)。
     *   item = Reset(104)、data = 空 ByteArray。成功 (cmdResultCode==success) のとき SDK は
     *   dropKey() を呼び、ローカルの鍵レコードを削除してセッションを破棄する。
     * 本 kit には永続鍵ストアが無い (secretKey は呼び出し側が保持) ため、dropKey 相当として
     * **成功時に disconnect() してセッションを破棄する** (WM2 reset と同じ流儀、wm2.js:440-448)。
     * 鍵レコードの削除そのものは呼び出し側の責務 (誇張せず明記)。
     * @param {{timeoutMs?:number}} [opts]
     * @returns {Promise<{resultCode:number, payload:Buffer}>} 成功時 resultCode=0
     */
    reset(opts?: {
        timeoutMs?: number;
    }): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * versionTag (ファームウェアバージョン文字列) を取得する。
     *   item = versionTag(5)、data = 空、payload = UTF-8 文字列 (CHSesameOS3.kt:398-418)。
     * @param {{timeoutMs?:number}} [opts]
     * @returns {Promise<string>} versionTag 文字列
     */
    getVersionTag(opts?: {
        timeoutMs?: number;
    }): Promise<string>;
    /**
     * 履歴を 1 件読み出す。
     *   item = history(4)、data = [0x01] (CHSesameOS3LockBase.kt:185-192)。
     * payload は 1 件分の履歴生バイト列 (先頭 4B が recordId)。サーバ post / 削除は呼び出し側の責務。
     * @param {{timeoutMs?:number}} [opts]
     * @returns {Promise<Buffer>} 履歴 payload (空なら 0 件)
     */
    readHistory(opts?: {
        timeoutMs?: number;
    }): Promise<Buffer>;
    /**
     * 履歴 1 件をデバイスから削除する。
     *   item = SSM2_ITEM_CODE_HISTORY_DELETE(18)、data = recordId = historyPayload[0..3]
     *   (CHSesameOS3LockBase.kt:201-209)。
     * @param {Buffer} historyPayload readHistory が返した payload (先頭 4B が recordId)
     * @param {{timeoutMs?:number}} [opts]
     * @returns {Promise<{resultCode:number, payload:Buffer}>}
     */
    deleteHistory(historyPayload: Buffer, opts?: {
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
     *   接続+notify購読。各 notify を onPacket へ。リンク断時は onDisconnect(reason) を 1 回呼ぶ (任意)。
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
export type Waiter = {
    resolve: (value?: any) => void;
    reject: (err: Error) => void;
    /**
     * setTimeout ハンドル。
     */
    timer: any;
};
import { Buffer } from "node:buffer";
import { SegmentAssembler } from "./protocol.js";
//# sourceMappingURL=session.d.ts.map