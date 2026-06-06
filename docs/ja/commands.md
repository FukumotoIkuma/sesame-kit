<!-- [English](../en/commands.md) | 日本語 -->

# コマンドリファレンス

> [English](../en/commands.md) · [ドキュメント目次](./index.md)

> CLI のコマンドを領域別にまとめています。各サブコマンドの全オプションは `sesame <cmd> --help` で引けます。
> `sesame serve` 経由で他言語から叩く場合は、`sesame rpc`（または `rpc.discover`）で全メソッドと引数を機械可読に取得できます。

## デバイス操作（デバイス主語）

主語は**デバイス**です。`sesame <device> <action>` は SDK の `device.action()` と同じ並びです。
device は名前（部分一致可）。action 省略でそのデバイスの対話メニュー、device も省略で全デバイスの
対話メニュー（＝ `session`）になります。

```bash
sesame front unlock            # front.unlock()  (部分一致可: sesame 玄関 unlock)
sesame front lock              # 施錠
sesame front toggle            # 現在状態で反転
sesame front status            # 状態 (施錠/解錠・位置)
sesame front autolock 30       # オートロック (BLE 必須。0=無効)
sesame kitchen click           # SESAME Bot クリック (Bot2/Bot3)

sesame front                   # front の対話メニュー
sesame                         # 全デバイスの対話メニュー (session)
```

action: `unlock` / `lock` / `toggle` / `click` / `status` / `autolock <秒>`（**使える操作は型で変わります** — 後述）。

### 経路 (transport) は「オート」が既定

- 既定はオートです。経路は自動で選ばれます。cloud で運べる op は cloud、`autolock` のような BLE 必須の op だけ BLE 接続します (BLE のスキャン/接続コストを毎回は払いません)。
- `--ble-only` / `--cloud-only` で経路を固定します。`--ble-only` は接続に数秒かかります。`--cloud-only` は一部操作が制限されます。
- BLE 接続を保持して連続操作するモードは `sesame session` (= `sesame <device>` の複数版) です。

```bash
sesame front unlock            # オート (ツールが経路を選ぶ)
sesame front autolock 30       # BLE 必須の op → 自動で BLE 接続
sesame front lock --ble-only   # BLE に固定 (接続に数秒)
sesame front lock --cloud-only # クラウドに固定
```

> 設計の詳細（クラウド/BLE の能力モデル統合）は [architecture.md](./architecture.md) を参照してください。

ロック定義の管理は `locks` グループ:

```bash
sesame locks ls                # 登録ロック一覧
sesame locks set-default front
sesame locks add               # 対話で追加 (deviceUUID + secretKey)
sesame locks add --name front --uuid <UUID> --secret <32hex> --model sesame_5_pro  # 非対話/フラグ追加
sesame locks sync-from-devices # devices の結果から自動取り込み
sesame locks rm front
```

クラウド操作の応答は同期 ack (`biz3TriggerLocker`, `success:true`) を待ってから戻ります (timeout 10s)。

> autolock はクラウド経由では設定できません (BLE のみ)。`sesame <device> autolock <秒>`（例: `sesame front autolock 30`、`0`=無効）を使ってください。背景は [architecture.md](./architecture.md)。

---

## Hub3 IR

### 既存キーの発射

```bash
sesame send 停止                         # デフォルトリモコンで発射
sesame send 停止 --remote ac
sesame list                              # リモコンに登録されているキー一覧
```

### 高度な操作

```bash
# 学習: 物理リモコンを Hub3 に向けてボタンを押す
sesame ir learn ac 強風                  # remote=ac に "強風" キーを学習登録
                                         # → Hub3 を REGISTER モード → 波形捕捉 → CONTROL に戻し → addIRCode

# モード制御
sesame ir mode get [hub3]                # 現在モード取得 (0=CONTROL / 1=REGISTER)
sesame ir mode set 1 [hub3]              # 強制 REGISTER 切替 (デバッグ用)

# キー CRUD
sesame ir key rename ac 強風 強運転        # キー名変更 (server + config)
sesame ir key rm ac 試運転                # キー削除

# リモコン CRUD (server 側)
sesame ir remote-list ac              # 登録済みリモコン (irType 指定)
sesame ir remote-rm ac                   # server から削除
sesame ir remote-rename "リビング" ac      # server alias 変更

# プリセット DB
sesame ir search ac ダイキン           # メーカー DB 検索 (max 1000)
sesame ir match ac <hex波形>           # 学習波形 → 既知リモコン照合
```

