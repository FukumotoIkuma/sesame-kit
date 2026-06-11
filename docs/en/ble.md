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

### `sesame ble` — BLE utility commands

The `ble` command group exposes keyless discovery, factory registration, and read-focused inspection commands:

```bash
sesame ble scan [--timeout <ms>]         # keyless nearby scan (listNearbyDevices; no secretKey)
sesame ble register <uuid> --model sesame_5 --save front
sesame ble os2-register <uuid> --model sesame_3
sesame ble cards <device>                # list enrolled NFC cards (Touch / Touch Pro)
sesame ble passcodes <device>            # list enrolled keypad passcodes (Touch / Touch Pro)
sesame ble fingers <device>              # list enrolled fingerprints (Touch Pro / Bike3)
sesame ble faces <device>                # list enrolled faces (Face)
sesame ble palms <device>                # list enrolled palms (Palm)
sesame ble mode <device> <type>          # get the current enroll mode (card/passcode/finger/face/palm)
sesame ble script <device> [--index <n>] # list Bot2/Bot3 script names + the current script
```

`<device>` is a config lock name or a deviceUUID; the connect-based subcommands accept `--secret <hex>` / `--model <model>` (to target a device not in your config locks) and `--timeout <ms>` (publish collection timeout, default 8000). `scan` is keyless.

Everything else on this page — biometric/access-control **enrollment** (add/delete/rename, mode-set), Bike3 fingerprint delete/rename/mode-set, Bot2 script select/write/run-by-index, WM2 / Hub3 provisioning, BLE OTA, factory `reset`, and the OS2 facade — has no dedicated CLI command, but registered operations are reachable from Node and through `sesame serve` with `ble.invoke` / `ble.os2.invoke` using the same method names. Binary JSON-RPC arguments may be sent as `{"type":"Buffer","data":[...]}` or `{"$buffer":"...","encoding":"hex"}`. Pairing/registration is also available through `sesame ble register`, `sesame ble os2-register`, `ble.register`, and `ble.os2.register`. The `sesame ble` commands, BLE RPC, and library calls share the same code paths and are unit-tested but **not yet confirmed against real hardware**.

## Capabilities by device type (follows the official SesameSDK)

The operation set differs by device type. The official SDK defines capabilities asymmetrically per type, and this CLI reproduces that from the `model` in your config. Unsupported operations are rejected (e.g. `lock` on a Bot → "use click").

| Type (example model) | BLE operations | mechStatus |
|---|---|---|
| Lock `sesame_5` / `_pro` / `sesame_6` / `_pro` / `_us` / `miwa` | `lock` `unlock` `toggle` `autolock` `status` | locked / unlocked + position |
| Bot `bot_2` / `bot_3` | `click` `status` | locked / unlocked (no position) |
| Bike `bike_2` | `unlock` `status` | locked / unlocked (no position) |
| Bike3 `bike_3` | `unlock` `status` + fingerprint enroll API (`lock.fingerPrint`, see below) | locked / unlocked (no position) |
| Touch / Touch Pro / Face / Palm `ssm_touch` / `_pro` / `sesame_face*` | (no lock op) — biometric/access-control **enroll** API instead (`lock.biometric`, see below) | — |
| Sensor / Remote | (no BLE lock operation) | — |
| Hub3 `hub_3` / `hub_3_lte` | (no lock op) — Wi-Fi provisioning / child-key / network-type API instead (`lock.hub3()`, see below) | — |
| WifiModule2 `wm_2` | (no lock op) — Wi-Fi provisioning / child-key API instead (`lock.wifi(...)`, see below) | — |
| OS2 `sesame_2` / `_3` / `_4`, `ssmbot_1` (Bot1), `bike_1` (Bike1) | `lock` `unlock` `toggle` `autolock` `status` (Bot1 = `click`, Bike1 = `unlock`) — over the **separate OS2 protocol** via `SesameOS2Ble` (see below) | locked / unlocked / **moved** + position |

> On OS3, "locked / unlocked" is a 2-state value based on `isInLockRange` only; there is no intermediate (moved) state — only OS2 devices (Sesame2/3/4) have `moved`.

## Error codes

When a device returns a non-zero result, the library throws `BleResultError` (`.resultCode` / `.resultName`). `resultName` matches the official SesameSDK `SesameResultCode` (`success` / `invalidFormat` / `notSupported` / `invalidSig` / `notFound` / `unknown` / `busy` / `invalidParam` / `invalidAction`), so you can branch on it.

