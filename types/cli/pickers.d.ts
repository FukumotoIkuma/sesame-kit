/** @typedef {import("./ctx.js").Program} Program */
/** @typedef {import("../client.js").SesameHub3} SesameHub3 */
/** @typedef {import("../client.js").DeviceInfo} DeviceInfo */
/** @typedef {import("../config.js").ConfigStore} ConfigStore */
/**
 * 名前未指定 & 対話可能なら、設定済みリストから選択させる。
 * @param {Program} program
 * @param {ConfigStore} configStore
 * @param {string|undefined} current
 * @returns {Promise<string|null|undefined>}
 */
export function pickRemoteName(program: Program, configStore: ConfigStore, current: string | undefined): Promise<string | null | undefined>;
/**
 * @param {Program} program
 * @param {ConfigStore} configStore
 * @param {string|null|undefined} remoteName
 * @param {string|undefined} current
 * @returns {Promise<string|null|undefined>}
 */
export function pickRemoteKeyName(program: Program, configStore: ConfigStore, remoteName: string | null | undefined, current: string | undefined): Promise<string | null | undefined>;
/**
 * Hub から デバイス一覧を取って UUID を選ばせる (model フィルタ任意)。
 * @param {Program} program
 * @param {SesameHub3} hub
 * @param {string|undefined} current
 * @param {{ filter?: (d: DeviceInfo) => boolean, message?: string }} [opts]
 * @returns {Promise<string|undefined>}
 */
export function pickDeviceUUID(program: Program, hub: SesameHub3, current: string | undefined, { filter, message }?: {
    filter?: (d: DeviceInfo) => boolean;
    message?: string;
}): Promise<string | undefined>;
/**
 * sync 系の結果 (added/updated/removed) を整形出力。
 * @param {boolean} json
 * @param {string} kind
 * @param {{added?:string[], updated?:string[], removed?:string[]}} r
 */
export function printSyncResult(json: boolean, kind: string, r: {
    added?: string[];
    updated?: string[];
    removed?: string[];
}): void;
export type Program = import("./ctx.js").Program;
export type SesameHub3 = import("../client.js").SesameHub3;
export type DeviceInfo = import("../client.js").DeviceInfo;
export type ConfigStore = import("../config.js").ConfigStore;
//# sourceMappingURL=pickers.d.ts.map