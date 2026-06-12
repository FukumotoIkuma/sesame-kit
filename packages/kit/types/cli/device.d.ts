/**
 * `sesame devices` (全デバイス dump → devices.json) を登録する。
 * help のコマンド順 = 登録順のため、device グループより前 (ping の直後) に呼ぶ。
 * @param {Program} program
 */
export function registerDevicesCommand(program: Program): void;
/**
 * `sesame device …` グループ + history / battery / firmware / webapi を登録する (Phase D)。
 * @param {Program} program
 */
export function registerDeviceCommands(program: Program): void;
export type Program = import("./ctx.js").Program;
export type CmdOpts = import("./ctx.js").CmdOpts;
export type CliError = import("./ctx.js").CliError;
export type DeviceInfo = import("@sesame-kit/core/client").DeviceInfo;
/**
 * listDevices の生レコードは DeviceRecord より広い (keyLevel / sesame2PublicKey 等の生フィールド)。
 */
export type FullDeviceInfo = DeviceInfo & {
    keyLevel?: number;
    sesame2PublicKey?: string;
};
//# sourceMappingURL=device.d.ts.map