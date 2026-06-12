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
   "vendor-behavior ↔ impl" conformance monitoring, or the facade silently starts
   lying. Implemented as `scripts/canary-upstream.mjs`, which has two modes:
   - **live** (`node scripts/canary-upstream.mjs`) — opt-in, read-only, **needs
     creds + network**. Calls stable read-only ops against the real cloud and
     asserts stable-contract fields are present in the live responses. Exits
     non-zero on drift. Run manually or on a schedule; **not** in CI (no creds).
   - **offline replay** (`node scripts/canary-upstream.mjs --replay`) — **runs in
     CI, no creds.** Validates recorded vendor-response samples in
     `tests/fixtures/upstream/*.json` against the **same** stable schemas
     (`src/serve/result-schemas.js`) the live canary asserts against, and exits
     non-zero on mismatch. This catches the "someone loosened a stable schema so it
     no longer matches a real vendor response" class of drift without live access.
     Fixtures are synthetic-but-schema-valid samples; refresh them from a live run
     when the vendor genuinely changes a shape (see the fixtures README and the
     header of `scripts/canary-upstream.mjs`). Wired as the `upstream-canary-replay`
     job in `.github/workflows/ci.yml`; the replay path is also covered by
     `tests/serve/upstream-canary-replay.test.js`.

### Provenance (first-class)

Each contract element should carry where its shape came from and how sure we are —
e.g. `verified-live` / `biz3-source-ref:<path>` / `unverified`. This formalizes the
informal `未確認` comments. **`x-stability` is derived from provenance**, so the
confidence we hold internally and the promise we make externally stay consistent.

## Model: two tiers

| Tier | Guarantee | Versioning |
|---|---|---|
| **stable** | Method name, params, return shape, and error `kind`s do not change incompatibly. Removal/incompatible change only on a major bump, after a deprecation period. | Covered by the API semver (`apiVersion` in `status` / `rpc.discover`). |
| **experimental** | May change or be removed in any release, no deprecation period. The generated SDKs annotate these methods with a JSDoc/docstring `@experimental` marker (`@experimental unverified — may change without notice.`) on the normal namespace — there is no separate `experimental` namespace; the methods live alongside stable ones (e.g. `client.org.*`) and tooling/IDEs surface the marker. | Excluded from the semver guarantee. |

The tier of every method is **machine-readable** via `rpc.discover` — each method
and event carries `x-stability: stable | experimental` and `x-provenance` — so
SDKs and tools can enforce it.

Principle (pre-1.0 latitude, 1.0 strictness): keep the **stable surface small and
provably solid**; ship breadth as **experimental** rather than over-committing.

## Transport / dependency reality (applies to all methods)

- The daemon backs cloud/Biz3 RPC methods with **one resident cloud-WS client**
  (`SesameHub3`). Registered BLE operations are exposed separately through
  `ble.invoke` / `ble.os2.invoke`, which use the daemon host Bluetooth adapter
  and do not require cloud auth for the BLE session itself.
- Meta methods `status` and `rpc.discover` need neither auth nor the cloud.
- Network framings (HTTP/WS/gRPC) require the loopback bearer token; stdio and the
  Unix socket trust the same-user process.

## Stable 1.0 surface (core)

**13 methods + 3 events** (the single source is `src/serve/stability.js`, locked
against the live registry by `tests/serve-stability.test.js` / `tests/provenance.test.js`).
This is the only surface the platform commits to at 1.0. Each qualifies under the
stable test above: **load-bearing in the official app** (vendor unlikely to break)
**and verified by us**.

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
| `lock.status` | `{deviceUUID}` | single device snapshot or `null` (vendor consumes `data[0]`; the daemon unwraps the transport array — `references_web/.../useManageDevice.js:84`) |

### devices / telemetry
| Method | Params |
|---|---|
| `devices.list` | none |
| `device.history` | `{deviceUUID, pageSize?}` |
| `device.battery` | `{deviceUUID, pageSize?}` |

### events
| Method | Params |
|---|---|
| `events.subscribe` | `{topics}` — `lockState` \| `deviceUpdate` \| `deviceListChanged` (experimental topic) |
| `events.unsubscribe` | `{topics}` |

Stable events emitted: `event.lockState`, `event.deviceUpdate` (provenance
app-core) and `event.ready` (provenance local — a connection-ready lifecycle
notification sent once on every persistent connection since contract 1.2.0).
`event.deviceListChanged` is **experimental** (provenance unverified; biz3
`pubUserDeviceChange`). (See delivery semantics below.)

## Intentionally absent from CLI/RPC: lock raw escape hatch

`SesameHub3` exposes two library-only methods for sending an arbitrary `cmd`
value directly to a lock:

- `triggerLockRaw(name, cmd)` — resolves a config name, then sends any `cmd`.
- `triggerLockDevice({ deviceUUID, secretKey, cmd })` — bypasses config, same
  raw send.

**These methods are deliberately not wired as CLI subcommands or RPC methods.**
Reason: accepting an arbitrary integer `cmd` in a networked endpoint is an
unguarded misfire surface — a caller typo or a replay of a stale payload could
send an undocumented item code to production hardware. The named wrappers
(`lock.lock` / `lock.unlock` / `lock.toggle` / `lock.click` and their
`*Device` counterparts) cover every cmd the official app sends (82/83/88/89)
and are the correct entry points for automation.

