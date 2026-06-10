<!-- [English](../en/architecture.md) | 日本語 -->

# アーキテクチャ / 設計ノート

> [English](../en/architecture.md) · [ドキュメント目次](./index.md)

実装の出自、設計判断、ファイル構成をまとめます。README は使い方を、ここは「なぜそうなっているか」を扱います。

## 出自 (Lineage)

本実装は **公式 biz3 管理 Web (https://github.com/CANDY-HOUSE/biz.candyhouse.co, MIT)** を Node.js に port したものです。主要部の port 関係:

| この実装 | biz3 vendor 元 |
|---|---|
| `src/transport.js` | `references_web/src/websocket/WebSocketManager.ts` (window 依存除去、Node `ws` 化、reconnect/keepalive/idle/sleep 検知は biz3 と同値、callback registry は FIFO 化) |
| `src/auth.js` | `references_web/src/api/useAuthState.js` (Amplify → AWS SDK 直叩きに置換) |
| `src/lock.js` | `references_web/src/api/useIotCtrl.js` の `sendCommandToWM2` |
| `src/ir.js` | `references_web/src/api/useRemoteCtrl.js` (hook 内 useCallback から JSON 構築部だけ抽出) |
| `src/devices.js` | `references_web/src/api/useManageDevice.js` / `useManageGroup.js` / `useDeveloper.js` / `MobileBatteryChart.js` |
| `src/crypto.js` | `references_web/src/utils/Cmac.js` + `biz3utils.js` + `constants/cmdCode.js` (CMAC は `node-aes-cmac` で実装) |

**biz3 との唯一の機能的相違**: Cognito Client ID を biz3 の `21u50hboia4s5q0sbk6pbdfmss` から、公式
iOS/Android アプリと同じ Consumer Client `6ialca0p8u0lsgvbmvsljfm305` に差し替えています。これにより
refreshToken が事実上失効しなくなります。biz3 の MIT ライセンス本文は [LICENSE.biz3](../../LICENSE.biz3) として同梱しています。

## クラウド / BLE の統合設計（経路は葉）

クラウドと BLE は公式 SesameSDK と同様、**命令の正体 (itemCode) とデバイス能力モデルを共有**し、
最後の送信経路 (transport) だけが葉として差し替わる単一設計です。

- itemCode は `src/itemcodes.js` の 1 ソース（クラウドは `src/crypto.js` の `CMD`、BLE は `src/ble/protocol.js` の
  `ITEM` という別名で同じものを参照します）。
- 能力は `src/ble/devicemodel.js` が **型 × 経路** で持ちます（各 kind に `cloud:[...]` と `ble:[...]` の op 集合）。制御 op の語彙 (`CONTROL_OPS`) はこのテーブルから **導出** され CLI (`DEVICE_ACTIONS` / 能力ゲート) が参照するため、ドリフトする 2 つ目のハードコード op 一覧は存在しません。
  **操作できる op = 両者の和集合**で、session の対象・操作メニュー・`pickTransport` の経路選択はすべて
  この和集合から導きます。
  - 例: ロックは `ble` に autolock があり `cloud` に無い → autolock は BLE 専用。
  - OS2 ロックは `ble` 空・`cloud` に lock/unlock/toggle → クラウドのみで操作可。
  - Hub3 は `cloud` に ir/relay/led。
- 既定は経路を意識しない**オート**で、固定したいときだけ `--ble-only` / `--cloud-only`。

## irType の非対称トラップ（自己学習リモコン）

リモコンの種別は整数コード (= 実デバイスの `remote.type`) です。主な値: `49152`(0xc000)=エアコン /
`8192`(0x2000)=テレビ / `57344`=照明 / `32768`=扇風機 / **`65024`(0xFE00)=自己学習**。

⚠️ **学習だけ非対称**: 公式 biz3 のメニューでは各項目に id が振られ、エアコン/テレビ等のプリセットは
「メニュー id = 実デバイスの type」で一致します。ところが「学習」のメニュー id は `0xFEFF` なのに、学習して
実際に作られるリモコンの type は **`0xFE00`(65024)** です。`0xFEFF` は「学習メニューを押した」という UI 上の印に
すぎず、デバイスや通信には現れません。**自己学習リモコンを指すときは必ず実 type `0xFE00` を使うこと**
（`0xFEFF` を渡すとサーバ照合が一致せずリモコンが見つかりません）。当ツールは `0xFE00` を採用しています。

## autolock はクラウド経由では設定できない

autolock (= `SesameItemCode` 11) の設定はクラウド経由では実機に反映されません。`biz3TriggerLocker` は cmd=11 に
`success:true` を返しますが、ロック本体の autolock 秒数は変化しません。biz3 web/SDK にも設定系のクラウド送信経路は無く
（`useIotCtrl.js` の IoT cmd は ADD/REMOVE_SESAME・LED・RELAY 等のみで autolock は "Unsupported"）、公式アプリは
autolock を BLE 直送します。よって autolock は BLE の `sesame autolock` のみで提供します。ライブラリには汎用レール
`lock.triggerItemCommand` / `lock.setAutolock` がありますが、クラウドでは lock/unlock/toggle/bot 以外は実機に効きません。

`biz3TriggerLocker` は同期 ack (`{code:200, success:true}`) を返します。`unlock`/`lock`/`toggle`/`bot` は
この ack で完了判定します (push 待ちのみだと「サーバ受理済みなのに timeout」と誤判定するため)。

## BLE 直接制御の設計

プロトコル層 (`src/ble/protocol.js`: CMAC セッション鍵 / AES-CCM / セグメント / フレーム) と
セッション層 (`src/ble/session.js`) は **OS 非依存の純 JS** です。無線 I/O だけを差し替え可能なアダプタ
(`src/ble/transport.js`、既定 noble) に閉じ込めてあり、Web Bluetooth 等の別アダプタも注入できます。
デバイス型モデル (`src/ble/devicemodel.js`) は公式 SesameSDK の `CHProductModel` と能力定義を移植したもので、
`productType`/`model` → 種別 (lock5/bot2/bike2/…) → 対応操作・mechStatus 解釈を引きます。`SesameBle` はこの能力に
従って操作を許可/拒否します。プロトコルは Android SesameSDK / ESP32 リファレンス実装から移植しています。

## config の単一 `devices{}` 設計

**デバイスは単一の `devices{}` に丸ごと保存します** — ロック / Bot / Bike / Hub3 を型ごとに分けず、
サーバの device レコードを (巨大な `stateInfo` を除き) そのまま格納します。型は `deviceModel` から導出し、
どの操作 view (lock / hub3) に出すかは `category` で分類します。`model`/`secretKey` の取りこぼし
(Hub3 が「解錠」と誤表示される等) を構造的に防ぐための設計です。`remotes` は device ではない子エンティティ
(親 Hub3 + irType + 学習 keys) なので独立コレクションのままです。

## `sesame serve` 言語非依存バックエンド

1 コア + 5 フレーミングで、単一常駐 `SesameHub3` に cloud/Biz3 RPC と登録済み BLE op を一様公開します。詳細は README の
[言語非依存バックエンド](../../README.ja.md#言語非依存バックエンド-sesame-serve) を参照。

- **コア**: `src/serve/jsonrpc.js`（JSON-RPC 2.0、transport 非依存）+ `registry.js`（`NAMESPACE_OPS` から
  メソッドを自動公開 + OpenRPC）+ `daemon.js`（直列化 / 購読一元 / 背圧 / shutdown）。
- **フレーミング**: `framing/` 配下に stdio / socket(UDS) / http(+SSE) / ws / grpc + token。
- **型抽出**: `scripts/gen-rpc-schema.mjs` が `.d.ts` から param 型を抽出し (`rpc-params.generated.json`)、
  `scripts/gen-grpc-proto.mjs` が型付き `sesame.proto` を生成します。両者は drift-guard テストで保護しています。

## ファイル構成

```
sesame-kit/
├── package.json
├── README.md
├── docs/                   # commands / architecture / library / migration
├── LICENSE
├── LICENSE.biz3
├── bin/
│   └── sesame.js           # CLI 実行エントリ
├── sdk/                    # 生成された型付き SDK (schema/openrpc.json から生成。推奨) — RPC ごと 1 メソッド、HTTP+SSE
│   ├── ts/sesame-client.ts       #   型付き TS クライアント (drift-gated。手編集禁止)
│   └── python/sesame_client.py   #   型付き Python クライアント (drift-gated。手編集禁止)
├── clients/                # 手書きの薄い公式クライアント (低レベル。上級 / カスタム連携向け)
│   ├── python/sesame_client.py   #   UDS/stdio/HTTP/WS + イベント購読、汎用 call() (依存ゼロ)
│   └── js/sesame-client.mjs      #   同等 (Node 20+)。sdk/ と clients/ の違いは README 参照
├── vendor/
│   └── biz3/constants/     # biz3 の import-zero 定数を逐語コピー (single source of truth)
└── src/
    ├── index.js            # 公開ライブラリエントリ
    ├── cli.js              # commander 実装 (基本コマンド + makeCtx)
    ├── cli/                # 機能別コマンド配線 (registerXxxCommands)
    │   └── serve.js        #   sesame serve … (常駐 JSON-RPC バックエンド配線)
    ├── serve/              # 言語非依存バックエンド (1 コア + 5 フレーミング)
    │   ├── jsonrpc.js      #   JSON-RPC 2.0 プロトコルコア (transport 非依存)
    │   ├── registry.js     #   メソッドカタログ (NAMESPACE_OPS から自動公開) + OpenRPC
    │   ├── daemon.js       #   単一常駐 hub への多重化 (直列化/購読/背圧/shutdown)
    │   ├── sesame.proto    #   gRPC 型付き定義 (生成物)
    │   └── framing/        #   stdio / socket(UDS) / http(+SSE) / ws / grpc + token
    ├── client.js           # SesameHub3 高レベルクラス (namespace getter で op を自動注入)
    ├── lock-manager.js     # LockManager (ロック名前解決 + 制御 op。client.js から委譲)
    ├── transport.js        # Hub3WsClient (reconnect/keepalive/queue/sleep)
    ├── auth.js             # Cognito CUSTOM_AUTH + REFRESH_TOKEN_AUTH + jwtSub
    ├── crypto.js           # AES-CMAC + uuid→base64 + cmd code 定数
    ├── util.js             # assertSuccess / subscribeChunks (ページング push の定型) / SesameError ヘルパ
    ├── lock.js / ir.js / presetir.js / sharekey.js   # ドメイン op
    ├── ble/                # BLE 直接制御 (OS非依存コア + 差し替え可能トランスポート)
    │   ├── protocol.js     #   純JS: CMAC鍵/AES-CCM/セグメント/フレーム/mechStatus
    │   ├── session.js      #   状態機械 (initial→login→コマンド応答)
    │   ├── transport.js    #   noble アダプタ (optionalDependency, 遅延require)
    │   └── index.js        #   SesameBle ファサード
    ├── iot.js / account.js / schedule.js / org.js / company.js / access.js / devices.js
    ├── config.js           # ConfigStore (~/.config/sesame-kit/config.json)
    ├── tokens.js           # FileTokenStore
    └── paths.js            # 設定ディレクトリ解決
```

## 生成物 (コミット + CI ガード)

リポジトリ内のいくつかのファイルは**生成・コミット・ガード**されており、手編集しません。ソースを変えたら `npm run build` を実行して結果をコミットしてください:

| 生成物 | 生成元 | 生成コマンド |
| --- | --- | --- |
| `types/**/*.d.ts` (+ `.d.ts.map`) | `src/**/*.js` の JSDoc | `tsc` (`npm run build:types`) |
| `src/serve/rpc-params.generated.json` | 各モジュールの `NAMESPACE_OPS` + `types/*.d.ts` | `npm run build:rpc-schema` |
| `src/serve/sesame.proto`, `src/serve/grpc-methods.generated.json` | RPC レジストリ | `npm run build:grpc-proto` |
| `schema/openrpc.json` | RPC レジストリ | `npm run build:openrpc` |
| `sdk/ts/sesame-client.ts`, `sdk/python/sesame_client.py` | OpenRPC ドキュメント | `npm run build:sdk` |

**方針: 生成物をコミットする**（JSON/proto 契約と同じ慣習。リポジトリを clone した利用者がビルド無しで `.d.ts` を得られ、`npm publish` 時は `prepack` が再生成する）。

コミット済みコピーの整合は 2 つのガードが守ります:
- `tests/serve/schema-drift.test.js` が RPC param スキーマと gRPC proto をインプロセスで再生成しバイト比較する。
- CI (`.github/workflows/ci.yml`) が**フル** `npm run build` を実行し、`git` に差分が出たら失敗する（`types/` を含む生成面全体をカバー）。

`tsc` は `package-lock.json` + `npm ci` でバージョン固定され、各ジェネレータは決定的（タイムスタンプ/乱数なし、`.d.ts.map` は相対ソースパス）なので、再ビルドはマシン間でバイト安定です。CI の "Verify committed artifacts are up to date" が失敗したら、ローカルで `npm run build` を実行して結果をコミットしてください。（歴史的に `types/` が腐ったのは JSON/proto 生成物しかガードされていなかったため。CI のビルド差分ガードがこの穴を塞ぎます。）
