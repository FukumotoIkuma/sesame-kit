// 上流コンフォーマンス・カナリア (opt-in / NOT CI)。
//
// 二境界モデル (docs/api-stability.md): CI の drift gate は「我々のスキーマ ↔ 実装」しか守れない。
// 真の親である vendor (公式クラウド) が形を変えたことは、実クラウドに当てないと分からない。
// このスクリプトは保存済み資格情報で stable な **read-only** op を実際に叩き、stable 契約の
// フィールドが live 応答に存在するかを検証する。欠落 = vendor drift → exit 1。
//
// 実行 (creds + ネットワークが要る。手動 or スケジュール): node scripts/canary-upstream.mjs
//   設定ディレクトリは SESAME_KIT_HOME / XDG / 既定 (~/.config/sesame-kit)。
// 副作用なし (lock 等の書き込み op は叩かない)。
import { SesameHub3, ConfigStore, FileTokenStore, resolveConfigDir } from "../src/index.js";

const results = [];
const record = (name, ok, detail) => { results.push({ name, ok, detail }); };
const has = (o, k) => o != null && typeof o === "object" && o[k] !== undefined && o[k] !== null;

async function main() {
  const dir = resolveConfigDir();
  const configStore = ConfigStore.fromConfigDir(dir);
  if (!configStore.exists()) {
    console.error(`no config at ${dir} — run \`sesame login\` first.`);
    process.exit(2);
  }
  const hub = new SesameHub3({ config: configStore.load(), configStore, tokenStore: FileTokenStore.fromConfigDir(dir) });
  await hub.connect();
  try {
    // status: connected + subUUID
    record("status.connected", hub.connected === true, `connected=${hub.connected}`);
    record("status.subUUID", typeof hub.subUUID === "string" && hub.subUUID.length > 0, `subUUID=${hub.subUUID ? "set" : "missing"}`);

    // account.whoami: customerInfo
    try {
      const who = await hub.getLoginUser();
      record("account.whoami.customerInfo", has(who, "customerInfo"), `keys=${who ? Object.keys(who).join(",") : "none"}`);
    } catch (e) { record("account.whoami", false, `threw: ${e.message}`); }

    // devices.list: array of {deviceUUID}
    let firstUUID = null;
    try {
      const devs = await hub.listDevices();
      const ok = Array.isArray(devs) && (devs.length === 0 || has(devs[0], "deviceUUID"));
      firstUUID = devs?.[0]?.deviceUUID || null;
      record("devices.list[].deviceUUID", ok, `n=${Array.isArray(devs) ? devs.length : "not-array"}`);
    } catch (e) { record("devices.list", false, `threw: ${e.message}`); }

    // device.status: non-null object for a real device
    if (firstUUID) {
      try {
        const st = await hub.getDeviceStatus(firstUUID);
        record("device.status", st != null && typeof st === "object", `keys=${st ? Object.keys(st).slice(0, 6).join(",") : "none"}`);
      } catch (e) { record("device.status", false, `threw: ${e.message}`); }
    } else {
      record("device.status", true, "skipped (no devices)");
    }
  } finally {
    await hub.close();
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "DRIFT"}  ${r.name}  (${r.detail})`);
  console.log(`\n${results.length - failed.length}/${results.length} stable contract checks passed against live cloud.`);
  if (failed.length) { console.error(`\n❌ ${failed.length} upstream drift(s) — vendor response shape changed for stable methods.`); process.exit(1); }
  console.log("✅ no upstream drift detected.");
}

main().catch((e) => { console.error("canary error:", e?.message || e); process.exit(1); });
