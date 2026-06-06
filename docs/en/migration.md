<!-- English | [日本語](../ja/migration.md) -->

# Migrating from older versions

> [日本語](../ja/migration.md) · [Docs index](./index.md)

Upgrading from the old `sesame-hub3` (CLI = `hub3-ir`):

- The CLI is renamed to `sesame` (the old `hub3-ir` is removed). Replace it in any shell scripts.
- Config and tokens are stored in `~/.config/sesame-kit`.
- Config is now stored under a single `devices` map; `locks` is a derived view rebuilt on each load, not a stored key. Populate `devices` from the server with `sesame locks sync-from-devices`.

Migrating from an old `.env` + `.tokens.json` + `keys.json` works with `sesame migrate`.
