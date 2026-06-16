// spec/auth-cli.md AUTHC-0001 〜 AUTHC-0018 の TDD テスト (統合版)
// 実装: packages/kit/src/cli/auth.js, packages/kit/src/cli/ctx.js
// 実行可能・self-contained・決定論的 (ネットワーク/実機不使用、全 mock)
//
// 方針: B の module-level vi.mock 方式を基本とし、A の detail 検証を統合。
// 各 it は [ID] タグを先頭に置く。TDD: red は許容、クラッシュは不可。
//
// 注意: vi.mock の factory で new が使われるため、mockImplementationOnce には
//       arrow function 不可 → function 式を使う。

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SesameError, ERR } from "@sesame-kit/core/errors";

// ──────────────────────────────────────────────────────────────────────────────
// モジュールモック (vi.mock は hoist されるため先頭に列挙)
// ──────────────────────────────────────────────────────────────────────────────

vi.mock("@sesame-kit/core/auth", () => ({
  loginInitiate: vi.fn(async () => {}),
  loginVerify: vi.fn(async () => ({
    clientId: "mock-clientId",
    username: "mock-user",
    deviceKey: "mock-devkey",
  })),
  getValidIdToken: vi.fn(async () => "mock.id.token.xxxxxxxxxxxxxxxxxxxx"),
  logout: vi.fn(async () => ({ forgotDevice: true, revokedToken: true })),
  bootstrap: vi.fn(() => ({ clientId: "6ialca0p8u0lsgvbmvsljfm305" })),
}));

vi.mock("@sesame-kit/core/i18n", () => ({
  t: (key, _vars) => key,
  tr: (key, _vars) => key,
  setLocale: vi.fn(),
}));

// ConfigStore: function キーワードでコンストラクタとして機能させる
vi.mock("@sesame-kit/core/config", () => ({
  ConfigStore: vi.fn(function() {
    return {
      exists: vi.fn(() => true),
      load: vi.fn(() => ({ hub3s: {} })),
      save: vi.fn(),
    };
  }),
}));

// FileTokenStore: function キーワードでコンストラクタとして機能させる
vi.mock("@sesame-kit/core/tokens", () => ({
  FileTokenStore: vi.fn(function() {
    return {
      load: vi.fn(() => null),
      loadPending: vi.fn(() => null),
      save: vi.fn(),
      savePending: vi.fn(),
      clear: vi.fn(),
      clearPending: vi.fn(),
    };
  }),
}));

vi.mock("@sesame-kit/core/paths", () => ({
  configPaths: vi.fn(() => ({
    dir: "/mock/dir",
    config: "/mock/dir/config.json",
    tokens: "/mock/dir/.tokens.json",
    loginState: "/mock/dir/.login_state.json",
  })),
}));

// SesameHub3: function キーワードでコンストラクタとして機能させる
vi.mock("@sesame-kit/core/client", () => ({
  SesameHub3: vi.fn(function() {
    return {
      connect: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      refreshAccount: vi.fn(async () => ({ companyID: "comp-123" })),
      getLoginUser: vi.fn(async () => ({ quotas: { seats: 5 } })),
      syncLocksFromDevices: vi.fn(async () => ({ added: [], updated: [], removed: [] })),
      syncHub3sFromDevices: vi.fn(async () => ({ added: [], updated: [] })),
      syncRemotesFromDevices: vi.fn(async () => ({ remotes: { added: [], updated: [] } })),
      syncRemoteKeys: vi.fn(async () => {}),
      ping: vi.fn(async () => {}),
    };
  }),
}));

vi.mock("../../src/prompts.js", async () => {
  const mod = await vi.importActual("../../src/prompts.js");
  return {
    ...mod,
    isInteractive: vi.fn(() => false),
    selectFromList: vi.fn(),
    promptText: vi.fn(),
    confirm: vi.fn(),
  };
});

// BLE モック (ctx.js が SesameBle を import するため)
vi.mock("@sesame-kit/core/ble", () => ({
  SesameBle: vi.fn(function() { return {}; }),
}));

// ──────────────────────────────────────────────────────────────────────────────
// 実装のインポート (モック後)
// ──────────────────────────────────────────────────────────────────────────────
import { loginInitiate, loginVerify, getValidIdToken, logout } from "@sesame-kit/core/auth";
import { SesameHub3 } from "@sesame-kit/core/client";
import { FileTokenStore } from "@sesame-kit/core/tokens";
import { cmdLogin, cmdVerify, cmdSetup, cmdRefresh, cmdLogout } from "../../src/cli/auth.js";
import { isInteractive } from "../../src/prompts.js";
import { setJsonMode } from "../../src/cli/errors.js";

