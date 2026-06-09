// Daemon + registry の単体テスト (fake hub で、実クラウド非依存)。
import { describe, it, expect, vi } from "vitest";
import { Daemon } from "../../src/serve/daemon.js";
import { buildRegistry } from "../../src/serve/registry.js";
import { KIND } from "../../src/serve/jsonrpc.js";
import { SesameHub3 } from "../../src/client.js";

// ---- 狭いインターフェースの fake hub ----
function makeFakeHub({ connected = true, devices = {} } = {}) {
  const calls = [];
  let duFn = null;
  let duCount = 0;
  const hub = {
    connected,
    subUUID: "sub-1",
    config: { devices },
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    onDeviceUpdate: (items, fn) => { duCount++; duFn = fn; return () => { duFn = null; }; },
    _emit: (msg) => { if (duFn) duFn(msg); },
    get duCount() { return duCount; },
    // top-level
    unlock: vi.fn(async (n) => ({ ok: true, n })),
    lock: vi.fn(async (n) => ({ ok: true, n })),
    unlockDevice: vi.fn(async (p) => ({ ok: true, p })),
    getDeviceStatus: vi.fn(async (u) => ({ uuid: u, locked: true })),
    listDevices: vi.fn(async () => [{ deviceUUID: "u1" }]),
    getLoginUser: vi.fn(async () => ({ companyID: "co" })),
  };
  for (const ns of ["schedule", "org", "company", "access", "iot", "presetir"]) {
    hub[ns] = new Proxy({}, {
      get: (_t, op) => (params) => { calls.push([`${ns}.${String(op)}`, params]); return Promise.resolve({ ns, op: String(op), params }); },
    });
  }
  hub.calls = calls;
  return hub;
}

describe("registry", () => {
  const reg = buildRegistry();
  it("名前空間 op を NAMESPACE_OPS から自動公開", () => {
    expect(reg.has("org.getEmployees")).toBe(true);
    expect(reg.has("iot.setHub3LedDuty")).toBe(true);
    expect(reg.has("access.getCards")).toBe(true);
    expect(reg.has("schedule.getScheduleList")).toBe(true);
    expect(reg.has("company.getCompanies")).toBe(true);
    expect(reg.has("presetir.emitAir")).toBe(true);
  });
  it("トップレベル + events も登録", () => {
    for (const m of ["status", "account.whoami", "lock.unlock", "lock.status", "devices.list", "ir.send", "events.subscribe", "events.unsubscribe"]) {
      expect(reg.has(m)).toBe(true);
    }
  });

  it("drift-guard: 全エントリの委譲先が実 SesameHub3 に存在する", () => {
    const proto = SesameHub3.prototype;
    const has = (n) => Object.getOwnPropertyNames(proto).includes(n);
    // 名前空間 getter
    for (const ns of ["schedule", "org", "company", "access", "iot", "presetir"]) {
      expect(has(ns), `getter ${ns}`).toBe(true);
    }
    // トップレベルが参照するメソッド
    for (const m of ["unlock", "lock", "toggle", "botClick", "unlockDevice", "getDeviceStatus", "listDevices", "getLoginUser", "getDeviceHistory", "getDeviceBattery", "send", "listKeys"]) {
      expect(has(m), `method ${m}`).toBe(true);
    }
  });
});

