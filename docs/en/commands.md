<!-- English | [日本語](../ja/commands.md) -->

# Command Reference

> [日本語](../ja/commands.md) · [Docs index](./index.md)

> The CLI commands, grouped by area. Each subcommand also accepts `sesame <cmd> --help` for its full options.
> When calling from another language via `sesame serve`, `sesame rpc` (or `rpc.discover`) lists every method and its parameters, machine-readably.

## Device operations (device as the subject)

The subject is the **device**. `sesame <device> <action>` mirrors the SDK's `device.action()` ordering.
`device` is a name (substring match allowed). Omit `action` for that device's interactive menu; omit `device` too for the interactive menu over all devices (= `session`).

```bash
sesame front unlock            # front.unlock()  (substring match: sesame 玄関 unlock)
sesame front lock              # lock
sesame front toggle            # invert from current state
sesame front status            # status (locked / unlocked, position)
sesame front autolock 30       # autolock (BLE only. 0 = off)
sesame kitchen click           # SESAME Bot click (Bot2/Bot3)

sesame front                   # interactive menu for front
sesame                         # interactive menu for all devices (session)
```

action: `unlock` / `lock` / `toggle` / `click` / `status` / `autolock <seconds>` (**which operations apply depends on the type** — see below).

### The route (transport) defaults to auto

