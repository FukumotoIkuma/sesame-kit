/**
 * 現在のプロセスが win32 上で動作しているかを返す。
 * テストで process.platform を stub するため関数化している。
 * @returns {boolean}
 */
export function _isWin32(): boolean;
/**
 * Windows 環境で sesame-kit が起動された場合に警告を 1 回だけ出力する。
 * - 設定パス (XDG / POSIX 前提) が Windows の %APPDATA% に非対応。
 * - tokens.json / config.json の 0600 パーミッション保護が Windows 非対応
 *   (secure-fs が mode degrade を自認している)。
 * テスト用に export しているが、公開 API ではない。
 * @internal
 */
export function _warnIfWin32(): void;
/**
 * テスト用: _win32WarnEmitted フラグをリセットする。
 * @internal
 */
export function _resetWin32WarnState(): void;
/**
 * 設定ディレクトリの絶対パスを解決する。
 * Windows (win32) では起動時に警告を 1 回出力する (サポート対象外)。
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