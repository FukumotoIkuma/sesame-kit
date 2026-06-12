import { describe, it, expect, beforeEach } from "vitest";
import { t, setLocale, getLocale, resolveLocale } from "../src/i18n.js";

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
