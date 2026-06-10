export class LockManager {
    /**
     * @param {{
     *   getWs: () => (import("./transport.js").Hub3WsClient | null),
     *   getConfig: () => import("./config.js").LoadedConfig,
     *   getSubUUID: () => (string | null),
     *   ensureConnected: () => void,
     * }} accessors
     */
    constructor({ getWs, getConfig, getSubUUID, ensureConnected }: {
        getWs: () => (import("./transport.js").Hub3WsClient | null);
        getConfig: () => import("./config.js").LoadedConfig;
        getSubUUID: () => (string | null);
        ensureConnected: () => void;
    });
    /**
     * 接続済み WS を返す。各 lock 操作は直前に `_ensureConnected()` を呼ぶため、
     * この時点で WS は非 null。型レベルで非 null を確定させるだけのアクセサ (実行時挙動なし)。
     * @returns {import("./transport.js").Hub3WsClient}
     */
    _ws(): import("./transport.js").Hub3WsClient;
    /**
     * lock 設定を name から解決。name 省略時は default.lock、
     * 無ければ locks が 1 つだけならそれ。
     * @param {string|null} [name]
     * @returns {{name: string, lock: import("./config.js").LockView}}
     */
    resolveLock(name?: string | null): {
        name: string;
        lock: import("./config.js").LockView;
    };
    /**
     * name 解決 + 必須フィールド検査 → triggerLock 用 params。
     * @param {string|null} [name]
     * @returns {{deviceId: string, secretKey: string, subUUID: string}}
     */
    _lockParams(name?: string | null): {
        deviceId: string;
        secretKey: string;
        subUUID: string;
    };
    /** ロック施錠 (name-based, cmd=82)。 @param {string|null} [name] */
    lock(name?: string | null): Promise<any>;
    /** ロック解錠 (name-based, cmd=83)。 @param {string|null} [name] */
    unlock(name?: string | null): Promise<any>;
    /** トグル (name-based, cmd=88, cloud のみの合成命令)。 @param {string|null} [name] */
    toggle(name?: string | null): Promise<any>;
    /** SESAME Bot クリック (name-based, cmd=89)。 @param {string|null} [name] */
    botClick(name?: string | null): Promise<any>;
    /** 任意 cmd 直指定 (上級用)。 @param {string|null} name @param {number} cmd */
    triggerRaw(name: string | null, cmd: number): Promise<any>;
    /**
     * オートロック設定 (name-based)。解錠 N 秒後に自動施錠。`seconds=0` で無効。
     * @param {string|null} name ロック名 (null で default.lock)
     * @param {number} seconds 0..65535 (0=無効)
     * @param {number} [timeoutMs] ack 待ちタイムアウト
     */
    setAutolock(name: string | null, seconds: number, timeoutMs?: number): Promise<{
        ack: any;
        cmd: number;
        seconds: number;
    }>;
    /**
     * 直接 lock 制御 (config を介さない, 任意 cmd)。`unlockDevice`/`lockDevice` 等の基底。
     * @param {{deviceUUID:string, secretKey:string, cmd:number, timeoutMs?:number}} p
     */
    triggerDevice({ deviceUUID, secretKey, cmd, timeoutMs }: {
        deviceUUID: string;
        secretKey: string;
        cmd: number;
        timeoutMs?: number;
    }): Promise<any>;
    /** 直接 解錠 (cmd=83)。 @param {{deviceUUID:string, secretKey:string, timeoutMs?:number}} p */
    unlockDevice(p: {
        deviceUUID: string;
        secretKey: string;
        timeoutMs?: number;
    }): Promise<any>;
    /** 直接 施錠 (cmd=82)。 @param {{deviceUUID:string, secretKey:string, timeoutMs?:number}} p */
    lockDevice(p: {
        deviceUUID: string;
        secretKey: string;
        timeoutMs?: number;
    }): Promise<any>;
    /** 直接 トグル (cmd=88)。 @param {{deviceUUID:string, secretKey:string, timeoutMs?:number}} p */
    toggleDevice(p: {
        deviceUUID: string;
        secretKey: string;
        timeoutMs?: number;
    }): Promise<any>;
    /** 直接 Bot クリック (cmd=89)。 @param {{deviceUUID:string, secretKey:string, timeoutMs?:number}} p */
    botClickDevice(p: {
        deviceUUID: string;
        secretKey: string;
        timeoutMs?: number;
    }): Promise<any>;
}
//# sourceMappingURL=lock-manager.d.ts.map