This is the device-layer (SesameOS3) taxonomy and is only available over BLE; the cloud path does not surface these codes, so they do not appear in `sesame serve`'s `kind`.

## Requirements

- The BLE adapter `@abandonware/noble`. It is an `optionalDependency`, so `npm install` attempts it automatically and the install does not break on unsupported platforms (BLE is simply disabled). Install manually with `npm i @abandonware/noble`.
- **macOS requires Bluetooth permission for the terminal** (System Settings → Privacy & Security → Bluetooth). This is an OS-level permission, unavoidable with any BLE implementation.
- Be within Bluetooth range of the lock.

### Linux / Raspberry Pi

`@abandonware/noble` is a native binding (it talks to BlueZ via raw HCI sockets), so on Debian / Raspberry Pi OS it has to compile at install time and needs extra privileges at run time:

- **Build prerequisites** — install the toolchain and the udev headers before `npm i @abandonware/noble`, otherwise the native build fails:

  ```sh
  sudo apt-get install -y build-essential libudev-dev
  ```

- **Run without root** — grant the Node binary the BLE capability so scanning works as a normal user (instead of running everything with `sudo`):

  ```sh
  sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))
  ```

  Re-run this after upgrading Node, since the capability is attached to the specific binary.

- If a Bluetooth adapter is missing, or the process lacks the capability above (common on headless / permission-less setups), the BLE backend cannot initialize — see [Troubleshooting](#troubleshooting) below.

## Troubleshooting

### BLE could not initialize

If BLE cannot start, the CLI prints a friendly one-line message and exits with code `1` — a runtime failure of the execution environment, not a usage error (in `--json` mode it emits `{ "error": "…", "code": 1, "bleCode": "…" }` on stderr) instead of crashing silently. (Historically `@abandonware/noble`'s native CoreBluetooth binding called `abort()` — a process-level `SIGABRT`, exit `134` — the instant it initialized without permission or an adapter, and that cannot be caught with `try`/`catch`. The CLI now probes BLE in an isolated child process first, so the in-process backend is never touched when it would abort.)

The message tells you which case you hit:

- **macOS — no Bluetooth permission** (`bleCode: BLE_UNAUTHORIZED`). Grant the running terminal (Terminal, iTerm, VS Code, …) Bluetooth access in **System Settings → Privacy & Security → Bluetooth**, then re-run. On macOS the CLI also opens that settings pane for you.
- **Linux / Raspberry Pi / headless — no adapter or insufficient privileges** (`bleCode: BLE_UNSUPPORTED`). Make sure a real Bluetooth adapter is present and the process is allowed to use it — run with privileges or grant the capability (see [Linux / Raspberry Pi](#linux--raspberry-pi) above for `setcap cap_net_raw+eip`).
- **Bluetooth turned off** (`bleCode: BLE_POWERED_OFF`). Turn Bluetooth on and retry.
- **Bluetooth initialization timed out** (`bleCode: BLE_INIT_TIMEOUT`). The adapter was detected, but it did not become `poweredOn` before the CLI timeout; retry after the OS Bluetooth stack finishes starting, or restart Bluetooth.

## As a library

```js
import { SesameBle } from "sesame-kit";   // or: import { ble } from "sesame-kit"

await SesameBle.use({ deviceUUID, secretKey }, async (lock) => {
  await lock.unlock();
  await lock.autolock(30);
  console.log(lock.lastStatus);            // { state, isInLockRange, position, batteryRaw, ... } (batteryRaw = voltage ADC raw, not mV)
});
```

### BLE-only settings & reads (lock models)

These have no cloud equivalent — they go straight to the device over BLE.

```js
await SesameBle.use({ deviceUUID, secretKey }, async (lock) => {
  // Angle calibration: set the lock / unlock target angles (signed 16-bit encoder values).
  // After it succeeds, lock.lastMechSetting is updated locally with the new positions.
  await lock.configureLockPosition(lockTargetAngle, unlockTargetAngle);
  console.log(lock.lastMechSetting);       // { lockPosition, unlockPosition, autoLockSecond }
  console.log(lock.lastOpsSetting);        // { opsLockSecond } (once the device has published it)

  console.log(await lock.getVersionTag()); // firmware version string

  await lock.magnet();                     // magnet command (no-arg, SESAME 5 / 6 family)

  // Open Sensor auto-lock seconds (CHSesame5Device.opSensorControl, item 92, 2-byte LE).
  // After it succeeds, lock.lastOpsSetting.opsLockSecond is updated locally.
  await lock.opSensorControl(300);         // 0 = disable

  // BLE transmit power (item 206, signed 1-byte). Implemented by OS3 locks and
  // biometric/access-control devices in the SDK, so it is available on both.
  await lock.setBleTxPower(0);             // -128..127

  // Overwrite the advertised productType (item 205, raw bytes; SESAME 5 / 6 family).
  await lock.sendAdvProductType(Buffer.from([/* device-specific bytes */]));

  // On-device history: read one record, then delete it by recordId (first 4 bytes).
  const record = await lock.history();     // Buffer (empty = no records)
  if (record.length) await lock.deleteHistory(record);
});
```

The clock is also synced automatically on login: if the device time has drifted more than 3 seconds, `connect()` sends a `time(8)` command in the background (fire-and-forget, matching the official SDK).

`configureLockPosition`, `magnet`, `opSensorControl`, and `sendAdvProductType` are lock-only operations (SESAME 5 / 6 family); calling them on a Bot/Bike/biometric/Hub3 device throws, just like `autolock`. `setBleTxPower` is available on OS3 locks **and** biometric/access-control devices (it is implemented by both in the SDK), but throws on Hub3 / WM2 / OS2 devices. `reset()` factory-resets any OS3 device (lock / Bot2 / Bike2/3 / biometric / Hub3 / WM2) — it sends `Reset(104)` and, on success, drops the session (you must discard the stored `secretKey` yourself); OS2 devices use a different reset path and throw.

### Biometric / access-control enrollment (Touch / Touch Pro / Face / Palm)

Touch / Touch Pro / Face / Palm devices have no lock operation; instead they expose a BLE enrollment API for cards, fingerprints, passcodes, faces, and palms via `lock.biometric` (a `BiometricCommands` instance over the same session). The getter is gated on the device capability table — accessing it on a lock / Bot / Bike / Hub3 / unknown model throws (it does not fabricate an unsupported surface).

```js
await SesameBle.use({ deviceUUID, secretKey, model: "ssm_touch" }, async (touch) => {
  const bio = touch.biometric;

  // Subscribe to publish events the device pushes during enrollment (FIRST / NOTIFY / LAST / CHANGE / DELETE).
  const off = bio.registerDelegate({
    onCardReceiveStart: () => {},
    onCardReceive: (cardID, cardName, cardType) => console.log("card", cardID),
    onCardReceiveEnd: () => {},
  });

  await bio.cardModeSet(1);                 // enter card-registration mode; device then pushes CARD_FIRST/NOTIFY/LAST
  await bio.cardAdd(idBytes, "name");       // write a card back to the device
  await bio.cardDelete(cardID);             // delete by hex id
  await bio.cardBatchAdd(allCardBytes);     // bulk add via STP split-transfer (209B chunks, 4s between packets)

  // Same shape for fingerPrint* / passcode* / face* / palm* (ModeSet/Get, Add/Delete/Change, batchAdd).

  // Remote Nano trigger delay (item 190 set / 191 publish) and Face radar sensitivity (item 200 set / 201 publish):
  await bio.setTriggerDelay(30);             // UByte 0..255 seconds; device may push it back as onTriggerDelaySecondReceived
  await bio.setRadarSensitivity(rawPayload); // opaque radar-param Buffer sent as-is; publish arrives as onRadarReceive(payload)
  off();
});
```

`setTriggerDelay` / `setRadarSensitivity` are ported 1:1 from `CHRemoteNanoCapableImpl.setTriggerDelayTime` and `CHDeviceConnectCapableImpl.setRadarSensitivity`. The matching publishes (`REMOTE_NANO_PUB_TRIGGER_DELAYTIME` 191 → `onTriggerDelaySecondReceived({ triggerDelaySecond })`, `SSM_OS3_RADAR_PARAM_PUBLISH` 201 → `onRadarReceive(payload)`) are delivered through the same `registerDelegate`. The radar payload structure is opaque on the SDK side too, so the bytes are passed through verbatim. Both paths are unit-tested but **not yet confirmed against real hardware**.

`registerDelegate` also dispatches the non-enrollment publishes a biometric device pushes, ported 1:1 from `CHSesameBiometricDeviceImpl.onGattSesamePublish` (`CHSesameBiometricDeviceImpl.kt:159-255`):

- `mechStatus` (81) → `onMechStatus(status)`. A biometric `mechStatus` is **not** a lock status: the SDK's `CHSesameTouchProMechStatus` is a pure pass-through that holds only the raw bytes (every `position`/`target`/`isInLockRange`/… getter falls back to the `CHSesameProtocolMechStatus` defaults), so the lock 7B/3B parse does not apply. `parseBiometricMechStatus` mirrors that: it returns `{ data, position:0, target:0, isInLockRange:false, isInUnlockRange:true, isStop:null, isCritical:null, isBatteryCritical:false, batteryRaw }` where `batteryRaw` is the leading 2 B (LE) the SDK feeds to `reportBatteryData`. The same fallback is wired into `SesameBleSession`, so `session.lastStatus` is now populated for biometric devices too (previously the lock parse threw and left it unset).
- `PUB_KEY_SESAME` (102) → `onSesameKeysReceived({ keys, slotFull, emptySlotCount })`. `parsePubKeySesame` splits the payload into 23 B slots (`divideArray(23)`, trailing remainder zero-padded), skips empty slots (`it[22] == 0`), and reads each occupied slot as a SS5 key (`it[21] == 0` → id = first 16 B hex, value `[0x05, lockStatus]`) or a SS2 key (`it[21] != 0` → id = base64-decode of the 22-byte ASCII + `"=="`, value `[0x04, lockStatus]`). `slotFull` follows the SDK's `setSlotFull(!hasEmptySlot)`; the default (non-OpenSensor) rule treats any all-zero slot as free, while OpenSensor models reserve one slot (`parsePubKeySesame(payload, { isOpenSensor: true })` requires **more than one** free slot, since the delegate carries no model context).
- `SSM3_ITEM_CODE_BATTERY_VOLTAGE` (202) → `onBatteryVoltageReceived(payloadHex)`. The SDK posts this to the server; the kit hands the hex payload to the delegate and leaves the upload to the caller / `access` layer.
- `SSM3_ITEM_CODE_SESAME_UNSUPPORT` (204) → `onSupportChanged(false)` (the SDK's `ssm2KeysMap.setSupport(false)`).
- `SSM3_ITEM_CODE_BLE_TX_POWER_SETTING` (206) → `onBleTxPowerReceive(txPower)`, where `txPower` is `payload[0]` read as a **signed** byte (Kotlin `Byte`).

These read-side handlers are unit-tested but **not yet confirmed against real hardware**.

The card / passcode **bulk** add (`cardBatchAdd` / `passcodeBatchAdd`) is sent under the `StpItemCode` enum (`STP_ITEM_CODES` in `src/itemcodes.js`: cards 182/183, passcodes 184/185), which is a separate number space from `SesameItemCode` — the same isolation pattern as `WM2_ACTION_CODES`.

### Bike3 fingerprint (`lock.fingerPrint`)

SESAME Bike3 (`bike_3`) is Bike2 (`unlock` only) plus a fingerprint capability — the SDK class is `CHSesameBike3Device : CHSesameBike2Device(), CHFingerPrintCapable` (`CHSesameBike3Device.kt:20-24`). It is **not** a full biometric device, so it exposes only the fingerprint subset (no card / passcode / face / palm) through `lock.fingerPrint`. The getter is gated on the `fingerprint` capability flag — accessing it on any model other than Bike3 throws.

```js
await SesameBle.use({ deviceUUID, secretKey, model: "bike_3" }, async (bike) => {
  await bike.unlock();                        // Bike2-inherited lock op still works

  const fp = bike.fingerPrint;
  const off = fp.registerDelegate({
    onFingerPrintReceiveStart: () => {},
    onFingerPrintReceive: (id, name, type) => console.log("finger", id),
    onFingerPrintReceiveEnd: () => {},
  });
  await fp.fingerPrintModeSet(1);             // SSM_OS3_FINGERPRINT_MODE_SET (122) — enter enroll mode
  await fp.fingerPrints();                    // SSM_OS3_FINGERPRINT_GET (117) — list
  await fp.fingerPrintChange(id, hexName);    // SSM_OS3_FINGERPRINT_CHANGE (115) — rename
  await fp.fingerPrintDelete(id);             // SSM_OS3_FINGERPRINT_DELETE (116)
  const mode = await fp.fingerPrintModeGet(); // SSM_OS3_FINGERPRINT_MODE_GET (121)
  off();
});
```

The implementation reuses the same `BiometricCommands` fingerprint methods (item codes 115–122) over the shared session; the getter just narrows the surface to the five fingerprint methods plus `registerDelegate`. Unit-tested but **not yet confirmed against real hardware**.

This is the device-side / firmware write half of access-control management. The cloud DB-sync half (`postCards` / `delPasscodes` / …) lives in `sesame-kit/access`; the official biz3 design writes the device over BLE first, then syncs the server DB in the BLE ack callback (a 2-stage flow).

The two halves are wired by an explicit, minimal bridge that keeps the BLE = device / cloud = DB split intact. On the BLE side, `bio.onEnroll(onEnrolled, { card, passcode })` (or the standalone `ble.createEnrollCollector({ onEnrolled })` delegate) aggregates one enrollment session — the `*_FIRST` → `*_NOTIFY`(×N) → `*_LAST` publish window — into a single batch `{ kind, records }`. On the cloud side, `access.syncEnrolledCards(client, { deviceUUID, records })` / `access.syncEnrolledPasscodes(...)` map those records and delegate to `postCards` / `postPasscodes` (no new WS op is introduced; `access.enrolledToCardList(records)` is the pure mapper). The biometric layer never imports `access` — the caller decides whether to sync inside `onEnrolled`:

```js
const off = bio.onEnroll(async ({ kind, records }) => {
  if (kind === "card") await access.syncEnrolledCards(wsClient, { deviceUUID, records });
});
await bio.cardModeSet(1); // device taps now flow BLE → onEnroll → access.postCards
```

The `cardName` from a NOTIFY arrives as a hex string and the device publish carries no `nameUUID`, so `enrolledToCardList` mints a v4 UUID per record (same v4 requirement as `updateCardName`); pass an explicit `list` to override. This bridge is unit-tested but the `*_FIRST`/`*_LAST` ordering and the on-`*_LAST` DB write are **not yet confirmed against real hardware**.

### Wi-Fi provisioning & child keys (WifiModule2)

A `WifiModule2` (`wm_2`) has no lock operation; instead it exposes a BLE provisioning API over `lock.wifi({ companyId })` (a `WifiModule2` instance over the same session). The getter is gated on the device capability table — accessing it on any non-WM2 model throws (it does not fabricate an unsupported surface). Because WM2 lives on a **different GATT service** than SESAME locks (`fd81`), constructing `SesameBle` with `model: "wm_2"` automatically wires the WM2 GATT (`WM2_GATT`) into the default transport.

```js
await SesameBle.use({ deviceUUID, secretKey, model: "wm_2" }, async (dev) => {
  const wifi = dev.wifi({ companyId });     // companyId = API_GATEWAY_CLIENT_ID (from your config/env)

  // Normalized publish events the WM2 pushes: { kind: "scanWifiSSID" | "wifiSSID" | "wifiPassword"
  //   | "networkStatus" | "sesameKeys" | "otaProgress", ... }.
  const off = wifi.onPublish((ev) => console.log(ev));

  wifi.scanWifiSSID();                       // results arrive as { kind: "scanWifiSSID", rssi, ssid }
  await wifi.setWifiSSID("my-ap");
  await wifi.setWifiPassword("secret");
  await wifi.connectWifi();                  // uses companyId + deviceUUID to build the verification
  wifi.networkStatus();                      // status arrives as { kind: "networkStatus", isNet, isIot, ... }

  // Provision a child SESAME key into the WM2 (so it can relay that lock), or remove it.
  await wifi.insertSesames({ deviceUUID: childUUID, secretKey: childSecret, sesame2PublicKey, deviceModel });
  await wifi.removeSesame(sesameKeyTag);

  // Factory-reset the WM2 (sends RESET_WM2; on success the session is torn down, the dropKey
  // equivalent). Also exposed on the facade as dev.resetWifiModule2().
  await wifi.reset();
  off();
});
```

WM2 commands ride the `WM2ActionCode` enum (`WM2_ACTION` / `WM2_ACTION_CODES` in `src/itemcodes.js`), a separate number space from `SesameItemCode` — the same isolation pattern as the biometric `StpItemCode`. The pure data builders and publish parsers (`setWifiSSIDData`, `parseWM2Publish`, …) are also exported from `sesame-kit/ble` (`ble.wm2.*`) for custom wiring.

### Wi-Fi provisioning & network type (Hub3)

A Hub3 (`hub_3` / `hub_3_lte`) also has no lock operation; it exposes a BLE provisioning API over `lock.hub3()` (a `Hub3Commands` instance over the same session). The getter is gated on the device capability table — accessing it on any non-Hub3 model throws. Unlike WM2, **Hub3 lives on the default SESAME GATT** (`fd81`), so no special GATT wiring is needed (it inherits the OS3 stack, `CHHub3Device : CHSesameOS3`). The Wi-Fi commands ride `SesameItemCode` directly (Hub3-specific codes 131–136 in `src/itemcodes.js`), not a separate enum — that is the SDK's own layout for Hub3. The network-type code 209 is **not** part of that layout: `SesameItemCode` ends at 208 and `CHHub3Device.kt` has no handler for it. It is inferred from the biz3 web native-bridge behavior (`references_web/src/components/MobileWifiModule.js:219-235`) and lives in the separate `UNVERIFIED_ITEM_CODES` table (experimental, unverified on hardware).

```js
await SesameBle.use({ deviceUUID, secretKey, model: "hub_3" }, async (dev) => {
  const hub = dev.hub3();

  // Normalized publish events the Hub3 pushes: { kind: "scanWifiSSID" | "networkType"
  //   | "mechSetting" | "sesameKeys" | "otaProgress" | "ssidMarker", ... }.
  const off = hub.onPublish((ev) => console.log(ev));

  hub.scanWifiSSID();                        // results arrive as { kind: "scanWifiSSID", rssi, ssid }
  await hub.setWifiSSID("my-ap");            // HUB3_UPDATE_WIFI_SSID (136)
  await hub.setWifiPassword("secret");       // HUB3_ITEM_CODE_WIFI_PASSWORD (135)
  await hub.removeSesame(childUUID);         // REMOVE_SESAME (103); data = the dash-stripped UUID as raw 16 B
  hub.networkType();                         // EXPERIMENTAL (item 209 is not in the Android SDK; inferred from the biz3 web bridge)
  off();
});
```

Hub3 has no BLE lock-control ops, but it does inherit the shared OS3 paths: `connect`/`login`, `register` (`SesameBle.register()`), `reset()` (`Reset(104)`), and `updateFirmware()` (`MOVE_TO(84)`, see below) all work. The pure data builders and publish parsers (`setWifiSSIDData`, `parseHub3Publish`, `parseNetworkType`, …) are also exported from `sesame-kit/ble` (`ble.hub3.*`) for custom wiring. **Not yet confirmed against real hardware.** The whole `networkType` path (item code 209, request *and* publish, and the `[wifi 1B][lte 1B]` payload guess) has **no primary source in the Android SDK** — it is inferred from the biz3 web native bridge and may be removed if it cannot be confirmed.

### Firmware update over BLE (DFU / OTA)

`lock.updateFirmware({ onProgress })` starts a BLE OTA. The route is chosen by model (1:1 with the SDK): a WM2 sends `OPEN_OTA_SERVER` (126) (`CHWifiModule2Device.updateFirmware`), a **Hub3 only** sends `MOVE_TO` (84) (`CHHub3Device.updateFirmwareBleOnly` — this command is Hub3-specific), and an OS3 lock (and Bot2 / Bike2/3 / biometric) **sends no command at all** — it just returns the connected device handle (`CHSesameOS3.updateFirmware` is a no-op handle return; the actual firmware transfer requires a Nordic-DFU equivalent on a separate GATT service, which this kit does not implement). Progress (Hub3/WM2) arrives as a publish whose first payload byte is the progress value. Models that have no OTA route (OS2, unknown) throw instead of fabricating an unsupported op.

```js
await SesameBle.use({ deviceUUID, secretKey, model: "hub_3" }, async (dev) => {
  await dev.updateFirmware({ onProgress: (p) => console.log("ota", p) });
});
```

The facade unsubscribes its internal progress listener once the OTA server is up (the command response). To keep receiving progress all the way to 100 %, subscribe directly via `ble.onMoveToOtaProgress(session, cb)` (Hub3) or `ble.onWM2OtaProgress(session, cb)` (WM2). The pure logic layer (`updateFirmware` / `updateFirmwareBleOnly` / `updateFirmwareWM2`) is also exported from `sesame-kit/ble` (`ble.dfu.*`) for custom wiring. The actual DFU binary transfer is handled by an external DFU library on a separate GATT service; this layer only starts the OTA server and reports progress.

### OS2 devices (SESAME 2 / 3 / 4, Bot1, Bike1)

OS2 devices speak a **different BLE protocol** from OS3 — login derives the session key from an ECDH against the device's public key, so it needs more than a `secretKey`. They use a separate facade, `SesameOS2Ble`, with the same operation surface as the OS3 one:

```js
import { SesameOS2Ble, ble } from "sesame-kit";
const { createBleTransport } = ble;                    // OS2 needs an explicit transport injected

await SesameOS2Ble.use(
  {
    deviceUUID, secretKey,          // secretKey: 16 B / 32 hex
    keyIndex,                       // userIdx (sesame2KeyData.keyIndex)
    ssmPublicKey,                   // device public key, 64 B (sesame2KeyData.sesame2PublicKey)
    model: "sesame_3",
    transport: createBleTransport({ deviceUUID }),
  },
  async (lock) => {
    await lock.unlock();            // SESAME 2/3/4 and Bike1
    await lock.lock();              // SESAME 2/3/4
    await lock.toggle();            // SESAME 2/3/4
    await lock.click();             // Bot1
    await lock.autolock(30);        // SESAME 2/3/4 — takes effect on the device over BLE
    console.log(await lock.getAutolock());
    console.log(await lock.versionTag());
    console.log(lock.lastStatus);   // { state, position, ... } incl. the OS2 `moved` state
    const history = await lock.history();   // one batch of raw history bytes

    // on-device writes (mechSetting, item=80):
    await lock.configureLockPosition(0, 90);   // SESAME 2/3/4 — lock/unlock target angles (degrees)
    await lock.updateSetting({                 // Bot1 — full mech_setting struct
      userPrefDir: 0, lockSec: 10, unlockSec: 10,
      clickLockSec: 2, clickHoldSec: 1, clickUnlockSec: 2, buttonMode: 0,
    });
    await lock.updateFirmware();               // start BLE DFU (enableDFU, item=7) — start command only
  },
);
```

`keyIndex` and `ssmPublicKey` come from the device's key material (the OS2 `sesame2KeyData`); `secretKey` alone is not enough for OS2 login. Guest / server-signed keys can log in via `needAuthFromServer: true` + a `signLogin` callback.

OS2 `mechSetting` writes mirror the SDK 1:1: `configureLockPosition(lockDeg, unlockDeg)` ports `CHSesame2Device.configureLockPosition` (the degrees are converted to the device's internal tick = `deg*1024/360`, then a ±150 range is built, and the 12-byte config is sent with a 22-byte history tag), and `updateSetting(setting, tag)` ports `CHSesameBotDevice.updateSetting` for Bot1 (the 7-field struct + 5 reserved zero bytes). `updateFirmware()` ports the OS2 `enableDFU` (item=7) start command — note this **only sends the DFU-start command** (the device then enters its DFU bootloader); the actual firmware binary transfer is out of scope. Unlike the OS3 `SesameBle#updateFirmware` (which drives an OTA-server/progress flow), the OS2 path is start-command-only and **unverified against real hardware**.

### New pairing / registration (factory-reset devices)

A factory-reset (unregistered) device can be paired directly over BLE — the facade runs the ECDH register handshake and hands you the `secretKey` to save. `SesameBle.registerOnce()` does scan → connect → register → close (OS3); `SesameOS2Ble.registerOnce()` is the OS2 equivalent (it takes a `registerServer` callback for the OS2 server-register step).

```bash
sesame ble register <uuid-from-scan> --model sesame_5 --save front
sesame ble os2-register <uuid-from-scan> --model sesame_3 --json
```

The same flows are available from `sesame serve` as `ble.register` and `ble.os2.register`.

```js
import { SesameBle } from "sesame-kit";

const key = await SesameBle.registerOnce(
  { deviceUUID: "<uuid from advertise>", model: "sesame_5" },
  async ({ deviceUUID, secretKey, productType, serverSecret }) => {
    // SAVE THESE. secretKey is the only credential that can drive the lock afterward.
    console.log({ deviceUUID, secretKey });
  },
);
await SesameBle.use({ deviceUUID: key.deviceUUID, secretKey: key.secretKey }, (lock) => lock.unlock());
```

The README's [BLE pairing / registration](../../README.md#ble-pairing--registration-advanced) section documents the returned fields and the lower-level building blocks (`register()`, `registerMode`, the `needAuthFromServer` server-auth login path).

### Device discovery & enumeration (no keys)

You can enumerate nearby SESAMEs from a single scan **without any `secretKey`** — everything below comes from the BLE advertisement alone (corresponds to `CHBleManager`'s `chDeviceMap` construction in the SDK).

```js
import { SesameBle } from "sesame-kit";

// One scan → typed discovery results. No secretKey required.
const found = await SesameBle.listNearby({ timeoutMs: 8000 });
for (const d of found) {
  console.log(d.deviceUUID, d.model, d.kind, d.isRegistered, d.rssi);
  // { deviceUUID, productType, model, kind, isRegistered, advTagB1,
  //   isConnectable, rssi, localName, address, peripheral }
}

// Build a connectable SesameBle from a discovery entry WITHOUT re-scanning
// (the discovered peripheral is injected straight into the transport).
const entry = found.find((d) => d.deviceUUID === myUUID);
const lock = SesameBle.fromDiscovery(entry, { secretKey });
await lock.connect();
// ... or hand a factory-reset entry (isRegistered:false) to registerOnce.
const key = SesameBle.fromDiscovery(entry, { registerMode: true });
```

`SesameBle.listNearby(opts)` is a thin facade over `listNearbyDevices()` (also exported from `sesame-kit/ble`); unlike `scanSesames()` (which returns only a `deviceUUID → peripheral` map), it returns the model-tagged attributes derivable from the advertisement. `isRegistered: false` flags a factory-reset device you can pass to `registerOnce`. `SesameBle.fromDiscovery(entry, opts)` reuses the entry's `peripheral`, so `connect()` skips the scan (the same fast path `connectMany` uses).

### Connecting to multiple locks in one scan

```js
const { connected, unreachable, failed } = await SesameBle.connectMany([
  { name: "front",   deviceUUID, secretKey, model: "sesame_5" },
  { name: "kitchen", deviceUUID, secretKey, model: "bot_2" },
], { scanTimeoutMs: 8000 });

for (const [name, lock] of connected) await lock.unlock();   // Map<name, SesameBle>, logged in
console.log(unreachable);   // names not seen in the scan (skipped, no per-device timeout)
console.log(failed);        // [{ name, error }] for locks found but whose login failed
```

`connectMany` runs **one** scan for all the given `deviceUUID`s, then connects (and logs in) to the ones in range **in parallel** — it never pays a per-device scan timeout for locks that are not nearby. Out-of-range entries land in `unreachable`; locks that were found but failed login are closed and reported in `failed`.

### Resilient link (disconnect / retry / MTU)

The default `NobleTransport` ports the link-robustness behaviour of the official SDK's `CHSesameOS3.kt`:

- **Fast-fail on disconnect.** The transport subscribes to the peripheral's `disconnect` event and propagates it into the session, so a dropped or out-of-range link **fails the pending requests immediately** instead of hanging until their timeout (mirrors `onConnectionStateChange` → `cmdCallBack.clear`). An explicit `close()` suppresses that callback (we initiated the disconnect).
- **Write retry with backoff.** Each Write-Without-Response is serialized for ordering and retried a few times with exponential backoff (20/40/80/160/320 ms); only after all retries fail is the link treated as lost (`_handleDisconnect`), matching `transmit`'s retry-then-disconnect.
- **MTU.** `requestMtu` is iOS/CoreBluetooth-managed — noble has no active `requestMtu` API, so the MTU is auto-negotiated by the OS and only read back for logging (the value is not actively verified against hardware). This matches the SDK's iOS path; the segment assembler does not depend on a specific MTU.

## Verification status

The register handshake, OS2 protocol, biometric enrollment, WM2 provisioning, and BLE OTA are **ported 1:1 from the official SesameSDK and covered by unit / mock end-to-end tests**, but several of them are **not yet confirmed against real hardware**. In particular:

- OS3 lock/Bot/Bike control and reads (status, autolock, mechSetting, versionTag, history) are the most-exercised path.
- New pairing/registration and the OS2 facade are mock-tested only; the surrounding server-auth primitives and REST host are unverified against a real device.

See [Known limitations](../../README.md#known-limitations) in the README for the exact caveats. Use against real hardware at your own risk. For the design notes (the unified cloud/BLE capability model), see [architecture.md](./architecture.md).
