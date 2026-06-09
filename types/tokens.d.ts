export class FileTokenStore {
    /**
     * 既定の設定ディレクトリから組み立てる。CLI 内部はこれを使う。
     * @param {string} [configDir]
     */
    static fromConfigDir(configDir?: string): FileTokenStore;
    /**
     * @param {{ tokensPath: string, loginStatePath: string }} paths
     */
    constructor({ tokensPath, loginStatePath }: {
        tokensPath: string;
        loginStatePath: string;
    });
    tokensPath: string;
    loginStatePath: string;
    /** @returns {StoredTokens|null} */
    load(): StoredTokens | null;
    /** @param {StoredTokens} t */
    save(t: StoredTokens): void;
    clear(): void;
    /** @returns {PendingLogin|null} */
    loadPending(): PendingLogin | null;
    /** @param {PendingLogin} s */
    savePending(s: PendingLogin): void;
    clearPending(): void;
}
/**
 * 永続化されるトークン一式。auth.js が読み書きする形。
 */
export type StoredTokens = {
    /**
     * 取得に使った Cognito client ID
     */
    clientId?: string | undefined;
    /**
     * Cognito IdToken (JWT)
     */
    idToken: string;
    /**
     * Cognito RefreshToken
     */
    refreshToken?: string | undefined;
    /**
     * Cognito AccessToken
     */
    accessToken?: string | null | undefined;
    /**
     * 確定済みデバイスキー
     */
    deviceKey?: string | null | undefined;
    /**
     * デバイスグループキー
     */
    deviceGroupKey?: string | null | undefined;
    /**
     * デバイスパスワード (SRP 用)
     */
    devicePassword?: string | null | undefined;
    /**
     * ログインユーザー名 (email)
     */
    username?: string | null | undefined;
    /**
     * 最終 refresh の ISO timestamp
     */
    lastRefresh?: string | undefined;
};
/**
 * login 途中 (CUSTOM_CHALLENGE 待ち) の一時状態。
 */
export type PendingLogin = {
    clientId: string;
    username: string;
    /**
     * Cognito challenge session
     */
    session?: string | undefined;
    /**
     * ISO timestamp
     */
    initiatedAt: string;
};
/**
 * トークン永続化の抽象。auth.js が依存する I/O 契約。
 * FileTokenStore のほか keychain / in-memory 実装に差し替え可能。
 */
export type TokenStore = {
    load: () => StoredTokens | null;
    save: (t: StoredTokens) => void;
    clear: () => void;
    loadPending: () => PendingLogin | null;
    savePending: (s: PendingLogin) => void;
    clearPending: () => void;
};
//# sourceMappingURL=tokens.d.ts.map