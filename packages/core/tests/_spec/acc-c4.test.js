// ACC-0076 〜 ACC-0084 の単体テスト (統合版: writer A + B 精査・採用)
//
// 対象:
//   ACC-0076: access CLI は withHub を使う (withAccount/refreshAccount 往復なし)
//   ACC-0077: ja/en メッセージカタログ完全性 (access.* キー)
//   ACC-0078: passcodes name — 非 v4 keyBoardPassCodeNameUUID 警告未実装 (cards name との非対称)
//   ACC-0079: postAuthenticationData の wire キー正準出典 = AuthenticationDataWrapper.kt @SerializedName
//   ACC-0080: makeBiometricsTransport 互換経路 — Authorization ヘッダのみ (SigV4/x-api-key 無し)
//   ACC-0081: makeBiometricsTransport — appIdentifyId/config/configStore を無視 (appidentifyid ヘッダ不付与)
//   ACC-0082: withSuffix — operation 欠落で badRequest('access.err.operationRequired') throw
//   ACC-0083: makeBiometricsTransport — fetchImpl 非関数で badRequest('access.err.fetchRequired') throw
//   ACC-0084: postBiometrics — transport が status を持たない unwrap 済み body を返す場合は bypass
//
// 規約:
//   - 各 it タイトル先頭に [ACC-XXXX] を置く
//   - assert は spec の assert フィールドに従う (実装に歪めない)
//   - ネットワーク/実機なし、全て mock / 純関数

import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";

// ---- core 実装 ----
import {
  makeBiometricsTransport,
  postAuthenticationData,
  putAuthenticationData,
  deleteAuthenticationData,
} from "../../src/access.js";

// ---- kit CLI ----
import { registerAccessCommands } from "../../../kit/src/cli/access.js";

// ---- i18n カタログ直接参照 (ACC-0077) ----
import accessI18n from "../../src/i18n/access.js";

// ─────────────────────────────────────────────────────────────────────────────
// 共有 helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * fake hub — access auth-data 系メソッドを spy で差し替える。
 * @param {object} [overrides]
 */
function makeFakeHub(overrides = {}) {
  return {
    access: {
      getCards: vi.fn(async () => ({ items: [], byDevice: {} })),
      delCards: vi.fn(() => undefined),
      clearCards: vi.fn(async () => ({ ok: true })),
      updateCardName: vi.fn(async () => ({ ok: true })),
      updateCardOwner: vi.fn(async () => ({ ok: true })),
      postCards: vi.fn(async () => ({ ok: true })),
      getPasscodes: vi.fn(async () => ({ items: [], byDevice: {} })),
      delPasscodes: vi.fn(() => undefined),
      clearPasscodes: vi.fn(async () => ({ ok: true })),
      updatePasscodeName: vi.fn(async () => ({ ok: true })),
      postPasscodes: vi.fn(async () => ({ ok: true })),
    },
    postAuthenticationData: vi.fn(async () => ({ ok: true })),
    putAuthenticationData: vi.fn(async () => ({ ok: true })),
    deleteAuthenticationData: vi.fn(async () => ({ ok: true })),
    updateAuthenticationName: vi.fn(async () => ({ ok: true })),
    listDevices: vi.fn(async () => []),
    registerCards: vi.fn(async () => ({ ok: true })),
    registerPasscodes: vi.fn(async () => ({ ok: true })),
    refreshAccount: vi.fn(async () => ({})),
    ...overrides,
  };
}

/**
 * fake ctx。
 * withHub: fn(hub, {opts:{json:true}}) を即呼び出し、'withHub' を calls に記録。
 * withAccount: refreshAccount を呼んだ後に fn へ委譲し、'withAccount' を calls に記録。
 * @param {ReturnType<makeFakeHub>} hub
 */
function makeCtx(hub) {
  const outputs = [];
  const calls = [];
  const ctx = {
    outputs,
    calls,
    out: (_json, _humanFn, jsonObj) => { outputs.push(jsonObj); },
    die: (msg, code) => { const e = new Error(msg); e.code = code; throw e; },
    canPrompt: () => false,
    withHub: (fn) => {
      calls.push("withHub");
      return fn(hub, { opts: { json: true } });
    },
    withAccount: async (fn) => {
      calls.push("withAccount");
      const customerInfo = await hub.refreshAccount();
      return fn(hub, { opts: { json: true }, customerInfo });
    },
    parseJson: (raw, _hint) => {
      try { return JSON.parse(raw); } catch { return undefined; }
    },
    prompts: {
      selectFromList: vi.fn(async () => null),
      promptText: vi.fn(async () => ""),
      confirm: vi.fn(async () => false),
      promptLine: vi.fn(async () => ""),
    },
    makeBle: vi.fn(() => { throw new Error("BLE not supported in this test"); }),
  };
  return { ctx, outputs, calls };
}

