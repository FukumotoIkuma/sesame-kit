// CFG-0078 〜 CFG-0095 — config ドメイン単体テスト (統合版)
// 対象: effectiveCategory/categoryForModel (core), serve config.* エントリ,
//       grpc-methods マニフェスト, i18n キー存在,
//       client._ensureConnected / _requireConfigStore, ConfigStore.updateRemoteKeys
//
// 実行: vitest unit project (vitest.config.js の unit project / KIT_SETUP 登録済み)
// モック: ネットワーク/実機不使用。serve エントリは handler を直接呼ぶ。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// ---- core imports ----
import { ConfigStore, isLockModel, isHub3Model } from "../../src/config.js";
import { SesameHub3 } from "../../src/client.js";
import { RpcError, RPC, KIND } from "../../src/jsonrpc.js";

// ---- serve imports (相対パス: _spec/ → kit/src/serve/) ----
import { configEntries } from "../../../kit/src/serve/entries/config.js";
import { requireAuth, requireConfigStore, need } from "../../../kit/src/serve/registry-helpers.js";

// ---- i18n (相対パス) ----
const cliI18nMod = await import("../../../kit/src/i18n/cli.js");
const cliI18n = cliI18nMod.default;

const serveI18nMod = await import("../../../kit/src/i18n/serve.js");
const serveI18n = serveI18nMod.default;

const domainI18nMod = await import("../../src/i18n/domain.js");
const domainI18n = domainI18nMod.default;

// ---- grpc-methods manifest (相対パス) ----
const __dirname = dirname(fileURLToPath(import.meta.url));
const GRPC_MAP_PATH = resolve(__dirname, "..", "..", "..", "kit", "src", "serve", "grpc-methods.generated.json");
const grpcMethods = JSON.parse(readFileSync(GRPC_MAP_PATH, "utf-8"));

// ---- pickers ----
const pickersMod = await import("../../../kit/src/cli/pickers.js");
const { printSyncResult } = pickersMod;

// ── helpers ────────────────────────────────────────────────────────────────

function makeTmpStore() {
  const workDir = mkdtempSync(join(tmpdir(), "sesame-cfg-c4-"));
  const configPath = join(workDir, "config.json");
  const store = new ConfigStore(configPath);
  return { store, workDir, configPath };
}

