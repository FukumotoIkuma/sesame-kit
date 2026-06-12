/**
 * 設定ディレクトリの絶対パスを解決する。
 * @param {string} [overrideDir] 明示指定された設定ディレクトリ (CLI --config-dir)
 * @returns {string} 設定ディレクトリの絶対パス
 */
export function resolveConfigDir(overrideDir?: string): string;
/**
 * @typedef {object} ConfigPaths
 * @property {string} dir 設定ディレクトリ
 * @property {string} config config.json への絶対パス
 * @property {string} tokens tokens.json への絶対パス
 * @property {string} loginState login_state.json への絶対パス
 * @property {string} devices devices.json への絶対パス
 * @property {string} socket `sesame serve` の Unix domain socket パス
 */
/**
 * 設定ディレクトリ配下の各ファイルパスを解決する。
 * @param {string} [overrideDir] 明示指定された設定ディレクトリ
 * @returns {ConfigPaths}
 */
export function configPaths(overrideDir?: string): ConfigPaths;
export type ConfigPaths = {
    /**
     * 設定ディレクトリ
     */
    dir: string;
    /**
     * config.json への絶対パス
     */
    config: string;
    /**
     * tokens.json への絶対パス
     */
    tokens: string;
    /**
     * login_state.json への絶対パス
     */
    loginState: string;
    /**
     * devices.json への絶対パス
     */
    devices: string;
    /**
     * `sesame serve` の Unix domain socket パス
     */
    socket: string;
};
//# sourceMappingURL=paths.d.ts.map