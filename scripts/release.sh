#!/usr/bin/env bash
#
# リリース自動化: npm publish + git タグ + GitHub Release を一括で、順序とガード付きで実行する。
# バージョンは package.json のものを使う (このスクリプトは bump しない)。
#   先に: バージョンを上げてコミット & push しておくこと (npm version <patch|minor|major> --no-git-tag-version)。
#
# 使い方:
#   npm run release               # 2FA はブラウザで確認する (npm publish が自動でブラウザを開く)
#
set -euo pipefail
cd "$(dirname "$0")/.."

red() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }
ok()  { printf '\033[32m✓ %s\033[0m\n' "$1"; }

# ---- preflight (壊れた状態でリリースしない) ----
[ -z "$(git status --porcelain)" ] || red "作業ツリーが clean ではありません。先に commit してください。"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || red "main ブランチではありません (現在: $BRANCH)。"
git pull --ff-only origin main
ok "main は origin と同期済み"

npm test
ok "テスト緑"
npm run build
[ -z "$(git status --porcelain)" ] || red "build で生成物が変化しました。コミットしてから再実行してください (npm run build → git add -A && git commit)。"
ok "build 緑 (生成物 drift なし)"

VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"

# ---- 二重リリース防止 ----
git rev-parse "$TAG" >/dev/null 2>&1 && red "タグ $TAG が既に存在します。バージョンを上げてください。"
if npm view "sesame-kit@$VERSION" version >/dev/null 2>&1; then red "$VERSION は既に npm に公開済みです。"; fi
ok "リリース対象: sesame-kit@$VERSION"

# ---- ① npm publish (2FA はブラウザで確認) ----
npm publish
ok "npm publish 完了"

# ---- ② git タグ ----
git tag -a "$TAG" -m "$TAG"
git push origin "$TAG"
ok "タグ $TAG を push"

# ---- ③ GitHub Release (前タグからのコミットでノート自動生成) ----
gh release create "$TAG" --title "$TAG" --generate-notes
ok "GitHub Release $TAG を作成"

printf '\n🎉 %s をリリースしました (npm + タグ + GitHub Release)\n' "$TAG"
