<!-- [English](../en/ble.md) | 日本語 -->

# BLE 直接制御

> [English](../en/ble.md) · [ドキュメント目次](./index.md)

登録済みの SESAME を、クラウドを経由せず PC から Bluetooth で直接操作します。オフラインで動作し、**クラウドでは変更できないオートロックなどの設定も、BLE 経由ならデバイスに反映されます**。BLE のみの操作にログインは不要です。

## コマンド

BLE 制御は独立したコマンドではありません。デバイス操作に `--ble-only` を付けます（`autolock` は BLE 必須のため、フラグなしでも BLE を使います）。

```bash
sesame front status --ble-only   # current state (locked / unlocked, position)
sesame front unlock --ble-only   # unlock (lock / Bike)
sesame front lock   --ble-only   # lock
sesame front toggle --ble-only   # toggle based on current state
sesame kitchen click --ble-only  # SESAME Bot click (Bot2 / Bot3)
sesame front autolock 30         # autolock (BLE required; actually takes effect)
sesame front autolock 0          # disable
```

`--ble-only` を付けない場合、経路（クラウド / BLE）は自動で選ばれます。`--cloud-only` でクラウドに固定します。

### `sesame ble` — 読み取り専用 BLE コマンド

BLE サーフェスの小さな**読み取り専用**スライスも `ble` コマンドグループとして公開しており、コードを書かずにデバイスを調べられます。

```bash
sesame ble scan [--timeout <ms>]         # 鍵なしの近接スキャン（listNearbyDevices・secretKey 不要）
sesame ble cards <device>                # 登録済み NFC カード一覧（Touch / Touch Pro）
sesame ble passcodes <device>            # 登録済みキーパッド暗証番号一覧（Touch / Touch Pro）
sesame ble fingers <device>              # 登録済み指紋一覧（Touch Pro / Bike3）
sesame ble faces <device>                # 登録済み顔一覧（Face）
sesame ble palms <device>                # 登録済み掌紋一覧（Palm）
sesame ble mode <device> <type>          # 現在の登録モードを取得（card/passcode/finger/face/palm）
sesame ble script <device> [--index <n>] # Bot2/Bot3 のスクリプト名一覧 + 現在スクリプト
```

`<device>` は config のロック名か deviceUUID です。`scan` 以外の接続を伴うサブコマンドは `--secret <hex>` / `--model <model>`（config のロックに無いデバイスを対象にする）と `--timeout <ms>`（publish 収集タイムアウト・既定 8000）を受け付けます。`scan` は鍵なしです。

このページのそれ以外 — 生体・アクセス制御の**登録**（追加 / 削除 / 改名・モード設定）、Bike3 指紋の削除 / 改名 / モード設定、Bot2 スクリプトの切替 / 書き込み / index 実行、WM2 / Hub3 プロビジョニング、BLE OTA、ペアリング / 登録、工場出荷 `reset`、OS2 ファサード — は**ライブラリ専用（CLI コマンドなし）**のままです。`sesame ble` の読み取りコマンドは以下のライブラリ読み出しと同じコード経路で、ユニットテスト済みですが**実機未確認**です。

## デバイス型ごとの能力（公式 SesameSDK に準拠）

操作セットはデバイス型ごとに異なります。公式 SDK は能力を型ごとに非対称に定義しており、この CLI は設定の `model` からそれを再現します。サポートされない操作は拒否されます（例: Bot に対する `lock` → 「click を使う」）。

| 型（例: モデル） | BLE 操作 | mechStatus |
|---|---|---|
| Lock `sesame_5` / `_pro` / `sesame_6` / `_pro` / `_us` / `miwa` | `lock` `unlock` `toggle` `autolock` `status` | locked / unlocked + position |
| Bot `bot_2` / `bot_3` | `click` `status` | locked / unlocked (no position) |
| Bike `bike_2` | `unlock` `status` | locked / unlocked (no position) |
| Bike3 `bike_3` | `unlock` `status` + 指紋登録 API（`lock.fingerPrint`、後述） | locked / unlocked (no position) |
| Touch / Touch Pro / Face / Palm `ssm_touch` / `_pro` / `sesame_face*` | （ロック操作なし）— 代わりに生体・アクセス制御の **登録** API（`lock.biometric`、後述） | — |
| Sensor / Remote | （BLE ロック操作なし） | — |
| Hub3 `hub_3` / `hub_3_lte` | （ロック操作なし）— 代わりに Wi-Fi プロビジョニング / 子鍵削除 / 接続種別 API（`lock.hub3()`、後述） | — |
| WifiModule2 `wm_2` | （ロック操作なし）— 代わりに Wi-Fi プロビジョニング / 子鍵登録 API（`lock.wifi(...)`、後述） | — |
| OS2 `sesame_2` / `_3` / `_4`, `ssmbot_1`（Bot1）, `bike_1`（Bike1） | `lock` `unlock` `toggle` `autolock` `status`（Bot1 = `click`、Bike1 = `unlock`）— **別系統の OS2 プロトコル**を使う `SesameOS2Ble` 経由（後述） | locked / unlocked / **moved** + position |

