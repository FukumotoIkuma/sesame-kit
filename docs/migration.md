<!-- English | [日本語](./migration.ja.md) -->

# Migrating from older versions

> 日本語: [migration.ja.md](./migration.ja.md)

Upgrading from the old `sesame-hub3` (CLI = `hub3-ir`):

- The CLI is renamed to `sesame` (the old `hub3-ir` is removed). Replace it in any shell scripts.
- The config directory (`~/.config/sesame-hub3`) is unchanged; an existing config.json works as-is.
- The `locks` key is added automatically (starting from an empty `{}`). Import from the `devices` command output with `sesame locks sync-from-devices`.

Migrating from an old `.env` + `.tokens.json` + `keys.json` works with `sesame migrate`.
