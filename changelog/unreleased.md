# Unreleased

<!-- One line per user-visible change, added in the same commit as the change.
Group under Added / Changed / Deprecated / Removed / Fixed / Security.
Breaking changes need a **Migration** note. -->

## Added

- Add per-vault sync configuration via `.obsidian/sync.config.json` in each vault
- Add `resolveVaultConfig()` and `loadVaultConfig()` utilities for vault-level config resolution

## Changed

- Agent and non-interactive sync scripts now read vault-level config with priority: CLI flags > vault-level config > repo-level `sync.config.json`
