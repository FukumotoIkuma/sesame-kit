// i18n spec テスト統合版: I18N-0001 〜 I18N-0018
// 対象: packages/core/src/i18n.js, packages/core/src/i18n/*, packages/kit/src/i18n/*
// 実行環境: vitest (unit project) — KIT_SETUP により kit カタログ登録済み
//
// 方針: 各 it は [ID] タグを先頭に置き、spec の assert を独立して検証する。
// 実装が spec と食い違う箇所は spec どおりの期待値で assert する (TDD: red は許容)。
// A/B 両実装を統合し、より移植元忠実で網羅的な側を採用。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  t,
  setLocale,
  getLocale,
  resolveLocale,
  isKnownLang,
  registerCatalog,
} from "@sesame-kit/core/i18n";

// kit catalog area modules
// _spec/ → tests/ → kit/ → packages/ = ../../.. から src/i18n/ を参照
import cliCatalog from "../../src/i18n/cli.js";
import serveCatalog from "../../src/i18n/serve.js";
import sessionCatalog from "../../src/i18n/session.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── ヘルパー ──────────────────────────────────────────────────────────────────

/** {var} プレースホルダを文字列から抽出する ({word} 形式のみ) */
function extractPlaceholders(str) {
  return new Set((str.match(/\{[A-Za-z_][A-Za-z0-9_]*\}/g) || []));
}

function setDiff(a, b) {
  return new Set([...a].filter((x) => !b.has(x)));
}

function sorted(s) {
  return [...s].sort();
}

// ─── フィクスチャ ──────────────────────────────────────────────────────────────

/** core の i18n/<area>.js を全て動的ロードして返す */
async function loadCoreAreas() {
  const i18nDir = join(__dirname, "../../../core/src/i18n");
  const files = readdirSync(i18nDir)
    .filter((f) => f.endsWith(".js"))
    .sort();
  const areas = [];
  for (const f of files) {
    const mod = await import(join(i18nDir, f));
    areas.push({ name: f, catalog: mod.default });
  }
  return areas;
}

/** kit が管理する catalog area 一覧 */
const KIT_AREAS = [
  { name: "cli.js", catalog: cliCatalog },
  { name: "serve.js", catalog: serveCatalog },
  { name: "session.js", catalog: sessionCatalog },
];

const CORE_I18N_DIR = join(__dirname, "../../../core/src/i18n");

/** kit catalog の全 en キーセット (静的) */
function kitCatalogKeys() {
  const keys = new Set();
  for (const { catalog } of KIT_AREAS) {
    for (const k of Object.keys(catalog?.en || {})) keys.add(k);
  }
  return keys;
}

/** core catalog の全 en キーセット (ファイル静的スキャン) */
function coreCatalogKeysFromFiles() {
  const keys = new Set();
  const files = readdirSync(CORE_I18N_DIR).filter((f) => f.endsWith(".js"));
  for (const f of files) {
    const src = readFileSync(join(CORE_I18N_DIR, f), "utf8");
    for (const m of src.matchAll(
      /"([a-z][a-zA-Z0-9._-]*\.[a-zA-Z0-9._-]*)"\s*:/g
    )) {
      keys.add(m[1]);
    }
  }
  return keys;
}

// ─── ロケールリセット ──────────────────────────────────────────────────────────
// setup.i18n.js が beforeEach で ja を設定するので、各テスト後に en へ戻す。

afterEach(() => setLocale("en"));

// =============================================================================
// I18N-0001: core area カタログ — en/ja キー集合一致
// =============================================================================
describe("I18N-0001 core area カタログ en/ja キー集合一致", () => {
  it("[I18N-0001] core 全 area で en と ja のキー集合が完全一致する (片側欠落キーゼロ)", async () => {
    const areas = await loadCoreAreas();
    const errors = [];
    for (const { name, catalog } of areas) {
      if (!catalog?.en || !catalog?.ja) continue;
      const enKeys = new Set(Object.keys(catalog.en));
      const jaKeys = new Set(Object.keys(catalog.ja));
      const onlyEn = setDiff(enKeys, jaKeys);
      const onlyJa = setDiff(jaKeys, enKeys);
      if (onlyEn.size > 0)
        errors.push(`${name}: en にのみ存在: ${sorted(onlyEn).join(", ")}`);
      if (onlyJa.size > 0)
        errors.push(`${name}: ja にのみ存在: ${sorted(onlyJa).join(", ")}`);
    }
    expect(errors, errors.join("\n")).toHaveLength(0);
  });
});

// =============================================================================
// I18N-0002: kit area カタログ — en/ja キー集合一致
// =============================================================================
describe("I18N-0002 kit area カタログ en/ja キー集合一致", () => {
  it("[I18N-0002] kit 3 area (cli/serve/session) で en と ja のキー集合が完全一致する (片側欠落キーゼロ)", () => {
    const errors = [];
    for (const { name, catalog } of KIT_AREAS) {
      if (!catalog?.en || !catalog?.ja) continue;
      const enKeys = new Set(Object.keys(catalog.en));
      const jaKeys = new Set(Object.keys(catalog.ja));
      const onlyEn = setDiff(enKeys, jaKeys);
      const onlyJa = setDiff(jaKeys, enKeys);
      if (onlyEn.size > 0)
        errors.push(`${name}: en にのみ存在: ${sorted(onlyEn).join(", ")}`);
      if (onlyJa.size > 0)
        errors.push(`${name}: ja にのみ存在: ${sorted(onlyJa).join(", ")}`);
    }
    expect(errors, errors.join("\n")).toHaveLength(0);
  });
});

