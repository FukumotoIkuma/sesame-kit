<!-- English | [日本語](../ja/commands.md) -->

# Command Reference

> [日本語](../ja/commands.md) · [Docs index](./index.md)

> The CLI commands, grouped by area. Each subcommand also accepts `sesame <cmd> --help` for its full options.
> When calling from another language via `sesame serve`, `sesame rpc` (or `rpc.discover`) lists every method and its parameters, machine-readably.

## Auth & setup

Sign-in, config bootstrap, and meta commands:

```bash
sesame login <email>           # start passwordless sign-in (a code is emailed)
sesame verify [code]           # complete sign-in (interactive input if omitted); imports devices with keys
sesame refresh                 # force a Cognito token refresh
sesame logout                  # revoke this session's token + ForgetDevice server-side, then clear local tokens
sesame whoami                  # logged-in user info (biz3GetLoginUser); saves companyID to config

sesame init                    # create the config directory and a config.json skeleton
sesame setup                   # re-run the post-auth auto-import (companyID / locks / Hub3 IR)
sesame migrate [srcDir]        # import a legacy .env / keys.json (tokens are NOT imported — run `sesame login`)
sesame config                  # show settings (redacted)
sesame bootstrap               # restore a full app-login token backup from JSON on stdin
sesame meta                    # show the Cognito config (region / userPoolId / clientId)
sesame ping                    # check the cloud WS connection
```

> `sesame migrate [srcDir]`: the legacy files do **not** have to sit in the repository root — point `srcDir` at the directory that holds them (default: the current directory).
>
> `sesame logout` is a deliberate **hardening over the official apps** (which only sign out locally): it additionally calls Cognito `ForgetDevice` and `RevokeToken`, scoped to this session/device only (no `GlobalSignOut`).

---

## Device operations (device as the subject)

The subject is the **device**. `sesame <device> <action>` mirrors the SDK's `device.action()` ordering.
`device` is the exact name shown by `sesame devices` or `sesame locks ls`. Omit `action` for that device's interactive menu; omit `device` too for the interactive menu over all devices (= `session`).

```bash
sesame front unlock            # front.unlock()
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
sesame locks add --name s3 --uuid <UUID> --secret <32hex> --model sesame_3 --ssm-public-key <128hex> --key-index 0000  # OS2: store the device public key from `ble os2-register` so `ble os2-invoke` resolves it from config
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
sesame ir remote-add --json <file|->     # add a remote object on the server (accepts an `ir search` / `ir match` result as-is)
sesame ir remote-rm ac                   # delete from server
sesame ir remote-rename "リビング" ac      # change the server alias

# Preset DB
sesame ir search ac ダイキン           # manufacturer DB search (max 1000)
sesame ir match ac <hex波形>           # match a learned waveform against known remotes

# Matter bridge (experimental, untested on real hardware)
sesame ir remote-add-matter              # register an IR remote as a Matter on/off device on Hub3 (RPC: ir.addRemoteToMatter)
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
sesame device add '<items JSON>'         # add devices to the company (QR-derived key object or array)
sesame device reorder <uuid1> <uuid2> …  # reorder devices (listed UUIDs first, the rest keep their order)
sesame device notify [<uuid> --on|--off] # push-notification settings (list, or switch one device)
sesame device recharge <uuid> --on|--off # switch rechargeable-battery mode

sesame history <uuid>                    # lock open/close history
sesame history                           # interactive selection (or `--json` requires a UUID)
sesame history <uuid> --delete <ts>      # hide (soft-delete) one open/close record by its timestamp
sesame history <uuid> --last-key <ts>    # paging cursor: timestamp of the last record of the previous page
sesame history <uuid> --all              # fetch all pages automatically (continues while a page is full)
sesame battery <uuid>                    # battery history (light/heavy voltage + percentage)
sesame battery <uuid> --delete <ts>      # hide (soft-delete) one battery record by its ts (seconds)
sesame battery <uuid> --last-key '<json>'  # paging cursor: the lastEvaluatedKey JSON from the previous page
sesame firmware                          # list firmware currently being distributed
```

