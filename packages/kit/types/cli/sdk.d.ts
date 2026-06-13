/**
 * `sesame sdk eject ts|py [--out <dir>]` の実体。
 * @param {"ts"|"py"} lang
 * @param {{ out?: string }} opts
 */
export function cmdSdkEject(lang: "ts" | "py", opts: {
    out?: string;
}): void;
/**
 * `sesame sdk` コマンドグループを program に登録する。
 * @param {import("./ctx.js").Program} program
 */
export function registerSdkCommands(program: import("./ctx.js").Program): void;
//# sourceMappingURL=sdk.d.ts.map