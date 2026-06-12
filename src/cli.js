// commander ベースの CLI。bin/sesame.js から run() を呼ぶ。
//
// 設計メモ:
// - グローバルオプション --config-dir / --debug / --json は program.opts() で取得
// - 全コマンドは loadCtx() でファクトリ越しに ConfigStore / TokenStore を得る
// - 出力は --json 指定時に JSON.stringify、それ以外は人間可読
// - 位置引数が足りない & TTY & !--json なら対話 prompt (src/prompts.js)
//
// P5-3 で本体ロジックは src/cli/ 配下へ分割済み。ここに残るのは
// run() (ロケール確定 → コマンド登録 → ルーティング → エラー契約) と終了処理のみ。

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { setLocale, resolveLocale, isKnownLang, t } from "./i18n.js";
import {
  die, setJsonMode, isJsonMode, withStaleHint,
  isCommanderError, commanderErrorInfo, runtimeExitCode,
  maybeHandleBleError,
} from "./cli/errors.js";
import { routeDeviceArgv } from "./cli/dispatch.js";
import { CONFIG_META } from "./auth.js";
import { isInteractive } from "./prompts.js";
// ---- P5-3 で抽出した CLI サブモジュール ----
import { makeCtx, loadCtx, out, redactConfig } from "./cli/ctx.js";
import { cmdLogin, cmdVerify, cmdSetup, cmdRefresh, cmdLogout, cmdWhoami, cmdBootstrap } from "./cli/auth.js";
import { cmdMigrate } from "./cli/migrate.js";
import { cmdDeviceOp, DEVICE_ACTIONS, fmtCloudStatus, sanitizeStatus } from "./cli/lock-ops.js";
import { cmdSession } from "./cli/session.js";
import { registerSendCommands, registerRemoteCommands } from "./cli/remote.js";
import { registerInitCommand, registerConfigCommands } from "./cli/config-cmd.js";
import { registerLocksCommands } from "./cli/locks.js";
import { registerIrCommands } from "./cli/ir.js";
import { registerDevicesCommand, registerDeviceCommands } from "./cli/device.js";
import { registerScheduleCommands } from "./cli/schedule.js";
import { registerCompanyCommands } from "./cli/company.js";
import { registerPaymentCommands } from "./cli/payment.js";
import { registerOrgCommands } from "./cli/org.js";
import { registerAccessCommands } from "./cli/access.js";
import { registerIotCommands } from "./cli/iot.js";
import { registerPresetIrCommands } from "./cli/presetir.js";
import { registerBleCommands } from "./cli/ble.js";
import { registerServeCommand } from "./cli/serve.js";
import { bleWasUsed } from "./ble/transport.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --json 契約・die()・終了コード・stale hint は src/cli/errors.js に集約 (横断のエラー契約)。

/**
 * commander の Command (全コマンドハンドラに渡る program)。
 * @typedef {import("commander").Command} Program
 */

/** @typedef {import("./cli/ctx.js").GlobalOpts} GlobalOpts */
/** @typedef {import("./cli/ctx.js").CmdOpts} CmdOpts */
/**
 * cli/ サブモジュールへ渡す共有コンテキスト (実体は src/cli/ctx.js)。
 * 既存 register モジュールが import("../cli.js").CliCtx で参照するため再公開する。
 * @typedef {import("./cli/ctx.js").CliCtx} CliCtx
 */

// ---------- 共通ユーティリティ ----------

function getPkgVersion() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ---------- デバイス主語の振り分け補助 ----------
// 実行系 (pickTransport/bleExec/runBleOp/runCloudOp/cmdAct/cmdDeviceOp) は src/cli/lock-ops.js、
// セッションモード (cmdSession + UI コントローラ群) は src/cli/session.js に分離 (P5-3)。
// run() のルーティング (routeDeviceArgv) が使う isKnownDevice だけここに残す。

/**
 * 先頭トークンが「登録済みデバイス名」を指しているか (op へ回してよいか) を非破壊で判定する。
 * lock 派生 view に限らず devices/hub3s の全デバイスキーを対象にする。
 * config 不在/破損時は false (= 未知コマンド扱いに委ねる)。例外は飲み込む (ルーティングを壊さない)。
 * @param {Program} program
 * @param {string|undefined} name
 * @returns {boolean}
 */
function isKnownDevice(program, name) {
  if (!name) return false;
  try {
    const { configStore } = loadCtx(program);
    if (!configStore.exists()) return false;
    const cfg = configStore.load();
    const names = Object.keys(cfg.devices || {});
    if (names.length === 0) return false;
    return names.includes(name);
  } catch {
    return false;
  }
}

// ---------- run ----------

// テスト用 re-export: status 出力の純関数 (秘匿値除去 / 整形) と config マスク。
// 実体は P5-3 で src/cli/lock-ops.js / src/cli/ctx.js へ移動 (import パス互換のため再公開)。
// maybeHandleBleError はバックログ9 (テスト seam) で src/cli/errors.js へ移動。既存の
// import 互換のためここからも再公開する。
export { fmtCloudStatus, sanitizeStatus, redactConfig, maybeHandleBleError };

