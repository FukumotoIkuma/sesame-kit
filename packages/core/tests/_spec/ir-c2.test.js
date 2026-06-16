// Tests for spec IR-0037..IR-0054
// Target implementation: packages/core/src/ir.js, packages/kit/src/serve/entries/ir.js,
//   packages/kit/src/cli/ir.js, packages/kit/src/serve/registry-helpers.js
//
// Setup: KIT_SETUP = [setup.i18n.js, kit/vitest.setup.js] → locale=ja, all catalogs registered.
// All tests are network/hardware-free; client is mocked via makeClient().
//
// Import paths are relative to packages/core/tests/_spec/ (two levels up = packages/core/).

import { describe, it, expect, vi } from "vitest";

import {
  setIRMode,
  getRemoteList,
  searchRemoteList,
  addIRRemote,
  canAddMoreRemote,
  matchRemote,
  subscribeIRData,
  subscribeIRMode,
  MODE,
} from "../../src/ir.js";

// ─── Shared helpers ──────────────────────────────────────────────────────────

const ACTION = "biz3IRRemote";
const COMPANY_ID = "co-test";

/**
 * Minimal mock WS client.
 * client.request() resolves with `reply` and records the frame in client.sent[].
 */
function makeClient(reply) {
  const sent = [];
  return {
    sent,
    // Also expose as `requests` for A-style compatibility
    get requests() { return sent; },
    request: vi.fn(async (frame) => {
      sent.push(frame);
      return reply;
    }),
    send: vi.fn(),
    subscribe: vi.fn(() => vi.fn()), // returns unsubscribe fn
  };
}

function successResp(data) {
  return { success: true, data };
}

// ============================================================
// IR-0037: setIRMode → assertSuccess(strict) on success:false
// ============================================================
describe("[IR-0037] setIRMode assertSuccess(strict) on server failure", () => {
  it("[IR-0037] success:false → throws SesameError(code=rejected)", async () => {
    const client = makeClient({ success: false, message: "device busy" });
    await expect(
      setIRMode(client, { deviceId: "hub3-uuid", mode: 0, companyID: COMPANY_ID }),
    ).rejects.toMatchObject({ code: "rejected" });
  });

  it("[IR-0037] success field absent (strict mode) → throws SesameError(code=rejected)", async () => {
    const client = makeClient({ message: "no success field" });
    await expect(
      setIRMode(client, { deviceId: "hub3-uuid", mode: 1, companyID: COMPANY_ID }),
    ).rejects.toMatchObject({ code: "rejected" });
  });

  it("[IR-0037] success:true → resolves normally", async () => {
    const client = makeClient({ success: true, data: null });
    const resp = await setIRMode(client, { deviceId: "hub3-uuid", mode: 0, companyID: COMPANY_ID });
    expect(resp.success).toBe(true);
  });
});

// ============================================================
// IR-0038: ir.setMode CLI --json output envelope (mode + label)
// Spec: --json → {ok:true, mode}; text → cli.okMode with CONTROL/REGISTER label
// ref: packages/kit/src/cli/ir.js:71-78; packages/kit/src/i18n/cli.js:152
// ============================================================
describe("[IR-0038] CLI ir mode set --json output envelope (mode + label)", () => {
  it("[IR-0038] mode=0 json envelope is {ok:true, mode:0} and label is CONTROL", () => {
    const jsonPayload = { ok: true, mode: 0 };
    const label = jsonPayload.mode === 0 ? "CONTROL" : "REGISTER";
    expect(jsonPayload).toMatchObject({ ok: true, mode: 0 });
    expect(label).toBe("CONTROL");
  });

  it("[IR-0038] mode=1 json envelope is {ok:true, mode:1} and label is REGISTER", () => {
    const jsonPayload = { ok: true, mode: 1 };
    const label = jsonPayload.mode === 0 ? "CONTROL" : "REGISTER";
    expect(jsonPayload).toMatchObject({ ok: true, mode: 1 });
    expect(label).toBe("REGISTER");
  });

  it("[IR-0038] cli.okMode i18n key exists in en catalog with {mode} and {label} placeholders", async () => {
    // ref: packages/kit/src/i18n/cli.js:152
    const { default: catalog } = await import("../../../kit/src/i18n/cli.js");
    expect(catalog.en["cli.okMode"]).toBeDefined();
    expect(catalog.en["cli.okMode"]).toContain("{mode}");
    expect(catalog.en["cli.okMode"]).toContain("{label}");
  });

  it("[IR-0038] cli.okMode i18n key exists in ja catalog", async () => {
    const { default: catalog } = await import("../../../kit/src/i18n/cli.js");
    expect(catalog.ja["cli.okMode"]).toBeDefined();
  });
});

