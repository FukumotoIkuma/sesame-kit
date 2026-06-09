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
- [x] **ii-a — Machine-readable tiers + apiVersion.** `src/serve/stability.js` is
  the single source (provenance → tier); `rpc.discover` emits per-method/event
  `x-stability` + `x-provenance`; `status` and discover.info expose `apiVersion`
  (canonical; `contractVersion`/`x-contractVersion` kept as deprecated aliases).
  Also fixed: vitest `projects` config (self-contained; `--project unit|e2e`
  filters work, no double-count) and restored `npm test` = unit then e2e.
- [x] **ii-b — Error model hardening.** `src/errors.js` (`SesameError` + machine
  `code`, `retryable`, `data`) typed at the library layer; serve boundary maps
  `code` → `kind` (+`data.retryable`, `data.upstreamCode`). New `kind=rejected`.
  Applied to the stable `lock.*` path + lock resolution. CONTRACT_VERSION → 1.1.0
  (additive). **Remaining:** experimental ns ops still collapse to `internal`
  (convert each before promoting to stable).
- [x] **iii — Published OpenRPC artifact + drift gate.** Decided AGAINST full
  inversion (hand-authored OpenRPC → generated impl): the registry is the natural
  home for handlers, so inverting would be churn without payoff at this size. The
  real value — a stable *published* contract + drift protection — is delivered by:
  `schema/openrpc.json` committed artifact (generated by `npm run build:openrpc`
  from the live registry, English-canonical, `info.version` = CONTRACT_VERSION);
  `tests/openrpc-contract.test.js` gates the **machine contract** (method names /
  params / result type / x-stability / x-provenance / events) of artifact ↔ impl,
  CI-blocking. Prose (summaries) is locale-dependent docs, excluded from the gate.
- [x] **iv — TS SDK generation (PoC).** `scripts/gen-sdk-ts.mjs` (exports
  `generateSdk(spec)`) emits `sdk/ts/sesame-client.ts` from `schema/openrpc.json`:
  namespaced typed methods (`client.lock.unlock({name})`), param types from the
  schema (unknown where the schema is `{}`), `SesameRpcError` with kind/retryable,
  `@experimental` JSDoc on non-stable methods, `API_VERSION`. Type-checks under
  `sdk/ts/tsconfig.json` (`npm run typecheck:sdk`); drift-gated by
  `tests/sdk-ts-contract.test.js` (regenerate == committed). HTTP `POST /rpc`
  transport.
- [x] **iv (Python SDK).** `scripts/gen-sdk-py.mjs` mirrors the TS generator →
  `sdk/python/sesame_client.py` (zero-dep `urllib`; `client.lock.unlock(name=...)`,
  typed keyword args from the schema, `SesameRpcError` with kind/retryable,
  `@experimental` docstrings). `npm run build:sdk:py` / `check:sdk:py` (py_compile);
  drift-gated by `tests/sdk-py-contract.test.js`. Satisfies the 1.0 "≥2 SDKs
  (TS, Python)" criterion. Next increment: SSE event-streaming wrapper for both.
- [x] **v — Upstream-conformance gate + provenance.** Provenance is first-class
  (`x-provenance` since ii-a); `tests/provenance.test.js` now locks the invariant
  that tier is *derived* from provenance (stable ⊂ {local, app-core}; experimental
  = unverified). Upstream (vendor ↔ impl) drift — which CI can't see — is covered
  by `scripts/canary-upstream.mjs`: an opt-in, read-only live canary that hits the
  real cloud with stored creds and asserts the stable contract fields are present
  in vendor responses (exit 1 on drift). Validated live: 5/5 stable checks pass.
  Not in CI (needs creds/network); run manually or scheduled.

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

- ~~Where the canonical OpenRPC file lives~~ → `schema/openrpc.json` (generated
  artifact; impl is the source, drift-gated). Resolved in iii.
- SDK package names / publishing targets (npm, PyPI).
- Whether the stable event contract gets sequence ids in 1.0 or 1.x.
