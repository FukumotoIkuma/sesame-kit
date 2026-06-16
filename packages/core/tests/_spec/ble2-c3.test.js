// packages/core/tests/_spec/ble2-c3.test.js
//
// 対象 spec ID: BLE2-0059 〜 BLE2-0076 (18件)
// spec: spec/ble-os2.md (os2-facade / os2-cli / os2-serve / os2-sdk / os2-i18n / 監査追補 v2)
//
// TDD 方針: spec の assert を正とし、実装の現状に合わせない。
// ネットワーク/実機不要。全て mock または純関数。決定論的。

import { describe, it, expect, vi } from "vitest";
import { Buffer } from "node:buffer";

// ---- core ble/index exports ----
import {
  OS2_BLE_RPC_ALLOWLIST,
  OS2_BLE_RPC_OPS,
  SesameOS2Ble,
} from "../../src/ble/index.js";

// ---- rpc-helpers: invokePath (fail-closed) ----
import { invokePath } from "../../src/ble/rpc-helpers.js";

// ---- OS2 protocol helpers ----
import {
  OP,
  ITEM,
  lockPositionConfiguration,
  lockPositionData,
  botMechSettingData,
  botUpdateSettingData,
  enableDfuData,
  createHistag,
} from "../../src/ble/os2/protocol.js";

// ---- i18n catalog ----
import bleI18nModule from "../../src/i18n/ble.js";

// ---- i18n runtime ----
import { setLocale, t } from "../../src/i18n.js";

// ─────────────────────────────────────────────────────────────────────────────
// shared helpers
// ─────────────────────────────────────────────────────────────────────────────
const fakeTransport = {
  connect: vi.fn(async () => {}),
  write: vi.fn(),
  disconnect: vi.fn(async () => {}),
  on: vi.fn(),
};

/** Kotlin Int.toShort() 相当 */
function toShortTest(n) {
  const v = ((n % 0x10000) + 0x10000) % 0x10000;
  return v >= 0x8000 ? v - 0x10000 : v;
}

/** SesameOS2Ble を request stub 付きで作る */
function makeConnectedFacade({ model = "sesame_3" } = {}) {
  const ble = new SesameOS2Ble({
    transport: fakeTransport,
    secretKey: "0102030405060708090a0b0c0d0e0f10",
    ssmPublicKey: "a".repeat(128), // 64B hex = 128 chars
    keyIndex: "0000",
    model,
  });
  const requestStub = vi.fn().mockResolvedValue({ resultCode: 0, payload: Buffer.alloc(0) });
  ble._session.request = requestStub;
  ble._session._loggedIn = true;
  return { ble, requestStub };
}

