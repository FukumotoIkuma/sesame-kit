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
//     パーミッションは変えない) ため、作成後に明示 chmod して旧バージョンの 0755 も締める。
import {
  chmodSync, closeSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync,
  unlinkSync, writeFileSync, writeSync,
} from "node:fs";
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
  try { chmodSync(dir, SECRET_DIR_MODE); } catch { /* 非 POSIX / 権限なし: best-effort */ }
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
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, contents, { mode: SECRET_FILE_MODE });
    restrictSecretFile(tmp);
    renameSync(tmp, path);
    restrictSecretFile(path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
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

// ---------------------------------------------------------------------------
// プロセス間ファイルロック (P2-8 / ARCH-13)
//
// serve デーモン常駐 + CLI 併用が公式ユースケースのため、tokens.json のような
// load-modify-save の系列はプロセスを跨いで競合し得る。writeSecretFile の
// atomic rename は「半端な内容での破損」を防ぐだけで、デーモンが refresh した
// 直後に古いメモリ内容を持つ CLI が save する lost-update (新 refreshToken の
// 巻き戻り → rotation 環境では Invalid Refresh Token) は防げない。
// ここで load→merge→save の系列全体を覆う advisory lock を提供する。
//
// 方式: `<path>.lock` を O_CREAT|O_EXCL (openSync の "wx") で作成 = 取得。
//   - O_EXCL はファイルシステム上で原子的なので、複数プロセスが同時に試みても
//     取得できるのは 1 プロセスだけ。
//   - lock ファイルには pid + 取得時刻を JSON で書く (デバッグ + stale 判定用)。
//   - 解放は finally で unlink (fn が throw しても必ず解放)。
//   - 保持プロセスが unlink 前に異常終了した場合に備えて stale 判定を持つ:
//     mtime が staleMs (既定 10s) を超えて古い、または記録された pid が既に
//     存在しない (kill(pid,0) が ESRCH) なら放棄されたとみなして奪取する。
//     これによりクラッシュしたプロセスのロックで永久に詰まることはない。
//   - 奪取は「再 stat で stale を確認 → unlink → 再取得試行」。stat と unlink の
//     間に第三のプロセスが奪取+再取得を完了する理論上の窓は残るが、窓は ms
//     オーダーで staleMs は 10s なので実害はない (advisory lock として十分)。
// ---------------------------------------------------------------------------

/** ロック放棄とみなす閾値 (ms)。正常な load-merge-save は数 ms で終わる。 */
const LOCK_STALE_MS = 10_000;
/** ロック取得リトライの間隔 (ms)。 */
const LOCK_RETRY_INTERVAL_MS = 40;
/** ロック取得を諦めるまでの総待ち時間 (ms)。 */
const LOCK_TIMEOUT_MS = 2_000;

// 同期 sleep。busy-wait で CPU を焼かないよう Atomics.wait を使う
// (Node のメインスレッドではタイムアウト付き wait が許可されている)。
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
/** @param {number} ms */
function sleepSync(ms) {
  Atomics.wait(sleepCell, 0, 0, ms);
}

/**
 * catch 節の unknown を `{ code? }` として安全に読むためのナロー化。
 * @param {unknown} e
 * @returns {{ code?: string }}
 */
function asFsErr(e) {
  return /** @type {{ code?: string }} */ (e ?? {});
}

/**
 * 既存 lock が放棄されたものか判定する。
 * @param {string} lockPath
 * @param {number} staleMs
 * @returns {boolean}
 */
function isLockStale(lockPath, staleMs) {
  // mtime と pid を **同一 fd** から読む (open → fstat → read)。statSync→readFileSync の
  // 2 syscall だと間でファイルが差し替わる TOCTOU (js/file-system-race) が生じるため、
  // 1 つの fd に固定して同じ inode を見る。実排他は withFileLock の O_EXCL acquire が担保し、
  // ここは best-effort の stale 判定に過ぎないが、判定自体も race-free にしておく。
  let fd;
  try {
    fd = openSync(lockPath, "r");
  } catch {
    return false; // 既に解放済み → 次の取得試行で普通に取れる
  }
  try {
    // mtime が閾値超で古い = 保持プロセスが unlink せず消えたとみなす
    if (Date.now() - fstatSync(fd).mtimeMs > staleMs) return true;
    // pid 死活: 記録された保持プロセスが既に存在しなければ mtime が若くても stale。
    // (クラッシュ直後でも staleMs を待たずに回収できる)
    let info;
    try {
      info = /** @type {{ pid?: number }} */ (JSON.parse(readFileSync(fd, "utf8")));
    } catch {
      return false; // 読めない/壊れた lock は mtime 判定だけに頼る (書き込み途中の可能性)
    }
    if (typeof info.pid === "number" && info.pid > 0) {
      try {
        process.kill(info.pid, 0); // シグナル 0 = 存在確認のみ
      } catch (e) {
        if (asFsErr(e).code === "ESRCH") return true; // 保持プロセス消滅
        // EPERM 等 = プロセスは生きている (他ユーザー) → stale ではない
      }
    }
    return false;
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * `<path>.lock` による advisory lock の下で fn を実行する。
 * load-modify-save の系列をプロセス間で直列化したいとき (tokens.json 等) に使う。
 *
 * @template T
 * @param {string} path ロック対象 (実体ファイル)。lock は `<path>.lock` に作られる。
 * @param {() => T} fn ロック保持中に実行する処理。
 * @param {{ timeoutMs?: number, staleMs?: number, retryIntervalMs?: number }} [opts]
 *   テスト等で待ち時間を縮めるためのオーバーライド。
 * @returns {T} fn の戻り値。
 * @throws {Error} timeoutMs 以内にロックを取得できなかった場合。
 */
export function withFileLock(path, fn, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? LOCK_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const retryIntervalMs = opts.retryIntervalMs ?? LOCK_RETRY_INTERVAL_MS;
  const lockPath = `${path}.lock`;
  // lock ファイル自体も設定ディレクトリ内に作るので、親を 0700 で用意しておく
  ensureSecureDir(dirname(path));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      // "wx" = O_WRONLY | O_CREAT | O_EXCL — 既存なら EEXIST (原子的な取得)
      const fd = openSync(lockPath, "wx", SECRET_FILE_MODE);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }) + "\n");
      } finally {
        closeSync(fd);
      }
      break; // 取得成功
    } catch (e) {
      if (asFsErr(e).code !== "EEXIST") throw e;
      if (isLockStale(lockPath, staleMs)) {
        // 放棄された lock を奪取して即再試行 (unlink 失敗 = 他プロセスが先に
        // 奪取しただけなので無視してよい)
        try { unlinkSync(lockPath); } catch { /* 競合奪取: 次の試行で解決 */ }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`failed to acquire file lock within ${timeoutMs}ms: ${lockPath} (held by another process?)`);
      }
      sleepSync(retryIntervalMs);
    }
  }
  try {
    return fn();
  } finally {
    // 異常系でも必ず解放する。万一 unlink に失敗しても stale 回収で詰まらない。
    try { unlinkSync(lockPath); } catch { /* best-effort */ }
  }
}
