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
     * @typedef {object} UseOpts
     * @property {string} [configDir]
     * @property {boolean} [debug]
     * @property {Partial<ClientConfig>} [config]
     * @property {TokenStore} [tokenStore]
     * @property {ConfigStore | null} [configStore]
     *
     * @param {((hub:SesameHub3) => Promise<any>) | UseOpts} fnOrOpts
     * @param {(hub:SesameHub3) => Promise<any>} [maybeFn]
     */
    static use(fnOrOpts: ((hub: SesameHub3) => Promise<any>) | {
        configDir?: string | undefined;
        debug?: boolean | undefined;
        config?: Partial<import("./config.js").LoadedConfig> | undefined;
        tokenStore?: import("./tokens.js").TokenStore | undefined;
        configStore?: ConfigStore | null | undefined;
    }, maybeFn?: (hub: SesameHub3) => Promise<any>): Promise<any>;
    /**
     * @param {{
     *   config: ClientConfig,
     *   tokenStore: TokenStore,
     *   configStore?: ConfigStore | null,
     *   debug?: boolean,
     * }} args
     */
    constructor({ config, tokenStore, configStore, debug }: {
        config: ClientConfig;
        tokenStore: TokenStore;
        configStore?: ConfigStore | null;
        debug?: boolean;
    });
    /** @type {ClientConfig} */
    _config: ClientConfig;
    _configStore: ConfigStore | null;
    _tokenStore: import("./tokens.js").TokenStore;
    _debug: boolean;
    /** @type {Hub3WsClient | null} */
    _ws: Hub3WsClient | null;
    _subUUID: string | null;
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
    /**
     * companyID を必ず string で返す (DEFAULT_CONFIG / config.load が常に設定するため、
     * 型上 optional でも実体は常に present)。下流モジュールは companyID:string を要求する。
     * @returns {string}
     */
    get _companyID(): string;
    get config(): import("./config.js").LoadedConfig;
    get configStore(): ConfigStore | null;
    get tokenStore(): import("./tokens.js").TokenStore;
    get connected(): boolean;
    /**
     * remote 名 (省略時は default) から remote 定義と親 hub3 をまとめて取得。
     * @param {string} [name]
     */
    resolveRemote(name?: string): {
        name: string;
        remote: RemoteEntry;
        hub3Name: string;
        hub3: Hub3View;
    };
    /** WS 接続を確立。既に接続済みなら何もしない。 */
    connect(): Promise<void>;
    close(): Promise<void>;
    /**
     * 未接続なら throw、接続済みなら非 null の WS client を返す。
     * 呼び出し側はこの戻り値を使うと `this._ws` の null 絞り込みを跨いで保持できる。
     * @returns {Hub3WsClient}
     */
    _ensureConnected(): Hub3WsClient;
    /**
     * ドメインモジュール (純関数集) を namespace オブジェクトに束ねる。
     * companyID/subUUID を既定注入し、各 op を `(params) => fn(ws, {...})` でラップする。
     * @param {Record<string, unknown>} mod
     * @returns {Record<string, (params?: Record<string, unknown>) => unknown>}
     */
    _bindNs(mod: Record<string, unknown>): Record<string, (params?: Record<string, unknown>) => unknown>;
    /** スケジュール (biz3Schedule)。 */
    get schedule(): Record<string, (params?: Record<string, unknown>) => unknown>;
    /** 組織管理 (employee/group/role/device-group/employee-device)。 */
    get org(): Record<string, (params?: Record<string, unknown>) => unknown>;
    /** 会社 (biz3ManageCompany)。 */
    get company(): Record<string, (params?: Record<string, unknown>) => unknown>;
    /** 認証データ (NFC カード/パスコードの WS op)。 */
    get access(): Record<string, (params?: Record<string, unknown>) => unknown>;
    /** IoT cmd (biz3OperateIoT: DFU/LED/リレー/Sesame item)。 */
    get iot(): Record<string, (params?: Record<string, unknown>) => unknown>;
    /** プリセットリモコン command 生成 (remoteEmit, HXD)。 */
    get presetir(): Record<string, (params?: Record<string, unknown>) => unknown>;
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
     * @param {{ timeoutMs?: number }} [opts]
     * @returns {Promise<DeviceInfo[]>}
     */
    listDevices({ timeoutMs }?: {
        timeoutMs?: number;
    }): Promise<DeviceInfo[]>;
    /**
     * configStore が無ければ throw、あれば非 null の ConfigStore を返す。
     * @param {string} op エラーメッセージ用の操作名
     * @returns {ConfigStore}
     */
    _requireConfigStore(op: string): ConfigStore;
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
     * @returns {Promise<{
     *   hub3: {added:string[], updated:string[], removed:string[]},
     *   remotes: {added:string[], updated:string[]},
     * }>}
     */
    syncRemotesFromDevices(): Promise<{
        hub3: {
            added: string[];
            updated: string[];
            removed: string[];
        };
        remotes: {
            added: string[];
            updated: string[];
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
     * @param {string|null} [name]
     */
    resolveLock(name?: string | null): {
        name: string;
        lock: import("./config.js").LockView;
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
     * @param {(msg: import("./transport.js").WsMessage)=>void} fn
     * @returns {()=>void} unsubscribe
     */
    onAnyMessage(fn: (msg: import("./transport.js").WsMessage) => void): () => void;
    /**
     * 任意 cmd 直指定 (上級用)。
     * @param {string|null} name
     * @param {number} cmd
     */
    triggerLockRaw(name: string | null, cmd: number): Promise<any>;
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
    get subUUID(): string | null;
    /**
     * Hub3 を学習モードに入れ、物理リモコンの 1 ボタンを学習して remote にキー登録。
     *
     * @param {string} remoteName リモコン名
     * @param {string} keyName 登録するキー名
     * @param {{
     *   timeoutMs?: number,        // ボタン押下待ち timeout (default 60s)
     *   onPrompt?: () => void,     // 学習モード突入後に呼ばれる (ユーザに「ボタン押して」と促す)
     * }} [opts]
     * @returns {Promise<{keyUUID: string, captured: unknown, saved: unknown}>}
     */
    learnIR(remoteName: string, keyName: string, { timeoutMs, onPrompt }?: {
        timeoutMs?: number;
        onPrompt?: () => void;
    }): Promise<{
        keyUUID: string;
        captured: unknown;
        saved: unknown;
    }>;
    /**
     * @param {number} type irType
     * @param {{ page?: number, pageSize?: number }} [opts]
     */
    listIRRemotes(type: number, { page, pageSize }?: {
        page?: number;
        pageSize?: number;
    }): Promise<{}>;
    /**
     * @param {number} type irType
     * @param {string} searchTerm
     */
    searchPresetIRRemotes(type: number, searchTerm: string): Promise<{}>;
    /** @param {object} remoteObj */
    addIRRemoteServer(remoteObj: object): Promise<{}>;
    /** @param {string} [remoteName] */
    deleteIRRemoteServer(remoteName?: string): Promise<import("./transport.js").WsMessage>;
    /**
     * @param {string} remoteName
     * @param {string} alias
     */
    renameIRRemote(remoteName: string, alias: string): Promise<import("./transport.js").WsMessage>;
    /**
     * @param {string} remoteName
     * @param {string} keyOrUUID
     */
    deleteIRKey(remoteName: string, keyOrUUID: string): Promise<import("./transport.js").WsMessage>;
    /**
     * @param {string} remoteName
     * @param {string} keyOrUUID
     * @param {string} newName
     */
    renameIRKey(remoteName: string, keyOrUUID: string, newName: string): Promise<import("./transport.js").WsMessage>;
    /** @param {string} [hub3Name] */
    getIRMode(hub3Name?: string): Promise<unknown>;
    /**
     * @param {string} hub3Name
     * @param {number} mode ir.MODE の値 (0=CONTROL, 1=REGISTER)
     */
    setIRMode(hub3Name: string, mode: number): Promise<import("./transport.js").WsMessage>;
    /** @param {{ irData: string, irType: number, brandName?: string }} args */
    matchIRRemote({ irData, irType, brandName }: {
        irData: string;
        irType: number;
        brandName?: string;
    }): Promise<any[]>;
    /** @param {string} [name] @returns {import("./config.js").Hub3View} */
    _resolveHub3(name?: string): import("./config.js").Hub3View;
    /** 個人ユーザのデバイス一覧 (会社 vs 個人で別 op)。 */
    listUserDevices(): Promise<any[]>;
    /** @param {string} deviceUUID */
    getDeviceStatus(deviceUUID: string): Promise<object | null>;
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
    /**
     * @param {string} deviceUUID
     * @param {string} deviceName
     */
    renameDevice(deviceUUID: string, deviceName: string): Promise<import("./transport.js").WsMessage>;
    /**
     * company から指定 UUID のデバイスを削除。
     * @param {string} deviceUUID
     */
    deleteDevice(deviceUUID: string): Promise<import("./transport.js").WsMessage>;
    /**
     * @deprecated `onDeviceUpdate(items, fn)` を使ってください (on* イベント命名に統一)。
     * 後方互換のため残置。内部実装は onDeviceUpdate と同一。
     * @param {{deviceUUID:string, deviceModel?:string}[]} deviceInfos
     * @param {(msg:any) => void} onUpdate
     */
    subscribeDeviceUpdates(deviceInfos: {
        deviceUUID: string;
        deviceModel?: string;
    }[], onUpdate: (msg: any) => void): () => void;
    /**
     * ロック開閉履歴を取得。`list` はデバイス指定の配列。
     *
     * @param {Array<{deviceUUID: string}>} list 履歴を取得するデバイスの配列
     * @param {number} [pageSize] 1 ページあたりの件数 (未指定でサーバ既定)
     * @returns {Promise<any>}
     */
    getDeviceHistory(list: Array<{
        deviceUUID: string;
    }>, pageSize?: number): Promise<any>;
    /**
     * 開閉履歴の1エントリを非表示化 (論理削除)。timestamp は getDeviceHistory の各 record の値。
     * @param {{ deviceUUID: string, timestamp: number }} args
     */
    hideDeviceHistory({ deviceUUID, timestamp }: {
        deviceUUID: string;
        timestamp: number;
    }): Promise<import("./transport.js").WsMessage>;
    /**
     * 電池履歴を取得 (1ページ)。lastEvaluatedKey でページング。
     * @param {string} deviceUUID
     * @param {{ lastEvaluatedKey?: unknown, pageSize?: number }} [opts]
     */
    getDeviceBattery(deviceUUID: string, { lastEvaluatedKey, pageSize }?: {
        lastEvaluatedKey?: unknown;
        pageSize?: number;
    }): Promise<{}>;
    /**
     * 電池履歴の1エントリを非表示化 (論理削除)。timestampSecond は getDeviceBattery の record.ts。
     * @param {{ deviceUUID: string, timestampSecond: number }} args
     */
    hideBatteryRecord({ deviceUUID, timestampSecond }: {
        deviceUUID: string;
        timestampSecond: number;
    }): Promise<import("./transport.js").WsMessage>;
    listFirmware(): Promise<any[]>;
    /**
     * WebAPI proxy 経由で REST API を叩く。apiKeyId は config 側に保存。
     * @param {{ func: string, query?: object, body?: object, apiKeyId?: string }} args
     */
    invokeWebAPI({ func, query, body, apiKeyId }: {
        func: string;
        query?: object;
        body?: object;
        apiKeyId?: string;
    }): Promise<unknown>;
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
    /**
     * name で指定したロックの state change push を購読。戻り値は unsubscribe。
     * @param {string|null} name
     * @param {(msg: import("./transport.js").WsMessage)=>void} fn
     */
    onLockStateChange(name: string | null, fn: (msg: import("./transport.js").WsMessage) => void): () => void;
    /**
     * UUID 直指定で state change を購読。
     * @param {string|undefined} deviceUUID
     * @param {(msg: import("./transport.js").WsMessage)=>void} fn
     */
    onLockStateChangeDevice(deviceUUID: string | undefined, fn: (msg: import("./transport.js").WsMessage) => void): () => void;
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
    /**
     * @param {string} hub3Name
     * @param {(data: unknown)=>void} fn
     * @returns {Promise<() => Promise<void>>}
     */
    onIRLearned(hub3Name: string, fn: (data: unknown) => void): Promise<() => Promise<void>>;
    /**
     * デバイス state push の購読 (複数デバイスまとめて)。
     * @param {{deviceUUID:string, deviceModel?:string}[]} items
     * @param {(msg:any) => void} fn
     */
    onDeviceUpdate(items: {
        deviceUUID: string;
        deviceModel?: string;
    }[], fn: (msg: any) => void): () => void;
}
/**
 * トークン永続化インターフェース。FileTokenStore がデフォルト実装。
 * 正準定義は tokens.js にある (load/save/clear + loadPending/savePending/clearPending)。
 */
export type TokenStore = import("./tokens.js").TokenStore;
/**
 * 高レベルクライアントが扱う設定。`load()` 後は locks/hub3s が必ず存在するため
 * LoadedConfig を採用する (LockManager もこの形を要求する)。
 */
export type ClientConfig = import("./config.js").LoadedConfig;
/**
 * getCompanyDevice 応答 1 件。正準定義は config.js の DeviceRecord。
 */
export type DeviceInfo = import("./config.js").DeviceRecord;
/**
 * IR リモコンキー 1 件 (listKeys / getIRCodes の戻り)。
 */
export type IRKey = {
    name: string;
    keyUUID: string;
};
import { ConfigStore } from "./config.js";
import { Hub3WsClient } from "./transport.js";
import { LockManager } from "./lock-manager.js";
//# sourceMappingURL=client.d.ts.map