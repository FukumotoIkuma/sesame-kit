/**
 * ディレクトリを所有者専用 (0700) で用意する (recursive)。
 * @param {string} dir
 * @returns {string} dir
 */
export function ensureSecureDir(dir: string): string;
/**
 * 秘匿ファイルをアトミック (temp→rename) かつ 0600 で書き込む。親ディレクトリは 0700 で用意。
 * アトミック書き込みにより、複数プロセス (serve デーモンと CLI) が同じファイルを
 * 同時更新しても半端な内容で壊れない (rename は POSIX で atomic)。
 * @param {string} path
 * @param {string} contents
 */
export function writeSecretFile(path: string, contents: string): void;
/**
 * オブジェクトを整形 JSON として秘匿ファイルに書き込む (writeSecretFile の薄いラッパ)。
 * @param {string} path
 * @param {*} obj
 */
export function writeSecretJson(path: string, obj: any): void;
/**
 * 既存ファイルのパーミッションを 0600 に締める (copyFileSync 後など、内容を書き換えずに
 * mode だけ直したいとき用)。非 POSIX 等で失敗しても致命でないため握りつぶす。
 * @param {string} path
 */
export function restrictSecretFile(path: string): void;
/**
 * `<path>.lock` による advisory lock の下で fn を実行する。
 * load-modify-save の系列をプロセス間で直列化したいとき (tokens.json 等) に使う。
 *
 * @template T
 * @param {string} path ロック対象 (実体ファイル)。lock は `<path>.lock` に作られる。
 * @param {() => T} fn ロック保持中に実行する処理。
 * @param {{ timeoutMs?: number, staleMs?: number, retryIntervalMs?: number }} [opts]
 *   テスト等で待ち時間を縮めるためのオーバーライド。
 * @returns {T} fn の戻り値。
 * @throws {Error} timeoutMs 以内にロックを取得できなかった場合。
 */
export function withFileLock<T>(path: string, fn: () => T, opts?: {
    timeoutMs?: number;
    staleMs?: number;
    retryIntervalMs?: number;
}): T;
/** 秘匿ファイルのパーミッション。鍵入りファイルは所有者のみ読み書き可。 */
export const SECRET_FILE_MODE: 384;
/** 設定ディレクトリのパーミッション。所有者のみアクセス可。 */
export const SECRET_DIR_MODE: 448;
//# sourceMappingURL=secure-fs.d.ts.map