> 自己学習リモコンを指すときは `irType` に実 type `0xFE00`(65024) を使います。メニュー id の `0xFEFF` を渡すと
> サーバ照合が一致せずリモコンが見つかりません。詳細は [architecture.md](./architecture.md)。

### リモコンと Hub3 の登録

`send` / `ir learn` を使うには、先にリモコン（とその Hub3）を config に取り込む必要があります。サーバから一括取り込みが最速です:

```bash
sesame hub3 sync-from-devices    # Hub3 を取り込む
sesame remote sync-from-devices  # リモコンを取り込む (Hub3・irType は自動判定) + キーも取得
sesame remote ls                 # 登録済みリモコン一覧
sesame remote set-default ac     # 引数なし `sesame send <key>` で使う既定リモコン
```

1 つずつ追加するなら `sesame hub3 add` / `sesame remote add`（どちらも一覧から選ぶ。UUID/irType の手打ち不要）。`sesame remote sync-keys [name]` でリモコンのキー一覧を取り込み直します。

---

## デバイス管理

```bash
sesame device user-ls                    # 個人デバイス一覧
sesame device status <uuid>              # 現在状態
sesame device rename <uuid> "玄関 SESAME"  # 名前変更
sesame device rm <uuid>                  # company から削除

sesame history <uuid>                    # ロック開閉履歴
sesame history                           # 全デバイス
sesame battery <uuid>                    # 電池履歴 (light/heavy 電圧 + 割合)
sesame firmware                          # 配信中ファームウェア一覧
```

---

## WebAPI proxy

biz3 dev console で発行する REST API key (apiKeyId) を `config.apiKeyId` に設定すると、任意の REST WebAPI を WebSocket 経由で proxy 呼び出しできます:

```bash
# config.json に "apiKeyId": "..." を入れた状態で:
sesame webapi webapi_ssm_shadow_get --query '{"device_id":"..."}'
sesame webapi webapi_history_get --query '{"device_id":"...","page":0,"lg":"ja","isBiz":true}'
sesame webapi webapi_cmd_send --body '{"device_id":"...","cmd":83,"sign":"...","history":"..."}'
```

---

## 予約スケジュール (biz3Schedule)

```bash
sesame schedule ls                 # 登録済み予約 (lock/unlock/upgrade_firmware) 一覧
sesame schedule cancel <id>        # 予約を取消 (id 省略時は一覧から対話選択)
```

> 予約の **新規作成 op は biz3 web に存在しない** ため、CLI も list / cancel のみ。

---

## アクセス制御 (NFC カード / 暗証番号)

SESAME Touch (Pro) の NFC カード・キーパッド暗証番号の **サーバ DB 同期** op 群。
実機ファームウェアへの書き込みは別系統 (BLE) で、ここは DB 側の同期のみを扱う 2 層構造。

```bash
sesame access cards ls --device <uuid> [--device <uuid2> ...]   # カード一覧
sesame access cards clear --device <uuid>                       # 指定デバイスのカード全削除
sesame access cards rm --json '[{"deviceID":"...","cardID":"..."}]'   # 個別削除 (応答なし)
sesame access cards owner <cardID> [ownerSubUUID]               # 所有者割当 ('' で解除)
sesame access passcodes ls --device <uuid>                      # 暗証番号一覧
```

> `rm` (delCards/delPasscodes) は biz3 に応答ハンドラが無く **fire-and-forget**。完了応答は返りません。

---

## 会社 / 組織管理 (biz3 enterprise)

複数会社・社員・役割・デバイスグループを扱う法人向け機能です。`companyID` はログイン情報から自動補完されます。

```bash
# 会社
sesame company ls                  # 所属会社一覧
sesame company rename "新社名"      # 優先会社の改名
sesame company add "新会社"         # 会社を新規登録
sesame company payment             # 課金設定取得

# 組織 (org)
sesame org employee ls             # 社員一覧
sesame org employee search <kw>    # CS 横断のユーザー検索
sesame org role ls                 # 役割タグ一覧
sesame org group ls                # 社員グループ一覧
sesame org device-group ls         # デバイスグループ一覧
sesame org keys device <deviceUUID>   # デバイス側の鍵保有従業員を列挙
```

### ゲスト共有 (鍵共有 URL / QR)

SESAME アプリが読む共有 QR と同じ `ssm://UI?t=sk&sk=…&l=…&n=…` URL を生成します。
`--level 2` (ゲスト) のときだけ使い捨て `guestKeyId` を発行して埋め込みます (biz3 と同じ挙動)。

