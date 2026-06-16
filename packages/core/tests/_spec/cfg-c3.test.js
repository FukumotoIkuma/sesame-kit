// CFG-0059 〜 CFG-0077 の実行可能単体テスト (統合版)
// surface: core (config.js / paths.js / secure-fs.js / jsonrpc.js / errors.js)
//          cli  (locks.js / pickers.js / ctx.js)
//
// ネットワーク・実機に触れない。全テストは純関数 or tmpdir 実 IO。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import {
  ConfigStore,
  normalizeConfig,
  migrateConfig,
  SCHEMA_VERSION,
  isLockModel,
} from "../../packages/core/src/config.js";
import { SesameError, ERR } from "../../packages/core/src/errors.js";
import { errorFromThrow } from "../../packages/core/src/jsonrpc.js";
import {
  withFileLock,
  writeSecretJson,
  SECRET_FILE_MODE,
  SECRET_DIR_MODE,
  ensureSecureDir,
} from "../../packages/core/src/secure-fs.js";
import { resolveConfigDir } from "../../packages/core/src/paths.js";

// ---------------------------------------------------------------------------
// テスト共通ヘルパ
// ---------------------------------------------------------------------------

let workDir;
let configPath;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "sesame-cfg-c3-"));
  configPath = join(workDir, "nested", "config.json");
});

afterEach(() => {
  if (workDir && existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  }
  workDir = null;
  configPath = null;
  vi.restoreAllMocks();
});

function validLock(overrides = {}) {
  return {
    deviceUUID: "00000000-0000-0000-0000-000000000001",
    secretKey: "0123456789abcdef0123456789abcdef",
    ...overrides,
  };
}

function makeStore(path = configPath) {
  return new ConfigStore(path);
}

function registerHub3(store, name = "hub-a") {
  store.addHub3(name, { deviceId: `device-${name}` });
}

function addRemote(store, name, hub3 = "hub-a") {
  store.addRemote(name, {
    hub3,
    irDeviceUUID: `ir-uuid-${name}`,
    irType: 0xfe00,
  });
}

// ---------------------------------------------------------------------------
// CFG-0059: setDefaultLock — 未知名は BAD_REQUEST / 既知名は更新
// ---------------------------------------------------------------------------

describe("[CFG-0059] setDefaultLock: 未知名は BAD_REQUEST、既知名は default.lock を更新", () => {
  it("[CFG-0059] 未知名を渡すと SesameError(BAD_REQUEST) を投げる", () => {
    const store = makeStore();
    store.addLock("L1", validLock());
    // locks["unknown"] が存在しない → SesameError
    expect(() => store.setDefaultLock("does-not-exist")).toThrow();
    let caught;
    try { store.setDefaultLock("does-not-exist"); } catch (e) { caught = e; }
    expect(caught).toBeDefined();
    expect(caught).toBeInstanceOf(SesameError);
    expect(caught.code).toBe(ERR.BAD_REQUEST);
  });

  it("[CFG-0059] 既知名を渡すと default.lock が更新される", () => {
    const store = makeStore();
    store.addLock("L1", validLock());
    store.addLock("L2", validLock({ deviceUUID: "00000000-0000-0000-0000-000000000002" }));
    store.setDefaultLock("L2");
    expect(store.load().default.lock).toBe("L2");
  });

  it("[CFG-0059] setDefaultLock の変更はファイルに永続化される", () => {
    const store = makeStore();
    store.addLock("L1", validLock());
    store.addLock("L2", validLock({ deviceUUID: "00000000-0000-0000-0000-000000000002" }));
    store.setDefaultLock("L2");

    const store2 = makeStore();
    expect(store2.load().default.lock).toBe("L2");
  });
});

// ---------------------------------------------------------------------------
// CFG-0060: locks ls — 未初期化 exit 2 / --json は redact
// ---------------------------------------------------------------------------

describe("[CFG-0060] locks ls: 未初期化 / --json redact 契約", () => {
  it("[CFG-0060] configStore.exists() が false のとき locks ls は die(configNotInitialized, 2) を呼ぶ前提確認", () => {
    const store = makeStore();
    // ファイル不在 → exists() は false
    expect(store.exists()).toBe(false);
  });

  it("[CFG-0060] redactConfig が secretKey を深く走査してマスクする", async () => {
    const { redactConfig } = await import("../../packages/kit/src/cli/ctx.js");
    const RAW = "5ccec6781bb7509bdd58fa21565b647b";
    const cfg = {
      default: "L1",
      locks: {
        L1: { deviceUUID: "AABB-CC", secretKey: RAW, model: "sesame_5" },
      },
    };
    const r = redactConfig(cfg);
    // secretKey がマスクされている
    expect(r.locks.L1.secretKey).not.toBe(RAW);
    // mask 形式: … を含む
    expect(typeof r.locks.L1.secretKey).toBe("string");
    expect(r.locks.L1.secretKey).toMatch(/…/);
    // 秘密でないフィールドは保持
    expect(r.locks.L1.deviceUUID).toBe("AABB-CC");
    expect(r.locks.L1.model).toBe("sesame_5");
  });

  it("[CFG-0060] redactConfig は元オブジェクトを破壊しない", async () => {
    const { redactConfig } = await import("../../packages/kit/src/cli/ctx.js");
    const RAW = "0123456789abcdef0123456789abcdef";
    const cfg = { locks: { L1: { secretKey: RAW } } };
    redactConfig(cfg);
    expect(cfg.locks.L1.secretKey).toBe(RAW);
  });

  it("[CFG-0060] redactConfig はネストされた secretKey をすべてマスクする", async () => {
    const { redactConfig } = await import("../../packages/kit/src/cli/ctx.js");
    const cfg = {
      locks: {
        a: { secretKey: "aabbccddaabbccddaabbccddaabbccdd" },
        b: { secretKey: "eeffeeffeeffeeffeeffeeffeeffeeab" },
      },
    };
    const r = redactConfig(cfg);
    expect(r.locks.a.secretKey).not.toBe("aabbccddaabbccddaabbccddaabbccdd");
    expect(r.locks.b.secretKey).not.toBe("eeffeeffeeffeeffeeffeeffeeffeeab");
  });
});

