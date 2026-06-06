// commander ベースの CLI。bin/sesame.js から run() を呼ぶ。
//
// 設計メモ:
// - グローバルオプション --config-dir / --debug / --json は program.opts() で取得
// - 全コマンドは loadCtx() でファクトリ越しに ConfigStore / TokenStore を得る
// - 出力は --json 指定時に JSON.stringify、それ以外は人間可読
// - 位置引数が足りない & TTY & !--json なら対話 prompt (src/prompts.js)

import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { SesameHub3 } from "./client.js";
import { ConfigStore } from "./config.js";
import { FileTokenStore } from "./tokens.js";
import { configPaths } from "./paths.js";
import {
  bootstrap,
  CONFIG_META,
  getValidIdToken,
  loginInitiate,
  loginVerify,
} from "./auth.js";
import { isInteractive, selectFromList, promptText, confirm as confirmPrompt } from "./prompts.js";
import { parseIrType, DEFAULT_IR_TYPE } from "./crypto.js";
import { registerScheduleCommands } from "./cli/schedule.js";
import { registerCompanyCommands } from "./cli/company.js";
import { registerOrgCommands } from "./cli/org.js";
import { registerAccessCommands } from "./cli/access.js";
import { registerIotCommands } from "./cli/iot.js";
import { registerPresetIrCommands } from "./cli/presetir.js";
import { registerServeCommand } from "./cli/serve.js";
import { SesameBle, capabilitiesForModel, transportsForOp } from "./ble/index.js";
import { bleWasUsed } from "./ble/transport.js";
import { EventEmitter } from "node:events";
// session-ui (ink + react) は session でしか使わないので、起動コスト削減のため動的 import する。

const __dirname = dirname(fileURLToPath(import.meta.url));

// `--json` がグローバルに指定されているか。run() 冒頭で argv から確定し、
// die()/エラー経路など program.opts() を取れない場所でも JSON 契約を守れるようにする。
// (--json 時: 成功は stdout に純 JSON 1件、エラーは stderr に {error,code} JSON、で統一)
let CLI_JSON = false;

// ---------- 共通ユーティリティ ----------

function getPkgVersion() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function mask(s) {
  if (typeof s !== "string") return s ?? "(none)";
  if (s.length <= 8) return s;
  return `${s.slice(0, 4)}…${s.slice(-4)} (len=${s.length})`;
}

function out(json, humanFn, jsonObj) {
  if (json) console.log(JSON.stringify(jsonObj, null, 2));
  else humanFn();
}

function die(msg, code = 1) {
  // エラーは常に stderr へ (stdout は成功 JSON 専用に保つ)。--json 時は構造化封筒で出す。
  if (CLI_JSON) console.error(JSON.stringify({ error: msg, code }));
  else console.error(`Error: ${msg}`);
  process.exit(code);
}

/** program.opts() を吸い上げて ConfigStore / TokenStore / paths を返す。 */
function loadCtx(program) {
  const opts = program.opts();
  const paths = configPaths(opts.configDir);
  const configStore = new ConfigStore(paths.config);
  const tokenStore = new FileTokenStore({
    tokensPath: paths.tokens,
    loginStatePath: paths.loginState,
  });
  return { opts, paths, configStore, tokenStore };
}

/**
 * cli/ サブモジュール (registerXxxCommands) に渡す共有コンテキスト。
 * program を内部に束縛し、新コマンドが cli.js の private helper に直接依存せず
 * ctx 越しに利用できるようにする (循環 import 回避 + cli.js 肥大化防止)。
 *
 * @param {import("commander").Command} program
 */
function makeCtx(program) {
  return {
    /** out(json, humanFn, jsonObj): --json 指定時は jsonObj を、それ以外は humanFn() を出力 */
    out,
    /** die(msg, code=1): エラー表示して exit */
    die,
    /** canPrompt(): TTY かつ --json なし */
    canPrompt: () => canPrompt(program),
    /** loadCtx(): { opts, paths, configStore, tokenStore } */
    loadCtx: () => loadCtx(program),
    /** withHub(fn): connect → fn(hub, {opts, paths}) → close */
    withHub: (fn) => withHub(program, fn),
    /**
     * withAccount(fn): withHub に加え、実行前に refreshAccount() で実 companyID /
     * subUUID を保証する (org / company など companyID 必須の op 用)。
     * refreshAccount() の戻り (customerInfo) を fn の第2引数 extra.customerInfo に渡すため、
     * employeeEmail/subUUID が要るコマンドは getLoginUser() を再度呼ばず済む。
     */
    withAccount: (fn) =>
      withHub(program, async (hub, extra) => {
        const customerInfo = await hub.refreshAccount();
        return fn(hub, { ...extra, customerInfo });
      }),
    /** 対話 prompt 群 */
    prompts: { selectFromList, promptText, confirm: confirmPrompt, promptLine },
    /**
     * parseJson(raw, hint): --json 文字列を JSON.parse。失敗時は die(...,2) し undefined を返す。
     * cli/ 各モジュールで重複していた parseJsonArg を 1 本化したもの。
     */
    parseJson(raw, hint) {
      try {
        return JSON.parse(raw);
      } catch (e) {
        die(`--json の値が不正な JSON です: ${e.message}${hint ? `\n  例: ${hint}` : ""}`, 2);
        return undefined;
      }
    },
  };
}

async function withHub(program, fn) {
  const { opts, paths, configStore, tokenStore } = loadCtx(program);
  if (!configStore.exists()) {
    die(
      `No config at ${paths.config}. \`sesame init\` または \`sesame migrate\` を実行してください。`,
      2,
    );
  }
  const hub = new SesameHub3({
    config: configStore.load(),
    configStore,
    tokenStore,
    debug: !!opts.debug,
  });
  try {
    await hub.connect();
    return await fn(hub, { opts, paths });
  } finally {
    await hub.close();
  }
}

async function promptLine(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let closed = false;
  rl.once("close", () => { closed = true; });
  try {
    const ans = await rl.question(question);
    // 3rd-pass L-1: Ctrl-D (EOF) で空文字 resolve した場合は throw (無限ループ防止)
    if (closed && !ans) throw new Error("prompt aborted (EOF / Ctrl-D)");
    return ans.trim();
  } finally {
    rl.close();
  }
}

/** prompts が許可される条件: TTY かつ --json 指定なし。 */
function canPrompt(program) {
  return isInteractive() && !program.opts().json;
}

/** 名前未指定 & 対話可能なら、設定済みリストから選択させる。 */
async function pickRemoteName(program, configStore, current) {
  if (current) return current;
  const cfg = configStore.load();
  const names = Object.keys(cfg.remotes || {});
  if (names.length === 0) die("リモコンが未登録です。先に `sesame remote add` を実行してください。", 2);
  if (names.length === 1) return names[0];
  if (!canPrompt(program)) return null;
  return selectFromList("どのリモコン?", names, (n) => {
    const r = cfg.remotes[n];
    const def = n === cfg.default?.remote ? " *" : "";
    return `${n}${def}\thub3=${r.hub3}\tkeys=${Object.keys(r.keys || {}).length}${r.alias ? `\t(${r.alias})` : ""}`;
  });
}

async function pickLockName(program, configStore, current) {
  if (current) return current;
  const cfg = configStore.load();
  const names = Object.keys(cfg.locks || {});
  if (names.length === 0) die("ロックが未登録です。`sesame lock add` か `sesame lock sync-from-devices` を実行してください。", 2);
  if (names.length === 1) return names[0];
  if (!canPrompt(program)) return null;
  return selectFromList("どのロック?", names, (n) => {
    const l = cfg.locks[n];
    const def = n === cfg.default?.lock ? " *" : "";
    return `${n}${def}\t${l.deviceUUID}\tmodel=${l.model || "?"}${l.alias ? `\t(${l.alias})` : ""}`;
  });
}

async function pickHub3Name(program, configStore, current) {
  if (current) return current;
  const cfg = configStore.load();
  const names = Object.keys(cfg.hub3s || {});
  if (names.length === 0) die("Hub3 が未登録です。`sesame hub3 add` を実行してください。", 2);
  if (names.length === 1) return names[0];
  if (!canPrompt(program)) return null;
  return selectFromList("どの Hub3?", names, (n) => `${n}\t${cfg.hub3s[n].deviceId}`);
}

async function pickRemoteKeyName(program, configStore, remoteName, current) {
  if (current) return current;
  const cfg = configStore.load();
  const remote = cfg.remotes?.[remoteName];
  if (!remote) die(`Unknown remote "${remoteName}"`, 2);
  const keys = Object.keys(remote.keys || {});
  if (keys.length === 0) die(`remote "${remoteName}" にキーがありません。`, 2);
  if (!canPrompt(program)) return null;
  return selectFromList(`remote "${remoteName}" のどのキー?`, keys, (k) => `${k}\t${remote.keys[k]}`);
}

/** Hub から デバイス一覧を取って UUID を選ばせる (model フィルタ任意)。 */
async function pickDeviceUUID(program, hub, current, { filter, message = "どのデバイス?" } = {}) {
  if (current) return current;
  let list;
  try { list = await hub.listUserDevices(); } catch { list = []; }
  if (!list.length) {
    try { list = await hub.listDevices(); } catch { /* ignore */ }
  }
  const filtered = filter ? (list || []).filter(filter) : (list || []);
  if (!filtered.length) die("デバイスが見つかりません。", 2);
  // 1 個ならそれを auto-pick (Review L-4)
  if (filtered.length === 1) return filtered[0].deviceUUID;
  if (!canPrompt(program)) {
    // 非対話で複数候補あり → 具体的な救済策をエラーに含める
    // (3rd-pass L-2: 外側の `list` を shadow しないようリネーム)
    const summary = filtered.map((d) => `  ${d.deviceUUID}\t${d.deviceModel || "?"}\t${d.deviceName || ""}`).join("\n");
    die(`複数のデバイスがあるため UUID 指定が必要です:\n${summary}`, 2);
  }
  const chosen = await selectFromList(message, filtered, (d) =>
    `${d.deviceName || "(no name)"}\t${d.deviceModel || "?"}\t${d.deviceUUID}`);
  return chosen.deviceUUID;
}

// ---------- コマンド: 認証 ----------

async function cmdLogin(email, opts, program) {
  if (!email) die("email required: sesame login <email>", 2);
  const { tokenStore } = loadCtx(program);
  await loginInitiate(tokenStore, email);
  out(CLI_JSON, () => {
    console.log(`OK: 確認コードを ${email} に送信しました。`);
    console.log(`Step 2: sesame verify <code>`);
  }, { ok: true, email, next: "sesame verify <code>" });
}

/**
 * 認証後の自動セットアップ。接続して companyID 取得 → ロック / Hub3+リモコン を devices から取り込む。
 * best-effort: 各ステップは個別に try/catch し、失敗しても他を続行 (ネットワーク不調で認証成功を潰さない)。
 * @returns {Promise<object>} 取り込みサマリ
 */
