// I18N-0019, I18N-0020: i18n 境界契約テスト
//
// I18N-0019: production の AREAS 配列と src/i18n/*.js ディレクトリの整合
//   production の i18n.js は hardcoded AREAS 配列で静的マージするが、
//   catalog-completeness test の loadCoreAreas() は readdirSync で動的ロードする。
//   両者が cross-check されていないため、新 area ファイルを追加して AREAS への
//   import を忘れると production CATALOG がそのキーを黙って欠落させる一方、
//   test は dir-scan で当該 area を被覆済みと判定し pass する。
//   → このテストは両者を突合し contract を固定する。
//
// I18N-0020: t(key, {vars}) call-site vars ↔ catalog {var} プレースホルダ整合
//   補間機構 (i18n.js:89 split/join) は未充足プレースホルダを生 {var} のまま残す。
//   既存テストは en↔ja のプレースホルダ一致のみ検査し、呼び出し側が実際に渡す
//   vars との突合は一切しない。
//   → このテストは lock-ops.js の call-site vars と cli catalog のプレースホルダを突合する。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── パス定数 ───────────────────────────────────────────────────────────────
// __dirname = packages/kit/tests/_spec
// → packages/core は 3 階層上から見た ../../../core
// → packages/kit/src は 2 階層上から見た ../../src
const CORE_I18N_JS  = join(__dirname, "../../../core/src/i18n.js");
const CORE_I18N_DIR = join(__dirname, "../../../core/src/i18n");
const LOCK_OPS_JS   = join(__dirname, "../../src/cli/lock-ops.js");
const KIT_CLI_I18N  = join(__dirname, "../../src/i18n/cli.js");

// ─── 共通ユーティリティ ─────────────────────────────────────────────────────

/**
 * {var} 形式のプレースホルダを文字列から抽出する (Set<"{name}"> 形式で返す)。
 * B 実装と同じ: 中括弧を含んだまま返すため、呼び出し側で .slice(1,-1) が必要。
 */
function extractPlaceholders(str) {
  return new Set((str.match(/\{[A-Za-z_][A-Za-z0-9_]*\}/g) || []));
}

// ─── I18N-0019 専用パーサ ────────────────────────────────────────────────────

/**
 * i18n.js ソースから `import <ident> from "./i18n/<file>.js"` を全て抽出し
 * ファイル名 (例: "org.js") → import 変数名 のマップを返す。
 */
function parseI18nImportMap(src) {
  const re = /^import\s+(\w+)\s+from\s+"\.\/i18n\/([^"]+\.js)";/gm;
  const map = new Map();
  for (const m of src.matchAll(re)) {
    map.set(m[2], m[1]); // "org.js" -> "org"
  }
  return map;
}

/**
 * i18n.js ソースから AREAS 配列の変数名 Set を抽出する。
 * `const AREAS = [org, access, iot, ...];` の形を期待する。
 */
function parseAreasIdentSet(src) {
  const m = src.match(/^const AREAS\s*=\s*\[([^\]]+)\];/m);
  if (!m) return new Set();
  return new Set(
    m[1].split(",").map((s) => s.trim()).filter(Boolean)
  );
}

// ─── I18N-0020 専用パーサ ────────────────────────────────────────────────────

/**
 * lock-ops.js ソースから t("key", { var1, var2: expr, ... }) の call-site を
 * 全て抽出する。バランスブレース追跡でネストした t() 呼び出しにも対応。
 * 返り値: Array<{ key: string, varNames: Set<string> }>
 */
function parseTCallsWithVars(src) {
  const results = [];
  // キーが "domain.sub" 形式 (最低1ドット) を要求 — B 実装の正確なパターン
  const startRe = /\bt\("([a-z][a-zA-Z0-9._-]*\.[a-zA-Z0-9._-]*)"\s*,\s*\{/g;
  let m;
  while ((m = startRe.exec(src)) !== null) {
    const key = m[1];
    let depth = 1;
    let i = m.index + m[0].length;
    let body = "";
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      if (depth > 0) body += ch;
      i++;
    }
    const propNames = new Set();
    // Match property names before ":", ",", "}" or end-of-body (handles shorthand `{ op }`).
    const propRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*(?:[:,}]|$)/gm;
    let pm;
    while ((pm = propRe.exec(body)) !== null) {
      const name = pm[1];
      if (
        !["true", "false", "null", "undefined", "return",
          "const", "let", "var", "if", "else",
          "Number", "String", "t", "join"].includes(name)
      ) {
        propNames.add(name);
      }
    }
    results.push({ key, varNames: propNames });
  }
  return results;
}