// ---------------------------------------------------------------------------
// CFG-0061: syncLocksFromDevices — accept は isLockModel && deviceUUID && secretKey
// ---------------------------------------------------------------------------

describe("[CFG-0061] syncLocksFromDevices: accept 条件 + prune + LOCAL_ONLY_KEYS", () => {
  it("[CFG-0061] isLockModel && deviceUUID && secretKey を持つ device のみ取り込む", () => {
    const store = makeStore();
    const list = [
      // accept → added
      { deviceUUID: "uuid-1", deviceName: "Lock A", deviceModel: "sesame_5", secretKey: "aabbccddeeff00112233445566778899" },
      // secretKey 無し → 除外
      { deviceUUID: "uuid-2", deviceName: "No Secret", deviceModel: "sesame_5", secretKey: null },
      // deviceUUID 無し → 除外
      { deviceName: "No UUID", deviceModel: "sesame_5", secretKey: "aabbccddeeff00112233445566778899" },
      // isLockModel 外 (hub3) → 除外
      { deviceUUID: "uuid-4", deviceName: "Hub", deviceModel: "hub_3", secretKey: "aabbccddeeff00112233445566778899" },
    ];
    const r = store.syncLocksFromDevices(list);
    expect(r.added.length).toBe(1);
    expect(r.removed.length).toBe(0);
  });

  it("[CFG-0061] --prune で lock category の seen 外エントリが removed に入る", () => {
    const store = makeStore();
    store.addLock("old-lock", validLock());
    const r = store.syncLocksFromDevices(
      [{ deviceModel: "sesame_5", deviceUUID: "uuid-new", secretKey: "aabbccddeeff00112233445566778899", deviceName: "New" }],
      { prune: true },
    );
    expect(r.removed).toContain("old-lock");
    const cfg = store.load();
    expect(cfg.locks["old-lock"]).toBeUndefined();
  });

  it("[CFG-0061] prune は hub3 category デバイスを消さない (effectiveCategory が lock のみ対象)", () => {
    const store = makeStore();
    store.addLock("mylock", validLock());
    store.addHub3("myhub", { deviceId: "hub-uuid" });

    const r = store.syncLocksFromDevices(
      [{ deviceModel: "sesame_5", deviceUUID: "00000000-0000-0000-0000-000000000001", secretKey: "0123456789abcdef0123456789abcdef", deviceName: "MyLock" }],
      { prune: true },
    );
    // hub3 は lock category でないので removed に入らない
    expect(r.removed).not.toContain("myhub");
    const cfg = store.load();
    expect(cfg.hub3s["myhub"]).toBeDefined();
  });

  it("[CFG-0061] prune で削除した device が default.lock だった場合 null に戻す", () => {
    const store = makeStore();
    store.addLock("L1", { deviceUUID: "uuid-lock-1", secretKey: "aabbccddeeff00112233445566778899" });
    store.addLock("L2", { deviceUUID: "uuid-lock-2", secretKey: "aabbccddeeff00112233445566778899" });
    store.setDefaultLock("L2");
    // prune: L1 のみ応答、L2 は削除対象
    const r = store.syncLocksFromDevices(
      [{ deviceUUID: "uuid-lock-1", deviceName: "L1", deviceModel: "sesame_5", secretKey: "aabbccddeeff00112233445566778899" }],
      { prune: true },
    );
    expect(r.removed).toContain("L2");
    expect(store.load().default.lock).toBeNull();
  });

  it("[CFG-0061] LOCAL_ONLY_KEYS (category/ssmPublicKey/keyIndex) は sync 更新で引き継がれる", () => {
    const store = makeStore();
    const secretKey = "0123456789abcdef0123456789abcdef";
    store.addLock("mylock", validLock({
      ssmPublicKey: "a".repeat(128),
      keyIndex: "0000",
    }));

    // sync: サーバ応答には ssmPublicKey/keyIndex が無い
    const list = [
      { deviceUUID: "00000000-0000-0000-0000-000000000001", deviceName: "MyLock Updated", deviceModel: "sesame_5", secretKey },
    ];
    store.syncLocksFromDevices(list);
    const cfg = store.load();
    const device = Object.values(cfg.devices).find(d => d.deviceUUID === "00000000-0000-0000-0000-000000000001");
    expect(device?.ssmPublicKey).toBe("a".repeat(128));
    expect(device?.keyIndex).toBe("0000");
    expect(device?.category).toBe("lock");
  });
});

// ---------------------------------------------------------------------------
// CFG-0062: CLI locks sync-from-devices — --prune オプションと printSyncResult 出力
// ---------------------------------------------------------------------------

