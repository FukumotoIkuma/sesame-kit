/**
 * resolveByName の errFactory。失敗系 2 種の Error を生成する。
 * @template T
 * @typedef {Object} ResolveErrFactory
 * @property {(names: string[]) => Error} noneSpecified 名前未指定かつ default も単一フォールバックも無い
 * @property {(name: string, names: string[]) => Error} unknown 指定名が map に存在しない
 */
/**
 * map から name 解決する純関数。解決順: 明示 name → defaultName → 登録が 1 件だけならそれ。
 *
 * @template T
 * @param {Record<string, T>|null|undefined} map        名前 → エントリ
 * @param {string|null|undefined} name                  明示指定 (省略可)
 * @param {string|null|undefined} defaultName           default 指定 (省略可)
 * @param {ResolveErrFactory<T>} errFactory             失敗時に投げる Error の生成器
 * @returns {{name: string, entry: T}}
 * @throws errFactory が生成した Error (本リポジトリでは SesameError(BAD_REQUEST))
 */
export function resolveByName<T>(map: Record<string, T> | null | undefined, name: string | null | undefined, defaultName: string | null | undefined, errFactory: ResolveErrFactory<T>): {
    name: string;
    entry: T;
};
/**
 * lock 解決用の標準 errFactory (domain.config.* キーが正準。
 * 旧 domain.client.unknownLock / noLockNoDefault は重複だったため削除済み — P5-4)。
 * @type {ResolveErrFactory<import("./config.js").LockView>}
 */
export const LOCK_RESOLVE_ERRORS: ResolveErrFactory<import("./config.js").LockView>;
/**
 * remote 解決用の標準 errFactory (domain.config.* キーが正準)。
 * @type {ResolveErrFactory<import("./config.js").RemoteEntry>}
 */
export const REMOTE_RESOLVE_ERRORS: ResolveErrFactory<import("./config.js").RemoteEntry>;
/**
 * resolveByName の errFactory。失敗系 2 種の Error を生成する。
 */
export type ResolveErrFactory<T> = {
    /**
     * 名前未指定かつ default も単一フォールバックも無い
     */
    noneSpecified: (names: string[]) => Error;
    /**
     * 指定名が map に存在しない
     */
    unknown: (name: string, names: string[]) => Error;
};
//# sourceMappingURL=resolve.d.ts.map