import { configDefaults, defineConfig } from "vitest/config";

// 統合テスト: 実プロセスを spawn する e2e (tests/cli/json-contract, tests/session-ui) と、
// in-process でデーモン/サーバ (gRPC/HTTP/WS/socket) を立てる tests/serve/** 群。
// いずれも実 fd・実ポート・タイミング窓 (例: gRPC Subscribe の 1500ms) に依存するため、
// CPU を飽和させる並列ユニットと同時に走らせると遅延して偽陽性で落ちる。
// → 別 project に分離し、ファイル単位で直列実行する。さらに package.json の test では
//    unit を流し切ってから e2e を単独実行し、ユニットとの CPU 競合自体を無くす。
const INTEGRATION = [
  "tests/serve/**/*.test.js",
  "tests/cli/json-contract.test.js",
  "tests/session-ui.test.js",
];

// `.claude/worktrees/*` には開発中エージェントが作る作業用 git worktree (このリポジトリの
// 完全コピー = tests/ 込み) が入る。探索すると同一テストを多重実行して衝突するため除外。
const COMMON_EXCLUDE = [...configDefaults.exclude, "**/.claude/**"];

export default defineConfig({
  test: {
    // テスト時のみロケールを ja に固定 (既存の日本語アサートを維持。本番既定は en)。
    setupFiles: ["./tests/setup.i18n.js"],
    exclude: COMMON_EXCLUDE,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          exclude: [...COMMON_EXCLUDE, ...INTEGRATION], // 統合テストは e2e project へ
        },
      },
      {
        extends: true,
        test: {
          name: "e2e",
          include: INTEGRATION,
          fileParallelism: false, // 直列実行で実ポート/タイミングの競合を避ける
          // 直列・単独実行が構造的な対処。これは subprocess/サーバ起動が遅い e2e 自体に
          // 与える妥当な上限 (ユニット既定 5s は subprocess 4 連発などに足りない)。
          testTimeout: 30000,
          hookTimeout: 30000,
        },
      },
    ],
  },
});