function cleanupDir(workDir) {
  if (workDir && existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** hub3 を登録してから remote を 1 件追加し、設定済み ConfigStore を返す */
function storeWithRemote(name = "r1", hub3Name = "hub-a") {
  const { store, workDir, configPath } = makeTmpStore();
  store.addHub3(hub3Name, { deviceId: `dev-${hub3Name}` });
  store.addRemote(name, { hub3: hub3Name, irDeviceUUID: "ir-001", irType: 0xfe00 });
  return { store, workDir, configPath };
}

/**
 * daemon を作るヘルパ。requireAuth を通過させる最小オブジェクト。
 * authState が "expired" でなく、hub.connected=true であれば通過する。
 */
function makeDaemon({ authState = "active", connected = true } = {}) {
  return { authState, hub: { connected } };
}

// ── CFG-0078: effectiveCategory / categoryForModel ─────────────────────────

describe("[CFG-0078] effectiveCategory / categoryForModel の分岐", () => {
  it("[CFG-0078-a] hub_3 model は hub3 view に投影され lock view には出ない", () => {
    const { store, workDir } = makeTmpStore();
    try {
      store.addHub3("my-hub", { deviceId: "dev-uuid-0001" });
      const cfg = store.load();
      expect(cfg.hub3s).toHaveProperty("my-hub");
      expect(cfg.locks).not.toHaveProperty("my-hub");
    } finally { cleanupDir(workDir); }
  });

  it("[CFG-0078-b] lock model は lock view に投影され hub3 view には出ない", () => {
    const { store, workDir } = makeTmpStore();
    try {
      store.addLock("L1", {
        deviceUUID: "00000000000000000000000000000001",
        secretKey: "0123456789abcdef0123456789abcdef",
      });
      const cfg = store.load();
      expect(cfg.locks).toHaveProperty("L1");
      expect(cfg.hub3s).not.toHaveProperty("L1");
    } finally { cleanupDir(workDir); }
  });

  it("[CFG-0078-c] model=null の lock は lock view に投影される (categoryForModel(null)→lock)", () => {
    const { store, workDir } = makeTmpStore();
    try {
      store.addLock("L-null-model", {
        deviceUUID: "00000000000000000000000000000002",
        secretKey: "abcdef0123456789abcdef0123456789",
        model: null,
      });
      const cfg = store.load();
      expect(cfg.locks).toHaveProperty("L-null-model");
      expect(cfg.hub3s).not.toHaveProperty("L-null-model");
    } finally { cleanupDir(workDir); }
  });

  it("[CFG-0078-d] isHub3Model('hub_3') / isHub3Model('hub_3_lte') = true", () => {
    expect(isHub3Model("hub_3")).toBe(true);
    expect(isHub3Model("hub_3_lte")).toBe(true);
  });

  it("[CFG-0078-e] isLockModel: lockModelDevices が true を返す", () => {
    const lockModels = [
      "sesame_2", "sesame_4", "sesame_5", "sesame_5_pro", "sesame_5_us",
      "bot_2", "bot_3", "ssmbot_1",
      "sesame_6", "sesame_6_pro", "sesame_6_pro_slidingdoor",
      "BLE_Connector_1", "bike_2", "bike_3",
    ];
    for (const m of lockModels) {
      expect(isLockModel(m), `isLockModel(${m})`).toBe(true);
    }
  });

  it("[CFG-0078-f] Touch/Face 相当モデルは isLockModel=false かつ isHub3Model=false", () => {
    const nonLock = ["sesame_touch_1", "sesame_face_1", "ssm_touch_pro"];
    for (const m of nonLock) {
      expect(isLockModel(m), `should not be lock: ${m}`).toBe(false);
      expect(isHub3Model(m), `should not be hub3: ${m}`).toBe(false);
    }
  });
});

// ── CFG-0079: serve config.syncLocks ──────────────────────────────────────

describe("[CFG-0079] serve config.syncLocks: prune オプション露出と {added,updated,removed} 返却", () => {
  it("[CFG-0079-a] config.syncLocks エントリが registry に存在する", () => {
    const entries = configEntries();
    expect(entries["config.syncLocks"]).toBeDefined();
  });

  it("[CFG-0079-b] prune param が optional boolean として宣言されている", () => {
    const entries = configEntries();
    const entry = entries["config.syncLocks"];
    const pruneParam = entry.params.find((p) => p.name === "prune");
    expect(pruneParam).toBeDefined();
    expect(pruneParam.required).toBe(false);
    expect(pruneParam.schema?.type).toBe("boolean");
  });

  it("[CFG-0079-c] handler が hub.syncLocksFromDevices({prune:true}) に委譲し結果を返す", async () => {
    const entries = configEntries();
    const syncResult = { added: ["L1"], updated: [], removed: [] };
    const hub = { configStore: {}, syncLocksFromDevices: vi.fn().mockResolvedValue(syncResult) };
    const daemon = makeDaemon();
    const result = await entries["config.syncLocks"].handler({ hub, params: { prune: true }, daemon });
    expect(hub.syncLocksFromDevices).toHaveBeenCalledWith({ prune: true });
    expect(result).toEqual(syncResult);
  });

  it("[CFG-0079-d] prune falsy → {prune:false} で呼ばれる", async () => {
    const entries = configEntries();
    const hub = { configStore: {}, syncLocksFromDevices: vi.fn().mockResolvedValue({ added: [], updated: [], removed: [] }) };
    const daemon = makeDaemon();
    await entries["config.syncLocks"].handler({ hub, params: {}, daemon });
    expect(hub.syncLocksFromDevices).toHaveBeenCalledWith({ prune: false });
  });
});

// ── CFG-0080: serve config.syncHub3s ──────────────────────────────────────

describe("[CFG-0080] serve config.syncHub3s: prune オプション露出", () => {
  it("[CFG-0080-a] config.syncHub3s エントリが registry に存在する", () => {
    const entries = configEntries();
    expect(entries["config.syncHub3s"]).toBeDefined();
  });

  it("[CFG-0080-b] prune param が optional boolean として宣言されている", () => {
    const entries = configEntries();
    const pruneParam = entries["config.syncHub3s"].params.find((p) => p.name === "prune");
    expect(pruneParam).toBeDefined();
    expect(pruneParam.required).toBe(false);
    expect(pruneParam.schema?.type).toBe("boolean");
  });

  it("[CFG-0080-c] handler が hub.syncHub3sFromDevices({prune:true}) に委譲する", async () => {
    const entries = configEntries();
    const syncResult = { added: ["h1"], updated: [], removed: [] };
    const hub = { configStore: {}, syncHub3sFromDevices: vi.fn().mockResolvedValue(syncResult) };
    const daemon = makeDaemon();
    const result = await entries["config.syncHub3s"].handler({ hub, params: { prune: true }, daemon });
    expect(hub.syncHub3sFromDevices).toHaveBeenCalledWith({ prune: true });
    expect(result).toEqual(syncResult);
  });
});

// ── CFG-0081: serve config.syncRemotes ─────────────────────────────────────

describe("[CFG-0081] serve config.syncRemotes: パラメータなしで hub3+remotes の複合結果を返す", () => {
  it("[CFG-0081-a] config.syncRemotes エントリが存在し params=[] である", () => {
    const entries = configEntries();
    expect(entries["config.syncRemotes"]).toBeDefined();
    expect(entries["config.syncRemotes"].params).toEqual([]);
  });

  it("[CFG-0081-b] handler が hub.syncRemotesFromDevices() に委譲し {hub3,remotes} 形を返す", async () => {
    const entries = configEntries();
    const expected = {
      hub3: { added: ["h1"], updated: [], removed: [] },
      remotes: { added: ["r1"], updated: [] },
    };
    const hub = { configStore: {}, syncRemotesFromDevices: vi.fn().mockResolvedValue(expected) };
    const daemon = makeDaemon();
    const result = await entries["config.syncRemotes"].handler({ hub, params: {}, daemon });
    expect(hub.syncRemotesFromDevices).toHaveBeenCalledOnce();
    expect(result).toEqual(expected);
    expect(result.hub3).toBeDefined();
    expect(result.remotes).toBeDefined();
  });
});

// ── CFG-0082: serve config.syncRemotesFromServer ─────────────────────────

describe("[CFG-0082] serve config.syncRemotesFromServer: hub3/irType を need() で必須検証", () => {
  it("[CFG-0082-a] hub3/irType が required:true で宣言されている", () => {
    const entries = configEntries();
    const entry = entries["config.syncRemotesFromServer"];
    expect(entry).toBeDefined();
    const hub3Param = entry.params.find((p) => p.name === "hub3");
    const irTypeParam = entry.params.find((p) => p.name === "irType");
    expect(hub3Param?.required).toBe(true);
    expect(irTypeParam?.required).toBe(true);
  });

  it("[CFG-0082-b] hub3 欠落で need() が RpcError(INVALID_PARAMS / BAD_PARAMS) を throw する", () => {
    expect(() => need({}, ["hub3", "irType"])).toThrow(RpcError);
    try {
      need({}, ["hub3", "irType"]);
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      expect(e.code).toBe(RPC.INVALID_PARAMS);
      expect(e.kind).toBe(KIND.BAD_PARAMS);
    }
  });

  it("[CFG-0082-c] irType 欠落で need() が RpcError を throw する", () => {
    expect(() => need({ hub3: "my-hub" }, ["hub3", "irType"])).toThrow(RpcError);
  });

  it("[CFG-0082-d] hub3 欠落: handler が throw する", () => {
    const entries = configEntries();
    const hub = { configStore: {}, syncRemotesFromServer: vi.fn() };
    const daemon = makeDaemon();
    expect(() =>
      entries["config.syncRemotesFromServer"].handler({ hub, params: { irType: 0xC000 }, daemon })
    ).toThrow();
  });

  it("[CFG-0082-e] hub3/irType 揃えば hub.syncRemotesFromServer(hub3, Number(irType)) に委譲する", async () => {
    const entries = configEntries();
    const syncFn = vi.fn().mockResolvedValue({ added: [], updated: [] });
    const hub = { configStore: {}, syncRemotesFromServer: syncFn };
    const daemon = makeDaemon();
    await entries["config.syncRemotesFromServer"].handler({
      hub,
      params: { hub3: "hub-a", irType: 49152 },
      daemon,
    });
    expect(syncFn).toHaveBeenCalledWith("hub-a", 49152);
  });
});

// ── CFG-0083: serve config.listRemoteCandidates ───────────────────────────

describe("[CFG-0083] serve config.listRemoteCandidates: ConfigStore 不要・読み取り専用露出", () => {
  it("[CFG-0083-a] config.listRemoteCandidates エントリが registry に存在する", () => {
    const entries = configEntries();
    expect(entries["config.listRemoteCandidates"]).toBeDefined();
  });

  it("[CFG-0083-b] handler が configStore 無し hub でも hub.listRemotesFromDevices() に委譲する", async () => {
    const entries = configEntries();
    const candidates = [
      { hub3DeviceUUID: "u1", hub3Name: "h1", uuid: "r1", type: 0xfe00, alias: null },
    ];
    // configStore を持たない hub を渡しても throw しないことを確認
    const hub = { listRemotesFromDevices: vi.fn().mockResolvedValue(candidates) };
    const daemon = makeDaemon();
    const result = await entries["config.listRemoteCandidates"].handler({ hub, params: {}, daemon });
    expect(hub.listRemotesFromDevices).toHaveBeenCalledOnce();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ hub3DeviceUUID: "u1", uuid: "r1" });
  });

  it("[CFG-0083-c] requireConfigStore は configStore 無しで RpcError(BAD_PARAMS) を投げる", () => {
    const hubWithout = { connected: true }; // configStore なし
    expect(() => requireConfigStore(hubWithout, "config.syncLocks")).toThrow(RpcError);
    try {
      requireConfigStore(hubWithout, "config.syncLocks");
    } catch (e) {
      expect(e.kind).toBe(KIND.BAD_PARAMS);
      expect(e.code).toBe(RPC.INVALID_PARAMS);
    }
  });

  it("[CFG-0083-d] listRemoteCandidates handler ソースが requireConfigStore を呼ばない", () => {
    const entries = configEntries();
    const handlerSrc = entries["config.listRemoteCandidates"].handler.toString();
    expect(handlerSrc).not.toContain("requireConfigStore");
  });
});