async function bootstrapAfterLogin(program, { quiet = false } = {}) {
  const log = (...a) => { if (!quiet) console.error(...a); };
  const summary = { companyID: null, locks: null, hub3s: null, remotes: null, errors: [] };
  try {
    await withHub(program, async (hub) => {
      try {
        const ci = await hub.refreshAccount();
        summary.companyID = ci?.companyID || null;
        log(`  ✓ アカウント (companyID=${summary.companyID || "default"})`);
      } catch (e) { summary.errors.push(`account: ${e.message}`); log(`  ✗ アカウント取得失敗: ${e.message}`); }

      try {
        const r = await hub.syncLocksFromDevices({});
        summary.locks = r;
        log(`  ✓ ロック: +${r.added.length} 更新${r.updated.length}${r.added.length ? ` (${r.added.join(", ")})` : ""}`);
      } catch (e) { summary.errors.push(`locks: ${e.message}`); log(`  ✗ ロック取り込み失敗: ${e.message}`); }

      try {
        const r = await hub.syncHub3sFromDevices();
        summary.hub3s = r;
        log(`  ✓ Hub3: +${r.added?.length || 0}${r.added?.length ? ` (${r.added.join(", ")})` : ""}`);
      } catch (e) { summary.errors.push(`hub3s: ${e.message}`); log(`  ✗ Hub3 取り込み失敗: ${e.message}`); }

      try {
        const { remotes } = await hub.syncRemotesFromDevices();
        for (const name of [...remotes.added, ...remotes.updated]) { try { await hub.syncRemoteKeys(name); } catch { /* best effort */ } }
        summary.remotes = remotes;
        log(`  ✓ Hub3 IR リモコン: +${remotes.added.length}${remotes.added.length ? ` (${remotes.added.join(", ")})` : ""}`);
      } catch (e) { summary.errors.push(`remotes: ${e.message}`); log(`  ✗ リモコン取り込み失敗: ${e.message}`); }
    });
  } catch (e) {
    summary.errors.push(`connect: ${e.message}`);
    const authExpired = /refresh token|unauthor|not authenticated|token/i.test(e.message || "");
    summary.authExpired = authExpired;
    if (authExpired) log(`  ✗ クラウド認証が切れています (${e.message})\n    → \`sesame login <email>\` → \`sesame verify\` で再ログインしてください`);
    else log(`  ✗ 接続失敗: ${e.message}\n    → 後で \`sesame setup\` で再実行できます`);
  }
  return summary;
}

async function cmdVerify(code, _opts, program) {
  const { opts, tokenStore } = loadCtx(program);
  if (!code && canPrompt(program)) code = await promptLine("Verification code: ");
  if (!code) die("code required: sesame verify <code>", 2);
  const t = await loginVerify(tokenStore, code);
  if (!opts.json) console.error("OK: signed in — セットアップを自動実行します...");
  // 認証後の取り込みを自動化 (companyID / ロック / Hub3 IR)。失敗しても認証成功は維持。
  const bootstrap = await bootstrapAfterLogin(program, { quiet: !!opts.json });
  out(opts.json, () => {
    const lk = bootstrap.locks ? bootstrap.locks.added.length + bootstrap.locks.updated.length : 0;
    console.log(`\n準備完了: ロック ${lk} 件 取り込み済み。`);
    console.log("  例: sesame unlock / sesame status / sesame session");
    if (bootstrap.errors.length) console.log("  (一部自動取り込みに失敗。`sesame setup` で再実行できます)");
  }, {
    ok: true,
    clientId: t.clientId,
    username: t.username,
    deviceKey: t.deviceKey ? "set" : null,
    bootstrap,
  });
}

/** 認証後セットアップの手動再実行 (デバイス追加後など)。 */
async function cmdSetup(_opts, program) {
  const { opts, tokenStore } = loadCtx(program);
  if (!tokenStore.load()) die("未ログインです。先に `sesame login <email>` → `sesame verify` を実行してください。", 2);
  if (!opts.json) console.error("セットアップ (companyID / ロック / Hub3 / リモコン 取り込み)...");
  const bootstrap = await bootstrapAfterLogin(program, { quiet: !!opts.json });
  const failed = bootstrap.errors.length > 0;
  out(opts.json, () => {
    if (bootstrap.authExpired) {
      console.error("✗ クラウド認証が切れています。`sesame login <email>` → `sesame verify` で再ログインしてください。");
    } else if (failed) {
      console.error(`一部失敗: ${bootstrap.errors.join("; ")}`);
    } else {
      console.log("完了。`sesame locks ls` / `sesame remote ls` で確認できます。");
    }
  }, { ok: !failed, bootstrap });
  if (failed) process.exitCode = 1;
}

async function cmdRefresh(_opts, program) {
  const { opts, tokenStore } = loadCtx(program);
  const t = await getValidIdToken(tokenStore, { marginSec: 999999 });
  out(opts.json, () => {
    console.log(`OK: idToken refreshed (len=${t.length})`);
  }, { ok: true, idTokenLength: t.length });
}

async function cmdWhoami(_opts, program) {
  await withHub(program, async (hub, { opts }) => {
    // biz3GetLoginUser で customerInfo/quotas を取得し、実 companyID を config に保存
    const customerInfo = await hub.refreshAccount();
    const quotas = (await hub.getLoginUser()).quotas;
    out(opts.json, () => {
      if (!customerInfo) { console.log("(customerInfo 取得できず)"); return; }
      console.log(`companyID: ${customerInfo.companyID}`);
      console.log(`subUUID:   ${customerInfo.subUUID || "(none)"}`);
      if (customerInfo.name) console.log(`name:      ${customerInfo.name}`);
      if (customerInfo.subscriptionId) console.log(`subscription: ${customerInfo.subscriptionId}`);
      console.log(`\ncompanyID を config.json に保存しました (以降の IR/device API で使用)。`);
    }, { ok: true, customerInfo, quotas });
  });
}

// ---------- コマンド: 操作 ----------

async function cmdSend(key, options, program) {
  const { configStore } = loadCtx(program);
  if (configStore.exists()) {
    const remoteName = await pickRemoteName(program, configStore, options.remote);
    if (!remoteName && !options.remote) die("--remote が必要です (非対話モード)", 2);
    options.remote = remoteName || options.remote;
    if (!key) {
      key = await pickRemoteKeyName(program, configStore, options.remote, key);
      if (!key) die("key が必要です (非対話モード)", 2);
    }
  } else if (!key) {
    die("key required: sesame send <key>", 2);
  }
  await withHub(program, async (hub, { opts }) => {
    const resp = await hub.send(options.remote, key);
    out(opts.json, () => {
      console.log(`OK: send ${key}`);
      if (resp?.data?.message) console.log(`   ${resp.data.message}`);
    }, { ok: true, key, response: resp });
  });
}

async function cmdList(options, program) {
  const { configStore } = loadCtx(program);
  if (configStore.exists()) {
    options.remote = await pickRemoteName(program, configStore, options.remote) || options.remote;
  }
  await withHub(program, async (hub, { opts }) => {
    const codes = await hub.listKeys(options.remote);
    out(opts.json, () => {
      if (!Array.isArray(codes) || codes.length === 0) {
        console.log("(no keys)");
        return;
      }
      console.log(`Found ${codes.length} keys:`);
      for (const c of codes) console.log(`  ${c.name}\t${c.keyUUID}`);
    }, { ok: true, count: codes.length, keys: codes });
  });
}

async function cmdPing(_opts, program) {
  await withHub(program, async (hub, { opts }) => {
    await hub.ping();
    out(opts.json, () => console.log("OK: connected & keepalive ack received"), { ok: true });
  });
}

async function cmdDevices(_opts, program) {
  await withHub(program, async (hub, { opts, paths }) => {
    const list = await hub.listDevices();
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.devices, JSON.stringify({ devices: list }, null, 2) + "\n");
    out(opts.json, () => {
      console.log(`Found ${list.length} devices:\n`);
      for (const d of list) {
        console.log(`  ${d.deviceName}`);
        console.log(`    model:     ${d.deviceModel}`);
        console.log(`    UUID:      ${d.deviceUUID}`);
        console.log(`    keyLevel:  ${d.keyLevel}`);
        console.log(`    publicKey: ${mask(d.sesame2PublicKey)}`);
        console.log(`    secretKey: ${mask(d.secretKey)}`);
        console.log("");
      }
      console.log(`Saved: ${paths.devices}`);
    }, { ok: true, count: list.length, devices: list, savedTo: paths.devices });
  });
}

// ---------- コマンド: セットアップ / 設定 ----------

async function cmdInit(_opts, program) {
  const { opts, paths, configStore } = loadCtx(program);
  mkdirSync(paths.dir, { recursive: true });
  const created = configStore.init();
  out(opts.json, () => {
    if (created) console.log(`OK: created ${paths.config}`);
    else         console.log(`Already exists: ${paths.config}`);
    console.log(``);
    console.log(`このツールは Node.js 18+ が必要です (現在: ${process.version})。`);
    console.log(`companyID はデフォルト (ch_CandyhouseMobile) のままで一般ユーザーは変更不要です。`);
    console.log(``);
    console.log(`次のステップ (所要 約3分):`);
    console.log(`  1. sesame login <email>             # email に確認コードが届く → sesame verify <code>`);
    console.log(`  2a. ロックを使うなら:  sesame lock sync-from-devices     # 自動取り込み`);
    console.log(`  2b. Hub3 IR を使うなら: sesame remote sync-from-devices   # Hub3+リモコン+キーを一括取得`);
    console.log(``);
    console.log(`概念: Hub3=IR を飛ばす中継器 / remote=リモコン定義 / lock=施錠デバイス。`);
    console.log(`     IR を使うには Hub3 と remote の両方を登録する必要があります。`);
    console.log(`     irType は整数コード (例 49152=エアコン / 8192=テレビ) だが、通常は自動取得され意識不要。`);
    console.log(``);
    console.log(`※ \`sesame\` コマンドが見つからない場合は \`npm link\` を実行してください`);
    console.log(`  (または \`node bin/sesame.js ...\` で直接起動)。`);
  }, { ok: true, created, configPath: paths.config, nodeVersion: process.version });
}

async function cmdConfigPath(opts, program) {
  const { paths } = loadCtx(program);
  out(CLI_JSON, () => console.log(paths.dir), { dir: paths.dir });
}

async function cmdConfigShow(_opts, program) {
  const { opts, paths, configStore, tokenStore } = loadCtx(program);
  const cfg = configStore.exists() ? configStore.load() : null;
  const tokens = tokenStore.load();
  const tokensMasked = tokens
    ? {
        clientId: tokens.clientId,
        username: tokens.username,
        idToken: mask(tokens.idToken),
        refreshToken: mask(tokens.refreshToken),
        accessToken: mask(tokens.accessToken),
        deviceKey: tokens.deviceKey ? "set" : null,
        lastRefresh: tokens.lastRefresh,
      }
    : null;
  out(opts.json, () => {
    console.log(`config dir: ${paths.dir}`);
    console.log(`---- config.json ----`);
    console.log(cfg ? JSON.stringify(cfg, null, 2) : "(not initialized)");
    console.log(`---- tokens.json (masked) ----`);
    console.log(tokensMasked ? JSON.stringify(tokensMasked, null, 2) : "(not signed in)");
  }, { configDir: paths.dir, config: cfg, tokens: tokensMasked });
}

async function cmdRemoteLs(_opts, program) {
  const { opts, configStore } = loadCtx(program);
  if (!configStore.exists()) die("config not initialized. sesame init", 2);
  const cfg = configStore.load();
  const remotes = cfg.remotes || {};
  const def = cfg.default?.remote;
  out(opts.json, () => {
    const names = Object.keys(remotes);
    if (!names.length) { console.log("(no remotes)"); return; }
    for (const n of names) {
      const r = remotes[n];
      const mark = n === def ? "*" : " ";
      const keyCount = Object.keys(r.keys || {}).length;
      console.log(`${mark} ${n}\thub3=${r.hub3}\tIR=${r.irDeviceUUID}\tkeys=${keyCount}${r.alias ? `\talias=${r.alias}` : ""}`);
    }
    console.log("\n(* = default)");
  }, { default: def, remotes });
}