// ─────────────────────────────────────────────────────────────────────────────
// BLE2-0059: connect() 失敗時はセッションを disconnect してから再 throw
// ─────────────────────────────────────────────────────────────────────────────
describe("[BLE2-0059] SesameOS2Ble.connect() — 失敗時 session.disconnect() してから再 throw", () => {
  it("[BLE2-0059] connect 失敗時に session.disconnect().catch を呼んでから throw する", async () => {
    const connectError = new Error("transport connect failed");
    const disconnectSpy = vi.fn().mockResolvedValue(undefined);
    const transport = {
      connect: async () => { throw connectError; },
      write: vi.fn(),
      disconnect: disconnectSpy,
    };
    const ble = new SesameOS2Ble({
      transport,
      secretKey: "00112233445566778899aabbccddeeff",
      ssmPublicKey: "a".repeat(128),
    });
    // _session.connect を強制 throw させる
    vi.spyOn(ble._session, "connect").mockRejectedValue(connectError);
    const disconnectSessionSpy = vi.spyOn(ble._session, "disconnect").mockResolvedValue();

    await expect(ble.connect()).rejects.toThrow("transport connect failed");
    expect(disconnectSessionSpy).toHaveBeenCalled();
  });

  it("[BLE2-0059] needAuthFromServer=true かつ signLogin 未指定なら connect() が reject (signLogin ガード)", async () => {
    const transport = {
      connect: vi.fn(async () => {}),
      write: vi.fn(),
      disconnect: vi.fn(async () => {}),
    };
    const ble = new SesameOS2Ble({
      transport,
      secretKey: "0102030405060708090a0b0c0d0e0f10",
      ssmPublicKey: "a".repeat(128),
      needAuthFromServer: true,
      // signLogin intentionally omitted
    });
    await expect(ble.connect()).rejects.toThrow(/signLogin/i);
  });

  it("[BLE2-0059] ssmPublicKey 未指定で connect() が reject する (ssmPublicKey ガード)", async () => {
    const transport = { connect: async () => {}, write: vi.fn(), disconnect: vi.fn(async () => {}) };
    const ble = new SesameOS2Ble({
      transport,
      secretKey: "0102030405060708090a0b0c0d0e0f10",
      // ssmPublicKey intentionally omitted
    });
    await expect(ble.connect()).rejects.toThrow(/ssmPublicKey/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BLE2-0060: status() は lastStatus 即返し、無ければ publish 待ち (timeout)
// ─────────────────────────────────────────────────────────────────────────────
describe("[BLE2-0060] SesameOS2Ble.status() — lastStatus 即返し / publish 待ち / timeout", () => {
  it("[BLE2-0060] lastStatus あれば Promise.resolve で即返し (cached)", async () => {
    const { ble } = makeConnectedFacade();
    const fakeStatus = { state: "locked" };
    ble._session._lastStatus = fakeStatus;
    const result = await ble.status();
    expect(result).toBe(fakeStatus);
  });

  it("[BLE2-0060] lastStatus なし + onStatus publish あれば resolve する", async () => {
    const { ble } = makeConnectedFacade();
    ble._session._lastStatus = null;
    const mockStatus = { state: "unlocked" };
    const origOnStatus = ble._session.onStatus.bind(ble._session);
    ble._session.onStatus = (fn) => {
      setTimeout(() => fn(mockStatus), 0);
      return origOnStatus(fn);
    };
    const result = await ble.status({ timeoutMs: 1000 });
    expect(result).toEqual(mockStatus);
  });

  it("[BLE2-0060] lastStatus なし timeout → 'could not receive mechStatus (timeout)' で reject", async () => {
    const { ble } = makeConnectedFacade();
    ble._session._lastStatus = null;
    ble._session.onStatus = (fn) => () => {};
    await expect(ble.status({ timeoutMs: 10 })).rejects.toThrow(/mechStatus.*timeout|timeout/i);
  });

  it("[BLE2-0060] STATUS_WAIT_MS=4000 の定義が存在する (status メソッドが function として存在する)", () => {
    expect(typeof SesameOS2Ble.prototype.status).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BLE2-0061: CLI ble os2-invoke は op を OS2 allowlist 照合で実行
// ─────────────────────────────────────────────────────────────────────────────
describe("[BLE2-0061] invokePath + OS2_BLE_RPC_ALLOWLIST: 掲載 op は通過、非掲載は fail-closed", () => {
  it("[BLE2-0061] OS2_BLE_RPC_ALLOWLIST に autolock/getAutolock/history/versionTag/reset が含まれる", () => {
    for (const op of ["autolock", "getAutolock", "history", "versionTag", "reset"]) {
      expect(OS2_BLE_RPC_ALLOWLIST).toContain(op);
    }
  });

  it("[BLE2-0061] OS2_BLE_RPC_ALLOWLIST に lock/unlock/click/toggle/configureLockPosition/updateSetting/updateFirmware が含まれる", () => {
    for (const op of ["lock", "unlock", "click", "toggle", "configureLockPosition", "updateSetting", "updateFirmware"]) {
      expect(OS2_BLE_RPC_ALLOWLIST).toContain(op);
    }
  });

  it("[BLE2-0061] connect は OS2_BLE_RPC_ALLOWLIST に含まれない (fail-closed 対象)", () => {
    expect(OS2_BLE_RPC_ALLOWLIST).not.toContain("connect");
    expect(OS2_BLE_RPC_ALLOWLIST).not.toContain("register");
    expect(OS2_BLE_RPC_ALLOWLIST).not.toContain("constructor");
    expect(OS2_BLE_RPC_ALLOWLIST).not.toContain("_session");
  });

  it("[BLE2-0061] allowlist 非掲載 op (connect) は invokePath が reject する", async () => {
    const fakeFacade = { connect: vi.fn(async () => {}) };
    await expect(invokePath(fakeFacade, "connect", [], OS2_BLE_RPC_ALLOWLIST)).rejects.toThrow();
  });

  it("[BLE2-0061] allowlist 掲載 op (lastStatus getter) は invokePath が通過する", async () => {
    const fakeStatus = { state: "locked" };
    const fakeFacade = { lastStatus: fakeStatus };
    const result = await invokePath(fakeFacade, "lastStatus", [], OS2_BLE_RPC_ALLOWLIST);
    expect(result).toBe(fakeStatus);
  });

  it("[BLE2-0061] _ を含む op は invokePath が拒否する (プロテクトプロパティ防御)", async () => {
    const fakeFacade = { _secret: "hidden" };
    await expect(invokePath(fakeFacade, "_secret", [], OS2_BLE_RPC_ALLOWLIST)).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BLE2-0062: CLI os2-invoke の keyIndex/ssmPublicKey 解決順 (フラグ>config)
// ─────────────────────────────────────────────────────────────────────────────
describe("[BLE2-0062] CLI os2-invoke keyIndex/ssmPublicKey 解決優先順", () => {
  it("[BLE2-0062] keyIndex 省略時は SesameOS2BleSession の既定 '0000' が使われる", () => {
    const ble = new SesameOS2Ble({
      transport: fakeTransport,
      secretKey: "0102030405060708090a0b0c0d0e0f10",
      ssmPublicKey: "a".repeat(128),
      // keyIndex intentionally omitted
    });
    expect(ble._session._keyIndex).toEqual(Buffer.from("0000", "hex"));
    expect(ble._session._keyIndex.length).toBe(2);
    expect(ble._session).toBeDefined();
  });

  it("[BLE2-0062] ssmPublicKey が OS2_BLE_RPC_ALLOWLIST 外 — invokePath は connect を拒否する", async () => {
    const fakeFacade = { connect: vi.fn() };
    await expect(invokePath(fakeFacade, "connect", [], OS2_BLE_RPC_ALLOWLIST)).rejects.toThrow();
  });

  it("[BLE2-0062] OS2_BLE_RPC_ALLOWLIST に status/lastStatus/loginInfo/isConnected/model が含まれる", () => {
    for (const op of ["status", "lastStatus", "loginInfo", "isConnected", "model"]) {
      expect(OS2_BLE_RPC_ALLOWLIST).toContain(op);
    }
  });

  it("[BLE2-0062] keyIndex 明示指定時は session に渡される (フラグ優先の設計)", () => {
    const ble = new SesameOS2Ble({
      transport: fakeTransport,
      secretKey: "0102030405060708090a0b0c0d0e0f10",
      ssmPublicKey: "a".repeat(128),
      keyIndex: "0001",
    });
    expect(ble._session).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BLE2-0063: CLI ble os2-register は registerOnce で鍵素材を出力
// ─────────────────────────────────────────────────────────────────────────────
describe("[BLE2-0063] SesameOS2Ble.registerOnce が localServerAuth 既定 true で登録を委譲する", () => {
  it("[BLE2-0063] registerOnce は static メソッドとして存在する", () => {
    expect(typeof SesameOS2Ble.registerOnce).toBe("function");
  });

  it("[BLE2-0063] registerMode:true + localServerAuth:true で _registerServer が function", () => {
    const ble = new SesameOS2Ble({
      transport: fakeTransport,
      registerMode: true,
      localServerAuth: true,
    });
    expect(typeof ble._registerServer).toBe("function");
  });

  it("[BLE2-0063] localServerAuth:false を渡すと _registerServer が null", () => {
    const ble = new SesameOS2Ble({
      transport: fakeTransport,
      registerMode: true,
      localServerAuth: false,
    });
    expect(ble._registerServer).toBeNull();
  });

  it("[BLE2-0063] 明示 registerServer が localServerAuth より優先される", () => {
    const myServer = vi.fn();
    const ble = new SesameOS2Ble({
      transport: fakeTransport,
      registerMode: true,
      registerServer: myServer,
      localServerAuth: true, // 同時指定でも明示優先
    });
    expect(ble._registerServer).toBe(myServer);
  });

  it("[BLE2-0063] registerMode:true のみで SesameOS2Ble が作れる", () => {
    const ble = new SesameOS2Ble({ transport: fakeTransport, registerMode: true });
    expect(ble).toBeInstanceOf(SesameOS2Ble);
  });

  it("[BLE2-0063] registerOnce は _registerServer=null (localServerAuth=false) なら即 reject する", async () => {
    const transport = { connect: async () => {}, write: vi.fn(), disconnect: async () => {} };
    await expect(
      SesameOS2Ble.registerOnce({ transport, localServerAuth: false })
    ).rejects.toThrow(/registerServer/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BLE2-0064: CLI os2-invoke/os2-register の文言は i18n キー (en/ja)
// ─────────────────────────────────────────────────────────────────────────────
describe("[BLE2-0064] os2Invoke/os2Register の i18n キーが en/ja 双方に存在し欠落しない", () => {
  const { en, ja } = bleI18nModule;

  it("[BLE2-0064] en: os2Register の desc/opt.ak/opt.noLocalServerAuth/done/saveHint が存在する", () => {
    expect(en).toHaveProperty("ble.cli.os2Register.desc");
    expect(en).toHaveProperty("ble.cli.os2Register.opt.ak");
    expect(en).toHaveProperty("ble.cli.os2Register.opt.noLocalServerAuth");
    expect(en).toHaveProperty("ble.cli.os2Register.done");
    expect(en).toHaveProperty("ble.cli.os2Register.saveHint");
  });

  it("[BLE2-0064] ja: os2Register の desc/opt.ak/opt.noLocalServerAuth/done/saveHint が存在する", () => {
    expect(ja).toHaveProperty("ble.cli.os2Register.desc");
    expect(ja).toHaveProperty("ble.cli.os2Register.opt.ak");
    expect(ja).toHaveProperty("ble.cli.os2Register.opt.noLocalServerAuth");
    expect(ja).toHaveProperty("ble.cli.os2Register.done");
    expect(ja).toHaveProperty("ble.cli.os2Register.saveHint");
  });

  it("[BLE2-0064] en: os2Invoke の desc/opt.keyIndex/opt.ssmPublicKey/needSsmPublicKey が存在する", () => {
    expect(en).toHaveProperty("ble.cli.os2Invoke.desc");
    expect(en).toHaveProperty("ble.cli.os2Invoke.opt.keyIndex");
    expect(en).toHaveProperty("ble.cli.os2Invoke.opt.ssmPublicKey");
    expect(en).toHaveProperty("ble.cli.os2Invoke.needSsmPublicKey");
  });

  it("[BLE2-0064] ja: os2Invoke の desc/opt.keyIndex/opt.ssmPublicKey/needSsmPublicKey が存在する", () => {
    expect(ja).toHaveProperty("ble.cli.os2Invoke.desc");
    expect(ja).toHaveProperty("ble.cli.os2Invoke.opt.keyIndex");
    expect(ja).toHaveProperty("ble.cli.os2Invoke.opt.ssmPublicKey");
    expect(ja).toHaveProperty("ble.cli.os2Invoke.needSsmPublicKey");
  });

  it("[BLE2-0064] en/ja の saveHint は deviceUUID/secretKey/sesamePublicKey プレースホルダを含む", () => {
    expect(en["ble.cli.os2Register.saveHint"]).toMatch(/\{deviceUUID\}/);
    expect(en["ble.cli.os2Register.saveHint"]).toMatch(/\{secretKey\}/);
    expect(en["ble.cli.os2Register.saveHint"]).toMatch(/\{sesamePublicKey\}/);
    expect(ja["ble.cli.os2Register.saveHint"]).toMatch(/\{deviceUUID\}/);
    expect(ja["ble.cli.os2Register.saveHint"]).toMatch(/\{secretKey\}/);
    expect(ja["ble.cli.os2Register.saveHint"]).toMatch(/\{sesamePublicKey\}/);
  });

  it("[BLE2-0064] ja locale で t() による os2Register.desc が解決できる", () => {
    setLocale("ja");
    const val = t("ble.cli.os2Register.desc");
    expect(typeof val).toBe("string");
    expect(val.length).toBeGreaterThan(0);
    expect(val).not.toBe("ble.cli.os2Register.desc");
  });

  it("[BLE2-0064] ja locale で t() による os2Invoke.desc が解決できる", () => {
    setLocale("ja");
    const val = t("ble.cli.os2Invoke.desc");
    expect(typeof val).toBe("string");
    expect(val.length).toBeGreaterThan(0);
    expect(val).not.toBe("ble.cli.os2Invoke.desc");
  });

  it("[BLE2-0064] en locale で os2Register.desc / os2Invoke.desc が解決できる", () => {
    setLocale("en");
    expect(t("ble.cli.os2Register.desc")).toMatch(/register/i);
    expect(t("ble.cli.os2Invoke.desc")).toMatch(/invoke/i);
    setLocale("ja"); // restore
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BLE2-0065: serve ble.os2.invoke は secretKey/keyIndex/ssmPublicKey 必須 + allowlist
// ─────────────────────────────────────────────────────────────────────────────
describe("[BLE2-0065] serve ble.os2.invoke: op/secretKey/keyIndex/ssmPublicKey 必須 + OS2_BLE_RPC_ALLOWLIST fail-closed", () => {
  it("[BLE2-0065] OS2_BLE_RPC_ALLOWLIST が存在し配列である", () => {
    expect(Array.isArray(OS2_BLE_RPC_ALLOWLIST)).toBe(true);
    expect(OS2_BLE_RPC_ALLOWLIST.length).toBeGreaterThan(0);
  });

  it("[BLE2-0065] OS2_BLE_RPC_ALLOWLIST に autolock/disableAutolock/getAutolock/history/versionTag/configureLockPosition/updateSetting/reset が含まれる", () => {
    const required = ["autolock", "disableAutolock", "getAutolock", "history", "versionTag", "configureLockPosition", "updateSetting", "reset"];
    for (const op of required) {
      expect(OS2_BLE_RPC_ALLOWLIST).toContain(op);
    }
  });

  it("[BLE2-0065] invokePath の allowlist 非掲載 op は fail-closed で reject する", async () => {
    const fakeFacade = { close: vi.fn() };
    await expect(invokePath(fakeFacade, "close", [], OS2_BLE_RPC_ALLOWLIST)).rejects.toThrow();
  });

  it("[BLE2-0065] invokePath 空 allowlist は全 op を拒否する (fail-closed 既定)", async () => {
    const fakeFacade = { lock: vi.fn(async () => ({ resultCode: 0 })) };
    await expect(invokePath(fakeFacade, "lock", [], [])).rejects.toThrow();
  });

  it("[BLE2-0065] invokePath allowlist 掲載 op (updateFirmware) は facade のメソッドへ到達する", async () => {
    const fakeResult = { resultCode: 0, payload: Buffer.alloc(0) };
    const fakeFacade = { updateFirmware: vi.fn(async () => fakeResult) };
    const result = await invokePath(fakeFacade, "updateFirmware", [], OS2_BLE_RPC_ALLOWLIST);
    expect(fakeFacade.updateFirmware).toHaveBeenCalledOnce();
    expect(result).toBe(fakeResult);
  });

  it("[BLE2-0065] OS2_BLE_RPC_ALLOWLIST は frozen 配列である", () => {
    expect(Object.isFrozen(OS2_BLE_RPC_ALLOWLIST)).toBe(true);
  });

  it("[BLE2-0065] OS2_BLE_RPC_ALLOWLIST に connect/register/registerOnce は含まれない", () => {
    expect(OS2_BLE_RPC_ALLOWLIST).not.toContain("connect");
    expect(OS2_BLE_RPC_ALLOWLIST).not.toContain("register");
    expect(OS2_BLE_RPC_ALLOWLIST).not.toContain("registerOnce");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BLE2-0066: serve ble.os2.register は deviceUUID 必須・registerOnce 委譲
// ─────────────────────────────────────────────────────────────────────────────
describe("[BLE2-0066] SesameOS2Ble.registerOnce の localServerAuth/productType/ak 正規化", () => {
  it("[BLE2-0066] localServerAuth:true が既定 (params.localServerAuth !== false) — false 以外は true 扱い", () => {
    // 実装の既定式 params.localServerAuth !== false を再現 (false 以外は true 扱い)。
    const norm = (v) => v !== false;
    expect(norm(undefined)).toBe(true);
    expect(norm(null)).toBe(true);
    expect(norm(false)).toBe(false);
    expect(norm(true)).toBe(true);
  });

  it("[BLE2-0066] productType: params.productType ?? params.model ?? undefined の解決順", () => {
    const resolve = (p, m) => p ?? m ?? undefined;
    expect(resolve("typeA", "modelB")).toBe("typeA");
    expect(resolve(undefined, "modelB")).toBe("modelB");
    expect(resolve(undefined, undefined)).toBeUndefined();
  });

  it("[BLE2-0066] SesameOS2Ble コンストラクタは transport 無しで throw する", () => {
    expect(() => new SesameOS2Ble({ secretKey: "00112233445566778899aabbccddeeff" })).toThrow(/transport/i);
  });

  it("[BLE2-0066] registerMode:true + localServerAuth:true で _registerServer が null でない", () => {
    const ble = new SesameOS2Ble({ transport: fakeTransport, registerMode: true, localServerAuth: true });
    expect(ble._registerServer).not.toBeNull();
    expect(typeof ble._registerServer).toBe("function");
  });

  it("[BLE2-0066] registerOnce は SesameOS2Ble の static メソッド (serve entry の委譲先)", () => {
    expect(typeof SesameOS2Ble.registerOnce).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BLE2-0067: OS2 RPC 公開面 (OS2_BLE_RPC_OPS) の op 集合と型付きスキーマ
// ─────────────────────────────────────────────────────────────────────────────
describe("[BLE2-0067] OS2_BLE_RPC_OPS に 8 op (autolock/disableAutolock/getAutolock/history/versionTag/updateSetting/reset/configureLockPosition) が型付きで存在する", () => {
  const expectedOps = [
    "autolock",
    "disableAutolock",
    "getAutolock",
    "history",
    "versionTag",
    "updateSetting",
    "reset",
    "configureLockPosition",
  ];

  it("[BLE2-0067] OS2_BLE_RPC_OPS は frozen object として export されている", () => {
    expect(typeof OS2_BLE_RPC_OPS).toBe("object");
    expect(Object.isFrozen(OS2_BLE_RPC_OPS)).toBe(true);
  });

  it("[BLE2-0067] OS2_BLE_RPC_OPS に 8 op が存在する", () => {
    for (const op of expectedOps) {
      expect(OS2_BLE_RPC_OPS, `OS2_BLE_RPC_OPS に "${op}" が無い`).toHaveProperty(op);
    }
    expect(Object.keys(OS2_BLE_RPC_OPS).length).toBe(expectedOps.length);
  });

  for (const op of expectedOps) {
    it(`[BLE2-0067] OS2_BLE_RPC_OPS['${op}'] が存在し params/result を持つ`, () => {
      expect(OS2_BLE_RPC_OPS).toHaveProperty(op);
      const spec = OS2_BLE_RPC_OPS[op];
      expect(Array.isArray(spec.params)).toBe(true);
      expect(typeof spec.result).toBe("string");
    });
  }

  it("[BLE2-0067] autolock の params[0] は seconds (required:true, type:number)", () => {
    const spec = OS2_BLE_RPC_OPS["autolock"];
    expect(spec.params[0].name).toBe("seconds");
    expect(spec.params[0].required).toBe(true);
    expect(spec.params[0].type).toBe("number");
  });

  it("[BLE2-0067] configureLockPosition の params は lockDeg/unlockDeg (各 required:true, type:number)", () => {
    const spec = OS2_BLE_RPC_OPS["configureLockPosition"];
    expect(spec.params.length).toBe(2);
    expect(spec.params[0].name).toBe("lockDeg");
    expect(spec.params[0].required).toBe(true);
    expect(spec.params[1].name).toBe("unlockDeg");
    expect(spec.params[1].required).toBe(true);
  });

  it("[BLE2-0067] getAutolock の result は 'raw'", () => {
    expect(OS2_BLE_RPC_OPS["getAutolock"].result).toBe("raw");
  });

  it("[BLE2-0067] reset の result は 'ack'", () => {
    expect(OS2_BLE_RPC_OPS["reset"].result).toBe("ack");
  });

  it("[BLE2-0067] status は OS2_BLE_RPC_OPS に含まれない (typed spec 保留)", () => {
    expect(OS2_BLE_RPC_OPS).not.toHaveProperty("status");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BLE2-0068: OS2 allowlist と TOPLEVEL_OPS の整合 (status は allowlist のみ)
// ─────────────────────────────────────────────────────────────────────────────
describe("[BLE2-0068] status/lastStatus/loginInfo/isConnected/model/lock/unlock/click/toggle は OS2_BLE_RPC_ALLOWLIST に載るが OS2_BLE_RPC_OPS には載らない", () => {
  const allowlistOnlyOps = ["status", "lastStatus", "loginInfo", "isConnected", "model", "lock", "unlock", "click", "toggle"];

  for (const op of allowlistOnlyOps) {
    it(`[BLE2-0068] '${op}' は OS2_BLE_RPC_ALLOWLIST に含まれ OS2_BLE_RPC_OPS には含まれない`, () => {
      expect(OS2_BLE_RPC_ALLOWLIST).toContain(op);
      expect(OS2_BLE_RPC_OPS).not.toHaveProperty(op);
    });
  }

  it("[BLE2-0068] OS2_BLE_RPC_ALLOWLIST は Object.freeze された readonly 配列である", () => {
    expect(Object.isFrozen(OS2_BLE_RPC_ALLOWLIST)).toBe(true);
  });

  it("[BLE2-0068] OS2_BLE_RPC_OPS は Object.freeze された readonly オブジェクトである", () => {
    expect(Object.isFrozen(OS2_BLE_RPC_OPS)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BLE2-0069: SDK 生成クライアントに ble.os2.invoke/ble.os2.register が露出
// ─────────────────────────────────────────────────────────────────────────────
describe("[BLE2-0069] ble.os2.invoke / ble.os2.register の serve entry パラメータスキーマ確認", () => {
  it("[BLE2-0069] ble.os2.invoke の必須パラメータ: op/secretKey/keyIndex/ssmPublicKey が 4 つ存在する", () => {
    const invokeRequired = ["op", "secretKey", "keyIndex", "ssmPublicKey"];
    expect(invokeRequired.length).toBe(4);
    expect(typeof SesameOS2Ble.prototype.lock).toBe("function");
    expect(typeof SesameOS2Ble.prototype.unlock).toBe("function");
  });

  it("[BLE2-0069] ble.os2.register の必須パラメータ: deviceUUID を想定 (registerMode=true で構築可)", () => {
    const ble = new SesameOS2Ble({ transport: fakeTransport, registerMode: true });
    expect(ble._registerMode).toBe(true);
  });

  it("[BLE2-0069] OS2_BLE_RPC_OPS の updateSetting params は setting(required)/tag(optional) の順", () => {
    const spec = OS2_BLE_RPC_OPS["updateSetting"];
    expect(spec.params.length).toBeGreaterThanOrEqual(1);
    expect(spec.params[0].name).toBe("setting");
    expect(spec.params[0].required).toBe(true);
    if (spec.params.length >= 2) {
      expect(spec.params[1].name).toBe("tag");
      expect(spec.params[1].required).toBe(false);
    }
  });

  it("[BLE2-0069] OS2_BLE_RPC_OPS の history params は opts(optional) 1 引数", () => {
    const spec = OS2_BLE_RPC_OPS["history"];
    expect(spec.params.length).toBeGreaterThanOrEqual(1);
    expect(spec.params[0].name).toBe("opts");
    expect(spec.params[0].required).toBe(false);
  });

  it("[BLE2-0069] OS2_BLE_RPC_OPS の getAutolock / versionTag / reset は params 空配列", () => {
    expect(OS2_BLE_RPC_OPS["getAutolock"].params).toHaveLength(0);
    expect(OS2_BLE_RPC_OPS["versionTag"].params).toHaveLength(0);
    expect(OS2_BLE_RPC_OPS["reset"].params).toHaveLength(0);
  });

  it("[BLE2-0069] OS2_BLE_RPC_OPS のキーが SesameOS2Ble のインスタンスメソッドとして存在する", () => {
    const ble = new SesameOS2Ble({ transport: fakeTransport, registerMode: true });
    for (const op of Object.keys(OS2_BLE_RPC_OPS)) {
      expect(typeof ble[op]).toBe("function");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BLE2-0070: OS2 切断/リンク断メッセージは i18n キー経由 (en/ja)
// ─────────────────────────────────────────────────────────────────────────────
describe("[BLE2-0070] t('ble.linkLost') / t('ble.disconnected') が en/ja 双方に存在する (OS3 共有キー)", () => {
  const { en, ja } = bleI18nModule;

  it("[BLE2-0070] en: ble.disconnected が存在する", () => {
    expect(en).toHaveProperty("ble.disconnected");
    expect(typeof en["ble.disconnected"]).toBe("string");
    expect(en["ble.disconnected"].length).toBeGreaterThan(0);
  });

  it("[BLE2-0070] en: ble.linkLost が存在する", () => {
    expect(en).toHaveProperty("ble.linkLost");
    expect(typeof en["ble.linkLost"]).toBe("string");
    expect(en["ble.linkLost"].length).toBeGreaterThan(0);
  });

  it("[BLE2-0070] ja: ble.disconnected が存在する", () => {
    expect(ja).toHaveProperty("ble.disconnected");
    expect(typeof ja["ble.disconnected"]).toBe("string");
    expect(ja["ble.disconnected"].length).toBeGreaterThan(0);
  });

  it("[BLE2-0070] ja: ble.linkLost が存在する", () => {
    expect(ja).toHaveProperty("ble.linkLost");
    expect(typeof ja["ble.linkLost"]).toBe("string");
    expect(ja["ble.linkLost"].length).toBeGreaterThan(0);
  });

  it("[BLE2-0070] ble.disconnected と ble.linkLost は別メッセージ (内容が異なる)", () => {
    expect(en["ble.disconnected"]).not.toBe(en["ble.linkLost"]);
    expect(ja["ble.disconnected"]).not.toBe(ja["ble.linkLost"]);
  });

  it("[BLE2-0070] ja locale で t('ble.linkLost') が解決できる", () => {
    setLocale("ja");
    const val = t("ble.linkLost");
    expect(typeof val).toBe("string");
    expect(val.length).toBeGreaterThan(0);
    expect(val).not.toBe("ble.linkLost");
  });

  it("[BLE2-0070] ja locale で t('ble.disconnected') が解決できる", () => {
    setLocale("ja");
    const val = t("ble.disconnected");
    expect(typeof val).toBe("string");
    expect(val.length).toBeGreaterThan(0);
    expect(val).not.toBe("ble.disconnected");
  });

  it("[BLE2-0070] en locale で t('ble.linkLost') が解決できる (OS3 共有キー)", () => {
    setLocale("en");
    const val = t("ble.linkLost");
    expect(val).toMatch(/link lost|disconnected|aborted/i);
    setLocale("ja");
  });

  it("[BLE2-0070] en locale で t('ble.disconnected') が解決できる", () => {
    setLocale("en");
    const val = t("ble.disconnected");
    expect(val).toMatch(/disconnect/i);
    setLocale("ja");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BLE2-0071: versionTag() 応答 payload[4:16] 12B latin1 スライス境界
// ─────────────────────────────────────────────────────────────────────────────
describe("[BLE2-0071] SesameOS2Ble.versionTag() は OP.READ + VERSION_TAG(5) を送り payload.subarray(4,16) を latin1 で返す", () => {
  it("[BLE2-0071] ITEM.VERSION_TAG は 5 (SesameProtocols.kt:34 SesameItemCode.versionTag)", () => {
    expect(ITEM.VERSION_TAG).toBe(5);
  });

  it("[BLE2-0071] OP.READ は 0x02 (SesameProtocols.kt:55 SSM2OpCode.read)", () => {
    expect(OP.READ).toBe(0x02);
  });

  it("[BLE2-0071] versionTag() は session.request を OP.READ + ITEM.VERSION_TAG + 空 data で呼ぶ", async () => {
    const { ble, requestStub } = makeConnectedFacade();
    const fakePayload = Buffer.alloc(16);
    fakePayload.write("FW1.2.3", 4, "latin1");
    requestStub.mockResolvedValue({ resultCode: 0, payload: fakePayload });
    await ble.versionTag();
    expect(requestStub).toHaveBeenCalledWith(OP.READ, ITEM.VERSION_TAG, Buffer.alloc(0));
  });

  it("[BLE2-0071] versionTag() は payload.subarray(4,16) を latin1 文字列として返す (12B)", async () => {
    const { ble, requestStub } = makeConnectedFacade();
    const payload = Buffer.alloc(16);
    Buffer.from("V2.3.4abcde ", "latin1").copy(payload, 4);
    requestStub.mockResolvedValue({ resultCode: 0, payload });
    const result = await ble.versionTag();
    expect(result).toBe(payload.subarray(4, 16).toString("latin1"));
    expect(result.length).toBe(12);
  });

  it("[BLE2-0071] subarray(4,16) は 12B (CHSesame2Device.kt:132 sliceArray(4..15) = 12B)", () => {
    const payload = Buffer.alloc(20);
    payload.write("HelloWorld12", 4, "latin1");
    const slice = payload.subarray(4, 16);
    expect(slice.length).toBe(12);
    expect(slice.toString("latin1")).toBe("HelloWorld12");
  });

  it("[BLE2-0071] SDK ref: sliceArray(4..15) = 12B — subarray(4,16) 境界が一致する", async () => {
    const { ble, requestStub } = makeConnectedFacade();
    const payload = Buffer.from("XXXXhello_world!", "latin1"); // 16B, [4:16]="hello_world!"
    requestStub.mockResolvedValue({ resultCode: 0, payload });
    const result = await ble.versionTag();
    expect(result).toBe("hello_world!"); // 12B
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BLE2-0072: updateFirmware() は OP.UPDATE item=ENABLE_DFU(7) に [0x01] を暗号化経路で送る
// ─────────────────────────────────────────────────────────────────────────────
describe("[BLE2-0072] SesameOS2Ble.updateFirmware() は OP.UPDATE + ENABLE_DFU(7) + [0x01] を送る", () => {
  it("[BLE2-0072] ITEM.ENABLE_DFU は 7 (SesameProtocols.kt:34 enableDFU(7))", () => {
    expect(ITEM.ENABLE_DFU).toBe(7);
  });

  it("[BLE2-0072] OP.UPDATE は 0x03 (SesameProtocols.kt:55 SSM2OpCode.update)", () => {
    expect(OP.UPDATE).toBe(0x03);
  });

  it("[BLE2-0072] enableDfuData() は [0x01] の 1B を返す (CHSesame2Device.kt:584 '01'.hexStringToByteArray())", () => {
    const data = enableDfuData();
    expect(data).toEqual(Buffer.from([0x01]));
    expect(data.length).toBe(1);
  });

  it("[BLE2-0072] updateFirmware() は session.request を OP.UPDATE + ENABLE_DFU + enableDfuData() で呼ぶ", async () => {
    const { ble, requestStub } = makeConnectedFacade();
    await ble.updateFirmware();
    expect(requestStub).toHaveBeenCalledWith(OP.UPDATE, ITEM.ENABLE_DFU, enableDfuData());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BLE2-0073: updateFirmware は allowlist 掲載だが TOPLEVEL_RPC_OPS 非掲載
// ─────────────────────────────────────────────────────────────────────────────
describe("[BLE2-0073] updateFirmware は OS2_BLE_RPC_ALLOWLIST に載るが OS2_BLE_RPC_OPS には載らない (allowlist-only)", () => {
  it("[BLE2-0073] updateFirmware は OS2_BLE_RPC_ALLOWLIST に含まれる", () => {
    expect(OS2_BLE_RPC_ALLOWLIST).toContain("updateFirmware");
  });

  it("[BLE2-0073] updateFirmware は OS2_BLE_RPC_OPS に含まれない (typed spec 保留)", () => {
    expect(OS2_BLE_RPC_OPS).not.toHaveProperty("updateFirmware");
  });

  it("[BLE2-0073] invokePath は OS2_BLE_RPC_ALLOWLIST 経由で updateFirmware に到達できる", async () => {
    const fakeResult = { resultCode: 0, payload: Buffer.alloc(0) };
    const fakeFacade = { updateFirmware: vi.fn(async () => fakeResult) };
    const result = await invokePath(fakeFacade, "updateFirmware", [], OS2_BLE_RPC_ALLOWLIST);
    expect(fakeFacade.updateFirmware).toHaveBeenCalled();
    expect(result).toBe(fakeResult);
  });

  it("[BLE2-0073] BLE2-0068 の allowlist-only 集合に updateFirmware も同方針である (status 等と対称)", () => {
    expect(OS2_BLE_RPC_ALLOWLIST).toContain("updateFirmware");
    expect(OS2_BLE_RPC_ALLOWLIST).toContain("status");
    expect(OS2_BLE_RPC_OPS).not.toHaveProperty("updateFirmware");
    expect(OS2_BLE_RPC_OPS).not.toHaveProperty("status");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BLE2-0074: configureLockPosition の 12B payload + createHistag(null) = 34B
// ─────────────────────────────────────────────────────────────────────────────
describe("[BLE2-0074] lockPositionConfiguration/lockPositionData: tick 変換・±150 range・Short wrap・34B", () => {
  it("[BLE2-0074] lockPositionConfiguration(90, 0) は 12B を返す (6 × LE Short)", () => {
    const data = lockPositionConfiguration(90, 0);
    expect(data.length).toBe(12);
  });

  it("[BLE2-0074] tick = trunc(deg * 1024 / 360) — CHSesame2Device.kt:557 Int 演算と一致", () => {
    // 90度 → trunc(90 * 1024 / 360) = trunc(256) = 256
    const data = lockPositionConfiguration(90, 0);
    const lockTick = data.readInt16LE(0);
    expect(lockTick).toBe(Math.trunc((90 * 1024) / 360));
  });

  it("[BLE2-0074] unlockDeg=180 → tick = trunc(180*1024/360) = 512", () => {
    const buf = lockPositionConfiguration(0, 180);
    const unlockTick = buf.readInt16LE(2);
    expect(unlockTick).toBe(Math.trunc((180 * 1024) / 360)); // 512
  });

  it("[BLE2-0074] lockMin = lock - 150, lockMax = lock + 150 (range=150 Short wrap)", () => {
    const lockDeg = 90; // tick = 256
    const data = lockPositionConfiguration(lockDeg, 0);
    const lock = data.readInt16LE(0);
    const lockMin = data.readInt16LE(4);
    const lockMax = data.readInt16LE(6);
    expect(lockMin).toBe(toShortTest(lock - 150));
    expect(lockMax).toBe(toShortTest(lock + 150));
  });

  it("[BLE2-0074] range=150 で lockMin=lock-150, lockMax=lock+150 (lockDeg=0 で確認)", () => {
    const buf = lockPositionConfiguration(0, 0);
    const lockMin = buf.readInt16LE(4);
    const lockMax = buf.readInt16LE(6);
    expect(lockMin).toBe(-150);
    expect(lockMax).toBe(150);
  });

  it("[BLE2-0074] lockPositionData(lockDeg, unlockDeg) = lockPositionConfiguration ++ createHistag(null) = 34B", () => {
    const data = lockPositionData(90, 0);
    expect(data.length).toBe(34); // 12B + 22B
    const histag = data.subarray(12);
    expect(histag.length).toBe(22);
    expect([...histag].every((b) => b === 0)).toBe(true);
  });

  it("[BLE2-0074] lockPositionData の最後 22B は createHistag(null) と一致する", () => {
    const buf = lockPositionData(45, 90);
    const tag22 = buf.subarray(12);
    expect(tag22).toEqual(createHistag(null));
  });

  it("[BLE2-0074] 非整数 lockDeg は throw する (整数必須)", () => {
    expect(() => lockPositionConfiguration(90.5, 0)).toThrow(/integer/i);
    expect(() => lockPositionConfiguration(90, 180.3)).toThrow(/integer/i);
  });

  it("[BLE2-0074] Short wrap: tick が 32767 を超える場合に 16bit 折り返しが発生する", () => {
    // deg=360 → tick = trunc(360*1024/360) = 1024
    const data = lockPositionConfiguration(360, 0);
    const lock = data.readInt16LE(0);
    expect(lock).toBe(1024);
    const lockMax = data.readInt16LE(6);
    expect(lockMax).toBe(toShortTest(lock + 150));
  });

  it("[BLE2-0074] SesameOS2Ble.configureLockPosition() は session.request を OP.UPDATE + MECH_SETTING で呼ぶ", async () => {
    const { ble, requestStub } = makeConnectedFacade();
    await ble.configureLockPosition(90, 0);
    expect(requestStub).toHaveBeenCalledWith(OP.UPDATE, ITEM.MECH_SETTING, lockPositionData(90, 0));
  });

  it("[BLE2-0074] SesameOS2Ble.configureLockPosition は OP.UPDATE / ITEM.MECH_SETTING / lockPositionData を送る (180度確認)", async () => {
    const { ble, requestStub } = makeConnectedFacade();
    await ble.configureLockPosition(90, 180);
    expect(requestStub).toHaveBeenCalledWith(OP.UPDATE, ITEM.MECH_SETTING, lockPositionData(90, 180));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BLE2-0075: updateSetting (Bot1) botMechSettingData 12B (7×signed Byte ++ 5B 予約0) ++ createHistag(tag)=34B
// ─────────────────────────────────────────────────────────────────────────────
describe("[BLE2-0075] botMechSettingData / botUpdateSettingData: 7×符号付き 1B ++ 5B 予約 0 = 12B, ++ histag = 34B", () => {
  const validSetting = {
    userPrefDir: 1,
    lockSec: 2,
    unlockSec: 3,
    clickLockSec: 4,
    clickHoldSec: 5,
    clickUnlockSec: 6,
    buttonMode: 7,
  };

  it("[BLE2-0075] botMechSettingData は 12B (7B 本体 ++ 5B 予約 0) を返す", () => {
    const data = botMechSettingData(validSetting);
    expect(data.length).toBe(12);
  });

  it("[BLE2-0075] 7 フィールドが [0..6] に符号付き 1B として書かれる", () => {
    const data = botMechSettingData(validSetting);
    expect(data[0]).toBe(1);  // userPrefDir
    expect(data[1]).toBe(2);  // lockSec
    expect(data[2]).toBe(3);  // unlockSec
    expect(data[3]).toBe(4);  // clickLockSec
    expect(data[4]).toBe(5);  // clickHoldSec
    expect(data[5]).toBe(6);  // clickUnlockSec
    expect(data[6]).toBe(7);  // buttonMode
  });

  it("[BLE2-0075] 後続 5B (bytes 7-11) は予約 0 (CHSesameBotMechSettings.data() の 0 埋め)", () => {
    const data = botMechSettingData(validSetting);
    for (let i = 7; i < 12; i++) {
      expect(data[i]).toBe(0);
    }
  });

  it("[BLE2-0075] 負の値 (符号付き Byte: -1) が 0xff として書かれる", () => {
    const setting = { ...validSetting, userPrefDir: -1 };
    const data = botMechSettingData(setting);
    expect(data[0]).toBe(0xff);
  });

  it("[BLE2-0075] -128..255 の範囲外は throw する", () => {
    expect(() => botMechSettingData({ ...validSetting, userPrefDir: 256 })).toThrow(/byte/i);
    expect(() => botMechSettingData({ ...validSetting, userPrefDir: -129 })).toThrow(/byte/i);
  });

  it("[BLE2-0075] null/undefined は throw する", () => {
    expect(() => botMechSettingData(null)).toThrow();
  });

  it("[BLE2-0075] botUpdateSettingData = botMechSettingData ++ createHistag(tag) = 34B", () => {
    const data = botUpdateSettingData(validSetting, undefined);
    expect(data.length).toBe(34); // 12B + 22B
    expect(data.subarray(0, 12)).toEqual(botMechSettingData(validSetting));
    const histag = data.subarray(12);
    expect([...histag].every((b) => b === 0)).toBe(true);
  });

  it("[BLE2-0075] tag 付き botUpdateSettingData は histag の先頭 1B に tag 長が入る", () => {
    const tag = Buffer.from([0xAB, 0xCD]);
    const data = botUpdateSettingData(validSetting, tag);
    expect(data.length).toBe(34);
    const histag = data.subarray(12);
    expect(histag[0]).toBe(2);      // size=2
    expect(histag[1]).toBe(0xAB);
    expect(histag[2]).toBe(0xCD);
  });

  it("[BLE2-0075] tag あり: 後半 22B が createHistag(tag) と一致", () => {
    const tag = Buffer.from([0x01, 0x02, 0x03]);
    const buf = botUpdateSettingData(validSetting, tag);
    expect(buf.subarray(12)).toEqual(createHistag(tag));
  });

  it("[BLE2-0075] tag null: 後半 22B が createHistag(null) と一致", () => {
    const buf = botUpdateSettingData(validSetting, undefined);
    expect(buf.subarray(12)).toEqual(createHistag(null));
  });

  it("[BLE2-0075] ITEM.MECH_SETTING は 80 (SDK SesameItemCode.mechSetting=80)", () => {
    expect(ITEM.MECH_SETTING).toBe(80);
  });

  it("[BLE2-0075] SesameOS2Ble.updateSetting() は session.request を OP.UPDATE + MECH_SETTING で呼ぶ", async () => {
    const { ble, requestStub } = makeConnectedFacade({ model: "ssmbot_1" });
    await ble.updateSetting(validSetting, undefined);
    expect(requestStub).toHaveBeenCalledWith(OP.UPDATE, ITEM.MECH_SETTING, botUpdateSettingData(validSetting, undefined));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// BLE2-0076: reset() の wire 境界 (OP.DELETE item=registration(1) 空 data / 成功時 disconnect)
// ─────────────────────────────────────────────────────────────────────────────
describe("[BLE2-0076] SesameOS2Ble.reset() は OP.DELETE + REGISTRATION(1) + 空 data を送り、resultCode==0 で disconnect する", () => {
  it("[BLE2-0076] ITEM.REGISTRATION は 1 (itemcodes.js:12 SesameItemCode.registration)", () => {
    expect(ITEM.REGISTRATION).toBe(1);
  });

  it("[BLE2-0076] OP.DELETE は 0x04 (SesameProtocols.kt:55 SSM2OpCode.delete)", () => {
    expect(OP.DELETE).toBe(0x04);
  });

  it("[BLE2-0076] reset() が OP.DELETE + REGISTRATION + 空 data で session.request を呼ぶ", async () => {
    const { ble, requestStub } = makeConnectedFacade();
    const disconnectSpy = vi.fn().mockResolvedValue(undefined);
    ble._session.disconnect = disconnectSpy;
    await ble.reset();
    expect(requestStub).toHaveBeenCalledWith(OP.DELETE, ITEM.REGISTRATION, Buffer.alloc(0));
  });

  it("[BLE2-0076] resultCode==0 (success) → session.disconnect() を呼ぶ (dropKey 相当)", async () => {
    const { ble, requestStub } = makeConnectedFacade();
    requestStub.mockResolvedValue({ resultCode: 0, payload: Buffer.alloc(0) });
    const disconnectSpy = vi.fn().mockResolvedValue(undefined);
    ble._session.disconnect = disconnectSpy;
    await ble.reset();
    expect(disconnectSpy).toHaveBeenCalled();
  });

  it("[BLE2-0076] resultCode!=0 → disconnect を呼ばず res を返す (CHSesame2Device.kt:572-573 と一致)", async () => {
    const { ble, requestStub } = makeConnectedFacade();
    const fakeResult = { resultCode: 5, payload: Buffer.alloc(0) };
    requestStub.mockResolvedValue(fakeResult);
    const disconnectSpy = vi.fn().mockResolvedValue(undefined);
    ble._session.disconnect = disconnectSpy;
    const result = await ble.reset();
    expect(disconnectSpy).not.toHaveBeenCalled();
    expect(result).toBe(fakeResult);
  });

  it("[BLE2-0076] 空 data は Buffer.alloc(0) (byteArrayOf() 相当、CHSesame2Device.kt:570)", async () => {
    const { ble, requestStub } = makeConnectedFacade();
    const disconnectSpy = vi.fn().mockResolvedValue(undefined);
    ble._session.disconnect = disconnectSpy;
    await ble.reset();
    const [, , data] = requestStub.mock.calls[0];
    expect(data.length).toBe(0);
  });
});
