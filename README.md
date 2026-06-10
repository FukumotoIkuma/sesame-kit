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
- **Biometric / access-control enrollment over BLE**: card / fingerprint / passcode / face / palm enroll on Touch / Touch Pro / Face / Palm (`SesameBle#biometric`); `registerDelegate` also surfaces the device's non-enroll publishes — Touch Pro `mechStatus`, battery voltage, child-key slots (`PUB_KEY_SESAME`), the unsupported-slot flag, and BLE TX power. The read-only subset is wired to `sesame ble ...`; write/enroll operations are available from Node and from `sesame serve` via `ble.invoke`.
- **SESAME Bike3 fingerprint over BLE**: list / delete / rename fingerprints and get/set enroll mode on Bike3 (`SesameBle#fingerPrint`) — Bike3 is Bike2 (unlock) plus a fingerprint capability, so only the fingerprint subset is exposed. Reads are on the CLI; writes are available from Node and `ble.invoke`.
- **SESAME Bot2 / Bot3 scripts over BLE**: run a script by index, select the active script, read the current script, list script names, and write a script (`SesameBle#script`) — reads are on the CLI; select / write / run-by-index are available from Node and `ble.invoke`.
- **WifiModule2 over BLE**: Wi-Fi provisioning and child-key registration (`SesameBle#wifi`)
- **Hub3 over BLE**: Wi-Fi provisioning (SSID scan / SSID / password), child-key removal, and network type (Wi-Fi / LTE) reads (`SesameBle#hub3`)
- **Firmware update over BLE** (DFU / OTA): Hub3 / OS3 lock / WM2 (`SesameBle#updateFirmware`)
- Hub3 IR: emit existing remotes, learn from a physical remote, remote / key CRUD, preset DB search
- Device management: list, rename, delete, current state, state-push subscriptions
- History: lock open/close history, battery history
- Access control: NFC card / keypad passcode DB sync, plus **bulk IC-card enroll over BLE** (`access cards enroll` — tap several cards, register them all in one call; experimental)
- Scheduling / company & org: schedules, enterprise features (employees, roles, device groups, key sharing)
- Hub3 IoT: LED dimming, LTE relay, firmware update, Matter pairing
- Language-agnostic backend: `sesame serve` exposes cloud/Biz3 features and registered BLE operations as JSON-RPC over stdio / UDS / HTTP / WS / gRPC
- Interactive mode and a library API

See [command reference](./docs/en/commands.md), [library usage](./docs/en/library.md), and [design notes](./docs/en/architecture.md) for details.

---

## Install

Requires Node.js 20+ (matches CI; uses ESM and the `node:` protocol).

```bash
npm install -g sesame-kit     # global CLI: `sesame ...`
npx sesame-kit --help         # or run without installing
npm install sesame-kit        # or as a library in your project
```

From source:

```bash
git clone https://github.com/FukumotoIkuma/sesame-kit.git
cd sesame-kit && npm install && npm link
```

### Dependencies & security posture

BLE support depends on the **optional** native package `@abandonware/noble` (listed under `optionalDependencies`). The cloud / CLI / `sesame serve` paths do **not** require it — if it fails to build (e.g. no Bluetooth toolchain) the rest of the kit still installs and works.

The native BLE toolchain pulls in `node-gyp`, which historically dragged in vulnerable transitive copies of `node-tar`. We pin it to a patched release with a package.json `overrides` field:

```json
"overrides": { "tar": "^7.5.11" }
```

With this single override, `npm audit --omit=dev` reports **0** vulnerabilities. The patched `tar@^7.5.11` is API-compatible with the extraction surface `node-gyp` / `cacache` / `@mapbox/node-pre-gyp` use, so the optional native build is unaffected. Production (non-dev) dependencies of the core kit have no known advisories.

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
- Exit codes: `0` = success / `1` = runtime error / `2` = usage error.

