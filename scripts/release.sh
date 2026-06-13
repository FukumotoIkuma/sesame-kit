#!/usr/bin/env bash
#
# リリース起動スクリプト: preflight チェック → v タグ作成 & push まで。
# npm publish と GitHub Release は tag-push トリガの CI (.github/workflows/release.yml) が行う
# (P5-8/ARCH-21: `npm publish --provenance` + trusted publishing のためローカルから publish しない)。
#
# 【バージョン bump 手順】
#   npm version <patch|minor|major> --no-git-tag-version --workspaces --include-workspace-root
#   # 上記で root / packages/core / packages/kit の version が一括更新される。
#   # その後、packages/kit/package.json の dependencies["@sesame-kit/core"] を
#   # 新しいバージョン文字列 (例: "0.6.3") に揃えること。
#   git add package.json packages/core/package.json packages/kit/package.json
#   git commit -m "chore: bump to vX.Y.Z"
#   git push origin main
#   # 準備ができたら:
#   npm run release
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

# ---- バージョン三分裂 / コアピン不整合 の防止 ----
ROOT_VERSION="$(node -p "require('./package.json').version")"
CORE_VERSION="$(node -p "require('./packages/core/package.json').version")"
KIT_VERSION="$(node -p "require('./packages/kit/package.json').version")"
KIT_CORE_PIN="$(node -p "require('./packages/kit/package.json').dependencies['@sesame-kit/core']")"

[ "$CORE_VERSION" = "$ROOT_VERSION" ] || \
  red "バージョン不一致: root=${ROOT_VERSION}, packages/core=${CORE_VERSION}。bump 手順 (スクリプトコメント参照) で三ファイルを一致させてください。"
[ "$KIT_VERSION" = "$ROOT_VERSION" ] || \
  red "バージョン不一致: root=${ROOT_VERSION}, packages/kit=${KIT_VERSION}。bump 手順 (スクリプトコメント参照) で三ファイルを一致させてください。"
[ "$KIT_CORE_PIN" = "$ROOT_VERSION" ] || \
  red "packages/kit の @sesame-kit/core ピン (${KIT_CORE_PIN}) が version (${ROOT_VERSION}) と不一致です。packages/kit/package.json の dependencies[\"@sesame-kit/core\"] を \"${ROOT_VERSION}\" に揃えてください。"
ok "root / core / kit バージョン一致: ${ROOT_VERSION}"

VERSION="$ROOT_VERSION"
TAG="v$VERSION"

# ---- 二重リリース防止 ----
git rev-parse "$TAG" >/dev/null 2>&1 && red "タグ $TAG が既に存在します。バージョンを上げてください。"
if npm view "sesame-kit@$VERSION" version >/dev/null 2>&1; then red "sesame-kit@${VERSION} は既に npm に公開済みです。"; fi
if npm view "@sesame-kit/core@$VERSION" version >/dev/null 2>&1; then red "@sesame-kit/core@${VERSION} は既に npm に公開済みです。"; fi
ok "リリース対象: @sesame-kit/core@${VERSION} + sesame-kit@${VERSION}"

# ---- タグ push (以降は CI が引き継ぐ) ----
git tag -a "$TAG" -m "$TAG"
git push origin "$TAG"
ok "タグ $TAG を push"

printf '\n%s のタグを push しました。npm publish (provenance 付き) と GitHub Release は\n   GitHub Actions の Release workflow が実行します: https://github.com/FukumotoIkuma/sesame-kit/actions\n' "$TAG"