> OS3 では「locked / unlocked」は `isInLockRange` のみに基づく 2 値で、中間（moved）の状態はありません。`moved` を持つのは OS2 デバイス（Sesame2/3/4）のみです。

## 結果コード

デバイスが非ゼロの結果を返すと、ライブラリは `BleResultError`（`.resultCode` / `.resultName`）をスローします。`resultName` は公式 SesameSDK の `SesameResultCode`（`success` / `invalidFormat` / `notSupported` / `invalidSig` / `notFound` / `unknown` / `busy` / `invalidParam` / `invalidAction`）と一致するため、これで分岐できます。

これはデバイス層（SesameOS3）の分類で、BLE 経由でのみ得られます。クラウド経路ではこれらのコードは表面化せず、`sesame serve` の `kind` にも現れません。

## 要件

- BLE アダプタ `@abandonware/noble`。`optionalDependency` のため `npm install` が自動で試行し、非対応プラットフォームでもインストールは壊れません（BLE が単に無効化されるだけです）。手動でインストールする場合は `npm i @abandonware/noble`。
- **macOS ではターミナルに Bluetooth 権限が必要です**（システム設定 → プライバシーとセキュリティ → Bluetooth）。これは OS レベルの権限で、どの BLE 実装でも避けられません。
- ロックの Bluetooth 通信圏内にいること。

## ライブラリとして

```js
import { SesameBle } from "sesame-kit";   // or: import { ble } from "sesame-kit"

await SesameBle.use({ deviceUUID, secretKey }, async (lock) => {
  await lock.unlock();
  await lock.autolock(30);
  console.log(lock.lastStatus);            // { state, isInLockRange, position, batteryRaw, ... }（batteryRaw は電圧 ADC 生値）
});
```

### BLE 専用の設定・読み出し（ロック機種）

クラウドに相当機能はなく、BLE で実機へ直接送ります。

```js
await SesameBle.use({ deviceUUID, secretKey }, async (lock) => {
  // 角度キャリブレーション: 施錠 / 解錠の目標角（符号付き 16bit のエンコーダ値）を設定。
  // 成功すると lock.lastMechSetting の位置が新しい値で局所更新される。
  await lock.configureLockPosition(lockTargetAngle, unlockTargetAngle);
  console.log(lock.lastMechSetting);       // { lockPosition, unlockPosition, autoLockSecond }
  console.log(lock.lastOpsSetting);        // { opsLockSecond }（デバイスが publish 済みのとき）

  console.log(await lock.getVersionTag()); // ファームウェアのバージョン文字列

  await lock.magnet();                     // magnet コマンド（引数なし・SESAME 5 / 6 系）

  // Open Sensor の自動施錠秒数（CHSesame5Device.opSensorControl・item 92・2B LE）。
  // 成功すると lock.lastOpsSetting.opsLockSecond がローカルで更新されます。
  await lock.opSensorControl(300);         // 0 = 無効

  // BLE 送信出力（item 206・符号付き 1B）。SDK では OS3 ロックと
  // 生体・アクセス制御デバイスの双方が実装するため、両方で利用できます。
  await lock.setBleTxPower(0);             // -128..127

  // アドバタイズ productType の書き換え（item 205・生バイト列・SESAME 5 / 6 系）。
  await lock.sendAdvProductType(Buffer.from([/* 機種固有のバイト列 */]));

  // 実機履歴: 1 件読み出し → recordId（先頭 4B）で 1 件削除。
  const record = await lock.history();     // Buffer（空 = 履歴なし）
  if (record.length) await lock.deleteHistory(record);
});
```

時刻同期も login 時に自動で行われます。デバイス時刻が 3 秒以上ずれていると、`connect()` が裏で `time(8)` コマンドを送ります（応答を待たない fire-and-forget。公式 SDK と同じ挙動）。