// ─── I18N-0019: AREAS 配列 vs src/i18n/*.js ディレクトリ整合 ─────────────────

describe("[I18N-0019] production AREAS array vs src/i18n/*.js directory consistency", () => {
  const i18nSrc = readFileSync(CORE_I18N_JS, "utf8");

  it("[I18N-0019] every src/i18n/*.js file is imported AND listed in AREAS", () => {
    const importMap   = parseI18nImportMap(i18nSrc);  // "org.js" -> "org"
    const areasIdents = parseAreasIdentSet(i18nSrc);  // Set { "org", "access", ... }

    const diskFiles = new Set(
      readdirSync(CORE_I18N_DIR).filter((f) => f.endsWith(".js"))
    );

    // ident -> file name (逆引き用)
    const identToFile = new Map(
      [...importMap.entries()].map(([file, ident]) => [ident, file])
    );

    // AREAS に登録されているファイル名 Set
    const areasFiles = new Set();
    for (const ident of areasIdents) {
      const file = identToFile.get(ident);
      if (file) areasFiles.add(file);
    }

    const errors = [];

    // (1) disk にあるが import されていないファイル
    for (const file of [...diskFiles].sort()) {
      if (!importMap.has(file)) {
        errors.push(`orphan file: src/i18n/${file} は i18n.js に import されていない`);
      }
    }

    // (2) import されているが AREAS に含まれていないファイル
    for (const file of [...diskFiles].sort()) {
      if (importMap.has(file) && !areasFiles.has(file)) {
        const varName = importMap.get(file);
        errors.push(
          `orphan import: src/i18n/${file} は import されているが AREAS 配列に含まれていない (変数: ${varName})`
        );
      }
    }

    // (3) AREAS に登録されているが対応ファイルが存在しないエントリ
    for (const ident of areasIdents) {
      const file = identToFile.get(ident);
      if (!file) {
        errors.push(`phantom AREAS entry: AREAS に変数 "${ident}" があるが対応する import 文が無い`);
      } else if (!diskFiles.has(file)) {
        errors.push(`phantom import: src/i18n/${file} は AREAS に登録されているがファイルが存在しない`);
      }
    }

    expect(
      errors,
      ["i18n.js の AREAS 配列と src/i18n/ ディレクトリに不整合があります:", ...errors].join("\n")
    ).toHaveLength(0);
  });

  it("[I18N-0019] AREAS array length equals src/i18n/*.js file count", () => {
    const diskCount  = readdirSync(CORE_I18N_DIR).filter((f) => f.endsWith(".js")).length;
    const areasCount = parseAreasIdentSet(i18nSrc).size;

    expect(
      areasCount,
      `AREAS 要素数 (${areasCount}) と src/i18n/ ファイル数 (${diskCount}) が異なります。`
    ).toBe(diskCount);
  });
});

// ─── I18N-0020: call-site vars ↔ catalog {var} placeholder 整合 ───────────────

