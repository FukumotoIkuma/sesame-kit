import { configDefaults, defineConfig } from "vitest/config";

// 統合テスト: 実プロセスを spawn する e2e (packages/kit/tests/cli/json-contract, session-ui) と、
// in-process でデーモン/サーバ (gRPC/HTTP/WS/socket) を立てる packages/kit/tests/serve/** 群。
// いずれも実 fd・実ポート・タイミング窓 (例: gRPC Subscribe の 1500ms) に依存するため、
// CPU を飽和させる並列ユニットと同時に走らせると遅延して偽陽性で落ちる。
// → 別 project に分離し、ファイル単位で直列実行。package.json の test では unit を流し
//    切ってから e2e を単独実行し (`--project`)、ユニットとの CPU 競合自体を無くす。
// (workspace 分割後も serve/spawn 系は kit に集約されているため、すべて packages/kit/tests 配下。)
const INTEGRATION = [
  "packages/kit/tests/serve/**/*.test.js",
  // bin/sesame.js を execFileSync で spawn する CLI 契約テスト群。unit の並列負荷下では
  // node 起動が test timeout を超えて偽陽性で落ちる (HEAD 時点から観測された flake) ため、
  // 上記コメントの設計どおり全 spawn 系をこの直列 project に置く。
  "packages/kit/tests/cli/json-contract.test.js",
  "packages/kit/tests/cli/arg-router.test.js",
  "packages/kit/tests/cli/contract.test.js",
  "packages/kit/tests/cli/status-transport.test.js",
  "packages/kit/tests/session-ui.test.js",
];

// テスト時のみロケールを ja に固定 (既存の日本語アサートを維持。本番既定は en)。
// setup は core/kit 両 project 共通で使う単一ファイル (@sesame-kit/core/i18n を叩く)。
const SETUP = ["./packages/core/tests/setup.i18n.js"];

// テスト探索のルート (両ワークスペースの tests/ を含める。glob は packages/* 配下に固定して
// ルート直下に残る一時ファイル等を拾わない)。
const TEST_INCLUDE = ["packages/*/tests/**/*.test.js"];

// `.claude/worktrees/*` には開発中エージェントが作る作業用 git worktree (このリポジトリの
// 完全コピー = tests/ 込み) が入る。探索すると同一テストを多重実行して衝突するため除外。
const BASE_EXCLUDE = [...configDefaults.exclude, "**/.claude/**"];

// projects は自己完結 (extends に頼らず各 project が setup/exclude を明示) — これにより
// `vitest run --project unit|e2e` のフィルタが確実に効き、ファイルが二重計上されない。
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: TEST_INCLUDE,
          setupFiles: SETUP,
          exclude: [...BASE_EXCLUDE, ...INTEGRATION], // 統合テストは e2e project へ
        },
      },
      {
        test: {
          name: "e2e",
          setupFiles: SETUP,
          include: INTEGRATION,
          exclude: BASE_EXCLUDE,
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
