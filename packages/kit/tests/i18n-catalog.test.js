// P5-2: kit カタログ完全性テスト。
// kit 専用の cli/serve/session カタログを対象に
// (1) en/ja キー集合一致 (2) area 間キー重複ゼロ (3) {var} 一致
// (4) kit/src の t("...") リテラルが全てカタログに存在 を検証する。
//
// テスト環境: vitest.setup.js で kit カタログ登録済み (beforeEach 前に実行)。

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import cli from "../src/i18n/cli.js";
import serve from "../src/i18n/serve.js";
import session from "../src/i18n/session.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// kit が管理する catalog area 一覧
const KIT_AREAS = [
  { name: "cli.js", catalog: cli },
  { name: "serve.js", catalog: serve },
  { name: "session.js", catalog: session },
];

/** {var} プレースホルダを文字列から抽出する。
 * {word} 形式 (変数名: 英数字・アンダースコアのみ) のみを対象とし、
 * JSON 例示 ({key:"value"} など) は除外する。
 */
function extractPlaceholders(str) {
  return new Set((str.match(/\{[A-Za-z_][A-Za-z0-9_]*\}/g) || []));
}

/** Set の差分を返す */
function setDiff(a, b) {
  return new Set([...a].filter(x => !b.has(x)));
}

/** Set を配列に変換(ソート済み) */
function sorted(s) {
  return [...s].sort();
}

describe("kit i18n catalog completeness (P5-2)", () => {
  it("(1) 各 area で en と ja のキー集合が一致する", () => {
    const errors = [];
    for (const { name, catalog } of KIT_AREAS) {
      if (!catalog?.en || !catalog?.ja) continue;
      const enKeys = new Set(Object.keys(catalog.en));
      const jaKeys = new Set(Object.keys(catalog.ja));
      const onlyEn = setDiff(enKeys, jaKeys);
      const onlyJa = setDiff(jaKeys, enKeys);
      if (onlyEn.size > 0) errors.push(`${name}: en にのみ存在: ${sorted(onlyEn).join(", ")}`);
      if (onlyJa.size > 0) errors.push(`${name}: ja にのみ存在: ${sorted(onlyJa).join(", ")}`);
    }
    expect(errors, errors.join("\n")).toHaveLength(0);
  });

  it("(2) kit area 間でキーの重複がない", () => {
    const seen = new Map(); // key -> areaName
    const duplicates = [];
    for (const { name, catalog } of KIT_AREAS) {
      const keys = Object.keys(catalog?.en || {});
      for (const k of keys) {
        if (seen.has(k)) {
          duplicates.push(`"${k}" が ${seen.get(k)} と ${name} に重複`);
        } else {
          seen.set(k, name);
        }
      }
    }
    expect(duplicates, duplicates.join("\n")).toHaveLength(0);
  });

  it("(3) en と ja で {var} プレースホルダが一致する", () => {
    const errors = [];
    for (const { name, catalog } of KIT_AREAS) {
      if (!catalog?.en || !catalog?.ja) continue;
      for (const key of Object.keys(catalog.en)) {
        if (!catalog.ja[key]) continue;
        const enPH = extractPlaceholders(catalog.en[key]);
        const jaPH = extractPlaceholders(catalog.ja[key]);
        const onlyEn = setDiff(enPH, jaPH);
        const onlyJa = setDiff(jaPH, enPH);
        if (onlyEn.size > 0 || onlyJa.size > 0) {
          errors.push(
            `${name} "${key}": en=${[...enPH].join(",")} ja=${[...jaPH].join(",")}`
          );
        }
      }
    }
    expect(errors, errors.join("\n")).toHaveLength(0);
  });

  it("(4) kit/src の t(\"...\") リテラルが全て kit+core カタログに存在する", () => {
    // kit src の全 .js ファイルを文字列スキャン (serve/entries/ なども含む)
    const srcDirs = [
      join(__dirname, "../src"),
      join(__dirname, "../src/cli"),
      join(__dirname, "../src/serve"),
      join(__dirname, "../src/serve/framing"),
      join(__dirname, "../src/serve/entries"),
    ];
    const keyPattern = /\bt\("([a-z][a-zA-Z0-9._-]*\.[a-zA-Z0-9._-]*)"\)/g;
    const usedKeys = new Set();
    for (const dir of srcDirs) {
      let files;
      try { files = readdirSync(dir).filter(f => f.endsWith(".js")); }
      catch { continue; }
      for (const f of files) {
        const src = readFileSync(join(dir, f), "utf8");
        for (const m of src.matchAll(keyPattern)) usedKeys.add(m[1]);
      }
    }

    // kit catalog keys
    const kitCatalogKeys = new Set();
    for (const { catalog } of KIT_AREAS) {
      for (const k of Object.keys(catalog?.en || {})) kitCatalogKeys.add(k);
    }

    // core catalog keys (直接 src/i18n/ から読む)
    const coreI18nDir = join(__dirname, "../../core/src/i18n");
    const coreCatalogKeys = new Set();
    const coreFiles = readdirSync(coreI18nDir).filter(f => f.endsWith(".js"));
    for (const f of coreFiles) {
      // dynamic import は async なので JSON.stringify で key 抽出
      const src = readFileSync(join(coreI18nDir, f), "utf8");
      for (const m of src.matchAll(/"([a-z][a-zA-Z0-9._-]*\.[a-zA-Z0-9._-]*)"\s*:/g)) {
        coreCatalogKeys.add(m[1]);
      }
    }

    const allCatalogKeys = new Set([...kitCatalogKeys, ...coreCatalogKeys]);
    const missing = [...usedKeys].filter(k => !allCatalogKeys.has(k));
    expect(missing, `kit src の t() リテラルがカタログに無い: ${missing.join(", ")}`).toHaveLength(0);
  });
});