// 明示された --lang の解決済みロケール (init で uiLang/lang を永続化するために保持)。
// 認識できないフラグや未指定なら null。
/** @type {import("./i18n.js").Locale|null} */
let CLI_LANG_FLAG = null;

export async function run(argv = process.argv) {
  setJsonMode(argv.includes("--json")); // die()/エラー経路用にグローバル --json を先に確定
  const program = new Command();

  // UI ロケールを確定する (この後 t() を使うコマンド description / help / session UI 等に効く)。
  // commander へコマンドを登録する前に行う: description 文字列は登録時に t() で解決されるため、
  // それより先に setLocale() しないと既定 "en" のまま固定されてしまう。
  // 優先順位: --lang フラグ > config.uiLang > 既定 "en"。commander parse 前なので argv を直接覗く。
  {
    const langFlag =
      (() => { const i = argv.indexOf("--lang"); return i >= 0 ? argv[i + 1] : null; })() ||
      (argv.find((a) => a.startsWith("--lang=")) || "").split("=")[1] || null;
    // 未知の --lang (例: `--lang xx`) は黙って英語へ落とさず警告する (typo に気付けるように)。
    if (langFlag && !isKnownLang(langFlag)) console.error(t("cli.unknownLang", { lang: langFlag }));
    let cfgUiLang = null;
    try { const { configStore } = loadCtx(program); if (configStore.exists()) cfgUiLang = configStore.load().uiLang; } catch { /* config 未作成等は無視 */ }
    const locale = resolveLocale({ flag: langFlag, configLang: cfgUiLang });
    setLocale(locale);
    // 明示かつ認識できたフラグだけ init の永続化対象にする (`sesame --lang en init` の意図を残す)。
    CLI_LANG_FLAG = (langFlag && isKnownLang(langFlag)) ? locale : null;
  }

  program
    .name("sesame")
    .description(t("cli.progDescription"))
    .version(getPkgVersion(), "-V, --version", t("cli.versionOption"))
    // 引数不足/未知オプション時に usage を出す (commander 既定はエラー1行のみで不親切)。
    // この前に設定すると後で追加する全サブコマンドへ継承される。--json 時は writeErr 側で抑止。
    .showHelpAfterError()
    .showSuggestionAfterError()
    .option("--config-dir <path>", t("cli.optConfigDir"))
    .option("--debug", t("cli.optDebug"))
    .option("--json", t("cli.optJson"))
    .option("--lang <lang>", t("cli.optLang"));
  program
    .helpOption("-h, --help", t("cli.helpOption"))
    .addHelpCommand("help [command]", t("cli.helpCommand"))
    .configureHelp({
      styleTitle: (str) => ({
        "Usage:": t("cli.helpTitleUsage"),
        "Arguments:": t("cli.helpTitleArguments"),
        "Options:": t("cli.helpTitleOptions"),
        "Global Options:": t("cli.helpTitleGlobalOptions"),
        "Commands:": t("cli.helpTitleCommands"),
      }[str] || str),
    });

  program.addHelpText("before", t("cli.helpBefore"));

  // ---------- 認証系 (src/cli/auth.js) ----------
  program.command("login <email>").description(t("cli.descLogin"))
    .action((email, opts) => cmdLogin(email, opts, program));
  program.command("verify [code]").description(t("cli.descVerify"))
    .action((code, opts) => cmdVerify(code, opts, program));
  program.command("refresh").description(t("cli.descRefresh"))
    .action((opts) => cmdRefresh(opts, program));
  program.command("logout").description(t("cli.descLogout"))
    .action((opts) => cmdLogout(opts, program));
  program.command("whoami").description(t("cli.descWhoami"))
    .action((opts) => cmdWhoami(opts, program));

  // ---------- IR 送信 + デバイス dump (src/cli/remote.js / device.js) ----------
  registerSendCommands(program);    // send / list / ping
  registerDevicesCommand(program);  // devices (全デバイス dump → devices.json)

  // ---------- セットアップ / 設定 (src/cli/config-cmd.js, auth.js, migrate.js) ----------
  registerInitCommand(program, { getLangFlag: () => CLI_LANG_FLAG });
  program.command("setup").description(t("cli.descSetup"))
    .action((opts) => cmdSetup(opts, program));
  program.command("migrate [srcDir]").description(t("cli.descMigrate"))
    .action((srcDir, opts) => cmdMigrate(srcDir, opts, program));
  registerConfigCommands(program);  // config / config path / config show

  // ---------- config 管理グループ (src/cli/remote.js / locks.js) ----------
  registerRemoteCommands(program);  // remote / hub3
  registerLocksCommands(program);   // locks (定義の管理。操作は下のトップレベル動詞)

  // ---------- デバイス主語の実行 (sesame <device> [action]) ----------
  // 主語はデバイス。`sesame front unlock` = front.unlock() 相当 (SDK の device.method() と同じ)。
  // action 省略は対話メニュー (= そのデバイスの session)。引数なし `sesame` は全デバイスの session。
  // 経路は既定「オート」(能力フル・自動。BLE 必須 op のみ BLE)。固定は --ble-only / --cloud-only。
  // 例: sesame front unlock / sesame kitchen click / sesame front autolock 30 / sesame front --ble-only
  //
  // 実体は隠し op コマンド。先頭トークンが既知コマンドでなければ run() がここへ振り分ける。
  program.command("op [device] [action] [args...]", { hidden: true })
    .option("--ble-only", t("cli.optBleOnly"))
    .option("--cloud-only", t("cli.optCloudOnly"))
    // maybeHandleBleError (終了コード契約 + macOS 設定ペイン誘導。実体は cli/errors.js) を注入する。
    .action((device, action, args, opts) => cmdDeviceOp(device, action, args, opts, program, { maybeHandleBleError }));

  program.command("session [names...]").alias("watch")
    .description(t("cli.descSession"))
    .addHelpText("after", t("cli.helpSession"))
    .action((names, opts) => cmdSession(names, opts, program));

  // ---------- IR advanced (Phase C) / device management (Phase D) ----------
  registerIrCommands(program);      // ir learn/mode/key/remote-* (src/cli/ir.js)
  registerDeviceCommands(program);  // device 管理 + history/battery/firmware/webapi (src/cli/device.js)

  // bootstrap (互換コマンド: app-login 済み token backup の復元。実体は src/cli/auth.js)
  program.command("bootstrap").description(t("cli.descBootstrap"))
    .action((opts) => cmdBootstrap(opts, program));

  // meta コマンド
  program.command("meta").description(t("cli.descMeta"))
    .action(() => out(isJsonMode(), () => console.log(JSON.stringify(CONFIG_META, null, 2)), CONFIG_META));

  // ---------- 拡張コマンド群 (Phase F–L) を cli/ サブモジュールから登録 ----------
  // 各 register は registerXxxCommands(program, ctx) で commander サブコマンドを生やす。
  // 本体ロジックは src/<module>.js、コマンド配線は src/cli/<module>.js に分離している。
  const ctx = makeCtx(program);

  registerScheduleCommands(program, ctx);
  registerCompanyCommands(program, ctx);
  registerPaymentCommands(program, ctx);
  registerOrgCommands(program, ctx);
  registerAccessCommands(program, ctx);
  registerIotCommands(program, ctx);
  registerPresetIrCommands(program, ctx);
  registerBleCommands(program, ctx); // BLE 直結の読み取り系 (scan / 生体一覧 / Bot2 スクリプト)
  registerServeCommand(program); // 常駐 JSON-RPC バックエンド (serve は reserved に自動で入る)

  // デバイス主語の振り分け (位置引数の抽出・予約語判定・op 書き換え) は cli/dispatch.js に分離。
  // 既知デバイス / device action を伴うものだけ隠し op コマンドへ回し、それ以外の単独トークンは
  // 据え置いて commander に未知コマンド (+ 候補提示) を出させる。
  argv = routeDeviceArgv({
    argv,
    program,
    deviceActions: DEVICE_ACTIONS,
    isKnownDevice: (name) => isKnownDevice(program, name),
    interactive: isInteractive(),
  });

  // commander 自身の usage エラー (引数不足/未知オプション等) も JSON 契約に乗せる。
  // 全コマンドに exitOverride を伝播させ process.exit でなく throw させて下の catch に集約。
  // --json 時は commander の素のエラー文 (writeErr) を抑止し、die() の JSON 封筒だけ出す。
  (function propagateExitOverride(cmd) {
    cmd.exitOverride();
    cmd.configureOutput({ writeErr: (str) => { if (!isJsonMode()) process.stderr.write(str); } });
    for (const c of cmd.commands) propagateExitOverride(c);
  })(program);

  try {
    await program.parseAsync(argv);
  } catch (err) {
    const e = /** @type {import("./cli/errors.js").CommanderLikeError} */ (err);
    // help/version 表示は正常終了 (commander が stdout に出力済み)。
    if (e.code === "commander.helpDisplayed" || e.code === "commander.help" || e.code === "commander.version") {
      finishCli(); return;
    }
    if (program.opts().debug) console.error(e.stack);
    // BLE 権限/電源エラーは macOS なら該当設定ペインを自動で開いて誘導する。
    if (maybeHandleBleError(err)) { finishCli(); return; }
    // commander の usage エラー (未知コマンド/オプション/引数欠落) は契約どおり exit 2 に統一する。
    if (isCommanderError(err)) {
      const { msg, code } = commanderErrorInfo(e);
      // 非 JSON 時は commander が stderr に整形済み (usage 付き) なので二重出力を避ける。
      if (!isJsonMode()) { process.exitCode = code; finishCli(); return; }
      die(msg, code); return; // --json: 封筒で出す
    }
    die(withStaleHint(err), runtimeExitCode(err));
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
