// ファイルシステム実装の TokenStore。auth.js から I/O を分離するための薄いラッパ。
// ライブラリ消費者は独自の実装 (例: keychain, in-memory) に差し替え可能。
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { configPaths } from "./paths.js";
import { withFileLock, writeSecretJson } from "./secure-fs.js";

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

/**
 * JWT を decode して exp を返す (秒、UNIX時間)。失敗時は 0。
 * auth.js:75 の jwtExp と同じロジック (非公開関数のためここに最小限を複製)。
 * @param {string|undefined|null} token
 * @returns {number}
 */
function jwtExpSec(token) {
  if (!token) return 0;
  try {
    const payload = token.split(".")[1];
    const json = Buffer.from(payload, "base64").toString("utf8");
    return Number(JSON.parse(json).exp) || 0;
  } catch {
    return 0;
  }
}

/**
 * トークン一式の「新しさ」を ms で返す。比較専用 (絶対時刻としては使わない)。
 *   1. lastRefresh (auth.js が save のたびに now を入れる ISO timestamp)
 *   2. idToken の exp claim (同一プールの idToken は有効期間が一定なので
 *      exp の大小 = 発行時刻の大小。lastRefresh を欠く外部 store 由来でも比較可能)
 * の大きい方。どちらも無ければ 0 (= 新しさ不明)。
 * @param {StoredTokens|null} t
 * @returns {number}
 */
function tokenFreshnessMs(t) {
  if (!t) return 0;
  let ms = 0;
  if (typeof t.lastRefresh === "string") {
    const parsed = Date.parse(t.lastRefresh);
    if (!Number.isNaN(parsed)) ms = parsed;
  }
  return Math.max(ms, jwtExpSec(t.idToken) * 1000);
}

// merge 規則 (P2-8 / ARCH-13 — プロセス間 lost-update 防止):
//
// serve デーモンと CLI が同じ tokens.json を共有するため、「デーモンが refresh して
// rotation 済み refreshToken を保存 → 古いスナップショットを持つ CLI が save」の順で
// 新トークンが巻き戻り、rotation 環境では Invalid Refresh Token → 再ログイン要求になる。
// save はロック内で「ディスクを読み直し → merge → 書き込み」して これを防ぐ。
//
//   1. 基本は incoming (呼び出し側が保存しようとした内容) を正とする。呼び出し側の
//      意図的な変更 (deviceKey の null 化 = 再ログイン誘導、username 更新 等) を
//      ディスク値で上書きしない。incoming が持たないフィールドも復活させない
//      (clear 相当の「フィールドを落とす」保存を merge が妨げない)。
//   2. 例外: ディスク側の方が「新しい」(tokenFreshnessMs が厳密に大きい) 場合、
//      認証トークン 4 点 idToken / accessToken / refreshToken / lastRefresh だけは
//      ディスク値を保持する。古いスナップショット由来の save が rotation 済み
//      refreshToken / 再発行済み idToken を巻き戻さないための核心ルール。
//      新しさの同値 (typ. 同一スナップショット) や判定不能 (両者とも timestamp 無し)
//      では incoming が全面的に勝つ — 従来の「save = 上書き」挙動を維持する。
//   3. deviceKey / deviceGroupKey / devicePassword は merge 保護の対象外 (常に
//      incoming 優先)。refresh 失敗時に意図的に null 化して再ログインへ誘導する
//      経路があり、「巻き戻り」と「意図的リセット」をフィールド値だけでは区別
//      できないため。refresh での device rotation は token rotation と同時に
//      起こる稀ケースで、その save は常に最新 (規則 2 の例外側に入らない)。
//   4. ディスクが壊れた JSON の場合は merge せず incoming で上書き回復する
//      (save まで SyntaxError で死ぬと破損から復旧する手段が clear しかなくなる)。
/**
 * @param {StoredTokens|null} disk ロック内で読み直したディスク上の現在値
 * @param {StoredTokens} incoming 呼び出し側が保存しようとした内容
 * @returns {StoredTokens}
 */
function mergeStoredTokens(disk, incoming) {
  if (!disk) return incoming;
  if (tokenFreshnessMs(disk) <= tokenFreshnessMs(incoming)) return incoming; // 規則 2 後段
  /** @type {StoredTokens} */
  const merged = { ...incoming };
  // 規則 2: 新しい認証トークンを巻き戻さない (ディスク側が欠くフィールドは触らない)
  if (disk.idToken !== undefined) merged.idToken = disk.idToken;
  if (disk.accessToken !== undefined) merged.accessToken = disk.accessToken;
  if (disk.refreshToken !== undefined) merged.refreshToken = disk.refreshToken;
  if (disk.lastRefresh !== undefined) merged.lastRefresh = disk.lastRefresh;
  return merged;
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

  /**
   * ロック内で「ディスク再読 → merge → アトミック書き込み」する。
   * merge 規則は mergeStoredTokens のコメント参照 (lost-update 防止の核心)。
   * @param {StoredTokens} t
   */
  save(t) {
    withFileLock(this.tokensPath, () => {
      /** @type {StoredTokens|null} */
      let disk = null;
      try {
        disk = this.load();
      } catch {
        // 規則 4: 破損ファイルは merge 対象にせず incoming で上書き回復する
      }
      writeJson(this.tokensPath, mergeStoredTokens(disk, t));
    });
  }

  /**
   * tokens.json を削除する。save (load→merge→write) と同じロックで直列化し、
   * 「clear 中に他プロセスの save が割り込んで中途半端に復活する」競合を防ぐ。
   */
  clear() {
    withFileLock(this.tokensPath, () => { unlinkIfExists(this.tokensPath); });
  }

  /** @returns {PendingLogin|null} */
  loadPending() { return /** @type {PendingLogin|null} */ (readJsonOrNull(this.loginStatePath)); }
  /** @param {PendingLogin} s */
  savePending(s) { writeJson(this.loginStatePath, s); }
  clearPending() { unlinkIfExists(this.loginStatePath); }
}
