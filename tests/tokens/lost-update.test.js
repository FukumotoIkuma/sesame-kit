// FileTokenStore の lost-update 防止 (P2-8 / ARCH-13) を検証する。
// 「serve デーモン (A) と CLI (B) の併用」をテストでは同一プロセス内の 2 つの
// store インスタンス (同じ tokens.json を指す) で擬似する — 競合の本質は
// 「古いメモリスナップショットからの save」であり、それはプロセス境界なしで再現できる。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTokenStore } from "../../src/tokens.js";

/** exp claim だけ持つ最小の擬似 JWT を作る (tokens.js の jwtExpSec が読める形)。 */
function fakeJwt(expSec) {
  const payload = Buffer.from(JSON.stringify({ exp: expSec })).toString("base64");
  return `eyJhbGciOiJub25lIn0.${payload}.sig`;
}

const T0 = "2026-06-12T00:00:00.000Z"; // 古い refresh 時刻
const T1 = "2026-06-12T00:01:00.000Z"; // 新しい refresh 時刻 (デーモンの rotation 後)

let workDir;
let tokensPath;
let storeA; // serve デーモン相当
let storeB; // CLI 相当 (同じファイルを指す別インスタンス)

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "sesame-lostupdate-"));
  tokensPath = join(workDir, "tokens.json");
  const loginStatePath = join(workDir, "login_state.json");
  storeA = new FileTokenStore({ tokensPath, loginStatePath });
  storeB = new FileTokenStore({ tokensPath, loginStatePath });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("lost-update 防止: 古いスナップショットの save が rotation を巻き戻さない", () => {
  it("A が refresh 保存した後、古いスナップショットの B が save しても新 refreshToken が残る", () => {
    // 初期状態 (両者がここから load した想定)
    storeA.save({ idToken: "id-0", refreshToken: "rt-0", accessToken: "at-0", username: "u@example.com", lastRefresh: T0 });
    const snapshotB = /** @type {NonNullable<ReturnType<typeof storeB.load>>} */ (storeB.load()); // B のメモリに古い内容が残る

    // A (デーモン) が refresh → rotation 済みトークンを保存
    storeA.save({ idToken: "id-1", refreshToken: "rt-1", accessToken: "at-1", username: "u@example.com", lastRefresh: T1 });

    // B (CLI) が古いスナップショットをそのまま save (従来はここで rt-1 が rt-0 に巻き戻った)
    storeB.save(snapshotB);

    const after = storeA.load();
    expect(after?.refreshToken).toBe("rt-1");
    expect(after?.idToken).toBe("id-1");
    expect(after?.accessToken).toBe("at-1");
    expect(after?.lastRefresh).toBe(T1);
  });

  it("B の意図的な変更フィールドは生かしつつ、認証トークン 4 点だけディスクの新しい方を保持する", () => {
    storeA.save({ idToken: "id-0", refreshToken: "rt-0", accessToken: "at-0", username: "old@example.com", lastRefresh: T0 });
    const snapshotB = /** @type {NonNullable<ReturnType<typeof storeB.load>>} */ (storeB.load());

    storeA.save({ idToken: "id-1", refreshToken: "rt-1", accessToken: "at-1", username: "old@example.com", lastRefresh: T1 });

    // B は古いスナップショットの username だけ書き換えて保存
    storeB.save({ ...snapshotB, username: "new@example.com" });

    const after = storeA.load();
    expect(after?.username).toBe("new@example.com"); // B の意図は通る
    expect(after?.refreshToken).toBe("rt-1");        // rotation は巻き戻らない
    expect(after?.idToken).toBe("id-1");
    expect(after?.lastRefresh).toBe(T1);
  });

  it("deviceKey の意図的 null 化 (再ログイン誘導) は merge で復活させない", () => {
    // merge 規則 3: device 3 点は常に incoming 優先。「null 化して device 無し
    // CUSTOM_AUTH からやり直す」回復経路を merge が妨げてはならない。
    storeA.save({ idToken: "id-0", refreshToken: "rt-0", deviceKey: "dk-0", deviceGroupKey: "dgk-0", devicePassword: "dp-0", lastRefresh: T1 });
    const snapshot = /** @type {NonNullable<ReturnType<typeof storeB.load>>} */ (storeB.load());
    storeB.save({ ...snapshot, deviceKey: null, deviceGroupKey: null, devicePassword: null });
    const after = storeA.load();
    expect(after?.deviceKey).toBeNull();
    expect(after?.deviceGroupKey).toBeNull();
    expect(after?.devicePassword).toBeNull();
    expect(after?.refreshToken).toBe("rt-0"); // 同じ新しさ (= 同一スナップショット由来) なので incoming が正
  });

  it("lastRefresh が無くても idToken の exp で新旧を判定する (外部 store 由来の比較フォールバック)", () => {
    const oldJwt = fakeJwt(1_900_000_000);
    const newJwt = fakeJwt(1_900_003_600); // 1 時間後に失効 = より新しく発行された idToken
    storeA.save({ idToken: oldJwt, refreshToken: "rt-0" });
    const snapshotB = /** @type {NonNullable<ReturnType<typeof storeB.load>>} */ (storeB.load());
    storeA.save({ idToken: newJwt, refreshToken: "rt-1" });

    storeB.save(snapshotB);

    const after = storeA.load();
    expect(after?.idToken).toBe(newJwt);
    expect(after?.refreshToken).toBe("rt-1");
  });

  it("新しさが同じなら従来どおり全面上書き (フィールドの削除も merge に妨げられない)", () => {
    storeA.save({ idToken: "id-0", refreshToken: "rt-0", accessToken: "at-0", lastRefresh: T0 });
    // 同じ lastRefresh のまま accessToken を落として保存 → そのまま反映される
    storeB.save({ idToken: "id-0", refreshToken: "rt-0", lastRefresh: T0 });
    expect(storeA.load()).toEqual({ idToken: "id-0", refreshToken: "rt-0", lastRefresh: T0 });
  });

  it("incoming の方が新しければ全面上書き (通常の refresh 保存はこちら)", () => {
    storeA.save({ idToken: "id-0", refreshToken: "rt-0", lastRefresh: T0 });
    storeB.save({ idToken: "id-1", refreshToken: "rt-1", lastRefresh: T1 });
    expect(storeA.load()).toEqual({ idToken: "id-1", refreshToken: "rt-1", lastRefresh: T1 });
  });

  it("ディスクが壊れた JSON でも save は merge をあきらめて上書き回復する", () => {
    storeA.save({ idToken: "x" }); // ディレクトリ作成
    writeFileSync(tokensPath, "{ broken json", "utf8");
    expect(() => storeB.save({ idToken: "recovered", refreshToken: "rt" })).not.toThrow();
    expect(storeA.load()).toEqual({ idToken: "recovered", refreshToken: "rt" });
  });
});