Contrast: `iot.sendIotCmd` / `iot.sendIotCmdAwait` *are* exposed (as
`sesame iot raw` / RPC `iot.sendIotCmd`) because the Hub3 IoT command set has
no equivalent lock-control risk and is needed for firmware / Matter flows that
have no typed wrapper. The lock raw path offers no comparable benefit over the
typed wrappers.

If a future use-case genuinely requires an arbitrary lock cmd (e.g. a new
item code the vendor adds before the SDK ships a typed wrapper), add a named
experimental method `lock.sendRaw { name|deviceUUID+secretKey, cmd }` with
explicit range validation, rather than reusing the current raw escape hatches.

## Experimental namespaces (excluded from 1.0 guarantee)

The registry exposes **135 methods** in total (contract 1.2.0); everything outside
the 13 stable methods stays **experimental** — broad cloud/business features, many
with explicitly unverified response shapes (`未確認` notes in source):

- `org.*` (34 ops: employees, groups, tags, device-group binding, key sharing)
- `company.*` (4 ops) and `payment.*` (6 ops)
- `access.*` (17 ops: cards / passcodes DB sync, `registerCards` / `registerPasscodes`
  bulk cloud-register conveniences pairing with the `access cards|passcodes enroll`
  BLE commands, and the `/device/v1/biometrics` REST ops `postAuthenticationData` /
  `putAuthenticationData` / `deleteAuthenticationData` / `updateAuthenticationName`)
- `iot.*` (10 ops: Hub3 device mgmt, Matter, firmware, raw cmd escape hatch)
- `presetir.*` (3 ops) and `ir.*` (14 ops: send / learn / remote & key CRUD /
  preset search & match / `addRemoteToMatter`)
- `schedule.*` (2 ops)
- `devices.*` beyond `devices.list` (userList / add / reorder / notifyStatus /
  notifyManage / switchRecharge) and `device.*` beyond history/battery
  (hideHistory / hideBattery / rename / delete)
- `config.sync*` (4 ops), `webapi.*` (4 ops), `firmware.list`, `cloud.ping`,
  `lock.setAutolock` (cloud/BLE `transport` param; only BLE takes effect on-device)
- `ble.*` (11 ops: `invoke` / `os2.invoke` generic facades plus typed wrappers —
  register / os2.register / updateFirmware / reset / position / wifi.*)

These remain callable and documented, but the generated SDKs tag them with a
JSDoc/docstring `@experimental` marker (on the normal namespace, alongside stable
methods) and they may change without notice.

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

Tracked here so the stable tier is honest when it freezes. All five original
issues are now addressed:

1. **Domain errors collapse to `internal`.** *(addressed — stable lock path in
   1.1.0, remaining namespaces since)* — `src/errors.js` (`SesameError` + machine
   `code`) is mapped at the serve boundary to `kind` + `data.retryable`; `lock.*`
   and the lock-resolution path emit `rejected`/`connection_lost`/`timeout`/
   `bad_params` instead of `internal`. The experimental namespace ops
   (`org`/`iot`/`company`/`access`/`devices`/`schedule`/`presetir`/`sharekey`/
   `account`/`ir`) now also throw `SesameError` via the shared `badRequest` /
   `rejected` / `timeout` helpers (`src/util.js`), so caller-input validation maps
   to `bad_params`, explicit upstream failures to `rejected` (with
   `data.upstreamCode`), and paged-push waits to `timeout` — no longer `internal`.
2. **`event.ready` advertised but never emitted.** *(addressed — contract 1.2.0)*
   It is now emitted once on **every** persistent connection (stdio / socket / ws /
   SSE / gRPC Subscribe) via `daemon.addConnection`, and is part of the stable
   event surface (provenance `local`).
3. **Methods with no extracted params** (`iot.subscribeIotResponse` /
   `iot.removeSesameFromHub3` showed only `(params)`). *(addressed —
   `iot.subscribeIotResponse` is no longer exposed as an RPC method, and
   `iot.removeSesameFromHub3` now self-describes its full param list in
   `rpc.discover` / `schema/openrpc.json`.)*
4. **Stale `CONTRACT_VERSION` doc-comment** ("79 method" vs 81 exposed).
   *(addressed — `src/serve/jsonrpc.js` now keeps a per-version changelog
   (1.0.0 / 1.1.0 / 1.2.0); the registry exposes 135 methods at 1.2.0.)*
5. **`apiVersion` separation.** *(addressed — 1.1.0)* The API surface is versioned
   independently from the package version and exposed as `apiVersion` in `status`
   and `rpc.discover` (`contractVersion` / `x-contractVersion` kept as deprecated
   aliases).

## Definition of 1.0

1.0 ships when:
- the `stable` surface above is frozen, documented, and semver-governed;
- per-method `x-stability` is in `rpc.discover`, **derived from provenance**;
- the error model has no `internal`-collapse on stable methods;
- generated SDKs exist for at least two languages (TS, Python);
- a CI gate guarantees the published schema and the implementation never diverge
  (**schema ↔ impl**); and
- an **upstream-conformance** check (vendor-behavior ↔ impl) exists for stable
  methods, so vendor drift is detected rather than silently breaking the facade.
  Both modes exist today: a live canary (opt-in, needs creds) and an offline
  replay that runs in CI against recorded fixtures (`canary-upstream.mjs --replay`).