async function cmdRemoteAdd(_opts, program) {
  // devices の応答だけで完結: Hub3 配下リモコン (uuid+type) を一覧から選ぶ。
  // irType も irDeviceUUID も手打ちさせない。
  await withHub(program, async (hub, { opts }) => {
    await hub.syncHub3sFromDevices(); // hub3 名を確保
    const candidates = await hub.listRemotesFromDevices();
    if (!candidates.length) {
      console.error("登録済みリモコンが見つかりません。biz3 アプリ等で先にリモコンを学習・登録してください。");
      return;
    }
    const chosen = candidates.length === 1
      ? candidates[0]
      : await selectFromList("どのリモコン?", candidates,
          (r) => `${r.alias || "(no name)"}\thub3=${r.hub3Name}\ttype=${r.type}\t${r.uuid}`);

    // chosen.hub3DeviceUUID に対応する config 上の hub3 名を解決
    const cfg = hub.config;
    const hub3Entry = Object.entries(cfg.hub3s).find(
      ([, h]) => h.deviceId.replace(/-/g, "").toLowerCase() === chosen.hub3DeviceUUID.replace(/-/g, "").toLowerCase(),
    );
    const hub3Name = hub3Entry ? hub3Entry[0] : null;
    if (!hub3Name) die("リモコンの親 Hub3 が config に見つかりません (hub3 sync-from-devices を試してください)", 2);

    const defaultName = (chosen.alias || "remote").replace(/\s+/g, "_").toLowerCase();
    const name = canPrompt(program)
      ? await promptText("config 上の呼び名", { defaultValue: defaultName })
      : defaultName;

    hub.configStore.addRemote(name, {
      hub3: hub3Name,
      irDeviceUUID: chosen.uuid,
      irType: chosen.type,
      irOperation: "learnEmit",
      alias: chosen.alias,
      keys: {},
    });
    const { keyCount } = await hub.syncRemoteKeys(name); // 末尾で自動 sync-keys
    out(opts.json, () => {
      console.log(`OK: remote "${name}" added (hub3=${hub3Name}, irType=${chosen.type}, keys=${keyCount})`);
    }, { ok: true, name, hub3: hub3Name, irType: chosen.type, keyCount });
  });
}

async function cmdRemoteSetDefault(name, opts, program) {
  const { configStore } = loadCtx(program);
  configStore.setDefaultRemote(name);
  out(CLI_JSON, () => console.log(`OK: default remote = ${name}`), { ok: true, defaultRemote: name });
}

async function cmdRemoteSyncKeys(name, opts, program) {
  await withHub(program, async (hub) => {
    const { name: resolvedName, keyCount } = await hub.syncRemoteKeys(name);
    out(CLI_JSON, () => console.log(`OK: synced ${keyCount} keys → remote "${resolvedName}"`),
      { ok: true, remote: resolvedName, keyCount });
  });
}

async function cmdHub3Ls(_opts, program) {
  const { opts, configStore } = loadCtx(program);
  if (!configStore.exists()) die("config not initialized. sesame init", 2);
  const cfg = configStore.load();
  const hub3s = cfg.hub3s || {};
  out(opts.json, () => {
    const names = Object.keys(hub3s);
    if (!names.length) { console.log("(no hub3)"); return; }
    for (const n of names) {
      const h = hub3s[n];
      console.log(`  ${n}\t${h.deviceId}${h.name && h.name !== n ? `\t(${h.name})` : ""}`);
    }
  }, { hub3s });
}

async function cmdHub3Add(_opts, program) {
  // devices から Hub3 を引いて選択式に (UUID 手打ちを排除)。
  await withHub(program, async (hub, { opts }) => {
    const list = await hub.listDevices();
    const hub3Devices = list.filter((d) => d.deviceModel === "hub_3" || d.deviceModel === "hub_3_lte");
    if (!hub3Devices.length) {
      console.error("Hub3 が devices に見つかりません。手動登録するなら configStore.addHub3 を直接利用してください。");
      return;
    }
    const chosen = hub3Devices.length === 1
      ? hub3Devices[0]
      : await selectFromList("どの Hub3?", hub3Devices,
          (d) => `${d.deviceName || "(no name)"}\t${d.deviceUUID}`);
    const defaultName = (chosen.deviceName || chosen.deviceUUID).replace(/\s+/g, "_").toLowerCase();
    const name = canPrompt(program)
      ? await promptText("config 上の呼び名", { defaultValue: defaultName })
      : defaultName;
    hub.configStore.addHub3(name, { deviceId: chosen.deviceUUID, name: chosen.deviceName || name });
    out(opts.json, () => console.log(`OK: hub3 "${name}" added (${chosen.deviceUUID})`),
      { ok: true, name, deviceId: chosen.deviceUUID });
  });
}

// ---------- コマンド: lock ----------

async function cmdLockLs(_opts, program) {
  const { opts, configStore } = loadCtx(program);
  if (!configStore.exists()) die("config not initialized. sesame init", 2);
  const cfg = configStore.load();
  const locks = cfg.locks || {};
  const def = cfg.default?.lock;
  out(opts.json, () => {
    const names = Object.keys(locks);
    if (!names.length) { console.log("(no locks)"); return; }
    for (const n of names) {
      const l = locks[n];
      const mark = n === def ? "*" : " ";
      console.log(`${mark} ${n}\t${l.deviceUUID}\tmodel=${l.model || "?"}${l.alias ? `\t(${l.alias})` : ""}`);
    }
    console.log("\n(* = default)");
  }, { default: def, locks });
}

async function cmdLockAdd(opts, program) {
  const { configStore } = loadCtx(program);
  if (!configStore.exists()) die("config not initialized. sesame init", 2);

  // フラグ指定があれば非対話で登録 (他言語からの呼び出し/--json 用)。
  // 不足分は TTY なら prompt で補い、非対話なら die で明示拒否する (固まらせない)。
  const ask = async (flag, label, required) => {
    if (opts[flag] != null) return opts[flag];
    if (canPrompt(program)) return await promptLine(label);
    if (required) die(`${flag} required (非対話モードでは --${flag} を指定してください)`, 2);
    return null;
  };
  const name = await ask("name", "lock name (例: front): ", true);
  if (!name) die("name required", 2);
  const deviceUUID = await ask("uuid", "deviceUUID: ", true);
  if (!deviceUUID) die("deviceUUID required", 2);
  const secretKey = await ask("secret", "secretKey (32hex, devices コマンドで取得): ", true);
  if (!secretKey) die("secretKey required", 2);
  const model = await ask("model", "model (例: sesame_5, sesame_5_pro, sesame_6, wm_2): ", false);
  const alias = await ask("alias", "alias (任意, 例: 玄関): ", false);
  configStore.addLock(name, {
    deviceUUID,
    secretKey,
    model: model || null,
    alias: alias || null,
  });
  out(CLI_JSON, () => console.log(`OK: lock "${name}" added.`),
    { ok: true, lock: name, deviceUUID, model: model || null, alias: alias || null });
}

async function cmdLockSetDefault(name, opts, program) {
  const { configStore } = loadCtx(program);
  configStore.setDefaultLock(name);
  out(CLI_JSON, () => console.log(`OK: default lock = ${name}`), { ok: true, defaultLock: name });
}

async function cmdLockRm(name, options, program) {
  const { configStore } = loadCtx(program);
  // Review M-4: 確認 prompt 追加 (secretKey が消えると復旧は devices 再取得が必要)
  // 2nd-pass M-4: 非対話モードでは prompt 不能なので --yes が無いと拒否
  if (canPrompt(program)) {
    if (!(await confirmPrompt(
      `lock "${name}" の定義を削除しますか? (secretKey も消えるので、復旧には sesame devices で再取得が必要)`,
      { defaultYes: false },
    ))) {
      return console.error("キャンセル");
    }
  } else if (!options.yes) {
    die(`非対話モードでは確認 prompt が出せません。意図して削除する場合は --yes を付けてください。`, 2);
  }
  configStore.removeLock(name);
  out(CLI_JSON, () => console.log(`OK: lock "${name}" removed.`), { ok: true, removed: name });
}

async function cmdLockSyncFromDevices(options, program) {
  await withHub(program, async (hub, { opts }) => {
    const r = await hub.syncLocksFromDevices({ prune: !!options.prune });
    printSyncResult(opts.json, "lock", r);
  });
}

async function cmdHub3SyncFromDevices(options, program) {
  await withHub(program, async (hub, { opts }) => {
    const r = await hub.syncHub3sFromDevices({ prune: !!options.prune });
    printSyncResult(opts.json, "hub3", r);
  });
}

async function cmdRemoteSyncFromDevices(_options, program) {
  // 引数不要。devices の各 Hub3 stateInfo.remoteList から irType 込みで全リモコン取り込み。
  await withHub(program, async (hub, { opts }) => {
    const { remotes } = await hub.syncRemotesFromDevices();
    // 取り込んだ各 remote のキーも同期
    for (const name of [...remotes.added, ...remotes.updated]) {
      try { await hub.syncRemoteKeys(name); } catch { /* best effort */ }
    }
    printSyncResult(opts.json, "remote", remotes);
  });
}

/** sync 系の結果 (added/updated/removed) を整形出力。 */
function printSyncResult(json, kind, r) {
  out(json, () => {
    const parts = [];
    if (r.added?.length)   parts.push(`+${r.added.length} (${r.added.join(", ")})`);
    if (r.updated?.length) parts.push(`~${r.updated.length} (${r.updated.join(", ")})`);
    if (r.removed?.length) parts.push(`-${r.removed.length} (${r.removed.join(", ")})`);
    console.log(`OK: ${kind} sync — ${parts.join(" / ") || "変更なし"}`);
  }, { ok: true, kind, ...r });
}

// ---------- コマンド: IR advanced (Phase C) ----------

async function cmdIRLearn(remoteName, keyName, _opts, program) {
  const { configStore } = loadCtx(program);
  if (configStore.exists()) {
    remoteName = await pickRemoteName(program, configStore, remoteName) || remoteName;
  }
  if (!keyName && canPrompt(program)) {
    keyName = await promptText("登録するキー名");
  }
  if (!keyName) die("keyname required: sesame ir learn <remote> <keyname>", 2);
  await withHub(program, async (hub, { opts }) => {
    console.error(`Hub3 を学習モードに切替中... (remote=${remoteName || "default"}, key="${keyName}")`);
    const result = await hub.learnIR(remoteName, keyName, {
      onPrompt: () => console.error("→ 物理リモコンを Hub3 に向けて、登録したいボタンを押してください..."),
    });
    out(opts.json, () => {
      console.log(`OK: learned "${keyName}"`);
      if (result.saved?.keyUUID) console.log(`   keyUUID: ${result.saved.keyUUID}`);
      if (result.captured?.irData) {
        const head = result.captured.irData.slice(0, 32);
        console.log(`   irData: ${head}... (len=${result.captured.irData.length})`);
      }
    }, { ok: true, key: keyName, ...result });
  });
}

async function cmdIRModeGet(hub3Name, _opts, program) {
  await withHub(program, async (hub, { opts }) => {
    const mode = await hub.getIRMode(hub3Name);
    out(opts.json, () => console.log(`mode: ${JSON.stringify(mode)}`), { mode });
  });
}