`configureLockPosition`・`magnet`・`opSensorControl`・`sendAdvProductType` はロック専用操作（SESAME 5 / 6 系）で、Bot / Bike / 生体 / Hub3 で呼ぶと autolock と同様に throw します。`setBleTxPower` は OS3 ロック**と**生体・アクセス制御デバイスで利用できます（SDK では両方が実装）が、Hub3 / WM2 / OS2 では throw します。`reset()` は任意の OS3 デバイス（ロック / Bot2 / Bike2/3 / 生体 / Hub3 / WM2）を工場出荷状態へ戻します。`Reset(104)` を送り、成功時にセッションを破棄します（保持している `secretKey` は呼び出し側で破棄してください）。OS2 デバイスは別系統の reset を使うため throw します。

### 生体・アクセス制御の登録（Touch / Touch Pro / Face / Palm）

Touch / Touch Pro / Face / Palm はロック操作を持たず、代わりにカード・指紋・暗証番号・顔・掌紋の BLE 登録 API を `lock.biometric`（同一 session 上の `BiometricCommands` インスタンス）として公開します。このゲッタは能力テーブルでゲートされており、ロック / Bot / Bike / Hub3 / 未知機種で参照すると throw します（非対応の API を捏造しません）。

```js
await SesameBle.use({ deviceUUID, secretKey, model: "ssm_touch" }, async (touch) => {
  const bio = touch.biometric;

  // 登録中にデバイスが push する publish イベント（FIRST / NOTIFY / LAST / CHANGE / DELETE）を購読。
  const off = bio.registerDelegate({
    onCardReceiveStart: () => {},
    onCardReceive: (cardID, cardName, cardType) => console.log("card", cardID),
    onCardReceiveEnd: () => {},
  });

  await bio.cardModeSet(1);                 // カード登録モードへ。以降デバイスが CARD_FIRST/NOTIFY/LAST を push
  await bio.cardAdd(idBytes, "name");       // カードを実機へ書き戻す
  await bio.cardDelete(cardID);             // hex id で削除
  await bio.cardBatchAdd(allCardBytes);     // STP 分割転送による一括登録（209B 分割・パケット間 4 秒）

  // fingerPrint* / passcode* / face* / palm* も同型（ModeSet/Get, Add/Delete/Change, batchAdd）。

  // Remote Nano トリガ遅延（item 190 設定 / 191 publish）と Face レーダー感度（item 200 設定 / 201 publish）:
  await bio.setTriggerDelay(30);             // UByte 0..255 秒。デバイスは onTriggerDelaySecondReceived で push し返しうる
  await bio.setRadarSensitivity(rawPayload); // 不透明なレーダーパラメータ Buffer を無加工で送信。publish は onRadarReceive(payload) で受信
  off();
});
```

`setTriggerDelay` / `setRadarSensitivity` は `CHRemoteNanoCapableImpl.setTriggerDelayTime` / `CHDeviceConnectCapableImpl.setRadarSensitivity` を 1:1 で移植したものです。対応する publish（`REMOTE_NANO_PUB_TRIGGER_DELAYTIME` 191 → `onTriggerDelaySecondReceived({ triggerDelaySecond })`、`SSM_OS3_RADAR_PARAM_PUBLISH` 201 → `onRadarReceive(payload)`）も同じ `registerDelegate` で受け取れます。レーダー payload の構造は SDK 側でも不透明なため、バイト列をそのまま素通しします。いずれもユニットテスト済みですが**実機未検証**です。

`registerDelegate` は登録以外に、生体デバイスが push するその他の publish も配信します（`CHSesameBiometricDeviceImpl.onGattSesamePublish`（`CHSesameBiometricDeviceImpl.kt:159-255`）を 1:1 で移植）:

- `mechStatus`（81）→ `onMechStatus(status)`。生体デバイスの `mechStatus` は**ロックの状態ではありません**: SDK の `CHSesameTouchProMechStatus` は raw バイトを保持するだけの pass-through で、`position`/`target`/`isInLockRange`/… の getter はすべて `CHSesameProtocolMechStatus` の既定値に落ちます。よってロックの 7B/3B parse は適用しません。`parseBiometricMechStatus` はこれを再現し、`{ data, position:0, target:0, isInLockRange:false, isInUnlockRange:true, isStop:null, isCritical:null, isBatteryCritical:false, batteryRaw }` を返します（`batteryRaw` は SDK が `reportBatteryData` に渡す先頭 2B（LE））。同じフォールバックを `SesameBleSession` にも配線したため、`session.lastStatus` は生体デバイスでも反映されるようになりました（従来はロック parse が throw して未設定でした）。
- `PUB_KEY_SESAME`（102）→ `onSesameKeysReceived({ keys, slotFull, emptySlotCount })`。`parsePubKeySesame` は payload を 23B スロットに分割し（`divideArray(23)`、末尾端数は 0x00 ゼロ埋め）、空きスロット（`it[22] == 0`）をスキップ、占有スロットを SS5 鍵（`it[21] == 0` → id = 先頭 16B hex、value `[0x05, lockStatus]`）または SS2 鍵（`it[21] != 0` → id = 22B ASCII + `"=="` の base64 復号、value `[0x04, lockStatus]`）として読みます。`slotFull` は SDK の `setSlotFull(!hasEmptySlot)` に従い、既定（非 OpenSensor）は全ゼロスロット 1 つで空きありとみなします。OpenSensor 機は 1 スロットを予約するため `parsePubKeySesame(payload, { isOpenSensor: true })` で**2 つ以上**の空きを要求します（delegate は model 文脈を持たないため）。
- `SSM3_ITEM_CODE_BATTERY_VOLTAGE`（202）→ `onBatteryVoltageReceived(payloadHex)`。SDK はサーバへ post しますが、kit は hex 化した payload を delegate へ渡し、アップロードは呼び出し側 / `access` 層に委ねます。
- `SSM3_ITEM_CODE_SESAME_UNSUPPORT`（204）→ `onSupportChanged(false)`（SDK の `ssm2KeysMap.setSupport(false)`）。
- `SSM3_ITEM_CODE_BLE_TX_POWER_SETTING`（206）→ `onBleTxPowerReceive(txPower)`。`txPower` は `payload[0]` を**符号付き**バイト（Kotlin `Byte`）として読みます。

これらの受信側ハンドラはユニットテスト済みですが**実機未検証**です。

カード / 暗証番号の**一括**登録（`cardBatchAdd` / `passcodeBatchAdd`）は `StpItemCode` enum（`src/itemcodes.js` の `STP_ITEM_CODES`: cards 182/183, passcodes 184/185）で送られます。これは `SesameItemCode` とは別の数値空間で、`WM2_ACTION_CODES` と同じ隔離方針です。

### Bike3 指紋（`lock.fingerPrint`）

SESAME Bike3（`bike_3`）は Bike2（`unlock` のみ）に指紋 capability を足した型です。SDK のクラスは `CHSesameBike3Device : CHSesameBike2Device(), CHFingerPrintCapable`（`CHSesameBike3Device.kt:20-24`）です。生体デバイス全機能（カード / 暗証番号 / 顔 / 掌紋）は持たないため、`lock.fingerPrint` では**指紋サブセットのみ**を公開します。このゲッタは `fingerprint` 能力フラグでゲートされ、Bike3 以外の機種で参照すると throw します。

```js
await SesameBle.use({ deviceUUID, secretKey, model: "bike_3" }, async (bike) => {
  await bike.unlock();                        // Bike2 から継承した解錠操作も使える

  const fp = bike.fingerPrint;
  const off = fp.registerDelegate({
    onFingerPrintReceiveStart: () => {},
    onFingerPrintReceive: (id, name, type) => console.log("finger", id),
    onFingerPrintReceiveEnd: () => {},
  });
  await fp.fingerPrintModeSet(1);             // SSM_OS3_FINGERPRINT_MODE_SET（122）— 登録モードに入る
  await fp.fingerPrints();                    // SSM_OS3_FINGERPRINT_GET（117）— 一覧
  await fp.fingerPrintChange(id, hexName);    // SSM_OS3_FINGERPRINT_CHANGE（115）— 改名
  await fp.fingerPrintDelete(id);             // SSM_OS3_FINGERPRINT_DELETE（116）
  const mode = await fp.fingerPrintModeGet(); // SSM_OS3_FINGERPRINT_MODE_GET（121）
  off();
});
```

実装は同一 session 上で `BiometricCommands` の指紋メソッド（itemCode 115〜122）を再利用し、ゲッタは指紋 5 メソッド + `registerDelegate` に面を絞るだけです。ユニットテスト済みですが**実機未確認**です。

