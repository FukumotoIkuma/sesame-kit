# Reference implementations (for tracing ports)

This project is a **faithful port** of the official SESAME stack. Cloud/auth code
in `src/` mirrors the vendor's behavior 1:1 — so message/response **shapes are
deterministic and knowable from the vendor source**. When fixing or extending a
port, **do not guess from the current code**: open the cited vendor file, trace
how it actually reads/writes the field, and mirror that exactly.

> Defensive code in a mirror (field fallback chains `a || b || c`, `?.` on
> response fields, swallow-and-default `try/catch`, "応答 push 未確認 →
> fire-and-forget") is a **smell of an unverified port**, not a real error case.
> Resolve it by tracing the reference, not by adding more defenses.

## Where the references live (gitignored — place them here)

Both directories are in `.gitignore` (primary sources, never committed). Drop the
checkouts here so the inline citations resolve and tracing is one `grep` away:

| Directory | What | Cited in code as |
|---|---|---|
| `references_web/` | CANDY-HOUSE **biz3 web** (React). The cloud/auth port's primary source. | `references_web/src/api/useManageDevice.js:147`, `…/useOperateIoT.js`, `…/useIotCtrl.js`, `…/useAuthState.js`, `…/aws-exports.js`, `…/learn/index.js`, etc. |
| `_sesame_sdk_ref/` | **Android SesameSDK** (Kotlin) + demo app. The BLE port's primary source. | bare `CHHub3Device.kt`, `CHSesame5Device.kt`, `CHSesameOS3.kt`, `CHServerAuth.kt`, `SesameProtocols.kt`, etc. |

Layout so citations resolve verbatim (e.g. `references_web/src/api/useManageDevice.js`):

```
references_web/        # = biz3 web repo root (so references_web/src/api/... exists)
_sesame_sdk_ref/       # = SesameSDK Android repo root (Kotlin under app/src/main/...)
```

## How to populate

- These are CANDY-HOUSE sources; obtain them from the upstream repos (the web
  `biz3` dashboard source and the Android `SesameSDK` repo) and unpack into the
  directories above. They are intentionally untracked.
- If you (a developer/agent) find a citation that does **not** resolve under
  these dirs, the reference is missing — stop and restore it before "fixing" a
  port, rather than inferring the shape from `src/`.

## Tracing checklist (per smell)

1. Read the citation in the `src/` comment (file + line).
2. Open that exact file under `references_web/` or `_sesame_sdk_ref/`.
3. Confirm the real field name / call shape / response handling.
4. Mirror it precisely in `src/`; delete any guessed fallback.
5. If the reference truly can't disambiguate (vendor delegates to an
   op-specific callback the kit can't see), keep a single honest passthrough and
   mark it `未確認` with the reason — that's the only legitimate "defense".
