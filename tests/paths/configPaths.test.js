import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { homedir } from "node:os";
import { resolve, sep, isAbsolute } from "node:path";
import { configPaths, resolveConfigDir } from "../../src/paths.js";

const APP_DIRNAME = "sesame-kit";

// 環境変数を完全クリーン状態にしてからテストを実行する。
// process.env を直接書き換えず、vi.stubEnv / vi.unstubAllEnvs で確実に復元する。
function clearRelevantEnv() {
  vi.stubEnv("SESAME_KIT_HOME", "");
  vi.stubEnv("XDG_CONFIG_HOME", "");
  // stubEnv の空文字は "存在するが空" になるため、delete で完全に消す必要がある。
  // vitest の stubEnv は undefined を渡すと delete してくれる。
  vi.stubEnv("SESAME_KIT_HOME", undefined);
  vi.stubEnv("XDG_CONFIG_HOME", undefined);
}

describe("resolveConfigDir", () => {
  beforeEach(() => {
    clearRelevantEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("優先順位 1: overrideDir", () => {
    it("overrideDir が絶対パスならそれをそのまま resolve した値を返す", () => {
      const abs = resolve("/tmp/my-sesame-config");
      expect(resolveConfigDir(abs)).toBe(abs);
    });

    it("overrideDir が相対パスでも resolve されて絶対パスになる", () => {
      const result = resolveConfigDir("./relative-config");
      expect(isAbsolute(result)).toBe(true);
      expect(result).toBe(resolve("./relative-config"));
    });

    it("overrideDir が指定されていれば SESAME_KIT_HOME より優先される", () => {
      vi.stubEnv("SESAME_KIT_HOME", "/env/sesame-home");
      const override = "/explicit/override";
      expect(resolveConfigDir(override)).toBe(resolve(override));
    });

    it("overrideDir が指定されていれば XDG_CONFIG_HOME より優先される", () => {
      vi.stubEnv("XDG_CONFIG_HOME", "/env/xdg");
      const override = "/explicit/override";
      expect(resolveConfigDir(override)).toBe(resolve(override));
    });

    it("overrideDir が指定されていれば ~/.config フォールバックより優先される", () => {
      const override = "/explicit/override";
      expect(resolveConfigDir(override)).toBe(resolve(override));
      expect(resolveConfigDir(override)).not.toContain(".config");
    });
  });

  describe("優先順位 2: SESAME_KIT_HOME", () => {
    it("overrideDir 未指定で SESAME_KIT_HOME が設定されていれば resolve した値を返す", () => {
      vi.stubEnv("SESAME_KIT_HOME", "/env/sesame-home");
      expect(resolveConfigDir()).toBe(resolve("/env/sesame-home"));
    });

    it("SESAME_KIT_HOME は XDG_CONFIG_HOME より優先される", () => {
      vi.stubEnv("SESAME_KIT_HOME", "/env/sesame-home");
      vi.stubEnv("XDG_CONFIG_HOME", "/env/xdg");
      expect(resolveConfigDir()).toBe(resolve("/env/sesame-home"));
    });

    it("SESAME_KIT_HOME に APP_DIRNAME (sesame-kit) は付与されない (アプリ専用 dir の前提)", () => {
      vi.stubEnv("SESAME_KIT_HOME", "/env/already-app-dir");
      const result = resolveConfigDir();
      expect(result).toBe(resolve("/env/already-app-dir"));
      expect(result.endsWith(`${sep}${APP_DIRNAME}`)).toBe(false);
    });

    it("SESAME_KIT_HOME が相対パスでも絶対パスに解決される", () => {
      vi.stubEnv("SESAME_KIT_HOME", "relative/sesame");
      const result = resolveConfigDir();
      expect(isAbsolute(result)).toBe(true);
      expect(result).toBe(resolve("relative/sesame"));
    });

    it("SESAME_KIT_HOME が空文字なら無視されて次の優先順位に進む", () => {
      // 空文字は falsy なので process.env.SESAME_KIT_HOME が真でないという判定
      vi.stubEnv("SESAME_KIT_HOME", "");
      vi.stubEnv("XDG_CONFIG_HOME", "/env/xdg");
      expect(resolveConfigDir()).toBe(resolve("/env/xdg", APP_DIRNAME));
    });
  });

  describe("優先順位 3: XDG_CONFIG_HOME", () => {
    it("XDG_CONFIG_HOME が設定されていれば $XDG_CONFIG_HOME/sesame-kit を返す", () => {
      vi.stubEnv("XDG_CONFIG_HOME", "/env/xdg");
      expect(resolveConfigDir()).toBe(resolve("/env/xdg", APP_DIRNAME));
    });

    it("XDG_CONFIG_HOME に APP_DIRNAME が付与される", () => {
      vi.stubEnv("XDG_CONFIG_HOME", "/custom/xdg");
      const result = resolveConfigDir();
      expect(result.endsWith(`${sep}${APP_DIRNAME}`)).toBe(true);
    });

    it("XDG_CONFIG_HOME が相対パスでも絶対パスに解決される", () => {
      vi.stubEnv("XDG_CONFIG_HOME", "xdg-rel");
      const result = resolveConfigDir();
      expect(isAbsolute(result)).toBe(true);
      expect(result).toBe(resolve("xdg-rel", APP_DIRNAME));
    });

    it("XDG_CONFIG_HOME が空文字なら無視されて ~/.config フォールバックに進む", () => {
      vi.stubEnv("XDG_CONFIG_HOME", "");
      const result = resolveConfigDir();
      expect(result).toBe(resolve(homedir(), ".config", APP_DIRNAME));
    });
  });

  describe("優先順位 4: ~/.config/sesame-kit フォールバック", () => {
    it("全 env 未設定なら homedir()/.config/sesame-kit を返す", () => {
      const result = resolveConfigDir();
      expect(result).toBe(resolve(homedir(), ".config", APP_DIRNAME));
    });

    it("フォールバック結果は homedir 配下である", () => {
      const result = resolveConfigDir();
      expect(result.startsWith(homedir())).toBe(true);
      expect(result.endsWith(`${sep}.config${sep}${APP_DIRNAME}`)).toBe(true);
    });
  });

  describe("入力の正規化", () => {
    it("overrideDir に undefined を渡すと env / フォールバックにフォールスルーする", () => {
      const result = resolveConfigDir(undefined);
      expect(result).toBe(resolve(homedir(), ".config", APP_DIRNAME));
    });

    it("overrideDir に null を渡すと env / フォールバックにフォールスルーする", () => {
      const result = resolveConfigDir(null);
      expect(result).toBe(resolve(homedir(), ".config", APP_DIRNAME));
    });

    it("overrideDir に空文字を渡すと env / フォールバックにフォールスルーする (falsy 扱い)", () => {
      const result = resolveConfigDir("");
      expect(result).toBe(resolve(homedir(), ".config", APP_DIRNAME));
    });
  });
});

describe("configPaths", () => {
  beforeEach(() => {
    clearRelevantEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("dir / ファイルパス導出", () => {
    it("overrideDir 指定時、6 つのキー (dir/config/tokens/loginState/devices/socket) を返す", () => {
      const result = configPaths("/tmp/cfg");
      expect(Object.keys(result).sort()).toEqual(
        ["config", "devices", "dir", "loginState", "socket", "tokens"].sort()
      );
    });

    it("dir が resolveConfigDir と一致する", () => {
      const override = "/tmp/explicit-cfg";
      const result = configPaths(override);
      expect(result.dir).toBe(resolveConfigDir(override));
      expect(result.dir).toBe(resolve(override));
    });

    it("config パスは dir/config.json", () => {
      const result = configPaths("/tmp/cfg");
      expect(result.config).toBe(resolve("/tmp/cfg", "config.json"));
    });

    it("tokens パスは dir/tokens.json", () => {
      const result = configPaths("/tmp/cfg");
      expect(result.tokens).toBe(resolve("/tmp/cfg", "tokens.json"));
    });

    it("loginState パスは dir/login_state.json (snake_case でファイル名は固定)", () => {
      const result = configPaths("/tmp/cfg");
      expect(result.loginState).toBe(resolve("/tmp/cfg", "login_state.json"));
    });

    it("devices パスは dir/devices.json", () => {
      const result = configPaths("/tmp/cfg");
      expect(result.devices).toBe(resolve("/tmp/cfg", "devices.json"));
    });

    it("全ファイルパスは dir をプレフィックスに持つ", () => {
      const dir = resolve("/tmp/prefix-test");
      const result = configPaths(dir);
      for (const key of ["config", "tokens", "loginState", "devices"]) {
        expect(result[key].startsWith(`${dir}${sep}`)).toBe(true);
      }
    });
  });

  describe("env 経由の解決", () => {
    it("SESAME_KIT_HOME 指定時、dir はそのまま使われ、ファイル名は固定", () => {
      vi.stubEnv("SESAME_KIT_HOME", "/env/sesame-home");
      const result = configPaths();
      expect(result.dir).toBe(resolve("/env/sesame-home"));
      expect(result.config).toBe(resolve("/env/sesame-home", "config.json"));
      expect(result.tokens).toBe(resolve("/env/sesame-home", "tokens.json"));
      expect(result.loginState).toBe(resolve("/env/sesame-home", "login_state.json"));
      expect(result.devices).toBe(resolve("/env/sesame-home", "devices.json"));
    });

    it("XDG_CONFIG_HOME 指定時、dir に APP_DIRNAME が付き、ファイル名はその配下", () => {
      vi.stubEnv("XDG_CONFIG_HOME", "/env/xdg");
      const result = configPaths();
      const expectedDir = resolve("/env/xdg", APP_DIRNAME);
      expect(result.dir).toBe(expectedDir);
      expect(result.config).toBe(resolve(expectedDir, "config.json"));
      expect(result.devices).toBe(resolve(expectedDir, "devices.json"));
    });

    it("全 env 未指定なら ~/.config/sesame-kit 配下に全ファイルが derive される", () => {
      const result = configPaths();
      const expectedDir = resolve(homedir(), ".config", APP_DIRNAME);
      expect(result.dir).toBe(expectedDir);
      expect(result.config).toBe(resolve(expectedDir, "config.json"));
      expect(result.tokens).toBe(resolve(expectedDir, "tokens.json"));
      expect(result.loginState).toBe(resolve(expectedDir, "login_state.json"));
      expect(result.devices).toBe(resolve(expectedDir, "devices.json"));
    });
  });

  describe("べき等性 / 純粋関数性", () => {
    it("同じ引数で 2 回呼んでも同じ結果を返す (副作用なし)", () => {
      const a = configPaths("/tmp/idem");
      const b = configPaths("/tmp/idem");
      expect(a).toEqual(b);
    });

    it("毎回新しいオブジェクトを返す (参照は等しくない)", () => {
      const a = configPaths("/tmp/idem");
      const b = configPaths("/tmp/idem");
      expect(a).not.toBe(b);
    });

    it("異なる overrideDir では異なる dir が返る", () => {
      const a = configPaths("/tmp/a");
      const b = configPaths("/tmp/b");
      expect(a.dir).not.toBe(b.dir);
      expect(a.config).not.toBe(b.config);
    });
  });

  describe("優先順位の通し確認", () => {
    it("overrideDir > SESAME_KIT_HOME > XDG_CONFIG_HOME > ~/.config の順", () => {
      vi.stubEnv("SESAME_KIT_HOME", "/env/sesame-home");
      vi.stubEnv("XDG_CONFIG_HOME", "/env/xdg");

      // 1. overrideDir 最優先
      expect(configPaths("/override").dir).toBe(resolve("/override"));

      // 2. overrideDir なし → SESAME_KIT_HOME
      expect(configPaths().dir).toBe(resolve("/env/sesame-home"));

      // 3. SESAME_KIT_HOME 解除 → XDG_CONFIG_HOME
      vi.stubEnv("SESAME_KIT_HOME", undefined);
      expect(configPaths().dir).toBe(resolve("/env/xdg", APP_DIRNAME));

      // 4. 全解除 → ~/.config フォールバック
      vi.stubEnv("XDG_CONFIG_HOME", undefined);
      expect(configPaths().dir).toBe(resolve(homedir(), ".config", APP_DIRNAME));
    });
  });
});
