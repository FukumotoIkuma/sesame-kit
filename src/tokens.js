// ファイルシステム実装の TokenStore。auth.js から I/O を分離するための薄いラッパ。
// ライブラリ消費者は独自の実装 (例: keychain, in-memory) に差し替え可能。
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { configPaths } from "./paths.js";
import { writeSecretJson } from "./secure-fs.js";

/**
 * 永続化されるトークン一式。auth.js が読み書きする形。
 * @typedef {object} StoredTokens
 * @property {string} [clientId] 取得に使った Cognito client ID
 * @property {string} idToken Cognito IdToken (JWT)
 * @property {string} [refreshToken] Cognito RefreshToken
 * @property {string|null} [accessToken] Cognito AccessToken
 * @property {string|null} [deviceKey] 確定済みデバイスキー
 * @property {string|null} [deviceGroupKey] デバイスグループキー
 * @property {string|null} [devicePassword] デバイスパスワード (SRP 用)
 * @property {string|null} [username] ログインユーザー名 (email)
 * @property {string} [lastRefresh] 最終 refresh の ISO timestamp
 */

/**
 * login 途中 (CUSTOM_CHALLENGE 待ち) の一時状態。
 * @typedef {object} PendingLogin
 * @property {string} clientId
 * @property {string} username
 * @property {string} [session] Cognito challenge session
 * @property {string} initiatedAt ISO timestamp
 */

/**
 * トークン永続化の抽象。auth.js が依存する I/O 契約。
 * FileTokenStore のほか keychain / in-memory 実装に差し替え可能。
 * @typedef {object} TokenStore
 * @property {() => StoredTokens|null} load
 * @property {(t: StoredTokens) => void} save
 * @property {() => void} clear
 * @property {() => PendingLogin|null} loadPending
 * @property {(s: PendingLogin) => void} savePending
 * @property {() => void} clearPending
 */

/**
 * @param {string} path
 * @returns {unknown} ファイルが無ければ null。中身は呼び出し側で型付けする。
 */
function readJsonOrNull(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

// tokens.json には idToken / refreshToken / deviceKey が入る。world-readable にならないよう
// mode 0600 / 親ディレクトリ 0700 でアトミックに書く処理は secure-fs.js に一本化した
// (serve デーモンと CLI の同時 refresh でも壊れないアトミック rename もそちら)。
/**
 * @param {string} path
 * @param {unknown} data
 */
function writeJson(path, data) {
  writeSecretJson(path, data);
}

/** @param {string} path */
function unlinkIfExists(path) {
  if (existsSync(path)) unlinkSync(path);
}

export class FileTokenStore {
  /**
   * @param {{ tokensPath: string, loginStatePath: string }} paths
   */
  constructor({ tokensPath, loginStatePath }) {
    if (!tokensPath) throw new Error("tokensPath required");
    if (!loginStatePath) throw new Error("loginStatePath required");
    this.tokensPath = tokensPath;
    this.loginStatePath = loginStatePath;
  }

  /**
   * 既定の設定ディレクトリから組み立てる。CLI 内部はこれを使う。
   * @param {string} [configDir]
   */
  static fromConfigDir(configDir) {
    const p = configPaths(configDir);
    return new FileTokenStore({ tokensPath: p.tokens, loginStatePath: p.loginState });
  }

  /** @returns {StoredTokens|null} */
  load() { return /** @type {StoredTokens|null} */ (readJsonOrNull(this.tokensPath)); }
  /** @param {StoredTokens} t */
  save(t) { writeJson(this.tokensPath, t); }
  clear() { unlinkIfExists(this.tokensPath); }

  /** @returns {PendingLogin|null} */
  loadPending() { return /** @type {PendingLogin|null} */ (readJsonOrNull(this.loginStatePath)); }
  /** @param {PendingLogin} s */
  savePending(s) { writeJson(this.loginStatePath, s); }
  clearPending() { unlinkIfExists(this.loginStatePath); }
}
