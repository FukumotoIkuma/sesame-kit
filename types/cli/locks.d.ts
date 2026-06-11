/**
 * `sesame locks …` グループを登録する (ロック定義の管理。操作はトップレベル動詞)。
 * @param {Program} program
 */
export function registerLocksCommands(program: Program): void;
export type Program = import("./ctx.js").Program;
export type CmdOpts = import("./ctx.js").CmdOpts;
export type CliError = import("./ctx.js").CliError;
/**
 * `locks add` のオプション袋。フラグ指定で非対話登録できる。
 */
export type LockAddOpts = {
    name?: string | undefined;
    uuid?: string | undefined;
    secret?: string | undefined;
    model?: string | undefined;
    alias?: string | undefined;
    fromUrl?: string | undefined;
};
//# sourceMappingURL=locks.d.ts.map