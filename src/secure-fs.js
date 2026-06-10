// 秘匿ファイルの安全な書き込みを 1 箇所に集約する横断ユーティリティ。
//
// config.json (ロックの secretKey 平文)、tokens.json (idToken/refreshToken)、
// devices.json (secretKey)、login_state.json など「鍵が入るファイル」は
// すべて mode 0600 / 親ディレクトリ 0700 で書く必要がある。以前はこのパターンが
// tokens.js / config.js / cli.js に個別実装で散っており、cli.js の init/devices/migrate
// では mode 指定が漏れて world-readable (0644/0755) になっていた。ここへ一本化する。
//
// POSIX (macOS/Linux) 専用のセマンティクス:
//   - Windows では fs の mode は read-only flag へ degrade される。
//   - mkdirSync の mode は **新規作成時のみ** 反映される (既存ディレクトリの
//     パーミッションは変えない)。旧バージョンで 0755 で作られたディレクトリは
//     `chmod 700 ~/.config/sesame-kit` で手動修正が必要。
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** 秘匿ファイルのパーミッション。鍵入りファイルは所有者のみ読み書き可。 */
export const SECRET_FILE_MODE = 0o600;
/** 設定ディレクトリのパーミッション。所有者のみアクセス可。 */
export const SECRET_DIR_MODE = 0o700;

/**
 * ディレクトリを所有者専用 (0700) で用意する (recursive)。
 * @param {string} dir
 * @returns {string} dir
 */
export function ensureSecureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: SECRET_DIR_MODE });
  return dir;
}

/**
 * 秘匿ファイルをアトミック (temp→rename) かつ 0600 で書き込む。親ディレクトリは 0700 で用意。
 * アトミック書き込みにより、複数プロセス (serve デーモンと CLI) が同じファイルを
 * 同時更新しても半端な内容で壊れない (rename は POSIX で atomic)。
 * @param {string} path
 * @param {string} contents
 */
export function writeSecretFile(path, contents) {
  ensureSecureDir(dirname(path));
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, contents, { mode: SECRET_FILE_MODE });
  renameSync(tmp, path);
}

/**
 * オブジェクトを整形 JSON として秘匿ファイルに書き込む (writeSecretFile の薄いラッパ)。
 * @param {string} path
 * @param {*} obj
 */
export function writeSecretJson(path, obj) {
  writeSecretFile(path, JSON.stringify(obj, null, 2) + "\n");
}

/**
 * 既存ファイルのパーミッションを 0600 に締める (copyFileSync 後など、内容を書き換えずに
 * mode だけ直したいとき用)。非 POSIX 等で失敗しても致命でないため握りつぶす。
 * @param {string} path
 */
export function restrictSecretFile(path) {
  try { chmodSync(path, SECRET_FILE_MODE); } catch { /* 非 POSIX / 権限なし: best-effort */ }
}
