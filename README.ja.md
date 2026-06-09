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
- **生体・アクセス制御の BLE 登録**: Touch / Touch Pro / Face / Palm へのカード / 指紋 / 暗証番号 / 顔 / 掌紋の登録（`SesameBle#biometric`）。`registerDelegate` は登録以外のデバイス publish も配信します — Touch Pro `mechStatus`・電池電圧・子鍵スロット（`PUB_KEY_SESAME`）・スロット非サポートフラグ・BLE 送信出力。**読み取り専用のサブセット**（登録済みカード / 暗証番号 / 指紋 / 顔 / 掌紋の一覧、現在の登録モードの取得）は CLI にも `sesame ble cards/passcodes/fingers/faces/palms/mode` として配線済みです。登録系（追加 / 削除 / 改名・モード設定）はライブラリ専用のままです
- **SESAME Bike3 指紋の BLE 対応**: Bike3 の指紋の一覧 / 削除 / 改名・登録モードの取得 / 設定（`SesameBle#fingerPrint`）— Bike3 は Bike2（解錠）に指紋 capability を足した型なので、指紋サブセットのみを露出（一覧 / モード取得の読み取りは CLI の `sesame ble fingers/mode` から到達可。削除 / 改名 / モード設定はライブラリ専用のまま）
- **SESAME Bot2 / Bot3 スクリプトの BLE 対応**: index 指定でスクリプト実行・アクティブスクリプトの切替・現在スクリプトの取得・名前一覧の取得・スクリプトの書き込み（`SesameBle#script`）— 読み取り専用のサブセット（スクリプト名一覧 + 現在スクリプト）は `sesame ble script` でも利用可。切替 / 書き込み / index 実行はライブラリ専用のまま
- **WifiModule2 の BLE 対応**: Wi-Fi プロビジョニングと子鍵登録（`SesameBle#wifi`）
- **Hub3 の BLE 対応**: Wi-Fi プロビジョニング（SSID スキャン / SSID / パスワード）・子鍵の削除・接続種別（Wi-Fi / LTE）の読み出し（`SesameBle#hub3`）
- **BLE 経由ファームウェア更新**（DFU / OTA）: Hub3 / OS3 ロック / WM2（`SesameBle#updateFirmware`）
- Hub3 IR: 既存リモコンの発射、物理リモコンからの学習、リモコン / キー CRUD、プリセット DB 検索
- デバイス管理: 一覧、リネーム、削除、現在状態、state push 購読
- 履歴: ロック開閉履歴、電池残量履歴
- アクセス制御: NFC カード / キーパッド暗証番号の DB 同期
- 予約 / 会社・組織: スケジュール、法人機能 (社員・役割・デバイスグループ・鍵共有)
- Hub3 IoT: LED 調光、LTE リレー、ファーム更新、Matter ペアリング
- 言語非依存バックエンド: `sesame serve` が全機能を stdio / UDS / HTTP / WS / gRPC に JSON-RPC として公開します
- 対話モード、ライブラリ API

詳細は [コマンドリファレンス](./docs/ja/commands.md) / [ライブラリ利用](./docs/ja/library.md) / [設計ノート](./docs/ja/architecture.md) を参照してください。

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
sesame logout               # このセッションの token を失効 + サーバ側でこのデバイスを解除し、ローカル token を削除
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

### 公開 API 契約と生成 SDK

JSON-RPC のサーフェスは**バージョン管理された機械可読な契約**として公開しており、安全に上に積めます:

- [`schema/openrpc.json`](./schema/openrpc.json) — 公開 OpenRPC ドキュメント（`rpc.discover` でも取得可）。各メソッド/イベントに `x-stability`（`stable` / `experimental`）と `x-provenance`、`apiVersion`（SemVer）は `status` / `rpc.discover` に。CI の drift gate で実装と常に一致。
- **スキーマから生成された型付き SDK** — [`sdk/ts/sesame-client.ts`](./sdk/ts/sesame-client.ts)（`client.lock.unlock({ name })`）と [`sdk/python/sesame_client.py`](./sdk/python/sesame_client.py)（`client.lock.unlock(name=...)`、依存ゼロ）。いずれも `SesameRpcError` が `kind` / `retryable` を公開。再生成は `npm run build:sdk`。
- **安定性:** API SemVer が守るのは `stable` コア（`lock.*` / `devices.list` / `device.history`・`battery` / `status` / `account.whoami` / `events.*`）のみ。`experimental` は予告なく変わり得ます。[docs/api-stability.md](./docs/api-stability.md) 参照。
- **エラー**は構造化: メッセージ文字列でなく `error.data.kind`（`not_authenticated` / `connection_lost` / `timeout` / `rejected` / `bad_params` …）と `error.data.retryable` で分岐。

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

## BLE 初期ペアリング / 登録（上級）

工場出荷（未登録）デバイスは BLE から直接ペアリングできます。ファサードが ECDH 登録ハンドシェイクを実行し、保存すべき `secretKey` を返します。`SesameBle.registerOnce()` は scan → connect → register → close を一括で行います。

