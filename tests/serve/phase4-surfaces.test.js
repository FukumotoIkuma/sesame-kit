// Phase 4 (P4-3 / P4-4 / P4-6 / P4-8) で追加・変更した RPC 表面の結線テスト。
//   - SURF-32 (P4-6): config.syncRemotesFromServer / config.listRemoteCandidates の結線
//   - SURF-04: access.registerPasscodes (hub.registerPasscodes 委譲) + SesameHub3.registerPasscodes
//   - SURF-06: cloud.ping (hub.ping = biz3KeepAlive 1 往復)
//   - SURF-07: config.syncLocks/syncHub3s/syncRemotes/syncRemoteKeys (ConfigStore 必須ガード)
//   - SURF-09: gen-rpc-schema の companyID/subUUID required:false 上書き + daemon 起動時 refreshAccount
//   - SURF-15: lock.setAutolock の transport ("cloud" 既定 / "ble" = SesameBle.autolock)
//   - SURF-16: TOPICS の単一定義 (daemon は registry から import)
//   - SURF-20: registry summary の i18n キー解決 (未定義キーの素通し検出)
//   - SURF-22: gen-grpc-proto の Discover 重複削除
//   - SURF-24: ir.listKeys の hub3DeviceId/irDeviceUUID 直指定
//   - SURF-34 (P4-8): events.subscribe/unsubscribe の topics param に enum schema を付与
import { describe, it, expect, vi, afterEach } from "vitest";
import { buildRegistry, SUBSCRIBABLE_TOPICS, STATE_TOPICS } from "../../src/serve/registry.js";
import { Daemon } from "../../src/serve/daemon.js";
import { SesameHub3 } from "../../src/client.js";
import { SesameBle } from "../../src/ble/index.js";
import { stabilityOf } from "../../src/serve/stability.js";

const ACTION = "biz3ManageAccessCtlAuthData";

// requireAuth を通す最小 daemon。
const daemon = { authState: "ok", hub: { connected: true } };

afterEach(() => { vi.restoreAllMocks(); });

describe("SURF-04: access.registerPasscodes", () => {
  const reg = buildRegistry();

  it("SesameHub3.registerPasscodes は records を {passwordID, name, nameUUID} に写像して postPasscodes を送る (nameUUID 透過)", async () => {
    const hub = new SesameHub3({
      config: { companyID: "co", wsUrl: "ws://unused", lang: "ja", default: {}, hub3s: {}, remotes: {}, locks: {} },
      tokenStore: {},
    });
    const sent = [];
    hub._ws = {
      async request(frame) { sent.push(frame); return { action: ACTION, op: "postPasscodes", code: 200, success: true }; },
      send() { throw new Error("unexpected send"); },
    };
    await hub.registerPasscodes("dev-1", [
      // BLE NOTIFY 由来形 (parseTouchCard 共通形)。nameUUID はファームウェア採番の 32hex。
      { cardID: "1234", cardName: "31323334", nameUUID: "00112233445566778899AABBCCDDEEFF" },
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0].op).toBe("postPasscodes");
    expect(sent[0].deviceUUID).toBe("dev-1");
    // enrolledToPasscodeList の最小写像 (passwords.js:101-113): keyBoardPassCode 等は送らない。
    expect(sent[0].list).toEqual([
      { passwordID: "1234", name: "31323334", nameUUID: "00112233-4455-6677-8899-aabbccddeeff" },
    ]);
  });

  it("registry: access.registerPasscodes → hub.registerPasscodes(deviceUUID, passcodes)", async () => {
    const calls = [];
    const hub = { registerPasscodes: async (u, p) => { calls.push([u, p]); return { ok: true }; } };
    const e = reg.get("access.registerPasscodes");
    expect(e).toBeTruthy();
    expect(e.params.map((p) => p.name)).toEqual(["deviceUUID", "passcodes"]);
    const passcodes = [{ cardID: "1234", cardName: "n" }];
    await e.handler({ hub, daemon, params: { deviceUUID: "U", passcodes } });
    expect(calls).toEqual([["U", passcodes]]);
  });

  it("registry: 必須 param 欠落は throw / experimental", () => {
    const e = buildRegistry().get("access.registerPasscodes");
    expect(() => e.handler({ hub: {}, daemon, params: { deviceUUID: "U" } })).toThrow();
    expect(stabilityOf("access.registerPasscodes")).toBe("experimental");
  });
});

