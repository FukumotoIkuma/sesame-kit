export class LockManager {
    /**
     * @param {{
     *   getWs: () => (import("./transport.js").Hub3WsClient | null),
     *   getConfig: () => object,
     *   getSubUUID: () => (string | null),
     *   ensureConnected: () => void,
     * }} accessors
     */
    constructor({ getWs, getConfig, getSubUUID, ensureConnected }: {
        getWs: () => (import("./transport.js").Hub3WsClient | null);
        getConfig: () => object;
        getSubUUID: () => (string | null);
        ensureConnected: () => void;
    });
    /**
     * lock 設定を name から解決。name 省略時は default.lock、
     * 無ければ locks が 1 つだけならそれ。
     */
    resolveLock(name: any): {
        name: any;
        lock: any;
    };
    /** name 解決 + 必須フィールド検査 → triggerLock 用 params。 */
    _lockParams(name: any): {
        deviceId: any;
        secretKey: any;
        subUUID: string;
    };
    /** ロック施錠 (name-based, cmd=82)。 */
    lock(name: any): Promise<any>;
    /** ロック解錠 (name-based, cmd=83)。 */
    unlock(name: any): Promise<any>;
    /** トグル (name-based, cmd=88, cloud のみの合成命令)。 */
    toggle(name: any): Promise<any>;
    /** SESAME Bot クリック (name-based, cmd=89)。 */
    botClick(name: any): Promise<any>;
    /** 任意 cmd 直指定 (上級用)。 */
    triggerRaw(name: any, cmd: any): Promise<any>;
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
    /** 直接 解錠 (cmd=83)。 */
    unlockDevice(p: any): Promise<any>;
    /** 直接 施錠 (cmd=82)。 */
    lockDevice(p: any): Promise<any>;
    /** 直接 トグル (cmd=88)。 */
    toggleDevice(p: any): Promise<any>;
    /** 直接 Bot クリック (cmd=89)。 */
    botClickDevice(p: any): Promise<any>;
}
//# sourceMappingURL=lock-manager.d.ts.map