// ── CFG-0084: serve sync 系 requireConfigStore ───────────────────────────

describe("[CFG-0084] serve sync 系: ConfigStore 無し構成は bad_params で明示拒否 (書込み系のみ)", () => {
  const WRITE_OPS = [
    "config.syncLocks",
    "config.syncHub3s",
    "config.syncRemotes",
    "config.syncRemoteKeys",
    "config.syncRemotesFromServer",
  ];

  for (const op of WRITE_OPS) {
    it(`[CFG-0084] ${op} は configStore 無しで RpcError(BAD_PARAMS) を throw する`, async () => {
      const entries = configEntries();
      const hub = { connected: true /* configStore なし */ };
      const daemon = makeDaemon();
      // handler は requireConfigStore で同期 throw するか、もしくは rejected Promise を返す
      let threw = false;
      try {
        const ret = entries[op].handler({ hub, params: { hub3: "x", irType: 1 }, daemon });
        if (ret && typeof ret.then === "function") await ret;
      } catch (e) {
        threw = true;
        expect(e).toBeInstanceOf(RpcError);
        expect(e.kind).toBe(KIND.BAD_PARAMS);
      }
      expect(threw).toBe(true);
    });
  }

  it("[CFG-0084] config.listRemoteCandidates は configStore 不在でも throw しない", async () => {
    const entries = configEntries();
    const hub = { listRemotesFromDevices: vi.fn().mockResolvedValue([]) };
    const daemon = makeDaemon();
    await expect(
      entries["config.listRemoteCandidates"].handler({ hub, params: {}, daemon })
    ).resolves.toEqual([]);
  });
});

