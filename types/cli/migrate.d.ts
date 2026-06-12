/** @typedef {import("./ctx.js").Program} Program */
/** @typedef {import("./ctx.js").CmdOpts} CmdOpts */
/**
 * 旧構成 (.env / keys.json、認証状態は skip) からの移行サマリ。
 * @typedef {object} MigrateSummary
 * @property {string} configDir
 * @property {string[]} imported
 * @property {string[]} skipped
 * @property {string} [hub3Added]
 * @property {string} [remoteAdded]
 *
 * @param {string|undefined} srcDir
 * @param {CmdOpts} _opts
 * @param {Program} program
 */
export function cmdMigrate(srcDir: string | undefined, _opts: CmdOpts, program: Program): Promise<void>;
/**
 * .env の素朴なパーサ (KEY=value、コメント/クォート対応)。dotenv 依存を持たないための内製。
 * @param {string} content
 * @returns {Record<string, string>}
 */
export function parseDotenv(content: string): Record<string, string>;
export type Program = import("./ctx.js").Program;
export type CmdOpts = import("./ctx.js").CmdOpts;
/**
 * 旧構成 (.env / keys.json、認証状態は skip) からの移行サマリ。
 */
export type MigrateSummary = {
    configDir: string;
    imported: string[];
    skipped: string[];
    hub3Added?: string | undefined;
    remoteAdded?: string | undefined;
};
//# sourceMappingURL=migrate.d.ts.map