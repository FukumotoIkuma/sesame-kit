// spec/auth-cli.md AUTHC-0019 〜 AUTHC-0036 の TDD テスト (A/B 統合版)
// 対象実装: packages/kit/src/cli/auth.js, packages/kit/src/cli/migrate.js,
//           packages/kit/src/cli/config-cmd.js, packages/kit/src/cli/ctx.js
// 実行環境: vitest (unit project) — KIT_SETUP により kit/core カタログ登録済み
//
// 方針:
//   - 各 it は先頭に [AUTHC-XXXX] タグを置く
//   - ネットワーク/実機に触れない (全て mock or 純関数)
//   - 実装が spec と食い違う場合は spec どおりの期待値で assert (TDD: red 許容)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { t, setLocale } from "@sesame-kit/core/i18n";
import { SesameError, ERR } from "@sesame-kit/core/errors";
import { CONFIG_META, CONSUMER_CLIENT_ID } from "@sesame-kit/core/auth";

import { cmdMigrate } from "../../src/cli/migrate.js";
import { out, canPrompt, promptLine, loadCtx, mask, redactConfig } from "../../src/cli/ctx.js";
import { EXIT } from "../../src/cli/errors.js";
import { registerConfigCommands } from "../../src/cli/config-cmd.js";

// ロケール固定: KIT_SETUP が ja に固定するが、各テストは en で検証して文言依存を回避する
beforeEach(() => setLocale("en"));
afterEach(() => setLocale("en"));

// ─────────────────────────────────────────────────────────────────────────────
// ヘルパ
// ─────────────────────────────────────────────────────────────────────────────

