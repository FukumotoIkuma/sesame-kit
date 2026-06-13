# sesame-kit

SESAME smart-lock CLI, `sesame serve` JSON-RPC daemon, and bundled thin clients.

This package provides the `sesame` CLI and the `sesame serve` daemon (JSON-RPC over
stdio / UDS / HTTP / WS / gRPC). It depends on
[`@sesame-kit/core`](https://www.npmjs.com/package/@sesame-kit/core) for the
BLE + cloud library.

For the full documentation, CLI reference, and design notes see the
[root README](https://github.com/FukumotoIkuma/sesame-kit#readme).

## Install

```bash
npm install -g sesame-kit   # global CLI
npx sesame-kit --help       # or run without installing
```

Requires Node.js 20+.

## Minimal example

```bash
sesame login
sesame locks
sesame unlock front-door
```

Start a JSON-RPC server (stdio, any language can drive it):

```bash
sesame serve
```

The bundled JS thin client:

```js
import { SesameClient } from "sesame-kit/client";

const client = new SesameClient();
await client.connect();
const result = await client.call("lock.unlock", { name: "front-door" });
```

## License

MIT — see [LICENSE](./LICENSE).
