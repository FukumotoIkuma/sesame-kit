<!-- English | [日本語](../ja/library.md) -->

# Using sesame-kit as a library

> [日本語](../ja/library.md) · [Docs index](./index.md)

The same features as the `sesame` CLI can be called directly from Node.js. To use it from other languages, use [`sesame serve`](../../README.md#language-agnostic-backend-sesame-serve); to use it inside Node, use this.

## `use()` helper (auto connect/close)

```js
import { SesameHub3 } from "sesame-kit";

await SesameHub3.use(async (hub) => {
  await hub.unlock("front");
  await hub.send("ac", "停止");
});
// connect / close are automatic, including close on exceptions.
```

To change the config directory:

```js
await SesameHub3.use({ configDir: "/tmp/cfg" }, async (hub) => {...});
```

To use an in-memory token without a config file (e.g. embedding in another project):

```js
await SesameHub3.use({
  tokenStore: {
    // Return the exact token object created by `sesame login`.
    // It must be the SESAME consumer app client and include ConfirmDevice credentials
    // (deviceKey/deviceGroupKey/devicePassword). A custom store only moves that object
    // to another storage backend; it must not fabricate or import legacy tokens.
    load() { return { idToken, refreshToken, clientId: "6ialca0p8u0lsgvbmvsljfm305", deviceKey, deviceGroupKey, devicePassword }; },
    save(t) { /* persist however */ },
    clear() {}, loadPending() { return null; }, savePending() {}, clearPending() {},
  },
  config: { companyID: "ch_X", wsUrl: "wss://..." },  // companyID/wsUrl are optional (DEFAULT_CONFIG fills them in)
}, async (hub) => {
  await hub.unlockDevice({ deviceUUID: "...", secretKey: "..." });
});
```

## Direct API without config (no name lookup)

```js
await SesameHub3.use(async (hub) => {
  // Lock (pass deviceUUID + secretKey directly, without relying on the config locks definitions)
  await hub.unlockDevice({ deviceUUID, secretKey });
  await hub.lockDevice({ deviceUUID, secretKey });
  await hub.toggleDevice({ deviceUUID, secretKey });
  await hub.botClickDevice({ deviceUUID, secretKey });
  await hub.triggerLockDevice({ deviceUUID, secretKey, cmd: 83 });   // raw itemCode: 83=unlock, 82=lock, 88=toggle, 89=click
  // ⚠️ triggerLockRaw / triggerLockDevice (arbitrary cmd) are intentionally absent from CLI/RPC.
  //    Reason: accepting an arbitrary integer cmd over a network endpoint is a misfire surface.
  //    The named wrappers cover every cmd the official app sends (82/83/88/89).
  //    See: docs/api-stability.md "Intentionally absent from CLI/RPC"

  // IR
  await hub.sendIRDirect({
    // irType selects the remote category: 49152 (0xC000)=air-conditioner, 8192=TV, 32768=fan, 57344=light
    hub3DeviceId, irDeviceUUID, irType: 49152, command: keyUUID, operation: "learnEmit",
  });
  const keys = await hub.getIRCodesDirect({ hub3DeviceId, irDeviceUUID });
});
```

## Event subscription (state push)

```js
await SesameHub3.use(async (hub) => {
  // Subscribe to lock-state push by config name
  const off1 = hub.onLockStateChange("front", (msg) => {
    console.log("front state:", msg.data?.state);
  });

  // Passing a UUID directly also works
  const off2 = hub.onLockStateChangeDevice(deviceUUID, (msg) => { ... });

  // Receive IR learning data (internally issues setIRMode + subscribeIRData, and reverts on unsubscribe)
  const offLearn = await hub.onIRLearned("livinghub3", (irData) => {
    console.log("captured:", irData);
  });

  // Bulk-subscribe to device state (subscribeDevicesUpdate)
  const off3 = hub.onDeviceUpdate(
    [{ deviceUUID, deviceModel: "sesame_5_pro" }],
    (msg) => console.log(msg),
  );

  await new Promise((r) => setTimeout(r, 30_000));
  off1(); off2(); off3();
  await offLearn();
});
```

## The older name-based API (config required)

```js
import { SesameHub3 } from "sesame-kit";

const hub = await SesameHub3.fromConfig();
await hub.connect();
try {
  await hub.unlock("front");
  await hub.send("ac", "停止");
  await hub.learnIR("ac", "強風", { onPrompt: () => console.log("press the button") });
  const devs = await hub.listDevices();
  const hist = await hub.getDeviceHistory([{ deviceUUID: devs[0].deviceUUID }]);
} finally {
  await hub.close();
}
```

## Low-level imports (transport / op functions / crypto directly)

Available from the main entry (`"sesame-kit"`):

```js
import {
  Hub3WsClient,          // WebSocket + reconnect/keepalive/queue/sleep detection
  sendIR, getIRCodes,    // IR base ops (named export)
  triggerLock, lockLock, lockUnlock, lockToggle, botClick,  // individual lock functions (named export)
  ir, devices, crypto, lock, auth,  // ← these are namespace exports (objects)
  FileTokenStore, ConfigStore, configPaths,
} from "sesame-kit";

// Call namespace methods via dot:
crypto.cmacTime("...");          // ✅ what you get from the main entry is the crypto namespace
auth.getValidIdToken(store);     // ✅ same as above
// ⚠️ import { cmacTime } from "sesame-kit" does not work (cmacTime is inside the crypto namespace)
```

To named-import individual functions, use the subpath (the `exports` map in `package.json`):

```js
import { cmacTime } from "sesame-kit/crypto";   // ✅ named works on a subpath
import { learnIRKey } from "sesame-kit/ir";
import { lockLock } from "sesame-kit/lock";
```

## Error handling: branch on `err.code`, never on the message

Error **messages thrown by the library are locale-dependent** (they go through the same i18n layer as the CLI, so the text changes with `--lang` / `config.uiLang`). For machine branching, use the structured fields of `SesameError` instead:

```js
import { SesameError } from "sesame-kit";

try {
  await hub.unlock("front");
} catch (e) {
  if (e instanceof SesameError) {
    // e.code: "not_connected" | "timeout" | "rejected" | "bad_request" | "unauthenticated"
    // e.retryable: true on transient failures (timeout / not_connected)
    // e.data: extra info (e.g. the upstream cloud's own code on "rejected")
    if (e.retryable) scheduleRetry();
  }
}
```

The same rule applies over `sesame serve`: JSON-RPC errors carry `error.data.kind` (mapped from `code`) — never parse `error.message`.

## TypeScript

`.d.ts` type definitions are bundled (`types/`, generated from JSDoc with `tsc`). With `moduleResolution: "node16" / "nodenext" / "bundler"`,
package-name imports (`from "sesame-kit"` / `"sesame-kit/crypto"` etc.) get types:

```ts
import { SesameHub3 } from "sesame-kit";
await SesameHub3.use(async (hub) => {
  await hub.unlockDevice({ deviceUUID: "...", secretKey: "..." });  // arguments are type-checked
});
```

Types can be regenerated with `npm run build:types` (run it after editing the JSDoc in the source).
