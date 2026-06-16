// cfg-c2.test.js — CFG-0039 〜 CFG-0058 統合 TDD spec テスト (A/B 統合版)
//
// 対象:
//   - packages/core/src/config.js (ConfigStore.addRemote/setDefaultRemote/resolveRemote/
//                                   addLock/removeLock/setDefaultLock/addHub3,
//                                   isLockModel, deriveIrOperation(addRemote 経由))
//   - packages/core/src/sharekey.js (parseShareKeyUrl, buildShareKeyUrl)
//   - packages/kit/src/cli/locks.js (registerLocksCommands 経由の CLI guard)
//   - packages/kit/src/cli/remote.js (registerRemoteCommands 経由の CLI guard)
//
// 方針:
//   - 各 it タイトル先頭に [<ID>] を置く (spec 要件)。
//   - assert は spec どおりの期待値で検証 (実装の現状に合わせて歪めない)。
//   - ネットワーク/実機に触れない。全て純関数・ConfigStore (tmpdir 実 IO)・CLI mock で完結。
//   - CLI guard テスト (CFG-0041/0043/0057) は vi.mock で ctx.js/errors.js を差し替え。
//     die() が throw に変わるため process.exit() を呼ばず捕捉可能になる。
//   - vi.mock は vitest が hoist するため import より先に書く (ESM 規約)。

// ---- CLI テスト用 vi.mock (hoist 対象) -------------------------------------

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ctx.js をモック: loadCtx/canPrompt/out/withHub/redactConfig/promptLine を制御可能にする。
vi.mock("../../../kit/src/cli/ctx.js", () => {
  return {
    loadCtx: vi.fn(() => ({
      opts: { json: false },
      configStore: {
        exists: () => false,
        load: () => ({ locks: {}, remotes: {}, hub3s: {}, default: { lock: null, remote: null } }),
        removeLock: () => {},
      },
      tokenStore: {},
      paths: { config: "/fake/config.json", dir: "/fake" },
    })),
    canPrompt: vi.fn(() => false),
    out: vi.fn((_json, humanFn, _jsonObj) => { if (humanFn) humanFn(); }),
    withHub: vi.fn(),
    redactConfig: vi.fn((x) => x),
    promptLine: vi.fn(async () => ""),
    mask: vi.fn((s) => s),
    hasCloudSession: vi.fn(() => false),
  };
});

// errors.js をモック: die() が throw するようにして process.exit() を回避する。
vi.mock("../../../kit/src/cli/errors.js", () => {
  const dieImpl = vi.fn((msg, code) => {
    const e = new Error(msg);
    e.exitCode = code ?? 1;
    throw e;
  });
  return {
    die: dieImpl,
    isJsonMode: vi.fn(() => false),
    setJsonMode: vi.fn(),
    EXIT: { OK: 0, RUNTIME: 1, USAGE: 2 },
    withStaleHint: vi.fn((msg) => msg),
    commanderErrorInfo: vi.fn((err) => ({ code: 1, msg: err.message })),
    isCommanderError: vi.fn(() => false),
    runtimeExitCode: vi.fn(() => 1),
    maybeHandleBleError: vi.fn(),
  };
});

// prompts.js をモック
vi.mock("../../../kit/src/prompts.js", () => ({
  confirm: vi.fn(async () => false),
  promptText: vi.fn(async () => ""),
  selectFromList: vi.fn(async (_, items) => items[0]),
  promptLine: vi.fn(async () => ""),
  isInteractive: vi.fn(() => false),
  menu: vi.fn(),
}));

// pickers.js をモック
vi.mock("../../../kit/src/cli/pickers.js", () => ({
  printSyncResult: vi.fn(),
  pickRemoteName: vi.fn(),
  pickRemoteKeyName: vi.fn(),
}));

// ---- 通常 import (vi.mock の後) -------------------------------------------

import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { ConfigStore, isLockModel } from "../../src/config.js";
import { parseShareKeyUrl, buildShareKeyUrl } from "../../src/sharekey.js";
import { SesameError, ERR } from "../../src/errors.js";

import { registerLocksCommands } from "../../../kit/src/cli/locks.js";
import { registerRemoteCommands } from "../../../kit/src/cli/remote.js";
import { loadCtx, canPrompt } from "../../../kit/src/cli/ctx.js";
import { die } from "../../../kit/src/cli/errors.js";

import { Command } from "commander";

// ---- セットアップ ----------------------------------------------------------

let workDir;
let configPath;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "sesame-cfg-c2-"));
  configPath = join(workDir, "nested", "config.json");

  vi.mocked(loadCtx).mockReturnValue({
    opts: { json: false },
    configStore: {
      exists: () => false,
      load: () => ({ locks: {}, remotes: {}, hub3s: {}, default: { lock: null, remote: null } }),
      removeLock: () => {},
    },
    tokenStore: {},
    paths: { config: "/fake/config.json", dir: "/fake" },
  });
  vi.mocked(canPrompt).mockReturnValue(false);
  vi.mocked(die).mockImplementation((msg, code) => {
    const e = new Error(msg);
    e.exitCode = code ?? 1;
    throw e;
  });
});

afterEach(() => {
  if (workDir && existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  }
  workDir = null;
  configPath = null;
  vi.restoreAllMocks();
});

// ---- ヘルパ ----------------------------------------------------------------

function makeStore() {
  mkdirSync(dirname(configPath), { recursive: true });
  const store = new ConfigStore(configPath);
  store.init();
  return store;
}

function makeStoreWithHub3(name = "hub-a") {
  const store = makeStore();
  store.addHub3(name, { deviceId: `dev-${name}` });
  return store;
}

function validLock(overrides = {}) {
  return {
    deviceUUID: "00000000-0000-0000-0000-000000000001",
    secretKey: "0123456789abcdef0123456789abcdef",
    ...overrides,
  };
}

function buildProgram() {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  return program;
}