describe("SURF-06: cloud.ping", () => {
  it("hub.ping() を 1 往復して {ok, rttMs} を返す", async () => {
    const reg = buildRegistry();
    const e = reg.get("cloud.ping");
    expect(e).toBeTruthy();
    const hub = { ping: vi.fn(async () => true) };
    const r = await e.handler({ hub, daemon, params: {} });
    expect(hub.ping).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
    expect(typeof r.rttMs).toBe("number");
    expect(stabilityOf("cloud.ping")).toBe("experimental");
  });

  it("未認証 daemon では not_authenticated", async () => {
    const e = buildRegistry().get("cloud.ping");
    await expect(e.handler({ hub: { ping: async () => true }, daemon: { authState: "expired", hub: { connected: false } }, params: {} }))
      .rejects.toThrow();
  });
});

describe("SURF-07: config.sync* RPC", () => {
  const reg = buildRegistry();

  it("config.syncLocks / syncHub3s は prune を hub.sync*FromDevices へ透過する", async () => {
    const calls = [];
    const hub = {
      configStore: {}, // ConfigStore を持つ構成
      syncLocksFromDevices: async (o) => { calls.push(["locks", o]); return { added: [], updated: [], removed: [] }; },
      syncHub3sFromDevices: async (o) => { calls.push(["hub3s", o]); return { added: [], updated: [], removed: [] }; },
    };
    await reg.get("config.syncLocks").handler({ hub, daemon, params: { prune: true } });
    await reg.get("config.syncHub3s").handler({ hub, daemon, params: {} });
    expect(calls).toEqual([["locks", { prune: true }], ["hub3s", { prune: false }]]);
  });

  it("config.syncRemotes / syncRemoteKeys の結線", async () => {
    const calls = [];
    const hub = {
      configStore: {},
      syncRemotesFromDevices: async () => { calls.push(["remotes"]); return { hub3: {}, remotes: {} }; },
      syncRemoteKeys: async (name) => { calls.push(["keys", name]); return { name, keyCount: 0 }; },
    };
    await reg.get("config.syncRemotes").handler({ hub, daemon, params: {} });
    await reg.get("config.syncRemoteKeys").handler({ hub, daemon, params: { remote: "ac" } });
    await reg.get("config.syncRemoteKeys").handler({ hub, daemon, params: {} });
    expect(calls).toEqual([["remotes"], ["keys", "ac"], ["keys", null]]);
  });

  it("ConfigStore を持たない構成では bad_params の明示エラー (internal に潰さない)", async () => {
    const hub = { configStore: null, syncLocksFromDevices: vi.fn() };
    for (const m of ["config.syncLocks", "config.syncHub3s", "config.syncRemotes", "config.syncRemoteKeys"]) {
      let err = null;
      try { await reg.get(m).handler({ hub, daemon, params: {} }); } catch (e) { err = e; }
      expect(err, `${m} は throw すべき`).toBeTruthy();
      expect(err.kind, `${m} の kind`).toBe("bad_params");
    }
    expect(hub.syncLocksFromDevices).not.toHaveBeenCalled();
  });

  it("config.* は experimental", () => {
    for (const m of ["config.syncLocks", "config.syncHub3s", "config.syncRemotes", "config.syncRemoteKeys"]) {
      expect(stabilityOf(m), m).toBe("experimental");
    }
  });
});

