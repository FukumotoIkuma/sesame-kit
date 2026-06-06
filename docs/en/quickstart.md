<!-- English | [日本語](../ja/quickstart.md) -->

# Quickstart

> [日本語](../ja/quickstart.md) · [Docs index](./index.md)

Open a lock from the command line in a few minutes.

## 1. Install

```bash
npm install -g sesame-kit     # global CLI: `sesame ...`
# or without installing: npx sesame-kit ...
```

Requires Node.js 18+.

## 2. Sign in

```bash
sesame init                 # create ~/.config/sesame-kit/ (first run only)
sesame login your@email.com # sends a verification code to your email
sesame verify               # enter the code
```

`verify` imports your devices together with their keys, so you can control them right away.

## 3. Control a lock

Run `sesame` for the interactive menu. It lists your devices and the actions each supports.

```bash
sesame      # ↑↓ move · → (or Enter) confirm · ← (or Esc) back · q quit
```

Or run an action directly. The subject is the device: `sesame <device> <action>` (substring match).

```bash
sesame front status            # current state (locked / unlocked)
sesame front unlock            # unlock
sesame front lock              # lock
```

## Next steps

- All CLI commands: [CLI reference](./commands.md)
- Operate over Bluetooth without the cloud: [BLE direct control](./ble.md)
- Call from another language: [Integrate via `sesame serve`](./integration.md)
- Use it from Node code: [Node library](./library.md)

> Cloud control needs sign-in. BLE-only control works without sign-in — see [BLE direct control](./ble.md).
