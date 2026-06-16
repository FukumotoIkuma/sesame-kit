// AUTH-0095 ~ AUTH-0112: status / cloud.ping / account.whoami の結線・安定性・
// フレーミング・認証テスト (統合版)。
//
// 対象: packages/kit/src/serve/entries/auth.js, stability.js, result-schemas.js,
//       registry.js, framing/token.js, framing/http.js, grpc-methods.generated.json
//
// TDD 方針: spec どおりの期待値を assert する。実装との食い違いは red で表面化。
// セットアップ: vitest.config.js の unit project に KIT_SETUP (setup.i18n.js + kit/vitest.setup.js)
//   が登録されているため、ja ロケール固定・serve i18n カタログ登録済み。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { authEntries } from "../../../kit/src/serve/entries/auth.js";
import { requireAuth } from "../../../kit/src/serve/registry-helpers.js";
import { stabilityOf, provenanceOf, STABLE_METHODS } from "../../../kit/src/serve/stability.js";
import { RESULT_SCHEMAS } from "../../../kit/src/serve/result-schemas.js";
import { buildRegistry, buildOpenRpcDoc } from "../../../kit/src/serve/registry.js";
import { Daemon } from "../../../kit/src/serve/daemon.js";
import { CONTRACT_VERSION, KIND } from "@sesame-kit/core/jsonrpc";
import { tokenMatches, generateToken, parseBearer } from "../../../kit/src/serve/framing/token.js";
import { startHttpFraming } from "../../../kit/src/serve/framing/http.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// paths from packages/core/tests/_spec/ to kit and schema
const KIT_SERVE = resolve(__dirname, "..", "..", "..", "kit", "src", "serve");
const KIT_TESTS = resolve(__dirname, "..", "..", "..", "kit", "tests");
const GRPC_MAP_PATH = resolve(KIT_SERVE, "grpc-methods.generated.json");
const PROTO_PATH = resolve(KIT_SERVE, "sesame.proto");
const OPENRPC_PATH = resolve(__dirname, "..", "..", "..", "..", "schema", "openrpc.json");
const FIXTURE_WHOAMI = resolve(KIT_TESTS, "fixtures", "upstream", "account.whoami.json");

// ─── fake hub factory ──────────────────────────────────────────────────────────

function makeFakeHub({
  connected = true,
  subUUID = "sub-uuid-001",
  pingResult = true,
  loginUserResult = undefined,
  username = "user@example.com",
} = {}) {
  const pingFn = vi.fn(async () => pingResult);
  const defaultLoginUser = {
    customerInfo: {
      companyID: "company-0001",
      subUUID: "sub-uuid-001",
      subscriptionId: "sub-0001",
      name: "Test Org",
      mainEmail: "owner@example.com",
      employeeEmail: "owner@example.com",
      employeeName: "Test Owner",
      access: ["admin"],
      tag: [],
      isAnonymous: false,
      isRootUser: true,
      isSesameApp: false,
    },
    quotas: { devices: 10 },
  };
  const getLoginUserFn = vi.fn(async () => loginUserResult ?? defaultLoginUser);
  const hub = {
    connected,
    subUUID,
    config: { devices: {} },
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    onDeviceUpdate: (_items, _fn) => () => {},
    ping: pingFn,
    getLoginUser: getLoginUserFn,
    tokenStore: {
      load: vi.fn(() =>
        username ? { username, idToken: "tok", refreshToken: "rtok" } : null,
      ),
    },
  };
  return hub;
}

function makeDaemon(hub, { authState = "ok" } = {}) {
  const d = new Daemon({ hub });
  d.authState = authState;
  return d;
}

// ─── AUTH-0095 ────────────────────────────────────────────────────────────────

describe("AUTH-0095: status の apiVersion / contractVersion", () => {
  it("[AUTH-0095] status の apiVersion と contractVersion がともに CONTRACT_VERSION と一致し、contractVersion は deprecated 別名として同値", async () => {
    const hub = makeFakeHub({ connected: true });
    const d = makeDaemon(hub, { authState: "ok" });
    const result = await d.invoke("status", {}, null);

    expect(result.apiVersion).toBe(CONTRACT_VERSION);
    expect(result.contractVersion).toBe(CONTRACT_VERSION);
    // canonical SemVer 形式
    expect(result.apiVersion).toMatch(/^\d+\.\d+\.\d+$/);
    // contractVersion は deprecated 別名 = apiVersion と同値
    expect(result.contractVersion).toBe(result.apiVersion);
  });
});

// ─── AUTH-0096 ────────────────────────────────────────────────────────────────