describe("Daemon dispatch", () => {
  it("rpc.discover は OpenRPC を返し全名前空間 op を列挙", async () => {
    const d = new Daemon({ hub: makeFakeHub(), version: "1.2.3" });
    const doc = await d.invoke("rpc.discover", {}, null);
    expect(doc.openrpc).toBe("1.2.6");
    const names = doc.methods.map((m) => m.name);
    expect(names).toContain("org.getEmployees");
    expect(names).toContain("lock.unlock");
  });

  it("discover が名前空間 op の実 param 型を持つ (.d.ts 抽出が効いている)", async () => {
    const d = new Daemon({ hub: makeFakeHub() });
    const doc = await d.invoke("rpc.discover", {}, null);
    const getCards = doc.methods.find((m) => m.name === "access.getCards");
    const p = Object.fromEntries(getCards.params.map((x) => [x.name, x]));
    expect(p.deviceUUIDs.required).toBe(true);
    expect(p.deviceUUIDs.schema).toEqual({ type: "array", items: { type: "string" } });
    expect(p.timeoutMs.required).toBe(false);
    expect(p.timeoutMs.schema).toEqual({ type: "number" });
    // もう「(params)」プレースホルダではない
    expect(getCards.params.map((x) => x.name)).not.toContain("(params)");
  });

  it("未知 method は method-not-found", async () => {
    const d = new Daemon({ hub: makeFakeHub() });
    await expect(d.invoke("nope.nope", {}, null)).rejects.toMatchObject({ kind: KIND.NOT_IMPLEMENTED });
  });

  it("rpc.* (discover 以外) も method-not-found", async () => {
    const d = new Daemon({ hub: makeFakeHub() });
    await expect(d.invoke("rpc.secret", {}, null)).rejects.toMatchObject({ kind: KIND.NOT_IMPLEMENTED });
  });

  it("status は接続/認証状態 + 契約版を返す", async () => {
    const d = new Daemon({ hub: makeFakeHub({ connected: true }) });
    d.authState = "ok";
    const r = await d.invoke("status", {}, null);
    expect(r).toMatchObject({ connected: true, authState: "ok", subUUID: "sub-1" });
    // 消費者が major 不一致を検知できるよう契約版を毎回返す (SemVer)。
    expect(r.contractVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("discover の info に契約版 (x-contractVersion) が載る", async () => {
    const d = new Daemon({ hub: makeFakeHub() });
    const doc = await d.invoke("rpc.discover", {}, null);
    expect(doc.info["x-contractVersion"]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("status と discover.info が apiVersion (canonical) を返す", async () => {
    const d = new Daemon({ hub: makeFakeHub({ connected: true }) });
    d.authState = "ok";
    const st = await d.invoke("status", {}, null);
    expect(st.apiVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(st.apiVersion).toBe(st.contractVersion); // 別名は同値
    const doc = await d.invoke("rpc.discover", {}, null);
    expect(doc.info["x-apiVersion"]).toBe(doc.info["x-contractVersion"]);
  });

  it("discover の各 method が x-stability/x-provenance を持ち、tier が正しい", async () => {
    const d = new Daemon({ hub: makeFakeHub() });
    const doc = await d.invoke("rpc.discover", {}, null);
    const byName = Object.fromEntries(doc.methods.map((m) => [m.name, m]));
    // stable コア
    for (const n of ["status", "lock.unlock", "devices.list", "events.subscribe"]) {
      expect(byName[n]["x-stability"]).toBe("stable");
      expect(byName[n]["x-provenance"]).toBeTruthy();
    }
    // experimental (未確認群)
    for (const n of ["org.getEmployees", "iot.setHub3LedDuty", "ir.send"]) {
      expect(byName[n]["x-stability"]).toBe("experimental");
    }
    // 全 method が tier を持つ (漏れない)
    for (const m of doc.methods) {
      expect(["stable", "experimental"]).toContain(m["x-stability"]);
    }
  });

  it("x-events も x-stability を持つ (lockState は stable、ready は experimental)", async () => {
    const d = new Daemon({ hub: makeFakeHub() });
    const doc = await d.invoke("rpc.discover", {}, null);
    const ev = Object.fromEntries(doc["x-events"].map((e) => [e.name, e]));
    expect(ev["event.lockState"]["x-stability"]).toBe("stable");
    expect(ev["event.deviceUpdate"]["x-stability"]).toBe("stable");
    // event.ready は全永続接続で発火する local ライフサイクル通知 → stable
    expect(ev["event.ready"]["x-stability"]).toBe("stable");
  });

  it("名前空間 op は hub[ns][op](params) へ委譲", async () => {
    const hub = makeFakeHub();
    const d = new Daemon({ hub }); d.authState = "ok";
    await d.invoke("org.getEmployees", { companyID: "x" }, null);
    expect(hub.calls).toContainEqual(["org.getEmployees", { companyID: "x" }]);
  });

  it("authState=expired ならクラウド op は not_authenticated", async () => {
    const d = new Daemon({ hub: makeFakeHub({ connected: true }) });
    d.authState = "expired";
    await expect(d.invoke("devices.list", {}, null)).rejects.toMatchObject({ kind: KIND.NOT_AUTHENTICATED });
  });

  it("未接続なら connection_lost", async () => {
    const d = new Daemon({ hub: makeFakeHub({ connected: false }) });
    d.authState = "ok";
    await expect(d.invoke("devices.list", {}, null)).rejects.toMatchObject({ kind: KIND.CONNECTION_LOST });
  });
});

describe("Daemon 直列化", () => {
  it("同名メソッドは重ならず順番に実行される", async () => {
    const d = new Daemon({ hub: makeFakeHub() });
    let active = 0, maxActive = 0;
    const slow = () => new Promise((res) => {
      active++; maxActive = Math.max(maxActive, active);
      setTimeout(() => { active--; res(); }, 10);
    });
    await Promise.all([d._serialize("k", slow), d._serialize("k", slow), d._serialize("k", slow)]);
    expect(maxActive).toBe(1); // 並行度 1 に直列化されている
  });
});

describe("Daemon 購読 fan-out", () => {
  function conn() { const sent = []; return { id: Math.random().toString(36), send: (o) => sent.push(o), sent, close() {} }; }

  it("購読 Connection にだけ event.<topic> が届き、ws 購読は client 数不変で 1 本", async () => {
    const hub = makeFakeHub({ devices: { front: { deviceUUID: "u1", deviceModel: "sesame_5" } } });
    const d = new Daemon({ hub });
    const a = conn(), b = conn(), c = conn();
    d.addConnection(a); d.addConnection(b); d.addConnection(c);
    d.subscribe(a, ["lockState"]);
    d.subscribe(b, ["deviceUpdate"]);
    // c は購読しない
    expect(hub.duCount).toBe(1); // 下層購読は 1 本だけ

    // addConnection が各接続へ event.ready を 1 本送るので、購読イベントだけ取り出して検証する。
    const evs = (k) => k.sent.filter((m) => m.method !== "event.ready");
    hub._emit({ data: { deviceUUID: "u1" } });
    expect(evs(a)).toHaveLength(1);
    expect(evs(a)[0]).toMatchObject({ method: "event.lockState" });
    expect(evs(b)).toHaveLength(1);
    expect(evs(b)[0]).toMatchObject({ method: "event.deviceUpdate" });
    expect(evs(c)).toHaveLength(0);
  });

  it("addConnection は永続接続へ event.ready を 1 本送り、ephemeral には送らない", () => {
    const d = new Daemon({ hub: makeFakeHub() });
    const persistent = conn();
    const ephemeral = { id: "e", ephemeral: true, sent: [], send(o) { this.sent.push(o); }, close() {} };
    d.addConnection(persistent);
    d.addConnection(ephemeral);
    expect(persistent.sent).toHaveLength(1);
    expect(persistent.sent[0]).toMatchObject({ method: "event.ready" });
    expect(persistent.sent[0]).not.toHaveProperty("id"); // 通知 (id 無し)
    expect(ephemeral.sent).toHaveLength(0);
  });

  it("全購読解除で下層購読が畳まれる", async () => {
    const hub = makeFakeHub();
    const d = new Daemon({ hub });
    const a = conn(); d.addConnection(a);
    d.subscribe(a, ["lockState"]);
    expect(d._stateUnsub).not.toBeNull();
    d.unsubscribe(a, ["lockState"]);
    expect(d._stateUnsub).toBeNull();
  });

  it("接続切断で購読がクリーンアップされる", async () => {
    const hub = makeFakeHub();
    const d = new Daemon({ hub });
    const a = conn(); d.addConnection(a);
    d.subscribe(a, ["lockState"]);
    d.removeConnection(a);
    expect(d._stateUnsub).toBeNull();
    // 切断後の emit は誰にも届かない (例外も出ない)
    expect(() => hub._emit({ data: { deviceUUID: "u1" } })).not.toThrow();
  });
});

describe("Daemon shutdown", () => {
  it("冪等で hub.close を呼ぶ", async () => {
    const hub = makeFakeHub();
    const d = new Daemon({ hub });
    await d.shutdown();
    await d.shutdown();
    expect(hub.close).toHaveBeenCalledTimes(1);
  });
});