> `--delete` hides a single record instead of listing: pass the `timestamp` of the open/close entry (`history`) or the `ts` in seconds of the battery entry (`battery`).
> RPC counterparts: `devices.add` / `devices.reorder` / `devices.notifyStatus` / `devices.notifyManage` / `devices.switchRecharge`, and `device.history` / `device.battery` take the same paging params.

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
sesame access cards enroll --device <uuid>                      # [experimental] read IC cards over BLE (tap), bulk-register all
sesame access cards clear --device <uuid>                       # delete all cards on the given device
sesame access cards rm --json '[{"deviceID":"...","cardID":"..."}]'   # delete individually (no response)
sesame access cards owner <cardID> [ownerSubUUID]               # assign an owner ('' to clear)
sesame access passcodes ls --device <uuid>                      # list passcodes
sesame access passcodes enroll --device <uuid>                  # [experimental] read passcodes over BLE (type on the keypad), bulk-register all
```

> `rm` (delCards/delPasscodes) is **fire-and-forget**, like biz3: the reference registers no callback and ignores any response (`useManageAuthData.js:265-267`), so no completion is reported.

> `enroll` (**experimental, hardware-unverified**) connects to the device over BLE, enters register mode, collects **every** card you tap / passcode you type (the notify stream carries multiple records), then bulk-registers them to the cloud DB in one call (`registerCards` → `postCards` for cards, `registerPasscodes` → `postPasscodes` for passcodes). Interactive: enroll, press Enter when done; non-interactive: `--timeout <sec>` (default 20). Phones read several entries per session — this brings the same to the CLI instead of one-at-a-time.

---

## Company / org management (biz3 enterprise)

Enterprise features for handling multiple companies, employees, roles, and device groups. `companyID` is filled in automatically from your login.

```bash
# Company
sesame company ls                  # list the companies you belong to
sesame company rename "新社名"      # rename the preferred company
sesame company add "新会社"         # register a new company
sesame company payment             # get billing settings

# Payment / Stripe-side Biz3 ops
sesame payment methods             # list payment methods
sesame payment client-secret       # SetupIntent client secret (confirm with the Stripe public API or Stripe.js — this kit does not handle card data; pass the resulting payment_method to `payment default`)
sesame payment default <pm_id> --yes
sesame payment remove <payment_id> --yes
sesame payment level <encoded_level> --upgrade --yes
sesame payment dev-api [--update --yes]

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
sesame iot raw --topic <topic> --payload <hex> --cmd <n>   # [experimental] raw iot cmd escape hatch (RPC: iot.sendIotCmd / iot.sendIotCmdAwait)
```

> `relay` is fire-and-forget: the Hub3 sends no acknowledgement, so a successful send is not a confirmed switch. The confirmed biz3 operation is `toggle` (`on` is kept as a compatibility alias for the same toggle op); there is no separate `off` command.

---

## Preset IR remotes (HXD command)

Emit air conditioners and the like **from preset DB commands** rather than by "learning". Specify the Hub3 as `--device`:

```bash
sesame preset-ir air --device <hub3uuid> --code <n> --power --temp 26 --mode 1 --fan 2
sesame preset-ir air --remote ac --power --temp 26       # resolve device/code/irType/state from a synced config remote
sesame preset-ir button --device <hub3uuid> --code <n> --button power --irtype 8192
sesame preset-ir send --device <hub3uuid> --command <hex> --irtype 49152   # emit raw hex
```

`air` and `button` generate the 16-byte HXD command locally (ported from biz3's `HXDCommandProcessor`) and emit it through the same `remoteEmit` frame as learned IR. `send` is the low-level path when you already have the HEX command. `--remote <name>` resolves `deviceId` / `code` / `irType` / saved state from a config remote (explicit flags win).

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

### `sesame ble` — direct BLE utility ops

The `ble` command group exposes keyless scan, factory registration, read-focused BLE inspection, generic facade invocation, and device maintenance ops directly. Anything without a dedicated CLI command is reachable through `sesame ble invoke` / `os2-invoke`, from Node, or from `sesame serve` via `ble.invoke` / `ble.os2.invoke`. See [ble.md](./ble.md).

```bash
sesame ble scan [--timeout <ms>]         # keyless nearby scan (no secretKey needed)
sesame ble register <uuid> [--model <model>] [--save <name>] [--register-base-url <url>]
sesame ble os2-register <uuid> [--model <model>]
sesame ble cards <device>                # list enrolled NFC cards (Touch / Touch Pro)
sesame ble passcodes <device>            # list enrolled keypad passcodes (Touch / Touch Pro)
sesame ble fingers <device>              # list enrolled fingerprints (Touch Pro / Bike3)
sesame ble faces <device>                # list enrolled faces (Face)
sesame ble palms <device>                # list enrolled palms (Palm)
sesame ble mode <device> <type>          # get the current enroll mode (type: card/passcode/finger/face/palm)
sesame ble script <device> [--index <n>] # list Bot2/Bot3 script names + the current script
sesame ble script-run <device> <index>    # run a Bot2/Bot3 script by number 0..9 over BLE (click 170+index)
sesame ble script-select <device> <index> # set the active script (SCRIPT_SELECT)
sesame ble script-write <device> <index> --json '{"name":"...","actions":[{"action":N,"time":N}]}'  # write a script (EDIT_SCRIPT)