async function cmdIRModeSet(hub3Name, mode, _opts, program) {
  const m = Number(mode);
  if (![0, 1].includes(m)) die("mode must be 0 (CONTROL) or 1 (REGISTER)", 2);
  await withHub(program, async (hub, { opts }) => {
    await hub.setIRMode(hub3Name, m);
    out(opts.json, () => console.log(`OK: mode=${m} (${m === 0 ? "CONTROL" : "REGISTER"})`), { ok: true, mode: m });
  });
}

async function cmdIRKeyRm(remoteName, keyName, options, program) {
  const { configStore } = loadCtx(program);
  if (configStore.exists()) {
    remoteName = await pickRemoteName(program, configStore, remoteName) || remoteName;
    keyName = await pickRemoteKeyName(program, configStore, remoteName, keyName) || keyName;
  }
  if (!keyName) die("key required", 2);
  if (canPrompt(program)) {
    if (!(await confirmPrompt(`key "${keyName}" を削除しますか?`, { defaultYes: false }))) {
      return console.error("キャンセル");
    }
  } else if (!options?.yes) {
    die(`非対話モードでは確認 prompt が出せません。--yes で強制削除可能。`, 2);
  }
  await withHub(program, async (hub, { opts }) => {
    await hub.deleteIRKey(remoteName, keyName);
    out(opts.json, () => console.log(`OK: deleted key "${keyName}" from remote "${remoteName || "default"}"`),
      { ok: true });
  });
}

async function cmdIRKeyRename(remoteName, keyName, newName, _opts, program) {
  const { configStore } = loadCtx(program);
  if (configStore.exists()) {
    remoteName = await pickRemoteName(program, configStore, remoteName) || remoteName;
    keyName = await pickRemoteKeyName(program, configStore, remoteName, keyName) || keyName;
  }
  if (!keyName) die("key required", 2);
  if (!newName && canPrompt(program)) newName = await promptText(`新しい名前 (現: ${keyName})`);
  if (!newName) die("new name required: sesame ir key rename <remote> <key> <new>", 2);
  await withHub(program, async (hub, { opts }) => {
    await hub.renameIRKey(remoteName, keyName, newName);
    out(opts.json, () => console.log(`OK: renamed "${keyName}" → "${newName}"`), { ok: true });
  });
}

async function cmdIRRemoteListServer(type, _opts, program) {
  let t;
  try { t = parseIrType(type); } catch (e) { die(e.message, 2); }
  await withHub(program, async (hub, { opts }) => {
    const list = await hub.listIRRemotes(t);
    out(opts.json, () => {
      console.log(`Found ${list.length} remotes (type=${t}):`);
      for (const r of list) {
        console.log(`  ${r.alias || r.name || "(no name)"}\t${r.irDeviceUUID || r.uuid || ""}`);
      }
    }, { count: list.length, remotes: list });
  });
}

async function cmdIRRemoteSearch(type, term, _opts, program) {
  let t;
  try { t = parseIrType(type); } catch (e) { die(e.message, 2); }
  if (!term) die("search term required", 2);
  await withHub(program, async (hub, { opts }) => {
    const list = await hub.searchPresetIRRemotes(t, term);
    out(opts.json, () => {
      console.log(`Found ${list.length} preset remotes:`);
      for (const r of list) {
        console.log(`  ${r.brandName || r.name || "?"}\t${r.modelName || r.model || ""}\t${r.uuid || ""}`);
      }
    }, { count: list.length, results: list });
  });
}

async function cmdIRRemoteMatch(type, irData, _opts, program) {
  let t;
  try { t = parseIrType(type); } catch (e) { die(e.message, 2); }
  if (!irData) die("irData required (hex)", 2);
  await withHub(program, async (hub, { opts }) => {
    const matches = await hub.matchIRRemote({ irData, irType: t });
    out(opts.json, () => {
      console.log(`Found ${matches.length} matching remotes`);
      for (const m of matches) console.log(`  ${JSON.stringify(m)}`);
    }, { count: matches.length, matches });
  });
}

async function cmdIRRemoteRmServer(name, _opts, program) {
  await withHub(program, async (hub, { opts }) => {
    await hub.deleteIRRemoteServer(name);
    out(opts.json, () => console.log(`OK: deleted server-side remote "${name || "default"}"`),
      { ok: true });
  });
}

async function cmdIRRemoteRenameServer(name, alias, _opts, program) {
  if (!alias) die("alias required", 2);
  await withHub(program, async (hub, { opts }) => {
    await hub.renameIRRemote(name, alias);
    out(opts.json, () => console.log(`OK: renamed remote "${name || "default"}" → "${alias}"`),
      { ok: true });
  });
}

// ---------- コマンド: device management (Phase D) ----------

async function cmdDeviceUserLs(_opts, program) {
  await withHub(program, async (hub, { opts }) => {
    const list = await hub.listUserDevices();
    out(opts.json, () => {
      console.log(`Found ${list.length} user devices:\n`);
      for (const d of list) {
        console.log(`  ${d.deviceName || "(no name)"}\t${d.deviceModel || "?"}\t${d.deviceUUID || ""}`);
      }
    }, { count: list.length, devices: list });
  });
}

async function cmdDeviceStatus(uuid, _opts, program) {
  await withHub(program, async (hub, { opts }) => {
    uuid = await pickDeviceUUID(program, hub, uuid, { message: "どのデバイスの状態を見ますか?" }) || uuid;
    if (!uuid) die("deviceUUID required", 2);
    const status = await hub.getDeviceStatus(uuid);
    out(opts.json, () => console.log(JSON.stringify(status, null, 2)), { status });
  });
}

async function cmdDeviceRename(uuid, newName, _opts, program) {
  await withHub(program, async (hub, { opts }) => {
    uuid = await pickDeviceUUID(program, hub, uuid, { message: "どのデバイスを rename しますか?" }) || uuid;
    if (!uuid) die("deviceUUID required", 2);
    if (!newName && canPrompt(program)) newName = await promptText("新しいデバイス名");
    if (!newName) die("new name required: sesame device rename <uuid> <name>", 2);
    await hub.renameDevice(uuid, newName);
    out(opts.json, () => console.log(`OK: renamed ${uuid} → "${newName}"`), { ok: true });
  });
}

async function cmdDeviceRm(uuid, options, program) {
  await withHub(program, async (hub, { opts }) => {
    uuid = await pickDeviceUUID(program, hub, uuid, { message: "どのデバイスを削除しますか?" }) || uuid;
    if (!uuid) die("deviceUUID required", 2);
    if (canPrompt(program)) {
      if (!(await confirmPrompt(`デバイス ${uuid} を削除しますか?`, { defaultYes: false }))) {
        return console.error("キャンセル");
      }
    } else if (!options.yes) {
      die(`非対話モードでは確認 prompt が出せません。意図して削除する場合は --yes を付けてください。`, 2);
    }
    await hub.deleteDevice(uuid);
    out(opts.json, () => console.log(`OK: deleted device ${uuid}`), { ok: true });
  });
}

async function cmdHistory(deviceUUID, options, program) {
  await withHub(program, async (hub, { opts }) => {
    if (!deviceUUID && canPrompt(program)) {
      deviceUUID = await pickDeviceUUID(program, hub, null, { message: "どのデバイスの履歴?" });
    }
    const pageSize = options.pageSize ? Number(options.pageSize) : null;
    const list = deviceUUID ? [{ deviceUUID }] : [];
    const data = await hub.getDeviceHistory(list, pageSize);
    out(opts.json, () => console.log(JSON.stringify(data, null, 2)), { data });
  });
}

async function cmdBattery(deviceUUID, options, program) {
  await withHub(program, async (hub, { opts }) => {
    deviceUUID = await pickDeviceUUID(program, hub, deviceUUID, {
      message: "どのデバイスの電池履歴?",
      filter: (d) => /^(sesame_|wm_|ssmbot_|bot_|bike_)/.test(d.deviceModel || ""),
    }) || deviceUUID;
    if (!deviceUUID) die("deviceUUID required", 2);
    const pageSize = options.pageSize ? Number(options.pageSize) : 100;
    const data = await hub.getDeviceBattery(deviceUUID, { pageSize });
    out(opts.json, () => {
      const recs = data.records || [];
      console.log(`Battery records: ${recs.length}`);
      for (const r of recs) {
        const t = r.ts ? new Date(r.ts * 1000).toISOString() : "?";
        console.log(`  ${t}\tlight=${r.light}\theavy=${r.heavy}\tlight%=${r.lightPercentage}\theavy%=${r.heavyPercentage}`);
      }
      if (data.lastEvaluatedKey) console.log(`\n次ページ key: ${JSON.stringify(data.lastEvaluatedKey)}`);
    }, data);
  });
}

async function cmdFirmware(_opts, program) {
  await withHub(program, async (hub, { opts }) => {
    const list = await hub.listFirmware();
    out(opts.json, () => console.log(JSON.stringify(list, null, 2)), { firmwares: list });
  });
}

async function cmdWebapi(func, options, program) {
  if (!func) die("func required: sesame webapi <func> [--query json] [--body json] [--api-key ID]", 2);
  let query = {}, body = {};
  try {
    if (options.query) query = JSON.parse(options.query);
    if (options.body)  body  = JSON.parse(options.body);
  } catch (e) {
    die(`invalid JSON in --query/--body: ${e.message}`, 2);
  }
  await withHub(program, async (hub, { opts }) => {
    const data = await hub.invokeWebAPI({ func, query, body, apiKeyId: options.apiKey });
    out(opts.json, () => console.log(JSON.stringify(data, null, 2)), { data });
  });
}

// ---------- 既存の lock op ----------

// ---------- 統合ロック操作 (トップレベル動詞 unlock/lock/toggle/status/autolock/bot) ----------

/**
 * config からロック entry を解決する。
 * 優先: 位置引数/--name → default.lock → 単一なら自動 → 部分一致 → 対話選択。
 * @returns {{name:string, deviceUUID:string, secretKey:string}|null} die 済みなら null
 */
async function resolveLockEntry(program, name) {
  const { configStore } = loadCtx(program);
  if (!configStore.exists()) { die("config がありません。`sesame init` → `sesame locks sync-from-devices` を先に。", 2); return null; }
  const cfg = configStore.load();
  const locks = cfg.locks || {};
  const names = Object.keys(locks);
  if (names.length === 0) { die("ロックが未登録です。`sesame locks sync-from-devices` で取り込んでください。", 2); return null; }

  let chosen = null;
  if (name) {
    if (locks[name]) chosen = name; // 完全一致
    else {
      // 部分一致 (大文字小文字無視)
      const matches = names.filter((n) => n.toLowerCase().includes(String(name).toLowerCase()));
      if (matches.length === 1) chosen = matches[0];
      else if (matches.length > 1) { die(`"${name}" が複数に一致: ${matches.join(", ")}`, 2); return null; }
      else { die(`ロック "${name}" が見つかりません。候補: ${names.join(", ")}`, 2); return null; }
    }
  } else {
    chosen = cfg.default?.lock || (names.length === 1 ? names[0] : null);
    if (!chosen) {
      if (!canPrompt(program)) { die(`複数ロックがあります。名前を指定してください: ${names.join(", ")}`, 2); return null; }
      chosen = await selectFromList("どのロック?", names, (n) => `${n}\t${locks[n].deviceUUID}`);
      if (!chosen) { console.error("キャンセルしました。"); return null; }
    }
  }
  const lock = locks[chosen];
  if (!lock?.deviceUUID || !lock?.secretKey) { die(`lock "${chosen}" に deviceUUID/secretKey がありません (sesame locks sync-from-devices で取り込み直し)。`, 2); return null; }
  return { name: chosen, deviceUUID: lock.deviceUUID, secretKey: lock.secretKey, model: lock.model || null };
}