describe("[I18N-0020] t(key, {vars}) call-site vars ↔ catalog {var} placeholder parity (lock-ops.js)", () => {
  it("[I18N-0020] call-site vars cover all catalog placeholders (no raw-token leaks)", async () => {
    const cliMod    = await import(KIT_CLI_I18N);
    const cliCatalog = cliMod.default; // { en: {...}, ja: {...} }

    const lockOpsSrc = readFileSync(LOCK_OPS_JS, "utf8");
    const callSites  = parseTCallsWithVars(lockOpsSrc);

    const leaks = [];
    for (const { key, varNames } of callSites) {
      const enTemplate = cliCatalog?.en?.[key];
      if (!enTemplate) continue; // cli catalog 外のキーは別テストが検出

      const catalogPlaceholders = extractPlaceholders(enTemplate);
      // "{name}" → "name" へ変換して突合
      for (const ph of catalogPlaceholders) {
        const varName = ph.slice(1, -1);
        if (!varNames.has(varName)) {
          leaks.push(
            `lock-ops.js t("${key}", {...}): catalog placeholder ${ph} not supplied by call-site vars [${[...varNames].join(", ")}] → raw token will leak in output`
          );
        }
      }
    }

    expect(
      leaks,
      `Raw-token leaks detected (call-site missing vars that catalog needs):\n${leaks.join("\n")}`
    ).toHaveLength(0);
  });

  it("[I18N-0020] t() interpolation leaves raw token when var is missing (behaviour verification)", async () => {
    // 補間機構 (i18n.js:89 split/join) が未充足プレースホルダを生 {var} のまま残すことを確認。
    const { t, setLocale, registerCatalog } = await import(CORE_I18N_JS);

    const scratchKey = `__i18n0020_scratch_${Date.now()}`;
    registerCatalog("__i18n0020_test__", {
      en: { [scratchKey]: "hello {name} and {other}" },
      ja: { [scratchKey]: "こんにちは {name} と {other}" },
    });

    setLocale("en");
    const resultEn = t(scratchKey, { name: "world" }); // {other} 未供給
    expect(resultEn).toBe("hello world and {other}"); // 生トークン漏れ — spec 正しい挙動

    setLocale("ja");
    const resultJa = t(scratchKey, { name: "テスト" }); // {other} 未供給
    expect(resultJa).toBe("こんにちは テスト と {other}"); // 日本語でも生トークン漏れ
  });

  it("[I18N-0020] key cli.lockNotFound call-site provides {name} and {names} (lock-ops.js:61)", async () => {
    const cliMod   = await import(KIT_CLI_I18N);
    const catalog  = cliMod.default;
    const template = catalog.en["cli.lockNotFound"];
    expect(template).toBeDefined();

    const needed       = extractPlaceholders(template);
    const callSiteVars = new Set(["name", "names"]);
    const missing      = [...needed].filter((p) => !callSiteVars.has(p.slice(1, -1)));
    expect(
      missing,
      `cli.lockNotFound: catalog placeholder(s) not supplied by call-site: ${missing.join(", ")}`
    ).toHaveLength(0);
  });

  it("[I18N-0020] key cli.okOp call-site provides {op}, {extra}, {name} (lock-ops.js:163)", async () => {
    const cliMod   = await import(KIT_CLI_I18N);
    const catalog  = cliMod.default;
    const template = catalog.en["cli.okOp"];
    expect(template).toBeDefined();

    const needed       = extractPlaceholders(template);
    const callSiteVars = new Set(["op", "extra", "name"]);
    const missing      = [...needed].filter((p) => !callSiteVars.has(p.slice(1, -1)));
    expect(
      missing,
      `cli.okOp: catalog placeholder(s) not supplied by call-site: ${missing.join(", ")}`
    ).toHaveLength(0);
  });

  it("[I18N-0020] key cli.modelNotSupportOp call-site provides {label}, {model}, {op}, {ops} (lock-ops.js:301)", async () => {
    const cliMod   = await import(KIT_CLI_I18N);
    const catalog  = cliMod.default;
    const template = catalog.en["cli.modelNotSupportOp"];
    expect(template).toBeDefined();

    const needed       = extractPlaceholders(template);
    const callSiteVars = new Set(["label", "model", "op", "ops"]);
    const missing      = [...needed].filter((p) => !callSiteVars.has(p.slice(1, -1)));
    expect(
      missing,
      `cli.modelNotSupportOp: catalog placeholder(s) not supplied by call-site: ${missing.join(", ")}`
    ).toHaveLength(0);
  });

  it("[I18N-0020] key cli.unknownAction call-site provides {action}, {actions}, {device} (lock-ops.js:269)", async () => {
    const cliMod   = await import(KIT_CLI_I18N);
    const catalog  = cliMod.default;
    const template = catalog.en["cli.unknownAction"];
    expect(template).toBeDefined();

    const needed       = extractPlaceholders(template);
    const callSiteVars = new Set(["action", "actions", "device"]);
    const missing      = [...needed].filter((p) => !callSiteVars.has(p.slice(1, -1)));
    expect(
      missing,
      `cli.unknownAction: catalog placeholder(s) not supplied by call-site: ${missing.join(", ")}`
    ).toHaveLength(0);
  });
});
