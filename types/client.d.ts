export class SesameHub3 {
    /**
     * 既定の設定ディレクトリ (~/.config/sesame-kit 等) から読み込んで構築。
     * CLI 内部はこのファクトリを使う。
     * @param {{ configDir?: string, debug?: boolean }} [opts]
     */
    static fromConfig(opts?: {
        configDir?: string;
        debug?: boolean;
    }): Promise<SesameHub3>;
    /**
     * 自動 connect/close ヘルパ。boilerplate 削減用。
     *
     *   await SesameHub3.use(async (hub) => { await hub.unlock("front"); });
     *   await SesameHub3.use({ configDir: "/tmp/cfg" }, async (hub) => { ... });
     *   await SesameHub3.use({ tokenStore: myStore, config: {...} }, async (hub) => { ... });
     *
     * config / tokenStore を opts で渡せば fromConfig をスキップ (他プロジェクト埋込み用)。
     *
     * @param {((hub:SesameHub3) => Promise<any>) | object} fnOrOpts
     * @param {(hub:SesameHub3) => Promise<any>} [maybeFn]
     */
    static use(fnOrOpts: ((hub: SesameHub3) => Promise<any>) | object, maybeFn?: (hub: SesameHub3) => Promise<any>): Promise<any>;
    /**
     * @param {{
     *   config: object,
     *   tokenStore: TokenStore,
     *   configStore?: ConfigStore,
     *   debug?: boolean,
     * }} args
     */
    constructor({ config, tokenStore, configStore, debug }: {
        config: object;
        tokenStore: TokenStore;
        configStore?: ConfigStore;
        debug?: boolean;
    });
    _config: any;
    _configStore: ConfigStore;
    _tokenStore: TokenStore;
    _debug: boolean;
    /** @type {Hub3WsClient | null} */
    _ws: Hub3WsClient | null;
    _subUUID: any;
    /**
     * close() 時に await したい async cleanup 関数の集合 (2nd-pass M-1)。
     * `onIRLearned` 等の戻り値 unsubscribe は呼び出し側の await 忘れで Hub3 が
     * REGISTER モードに残るリスクがあるため、ここに登録しておくと close() で確実に走る。
     */
    _pendingCleanups: Set<any>;
    /** WS 再接続 (初回以外の OPEN) で呼ぶコールバック集合。購読者の再 subscribe 用。 */
    _reconnectCbs: Set<any>;
    _lock: LockManager;
    /**
     * WS 再接続時に呼ばれるコールバックを登録する。戻り値で解除。
     * デーモン等、再接続後にサーバ購読 (subscribe frame) を張り直したい用途向け。
     * @param {() => void} cb
     * @returns {() => void} unsubscribe
     */
    onReconnect(cb: () => void): () => void;
    /** 登録済み再接続コールバックを発火する (transport の onReopen から呼ばれる)。 */
    _fireReconnect(): void;
    get config(): any;
    get configStore(): ConfigStore;
    get tokenStore(): TokenStore;
    get connected(): boolean;
    /**
     * remote 名 (省略時は default) から remote 定義と親 hub3 をまとめて取得。
     */
    resolveRemote(name: any): {
        name: any;
        remote: any;
        hub3Name: any;
        hub3: any;
    };
    /** WS 接続を確立。既に接続済みなら何もしない。 */
    connect(): Promise<void>;
    close(): Promise<void>;
    _ensureConnected(): void;
    _bindNs(mod: any): {};
    /** スケジュール (biz3Schedule)。 */
    get schedule(): {};
    /** 組織管理 (employee/group/role/device-group/employee-device)。 */
    get org(): {};
    /** 会社 (biz3ManageCompany)。 */
    get company(): {};
    /** 認証データ (NFC カード/パスコードの WS op)。 */
    get access(): {};
    /** IoT cmd (biz3OperateIoT: DFU/LED/リレー/Sesame item)。 */
    get iot(): {};
    /** プリセットリモコン command 生成 (remoteEmit, HXD)。 */
    get presetir(): {};
    /**
     * IR 発射 (name-based)。`keyOrUUID` が UUID 形式ならそのまま command として、
     * そうでなければ remote.keys から名前解決する。
     * config を介さない版は {@link SesameHub3#sendIRDirect}。
     *
     * @param {string|null} remoteName リモコン名 (null で default.remote)
     * @param {string} keyOrUUID キー名 or keyUUID
     * @returns {Promise<object>} sendIR の応答 (success / data.message 等)
     */
    send(remoteName: string | null, keyOrUUID: string): Promise<object>;
    /**
     * リモコンに登録されている IR キー一覧をサーバから取得 (name-based)。
     * config を介さない版は {@link SesameHub3#getIRCodesDirect}。
     *
     * @param {string|null} remoteName リモコン名 (null で default.remote)
     * @returns {Promise<Array<{name:string, keyUUID:string}>>}
     */
    listKeys(remoteName: string | null): Promise<Array<{
        name: string;
        keyUUID: string;
    }>>;
    /**
     * 接続疎通確認: biz3KeepAlive を 1 往復して ack を待つ。
     * 失敗時は throw。
     */
    ping(): Promise<boolean>;
    /**
     * ログインユーザの customerInfo / quotas を取得 (biz3GetLoginUser)。
     * email は tokenStore の username (login に使った値) を使う。
     * @returns {Promise<{customerInfo: object|null, quotas: object|null}>}
     */
    getLoginUser(): Promise<{
        customerInfo: object | null;
        quotas: object | null;
    }>;
    /**
     * biz3GetLoginUser で実 companyID / subUUID を取得し、config と内部状態に反映する。
     * companyID は従来デフォルト (ch_CandyhouseMobile) を置いていたが、これで実値に上書きできる。
     * @returns {Promise<object|null>} customerInfo
     */
    refreshAccount(): Promise<object | null>;
    /**
     * 全 SESAME デバイス (Hub3 含む) のリストを取得。
     * biz3ManageDevice/getCompanyDevice → PubedCompanyDevice の応答を待つ。
     */
    listDevices({ timeoutMs }?: {
        timeoutMs?: number;
    }): Promise<any>;
    _requireConfigStore(op: any): void;
    /**
     * 全 SESAME デバイスを引いてロックを config に取り込む。
     * @param {{prune?:boolean}} [opts]
     * @returns {Promise<{added:string[], updated:string[], removed:string[]}>}
     */
    syncLocksFromDevices(opts?: {
        prune?: boolean;
    }): Promise<{
        added: string[];
        updated: string[];
        removed: string[];
    }>;
    /**
     * 全 SESAME デバイスを引いて Hub3 を config に取り込む。
     * @param {{prune?:boolean}} [opts]
     * @returns {Promise<{added:string[], updated:string[], removed:string[]}>}
     */
    syncHub3sFromDevices(opts?: {
        prune?: boolean;
    }): Promise<{
        added: string[];
        updated: string[];
        removed: string[];
    }>;
    /**
     * `devices` 応答だけからリモコンを config に取り込む (引数不要)。
     * 内部で Hub3 を自動登録してから、各 Hub3 の stateInfo.remoteList を展開する。
     * irType はリモコン側が持っているのでユーザー指定不要。
     * @returns {Promise<{hub3:{added,updated,removed}, remotes:{added,updated}}>}
     */
    syncRemotesFromDevices(): Promise<{
        hub3: {
            added: any;
            updated: any;
            removed: any;
        };
        remotes: {
            added: any;
            updated: any;
        };
    }>;
    /**
     * devices から「Hub3 とその配下リモコン」をフラットに取得 (登録せず一覧だけ)。
     * 対話 add で候補を見せる用途。
     * @returns {Promise<Array<{hub3DeviceUUID:string, hub3Name:string, uuid:string, type:number, alias:string|null}>>}
     */
    listRemotesFromDevices(): Promise<Array<{
        hub3DeviceUUID: string;
        hub3Name: string;
        uuid: string;
        type: number;
        alias: string | null;
    }>>;
    /**
     * server 側 (getRemoteList) のリモコンを config に取り込む (上級/代替経路)。
     * 通常は syncRemotesFromDevices で足りる。
     * @param {string} hub3Name これらのリモコンが属する Hub3 の config 名
     * @param {number} irType 取得するリモコンの irType (例 49152=エアコン)
     * @returns {Promise<{added:string[], updated:string[]}>}
     */
    syncRemotesFromServer(hub3Name: string, irType: number): Promise<{
        added: string[];
        updated: string[];
    }>;
    /**
     * 指定 remote のキー一覧を server から取得して config に書き戻す。
     * @param {string|null} remoteName
     * @returns {Promise<{name:string, keyCount:number}>}
     */
    syncRemoteKeys(remoteName: string | null): Promise<{
        name: string;
        keyCount: number;
    }>;
    /**
     * lock 設定を name から解決。name 省略時は default.lock、
     * 無ければ locks が 1 つだけならそれ。
     */
    resolveLock(name: any): {
        name: any;
        lock: any;
    };
    /**
     * ロック施錠 (name-based, cmd=82)。config を介さない版は {@link SesameHub3#lockDevice}。
     * @param {string|null} [name] ロック名 (null で default.lock)
     * @returns {Promise<object>} pubDeviceStateChange の応答
     */
    lock(name?: string | null): Promise<object>;
    /**
     * ロック解錠 (name-based, cmd=83)。config を介さない版は {@link SesameHub3#unlockDevice}。
     * @param {string|null} [name] ロック名 (null で default.lock)
     * @returns {Promise<object>} pubDeviceStateChange の応答
     */
    unlock(name?: string | null): Promise<object>;
    /**
     * トグル (name-based, cmd=88, cloud のみの合成命令)。
     * @param {string|null} [name] ロック名 (null で default.lock)
     * @returns {Promise<object>}
     */
    toggle(name?: string | null): Promise<object>;
    /**
     * SESAME Bot クリック (name-based, cmd=89)。
     * 注: lock.js の低レベル関数 `botClick(client, params)` とは別物 (こちらは name で解決)。
     * @param {string|null} [name] ロック名 (null で default.lock)
     * @returns {Promise<object>}
     */
    botClick(name?: string | null): Promise<object>;
    /**
     * デバッグ用: WS の全受信メッセージを購読する (戻り値で unsubscribe)。
     * fire-and-forget な op (autolock 等) のサーバ応答を観測するのに使う。
     * @param {(msg:object)=>void} fn
     * @returns {()=>void} unsubscribe
     */
    onAnyMessage(fn: (msg: object) => void): () => void;
    /** 任意 cmd 直指定 (上級用)。 */
    triggerLockRaw(name: any, cmd: any): Promise<any>;
    /**
     * オートロック設定 (name-based)。解錠 N 秒後に自動施錠。`seconds=0` で無効。
     *
     * ⚠️ 実験的 / 実機未検証: クラウド中継 (Hub3) が autolock(ItemCode 11) を通すかは前例が無い。
     *    公式アプリは BLE で送っている。fire-and-forget (応答待ちしない)。
     *
     * @param {string|null} name ロック名 (null で default.lock)
     * @param {number} seconds 0..65535 (0=無効)
     * @param {number} [timeoutMs] ack 待ちタイムアウト
     * @returns {Promise<{ack:any, cmd:number, seconds:number}>}
     */
    setAutolock(name: string | null, seconds: number, timeoutMs?: number): Promise<{
        ack: any;
        cmd: number;
        seconds: number;
    }>;
    get subUUID(): any;
    /**
     * Hub3 を学習モードに入れ、物理リモコンの 1 ボタンを学習して remote にキー登録。
     *
     * @param {string} remoteName リモコン名
     * @param {string} keyName 登録するキー名
     * @param {{
     *   timeoutMs?: number,        // ボタン押下待ち timeout (default 60s)
     *   onPrompt?: () => void,     // 学習モード突入後に呼ばれる (ユーザに「ボタン押して」と促す)
     * }} [opts]
     * @returns {Promise<{keyUUID: string, captured: any, saved: any}>}
     */
    learnIR(remoteName: string, keyName: string, { timeoutMs, onPrompt }?: {
        timeoutMs?: number;
        onPrompt?: () => void;
    }): Promise<{
        keyUUID: string;
        captured: any;
        saved: any;
    }>;
    listIRRemotes(type: any, { page, pageSize }?: {}): Promise<any>;
    searchPresetIRRemotes(type: any, searchTerm: any): Promise<any>;
    addIRRemoteServer(remoteObj: any): Promise<any>;
    deleteIRRemoteServer(remoteName: any): Promise<any>;
    renameIRRemote(remoteName: any, alias: any): Promise<any>;
    deleteIRKey(remoteName: any, keyOrUUID: any): Promise<any>;
    renameIRKey(remoteName: any, keyOrUUID: any, newName: any): Promise<any>;
    getIRMode(hub3Name: any): Promise<any>;
    setIRMode(hub3Name: any, mode: any): Promise<any>;
    matchIRRemote({ irData, irType, brandName }: {
        irData: any;
        irType: any;
        brandName: any;
    }): Promise<any>;
    _resolveHub3(name: any): any;
    /** 個人ユーザのデバイス一覧 (会社 vs 個人で別 op)。 */
    listUserDevices(): Promise<any[]>;
    getDeviceStatus(deviceUUID: any): Promise<any>;
    /**
     * 読み取った複数 IC カードをクラウド DB へ一括登録する (postCards への委譲)。
     *
     * BLE enroll (`sesame access cards enroll`) で集約した records をそのまま渡せる。
     * cards 要素は BLE 読み取り形 `{cardID, cardName, cardType}` (access.enrolledToCardList が
     * postCards の list 形へ写像する)。既に postCards の list 形を持つ場合は access.postCards を直接使う。
     * @param {string} deviceUUID 対象 Touch の deviceUUID
     * @param {Array<{cardID:string, cardName?:string, cardType?:number}>} cards
     * @returns {Promise<object|null>} postCards 応答 (cards 空なら null)
     */
    registerCards(deviceUUID: string, cards: Array<{
        cardID: string;
        cardName?: string;
        cardType?: number;
    }>): Promise<object | null>;
    renameDevice(deviceUUID: any, deviceName: any): Promise<any>;
    /** company から指定 UUID のデバイスを削除。 */
    deleteDevice(deviceUUID: any): Promise<any>;
    /**
     * @deprecated `onDeviceUpdate(items, fn)` を使ってください (on* イベント命名に統一)。
     * 後方互換のため残置。内部実装は onDeviceUpdate と同一。
     */
    subscribeDeviceUpdates(deviceInfos: any, onUpdate: any): any;
    /**
     * ロック開閉履歴を取得。`list` はデバイス指定の配列。
     *
     * @param {Array<{deviceUUID: string}>} list 履歴を取得するデバイスの配列
     * @param {number} [pageSize] 1ページ件数 (未指定でサーバ既定)
     * @returns {Promise<any>}
     */
    getDeviceHistory(list: Array<{
        deviceUUID: string;
    }>, pageSize?: number): Promise<any>;
    /** 開閉履歴の1エントリを非表示化 (論理削除)。timestamp は getDeviceHistory の各 record の値。 */
    hideDeviceHistory({ deviceUUID, timestamp }: {
        deviceUUID: any;
        timestamp: any;
    }): Promise<any>;
    /** 電池履歴を取得 (1ページ)。lastEvaluatedKey でページング。 */
    getDeviceBattery(deviceUUID: any, { lastEvaluatedKey, pageSize }?: {
        lastEvaluatedKey?: any;
        pageSize?: number;
    }): Promise<any>;
    /** 電池履歴の1エントリを非表示化 (論理削除)。timestampSecond は getDeviceBattery の record.ts。 */
    hideBatteryRecord({ deviceUUID, timestampSecond }: {
        deviceUUID: any;
        timestampSecond: any;
    }): Promise<any>;
    listFirmware(): Promise<any[]>;
    /** WebAPI proxy 経由で REST API を叩く。apiKeyId は config 側に保存。 */
    invokeWebAPI({ func, query, body, apiKeyId }: {
        func: any;
        query: any;
        body: any;
        apiKeyId: any;
    }): Promise<any>;
    /**
     * 直接 lock 制御 (config を介さない, 任意 cmd)。`unlockDevice`/`lockDevice` 等の基底。
     * @param {{deviceUUID:string, secretKey:string, cmd:number, timeoutMs?:number}} p
     *   deviceUUID: ロックの UUID / secretKey: 32hex 共通鍵 (devices で取得) /
     *   cmd: 82=LOCK 83=UNLOCK 88=TOGGLE 89=CLICK
     * @returns {Promise<object>} pubDeviceStateChange の応答
     */
    triggerLockDevice({ deviceUUID, secretKey, cmd, timeoutMs }: {
        deviceUUID: string;
        secretKey: string;
        cmd: number;
        timeoutMs?: number;
    }): Promise<object>;
    /**
     * 直接 解錠 (config を介さない, cmd=83)。
     * @param {{deviceUUID:string, secretKey:string, timeoutMs?:number}} p
     * @returns {Promise<object>} pubDeviceStateChange の応答
     */
    unlockDevice(p: {
        deviceUUID: string;
        secretKey: string;
        timeoutMs?: number;
    }): Promise<object>;
    /**
     * 直接 施錠 (config を介さない, cmd=82)。
     * @param {{deviceUUID:string, secretKey:string, timeoutMs?:number}} p
     * @returns {Promise<object>}
     */
    lockDevice(p: {
        deviceUUID: string;
        secretKey: string;
        timeoutMs?: number;
    }): Promise<object>;
    /**
     * 直接 トグル (config を介さない, cmd=88)。
     * @param {{deviceUUID:string, secretKey:string, timeoutMs?:number}} p
     * @returns {Promise<object>}
     */
    toggleDevice(p: {
        deviceUUID: string;
        secretKey: string;
        timeoutMs?: number;
    }): Promise<object>;
    /**
     * 直接 Bot クリック (config を介さない, cmd=89)。
     * @param {{deviceUUID:string, secretKey:string, timeoutMs?:number}} p
     * @returns {Promise<object>}
     */
    botClickDevice(p: {
        deviceUUID: string;
        secretKey: string;
        timeoutMs?: number;
    }): Promise<object>;
    /**
     * 直接 IR 発射 (config を介さない)。
     * @param {{hub3DeviceId:string, irDeviceUUID:string, irType:number, command:string, operation?:string}} p
     *   hub3DeviceId: Hub3 UUID / irDeviceUUID: リモコン UUID / irType: 例 49152 /
     *   command: keyUUID か 16byte hex / operation: "learnEmit" (default) | "remoteEmit"
     * @returns {Promise<object>} sendIR の応答
     */
    sendIRDirect({ hub3DeviceId, irDeviceUUID, irType, command, operation }: {
        hub3DeviceId: string;
        irDeviceUUID: string;
        irType: number;
        command: string;
        operation?: string;
    }): Promise<object>;
    /**
     * 直接 IR キー一覧取得 (config を介さない)。
     * @param {{hub3DeviceId:string, irDeviceUUID:string}} p
     * @returns {Promise<Array<{name:string, keyUUID:string}>>}
     */
    getIRCodesDirect({ hub3DeviceId, irDeviceUUID }: {
        hub3DeviceId: string;
        irDeviceUUID: string;
    }): Promise<Array<{
        name: string;
        keyUUID: string;
    }>>;
    /** name で指定したロックの state change push を購読。戻り値は unsubscribe。 */
    onLockStateChange(name: any, fn: any): () => void;
    /** UUID 直指定で state change を購読。 */
    onLockStateChangeDevice(deviceUUID: any, fn: any): () => void;
    /**
     * IR 学習データの購読 (受け取った波形を fn に流す)。
     * 内部で setIRMode(REGISTER) → subscribeIRData を発行する。
     *
     * **重要**: 戻り値の async unsubscribe 関数は **必ず `await` してください**。
     * await 忘れで親プロセスが先に終了すると、Hub3 が REGISTER モードに残ります
     * (Review M-1)。`hub.close()` を呼んでも Hub3 側のモードは元に戻りません。
     *
     * 戻り値: async () => Promise<void>  — subscribe 解除 + setIRMode(CONTROL) 復帰
     */
    onIRLearned(hub3Name: any, fn: any): Promise<() => Promise<void>>;
    /**
     * デバイス state push の購読 (複数デバイスまとめて)。
     * @param {{deviceUUID:string, deviceModel?:string}[]} items
     * @param {(msg:any) => void} fn
     */
    onDeviceUpdate(items: {
        deviceUUID: string;
        deviceModel?: string;
    }[], fn: (msg: any) => void): any;
}
/**
 * トークン永続化インターフェース。FileTokenStore がデフォルト実装。
 * 独自実装 (keychain / DB / メモリ) を渡す場合は下記 6 メソッドすべて必須。
 */
export type TokenStore = {
    /**
     * 保存済みトークン {idToken, refreshToken, clientId, accessToken?, deviceKey?} を返す。無ければ null
     */
    load: () => (object | null);
    /**
     * トークンを永続化 (refresh 時に呼ばれる)
     */
    save: (tokens: object) => void;
    /**
     * トークンを破棄
     */
    clear: () => void;
    /**
     * sign-in 進行中の一時状態を返す。無ければ null
     */
    loadPending: () => (object | null);
    /**
     * sign-in 進行中の一時状態を保存
     */
    savePending: (state: object) => void;
    /**
     * sign-in 一時状態を破棄
     */
    clearPending: () => void;
};
import { ConfigStore } from "./config.js";
import { Hub3WsClient } from "./transport.js";
import { LockManager } from "./lock-manager.js";
//# sourceMappingURL=client.d.ts.map