/**
 * 単発コマンドの経路を決定する。
 *   - 既定 (全部モード): 能力フル。経路はツールが自動選択する。BLE はスキャン/接続のオーバーヘッドが
 *     あるため毎回は張らず、cloud で運べる op は cloud、cloud で運べない op (autolock など BLE 必須)
 *     のみ BLE で一時接続する (cloud が速いという意味ではなく、BLE の接続コストを毎回払わないため)。
 *   - `--ble-only` / `--cloud-only`: 経路を固定したいときの明示指定 (最優先)。
 * 「BLE 接続を保持する」モードは `sesame session`。運べる経路はデバイス型×op の能力から導出する。
 * @returns {"cloud"|"ble"}
 */
function pickTransport(op, options, model) {
  if (options.cloudOnly && options.bleOnly) { die("--cloud-only と --ble-only は同時指定できません。", 2); }
  const allowed = transportsForOp(model, op);
  if (allowed.length === 0) { die(`${op} に利用できる経路がありません (この型では非対応)。`, 2); }
  if (options.bleOnly) {
    if (!allowed.includes("ble")) { die(`${op} は BLE では送れません。`, 2); }
    return "ble";
  }
  if (options.cloudOnly) {
    if (!allowed.includes("cloud")) { die(`${op} はクラウドでは実機に反映されません (BLE 必須)。--ble-only か無指定で。`, 2); }
    return "cloud";
  }
  // 全部モード: cloud で運べるなら cloud (BLE の接続コストを避けるため)。cloud 不可な op (autolock) のみ BLE。
  return allowed.includes("cloud") ? "cloud" : "ble";
}

/** auto フォールバック先の cloud が使えるか (token があるか)。 */
function hasCloudSession(program) {
  const { tokenStore } = loadCtx(program);
  const t = tokenStore.load();
  return !!(t && (t.refreshToken || t.idToken));
}

/** mechStatus を 1 行に整形。 */
function fmtMech(s) {
  if (!s) return "(status 未取得)";
  const warn = [s.isBatteryCritical && "⚠電池残少", s.isStop && "停止", s.isCritical && "異常"].filter(Boolean).join(" ");
  // position はロック (Sesame5/6) のみ。Bot/Bike は概念がないので state だけ表示する。
  const pos = s.position == null ? "" : ` pos=${s.position}`;
  return `state=${s.state}${pos}${warn ? " " + warn : ""}`;
}

/** config の全ロック entry (deviceUUID/secretKey が揃っているもの) を返す。 */
function allLockEntries(program) {
  const { configStore } = loadCtx(program);
  if (!configStore.exists()) { die("config がありません。`sesame init` → `sesame locks sync-from-devices` を先に。", 2); return []; }
  const locks = configStore.load().locks || {};
  return Object.entries(locks)
    .filter(([, l]) => l?.deviceUUID && l?.secretKey)
    .map(([name, l]) => ({ name, deviceUUID: l.deviceUUID, secretKey: l.secretKey, model: l.model || null }));
}

/**
 * config の全 Hub3 entry を返す ({name, deviceId, model, secretKey})。
 * secretKey/model は devices レコード丸ごと保存により config に揃っているので、ここで返す
 * (relay/LED は secretKey 必須。旧実装の「session 開始時に listDevices で再取得」する band-aid は廃止)。
 */
function allHub3Entries(program) {
  const { configStore } = loadCtx(program);
  if (!configStore.exists()) return [];
  const hub3s = configStore.load().hub3s || {};
  return Object.entries(hub3s)
    .filter(([, h]) => h?.deviceId)
    .map(([name, h]) => ({ name, deviceId: h.deviceId, model: h.model || "hub_3", secretKey: h.secretKey || null }));
}

/** 指定 Hub3 名に属する remote の一覧 ({name, label}) を返す (IR 送信のリモコン選択用)。 */
function remotesForHub3(program, hub3Name) {
  const { configStore } = loadCtx(program);
  if (!configStore.exists()) return [];
  const remotes = configStore.load().remotes || {};
  return Object.entries(remotes)
    .filter(([, r]) => r?.hub3 === hub3Name)
    .map(([name, r]) => ({ name, label: r.alias ? `${name} (${r.alias})` : name }));
}

/** 名前 (部分一致・大文字小文字無視) で entry を1つ選ぶ。曖昧/不在は null + reason。 */
function matchLockName(input, entries) {
  if (!input) return { entry: null, reason: "name required" };
  const exact = entries.find((e) => e.name === input);
  if (exact) return { entry: exact };
  const m = entries.filter((e) => e.name.toLowerCase().includes(String(input).toLowerCase()));
  if (m.length === 1) return { entry: m[0] };
  if (m.length > 1) return { entry: null, reason: `"${input}" が複数に一致: ${m.map((e) => e.name).join(", ")}` };
  return { entry: null, reason: `"${input}" に一致するロックなし` };
}

/**
 * 統合ハンドラ。op: unlock|lock|toggle|status|autolock|bot。
 * @param {string} op
 * @param {string|undefined} name 位置引数のロック名
 * @param {string|null} seconds autolock 用
 * @param {object} options commander options (--ble-only/--cloud-only/--name)
 * @param {object} program
 */
/** BLE 経由で 1 操作を実行。scanTimeoutMs を指定すると圏外時に早めに失敗 (auto の高速フォールバック用)。 */
/** 接続済みの SesameBle に対して 1 操作を実行 (接続/切断は呼び出し側責務)。 */
/**
 * 接続済み SesameBle に op を実行する**唯一のコア**。単発コマンド・セッションの両方がここを通る
 * (session は保持中の接続を、単発は都度張った接続を渡す。「保持接続があればそれで操作する」という
 * セッションモードの挙動が、両方の既定動作になる)。能力ゲートは SesameBle 側が担保。表示はしない。
 * @returns {{result:any, status:object|null}}
 */
async function bleExec(op, ble, seconds) {
  let result = null;
  if (op === "autolock") result = await ble.autolock(Number(seconds));
  else if (op !== "status") result = await ble[op](); // lock/unlock/toggle/click (履歴タグ無し = SDK null-tag [00 0E])
  const status = await ble.status().catch(() => null);
  return { result, status };
}

/** 接続済みの SesameBle に対して 1 操作を実行し、単発コマンド向けに表示する (接続/切断は呼び出し側責務)。 */
async function runBleOnLock(op, lock, entry, seconds, gopts) {
  const { result, status } = await bleExec(op, lock, seconds);
  out(gopts.json, () => {
    if (op === "status") { console.log(`${entry.name}: ${fmtMech(status)}`); return; }
    console.log(`OK: ${op}${op === "autolock" ? ` ${Number(seconds) === 0 ? "無効化" : Number(seconds) + "秒"}` : ""} (${entry.name})`);
    if (status) console.log(`   ${fmtMech(status)}`);
  }, { ok: true, op, name: entry.name, via: "ble", result, status });
}

/** BLE で 1 操作 (connect→op→close)。--ble-only 明示 or BLE 必須 op (autolock) 用。 */
async function runBleOp(op, entry, seconds, gopts, { scanTimeoutMs } = {}) {
  await SesameBle.use(
    { secretKey: entry.secretKey, deviceUUID: entry.deviceUUID, model: entry.model, debug: !!gopts.debug, scanTimeoutMs },
    (lock) => runBleOnLock(op, lock, entry, seconds, gopts),
  );
}

/** クラウド経由で 1 操作を実行。 */
async function runCloudOp(op, entry, program) {
  await withHub(program, async (hub, { opts }) => {
    if (op === "status") {
      const st = await hub.getDeviceStatus(entry.deviceUUID);
      out(opts.json, () => console.log(`${entry.name}: ${JSON.stringify(st)}`), { ok: true, op, name: entry.name, via: "cloud", status: st });
      return;
    }
    // click (Bot の BLE クリック) は cloud では botClick(cmd=89) に対応。
    const resp = (op === "bot" || op === "click") ? await hub.botClick(entry.name) : await hub[op](entry.name); // lock/unlock/toggle
    out(opts.json, () => {
      console.log(`OK: ${op} (${entry.name})`);
      if (resp?.data && Object.keys(resp.data).length) console.log(`   ${JSON.stringify(resp.data)}`);
    }, { ok: true, op, name: entry.name, via: "cloud", response: resp });
  });
}

// セッション UI で使う操作ラベル (ロック系 + Hub3 系)。
const SESSION_LABEL = {
  unlock: "🔓 解錠", lock: "🔒 施錠", toggle: "↕ トグル", click: "👆 クリック", status: "ℹ 状態", autolock: "⏱ オートロック",
  ir: "📡 IR 送信", "relay-on": "🔌 リレー ON", "relay-off": "🔌 リレー OFF", led: "💡 LED 調光",
};

/* exported for tests */
/**
 * デバイス型 × 利用可能な経路の **和集合** で操作一覧を作る。
 * その op を運べる経路が今使えるときだけ出す: BLE 接続中なら ble 能力、ログイン済みなら cloud 能力。
 * (例: ロックは BLE 接続中のみ autolock を出す。OS2 ロックは cloud の lock/unlock/toggle のみ。)
 * @param {{kind:string, entry:object, ble:object|null}} d
 * @param {boolean} hasCloud クラウド経路が使えるか
 */
function sessionActionsFor(d, hasCloud) {
  const caps = capabilitiesForModel(d.entry.model);
  // 今使える経路で運べる op の集合。
  const avail = new Set();
  if (d.ble) for (const o of caps.ble) avail.add(o);
  if (hasCloud) for (const o of caps.cloud) avail.add(o);

  // 提示順: lock5 は現在状態から自然な順、それ以外は能力順。
  let ordered;
  if (caps.kind === "lock5") {
    const primary = d.ble?.lastStatus?.state === "locked" ? "unlock" : "lock";
    ordered = [primary, ...["unlock", "lock", "toggle", "autolock"].filter((o) => o !== primary)];
  } else {
    ordered = caps.ops; // bot2:[click] / bike2:[unlock] / hub3:[ir,relay,led] / os2lock:[lock,unlock,toggle] 等
  }

  const acts = [];
  for (const o of ordered.filter((o) => avail.has(o))) {
    if (o === "relay") { // Hub3 のリレーは ON/OFF の 2 項目に展開。
      acts.push({ label: SESSION_LABEL["relay-on"], value: "relay-on" }, { label: SESSION_LABEL["relay-off"], value: "relay-off" });
    } else {
      acts.push({ label: SESSION_LABEL[o], value: o });
    }
  }
  if (caps.mechKind && d.ble) acts.push({ label: SESSION_LABEL.status, value: "status" }); // mech がある型は BLE 接続中のみ状態取得
  return acts;
}

/** ヘッダの状態表示。BLE 接続済みは実 mechStatus、Hub3/未接続は注記 (クラウド状態は形が不定で正規化しない)。 */
function sessionFmtState(d) {
  if (d.kind === "hub3") return "(Hub3: IR / リレー / LED)";
  return d.ble ? fmtMech(d.ble.lastStatus) : "(BLE未接続)";
}

/**
 * 1 操作を実行し結果メッセージを返す。
 *   ロック: BLE 接続済みなら BLE、無ければクラウド (autolock は BLE 必須)。
 *   Hub3 : IR 送信 (extra={remote,key}) / リレー ON/OFF / LED (extra=duty)。いずれもクラウド。
 * @param {object|null} hub クラウドクライアント (未ログイン時 null)
 */