// ── CFG-0085: serve sync 系 requireAuth ──────────────────────────────────

describe("[CFG-0085] serve sync 系: 未認証 daemon は requireAuth で NOT_AUTHENTICATED", () => {
  const ALL_OPS = [
    "config.syncLocks",
    "config.syncHub3s",
    "config.syncRemotes",
    "config.syncRemoteKeys",
    "config.syncRemotesFromServer",
    "config.listRemoteCandidates",
  ];

  it("[CFG-0085-a] requireAuth: authState=expired → NOT_AUTHENTICATED を throw する", () => {
    const daemon = { authState: "expired", hub: { connected: false } };
    expect(() => requireAuth(daemon)).toThrow(RpcError);
    try {
      requireAuth(daemon);
    } catch (e) {
      expect(e.kind).toBe(KIND.NOT_AUTHENTICATED);
    }
  });

  it("[CFG-0085-b] requireAuth: authState が有効でも hub.connected=false → CONNECTION_LOST", () => {
    const daemon = { authState: "active", hub: { connected: false } };
    expect(() => requireAuth(daemon)).toThrow(RpcError);
    try {
      requireAuth(daemon);
    } catch (e) {
      expect(e.kind).toBe(KIND.CONNECTION_LOST);
    }
  });

  for (const op of ALL_OPS) {
    it(`[CFG-0085] ${op}: daemon.authState=expired で NOT_AUTHENTICATED RpcError を throw する`, async () => {
      const entries = configEntries();
      const hub = {
        configStore: {},
        syncLocksFromDevices: vi.fn(),
        syncHub3sFromDevices: vi.fn(),
        syncRemotesFromDevices: vi.fn(),
        syncRemoteKeys: vi.fn(),
        syncRemotesFromServer: vi.fn(),
        listRemotesFromDevices: vi.fn(),
      };
      // authState=expired → requireAuth が最初に throw する
      const daemon = { authState: "expired", hub: { connected: false } };
      let threw = false;
      try {
        await entries[op].handler({ hub, params: { hub3: "x", irType: 1 }, daemon });
      } catch (e) {
        threw = true;
        expect(e).toBeInstanceOf(RpcError);
        expect(e.kind).toBe(KIND.NOT_AUTHENTICATED);
      }
      expect(threw).toBe(true);
    });
  }
});

// ── CFG-0086: config.* メソッドの registry 登録確認 ─────────────────────

describe("[CFG-0086] config.* メソッドが registry に 1:1 存在", () => {
  const EXPECTED_METHODS = [
    "config.syncLocks",
    "config.syncHub3s",
    "config.syncRemotes",
    "config.syncRemoteKeys",
    "config.syncRemotesFromServer",
    "config.listRemoteCandidates",
  ];

  it("[CFG-0086-a] configEntries() が 6 メソッドを全て含む", () => {
    const entries = configEntries();
    for (const m of EXPECTED_METHODS) {
      expect(entries[m], `missing: ${m}`).toBeDefined();
    }
  });

  it("[CFG-0086-b] config.syncRemotesFromServer の hub3/irType は required:true", () => {
    const entries = configEntries();
    const params = entries["config.syncRemotesFromServer"].params;
    const hub3 = params.find((p) => p.name === "hub3");
    const irType = params.find((p) => p.name === "irType");
    expect(hub3?.required).toBe(true);
    expect(irType?.required).toBe(true);
  });
});