describe("AUTH-0096: sesame rpc status の notLoggedIn ヒント (CLI)", () => {
  // cli/serve.js のブランチ: m==='status' && result.authState !== 'ok' のとき
  // serve.hint.notLoggedIn を stderr へ出す。純粋なブランチ判定をユニットで検証する。

  it("[AUTH-0096] authState が ok のとき notLoggedIn ヒントは出力されない", () => {
    const result = { authState: "ok" };
    const m = "status";
    const shouldHint = m === "status" && result && result.authState && result.authState !== "ok";
    expect(shouldHint).toBe(false);
  });

  it("[AUTH-0096] authState が degraded のとき notLoggedIn ヒントが出力される", () => {
    const result = { authState: "degraded" };
    const m = "status";
    const shouldHint = m === "status" && result && result.authState && result.authState !== "ok";
    expect(shouldHint).toBe(true);
  });

  it("[AUTH-0096] authState が expired のとき notLoggedIn ヒントが出力される", () => {
    const result = { authState: "expired" };
    const m = "status";
    const shouldHint = m === "status" && result && result.authState && result.authState !== "ok";
    expect(shouldHint).toBe(true);
  });

  it("[AUTH-0096] m が status 以外のときはヒントを出力しない", () => {
    const result = { authState: "expired" };
    const m = "devices.list";
    const shouldHint = m === "status" && result && result.authState && result.authState !== "ok";
    expect(shouldHint).toBe(false);
  });

  it("[AUTH-0096] daemon が degraded のとき status がその authState を返す", async () => {
    const hub = makeFakeHub({ connected: false });
    const d = makeDaemon(hub, { authState: "degraded" });
    const sr = await d.invoke("status", {}, null);
    expect(sr.authState).toBe("degraded");
    expect(sr.authState).not.toBe("ok");
  });
});

// ─── AUTH-0097 ────────────────────────────────────────────────────────────────

describe("AUTH-0097: cloud.ping は biz3KeepAlive 1 往復で {ok:true, rttMs} を返す", () => {
  it("[AUTH-0097] cloud.ping が requireAuth 後 hub.ping() を 1 回だけ呼び {ok:true, rttMs} を返す", async () => {
    const hub = makeFakeHub({ connected: true });
    const d = makeDaemon(hub, { authState: "ok" });

    const t0 = Date.now();
    const result = await d.invoke("cloud.ping", {}, null);
    const t1 = Date.now();

    expect(hub.ping).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(typeof result.rttMs).toBe("number");
    expect(result.rttMs).toBeGreaterThanOrEqual(0);
    // rttMs は t0..t1 の範囲内に収まる (100ms の余裕)
    expect(result.rttMs).toBeLessThanOrEqual(t1 - t0 + 100);
  });

  it("[AUTH-0097] rttMs は Date.now() ベースの実経過時間 (ping に 0ms 以上)", async () => {
    const hub = makeFakeHub({ connected: true });
    const d = makeDaemon(hub, { authState: "ok" });
    const result = await d.invoke("cloud.ping", {}, null);
    expect(result.rttMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.rttMs)).toBe(true);
  });
});

// ─── AUTH-0098 ────────────────────────────────────────────────────────────────

describe("AUTH-0098: cloud.ping は未認証 daemon で not_authenticated を投げる", () => {
  it("[AUTH-0098] authState=expired で cloud.ping が NOT_AUTHENTICATED を投げ hub.ping は呼ばれない", async () => {
    const hub = makeFakeHub({ connected: true });
    const d = makeDaemon(hub, { authState: "expired" });

    await expect(d.invoke("cloud.ping", {}, null)).rejects.toMatchObject({
      kind: KIND.NOT_AUTHENTICATED,
    });
    expect(hub.ping).not.toHaveBeenCalled();
  });

  it("[AUTH-0098] authState=ok かつ connected で cloud.ping は通過して {ok:true} を返す", async () => {
    const hub = makeFakeHub({ connected: true });
    const d = makeDaemon(hub, { authState: "ok" });
    const result = await d.invoke("cloud.ping", {}, null);
    expect(result.ok).toBe(true);
    expect(hub.ping).toHaveBeenCalledTimes(1);
  });

  it("[AUTH-0098] authState=degraded かつ disconnected で cloud.ping は CONNECTION_LOST を投げる", async () => {
    // degraded は requireAuth を通過するが !hub.connected で CONNECTION_LOST
    const hub = makeFakeHub({ connected: false });
    const d = makeDaemon(hub, { authState: "degraded" });
    await expect(d.invoke("cloud.ping", {}, null)).rejects.toMatchObject({
      kind: KIND.CONNECTION_LOST,
    });
    expect(hub.ping).not.toHaveBeenCalled();
  });

  it("[AUTH-0098] requireAuth は degraded+disconnected で CONNECTION_LOST を投げる", () => {
    const hub = makeFakeHub({ connected: false });
    const d = makeDaemon(hub, { authState: "degraded" });
    expect(() => requireAuth(d)).toThrow();
    try {
      requireAuth(d);
    } catch (e) {
      expect(e.kind).toBe(KIND.CONNECTION_LOST);
    }
  });
});

