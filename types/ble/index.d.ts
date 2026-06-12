export * as protocol from "./protocol.js";
export * as devicemodel from "./devicemodel.js";
export * as biometric from "./biometric.js";
export * as bot2 from "./bot2.js";
export * as wm2 from "./wm2.js";
export * as hub3 from "./hub3.js";
export * as dfu from "./dfu.js";
export * as os2 from "./os2/index.js";
/** SesameBle (OS3) ファサードの RPC 公開面 (op パス第 1 セグメント)。 */
export const BLE_RPC_ALLOWLIST: readonly string[];
/**
 * SesameOS2Ble ファサードの RPC 公開面 (op パス第 1 セグメント)。
 * 除外の方針は BLE_RPC_ALLOWLIST と同じ (connect/close/register 系・onStatus は載せない —
 * 登録は ble.os2.register RPC が担う)。
 */
export const OS2_BLE_RPC_ALLOWLIST: readonly string[];
/**
 * biometric ゲッタが返す限定ビューの型。
 *
 * ★型は全 capability のメソッドを持つが、**実行時は bioCaps 集合内のメソッドだけが存在する**
 * (集合外は undefined — DeviceProfiles で機種ごとに静的に決まるため、モデルごとの部分型を
 * 静的に表現できない以上、型は上限・実体は機種別部分集合という関係になる)。集合外メソッドの
 * 呼び出しは TypeError になる (op を捏造して実機に送ることはない)。
 * @typedef {Pick<BiometricCommands,
 *   "cardModeSet"|"cardModeGet"|"cardGet"|"cardAdd"|"cardDelete"|"cardMove"|"cardChange"|"cardChangeValue"|"cardBatchAdd"
 *   |"fingerPrintModeSet"|"fingerPrintModeGet"|"fingerPrints"|"fingerPrintDelete"|"fingerPrintChange"
 *   |"passcodeModeSet"|"passcodeModeGet"|"passcodeGet"|"passcodeAdd"|"passcodeDelete"|"passcodeMove"|"passcodeChange"|"passcodeBatchAdd"
 *   |"faceModeSet"|"faceModeGet"|"faceListGet"|"faceChange"|"faceDelete"
 *   |"palmModeSet"|"palmModeGet"|"palmListGet"|"palmDelete"
 *   |"insertSesame"|"removeSesame"|"setRadarSensitivity"|"registerDelegate"|"onEnroll">} BiometricView
 */
/**
 * remoteNano ゲッタが返す限定ビューの型 (Remote / Remote Nano 専用面、追加バックログ 7)。
 * SDK が Remote 系 (CHSesameBiometricDeviceImpl) に与える公開面と 1:1:
 *   - setTriggerDelayTime: CHRemoteNanoCapable.kt:8 (送信 190)
 *   - insertSesame/removeSesame/setRadarSensitivity: CHSesameConnector (CHDeivceProtocols.kt:317-322)
 *   - registerDelegate: CHRemoteNanoCapable.registerEventDelegate 相当 (publish 191/201 等の受信結線)
 * @typedef {Pick<BiometricCommands, "insertSesame"|"removeSesame"|"setRadarSensitivity"|"registerDelegate">
 *   & {setTriggerDelayTime: (time:number)=>Promise<void>}} RemoteNanoView
 */
/**
 * サーバ署名トランスポート (makeRegisterTransport の戻り)。signGuestKey / register に渡す。
 * 正準型は devices.js が所有する。
 * @typedef {import("../devices.js").RegisterTransport} RegisterTransport
 */
/**
 * 発見結果に含まれる noble peripheral ハンドル。正準型は transport.js が所有する。
 * @typedef {import("./transport.js").NoblePeripheral} NoblePeripheral
 */
/**
 * SesameBle コンストラクタ opts。
 * @typedef {Object} SesameBleOptions
 * @property {string|Buffer} [secretKey] ロック共通鍵 (32 文字 hex、cloud の `sesame devices` で取得済み)。register モードでは不要 (工場出荷デバイスは鍵が未確定)。
 * @property {string} [deviceUUID] 対象識別 (advertise 照合)。複数 SESAME が近接する環境で必須。
 * @property {string} [address] BLE アドレスで識別する代替。
 * @property {string|null} [model] デバイス model 文字列 (能力テーブル参照用)。
 * @property {boolean} [registerMode] true で工場出荷デバイスの register() 用 (secretKey 不要・session を鍵無しで構築)。
 * @property {boolean} [needAuthFromServer] 登録済みだが server 認証が要るデバイス (ゲスト鍵等) で connect 時に signGuestKey login。
 * @property {RegisterTransport|null} [registerTransport] makeRegisterTransport の戻り (needAuthFromServer の signGuestKey / register に使用)。
 * @property {boolean} [debug]
 * @property {number} [scanTimeoutMs] 既定 transport のスキャン timeout。
 * @property {import("./session.js").BleTransport} [transport] 独自トランスポート (省略時 noble)。
 */
