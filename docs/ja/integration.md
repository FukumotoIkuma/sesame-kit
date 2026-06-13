<!-- [English](../en/integration.md) | 日本語 -->

# 他言語からの組み込み (`sesame serve`)

> [English](../en/integration.md) · [ドキュメント目次](./index.md)

`sesame serve` は常駐する JSON-RPC 2.0 デーモンです。一度サインインするとクラウド接続を維持し続け、操作の実行とイベントの配信を繰り返します。クラウド / Biz3 機能は型付き RPC として公開します。BLE 操作も型付きメソッドとして公開され、各 facade op が `ble.<op>` / `ble.os2.<op>`(例: `ble.script.click`・`ble.biometric.cardAdd`・`ble.hub3.setWifiSSID`)として名前付きパラメータで生成 SDK に現れます(すべて `experimental`・実機未確認)。汎用の `ble.invoke` / `ble.os2.invoke` 文字列ディスパッチは脱出口として併存します。

## 1. サインインしてデーモンを起動

デーモンは保存済みのログイン情報を使い、デーモン自身はサインインしません。CLI で一度サインインしてから、デーモンを起動します。

```bash
sesame login your@email.com && sesame verify   # if not already signed in
sesame serve --http 8080                        # serve over HTTP on port 8080
```

デーモンは起動時にトークンを出力します（`~/.config/sesame-kit/serve.token` にも保存されます）。すべての HTTP リクエストは `Authorization: Bearer <token>` を送る必要があります。

> 同一マシンでの利用なら、フラグなしの `sesame serve` は Unix ソケットで待ち受け、トークンは不要です。ここで HTTP を使うのは、任意の言語・任意のマシンから動作するためです。

## 2. 最初の呼び出し — ライブラリのインストール不要

HTTP 上の素の JSON-RPC です。POST できるものなら何でも動作します。

```bash
TOKEN=...   # the token printed by `sesame serve`

curl -s -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"lock.unlock","params":{"name":"front"}}' \
  http://127.0.0.1:8080/rpc
```

同じものを Python で、標準ライブラリだけで（pip install 不要）：

```python
import json, urllib.request

TOKEN = "..."   # the token printed by `sesame serve`

def rpc(method, params=None):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}).encode()
    req = urllib.request.Request("http://127.0.0.1:8080/rpc", data=body,
        headers={"content-type": "application/json", "authorization": f"Bearer {TOKEN}"})
    return json.load(urllib.request.urlopen(req))

print(rpc("status"))
print(rpc("lock.unlock", {"name": "front"}))
```

レスポンスは成功時に `{"jsonrpc":"2.0","id":1,"result": ...}`、失敗時に `{"jsonrpc":"2.0","id":1,"error":{"code","message","data":{"kind"}}}` です。

## 3. メソッドと渡す値の調べ方

`sesame rpc` は全メソッドとそのパラメータを一覧します（必須はそのまま、任意は `[brackets]` で表示）：

```bash
sesame rpc
```

```text
lock.unlock                  [name] [deviceUUID] [secretKey]
lock.status                  deviceUUID
devices.list
device.history               deviceUUID [pageSize]
ir.send                      [remote] key
org.getEmployees             [companyID]
access.registerCards         deviceUUID cards   # [experimental] 読み取った IC カードを一括登録 (クラウド DB)
…
205 methods.
```

この一覧から、使いたいメソッドの行を読みます。各行は `メソッド名  <必須> [任意]` の形です。例えば `device.history  deviceUUID [pageSize]` は、**`deviceUUID` が必須・`pageSize` が任意**という意味です。

あとは各パラメータに**値**を入れるだけです。値の出所は 2 種類あります。

- **ID 系**（`deviceUUID` / `companyID` など）は、別の一覧メソッドが返します。`deviceUUID` なら `devices.list` の結果から取ります：

  ```bash
  sesame rpc devices.list
  # → [{"deviceUUID":"AB12CD34...","deviceName":"front", ...}, ...]
  ```

- **自分で決める値**（`pageSize` / `name` など）は、任意で好きな値を入れます。`pageSize` は取得件数です。

決めた値を `--params` の JSON に入れて呼びます：

```bash
sesame rpc device.history --params '{"deviceUUID":"AB12CD34...","pageSize":10}'
```

ここで決めた**メソッド名と params が、そのまま任意のクライアントから送る内容**です（セクション2の `method` / `params` フィールドに対応します）。

