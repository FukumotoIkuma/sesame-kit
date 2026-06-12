<!-- English | [日本語](../ja/integration.md) -->

# Integrate from any language (`sesame serve`)

> [日本語](../ja/integration.md) · [Docs index](./index.md)

`sesame serve` is a long-running JSON-RPC 2.0 daemon. It signs in once, keeps the cloud connection alive, runs operations repeatedly, and pushes events. Cloud/Biz3 features are exposed as typed RPC methods. BLE operations are also exposed as typed methods — each facade op appears as `ble.<op>` / `ble.os2.<op>` (e.g. `ble.script.click`, `ble.biometric.cardAdd`, `ble.hub3.setWifiSSID`) with named parameters in the generated SDKs (all `experimental`, not yet confirmed against real hardware). The generic `ble.invoke` / `ble.os2.invoke` string-dispatch remains as an escape hatch.

## 1. Sign in and start the daemon

The daemon uses your stored login — it does not sign in itself. Sign in once with the CLI, then start the daemon.

```bash
sesame login your@email.com && sesame verify   # if not already signed in
sesame serve --http 8080                        # serve over HTTP on port 8080
```

The daemon prints a token at startup (also saved to `~/.config/sesame-kit/serve.token`). Every HTTP request must send `Authorization: Bearer <token>`.

> For same-machine use, `sesame serve` with no flags listens on a Unix socket and needs no token. HTTP is used here because it works from any language and any machine.

## 2. Your first call — no library to install

It is plain JSON-RPC over HTTP. Anything that can POST works.

```bash
TOKEN=...   # the token printed by `sesame serve`

curl -s -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"lock.unlock","params":{"name":"front"}}' \
  http://127.0.0.1:8080/rpc
```

The same in Python, using only the standard library (no pip install):

```python
import json, urllib.request

TOKEN = "..."   # the token printed by `sesame serve`

def rpc(method, params=None):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}).encode()
    req = urllib.request.Request("http://127.0.0.1:8080/rpc", data=body,
        headers={"content-type": "application/json", "authorization": f"Bearer {TOKEN}"})
    return json.load(urllib.request.urlopen(req))

print(rpc("status"))
print(rpc("lock.unlock", {"name": "front"}))
```

A response is `{"jsonrpc":"2.0","id":1,"result": ...}` on success, or `{"jsonrpc":"2.0","id":1,"error":{"code","message","data":{"kind"}}}` on failure.

## 3. Finding the method and the values to pass

`sesame rpc` lists every method with its parameters (required shown plain, optional in `[brackets]`):

```bash
sesame rpc
```

```text
lock.unlock                  [name] [deviceUUID] [secretKey]
lock.status                  deviceUUID
devices.list
device.history               deviceUUID [pageSize]
ir.send                      [remote] key
org.getEmployees             companyID
access.registerCards         deviceUUID cards   # [experimental] bulk-register read IC cards (cloud DB)
…
202 methods.
```

Read the line for the method you want. Each line is `method  <required> [optional]`. For example, `device.history  deviceUUID [pageSize]` means **`deviceUUID` is required and `pageSize` is optional**.

Then fill each parameter with a **value**. Values come from one of two places:

- **IDs** (`deviceUUID`, `companyID`, …) are returned by another list method. For a `deviceUUID`, take one from `devices.list`:

  ```bash
  sesame rpc devices.list
  # → [{"deviceUUID":"AB12CD34...","deviceName":"front", ...}, ...]
  ```

- **Values you choose** (`pageSize`, `name`, …) are optional and up to you. `pageSize` is the number of records.

Put the values in the `--params` JSON and call it:

```bash
sesame rpc device.history --params '{"deviceUUID":"AB12CD34...","pageSize":10}'
```

The **method name and params you settle on here are exactly what you send from any client** (the `method` / `params` fields of the call in section 2).

> Lock ops also accept a config name instead of a `deviceUUID` — `{"name":"front"}` works for `lock.unlock` / `lock.lock` / `lock.toggle` / `lock.click`. (`lock.status` takes a `deviceUUID`.)

For exact parameter types (e.g. for code generation), `sesame rpc --json rpc.discover` returns the full OpenRPC document. Each method entry carries its param types:

```json
{
  "name": "device.history",
  "params": [
    { "name": "deviceUUID", "required": true,  "schema": { "type": "string" } },
    { "name": "pageSize",   "required": false, "schema": { "type": "number" } }
  ]
}
```

## 4. Bundled clients (optional)

Thin clients wrap the above so you write `c.unlock("front")` instead of building JSON by hand. They are optional — section 2 already works without them.

