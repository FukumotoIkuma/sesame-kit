/**
 * 単発コマンドの経路を決定する。
 *   - 既定 (オート): 能力フル。経路はツールが自動選択する。BLE はスキャン/接続のオーバーヘッドが
 *     あるため毎回は張らず、cloud で運べる op は cloud、cloud で運べない op (autolock など BLE 必須)
 *     のみ BLE で一時接続する (cloud が速いという意味ではなく、BLE の接続コストを毎回払わないため)。
 *   - `--ble-only` / `--cloud-only`: 経路を固定したいときの明示指定 (最優先)。
 * 「BLE 接続を保持する」モードは `sesame session`。運べる経路はデバイス型×op の能力から導出する。
 * @param {string} op
 * @param {{ cloudOnly?: boolean, bleOnly?: boolean }} options
 * @param {string|null|undefined} model
 * @returns {"cloud"|"ble"}
 */
export function pickTransport(op: string, options: {
    cloudOnly?: boolean;
    bleOnly?: boolean;
}, model: string | null | undefined): "cloud" | "ble";
/**
 * cloud の device-status (stateInfo) を fmtMech と揃えた 1 行に整形。
 * @param {{ stateInfo?: { position?: number|null, batteryPercentage?: number|null, CHSesame2Status?: string } }|null|undefined} st
 * @returns {string}
 */
export function fmtCloudStatus(st: {
    stateInfo?: {
        position?: number | null;
        batteryPercentage?: number | null;
        CHSesame2Status?: string;
    };
} | null | undefined): string;
/**
 * status 出力から秘匿値 (secretKey) を落とす。status は状態読み取りで鍵は不要。
 * @param {unknown} st
 * @returns {unknown}
 */
export function sanitizeStatus(st: unknown): unknown;
/**
 * BLE で 1 操作 (connect→op→close)。--ble-only 明示 or BLE 必須 op (autolock) 用。
 * OS2 デバイス (capabilitiesForModel(entry.model).os === 2) は SesameOS2Ble ファサードへ委譲。
 * OS3 は従来どおり SesameBle (OS3 ファサード)。
 * OS2/OS3 でハンドシェイク・暗号が完全に別物のため、ファサードを間違えると接続不可になる
 * (CHSesame2Device.kt 系 vs CHSesameOS3.kt 系 — 互換性なし)。
 * @param {string} op
 * @param {LockEntry} entry
 * @param {string|number|null|undefined} seconds
 * @param {GlobalOpts} gopts
 * @param {{ scanTimeoutMs?: number }} [bleOpts]
 */
export function runBleOp(op: string, entry: LockEntry, seconds: string | number | null | undefined, gopts: GlobalOpts, { scanTimeoutMs }?: {
    scanTimeoutMs?: number;
}): Promise<void>;
/**
 * クラウド経由で 1 操作を実行。
 * @param {string} op
 * @param {LockEntry} entry
 * @param {Program} program
 */
export function runCloudOp(op: string, entry: LockEntry, program: Program): Promise<void>;
/**
 * cmdDeviceOp / cmdAct が cli.js から注入される依存。
 * maybeHandleBleError は cli.js に実体がある (BLE 環境エラーの終了コード契約をソース固定する
 * テストの都合 + macOS 設定ペイン誘導という「プロセス終端の関心事」のため)。
 * @typedef {{ maybeHandleBleError?: (err: unknown) => boolean }} LockOpsDeps
 */
/**
 * デバイス主語の実行: `sesame <device> [action] [args]`。
 *   - action 省略 + TTY → そのデバイス (複数可) の対話セッション。
 *   - action 省略 + 非対話 → status を表示。
 *   - action 指定 → 1 発実行 (cmdAct に委譲。経路はオートで自動)。
 * @param {string|undefined} device
 * @param {string|undefined} action
 * @param {string[]|undefined} args
 * @param {{ bleOnly?: boolean, cloudOnly?: boolean, name?: string }} options
 * @param {Program} program
 * @param {LockOpsDeps} [deps]
 */
export function cmdDeviceOp(device: string | undefined, action: string | undefined, args: string[] | undefined, options: {
    bleOnly?: boolean;
    cloudOnly?: boolean;
    name?: string;
}, program: Program, deps?: LockOpsDeps): Promise<void>;
/**
 * @param {string} op
 * @param {string|undefined} name
 * @param {string|null|undefined} seconds
 * @param {{ bleOnly?: boolean, cloudOnly?: boolean, name?: string }} options
 * @param {Program} program
 * @param {LockOpsDeps} [deps]
 */
export function cmdAct(op: string, name: string | undefined, seconds: string | null | undefined, options: {
    bleOnly?: boolean;
    cloudOnly?: boolean;
    name?: string;
}, program: Program, deps?: LockOpsDeps): Promise<void>;
/** @typedef {import("./exec.js").MechStatus} MechStatus */
/** @typedef {import("./ctx.js").Program} Program */
/** @typedef {import("./ctx.js").GlobalOpts} GlobalOpts */
/** @typedef {import("./ctx.js").CliError} CliError */
/** 統合ロック操作の解決済み entry。 */
/**
 * @typedef {object} LockEntry
 * @property {string} name
 * @property {string} deviceUUID
 * @property {string} secretKey
 * @property {string|null} [model]
 * @property {string} [ssmPublicKey] OS2 BLE login 用デバイス公開鍵 (128 hex)。config に保存済みのときのみ存在。
 * @property {string} [keyIndex]     OS2 BLE login 用 userIdx (4 hex)。config に保存済みのときのみ存在。
 */
/** デバイスに対して可能な操作 (動詞)。制御 op は能力モデル (CONTROL_OPS) を単一真実源として引き、
 *  状態取得の "status" だけ CLI 固有に足す。型ごとの可否は cmdAct の能力ゲートが別途判定する。 */
export const DEVICE_ACTIONS: Set<string>;
/**
 * cmdDeviceOp / cmdAct が cli.js から注入される依存。
 * maybeHandleBleError は cli.js に実体がある (BLE 環境エラーの終了コード契約をソース固定する
 * テストの都合 + macOS 設定ペイン誘導という「プロセス終端の関心事」のため)。
 */
export type LockOpsDeps = {
    maybeHandleBleError?: (err: unknown) => boolean;
};
export type MechStatus = import("./exec.js").MechStatus;
export type Program = import("./ctx.js").Program;
export type GlobalOpts = import("./ctx.js").GlobalOpts;
export type CliError = import("./ctx.js").CliError;
export type LockEntry = {
    name: string;
    deviceUUID: string;
    secretKey: string;
    model?: string | null | undefined;
    /**
     * OS2 BLE login 用デバイス公開鍵 (128 hex)。config に保存済みのときのみ存在。
     */
    ssmPublicKey?: string | undefined;
    /**
     * OS2 BLE login 用 userIdx (4 hex)。config に保存済みのときのみ存在。
     */
    keyIndex?: string | undefined;
};
import { bleExec } from "./exec.js";
import { fmtMech } from "./exec.js";
export { bleExec, fmtMech };
//# sourceMappingURL=lock-ops.d.ts.map