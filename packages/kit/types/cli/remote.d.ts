/**
 * `sesame send/list/ping` を登録する。
 * help のコマンド順 = 登録順のため、login 系の直後 (devices より前) に呼ぶ。
 * @param {Program} program
 */
export function registerSendCommands(program: Program): void;
/**
 * `sesame remote …` / `sesame hub3 …` グループを登録する (config 管理)。
 * @param {Program} program
 */
export function registerRemoteCommands(program: Program): void;
export type Program = import("./ctx.js").Program;
export type CmdOpts = import("./ctx.js").CmdOpts;
export type ConfigStore = import("@sesame-kit/core/config").ConfigStore;
/**
 * --remote <name> を取る系のオプション袋。
 */
export type RemoteOpts = {
    remote?: string | null;
};
//# sourceMappingURL=remote.d.ts.map