```bash
sesame front status --json        # → stdout: {...}  exit 0
sesame login --json               # → stderr: {"error":"...","code":1}  exit≠0
```

The JSON shape is command-specific. Use the contract version to check compatibility:
the daemon's `status` returns `contractVersion`, and `rpc.discover` returns `info["x-contractVersion"]`.
It is a SemVer for the machine contract; only breaking changes bump the major. Consumers can pin the major and fail fast.

---

## Language-agnostic backend (`sesame serve`)

`sesame serve` is a long-running JSON-RPC 2.0 daemon. It logs in once, keeps the WS connection alive, runs ops repeatedly, and pushes events. Cloud/Biz3 features are exposed as typed RPC methods; registered BLE operations are available through `ble.invoke` / `ble.os2.invoke`.

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

- `rpc.discover` enumerates every method machine-readably (OpenRPC). Param names, requiredness, and types are extracted from the actual code.
- Locks: `lock.lock` / `lock.unlock` / `lock.toggle` / `lock.status`. Namespace ops are all exposed as `<ns>.<op>` (`org.*` / `iot.*` / `access.*` …).
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
- **`clients/` — hand-written, low-level transport clients (advanced / custom integrations).** [`clients/js/sesame-client.mjs`](./clients/js/sesame-client.mjs) and [`clients/python/sesame_client.py`](./clients/python/sesame_client.py) are the **薄い公式クライアント** ("thin official clients"): hand-written, minimal-dependency, with a generic `c.call("<method>", …)` plus a few conveniences (`c.unlock(…)`). They support **every framing** (Unix socket / stdio / HTTP / WebSocket / gRPC), not just HTTP, which makes them a good fit for embedded (stdio child process), local-daemon, or full-duplex (WS) integrations. They are **not generated** from the schema, so they are not statically typed against it.

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

gRPC is typed. `src/serve/sesame.proto` has a typed method per op.
Generate stubs from a source checkout (after `pip install grpcio-tools`): `python -m grpc_tools.protoc -I src/serve --python_out=. --grpc_python_out=. src/serve/sesame.proto`.

Auth boundary: interactive login is CLI-only and never runs in the daemon. A Unix socket can be used by any process of the same user (the same boundary as the CLI). HTTP / WS / gRPC are over TCP and require a loopback token generated at startup. POSIX only (Windows UDS is out of scope; stdio / HTTP / WS / gRPC work).

### Published API contract & generated SDK

The JSON-RPC surface is a **versioned, machine-readable contract** so you can build against it safely:

- [`schema/openrpc.json`](./schema/openrpc.json) — the published OpenRPC document (also live via `rpc.discover`). Each method/event carries `x-stability` (`stable` | `experimental`) and `x-provenance`; `apiVersion` (SemVer) is in `status` and `rpc.discover`. A CI drift gate keeps it in lockstep with the implementation.
- **Generated, typed SDKs** from that schema — [`sdk/ts/sesame-client.ts`](./sdk/ts/sesame-client.ts) (`client.lock.unlock({ name })`) and [`sdk/python/sesame_client.py`](./sdk/python/sesame_client.py) (`client.lock.unlock(name=...)`, zero deps), both with `SesameRpcError` exposing `kind` / `retryable`. Regenerate with `npm run build:sdk`.
- **Stability:** only the `stable` core (`lock.*`, `devices.list`, `device.history`/`battery`, `status`, `account.whoami`, `events.*`) is covered by the API SemVer; `experimental` methods may change without notice. See [docs/api-stability.md](./docs/api-stability.md).
- **Errors** are structured: branch on `error.data.kind` (`not_authenticated` / `bad_params` / `timeout` / `connection_lost` / `rejected` / `internal` / `not_implemented`) and `error.data.retryable`, never on message text.

---

## Use from Node (in-process)

To control locks directly inside a Node app — without a separate daemon — use the library entry. It reads your CLI login from `~/.config/sesame-kit` (run `sesame login` once), then connects and closes automatically.