```bash
sesame org keys share-url --device <uuid> --level 2 --name "来客用"   # ゲスト共有 URL
sesame org keys share-url --device <uuid> --level 1                  # マネージャ鍵共有
sesame org keys share-url --device <uuid> --qr                       # 端末に QR 表示 (要 qrcode-terminal)
```

> 共有 URL の組み立て・解析は biz3 `generateInviteGuestQRCodeByInfo` / `readQrcode` を 1:1 移植。
> **画像化ライブラリ非依存**で、出力 URL を任意の QR 生成器に貼っても共有できます。
> 作成/更新系の多くは構造体を `--json '<…>'` で受けます（各サブコマンドの `--help` に例あり）。
> `org employee confirm <email>` は biz3 仕様上、成功時に現セッションを signout する点に注意。

---

## Hub3 IoT 制御 (biz3OperateIoT)

Hub3 本体への直接コマンド (LED 調光・LTE リレー・ファーム更新・Matter ペアリング等)。
`--device <hub3UUID> --secret <hex>` を渡すか、対話時は接続デバイスから選択。

```bash
sesame iot led 80 --device <uuid> --secret <hex>   # LED 調光 (duty 0-255)
sesame iot led --get --device <uuid> --secret <hex># 現在の調光取得
sesame iot relay on  --device <uuid> --secret <hex># LTE リレー開閉
sesame iot firmware-update --device <uuid> --secret <hex> --wait 60
sesame iot matter-code --device <uuid> --secret <hex>   # Matter ペアリングコード
```

> `relay` は fire-and-forget で、Hub3 から応答が返りません（送信成功＝切替成功ではありません）。`off` の opcode 割当は公式ソース上で未確認で、実機では別挙動になる可能性があります。

---

## プリセット IR リモコン (HXD command)

エアコン等を「学習」ではなく **プリセット DB の命令で** 発射します。Hub3 を `--device` に指定:

```bash
sesame preset-ir air --device <hub3uuid> --code <n> --power --temp 26 --mode 1 --fan 2
sesame preset-ir button --device <hub3uuid> --code <n> --button power --irtype 8192
sesame preset-ir send --device <hub3uuid> --command <hex> --irtype 49152   # 生 hex 発射
```

