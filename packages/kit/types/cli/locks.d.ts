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
 * ssmPublicKey/keyIndex は OS2 デバイス用 (バックログ4: os2-register の戻り値を保存し、
 * os2-invoke が --ssm-public-key 無しで config から解決できるようにする)。
 * push: true のとき、ローカル config に登録後に個人アカウント鍵ストア REST API へ同期する
 * (P3-2。CHAPIClientBiz.kt:102-103 の putKey 相当。@experimental: 実機未検証 §9 V15)。
 */
export type LockAddOpts = {
    name?: string | undefined;
    uuid?: string | undefined;
    secret?: string | undefined;
    model?: string | undefined;
    alias?: string | undefined;
    fromUrl?: string | undefined;
    ssmPublicKey?: string | undefined;
    keyIndex?: string | undefined;
    push?: boolean | undefined;
};
//# sourceMappingURL=locks.d.ts.map