# Upstream response fixtures (offline canary replay)

These JSON files are **synthetic samples of vendor (official cloud) responses**
for the *stable* RPC methods, used by the **offline** upstream-conformance canary:

```
node scripts/canary-upstream.mjs --replay
```

Each fixture is validated against the **same** `RESULT_SCHEMAS`
(`src/serve/result-schemas.js`) that the *live* canary asserts against, so CI can
catch "someone loosened the stable schema in a way that no longer matches a real
vendor response" — **without live cloud credentials**. The replay step runs in CI
(`.github/workflows/ci.yml`); the live canary stays opt-in (needs creds).

## Format

```json
{
  "method": "<key in RESULT_SCHEMAS, e.g. devices.list>",
  "sample": <a recorded/synthetic upstream response for that method>,
  "note":  "<optional human note: provenance, why this shape>"
}
```

- `method` must be a key of `RESULT_SCHEMAS`.
- `sample` is what the vendor cloud returns for that method (the daemon's
  anti-corruption layer in `src/<namespace>.js` maps the WS payload into this
  shape). Extra/unknown fields are allowed — the validator only checks the
  documented `required` fields and the types of documented `properties`.
- These values are **synthetic** (no real secrets / device UUIDs). They exist
  only to pin the *shape* of the stable contract for offline drift detection.

## Refreshing from a live run

When the vendor genuinely changes a shape, refresh these samples from a real
authenticated session instead of hand-editing:

1. `sesame login` (so creds exist in the config dir).
2. Run the live canary to confirm what the real cloud now returns:
   `node scripts/canary-upstream.mjs`
3. Capture the live payloads (e.g. add a temporary `console.log(JSON.stringify(...))`
   in the live branch, or use `sesame ... --json` for the corresponding command),
   scrub any real secrets/UUIDs, and paste the result into the matching fixture's
   `sample`. Keep the synthetic-but-schema-valid invariant.
4. Re-run `node scripts/canary-upstream.mjs --replay` and the vitest replay test
   to confirm the refreshed fixtures still validate.