describe("SURF-15: lock.setAutolock の transport", () => {
  it("既定 (transport 省略) は従来どおり cloud 経路 (後方互換)", async () => {
    const reg = buildRegistry();
    const e = reg.get("lock.setAutolock");
    const hub = {
      setAutolock: vi.fn(async () => ({ ack: 1, cmd: 11, seconds: 30 })),
      setAutolockDevice: vi.fn(async () => ({ ack: 1, cmd: 11, seconds: 30 })),
    };
    await e.handler({ hub, daemon, params: { name: "front", seconds: 30, timeoutMs: 500 } });
    expect(hub.setAutolock).toHaveBeenCalledWith("front", 30, 500);
    await e.handler({ hub, daemon, params: { deviceUUID: "U", secretKey: "s", seconds: 0 } });
    expect(hub.setAutolockDevice).toHaveBeenCalledWith({ deviceUUID: "U", secretKey: "s", seconds: 0, timeoutMs: undefined });
  });

  it('transport:"ble" は SesameBle.autolock(seconds) を実行し ack を返す (クラウド接続不要)', async () => {
    const reg = buildRegistry();
    const e = reg.get("lock.setAutolock");
    const fakeBle = { autolock: vi.fn(async (s) => ({ resultCode: 0, payload: Buffer.alloc(0), seconds: s })) };
    const useSpy = vi.spyOn(SesameBle, "use").mockImplementation(async (_opts, fn) => fn(fakeBle));
    // クラウド未認証 (expired) でも BLE 経路は通る (requireAuth を踏まない)。
    const r = await e.handler({
      hub: {},
      daemon: { authState: "expired", hub: { connected: false } },
      params: { transport: "ble", deviceUUID: "U", secretKey: "00".repeat(16), model: "sesame_5", seconds: 45 },
    });
    expect(fakeBle.autolock).toHaveBeenCalledWith(45);
    expect(r).toMatchObject({ resultCode: 0, seconds: 45, transport: "ble" });
    expect(typeof r.resultName).toBe("string");
    // 対象指定は ble.invoke と同じ bleUseOptsFromParams (deviceUUID/secretKey/model 透過)。
    const opts = useSpy.mock.calls[0][0];
    expect(opts).toMatchObject({ deviceUUID: "U", model: "sesame_5" });
  });

  it('transport:"ble" は secretKey 必須 / 未知 transport は bad_params', async () => {
    const reg = buildRegistry();
    const e = reg.get("lock.setAutolock");
    await expect(e.handler({ hub: {}, daemon, params: { transport: "ble", deviceUUID: "U", seconds: 1 } })).rejects.toThrow();
    await expect(e.handler({ hub: {}, daemon, params: { transport: "nope", name: "front", seconds: 1 } })).rejects.toThrow(/transport/);
  });
});

describe("SURF-24: ir.listKeys の直指定", () => {
  const reg = buildRegistry();

  it("hub3DeviceId + irDeviceUUID 指定で hub.getIRCodesDirect へ直行 (config 非依存)", async () => {
    const calls = [];
    const hub = {
      getIRCodesDirect: async (p) => { calls.push(["direct", p]); return []; },
      listKeys: async (r) => { calls.push(["named", r]); return []; },
    };
    const e = reg.get("ir.listKeys");
    expect(e.params.map((p) => p.name)).toEqual(["remote", "hub3DeviceId", "irDeviceUUID"]);
    await e.handler({ hub, daemon, params: { hub3DeviceId: "H", irDeviceUUID: "R" } });
    await e.handler({ hub, daemon, params: { remote: "ac" } });
    await e.handler({ hub, daemon, params: {} });
    expect(calls).toEqual([
      ["direct", { hub3DeviceId: "H", irDeviceUUID: "R" }],
      ["named", "ac"],
      ["named", null],
    ]);
  });

  it("片方だけの直指定は bad_params (対象を特定できない)", () => {
    const hub = { getIRCodesDirect: vi.fn(), listKeys: vi.fn() };
    const e = reg.get("ir.listKeys");
    expect(() => e.handler({ hub, daemon, params: { hub3DeviceId: "H" } })).toThrow();
    expect(() => e.handler({ hub, daemon, params: { irDeviceUUID: "R" } })).toThrow();
    expect(hub.getIRCodesDirect).not.toHaveBeenCalled();
    expect(hub.listKeys).not.toHaveBeenCalled();
  });
});

describe("SURF-16: topic 集合の単一定義", () => {
  it("daemon.topics は registry.SUBSCRIBABLE_TOPICS そのもの", () => {
    const hub = {
      connected: false, connect: async () => {}, close: async () => {},
      onDeviceUpdate: () => () => {},
    };
    const d = new Daemon({ hub });
    expect(d.topics).toBe(SUBSCRIBABLE_TOPICS);
    expect([...SUBSCRIBABLE_TOPICS]).toEqual([...STATE_TOPICS, "deviceListChanged"]);
  });
});

