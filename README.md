<!-- English | [日本語](./README.ja.md) -->

# sesame-kit — SESAME cloud CLI & library (unofficial)

A Node.js CLI and library that drives the SESAME cloud WebSocket API using the same Cognito consumer client as the official SESAME iOS / Android apps. It covers lock control, Hub3 IR (emit and learn), device management, history, and battery level. With `sesame serve` it exposes every feature as JSON-RPC so you can drive SESAME from any language.

> 日本語版: [README.ja.md](./README.ja.md)

> **Status** — Pre-1.0 and may contain bugs. It will reach 1.0 once it has proven stable in real use. Pin a version if you depend on it.
>
> **Disclaimer** — Unofficial. Not affiliated with or endorsed by CANDY HOUSE. It drives the cloud API the same way the official apps do, which may change or break without notice. Your `secretKey` and tokens grant full control of your lock; keep them private. Use at your own risk.

## Features

- Lock control: lock / unlock / toggle / SESAME Bot click
- Hub3 IR: emit existing remotes, learn from a physical remote, remote / key CRUD, preset DB search
- Device management: list, rename, delete, current state, state-push subscriptions
- History: lock open/close history, battery history
- Access control: NFC card / keypad passcode DB sync
- Scheduling / company & org: schedules, enterprise features (employees, roles, device groups, key sharing)
- Hub3 IoT: LED dimming, LTE relay, firmware update, Matter pairing
- BLE direct control: operate locks over Bluetooth without the cloud. Settings such as autolock only take effect over BLE
- Language-agnostic backend: `sesame serve` exposes every feature as JSON-RPC over stdio / UDS / HTTP / WS / gRPC
- Interactive mode and a library API

See [command reference](./docs/commands.md), [library usage](./docs/library.md), and [design notes](./docs/architecture.md) for details.

## Lineage

