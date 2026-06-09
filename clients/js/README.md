# sesame-kit JS client (hand-written, low-level)

[`sesame-client.mjs`](./sesame-client.mjs) is a **hand-written, low-level transport
client** for the `sesame serve` daemon — the *薄い公式クライアント* ("thin official
client"). It is **not generated** from the schema. Node 18+, **zero runtime deps**.

This is what `sesame-kit/client` (`package.json` `exports`) points at:

```js
import { SesameClient } from "sesame-kit/client"; // or "./sesame-client.mjs"

const c = SesameClient.unix();                     // Unix socket (default)
await c.unlock("front");                            // convenience method
await c.call("device.history", { deviceUUID: "AB12CD34...", pageSize: 10 }); // any method
await c.subscribe(["lockState"], (topic, p) => console.log(topic, p)); // always await

// const h = SesameClient.http("http://127.0.0.1:8080");    // token auto-read from serve.token
// const w = await SesameClient.ws("ws://127.0.0.1:8081");  // full-duplex (npm i ws for header auth)
```

Use this when you want a **thin, minimal-dependency, multi-transport** client
(Unix socket / stdio / HTTP / WebSocket) or a generic `call()` escape hatch.
Failures throw `SesameError(message, kind)` (`kind`: `not_authenticated` /
`connection_lost` / `timeout` …).

## When to use the generated SDK instead

For most users the **typed, contract-tracked SDK** is the better choice:
[`sdk/ts/sesame-client.ts`](../../sdk/ts/sesame-client.ts) is **generated** from
[`schema/openrpc.json`](../../schema/openrpc.json), with one typed method per RPC,
typed params/results, and `SesameRpcError` (`kind` / `retryable`). See
[`sdk/ts/README.md`](../../sdk/ts/README.md) and the
[repository README](../../README.md#which-should-i-use--sdk-vs-clients) for the
full "which should I use?" guidance.
