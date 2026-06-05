/** ロック系 model か (biz3 lockModelDevices と完全一致, gUtils.js:279-294)。 */
export function isLockModel(model: any): boolean;
/** Hub3 系 model か (hub_3 / hub_3_lte)。 */
export function isHub3Model(model: any): boolean;
export class ConfigStore {
    static fromConfigDir(configDir: any): ConfigStore;
    /**
     * @param {string} configPath 絶対パス
     */
    constructor(configPath: string);
    configPath: string;
    data: any;
    exists(): boolean;
    /** ファイル不在時はメモリ上で空オブジェクトを返す (保存はしない)。 */
    load(): any;
    /** devices{} から locks{}/hub3s{} の派生 view (旧 shape) を都度組み立てる。reader 互換用。 */
    _reproject(): void;
    save(): void;
    /** 空スケルトンを書き出す。既存があれば触らない。 */
    init(): boolean;
    /** name 省略時は default.remote、無ければ remotes が 1 つだけならそれ。 */
    resolveRemote(name: any): {
        name: any;
        remote: any;
        hub3Name: any;
        hub3: any;
    };
    addHub3(name: any, hub3: any): void;
    addRemote(name: any, remote: any): void;
    setDefaultRemote(name: any): void;
    updateRemoteKeys(name: any, keys: any): void;
    /** name 省略時は default.lock、無ければ locks が 1 つだけならそれ。 */
    resolveLock(name: any): {
        name: any;
        lock: any;
    };
    addLock(name: any, lock: any): void;
    setDefaultLock(name: any): void;
    removeLock(name: any): void;
    /**
     * @param {Array} deviceList
     * @param {{ accept:(d:object)=>boolean, category:"lock"|"hub3", prune?:boolean,
     *           onFirstAdd?:(name:string)=>void, pruneProtect?:(name:string)=>boolean }} opts
     *   accept  受理条件 (取り込む incoming device の判定)
     *   category この sync が司る view。prune はこの view に属する device だけを対象にする
     * @returns {{added:string[], updated:string[], removed:string[]}}
     */
    _syncDevices(deviceList: any[], { accept, category, prune, onFirstAdd, pruneProtect }: {
        accept: (d: object) => boolean;
        category: "lock" | "hub3";
        prune?: boolean;
        onFirstAdd?: (name: string) => void;
        pruneProtect?: (name: string) => boolean;
    }): {
        added: string[];
        updated: string[];
        removed: string[];
    };
    /**
     * `devices` (getCompanyDevice 等) の結果からロックを取り込む (devices{} に丸ごと格納)。
     * @param {Array} deviceList
     * @param {{prune?:boolean}} [opts]
     * @returns {{added:string[], updated:string[], removed:string[]}}
     */
    syncLocksFromDevices(deviceList: any[], { prune }?: {
        prune?: boolean;
    }): {
        added: string[];
        updated: string[];
        removed: string[];
    };
    /**
     * `devices` の結果から Hub3 を取り込む (deviceModel が hub_3 / hub_3_lte。devices{} に丸ごと格納)。
     * @param {Array} deviceList
     * @param {{prune?:boolean}} [opts]
     * @returns {{added:string[], updated:string[], removed:string[]}}
     */
    syncHub3sFromDevices(deviceList: any[], { prune }?: {
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
     * @param {Array} deviceList  getCompanyDevice / getUserDevice の応答
     * @returns {{added:string[], updated:string[]}}
     */
    syncRemotesFromDevices(deviceList: any[]): {
        added: string[];
        updated: string[];
    };
    /**
     * server 側 (getRemoteList) のリモコン一覧から remote 定義を取り込む (上級/代替経路)。
     * 通常は syncRemotesFromDevices で足りる。company 横断の一覧が欲しい場合のみ。
     * @param {Array} remoteList  getRemoteList の応答 (irDeviceUUID/uuid, type, alias/name 等)
     * @param {string} hub3Name   これらのリモコンが属する Hub3 の config 名
     * @returns {{added:string[], updated:string[]}}
     */
    syncRemotesFromServer(remoteList: any[], hub3Name: string): {
        added: string[];
        updated: string[];
    };
}
//# sourceMappingURL=config.d.ts.map