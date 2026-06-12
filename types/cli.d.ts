export function run(argv?: string[]): Promise<void>;
/**
 * commander の Command (全コマンドハンドラに渡る program)。
 */
export type Program = import("commander").Command;
export type GlobalOpts = import("./cli/ctx.js").GlobalOpts;
export type CmdOpts = import("./cli/ctx.js").CmdOpts;
/**
 * cli/ サブモジュールへ渡す共有コンテキスト (実体は src/cli/ctx.js)。
 * 既存 register モジュールが import("../cli.js").CliCtx で参照するため再公開する。
 */
export type CliCtx = import("./cli/ctx.js").CliCtx;
import { fmtCloudStatus } from "./cli/lock-ops.js";
import { sanitizeStatus } from "./cli/lock-ops.js";
import { redactConfig } from "./cli/ctx.js";
import { maybeHandleBleError } from "./cli/errors.js";
export { fmtCloudStatus, sanitizeStatus, redactConfig, maybeHandleBleError };
//# sourceMappingURL=cli.d.ts.map