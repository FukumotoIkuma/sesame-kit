<!-- English | [日本語](../ja/ble.md) -->

# BLE direct control

> [日本語](../ja/ble.md) · [Docs index](./index.md)

Drive a registered SESAME directly over Bluetooth from your PC, without going through the cloud. It works offline, and **settings such as autolock — which the cloud cannot change — take effect on the device over BLE**. No sign-in is required for BLE-only operation.

## Commands

BLE control is not a separate command — add `--ble-only` to the device operation (`autolock` requires BLE, so it uses BLE even without the flag):

```bash
sesame front status --ble-only   # current state (locked / unlocked, position)
sesame front unlock --ble-only   # unlock (lock / Bike)
sesame front lock   --ble-only   # lock
sesame front toggle --ble-only   # toggle based on current state
sesame kitchen click --ble-only  # SESAME Bot click (Bot2 / Bot3)
sesame front autolock 30         # autolock (BLE required; actually takes effect)
sesame front autolock 0          # disable
```

Without `--ble-only`, the route (cloud / BLE) is chosen automatically; `--cloud-only` pins it to the cloud.

## Capabilities by device type (follows the official SesameSDK)

The operation set differs by device type. The official SDK defines capabilities asymmetrically per type, and this CLI reproduces that from the `model` in your config. Unsupported operations are rejected (e.g. `lock` on a Bot → "use click").

| Type (example model) | BLE operations | mechStatus |
|---|---|---|
| Lock `sesame_5` / `_pro` / `sesame_6` / `_pro` / `_us` / `miwa` | `lock` `unlock` `toggle` `autolock` `status` | locked / unlocked + position |
| Bot `bot_2` / `bot_3` | `click` `status` | locked / unlocked (no position) |
| Bike `bike_2` / `bike_3` | `unlock` `status` | locked / unlocked (no position) |
| Touch / Face / Sensor / Remote, Hub3, WiFiModule2 | (no BLE lock operation) | — |
| OS2 `sesame_2` / `_4`, `ssmbot_1`, `bike_1` | BLE not implemented (different key derivation / crypto). Operate via the cloud | — |

> On OS3, "locked / unlocked" is a 2-state value based on `isInLockRange` only; there is no intermediate (moved) state (only OS2 devices like Sesame2 have it).

## Error codes

When a device returns a non-zero result, the library throws `BleResultError` (`.resultCode` / `.resultName`). `resultName` matches the official SesameSDK `SesameResultCode` (`success` / `invalidFormat` / `notSupported` / `invalidSig` / `notFound` / `unknown` / `busy` / `invalidParam` / `invalidAction`), so you can branch on it.

This is the device-layer (SesameOS3) taxonomy and is only available over BLE; the cloud path does not surface these codes, so they do not appear in `sesame serve`'s `kind`.

## Requirements

- The BLE adapter `@abandonware/noble`. It is an `optionalDependency`, so `npm install` attempts it automatically and the install does not break on unsupported platforms (BLE is simply disabled). Install manually with `npm i @abandonware/noble`.
- **macOS requires Bluetooth permission for the terminal** (System Settings → Privacy & Security → Bluetooth). This is an OS-level permission, unavoidable with any BLE implementation.
- Be within Bluetooth range of the lock.

## As a library

```js
import { SesameBle } from "sesame-kit";   // or: import { ble } from "sesame-kit"

await SesameBle.use({ deviceUUID, secretKey }, async (lock) => {
  await lock.unlock();
  await lock.autolock(30);
  console.log(lock.lastStatus);            // { state, isInLockRange, position, batteryRaw, ... } (batteryRaw = voltage ADC raw, not mV)
});
```

## Scope

Targets **SesameOS3** (SESAME 5 / 5 Pro / Touch, etc.). New pairing (registering an unregistered device) is not supported; only operating already-registered devices. See the design notes in [architecture.md](./architecture.md).
