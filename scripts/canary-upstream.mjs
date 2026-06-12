// 上流コンフォーマンス・カナリア。2 モード:
//   1. live  (既定 / opt-in)  : 保存済み資格情報で stable な read-only op を実クラウドに叩き、
//                               live 応答が stable 契約の形を満たすかを検証する (要 creds + ネット)。
//   2. replay (--replay / CI) : 記録済みの上流応答サンプル (tests/fixtures/upstream/*.json) を、
//                               live モードと **同一の** スキーマ (src/serve/result-schemas.js の
//                               RESULT_SCHEMAS) で検証する。creds もネットも不要なので CI で常時回せる。
//
// 二境界モデル (docs/api-stability.md): CI の drift gate は「我々のスキーマ ↔ 実装」しか守れない。
// 真の親である vendor (公式クラウド) が形を変えたことは、実クラウドに当てるか、過去に記録した実応答を
// 検証しないと分からない。replay は「記録済み実応答 ↔ 今のスキーマ」を突き合わせ、スキーマ側を
// 緩めて契約を壊すような drift を creds 無しで検出する (fixtures の更新は live 実行で行う)。
//
// 実行:
//   live   : node scripts/canary-upstream.mjs            (creds + ネットワークが要る。手動 or スケジュール)
//            設定ディレクトリは SESAME_KIT_HOME / XDG / 既定 (~/.config/sesame-kit)。副作用なし。
//   replay : node scripts/canary-upstream.mjs --replay   (オフライン。CI 既定)
//
// 終了コード: 0 = drift 無し / 1 = drift 検出 (または live のエラー) / 2 = 設定未存在 (live のみ)。
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { RESULT_SCHEMAS } from "../src/serve/result-schemas.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// fixtures は tests/fixtures/upstream/ に置く (記録済みの上流応答サンプル)。
const FIXTURES_DIR = join(__dirname, "..", "tests", "fixtures", "upstream");

const results = [];
const record = (name, ok, detail) => { results.push({ name, ok, detail }); };
const has = (o, k) => o != null && typeof o === "object" && o[k] !== undefined && o[k] !== null;

// --- 最小 JSON-Schema バリデータ ----------------------------------------------
// RESULT_SCHEMAS が使うサブセットだけを解釈する: type (object/array/string/number/boolean)、
// properties / required / items / nullable。ajv 等の依存を増やさず、live が見るのと同じ
// スキーマ表現をそのまま評価することで「live と replay で検証ロジックが二重化する」のを避ける。
// 戻り値: 違反パスの配列 (空 = 妥当)。
function validate(schema, value, path = "$") {
  if (!schema || typeof schema !== "object") return [];
  // nullable: 値が null でも許す (SDK の `| null` / `| None`)。
  if (value === null) {
    return schema.nullable ? [] : [`${path}: null は許可されていない (nullable でない)`];
  }
  if (value === undefined) return [`${path}: 値が undefined`];

  switch (schema.type) {
    case "object": {
      if (typeof value !== "object" || Array.isArray(value)) {
        return [`${path}: object を期待したが ${Array.isArray(value) ? "array" : typeof value}`];
      }
      const errors = [];
      for (const key of schema.required || []) {
        if (value[key] === undefined || value[key] === null) {
          errors.push(`${path}.${key}: required フィールドが欠落`);
        }
      }
      // properties は記述された分だけ検証 (additionalProperties は許容 = vendor が足す分は無視)。
      for (const [key, sub] of Object.entries(schema.properties || {})) {
        if (value[key] !== undefined) errors.push(...validate(sub, value[key], `${path}.${key}`));
      }
      return errors;
    }
    case "array": {
      if (!Array.isArray(value)) return [`${path}: array を期待したが ${typeof value}`];
      const errors = [];
      value.forEach((item, i) => {
        errors.push(...validate(schema.items, item, `${path}[${i}]`));
      });
      return errors;
    }
    case "string":
      return typeof value === "string" ? [] : [`${path}: string を期待したが ${typeof value}`];
    case "number":
      return typeof value === "number" ? [] : [`${path}: number を期待したが ${typeof value}`];
    case "boolean":
      return typeof value === "boolean" ? [] : [`${path}: boolean を期待したが ${typeof value}`];
    default:
      // type 未指定 (bare object 等、中身未確定) は何でも通す = SDK の unknown/Any 相当。
      return [];
  }
}

// --- オフライン replay モード --------------------------------------------------
// fixtures/*.json は { "method": "<RESULT_SCHEMAS のキー>", "sample": <記録済み応答> } 形式。
// 各 fixture を対応スキーマで検証し、違反があれば drift として記録する。
function runReplay() {
  let files;
  try {
    files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
  } catch (e) {
    console.error(`fixtures ディレクトリを読めない: ${FIXTURES_DIR} (${e.message})`);
    process.exit(1);
  }
  if (files.length === 0) {
    console.error(`fixtures が無い: ${FIXTURES_DIR} — 上流応答サンプルを記録すること。`);
    process.exit(1);
  }

  for (const file of files.sort()) {
    const full = join(FIXTURES_DIR, file);
    let fixture;
    try {
      fixture = JSON.parse(readFileSync(full, "utf8"));
    } catch (e) {
      record(`fixture:${file}`, false, `JSON parse 失敗: ${e.message}`);
      continue;
    }
    const method = fixture.method;
    const schema = RESULT_SCHEMAS[method];
    if (!schema) {
      record(`fixture:${file}`, false, `未知の method "${method}" (RESULT_SCHEMAS に無い)`);
      continue;
    }
    if (!("sample" in fixture)) {
      record(`fixture:${file}`, false, `"sample" フィールドが無い`);
      continue;
    }
    const errors = validate(schema, fixture.sample);
    record(
      `${method} (${file})`,
      errors.length === 0,
      errors.length === 0 ? "schema-valid" : errors.slice(0, 4).join(" | "),
    );
  }
  finish("offline fixtures", "記録済み上流応答");
}

// --- live モード --------------------------------------------------------------
async function runLive() {
  const { SesameHub3, ConfigStore, FileTokenStore, resolveConfigDir } = await import("../src/index.js");
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
  finish("live cloud", "vendor");
}

// --- 共通レポート -------------------------------------------------------------
function finish(against, source) {
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? "PASS" : "DRIFT"}  ${r.name}  (${r.detail})`);
  console.log(`\n${results.length - failed.length}/${results.length} stable contract checks passed against ${against}.`);
  if (failed.length) {
    console.error(`\n❌ ${failed.length} upstream drift(s) — ${source} response shape no longer matches the stable contract.`);
    process.exit(1);
  }
  console.log("✅ no upstream drift detected.");
}

const replay = process.argv.includes("--replay");
if (replay) {
  runReplay();
} else {
  runLive().catch((e) => { console.error("canary error:", e?.message || e); process.exit(1); });
}
