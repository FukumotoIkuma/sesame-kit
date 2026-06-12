// secure-fs.js withFileLock: プロセス間ロックの取得/解放/直列化/stale 回収を検証する (P2-8)。
// 「2 プロセス」はテストでは同一プロセス内で擬似する — ロックは O_EXCL のファイル存在で
// 表現されているため、lock ファイルを直接作る/保持中に再取得を試みることで競合を再現できる。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock, SECRET_FILE_MODE, SECRET_DIR_MODE } from "../src/secure-fs.js";

const isPosix = process.platform !== "win32";
const mode = (p) => statSync(p).mode & 0o777;

// リトライを高速化するテスト用オーバーライド (既定: timeout 2s / stale 10s / interval 40ms)
const FAST = { timeoutMs: 200, retryIntervalMs: 10 };

/** lock ファイルの mtime を ms だけ過去にずらす (stale 状態の擬似)。 */
function ageLock(lockPath, ms) {
  const past = new Date(Date.now() - ms);
  utimesSync(lockPath, past, past);
}

let dir;
let target;
let lockPath;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sesame-fslock-"));
  target = join(dir, "tokens.json");
  lockPath = `${target}.lock`;
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("withFileLock 基本動作", () => {
  it("fn を実行して戻り値を返し、終了後に lock ファイルを残さない", () => {
    const result = withFileLock(target, () => "ok");
    expect(result).toBe("ok");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("fn 実行中は lock ファイルが存在し、pid + 取得時刻が記録されている", () => {
    withFileLock(target, () => {
      expect(existsSync(lockPath)).toBe(true);
      const info = JSON.parse(readFileSync(lockPath, "utf8"));
      expect(info.pid).toBe(process.pid);
      expect(typeof info.acquiredAt).toBe("string");
      if (isPosix) expect(mode(lockPath)).toBe(SECRET_FILE_MODE);
    });
  });

  it("fn が throw しても lock は finally で解放され、例外はそのまま伝搬する", () => {
    expect(() => withFileLock(target, () => { throw new Error("boom"); })).toThrow(/boom/);
    expect(existsSync(lockPath)).toBe(false);
    // 解放済みなので次の取得は即成功する
    expect(withFileLock(target, () => 2, FAST)).toBe(2);
  });

  it("親ディレクトリが無くても 0700 で作成してロックできる", () => {
    const deep = join(dir, "a", "b", "tokens.json");
    expect(withFileLock(deep, () => 1)).toBe(1);
    if (isPosix) expect(mode(join(dir, "a", "b"))).toBe(SECRET_DIR_MODE);
  });
});

describe("withFileLock 競合の直列化", () => {
  it("保持中の再取得 (= 別プロセスの割り込み相当) は retry の末タイムアウトする", () => {
    withFileLock(target, () => {
      // ロック保持中: 「もう 1 プロセス」が取得を試みても fn には到達しない
      let entered = false;
      expect(() => withFileLock(target, () => { entered = true; }, FAST))
        // P5-1: メッセージは i18n 化済み。ロック取得失敗の Error であることを確認する。
        .toThrow(/ロックを取得できません|failed to acquire|lockTimeout|以内にファイルロックを取得/);
      expect(entered).toBe(false);
    });
    // 解放後は取得できる = 競合は失敗ではなく「順番待ち→直列実行」になる
    expect(withFileLock(target, () => "after", FAST)).toBe("after");
  });

  it("取得失敗は即エラーではなく retry し、retry 中の状況変化で取得できる (順番待ちの成立)", () => {
    // withFileLock の retry は同期ブロック (Atomics.wait) でイベントループが止まるため、
    // 「retry 中に他プロセスが解放する」状況は時間経過 (stale 化) で擬似する:
    // 取得開始時点では保持中 (age < staleMs) → 数回 retry するうちに staleMs を超え
    // 解放扱いになり取得が成立する。最初の試行で諦めないこと自体の検証。
    writeFileSync(lockPath, "{ pid unknown"); // pid 死活チェック不能 = mtime のみで判定
    const start = Date.now();
    const result = withFileLock(target, () => "queued", { timeoutMs: 2000, retryIntervalMs: 15, staleMs: 120 });
    const elapsed = Date.now() - start;
    expect(result).toBe("queued");
    expect(elapsed).toBeGreaterThanOrEqual(100); // 即時取得ではなく待ってから取れている
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("withFileLock stale 回収", () => {
  it("mtime が staleMs を超えて古い lock は奪取して取得できる (異常終了プロセスの残骸)", () => {
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
    ageLock(lockPath, 60_000); // 既定 staleMs=10s を大きく超過
    const start = Date.now();
    expect(withFileLock(target, () => "stolen")).toBe("stolen");
    expect(Date.now() - start).toBeLessThan(1000); // timeout 待ちせず即奪取
    expect(existsSync(lockPath)).toBe(false);
  });

  it("mtime が若くても保持 pid が既に死んでいれば奪取できる (クラッシュ直後の回収)", () => {
    // 実在したが既に終了したプロセスの pid を得る (pid 再利用の確率は無視できる)
    const dead = spawnSync(process.execPath, ["-e", ""]);
    expect(typeof dead.pid).toBe("number");
    writeFileSync(lockPath, JSON.stringify({ pid: dead.pid, acquiredAt: new Date().toISOString() }));
    expect(withFileLock(target, () => "recovered", FAST)).toBe("recovered");
  });

  it("内容が壊れた lock は mtime 判定のみ: 若ければ保持中とみなしタイムアウト、古ければ奪取", () => {
    writeFileSync(lockPath, "{ not json"); // pid 不明
    // P5-1: メッセージは i18n 化済み。ロック取得失敗の Error であることを確認する。
    expect(() => withFileLock(target, () => null, FAST)).toThrow(/以内にファイルロックを取得できませんでした|failed to acquire file lock/);
    ageLock(lockPath, 60_000);
    expect(withFileLock(target, () => "ok", FAST)).toBe("ok");
  });

  it("staleMs はオプションで上書きできる", () => {
    writeFileSync(lockPath, "{ not json"); // pid 死活チェック不能 → mtime のみで判定
    ageLock(lockPath, 100);
    expect(withFileLock(target, () => "fast-stale", { ...FAST, staleMs: 50 })).toBe("fast-stale");
  });
});

// ---------------------------------------------------------------------------
// P5-12: rename ベース奪取の競合窓閉鎖テスト (R2:ARCH-14)
//
// 旧実装 (unlinkSync) の問題:
//   P1・P2 が同時に stale を観測 → P1 が unlinkSync+O_EXCL 取得済みの後で
//   P2 の遅延 unlinkSync が P1 の新鮮な lock を消す → P2 も O_EXCL 取得 → 二重保持。
//
// 修正 (P5-12):
//   unlinkSync → renameSync(lockPath, lockPath.reap.<pid>) + ino 確認 + unlink。
//   renameSync は原子的なため rename 勝者は 1 つだけ。敗者は ENOENT → continue。
//
// fault-injection 手法:
//   ESM + 静的 import の制約で renameSync 自体はモック不可。
//   代わりに「lock ファイルの状態を手動操作」でインターリーブを模倣する。
// ---------------------------------------------------------------------------
describe("withFileLock rename ベース奪取 (P5-12)", () => {
  it("stale lock (pid=0 = dead) を rename 奪取して取得し、reap 残骸が残らない", () => {
    // pid=0 は kill(0,0) で ESRCH → stale 判定。mtime は若いまま (pid 死活のみで stale)
    writeFileSync(lockPath, JSON.stringify({ pid: 0, acquiredAt: new Date().toISOString() }));
    const result = withFileLock(target, () => "rename-won", { ...FAST, staleMs: 1 });
    expect(result).toBe("rename-won");
    // 完了後 lock が消えている (正常解放)
    expect(existsSync(lockPath)).toBe(false);
    // .reap.<pid> 残骸がない (rename 勝者が unlink 済み)
    const reapFiles = readdirSync(dir).filter((f) => f.includes(".reap."));
    expect(reapFiles.length).toBe(0);
  });

  it("stale rename 奪取後も fn 保持中の再取得はブロックされる (二重保持なし)", () => {
    // stale lock から rename 奪取した後でも O_EXCL ベースの排他は有効であることを確認。
    // これが rename 方式の正しさの核心: 旧実装では奪取後の lock が P2 の遅延 unlink に
    // 消されて二重保持になった。rename 方式では P1 が O_EXCL 取得した lock は P2 が
    // 触れない (renameSync は ENOENT で失敗するため)。
    writeFileSync(lockPath, JSON.stringify({ pid: 0, acquiredAt: new Date().toISOString() }));
    ageLock(lockPath, 60_000); // mtime 超過 + pid=0 → stale

    let p2RanInsideP1 = false;
    withFileLock(target, () => {
      // P1 の fn 保持中: P2 相当の取得試みはタイムアウトするはず
      try {
        withFileLock(target, () => { p2RanInsideP1 = true; }, { timeoutMs: 60, retryIntervalMs: 10 });
      } catch { /* 期待するタイムアウト */ }
    }, FAST);

    // P2 が fn を実行できていない = 二重保持なし
    expect(p2RanInsideP1).toBe(false);
    // P1 解放後は P2 相当が正常に取得できる
    expect(withFileLock(target, () => "sequential-ok", FAST)).toBe("sequential-ok");
  });

  it("fault-injection: stale 奪取競合 — P2 が先に rename した後で P1 が retry して取得できる", () => {
    // 「P2 が P1 より先に renameSync に成功した」状況を手動で模倣:
    //   1. stale lock を置く
    //   2. P2 の動作を模倣: lock を reap パスへ rename し lock ファイルを消す
    //   3. P1 (= withFileLock) を呼ぶ: lock が既にないので最初の O_EXCL が成功
    //
    // これは「P1 の renameSync が ENOENT で失敗 → continue → O_EXCL 成功」のエンドステートと
    // 等価 (lock が消えた状態で再取得に成功する)。
    writeFileSync(lockPath, JSON.stringify({ pid: 0, acquiredAt: new Date().toISOString() }));
    // P2 の rename 奪取を手動再現: lock → reap.P2 → unlink
    const p2ReapPath = `${lockPath}.reap.${process.pid + 1}`;
    renameSync(lockPath, p2ReapPath);
    // P2 が unlink する前に P1 が入ったと仮定 (reap ファイルは残っている)
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(p2ReapPath)).toBe(true);

    // P1: lock がないので O_EXCL 取得成功
    const result = withFileLock(target, () => "p1-after-p2-renamed", FAST);
    expect(result).toBe("p1-after-p2-renamed");
    // lock は P1 の fn 完了後に解放
    expect(existsSync(lockPath)).toBe(false);
    // P2 の reap 残骸は P1 が触らない (P2 が後で unlink するはず)
    expect(existsSync(p2ReapPath)).toBe(true); // P1 は自分の reap パスしか触らない
  });

  it("stale lock を連続して複数回取得できる (各回で reap 残骸が残らない)", () => {
    // rename 奪取を複数回繰り返しても reap ファイルが蓄積しないことを確認
    for (let i = 0; i < 3; i++) {
      writeFileSync(lockPath, JSON.stringify({ pid: 0, acquiredAt: new Date().toISOString() }));
      withFileLock(target, () => {}, { ...FAST, staleMs: 1 });
      const reapFiles = readdirSync(dir).filter((f) => f.includes(".reap."));
      expect(reapFiles.length).toBe(0);
    }
  });
});
