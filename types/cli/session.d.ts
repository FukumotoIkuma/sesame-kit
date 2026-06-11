export function sessionLabel(): {
    unlock: string;
    lock: string;
    toggle: string;
    click: string;
    status: string;
    autolock: string;
    ir: string;
    "relay-on": string;
    "relay-off": string;
    led: string;
};
/**
 * セッション対象 1 デバイスの entry (ロック / Hub3 を統合した緩い形)。
 * @typedef {object} SessionEntry
 * @property {string} name
 * @property {string} [deviceUUID] ロック (BLE)
 * @property {string} [secretKey]
 * @property {string} [deviceId] Hub3 (cloud relay/LED)
 * @property {string|null} [model]
 * @property {string} [kind]
 */
/**
 * セッション中の 1 デバイス。ble は接続できたら SesameBle、未接続は null。
 * lastStatus は SesameBle 側のキャッシュ済み mechStatus。
 * @typedef {{ kind: string, entry: SessionEntry, ble: (import("../ble/index.js").SesameBle & { lastStatus?: MechStatus|null })|null }} SessionDevice
 */
/**
 * デバイス型 × 利用可能な経路の **和集合** で操作一覧を作る。
 * その op を運べる経路が今使えるときだけ出す: BLE 接続中なら ble 能力、ログイン済みなら cloud 能力。
 * (例: ロックは BLE 接続中のみ autolock を出す。OS2 ロックは cloud の lock/unlock/toggle のみ。)
 * @param {SessionDevice} d
 * @param {boolean} hasCloud クラウド経路が使えるか
 * @returns {Array<{label:string, value:string}>}
 */
export function sessionActionsFor(d: SessionDevice, hasCloud: boolean): Array<{
    label: string;
    value: string;
}>;
/**
 * ヘッダの状態表示。BLE 接続済みは実 mechStatus、Hub3/未接続は注記 (クラウド状態は形が不定で正規化しない)。
 * @param {SessionDevice} d
 * @returns {string}
 */
export function sessionFmtState(d: SessionDevice): string;
/**
 * 1 操作を実行し結果メッセージを返す。
 *   ロック: BLE 接続済みなら BLE、無ければクラウド (autolock は BLE 必須)。
 *   Hub3 : IR 送信 (extra={remote,key}) / リレー ON/OFF / LED (extra=duty)。いずれもクラウド。
 * @param {SesameHub3|null} hub クラウドクライアント (未ログイン時 null)
 * @returns {(op: string, d: SessionDevice, extra: any) => Promise<string>}
 */
export function makeSessionExec(hub: SesameHub3 | null): (op: string, d: SessionDevice, extra: any) => Promise<string>;
/**
 * 対象ロックへ BLE 接続を張ったまま保持し、runSessionMenu でメニュー操作させる。
 * 接続を維持するので 1 操作ごとの再スキャン/再接続が起きない。
 *
 * @param {string[]} names 対象ロック名 (完全一致)。空なら config の全ロック。
 * @param {{ bleOnly?: boolean, cloudOnly?: boolean }} _options
 * @param {Program} program
 */
export function cmdSession(names: string[], _options: {
    bleOnly?: boolean;
    cloudOnly?: boolean;
}, program: Program): Promise<void>;
export type Program = import("./ctx.js").Program;
export type GlobalOpts = import("./ctx.js").GlobalOpts;
export type CliError = import("./ctx.js").CliError;
export type LockEntry = import("./lock-ops.js").LockEntry;
export type MechStatus = import("./lock-ops.js").MechStatus;
export type SesameHub3 = import("../client.js").SesameHub3;
/**
 * config 由来の Hub3 entry (relay/LED 用 secretKey 付き)。
 */
export type Hub3Entry = {
    name: string;
    deviceId: string | undefined;
    model: string;
    secretKey: string | null;
};
/**
 * セッション対象 1 デバイスの entry (ロック / Hub3 を統合した緩い形)。
 */
export type SessionEntry = {
    name: string;
    /**
     * ロック (BLE)
     */
    deviceUUID?: string | undefined;
    secretKey?: string | undefined;
    /**
     * Hub3 (cloud relay/LED)
     */
    deviceId?: string | undefined;
    model?: string | null | undefined;
    kind?: string | undefined;
};
/**
 * セッション中の 1 デバイス。ble は接続できたら SesameBle、未接続は null。
 * lastStatus は SesameBle 側のキャッシュ済み mechStatus。
 */
export type SessionDevice = {
    kind: string;
    entry: SessionEntry;
    ble: (import("../ble/index.js").SesameBle & {
        lastStatus?: MechStatus | null;
    }) | null;
};
//# sourceMappingURL=session.d.ts.map