// run() の「デバイス主語ルーティング」を切り出した横断モジュール。
//
//   `sesame <device> [action]` を隠し op コマンドへ振り分ける argv 書き換えと、
//   値オプション (--config-dir <path> 等) の **値** をデバイス名と誤認しない位置引数抽出。
//
// 巨大な run() に直書きされていた配線ロジックをここへ分離する (挙動は不変。回帰は
// tests/cli/arg-router.test.js が実バイナリで担保)。

/**
 * 値を取るグローバルオプションの次トークンを読み飛ばし、本当の位置引数だけを返す。
 * 値オプション (.required/.optional) は commander の Option 定義から introspection するので
 * 将来オプションが増えても追従する。`--opt=value` 形式は値同梱なので後続を消費しない。
 * @param {string[]} userArgs argv.slice(2)
 * @param {import("commander").Command} program
 * @returns {string[]}
 */
export function extractPositionals(userArgs, program) {
  const valueOpts = new Map(); // 正準名(--long)・短縮(-x) 両方を引く
  for (const o of program.options) {
    const takesValue = o.required || o.optional;
    if (o.long) valueOpts.set(o.long, takesValue);
    if (o.short) valueOpts.set(o.short, takesValue);
  }
  const positionals = [];
  for (let i = 0; i < userArgs.length; i++) {
    const a = userArgs[i];
    if (a === "--") { positionals.push(...userArgs.slice(i + 1)); break; }
    if (a.startsWith("-") && a !== "-") {
      const eq = a.indexOf("=");
      const flag = eq === -1 ? a : a.slice(0, eq);
      if (eq === -1 && valueOpts.get(flag) === true) i++; // 別トークンの値を飛ばす
      continue;
    }
    positionals.push(a);
  }
  return positionals;
}

/**
 * program に登録済みの予約語 (コマンド名 + エイリアス + commander 既定の help)。
 * @param {import("commander").Command} program
 * @returns {Set<string>}
 */
export function reservedCommandNames(program) {
  const reserved = new Set();
  // commander 既定の help コマンド/フラグは program.commands に現れないため明示予約
  // (これがないと `sesame help <cmd>` が op に誤誘導される)。
  reserved.add("help");
  for (const c of program.commands) {
    reserved.add(c.name());
    for (const a of c.aliases()) reserved.add(a);
  }
  return reserved;
}

/**
 * デバイス主語ルーティング。必要なら argv を隠し op コマンドへ書き換えて返す。
 *   - 引数なし + 対話 (非 --json) → 全デバイスの session。
 *   - 先頭が管理コマンドでない & (既知デバイス or 有効な device action 同伴) → op へ。
 *   - それ以外の単独トークンは据え置き → commander が未知コマンドを投げる (typo 誘導)。
 * @param {{argv:string[], program:import("commander").Command, deviceActions:Set<string>,
 *          isKnownDevice:(name:string)=>boolean, interactive:boolean}} ctx
 * @returns {string[]} 書き換え後の argv (変更不要ならそのまま)
 */
export function routeDeviceArgv({ argv, program, deviceActions, isKnownDevice, interactive }) {
  const userArgs = argv.slice(2);
  if (userArgs.some((a) => a === "-h" || a === "--help")) return argv;
  const isJson = userArgs.includes("--json");

  const positionals = extractPositionals(userArgs, program);
  const firstTok = positionals[0];
  const secondTok = positionals[1];
  const reserved = reservedCommandNames(program);

  if (!firstTok) {
    // 引数なし: 既定はデバイス主語の対話 (全デバイス session)。非対話/JSON は help を出す。
    if (!isJson && interactive) return [argv[0], argv[1], "session"];
    return argv;
  }
  if (!reserved.has(firstTok)) {
    // 先頭が管理コマンドでない場合のみ判定。既知デバイス or 有効な device action 同伴のみ op へ。
    // どちらでもない単独トークンは誤入力 → 据え置き → 未知コマンド (+ 候補提示)。
    const hasDeviceAction = secondTok != null && deviceActions.has(secondTok);
    if (hasDeviceAction || isKnownDevice(firstTok)) {
      return [argv[0], argv[1], "op", ...userArgs];
    }
  }
  return argv;
}
