// secure-fs.js: 秘匿ファイル書き込みの mode/atomicity を検証する。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
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

  it("writeSecretJson はファイル 0600 / 親 0700 で書く", () => {
    const f = join(dir, "nested", "devices.json");
    writeSecretJson(f, { devices: [{ secretKey: "deadbeef" }] });
    expect(JSON.parse(readFileSync(f, "utf8")).devices[0].secretKey).toBe("deadbeef");
    if (isPosix) {
      expect(mode(f)).toBe(SECRET_FILE_MODE);
      expect(mode(join(dir, "nested"))).toBe(SECRET_DIR_MODE);
    }
  });

  it("writeSecretFile はアトミック (一時ファイルを残さない)", () => {
    const f = join(dir, "t.json");
    writeSecretFile(f, "hello\n");
    expect(readFileSync(f, "utf8")).toBe("hello\n");
    expect(() => statSync(`${f}.tmp`)).toThrow(); // temp は rename で消える
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
