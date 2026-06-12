import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FileTokenStore } from "../../src/tokens.js";

// POSIX のみ mode (0o600/0o700) 検証する。Windows ではスキップ。
const IS_POSIX = process.platform !== "win32";

let workDir;
let tokensPath;
let loginStatePath;
let store;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "sesame-tokens-test-"));
  // 設定ディレクトリ自体は store が作るので、ここでは未作成にしておく
  tokensPath = join(workDir, "sub", "tokens.json");
  loginStatePath = join(workDir, "sub", "login_state.json");
  store = new FileTokenStore({ tokensPath, loginStatePath });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("FileTokenStore constructor", () => {
  it("tokensPath が未指定なら Error をスローする", () => {
    expect(() => new FileTokenStore({ loginStatePath: "/tmp/ls.json" })).toThrow(/tokensPath required/);
  });

  it("loginStatePath が未指定なら Error をスローする", () => {
    expect(() => new FileTokenStore({ tokensPath: "/tmp/t.json" })).toThrow(/loginStatePath required/);
  });

  it("tokensPath が空文字なら Error をスローする (falsy 扱い)", () => {
    expect(() => new FileTokenStore({ tokensPath: "", loginStatePath: "/tmp/ls.json" })).toThrow(/tokensPath required/);
  });

  it("loginStatePath が空文字なら Error をスローする (falsy 扱い)", () => {
    expect(() => new FileTokenStore({ tokensPath: "/tmp/t.json", loginStatePath: "" })).toThrow(/loginStatePath required/);
  });

  it("両方指定すればインスタンスを生成し、tokensPath/loginStatePath プロパティを公開する", () => {
    const s = new FileTokenStore({ tokensPath: "/a/t.json", loginStatePath: "/a/ls.json" });
    expect(s.tokensPath).toBe("/a/t.json");
    expect(s.loginStatePath).toBe("/a/ls.json");
  });
});

describe("FileTokenStore.fromConfigDir", () => {
  it("configDir を渡すと tokens.json / login_state.json をそのディレクトリ配下に組み立てる", () => {
    const s = FileTokenStore.fromConfigDir(workDir);
    expect(s.tokensPath).toBe(resolve(workDir, "tokens.json"));
    expect(s.loginStatePath).toBe(resolve(workDir, "login_state.json"));
  });

  it("FileTokenStore のインスタンスを返す", () => {
    const s = FileTokenStore.fromConfigDir(workDir);
    expect(s).toBeInstanceOf(FileTokenStore);
  });
});

describe("FileTokenStore#load", () => {
  it("tokensPath が存在しない場合 null を返す", () => {
    expect(store.load()).toBeNull();
  });

  it("親ディレクトリごと存在しない場合でも例外を投げずに null を返す", () => {
    expect(existsSync(tokensPath)).toBe(false);
    expect(store.load()).toBeNull();
  });

  it("save した内容を round-trip で読み戻せる", () => {
    const tokens = { idToken: "id-1", refreshToken: "rt-1", deviceKey: "dk-1" };
    store.save(tokens);
    expect(store.load()).toEqual(tokens);
  });

  it("空オブジェクトでも保存・読み戻しが可能", () => {
    store.save({});
    expect(store.load()).toEqual({});
  });

  it("ネストした構造でも JSON シリアライズ/デシリアライズが正しく round-trip する", () => {
    const tokens = { idToken: "id", meta: { exp: 1700000000, scopes: ["a", "b"] }, n: 42 };
    store.save(tokens);
    expect(store.load()).toEqual(tokens);
  });

  it("壊れた JSON が書かれている場合は SyntaxError を投げる (silently null にはしない)", () => {
    store.save({}); // ディレクトリ作成のため
    writeFileSync(tokensPath, "{ not valid json", "utf8");
    expect(() => store.load()).toThrow(SyntaxError);
  });
});

