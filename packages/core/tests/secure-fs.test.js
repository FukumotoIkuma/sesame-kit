// secure-fs.js: 秘匿ファイル書き込みの mode/atomicity を検証する。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureSecureDir, writeSecretFile, writeSecretJson, restrictSecretFile,
  SECRET_FILE_MODE, SECRET_DIR_MODE,
} from "../src/secure-fs.js";

const isPosix = process.platform !== "win32";
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "sesame-securefs-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const mode = (p) => statSync(p).mode & 0o777;

describe("secure-fs", () => {
  it("ensureSecureDir は 0700 でディレクトリを作る", () => {
    const sub = join(dir, "a", "b");
    ensureSecureDir(sub);
    if (isPosix) expect(mode(sub)).toBe(SECRET_DIR_MODE);
  });

  it("ensureSecureDir は既存の緩いディレクトリも 0700 へ締め直す", () => {
    const sub = join(dir, "loose");
    mkdirSync(sub);
    if (isPosix) chmodSync(sub, 0o755);
    ensureSecureDir(sub);
    if (isPosix) expect(mode(sub)).toBe(SECRET_DIR_MODE);
  });

  it("writeSecretJson はファイル 0600 / 親 0700 で書く", () => {
    const f = join(dir, "nested", "devices.json");
    writeSecretJson(f, { devices: [{ secretKey: "deadbeef" }] });
    expect(JSON.parse(readFileSync(f, "utf8")).devices[0].secretKey).toBe("deadbeef");
    if (isPosix) {
      expect(mode(f)).toBe(SECRET_FILE_MODE);
      expect(mode(join(dir, "nested"))).toBe(SECRET_DIR_MODE);
    }
  });

  it("writeSecretFile は既存の緩い親ディレクトリとファイルを締め直す", () => {
    const parent = join(dir, "loose-parent");
    const f = join(parent, "tokens.json");
    mkdirSync(parent);
    writeFileSync(f, "old\n", { mode: 0o644 });
    if (isPosix) {
      chmodSync(parent, 0o755);
      chmodSync(f, 0o644);
    }
    writeSecretFile(f, "new\n");
    expect(readFileSync(f, "utf8")).toBe("new\n");
    if (isPosix) {
      expect(mode(parent)).toBe(SECRET_DIR_MODE);
      expect(mode(f)).toBe(SECRET_FILE_MODE);
    }
  });

  it("writeSecretFile はアトミック (一時ファイルを残さない)", () => {
    const f = join(dir, "t.json");
    writeSecretFile(f, "hello\n");
    expect(readFileSync(f, "utf8")).toBe("hello\n");
    expect(readdirSync(dir).filter((name) => name.startsWith("t.json.") && name.endsWith(".tmp"))).toEqual([]);
  });

  it("restrictSecretFile は既存ファイルの mode を 0600 へ締める", () => {
    const f = join(dir, "copied.json");
    writeFileSync(f, "{}", { mode: 0o644 });
    restrictSecretFile(f);
    if (isPosix) expect(mode(f)).toBe(SECRET_FILE_MODE);
  });

  it("restrictSecretFile は不在ファイルでも投げない (best-effort)", () => {
    expect(() => restrictSecretFile(join(dir, "missing"))).not.toThrow();
  });
});
