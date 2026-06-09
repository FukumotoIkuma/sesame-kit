# sesame-kit TypeScript SDK (generated)

A typed client for the self-hosted `sesame serve` daemon (JSON-RPC over HTTP).
**Generated** from [`schema/openrpc.json`](../../schema/openrpc.json) by
`npm run build:sdk` — do not edit `sesame-client.ts` by hand; it is drift-gated
against the schema (`tests/sdk-ts-contract.test.js`).

## Usage

```ts
import { SesameClient } from "./sesame-client";

const client = new SesameClient({
  baseUrl: "http://127.0.0.1:8080",          // sesame serve --http 8080
  token: process.env.SESAME_TOKEN,            // ~/.config/sesame-kit/serve.token
});

// stable methods
await client.lock.unlock({ name: "front" });
const devices = await client.devices.list();
const st = await client.status();

// errors carry the machine-readable kind / retryable
import { SesameRpcError } from "./sesame-client";
try {
  await client.lock.lock({ name: "front" });
} catch (e) {
  if (e instanceof SesameRpcError && e.retryable) { /* retry */ }
}
```

## Stability

Methods are tagged `@experimental` in JSDoc when they are outside the API SemVer
guarantee (see `docs/api-stability.md`). Only the `stable` surface
(`lock.*`, `devices.list`, `device.history`/`battery`, `status`,
`account.whoami`, `events.*`) is covered by `API_VERSION` semver.

## Events

```ts
const ac = new AbortController();
client.streamEvents(["lockState", "deviceUpdate"], (e) => {
  // e.method is "event.ready" (sent on connect) or "event.<topic>"
  if (e.method === "event.lockState") console.log("lock changed:", e.params);
}, { signal: ac.signal });
// later: ac.abort();
```

`streamEvents` reads SSE `GET /events`. The callback receives `event.ready`
first (stream is live), then your subscribed `event.<topic>` notifications.
Topic names are typed (`SesameEventTopic`).

## Transport

Calls go to `POST {baseUrl}/rpc`; events to `GET {baseUrl}/events` (SSE). For
network framings pass the loopback `token`; over a Unix socket the daemon trusts
the same user (no token).