describe("FileTokenStore#save", () => {
  it("save 後にファイルが実際にディスク上に作成される", () => {
    store.save({ idToken: "x" });
    expect(existsSync(tokensPath)).toBe(true);
  });

  it("save は親ディレクトリを recursive に作成する", () => {
    // 2 階層深いパス
    const deep = new FileTokenStore({
      tokensPath: join(workDir, "a", "b", "c", "tokens.json"),
      loginStatePath: join(workDir, "a", "b", "c", "login_state.json"),
    });
    expect(() => deep.save({ idToken: "x" })).not.toThrow();
    expect(existsSync(join(workDir, "a", "b", "c", "tokens.json"))).toBe(true);
  });

  it("save は JSON を pretty-print (indent 2) + trailing newline で書く", () => {
    store.save({ idToken: "id-1" });
    const raw = readFileSync(tokensPath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    // indent 2 を確認 (改行 + 2 スペース)
    expect(raw).toContain("\n  \"idToken\"");
  });

  it("既存のファイルを上書きする (前回の値は残らない)", () => {
    store.save({ idToken: "old", refreshToken: "rt-old" });
    store.save({ idToken: "new" });
    expect(store.load()).toEqual({ idToken: "new" });
  });

  it.skipIf(!IS_POSIX)("POSIX 環境で tokens.json は mode 0o600 で書かれる", () => {
    store.save({ idToken: "secret" });
    const mode = statSync(tokensPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it.skipIf(!IS_POSIX)("POSIX 環境で新規作成された親ディレクトリは mode 0o700 になる", () => {
    store.save({ idToken: "secret" });
    const dirMode = statSync(join(workDir, "sub")).mode & 0o777;
    expect(dirMode).toBe(0o700);
  });
});

describe("FileTokenStore#clear", () => {
  it("ファイルが存在する場合は削除する", () => {
    store.save({ idToken: "x" });
    expect(existsSync(tokensPath)).toBe(true);
    store.clear();
    expect(existsSync(tokensPath)).toBe(false);
  });

  it("clear 後の load は null を返す", () => {
    store.save({ idToken: "x" });
    store.clear();
    expect(store.load()).toBeNull();
  });

  it("ファイルが存在しなくても例外を投げない (no-op)", () => {
    expect(existsSync(tokensPath)).toBe(false);
    expect(() => store.clear()).not.toThrow();
  });

  it("clear を 2 回呼んでも 2 回目は no-op (再度の削除でエラーにならない)", () => {
    store.save({ idToken: "x" });
    store.clear();
    expect(() => store.clear()).not.toThrow();
    expect(store.load()).toBeNull();
  });

  it("clear は loginStatePath には触らない (tokens 専用)", () => {
    store.save({ idToken: "x" });
    store.savePending({ state: "s" });
    store.clear();
    expect(existsSync(tokensPath)).toBe(false);
    expect(existsSync(loginStatePath)).toBe(true);
    expect(store.loadPending()).toEqual({ state: "s" });
  });
});

describe("FileTokenStore#loadPending", () => {
  it("loginStatePath が存在しない場合 null を返す", () => {
    expect(store.loadPending()).toBeNull();
  });

  it("savePending した内容を round-trip で読み戻せる", () => {
    const pending = { state: "abc", codeVerifier: "v1", createdAt: 123 };
    store.savePending(pending);
    expect(store.loadPending()).toEqual(pending);
  });

  it("壊れた JSON が書かれている場合は SyntaxError を投げる", () => {
    store.savePending({}); // ディレクトリ作成のため
    writeFileSync(loginStatePath, "garbage", "utf8");
    expect(() => store.loadPending()).toThrow(SyntaxError);
  });
});

describe("FileTokenStore#savePending", () => {
  it("savePending 後にファイルが実際にディスク上に作成される", () => {
    store.savePending({ state: "s" });
    expect(existsSync(loginStatePath)).toBe(true);
  });

  it("既存の pending を上書きする", () => {
    store.savePending({ state: "old" });
    store.savePending({ state: "new" });
    expect(store.loadPending()).toEqual({ state: "new" });
  });

  it.skipIf(!IS_POSIX)("POSIX 環境で login_state.json は mode 0o600 で書かれる", () => {
    store.savePending({ state: "s" });
    const mode = statSync(loginStatePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("savePending は tokens.json には影響しない", () => {
    store.save({ idToken: "x" });
    store.savePending({ state: "s" });
    expect(store.load()).toEqual({ idToken: "x" });
  });
});

describe("FileTokenStore#clearPending", () => {
  it("login state ファイルが存在する場合は削除する", () => {
    store.savePending({ state: "s" });
    expect(existsSync(loginStatePath)).toBe(true);
    store.clearPending();
    expect(existsSync(loginStatePath)).toBe(false);
  });

  it("clearPending 後の loadPending は null を返す", () => {
    store.savePending({ state: "s" });
    store.clearPending();
    expect(store.loadPending()).toBeNull();
  });

  it("ファイルが存在しなくても例外を投げない (no-op)", () => {
    expect(existsSync(loginStatePath)).toBe(false);
    expect(() => store.clearPending()).not.toThrow();
  });

  it("clearPending を 2 回呼んでも 2 回目は no-op", () => {
    store.savePending({ state: "s" });
    store.clearPending();
    expect(() => store.clearPending()).not.toThrow();
  });

  it("clearPending は tokens.json には触らない (pending 専用)", () => {
    store.save({ idToken: "x" });
    store.savePending({ state: "s" });
    store.clearPending();
    expect(existsSync(loginStatePath)).toBe(false);
    expect(existsSync(tokensPath)).toBe(true);
    expect(store.load()).toEqual({ idToken: "x" });
  });
});

describe("FileTokenStore 統合シナリオ", () => {
  it("典型的なログインフロー: savePending → save (tokens) → clearPending → ... → clear", () => {
    // 1. pending を保存
    store.savePending({ state: "S", codeVerifier: "V" });
    expect(store.loadPending()).toEqual({ state: "S", codeVerifier: "V" });

    // 2. トークン取得 → 保存
    store.save({ idToken: "id", refreshToken: "rt" });
    expect(store.load()).toEqual({ idToken: "id", refreshToken: "rt" });

    // 3. pending を破棄
    store.clearPending();
    expect(store.loadPending()).toBeNull();
    expect(store.load()).toEqual({ idToken: "id", refreshToken: "rt" });

    // 4. ログアウト
    store.clear();
    expect(store.load()).toBeNull();
    expect(store.loadPending()).toBeNull();
  });

  it("tokens と pending を独立に save/clear できる (相互干渉なし)", () => {
    store.save({ a: 1 });
    store.savePending({ b: 2 });
    expect(store.load()).toEqual({ a: 1 });
    expect(store.loadPending()).toEqual({ b: 2 });

    store.clear();
    expect(store.load()).toBeNull();
    expect(store.loadPending()).toEqual({ b: 2 });

    store.clearPending();
    expect(store.loadPending()).toBeNull();
  });
});
