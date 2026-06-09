# Contributing to sesame-kit / コントリビューションガイド

Thanks for your interest in improving sesame-kit! This is an unofficial,
community-driven project. Both English and 日本語 are welcome in issues and PRs.
sesame-kit への貢献に感謝します。本プロジェクトは非公式・コミュニティ主導です。
Issue / PR は英語・日本語どちらでも歓迎します。

## Our core principle: report bugs as failing tests / 基本方針：バグは「失敗するテスト」で報告する

In the AI-coding era, the unit of a good bug report or fix is not prose — it's an
**executable test**. We strongly favor this loop:
AIコーディング時代、良いバグ報告・修正の単位は文章ではなく**実行可能なテスト**です。
私たちは次のループを強く推奨します:

```
failing test  →  fix  →  green test (CI proves it)
失敗するテスト →  修正 →  緑のテスト（CIが証明）
```

- **A bug** is best expressed as a `vitest` test that **fails** because the bug exists.
  **バグ**は、それが存在するがゆえに**落ちる** vitest テストで表すのが最良です。
- **A fix** is "done" when that test goes **green** and the rest of the suite stays green.
  **修正**は、そのテストが**緑**になり他のテストも緑のままなら「完了」です。
- **A feature** is best specified by a test describing the desired behavior first.
  **機能**は、望む挙動を記述するテストを先に書くのが最良です。

This is *strongly encouraged, not mandatory* — a plain-language bug report is still
welcome. But a failing test gets fixed faster, and an AI agent can usually generate
one from a reproduction. It removes the "can't reproduce" back-and-forth entirely.
これは*強い推奨であって必須ではありません*。文章だけのバグ報告も歓迎します。ただし失敗テスト付きは
修正が速く、AIエージェントなら再現手順から生成できます。「再現できない」のラリーをなくせます。

## Getting started / 準備

```bash
git clone https://github.com/FukumotoIkuma/sesame-kit.git
cd sesame-kit
npm ci
npm test            # run the test suite / テスト実行
npm run build:types # type-check via JSDoc -> .d.ts / 型チェック
```

Requirements / 必要環境: Node.js >= 20 (matches `package.json` `engines`).

## Development workflow / 開発の流れ

1. Fork and create a branch from `main`. / `main` からブランチを作成。
2. **Write a failing test first** for the bug/feature (see above). / まず失敗テストを書く。
3. Implement the change until tests pass. / テストが通るまで実装。
4. Run `npm test` and `npm run build:types` locally. / ローカルで両方を実行。
5. Update `README.md` / `README.ja.md` if behavior changed. / 挙動が変わるなら README を更新。
6. Open a PR; fill in the template. CI (Node 20/22) must pass. / PR を作成、テンプレを記入。CI を通す。

## Testing notes / テストの注意

- Tests use [vitest](https://vitest.dev/). Place tests under `tests/`. / テストは `tests/` 配下。
- The locale is pinned to `ja` during tests (`tests/setup.i18n.js`); production defaults to `en`.
  テスト時はロケールが `ja` 固定です（本番既定は `en`）。
- Don't commit real secrets, tokens, or device IDs — use fixtures/mocks.
  実トークン・秘密情報・端末IDはコミットしない（フィクスチャ/モックを使う）。

## Commit & PR conventions / コミット・PR 規約

- Conventional Commits are appreciated (`feat:`, `fix:`, `docs:`, `chore:` …). / Conventional Commits 推奨。
- Keep PRs focused; one logical change per PR. / PR は1論点に絞る。
- Link related issues (`Closes #123`). / 関連 Issue をリンク。

## Security / セキュリティ

Found a vulnerability? Do **not** open a public issue — see [SECURITY.md](./SECURITY.md).
脆弱性は公開 Issue にせず [SECURITY.md](./SECURITY.md) を参照してください。

## License / ライセンス

By contributing, you agree your contributions are licensed under the
[MIT License](../LICENSE) of this project.
貢献いただいた内容は本プロジェクトの [MIT ライセンス](../LICENSE)の下で提供されることに同意したものとします。
