<!-- [English](./migration.md) | 日本語 -->

# 旧版からのマイグレーション

> English: [migration.md](./migration.md)

旧 `sesame-hub3` (CLI=`hub3-ir`) からのアップグレード:

- CLI 名は `sesame` に変更 (旧 `hub3-ir` は廃止)。シェルスクリプトを使っている場合は置換。
- 設定ディレクトリ (`~/.config/sesame-hub3`) は変更なし、既存 config.json はそのまま使える。
- `locks` キーは自動で追加される (空 `{}` から開始)。`sesame locks sync-from-devices` で `devices` コマンドの出力から取り込み可能。

旧 `.env + .tokens.json + keys.json` からの移行は `sesame migrate` がそのまま使える。
