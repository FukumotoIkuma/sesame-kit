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
export type MechStatus = import("./exec.js").MechStatus;
export type SesameHub3 = import("@sesame-kit/core/client").SesameHub3;
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
    ble: (import("@sesame-kit/core/ble").SesameBle & {
        lastStatus?: MechStatus | null;
    }) | null;
};
//# sourceMappingURL=session.d.ts.map