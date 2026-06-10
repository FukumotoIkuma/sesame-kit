<!-- English | [日本語](../ja/migration.md) -->

# Migrating from older versions

> [日本語](../ja/migration.md) · [Docs index](./index.md)

Upgrading from the old `sesame-hub3` (CLI = `hub3-ir`):

- The CLI is renamed to `sesame` (the old `hub3-ir` is removed). Replace it in any shell scripts.
- Config and tokens are stored in `~/.config/sesame-kit`.
- Config is now stored under a single `devices` map; `locks` is a derived view rebuilt on each load, not a stored key. Populate `devices` from the server with `sesame locks sync-from-devices`.

Migrating from an old `.env` + `keys.json` works with `sesame migrate`. Legacy `.tokens.json` and `.login_state.json` are intentionally not imported, because they may not have the app-compatible Cognito `ConfirmDevice` state needed for long-lived refresh tokens. Run `sesame login <email>` after migrating config.
