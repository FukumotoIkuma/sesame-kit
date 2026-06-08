<!-- English | [日本語](./README.ja.md) -->

# sesame-kit — SESAME smart-lock CLI & library (BLE + cloud, unofficial)

[![npm](https://img.shields.io/npm/v/sesame-kit)](https://www.npmjs.com/package/sesame-kit) [![license](https://img.shields.io/npm/l/sesame-kit)](./LICENSE) [![node](https://img.shields.io/node/v/sesame-kit)](https://nodejs.org)

**Control your SESAME smart lock from your own code — even directly over Bluetooth, offline.** `sesame-kit` drives your existing SESAME devices over **BLE (no cloud, low latency)** and over the cloud — lock/unlock, Hub3 IR, device management, history — from a CLI, a Node library, or any language via `sesame serve` (JSON-RPC). Build SESAME into your scripts, home automation, or a Raspberry Pi.

<p align="center"><img src="https://raw.githubusercontent.com/FukumotoIkuma/sesame-kit/main/assets/demo.en.gif" alt="sesame-kit demo" width="800"></p>

> 日本語版: [README.ja.md](./README.ja.md)

> **Status** — Pre-1.0 and may contain bugs. It will reach 1.0 once it has proven stable in real use. Pin a version if you depend on it.
>
> **Disclaimer** — Unofficial. Not affiliated with or endorsed by CANDY HOUSE, and using an unofficial client may fall outside their terms of service. It drives the cloud API the same way the official apps do, which may change or break without notice. Your `secretKey` and tokens grant full control of your lock and are stored unencrypted under `~/.config/sesame-kit`; keep them private. Use at your own risk.

## Features

- **BLE direct control**: operate locks over Bluetooth with no cloud — offline, low latency. Settings such as autolock only take effect on-device over BLE. Pure-JS SesameOS3 protocol (runs on a Raspberry Pi; swappable BLE adapter)
- Lock control: lock / unlock / toggle / SESAME Bot click (over BLE or cloud, auto-selected)
- Hub3 IR: emit existing remotes, learn from a physical remote, remote / key CRUD, preset DB search
- Device management: list, rename, delete, current state, state-push subscriptions
- History: lock open/close history, battery history
- Access control: NFC card / keypad passcode DB sync
- Scheduling / company & org: schedules, enterprise features (employees, roles, device groups, key sharing)
- Hub3 IoT: LED dimming, LTE relay, firmware update, Matter pairing
- Language-agnostic backend: `sesame serve` exposes every feature as JSON-RPC over stdio / UDS / HTTP / WS / gRPC
- Interactive mode and a library API

See [command reference](./docs/en/commands.md), [library usage](./docs/en/library.md), and [design notes](./docs/en/architecture.md) for details.

---

## Install

Requires Node.js 18+ (uses ESM and the `node:` protocol).

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

---

## Setup

Your devices must already be set up in the official SESAME app — this tool operates existing devices and does not pair new ones.

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

To run an action directly, the subject is the device: `sesame <device> <action>`. Use one of your device names from `sesame devices` (matched by substring; `front` below is just an example).

```bash
sesame front unlock            # unlock (substring match: sesame 玄関 unlock)
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

`sesame serve` is a long-running JSON-RPC 2.0 daemon. It logs in once, keeps the WS connection alive, runs ops repeatedly, and pushes events. Every feature is callable from any language through the same API.

```bash
sesame serve                          # Unix socket only (default. ~/.config/sesame-kit/sesame.sock)
sesame serve --stdio                  # embedded: a parent spawns it and talks over stdin/stdout
sesame serve --http 8080 --ws 8081 --grpc 50051   # over the network (token auth)
```

There are five framings, all exposing the same methods:

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
- Errors are `{error:{code, message, data:{kind}}}`. `kind` is one of six: `not_authenticated` / `connection_lost` / `timeout` / `bad_params` / `not_implemented` / `internal`.

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

### Bundled clients

Thin clients wrap the JSON-RPC so you can write `c.unlock("front")`. They are optional — the `curl` call above works without any client. Node: `import { SesameClient } from "sesame-kit/client"` after `npm install sesame-kit`. Python: a single file shipped with the package.

```js
import { SesameClient } from "sesame-kit/client";   // after: npm install sesame-kit
const c = SesameClient.unix();                       // default Unix socket
console.log(await c.unlock("front"));
console.log(await c.call("device.history", { deviceUUID: "AB12CD34...", pageSize: 10 })); // any method; deviceUUID from `sesame devices`
await c.subscribe(["lockState"], (topic, p) => console.log(topic, p)); // always await
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
- [BLE direct control](./docs/en/ble.md) — operate over Bluetooth without the cloud
- [Node library](./docs/en/library.md) — embed in a Node.js app
- [Integrate from any language](./docs/en/integration.md) — via `sesame serve` (Python / JS / HTTP / WS / gRPC)
- [Architecture](./docs/en/architecture.md) · [Migration](./docs/en/migration.md)

---

## Known limitations

- Only self-learned remotes (`learnEmit`) are supported. Command generation for preset remotes (picked from a manufacturer DB) is not ported. Use `sesame ir learn` to capture a physical remote.
- autolock cannot be set over the cloud — use `sesame <device> autolock <seconds>` over BLE (e.g. `sesame front autolock 30`).
- The only unimplemented op is Stripe billing changes. Every other biz3 op (employees / groups / roles / device groups / key sharing / access control / scheduling / IoT) is available as a command.
- The default WS stage is `/public`. `/production` is never used (if it lingers in config it is rewritten to `/public` on load).
- AWS IoT WS requires IPv4. It will not connect on IPv6-only networks.
- New pairing (registering an unregistered device) is not supported; only operating already-registered devices.

---

## Troubleshooting

- `No tokens stored` / `No config at ...`: `sesame init` → `sesame login`, or `sesame migrate`.
- `UserNotFoundException`: auto sign-up is built in. If it still appears, it is a Cognito-side edge case.
- `Cognito refresh returned no IdToken`: the refresh token was invalidated (e.g., logged out in the official app). Sign in again.
- `Invalid Refresh Token` on the first refresh (≈24h after login): your tokens predate device confirmation. `sesame login` registers the device with Cognito (`ConfirmDevice`, like the official app) so the refresh token stays valid; sign in again once to migrate.
- `triggerLock timeout`: wrong `secretKey`, Hub3 offline, or a half-open WS (recovers on auto-reconnect).
- `learn timeout`: the Hub3 entered REGISTER mode but did not receive a waveform. Move closer or try a different button.
- `apiKeyId required`: for `webapi` commands, set `apiKeyId` in config.json (issue one in the biz3 dev console).

## See also

- [SesameSDK_iOS_with_DemoApp](https://github.com/CANDY-HOUSE/SesameSDK_iOS_with_DemoApp) / [SesameSDK_Android_with_DemoApp](https://github.com/CANDY-HOUSE/SesameSDK_Android_with_DemoApp) — the official SDKs referenced