```js
import { SesameBle } from "sesame-kit";

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
- **OS2 のサーバ認証登録**（サーバの `getRegisterKey` ステップが要る SESAME 2/3/4 の工場ペアリング）は、サーバ認証 login と同じコールバック注入で配線しています。`SesameOS2BleSession.register({ registerServer })` が `IRER` を読み、`registerServer({ ak, n, e, appPubK64, ... })` から `{ sig1, st, pubkey }` を受けて ECDH/登録鍵ハンドシェイクを完走します（`CHSesame2Device.kt:406-482` の移植）。サーバの役割は `CHServerAuth.getRegisterKey`（`CHServerAuth.kt:41-65`）で、これを**自分のコードからオフライン実行**（クラウド不要）するには `makeLocalRegisterServer()`（`src/crypto.js`、`sesame-kit/ble/os2` から再公開）を `registerServer` に渡すか、`SesameOS2Ble` ファサードで `localServerAuth: true` を指定して自動配線します。既定の BLE-only register は不変です（`registerServer` も `localServerAuth` も無ければ従来どおり明示エラー）。`getRegisterKey` は依然 **未照合 (UNVERIFIED) な移植**で（[既知の制限](#既知の制限)参照）、実機 SESAME 2/3/4 キャプチャとのバイト一致は未確認です。

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
- [BLE 直接制御](./docs/ja/ble.md) — クラウド非経由で Bluetooth 操作
- [Node ライブラリ](./docs/ja/library.md) — Node.js アプリへ埋め込み
- [他言語からの組み込み](./docs/ja/integration.md) — `sesame serve` 経由 (Python / JS / HTTP / WS / gRPC)
- [API 安定性 & 1.0 サーフェス](./docs/api-stability.md) — stable / experimental、エラーモデル、二境界モデル
- [アーキテクチャ](./docs/ja/architecture.md) · [マイグレーション](./docs/ja/migration.md)

---

## 既知の制限

- 対応リモコンは自己学習 (`learnEmit`) のみです。プリセットリモコン (メーカー DB から選ぶ方式) の command 生成は未移植です。`sesame ir learn` で物理リモコンを取り込んで使います。
- autolock はクラウド経由では設定できません。BLE で `sesame <device> autolock <秒>`（例: `sesame front autolock 30`）を使います。
- 未実装 op は Stripe 課金切替のみです。それ以外の biz3 op (社員 / グループ / 役割 / デバイスグループ / 鍵共有 / アクセス制御 / 予約 / IoT) はコマンド化済みです。
- WS ステージの既定は `/public` です。`/production` は使用しません (config に残っていれば load 時に `/public` へ書き換えます)。
- AWS IoT WS は IPv4 必須です。IPv6-only 回線では繋がりません。
- 新規ペアリング (未登録デバイスの登録) は Node ライブラリから提供しています (`SesameBle.register()` / `SesameBle.registerOnce()`、[BLE 初期ペアリング / 登録](#ble-初期ペアリング--登録上級)参照) が、**実機 OS3 では未確認**で CLI コマンドとしては未公開です。BLE の **セッション層**の登録ハンドシェイク自体は実装済みで mock ベクタで単体テスト済みです (`src/ble/session.js` の `SesameBleSession.register()`: secretKey 無しで構築した工場出荷デバイスが `initial(14)` 受信時に login せず `ReadyToRegister` へ遷移し、`REGISTRATION(1)` を平文送出、応答のデバイス公開鍵から ECDH で `secretKey`/session key を導出して cipher を確立。`CHHub3Device.kt:176-211` / `CHSesameOS3.kt:468-492` の移植)。`REGISTRATION` 応答は長さで機種分岐します: **64B** (Hub3 等 — payload 全体がデバイス公開鍵、`CHHub3Device.kt:197`) または **77B** (実機 SESAME 5 — `mechStatus(7B)` + `mechSetting(6B)` + `devicePubKey(64B)`。先頭 13B を parse してキャッシュへ、末尾 64B を ECDH に使用、`CHSesame5Device.kt:200-202` 準拠)。77B の SS5 経路は Kotlin から移植済みですが**実機 SESAME 5 では未確認**です。ファサードは `register()`・`registerMode` コンストラクタフラグ・`registerOnce()` (scan→connect→register→close)・`needAuthFromServer` login 経路 (`signGuestKey`→`login`、`CHSesameOS3.kt:473-487`) を追加し、いずれも mock の end-to-end テストで検証済みです。ただし依存するサーバ認証プリミティブ (`getRegisterKey`) と REST クライアント (`signGuestKey`/`registerSesame5`) は未照合 (UNVERIFIED) で、フロー全体は実機 OS3 で未確認です。サーバ認証プリミティブ `getRegisterKey` (`src/crypto.js`) は **OS2 register の任意経路に配線済み**になりました: `SesameOS2BleSession.register({ registerServer })` が `{ sig1, st, pubkey }` コールバックを受け、`makeLocalRegisterServer()` が `getRegisterKey` をそのコールバックに適合させてオフライン実行を可能にします (`SesameOS2Ble({ localServerAuth: true })` でも到達可)。mock end-to-end テスト (`tests/ble/os2-register.test.js`) で kit 内の app↔device 鍵一致は確認済みですが、実機一致は未確認です。既定の BLE-only register (OS3 `SesameBleSession.register()` と、`registerServer`/`localServerAuth` 無しの OS2 `register()`) は不変です。OS3 register (`CHHub3Device.kt:176-211`) は純 ECDH で `getRegisterKey` を使わないため、本配線は OS2 専用です (SDK で唯一の呼び出し元 `CHSesame2Device.kt:406-482`)。なお旧記載の「`e`/`ak`/`n` は各 16B」という想定は **一次資料が否定する未照合の推測**でした: `CHSesame2Device.kt:424-447` + `EccKey.kt:19-25` の照合により、実 wire は `ak` = app の 64B ECDH 公開鍵の base64、`n` = 4B の `mSesameToken`、`e` = 可変長の `ER` と判明したため、16B 固定 assert は下限 (空でない) チェックに訂正しました (CMAC は長さ非依存)。
- **OS2 BLE** ファサード (`SesameOS2Ble`: SESAME 2/3/4・Bot1・Bike1 — 制御・autolock・履歴・ECDH login・register・`mechSetting` 書き込み [2/3/4 は `configureLockPosition`、Bot1 は `updateSetting`]・`updateFirmware` [DFU 開始コマンドのみ])、**生体・アクセス制御の登録** (`SesameBle#biometric`: カード / 指紋 / 暗証番号 / 顔 / 掌紋)、**SESAME Bike3 指紋** (`SesameBle#fingerPrint`: 一覧 / 削除 / 改名 / モード)、**SESAME Bot2 / Bot3 スクリプト** (`SesameBle#script`: index 実行 / 切替 / 取得 / 一覧 / 書き込み)、**WifiModule2 プロビジョニング** (`SesameBle#wifi`)、**Hub3 プロビジョニング** (`SesameBle#hub3`: SSID スキャン / SSID 設定 / パスワード設定 / 子鍵削除 / 接続種別 — `CHHub3Device.kt` から移植、Hub3 固有の `SesameItemCode` 131‑136 / 209。Hub3 は既定 SESAME GATT で接続し BLE のロック制御 op は持たないが、`connect`/`login`/`register`/`reset`/`updateFirmware` は OS3 共通経路で動作する。これにより `updateFirmware` の Hub3 分岐 [`MOVE_TO(84)`、`CHHub3Device.kt:213-226`] が到達可能になる)、**BLE 経由ファームウェア更新 / OTA** (`SesameBle#updateFirmware`) は、いずれも公式 SesameSDK から 1:1 で移植しユニット / mock end-to-end テストで検証済みです。**読み取り専用のサブセット**は `sesame ble …` として CLI に配線済みになりました — 鍵なしスキャン (`sesame ble scan`)、生体 / Bike3 の一覧読み出し (`cards` / `passcodes` / `fingers` / `faces` / `palms`)、登録モードの取得 (`mode`)、Bot2 / Bot3 のスクリプト名一覧 + 現在スクリプトの読み出し (`script`) です。それ以外はすべて**ライブラリ専用 (CLI コマンドなし)** のままです: 生体・アクセス制御の**登録**（追加 / 削除 / 改名・モード設定）、Bike3 指紋の削除 / 改名 / モード設定、Bot2 スクリプトの切替 / 書き込み / index 実行、WifiModule2 プロビジョニング、Hub3 プロビジョニング、BLE 経由ファームウェア更新 / OTA、BLE 初期ペアリング / 登録 (`register`/`registerOnce`)、工場出荷 `reset`、OS2 ファサード (`SesameOS2Ble`)。ライブラリも新しい `sesame ble` 読み取りコマンドも同じコード経路を共有しており、**実機未確認**です。実機で最もよく通る経路は OS3 のロック / Bot / Bike 制御と読み出しです。使い方は [docs/ja/ble.md](./docs/ja/ble.md) を参照してください。