> **`sdk/` vs `clients/`** — the clients below are the **hand-written, low-level** layer (`clients/js`, `clients/python`): minimal-dependency, multi-transport (JS: Unix socket / HTTP / WebSocket; Python: Unix socket / stdio / HTTP — neither covers gRPC, for which you generate protoc stubs from `src/serve/sesame.proto`), with a generic `call()`. For most users the **generated, typed** SDK ([`sdk/ts`](../../sdk/ts/README.md) / [`sdk/python`](../../sdk/python/README.md)) — one typed method per RPC, generated from `schema/openrpc.json` and tracking the OpenRPC contract over HTTP — is the better default. See the ["which should I use?" guide](../../README.md#which-should-i-use--sdk-vs-clients).

**Node** — after `npm install sesame-kit`:

```js
import { SesameClient } from "sesame-kit/client";

const c = SesameClient.unix();                          // default Unix socket
try {
  console.log(await c.unlock("front"));                 // convenience method
  console.log(await c.call("device.history", { deviceUUID: "AB12CD34...", pageSize: 10 })); // any method
  console.log((await c.discover()).methods.map((m) => m.name));  // list methods from JS
  await c.subscribe(["lockState"], (topic, p) => console.log(topic, p)); // always await
} finally {
  c.close();
}

// const h = SesameClient.http("http://127.0.0.1:8080");   // token auto-read from serve.token
// const w = await SesameClient.ws("ws://127.0.0.1:8081");  // npm i ws for header auth
```

**Python** — the client is a single file shipped with the package:

> **Two Python clients ship with sesame-kit, and they share the module name `sesame_client` and the class name `SesameClient` — but their APIs are different and incompatible. Install/vendor only ONE.**
> - **This bundled client** (`clients/python`, hand-written, multi-transport convenience) — factory constructors `SesameClient.unix()` / `.http()` / `.stdio()`, positional convenience methods like `c.unlock("front")`, and `c.call(method, **params)`. Documented below.
> - **The generated, fully-typed SDK** (`sdk/python`, HTTP-only) — constructor `SesameClient(base_url, token=...)` with namespaced typed calls like `c.lock.unlock(name="front")`. No `.unix()` / `.http()` factories and no positional convenience methods. See [`sdk/python/README.md`](../../sdk/python/README.md).
>
> Because both resolve `from sesame_client import SesameClient`, the examples below only work against the bundled client; copy-pasting them against the generated SDK (or vice-versa) fails. Pick one per project.

```bash
pip install ./clients/python                       # from a cloned repo
pip install "$(npm root -g)/sesame-kit/clients/python"   # from a global `npm install -g sesame-kit`
```
```python
from sesame_client import SesameClient

c = SesameClient.unix()                       # default Unix socket
print(c.unlock("front"))                      # convenience method
print(c.call("device.history", deviceUUID="AB12CD34...", pageSize=10))  # any method
print(c.discover_names())                     # list methods from Python
c.subscribe(["lockState"], lambda topic, payload: print(topic, payload))
# HTTP: SesameClient.http("http://127.0.0.1:8080") / embedded: SesameClient.stdio()
```

## Transports (framings)

The same RPC catalog is available over five transports. Use HTTP/WS/gRPC for network access, the Unix socket or stdio for the local machine. Event delivery remains transport-native.

| Framing | Use | Events | Auth |
|---|---|---|---|
| stdio | embedded (child process) | `event.*` notifications | inherits parent trust |
| Unix socket | local daemon, multiple clients | `event.*` notifications | file permission 0600 |
| HTTP | any language / browser | `GET /events` (SSE) | `Authorization: Bearer <token>` |
| WebSocket | any language / browser (full-duplex) | `event.*` notifications | token |
| gRPC | typed stubs for many languages | `Subscribe` stream | token (metadata) |

gRPC is typed: `src/serve/sesame.proto` has a typed method per op. Generate stubs with
`python -m grpc_tools.protoc -I src/serve --python_out=. --grpc_python_out=. src/serve/sesame.proto`.
Scalar/array params are protobuf-typed; dynamic params are a JSON-string field; responses are `JsonRpc{json}`. Ops without a typed method use the generic `Invoke`.

## Events

```jsonc
// request (over Unix socket / WebSocket / stdio):
{"jsonrpc":"2.0","id":1,"method":"events.subscribe","params":{"topics":["lockState","deviceUpdate"]}}
// then notifications arrive (no id):
{"jsonrpc":"2.0","method":"event.lockState","params":{ /* state */ }}
```

Topics: `lockState`, `deviceUpdate`, and the experimental `deviceListChanged` (key sharing / device add-remove; biz3 `pubUserDeviceChange`). The subscribable list is machine-readable as `x-event-topics` in `rpc.discover`. Over HTTP use `GET /events?topics=…` (SSE); over gRPC use the `Subscribe` stream. `POST /rpc` and gRPC `Invoke` are request/response only and reject `events.*`.

## Errors

Errors are `{error:{code, message, data:{kind}}}`. `kind` is one of:
`not_authenticated` (sign in via the CLI, then restart the daemon) / `connection_lost` (cloud connection down) / `timeout` / `bad_params` / `rejected` (the upstream cloud explicitly returned a failure) / `not_implemented` (unknown method) / `internal` (anything else; details in `message`).

`data` may carry extra fields: `data.retryable` (boolean) is a retry hint for automation — `true` on transient kinds (`timeout`, `connection_lost`), `false` on `rejected` / `bad_params`. On `rejected`, `data.upstreamCode` carries the upstream cloud's own code.

`not_authenticated` is reachable from any client, including the typed SDKs: the Python SDK maps HTTP-level failures (e.g. HTTP 401) to `SesameRpcError` with `kind = "not_authenticated"`, so an expired or missing token surfaces as a normal `SesameRpcError` rather than a raw HTTP error.

## Compatibility

The result shape is method-specific. To check compatibility, read the contract version: `status` returns `contractVersion`, and `rpc.discover` returns `info["x-contractVersion"]`. It is a SemVer for the machine contract; only breaking changes bump the major.

## Security boundary

Interactive login is CLI-only and never runs in the daemon. A Unix socket can be used by any process of the same user (the same boundary as the CLI). HTTP / WS / gRPC are over TCP and require a loopback token generated at startup. They are plaintext (no TLS); expose them over loopback only, or tunnel via SSH / a TLS reverse proxy. POSIX only (Windows UDS is out of scope; stdio / HTTP / WS / gRPC work).