> ロック操作は `deviceUUID` の代わりに設定名も受け付けます。`{"name":"front"}` が `lock.unlock` / `lock.lock` / `lock.toggle` / `lock.click` で動きます（`lock.status` は `deviceUUID` を取ります）。

正確なパラメータ型（例えばコード生成用）が必要なら、`sesame rpc --json rpc.discover` が完全な OpenRPC 文書を返します。各メソッドのエントリが param の型を持ちます：

```json
{
  "name": "device.history",
  "params": [
    { "name": "deviceUUID", "required": true,  "schema": { "type": "string" } },
    { "name": "pageSize",   "required": false, "schema": { "type": "number" } }
  ]
}
```

## 4. 同梱クライアント（任意）

薄いクライアントが上記をラップし、JSON を手で組み立てる代わりに `c.unlock("front")` と書けます。任意であり、セクション 2 はこれらなしでも動作します。

> **`sdk/` と `clients/`** — 以下のクライアントは**手書きの低レベル**層（`clients/js`・`clients/python`）です: 依存最小・多経路対応（JS: Unix socket / HTTP / WebSocket、Python: Unix socket / stdio / HTTP — gRPC はどちらも非対応で、`packages/kit/src/serve/sesame.proto` から protoc stub を生成して使います）・汎用 `call()` 付き。多くのユーザには、**生成された型付き**の SDK（[`sdk/ts`](../../packages/kit/sdk/ts/README.md) / [`sdk/python`](../../packages/kit/sdk/python/README.md)）— RPC ごとに型付きメソッドが 1 つ、`schema/openrpc.json` から生成され OpenRPC 契約を HTTP 上で追従 — の方が既定として適します。[README の「どちらを使う?」セクション](../../README.ja.md)を参照してください。

**Node** — `npm install sesame-kit` の後：

```js
import { SesameClient } from "sesame-kit/client";

const c = SesameClient.unix();                          // default Unix socket
try {
  console.log(await c.unlock("front"));                 // convenience method
  console.log(await c.call("device.history", { deviceUUID: "AB12CD34...", pageSize: 10 })); // any method
  console.log((await c.discover()).methods.map((m) => m.name));  // list methods from JS
  await c.subscribe(["lockState"], (topic, p) => console.log(topic, p)); // always await
} finally {
  c.close();
}

// const h = SesameClient.http("http://127.0.0.1:8080");   // token auto-read from serve.token
// const w = await SesameClient.ws("ws://127.0.0.1:8081");  // npm i ws for header auth
```

**Python** — クライアントはパッケージに同梱される単一ファイルです：

> **sesame-kit には Python クライアントが 2 つ同梱されており、いずれもモジュール名 `sesame_client`・クラス名 `SesameClient` を共有しますが、API は異なり互換性がありません。インストール／同梱するのはどちらか 1 つだけにしてください。**
> - **この同梱クライアント**（`clients/python`、手書き・複数経路対応の薄いクライアント）— ファクトリコンストラクタ `SesameClient.unix()` / `.http()` / `.stdio()`、`c.unlock("front")` のような位置引数の便利メソッド、`c.call(method, **params)`。以下で説明します。
> - **生成された型付き SDK**（`sdk/python`、HTTP 専用）— コンストラクタ `SesameClient(base_url, token=...)` と、`c.lock.unlock(name="front")` のような名前空間付きの型付き呼び出し。`.unix()` / `.http()` ファクトリや位置引数の便利メソッドはありません。[`packages/kit/sdk/python/README.md`](../../packages/kit/sdk/python/README.md) を参照。
>
> どちらも `from sesame_client import SesameClient` で解決されるため、以下の例は同梱クライアントでのみ動作します。生成 SDK に対して（またはその逆で）コピペすると失敗します。プロジェクトごとに 1 つを選んでください。

```bash
pip install ./packages/kit/clients/python                       # from a cloned repo
pip install "$(npm root -g)/sesame-kit/clients/python"   # from a global `npm install -g sesame-kit`
```
```python
from sesame_client import SesameClient

c = SesameClient.unix()                       # default Unix socket
print(c.unlock("front"))                      # convenience method
print(c.call("device.history", deviceUUID="AB12CD34...", pageSize=10))  # any method
print(c.discover_names())                     # list methods from Python
c.subscribe(["lockState"], lambda topic, payload: print(topic, payload))
# HTTP: SesameClient.http("http://127.0.0.1:8080") / embedded: SesameClient.stdio()
```

