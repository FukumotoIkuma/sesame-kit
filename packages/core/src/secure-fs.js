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
  statSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { t } from "./i18n.js";

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
//   - 奪取は「stale 確認(fd ino も記録) → renameSync(lockPath, lockPath.reap.<pid>)
//     → ino 突き合わせ → 退避ファイルを unlink → 再取得試行」。renameSync は
//     原子的なため複数プロセスが同時に stale を観測しても rename 勝者は 1 つだけ。
//     旧実装の unlink 方式では「P1 が O_EXCL 取得済みの新鮮な lock を P2 の遅延
//     unlink が消す二重保持」の窓があったが、rename 方式ではこの窓が閉じている。
//     (P5-12 / R2:ARCH-14)
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
 * stale と判定した場合は、その時点で fd から読んだ inode 番号も返す。
 * 呼び出し元が rename ベースの奪取を行うとき、rename 後に inode を突き合わせて
 * 「stale 判定した inode と rename した inode が同一か」を確認できるようにする
 * (判定と rename の間に別プロセスが新鮮な lock を作っていた場合に検出可能)。
 *
 * @param {string} lockPath
 * @param {number} staleMs
 * @returns {{ stale: true; ino: number } | { stale: false }}
 */
function isLockStale(lockPath, staleMs) {
  // mtime・pid・inode を **同一 fd** から読む (open → fstat → read)。
  // statSync→readFileSync の 2 syscall だと間でファイルが差し替わる TOCTOU が生じるため、
  // 1 つの fd に固定して同じ inode を見る。実排他は withFileLock の O_EXCL acquire が担保し、
  // ここは best-effort の stale 判定に過ぎないが、判定自体も race-free にしておく。
  let fd;
  try {
    fd = openSync(lockPath, "r");
  } catch {
    return { stale: false }; // 既に解放済み → 次の取得試行で普通に取れる
  }
  try {
    const st = fstatSync(fd);
    // mtime が閾値超で古い = 保持プロセスが unlink せず消えたとみなす
    if (Date.now() - st.mtimeMs > staleMs) return { stale: true, ino: st.ino };
    // pid 死活: 記録された保持プロセスが既に存在しなければ mtime が若くても stale。
    // (クラッシュ直後でも staleMs を待たずに回収できる)
    let info;
    try {
      info = /** @type {{ pid?: number }} */ (JSON.parse(readFileSync(fd, "utf8")));
    } catch {
      return { stale: false }; // 読めない/壊れた lock は mtime 判定だけに頼る (書き込み途中の可能性)
    }
    if (typeof info.pid === "number" && info.pid > 0) {
      try {
        process.kill(info.pid, 0); // シグナル 0 = 存在確認のみ
      } catch (e) {
        if (asFsErr(e).code === "ESRCH") return { stale: true, ino: st.ino }; // 保持プロセス消滅
        // EPERM 等 = プロセスは生きている (他ユーザー) → stale ではない
      }
    }
    return { stale: false };
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
  // P5-3: 取得成功時に lock ファイルの inode 番号を保持する。解放時に現 lock の ino と照合し、
  // 一致する場合のみ unlink する。不一致 = 保持中に別プロセスが stale 奪取して新鮮な lock を
  // 書き直した (ino が変わっている) ため、そちらの lock は解放しない (二重保持防止)。
  let acquiredIno = -1;
  for (;;) {
    try {
      // "wx" = O_WRONLY | O_CREAT | O_EXCL — 既存なら EEXIST (原子的な取得)
      const fd = openSync(lockPath, "wx", SECRET_FILE_MODE);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }) + "\n");
        // P5-3: fd を close する前に fstat して ino を記録する (open→fstat = 同一 inode の保証)。
        acquiredIno = fstatSync(fd).ino;
      } finally {
        closeSync(fd);
      }
      break; // 取得成功
    } catch (e) {
      if (asFsErr(e).code !== "EEXIST") throw e;
      const staleResult = isLockStale(lockPath, staleMs);
      if (staleResult.stale) {
        // P5-12: rename ベースの奪取。renameSync は原子的なので、複数プロセスが同時に
        // stale を観測した場合でも rename 勝者は 1 つだけ (敗者は ENOENT)。
        // 旧実装の unlinkSync は「P1 が取得した新鮮な lock を P2 の遅延 unlink が消す」
        // 二重保持の競合窓を持っていた。rename 方式では:
        //   1. 勝者がロック実体を <lockPath>.reap.<pid> へ退避 (rename = atomic)
        //   2. 退避後に inode を突き合わせて stale 判定した inode と同一かを確認
        //      (判定→rename の間に別プロセスが新鮮な lock を書いた場合は ino が異なる)
        //   3. inode 一致なら退避ファイルを unlink して continue(= 次ループで O_EXCL 取得)
        //   4. inode 不一致は「別の保持プロセスの lock を誤って移動した」ため rename 元を復元
        //      (正常系では発生しないが、safety net として)
        //   5. 敗者の rename は ENOENT → continue で通常 retry に戻る
        const reapPath = `${lockPath}.reap.${process.pid}`;
        try {
          renameSync(lockPath, reapPath); // 勝者のみ成功、敗者は ENOENT
          // inode 同一性確認: 判定した stale inode と rename した実体が同一か
          let renamedIno;
          try {
            // fstatSync より statSync で十分 (rename 後は fd ではなくパスで参照)
            renamedIno = statSync(reapPath).ino;
          } catch {
            // stat 失敗は通常起きないが safety net: inode 確認をスキップして unlink へ
          }
          if (renamedIno !== undefined && renamedIno !== staleResult.ino) {
            // stale 判定後・rename 前に別プロセスが lock を書き換えた (inode が違う)
            // → 誤って別プロセスの lock を奪った可能性: 元のパスへ戻して retry に回す
            try { renameSync(reapPath, lockPath); } catch { /* 戻せない場合も stale 回収が後始末 */ }
          } else {
            try { unlinkSync(reapPath); } catch { /* best-effort */ }
          }
        } catch {
          // rename 失敗 (ENOENT = 他プロセスが先に rename 済み) → 通常 retry に戻る
        }
        continue;
      }
      if (Date.now() >= deadline) {
        // P5-1: i18n 化 (元の英語ハードコードを domain.securefs.lockTimeout へ)。
        throw new Error(t("domain.securefs.lockTimeout", { timeoutMs: String(timeoutMs), lockPath }));
      }
      sleepSync(retryIntervalMs);
    }
  }
  try {
    return fn();
  } finally {
    // P5-3: 解放は「自分が取得したロック」に限定する。
    // 保持中にプロセスが suspend されるなど stale 閾値を超えた場合、別プロセス (P2) が
    // stale 奪取して新鮮な lock を書き直す。その後このプロセスが復帰して finally に来たとき、
    // lockPath が指すのは P2 の新鮮な lock (ino が異なる)。無条件 unlink すると P2 の lock が
    // 消え、P3 が O_EXCL 取得して P2 と P3 の二重保持 → tokens.json の lost-update になる。
    // ino 照合により「奪取済み = 自分のロックではない」と判定して unlink をスキップする。
    // 万一 statSync が失敗した場合は安全側に倒してスキップ (既に誰かが unlink 済みの可能性)。
    try {
      if (acquiredIno >= 0) {
        let currentIno;
        try { currentIno = statSync(lockPath).ino; } catch { /* ENOENT 等: ino 不明 → スキップ */ }
        if (currentIno === acquiredIno) {
          try { unlinkSync(lockPath); } catch { /* best-effort */ }
        }
        // currentIno !== acquiredIno (または statSync 失敗): 奪取済みか既に消された → 何もしない
      }
    } catch { /* safety net: 解放エラーは stale 回収で詰まらない */ }
  }
}