// ── CFG-0087: grpc-methods マニフェスト存在確認 ─────────────────────────

describe("[CFG-0087] SDK gen: config.sync* / listRemoteCandidates が grpc-methods マニフェストに存在", () => {
  const EXPECTED = {
    ConfigSyncLocks: "config.syncLocks",
    ConfigSyncHub3s: "config.syncHub3s",
    ConfigSyncRemotes: "config.syncRemotes",
    ConfigSyncRemoteKeys: "config.syncRemoteKeys",
    ConfigSyncRemotesFromServer: "config.syncRemotesFromServer",
    ConfigListRemoteCandidates: "config.listRemoteCandidates",
  };

  it("[CFG-0087-a] 各 ConfigXxx エントリが grpc-methods に存在し method 名が正しい", () => {
    for (const [key, method] of Object.entries(EXPECTED)) {
      expect(grpcMethods[key], `missing: ${key}`).toBeDefined();
      expect(grpcMethods[key].method).toBe(method);
    }
  });

  it("[CFG-0087-b] ConfigSyncLocks の method は 'config.syncLocks'", () => {
    expect(grpcMethods.ConfigSyncLocks.method).toBe("config.syncLocks");
  });

  it("[CFG-0087-c] ConfigListRemoteCandidates の method は 'config.listRemoteCandidates'", () => {
    expect(grpcMethods.ConfigListRemoteCandidates.method).toBe("config.listRemoteCandidates");
  });
});

// ── CFG-0088: optionalScalars の宣言確認 ───────────────────────────────

describe("[CFG-0088] SDK gen: syncLocks/syncHub3s の prune が optionalScalars、syncRemotesFromServer は []", () => {
  it("[CFG-0088-a] ConfigSyncLocks.optionalScalars に 'prune' が含まれる", () => {
    expect(grpcMethods["ConfigSyncLocks"].optionalScalars).toContain("prune");
  });

  it("[CFG-0088-b] ConfigSyncHub3s.optionalScalars に 'prune' が含まれる", () => {
    expect(grpcMethods["ConfigSyncHub3s"].optionalScalars).toContain("prune");
  });

  it("[CFG-0088-c] ConfigSyncRemotesFromServer.optionalScalars は [] (surface-parity ギャップ)", () => {
    // spec どおり: grpc gen は required を表現せず optionalScalars=[] のまま
    expect(grpcMethods["ConfigSyncRemotesFromServer"].optionalScalars).toEqual([]);
  });
});

// ── CFG-0089: 同操作が cli/serve/core で同じ封筒を返す (surface-parity) ─

describe("[CFG-0089] sync 同操作が cli/serve/core で同結果封筒 {added,updated,removed}", () => {
  it("[CFG-0089-a] serve config.syncLocks result フィールドに added/updated/removed が宣言されている", () => {
    const entries = configEntries();
    const result = entries["config.syncLocks"].result;
    expect(result).toMatch(/added/);
    expect(result).toMatch(/updated/);
    expect(result).toMatch(/removed/);
  });

  it("[CFG-0089-b] serve config.syncHub3s result フィールドに added/updated/removed が宣言されている", () => {
    const entries = configEntries();
    const result = entries["config.syncHub3s"].result;
    expect(result).toMatch(/added/);
    expect(result).toMatch(/updated/);
    expect(result).toMatch(/removed/);
  });

  it("[CFG-0089-c] serve config.syncRemotes result フィールドに hub3/remotes が宣言されている", () => {
    const entries = configEntries();
    const result = entries["config.syncRemotes"].result;
    expect(result).toMatch(/hub3/);
    expect(result).toMatch(/remotes/);
  });

  it("[CFG-0089-d] hub ハンドラは core の syncLocksFromDevices 戻り値をそのまま返す (取捨なし)", async () => {
    const entries = configEntries();
    const full = { added: ["A", "B"], updated: ["C"], removed: ["D"] };
    const hub = { configStore: {}, syncLocksFromDevices: vi.fn().mockResolvedValue(full) };
    const daemon = makeDaemon();
    const result = await entries["config.syncLocks"].handler({ hub, params: {}, daemon });
    expect(result).toEqual(full);
    expect(result.added).toEqual(["A", "B"]);
    expect(result.updated).toEqual(["C"]);
    expect(result.removed).toEqual(["D"]);
  });
});

// ── CFG-0090: printSyncResult の {ok,kind,...r} 出力 ─────────────────────

