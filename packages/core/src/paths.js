// 設定ディレクトリ解決。優先順位:
//   1. 明示渡し (overrideDir, CLI --config-dir)
//   2. env SESAME_KIT_HOME (アプリ専用)
//   3. env XDG_CONFIG_HOME → $XDG_CONFIG_HOME/sesame-kit
//   4. ~/.config/sesame-kit
//
// プラットフォームサポート:
//   macOS / Linux のみ正式サポート。Windows (win32) は設定パス (%APPDATA%)
//   および 0600 ファイルパーミッション (秘密鍵保護) が非対応のため、
//   サポート対象外です。起動時に一度だけ警告を出力します。
import { homedir } from "node:os";
import { resolve } from "node:path";

const APP_DIRNAME = "sesame-kit";

// win32 起動警告 — 1 回だけ出す。
let _win32WarnEmitted = false;

/**
 * 現在のプロセスが win32 上で動作しているかを返す。
 * テストで process.platform を stub するため関数化している。
 * @returns {boolean}
 */
export function _isWin32() {
  return process.platform === "win32";
}

/**
 * Windows 環境で sesame-kit が起動された場合に警告を 1 回だけ出力する。
 * - 設定パス (XDG / POSIX 前提) が Windows の %APPDATA% に非対応。
 * - tokens.json / config.json の 0600 パーミッション保護が Windows 非対応
 *   (secure-fs が mode degrade を自認している)。
 * テスト用に export しているが、公開 API ではない。
 * @internal
 */
export function _warnIfWin32() {
  if (!_isWin32()) return;
  if (_win32WarnEmitted) return;
  _win32WarnEmitted = true;
  // eslint-disable-next-line no-console
  console.error(
    "[sesame-kit] Windows is not supported: config paths (XDG/POSIX) and " +
      "file-permission security (0600 for tokens/secrets) do not work on win32. " +
      "Use macOS or Linux. See docs/platform-roadmap.md for the roadmap."
  );
}

/**
 * テスト用: _win32WarnEmitted フラグをリセットする。
 * @internal
 */
export function _resetWin32WarnState() {
  _win32WarnEmitted = false;
}

/**
 * 設定ディレクトリの絶対パスを解決する。
 * Windows (win32) では起動時に警告を 1 回出力する (サポート対象外)。
 * @param {string} [overrideDir] 明示指定された設定ディレクトリ (CLI --config-dir)
 * @returns {string} 設定ディレクトリの絶対パス
 */
export function resolveConfigDir(overrideDir) {
  _warnIfWin32();
  if (overrideDir) return resolve(overrideDir);
  if (process.env.SESAME_KIT_HOME) return resolve(process.env.SESAME_KIT_HOME);
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return resolve(xdg, APP_DIRNAME);
  return resolve(homedir(), ".config", APP_DIRNAME);
}

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
export function configPaths(overrideDir) {
  const dir = resolveConfigDir(overrideDir);
  return {
    dir,
    config: resolve(dir, "config.json"),
    tokens: resolve(dir, "tokens.json"),
    loginState: resolve(dir, "login_state.json"),
    devices: resolve(dir, "devices.json"),
    // `sesame serve` の Unix domain socket (POSIX 専用。dir 自体が 0700)。
    socket: resolve(dir, "sesame.sock"),
  };
}
