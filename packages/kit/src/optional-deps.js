// optional peerDependencies の遅延 import ヘルパー。
//
// ★動機: `@sesame-kit/core` ライブラリ利用者に CLI/TUI/serve 専用の重い依存
//   (@grpc/grpc-js, @grpc/proto-loader, ink, react, ...) を強制しないため、これらを
//   sesame-kit (CLI/serve パッケージ) の optional な peerDependencies に降格し、
//   利用箇所でのみ動的 import する。
//   未導入環境では「何を npm i すれば良いか」を明示するエラーに変換する
//   (黙った ERR_MODULE_NOT_FOUND は利用者に原因究明を強いるため)。
//
// 利用箇所: packages/kit/src/serve/framing/grpc.js (--grpc)、
//   packages/kit/src/cli/session.js (session-ui 遅延 import)。
//   session UI (ink/react 等) の配線は cli/session.js で rethrowMissingOptional を
//   catch に足す形で実装済み。

/**
 * モジュール解決失敗 (= 未インストール) かどうかの判定。
 * 対象パッケージ自身の解決失敗のみを「未導入」と見なし、対象パッケージ内部の別モジュールの
 * 解決失敗 (壊れた install) や構文エラー等はそのまま rethrow させる (原因の握りつぶし防止)。
 * @param {unknown} e import が投げたエラー
 * @param {string} spec import 指定子 (例 "@grpc/grpc-js")
 * @returns {boolean}
 */
function isModuleNotFound(e, spec) {
  const err = /** @type {{ code?: unknown, message?: unknown }} */ (e);
  const code = String(err?.code ?? "");
  if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") return false;
  return String(err?.message ?? "").includes(spec);
}

/**
 * optional 依存を動的 import し、未導入時は導入手順 (hint) を含む明瞭なエラーへ変換する。
 *
 * @param {string} spec import 指定子 (例 "@grpc/grpc-js")
 * @param {string} hint 未導入時に投げるエラーメッセージ (i18n 済みの文字列を渡す)
 * @returns {Promise<any>} import() のモジュール名前空間 (CJS は .default に実体)
 * @throws {Error & {code: "ERR_OPTIONAL_DEP_MISSING", spec: string}} 未導入のとき
 */
export async function importOptional(spec, hint) {
  try {
    return await import(spec);
  } catch (e) {
    rethrowMissingOptional(e, [spec], hint);
    throw e; // 到達しない (rethrowMissingOptional は必ず throw) が、型/静的解析のため明示
  }
}

/**
 * 動的 import の catch 節用ヘルパー。e が specs のいずれかの「未導入」エラーなら hint 付きの
 * 明瞭なエラーに変換して throw し、無関係なエラーはそのまま rethrow する。
 *
 * importOptional と違い「import したモジュール自身は同梱だが、その内部 import (ink/react 等の
 * optional peer) が未導入」というケースに使う。例: cli.js の session-ui 遅延 import
 * (`await import("./session-ui.js")`) の catch に
 *   `catch (e) { rethrowMissingOptional(e, ["ink", "react", "ink-select-input", "ink-text-input"], hint); }`
 * を 1 行足すだけで「npm i ink react ... で sesame session が使える」案内になる。
 *
 * @param {unknown} e catch したエラー
 * @param {string[]} specs 未導入とみなす import 指定子の候補
 * @param {string} hint 未導入時に投げるエラーメッセージ (i18n 済みの文字列を渡す)
 * @returns {never} 必ず throw する
 * @throws {Error & {code: "ERR_OPTIONAL_DEP_MISSING", spec: string}} 未導入のとき
 */
export function rethrowMissingOptional(e, specs, hint) {
  for (const spec of specs) {
    if (isModuleNotFound(e, spec)) {
      const err = /** @type {Error & {code: string, spec: string}} */ (new Error(hint));
      err.code = "ERR_OPTIONAL_DEP_MISSING";
      err.spec = spec;
      throw err;
    }
  }
  throw e;
}