describe("[CFG-0090] CLI sync 系 --json: printSyncResult が {ok,kind,added,updated,removed} を出力", () => {
  it("[CFG-0090-a] json=true 時: console.log で {ok:true,kind,...r} を出力する", () => {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      printSyncResult(true, "lock", { added: ["L1"], updated: [], removed: [] });
      expect(logs.length).toBeGreaterThan(0);
      const parsed = JSON.parse(logs[0]);
      expect(parsed.ok).toBe(true);
      expect(parsed.kind).toBe("lock");
      expect(parsed.added).toEqual(["L1"]);
    } finally {
      console.log = origLog;
    }
  });

  it("[CFG-0090-b] json=false 時: +N/~N/-N 形式の人間可読サマリを console.log で出力する", () => {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      printSyncResult(false, "lock", { added: ["L1", "L2"], updated: ["L3"], removed: ["L4"] });
      expect(logs.length).toBeGreaterThan(0);
      const output = logs[0];
      expect(output).toMatch(/\+2/);
      expect(output).toMatch(/~1/);
      expect(output).toMatch(/-1/);
    } finally {
      console.log = origLog;
    }
  });

  it("[CFG-0090-c] json=false かつ変更なし: syncNoChange に当たるテキストが出力に含まれる", () => {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(" "));
    try {
      printSyncResult(false, "lock", { added: [], updated: [], removed: [] });
      expect(logs.length).toBeGreaterThan(0);
      // setup.i18n.js が ja に固定しているので ja の syncNoChange テキストを確認
      const noChangeText = cliI18n.ja["cli.syncNoChange"];
      expect(logs[0]).toMatch(noChangeText);
    } finally {
      console.log = origLog;
    }
  });
});

// ── CFG-0091: i18n キー存在確認 ──────────────────────────────────────────

describe("[CFG-0091] i18n: sync 系 serve サマリ/説明と CLI okSync メッセージのキー存在", () => {
  const SERVE_KEYS = [
    "serve.sum.configSyncLocks",
    "serve.sum.configSyncHub3s",
    "serve.sum.configSyncRemotes",
    "serve.sum.configSyncRemotesFromServer",
    "serve.sum.configListRemoteCandidates",
  ];
  const CLI_KEYS = ["cli.okSync", "cli.syncNoChange"];

  for (const key of SERVE_KEYS) {
    it(`[CFG-0091] serve i18n en: "${key}" が定義されている`, () => {
      expect(serveI18n.en[key]).toBeDefined();
      expect(typeof serveI18n.en[key]).toBe("string");
      expect(serveI18n.en[key].length).toBeGreaterThan(0);
    });

    it(`[CFG-0091] serve i18n ja: "${key}" が定義されている`, () => {
      expect(serveI18n.ja[key]).toBeDefined();
      expect(typeof serveI18n.ja[key]).toBe("string");
      expect(serveI18n.ja[key].length).toBeGreaterThan(0);
    });
  }

  for (const key of CLI_KEYS) {
    it(`[CFG-0091] cli i18n en: "${key}" が定義されている`, () => {
      expect(cliI18n.en[key]).toBeDefined();
      expect(typeof cliI18n.en[key]).toBe("string");
    });

    it(`[CFG-0091] cli i18n ja: "${key}" が定義されている`, () => {
      expect(cliI18n.ja[key]).toBeDefined();
      expect(typeof cliI18n.ja[key]).toBe("string");
    });
  }
});

// ── CFG-0092: config ドメイン error i18n 完全性 ──────────────────────────

describe("[CFG-0092] config ドメインの error i18n キーが en/ja 両カタログに完全存在", () => {
  const DOMAIN_CONFIG_KEYS = [
    "domain.config.lockNameRequired",
    "domain.config.lockDeviceUUIDRequired",
    "domain.config.lockSecretKeyRequired",
    "domain.config.hub3NameRequired",
    "domain.config.hub3DeviceIdRequired",
    "domain.config.remoteNameRequired",
    "domain.config.remoteHub3Required",
    "domain.config.hub3NotRegisteredAddFirst",
    "domain.config.unknownRemoteName",
    "domain.config.unknownLockName",
    "domain.config.hub3NotRegisteredSyncFirst",
    "domain.config.configPathRequired",
  ];

  const CLI_CONFIG_KEYS = [
    "cli.configNotInitialized",
    "cli.invalidLockModel",
    "cli.invalidDeviceUuid",
    "cli.invalidSecretKey",
  ];

  for (const key of DOMAIN_CONFIG_KEYS) {
    it(`[CFG-0092] domain i18n en: "${key}" が定義されている`, () => {
      expect(domainI18n.en[key], `missing en: ${key}`).toBeDefined();
      expect(typeof domainI18n.en[key]).toBe("string");
    });

    it(`[CFG-0092] domain i18n ja: "${key}" が定義されている`, () => {
      expect(domainI18n.ja[key], `missing ja: ${key}`).toBeDefined();
      expect(typeof domainI18n.ja[key]).toBe("string");
    });
  }

  for (const key of CLI_CONFIG_KEYS) {
    it(`[CFG-0092] cli i18n en: "${key}" が定義されている`, () => {
      expect(cliI18n.en[key], `missing en: ${key}`).toBeDefined();
    });

    it(`[CFG-0092] cli i18n ja: "${key}" が定義されている`, () => {
      expect(cliI18n.ja[key], `missing ja: ${key}`).toBeDefined();
    });
  }

  it("[CFG-0092] ConfigStore.addLock 空 name は lockNameRequired を throw する", () => {
    const { store, workDir } = makeTmpStore();
    try {
      expect(() =>
        store.addLock("", {
          deviceUUID: "00000000000000000000000000000001",
          secretKey: "0123456789abcdef0123456789abcdef",
        })
      ).toThrow(/lock name required|lockNameRequired/i);
    } finally { cleanupDir(workDir); }
  });

  it("[CFG-0092] domain.config.unknownRemoteName が en に存在し 'Unknown remote' を含む", () => {
    expect(domainI18n.en["domain.config.unknownRemoteName"]).toMatch(/Unknown remote/i);
  });
});

