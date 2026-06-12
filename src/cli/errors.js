// CLI の「エラー/終了コード契約」を 1 箇所に集約する横断モジュール。
//
// 以前は die()・--json 封筒・終了コード判定・commander の usage エラー写像・stale hint が
// すべて巨大な cli.js に直書きされ、終了コードが不統一 (usage エラーが 1 だったり 2 だったり)
// だった。契約をここへ一本化する:
//   - 終了コード: 0=成功 / 1=ランタイムエラー / 2=usage エラー (README と一致)。
//     BLE 環境エラー (BLE_UNAUTHORIZED/BLE_UNSUPPORTED/BLE_POWERED_OFF/BLE_INIT_TIMEOUT/
//     BLE_NO_ADAPTER) は実行環境のランタイム障害なので 1 (usage の 2 ではない。SURF-19。
//     下の maybeHandleBleError 参照 — --json 封筒には bleCode が付く)。
//   - --json 時: 成功は stdout に純 JSON、エラーは stderr に {error, code} JSON。
//
// 依存方向: cli.js / cli/*.js → このモジュール (逆は無し)。
import { spawn } from "node:child_process";
import { t } from "../i18n.js";
import { SesameError, ERR } from "../errors.js";

/** 終了コード契約 (README: 0=成功 / 1=ランタイム / 2=usage)。 */
export const EXIT = Object.freeze({ OK: 0, RUNTIME: 1, USAGE: 2 });

// commander が usage 系で投げる error.code 一覧。これらは exit 2 へ統一する。
// commander 既定は exitCode=1 で、README の「usage error = 2」契約と食い違っていた
// (例: `login` の必須引数欠落、未知オプション、未知コマンドがすべて 1 を返していた)。
const COMMANDER_USAGE_CODES = new Set([
  "commander.unknownCommand",
  "commander.unknownOption",
  "commander.missingArgument",
  "commander.optionMissingArgument",
  "commander.missingMandatoryOptionValue",
  "commander.mandatoryOptionMissing",
  "commander.excessArguments",
  "commander.invalidArgument",
  "commander.invalidOptionArgument",
]);

// --json がグローバル指定されているか。run() 冒頭で setJsonMode() し、die() 等
// program.opts() を取れない経路でも JSON 契約を守れるようにする。
let _jsonMode = false;
/** @param {boolean} on */
export function setJsonMode(on) { _jsonMode = !!on; }
/** @returns {boolean} */
export function isJsonMode() { return _jsonMode; }

/**
 * エラーを表示してプロセスを終了する。エラーは常に stderr へ (stdout は成功 JSON 専用)。
 * @param {string} msg
 * @param {number} [code] EXIT.RUNTIME(1) 既定。usage エラーは EXIT.USAGE(2)。
 * @returns {never}
 */
export function die(msg, code = EXIT.RUNTIME) {
  if (_jsonMode) console.error(JSON.stringify({ error: msg, code }));
  else console.error(`Error: ${msg}`);
  process.exit(code);
}

/**
 * commander の usage エラーか (未知コマンド/オプション/引数欠落など)。
 * @param {unknown} err
 * @returns {boolean}
 */
export function isCommanderError(err) {
  return (
    !!err &&
    typeof err === "object" &&
    "code" in err &&
    typeof (/** @type {{code?: unknown}} */ (err).code) === "string" &&
    /** @type {{code: string}} */ (err).code.startsWith("commander.")
  );
}

/**
 * commander が投げる usage エラー (CommanderError 互換)。
 * @typedef {Error & {code?: string, exitCode?: number}} CommanderLikeError
 */

/**
 * commander エラーから {msg, code} を導く。usage 系は常に exit 2。
 * メッセージ先頭の "error: " は剥がす (--json 封筒で error が二重にならないように)。
 * @param {CommanderLikeError} err
 * @returns {{msg:string, code:number}}
 */
export function commanderErrorInfo(err) {
  const code = COMMANDER_USAGE_CODES.has(err.code ?? "")
    ? EXIT.USAGE
    : (typeof err.exitCode === "number" && err.exitCode !== 0 ? err.exitCode : EXIT.RUNTIME);
  const msg = (err.message || t("cli.usageError")).replace(/^error:\s*/i, "");
  return { msg, code };
}

/**
 * commander 以外の一般エラーの exit code (明示 exitCode を尊重、無ければ 1)。
 * P4-2 (SURF-28): SesameError(BAD_REQUEST) は「呼び出し側不正」= usage エラーなので
 * EXIT.USAGE(2) を返す。serve 経路 (toServeError: bad_params→exitCode=2) と対称にする。
 * @param {unknown} err
 * @returns {number}
 */
