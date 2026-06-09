# sesame-kit Python client (hand-written, low-level)

[`sesame_client.py`](./sesame_client.py) is a **hand-written, low-level transport
client** for the `sesame serve` daemon — the *薄い公式クライアント* ("thin official
client"). It is **not generated** from the schema. Standard library only,
**zero dependencies**.

```bash
pip install ./clients/python                              # from a cloned repo
pip install "$(npm root -g)/sesame-kit/clients/python"   # from a global npm install
```
```python
from sesame_client import SesameClient

c = SesameClient.unix()                       # Unix socket (default)
print(c.unlock("front"))                      # convenience method
print(c.call("device.history", deviceUUID="AB12CD34...", pageSize=10))  # any method
c.subscribe(["lockState"], lambda topic, payload: print(topic, payload))
c.wait()
# HTTP: SesameClient.http("http://127.0.0.1:8080") / embedded: SesameClient.stdio()
```

Use this when you want a **thin, minimal-dependency, multi-transport** client
(Unix socket / stdio / HTTP / WebSocket) or a generic `call()` escape hatch.
Failures raise `SesameError(message, kind)` (`kind`: `not_authenticated` /
`connection_lost` / `timeout` …).

## When to use the generated SDK instead

For most users the **typed, contract-tracked SDK** is the better choice:
[`sdk/python/sesame_client.py`](../../sdk/python/sesame_client.py) is **generated**
from [`schema/openrpc.json`](../../schema/openrpc.json), with one typed method per
RPC, typed keyword args / `TypedDict` results, and `SesameRpcError`
(`kind` / `retryable`). See [`sdk/python/README.md`](../../sdk/python/README.md)
and the [repository README](../../README.md#which-should-i-use--sdk-vs-clients)
for the full "which should I use?" guidance.