これはアクセス制御管理の「デバイス側 / ファームウェア書き込み」側です。クラウド DB 同期側（`postCards` / `delPasscodes` …）は `sesame-kit/access` にあり、公式 biz3 の設計では BLE で実機を先に書き換え、その ack コールバックでサーバ DB を追従させる 2 段構造です。

この 2 段は、BLE=実機 / cloud=DB の責務分担を崩さない最小限のブリッジで実結線します。BLE 側は `bio.onEnroll(onEnrolled, { card, passcode })`（または単体 delegate の `ble.createEnrollCollector({ onEnrolled })`）が 1 登録セッション分（`*_FIRST` → `*_NOTIFY`(×N) → `*_LAST` の publish 窓）を 1 バッチ `{ kind, records }` に集約します。cloud 側は `access.syncEnrolledCards(client, { deviceUUID, records })` / `access.syncEnrolledPasscodes(...)` がそのレコードを写像して `postCards` / `postPasscodes` へ委譲します（新しい WS op は増やしません。`access.enrolledToCardList(records)` が純粋な変換器）。生体層は `access` を import せず、同期するかは呼び出し側が `onEnrolled` 内で決めます:

```js
const off = bio.onEnroll(async ({ kind, records }) => {
  if (kind === "card") await access.syncEnrolledCards(wsClient, { deviceUUID, records });
});
await bio.cardModeSet(1); // 以降の実機タップが BLE → onEnroll → access.postCards へ流れる
```

NOTIFY 由来の `cardName` は hex 文字列で届き、デバイス publish に `nameUUID` は含まれないため、`enrolledToCardList` はレコードごとに v4 UUID を採番します（`updateCardName` と同じ v4 要件）。上書きしたい場合は明示的な `list` を渡してください。本ブリッジはユニットテスト済みですが、`*_FIRST`/`*_LAST` の到達順と `*_LAST` 時の DB 反映は **実機未検証** です。

### Wi-Fi プロビジョニング・子鍵登録（WifiModule2）

`WifiModule2`（`wm_2`）はロック操作を持たず、代わりに `lock.wifi({ companyId })`（同一 session 上の `WifiModule2` インスタンス）として BLE プロビジョニング API を公開します。このゲッタは能力テーブルでゲートされており、WM2 以外の機種で参照すると throw します（非対応の API を捏造しません）。WM2 は SESAME ロック（`fd81`）とは**別の GATT サービス**上にあるため、`SesameBle` を `model: "wm_2"` で構築すると既定 transport に WM2 GATT（`WM2_GATT`）が自動で結線されます。

```js
await SesameBle.use({ deviceUUID, secretKey, model: "wm_2" }, async (dev) => {
  const wifi = dev.wifi({ companyId });     // companyId = API_GATEWAY_CLIENT_ID（config/env から供給）

  // WM2 が push する正規化済み publish イベント: { kind: "scanWifiSSID" | "wifiSSID" | "wifiPassword"
  //   | "networkStatus" | "sesameKeys" | "otaProgress", ... }
  const off = wifi.onPublish((ev) => console.log(ev));

  wifi.scanWifiSSID();                       // 結果は { kind: "scanWifiSSID", rssi, ssid } で届く
  await wifi.setWifiSSID("my-ap");
  await wifi.setWifiPassword("secret");
  await wifi.connectWifi();                  // companyId + deviceUUID から verification を生成
  wifi.networkStatus();                      // 状態は { kind: "networkStatus", isNet, isIot, ... } で届く

  // 子 SESAME 鍵を WM2 に登録（その鍵で WM2 が中継できるようにする）/ 削除する。
  await wifi.insertSesames({ deviceUUID: childUUID, secretKey: childSecret, sesame2PublicKey, deviceModel });
  await wifi.removeSesame(sesameKeyTag);

  // WM2 を工場出荷状態へリセット（RESET_WM2 を送出。成功時に session を破棄＝dropKey 相当）。
  // ファサード経由でも dev.resetWifiModule2() で呼べる。
  await wifi.reset();
  off();
});
```

WM2 コマンドは `WM2ActionCode` enum（`src/itemcodes.js` の `WM2_ACTION` / `WM2_ACTION_CODES`）で送られます。これは `SesameItemCode` とは別の数値空間で、生体の `StpItemCode` と同じ隔離方針です。純関数の data builder / publish parser（`setWifiSSIDData`・`parseWM2Publish` など）も `sesame-kit/ble`（`ble.wm2.*`）から export されており、独自結線に利用できます。