// =============================================================================
// I18N-0003: core area 間キー重複ゼロ
// =============================================================================
describe("I18N-0003 core area 間キー重複ゼロ (静的マージ衝突なし)", () => {
  it("[I18N-0003] core 全 area を Object.assign でマージする際に area 間で同一キーが存在しない", async () => {
    const areas = await loadCoreAreas();
    const seen = new Map();
    const duplicates = [];
    for (const { name, catalog } of areas) {
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
});

// =============================================================================
// I18N-0004: kit area 間キー重複ゼロ
// =============================================================================
describe("I18N-0004 kit area 間キー重複ゼロ", () => {
  it("[I18N-0004] kit 3 area (cli/serve/session) 間で同一キーが重複しない", () => {
    const seen = new Map();
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
});

// =============================================================================
// I18N-0005: core ↔ kit 横断キー重複ゼロ
// =============================================================================
describe("I18N-0005 core↔kit 横断キー重複ゼロ (serve.* 名前空間分割の自己整合)", () => {
  it("[I18N-0005] core 静的カタログ全キーと kit 3 area 全キーの和集合に重複が無い", async () => {
    const coreAreas = await loadCoreAreas();

    // core キーセット
    const coreKeys = new Map(); // key -> area name
    for (const { name, catalog } of coreAreas) {
      for (const k of Object.keys(catalog?.en || {})) {
        coreKeys.set(k, name);
      }
    }

    // kit キーを core と突合
    const duplicates = [];
    for (const { name, catalog } of KIT_AREAS) {
      for (const k of Object.keys(catalog?.en || {})) {
        if (coreKeys.has(k)) {
          duplicates.push(
            `"${k}" が core/${coreKeys.get(k)} と kit/${name} に重複`
          );
        }
      }
    }

    expect(
      duplicates,
      `core↔kit 横断重複キー:\n${duplicates.join("\n")}`
    ).toHaveLength(0);
  });
});

// =============================================================================
// I18N-0006: core カタログ en/ja の {var} プレースホルダ一致
// =============================================================================
describe("I18N-0006 core カタログ en/ja の {var} プレースホルダ一致", () => {
  it("[I18N-0006] core 各 area で ja 値が truthy なキーは en と ja の {var} プレースホルダ集合が一致する (ja-falsy はスキップ)", async () => {
    const areas = await loadCoreAreas();
    const errors = [];
    for (const { name, catalog } of areas) {
      if (!catalog?.en || !catalog?.ja) continue;
      for (const key of Object.keys(catalog.en)) {
        if (!catalog.ja[key]) continue; // ja-falsy-skip
        const enPH = extractPlaceholders(catalog.en[key]);
        const jaPH = extractPlaceholders(catalog.ja[key]);
        const onlyEn = setDiff(enPH, jaPH);
        const onlyJa = setDiff(jaPH, enPH);
        if (onlyEn.size > 0 || onlyJa.size > 0) {
          errors.push(
            `${name} "${key}": en={${[...enPH].join(",")}} ja={${[...jaPH].join(",")}}`
          );
        }
      }
    }
    expect(errors, errors.join("\n")).toHaveLength(0);
  });
});

// =============================================================================
// I18N-0007: kit カタログ en/ja の {var} プレースホルダ一致
// =============================================================================
describe("I18N-0007 kit カタログ en/ja の {var} プレースホルダ一致", () => {
  it("[I18N-0007] kit 各 area で ja 値が truthy なキーは en と ja の {var} プレースホルダ集合が一致する (ja-falsy はスキップ)", () => {
    const errors = [];
    for (const { name, catalog } of KIT_AREAS) {
      if (!catalog?.en || !catalog?.ja) continue;
      for (const key of Object.keys(catalog.en)) {
        if (!catalog.ja[key]) continue; // ja-falsy-skip
        const enPH = extractPlaceholders(catalog.en[key]);
        const jaPH = extractPlaceholders(catalog.ja[key]);
        const onlyEn = setDiff(enPH, jaPH);
        const onlyJa = setDiff(jaPH, enPH);
        if (onlyEn.size > 0 || onlyJa.size > 0) {
          errors.push(
            `${name} "${key}": en={${[...enPH].join(",")}} ja={${[...jaPH].join(",")}}`
          );
        }
      }
    }
    expect(errors, errors.join("\n")).toHaveLength(0);
  });
});

// =============================================================================
// I18N-0008: core src の t("...") リテラルが全て core カタログに存在
// =============================================================================
describe('I18N-0008 core src の t("...") リテラルが全て core カタログに存在', () => {
  it('[I18N-0008] packages/core/src/**/*.js 内の t("key") リテラルが全て core カタログに存在する (欠落キーゼロ)', async () => {
    const srcDirs = [
      join(__dirname, "../../../core/src"),
      join(__dirname, "../../../core/src/ble"),
      join(__dirname, "../../../core/src/ble/os2"),
    ];

    // 引数なし形のみ一致 — I18N-0010 でギャップを文書化する
    const keyPattern = /\bt\("([a-z][a-zA-Z0-9._-]*\.[a-zA-Z0-9._-]*)"\)/g;
    const usedKeys = new Set();

    for (const dir of srcDirs) {
      let files;
      try {
        files = readdirSync(dir).filter((f) => f.endsWith(".js"));
      } catch {
        continue;
      }
      for (const f of files) {
        const src = readFileSync(join(dir, f), "utf8");
        for (const m of src.matchAll(keyPattern)) usedKeys.add(m[1]);
      }
    }

    const areas = await loadCoreAreas();
    const catalogKeys = new Set();
    for (const { catalog } of areas) {
      for (const k of Object.keys(catalog?.en || {})) catalogKeys.add(k);
    }

    const missing = [...usedKeys].filter((k) => !catalogKeys.has(k));
    expect(
      missing,
      `core src の t() リテラルがカタログに無い: ${missing.join(", ")}`
    ).toHaveLength(0);
  });
});

// =============================================================================
// I18N-0009: kit src の t("...") リテラルが kit+core カタログに存在
// =============================================================================
describe('I18N-0009 kit src の t("...") リテラルが kit+core カタログに存在', () => {
  it('[I18N-0009] packages/kit/src/**/*.js 内の t("key") リテラルが kit カタログ ∪ core カタログに全て存在する', () => {
    const srcDirs = [
      join(__dirname, "../../src"),
      join(__dirname, "../../src/cli"),
      join(__dirname, "../../src/serve"),
      join(__dirname, "../../src/serve/framing"),
      join(__dirname, "../../src/serve/entries"),
    ];

    const keyPattern = /\bt\("([a-z][a-zA-Z0-9._-]*\.[a-zA-Z0-9._-]*)"\)/g;
    const usedKeys = new Set();

    for (const dir of srcDirs) {
      let files;
      try {
        files = readdirSync(dir).filter((f) => f.endsWith(".js"));
      } catch {
        continue;
      }
      for (const f of files) {
        const src = readFileSync(join(dir, f), "utf8");
        for (const m of src.matchAll(keyPattern)) usedKeys.add(m[1]);
      }
    }

    const allCatalogKeys = new Set([
      ...kitCatalogKeys(),
      ...coreCatalogKeysFromFiles(),
    ]);
    const missing = [...usedKeys].filter((k) => !allCatalogKeys.has(k));
    expect(
      missing,
      `kit src の t() リテラルがカタログに無い: ${missing.join(", ")}`
    ).toHaveLength(0);
  });
});

// =============================================================================
// I18N-0010: t("key", {vars}) 引数付き呼び出しの literal scan ギャップ
// =============================================================================
describe('I18N-0010 t("key", {vars}) 引数付き呼び出しの literal scan ギャップ', () => {
  it("[I18N-0010] catalog completeness テストの keyPattern は t(\"k\") 形のみ一致し t(\"k\",{...}) 引数付き形を走査対象から取りこぼす (監査ギャップの確認)", () => {
    // 引数なし形のみ: 既存 lint パターン
    const narrowPattern =
      /\bt\("([a-z][a-zA-Z0-9._-]*\.[a-zA-Z0-9._-]*)"\)/g;
    // 引数付き形: t("key", {...}) を捕捉
    const withArgsPattern =
      /\bt\("([a-z][a-zA-Z0-9._-]*\.[a-zA-Z0-9._-]*)"\s*,\s*\{/g;

    const srcDirs = [
      join(__dirname, "../../../core/src"),
      join(__dirname, "../../../core/src/ble"),
      join(__dirname, "../../../core/src/ble/os2"),
      join(__dirname, "../../src"),
      join(__dirname, "../../src/cli"),
      join(__dirname, "../../src/serve"),
      join(__dirname, "../../src/serve/framing"),
      join(__dirname, "../../src/serve/entries"),
    ];

    let narrowCount = 0;
    let withArgsCount = 0;

    for (const dir of srcDirs) {
      let files;
      try {
        files = readdirSync(dir).filter((f) => f.endsWith(".js"));
      } catch {
        continue;
      }
      for (const f of files) {
        const src = readFileSync(join(dir, f), "utf8");
        narrowCount += [...src.matchAll(narrowPattern)].length;
        withArgsCount += [...src.matchAll(withArgsPattern)].length;
      }
    }

    // 引数なし呼び出しが既存スキャンで対象にされる形式
    expect(narrowCount, "引数なし t(\"k\") が 1 件以上存在するはず").toBeGreaterThan(0);
    // 引数付き呼び出しが実際に存在すること (ギャップの前提条件)
    expect(withArgsCount, "引数付き t(\"k\",{...}) が 1 件以上存在するはず — これが監査ギャップ").toBeGreaterThan(0);
  });
});

// =============================================================================
// I18N-0011: registerCatalog() 重複キー登録で TypeError
// =============================================================================
describe("I18N-0011 registerCatalog() 重複キー登録で TypeError", () => {
  it("[I18N-0011] en 側の重複キーで TypeError を投げる (en-dup branch)", () => {
    // "ble.disconnected" は core/ble.js に存在する既知キー
    expect(() =>
      registerCatalog("__i18n0011_en_dup__", {
        en: { "ble.disconnected": "DUPLICATE" },
        ja: {},
      })
    ).toThrow(TypeError);
  });

  it("[I18N-0011] ja 側の重複キーで TypeError を投げる (ja-dup branch)", () => {
    expect(() =>
      registerCatalog("__i18n0011_ja_dup__", {
        en: {},
        ja: { "ble.disconnected": "重複" },
      })
    ).toThrow(TypeError);
  });

  it("[I18N-0011] 新しいキーは TypeError を投げずに登録される (new-key-ok branch)", () => {
    const uniqueKey = `__i18n0011_new_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    expect(() =>
      registerCatalog("__i18n0011_new__", {
        en: { [uniqueKey]: "hello" },
        ja: { [uniqueKey]: "こんにちは" },
      })
    ).not.toThrow();
    setLocale("en");
    expect(t(uniqueKey)).toBe("hello");
    setLocale("ja");
    expect(t(uniqueKey)).toBe("こんにちは");
  });

  it("[I18N-0011] ja 欠落 area は en のみ登録してエラーにならない (ja-missing-ok branch)", () => {
    const uniqueKey = `__i18n0011_enonly_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    expect(() =>
      registerCatalog("__i18n0011_enonly__", {
        en: { [uniqueKey]: "only english" },
      })
    ).not.toThrow();
    setLocale("en");
    expect(t(uniqueKey)).toBe("only english");
    // ja にキーが無いため en にフォールバック
    setLocale("ja");
    expect(t(uniqueKey)).toBe("only english");
  });
});

// =============================================================================
// I18N-0012: kit カタログを registerCatalog で core へ起動時登録
// =============================================================================
describe("I18N-0012 kit カタログを registerCatalog で core へ起動時登録 (cli/serve/session)", () => {
  it("[I18N-0012] kit vitest.setup.js の副作用 import 後に kit catalog が core CATALOG に登録済み (各 area 代表キー)", () => {
    // vitest.setup.js で ./src/i18n/index.js が既に実行済みのため、
    // kit の cli/serve/session カタログが core CATALOG へ登録されている。
    // 各 area の先頭キーを使って生キー未返却を確認する。

    // cli.* の代表キー
    const cliKey = Object.keys(cliCatalog.en)[0];
    const cliEnVal = cliCatalog.en[cliKey];
    setLocale("en");
    expect(t(cliKey)).toBe(cliEnVal);
    expect(t(cliKey)).not.toBe(cliKey); // 生キー未返却

    // serve.* の代表キー
    const serveKey = Object.keys(serveCatalog.en)[0];
    const serveEnVal = serveCatalog.en[serveKey];
    setLocale("en");
    expect(t(serveKey)).toBe(serveEnVal);
    expect(t(serveKey)).not.toBe(serveKey);

    // session.* の代表キー
    const sessionKey = Object.keys(sessionCatalog.en)[0];
    const sessionEnVal = sessionCatalog.en[sessionKey];
    setLocale("en");
    expect(t(sessionKey)).toBe(sessionEnVal);
    expect(t(sessionKey)).not.toBe(sessionKey);
  });

  it("[I18N-0012] t(\"session.devicesTitle\") が正しく解決される (session area)", () => {
    setLocale("en");
    expect(t("session.devicesTitle")).toBe("Pick a device:");
    setLocale("ja");
    expect(t("session.devicesTitle")).toBe("操作するデバイス:");
  });

  it("[I18N-0012] t(\"cli.helpOption\") が登録済みカタログから解決される (cli area)", () => {
    setLocale("en");
    expect(t("cli.helpOption")).toBe("display help");
  });

  it("[I18N-0012] t(\"serve.invalidPort\") が登録済みカタログから解決される (serve area)", () => {
    setLocale("en");
    const result = t("serve.invalidPort", { v: "abc" });
    expect(result).toContain("abc");
    expect(result).not.toBe("serve.invalidPort");
  });

  it("[I18N-0012] 未登録キーを呼ぶと生キーが返る (登録タイミング不変条件の境界確認)", () => {
    setLocale("en");
    const fakeKey = "cli.__nonexistent_key_for_test__";
    expect(t(fakeKey)).toBe(fakeKey);
  });
});

// =============================================================================
// I18N-0013: 本番 core は kit 非依存 (依存方向 kit→core 単方向)
// =============================================================================
describe("I18N-0013 本番 core は kit 非依存 (依存方向 kit→core 単方向)", () => {
  it("[I18N-0013] packages/core/src/**/*.js が @sesame-kit/kit / sesame-kit を一切 import しない", () => {
    const coreSrcDirs = [
      join(__dirname, "../../../core/src"),
      join(__dirname, "../../../core/src/ble"),
      join(__dirname, "../../../core/src/ble/os2"),
      join(__dirname, "../../../core/src/i18n"),
    ];

    // 両パターンを組み合わせる (A: @sesame-kit/kit | B: sesame-kit前方一致)
    const kitImportPattern =
      /from\s+["'](@sesame-kit\/kit|sesame-kit)["']/;
    const violations = [];

    for (const dir of coreSrcDirs) {
      let files;
      try {
        files = readdirSync(dir).filter((f) => f.endsWith(".js"));
      } catch {
        continue;
      }
      for (const f of files) {
        const src = readFileSync(join(dir, f), "utf8");
        if (kitImportPattern.test(src)) {
          violations.push(`${dir}/${f} が kit を import しています`);
        }
      }
    }

    expect(
      violations,
      `core src から kit への逆依存:\n${violations.join("\n")}`
    ).toHaveLength(0);
  });

  it("[I18N-0013] core の i18n.js は kit を import せず t()/registerCatalog が core 内に常駐する", () => {
    const i18nSrc = readFileSync(
      join(__dirname, "../../../core/src/i18n.js"),
      "utf8"
    );
    // kit への import が無いこと
    expect(i18nSrc).not.toMatch(
      /from\s+["'](@sesame-kit\/kit|sesame-kit)["']/
    );
    // registerCatalog が export されていること
    expect(i18nSrc).toMatch(/export function registerCatalog/);
    // t が export されていること
    expect(i18nSrc).toMatch(/export function t\b/);
  });
});

// =============================================================================
// I18N-0014: 既定ロケール en・テスト ja 固定の二系統
// =============================================================================
describe("I18N-0014 既定ロケール en・テスト ja 固定の二系統", () => {
  beforeEach(() => setLocale("en"));

  it("[I18N-0014] 本番既定は _locale=en で getLocale()==='en' (prod-default-en branch)", () => {
    setLocale("en");
    expect(getLocale()).toBe("en");
  });

  it("[I18N-0014] setLocale('ja') で ja に切り替わる (test-beforeEach-ja branch)", () => {
    setLocale("ja");
    expect(getLocale()).toBe("ja");
  });

  it("[I18N-0014] setLocale('fr') など ja 以外は全て en へ丸める (invalid→en branch)", () => {
    setLocale("fr");
    expect(getLocale()).toBe("en");

    setLocale("zh");
    expect(getLocale()).toBe("en");

    setLocale("");
    expect(getLocale()).toBe("en");
  });

  it("[I18N-0014] setLocale(undefined) は en に丸める", () => {
    setLocale(undefined);
    expect(getLocale()).toBe("en");
  });
});

// =============================================================================
// I18N-0015: resolveLocale 優先順位 flag>configLang>en と前方一致正規化
// =============================================================================
describe("I18N-0015 resolveLocale 優先順位 flag>configLang>en と前方一致正規化", () => {
  it("[I18N-0015] flag > configLang > 既定 en の優先順位 (flag-wins branch)", () => {
    expect(resolveLocale({ flag: "ja", configLang: "en" })).toBe("ja");
  });

  it("[I18N-0015] flag が null/未指定なら configLang へフォールバック (config-fallback branch)", () => {
    expect(resolveLocale({ flag: null, configLang: "ja" })).toBe("ja");
    expect(resolveLocale({ flag: undefined, configLang: "ja" })).toBe("ja");
  });

  it("[I18N-0015] 両方未指定なら 'en' (default branch)", () => {
    expect(resolveLocale({})).toBe("en");
    expect(resolveLocale()).toBe("en");
  });

  it("[I18N-0015] 未知の値は黙って次の優先度へフォールスルー (unknown-skip branch)", () => {
    expect(resolveLocale({ flag: "fr", configLang: "ja" })).toBe("ja");
    expect(resolveLocale({ flag: "fr" })).toBe("en");
    expect(resolveLocale({ flag: "zh", configLang: "zh" })).toBe("en");
  });

  it("[I18N-0015] ja_JP.UTF-8 など前方一致 ja* → ja (ja*-prefix branch)", () => {
    expect(resolveLocale({ flag: "ja_JP.UTF-8" })).toBe("ja");
    expect(resolveLocale({ flag: "ja-JP" })).toBe("ja");
    expect(resolveLocale({ configLang: "ja_JP" })).toBe("ja");
  });

  it("[I18N-0015] en_US など前方一致 en* → en (en*-prefix branch)", () => {
    expect(resolveLocale({ flag: "en_US" })).toBe("en");
    expect(resolveLocale({ flag: "en-US.UTF-8" })).toBe("en");
    expect(resolveLocale({ configLang: "en_US" })).toBe("en");
  });

  it("[I18N-0015] isKnownLang: 空/未指定は true 扱い (指定なし扱い)", () => {
    expect(isKnownLang(null)).toBe(true);
    expect(isKnownLang(undefined)).toBe(true);
    expect(isKnownLang("")).toBe(true);
  });

  it("[I18N-0015] isKnownLang: ja*/en* は true、未知値は false", () => {
    expect(isKnownLang("ja")).toBe(true);
    expect(isKnownLang("en")).toBe(true);
    expect(isKnownLang("ja_JP")).toBe(true);
    expect(isKnownLang("en_US")).toBe(true);
    expect(isKnownLang("ja_JP.UTF-8")).toBe(true);
    expect(isKnownLang("fr")).toBe(false);
    expect(isKnownLang("zh")).toBe(false);
    expect(isKnownLang("xx")).toBe(false);
  });
});

// =============================================================================
// I18N-0016: t() の en フォールバック→生キー返却の三段解決
// =============================================================================
describe("I18N-0016 t() の en フォールバック→生キー返却の三段解決", () => {
  beforeEach(() => setLocale("en"));

  it("[I18N-0016] ロケール辞書にキーがあればその値を返す (locale-hit branch)", () => {
    // en hit
    setLocale("en");
    const enKey = Object.keys(cliCatalog.en)[0];
    expect(t(enKey)).toBe(cliCatalog.en[enKey]);

    // ja hit
    setLocale("ja");
    const jaKey = Object.keys(sessionCatalog.ja)[0];
    expect(t(jaKey)).toBe(sessionCatalog.ja[jaKey]);
  });

  it("[I18N-0016] ja で未定義キーは en へフォールバック (en-fallback branch)", () => {
    // en のみ登録済みキーは ja ロケールでも en 値を返す
    const uniqueKey = `__i18n0016_enonly_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    registerCatalog("__i18n0016_fb__", { en: { [uniqueKey]: "en-only value" } });
    setLocale("ja");
    expect(t(uniqueKey)).toBe("en-only value");
  });

  it("[I18N-0016] en にも無ければキー文字列そのものを返す (raw-key-passthrough branch)", () => {
    setLocale("en");
    expect(t("does.not.exist")).toBe("does.not.exist");
    setLocale("ja");
    expect(t("does.not.exist")).toBe("does.not.exist");
  });

  it("[I18N-0016] vars があれば {k} を全置換する", () => {
    setLocale("en");
    expect(t("session.actionsTitle", { name: "front" })).toBe("front — actions:");
    setLocale("ja");
    expect(t("session.actionsTitle", { name: "front" })).toBe("front の操作:");
  });

  it("[I18N-0016] t() は三段解決: key in dict ? dict[key] : key in CATALOG.en ? CATALOG.en[key] : key", () => {
    // ja hit: session.quit
    setLocale("ja");
    expect(t("session.quit")).toBe("終了");
    // raw-key passthrough
    expect(t("totally.unknown.key.xyz")).toBe("totally.unknown.key.xyz");
  });
});

// =============================================================================
// I18N-0017: 未訳 (ja 値 == en 値) を検出する value-translation 不変条件
// =============================================================================
describe("I18N-0017 未訳 (ja 値==en 値) を検出する value-translation 不変条件", () => {
  // 意図的に英語のまま維持するキーの allowlist
  // (フォーマット専用文字列、プロトコル文字列、技術トークン、ブランド名、API 識別子など)
  // spec audit (i18n.md I18N-0017 note) で 327 件の en===ja キーを実測し「多くは意図的同一」と判定。
  // 以下は全ての意図的同一キーの網羅リスト。
  const ALLOWLIST = new Set([
    // ─── core/jsonrpc.js: JSON-RPC プロトコル文字列 ───────────────────────────
    "serve.batchUnsupported",
    "serve.invalidRequest",
    "serve.internal",
    "serve.internalError",
    // ─── core/ble/*.js: BLE プロトコル/バッファガード文字列 ──────────────────
    "ble.disconnected",
    "ble.notConnected",
    "ble.transportRequired",
    "ble.secretKeyRequiredSession",
    "ble.tokenMustBe4Byte",
    "ble.mechStatusMustBeBuffer",
    "ble.mechSettingMustBeBuffer",
    "ble.opsSettingMustBeBuffer",
    "ble.ciphertextTooShort",
    "ble.frameTooShort",
    "ble.secretKeyMustBe16",
    "ble.ecdhSecretMustBe16",
    "ble.secondsRange",
    "ble.wm2SsidRequired",
    "ble.wm2PasswordString",
    "ble.wm2CompanyIdRequired",
    "ble.wm2DeviceUUIDRequired",
    "ble.wm2SesameKeyTagRequired",
    "ble.wm2NetworkStatusEmpty",
    "ble.wm2SessionRequired",
    "ble.wm2NoServerAuth",
    "ble.hub3SessionRequired",
    "ble.dfuDeviceNotAvailable",
    "ble.bot2BadIndex",
    "ble.bot2BadAction",
    "ble.bot2BadActionTime",
    "ble.bot2ScriptParseFailed",
    "ble.cli.list.header",
    "ble.cli.badHex",
    // ─── core/ble/*.js: BLE 技術エラー文字列 ────────────────────────────────
    "ble.secretKeyRequired",
    "ble.bleResultFailed",
    "ble.requestTimeout",
    "ble.wm2SesameKeyRequired",
    // ─── core/access.js: access ドメイン出力/エラー文字列 ────────────────────
    "access.authData.delete.done",
    "access.authData.name.done",
    "access.authData.post.done",
    "access.authData.put.done",
    "access.cards.cleared",
    "access.cards.nameUpdated",
    "access.cards.ownerUpdated",
    "access.cards.posted",
    "access.cards.rm.sent",
    "access.cmd.authData.delete",
    "access.cmd.authData.post",
    "access.cmd.authData.put",
    "access.enroll.passcodes.registered",
    "access.enroll.registered",
    "access.err.opTimeout",
    "access.foundCards",
    "access.foundPasscodes",
    "access.noCards",
    "access.noPasscodes",
    "access.passcodes.cleared",
    "access.passcodes.nameUpdated",
    "access.passcodes.posted",
    "access.passcodes.rm.sent",
    "access.post.emptyList",
    "access.rm.nothingSent",
    // ─── core/company.js ────────────────────────────────────────────────────
    "company.add.ok",
    "company.err.companyIDRequired",
    "company.err.nameRequired",
    "company.ls.found.many",
    "company.ls.found.one",
    "company.ls.none",
    "company.rename.ok",
    // ─── core/domain.js ─────────────────────────────────────────────────────
    "domain.aws.cognitoIdentityError",
    "domain.client.configRequired",
    "domain.client.getCompanyDeviceTimeout",
    "domain.client.keyRequired",
    "domain.client.lockMissingDeviceUUID",
    "domain.client.lockMissingSecretKey",
    "domain.client.noHub3Specified",
    "domain.client.notConnected",
    "domain.client.remoteMissingHub3",
    "domain.client.subUUIDNotAvailable",
    "domain.client.tokenStoreRequired",
    "domain.client.unknownHub3",
    "domain.client.useUsage",
    "domain.config.configPathRequired",
    "domain.config.hub3DeviceIdRequired",
    "domain.config.hub3NameRequired",
    "domain.config.lockDeviceUUIDRequired",
    "domain.config.lockNameRequired",
    "domain.config.lockSecretKeyRequired",
    "domain.config.nothingToSave",
    "domain.config.remoteHub3Required",
    "domain.config.remoteNameRequired",
    "domain.config.unknownLockName",
    "domain.config.unknownRemoteName",
    "domain.devices.deviceUUIDRequired",
    "domain.devices.getUserDeviceTimeout",
    "domain.devices.listFirmwareTimeout",
    "domain.devices.registerHttpError",
    "domain.devices.secretKeyRequired",
    "domain.devices.serverSecretRequired",
    "domain.devices.signGuestKeyNoToken",
    "domain.ir.learnTimeout",
    "domain.ir.subscribeIRDataFailed",
    "domain.ir.subscribeIRModeFailed",
    "domain.lock.cmdRequired",
    "domain.lock.deviceIdRequired",
    "domain.lock.failed",
    "domain.lock.notConnected",
    "domain.lock.secondsRange",
    "domain.lock.secretKeyRequired",
    "domain.lock.subUUIDRequired",
    "domain.lock.timeout",
    "domain.transport.closed",
    "domain.transport.closedBeforeInitial",
    "domain.transport.closedBeforeOpen",
    "domain.transport.closedByUser",
    "domain.transport.getIRCodesFailed",
    "domain.transport.idTokenRequired",
    "domain.transport.requestTimeout",
    "domain.transport.sendIRFailed",
    "domain.transport.wsUrlRequired",
    "domain.util.opFailed",
    // ─── core/iot.js ────────────────────────────────────────────────────────
    "iot.err.cmdRequired",
    "iot.err.cmdTimeout",
    "iot.err.deviceIdRequired",
    "iot.err.invalidHexString",
    "iot.err.nicknameTooLong",
    "iot.err.opDutyRange",
    "iot.err.opDutyRequired",
    "iot.err.opRange",
    "iot.err.payloadRequiredBase64",
    "iot.err.sesameIdRequired",
    "iot.err.ssmSecKaRequired",
    "iot.err.topicRequired",
    "iot.firmware.progress",
    "iot.led.get",
    "iot.matterCode.manual",
    "iot.matterCode.qr",
    "iot.sesame.missing.sesame",
    "iot.sesame.missing.ssmSec",
    "iot.sesame.ok",
    "iot.sesame.ssks",
    // ─── core/org.js ────────────────────────────────────────────────────────
    "org.deviceGroup.add.ok",
    "org.deviceGroup.addDevices.ok",
    "org.deviceGroup.ls.found",
    "org.deviceGroup.ls.none",
    "org.deviceGroup.rm.ok",
    "org.deviceGroup.rmDevices.ok",
    "org.deviceGroup.rmUserGroup.ok",
    "org.deviceGroup.update.ok",
    "org.employee.add.ok",
    "org.employee.confirm.ok",
    "org.employee.ls.found",
    "org.employee.ls.none",
    "org.employee.reorder.ok",
    "org.employee.rm.ok",
    "org.employee.search.found",
    "org.employee.search.none",
    "org.employee.update.ok",
    "org.group.add.ok",
    "org.group.add.okId",
    "org.group.addUsers.ok",
    "org.group.ls.found",
    "org.group.ls.none",
    "org.group.rm.ok",
    "org.group.rmDeviceGroup.ok",
    "org.group.rmUsers.ok",
    "org.group.update.ok",
    "org.keys.device.found",
    "org.keys.device.none",
    "org.keys.generateGuestQr.ok",
    "org.keys.rm.ok",
    "org.keys.share.ok",
    "org.keys.shareGroup.ok",
    "org.keys.updateGuestTag.ok",
    "org.req.companyID",
    "org.req.data",
    "org.req.deviceUUID",
    "org.req.email",
    "org.req.gid",
    "org.req.gidsArray",
    "org.req.groupIdsArray",
    "org.req.itemsArray",
    "org.req.keyword",
    "org.req.subUUID",
    "org.role.ls.found",
    "org.role.ls.none",
    "org.role.post.hint",
    "org.role.post.ok",
    "org.role.rm.hint",
    "org.role.rm.ok",
    // ─── core/payment.js ────────────────────────────────────────────────────
    "payment.err.customerIdRequired",
    "payment.err.defaultPaymentMethodRequired",
    "payment.err.emailRequired",
    "payment.err.isUpgradeRequired",
    "payment.err.levelRequired",
    "payment.err.paymentIdRequired",
    "payment.err.subIdRequired",
    "payment.opt.paymentMethod",
    "payment.secret.value",
    // ─── core/presetir.js ───────────────────────────────────────────────────
    "presetir.err.commandRequired",
    "presetir.err.companyIdRequired",
    "presetir.err.deviceIdRequired",
    "presetir.err.irTypeRequired",
    "presetir.out.airEmitted",
    "presetir.out.buttonEmitted",
    "presetir.out.command",
    "presetir.out.sent",
    // ─── core/schedule.js ───────────────────────────────────────────────────
    "schedule.cancel.ack",
    "schedule.cancel.none",
    "schedule.err.cancelScheduleFailed",
    "schedule.err.getScheduleListFailed",
    "schedule.err.scheduleIdRequired",
    "schedule.err.subUUIDRequired",
    "schedule.ls.found",
    "schedule.ls.none",
    // ─── core/sharekey.js ───────────────────────────────────────────────────
    "sharekey.err.friendQrUrlRequired",
    "sharekey.err.subUUIDRequired",
    // ─── kit/cli.js: CLI 出力/エラー文字列 ──────────────────────────────────
    "cli.aliasRequired",
    "cli.alreadyExists",
    "cli.batteryRecords",
    "cli.bootHub3",
    "cli.codeRequired",
    "cli.companyId",
    "cli.configDir",
    "cli.configJsonHeader",
    "cli.configNotInitialized",
    "cli.defaultMarker",
    "cli.deviceUuidPrompt",
    "cli.deviceUuidRequired",
    "cli.emailRequired",
    "cli.foundDevices",
    "cli.foundKeys",
    "cli.foundMatchingRemotes",
    "cli.foundPresetRemotes",
    "cli.foundRemotes",
    "cli.foundUserDevices",
    "cli.funcRequired",
    "cli.idTokenRefreshed",
    "cli.imported",
    "cli.importedNone",
    "cli.invalidJsonQueryBody",
    "cli.irData",
    "cli.irDataRequired",
    "cli.keyRequired",
    "cli.keyRequiredShort",
    "cli.keyUuid",
    "cli.keynameRequired",
    "cli.loginStep2",
    "cli.migrateHub3",
    "cli.migrateRemote",
    "cli.mode",
    "cli.modeMustBe",
    "cli.name",
    "cli.nameRequired",
    "cli.newNameRequiredDevice",
    "cli.newNameRequiredKey",
    "cli.noHub3",
    "cli.noKeys",
    "cli.noLocks",
    "cli.noRemotes",
    "cli.notInitialized",
    "cli.notSignedIn",
    "cli.okBootstrapped",
    "cli.okCreated",
    "cli.okDefaultLock",
    "cli.okDefaultRemote",
    "cli.okDeletedDevice",
    "cli.okDeletedKey",
    "cli.okDeletedServerRemote",
    "cli.okHub3Added",
    "cli.okKeepalive",
    "cli.okLearned",
    "cli.okLockAdded",
    "cli.okLockRemoved",
    "cli.okMigrated",
    "cli.okMode",
    "cli.okOp",
    "cli.okRemoteAdded",
    "cli.okRenamedDevice",
    "cli.okRenamedKey",
    "cli.okRenamedRemote",
    "cli.okSend",
    "cli.okSync",
    "cli.okSyncedKeys",
    "cli.optWebapiBody",
    "cli.optWebapiQuery",
    "cli.promptAbortedEof",
    "cli.savedTo",
    "cli.searchTermRequired",
    "cli.secretKeyRequired",
    "cli.sessCloudResult",
    "cli.sessLedResult",
    "cli.skipped",
    "cli.subUuid",
    "cli.subscription",
    "cli.tokensJsonHeader",
    "cli.unknownRemote",
    "cli.usageError",
    "cli.verifyCodePrompt",
    // ─── kit/serve.js: serve ドメイン出力/エラー文字列 ──────────────────────
    "serve.cloudNotConnected",
    "serve.connNotRegistered",
    "serve.connectFailed",
    "serve.grpc.fieldMustBeJson",
    "serve.grpc.unauthorized",
    "serve.grpc.unknownTopics",
    "serve.http.notFound",
    "serve.http.payloadTooLarge",
    "serve.http.unknownTopics",
    "serve.http.usage",
    "serve.hubRequired",
    "serve.invalidPort",
    "serve.methodNotFound",
    "serve.missingParam",
    "serve.notAuthenticated",
    "serve.note.shuttingDown",
    "serve.note.socketTest",
    "serve.note.stdioReady",
    "serve.note.token",
    "serve.note.tokenSaved",
    "serve.note.tokenUse",
    "serve.note.tooManyRej",
    "serve.note.uncaught",
    "serve.note.unhandled",
    "serve.note.unixSocket",
    "serve.note.watchdog",
    "serve.note.wsTest",
    "serve.paramsMustBeObject",
    "serve.result.openrpc",
    "serve.rpcTimeout",
    "serve.socket.alreadyRunning",
    "serve.unknownTopics",
    "serve.unsupportedBleOp",
    "serve.unsupportedJsonKey",
    "serve.ws.unauthorized",
  ]);

  it("[I18N-0017] core 各 area で ja 値が en 値と同一 (未訳) のキーが allowlist 外に存在しない", async () => {
    const areas = await loadCoreAreas();
    const untranslated = [];
    for (const { name, catalog } of areas) {
      if (!catalog?.en || !catalog?.ja) continue;
      for (const key of Object.keys(catalog.en)) {
        if (!catalog.ja[key]) continue; // ja 欠落はスキップ
        if (ALLOWLIST.has(key)) continue;
        if (catalog.ja[key] === catalog.en[key]) {
          untranslated.push(
            `${name} "${key}": ja===en ("${catalog.en[key]}")`
          );
        }
      }
    }
    expect(
      untranslated,
      `未訳キー (ja===en, allowlist 外):\n${untranslated.join("\n")}`
    ).toHaveLength(0);
  });

  it("[I18N-0017] kit 各 area で ja 値が en 値と同一 (未訳) のキーが allowlist 外に存在しない", () => {
    const untranslated = [];
    for (const { name, catalog } of KIT_AREAS) {
      if (!catalog?.en || !catalog?.ja) continue;
      for (const key of Object.keys(catalog.en)) {
        if (!catalog.ja[key]) continue;
        if (ALLOWLIST.has(key)) continue;
        if (catalog.ja[key] === catalog.en[key]) {
          untranslated.push(
            `${name} "${key}": ja===en ("${catalog.en[key]}")`
          );
        }
      }
    }
    expect(
      untranslated,
      `未訳キー (ja===en, allowlist 外):\n${untranslated.join("\n")}`
    ).toHaveLength(0);
  });
});

// =============================================================================
// I18N-0018: literal-coverage の helper 経由 badRequest("k",vars) / 動的キー走査ギャップ
// =============================================================================
describe('I18N-0018 literal-coverage の helper 経由 badRequest("k",vars) / 動的キー走査ギャップ', () => {
  it("[I18N-0018] badRequest(key, vars) 第1引数リテラルのキーが全て core カタログに存在する (core helper-indirection branch)", async () => {
    const srcDirs = [
      join(__dirname, "../../../core/src"),
      join(__dirname, "../../../core/src/ble"),
      join(__dirname, "../../../core/src/ble/os2"),
    ];

    const badRequestPattern =
      /\bbadRequest\(\s*"([a-z][a-zA-Z0-9._-]*\.[a-zA-Z0-9._-]*)"/g;
    const usedKeys = new Set();

    for (const dir of srcDirs) {
      let files;
      try {
        files = readdirSync(dir).filter((f) => f.endsWith(".js"));
      } catch {
        continue;
      }
      for (const f of files) {
        const src = readFileSync(join(dir, f), "utf8");
        for (const m of src.matchAll(badRequestPattern)) usedKeys.add(m[1]);
      }
    }

    const areas = await loadCoreAreas();
    const catalogKeys = new Set();
    for (const { catalog } of areas) {
      for (const k of Object.keys(catalog?.en || {})) catalogKeys.add(k);
    }

    const missing = [...usedKeys].filter((k) => !catalogKeys.has(k));
    expect(
      missing,
      `core badRequest() 経由のキーがカタログに無い: ${missing.join(", ")}`
    ).toHaveLength(0);
  });

  it("[I18N-0018] badRequest(key, vars) 第1引数リテラルのキーが全て kit+core カタログに存在する (kit helper-indirection branch)", () => {
    const srcDirs = [
      join(__dirname, "../../src"),
      join(__dirname, "../../src/cli"),
      join(__dirname, "../../src/serve"),
      join(__dirname, "../../src/serve/framing"),
      join(__dirname, "../../src/serve/entries"),
    ];

    const badRequestPattern =
      /\bbadRequest\(\s*"([a-z][a-zA-Z0-9._-]*\.[a-zA-Z0-9._-]*)"/g;
    const usedKeys = new Set();

    for (const dir of srcDirs) {
      let files;
      try {
        files = readdirSync(dir).filter((f) => f.endsWith(".js"));
      } catch {
        continue;
      }
      for (const f of files) {
        const src = readFileSync(join(dir, f), "utf8");
        for (const m of src.matchAll(badRequestPattern)) usedKeys.add(m[1]);
      }
    }

    const allKeys = new Set([...kitCatalogKeys(), ...coreCatalogKeysFromFiles()]);
    const missing = [...usedKeys].filter((k) => !allKeys.has(k));
    expect(
      missing,
      `kit badRequest() 経由のキーがカタログに無い: ${missing.join(", ")}`
    ).toHaveLength(0);
  });

  it("[I18N-0018] t(\"key\", {vars}) 引数付き形のキーが全て core カタログに存在する (core with-vars branch — gap detection)", async () => {
    const srcDirs = [
      join(__dirname, "../../../core/src"),
      join(__dirname, "../../../core/src/ble"),
      join(__dirname, "../../../core/src/ble/os2"),
    ];

    // 引数あり形: narrowPattern が拾い漏らす形式
    const withVarsPattern =
      /\bt\("([a-z][a-zA-Z0-9._-]*\.[a-zA-Z0-9._-]*)"\s*,/g;
    const usedKeys = new Set();

    for (const dir of srcDirs) {
      let files;
      try {
        files = readdirSync(dir).filter((f) => f.endsWith(".js"));
      } catch {
        continue;
      }
      for (const f of files) {
        const src = readFileSync(join(dir, f), "utf8");
        for (const m of src.matchAll(withVarsPattern)) usedKeys.add(m[1]);
      }
    }

    // core/src/ble/rpc-helpers.js は core モジュールだが serve.missingParam 等
    // kit カタログ (serve.js) のキーを参照する。実行時は registerCatalog() により
    // kit カタログがマージされるため、core+kit の合算カタログで存在確認する。
    const areas = await loadCoreAreas();
    const catalogKeys = new Set([...kitCatalogKeys()]);
    for (const { catalog } of areas) {
      for (const k of Object.keys(catalog?.en || {})) catalogKeys.add(k);
    }

    const missing = [...usedKeys].filter((k) => !catalogKeys.has(k));
    expect(
      missing,
      `core t("key", vars) 形のキーがカタログに無い (監査ギャップ): ${missing.join(", ")}`
    ).toHaveLength(0);
  });

  it("[I18N-0018] kit src の t(\"key\", {vars}) 引数付き形のキーが全て kit+core カタログに存在する (kit with-vars branch)", () => {
    const srcDirs = [
      join(__dirname, "../../src"),
      join(__dirname, "../../src/cli"),
      join(__dirname, "../../src/serve"),
      join(__dirname, "../../src/serve/framing"),
      join(__dirname, "../../src/serve/entries"),
    ];

    const withVarsPattern =
      /\bt\("([a-z][a-zA-Z0-9._-]*\.[a-zA-Z0-9._-]*)"\s*,/g;
    const usedKeys = new Set();

    for (const dir of srcDirs) {
      let files;
      try {
        files = readdirSync(dir).filter((f) => f.endsWith(".js"));
      } catch {
        continue;
      }
      for (const f of files) {
        const src = readFileSync(join(dir, f), "utf8");
        for (const m of src.matchAll(withVarsPattern)) usedKeys.add(m[1]);
      }
    }

    const allKeys = new Set([...kitCatalogKeys(), ...coreCatalogKeysFromFiles()]);
    const missing = [...usedKeys].filter((k) => !allKeys.has(k));
    expect(
      missing,
      `kit t("key", vars) 形のキーがカタログに無い (監査ギャップ): ${missing.join(", ")}`
    ).toHaveLength(0);
  });

  it("[I18N-0018] 動的キー呼び出し t(var)/t(obj.prop) が存在するギャップを文書化する (dynamic-key gap branch)", () => {
    // spec: t(key)/t(m)/t(kind.notCapableKey) のような非リテラルキー形式は
    // 既存の literal scan で検出できない。このテストはギャップの存在を確認する。
    const srcDirs = [
      join(__dirname, "../../../core/src"),
      join(__dirname, "../../../core/src/ble"),
      join(__dirname, "../../../core/src/ble/os2"),
      join(__dirname, "../../src"),
      join(__dirname, "../../src/cli"),
      join(__dirname, "../../src/serve"),
      join(__dirname, "../../src/serve/framing"),
      join(__dirname, "../../src/serve/entries"),
    ];

    // 動的キー形: t( の直後が " でない識別子/プロパティアクセス
    const dynamicKeyPattern = /\bt\(\s*(?!["'`])[a-zA-Z_$][a-zA-Z0-9_$.]*\s*[,)]/g;

    let dynamicCount = 0;
    for (const dir of srcDirs) {
      let files;
      try {
        files = readdirSync(dir).filter((f) => f.endsWith(".js"));
      } catch {
        continue;
      }
      for (const f of files) {
        const src = readFileSync(join(dir, f), "utf8");
        const matches = [...src.matchAll(dynamicKeyPattern)];
        dynamicCount += matches.length;
        dynamicKeyPattern.lastIndex = 0;
      }
    }

    // 動的キー呼び出しが実際に存在すること (ギャップの前提確認)
    expect(
      dynamicCount,
      "動的キー t(var) / t(obj.prop) 形式が 1 件以上存在するはず"
    ).toBeGreaterThan(0);
  });
});
