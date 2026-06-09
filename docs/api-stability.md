# API Stability & 1.0 Surface

This document defines the **public, versioned API surface** of the self-hosted
`sesame serve` daemon — the contract that SDKs and third-party automation build
against. It is the source of decisions for the developer-platform work
(schema-first SDK generation, semver, deprecation).

Status: **pre-1.0** — the surface below is a *proposal/decision record*, not yet a
frozen guarantee. The `stable` tier becomes binding at 1.0.

## Two boundaries (our schema is the downstream parent, not the only one)

A subtle but load-bearing truth: our OpenRPC is the canonical parent **for
consumers**, but it is not the ultimate authority over **behavior**. There are two
boundaries, with an anti-corruption layer between them:

```
vendor reality (discovered)   ──►  [ anti-corruption layer ]  ──►  our contract (designed/owned)  ──►  SDKs
official app / biz3 cloud WS        src/<namespace>.js, client.js     OpenRPC (stable/experimental)
(the upstream "parent" of our        translate + absorb upstream
 implementation; not ours to fix)    change so downstream stays stable
```

- **Upstream truth = the vendor** (official app / biz3 cloud WS). This is a
  *discovered* spec, reverse-engineered and verified — not designed by us, and it
  can change without notice. `src/client.js` is that boundary.
- **Downstream contract = our OpenRPC.** Owned and designed by us; stable because
  we choose it to be.
- The **namespace modules are the anti-corruption layer**: they map vendor WS
  messages into our method shapes and exist precisely to *absorb upstream churn so
  the downstream contract does not break*.

The asymmetry is not a defect — it is the platform's reason to exist (consumers
pay us to track the vendor so they don't have to). But it bounds what we can
promise:

1. **`stable` is a best-effort facade.** It is only as stable as our ability to
   absorb upstream change. If the vendor removes a capability we cannot map, a
   stable method may still have to break. We say so honestly rather than implying
   an absolute guarantee.
2. **Tier = upstream confidence, not just API maturity.** A method is
   `stable` only when it is **(a) load-bearing in the official app** (so the vendor
   is very unlikely to break it — e.g. lock control, state events) **and (b)
   verified by us**. The `未確認` / "unverified" notes scattered in the source are
   exactly the *low upstream-confidence* signal that keeps a method `experimental`.
3. **We need upstream-drift detection.** Because the true parent is outside our
   control, "schema ↔ impl" drift checking is not enough; we also need
   "vendor-behavior ↔ impl" conformance monitoring (live canary or replay of
   captured fixtures), or the facade silently starts lying. See issues.

### Provenance (first-class)

Each contract element should carry where its shape came from and how sure we are —
e.g. `verified-live` / `biz3-source-ref:<path>` / `unverified`. This formalizes the
informal `未確認` comments. **`x-stability` is derived from provenance**, so the
confidence we hold internally and the promise we make externally stay consistent.

## Model: two tiers

| Tier | Guarantee | Versioning |
|---|---|---|
| **stable** | Method name, params, return shape, and error `kind`s do not change incompatibly. Removal/incompatible change only on a major bump, after a deprecation period. | Covered by the API semver (`apiVersion` in `status` / `rpc.discover`). |
| **experimental** | May change or be removed in any release, no deprecation period. SDKs surface these behind an explicit `experimental` namespace/flag. | Excluded from the semver guarantee. |

The tier of every method is **machine-readable** via `rpc.discover` (planned:
`x-stability: stable | experimental` per method) so SDKs and tools can enforce it.

Principle (pre-1.0 latitude, 1.0 strictness): keep the **stable surface small and
provably solid**; ship breadth as **experimental** rather than over-committing.

## Transport / dependency reality (applies to all methods)

- The daemon backs every RPC with **one resident cloud-WS client** (`SesameHub3`).
  As of today **all RPC methods require the cloud WS**; `serve` exposes **no BLE
  path**. (BLE lives in `src/ble/*` and is library-only.) Exposing BLE-backed
  local control through `serve` is a separate, future surface.
- Meta methods `status` and `rpc.discover` need neither auth nor the cloud.
- Network framings (HTTP/WS/gRPC) require the loopback bearer token; stdio and the
  Unix socket trust the same-user process.

## Stable 1.0 surface (core)

~15 methods + 2 events. This is the only surface the platform commits to at 1.0.
Each qualifies under the stable test above: **load-bearing in the official app**
(vendor unlikely to break) **and verified by us**.

### Meta
| Method | Description |
|---|---|
| `status` | Daemon/cloud status: `{connected, authState, subUUID, apiVersion}` |
| `rpc.discover` | OpenRPC document (incl. per-method `x-stability`, events) |
| `account.whoami` | Logged-in customer info |