async function runCli(ctx, args) {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerAccessCommands(program, ctx);
  await program.parseAsync(args, { from: "user" });
}

/** fetchImpl: calls[] にキャプチャし 200 を返す。 */
function captureFetch(calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    return { status: 200, text: async () => JSON.stringify({ data: { items: [] } }) };
  };
}

/** 注入 transport: req をキャプチャして 200 + json を返す。 */
function captureTransport(calls) {
  return async (req) => {
    calls.push(req);
    return { status: 200, json: { data: { items: [] } }, text: "{}" };
  };
}

const FAKE_CREDENTIALS_PROVIDER = {
  getCredentials: async () => ({
    accessKeyId: "ASIATEST",
    secretAccessKey: "secret",
    sessionToken: "TOKEN",
    expiration: new Date(Date.now() + 3_600_000),
    identityId: "ap-northeast-1:test",
  }),
};

// ─────────────────────────────────────────────────────────────────────────────
// [ACC-0076] access CLI は withHub を使う (withAccount/refreshAccount 往復なし)
// ref: packages/kit/src/cli/access.js:12-23,616,639,661,685; packages/kit/src/cli/ctx.js:118-135,219-222
// ─────────────────────────────────────────────────────────────────────────────
describe("[ACC-0076] access auth-data / cards / passcodes は withHub を使い withAccount を使わない", () => {
  it("[ACC-0076] auth-data post は ctx.withHub を呼び ctx.withAccount を呼ばない", async () => {
    const hub = makeFakeHub();
    const { ctx, calls } = makeCtx(hub);

    await runCli(ctx, [
      "access", "auth-data", "post",
      "--operation", "nfc_card",
      "--device-id", "dev-1",
      "--items", "[]",
    ]);

    expect(calls).toContain("withHub");
    expect(calls).not.toContain("withAccount");
    expect(hub.refreshAccount).not.toHaveBeenCalled();
  });

  it("[ACC-0076] auth-data put は ctx.withHub のみ使う", async () => {
    const hub = makeFakeHub();
    const { ctx, calls } = makeCtx(hub);

    await runCli(ctx, [
      "access", "auth-data", "put",
      "--operation", "nfc_card",
      "--device-id", "dev-1",
      "--items", "[]",
    ]);

    expect(calls).toContain("withHub");
    expect(calls).not.toContain("withAccount");
    expect(hub.refreshAccount).not.toHaveBeenCalled();
  });

  it("[ACC-0076] auth-data delete は ctx.withHub のみ使う", async () => {
    const hub = makeFakeHub();
    const { ctx, calls } = makeCtx(hub);

    await runCli(ctx, [
      "access", "auth-data", "delete",
      "--operation", "nfc_card",
      "--device-id", "dev-1",
      "--items", "[]",
    ]);

    expect(calls).toContain("withHub");
    expect(calls).not.toContain("withAccount");
    expect(hub.refreshAccount).not.toHaveBeenCalled();
  });

  it("[ACC-0076] auth-data name は ctx.withHub のみ使う", async () => {
    const hub = makeFakeHub();
    const { ctx, calls } = makeCtx(hub);

    await runCli(ctx, [
      "access", "auth-data", "name",
      "--kind", "card",
    ]);

    expect(calls).toContain("withHub");
    expect(calls).not.toContain("withAccount");
    expect(hub.refreshAccount).not.toHaveBeenCalled();
  });

  it("[ACC-0076] passcodes name は ctx.withHub のみ使う (companyID/subUUID 不要)", async () => {
    const hub = makeFakeHub();
    const { ctx, calls } = makeCtx(hub);

    await runCli(ctx, [
      "access", "passcodes", "name",
      "--json", '{"stpDeviceUUID":"u1","keyBoardPassCode":"010203","keyBoardPassCodeNameUUID":"11111111-1111-4111-8111-111111111111","name":"pc"}',
    ]);

    expect(calls).toContain("withHub");
    expect(calls).not.toContain("withAccount");
    expect(hub.refreshAccount).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [ACC-0077] ja/en メッセージカタログ完全性 (access.* キー)
// ref: packages/kit/src/cli/access.js:98-693; packages/core/src/i18n/access.js:3-222
// ─────────────────────────────────────────────────────────────────────────────
describe("[ACC-0077] access i18n カタログ完全性 (ja/en キーパリティ)", () => {
  it("[ACC-0077] en カタログと ja カタログのキー集合が一致する (欠落なし)", () => {
    const enKeys = Object.keys(accessI18n.en).sort();
    const jaKeys = Object.keys(accessI18n.ja).sort();

    const missingInJa = enKeys.filter((k) => !accessI18n.ja[k]);
    const missingInEn = jaKeys.filter((k) => !accessI18n.en[k]);

    expect(missingInJa, "en にあるが ja に無いキー").toEqual([]);
    expect(missingInEn, "ja にあるが en に無いキー").toEqual([]);
    expect(enKeys).toEqual(jaKeys);
  });

  it("[ACC-0077] en カタログが 101 キーを持つ (authData 含む全カテゴリ parity 確認)", () => {
    // spec note: en(3-112)/ja(113-222) 各 101 キー
    const count = Object.keys(accessI18n.en).length;
    expect(count).toBe(101);
  });

  it("[ACC-0077] ja カタログが 101 キーを持つ", () => {
    const count = Object.keys(accessI18n.ja).length;
    expect(count).toBe(101);
  });

  it("[ACC-0077] en に access.err.fetchRequired キーが存在する", () => {
    expect(accessI18n.en["access.err.fetchRequired"]).toBeTruthy();
  });

  it("[ACC-0077] ja に access.err.fetchRequired キーが存在する", () => {
    expect(accessI18n.ja["access.err.fetchRequired"]).toBeTruthy();
  });

  it("[ACC-0077] en に access.err.operationRequired キーが存在する", () => {
    expect(accessI18n.en["access.err.operationRequired"]).toBeTruthy();
  });

  it("[ACC-0077] ja に access.err.operationRequired キーが存在する", () => {
    expect(accessI18n.ja["access.err.operationRequired"]).toBeTruthy();
  });

  it("[ACC-0077] en に access.err.biometricsAuthorizationRequired が存在する", () => {
    expect(accessI18n.en["access.err.biometricsAuthorizationRequired"]).toBeTruthy();
  });

  it("[ACC-0077] ja に access.err.biometricsAuthorizationRequired が存在する", () => {
    expect(accessI18n.ja["access.err.biometricsAuthorizationRequired"]).toBeTruthy();
  });

  it("[ACC-0077] en に access.cmd.authData キーが存在する", () => {
    expect(accessI18n.en["access.cmd.authData"]).toBeTruthy();
  });

  it("[ACC-0077] ja に access.cmd.authData キーが存在する", () => {
    expect(accessI18n.ja["access.cmd.authData"]).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [ACC-0078] passcodes name: 非 v4 keyBoardPassCodeNameUUID 警告未実装 (cards name との非対称)
// ref: packages/kit/src/cli/access.js:513-531; packages/kit/src/cli/access.js:331-338
// 仕様どおりの正しい挙動 (警告を出す) を assert する (TDD red)
// ─────────────────────────────────────────────────────────────────────────────
describe("[ACC-0078] passcodes name: 非v4 keyBoardPassCodeNameUUID で stderr 警告を出すべき (cards name と対称)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("[ACC-0078] 非v4 keyBoardPassCodeNameUUID のとき stderr に警告を出す (spec: あるべき挙動、TDD red)", async () => {
    // 非v4 UUID: version nibble が '4' でない (version=1)
    const NON_V4_UUID = "11111111-1111-1111-8111-111111111111";
    const hub = makeFakeHub();
    const { ctx } = makeCtx(hub);

    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await runCli(ctx, [
        "access", "passcodes", "name",
        "--json", JSON.stringify({
          stpDeviceUUID: "dev-1",
          keyBoardPassCode: "010203",
          keyBoardPassCodeNameUUID: NON_V4_UUID,
          name: "test",
        }),
      ]);
      // spec: 非v4 で警告を出しつつ処理は続行 (cards name の ACC-0064 と対称)
      // 現状実装は警告を出さない (非対称) — これは red になる TDD テスト
      expect(stderrSpy, "passcodes name should warn for non-v4 keyBoardPassCodeNameUUID (mirrors cards name)").toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("[ACC-0078] 非v4 警告は処理を中断せず updatePasscodeName を呼ぶ (続行する)", async () => {
    const NON_V4_UUID = "11111111-1111-1111-8111-111111111111";
    const hub = makeFakeHub();
    const { ctx } = makeCtx(hub);

    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await runCli(ctx, [
        "access", "passcodes", "name",
        "--json", JSON.stringify({
          stpDeviceUUID: "dev-1",
          keyBoardPassCode: "010203",
          keyBoardPassCodeNameUUID: NON_V4_UUID,
          name: "test",
        }),
      ]);
      // 処理は続行し updatePasscodeName が呼ばれる
      expect(hub.access.updatePasscodeName).toHaveBeenCalledOnce();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("[ACC-0078] v4 UUID のとき stderr 警告は出ない (正常パス)", async () => {
    const V4_UUID = "11111111-1111-4111-8111-111111111111"; // version=4
    const hub = makeFakeHub();
    const { ctx } = makeCtx(hub);

    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await runCli(ctx, [
        "access", "passcodes", "name",
        "--json", JSON.stringify({
          stpDeviceUUID: "dev-1",
          keyBoardPassCode: "010203",
          keyBoardPassCodeNameUUID: V4_UUID,
          name: "test",
        }),
      ]);
      expect(stderrSpy).not.toHaveBeenCalled();
      expect(hub.access.updatePasscodeName).toHaveBeenCalledOnce();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("[ACC-0078] cards name は非v4 cardNameUUID で stderr 警告を出す (対比: 現在実装済み)", async () => {
    // access.js:331-338 — cards name は isUuidV4 で判定し非 v4 なら stderr 警告
    const NON_V4_UUID = "11111111-1111-1111-8111-111111111111";
    const hub = makeFakeHub();
    const { ctx } = makeCtx(hub);

    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await runCli(ctx, [
        "access", "cards", "name",
        "--json", JSON.stringify({
          cardID: "C1",
          name: "test",
          cardNameUUID: NON_V4_UUID,
          stpDeviceUUID: "dev-1",
        }),
      ]);
      // cards name は警告を出す (access.js:331-338)
      expect(stderrSpy).toHaveBeenCalled();
      const warnMsg = stderrSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(warnMsg).toMatch(/SSM_OS3_CARD_CHANGE|v4|UUID/i);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [ACC-0079] postAuthenticationData wire キー正準出典 = AuthenticationDataWrapper.kt @SerializedName
// ref: packages/core/src/access.js:683-687; _sesame_sdk_ref/.../AuthenticationDataWrapper.kt:6-8
// ─────────────────────────────────────────────────────────────────────────────
describe("[ACC-0079] postAuthenticationData wire キー正準 (op/deviceID/items = @SerializedName)", () => {
  it("[ACC-0079] POST body は op/deviceID/items の 3 キーを持つ (Kotlin @SerializedName('op')/'deviceID'/'items')", async () => {
    const calls = [];
    await postAuthenticationData(null, {
      operation: "nfc_card",
      deviceID: "dev-abc",
      items: [{ id: "x1" }],
      transport: captureTransport(calls),
    });

    expect(calls).toHaveLength(1);
    const body = calls[0].body;
    expect(body).toHaveProperty("op");
    expect(body).toHaveProperty("deviceID");
    expect(body).toHaveProperty("items");
    // Kotlin property 'operation' は wire 上 'op' に化ける (@SerializedName)
    expect(body).not.toHaveProperty("operation");
    // Kotlin property 'credentialList' は wire 上 'items' に化ける
    expect(body).not.toHaveProperty("credentialList");
  });

  it("[ACC-0079] op は operation + '_post' の連結 (wire 名 'op' が suffix 連結対象)", async () => {
    const calls = [];
    await postAuthenticationData(null, {
      operation: "nfc_card",
      deviceID: "dev-abc",
      items: [],
      transport: captureTransport(calls),
    });
    expect(calls[0].body.op).toBe("nfc_card_post");
  });

  it("[ACC-0079] deviceID は Kotlin property 名そのまま (wire 上も 'deviceID')", async () => {
    const calls = [];
    await postAuthenticationData(null, {
      operation: "nfc_card",
      deviceID: "device-xyz",
      items: [],
      transport: captureTransport(calls),
    });
    expect(calls[0].body.deviceID).toBe("device-xyz");
  });

  it("[ACC-0079] items は Kotlin property 'credentialList' が wire 上 'items' に化けた形", async () => {
    const items = [{ type: "nfc", id: "c1" }];
    const calls = [];
    await postAuthenticationData(null, {
      operation: "nfc_card",
      deviceID: "dev-1",
      items,
      transport: captureTransport(calls),
    });
    expect(calls[0].body.items).toEqual(items);
  });

  it("[ACC-0079] putAuthenticationData も同じ wire キー構造 (op/deviceID/items、op = operation + '_put')", async () => {
    const calls = [];
    await putAuthenticationData(null, {
      operation: "nfc_card",
      deviceID: "dev-1",
      items: [],
      transport: captureTransport(calls),
    });
    const body = calls[0].body;
    expect(body).toHaveProperty("op");
    expect(body).toHaveProperty("deviceID");
    expect(body).toHaveProperty("items");
    expect(body).not.toHaveProperty("operation");
    expect(body.op).toBe("nfc_card_put");
  });

  it("[ACC-0079] deleteAuthenticationData も同じ wire キー構造 (op/deviceID/items、op = operation + '_delete')", async () => {
    const calls = [];
    await deleteAuthenticationData(null, {
      operation: "palm",
      deviceID: "d3",
      items: [],
      transport: captureTransport(calls),
    });
    const body = calls[0].body;
    expect(body).toHaveProperty("op");
    expect(body).toHaveProperty("deviceID");
    expect(body).toHaveProperty("items");
    expect(body.op).toBe("palm_delete");
    expect(body).not.toHaveProperty("operation");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [ACC-0080] makeBiometricsTransport 互換経路: Authorization ヘッダのみ (SigV4/x-api-key 無し)
// ref: packages/core/src/access.js:207-227; packages/core/src/access.js:74-80
// ─────────────────────────────────────────────────────────────────────────────
describe("[ACC-0080] makeBiometricsTransport 互換経路: Authorization ヘッダのみ (x-api-key/SigV4 無し)", () => {
  it("[ACC-0080] authorization 文字列指定: そのまま authorization ヘッダに載る (x-api-key/x-amz-date 無し)", async () => {
    const fetchCalls = [];
    const transport = makeBiometricsTransport({
      baseUrl: "https://api.example.test",
      authorization: "Bearer my-token",
      fetchImpl: captureFetch(fetchCalls),
    });

    await transport({ method: "POST", path: "/device/v1/biometrics", body: { op: "x" } });

    expect(fetchCalls).toHaveLength(1);
    const headers = fetchCalls[0].init.headers;
    expect(headers["authorization"]).toBe("Bearer my-token");
    // SigV4 の特徴ヘッダが無いこと
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["x-amz-date"]).toBeUndefined();
    expect(headers["x-amz-security-token"]).toBeUndefined();
    // content-type は互換経路でも付与される
    expect(headers["content-type"]).toBe("application/json");
  });

  it("[ACC-0080] bearerToken 指定: 'Bearer ' を前置した Authorization ヘッダになる", async () => {
    const fetchCalls = [];
    const transport = makeBiometricsTransport({
      baseUrl: "https://api.example.test",
      bearerToken: "my-raw-token",
      fetchImpl: captureFetch(fetchCalls),
    });

    await transport({ method: "POST", path: "/device/v1/biometrics", body: { op: "x" } });

    expect(fetchCalls).toHaveLength(1);
    const headers = fetchCalls[0].init.headers;
    expect(headers["authorization"]).toBe("Bearer my-raw-token");
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("[ACC-0080] authorizationProvider 関数: 都度解決した値が authorization ヘッダになる", async () => {
    const fetchCalls = [];
    let callCount = 0;
    const authorizationProvider = async () => {
      callCount++;
      return `Bearer provider-token-${callCount}`;
    };
    const transport = makeBiometricsTransport({
      baseUrl: "https://api.example.test",
      authorizationProvider,
      fetchImpl: captureFetch(fetchCalls),
    });

    await transport({ method: "POST", path: "/device/v1/biometrics", body: { op: "a" } });
    await transport({ method: "POST", path: "/device/v1/biometrics", body: { op: "b" } });

    // 都度解決されることを確認
    expect(fetchCalls[0].init.headers["authorization"]).toBe("Bearer provider-token-1");
    expect(fetchCalls[1].init.headers["authorization"]).toBe("Bearer provider-token-2");
    expect(fetchCalls[0].init.headers["x-api-key"]).toBeUndefined();
  });

  it("[ACC-0080] 互換経路は content-type: application/json を付ける", async () => {
    const fetchCalls = [];
    const transport = makeBiometricsTransport({
      baseUrl: "https://api.example.test",
      authorization: "Bearer tok",
      fetchImpl: captureFetch(fetchCalls),
    });

    await transport({ method: "POST", path: "/device/v1/biometrics", body: { op: "x" } });

    expect(fetchCalls[0].init.headers["content-type"]).toBe("application/json");
  });

  it("[ACC-0080] authorization が優先 (bearerToken と両方あれば authorization を使う)", async () => {
    const fetchCalls = [];
    const transport = makeBiometricsTransport({
      baseUrl: "https://api.example.test",
      authorization: "Bearer explicit",
      bearerToken: "raw-token",
      fetchImpl: captureFetch(fetchCalls),
    });

    await transport({ method: "POST", path: "/device/v1/biometrics", body: { op: "x" } });

    expect(fetchCalls[0].init.headers["authorization"]).toBe("Bearer explicit");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [ACC-0081] makeBiometricsTransport: appIdentifyId/config/configStore を受理して無視
// ref: packages/core/src/access.js:177-204; CHAPIClient.kt:105-106
// ─────────────────────────────────────────────────────────────────────────────
describe("[ACC-0081] makeBiometricsTransport: appIdentifyId/config/configStore は受理されるが無視される", () => {
  it("[ACC-0081] appIdentifyId を渡しても appidentifyid ヘッダが付かない (SigV4 経路)", async () => {
    const fetchCalls = [];
    const transport = makeBiometricsTransport({
      baseUrl: "https://api.example.test",
      credentialsProvider: FAKE_CREDENTIALS_PROVIDER,
      appIdentifyId: "ap-northeast-1:some-identity",
      fetchImpl: captureFetch(fetchCalls),
    });

    await transport({ method: "POST", path: "/device/v1/biometrics", body: { op: "x" } });

    expect(fetchCalls).toHaveLength(1);
    const headers = fetchCalls[0].init.headers;
    // appidentifyid は CHAPIClient.kt:105-106 に存在しないため付けない
    expect(headers["appidentifyid"]).toBeUndefined();
    // SigV4 は付く (正準経路)
    expect(headers["authorization"]).toMatch(/^AWS4-HMAC-SHA256/);
  });

  it("[ACC-0081] config オプションを渡しても transport は構築できる (エラーにならない)", () => {
    expect(() => makeBiometricsTransport({
      baseUrl: "https://api.example.test",
      credentialsProvider: FAKE_CREDENTIALS_PROVIDER,
      // config は JSDoc 上「互換受理・無視」
      config: { someKey: "someValue" },
      fetchImpl: captureFetch([]),
    })).not.toThrow();
  });

  it("[ACC-0081] configStore オプションを渡しても transport は構築できる (エラーにならない)", () => {
    expect(() => makeBiometricsTransport({
      baseUrl: "https://api.example.test",
      credentialsProvider: FAKE_CREDENTIALS_PROVIDER,
      configStore: { load: () => ({}), exists: () => true },
      fetchImpl: captureFetch([]),
    })).not.toThrow();
  });

  it("[ACC-0081] appIdentifyId を渡しても SignedHeaders に appidentifyid が含まれない", async () => {
    const fetchCalls = [];
    const transport = makeBiometricsTransport({
      baseUrl: "https://api.example.test",
      credentialsProvider: FAKE_CREDENTIALS_PROVIDER,
      appIdentifyId: "ap-northeast-1:identity-id",
      fetchImpl: captureFetch(fetchCalls),
    });

    await transport({ method: "POST", path: "/device/v1/biometrics", body: { op: "x" } });

    const authHeader = fetchCalls[0].init.headers["authorization"] ?? "";
    const signedMatch = authHeader.match(/SignedHeaders=([^,]+)/);
    if (signedMatch) {
      expect(signedMatch[1]).not.toContain("appidentifyid");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [ACC-0082] withSuffix: operation 欠落で badRequest('access.err.operationRequired') throw
// ref: packages/core/src/access.js:244-247; packages/core/src/access.js:684,703,719
// ─────────────────────────────────────────────────────────────────────────────
describe("[ACC-0082] operation 欠落で badRequest を throw (post/put/delete 共通)", () => {
  it("[ACC-0082] postAuthenticationData: operation が undefined で throw", async () => {
    await expect(postAuthenticationData(null, {
      operation: undefined,
      deviceID: "dev-1",
      items: [],
      transport: captureTransport([]),
    })).rejects.toThrow(/operationRequired|operation/i);
  });

  it("[ACC-0082] postAuthenticationData: operation が空文字で throw", async () => {
    await expect(postAuthenticationData(null, {
      operation: "",
      deviceID: "dev-1",
      items: [],
      transport: captureTransport([]),
    })).rejects.toThrow(/operationRequired|operation/i);
  });

  it("[ACC-0082] postAuthenticationData: operation が null で throw", async () => {
    await expect(postAuthenticationData(null, {
      operation: null,
      deviceID: "dev-1",
      items: [],
      transport: captureTransport([]),
    })).rejects.toThrow(/operationRequired|operation/i);
  });

  it("[ACC-0082] putAuthenticationData: operation 欠落 (undefined) で throw", async () => {
    await expect(putAuthenticationData(null, {
      operation: undefined,
      deviceID: "dev-1",
      items: [],
      transport: captureTransport([]),
    })).rejects.toThrow(/operationRequired|operation/i);
  });

  it("[ACC-0082] deleteAuthenticationData: operation 欠落 (undefined) で throw", async () => {
    await expect(deleteAuthenticationData(null, {
      operation: undefined,
      deviceID: "dev-1",
      items: [],
      transport: captureTransport([]),
    })).rejects.toThrow(/operationRequired|operation/i);
  });

  it("[ACC-0082] operation が正常値のときは throw しない (正常パス確認)", async () => {
    const calls = [];
    await expect(postAuthenticationData(null, {
      operation: "nfc_card",
      deviceID: "dev-1",
      items: [],
      transport: captureTransport(calls),
    })).resolves.not.toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0].body.op).toBe("nfc_card_post");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [ACC-0083] makeBiometricsTransport: fetchImpl 非関数で badRequest('access.err.fetchRequired')
// ref: packages/core/src/access.js:187; packages/core/src/i18n/access.js:109,219
// ─────────────────────────────────────────────────────────────────────────────
describe("[ACC-0083] makeBiometricsTransport: fetchImpl 非関数で badRequest (fetchRequired)", () => {
  it("[ACC-0083] fetchImpl が undefined かつ globalThis.fetch が無い環境で throw (JS destructuring default が無効になる条件)", () => {
    // fetchImpl: undefined は JS destructuring で default (globalThis.fetch) が適用される。
    // globalThis.fetch が存在する環境 (Node.js 20+) では throw しない。
    // fetch が存在しない環境では guard が発火する。
    // テスト環境では globalThis.fetch が存在するため、null を使って非関数性をテストする。
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = undefined;
      // fetchImpl を明示的に undefined にしても JS destructuring default が適用されるため
      // globalThis.fetch が無効な場合のみ guard が発火する
      // Note: { fetchImpl: undefined } → destructuring default = globalThis.fetch = undefined → throw
      expect(() => makeBiometricsTransport({
        baseUrl: "https://api.example.test",
        credentialsProvider: FAKE_CREDENTIALS_PROVIDER,
        fetchImpl: undefined,
      })).toThrow(/fetchRequired|fetch/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("[ACC-0083] fetchImpl が null で throw", () => {
    expect(() => makeBiometricsTransport({
      baseUrl: "https://api.example.test",
      credentialsProvider: FAKE_CREDENTIALS_PROVIDER,
      fetchImpl: null,
    })).toThrow(/fetchRequired|fetch/i);
  });

  it("[ACC-0083] fetchImpl が文字列で throw (typeof !== 'function')", () => {
    expect(() => makeBiometricsTransport({
      baseUrl: "https://api.example.test",
      credentialsProvider: FAKE_CREDENTIALS_PROVIDER,
      fetchImpl: "https://fetch.polyfill",
    })).toThrow(/fetchRequired|fetch/i);
  });

  it("[ACC-0083] fetchImpl が数値で throw", () => {
    expect(() => makeBiometricsTransport({
      baseUrl: "https://api.example.test",
      credentialsProvider: FAKE_CREDENTIALS_PROVIDER,
      fetchImpl: 42,
    })).toThrow(/fetchRequired|fetch/i);
  });

  it("[ACC-0083] fetchImpl が関数のときは throw しない (正常パス)", () => {
    expect(() => makeBiometricsTransport({
      baseUrl: "https://api.example.test",
      credentialsProvider: FAKE_CREDENTIALS_PROVIDER,
      fetchImpl: async () => ({ status: 200, text: async () => "{}" }),
    })).not.toThrow();
  });

  it("[ACC-0083] fetchRequired は認可ソース guard より前に発火する最前段 guard", () => {
    // 認可ソース (credentialsProvider) も無い状態で fetchImpl が非関数 → fetchRequired が先に throw
    expect(() => makeBiometricsTransport({
      baseUrl: "https://api.example.test",
      fetchImpl: null,
      // credentialsProvider も無し: 本来なら biometricsAuthorizationRequired になるが
      // fetchRequired が先
    })).toThrow(/fetchRequired|fetch/i);
  });

  it("[ACC-0083] globalThis.fetch が無く fetchImpl も省略した場合は throw", () => {
    // globalThis.fetch が存在しない環境をシミュレート
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = undefined;
      expect(() => makeBiometricsTransport({
        credentialsProvider: FAKE_CREDENTIALS_PROVIDER,
        // fetchImpl 省略 → globalThis.fetch が既定値 → undefined → throw
      })).toThrow(/fetchRequired|fetch/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [ACC-0084] postBiometrics: transport が status 非 number を返す場合は assertHttpOk をスキップして bypass
// ref: packages/core/src/access.js:250-256
// ─────────────────────────────────────────────────────────────────────────────
describe("[ACC-0084] postBiometrics: transport が status 非number を返すと assertHttpOk をスキップして透過", () => {
  it("[ACC-0084] transport が null を返すと assertHttpOk をスキップし undefined が返る", async () => {
    // transport が null を返す → if(!res || ...) return res → null が透過
    // postAuthenticationData は resp?.data?.items → null?.data?.items → undefined
    const transport = async () => null;
    const result = await postAuthenticationData(null, {
      operation: "nfc_card",
      deviceID: "dev-1",
      items: [],
      transport,
    });
    expect(result).toBeUndefined();
  });

  it("[ACC-0084] transport が {data:{items:[...]}} を直接返す (status 無し) と body が透過される", async () => {
    const items = [{ type: "nfc", id: "card-1" }];
    // status を持たない unwrap 済み body を返す注入 transport
    const transport = async () => ({ data: { items } });
    const result = await postAuthenticationData(null, {
      operation: "nfc_card",
      deviceID: "dev-1",
      items: [],
      transport,
    });
    // bypass 経路: res = { data: { items } } → typeof res.status !== 'number' → return res
    // postAuthenticationData: return resp?.data?.items → items
    expect(result).toEqual(items);
  });

  it("[ACC-0084] transport が {status:200, json:{data:{items:[...]}}} を返す通常経路では assertHttpOk を通る", async () => {
    const items = [{ type: "nfc", id: "card-2" }];
    const transport = async () => ({
      status: 200,
      json: { data: { items } },
      text: JSON.stringify({ data: { items } }),
    });
    const result = await postAuthenticationData(null, {
      operation: "nfc_card",
      deviceID: "dev-1",
      items: [],
      transport,
    });
    expect(result).toEqual(items);
  });

  it("[ACC-0084] transport が {status:500, json:{message:'err'}} を返す通常経路では assertHttpOk が throw", async () => {
    const transport = async () => ({
      status: 500,
      json: { message: "internal error" },
      text: '{"message":"internal error"}',
    });
    await expect(postAuthenticationData(null, {
      operation: "nfc_card",
      deviceID: "dev-1",
      items: [],
      transport,
    })).rejects.toThrow(/500|internal error/i);
  });

  it("[ACC-0084] status が文字列 '200' でも bypass 分岐が発火する (typeof !== 'number')", async () => {
    // status が文字列 → typeof !== 'number' → bypass (assertHttpOk スキップ)
    const transport = async () => ({ status: "200", data: { items: [] } });
    await expect(postAuthenticationData(null, {
      operation: "nfc_card",
      deviceID: "dev-1",
      items: [],
      transport,
    })).resolves.not.toThrow();
  });

  it("[ACC-0084] putAuthenticationData でも同じ bypass 分岐が働く (status 無し body 透過)", async () => {
    // putAuthenticationData は postBiometrics の戻りをそのまま返す (resp?.data?.items ラップ無し)
    const unwrappedBody = { someKey: "someValue" };
    const transport = async () => unwrappedBody; // status 無し
    const result = await putAuthenticationData(null, {
      operation: "nfc_card",
      deviceID: "dev-1",
      items: [],
      transport,
    });
    // bypass: return res = unwrappedBody
    expect(result).toEqual(unwrappedBody);
  });

  it("[ACC-0084] deleteAuthenticationData でも同じ bypass 分岐が働く", async () => {
    const unwrappedBody = { deleted: true };
    const transport = async () => unwrappedBody;
    const result = await deleteAuthenticationData(null, {
      operation: "nfc_card",
      deviceID: "dev-1",
      items: [],
      transport,
    });
    expect(result).toEqual(unwrappedBody);
  });
});
