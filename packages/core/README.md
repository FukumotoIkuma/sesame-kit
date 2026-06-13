# @sesame-kit/core

SESAME smart-lock library — BLE + cloud transport, auth, crypto, device management.

This is the library core of [`sesame-kit`](https://github.com/FukumotoIkuma/sesame-kit).
For the full documentation, CLI reference, and design notes see the
[root README](https://github.com/FukumotoIkuma/sesame-kit#readme).

## Install

```bash
npm install @sesame-kit/core
```

Requires Node.js 20+.

## Minimal example

```js
import { SesameHub3 } from "@sesame-kit/core";

const hub = await SesameHub3.fromConfig();
await hub.connect();
try {
  await hub.unlock("front-door");
} finally {
  await hub.close();
}
```

BLE direct control (no cloud):

```js
import { SesameBle } from "@sesame-kit/core";

await SesameBle.use({ deviceUUID, secretKey }, async (lock) => {
  await lock.unlock();
});
```

## License

MIT — see [LICENSE](./LICENSE). Portions from CANDY-HOUSE/biz3 (MIT) — see [LICENSE.biz3](./LICENSE.biz3).
