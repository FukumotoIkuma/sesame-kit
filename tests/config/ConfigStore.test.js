// ConfigStore の単体テスト。各 it ごとに tmpdir を切って実 IO を行う。
// mock は最小限。fs / path / os のみ標準モジュールを利用。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep, dirname } from "node:path";

import { ConfigStore } from "../../src/config.js";

const DEFAULT_WS_URL =
  "wss://82q6nuplv0.execute-api.ap-northeast-1.amazonaws.com/public";
const LEGACY_WS_URL =
  "wss://82q6nuplv0.execute-api.ap-northeast-1.amazonaws.com/production";
const DEFAULT_COMPANY_ID = "ch_CandyhouseMobile";
const DEFAULT_LANG = "ja";

let workDir;
let configPath;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "sesame-cfg-"));
  configPath = join(workDir, "nested", "config.json");
});

afterEach(() => {
  if (workDir && existsSync(workDir)) {
    rmSync(workDir, { recursive: true, force: true });
  }
  workDir = null;
  configPath = null;
});

/** 共通: 有効な lock データ */
function validLock(overrides = {}) {
  return {
    deviceUUID: "00000000-0000-0000-0000-000000000001",
    secretKey: "0123456789abcdef0123456789abcdef",
    ...overrides,
  };
}

function validRemote(overrides = {}) {
  return {
    hub3: "hub-a",
    irDeviceUUID: "ir-uuid-1",
    irType: 65024,
    ...overrides,
  };
}

function registerHub3(store, name = "hub-a") {
  store.addHub3(name, { deviceId: `device-${name}` });
}

describe("ConfigStore - constructor", () => {
  it("configPath が空文字や undefined だと throw する", () => {
    expect(() => new ConfigStore()).toThrow(/configPath required/);
    expect(() => new ConfigStore("")).toThrow(/configPath required/);
    expect(() => new ConfigStore(null)).toThrow(/configPath required/);
  });

  it("有効な configPath を受け取ると this.data は null で初期化される", () => {
    const store = new ConfigStore(configPath);
    expect(store.configPath).toBe(configPath);
    expect(store.data).toBeNull();
  });
});

describe("ConfigStore.exists()", () => {
  it("ファイルが無ければ false", () => {
    const store = new ConfigStore(configPath);
    expect(store.exists()).toBe(false);
  });

  it("ファイルが存在すれば true", () => {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, "{}");
    const store = new ConfigStore(configPath);
    expect(store.exists()).toBe(true);
  });
});

describe("ConfigStore.load()", () => {
  it("ファイル不在のときは empty config を返し、保存は行わない", () => {
    const store = new ConfigStore(configPath);
    const cfg = store.load();
    expect(cfg.companyID).toBe(DEFAULT_COMPANY_ID);
    expect(cfg.wsUrl).toBe(DEFAULT_WS_URL);
    expect(cfg.lang).toBe(DEFAULT_LANG);
    expect(cfg.default).toEqual({ remote: null, lock: null });
    expect(cfg.hub3s).toEqual({});
    expect(cfg.remotes).toEqual({});
    expect(cfg.locks).toEqual({});
    expect(cfg.apiKeyId).toBeNull();
    // load() 単体ではファイルを作らない
    expect(existsSync(configPath)).toBe(false);
  });

  it("禁止エンドポイント /production は load 時に /public へ強制され、ファイルからも物理的に消える (安全ガード)", () => {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ wsUrl: LEGACY_WS_URL, locks: {} }));
    const cfg = new ConfigStore(configPath).load();
    expect(cfg.wsUrl).toBe(DEFAULT_WS_URL); // /public (in-memory)
    // ファイルにも書き戻され、/production がディスク上から消えている
    const onDiskRaw = readFileSync(configPath, "utf8");
    expect(JSON.parse(onDiskRaw).wsUrl).toBe(DEFAULT_WS_URL);
    expect(onDiskRaw).not.toContain("/production");
  });

  it("ユーザーが明示設定した別 wsUrl は尊重する (移行は /production だけ)", () => {
    const custom = "wss://example.invalid/custom";
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ wsUrl: custom, locks: {} }));
    const cfg = new ConfigStore(configPath).load();
    expect(cfg.wsUrl).toBe(custom);
  });

  it("2 回目の load() は同じインスタンスを返す (キャッシュ)", () => {
    const store = new ConfigStore(configPath);
    const a = store.load();
    const b = store.load();
    expect(a).toBe(b);
  });

  it("devices / default.lock が欠落した config を読込むと既定値で補完される", () => {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        companyID: "co",
        wsUrl: "wss://old.example",
        remotes: {},
        default: { remote: null },
      }),
    );
    const store = new ConfigStore(configPath);
    const cfg = store.load();
    expect(cfg.devices).toEqual({});
    expect(cfg.locks).toEqual({}); // 派生 view も空で復元
    expect(cfg.default.lock).toBeNull();
    expect(cfg.companyID).toBe("co");
  });

  it("default フィールドが完全に欠落していても補完される", () => {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ companyID: "x" }));
    const store = new ConfigStore(configPath);
    const cfg = store.load();
    expect(cfg.default).toEqual({ remote: null, lock: null });
  });

  it("default.lock が undefined の場合は null に正規化される", () => {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ default: { remote: "r1" } }),
    );
    const store = new ConfigStore(configPath);
    const cfg = store.load();
    expect(cfg.default.remote).toBe("r1");
    expect(cfg.default.lock).toBeNull();
  });

  it("JSON が壊れている場合は throw する", () => {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, "{not-json");
    const store = new ConfigStore(configPath);
    expect(() => store.load()).toThrow();
  });
});

