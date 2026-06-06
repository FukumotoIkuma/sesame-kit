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

## デバイス型ごとの能力（公式 SesameSDK に準拠）

操作セットはデバイス型ごとに異なります。公式 SDK は能力を型ごとに非対称に定義しており、この CLI は設定の `model` からそれを再現します。サポートされない操作は拒否されます（例: Bot に対する `lock` → 「click を使う」）。

| 型（例: モデル） | BLE 操作 | mechStatus |
|---|---|---|
| Lock `sesame_5` / `_pro` / `sesame_6` / `_pro` / `_us` / `miwa` | `lock` `unlock` `toggle` `autolock` `status` | locked / unlocked + position |
| Bot `bot_2` / `bot_3` | `click` `status` | locked / unlocked (no position) |
| Bike `bike_2` / `bike_3` | `unlock` `status` | locked / unlocked (no position) |
| Touch / Face / Sensor / Remote, Hub3, WiFiModule2 | （BLE ロック操作なし） | — |
| OS2 `sesame_2` / `_4`, `ssmbot_1`, `bike_1` | BLE 未実装（鍵導出 / 暗号方式が異なる）。クラウド経由で操作 | — |

> OS3 では「locked / unlocked」は `isInLockRange` のみに基づく 2 値で、中間（動作中）の状態はありません（Sesame2 など OS2 デバイスのみが持ちます）。

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

## 対象範囲

**SesameOS3**（SESAME 5 / 5 Pro / Touch など）を対象とします。新規ペアリング（未登録デバイスの登録）はサポートせず、登録済みデバイスの操作のみを扱います。設計上の補足は [architecture.md](./architecture.md) を参照してください。
