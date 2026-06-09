/**
 * @param {import("commander").Command} program
 * @param {import("../cli.js").CliCtx} ctx cli.js makeCtx() が供給する共有コンテキスト
 */
export function registerAccessCommands(program: import("commander").Command, ctx: import("../cli.js").CliCtx): void;
/**
 * getCards の items 要素 (lib access.js:144 の集約結果)。表示で読むフィールドのみ宣言。
 */
export type CardItem = {
    cardID?: string | undefined;
    name?: string | undefined;
    cardType?: string | number | undefined;
    /**
     * 該当 deviceUUID 群 (idKey 集約で付与)
     */
    uuids?: string[] | undefined;
};
/**
 * getPasscodes の items 要素 (lib access.js:165 の集約結果)。表示で読むフィールドのみ宣言。
 */
export type PasscodeItem = {
    passwordID?: string | undefined;
    name?: string | undefined;
    /**
     * 該当 deviceUUID 群 (idKey 集約で付与)
     */
    uuids?: string[] | undefined;
};
/**
 * getCards / getPasscodes の戻り (lib access.js:68,143,164)。namespace getter は
 * これを unknown に erase するため CLI 側で cast に使う。
 */
export type AccessListResult<T> = {
    items: T[];
    byDevice: Record<string, object[]>;
};
//# sourceMappingURL=access.d.ts.map