function makeSessionExec(hub) {
  return async (op, d, extra) => {
    if (d.kind === "hub3") {
      if (!hub) return "Hub3 操作にはログインが必要です。";
      if (op === "ir") { await hub.send(extra.remote, extra.key); return `OK: IR 送信 ${extra.remote}/${extra.key} (${d.entry.name})`; }
      if (op === "relay-on" || op === "relay-off") {
        if (!d.entry.secretKey) return "Hub3 の secretKey が取得できていません (`sesame devices` で再取得)。";
        await hub.iot.hub3RelaySwitch({ deviceId: d.entry.deviceId, secretKey: d.entry.secretKey, op: op === "relay-on" ? 0x01 : 0x00 });
        return `OK: リレー ${op === "relay-on" ? "ON" : "OFF"} (${d.entry.name}) [応答なし]`;
      }
      if (op === "led") {
        if (!d.entry.secretKey) return "Hub3 の secretKey が取得できていません (`sesame devices` で再取得)。";
        const r = await hub.iot.setHub3LedDuty({ deviceId: d.entry.deviceId, secretKey: d.entry.secretKey, op: 0x01, duty: Number(extra) });
        return `OK: LED duty=${Number(extra)} (${d.entry.name})${r?.ledDuty != null ? ` → ${r.ledDuty}` : ""}`;
      }
      return `未対応の操作: ${op}`;
    }
    // ロック系
    if (d.ble) {
      const { status } = await bleExec(op, d.ble, extra);
      return op === "status" ? `${d.entry.name}: ${fmtMech(status)}` : `OK: ${SESSION_LABEL[op]} (${d.entry.name})`;
    }
    if (op === "autolock") return "autolock は BLE 必須です (デバイスに近づいて再試行してください)。";
    if (op === "status") return `${d.entry.name}: (クラウド接続中・状態詳細は BLE 接続時のみ)`;
    if (!hub) return "この操作には BLE 圏内かログインが必要です。";
    if (op === "click") await hub.botClick(d.entry.name);
    else await hub[op](d.entry.name); // lock/unlock/toggle
    return `OK: ${SESSION_LABEL[op]} (${d.entry.name}) [cloud]`;
  };
}

/**
 * 対象ロックへ BLE 接続を張ったまま保持し、runSessionMenu でメニュー操作させる。
 * 接続を維持するので 1 操作ごとの再スキャン/再接続が起きない。
 *
 * @param {string[]} names 対象ロック名 (部分一致可)。空なら config の全ロック。
 */
async function cmdSession(names, options, program) {
  const gopts = program.opts();
  if (gopts.json) { die("session は対話モード専用です (--json 不可)。", 2); return; }
  if (!isInteractive()) { die("session は TTY 専用です。単発操作は `sesame unlock <name>` (必要なら --ble-only) を使ってください。", 2); return; }

  const loggedIn = hasCloudSession(program);

  // 操作できるデバイス全部を対象にする: ロック/Bot/Bike (BLE+cloud) と、ログイン済みなら Hub3 (cloud)。
  // model/secretKey は config の devices レコードに揃っているので entry がそのまま能力解決に使える。
  const locks = allLockEntries(program).map((e) => ({ ...e, kind: "lock" }));
  const hub3s = loggedIn ? allHub3Entries(program).map((e) => ({ ...e, kind: "hub3" })) : [];
  const allDevs = [...locks, ...hub3s];
  if (allDevs.length === 0) { die("操作できるデバイスがありません。`sesame locks sync-from-devices` / `sesame hub3 sync-from-devices` で取り込んでください。", 2); return; }

  // 対象を決定: 名前指定があれば部分一致で絞る、無ければ全デバイス。
  let targets;
  if (Array.isArray(names) && names.length > 0) {
    targets = [];
    for (const n of names) {
      const matches = allDevs.filter((e) => e.name.toLowerCase().includes(String(n).toLowerCase()));
      if (matches.length === 0) { die(`デバイス "${n}" が見つかりません。候補: ${allDevs.map((e) => e.name).join(", ")}`, 2); return; }
      for (const m of matches) if (!targets.some((t) => t.name === m.name)) targets.push(m);
    }
  } else {
    targets = allDevs;
  }

  const lockTargets = targets.filter((t) => t.kind === "lock");

  /** @type {Map<string, {kind:string, entry:object, ble:(import("./ble/index.js").SesameBle|null)}>} */
  const devices = new Map();
  for (const t of targets) devices.set(t.name, { kind: t.kind, entry: t, ble: null });

  // UI のライブ再描画トリガ。BLE の mechStatus publish / 背景接続の完了で "update" を流す。
  const bus = new EventEmitter();
  bus.setMaxListeners(0);

  // BLE を張って devices[].ble に反映する (ロックのみ・best-effort・非致命)。繋がった台数を返す。
  const connectBle = async () => {
    if (lockTargets.length === 0) return 0;
    try {
      const result = await SesameBle.connectMany(lockTargets, { debug: !!gopts.debug, scanTimeoutMs: 8_000 });
      for (const [name, ble] of result.connected) {
        const d = devices.get(name);
        if (d) { d.ble = ble; ble.onStatus(() => bus.emit("update")); } // 以降 BLE 優先・状態変化で再描画
      }
      bus.emit("update"); // 接続が増えたら ·BLE に昇格させるため再描画
      return result.connected.size;
    } catch (e) {
      if (gopts.debug) console.error(`[ble] 接続失敗: ${e?.message || e}`);
      return 0;
    }
  };

  let blePromise = null;
  if (loggedIn) {
    // 全部モードのアプリ的挙動: クラウドでメニューを即表示し、BLE は **バックグラウンド** で接続する
    // (繋がったデバイスは次の描画で ·BLE に昇格し、以降 BLE 優先)。起動を BLE スキャンで待たせない。
    if (lockTargets.length) console.error("[ble] バックグラウンドで接続中... (クラウドで操作可能)");
    blePromise = connectBle();
  } else {
    // 未ログイン: クラウドの下支えが無いので BLE を待つしかない。0 なら die。
    console.error(`[ble] スキャン中... (${lockTargets.map((t) => t.name).join(", ")})`);
    if ((await connectBle()) === 0) {
      die("BLE 圏内のデバイスが無く、クラウドも未ログインです。デバイスに近づくか `sesame login <email>` → `sesame verify` してください。", 1);
      return;
    }
  }

  const { runSessionUI } = await import("./session-ui.js"); // ink/react を遅延ロード
  const runner = async (hub) => {
    // Hub3 の relay/LED 用 secretKey は config の devices レコードに保存済み (sync 時に取り込み)。
    // 旧実装の「session 開始時に listDevices で再取得」する band-aid は不要 (entry.secretKey をそのまま使う。
    // 欠落していれば relay/LED の exec が `sesame devices で再取得` を案内する)。
    try {
      await runSessionUI({
        devices,
        hasCloud: !!hub,
        bus,
        exec: makeSessionExec(hub),
        actionsFor: (d) => sessionActionsFor(d, !!hub),
        fmtState: sessionFmtState,
        hub3RemotesFor: (d) => remotesForHub3(program, d.entry.name).map((r) => ({ label: r.label, value: r.name })),
        listKeysFor: async (remoteName) => (await hub.listKeys(remoteName)).map((k) => ({ label: k.name, value: k.name })),
      });
    } finally {
      if (blePromise) await blePromise.catch(() => {}); // 背景接続の完了を待ってから閉じる
      for (const d of devices.values()) if (d.ble) await d.ble.close().catch(() => {});
      console.error("切断しました。");
    }
  };

  if (loggedIn) await withHub(program, (hub) => runner(hub));
  else await runner(null);
}

/** デバイスに対して可能な操作 (動詞)。型ごとの可否は能力モデルが別途ゲートする。 */
const DEVICE_ACTIONS = new Set(["unlock", "lock", "toggle", "click", "status", "autolock"]);

/**
 * デバイス主語の実行: `sesame <device> [action] [args]`。
 *   - action 省略 + TTY → そのデバイス (複数可) の対話セッション。
 *   - action 省略 + 非対話 → status を表示。
 *   - action 指定 → 1 発実行 (cmdAct に委譲。経路は全部モードで自動)。
 */
async function cmdDeviceOp(device, action, args, options, program) {
  if (!action) {
    if (isInteractive() && !program.opts().json) { await cmdSession(device ? [device] : [], options, program); return; }
    action = "status"; // 非対話の既定は状態表示
  }
  if (!DEVICE_ACTIONS.has(action)) {
    die(`不明な操作 "${action}"。使えるのは: ${[...DEVICE_ACTIONS].join(" / ")} (例: sesame ${device || "<device>"} unlock)`, 2);
    return;
  }
  const seconds = action === "autolock" ? (args && args[0]) : null;
  if (action === "autolock" && (seconds == null)) {
    die("autolock には秒数が必要です (例: sesame front autolock 30、0=無効)。", 2);
    return;
  }
  await cmdAct(action, device, seconds, options, program);
}

async function cmdAct(op, name, seconds, options, program) {
  const entry = await resolveLockEntry(program, name || options.name);
  if (!entry) return; // die 済み
  const transport = pickTransport(op, options, entry.model);
  const gopts = program.opts();
  const extra = op === "autolock" ? ` ${seconds}s` : "";

  // デバイス型ごとの能力ゲート (SDK 準拠)。model が判っていて非対応な操作は接続前に弾く。
  // 例: Bot に lock/unlock → "click を使え"、Lock に click → "toggle を使え"。
  const BLE_OPS = new Set(["lock", "unlock", "toggle", "autolock", "click"]);
  if (BLE_OPS.has(op) && entry.model) {
    const caps = capabilitiesForModel(entry.model);
    if (!caps.ops.includes(op)) {
      die(`${caps.label} (${entry.model}) は ${op} に対応していません。可能な操作: ${caps.ops.join("/") || "なし"}`, 2);
      return;
    }
  }

  // autolock の引数検証は接続前に。
  if (op === "autolock") {
    const sec = Number(seconds);
    if (!Number.isInteger(sec) || sec < 0 || sec > 65535) { die("seconds は 0..65535 の整数 (0=無効)。", 2); return; }
  }

  if (transport === "ble") {
    // BLE 一時接続 (--ble-only 明示、または autolock のような cloud 不可な op)。
    if (!gopts.json) console.error(`[ble] ${op}${extra} → ${entry.name}`);
    try {
      await runBleOp(op, entry, seconds, gopts);
    } catch (e) {
      if (maybeHandleBleError(e)) return; // 権限/電源/未導入は設定誘導
      throw e;
    }
    return;
  }
  // transport === "cloud"
  if (!hasCloudSession(program)) {
    die("クラウド未ログインです。`sesame login <email>` → `sesame verify` でログインするか、BLE で操作する場合は `--ble-only` か `sesame session` を使ってください。", 2);
    return;
  }
  if (!gopts.json) console.error(`[cloud] ${op}${extra} → ${entry.name}`);
  await runCloudOp(op, entry, program);
}

// ---------- コマンド: migrate ----------