A Node.js port of the official biz3 admin web app ([CANDY-HOUSE/biz.candyhouse.co](https://github.com/CANDY-HOUSE/biz.candyhouse.co), MIT). The only functional difference from biz3 is that the Cognito client ID is set to the same consumer client as the official iOS / Android apps, which keeps the refresh token from effectively expiring. The biz3 MIT license is bundled as [LICENSE.biz3](./LICENSE.biz3). The port mapping is in [docs/architecture.md](./docs/architecture.md).

---

## Install

Requires Node.js 18+ (uses ESM and the `node:` protocol).

```bash
git clone https://github.com/FukumotoIkuma/sesame-kit.git
cd sesame-kit
npm install
npm link        # expose the `sesame` command globally
# or: node bin/sesame.js ...
```

To use it as a library: `npm link sesame-kit`, or `npm install /path/to/sesame-kit`.

---

## Setup

Authenticate with `login` and `verify`. `verify` imports your companyID, locks, and Hub3 IR remotes automatically.

```bash
sesame init                 # initialize the config directory (~/.config/sesame-hub3/)
sesame login your@email.com # send a verification code to your email
sesame verify               # enter the code; imports companyID / locks / Hub3 IR
```

Run `sesame setup` to re-import after adding devices later.
IR requires both a Hub3 and a Remote to be registered. For lock control alone, only the Lock is needed.

---

## Basic usage

The subject is the device: `sesame <device> <action>` (device matches by substring).

```bash
sesame front unlock            # unlock (substring match: sesame 玄関 unlock)
sesame front lock              # lock
sesame front toggle            # toggle from current state
sesame front status            # state (locked / unlocked, position)
sesame front autolock 30       # autolock (BLE only. 0 = off)
sesame send 停止 --remote ac   # Hub3 IR emit
sesame                         # interactive menu for all devices (session)
```

The route (cloud / BLE) is chosen automatically. Pin it with `--ble-only` / `--cloud-only`.
See [docs/commands.md](./docs/commands.md) for the full command set (IR learning, device management, scheduling, access control, org, IoT, BLE).

### Interactive mode

In a TTY (no `--json`), missing arguments can be selected with the arrow keys (↑↓). `sesame` alone opens the top menu.
With `--json` or in a non-TTY, no prompts are shown and missing arguments are errors (CI-friendly).

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
sesame serve                          # Unix socket only (default. ~/.config/sesame-hub3/sesame.sock)
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

### Bundled clients

Thin zero-dependency clients live under `clients/`.

- Python: `pip install ./clients/python`, then `import sesame_client` from anywhere. For a quick try, `PYTHONPATH=clients/python`.
- JS: copy `clients/js/sesame-client.mjs` into your project, or import it by relative path. For header-authenticated WebSocket, `npm i ws` (otherwise it falls back to URL `?token=`).

```python
from sesame_client import SesameClient
c = SesameClient.unix()              # resolves the default UDS path
print(c.status()); print(c.unlock("front"))
c.subscribe(["lockState"], lambda topic, payload: print("EVENT", topic, payload))
# HTTP: SesameClient.http("http://127.0.0.1:8080") / embedded: SesameClient.stdio()
```

```js
import { SesameClient } from "./sesame-client.mjs";
const c = SesameClient.unix();                       // UDS (POSIX)
console.log(await c.unlock("front"));
await c.subscribe(["lockState"], (topic, p) => console.log("EVENT", topic, p)); // always await
const w = await SesameClient.ws("ws://127.0.0.1:8081"); // WebSocket (full-duplex)
```

gRPC is typed. `src/serve/sesame.proto` has a typed method per op.
Generate stubs with: `python -m grpc_tools.protoc -I src/serve --python_out=. --grpc_python_out=. src/serve/sesame.proto`.

Auth boundary: interactive login is CLI-only and never runs in the daemon. A Unix socket can be used by any process of the same user (the same boundary as the CLI). HTTP / WS / gRPC are over TCP and require a loopback token generated at startup. POSIX only (Windows UDS is out of scope; stdio / HTTP / WS / gRPC work).

---

## Config directory

Precedence: `--config-dir <path>` → `SESAME_HUB3_HOME` → `$XDG_CONFIG_HOME/sesame-hub3` → `~/.config/sesame-hub3`.

```
~/.config/sesame-hub3/
├── config.json         # devices / remotes / default / apiKeyId
├── tokens.json         # Cognito state (must be gitignored)
├── login_state.json    # transient state during sign-in
└── devices.json        # dump from the `devices` command
```

The config schema and the "store all devices in a single `devices{}`" design are in [docs/architecture.md](./docs/architecture.md).

---

## Documentation

- [docs/commands.md](./docs/commands.md) — full CLI command reference
- [docs/library.md](./docs/library.md) — using it as a Node library
- [docs/architecture.md](./docs/architecture.md) — lineage, design decisions, file layout
- [docs/migration.md](./docs/migration.md) — migrating from older versions

---

## Known limitations

- For long-running use, auto-reconnect (exponential backoff 1s→10s), a token refresh callback, and idle / sleep detection are in place.
- Only self-learned remotes (`learnEmit`) are supported. Command generation for preset remotes (picked from a manufacturer DB) is not ported. Use `sesame ir learn` to capture a physical remote.
- autolock cannot be set over the cloud. Use `sesame autolock` over BLE.
- The only unimplemented op is Stripe billing changes. Every other biz3 op (employees / groups / roles / device groups / key sharing / access control / scheduling / IoT) is available as a command.
- The default WS stage is `/public`. `/production` is never used (if it lingers in config it is rewritten to `/public` on load).
- AWS IoT WS requires IPv4. It will not connect on IPv6-only networks.
- New pairing (registering an unregistered device) is not supported; only operating already-registered devices.

---

## Troubleshooting

- `No tokens stored` / `No config at ...`: `sesame init` → `sesame login`, or `sesame migrate`.
- `UserNotFoundException`: auto sign-up is built in. If it still appears, it is a Cognito-side edge case.
- `Cognito refresh returned no IdToken`: the refresh token was invalidated (e.g., logged out in the official app). Sign in again.
- `triggerLock timeout`: wrong `secretKey`, Hub3 offline, or a half-open WS (recovers on auto-reconnect).
- `learn timeout`: the Hub3 entered REGISTER mode but did not receive a waveform. Move closer or try a different button.
- `apiKeyId required`: for `webapi` commands, set `apiKeyId` in config.json (issue one in the biz3 dev console).

## See also

- [CANDY-HOUSE/biz.candyhouse.co](https://github.com/CANDY-HOUSE/biz.candyhouse.co) — the React admin web "biz3" this is ported from
- [SesameSDK_iOS_with_DemoApp](https://github.com/CANDY-HOUSE/SesameSDK_iOS_with_DemoApp) / [SesameSDK_Android_with_DemoApp](https://github.com/CANDY-HOUSE/SesameSDK_Android_with_DemoApp) — the official SDKs referenced