// ── CFG-0093: client._requireConfigStore ────────────────────────────────

describe("[CFG-0093] client sync*: ConfigStore 無しで直利用すると _requireConfigStore で plain Error", () => {
  /**
   * ConfigStore なしの最小 SesameHub3 スタブを構築する。
   * _ws を設定して _ensureConnected をパスさせ、_configStore は null に設定しない。
   */
  async function makeHubWithoutConfigStore() {
    const hub = Object.create(SesameHub3.prototype);
    hub._ws = {}; // 接続済みとして扱う (_ensureConnected をパスさせる)
    hub._configStore = null; // ConfigStore 無し
    return hub;
  }

  it("[CFG-0093-a] syncLocksFromDevices が _requireConfigStore で Error を throw する", async () => {
    const hub = await makeHubWithoutConfigStore();
    await expect(hub.syncLocksFromDevices()).rejects.toThrow(/requiresConfigStore|ConfigStore|requires a ConfigStore/i);
  });

  it("[CFG-0093-b] syncHub3sFromDevices が _requireConfigStore で Error を throw する", async () => {
    const hub = await makeHubWithoutConfigStore();
    await expect(hub.syncHub3sFromDevices()).rejects.toThrow(/requiresConfigStore|ConfigStore|requires a ConfigStore/i);
  });

  it("[CFG-0093-c] syncRemotesFromDevices が _requireConfigStore で Error を throw する", async () => {
    const hub = await makeHubWithoutConfigStore();
    await expect(hub.syncRemotesFromDevices()).rejects.toThrow(/requiresConfigStore|ConfigStore|requires a ConfigStore/i);
  });

  it("[CFG-0093-d] syncRemotesFromServer が _requireConfigStore で Error を throw する", async () => {
    const hub = await makeHubWithoutConfigStore();
    await expect(hub.syncRemotesFromServer("hub-a", 0xC000)).rejects.toThrow(/requiresConfigStore|ConfigStore|requires a ConfigStore/i);
  });

  it("[CFG-0093-e] throw されるのは SesameError ではなく素の Error (code プロパティなし)", async () => {
    const hub = await makeHubWithoutConfigStore();
    try {
      await hub.syncLocksFromDevices();
      expect.fail("should have thrown");
    } catch (e) {
      // _requireConfigStore は plain Error を throw する (SesameError でない)
      expect(e instanceof Error).toBe(true);
      expect(e.code).toBeUndefined();
    }
  });

  it("[CFG-0093-f] domain.client.requiresConfigStore i18n キーが en に存在し '{op}' を含む", () => {
    expect(domainI18n.en["domain.client.requiresConfigStore"]).toBeDefined();
    expect(domainI18n.en["domain.client.requiresConfigStore"]).toContain("{op}");
  });

  it("[CFG-0093-g] serve requireConfigStore は configStore 無しで RpcError(BAD_PARAMS) を投げる", () => {
    const hub = { connected: true }; // configStore なし
    try {
      requireConfigStore(hub, "syncLocksFromDevices");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      expect(e.kind).toBe(KIND.BAD_PARAMS);
    }
  });
});

// ── CFG-0094: client sync* 未接続 NOT_CONNECTED ──────────────────────────