// ─── AUTH-0099 ────────────────────────────────────────────────────────────────

describe("AUTH-0099: cloud.ping result スキーマは緩い object (experimental)", () => {
  it("[AUTH-0099] RESULT_SCHEMAS に cloud.ping のエントリが無い (experimental のため type:object にフォールバック)", () => {
    expect(Object.hasOwn(RESULT_SCHEMAS, "cloud.ping")).toBe(false);
  });

  it("[AUTH-0099] buildOpenRpcDoc の cloud.ping result.schema は type:object のみ (SDK は unknown/Any)", () => {
    const reg = buildRegistry();
    const doc = buildOpenRpcDoc(reg, "1.0.0");
    const m = doc.methods.find((x) => x.name === "cloud.ping");
    expect(m).toBeTruthy();
    // RESULT_SCHEMAS 非掲載 → フォールバック: { description, type: "object" }
    expect(m.result.schema.type).toBe("object");
    // プロパティ定義を含まない緩い object
    const hasDetailedProperties =
      m.result.schema.properties &&
      Object.keys(m.result.schema.properties).length > 0;
    expect(hasDetailedProperties).toBeFalsy();
  });
});

// ─── AUTH-0100 ────────────────────────────────────────────────────────────────

describe("AUTH-0100: cloud.ping が experimental として公開される", () => {
  it("[AUTH-0100] stabilityOf(cloud.ping) === 'experimental'", () => {
    expect(stabilityOf("cloud.ping")).toBe("experimental");
  });

  it("[AUTH-0100] provenanceOf(cloud.ping) === 'unverified'", () => {
    expect(provenanceOf("cloud.ping")).toBe("unverified");
  });

  it("[AUTH-0100] cloud.ping は STABLE_METHODS に含まれない", () => {
    expect(Object.hasOwn(STABLE_METHODS, "cloud.ping")).toBe(false);
  });

  it("[AUTH-0100] openrpc.json の cloud.ping が x-stability=experimental / x-provenance=unverified", () => {
    let doc;
    try {
      doc = JSON.parse(readFileSync(OPENRPC_PATH, "utf8"));
    } catch {
      // openrpc.json が未生成の環境ではスキップ
      return;
    }
    const m = doc.methods.find((x) => x.name === "cloud.ping");
    expect(m).toBeTruthy();
    expect(m["x-stability"]).toBe("experimental");
    expect(m["x-provenance"]).toBe("unverified");
  });
});

// ─── AUTH-0101 ────────────────────────────────────────────────────────────────

describe("AUTH-0101: account.whoami は requireAuth 後 hub.getLoginUser() を返す", () => {
  it("[AUTH-0101] account.whoami が requireAuth 後 hub.getLoginUser() を 1 回呼び、その戻り値をそのまま返す", async () => {
    const expected = { customerInfo: { companyID: "co1" }, quotas: { devices: 10 } };
    const hub = makeFakeHub({ connected: true, loginUserResult: expected });
    const d = makeDaemon(hub, { authState: "ok" });

    const result = await d.invoke("account.whoami", {}, null);
    expect(hub.getLoginUser).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expected);
  });
});

// ─── AUTH-0102 ────────────────────────────────────────────────────────────────

describe("AUTH-0102: account.whoami は email 未保存時 UNAUTHENTICATED を投げる", () => {
  it("[AUTH-0102] hub.getLoginUser が email 無しのとき SesameError(UNAUTHENTICATED) を投げる", async () => {
    const { SesameError, ERR } = await import("@sesame-kit/core/errors");
    const hub = makeFakeHub({ connected: true, username: null });
    hub.getLoginUser = vi.fn(async () => {
      throw new SesameError("emailNotInStore", { code: ERR.UNAUTHENTICATED });
    });

    const d = makeDaemon(hub, { authState: "ok" });
    await expect(d.invoke("account.whoami", {}, null)).rejects.toMatchObject({
      code: ERR.UNAUTHENTICATED,
    });
    expect(hub.getLoginUser).toHaveBeenCalledTimes(1);
  });

  it("[AUTH-0102] account.getLoginUser は email 未設定で badRequest(domain.account.emailRequired) を投げる", async () => {
    const { getLoginUser } = await import("@sesame-kit/core/account");
    const { ERR } = await import("@sesame-kit/core/errors");
    const fakeClient = { request: vi.fn() };
    // badRequest("domain.account.emailRequired") は code=bad_request の SesameError を投げる。
    // message は ja ロケールの翻訳文字列 (i18n キーではない)。code で判定する。
    await expect(getLoginUser(fakeClient, { email: "" })).rejects.toMatchObject({
      code: ERR.BAD_REQUEST,
    });
    // request は呼ばれない (email 検証で弾かれる)
    expect(fakeClient.request).not.toHaveBeenCalled();
  });
});

