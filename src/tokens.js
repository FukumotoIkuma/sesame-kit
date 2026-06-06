// ファイルシステム実装の TokenStore。auth.js から I/O を分離するための薄いラッパ。
// ライブラリ消費者は独自の実装 (例: keychain, in-memory) に差し替え可能。
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPaths } from "./paths.js";

function readJsonOrNull(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, data) {
  // tokens.json には idToken / refreshToken / deviceKey が入る。multi-user 環境で
  // world-readable にならないよう mode 0600 / 親ディレクトリ 0700 で書き出す (Review M-5)。
  //
  // 注: 以下は POSIX (macOS/Linux) でのみ意味を持つ:
  //   - Windows では fs.writeFileSync の mode は read-only flag に degrade される
  //   - mkdirSync の mode は **新規作成時のみ** 適用される (既存ディレクトリの
  //     パーミッションは変わらない)。旧バージョンで 0755 で作られたディレクトリは
  //     `chmod 700 ~/.config/sesame-kit` で手動修正が必要。
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}

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

  /** 既定の設定ディレクトリから組み立てる。CLI 内部はこれを使う。 */
  static fromConfigDir(configDir) {
    const p = configPaths(configDir);
    return new FileTokenStore({ tokensPath: p.tokens, loginStatePath: p.loginState });
  }

  load() { return readJsonOrNull(this.tokensPath); }
  save(t) { writeJson(this.tokensPath, t); }
  clear() { unlinkIfExists(this.tokensPath); }

  loadPending() { return readJsonOrNull(this.loginStatePath); }
  savePending(s) { writeJson(this.loginStatePath, s); }
  clearPending() { unlinkIfExists(this.loginStatePath); }
}