### lock (core control)
| Method | Params | Notes |
|---|---|---|
| `lock.lock` | `name` \| `{deviceUUID, secretKey}` | |
| `lock.unlock` | `name` \| `{deviceUUID, secretKey}` | |
| `lock.toggle` | same | cloud decides direction (cmd 88) |
| `lock.click` | same | bot click (cmd 89) |
| `lock.status` | `{deviceUUID}` | status snapshot |

### devices / telemetry
| Method | Params |
|---|---|
| `devices.list` | none |
| `device.history` | `{deviceUUID, pageSize?}` |
| `device.battery` | `{deviceUUID, pageSize?}` |

### events
| Method | Params |
|---|---|
| `events.subscribe` | `{topics}` — `lockState` \| `deviceUpdate` |
| `events.unsubscribe` | `{topics}` |

Events emitted: `event.lockState`, `event.deviceUpdate`. (See delivery semantics
below and the pre-1.0 issues.)

## Experimental namespaces (excluded from 1.0 guarantee)

All of the following stay **experimental** — broad cloud/business features, many
with explicitly unverified response shapes (`未確認` notes in source):

- `org.*` (~34 ops: employees, groups, tags, device-group binding, key sharing)
- `company.*` (4 ops)
- `access.*` (11 ops: cards / passcodes)
- `iot.*` (11 ops: Hub3 device mgmt, Matter, firmware)
- `presetir.*` (3 ops) and `ir.send` / `ir.listKeys` — IR features
- `schedule.*` (2 ops)

These remain callable and documented, but SDKs surface them as `experimental` and
they may change without notice.

## Event delivery semantics (current)

- Single upstream subscription, fanned out to subscribed connections.
- A connection subscribed to both topics receives each event **once** (deduped,
  labeled with the first matching topic).
- **Resubscribe-on-reconnect** is handled by the daemon.
- **No ordering, sequence id, or replay** across reconnect gaps. Ephemeral HTTP
  `POST /rpc` connections cannot subscribe (use SSE `GET /events?topics=…`).

> For automation correctness, adding a per-event sequence id + `lastEventId`
> gap-detection is a candidate for the stable event contract (see issues).

## Error model (current)

JSON-RPC 2.0 errors carry a structured, machine-readable `data.kind`:

- Codes: `-32700/-32600/-32601/-32602/-32603` (standard) and `-32000` (app).
- `kind` ∈ `not_authenticated | bad_params | timeout | connection_lost |
  rejected | internal | not_implemented`.
- `data.retryable` (boolean, optional): retry hint for automation —
  `timeout`/`connection_lost` = true, `rejected`/`bad_params` = false.
- `rejected` carries `data.upstreamCode` (the vendor cloud's failure code;
  provenance = upstream).
- Library throws are typed (`SesameError` with a machine `code`); the serve
  boundary maps `code` → `kind` (`src/errors.js` → `src/serve/jsonrpc.js`), so
  domain failures no longer collapse to `internal`.
- `data` never echoes inbound params (avoids leaking `secretKey`).
- Transport failures are classified by **structured code**, not error-string
  matching (good); authState is decided by token presence, not regex.

**The kind enum is the contract** — clients branch on `data.kind`, never on the
(localized) `message`.

## Pre-1.0 issues to resolve before freezing `stable`

Tracked here so the stable tier is honest when it freezes:

1. **Domain errors collapse to `internal`.** *(addressed for the stable lock path
   in 1.1.0)* — `src/errors.js` (`SesameError` + machine `code`) is mapped at the
   serve boundary to `kind` + `data.retryable`; `lock.*` and the lock-resolution
   path now emit `rejected`/`connection_lost`/`timeout`/`bad_params` instead of
   `internal`. **Remaining:** experimental namespace ops (`org/iot/...`) still
   throw plain `Error` → `internal`; convert each before it enters `stable`.
2. **`event.ready`** is advertised in `rpc.discover` but never emitted — either
   emit it or drop it from the contract.
3. **`iot.subscribeIotResponse` / `iot.removeSesameFromHub3`** have no extracted
   params, so `discover` describes them only as `(params)`. (Experimental, but
   fix the self-description.)
4. **Stale `CONTRACT_VERSION` doc-comment** ("79 method") vs the 81 now exposed.
5. **`apiVersion` separation** — version the API surface independently from the
   package version; expose it in `status` and `rpc.discover`.

## Definition of 1.0

1.0 ships when:
- the `stable` surface above is frozen, documented, and semver-governed;
- per-method `x-stability` is in `rpc.discover`, **derived from provenance**;
- the error model has no `internal`-collapse on stable methods;
- generated SDKs exist for at least two languages (TS, Python);
- a CI gate guarantees the published schema and the implementation never diverge
  (**schema ↔ impl**); and
- an **upstream-conformance** check (vendor-behavior ↔ impl, live canary or replay)
  exists for stable methods, so vendor drift is detected rather than silently
  breaking the facade.
