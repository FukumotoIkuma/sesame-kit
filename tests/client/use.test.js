// Unit tests for SesameHub3.use() (static helper).
//
// Strategy:
//   - 実 WebSocketServer({port: 0}) を立てて、connect → fn → close まで実コードを動かす。
//     ws の生 connect/close ライフサイクルは tests/transport で別途検証済みなので、
//     ここでは use() の「引数判別 / fromConfig スキップ / 例外伝播 / cleanup 確実性」に集中。
//   - tokenStore は最小限の fake (load() のみ実装)。idToken は jwtExp/jwtSub が読める形に
//     エンコードした JWT 文字列 (exp 十分先) で、Cognito refresh 経路には絶対入らない。
//   - 実 fs に触らない: opts.tokenStore + opts.config を渡して fromConfig をスキップ。
//   - fromConfig 経路は vi.spyOn(SesameHub3, "fromConfig") で差し替えて確認 (実 fs を読まない)。
//   - _pendingCleanups: close() で flush される事を、テストから手動で関数を add して確認する
//     (実コード側の onIRLearned 等の挙動は別関数のテストに譲る)。
//   - WebSocket 接続を 1 回 / fn 戻り値 / fn throw 時の cleanup を全て独立 it で検証。
//   - 並行性: 2 つの use() を同時に走らせても server に独立した 2 本の接続が張られる事。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocketServer } from "ws";
import { SesameHub3 } from "../../src/client.js";
import { CONSUMER_CLIENT_ID } from "../../src/auth.js";

const CONFIRMED_DEVICE = {
  deviceKey: "dev-key-abc",
  deviceGroupKey: "dev-group-abc",
  devicePassword: "dev-password-abc",
};

/** @type {WebSocketServer | null} */
let server = null;
/** @type {number} */
let port = 0;
/** ephemeral server 起動数を増やしたい時用 */
const createdServers = [];

function startServer(onConnection) {
  return new Promise((resolve) => {
    const s = new WebSocketServer({ port: 0 });
    createdServers.push(s);
    s.on("listening", () => {
      resolve({ server: s, port: s.address().port });
    });
    if (onConnection) s.on("connection", onConnection);
  });
}

/**
 * Cognito refresh 経路を avoid するため、exp が十分未来な idToken (JWT) を作る。
 * sub は "test-sub-uuid"。署名は検証しないので適当でよい。
 */
function makeIdToken({ sub = "test-sub-uuid", expOffsetSec = 60 * 60 } = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64");
  const exp = Math.floor(Date.now() / 1000) + expOffsetSec;
  const payload = Buffer.from(JSON.stringify({ aud: CONSUMER_CLIENT_ID, sub, exp })).toString("base64");
  return `${header}.${payload}.sig`;
}

/** 最小 tokenStore (load のみ実装)。getValidIdToken が呼ぶのは load()。 */
function makeTokenStore(overrides = {}) {
  const idToken = overrides.idToken ?? makeIdToken();
  return {
    load: vi.fn(() => ({ idToken, refreshToken: "r", clientId: CONSUMER_CLIENT_ID, ...CONFIRMED_DEVICE, ...overrides.extra })),
    save: vi.fn(),
    clear: vi.fn(),
  };
}

function makeConfig() {
  return {
    wsUrl: `ws://127.0.0.1:${port}`,
    companyID: "test-co",
    lang: "ja",
    default: { remote: null, lock: null },
    hub3s: {},
    remotes: {},
    locks: {},
  };
}

beforeEach(async () => {
  const started = await startServer();
  server = started.server;
  port = started.port;
});