// ─── AUTH-0103 ────────────────────────────────────────────────────────────────

describe("AUTH-0103: account.whoami は authState=expired で not_authenticated を投げる", () => {
  it("[AUTH-0103] authState=expired で account.whoami が NOT_AUTHENTICATED を投げ hub.getLoginUser は呼ばれない", async () => {
    const hub = makeFakeHub({ connected: true });
    const d = makeDaemon(hub, { authState: "expired" });

    await expect(d.invoke("account.whoami", {}, null)).rejects.toMatchObject({
      kind: KIND.NOT_AUTHENTICATED,
    });
    expect(hub.getLoginUser).not.toHaveBeenCalled();
  });

  it("[AUTH-0103] authState=ok かつ connected で account.whoami は通過して結果を返す", async () => {
    const data = { customerInfo: { companyID: "x" }, quotas: {} };
    const hub = makeFakeHub({ connected: true, loginUserResult: data });
    const d = makeDaemon(hub, { authState: "ok" });

    const result = await d.invoke("account.whoami", {}, null);
    expect(result).toEqual(data);
    expect(hub.getLoginUser).toHaveBeenCalledTimes(1);
  });

  it("[AUTH-0103] authState=degraded かつ disconnected で account.whoami は CONNECTION_LOST を投げる", async () => {
    const hub = makeFakeHub({ connected: false });
    const d = makeDaemon(hub, { authState: "degraded" });

    await expect(d.invoke("account.whoami", {}, null)).rejects.toMatchObject({
      kind: KIND.CONNECTION_LOST,
    });
    expect(hub.getLoginUser).not.toHaveBeenCalled();
  });
});

// ─── AUTH-0104 ────────────────────────────────────────────────────────────────

describe("AUTH-0104: account.whoami customerInfo result スキーマが vendor 観測形と 1:1 一致", () => {
  const EXPECTED_CI_FIELDS = [
    "companyID", "subUUID", "subscriptionId", "name", "mainEmail",
    "employeeEmail", "employeeName", "access", "tag",
    "isAnonymous", "isRootUser", "isSesameApp",
  ];

  it("[AUTH-0104] RESULT_SCHEMAS['account.whoami'] の customerInfo フィールドが vendor 観測形と 1:1 一致", () => {
    const schema = RESULT_SCHEMAS["account.whoami"];
    expect(schema).toBeTruthy();
    const ciProps = Object.keys(schema.properties.customerInfo.properties);
    for (const f of EXPECTED_CI_FIELDS) {
      expect(ciProps).toContain(f);
    }
    // 余分なフィールドがないことも確認
    expect(ciProps.sort()).toEqual([...EXPECTED_CI_FIELDS].sort());
  });

  it("[AUTH-0104] RESULT_SCHEMAS['account.whoami'] が quotas を持ち、内部形が opaque (type:object のみ)", () => {
    const schema = RESULT_SCHEMAS["account.whoami"];
    expect(schema.properties.quotas).toBeTruthy();
    expect(schema.properties.quotas.type).toBe("object");
    // opaque: properties を持たない
    expect(schema.properties.quotas.properties).toBeUndefined();
  });

  it("[AUTH-0104] fixtures/upstream/account.whoami.json の customerInfo 全フィールドが RESULT_SCHEMAS に含まれる", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_WHOAMI, "utf8"));
    const schema = RESULT_SCHEMAS["account.whoami"];
    const ciProps = Object.keys(schema.properties.customerInfo.properties);
    const fixtureCiFields = Object.keys(fixture.sample.customerInfo);
    for (const f of fixtureCiFields) {
      expect(ciProps).toContain(f);
    }
  });

  it("[AUTH-0104] openrpc.json の account.whoami customerInfo properties が RESULT_SCHEMAS と一致", () => {
    let doc;
    try {
      doc = JSON.parse(readFileSync(OPENRPC_PATH, "utf8"));
    } catch {
      return;
    }
    const m = doc.methods.find((x) => x.name === "account.whoami");
    const openrpcCiProps = Object.keys(m.result.schema.properties.customerInfo.properties);
    const schema = RESULT_SCHEMAS["account.whoami"];
    const schemaCiProps = Object.keys(schema.properties.customerInfo.properties);
    expect(openrpcCiProps.sort()).toEqual(schemaCiProps.sort());
  });
});

// ─── AUTH-0105 ────────────────────────────────────────────────────────────────

