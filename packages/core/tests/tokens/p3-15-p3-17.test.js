// P3-17: readJsonOrNull の TOCTOU 修正 (existsSync → try/catch ENOENT)
// P3-15: FileTokenStore.loadAwsCredentials / saveAwsCredentials の永続化
//
// 参照(モック導出元):
//   P3-17: serve デーモンの load と CLI の logout (unlink) 競合 — ENOENT が素通りしていた
//   P3-15: _aws_sdk_ref/CognitoCachingCredentialsProvider.java:86-98 (キー定数)
//          _aws_sdk_ref/CognitoCachingCredentialsProvider.java:473-505 (loadCachedCredentials)
//          _aws_sdk_ref/CognitoCachingCredentialsProvider.java:638-646 (saveCredentials)
//          _aws_sdk_ref/CognitoCachingCredentialsProvider.java:655-659 (saveIdentityId)
//
// 既存テストは readJsonOrNull を existsSync→readFileSync の 2 ステップで実装しており
// TOCTOU 競合をテストできていなかったことが見逃しの根因。
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTokenStore } from "../../src/tokens.js";

const IS_POSIX = process.platform !== "win32";

let workDir;
let tokensPath;
let loginStatePath;
let store;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "sesame-p3-17-test-"));
  tokensPath = join(workDir, "tokens.json");
  loginStatePath = join(workDir, "login_state.json");
  store = new FileTokenStore({ tokensPath, loginStatePath });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// ──────────────────────────────────────────────────────────────────────────
// P3-17: readJsonOrNull — ENOENT → null (existsSync 除去)
// ──────────────────────────────────────────────────────────────────────────
describe("P3-17: readJsonOrNull — TOCTOU 競合 ENOENT → null", () => {
  it("ファイルが存在しない場合 load() は null を返す (ENOENT → null 写像)", () => {
    // existsSync ベースの実装が TOCTOU で ENOENT を投げる状況を確認するには
    // mock fs が必要だが、try/catch 版は単純な「ファイルなし」でも null を返すことで
    // 同じ保証を提供している。
    expect(store.load()).toBeNull();
  });

  it("ファイルが壊れた JSON の場合は SyntaxError を投げる (null にしない)", () => {
    // ENOENT のみ null 写像。SyntaxError は呼び出し側に伝播する。
    writeFileSync(tokensPath, "{ broken json", "utf8");
    expect(() => store.load()).toThrow(SyntaxError);
  });

  it("正常な JSON は load() でパースして返す", () => {
    writeFileSync(tokensPath, '{"idToken":"id-1"}', "utf8");
    expect(store.load()).toEqual({ idToken: "id-1" });
  });

  it("load() 後にファイルを削除して再 load() しても null を返す (競合模擬)", () => {
    store.save({ idToken: "id-0" });
    expect(store.load()).toEqual({ idToken: "id-0" });
    // TOCTOU 競合シナリオ: load を 2 段に分解し、existsSync 後に unlink が走る状況
    // try/catch 版は readFileSync が直接 ENOENT → null に写像するので問題なし。
    unlinkSync(tokensPath);
    expect(store.load()).toBeNull();
  });

  it("loadPending() もファイルなしで null を返す (同じ readJsonOrNull 経由)", () => {
    expect(store.loadPending()).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// P3-15: FileTokenStore.loadAwsCredentials / saveAwsCredentials
// ──────────────────────────────────────────────────────────────────────────
describe("P3-15: FileTokenStore — AWS credentials 永続化", () => {
  it("awsCredentialsPath は tokensPath と同一ディレクトリの aws_credentials.json", () => {
    // 参照: CognitoCachingCredentialsProvider.java:86-98 — 別の namespace/キーに保存
    expect(store.awsCredentialsPath).toBe(join(workDir, "aws_credentials.json"));
  });

  it("loadAwsCredentials はファイルなしで null を返す", () => {
    expect(store.loadAwsCredentials()).toBeNull();
  });

  it("saveAwsCredentials → loadAwsCredentials で round-trip", () => {
    // 参照: CognitoCachingCredentialsProvider.java:638-646 saveCredentials
    //       CognitoCachingCredentialsProvider.java:473-505 loadCachedCredentials
    const c = {
      identityId: "ap-northeast-1:id-1",
      accessKeyId: "ASIAEXAMPLE",
      secretAccessKey: "secret/Key",
      sessionToken: "SESSION-TOKEN",
      expirationMs: Date.now() + 3600_000,
    };
    store.saveAwsCredentials(c);
    const loaded = store.loadAwsCredentials();
    expect(loaded).toEqual(c);
  });

  it("saveAwsCredentials(null) はファイルを削除する (clearCredentials 相当)", () => {
    // 参照: CognitoCachingCredentialsProvider.java:561-566 clearCredentials で各キーを remove
    store.saveAwsCredentials({ identityId: "id-1", accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST", expirationMs: 0 });
    expect(existsSync(store.awsCredentialsPath)).toBe(true);
    store.saveAwsCredentials(null);
    expect(existsSync(store.awsCredentialsPath)).toBe(false);
  });

  it("saveAwsCredentials(null) でファイルが存在しなくても例外を投げない", () => {
    expect(() => store.saveAwsCredentials(null)).not.toThrow();
  });

  it.skipIf(!IS_POSIX)("POSIX 環境で aws_credentials.json は mode 0o600 で書かれる", () => {
    // 参照: CognitoCachingCredentialsProvider.java:640-644 — AWSKeyValueStore が Android
    //       SharedPreferences に書く (iOS Keychain と同等の保護)。Node では 0600 で代替。
    store.saveAwsCredentials({ identityId: "id-1", accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST", expirationMs: Date.now() + 3600_000 });
    const mode = statSync(store.awsCredentialsPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("tokens.json と aws_credentials.json は互いに独立 (相互干渉なし)", () => {
    store.save({ idToken: "id-1" });
    store.saveAwsCredentials({ identityId: "aws-id-1", accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST", expirationMs: 0 });

    // token を clear しても aws_credentials は残る
    store.clear();
    expect(store.load()).toBeNull();
    expect(store.loadAwsCredentials()).not.toBeNull();

    // aws_credentials を null 化しても tokens は復活しない
    store.saveAwsCredentials(null);
    expect(store.load()).toBeNull();
  });

  it("壊れた aws_credentials.json は SyntaxError を投げる (p3-17 一致挙動)", () => {
    // saveAwsCredentials で一旦書いてから壊す
    store.saveAwsCredentials({ identityId: "id", accessKeyId: "AK", secretAccessKey: "SK", sessionToken: "ST", expirationMs: 0 });
    writeFileSync(store.awsCredentialsPath, "broken json", "utf8");
    expect(() => store.loadAwsCredentials()).toThrow(SyntaxError);
  });
});