/**
 * register() 確定結果。
 * @typedef {Object} RegisterResult
 * @property {string} deviceUUID
 * @property {string} secretKey
 * @property {string|number|undefined} productType
 * @property {string} serverSecret
 */
/**
 * listNearbyDevices() の発見結果 1 件 (advertise だけから判る属性)。
 * @typedef {Object} DiscoveryEntry
 * @property {string} deviceUUID
 * @property {number} [productType]
 * @property {string|null} [model]
 * @property {string} [kind]
 * @property {boolean} [isRegistered]
 * @property {NoblePeripheral} peripheral
 */
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
     * 工場出荷 (未登録) デバイスを scan → connect → register → close まで自動化する。
     * register モードで SesameBle を構築し、登録ハンドシェイクを実行して確定した鍵を返す。
     *
     * @param {{deviceUUID?:string, address?:string, productType?:(string|number),
     *          registerTransport?:RegisterTransport, debug?:boolean, scanTimeoutMs?:number,
     *          transport?:import("./session.js").BleTransport, nowMs?:number}} [opts]
     *   deviceUUID/address はスキャン照合用。registerTransport を渡すと register() 内で
     *   サーバ側 registerSesame5 もコールする (失敗してもログのみで継続)。
     * @param {(result:RegisterResult)=>Promise<unknown>} [fn]
     *   登録結果を受け取る任意のコールバック (鍵の保存など)。close 前に実行される。
     * @returns {Promise<RegisterResult>}
     *   登録結果 (fn 指定時もこの結果を返す)。
     */
    static registerOnce(opts?: {
        deviceUUID?: string;
        address?: string;
        productType?: (string | number);
        registerTransport?: RegisterTransport;
        debug?: boolean;
        scanTimeoutMs?: number;
        transport?: import("./session.js").BleTransport;
        nowMs?: number;
    }, fn?: (result: RegisterResult) => Promise<unknown>): Promise<RegisterResult>;
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
     * 近接 SESAME を**鍵無しで**列挙する (transport.listNearbyDevices の薄いファサード)。
     * scanSesames が deviceUUID→peripheral の Map しか返さないのに対し、こちらは advertise だけから
     * 判る属性 ({deviceUUID, productType, model, kind, isRegistered, advTagB1, isConnectable, rssi,
     * localName, address, peripheral}) を機種付きで返す (CHBleManager.kt の chDeviceMap 構築に対応)。
     *
     * 用途: 登録前 (工場出荷) デバイスの発見 (isRegistered=false を拾って registerOnce へ)、
     * 鍵を持たない近接デバイスの可視化、接続前の機種判定など。返り値の peripheral を
     * SesameBle.fromDiscovery() / connectMany / NobleTransport に渡せば**再スキャン無しで**接続できる。
     *
     * @param {{timeoutMs?:number, debug?:boolean, includeUnknown?:boolean}} [opts]
     * @returns {Promise<Array<object>>} listNearbyDevices の発見結果配列
     */
    static listNearby(opts?: {
        timeoutMs?: number;
        debug?: boolean;
        includeUnknown?: boolean;
    }): Promise<Array<object>>;
    /**
     * listNearbyDevices() / listNearby() の発見結果 1 件から、**再スキャン無しで**接続可能な
     * SesameBle を構築する。発見結果の peripheral・deviceUUID・model をそのまま引き継ぎ、
     * secretKey など鍵情報は呼び出し側が補う (発見段階では鍵は未知)。
     *
     * @param {DiscoveryEntry} entry listNearbyDevices() の要素 ({deviceUUID, model, peripheral, ...})
     * @param {{secretKey?:string|Buffer, registerMode?:boolean, needAuthFromServer?:boolean,
     *          registerTransport?:RegisterTransport, debug?:boolean}} [opts]
     *   secretKey 等の鍵/モード指定。registerMode:true なら工場出荷デバイスの register() 用 (鍵不要)。
     * @returns {SesameBle}
     */
    static fromDiscovery(entry: DiscoveryEntry, opts?: {
        secretKey?: string | Buffer;
        registerMode?: boolean;
        needAuthFromServer?: boolean;
        registerTransport?: RegisterTransport;
        debug?: boolean;
    }): SesameBle;
    /**
     * @param {SesameBleOptions} [opts]
     */
    constructor(opts?: SesameBleOptions);
    /** デバイスの model 文字列 (例 "sesame_5" / "bot_2")。未指定なら null。 */
    get model(): string | null;
    /** 型ごとの能力 { kind, os, ops, mechKind, bleSupported, label }。 */
    get capabilities(): {
        kind: string;
        os: number;
        cloud: string[];
        ble: string[];
        ops: string[];
        mechKind: string | null;
        bleSupported: boolean;
        biometric: boolean;
        bioCaps: readonly string[];
        isOpenSensor: boolean;
        isRemote: boolean;
        wifiProvisioning: boolean;
        hubProvisioning: boolean;
        script: boolean;
        fingerprint: boolean;
        label: string;
    };
    /**
     * この操作を BLE で送れるか (このファサードは BLE 専用なので ble 能力で判定)。
     * @param {string} op
     * @returns {boolean}
     */
    supports(op: string): boolean;
    /**
     * 生体・アクセス制御デバイス (Touch/Touch Pro/Face/Palm 系) の BLE 登録 API。
     *
     * **機種別の capability 集合 (DeviceProfiles) で絞った限定ビュー** を返す (P3-15)。
     * SDK では capability 集合が機種ごとに deviceFactory() で固定され
     * (CHSesameBiometricDevice.kt:44-57 / CHDeivceProtocols.kt:77-216)、集合外の操作は存在しない。
     * kit でも bioCaps 集合内の capability のメソッド群 (BIO_VIEW_METHODS) だけを bind した
     * ビューを返す (既存 fingerPrint ゲッタと同型):
     *   - ssm_touch       → card + fingerprint (passcode 系は **見えない**)
     *   - ssm_touch_pro   → card + fingerprint + passcode
     *   - sesame_face     → card + fingerprint + palm + face
     *   - sesame_face_ai  → palm + face のみ (card 系は **見えない**)
     *   - sesame_face_Pro → 全部 / sesame_face_pro_ai → passcode + palm + face
     * 集合に依らない共通 API (CHSesameConnector / delegate 結線) は常に載る:
     *   insertSesame / removeSesame / setRadarSensitivity / registerDelegate / onEnroll
     *   (onEnroll の card/passcode 既定値は集合から導出され、集合外 kind は集約しない)。
     *
     * capabilitiesForModel(model).biometric が true の機種でのみ露出する。それ以外 (ロック/Bot/
     * Bike/Hub3/WiFi/未知) で参照すると enroll 非対応として明示エラーを投げる (op を捏造しない)。
     * **bioCaps が空集合の機種 (open_sensor_1/2, remote, remote_nano — CHDeivceProtocols.kt:81,112,
     * 118,172 で setOf()) でも明示エラーを投げる** (P3-15)。remote/remote_nano の専用面
     * (setTriggerDelayTime / connector 操作) は remoteNano ゲッタが露出する (追加バックログ 7)。
     * open sensor 系で connector 操作 (insertSesame 等) が必要な場合は
     * BiometricCommands(session, {model}) を直接構築すること。
     * connect() 前でも参照できる (session.request は connect 後に login 済みを要求する)。
     *
     * @returns {BiometricView} bioCaps で絞った BiometricCommands の限定ビュー
     *   (型は全 capability の上限。実行時に存在するのは集合内メソッドのみ — BiometricView 参照)
     */
    get biometric(): BiometricView;
    /**
     * Remote / Remote Nano の専用 API (追加バックログ 7)。
     *
     * SDK では remote(pType 14) と remote_nano(pType 15) はどちらも BiometricDeviceType.REMOTE の
     * CHSesameBiometricDeviceImpl として生成され (CHDeivceProtocols.kt:112,118)、capability 集合は
     * 空 (setOf())。そのため biometric ゲッタは明示エラーを投げ (P3-15)、Remote 系が SDK 上で持つ
     * 次の公開面が facade から不達になっていた。ここで 1:1 に露出する (実在するもののみ):
     *   - setTriggerDelayTime(time): トリガ遅延の設定 — REMOTE_NANO_ITEM_CODE_SET_TRIGGER_DELAYTIME
     *     (190) + [time(UByte 1B)] (CHRemoteNanoCapable.kt:8 / CHRemoteNanoCapableImpl.kt:19-28)。
     *     **読み出しコマンドは SDK に存在しない**: 現在値は PUB_TRIGGER_DELAYTIME(191) publish が
     *     運び、registerDelegate の onTriggerDelaySecondReceived で受ける
     *     (CHRemoteNanoEventHandler.kt:15-21 — isRemote() の機種でのみ dispatch)。
     *   - insertSesame / removeSesame / setRadarSensitivity: CHSesameConnector 共通面
     *     (CHDeivceProtocols.kt:317-322。実装は CHDeviceConnectCapableImpl.kt:23-95 を
     *     CHSesameBiometricDeviceImpl.kt:411-412 が委譲し、Remote 系もこの実装クラスで生成される)。
     *     **radar 感度の読み出しコマンドも SDK に存在しない**: RADAR_PARAM_PUBLISH(201) publish を
     *     registerDelegate の onRadarReceive で受けるのみ (CHSesameBiometricDeviceImpl.kt:176,210-212)。
     *   - registerDelegate(delegate, device): publish 受信の delegate 結線
     *     (CHRemoteNanoCapable.registerEventDelegate 相当)。
     *
     * capabilitiesForModel(model).isRemote が true の機種 (= remote / remote_nano) でのみ露出する。
     * それ以外 (ロック/Bot/Bike/Touch/Face/open sensor/Hub3/WM2/未知) で参照すると明示エラーを投げる
     * (op を捏造しない)。open sensor 系は Remote ではない (BiometricDeviceType.OPEN_SENSOR/_2) ため
     * ここでは露出しない — SDK にも open sensor 固有の Capable interface は無く、connector 操作が
     * 必要な場合は new BiometricCommands(session, {model}) を直接構築する (biometric ゲッタの注記)。
     * connect() 前でも参照できる (session.request は connect 後に login 済みを要求する)。
     *
     * @experimental Remote 系 BLE 経路は SDK Kotlin の静的読みからの移植で **実機未検証**
     *   (参照: CHRemoteNanoCapableImpl.kt:19-28 / CHDeviceConnectCapableImpl.kt:23-95)。
     * @returns {RemoteNanoView}
     */
    get remoteNano(): RemoteNanoView;
    /**
     * SESAME Bike3 の指紋登録 API (CHSesameBike3Device.kt:20-24 が mixin する CHFingerPrintCapable と 1:1)。
     *
     * Bike3 は Bike2 (解錠のみ) に CHFingerPrintCapable **だけ**を足した固有型で、card/passcode/face/palm
     * は持たない。よって biometric ゲッタ (生体全機能) ではなく、指紋サブセットのみを露出する:
     *   fingerPrints() / fingerPrintDelete(id) / fingerPrintChange(id, hexName) /
     *   fingerPrintModeGet() / fingerPrintModeSet(mode) と、publish 受信を delegate に流す
     *   registerDelegate()。実体は biometric.js の BiometricCommands (itemCode 115-122) を共用する
     *   (重複実装しない) が、ここでは指紋系メソッドだけを通す薄いビューに絞る。
     *
     * capabilitiesForModel(model).fingerprint が true の機種 (= Bike3) でのみ露出する。それ以外
     * (ロック/Bot/Bike2/biometric/Hub3/WiFi/未知) で参照すると非対応として明示エラーを投げる (op を捏造しない)。
     * connect() 前でも参照できる (session.request は connect 後に login 済みを要求する)。
     *
     * @returns {{fingerPrints:Function, fingerPrintDelete:Function, fingerPrintChange:Function, fingerPrintModeGet:Function, fingerPrintModeSet:Function, registerDelegate:Function}}
     */
    get fingerPrint(): {
        fingerPrints: Function;
        fingerPrintDelete: Function;
        fingerPrintChange: Function;
        fingerPrintModeGet: Function;
        fingerPrintModeSet: Function;
        registerDelegate: Function;
    };
    /**
     * SESAME Bot2 / Bot3 のスクリプト API (CHSesameBot2Device.kt:73-193 と 1:1)。
     *
     * click(index, tag) / sendClickScript(index, script) / selectScript(index) /
     * getCurrentScript(index) / getScriptNameList() と、直近の SCRIPT_NAME_LIST 結果を保持する
     * scripts プロパティを持つ Bot2Commands を返す (実体は src/ble/bot2.js、契約は session.request に乗る)。
     *
     * capabilitiesForModel(model).script が true の機種 (= Bot2/Bot3) でのみ露出する。それ以外
     * (ロック/Bike/biometric/Hub3/WiFi/未知) で参照すると非対応として明示エラーを投げる (op を捏造しない)。
     * connect() 前でも参照できる (session.request は connect 後に login 済みを要求する)。
     *
     * 注: ファサードの click(tag) (CLICK=89) は従来通り残す (index 無しの単純クリック)。index 指定 click と
     * スクリプト管理はこの script ゲッタ経由で行う。
     *
     * @returns {Bot2Commands}
     */
    get script(): Bot2Commands;
    /**
     * WifiModule2 (WM2) の BLE プロビジョニング API。
     *
     * scanWifiSSID / setWifiSSID / setWifiPassword / connectWifi / insertSesames / removeSesame /
     * networkStatus と、正規化済み WM2 publish ({kind, ...}) を購読する onPublish を持つ
     * WifiModule2 を返す (実体は src/ble/wm2.js、契約は session.request / session.onPublish に乗る)。
     *
     * capabilitiesForModel(model).wifiProvisioning が true の機種 (= WM2) でのみ露出する。それ以外
     * (ロック/Bot/Bike/biometric/Hub3/未知) で参照すると非対応として明示エラーを投げる (op を捏造しない)。
     * connectWifi の companyId (= BuildConfig.API_GATEWAY_CLIENT_ID) と deviceUUID はここで束ねて
     * WifiModule2 に渡す (本番では config/env から供給する想定)。
     *
     * 注: WM2 は専用 GATT (WM2_GATT) で接続する必要がある。SesameBle を WM2 model で構築すると
     * 既定 transport に WM2_GATT が注入される (constructor)。connect() 前でも参照できる
     * (session.request は connect 後に login 済みを要求する)。
     *
     * @param {{companyId?:string}} [opts] connectWifi 用 companyId (API_GATEWAY_CLIENT_ID) の上書き。
     * @returns {WifiModule2}
     */
    wifi({ companyId }?: {
        companyId?: string;
    }): WifiModule2;
    /**
     * WM2 を工場出荷状態へリセットする (CHWifiModule2Device.kt:437-448 reset() と 1:1)。
     *
     * RESET_WM2(18) を送り、成功時にセッションを破棄する (= SDK の dropKey 相当)。詳細は
     * WifiModule2.reset() を参照。wifiProvisioning 非対応機種では wifi() と同じく明示エラーを投げる。
     *
     * @param {{timeoutMs?:number}} [opts]
     * @returns {Promise<{resultCode:number, payload:Buffer}>} RESET_WM2 の応答 (成功時 resultCode=0)
     */
    resetWifiModule2(opts?: {
        timeoutMs?: number;
    }): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * SESAME Hub3 / Hub3 LTE の BLE プロビジョニング API (CHHub3Device.kt の Wi-Fi/SSID/子鍵/接続種別と 1:1)。
     *
     * scanWifiSSID / setWifiSSID / setWifiPassword / removeSesame / networkType と、正規化済み Hub3
     * publish ({kind, ...}) を購読する onPublish を持つ Hub3Commands を返す (実体は src/ble/hub3.js、
     * 契約は session.request / session.onPublish に乗る)。
     *
     * capabilitiesForModel(model).hubProvisioning が true の機種 (= Hub3/Hub3 LTE) でのみ露出する。
     * それ以外 (ロック/Bot/Bike/biometric/WM2/未知) で参照すると非対応として明示エラーを投げる (op を捏造しない)。
     *
     * 注: Hub3 は SESAME 既定 GATT で接続する (WM2 のような専用 GATT は不要)。connect() 前でも参照できる
     * (session.request は connect 後に login 済みを要求する)。Hub3 は BLE 施錠制御 op (lock/unlock 等) を
     * 持たない (ble[] は空) が、connect/login/register/reset/updateFirmware は OS3 共通経路で動く。
     *
     * @returns {Hub3Commands}
     */
    hub3(): Hub3Commands;
    /**
     * BLE 経由ファームウェア更新 (DFU/OTA) を開始する。model で経路が分岐する (SDK と 1:1):
     *   - WM2 (wifiProvisioning)  → OPEN_OTA_SERVER(126) を送る updateFirmwareWM2
     *                               (CHWifiModule2Device.kt:450-458)
     *   - Hub3                    → MOVE_TO(84) を送る updateFirmwareBleOnly
     *                               (CHHub3Device.kt:217-230。MOVE_TO 送出は **Hub3 専用**)
     *   - OS3 lock / Bot2 / Bike2/3 / biometric
     *                             → **命令を一切送らず** デバイスハンドル ({session}) を返す
     *                               dfu.updateFirmware (CHSesameOS3.kt:441-449 の共通 no-op 経路。
     *                               実際の DFU バイナリ転送は Nordic DFU 相当が別 GATT で行う前提で、
     *                               本 kit は未実装 — ハンドル返しまで)。
     *
     * 進捗 (Hub3/WM2) は publish の payload 先頭バイト (onProgress(progress, body))。応答が来た時点
     * (OTA サーバ起動完了) で内部購読は停止する。100% 完了まで進捗を取り続けたい場合は
     * ble.onMoveToOtaProgress / ble.onWM2OtaProgress を直接購読する。
     *
     * OTA 経路を持たない機種 (OS2 系・未知) は明示エラーを投げる (op を捏造しない)。
     *
     * @param {{onProgress?:(progress:number|null, body:Buffer)=>void, timeoutMs?:number}} [opts]
     * @returns {Promise<{resultCode:number, payload:Buffer, session:object}>
     *           |{session:import("./session.js").SesameBleSession}}
     *   Hub3/WM2 はコマンド応答 + session の Promise。OS3 lock 系は同期で {session} (命令無送信)。
     */
    updateFirmware(opts?: {
        onProgress?: (progress: number | null, body: Buffer) => void;
        timeoutMs?: number;
    }): Promise<{
        resultCode: number;
        payload: Buffer;
        session: object;
    }> | {
        session: import("./session.js").SesameBleSession;
    };
    /**
     * mechStatus publish を購読 (戻り値 unsubscribe)。
     * @param {(status: unknown) => void} fn
     * @returns {() => void}
     */
    onStatus(fn: (status: unknown) => void): () => void;
    /** 最後に受信した mechStatus。 */
    get lastStatus(): any;
    /** 最後に受信した mechSetting (角度キャリブレーション lockPosition/unlockPosition/autoLockSecond)。未受信なら null。 */
    get lastMechSetting(): {
        lockPosition: number;
        unlockPosition: number;
        autoLockSecond: number;
    } | null;
    /** 最後に受信した opsSetting (opsLockSecond)。未受信なら null。 */
    get lastOpsSetting(): {
        opsLockSecond: number;
    } | null;
    get isConnected(): boolean;
    /**
     * 接続 + login。
     *
     * needAuthFromServer=true (かつ registerTransport 指定) のとき、initial token を
     * signGuestKey に渡してサーバ署名済み session token を取得する経路で login する
     * (CHHub3Device.kt:163-174 token!=null / CHSesameOS3.kt:473-487)。登録済みだが
     * ゲスト鍵・期限付き鍵などで secretKey 単体では session を確立できないデバイス向け。
     * needAuthFromServer=false の通常デバイスは secretKey からローカルに session 鍵を導出する。
     */
    connect(): Promise<this>;
    /** 切断。 */
    close(): Promise<void>;
    /**
     * 工場出荷 (未登録) デバイスの初期ペアリング / 登録 (ECDH + サーバ認証)。
     * `registerMode: true` で構築した SesameBle で呼ぶ (secretKey 無し)。
     *
     * フロー (CHHub3Device.kt:176-211): connect(register モード) → session.register() で
     * REGISTRATION ハンドシェイク → 確定した {deviceUUID, secretKey, productType, serverSecret} を返す。
     * 戻り値の secretKey を保存すれば、以降は通常の SesameBle({ secretKey }).connect() で操作できる。
     *
     * @param {{deviceUUID?:string, productType?:(string|number), nowMs?:number}} [opts]
     *   deviceUUID 省略時はコンストラクタの deviceUUID を使用。
     * @returns {Promise<{deviceUUID:string, secretKey:string, productType:(string|number|undefined), serverSecret:string}>}
     */
    register({ deviceUUID, productType, nowMs }?: {
        deviceUUID?: string;
        productType?: (string | number);
        nowMs?: number;
    }): Promise<{
        deviceUUID: string;
        secretKey: string;
        productType: (string | number | undefined);
        serverSecret: string;
    }>;
    /**
     * 施錠 (BLE item=82)。tag は履歴に残す任意ラベル。
     * @param {Buffer} [tag] 履歴タグ (UUID バイト列)
     * @returns {Promise<{resultCode:number, payload:Buffer}>}
     */
    lock(tag?: Buffer): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * 解錠 (BLE item=83)。Sesame5/6 ロックと Bike2 が対応。
     * @param {Buffer} [tag] 履歴タグ (UUID バイト列)
     */
    unlock(tag?: Buffer): Promise<{
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
     * @param {Buffer} [tag] 履歴タグ (UUID バイト列)
     */
    toggle(tag?: Buffer): Promise<{
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
     * @returns {Promise<unknown>} parseMechStatus の結果
     */
    status({ timeoutMs }?: {
        timeoutMs?: number;
    }): Promise<unknown>;
    /**
     * mechSetting (角度キャリブレーション) を書き込む (BLE item=80)。Sesame5/6 系ロックのみ。
     * **BLE 経由のみ**で本体に反映される (クラウド経路には存在しない設定)。
     * lockTarget/unlockTarget は施錠/解錠位置のエンコーダ角 (符号付き 16bit)。
     * 成功時は lastMechSetting キャッシュの lock/unlock 位置も更新される (SDK と同じ局所更新)。
     * @param {number} lockTarget   施錠目標角 (-32768..32767)
     * @param {number} unlockTarget 解錠目標角 (-32768..32767)
     * @returns {Promise<{resultCode:number, payload:Buffer}>}
     */
    configureLockPosition(lockTarget: number, unlockTarget: number): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * magnet コマンドを送る (BLE item=17、CHSesame5Device.kt:118-126 magnet() と 1:1)。
     * 引数なし・空ペイロード。magnet() は CHSesame5 固有 (CHSesame5.kt:16) のため
     * os===3 && kind===LOCK5 で厳密に弾く (OS2 SESAME2/4 も autolock を持つので op では弾けない)。
     * @returns {Promise<{resultCode:number, payload:Buffer}>}
     */
    magnet(): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * opSensorControl(seconds) — Open Sensor の自動施錠秒数を設定する (BLE item=92、
     * CHSesame5Device.kt:107-116 と 1:1)。OPS_CONTROL は CHSesame5 固有 (CHSesame5.kt:19) のため
     * os===3 && kind===LOCK5 で厳密に弾く (OS2 SESAME2/4 も autolock を持つので op では弾けない)。
     * 成功時は lastOpsSetting キャッシュの opsLockSecond も更新される (SDK と同じ局所更新)。
     * @param {number} seconds 0..65535 (0 = 無効)
     * @returns {Promise<{resultCode:number, payload:Buffer}>}
     */
    opSensorControl(seconds: number): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * sendAdvProductType(data) — LOCK5 のアドバタイズ productType を書き換える (BLE item=205、
     * CHSesame5Device.kt:85-94 と 1:1)。data は機種固有の生バイト列をそのまま送る。
     * SET_ADV_PRODUCT_TYPE は CHSesame5 固有 (CHSesame5.kt:21) のため os===3 && kind===LOCK5 で
     * 厳密に弾く (OS2 SESAME2/4 も autolock を持つので op では弾けない)。
     * @param {Buffer} data 送信する生バイト列
     * @returns {Promise<{resultCode:number, payload:Buffer}>}
     */
    sendAdvProductType(data: Buffer): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * setBleTxPower(txPower) — BLE 送信出力を設定する (BLE item=206)。
     * SDK では OS3 ロック (CHSesameOS3LockBase.kt:62-71) と生体・アクセス制御デバイス
     * (CHSesameBiometricDeviceImpl.kt:332-341) の双方が実装する。よって OS3 の
     * LOCK5 または biometric kind のみで露出し、それ以外 (OS2 系・Bot/Bike・Hub3・WM2・未知) は
     * 明示エラーを投げる (op を捏造しない)。txPower は符号付き 1B (-128..127)。
     * @param {number} txPower -128..127
     * @returns {Promise<{resultCode:number, payload:Buffer}>}
     */
    setBleTxPower(txPower: number): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * reset() — OS3 デバイスを工場出荷状態へ戻す (BLE item=104、CHSesameOS3.kt:420-439 と 1:1)。
     * SDK の reset() は CHSesameOS3 の open fun で、全 OS3 デバイス (LOCK5/Bot2/Bike2/Bike3/
     * biometric/Hub3) が継承する。OS2 系 (CHSesame2/Bot/Bike) は別の reset 系統なので弾く。
     *
     * **WM2 (wifiProvisioning) は RESET_WM2(18) 経路へ自動ルーティングする**: CHWifiModule2Device は
     * reset() を override して WM2ActionCode.RESET_WM2(18) を空ペイロードで送り、成功時に dropKey
     * (CHWifiModule2Device.kt:437-448)。WM2 の action code 空間で 104 は未定義のため、汎用
     * Reset(104) を送る旧挙動は SDK と乖離していた (追加バックログ 1)。実装は WifiModule2.reset()
     * (wm2.js — 成功時 session.disconnect = dropKey 相当) に委譲する。
     *
     * 成功時はセッションが破棄される (session.reset / WifiModule2.reset 内で disconnect 相当、
     * dropKey に対応)。鍵レコードの削除そのものは呼び出し側の責務。
     * @returns {Promise<{resultCode:number, payload:Buffer}>}
     */
    reset(): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
    /**
     * versionTag (ファームウェアバージョン文字列) を取得する (BLE item=5)。
     * @returns {Promise<string>}
     */
    getVersionTag(): Promise<string>;
    /**
     * 履歴を 1 件取得 (BLE item=4)。payload の解析は呼び出し側 (生バイト返し)。
     * 先頭 4B が recordId で、deleteHistory に渡せばその 1 件をデバイスから削除できる。
     * @returns {Promise<Buffer>}
     */
    history(): Promise<Buffer>;
    /**
     * 履歴 1 件をデバイスから削除する (BLE item=18)。
     * @param {Buffer} historyPayload history() が返した payload (先頭 4B が recordId)
     * @returns {Promise<{resultCode:number, payload:Buffer}>}
     */
    deleteHistory(historyPayload: Buffer): Promise<{
        resultCode: number;
        payload: Buffer;
    }>;
}
/**
 * biometric ゲッタが返す限定ビューの型。
 *
 * ★型は全 capability のメソッドを持つが、**実行時は bioCaps 集合内のメソッドだけが存在する**
 * (集合外は undefined — DeviceProfiles で機種ごとに静的に決まるため、モデルごとの部分型を
 * 静的に表現できない以上、型は上限・実体は機種別部分集合という関係になる)。集合外メソッドの
 * 呼び出しは TypeError になる (op を捏造して実機に送ることはない)。
 */
export type BiometricView = Pick<BiometricCommands, "cardModeSet" | "cardModeGet" | "cardGet" | "cardAdd" | "cardDelete" | "cardMove" | "cardChange" | "cardChangeValue" | "cardBatchAdd" | "fingerPrintModeSet" | "fingerPrintModeGet" | "fingerPrints" | "fingerPrintDelete" | "fingerPrintChange" | "passcodeModeSet" | "passcodeModeGet" | "passcodeGet" | "passcodeAdd" | "passcodeDelete" | "passcodeMove" | "passcodeChange" | "passcodeBatchAdd" | "faceModeSet" | "faceModeGet" | "faceListGet" | "faceChange" | "faceDelete" | "palmModeSet" | "palmModeGet" | "palmListGet" | "palmDelete" | "insertSesame" | "removeSesame" | "setRadarSensitivity" | "registerDelegate" | "onEnroll">;
/**
 * remoteNano ゲッタが返す限定ビューの型 (Remote / Remote Nano 専用面、追加バックログ 7)。
 * SDK が Remote 系 (CHSesameBiometricDeviceImpl) に与える公開面と 1:1:
 *   - setTriggerDelayTime: CHRemoteNanoCapable.kt:8 (送信 190)
 *   - insertSesame/removeSesame/setRadarSensitivity: CHSesameConnector (CHDeivceProtocols.kt:317-322)
 *   - registerDelegate: CHRemoteNanoCapable.registerEventDelegate 相当 (publish 191/201 等の受信結線)
 */
export type RemoteNanoView = Pick<BiometricCommands, "insertSesame" | "removeSesame" | "setRadarSensitivity" | "registerDelegate"> & {
    setTriggerDelayTime: (time: number) => Promise<void>;
};
/**
 * サーバ署名トランスポート (makeRegisterTransport の戻り)。signGuestKey / register に渡す。
 * 正準型は devices.js が所有する。
 */
export type RegisterTransport = import("../devices.js").RegisterTransport;
/**
 * 発見結果に含まれる noble peripheral ハンドル。正準型は transport.js が所有する。
 */
export type NoblePeripheral = import("./transport.js").NoblePeripheral;
/**
 * SesameBle コンストラクタ opts。
 */
export type SesameBleOptions = {
    /**
     * ロック共通鍵 (32 文字 hex、cloud の `sesame devices` で取得済み)。register モードでは不要 (工場出荷デバイスは鍵が未確定)。
     */
    secretKey?: string | Buffer<ArrayBufferLike> | undefined;
    /**
     * 対象識別 (advertise 照合)。複数 SESAME が近接する環境で必須。
     */
    deviceUUID?: string | undefined;
    /**
     * BLE アドレスで識別する代替。
     */
    address?: string | undefined;
    /**
     * デバイス model 文字列 (能力テーブル参照用)。
     */
    model?: string | null | undefined;
    /**
     * true で工場出荷デバイスの register() 用 (secretKey 不要・session を鍵無しで構築)。
     */
    registerMode?: boolean | undefined;
    /**
     * 登録済みだが server 認証が要るデバイス (ゲスト鍵等) で connect 時に signGuestKey login。
     */
    needAuthFromServer?: boolean | undefined;
    /**
     * makeRegisterTransport の戻り (needAuthFromServer の signGuestKey / register に使用)。
     */
    registerTransport?: import("../devices.js").RegisterTransport | null | undefined;
    debug?: boolean | undefined;
    /**
     * 既定 transport のスキャン timeout。
     */
    scanTimeoutMs?: number | undefined;
    /**
     * 独自トランスポート (省略時 noble)。
     */
    transport?: import("./session.js").BleTransport | undefined;
};
/**
 * register() 確定結果。
 */
export type RegisterResult = {
    deviceUUID: string;
    secretKey: string;
    productType: string | number | undefined;
    serverSecret: string;
};
/**
 * listNearbyDevices() の発見結果 1 件 (advertise だけから判る属性)。
 */
export type DiscoveryEntry = {
    deviceUUID: string;
    productType?: number | undefined;
    model?: string | null | undefined;
    kind?: string | undefined;
    isRegistered?: boolean | undefined;
    peripheral: NoblePeripheral;
};
import { Buffer } from "node:buffer";
import { Bot2Commands } from "./bot2.js";
import { WifiModule2 } from "./wm2.js";
import { Hub3Commands } from "./hub3.js";
import { BiometricCommands } from "./biometric.js";
export { SesameBleSession, BleResultError } from "./session.js";
export { RESULT as SESAME_RESULT_CODES, resultName } from "./protocol.js";
export { NobleTransport, createBleTransport, advToDeviceUUID, parseAdvertisement, scanSesames, listNearbyDevices, peripheralToDiscovery } from "./transport.js";
export { capabilitiesForModel, kindForModel, supportsOp, isOperable, transportsForOp, CONTROL_OPS, KIND, PRODUCT_TYPES, BIO_CAPABILITY, bioCapsForModel } from "./devicemodel.js";
export { BiometricCommands, handleBiometricPublish, parseTouchCard, parseTouchFace, parseRemoteNanoTrigger, remoteNanoTriggerDelayData, radarSensitivityData, insertSesameData as biometricInsertSesameData, removeSesameData as biometricRemoveSesameData, createEnrollCollector } from "./biometric.js";
export { Bot2Commands, BOT_ACTION_TYPE, clickItemCode, bot2ActionToBytes, scriptToBytes, parseCurrentScript, parseScriptNameList } from "./bot2.js";
export { WifiModule2, WM2_GATT, WM2_ACTION, scanWifiSSIDData, setWifiSSIDData, setWifiPasswordData, connectWifiData, insertSesamesData, removeSesameData, networkStatusData, parseScanWifiSSID, parseWifiSSIDPublish, parseWifiPasswordPublish, parseNetworkStatus, parseSesameKeys, parseWM2Publish } from "./wm2.js";
export { Hub3Commands, parseHub3Publish, parseNetworkType, parseMechSetting as parseHub3MechSetting, parseScanWifiSSID as parseHub3ScanWifiSSID, parseSesameKeys as parseHub3SesameKeys, networkTypeData } from "./hub3.js";
export { updateFirmware, updateFirmwareBleOnly, updateFirmwareWM2, onMoveToOtaProgress, onWM2OtaProgress } from "./dfu.js";
export { SesameOS2Ble, SesameOS2BleSession, SesameOS2BleCipher } from "./os2/index.js";
//# sourceMappingURL=index.d.ts.map