async function cmdMigrate(srcDir, _opts, program) {
  const { opts, paths, configStore, tokenStore } = loadCtx(program);
  const src = resolve(srcDir || process.cwd());
  mkdirSync(paths.dir, { recursive: true });

  const summary = { configDir: paths.dir, imported: [] };

  // 1. tokens
  const oldTokens = resolve(src, ".tokens.json");
  if (existsSync(oldTokens)) {
    copyFileSync(oldTokens, paths.tokens);
    summary.imported.push("tokens.json");
  }
  const oldPending = resolve(src, ".login_state.json");
  if (existsSync(oldPending)) {
    copyFileSync(oldPending, paths.loginState);
    summary.imported.push("login_state.json");
  }

  // 2. config: .env + keys.json を統合
  const cfg = configStore.load(); // 既存 or 空
  const envPath = resolve(src, ".env");
  let envVars = {};
  if (existsSync(envPath)) {
    envVars = parseDotenv(readFileSync(envPath, "utf8"));
    summary.imported.push(".env");
  }
  const keysPath = resolve(src, "keys.json");
  let keysFile = null;
  if (existsSync(keysPath)) {
    keysFile = JSON.parse(readFileSync(keysPath, "utf8"));
    summary.imported.push("keys.json");
  }

  if (envVars.COMPANY_ID)   cfg.companyID = envVars.COMPANY_ID;
  if (envVars.WS_URL)       cfg.wsUrl     = envVars.WS_URL;
  if (envVars.LANG)         cfg.lang      = envVars.LANG;

  // hub3/remote は派生 view (cfg.hub3s) を直接いじらず、devices/remotes へ書く store API 経由で登録する
  // (view は save() の _reproject で再生成されるため、直接代入しても保存されず消える)。
  if (envVars.HUB3_DEVICE_ID) {
    const hub3Name = "default";
    configStore.addHub3(hub3Name, { deviceId: envVars.HUB3_DEVICE_ID, name: hub3Name });
    summary.hub3Added = hub3Name;
  }

  if (envVars.IR_DEVICE_UUID && Object.keys(cfg.hub3s).length) {
    const hub3Name = Object.keys(cfg.hub3s)[0];
    const remoteName = keysFile?.alias || "default";
    configStore.addRemote(remoteName, {
      hub3: hub3Name,
      irDeviceUUID: envVars.IR_DEVICE_UUID,
      irType: Number(envVars.IR_TYPE) || DEFAULT_IR_TYPE,
      irOperation: envVars.IR_OPERATION || "learnEmit",
      alias: keysFile?.alias || null,
      keys: keysFile?.keys || {},
    });
    summary.remoteAdded = remoteName;
  }

  configStore.save(); // companyID/wsUrl/lang 等の直接設定分を確定 (hub3/remote は上で保存済み)

  out(opts.json, () => {
    console.log(`OK: migrated to ${paths.dir}`);
    console.log(`Imported: ${summary.imported.join(", ") || "(none)"}`);
    if (summary.hub3Added)   console.log(`  hub3:   ${summary.hub3Added}`);
    if (summary.remoteAdded) console.log(`  remote: ${summary.remoteAdded} (default)`);
    console.log(`\n旧ファイル (.env / .tokens.json / keys.json / .login_state.json) は不要なら削除して構いません。`);
  }, summary);
}

function parseDotenv(content) {
  const out = {};
  for (const line of content.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const m = s.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[m[1]] = val;
  }
  return out;
}

// ---------- run ----------

