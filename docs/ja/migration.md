<!-- [English](../en/migration.md) | 日本語 -->

# 旧版からのマイグレーション

> [English](../en/migration.md) · [ドキュメント目次](./index.md)

旧 `sesame-hub3` (CLI=`hub3-ir`) からのアップグレード:

- CLI 名は `sesame` に変更 (旧 `hub3-ir` は廃止)。シェルスクリプトを使っている場合は置換。
- 設定とトークンは `~/.config/sesame-kit` に保存されます。
- config は単一の `devices` マップに保存されます。`locks` は読み込み時に毎回再構築される派生 view で、保存されるキーではありません。`sesame locks sync-from-devices` でサーバから `devices` を取り込みます。

旧 `.env + .tokens.json + keys.json` からの移行は `sesame migrate` がそのまま使えます。