---

## トラブルシュート

- `No tokens stored` / `No config at ...`: `sesame init` → `sesame login`、または `sesame migrate`。
- `UserNotFoundException`: 自動 SignUp は組み込み済みです。それでも出る場合は Cognito 側の特殊ケースです。
- `Cognito refresh returned no IdToken`: refreshToken が無効化されました (公式アプリでログアウト等)。再 sign-in します。
- 初回 refresh (ログインの約24h後) で `Invalid Refresh Token`: デバイス確認前の古いトークンです。`sesame login` で Cognito にデバイスを登録 (`ConfirmDevice`、公式アプリと同じ) するため refreshToken が有効に保たれます。一度だけ再 sign-in して移行してください。
- `triggerLock timeout`: `secretKey` 不一致、Hub3 オフライン、または WS の半開接続 (自動再接続で復帰)。
- `learn timeout`: Hub3 が REGISTER に入りましたが波形を受け取れませんでした。距離を縮めるか、別のボタンを試してください。
- `apiKeyId required`: `webapi` 系は config.json に `apiKeyId` を入れます (biz3 dev console で発行)。

## 関連

- [SesameSDK_iOS_with_DemoApp](https://github.com/CANDY-HOUSE/SesameSDK_iOS_with_DemoApp) / [SesameSDK_Android_with_DemoApp](https://github.com/CANDY-HOUSE/SesameSDK_Android_with_DemoApp) — 参考にした公式 SDK