### Wi-Fi プロビジョニング・接続種別（Hub3）

Hub3（`hub_3` / `hub_3_lte`）もロック操作を持たず、`lock.hub3()`（同一 session 上の `Hub3Commands` インスタンス）として BLE プロビジョニング API を公開します。このゲッタは能力テーブルでゲートされており、Hub3 以外の機種で参照すると throw します。WM2 と違い **Hub3 は既定 SESAME GATT**（`fd81`）上にあるため特別な GATT 結線は不要です（`CHHub3Device : CHSesameOS3` で OS3 スタックを継承）。Wi-Fi コマンドは別 enum ではなく **`SesameItemCode` に直接**乗ります（`src/itemcodes.js` の Hub3 固有コード 131–136 / 209）。これは SDK 自体の Hub3 のレイアウトです。

```js
await SesameBle.use({ deviceUUID, secretKey, model: "hub_3" }, async (dev) => {
  const hub = dev.hub3();

  // Hub3 が push する正規化済み publish: { kind: "scanWifiSSID" | "networkType"
  //   | "mechSetting" | "sesameKeys" | "otaProgress" | "ssidMarker", ... }
  const off = hub.onPublish((ev) => console.log(ev));

  hub.scanWifiSSID();                        // 結果は { kind: "scanWifiSSID", rssi, ssid } で届く
  await hub.setWifiSSID("my-ap");            // HUB3_UPDATE_WIFI_SSID (136)
  await hub.setWifiPassword("secret");       // HUB3_ITEM_CODE_WIFI_PASSWORD (135)
  await hub.removeSesame(childUUID);         // REMOVE_SESAME (103); data = dash 除去 UUID を decode した生 16B
  hub.networkType();                         // { kind: "networkType", isWifiConnected, isLTEConnected } で届く
  off();
});
```

Hub3 は BLE のロック制御 op を持ちませんが、共通の OS3 経路は継承します。`connect`/`login`・`register`（`SesameBle.register()`）・`reset()`（`Reset(104)`）・`updateFirmware()`（`MOVE_TO(84)`、後述）はいずれも動作します。純関数の data builder / publish parser（`setWifiSSIDData`・`parseHub3Publish`・`parseNetworkType` など）も `sesame-kit/ble`（`ble.hub3.*`）から export されており、独自結線に利用できます。**実機未確認**です（特に `networkType` の *要求* は SDK では publish 受信のみ確認でき、送信コマンドとしては未確認）。

### BLE 経由ファームウェア更新（DFU / OTA）

`lock.updateFirmware({ onProgress })` で BLE OTA を開始します。経路は model で分岐します（SDK と 1:1）。WM2 は `OPEN_OTA_SERVER`（126）を送り（`CHWifiModule2Device.updateFirmware`）、Hub3 / OS3 ロックは `MOVE_TO`（84）を送ります（`CHHub3Device.updateFirmwareBleOnly` / `CHSesameOS3.updateFirmware`）。進捗は publish で届き、payload の先頭 1 バイトが進捗値です。OTA を持たない機種（OS2・Bot/Bike・生体・未知）は op を捏造せず明示エラーを投げます。

```js
await SesameBle.use({ deviceUUID, secretKey, model: "hub_3" }, async (dev) => {
  await dev.updateFirmware({ onProgress: (p) => console.log("ota", p) });
});
```

ファサードは OTA サーバ起動（コマンド応答）の時点で内部の進捗購読を解除します。100% 完了まで進捗を取り続けたい場合は `ble.onMoveToOtaProgress(session, cb)`（Hub3 / OS3 ロック）または `ble.onWM2OtaProgress(session, cb)`（WM2）を直接購読してください。純ロジック層（`updateFirmware` / `updateFirmwareBleOnly` / `updateFirmwareWM2`）も `sesame-kit/ble`（`ble.dfu.*`）から export されており、独自結線に利用できます。実際の DFU バイナリ転送は別 GATT サービスで外部 DFU ライブラリが行い、この層は OTA サーバの起動と進捗報告のみを担当します。

### OS2 デバイス（SESAME 2 / 3 / 4・Bot1・Bike1）

OS2 デバイスは OS3 とは**別の BLE プロトコル**を話します。login がデバイス公開鍵との ECDH で session 鍵を導出するため、`secretKey` だけでは足りません。専用ファサード `SesameOS2Ble` を使い、操作面は OS3 版と揃えてあります。

