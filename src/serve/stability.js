// API 安定性 tier の単一ソース。詳細な根拠は docs/api-stability.md を参照。
//
// 設計: tier は provenance (出所/確信度) から *導出* する。これにより「内部で持つ確信度」と
// 「外部へ出す約束 (x-stability)」が乖離しない。下流 (SDK/自動化) が約束に張れるのは
// `stable` だけで、`experimental` は予告なく変わり得る。
//
// provenance 語彙 (正直に。過剰主張しない):
//   - "local":      vendor 依存なし (ローカル meta)。上流が無いので自明に安定。
//   - "app-core":   公式アプリで恒常的に load-bearing かつ biz3 から移植済み。高確信だが
//                   まだ上流コンフォーマンス・カナリア (roadmap v) で live 固定はしていない。
//   - "unverified": 形が未確認 (ソースの `未確認` 群)。experimental の既定。
//
// tier 導出: provenance が local/app-core のものだけ `stable`。それ以外は `experimental`。

// stable コア (= docs/api-stability.md の "Stable 1.0 surface")。値は provenance。
// export しているのは整合テスト用 (全キーが実レジストリ/イベントに実在することを保証し、
// typo/rename による無言の experimental 降格を防ぐ)。
export // 注: `rpc.discover` は daemon が特別扱いで直接処理し、レジストリ＝discover の methods 配列
// には現れない (注釈対象外)。OpenRPC 仕様の暗黙メタとして常に存在し implicit に stable なので
// ここには載せない (載せると整合ガードで「実在しない」と落ちる)。
const STABLE_METHODS = {
  "status": "local",
  "account.whoami": "app-core",
  "lock.lock": "app-core",
  "lock.unlock": "app-core",
  "lock.toggle": "app-core",
  "lock.click": "app-core",
  "lock.status": "app-core",
  "devices.list": "app-core",
  "device.history": "app-core",
  "device.battery": "app-core",
  "events.subscribe": "local",
  "events.unsubscribe": "local",
};

// サーバ発イベントの provenance。event.ready は daemon が全永続接続の確立時に一律発火する
// ローカルなライフサイクル通知 (vendor 非依存)。lockState/deviceUpdate は上流由来 (app-core)。
export const STABLE_EVENTS = {
  "event.lockState": "app-core",
  "event.deviceUpdate": "app-core",
  "event.ready": "local",
};

function has(map, name) {
  return Object.prototype.hasOwnProperty.call(map, name);
}

/** メソッド名 → "stable" | "experimental" (provenance から導出)。 */
export function stabilityOf(name) {
  return has(STABLE_METHODS, name) ? "stable" : "experimental";
}

/** メソッド名 → provenance 文字列。未登録は "unverified"。 */
export function provenanceOf(name) {
  return STABLE_METHODS[name] ?? "unverified";
}

/** イベント名 → "stable" | "experimental"。 */
export function eventStabilityOf(name) {
  return has(STABLE_EVENTS, name) ? "stable" : "experimental";
}

/** イベント名 → provenance。 */
export function eventProvenanceOf(name) {
  return STABLE_EVENTS[name] ?? "unverified";
}