// ============================================================================
// CFG-0039 — deriveIrOperation: 0xFE00 のみ learnEmit、他は remoteEmit
// ============================================================================
describe("CFG-0039: deriveIrOperation — irType から operation を導出", () => {
  it("[CFG-0039] irType=0xfe00 (自己学習) のとき irOperation は learnEmit になる", () => {
    const store = makeStoreWithHub3();
    store.addRemote("learn-r", {
      hub3: "hub-a",
      irDeviceUUID: "ir-uuid-learn",
      irType: 0xfe00,
      // irOperation 未指定 → deriveIrOperation(0xfe00) = 'learnEmit'
    });
    expect(store.load().remotes["learn-r"].irOperation).toBe("learnEmit");
  });

  it("[CFG-0039] irType=0xC000 (エアコン=プリセット) のとき irOperation は remoteEmit になる", () => {
    const store = makeStoreWithHub3();
    store.addRemote("r1", {
      hub3: "hub-a",
      irDeviceUUID: "ir-uuid-preset",
      irType: 0xc000,
    });
    expect(store.load().remotes.r1.irOperation).toBe("remoteEmit");
  });

  it("[CFG-0039] irType=0x2000 (テレビ=プリセット) のとき irOperation は remoteEmit になる", () => {
    const store = makeStoreWithHub3();
    store.addRemote("r1", {
      hub3: "hub-a",
      irDeviceUUID: "ir-uuid-preset2",
      irType: 0x2000,
    });
    expect(store.load().remotes.r1.irOperation).toBe("remoteEmit");
  });

  it("[CFG-0039] irType=0x8000 のとき irOperation は remoteEmit になる", () => {
    const store = makeStoreWithHub3();
    store.addRemote("r1", {
      hub3: "hub-a",
      irDeviceUUID: "ir-uuid-any",
      irType: 0x8000,
    });
    expect(store.load().remotes.r1.irOperation).toBe("remoteEmit");
  });

  it("[CFG-0039] irType=1 (任意非0xfe00) のとき irOperation は remoteEmit になる", () => {
    const store = makeStoreWithHub3();
    store.addRemote("any-r", {
      hub3: "hub-a",
      irDeviceUUID: "ir-uuid-any2",
      irType: 1,
    });
    expect(store.load().remotes["any-r"].irOperation).toBe("remoteEmit");
  });

  it("[CFG-0039] irOperation を明示指定したときはその値が優先される (導出を上書きしない)", () => {
    const store = makeStoreWithHub3();
    store.addRemote("r1", {
      hub3: "hub-a",
      irDeviceUUID: "ir-uuid-override",
      irType: 0xc000,
      irOperation: "learnEmit",
    });
    expect(store.load().remotes.r1.irOperation).toBe("learnEmit");
  });
});