describe("ConfigStore.save()", () => {
  it("load() 前に save() を呼ぶと throw する", () => {
    const store = new ConfigStore(configPath);
    expect(() => store.save()).toThrow(/nothing to save/);
  });

  it("save() で round-trip できる", () => {
    const store = new ConfigStore(configPath);
    const cfg = store.load();
    cfg.companyID = "saved-co";
    cfg.registerBaseUrl = "https://register.example.invalid";
    store.save();

    const store2 = new ConfigStore(configPath);
    const cfg2 = store2.load();
    expect(cfg2.companyID).toBe("saved-co");
    expect(cfg2.registerBaseUrl).toBe("https://register.example.invalid");
  });

  it("save() は親ディレクトリを再帰的に作成する", () => {
    const deep = join(workDir, "a", "b", "c", "config.json");
    const store = new ConfigStore(deep);
    store.load();
    store.save();
    expect(existsSync(deep)).toBe(true);
  });

  it("save() の出力は末尾改行付きの pretty JSON", () => {
    const store = new ConfigStore(configPath);
    store.load();
    store.save();
    const raw = readFileSync(configPath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain("\n  "); // 2-space indent
  });

  it("POSIX では config.json の mode が 0600 になる", () => {
    if (process.platform === "win32") return; // Windows は skip
    const store = new ConfigStore(configPath);
    store.load();
    store.save();
    const st = statSync(configPath);
    const mode = st.mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("ConfigStore.init()", () => {
  it("ファイル不在なら空 config を書き出して true を返す", () => {
    const store = new ConfigStore(configPath);
    const created = store.init();
    expect(created).toBe(true);
    expect(existsSync(configPath)).toBe(true);
    const written = JSON.parse(readFileSync(configPath, "utf8"));
    expect(written.companyID).toBe(DEFAULT_COMPANY_ID);
    expect(written.devices).toEqual({});   // 単一 devices コレクション
    expect(written.remotes).toEqual({});
    expect(written.locks).toBeUndefined();  // 派生 view は永続化しない
    expect(written.hub3s).toBeUndefined();
  });

  it("既存ファイルがあれば触らず false を返す", () => {
    mkdirSync(dirname(configPath), { recursive: true });
    const original = JSON.stringify({ companyID: "preserve-me" });
    writeFileSync(configPath, original);

    const store = new ConfigStore(configPath);
    const created = store.init();
    expect(created).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });
});

describe("ConfigStore.addHub3()", () => {
  it("name + deviceId を渡せば登録される", () => {
    const store = new ConfigStore(configPath);
    store.addHub3("hub-a", { deviceId: "dev-1" });
    const cfg = store.load();
    // hub3 view は session が経路判定/操作に使う model・secretKey も保持する
    // (旧スキーマでは取りこぼしていた。devices 丸ごと保存の結果 view も richer に)。
    expect(cfg.hub3s["hub-a"]).toEqual({
      deviceId: "dev-1",
      name: "hub-a",
      model: "hub_3",
      secretKey: null,
    });
  });

  it("name を渡さないと throw", () => {
    const store = new ConfigStore(configPath);
    expect(() => store.addHub3("", { deviceId: "x" })).toThrow(
      /hub3 name required/,
    );
  });

  it("deviceId が無いと throw", () => {
    const store = new ConfigStore(configPath);
    expect(() => store.addHub3("hub-a", {})).toThrow(/hub3.deviceId required/);
    expect(() => store.addHub3("hub-a", null)).toThrow(/hub3.deviceId required/);
  });

  it("hub3 オブジェクトに name があれば優先される", () => {
    const store = new ConfigStore(configPath);
    store.addHub3("hub-a", { deviceId: "dev-1", name: "My Hub" });
    expect(store.load().hub3s["hub-a"].name).toBe("My Hub");
  });

  it("同名で 2 度呼ぶと上書きされる", () => {
    const store = new ConfigStore(configPath);
    store.addHub3("hub-a", { deviceId: "dev-1" });
    store.addHub3("hub-a", { deviceId: "dev-2" });
    expect(store.load().hub3s["hub-a"].deviceId).toBe("dev-2");
  });
});

describe("ConfigStore.addRemote()", () => {
  it("hub3 未登録だと throw", () => {
    const store = new ConfigStore(configPath);
    expect(() => store.addRemote("r1", validRemote())).toThrow(
      /hub3 "hub-a" 未登録/,
    );
  });

  it("name が空だと throw", () => {
    const store = new ConfigStore(configPath);
    registerHub3(store);
    expect(() => store.addRemote("", validRemote())).toThrow(
      /remote name required/,
    );
  });

  it("remote.hub3 が無いと throw", () => {
    const store = new ConfigStore(configPath);
    registerHub3(store);
    expect(() => store.addRemote("r1", {})).toThrow(/remote.hub3 required/);
  });

  it("正常系: 初回登録で default.remote が自動セットされる", () => {
    const store = new ConfigStore(configPath);
    registerHub3(store);
    store.addRemote("r1", validRemote());
    const cfg = store.load();
    expect(cfg.remotes.r1).toMatchObject({
      hub3: "hub-a",
      irDeviceUUID: "ir-uuid-1",
      irType: 65024,
      irOperation: "learnEmit",
      alias: null,
      keys: {},
    });
    expect(cfg.default.remote).toBe("r1");
  });

  it("2 個目を登録しても default.remote は変わらない", () => {
    const store = new ConfigStore(configPath);
    registerHub3(store);
    store.addRemote("r1", validRemote());
    store.addRemote("r2", validRemote());
    expect(store.load().default.remote).toBe("r1");
  });

  it("irType は Number に変換される (文字列 → 数値)", () => {
    const store = new ConfigStore(configPath);
    registerHub3(store);
    store.addRemote("r1", validRemote({ irType: "256" }));
    expect(store.load().remotes.r1.irType).toBe(256);
  });

  it("irOperation 省略時は 'learnEmit' になる", () => {
    const store = new ConfigStore(configPath);
    registerHub3(store);
    store.addRemote(
      "r1",
      validRemote({ irOperation: undefined }),
    );
    expect(store.load().remotes.r1.irOperation).toBe("learnEmit");
  });

  it("alias / keys を保持する", () => {
    const store = new ConfigStore(configPath);
    registerHub3(store);
    store.addRemote(
      "r1",
      validRemote({ alias: "リビング", keys: { power: "k1" } }),
    );
    const r = store.load().remotes.r1;
    expect(r.alias).toBe("リビング");
    expect(r.keys).toEqual({ power: "k1" });
  });
});

describe("ConfigStore.resolveRemote()", () => {
  it("名前指定で見つかれば返す", () => {
    const store = new ConfigStore(configPath);
    registerHub3(store);
    store.addRemote("r1", validRemote());
    const res = store.resolveRemote("r1");
    expect(res.name).toBe("r1");
    expect(res.hub3Name).toBe("hub-a");
    expect(res.hub3.deviceId).toBe("device-hub-a");
    expect(res.remote.hub3).toBe("hub-a");
  });

  it("名前省略時は default.remote にフォールバック", () => {
    const store = new ConfigStore(configPath);
    registerHub3(store);
    store.addRemote("r1", validRemote());
    store.addRemote("r2", validRemote());
    store.setDefaultRemote("r2");
    expect(store.resolveRemote().name).toBe("r2");
  });

  it("default 無し + remotes が 1 個だけならそれを採用", () => {
    const store = new ConfigStore(configPath);
    registerHub3(store);
    store.addRemote("only", validRemote());
    // default を強制的に消す
    const cfg = store.load();
    cfg.default.remote = null;
    store.save();
    expect(store.resolveRemote().name).toBe("only");
  });

  it("default 無し + remotes 複数なら throw", () => {
    const store = new ConfigStore(configPath);
    registerHub3(store);
    store.addRemote("r1", validRemote());
    store.addRemote("r2", validRemote());
    const cfg = store.load();
    cfg.default.remote = null;
    store.save();
    expect(() => store.resolveRemote()).toThrow(/No remote specified/);
  });

  it("remotes 空の状態で resolve すると throw", () => {
    const store = new ConfigStore(configPath);
    expect(() => store.resolveRemote()).toThrow(/No remote specified/);
  });

  it("Unknown name を渡すと throw", () => {
    const store = new ConfigStore(configPath);
    registerHub3(store);
    store.addRemote("r1", validRemote());
    expect(() => store.resolveRemote("missing")).toThrow(
      /Unknown remote "missing"/,
    );
  });

  it("hub3 を後から強制削除した remote を resolve すると throw", () => {
    const store = new ConfigStore(configPath);
    registerHub3(store);
    store.addRemote("r1", validRemote());
    const cfg = store.load();
    delete cfg.devices["hub-a"]; // devices が真実。view (hub3s) は save()→_reproject で再生成される
    store.save();
    expect(() => store.resolveRemote("r1")).toThrow(
      /hub3 "hub-a" を参照しますが未登録/,
    );
  });
});

describe("ConfigStore.setDefaultRemote()", () => {
  it("未登録名は throw", () => {
    const store = new ConfigStore(configPath);
    expect(() => store.setDefaultRemote("nope")).toThrow(
      /Unknown remote "nope"/,
    );
  });

  it("登録済み名は default に設定される", () => {
    const store = new ConfigStore(configPath);
    registerHub3(store);
    store.addRemote("r1", validRemote());
    store.addRemote("r2", validRemote());
    store.setDefaultRemote("r2");
    expect(store.load().default.remote).toBe("r2");
  });
});

describe("ConfigStore.updateRemoteKeys()", () => {
  it("未登録名は throw", () => {
    const store = new ConfigStore(configPath);
    expect(() => store.updateRemoteKeys("nope", {})).toThrow(
      /Unknown remote "nope"/,
    );
  });

  it("既存 keys を完全に置き換える", () => {
    const store = new ConfigStore(configPath);
    registerHub3(store);
    store.addRemote("r1", validRemote({ keys: { a: "1" } }));
    store.updateRemoteKeys("r1", { b: "2", c: "3" });
    expect(store.load().remotes.r1.keys).toEqual({ b: "2", c: "3" });
  });

  it("空オブジェクトを渡すと keys がクリアされる", () => {
    const store = new ConfigStore(configPath);
    registerHub3(store);
    store.addRemote("r1", validRemote({ keys: { a: "1" } }));
    store.updateRemoteKeys("r1", {});
    expect(store.load().remotes.r1.keys).toEqual({});
  });

  it("update した内容がファイルに永続化される", () => {
    const store = new ConfigStore(configPath);
    registerHub3(store);
    store.addRemote("r1", validRemote());
    store.updateRemoteKeys("r1", { x: "y" });

    const store2 = new ConfigStore(configPath);
    expect(store2.load().remotes.r1.keys).toEqual({ x: "y" });
  });
});

describe("ConfigStore.addLock()", () => {
  it("name 空だと throw", () => {
    const store = new ConfigStore(configPath);
    expect(() => store.addLock("", validLock())).toThrow(/lock name required/);
  });

  it("deviceUUID 欠落で throw", () => {
    const store = new ConfigStore(configPath);
    expect(() =>
      store.addLock("L1", { secretKey: "abc" }),
    ).toThrow(/lock.deviceUUID required/);
  });

  it("secretKey 欠落で throw", () => {
    const store = new ConfigStore(configPath);
    expect(() =>
      store.addLock("L1", { deviceUUID: "u" }),
    ).toThrow(/lock.secretKey required/);
  });

  it("lock が null/undefined で throw", () => {
    const store = new ConfigStore(configPath);
    expect(() => store.addLock("L1", null)).toThrow(/lock.deviceUUID required/);
    expect(() => store.addLock("L1")).toThrow(/lock.deviceUUID required/);
  });

  it("正常系: 登録される & 初回は default.lock が自動セット", () => {
    const store = new ConfigStore(configPath);
    store.addLock("L1", validLock({ model: "SESAME5", alias: "玄関" }));
    const cfg = store.load();
    expect(cfg.locks.L1).toEqual({
      deviceUUID: "00000000-0000-0000-0000-000000000001",
      secretKey: "0123456789abcdef0123456789abcdef",
      model: "SESAME5",
      alias: "玄関",
    });
    expect(cfg.default.lock).toBe("L1");
  });

  it("model / alias 省略時は null になる", () => {
    const store = new ConfigStore(configPath);
    store.addLock("L1", validLock());
    expect(store.load().locks.L1.model).toBeNull();
    expect(store.load().locks.L1.alias).toBeNull();
  });

  it("2 個目を登録しても default.lock は変わらない", () => {
    const store = new ConfigStore(configPath);
    store.addLock("L1", validLock());
    store.addLock("L2", validLock({ deviceUUID: "uuid-2" }));
    expect(store.load().default.lock).toBe("L1");
  });
});

describe("ConfigStore.resolveLock()", () => {
  it("名前指定でヒットすれば返す", () => {
    const store = new ConfigStore(configPath);
    store.addLock("L1", validLock());
    const res = store.resolveLock("L1");
    expect(res.name).toBe("L1");
    expect(res.lock.deviceUUID).toBe("00000000-0000-0000-0000-000000000001");
  });

  it("名前省略時は default.lock を採用", () => {
    const store = new ConfigStore(configPath);
    store.addLock("L1", validLock());
    store.addLock("L2", validLock({ deviceUUID: "uuid-2" }));
    store.setDefaultLock("L2");
    expect(store.resolveLock().name).toBe("L2");
  });

  it("default 無し + locks 1 個ならそれを採用", () => {
    const store = new ConfigStore(configPath);
    store.addLock("only", validLock());
    const cfg = store.load();
    cfg.default.lock = null;
    store.save();
    expect(store.resolveLock().name).toBe("only");
  });

  it("default 無し + locks 複数なら throw", () => {
    const store = new ConfigStore(configPath);
    store.addLock("L1", validLock());
    store.addLock("L2", validLock({ deviceUUID: "uuid-2" }));
    const cfg = store.load();
    cfg.default.lock = null;
    store.save();
    expect(() => store.resolveLock()).toThrow(/No lock specified/);
  });

  it("locks 空で resolveLock() すると throw", () => {
    const store = new ConfigStore(configPath);
    expect(() => store.resolveLock()).toThrow(/No lock specified/);
  });

  it("Unknown name で throw", () => {
    const store = new ConfigStore(configPath);
    store.addLock("L1", validLock());
    expect(() => store.resolveLock("missing")).toThrow(
      /Unknown lock "missing"/,
    );
  });
});

describe("ConfigStore.setDefaultLock()", () => {
  it("未登録名は throw", () => {
    const store = new ConfigStore(configPath);
    expect(() => store.setDefaultLock("nope")).toThrow(/Unknown lock "nope"/);
  });

  it("登録済み名は default.lock に設定される", () => {
    const store = new ConfigStore(configPath);
    store.addLock("L1", validLock());
    store.addLock("L2", validLock({ deviceUUID: "uuid-2" }));
    store.setDefaultLock("L2");
    expect(store.load().default.lock).toBe("L2");
  });

  it("変更がファイルに永続化される", () => {
    const store = new ConfigStore(configPath);
    store.addLock("L1", validLock());
    store.addLock("L2", validLock({ deviceUUID: "uuid-2" }));
    store.setDefaultLock("L2");

    const store2 = new ConfigStore(configPath);
    expect(store2.load().default.lock).toBe("L2");
  });
});

describe("ConfigStore.removeLock()", () => {
  it("未登録名は throw", () => {
    const store = new ConfigStore(configPath);
    expect(() => store.removeLock("nope")).toThrow(/Unknown lock "nope"/);
  });

  it("削除対象が default だと default.lock が null になる", () => {
    const store = new ConfigStore(configPath);
    store.addLock("L1", validLock());
    expect(store.load().default.lock).toBe("L1");
    store.removeLock("L1");
    const cfg = store.load();
    expect(cfg.locks.L1).toBeUndefined();
    expect(cfg.default.lock).toBeNull();
  });

  it("削除対象が default で無ければ default.lock は維持される", () => {
    const store = new ConfigStore(configPath);
    store.addLock("L1", validLock());
    store.addLock("L2", validLock({ deviceUUID: "uuid-2" }));
    // default は L1 のまま
    store.removeLock("L2");
    const cfg = store.load();
    expect(cfg.locks.L2).toBeUndefined();
    expect(cfg.default.lock).toBe("L1");
  });

  it("削除がファイルに永続化される", () => {
    const store = new ConfigStore(configPath);
    store.addLock("L1", validLock());
    store.removeLock("L1");

    const store2 = new ConfigStore(configPath);
    const cfg = store2.load();
    expect(cfg.locks).toEqual({});
    expect(cfg.default.lock).toBeNull();
  });
});

describe("ConfigStore.fromConfigDir()", () => {
  it("ディレクトリパスから config.json の Store を作る", () => {
    const dir = join(workDir, "cdir");
    const store = ConfigStore.fromConfigDir(dir);
    expect(store.configPath.endsWith(`${sep}config.json`)).toBe(true);
    expect(store.configPath.startsWith(dir)).toBe(true);
  });
});
