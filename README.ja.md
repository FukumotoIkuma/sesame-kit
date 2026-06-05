<!-- [English](./README.md) | 日本語 -->

# sesame-kit — SESAME クラウド CLI & ライブラリ (非公式)

> English: [README.md](./README.md)

> **ステータス** — pre-1.0 でありバグが残っている可能性があります。実運用で概ね安定が確認できた時点で 1.0 にします。依存する場合はバージョンを固定してください。
>
> **免責** — 非公式。CANDY HOUSE とは無関係で、公式の承認も受けていません。公式アプリと同じ方法でクラウド API を叩くため、予告なく変更・破損する可能性があります。`secretKey` とトークンはロックの全権を握るので外部に漏らさないでください。自己責任で利用してください。

公式 SESAME iOS / Android アプリと同じ Cognito Consumer Client で、SESAME クラウドの WebSocket API を叩く Node.js 実装。ロックの開閉、Hub3 IR の発射・学習、デバイス管理、開閉履歴、電池残量を CLI とライブラリで提供する。`sesame serve` を使えば全機能を JSON-RPC として公開し、任意の言語から組み込める。

## 何ができるか

- ロック制御: 施錠 / 解錠 / トグル / SESAME Bot クリック
- Hub3 IR: 既存リモコンの発射、物理リモコンからの学習、リモコン / キー CRUD、プリセット DB 検索
- デバイス管理: 一覧、リネーム、削除、現在状態、state push 購読
- 履歴: ロック開閉履歴、電池残量履歴
- アクセス制御: NFC カード / キーパッド暗証番号の DB 同期
- 予約 / 会社・組織: スケジュール、法人機能 (社員・役割・デバイスグループ・鍵共有)
- Hub3 IoT: LED 調光、LTE リレー、ファーム更新、Matter ペアリング
- BLE 直接制御: Bluetooth でロックを直接操作する。autolock 等の設定系は BLE でのみ実機に反映される
- 言語非依存バックエンド: `sesame serve` が全機能を stdio / UDS / HTTP / WS / gRPC に JSON-RPC として公開する
- 対話モード、ライブラリ API

詳細は [コマンドリファレンス](./docs/commands.ja.md) / [ライブラリ利用](./docs/library.ja.md) / [設計ノート](./docs/architecture.ja.md) を参照。

## 出自 (Lineage)