> プリセットの command 生成 (biz3 の HXDCommandProcessor) は未移植のため、プリセット発射は現状機能しません。
> 自己学習リモコン (`sesame ir learn`) を使ってください（[既知の制限](../../README.ja.md#健全性--既知の制限)）。

---

## BLE 直接制御 (クラウド非経由)

PC の Bluetooth から登録済み SESAME を**直接**操作します。クラウド (WS) を介さないので
オフラインでも動き、**クラウドでは不可だった `autolock` 等の設定系が実機に反映されます**。

BLE 操作は専用コマンドではなく、デバイス主語の操作に **`--ble-only` を付ける**だけ
（`autolock` は BLE 必須なので無指定でも自動で BLE）:

```bash
sesame front status --ble-only   # 現在状態 (施錠/解錠, 位置)
sesame front unlock --ble-only   # 解錠 (ロック/Bike)
sesame front lock   --ble-only   # 施錠 (ロック)
sesame front toggle --ble-only   # 状態を見て反転 (ロック)
sesame kitchen click --ble-only  # SESAME Bot のクリック (Bot2/Bot3)
sesame front autolock 30         # オートロック (BLE 必須。本当に効く)
sesame front autolock 0          # 無効化
```

> **BLE エラーは `SesameResultCode` で意味づけ済み** — デバイスが非 0 の結果を返すと、ライブラリは
> `BleResultError`（`.resultCode` / `.resultName`）を投げます。`resultName` は公式 SesameSDK の
> `SesameResultCode`（`success`/`invalidFormat`/`notSupported`/`invalidSig`/`notFound`/`unknown`/
> `busy`/`invalidParam`/`invalidAction`）に一致し、機械的に分岐できます。
> 注: これは**デバイス層 (SesameOS3) の taxonomy** で、BLE 直接経路でのみ取得できます
> (クラウド経路はこの code を surface しないため `sesame serve` の `kind` には乗りません)。

### デバイス型ごとの操作 (公式 SesameSDK 準拠)

操作セットはデバイスの種別で異なります。SDK では能力が型ごとに非対称に定義されており、本 CLI もそれを `config` の
`model` から判定して同じ非対称性を再現します。対応外の操作はコマンドが拒否されます（例: Bot に `lock` → 「click を使え」）。

| 種別 (model 例) | BLE 操作 | mechStatus |
|---|---|---|
| ロック `sesame_5`/`_pro`/`sesame_6`/`_pro`/`_us`/`miwa` | `lock` `unlock` `toggle` `autolock` `status` | 施錠/解錠 + 位置 |
| Bot `bot_2`/`bot_3` | `click` `status` | 施錠/解錠 (位置なし) |
| Bike `bike_2`/`bike_3` | `unlock` `status` | 施錠/解錠 (位置なし) |
| Touch/Face/Sensor/Remote, Hub3, WiFiModule2 | (BLE 施錠操作なし) | — |
| OS2 `sesame_2`/`_4`, `ssmbot_1`, `bike_1` | BLE 未実装 (鍵導出/暗号が別系統)。クラウド経由で操作 | — |

> 「施錠/解錠」は OS3 では `isInLockRange` の有無による **2 値**のみ。OS3 に中間状態 (moved) はありません
> (Sesame2 等 OS2 系のみ moved を持ちます)。BLE 実装の設計は [architecture.md](./architecture.md) を参照してください。

ライブラリとしても利用可:

```js
import { SesameBle } from "sesame-kit";   // or: import { ble } from "sesame-kit"
await SesameBle.use({ deviceUUID, secretKey }, async (lock) => {
  await lock.unlock();
  await lock.autolock(30);
  console.log(lock.lastStatus);            // { state, batteryMv, position, ... }
});
```

> 対象は **SesameOS3** (SESAME 5 / 5 Pro / Touch 等)。新規ペアリング (未登録デバイスの登録) は別フェーズ。

---

## 対話セッション

対話セッション（`sesame` / `sesame <device>` / `sesame session`）は**アプリ的なオート**です。
**操作できるデバイスを全部**載せます: ロック/Bot/Bike（BLE+クラウド）と、ログイン済みなら **Hub3**（クラウド: IR 送信 / リレー / LED）。
BLE を best-effort で張りつつ、**BLE が 0 でも終了しません**: 圏外/権限なしのデバイスはログイン済みなら
**クラウドで操作**します（BLE が張れたデバイスは BLE を優先＝低遅延＋autolock 可）。

```text
$ sesame                      # 全デバイス (alias: sesame session / watch)
[ble] バックグラウンドで接続中... (クラウドで操作可能)
─── SESAME セッション ── 矢印キーで選択 ───
  front   [sesame_5·BLE]:   state=locked pos=-176
  kitchen [bot_2·cloud]:    (BLE未接続)
  hub3-居間 [hub3·hub3]:    (Hub3: IR / リレー / LED)

? 操作するデバイス          ← ① デバイスを選ぶ
? front の操作              ← ② 操作を選ぶ (型で変わる)
  ロック  : 🔓 解錠 / 🔒 施錠 / ↕ トグル / ⏱ オートロック / ℹ 状態
  Bot     : 👆 クリック / ℹ 状態
  Hub3    : 📡 IR 送信 (リモコン→キー選択) / 🔌 リレー ON/OFF / 💡 LED 調光
```

各デバイスの末尾タグ `·BLE` / `·cloud` が経路。**`autolock` は BLE 必須**なので、cloud のデバイスでは
「近づいて再試行」と案内します。接続が 1 個だけならデバイス選択を省略します。

**ライブ更新**: 画面は **Ink (React for CLI)** 製のライブダッシュボードで、BLE の状態変化や
バックグラウンド接続の完了を受けて**その場で再描画**します（cloud→BLE への昇格もリアルタイム）。
起動はクラウドで即メニュー表示し、BLE は裏で接続するので 8 秒のスキャンを待ちません。終了は `q` / Esc。

**前提**:
- 鍵は既存の `config.locks`（`sesame locks sync-from-devices` で取り込んだ deviceUUID/secretKey）を再利用。新規登録は不要。
- BLE アダプタ `@abandonware/noble` が必要。`optionalDependency` なので `npm install` で**自動導入**を試み、未対応環境でもインストール自体は壊れません (BLE だけ無効)。手動で入れるなら `npm i @abandonware/noble`。
- **macOS は Terminal/iTerm に Bluetooth 権限が必要**（システム設定 → プライバシーとセキュリティ → Bluetooth）。
- ロックの BLE 圏内（近接）にいること。