afterEach(async () => {
  // 立てた全 server を撤収
  for (const s of createdServers) {
    try { await new Promise((res) => s.close(() => res())); } catch { /* ignore */ }
  }
  createdServers.length = 0;
  server = null;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("SesameHub3.use() — 引数判別", () => {
  it("use(fn) 形: 第一引数が関数なら fn として扱い、opts は空", async () => {
    // fromConfig をスタブして実 fs アクセスを完全に遮断
    const tokenStore = makeTokenStore();
    const config = makeConfig();
    const fromConfigSpy = vi
      .spyOn(SesameHub3, "fromConfig")
      .mockImplementation(async (opts) => new SesameHub3({ config, tokenStore, debug: !!opts?.debug }));

    const fn = vi.fn(async (hub) => {
      expect(hub).toBeInstanceOf(SesameHub3);
      return "ok";
    });
    const ret = await SesameHub3.use(fn);
    expect(ret).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fromConfigSpy).toHaveBeenCalledTimes(1);
    // opts が無いので fromConfig は空 object もしくは undefined で呼ばれる
    expect(fromConfigSpy.mock.calls[0][0]).toEqual({});
  });

  it("use(opts, fn) 形: tokenStore+config が両方あれば fromConfig は呼ばない", async () => {
    const fromConfigSpy = vi.spyOn(SesameHub3, "fromConfig");
    const tokenStore = makeTokenStore();
    const config = makeConfig();

    const fn = vi.fn(async () => "via-opts");
    const ret = await SesameHub3.use({ tokenStore, config }, fn);
    expect(ret).toBe("via-opts");
    expect(fromConfigSpy).not.toHaveBeenCalled();
  });

  it("use(opts, fn) 形: tokenStore 単独 (config なし) では fromConfig 経路に落ちる", async () => {
    const tokenStore = makeTokenStore();
    const config = makeConfig();
    const fromConfigSpy = vi
      .spyOn(SesameHub3, "fromConfig")
      .mockImplementation(async () => new SesameHub3({ config, tokenStore }));

    await SesameHub3.use({ tokenStore /* no config */ }, async () => undefined);
    expect(fromConfigSpy).toHaveBeenCalledTimes(1);
    // 渡した opts (tokenStore 等) はそのまま fromConfig に転送される
    expect(fromConfigSpy.mock.calls[0][0]).toMatchObject({ tokenStore });
  });

  it("use(opts, fn) 形: config 単独 (tokenStore なし) でも fromConfig 経路に落ちる", async () => {
    const tokenStore = makeTokenStore();
    const config = makeConfig();
    const fromConfigSpy = vi
      .spyOn(SesameHub3, "fromConfig")
      .mockImplementation(async () => new SesameHub3({ config, tokenStore }));

    await SesameHub3.use({ config /* no tokenStore */ }, async () => undefined);
    expect(fromConfigSpy).toHaveBeenCalledTimes(1);
  });

  it("fn が関数でないと throw (use(opts) で fn 省略)", async () => {
    await expect(SesameHub3.use({})).rejects.toThrow(/usage: SesameHub3\.use/);
  });

  it("fn が関数でないと throw (use(opts, notFn))", async () => {
    await expect(SesameHub3.use({}, "not a function")).rejects.toThrow(/usage: SesameHub3\.use/);
  });

  it("fn が関数でないと throw (use(null) — opts も fn も無効)", async () => {
    await expect(SesameHub3.use(null)).rejects.toThrow(/usage: SesameHub3\.use/);
  });

  it("fn が関数でないと throw (use(undefined))", async () => {
    await expect(SesameHub3.use(undefined)).rejects.toThrow(/usage: SesameHub3\.use/);
  });

  it("fromConfigSpy を介さず fn だけ非関数のケース (use(opts, fn=number))", async () => {
    const tokenStore = makeTokenStore();
    const config = makeConfig();
    // tokenStore+config 経路でも、fn が壊れていれば connect 前に throw
    await expect(SesameHub3.use({ tokenStore, config }, 42)).rejects.toThrow(/usage: SesameHub3\.use/);
  });
});

describe("SesameHub3.use() — fn 実行 / 戻り値 / 例外伝播", () => {
  it("fn の戻り値をそのまま resolve する", async () => {
    const tokenStore = makeTokenStore();
    const config = makeConfig();
    const ret = await SesameHub3.use({ tokenStore, config }, async () => ({ k: 1 }));
    expect(ret).toEqual({ k: 1 });
  });

  it("fn 内で throw された Error はそのまま伝播する", async () => {
    const tokenStore = makeTokenStore();
    const config = makeConfig();
    const boom = new Error("boom!");
    await expect(
      SesameHub3.use({ tokenStore, config }, async () => { throw boom; }),
    ).rejects.toBe(boom);
  });

  it("fn 内 throw でも finally で hub.close() が走り、サーバ側で disconnect される", async () => {
    // server 側で connection を観察
    await new Promise((res) => server.close(() => res()));
    let opened = 0;
    let closed = 0;
    const closePromises = [];
    const started = await startServer((ws) => {
      opened++;
      closePromises.push(new Promise((res) => ws.on("close", () => { closed++; res(); })));
    });
    server = started.server;
    port = started.port;

    const tokenStore = makeTokenStore();
    const config = makeConfig();
    await expect(
      SesameHub3.use({ tokenStore, config }, async () => { throw new Error("err"); }),
    ).rejects.toThrow("err");

    // server 側の close event を待つ (close は async)
    await Promise.all(closePromises);
    expect(opened).toBe(1);
    expect(closed).toBe(1);
  });

  it("fn 同期 throw でも finally で close される", async () => {
    const tokenStore = makeTokenStore();
    const config = makeConfig();
    // async function 内の synchronous throw も Promise reject になる
    await expect(
      SesameHub3.use({ tokenStore, config }, () => { throw new Error("sync-boom"); }),
    ).rejects.toThrow("sync-boom");
  });

  it("fn の中で hub.connected === true になっている", async () => {
    const tokenStore = makeTokenStore();
    const config = makeConfig();
    let observedConnected = null;
    await SesameHub3.use({ tokenStore, config }, async (hub) => {
      observedConnected = hub.connected;
    });
    expect(observedConnected).toBe(true);
  });

  it("use() 完了後 hub は close されている (fn から漏れた hub の connected が false)", async () => {
    const tokenStore = makeTokenStore();
    const config = makeConfig();
    let leaked = null;
    await SesameHub3.use({ tokenStore, config }, async (hub) => {
      leaked = hub;
      expect(hub.connected).toBe(true);
    });
    expect(leaked).not.toBeNull();
    expect(leaked.connected).toBe(false);
  });
});

describe("SesameHub3.use() — config マージ / debug 転送", () => {
  it("opts.config は DEFAULT_CONFIG とマージされる (companyID 上書きが効く)", async () => {
    const tokenStore = makeTokenStore();
    const partialConfig = {
      wsUrl: `ws://127.0.0.1:${port}`,
      companyID: "override-co",
    };
    let observed;
    await SesameHub3.use({ tokenStore, config: partialConfig }, async (hub) => {
      observed = hub.config;
    });
    expect(observed.companyID).toBe("override-co");
    // DEFAULT_CONFIG 由来の lang などが残っている
    expect(observed.lang).toBe("ja");
    // DEFAULT_CONFIG の default も保持
    expect(observed.default).toEqual({ remote: null, lock: null });
  });

  it("opts.debug が true なら hub._debug=true", async () => {
    const tokenStore = makeTokenStore();
    const config = makeConfig();
    let observedDebug;
    await SesameHub3.use({ tokenStore, config, debug: true }, async (hub) => {
      observedDebug = hub._debug;
    });
    expect(observedDebug).toBe(true);
  });

  it("opts.debug 未指定なら false に正規化される", async () => {
    const tokenStore = makeTokenStore();
    const config = makeConfig();
    let observedDebug;
    await SesameHub3.use({ tokenStore, config }, async (hub) => {
      observedDebug = hub._debug;
    });
    expect(observedDebug).toBe(false);
  });

  it("opts.configStore を渡せば hub.configStore に反映される", async () => {
    const tokenStore = makeTokenStore();
    const config = makeConfig();
    const configStore = { resolveRemote: vi.fn(), load: vi.fn(), updateRemoteKeys: vi.fn() };
    let observed;
    await SesameHub3.use({ tokenStore, config, configStore }, async (hub) => {
      observed = hub.configStore;
    });
    expect(observed).toBe(configStore);
  });

  it("opts.configStore 未指定なら hub.configStore は null", async () => {
    const tokenStore = makeTokenStore();
    const config = makeConfig();
    let observed = "unset";
    await SesameHub3.use({ tokenStore, config }, async (hub) => {
      observed = hub.configStore;
    });
    expect(observed).toBeNull();
  });
});

describe("SesameHub3.use() — connect 失敗時の挙動", () => {
  it("connect() が失敗すると fn は呼ばれず、エラーが伝播する", async () => {
    // server を落としてから use() を呼ぶ → connect で reject
    await new Promise((res) => server.close(() => res()));
    const tokenStore = makeTokenStore();
    const config = makeConfig(); // 既に落ちた port を指す

    const fn = vi.fn();
    await expect(SesameHub3.use({ tokenStore, config }, fn)).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });

  it("tokenStore.load() が null を返すと getValidIdToken が throw し、fn は呼ばれない", async () => {
    const tokenStore = { load: vi.fn(() => null), save: vi.fn(), clear: vi.fn() };
    const config = makeConfig();
    const fn = vi.fn();
    await expect(SesameHub3.use({ tokenStore, config }, fn)).rejects.toThrow(/No tokens stored/);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("SesameHub3.use() — _pendingCleanups の flush", () => {
  it("fn 内で _pendingCleanups.add した async fn が close() 時に呼ばれる", async () => {
    const tokenStore = makeTokenStore();
    const config = makeConfig();
    const cleanupFn = vi.fn(async () => {});
    await SesameHub3.use({ tokenStore, config }, async (hub) => {
      hub._pendingCleanups.add(cleanupFn);
      expect(hub._pendingCleanups.size).toBe(1);
    });
    expect(cleanupFn).toHaveBeenCalledTimes(1);
  });

  it("複数の cleanup を全て待ってから close する (Promise.allSettled)", async () => {
    const tokenStore = makeTokenStore();
    const config = makeConfig();
    const order = [];
    const a = vi.fn(async () => { order.push("a"); });
    const b = vi.fn(async () => { order.push("b"); });
    await SesameHub3.use({ tokenStore, config }, async (hub) => {
      hub._pendingCleanups.add(a);
      hub._pendingCleanups.add(b);
    });
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
    expect(order.sort()).toEqual(["a", "b"]);
  });

  it("cleanup の一つが reject しても残りは実行され、use() 全体は正常終了", async () => {
    const tokenStore = makeTokenStore();
    const config = makeConfig();
    const good = vi.fn(async () => {});
    const bad = vi.fn(async () => { throw new Error("cleanup-fail"); });
    // close() は Promise.allSettled なので throw は呑まれる
    await expect(
      SesameHub3.use({ tokenStore, config }, async (hub) => {
        hub._pendingCleanups.add(bad);
        hub._pendingCleanups.add(good);
        return "done";
      }),
    ).resolves.toBe("done");
    expect(good).toHaveBeenCalled();
    expect(bad).toHaveBeenCalled();
  });

  it("close() 後 _pendingCleanups は空になっている", async () => {
    const tokenStore = makeTokenStore();
    const config = makeConfig();
    let hubRef = null;
    await SesameHub3.use({ tokenStore, config }, async (hub) => {
      hub._pendingCleanups.add(async () => {});
      hubRef = hub;
    });
    expect(hubRef._pendingCleanups.size).toBe(0);
  });
});

describe("SesameHub3.use() — 並行 / 多重呼び出し", () => {
  it("2 並列で use() を呼ぶと server 側に 2 本独立した connection が張られる", async () => {
    await new Promise((res) => server.close(() => res()));
    let opened = 0;
    const started = await startServer(() => { opened++; });
    server = started.server;
    port = started.port;

    const tokenStore = makeTokenStore();
    const config = makeConfig();

    let mid1, mid2;
    const p1 = SesameHub3.use({ tokenStore, config }, async (hub) => {
      mid1 = hub.connected;
      // 短い待ちで並列性を確保
      await new Promise((r) => setTimeout(r, 20));
      return 1;
    });
    const p2 = SesameHub3.use({ tokenStore, config }, async (hub) => {
      mid2 = hub.connected;
      await new Promise((r) => setTimeout(r, 20));
      return 2;
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(1);
    expect(r2).toBe(2);
    expect(mid1).toBe(true);
    expect(mid2).toBe(true);
    expect(opened).toBe(2);
  });

  it("連続して use() を呼んでも毎回新しい hub を作って connect/close する", async () => {
    await new Promise((res) => server.close(() => res()));
    let opened = 0;
    const started = await startServer(() => { opened++; });
    server = started.server;
    port = started.port;

    const tokenStore = makeTokenStore();
    const config = makeConfig();

    await SesameHub3.use({ tokenStore, config }, async () => undefined);
    await SesameHub3.use({ tokenStore, config }, async () => undefined);
    await SesameHub3.use({ tokenStore, config }, async () => undefined);
    expect(opened).toBe(3);
  });
});

describe("SesameHub3.use() — 引数判別の境界ケース", () => {
  it("空 object と function (use({}, fn)) の組: fromConfig 経路に落ちる (tokenStore も config も無いため)", async () => {
    const tokenStore = makeTokenStore();
    const config = makeConfig();
    const fromConfigSpy = vi
      .spyOn(SesameHub3, "fromConfig")
      .mockImplementation(async () => new SesameHub3({ config, tokenStore }));

    await SesameHub3.use({}, async () => undefined);
    expect(fromConfigSpy).toHaveBeenCalledTimes(1);
    expect(fromConfigSpy.mock.calls[0][0]).toEqual({});
  });

  it("use(fn) で fn が同期関数でも resolve される", async () => {
    const tokenStore = makeTokenStore();
    const config = makeConfig();
    vi.spyOn(SesameHub3, "fromConfig")
      .mockImplementation(async () => new SesameHub3({ config, tokenStore }));

    const ret = await SesameHub3.use((hub) => {
      expect(hub).toBeInstanceOf(SesameHub3);
      return "sync-ret";
    });
    expect(ret).toBe("sync-ret");
  });
});
