/**
 * config オブジェクトを実行時 shape に正規化する。
 * ConfigStore.load() を通らない embedded 利用でも、保存正準形 `devices` から
 * 互換 view の `locks` / `hub3s` を必ず再投影する。
 *
 * @param {Partial<ConfigData>} raw
 * @returns {LoadedConfig}
 */
export function normalizeConfig(raw?: Partial<ConfigData>): LoadedConfig;
/**
 * ロック系 model か (biz3 lockModelDevices と完全一致, gUtils.js:279-294)。
 * @param {string|null|undefined} model
 * @returns {boolean}
 */
export function isLockModel(model: string | null | undefined): boolean;
/**
 * Hub3 系 model か (hub_3 / hub_3_lte)。
 * @param {string|null|undefined} model
 * @returns {boolean}
 */
export function isHub3Model(model: string | null | undefined): boolean;
export class ConfigStore {
    /**
     * @param {string} configDir
     * @returns {ConfigStore}
     */
    static fromConfigDir(configDir: string): ConfigStore;
    /**
     * @param {string} configPath 絶対パス
     */
    constructor(configPath: string);
    configPath: string;
    /** @type {ConfigData|null} */
    data: ConfigData | null;
    exists(): boolean;
    /**
     * ファイル不在時はメモリ上で空オブジェクトを返す (保存はしない)。
     * @returns {LoadedConfig}
     */
    load(): LoadedConfig;
    save(): void;
    /**
     * 空スケルトンを書き出す。既存があれば触らない。
     * @param {{uiLang?: "en"|"ja", lang?: "en"|"ja"}} [overrides]
     *   init 時に確定している言語設定を焼き込む。`sesame --lang en init` の意図
     *   (UI を英語に) を config に永続化し、次回以降のセッションへ引き継ぐため。
     *   渡さなければ emptyConfig の既定 (lang:"ja", uiLang 未設定) のまま。
     * @returns {boolean} 新規作成したら true
     */
    init(overrides?: {
        uiLang?: "en" | "ja";
        lang?: "en" | "ja";
    }): boolean;
    /**
     * name 省略時は default.remote、無ければ remotes が 1 つだけならそれ。
     * @param {string} [name]
     * @returns {{name: string, remote: RemoteEntry, hub3Name: string, hub3: Hub3View}}
     */
    resolveRemote(name?: string): {
        name: string;
        remote: RemoteEntry;
        hub3Name: string;
        hub3: Hub3View;
    };
    /**
     * @param {string} name
     * @param {{deviceId?: string, name?: string, model?: string, secretKey?: string|null}} hub3
     */
    addHub3(name: string, hub3: {
        deviceId?: string;
        name?: string;
        model?: string;
        secretKey?: string | null;
    }): void;
    /**
     * @param {string} name
     * @param {{hub3?: string, irDeviceUUID?: string, irType?: number|string,
     *          irOperation?: string, alias?: string|null, keys?: Record<string, string>}} remote
     */
    addRemote(name: string, remote: {
        hub3?: string;
        irDeviceUUID?: string;
        irType?: number | string;
        irOperation?: string;
        alias?: string | null;
        keys?: Record<string, string>;
    }): void;
    /** @param {string} name */
    setDefaultRemote(name: string): void;
    /**
     * @param {string} name
     * @param {Record<string, string>} keys
     */
    updateRemoteKeys(name: string, keys: Record<string, string>): void;
    /**
     * name 省略時は default.lock、無ければ locks が 1 つだけならそれ。
     * @param {string} [name]
     * @returns {{name: string, lock: LockView}}
     */
    resolveLock(name?: string): {
        name: string;
        lock: LockView;
    };
    /**
     * @param {string} name
     * @param {{deviceUUID?: string, secretKey?: string, model?: string|null, alias?: string|null}} lock
     */
    addLock(name: string, lock: {
        deviceUUID?: string;
        secretKey?: string;
        model?: string | null;
        alias?: string | null;
    }): void;
    /** @param {string} name */
    setDefaultLock(name: string): void;
    /** @param {string} name */
    removeLock(name: string): void;
    /**
     * `devices` (getCompanyDevice 等) の結果からロックを取り込む (devices{} に丸ごと格納)。
     * @param {DeviceRecord[]} deviceList
     * @param {{prune?:boolean}} [opts]
     * @returns {{added:string[], updated:string[], removed:string[]}}
     */
    syncLocksFromDevices(deviceList: DeviceRecord[], { prune }?: {
        prune?: boolean;
    }): {
        added: string[];
        updated: string[];
        removed: string[];
    };
    /**
     * `devices` の結果から Hub3 を取り込む (deviceModel が hub_3 / hub_3_lte。devices{} に丸ごと格納)。
     * @param {DeviceRecord[]} deviceList
     * @param {{prune?:boolean}} [opts]
     * @returns {{added:string[], updated:string[], removed:string[]}}
     */
    syncHub3sFromDevices(deviceList: DeviceRecord[], { prune }?: {
        prune?: boolean;
    }): {
        added: string[];
        updated: string[];
        removed: string[];
    };
    /**
     * `devices` の応答だけからリモコンを取り込む (引数 irType 不要)。
     *
     * 各 Hub3 デバイスは `stateInfo.remoteList` に配下リモコンを
     * `{uuid, type, alias?}` 付きで持っているので、それを直接展開する。
     * 先に hub3s が登録済みである必要がある (syncHub3sFromDevices を先に呼ぶ)。
     *
     * @param {Array<DeviceRecord & {stateInfo?: {remoteList?: Array<{uuid?: string, irDeviceUUID?: string, type?: number|string, irType?: number|string, alias?: string|null, name?: string|null}>}}>} deviceList  getCompanyDevice / getUserDevice の応答
     * @returns {{added:string[], updated:string[]}}
     */
    syncRemotesFromDevices(deviceList: Array<DeviceRecord & {
        stateInfo?: {
            remoteList?: Array<{
                uuid?: string;
                irDeviceUUID?: string;
                type?: number | string;
                irType?: number | string;
                alias?: string | null;
                name?: string | null;
            }>;
        };
    }>): {
        added: string[];
        updated: string[];
    };
    /**
     * server 側 (getRemoteList) のリモコン一覧から remote 定義を取り込む (上級/代替経路)。
     * 通常は syncRemotesFromDevices で足りる。company 横断の一覧が欲しい場合のみ。
     * @param {Array<{irDeviceUUID?: string, uuid?: string, type?: number|string, irType?: number|string, alias?: string|null, name?: string|null, irOperation?: string}>} remoteList  getRemoteList の応答 (irDeviceUUID/uuid, type, alias/name 等)
     * @param {string} hub3Name   これらのリモコンが属する Hub3 の config 名
     * @returns {{added:string[], updated:string[]}}
     */
    syncRemotesFromServer(remoteList: Array<{
        irDeviceUUID?: string;
        uuid?: string;
        type?: number | string;
        irType?: number | string;
        alias?: string | null;
        name?: string | null;
        irOperation?: string;
    }>, hub3Name: string): {
        added: string[];
        updated: string[];
    };
}
/**
 * config に格納する SESAME device レコード。サーバ応答 (getCompanyDevice 等) を
 * ほぼ丸ごと保存するため未知フィールドも許容する。category はローカル注釈。
 */
