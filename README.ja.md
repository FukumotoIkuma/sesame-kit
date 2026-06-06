<!-- [English](./README.md) | 日本語 -->

# sesame-kit — SESAME クラウド CLI & ライブラリ (非公式)

[![npm](https://img.shields.io/npm/v/sesame-kit)](https://www.npmjs.com/package/sesame-kit) [![license](https://img.shields.io/npm/l/sesame-kit)](./LICENSE) [![node](https://img.shields.io/node/v/sesame-kit)](https://nodejs.org)

> English: [README.md](./README.md)

> **ステータス** — pre-1.0 でありバグが残っている可能性があります。実運用で概ね安定が確認できた時点で 1.0 にします。依存する場合はバージョンを固定してください。
>
> **免責** — 非公式。CANDY HOUSE とは無関係・非公認であり、非公式クライアントの利用は同社の利用規約の範囲外となる可能性があります。公式アプリと同じ方法でクラウド API を叩くため、予告なく変更・破損する可能性があります。`secretKey` とトークンはロックの全権を握り、`~/.config/sesame-kit` に暗号化されず保存されるので外部に漏らさないでください。自己責任で利用してください。

**公式 SESAME アプリでできる操作を、あなたのコードから。** `sesame-kit` は登録済みの SESAME デバイスを公式 iOS / Android アプリと同じように操作します — 施錠 / 解錠、Hub3 IR（発射・学習）、デバイス管理、開閉履歴、電池残量。CLI、Node ライブラリ、`sesame serve`（JSON-RPC）で任意の言語から呼べます。`npm install` して、スクリプトやホームオートメーション、自作アプリに SESAME を組み込みましょう。

## 何ができるか

- ロック制御: 施錠 / 解錠 / トグル / SESAME Bot クリック
- Hub3 IR: 既存リモコンの発射、物理リモコンからの学習、リモコン / キー CRUD、プリセット DB 検索
- デバイス管理: 一覧、リネーム、削除、現在状態、state push 購読
- 履歴: ロック開閉履歴、電池残量履歴
- アクセス制御: NFC カード / キーパッド暗証番号の DB 同期
- 予約 / 会社・組織: スケジュール、法人機能 (社員・役割・デバイスグループ・鍵共有)
- Hub3 IoT: LED 調光、LTE リレー、ファーム更新、Matter ペアリング
- BLE 直接制御: Bluetooth でロックを直接操作します。autolock 等の設定系は BLE でのみ実機に反映されます
- 言語非依存バックエンド: `sesame serve` が全機能を stdio / UDS / HTTP / WS / gRPC に JSON-RPC として公開します
- 対話モード、ライブラリ API

詳細は [コマンドリファレンス](./docs/ja/commands.md) / [ライブラリ利用](./docs/ja/library.md) / [設計ノート](./docs/ja/architecture.md) を参照してください。

## 出自 (Lineage)

公式 biz3 管理 Web ([CANDY-HOUSE/biz.candyhouse.co](https://github.com/CANDY-HOUSE/biz.candyhouse.co), MIT) の Node.js port。biz3 との差分は Cognito Client ID を公式 iOS / Android アプリと同じ Consumer Client にした点のみで、これにより refreshToken が事実上失効しません。biz3 の MIT ライセンスは [LICENSE.biz3](./LICENSE.biz3) に同梱します。port 対応表は [docs/ja/architecture.md](./docs/ja/architecture.md) を参照してください。

---

## インストール

要件は Node.js 18 以上です (ESM / `node:` プロトコルを使用)。

```bash
npm install -g sesame-kit     # グローバル CLI: `sesame ...`
npx sesame-kit --help         # インストールせず実行
npm install sesame-kit        # プロジェクトにライブラリとして追加
```

ソースから:

```bash
git clone https://github.com/FukumotoIkuma/sesame-kit.git
cd sesame-kit && npm install && npm link
```

---

## セットアップ

デバイスは公式 SESAME アプリで先に登録済みである必要があります。本ツールは既存デバイスを操作するもので、新規ペアリングは行いません。

`login` と `verify` で認証します。`verify` はデバイスを**鍵ごと**（companyID・Hub3 IR リモコンも）`~/.config/sesame-kit/` に取り込むので、以後 `sesame <device> <action>` は追加の鍵設定なしで動きます。

```bash
sesame init                 # 設定ディレクトリ初期化 (~/.config/sesame-kit/)
sesame login your@email.com # email に確認コードを送る
sesame verify               # コードを入力。デバイスを鍵ごと取り込む
sesame devices              # 取り込んだデバイスと名前を一覧 (以降この名前を使う)
```

公式アプリでデバイスを後から追加したら `sesame setup` で取り込みを再実行します。
IR を使うには Hub3 と Remote の両方が登録済みである必要があります。ロック開閉だけなら Lock だけでよいです。

---

## 基本操作

引数なしで `sesame` を実行すると対話メニューが出ます。デバイスと各デバイスで使える操作が一覧されます。

```bash
sesame                         # デバイス→操作を選ぶ。  ↑↓ 移動 · → 決定 · ← 戻る · q 終了
```

操作を直接指定する場合、主語はデバイスです: `sesame <device> <action>`。`sesame devices` で出た自分のデバイス名を使います（部分一致。下の `front` は例）。

```bash
sesame front unlock            # 解錠 (部分一致: sesame 玄関 unlock)
sesame front lock              # 施錠
sesame front status            # 状態 (施錠 / 解錠・位置)
sesame front autolock 30       # オートロック (BLE 必須。0=無効)
sesame send 停止 --remote ac   # Hub3 IR 発射
```

経路 (cloud / BLE) は既定で自動選択されます（"auto" モード）。固定するときは `--ble-only` / `--cloud-only` を付けます。
全コマンドは [CLI リファレンス](./docs/ja/commands.md) を参照してください (IR 学習・デバイス管理・予約・アクセス制御・会社組織・IoT・BLE)。

> TTY では引数不足のコマンドは矢印キーのプロンプトにフォールバックします。`--json` / 非 TTY では prompt を出さず引数不足はエラーです (CI 互換)。

---

## JSON 出力契約 (他言語からの subprocess 呼び出し)

`--json` を付けると、subprocess から扱える契約で動きます。

- 成功: stdout に純 JSON を 1 件だけ出力します (進捗・ログは stderr)。
- エラー: stderr に `{"error": "...", "code": <n>}` を出し、非 0 で終了します。
- `--json` / 非対話では prompt を出さず、引数不足は即エラーです。
- 終了コード: `0`=成功 / `1`=実行時エラー / `2`=使い方エラー。

```bash
sesame front status --json        # → stdout: {...}  exit 0
sesame login --json               # → stderr: {"error":"...","code":1}  exit≠0
```

出力 JSON の形は各コマンド固有です。互換性の判定には契約バージョンを使います:
常駐デーモンの `status` が返す `contractVersion`、または `rpc.discover` の `info["x-contractVersion"]`。
機械契約の SemVer で、破壊的変更でのみ major が上がります。消費者は major を pin して fail-fast できます。

---

## 言語非依存バックエンド (`sesame serve`)

`sesame serve` は常駐 JSON-RPC 2.0 デーモンです。1 回ログインして WS 接続を保持したまま、何度でも op を実行し、
イベントを push します。全機能を、どの言語からでも同一の API で呼べます。

```bash
sesame serve                          # Unix socket のみ (既定。~/.config/sesame-kit/sesame.sock)
sesame serve --stdio                  # 埋め込み: 親が子プロセスとして spawn し stdin/stdout で対話
sesame serve --http 8080 --ws 8081 --grpc 50051   # ネットワーク経由 (token 認証)
```

5 つの接続方式 (トランスポート) があり、どれも同じメソッドを公開します:

| トランスポート | 用途 | イベント | 認証 |
|---|---|---|---|
| stdio | 埋め込み (子プロセス) | `event.*` 通知 | 親の信頼を継承 |
| Unix socket | ローカル常駐・多クライアント | `event.*` 通知 | ファイル権限 0600 |
| HTTP | 全言語 / ブラウザ | `GET /events` (SSE) | `Authorization: Bearer <token>` |
| WebSocket | 全言語 / ブラウザ (全二重) | `event.*` 通知 | token |
| gRPC | 多言語の型付きスタブ生成 | `Subscribe` ストリーム | token (metadata) |

- メソッドは `rpc.discover` で機械可読に全列挙します (OpenRPC)。param 名・必須・型は実コードから抽出済みです。
- ロック: `lock.lock` / `lock.unlock` / `lock.toggle` / `lock.status`。名前空間 op は `<ns>.<op>` で全公開します (`org.*` / `iot.*` / `access.*` …)。
- イベント: `events.subscribe {topics:["lockState","deviceUpdate"]}` で以後 `event.<topic>` 通知が届きます。
- エラーは `{error:{code, message, data:{kind}}}`。`kind` は `not_authenticated` / `connection_lost` / `timeout` / `bad_params` / `not_implemented` / `internal` の 6 種です。

別端末で `sesame serve` を起動しておけば、`sesame rpc` が UDS 越しにそのデーモンを叩きます:

```bash
sesame rpc                                   # rpc.discover を人間向けの表で表示
sesame rpc lock.unlock --params '{"name":"front"}'
sesame rpc --subscribe lockState             # イベントを表示し続ける (Ctrl-C で停止)
sesame rpc --paths                           # 接続情報 (socket / token のパス) を JSON で出力
```

HTTP 経由（任意の言語・クライアント不要）: `POST /rpc` に Bearer token を付けます。token は起動時に表示され `~/.config/sesame-kit/serve.token` にも保存されます。

```bash
sesame serve --http 8080                          # HTTP リスナを起動 (既定の serve は socket のみ)
TOKEN=$(cat ~/.config/sesame-kit/serve.token)    # 起動時に表示されるトークン
curl -s -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"lock.unlock","params":{"name":"front"}}' \
  http://127.0.0.1:8080/rpc
```

### 同梱クライアント

JSON-RPC をラップした薄いクライアントで、`c.unlock("front")` のように書けます。任意であり、上の `curl` でもクライアント無しで動きます。Node は `npm install sesame-kit` 後に `import { SesameClient } from "sesame-kit/client"`。Python はパッケージ同梱の単一ファイルです。

```js
import { SesameClient } from "sesame-kit/client";   // npm install sesame-kit の後
const c = SesameClient.unix();                       // 既定 Unix ソケット
console.log(await c.unlock("front"));
console.log(await c.call("device.history", { deviceUUID: "AB12CD34...", pageSize: 10 })); // 任意のメソッド。deviceUUID は `sesame devices` から
await c.subscribe(["lockState"], (topic, p) => console.log(topic, p)); // 常に await
```

```python
# Python — 連携ガイドの手順でインストールしてから:
from sesame_client import SesameClient
c = SesameClient.unix()                       # 既定 Unix ソケット
print(c.unlock("front"))
print(c.call("device.history", deviceUUID="AB12CD34...", pageSize=10))  # 任意のメソッド。deviceUUID は `sesame devices` から
```

インストール不要の HTTP 経路・Python のインストール（グローバル npm 含む）・メソッド/値の調べ方・イベント・gRPC・セキュリティは [連携ガイド](./docs/ja/integration.md) を参照してください。

gRPC は型付きです。`src/serve/sesame.proto` が op ごとに型付きメソッドを持ちます。
ソースチェックアウトでスタブ生成（`pip install grpcio-tools` 後）: `python -m grpc_tools.protoc -I src/serve --python_out=. --grpc_python_out=. src/serve/sesame.proto`。

認証境界: 対話ログインは CLI 専用で、デーモンには載りません。Unix socket は同一ユーザの任意プロセスが操作できます
(CLI と同じ境界)。HTTP / WS / gRPC は TCP のため、起動時に生成する loopback token を要求します。POSIX 専用です
(Windows の UDS は非対象です。stdio / HTTP / WS / gRPC は動きます)。

---

## Node から使う（インプロセス）

デーモンを別に立てず、Node アプリ内で直接ロックを操作するにはライブラリエントリを使います。CLI のログイン情報（`~/.config/sesame-kit`、`sesame login` を一度実行）を読み、接続と切断を自動で行います。

```js
import { SesameHub3 } from "sesame-kit";

await SesameHub3.use(async (hub) => {
  await hub.unlock("front");
  await hub.send("ac", "停止");        // Hub3 IR
});
```

直接 API（`deviceUUID` / `secretKey` 指定）、イベント購読、config ファイルでなくコードでトークンを渡す方法は [Node ライブラリガイド](./docs/ja/library.md) を参照してください。

---

## 設定ディレクトリ

優先順位: `--config-dir <path>` → `SESAME_KIT_HOME` → `$XDG_CONFIG_HOME/sesame-kit` → `~/.config/sesame-kit`。

```
~/.config/sesame-kit/
├── config.json         # devices / remotes / default / apiKeyId
├── tokens.json         # Cognito state (gitignore 必須)
├── login_state.json    # sign-in 進行中の一時状態
└── devices.json        # `devices` コマンドの dump
```

config スキーマと「単一 `devices{}` に保存する」設計は [docs/ja/architecture.md](./docs/ja/architecture.md) を参照してください。

---

## ドキュメント

ドキュメント全体: **[docs/ja/](./docs/ja/index.md)** ([English](./docs/en/index.md))。

- [クイックスタート](./docs/ja/quickstart.md) — 導入・ログイン・解錠まで
- [CLI リファレンス](./docs/ja/commands.md) — 全コマンド
- [BLE 直接制御](./docs/ja/ble.md) — クラウド非経由で Bluetooth 操作
- [Node ライブラリ](./docs/ja/library.md) — Node.js アプリへ埋め込み
- [他言語からの組み込み](./docs/ja/integration.md) — `sesame serve` 経由 (Python / JS / HTTP / WS / gRPC)
- [アーキテクチャ](./docs/ja/architecture.md) · [マイグレーション](./docs/ja/migration.md)

---

## 既知の制限

- 対応リモコンは自己学習 (`learnEmit`) のみです。プリセットリモコン (メーカー DB から選ぶ方式) の command 生成は未移植です。`sesame ir learn` で物理リモコンを取り込んで使います。
- autolock はクラウド経由では設定できません。BLE で `sesame <device> autolock <秒>`（例: `sesame front autolock 30`）を使います。
- 未実装 op は Stripe 課金切替のみです。それ以外の biz3 op (社員 / グループ / 役割 / デバイスグループ / 鍵共有 / アクセス制御 / 予約 / IoT) はコマンド化済みです。
- WS ステージの既定は `/public` です。`/production` は使用しません (config に残っていれば load 時に `/public` へ書き換えます)。
- AWS IoT WS は IPv4 必須です。IPv6-only 回線では繋がりません。
- 新規ペアリング (未登録デバイスの登録) は未対応です。登録済みデバイスの操作のみです。

---

## トラブルシュート

- `No tokens stored` / `No config at ...`: `sesame init` → `sesame login`、または `sesame migrate`。
- `UserNotFoundException`: 自動 SignUp は組み込み済みです。それでも出る場合は Cognito 側の特殊ケースです。
- `Cognito refresh returned no IdToken`: refreshToken が無効化されました (公式アプリでログアウト等)。再 sign-in します。
- `triggerLock timeout`: `secretKey` 不一致、Hub3 オフライン、または WS の半開接続 (自動再接続で復帰)。
- `learn timeout`: Hub3 が REGISTER に入りましたが波形を受け取れませんでした。距離を縮めるか、別のボタンを試してください。
- `apiKeyId required`: `webapi` 系は config.json に `apiKeyId` を入れます (biz3 dev console で発行)。

## 関連

- [CANDY-HOUSE/biz.candyhouse.co](https://github.com/CANDY-HOUSE/biz.candyhouse.co) — port 元の React 管理 Web "biz3"
- [SesameSDK_iOS_with_DemoApp](https://github.com/CANDY-HOUSE/SesameSDK_iOS_with_DemoApp) / [SesameSDK_Android_with_DemoApp](https://github.com/CANDY-HOUSE/SesameSDK_Android_with_DemoApp) — 参考にした公式 SDK