describe("[CFG-0062] CLI locks sync-from-devices: --prune と printSyncResult 契約", () => {
  it("[CFG-0062] printSyncResult が {ok:true, kind, added, updated, removed} を JSON 出力する", async () => {
    const { printSyncResult } = await import("../../packages/kit/src/cli/pickers.js");
    const lines = [];
    const origLog = console.log;
    console.log = (...args) => lines.push(args.join(" "));
    try {
      printSyncResult(true /* json */, "lock", { added: ["a", "b"], updated: ["c"], removed: [] });
    } finally {
      console.log = origLog;
    }
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.ok).toBe(true);
    expect(parsed.kind).toBe("lock");
    expect(parsed.added).toEqual(["a", "b"]);
    expect(parsed.updated).toEqual(["c"]);
    expect(parsed.removed).toEqual([]);
  });

  it("[CFG-0062] registerLocksCommands が存在し sync-from-devices コマンドに --prune が登録されている", async () => {
    const locksModule = await import("../../packages/kit/src/cli/locks.js");
    expect(typeof locksModule.registerLocksCommands).toBe("function");

    // Commander を最小モックで --prune 登録を検証
    const commands = {};
    const mockProgram = {
      opts: () => ({}),
      command: (name) => {
        const sub = {
          description: () => sub,
          option: (flag) => {
            if (!sub._options) sub._options = [];
            sub._options.push(flag);
            return sub;
          },
          action: () => sub,
          addHelpText: () => sub,
          command: (subName) => {
            const child = {
              description: () => child,
              option: (flag) => {
                if (!child._options) child._options = [];
                child._options.push(flag);
                return child;
              },
              action: () => child,
              addHelpText: () => child,
              command: () => ({ description: () => ({ option: () => ({ action: () => ({}) }), action: () => ({}) }), action: () => ({}) }),
            };
            commands[`${name}:${subName}`] = child;
            return child;
          },
        };
        commands[name] = sub;
        return sub;
      },
    };
    locksModule.registerLocksCommands(mockProgram);
    const syncCmd = commands["locks:sync-from-devices"];
    expect(syncCmd).toBeDefined();
    expect(syncCmd._options?.some(f => f.includes("--prune"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CFG-0064: resolveLock 解決順序
// ---------------------------------------------------------------------------

describe("[CFG-0064] resolveLock: 明示 > default > 単一 fallback の解決順序", () => {
  it("[CFG-0064] 明示 name があれば (default より優先して) それを採用する", () => {
    const store = makeStore();
    store.addLock("L1", validLock());
    store.addLock("L2", validLock({ deviceUUID: "00000000-0000-0000-0000-000000000002" }));
    store.setDefaultLock("L1");
    const r = store.resolveLock("L2");
    expect(r.name).toBe("L2");
  });

  it("[CFG-0064] name 省略 + default.lock があれば default を採用する", () => {
    const store = makeStore();
    store.addLock("L1", validLock());
    store.addLock("L2", validLock({ deviceUUID: "00000000-0000-0000-0000-000000000002" }));
    store.setDefaultLock("L2");
    const r = store.resolveLock();
    expect(r.name).toBe("L2");
  });

  it("[CFG-0064] name 省略 + default なし + locks が 1 件ならそれを採用 (単一 fallback)", () => {
    const store = makeStore();
    store.addLock("only", validLock());
    const cfg = store.load();
    cfg.default.lock = null;
    store.save();
    const r = store.resolveLock();
    expect(r.name).toBe("only");
  });

  it("[CFG-0064] name 省略 + default なし + locks 複数 → noneSpecified (SesameError BAD_REQUEST)", () => {
    const store = makeStore();
    store.addLock("L1", validLock());
    store.addLock("L2", validLock({ deviceUUID: "00000000-0000-0000-0000-000000000002" }));
    const cfg = store.load();
    cfg.default.lock = null;
    store.save();
    expect(() => store.resolveLock()).toThrow(SesameError);
    let caught;
    try { store.resolveLock(); } catch (e) { caught = e; }
    expect(caught?.code).toBe(ERR.BAD_REQUEST);
  });

  it("[CFG-0064] 未知名を渡すと SesameError(BAD_REQUEST) を投げる", () => {
    const store = makeStore();
    store.addLock("L1", validLock());
    expect(() => store.resolveLock("nonexistent")).toThrow(SesameError);
    let caught;
    try { store.resolveLock("nonexistent"); } catch (e) { caught = e; }
    expect(caught?.code).toBe(ERR.BAD_REQUEST);
  });
});

// ---------------------------------------------------------------------------
// CFG-0065: resolve 失敗が serve で bad_params に写像
// ---------------------------------------------------------------------------

describe("[CFG-0065] resolve 失敗が SesameError(BAD_REQUEST) → errorFromThrow → bad_params 写像", () => {
  it("[CFG-0065] resolveLock の SesameError(BAD_REQUEST) が errorFromThrow で bad_params になる", () => {
    const store = makeStore();
    // locks 空 = noneSpecified
    let caught;
    try { store.resolveLock(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(SesameError);
    expect(caught?.code).toBe(ERR.BAD_REQUEST);

    const rpcEnvelope = errorFromThrow(1, caught);
    expect(rpcEnvelope.error).toBeDefined();
    expect(rpcEnvelope.error?.data?.kind).toBe("bad_params");
    // JSON-RPC INVALID_PARAMS = -32602
    expect(rpcEnvelope.error?.code).toBe(-32602);
  });

  it("[CFG-0065] resolveRemote の SesameError(BAD_REQUEST) が errorFromThrow で bad_params になる", () => {
    const store = makeStore();
    registerHub3(store);
    addRemote(store, "r1");
    addRemote(store, "r2");
    const cfg = store.load();
    cfg.default.remote = null;
    store.save();

    let caught;
    try { store.resolveRemote(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(SesameError);
    expect(caught?.code).toBe(ERR.BAD_REQUEST);

    const rpcEnvelope = errorFromThrow(2, caught);
    expect(rpcEnvelope.error?.data?.kind).toBe("bad_params");
  });

  it("[CFG-0065] 未知 lock 名も bad_params に写像される", () => {
    const store = makeStore();
    store.addLock("L1", validLock());
    let caught;
    try { store.resolveLock("no-such-lock"); } catch (e) { caught = e; }
    const rpcEnvelope = errorFromThrow(3, caught);
    expect(rpcEnvelope.error?.data?.kind).toBe("bad_params");
  });
});

// ---------------------------------------------------------------------------
// CFG-0066: init → 空スケルトンを 0700 dir + 0600 file で生成
// ---------------------------------------------------------------------------

describe("[CFG-0066] init(): 新規作成 true / 既存 no-op false / 0700 dir + 0600 file", () => {
  it("[CFG-0066] ファイル不在時のみ emptyConfig を save して true を返す", () => {
    const store = makeStore();
    const created = store.init();
    expect(created).toBe(true);
    expect(existsSync(configPath)).toBe(true);
    const written = JSON.parse(readFileSync(configPath, "utf8"));
    expect(written.companyID).toBeDefined();
    expect(written.devices).toEqual({});
    expect(written.remotes).toEqual({});
  });

  it("[CFG-0066] 既存ファイルがあれば触らず false を返す", () => {
    mkdirSync(dirname(configPath), { recursive: true });
    const original = JSON.stringify({ companyID: "preserve-me" });
    writeFileSync(configPath, original);
    const store = makeStore();
    const created = store.init();
    expect(created).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  it("[CFG-0066] init() 後のファイルは 0600 (SECRET_FILE_MODE) になる (POSIX)", () => {
    if (process.platform === "win32") return;
    const store = makeStore();
    store.init();
    const st = statSync(configPath);
    expect(st.mode & 0o777).toBe(SECRET_FILE_MODE);
  });

  it("[CFG-0066] 親ディレクトリは init() 後に存在し ensureSecureDir が 0700 にする (POSIX)", () => {
    if (process.platform === "win32") return;
    const testDir = join(workDir, "secure-dir-check");
    ensureSecureDir(testDir);
    const st = statSync(testDir);
    expect(st.mode & 0o777).toBe(SECRET_DIR_MODE);
  });

  it("[CFG-0066] 深いパスでも recursive に親ディレクトリを作成する", () => {
    const deep = join(workDir, "a", "b", "c", "config.json");
    const store = new ConfigStore(deep);
    store.init();
    expect(existsSync(deep)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CFG-0067: init --lang en が uiLang/lang を config に焼き込む
// ---------------------------------------------------------------------------

describe("[CFG-0067] init({uiLang, lang}): 言語設定を永続化", () => {
  it("[CFG-0067] langFlag 指定時 data.uiLang と data.lang が同一ロケールに設定される", () => {
    const store = makeStore();
    store.init({ uiLang: "en", lang: "en" });
    const stored = JSON.parse(readFileSync(configPath, "utf8"));
    expect(stored.uiLang).toBe("en");
    expect(stored.lang).toBe("en");
  });

  it("[CFG-0067] overrides 無しなら lang:'ja'、uiLang は未設定のまま", () => {
    const store = makeStore();
    store.init();
    const stored = JSON.parse(readFileSync(configPath, "utf8"));
    expect(stored.lang).toBe("ja");
    expect(stored.uiLang).toBeUndefined();
  });

  it("[CFG-0067] ja 指定でも uiLang=ja / lang=ja が永続化される", () => {
    const store = makeStore();
    store.init({ uiLang: "ja", lang: "ja" });
    const stored = JSON.parse(readFileSync(configPath, "utf8"));
    expect(stored.uiLang).toBe("ja");
    expect(stored.lang).toBe("ja");
  });
});

// ---------------------------------------------------------------------------
// CFG-0068: config show が secretKey をツリー全体でマスク
// ---------------------------------------------------------------------------

describe("[CFG-0068] config show: redactConfig がツリー全体の secretKey をマスク", () => {
  it("[CFG-0068] devices と locks の双方で secretKey をマスクする", async () => {
    const { redactConfig } = await import("../../packages/kit/src/cli/ctx.js");
    const RAW = "0123456789abcdef0123456789abcdef";
    const cfg = {
      devices: { front: { deviceUUID: "A", secretKey: RAW, deviceModel: "sesame_5" } },
      locks: { front: { deviceUUID: "A", secretKey: RAW, model: "sesame_5", alias: null } },
    };
    const r = redactConfig(cfg);
    expect(r.devices.front.secretKey).not.toBe(RAW);
    expect(r.locks.front.secretKey).not.toBe(RAW);
    expect(r.devices.front.secretKey).toContain("…");
    expect(r.locks.front.secretKey).toContain("…");
  });

  it("[CFG-0068] JSON.stringify 出力に生 secretKey が残らない (全ツリー走査)", async () => {
    const { redactConfig } = await import("../../packages/kit/src/cli/ctx.js");
    const RAW = "5ccec6781bb7509bdd58fa21565b647b";
    const cfg = {
      devices: { L1: { secretKey: RAW } },
      locks: { L1: { secretKey: RAW } },
    };
    const json = JSON.stringify(redactConfig(cfg));
    expect(json).not.toContain(RAW);
  });

  it("[CFG-0068] null を渡すと null のまま返す", async () => {
    const { redactConfig } = await import("../../packages/kit/src/cli/ctx.js");
    expect(redactConfig(null)).toBeNull();
  });

  it("[CFG-0068] undefined/非オブジェクトをそのまま返す", async () => {
    const { redactConfig } = await import("../../packages/kit/src/cli/ctx.js");
    expect(redactConfig(undefined)).toBeUndefined();
    expect(redactConfig("string")).toBe("string");
  });

  it("[CFG-0068] 秘密でないフィールドは保持する", async () => {
    const { redactConfig } = await import("../../packages/kit/src/cli/ctx.js");
    const cfg = { companyID: "test-co", locks: { L1: { secretKey: "x".repeat(32), model: "sesame_5" } } };
    const r = redactConfig(cfg);
    expect(r.companyID).toBe("test-co");
    expect(r.locks.L1.model).toBe("sesame_5");
  });
});

// ---------------------------------------------------------------------------
// CFG-0069: config path が解決済み設定ディレクトリの絶対パスを出力
// ---------------------------------------------------------------------------

describe("[CFG-0069] resolveConfigDir: 優先順位 override > SESAME_KIT_HOME > XDG_CONFIG_HOME > 既定", () => {
  it("[CFG-0069] override 指定があれば最優先 (そのまま返る)", () => {
    const override = join(workDir, "custom");
    const resolved = resolveConfigDir(override);
    expect(resolved).toBe(override);
  });

  it("[CFG-0069] SESAME_KIT_HOME が override より低優先で機能する", () => {
    const saved = process.env.SESAME_KIT_HOME;
    process.env.SESAME_KIT_HOME = join(workDir, "home");
    try {
      const r = resolveConfigDir(undefined);
      expect(r).toBe(join(workDir, "home"));
    } finally {
      if (saved === undefined) delete process.env.SESAME_KIT_HOME;
      else process.env.SESAME_KIT_HOME = saved;
    }
  });

  it("[CFG-0069] XDG_CONFIG_HOME が SESAME_KIT_HOME なしで機能する", () => {
    const origHome = process.env.SESAME_KIT_HOME;
    const origXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.SESAME_KIT_HOME;
    process.env.XDG_CONFIG_HOME = join(workDir, "xdg");
    try {
      const r = resolveConfigDir(undefined);
      expect(r).toContain("xdg");
      expect(r).toContain("sesame-kit");
    } finally {
      if (origHome !== undefined) process.env.SESAME_KIT_HOME = origHome;
      if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = origXdg;
    }
  });

  it("[CFG-0069] 環境変数なし・override なしで ~/.config/sesame-kit を返す", () => {
    const origHome = process.env.SESAME_KIT_HOME;
    const origXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.SESAME_KIT_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
      const r = resolveConfigDir(undefined);
      expect(r).toContain("sesame-kit");
      expect(r).toContain(".config");
    } finally {
      if (origHome !== undefined) process.env.SESAME_KIT_HOME = origHome;
      if (origXdg !== undefined) process.env.XDG_CONFIG_HOME = origXdg;
    }
  });
});

// ---------------------------------------------------------------------------
// CFG-0070: save() は config.json を 0600 / 親 0700 でアトミック書き込み
// ---------------------------------------------------------------------------

describe("[CFG-0070] save(): 0600 ファイル / 0700 親ディレクトリ / withFileLock", () => {
  it("[CFG-0070] save() 後のファイルは 0600 になる (POSIX)", () => {
    if (process.platform === "win32") return;
    const store = makeStore();
    store.load();
    store.save();
    const st = statSync(configPath);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("[CFG-0070] save() 後の親ディレクトリは 0700 になる (POSIX)", () => {
    if (process.platform === "win32") return;
    const store = makeStore();
    store.load();
    store.save();
    const parentDir = dirname(configPath);
    const st = statSync(parentDir);
    expect(st.mode & 0o777).toBe(0o700);
  });

  it("[CFG-0070] withFileLock は fn を 1 度だけ呼び結果を返す", () => {
    const lockTarget = join(workDir, "testfile.json");
    const calls = [];
    const result = withFileLock(lockTarget, () => {
      calls.push(1);
      return 42;
    });
    expect(result).toBe(42);
    expect(calls.length).toBe(1);
  });

  it("[CFG-0070] writeSecretJson が 0600 のファイルを書く (secure-fs 境界)", () => {
    if (process.platform === "win32") return;
    const target = join(workDir, "secret.json");
    writeSecretJson(target, { test: true });
    const st = statSync(target);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("[CFG-0070] save() の直後に load() するとデータが保たれる (round-trip)", () => {
    const store = makeStore();
    store.load();
    store.addLock("roundtrip", validLock());
    const store2 = makeStore();
    expect(store2.load().locks["roundtrip"]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// CFG-0071: save() round-trip と末尾改行付き pretty JSON / 親ディレクトリ再帰作成
// ---------------------------------------------------------------------------

describe("[CFG-0071] save(): round-trip / pretty JSON / 親ディレクトリ再帰作成", () => {
  it("[CFG-0071] load→save→load で値が保たれる", () => {
    const store = makeStore();
    const cfg = store.load();
    cfg.companyID = "round-trip-test";
    store.save();

    const store2 = makeStore();
    expect(store2.load().companyID).toBe("round-trip-test");
  });

  it("[CFG-0071] writeSecretJson は JSON.stringify(obj,null,2)+'\\n' を書く (末尾改行 + 2space indent)", () => {
    const target = join(workDir, "pretty.json");
    writeSecretJson(target, { a: 1, b: { c: 2 } });
    const raw = readFileSync(target, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain("  "); // 2-space indent
    expect(JSON.parse(raw)).toEqual({ a: 1, b: { c: 2 } });
  });

  it("[CFG-0071] save() は深い親ディレクトリを再帰的に作成する", () => {
    const deepPath = join(workDir, "a", "b", "c", "config.json");
    const store = new ConfigStore(deepPath);
    store.load();
    store.save();
    expect(existsSync(deepPath)).toBe(true);
  });

  it("[CFG-0071] save() の出力は末尾改行付きの pretty JSON (2-space indent)", () => {
    const store = makeStore();
    store.load();
    store.save();
    const raw = readFileSync(configPath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain("\n  ");
  });
});

// ---------------------------------------------------------------------------
// CFG-0072: save() は派生 view 以外の未知キーを保持 (ダウングレード安全)
// ---------------------------------------------------------------------------

describe("[CFG-0072] save(): DERIVED_KEYS のみ除外し未知キーを保持 (ダウングレード安全)", () => {
  it("[CFG-0072] 新版が書いたキーを旧版 save が消さない (未知キー保持)", () => {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      schemaVersion: 2,
      companyID: "ch_x",
      wsUrl: "wss://82q6nuplv0.execute-api.ap-northeast-1.amazonaws.com/public",
      lang: "ja",
      default: { remote: null, lock: null },
      devices: {},
      remotes: {},
      future_feature: "should-survive",
    }) + "\n");

    const store = makeStore();
    const cfg = store.load();
    cfg.lang = "en";
    store.save();

    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    expect(saved.future_feature).toBe("should-survive");
    expect(saved.lang).toBe("en");
  });

  it("[CFG-0072] 派生 view (locks/hub3s) はファイルに保存されない", () => {
    const store = makeStore();
    store.addLock("L1", validLock());
    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    expect(saved.locks).toBeUndefined();
    expect(saved.hub3s).toBeUndefined();
    expect(saved.devices).toBeDefined();
  });

  it("[CFG-0072] devices/remotes は保存される (真実として)", () => {
    const store = makeStore();
    store.addLock("L1", validLock());
    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    expect(saved.devices).toBeDefined();
    expect(saved.remotes).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// CFG-0073: save() のプロセス間 lost-update 防止
// ---------------------------------------------------------------------------

describe("[CFG-0073] save(): mergeConfigData による lost-update 防止", () => {
  it("[CFG-0073] 別プロセスが追加したエントリを save が消さない (devices union)", () => {
    const store1 = makeStore();
    store1.addLock("L1", validLock());

    // 別プロセス相当: 直接ファイルを書き換えて L2 を追加
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    raw.devices["L2"] = {
      deviceUUID: "uuid-2",
      secretKey: "00112233445566778899aabbccddeeff",
      deviceModel: "sesame_5",
      category: "lock",
    };
    writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n");

    // store1 で L3 を追加して save (内部で disk を再読込して merge)
    store1.addLock("L3", validLock({ deviceUUID: "00000000-0000-0000-0000-000000000003", secretKey: "ffeeddccbbaa99887766554433221100" }));

    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    expect(saved.devices["L1"]).toBeDefined();
    expect(saved.devices["L2"]).toBeDefined();
    expect(saved.devices["L3"]).toBeDefined();
  });

  it("[CFG-0073] 意図的削除は disk 側に残っていても復活しない (baselineKeys 判定)", () => {
    const store1 = makeStore();
    store1.addLock("L1", validLock());
    // load 時点の baseline に L1 が記録される
    store1.removeLock("L1");

    // 別プロセス相当: ディスクを直接書き換えて L1 を復活させる
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    raw.devices = raw.devices || {};
    raw.devices["L1"] = {
      deviceUUID: "00000000-0000-0000-0000-000000000001",
      secretKey: "0123456789abcdef0123456789abcdef",
      category: "lock",
    };
    writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n");

    // store1 で別の L2 を追加して save → merge で L1 は baseline 追跡で消えたまま
    store1.addLock("L2", validLock({ deviceUUID: "00000000-0000-0000-0000-000000000002", secretKey: "ffeeddccbbaa99887766554433221100" }));

    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    expect(saved.devices["L1"]).toBeUndefined();
    expect(saved.devices["L2"]).toBeDefined();
  });

  it("[CFG-0073] 破損 JSON はディスク再読込 merge を放棄して incoming で上書き回復する", () => {
    const store = makeStore();
    store.addLock("L1", validLock());

    // ディスクを壊す
    writeFileSync(configPath, "{broken json");

    // save は throw せず破損を上書き回復する
    expect(() => store.addLock("L2", validLock({ deviceUUID: "00000000-0000-0000-0000-000000000002", secretKey: "ffeeddccbbaa99887766554433221100" }))).not.toThrow();

    // 回復後はファイルが valid JSON
    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    expect(saved.devices).toBeDefined();
  });

  it("[CFG-0073] スカラ設定は incoming 優先 (ディスク値で上書きしない)", () => {
    const store = makeStore();
    const cfg = store.load();
    cfg.lang = "en";
    // ディスクに ja が残っていても incoming (en) が優先される
    store.save();
    const saved = JSON.parse(readFileSync(configPath, "utf8"));
    expect(saved.lang).toBe("en");
  });
});

// ---------------------------------------------------------------------------
// CFG-0074: withFileLock advisory lock の取得/解放/stale 奪取/timeout
// ---------------------------------------------------------------------------

describe("[CFG-0074] withFileLock: 取得/解放/stale 奪取/timeout", () => {
  it("[CFG-0074] 通常取得: fn の戻り値が返る", () => {
    const lockTarget = join(workDir, "testfile.json");
    const result = withFileLock(lockTarget, () => 42);
    expect(result).toBe(42);
  });

  it("[CFG-0074] fn が throw しても lock ファイルが解放される (finally)", () => {
    const lockTarget = join(workDir, "testfile2.json");
    const lockPath = `${lockTarget}.lock`;
    expect(() =>
      withFileLock(lockTarget, () => { throw new Error("fn error"); })
    ).toThrow("fn error");
    // throw 後も lock が解放されている
    expect(existsSync(lockPath)).toBe(false);
  });

  it("[CFG-0074] stale lock (pid 不存在・mtime 古) は奪取されて fn を実行できる", () => {
    const lockTarget = join(workDir, "stale.json");
    const lockPath = `${lockTarget}.lock`;
    mkdirSync(dirname(lockTarget), { recursive: true });
    // staleMs=0 で強制的に stale と判定させる
    writeFileSync(lockPath, JSON.stringify({ pid: 99999999, acquiredAt: new Date(0).toISOString() }));

    const called = [];
    const result = withFileLock(lockTarget, () => { called.push(1); return "ok"; }, { staleMs: 0 });
    expect(called.length).toBe(1);
    expect(result).toBe("ok");
  });

  it("[CFG-0074] timeout 超過で lockTimeout エラーを throw する", () => {
    const lockTarget = join(workDir, "timeout.json");
    const lockPath = `${lockTarget}.lock`;
    mkdirSync(dirname(lockTarget), { recursive: true });
    // mtime=now → stale ではない → 奪取されない
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
    expect(() =>
      withFileLock(lockTarget, () => {}, { timeoutMs: 80, staleMs: 60_000, retryIntervalMs: 10 })
    ).toThrow(/lockTimeout|lock.*timeout/i);
  });
});

// ---------------------------------------------------------------------------
// CFG-0075: v1→v2 移行: トップレベル locks/hub3s を devices{} へ取り込む
// ---------------------------------------------------------------------------

describe("[CFG-0075] migrateConfig: v1→v2 移行 / schemaVersion>=現行はそのまま", () => {
  it("[CFG-0075] schemaVersion 無し (v1) の locks/hub3s を devices{} へ取り込む", () => {
    const v1 = {
      companyID: "ch_x",
      locks: {
        front: { deviceUUID: "lock-uuid", secretKey: "aabbccddeeff00112233445566778899", model: "sesame_5", alias: "玄関" },
      },
      hub3s: {
        "hub-a": { deviceId: "hub-uuid", name: "My Hub" },
      },
    };
    const result = migrateConfig(v1);
    expect(result.schemaVersion).toBe(SCHEMA_VERSION);
    expect(result.devices["front"]).toBeDefined();
    expect(result.devices["front"].deviceUUID).toBe("lock-uuid");
    expect(result.devices["front"].category).toBe("lock");
    expect(result.devices["hub-a"]).toBeDefined();
    expect(result.devices["hub-a"].category).toBe("hub3");
    expect(result.locks).toBeUndefined();
    expect(result.hub3s).toBeUndefined();
  });

  it("[CFG-0075] schemaVersion>=現行 (新版) はそのまま (ダウングレード安全)", () => {
    const newer = { schemaVersion: SCHEMA_VERSION + 1, devices: {}, future_key: "x" };
    const result = migrateConfig(newer);
    expect(result.schemaVersion).toBe(SCHEMA_VERSION + 1);
    expect(result.future_key).toBe("x");
  });

  it("[CFG-0075] v1 の model/alias が deviceModel/deviceName に吸収される", () => {
    const v1 = {
      locks: {
        legacy: { deviceUUID: "uuid-legacy", secretKey: "sk-legacy", model: "sesame_4", alias: "裏口" },
      },
    };
    const migrated = migrateConfig(v1);
    const entry = migrated.devices["legacy"] || Object.values(migrated.devices).find(d => d.deviceUUID === "uuid-legacy");
    expect(entry?.deviceModel).toBe("sesame_4");
    expect(entry?.deviceName).toBe("裏口");
  });

  it("[CFG-0075] ConfigStore.load() が v1 ファイルを自動移行する", () => {
    const v1 = {
      companyID: "co",
      locks: {
        L1: { deviceUUID: "uuid-v1", secretKey: "aabbccddeeff00112233445566778899" },
      },
    };
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(v1));
    const store = makeStore();
    const cfg = store.load();
    expect(cfg.locks["L1"]).toBeDefined();
    expect(cfg.locks["L1"].deviceUUID).toBe("uuid-v1");
  });
});

// ---------------------------------------------------------------------------
// CFG-0076: normalizeConfig: 既定穴埋め + view 再投影 + LEGACY_WS_URL 強制
// ---------------------------------------------------------------------------

describe("[CFG-0076] normalizeConfig: 既定穴埋め / LEGACY_WS_URL 強制 / locks|hub3s 再投影", () => {
  it("[CFG-0076] emptyConfig 既定で穴埋め (companyID/wsUrl/lang/default/devices/remotes)", () => {
    const result = normalizeConfig({});
    expect(result.companyID).toBe("ch_CandyhouseMobile");
    expect(result.wsUrl).toBe("wss://82q6nuplv0.execute-api.ap-northeast-1.amazonaws.com/public");
    expect(result.lang).toBe("ja");
    expect(result.default).toEqual({ remote: null, lock: null });
    expect(result.devices).toEqual({});
    expect(result.remotes).toEqual({});
  });

  it("[CFG-0076] wsUrl が LEGACY (/production) なら /public へ強制", () => {
    const result = normalizeConfig({
      wsUrl: "wss://82q6nuplv0.execute-api.ap-northeast-1.amazonaws.com/production",
    });
    expect(result.wsUrl).toBe("wss://82q6nuplv0.execute-api.ap-northeast-1.amazonaws.com/public");
  });

  it("[CFG-0076] default.remote/lock が undefined なら null に正規化", () => {
    const result = normalizeConfig({ default: {} });
    expect(result.default.remote).toBeNull();
    expect(result.default.lock).toBeNull();
  });

  it("[CFG-0076] devices から locks/hub3s を effectiveCategory で再投影する", () => {
    const result = normalizeConfig({
      devices: {
        front: { deviceUUID: "u1", secretKey: "aabbccddeeff00112233445566778899", deviceModel: "sesame_5", category: "lock" },
        "hub-a": { deviceUUID: "h1", deviceModel: "hub_3", category: "hub3" },
      },
    });
    expect(result.locks["front"]).toBeDefined();
    expect(result.hub3s["hub-a"]).toBeDefined();
    expect(result.locks["front"].deviceUUID).toBe("u1");
    expect(result.hub3s["hub-a"].deviceId).toBe("h1");
    expect(result.locks["hub-a"]).toBeUndefined();
    expect(result.hub3s["front"]).toBeUndefined();
  });

  it("[CFG-0076] Touch/Face (認証機) は locks にも hub3s にも出ない (null category)", () => {
    const result = normalizeConfig({
      devices: {
        face: { deviceUUID: "f1", deviceModel: "sesame_face_2_pro", secretKey: "aabbccddeeff00112233445566778899" },
      },
    });
    expect(result.locks["face"]).toBeUndefined();
    expect(result.hub3s["face"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CFG-0077: load() は /production を物理的に消去
// ---------------------------------------------------------------------------

describe("[CFG-0077] load(): /production を物理的に消去 (禁止エンドポイント焼き付け防止)", () => {
  const LEGACY_WS = "wss://82q6nuplv0.execute-api.ap-northeast-1.amazonaws.com/production";
  const PUBLIC_WS = "wss://82q6nuplv0.execute-api.ap-northeast-1.amazonaws.com/public";

  it("[CFG-0077] raw.wsUrl===LEGACY のとき in-memory は /public に置換される", () => {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ wsUrl: LEGACY_WS, devices: {}, remotes: {} }) + "\n");

    const cfg = makeStore().load();
    expect(cfg.wsUrl).toBe(PUBLIC_WS);
  });

  it("[CFG-0077] raw.wsUrl===LEGACY のときファイルからも /production が消える", () => {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ wsUrl: LEGACY_WS, devices: {}, remotes: {} }) + "\n");

    makeStore().load();
    const onDisk = readFileSync(configPath, "utf8");
    expect(onDisk).not.toContain("/production");
    expect(JSON.parse(onDisk).wsUrl).toBe(PUBLIC_WS);
  });

  it("[CFG-0077] 読み取り専用環境 (save が失敗) でも in-memory は /public になる", () => {
    if (process.platform === "win32") return;
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ wsUrl: LEGACY_WS, devices: {}, remotes: {} }) + "\n");
    chmodSync(configPath, 0o444);
    try {
      // load() は save 失敗を握り潰すので throw しない
      const cfg = makeStore().load();
      expect(cfg.wsUrl).toBe(PUBLIC_WS);
    } finally {
      chmodSync(configPath, 0o644);
    }
  });

  it("[CFG-0077] 通常の wsUrl (/public) はそのまま保持する", () => {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ wsUrl: PUBLIC_WS, devices: {}, remotes: {} }) + "\n");

    const cfg = makeStore().load();
    expect(cfg.wsUrl).toBe(PUBLIC_WS);
  });

  it("[CFG-0077] カスタム wsUrl (user 指定の別エンドポイント) は変更しない", () => {
    const custom = "wss://example.invalid/custom";
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ wsUrl: custom, devices: {}, remotes: {} }) + "\n");

    const cfg = makeStore().load();
    expect(cfg.wsUrl).toBe(custom);
  });
});
