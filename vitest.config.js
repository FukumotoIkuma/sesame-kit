import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // テスト時のみロケールを ja に固定 (既存の日本語アサートを維持。本番既定は en)。
    setupFiles: ["./tests/setup.i18n.js"],
    // `.claude/worktrees/*` には開発中エージェントが作る作業用 git worktree
    // (このリポジトリの完全コピー = tests/ 込み) が入る。デフォルト探索はそれらまで
    // 拾い、同一テストを多重に並列実行する。ポート / ~/.config / 一時ファイルを共有する
    // e2e・config 系テストが衝突して偽陽性で落ちるため、.claude 配下を探索から除外する。
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
});
