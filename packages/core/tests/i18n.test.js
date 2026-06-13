import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { t, setLocale, getLocale, resolveLocale, registerCatalog } from "../src/i18n.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- 既存テスト ----

describe("i18n", () => {
  beforeEach(() => setLocale("en"));

  it("既定は英語", () => {
    expect(getLocale()).toBe("en");
    expect(t("session.devicesTitle")).toBe("Pick a device:");
  });

  it("setLocale('ja') で日本語を返す", () => {
    setLocale("ja");
    expect(getLocale()).toBe("ja");
    expect(t("session.devicesTitle")).toBe("操作するデバイス:");
  });

  it("{var} を補間する", () => {
    expect(t("session.actionsTitle", { name: "front" })).toBe("front — actions:");
    setLocale("ja");
    expect(t("session.actionsTitle", { name: "front" })).toBe("front の操作:");
  });

  it("未定義キーは en にフォールバックし、無ければキー自身を返す", () => {
    setLocale("ja");
    expect(t("does.not.exist")).toBe("does.not.exist");
  });

  it("不正な locale は en に丸める", () => {
    setLocale("fr");
    expect(getLocale()).toBe("en");
  });

  describe("resolveLocale", () => {
    it("優先順位: flag > configLang > 既定 en", () => {
      expect(resolveLocale({ flag: "ja", configLang: "en" })).toBe("ja");
      expect(resolveLocale({ flag: null, configLang: "ja" })).toBe("ja");
      expect(resolveLocale({})).toBe("en");
    });
    it("ja_JP.UTF-8 のような値も前方一致で判定", () => {
      expect(resolveLocale({ flag: "ja_JP.UTF-8" })).toBe("ja");
      expect(resolveLocale({ flag: "en_US" })).toBe("en");
    });
    it("未知の値は無視して次の優先度へ", () => {
      expect(resolveLocale({ flag: "fr", configLang: "ja" })).toBe("ja");
      expect(resolveLocale({ flag: "fr" })).toBe("en");
    });
  });
});

// ---- P5-2: カタログ完全性テスト (core カタログ対象) ----

/** core の i18n/<area>.js を全て動的に読み込む */
async function loadCoreAreas() {
  const i18nDir = join(__dirname, "../src/i18n");
  const files = readdirSync(i18nDir)
    .filter(f => f.endsWith(".js"))
    .sort();
  const areas = [];
  for (const f of files) {
    const mod = await import(join(i18nDir, f));
    areas.push({ name: f, catalog: mod.default });
  }
  return areas;
}

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

describe("i18n core catalog completeness (P5-2)", () => {
  let areas;
  beforeEach(async () => {
    areas = await loadCoreAreas();
  });

  it("(1) 各 area で en と ja のキー集合が一致する", () => {
    const errors = [];
    for (const { name, catalog } of areas) {
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

  it("(2) core area 間でキーの重複がない", () => {
    const seen = new Map(); // key -> areaName
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

  it("(3) en と ja で {var} プレースホルダが一致する", () => {
    const errors = [];
    for (const { name, catalog } of areas) {
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

  it("(4) core/src の t(\"...\") リテラルが全て core カタログに存在する", () => {
    // core src の全 .js ファイルを文字列スキャン
    const srcDirs = [
      join(__dirname, "../src"),
      join(__dirname, "../src/ble"),
      join(__dirname, "../src/ble/os2"),
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

    // core catalog のキーセット (area ファイルから直接収集)
    const catalogKeys = new Set();
    for (const { catalog } of areas) {
      for (const k of Object.keys(catalog?.en || {})) catalogKeys.add(k);
    }

    const missing = [...usedKeys].filter(k => !catalogKeys.has(k));
    expect(missing, `core src の t() リテラルがカタログに無い: ${missing.join(", ")}`).toHaveLength(0);
  });
});

// ---- P5-2: registerCatalog API のユニットテスト ----

describe("registerCatalog API (P5-2)", () => {
  it("新しいキーを正常に登録できる", () => {
    // ユニークな area 名で登録
    const testKey = `__test_register_${Date.now()}`;
    registerCatalog("__test_area__", {
      en: { [testKey]: "hello" },
      ja: { [testKey]: "こんにちは" },
    });
    setLocale("en");
    expect(t(testKey)).toBe("hello");
    setLocale("ja");
    expect(t(testKey)).toBe("こんにちは");
  });

  it("重複キーを登録すると TypeError を投げる", () => {
    // 既存の core カタログキーと重複させる
    expect(() =>
      registerCatalog("__dup_test__", { en: { "ble.disconnected": "DUPLICATE" }, ja: {} })
    ).toThrow(TypeError);
    expect(() =>
      registerCatalog("__dup_test__", { en: {}, ja: { "ble.disconnected": "重複" } })
    ).toThrow(TypeError);
  });

  it("ja キー欠落 area は en のみ登録してエラーにならない", () => {
    const testKey = `__test_en_only_${Date.now()}`;
    expect(() =>
      registerCatalog("__en_only__", { en: { [testKey]: "only en" } })
    ).not.toThrow();
    setLocale("en");
    expect(t(testKey)).toBe("only en");
    // ja は en フォールバック
    setLocale("ja");
    expect(t(testKey)).toBe("only en");
  });
});
