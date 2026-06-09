# API Stability & 1.0 Surface

This document defines the **public, versioned API surface** of the self-hosted
`sesame serve` daemon — the contract that SDKs and third-party automation build
against. It is the source of decisions for the developer-platform work
(schema-first SDK generation, semver, deprecation).

Status: **pre-1.0** — the surface below is a *proposal/decision record*, not yet a
frozen guarantee. The `stable` tier becomes binding at 1.0.

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
  internal | not_implemented`.
- `data` never echoes inbound params (avoids leaking `secretKey`).
- Transport failures are classified by **structured code**, not error-string
  matching (good); authState is decided by token presence, not regex.

**The kind enum is the contract** — clients branch on `data.kind`, never on the
(localized) `message`.

## Pre-1.0 issues to resolve before freezing `stable`

Tracked here so the stable tier is honest when it freezes:

1. **Domain errors collapse to `internal`.** Namespace ops throw plain `Error`,
   which becomes `{code:-32603, kind:"internal", message}`. Consumers can't branch
   on domain failures without parsing localized messages. → Introduce domain
   `kind`s (e.g. `device_offline`, `not_found`, `rejected`) and optionally
   `data.retryable` before any affected method enters `stable`. **Biggest gap.**
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
- per-method `x-stability` is in `rpc.discover`;
- the error model has no `internal`-collapse on stable methods;
- generated SDKs exist for at least two languages (TS, Python);
- a CI gate guarantees the published schema and the implementation never diverge.
