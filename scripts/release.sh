#!/usr/bin/env bash
#
# リリース起動スクリプト: preflight チェック → v タグ作成 & push まで。
# npm publish と GitHub Release は tag-push トリガの CI (.github/workflows/release.yml) が行う
# (P5-8/ARCH-21: `npm publish --provenance` + trusted publishing のためローカルから publish しない)。
# バージョンは package.json のものを使う (このスクリプトは bump しない)。
#   先に: バージョンを上げてコミット & push しておくこと (npm version <patch|minor|major> --no-git-tag-version)。
#
# 使い方:
#   npm run release
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

# ---- タグ push (以降は CI が引き継ぐ) ----
git tag -a "$TAG" -m "$TAG"
git push origin "$TAG"
ok "タグ $TAG を push"

printf '\n🚀 %s のタグを push しました。npm publish (provenance 付き) と GitHub Release は\n   GitHub Actions の Release workflow が実行します: https://github.com/FukumotoIkuma/sesame-kit/actions\n' "$TAG"