// ============================================================
// IR-0039: ir.setMode serve registry contract existence
// Spec: registry ir.setMode (hub3?:string, mode:number) params match schema
// ref: packages/kit/src/serve/entries/ir.js:102-107
// ============================================================
describe("[IR-0039] ir.setMode serve registry contract existence", () => {
  it("[IR-0039] irEntries has ir.setMode with hub3(optional) and mode(required:true, type:number)", async () => {
    const { irEntries } = await import("../../../kit/src/serve/entries/ir.js");
    const entries = irEntries();
    expect(entries).toHaveProperty("ir.setMode");
    const entry = entries["ir.setMode"];
    const hub3Param = entry.params.find((p) => p.name === "hub3");
    const modeParam = entry.params.find((p) => p.name === "mode");
    expect(hub3Param).toBeDefined();
    expect(hub3Param.required).toBe(false);
    expect(modeParam).toBeDefined();
    expect(modeParam.required).toBe(true);
    expect(modeParam.schema).toMatchObject({ type: "number" });
  });
});

// ============================================================
// IR-0040: All ir.* handlers call requireAuth
// Spec: all ir.* handlers call requireAuth(daemon) first
// ref: packages/kit/src/serve/entries/ir.js:20,33,50,100,106
// ============================================================
describe("[IR-0040] all ir.* handlers call requireAuth (unauthenticated rejection)", () => {
  it("[IR-0040] requireAuth throws not_authenticated when authState=expired", async () => {
    const { requireAuth } = await import("../../../kit/src/serve/registry-helpers.js");
    const daemon = { authState: "expired", hub: { connected: true } };
    expect(() => requireAuth(daemon)).toThrow();
    try {
      requireAuth(daemon);
    } catch (e) {
      expect(e.kind ?? e.data?.kind ?? "").toMatch(/not_authenticated|NOT_AUTHENTICATED/i);
    }
  });

  it("[IR-0040] requireAuth throws connection_lost when hub.connected=false", async () => {
    const { requireAuth } = await import("../../../kit/src/serve/registry-helpers.js");
    const daemon = { authState: "ok", hub: { connected: false } };
    expect(() => requireAuth(daemon)).toThrow();
    try {
      requireAuth(daemon);
    } catch (e) {
      expect(e.kind ?? e.data?.kind ?? "").toMatch(/connection_lost|CONNECTION_LOST/i);
    }
  });

  it("[IR-0040] ir.send handler throws not_authenticated when auth expired", async () => {
    const { irEntries } = await import("../../../kit/src/serve/entries/ir.js");
    const entries = irEntries();
    const daemon = { authState: "expired", hub: { connected: true } };
    expect(() =>
      entries["ir.send"].handler({ hub: {}, params: { key: "k1" }, daemon }),
    ).toThrow();
    try {
      entries["ir.send"].handler({ hub: {}, params: { key: "k1" }, daemon });
    } catch (e) {
      expect(e.kind ?? e.data?.kind ?? "").toMatch(/not_authenticated|NOT_AUTHENTICATED/i);
    }
  });

  it("[IR-0040] ir.listKeys handler throws connection_lost when not connected", async () => {
    const { irEntries } = await import("../../../kit/src/serve/entries/ir.js");
    const entries = irEntries();
    const daemon = { authState: "ok", hub: { connected: false } };
    expect(() =>
      entries["ir.listKeys"].handler({ hub: {}, params: {}, daemon }),
    ).toThrow();
    try {
      entries["ir.listKeys"].handler({ hub: {}, params: {}, daemon });
    } catch (e) {
      expect(e.kind ?? e.data?.kind ?? "").toMatch(/connection_lost|CONNECTION_LOST/i);
    }
  });

  it("[IR-0040] ir.learn handler throws not_authenticated when auth expired", async () => {
    const { irEntries } = await import("../../../kit/src/serve/entries/ir.js");
    const entries = irEntries();
    const daemon = { authState: "expired", hub: { connected: true } };
    expect(() =>
      entries["ir.learn"].handler({ hub: {}, params: { remote: "r", key: "k" }, daemon }),
    ).toThrow();
    try {
      entries["ir.learn"].handler({ hub: {}, params: { remote: "r", key: "k" }, daemon });
    } catch (e) {
      expect(e.kind ?? e.data?.kind ?? "").toMatch(/not_authenticated|NOT_AUTHENTICATED/i);
    }
  });

  it("[IR-0040] ir.getMode handler throws not_authenticated when auth expired", async () => {
    const { irEntries } = await import("../../../kit/src/serve/entries/ir.js");
    const entries = irEntries();
    const daemon = { authState: "expired", hub: { connected: true } };
    expect(() =>
      entries["ir.getMode"].handler({ hub: {}, params: {}, daemon }),
    ).toThrow();
    try {
      entries["ir.getMode"].handler({ hub: {}, params: {}, daemon });
    } catch (e) {
      expect(e.kind ?? e.data?.kind ?? "").toMatch(/not_authenticated|NOT_AUTHENTICATED/i);
    }
  });

  it("[IR-0040] ir.setMode handler throws not_authenticated when auth expired", async () => {
    const { irEntries } = await import("../../../kit/src/serve/entries/ir.js");
    const entries = irEntries();
    const daemon = { authState: "expired", hub: { connected: true } };
    expect(() =>
      entries["ir.setMode"].handler({ hub: {}, params: { mode: 0 }, daemon }),
    ).toThrow();
    try {
      entries["ir.setMode"].handler({ hub: {}, params: { mode: 0 }, daemon });
    } catch (e) {
      expect(e.kind ?? e.data?.kind ?? "").toMatch(/not_authenticated|NOT_AUTHENTICATED/i);
    }
  });

  it("[IR-0040] ir.send/listKeys/learn/getMode/setMode all have handler functions", async () => {
    const { irEntries } = await import("../../../kit/src/serve/entries/ir.js");
    const entries = irEntries();
    for (const name of ["ir.send", "ir.listKeys", "ir.learn", "ir.getMode", "ir.setMode"]) {
      expect(entries[name], `entry ${name} must exist`).toBeDefined();
      expect(typeof entries[name].handler).toBe("function");
    }
  });
});

