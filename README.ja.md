<!-- [English](./README.md) | 日本語 -->

# sesame-kit — SESAME スマートロック CLI & ライブラリ (BLE + クラウド・非公式)

[![CI](https://github.com/FukumotoIkuma/sesame-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/FukumotoIkuma/sesame-kit/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/sesame-kit)](https://www.npmjs.com/package/sesame-kit) [![license](https://img.shields.io/npm/l/sesame-kit)](./LICENSE) [![node](https://img.shields.io/node/v/sesame-kit)](https://nodejs.org)

> English: [README.md](./README.md)

> **ステータス** — pre-1.0 でありバグが残っている可能性があります。実運用で概ね安定が確認できた時点で 1.0 にします。依存する場合はバージョンを固定してください。
>
> **免責** — 非公式。CANDY HOUSE とは無関係・非公認であり、非公式クライアントの利用は同社の利用規約の範囲外となる可能性があります。公式アプリと同じ方法でクラウド API を叩くため、予告なく変更・破損する可能性があります。`secretKey` とトークンはロックの全権を握り、`~/.config/sesame-kit` に暗号化されず保存されるので外部に漏らさないでください。自己責任で利用してください。

**SESAME を、自分のコードから——しかも Bluetooth で直接・オフラインに操作できます。** `sesame-kit` は登録済みの SESAME デバイスを **BLE（クラウド不要・低遅延）** とクラウドの両方で操作します — 施錠 / 解錠、Hub3 IR、デバイス管理、開閉履歴。CLI、Node ライブラリ、`sesame serve`（JSON-RPC）で任意の言語から。スクリプト・ホームオートメーション・Raspberry Pi に SESAME を組み込みましょう。

<p align="center"><img src="https://raw.githubusercontent.com/FukumotoIkuma/sesame-kit/main/assets/demo.ja.gif" alt="sesame-kit デモ" width="800"></p>

## 何ができるか

- **BLE 直接制御**: Bluetooth でロックを直接操作（クラウド不要・オフライン・低遅延）。autolock 等の設定系は BLE でのみ実機に反映されます。OS3 **と OS2** のプロトコルを純 JS で実装（Raspberry Pi でも動作・アダプタ差し替え可）
- ロック制御: 施錠 / 解錠 / トグル / SESAME Bot クリック（BLE / クラウドを自動選択）。OS2 デバイス（SESAME 2/3/4・Bot1・Bike1）はライブラリの `SesameOS2Ble` から BLE で操作
- **BLE 専用の実機設定**: 角度キャリブレーション（`configureLockPosition`：施錠 / 解錠の目標角）、`magnet`、autolock、Open Sensor 自動施錠（`opSensorControl`）、BLE 送信出力（`setBleTxPower`）、アドバタイズ productType（`sendAdvProductType`）、工場出荷リセット（`reset`） — クラウドに相当機能はなく実機へ直接書き込み
- **BLE 専用の読み出し**: ファームウェアの `versionTag`、実機履歴の読み出し・1 件単位の削除、直近の `mechSetting` / `opsSetting`、login 時の時刻同期（デバイス時刻が 3 秒以上ずれていたら自動補正）
- 全機種の advertise パース（`parseAdvertisement`）: productType・登録済みフラグ・接続可否・deviceUUID
- **鍵なしの BLE デバイス発見**（`listNearbyDevices()` / `SesameBle.listNearby()`、`sesame ble scan` でも可）: 1 回のスキャンで近接 SESAME を `{ deviceUUID, productType, model, kind, isRegistered, advTagB1, isConnectable, rssi, localName, address, peripheral }` のリストで返します（`secretKey` 不要）。結果の `peripheral` を `SesameBle.fromDiscovery()` に渡せば再スキャンなしで接続できます（例: `isRegistered: false` の工場出荷デバイスを見つけて `registerOnce` に渡す）
- **堅牢な BLE リンク**: 既定の `NobleTransport` は peripheral の切断イベントを購読してセッションへ伝播し、リンク断（相手側切断 / 圏外）時に処理中リクエストを **timeout を待たず即座に fail-fast** させます。write は数回の指数バックオフ付きリトライ後にリンク断とみなします（`CHSesameOS3.kt` `transmit` の「リトライ→最終的に切断」を移植）。MTU は CoreBluetooth が自動協商します（noble に能動的な `requestMtu` API はなく、SDK の iOS 経路と同じ挙動）
- **BLE ペアリング**: 工場出荷デバイスを BLE で登録（ECDH ハンドシェイク + サーバ認証）し、その `secretKey` を取得 — OS3（`SesameBle.registerOnce()`）/ OS2（`SesameOS2Ble.registerOnce()`）
- **生体・アクセス制御の BLE 登録**: Touch / Touch Pro / Face / Palm へのカード / 指紋 / 暗証番号 / 顔 / 掌紋の登録（`SesameBle#biometric`）。`registerDelegate` は登録以外のデバイス publish も配信します — Touch Pro `mechStatus`・電池電圧・子鍵スロット（`PUB_KEY_SESAME`）・スロット非サポートフラグ・BLE 送信出力。読み取り専用サブセットは CLI に `sesame ble ...` として配線済み（汎用 `sesame ble invoke` / `os2-invoke` と `ota` / `reset` / `wifi` / `position` も追加済み）で、登録 / 書き込み系は Node と `sesame serve` の型付き `ble.biometric.*` RPC メソッド（例: `ble.biometric.cardAdd`・`ble.biometric.passcodeAdd`）からも呼べます。`ble.invoke` は脱出口として併存します
- **SESAME Bike3 指紋の BLE 対応**: Bike3 の指紋の一覧 / 削除 / 改名・登録モードの取得 / 設定（`SesameBle#fingerPrint`）— Bike3 は Bike2（解錠）に指紋 capability を足した型なので、指紋サブセットのみを露出。読み取りは CLI でも利用可能で、すべての op が型付き `ble.fingerPrint.*` RPC メソッド（例: `ble.fingerPrint.fingerPrints`・`ble.fingerPrint.fingerPrintDelete`）からも呼べます
- **SESAME Bot2 / Bot3 スクリプトの BLE 対応**: index 指定でスクリプト実行・アクティブスクリプトの切替・現在スクリプトの取得・名前一覧の取得・スクリプトの書き込み（`SesameBle#script`）— 読み取り・index 実行（`sesame ble script-run`）・切替（`sesame ble script-select`）・書き込み（`sesame ble script-write`）はすべて CLI でも利用可能で、型付き `ble.script.*` RPC メソッド（例: `ble.script.click`・`ble.script.selectScript`）からも呼べます
- **WifiModule2 の BLE 対応**: Wi-Fi プロビジョニングと子鍵登録（`SesameBle#wifi`）
- **Hub3 の BLE 対応**: Wi-Fi プロビジョニング（SSID スキャン / SSID / パスワード）・子鍵の削除・接続種別（Wi-Fi / LTE）の読み出し（`SesameBle#hub3`）
- **BLE 経由ファームウェア更新**（DFU / OTA）の開始コマンド: Hub3（`MOVE_TO`）/ WM2（`OPEN_OTA_SERVER`）。OS3 ロックは SDK と同じ「コマンド無し」経路（`SesameBle#updateFirmware`、CLI は `sesame ble ota`）。DFU バイナリ転送自体（Nordic DFU）は非同梱 — [既知の制限](#既知の制限)参照
- Hub3 IR: 既存リモコンの発射、物理リモコンからの学習、リモコン / キー CRUD、プリセット DB 検索
- デバイス管理: 一覧、リネーム、削除、現在状態、state push 購読
- 履歴: ロック開閉履歴、電池残量履歴
- アクセス制御: NFC カード / キーパッド暗証番号の DB 同期。加えて **BLE 経由の一括登録** (`access cards enroll` / `access passcodes enroll` — カードのタップ / 暗証番号の入力をまとめて 1 回で登録。experimental)
- 予約 / 会社・組織: スケジュール、法人機能 (社員・役割・デバイスグループ・鍵共有)
- Hub3 IoT: LED 調光、LTE リレー、ファーム更新、Matter ペアリング
- 言語非依存バックエンド: `sesame serve` が cloud/Biz3 機能と登録済み BLE 操作を stdio / UDS / HTTP / WS / gRPC に JSON-RPC として公開します
- 対話モード、ライブラリ API

詳細は [コマンドリファレンス](./docs/ja/commands.md) / [ライブラリ利用](./docs/ja/library.md) / [設計ノート](./docs/ja/architecture.md) を参照してください。

---

## インストール

要件は Node.js 20 以上です (CI と一致 / ESM・`node:` プロトコルを使用)。

> **注（publish 準備中）:** `@sesame-kit/core` は現在 npm に未公開（試すと E404）で、npm 上の `sesame-kit` 最新は分割前の 0.6.1 であり依存構成も異なります。0.6.2+ がリリースされるまでは、**下記の git clone + workspace 手順をお使いください**。両パッケージ publish 後にこの注記を撤去します。

ソースから（現在の推奨手順）:

```bash
git clone https://github.com/FukumotoIkuma/sesame-kit.git
cd sesame-kit && npm install   # workspace install で @sesame-kit/core ↔ sesame-kit を結線
```

publish 後（0.6.2+）:

```bash
npm install -g sesame-kit       # グローバル CLI: `sesame ...`（+ `sesame serve` デーモン）
npx sesame-kit --help           # インストールせず実行
npm install @sesame-kit/core    # プロジェクトにライブラリとして追加（BLE + クラウド。CLI/serve 依存なし）
```

本リポジトリは npm workspace で 2 つの公開パッケージに分割されています:

- **`@sesame-kit/core`** — ライブラリ本体（BLE + クラウド転送・認証・暗号・デバイス管理）。アプリ内利用はこれを import します（`import { SesameHub3 } from "@sesame-kit/core"`）。
- **`sesame-kit`** — `sesame` CLI・`sesame serve` JSON-RPC デーモン・同梱の薄いクライアント。`@sesame-kit/core` に依存します。インストールすると core も推移的に入り、`sesame-kit/client` は同梱 JS クライアントを指します。

### 依存関係とセキュリティ方針

本番依存ツリーは意図的に小さく保っています。`npm install sesame-kit` が引き込む必須 runtime 依存は次の 3 つです。加えて optional のネイティブパッケージ `@abandonware/noble`（後述）のビルドも試みます（失敗しても無視されます）:

- `ws` — クラウド WebSocket transport（コア）
- `commander` — CLI 引数パース（`sesame` bin のコア）
- `@inquirer/prompts` — 対話 CLI プロンプト（login / setup フロー）

この 3 つは CLI とクラウド transport（kit の主入口）が動作に必須なため `dependencies` に残しています。それより重いものはすべてオプトインです:

- **AES-CMAC は内製実装**（`packages/core/src/aes-cmac.js`、RFC 4493 準拠、`node:crypto` の AES-128-ECB/CBC のみ使用）。従来使っていた `node-aes-cmac` は 2014 年から無メンテで、ロックコマンド MAC / セッション鍵導出というセキュリティ要所で deprecated な `Buffer` コンストラクタを使っていたため除去しました。RFC 4493 §4 の全テストベクタ (Examples 1–4) を `tests/crypto/aes-cmac.test.js` に固定しています。
- **gRPC フレーミング**（`sesame serve --grpc`）には `@grpc/grpc-js` + `@grpc/proto-loader` が必要です。**optional peerDependencies** として遅延 import しており、無くても他の全フレーミング (stdio / UDS / HTTP / WS) は通常どおり動作し、`--grpc` は導入手順つきのエラーで失敗します。有効化:

  ```bash
  npm i @grpc/grpc-js @grpc/proto-loader
  ```

- **対話セッション TUI**（`sesame session`）には `ink` + `react` + `ink-select-input` + `ink-text-input` が必要です（同じく optional peerDependencies・動的 import）。有効化:

  ```bash
  npm i ink react ink-select-input ink-text-input
  ```

- `npx sesame-kit` / グローバルインストールの注意: npm は optional peer を自動導入しないため、gRPC / セッション TUI を使う場合は上記 extras を併せて入れてください（例: `npm i -g sesame-kit @grpc/grpc-js @grpc/proto-loader`）。他のコマンドはそのまま動きます。

BLE 対応はネイティブパッケージ `@abandonware/noble`（`optionalDependencies` 掲載の**任意**依存）に依存します。npm はインストール時にビルドを試みますが、失敗した場合（例: Bluetooth ツールチェーン無し・`node-gyp` 前提条件が無い環境）はエラーが無視され、残りの kit はそのままインストールされ動作します。クラウド / CLI / `sesame serve` 経路には noble は**不要**です。

ネイティブ BLE ツールチェーンは `node-gyp` を引き込み、これが従来は脆弱な `node-tar` および関連パッケージの transitive コピーを連れてきていました。package.json の `overrides` で 5 件のパッケージをパッチ版／現行 major に固定しています:

```json
"overrides": {
  "@mapbox/node-pre-gyp": "^2.0.3",
  "cacache":              "^20.0.1",
  "make-fetch-happen":   "^15.0.6",
  "node-gyp":            "^12.4.0",
  "tar":                 "^7.5.16"
}
```

`tar@^7.5.16` がセキュリティ修正の核（アーカイブ展開 CVE へのパッチ）です。`node-gyp`・`cacache`・`make-fetch-happen`・`@mapbox/node-pre-gyp` は transitive の advisory を解消するため現行 major に引き上げています。5 件はいずれも任意のネイティブビルドが利用する API と互換です。これらの override により `npm audit --omit=dev` は脆弱性 **0** を報告します。コア kit の本番（非 dev）依存に既知の advisory はありません。

---

## セットアップ

通常は公式 SESAME アプリで登録済みのデバイスを取り込みます。工場出荷デバイスも `sesame ble register` / `sesame ble os2-register` または Node/RPC の register API で BLE ペアリングできます。

`login` と `verify` で認証します。`verify` はデバイスを**鍵ごと**（companyID・Hub3 IR リモコンも）`~/.config/sesame-kit/` に取り込むので、以後 `sesame <device> <action>` は追加の鍵設定なしで動きます。

```bash
sesame init                 # 設定ディレクトリ初期化 (~/.config/sesame-kit/)
sesame login your@email.com # email に確認コードを送る
sesame verify               # コードを入力。デバイスを鍵ごと取り込む
sesame devices              # 取り込んだデバイスと名前を一覧 (以降この名前を使う)
sesame logout               # このセッションの token を失効 + サーバ側でこのデバイスを解除し、ローカル token を削除
```

公式アプリでデバイスを後から追加したら `sesame setup` で取り込みを再実行します。
IR を使うには Hub3 と Remote の両方が登録済みである必要があります。ロック開閉だけなら Lock だけでよいです。

旧構成（`.env` / `keys.json`）からの移行は `sesame migrate [srcDir]` です。旧ファイルを**リポジトリ直下に置く必要はありません** — それらが置いてあるディレクトリを `srcDir` で指定してください（省略時はカレントディレクトリ）。トークンは意図的に取り込まないので、移行後に `sesame login` を実行します。

---

## 基本操作

引数なしで `sesame` を実行すると対話メニューが出ます。デバイスと各デバイスで使える操作が一覧されます。

```bash
sesame                         # デバイス→操作を選ぶ。  ↑↓ 移動 · → 決定 · ← 戻る · q 終了
```

操作を直接指定する場合、主語はデバイスです: `sesame <device> <action>`。`sesame devices` または `sesame locks ls` で出た正確なデバイス名を使います（下の `front` は例）。

```bash
sesame front unlock            # 解錠
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
- 終了コード: `0`=成功 / `1`=実行時エラー / `2`=使い方エラー。BLE 環境エラー (`BLE_UNAUTHORIZED` / `BLE_UNSUPPORTED` / `BLE_POWERED_OFF` / `BLE_INIT_TIMEOUT`) は実行環境のランタイム障害であり使い方エラーではない → 終了コード `1`（`--json` の封筒に `bleCode` が付きます）。

```bash
sesame front status --json        # → stdout: {...}  exit 0
sesame login --json               # → stderr: {"error":"...","code":1}  exit≠0
```

出力 JSON の形は各コマンド固有です。互換性の判定には契約バージョンを使います:
常駐デーモンの `status` が返す `apiVersion`、または `rpc.discover` の `info["x-apiVersion"]`（旧称 `contractVersion` / `x-contractVersion` はエイリアスとして残っています）。
機械契約の SemVer で、破壊的変更でのみ major が上がります。消費者は major を pin して fail-fast できます。

---

## 言語非依存バックエンド (`sesame serve`)

`sesame serve` は常駐 JSON-RPC 2.0 デーモンです。1 回ログインして WS 接続を保持したまま、何度でも op を実行し、
イベントを push します。クラウド / Biz3 機能は型付き RPC として公開します。BLE 操作も型付きメソッドとして公開され、各 facade op が `ble.<op>` / `ble.os2.<op>`（例: `ble.script.click`・`ble.biometric.cardAdd`・`ble.hub3.setWifiSSID`）として名前付きパラメータで生成 SDK に現れます（合計 76 の型付き BLE メソッド、すべて `experimental`）。汎用の `ble.invoke` / `ble.os2.invoke` 文字列ディスパッチは脱出口として併存します。

```bash
sesame serve                          # Unix socket のみ (既定。~/.config/sesame-kit/sesame.sock)
sesame serve --stdio                  # 埋め込み: 親が子プロセスとして spawn し stdin/stdout で対話
sesame serve --http 8080 --ws 8081 --grpc 50051   # ネットワーク経由 (token 認証)
```

5 つの接続方式 (トランスポート) があり、同じ RPC カタログを使います。イベントは HTTP では `GET /events`、gRPC では `Subscribe` を使います:

| トランスポート | 用途 | イベント | 認証 |
|---|---|---|---|
| stdio | 埋め込み (子プロセス) | `event.*` 通知 | 親の信頼を継承 |
| Unix socket | ローカル常駐・多クライアント | `event.*` 通知 | ファイル権限 0600 |
| HTTP | 全言語 / ブラウザ | `GET /events` (SSE) | `Authorization: Bearer <token>` |
| WebSocket | 全言語 / ブラウザ (全二重) | `event.*` 通知 | token |
| gRPC | 多言語の型付きスタブ生成 | `Subscribe` ストリーム | token (metadata) |

- メソッドは `rpc.discover` で機械可読に全列挙します (OpenRPC。契約 1.4.0 時点で 205 メソッド)。param 名・必須・型は実コードから抽出済みです。
- ロック: `lock.lock` / `lock.unlock` / `lock.toggle` / `lock.status`。加えて `lock.setAutolock` (experimental。`transport: "cloud" | "ble"` を受け、実機に効くのは BLE 経路のみ)。名前空間 op は `<ns>.<op>` で全公開します (`org.*` / `iot.*` / `access.*` / `ir.*` / `devices.*` / `config.sync*` / `ble.*` / `cloud.ping` …)。`access.registerPasscodes`・`ir.addRemoteToMatter`・型付き BLE op (`ble.script.*` / `ble.biometric.*` / `ble.fingerPrint.*` / `ble.remoteNano.*` / `ble.wifi.*` / `ble.hub3.*` / `ble.os2.*` とスタンドアロン op `ble.register` / `ble.updateFirmware` / `ble.reset` / `ble.position` / `ble.history` / `ble.scan` / `ble.magnet` … — 合計 76 の型付き `ble.*` メソッド）を含みます。汎用の `ble.invoke` / `ble.os2.invoke` は任意の BLE op を文字列ディスパッチする脱出口 facade です。
- イベント: `events.subscribe {topics:["lockState","deviceUpdate"]}` で以後 `event.<topic>` 通知が届きます。
- エラーは `{error:{code, message, data:{kind}}}`。`kind` は `not_authenticated` / `bad_params` / `timeout` / `connection_lost` / `rejected` / `internal` / `not_implemented` の 7 種です。

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

`sesame rpc` から HTTP リスナへ繋ぐこともできます（token は `serve.token` から自動取得）:

```bash
sesame rpc --http status                          # 既定 URL http://127.0.0.1:8080
sesame rpc --http http://host:8080 lock.unlock --params '{"name":"front"}'
```

**ブラウザから呼ぶ場合 (CORS):** 別オリジンのブラウザからのリクエストは既定でブロックされます（`Access-Control-*` ヘッダ無し = 安全側）。`--cors` でオリジンを明示的に許可します:

```bash
sesame serve --http 8080 --cors https://app.example.com   # 1 オリジン許可 (カンマ区切りで複数可)
sesame serve --http 8080 --cors '*'                       # 全オリジン許可 (開発用)
```

`OPTIONS` プリフライト処理と `/rpc`・`/events` への `Access-Control-Allow-Origin` が付きます。Bearer token は引き続き必須です — CORS はブラウザの same-origin 制限を緩めるだけで、認証ではありません。

### どちらを使う? — `sdk/` と `clients/`

本リポジトリには 2 つのクライアント層があり、用途が異なります:

- **`sdk/` — 生成された型付きの契約 SDK（多くのユーザにはこちらを推奨）。** [`sdk/ts/sesame-client.ts`](./sdk/ts/sesame-client.ts) と [`sdk/python/sesame_client.py`](./sdk/python/sesame_client.py) は [`schema/openrpc.json`](./schema/openrpc.json) から**生成**されます（`npm run build:sdk`）。RPC ごとに型付きメソッドが 1 つ（`client.lock.unlock({ name })`）、param/result も型付きで、`SesameRpcError`（`kind` / `retryable`）を公開します。公開 OpenRPC 契約を追従し（CI の drift gate で常に一致）、`sesame serve` の JSON-RPC デーモンに HTTP（イベントは SSE）で接続します。**生成物 `sesame-client.ts` / `sesame_client.py` は手で編集しないでください** — スキーマを変更して再生成します。
- **`clients/` — 手書きの低レベル経路クライアント（上級 / カスタム連携向け）。** [`packages/kit/clients/js/sesame-client.mjs`](./packages/kit/clients/js/sesame-client.mjs) と [`packages/kit/clients/python/sesame_client.py`](./packages/kit/clients/python/sesame_client.py) は**薄い公式クライアント**です: 手書き・依存最小で、汎用の `c.call("<method>", …)` に加えていくつかの便利メソッド（`c.unlock(…)`）を持ちます。**多経路対応**です — JS クライアントは Unix socket / HTTP / WebSocket、Python クライアントは Unix socket / stdio / HTTP に対応 — ため、組み込み（Python の stdio 子プロセス）・ローカルデーモン・全二重（JS の WS）連携に向きます。gRPC はどちらも非対応です（`packages/kit/src/serve/sesame.proto` から生成した stub を直接使ってください）。スキーマから**生成されない**ため、契約に対する静的型付けはありません。

まとめ: HTTP 上で型付き・契約追従のクライアントが欲しいなら **`sdk/`**、薄い多経路クライアントや汎用 `call()` の逃げ道が欲しいなら **`clients/`**。`sesame-kit/client`（`package.json` の `exports`）が指すのはこの `clients/` 層です。

### 同梱クライアント

JSON-RPC をラップした薄いクライアント（上記の `clients/` 層）で、`c.unlock("front")` のように書けます。任意であり、上の `curl` でもクライアント無しで動きます。Node は `npm install sesame-kit` 後に `import { SesameClient } from "sesame-kit/client"`。Python はパッケージ同梱の単一ファイルです。

```js
import { SesameClient } from "sesame-kit/client";   // npm install sesame-kit の後
const c = SesameClient.unix();                       // 既定 Unix ソケット
try {
  console.log(await c.unlock("front"));
  console.log(await c.call("device.history", { deviceUUID: "AB12CD34...", pageSize: 10 })); // 任意のメソッド。deviceUUID は `sesame devices` から
  await c.subscribe(["lockState"], (topic, p) => console.log(topic, p)); // 常に await
} finally {
  c.close();
}
```

```python
# Python — 連携ガイドの手順でインストールしてから:
from sesame_client import SesameClient
c = SesameClient.unix()                       # 既定 Unix ソケット
print(c.unlock("front"))
print(c.call("device.history", deviceUUID="AB12CD34...", pageSize=10))  # 任意のメソッド。deviceUUID は `sesame devices` から
```

インストール不要の HTTP 経路・Python のインストール（グローバル npm 含む）・メソッド/値の調べ方・イベント・gRPC・セキュリティは [連携ガイド](./docs/ja/integration.md) を参照してください。

gRPC は型付きです。`packages/kit/src/serve/sesame.proto` が op ごとに型付きメソッドを持ちます。
ソースチェックアウトでスタブ生成（`pip install grpcio-tools` 後）: `python -m grpc_tools.protoc -I packages/kit/src/serve --python_out=. --grpc_python_out=. packages/kit/src/serve/sesame.proto`。

認証境界: 対話ログインは CLI 専用で、デーモンには載りません。Unix socket は同一ユーザの任意プロセスが操作できます
(CLI と同じ境界)。HTTP / WS / gRPC は TCP のため、起動時に生成する loopback token を要求します。POSIX 専用です
(Windows の UDS は非対象です。stdio / HTTP / WS / gRPC は動きます)。

### 公開 API 契約と生成 SDK

JSON-RPC のサーフェスは**バージョン管理された機械可読な契約**として公開しており、安全に上に積めます:

- [`schema/openrpc.json`](./schema/openrpc.json) — 公開 OpenRPC ドキュメント（`rpc.discover` でも取得可）。各メソッド/イベントに `x-stability`（`stable` / `experimental`）と `x-provenance`、`apiVersion`（SemVer。1.4.0）は `status` / `rpc.discover` に。CI の drift gate で実装と常に一致。
- **スキーマから生成された型付き SDK** — [`sdk/ts/sesame-client.ts`](./sdk/ts/sesame-client.ts)（`client.lock.unlock({ name })`）と [`sdk/python/sesame_client.py`](./sdk/python/sesame_client.py)（`client.lock.unlock(name=...)`、依存ゼロ）。いずれも `SesameRpcError` が `kind` / `retryable` を公開。再生成は `npm run build:sdk`。
- **安定性:** API SemVer が守るのは `stable` コア — 13 メソッド: `lock.lock` / `lock.unlock` / `lock.toggle` / `lock.click` / `lock.status`（注: `lock.setAutolock` は **experimental**）、`devices.list`、`device.history` / `device.battery`、`status`、`rpc.discover`、`account.whoami`、`events.subscribe` / `events.unsubscribe` — のみ。`experimental` は予告なく変わり得ます。[docs/api-stability.md](./docs/api-stability.md) 参照。
- **エラー**は構造化: メッセージ文字列でなく `error.data.kind`（`not_authenticated` / `bad_params` / `timeout` / `connection_lost` / `rejected` / `internal` / `not_implemented`）と `error.data.retryable` で分岐。

---

## Node から使う（インプロセス）

デーモンを別に立てず、Node アプリ内で直接ロックを操作するにはライブラリエントリを使います。CLI のログイン情報（`~/.config/sesame-kit`、`sesame login` を一度実行）を読み、接続と切断を自動で行います。

```js
import { SesameHub3 } from "@sesame-kit/core";

await SesameHub3.use(async (hub) => {
  await hub.unlock("front");
  await hub.send("ac", "停止");        // Hub3 IR
});
```

直接 API（`deviceUUID` / `secretKey` 指定）、イベント購読、config ファイルでなくコードでトークンを渡す方法は [Node ライブラリガイド](./docs/ja/library.md) を参照してください。

---

## BLE 初期ペアリング / 登録（上級）

工場出荷（未登録）デバイスは BLE から直接ペアリングできます。ファサードが ECDH 登録ハンドシェイクを実行し、保存すべき `secretKey` を返します。`SesameBle.registerOnce()` は scan → connect → register → close を一括で行います。

```js
import { SesameBle } from "@sesame-kit/core";

const key = await SesameBle.registerOnce(
  { deviceUUID: "<advertise から取得した uuid>", model: "sesame_5" },
  async ({ deviceUUID, secretKey, productType, serverSecret }) => {
    // 必ず保存すること。secretKey は以降ロックを操作できる唯一の資格情報です。
    // 例: ~/.config/sesame-kit/config.json の devices{} (deviceUUID → { secretKey }) に永続化。
    console.log({ deviceUUID, secretKey });
  },
);
// `key` は同じ { deviceUUID, secretKey, productType, serverSecret } オブジェクト。
```

ペアリング後は、返ってきた `secretKey` で登録済みデバイスと全く同様に操作できます。

```js
await SesameBle.use({ deviceUUID: key.deviceUUID, secretKey: key.secretKey }, (lock) => lock.unlock());
```

返り値 4 フィールドの意味と保存先:

| フィールド | 内容 | 保存先 |
|-----------|------|--------|
| `secretKey` | ECDH 共有秘密から導出した 32hex のデバイス鍵。ログイン / 操作のための**資格情報**。 | `config.json` の `devices{}`（または独自ストア）に保存。秘匿すること。 |
| `deviceUUID` | 登録したデバイス識別子。 | `devices{}` のキー。 |
| `productType` | 渡した model（例 `sesame_5`）のエコーバック。 | 任意。型別能力テーブルに利用可。 |
| `serverSecret` | デバイスの `initial` token を hex 化したもの（`mSesameToken`）。サーバ登録ペイロード。 | サーバ登録呼び出しを配線する場合に使用。 |

低レベルの部品も利用できます。

- `new SesameBle({ registerMode: true, deviceUUID, transport }).register()` — スキャン済み / 注入済みトランスポートに対して登録する。`register()` は工場出荷デバイス専用なので、`registerMode: true`（`secretKey` 無し）で構築したファサードでのみ有効。`secretKey` 付きのファサードで呼ぶと throw する。
- **サーバ認証**が要る登録済みデバイス（ゲスト鍵・期限付き鍵）は、ローカル導出ではなくサーバ署名済み token で login できます。`{ secretKey, deviceUUID, needAuthFromServer: true, registerTransport }` で構築すると `connect()` が `signGuestKey` を呼び、返った token で `login` します（`CHHub3Device.kt:163-174` / `CHSesameOS3.kt:473-487` の移植）。`registerTransport` は `makeRegisterTransport(...)` の戻りです。
- CLI / RPC から `registerTransport` が必要な OS3 経路を使う場合、REST host は `--register-base-url` / RPC `registerBaseUrl` / `config.registerBaseUrl` から解決し、未指定なら公式ホスト `https://app.candyhouse.co/prod` (`_sesame_sdk_ref/app.properties:2-3` にチェックイン済み) を既定とします。認可は公式アプリと同じ「SigV4 (Cognito Identity Pool の一時 credentials) + `x-api-key` + `appidentifyid`」(`ApiClientConfigBuilder.kt:34-46`, `BaseApp.kt:95-102`, `AppIdentifyIdUtil.kt:42`) で、Identity Pool credentials は `sesame login` が保存した既存 TokenStore の idToken から導出します (`packages/core/src/aws-credentials.js` + `packages/core/src/sigv4.js`)。別ログインや手入力 token は不要です。実機 API Gateway での受理は未検証です。
- **OS2 のサーバ認証登録**（サーバの `getRegisterKey` ステップが要る SESAME 2/3/4 の工場ペアリング）は、サーバ認証 login と同じコールバック注入で配線しています。`SesameOS2BleSession.register({ registerServer })` が `IRER` を読み、`registerServer({ ak, n, e, appPubK64, ... })` から `{ sig1, st, pubkey }` を受けて ECDH/登録鍵ハンドシェイクを完走します（`CHSesame2Device.kt:406-482` の移植）。サーバの役割は `CHServerAuth.getRegisterKey`（`CHServerAuth.kt:41-65`）で、これを**自分のコードからオフライン実行**（クラウド不要）するには `makeLocalRegisterServer()`（`packages/core/src/crypto.js`、`@sesame-kit/core/ble/os2` から再公開）を `registerServer` に渡すか、`SesameOS2Ble` ファサードで `localServerAuth: true` を指定して自動配線します。既定の BLE-only register は不変です（`registerServer` も `localServerAuth` も無ければ従来どおり明示エラー）。`getRegisterKey` は依然 **未照合 (UNVERIFIED) な移植**で（[既知の制限](#既知の制限)参照）、実機 SESAME 2/3/4 キャプチャとのバイト一致は未確認です。

> 登録ハンドシェイクとサーバ認証 login は SDK から 1:1 で移植し mock の end-to-end テストで検証済みですが、依存するサーバ認証プリミティブと REST ホストは**実機 OS3 で未照合**です（[既知の制限](#既知の制限)参照）。実機での利用は自己責任で。

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
- [BLE 直接制御](./docs/ja/ble.md) — クラウド非経由で Bluetooth 操作（Linux / Raspberry Pi のセットアップは [要件](./docs/ja/ble.md#要件) を参照: `libudev-dev` + `setcap`）
- [Node ライブラリ](./docs/ja/library.md) — Node.js アプリへ埋め込み
- [他言語からの組み込み](./docs/ja/integration.md) — `sesame serve` 経由 (Python / JS / HTTP / WS / gRPC)
- [API 安定性 & 1.0 サーフェス](./docs/api-stability.md) — stable / experimental、エラーモデル、二境界モデル
- [アーキテクチャ](./docs/ja/architecture.md) · [マイグレーション](./docs/ja/migration.md)

---

## 既知の制限

3 つの層に分けて記載します: **検証済み**（実クラウド / 実機で確認済み）、**設計上の非実装**、**実装済み・実機未検証**（公式 SDK / biz3 ソースから 1:1 で移植しユニット + mock end-to-end テストで検証済みだが、実機・実 API Gateway では未確認）。

### 動作プラットフォーム

**macOS と Linux のみ対応しています。** Windows (`win32`) は**サポート対象外**です:

- 設定ディレクトリの解決（`paths.js`）が XDG / POSIX 規約（`~/.config/sesame-kit`）を前提にしています。`%APPDATA%` へのマッピングは実装されていないため、Windows では誤ったパスが使用されます。
- `tokens.json` や `config.json` など秘密鍵を含むファイルへの `0600` パーミッション保護が Windows では無効です（Windows は NTFS ACL を使用し、POSIX の mode bit は機能しないため、OS レベルのアクセス制御が掛かりません）。
- `sesame serve` の既定トランスポートは Unix domain socket（`sesame.sock`）であり、POSIX 専用です。

Windows 上で起動すると、1 プロセスにつき 1 回だけ stderr に警告を出力して継続します（ベストエフォート）が、上記の制限が適用されます。Windows サポートのロードマップは [docs/platform-roadmap.md](./docs/platform-roadmap.md) を参照してください。

### 検証済みの挙動

- Hub3 IR には、自己学習リモコン (`learnEmit`) とプリセット HXD command の 2 経路があります。学習ボタンは `sesame ir learn` / `sesame remote`、プリセット command はプリセットの `remote.code` と `remote.type` を指定して `sesame preset-ir`（または `presetir.*` RPC/Node namespace）から使います。
- autolock はクラウド経由では設定できません — cmd=11 はクラウドが ack を返しますが実機は変化しません。BLE で `sesame <device> autolock <秒>` を使ってください（RPC の `lock.setAutolock` は互換性のため既定 `transport:"cloud"` のままです。実機に効く経路は `transport:"ble"` を明示）。
- WS ステージの既定は `/public` です。`/production` は使用しません (config に残っていれば load 時に `/public` へ書き換えます)。
- **biz3 クラウド WebSocket** — 接続先は API Gateway の `execute-api` エンドポイント (`wss://82q6nuplv0.execute-api.ap-northeast-1.amazonaws.com/public`、`references_web/src/env_config.js:1-3`) であり、本 README が以前記載していた AWS IoT ではありません — は IPv4 必須で、IPv6-only 回線では繋がりません（実測による観測）。

### 設計上の非実装

- **Stripe SetupIntent の confirm。** 本 kit はカード情報を扱わない方針のため confirm を実装しません。「Stripe.js を動かせるクライアントが必須」という旧記載は技術的事実ではありません: confirm に必要なのは publishable key（biz3 では `references_web/src/env_config.js:5-7` にハードコード）と `sesame payment client-secret` で取得できる `client_secret` のみで、Stripe 公開 API（`POST /v1/payment_methods` → `POST /v1/setup_intents/{id}/confirm`）か Stripe.js で confirm し、得られた `payment_method` id を `payment.changeDefaultPayment` に渡せば完結します。周辺の Biz3 payment op (`payment.*`) はすべて公開しています。
- **DFU バイナリ転送 (Nordic DFU)。** `SesameBle#updateFirmware` は SDK の開始コマンドのみを移植しています: Hub3 は `MOVE_TO(84)` (`CHHub3Device.kt:213-226`)、WM2 は `OPEN_OTA_SERVER(126)` (`CHWifiModule2Device.kt:450-458`)、OS3 ロックは SDK 自体が**コマンドを一切送らず**接続済みデバイスを外部 DFU ライブラリへ渡すだけです (`CHSesameOS3.kt:441-449`)。kit もこの no-op 経路を踏襲し、Nordic-DFU の転送実装は同梱しません。（旧 README の「OS3 ロックは `MOVE_TO` を送る」は誤りで、その分岐は Hub3 専用です。）
- 予約スケジュールの**新規作成** op と、Android アプリ専用の付帯 REST（feed history・SNS subscribe・friend 等）は biz3 web 参照に存在せず、スコープ外です。
- **OS2 mechStatus publish — 自動履歴読み出し（意図的逸脱）。** 公式 SDK（`CHSesame2Device.kt:543-553`）は、mechStatus publish を受信したときに `retCode != 0` または `target == Short.MIN_VALUE (-32768)` の場合、`readHistoryCommand` を自動発行してサーバへ POST します。kit では**この自動ドレインを実装しません**: 履歴の取得は、呼び出し元が明示的に `history()` を呼んだときのみ行われます（Node ライブラリ / `ble.history` RPC / `sesame ble os2-invoke <device> history` CLI）。これは意図的な設計判断です — 自動ドレインはポリシー（ログ・サーバ同期）をトランスポート層に結びつけてしまうため、kit はセッション層を純粋なプロトコル移植に留め、その判断を呼び出し元に委ねます。実際の影響は、明示呼び出しの間にデバイス側の履歴バッファが溜まることです。ロックの動作には影響しません。
- **OS3 ロック — 広告トリガによる自動履歴ドレイン（意図的逸脱）。** 公式 SDK（`CHSesameOS3LockBase.kt:42-58, 185-209`）は、login 済み状態で広告（`adv_tag_b1`）を受信するたびに `readHistory` を自動発行し、サーバへ POST 成功後に 1 件削除するドレインループを実行します。kit では OS2 と同様に**この自動ドレインを実装しません**: サーバ POST 部分はアプリ専用テレメトリ REST（§10-6 確定非実装）であり、ドレインループもセッション層の外に委ねます。履歴の取得は、呼び出し元が明示的に `sesame ble invoke <device> history` / `ble.history` RPC / Node の `history()` を呼んだときのみ行われます。

### 実装済み・実機未検証

- **BLE 初期ペアリング / 登録** — OS3 (`sesame ble register` / `ble.register` / `SesameBle.registerOnce()`) と OS2 (`sesame ble os2-register` / `ble.os2.register`): セッション層の ECDH 登録ハンドシェイク（`REGISTRATION` 応答の長さ分岐 64B [Hub3 系] / 77B [SESAME 5 系] を含む）は実装済みで mock ベクタでテスト済みですが、実際の工場出荷デバイスでは未確認です。詳細は [BLE 初期ペアリング / 登録](#ble-初期ペアリング--登録上級)。
- **register / biometrics REST**（`packages/core/src/devices.js` の `signGuestKey` / `registerSesame5`、`packages/core/src/access.js` の `/device/v1/biometrics`）: リクエスト整形は 1:1 移植、公式の既定ホスト `https://app.candyhouse.co/prod` を同梱し (`_sesame_sdk_ref/app.properties:2-3`)、認可は公式アプリと同じ **SigV4 (Cognito Identity Pool の一時 credentials) + `x-api-key` + `appidentifyid`** です (`ApiClientConfigBuilder.kt:34-46`、`BaseApp.kt:95-102`。`packages/core/src/aws-credentials.js` + `packages/core/src/sigv4.js` で AWS SDK 非依存に実装)。Identity Pool credentials は `sesame login` が保存した idToken から導出され、追加ログインは不要です。リクエスト形と署名ヘッダ集合は fetch mock のテストで固定済みですが、**実機 API Gateway での受理は未検証**です。
- OS2 のサーバ認証プリミティブ `getRegisterKey`（`packages/core/src/crypto.js`。`registerServer` / `localServerAuth` 経由の OS2 register 任意経路に配線済み）は**未照合 (UNVERIFIED) の移植**で、実機 SESAME 2/3/4 キャプチャとのバイト一致は未確認です。OS3 register は純 ECDH でこれを使いません。
- **OS2 BLE**（`SesameOS2Ble`: SESAME 2/3/4・Bot1・Bike1 — 制御・autolock・履歴・ECDH login・register・`mechSetting` 書き込み）: バイト順などのプロトコルバグは Kotlin ソース由来のベクタに対して修正済み (Phase 1) ですが、実機 OS2 デバイスでは未確認です。
- **WM2 BLE**: ロックと非互換の専用セッション層（profile `"wm2"`: `INITIAL=13`・secretKey 生鍵 cipher・16B login payload・WM2 専用 GATT — `packages/core/src/ble/wm2.js`、`CHWifiModule2Device.kt:279-321,521-528` 準拠）を実装済み。実機未検証です。
- **Hub3 networkType (item 209)** は公式 Android SDK に**存在しません** — biz3 web の native bridge (`references_web/src/components/MobileWifiModule.js:219-235`) からの推定実装（**UNVERIFIED**）で、`UNVERIFIED_ITEM_CODES` に隔離した experimental 経路としてのみ公開しています。
- その他の移植済み BLE 面 — 生体 / アクセス制御の登録 (`SesameBle#biometric`)、Bike3 指紋 (`#fingerPrint`)、Bot2/Bot3 スクリプト (`#script`)、WM2 / Hub3 の Wi-Fi プロビジョニング (`#wifi` / `#hub3`)、上記 OTA 開始コマンド — はライブラリ・CLI（`sesame ble …`。汎用 `invoke` / `os2-invoke` と `ota` / `reset` / `wifi` / `position` を含む）・`ble.*` RPC で同一コード経路を共有し、実機未検証です。実機で最もよく通る経路は OS3 のロック / Bot / Bike 制御と読み出しです。[docs/ja/ble.md](./docs/ja/ble.md) を参照してください。

---

## トラブルシュート

- `No tokens stored` / `No config at ...`: config は `sesame init` / `sesame migrate`、ログイン状態は `sesame login` で作成してください。
- `UserNotFoundException`: 自動 SignUp は組み込み済みです。それでも出る場合は Cognito 側の特殊ケースです。
- `Cognito refresh returned no IdToken`: refreshToken が無効化されました (公式アプリでログアウト等)。再 sign-in します。
- 初回 refresh (ログインの約24h後) で `Invalid Refresh Token`: デバイス確認前の古いトークンです。`sesame login` で Cognito にデバイスを登録 (`ConfirmDevice`、公式アプリと同じ) するため refreshToken が有効に保たれます。一度だけ再 sign-in してください。`sesame migrate` は旧 `.tokens.json` / `.login_state.json` を意図的に取り込みません。
- `triggerLock timeout`: `secretKey` 不一致、Hub3 オフライン、または WS の半開接続 (自動再接続で復帰)。
- `learn timeout`: Hub3 が REGISTER に入りましたが波形を受け取れませんでした。距離を縮めるか、別のボタンを試してください。
- `apiKeyId required`: `webapi` 系は config.json に `apiKeyId` を入れます (biz3 dev console で発行)。
- **BLE を初期化できない** (`sesame ble …` / `--ble-only`): CLI は無言クラッシュせず終了コード `1`（実行環境のランタイム障害であり使い方エラーではない）とわかりやすいメッセージを出します (`--json` 時は `{ error, code, bleCode }`)。`bleCode: BLE_UNAUTHORIZED` → ターミナルに Bluetooth 権限を付与 (macOS: システム設定 → プライバシーとセキュリティ → Bluetooth)。`BLE_UNSUPPORTED` → アダプタ無し / 権限不足 (Linux / Raspberry Pi / ヘッドレス — 実機アダプタと `setcap cap_net_raw+eip` が必要)。`BLE_POWERED_OFF` → Bluetooth をオンにする。`BLE_INIT_TIMEOUT` → Bluetooth が時間内に ready にならなかった状態。詳細は [docs/ja/ble.md](./docs/ja/ble.md#トラブルシュート)。

## 関連

- [SesameSDK_iOS_with_DemoApp](https://github.com/CANDY-HOUSE/SesameSDK_iOS_with_DemoApp) / [SesameSDK_Android_with_DemoApp](https://github.com/CANDY-HOUSE/SesameSDK_Android_with_DemoApp) — 参考にした公式 SDK