export function runtimeExitCode(err) {
  // 呼び出し側不正 (引数欠落/不明なデバイス名など) は usage エラー = 2。
  // serve 経路の bad_params→exitCode=2 (toServeError) と終了コードを一致させる。
  if (err instanceof SesameError && err.code === ERR.BAD_REQUEST) return EXIT.USAGE;
  const exitCode =
    err && typeof err === "object" && "exitCode" in err
      ? /** @type {{exitCode?: unknown}} */ (err).exitCode
      : undefined;
  return typeof exitCode === "number" && exitCode !== 0 ? exitCode : EXIT.RUNTIME;
}

/**
 * maybeHandleBleError のテスト用 seam (バックログ9)。実 BLE 環境 (権限拒否等) が無いと
 * 経路を起動できないため、副作用 (platform 判定・設定ペイン spawn・exitCode 設定) を
 * 注入可能にする。本番 (cli.js / cli/lock-ops.js) は引数無しで呼び、既定の実体を使う。
 * @typedef {object} BleErrorDeps
 * @property {NodeJS.Platform} [platform] 既定 process.platform
 * @property {typeof spawn} [spawnFn] 既定 node:child_process.spawn
 * @property {(code: number) => void} [setExitCode] 既定 process.exitCode への代入
 */

/**
 * BLE 権限/電源系エラーを検知し、macOS なら設定ペインを開いて案内する。
 * 旧実装は cli.js の内部関数で、tests/cli/errors.test.js がソース文字列で挙動を固定していた
 * (バックログ9)。挙動契約は不変: exit 1 (SURF-19: ランタイム障害。2 は usage 専用) /
 * --json 封筒は {error, code:1, bleCode} で bleCode (機械可読な BLE 分類) を維持する。
 * @param {unknown} err
 * @param {BleErrorDeps} [deps]
 * @returns {boolean} ハンドルした (= 呼び出し側は return) なら true
 */
export function maybeHandleBleError(err, deps = {}) {
  const {
    platform = process.platform,
    spawnFn = spawn,
    setExitCode = (/** @type {number} */ c) => { process.exitCode = c; },
  } = deps;
  const e = /** @type {Error & {code?: string|number, message?: string}} */ (err);
  const code = e?.code;
  if (
    code !== "BLE_UNAUTHORIZED" &&
    code !== "BLE_UNSUPPORTED" && // Linux/RPi/headless: アダプタ無し・権限不足 (native abort 探触のマップ先)
    code !== "BLE_POWERED_OFF" &&
    code !== "BLE_INIT_TIMEOUT" &&
    code !== "BLE_NO_ADAPTER"
  )
    return false;
  // SURF-19: BLE 環境エラー (権限/アダプタ/電源/初期化) は実行環境のランタイム障害であり
  // usage(2) ではない → 終了コード契約 (EXIT) どおり 1。封筒の code は exit code と一致させ、
  // bleCode (機械可読な BLE 分類) は維持する。
  if (isJsonMode()) console.error(JSON.stringify({ error: e.message, code: 1, bleCode: code }));
  else console.error(`Error: ${e.message}`);
  if (!isJsonMode() && platform === "darwin" && code === "BLE_UNAUTHORIZED") {
    // システム設定 → プライバシーとセキュリティ → Bluetooth を直接開く (人間向け誘導。--json では出さない)。
    try {
      spawnFn("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Bluetooth"], {
        stdio: "ignore", detached: true,
      }).unref();
      console.error(t("cli.bleOpenedPrivacy"));
    } catch {
      console.error(t("cli.bleEnablePrivacy"));
    }
  }
  setExitCode(EXIT.RUNTIME); // SURF-19: ランタイム障害 = 1 (2 は usage 専用)
  return true;
}

/**
 * server が「未知のキー/デバイス」系エラーを返したら config が古い可能性を案内に添える。
 * ただし JSON-RPC の構造化エラー (err.rpcError マーカーや data.kind を持つ) と型付き
 * SesameError は既に正しい分類を持つので hint を付けない: `Method not found` のような
 * 単なる typo を「config が古い」と誤誘導しないため。
 * @param {unknown} err  Error オブジェクト (推奨) か message 文字列
 * @returns {string} 表示用メッセージ
 */
export function withStaleHint(err) {
  if (err && typeof err === "object") {
    const e = /** @type {{rpcError?: unknown, data?: {kind?: unknown}, message?: string}} */ (err);
    if (e.rpcError) return e.message || String(err);            // serve からの JSON-RPC エラー
    if (e.data && e.data.kind) return e.message || String(err);
    if (err instanceof SesameError) return err.message || String(err);
  }
  const errMsg =
    err && typeof err === "object" && "message" in err
      ? /** @type {{message?: unknown}} */ (err).message
      : undefined;
  const m = String(errMsg != null ? errMsg : err);
  const looksStale =
    /Unknown key/i.test(m) ||
    /sendIR failed/i.test(m) ||
    /getIRCodes failed/i.test(m) ||
    /triggerLock failed/i.test(m) ||
    /not found/i.test(m) ||
    /invalid.*device/i.test(m);
  if (!looksStale) return m;
  return t("cli.staleHint", { msg: m });
}
