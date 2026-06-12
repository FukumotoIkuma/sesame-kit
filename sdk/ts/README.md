# sesame-kit TypeScript SDK (generated)

A typed client for the self-hosted `sesame serve` daemon (JSON-RPC over HTTP).
**Generated** from [`schema/openrpc.json`](../../schema/openrpc.json) by
`npm run build:sdk` — do not edit `sesame-client.ts` by hand; it is drift-gated
against the schema (`tests/sdk-ts-contract.test.js`).

> This is the **generated, typed** SDK and is recommended for most users. A
> separate **hand-written, low-level** client (multi-transport: Unix socket /
> HTTP / WebSocket) ships at [`clients/js/`](../../clients/js/) — use it
> for thin / multi-transport / custom integrations. See the
> [repository README](../../README.md#which-should-i-use--sdk-vs-clients) for the
> full "which should I use?" guidance.

## Get the file

Not published to npm (yet). It's a single self-contained file with **no runtime
deps** (uses the global `fetch`, Node 20+ or any browser). **Vendor it**: copy
`sesame-client.ts` into your project, or import it from a source checkout.

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

## Types: what's typed vs not

- **Params are typed** from the schema (`client.lock.unlock({ name })`,
  `lock.status({ deviceUUID })` — a missing required field is a compile error).
- **Stable methods have typed results** — `await client.status()` is
  `{ connected, authState, apiVersion, ... }` (no cast needed), `devices.list()`
  is `Array<{ deviceUUID, deviceName?, ... }>`, etc. `lock.status()` is
  `{ deviceUUID, ... } | null` (vendor consumes only the first element, so an
  empty result is `null`). Sub-objects whose shape isn't pinned (e.g.
  `stateInfo`, `quotas`) are `unknown`.
- **Experimental / un-traced methods return `Promise<unknown>`** — cast or
  validate those. Errors are typed via `SesameRpcError` (`kind` / `retryable`).

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
