/**
 * iot サブコマンドの commander options (--device/--secret/--hub3 ほか)。
 * commander は値を string | undefined で渡す (boolean フラグは --get のみ)。
 * @typedef {{
 *   device?: string,
 *   secret?: string,
 *   hub3?: string,
 *   get?: boolean,
 *   wait?: string,
 *   sesame?: string,
 *   ssmSec?: string,
 *   nick?: string,
 *   model?: string,
 * }} IotOptions
 */
/**
 * resolveTarget / pickFromList / configCandidates が扱うデバイス候補。
 * server の listDevices と config 由来の両方をこの形に正規化する。
 * @typedef {{
 *   deviceUUID?: string,
 *   secretKey?: string|null,
 *   deviceModel?: string|null,
 *   deviceName?: string|null,
 * }} IotCandidate
 */
/**
 * resolveTarget / pickFromList の解決結果。
 * @typedef {{ deviceId: string|undefined, secretKey: string|undefined, hub3Id: string|undefined }} IotTarget
 */
/**
 * @param {import("commander").Command} program
 * @param {import("../cli.js").CliCtx} ctx cli.js makeCtx() が供給する共有コンテキスト
 */
export function registerIotCommands(program: import("commander").Command, ctx: import("../cli.js").CliCtx): void;
/**
 * iot サブコマンドの commander options (--device/--secret/--hub3 ほか)。
 * commander は値を string | undefined で渡す (boolean フラグは --get のみ)。
 */
export type IotOptions = {
    device?: string;
    secret?: string;
    hub3?: string;
    get?: boolean;
    wait?: string;
    sesame?: string;
    ssmSec?: string;
    nick?: string;
    model?: string;
};
/**
 * resolveTarget / pickFromList / configCandidates が扱うデバイス候補。
 * server の listDevices と config 由来の両方をこの形に正規化する。
 */
export type IotCandidate = {
    deviceUUID?: string;
    secretKey?: string | null;
    deviceModel?: string | null;
    deviceName?: string | null;
};
/**
 * resolveTarget / pickFromList の解決結果。
 */
export type IotTarget = {
    deviceId: string | undefined;
    secretKey: string | undefined;
    hub3Id: string | undefined;
};
//# sourceMappingURL=iot.d.ts.map