# Generic + maintenance (RPC twins: ble.invoke / ble.os2.invoke / ble.updateFirmware / ble.reset / ble.wifi.* / ble.position)
sesame ble invoke <device> <op> [--args '<json>']      # any allowlisted OS3 facade op by dotted path (e.g. biometric.insertSesame)
sesame ble os2-invoke <device> <op> [--args '<json>']  # same for the OS2 facade (SESAME 2/3/4, Bot1, Bike1)
sesame ble ota <device>                  # start BLE firmware update (WM2: OPEN_OTA_SERVER / Hub3: MOVE_TO / OS3 locks: SDK no-op path)
sesame ble reset <device>                # factory-reset an OS3 device (destructive: invalidates its keys)
sesame ble wifi <device> scan|ssid <v>|password <v>|connect   # Wi-Fi provisioning for WM2/Hub3 (kind auto-detected from model)
sesame ble position <device> <lock> <unlock>   # configure lock/unlock angles (configureLockPosition)
```

`<device>` is a config lock name or a deviceUUID. On the connect-based subcommands (everything except `scan`), `--secret <hex>` and `--model <model>` let you target a device that is not in your config locks, and `--timeout <ms>` sets the publish collection timeout (default 8000). `scan` is keyless and needs neither. For registered OS3 devices that require server-signed login, such as guest or time-limited keys, pass `--server-auth`. The register REST API host is resolved from `--register-base-url <url>` or `config.registerBaseUrl` (default: the official `https://app.candyhouse.co/prod`), and requests are SigV4-signed with Identity Pool credentials derived from the TokenStore created by `sesame login`.

> These commands are the same BLE code paths as the library/RPC surface and are unit-tested but **not yet confirmed against real hardware**. The list/mode/script commands are read-only; enrollment and mode-set go through `ble invoke`, Node, or the BLE RPCs.

**SESAME Bot scripts (台本).** A Bot2/Bot3 stores up to 10 scripts (action patterns); running script *N* sends item code `170+N` (`RUN_SCRIPT_0`..`RUN_SCRIPT_9`). The same `170+index` is used over BLE and over the cloud (the official app falls back to cloud with the identical code). Run any script by number three ways:
> - **BLE**: `sesame ble script-run <device> <N>` (above), or in Node `ble.script.click(N)`.
> - **Cloud**: `sesame rpc lock.click --scriptIndex N` (RPC), or in Node `hub.botClickScript(name, N)` / `hub.botClickScriptDevice({deviceUUID, secretKey, scriptIndex})`. Omitting `scriptIndex` clicks the *currently selected* script (cmd 89).
>
> Note: `cmd=83` (unlock) triggering "script 1" is a firmware legacy alias and can only ever reach one script — the general path is `170+index`.

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
| Touch/Face/Sensor/Remote, Hub3, WiFiModule2 | (no BLE lock op) — biometric/enroll-mode **reads** are on the CLI via `sesame ble cards/passcodes/fingers/faces/palms/mode`; enrollment writes and Wi-Fi/Hub3 provisioning are available via Node or `ble.invoke` (`SesameBle#biometric` / `#wifi` / `#hub3`, see [ble.md](./ble.md)) | — |
| OS2 `sesame_2`/`_3`/`_4`, `ssmbot_1`, `bike_1` | BLE supported via **Node and `ble.os2.invoke`** (`SesameOS2Ble`, separate protocol); the dedicated CLI route is cloud-only for OS2 | locked/unlocked/moved + position |

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

> The **CLI** drives OS3 lock/Bot/Bike control, plus `sesame ble` scan, factory registration, biometric/script list reads, and enroll-mode get. The **library/RPC** surface additionally covers OS2 control (`SesameOS2Ble` / `ble.os2.invoke`), biometric/access-control enrollment writes, WifiModule2/Hub3 provisioning, and BLE OTA — all ported from the SesameSDK but partly unverified against real hardware. See [ble.md](./ble.md) and the README's [Known limitations](../../README.md#known-limitations).

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