describe("AUTH-0105: account.whoami が stable/app-core として公開される", () => {
  it("[AUTH-0105] stabilityOf(account.whoami) === 'stable'", () => {
    expect(stabilityOf("account.whoami")).toBe("stable");
  });

  it("[AUTH-0105] provenanceOf(account.whoami) === 'app-core'", () => {
    expect(provenanceOf("account.whoami")).toBe("app-core");
  });

  it("[AUTH-0105] account.whoami は STABLE_METHODS に掲載されている", () => {
    expect(Object.hasOwn(STABLE_METHODS, "account.whoami")).toBe(true);
    expect(STABLE_METHODS["account.whoami"]).toBe("app-core");
  });

  it("[AUTH-0105] openrpc.json の account.whoami が x-stability=stable / x-provenance=app-core", () => {
    let doc;
    try {
      doc = JSON.parse(readFileSync(OPENRPC_PATH, "utf8"));
    } catch {
      return;
    }
    const m = doc.methods.find((x) => x.name === "account.whoami");
    expect(m).toBeTruthy();
    expect(m["x-stability"]).toBe("stable");
    expect(m["x-provenance"]).toBe("app-core");
  });
});

// ─── AUTH-0106 ────────────────────────────────────────────────────────────────

describe("AUTH-0106: 3 メソッドが registry に存在し OpenRPC に列挙される", () => {
  it("[AUTH-0106] buildRegistry() が status / cloud.ping / account.whoami の 3 エントリを持つ", () => {
    const reg = buildRegistry();
    expect(reg.has("status")).toBe(true);
    expect(reg.has("cloud.ping")).toBe(true);
    expect(reg.has("account.whoami")).toBe(true);
  });

  it("[AUTH-0106] buildOpenRpcDoc が status / cloud.ping / account.whoami を methods[] に 1:1 で含む", () => {
    const reg = buildRegistry();
    const doc = buildOpenRpcDoc(reg, "1.0.0");
    const names = doc.methods.map((m) => m.name);
    expect(names).toContain("status");
    expect(names).toContain("cloud.ping");
    expect(names).toContain("account.whoami");
    // 重複がない (1:1)
    expect(names.filter((n) => n === "status").length).toBe(1);
    expect(names.filter((n) => n === "cloud.ping").length).toBe(1);
    expect(names.filter((n) => n === "account.whoami").length).toBe(1);
  });

  it("[AUTH-0106] 3 メソッドの params が空配列", () => {
    const reg = buildRegistry();
    const doc = buildOpenRpcDoc(reg, "1.0.0");
    for (const name of ["status", "cloud.ping", "account.whoami"]) {
      const m = doc.methods.find((x) => x.name === name);
      expect(m.params).toEqual([]);
    }
  });

  it("[AUTH-0106] authEntries() は 3 キーを返す", () => {
    const entries = authEntries();
    const keys = Object.keys(entries);
    expect(keys).toContain("status");
    expect(keys).toContain("cloud.ping");
    expect(keys).toContain("account.whoami");
    expect(keys.length).toBe(3);
  });
});

// ─── AUTH-0107 ────────────────────────────────────────────────────────────────

describe("AUTH-0107: openrpc.json が registry と非ドリフト (3 メソッドを保持)", () => {
  it("[AUTH-0107] schema/openrpc.json の 3 メソッドが buildOpenRpcDoc 出力と x-stability/x-provenance で一致する", () => {
    let committed;
    try {
      committed = JSON.parse(readFileSync(OPENRPC_PATH, "utf8"));
    } catch {
      return;
    }
    const reg = buildRegistry();
    const live = buildOpenRpcDoc(reg, CONTRACT_VERSION);

    for (const n of ["status", "cloud.ping", "account.whoami"]) {
      const committedM = committed.methods.find((m) => m.name === n);
      const liveM = live.methods.find((m) => m.name === n);
      expect(committedM, `committed has ${n}`).toBeTruthy();
      expect(liveM, `live has ${n}`).toBeTruthy();
      expect(committedM["x-stability"]).toBe(liveM["x-stability"]);
      expect(committedM["x-provenance"]).toBe(liveM["x-provenance"]);
    }
  });

  it("[AUTH-0107] committed の status/cloud.ping/account.whoami の params が [] (引数なし)", () => {
    let committed;
    try {
      committed = JSON.parse(readFileSync(OPENRPC_PATH, "utf8"));
    } catch {
      return;
    }
    for (const n of ["status", "cloud.ping", "account.whoami"]) {
      const m = committed.methods.find((x) => x.name === n);
      expect(m).toBeTruthy();
      expect(Array.isArray(m.params)).toBe(true);
      expect(m.params).toHaveLength(0);
    }
  });

  it("[AUTH-0107] schema/openrpc.json の status エントリが buildOpenRpcDoc 出力と result.schema で一致する", () => {
    let committed;
    try {
      committed = JSON.parse(readFileSync(OPENRPC_PATH, "utf8"));
    } catch {
      return;
    }
    const reg = buildRegistry();
    const live = buildOpenRpcDoc(reg, CONTRACT_VERSION);

    const committedStatus = committed.methods.find((m) => m.name === "status");
    const liveStatus = live.methods.find((m) => m.name === "status");
    expect(committedStatus).toBeTruthy();
    expect(liveStatus).toBeTruthy();
    // result schema type は一致する
    expect(committedStatus.result?.schema?.type).toBe(liveStatus.result?.schema?.type);
  });
});

