import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // テスト時のみロケールを ja に固定 (既存の日本語アサートを維持。本番既定は en)。
    setupFiles: ["./tests/setup.i18n.js"],
  },
});