describe("SURF-09: daemon 起動時の refreshAccount", () => {
  function makeHub(over = {}) {
    return {
      connected: true,
      config: { devices: {} },
      connect: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      onDeviceUpdate: () => () => {},
      refreshAccount: vi.fn(async () => ({ companyID: "real_co" })),
      ...over,
    };
  }

  it("接続確立後に refreshAccount を 1 回呼ぶ (config 既定 companyID と実値の食い違い解消)", async () => {
    const hub = makeHub();
    const d = new Daemon({ hub });
    await d._connectLoop();
    expect(hub.refreshAccount).toHaveBeenCalledTimes(1);
    expect(d.authState).toBe("ok");
  });

  it("refreshAccount 失敗は warn ログのみで継続 (authState は ok のまま)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const hub = makeHub({ refreshAccount: vi.fn(async () => { throw new Error("ws down"); }) });
    const d = new Daemon({ hub });
    await d._connectLoop();
    expect(d.authState).toBe("ok");
    expect(errSpy).toHaveBeenCalled(); // warn ログ
  });

  it("refreshAccount を持たない hub (テスト fake 等) でも起動できる", async () => {
    const hub = makeHub();
    delete hub.refreshAccount;
    const d = new Daemon({ hub });
    await d._connectLoop();
    expect(d.authState).toBe("ok");
  });
});

describe("SURF-09: gen-rpc-schema の companyID/subUUID 上書き", () => {
  it("名前空間 op の companyID/subUUID は required:false + 自動注入 desc になる", async () => {
    const { generateSchema } = await import("../../scripts/gen-rpc-schema.mjs");
    const schema = await generateSchema();
    let seen = 0;
    for (const [op, params] of Object.entries(schema)) {
      for (const p of params) {
        if (p.name !== "companyID" && p.name !== "subUUID") continue;
        seen += 1;
        expect(p.required, `${op}.${p.name} は required:false (daemon が自動注入)`).toBe(false);
        expect(p.desc, `${op}.${p.name} の desc に注入注記`).toMatch(/auto-injected by the daemon/);
      }
    }
    expect(seen).toBeGreaterThan(0); // 対象 param が 1 つも無いなら前提が崩れている
  });
});

