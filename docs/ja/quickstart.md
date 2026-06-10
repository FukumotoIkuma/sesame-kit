<!-- [English](../en/quickstart.md) | 日本語 -->

# クイックスタート

> [English](../en/quickstart.md) · [ドキュメント目次](./index.md)

数分でコマンドラインからロックを開けます。

## 1. インストール

```bash
npm install -g sesame-kit     # グローバル CLI: `sesame ...`
# インストールせず実行: npx sesame-kit ...
```

Node.js 20 以上が必要です。

## 2. サインイン

```bash
sesame init                 # ~/.config/sesame-kit/ を作成 (初回のみ)
sesame login your@email.com # 確認コードがメールに届く
sesame verify               # コードを入力
```

`verify` がデバイスを鍵ごと自動で取り込むので、直後から操作できます。

## 3. ロックを操作する

`sesame` を引数なしで実行すると対話メニューが表示され、デバイスと各デバイスで使える操作が一覧されます。

```bash
sesame      # ↑↓ 移動 · →（または Enter）決定 · ←（または Esc）戻る · q 終了
```

やりたいことが決まっていれば直接実行することもできます。主語はデバイスです: `sesame <device> <action>`（`sesame devices` / `sesame locks ls` に出る正確な名前）。

```bash
sesame front status            # 現在状態 (施錠 / 解錠)
sesame front unlock            # 解錠
sesame front lock              # 施錠
```

## 次のステップ

- CLI の全コマンド: [CLI リファレンス](./commands.md)
- クラウドを介さず Bluetooth で操作する: [BLE 直接制御](./ble.md)
- 他言語から呼び出す: [`sesame serve` 連携](./integration.md)
- Node コードから使う: [Node ライブラリ](./library.md)

> クラウド制御にはサインインが必要です。BLE 単独の制御はサインインなしで動作します — [BLE 直接制御](./ble.md)を参照。