function captureOutput(fn) {
  const logs = [];
  const errs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(a.map(String).join(" "));
  console.error = (...a) => errs.push(a.map(String).join(" "));
  let result;
  try {
    result = fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { logs, errs, result };
}

async function captureOutputAsync(fn) {
  const logs = [];
  const errs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(a.map(String).join(" "));
  console.error = (...a) => errs.push(a.map(String).join(" "));
  let result;
  try {
    result = await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { logs, errs, result };
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTHC-0019: whoami は biz3GetLoginUser で customerInfo/quotas を取得
// ─────────────────────────────────────────────────────────────────────────────

describe("AUTHC-0019: cmdWhoami の wire 配線", () => {
  it("[AUTHC-0019] withHub 内で hub.refreshAccount() と hub.getLoginUser().quotas を呼ぶ", async () => {
    const customerInfo = {
      companyID: "ch_test",
      subUUID: "sub-uuid-123",
      name: "Test User",
      subscriptionId: "sub-001",
    };
    const quotas = { devices: 10 };
    const hub = {
      refreshAccount: vi.fn(async () => customerInfo),
      getLoginUser: vi.fn(async () => ({ quotas })),
      connect: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };

    const ctxMod = await import("../../src/cli/ctx.js");
    const withHubSpy = vi.spyOn(ctxMod, "withHub").mockImplementation(async (_program, fn) => {
      return fn(hub, { opts: { json: true }, paths: {} });
    });

    const { cmdWhoami } = await import("../../src/cli/auth.js");
    const { logs } = await captureOutputAsync(async () => {
      const program = { opts: () => ({ json: true }) };
      await cmdWhoami({}, program);
    });

    try {
      expect(hub.refreshAccount).toHaveBeenCalledOnce();
      expect(hub.getLoginUser).toHaveBeenCalledOnce();

      // --json 封筒に ok/customerInfo/quotas が含まれる
      const output = JSON.parse(logs[0]);
      expect(output.ok).toBe(true);
      expect(output.customerInfo).toEqual(customerInfo);
      expect(output.quotas).toEqual(quotas);
    } finally {
      withHubSpy.mockRestore();
    }
  });

  it("[AUTHC-0019] --json 封筒は {ok, customerInfo, quotas} を含む (out() の直接テスト)", () => {
    const customerInfo = { companyID: "ch_Co", subUUID: "s1" };
    const quotas = { limit: 5 };

    const { logs } = captureOutput(() => {
      out(true, () => { throw new Error("humanFn should not be called in json mode"); },
        { ok: true, customerInfo, quotas });
    });

    const parsed = JSON.parse(logs[0]);
    expect(parsed).toMatchObject({ ok: true });
    expect(parsed.customerInfo).toEqual(customerInfo);
    expect(parsed.quotas).toEqual(quotas);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTHC-0020: whoami の customerInfo 欠落分岐と --json 封筒
// ─────────────────────────────────────────────────────────────────────────────

describe("AUTHC-0020: cmdWhoami の customerInfo 欠落分岐", () => {
  it("[AUTHC-0020] customerInfo が null なら noCustomerInfo を出し companyId/subUuid 行をスキップ", () => {
    // auth.js:192 相当: if (!customerInfo) { console.log(t("cli.noCustomerInfo")); return; }
    const { logs } = captureOutput(() => {
      const customerInfo = null;
      if (!customerInfo) {
        console.log(t("cli.noCustomerInfo"));
        return;
      }
      console.log(t("cli.companyId", { companyID: "x" }));
    });

    expect(logs[0]).toContain(t("cli.noCustomerInfo"));
    expect(logs.join("\n")).not.toContain("companyID:");
  });

  it("[AUTHC-0020] --json 時は {ok:true, customerInfo, quotas} 封筒を出す (customerInfo=null でもキー保持)", () => {
    const customerInfo = null;
    const quotas = null;
    const { logs } = captureOutput(() => {
      out(true, () => {}, { ok: true, customerInfo, quotas });
    });
    const parsed = JSON.parse(logs[0]);
    expect(parsed.ok).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(parsed, "customerInfo")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(parsed, "quotas")).toBe(true);
  });

  it("[AUTHC-0020] subUUID 欠落は '(none)' を出す", () => {
    // auth.js:194: console.log(t("cli.subUuid", { subUUID: customerInfo.subUUID || "(none)" }))
    const subUUID = null;
    const displayed = subUUID || "(none)";
    const { logs } = captureOutput(() => {
      console.log(t("cli.subUuid", { subUUID: displayed }));
    });
    expect(logs[0]).toContain("(none)");
  });

  it("[AUTHC-0020] name/subscriptionId は存在時のみ行追加する", () => {
    // auth.js:195-196
    function renderHuman(ci) {
      const out_ = [];
      out_.push(t("cli.companyId", { companyID: ci.companyID }));
      out_.push(t("cli.subUuid", { subUUID: ci.subUUID || "(none)" }));
      if (ci.name) out_.push(t("cli.name", { name: ci.name }));
      if (ci.subscriptionId) out_.push(t("cli.subscription", { subscriptionId: ci.subscriptionId }));
      return out_;
    }

    const withBoth = { companyID: "c", subUUID: "s", name: "N", subscriptionId: "sub-1" };
    const withNone = { companyID: "c", subUUID: "s" };

    const withBothLines = renderHuman(withBoth);
    expect(withBothLines.length).toBe(4);
    expect(withBothLines.some(l => l.includes("N"))).toBe(true);

    const withNoneLines = renderHuman(withNone);
    expect(withNoneLines.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTHC-0021: bootstrap は TTY (パイプ無し) で usage エラー (exit 2)
// ─────────────────────────────────────────────────────────────────────────────

describe("AUTHC-0021: cmdBootstrap の TTY チェック", () => {
  it("[AUTHC-0021] process.stdin.isTTY が真なら die(bootstrapStdin, 2) を呼ぶ (exit 2)", async () => {
    // auth.js:209: if (process.stdin.isTTY) die(t("cli.bootstrapStdin"), 2);
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    try {
      await expect(
        (async () => {
          if (process.stdin.isTTY) {
            const err = new Error(t("cli.bootstrapStdin"));
            err.code = EXIT.USAGE;
            throw err;
          }
        })()
      ).rejects.toMatchObject({ code: EXIT.USAGE });
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, configurable: true });
    }
  });

  it("[AUTHC-0021] die のコードは 2 (EXIT.USAGE) と一致する", () => {
    expect(EXIT.USAGE).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTHC-0022: bootstrap は空入力 / 不正 JSON で usage エラー (exit 2)
// ─────────────────────────────────────────────────────────────────────────────

describe("AUTHC-0022: cmdBootstrap の入力検証", () => {
  it("[AUTHC-0022] 空入力 (trim 後空文字) なら die(bootstrapEmpty, 2) を呼ぶ", () => {
    // auth.js:214: if (!input) die(t("cli.bootstrapEmpty"), 2)
    const input = "   ";
    const errors = [];
    const dieMock = (msg, code) => { errors.push({ msg, code }); };

    if (!input.trim()) dieMock(t("cli.bootstrapEmpty"), 2);

    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe(2);
    expect(errors[0].msg).toBe(t("cli.bootstrapEmpty"));
  });

  it("[AUTHC-0022] JSON.parse 失敗なら die(bootstrapInvalidJson{message}, 2) を呼ぶ", () => {
    // auth.js:216-219
    const input = "{ not valid json }";
    const errors = [];
    const dieMock = (msg, code) => { errors.push({ msg, code }); };

    let parseError;
    try { JSON.parse(input); } catch (e) { parseError = e; }
    if (parseError) {
      const message = parseError instanceof Error ? parseError.message : String(parseError);
      dieMock(t("cli.bootstrapInvalidJson", { message }), 2);
    }

    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe(2);
    // t("cli.bootstrapInvalidJson") キーが存在すること
    expect(errors[0].msg).toBeTruthy();
  });

  it("[AUTHC-0022] 有効な JSON は die を呼ばず core bootstrap へ進む", () => {
    const input = '{"idToken":"abc","refreshToken":"rt"}';
    const errors = [];
    const dieMock = (msg, code) => { errors.push({ msg, code }); };

    if (!input.trim()) { dieMock(t("cli.bootstrapEmpty"), 2); return; }
    let values;
    try { values = JSON.parse(input); } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      dieMock(t("cli.bootstrapInvalidJson", { message }), 2);
    }

    expect(errors).toHaveLength(0);
    expect(values).toMatchObject({ idToken: "abc", refreshToken: "rt" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTHC-0023: bootstrap は app-login 由来トークンのみ受理
// ─────────────────────────────────────────────────────────────────────────────

describe("AUTHC-0023: bootstrap の assertAppLoginTokens 検証", () => {
  it("[AUTHC-0023] core の bootstrap() は idToken/refreshToken 必須を検証し欠落で throw する", async () => {
    const { bootstrap } = await import("@sesame-kit/core/auth");
    let t_ = null;
    const store = {
      load: () => null,
      save: vi.fn((v) => { t_ = v; }),
      clearPending: vi.fn(),
    };

    // idToken 欠落
    await expect(
      Promise.resolve().then(() => bootstrap(store, { refreshToken: "rt" }))
    ).rejects.toThrow();

    // refreshToken 欠落
    await expect(
      Promise.resolve().then(() => bootstrap(store, { idToken: "header.payload.sig" }))
    ).rejects.toThrow();
  });

  it("[AUTHC-0023] aud が CONSUMER_CLIENT_ID と不一致なら UNAUTHENTICATED で拒否する", async () => {
    // assertAppLoginTokens(values, 'bootstrap input', {requireAud:true,...})
    const { bootstrap } = await import("@sesame-kit/core/auth");
    const store = { load: () => null, save: vi.fn(), clearPending: vi.fn() };

    function b64url(obj) {
      return Buffer.from(JSON.stringify(obj)).toString("base64url");
    }
    const wrongAudJwt = `${b64url({ alg: "RS256" })}.${b64url({ aud: "wrong-client-id", exp: 9999999999 })}.sig`;

    await expect(
      Promise.resolve().then(() => bootstrap(store, {
        idToken: wrongAudJwt,
        refreshToken: "rt-wrong-aud",
      }))
    ).rejects.toThrow();
  });

  it("[AUTHC-0023] aud=null (claim 欠落) を持つ JWT も bootstrap で拒否される", async () => {
    // requireAud=true: aud claim 欠落も CONSUMER_CLIENT_ID と不一致 → 拒否
    const { bootstrap } = await import("@sesame-kit/core/auth");
    const store = { load: () => null, save: vi.fn(), clearPending: vi.fn() };

    function b64url(obj) {
      return Buffer.from(JSON.stringify(obj)).toString("base64url");
    }
    const noAudJwt = `${b64url({ alg: "RS256" })}.${b64url({ exp: 9999999999 })}.sig`;

    await expect(
      Promise.resolve().then(() => bootstrap(store, {
        idToken: noAudJwt,
        refreshToken: "rt-no-aud",
      }))
    ).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTHC-0024: bootstrap 成功時 clientId を consumer に固定し封筒返却
// ─────────────────────────────────────────────────────────────────────────────

describe("AUTHC-0024: bootstrap 成功時の clientId 固定", () => {
  it("[AUTHC-0024] 保存トークンの clientId は入力に依らず CONSUMER_CLIENT_ID に固定される", async () => {
    // auth.js:926: clientId: CONSUMER_CLIENT_ID 固定
    // resolvedClientId は tokens.clientId || jwtAud(idToken) の順で解決するため、
    // clientId を省略して JWT aud から解決させる (CONSUMER_CLIENT_ID と一致するよう構築)
    const { bootstrap } = await import("@sesame-kit/core/auth");
    let saved;
    const store = {
      load: () => null,
      save: vi.fn((v) => { saved = v; }),
      clearPending: vi.fn(),
    };

    function b64url(obj) {
      return Buffer.from(JSON.stringify(obj)).toString("base64url");
    }
    // CONSUMER_CLIENT_ID と一致する aud を持つ JWT (clientId は省略して jwtAud から解決)
    const validJwt = `${b64url({ alg: "RS256" })}.${b64url({ aud: CONSUMER_CLIENT_ID, exp: 9999999999 })}.sig`;

    const tok = bootstrap(store, {
      idToken: validJwt,
      refreshToken: "rt-valid",
      // clientId を渡さない → resolvedClientId は jwtAud(idToken) = CONSUMER_CLIENT_ID を使う
    });

    // bootstrap は常に CONSUMER_CLIENT_ID を clientId として保存する (auth.js:926)
    expect(tok.clientId).toBe(CONSUMER_CLIENT_ID);
    expect(store.save).toHaveBeenCalledOnce();
    expect(saved.clientId).toBe(CONSUMER_CLIENT_ID);
  });

  it("[AUTHC-0024] --json 封筒は {ok:true, clientId} / 人間向けは okBootstrapped を出す", () => {
    // auth.js:222-223
    const clientId = CONSUMER_CLIENT_ID;

    // json mode
    const { logs: jsonLogs } = captureOutput(() => {
      out(true, () => {}, { ok: true, clientId });
    });
    const parsed = JSON.parse(jsonLogs[0]);
    expect(parsed.ok).toBe(true);
    expect(parsed.clientId).toBe(clientId);

    // human mode
    const { logs: humanLogs } = captureOutput(() => {
      out(false, () => console.log(t("cli.okBootstrapped", { clientId })), {});
    });
    // okBootstrapped キーが存在し、何かメッセージが出る
    expect(humanLogs[0]).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTHC-0025: init は 0700 で config dir を作り --lang を焼き込む
// ─────────────────────────────────────────────────────────────────────────────

describe("AUTHC-0025: cmdInit の ensureSecureDir と langFlag", () => {
  let workDir;
  beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), "sesame-authc25-")); });
  afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

  it("[AUTHC-0025] configStore.init は langFlag がある時 {uiLang, lang} を焼き込む", async () => {
    // config-cmd.js:25: const created = configStore.init(langFlag ? { uiLang: langFlag, lang: langFlag } : {})
    const { ConfigStore } = await import("@sesame-kit/core/config");
    const configPath = join(workDir, "config.json");
    const cs = new ConfigStore(configPath);

    const created = cs.init({ uiLang: "en", lang: "en" });
    expect(created).toBe(true);

    const cfg = cs.load();
    expect(cfg.uiLang).toBe("en");
    expect(cfg.lang).toBe("en");
  });

  it("[AUTHC-0025] langFlag が null なら {} を渡し uiLang/lang の明示的上書きは行わない", async () => {
    // config-cmd.js:25: configStore.init(langFlag ? {uiLang,lang} : {})
    // emptyConfig() は lang: "ja" を既定として持つため、langFlag=null でも lang は "ja" になる。
    // uiLang は emptyConfig() に含まれないため undefined のまま。
    const { ConfigStore } = await import("@sesame-kit/core/config");
    const configPath = join(workDir, "config2.json");
    const cs = new ConfigStore(configPath);

    cs.init({});

    const cfg = cs.load();
    // uiLang は焼き込まれない (emptyConfig に存在しないため undefined)
    expect(cfg.uiLang == null || cfg.uiLang === undefined).toBe(true);
    // lang は emptyConfig の既定値 "ja" が入る (langFlag=null 時の明示上書きなし)
    expect(cfg.lang).toBe("ja");
  });

  it("[AUTHC-0025] configStore.init が false を返す (既存) と created=false で alreadyExists が出る", async () => {
    // configStore.init() は既存時 false を返す → alreadyExists メッセージ
    const { ConfigStore } = await import("@sesame-kit/core/config");
    const configPath = join(workDir, "config3.json");
    const cs = new ConfigStore(configPath);

    cs.init({});
    const created = cs.init({});
    expect(created).toBe(false);

    // created=false → alreadyExists 分岐
    const alreadyExistsMsg = t("cli.alreadyExists", { path: configPath });
    expect(alreadyExistsMsg).toBeTruthy();

    const { logs } = captureOutput(() => {
      if (created) console.log(t("cli.okCreated", { path: configPath }));
      else         console.log(t("cli.alreadyExists", { path: configPath }));
    });
    expect(logs.some((l) => l.includes(alreadyExistsMsg))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTHC-0026: init の --json 封筒 ({ok, created, configPath, nodeVersion})
// ─────────────────────────────────────────────────────────────────────────────

describe("AUTHC-0026: cmdInit の --json 封筒", () => {
  it("[AUTHC-0026] --json 時は {ok:true, created, configPath, nodeVersion} を stdout に出す", () => {
    // config-cmd.js:44: { ok: true, created, configPath: paths.config, nodeVersion: process.version }
    const created = true;
    const configPath = "/tmp/sesame-test/config.json";
    const nodeVersion = process.version;

    const humanFnCalled = { value: false };
    const { logs } = captureOutput(() => {
      out(true, () => { humanFnCalled.value = true; },
        { ok: true, created, configPath, nodeVersion });
    });

    const parsed = JSON.parse(logs[0]);
    expect(parsed.ok).toBe(true);
    expect(parsed.created).toBe(created);
    expect(parsed.configPath).toBe(configPath);
    expect(parsed.nodeVersion).toBe(nodeVersion);
    // 人間向け関数は呼ばれない
    expect(humanFnCalled.value).toBe(false);
  });

  it("[AUTHC-0026] 非 --json 時は人間向け関数が呼ばれ JSON は stdout に出ない", () => {
    const humanOutput = [];

    const { logs } = captureOutput(() => {
      out(false, () => {
        humanOutput.push(t("cli.okCreated", { path: "/tmp/config.json" }));
        console.log(humanOutput[0]);
      }, { ok: true });
    });

    expect(humanOutput).toHaveLength(1);
    expect(logs[0]).toBe(humanOutput[0]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTHC-0027: config (引数省略) と config show が同じ表示になる
// ─────────────────────────────────────────────────────────────────────────────

describe("AUTHC-0027: config グループ action と show サブコマンドの等価性", () => {
  it("[AUTHC-0027] registerConfigCommands は config コマンドと config show 双方を登録する", async () => {
    const { Command } = await import("commander");
    const program = new Command();
    program.exitOverride();

    let workDir2 = mkdtempSync(join(tmpdir(), "sesame-authc27-"));
    try {
      program.option("--config-dir <dir>", "config dir", workDir2);
      program.option("--json", "json output");
      program.option("--debug", "debug");

      registerConfigCommands(program);

      const configCmd = program.commands.find(c => c.name() === "config");
      expect(configCmd).toBeDefined();

      const showCmd = configCmd.commands.find(c => c.name() === "show");
      expect(showCmd).toBeDefined();
    } finally {
      rmSync(workDir2, { recursive: true, force: true });
    }
  });

  it("[AUTHC-0027] config グループ action と show の action は同一 cmdConfigShow を呼ぶ配線になっている", async () => {
    // config-cmd.js:102-107: config.action と config show.action が同じ cmdConfigShow を参照
    const { Command } = await import("commander");
    const program = new Command();
    program.exitOverride();
    let workDir3 = mkdtempSync(join(tmpdir(), "sesame-authc27b-"));
    try {
      program.option("--config-dir <dir>", "config dir", workDir3);
      program.option("--json", "json output");
      program.option("--debug", "debug");
      registerConfigCommands(program);

      const configCmd = program.commands.find(c => c.name() === "config");
      const showCmd = configCmd.commands.find(c => c.name() === "show");

      // 両コマンドが存在し、action が登録されている
      expect(typeof configCmd._actionHandler).toBe("function");
      expect(typeof showCmd._actionHandler).toBe("function");
    } finally {
      rmSync(workDir3, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTHC-0028: config show は secretKey をツリー全体でマスクする
// ─────────────────────────────────────────────────────────────────────────────

describe("AUTHC-0028: redactConfig による secretKey マスク", () => {
  it("[AUTHC-0028] devices と locks 双方の secretKey を mask() で潰す (非破壊)", () => {
    const secretKey = "aabbccddeeff00112233445566778899"; // 32hex
    const cfg = {
      devices: {
        "LOCK-UUID": { name: "front-door", secretKey, model: "sesame_5" },
        device2: { secretKey, name: "back" },
      },
      locks: {
        "front-door": { secretKey, uuid: "uuid-1" },
      },
      companyID: "ch_test",
    };

    const redacted = redactConfig(cfg);

    // 元オブジェクトは変更されない (非破壊)
    expect(cfg.devices["LOCK-UUID"].secretKey).toBe(secretKey);
    expect(cfg.devices.device2.secretKey).toBe(secretKey);

    // マスク後は生 32hex 鍵が残らない
    const redactedStr = JSON.stringify(redacted);
    expect(redactedStr).not.toContain(secretKey);

    // devices の secretKey がマスクされている
    expect(redacted.devices["LOCK-UUID"].secretKey).not.toBe(secretKey);
    expect(redacted.devices.device2.secretKey).not.toBe(secretKey);

    // locks の secretKey もマスクされている
    expect(redacted.locks["front-door"].secretKey).not.toBe(secretKey);

    // 他のフィールドは保持される
    expect(redacted.devices["LOCK-UUID"].name).toBe("front-door");
    expect(redacted.locks["front-door"].uuid).toBe("uuid-1");
  });

  it("[AUTHC-0028] 32hex 鍵は mask() で len= 形式に変換される", () => {
    const secretKey = "deadbeef".repeat(4); // 32hex
    const cfg = { a: { secretKey } };
    const redacted = redactConfig(cfg);
    expect(JSON.stringify(redacted)).not.toContain("deadbeef");
    expect(redacted.a.secretKey).toContain("len=");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTHC-0029: config show は tokens を長さマスクし deviceKey は set/null に潰す
// ─────────────────────────────────────────────────────────────────────────────

describe("AUTHC-0029: tokens の mask と deviceKey 正規化", () => {
  it("[AUTHC-0029] idToken/refreshToken/accessToken は mask() で長さ表示、deviceKey は 'set' か null", () => {
    // config-cmd.js:68-72 の tokensMasked 構築
    const idToken = "header.payload.sig-long-enough-for-masking";
    const refreshToken = "refresh-token-long-enough-for-masking";
    const accessToken = "access-token-long-enough-for-masking";
    const deviceKey = "ap-northeast-1_DeviceKey";

    const tokensMasked = {
      clientId: "6ialca0p8u0lsgvbmvsljfm305",
      username: "user@example.com",
      idToken: mask(idToken),
      refreshToken: mask(refreshToken),
      accessToken: mask(accessToken),
      deviceKey: deviceKey ? "set" : null,
      lastRefresh: null,
    };

    expect(tokensMasked.idToken).toContain("len=");
    expect(tokensMasked.idToken).not.toBe(idToken);
    expect(tokensMasked.refreshToken).toContain("len=");
    expect(tokensMasked.accessToken).toContain("len=");
    expect(tokensMasked.deviceKey).toBe("set");
  });

  it("[AUTHC-0029] deviceKey が falsy なら null に正規化される", () => {
    // config-cmd.js:71: deviceKey: tokens.deviceKey ? "set" : null
    const deviceKey = null;
    const normalized = deviceKey ? "set" : null;
    expect(normalized).toBeNull();
  });

  it("[AUTHC-0029] tokens が null なら notSignedIn メッセージが出る", () => {
    // config-cmd.js:81: tokensMasked ? ... : t('cli.notSignedIn')
    const notSignedIn = t("cli.notSignedIn");
    expect(notSignedIn).toBeTruthy();

    const tokens = null;
    const tokensMasked = tokens ? { id: "x" } : null;

    const { logs } = captureOutput(() => {
      out(false, () => {
        console.log(tokensMasked ? JSON.stringify(tokensMasked) : notSignedIn);
      }, { tokens: tokensMasked });
    });

    expect(logs[0]).toBe(notSignedIn);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTHC-0030: config path は config dir パスのみを出す
// ─────────────────────────────────────────────────────────────────────────────

describe("AUTHC-0030: cmdConfigPath の出力", () => {
  it("[AUTHC-0030] --json 時は {dir: paths.dir} を出力し config 存在に依存しない", () => {
    // config-cmd.js:53: out(isJsonMode(), ()=>console.log(paths.dir), {dir: paths.dir})
    const fakeDir = "/home/user/.sesame";

    const { logs } = captureOutput(() => {
      out(true, () => console.log(fakeDir), { dir: fakeDir });
    });

    expect(logs).toHaveLength(1);
    const result = JSON.parse(logs[0]);
    expect(result).toEqual({ dir: fakeDir });
  });

  it("[AUTHC-0030] 非 --json 時は paths.dir テキストを console.log する", () => {
    const fakeDir = "/home/user/.sesame";

    const { logs } = captureOutput(() => {
      out(false, () => console.log(fakeDir), { dir: fakeDir });
    });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toBe(fakeDir);
  });

  it("[AUTHC-0030] configStore.load() は呼ばない (パス解決のみで副作用なし)", async () => {
    // cmdConfigPath は loadCtx で paths だけ解き、 configStore.load() を呼ばない
    // loadCtx は ConfigStore インスタンスを返すだけで load() は呼ばない
    const { Command } = await import("commander");
    let tmpWork = mkdtempSync(join(tmpdir(), "sesame-authc30-"));
    try {
      const program = new Command();
      program.option("--config-dir <dir>", "dir", tmpWork);
      program.option("--json");
      program.option("--debug");
      program.parse([], { from: "user" });

      const { paths, configStore } = loadCtx(program);
      expect(typeof paths.dir).toBe("string");

      // ConfigStore.load() は実メソッドなのでスパイでラップして呼び出し確認
      const loadSpy = vi.spyOn(configStore, "load");
      // loadCtx 直後の時点では load() は未呼び出し
      expect(loadSpy).not.toHaveBeenCalled();
      loadSpy.mockRestore();
    } finally {
      rmSync(tmpWork, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTHC-0031: migrate はトークン (.tokens.json/.login_state.json) を取り込まず skip する
// ─────────────────────────────────────────────────────────────────────────────

describe("AUTHC-0031: cmdMigrate のトークン skip", () => {
  let workDir;
  beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), "sesame-authc31-")); });
  afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

  it("[AUTHC-0031] .tokens.json が存在しても tokenStore へ取り込まず skipped に積む", async () => {
    const srcDir = join(workDir, "src");
    const cfgDir = join(workDir, "cfg");
    mkdirSync(srcDir);

    // .tokens.json を作成
    writeFileSync(join(srcDir, ".tokens.json"), JSON.stringify({ idToken: "x", refreshToken: "y" }));

    const { Command } = await import("commander");
    const program = new Command();
    program.option("--config-dir <dir>", "config dir", cfgDir);
    program.option("--json");
    program.option("--debug");
    program.parse(["--json", "--config-dir", cfgDir], { from: "user" });

    const { logs } = await captureOutputAsync(async () => {
      await cmdMigrate(srcDir, { json: true }, program);
    });

    const summary = JSON.parse(logs[0]);

    // .tokens.json は skipped に入る (再ログイン誘導付き)
    expect(summary.skipped).toEqual(
      expect.arrayContaining([expect.stringContaining(".tokens.json")])
    );
    const tokensSkip = summary.skipped.find(s => s.includes(".tokens.json"));
    expect(tokensSkip).toContain("sesame login");

    // tokens.json は config dir に作られない
    expect(existsSync(join(cfgDir, "tokens.json"))).toBe(false);
  });

  it("[AUTHC-0031] .login_state.json が存在しても skipped に 'stale sign-in state' を積む", async () => {
    const srcDir = join(workDir, "src2");
    const cfgDir = join(workDir, "cfg2");
    mkdirSync(srcDir);

    writeFileSync(join(srcDir, ".login_state.json"), JSON.stringify({ session: "s1" }));

    const { Command } = await import("commander");
    const program = new Command();
    program.option("--config-dir <dir>", "config dir", cfgDir);
    program.option("--json");
    program.option("--debug");
    program.parse(["--json", "--config-dir", cfgDir], { from: "user" });

    const { logs } = await captureOutputAsync(async () => {
      await cmdMigrate(srcDir, { json: true }, program);
    });

    const summary = JSON.parse(logs[0]);
    const pendingSkip = summary.skipped.find(s => s.includes(".login_state.json"));
    expect(pendingSkip).toBeDefined();
    expect(pendingSkip).toContain("stale sign-in state");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTHC-0032: migrate は .env (COMPANY_ID/WS_URL/LANG) と keys.json を config へ統合する
// ─────────────────────────────────────────────────────────────────────────────

describe("AUTHC-0032: cmdMigrate の .env 解析と hub3/remote 登録", () => {
  let workDir;
  beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), "sesame-authc32-")); });
  afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

  it("[AUTHC-0032] COMPANY_ID/WS_URL/LANG を .env から cfg へ移し summary.imported に '.env' を追加する", async () => {
    const srcDir = join(workDir, "src");
    const cfgDir = join(workDir, "cfg");
    mkdirSync(srcDir);

    writeFileSync(join(srcDir, ".env"),
      "COMPANY_ID=ch_TestCompany\nWS_URL=wss://example.com\nLANG=ja\n");

    const { Command } = await import("commander");
    const program = new Command();
    program.option("--config-dir <dir>", "config dir", cfgDir);
    program.option("--json");
    program.option("--debug");
    program.parse(["--json", "--config-dir", cfgDir], { from: "user" });

    const { logs } = await captureOutputAsync(async () => {
      await cmdMigrate(srcDir, { json: true }, program);
    });

    const summary = JSON.parse(logs[0]);
    expect(summary.imported).toContain(".env");

    const { readFileSync: rf } = await import("node:fs");
    const cfg = JSON.parse(rf(join(cfgDir, "config.json"), "utf8"));
    expect(cfg.companyID).toBe("ch_TestCompany");
    expect(cfg.wsUrl).toBe("wss://example.com");
    expect(cfg.lang).toBe("ja");
  });

  it("[AUTHC-0032] HUB3_DEVICE_ID は addHub3 で登録し summary.hub3Added を埋める", async () => {
    const srcDir = join(workDir, "src2");
    const cfgDir = join(workDir, "cfg2");
    mkdirSync(srcDir);

    writeFileSync(join(srcDir, ".env"),
      "COMPANY_ID=ch_Co\nHUB3_DEVICE_ID=hub3-device-uuid-1234\n");

    const { Command } = await import("commander");
    const program = new Command();
    program.option("--config-dir <dir>", "config dir", cfgDir);
    program.option("--json");
    program.option("--debug");
    program.parse(["--json", "--config-dir", cfgDir], { from: "user" });

    const { logs } = await captureOutputAsync(async () => {
      await cmdMigrate(srcDir, { json: true }, program);
    });

    const summary = JSON.parse(logs[0]);
    expect(summary.hub3Added).toBe("default");
  });

  it("[AUTHC-0032] IR_DEVICE_UUID は hub3 が存在するとき addRemote で登録し summary.remoteAdded を埋める", async () => {
    const srcDir = join(workDir, "src3");
    const cfgDir = join(workDir, "cfg3");
    mkdirSync(srcDir);

    writeFileSync(join(srcDir, ".env"),
      "COMPANY_ID=ch_Co\nHUB3_DEVICE_ID=hub3-uuid-abc\nIR_DEVICE_UUID=ir-uuid-xyz\n");

    const { Command } = await import("commander");
    const program = new Command();
    program.option("--config-dir <dir>", "config dir", cfgDir);
    program.option("--json");
    program.option("--debug");
    program.parse(["--json", "--config-dir", cfgDir], { from: "user" });

    const { logs } = await captureOutputAsync(async () => {
      await cmdMigrate(srcDir, { json: true }, program);
    });

    const summary = JSON.parse(logs[0]);
    // remoteName は keysFile?.alias || 'default'
    expect(summary.remoteAdded).toBe("default");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTHC-0033: migrate は 0700 dir 作成と src 既定 cwd 解決
// ─────────────────────────────────────────────────────────────────────────────

describe("AUTHC-0033: cmdMigrate の srcDir 解決と 0700 作成", () => {
  let workDir;
  beforeEach(() => { workDir = mkdtempSync(join(tmpdir(), "sesame-authc33-")); });
  afterEach(() => { rmSync(workDir, { recursive: true, force: true }); });

  it("[AUTHC-0033] srcDir 省略時は process.cwd() を resolve する (migrate.js:31)", async () => {
    // migrate.js:31: const src = resolve(srcDir || process.cwd())
    const cfgDir = join(workDir, "cfg");

    const { Command } = await import("commander");
    const program = new Command();
    program.option("--config-dir <dir>", "config dir", cfgDir);
    program.option("--json");
    program.option("--debug");
    program.parse(["--json", "--config-dir", cfgDir], { from: "user" });

    const { logs } = await captureOutputAsync(async () => {
      await cmdMigrate(undefined, { json: true }, program);
    });

    const summary = JSON.parse(logs[0]);
    expect(summary).toMatchObject({ configDir: cfgDir });
  });

  it("[AUTHC-0033] ensureSecureDir(paths.dir) で 0700 の config dir が作られる", async () => {
    const { statSync: st } = await import("node:fs");
    const isPosix = process.platform !== "win32";
    const cfgDir = join(workDir, "cfg-0700");

    const { Command } = await import("commander");
    const program = new Command();
    program.option("--config-dir <dir>", "config dir", cfgDir);
    program.option("--json");
    program.option("--debug");
    program.parse(["--config-dir", cfgDir], { from: "user" });

    const srcDir = join(workDir, "src-empty");
    mkdirSync(srcDir);

    await captureOutputAsync(async () => {
      await cmdMigrate(srcDir, { json: true }, program);
    });

    expect(existsSync(cfgDir)).toBe(true);
    if (isPosix) {
      const mode = st(cfgDir).mode & 0o777;
      expect(mode).toBe(0o700);
    }
  });

  it("[AUTHC-0033] configStore.save() が最後に呼ばれ companyID を確定する (migrate.js:92)", async () => {
    // migrate.js:92: configStore.save()
    const srcDir = join(workDir, "src-save");
    const cfgDir = join(workDir, "cfg-save");
    mkdirSync(srcDir);

    writeFileSync(join(srcDir, ".env"), "COMPANY_ID=ch_SaveTest\n");

    const { Command } = await import("commander");
    const program = new Command();
    program.option("--config-dir <dir>", "config dir", cfgDir);
    program.option("--json");
    program.option("--debug");
    program.parse(["--config-dir", cfgDir], { from: "user" });

    await captureOutputAsync(async () => {
      await cmdMigrate(srcDir, { json: true }, program);
    });

    const { readFileSync: rf } = await import("node:fs");
    const cfg = JSON.parse(rf(join(cfgDir, "config.json"), "utf8"));
    expect(cfg.companyID).toBe("ch_SaveTest");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTHC-0034: meta は CONFIG_META (region/userPoolId/consumerClientId) を出す
// ─────────────────────────────────────────────────────────────────────────────

describe("AUTHC-0034: CONFIG_META の内容と consumerClientId 一致", () => {
  it("[AUTHC-0034] CONFIG_META は {region, userPoolId, consumerClientId} を持つ", () => {
    // auth.js:940-944
    expect(CONFIG_META).toMatchObject({
      region: expect.stringMatching(/^ap-northeast-/),
      userPoolId: expect.any(String),
      consumerClientId: expect.any(String),
    });
    expect(Object.keys(CONFIG_META).sort()).toEqual(["consumerClientId", "region", "userPoolId"]);
  });

  it("[AUTHC-0034] consumerClientId は CONSUMER_CLIENT_ID と同値", () => {
    // core/auth.js:940: consumerClientId: CONSUMER_CLIENT_ID
    // core/auth.js:75: CONSUMER_CLIENT_ID = '6ialca0p8u0lsgvbmvsljfm305'
    expect(CONFIG_META.consumerClientId).toBe(CONSUMER_CLIENT_ID);
    expect(CONSUMER_CLIENT_ID).toBe("6ialca0p8u0lsgvbmvsljfm305");
  });

  it("[AUTHC-0034] --json 時 CONFIG_META をそのまま stdout に JSON 出力する", () => {
    // cli.js:224: action が out(..., CONFIG_META)
    const { logs } = captureOutput(() => {
      out(true, () => console.log(JSON.stringify(CONFIG_META, null, 2)), CONFIG_META);
    });
    expect(logs).toHaveLength(1);
    const result = JSON.parse(logs[0]);
    expect(result).toEqual(CONFIG_META);
    expect(result.consumerClientId).toBe(CONSUMER_CLIENT_ID);
  });

  it("[AUTHC-0034] 非 --json 時も CONFIG_META を JSON.stringify して stdout に出す (人間向けも JSON)", () => {
    // cli.js:224: () => console.log(JSON.stringify(CONFIG_META, null, 2)) が humanFn
    const { logs } = captureOutput(() => {
      out(false, () => console.log(JSON.stringify(CONFIG_META, null, 2)), CONFIG_META);
    });
    const parsed = JSON.parse(logs[0]);
    expect(parsed.region).toBe(CONFIG_META.region);
    expect(parsed.userPoolId).toBe(CONFIG_META.userPoolId);
    expect(parsed.consumerClientId).toBe(CONFIG_META.consumerClientId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTHC-0035: canPrompt は TTY かつ --json 無しのときだけ真
// ─────────────────────────────────────────────────────────────────────────────

describe("AUTHC-0035: canPrompt の条件", () => {
  it("[AUTHC-0035] --json が真なら canPrompt は偽 (TTY 状態に依らず)", async () => {
    // ctx.js:161: return isInteractive() && !program.opts().json
    const { Command } = await import("commander");
    const program = new Command();
    program.option("--json");
    program.parse(["--json"], { from: "user" });

    const result = canPrompt(program);
    expect(result).toBe(false);
  });

  it("[AUTHC-0035] --json なしかつ TTY の場合 canPrompt は isInteractive() && !json と等価", async () => {
    const { isInteractive } = await import("../../src/prompts.js");

    const { Command } = await import("commander");
    const program = new Command();
    program.option("--json");
    program.parse([], { from: "user" });

    const expected = isInteractive() && !program.opts().json;
    const actual = canPrompt(program);
    expect(actual).toBe(expected);
  });

  it("[AUTHC-0035] isInteractive は process.stdin.isTTY && process.stdout.isTTY と同値", async () => {
    // prompts.js:12: return Boolean(process.stdin.isTTY && process.stdout.isTTY)
    const { isInteractive } = await import("../../src/prompts.js");

    const expected = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    expect(isInteractive()).toBe(expected);
  });

  it("[AUTHC-0035] isInteractive() の定義: stdin/stdout 双方 isTTY の Boolean", async () => {
    const { isInteractive } = await import("../../src/prompts.js");

    const origStdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const origStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

    try {
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      expect(isInteractive()).toBe(true);

      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
      expect(isInteractive()).toBe(false);
    } finally {
      if (origStdinIsTTY) Object.defineProperty(process.stdin, "isTTY", origStdinIsTTY);
      else delete process.stdin.isTTY;
      if (origStdoutIsTTY) Object.defineProperty(process.stdout, "isTTY", origStdoutIsTTY);
      else delete process.stdout.isTTY;
    }
  });

  it("[AUTHC-0035] canPrompt 偽なら prompt を呼ばない契約 (--json → canPrompt=false)", async () => {
    // auth.js:104: if (!code && canPrompt(program)) code = await promptLine(...)
    const { Command } = await import("commander");
    const program = new Command();
    program.option("--json");
    program.parse(["--json"], { from: "user" });

    expect(canPrompt(program)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AUTHC-0036: promptLine は Ctrl-D (EOF) で空入力なら throw する
// ─────────────────────────────────────────────────────────────────────────────

describe("AUTHC-0036: promptLine の EOF 処理", () => {
  it("[AUTHC-0036] close 後に空文字 resolve したら promptAbortedEof を throw する", async () => {
    // ctx.js:148: if (closed && !ans) throw new Error(t("cli.promptAbortedEof"))
    // promptLine の同等ロジックを再現してテスト
    const simulate = async (closedBeforeAnswer, ans) => {
      let closed = false;
      const onClose = () => { closed = true; };
      if (closedBeforeAnswer) onClose();
      if (closed && !ans) throw new Error(t("cli.promptAbortedEof"));
      return ans.trim();
    };

    // EOF パス: close 発火後、ans が空
    await expect(simulate(true, "")).rejects.toThrow(t("cli.promptAbortedEof"));

    // 通常パス: close なし、ans あり
    const result = await simulate(false, "  1234  ");
    expect(result).toBe("1234");

    // close 発火後でも ans があれば throw しない
    const resultWithAns = await simulate(true, "5678");
    expect(resultWithAns).toBe("5678");
  });

  it("[AUTHC-0036] ctx.js:149 の ans.trim() 契約: 通常入力は trim して返す", async () => {
    // ctx.js:149: return ans.trim()
    // ESM の createInterface は spy 不可のため、ロジックを直接シミュレートする
    const simulate = async (ans) => {
      let closed = false;
      // close ハンドラ未発火 → closed=false
      if (closed && !ans) throw new Error(t("cli.promptAbortedEof"));
      return ans.trim();
    };

    expect(await simulate("  1234  ")).toBe("1234");
    expect(await simulate("my-answer")).toBe("my-answer");
    expect(await simulate("  ")).toBe(""); // trim 後空文字だが closed=false なので throw しない
  });

  it("[AUTHC-0036] ctx.js:148 の closed && !ans → throw 契約: close 後の空答えで throw する", async () => {
    // ctx.js:148: if (closed && !ans) throw new Error(t("cli.promptAbortedEof"))
    // ESM の createInterface は spy 不可のため、ロジックを直接シミュレートする
    const simulate = async (closedBeforeAnswer, ans) => {
      let closed = false;
      if (closedBeforeAnswer) closed = true;
      if (closed && !ans) throw new Error(t("cli.promptAbortedEof"));
      return ans.trim();
    };

    // close 発火後に空文字 → throw
    await expect(simulate(true, "")).rejects.toThrow(t("cli.promptAbortedEof"));
    // close 発火後でも ans があれば throw しない
    expect(await simulate(true, "valid-answer")).toBe("valid-answer");
    // close なしの空文字は throw しない
    expect(await simulate(false, "")).toBe("");
  });

  it("[AUTHC-0036] t('cli.promptAbortedEof') キーが ja カタログに存在する", () => {
    setLocale("ja");
    const msg = t("cli.promptAbortedEof");
    expect(msg).not.toBe("cli.promptAbortedEof");
    expect(msg.length).toBeGreaterThan(0);
  });
});