```js
import { SesameOS2Ble, ble } from "sesame-kit";
const { createBleTransport } = ble;                    // OS2 は transport の明示注入が必要

await SesameOS2Ble.use(
  {
    deviceUUID, secretKey,          // secretKey: 16 B / 32 hex
    keyIndex,                       // userIdx（sesame2KeyData.keyIndex）
    ssmPublicKey,                   // デバイス公開鍵 64 B（sesame2KeyData.sesame2PublicKey）
    model: "sesame_3",
    transport: createBleTransport({ deviceUUID }),
  },
  async (lock) => {
    await lock.unlock();            // SESAME 2/3/4 と Bike1
    await lock.lock();              // SESAME 2/3/4
    await lock.toggle();            // SESAME 2/3/4
    await lock.click();             // Bot1
    await lock.autolock(30);        // SESAME 2/3/4 — BLE 経由なら実機に反映
    console.log(await lock.getAutolock());
    console.log(await lock.versionTag());
    console.log(lock.lastStatus);   // { state, position, ... } OS2 の `moved` 状態を含む
    const history = await lock.history();   // 履歴 1 バッチ（生バイト）

    // 実機への書き込み（mechSetting, item=80）:
    await lock.configureLockPosition(0, 90);   // SESAME 2/3/4 — 施錠/解錠角（度）
    await lock.updateSetting({                 // Bot1 — mech_setting 構造体
      userPrefDir: 0, lockSec: 10, unlockSec: 10,
      clickLockSec: 2, clickHoldSec: 1, clickUnlockSec: 2, buttonMode: 0,
    });
    await lock.updateFirmware();               // BLE DFU 開始（enableDFU, item=7）— 開始コマンドのみ
  },
);
```

`keyIndex` と `ssmPublicKey` はデバイスの鍵情報（OS2 の `sesame2KeyData`）から得ます。OS2 login には `secretKey` だけでは不十分です。ゲスト鍵 / サーバ署名鍵は `needAuthFromServer: true` + `signLogin` コールバックで login できます。

OS2 の `mechSetting` 書き込みは SDK と 1:1 です。`configureLockPosition(lockDeg, unlockDeg)` は `CHSesame2Device.configureLockPosition` の移植で、度数を内部 tick（`deg*1024/360`）へ変換し ±150 の range を作って 12 バイトの設定を 22 バイトの履歴タグ付きで送ります。`updateSetting(setting, tag)` は Bot1 用に `CHSesameBotDevice.updateSetting`（7 フィールド + 予約 5 バイト 0 埋め）を移植したものです。`updateFirmware()` は OS2 の `enableDFU`（item=7）開始コマンドの移植で、**DFU 開始コマンドの送信のみ**を行います（送信後デバイスは DFU ブートローダへ遷移）。本体ファームのバイナリ転送は範囲外です。OS3 の `SesameBle#updateFirmware`（OTA サーバ起動 + 進捗フロー）とは異なり、OS2 経路は開始コマンドのみで**実機未検証**です。

### 新規ペアリング・登録（工場出荷デバイス）

工場出荷（未登録）のデバイスは BLE で直接ペアリングできます。ファサードが ECDH register ハンドシェイクを実行し、保存すべき `secretKey` を返します。`SesameBle.registerOnce()` が scan → connect → register → close を行い（OS3）、`SesameOS2Ble.registerOnce()` はその OS2 版です（OS2 サーバ登録用の `registerServer` コールバックを取ります）。

```js
import { SesameBle } from "sesame-kit";

const key = await SesameBle.registerOnce(
  { deviceUUID: "<advertise から得た uuid>", model: "sesame_5" },
  async ({ deviceUUID, secretKey, productType, serverSecret }) => {
    // 必ず保存すること。secretKey は以後ロックを操作できる唯一の資格情報。
    console.log({ deviceUUID, secretKey });
  },
);
await SesameBle.use({ deviceUUID: key.deviceUUID, secretKey: key.secretKey }, (lock) => lock.unlock());
```

