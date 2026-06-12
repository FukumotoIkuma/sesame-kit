<!-- English | [日本語](./README.ja.md) -->

# sesame-kit — SESAME smart-lock CLI & library (BLE + cloud, unofficial)

[![CI](https://github.com/FukumotoIkuma/sesame-kit/actions/workflows/ci.yml/badge.svg)](https://github.com/FukumotoIkuma/sesame-kit/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/sesame-kit)](https://www.npmjs.com/package/sesame-kit) [![license](https://img.shields.io/npm/l/sesame-kit)](./LICENSE) [![node](https://img.shields.io/node/v/sesame-kit)](https://nodejs.org)

**Control your SESAME smart lock from your own code — even directly over Bluetooth, offline.** `sesame-kit` drives your existing SESAME devices over **BLE (no cloud, low latency)** and over the cloud — lock/unlock, Hub3 IR, device management, history — from a CLI, a Node library, or any language via `sesame serve` (JSON-RPC). Build SESAME into your scripts, home automation, or a Raspberry Pi.

<p align="center"><img src="https://raw.githubusercontent.com/FukumotoIkuma/sesame-kit/main/assets/demo.en.gif" alt="sesame-kit demo" width="800"></p>

> 日本語版: [README.ja.md](./README.ja.md)

> **Status** — Pre-1.0 and may contain bugs. It will reach 1.0 once it has proven stable in real use. Pin a version if you depend on it.
>
> **Disclaimer** — Unofficial. Not affiliated with or endorsed by CANDY HOUSE, and using an unofficial client may fall outside their terms of service. It drives the cloud API the same way the official apps do, which may change or break without notice. Your `secretKey` and tokens grant full control of your lock and are stored unencrypted under `~/.config/sesame-kit`; keep them private. Use at your own risk.

## Features

- **BLE direct control**: operate locks over Bluetooth with no cloud — offline, low latency. Settings such as autolock only take effect on-device over BLE. Pure-JS SesameOS3 **and OS2** protocols (run on a Raspberry Pi; swappable BLE adapter)
- Lock control: lock / unlock / toggle / SESAME Bot click (over BLE or cloud, auto-selected). OS2 devices (SESAME 2/3/4, Bot1, Bike1) are driven over BLE from the library via `SesameOS2Ble`
- **BLE-only on-device settings**: angle calibration (`configureLockPosition`, the lock/unlock target angles), `magnet`, autolock, Open Sensor auto-lock (`opSensorControl`), BLE TX power (`setBleTxPower`), advertised productType (`sendAdvProductType`), factory `reset` — written straight to the device, with no cloud equivalent
- **BLE-only reads**: firmware `versionTag`, on-device history read & per-record delete, last-seen `mechSetting` / `opsSetting`; clock sync on login (the device time is corrected automatically when it drifts >3 s)
- BLE advertisement parsing for every model (`parseAdvertisement`): productType, registered flag, connectable state, deviceUUID
- **BLE device discovery without keys** (`listNearbyDevices()` / `SesameBle.listNearby()`, also via `sesame ble scan`): one scan returns nearby SESAMEs as `{ deviceUUID, productType, model, kind, isRegistered, advTagB1, isConnectable, rssi, localName, address, peripheral }` — no `secretKey` needed. Pass an entry's `peripheral` to `SesameBle.fromDiscovery()` to connect without re-scanning (e.g. find a factory-reset device by `isRegistered: false` and hand it to `registerOnce`)
- **Resilient BLE link**: the default `NobleTransport` subscribes to the peripheral disconnect event and propagates it to the session, so a dropped/out-of-range link **fails pending requests fast** instead of hanging until timeout; writes are retried a few times with exponential backoff before the link is treated as lost (ports the retry-then-disconnect behaviour of `CHSesameOS3.kt` `transmit`). MTU is auto-negotiated by CoreBluetooth (noble has no active `requestMtu`, matching the SDK's iOS path)
- **BLE pairing**: register a factory-reset device over BLE (ECDH handshake + server auth) and get back its `secretKey` — OS3 (`SesameBle.registerOnce()`) and OS2 (`SesameOS2Ble.registerOnce()`)
- **Biometric / access-control enrollment over BLE**: card / fingerprint / passcode / face / palm enroll on Touch / Touch Pro / Face / Palm (`SesameBle#biometric`); `registerDelegate` also surfaces the device's non-enroll publishes — Touch Pro `mechStatus`, battery voltage, child-key slots (`PUB_KEY_SESAME`), the unsupported-slot flag, and BLE TX power. The read-only subset is wired to `sesame ble ...` (plus the generic `sesame ble invoke` / `os2-invoke` and `ota` / `reset` / `wifi` / `position`); enroll/write operations are also available from Node and from `sesame serve` via the typed `ble.biometric.*` RPC methods (e.g. `ble.biometric.cardAdd`, `ble.biometric.passcodeAdd`); `ble.invoke` remains as an escape hatch.
- **SESAME Bike3 fingerprint over BLE**: list / delete / rename fingerprints and get/set enroll mode on Bike3 (`SesameBle#fingerPrint`) — Bike3 is Bike2 (unlock) plus a fingerprint capability, so only the fingerprint subset is exposed. Reads are on the CLI; all ops are also available via the typed `ble.fingerPrint.*` RPC methods (e.g. `ble.fingerPrint.fingerPrints`, `ble.fingerPrint.fingerPrintDelete`).
- **SESAME Bot2 / Bot3 scripts over BLE**: run a script by index, select the active script, read the current script, list script names, and write a script (`SesameBle#script`) — reads, run-by-index (`sesame ble script-run`), select (`sesame ble script-select`), and write (`sesame ble script-write`) are all on the CLI; they are also available via the typed `ble.script.*` RPC methods (e.g. `ble.script.click`, `ble.script.selectScript`).
- **WifiModule2 over BLE**: Wi-Fi provisioning and child-key registration (`SesameBle#wifi`)
- **Hub3 over BLE**: Wi-Fi provisioning (SSID scan / SSID / password), child-key removal, and network type (Wi-Fi / LTE) reads (`SesameBle#hub3`)
- **Firmware update over BLE** (DFU / OTA) start commands: Hub3 (`MOVE_TO`) / WM2 (`OPEN_OTA_SERVER`); OS3 locks follow the SDK's no-command path (`SesameBle#updateFirmware`, also `sesame ble ota`). The DFU binary transfer itself (Nordic DFU) is not bundled — see [Known limitations](#known-limitations)
- Hub3 IR: emit existing remotes, learn from a physical remote, remote / key CRUD, preset DB search
- Device management: list, rename, delete, current state, state-push subscriptions
- History: lock open/close history, battery history
- Access control: NFC card / keypad passcode DB sync, plus **bulk enroll over BLE** (`access cards enroll` / `access passcodes enroll` — tap cards or type passcodes, register them all in one call; experimental)
- Scheduling / company & org: schedules, enterprise features (employees, roles, device groups, key sharing)
- Hub3 IoT: LED dimming, LTE relay, firmware update, Matter pairing
- Language-agnostic backend: `sesame serve` exposes cloud/Biz3 features and registered BLE operations as JSON-RPC over stdio / UDS / HTTP / WS / gRPC
- Interactive mode and a library API

See [command reference](./docs/en/commands.md), [library usage](./docs/en/library.md), and [design notes](./docs/en/architecture.md) for details.

---

## Install

Requires Node.js 20+ (matches CI; uses ESM and the `node:` protocol).

```bash
npm install -g sesame-kit       # global CLI: `sesame ...` (+ the `sesame serve` daemon)
npx sesame-kit --help           # or run without installing
npm install @sesame-kit/core    # as a library in your project (BLE + cloud, no CLI/serve deps)
```

This repo is an npm workspace split into two published packages:

- **`@sesame-kit/core`** — the library (BLE + cloud transport, auth, crypto, device management). Import this for in-process use (`import { SesameHub3 } from "@sesame-kit/core"`).
- **`sesame-kit`** — the `sesame` CLI, the `sesame serve` JSON-RPC daemon, and the bundled thin clients. Depends on `@sesame-kit/core`. Installing it pulls in core transitively, and `sesame-kit/client` still resolves to the bundled JS client.

From source:

```bash
git clone https://github.com/FukumotoIkuma/sesame-kit.git
cd sesame-kit && npm install   # workspace install wires @sesame-kit/core ↔ sesame-kit
```

### Dependencies & security posture

The production dependency tree is intentionally small. `npm install sesame-kit` pulls in three mandatory runtime dependencies, and also attempts to install one optional native dependency (`@abandonware/noble`, see below):

- `ws` — cloud WebSocket transport (core)
- `commander` — CLI argument parsing (core to the `sesame` bin)
- `@inquirer/prompts` — interactive CLI prompts (login / setup flows)

These three stay in `dependencies` because the CLI and the cloud transport — the primary entry points of the kit — cannot function without them. Everything heavier is opt-in:

- **AES-CMAC is implemented in-house** (`packages/core/src/aes-cmac.js`, RFC 4493, built on `node:crypto` AES-128-ECB/CBC only). The previously used `node-aes-cmac` package was unmaintained since 2014 and used the deprecated `Buffer` constructor in a security-critical spot (lock command MAC / session key derivation), so it was removed. All RFC 4493 §4 test vectors (Examples 1–4) are pinned in `tests/crypto/aes-cmac.test.js`.
- **gRPC framing** (`sesame serve --grpc`) needs `@grpc/grpc-js` + `@grpc/proto-loader`. They are **optional peerDependencies** and are imported lazily; without them every other framing (stdio / UDS / HTTP / WS) works as usual, and `--grpc` fails with a clear install hint. Enable with:

  ```bash
  npm i @grpc/grpc-js @grpc/proto-loader
  ```

- **The interactive session TUI** (`sesame session`) needs `ink` + `react` + `ink-select-input` + `ink-text-input` (also optional peerDependencies, dynamically imported). Enable with:

  ```bash
  npm i ink react ink-select-input ink-text-input
  ```

- Note for `npx sesame-kit` / global installs: npm does not auto-install optional peers, so the gRPC / session-TUI extras above must be installed alongside (e.g. `npm i -g sesame-kit @grpc/grpc-js @grpc/proto-loader`) if you want those two subcommands. All other commands work out of the box.

BLE support depends on the **optional** native package `@abandonware/noble` (listed under `optionalDependencies`). npm will attempt to build it during install; if the build fails (e.g. no Bluetooth toolchain or no `node-gyp` prerequisites) the failure is silently ignored and the rest of the kit still installs and works. The cloud / CLI / `sesame serve` paths do **not** require noble.

The native BLE toolchain pulls in `node-gyp`, which historically dragged in vulnerable transitive copies of `node-tar` and related packages. We pin five packages to patched / current-major releases with a package.json `overrides` field:

```json
"overrides": {
  "@mapbox/node-pre-gyp": "^2.0.3",
  "cacache":              "^20.0.1",
  "make-fetch-happen":   "^15.0.6",
  "node-gyp":            "^12.4.0",
  "tar":                 "^7.5.16"
}
```

`tar@^7.5.16` is the core security fix (patched archive-extraction CVEs). `node-gyp`, `cacache`, `make-fetch-happen`, and `@mapbox/node-pre-gyp` are pinned to their current major to eliminate transitive advisories they carried before. All five are API-compatible with the surfaces the optional native build uses. With these overrides, `npm audit --omit=dev` reports **0** vulnerabilities. Production (non-dev) dependencies of the core kit have no known advisories.

---

## Setup

The usual setup imports devices that are already registered in the official SESAME app. Factory-reset devices can also be paired directly over BLE with `sesame ble register` / `sesame ble os2-register` or the Node/RPC register APIs.

Authenticate with `login` and `verify`. `verify` imports your devices **together with their keys** (and companyID and Hub3 IR remotes) into `~/.config/sesame-kit/`, so `sesame <device> <action>` works afterward with no further key setup.

```bash
sesame init                 # initialize the config directory (~/.config/sesame-kit/)
sesame login your@email.com # send a verification code to your email
sesame verify               # enter the code; imports your devices (with keys)
sesame devices              # list your devices and their names (use these names below)
sesame logout               # revoke this session's token + forget this device server-side, then clear local tokens
```

Run `sesame setup` to re-import after adding devices in the official app later.
IR requires both a Hub3 and a Remote to be set up. For lock control alone, only the Lock is needed.

Migrating from a legacy setup (`.env` / `keys.json`): run `sesame migrate [srcDir]`. The legacy files do **not** need to sit in the repository root — point `srcDir` at whatever directory holds them (defaults to the current directory). Tokens are intentionally not imported; run `sesame login` afterwards.

---

## Basic usage

Run `sesame` with no arguments for the interactive menu. It lists your devices and the actions each one supports.

```bash
sesame                         # pick a device, then an action.  ↑↓ move · → confirm · ← back · q quit
```

To run an action directly, the subject is the device: `sesame <device> <action>`. Use the exact device name from `sesame devices` or `sesame locks ls` (`front` below is just an example).

```bash
sesame front unlock            # unlock
sesame front lock              # lock
sesame front status            # state (locked / unlocked, position)
sesame front autolock 30       # autolock (BLE only. 0 = off)
sesame send 停止 --remote ac   # Hub3 IR emit
```

The route (cloud / BLE) is chosen automatically (**auto**). Pin it with `--ble-only` / `--cloud-only`.
See the [CLI reference](./docs/en/commands.md) for every command (IR learning, device management, scheduling, access control, org, IoT, BLE).

> In a TTY, a command with missing arguments falls back to arrow-key prompts. With `--json` or in a non-TTY, there are no prompts and missing arguments are errors (CI-friendly).

---

## JSON output contract (calling from other languages)

With `--json`, commands behave under a contract that is safe to call from a subprocess.

- Success: exactly one pure JSON object on stdout (progress and logs go to stderr).
- Error: `{"error": "...", "code": <n>}` on stderr, with a non-zero exit code.
- With `--json` or non-interactive, no prompts; missing arguments are immediate errors.
- Exit codes: `0` = success / `1` = runtime error / `2` = usage error. BLE environment errors (`BLE_UNAUTHORIZED` / `BLE_UNSUPPORTED` / `BLE_POWERED_OFF` / `BLE_INIT_TIMEOUT`) are runtime failures of the execution environment, not usage errors → exit `1` (the `--json` envelope carries `bleCode`).

```bash
sesame front status --json        # → stdout: {...}  exit 0
sesame login --json               # → stderr: {"error":"...","code":1}  exit≠0
```

The JSON shape is command-specific. Use the contract version to check compatibility:
the daemon's `status` returns `contractVersion`, and `rpc.discover` returns `info["x-contractVersion"]`.
It is a SemVer for the machine contract; only breaking changes bump the major. Consumers can pin the major and fail fast.

---

## Language-agnostic backend (`sesame serve`)

`sesame serve` is a long-running JSON-RPC 2.0 daemon. It logs in once, keeps the WS connection alive, runs ops repeatedly, and pushes events. Cloud/Biz3 features are exposed as typed RPC methods. BLE operations are also exposed as typed methods — each facade op appears as `ble.<op>` / `ble.os2.<op>` (e.g. `ble.script.click`, `ble.biometric.cardAdd`, `ble.hub3.setWifiSSID`) — 76 typed BLE methods in total (all `experimental`). The generic `ble.invoke` / `ble.os2.invoke` string-dispatch remains as an escape hatch.

```bash
sesame serve                          # Unix socket only (default. ~/.config/sesame-kit/sesame.sock)
sesame serve --stdio                  # embedded: a parent spawns it and talks over stdin/stdout
sesame serve --http 8080 --ws 8081 --grpc 50051   # over the network (token auth)
```

There are five framings over the same RPC catalog. Event streams use the transport-native channel (`GET /events` for HTTP, `Subscribe` for gRPC):

| Framing | Use | Events | Auth |
|---|---|---|---|
| stdio | embedded (child process) | `event.*` notifications | inherits parent trust |
| Unix socket | local daemon, multiple clients | `event.*` notifications | file permission 0600 |
| HTTP | any language / browser | `GET /events` (SSE) | `Authorization: Bearer <token>` |
| WebSocket | any language / browser (full-duplex) | `event.*` notifications | token |
| gRPC | typed stub generation for many languages | `Subscribe` stream | token (metadata) |

- `rpc.discover` enumerates every method machine-readably (OpenRPC; 202 methods as of contract 1.2.0). Param names, requiredness, and types are extracted from the actual code.
- Locks: `lock.lock` / `lock.unlock` / `lock.toggle` / `lock.status`, plus `lock.setAutolock` (experimental; takes `transport: "cloud" | "ble"` — only the BLE route takes effect on the device). Namespace ops are all exposed as `<ns>.<op>` (`org.*` / `iot.*` / `access.*` / `ir.*` / `devices.*` / `config.sync*` / `ble.*` / `cloud.ping` …), including `access.registerPasscodes`, `ir.addRemoteToMatter`, and the typed BLE ops (`ble.script.*` / `ble.biometric.*` / `ble.fingerPrint.*` / `ble.remoteNano.*` / `ble.wifi.*` / `ble.hub3.*` / `ble.os2.*` and standalone ops `ble.register` / `ble.updateFirmware` / `ble.reset` / `ble.position` / `ble.history` / `ble.scan` / `ble.magnet` … — 76 typed `ble.*` methods total). The generic `ble.invoke` / `ble.os2.invoke` are escape-hatch facades for string-dispatching any BLE op.
- Events: `events.subscribe {topics:["lockState","deviceUpdate"]}` then `event.<topic>` notifications arrive.
- Errors are `{error:{code, message, data:{kind}}}`. `kind` is one of seven: `not_authenticated` / `bad_params` / `timeout` / `connection_lost` / `rejected` / `internal` / `not_implemented`.

Start `sesame serve` in one terminal, then call it over the socket from another with `sesame rpc`:

```bash
sesame rpc                                   # show rpc.discover as a human-readable table
sesame rpc lock.unlock --params '{"name":"front"}'
sesame rpc --subscribe lockState             # keep printing events (Ctrl-C to stop)
sesame rpc --paths                           # print connection info (socket / token paths) as JSON
```

Over HTTP (any language, no client): `POST /rpc` with a Bearer token. The token is printed when the daemon starts and saved to `~/.config/sesame-kit/serve.token`.

```bash
sesame serve --http 8080                          # start the HTTP listener (the default serve is socket-only)
TOKEN=$(cat ~/.config/sesame-kit/serve.token)    # the token printed at startup
curl -s -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"lock.unlock","params":{"name":"front"}}' \
  http://127.0.0.1:8080/rpc
```

`sesame rpc` can target the HTTP listener too (token read from `serve.token` automatically):

```bash
sesame rpc --http status                          # default URL http://127.0.0.1:8080
sesame rpc --http http://host:8080 lock.unlock --params '{"name":"front"}'
```

**Calling from a browser (CORS):** cross-origin browser requests are blocked by default (no `Access-Control-*` headers, secure default). Opt in per-origin with `--cors`:

```bash
sesame serve --http 8080 --cors https://app.example.com   # allow one origin (comma-separate for several)
sesame serve --http 8080 --cors '*'                       # allow any origin (dev only)
```

This adds `OPTIONS` preflight handling and `Access-Control-Allow-Origin` to `/rpc` and `/events`. The Bearer token is still required — CORS only relaxes the browser's same-origin check, it is not authentication.

### Which should I use? — `sdk/` vs `clients/`

Two client layers ship in this repo and they serve different needs:

- **`sdk/` — generated, typed, contract SDK (recommended for most users).** [`sdk/ts/sesame-client.ts`](./sdk/ts/sesame-client.ts) and [`sdk/python/sesame_client.py`](./sdk/python/sesame_client.py) are **generated** from [`schema/openrpc.json`](./schema/openrpc.json) (`npm run build:sdk`), with one typed method per RPC (`client.lock.unlock({ name })`), typed params/results, and `SesameRpcError` (`kind` / `retryable`). They track the published OpenRPC contract — a CI drift gate keeps them in lockstep — and talk to the `sesame serve` JSON-RPC daemon over HTTP (+ SSE for events). **Do not hand-edit the generated `sesame-client.ts` / `sesame_client.py`** — change the schema and regenerate.
- **`clients/` — hand-written, low-level transport clients (advanced / custom integrations).** [`packages/kit/clients/js/sesame-client.mjs`](./packages/kit/clients/js/sesame-client.mjs) and [`packages/kit/clients/python/sesame_client.py`](./packages/kit/clients/python/sesame_client.py) are the **薄い公式クライアント** ("thin official clients"): hand-written, minimal-dependency, with a generic `c.call("<method>", …)` plus a few conveniences (`c.unlock(…)`). They are **multi-transport** — the JS client speaks Unix socket / HTTP / WebSocket, the Python client speaks Unix socket / stdio / HTTP — which makes them a good fit for embedded (Python stdio child process), local-daemon, or full-duplex (JS WS) integrations. Neither covers gRPC (use stubs generated from `packages/kit/src/serve/sesame.proto` for that). They are **not generated** from the schema, so they are not statically typed against it.

In short: reach for **`sdk/`** for a typed, contract-tracked client over HTTP; reach for **`clients/`** when you need a thin, multi-transport client or a generic `call()` escape hatch. The `clients/` layer is what `sesame-kit/client` (`package.json` `exports`) points at.

### Bundled clients

Thin clients (the `clients/` layer above) wrap the JSON-RPC so you can write `c.unlock("front")`. They are optional — the `curl` call above works without any client. Node: `import { SesameClient } from "sesame-kit/client"` after `npm install sesame-kit`. Python: a single file shipped with the package.

```js
import { SesameClient } from "sesame-kit/client";   // after: npm install sesame-kit
const c = SesameClient.unix();                       // default Unix socket
try {
  console.log(await c.unlock("front"));
  console.log(await c.call("device.history", { deviceUUID: "AB12CD34...", pageSize: 10 })); // any method; deviceUUID from `sesame devices`
  await c.subscribe(["lockState"], (topic, p) => console.log(topic, p)); // always await
} finally {
  c.close();
}
```

```python
# Python — install per the integration guide, then:
from sesame_client import SesameClient
c = SesameClient.unix()                       # default Unix socket
print(c.unlock("front"))
print(c.call("device.history", deviceUUID="AB12CD34...", pageSize=10))  # any method; deviceUUID from `sesame devices`
```

See the [integration guide](./docs/en/integration.md) for the no-install HTTP path, Python install (incl. global npm installs), discovering methods/values, events, gRPC, and security.

gRPC is typed. `packages/kit/src/serve/sesame.proto` has a typed method per op.
Generate stubs from a source checkout (after `pip install grpcio-tools`): `python -m grpc_tools.protoc -I packages/kit/src/serve --python_out=. --grpc_python_out=. packages/kit/src/serve/sesame.proto`.

Auth boundary: interactive login is CLI-only and never runs in the daemon. A Unix socket can be used by any process of the same user (the same boundary as the CLI). HTTP / WS / gRPC are over TCP and require a loopback token generated at startup. POSIX only (Windows UDS is out of scope; stdio / HTTP / WS / gRPC work).

### Published API contract & generated SDK

The JSON-RPC surface is a **versioned, machine-readable contract** so you can build against it safely:

- [`schema/openrpc.json`](./schema/openrpc.json) — the published OpenRPC document (also live via `rpc.discover`). Each method/event carries `x-stability` (`stable` | `experimental`) and `x-provenance`; `apiVersion` (SemVer) is in `status` and `rpc.discover`. A CI drift gate keeps it in lockstep with the implementation.
- **Generated, typed SDKs** from that schema — [`sdk/ts/sesame-client.ts`](./sdk/ts/sesame-client.ts) (`client.lock.unlock({ name })`) and [`sdk/python/sesame_client.py`](./sdk/python/sesame_client.py) (`client.lock.unlock(name=...)`, zero deps), both with `SesameRpcError` exposing `kind` / `retryable`. Regenerate with `npm run build:sdk`.
- **Stability:** only the `stable` core — 13 methods: `lock.lock` / `lock.unlock` / `lock.toggle` / `lock.click` / `lock.status` (note: `lock.setAutolock` is **experimental**), `devices.list`, `device.history` / `device.battery`, `status`, `rpc.discover`, `account.whoami`, `events.subscribe` / `events.unsubscribe` — is covered by the API SemVer; `experimental` methods may change without notice. See [docs/api-stability.md](./docs/api-stability.md).
- **Errors** are structured: branch on `error.data.kind` (`not_authenticated` / `bad_params` / `timeout` / `connection_lost` / `rejected` / `internal` / `not_implemented`) and `error.data.retryable`, never on message text.

---

## Use from Node (in-process)

To control locks directly inside a Node app — without a separate daemon — use the library entry. It reads your CLI login from `~/.config/sesame-kit` (run `sesame login` once), then connects and closes automatically.

```js
import { SesameHub3 } from "@sesame-kit/core";

await SesameHub3.use(async (hub) => {
  await hub.unlock("front");
  await hub.send("ac", "停止");        // Hub3 IR
});
```

See the [Node library guide](./docs/en/library.md) for the direct API (by `deviceUUID` / `secretKey`), event subscriptions, and supplying tokens in code instead of the config file.

---

## BLE pairing / registration (advanced)

A factory-reset (unregistered) device can be paired directly over BLE — the facade runs the ECDH register handshake and hands you the `secretKey` to save. `SesameBle.registerOnce()` does scan → connect → register → close for you:

```js
import { SesameBle } from "@sesame-kit/core";

const key = await SesameBle.registerOnce(
  { deviceUUID: "<uuid from advertise>", model: "sesame_5" },
  async ({ deviceUUID, secretKey, productType, serverSecret }) => {
    // SAVE THESE. The secretKey is the only credential that can drive the lock later.
    // Persist e.g. into ~/.config/sesame-kit/config.json under devices{} (deviceUUID → { secretKey }).
    console.log({ deviceUUID, secretKey });
  },
);
// `key` is the same { deviceUUID, secretKey, productType, serverSecret } object.
```

Then operate the freshly-paired device with the returned `secretKey` exactly like any registered device:

```js
await SesameBle.use({ deviceUUID: key.deviceUUID, secretKey: key.secretKey }, (lock) => lock.unlock());
```

What the four returned fields are, and how to store them:

| Field | What it is | Where it goes |
|-------|------------|---------------|
| `secretKey` | 32-hex device key derived from the ECDH shared secret. **The credential** to log in / operate the lock. | Save under `devices{}` in `config.json` (or your own store). Treat as a secret. |
| `deviceUUID` | The device identifier you registered. | The key under `devices{}`. |
| `productType` | The model you passed (e.g. `sesame_5`) — echoed back. | Optional; useful for the per-model capability table. |
| `serverSecret` | The device's `initial` token as hex (`mSesameToken`). Server-side register payload. | Pass to the server register call if/when you wire one up. |

Lower-level building blocks are also available:

- `new SesameBle({ registerMode: true, deviceUUID, transport }).register()` — register against an already-scanned/injected transport. `register()` requires a factory-reset device, so it is only valid on a facade built with `registerMode: true` (no `secretKey`); calling it on a `secretKey`-bearing facade throws.
- Registered devices that need **server authentication** (guest keys, time-limited keys) can log in via the server-signed token instead of a locally-derived one: construct with `{ secretKey, deviceUUID, needAuthFromServer: true, registerTransport }` and `connect()` will call `signGuestKey` and `login` with the returned token (ports `CHHub3Device.kt:163-174` / `CHSesameOS3.kt:473-487`). `registerTransport` is a `makeRegisterTransport(...)` result.
- When CLI / RPC paths need `registerTransport`, the REST host is resolved from `--register-base-url`, RPC `registerBaseUrl`, or `config.registerBaseUrl`, defaulting to the official host `https://app.candyhouse.co/prod` (checked in at `_sesame_sdk_ref/app.properties:2-3`). Requests are authorized the same way as the official app — SigV4 with Cognito Identity Pool temporary credentials plus `x-api-key` and `appidentifyid` (`ApiClientConfigBuilder.kt:34-46`, `BaseApp.kt:95-102`, `AppIdentifyIdUtil.kt:42`) — where the Identity Pool credentials are derived from the idToken of the existing TokenStore created by `sesame login` (`packages/core/src/aws-credentials.js` + `packages/core/src/sigv4.js`). No separate login or manually supplied token is needed. Acceptance by the real API Gateway is still unverified on hardware.
- **OS2 server-auth register** (factory pairing of SESAME 2/3/4 that requires the server's `getRegisterKey` step) is wired via a callback injection that mirrors the server-auth login path. `SesameOS2BleSession.register({ registerServer })` reads `IRER`, then asks `registerServer({ ak, n, e, appPubK64, ... })` for `{ sig1, st, pubkey }` and finishes the ECDH/register-key handshake (ports `CHSesame2Device.kt:406-482`). The server's role is `CHServerAuth.getRegisterKey` (`CHServerAuth.kt:41-65`); to run it **offline from your own code** (no cloud), pass `makeLocalRegisterServer()` (in `packages/core/src/crypto.js`, re-exported from `@sesame-kit/core/ble/os2`) as `registerServer`, or set `localServerAuth: true` on the `SesameOS2Ble` facade to have it auto-wired. The default BLE-only register paths are unchanged: with neither `registerServer` nor `localServerAuth`, `register()` still throws as before. `getRegisterKey` remains an **unverified port** (see [Known limitations](#known-limitations)) — its byte-level agreement with a real SESAME 2/3/4 capture is unconfirmed.

> The register handshake and server-auth login are ported 1:1 from the SDK and covered by mock end-to-end tests, but the surrounding server-auth primitives and REST host remain **unverified against a real OS3 device** (see [Known limitations](#known-limitations)). Use against real hardware at your own risk.

---

## Config directory

Precedence: `--config-dir <path>` → `SESAME_KIT_HOME` → `$XDG_CONFIG_HOME/sesame-kit` → `~/.config/sesame-kit`.

```
~/.config/sesame-kit/
├── config.json         # devices / remotes / default / apiKeyId
├── tokens.json         # Cognito state (must be gitignored)
├── login_state.json    # transient state during sign-in
└── devices.json        # dump from the `devices` command
```

The config schema and the "store all devices in a single `devices{}`" design are in [docs/en/architecture.md](./docs/en/architecture.md).

---

## Documentation

Full docs: **[docs/en/](./docs/en/index.md)** ([日本語](./docs/ja/index.md)).

- [Quickstart](./docs/en/quickstart.md) — install, sign in, open a lock
- [CLI reference](./docs/en/commands.md) — every command
- [BLE direct control](./docs/en/ble.md) — operate over Bluetooth without the cloud (see [Requirements](./docs/en/ble.md#requirements) for Linux / Raspberry Pi setup: `libudev-dev` + `setcap`)
- [Node library](./docs/en/library.md) — embed in a Node.js app
- [Integrate from any language](./docs/en/integration.md) — via `sesame serve` (Python / JS / HTTP / WS / gRPC)
- [API stability & 1.0 surface](./docs/api-stability.md) — stable vs experimental, error model, the two-boundary contract
- [Architecture](./docs/en/architecture.md) · [Migration](./docs/en/migration.md)

---

## Known limitations

Three tiers: **verified** (confirmed against the real cloud / real devices), **not implemented by design**, and **implemented but hardware-unverified** (ported 1:1 from the official SDK / biz3 sources and covered by unit + mock end-to-end tests, but not yet confirmed against a real device or the real API Gateway).

### Verified behaviour

- Hub3 IR has two paths: self-learned remotes (`learnEmit`) and preset HXD commands. Learned buttons use `sesame ir learn` / `sesame remote`; preset commands use `sesame preset-ir` (or the `presetir.*` RPC/Node namespace) with a preset `remote.code` and `remote.type`.
- autolock cannot be set over the cloud — the cloud acks cmd=11 but the device does not change. Use BLE: `sesame <device> autolock <seconds>` (the `lock.setAutolock` RPC keeps `transport:"cloud"` as its compatibility default; pass `transport:"ble"` for the route that actually takes effect).
- The default WS stage is `/public`. `/production` is never used (if it lingers in config it is rewritten to `/public` on load).
- The **biz3 cloud WebSocket** — an API Gateway `execute-api` endpoint (`wss://82q6nuplv0.execute-api.ap-northeast-1.amazonaws.com/public`, `references_web/src/env_config.js:1-3`), not AWS IoT as this README previously said — requires IPv4 and does not connect on IPv6-only networks (empirical observation).

### Not implemented by design

- **Stripe SetupIntent confirmation.** This kit does not handle card data, so it does not implement the confirm step. A Stripe.js-capable client is **not** technically required (the earlier claim here was wrong): confirming needs only the publishable key (hardcoded in biz3 at `references_web/src/env_config.js:5-7`) plus the `client_secret` from `sesame payment client-secret`, so you can confirm via the Stripe public API (`POST /v1/payment_methods` → `POST /v1/setup_intents/{id}/confirm`) or Stripe.js, then pass the resulting `payment_method` id to `payment.changeDefaultPayment`. The kit exposes all surrounding Biz3 payment ops (`payment.*`).
- **DFU binary transfer (Nordic DFU).** `SesameBle#updateFirmware` ports the SDK's start commands only: Hub3 sends `MOVE_TO(84)` (`CHHub3Device.kt:213-226`), WM2 sends `OPEN_OTA_SERVER(126)` (`CHWifiModule2Device.kt:450-458`), and for OS3 locks the SDK sends **no command at all** (it hands the connected device to an external DFU library — `CHSesameOS3.kt:441-449`); the kit mirrors that no-op path and does not bundle a Nordic-DFU transfer implementation. (An earlier version of this README wrongly said the OS3-lock path sends `MOVE_TO`; that branch is Hub3-only.)
- Schedule **creation** ops and the Android-app-only auxiliary REST calls (feed history, SNS subscribe, friends, …) do not exist in the biz3 web reference and are out of scope.
- **OS2 mechStatus publish — automatic history drain (intentional difference).** The official SDK (`CHSesame2Device.kt:543-553`) automatically issues a `readHistoryCommand` when a mechStatus publish arrives with `retCode != 0` or `target == Short.MIN_VALUE (-32768)`, then POSTs the result to the server. kit **does not implement this automatic drain**: history is only read when your code explicitly calls `history()` (Node library / `ble.history` RPC / `sesame <device> history` CLI). This is an intentional design choice — auto-draining ties policy (logging, server sync) to the transport layer; kit keeps the session layer as a pure protocol port and leaves the decision to the caller. The practical effect is that device-side history accumulates between explicit calls; no lock functionality is affected.

### Implemented, but hardware-unverified

- **BLE pairing / registration** — OS3 (`sesame ble register` / `ble.register` / `SesameBle.registerOnce()`) and OS2 (`sesame ble os2-register` / `ble.os2.register`): the session-layer ECDH register handshake, including the length-branched `REGISTRATION` response (64 B Hub3-style / 77 B SESAME 5-style), is implemented and mock-vector-tested, but has not been confirmed against a real factory-reset device. Details in [BLE pairing / registration](#ble-pairing--registration-advanced).
- **register / biometrics REST** (`signGuestKey` / `registerSesame5` in `packages/core/src/devices.js`; `/device/v1/biometrics` in `packages/core/src/access.js`): request shaping is ported 1:1, the official default host `https://app.candyhouse.co/prod` ships with the kit (`_sesame_sdk_ref/app.properties:2-3`), and authorization matches the official app — **SigV4 with Cognito Identity Pool temporary credentials + `x-api-key` + `appidentifyid`** (`ApiClientConfigBuilder.kt:34-46`, `BaseApp.kt:95-102`; implemented in `packages/core/src/aws-credentials.js` + `packages/core/src/sigv4.js`, no AWS SDK dependency). The Identity Pool credentials are derived from the idToken stored by `sesame login`; no extra login is needed. Tests pin the request shapes and signed header set via fetch mocks, but **acceptance by the real API Gateway is unverified**.
- The OS2 server-auth primitive `getRegisterKey` (`packages/core/src/crypto.js`, wired as the optional OS2 register path via `registerServer` / `localServerAuth`) is an **unverified port**: its byte-level agreement with a real SESAME 2/3/4 capture is unconfirmed. The OS3 register flow is pure ECDH and never uses it.
- **OS2 BLE** (`SesameOS2Ble`: SESAME 2/3/4, Bot1, Bike1 — control, autolock, history, ECDH login, register, `mechSetting` writes): byte-order and protocol bugs were fixed against vectors derived from the Kotlin sources (Phase 1), but the result has not been confirmed on a real OS2 device.
- **WM2 BLE**: a dedicated, lock-incompatible session layer (profile `"wm2"`: `INITIAL=13`, raw-secret cipher keys, 16-byte login payload, WM2-specific GATT — `packages/core/src/ble/wm2.js`, per `CHWifiModule2Device.kt:279-321,521-528`) is implemented; hardware-unverified.
- **Hub3 networkType (item 209)** does **not** exist in the official Android SDK — it is an inferred implementation (**UNVERIFIED**) derived from the biz3 web native bridge (`references_web/src/components/MobileWifiModule.js:219-235`), isolated in `UNVERIFIED_ITEM_CODES` and exposed only as an experimental path.
- The remaining ported BLE surfaces — biometric / access-control enrollment (`SesameBle#biometric`), Bike3 fingerprint (`#fingerPrint`), Bot2/Bot3 scripts (`#script`), WM2 / Hub3 Wi-Fi provisioning (`#wifi` / `#hub3`), and the OTA start commands above — share one code path across the library, the CLI (`sesame ble …`, including the generic `invoke` / `os2-invoke` and `ota` / `reset` / `wifi` / `position`), and the `ble.*` RPCs, and are hardware-unverified. The most-exercised real path is OS3 lock/Bot/Bike control and reads. See [docs/en/ble.md](./docs/en/ble.md).

---

## Troubleshooting

- `No tokens stored` / `No config at ...`: `sesame init` / `sesame migrate` for config, then `sesame login`.
- `UserNotFoundException`: auto sign-up is built in. If it still appears, it is a Cognito-side edge case.
- `Cognito refresh returned no IdToken`: the refresh token was invalidated (e.g., logged out in the official app). Sign in again.
- `Invalid Refresh Token` on the first refresh (≈24h after login): your tokens predate device confirmation. `sesame login` registers the device with Cognito (`ConfirmDevice`, like the official app) so the refresh token stays valid; sign in again once. `sesame migrate` intentionally does not import legacy `.tokens.json` / `.login_state.json`.
- `triggerLock timeout`: wrong `secretKey`, Hub3 offline, or a half-open WS (recovers on auto-reconnect).
- `learn timeout`: the Hub3 entered REGISTER mode but did not receive a waveform. Move closer or try a different button.
- `apiKeyId required`: for `webapi` commands, set `apiKeyId` in config.json (issue one in the biz3 dev console).
- **BLE could not initialize** (`sesame ble …` / `--ble-only`): the CLI exits with code `1` (a runtime failure of the environment, not a usage error) and a friendly message (`{ error, code, bleCode }` under `--json`) instead of crashing silently. `bleCode: BLE_UNAUTHORIZED` → grant the terminal Bluetooth access (macOS: System Settings → Privacy & Security → Bluetooth); `BLE_UNSUPPORTED` → no adapter / insufficient privileges (Linux / Raspberry Pi / headless — need a real adapter and `setcap cap_net_raw+eip`); `BLE_POWERED_OFF` → turn Bluetooth on; `BLE_INIT_TIMEOUT` → Bluetooth did not become ready in time. See [docs/en/ble.md](./docs/en/ble.md#troubleshooting).

## See also

- [SesameSDK_iOS_with_DemoApp](https://github.com/CANDY-HOUSE/SesameSDK_iOS_with_DemoApp) / [SesameSDK_Android_with_DemoApp](https://github.com/CANDY-HOUSE/SesameSDK_Android_with_DemoApp) — the official SDKs referenced