export async function run(argv = process.argv) {
  CLI_JSON = argv.includes("--json"); // die()/エラー経路用にグローバル --json を先に確定
  const program = new Command();
  program
    .name("sesame")
    .description("SESAME cloud CLI: lock control + Hub3 IR + device management (port of biz3 React with Consumer Cognito client)")
    .version(getPkgVersion(), "-V, --version")
    // 引数不足/未知オプション時に usage を出す (commander 既定はエラー1行のみで不親切)。
    // この前に設定すると後で追加する全サブコマンドへ継承される。--json 時は writeErr 側で抑止。
    .showHelpAfterError()
    .showSuggestionAfterError()
    .option("--config-dir <path>", "設定ディレクトリ上書き (default: ~/.config/sesame-hub3)")
    .option("--debug", "詳細ログ")
    .option("--json", "JSON 出力");

  program.addHelpText("before", `
デバイス主語で操作します (device.action() と同じ並び):
  sesame <device> <action>   1 発実行   例: sesame front unlock / sesame kitchen click / sesame front autolock 30
  sesame <device>            そのデバイスの対話メニュー
  sesame                     全デバイスの対話メニュー (session)
action: unlock / lock / toggle / click / status / autolock <秒>  (使える操作は型で変わる)
経路は既定で自動。固定は --ble-only / --cloud-only。
下記は管理コマンド (login やデバイス管理・IR 等)。
`);

  program.command("login <email>").description("sign-in 開始 (email にコード送信)")
    .action((email, opts) => cmdLogin(email, opts, program));
  program.command("verify [code]").description("sign-in 完了 (省略時は対話入力)")
    .action((code, opts) => cmdVerify(code, opts, program));
  program.command("refresh").description("強制 token 更新")
    .action((opts) => cmdRefresh(opts, program));
  program.command("whoami").description("ログインユーザ情報 (biz3GetLoginUser) を取得し companyID を config に保存")
    .action((opts) => cmdWhoami(opts, program));

  program.command("send [key]").description("IR 発射 (key は名前 or keyUUID, 省略時は対話選択)")
    .option("--remote <name>", "リモコン名 (省略時はデフォルト)")
    .action((key, opts) => cmdSend(key, opts, program));
  program.command("list").description("リモコン登録キー一覧 (getIRCodes)")
    .option("--remote <name>", "リモコン名 (省略時はデフォルト)")
    .action((opts) => cmdList(opts, program));
  program.command("ping").description("WS 接続確認")
    .action((opts) => cmdPing(opts, program));
  program.command("devices").description("全 SESAME デバイス情報 (secretKey 含む dump)")
    .action((opts) => cmdDevices(opts, program));

  program.command("init").description("設定ディレクトリと config.json スケルトンを作成")
    .action((opts) => cmdInit(opts, program));
  program.command("setup").description("認証後の自動セットアップを再実行 (companyID / ロック / Hub3 IR をデバイスから取り込み)")
    .action((opts) => cmdSetup(opts, program));
  program.command("migrate [srcDir]").description("旧 .env / .tokens.json / keys.json を取り込み")
    .action((srcDir, opts) => cmdMigrate(srcDir, opts, program));

  // サブコマンド省略時は show 相当を出す (引数なしで exit 1 にならないように)
  const config = program.command("config").description("設定の参照 (省略時は show)")
    .action((opts) => cmdConfigShow(opts, program));
  config.command("path").description("設定ディレクトリのパスを出力")
    .action((opts) => cmdConfigPath(opts, program));
  config.command("show").description("config.json / tokens.json (masked) を出力")
    .action((opts) => cmdConfigShow(opts, program));

  const remote = program.command("remote").description("リモコン定義の編集");
  remote.command("ls").description("設定済みリモコン一覧")
    .action((opts) => cmdRemoteLs(opts, program));
  remote.command("add").description("リモコンを一覧から選んで 1 つ追加 (UUID/irType 手打ち不要)")
    .addHelpText("after", `
devices だけで完結します (手入力は呼び名のみ):
  - 各 Hub3 配下の登録済みリモコンを一覧表示し選択 (irType も自動)
  - 追加後に自動で sync-keys (キー一覧を取り込み)
全リモコンを一括で取り込むなら \`sesame remote sync-from-devices\` の方が速い。`)
    .action((opts) => cmdRemoteAdd(opts, program));
  remote.command("set-default <name>").description("デフォルトリモコン設定")
    .action((name, opts) => cmdRemoteSetDefault(name, opts, program));
  remote.command("sync-keys [name]").description("getIRCodes で取得したキーを config.json に書き戻し")
    .action((name, opts) => cmdRemoteSyncKeys(name, opts, program));
  remote.command("sync-from-devices")
    .description("devices からリモコンを全件自動取り込み (Hub3 と irType を自動判定、引数不要)")
    .action((opts) => cmdRemoteSyncFromDevices(opts, program));

  const hub3 = program.command("hub3").description("Hub3 定義の編集");
  hub3.command("ls").description("設定済み Hub3 一覧")
    .action((opts) => cmdHub3Ls(opts, program));
  hub3.command("add").description("devices から Hub3 を選んで追加 (UUID 手打ち不要)")
    .action((opts) => cmdHub3Add(opts, program));
  hub3.command("sync-from-devices").description("devices から Hub3 を全件自動取り込み")
    .option("--prune", "server に無い Hub3 を config から除去 (参照中の remote があるものは残す)")
    .action((opts) => cmdHub3SyncFromDevices(opts, program));

  // ロック定義の管理 (グループ名は locks。操作は下のトップレベル動詞)
  const locks = program.command("locks").description("ロック定義の管理 (一覧/追加/削除/デフォルト/取込)");
  locks.command("ls").description("設定済みロック一覧")
    .action((opts) => cmdLockLs(opts, program));
  locks.command("add").description("ロック追加 (対話、またはフラグで非対話)")
    .option("--name <name>", "ロックの呼び名 (例: front)")
    .option("--uuid <uuid>", "ロックの deviceUUID (devices の出力にある)")
    .option("--secret <hex>", "32hex 共通鍵 (devices の出力にある)")
    .option("--model <model>", "例 sesame_5 / sesame_5_pro / sesame_6 / wm_2")
    .option("--alias <alias>", "表示名 (任意)")
    .addHelpText("after", `
フラグ未指定なら対話で聞く。--json/非対話では --name/--uuid/--secret が必須。
通常は \`sesame locks sync-from-devices\` で自動取り込みが楽。
例: sesame locks add --name front --uuid <UUID> --secret <32hex> --model sesame_5_pro`)
    .action((opts) => cmdLockAdd(opts, program));
  locks.command("rm <name>").description("ロック定義削除 (--yes で非対話強制削除)")
    .option("--yes", "確認 prompt をスキップ (非対話モード必須)")
    .action((name, opts) => cmdLockRm(name, opts, program));
  locks.command("set-default <name>").description("デフォルトロック設定")
    .action((name, opts) => cmdLockSetDefault(name, opts, program));
  locks.command("sync-from-devices").description("devices からロックを config に取り込み (追加 + secretKey 更新)")
    .option("--prune", "server に無いロックを config から除去")
    .action((opts) => cmdLockSyncFromDevices(opts, program));

  // ---------- デバイス主語の実行 (sesame <device> [action]) ----------
  // 主語はデバイス。`sesame front unlock` = front.unlock() 相当 (SDK の device.method() と同じ)。
  // action 省略は対話メニュー (= そのデバイスの session)。引数なし `sesame` は全デバイスの session。
  // 経路は既定「全部モード」(能力フル・自動。BLE 必須 op のみ BLE)。固定は --ble-only / --cloud-only。
  // 例: sesame front unlock / sesame kitchen click / sesame front autolock 30 / sesame front --ble-only
  //
  // 実体は隠し op コマンド。先頭トークンが既知コマンドでなければ run() がここへ振り分ける。
  program.command("op [device] [action] [args...]", { hidden: true })
    .option("--ble-only", "BLE 経路に固定 (近接 + Bluetooth 権限。接続に数秒)")
    .option("--cloud-only", "クラウド経路に固定 (要 login。一部操作は制限)")
    .action((device, action, args, opts) => cmdDeviceOp(device, action, args, opts, program));

  program.command("session [names...]").alias("watch")
    .description("複数デバイスに BLE 接続を保持して対話操作 (sesame <device> の複数版)")
    .addHelpText("after", `
名前を省略すると全デバイスに、指定するとそれらに接続する。
接続後は矢印キーのメニューでデバイスと操作を選ぶ (操作は型で変わる)。
例: sesame session            # 全デバイス
    sesame session front 裏口  # 指定デバイスだけ`)
    .action((names, opts) => cmdSession(names, opts, program));

  // ---------- IR advanced (Phase C) ----------
  const irCmd = program.command("ir").description("Hub3 IR の高度な操作 (学習 / モード / 検索 / プリセット照合)");
  irCmd.command("learn [remote] [keyname]")
    .description("物理リモコンの 1 ボタンを学習して remote にキー登録 (引数省略で対話選択)")
    .action((remote, keyName, opts) => cmdIRLearn(remote, keyName, opts, program));
  const irMode = irCmd.command("mode").description("Hub3 の IR モード制御 (0=CONTROL / 1=REGISTER)");
  irMode.command("get [hub3]").description("現在のモード取得")
    .action((hub3, opts) => cmdIRModeGet(hub3, opts, program));
  irMode.command("set <mode> [hub3]").description("モード設定 (0 or 1)")
    .action((mode, hub3, opts) => cmdIRModeSet(hub3, mode, opts, program));
  const irKey = irCmd.command("key").description("キー (ボタン) CRUD");
  irKey.command("rm [remote] [key]").description("キー削除 (引数省略で対話選択、--yes で非対話強制)")
    .option("--yes", "確認 prompt をスキップ (非対話モード必須)")
    .action((remote, key, opts) => cmdIRKeyRm(remote, key, opts, program));
  irKey.command("rename [remote] [key] [new]").description("キー名変更 (引数省略で対話)")
    .action((remote, key, n, opts) => cmdIRKeyRename(remote, key, n, opts, program));
  irCmd.command("remote-list <irType>").description("server 側の登録リモコン一覧 (irType: 整数コード, 例 49152=エアコン)")
    .action((type, opts) => cmdIRRemoteListServer(type, opts, program));
  irCmd.command("search <irType> <term>").description("プリセットリモコン (メーカー DB) 検索 (irType: 例 49152=エアコン)")
    .action((type, term, opts) => cmdIRRemoteSearch(type, term, opts, program));
  irCmd.command("match <irType> <irData>").description("学習波形 (hex) からプリセット照合 (irType: 整数コード)")
    .action((type, irData, opts) => cmdIRRemoteMatch(type, irData, opts, program));
  irCmd.command("remote-rm [name]").description("server 側からリモコン削除 (config の remote は残る)")
    .action((name, opts) => cmdIRRemoteRmServer(name, opts, program));
  irCmd.command("remote-rename <alias> [name]").description("server 側でリモコンの alias 変更")
    .action((alias, name, opts) => cmdIRRemoteRenameServer(name, alias, opts, program));

  // ---------- device management (Phase D) ----------
  const devCmd = program.command("device").description("デバイス管理 (個人/会社 + 名前変更/削除)");
  devCmd.command("user-ls").description("個人ユーザのデバイス一覧 (getUserDevice)")
    .action((opts) => cmdDeviceUserLs(opts, program));
  devCmd.command("status [uuid]").description("単機の現在状態 (lock state, battery 等)")
    .action((uuid, opts) => cmdDeviceStatus(uuid, opts, program));
  devCmd.command("rename [uuid] [name]").description("デバイス名変更 (引数省略で対話)")
    .action((uuid, name, opts) => cmdDeviceRename(uuid, name, opts, program));
  devCmd.command("rm [uuid]").description("company からデバイス削除 (確認 prompt あり、--yes で非対話強制)")
    .option("--yes", "確認 prompt をスキップ (非対話モード必須)")
    .action((uuid, opts) => cmdDeviceRm(uuid, opts, program));

  program.command("history [deviceUUID]").description("デバイスの開閉履歴 (省略時は全デバイス or 対話)")
    .option("--page-size <n>", "ページサイズ")
    .action((uuid, opts) => cmdHistory(uuid, opts, program));
  program.command("battery [deviceUUID]").description("デバイスの電池履歴 (省略時は対話選択)")
    .option("--page-size <n>", "ページサイズ (default 100)")
    .action((uuid, opts) => cmdBattery(uuid, opts, program));
  program.command("firmware").description("配信中ファームウェア一覧")
    .action((opts) => cmdFirmware(opts, program));
  program.command("webapi <func>").description("biz3 WebAPI proxy 経由で REST API を叩く")
    .option("--query <json>", "query params (JSON)")
    .option("--body <json>", "request body (JSON)")
    .option("--api-key <id>", "apiKeyId (省略時は config.apiKeyId)")
    .action((func, opts) => cmdWebapi(func, opts, program));

  // bootstrap (互換コマンド: 既存 token を JSON で流し込み)
  program.command("bootstrap").description("既存 idToken/refreshToken を JSON stdin から流し込み")
    .action(async (opts) => {
      // stdin がパイプ/リダイレクトでない (TTY) のに読みに行くと無限に待つので明示拒否する。
      if (process.stdin.isTTY) die("bootstrap は JSON を stdin から受け取ります: echo '{...}' | sesame bootstrap", 2);
      const { tokenStore } = loadCtx(program);
      const chunks = [];
      for await (const c of process.stdin) chunks.push(c);
      const values = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const t = bootstrap(tokenStore, values);
      out(CLI_JSON, () => console.log(`OK: bootstrapped (clientId=${t.clientId})`),
        { ok: true, clientId: t.clientId });
    });

  // meta コマンド
  program.command("meta").description("Cognito 構成 (region/userPoolId/clientId) を表示")
    .action(() => out(CLI_JSON, () => console.log(JSON.stringify(CONFIG_META, null, 2)), CONFIG_META));

  // ---------- 拡張コマンド群 (Phase F–L) を cli/ サブモジュールから登録 ----------
  // 各 register は registerXxxCommands(program, ctx) で commander サブコマンドを生やす。
  // 本体ロジックは src/<module>.js、コマンド配線は src/cli/<module>.js に分離している。
  const ctx = makeCtx(program);
  registerScheduleCommands(program, ctx);
  registerCompanyCommands(program, ctx);
  registerOrgCommands(program, ctx);
  registerAccessCommands(program, ctx);
  registerIotCommands(program, ctx);
  registerPresetIrCommands(program, ctx);
  registerServeCommand(program); // 常駐 JSON-RPC バックエンド (serve は reserved に自動で入る)

  // デバイス主語の振り分け。先頭トークンが「既知の管理コマンド」でなければデバイス名とみなし、
  // 隠し op コマンドへ回す (sesame <device> [action] = device.action())。
  const userArgs = argv.slice(2);
  const isHelp = userArgs.some((a) => a === "-h" || a === "--help");
  const isJson = userArgs.includes("--json");
  const firstTok = userArgs.find((a) => !a.startsWith("-"));
  const reserved = new Set();
  for (const c of program.commands) { reserved.add(c.name()); for (const a of c.aliases()) reserved.add(a); }

  if (!isHelp) {
    if (!firstTok) {
      // 引数なし: 既定はデバイス主語の対話 (全デバイスの session)。非対話/JSON はそのまま help を出す。
      if (!isJson && isInteractive()) argv = [argv[0], argv[1], "session"];
    } else if (!reserved.has(firstTok)) {
      // 先頭が管理コマンドでない = デバイス名 → デバイス主語実行へ。
      argv = [argv[0], argv[1], "op", ...userArgs];
    }
  }

  // commander 自身の usage エラー (引数不足/未知オプション等) も JSON 契約に乗せる。
  // 全コマンドに exitOverride を伝播させ process.exit でなく throw させて下の catch に集約。
  // --json 時は commander の素のエラー文 (writeErr) を抑止し、die() の JSON 封筒だけ出す。
  (function propagateExitOverride(cmd) {
    cmd.exitOverride();
    cmd.configureOutput({ writeErr: (str) => { if (!CLI_JSON) process.stderr.write(str); } });
    for (const c of cmd.commands) propagateExitOverride(c);
  })(program);

  try {
    await program.parseAsync(argv);
  } catch (err) {
    // help/version 表示は正常終了 (commander が stdout に出力済み)。
    if (err.code === "commander.helpDisplayed" || err.code === "commander.help" || err.code === "commander.version") {
      finishCli(); return;
    }
    if (program.opts().debug) console.error(err.stack);
    // BLE 権限/電源エラーは macOS なら該当設定ペインを自動で開いて誘導する。
    if (maybeHandleBleError(err)) { finishCli(); return; }
    const code = (typeof err.exitCode === "number" && err.exitCode !== 0) ? err.exitCode : 1;
    // commander の usage エラー。非 JSON 時は commander が stderr に整形済み (usage 付き) なので二重出力を避ける。
    if (typeof err.code === "string" && err.code.startsWith("commander.")) {
      if (!CLI_JSON) { process.exitCode = code; finishCli(); return; }
      // --json: commander のメッセージ先頭 "error: " を剥がして封筒に載せる (error が二重にならないように)。
      die((err.message || "usage error").replace(/^error:\s*/i, ""), code); return;
    }
    die(withStaleHint(err.message || String(err)), code);
  }
  finishCli();
}

/**
 * 後始末してプロセスを終わらせる。noble (CoreBluetooth) を一度でも使うとネイティブ
 * ハンドルがイベントループに残り node が自然 exit しないため、その場合だけ明示終了する。
 * 出力の取りこぼしを防ぐため stdout を drain してから exit する。
 */
function finishCli() {
  if (!bleWasUsed()) return; // クラウドのみのコマンドは自然 exit に任せる (出力 truncate 回避)
  const code = process.exitCode || 0;
  if (process.stdout.write("")) process.exit(code);
  else process.stdout.once("drain", () => process.exit(code));
}

/**
 * BLE 権限/電源系エラーを検知し、macOS なら設定ペインを開いて案内する。
 * @returns {boolean} ハンドルした (= 呼び出し側は return) なら true
 */
function maybeHandleBleError(err) {
  const code = err?.code;
  if (code !== "BLE_UNAUTHORIZED" && code !== "BLE_POWERED_OFF" && code !== "BLE_NO_ADAPTER") return false;
  if (CLI_JSON) console.error(JSON.stringify({ error: err.message, code: 2, bleCode: code }));
  else console.error(`Error: ${err.message}`);
  if (!CLI_JSON && process.platform === "darwin" && code === "BLE_UNAUTHORIZED") {
    // システム設定 → プライバシーとセキュリティ → Bluetooth を直接開く (人間向け誘導。--json では出さない)。
    try {
      spawn("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Bluetooth"], {
        stdio: "ignore", detached: true,
      }).unref();
      console.error("→ Bluetooth のプライバシー設定を開きました。実行中のターミナル (Terminal/iTerm 等) を ON にして再実行してください。");
    } catch {
      console.error("→ システム設定 → プライバシーとセキュリティ → Bluetooth でターミナルを許可してください。");
    }
  }
  process.exitCode = 2;
  return true;
}

/**
 * server が「未知のキー/デバイス」系エラーを返した場合、config が古い可能性を
 * 案内に添える (stale 検知の最小実装。完全な存在確認はせず誘導に留める)。
 */
function withStaleHint(msg) {
  const m = String(msg);
  const looksStale =
    /Unknown key/i.test(m) ||
    /sendIR failed/i.test(m) ||
    /getIRCodes failed/i.test(m) ||
    /triggerLock failed/i.test(m) ||
    /not found/i.test(m) ||
    /invalid.*device/i.test(m);
  if (!looksStale) return m;
  return `${m}\nヒント: ローカル config が古い可能性があります。\n  IR キー: sesame remote sync-keys [name]\n  ロック/Hub3: sesame lock sync-from-devices / sesame hub3 sync-from-devices`;
}