// ──────────────────────────────────────────────────────────────────────────────
// ヘルパ
// ──────────────────────────────────────────────────────────────────────────────

/**
 * テスト用の最小 commander-like program オブジェクトを作る。
 */
function makeProgram(globalOpts = {}) {
  return {
    opts: () => ({ json: false, debug: false, configDir: undefined, ...globalOpts }),
  };
}

/**
 * process.exit を捕捉して throw に変換するヘルパ。
 * die() は process.exit() を呼ぶため、テストでは intercept する。
 */
function interceptExit() {
  const spy = vi.spyOn(process, "exit").mockImplementation((code) => {
    const err = new Error(`process.exit(${code})`);
    err.code = code;
    throw err;
  });
  return spy;
}

/**
 * console.log / console.error を spy して戻り値を集める。
 */
function captureConsole() {
  const logs = [];
  const errors = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
  const errSpy = vi.spyOn(console, "error").mockImplementation((...a) => errors.push(a.join(" ")));
  return { logs, errors, restore: () => { logSpy.mockRestore(); errSpy.mockRestore(); } };
}

/**
 * FileTokenStore の mockImplementationOnce ヘルパ。
 * new FileTokenStore() のコンストラクタ呼び出しを成立させるため function 式を使う。
 */
function mockTokenStoreOnce(tokenData) {
  vi.mocked(FileTokenStore).mockImplementationOnce(function() {
    return {
      load: vi.fn(() => tokenData),
      loadPending: vi.fn(() => null),
      save: vi.fn(),
      savePending: vi.fn(),
      clear: vi.fn(),
      clearPending: vi.fn(),
    };
  });
}

/**
 * SesameHub3 の mockImplementationOnce ヘルパ。function 式でコンストラクタ対応。
 */
function mockHub3Once(hubObj) {
  vi.mocked(SesameHub3).mockImplementationOnce(function() {
    return hubObj;
  });
}

// モック呼び出しカウントをテスト間でリセット (vi.mock で作った spy は共有される)
beforeEach(() => {
  vi.clearAllMocks();
  // isJsonMode のグローバル状態をリセット
  setJsonMode(false);
});

