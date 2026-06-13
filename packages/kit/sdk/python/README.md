# sesame-kit Python SDK (generated)

A typed client for the self-hosted `sesame serve` daemon (JSON-RPC over HTTP),
**zero dependencies** (stdlib `urllib`). **Generated** from
[`schema/openrpc.json`](../../../../schema/openrpc.json) by `npm run build:sdk:py` —
do not edit `sesame_client.py` by hand; it is drift-gated against the schema
(`packages/kit/tests/sdk-py-contract.test.js`).

> **Two Python clients ship with sesame-kit, and they share the module name
> `sesame_client` and the class name `SesameClient` — but their APIs are
> different and incompatible. Install/vendor only ONE.**
>
> - **This generated, fully-typed SDK** (`sdk/python`, HTTP-only) — constructor
>   `SesameClient(base_url, token=...)` with namespaced typed calls like
>   `client.lock.unlock(name="front")`. No `.unix()` / `.http()` factories and no
>   positional convenience methods.
> - **The bundled thin client** (`clients/python`, hand-written, multi-transport:
>   Unix socket / stdio / HTTP) — factory constructors `SesameClient.unix()` /
>   `.stdio()` / `.http()`, positional convenience methods like `c.unlock("front")`,
>   and `c.call(method, **params)`. See the integration guide,
>   [`docs/en/integration.md`](../../../../docs/en/integration.md) §4
>   ([日本語](../../../../docs/ja/integration.md)).
>
> Because both resolve `from sesame_client import SesameClient`, the examples
> below only work against this generated SDK; copy-pasting them against the
> bundled thin client (or vice-versa) fails. Pick one per project.

## Get the file

Not on PyPI (yet). It's **one file with zero dependencies** (stdlib `urllib`
only) — **vendor it**: copy `sesame_client.py` into your project and
`from sesame_client import SesameClient`. Python 3.10+ (uses `X | None`).

## Types: what's typed vs not

- **Params are typed keyword args** from the schema —
  `client.lock.unlock(name="front")`, `client.lock.status(deviceUUID=...)`; a
  missing required arg is a **TypeError at the call site** (before any network
  I/O), enums are `Literal`.
- **Stable methods return generated `TypedDict`s** — `status()` returns
  `StatusResult`, `account.whoami()` returns `AccountWhoamiResult`,
  `devices.list()` returns `list[DevicesListResultItem]`, `device.battery()`
  returns `DeviceBatteryResult`, etc. Field-level optionality is encoded with
  `NotRequired[...]`. `lock.status()` returns `LockStatusResult | None` (vendor
  consumes only the first element, so an empty result is `None`). Sub-objects
  whose interior shape isn't pinned (e.g. `stateInfo`, `quotas`) stay `Any`.
  Experimental / un-traced methods return `Any`. Errors are typed via
  `SesameRpcError` (`kind` / `retryable`).
  - The `TypedDict`s use `NotRequired` (typing 3.11+) imported under
    `TYPE_CHECKING`; `from __future__ import annotations` keeps every annotation
    a string, so the file still imports and runs on **Python 3.10** while type
    checkers see the full shape.

## Usage

```python
from sesame_client import SesameClient, SesameRpcError

client = SesameClient("http://127.0.0.1:8080", token="...")  # serve.token

# stable methods (namespaced, typed keyword args)
client.lock.unlock(name="front")
devices = client.devices.list()
st = client.status()

# errors carry the machine-readable kind / retryable
try:
    client.lock.lock(name="front")
except SesameRpcError as e:
    if e.retryable:
        ...  # retry
```

## Stability

Methods whose docstring says `@experimental` are outside the API SemVer
guarantee (see `docs/api-stability.md`). Only the `stable` surface
(`lock.*`(`setAutolock` を除く), `devices.list`, `device.history`/`battery`, `status`,
`account.whoami`, `events.*`) is covered by `API_VERSION`.

## Events

```python
# blocks; run in a thread if you need it non-blocking
def on_event(frame):
    # frame["method"] is "event.ready" (on connect) or "event.<topic>"
    if frame["method"] == "event.lockState":
        print("lock changed:", frame["params"])

client.stream_events(["lockState", "deviceUpdate"], on_event)
```

`stream_events` reads SSE `GET /events`. The callback receives `event.ready`
first, then your subscribed `event.<topic>` notifications.

> This is the **generated, typed** SDK and is recommended for most users. A
> separate **hand-written, low-level** thin client (multi-transport: Unix socket /
> stdio / HTTP; a different, incompatible API despite sharing the
> `sesame_client` / `SesameClient` name) ships at
> [`clients/python/`](../../clients/python/) — use it for thin / multi-transport /
> custom integrations. See the
> [repository README](../../../../README.md#which-should-i-use--sdk-vs-clients) for the
> full "which should I use?" guidance and the integration guide
> ([`docs/en/integration.md`](../../../../docs/en/integration.md) §4).
> Calls go to `POST {base_url}/rpc`; events to `GET {base_url}/events` (SSE).
