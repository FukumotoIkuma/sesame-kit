/**
 * 値を取るグローバルオプションの次トークンを読み飛ばし、本当の位置引数だけを返す。
 * 値オプション (.required/.optional) は commander の Option 定義から introspection するので
 * 将来オプションが増えても追従する。`--opt=value` 形式は値同梱なので後続を消費しない。
 * @param {string[]} userArgs argv.slice(2)
 * @param {import("commander").Command} program
 * @returns {string[]}
 */
export function extractPositionals(userArgs: string[], program: import("commander").Command): string[];
/**
 * program に登録済みの予約語 (コマンド名 + エイリアス + commander 既定の help)。
 * @param {import("commander").Command} program
 * @returns {Set<string>}
 */
export function reservedCommandNames(program: import("commander").Command): Set<string>;
/**
 * デバイス主語ルーティング。必要なら argv を隠し op コマンドへ書き換えて返す。
 *   - 引数なし + 対話 (非 --json) → 全デバイスの session。
 *   - 先頭が管理コマンドでない & (既知デバイス or 有効な device action 同伴) → op へ。
 *   - それ以外の単独トークンは据え置き → commander が未知コマンドを投げる (typo 誘導)。
 * @param {{argv:string[], program:import("commander").Command, deviceActions:Set<string>,
 *          isKnownDevice:(name:string)=>boolean, interactive:boolean}} ctx
 * @returns {string[]} 書き換え後の argv (変更不要ならそのまま)
 */
export function routeDeviceArgv({ argv, program, deviceActions, isKnownDevice, interactive }: {
    argv: string[];
    program: import("commander").Command;
    deviceActions: Set<string>;
    isKnownDevice: (name: string) => boolean;
    interactive: boolean;
}): string[];
//# sourceMappingURL=dispatch.d.ts.map