// ──────────────────────────────────────────────────────────────────────────────
// AUTHC-0001: login <email> 必須引数欠落で usage エラー (exit 2)
// ──────────────────────────────────────────────────────────────────────────────
describe("[AUTHC-0001] login <email> 必須引数欠落で usage エラー (exit 2)", () => {
  it("[AUTHC-0001] email 未指定で die(emailRequired, 2) を呼び loginInitiate に進まない", async () => {
    const exitSpy = interceptExit();
    const cap = captureConsole();
    try {
      await expect(cmdLogin(undefined, {}, makeProgram())).rejects.toMatchObject({ code: 2 });
      expect(loginInitiate).not.toHaveBeenCalled();
    } finally {
      cap.restore();
      exitSpy.mockRestore();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AUTHC-0002: login → loginInitiate(tokenStore, email) 配線
// ──────────────────────────────────────────────────────────────────────────────
describe("[AUTHC-0002] login → loginInitiate(tokenStore, email) 配線", () => {
  it("[AUTHC-0002] cmdLogin が tokenStore と email でちょうど一度 loginInitiate を呼ぶ", async () => {
    const cap = captureConsole();
    try {
      vi.mocked(loginInitiate).mockResolvedValueOnce(undefined);
      await cmdLogin("user@example.com", {}, makeProgram());
      expect(loginInitiate).toHaveBeenCalledOnce();
      expect(loginInitiate).toHaveBeenCalledWith(
        expect.objectContaining({ load: expect.any(Function) }),
        "user@example.com",
      );
    } finally {
      cap.restore();
      vi.mocked(loginInitiate).mockReset();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AUTHC-0003: login の --json 封筒 ({ok,email,next})
// ──────────────────────────────────────────────────────────────────────────────
describe("[AUTHC-0003] login の --json 封筒 ({ok,email,next})", () => {
  it("[AUTHC-0003] --json 時は stdout に {ok:true, email, next:'sesame verify <code>'} を出す", async () => {
    // auth.js の cmdLogin は out(isJsonMode(), ...) を使うため setJsonMode(true) が必要
    setJsonMode(true);
    const cap = captureConsole();
    try {
      await cmdLogin("a@b.com", {}, makeProgram({ json: true }));
      expect(cap.logs.length).toBeGreaterThan(0);
      const parsed = JSON.parse(cap.logs[0]);
      expect(parsed).toMatchObject({
        ok: true,
        email: "a@b.com",
        next: "sesame verify <code>",
      });
    } finally {
      cap.restore();
      setJsonMode(false);
    }
  });

  it("[AUTHC-0003] 非 --json 時は JSON.stringify を stdout に出さず humanFn を呼ぶ", async () => {
    // json:false → isJsonMode()=false のまま
    const cap = captureConsole();
    try {
      await cmdLogin("a@b.com", {}, makeProgram({ json: false }));
      for (const line of cap.logs) {
        let isJson = false;
        try { const p = JSON.parse(line); if (p && typeof p === "object" && "ok" in p) isJson = true; } catch {}
        expect(isJson).toBe(false);
      }
    } finally {
      cap.restore();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AUTHC-0004: verify [code] 省略時に TTY なら対話 prompt へフォールバック
// ──────────────────────────────────────────────────────────────────────────────
describe("[AUTHC-0004] verify [code] 省略時に TTY なら対話 prompt へフォールバック", () => {
  it("[AUTHC-0004] code 未指定かつ canPrompt() 真なら promptLine で入力値を code に充てる", async () => {
    vi.mocked(isInteractive).mockReturnValueOnce(true);
    // promptLine は ctx.js の export をスパイ (ctx.js はモックしていない実実装を使う)
    const ctxMod = await import("../../src/cli/ctx.js");
    const promptLineSpy = vi.spyOn(ctxMod, "promptLine").mockResolvedValueOnce("1234");

    const cap = captureConsole();
    try {
      await cmdVerify(undefined, {}, makeProgram({ json: false }));
      expect(loginVerify).toHaveBeenCalledWith(
        expect.objectContaining({ load: expect.any(Function) }),
        "1234",
      );
    } finally {
      cap.restore();
      promptLineSpy.mockRestore();
      vi.mocked(isInteractive).mockReset();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AUTHC-0005: verify code 欠落かつ非対話で usage エラー (exit 2)
// ──────────────────────────────────────────────────────────────────────────────
describe("[AUTHC-0005] verify code 欠落かつ非対話で usage エラー (exit 2)", () => {
  it("[AUTHC-0005] prompt 不可 (非TTY & json) で code も無いとき die(...,2) で exit 2", async () => {
    const exitSpy = interceptExit();
    const cap = captureConsole();
    try {
      await expect(cmdVerify(undefined, {}, makeProgram({ json: true }))).rejects.toMatchObject({ code: 2 });
      expect(loginVerify).not.toHaveBeenCalled();
    } finally {
      cap.restore();
      exitSpy.mockRestore();
    }
  });

  it("[AUTHC-0005] prompt 不可 (非TTY & json:false) でも code 無いとき exit 2", async () => {
    vi.mocked(isInteractive).mockReturnValue(false);
    const exitSpy = interceptExit();
    const cap = captureConsole();
    try {
      await expect(cmdVerify(undefined, {}, makeProgram({ json: false }))).rejects.toMatchObject({ code: 2 });
      expect(loginVerify).not.toHaveBeenCalled();
    } finally {
      cap.restore();
      exitSpy.mockRestore();
      vi.mocked(isInteractive).mockReset();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AUTHC-0006: verify → loginVerify(tokenStore, code) で CUSTOM_CHALLENGE 回答
// ──────────────────────────────────────────────────────────────────────────────
describe("[AUTHC-0006] verify → loginVerify(tokenStore, code) 配線", () => {
  it("[AUTHC-0006] cmdVerify が code で loginVerify を tokenStore と共にちょうど一度呼ぶ", async () => {
    const cap = captureConsole();
    try {
      await cmdVerify("5678", {}, makeProgram({ json: true }));
      expect(loginVerify).toHaveBeenCalledOnce();
      expect(loginVerify).toHaveBeenCalledWith(
        expect.objectContaining({ load: expect.any(Function) }),
        "5678",
      );
    } finally {
      cap.restore();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AUTHC-0007: verify 後に bootstrapAfterLogin が自動実行され封筒に bootstrap が入る
// ──────────────────────────────────────────────────────────────────────────────
describe("[AUTHC-0007] verify 後の bootstrapAfterLogin と --json 封筒", () => {
  it("[AUTHC-0007] --json 封筒に {ok,clientId,username,deviceKey,bootstrap} が入る", async () => {
    vi.mocked(loginVerify).mockResolvedValueOnce({
      clientId: "cli-001",
      username: "userA",
      deviceKey: "dkXYZ",
    });

    const cap = captureConsole();
    try {
      await cmdVerify("1234", {}, makeProgram({ json: true }));
      expect(cap.logs.length).toBeGreaterThan(0);
      const parsed = JSON.parse(cap.logs[0]);
      expect(parsed).toMatchObject({
        ok: true,
        clientId: "cli-001",
        username: "userA",
        bootstrap: expect.any(Object),
      });
    } finally {
      cap.restore();
    }
  });

  it("[AUTHC-0007] deviceKey は値ではなく 'set'|null に正規化される (有り → 'set')", async () => {
    vi.mocked(loginVerify).mockResolvedValueOnce({
      clientId: "cli-001",
      username: "userA",
      deviceKey: "someRawKey",
    });

    const cap = captureConsole();
    try {
      await cmdVerify("1234", {}, makeProgram({ json: true }));
      const parsed = JSON.parse(cap.logs[0]);
      expect(parsed.deviceKey).toBe("set");
    } finally {
      cap.restore();
    }
  });

  it("[AUTHC-0007] deviceKey 無し (null/undefined) → 封筒の deviceKey は null", async () => {
    vi.mocked(loginVerify).mockResolvedValueOnce({
      clientId: "cli-002",
      username: "userB",
      deviceKey: null,
    });

    const cap = captureConsole();
    try {
      await cmdVerify("1234", {}, makeProgram({ json: true }));
      const parsed = JSON.parse(cap.logs[0]);
      expect(parsed.deviceKey).toBeNull();
    } finally {
      cap.restore();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AUTHC-0008: verify の bootstrap quiet 連動 (--json で人間ログ抑止)
// ──────────────────────────────────────────────────────────────────────────────
describe("[AUTHC-0008] verify の bootstrap quiet 連動", () => {
  it("[AUTHC-0008] --json 時 signedInAutoSetup を stderr に出さない", async () => {
    const cap = captureConsole();
    try {
      await cmdVerify("1234", {}, makeProgram({ json: true }));
      expect(cap.errors).not.toContain(expect.stringContaining("cli.signedInAutoSetup"));
    } finally {
      cap.restore();
    }
  });

  it("[AUTHC-0008] 非 --json 時 signedInAutoSetup を stderr に出す", async () => {
    const cap = captureConsole();
    try {
      await cmdVerify("1234", {}, makeProgram({ json: false }));
      // auth.js: if (!opts.json) console.error(t("cli.signedInAutoSetup"))
      expect(cap.errors.some((line) => line.includes("cli.signedInAutoSetup"))).toBe(true);
    } finally {
      cap.restore();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AUTHC-0009: bootstrapAfterLogin が companyID(refreshAccount) を取り込む
// ──────────────────────────────────────────────────────────────────────────────
describe("[AUTHC-0009] bootstrapAfterLogin が companyID(refreshAccount) を取り込む", () => {
  it("[AUTHC-0009] hub.refreshAccount() を呼び companyID を bootstrap.summary に格納する", async () => {
    const fakeHub = {
      connect: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      refreshAccount: vi.fn(async () => ({ companyID: "cmp-456" })),
      getLoginUser: vi.fn(async () => ({ quotas: {} })),
      syncLocksFromDevices: vi.fn(async () => ({ added: [], updated: [], removed: [] })),
      syncHub3sFromDevices: vi.fn(async () => ({ added: [], updated: [] })),
      syncRemotesFromDevices: vi.fn(async () => ({ remotes: { added: [], updated: [] } })),
      syncRemoteKeys: vi.fn(async () => {}),
    };
    mockHub3Once(fakeHub);
    vi.mocked(loginVerify).mockResolvedValueOnce({
      clientId: "c1", username: "u1", deviceKey: null,
    });

    const cap = captureConsole();
    try {
      await cmdVerify("0000", {}, makeProgram({ json: true }));
      expect(fakeHub.refreshAccount).toHaveBeenCalledOnce();
      const parsed = JSON.parse(cap.logs[0]);
      expect(parsed.bootstrap.companyID).toBe("cmp-456");
    } finally {
      cap.restore();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AUTHC-0010: bootstrapAfterLogin が locks/Hub3/remotes を devices から取り込む
// ──────────────────────────────────────────────────────────────────────────────
describe("[AUTHC-0010] bootstrapAfterLogin が locks/Hub3/remotes を順番に同期する", () => {
  it("[AUTHC-0010] syncLocksFromDevices→syncHub3sFromDevices→syncRemotesFromDevices の順で呼ぶ", async () => {
    const callOrder = [];
    const fakeHub = {
      connect: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      refreshAccount: vi.fn(async () => ({ companyID: "c" })),
      getLoginUser: vi.fn(async () => ({ quotas: {} })),
      syncLocksFromDevices: vi.fn(async () => { callOrder.push("locks"); return { added: [], updated: [], removed: [] }; }),
      syncHub3sFromDevices: vi.fn(async () => { callOrder.push("hub3s"); return { added: [], updated: [] }; }),
      syncRemotesFromDevices: vi.fn(async () => { callOrder.push("remotes"); return { remotes: { added: [], updated: [] } }; }),
      syncRemoteKeys: vi.fn(async () => {}),
    };
    mockHub3Once(fakeHub);
    vi.mocked(loginVerify).mockResolvedValueOnce({ clientId: "c1", username: "u1", deviceKey: null });

    const cap = captureConsole();
    try {
      await cmdVerify("1111", {}, makeProgram({ json: true }));
      expect(callOrder).toEqual(["locks", "hub3s", "remotes"]);
      expect(fakeHub.syncLocksFromDevices).toHaveBeenCalledOnce();
      expect(fakeHub.syncHub3sFromDevices).toHaveBeenCalledOnce();
      expect(fakeHub.syncRemotesFromDevices).toHaveBeenCalledOnce();
    } finally {
      cap.restore();
    }
  });

  it("[AUTHC-0010] remotes.added + remotes.updated の各 name に syncRemoteKeys を best-effort で呼ぶ", async () => {
    const fakeHub = {
      connect: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      refreshAccount: vi.fn(async () => ({ companyID: "c" })),
      getLoginUser: vi.fn(async () => ({ quotas: {} })),
      syncLocksFromDevices: vi.fn(async () => ({ added: [], updated: [], removed: [] })),
      syncHub3sFromDevices: vi.fn(async () => ({ added: [], updated: [] })),
      syncRemotesFromDevices: vi.fn(async () => ({ remotes: { added: ["remA"], updated: ["remB"] } })),
      syncRemoteKeys: vi.fn(async () => {}),
    };
    mockHub3Once(fakeHub);
    vi.mocked(loginVerify).mockResolvedValueOnce({ clientId: "c1", username: "u1", deviceKey: null });

    const cap = captureConsole();
    try {
      await cmdVerify("2222", {}, makeProgram({ json: true }));
      expect(fakeHub.syncRemoteKeys).toHaveBeenCalledTimes(2);
      expect(fakeHub.syncRemoteKeys).toHaveBeenCalledWith("remA");
      expect(fakeHub.syncRemoteKeys).toHaveBeenCalledWith("remB");
    } finally {
      cap.restore();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AUTHC-0011: bootstrapAfterLogin は各ステップを個別 try/catch し best-effort 続行する
// ──────────────────────────────────────────────────────────────────────────────
describe("[AUTHC-0011] bootstrapAfterLogin は各ステップ失敗を best-effort で続行する", () => {
  it("[AUTHC-0011] account失敗 → errors に 'account:' プレフィックスで積まれ他ステップ続行", async () => {
    const fakeHub = {
      connect: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      refreshAccount: vi.fn(async () => { throw new Error("account boom"); }),
      getLoginUser: vi.fn(async () => ({ quotas: {} })),
      syncLocksFromDevices: vi.fn(async () => ({ added: [], updated: [], removed: [] })),
      syncHub3sFromDevices: vi.fn(async () => ({ added: [], updated: [] })),
      syncRemotesFromDevices: vi.fn(async () => ({ remotes: { added: [], updated: [] } })),
      syncRemoteKeys: vi.fn(async () => {}),
    };
    mockHub3Once(fakeHub);
    vi.mocked(loginVerify).mockResolvedValueOnce({ clientId: "c1", username: "u1", deviceKey: null });

    const cap = captureConsole();
    try {
      await cmdVerify("3333", {}, makeProgram({ json: true }));
      const parsed = JSON.parse(cap.logs[0]);
      expect(parsed.bootstrap.errors.some((e) => e.startsWith("account:"))).toBe(true);
      expect(fakeHub.syncLocksFromDevices).toHaveBeenCalledOnce();
      expect(fakeHub.syncHub3sFromDevices).toHaveBeenCalledOnce();
      expect(fakeHub.syncRemotesFromDevices).toHaveBeenCalledOnce();
    } finally {
      cap.restore();
    }
  });

  it("[AUTHC-0011] locks失敗 → errors に 'locks:' プレフィックス", async () => {
    const fakeHub = {
      connect: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      refreshAccount: vi.fn(async () => ({ companyID: "c" })),
      getLoginUser: vi.fn(async () => ({ quotas: {} })),
      syncLocksFromDevices: vi.fn(async () => { throw new Error("locks boom"); }),
      syncHub3sFromDevices: vi.fn(async () => ({ added: [], updated: [] })),
      syncRemotesFromDevices: vi.fn(async () => ({ remotes: { added: [], updated: [] } })),
      syncRemoteKeys: vi.fn(async () => {}),
    };
    mockHub3Once(fakeHub);
    vi.mocked(loginVerify).mockResolvedValueOnce({ clientId: "c1", username: "u1", deviceKey: null });

    const cap = captureConsole();
    try {
      await cmdVerify("3334", {}, makeProgram({ json: true }));
      const parsed = JSON.parse(cap.logs[0]);
      expect(parsed.bootstrap.errors.some((e) => e.startsWith("locks:"))).toBe(true);
    } finally {
      cap.restore();
    }
  });

  it("[AUTHC-0011] hub3失敗 → errors に 'hub3s:' プレフィックス", async () => {
    const fakeHub = {
      connect: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      refreshAccount: vi.fn(async () => ({ companyID: "c" })),
      getLoginUser: vi.fn(async () => ({ quotas: {} })),
      syncLocksFromDevices: vi.fn(async () => ({ added: [], updated: [], removed: [] })),
      syncHub3sFromDevices: vi.fn(async () => { throw new Error("hub3 boom"); }),
      syncRemotesFromDevices: vi.fn(async () => ({ remotes: { added: [], updated: [] } })),
      syncRemoteKeys: vi.fn(async () => {}),
    };
    mockHub3Once(fakeHub);
    vi.mocked(loginVerify).mockResolvedValueOnce({ clientId: "c1", username: "u1", deviceKey: null });

    const cap = captureConsole();
    try {
      await cmdVerify("3335", {}, makeProgram({ json: true }));
      const parsed = JSON.parse(cap.logs[0]);
      expect(parsed.bootstrap.errors.some((e) => e.startsWith("hub3s:"))).toBe(true);
    } finally {
      cap.restore();
    }
  });

  it("[AUTHC-0011] remotes失敗 → errors に 'remotes:' プレフィックス", async () => {
    const fakeHub = {
      connect: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      refreshAccount: vi.fn(async () => ({ companyID: "c" })),
      getLoginUser: vi.fn(async () => ({ quotas: {} })),
      syncLocksFromDevices: vi.fn(async () => ({ added: [], updated: [], removed: [] })),
      syncHub3sFromDevices: vi.fn(async () => ({ added: [], updated: [] })),
      syncRemotesFromDevices: vi.fn(async () => { throw new Error("remotes boom"); }),
      syncRemoteKeys: vi.fn(async () => {}),
    };
    mockHub3Once(fakeHub);
    vi.mocked(loginVerify).mockResolvedValueOnce({ clientId: "c1", username: "u1", deviceKey: null });

    const cap = captureConsole();
    try {
      await cmdVerify("3336", {}, makeProgram({ json: true }));
      const parsed = JSON.parse(cap.logs[0]);
      expect(parsed.bootstrap.errors.some((e) => e.startsWith("remotes:"))).toBe(true);
    } finally {
      cap.restore();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AUTHC-0012: bootstrapAfterLogin の connect 失敗時に authExpired を構造化エラーで判定
// ──────────────────────────────────────────────────────────────────────────────
describe("[AUTHC-0012] bootstrapAfterLogin の connect 失敗時 authExpired 判定", () => {
  it("[AUTHC-0012] SesameError(UNAUTHENTICATED) → summary.authExpired=true", async () => {
    const unauthErr = new SesameError("token expired", { code: ERR.UNAUTHENTICATED });
    mockHub3Once({
      connect: vi.fn(async () => { throw unauthErr; }),
      close: vi.fn(async () => {}),
    });
    vi.mocked(loginVerify).mockResolvedValueOnce({ clientId: "c1", username: "u1", deviceKey: null });

    const cap = captureConsole();
    try {
      await cmdVerify("4444", {}, makeProgram({ json: true }));
      const parsed = JSON.parse(cap.logs[0]);
      expect(parsed.bootstrap.authExpired).toBe(true);
    } finally {
      cap.restore();
    }
  });

  it("[AUTHC-0012] その他のエラー → summary.authExpired=false (bootConnectFail 経路)", async () => {
    const genericErr = new Error("network fail");
    mockHub3Once({
      connect: vi.fn(async () => { throw genericErr; }),
      close: vi.fn(async () => {}),
    });
    vi.mocked(loginVerify).mockResolvedValueOnce({ clientId: "c1", username: "u1", deviceKey: null });

    const cap = captureConsole();
    try {
      await cmdVerify("5555", {}, makeProgram({ json: true }));
      const parsed = JSON.parse(cap.logs[0]);
      expect(parsed.bootstrap.authExpired).toBe(false);
    } finally {
      cap.restore();
    }
  });

  it("[AUTHC-0012] SesameError(BAD_REQUEST) → authExpired=false (UNAUTHENTICATED のみが真)", async () => {
    const badReqErr = new SesameError("bad", { code: ERR.BAD_REQUEST });
    mockHub3Once({
      connect: vi.fn(async () => { throw badReqErr; }),
      close: vi.fn(async () => {}),
    });
    vi.mocked(loginVerify).mockResolvedValueOnce({ clientId: "c1", username: "u1", deviceKey: null });

    const cap = captureConsole();
    try {
      await cmdVerify("6666", {}, makeProgram({ json: true }));
      const parsed = JSON.parse(cap.logs[0]);
      expect(parsed.bootstrap.authExpired).toBe(false);
    } finally {
      cap.restore();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AUTHC-0013: setup は未ログインで usage エラー (exit 2)
// ──────────────────────────────────────────────────────────────────────────────
describe("[AUTHC-0013] setup は未ログインで usage エラー (exit 2)", () => {
  it("[AUTHC-0013] tokenStore.load() 偽で die(notLoggedIn, 2)、bootstrapAfterLogin に進まない", async () => {
    // load() → null (未ログイン)
    mockTokenStoreOnce(null);

    const exitSpy = interceptExit();
    const cap = captureConsole();
    try {
      await expect(cmdSetup({}, makeProgram())).rejects.toMatchObject({ code: 2 });
    } finally {
      cap.restore();
      exitSpy.mockRestore();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AUTHC-0014: setup の手動再実行と部分失敗時 exit 1
// ──────────────────────────────────────────────────────────────────────────────
describe("[AUTHC-0014] setup の手動再実行と部分失敗時 exit 1", () => {
  beforeEach(() => {
    // ログイン済みにするため tokenStore.load を非 null に
    vi.mocked(FileTokenStore).mockImplementation(function() {
      return {
        load: vi.fn(() => ({ clientId: "c", username: "u", idToken: "tok", refreshToken: "ref" })),
        loadPending: vi.fn(() => null),
        save: vi.fn(),
        savePending: vi.fn(),
        clear: vi.fn(),
        clearPending: vi.fn(),
      };
    });
  });

  afterEach(() => {
    vi.mocked(FileTokenStore).mockReset();
  });

  it("[AUTHC-0014] ログイン済みで bootstrapAfterLogin を呼び、errors 空なら exitCode を変えない", async () => {
    const prevExitCode = process.exitCode;
    const cap = captureConsole();
    try {
      await cmdSetup({}, makeProgram({ json: true }));
      const parsed = JSON.parse(cap.logs[0]);
      expect(parsed.ok).toBe(true);
      expect(parsed).toHaveProperty("bootstrap");
    } finally {
      cap.restore();
      process.exitCode = prevExitCode;
    }
  });

  it("[AUTHC-0014] summary.errors が空でなければ process.exitCode=1 かつ封筒 {ok:false}", async () => {
    mockHub3Once({
      connect: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      refreshAccount: vi.fn(async () => ({ companyID: "c" })),
      syncLocksFromDevices: vi.fn(async () => { throw new Error("locks fail"); }),
      syncHub3sFromDevices: vi.fn(async () => ({ added: [], updated: [] })),
      syncRemotesFromDevices: vi.fn(async () => ({ remotes: { added: [], updated: [] } })),
      syncRemoteKeys: vi.fn(async () => {}),
    });

    const prevExitCode = process.exitCode;
    const cap = captureConsole();
    try {
      await cmdSetup({}, makeProgram({ json: true }));
      const parsed = JSON.parse(cap.logs[0]);
      expect(parsed.ok).toBe(false);
      expect(process.exitCode).toBe(1);
    } finally {
      cap.restore();
      process.exitCode = prevExitCode;
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AUTHC-0015: refresh は marginSec を大きく取り強制リフレッシュする
// ──────────────────────────────────────────────────────────────────────────────
describe("[AUTHC-0015] refresh は marginSec:999999 で強制リフレッシュする", () => {
  it("[AUTHC-0015] getValidIdToken(tokenStore, {marginSec:999999}) をちょうど一度呼ぶ", async () => {
    vi.mocked(getValidIdToken).mockResolvedValueOnce("fresh.id.token.xxxxxxxxxxxxxxxxxxxx");
    const cap = captureConsole();
    try {
      await cmdRefresh({}, makeProgram({ json: true }));
      expect(getValidIdToken).toHaveBeenCalledOnce();
      expect(getValidIdToken).toHaveBeenCalledWith(
        expect.objectContaining({ load: expect.any(Function) }),
        { marginSec: 999999 },
      );
    } finally {
      cap.restore();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AUTHC-0016: refresh の --json 封筒 ({ok,idTokenLength})
// ──────────────────────────────────────────────────────────────────────────────
describe("[AUTHC-0016] refresh の --json 封筒 ({ok,idTokenLength})", () => {
  it("[AUTHC-0016] --json 時 {ok:true, idTokenLength:tok.length} を stdout に出し生 token を出さない", async () => {
    const fakeToken = "a".repeat(300);
    vi.mocked(getValidIdToken).mockResolvedValueOnce(fakeToken);

    const cap = captureConsole();
    try {
      await cmdRefresh({}, makeProgram({ json: true }));
      expect(cap.logs.length).toBeGreaterThan(0);
      const parsed = JSON.parse(cap.logs[0]);
      expect(parsed).toMatchObject({ ok: true, idTokenLength: fakeToken.length });
      expect(cap.logs.join("")).not.toContain(fakeToken);
    } finally {
      cap.restore();
    }
  });

  it("[AUTHC-0016] 非 --json 時は idTokenRefreshed メッセージを stdout に出す", async () => {
    const fakeToken = "b".repeat(250);
    vi.mocked(getValidIdToken).mockResolvedValueOnce(fakeToken);

    const cap = captureConsole();
    try {
      await cmdRefresh({}, makeProgram({ json: false }));
      expect(cap.logs.some((l) => l.includes("cli.idTokenRefreshed"))).toBe(true);
    } finally {
      cap.restore();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AUTHC-0017: logout はセッション無しで冪等に成功封筒を返す
// ──────────────────────────────────────────────────────────────────────────────
describe("[AUTHC-0017] logout はセッション無しで冪等に成功封筒を返す", () => {
  it("[AUTHC-0017] tokenStore.load() 偽なら logout(core) を呼ばず {ok:true, alreadyLoggedOut:true}", async () => {
    mockTokenStoreOnce(null);

    const cap = captureConsole();
    try {
      await cmdLogout({}, makeProgram({ json: true }));
      expect(logout).not.toHaveBeenCalled();
      const parsed = JSON.parse(cap.logs[0]);
      expect(parsed).toMatchObject({ ok: true, alreadyLoggedOut: true });
    } finally {
      cap.restore();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// AUTHC-0018: logout は ForgetDevice + RevokeToken をしてからローカル消去する
// ──────────────────────────────────────────────────────────────────────────────
describe("[AUTHC-0018] logout は ForgetDevice + RevokeToken をしてからローカル消去する", () => {
  it("[AUTHC-0018] セッション有りなら logout(core) が呼ばれ封筒 {ok:true, forgotDevice, revokedToken}", async () => {
    mockTokenStoreOnce({
      clientId: "6ialca0p8u0lsgvbmvsljfm305",
      username: "u@example.com",
      idToken: "idtok",
      refreshToken: "reftok",
      accessToken: "acctok",
      deviceKey: "devk",
    });
    vi.mocked(logout).mockResolvedValueOnce({ forgotDevice: true, revokedToken: true });

    const cap = captureConsole();
    try {
      await cmdLogout({}, makeProgram({ json: true }));
      expect(logout).toHaveBeenCalledOnce();
      const parsed = JSON.parse(cap.logs[0]);
      expect(parsed).toMatchObject({
        ok: true,
        forgotDevice: true,
        revokedToken: true,
      });
    } finally {
      cap.restore();
    }
  });

  it("[AUTHC-0018] 部分失敗 (forgotDevice=false) でも {ok:true} を返し logoutPartial を stderr に出す", async () => {
    mockTokenStoreOnce({
      clientId: "6ialca0p8u0lsgvbmvsljfm305",
      username: "u@example.com",
      idToken: "idtok",
      refreshToken: "reftok",
      accessToken: "acctok",
      deviceKey: "devk",
    });
    vi.mocked(logout).mockResolvedValueOnce({ forgotDevice: false, revokedToken: true });

    const cap = captureConsole();
    try {
      await cmdLogout({}, makeProgram({ json: false }));
      // auth.js: if (!r.revokedToken || !r.forgotDevice) console.error(t("cli.logoutPartial"))
      expect(cap.errors.some((l) => l.includes("cli.logoutPartial"))).toBe(true);
    } finally {
      cap.restore();
    }
  });
});