- The default is auto; the route is chosen automatically. Ops that the cloud can carry go over cloud, and only BLE-required ops such as `autolock` open a BLE connection (so you don't pay the BLE scan/connect cost every time).
- Pin the route with `--ble-only` / `--cloud-only`. `--ble-only` takes a few seconds to connect. `--cloud-only` restricts some operations.
- To hold a BLE connection open across a run of operations, use `sesame session` (the multi-device form of `sesame <device>`).

```bash
sesame front unlock            # auto (the tool picks the route)
sesame front autolock 30       # BLE-required op → connects over BLE automatically
sesame front lock --ble-only   # pinned to BLE (a few seconds to connect)
sesame front lock --cloud-only # pinned to cloud
```

> For the design details (the unified cloud/BLE capability model), see [architecture.md](./architecture.md).

Manage lock definitions with the `locks` group:

```bash
sesame locks ls                # list registered locks
sesame locks set-default front
sesame locks add               # add interactively (deviceUUID + secretKey)
sesame locks add --name front --uuid <UUID> --secret <32hex> --model sesame_5_pro  # non-interactive / flag-based add
sesame locks add --from-url 'ssm://UI?t=sk&sk=...'  # fill deviceUUID/secretKey/model/name from a share-key URL
sesame locks sync-from-devices # auto-import from the result of devices
sesame locks rm front
```

`--from-url` parses a share-key URL (the inverse of `sesame org keys share-url`) and fills in `deviceUUID` / `secretKey` / `model` / `name`. Any explicit flag (`--uuid` / `--secret` / `--model` / `--name`) overrides the value taken from the URL.

A cloud operation returns only after the synchronous ack (`biz3TriggerLocker`, `success:true`) arrives (timeout 10s).

> autolock cannot be set over the cloud (BLE only). Use `sesame <device> autolock <seconds>` (e.g. `sesame front autolock 30`, `0` = off). Background in [architecture.md](./architecture.md).

---

## Hub3 IR

### Emit an existing key

```bash
sesame send 停止                         # emit on the default remote
sesame send 停止 --remote ac
sesame list                              # list the keys registered on a remote
```

### Advanced operations

```bash
# Learn: aim a physical remote at the Hub3 and press a button
sesame ir learn ac 強風                  # learn the "強風" key onto remote=ac
                                         # → Hub3 into REGISTER mode → capture waveform → back to CONTROL → addIRCode

# Mode control
sesame ir mode get [hub3]                # get the current mode (0=CONTROL / 1=REGISTER)
sesame ir mode set 1 [hub3]              # force a switch to REGISTER (for debugging)

# Key CRUD
sesame ir key rename ac 強風 強運転        # rename a key (server + config)
sesame ir key rm ac 試運転                # delete a key

# Remote CRUD (server side)
sesame ir remote-list ac              # registered remotes (by irType)
sesame ir remote-rm ac                   # delete from server
sesame ir remote-rename "リビング" ac      # change the server alias

# Preset DB
sesame ir search ac ダイキン           # manufacturer DB search (max 1000)
sesame ir match ac <hex波形>           # match a learned waveform against known remotes
```

> To refer to a self-learned remote, use the real type `0xFE00` (65024) for `irType`. Passing the menu id `0xFEFF` makes the server match fail and the remote is not found. See [architecture.md](./architecture.md) for details.

### Register remotes and the Hub3

`send` / `ir learn` need a remote (and its Hub3) imported into config first. The fastest path is to sync everything from the server:

```bash
sesame hub3 sync-from-devices    # import your Hub3(s)
sesame remote sync-from-devices  # import remotes (Hub3 + irType auto-detected) and their keys
sesame remote ls                 # list configured remotes
sesame remote set-default ac     # default remote used by a bare `sesame send <key>`
```

Or add one at a time: `sesame hub3 add` / `sesame remote add` both pick from a list (no UUID/irType to type). `sesame remote sync-keys [name]` re-imports a remote's key list.

---

## Device management

```bash
sesame device user-ls                    # list personal devices
sesame device status <uuid>              # current state
sesame device rename <uuid> "玄関 SESAME"  # rename
sesame device rm <uuid>                  # remove from the company

sesame history <uuid>                    # lock open/close history
sesame history                           # all devices
sesame history <uuid> --delete <ts>      # hide (soft-delete) one open/close record by its timestamp
sesame battery <uuid>                    # battery history (light/heavy voltage + percentage)
sesame battery <uuid> --delete <ts>      # hide (soft-delete) one battery record by its ts (seconds)
sesame firmware                          # list firmware currently being distributed
```

> `--delete` hides a single record instead of listing: pass the `timestamp` of the open/close entry (`history`) or the `ts` in seconds of the battery entry (`battery`).

---

## WebAPI proxy

Set the REST API key (apiKeyId) issued in the biz3 dev console as `config.apiKeyId`, and you can proxy any REST WebAPI call over the WebSocket:

```bash
# with "apiKeyId": "..." in config.json:
sesame webapi webapi_ssm_shadow_get --query '{"device_id":"..."}'
sesame webapi webapi_history_get --query '{"device_id":"...","page":0,"lg":"ja","isBiz":true}'
sesame webapi webapi_cmd_send --body '{"device_id":"...","cmd":83,"sign":"...","history":"..."}'
```

> The same proxy is also reachable over `sesame serve` as the `webapi.invoke` RPC method (params: `func`, `query?`, `body?`, `apiKeyId?`); it was previously CLI-only. Like the `device.hideHistory` / `device.hideBattery` soft-delete methods (the RPC counterparts of `history --delete` / `battery --delete`), it is tier `experimental`.

---

## Scheduling (biz3Schedule)

```bash
sesame schedule ls                 # list registered schedules (lock/unlock/upgrade_firmware)
sesame schedule cancel <id>        # cancel a schedule (omit id to pick interactively from the list)
```

> Since **biz3 web has no op to create a schedule**, the CLI offers only list / cancel.

---

## Access control (NFC cards / passcodes)

The **server-DB sync** ops for SESAME Touch (Pro) NFC cards and keypad passcodes.
Writing to the device firmware itself goes through a separate path (BLE); this layer handles only the DB-side sync — a two-layer structure.

```bash
sesame access cards ls --device <uuid> [--device <uuid2> ...]   # list cards
sesame access cards clear --device <uuid>                       # delete all cards on the given device
sesame access cards rm --json '[{"deviceID":"...","cardID":"..."}]'   # delete individually (no response)
sesame access cards owner <cardID> [ownerSubUUID]               # assign an owner ('' to clear)
sesame access passcodes ls --device <uuid>                      # list passcodes
```

> `rm` (delCards/delPasscodes) has no response handler in biz3 and is **fire-and-forget**. No completion response is returned.

---

## Company / org management (biz3 enterprise)

Enterprise features for handling multiple companies, employees, roles, and device groups. `companyID` is filled in automatically from your login.

```bash
# Company
sesame company ls                  # list the companies you belong to
sesame company rename "新社名"      # rename the preferred company
sesame company add "新会社"         # register a new company
sesame company payment             # get billing settings

# Org
sesame org employee ls             # list employees
sesame org employee search <kw>    # cross-CS user search
sesame org role ls                 # list role tags
sesame org group ls                # list employee groups
sesame org device-group ls         # list device groups
sesame org keys device <deviceUUID>   # enumerate employees holding a key for the device
```

### Guest sharing (key-sharing URL / QR)

Generates the same `ssm://UI?t=sk&sk=…&l=…&n=…` URL that the SESAME app reads as a sharing QR.
Only with `--level 2` (guest) is a single-use `guestKeyId` issued and embedded (same behavior as biz3).

```bash
sesame org keys share-url --device <uuid> --level 2 --name "来客用"   # guest sharing URL
sesame org keys share-url --device <uuid> --level 1                  # manager key sharing
sesame org keys share-url --device <uuid> --qr                       # show a QR in the terminal (requires qrcode-terminal)
```

> Building and parsing the sharing URL is a 1:1 port of biz3 `generateInviteGuestQRCodeByInfo` / `readQrcode`.
> It is **independent of any image library**, so you can paste the output URL into any QR generator to share.
> Many create/update ops take a struct via `--json '<…>'` (each subcommand's `--help` has examples).
> Note that `org employee confirm <email>` signs out the current session on success, per the biz3 spec.

---

## Hub3 IoT control (biz3OperateIoT)

Direct commands to the Hub3 itself (LED dimming, LTE relay, firmware update, Matter pairing, etc.).
Pass `--device <hub3UUID> --secret <hex>`, or select from connected devices when interactive.

```bash
sesame iot led 80 --device <uuid> --secret <hex>   # LED dimming (duty 0-255)
sesame iot led --get --device <uuid> --secret <hex># get the current dimming level
sesame iot relay on  --device <uuid> --secret <hex># LTE relay open/close
sesame iot firmware-update --device <uuid> --secret <hex> --wait 60
sesame iot matter-code --device <uuid> --secret <hex>   # Matter pairing code
```

> `relay` is fire-and-forget: the Hub3 sends no acknowledgement, so a successful send is not a confirmed switch. The `off` opcode mapping is unverified against the official source and may behave differently on real hardware.

---

## Preset IR remotes (HXD command)

Emit air conditioners and the like **from preset DB commands** rather than by "learning". Specify the Hub3 as `--device`:

```bash
sesame preset-ir air --device <hub3uuid> --code <n> --power --temp 26 --mode 1 --fan 2
sesame preset-ir button --device <hub3uuid> --code <n> --button power --irtype 8192
sesame preset-ir send --device <hub3uuid> --command <hex> --irtype 49152   # emit raw hex
```

> Preset command generation (biz3's HXDCommandProcessor) is not yet ported, so preset emit does not currently work.
> Use a self-learned remote (`sesame ir learn`) instead ([known limitations](../../README.md#known-limitations)).

---

## BLE direct control (without the cloud)

Operate registered SESAME devices **directly** over the PC's Bluetooth. Since it does not go through the cloud (WS), it works offline, and **settings such as `autolock` that the cloud could not apply do take effect on the device**.

BLE operation is not a dedicated command — just **add `--ble-only`** to a device-subject operation
(`autolock` is BLE-required, so it goes over BLE automatically even without the flag):

```bash
sesame front status --ble-only   # current state (locked / unlocked, position)
sesame front unlock --ble-only   # unlock (Lock / Bike)
sesame front lock   --ble-only   # lock (Lock)
sesame front toggle --ble-only   # invert based on current state (Lock)
sesame kitchen click --ble-only  # SESAME Bot click (Bot2/Bot3)
sesame front autolock 30         # autolock (BLE required. Actually takes effect)
sesame front autolock 0          # disable
```

### `sesame ble` — direct BLE read-only ops

The `ble` command group exposes the **read-only** subset of the BLE surface directly (keyless scan, biometric/script list reads, enroll-mode get). The rest of the BLE feature set (enrollment, provisioning, firmware, pairing, reset, the OS2 facade) remains library-only — see [ble.md](./ble.md).

```bash
sesame ble scan [--timeout <ms>]         # keyless nearby scan (no secretKey needed)
sesame ble cards <device>                # list enrolled NFC cards (Touch / Touch Pro)
sesame ble passcodes <device>            # list enrolled keypad passcodes (Touch / Touch Pro)
sesame ble fingers <device>              # list enrolled fingerprints (Touch Pro / Bike3)
sesame ble faces <device>                # list enrolled faces (Face)
sesame ble palms <device>                # list enrolled palms (Palm)
sesame ble mode <device> <type>          # get the current enroll mode (type: card/passcode/finger/face/palm)
sesame ble script <device> [--index <n>] # list Bot2/Bot3 script names + the current script
```

`<device>` is a config lock name or a deviceUUID. On the connect-based subcommands (everything except `scan`), `--secret <hex>` and `--model <model>` let you target a device that is not in your config locks, and `--timeout <ms>` sets the publish collection timeout (default 8000). `scan` is keyless and needs neither.

> These commands are the same BLE code paths as the library reads and are unit-tested but **not yet confirmed against real hardware**. They are read-only: enrollment / mode-set / script select / write / run remain library-only.

> **BLE errors are given meaning via `SesameResultCode`** — when a device returns a non-zero result, the library throws
> `BleResultError` (`.resultCode` / `.resultName`). `resultName` matches the official SesameSDK's
> `SesameResultCode` (`success`/`invalidFormat`/`notSupported`/`invalidSig`/`notFound`/`unknown`/
> `busy`/`invalidParam`/`invalidAction`), so you can branch on it programmatically.
> Note: this is the **device-layer (SesameOS3) taxonomy** and is available only over the BLE direct route
> (the cloud route does not surface this code, so it does not appear in `sesame serve`'s `kind`).

### Operations per device type (per the official SesameSDK)

The operation set differs by device type. The SDK defines capabilities asymmetrically per type, and this CLI reproduces the same asymmetry by determining the type from the `model` in `config`. Unsupported operations are rejected by the command (e.g. `lock` on a Bot → "use click").

| Type (model examples) | BLE operations | mechStatus |
|---|---|---|
| Lock `sesame_5`/`_pro`/`sesame_6`/`_pro`/`_us`/`miwa` | `lock` `unlock` `toggle` `autolock` `status` | locked/unlocked + position |
| Bot `bot_2`/`bot_3` | `click` `status` | locked/unlocked (no position) |
| Bike `bike_2`/`bike_3` | `unlock` `status` | locked/unlocked (no position) |
| Touch/Face/Sensor/Remote, Hub3, WiFiModule2 | (no BLE lock op) — biometric/enroll-mode **reads** are on the CLI via `sesame ble cards/passcodes/fingers/faces/palms/mode`; enrollment (write) and Wi-Fi provisioning stay **library-only** (`SesameBle#biometric` / `#wifi`, see [ble.md](./ble.md)) | — |
| OS2 `sesame_2`/`_3`/`_4`, `ssmbot_1`, `bike_1` | BLE supported via the **library** (`SesameOS2Ble`, separate protocol); the CLI route is cloud-only for OS2 | locked/unlocked/moved + position |

> "locked/unlocked" is only the **two values** based on the presence of `isInLockRange` in OS3. OS3 has no intermediate (moved) state
> (only OS2 devices such as Sesame2/3/4 have moved). For the BLE implementation design, see [architecture.md](./architecture.md).

Usable as a library too:

```js
import { SesameBle } from "sesame-kit";   // or: import { ble } from "sesame-kit"
await SesameBle.use({ deviceUUID, secretKey }, async (lock) => {
  await lock.unlock();
  await lock.autolock(30);
  console.log(lock.lastStatus);            // { state, batteryMv, position, ... }
});
```

> The **CLI** drives OS3 lock/Bot/Bike control, plus the read-only BLE ops under `sesame ble` (keyless scan, biometric/script list reads, enroll-mode get). The **library** additionally covers OS2 devices (`SesameOS2Ble`), new pairing/registration (`SesameBle.registerOnce()` / `SesameOS2Ble.registerOnce()`), biometric/access-control enrollment (write), WifiModule2 provisioning, and BLE OTA — all ported from the SesameSDK but partly unverified against real hardware. See [ble.md](./ble.md) and the README's [Known limitations](../../README.md#known-limitations).

---

## Interactive session

The interactive session (`sesame` / `sesame <device>` / `sesame session`) is an **app-like auto**.
It lists **every device you can operate**: Locks/Bots/Bikes (BLE + cloud) and, if you are logged in, **Hub3** (cloud: IR send / relay / LED).
It attaches BLE best-effort but **does not exit even when BLE is zero**: devices out of range or without permission are **operated over cloud** when you are logged in (devices with a BLE connection prefer BLE = lower latency + autolock available).

```text
$ sesame                      # all devices (alias: sesame session / watch)
[ble] バックグラウンドで接続中... (クラウドで操作可能)
─── SESAME セッション ── 矢印キーで選択 ───
  front   [sesame_5·BLE]:   state=locked pos=-176
  kitchen [bot_2·cloud]:    (BLE未接続)
  hub3-居間 [hub3·hub3]:    (Hub3: IR / リレー / LED)

? 操作するデバイス          ← ① pick a device
? front の操作              ← ② pick an operation (varies by type)
  ロック  : 🔓 解錠 / 🔒 施錠 / ↕ トグル / ⏱ オートロック / ℹ 状態
  Bot     : 👆 クリック / ℹ 状態
  Hub3    : 📡 IR 送信 (リモコン→キー選択) / 🔌 リレー ON/OFF / 💡 LED 調光
```

The trailing tag on each device, `·BLE` / `·cloud`, is the route. Because **`autolock` is BLE-required**, cloud devices are prompted to "move closer and retry". If only one connection exists, device selection is skipped.

**Live updates**: the screen is a live dashboard built with **Ink (React for CLI)** and **re-renders in place** as BLE state changes or background connections complete (cloud→BLE promotion is real-time too). Startup shows the menu immediately over cloud and connects BLE in the background, so you don't wait the 8-second scan. Quit with `q` / Esc.

**Prerequisites**:
- Keys reuse the existing `config.locks` (deviceUUID/secretKey imported via `sesame locks sync-from-devices`). No new registration needed.
- The BLE adapter `@abandonware/noble` is required. As an `optionalDependency`, `npm install` tries to **install it automatically**, and on unsupported environments the install itself still succeeds (only BLE is disabled). To install it manually, `npm i @abandonware/noble`.
- **macOS requires Bluetooth permission for Terminal/iTerm** (System Settings → Privacy & Security → Bluetooth).
- Be within BLE range (close proximity) of the lock.