```js
import { SesameHub3 } from "sesame-kit";

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
import { SesameBle } from "sesame-kit";

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
- When CLI / RPC paths need `registerTransport`, the REST host is resolved from `--register-base-url`, RPC `registerBaseUrl`, or `config.registerBaseUrl`, and the Bearer token is obtained through `getValidIdToken()` on the existing TokenStore created by `sesame login`. No separate login or manually supplied token is needed.
- **OS2 server-auth register** (factory pairing of SESAME 2/3/4 that requires the server's `getRegisterKey` step) is wired via a callback injection that mirrors the server-auth login path. `SesameOS2BleSession.register({ registerServer })` reads `IRER`, then asks `registerServer({ ak, n, e, appPubK64, ... })` for `{ sig1, st, pubkey }` and finishes the ECDH/register-key handshake (ports `CHSesame2Device.kt:406-482`). The server's role is `CHServerAuth.getRegisterKey` (`CHServerAuth.kt:41-65`); to run it **offline from your own code** (no cloud), pass `makeLocalRegisterServer()` (in `src/crypto.js`, re-exported from `sesame-kit/ble/os2`) as `registerServer`, or set `localServerAuth: true` on the `SesameOS2Ble` facade to have it auto-wired. The default BLE-only register paths are unchanged: with neither `registerServer` nor `localServerAuth`, `register()` still throws as before. `getRegisterKey` remains an **unverified port** (see [Known limitations](#known-limitations)) — its byte-level agreement with a real SESAME 2/3/4 capture is unconfirmed.

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

- Hub3 IR has two paths: self-learned remotes (`learnEmit`) and preset HXD commands. Learned buttons use `sesame ir learn` / `sesame remote`; preset commands use `sesame preset-ir` or the `presetir.*` RPC/Node namespace with a preset `remote.code` and `remote.type`.
- autolock cannot be set over the cloud — use `sesame <device> autolock <seconds>` over BLE (e.g. `sesame front autolock 30`).
- The audited Biz3 web-command groups (employees / groups / roles / device groups / key sharing / access control / scheduling / IoT / payment) have CLI/RPC entry points. Stripe card setup still requires a Stripe.js-capable client to confirm the SetupIntent; this kit exposes the surrounding Biz3 payment ops (`payment.*`) and the client secret, but it does not embed Stripe Elements in the CLI.
- The default WS stage is `/public`. `/production` is never used (if it lingers in config it is rewritten to `/public` on load).
- AWS IoT WS requires IPv4. It will not connect on IPv6-only networks.
- New pairing (registering an unregistered device) is exposed from the Node library (`SesameBle.register()` / `SesameBle.registerOnce()`, see [BLE pairing / registration](#ble-pairing--registration-advanced)), the CLI (`sesame ble register` / `sesame ble os2-register`), and `sesame serve` RPC (`ble.register` / `ble.os2.register`). It is **not** confirmed against a real OS3 device. The BLE **session-layer** register handshake is implemented and unit-tested with mock vectors (`SesameBleSession.register()` in `src/ble/session.js`: a factory-reset device — constructed without `secretKey` — transitions to `ReadyToRegister` on the `initial(14)` publish instead of logging in, then sends `REGISTRATION(1)` in plaintext, derives the shared `secretKey`/session key from the device's returned public key via ECDH, and establishes the cipher; ports `CHHub3Device.kt:176-211` / `CHSesameOS3.kt:468-492`). The `REGISTRATION` response shape is branched by length: **64 B** (Hub3 etc. — the whole payload is the device public key, `CHHub3Device.kt:197`) or **77 B** (real SESAME 5 — `mechStatus(7B)` + `mechSetting(6B)` + `devicePubKey(64B)`, parsed and cached per `CHSesame5Device.kt:200-202`; the trailing 64 B feed ECDH). The 77 B SS5 path is ported from the Kotlin but **not yet confirmed against a real SESAME 5 capture**. The facade adds `register()`, a `registerMode` constructor flag, `registerOnce()` (scan→connect→register→close), and a `needAuthFromServer` login path (`signGuestKey`→`login`, `CHSesameOS3.kt:473-487`), all covered by mock end-to-end tests. However, the surrounding server-auth primitives and REST client it would rely on remain unverified (below), and the whole flow has **not** been confirmed against a real OS3 device. The server-auth primitive (`getRegisterKey` in `src/crypto.js`) is an **unverified port** — its byte-level agreement with the official SDK has not yet been confirmed against a real-device capture or an independent golden vector. It is now **wired into the OS2 register flow** as an *optional* server-auth path: `SesameOS2BleSession.register({ registerServer })` consumes a `{ sig1, st, pubkey }` callback (mirroring the server-auth `signLogin` injection), and `makeLocalRegisterServer()` adapts `getRegisterKey` into that callback so the flow can run offline (also reachable via `SesameOS2Ble({ localServerAuth: true })`, `sesame ble os2-register`, and `ble.os2.register`). This is covered by mock end-to-end tests (`tests/ble/os2-register.test.js`), which confirm app↔device key agreement within the kit but **not** agreement with a real device. The default BLE-only register paths (OS3 `SesameBleSession.register()` and OS2 `register()` without `registerServer`/`localServerAuth`) are unchanged. Note the OS3 register flow (`CHHub3Device.kt:176-211`) is pure ECDH and does **not** use `getRegisterKey`; this wiring is OS2-only (the only flow that consumes it in the SDK, `CHSesame2Device.kt:406-482`). `getRegisterKey` additionally carries a **cross-generation note**: the cited source (`CHServerAuth.kt`, key string `"Sesame2_key_pair"`, `serverKey`) is OS2; the earlier worry about reusing it for OS3 is moot now that the wiring is OS2-only, but its internal algorithm (CMAC key string, concatenation order, `serverKey`) is still unconfirmed against any capture. The earlier "16 B each" length assumption for `e`/`ak`/`n` was an **unverified guess that the primary source contradicts**: per `CHSesame2Device.kt:424-447` + `EccKey.kt:19-25`, the real wire values are `ak` = base64 of the app's 64 B ECDH public key, `n` = the 4 B `mSesameToken`, and `e` = the variable-length `ER`; the hardcoded 16 B asserts were therefore relaxed to lower-bound (non-empty) checks (CMAC is length-agnostic).
- The register REST-API client for it (`signGuestKey` / `registerSesame5` / `makeRegisterTransport` in `src/devices.js`) ports the SDK's request shaping 1:1 (paths `/device/v1/sesame2/sign` and `/device/v1/sesame5/{device_id}`; `CHRemoveSignKeyRequest` `{deviceId(uppercased), token(hex), secretKey}`; `CHOS3RegisterReq` JSON `{t: productType, pk: serverSecret}` — see `CHAPIClient.kt:84-96`, `CHSesameOS3.kt:474-484`, `CHHub3Device.kt:183-186`). It is wired through the optional `registerTransport` / `needAuthFromServer` paths, but the REST host (`BuildConfig.ch_server`) is not present in any checked-in reference, so `baseUrl` must be injected; and the official SDK authenticates the API Gateway via an AWS credentials provider (Cognito identity pool), whereas this client reuses the kit's existing Cognito **idToken** (`getValidIdToken`) as `Authorization: Bearer`. Whether the real API Gateway accepts that is unconfirmed pending an OS3 register capture. Tests verify request shaping only (via an injected fake transport).
- The **OS2 BLE** facade (`SesameOS2Ble`: SESAME 2/3/4, Bot1, Bike1 — control, autolock, history, ECDH login, register, `mechSetting` writes [`configureLockPosition` for 2/3/4, `updateSetting` for Bot1], and `updateFirmware` [DFU start command only]), **biometric / access-control enrollment** (`SesameBle#biometric`: card / fingerprint / passcode / face / palm), **SESAME Bike3 fingerprint** (`SesameBle#fingerPrint`: list / delete / rename / mode), **SESAME Bot2 / Bot3 scripts** (`SesameBle#script`: run-by-index / select / get / list / write), **WifiModule2 provisioning** (`SesameBle#wifi`), **Hub3 provisioning** (`SesameBle#hub3`: SSID scan / set SSID / set password / remove child key / network type — ported from `CHHub3Device.kt`, Hub3-specific `SesameItemCode` 131‑136 / 209; Hub3 connects on the default SESAME GATT and has no BLE lock-control ops, but `connect`/`login`/`register`/`reset`/`updateFirmware` run on the shared OS3 path, which also makes the `updateFirmware` Hub3 branch [`MOVE_TO(84)`, `CHHub3Device.kt:213-226`] reachable), and **BLE firmware update / OTA** (`SesameBle#updateFirmware`) are all ported 1:1 from the official SesameSDK and covered by unit / mock end-to-end tests. The **read-only subset plus factory registration** is wired to the CLI as `sesame ble …` (`scan`, `register`, `os2-register`, list/mode/script reads); write/provisioning/OTA operations with no dedicated CLI command are reachable from Node and from `sesame serve` through `ble.invoke` / `ble.os2.invoke` with the same method names (for example `biometric.insertSesame`, `script.sendClickScript`, `hub3.scanWifiSSID`). Both the library and BLE RPC/CLI paths share the same code paths and are **not yet confirmed against real hardware**. The most-exercised real path is OS3 lock/Bot/Bike control and reads. See [docs/en/ble.md](./docs/en/ble.md) for usage.