describe("ロック運用 (save/clear)", () => {
  it("save は終了後に .lock / .tmp を残さない", () => {
    storeA.save({ idToken: "id", refreshToken: "rt", lastRefresh: T0 });
    const leftovers = readdirSync(workDir).filter((n) => n.endsWith(".lock") || n.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("stale lock (異常終了プロセスの残骸) が残っていても save は回収して成功する", () => {
    const lockPath = `${tokensPath}.lock`;
    writeFileSync(lockPath, "{ pid unknown"); // pid 死活チェック不能 → mtime のみで stale 判定
    const past = new Date(Date.now() - 60_000); // 既定 staleMs=10s を超過
    utimesSync(lockPath, past, past);
    storeA.save({ idToken: "id", refreshToken: "rt", lastRefresh: T1 });
    expect(storeA.load()?.refreshToken).toBe("rt");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("stale lock が残っていても clear は回収して成功する", () => {
    storeA.save({ idToken: "id" });
    const lockPath = `${tokensPath}.lock`;
    writeFileSync(lockPath, "{ pid unknown");
    const past = new Date(Date.now() - 60_000);
    utimesSync(lockPath, past, past);
    storeA.clear();
    expect(storeA.load()).toBeNull();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("clear → save の系列が別インスタンス間でも一貫する (logout 後の login)", () => {
    storeA.save({ idToken: "id-0", refreshToken: "rt-0", lastRefresh: T1 });
    storeA.clear();
    // ディスクが空なので、古い時刻のトークンでもそのまま保存される (merge 相手なし)
    storeB.save({ idToken: "id-relogin", refreshToken: "rt-relogin", lastRefresh: T0 });
    expect(storeA.load()).toEqual({ idToken: "id-relogin", refreshToken: "rt-relogin", lastRefresh: T0 });
  });
});