## 経路（フレーミング）

同じ RPC カタログが 5 つの経路で利用できます。ネットワークアクセスには HTTP/WS/gRPC を、ローカルマシンには Unix ソケットまたは stdio を使います。イベント配信は各 transport 固有の形を保ちます。

| フレーミング | 用途 | イベント | 認証 |
|---|---|---|---|
| stdio | 組み込み（子プロセス） | `event.*` 通知 | 親プロセスの信頼を継承 |
| Unix ソケット | ローカルデーモン、複数クライアント | `event.*` 通知 | ファイルパーミッション 0600 |
| HTTP | 任意の言語 / ブラウザ | `GET /events`（SSE） | `Authorization: Bearer <token>` |
| WebSocket | 任意の言語 / ブラウザ（全二重） | `event.*` 通知 | トークン |
| gRPC | 多言語向けの型付きスタブ | `Subscribe` ストリーム | トークン（メタデータ） |

gRPC は型付きです。`packages/kit/src/serve/sesame.proto` には op ごとに型付きメソッドがあります。スタブは
`python -m grpc_tools.protoc -I packages/kit/src/serve --python_out=. --grpc_python_out=. packages/kit/src/serve/sesame.proto`
で生成します。スカラー/配列パラメータは protobuf 型、動的パラメータは JSON 文字列フィールド、レスポンスは `JsonRpc{json}` です。型付きメソッドを持たない op は汎用の `Invoke` を使います。

## イベント

```jsonc
// request (over Unix socket / WebSocket / stdio):
{"jsonrpc":"2.0","id":1,"method":"events.subscribe","params":{"topics":["lockState","deviceUpdate"]}}
// then notifications arrive (no id):
{"jsonrpc":"2.0","method":"event.lockState","params":{ /* state */ }}
```

トピック：`lockState`、`deviceUpdate`、experimental の `deviceListChanged`（鍵共有 / デバイス追加・削除。biz3 `pubUserDeviceChange`）。購読可能な一覧は `rpc.discover` の `x-event-topics` で機械可読に取れます。HTTP では `GET /events?topics=…`（SSE）を、gRPC では `Subscribe` ストリームを使います。`POST /rpc` と gRPC の `Invoke` はリクエスト/レスポンス専用で、`events.*` を拒否します。

## エラー

エラーは `{error:{code, message, data:{kind}}}` です。`kind` は次のいずれかです：
`not_authenticated`（CLI でサインインしてからデーモンを再起動）/ `connection_lost`（クラウド接続が切断）/ `timeout` / `bad_params` / `rejected`（上流クラウドが明示的に失敗を返した）/ `not_implemented`（不明なメソッド）/ `internal`（それ以外。詳細は `message` に）。

`data` には追加フィールドが載ることがあります。`data.retryable`（boolean）は自動化向けの再試行ヒントで、一時的な kind（`timeout` / `connection_lost`）では `true`、`rejected` / `bad_params` では `false` です。`rejected` の場合、`data.upstreamCode` に上流クラウド自身の code が載ります。

`not_authenticated` は型付き SDK を含む任意のクライアントから到達可能です。Python SDK は HTTP レベルの失敗（例：HTTP 401）を `kind = "not_authenticated"` の `SesameRpcError` に写像するため、トークンの失効や欠落は生の HTTP エラーではなく通常の `SesameRpcError` として現れます。

## 互換性

結果の形はメソッド固有です。互換性を確認するには、コントラクトバージョンを読みます。`status` は `apiVersion` を返し、`rpc.discover` は `info["x-apiVersion"]` を返します（旧称 `contractVersion` / `x-contractVersion` は互換性のため同値を返すエイリアスとして残しています）。これは機械向けコントラクトの SemVer であり、互換性を壊す変更のみがメジャーを上げます。

## セキュリティ境界

対話的ログインは CLI 専用で、デーモン内では決して実行されません。Unix ソケットは同一ユーザーの任意のプロセスから使えます（CLI と同じ境界）。HTTP / WS / gRPC は TCP 上であり、起動時に生成されるループバックトークンを要求します。これらは平文（TLS なし）であり、ループバックでのみ公開するか、SSH / TLS リバースプロキシ経由でトンネルします。POSIX のみ対応です（Windows UDS は対象外。stdio / HTTP / WS / gRPC は動作します）。