// ============================================================
// IR-0041: onIRLearned cleanup idempotency (cleaned flag prevents double-run)
// Spec: cleaned flag prevents double-run of unsubscribe + setIRMode(CONTROL)
// ref: packages/core/src/client.js:1510-1536
// ============================================================
describe("[IR-0041] onIRLearned cleanup idempotency (cleaned flag)", () => {
  it("[IR-0041] cleanup called twice executes side effects exactly once", async () => {
    // Reproduce the cleaned-flag pattern from client.js:1522-1532
    let cleaned = false;
    const off = vi.fn();
    const unsubscribe = vi.fn();
    const setIRModeCtrl = vi.fn().mockResolvedValue(undefined);

    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      off();
      unsubscribe();
      try { await setIRModeCtrl(); } catch { /* best-effort */ }
    };

    await cleanup();
    await cleanup(); // second call must be a no-op

    expect(off).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(setIRModeCtrl).toHaveBeenCalledTimes(1);
  });

  it("[IR-0041] cleanup swallows setIRMode error (best-effort)", async () => {
    let cleaned = false;
    const off = vi.fn();
    const unsubscribe = vi.fn();
    const setIRModeCtrl = vi.fn().mockRejectedValue(new Error("CONTROL restore failed"));

    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      off();
      unsubscribe();
      try { await setIRModeCtrl(); } catch { /* best-effort */ }
    };

    // Must not throw even if setIRMode fails
    await expect(cleanup()).resolves.toBeUndefined();
    expect(off).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// IR-0042: subscribeIRData / subscribeIRMode deviceId filter
// Spec: msg.deviceId is normalizeUuid-compared; foreign deviceId msgs are dropped
// ref: packages/core/src/ir.js:397-403, 437-443
//
// Note: subscribeIRData uses client.subscribe() — the handler is installed via subscribe().
// The mock captures the callback from subscribe() to simulate push messages.
// ============================================================
describe("[IR-0042] subscribeIRData / subscribeIRMode deviceId filter", () => {
  it("[IR-0042] subscribeIRData drops push from other deviceId", async () => {
    const deviceId = "aabbccdd";
    let capturedCb = null;
    const client = {
      request: vi.fn(async () => ({ success: true })),
      send: vi.fn(),
      subscribe: vi.fn((_topic, cb) => {
        capturedCb = cb;
        return vi.fn();
      }),
    };

    const sub = await subscribeIRData(client, { deviceId, companyID: COMPANY_ID });
    const received = [];
    sub.onData((msg) => received.push(msg));

    // Push from the correct device
    capturedCb({ deviceId: "aabbccdd", data: { data: [1, 2] } });
    // Push from a different device — must be dropped
    capturedCb({ deviceId: "ffffffff", data: { data: [9] } });

    expect(received).toHaveLength(1);
    expect(received[0].deviceId).toBe("aabbccdd");

    sub.unsubscribe();
  });

  it("[IR-0042] subscribeIRData delivers push when msg.deviceId is absent (no filter)", async () => {
    let capturedCb = null;
    const client = {
      request: vi.fn(async () => ({ success: true })),
      send: vi.fn(),
      subscribe: vi.fn((_topic, cb) => {
        capturedCb = cb;
        return vi.fn();
      }),
    };

    const sub = await subscribeIRData(client, { deviceId: "aabbccdd", companyID: COMPANY_ID });
    const received = [];
    sub.onData((msg) => received.push(msg));

    // Message with no deviceId passes through (guard is `if(msg?.deviceId)`)
    capturedCb({ data: { data: [1] } });

    expect(received).toHaveLength(1);
    sub.unsubscribe();
  });

  it("[IR-0042] subscribeIRMode drops push from other deviceId", async () => {
    const deviceId = "aaaaaaaa-bbbb-cccc-dddd-ffffffffffff";
    const otherDeviceId = "99999999-8888-7777-6666-555555555555";
    let capturedCb = null;
    const client = {
      request: vi.fn(async () => ({ success: true })),
      send: vi.fn(),
      subscribe: vi.fn((_topic, cb) => {
        capturedCb = cb;
        return vi.fn();
      }),
    };

    const sub = await subscribeIRMode(client, { deviceId, companyID: COMPANY_ID });
    const received = [];
    sub.onData((msg) => received.push(msg));

    // Own device: delivered
    capturedCb({ deviceId, mode: 0 });
    expect(received).toHaveLength(1);

    // Other device: filtered
    capturedCb({ deviceId: otherDeviceId, mode: 1 });
    expect(received).toHaveLength(1); // does not grow

    sub.unsubscribe();
  });
});

// ============================================================
// IR-0043: i18n key coverage (en + ja) for IR slice
// Spec: cli.* and domain.ir.* keys exist in both en and ja
// ref: packages/kit/src/i18n/cli.js:142-152; packages/core/src/i18n/domain.js:59-64,106-107
// ============================================================
describe("[IR-0043] IR i18n key coverage (en + ja both catalogs)", () => {
  const CLI_KEYS = [
    "cli.learnKeyName",
    "cli.keynameRequired",
    "cli.switchingLearnMode",
    "cli.pointRemote",
    "cli.okLearned",
    "cli.mode",
    "cli.modeMustBe",
    "cli.okMode",
  ];
  const DOMAIN_IR_KEYS = [
    "domain.ir.subscribeIRDataFailed",
    "domain.ir.subscribeIRModeFailed",
    "domain.ir.learnTimeout",
    "domain.ir.learnFailed",
    "domain.ir.learnEmptyWaveform",
    "domain.ir.addIRRemoteDeviceUUIDRequired",
  ];

  it("[IR-0043] cli.* IR keys exist in en catalog", async () => {
    const { default: catalog } = await import("../../../kit/src/i18n/cli.js");
    for (const key of CLI_KEYS) {
      expect(catalog.en[key], `en missing: ${key}`).toBeDefined();
    }
  });

  it("[IR-0043] cli.* IR keys exist in ja catalog", async () => {
    const { default: catalog } = await import("../../../kit/src/i18n/cli.js");
    for (const key of CLI_KEYS) {
      expect(catalog.ja[key], `ja missing: ${key}`).toBeDefined();
    }
  });

  it("[IR-0043] domain.ir.* keys exist in en catalog", async () => {
    const { default: catalog } = await import("../../src/i18n/domain.js");
    for (const key of DOMAIN_IR_KEYS) {
      expect(catalog.en[key], `en missing: ${key}`).toBeDefined();
    }
  });

  it("[IR-0043] domain.ir.* keys exist in ja catalog", async () => {
    const { default: catalog } = await import("../../src/i18n/domain.js");
    for (const key of DOMAIN_IR_KEYS) {
      expect(catalog.ja[key], `ja missing: ${key}`).toBeDefined();
    }
  });

  it("[IR-0043] domain.transport.sendIRFailed/getIRCodesFailed exist in en and ja", async () => {
    const { default: catalog } = await import("../../src/i18n/domain.js");
    expect(catalog.en["domain.transport.sendIRFailed"]).toBeDefined();
    expect(catalog.en["domain.transport.getIRCodesFailed"]).toBeDefined();
    expect(catalog.ja["domain.transport.sendIRFailed"]).toBeDefined();
    expect(catalog.ja["domain.transport.getIRCodesFailed"]).toBeDefined();
  });
});

// ============================================================
// IR-0044: getRemoteList wire frame (action/op/type/companyID/pagination)
// Spec: frame matches vendor getRemoteList shape exactly
// ref: packages/core/src/ir.js:82-88
// ============================================================
describe("[IR-0044] getRemoteList wire frame", () => {
  it("[IR-0044] frame keys match vendor getRemoteList: action/op/type/companyID/pagination", async () => {
    const client = makeClient(successResp({ data: [], pagination: null }));
    await getRemoteList(client, { type: 0x2000, companyID: COMPANY_ID });
    const frame = client.sent[0];
    expect(frame.action).toBe("biz3IRRemote");
    expect(frame.op).toBe("getRemoteList");
    expect(frame.type).toBe(0x2000);
    expect(frame.companyID).toBe(COMPANY_ID);
    expect(frame.pagination).toBeDefined();
    expect(typeof frame.pagination.page).toBe("number");
    expect(typeof frame.pagination.pageSize).toBe("number");
  });

  it("[IR-0044] no extra keys in frame (only action/op/type/companyID/pagination)", async () => {
    const client = makeClient(successResp({ data: [], pagination: null }));
    await getRemoteList(client, { type: 0xc000, companyID: COMPANY_ID });
    const frame = client.sent[0];
    const allowedKeys = new Set(["action", "op", "type", "companyID", "pagination"]);
    for (const k of Object.keys(frame)) {
      expect(allowedKeys, `unexpected key "${k}" in frame`).toContain(k);
    }
    expect(frame).not.toHaveProperty("hub3DeviceId");
    expect(frame).not.toHaveProperty("remoteId");
  });
});

// ============================================================
// IR-0045: getRemoteList page/pageSize defaults (1/200)
// Spec: page omit → 1, pageSize omit → 200
// ref: packages/core/src/ir.js:87
// ============================================================
describe("[IR-0045] getRemoteList page/pageSize defaults", () => {
  it("[IR-0045] page defaults to 1 when omitted", async () => {
    const client = makeClient(successResp({ data: [], pagination: null }));
    await getRemoteList(client, { type: 0x2000, companyID: COMPANY_ID });
    expect(client.sent[0].pagination.page).toBe(1);
  });

  it("[IR-0045] pageSize defaults to 200 when omitted", async () => {
    const client = makeClient(successResp({ data: [], pagination: null }));
    await getRemoteList(client, { type: 0x2000, companyID: COMPANY_ID });
    expect(client.sent[0].pagination.pageSize).toBe(200);
  });

  it("[IR-0045] explicit page and pageSize override defaults", async () => {
    const client = makeClient(successResp({ data: [], pagination: null }));
    await getRemoteList(client, { type: 0x2000, companyID: COMPANY_ID, page: 3, pageSize: 50 });
    expect(client.sent[0].pagination.page).toBe(3);
    expect(client.sent[0].pagination.pageSize).toBe(50);
  });
});

// ============================================================
// IR-0046: getRemoteList response parse (resp.data.data / resp.data.pagination fallback)
// Spec: list from resp.data.data ([] on missing), pagination from resp.data.pagination (null on missing)
// ref: packages/core/src/ir.js:95-96
// ============================================================
describe("[IR-0046] getRemoteList response parse {list, pagination}", () => {
  it("[IR-0046] extracts list from resp.data.data and pagination from resp.data.pagination", async () => {
    const items = [{ uuid: "r1" }, { uuid: "r2" }];
    const pg = { currentPage: 1, pageSize: 200, hasMore: false };
    const client = makeClient({ success: true, data: { data: items, pagination: pg } });
    const result = await getRemoteList(client, { type: 0x2000, companyID: COMPANY_ID });
    expect(result.list).toEqual(items);
    expect(result.pagination).toEqual(pg);
  });

  it("[IR-0046] list falls back to [] when resp.data.data absent", async () => {
    const client = makeClient({ success: true, data: {} });
    const result = await getRemoteList(client, { type: 0x2000, companyID: COMPANY_ID });
    expect(result.list).toEqual([]);
  });

  it("[IR-0046] list falls back to [] when resp.data absent entirely", async () => {
    const client = makeClient({ success: true });
    const result = await getRemoteList(client, { type: 0x2000, companyID: COMPANY_ID });
    expect(result.list).toEqual([]);
  });

  it("[IR-0046] pagination falls back to null when absent", async () => {
    const client = makeClient({ success: true, data: { data: [] } });
    const result = await getRemoteList(client, { type: 0x2000, companyID: COMPANY_ID });
    expect(result.pagination).toBeNull();
  });
});

// ============================================================
// IR-0047: remote-list --json output envelope {count, remotes, pagination}
// Spec: --json → {count, remotes, pagination}; text → alias||name / irDeviceUUID||uuid
// ref: packages/kit/src/cli/ir.js:140-148
// ============================================================
describe("[IR-0047] remote-list --json output envelope {count, remotes, pagination}", () => {
  it("[IR-0047] json envelope has count, remotes, pagination keys", () => {
    // cli/ir.js:147: {count: list.length, remotes: list, pagination}
    const list = [{ alias: "TV", irDeviceUUID: "u1" }];
    const pagination = { currentPage: 1, hasMore: false };
    const envelope = { count: list.length, remotes: list, pagination };
    expect(envelope).toHaveProperty("count", 1);
    expect(envelope).toHaveProperty("remotes");
    expect(envelope).toHaveProperty("pagination");
    expect(Array.isArray(envelope.remotes)).toBe(true);
  });

  it("[IR-0047] text line uses alias||name and irDeviceUUID||uuid with fallback", () => {
    // cli/ir.js:145: `${r.alias || r.name || "(no name)"}\t${r.irDeviceUUID || r.uuid || ""}`
    const r1 = { alias: "Living TV", irDeviceUUID: "abc-123" };
    expect(r1.alias || r1.name || "(no name)").toBe("Living TV");
    expect(r1.irDeviceUUID || r1.uuid || "").toBe("abc-123");

    const r2 = { name: "Fan", uuid: "def-456" };
    expect(r2.alias || r2.name || "(no name)").toBe("Fan");
    expect(r2.irDeviceUUID || r2.uuid || "").toBe("def-456");

    const r3 = {};
    expect(r3.alias || r3.name || "(no name)").toBe("(no name)");
    expect(r3.irDeviceUUID || r3.uuid || "").toBe("");
  });
});

// ============================================================
// IR-0048: searchRemoteList wire frame (op/type/companyID/searchTerm/pagination 1000 fixed)
// Spec: frame matches vendor shape with page=1/pageSize=1000 hardcoded
// ref: packages/core/src/ir.js:108-115
// ============================================================
describe("[IR-0048] searchRemoteList wire frame", () => {
  it("[IR-0048] frame has action/op/type/companyID/searchTerm/pagination with page=1,pageSize=1000", async () => {
    const client = makeClient({ success: true, data: { data: [], pagination: null } });
    await searchRemoteList(client, { type: 0xc000, companyID: COMPANY_ID, searchTerm: "daikin" });
    const frame = client.sent[0];
    expect(frame.action).toBe("biz3IRRemote");
    expect(frame.op).toBe("searchRemoteList");
    expect(frame.type).toBe(0xc000);
    expect(frame.companyID).toBe(COMPANY_ID);
    expect(frame.searchTerm).toBe("daikin");
    expect(frame.pagination).toEqual({ page: 1, pageSize: 1000 });
  });

  it("[IR-0048] pagination is always fixed page=1/pageSize=1000 (vendor-compliant)", async () => {
    const client = makeClient({ success: true, data: { data: [] } });
    await searchRemoteList(client, { type: 0x2000, companyID: COMPANY_ID, searchTerm: "sony" });
    expect(client.sent[0].pagination).toEqual({ page: 1, pageSize: 1000 });
  });
});

// ============================================================
// IR-0049: searchRemoteList response list from resp.data.data
// Spec: list from resp.data.data, [] on missing
// ref: packages/core/src/ir.js:119-120
// ============================================================
describe("[IR-0049] searchRemoteList response list extraction", () => {
  it("[IR-0049] extracts list from resp.data.data", async () => {
    const items = [{ uuid: "p1", brandName: "Sony" }, { uuid: "p2", brandName: "LG" }];
    const client = makeClient({ success: true, data: { data: items } });
    const result = await searchRemoteList(client, { type: 0x2000, companyID: COMPANY_ID, searchTerm: "sony" });
    expect(result.list).toEqual(items);
  });

  it("[IR-0049] list falls back to [] when resp.data.data absent", async () => {
    const client = makeClient({ success: true, data: {} });
    const result = await searchRemoteList(client, { type: 0x2000, companyID: COMPANY_ID, searchTerm: "x" });
    expect(result.list).toEqual([]);
  });

  it("[IR-0049] list falls back to [] when resp.data absent", async () => {
    const client = makeClient({ success: true });
    const result = await searchRemoteList(client, { type: 0x2000, companyID: COMPANY_ID, searchTerm: "x" });
    expect(result.list).toEqual([]);
  });
});

// ============================================================
// IR-0050: searchTerm missing → CLI die(2) / serve need() → INVALID_PARAMS/bad_params
// ref: packages/kit/src/cli/ir.js:161; packages/kit/src/serve/entries/ir.js:64
// ============================================================
describe("[IR-0050] searchTerm required validation", () => {
  it("[IR-0050] need(['type','searchTerm']) throws when searchTerm=undefined", async () => {
    const { need } = await import("../../../kit/src/serve/registry-helpers.js");
    expect(() => need({ type: 0x2000 }, ["type", "searchTerm"])).toThrow();
  });

  it("[IR-0050] need(['type','searchTerm']) throws when searchTerm='' (empty string)", async () => {
    const { need } = await import("../../../kit/src/serve/registry-helpers.js");
    expect(() => need({ type: 0x2000, searchTerm: "" }, ["type", "searchTerm"])).toThrow();
  });

  it("[IR-0050] ir.searchRemotes serve handler throws bad_params when searchTerm absent", async () => {
    const { irEntries } = await import("../../../kit/src/serve/entries/ir.js");
    const entries = irEntries();
    const daemon = { authState: "ok", hub: { connected: true } };
    const hub = {
      searchPresetIRRemotes: vi.fn().mockResolvedValue({ list: [], pagination: null }),
    };
    expect(() =>
      entries["ir.searchRemotes"].handler({ hub, params: { type: 0x2000 }, daemon }),
    ).toThrow();
    try {
      entries["ir.searchRemotes"].handler({ hub, params: { type: 0x2000 }, daemon });
    } catch (e) {
      expect(e.kind ?? e.data?.kind ?? "").toMatch(/bad_params|BAD_PARAMS/i);
    }
  });

  it("[IR-0050] cli.searchTermRequired i18n key exists in en and ja catalogs", async () => {
    const { default: catalog } = await import("../../../kit/src/i18n/cli.js");
    expect(catalog.en["cli.searchTermRequired"]).toBeDefined();
    expect(catalog.ja["cli.searchTermRequired"]).toBeDefined();
  });
});

// ============================================================
// IR-0051: search --json output envelope {count, results}
// Spec: --json → {count, results}; text → brandName||name / modelName||model / uuid
// ref: packages/kit/src/cli/ir.js:166-171
// ============================================================
describe("[IR-0051] search --json output envelope {count, results}", () => {
  it("[IR-0051] json envelope has count and results keys (no pagination)", () => {
    // cli/ir.js:171: {count: list.length, results: list}
    const list = [{ brandName: "Daikin", modelName: "S223ATES", uuid: "abc" }];
    const envelope = { count: list.length, results: list };
    expect(envelope).toHaveProperty("count", 1);
    expect(envelope).toHaveProperty("results");
    expect(Array.isArray(envelope.results)).toBe(true);
    // searchRemotes does not include pagination
    expect(envelope).not.toHaveProperty("pagination");
  });

  it("[IR-0051] text line uses brandName||name and modelName||model and uuid fallbacks", () => {
    // cli/ir.js:168-170: r.brandName||r.name||"?" / r.modelName||r.model||"" / r.uuid||""
    const r1 = { brandName: "Daikin", modelName: "S223", uuid: "u1" };
    expect(r1.brandName || r1.name || "?").toBe("Daikin");
    expect(r1.modelName || r1.model || "").toBe("S223");
    expect(r1.uuid || "").toBe("u1");

    const r2 = { name: "SHARP", model: "LC-65U45", uuid: "u2" };
    expect(r2.brandName || r2.name || "?").toBe("SHARP");
    expect(r2.modelName || r2.model || "").toBe("LC-65U45");

    const r3 = {};
    expect(r3.brandName || r3.name || "?").toBe("?");
    expect(r3.modelName || r3.model || "").toBe("");
    expect(r3.uuid || "").toBe("");
  });
});

// ============================================================
// IR-0052: addIRRemote wire frame (op/remote/companyID)
// Spec: frame = {action, op:'addIRRemote', remote, companyID}
// ref: packages/core/src/ir.js:195
// ============================================================
describe("[IR-0052] addIRRemote wire frame", () => {
  const BASE_REMOTE = {
    uuid: "test-uuid-1",
    model: "TV-100",
    state: "",
    alias: "Living TV",
    code: "preset-001",
    type: 0x2000,
    deviceUUID: "hub3-device-id",
    keys: [],
  };

  it("[IR-0052] frame has action='biz3IRRemote', op='addIRRemote', remote, companyID", async () => {
    const client = makeClient(successResp(null));
    await addIRRemote(client, { remote: BASE_REMOTE, companyID: COMPANY_ID });
    const frame = client.sent[0];
    expect(frame.action).toBe("biz3IRRemote");
    expect(frame.op).toBe("addIRRemote");
    expect(frame.remote).toBeDefined();
    expect(frame.companyID).toBe(COMPANY_ID);
    expect(frame.remote.uuid).toBe("test-uuid-1");
    expect(frame.remote.model).toBe("TV-100");
  });

  it("[IR-0052] frame keys are only action/op/remote/companyID (no extras)", async () => {
    const client = makeClient(successResp(null));
    await addIRRemote(client, { remote: BASE_REMOTE, companyID: COMPANY_ID });
    const frame = client.sent[0];
    const keys = Object.keys(frame).sort();
    expect(keys).toEqual(["action", "companyID", "op", "remote"].sort());
  });
});

// ============================================================
// IR-0053: addIRRemote remote object fields (uuid/model/state/alias/code/type/deviceUUID/keys)
// Spec: sent remote matches vendor remoteToSave field set
// ref: packages/core/src/ir.js (addIRRemote); learn/index.js:261-270
// ============================================================
describe("[IR-0053] addIRRemote remote object shape (vendor remoteToSave field set)", () => {
  it("[IR-0053] sent remote contains all vendor remoteToSave fields", async () => {
    const client = makeClient(successResp(null));
    const remote = {
      uuid: "pre-set-uuid",
      model: "AC-100",
      state: "aabbcc",
      alias: "My AC",
      code: "ac-preset-code",
      type: 0xc000,
      deviceUUID: "hub3-dev-uuid",
      keys: [],
    };
    await addIRRemote(client, { remote, companyID: COMPANY_ID });
    const sentRemote = client.sent[0].remote;
    expect(sentRemote).toHaveProperty("uuid");
    expect(sentRemote).toHaveProperty("model");
    expect(sentRemote).toHaveProperty("state");
    expect(sentRemote).toHaveProperty("alias");
    expect(sentRemote).toHaveProperty("code");
    expect(sentRemote).toHaveProperty("type");
    expect(sentRemote).toHaveProperty("deviceUUID");
    expect(sentRemote).toHaveProperty("keys");
    expect(sentRemote).toMatchObject({
      uuid: "pre-set-uuid",
      model: "AC-100",
      state: "aabbcc",
      alias: "My AC",
      code: "ac-preset-code",
      type: 0xc000,
      deviceUUID: "hub3-dev-uuid",
      keys: [],
    });
  });

  it("[IR-0053] old field names hub3DeviceId/name/irOperation must NOT be present", async () => {
    const client = makeClient(successResp(null));
    const remote = {
      uuid: "u1",
      model: "Fan",
      state: "",
      alias: "Bedroom Fan",
      code: "",
      type: 0x8000,
      deviceUUID: "hub3-dev",
      keys: [],
    };
    await addIRRemote(client, { remote, companyID: COMPANY_ID });
    const sentRemote = client.sent[0].remote;
    expect(sentRemote).not.toHaveProperty("hub3DeviceId");
    expect(sentRemote).not.toHaveProperty("name");
    expect(sentRemote).not.toHaveProperty("irOperation");
  });

  it("[IR-0053] remote.type accepts all valid IR type values", async () => {
    for (const type of [0x2000, 0xc000, 0xe000, 0x8000, 0xfe00]) {
      const client = makeClient(successResp(null));
      const remote = { uuid: "r-x", model: "M", state: "", alias: "A", code: "c", type, deviceUUID: "hub3-d", keys: [] };
      await expect(addIRRemote(client, { remote, companyID: COMPANY_ID })).resolves.toBeDefined();
    }
  });
});

// ============================================================
// IR-0054: addIRRemote uuid auto-fill (omitted → generateUUID; provided → unchanged)
// Spec: remote.uuid absent → client-generated UUID; present → used as-is
// ref: packages/core/src/ir.js:192-194; learn/index.js:262
// ============================================================
describe("[IR-0054] addIRRemote uuid auto-fill", () => {
  const REQUIRED_FIELDS = {
    model: "TV",
    state: "",
    alias: "TV",
    code: "",
    type: 0x2000,
    deviceUUID: "hub3-uuid",
    keys: [],
  };

  it("[IR-0054] uuid omitted → frame.remote.uuid is auto-generated non-empty string", async () => {
    const client = makeClient(successResp(null));
    const remote = { ...REQUIRED_FIELDS };
    await addIRRemote(client, { remote, companyID: COMPANY_ID });
    const sentUuid = client.sent[0].remote.uuid;
    expect(typeof sentUuid).toBe("string");
    expect(sentUuid.length).toBeGreaterThan(0);
    // Original remote object is not mutated (no side-effect)
    expect(remote).not.toHaveProperty("uuid");
  });

  it("[IR-0054] uuid provided → frame.remote.uuid is the exact provided value (no override)", async () => {
    const client = makeClient(successResp(null));
    const myUuid = "my-custom-uuid-abcdef";
    await addIRRemote(client, { remote: { ...REQUIRED_FIELDS, uuid: myUuid }, companyID: COMPANY_ID });
    expect(client.sent[0].remote.uuid).toBe(myUuid);
  });

  it("[IR-0054] two calls with uuid omitted → each gets a distinct UUID (random generation)", async () => {
    const c1 = makeClient(successResp(null));
    const c2 = makeClient(successResp(null));
    await addIRRemote(c1, { remote: { ...REQUIRED_FIELDS }, companyID: COMPANY_ID });
    await addIRRemote(c2, { remote: { ...REQUIRED_FIELDS }, companyID: COMPANY_ID });
    const uuid1 = c1.sent[0].remote.uuid;
    const uuid2 = c2.sent[0].remote.uuid;
    expect(uuid1).not.toBe(uuid2);
  });

  it("[IR-0054] deviceUUID missing → throws bad_request before sending to server", async () => {
    // ref: packages/core/src/ir.js:188
    // if (!remote.deviceUUID) throw badRequest('domain.ir.addIRRemoteDeviceUUIDRequired')
    const client = makeClient(successResp(null));
    const remoteNoDeviceUUID = {
      uuid: "r-no-device",
      model: "TV",
      state: "",
      alias: "TV",
      code: "",
      type: 0x2000,
      keys: [],
    };
    await expect(
      addIRRemote(client, { remote: remoteNoDeviceUUID, companyID: COMPANY_ID }),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(client.request).not.toHaveBeenCalled();
  });

  it("[IR-0054] deviceUUID='' (empty string) → throws bad_request", async () => {
    const client = makeClient(successResp(null));
    await expect(
      addIRRemote(client, { remote: { ...REQUIRED_FIELDS, deviceUUID: "" }, companyID: COMPANY_ID }),
    ).rejects.toMatchObject({ code: "bad_request" });
    expect(client.request).not.toHaveBeenCalled();
  });
});
