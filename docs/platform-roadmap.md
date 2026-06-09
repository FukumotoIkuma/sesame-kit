# Developer-Platform Roadmap

Where this initiative is and where it's going. Resume from here.
Contract details live in [api-stability.md](./api-stability.md); this is the work plan.

## Goal

Make this the de-facto **developer platform** for SESAME automation ("SESAME
automation = this"). Strategy = **schema-first**: one canonical API schema is the
source of truth, from which polyglot SDKs and docs are generated, and a CI gate
guarantees schema and implementation never diverge.

## Locked decisions

- **Hosting: self-hosted only.** Each user runs `sesame serve` (or embeds the
  library); SDKs talk to that local daemon. No hosted multi-tenant service
  (lower liability for an unofficial client; OSS-native; easier moat).
- **Guiding principle:** choose the design that will be *certainly right long-term*
  even if harder now. Pre-1.0 → **no salvage/migration cruft**; the recovery for a
  legacy/broken token is simply re-login.
- **Two-boundary model (anti-corruption).** Our OpenRPC is the canonical parent
  *for consumers*, but the *true upstream parent* of our behavior is the **vendor**
  (official app / biz3 cloud WS) — a discovered, reverse-engineered spec we don't
  control. The namespace modules are an **anti-corruption layer** that absorbs
  upstream churn so the downstream contract stays stable. Consequences:
  `stable` is a **best-effort facade** (only as stable as we can absorb upstream
  change); **tier = upstream confidence** (`stable` = load-bearing in the official
  app **and** verified by us; `未確認` notes = low confidence → `experimental`).
  See [api-stability.md](./api-stability.md) → "Two boundaries".
- **Provenance is first-class.** Each contract element records origin/confidence
  (`verified-live` / `biz3-source-ref` / `unverified`); **`x-stability` is derived
  from provenance** so internal confidence and external promise stay consistent.
- **Two drift gates, not one.** (1) schema ↔ impl (our internal consistency); and
  (2) **vendor-behavior ↔ impl** upstream-conformance (live canary / fixture
  replay) — without (2) the facade silently lies when the vendor changes.
- **Canonical schema = OpenRPC** (JSON-RPC is the native shape across
  HTTP/WS/stdio); it is the *downstream-facing* parent. gRPC proto becomes a
  generated binding, not a second source. → invert today's *code→schema*
  generation into *schema→(impl validation + SDKs + docs + proto)*.
- **API tiers:** small frozen `stable` core vs `experimental` (see api-stability.md).
  Tier is machine-readable via `rpc.discover` (`x-stability`).
- **Errors are contract:** clients branch on structured `data.kind`, never on the
  (localized) message. Domain failures must get real `kind`s (not `internal`).
- **Events:** at-least-once + resubscribe-on-reconnect (have it); add per-event
  sequence id + `lastEventId` gap-detection for the stable event contract.
- **SDKs:** generated thin client + small idiomatic wrapper. Order: **TS → Python**
  (1.0 commitment), **Go** fast-follow. TS SDK is the reference; the Node library
  aligns to the same wire contract.
- **`apiVersion`:** version the API surface independently of the package; expose in
  `status` and `rpc.discover`.

## Definition of 1.0

- `stable` surface frozen, documented, semver-governed
- per-method `x-stability` in `rpc.discover`
- no `internal`-collapse on stable methods (real domain error `kind`s)
- generated SDKs for ≥2 languages (TS, Python)
- CI gate (1): published schema ↔ implementation never diverge
- gate (2): upstream-conformance (vendor-behavior ↔ impl) for stable methods
- per-method `x-stability` derived from provenance

## Work plan & status

- [x] **i — Surface audit & tiering.** Full inventory of serve methods/events/
  params/errors; stable-vs-experimental decision. → `docs/api-stability.md`
  (branch `platform/api-surface`).
- [ ] **ii-a — Machine-readable tiers + apiVersion.** Emit per-method
  `x-stability` (derived from provenance) in `rpc.discover`; split `apiVersion`
  into `status`/discover. *(low risk, unblocks SDK gen + CI gate)*
- [ ] **ii-b — Error model hardening.** Replace `internal`-collapse with domain
  `kind`s (e.g. `device_offline`, `not_found`, `rejected`) + optional
  `data.retryable`, on stable methods. *(the biggest gap; contract-freezing)*
- [ ] **iii — OpenRPC canonical + bidirectional drift gate.** Make OpenRPC the
  hand-curated source of truth; generate proto/params from it; extend the
  schema-drift test into a CI-blocking guarantee that schema ↔ impl can't diverge.
- [ ] **iv — TS SDK generation PoC.** Generate the TS client from the canonical
  OpenRPC over HTTP+WS; prove the pipeline; then Python.
- [ ] **v — Upstream-conformance gate + provenance.** Record provenance per
  contract element; add a vendor-behavior ↔ impl check (live canary / captured
  fixture replay) for stable methods so vendor drift is detected, not silently
  absorbed-then-broken.

Recommended order: i → ii-a → ii-b → iii → iv (decide *what* we promise before
generating clients off it). **v (provenance + upstream gate)** runs alongside:
provenance lands with ii-a (it feeds `x-stability`); the upstream canary can
follow iii.

## Pre-1.0 cleanups to fold in (from the audit)

- `event.ready`: advertised in `rpc.discover` but never emitted — emit or drop.
- `iot.subscribeIotResponse` / `iot.removeSesameFromHub3`: missing extracted
  params → `discover` shows only `(params)`.
- Stale `CONTRACT_VERSION` doc-comment ("79 method" vs 81 exposed).
- `serve` exposes no BLE today (all RPC = cloud WS). Local BLE-backed control is a
  future, separate surface — relevant to the "works offline / local-first" moat.

## Open questions (not yet decided)

- Where the canonical OpenRPC file lives and how impl validates against it (iii).
- SDK package names / publishing targets (npm, PyPI).
- Whether the stable event contract gets sequence ids in 1.0 or 1.x.