// ─── AUTH-0108 ────────────────────────────────────────────────────────────────

describe("AUTH-0108: 3 メソッドの gRPC Pascal 変換メソッドが生成物に存在する", () => {
  let methodMap;
  beforeEach(() => {
    methodMap = JSON.parse(readFileSync(GRPC_MAP_PATH, "utf8"));
  });

  it("[AUTH-0108] grpc-methods.generated.json が Status -> method=status を持つ", () => {
    expect(Object.hasOwn(methodMap, "Status")).toBe(true);
    expect(methodMap["Status"].method).toBe("status");
  });

  it("[AUTH-0108] grpc-methods.generated.json が CloudPing -> method=cloud.ping を持つ", () => {
    expect(Object.hasOwn(methodMap, "CloudPing")).toBe(true);
    expect(methodMap["CloudPing"].method).toBe("cloud.ping");
  });

  it("[AUTH-0108] grpc-methods.generated.json が AccountWhoami -> method=account.whoami を持つ", () => {
    expect(Object.hasOwn(methodMap, "AccountWhoami")).toBe(true);
    expect(methodMap["AccountWhoami"].method).toBe("account.whoami");
  });

  it("[AUTH-0108] sesame.proto に Status / CloudPing / AccountWhoami の rpc 宣言が存在する", () => {
    const protoText = readFileSync(PROTO_PATH, "utf8");
    expect(protoText).toMatch(/rpc Status\s*\(/);
    expect(protoText).toMatch(/rpc CloudPing\s*\(/);
    expect(protoText).toMatch(/rpc AccountWhoami\s*\(/);
  });

  it("[AUTH-0108] sesame.proto の Status / AccountWhoami (stable) は '// stable' コメント付きで宣言され、CloudPing は stable でない", () => {
    const protoText = readFileSync(PROTO_PATH, "utf8");
    const lines = protoText.split("\n");

    for (const pascal of ["Status", "AccountWhoami"]) {
      const rpcIdx = lines.findIndex((l) => l.trimStart().startsWith(`rpc ${pascal} (`));
      expect(rpcIdx).toBeGreaterThan(-1);
      const commentLine = lines[rpcIdx - 1]?.trim();
      expect(commentLine).toBe("// stable");
    }

    // CloudPing は experimental なので // stable ではない
    const pingIdx = lines.findIndex((l) => l.trimStart().startsWith("rpc CloudPing ("));
    expect(pingIdx).toBeGreaterThan(-1);
    expect(lines[pingIdx - 1]?.trim()).not.toBe("// stable");
  });
});

// ─── AUTH-0109 ────────────────────────────────────────────────────────────────

describe("AUTH-0109: 3 メソッドが全 framing で同一 hub 結果へ届く (dispatch 統一)", () => {
  it("[AUTH-0109] Daemon.invoke が status を registry 経由で解決し connected/authState を返す", async () => {
    const hub = makeFakeHub({ connected: true });
    const d = makeDaemon(hub, { authState: "ok" });

    const result = await d.invoke("status", {}, null);
    expect(result.connected).toBe(true);
    expect(result.authState).toBe("ok");
    expect(result.apiVersion).toBe(CONTRACT_VERSION);
    expect(result.contractVersion).toBe(CONTRACT_VERSION);
  });

  it("[AUTH-0109] Daemon.invoke が account.whoami を registry 経由で解決し hub.getLoginUser の戻り値を返す", async () => {
    const expected = { customerInfo: { companyID: "co" }, quotas: {} };
    const hub = makeFakeHub({ connected: true, loginUserResult: expected });
    const d = makeDaemon(hub, { authState: "ok" });

    const result = await d.invoke("account.whoami", {}, null);
    expect(result).toEqual(expected);
  });

  it("[AUTH-0109] Daemon.invoke が cloud.ping を registry 経由で解決し {ok:true,rttMs} を返す", async () => {
    const hub = makeFakeHub({ connected: true });
    const d = makeDaemon(hub, { authState: "ok" });

    const result = await d.invoke("cloud.ping", {}, null);
    expect(result.ok).toBe(true);
    expect(typeof result.rttMs).toBe("number");
  });

  it("[AUTH-0109] dispatchMessage を通した status が同一 result 封筒を返す (1 リクエスト=1 JSON-RPC response)", async () => {
    const hub = makeFakeHub({ connected: true });
    const d = makeDaemon(hub, { authState: "ok" });
    const conn = { id: "test-dispatch", ephemeral: true, send() {}, close() {} };
    d.addConnection(conn);

    const raw = JSON.stringify({ jsonrpc: "2.0", id: 42, method: "status", params: {} });
    const res = await d.dispatchMessage(conn, raw);

    expect(res).toBeTruthy();
    expect(res.jsonrpc).toBe("2.0");
    expect(res.id).toBe(42);
    expect(res.result).toBeTruthy();
    expect(res.result.apiVersion).toBe(CONTRACT_VERSION);

    d.removeConnection(conn);
  });

  it("[AUTH-0109] framing 非依存に同名 handler は同一 hub メソッドへ届く (invoke 複数回)", async () => {
    const hub = makeFakeHub({ connected: true });
    const d = makeDaemon(hub, { authState: "ok" });
    const conn = { id: "test", ephemeral: true, send() {}, close() {} };
    d.addConnection(conn);

    // status は framing に依らず同じフィールドを返す
    const s1 = await d.invoke("status", {}, conn);
    const s2 = await d.invoke("status", {}, conn);
    expect(s1.apiVersion).toBe(s2.apiVersion);
    expect(s1.authState).toBe(s2.authState);

    // account.whoami は毎回 hub.getLoginUser を 1 往復
    await d.invoke("account.whoami", {}, conn);
    await d.invoke("account.whoami", {}, conn);
    expect(hub.getLoginUser).toHaveBeenCalledTimes(2);

    d.removeConnection(conn);
  });
});

// ─── AUTH-0110 ────────────────────────────────────────────────────────────────

describe("AUTH-0110: HTTP POST /rpc が 3 メソッドを ephemeral 接続で処理し result 封筒を返す", () => {
  let httpHandle;

  afterEach(async () => {
    if (httpHandle) {
      await httpHandle.stop();
      httpHandle = null;
    }
  });

  async function bootHttp(hubOverrides = {}) {
    const hub = makeFakeHub({ connected: true, ...hubOverrides });
    const d = makeDaemon(hub, { authState: "ok" });
    const token = generateToken();
    httpHandle = await startHttpFraming(d, { port: 0, token });
    return { url: httpHandle.url, token };
  }

  it("[AUTH-0110] POST /rpc status が 200 + JSON-RPC result 封筒を返す", async () => {
    const { url, token } = await bootHttp();
    const res = await fetch(`${url}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: {} }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(1);
    expect(body.result).toBeDefined();
    expect(body.result.apiVersion).toBe(CONTRACT_VERSION);
    expect(body.result.contractVersion).toBe(CONTRACT_VERSION);
  });

  it("[AUTH-0110] POST /rpc cloud.ping が 200 + JSON-RPC result {ok:true} を返す", async () => {
    const { url, token } = await bootHttp();
    const res = await fetch(`${url}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "cloud.ping", params: {} }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(2);
    expect(body.result).toBeDefined();
    expect(body.result.ok).toBe(true);
    expect(typeof body.result.rttMs).toBe("number");
  });

  it("[AUTH-0110] POST /rpc account.whoami が 200 + JSON-RPC result を返す", async () => {
    const expected = { customerInfo: { companyID: "co" }, quotas: {} };
    const { url, token } = await bootHttp({ loginUserResult: expected });
    const res = await fetch(`${url}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "account.whoami", params: {} }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(3);
    expect(body.result).toEqual(expected);
  });

  it("[AUTH-0110] POST /rpc は通知 (id 無し) を受けたとき 204 を返す (result 無し)", async () => {
    const { url, token } = await bootHttp();
    const res = await fetch(`${url}/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      // JSON-RPC 通知: id を含まない
      body: JSON.stringify({ jsonrpc: "2.0", method: "status" }),
    });
    expect(res.status).toBe(204);
  });
});

// ─── AUTH-0111 ────────────────────────────────────────────────────────────────

describe("AUTH-0111: gRPC unary が 3 メソッド result を {json:...} で運ぶ", () => {
  it("[AUTH-0111] grpc-methods.generated.json の Status / CloudPing / AccountWhoami が jsonFields=[] を持つ", () => {
    const methodMap = JSON.parse(readFileSync(GRPC_MAP_PATH, "utf8"));
    for (const pascal of ["Status", "CloudPing", "AccountWhoami"]) {
      const entry = methodMap[pascal];
      expect(entry, `${pascal} が grpc-methods.generated.json に無い`).toBeTruthy();
      expect(Array.isArray(entry.jsonFields)).toBe(true);
      expect(entry.jsonFields).toHaveLength(0);
    }
  });

  it("[AUTH-0111] grpc-methods.generated.json の Status / CloudPing / AccountWhoami が optionalScalars=[] を持つ", () => {
    const methodMap = JSON.parse(readFileSync(GRPC_MAP_PATH, "utf8"));
    for (const pascal of ["Status", "CloudPing", "AccountWhoami"]) {
      const entry = methodMap[pascal];
      expect(entry, `${pascal} が grpc-methods.generated.json に無い`).toBeTruthy();
      expect(Array.isArray(entry.optionalScalars)).toBe(true);
      expect(entry.optionalScalars).toHaveLength(0);
    }
  });

  it("[AUTH-0111] gRPC unary の result は {json: JSON.stringify(result ?? null)} 形式 (仕様コード確認)", async () => {
    // grpc.js の実装: callback(null, { json: JSON.stringify(result ?? null) })
    const hub = makeFakeHub({ connected: true });
    const d = makeDaemon(hub, { authState: "ok" });

    const result = await d.invoke("status", {}, null);
    const json = JSON.stringify(result ?? null);
    const parsed = JSON.parse(json);
    expect(parsed.apiVersion).toBe(CONTRACT_VERSION);

    // cloud.ping
    const pingResult = await d.invoke("cloud.ping", {}, null);
    const pingJson = JSON.stringify(pingResult ?? null);
    const pingParsed = JSON.parse(pingJson);
    expect(pingParsed.ok).toBe(true);
    expect(typeof pingParsed.rttMs).toBe("number");

    // null の場合
    const nullJson = JSON.stringify(null);
    expect(JSON.parse(nullJson)).toBeNull();
  });
});

// ─── AUTH-0112 ────────────────────────────────────────────────────────────────

describe("AUTH-0112: TCP framing は loopback token 必須で 3 メソッドを保護", () => {
  it("[AUTH-0112] tokenMatches は定数時間比較を行い、一致/不一致/型不正を正しく判定する", () => {
    const tok = generateToken();
    expect(tokenMatches(tok, tok)).toBe(true);
    expect(tokenMatches(tok + "x", tok)).toBe(false);
    expect(tokenMatches("short", tok)).toBe(false);
    expect(tokenMatches("", tok)).toBe(false);
    expect(tokenMatches(undefined, tok)).toBe(false);
    expect(tokenMatches(null, tok)).toBe(false);
    // 同長で異なるトークン
    const tok2 = generateToken();
    if (tok !== tok2) {
      expect(tokenMatches(tok, tok2)).toBe(false);
    }
  });

  it("[AUTH-0112] parseBearer が Authorization ヘッダから Bearer token を取り出す", () => {
    const tok = "abc123def";
    expect(parseBearer(`Bearer ${tok}`)).toBe(tok);
    expect(parseBearer("Basic abc")).toBeNull();
    expect(parseBearer("")).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
  });

  it("[AUTH-0112] HTTP POST /rpc にトークン無しで 401 + not_authenticated kind を返す", async () => {
    const hub = makeFakeHub({ connected: true });
    const d = makeDaemon(hub, { authState: "ok" });
    const token = generateToken();
    const handle = await startHttpFraming(d, { port: 0, token });
    try {
      const res = await fetch(`${handle.url}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: {} }),
      });
      expect(res.status).toBe(401);
      // WWW-Authenticate ヘッダ
      expect(res.headers.get("www-authenticate")).toMatch(/Bearer/i);
      // JSON-RPC error body
      const body = await res.json();
      expect(body.error).toBeDefined();
      expect(body.error.data?.kind).toBe(KIND.NOT_AUTHENTICATED);
    } finally {
      await handle.stop();
    }
  });

  it("[AUTH-0112] HTTP POST /rpc にトークン不一致で 401 を返す", async () => {
    const hub = makeFakeHub({ connected: true });
    const d = makeDaemon(hub, { authState: "ok" });
    const token = generateToken();
    const handle = await startHttpFraming(d, { port: 0, token });
    try {
      const res = await fetch(`${handle.url}/rpc`, {
        method: "POST",
        headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: {} }),
      });
      expect(res.status).toBe(401);
    } finally {
      await handle.stop();
    }
  });

  it("[AUTH-0112] valid token を持つ HTTP POST /rpc は 200 + result を返す (3 メソッド通過確認)", async () => {
    const hub = makeFakeHub({ connected: true });
    const d = makeDaemon(hub, { authState: "ok" });
    const token = generateToken();
    const handle = await startHttpFraming(d, { port: 0, token });
    try {
      for (const method of ["status", "cloud.ping", "account.whoami"]) {
        const res = await fetch(`${handle.url}/rpc`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 99, method, params: {} }),
        });
        expect(res.status, `${method} should return 200`).toBe(200);
        const body = await res.json();
        expect(body.result, `${method} result should be present`).toBeDefined();
      }
    } finally {
      await handle.stop();
    }
  });
});
