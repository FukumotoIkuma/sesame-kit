<!-- English | [日本語](./architecture.ja.md) -->

# Architecture / Design Notes

> 日本語: [architecture.ja.md](./architecture.ja.md)

This document covers the lineage of the implementation, the design decisions, and the file layout. The README covers usage; this covers why things are the way they are.

## Lineage

This implementation is a Node.js port of the **official biz3 admin web app (https://github.com/CANDY-HOUSE/biz.candyhouse.co, MIT)**. The port mapping for the main parts:

| This implementation | biz3 vendor source |
|---|---|
| `src/transport.js` | `references_web/src/websocket/WebSocketManager.ts` (window dependency removed, switched to Node `ws`; reconnect/keepalive/idle/sleep detection identical to biz3; callback registry made FIFO) |
| `src/auth.js` | `references_web/src/api/useAuthState.js` (Amplify replaced with direct AWS SDK calls) |
| `src/lock.js` | `sendCommandToWM2` in `references_web/src/api/useIotCtrl.js` |
| `src/ir.js` | `references_web/src/api/useRemoteCtrl.js` (only the JSON-building part extracted from the hook's useCallback) |
| `src/devices.js` | `references_web/src/api/useManageDevice.js` / `useManageGroup.js` / `useDeveloper.js` / `MobileBatteryChart.js` |
| `src/crypto.js` | `references_web/src/utils/Cmac.js` + `biz3utils.js` + `constants/cmdCode.js` (CMAC implemented with `node-aes-cmac`) |

**The only functional difference from biz3**: the Cognito Client ID is swapped from biz3's `21u50hboia4s5q0sbk6pbdfmss` to the same Consumer Client as the official iOS/Android apps, `6ialca0p8u0lsgvbmvsljfm305`. This keeps the refreshToken from effectively expiring. The biz3 MIT license text is bundled as [LICENSE.biz3](../LICENSE.biz3).

## Unified cloud / BLE design (the route is the leaf)

Like the official SesameSDK, cloud and BLE **share the underlying command (itemCode) and the device capability model**; only the final send route (transport) is swapped as a leaf. This is a single design.

- itemCode has one source in `src/itemcodes.js` (the cloud refers to it as `CMD` in `crypto.js`, BLE as `ITEM` in `protocol.js` — different aliases for the same thing).
- Capability is held by `devicemodel.js` as **type × route** (each kind has a `cloud:[...]` and a `ble:[...]` op set).
  The **operable ops = the union of the two**, and the session's targets, operation menu, and `pickTransport` route selection are all derived from this union.
  - Example: a lock has autolock under `ble` but not `cloud` → autolock is BLE-only.
  - An OS2 lock has an empty `ble` set and lock/unlock/toggle under `cloud` → operable via cloud only.
  - Hub3 has ir/relay/led under `cloud`.
- The default is a **full mode** that is unaware of the route; pin it with `--ble-only` / `--cloud-only` only when desired.

## The irType asymmetry trap (self-learned remote)

A remote's kind is an integer code (= the device's `remote.type`). Main values: `49152` (0xc000) = air conditioner / `8192` (0x2000) = TV / `57344` = light / `32768` = fan / **`65024` (0xFE00) = self-learned**.

⚠️ **Only learning is asymmetric**: in the official biz3 menu, each item has an id, and presets such as air conditioner / TV match by "menu id = device type." However, the "learn" menu id is `0xFEFF`, while the type of the remote actually created by learning is **`0xFE00` (65024)**. `0xFEFF` is only a UI-side marker for "the learn menu was pressed"; it never appears on the device or in communication. **Always use the real type `0xFE00` when referring to a self-learned remote** (passing `0xFEFF` fails the server-side match and the remote is not found). This tool uses `0xFE00`.

## autolock cannot be set over the cloud

Setting autolock (= `SesameItemCode` 11) over the cloud is not reflected on the physical device. `biz3TriggerLocker` returns `success:true` for cmd=11, but the lock's actual autolock duration does not change. biz3 web/SDK has no cloud send route for settings either (the IoT cmds in `useIotCtrl.js` are only ADD/REMOVE_SESAME, LED, RELAY, etc., and autolock is "Unsupported"), and the official app sends autolock directly over BLE. autolock is therefore provided only via BLE's `sesame autolock`. The library has the generic rails `lock.triggerItemCommand` / `lock.setAutolock`, but over the cloud only lock/unlock/toggle/bot take effect on the device.

`biz3TriggerLocker` returns a synchronous ack (`{code:200, success:true}`). `unlock`/`lock`/`toggle`/`bot` use this ack to determine completion (waiting on the push alone would wrongly report a timeout even though the server already accepted the command).

## BLE direct control design

The protocol layer (`src/ble/protocol.js`: CMAC session key / AES-CCM / segments / frames) and the session layer (`src/ble/session.js`) are **OS-independent pure JS**. Only the radio I/O is confined to a swappable adapter (`src/ble/transport.js`, noble by default); an alternate adapter such as Web Bluetooth can also be injected. The device type model (`src/ble/devicemodel.js`) ports the capability definitions of the official SesameSDK's `CHProductModel`, mapping `productType`/`model` → kind (lock5/bot2/bike2/…) → supported operations and mechStatus interpretation. `SesameBle` allows or rejects operations according to this capability. The protocol is ported from the Android SesameSDK / ESP32 reference implementation.

## The single `devices{}` config design

**Devices are stored whole in a single `devices{}`** — locks / Bots / Bikes / Hub3 are not split by type; the server's device record is stored as-is (minus the huge `stateInfo`). The type is derived from `deviceModel`, and which operation view (lock / hub3) it appears in is classified by `category`. This design structurally prevents dropped `model`/`secretKey` (e.g., a Hub3 being mislabeled as "unlocked"). `remotes` is a child entity, not a device (parent Hub3 + irType + learned keys), so it stays an independent collection.

## `sesame serve` language-agnostic backend

With 1 core + 5 framings, the full feature set is uniformly exposed on a single resident `SesameHub3`. See the README's [language-agnostic backend](../README.md#language-agnostic-backend-sesame-serve) for details.

- **Core**: `src/serve/jsonrpc.js` (JSON-RPC 2.0, transport-independent) + `registry.js` (auto-exposes methods from `NAMESPACE_OPS` + OpenRPC) + `daemon.js` (serialization / unified subscription / backpressure / shutdown).
- **Framing**: stdio / socket(UDS) / http(+SSE) / ws / grpc + token under `framing/`.
- **Type extraction**: `scripts/gen-rpc-schema.mjs` extracts param types from `.d.ts` (`rpc-params.generated.json`), and `scripts/gen-grpc-proto.mjs` generates a typed `sesame.proto`. Both are protected by drift-guard tests.

## File layout

```
sesame-kit/
├── package.json
├── README.md
├── docs/                   # commands / architecture / library / migration
├── LICENSE
├── LICENSE.biz3
├── bin/
│   └── sesame.js           # CLI entry point
├── clients/                # thin official clients that connect to sesame serve (zero dependencies)
│   ├── python/sesame_client.py   #   UDS/stdio/HTTP + event subscription
│   └── js/sesame-client.mjs      #   equivalent (Node 18+)
├── vendor/
│   └── biz3/constants/     # verbatim copy of biz3's import-zero constants (single source of truth)
└── src/
    ├── index.js            # public library entry
    ├── cli.js              # commander implementation (basic commands + makeCtx)
    ├── cli/                # per-feature command wiring (registerXxxCommands)
    │   └── serve.js        #   sesame serve … (resident JSON-RPC backend wiring)
    ├── serve/              # language-agnostic backend (1 core + 5 framings)
    │   ├── jsonrpc.js      #   JSON-RPC 2.0 protocol core (transport-independent)
    │   ├── registry.js     #   method catalog (auto-exposed from NAMESPACE_OPS) + OpenRPC
    │   ├── daemon.js       #   multiplexing onto a single resident hub (serialization/subscription/backpressure/shutdown)
    │   ├── sesame.proto    #   gRPC typed definition (generated)
    │   └── framing/        #   stdio / socket(UDS) / http(+SSE) / ws / grpc + token
    ├── client.js           # SesameHub3 high-level class (auto-injects ops via namespace getters)
    ├── transport.js        # Hub3WsClient (reconnect/keepalive/queue/sleep)
    ├── auth.js             # Cognito CUSTOM_AUTH + REFRESH_TOKEN_AUTH + jwtSub
    ├── crypto.js           # AES-CMAC + uuid→base64 + cmd code constants
    ├── lock.js / ir.js / presetir.js / sharekey.js   # domain ops
    ├── ble/                # BLE direct control (OS-independent core + swappable transport)
    │   ├── protocol.js     #   pure JS: CMAC key/AES-CCM/segment/frame/mechStatus
    │   ├── session.js      #   state machine (initial→login→command response)
    │   ├── transport.js    #   noble adapter (optionalDependency, lazy require)
    │   └── index.js        #   SesameBle facade
    ├── iot.js / account.js / schedule.js / org.js / company.js / access.js / devices.js
    ├── config.js           # ConfigStore (~/.config/sesame-hub3/config.json)
    ├── tokens.js           # FileTokenStore
    └── paths.js            # config directory resolution
```
