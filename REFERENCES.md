# Reference implementations (for tracing ports)

This project is a **faithful port** of the official SESAME stack. Cloud/auth code
in `packages/core/src/` and `packages/kit/src/` mirrors the vendor's behavior 1:1 — so message/response **shapes are
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

Primary source is assigned **per domain**, not per directory:

| Domain | Primary source | Cited in code as |
|---|---|---|
| **auth / token — wire shape** (InitiateAuth, RespondToAuthChallenge, ConfirmDevice, SRP math, HKDF, Identity Pool threshold) | `_aws_sdk_ref/` — **AWSMobileClient 2.77.0** Java source (`release_v2.77.0` tag). This is the actual wire format AWSMobileClient sends to Cognito; the math in `packages/core/src/device-srp.js` and `packages/core/src/aws-credentials.js` must be traced to this. Key files: `CognitoUser.java` (inner class `AuthenticationHelper` at :3979-4097), `Hkdf.java`, `CognitoCredentialsProvider.java`, `CognitoCachingCredentialsProvider.java`, request marshallers. | `_aws_sdk_ref/CognitoUser.java`, `_aws_sdk_ref/Hkdf.java`, `_aws_sdk_ref/CognitoCredentialsProvider.java`, etc. |
| **auth / token — app flow** (signIn call path, login UI, device confirmation triggers) | `_sesame_sdk_ref/` — the Android **app** source (Kotlin). Shows how AWSMobileClient is *invoked* (LoginMailFG.kt, CHLoginViewModel.kt). `_aws_sdk_ref` shows what AWSMobileClient then *does* on the wire. | `app.properties`, `AWSConfig.kt`, `LoginMailFG.kt`, `CHLoginViewModel.kt`, `CognitoIdentityProviderClientConfig.java`, etc. |
| **cloud transport** (WS frames, IoT topics, API request/response shapes) | `references_web/` — CANDY-HOUSE **biz3 web** (React). | `references_web/src/api/useManageDevice.js:147`, `references_web/src/hooks/useOperateIoT.js`, `references_web/src/api/useIotCtrl.js`, `references_web/src/aws-exports.js`, `…/learn/index.js`, etc. |
| **BLE** (OS2/OS3 protocol, peripherals) | `_sesame_sdk_ref/` — **Android SesameSDK** (Kotlin) + demo app. | bare `CHHub3Device.kt`, `CHSesame5Device.kt`, `CHSesameOS3.kt`, `CHServerAuth.kt`, `SesameProtocols.kt`, etc. |

### ⚠️ auth is traced from the **app**, never from the web (absolute constraint)

The web dashboard (`references_web/src/api/useAuthState.js`) authenticates with a
plain CUSTOM_AUTH flow **without ConfirmDevice**: Cognito issues it a short-lived
refresh token tied to no confirmed device, so its tokens **cannot be persisted**
across sessions — the web simply re-logins in the browser. This kit is a
long-lived CLI/daemon and *must* persist tokens, which is only possible with the
Android app's flow (AWSMobileClient 2.77.0: CUSTOM_AUTH + device SRP +
ConfirmDevice → durable, rotatable refresh token). Auth is in `packages/core/src/auth.js` and `packages/core/src/aws-credentials.js`.

**Do not "fix" auth code to be more faithful to `useAuthState.js` — that is a
regression, not a faithful port.** If auth code looks like it diverges from the
web source, that divergence is intentional; the reference to trace is the app
(`_sesame_sdk_ref` + AWSMobileClient 2.77.0 behavior). `useAuthState.js` may be
consulted only as *negative* evidence (what the kit must not do). See `packages/core/src/auth.js` JSDoc for rationale.

Layout so citations resolve verbatim (e.g. `references_web/src/api/useManageDevice.js`):

```
references_web/        # = biz3 web repo root (so references_web/src/api/... exists)
_sesame_sdk_ref/       # = SesameSDK Android repo root (Kotlin under sesame-sdk/src/main/...)
_aws_sdk_ref/          # = AWSMobileClient 2.77.0 Java files (release_v2.77.0 tag)
                       #   NOTE: AuthenticationHelper is an inner class of CognitoUser.java
                       #   (:3979-4097). There is no standalone AuthenticationHelper.java —
                       #   do not copy placeholder files named AH.java or AuthenticationHelper.java.
```

## How to populate

- `_sesame_sdk_ref/` and `references_web/`: CANDY-HOUSE sources; obtain them from
  the upstream repos (the web `biz3` dashboard source and the Android `SesameSDK`
  repo) and unpack into the directories above. They are intentionally untracked.
- `_aws_sdk_ref/`: AWSMobileClient 2.77.0 Java files from the
  `aws-amplify/aws-sdk-android` repo (`release_v2.77.0` tag). Key files:
  - `CognitoUser.java`, `CognitoUserPool.java`, `AWSMobileClient.java` — core auth
  - `AuthenticationDetails.java`, `ChallengeContinuation.java` — challenge handling
  - `CognitoDeviceHelper.java`, `Hkdf.java` — device SRP and HKDF math
  - `CognitoIdentityProviderClientConfig.java`, `CognitoServiceConstants.java`
  - `CognitoCredentialsProvider.java`, `CognitoCachingCredentialsProvider.java`
  - `SignUpRequestMarshaller.java`, `InitiateAuthRequestMarshaller.java`,
    `RespondToAuthChallengeRequestMarshaller.java` — wire-format marshallers
  - **Do NOT copy** `AuthenticationHelper.java` or `AH.java` — these are 14-byte
    `404: Not Found` placeholders. `AuthenticationHelper` is an inner class of
    `CognitoUser.java` at lines 3979-4097.
  - Run `npm run check:refs` after populating to validate all files.
- If you (a developer/agent) find a citation that does **not** resolve under
  these dirs, the reference is missing — stop and restore it before "fixing" a
  port, rather than inferring the shape from `src/`.

## Tracing checklist (per smell)

1. Read the citation in the source code comment (file + line).
2. Open that exact file under `references_web/` or `_sesame_sdk_ref/`.
3. Confirm the real field name / call shape / response handling.
4. Mirror it precisely in `packages/core/src/` or `packages/kit/src/`; delete any guessed fallback.
5. If the reference truly can't disambiguate (vendor delegates to an
   op-specific callback the kit can't see), keep a single honest passthrough and
   mark it `未確認` with the reason — that's the only legitimate "defense".