公式 biz3 管理 Web ([CANDY-HOUSE/biz.candyhouse.co](https://github.com/CANDY-HOUSE/biz.candyhouse.co), MIT) の Node.js port。biz3 との差分は Cognito Client ID を公式 iOS / Android アプリと同じ Consumer Client にした点のみで、これにより refreshToken が事実上失効しない。biz3 の MIT ライセンスは [LICENSE.biz3](./LICENSE.biz3) に同梱する。port 対応表は [docs/architecture.md](./docs/architecture.ja.md) を参照。

---

## インストール

要件は Node.js 18 以上 (ESM / `node:` プロトコルを使用)。

```bash
git clone https://github.com/FukumotoIkuma/sesame-kit.git
cd sesame-kit
npm install
npm link        # グローバルに `sesame` コマンドを公開
# あるいは: node bin/sesame.js ...
```

ライブラリとして使う場合は `npm link sesame-kit`、または `npm install /path/to/sesame-kit`。

---

## セットアップ

`login` と `verify` で認証する。`verify` は companyID・ロック・Hub3 IR を自動で取り込む。

```bash
sesame init                 # 設定ディレクトリ初期化 (~/.config/sesame-hub3/)
sesame login your@email.com # email に確認コードを送る
sesame verify               # コードを入力。companyID / ロック / Hub3 IR を取り込む
```

デバイスを後から追加したら `sesame setup` で取り込みを再実行する。
IR を使うには Hub3 と Remote の両方の登録が必要。ロック開閉だけなら Lock の登録だけでよい。

---

## 基本操作

主語はデバイス: `sesame <device> <action>` (device は部分一致)。

```bash
sesame front unlock            # 解錠 (部分一致: sesame 玄関 unlock)
sesame front lock              # 施錠
sesame front toggle            # 現在状態で反転
sesame front status            # 状態 (施錠 / 解錠・位置)
sesame front autolock 30       # オートロック (BLE 必須。0=無効)
sesame send 停止 --remote ac   # Hub3 IR 発射
sesame                         # 全デバイスの対話メニュー (session)
```

経路 (cloud / BLE) は自動で選ばれる。固定するときは `--ble-only` / `--cloud-only` を付ける。
IR 学習・デバイス管理・予約・アクセス制御・会社組織・IoT・BLE の全コマンドは [docs/commands.md](./docs/commands.ja.md) を参照。

### 対話モード

TTY 環境 (`--json` 指定なし) では、足りない引数を矢印キー (↑↓) で選択できる。`sesame` だけでトップメニュー。
`--json` / 非 TTY では prompt を出さず、引数不足はエラーになる (CI 互換)。

---

## JSON 出力契約 (他言語からの subprocess 呼び出し)

`--json` を付けると、subprocess から扱える契約で動く。

- 成功: stdout に純 JSON を 1 件だけ出力する (進捗・ログは stderr)。
- エラー: stderr に `{"error": "...", "code": <n>}` を出し、非 0 で終了する。
- `--json` / 非対話では prompt を出さず、引数不足は即エラー。
- 終了コード: `0`=成功 / `1`=実行時エラー / `2`=使い方エラー。

```bash
sesame front status --json        # → stdout: {...}  exit 0
sesame login --json               # → stderr: {"error":"...","code":1}  exit≠0
```

出力 JSON の形は各コマンド固有。互換性の判定には契約バージョンを使う:
常駐デーモンの `status` が返す `contractVersion`、または `rpc.discover` の `info["x-contractVersion"]`。
機械契約の SemVer で、破壊的変更でのみ major が上がる。消費者は major を pin して fail-fast できる。

---

## 言語非依存バックエンド (`sesame serve`)

`sesame serve` は常駐 JSON-RPC 2.0 デーモン。1 回ログインして WS 接続を保持したまま、何度でも op を実行し、
イベントを push する。全機能を、どの言語からでも同一の API で呼べる。

```bash
sesame serve                          # Unix socket のみ (既定。~/.config/sesame-hub3/sesame.sock)
sesame serve --stdio                  # 埋め込み: 親が子プロセスとして spawn し stdin/stdout で対話
sesame serve --http 8080 --ws 8081 --grpc 50051   # ネットワーク経由 (token 認証)
```

5 つの繋ぎ口があり、どれも同じメソッドを公開する:

| 繋ぎ口 | 用途 | イベント | 認証 |
|---|---|---|---|
| stdio | 埋め込み (子プロセス) | `event.*` 通知 | 親の信頼を継承 |
| Unix socket | ローカル常駐・多クライアント | `event.*` 通知 | ファイル権限 0600 |
| HTTP | 全言語 / ブラウザ | `GET /events` (SSE) | `Authorization: Bearer <token>` |
| WebSocket | 全言語 / ブラウザ (全二重) | `event.*` 通知 | token |
| gRPC | 多言語の型付きスタブ生成 | `Subscribe` ストリーム | token (metadata) |

- メソッドは `rpc.discover` で機械可読に全列挙する (OpenRPC)。param 名・必須・型は実コードから抽出済み。
- ロック: `lock.lock` / `lock.unlock` / `lock.toggle` / `lock.status`。名前空間 op は `<ns>.<op>` で全公開する (`org.*` / `iot.*` / `access.*` …)。
- イベント: `events.subscribe {topics:["lockState","deviceUpdate"]}` で以後 `event.<topic>` 通知が届く。
- エラーは `{error:{code, message, data:{kind}}}`。`kind` は `not_authenticated` / `connection_lost` / `timeout` / `bad_params` / `not_implemented` / `internal` の 6 種。

別端末で `sesame serve` を起動しておけば、`sesame rpc` が UDS 越しにそのデーモンを叩く:

```bash
sesame rpc                                   # rpc.discover を人間向けの表で表示
sesame rpc lock.unlock --params '{"name":"front"}'
sesame rpc --subscribe lockState             # イベントを表示し続ける (Ctrl-C で停止)
sesame rpc --paths                           # 接続情報 (socket / token のパス) を JSON で出力
```

### 同梱クライアント

`clients/` に依存ゼロの薄いクライアントを同梱する。

- Python: `pip install ./clients/python` で、どこからでも `import sesame_client`。試すだけなら `PYTHONPATH=clients/python`。
- JS: `clients/js/sesame-client.mjs` を自プロジェクトにコピー、または相対 import。WebSocket をヘッダ認証で使うなら `npm i ws` (無ければ URL `?token=` にフォールバックする)。

```python
from sesame_client import SesameClient
c = SesameClient.unix()              # 既定 UDS パスを自動解決
print(c.status()); print(c.unlock("front"))
c.subscribe(["lockState"], lambda topic, payload: print("EVENT", topic, payload))
# HTTP: SesameClient.http("http://127.0.0.1:8080") / 埋め込み: SesameClient.stdio()
```

```js
import { SesameClient } from "./sesame-client.mjs";
const c = SesameClient.unix();                       // UDS (POSIX)
console.log(await c.unlock("front"));
await c.subscribe(["lockState"], (topic, p) => console.log("EVENT", topic, p)); // 常に await
const w = await SesameClient.ws("ws://127.0.0.1:8081"); // WebSocket (全二重)
```

gRPC は型付き。`src/serve/sesame.proto` が op ごとに型付きメソッドを持つ。
スタブ生成: `python -m grpc_tools.protoc -I src/serve --python_out=. --grpc_python_out=. src/serve/sesame.proto`。

認証境界: 対話ログインは CLI 専用で、デーモンには載らない。Unix socket は同一ユーザの任意プロセスが操作できる
(CLI と同じ境界)。HTTP / WS / gRPC は TCP のため、起動時に生成する loopback token を要求する。POSIX 専用
(Windows の UDS は非対象。stdio / HTTP / WS / gRPC は動く)。

---

## 設定ディレクトリ

優先順位: `--config-dir <path>` → `SESAME_HUB3_HOME` → `$XDG_CONFIG_HOME/sesame-hub3` → `~/.config/sesame-hub3`。

```
~/.config/sesame-hub3/
├── config.json         # devices / remotes / default / apiKeyId
├── tokens.json         # Cognito state (gitignore 必須)
├── login_state.json    # sign-in 進行中の一時状態
└── devices.json        # `devices` コマンドの dump
```

config スキーマと「単一 `devices{}` に保存する」設計は [docs/architecture.md](./docs/architecture.ja.md) を参照。

---

## ドキュメント

- [docs/commands.md](./docs/commands.ja.md) — 全 CLI コマンドのリファレンス
- [docs/library.md](./docs/library.ja.md) — Node ライブラリとしての利用
- [docs/architecture.md](./docs/architecture.ja.md) — 出自・設計判断・ファイル構成
- [docs/migration.md](./docs/migration.ja.md) — 旧版からの移行

---

## 既知の制限

- 常駐用途では auto-reconnect (exponential backoff 1s→10s)、token refresh callback、idle / sleep 検知が動く。
- 対応リモコンは自己学習 (`learnEmit`) のみ。プリセットリモコン (メーカー DB から選ぶ方式) の command 生成は未移植。`sesame ir learn` で物理リモコンを取り込んで使う。
- autolock はクラウド経由では設定できない。BLE の `sesame autolock` を使う。
- 未実装 op は Stripe 課金切替のみ。それ以外の biz3 op (社員 / グループ / 役割 / デバイスグループ / 鍵共有 / アクセス制御 / 予約 / IoT) はコマンド化済み。
- WS ステージの既定は `/public`。`/production` は使用しない (config に残っていれば load 時に `/public` へ書き換える)。
- AWS IoT WS は IPv4 必須。IPv6-only 回線では繋がらない。
- 新規ペアリング (未登録デバイスの登録) は未対応。登録済みデバイスの操作のみ。

---

## トラブルシュート

- `No tokens stored` / `No config at ...`: `sesame init` → `sesame login`、または `sesame migrate`。
- `UserNotFoundException`: 自動 SignUp は組み込み済み。それでも出る場合は Cognito 側の特殊ケース。
- `Cognito refresh returned no IdToken`: refreshToken が無効化された (公式アプリでログアウト等)。再 sign-in する。
- `triggerLock timeout`: `secretKey` 不一致、Hub3 オフライン、または WS の半開接続 (自動再接続で復帰)。
- `learn timeout`: Hub3 が REGISTER に入ったが波形を受け取れなかった。距離を縮める、別ボタンを試す。
- `apiKeyId required`: `webapi` 系は config.json に `apiKeyId` を入れる (biz3 dev console で発行)。

## 関連

- [CANDY-HOUSE/biz.candyhouse.co](https://github.com/CANDY-HOUSE/biz.candyhouse.co) — port 元の React 管理 Web "biz3"
- [SesameSDK_iOS_with_DemoApp](https://github.com/CANDY-HOUSE/SesameSDK_iOS_with_DemoApp) / [SesameSDK_Android_with_DemoApp](https://github.com/CANDY-HOUSE/SesameSDK_Android_with_DemoApp) — 参考にした公式 SDK