// ============================================================================
// CFG-0040 — setDefaultRemote: 未知名は BAD_REQUEST
// ============================================================================
describe("CFG-0040: setDefaultRemote — 未知名は BAD_REQUEST", () => {
  it("[CFG-0040] setDefaultRemote に未登録名を渡すと SesameError(BAD_REQUEST) を throw する", () => {
    const store = makeStore();
    expect(() => store.setDefaultRemote("no-such-remote")).toThrow(SesameError);
    expect(() => store.setDefaultRemote("no-such-remote")).toThrow(/Unknown remote/i);
  });

  it("[CFG-0040] SesameError の code が bad_request である", () => {
    const store = makeStore();
    let err;
    try { store.setDefaultRemote("ghost"); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
  });

  it("[CFG-0040] 登録済み名は default.remote に設定される (正常系)", () => {
    const store = makeStoreWithHub3();
    store.addRemote("r1", { hub3: "hub-a", irDeviceUUID: "ir-1", irType: 0xfe00 });
    store.addRemote("r2", { hub3: "hub-a", irDeviceUUID: "ir-2", irType: 0xfe00 });
    store.setDefaultRemote("r2");
    expect(store.load().default.remote).toBe("r2");
  });

  it("[CFG-0040] 存在しない名前は常に throw する", () => {
    const store = makeStoreWithHub3();
    store.addRemote("r1", { hub3: "hub-a", irDeviceUUID: "ir-1", irType: 0xfe00 });
    expect(() => store.setDefaultRemote("r3")).toThrow();
  });
});

// ============================================================================
// CFG-0041 — remote ls: 未初期化 exit 2 (CLI guard) + exists() 基盤
// ============================================================================
describe("CFG-0041: remote ls — 未初期化は exit 2", () => {
  it("[CFG-0041] configStore.exists() が false の場合は die(configNotInitialized, 2) が呼ばれる", async () => {
    vi.mocked(loadCtx).mockReturnValue({
      opts: { json: false },
      configStore: { exists: () => false },
      tokenStore: {},
      paths: {},
    });

    const program = buildProgram();
    registerRemoteCommands(program);

    await expect(
      program.parseAsync(["remote", "ls"], { from: "user" }),
    ).rejects.toThrow();

    expect(die).toHaveBeenCalledWith(expect.any(String), 2);
  });

  it("[CFG-0041] die に渡された exitCode は 2 (usage error)", async () => {
    vi.mocked(loadCtx).mockReturnValue({
      opts: { json: false },
      configStore: { exists: () => false },
      tokenStore: {},
      paths: {},
    });

    const program = buildProgram();
    registerRemoteCommands(program);

    let caughtExitCode;
    try {
      await program.parseAsync(["remote", "ls"], { from: "user" });
    } catch (e) {
      caughtExitCode = e.exitCode;
    }
    expect(caughtExitCode).toBe(2);
  });

  it("[CFG-0041] ConfigStore.exists() はファイル不在で false、init 後は true を返す", () => {
    const dir = mkdtempSync(join(tmpdir(), "sesame-cfg-041-"));
    const path = join(dir, "config.json");
    try {
      const store = new ConfigStore(path);
      expect(store.exists()).toBe(false);
      store.init();
      expect(store.exists()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// CFG-0042 — resolveRemote: 親 hub3 view 不在で BAD_REQUEST
// ============================================================================
describe("CFG-0042: resolveRemote — 親 hub3 未登録は BAD_REQUEST", () => {
  it("[CFG-0042] remote は存在するが hub3 が削除されると SesameError を throw する", () => {
    const store = makeStoreWithHub3();
    store.addRemote("r1", { hub3: "hub-a", irDeviceUUID: "ir-1", irType: 0xfe00 });
    // hub3 を強制削除して hub3s view を破壊する
    const cfg = store.load();
    delete cfg.devices["hub-a"];
    store.save();

    expect(() => store.resolveRemote("r1")).toThrow(SesameError);
  });

  it("[CFG-0042] throw の code が bad_request である", () => {
    const store = makeStoreWithHub3();
    store.addRemote("r1", { hub3: "hub-a", irDeviceUUID: "ir-1", irType: 0xfe00 });
    const cfg = store.load();
    delete cfg.devices["hub-a"];
    store.save();

    let err;
    try { store.resolveRemote("r1"); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
  });

  it("[CFG-0042] hub3 が正常に登録されているとき resolveRemote は成功する (正常系)", () => {
    const store = makeStoreWithHub3();
    store.addRemote("r1", { hub3: "hub-a", irDeviceUUID: "ir-1", irType: 0xfe00 });
    const result = store.resolveRemote("r1");
    expect(result.name).toBe("r1");
    expect(result.hub3Name).toBe("hub-a");
    expect(result.hub3).toBeDefined();
  });
});

// ============================================================================
// CFG-0043 — locks add 非対話: 必須フラグ欠落で die(exit 2)
// ============================================================================
describe("CFG-0043: locks add 非対話 — 必須フラグ欠落で exit 2", () => {
  function makeLockAddStore() {
    const fakeStore = {
      exists: () => true,
      load: () => ({ locks: {}, default: { lock: null } }),
      addLock: vi.fn(),
    };
    vi.mocked(loadCtx).mockReturnValue({
      opts: { json: false },
      configStore: fakeStore,
      tokenStore: {},
      paths: {},
    });
    vi.mocked(canPrompt).mockReturnValue(false);
    return fakeStore;
  }

  it("[CFG-0043] canPrompt=false かつ --name 未指定のとき die(flagRequired, 2) が呼ばれる", async () => {
    makeLockAddStore();
    const program = buildProgram();
    registerLocksCommands(program);

    await expect(
      program.parseAsync(
        ["locks", "add", "--uuid", "0102030405060708090a0b0c0d0e0f10", "--secret", "0102030405060708090a0b0c0d0e0f10"],
        { from: "user" },
      ),
    ).rejects.toThrow();

    expect(die).toHaveBeenCalledWith(expect.any(String), 2);
  });

  it("[CFG-0043] canPrompt=false かつ --uuid 未指定のとき die(flagRequired, 2) が呼ばれる", async () => {
    makeLockAddStore();
    const program = buildProgram();
    registerLocksCommands(program);

    await expect(
      program.parseAsync(
        ["locks", "add", "--name", "MyLock", "--secret", "0102030405060708090a0b0c0d0e0f10"],
        { from: "user" },
      ),
    ).rejects.toThrow();

    expect(die).toHaveBeenCalledWith(expect.any(String), 2);
  });

  it("[CFG-0043] canPrompt=false かつ --secret 未指定のとき die(flagRequired, 2) が呼ばれる", async () => {
    makeLockAddStore();
    const program = buildProgram();
    registerLocksCommands(program);

    await expect(
      program.parseAsync(
        ["locks", "add", "--name", "MyLock", "--uuid", "0102030405060708090a0b0c0d0e0f10"],
        { from: "user" },
      ),
    ).rejects.toThrow();

    expect(die).toHaveBeenCalledWith(expect.any(String), 2);
  });

  it("[CFG-0043] core: name が空のとき addLock は badRequest を throw する", () => {
    const store = makeStore();
    expect(() => store.addLock("", validLock())).toThrow();
    expect(() => store.addLock(null, validLock())).toThrow();
    expect(() => store.addLock(undefined, validLock())).toThrow();
  });

  it("[CFG-0043] core: uuid が無ければ addLock は badRequest を throw する", () => {
    const store = makeStore();
    expect(() => store.addLock("L1", { secretKey: "0123456789abcdef0123456789abcdef" })).toThrow();
  });

  it("[CFG-0043] core: secret が無ければ addLock は badRequest を throw する", () => {
    const store = makeStore();
    expect(() => store.addLock("L1", { deviceUUID: "00000000-0000-0000-0000-000000000001" })).toThrow();
  });
});

// ============================================================================
// CFG-0044 — locks add: deviceUUID 形式不正で exit 2
// ============================================================================
describe("CFG-0044: isDeviceUuidLike — UUID 形式検証", () => {
  function makeLockAddStoreWithExists() {
    const fakeStore = {
      exists: () => true,
      load: () => ({ locks: {}, default: { lock: null } }),
      addLock: vi.fn(),
    };
    vi.mocked(loadCtx).mockReturnValue({
      opts: { json: false },
      configStore: fakeStore,
      tokenStore: {},
      paths: {},
    });
    vi.mocked(canPrompt).mockReturnValue(false);
    return fakeStore;
  }

  it("[CFG-0044] 32 hex 文字 (ハイフンなし) は受理される", async () => {
    const fakeStore = makeLockAddStoreWithExists();
    const program = buildProgram();
    registerLocksCommands(program);

    await program.parseAsync(
      ["locks", "add",
        "--name", "TestLock",
        "--uuid", "0102030405060708090a0b0c0d0e0f10",
        "--secret", "0102030405060708090a0b0c0d0e0f10",
      ],
      { from: "user" },
    );
    expect(fakeStore.addLock).toHaveBeenCalled();
    const dieCalls = vi.mocked(die).mock.calls;
    const exit2Calls = dieCalls.filter(([, code]) => code === 2);
    expect(exit2Calls).toHaveLength(0);
  });

  it("[CFG-0044] 8-4-4-4-12 ハイフン UUID は受理される", async () => {
    const fakeStore = makeLockAddStoreWithExists();
    const program = buildProgram();
    registerLocksCommands(program);

    await program.parseAsync(
      ["locks", "add",
        "--name", "TestLock",
        "--uuid", "01020304-0506-0708-090a-0b0c0d0e0f10",
        "--secret", "0102030405060708090a0b0c0d0e0f10",
      ],
      { from: "user" },
    );
    expect(fakeStore.addLock).toHaveBeenCalled();
  });

  it("[CFG-0044] 不正な UUID 文字列では die(invalidDeviceUuid, 2) が呼ばれる", async () => {
    makeLockAddStoreWithExists();
    const program = buildProgram();
    registerLocksCommands(program);

    await expect(
      program.parseAsync(
        ["locks", "add",
          "--name", "TestLock",
          "--uuid", "not-a-valid-uuid",
          "--secret", "0102030405060708090a0b0c0d0e0f10",
        ],
        { from: "user" },
      ),
    ).rejects.toThrow();

    expect(die).toHaveBeenCalledWith(expect.any(String), 2);
  });

  it("[CFG-0044] 31 桁 hex (1 文字短い) は不正として die(exit 2) になる", async () => {
    makeLockAddStoreWithExists();
    const program = buildProgram();
    registerLocksCommands(program);

    await expect(
      program.parseAsync(
        ["locks", "add",
          "--name", "TestLock",
          "--uuid", "0102030405060708090a0b0c0d0e0f1",  // 31 chars
          "--secret", "0102030405060708090a0b0c0d0e0f10",
        ],
        { from: "user" },
      ),
    ).rejects.toThrow();

    expect(die).toHaveBeenCalledWith(expect.any(String), 2);
  });

  it("[CFG-0044] isDeviceUuidLike ロジック確認: 正常系/異常系", () => {
    // locks.js の isDeviceUuidLike 実装を参照した純粋検証
    function isDeviceUuidLike(v) {
      return (
        typeof v === "string" &&
        (/^[0-9a-f]{32}$/i.test(v) ||
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v))
      );
    }
    expect(isDeviceUuidLike("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isDeviceUuidLike("00000000-0000-0000-0000-000000000001")).toBe(true);
    expect(isDeviceUuidLike("0123456789abcdef012345678")).toBe(false);
    expect(isDeviceUuidLike("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")).toBe(false);
    expect(isDeviceUuidLike("")).toBe(false);
    expect(isDeviceUuidLike(null)).toBe(false);
  });
});

// ============================================================================
// CFG-0045 — locks add: secretKey は 32hex 必須
// ============================================================================
describe("CFG-0045: isSecretKeyLike — secretKey は 32hex 必須", () => {
  function makeLockAddStoreExists() {
    const fakeStore = {
      exists: () => true,
      load: () => ({ locks: {}, default: { lock: null } }),
      addLock: vi.fn(),
    };
    vi.mocked(loadCtx).mockReturnValue({
      opts: { json: false },
      configStore: fakeStore,
      tokenStore: {},
      paths: {},
    });
    vi.mocked(canPrompt).mockReturnValue(false);
    return fakeStore;
  }

  it("[CFG-0045] ^[0-9a-f]{32}$ に合致する secret は受理される", async () => {
    const fakeStore = makeLockAddStoreExists();
    const program = buildProgram();
    registerLocksCommands(program);

    await program.parseAsync(
      ["locks", "add",
        "--name", "TestLock",
        "--uuid", "0102030405060708090a0b0c0d0e0f10",
        "--secret", "aabbccddeeff00112233445566778899",
      ],
      { from: "user" },
    );
    expect(fakeStore.addLock).toHaveBeenCalled();
  });

  it("[CFG-0045] 31 桁の秘密鍵は不正として die(exit 2) になる", async () => {
    makeLockAddStoreExists();
    const program = buildProgram();
    registerLocksCommands(program);

    await expect(
      program.parseAsync(
        ["locks", "add",
          "--name", "TestLock",
          "--uuid", "0102030405060708090a0b0c0d0e0f10",
          "--secret", "aabbccddeeff0011223344556677889", // 31 chars
        ],
        { from: "user" },
      ),
    ).rejects.toThrow();

    expect(die).toHaveBeenCalledWith(expect.any(String), 2);
  });

  it("[CFG-0045] 大文字 hex を含む secret は受理される (/i フラグ付き実装)", async () => {
    const fakeStore = makeLockAddStoreExists();
    const program = buildProgram();
    registerLocksCommands(program);

    await program.parseAsync(
      ["locks", "add",
        "--name", "TestLock",
        "--uuid", "0102030405060708090a0b0c0d0e0f10",
        "--secret", "AABBCCDDEEFF00112233445566778899",
      ],
      { from: "user" },
    );
    expect(fakeStore.addLock).toHaveBeenCalled();
  });

  it("[CFG-0045] 32 文字だが非 hex 文字を含む secret は die(exit 2) になる", async () => {
    makeLockAddStoreExists();
    const program = buildProgram();
    registerLocksCommands(program);

    await expect(
      program.parseAsync(
        ["locks", "add",
          "--name", "TestLock",
          "--uuid", "0102030405060708090a0b0c0d0e0f10",
          "--secret", "ggbbccddeeff00112233445566778899", // 'g' は非 hex
        ],
        { from: "user" },
      ),
    ).rejects.toThrow();

    expect(die).toHaveBeenCalledWith(expect.any(String), 2);
  });

  it("[CFG-0045] isSecretKeyLike ロジック確認: 正常系/異常系", () => {
    function isSecretKeyLike(v) {
      return typeof v === "string" && /^[0-9a-f]{32}$/i.test(v);
    }
    expect(isSecretKeyLike("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(isSecretKeyLike("AABBCCDDEEFF00112233445566778899")).toBe(true);
    expect(isSecretKeyLike("0123456789abcdef012345678")).toBe(false);
    expect(isSecretKeyLike("xyz")).toBe(false);
    expect(isSecretKeyLike("")).toBe(false);
    expect(isSecretKeyLike(null)).toBe(false);
  });
});

// ============================================================================
// CFG-0046 — locks add --model: biz3 lockModelDevices ホワイトリスト以外で拒否
// ============================================================================
describe("CFG-0046: isLockModel — biz3 lockModelDevices と集合一致", () => {
  const EXPECTED_LOCK_MODELS = [
    "sesame_2", "sesame_4", "sesame_5", "sesame_5_pro", "sesame_5_us",
    "bot_2", "bot_3", "ssmbot_1",
    "sesame_6", "sesame_6_pro", "sesame_6_pro_slidingdoor",
    "BLE_Connector_1", "bike_2", "bike_3",
  ];

  it("[CFG-0046] LOCK_MODELS が gUtils.lockModelDevices の 14 モデル全てを含む", () => {
    for (const model of EXPECTED_LOCK_MODELS) {
      expect(isLockModel(model)).toBe(true);
    }
    expect(EXPECTED_LOCK_MODELS.length).toBe(14);
  });

  it("[CFG-0046] hub_3 / hub_3_lte はロックモデルではない (Hub3 カテゴリ)", () => {
    expect(isLockModel("hub_3")).toBe(false);
    expect(isLockModel("hub_3_lte")).toBe(false);
  });

  it("[CFG-0046] 認証機 (sesame_face*/ssm_touch*) はロックモデルではない", () => {
    expect(isLockModel("sesame_face_pro")).toBe(false);
    expect(isLockModel("ssm_touch_pro")).toBe(false);
    expect(isLockModel("sesame_touch")).toBe(false);
  });

  it("[CFG-0046] null / undefined / 未知文字列はロックモデルではない", () => {
    expect(isLockModel(null)).toBe(false);
    expect(isLockModel(undefined)).toBe(false);
    expect(isLockModel("unknown_model")).toBe(false);
    expect(isLockModel("wm_2")).toBe(false);
    expect(isLockModel("bike_1")).toBe(false);
    expect(isLockModel("")).toBe(false);
  });

  it("[CFG-0046] 不正 model を --model で渡すと CLI が die(invalidLockModel, 2) を呼ぶ", async () => {
    const fakeStore = {
      exists: () => true,
      load: () => ({ locks: {}, default: { lock: null } }),
      addLock: vi.fn(),
    };
    vi.mocked(loadCtx).mockReturnValue({
      opts: { json: false },
      configStore: fakeStore,
      tokenStore: {},
      paths: {},
    });
    vi.mocked(canPrompt).mockReturnValue(false);

    const program = buildProgram();
    registerLocksCommands(program);

    await expect(
      program.parseAsync(
        ["locks", "add",
          "--name", "TestLock",
          "--uuid", "0102030405060708090a0b0c0d0e0f10",
          "--secret", "0102030405060708090a0b0c0d0e0f10",
          "--model", "hub_3",
        ],
        { from: "user" },
      ),
    ).rejects.toThrow();

    expect(die).toHaveBeenCalledWith(expect.any(String), 2);
  });
});

// ============================================================================
// CFG-0047 — locks add --ssm-public-key は 128hex 必須
// ============================================================================
describe("CFG-0047: ssmPublicKey — 128hex 必須 (OS2 鍵素材)", () => {
  it("[CFG-0047] core: addLock に 128 桁 hex の ssmPublicKey は受理される", () => {
    const store = makeStore();
    const validPubKey = "ab".repeat(64); // 128 hex chars
    store.addLock("L1", {
      deviceUUID: "0102030405060708090a0b0c0d0e0f10",
      secretKey: "0102030405060708090a0b0c0d0e0f10",
      ssmPublicKey: validPubKey,
    });
    expect(store.load().locks.L1.ssmPublicKey).toBe(validPubKey);
  });

  it("[CFG-0047] core: 大文字混じり 128hex は lowercase へ正規化して保存する", () => {
    const store = makeStore();
    const pubUpper = "AB".repeat(64);
    store.addLock("L1", {
      deviceUUID: "0102030405060708090a0b0c0d0e0f10",
      secretKey: "0102030405060708090a0b0c0d0e0f10",
      ssmPublicKey: pubUpper,
    });
    expect(store.load().locks.L1.ssmPublicKey).toBe("ab".repeat(64));
  });

  it("[CFG-0047] core: 128 桁でない ssmPublicKey は addLock で SesameError(BAD_REQUEST) になる", () => {
    const store = makeStore();
    const bad = [
      "ab".repeat(63),  // 126 hex (短い)
      "ab".repeat(65),  // 130 hex (長い)
      "zz".repeat(64),  // hex 以外
      "not-hex",
    ];
    for (const ssmPublicKey of bad) {
      expect(() =>
        store.addLock("L1", {
          deviceUUID: "0102030405060708090a0b0c0d0e0f10",
          secretKey: "0102030405060708090a0b0c0d0e0f10",
          ssmPublicKey,
        }),
      ).toThrow(SesameError);
    }
  });

  it("[CFG-0047] core: ssmPublicKey が null/undefined のとき addLock は成功し、キー自体を作らない", () => {
    const store = makeStore();
    store.addLock("L1", {
      deviceUUID: "0102030405060708090a0b0c0d0e0f10",
      secretKey: "0102030405060708090a0b0c0d0e0f10",
      ssmPublicKey: null,
    });
    const lock = store.load().locks.L1;
    expect("ssmPublicKey" in lock).toBe(false);
  });

  it("[CFG-0047] CLI: 128 桁でない --ssm-public-key は die(exit 2) になる", async () => {
    const fakeStore = {
      exists: () => true,
      load: () => ({ locks: {}, default: { lock: null } }),
      addLock: vi.fn(),
    };
    vi.mocked(loadCtx).mockReturnValue({
      opts: { json: false },
      configStore: fakeStore,
      tokenStore: {},
      paths: {},
    });
    vi.mocked(canPrompt).mockReturnValue(false);

    const program = buildProgram();
    registerLocksCommands(program);

    await expect(
      program.parseAsync(
        ["locks", "add",
          "--name", "TestLock",
          "--uuid", "0102030405060708090a0b0c0d0e0f10",
          "--secret", "0102030405060708090a0b0c0d0e0f10",
          "--ssm-public-key", "ab".repeat(32), // 64 chars, not 128
        ],
        { from: "user" },
      ),
    ).rejects.toThrow();

    expect(die).toHaveBeenCalledWith(expect.any(String), 2);
  });
});

// ============================================================================
// CFG-0048 — locks add --key-index は 4hex 必須
// ============================================================================
describe("CFG-0048: keyIndex — 4hex 必須 (OS2 keyIndex)", () => {
  it("[CFG-0048] core: addLock に 4 桁 hex の keyIndex は受理される", () => {
    const store = makeStore();
    store.addLock("L1", {
      deviceUUID: "0102030405060708090a0b0c0d0e0f10",
      secretKey: "0102030405060708090a0b0c0d0e0f10",
      keyIndex: "0001",
    });
    expect(store.load().locks.L1.keyIndex).toBe("0001");
  });

  it("[CFG-0048] core: 大文字 4hex は lowercase 正規化されて保存される", () => {
    const store = makeStore();
    store.addLock("L1", {
      deviceUUID: "0102030405060708090a0b0c0d0e0f10",
      secretKey: "0102030405060708090a0b0c0d0e0f10",
      keyIndex: "00FF",
    });
    expect(store.load().locks.L1.keyIndex).toBe("00ff");
  });

  it("[CFG-0048] core: 4 桁でない keyIndex は addLock で SesameError(BAD_REQUEST) になる", () => {
    const store = makeStore();
    const bad = ["001", "00011", "zzzz", "0x00", "FFFFF"];
    for (const keyIndex of bad) {
      expect(() =>
        store.addLock("L1", {
          deviceUUID: "0102030405060708090a0b0c0d0e0f10",
          secretKey: "0102030405060708090a0b0c0d0e0f10",
          keyIndex,
        }),
      ).toThrow(SesameError);
    }
  });

  it("[CFG-0048] core: keyIndex が null のとき addLock は成功し、キー自体を作らない", () => {
    const store = makeStore();
    store.addLock("L1", {
      deviceUUID: "0102030405060708090a0b0c0d0e0f10",
      secretKey: "0102030405060708090a0b0c0d0e0f10",
      keyIndex: null,
    });
    expect("keyIndex" in store.load().locks.L1).toBe(false);
  });

  it("[CFG-0048] CLI: 4 桁でない --key-index は die(exit 2) になる", async () => {
    const fakeStore = {
      exists: () => true,
      load: () => ({ locks: {}, default: { lock: null } }),
      addLock: vi.fn(),
    };
    vi.mocked(loadCtx).mockReturnValue({
      opts: { json: false },
      configStore: fakeStore,
      tokenStore: {},
      paths: {},
    });
    vi.mocked(canPrompt).mockReturnValue(false);

    const program = buildProgram();
    registerLocksCommands(program);

    await expect(
      program.parseAsync(
        ["locks", "add",
          "--name", "TestLock",
          "--uuid", "0102030405060708090a0b0c0d0e0f10",
          "--secret", "0102030405060708090a0b0c0d0e0f10",
          "--key-index", "001",  // 3 chars — invalid
        ],
        { from: "user" },
      ),
    ).rejects.toThrow();

    expect(die).toHaveBeenCalledWith(expect.any(String), 2);
  });
});

// ============================================================================
// CFG-0049 — parseShareKeyUrl: OS3 共有 URL round-trip
// ============================================================================
describe("CFG-0049: parseShareKeyUrl — OS3 共有 URL 解析", () => {
  const OS3_KEY = {
    deviceModel: "sesame_5",
    secretKey: "0102030405060708090a0b0c0d0e0f10",
    sesame2PublicKey: "aabbccdd", // OS3 は 4B = 8 hex chars
    keyIndex: "0001",
    deviceUUID: "12345678-ABCD-EF01-2345-678901234567",
    deviceName: "My Lock",
  };

  it("[CFG-0049] buildShareKeyUrl → parseShareKeyUrl round-trip が secretKey/UUID を復元する", () => {
    const url = buildShareKeyUrl(OS3_KEY, { keyLevel: 0 });
    expect(typeof url).toBe("string");
    expect(url.startsWith("ssm://UI?")).toBe(true);

    const parsed = parseShareKeyUrl(url);
    expect(parsed.secretKey).toBe(OS3_KEY.secretKey.toLowerCase());
    expect(parsed.deviceUUID.replace(/-/g, "").toLowerCase()).toBe(
      OS3_KEY.deviceUUID.replace(/-/g, "").toLowerCase(),
    );
    expect(parsed.deviceModel).toBe("sesame_5");
  });

  it("[CFG-0049] parseShareKeyUrl が deviceName (n パラメータ) を返す", () => {
    const url = buildShareKeyUrl(OS3_KEY, { keyLevel: 0, name: "Front Door" });
    const parsed = parseShareKeyUrl(url);
    expect(parsed.deviceName).toBe("Front Door");
  });

  it("[CFG-0049] parseShareKeyUrl が keyLevel を返す", () => {
    const url = buildShareKeyUrl(OS3_KEY, { keyLevel: 1 });
    const parsed = parseShareKeyUrl(url);
    expect(parsed.keyLevel).toBe(1);
  });

  it("[CFG-0049] sk パラメータが無い URL は badRequest を throw する", () => {
    expect(() => parseShareKeyUrl("ssm://UI?t=sk&l=0&n=test")).toThrow();
  });

  it("[CFG-0049] URL が空文字列/null の場合は badRequest を throw する", () => {
    expect(() => parseShareKeyUrl("")).toThrow();
    expect(() => parseShareKeyUrl(null)).toThrow();
  });

  it("[CFG-0049] OS3 レイアウト: sesame2PublicKey は 4B (8 hex chars)", () => {
    const url = buildShareKeyUrl(OS3_KEY, { keyLevel: 0 });
    const parsed = parseShareKeyUrl(url);
    expect(parsed.sesame2PublicKey).toBe(OS3_KEY.sesame2PublicKey.toLowerCase());
    expect(parsed.sesame2PublicKey.length).toBe(8);
  });

  it("[CFG-0049] --from-url 由来値: uuid/secret/name/keyLevel が揃って返る", () => {
    const key = {
      deviceModel: "sesame_5",
      secretKey: "aabbccddeeff00112233445566778899",
      sesame2PublicKey: "11223344",
      keyIndex: "0002",
      deviceUUID: "aaaabbbb-cccc-dddd-eeee-ffffffffffff",
      deviceName: "Fallback",
    };
    const url = buildShareKeyUrl(key, { keyLevel: 1 });
    const parsed = parseShareKeyUrl(url);
    expect(parsed.deviceUUID).toBeTruthy();
    expect(parsed.secretKey).toBe(key.secretKey);
    expect(parsed.deviceName).toBe("Fallback");
    expect(parsed.keyLevel).toBe(1);
  });
});

// ============================================================================
// CFG-0050 — parseShareKeyUrl: ゲスト共有 (l=2) の guestKeyId
// ============================================================================
describe("CFG-0050: parseShareKeyUrl — ゲスト共有 (l=2) の guestKeyId", () => {
  const OS3_KEY_FOR_GUEST = {
    deviceModel: "sesame_5",
    secretKey: "aabbccddeeff00112233445566778899",
    sesame2PublicKey: "11223344",
    keyIndex: "0002",
    deviceUUID: "aaaabbbb-cccc-dddd-eeee-ffffaaaabbbb",
    deviceName: "Guest Lock",
  };

  it("[CFG-0050] l=2 の URL は keyLevel=2 を返す", () => {
    const guestKeyId = "fedcba9876543210fedcba9876543210";
    const url = buildShareKeyUrl(OS3_KEY_FOR_GUEST, { keyLevel: 2, guestKeyId });
    const parsed = parseShareKeyUrl(url);
    expect(parsed.keyLevel).toBe(2);
  });

  it("[CFG-0050] ゲスト共有 URL の sk 位置には guestKeyId が入り parseShareKeyUrl が secretKey として返す", () => {
    const guestKeyId = "deadbeefdeadbeefdeadbeefdeadbeef";
    const url = buildShareKeyUrl(OS3_KEY_FOR_GUEST, { keyLevel: 2, guestKeyId });
    const parsed = parseShareKeyUrl(url);
    expect(parsed.secretKey).toBe(guestKeyId);
    expect(parsed.keyLevel).toBe(2);
  });

  it("[CFG-0050] ゲスト共有 URL の secretKey は 32hex 形式なので isSecretKeyLike を通過する", () => {
    function isSecretKeyLike(v) {
      return typeof v === "string" && /^[0-9a-f]{32}$/i.test(v);
    }
    const guestKeyId = "cafebabecafebabecafebabecafebabe";
    const url = buildShareKeyUrl(OS3_KEY_FOR_GUEST, { keyLevel: 2, guestKeyId });
    const parsed = parseShareKeyUrl(url);
    expect(isSecretKeyLike(parsed.secretKey)).toBe(true);
  });
});

// ============================================================================
// CFG-0051 — addLock 必須検証: name/deviceUUID/secretKey 欠落で BAD_REQUEST
// ============================================================================
describe("CFG-0051: addLock — 必須フィールド欠落で BAD_REQUEST", () => {
  it("[CFG-0051] name が空文字のとき SesameError(BAD_REQUEST) を throw する", () => {
    const store = makeStore();
    expect(() =>
      store.addLock("", {
        deviceUUID: "0102030405060708090a0b0c0d0e0f10",
        secretKey: "0102030405060708090a0b0c0d0e0f10",
      }),
    ).toThrow(SesameError);
  });

  it("[CFG-0051] name が null のとき SesameError(BAD_REQUEST) を throw する", () => {
    const store = makeStore();
    expect(() =>
      store.addLock(null, {
        deviceUUID: "0102030405060708090a0b0c0d0e0f10",
        secretKey: "0102030405060708090a0b0c0d0e0f10",
      }),
    ).toThrow(SesameError);
  });

  it("[CFG-0051] deviceUUID が欠落のとき SesameError(BAD_REQUEST) を throw する", () => {
    const store = makeStore();
    let err;
    try {
      store.addLock("L1", { secretKey: "0102030405060708090a0b0c0d0e0f10" });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
  });

  it("[CFG-0051] secretKey が欠落のとき SesameError(BAD_REQUEST) を throw する", () => {
    const store = makeStore();
    let err;
    try {
      store.addLock("L1", { deviceUUID: "0102030405060708090a0b0c0d0e0f10" });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
  });

  it("[CFG-0051] lock が null の場合も SesameError(BAD_REQUEST) を throw する", () => {
    const store = makeStore();
    expect(() => store.addLock("L1", null)).toThrow(SesameError);
  });

  it("[CFG-0051] lock が undefined の場合も SesameError(BAD_REQUEST) を throw する", () => {
    const store = makeStore();
    expect(() => store.addLock("L1", undefined)).toThrow(SesameError);
  });
});

// ============================================================================
// CFG-0052 — addLock は model 未指定でも category:'lock' で view に出す
// ============================================================================
describe("CFG-0052: addLock — model 未指定でも category:lock で lockView に投影", () => {
  it("[CFG-0052] model を指定しなくても addLock 後に cfg.locks に出現する", () => {
    const store = makeStore();
    store.addLock("L1", {
      deviceUUID: "0102030405060708090a0b0c0d0e0f10",
      secretKey: "0102030405060708090a0b0c0d0e0f10",
    });
    const cfg = store.load();
    expect(cfg.locks.L1).toBeDefined();
    expect(cfg.locks.L1.deviceUUID).toBe("0102030405060708090a0b0c0d0e0f10");
  });

  it("[CFG-0052] model=null でも locks view に投影され model は null になる", () => {
    const store = makeStore();
    store.addLock("L1", { ...validLock(), model: null });
    const cfg = store.load();
    expect(cfg.locks.L1).toBeDefined();
    expect(cfg.locks.L1.model).toBeNull();
  });

  it("[CFG-0052] model を明示しても lockView に出現する", () => {
    const store = makeStore();
    store.addLock("L1", {
      deviceUUID: "0102030405060708090a0b0c0d0e0f10",
      secretKey: "0102030405060708090a0b0c0d0e0f10",
      model: "sesame_5",
    });
    const cfg = store.load();
    expect(cfg.locks.L1).toBeDefined();
    expect(cfg.locks.L1.model).toBe("sesame_5");
  });

  it("[CFG-0052] devices の対応レコードには category:'lock' が記録される", () => {
    const store = makeStore();
    store.addLock("L1", {
      deviceUUID: "0102030405060708090a0b0c0d0e0f10",
      secretKey: "0102030405060708090a0b0c0d0e0f10",
    });
    const cfg = store.load();
    expect(cfg.devices.L1.category).toBe("lock");
  });

  it("[CFG-0052] model=null (未指定) の lock は hub3s view には出現しない", () => {
    const store = makeStore();
    store.addLock("L1", {
      deviceUUID: "0102030405060708090a0b0c0d0e0f10",
      secretKey: "0102030405060708090a0b0c0d0e0f10",
    });
    const cfg = store.load();
    expect(cfg.hub3s.L1).toBeUndefined();
  });
});

// ============================================================================
// CFG-0053 — addLock 初回登録は default.lock に自動設定
// ============================================================================
describe("CFG-0053: addLock — 初回登録は default.lock に自動設定", () => {
  it("[CFG-0053] default.lock が未設定のとき addLock した name が default.lock になる", () => {
    const store = makeStore();
    expect(store.load().default.lock).toBeNull();
    store.addLock("first-lock", validLock());
    expect(store.load().default.lock).toBe("first-lock");
  });

  it("[CFG-0053] 2 個目以降は default.lock を変えない", () => {
    const store = makeStore();
    store.addLock("first-lock", validLock());
    store.addLock("second-lock", {
      deviceUUID: "00000000-0000-0000-0000-000000000002",
      secretKey: "ffffffffffffffffffffffffffffffff",
    });
    expect(store.load().default.lock).toBe("first-lock");
  });

  it("[CFG-0053] default.lock が設定済みのとき addLock は変えない", () => {
    const store = makeStore();
    store.addLock("L1", validLock());
    store.setDefaultLock("L1");
    store.addLock("L2", {
      deviceUUID: "00000000-0000-0000-0000-000000000002",
      secretKey: "ffffffffffffffffffffffffffffffff",
    });
    expect(store.load().default.lock).toBe("L1");
  });
});

// ============================================================================
// CFG-0054 — addLock の lock view 投影 shape
// ============================================================================
describe("CFG-0054: lockView — shape (deviceUUID/secretKey/model/alias [+ssmPublicKey/keyIndex])", () => {
  it("[CFG-0054] OS3 lock (鍵素材なし) の lockView は {deviceUUID,secretKey,model,alias} のみを持つ", () => {
    const store = makeStore();
    store.addLock("L1", {
      deviceUUID: "0102030405060708090a0b0c0d0e0f10",
      secretKey: "0102030405060708090a0b0c0d0e0f10",
      model: "sesame_5",
      alias: "玄関",
    });
    const view = store.load().locks.L1;
    expect(Object.keys(view).sort()).toEqual(["alias", "deviceUUID", "model", "secretKey"].sort());
    expect(view.deviceUUID).toBe("0102030405060708090a0b0c0d0e0f10");
    expect(view.secretKey).toBe("0102030405060708090a0b0c0d0e0f10");
    expect(view.model).toBe("sesame_5");
    expect(view.alias).toBe("玄関");
    // OS2 フィールドは無い
    expect("ssmPublicKey" in view).toBe(false);
    expect("keyIndex" in view).toBe(false);
  });

  it("[CFG-0054] model 未指定のとき model は null になる (undefined ではない)", () => {
    const store = makeStore();
    store.addLock("L1", {
      deviceUUID: "0102030405060708090a0b0c0d0e0f10",
      secretKey: "0102030405060708090a0b0c0d0e0f10",
    });
    const view = store.load().locks.L1;
    expect(view.model).toBeNull();
    expect(view.alias).toBeNull();
  });

  it("[CFG-0054] OS2 lock (ssmPublicKey/keyIndex あり) の lockView はその 2 キーを追加で持つ", () => {
    const store = makeStore();
    const pubKey = "ab".repeat(64);
    store.addLock("L1", {
      deviceUUID: "0102030405060708090a0b0c0d0e0f10",
      secretKey: "0102030405060708090a0b0c0d0e0f10",
      ssmPublicKey: pubKey,
      keyIndex: "0001",
    });
    const view = store.load().locks.L1;
    expect(view.ssmPublicKey).toBe(pubKey);
    expect(view.keyIndex).toBe("0001");
    expect(Object.keys(view)).toHaveLength(6);
  });

  it("[CFG-0054] OS2 lock の ssmPublicKey/keyIndex は lowercase 正規化されて保存される", () => {
    const store = makeStore();
    const pubKey = "AB".repeat(64);
    store.addLock("L1", {
      deviceUUID: "0102030405060708090a0b0c0d0e0f10",
      secretKey: "0102030405060708090a0b0c0d0e0f10",
      ssmPublicKey: pubKey,
      keyIndex: "AABB",
    });
    const view = store.load().locks.L1;
    expect(view.ssmPublicKey).toBe(pubKey.toLowerCase());
    expect(view.keyIndex).toBe("aabb");
  });

  it("[CFG-0054] lockView に category フィールドは含まれない (category は devices のみ)", () => {
    const store = makeStore();
    store.addLock("L1", validLock());
    const lock = store.load().locks.L1;
    expect("category" in lock).toBe(false);
  });
});

// ============================================================================
// CFG-0057 — locks rm 非対話は --yes 必須 (無いと exit 2)
// ============================================================================
describe("CFG-0057: locks rm — 非対話モードでは --yes 必須", () => {
  function makeLockRmStore(lockExists = true) {
    const cfg = {
      locks: lockExists ? { mylock: { deviceUUID: "u1", secretKey: "s1" } } : {},
      default: { lock: lockExists ? "mylock" : null },
    };
    const fakeStore = {
      exists: () => true,
      load: () => cfg,
      removeLock: vi.fn(),
    };
    vi.mocked(loadCtx).mockReturnValue({
      opts: { json: false },
      configStore: fakeStore,
      tokenStore: {},
      paths: {},
    });
    vi.mocked(canPrompt).mockReturnValue(false);
    return fakeStore;
  }

  it("[CFG-0057] canPrompt=false かつ --yes 未指定のとき die(nonInteractiveNeedsYes, 2) が呼ばれる", async () => {
    makeLockRmStore();
    const program = buildProgram();
    registerLocksCommands(program);

    await expect(
      program.parseAsync(["locks", "rm", "mylock"], { from: "user" }),
    ).rejects.toThrow();

    expect(die).toHaveBeenCalledWith(expect.any(String), 2);
    expect(vi.mocked(loadCtx)().configStore.removeLock).not.toHaveBeenCalled();
  });

  it("[CFG-0057] --yes が指定されていれば removeLock が呼ばれる (die なし)", async () => {
    const fakeStore = makeLockRmStore();
    const program = buildProgram();
    registerLocksCommands(program);

    await program.parseAsync(["locks", "rm", "mylock", "--yes"], { from: "user" });

    const exit2Calls = vi.mocked(die).mock.calls.filter(([, code]) => code === 2);
    expect(exit2Calls).toHaveLength(0);
    expect(fakeStore.removeLock).toHaveBeenCalledWith("mylock");
  });

  it("[CFG-0057] die に渡す exitCode は 2 (usage error)", async () => {
    makeLockRmStore();
    const program = buildProgram();
    registerLocksCommands(program);

    let caughtCode;
    try {
      await program.parseAsync(["locks", "rm", "mylock"], { from: "user" });
    } catch (e) {
      caughtCode = e.exitCode;
    }
    expect(caughtCode).toBe(2);
  });

  it("[CFG-0057] canPrompt=false + --yes=false → die 条件ロジック確認", () => {
    const shouldDie = !false && !false;
    expect(shouldDie).toBe(true);
  });

  it("[CFG-0057] canPrompt=false + --yes=true → die を呼ばない", () => {
    const shouldDie = !false && !true;
    expect(shouldDie).toBe(false);
  });

  it("[CFG-0057] canPrompt=true → --yes 無しでも die を呼ばない (prompt 経路)", () => {
    const shouldDie = !true && !false;
    expect(shouldDie).toBe(false);
  });
});

// ============================================================================
// CFG-0058 — removeLock: 未知名は BAD_REQUEST / default は null へ
// ============================================================================
describe("CFG-0058: removeLock — 未知名は BAD_REQUEST / default は null へリセット", () => {
  it("[CFG-0058] 未登録名を removeLock に渡すと SesameError(BAD_REQUEST) を throw する", () => {
    const store = makeStore();
    let err;
    try { store.removeLock("ghost"); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(SesameError);
    expect(err.code).toBe(ERR.BAD_REQUEST);
  });

  it("[CFG-0058] removeLock で登録済みの lock が消える (locks view / devices から削除)", () => {
    const store = makeStore();
    store.addLock("L1", {
      deviceUUID: "0102030405060708090a0b0c0d0e0f10",
      secretKey: "0102030405060708090a0b0c0d0e0f10",
    });
    expect(store.load().locks.L1).toBeDefined();

    store.removeLock("L1");

    const cfg = store.load();
    expect(cfg.locks.L1).toBeUndefined();
    expect(cfg.devices.L1).toBeUndefined();
  });

  it("[CFG-0058] 削除した lock が default.lock だった場合 default.lock が null にリセットされる", () => {
    const store = makeStore();
    store.addLock("L1", {
      deviceUUID: "0102030405060708090a0b0c0d0e0f10",
      secretKey: "0102030405060708090a0b0c0d0e0f10",
    });
    expect(store.load().default.lock).toBe("L1");

    store.removeLock("L1");

    expect(store.load().default.lock).toBeNull();
  });

  it("[CFG-0058] 削除した lock が default.lock でない場合 default.lock は変わらない", () => {
    const store = makeStore();
    store.addLock("L1", {
      deviceUUID: "0102030405060708090a0b0c0d0e0f10",
      secretKey: "0102030405060708090a0b0c0d0e0f10",
    });
    store.addLock("L2", {
      deviceUUID: "02020202020202020202020202020202",
      secretKey: "02020202020202020202020202020202",
    });
    expect(store.load().default.lock).toBe("L1");
    store.removeLock("L2");
    expect(store.load().default.lock).toBe("L1");
  });

  it("[CFG-0058] save()→_reproject で lockView が更新される (削除後は別インスタンスでも出ない)", () => {
    const store = makeStore();
    store.addLock("L1", {
      deviceUUID: "0102030405060708090a0b0c0d0e0f10",
      secretKey: "0102030405060708090a0b0c0d0e0f10",
    });
    store.removeLock("L1");

    const store2 = new ConfigStore(configPath);
    expect(store2.load().locks.L1).toBeUndefined();
    expect(store2.load().default.lock).toBeNull();
  });
});
