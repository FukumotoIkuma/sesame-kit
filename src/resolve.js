// 名前解決の単一実装 (P5-4 / ARCH-05)。
//
// 「明示 name → default 名 → 登録が 1 件だけならそれ」というフォールバック付きの
// name 解決は ConfigStore.resolveLock / ConfigStore.resolveRemote / LockManager.resolveLock /
// client.js の configStore 無しフォールバックの 4 箇所で重複実装されていた。
// ここに純関数 resolveByName として一本化し、エラーは SesameError(BAD_REQUEST) に統一する
// (ConfigStore 経路の plain Error が serve 層で kind=internal に潰れていた問題も解消。
// serve 経由では error.data.kind=bad_params に写像される)。

import { badRequest } from "./util.js";

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
export function resolveByName(map, name, defaultName, errFactory) {
  const entries = map || {};
  const names = Object.keys(entries);
  const chosen = name || defaultName || (names.length === 1 ? names[0] : null);
  if (!chosen) throw errFactory.noneSpecified(names);
  const entry = entries[chosen];
  if (!entry) throw errFactory.unknown(chosen, names);
  return { name: chosen, entry };
}

/** @param {string[]} names */
const list = (names) => names.join(", ") || "(none)";

/**
 * lock 解決用の標準 errFactory (domain.config.* キーが正準。
 * 旧 domain.client.unknownLock / noLockNoDefault は重複だったため削除済み — P5-4)。
 * @type {ResolveErrFactory<import("./config.js").LockView>}
 */
export const LOCK_RESOLVE_ERRORS = Object.freeze({
  noneSpecified: (names) => badRequest("domain.config.noLockNoDefault", { names: list(names) }),
  unknown: (name, names) => badRequest("domain.config.unknownLock", { name, names: list(names) }),
});

/**
 * remote 解決用の標準 errFactory (domain.config.* キーが正準)。
 * @type {ResolveErrFactory<import("./config.js").RemoteEntry>}
 */
export const REMOTE_RESOLVE_ERRORS = Object.freeze({
  noneSpecified: (names) => badRequest("domain.config.noRemoteNoDefault", { names: list(names) }),
  unknown: (name, names) => badRequest("domain.config.unknownRemote", { name, names: list(names) }),
});
