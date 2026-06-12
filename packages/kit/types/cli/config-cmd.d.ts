/**
 * `sesame init` を登録する。help のコマンド順 = 登録順のため setup/migrate より前に呼ぶ。
 * @param {Program} program
 * @param {{ getLangFlag: () => import("@sesame-kit/core/i18n").Locale|null }} deps
 *   getLangFlag: 明示された --lang の解決済みロケール (cli.js run() が保持) を action 時に引く。
 */
export function registerInitCommand(program: Program, deps: {
    getLangFlag: () => import("@sesame-kit/core/i18n").Locale | null;
}): void;
/**
 * `sesame config` グループを登録する (サブコマンド省略時は show 相当)。
 * @param {Program} program
 */
export function registerConfigCommands(program: Program): void;
export type Program = import("./ctx.js").Program;
export type CmdOpts = import("./ctx.js").CmdOpts;
//# sourceMappingURL=config-cmd.d.ts.map