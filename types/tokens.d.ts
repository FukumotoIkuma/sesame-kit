export class FileTokenStore {
    /** 既定の設定ディレクトリから組み立てる。CLI 内部はこれを使う。 */
    static fromConfigDir(configDir: any): FileTokenStore;
    /**
     * @param {{ tokensPath: string, loginStatePath: string }} paths
     */
    constructor({ tokensPath, loginStatePath }: {
        tokensPath: string;
        loginStatePath: string;
    });
    tokensPath: string;
    loginStatePath: string;
    load(): any;
    save(t: any): void;
    clear(): void;
    loadPending(): any;
    savePending(s: any): void;
    clearPending(): void;
}
//# sourceMappingURL=tokens.d.ts.map