# sesame-kit Python SDK (generated)

A typed client for the self-hosted `sesame serve` daemon (JSON-RPC over HTTP),
**zero dependencies** (stdlib `urllib`). **Generated** from
[`schema/openrpc.json`](../../schema/openrpc.json) by `npm run build:sdk:py` —
do not edit `sesame_client.py` by hand; it is drift-gated against the schema
(`tests/sdk-py-contract.test.js`).

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
(`lock.*`, `devices.list`, `device.history`/`battery`, `status`,
`account.whoami`, `events.*`) is covered by `API_VERSION`.

> This is the **generated, typed** client. A separate hand-written thin client
> ships at `clients/python/sesame_client.py` (see the integration guide).
> Calls go to `POST {base_url}/rpc` with a Bearer token; SSE event streaming is
> not yet wrapped here.
