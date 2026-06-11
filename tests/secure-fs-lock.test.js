// secure-fs.js withFileLock: プロセス間ロックの取得/解放/直列化/stale 回収を検証する (P2-8)。
// 「2 プロセス」はテストでは同一プロセス内で擬似する — ロックは O_EXCL のファイル存在で
// 表現されているため、lock ファイルを直接作る/保持中に再取得を試みることで競合を再現できる。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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
        .toThrow(/failed to acquire file lock/);
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
    expect(() => withFileLock(target, () => null, FAST)).toThrow(/failed to acquire file lock/);
    ageLock(lockPath, 60_000);
    expect(withFileLock(target, () => "ok", FAST)).toBe("ok");
  });

  it("staleMs はオプションで上書きできる", () => {
    writeFileSync(lockPath, "{ not json"); // pid 死活チェック不能 → mtime のみで判定
    ageLock(lockPath, 100);
    expect(withFileLock(target, () => "fast-stale", { ...FAST, staleMs: 50 })).toBe("fast-stale");
  });
});