---

## Troubleshooting

- `No tokens stored` / `No config at ...`: `sesame init` / `sesame migrate` for config, then `sesame login`.
- `UserNotFoundException`: auto sign-up is built in. If it still appears, it is a Cognito-side edge case.
- `Cognito refresh returned no IdToken`: the refresh token was invalidated (e.g., logged out in the official app). Sign in again.
- `Invalid Refresh Token` on the first refresh (≈24h after login): your tokens predate device confirmation. `sesame login` registers the device with Cognito (`ConfirmDevice`, like the official app) so the refresh token stays valid; sign in again once. `sesame migrate` intentionally does not import legacy `.tokens.json` / `.login_state.json`.
- `triggerLock timeout`: wrong `secretKey`, Hub3 offline, or a half-open WS (recovers on auto-reconnect).
- `learn timeout`: the Hub3 entered REGISTER mode but did not receive a waveform. Move closer or try a different button.
- `apiKeyId required`: for `webapi` commands, set `apiKeyId` in config.json (issue one in the biz3 dev console).
- **BLE could not initialize** (`sesame ble …` / `--ble-only`): the CLI exits with code `2` and a friendly message (`{ error, code, bleCode }` under `--json`) instead of crashing silently. `bleCode: BLE_UNAUTHORIZED` → grant the terminal Bluetooth access (macOS: System Settings → Privacy & Security → Bluetooth); `BLE_UNSUPPORTED` → no adapter / insufficient privileges (Linux / Raspberry Pi / headless — need a real adapter and `setcap cap_net_raw+eip`); `BLE_POWERED_OFF` → turn Bluetooth on; `BLE_INIT_TIMEOUT` → Bluetooth did not become ready in time. See [docs/en/ble.md](./docs/en/ble.md#troubleshooting).

## See also

- [SesameSDK_iOS_with_DemoApp](https://github.com/CANDY-HOUSE/SesameSDK_iOS_with_DemoApp) / [SesameSDK_Android_with_DemoApp](https://github.com/CANDY-HOUSE/SesameSDK_Android_with_DemoApp) — the official SDKs referenced