describe("[CFG-0094] client sync*: 未接続 (_ws なし) は NOT_CONNECTED(retryable) で拒否", () => {
  async function makeDisconnectedHub() {
    const hub = Object.create(SesameHub3.prototype);
    hub._ws = null; // 未接続
    hub._configStore = {}; // ConfigStore あり
    return hub;
  }

  it("[CFG-0094-a] syncLocksFromDevices が未接続で SesameError(NOT_CONNECTED, retryable:true) を throw する", async () => {
    const hub = await makeDisconnectedHub();
    await expect(hub.syncLocksFromDevices()).rejects.toMatchObject({
      code: expect.stringMatching(/not_connected|NOT_CONNECTED/i),
      retryable: true,
    });
  });

  it("[CFG-0094-b] syncHub3sFromDevices が未接続で NOT_CONNECTED を throw する", async () => {
    const hub = await makeDisconnectedHub();
    await expect(hub.syncHub3sFromDevices()).rejects.toMatchObject({
      code: expect.stringMatching(/not_connected|NOT_CONNECTED/i),
    });
  });

  it("[CFG-0094-c] syncRemotesFromDevices が未接続で NOT_CONNECTED を throw する", async () => {
    const hub = await makeDisconnectedHub();
    await expect(hub.syncRemotesFromDevices()).rejects.toMatchObject({
      code: expect.stringMatching(/not_connected|NOT_CONNECTED/i),
    });
  });

  it("[CFG-0094-d] syncRemotesFromServer が未接続で NOT_CONNECTED を throw する", async () => {
    const hub = await makeDisconnectedHub();
    await expect(hub.syncRemotesFromServer("hub-a", 0xC000)).rejects.toMatchObject({
      code: expect.stringMatching(/not_connected|NOT_CONNECTED/i),
    });
  });

  it("[CFG-0094-e] domain.client.notConnected i18n キーが en に存在する", () => {
    expect(domainI18n.en["domain.client.notConnected"]).toBeDefined();
    expect(typeof domainI18n.en["domain.client.notConnected"]).toBe("string");
  });

  it("[CFG-0094-f] requireAuth: hub.connected=false → CONNECTION_LOST (未接続の serve 写像)", () => {
    const daemon = { authState: "active", hub: { connected: false } };
    try {
      requireAuth(daemon);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(RpcError);
      expect(e.kind).toBe(KIND.CONNECTION_LOST);
    }
  });

  it("[CFG-0094-g] serve syncLocks: hub.connected=false → requireAuth が CONNECTION_LOST を投げる", async () => {
    const entries = configEntries();
    const hub = { configStore: {}, connected: false };
    const daemon = { authState: "active", hub: { connected: false } };
    // requireAuth は同期 throw するので try/catch で捕捉する
    let threw = false;
    try {
      const ret = entries["config.syncLocks"].handler({ hub, params: {}, daemon });
      if (ret && typeof ret.then === "function") await ret;
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(RpcError);
      expect(e.kind).toBe(KIND.CONNECTION_LOST);
    }
    expect(threw).toBe(true);
  });
});

// ── CFG-0095: ConfigStore.updateRemoteKeys ──────────────────────────────

describe("[CFG-0095] updateRemoteKeys: 未知 remote 名は BAD_REQUEST / 既知は keys 総入替+save", () => {
  it("[CFG-0095-a] 未知 remote 名は badRequest(unknownRemoteName) を throw する", () => {
    const { store, workDir } = makeTmpStore();
    try {
      expect(() => store.updateRemoteKeys("no-such-remote", { x: "y" })).toThrow(
        /unknownRemoteName|Unknown remote/i,
      );
    } finally { cleanupDir(workDir); }
  });

  it("[CFG-0095-b] 既知 remote 名は keys を総置換する", () => {
    const { store, workDir } = storeWithRemote("r1");
    try {
      store.updateRemoteKeys("r1", { power: "k1", mode: "k2" });
      const cfg = store.load();
      expect(cfg.remotes["r1"].keys).toEqual({ power: "k1", mode: "k2" });
    } finally { cleanupDir(workDir); }
  });

  it("[CFG-0095-c] 空オブジェクトを渡すと既存 keys がクリアされる", () => {
    const { store, workDir } = storeWithRemote("r1");
    try {
      store.updateRemoteKeys("r1", { power: "k1" });
      store.updateRemoteKeys("r1", {});
      expect(store.load().remotes["r1"].keys).toEqual({});
    } finally { cleanupDir(workDir); }
  });

  it("[CFG-0095-d] 更新がファイルに永続化される (save が呼ばれる)", () => {
    const { store, workDir, configPath } = storeWithRemote("r1");
    try {
      store.updateRemoteKeys("r1", { a: "b" });
      const store2 = new ConfigStore(configPath);
      expect(store2.load().remotes["r1"].keys).toEqual({ a: "b" });
    } finally { cleanupDir(workDir); }
  });

  it("[CFG-0095-e] throw されるエラーのメッセージに remote 名が含まれる", () => {
    const { store, workDir } = makeTmpStore();
    try {
      let err;
      try {
        store.updateRemoteKeys("ghost", {});
      } catch (e) {
        err = e;
      }
      expect(err).toBeDefined();
      expect(err.message).toMatch(/ghost/);
    } finally { cleanupDir(workDir); }
  });

  it("[CFG-0095-f] domain.config.unknownRemoteName が en に存在し 'Unknown remote' を含む", () => {
    expect(domainI18n.en["domain.config.unknownRemoteName"]).toBeDefined();
    expect(domainI18n.en["domain.config.unknownRemoteName"]).toMatch(/Unknown remote/i);
  });
});