export type DeviceRecord = {
    deviceUUID?: string | undefined;
    secretKey?: string | null | undefined;
    deviceModel?: string | null | undefined;
    deviceName?: string | null | undefined;
    /**
     * ローカル注釈 ("lock"/"hub3" など)。view 分類の真実。
     */
    category?: string | undefined;
    /**
     * sanitize で除外されるが incoming では存在しうる。
     */
    stateInfo?: any;
};
/**
 * locks{} の派生 view エントリ (旧 shape)。
 */
export type LockView = {
    deviceUUID: string | undefined;
    secretKey: string | null | undefined;
    model: string | null;
    alias: string | null;
};
/**
 * hub3s{} の派生 view エントリ (旧 shape)。
 */
export type Hub3View = {
    deviceId: string | undefined;
    name: string;
    model: string;
    secretKey: string | null;
};
/**
 * remotes{} のエントリ (IR リモコン定義)。
 */
export type RemoteEntry = {
    /**
     * 親 Hub3 の config 名
     */
    hub3: string;
    irDeviceUUID?: string | undefined;
    irType: number;
    irOperation: string;
    alias?: string | null | undefined;
    /**
     * キー名 → keyUUID
     */
    keys: Record<string, string>;
};
/**
 * default 指定。
 */
export type ConfigDefault = {
    remote: string | null;
    lock: string | null;
};
/**
 * config.json 全体のドメインモデル。
 */
export type ConfigData = {
    companyID?: string | undefined;
    wsUrl?: string | undefined;
    lang?: string | undefined;
    uiLang?: "en" | "ja" | undefined;
    default: ConfigDefault;
    /**
     * 単一の真実: 全 SESAME device。
     */
    devices: Record<string, DeviceRecord>;
    /**
     * IR リモコン群 (device ではない子)。
     */
    remotes: Record<string, RemoteEntry>;
    apiKeyId?: string | null | undefined;
    /**
     * biometrics REST base URL (PERSISTED)。
     */
    biometricsBaseUrl?: string | undefined;
    /**
     * register REST base URL (biometrics fallback)。
     */
    registerBaseUrl?: string | undefined;
    /**
     * devices からの派生 view (保存しない)。
     */
    locks?: Record<string, LockView> | undefined;
    /**
     * devices からの派生 view (保存しない)。
     */
    hub3s?: Record<string, Hub3View> | undefined;
};
/**
 * `load()` 後の config。`load()` は `{...emptyConfig(), ...raw}` で穴埋めし、その後 `_reproject` を
 * 必ず走らせるため、emptyConfig が必ず与えるスカラ (companyID/wsUrl/lang) と派生 view (locks/hub3s)
 * は常に存在する。client.js など読み手はこの型を参照する。
 */
export type LoadedConfig = ConfigData & {
    companyID: string;
    wsUrl: string;
    lang: string;
    locks: Record<string, LockView>;
    hub3s: Record<string, Hub3View>;
};
//# sourceMappingURL=config.d.ts.map