返り値のフィールドと低レベルの構成要素（`register()`・`registerMode`・`needAuthFromServer` のサーバ認証 login 経路）は README の [BLE 初期ペアリング / 登録](../../README.ja.md#ble-初期ペアリング--登録上級) を参照してください。

### デバイス発見・列挙（鍵不要）

近接 SESAME を **`secretKey` なしで** 1 回のスキャンから列挙できます。以下はすべて BLE アドバタイズだけから判る情報です（SDK の `CHBleManager` の `chDeviceMap` 構築に対応）。

```js
import { SesameBle } from "sesame-kit";

// 1 回のスキャン → 型付き発見結果。secretKey 不要。
const found = await SesameBle.listNearby({ timeoutMs: 8000 });
for (const d of found) {
  console.log(d.deviceUUID, d.model, d.kind, d.isRegistered, d.rssi);
  // { deviceUUID, productType, model, kind, isRegistered, advTagB1,
  //   isConnectable, rssi, localName, address, peripheral }
}

// 発見結果から再スキャンなしで接続可能な SesameBle を構築する
// （発見済み peripheral を transport にそのまま注入する）。
const entry = found.find((d) => d.deviceUUID === myUUID);
const lock = SesameBle.fromDiscovery(entry, { secretKey });
await lock.connect();
// ... または工場出荷エントリ（isRegistered:false）を registerOnce へ渡す。
const key = SesameBle.fromDiscovery(entry, { registerMode: true });
```

`SesameBle.listNearby(opts)` は `listNearbyDevices()`（`sesame-kit/ble` からも export）の薄いファサードです。`scanSesames()`（`deviceUUID → peripheral` の Map のみ）と違い、アドバタイズから判る属性を機種付きで返します。`isRegistered: false` は `registerOnce` に渡せる工場出荷デバイスを示します。`SesameBle.fromDiscovery(entry, opts)` は entry の `peripheral` を再利用するため、`connect()` がスキャンを省略します（`connectMany` と同じ高速パス）。

### 1 回のスキャンで複数ロックに接続

```js
const { connected, unreachable, failed } = await SesameBle.connectMany([
  { name: "front",   deviceUUID, secretKey, model: "sesame_5" },
  { name: "kitchen", deviceUUID, secretKey, model: "bot_2" },
], { scanTimeoutMs: 8000 });

for (const [name, lock] of connected) await lock.unlock();   // Map<name, SesameBle>（login 済み）
console.log(unreachable);   // スキャンで見つからなかった名前（即スキップ・per-device timeout なし）
console.log(failed);        // [{ name, error }]（見つかったが login に失敗したロック）
```

`connectMany` は指定した全 `deviceUUID` に対して **1 回だけ**スキャンし、圏内のものへ **並行で** 接続（login まで）します。近接していないロックの per-device scan timeout を払いません。圏外のエントリは `unreachable` に、見つかったが login に失敗したロックは close した上で `failed` に入ります。

### 堅牢なリンク（切断 / リトライ / MTU）

既定の `NobleTransport` は公式 SDK の `CHSesameOS3.kt` のリンク堅牢性挙動を移植しています:

- **切断時の fail-fast。** transport は peripheral の `disconnect` イベントを購読し session へ伝播するため、リンク断（相手側切断 / 圏外）時に処理中リクエストを **timeout を待たず即座に fail** させます（`onConnectionStateChange` → `cmdCallBack.clear` に対応）。能動的な `close()` ではこのコールバックを抑止します（こちらから切断するため）。
- **指数バックオフ付き write リトライ。** Write-Without-Response は順序保証のため直列化し、数回（20/40/80/160/320ms）指数バックオフで再送します。全リトライ失敗後にのみリンク断とみなします（`_handleDisconnect`）。`transmit` の「リトライ→最終的に切断」と一致します。
- **MTU。** `requestMtu` は iOS/CoreBluetooth が管理します。noble に能動的な `requestMtu` API はないため、MTU は OS が自動協商し、ログ用に参照するのみです（値は実機未検証）。SDK の iOS 経路と同じ挙動で、セグメントアセンブラは特定の MTU に依存しません。

## 検証状況

register ハンドシェイク・OS2 プロトコル・生体登録・WM2 プロビジョニング・BLE OTA は、いずれも**公式 SesameSDK から 1:1 で移植し、ユニット / モック end-to-end テストで検証済み**ですが、その多くは**実機での確認はまだ行っていません**。特に:

- OS3 ロック / Bot / Bike の制御と読み出し（status・autolock・mechSetting・versionTag・history）が最も実行経路として検証されています。
- 新規ペアリング / 登録および OS2 ファサードはモックテストのみで、周辺のサーバ認証プリミティブと REST ホストは実機未検証です。

正確な注意点は README の [既知の制限](../../README.ja.md#既知の制限) を参照してください。実機での使用は自己責任で。設計（クラウド / BLE 統一能力モデル）の補足は [architecture.md](./architecture.md) を参照してください。