describe("SURF-22: gRPC Discover 重複の削除", () => {
  it("rpc.discover への rpc は RpcDiscover の 1 本のみ (Discover は生成されない)", async () => {
    const { generateProto } = await import("../../scripts/gen-grpc-proto.mjs");
    const { protoText, nameMap } = await generateProto();
    expect(nameMap.RpcDiscover).toEqual({ method: "rpc.discover", jsonFields: [] });
    expect(nameMap.Discover).toBeUndefined();
    const discoverRpcs = Object.values(nameMap).filter((e) => e.method === "rpc.discover");
    expect(discoverRpcs).toHaveLength(1);
    expect(protoText).not.toMatch(/rpc Discover \(/);
    expect(protoText).toMatch(/rpc RpcDiscover \(/);
  });
});

describe("SURF-20: registry summary の i18n キー解決", () => {
  it("全 entry の summary が i18n キーのまま素通りしていない (未定義キー検出)", () => {
    const reg = buildRegistry();
    for (const [name, e] of reg) {
      expect(typeof e.summary, name).toBe("string");
      expect(e.summary.length, name).toBeGreaterThan(0);
      // t() は未定義キーをキー文字列のまま返すため、"serve." 始まりの summary は付け忘れ。
      expect(e.summary.startsWith("serve."), `${name} の summary が未解決キー: ${e.summary}`).toBe(false);
    }
  });
});

describe("lock.click scriptIndex (Bot2/Bot3 台本の番号実行)", () => {
  const reg = buildRegistry();

  it("scriptIndex 省略時は通常クリック (botClick)", async () => {
    const e = reg.get("lock.click");
    const hub = { botClick: vi.fn(async () => ({ ok: true })), botClickScript: vi.fn() };
    await e.handler({ hub, daemon, params: { name: "bot" } });
    expect(hub.botClick).toHaveBeenCalledWith("bot");
    expect(hub.botClickScript).not.toHaveBeenCalled();
  });

  it("scriptIndex 指定時は番号実行 (botClickScript)", async () => {
    const e = reg.get("lock.click");
    const hub = { botClick: vi.fn(), botClickScript: vi.fn(async () => ({ ok: true })) };
    await e.handler({ hub, daemon, params: { name: "bot", scriptIndex: 3 } });
    expect(hub.botClickScript).toHaveBeenCalledWith("bot", 3);
    expect(hub.botClick).not.toHaveBeenCalled();
  });

  it("scriptIndex=0 も番号実行へ (falsy だが有効値)", async () => {
    const e = reg.get("lock.click");
    const hub = { botClick: vi.fn(), botClickScript: vi.fn(async () => ({ ok: true })) };
    await e.handler({ hub, daemon, params: { name: "bot", scriptIndex: 0 } });
    expect(hub.botClickScript).toHaveBeenCalledWith("bot", 0);
  });

  it("deviceUUID + scriptIndex は botClickScriptDevice へ", async () => {
    const e = reg.get("lock.click");
    const hub = { botClickDevice: vi.fn(), botClickScriptDevice: vi.fn(async () => ({ ok: true })) };
    await e.handler({ hub, daemon, params: { deviceUUID: "U", secretKey: "K", scriptIndex: 5 } });
    expect(hub.botClickScriptDevice).toHaveBeenCalledWith({ deviceUUID: "U", secretKey: "K", scriptIndex: 5 });
  });

  it("scriptIndex param が discover に出る", () => {
    const e = reg.get("lock.click");
    expect(e.params.some((p) => p.name === "scriptIndex")).toBe(true);
  });
});

describe("SURF-32 (P4-6): config.syncRemotesFromServer / config.listRemoteCandidates の結線", () => {
  const reg = buildRegistry();

  it("config.syncRemotesFromServer は hub3 + irType を hub.syncRemotesFromServer へ委譲する", async () => {
    const calls = [];
    const hub = {
      configStore: {},
      syncRemotesFromServer: async (hub3Name, irType) => {
        calls.push([hub3Name, irType]);
        return { added: ["ac"], updated: [] };
      },
    };
    const e = reg.get("config.syncRemotesFromServer");
    expect(e, "エントリが登録されている").toBeTruthy();
    // hub3 / irType どちらも必須になっている
    expect(e.params.map((p) => p.name)).toEqual(["hub3", "irType"]);
    expect(e.params.find((p) => p.name === "hub3").required).toBe(true);
    expect(e.params.find((p) => p.name === "irType").required).toBe(true);
    const r = await e.handler({ hub, daemon, params: { hub3: "living_ac", irType: 49152 } });
    expect(calls).toEqual([["living_ac", 49152]]);
    expect(r).toEqual({ added: ["ac"], updated: [] });
  });

  it("config.syncRemotesFromServer: irType は Number() 変換して渡す", async () => {
    const calls = [];
    const hub = {
      configStore: {},
      syncRemotesFromServer: async (h, t) => { calls.push([h, t]); return { added: [], updated: [] }; },
    };
    const e = reg.get("config.syncRemotesFromServer");
    // JSON-RPC 経由で文字列として届いた場合も Number に変換される
    await e.handler({ hub, daemon, params: { hub3: "h1", irType: "8192" } });
    expect(calls[0][1]).toBe(8192);
    expect(typeof calls[0][1]).toBe("number");
  });

  it("config.syncRemotesFromServer: hub3 / irType 欠落は bad_params", () => {
    // handler は同期 throw (non-async) — try/catch パターン (config.* の既存テストと同じ規約)。
    const e = reg.get("config.syncRemotesFromServer");
    const hub = { configStore: {} };
    expect(() => e.handler({ hub, daemon, params: { irType: 49152 } })).toThrow();
    expect(() => e.handler({ hub, daemon, params: { hub3: "h1" } })).toThrow();
  });

  it("config.syncRemotesFromServer: ConfigStore を持たない構成は bad_params (internal に潰さない)", async () => {
    const hub = { configStore: null };
    const e = reg.get("config.syncRemotesFromServer");
    let err = null;
    try { await e.handler({ hub, daemon, params: { hub3: "h1", irType: 49152 } }); } catch (ex) { err = ex; }
    expect(err).toBeTruthy();
    expect(err.kind).toBe("bad_params");
  });

  it("config.listRemoteCandidates は hub.listRemotesFromDevices() に委譲し configStore 不要", async () => {
    const candidates = [
      { hub3DeviceUUID: "uuid-hub3", hub3Name: "living", uuid: "uuid-remote", type: 49152, alias: "AC" },
    ];
    const hub = { listRemotesFromDevices: async () => candidates };
    const e = reg.get("config.listRemoteCandidates");
    expect(e, "エントリが登録されている").toBeTruthy();
    expect(e.params).toEqual([]); // 引数なし
    const r = await e.handler({ hub, daemon, params: {} });
    expect(r).toEqual(candidates);
  });

  it("config.listRemoteCandidates: 未認証 daemon は not_authenticated", () => {
    // requireAuth は同期 throw。
    const e = reg.get("config.listRemoteCandidates");
    expect(() =>
      e.handler({ hub: { listRemotesFromDevices: async () => [] }, daemon: { authState: "expired", hub: { connected: false } }, params: {} }),
    ).toThrow();
  });

  it("config.syncRemotesFromServer / listRemoteCandidates は experimental", () => {
    // stabilityOf はトップレベルで import 済み (phase4-surfaces.test.js 先頭)。
    for (const m of ["config.syncRemotesFromServer", "config.listRemoteCandidates"]) {
      expect(stabilityOf(m), m).toBe("experimental");
    }
  });

  it("config.syncRemotesFromServer は ConfigStore ガード対象の列挙に含まれる (bad_params 一覧テストと整合)", async () => {
    // config.syncLocks/syncHub3s/syncRemotes/syncRemoteKeys と同じく ConfigStore 必須である確認。
    // (上の ConfigStore テストで単体検証済み。ここでは全 config.* ガード対象の完全性を列挙で保護する)
    const guardedMethods = [
      "config.syncLocks", "config.syncHub3s", "config.syncRemotes",
      "config.syncRemoteKeys", "config.syncRemotesFromServer",
    ];
    const hub = { configStore: null };
    for (const m of guardedMethods) {
      const e = reg.get(m);
      expect(e, `${m} が登録されている`).toBeTruthy();
      let err = null;
      try { await e.handler({ hub, daemon, params: { hub3: "h", irType: 0, remote: null, prune: false } }); } catch (ex) { err = ex; }
      expect(err?.kind, `${m} の kind`).toBe("bad_params");
    }
  });
});

describe("SURF-34 (P4-8): events.subscribe/unsubscribe の topics enum schema", () => {
  const reg = buildRegistry();

  // SUBSCRIBABLE_TOPICS の全値が enum に含まれること、かつ enum と SUBSCRIBABLE_TOPICS が一致すること。
  // これにより SDK 生成系が SesameEventTopic union 型 / Literal[] を導出できる。
  it("events.subscribe の topics param に enum schema が付き、SUBSCRIBABLE_TOPICS と一致する", () => {
    const e = reg.get("events.subscribe");
    const topicsParam = e.params.find((p) => p.name === "topics");
    expect(topicsParam, "topics param が存在する").toBeTruthy();
    expect(topicsParam.schema, "schema が付いている").toBeTruthy();
    expect(topicsParam.schema.type).toBe("array");
    expect(topicsParam.schema.items).toBeTruthy();
    expect(topicsParam.schema.items.type).toBe("string");
    // enum が SUBSCRIBABLE_TOPICS と同値であることを全件照合 (規範8)。
    const enumValues = topicsParam.schema.items.enum;
    expect(enumValues).toEqual([...SUBSCRIBABLE_TOPICS]);
  });

  it("events.unsubscribe の topics param に enum schema が付き、SUBSCRIBABLE_TOPICS と一致する", () => {
    const e = reg.get("events.unsubscribe");
    const topicsParam = e.params.find((p) => p.name === "topics");
    expect(topicsParam, "topics param が存在する").toBeTruthy();
    expect(topicsParam.schema, "schema が付いている").toBeTruthy();
    expect(topicsParam.schema.type).toBe("array");
    expect(topicsParam.schema.items).toBeTruthy();
    expect(topicsParam.schema.items.type).toBe("string");
    // enum が SUBSCRIBABLE_TOPICS と同値であることを全件照合 (規範8)。
    const enumValues = topicsParam.schema.items.enum;
    expect(enumValues).toEqual([...SUBSCRIBABLE_TOPICS]);
  });

  it("subscribe / unsubscribe の enum は互いに一致する (対称性)", () => {
    const sub = reg.get("events.subscribe").params.find((p) => p.name === "topics").schema.items.enum;
    const unsub = reg.get("events.unsubscribe").params.find((p) => p.name === "topics").schema.items.enum;
    expect(sub).toEqual(unsub);
  });
});
