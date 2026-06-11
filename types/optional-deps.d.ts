/**
 * optional 依存を動的 import し、未導入時は導入手順 (hint) を含む明瞭なエラーへ変換する。
 *
 * @param {string} spec import 指定子 (例 "@grpc/grpc-js")
 * @param {string} hint 未導入時に投げるエラーメッセージ (i18n 済みの文字列を渡す)
 * @returns {Promise<any>} import() のモジュール名前空間 (CJS は .default に実体)
 * @throws {Error & {code: "ERR_OPTIONAL_DEP_MISSING", spec: string}} 未導入のとき
 */
export function importOptional(spec: string, hint: string): Promise<any>;
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
export function rethrowMissingOptional(e: unknown, specs: string[], hint: string): never;
//# sourceMappingURL=optional-deps.d.ts.map